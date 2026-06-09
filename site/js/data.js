// data.js — data loading and derived metrics.
// Pure data logic: no DOM access lives here, so it can be reasoned about and
// tested in isolation from the UI.

const DAY_MS = 86_400_000;
const MAX_DAY_CACHE = 120;

/**
 * Fetch and normalise the day-level summary.
 * @returns {Promise<Array>} ascending rows enriched with net/activity/baseline.
 */
export async function loadSummary() {
  const res = await fetch("data/summary.json");
  if (!res.ok) throw new Error(`summary.json: HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error("summary.json is not an array");
  return enrich(raw);
}

// Validate, sort ascending, and attach derived per-day fields.
function enrich(raw) {
  const rows = raw
    .filter(
      (d) =>
        d &&
        typeof d.date === "string" &&
        Number.isFinite(d.registered) &&
        Number.isFinite(d.deregistered)
    )
    .map((d) => {
      const registered = d.registered >= 0 ? d.registered : 0;
      const deregistered = d.deregistered >= 0 ? d.deregistered : 0;
      return {
        date: d.date,
        registered,
        deregistered,
        total: Number.isFinite(d.total) ? d.total : null,
        net: registered - deregistered,
        activity: registered + deregistered,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // A "baseline" row is one whose diff spans more than a single calendar day —
  // e.g. the initial backfill that diffs across a multi-month gap. These are
  // genuine data points but distort daily scales, peaks and averages, so we
  // flag them and let callers exclude them from those calculations.
  let prevDate = null;
  for (const r of rows) {
    const curTs = Date.parse(r.date);
    const prevTs = prevDate ? Date.parse(prevDate) : null;
    const gap =
      prevTs != null && Number.isFinite(curTs) && Number.isFinite(prevTs)
        ? Math.round((curTs - prevTs) / DAY_MS)
        : null;
    r.gapDays = gap;
    r.isBaseline = gap != null && gap > 1;
    prevDate = r.date;
  }
  return rows;
}

const dayCache = new Map();

/**
 * Fetch the registered/deregistered domain lists for a single date.
 * Missing or malformed files resolve to empty lists rather than throwing.
 */
export async function loadDay(date) {
  if (dayCache.has(date)) return dayCache.get(date);
  let data;
  try {
    const res = await fetch(`data/days/${date}.json`);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    data = { date, registered: [], deregistered: [] };
  }
  data.registered = Array.isArray(data.registered) ? data.registered : [];
  data.deregistered = Array.isArray(data.deregistered) ? data.deregistered : [];
  dayCache.set(date, data);
  if (dayCache.size > MAX_DAY_CACHE) {
    const firstKey = dayCache.keys().next().value;
    dayCache.delete(firstKey);
  }
  return data;
}

/** Load the precomputed whole-zone composition (optional; null if unavailable). */
export async function loadComposition() {
  try {
    const res = await fetch("data/composition.json");
    if (!res.ok) return null;
    const c = await res.json();
    return c && Number.isFinite(c.count) && c.count > 0 ? c : null;
  } catch {
    return null;
  }
}

/** Derive headline KPIs and aggregate statistics from the enriched summary. */
export function deriveMetrics(rows) {
  if (!rows.length) return null;

  const latest = rows[rows.length - 1];
  const real = rows.filter((r) => !r.isBaseline); // exclude backfill artifacts

  const last7 = real.slice(-7);
  const peakReg = maxBy(real, (r) => r.registered);
  const peakDereg = maxBy(real, (r) => r.deregistered);

  return {
    latest,
    totalTracked: latest.total ?? lastNonNull(rows, "total"),
    newYesterday: latest.registered,
    removedYesterday: latest.deregistered,
    netYesterday: latest.net,
    totalRegistered: sum(rows.map((r) => r.registered)),
    totalDeregistered: sum(rows.map((r) => r.deregistered)),
    trackedDays: rows.length,
    windowDays: last7.length,
    avg7Reg: mean(last7.map((r) => r.registered)),
    avg7Dereg: mean(last7.map((r) => r.deregistered)),
    avg7Net: mean(last7.map((r) => r.net)),
    avg7Activity: mean(last7.map((r) => r.activity)),
    net7: sum(last7.map((r) => r.net)),
    churnToday: churnRate(latest),
    churnAvg7: mean(last7.map(churnRate).filter((v) => v != null)),
    peakReg,
    peakDereg,
  };
}

/** Daily churn = gross activity / total tracked domains (null when total missing). */
export function churnRate(row) {
  return row && row.total ? row.activity / row.total : null;
}

/** Average registrations & deregistrations per *observed* weekday (Mon–Sun). */
export function weekdayAverages(rows) {
  const acc = Array.from({ length: 7 }, () => ({ reg: 0, dereg: 0, n: 0 }));
  for (const r of rows) {
    if (r.isBaseline) continue;
    const wd = new Date(`${r.date}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
    acc[wd].reg += r.registered;
    acc[wd].dereg += r.deregistered;
    acc[wd].n += 1;
  }
  const order = [1, 2, 3, 4, 5, 6, 0]; // present Mon-first
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return order.map((wd, i) => ({
    label: labels[i],
    regAvg: acc[wd].n ? acc[wd].reg / acc[wd].n : 0,
    deregAvg: acc[wd].n ? acc[wd].dereg / acc[wd].n : 0,
    count: acc[wd].n,
  }));
}

