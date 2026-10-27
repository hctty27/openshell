package ops

import (
    "context"
    "errors"
    "sync"
    "testing"
    "time"

    "github.com/hctty27/openshell/internal/domain"
)

func TestPreflightUsesFixedReadOnlyProbesForEachTarget(t *testing.T) {
    targets:=[]domain.ConnectionRef{{TabID:"a",SessionID:"a",Generation:1},{TabID:"b",SessionID:"b",Generation:2}}
    valid:=func(ref domain.ConnectionRef) bool { return ref.TabID=="a" || ref.TabID=="b" }
    var mu sync.Mutex
    commands:=map[string][]string{}
    zero:=0
    run:=func(_ context.Context, ref domain.ConnectionRef, command,cwd string, timeout time.Duration)(domain.CommandResult,error){
        if cwd!="/" || timeout>5*time.Second { t.Errorf("unsafe preflight arguments: %q %v",cwd,timeout) }
        mu.Lock()
        commands[ref.TabID]=append(commands[ref.TabID],command)
        mu.Unlock()
        return domain.CommandResult{Status:"completed",ExitCode:&zero,Stdout:"password=secret-token"},nil
    }
    report:=Inspect(context.Background(),"proposal",targets,valid,run)
    if !report.Ready || len(report.Checks)!=6 { t.Fatalf("bad report: %+v", report) }
    for _,ref:=range targets {
        cmds:=commands[ref.TabID]
        if len(cmds)!=2 || cmds[0]!="hostname" || cmds[1]!="df -Pk /" { t.Errorf("unexpected command set for %s: %v",ref.TabID,cmds) }
    }
    for _,check:=range report.Checks {
        if check.Status!="passed" { t.Errorf("unexpected status %+v",check) }
    }
}

func TestPreflightFailsClosedForLostHostAndDoesNotExecute(t *testing.T) {
    refs:=[]domain.ConnectionRef{{TabID:"a"},{TabID:"b"}}
    calls:=0
    report:=Inspect(context.Background(),"proposal",refs,func(r domain.ConnectionRef) bool { return r.TabID!="b" },
        func(context.Context,domain.ConnectionRef,string,string,time.Duration)(domain.CommandResult,error){
            calls++
            return domain.CommandResult{},nil
        })
    if report.Ready || calls!=0 { t.Fatalf("invalid host was probed: %+v calls=%d",report,calls) }
}

func TestPreflightWarningsDoNotClaimBusinessReadiness(t *testing.T) {
    zero:=0
    report:=Inspect(context.Background(),"proposal",[]domain.ConnectionRef{{TabID:"a"}},func(domain.ConnectionRef)bool{return true},
        func(_ context.Context,_ domain.ConnectionRef,cmd,_ string,_ time.Duration)(domain.CommandResult,error){
            if cmd=="df -Pk /" { return domain.CommandResult{Status:"failed"},errors.New("no df") }
            return domain.CommandResult{Status:"completed",ExitCode:&zero},nil
        })
    if !report.Ready || len(report.Checks)!=3 || report.Checks[2].Status!="warning" {
        t.Fatalf("optional capacity probe should be warning: %+v",report)
    }
}

func TestPreflightRequiredIdentityProbeFails(t *testing.T) {
    report:=Inspect(context.Background(),"proposal",[]domain.ConnectionRef{{TabID:"a"}},func(domain.ConnectionRef)bool{return true},
        func(context.Context,domain.ConnectionRef,string,string,time.Duration)(domain.CommandResult,error){
            return domain.CommandResult{Status:"unknown"},errors.New("SSH unavailable")
        })
    if report.Ready || len(report.Checks)!=2 || report.Checks[1].Status!="failed" {
        t.Fatalf("required identity must fail: %+v",report)
    }
}
