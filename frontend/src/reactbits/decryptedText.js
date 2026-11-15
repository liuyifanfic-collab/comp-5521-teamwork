// Decrypted Text：移植自 React Bits (https://reactbits.dev/text-animations/decrypted-text，
// 源码 github.com/DavidHDev/react-bits，MIT + Commons Clause)。
// 改动：去掉 React 与 motion 依赖，改成 decryptText(el, text, options) 直接写 DOM；
// 只保留本项目用到的"出现时解密一次"（animateOn='view'）与 scramble/fade 效果、顺序/整体两种揭示方式。
// 每个字符用"隐形原字符 + 绝对定位乱码"占位，解密过程中宽度不变（与原版相同的做法）。

const FADE_FLOOR = 0.16;
const FADE_PEAK = 0.62;
const FADE_LEAD = 6;
const SETTLE = "color 0.7s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1)";

const isSpace = (c) => /\s/.test(c);
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function decryptText(
  el,
  text,
  {
    speed = 50,
    maxIterations = 10,
    sequential = false,
    revealDirection = "start",
    characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+",
    effect = "scramble",
    scrambleColor = "",
    onDone,
  } = {},
) {
  clearInterval(el.__decryptTimer);
  const chars = Array.from(String(text ?? ""));
  const pool = Array.from(characters);
  const step = Math.max(16, speed);

  // 读屏器读完整文本；视觉层逐字符
  el.textContent = "";
  el.style.whiteSpace = "pre-wrap";
  const sr = document.createElement("span");
  sr.style.cssText = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
  sr.textContent = chars.join("");
  const visual = document.createElement("span");
  visual.setAttribute("aria-hidden", "true");
  el.append(sr, visual);

  if (reduced()) {
    visual.textContent = chars.join("");
    onDone?.();
    return;
  }

  const cells = chars.map((char) => {
    if (isSpace(char)) {
      visual.append(char);
      return null;
    }
    const cell = document.createElement("span");
    cell.style.position = "relative";
    cell.style.display = "inline-block";
    const ghost = document.createElement("span");
    ghost.style.visibility = "hidden";
    ghost.textContent = char;
    const glyph = document.createElement("span");
    glyph.style.cssText = "position:absolute;top:0;left:50%;transform:translateX(-50%)";
    cell.append(ghost, glyph);
    visual.append(cell);
    return { cell, ghost, glyph, char };
  });

  const order = cells.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (revealDirection === "end") order.reverse();
  else if (revealDirection === "center") {
    const mid = Math.floor(chars.length / 2);
    order.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  } else if (revealDirection === "random") {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  const mask = chars.map((c) => isSpace(c));
  const queue = sequential ? [...order] : [];
  let iteration = 0;
  const tinted = Boolean(scrambleColor);
  const fading = effect === "fade";

  const paint = () => {
    const ranks = sequential ? new Map(queue.map((index, rank) => [index, rank])) : null;
    const ramp = !sequential ? Math.min(1, iteration / Math.max(1, maxIterations)) : 0;
    cells.forEach((c, index) => {
      if (!c) return;
      if (mask[index]) {
        if (c.glyph.isConnected) {
          // 揭示：换回真实字符，并让颜色 / 透明度缓缓回到正常
          c.cell.textContent = c.char;
          if (tinted || fading) {
            c.cell.style.transition = SETTLE;
            c.cell.style.color = "";
            c.cell.style.opacity = "";
          }
        }
        return;
      }
      c.glyph.textContent = pool[Math.floor(Math.random() * pool.length)];
      if (tinted || fading) c.cell.style.transition = `color 0.12s linear, opacity ${step}ms linear`;
      if (tinted) c.cell.style.color = scrambleColor;
      if (fading) {
        const rank = ranks?.get(index);
        const lift = rank === undefined ? ramp : Math.max(0, 1 - rank / FADE_LEAD);
        c.cell.style.opacity = String(FADE_FLOOR + (FADE_PEAK - FADE_FLOOR) * lift);
      }
    });
  };

  paint();
  el.__decryptTimer = setInterval(() => {
    if (!el.isConnected) return clearInterval(el.__decryptTimer);
    iteration += 1;
    let done;
    if (sequential) {
      const index = queue.shift();
      if (index !== undefined) mask[index] = true;
      done = queue.length === 0;
    } else {
      done = iteration >= maxIterations;
      if (done) mask.fill(true);
    }
    paint();
    if (done) {
      clearInterval(el.__decryptTimer);
      onDone?.();
    }
  }, step);
}
