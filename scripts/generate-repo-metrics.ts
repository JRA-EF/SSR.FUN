// Regenerates docs/project/REPO_METRICS.json -- mechanically-derived repo
// facts (commit counts, contributors, branches, doc/decision/instruction
// counts, rough LOC) for the /internal/status dashboard's Engineering
// Overview panel. Never hand-edit REPO_METRICS.json; re-run this script
// instead (`npx ts-node -P scripts/tsconfig.json scripts/generate-repo-metrics.ts`).
//
// Why a generated file, not a live git call: the dashboard is served by a
// Vercel serverless function at request time, which has no `git` binary or
// guaranteed `.git` directory available -- so repo facts are computed once,
// here, in a real dev/CI environment that has both, and committed like
// docs/project/PROJECT_STATUS.md itself.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf-8" }).trim();
}

function countLines(globDirs: string[], extensions: string[]): number {
  let total = 0;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        total += fs.readFileSync(full, "utf-8").split("\n").length;
      }
    }
  };
  for (const d of globDirs) walk(path.join(ROOT, d));
  return total;
}

function main() {
  const totalCommits = Number(git("log --all --oneline").split("\n").filter(Boolean).length);

  const shortlog = git("shortlog -sne --all")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^\s*(\d+)\s+(.+?)\s+<(.+?)>$/);
      return m ? { name: m[2], email: m[3], commits: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; email: string; commits: number } => x !== null);

  // Tag each contributor with whether ANY of their commits carry a Claude
  // Co-Authored-By trailer -- a real, git-derived signal for "AI-assisted",
  // not a guess.
  const contributors = shortlog.map((c) => {
    const hashes = git(`log --all --author="${c.name}" --pretty=format:%H`).split("\n").filter(Boolean);
    const aiAssisted = hashes.some((h) => git(`log -1 --format=%B ${h}`).includes("Co-Authored-By: Claude"));
    return { ...c, aiAssisted };
  });

  const branchLines = git('branch -a --format="%(refname:short)|%(committerdate:iso-strict)|%(subject)"').split("\n");
  const branches = branchLines
    .filter((l) => !l.includes("HEAD -> ") && !l.startsWith("origin/HEAD") && !l.startsWith("origin|") && !l.startsWith("HEAD|"))
    .map((l) => {
      const [ref, date, ...subjectParts] = l.split("|");
      return { name: ref.replace(/^origin\//, ""), remote: ref.startsWith("origin/"), lastCommitDate: date, lastCommitSubject: subjectParts.join("|") };
    })
    // De-dupe local/remote pairs pointing at the same branch name, preferring the local entry.
    .filter((b, i, arr) => arr.findIndex((x) => x.name === b.name) === i);

  const firstCommit = git('log --all --reverse --pretty=format:"%H|%ad|%an|%s" --date=iso-strict').split("\n")[0];
  const [firstHash, firstDate, firstAuthor, firstSubject] = firstCommit.split("|");

  const latestCommit = git('log -1 --pretty=format:"%H|%ad|%an|%s" --date=iso-strict');
  const [latestHash, latestDate, latestAuthor, latestSubject] = latestCommit.split("|");

  const currentBranch = git("rev-parse --abbrev-ref HEAD");

  const docsCount = fs
    .readdirSync(path.join(ROOT, "docs"), { recursive: true } as any)
    .filter((f: unknown) => typeof f === "string" && f.endsWith(".md")).length;

  const decisionLog = fs.readFileSync(path.join(ROOT, "docs/project/DECISION_LOG.md"), "utf-8");
  const decisionCount = (decisionLog.match(/^## DEC-/gm) ?? []).length;

  const instructionsModPath = path.join(ROOT, "programs/ssr_protocol/src/instructions/mod.rs");
  const instructionsMod = fs.existsSync(instructionsModPath) ? fs.readFileSync(instructionsModPath, "utf-8") : "";
  const instructionCount = (instructionsMod.match(/^pub mod (?!common)\w+;/gm) ?? []).length;

  const rustLoc = countLines(["programs/ssr_protocol/src"], [".rs"]);
  const tsLoc = countLines(["src", "packages/sdk/src", "api", "scripts"], [".ts", ".tsx"]);

  const verifyScriptCount = fs.existsSync(path.join(ROOT, "scripts"))
    ? fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => f.startsWith("verify_") && f.endsWith(".ts")).length
    : 0;

  // Real commit activity per calendar day (deduped across branches by hash) --
  // powers the dashboard's commit-activity sparkline. Not a fabricated curve.
  const allCommitsWithDates = git('log --all --pretty=format:"%H|%ad" --date=short').split("\n").filter(Boolean);
  const seenHashes = new Set<string>();
  const perDay = new Map<string, number>();
  for (const line of allCommitsWithDates) {
    const [hash, date] = line.split("|");
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
  }
  const commitActivity = Array.from(perDay.entries())
    .map(([date, commits]) => ({ date, commits }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const output = {
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/generate-repo-metrics.ts",
    repository: {
      remoteUrl: git("remote get-url origin"),
      totalCommitsAllBranches: totalCommits,
      firstCommit: { hash: firstHash, date: firstDate, author: firstAuthor, subject: firstSubject },
      latestCommit: { hash: latestHash, date: latestDate, author: latestAuthor, subject: latestSubject },
      currentBranch,
      branches,
      contributors,
      commitActivity,
    },
    codebase: {
      rustLinesOfCode: rustLoc,
      typescriptLinesOfCode: tsLoc,
      protocolInstructionCount: instructionCount,
      documentationPageCount: docsCount,
      decisionLogEntryCount: decisionCount,
      liveDevnetVerificationScriptCount: verifyScriptCount,
    },
  };

  const outPath = path.join(ROOT, "docs/project/REPO_METRICS.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(output, null, 2));
}

main();
