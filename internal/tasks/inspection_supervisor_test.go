package tasks

import (
    "strings"
    "testing"
)

func TestSupervisorctlInspectionIsReadOnly(t *testing.T) {
    allowed := []string{"supervisorctl status", "supervisorctl status all", "supervisorctl status container_11", "supervisorctl status a:b"}
    denied := []string{
        "supervisorctl stop all", "supervisorctl restart container_11",
        "supervisorctl update", "supervisorctl reread",
        "supervisorctl status -c /tmp/custom",
        "supervisorctl status; touch /tmp/changed",
        "supervisorctl status $(touch /tmp/changed)",
    }
    for _, cmd := range allowed {
        if !IsInspectionCommand(cmd) { t.Errorf("read-only Supervisor command rejected: %s", cmd) }
    }
    for _, cmd := range denied {
        if IsInspectionCommand(cmd) { t.Errorf("unsafe Supervisor command allowed: %s", cmd) }
    }
}

func TestParallelSupervisorToolGivesSpecificErrors(t *testing.T) {
    good := `{"command":"supervisorctl status","purpose":"compare services","cwd":"/"}`
    input, err := ParseTool("propose_parallel_inspection", good)
    if err != nil || !input.Parallel { t.Fatalf("parallel status rejected: %+v %v", input, err) }
    _, err = ParseTool("propose_parallel_inspection", `{"command":"supervisorctl stop all","purpose":"stop","cwd":"/"}`)
    if err == nil || !strings.Contains(err.Error(), "inspectionCommandNotAllowed") {
        t.Fatalf("unsafe command returned wrong error: %v", err)
    }
    _, err = ParseTool("propose_parallel_inspection", `{"target_id":"tab","command":"supervisorctl status","purpose":"compare","cwd":"/"}`)
    if err == nil || !strings.Contains(err.Error(), "parallelInspectionDoesNotAcceptTargetId") {
        t.Fatalf("bad target_id returned wrong error: %v", err)
    }
}

func TestNoCredentialsInAgentCommand(t *testing.T) {
    for _, cmd := range []string{
        "mysql -uhtdba -psecret", "mysql --password=secret",
        "MYSQL_PWD=secret mysql -h 127.0.0.1", "echo pass=secret", "curl mysql://u:password@host/database",
    } {
        if err := validate(cmd, "inspect", "/"); err == nil {
            t.Fatalf("accepted inline credential: %s", cmd)
        }
    }
}
