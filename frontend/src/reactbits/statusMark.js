// Status Mark：移植自 React Bits (https://reactbits.dev/micro/status-mark，
// 源码 github.com/DavidHDev/react-bits，MIT + Commons Clause)。
// 改动：去掉 React 与 motion 依赖，改成 createStatusMark(options) 返回 { el, set(status) }；
// motion 的 mode/arc/travel 三个动画值改为手写 rAF 补间（形变 0.3s、easeInOut [0.77,0,0.175,1]；转圈线性 1.1s）。
// 状态：pending（虚线空心圈）→ running（转动的弧）→ done（实心圈 + 画出对勾）/ failed（画出叉）。

const MORPH_MS = 300;
const UI_MS = 300;
const CHECK = "M7.5 12.25 10.5 15.25 16.75 8.75";
const CROSS = "M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5";
const IDLE_DASH = 0.3;
const SVG = "http://www.w3.org/2000/svg";

// cubic-bezier(0.77, 0, 0.175, 1) 的近似（easeInOutQuart 足够接近）
const easeInOut = (t) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function createStatusMark({
  status = "pending",
  color = "currentColor",
  doneColor = "#22c55e",
  errorColor = "#ef4444",
  size = 20,
  strokeWidth = 2,
  dashes = 8,
  spinDuration = 1100,
  arcLength = 0.68,
  drawDuration = 240,
  fillOpacity = 0.06,
} = {}) {
  const r = 10 - strokeWidth / 2;
  const C = 2 * Math.PI * r;
  const P = C / Math.max(1, dashes);

  const el = document.createElement("span");
  el.className = "status-mark";
  el.style.setProperty("--sm-size", `${size}px`);
  el.style.setProperty("--sm-stroke", strokeWidth);
  el.style.setProperty("--sm-color", color);
  el.style.setProperty("--sm-done", doneColor);
  el.style.setProperty("--sm-error", errorColor);
  el.style.setProperty("--sm-fill", fillOpacity);
  el.style.setProperty("--sm-draw", `${drawDuration}ms`);

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "status-mark__glyph");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  const circle = (cls) => {
    const c = document.createElementNS(SVG, "circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", "12");
    c.setAttribute("cy", "12");
    c.setAttribute("r", r);
    c.setAttribute("transform", "rotate(-90 12 12)");
    return c;
  };
  const path = (cls, d) => {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("class", cls);
    p.setAttribute("d", d);
    p.setAttribute("pathLength", "1");
    return p;
  };
  const ring = circle("status-mark__ring");
  svg.append(circle("status-mark__track"), ring, path("status-mark__check", CHECK), path("status-mark__cross", CROSS));
  el.append(svg);

  // 三个动画量：mode（0 虚线 → 1 实线）、arc（弧长比例）、travel（dashoffset，转圈用）
  const v = { mode: 0, arc: 1, travel: 0 };
  const tweens = {};
  const writeDash = () => {
    const dash = IDLE_DASH * P + (v.arc * C - IDLE_DASH * P) * v.mode;
    const gap = (1 - IDLE_DASH) * P + ((1 - v.arc) * C - (1 - IDLE_DASH) * P) * v.mode;
    ring.setAttribute("stroke-dasharray", `${Math.max(0, dash)} ${Math.max(0, gap)}`);
    ring.setAttribute("stroke-dashoffset", String(v.travel));
  };
  const tween = (key, to, ms, ease, { repeatFrom } = {}) => {
    cancelAnimationFrame(tweens[key]);
    const from = repeatFrom ?? v[key];
    const t0 = performance.now();
    const step = (now) => {
      let p = ms > 0 ? (now - t0) / ms : 1;
      if (repeatFrom !== undefined) p %= 1; // 无限循环（转圈）
      else p = Math.min(1, p);
      v[key] = from + (to - from) * ease(p);
      writeDash();
      if (repeatFrom !== undefined || p < 1) tweens[key] = requestAnimationFrame(step);
      else return;
    };
    tweens[key] = requestAnimationFrame(step);
  };

  let current = null;
  const set = (next) => {
    if (next === current) return;
    current = next;
    el.dataset.status = next;
    const running = next === "running";
    const solid = running || next === "done" || next === "failed";
    const targetArc = running ? arcLength : 1;
    if (running) el.dataset.indeterminate = "";
    else delete el.dataset.indeterminate;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      Object.values(tweens).forEach(cancelAnimationFrame);
      Object.assign(v, { mode: solid ? 1 : 0, arc: targetArc, travel: 0 });
      writeDash();
      return;
    }
    if (v.mode === 0) v.arc = targetArc;
    tween("mode", solid ? 1 : 0, MORPH_MS, easeInOut);
    tween("arc", targetArc, UI_MS, easeOut);
    if (running) tween("travel", v.travel - C, spinDuration, (t) => t, { repeatFrom: v.travel });
    else tween("travel", Math.floor(v.travel / P) * P, UI_MS, easeOut);
  };

  writeDash();
  set(status);
  return { el, set };
}

