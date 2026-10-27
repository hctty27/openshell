package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/hctty27/openshell/internal/ai"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/branding"
	"github.com/hctty27/openshell/internal/conversation"
	"github.com/hctty27/openshell/internal/domain"
	sshclient "github.com/hctty27/openshell/internal/ssh"
	"github.com/hctty27/openshell/internal/store"
	files "github.com/hctty27/openshell/internal/sftp"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/hctty27/openshell/internal/tasks"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type App struct {
	closeGuardReady bool
	quitApproved bool
	connectEpoch map[string]uint64
	ctx          context.Context
	store        *store.Store
	secrets      domain.SecretStore
	ssh          *sshclient.Manager
	sftp         *files.Manager
	coordinator  *tasks.Coordinator
	automatic    *tasks.AutomaticRunner
	provider     *ai.Provider
	memory       *conversation.Service
	executionMu  sync.Mutex
	closing      map[string]domain.ConnectionRef
	proposalRuns map[string]string
	executions   map[string]*conversationExecution
	emit         sshclient.EmitFunc
	pickKey      func() (string, error)
	pickImport func() (string, error)
	pickBackupRead func() (string, error)
	pickBackupWrite func() (string, error)
	xshellPreview *XshellImportPreview
	mu           sync.Mutex
	transient    map[string]string
	challenges   map[string]*sshclient.HostKeyError
	chatCancels  map[string]context.CancelFunc
	pending      map[string]string
	tabRefs      map[string]domain.ConnectionRef
	localTerminals map[string]*localTerminalSession
	localTerminalPending map[string]string
	localTerminalFactory func(string, int, int) (localPTY, error)
}
type QuickCommand struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Command  string `json:"command"`
	Category string `json:"category"`
	Scope    string `json:"scope"`
	ScopeID  string `json:"scopeId"`
	Mode     string `json:"mode,omitempty"`
	Confirm  bool   `json:"confirm"`
}

type AppState struct {
	SaveChatHistory       bool                `json:"saveChatHistory"`
	AutoSummarize         bool                `json:"autoSummarize"`
	Language              string              `json:"language"`
	Sessions              []domain.Session    `json:"sessions"`
	Groups                []domain.Group      `json:"groups"`
	Profiles              []domain.APIProfile `json:"profiles"`
	QuickCommands         []QuickCommand      `json:"quickCommands"`
	QuickCommandLayout    string              `json:"quickCommandLayout"`
	AutoCopySelection     bool                `json:"autoCopySelection"`
	RightClickPaste       bool                `json:"rightClickPaste"`
	ConfirmMultilinePaste bool                `json:"confirmMultilinePaste"`
	MiddleClickPaste       bool                `json:"middleClickPaste"`
	LogHighlights          bool                `json:"logHighlights"`
	KeepAliveSeconds       int                 `json:"keepAliveSeconds"`
	AutoReconnect          bool                `json:"autoReconnect"`
	MaxReconnectAttempts   int                 `json:"maxReconnectAttempts"`
	ShowDisconnectReason   bool                `json:"showDisconnectReason"`
	DisconnectBehavior string `json:"disconnectBehavior"`
	LocalShell string `json:"localShell"`
	PreserveTerminalHistory bool `json:"preserveTerminalHistory"`
	ConfirmActiveDisconnect bool              `json:"confirmActiveDisconnect"`
	SplitRatio             int                 `json:"splitRatio"`
	FontSize              string              `json:"fontSize"`
	Theme                 string              `json:"theme"`
	TerminalTheme         string              `json:"terminalTheme"`
	ActiveProfile         string              `json:"activeProfile"`
	AutoCommandLimit      int                 `json:"autoCommandLimit"`
	AutoAllowChanges      bool                `json:"autoAllowChanges"`
	AutoContinueRounds     bool                `json:"autoContinueRounds"`
	Version               string              `json:"version"`
}

type SaveSessionRequest struct {
	Session    domain.Session `json:"session"`
	Secret     string         `json:"secret"`
	SaveSecret bool           `json:"saveSecret"`
}
type SaveAPIRequest struct {
	Profile    domain.APIProfile `json:"profile"`
	Key        string            `json:"key"`
	MemoryOnly bool              `json:"memoryOnly"`
}
type HostChallenge struct {
	ID          string `json:"id"`
	Address     string `json:"address"`
	Fingerprint string `json:"fingerprint"`
	Changed     bool   `json:"changed"`
}
type ConnectResult struct {
	ConversationID string               `json:"conversationId"`
	Ref            domain.ConnectionRef `json:"ref"`
	Challenge      *HostChallenge       `json:"challenge,omitempty"`
	Home           string               `json:"home"`
}
type ChatRequest struct {
	RequestID string               `json:"requestId"`
	Ref       domain.ConnectionRef `json:"ref"`
	Targets   []domain.ConnectionRef `json:"targets,omitempty"`
	ProfileID string               `json:"profileId"`
	Text      string               `json:"text"`
	Context   string               `json:"context"`
	Operate   bool                 `json:"operate"`
}
type ChatResponse struct {
	Text     string           `json:"text"`
	Proposal *domain.Proposal `json:"proposal,omitempty"`
}

