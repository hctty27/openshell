package sshclient

import (
	"encoding/hex"
	"regexp"
)

// Only a native lease is allowed to consume protocol data. ZHEX start
// headers contain: frame type (1 B), 4 flag/position bytes, CRC-16 (2 B).
// Check the CRC before allowing any terminal stream to be quarantined.
var zmodemDirectionPattern = regexp.MustCompile(`\*\*\x18B0([01])[0-9a-fA-F]{12}`)

// nativeZmodemStartScanner recognizes the same ZMODEM header signature as
// the ZMODEM start signature while preserving bytes across SSH Write calls.
// Both native handoff and the unclaimed-protocol safety guard use it.
type nativeZmodemStartScanner struct {
	tail []byte
	// A passive, unclaimed-protocol guard must quarantine even a corrupted
	// ZHEX-looking frame. Without a valid PTY lease it is unsafe to let
	// possible binary data reach xterm. A native transfer handoff requires
	// CRC validation and leaves this setting disabled.
	quarantineMalformed bool
}

const nativeZmodemHeaderSize = 18

// ZMODEM uses the CRC-16/XMODEM polynomial 0x1021 over the decoded type
// and four flag bytes. This matches lrzsz zshhdr's updcrc calculation
// including its two final zero update operations.
func nativeZmodemCRC16(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b) << 8
		for bit := 0; bit < 8; bit++ {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

func nativeZmodemValidStartHeader(header []byte) bool {
	if len(header) != nativeZmodemHeaderSize ||
		header[0] != '*' || header[1] != '*' ||
		header[2] != 0x18 || header[3] != 'B' {
		return false
	}
	var decoded [7]byte
	if _, err := hex.Decode(decoded[:], header[4:]); err != nil {
		return false
	}
	if decoded[0] != 0 && decoded[0] != 1 {
		return false
	}
	actual := uint16(decoded[5])<<8 | uint16(decoded[6])
	return actual == nativeZmodemCRC16(decoded[:5])
}

func (s *nativeZmodemStartScanner) feed(p []byte) (legacy, native []byte, matched bool) {
	data := make([]byte, 0, len(s.tail)+len(p))
	data = append(data, s.tail...)
	data = append(data, p...)
	s.tail = nil

	// The terminal can print literal text that happens to resemble an
	// unverified ZMODEM header. Skip false positives while continuing to
	// search this same chunk for a later *valid* start frame.
	for offset := 0; offset < len(data); {
		candidate := zmodemDirectionPattern.FindIndex(data[offset:])
		if candidate == nil { break }
		start, end := offset+candidate[0], offset+candidate[1]
		if s.quarantineMalformed || nativeZmodemValidStartHeader(data[start:end]) {
			legacy = append([]byte(nil), data[:start]...)
			native = append([]byte(nil), data[start:]...)
			return legacy, native, true
		}
		offset = start + 1
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
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') ||
				(char >= 'A' && char <= 'F')) {
				return false
			}
		}
	}
	return true
}
