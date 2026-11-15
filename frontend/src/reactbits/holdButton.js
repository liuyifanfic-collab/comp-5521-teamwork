// Hold Button：移植自 React Bits (https://reactbits.dev/micro/hold-button，
// 源码 github.com/DavidHDev/react-bits，MIT + Commons Clause)。
// 改动：去掉 React 外壳，改成 createHoldButton(options) 返回 { el, setDisabled, isHolding }；
// 交互逻辑（按住填充、松手回退、拖出取消、键盘空格 / 回车长按、完成后脉冲）与原版相同，没有图标。

const TAP_MS = 250;
const HIT_PAD = 10;
const LINEAR = (t) => t;
const EASE_OUT = (t) => 1 - Math.pow(1 - t, 3);

export function createHoldButton({
  label = "Hold to delete",
  doneLabel = "Deleted",
  hint = "",
  backgroundColor = "#27272a",
  fillColor = "#5227FF",
  textColor = "#f5f5f5",
  fillTextColor = "#ffffff",
  size = "md",
  radius = 14,
  holdTime = 2000,
  releaseTime = 200,
  pressScale = 0.97,
  wave = true,
  waveAmplitude = 6,
  glow = true,
  resetAfter = 1200,
  disabled = false,
  onHold,
  onTap,
  className = "",
} = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = disabled;
  button.className = `hold-button hold-button--${size}${className ? ` ${className}` : ""}`;
  button.dataset.phase = "idle";
  button.dataset.direction = "right";
  if (glow) button.dataset.glow = "true";
  const vars = {
    "--hb-radius": `${radius}px`,
    "--hb-bg": backgroundColor,
    "--hb-fill": fillColor,
    "--hb-text": textColor,
    "--hb-fill-text": fillTextColor,
    "--hb-hold": `${holdTime}ms`,
    "--hb-cycles": holdTime / 1100,
    "--hb-release": `${releaseTime}ms`,
    "--hb-press": pressScale,
    "--hb-wave": `${wave ? waveAmplitude : 0}px`,
  };
  for (const [k, v] of Object.entries(vars)) button.style.setProperty(k, String(v));

  const labels = () => {
    const wrap = document.createElement("span");
    wrap.className = "hold-button__label";
    const idle = document.createElement("span");
    idle.className = "hold-button__idle";
    idle.textContent = label;
    const done = document.createElement("span");
    done.className = "hold-button__done";
    done.textContent = doneLabel;
    wrap.append(idle, done);
    return wrap;
  };
  const pulse = document.createElement("span");
  pulse.className = "hold-button__pulse";
  pulse.setAttribute("aria-hidden", "true");
  const clip = document.createElement("span");
  clip.className = "hold-button__clip";
  clip.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.className = "hold-button__fill";
  const fillLabel = labels();
  fillLabel.classList.add("hold-button__label--fill");
  fill.append(fillLabel);
  const crest = document.createElement("span");
  crest.className = "hold-button__crest";
  const crestLabel = labels();
  crestLabel.classList.add("hold-button__label--fill");
  crest.append(crestLabel);
  clip.append(fill, crest);
  const sr = document.createElement("span");
  sr.className = "hold-button__sr";
  sr.textContent = hint;
  button.append(pulse, labels(), clip, sr);

  let phase = "idle";
  let input = null;
  const gesture = { pointerId: null, start: 0, rect: null };
  const timers = { complete: 0, reset: 0 };
  const motion = { raf: 0, p: 0, from: 0, to: 0, start: 0 };

  const go = (next, kind = null) => {
    phase = next;
    input = kind;
    button.dataset.phase = next;
    if (kind) button.dataset.input = kind;
    else delete button.dataset.input;
  };
  const clearTimers = () => {
    clearTimeout(timers.complete);
    clearTimeout(timers.reset);
  };
  const drive = (to, duration, ease) => {
    cancelAnimationFrame(motion.raf);
    motion.from = motion.p;
    motion.to = to;
    motion.start = performance.now();
    const step = (now) => {
      const t = duration > 0 ? Math.min(1, (now - motion.start) / duration) : 1;
      motion.p = motion.from + (motion.to - motion.from) * ease(t);
      button.style.setProperty("--hb-p", motion.p.toFixed(4));
      if (t < 1) {
        motion.raf = requestAnimationFrame(step);
        return;
      }
      motion.raf = 0;
      if (motion.to === 1) complete();
    };
    motion.raf = requestAnimationFrame(step);
  };
  const complete = () => {
    if (phase !== "holding") return;
    if (performance.now() - gesture.start < holdTime - 50) return;
    clearTimers();
    go("done", input);
    onHold?.();
    if (resetAfter > 0) {
      timers.reset = setTimeout(() => {
        go("idle");
        drive(0, releaseTime, EASE_OUT);
      }, resetAfter);
    }
  };
  const begin = (kind) => {
    if (button.disabled || phase !== "idle") return false;
    gesture.start = performance.now();
    gesture.rect = button.getBoundingClientRect();
    go("holding", kind);
    drive(1, holdTime, LINEAR);
    timers.complete = setTimeout(complete, holdTime + 100);
    return true;
  };
  const release = ({ drifted = false } = {}) => {
    if (phase !== "holding") return;
    clearTimers();
    const held = performance.now() - gesture.start;
    go("idle");
    drive(0, releaseTime, EASE_OUT);
    if (!drifted && held < TAP_MS) onTap?.();
  };
  const endPointer = (e, options) => {
    if (e.pointerId !== gesture.pointerId) return;
    gesture.pointerId = null;
    try {
      if (button.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放 */
    }
    release(options);
  };

  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary || gesture.pointerId !== null) return;
    if (!begin("pointer")) return;
    gesture.pointerId = e.pointerId;
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持时忽略 */
    }
  });
  button.addEventListener("pointermove", (e) => {
    if (e.pointerId !== gesture.pointerId || !gesture.rect) return;
    const r = gesture.rect;
    const out = e.clientX < r.left - HIT_PAD || e.clientX > r.right + HIT_PAD || e.clientY < r.top - HIT_PAD || e.clientY > r.bottom + HIT_PAD;
    if (out) endPointer(e, { drifted: true });
  });
  button.addEventListener("pointerup", (e) => endPointer(e));
  button.addEventListener("pointercancel", (e) => endPointer(e, { drifted: true }));
  button.addEventListener("lostpointercapture", (e) => endPointer(e, { drifted: true }));
  button.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "touch") endPointer(e, { drifted: true });
  });
  button.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (input === "key") release({ drifted: true });
      return;
    }
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) begin("key");
    }
  });
  button.addEventListener("keyup", (e) => {
    if ((e.key === " " || e.key === "Enter") && input === "key") {
      e.preventDefault();
      release();
    }
  });
  button.addEventListener("contextmenu", (e) => e.preventDefault());
  // 窗口失焦时取消按住；按钮被移出页面后顺带解除监听，避免反复重建时泄漏
  const cancel = () => {
    if (!button.isConnected) return window.removeEventListener("blur", cancel);
    release({ drifted: true });
  };
  window.addEventListener("blur", cancel);

  const measure = () => {
    button.style.setProperty("--hb-w", `${button.offsetWidth}px`);
    button.style.setProperty("--hb-h", `${button.offsetHeight}px`);
  };
  new ResizeObserver(measure).observe(button);

  return {
    el: button,
    setDisabled: (d) => (button.disabled = d),
    isHolding: () => phase === "holding",
  };
}