func NewApp() (*App, error) {
	dir, e := os.UserConfigDir()
	if e != nil {
		return nil, e
	}
	return newApp(filepath.Join(dir, branding.Name, "state.db"), store.NewSecrets(), nil)
}
func newApp(path string, secrets domain.SecretStore, emit sshclient.EmitFunc) (*App, error) {
	db, e := store.Open(path)
	if e != nil {
		return nil, e
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	a := &App{ctx: context.Background(), store: db, secrets: secrets, provider: ai.NewProvider(), executions: map[string]*conversationExecution{}, closing: map[string]domain.ConnectionRef{}, proposalRuns: map[string]string{}, emit: emit, transient: map[string]string{}, challenges: map[string]*sshclient.HostKeyError{}, chatCancels: map[string]context.CancelFunc{}, pending: map[string]string{}, tabRefs: map[string]domain.ConnectionRef{}, localTerminals: map[string]*localTerminalSession{}, localTerminalPending: map[string]string{}}
	a.memory = conversation.NewService(db, func(event domain.ConversationEvent) { a.emit("conversation:event", event) })
	saved, e := db.GetPreference(a.ctx, "saveChatHistory")
	if e != nil {
		db.Close()
		return nil, e
	}
	if saved == "false" {
		if e = a.memory.Configure(a.ctx, false); e != nil {
			db.Close()
			return nil, e
		}
	}
	a.connectEpoch = map[string]uint64{}
	a.automatic = tasks.NewAutomaticRunner()
	a.ssh = sshclient.NewManager(db, func(name string, payload any) {
		if name == "ssh:disconnected" {
			if ref, ok := payload.(domain.ConnectionRef); ok {
				a.cancelExecution(ref, false)
				if a.sftp != nil { a.sftp.CancelConnection(ref) }
			}
		}
		a.emit(name, payload)
	})
	interval, _ := db.GetPreference(a.ctx, "keepAliveSeconds")
	keepAliveSeconds, err := strconv.Atoi(interval)
	if err != nil || keepAliveSeconds < 0 || keepAliveSeconds > 300 { keepAliveSeconds = 30 }
	a.ssh.SetKeepAliveInterval(time.Duration(keepAliveSeconds) * time.Second)
	a.sftp = files.NewManager(a.ssh.Client, func(name string, payload any) { a.emit(name, payload) })
	a.coordinator = tasks.NewCoordinator(a.ssh.Run, a.ssh.Valid)
	return a, nil
}
func (a *App) startup(ctx context.Context) { a.ctx = ctx }

// Before native shutdown, let the frontend decide whether to prompt for live SSH sessions.
func (a *App) beforeClose(context.Context) bool {
 a.mu.Lock()
 prevent := a.closeGuardReady && !a.quitApproved
 a.mu.Unlock()
 if prevent { a.emit("app:quit-requested", nil) }
 return prevent
}

func (a *App) SetCloseGuardReady(ready bool) {
 a.mu.Lock()
 a.closeGuardReady = ready
 a.mu.Unlock()
}

func (a *App) QuitConfirmed() {
 a.mu.Lock()
 a.quitApproved = true
 a.mu.Unlock()
 runtime.Quit(a.ctx)
}
func (a *App) shutdown(context.Context) {
	a.mu.Lock()
	for _, cancel := range a.chatCancels {
		cancel()
	}
	refs := make([]domain.ConnectionRef, 0, len(a.tabRefs))
	for _, r := range a.tabRefs {
		refs = append(refs, r)
	}
	a.mu.Unlock()
	for _, ref := range refs {
		a.cancelExecution(ref, true)
	}
	a.closeAllLocalTerminals()
	a.ssh.Close()
	a.memory.Close()
	a.store.Close()
}
func (a *App) State() (AppState, error) {
	language, err := a.language()
	if err != nil {
		return AppState{}, err
	}
	sessions, e := a.store.ListSessions(a.ctx)
	if e != nil {
		return AppState{}, e
	}
	groups, e := a.store.ListGroups(a.ctx)
	if e != nil {
		return AppState{}, e
	}
	profiles, e := a.store.ListAPIProfiles(a.ctx)
	if e != nil {
		return AppState{}, e
	}
	font, e := a.store.GetPreference(a.ctx, "fontSize")
	if e != nil {
		return AppState{}, e
	}
	active, e := a.store.GetPreference(a.ctx, "activeProfile")
	if e != nil {
		return AppState{}, e
	}
	theme, e := a.store.GetPreference(a.ctx, "theme")
	if e != nil {
		return AppState{}, e
	}
	if theme != "light" {
		theme = "dark"
	}
	terminalTheme, e := a.store.GetPreference(a.ctx, "terminalTheme")
	if e != nil {
		return AppState{}, e
	}
	switch terminalTheme {
	case "classic", "dark", "light":
	default:
		terminalTheme = "follow"
	}
	layout, e := a.store.GetPreference(a.ctx, "quickCommandLayout")
	if e != nil {
		return AppState{}, e
	}
	if layout != "multi" {
		layout = "single"
	}
	autoCopySelection, e := a.store.GetPreference(a.ctx, "autoCopySelection")
	if e != nil {
		return AppState{}, e
	}
	rightClickPaste, e := a.store.GetPreference(a.ctx, "rightClickPaste")
	if e != nil {
		return AppState{}, e
	}
	middleClickPaste, e := a.store.GetPreference(a.ctx, "middleClickPaste")
	if e != nil { return AppState{}, e }
	logHighlights, e := a.store.GetPreference(a.ctx, "logHighlights")
	if e != nil { return AppState{}, e }
	rawSplitRatio, e := a.store.GetPreference(a.ctx, "splitRatio")
	if e != nil { return AppState{}, e }
	splitRatio, e := strconv.Atoi(rawSplitRatio)
	if e != nil || splitRatio < 20 || splitRatio > 80 { splitRatio = 50 }
	confirmMultilinePaste, e := a.store.GetPreference(a.ctx, "confirmMultilinePaste")
	if e != nil {
		return AppState{}, e
	}
	raw, e := a.store.GetPreference(a.ctx, "quickCommands")
	if e != nil {
		return AppState{}, e
	}
	commands := []QuickCommand{}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &commands); err != nil {
			return AppState{}, err
		}
	}
	// Preserve existing run/insert actions, then use line breaks as the sole execution signal.
	for i := range commands {
		switch commands[i].Mode {
		case "run":
			if !strings.HasSuffix(commands[i].Command, "\n") && !strings.HasSuffix(commands[i].Command, "\r") {
				commands[i].Command += "\n"
			}
			commands[i].Mode = ""
		case "insert":
			commands[i].Mode = ""
		}
	}
	limit, allow, autoContinue, e := a.automaticSettings()
	if e != nil {
		return AppState{}, e
	}
	saveChat, e := a.store.GetPreference(a.ctx, "saveChatHistory")
	if e != nil {
		return AppState{}, e
	}
	autoSummary, e := a.store.GetPreference(a.ctx, "autoSummarize")
	if e != nil {
		return AppState{}, e
	}
 	keepAliveRaw, e := a.store.GetPreference(a.ctx, "keepAliveSeconds")
	if e != nil { return AppState{}, e }
	keepAliveSeconds, e := strconv.Atoi(keepAliveRaw)
	if e != nil || keepAliveSeconds < 0 || keepAliveSeconds > 300 { keepAliveSeconds = 30 }
	maxRetriesRaw, e := a.store.GetPreference(a.ctx, "maxReconnectAttempts")
	if e != nil { return AppState{}, e }
	maxRetries, e := strconv.Atoi(maxRetriesRaw)
	if e != nil || maxRetries < 0 || maxRetries > 50 { maxRetries = 10 }
	autoReconnect, e := a.store.GetPreference(a.ctx, "autoReconnect")
	if e != nil { return AppState{}, e }
	showReason, e := a.store.GetPreference(a.ctx, "showDisconnectReason")
	if e != nil { return AppState{}, e }
	disconnectBehavior, e := a.store.GetPreference(a.ctx, "disconnectBehavior")
	if e != nil { return AppState{}, e }
	if disconnectBehavior != "local" && disconnectBehavior != "retain" && disconnectBehavior != "close" { disconnectBehavior = "local" }
	localShell, e := a.store.GetPreference(a.ctx, "localShell")
	if e != nil { return AppState{}, e }
	if localShell != "powershell" && localShell != "pwsh" && localShell != "cmd" && localShell != "wsl" { localShell = "powershell" }
	preserveHistory, e := a.store.GetPreference(a.ctx, "preserveTerminalHistory")
	if e != nil { return AppState{}, e }
	confirmDisconnect, e := a.store.GetPreference(a.ctx, "confirmActiveDisconnect")
	if e != nil { return AppState{}, e }
	return AppState{
		KeepAliveSeconds: keepAliveSeconds,
		AutoReconnect: autoReconnect != "false",
		MaxReconnectAttempts: maxRetries,
		ShowDisconnectReason: showReason != "false",
		DisconnectBehavior: disconnectBehavior,
		LocalShell: localShell,
		PreserveTerminalHistory: preserveHistory != "false",
		ConfirmActiveDisconnect: confirmDisconnect != "false",
		SaveChatHistory: saveChat != "false", AutoSummarize: autoSummary != "false",
		Language: language, AutoCommandLimit: limit, AutoAllowChanges: allow, AutoContinueRounds: autoContinue,
		Sessions: sessions, Groups: groups, Profiles: profiles,
		FontSize: font, Theme: theme, TerminalTheme: terminalTheme, ActiveProfile: active,
		QuickCommands: commands, QuickCommandLayout: layout,
		AutoCopySelection: autoCopySelection == "true", RightClickPaste: rightClickPaste == "true",
		ConfirmMultilinePaste: confirmMultilinePaste != "false",
		MiddleClickPaste: middleClickPaste == "true", LogHighlights: logHighlights == "true", SplitRatio: splitRatio,
		Version:               branding.Version,
	}, nil
}

