# Task 2 report — quota math and fair allocation

## Scope

- Added pure quota calculation, deterministic round-robin allocation, and assignment release guard.
- Added the server Node test command and focused planner tests.

## TDD evidence

- RED: `cd server; npm test` failed because `auto-listing-planner.js` did not exist.
- GREEN: `cd server; npm test` passed 4 tests.
- TYPECHECK: `cd server; npm run check` passed.

## Files

- `server/src/auto-listing-planner.ts`
- `server/src/auto-listing-planner.test.ts`
- `server/package.json`

## Notes

- Create quota keeps a 5% reserve with a minimum reserve of two slots.
- Shops are allocated in stable round-robin order and exhausted capacity is redistributed.
- Only untouched `reserved` assignments can be released.
