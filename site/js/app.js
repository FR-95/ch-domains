// app.js — orchestration. Loads data, renders the static views (KPIs,
// observations, charts, methodology) once, and drives the interactive day
// selection (navigator, strip, charts, domain lists).
import {
  loadSummary,
  loadDay,
  loadComposition,
  deriveMetrics,
  buildObservations,
  buildDayInsights,
  activityScaleMax,
  records,
  weekdayAverages,
  dayOfMonthAverages,
  analyzeDomains,
  comparison,
  churnRate,
  fmt,
  signed,
  formatPct,
  decimal,
  prettyDate,
  weekday,
} from "./data.js";
import {
  drawActivityChart,
  drawTotalChart,
  drawActivityStrip,
  drawBarChart,
} from "./charts.js";

const $ = (id) => document.getElementById(id);

const state = {
  rows: [],
  metrics: null,
  scaleMax: 1,
  index: 0,
  fetchTimer: null,
  filters: { reg: "", dereg: "" },
  composition: null, // whole-zone baseline (or null)
  patterns: null, // { weekday, dom }
  records: null,
  dayAnalysis: null, // { date, day, regA, deregA }
};

const LIST_CAP = 800; // rows rendered at once; filtering still searches the full set

const WEEKDAY_FULL = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

init();

async function init() {
  wireTheme(); // independent of data — wire first so it works even if load fails

  try {
    state.rows = await loadSummary();
  } catch (e) {
    showFatal(`Could not load dashboard data (${e.message}).`);
    return;
  }
  if (!state.rows.length) {
    showFatal("No data available yet — the daily job has not produced any snapshots.");
    return;
  }

  state.metrics = deriveMetrics(state.rows);
  state.scaleMax = activityScaleMax(state.rows);
  state.records = records(state.rows);
  state.patterns = {
    weekday: weekdayAverages(state.rows),
    dom: dayOfMonthAverages(state.rows),
  };
  state.composition = await loadComposition(); // optional baseline
  state.index = state.rows.length - 1; // start on the latest day

  renderKpis();
  renderRecords();
  renderMetricsStrip();
  renderObservations();
  renderAllCharts();
  renderPatternCharts();
  renderZoneComposition();
  wireNavigation();

  selectDay(state.index, { immediate: true });

  window.addEventListener("resize", debounce(redrawCharts, 150));
}

// Re-render every chart (used on resize and theme change). SVG colours and
// geometry are theme/size-derived, so a full redraw is the simplest correct path.
function redrawCharts() {
  renderAllCharts();
  renderPatternCharts();
  renderZoneChart();
  renderDayCharts();
}

// --- theme -----------------------------------------------------------------

function wireTheme() {
  const btn = $("theme-toggle");
  if (!btn) return;
  const icon = btn.querySelector(".theme-icon");
  const text = btn.querySelector(".theme-text");

  const sync = () => {
    const dark = document.documentElement.dataset.theme !== "light";
    // The button advertises the action it performs (switch to the *other* theme).
    icon.textContent = dark ? "☀" : "☾";
    text.textContent = dark ? "Light" : "Dark";
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    btn.setAttribute("aria-pressed", String(!dark));
  };

  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* storage may be unavailable (private mode); theme still applies for the session */
    }
    sync();
    if (state.rows.length) redrawCharts(); // SVG colours are theme-derived
  });

  sync();
}

// --- static views ---------------------------------------------------------

