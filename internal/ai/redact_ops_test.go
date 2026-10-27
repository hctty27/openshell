package ai

import (
    "encoding/json"
    "strings"
    "testing"

    "github.com/hctty27/openshell/internal/domain"
)

func TestRedactDatabaseLogCredentials(t *testing.T) {
    input := "MysqlConfigInfo{name=data, host=10.0.1.7, pass='db-secret', password=another-secret, pwd=third-secret, token=token123} mysql://admin:url-secret@localhost/data"
    redacted := Redact(input)
    for _, value := range []string{"db-secret", "another-secret", "third-secret", "token123", "url-secret"} {
        if strings.Contains(redacted, value) { t.Fatalf("leaked %s: %s", value, redacted) }
    }
    if !strings.Contains(redacted, "host=10.0.1.7") {
        t.Fatal("over-redacted harmless connection metadata")
    }
}

func TestSanitizeNestedCommandResultAndStoredDisplay(t *testing.T) {
    original := domain.CommandResult{
        Status: "completed", Stdout: "pass=db-secret", Stderr: "password=another-secret",
        TargetResults: []domain.TargetCommandResult{{
            Ref: domain.ConnectionRef{TabID:"second"},
            Result: domain.CommandResult{Status:"completed", Stdout:"token=token123"},
        }},
    }
    clean := SanitizeResult(original)
    data, _ := json.Marshal(map[string]any{"command": "cat /etc/app.conf", "result": clean,
        "settings": map[string]any{"pass":"hidden-json-secret"}})
    message, err := SanitizeMessage(domain.ConversationMessage{Role:"tool", DisplayJSON:data, Content:BuildToolResult("pwd","/",original)})
    if err != nil || !json.Valid(message.DisplayJSON) || !json.Valid([]byte(message.Content)) {
        t.Fatalf("invalid serialized tool history: %v", err)
    }
    for _, output := range []string{clean.Stdout, clean.Stderr, clean.TargetResults[0].Result.Stdout, string(message.DisplayJSON), message.Content} {
        for _, secret := range []string{"db-secret","another-secret","token123","hidden-json-secret"} {
            if strings.Contains(output, secret) { t.Fatalf("secret in stored or displayed result: %s", output) }
        }
    }
}

func TestChinesePasswordAndMySQLPasswordAreRedacted(t *testing.T) {
    output := Redact("密码=zh-secret MYSQL_PWD=mysql-secret")
    if strings.Contains(output, "zh-secret") || strings.Contains(output, "mysql-secret") {
        t.Fatal("non-English or prefixed credential escaped redaction")
    }
}
