package sshclient

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"strconv"
	"strings"
)

const (
	nativeRemoteBoundaryName = "OpenShellNativeZmodem"
	nativeRemoteBoundaryPostLimit = 64 * 1024
)

type nativeRemoteExit struct {
	code int
	err error
}

// Each transfer receives a fresh unguessable marker. This identifies the
// completion of the shell command started by OpenShell; it is NOT a form of
// authentication against a malicious remote server.
func newNativeRemoteBoundaryToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func nativeInteractiveFencedCommand(direction, remotePath, token string) (string, string, error) {
	rawToken, err := hex.DecodeString(token)
	if err != nil || len(rawToken) != 16 || hex.EncodeToString(rawToken) != token {
		return "", "", errors.New("无效的原生 ZMODEM 远端结束令牌")
	}
	command, action, err := nativeInteractiveCommand(direction, remotePath)
	if err != nil {
		return "", "", err
	}
	command = strings.TrimSuffix(command, "\r")
	// The shell echoes literal backslash sequences, not ESC/BEL, so its own
	// command echo cannot look like the binary completion marker. The marker
	// is emitted only after rz/sz has exited and its status is captured.
	wrapped := "{ " + command +
		"; __openshell_native_zmodem_rc=$?; printf '\\033]777;" +
		nativeRemoteBoundaryName + ";" + token +
		";%d\\007' \"$__openshell_native_zmodem_rc\"; }\r"
	return wrapped, action, nil
}

// nativeRemoteBoundarySink is placed after the output gate's verified start
// header scanner. It forwards original protocol bytes to the Rust sidecar
// while withholding the transfer-specific OSC completion marker. Subsequent
// shell output is held until the output gate can replay it atomically to the
// legacy terminal after successful protocol completion.
type nativeRemoteBoundarySink struct {
	downstream io.Writer
	prefix []byte
	pending []byte
	trailing []byte
	finished bool
	completion chan nativeRemoteExit
}

func newNativeRemoteBoundarySink(downstream io.Writer, token string) *nativeRemoteBoundarySink {
	return &nativeRemoteBoundarySink{
		downstream: downstream,
		prefix: []byte("\x1b]777;" + nativeRemoteBoundaryName + ";" + token + ";"),
		completion: make(chan nativeRemoteExit, 1),
	}
}

func (s *nativeRemoteBoundarySink) appendTrailing(data []byte) error {
	if len(data) > nativeRemoteBoundaryPostLimit-len(s.trailing) {
		return errors.New("远端 ZMODEM 完成标记之后输出过多，已停止自动恢复")
	}
	s.trailing = append(s.trailing, data...)
	return nil
}

func (s *nativeRemoteBoundarySink) Write(p []byte) (int, error) {
	if s.finished {
		if err := s.appendTrailing(p); err != nil { return 0, err }
		return len(p), nil
	}
	data := make([]byte, 0, len(s.pending)+len(p))
	data = append(data, s.pending...)
	data = append(data, p...)
	s.pending = nil

	if start := bytes.Index(data, s.prefix); start >= 0 {
		// Forward only pre-marker protocol bytes. An incomplete marker is
		// retained across arbitrary SSH stdout chunk boundaries.
		if err := writeNativeGateBytes(s.downstream, data[:start]); err != nil {
			return 0, err
		}
		suffix := data[start+len(s.prefix):]
		end := bytes.IndexByte(suffix, '\x07')
		if end == -1 {
			if len(suffix) > 3 {
				return 0, errors.New("远端 ZMODEM 结束标记的退出码格式无效")
			}
			s.pending = append(s.pending, data[start:]...)
			return len(p), nil
		}
		if end == 0 || end > 3 {
			return 0, errors.New("远端 ZMODEM 结束标记的退出码长度无效")
		}
		for _, ch := range suffix[:end] {
			if ch < '0' || ch > '9' {
				return 0, errors.New("远端 ZMODEM 结束标记的退出码无效")
			}
		}
		code, err := strconv.Atoi(string(suffix[:end]))
		if err != nil || code > 255 {
			return 0, errors.New("远端 ZMODEM 退出码超出允许范围")
		}
		if err := s.appendTrailing(suffix[end+1:]); err != nil {
			return 0, err
		}
		s.finished = true
		s.completion <- nativeRemoteExit{code: code}
		return len(p), nil
	}

	keep := len(data)
	if keep >= len(s.prefix) { keep = len(s.prefix) - 1 }
	for keep > 0 && !bytes.Equal(data[len(data)-keep:], s.prefix[:keep]) {
		keep--
	}
	if err := writeNativeGateBytes(s.downstream, data[:len(data)-keep]); err != nil {
		return 0, err
	}
	s.pending = append(s.pending, data[len(data)-keep:]...)
	return len(p), nil
}

// The output gate MUST be locked while reading the trailing bytes: it is
// the sole caller of Write, so its lock establishes a total byte order.
func (s *nativeRemoteBoundarySink) replayTrailing() []byte {
	return append([]byte(nil), s.trailing...)
}

var _ io.Writer = (*nativeRemoteBoundarySink)(nil)
