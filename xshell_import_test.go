package main

import (
	"archive/zip"
	"errors"
	"github.com/hctty27/openshell/internal/apperror"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

const xshellFixture = "[SessionInfo]\r\nVersion=7.0\r\n[CONNECTION]\r\nProtocol=SSH\r\nHost=example.com\r\nPort=2222\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=deploy\r\nUserKey=mykey\r\n"

func TestParseXshellSessionUTF16(t *testing.T) {
	units := utf16.Encode([]rune(xshellFixture))
	data := []byte{0xff, 0xfe}
	for _, unit := range units { data = append(data, byte(unit), byte(unit>>8)) }
	entry, err := parseXshellSession("Sessions/Production/API.xsh", data)
	if err != nil { t.Fatal(err) }
	if entry.Session.Host != "example.com" || entry.Session.Port != 2222 || entry.Session.Username != "deploy" {
		t.Fatalf("unexpected session: %+v", entry.Session)
	}
	if entry.Folder != "Production" || entry.Session.Name != "API" || !strings.Contains(entry.Warning,"key") {
		t.Fatalf("unexpected Xshell import: %+v", entry)
	}
	if entry.Session.CredentialRef != "" || entry.Session.PrivateKeyPath != "" { t.Fatal("imported private credential") }
}

func TestParseXshellArchiveFiltersUnsupported(t *testing.T) {
	name := filepath.Join(t.TempDir(), "sessions.xts")
	file, err := os.Create(name)
	if err != nil { t.Fatal(err) }
	writer := zip.NewWriter(file)
	good, _ := writer.Create("Sessions/Prod/host.xsh")
	_, _ = good.Write([]byte(xshellFixture))
	bad, _ := writer.Create("Sessions/Prod/telnet.xsh")
	_, _ = bad.Write([]byte(strings.Replace(xshellFixture, "Protocol=SSH", "Protocol=TELNET",1)))
	traversal, _ := writer.Create("../bad.xsh")
	_, _ = traversal.Write([]byte(xshellFixture))
	if err := writer.Close(); err != nil { t.Fatal(err) }
	if err := file.Close(); err != nil { t.Fatal(err) }
	preview, err := parseXshellImport(name)
	if err != nil { t.Fatal(err) }
	if len(preview.Entries) != 1 || len(preview.Skipped) != 2 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if preview.Entries[0].Folder != "Prod" { t.Fatal(preview.Entries[0].Folder) }
}

func TestParseXshellMissingUsername(t *testing.T) {
	data := strings.Replace(xshellFixture, "UserName=deploy", "", 1)
	_, err := parseXshellSession("test.xsh", []byte(data))
	var coded *apperror.Error
	if !errors.As(err, &coded) || coded.Code != "xshellImportMissingUsernameConfigureItInXshellFirst" {
		t.Fatalf("unexpected error: %v", err)
	}
}
