#!/usr/bin/env node
// Build per-day registration/deregistration stats from git history.
//
// Each daily GitHub Action commit is a sorted snapshot of every .ch domain, so
// `git diff <prevDay>..<day> -- ch/` yields clean added lines (registrations)
// and removed lines (deregistrations). We collapse history to one commit per
// calendar date and diff consecutive dates.
//
// Output:
//   site/data/summary.json        [{date, registered, deregistered, total}, ...] (date-ascending)
//   site/data/days/<date>.json    {date, registered:[...], deregistered:[...]}
//
// Modes:
//   --all   backfill the entire history (run locally on a full clone)
//   (none)  incremental: only compute dates missing from summary.json

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(repoRoot, "site", "data");
const daysDir = join(dataDir, "days");
const summaryPath = join(dataDir, "summary.json");

const backfill = process.argv.includes("--all");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

// One commit per calendar date (keep the last commit of each date), ascending.
function dailyCommits() {
  const out = git(["log", "--reverse", "--format=%H %cI", "--", "ch/"]).trim();
  const byDate = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [hash, iso] = line.split(" ");
    byDate.set(iso.slice(0, 10), hash); // later commit on same date overwrites
  }
  return [...byDate.entries()].map(([date, hash]) => ({ date, hash }));
}

// Total domain count from ch-summary.txt at a commit ("<n> total"), or null.
function totalAt(hash) {
  let summary;
  try {
    summary = git(["show", `${hash}:ch-summary.txt`]);
  } catch {
    return null;
  }
  const m = summary.match(/^\s*(\d+)\s+total\s*$/m);
  return m ? Number(m[1]) : null;
}

// Diff two commits over ch/ -> {registered:[...], deregistered:[...]} (sorted).
function diffDomains(prevHash, curHash) {
  const out = git(["diff", "--no-color", prevHash, curHash, "--", "ch/"]);
  const registered = [];
  const deregistered = [];
  for (const line of out.split("\n")) {
    if (!line.endsWith(".ch")) continue; // skips +++/--- headers and hunk lines
    if (line[0] === "+") registered.push(line.slice(1));
    else if (line[0] === "-") deregistered.push(line.slice(1));
  }
  registered.sort();
  deregistered.sort();
  return { registered, deregistered };
}

function loadSummary() {
  if (!existsSync(summaryPath)) return [];
  try {
    return JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch {
    return [];
  }
}

function main() {
  mkdirSync(daysDir, { recursive: true });

  const commits = dailyCommits();
  if (commits.length < 2) {
    console.error("Not enough history to diff (need >= 2 daily commits).");
    process.exit(1);
  }

  const existing = backfill ? [] : loadSummary();
  const known = new Set(existing.map((e) => e.date));
  const summary = backfill ? [] : [...existing];

  let added = 0;
  // Diff each date against the previous date. commits[0] has no predecessor.
  for (let i = 1; i < commits.length; i++) {
    const cur = commits[i];
    const prev = commits[i - 1];
    if (known.has(cur.date)) continue;

    const { registered, deregistered } = diffDomains(prev.hash, cur.hash);
    writeFileSync(
      join(daysDir, `${cur.date}.json`),
      JSON.stringify({ date: cur.date, registered, deregistered })
    );
    summary.push({
      date: cur.date,
      registered: registered.length,
      deregistered: deregistered.length,
      total: totalAt(cur.hash),
    });
    added++;
    console.log(
      `${cur.date}: +${registered.length} / -${deregistered.length}`
    );
  }

  summary.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(summaryPath, JSON.stringify(summary, null, 0));
  console.log(
    `Wrote ${summary.length} dates (${added} new) to ${summaryPath}`
  );
}

main();
