// .ch domains dashboard — loads precomputed stats and drives a draggable timeline.
const SVGNS = "http://www.w3.org/2000/svg";

const state = {
  summary: [], // [{date, registered, deregistered, total}]
  index: 0, // selected day index
  dayCache: new Map(),
  fetchTimer: null,
};

const $ = (id) => document.getElementById(id);

function fmt(n) {
  return n == null ? "—" : n.toLocaleString("en-US");
}

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

async function init() {
  try {
    const res = await fetch("data/summary.json");
    state.summary = await res.json();
  } catch (e) {
    $("cards").textContent = "Failed to load data/summary.json";
    return;
  }
  if (!state.summary.length) return;
  state.index = state.summary.length - 1; // start on latest day

  renderCards();
  drawTrend();
  drawTimeline();
  wireTimeline();
  selectDay(state.index, true);
  window.addEventListener("resize", () => {
    drawTrend();
    drawTimeline();
    positionCursor();
  });
}

function renderCards() {
  const s = state.summary;
  const latest = s[s.length - 1];
  const sumReg = s.reduce((a, d) => a + d.registered, 0);
  const sumDereg = s.reduce((a, d) => a + d.deregistered, 0);
  const cards = [
    { label: "Total .ch domains", value: fmt(latest.total) },
    { label: `Registered (last day)`, value: "+" + fmt(latest.registered), cls: "reg" },
    { label: `Deregistered (last day)`, value: "−" + fmt(latest.deregistered), cls: "dereg" },
    { label: `Tracked days`, value: fmt(s.length) },
    { label: `Total registered`, value: "+" + fmt(sumReg), cls: "reg" },
    { label: `Total deregistered`, value: "−" + fmt(sumDereg), cls: "dereg" },
  ];
  $("cards").innerHTML = cards
    .map(
      (c) =>
        `<div class="card"><div class="label">${c.label}</div><div class="value ${
          c.cls || ""
        }">${c.value}</div></div>`
    )
    .join("");
}

// --- Trend chart: registrations & deregistrations (left axis) + total (right axis)
function drawTrend() {
  const svg = $("trend");
  const w = svg.clientWidth || 800;
  const h = svg.clientHeight || 240;
  const pad = { t: 12, r: 52, b: 22, l: 48 };
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";

  const s = state.summary;
  const n = s.length;
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r);

  const maxChange = Math.max(1, ...s.map((d) => Math.max(d.registered, d.deregistered)));
  const totals = s.map((d) => d.total).filter((t) => t != null);
  const minTotal = Math.min(...totals);
  const maxTotal = Math.max(...totals);
  const yL = (v) => pad.t + (1 - v / maxChange) * (h - pad.t - pad.b);
  const yR = (v) =>
    pad.t + (1 - (v - minTotal) / Math.max(1, maxTotal - minTotal)) * (h - pad.t - pad.b);

  // gridlines + left axis labels
  for (let g = 0; g <= 4; g++) {
    const v = (maxChange / 4) * g;
    const yy = yL(v);
    svg.appendChild(el("line", { x1: pad.l, y1: yy, x2: w - pad.r, y2: yy, stroke: "#2a323d" }));
    svg.appendChild(
      el("text", { x: pad.l - 6, y: yy + 4, "text-anchor": "end", fill: "#8b949e", "font-size": 10 },
        Math.round(v))
    );
  }

  const path = (accessor, scale, color, fill) => {
    let d = "";
    s.forEach((row, i) => {
      const val = accessor(row);
      if (val == null) return;
      d += (d ? "L" : "M") + x(i).toFixed(1) + "," + scale(val).toFixed(1) + " ";
    });
    if (fill) {
      const area = d + `L${x(n - 1).toFixed(1)},${h - pad.b} L${x(0).toFixed(1)},${h - pad.b} Z`;
      svg.appendChild(el("path", { d: area, fill: color, "fill-opacity": 0.12, stroke: "none" }));
    }
    svg.appendChild(el("path", { d, fill: "none", stroke: color, "stroke-width": 1.8 }));
  };

  path((r) => r.total, yR, "#58a6ff", false);
  path((r) => r.registered, yL, "#3fb950", true);
  path((r) => r.deregistered, yL, "#f85149", false);

  // x labels: first, middle, last
  [0, Math.floor(n / 2), n - 1].forEach((i) => {
    svg.appendChild(
      el("text", { x: x(i), y: h - 6, "text-anchor": "middle", fill: "#8b949e", "font-size": 10 },
        s[i].date.slice(5))
    );
  });
}