function renderKpis() {
  const m = state.metrics;
  const netTone = m.netYesterday > 0 ? "pos" : m.netYesterday < 0 ? "neg" : "zero";
  const netWord = m.netYesterday > 0 ? "Net growth" : m.netYesterday < 0 ? "Net decline" : "Balanced";
  const arrow = m.netYesterday > 0 ? "▲" : m.netYesterday < 0 ? "▼" : "■";

  $("kpis").innerHTML = `
    <article class="kpi kpi--net kpi--${netTone}">
      <div class="kpi-label">Net change yesterday</div>
      <div class="kpi-value">${signed(m.netYesterday)}</div>
      <div class="kpi-foot"><span aria-hidden="true">${arrow}</span> ${netWord} · ${prettyDate(
    m.latest.date
  )}</div>
    </article>
    <article class="kpi">
      <div class="kpi-label">Total tracked domains</div>
      <div class="kpi-value">${fmt(m.totalTracked)}</div>
      <div class="kpi-foot">across the whole .ch zone</div>
    </article>
    <article class="kpi">
      <div class="kpi-label">New yesterday</div>
      <div class="kpi-value kpi-value--reg">+${fmt(m.newYesterday)}</div>
      <div class="kpi-foot">registered</div>
    </article>
    <article class="kpi">
      <div class="kpi-label">Removed yesterday</div>
      <div class="kpi-value kpi-value--dereg">−${fmt(m.removedYesterday)}</div>
      <div class="kpi-foot">deregistered</div>
    </article>`;

  $("secondary-stats").innerHTML = [
    `<span><b>${fmt(m.trackedDays)}</b> tracked days</span>`,
    `<span><b>+${fmt(m.totalRegistered)}</b> total registered</span>`,
    `<span><b>−${fmt(m.totalDeregistered)}</b> total deregistered</span>`,
  ].join("");
}

function renderObservations() {
  renderObsList("observations", buildObservations(state.metrics, state.rows));
}

function renderObsList(id, items) {
  $(id).innerHTML = items
    .map(
      (o) =>
        `<li class="obs obs--${o.tone}"><span class="obs-dot" aria-hidden="true"></span>${escapeHtml(
          o.text
        )}</li>`
    )
    .join("");
}

function renderRecords() {
  const r = state.records;
  if (!r) {
    $("records").innerHTML = '<p class="state-msg">Not enough data yet.</p>';
    return;
  }
  const card = (label, rec, valueFn, cls = "") =>
    `<div class="record ${cls}">
      <div class="record-label">${label}</div>
      <div class="record-value">${valueFn(rec.value)}</div>
      <div class="record-date">${prettyDate(rec.date)}</div>
    </div>`;
  $("records").innerHTML = [
    card("Most registrations", r.highestReg, (v) => "+" + fmt(v), "reg"),
    card("Most deregistrations", r.highestDereg, (v) => "−" + fmt(v), "dereg"),
    card("Most gross activity", r.highestActivity, (v) => fmt(v)),
    card("Biggest net growth", r.highestNetGrowth, (v) => signed(v), "reg"),
    card("Biggest net loss", r.highestNetLoss, (v) => signed(v), "dereg"),
  ].join("");
}

function renderMetricsStrip() {
  const m = state.metrics;
  const metric = (label, value) =>
    `<div class="metric"><span class="metric-label">${label}</span><span class="metric-value">${value}</span></div>`;
  $("metrics-strip").innerHTML = [
    metric("Activity (7-day avg)", fmt(m.avg7Activity)),
    metric("Net change (7-day avg)", signed(m.avg7Net)),
    metric("Churn (7-day avg)", formatPct(m.churnAvg7, 3)),
    metric("Churn (latest day)", formatPct(m.churnToday, 3)),
  ].join("");
}

function renderAllCharts() {
  const shared = {
    selectedIndex: state.index,
    onHover: null, // set per chart below
    onLeave: null,
    onSelect: (i) => selectDay(i),
  };

  drawActivityChart($("chart-activity"), state.rows, {
    ...shared,
    scaleMax: state.scaleMax,
    onHover: (i, e) => showTip("tip-activity", "chart-activity", i, e, activityTip),
    onLeave: () => hideTip("tip-activity"),
  });
  drawTotalChart($("chart-total"), state.rows, {
    ...shared,
    onHover: (i, e) => showTip("tip-total", "chart-total", i, e, totalTip),
    onLeave: () => hideTip("tip-total"),
  });
  drawActivityStrip($("strip"), state.rows, {
    ...shared,
    scaleMax: state.scaleMax,
    onHover: (i, e) => showTip("tip-strip", "strip", i, e, activityTip),
    onLeave: () => hideTip("tip-strip"),
  });
}

