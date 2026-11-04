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
 if len(chat)!=7 || len(chat[2].ToolCalls)!=0 || chat[3].Role!="assistant" || chat[6].ToolCallID!="new" {t.Fatalf("unsafe history %#v",chat)}
}
