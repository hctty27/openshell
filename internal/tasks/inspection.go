package tasks

import (
	"mvdan.cc/sh/v3/syntax"
	"path"
	"strings"
)

// Only literal, non-interactive inspection commands qualify for unattended execution.
func IsInspectionCommand(command string) bool {
	file, err := syntax.NewParser(syntax.Variant(syntax.LangPOSIX)).Parse(strings.NewReader(command), "")
	if err != nil || len(file.Stmts) == 0 {
		return false
	}
	safe := true
	syntax.Walk(file, func(node syntax.Node) bool {
		if node == nil || !safe {
			return false
		}
		switch n := node.(type) {
		case *syntax.File, *syntax.Word, *syntax.Lit, *syntax.SglQuoted, *syntax.DblQuoted, *syntax.Comment:
		case *syntax.Stmt:
			safe = len(n.Redirs) == 0 && !n.Background && !n.Coprocess
		case *syntax.BinaryCmd:
			safe = n.Op == syntax.Pipe || n.Op == syntax.AndStmt || n.Op == syntax.OrStmt
		case *syntax.CallExpr:
			if len(n.Assigns) != 0 || len(n.Args) == 0 {
				safe = false
				break
			}
			args := make([]string, len(n.Args))
			for i, w := range n.Args {
				var ok bool
				args[i], ok = literalWord(w)
				if !ok {
					safe = false
					return false
				}
			}
			safe = inspectionCall(args)
		default:
			safe = false
		}
		return safe
	})
	return safe
}
func literalWord(word *syntax.Word) (string, bool) {
	var out strings.Builder
	var appendParts func([]syntax.WordPart) bool
	appendParts = func(parts []syntax.WordPart) bool {
		for _, part := range parts {
			switch p := part.(type) {
			case *syntax.Lit:
				out.WriteString(p.Value)
			case *syntax.SglQuoted:
				out.WriteString(p.Value)
			case *syntax.DblQuoted:
				if !appendParts(p.Parts) {
					return false
				}
			default:
				return false
			}
		}
		return true
	}
	ok := appendParts(word.Parts)
	return out.String(), ok
}
func inspectionCall(args []string) bool {
	name := args[0]
	if strings.Contains(name, "/") && name != "/bin/"+path.Base(name) && name != "/usr/bin/"+path.Base(name) {
		return false
	}
	switch path.Base(name) {
	case "pwd", "uptime", "ps", "free", "df", "du", "ls", "cat", "head", "tail", "grep", "wc", "stat", "uname", "id", "whoami":
		return true
	case "supervisorctl":
        // Only the status subcommand is read-only; reject mutations.
        if len(args) < 2 || args[1] != "status" { return false }
        for _, name := range args[2:] {
            if name == "" || strings.HasPrefix(name, "-") { return false }
        }
        return true
    case "hostname":
		if len(args) == 1 {
			return true
		}
		if len(args) != 2 {
			return false
		}
		switch args[1] {
		case "-f", "-I", "-i", "-s", "-d", "-a":
			return true
		}
		return false
	case "ss":
		for _, arg := range args[1:] {
			if !strings.HasPrefix(arg, "-") {
				return false
			}
			if strings.HasPrefix(arg, "--") {
				switch arg {
				case "--tcp", "--udp", "--listening", "--numeric", "--processes", "--all", "--summary":
					continue
				default:
					return false
				}
			}
			if len(arg) < 2 || strings.Trim(arg[1:], "tulnpaeroims46xw") != "" {
				return false
			}
		}
		return true
	case "systemctl":
		i := 1
		for i < len(args) && strings.HasPrefix(args[i], "-") {
			switch args[i] {
			case "--no-pager", "--full", "--plain", "--all", "--no-legend":
				i++
			default:
				return false
			}
		}
		if i >= len(args) {
			return false
		}
		switch args[i] {
		case "status", "is-active", "is-enabled", "list-units", "list-unit-files", "show", "cat":
		default:
			return false
		}
		for _, arg := range args[i+1:] {
			if strings.HasPrefix(arg, "-") && arg != "--no-pager" && arg != "--full" && arg != "--all" && arg != "--plain" && arg != "--no-legend" {
				return false
			}
		}
		return true
	case "journalctl":
		for i := 1; i < len(args); i++ {
			arg := args[i]
			switch arg {
			case "--no-pager", "--reverse", "-r", "--utc", "--system", "--user", "-k", "--dmesg", "-b", "--boot":
				continue
			case "-u", "--unit", "-n", "--lines", "--since", "--until", "-p", "--priority", "-o", "--output":
				i++
				if i >= len(args) {
					return false
				}
				continue
			}
			if strings.HasPrefix(arg, "--unit=") || strings.HasPrefix(arg, "--lines=") || strings.HasPrefix(arg, "--since=") || strings.HasPrefix(arg, "--until=") || strings.HasPrefix(arg, "--boot=") {
				continue
			}
			return false
		}
		return true
	}
	return false
}