// clearSessionCredentialsLocked invalidates both the session fallback and
// credentials cached per terminal tab. Caller must hold a.mu.
func (a *App) clearSessionCredentialsLocked(sessionID string) {
 suffix := ":" + sessionID
 for key := range a.transient {
  if key == "session:"+sessionID || (strings.HasPrefix(key, "connection:") && strings.HasSuffix(key, suffix)) {
   delete(a.transient, key)
  }
 }
}

func (a *App) SaveSession(req SaveSessionRequest) (domain.Session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	req.Session.Host = strings.TrimSpace(req.Session.Host)
	req.Session.Username = strings.TrimSpace(req.Session.Username)
	req.Session.Name = strings.TrimSpace(req.Session.Name)
	if req.Session.Name == "" {
		req.Session.Name = req.Session.Host
	}
	old, _ := a.store.GetSession(a.ctx, req.Session.ID)
	row, e := a.store.SaveSessionWithSecret(a.ctx, req.Session, req.Secret, req.SaveSecret, a.secrets)
	var appErr *domain.AppError
	committed := e == nil || (errors.As(e, &appErr) && appErr.Code == "cleanup")
	if committed {
		key := "session:" + row.ID
		authChanged := old.AuthType != row.AuthType || old.PrivateKeyPath != row.PrivateKeyPath || old.Host != row.Host || old.Port != row.Port || old.Username != row.Username || old.UseSSHConfig != row.UseSSHConfig || old.ProxyJump != row.ProxyJump
		if req.SaveSecret || authChanged || req.Secret != "" || old.CredentialRef != row.CredentialRef {
			a.clearSessionCredentialsLocked(row.ID)
		}
		if !req.SaveSecret && req.Secret != "" {
			a.transient[key] = req.Secret
		}
	}
	return row, e
}
// DuplicateSession copies a saved SSH configuration without opening a connection.
func (a *App) DuplicateSession(id string) (domain.Session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	source, err := a.store.GetSession(a.ctx, id)
	if err != nil {
		return domain.Session{}, err
	}
	sessions, err := a.store.ListSessions(a.ctx)
	if err != nil {
		return domain.Session{}, err
	}

	base := source.Name + " - " + a.dialogTitle("Copy", "副本")
	used := make(map[string]bool, len(sessions))
	for _, session := range sessions {
		if session.GroupID == source.GroupID {
			used[session.Name] = true
		}
	}
	name := base
	for index := 2; used[name]; index++ {
		name = base + " (" + strconv.Itoa(index) + ")"
	}

	copy := source
	copy.ID = domain.NewID()
	copy.Name = name
	copy.CredentialRef = ""
	copy.CreatedAt = ""
	copy.UpdatedAt = ""

	var credential string
	if source.CredentialRef != "" {
		credential, err = a.secrets.Get(a.ctx, source.CredentialRef)
		if err != nil || credential == "" {
			return domain.Session{}, apperror.New("couldNotReadLoginCredentialsEnterThemAgain", nil)
		}
	}
	return a.store.SaveSessionWithSecret(a.ctx, copy, credential, source.CredentialRef != "", a.secrets)
}

