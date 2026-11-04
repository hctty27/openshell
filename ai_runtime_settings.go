package main

import (
    "encoding/json"
    "errors"
    "fmt"
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
        return errors.New("自动压缩阈值只能设置为 80%、85%、90% 或 95%")
    }
    if s.MaxSteps != 6 && s.MaxSteps != 12 && s.MaxSteps != 20 &&
        s.MaxSteps != 30 && s.MaxSteps != 50 {
        return errors.New("单次最大循环只能设置为 6、12、20、30 或 50 次")
    }
    if s.TaskTimeoutMinutes != 5 && s.TaskTimeoutMinutes != 10 &&
        s.TaskTimeoutMinutes != 20 && s.TaskTimeoutMinutes != 30 &&
        s.TaskTimeoutMinutes != 60 {
        return errors.New("任务超时只能设置为 5、10、20、30 或 60 分钟")
    }
    if s.KeepRecentTurns != 2 && s.KeepRecentTurns != 4 &&
        s.KeepRecentTurns != 6 && s.KeepRecentTurns != 10 &&
        s.KeepRecentTurns != 20 {
        return errors.New("保留最近完整对话只能设置为 2、4、6、10 或 20 轮")
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
        return AIRuntimeSettings{}, fmt.Errorf("读取 AI 设置失败: %w", err)
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
