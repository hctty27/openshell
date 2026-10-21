# Internationalization

OpenShell defaults to English (en). Select English or 简体中文 (zh-CN) in Settings → Appearance → Language / 语言. The selection is saved immediately, independently of Save appearance, and restored before the workspace renders.

## Translation resources

The bundled JSON resources live in frontend/src/locales/{en,zh-CN}/. Namespaces cover common controls, sessions, settings, terminal, AI and errors. Keep stable semantic keys and translate complete sentences with parameters. Use i18next count-based plural forms for quantities. Missing translations fall back to English.

React components subscribe with useTranslation and use the typed t helper. Deferred application dialogs and temporary notices use message(key, values), rendered only when displayed. User names, commands, server output and historical messages stay unchanged. Do not translate protocol values or use translated text for logic.

## Add a language

1. Add the six namespace JSON files using English resources as the key/parameter reference.
2. Register its code and native display name in frontend/src/i18n/languages.ts. Extend normalizeLanguage there and NormalizeLanguage / SavePreference validation in Go.
3. Import and register the resources and supported language in frontend/src/i18n/index.ts. Extend the language type inferred from the registry.
4. Add its default AI response-language instruction in internal/ai/system.go and native private-key picker title in main.go.
5. Verify resource keys/parameters/plurals, preference persistence, missing-key fallback and compact layouts. Run go test ./..., npm ci, npm test -- --run, npm run build and npx playwright test from their respective project directories. Regenerate Wails bindings after Go payload changes.

## Errors and task status

Application errors use internal/apperror with a stable code and parameters. Wails v2 sends Error() through Promise rejection; the OPENSHELL_ERROR: JSON envelope is decoded centrally in frontend/src/i18n/errors.ts. Never match translated prose. Unknown third-party errors retain diagnostic text.

Execution results and automatic task snapshots carry reasonCode / reasonParams alongside a readable reason fallback. Use reasonText when displaying live states or creating a localized historical snapshot. Do not render error envelopes directly into chat.

## AI language

Ordinary requests and continuations read the current language at request start. An active response is not restarted on switching. Automatic tasks capture their starting language and keep it across confirmation, round extension and resume; subsequent new tasks use the latest preference. A user's explicit reply-language request takes priority. Model adherence is outside the application's deterministic guarantees.

## Validation limits

The implementation was checked with Go integration tests using real local SSH and an SSE model fixture, frontend unit tests, Chromium E2E, production bundling, generated Wails v2.17 bindings and Windows amd64 cross-compilation. Native Windows desktop interaction still requires a smoke test.

Known minor deferral: a pending quick-command confirmation can retain its translated run/insert action word if the global language changes externally while that modal is open. Command execution is unaffected; normal Settings access is blocked behind the modal.
