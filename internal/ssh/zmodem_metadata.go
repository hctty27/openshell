package sshclient

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"hash/crc32"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	zmodemZDLE             = byte(0x18)
	zmodemZFILE             = byte(4)
	zmodemZEOF              = byte(11)
	zmodemZABORT             = byte(7)
	zmodemZFIN               = byte(8)
	zmodemMaxFileInfo        = 4096
	zmodemMaxPendingMetadata = 128 * 1024
)

type zmodemFileMetadata struct {
	Name  string
	Total uint64
}

type zmodemMetadataParser struct {
	pending         []byte
	currentFile     *zmodemFileMetadata
	onFile          func(zmodemFileMetadata)
	onFileCompleted func(zmodemFileMetadata, uint64)
}

type zmodemFrameHeader struct {
	frameType byte
	position  uint32
	crc32     bool
}

func newZmodemMetadataParser(
	onFile func(zmodemFileMetadata),
	onFileCompleted func(zmodemFileMetadata, uint64),
) *zmodemMetadataParser {
	return &zmodemMetadataParser{
		onFile:          onFile,
		onFileCompleted: onFileCompleted,
	}
}

// Write observes the remote ZMODEM stream without consuming or modifying it.
func (p *zmodemMetadataParser) Write(data []byte) {
	if len(data) == 0 {
		return
	}
	p.pending = append(p.pending, data...)
	p.process()
	if len(p.pending) > zmodemMaxPendingMetadata {
		p.pending = append(p.pending[:0], p.pending[len(p.pending)-4:]...)
		p.currentFile = nil
	}
}

func (p *zmodemMetadataParser) process() {
	for len(p.pending) > 0 {
		header, headerEnd, found, needMore := parseZmodemFrameHeader(p.pending)
		if needMore {
			return
		}
		if !found {
			p.keepHeaderTail()
			return
		}

		frameEnd := headerEnd
		var fileInfo []byte
		firstSubpacket := true
		if zmodemFrameHasData(header.frameType) {
			for {
				capture := header.frameType == zmodemZFILE && firstSubpacket
				payload, consumed, marker, complete := parseZmodemDataSubpacket(
					p.pending[frameEnd:], header.crc32, capture,
				)
				if !complete {
					return
				}
				if capture {
					fileInfo = payload
				}
				firstSubpacket = false
				frameEnd += consumed
				if marker == 'h' || marker == 'k' {
					break
				}
			}
		}

		switch header.frameType {
		case zmodemZFILE:
			if file, ok := parseZmodemFileInfo(fileInfo); ok {
				p.currentFile = &file
				if p.onFile != nil {
					p.onFile(file)
				}
			}
		case zmodemZEOF:
			if p.currentFile != nil {
				file := *p.currentFile
				if p.onFileCompleted != nil {
					p.onFileCompleted(file, uint64(header.position))
				}
				p.currentFile = nil
			}
		case zmodemZABORT, zmodemZFIN:
			p.currentFile = nil
		}

		p.pending = p.pending[frameEnd:]
	}
}

func (p *zmodemMetadataParser) keepHeaderTail() {
	if len(p.pending) > 4 {
		p.pending = append(p.pending[:0], p.pending[len(p.pending)-4:]...)
	}
}

func zmodemFrameHasData(frameType byte) bool {
	switch frameType {
	case 2, zmodemZFILE, 10, 18, 19:
		return true
	default:
		return false
	}
}

func parseZmodemFrameHeader(data []byte) (zmodemFrameHeader, int, bool, bool) {
	for i := 0; i < len(data); i++ {
		if data[i] != '*' {
			continue
		}

		j := i
		for j < len(data) && data[j] == '*' {
			j++
		}
		if j == len(data) {
			return zmodemFrameHeader{}, 0, false, true
		}
		if data[j] != zmodemZDLE {
			continue
		}
		if j+1 >= len(data) {
			return zmodemFrameHeader{}, 0, false, true
		}

		format := data[j+1]
		switch format {
		case 'B', 'b':
			if j-i < 2 {
				continue
			}
			start := j + 2
			if len(data) < start+14 {
				return zmodemFrameHeader{}, 0, false, true
			}
			raw := make([]byte, 7)
			if _, err := hex.Decode(raw, data[start:start+14]); err != nil ||
				!validZmodemCRC16(raw[:5], raw[5:7]) {
				continue
			}
			end := start + 14
			if end < len(data) && data[end] == '\r' {
				if end+1 >= len(data) {
					return zmodemFrameHeader{}, 0, false, true
				}
				if data[end+1] == '\n' || data[end+1] == 0x8a {
					end += 2
				}
			}
			if end < len(data) && (data[end] == 0x11 || data[end] == 0x91) {
				end++
			}
			return makeZmodemFrameHeader(raw, false), end, true, false
		case 'A', 'C', 'D':
			crc32Mode := format == 'C' || format == 'D'
			rawLength := 7
			if crc32Mode {
				rawLength = 9
			}
			raw := make([]byte, rawLength)
			offset := j + 2
			for index := range raw {
				value, consumed, complete := decodeZmodemQuotedByte(data[offset:])
				if !complete {
					return zmodemFrameHeader{}, 0, false, true
				}
				raw[index] = value
				offset += consumed
			}
			if crc32Mode {
				if !validZmodemCRC32(raw[:5], raw[5:9]) {
					continue
				}
			} else if !validZmodemCRC16(raw[:5], raw[5:7]) {
				continue
			}
			return makeZmodemFrameHeader(raw, crc32Mode), offset, true, false
		default:
			continue
		}
	}
	return zmodemFrameHeader{}, 0, false, false
}

