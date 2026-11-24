package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A previously captured completion is sufficient: do not send protocol
// cancellation bytes into an already-returned interactive Bash shell.
func TestNativeZmodemPassiveCancelPickerAlreadyExited(t *testing.T) {
	var visible, remote bytes.Buffer
	input := newTerminalInputGate(&remote, &remote)
	guard := newNativeOnlyOutputGuardPassive(&visible, nil, input.blockPassiveInput, func(byte){})
	output := newTerminalOutputGate(guard)
	marker := []byte("\x1b]777;OpenShellNativeZmodem;"+testNativePassiveSessionToken+";128\x07shell$ ")
	if _, err := output.Write(append(nativeZmodemHeaderFixture(0), marker...)); err != nil { t.Fatal(err) }
	c := &nativeTerminalCoordinator{input: input, output: output}
	if !c.cancelPassivePicker(context.Background(), guard, testNativePassiveSessionToken) { t.Fatal("captured exit did not restore") }
	if remote.Len() != 0 || visible.String() != "shell$ " { t.Fatalf("unexpected input=%q output=%q", remote.String(), visible.String()) }
	if _, err := input.Write([]byte("pwd\r")); err != nil { t.Fatal(err) }
}

type passiveCancelWriter func([]byte) (int,error)
func (f passiveCancelWriter) Write(p []byte) (int,error) { return f(p) }

