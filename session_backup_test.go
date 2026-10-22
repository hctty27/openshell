package main

import (
	"encoding/json"
	"testing"

	"github.com/hctty27/openshell/internal/domain"
)

func TestParseSessionBackupNestedFoldersAndCredentials(t *testing.T) {
	backup := sessionBackup{
		Format:sessionBackupFormat, Version:1,
		Groups:[]domain.Group{{ID:"parent",Name:"Operations"},{ID:"child",Name:"Production",ParentID:"parent"}},
		Sessions:[]domain.Session{{ID:"old",GroupID:"child",Name:"prod-db",Host:"example.com",Port:22,Username:"root",AuthType:"password",CredentialRef:"sensitive-reference"}},
	}
	raw, err := json.Marshal(backup)
	if err != nil { t.Fatal(err) }
	preview, err := parseSessionBackup(raw)
	if err != nil { t.Fatal(err) }
	if preview.Source != "openshell" || len(preview.Entries) != 1 { t.Fatalf("unexpected preview: %+v", preview) }
	entry := preview.Entries[0]
	if entry.Folder != "Operations/Production" || entry.Session.CredentialRef != "" || entry.Session.ID != "" {
		t.Fatalf("restore must reconstruct folders without secrets: %+v", entry)
	}
}

func TestParseSessionBackupRejectsCycle(t *testing.T) {
	backup := sessionBackup{
		Format:sessionBackupFormat, Version:1,
		Groups:[]domain.Group{{ID:"a",Name:"A",ParentID:"b"},{ID:"b",Name:"B",ParentID:"a"}},
		Sessions:[]domain.Session{{ID:"x",GroupID:"a",Name:"server",Host:"example.com",Port:22,Username:"root"}},
	}
	raw, _ := json.Marshal(backup)
	if _, err := parseSessionBackup(raw); err == nil { t.Fatal("expected folder cycle rejection") }
}