func (a *App) DeleteSession(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, ref := range a.tabRefs {
		if ref.SessionID == id {
			return apperror.New("closeThisSessionSTerminalTabsFirst", nil)
		}
	}
	s, e := a.store.GetSession(a.ctx, id)
	if e != nil {
		return e
	}
	if e = a.store.DeleteSession(a.ctx, id); e != nil {
		return e
	}
	a.clearSessionCredentialsLocked(id)
	if s.CredentialRef != "" {
		if e = a.secrets.Delete(a.ctx, s.CredentialRef); e != nil {
			return apperror.New("sessionDeletedButCredentialCleanupFailedRemoveOpenshell", nil)
		}
	}
	return nil
}
func (a *App) SaveGroup(g domain.Group) (domain.Group, error) {
	g.Name = strings.TrimSpace(g.Name)
	if g.Name == "" || g.ParentID == g.ID && g.ID != "" {
		return g, apperror.New("folderInvalidNameOrParent",nil)
	}
	if g.ID == "" { g.ID = domain.NewID() }
	groups, err := a.store.ListGroups(a.ctx)
	if err != nil { return g, err }
	parents := make(map[string]string, len(groups))
	for _, item := range groups { parents[item.ID] = item.ParentID }
	seen := map[string]bool{g.ID:true}
	for id := g.ParentID; id != ""; id = parents[id] {
		if seen[id] { return g, apperror.New("folderCycleNotAllowed",nil) }
		if _, ok := parents[id]; !ok { return g, apperror.New("folderParentNotFound",nil) }
		seen[id] = true
	}
	return g, a.store.SaveGroup(a.ctx, g)
}
func (a *App) DeleteGroup(id string) error { return a.store.DeleteGroup(a.ctx, id) }
func (a *App) SavePreference(key, value string) error {
	switch key {
	case "fontSize", "activeProfile":
	case "language":
		if value != "en" && value != "zh-CN" {
			return apperror.New("unsupportedLanguage", nil)
		}
	case "theme":
		if value != "dark" && value != "light" {
			return apperror.New("unsupportedTheme", nil)
		}
	case "terminalTheme":
		if value != "follow" && value != "classic" && value != "dark" && value != "light" {
			return apperror.New("unsupportedTheme", nil)
		}
	case "disconnectBehavior":
		if value != "local" && value != "retain" && value != "close" { return apperror.New("unsupportedPreference", nil) }
	case "localShell":
		if value != "powershell" && value != "pwsh" && value != "cmd" && value != "wsl" { return apperror.New("unsupportedPreference", nil) }
	case "quickCommandLayout":
		if value != "single" && value != "multi" {
			return apperror.New("unsupportedCommandBarLayout", nil)
		}
	case "autoCommandLimit":
		n, e := strconv.Atoi(value)
		if e != nil || n < 1 || n > 100 {
			return apperror.New("commandLimitMustBeBetween1And100", nil)
		}
	case "autoCopySelection", "rightClickPaste", "middleClickPaste", "logHighlights", "confirmMultilinePaste", "autoAllowChanges", "autoContinueRounds", "saveChatHistory", "autoSummarize", "autoReconnect", "showDisconnectReason", "confirmActiveDisconnect", "preserveTerminalHistory":
		if value != "true" && value != "false" {
			return apperror.New("booleanSettingsMustBeTrueOrFalse", nil)
		}
	case "keepAliveSeconds":
		n, err := strconv.Atoi(value)
		if err != nil || (n != 0 && n != 15 && n != 30 && n != 60) { return apperror.New("unsupportedPreference", nil) }
	case "maxReconnectAttempts":
		n, err := strconv.Atoi(value)
		if err != nil || (n != 0 && n != 5 && n != 10 && n != 20) { return apperror.New("unsupportedPreference", nil) }
	case "splitRatio":
		n, err := strconv.Atoi(value)
		if err != nil || n < 20 || n > 80 { return apperror.New("unsupportedPreference", nil) }
	case "quickCommands":
		if err := validateQuickCommands(value); err != nil {
			return err
		}
	default:
		return apperror.New("unsupportedPreference", nil)
	}
	if key == "saveChatHistory" {
		a.executionMu.Lock()
		defer a.executionMu.Unlock()
		old, e := a.store.GetPreference(a.ctx, key)
		if e != nil {
			return e
		}
		if (old != "false") == (value == "true") {
			return a.store.SetPreference(a.ctx, key, value)
		}
		if e = a.store.SetPreference(a.ctx, key, value); e != nil {
			return e
		}
		if e = a.memory.Configure(a.ctx, value == "true"); e != nil {
			a.store.SetPreference(a.ctx, key, old)
			return e
		}
		return nil
	}
	if err := a.store.SetPreference(a.ctx, key, value); err != nil { return err }
	if key == "keepAliveSeconds" {
		seconds, _ := strconv.Atoi(value)
		a.ssh.SetKeepAliveInterval(time.Duration(seconds) * time.Second)
	}
	return nil
}