func TestNativeZmodemPassiveCancelPickerWaitsForVerifiedExit(t *testing.T) {
	for _, valid := range []bool{true,false} {
		t.Run(map[bool]string{true:"verified",false:"wrong-token"}[valid],func(t *testing.T){
			var visible bytes.Buffer
			var output *terminalOutputGate
			remote := passiveCancelWriter(func(p []byte)(int,error){
				if !bytes.Equal(p,zmodemCancelSequence){ t.Errorf("not a native cancel: %x",p) }
				token := testNativePassiveSessionToken
				if !valid { token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
				_,err:=output.Write([]byte("\x1b]777;OpenShellNativeZmodem;"+token+";128\x07shell$ "))
				return len(p),err
			})
			input:=newTerminalInputGate(io.Discard,remote)
			guard:=newNativeOnlyOutputGuardPassive(&visible,nil,input.blockPassiveInput,func(byte){})
			output=newTerminalOutputGate(guard)
			if _,err:=output.Write(nativeZmodemHeaderFixture(1));err!=nil{t.Fatal(err)}
			ctx,cancel:=context.WithTimeout(context.Background(),150*time.Millisecond)
			defer cancel()
			c:=&nativeTerminalCoordinator{input:input,output:output}
			if restored:=c.cancelPassivePicker(ctx,guard,testNativePassiveSessionToken);restored!=valid{t.Fatalf("restored=%v want=%v",restored,valid)}
			_,err:=input.Write([]byte("pwd\r"))
			if valid && (err!=nil || visible.String()!="shell$ "){t.Fatalf("verified exit did not restore: %v %q",err,visible.String())}
			if !valid && (!errors.Is(err,errNativeTerminalInputBusy)||visible.Len()!=0){t.Fatalf("unverified exit escaped isolation: %v %q",err,visible.String())}
		})
	}
}

func TestNativeZmodemPassiveSidecarFailureRecoversWithoutPublishingPartial(t *testing.T) {
	var visible bytes.Buffer
	var output *terminalOutputGate
	remote:=passiveCancelWriter(func(p []byte)(int,error){
		if !bytes.Equal(p,zmodemCancelSequence){t.Errorf("unexpected response %x",p)}
		_,err:=output.Write([]byte("\x1b]777;OpenShellNativeZmodem;"+testNativePassiveSessionToken+";128\x07shell$ "))
		return len(p),err
	})
	input:=newTerminalInputGate(io.Discard,remote)
	guard:=newNativeOnlyOutputGuardPassive(&visible,nil,input.blockPassiveInput,func(byte){})
	output=newTerminalOutputGate(guard)
	header:=nativeZmodemHeaderFixture(0)
	if _,err:=output.Write(header);err!=nil{t.Fatal(err)}
	failure:=errors.New("remote sz did not provide a file")
	c:=&nativeTerminalCoordinator{input:input,output:output,runner:func(_ context.Context,_ string,dir string,in io.ReadCloser,_ io.Writer)error{
		if _,err:=io.ReadFull(in,make([]byte,len(header)));err!=nil{return err}
		if err:=os.WriteFile(filepath.Join(dir,"partial.bin"),[]byte("incomplete"),0600);err!=nil{return err}
		return failure
	}}
	target:=t.TempDir()
	restored,err:=c.runPassiveVerified(context.Background(),"download",target,guard,testNativePassiveSessionToken)
	if !restored||!errors.Is(err,failure){t.Fatalf("restored=%v err=%v",restored,err)}
	if entries,err:=os.ReadDir(target);err!=nil||len(entries)!=0{t.Fatalf("failed download published or left staging: %v %v",entries,err)}
	if _,err:=input.Write([]byte("pwd\r"));err!=nil{t.Fatal(err)}
}

// A picker cancellation may only recover the exact current connection and
// selection generation. Late callbacks must not affect a subsequent picker.
func TestNativeZmodemPassiveCancelPickerManagerGeneration(t *testing.T) {
	m,ref,remote,intents:=nativeAutoTestManager(t,true,true)
	conn:=m.connections[ref.TabID]
	conn.passiveBashHookToken=testNativePassiveSessionToken
	var visible bytes.Buffer
	guard:=newNativeOnlyOutputGuardPassive(&visible,nil,conn.inputGate.blockPassiveInput,func(frame byte){go m.handleNativePassiveFrame(ref,conn,frame)})
	conn.outputGuard=guard
	conn.outputGate=newTerminalOutputGate(guard)
	marker:=[]byte("\x1b]777;OpenShellNativeZmodem;"+testNativePassiveSessionToken+";128\x07shell$ ")
	if _,err:=conn.outputGate.Write(append(nativeZmodemHeaderFixture(1),marker...));err!=nil{t.Fatal(err)}
	var id uint64
	select{
	case event:=<-intents:
		id=event["selectionId"].(uint64)
	case <-time.After(2*time.Second):t.Fatal("picker missing")
	}
	stale:=ref
	stale.Generation++
	if m.ReleaseNativeZmodemSelection(stale,id)||m.ReleaseNativeZmodemSelection(ref,id+1){t.Fatal("stale cancellation accepted")}
	if _,err:=conn.inputGate.Write([]byte("pwd\r"));!errors.Is(err,errNativeTerminalInputBusy){t.Fatalf("stale cancellation unlocked input: %v",err)}
	if !m.ReleaseNativeZmodemSelection(ref,id){t.Fatal("current picker not released")}
	m.mu.Lock()
	unsafe:=conn.nativeTerminalPoisoned||conn.nativeTerminalTransfer!=nil||conn.nativeZmodemSelection
	m.mu.Unlock()
	if unsafe||remote.Len()!=0{t.Fatalf("verified picker remained unsafe or wrote cancel after exit: %v %q",unsafe,remote.String())}
	if _,err:=conn.inputGate.Write([]byte("pwd\r"));err!=nil{t.Fatal(err)}
	if _,err:=conn.outputGate.Write(nativeZmodemHeaderFixture(1));err!=nil{t.Fatal(err)}
	select{
	case event:=<-intents:
		if event["selectionId"].(uint64)<=id{t.Fatalf("new picker has stale id: %v",event)}
	case <-time.After(2*time.Second):t.Fatal("second picker missing")
	}
	if m.ReleaseNativeZmodemSelection(ref,id){t.Fatal("old cancellation affected second picker")}
	if _,err:=conn.inputGate.Write([]byte("pwd\r"));!errors.Is(err,errNativeTerminalInputBusy){t.Fatalf("second picker input escaped: %v",err)}
}
