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
