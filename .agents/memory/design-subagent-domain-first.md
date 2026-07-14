---
    name: Design-subagent handoff for stateful sims
    description: When a frontend-only app needs new mutable domain logic (create/delegate/rebalance-style actions) plus a full visual rebrand, build the types/store/calculations yourself first, then delegate the UI.
    ---

    For apps with real interdependent business rules (permission checks, weighted-basket math, mutable in-memory "DB" via a persisted store), write types.ts / calculations.ts / store actions yourself and typecheck them before involving a design subagent -- correctness bugs here are expensive to catch visually.

    Once the domain layer is solid, delegate the full visual rebrand + new pages to a design subagent in one brief: give it exact action signatures (e.g. createDTR(input): {success,message,dtrId?}), exact permission-guard helper names to import, and tell it explicitly not to touch the domain files. It can successfully wire multi-step forms and gated dashboards end-to-end against that contract in one pass.

    **Why:** avoids the design subagent inventing its own (likely inconsistent) business logic, and avoids re-deriving math/permission rules after a stylistic pass touches the same files.

    **How to apply:** any "simulate a protocol/app with mutable state + role-based actions" build -- write store first, screenshot/typecheck it, then hand off styling.
    