func validateQuickCommands(raw string) error {
	if len(raw) > 256*1024 {
		return apperror.New("quickCommandConfigurationIsTooLarge", nil)
	}
	var commands []QuickCommand
	if err := json.Unmarshal([]byte(raw), &commands); err != nil {
		return apperror.New("invalidQuickCommandConfiguration", nil)
	}
	if len(commands) > 200 {
		return apperror.New("saveUpTo200QuickCommands", nil)
	}
	seen := make(map[string]bool, len(commands))
	for _, c := range commands {
		if c.ID == "" || seen[c.ID] || len(c.ID) > 100 {
			return apperror.New("invalidOrDuplicateQuickCommandId", nil)
		}
		seen[c.ID] = true
		if n := len([]rune(strings.TrimSpace(c.Name))); n == 0 || n > 40 {
			return apperror.New("commandNameMustBe140Characters", nil)
		}
		if strings.TrimSpace(c.Command) == "" || len(c.Command) > 16*1024 ||
			strings.IndexFunc(c.Command, func(r rune) bool {
				return (r < 32 && r != '\n' && r != '\r' && r != '\t') || r == 127
			}) >= 0 {
			return apperror.New("commandMustBeNonemptyUpTo16384Bytes", nil)
		}
		if len([]rune(c.Category)) > 40 {
			return apperror.New("commandCategoryIsTooLong", nil)
		}
		if c.Mode != "" && c.Mode != "run" && c.Mode != "insert" {
			return apperror.New("invalidCommandAction", nil)
		}
		if c.Scope != "global" && c.Scope != "group" && c.Scope != "session" {
			return apperror.New("invalidCommandScope", nil)
		}
		if c.Scope != "global" && c.ScopeID == "" {
			return apperror.New("selectATargetFolderOrSession", nil)
		}
	}
	return nil
}

