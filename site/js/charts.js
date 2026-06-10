// charts.js — dependency-free SVG charts.
// Each renderer clears and redraws its <svg>, sized to the element's current
// width via a 1:1 viewBox (preserveAspectRatio=none), so it stays crisp and
// responsive. Interaction (hover/click -> day index) is wired once per <svg>
// and reads geometry stashed on the element, so repeated redraws don't stack
// listeners.

const NS = "http://www.w3.org/2000/svg";

// Colours are read from CSS custom properties at draw time, so the charts
// follow the active theme (and any future theme) without code changes.
function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    reg: v("--green", "#3fb950"),
    dereg: v("--red", "#f85149"),
    total: v("--blue", "#58a6ff"),
    net: v("--net-line", "#c9d4e0"),
    grid: v("--chart-grid", "#1f2733"),
    axis: v("--chart-axis", "#243040"),
    text: v("--muted", "#8b98a7"),
    selBand: v("--chart-sel", "rgba(88,166,255,0.14)"),
    stripBar: v("--strip-bar", "#33414f"),
  };
}

function elNS(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function frame(svg, height) {
  const w = Math.max(320, Math.round(svg.clientWidth || svg.parentElement.clientWidth || 800));
  svg.setAttribute("viewBox", `0 0 ${w} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  return w;
}

// Map a pointer/keyboard interaction to a day index using stashed geometry.
function wire(svg, geom, handlers) {
  svg.__geom = geom;
  svg.__handlers = handlers;
  if (svg.__wired) return;
  svg.__wired = true;

  const indexAt = (clientX) => {
    const g = svg.__geom;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return 0;
    const x = ((clientX - rect.left) / rect.width) * g.vbWidth;
    const i = Math.floor((x - g.left) / g.step);
    return Math.max(0, Math.min(g.n - 1, i));
  };

  svg.addEventListener("pointermove", (e) => svg.__handlers.onHover?.(indexAt(e.clientX), e));
  svg.addEventListener("pointerleave", () => svg.__handlers.onLeave?.());
  svg.addEventListener("pointerdown", (e) => svg.__handlers.onSelect?.(indexAt(e.clientX), e));
}

function xTicks(svg, rows, left, step, y) {
  const COLORS = palette();
  const n = rows.length;
  const picks = n <= 1 ? [0] : [0, Math.floor(n / 2), n - 1];
  for (const i of [...new Set(picks)]) {
    const cx = left + (i + 0.5) * step;
    svg.appendChild(
      elNS(
        "text",
        { x: cx, y, "text-anchor": "middle", fill: COLORS.text, "font-size": 10 },
        rows[i].date.slice(5)
      )
    );
  }
}

/**
 * Chart A — diverging daily bars (registrations up, deregistrations down) with
 * a thin net line. opts: { selectedIndex, onHover, onLeave, onSelect, scaleMax }.
 */
export function drawActivityChart(svg, rows, opts = {}) {
  const COLORS = palette();
  const H = 280;
  const pad = { t: 14, r: 14, b: 22, l: 44 };
  const w = frame(svg, H);
  const n = rows.length;
  if (!n) return;

  const plotW = w - pad.l - pad.r;
  const step = plotW / n;
  const mid = pad.t + (H - pad.t - pad.b) / 2;
  const half = (H - pad.t - pad.b) / 2;
  const max = opts.scaleMax || 1;
  const barW = Math.max(1, step * 0.7);
  const h = (v) => Math.min(half, (Math.max(0, v) / max) * half);

  // horizontal grid + symmetric value labels (top = registrations, bottom = deregistrations)
  for (const g of [-1, -0.5, 0, 0.5, 1]) {
    const yy = mid - g * half;
    svg.appendChild(
      elNS("line", { x1: pad.l, y1: yy, x2: w - pad.r, y2: yy, stroke: g === 0 ? COLORS.axis : COLORS.grid })
    );
    svg.appendChild(
      elNS(
        "text",
        { x: pad.l - 6, y: yy + 3, "text-anchor": "end", fill: COLORS.text, "font-size": 10 },
        fmtAxis(Math.abs(g) * max)
      )
    );
  }

  // selection band
  if (opts.selectedIndex != null && rows[opts.selectedIndex]) {
    const cx = pad.l + (opts.selectedIndex + 0.5) * step;
    svg.appendChild(
      elNS("rect", { x: cx - step / 2, y: pad.t, width: step, height: H - pad.t - pad.b, fill: COLORS.selBand })
    );
  }

  // bars
  rows.forEach((r, i) => {
    const cx = pad.l + (i + 0.5) * step;
    const rh = h(r.registered);
    const dh = h(r.deregistered);
    if (rh > 0)
      svg.appendChild(elNS("rect", { x: cx - barW / 2, y: mid - rh, width: barW, height: rh, fill: COLORS.reg }));
    if (dh > 0)
      svg.appendChild(elNS("rect", { x: cx - barW / 2, y: mid, width: barW, height: dh, fill: COLORS.dereg }));
  });

  // net line (clamped to plot area)
  let d = "";
  rows.forEach((r, i) => {
    const cx = pad.l + (i + 0.5) * step;
    const y = clamp(mid - (r.net / max) * half, pad.t, H - pad.b);
    d += (d ? "L" : "M") + cx.toFixed(1) + "," + y.toFixed(1) + " ";
  });
  svg.appendChild(
    elNS("path", { d, fill: "none", stroke: COLORS.net, "stroke-width": 1.2, "stroke-opacity": 0.85 })
  );

  xTicks(svg, rows, pad.l, step, H - 6);
  wire(svg, { n, left: pad.l, step, vbWidth: w }, opts);
}

/**
 * Chart B — total tracked domains as a zoomed line + soft area.
 * opts: { selectedIndex, onHover, onLeave, onSelect }.
 */
export function drawTotalChart(svg, rows, opts = {}) {
  const COLORS = palette();
  const H = 220;
  const pad = { t: 14, r: 14, b: 22, l: 56 };
  const w = frame(svg, H);
  const n = rows.length;
  if (!n) return;

  const plotW = w - pad.l - pad.r;
  const step = plotW / n;
  const cx = (i) => pad.l + (i + 0.5) * step;

  const totals = rows.map((r) => r.total).filter((t) => t != null);
  if (!totals.length) {
    svg.appendChild(
      elNS("text", { x: w / 2, y: H / 2, "text-anchor": "middle", fill: COLORS.text, "font-size": 12 }, "No total data")
    );
    wire(svg, { n, left: pad.l, step, vbWidth: w }, opts);
    return;
  }
  let min = Math.min(...totals);
  let max = Math.max(...totals);
  if (min === max) { min -= 1; max += 1; } // avoid divide-by-zero on flat data
  const padV = (max - min) * 0.1;
  min -= padV;
  max += padV;
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  // grid + axis labels
  for (let g = 0; g <= 4; g++) {
    const v = min + ((max - min) / 4) * g;
    const yy = y(v);
    svg.appendChild(elNS("line", { x1: pad.l, y1: yy, x2: w - pad.r, y2: yy, stroke: COLORS.grid }));
    svg.appendChild(
      elNS("text", { x: pad.l - 6, y: yy + 3, "text-anchor": "end", fill: COLORS.text, "font-size": 10 }, fmtAxis(v))
    );
  }

  // selection band
  if (opts.selectedIndex != null && rows[opts.selectedIndex]) {
    const sx = cx(opts.selectedIndex);
    svg.appendChild(
      elNS("rect", { x: sx - step / 2, y: pad.t, width: step, height: H - pad.t - pad.b, fill: COLORS.selBand })
    );
  }

  // line over only the points that have a total (skip gaps cleanly)
  let line = "";
  let first = null;
  let last = null;
  rows.forEach((r, i) => {
    if (r.total == null) return;
    if (first == null) first = i;
    last = i;
    line += (line ? "L" : "M") + cx(i).toFixed(1) + "," + y(r.total).toFixed(1) + " ";
  });
  if (first != null) {
    const area =
      line + `L${cx(last).toFixed(1)},${H - pad.b} L${cx(first).toFixed(1)},${H - pad.b} Z`;
    svg.appendChild(elNS("path", { d: area, fill: COLORS.total, "fill-opacity": 0.1, stroke: "none" }));
  }
  svg.appendChild(elNS("path", { d: line, fill: "none", stroke: COLORS.total, "stroke-width": 1.8 }));

  xTicks(svg, rows, pad.l, step, H - 6);
  wire(svg, { n, left: pad.l, step, vbWidth: w }, opts);
}

/**
 * Activity strip — one slim bar per day, intensity by total activity.
 * Doubles as the day navigator. opts: { selectedIndex, scaleMax, ...handlers }.
 */
export function drawActivityStrip(svg, rows, opts = {}) {
  const COLORS = palette();
  const H = 56;
  const w = frame(svg, H);
  const n = rows.length;
  if (!n) return;

  const step = w / n;
  const barW = Math.max(1, step * 0.8);
  const max = opts.scaleMax || 1;

  rows.forEach((r, i) => {
    const cx = (i + 0.5) * step;
    const intensity = Math.min(1, r.activity / max);
    const bh = 6 + intensity * (H - 12);
    // neutral bars; the selected one is accented so colour is never the only cue
    svg.appendChild(
      elNS("rect", {
        x: cx - barW / 2,
        y: (H - bh) / 2,
        width: barW,
        height: bh,
        rx: 1,
        fill: i === opts.selectedIndex ? COLORS.total : COLORS.stripBar,
        "fill-opacity": i === opts.selectedIndex ? 1 : 0.55 + intensity * 0.45,
      })
    );
  });

  // selected marker line for an unambiguous, non-colour cue
  if (rows[opts.selectedIndex]) {
    const sx = (opts.selectedIndex + 0.5) * step;
    svg.appendChild(elNS("line", { x1: sx, y1: 0, x2: sx, y2: H, stroke: COLORS.total, "stroke-width": 1 }));
  }

  wire(svg, { n, left: 0, step, vbWidth: w }, opts);
}

/**
 * Generic categorical bar chart — 1–2 grouped series, vertical or horizontal.
 * @param {object} cfg
 *   categories: [{label}]            one slot per category
 *   series: [{name, key, data:[]}]   key ∈ reg|dereg|total|neutral (theme colour)
 *   orientation: "v" | "h"
 *   height, labelEvery, formatValue, onHover, onLeave
 */
export function drawBarChart(svg, cfg) {
  const COLORS = palette();
  const colorFor = (key) =>
    ({ reg: COLORS.reg, dereg: COLORS.dereg, total: COLORS.total, neutral: COLORS.stripBar }[key] ||
      COLORS.stripBar);

  const {
    categories,
    series,
    orientation = "v",
    height = 200,
    labelEvery = 1,
    formatValue = fmtAxis,
    onHover,
    onLeave,
  } = cfg;

  const H = height;
  const w = frame(svg, H);
  const n = categories.length;
  if (!n || !series.length) return;
  const max = Math.max(1, ...series.flatMap((s) => s.data.map((v) => v || 0)));

  if (orientation === "h") {
    const pad = { t: 6, r: 12, b: 18, l: 46 };
    const plotW = w - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const step = plotH / n;
    const x = (v) => pad.l + (v / max) * plotW;

    for (let g = 0; g <= 2; g++) {
      const v = (max / 2) * g;
      const xx = x(v);
      svg.appendChild(elNS("line", { x1: xx, y1: pad.t, x2: xx, y2: H - pad.b, stroke: COLORS.grid }));
      svg.appendChild(
        elNS("text", { x: xx, y: H - 6, "text-anchor": "middle", fill: COLORS.text, "font-size": 10 }, formatValue(v))
      );
    }
    const inner = step * 0.74;
    const gap = (step - inner) / 2;
    const bh = inner / series.length;
    categories.forEach((cat, i) => {
      const y0 = pad.t + i * step + gap;
      series.forEach((s, si) => {
        const v = s.data[i] || 0;
        svg.appendChild(
          elNS("rect", { x: pad.l, y: y0 + si * bh, width: Math.max(0, x(v) - pad.l), height: bh * 0.86, fill: colorFor(s.key), rx: 1 })
        );
      });
      svg.appendChild(
        elNS("text", { x: pad.l - 6, y: pad.t + i * step + step / 2 + 3, "text-anchor": "end", fill: COLORS.text, "font-size": 10 }, cat.label)
      );
    });
    wireHover(svg, { n, top: pad.t, step, vbHeight: H, orientation: "h" }, { onHover, onLeave });
    return;
  }

  // vertical
  const pad = { t: 10, r: 8, b: 22, l: 38 };
  const plotW = w - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const step = plotW / n;
  const y = (v) => pad.t + (1 - v / max) * plotH;

  for (let g = 0; g <= 2; g++) {
    const v = (max / 2) * g;
    const yy = y(v);
    svg.appendChild(elNS("line", { x1: pad.l, y1: yy, x2: w - pad.r, y2: yy, stroke: COLORS.grid }));
    svg.appendChild(
      elNS("text", { x: pad.l - 6, y: yy + 3, "text-anchor": "end", fill: COLORS.text, "font-size": 10 }, formatValue(v))
    );
  }
  const inner = step * 0.8;
  const gap = (step - inner) / 2;
  const bw = inner / series.length;
  categories.forEach((cat, i) => {
    const x0 = pad.l + i * step + gap;
    series.forEach((s, si) => {
      const v = s.data[i] || 0;
      const yy = y(v);
      svg.appendChild(
        elNS("rect", { x: x0 + si * bw, y: yy, width: bw * 0.88, height: Math.max(0, H - pad.b - yy), fill: colorFor(s.key), rx: 1 })
      );
    });
    if (i % labelEvery === 0) {
      svg.appendChild(
        elNS("text", { x: pad.l + i * step + step / 2, y: H - 6, "text-anchor": "middle", fill: COLORS.text, "font-size": 10 }, cat.label)
      );
    }
  });
  wireHover(svg, { n, left: pad.l, step, vbWidth: w, orientation: "v" }, { onHover, onLeave });
}

// Lightweight hover-only wiring for the categorical charts (no day selection).
function wireHover(svg, geom, handlers) {
  svg.__hgeom = geom;
  svg.__hhandlers = handlers;
  if (svg.__hwired) return;
  svg.__hwired = true;
  const idxAt = (e) => {
    const g = svg.__hgeom;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    let i;
    if (g.orientation === "h") {
      const yv = ((e.clientY - rect.top) / rect.height) * g.vbHeight;
      i = Math.floor((yv - g.top) / g.step);
    } else {
      const xv = ((e.clientX - rect.left) / rect.width) * g.vbWidth;
      i = Math.floor((xv - g.left) / g.step);
    }
    return i >= 0 && i < g.n ? i : -1;
  };
  svg.addEventListener("pointermove", (e) => {
    const i = idxAt(e);
    if (i < 0) svg.__hhandlers.onLeave?.();
    else svg.__hhandlers.onHover?.(i, e);
  });
  svg.addEventListener("pointerleave", () => svg.__hhandlers.onLeave?.());
}

// --- small helpers --------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Compact axis numbers: 2.56M, 3.1k, 980.
function fmtAxis(v) {
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (a >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(v));
}
