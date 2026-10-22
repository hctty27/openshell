package main

import (
    "strings"
    "testing"
)

func TestParseSFTPAIProposals(t *testing.T) {
 var v aiEditJSON
 if err:=parseAIJSON("```json\n{\"summary\":\"Fix port\",\"content\":\"port: 9090\\n\"}\n```",&v);err!=nil {t.Fatal(err)}
 if v.Content!="port: 9090\n" {t.Fatalf("unrecognized model proposal: %#v",v)}
 if err:=parseAIJSON("{\"content\":\"ok\",\"unknown\":true}",&v);err==nil {t.Fatal("unknown fields accepted")}
 if err:=parseAIJSON("{\"content\":\"ok\"}{\"content\":\"extra\"}",&v);err==nil {t.Fatal("trailing JSON accepted")}
}

func TestAIUploadFilenameBoundaries(t *testing.T) {
 for _,name:=range []string{"../passwd","config/app.yml","..",".","foo\\bar","line\nbreak",""} {
  if _,err:=proposedFilename(name);err==nil {t.Fatalf("unsafe AI filename accepted %q",name)}
 }
 for _,name:=range []string{"release.jar","application.yml","service-2026.zip"} {
  valid,err:=proposedFilename(name)
  if err!=nil || valid!=name {t.Fatalf("rejected %q: %v",name,err)}
 }
 if _,err:=proposedFilename(strings.Repeat("a",201));err==nil {t.Fatal("oversized AI filename accepted")}
}