func (a *App) SaveAPI(req SaveAPIRequest) (domain.APIProfile, error) {
	p := req.Profile
	var endpointErr error
	switch p.Provider {
	case "", "openai":
		_, endpointErr = ai.NormalizeEndpoint(p.BaseURL)
	case "anthropic":
		_, endpointErr = ai.NormalizeAnthropicEndpoint(p.BaseURL)
	default:
		return p, apperror.New("unsupportedPreference", nil)
	}
	if endpointErr != nil { return p, endpointErr }
	if strings.TrimSpace(p.Model) == "" {
		return p, apperror.New("enterAModelName", nil)
	}
	if p.ID == "" {
		p.ID = domain.NewID()
	}
	old, _ := a.store.GetAPIProfile(a.ctx, p.ID)
	p.SecretRef = old.SecretRef
	if req.Key != "" && !req.MemoryOnly {
		p.SecretRef = "api-" + domain.NewID()
		if e := a.secrets.Put(a.ctx, p.SecretRef, req.Key); e != nil {
			return p, apperror.New("couldNotSaveSystemCredentialsUseTheKey", nil)
		}
	} else if req.MemoryOnly {
		p.SecretRef = ""
	}
	if e := a.store.SaveAPIProfile(a.ctx, p); e != nil {
		if p.SecretRef != "" && p.SecretRef != old.SecretRef {
			a.secrets.Delete(a.ctx, p.SecretRef)
		}
		return p, e
	}
	if req.Key != "" {
		a.mu.Lock()
		a.transient["api:"+p.ID] = req.Key
		a.mu.Unlock()
	}
	if old.SecretRef != "" && old.SecretRef != p.SecretRef {
		if e := a.secrets.Delete(a.ctx, old.SecretRef); e != nil {
			return p, apperror.New("profileSavedButOldCredentialCleanupFailed", nil)
		}
	}
	return p, nil
}
func (a *App) DeleteAPI(id string) error {
	p, e := a.store.GetAPIProfile(a.ctx, id)
	if e != nil {
		return e
	}
	if e = a.store.DeleteAPIProfile(a.ctx, id); e != nil {
		return e
	}
	a.mu.Lock()
	delete(a.transient, "api:"+id)
	a.mu.Unlock()
	if p.SecretRef != "" {
		if e = a.secrets.Delete(a.ctx, p.SecretRef); e != nil {
			return apperror.New("profileDeletedButCredentialCleanupFailed", nil)
		}
	}
	return nil
}
func (a *App) profile(id string) (domain.APIProfile, string, error) {
	p, e := a.store.GetAPIProfile(a.ctx, id)
	if e != nil {
		return p, "", apperror.New("selectAnAiApiProfileFirst", nil)
	}
	a.mu.Lock()
	key, ok := a.transient["api:"+id]
	a.mu.Unlock()
	if !ok && p.SecretRef != "" {
		key, e = a.secrets.Get(a.ctx, p.SecretRef)
		if e != nil {
			return p, "", apperror.New("couldNotReadApiKeyEnterItAgain", nil)
		}
	}
	return p, key, nil
}
func (a *App) TestAPI(req SaveAPIRequest) error {
	p := req.Profile
	key := req.Key
	if key == "" && p.ID != "" {
		_, saved, e := a.profile(p.ID)
		if e == nil {
			key = saved
		}
	}
	p.ToolsEnabled = false
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	_, e := a.provider.Stream(ctx, p, key, []ai.Message{{Role: "user", Content: "Reply OK."}}, nil)
	return e
}
func (a *App) Connect(tabID, sessionID, secret string) (ConnectResult, error) {
	if len(tabID) < 1 || len(tabID) > 128 {
		return ConnectResult{}, apperror.New("invalidTerminalTab", nil)
	}
	a.mu.Lock()
	s, e := a.store.GetSession(a.ctx, sessionID)
	if e != nil {
		a.mu.Unlock()
		return ConnectResult{}, e
	}
	old, exists := a.tabRefs[tabID]
	a.connectEpoch[tabID]++
	epoch := a.connectEpoch[tabID]
	a.tabRefs[tabID] = domain.ConnectionRef{TabID: tabID, SessionID: sessionID}
	if secret == "" {
		secret = a.transient["connection:"+tabID+":"+sessionID]
		if secret == "" { secret = a.transient["session:"+sessionID] }
	}
	a.mu.Unlock()
	a.stopLocalTerminal(tabID, "")
	if exists {
		a.cancelExecution(old, true)
	}
	if secret == "" && s.CredentialRef != "" {
		secret, e = a.secrets.Get(a.ctx, s.CredentialRef)
		if e != nil {
			return ConnectResult{}, apperror.New("couldNotReadLoginCredentialsEnterThemAgain", nil)
		}
	}
	auth := sshclient.AuthInput{}
	if s.AuthType == "key" {
		auth.Passphrase = secret
	} else {
		auth.Password = secret
	}
	ref, e := a.ssh.Connect(a.ctx, tabID, s, auth)
	a.mu.Lock()
	if a.connectEpoch[tabID] != epoch {
		a.mu.Unlock()
		a.ssh.Disconnect(ref)
		return ConnectResult{}, apperror.New("connectionCancelled", nil)
	}
	a.tabRefs[tabID] = ref
	a.mu.Unlock()
	if e != nil {
		var h *sshclient.HostKeyError
		if errors.As(e, &h) {
			id := domain.NewID()
			a.mu.Lock()
			a.challenges[id] = h
			for key := range a.challenges {
				if len(a.challenges) > 100 {
					delete(a.challenges, key)
				}
			}
			a.mu.Unlock()
			return ConnectResult{Ref: ref, Challenge: &HostChallenge{ID: id, Address: h.Address, Fingerprint: h.Fingerprint, Changed: h.Changed}}, nil
		}
		return ConnectResult{Ref: ref}, e
	}
	home, _ := a.ssh.Home(ref)
	a.mu.Lock()
	if a.connectEpoch[tabID] != epoch {
		a.mu.Unlock()
		a.ssh.Disconnect(ref)
		return ConnectResult{}, apperror.New("connectionCancelled", nil)
	}
	live, e := a.ssh.ConnectedSession(ref)
	var c domain.Conversation
	if e == nil {
		c, e = a.memory.Bind(a.ctx, ref, live)
	}
	a.mu.Unlock()
	if e != nil {
		return ConnectResult{Ref: ref, Home: home}, e
	}
	if secret != "" {
		a.mu.Lock()
		a.transient["connection:"+tabID+":"+sessionID] = secret
		a.mu.Unlock()
	}
	return ConnectResult{Ref: ref, Home: home, ConversationID: c.ID}, nil
}
func (a *App) TrustHost(challengeID string) error {
	a.mu.Lock()
	h := a.challenges[challengeID]
	delete(a.challenges, challengeID)
	a.mu.Unlock()
	if h == nil {
		return apperror.New("fingerprintConfirmationExpiredReconnect", nil)
	}
	if h.Changed {
		return apperror.New("fingerprintChangedVerifyTheServerOverwritingTrustedFingerprints", nil)
	}
	return a.store.Trust(h.Address, h.Key)
}
func (a *App) OpenTerminal(ref domain.ConnectionRef, cols, rows int) error {
	return a.ssh.OpenTerminal(ref, cols, rows)
}
func (a *App) WriteTerminal(ref domain.ConnectionRef, data string) error {
    return a.ssh.Write(ref, data)
}
func (a *App) AcknowledgeTerminalOutput(ref domain.ConnectionRef, sequence uint64) {
    a.ssh.AcknowledgeOutput(ref, sequence)
}
func (a *App) CancelZmodem(ref domain.ConnectionRef) error {
    return a.ssh.CancelZmodem(ref)
}
func (a *App) ResizeTerminal(ref domain.ConnectionRef, cols, rows int) error {
	return a.ssh.Resize(ref, cols, rows)
}
// Reconnect reuses only an in-memory credential or an existing saved credential.
func (a *App) Reconnect(tabID, sessionID string) (ConnectResult, error) {
	a.mu.Lock()
	s, err := a.store.GetSession(a.ctx, sessionID)
	secret := a.transient["connection:"+tabID+":"+sessionID]
	if secret == "" { secret = a.transient["session:"+sessionID] }
	a.mu.Unlock()
	if err != nil { return ConnectResult{}, err }
	if s.AuthType == "password" && secret == "" && s.CredentialRef == "" {
		return ConnectResult{}, apperror.New("couldNotReadLoginCredentialsEnterThemAgain", nil)
	}
	return a.Connect(tabID, sessionID, secret)
}

