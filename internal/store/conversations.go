package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	"strings"
	"time"
)

var ErrConversationConflict = errors.New("conversation changed; reload and retry")

const conversationColumns = "id,server_key,session_id,title,title_manual,summary,summary_through_seq,revision,created_at,updated_at"

type scanner interface{ Scan(...any) error }

func scanConversation(row scanner) (c domain.Conversation, err error) {
	err = row.Scan(&c.ID, &c.ServerKey, &c.SessionID, &c.Title, &c.TitleManual, &c.Summary, &c.SummaryThroughSeq, &c.Revision, &c.CreatedAt, &c.UpdatedAt)
	return
}
func (s *Store) migrateConversations() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err = tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version < 2 {
		_, err = tx.Exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,server_key TEXT NOT NULL,session_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',title_manual INTEGER NOT NULL DEFAULT 0,summary TEXT NOT NULL DEFAULT '',summary_through_seq INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS conversations_server ON conversations(server_key,updated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS conversation_messages(conversation_id TEXT NOT NULL,seq INTEGER NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(conversation_id,seq),UNIQUE(conversation_id,id));
CREATE TABLE IF NOT EXISTS conversation_selections(server_key TEXT PRIMARY KEY,last_conversation_id TEXT NOT NULL);
PRAGMA user_version=2;`)
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(`CREATE TABLE IF NOT EXISTS operation_steps(
  conversation_id TEXT NOT NULL, step_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(conversation_id, step_id), UNIQUE(conversation_id, seq));
CREATE INDEX IF NOT EXISTS operation_steps_conversation ON operation_steps(conversation_id, seq DESC);
-- Never assume a command that was running before a process crash completed.
UPDATE operation_steps SET data=json_set(data, '$.status',
  CASE WHEN json_extract(data,'$.status')='running' THEN 'unknown' ELSE 'expired' END,
  '$.reason', CASE WHEN json_extract(data,'$.status')='running' THEN 'interrupted_on_restart' ELSE 'proposal_expired_on_restart' END,
  '$.verificationStatus', CASE WHEN json_extract(data,'$.status')='running' THEN 'pending' ELSE '' END)
WHERE json_extract(data,'$.status') IN ('awaiting_confirmation','running');`)
    if err != nil { return err }
    return tx.Commit()
}
func (s *Store) CreateConversation(ctx context.Context, key, sessionID string) (domain.Conversation, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	c := domain.Conversation{ID: domain.NewID(), ServerKey: key, SessionID: sessionID, CreatedAt: now, UpdatedAt: now}
	_, err := s.db.ExecContext(ctx, "INSERT INTO conversations(id,server_key,session_id,created_at,updated_at) VALUES(?,?,?,?,?)", c.ID, key, sessionID, now, now)
	return c, err
}
func (s *Store) GetConversation(ctx context.Context, id string) (domain.Conversation, error) {
	return scanConversation(s.db.QueryRowContext(ctx, "SELECT "+conversationColumns+" FROM conversations WHERE id=?", id))
}
func (s *Store) ListConversations(ctx context.Context, key string, cursor *domain.ConversationCursor, limit int) (domain.ConversationList, error) {
	if limit < 1 || limit > 50 {
		limit = 50
	}
	query := "SELECT " + conversationColumns + " FROM conversations WHERE server_key=?"
	args := []any{key}
	if cursor != nil {
		query += " AND (updated_at<? OR (updated_at=? AND id<?))"
		args = append(args, cursor.UpdatedAt, cursor.UpdatedAt, cursor.ID)
	}
	query += " ORDER BY updated_at DESC,id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return domain.ConversationList{}, err
	}
	defer rows.Close()
	result := domain.ConversationList{Items: []domain.Conversation{}}
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, c)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		last := result.Items[limit-1]
		result.NextCursor = &domain.ConversationCursor{UpdatedAt: last.UpdatedAt, ID: last.ID}
	}
	return result, nil
}
func (s *Store) ReadConversation(ctx context.Context, id string, before int64, limit int) (domain.ConversationPage, error) {
	c, err := s.GetConversation(ctx, id)
	if err != nil {
		return domain.ConversationPage{}, err
	}
	if limit < 1 || limit > 100 {
		limit = 100
	}
	query := "SELECT data FROM conversation_messages WHERE conversation_id=?"
	args := []any{id}
	if before > 0 {
		query += " AND seq<?"
		args = append(args, before)
	}
	query += " ORDER BY seq DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return domain.ConversationPage{}, err
	}
	defer rows.Close()
	result := domain.ConversationPage{Conversation: c, Messages: []domain.ConversationMessage{}}
	for rows.Next() {
		var data []byte
		var m domain.ConversationMessage
		if err = rows.Scan(&data); err != nil {
			return result, err
		}
		if err = json.Unmarshal(data, &m); err != nil {
			return result, err
		}
		result.Messages = append(result.Messages, m)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if len(result.Messages) > limit {
		result.HasMore = true
		result.Messages = result.Messages[:limit]
	}
	for i, j := 0, len(result.Messages)-1; i < j; i, j = i+1, j-1 {
		result.Messages[i], result.Messages[j] = result.Messages[j], result.Messages[i]
	}
	if len(result.Messages) > 0 {
		result.BeforeSeq = result.Messages[0].Seq
	}
	return result, nil
}
func (s *Store) LastConversation(ctx context.Context, key string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, "SELECT last_conversation_id FROM conversation_selections WHERE server_key=?", key).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}
func (s *Store) SelectConversation(ctx context.Context, key, id string) error {
	c, err := s.GetConversation(ctx, id)
	if err != nil {
		return err
	}
	if c.ServerKey != key {
		return apperror.New("memoryWrongServer",nil)
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO conversation_selections VALUES(?,?) ON CONFLICT(server_key) DO UPDATE SET last_conversation_id=excluded.last_conversation_id", key, id)
	return err
}
func shortTitle(title string) string {
	title = strings.TrimSpace(strings.SplitN(title, "\n", 2)[0])
	r := []rune(title)
	if len(r) > 40 {
		r = r[:40]
	}
	return string(r)
}
func (s *Store) RenameConversation(ctx context.Context, id, title string) (domain.Conversation, error) {
	title = shortTitle(title)
	result, err := s.db.ExecContext(ctx, "UPDATE conversations SET title=?,title_manual=?,revision=revision+1 WHERE id=?", title, title != "", id)
	if err != nil {
		return domain.Conversation{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return domain.Conversation{}, sql.ErrNoRows
	}
	return s.GetConversation(ctx, id)
}
func (s *Store) MutateConversation(ctx context.Context, id string, expected int64, change domain.ConversationMutation) (domain.Conversation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Conversation{}, err
	}
	defer tx.Rollback()
	c, err := scanConversation(tx.QueryRowContext(ctx, "SELECT "+conversationColumns+" FROM conversations WHERE id=?", id))
	if err != nil {
		return c, err
	}
	if c.Revision != expected {
		return c, ErrConversationConflict
	}
	switch change.Kind {
	case "append":
		if change.Message == nil || change.Message.ID == "" {
			return c, apperror.New("memoryMessageIdRequired",nil)
		}
		m := *change.Message
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM conversation_messages WHERE conversation_id=? AND id=?", id, m.ID).Scan(&exists); err != nil {
			return c, err
		}
		if exists > 0 {
			return c, nil
		}
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0)+1 FROM conversation_messages WHERE conversation_id=?", id).Scan(&m.Seq); err != nil {
			return c, err
		}
		m.ConversationID = id
		m.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if m.Status == "" {
			m.Status = "completed"
		}
		data, e := json.Marshal(m)
		if e != nil {
			return c, e
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO conversation_messages VALUES(?,?,?,?)", id, m.Seq, m.ID, string(data)); err != nil {
			return c, err
		}
		if c.Title == "" && !c.TitleManual && m.Role == "user" {
			c.Title = shortTitle(m.Content)
		}
	case "clear":
        if _, err = tx.ExecContext(ctx, "DELETE FROM operation_steps WHERE conversation_id=?", id); err != nil { return c, err }
		if _, err = tx.ExecContext(ctx, "DELETE FROM conversation_messages WHERE conversation_id=?", id); err != nil {
			return c, err
		}
		c.Summary = ""
		c.SummaryThroughSeq = 0
		if !c.TitleManual {
			c.Title = ""
		}
	case "summary":
		c.Summary = change.Summary
		c.SummaryThroughSeq = change.SummaryThroughSeq
	default:
		return c, apperror.New("memoryUnsupportedMutation",nil)
	}
	c.Revision++
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_, err = tx.ExecContext(ctx, "UPDATE conversations SET title=?,summary=?,summary_through_seq=?,revision=?,updated_at=? WHERE id=?", c.Title, c.Summary, c.SummaryThroughSeq, c.Revision, c.UpdatedAt, id)
	if err != nil {
		return c, err
	}
	return c, tx.Commit()
}
func deleteConversationTx(ctx context.Context, tx *sql.Tx, id string) error {
	for _, query := range []string{"DELETE FROM operation_steps WHERE conversation_id=?", "DELETE FROM conversation_messages WHERE conversation_id=?", "DELETE FROM conversation_selections WHERE last_conversation_id=?", "DELETE FROM conversations WHERE id=?"} {
		if _, err := tx.ExecContext(ctx, query, id); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) DeleteConversation(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = deleteConversationTx(ctx, tx, id); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteAndSelectConversation(ctx context.Context, id string) (domain.Conversation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Conversation{}, err
	}
	defer tx.Rollback()
	old, err := scanConversation(tx.QueryRowContext(ctx, "SELECT "+conversationColumns+" FROM conversations WHERE id=?", id))
	if err != nil {
		return old, err
	}
	next, err := scanConversation(tx.QueryRowContext(ctx, "SELECT "+conversationColumns+" FROM conversations WHERE server_key=? AND id<>? ORDER BY updated_at DESC,id DESC LIMIT 1", old.ServerKey, id))
	if errors.Is(err, sql.ErrNoRows) {
		next = domain.Conversation{}
	} else if err != nil {
		return next, err
	}
	if err = deleteConversationTx(ctx, tx, id); err != nil {
		return next, err
	}
	if next.ID != "" {
		_, err = tx.ExecContext(ctx, "INSERT INTO conversation_selections VALUES(?,?) ON CONFLICT(server_key) DO UPDATE SET last_conversation_id=excluded.last_conversation_id", old.ServerKey, next.ID)
		if err != nil {
			return next, err
		}
	}
	return next, tx.Commit()
}