// --- Timeline: one bar per day (registered up, deregistered down), draggable cursor
function drawTimeline() {
  const svg = $("timeline-svg");
  const w = svg.clientWidth || 800;
  const h = svg.clientHeight || 96;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";

  const s = state.summary;
  const n = s.length;
  const mid = h / 2;
  const maxChange = Math.max(1, ...s.map((d) => Math.max(d.registered, d.deregistered)));
  const bw = Math.max(1, (w / n) * 0.7);
  const cx = (i) => (i + 0.5) * (w / n);
  const scale = (v) => (v / maxChange) * (mid - 4);

  svg.appendChild(el("line", { x1: 0, y1: mid, x2: w, y2: mid, stroke: "#2a323d" }));
  s.forEach((row, i) => {
    const rH = scale(row.registered);
    const dH = scale(row.deregistered);
    svg.appendChild(el("rect", { x: cx(i) - bw / 2, y: mid - rH, width: bw, height: rH, fill: "#3fb950" }));
    svg.appendChild(el("rect", { x: cx(i) - bw / 2, y: mid, width: bw, height: dH, fill: "#f85149" }));
  });
}

function positionCursor() {
  const tl = $("timeline");
  const n = state.summary.length;
  const w = tl.clientWidth;
  const left = ((state.index + 0.5) / n) * w;
  $("cursor").style.left = left + "px";
}

function indexFromClientX(clientX) {
  const tl = $("timeline");
  const rect = tl.getBoundingClientRect();
  const ratio = (clientX - rect.left) / rect.width;
  const n = state.summary.length;
  return Math.max(0, Math.min(n - 1, Math.round(ratio * n - 0.5)));
}

function wireTimeline() {
  const tl = $("timeline");
  let dragging = false;

  const move = (clientX) => {
    const i = indexFromClientX(clientX);
    if (i !== state.index) selectDay(i);
  };

  tl.addEventListener("pointerdown", (e) => {
    dragging = true;
    tl.setPointerCapture(e.pointerId);
    move(e.clientX);
  });
  tl.addEventListener("pointermove", (e) => {
    if (dragging) move(e.clientX);
  });
  tl.addEventListener("pointerup", () => (dragging = false));
  tl.addEventListener("pointercancel", () => (dragging = false));

  tl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      selectDay(Math.max(0, state.index - 1));
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      selectDay(Math.min(state.summary.length - 1, state.index + 1));
      e.preventDefault();
    }
  });
}

function selectDay(i, immediate = false) {
  state.index = i;
  const row = state.summary[i];
  positionCursor();
  updateAria(row);

  // Render counts immediately from summary; debounce the heavier list fetch.
  $("day-date").textContent = row.date;
  $("day-reg").textContent = fmt(row.registered);
  $("day-dereg").textContent = fmt(row.deregistered);

  clearTimeout(state.fetchTimer);
  const load = () => loadDay(row.date);
  if (immediate) load();
  else state.fetchTimer = setTimeout(load, 120);
}

function updateAria(row) {
  const tl = $("timeline");
  tl.setAttribute("aria-valuenow", state.index);
  tl.setAttribute("aria-valuetext", `${row.date}: +${row.registered} / −${row.deregistered}`);
}

async function loadDay(date) {
  let data = state.dayCache.get(date);
  if (!data) {
    try {
      const res = await fetch(`data/days/${date}.json`);
      data = await res.json();
    } catch {
      data = { date, registered: [], deregistered: [] };
    }
    state.dayCache.set(date, data);
  }
  if (state.summary[state.index].date !== date) return; // selection moved on
  renderList("list-reg", "filter-reg", data.registered);
  renderList("list-dereg", "filter-dereg", data.deregistered);
}

function renderList(listId, filterId, items) {
  const ul = $(listId);
  const filter = $(filterId);
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = q ? items.filter((d) => d.includes(q)) : items;
    if (!shown.length) {
      ul.innerHTML = `<li class="empty">${items.length ? "No matches" : "None"}</li>`;
      return;
    }
    // Cap rendered rows for very large days; filtering still searches all.
    const cap = 2000;
    ul.innerHTML = shown
      .slice(0, cap)
      .map((d) => `<li>${d}</li>`)
      .join("") + (shown.length > cap ? `<li class="empty">…${shown.length - cap} more</li>` : "");
  };
  filter.oninput = draw;
  draw();
}

init();
