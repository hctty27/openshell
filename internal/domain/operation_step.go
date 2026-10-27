package domain

// OperationStep is an append-only command identity with mutable execution
// outcome. The journal stores redacted metadata, never raw remote output.
type OperationStep struct {
    ID                 string          `json:"id"`
    ConversationID     string          `json:"conversationId"`
    RunID              string          `json:"runId"`
    Sequence           int64           `json:"sequence"`
    Command            string          `json:"command"`
    Purpose            string          `json:"purpose"`
    Targets            []ConnectionRef `json:"targets"`
    Risk               string          `json:"risk"`
    Preflight          []string        `json:"preflight,omitempty"`
    Status             string          `json:"status"`
    VerificationStatus string          `json:"verificationStatus,omitempty"`
    ExitCode           *int            `json:"exitCode,omitempty"`
    Reason             string          `json:"reason,omitempty"`
    CreatedAt          string          `json:"createdAt"`
    UpdatedAt          string          `json:"updatedAt"`
}
