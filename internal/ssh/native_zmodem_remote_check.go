package sshclient

import (
	"context"
	"io"
	"strings"
	"time"

	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

// Exit codes of the pre-transfer check. They are above the range used by
// shells for signals (128+n) so a real rz/sz status can never be mistaken
// for one of them.
const (
	nativeCheckIsDirectory    = 210
	nativeCheckNotFound       = 211
	nativeCheckNotReadable    = 212
	nativeCheckDirNotWritable = 213
	nativeCheckLrzszMissing   = 214
	nativeRemoteCheckTimeout  = 10 * time.Second
	nativeTerminalEraseLine   = "\r\x1b[K"
)

// nativeInteractiveCheckCommand builds a command that runs in the same
// remote shell (so a relative path is resolved against the shell's working
// directory) and reports, through the nonce-bound completion marker, whether
// the transfer can start. It never runs rz or sz.
func nativeInteractiveCheckCommand(direction, remotePath, token string) (string, error) {
	// Reuse the transfer command validation for the token and the path.
	if _, _, err := nativeInteractiveFencedCommand(direction, remotePath, token); err != nil {
		return "", err
	}
	rc := "__openshell_native_zmodem_rc"
	var check string
	switch direction {
	case "upload", "upload-overwrite":
		check = "if ! command -v rz >/dev/null 2>&1; then " + rc + "=214; " +
			"elif [ ! -w . ]; then " + rc + "=213; " +
			"else " + rc + "=0; fi"
	case "download":
		quoted := "'" + strings.ReplaceAll(remotePath, "'", "'\\''") + "'"
		check = "if ! command -v sz >/dev/null 2>&1; then " + rc + "=214; " +
			"elif [ -d " + quoted + " ]; then " + rc + "=210; " +
			"elif [ ! -e " + quoted + " ]; then " + rc + "=211; " +
			"elif [ ! -r " + quoted + " ]; then " + rc + "=212; " +
			"else " + rc + "=0; fi"
	}
	return "{ " + check + "; printf '\\033]777;" + nativeRemoteBoundaryName + ";" + token +
		";%d\\007' \"$" + rc + "\"; }\r", nil
}

// nativeRemoteCheckError maps a check exit code to a user-facing error.
func nativeRemoteCheckError(code int, remotePath string) error {
	params := map[string]any{"path": remotePath}
	switch code {
	case 0:
		return nil
	case nativeCheckIsDirectory:
		return apperror.New("zmodemRemoteIsDirectory", params)
	case nativeCheckNotFound:
		return apperror.New("zmodemRemoteNotFound", params)
	case nativeCheckNotReadable:
		return apperror.New("zmodemRemoteNotReadable", params)
	case nativeCheckDirNotWritable:
		return apperror.New("zmodemRemoteDirNotWritable", nil)
	case nativeCheckLrzszMissing:
		return apperror.New("zmodemRemoteLrzszMissing", nil)
	}
	return apperror.New("zmodemRemoteCheckFailed", map[string]any{"status": code})
}

// zmodemRemoteDidNotStartError explains why a fenced transfer command ended
// before rz/sz spoke ZMODEM.
func zmodemRemoteDidNotStartError(code int, remotePath string) error {
	switch code {
	case nativeCheckIsDirectory, nativeCheckNotFound, nativeCheckNotReadable, nativeCheckDirNotWritable, nativeCheckLrzszMissing:
		return nativeRemoteCheckError(code, remotePath)
	case 127:
		return apperror.New("zmodemRemoteLrzszMissing", nil)
	}
	return apperror.New("zmodemRemoteDidNotStart", map[string]any{"status": code})
}

// eraseThenReplay drops the prompt line left behind after the intercepted
// rz/sz line was erased with Ctrl-U, so the prompt printed by the shell after
// the hidden command does not appear twice on the same line.
func eraseThenReplay(trailing func() []byte) func() []byte {
	return func() []byte {
		return append([]byte(nativeTerminalEraseLine), trailing()...)
	}
}

// checkRemote runs the pre-transfer check behind both terminal gates. The
// command and its echo are hidden; only the shell output that follows the
// completion marker (the fresh prompt) reaches the terminal.
func (c *nativeTerminalCoordinator) checkRemote(parent context.Context, direction, remotePath string) error {
	if parent == nil || c == nil || c.input == nil || c.output == nil {
		return apperror.New("zmodemMissingContext", nil)
	}
	token, err := newNativeRemoteBoundaryToken()
	if err != nil {
		return apperror.Wrap("zmodemBoundaryTokenFailed", err, nil)
	}
	command, err := nativeInteractiveCheckCommand(direction, remotePath, token)
	if err != nil {
		return err
	}
	inputLease, err := c.input.takeover()
	if err != nil {
		return err
	}
	// Nothing but the marker is expected. A ZMODEM header here would mean
	// something else is talking on the terminal; its bytes are dropped.
	fence := newNativeRemoteBoundarySink(io.Discard, token)
	outputLease, err := c.output.armOnZmodemHeaderQuietBoundary(fence, fence.prefix)
	if err != nil {
		_ = c.input.restore(inputLease)
		return err
	}
	restore := func() error {
		if err := c.output.restoreWithReplay(outputLease, eraseThenReplay(fence.replayTrailing)); err != nil {
			// The marker never switched the gate: give the terminal back.
			if disarmErr := c.output.disarm(outputLease); disarmErr != nil {
				return err
			}
		}
		return c.input.restore(inputLease)
	}
	if n, err := c.input.writeNative(inputLease, []byte(command)); err != nil || n != len(command) {
		_ = restore()
		if err == nil {
			err = io.ErrShortWrite
		}
		return apperror.Wrap("zmodemRemoteCheckFailedSend", err, nil)
	}
	timer := time.NewTimer(nativeRemoteCheckTimeout)
	defer timer.Stop()
	select {
	case remote := <-fence.completion:
		if err := restore(); err != nil {
			return err
		}
		if remote.err != nil {
			return apperror.Wrap("zmodemRemoteCheckFailedSend", remote.err, nil)
		}
		return nativeRemoteCheckError(remote.code, remotePath)
	case <-timer.C:
		_ = restore()
		return apperror.New("zmodemRemoteCheckTimeout", nil)
	case <-parent.Done():
		_ = restore()
		return parent.Err()
	}
}

// CheckNativeZmodemRemote verifies, before the file picker opens, that the
// remote side can take part: for sz the file exists, is a regular readable
// file; for rz the working directory is writable; lrzsz is installed. It
// only runs while the picker reservation for selectionID is held.
func (m *Manager) CheckNativeZmodemRemote(ctx context.Context, ref domain.ConnectionRef, selectionID uint64, direction, remotePath string) error {
	if direction != "upload" && direction != "upload-overwrite" && direction != "download" {
		return apperror.New("zmodemUnsupportedDirection", nil)
	}
	if direction == "download" && (remotePath == "" || strings.ContainsAny(remotePath, "\r\n")) {
		return apperror.New("zmodemSingleRemoteFile", nil)
	}
	m.mu.Lock()
	c := m.connections[ref.TabID]
	if c == nil || c.ref != ref || c.inputGate == nil || c.outputGate == nil || m.closed {
		m.mu.Unlock()
		return apperror.New("zmodemTerminalGone", nil)
	}
	if !c.nativeZmodemSelection || c.nativeZmodemSelectionPassive || selectionID == 0 || selectionID != c.nativeZmodemSelectionID {
		m.mu.Unlock()
		return apperror.New("zmodemSelectionExpired", nil)
	}
	if c.aiController != nil || c.nativeTerminalTransfer != nil || c.nativeTerminalPoisoned {
		m.mu.Unlock()
		return apperror.New("zmodemTerminalBusy", nil)
	}
	input, output := c.inputGate, c.outputGate
	m.mu.Unlock()
	coordinator := &nativeTerminalCoordinator{input: input, output: output}
	return coordinator.checkRemote(ctx, direction, remotePath)
}
