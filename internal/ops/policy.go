package ops

import (
    "strings"
    "github.com/hctty27/openshell/internal/domain"

    "mvdan.cc/sh/v3/syntax"
)

// Plan is a server-authored proposal risk assessment, not a claim that any
// remote preflight or business verification has already succeeded.

// Analyze produces a conservative risk assessment. Only commands independently
// confirmed to be read-only by the caller qualify as inspections.
func Analyze(command string, readOnly bool) domain.OperationPlan {
    if readOnly {
        return domain.OperationPlan{Risk: "read", RequiresConfirmation: false, Preflight: []string{"target"}}
    }
    risk := "high"
    file, err := syntax.NewParser(syntax.Variant(syntax.LangPOSIX)).Parse(strings.NewReader(command), "")
    if err == nil && len(file.Stmts) == 1 {
        stmt := file.Stmts[0]
        if len(stmt.Redirs) == 0 {
            if call, ok := stmt.Cmd.(*syntax.CallExpr); ok && len(call.Assigns) == 0 && len(call.Args) >= 2 {
                // mkdir -p on one or more literal, absolute paths is the only
                // currently auto-approvable filesystem change.
                if word(call.Args[0]) == "mkdir" && word(call.Args[1]) == "-p" {
                    allAbsolute := true
                    for _, w := range call.Args[2:] {
                        p := word(w)
                        if p == "" || !strings.HasPrefix(p, "/") || strings.Contains(p, "..") {
                            allAbsolute = false
                        }
                    }
                    if len(call.Args) > 2 && allAbsolute { risk = "low" }
                }
            }
        }
    }
    preflight := []string{"target", "impact"}
    if risk == "high" {
        preflight = append(preflight, "environment", "backup", "rollback")
    }
    return Plan{Risk: risk, RequiresConfirmation: risk == "high", Preflight: preflight, VerificationRequired: true}
}

// word accepts a literal argument only: no expansion, substitutions or globbing.
func word(w *syntax.Word) string {
    if w == nil || len(w.Parts) != 1 { return "" }
    switch p := w.Parts[0].(type) {
    case *syntax.Lit: return p.Value
    case *syntax.SglQuoted: return p.Value
    }
    return ""
}