/** Average registrations & deregistrations per *observed* day-of-month (1–31). */
export function dayOfMonthAverages(rows) {
  const acc = Array.from({ length: 32 }, () => ({ reg: 0, dereg: 0, n: 0 }));
  for (const r of rows) {
    if (r.isBaseline) continue;
    const dom = Number(r.date.slice(8, 10));
    if (dom >= 1 && dom <= 31) {
      acc[dom].reg += r.registered;
      acc[dom].dereg += r.deregistered;
      acc[dom].n += 1;
    }
  }
  const out = [];
  for (let d = 1; d <= 31; d++) {
    out.push({
      label: String(d),
      dom: d,
      regAvg: acc[d].n ? acc[d].reg / acc[d].n : 0,
      deregAvg: acc[d].n ? acc[d].dereg / acc[d].n : 0,
      count: acc[d].n,
    });
  }
  return out;
}

/** Record days (baseline rows excluded so the initial import never wins). */
export function records(rows) {
  const real = rows.filter((r) => !r.isBaseline);
  if (!real.length) return null;
  const by = (sel) => real.reduce((b, r) => (sel(r) > sel(b) ? r : b), real[0]);
  const hr = by((r) => r.registered);
  const hd = by((r) => r.deregistered);
  const ha = by((r) => r.activity);
  const hg = by((r) => r.net);
  const hl = by((r) => -r.net);
  return {
    highestReg: { date: hr.date, value: hr.registered },
    highestDereg: { date: hd.date, value: hd.deregistered },
    highestActivity: { date: ha.date, value: ha.activity },
    highestNetGrowth: { date: hg.date, value: hg.net },
    highestNetLoss: { date: hl.date, value: hl.net },
  };
}

/** Largest single daily activity, ignoring baseline rows. Used to scale charts. */
export function activityScaleMax(rows) {
  let max = 0;
  for (const r of rows) {
    if (r.isBaseline) continue;
    if (r.registered > max) max = r.registered;
    if (r.deregistered > max) max = r.deregistered;
  }
  return max || 1;
}

