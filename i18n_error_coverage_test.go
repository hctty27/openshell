package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func loadErrorTranslations(t *testing.T, language string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("frontend", "src", "locales", language, "errors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var messages map[string]string
	if err := json.Unmarshal(data, &messages); err != nil {
		t.Fatal(err)
	}
	return messages
}

func TestAppErrorCodesHaveBilingualTranslations(t *testing.T) {
	english := loadErrorTranslations(t, "en")
	chinese := loadErrorTranslations(t, "zh-CN")
	if len(english) != len(chinese) {
		t.Fatalf("error catalog counts differ: en=%d zh-CN=%d", len(english), len(chinese))
	}
	for key := range english {
		if _, ok := chinese[key]; !ok {
			t.Errorf("missing Chinese translation: %s", key)
		}
	}
	placeholders := regexp.MustCompile(`{{\s*[A-Za-z][A-Za-z0-9_]*\s*}}`)
	for key, en := range english {
		zh := chinese[key]
		a := placeholders.FindAllString(en, -1)
		b := placeholders.FindAllString(zh, -1)
		sort.Strings(a)
		sort.Strings(b)
		if strings.Join(a, ",") != strings.Join(b, ",") {
			t.Errorf("interpolation mismatch for %s: en=%v zh-CN=%v", key, a, b)
		}
	}
	err := filepath.WalkDir(".", func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if path != "." && (strings.HasPrefix(d.Name(), ".") || d.Name() == "frontend" || d.Name() == "build") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (sel.Sel.Name != "New" && sel.Sel.Name != "Wrap") {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "apperror" {
				return true
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			code, unquoteErr := strconv.Unquote(literal.Value)
			if unquoteErr != nil {
				t.Errorf("%s: invalid error code: %v", path, unquoteErr)
				return true
			}
			if _, ok := english[code]; !ok {
				t.Errorf("%s: missing English error translation: %s", path, code)
			}
			if _, ok := chinese[code]; !ok {
				t.Errorf("%s: missing Chinese error translation: %s", path, code)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestUserFacingFileOperationsUseStructuredErrors(t *testing.T) {
	paths := []string{
		"sftp_ai.go", "xshell_import.go", "session_backup.go",
		"internal/sftp/files.go", "internal/sftp/transfer.go",
		"internal/sftp/advanced.go", "internal/sftp/ai.go",
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "errors.New(") {
			t.Errorf("%s: user-facing errors must use structured codes", path)
		}
	}
}
