// Border Glow：移植自 React Bits (https://reactbits.dev/components/border-glow，
// 源码 github.com/DavidHDev/react-bits，MIT + Commons Clause)。
// 改动：去掉 React 外壳，改成 attachBorderGlow(el, options) 直接挂到已有元素上；
// 原版用实心背景色遮住边框内侧，这里改用 mask 只保留 1px 边框，以便用在半透明毛玻璃卡片上（见 borderGlow.css）。

function parseHSL(hslStr) {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildGlowVars(glowColor, intensity) {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const opacities = [100, 60, 50, 40, 30, 20, 10];
  const keys = ["", "-60", "-50", "-40", "-30", "-20", "-10"];
  const vars = {};
  for (let i = 0; i < opacities.length; i++) {
    vars[`--glow-color${keys[i]}`] = `hsl(${base} / ${Math.min(opacities[i] * intensity, 100)}%)`;
  }
  return vars;
}

const GRADIENT_POSITIONS = ["80% 55%", "69% 34%", "8% 6%", "41% 38%", "86% 85%", "82% 18%", "51% 4%"];
const GRADIENT_KEYS = ["--gradient-one", "--gradient-two", "--gradient-three", "--gradient-four", "--gradient-five", "--gradient-six", "--gradient-seven"];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildGradientVars(colors) {
  const vars = {};
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    vars[GRADIENT_KEYS[i]] = `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`;
  }
  vars["--gradient-base"] = `linear-gradient(${colors[0]} 0 100%)`;
  return vars;
}

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeInCubic = (x) => x * x * x;

function animateValue({ start = 0, end = 100, duration = 1000, delay = 0, ease = easeOutCubic, onUpdate, onEnd }) {
  const t0 = performance.now() + delay;
  let frame = 0;
  function tick() {
    const elapsed = performance.now() - t0;
    const t = Math.min(elapsed / duration, 1);
    onUpdate(start + (end - start) * ease(t));
    if (t < 1) frame = requestAnimationFrame(tick);
    else if (onEnd) onEnd();
  }
  const timer = setTimeout(() => {
    frame = requestAnimationFrame(tick);
  }, delay);
  return () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
  };
}

function edgeProximity(el, x, y) {
  const { width, height } = el.getBoundingClientRect();
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  let kx = Infinity;
  let ky = Infinity;
  if (dx !== 0) kx = cx / Math.abs(dx);
  if (dy !== 0) ky = cy / Math.abs(dy);
  return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
}

function cursorAngle(el, x, y) {
  const { width, height } = el.getBoundingClientRect();
  const dx = x - width / 2;
  const dy = y - height / 2;
  if (dx === 0 && dy === 0) return 0;
  let degrees = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
  if (degrees < 0) degrees += 360;
  return degrees;
}

export function attachBorderGlow(
  el,
  {
    edgeSensitivity = 30,
    glowColor = "40 80 80",
    glowRadius = 40,
    glowIntensity = 1.0,
    coneSpread = 25,
    colors = ["#c084fc", "#f472b6", "#38bdf8"],
    fillOpacity = 0.5,
  } = {},
) {
  if (el.__borderGlow) return el.__borderGlow;
  el.classList.add("border-glow-card");
  const vars = {
    "--edge-sensitivity": edgeSensitivity,
    "--glow-padding": `${glowRadius}px`,
    "--cone-spread": coneSpread,
    "--fill-opacity": fillOpacity,
    ...buildGlowVars(glowColor, glowIntensity),
    ...buildGradientVars(colors),
  };
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, String(v));

  const light = document.createElement("span");
  light.className = "edge-light";
  el.prepend(light);

  el.addEventListener("pointermove", (e) => {
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.setProperty("--edge-proximity", (edgeProximity(el, x, y) * 100).toFixed(3));
    el.style.setProperty("--cursor-angle", `${cursorAngle(el, x, y).toFixed(3)}deg`);
  });

  let cancels = [];
  // 原版 animated=true 时的一次性扫光：用于"当前步骤"切换时吸引注意
  const sweep = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    cancels.forEach((c) => c());
    const angleStart = 110;
    const angleEnd = 465;
    el.classList.add("sweep-active");
    el.style.setProperty("--cursor-angle", `${angleStart}deg`);
    const setAngle = (v) => el.style.setProperty("--cursor-angle", `${(angleEnd - angleStart) * (v / 100) + angleStart}deg`);
    cancels = [
      animateValue({ duration: 500, onUpdate: (v) => el.style.setProperty("--edge-proximity", v) }),
      animateValue({ ease: easeInCubic, duration: 1500, end: 50, onUpdate: setAngle }),
      animateValue({ ease: easeOutCubic, delay: 1500, duration: 2250, start: 50, end: 100, onUpdate: setAngle }),
      animateValue({
        ease: easeInCubic,
        delay: 2500,
        duration: 1500,
        start: 100,
        end: 0,
        onUpdate: (v) => el.style.setProperty("--edge-proximity", v),
        onEnd: () => el.classList.remove("sweep-active"),
      }),
    ];
  };

  el.__borderGlow = { sweep };
  return el.__borderGlow;
}
