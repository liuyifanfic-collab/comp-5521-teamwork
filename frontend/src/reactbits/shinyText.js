// Shiny Text：移植自 React Bits (https://reactbits.dev/text-animations/shiny-text，
// 源码 github.com/DavidHDev/react-bits，MIT + Commons Clause)。
// 改动：去掉 React 外壳，改成 shinyText(el, options) 直接作用在已有元素上；
// 只保留 loop 触发（本项目用于完成 / 退款横幅），去掉 hover / followPointer。渐变与缓动计算与原版相同。

const EASINGS = {
  linear: (t) => t,
  smooth: (t) => 0.5 - Math.cos(Math.PI * t) / 2,
  snappy: (t) => (t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2),
};
const FALLOFF = [0, 0.2, 0.4, 0.6, 0.8, 1];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let paint = null;
const parseColor = (value) => {
  if (!paint) paint = document.createElement("canvas").getContext("2d");
  if (!paint) return null;
  paint.fillStyle = "#000000";
  paint.fillStyle = value;
  const resolved = String(paint.fillStyle);
  if (resolved.startsWith("#")) return [1, 3, 5].map((i) => parseInt(resolved.slice(i, i + 2), 16)).concat(1);
  const parts = resolved.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), parts.length > 3 ? Number(parts[3]) : 1];
};

const blend = (from, to, amount) => {
  const channel = (a, b) =>
    Math.round(Math.pow(Math.pow(a / 255, 2.2) * (1 - amount) + Math.pow(b / 255, 2.2) * amount, 1 / 2.2) * 255);
  const alpha = from[3] * (1 - amount) + to[3] * amount;
  if (alpha <= 0) return "rgba(0, 0, 0, 0)";
  const weigh = (a, b) => (a * from[3] * (1 - amount) + b * to[3] * amount) / alpha;
  const r = from[3] === to[3] ? channel(from[0], to[0]) : Math.round(weigh(from[0], to[0]));
  const g = from[3] === to[3] ? channel(from[1], to[1]) : Math.round(weigh(from[1], to[1]));
  const b = from[3] === to[3] ? channel(from[2], to[2]) : Math.round(weigh(from[2], to[2]));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
};

export function shinyText(
  el,
  { color = "#b5b5b5", shineColor = "#ffffff", speed = 2, delay = 0, angle = 120, shineWidth = 40, softness = 0.8, bands = 1, direction = "left", easing = "smooth", yoyo = false } = {},
) {
  const s = {
    speed: Math.max(0.1, speed),
    delay: Math.max(0, delay),
    angle,
    shineWidth: clamp(shineWidth, 2, 200),
    softness: clamp(softness, 0, 1),
    bands: clamp(Math.round(bands), 1, 3),
    sign: direction === "right" ? 1 : -1,
    ease: EASINGS[easing] ?? EASINGS.smooth,
  };
  el.classList.add("shiny-text");
  const base = parseColor(color);
  const shine = parseColor(shineColor);
  el.style.backgroundImage = `linear-gradient(${color}, ${color})`;
  if (!base || !shine || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const extent = () => s.shineWidth / 2 + (s.bands - 1) * s.shineWidth * 1.3 + 2;
  const entry = () => (s.sign > 0 ? -extent() : 100 + extent());
  const exit = () => (s.sign > 0 ? 100 + extent() : -extent());

  const gradient = (pos) => {
    const half = s.shineWidth / 2;
    const core = half * (1 - s.softness);
    const fade = half - core;
    const stops = [];
    for (let band = 0; band < s.bands; band++) {
      const center = pos - s.sign * band * s.shineWidth * 1.3;
      const strength = 1 - band * 0.28;
      for (const side of [-1, 1]) {
        for (const f of FALLOFF) stops.push([center + side * (core + fade * (1 - f)), f * f * (3 - 2 * f) * strength]);
      }
    }
    stops.sort((a, b) => a[0] - b[0]);
    const list = stops.map(([at, amount]) => `${blend(base, shine, amount)} ${at.toFixed(2)}%`);
    return `linear-gradient(${s.angle}deg, ${blend(base, shine, 0)} 0%, ${list.join(", ")}, ${blend(base, shine, 0)} 100%)`;
  };

  let flip = false;
  let from = entry();
  let to = exit();
  let start = performance.now();
  let waitUntil = 0;
  const duration = s.speed * 1000;

  const tick = (now) => {
    if (!el.isConnected) return; // 元素被移除后停止
    if (now < waitUntil) {
      el.__shinyRaf = requestAnimationFrame(tick);
      return;
    }
    const t = clamp((now - start) / duration, 0, 1);
    el.style.backgroundImage = gradient(from + (to - from) * s.ease(t));
    if (t >= 1) {
      // 一次扫光结束：等待 delay 后再扫（yoyo 时反向）
      waitUntil = now + s.delay * 1000;
      start = waitUntil;
      if (yoyo) {
        flip = !flip;
        [from, to] = flip ? [exit(), entry()] : [entry(), exit()];
      }
    }
    el.__shinyRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(el.__shinyRaf);
  el.__shinyRaf = requestAnimationFrame(tick);
}
