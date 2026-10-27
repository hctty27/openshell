package ops

import (
    "context"
    "sync"
    "time"

    "github.com/hctty27/openshell/internal/domain"
)

// PreflightReport describes fixed, read-only probes. It is not proof that a
// backup, a rollback path, or the application business health is valid.
type PreflightReport struct {
    ProposalID string          `json:"proposalId"`
    CheckedAt  string          `json:"checkedAt"`
    Ready      bool            `json:"ready"`
    Checks     []PreflightCheck `json:"checks"`
}

type PreflightCheck struct {
    Ref      domain.ConnectionRef `json:"ref"`
    Key      string               `json:"key"`
    Status   string               `json:"status"`
}

// ProbeRun receives only a trusted command constant and absolute cwd.
type ProbeRun func(context.Context, domain.ConnectionRef, string, string, time.Duration) (domain.CommandResult, error)

// Inspect performs bounded read-only discovery without storing raw outputs.
// A failed required probe makes Ready false. Optional capacity discovery only
// warns; it cannot infer workload-specific memory or disk requirements.
func Inspect(ctx context.Context, proposalID string, refs []domain.ConnectionRef, valid func(domain.ConnectionRef) bool, run ProbeRun) PreflightReport {
    report := PreflightReport{ProposalID:proposalID, CheckedAt:time.Now().UTC().Format(time.RFC3339), Ready:true}
    if proposalID == "" || len(refs)==0 || len(refs)>8 || valid==nil || run==nil {
        report.Ready=false
        return report
    }
    seen := map[string]bool{}
    for _, ref := range refs {
        if ref.TabID=="" || seen[ref.TabID] || !valid(ref) {
            report.Ready=false
            report.Checks=append(report.Checks, PreflightCheck{Ref:ref, Key:"connection", Status:"failed"})
            return report
        }
        seen[ref.TabID]=true
    }
    results := make([][]PreflightCheck, len(refs))
    var wg sync.WaitGroup
    for i, ref := range refs {
        wg.Add(1)
        go func(index int, target domain.ConnectionRef) {
            defer wg.Done()
            checks:=[]PreflightCheck{{Ref:target, Key:"connection", Status:"passed"}}
            for _, probe := range []struct{ key, command string; required bool }{
                {"identity", "hostname", true},
                {"capacity", "df -Pk /", false},
            } {
                status:="passed"
                probeCtx, cancel:=context.WithTimeout(ctx, 6*time.Second)
                // Never execute AI-supplied shell text here.
                output, err:=run(probeCtx, target, probe.command, "/", 5*time.Second)
                cancel()
                if err!=nil || output.Status!="completed" || output.ExitCode==nil || *output.ExitCode!=0 || output.Truncated || !valid(target) {
                    status="warning"
                    if probe.required { status="failed" }
                }
                checks=append(checks, PreflightCheck{Ref:target, Key:probe.key, Status:status})
                if status=="failed" { break }
            }
            results[index]=checks
        }(i,ref)
    }
    wg.Wait()
    for _, checks := range results {
        for _, check := range checks {
            report.Checks=append(report.Checks, check)
            if check.Status=="failed" { report.Ready=false }
        }
    }
    if ctx.Err()!=nil { report.Ready=false }
    for _, ref := range refs { if !valid(ref) { report.Ready=false } }
    return report
}
