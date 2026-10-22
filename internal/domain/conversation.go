package domain

import "encoding/json"

type Conversation struct {
	ID                string `json:"id"`
	ServerKey         string `json:"serverKey"`
	SessionID         string `json:"sessionId"`
	Title             string `json:"title"`
	TitleManual       bool   `json:"titleManual"`
	Summary           string `json:"summary"`
	SummaryThroughSeq int64  `json:"summaryThroughSeq"`
	Revision          int64  `json:"revision"`
	CreatedAt         string `json:"createdAt"`
	UpdatedAt         string `json:"updatedAt"`
}
type ConversationMessage struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversationId"`
	Seq            int64           `json:"seq"`
	Role           string          `json:"role"`
	Content        string          `json:"content"`
	ToolCallsJSON  json.RawMessage `json:"toolCalls,omitempty"`
	ToolCallID     string          `json:"toolCallId,omitempty"`
	DisplayJSON    json.RawMessage `json:"display,omitempty"`
	Status         string          `json:"status"`
	CreatedAt      string          `json:"createdAt"`
}
type ConversationCursor struct {
	UpdatedAt string `json:"updatedAt"`
	ID        string `json:"id"`
}
type ConversationList struct {
	Items      []Conversation      `json:"items"`
	NextCursor *ConversationCursor `json:"nextCursor"`
}
type ConversationPage struct {
	Conversation Conversation          `json:"conversation"`
	Messages     []ConversationMessage `json:"messages"`
	BeforeSeq    int64                 `json:"beforeSeq"`
	HasMore      bool                  `json:"hasMore"`
	Run          *ConversationRun      `json:"run"`
	EventSeq     uint64                `json:"eventSeq"`
}
type ConversationRun struct {
	ID             string        `json:"id"`
	ConversationID string        `json:"conversationId"`
	Kind           string        `json:"kind"`
	Status         string        `json:"status"`
	OwnerRef       ConnectionRef `json:"ownerRef"`
}
type ConversationEvent struct {
	SelectionRevision uint64                   `json:"selectionRevision,omitempty"`
	SelectedRefs      map[string]ConnectionRef `json:"selectedRefs,omitempty"`
	EventID           string                   `json:"eventId"`
	ServerKey         string                   `json:"serverKey"`
	ConversationID    string                   `json:"conversationId"`
	Kind              string                   `json:"kind"`
	Revision          int64                    `json:"revision"`
	EventSeq          uint64                   `json:"eventSeq"`
	Run               *ConversationRun         `json:"run"`
	Message           *ConversationMessage     `json:"message,omitempty"`
	Delta             string                   `json:"delta,omitempty"`
	SelectedByTab     map[string]string        `json:"selectedByTab,omitempty"`
	Conversation      *Conversation            `json:"conversation,omitempty"`
	Status            string                   `json:"status,omitempty"`
}
type ConversationMutation struct {
	Kind              string
	Message           *ConversationMessage
	Summary           string
	SummaryThroughSeq int64
}