// --- pattern charts (weekday / day-of-month) ------------------------------

function renderPatternCharts() {
  if (!state.patterns) return;
  const wd = state.patterns.weekday;
  drawBarChart($("chart-weekday"), {
    categories: wd.map((d) => ({ label: d.label })),
    series: [
      { name: "Registered", key: "reg", data: wd.map((d) => d.regAvg) },
      { name: "Deregistered", key: "dereg", data: wd.map((d) => d.deregAvg) },
    ],
    orientation: "h",
    height: 184,
    onHover: (i, e) =>
      showHtmlTip(
        "tip-weekday",
        "chart-weekday",
        e,
        `<b>${WEEKDAY_FULL[wd[i].label] || wd[i].label}</b>
         <span class="t-reg">${fmt(wd[i].regAvg)} reg/day</span>
         <span class="t-dereg">${fmt(wd[i].deregAvg)} dereg/day</span>
         <span class="muted">${wd[i].count} days observed</span>`
      ),
    onLeave: () => hideTip("tip-weekday"),
  });

  const dom = state.patterns.dom;
  drawBarChart($("chart-dom"), {
    categories: dom.map((d) => ({ label: d.label })),
    series: [
      { name: "Registered", key: "reg", data: dom.map((d) => d.regAvg) },
      { name: "Deregistered", key: "dereg", data: dom.map((d) => d.deregAvg) },
    ],
    orientation: "v",
    height: 184,
    labelEvery: 2,
    onHover: (i, e) =>
      showHtmlTip(
        "tip-dom",
        "chart-dom",
        e,
        `<b>Day ${dom[i].label}</b>
         <span class="t-reg">${fmt(dom[i].regAvg)} reg/day</span>
         <span class="t-dereg">${fmt(dom[i].deregAvg)} dereg/day</span>
         <span class="muted">${dom[i].count} months observed</span>`
      ),
    onLeave: () => hideTip("tip-dom"),
  });
}

// --- zone composition (whole-corpus baseline) -----------------------------

function renderZoneComposition() {
  const c = state.composition;
  const panel = $("zone-panel");
  if (!c) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("zone-count").textContent = fmt(c.count);
  const share = (x) => formatPct(x / c.count, 2);
  const stat = (label, value) =>
    `<div class="metric"><span class="metric-label">${label}</span><span class="metric-value">${value}</span></div>`;
  $("zone-stats").innerHTML = [
    stat("Avg length", decimal(c.length.avg)),
    stat("Median / p90 length", `${c.length.median} / ${c.length.p90}`),
    stat("Hyphenated", share(c.hyphen.any)),
    stat("Multiple hyphens", share(c.hyphen.multi)),
    stat("Contains a digit", share(c.digit.any)),
    stat("Numeric-only", share(c.digit.numericOnly)),
    stat("IDN (xn--)", share(c.idn.count)),
    stat("Short (≤3 chars)", fmt(c.short.le3)),
  ].join("");
  renderZoneChart();
}

function renderZoneChart() {
  const c = state.composition;
  if (!c) return;
  const { categories, series } = lengthBuckets(c.length.histogram, {}, 30);
  drawBarChart($("chart-zone-length"), {
    categories,
    series: [{ name: "Domains", key: "total", data: series[0].data }],
    orientation: "v",
    height: 200,
    labelEvery: 2,
    onHover: (i, e) =>
      showHtmlTip(
        "tip-zone-length",
        "chart-zone-length",
        e,
        `<b>${categories[i].label} chars</b><span class="t-total">${fmt(series[0].data[i])} domains</span>`
      ),
    onLeave: () => hideTip("tip-zone-length"),
  });
}

// --- per-day composition --------------------------------------------------

function renderDayComposition() {
  renderCompTable();
  renderDayInsights();
  renderDayCharts();
  renderInteresting();
}

