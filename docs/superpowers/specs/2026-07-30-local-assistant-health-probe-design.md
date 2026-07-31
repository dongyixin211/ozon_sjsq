# Local Assistant Health Probe Stability Design

**Date:** 2026-07-30

## Goal

Stop intermittent false 本地助手连接超时 messages while the local assistant is healthy, without delaying detection when it is actually unavailable.

## Evidence

- The assistant listens on `127.0.0.1:17641` and reports protocol version `4`.
- Twenty-five consecutive `GET /health` requests returned HTTP 200, mostly in 10-18 ms.
- The browser polls `/health` every 1-3 seconds with a 700 ms timeout and creates a new connection per probe.
- During investigation, 179 connections to the assistant port were in `TIME_WAIT`.
- `App.tsx` allows periodic probes and manual refreshes to write the same status independently; one failed probe can show an error while another success restores the connected indicator.

## Scope

Only change browser-side health checking and its connected/disconnected feedback. The local assistant command API, port, protocol, and CORS policy remain unchanged.

## Design

### Probe Coordination

`src/lib/localAssistant.ts` will allow at most one active `/health` request. Concurrent callers will await the same result. Normal probes use a two-second timeout; the existing bounded retry behavior remains for startup and manual refresh.

### Periodic Scheduling and Feedback

`src/App.tsx` will schedule its next probe after the current probe settles. Healthy checks use a low, fixed cadence; failed checks use a bounded backoff. One or two transient failures preserve the connected UI and do not show an error. Only a configured consecutive-failure threshold marks the assistant disconnected. A later success clears the connection error while preserving unrelated API errors.

## Tests

Add focused tests for shared concurrent probes, transient failures retaining connected state, consecutive failures showing disconnected feedback, and recovery clearing a stale connection error.

## Success Criteria

- An idle browser workspace does not falsely show 本地助手连接超时 while the assistant continues responding.
- A stopped assistant reaches a stable disconnected state after the configured threshold.
- Restarting the assistant restores the connected state and removes the stale connection error.
- Focused tests, the web test suite, TypeScript build, and available Rust checks pass.
