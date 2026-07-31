# Orders Pagination and Auto-Listing Loading Design

## Goal

Improve two focused areas: orders display ten rows per page by default with selectable page sizes, and auto-listing plans render before every shop warehouse request finishes.

## Order Pagination

- Paginate the existing filtered `rows` result on the client; the query `limit` remains the fetch ceiling.
- Default page size is 10. Options are 10, 20, 50, and 100.
- New results, filter changes, and page-size changes reset to page 1.
- Selection and summary totals continue to cover all loaded filtered rows, not only the visible page.
- Persist page size in the existing order draft stored in `localStorage`.

## Auto-Listing Loading

- Keep the eight core configuration requests as the blocking setup phase.
- Render the plan list immediately after core configuration loads.
- Load each shop warehouse in the background and merge results incrementally.
- One slow or failed warehouse request must not block the page.
- Show a small non-blocking warehouse-loading status while requests remain pending.
- Existing plan validation remains authoritative when warehouse data finishes.

## Error Handling and Tests

- Core setup failures remain blocking and use the existing error display.
- Warehouse failures remain isolated per shop.
- Orders tests cover default pagination, navigation, page-size changes, and selection semantics.
- Auto-listing tests hold a warehouse promise open and verify plans render before it resolves.
- No server API changes, new dependencies, or unrelated UI redesign.