function renderCompTable() {
  const a = state.dayAnalysis;
  const body = $("comp-table").querySelector("tbody");
  if (!a) {
    body.innerHTML = "";
    return;
  }
  const cell = (v, kind) =>
    kind === "pct" ? formatPct(v, 1) : kind === "dec1" ? decimal(v) : fmt(v);
  body.innerHTML = comparison(a.regA, a.deregA)
    .map(
      (r) =>
        `<tr><th scope="row">${r.label}</th><td>${cell(r.reg, r.kind)}</td><td>${cell(
          r.dereg,
          r.kind
        )}</td></tr>`
    )
    .join("");
}

function renderDayInsights() {
  const a = state.dayAnalysis;
  renderObsList("day-insights", a ? buildDayInsights(a.day, a.regA, a.deregA) : []);
}

function renderDayCharts() {
  const a = state.dayAnalysis;
  if (!a) return;

  const lb = lengthBuckets(a.regA.length.histogram, a.deregA.length.histogram, 26);
  drawBarChart($("chart-length"), {
    categories: lb.categories,
    series: lb.series,
    orientation: "v",
    height: 180,
    labelEvery: 2,
    onHover: (i, e) =>
      showHtmlTip(
        "tip-length",
        "chart-length",
        e,
        `<b>${lb.categories[i].label} chars</b>
         <span class="t-reg">${fmt(lb.series[0].data[i])} registered</span>
         <span class="t-dereg">${fmt(lb.series[1].data[i])} deregistered</span>`
      ),
    onLeave: () => hideTip("tip-length"),
  });

  const fc = firstCharBuckets(a.regA.firstChar);
  drawBarChart($("chart-firstchar"), {
    categories: fc.categories,
    series: fc.series,
    orientation: "v",
    height: 180,
    onHover: (i, e) =>
      showHtmlTip(
        "tip-firstchar",
        "chart-firstchar",
        e,
        `<b>${fc.categories[i].full}</b><span class="t-reg">${fmt(fc.series[0].data[i])} registered</span>`
      ),
    onLeave: () => hideTip("tip-firstchar"),
  });
}

function renderInteresting() {
  const a = state.dayAnalysis;
  if (!a) {
    $("interesting").innerHTML = "";
    return;
  }
  const { regA, deregA } = a;
  const dom = (lab) => escapeHtml(lab) + ".ch";
  const group = (title, items) => {
    if (!items || !items.length) return "";
    const chips = items
      .slice(0, 8)
      .map((lab) => `<span class="idomain">${dom(lab)}</span>`)
      .join("");
    return `<div class="igroup"><div class="igroup-title">${title}</div><div class="ichips">${chips}</div></div>`;
  };
  $("interesting").innerHTML =
    [
      group("Shortest registered", regA.shortest),
      group("Longest registered", regA.longest),
      group("Shortest deregistered", deregA.shortest),
      group("Longest deregistered", deregA.longest),
      group("Numeric-only", [...regA.lists.numeric, ...deregA.lists.numeric]),
      group("IDN (decoded)", [...regA.idn.examples, ...deregA.idn.examples]),
    ].join("") || '<p class="state-msg">No domains for this day.</p>';
}

// Histogram object -> bar-chart categories/series, capping the long tail.
function lengthBuckets(histA = {}, histB = {}, cap = 26) {
  const keys = [...new Set([...Object.keys(histA), ...Object.keys(histB)])].map(Number);
  if (!keys.length) return { categories: [], series: [{ data: [] }, { data: [] }] };
  const lo = Math.max(1, Math.min(...keys));
  const maxK = Math.max(...keys);
  const hi = Math.min(cap, maxK);
  const cats = [];
  const a = [];
  const b = [];
  const countAt = (hist, L, includeAbove) => {
    let s = hist[L] || 0;
    if (includeAbove) for (const k of Object.keys(hist)) if (Number(k) > L) s += hist[k];
    return s;
  };
  for (let L = lo; L <= hi; L++) {
    const last = L === hi && maxK > hi;
    cats.push({ label: last ? `${L}+` : String(L) });
    a.push(countAt(histA, L, last));
    b.push(countAt(histB, L, last));
  }
  return {
    categories: cats,
    series: [
      { name: "Registered", key: "reg", data: a },
      { name: "Deregistered", key: "dereg", data: b },
    ],
  };
}

