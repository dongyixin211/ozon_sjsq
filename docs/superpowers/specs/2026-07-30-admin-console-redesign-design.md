# Admin Console Redesign Design

## Goal

Redesign `/admin` into a data-management-first administrator console. Preserve the existing management capabilities, add real server-backed CRUD where missing, make all deletions logical, and standardize data-list pagination to ten records per page. The console must keep gallery source images, mockup results, shop usage, orders, and featured-gallery records correctly related.

## Scope and Constraints

- Keep the existing `/admin` route and admin-token authentication model.
- Improve the existing static administrator console incrementally; do not migrate it to React or add UI dependencies.
- All data-list pages use server pagination with `limit=10` by default.
- All delete actions are logical deletes. No administrator page may physically delete a record.
- Mockup results are never standalone gallery or featured-gallery records; they are derived media shown only under their source image.
- Featured Gallery in the console aggregates the already-existing user-side featured records. It must not derive eligibility from order data.
- Keep existing live product features and unrelated desktop/web UI unchanged.

## Information Architecture

The sidebar groups related work rather than listing every page at the same level.

### Dashboard

- **Overview:** operational metrics, recent changes, actionable warnings, and navigation shortcuts. It does not duplicate full list tables.

### Accounts and Entitlements

- **Users and Memberships:** user profile, role, membership, storage, device, and shop summary.
- **License Keys:** plan, validity, binding, usage, batch generation, and status.

### Content Assets

- **Gallery Assets:** source images only, with mockups, shop usage, and order summary attached to the source-image detail.
- **Featured Gallery:** aggregated user-side featured source images and their related media.
- **Mockup Templates:** template metadata, preview package, files, publish state, and lifecycle.

### Business Data

- **Orders and Shops:** order records, owner, shop, SKU, source-image relationship, source of record, and administrator notes.

### System Configuration

- **AI Settings:** AI model configuration list and effective configuration state.
- **Product Image Rules:** ratio rules and enabled status.
- **Recycle Bin:** logically deleted records grouped by data type, with detail and restore actions.

## Standard List-Page Experience

Every paginated page uses the same visual and interaction pattern:

1. Header with page title, one-line purpose, and the primary create action.
2. Filter toolbar containing keyword search and page-specific filters.
3. Compact data table or asset list with stable columns and row-level actions.
4. Footer with total count, displayed range, previous/next controls, direct page navigation, and a fixed request size of ten records.
5. Create and edit forms in a side drawer. Related details render in a read-only detail drawer.
6. Delete opens a confirmation dialog; success or failure is reported with a non-blocking notification.
7. After a mutation, retain filters and current page. If a delete empties the current page, navigate to the closest preceding non-empty page.
8. Every list has a deletion-state filter: active, deleted, or all. Default is active.

Singleton configuration screens do not pretend to be paginated data grids. AI provider/model entries are represented as managed rows so they receive the standard list behavior, while the effective settings view remains a concise configuration panel.

## Gallery Assets

### Record Meaning

A Gallery Assets row represents exactly one original/source asset. The source asset remains the primary identity for pagination, counts, search, selection, and deletion. A mockup result remains associated with `gallery_mockup_results.source_asset_id` and is never returned as a standalone asset row.

### List Data and Filters

Each row shows source-image thumbnail, SKU/file name, owner, ratio and dimensions, created time, mockup count, shop usage summary, order summary, lifecycle state, and actions.

Supported filters are keyword (SKU, source file name, or owner), owner, ratio family, mockup status, shop, ordered status, date range, and deletion state. The API applies all filters before total counting and pagination.

### Source Asset Detail

The detail drawer shows the source image first. The related mockup-result thumbnails immediately follow it, carrying template name, scene number, generation time, and preview link. Separate tabs show shop-use records and the concise order summary. No mockup can be edited as an independent gallery asset from this page.

### Mutations

Administrators can create a source asset, update editable source metadata, logically delete it, and restore it. Deleting a source image hides its associated mockup rows and featured references through their source-asset relationship; recovery makes those related records visible again when they have not been independently deleted.

## Featured Gallery

The Featured Gallery reads and aggregates the user-facing featured-gallery records. A row is a featured source image, not an order signal and not a mockup result.

Each row shows the source image, owner, SKU, feature status, reason or administrator note, user-facing create time, mockup count, shop-use and order summary, and lifecycle state. Its detail drawer repeats the source-first mockup presentation from Gallery Assets.

Filters are keyword, owner, feature status, mockup status, ordered status, shop, date range, and deletion state. Administrators may add an existing source asset to the featured collection, edit feature status and note, logically delete a feature record, and restore it. These actions update the user-side featured visibility associated with the same record.

## CRUD Coverage

- **Users and Memberships:** create, update profile/membership/limits, logical delete, restore; list is paginated by ten.
- **License Keys:** create and batch-create, update plan/expiry/status, logical delete, restore; list is paginated by ten.
- **Gallery Assets:** create source asset, update metadata, logical delete, restore; list is paginated by ten.
- **Featured Gallery:** add existing source asset, update status/note, logical delete, restore; list is paginated by ten.
- **Orders and Shops:** create/update administrator-managed fields, logical delete, restore; externally synchronized records retain an explicit source marker; list is paginated by ten.
- **Mockup Templates:** create/update template metadata and publish state, logical delete, restore; list is paginated by ten.
- **Product Image Rules:** create/update, enable/disable, logical delete, restore; list is paginated by ten.
- **AI model configurations:** create/update, logical delete, restore; list is paginated by ten. The current effective setting remains readable as a compact panel.
- **Recycle Bin:** filtered pagination by ten across record types; restore is the only destructive-lifecycle action.

## Data Lifecycle

Logical deletion uses `deleted_at` and `deleted_by` (where the table represents administrator-managed data). Active list queries must exclude `deleted_at IS NOT NULL` unless the deletion-state filter requests deleted or all records. Restore clears the two deletion fields. Existing tables without soft-delete columns require focused migrations; related visibility is handled by query conditions rather than physical cascade deletion.

The Recycle Bin is an aggregation of soft-deleted records. It never removes data permanently.

## API Contract

All list endpoints return this envelope:

```ts
{
  ok: true,
  items: T[],
  total: number,
  limit: 10,
  offset: number
}
```

List requests accept `limit`, `offset`, `deletionState`, and page-specific filter parameters. The UI calculates page controls from `total`, `limit`, and `offset`; it always starts requests with `limit=10`.

Managed resources use these mutation shapes:

```text
POST   /admin/<resource>
PUT    /admin/<resource>/:id
DELETE /admin/<resource>/:id
POST   /admin/<resource>/:id/restore
GET    /admin/<resource>
```

Existing endpoints retain compatible response fields where needed while adding the common `items` alias or adapting the admin UI through a local normalizer. All endpoints remain protected by the existing admin-token prehandler.

## Visual Direction

Use the approved data-management-first visual direction: a restrained neutral surface, dark or light grouped sidebar with one blue primary action color, compact data typography with tabular figures, clear information hierarchy, and low-noise borders. Avoid oversized statistic grids, decorative gradients, duplicate metrics, and individual mockup cards that compete with source-image records.

## Validation

- Server tests cover query filtering, `limit=10` behavior, total counts, soft-delete exclusion, restore, and source/mockup separation.
- Static admin tests cover navigation, pagination interaction, retained filters after mutation, empty-page fallback, and correct placement of related mockups after their source asset.
- Manual browser verification covers every sidebar item, create/edit/delete/restore feedback, and responsive rendering of tables and drawers.
