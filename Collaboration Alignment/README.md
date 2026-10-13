# Collaboration Alignment

Shared hand-off log between the humans and LLM agents working on SSR.FUN (the Boss + their Claude, Joao + his Claude, and anyone else). One Markdown file per shipped unit of work.

## The rule

1. **Before starting any new work, read every file in this folder you have not read yet** (newest first — filenames sort by date). Build on what is there; do not redo it, do not overwrite it.
2. **Every time you ship something** — a commit pushed to a shared branch, a deployment, a program upgrade, a config/env change, a toolchain or infra change — **add one file here in the same commit** (or the status commit that follows a deploy).
3. Never edit someone else's entry except to append a dated "Follow-up" line at the bottom. A correction is a new entry that links the old one.
4. This folder complements, not replaces, `docs/project/DECISION_LOG.md` and `PROJECT_STATUS.md`: those record *decisions and status*; this folder records *what landed, where, and what the next person must know*.

## File naming

`YYYY-MM-DD-<author>-<short-slug>.md` — e.g. `2026-10-01-boss-set-keeper-gate-and-toolchain.md`. Several entries per day are fine; add `-2`, `-3` if the slug would collide.

## Template

```markdown
# <Title>

- **Date:** YYYY-MM-DD
- **Author:** <human> via <LLM, model>
- **Branch / commits:** `<branch>` @ `<sha>` … (and PR/merge if any)
- **Deployed to:** none | staging (`dpl_…`) | production (`dpl_…`) | Mainnet program (slot …) | Robinhood (tx …)
- **Decision log:** DEC-xxxx (or "none")

## What shipped
Plain-language summary: the product change, who sees it, what behaves differently.

## Code touched
- `path/to/file` — what changed and why (one line each)

## Repositories / environments adjusted
- SSR.FUN: …
- Other repos (ssr-evm, …): …
- Vercel env / Neon / Squads / keys: … (names only — never values)

## Effect on others — READ THIS
- Things that are now true that weren't (new routes, renamed things, new env vars, new conventions)
- Things NOT to touch / in-flight work that would conflict
- Known gaps the next person could pick up

## Verification
How it was checked (tests, tsc, browser, on-chain evidence).
```
