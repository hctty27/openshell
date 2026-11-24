package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
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
	c:=&nativeTerminalCoordinator{input:input,output:output,runner:func(_ context.Context,_ string,_ string,in io.ReadCloser,_ io.Writer)error{
		if _,err:=io.ReadFull(in,make([]byte,len(header)));err!=nil{return err}
		return failure
	}}
	restored,err:=c.runPassiveVerified(context.Background(),"download",t.TempDir(),guard,testNativePassiveSessionToken)
	if !restored||!errors.Is(err,failure){t.Fatalf("restored=%v err=%v",restored,err)}
	if _,err:=input.Write([]byte("pwd\r"));err!=nil{t.Fatal(err)}
}
