package main

import (
	"context"
	"strings"

	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/store"
)

// Read the key only at the provider-request boundary. No plaintext key is
// retained by the AI task across tool execution, approval waits or history
// compaction batches. This reduces references, not guaranteed memory erasure.
func (a *App) requestStoredAICompletion(ctx context.Context, provider store.AIProvider, model string, messages []store.AIMessage, tools []map[string]any, onDelta func(string)) (store.AIMessage,int,error) {
	if err:=ctx.Err();err!=nil{return store.AIMessage{},0,err}
	key,err:=a.secrets.Get(ctx,provider.SecretRef)
	if err!=nil||key==""{return store.AIMessage{},0,apperror.New("aiMissingAPIKey",nil)}
	return requestAICompletionWithUsage(ctx,provider.BaseURL,key,model,messages,tools,onDelta)
}

// A provider may echo the Authorization header in its HTTP error body.
// Do not forward a verbatim API key to UI error events or diagnostics.
func redactAIKey(detail,key string) string {
	if key==""{return detail}
	return strings.ReplaceAll(detail,key,"[REDACTED]")
}
