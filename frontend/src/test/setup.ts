import { afterAll } from "vitest";

// @wailsio/runtime's drag.js starts a 50 ms window.setInterval when it is
// imported. A test file that finishes sooner tears jsdom down first, and the
// pending tick then throws "window is not defined" as an unhandled error,
// which fails the whole run although every test passed. Waiting one tick
// longer than that interval lets it run (and clear itself) while the DOM
// still exists; Node fires timers in deadline order, so this is deterministic.
// Captured before any test can install fake timers.
const realSetTimeout = globalThis.setTimeout;
afterAll(() => new Promise<void>(resolve => { realSetTimeout(resolve, 60); }));
