package main

import (
	"context"
	"github.com/hctty27/openshell/internal/ai"
	"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
)

func (a *App) prepareConversationContext(ctx context.Context, run domain.ConversationRun, profile domain.APIProfile, key, language string, system ai.Message) ([]ai.Message, error) {
	c, history, err := a.memory.History(ctx, run.ID)
	if err != nil {
		return nil, err
	}
	setting, err := a.store.GetPreference(ctx, "autoSummarize")
	if err != nil {
		return nil, err
	}
	policy := ai.DefaultContextPolicy()
	var summarize ai.SummaryFunc
	if setting != "false" {
		summarize = func(summaryCtx context.Context, messages []ai.Message) (string, error) {
			a.memory.SetStatus(run.ID, "summarizing")
			p := profile
			p.ToolsEnabled = false
			messages[0].Content += "\nResponse language: " + language
			n, e := a.provider.RequestSize(p, messages)
			if e != nil {
				return "", e
			}
			if n > policy.SummaryInputBytes {
				return "", apperror.New("memoryContextTooLarge", nil)
			}
			reply, e := a.provider.Stream(summaryCtx, p, key, messages, nil)
			return reply.Text, e
		}
	}
	result, err := ai.BuildContext(ctx, system, history, c.Summary, c.SummaryThroughSeq, policy, summarize, func(messages []ai.Message) (int, error) { return a.provider.RequestSize(profile, messages) })
	if err != nil {
		return nil, err
	}
	if result.Summary != c.Summary || result.ThroughSeq != c.SummaryThroughSeq {
		if err = a.memory.SaveSummary(ctx, run.ID, c.Revision, result.Summary, result.ThroughSeq); err != nil {
			return nil, err
		}
	}
	if err = a.memory.SetStatus(run.ID, result.Status); err != nil {
		return nil, err
	}
	return result.Messages, nil
}
