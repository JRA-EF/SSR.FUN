---
name: Byor persisted-store migrations
description: How to safely evolve the zustand-persist shape in the SSR.FUN (byor) app without breaking existing localStorage state.
---

The app store uses zustand's `persist` middleware with a `migrate()` callback. Any time a field on a persisted entity (e.g. `DTR.feeConfig`) is renamed, reshaped, or split into multiple fields, or a brand-new top-level state slice is added (e.g. `profiles`), the change must be reflected in `migrate()`, not just in the type/initial-state defaults.

**Why:** Existing users' browsers already have old-shaped JSON in localStorage. Without a migration step, old fields silently read as `undefined` (NaN math, missing UI values) instead of erroring, so the bug is invisible until someone with old state opens the app.

**How to apply:** Bump the `version` number in the persist config, and in `migrate(persisted)`:
1. Cast `persisted` to an intersection type that includes both old (legacy, optional) and new field names.
2. For reshaped fields, compute the new field from the legacy one with a sensible fallback (`new ?? legacyValue ?? default`).
3. For new top-level slices, default them to an empty/initial value if absent.