// First-character distribution -> a–z, then 0-9 and "other".
function firstCharBuckets(fc = {}) {
  const cats = [];
  const data = [];
  for (let c = 97; c <= 122; c++) {
    const ch = String.fromCharCode(c);
    cats.push({ label: ch, full: `Starts with "${ch}"` });
    data.push(fc[ch] || 0);
  }
  cats.push({ label: "0-9", full: "Starts with a digit" });
  data.push(fc.digit || 0);
  cats.push({ label: "·", full: "Starts with other (e.g. hyphen)" });
  data.push(fc.other || 0);
  return { categories: cats, series: [{ name: "Registered", key: "reg", data }] };
}

// --- day selection --------------------------------------------------------

function selectDay(i, { immediate = false } = {}) {
  i = Math.max(0, Math.min(state.rows.length - 1, i));
  state.index = i;
  const row = state.rows[i];

  // Cheap UI updates from the summary happen immediately…
  updateNav(row);
  updateDaySummary(row);
  redrawSelectionMarkers();

  // …the heavier per-day list fetch is debounced for smooth scrubbing.
  clearTimeout(state.fetchTimer);
  const run = () => loadAndRenderDay(row.date);
  if (immediate) run();
  else state.fetchTimer = setTimeout(run, 110);
}

function updateNav(row) {
  $("nav-date").textContent = prettyDate(row.date);
  $("nav-weekday").textContent = weekday(row.date);
  $("prev-day").disabled = state.index === 0;
  $("next-day").disabled = state.index === state.rows.length - 1;

  const strip = $("strip");
  strip.setAttribute("aria-valuemin", "0");
  strip.setAttribute("aria-valuemax", String(state.rows.length - 1));
  strip.setAttribute("aria-valuenow", String(state.index));
  strip.setAttribute(
    "aria-valuetext",
    `${prettyDate(row.date)}: +${fmt(row.registered)} registered, −${fmt(row.deregistered)} deregistered`
  );
}

function updateDaySummary(row) {
  const churn = churnRate(row);
  $("day-summary").innerHTML = `
    <span class="chip chip--reg">+${fmt(row.registered)} registered</span>
    <span class="chip chip--dereg">−${fmt(row.deregistered)} deregistered</span>
    <span class="chip chip--net">net ${signed(row.net)}</span>
    <span class="chip">activity ${fmt(row.activity)}</span>${
    churn != null ? `<span class="chip">churn ${formatPct(churn, 3)}</span>` : ""
  }${
    row.isBaseline
      ? '<span class="chip chip--note">initial snapshot — spans more than one day</span>'
      : ""
  }`;
}

// Re-render charts to move the selection band/marker without refetching.
function redrawSelectionMarkers() {
  renderAllCharts();
}

async function loadAndRenderDay(date) {
  try {
    const data = await loadDay(date);
    if (state.rows[state.index].date !== date) return; // selection moved on
    $("count-reg").textContent = fmt(data.registered.length);
    $("count-dereg").textContent = fmt(data.deregistered.length);
    renderList("reg", data.registered);
    renderList("dereg", data.deregistered);

    // Composition analysis for this day (cheap; cached for resize/theme redraws).
    state.dayAnalysis = {
      date,
      day: data,
      regA: analyzeDomains(data.registered),
      deregA: analyzeDomains(data.deregistered),
    };
    renderDayComposition();
  } catch {
    if (state.rows[state.index].date !== date) return;
    state.dayAnalysis = null;
    $("count-reg").textContent = "0";
    $("count-dereg").textContent = "0";
    $("list-reg").innerHTML = '<li class="empty">Could not load domains for this day</li>';
    $("list-dereg").innerHTML = '<li class="empty">Could not load domains for this day</li>';
    $("interesting").innerHTML = '<p class="state-msg">No details available for this day.</p>';
    $("comp-table").querySelector("tbody").innerHTML = "";
    $("day-insights").innerHTML = "";
  }
}

