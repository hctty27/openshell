package main

func NormalizeLanguage(value string) string {
	if value == "zh-CN" {
		return value
	}
	return "en"
}
func (a *App) language() (string, error) {
	value, err := a.store.GetPreference(a.ctx, "language")
	return NormalizeLanguage(value), err
}

func (a *App) dialogTitle(english, chinese string) string {
	language, err := a.language()
	if err == nil && language == "zh-CN" {
		return chinese
	}
	return english
}

