package main

import (
 "testing"
 "github.com/hctty27/openshell/internal/store"
)

func TestAIContextModelWindow(t *testing.T) {
 p := store.AIProvider{Models: []store.AIModel{{ID:"large", ContextWindow:262144},{ID:"small",ContextWindow:8192}}}
 if aiModelWindow(p,"large") != 262144 || aiModelWindow(p,"small") != 8192 { t.Fatal("window mismatch") }
 if aiModelWindow(p,"missing") != aiDefaultContextTokens { t.Fatal("default window mismatch") }
}

func TestAIContextHistoryRetentionAndBoundary(t *testing.T) {
 messages := make([]store.AIMessage,0,80)
 for i:=0;i<40;i++ {
  messages=append(messages,store.AIMessage{Role:"user",Content:"question"})
  messages=append(messages,store.AIMessage{Role:"assistant",Content:"answer"})
 }
 if len(aiHistoryContext(messages)) != 80 { t.Fatal("history silently truncated") }
 c:=store.AIConversation{Messages:messages}
 if got:=aiCompactBoundary(c,len(messages));got!=68 {t.Fatalf("boundary %d",got)}
 c.CompactedThrough=68
 if got:=aiCompactBoundary(c,len(messages));got!=76 {t.Fatalf("incremental boundary %d",got)}
}

func TestAIContextEstimateAndLiveToolSafety(t *testing.T) {
 if aiEstimateTokens("服务器 abc") == 0 {t.Fatal("empty estimate")}
 call:=store.AIToolCall{ID:"new",Function:store.AIFunction{Name:"ssh_exec"}}
 c:=store.AIConversation{Messages:[]store.AIMessage{
  {Role:"user",Content:"old"},
  {Role:"assistant",ToolCalls:[]store.AIToolCall{{ID:"old"}}},
  {Role:"tool",Content:"old result",ToolCallID:"old"},
  {Role:"user",Content:"current"},
  {Role:"assistant",ToolCalls:[]store.AIToolCall{call}},
  {Role:"tool",ToolCallID:"new",Content:"new result"},
 }}
 chat:=aiPreparedMessages(c,"system",3,false)
 if len(chat)!=6 || chat[2].Role!="assistant" ||
  chat[2].Content!="[历史工具结果，仅供参考，不代表当前连接状态]\nold result" ||
  chat[3].Role!="user" || len(chat[4].ToolCalls)!=1 || chat[5].ToolCallID!="new" {
  t.Fatalf("unsafe history %#v",chat)
 }
}

func TestAIHistoryDoesNotInventStaleTargetWarnings(t *testing.T) {
 messages := []store.AIMessage{
  {Role:"assistant",ToolCalls:[]store.AIToolCall{{ID:"old",Function:store.AIFunction{Name:"ssh_exec"}}}},
  {Role:"assistant",Content:"已查询数据库。",ToolCalls:[]store.AIToolCall{{ID:"old-2",Function:store.AIFunction{Name:"ssh_exec"}}}},
  {Role:"tool",Content:"private-chat=#"},
 }
 history := aiHistoryContext(messages)
 if len(history)!=2 || history[0].Role!="assistant" || history[0].Content!="已查询数据库。" {
  t.Fatalf("unexpected historical messages: %#v",history)
 }
 if history[1].Role!="assistant" || history[1].Content!="[历史工具结果，仅供参考，不代表当前连接状态]\nprivate-chat=#" {
  t.Fatalf("historical tool result was not sanitized: %#v",history[1])
 }
}
