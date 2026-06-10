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
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(repoRoot, "site", "data");
const daysDir = join(dataDir, "days");
const chDir = join(repoRoot, "ch");
const summaryPath = join(dataDir, "summary.json");
const compositionPath = join(dataDir, "composition.json");

const backfill = process.argv.includes("--all");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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

// Composition of the *whole current zone*, computed in one pass over the
// working-tree ch/ files (too large — ~2.6M domains — to analyse in the
// browser). Mirrors the per-day analyzeDomains() shape in site/js/data.js.
function corpusComposition(latestDate) {
  let entries;
  try {
    entries = readdirSync(chDir, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".txt"))
    .map((e) => join(e.parentPath ?? e.path, e.name));
  if (!files.length) return null;

  const hist = {};
  const firstChar = { digit: 0, other: 0 };
  for (let c = 97; c <= 122; c++) firstChar[String.fromCharCode(c)] = 0;

  let count = 0, lenSum = 0, min = Infinity, max = 0;
  let le3 = 0, eq4 = 0, le5 = 0, hyAny = 0, hyMulti = 0, digAny = 0, startsDigit = 0, numericOnly = 0, idn = 0;

  for (const f of files) {
    for (let line of readFileSync(f, "utf8").split("\n")) {
      line = line.trim();
      if (!line.endsWith(".ch")) continue;
      const lab = line.slice(0, -3);
      if (!lab) continue;
      const L = lab.length;
      count++; lenSum += L;
      if (L < min) min = L;
      if (L > max) max = L;
      hist[L] = (hist[L] || 0) + 1;
      if (L <= 3) le3++;
      if (L === 4) eq4++;
      if (L <= 5) le5++;
      const hy = (lab.match(/-/g) || []).length;
      if (hy >= 1) hyAny++;
      if (hy >= 2) hyMulti++;
      if (/[0-9]/.test(lab)) digAny++;
      const fc = lab[0];
      if (fc >= "0" && fc <= "9") { startsDigit++; firstChar.digit++; }
      else if (fc >= "a" && fc <= "z") firstChar[fc]++;
      else firstChar.other++;
      if (/^[0-9]+$/.test(lab)) numericOnly++;
      if (lab.startsWith("xn--")) idn++;
    }
  }
  if (!count) return null;

  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const quant = (q) => {
    const t = q * count;
    let cum = 0;
    for (const k of keys) { cum += hist[k]; if (cum >= t) return k; }
    return max;
  };

  return {
    generatedFor: latestDate,
    count,
    length: { min, max, avg: lenSum / count, median: quant(0.5), p90: quant(0.9), histogram: hist },
    short: { le3, eq4, le5 },
    firstChar,
    hyphen: { any: hyAny, multi: hyMulti },
    digit: { any: digAny, startsDigit, numericOnly },
    idn: { count: idn },
  };
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
    try {
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
    } catch (err) {
      console.error(
        `Failed to process ${cur.date} (${prev.hash.slice(0, 8)}..${cur.hash.slice(0, 8)}): ${err.message}`
      );
      process.exit(1);
    }
  }

  summary.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(
    `Wrote ${summary.length} dates (${added} new) to ${summaryPath}`
  );

  // Always refresh the corpus composition — the zone changes every run.
  const latestDate = summary.length ? summary[summary.length - 1].date : null;
  const composition = corpusComposition(latestDate);
  if (composition) {
    writeFileSync(compositionPath, JSON.stringify(composition));
    console.log(`Wrote composition.json (${composition.count} labels)`);
  } else {
    console.warn("Skipped composition.json (no ch/ files found).");
  }
}

main();
