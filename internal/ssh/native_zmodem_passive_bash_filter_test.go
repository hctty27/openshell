package sshclient

import (
	"bytes"
	"testing"
)

func TestNativePassiveBashHookFilterSplitMarkersAndOrdinaryOutput(t *testing.T) {
	var output bytes.Buffer
	f:=newNativePassiveBashHookFilter(&output)
	f.setToken(testNativePassiveSessionToken)
	markers:=[]byte(nativePassiveBashHookChallenge+
		nativePassiveBashHookReady+
		"\x1b]777;OpenShellNativeZmodem;"+testNativePassiveSessionToken+";0\x07")
	data:=append([]byte("ordinary before \x1b[32mvisible\x1b[0m\n"),markers...)
	data=append(data,[]byte("ordinary after\x1b]7;file://host/tmp\x07 done")...)
	for _, b:=range data {
		if n,err:=f.Write([]byte{b});err!=nil||n!=1 {t.Fatalf("partial OSC error: %d %v",n,err)}
	}
	want:="ordinary before \x1b[32mvisible\x1b[0m\nordinary after\x1b]7;file://host/tmp\x07 done"
	if output.String()!=want {t.Fatalf("filtered output mismatch: got %q want %q",output.String(),want)}
	for _, expected:=range []byte{nativeHookEventChallenge,nativeHookEventReady} {
		select {case got:=<-f.events: if got!=expected {t.Fatalf("event=%d expected=%d",got,expected)}
		default:t.Fatalf("missing hook event %d",expected)}
	}
}
func TestNativePassiveBashHookFilterDoesNotStripWrongSessionExit(t *testing.T) {
	var out bytes.Buffer
	f:=newNativePassiveBashHookFilter(&out)
	f.setToken(testNativePassiveSessionToken)
	frame:=[]byte("\x1b]777;OpenShellNativeZmodem;aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;0\x07")
	_,err:=f.Write(frame)
	if err!=nil||!bytes.Equal(out.Bytes(),frame){t.Fatalf("other-session OSC was silently trusted: %q %v",out.Bytes(),err)}
}
func TestNativePassiveBashHookFilterBoundsUnterminatedOSC(t *testing.T) {
	var out bytes.Buffer
	f:=newNativePassiveBashHookFilter(&out)
	blob:=append([]byte("\x1b]Other;"),bytes.Repeat([]byte{'a'},nativeHookOSCLimit*2)...)
	if _,err:=f.Write(blob);err!=nil {t.Fatal(err)}
	if len(f.pending)>nativeHookOSCLimit {t.Fatal("unbounded OSC accumulation")}
	if out.Len()<nativeHookOSCLimit {t.Fatal("normal OSC was swallowed")}
}