/** Build short, factual observation strings from the derived metrics + history. */
export function buildObservations(m, rows = []) {
  if (!m) return [];
  const obs = [];
  const d = m.latest;
  const balanced = d.activity > 0 && Math.abs(d.net) / d.activity < 0.1;

  if (balanced) {
    obs.push({
      tone: "neutral",
      text: `${prettyDate(d.date)} was nearly balanced — ${f(d.registered)} registered against ${f(
        d.deregistered
      )} removed (net ${signed(d.net)}).`,
    });
  } else if (d.net >= 0) {
    obs.push({
      tone: "positive",
      text: `${prettyDate(d.date)} grew the zone by ${f(d.net)} domains (${f(
        d.registered
      )} new, ${f(d.deregistered)} removed).`,
    });
  } else {
    obs.push({
      tone: "negative",
      text: `${prettyDate(d.date)} shrank the zone by ${f(-d.net)} domains (${f(
        d.registered
      )} new, ${f(d.deregistered)} removed).`,
    });
  }

  if (m.windowDays > 1) {
    obs.push({
      tone: "neutral",
      text: `Over the last ${m.windowDays} days, registrations averaged ${f(
        m.avg7Reg
      )}/day and deregistrations ${f(m.avg7Dereg)}/day.`,
    });
    obs.push({
      tone: m.net7 >= 0 ? "positive" : "negative",
      text: `Net change across the last ${m.windowDays} days: ${signed(m.net7)} domains.`,
    });
  }

  if (m.peakReg) {
    obs.push({
      tone: "positive",
      text: `Strongest registration day so far: ${prettyDate(m.peakReg.date)} with ${f(
        m.peakReg.registered
      )} new domains.`,
    });
  }
  if (m.peakDereg) {
    obs.push({
      tone: "negative",
      text: `Strongest deregistration day so far: ${prettyDate(m.peakDereg.date)} with ${f(
        m.peakDereg.deregistered
      )} removed domains.`,
    });
  }

  // --- pattern observations (need the full history) ---
  const real = rows.filter((r) => !r.isBaseline);
  if (real.length >= 7) {
    const wd = weekdayAverages(rows).filter((d) => d.count);
    if (wd.length) {
      const busiest = wd.reduce((b, d) => (d.regAvg > b.regAvg ? d : b));
      obs.push({
        tone: "neutral",
        text: `${weekdayLong(busiest.label)} sees the most registrations on average (${f(
          busiest.regAvg
        )}/day).`,
      });
    }

    const dom = dayOfMonthAverages(rows).filter((d) => d.count);
    if (dom.length) {
      const peak = dom.reduce((b, d) => (d.deregAvg > b.deregAvg ? d : b));
      obs.push({
        tone: "neutral",
        text: `Deregistrations are highest around day ${peak.dom} of the month (avg ${f(
          peak.deregAvg
        )}).`,
      });
    }

    if (m.avg7Activity > 0) {
      const diff = (m.latest.activity - m.avg7Activity) / m.avg7Activity;
      if (Math.abs(diff) >= 0.1) {
        obs.push({
          tone: "neutral",
          text: `Today's total activity is ${formatPct(Math.abs(diff), 0)} ${
            diff >= 0 ? "above" : "below"
          } the 7-day average.`,
        });
      }
    }
  }

  if (m.churnToday != null) {
    obs.push({
      tone: "neutral",
      text: `Today's gross activity churned ${formatPct(m.churnToday, 2)} of the tracked zone.`,
    });
  }
  return obs;
}

/** Per-day composition insights for the selected day (factual, derivable only). */
export function buildDayInsights(row, regA, deregA) {
  const obs = [];
  if (!regA || !deregA) return obs;

  if (regA.count && deregA.count) {
    const dm = regA.length.median - deregA.length.median;
    if (Math.abs(dm) >= 1) {
      obs.push({
        tone: "neutral",
        text: `Today's new domains are ${dm > 0 ? "longer" : "shorter"} than removed ones (median ${
          regA.length.median
        } vs ${deregA.length.median} chars).`,
      });
    }
    const hd = regA.hyphen.anyShare - deregA.hyphen.anyShare;
    if (Math.abs(hd) >= 0.03) {
      obs.push({
        tone: "neutral",
        text: `Hyphenated domains are more common among ${
          hd < 0 ? "deregistrations" : "registrations"
        } today (${formatPct(regA.hyphen.anyShare, 1)} vs ${formatPct(deregA.hyphen.anyShare, 1)}).`,
      });
    }
  }

  if (regA.count) {
    obs.push({
      tone: "neutral",
      text: `Numeric-only domains make up ${formatPct(
        regA.digit.numericOnlyShare,
        1
      )} of today's registrations.`,
    });
  }

  const idnReg = regA?.idn.count || 0;
  const idnDereg = deregA?.idn.count || 0;
  if (idnReg || idnDereg) {
    obs.push({
      tone: "neutral",
      text: `IDN (punycode) domains today: ${fmt(idnReg)} registered, ${fmt(idnDereg)} deregistered.`,
    });
  }
  return obs;
}

