package sshclient

import (
	"encoding/binary"
	"encoding/hex"
	"hash/crc32"
	"strconv"
	"testing"
)

func encodeZmodemTestQuoted(value byte) []byte {
	if value == 0x7f {
		return []byte{zmodemZDLE, 'l'}
	}
	if value == 0xff {
		return []byte{zmodemZDLE, 'm'}
	}
	if value == zmodemZDLE || value < 0x20 {
		return []byte{zmodemZDLE, value ^ 0x40}
	}
	return []byte{value}
}

func encodeZmodemTestHeader(frameType, format byte, position uint32) []byte {
	raw := make([]byte, 5)
	raw[0] = frameType
	binary.LittleEndian.PutUint32(raw[1:], position)

	if format == 'B' {
		crc := zmodemCRC16(raw)
		raw = append(raw, byte(crc>>8), byte(crc))
		encoded := make([]byte, hex.EncodedLen(len(raw)))
		hex.Encode(encoded, raw)
		return append([]byte("**\x18B"), append(encoded, []byte("\r\n\x11")...)...)
	}

	if format == 'C' {
		crc := crc32.ChecksumIEEE(raw)
		raw = append(raw, byte(crc), byte(crc>>8), byte(crc>>16), byte(crc>>24))
	} else {
		crc := zmodemCRC16(raw)
		raw = append(raw, byte(crc>>8), byte(crc))
	}
	prefix := []byte{'*', zmodemZDLE, format}
	for _, value := range raw {
		prefix = append(prefix, encodeZmodemTestQuoted(value)...)
	}
	return prefix
}

func encodeZmodemTestSubpacket(payload []byte, marker byte, crc32Mode bool) []byte {
	result := make([]byte, 0, len(payload)+12)
	for _, value := range payload {
		result = append(result, encodeZmodemTestQuoted(value)...)
	}
	result = append(result, zmodemZDLE, marker)
	if crc32Mode {
		crcInput := append(append([]byte(nil), payload...), marker)
		crc := crc32.ChecksumIEEE(crcInput)
		crcBytes := []byte{byte(crc), byte(crc >> 8), byte(crc >> 16), byte(crc >> 24)}
		for _, value := range crcBytes {
			result = append(result, encodeZmodemTestQuoted(value)...)
		}
	} else {
		crcInput := append(append([]byte(nil), payload...), marker)
		crc := zmodemCRC16(crcInput)
		for _, value := range []byte{byte(crc >> 8), byte(crc)} {
			result = append(result, encodeZmodemTestQuoted(value)...)
		}
	}
	if marker == 'k' {
		result = append(result, 0x11)
	}
	return result
}

func encodeZmodemTestFile(name string, size uint64, format byte) []byte {
	payload := []byte(name + "\x00" + formatZmodemTestSize(size) + " 0 100644\x00")
	crc32Mode := format == 'C'
	frame := encodeZmodemTestHeader(zmodemZFILE, format, 0)
	return append(frame, encodeZmodemTestSubpacket(payload, 'k', crc32Mode)...)
}

func formatZmodemTestSize(size uint64) string {
	return strconv.FormatUint(size, 10)
}

func TestZmodemMetadataParserReadsHexFileInfoAcrossChunks(t *testing.T) {
	var files []zmodemFileMetadata
	var completed []uint64
	parser := newZmodemMetadataParser(
		func(file zmodemFileMetadata) { files = append(files, file) },
		func(_ zmodemFileMetadata, size uint64) { completed = append(completed, size) },
	)
	stream := encodeZmodemTestFile("../../remote/backup.tar.gz", 1048576, 'B')
	for _, value := range stream {
		parser.Write([]byte{value})
	}
	if len(files) != 1 || files[0].Name != "backup.tar.gz" || files[0].Total != 1048576 {
		t.Fatalf("unexpected file metadata: %+v", files)
	}

	parser.Write(encodeZmodemTestHeader(zmodemZEOF, 'B', 1048576))
	if len(completed) != 1 || completed[0] != 1048576 {
		t.Fatalf("unexpected completed size: %+v", completed)
	}
}

func TestZmodemMetadataParserReadsBinaryFileInfoAndSkipsDataPayload(t *testing.T) {
	var files []zmodemFileMetadata
	parser := newZmodemMetadataParser(
		func(file zmodemFileMetadata) { files = append(files, file) },
		nil,
	)
	fakeFile := encodeZmodemTestFile("fake.bin", 999, 'B')
	dataFrame := encodeZmodemTestHeader(10, 'A', 0)
	dataFrame = append(dataFrame, encodeZmodemTestSubpacket(fakeFile, 'i', false)...)
	dataFrame = append(dataFrame, encodeZmodemTestSubpacket([]byte("more data"), 'k', false)...)
	parser.Write(dataFrame)
	if len(files) != 0 {
		t.Fatalf("file-like bytes inside ZDATA were parsed: %+v", files)
	}

	parser.Write(encodeZmodemTestFile("real.bin", 2048, 'A'))
	if len(files) != 1 || files[0].Name != "real.bin" || files[0].Total != 2048 {
		t.Fatalf("unexpected binary file metadata: %+v", files)
	}
}

func TestZmodemMetadataParserReadsCRC32FileInfo(t *testing.T) {
	var files []zmodemFileMetadata
	parser := newZmodemMetadataParser(
		func(file zmodemFileMetadata) { files = append(files, file) },
		nil,
	)
	parser.Write(encodeZmodemTestFile("large.bin", 3*1024*1024, 'C'))
	if len(files) != 1 || files[0].Name != "large.bin" || files[0].Total != 3*1024*1024 {
		t.Fatalf("unexpected CRC32 metadata: %+v", files)
	}
}

func TestParseZmodemFileInfoRejectsMissingOrInvalidSize(t *testing.T) {
	for _, payload := range [][]byte{
		[]byte("missing-size\x00\x00"),
		[]byte("bad-size\x00unknown 0 100644\x00"),
		[]byte("\x001024 0 100644\x00"),
	} {
		if _, ok := parseZmodemFileInfo(payload); ok {
			t.Fatalf("invalid metadata was accepted: %q", payload)
		}
	}
}
