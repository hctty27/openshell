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