// CancelConnecting cancels an in-flight connection or automatic retry for one tab.
func (a *App) CancelConnecting(tabID string) {
	a.mu.Lock()
	a.connectEpoch[tabID]++
	ref := a.tabRefs[tabID]
	delete(a.transient, "connection:"+tabID+":"+ref.SessionID)
	a.mu.Unlock()
	a.sftp.CancelTab(tabID)
	a.cancelExecution(ref, true)
	a.ssh.CancelTab(tabID)
}

func (a *App) Disconnect(ref domain.ConnectionRef) error {
	a.mu.Lock()
	if current, ok := a.tabRefs[ref.TabID]; ok && current != ref {
		a.mu.Unlock()
		return nil
	}
	a.connectEpoch[ref.TabID]++
	delete(a.transient, "connection:"+ref.TabID+":"+ref.SessionID)
	a.mu.Unlock()
	a.sftp.CancelTab(ref.TabID)
	a.cancelExecution(ref, true)
	a.ssh.CancelTab(ref.TabID)
	a.emit("ssh:disconnected", ref)
	return nil
}
func (a *App) CloseTab(tabID string) error {
	a.stopLocalTerminal(tabID, "")
	a.mu.Lock()
	ref := a.tabRefs[tabID]
	a.mu.Unlock()
	a.cancelExecution(ref, true)
	a.mu.Lock()
	delete(a.transient, "connection:"+tabID+":"+ref.SessionID)
	a.mu.Unlock()
	a.automatic.Forget(tabID)
	a.coordinator.Forget(tabID)
	a.memory.Unbind(ref)
	a.mu.Lock()
	delete(a.tabRefs, tabID)
	a.connectEpoch[tabID]++
	for id := range a.pending {
		p, e := a.coordinator.Get(id)
		if e != nil || p.Ref.TabID == tabID {
			delete(a.pending, id)
		}
	}
	a.mu.Unlock()
	a.sftp.CancelTab(tabID)
	a.ssh.CancelTab(tabID)
	return nil
}
func (a *App) PreviewContext(ref domain.ConnectionRef, text string) (ai.Preview, error) {
	if !a.ssh.Valid(ref) {
		return ai.Preview{}, apperror.New("sessionDisconnected", nil)
	}
	if text == "" {
		text = a.ssh.History(ref)
	}
	p := ai.BuildPreview(text, 200, 32768)
	p.Text = ai.Redact(p.Text)
	return p, nil
}
func (a *App) Chat(req ChatRequest) (ChatResponse, error) { return a.chat(req, false) }
func (a *App) Continue(req ChatRequest) (ChatResponse, error) {
	req.Text = ""
	req.Context = ""
	return a.chat(req, true)
}
func (a *App) chat(req ChatRequest, continuation bool) (ChatResponse, error) {
	if a.automatic.Active(req.Ref.TabID) {
		return ChatResponse{}, apperror.New("stopTheAutomaticTaskFirst", nil)
	}
	return a.chatContext(a.ctx, req, continuation, false, nil)
}
func (a *App) ChoosePrivateKey() (string, error) {
	if a.pickKey == nil {
		return "", apperror.New("filePickerIsNotInitialized", nil)
	}
	return a.pickKey()
}