// --- domain lists ---------------------------------------------------------

function renderList(kind, items) {
  const ul = $(`list-${kind}`);
  const sign = kind === "reg" ? "+" : "−";
  const q = state.filters[kind];
  const shown = q ? items.filter((d) => d.includes(q)) : items;

  if (!shown.length) {
    ul.innerHTML = `<li class="empty">${items.length ? "No matches" : "None"}</li>`;
    return;
  }

  const slice = shown.slice(0, LIST_CAP);
  let html = slice
    .map(
      (d) =>
        `<li><span class="sign ${kind}" aria-hidden="true">${sign}</span><span class="name">${escapeHtml(
          d
        )}</span><button class="copy" data-domain="${escapeAttr(
          d
        )}" type="button" aria-label="Copy ${escapeAttr(d)}">copy</button></li>`
    )
    .join("");
  if (shown.length > slice.length) {
    html += `<li class="empty">…${fmt(shown.length - slice.length)} more — refine the filter to narrow down</li>`;
  }
  ul.innerHTML = html;
}

// One delegated copy listener per list; the filter re-renders from the cached
// day data (loadDay resolves instantly once the day has been fetched).
function wireLists() {
  for (const kind of ["reg", "dereg"]) {
    const filter = $(`filter-${kind}`);
    filter.addEventListener("input", async () => {
      state.filters[kind] = filter.value.trim().toLowerCase();
      const day = await loadDay(state.rows[state.index].date);
      renderList(kind, kind === "reg" ? day.registered : day.deregistered);
    });

    $(`list-${kind}`).addEventListener("click", onCopyClick);
  }
}

async function onCopyClick(e) {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const domain = btn.dataset.domain;
  try {
    await navigator.clipboard.writeText(domain);
    btn.textContent = "copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "copy";
      btn.classList.remove("copied");
    }, 1200);
  } catch {
    btn.textContent = "press ⌘C";
  }
}

// --- navigation wiring ----------------------------------------------------

function wireNavigation() {
  $("prev-day").addEventListener("click", () => selectDay(state.index - 1));
  $("next-day").addEventListener("click", () => selectDay(state.index + 1));

  $("strip").addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      selectDay(state.index - 1);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      selectDay(state.index + 1);
      e.preventDefault();
    } else if (e.key === "Home") {
      selectDay(0);
      e.preventDefault();
    } else if (e.key === "End") {
      selectDay(state.rows.length - 1);
      e.preventDefault();
    }
  });

  wireLists();
}

// --- tooltips -------------------------------------------------------------

function activityTip(row) {
  return `<b>${prettyDate(row.date)}</b>
    <span class="t-reg">+${fmt(row.registered)} registered</span>
    <span class="t-dereg">−${fmt(row.deregistered)} deregistered</span>
    <span class="t-net">net ${signed(row.net)}</span>`;
}

function totalTip(row) {
  return `<b>${prettyDate(row.date)}</b>
    <span class="t-total">${fmt(row.total)} total domains</span>`;
}

// Tooltip keyed by a day index (activity/total/strip charts).
function showTip(tipId, svgId, index, e, render) {
  const row = state.rows[index];
  if (!row) return;
  showHtmlTip(tipId, svgId, e, render(row));
}

// Tooltip with ready-made HTML (categorical charts).
function showHtmlTip(tipId, svgId, e, html) {
  const tip = $(tipId);
  tip.innerHTML = html;
  tip.hidden = false;

  const wrap = $(svgId).parentElement; // .chart-wrap (position: relative)
  const rect = wrap.getBoundingClientRect();
  const tw = tip.offsetWidth;
  let x = e.clientX - rect.left + 12;
  if (x + tw > rect.width) x = rect.width - tw - 8;
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = e.clientY - rect.top + 12 + "px";
}

function hideTip(tipId) {
  $(tipId).hidden = true;
}

// --- helpers --------------------------------------------------------------

function showFatal(msg) {
  $("kpis").innerHTML = `<p class="state-msg state-msg--error">${escapeHtml(msg)}</p>`;
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