// --- domain composition ---------------------------------------------------

const EXAMPLE_CAP = 60; // keep example lists small/cheap to render

function emptyAnalysis() {
  return {
    count: 0,
    length: { min: 0, max: 0, avg: 0, median: 0, p90: 0, histogram: {} },
    longest: [],
    shortest: [],
    short: { le3: 0, eq4: 0, le5: 0, le3Share: 0, eq4Share: 0, le5Share: 0 },
    firstChar: {},
    hyphen: { any: 0, multi: 0, anyShare: 0, multiShare: 0 },
    digit: { any: 0, startsDigit: 0, numericOnly: 0, anyShare: 0, startsDigitShare: 0, numericOnlyShare: 0, alnumMixedShare: 0 },
    idn: { count: 0, share: 0, examples: [] },
    lists: { numeric: [], hyphen: [], idn: [] },
  };
}

/**
 * Analyse the label part (before ".ch") of a list of domains. Single pass;
 * quantiles come from a length histogram so it stays O(n) even on big days.
 */
export function analyzeDomains(list) {
  if (!Array.isArray(list) || !list.length) return emptyAnalysis();

  const labels = [];
  for (const d of list) {
    const lab = typeof d === "string" ? (d.endsWith(".ch") ? d.slice(0, -3) : d) : "";
    if (lab) labels.push(lab);
  }
  const count = labels.length;
  if (!count) return emptyAnalysis();

  const hist = {};
  const firstChar = { digit: 0, other: 0 };
  for (let c = 97; c <= 122; c++) firstChar[String.fromCharCode(c)] = 0;

  let lenSum = 0, min = Infinity, max = 0;
  let le3 = 0, eq4 = 0, le5 = 0;
  let hyAny = 0, hyMulti = 0, digAny = 0, startsDigit = 0, numericOnly = 0, idn = 0;
  const idnList = [], numericList = [], hyphenList = [];

  for (const lab of labels) {
    const L = lab.length;
    lenSum += L;
    if (L < min) min = L;
    if (L > max) max = L;
    hist[L] = (hist[L] || 0) + 1;
    if (L <= 3) le3++;
    if (L === 4) eq4++;
    if (L <= 5) le5++;

    const hy = (lab.match(/-/g) || []).length;
    if (hy >= 1) { hyAny++; if (hyphenList.length < EXAMPLE_CAP) hyphenList.push(lab); }
    if (hy >= 2) hyMulti++;

    if (/[0-9]/.test(lab)) digAny++;
    const first = lab[0];
    if (first >= "0" && first <= "9") { startsDigit++; firstChar.digit++; }
    else if (first >= "a" && first <= "z") firstChar[first]++;
    else firstChar.other++;

    if (/^[0-9]+$/.test(lab)) { numericOnly++; if (numericList.length < EXAMPLE_CAP) numericList.push(lab); }
    if (lab.startsWith("xn--")) { idn++; if (idnList.length < EXAMPLE_CAP) idnList.push(lab); }
  }

  const byLen = [...labels].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const sh = (x) => x / count;

  return {
    count,
    length: {
      min,
      max,
      avg: lenSum / count,
      median: quantileFromHist(hist, count, 0.5),
      p90: quantileFromHist(hist, count, 0.9),
      histogram: hist,
    },
    longest: byLen.slice(-12).reverse(),
    shortest: byLen.slice(0, 12),
    short: { le3, eq4, le5, le3Share: sh(le3), eq4Share: sh(eq4), le5Share: sh(le5) },
    firstChar,
    hyphen: { any: hyAny, multi: hyMulti, anyShare: sh(hyAny), multiShare: sh(hyMulti) },
    digit: {
      any: digAny,
      startsDigit,
      numericOnly,
      anyShare: sh(digAny),
      startsDigitShare: sh(startsDigit),
      numericOnlyShare: sh(numericOnly),
      alnumMixedShare: sh(digAny - numericOnly),
    },
    idn: { count: idn, share: sh(idn), examples: idnList.slice(0, 12).map(decodeIdnLabel) },
    lists: { numeric: numericList, hyphen: hyphenList, idn: idnList },
  };
}

