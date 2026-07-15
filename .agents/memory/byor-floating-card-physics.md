---
name: byor floating-card drag/collision physics
description: How draggable, throwable, colliding floating cards were implemented for SSR.FUN's Live DTR Universe panel.
---

Draggable "fling and collide" physics for freely-floating absolutely-positioned cards works well with:
- A `dragStateRef` (not React state) tracking pointer offset + a rolling last-sample velocity, updated via `window`-level `pointermove`/`pointerup` listeners attached only while a drag is active.
- Treating the dragged body as **infinite mass** in collision response (`invMass = 0`) so it keeps following the pointer unaffected, while whatever it hits gets the full impulse.
- Standard 2D impulse collision formula (`j = -(1+e) * velAlongNormal / (invA+invB)`) with **restitution `e` > 1** (used 1.55) to intentionally make hits feel exaggerated/arcade-y ("clash and get launched away faster") rather than physically realistic.
- React state (`draggingIndex`) only drives styling; the actual per-frame physics stays in refs mutated inside the `requestAnimationFrame` loop to avoid re-render overhead.

**Why:** the user wanted mouse-draggable, throwable cards that knock each other away at higher speed on impact — plain physical elastic collision (e=1) felt too subtle for that "clash" request.
