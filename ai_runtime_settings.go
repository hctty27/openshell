package main

import (
    "encoding/json"

    "github.com/hctty27/openshell/internal/apperror"
)

const aiRuntimeSettingsPreference = "aiRuntimeSettings"

// AI runtime settings are global defaults. A running task snapshots them at start.
type AIRuntimeSettings struct {
    AutoCompact       bool `json:"autoCompact"`
    CompactThreshold  int  `json:"compactThreshold"`
    MaxSteps          int  `json:"maxSteps"`
    TaskTimeoutMinutes int `json:"taskTimeoutMinutes"`
    KeepRecentTurns   int  `json:"keepRecentTurns"`
}

func defaultAIRuntimeSettings() AIRuntimeSettings {
    return AIRuntimeSettings{
        AutoCompact: true,
        CompactThreshold: 90,
        MaxSteps: 12,
        TaskTimeoutMinutes: 10,
        KeepRecentTurns: 6,
    }
}

func (s AIRuntimeSettings) validate() error {
    if s.CompactThreshold != 80 && s.CompactThreshold != 85 &&
        s.CompactThreshold != 90 && s.CompactThreshold != 95 {
        return apperror.New("aiCompactThresholdInvalid", nil)
    }
    if s.MaxSteps != 6 && s.MaxSteps != 12 && s.MaxSteps != 20 &&
        s.MaxSteps != 30 && s.MaxSteps != 50 {
        return apperror.New("aiMaxStepsInvalid", nil)
    }
    if s.TaskTimeoutMinutes != 5 && s.TaskTimeoutMinutes != 10 &&
        s.TaskTimeoutMinutes != 20 && s.TaskTimeoutMinutes != 30 &&
        s.TaskTimeoutMinutes != 60 {
        return apperror.New("aiTaskTimeoutInvalid", nil)
    }
    if s.KeepRecentTurns != 2 && s.KeepRecentTurns != 4 &&
        s.KeepRecentTurns != 6 && s.KeepRecentTurns != 10 &&
        s.KeepRecentTurns != 20 {
        return apperror.New("aiRecentTurnsInvalid", nil)
    }
    return nil
}

func (a *App) AIRuntimeSettings() (AIRuntimeSettings, error) {
    raw, err := a.store.GetPreference(a.ctx, aiRuntimeSettingsPreference)
    if err != nil {
        return AIRuntimeSettings{}, err
    }
    if raw == "" {
        return defaultAIRuntimeSettings(), nil
    }
    var settings AIRuntimeSettings
    if err := json.Unmarshal([]byte(raw), &settings); err != nil {
        return AIRuntimeSettings{}, apperror.Wrap("aiSettingsReadFailed", err, nil)
    }
    if err := settings.validate(); err != nil {
        return AIRuntimeSettings{}, err
    }
    return settings, nil
}

func (a *App) AISaveRuntimeSettings(settings AIRuntimeSettings) error {
    if err := settings.validate(); err != nil {
        return err
    }
    data, err := json.Marshal(settings)
    if err != nil {
        return err
    }
    return a.store.SetPreference(a.ctx, aiRuntimeSettingsPreference, string(data))
}
