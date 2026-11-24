package main

import "time"

// Unsaved credentials support recent connection retries, but are never kept
// indefinitely. Saved vault credentials are read on demand, not copied here.
const (
	transientSessionCredentialTTL = 15 * time.Minute
	transientConnectionCredentialTTL = 30 * time.Minute
)

// All helpers below require a.mu. Timer identity prevents a stale expiry
// callback deleting a newly supplied password; the callback holds no secret.
// Deleting references is best-effort lifetime reduction, not secure erasure.
func (a *App) cacheTransientLocked(key, secret string, ttl time.Duration) {
	a.deleteTransientLocked(key)
	if a.credentialsClosed || secret == "" || ttl <= 0 { return }
	if a.transient == nil { a.transient = make(map[string]string) }
	if a.transientTimers == nil { a.transientTimers = make(map[string]*time.Timer) }
	a.transient[key] = secret
	var timer *time.Timer
	timer = time.AfterFunc(ttl, func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.transientTimers[key] == timer { a.deleteTransientLocked(key) }
	})
	a.transientTimers[key] = timer
}

func (a *App) deleteTransientLocked(key string) {
	if timer := a.transientTimers[key]; timer != nil {
		timer.Stop()
		delete(a.transientTimers, key)
	}
	delete(a.transient, key)
}
