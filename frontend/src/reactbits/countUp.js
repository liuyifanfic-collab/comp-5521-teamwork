// Count Up：移植自 React Bits (https://reactbits.dev/text-animations/count-up，
// 源码 github.com/DavidHDev/react-bits，MIT + Commons Clause)。
// 改动：去掉 React 与 motion 依赖，只保留 count 模式；改成 countUp(el, to, options)，
// 同一元素再次调用时从当前显示值继续滚到新值（用于余额变化）。缓动与原版 easeOut 相同：cubic-bezier(0.33, 1, 0.68, 1)。

// cubic-bezier(0.33, 1, 0.68, 1) 恰好等于 easeOutCubic
const EASINGS = {
  linear: (t) => t,
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  expo: (t) => (t >= 1 ? 1 : (1 - Math.pow(2, -10 * t)) / (1 - Math.pow(2, -10))),
};

const getDecimalPlaces = (num) => {
  const str = num.toString();
  if (str.includes(".")) {
    const decimals = str.split(".")[1];
    if (parseInt(decimals) !== 0) return decimals.length;
  }
  return 0;
};

const group = (int, separator) => (separator ? int.replace(/\B(?=(\d{3})+(?!\d))/g, separator) : int);

export function countUp(el, to, { from, duration = 1.2, easing = "easeOut", separator = "", prefix = "", suffix = "", decimals } = {}) {
  const start = from ?? el.__countValue ?? 0;
  const places = decimals ?? Math.max(getDecimalPlaces(start), getDecimalPlaces(to));
  const format = (v) => {
    const fixed = Math.abs(v).toFixed(places);
    const [int, frac = ""] = fixed.split(".");
    const negative = v < 0 && Number(fixed) !== 0;
    return `${prefix}${negative ? "-" : ""}${group(int, separator)}${frac ? `.${frac}` : ""}${suffix}`;
  };

  el.style.fontVariantNumeric = "tabular-nums";
  cancelAnimationFrame(el.__countRaf);
  el.__countTarget = to;

  if (start === to || duration <= 0 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    el.__countValue = to;
    el.textContent = format(to);
    return;
  }

  const ease = EASINGS[easing] || EASINGS.easeOut;
  const t0 = performance.now();
  const total = duration * 1000;
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / total);
    const value = start + (to - start) * ease(p);
    el.__countValue = value;
    el.textContent = format(value);
    if (p < 1) el.__countRaf = requestAnimationFrame(tick);
    else el.__countValue = to;
  };
  el.__countRaf = requestAnimationFrame(tick);
}
