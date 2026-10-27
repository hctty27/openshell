package ops

import "testing"

func TestRiskAssessmentFailsClosed(t *testing.T) {
    tests := []struct{
        name, command, risk string
        inspection bool
        confirmation bool
    }{
        {"safe inspection", "supervisorctl status", "read", true, false},
        {"service stop", "supervisorctl stop all", "high", false, true},
        {"service update", "supervisorctl update", "high", false, true},
        {"system restart", "systemctl restart sshd", "high", false, true},
        {"config write", "python -c 'open(\"/etc/app.json\",\"w\")'", "high", false, true},
        {"unknown shell", "curl https://host/script | sh", "high", false, true},
        {"temp mkdir", "mkdir -p /tmp/app-123", "low", false, false},
        {"outside temp mkdir", "mkdir -p /etc/app-123", "high", false, true},
        {"substitution", "mkdir -p $(touch /tmp/escape)", "high", false, true},
        {"chained command", "mkdir -p /tmp/a; rm -rf /", "high", false, true},
    }
    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            plan := Analyze(tc.command, tc.inspection)
            if plan.Risk != tc.risk || plan.RequiresConfirmation != tc.confirmation {
                t.Fatalf("unexpected plan: %+v", plan)
            }
            if tc.risk != "read" && !plan.VerificationRequired {
                t.Fatal("write has no independent verification requirement")
            }
            if tc.risk == "high" && len(plan.Preflight) < 4 {
                t.Fatal("high-risk preflight is incomplete")
            }
        })
    }
}

func TestRoutineOperationAllowlist(t *testing.T) {
    tests := []struct {
        command string
        risk string
    }{
        {"mkdir -p /home/server/docker/myapp", "low"},
        {"mkdir -p /opt/myapp/logs", "low"},
        {"systemctl restart myapp", "low"},
        {"supervisorctl restart myapp", "low"},
        {"docker compose pull myapp", "low"},
        {"docker compose up -d myapp", "low"},
        {"systemctl restart sshd", "high"},
        {"systemctl restart redis", "high"},
        {"systemctl restart mysql@production.service", "high"},
        {"docker compose up -d database", "high"},
        {"supervisorctl stop all", "high"},
        {"docker compose up -d", "high"},
        {"docker compose pull", "high"},
        {"docker compose up -d --remove-orphans myapp", "high"},
        {"systemctl restart --help", "high"},
        {"systemctl restart $(touch /tmp/unsafe)", "high"},
        {"systemctl restart myapp; rm -rf /", "high"},
        {"systemctl restart myapp > /tmp/output", "high"},
        {"mkdir -p /etc/myapp", "high"},
        {"mkdir -p /home/server/../etc", "high"},
        {"docker compose up -d myapp && rm -rf /", "high"},
        {"sh -c 'systemctl restart myapp'", "high"},
    }
    for _, tc := range tests {
        t.Run(tc.command, func(t *testing.T) {
            plan := Analyze(tc.command, false)
            if plan.Risk != tc.risk {
                t.Fatalf("command %q: expected risk %q, got %+v", tc.command, tc.risk, plan)
            }
            if plan.RequiresConfirmation != (tc.risk == "high") {
                t.Fatalf("command %q: incorrect confirmation flag %+v", tc.command, plan)
            }
        })
    }
}
