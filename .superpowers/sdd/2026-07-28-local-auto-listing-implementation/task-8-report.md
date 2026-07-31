# Task 8 Report

## Modified Files
- `server/scripts/auto-listing-consistency-smoke.ts`
- `server/package.json`

## Implementation
- Added `npm run listing:auto:smoke` to `server/package.json`.
- Created an in-process smoke script that reuses the production auto-listing route module, creates unique smoke data, fires two concurrent reserve requests through separate database transactions, checks source-asset uniqueness and shop balance, releases only untouched reserved assignments, and cleans up in `finally`.
- The script now reports a clear runtime block when PostgreSQL is unavailable.

## Verification
- `npm run check` — passed.
- `npm test` — passed 19/19 server tests.
- `npm run listing:auto:smoke` — blocked because PostgreSQL was unavailable: `connect ECONNREFUSED 127.0.0.1:5432`.

## Result
- TypeScript check is green for the new script.
- The smoke command is wired up and exits with an explicit runtime-blocked message when the local PostgreSQL instance is not reachable.
- `duplicateAssignments=0` is emitted only on a successful database-backed run; this environment could not reach PostgreSQL, so the script stopped before that assertion path.
