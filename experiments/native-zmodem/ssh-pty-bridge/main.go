// Command zmodem-ssh-pty-bridge is an isolated, non-shipping SSH PTY experiment.
// It deliberately opens a separate SSH session; the OpenShell terminal and
// trzsz-go data paths are never modified or shared with this binary stream.
package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

type options struct {
	address  string
	user     string
	identity string
	hostKey  string
	sidecar  string
	timeout  time.Duration
}

func quoteShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func remoteCommand(direction, remotePath string) (string, error) {
	if remotePath == "" || strings.ContainsRune(remotePath, '\x00') {
		return "", errors.New("invalid remote path")
	}
	switch direction {
	case "send":
		return "cd -- " + quoteShell(remotePath) + " && stty raw -echo && exec rz -q -y", nil
	case "receive":
		return "stty raw -echo && exec sz -q -- " + quoteShell(remotePath), nil
	default:
		return "", fmt.Errorf("unsupported direction %q", direction)
	}
}

func verifyLocalPath(direction, path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", err
	}
	if direction == "send" && !info.Mode().IsRegular() {
		return "", errors.New("send requires a regular source file")
	}
	if direction == "receive" && !info.IsDir() {
		return "", errors.New("receive requires an existing destination directory")
	}
	return absolute, nil
}

func dialSSH(opts options) (*ssh.Client, error) {
	privateKey, err := os.ReadFile(opts.identity)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(privateKey)
	if err != nil {
		return nil, err
	}
	publicKey, err := os.ReadFile(opts.hostKey)
	if err != nil {
		return nil, err
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey(publicKey)
	if err != nil {
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:            opts.user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.FixedHostKey(key),
		Timeout:         10 * time.Second,
	}
	return ssh.Dial("tcp", opts.address, config)
}

func bridge(ctx context.Context, client *ssh.Client, sidecar, direction, localPath, command string) error {
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()

	remoteIn, err := session.StdinPipe()
	if err != nil {
		return err
	}
	remoteOut, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	if err := session.RequestPty("dumb", 24, 80, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
		return fmt.Errorf("request remote PTY: %w", err)
	}

	process := exec.CommandContext(ctx, sidecar, direction, localPath)
	var sidecarLog bytes.Buffer
	process.Stderr = &sidecarLog
	localIn, err := process.StdinPipe()
	if err != nil {
		return err
	}
	localOut, err := process.StdoutPipe()
	if err != nil {
		return err
	}
	if err := session.Start(command); err != nil {
		return fmt.Errorf("start remote ZMODEM: %w", err)
	}
	if err := process.Start(); err != nil {
		return fmt.Errorf("start native sidecar: %w", err)
	}

	// Exactly one reader owns each direction. Terminal rendering and the
	// production trzsz filter are not involved in this experimental session.
	copied := make(chan error, 2)
	remoteOutputDone := make(chan struct{})
	localOutputDone := make(chan struct{})
	go func() {
		defer close(remoteOutputDone)
		_, copyErr := io.Copy(localIn, remoteOut)
		_ = localIn.Close()
		copied <- copyErr
	}()
	go func() {
		defer close(localOutputDone)
		_, copyErr := io.Copy(remoteIn, localOut)
		_ = remoteIn.Close()
		copied <- copyErr
	}()

	// Wait only after stdout has been fully drained. Both SSH Session.Wait
	// and exec.Cmd.Wait may otherwise close pipes before io.Copy finishes.
	localFinished := make(chan error, 1)
	remoteFinished := make(chan error, 1)
	go func() { <-localOutputDone; localFinished <- process.Wait() }()
	go func() { <-remoteOutputDone; remoteFinished <- session.Wait() }()

	var localErr, remoteErr error
	for localFinished != nil || remoteFinished != nil {
		select {
		case <-ctx.Done():
			_ = session.Close()
			_ = process.Process.Kill()
			return fmt.Errorf("SSH ZMODEM experiment cancelled or timed out: %w", ctx.Err())
		case localErr = <-localFinished:
			localFinished = nil
			if localErr != nil {
				_ = session.Close()
				return fmt.Errorf("native ZMODEM sidecar failed: %w; stderr: %s", localErr, sidecarLog.String())
			}
		case remoteErr = <-remoteFinished:
			remoteFinished = nil
			if remoteErr != nil {
				_ = session.Close()
				_ = process.Process.Kill()
				return fmt.Errorf("remote rz/sz failed: %w; sidecar stderr: %s", remoteErr, sidecarLog.String())
			}
		}
	}
	for range 2 {
		select {
		case copyErr := <-copied:
			// Successful peers can close their pipes while the final protocol
			// bytes are still being drained. Other copy failures are fatal.
			if copyErr != nil && !errors.Is(copyErr, io.ErrClosedPipe) && !errors.Is(copyErr, os.ErrClosed) && !errors.Is(copyErr, syscall.EPIPE) {
				return fmt.Errorf("SSH PTY copy failed: %w", copyErr)
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func run(args []string) error {
	flags := flag.NewFlagSet("zmodem-ssh-pty-bridge", flag.ContinueOnError)
	var opts options
	flags.StringVar(&opts.address, "addr", "", "SSH server host:port")
	flags.StringVar(&opts.user, "user", "", "SSH username")
	flags.StringVar(&opts.identity, "identity", "", "SSH private key file")
	flags.StringVar(&opts.hostKey, "hostkey", "", "trusted SSH host public key file")
	flags.StringVar(&opts.sidecar, "sidecar", "", "compiled zmodem-sidecar binary")
	flags.DurationVar(&opts.timeout, "timeout", 60*time.Second, "transfer deadline")
	if err := flags.Parse(args); err != nil {
		return err
	}
	remaining := flags.Args()
	if len(remaining) != 3 || opts.address == "" || opts.user == "" ||
		opts.identity == "" || opts.hostKey == "" || opts.sidecar == "" || opts.timeout <= 0 {
		return errors.New("usage: zmodem-ssh-pty-bridge -addr HOST:PORT -user USER -identity KEY -hostkey HOST.PUB -sidecar BIN [-timeout 60s] send LOCAL_FILE REMOTE_DIR | receive LOCAL_DIR REMOTE_FILE")
	}
	direction, localPath, remotePath := remaining[0], remaining[1], remaining[2]
	command, err := remoteCommand(direction, remotePath)
	if err != nil {
		return err
	}
	localPath, err = verifyLocalPath(direction, localPath)
	if err != nil {
		return err
	}
	client, err := dialSSH(opts)
	if err != nil {
		return fmt.Errorf("SSH authentication/host-key verification failed: %w", err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), opts.timeout)
	defer cancel()
	if err := bridge(ctx, client, opts.sidecar, direction, localPath, command); err != nil {
		return err
	}
	fmt.Println("SSH PTY ZMODEM experiment completed")
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
