package sshclient

import "regexp"

// Only a native lease is allowed to consume protocol data.
var zmodemDirectionPattern = regexp.MustCompile(`\*\*\x18B0([01])[0-9a-f]{12}`)

// nativeZmodemStartScanner recognizes the same ZMODEM header signature as
// the ZMODEM start signature while preserving bytes across SSH Write calls.
// Both native handoff and the unclaimed-protocol safety guard use it.
type nativeZmodemStartScanner struct {
	tail []byte
}

const nativeZmodemHeaderSize = 18

func (s *nativeZmodemStartScanner) feed(p []byte) (legacy, native []byte, matched bool) {
	data := make([]byte, 0, len(s.tail)+len(p))
	data = append(data, s.tail...)
	data = append(data, p...)
	s.tail = nil

	if match := zmodemDirectionPattern.FindIndex(data); match != nil {
		legacy = append([]byte(nil), data[:match[0]]...)
		native = append([]byte(nil), data[match[0]:]...)
		return legacy, native, true
	}

	keep := len(data)
	if keep >= nativeZmodemHeaderSize {
		keep = nativeZmodemHeaderSize - 1
	}
	for keep > 0 && !isNativeZmodemHeaderPrefix(data[len(data)-keep:]) {
		keep--
	}
	legacy = append([]byte(nil), data[:len(data)-keep]...)
	s.tail = append(s.tail, data[len(data)-keep:]...)
	return legacy, nil, false
}

func isNativeZmodemHeaderPrefix(data []byte) bool {
	if len(data) > nativeZmodemHeaderSize {
		return false
	}
	for i, char := range data {
		switch i {
		case 0, 1:
			if char != '*' {
				return false
			}
		case 2:
			if char != 0x18 {
				return false
			}
		case 3:
			if char != 'B' {
				return false
			}
		case 4:
			if char != '0' {
				return false
			}
		case 5:
			if char != '0' && char != '1' {
				return false
			}
		default:
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
				return false
			}
		}
	}
	return true
}
