#!/usr/bin/env node
// DEC-0264: publish this PC's git state to /internal/commandcenter.
// Production cannot see a developer machine, so this script (run hourly by a
// scheduled task on the dev PC) records, in Neon command_center_snapshots:
//   - commits that exist only here (local branches ahead of GitHub, or with no
//     GitHub branch at all), per worktree;
//   - worktrees with uncommitted changes;
//   - branches on GitHub that are not merged into main.
// Names, counts and commit subjects only: no diffs, no file contents.
//
// usage: node scripts/command_center_git_snapshot.mjs [repo path]
// Needs DATABASE_URL (read from the repo's .env.local when not set).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repo = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const lines = (s) => (s ? s.split('\n').filter(Boolean) : [])

if (!process.env.DATABASE_URL) {
  try {
    // A worktree has no .env.local of its own; fall back to the main checkout's.
    const common = path.resolve(repo, git(['rev-parse', '--git-common-dir']))
    const file = [path.join(repo, '.env.local'), path.join(path.dirname(common), '.env.local')].find((p) => fs.existsSync(p))
    const m = file && fs.readFileSync(file, 'utf8').match(/^DATABASE_URL="?(.*?)"?$/m)
    if (m) process.env.DATABASE_URL = m[1]
  } catch { /* handled below */ }
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set and .env.local has none.'); process.exit(1) }

try { git(['fetch', '--quiet', '--prune', 'origin']) } catch { console.error('git fetch failed; using the last fetched state') }

const commitsOf = (...range) => lines(git(['log', '--format=%H%x09%cI%x09%s', ...range])).map((l) => {
  const [sha, date, ...rest] = l.split('\t')
  return { sha, date, subject: rest.join('\t').slice(0, 160) }
})

// Worktrees: which branch each has checked out, and whether it has uncommitted changes.
const worktrees = []
let cur = null
for (const l of lines(git(['worktree', 'list', '--porcelain']))) {
  if (l.startsWith('worktree ')) { cur = { path: l.slice(9), branch: null }; worktrees.push(cur) }
  else if (l.startsWith('branch ') && cur) cur.branch = l.slice(7).replace('refs/heads/', '')
}
const dirty = []
const branchWorktree = new Map()
for (const w of worktrees) {
  if (!fs.existsSync(w.path)) continue
  if (w.branch) branchWorktree.set(w.branch, path.basename(w.path))
  try {
    const n = lines(git(['status', '--porcelain'], w.path)).length
    if (n) dirty.push({ worktree: path.basename(w.path), branch: w.branch ?? '(detached)', files: n })
  } catch { /* a broken worktree */ }
}

// Work that would be lost with this PC: non-merge commits on no GitHub branch whose change is not
// already in main under another hash (git cherry). Staging deploy merges and cherry-picked
// patches are therefore not counted.
function realWork(tip, cwd = repo) {
  const notOnGithub = lines(git(['log', '--no-merges', '--format=%H%x09%cI%x09%s', tip, '--not', '--remotes=origin'], cwd)).map((l) => {
    const [sha, date, ...rest] = l.split('\t')
    return { sha, date, subject: rest.join('\t').slice(0, 160) }
  })
  if (!notOnGithub.length) return []
  const newPatches = new Set(lines(git(['cherry', 'refs/remotes/origin/main', tip], cwd)).filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)))
  return notOnGithub.filter((c) => newPatches.has(c.sha))
}

const unpushed = []
// Full ref names: a branch may itself be called heads/..., which the short form makes ambiguous.
for (const ref of lines(git(['for-each-ref', '--format=%(refname)', 'refs/heads']))) {
  const b = ref.slice('refs/heads/'.length)
  const commits = realWork(ref)
  if (!commits.length) continue
  unpushed.push({ branch: b, worktree: branchWorktree.get(b), ahead: commits.length, commits: commits.slice(0, 10) })
}
// Detached worktrees (deploy and staging checkouts) can hold commits that are on no branch at all.
const onBranches = new Set(lines(git(['log', '--format=%H', '--branches', '--not', '--remotes=origin'])))
for (const w of worktrees) {
  if (w.branch || !fs.existsSync(w.path)) continue
  try {
    const here = realWork('HEAD', w.path).filter((c) => !onBranches.has(c.sha))
    if (here.length) unpushed.push({ branch: '(detached)', worktree: path.basename(w.path), ahead: here.length, commits: here.slice(0, 10) })
  } catch { /* a broken worktree */ }
}

// GitHub branches not merged into main.
const unmerged = []
for (const ref of lines(git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']))) {
  const r = ref.slice('refs/remotes/'.length)
  if (r === 'origin/HEAD' || r === 'origin/main') continue
  const ahead = Number(git(['rev-list', '--count', `refs/remotes/origin/main..${ref}`]))
  if (!ahead) continue
  const [last] = commitsOf('-1', ref)
  unmerged.push({ branch: r.replace(/^origin\//, ''), ahead, lastCommit: last?.date ?? '', subject: last?.subject ?? '' })
}
unmerged.sort((a, b) => b.lastCommit.localeCompare(a.lastCommit))
unpushed.sort((a, b) => (b.commits[0]?.date ?? '').localeCompare(a.commits[0]?.date ?? ''))

const data = { host: os.hostname(), unpushed, dirty, unmerged }
const require = createRequire(path.join(repo, 'package.json'))
const { neon } = require('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL)
await sql`CREATE TABLE IF NOT EXISTS command_center_snapshots (kind text PRIMARY KEY, data jsonb NOT NULL, taken_at timestamptz NOT NULL DEFAULT now())`
await sql`INSERT INTO command_center_snapshots (kind, data, taken_at) VALUES ('git', ${JSON.stringify(data)}::jsonb, now())
  ON CONFLICT (kind) DO UPDATE SET data = EXCLUDED.data, taken_at = now()`
const commits = unpushed.reduce((a, b) => a + b.ahead, 0)
console.log(`git snapshot: ${commits} unpushed commit(s) in ${unpushed.length} branch(es), ${dirty.length} dirty worktree(s), ${unmerged.length} unmerged GitHub branch(es)`)