// Integer-length quantile from a histogram (lengths are small, bounded).
function quantileFromHist(hist, count, q) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const target = q * count;
  let cum = 0;
  for (const k of keys) {
    cum += hist[k];
    if (cum >= target) return k;
  }
  return keys.length ? keys[keys.length - 1] : 0;
}

/** Build the registered-vs-deregistered comparison rows for the selected day. */
export function comparison(regA, deregA) {
  return [
    { label: "Domains", reg: regA.count, dereg: deregA.count, kind: "int" },
    { label: "Median length", reg: regA.length.median, dereg: deregA.length.median, kind: "int" },
    { label: "Avg length", reg: regA.length.avg, dereg: deregA.length.avg, kind: "dec1" },
    { label: "p90 length", reg: regA.length.p90, dereg: deregA.length.p90, kind: "int" },
    { label: "Short (≤3)", reg: regA.short.le3Share, dereg: deregA.short.le3Share, kind: "pct" },
    { label: "Hyphenated", reg: regA.hyphen.anyShare, dereg: deregA.hyphen.anyShare, kind: "pct" },
    { label: "Has digit", reg: regA.digit.anyShare, dereg: deregA.digit.anyShare, kind: "pct" },
    { label: "Numeric-only", reg: regA.digit.numericOnlyShare, dereg: deregA.digit.numericOnlyShare, kind: "pct" },
    { label: "IDN", reg: regA.idn.share, dereg: deregA.idn.share, kind: "pct" },
  ];
}

function decodeIdnLabel(lab) {
  if (!lab.startsWith("xn--")) return lab;
  try {
    return punycodeToUnicode(lab.slice(4));
  } catch {
    return lab;
  }
}

/** Decode a punycode string (the part after "xn--") to Unicode — RFC 3492. */
export function punycodeToUnicode(input) {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128;
  const adapt = (delta, numPoints, firstTime) => {
    delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
  };
  const digitOf = (cp) => {
    if (cp - 48 < 10) return cp - 22; // 0-9 -> 26-35
    if (cp - 65 < 26) return cp - 65; // A-Z -> 0-25
    if (cp - 97 < 26) return cp - 97; // a-z -> 0-25
    return base;
  };

  const output = [];
  const len = input.length;
  let basic = input.lastIndexOf("-");
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) output.push(input.charCodeAt(j));

  let i = 0, n = initialN, bias = initialBias;
  let idx = basic > 0 ? basic + 1 : 0;
  while (idx < len) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (idx >= len) throw new Error("punycode: malformed");
      const digit = digitOf(input.charCodeAt(idx++));
      if (digit >= base) throw new Error("punycode: malformed");
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const outLen = output.length + 1;
    bias = adapt(i - oldi, outLen, oldi === 0);
    n += Math.floor(i / outLen);
    i %= outLen;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

// --- formatting helpers (exported where the UI needs them) ----------------

/** Locale integer, or em dash for null/undefined. */
export function fmt(n) {
  return n == null || Number.isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US");
}

/** Signed integer, e.g. +312 / −45. */
export function signed(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const r = Math.round(n);
  return (r >= 0 ? "+" : "−") + Math.abs(r).toLocaleString("en-US");
}

/** Fraction (0–1) to a percent string, e.g. 0.0247 -> "2.47%". */
export function formatPct(x, digits = 1) {
  if (x == null || Number.isNaN(x)) return "—";
  return (x * 100).toFixed(digits) + "%";
}

/** One-decimal number, e.g. 12.2. */
export function decimal(n, digits = 1) {
  return n == null || Number.isNaN(n) ? "—" : n.toFixed(digits);
}

const WEEKDAY_LONG = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
function weekdayLong(short) {
  return WEEKDAY_LONG[short] || short;
}

/** "2026-06-08" -> "Jun 8, 2026" (UTC, so the calendar date never shifts). */
export function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Weekday name in UTC, e.g. "Monday". */
export function weekday(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });
}

// internal numeric helpers
const f = (n) => Math.round(n).toLocaleString("en-US");
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
function maxBy(arr, sel) {
  let best = null;
  for (const r of arr) if (!best || sel(r) > sel(best)) best = r;
  return best;
}
function lastNonNull(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] != null) return rows[i][key];
  return null;
}
