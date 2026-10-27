package ops

import (
    "path"
    "strings"

    "github.com/hctty27/openshell/internal/domain"
    "mvdan.cc/sh/v3/syntax"
)

// Analyze is a conservative local policy, not proof that a remote change is safe.
func Analyze(command string, readOnly bool) domain.OperationPlan {
    if readOnly {
        return domain.OperationPlan{Risk: "read", RequiresConfirmation: false, Preflight: []string{"target"}}
    }
    risk := "high"
    if isRoutineChange(command) {
        risk = "low"
    }
    preflight := []string{"target", "impact"}
    if risk == "high" {
        preflight = append(preflight, "environment", "backup", "rollback")
    }
    return domain.OperationPlan{Risk: risk, RequiresConfirmation: risk == "high", Preflight: preflight, VerificationRequired: true}
}

// Only a single, literal shell command may qualify. Compound commands, redirects,
// assignments, expansions, wrappers and interpreters fail closed.
func isRoutineChange(command string) bool {
    file, err := syntax.NewParser(syntax.Variant(syntax.LangPOSIX)).Parse(strings.NewReader(command), "")
    if err != nil || len(file.Stmts) != 1 {
        return false
    }
    stmt := file.Stmts[0]
    if stmt.Negated || stmt.Background || stmt.Coprocess || len(stmt.Redirs) != 0 {
        return false
    }
    call, ok := stmt.Cmd.(*syntax.CallExpr)
    if !ok || len(call.Assigns) != 0 || len(call.Args) == 0 {
        return false
    }
    args := make([]string, len(call.Args))
    for i, arg := range call.Args {
        args[i] = word(arg)
        if args[i] == "" {
            return false
        }
    }
    switch args[0] {
    case "mkdir":
        if len(args) < 3 || args[1] != "-p" {
            return false
        }
        for _, p := range args[2:] {
            if path.Clean(p) != p || strings.Contains(p, "..") {
                return false
            }
            allowed := false
            for _, prefix := range []string{"/tmp/", "/var/tmp/", "/home/", "/opt/", "/srv/"} {
                if strings.HasPrefix(p, prefix) {
                    allowed = true
                    break
                }
            }
            if !allowed {
                return false
            }
        }
        return true
    case "systemctl":
        return len(args) == 3 && (args[1] == "start" || args[1] == "restart") && routineService(args[2])
    case "supervisorctl":
        return len(args) == 3 && (args[1] == "start" || args[1] == "restart") && routineService(args[2])
    case "docker":
        if len(args) < 3 || args[1] != "compose" {
            return false
        }
        if args[2] == "pull" && len(args) >= 4 {
            return allServiceNames(args[3:])
        }
        // Updating a named service avoids implicit changes to every service in the stack.
        if args[2] == "up" && len(args) >= 5 && args[3] == "-d" {
            return allServiceNames(args[4:])
        }
    }
    return false
}

func allServiceNames(names []string) bool {
    if len(names) == 0 {
        return false
    }
    for _, name := range names {
        if !routineService(name) {
            return false
        }
    }
    return true
}

func routineService(service string) bool {
    name := strings.TrimSuffix(strings.ToLower(service), ".service")
    switch name {
    case "", "all", "ssh", "sshd", "network", "networking", "networkmanager",
        "firewalld", "ufw", "iptables", "nftables", "docker", "containerd",
        "mysql", "mysqld", "mariadb", "postgresql", "redis", "redis-server", "dbus":
        return false
    }
    if strings.HasPrefix(name, "systemd-") {
        return false
    }
    for _, char := range service {
        if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
            (char >= '0' && char <= '9') || char == '-' || char == '_' ||
            char == '.' || char == '@' {
            continue
        }
        return false
    }
    return true
}

// word accepts one literal shell argument, without expansions or interpolation.
func word(w *syntax.Word) string {
    if w == nil || len(w.Parts) != 1 {
        return ""
    }
    switch p := w.Parts[0].(type) {
    case *syntax.Lit:
        return p.Value
    case *syntax.SglQuoted:
        return p.Value
    }
    return ""
}