func (a *App) SFTPHome(ref domain.ConnectionRef) (files.Paths, error) {
 return a.sftp.Homes(ref)
}
func (a *App) SFTPList(ref domain.ConnectionRef, side, directory string) ([]files.Entry, error) {
 return a.sftp.List(ref, side, directory)
}
func (a *App) SFTPOperate(ref domain.ConnectionRef, side, operation, source, argument string) error {
 return a.sftp.Operate(ref, side, operation, source, argument)
}
func (a *App) SFTPTransfer(ref domain.ConnectionRef, direction, source, destination string, overwrite, resume bool) (files.Task, error) {
 return a.sftp.Start(ref, direction, source, destination, overwrite, resume)
}
func (a *App) SFTPTransfers(ref domain.ConnectionRef) []files.Task {
 return a.sftp.Transfers(ref)
}
func (a *App) SFTPCancel(taskID string) error {
 return a.sftp.Cancel(taskID)
}

func (a *App) SFTPChooseDirectory() (string, error) {
 return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title:a.dialogTitle("Select local folder", "选择本地文件夹")})
}

func (a *App) SFTPReadRemoteText(ref domain.ConnectionRef, name string) (files.RemoteDocument,error) {
 return a.sftp.ReadRemoteText(ref,name)
}
func (a *App) SFTPSaveRemoteText(ref domain.ConnectionRef, name,revision,content string) (files.RemoteDocument,error) {
 return a.sftp.SaveRemoteText(ref,name,revision,content)
}
func (a *App) SFTPPreviewSync(ref domain.ConnectionRef, direction,localDir,remoteDir string) (files.SyncPreview,error) {
 return a.sftp.PreviewSync(ref,direction,localDir,remoteDir)
}
func (a *App) SFTPBatchChmod(ref domain.ConnectionRef, side string, paths []string, mode string) (int,error) {
 return a.sftp.BatchChmod(ref,side,paths,mode)
}

func (a *App) SFTPEnsureDirectory(ref domain.ConnectionRef, side,directory string) error {
 return a.sftp.EnsureDirectory(ref,side,directory)
}
