package sshclient

import (
    "bytes"
    "strings"
    "testing"
)

func TestTrzszDirectionWriterDetectsNativeTransferModes(t *testing.T) {
    var output bytes.Buffer
    var calls []string
    writer := &zmodemDirectionWriter{
        dst: &output,
        onTrzsz: func(direction string, directory bool) bool {
            calls = append(calls, direction+":"+map[bool]string{false: "file", true: "directory"}[directory])
            return true
        },
    }
    data := []string{
        "before ::TRZSZ:TRANS",
        "FER:R:1.2.0:123456789012300\r\n",
        "::TRZSZ:TRANSFER:S:1.2.0:123456789012301\r\n",
        "::TRZSZ:TRANSFER:D:1.2.0:123456789012302\r\n",
    }
    for _, part := range data {
        if _, err := writer.Write([]byte(part)); err != nil { t.Fatal(err) }
    }
    if output.String() != strings.Join(data, "") { t.Fatal("terminal stream was changed") }
    if got := strings.Join(calls, ","); got != "upload:file,download:file,upload:directory" {
        t.Fatalf("unexpected native triggers: %s", got)
    }
}

func TestTrzszDirectionWriterSuppressesCanceledTrigger(t *testing.T) {
    var output bytes.Buffer
    writer := &zmodemDirectionWriter{
        dst: &output,
        onTrzsz: func(string, bool) bool { return false },
    }
    trigger := "::TRZSZ:TRANSFER:R:1.2.0:123456789012300\r\n"
    if _, err := writer.Write([]byte(trigger)); err != nil { t.Fatal(err) }
    if output.Len() != 0 { t.Fatal("canceled native transfer reached the filter") }
}