func makeZmodemFrameHeader(raw []byte, crc32Mode bool) zmodemFrameHeader {
	return zmodemFrameHeader{
		frameType: raw[0],
		position:  binary.LittleEndian.Uint32(raw[1:5]),
		crc32:     crc32Mode,
	}
}

func decodeZmodemQuotedByte(data []byte) (byte, int, bool) {
	if len(data) == 0 {
		return 0, 0, false
	}
	if data[0] != zmodemZDLE {
		return data[0], 1, true
	}
	if len(data) < 2 {
		return 0, 0, false
	}
	switch data[1] {
	case 'l':
		return 0x7f, 2, true
	case 'm':
		return 0xff, 2, true
	default:
		return data[1] ^ 0x40, 2, true
	}
}

func parseZmodemDataSubpacket(data []byte, crc32Mode, capture bool) ([]byte, int, byte, bool) {
	var payload []byte
	if capture {
		payload = make([]byte, 0, 256)
	}

	for offset := 0; offset < len(data); {
		if data[offset] == zmodemZDLE && offset+1 < len(data) &&
			(data[offset+1] == 'h' || data[offset+1] == 'i' ||
				data[offset+1] == 'j' || data[offset+1] == 'k') {
			marker := data[offset+1]
			offset += 2
			crcLength := 2
			if crc32Mode {
				crcLength = 4
			}
			for count := 0; count < crcLength; count++ {
				_, consumed, complete := decodeZmodemQuotedByte(data[offset:])
				if !complete {
					return nil, 0, 0, false
				}
				offset += consumed
			}
			if offset < len(data) && (data[offset] == 0x11 || data[offset] == 0x91) {
				offset++
			}
			return payload, offset, marker, true
		}

		value, consumed, complete := decodeZmodemQuotedByte(data[offset:])
		if !complete {
			return nil, 0, 0, false
		}
		if capture && len(payload) < zmodemMaxFileInfo {
			payload = append(payload, value)
		}
		offset += consumed
	}
	return nil, 0, 0, false
}

func parseZmodemFileInfo(data []byte) (zmodemFileMetadata, bool) {
	nameEnd := bytes.IndexByte(data, 0)
	if nameEnd <= 0 {
		return zmodemFileMetadata{}, false
	}
	name := strings.TrimSpace(strings.ToValidUTF8(string(data[:nameEnd]), "�"))
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	if name == "" || name == "." || name == "/" {
		return zmodemFileMetadata{}, false
	}

	fieldsData := data[nameEnd+1:]
	if end := bytes.IndexByte(fieldsData, 0); end >= 0 {
		fieldsData = fieldsData[:end]
	}
	fields := strings.Fields(string(fieldsData))
	if len(fields) == 0 {
		return zmodemFileMetadata{}, false
	}
	size, err := strconv.ParseUint(fields[0], 10, 64)
	if err != nil {
		return zmodemFileMetadata{}, false
	}
	return zmodemFileMetadata{Name: name, Total: size}, true
}

func validZmodemCRC16(data, expected []byte) bool {
	if len(expected) != 2 {
		return false
	}
	return zmodemCRC16(data) == binary.BigEndian.Uint16(expected)
}

func zmodemCRC16(data []byte) uint16 {
	var crc uint16
	for _, value := range data {
		crc ^= uint16(value) << 8
		for bit := 0; bit < 8; bit++ {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	for range 2 {
		for bit := 0; bit < 8; bit++ {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

func validZmodemCRC32(data, expected []byte) bool {
	return len(expected) == 4 && crc32.ChecksumIEEE(data) == binary.LittleEndian.Uint32(expected)
}
