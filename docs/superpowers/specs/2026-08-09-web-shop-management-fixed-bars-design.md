# Web Shop Management Fixed Bars Design

## Goal

Reduce unused web-page vertical space while preserving sticky operational context and feature navigation.

## Scope

- Modify only `src/App.tsx`, `src/features/ozon/OzonPage.tsx`, and `src/styles.css`.
- Do not change API calls, business state, task behavior, or desktop data processing.
- Keep feature-selection behavior unchanged.

## Shop Management

- Present timed maintenance and shop-management controls in one compact sticky web row.
- Retain critical status, actions, statistics, search, and add-shop controls.
- Keep the row single-line and horizontally scrollable at narrow browser widths.

## Shop Function Center

- Keep page header and shop context visible.
- Replace feature cards with a sticky, horizontal name-only tab bar beneath the shop header.
- Retain the active state and existing tab-switching behavior.
- Offset page content so sticky navigation does not obscure it.

## Styling Constraint

- Add a web-only shell class and scope the new layout to it.
- Append focused overrides instead of refactoring unrelated legacy styles.

## Verification

- Existing Ozon page tests pass.
- The web build completes.
- Rendered web pages keep compact bars sticky and single-line.