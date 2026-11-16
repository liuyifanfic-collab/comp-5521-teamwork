// 页面逻辑：钱包、余额、引导式交换流程、双链状态监控、交易反馈。
import { Contract, formatEther, formatUnits, isAddress, isHexString, parseEther, parseUnits } from "ethers";
import { config, devWalletEnabled, SAFETY_GAP_SECONDS } from "./config.js";
import { erc20Abi, erc20HtlcAbi, ethHtlcAbi, readContracts, readProviders } from "./contracts.js";
import { decodeError } from "./errors.js";
import { attachBorderGlow } from "./reactbits/borderGlow.js";
import { mountDarkVeil } from "./reactbits/darkVeil.js";
import "./reactbits/darkVeil.css";
import { countUp } from "./reactbits/countUp.js";
import { decryptText } from "./reactbits/decryptedText.js";
import { createHoldButton } from "./reactbits/holdButton.js";
import { shinyText } from "./reactbits/shinyText.js";
import { createStatusMark } from "./reactbits/statusMark.js";
import "./reactbits/borderGlow.css";
import "./reactbits/holdButton.css";
import "./reactbits/shinyText.css";
import "./reactbits/statusMark.css";
import { applyStatic, chainName, getLang, lazy, onLangChange, setLang, t, timeLocale } from "./i18n.js";
import {
  STATUS,
  deriveState,
  findRevealedSecret,
  hashlockOf,
  newSecret,
  readSwap,
  sameAddr,
  swapIdFromReceipt,
  verifyEthLock,
  verifyMstLock,
} from "./protocol.js";
import { chainLabel, connectWallet, getInjected, onWalletChange, signerOn, switchChain, wallet } from "./wallet.js";

const MST = config.mstChain;
const ETH = config.ethChain;
const $ = (sel) => document.querySelector(sel);

// ---------- 本地会话（swapId、secret 等链下信息） ----------
const SESSION_KEY = `htlc-session-${config.profile}`;
function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || {};
  } catch {
    return {};
  }
}
const state = {
  role: localStorage.getItem("htlc-role") || "alice",
  session: loadSession(),
  swaps: { mst: null, eth: null },
  checks: { mst: null, eth: null },
  balances: null,
  decimals: 18,
  txs: [],
  busy: false,
};
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
  } catch {
    /* 隐私模式下忽略 */
  }
}

// ---------- 格式化 ----------
const short = (x) => (x ? `${x.slice(0, 6)}…${x.slice(-4)}` : "—");
const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString(timeLocale()) : "—");
const clock = (d = new Date()) => d.toLocaleTimeString(timeLocale());
function fmtCountdown(sec) {
  if (sec <= 0) return t("time.expiredFor", { d: fmtDur(-sec) });
  return t("time.remaining", { d: fmtDur(sec) });
}
function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? t("time.ms", { m, s: String(s).padStart(2, "0") }) : t("time.s", { s });
}
const fmtMst = (v) => (v == null ? "—" : `${formatUnits(v, state.decimals)} MST`);
// 显示最多 6 位小数，避免余额被长尾小数撑开
function trimDecimals(s, n = 6) {
  const [i, f = ""] = s.split(".");
  const t = f.slice(0, n).replace(/0+$/, "");
  return t ? `${i}.${t}` : i;
}
const fmtEth = (v) => (v == null ? "—" : `${trimDecimals(formatEther(v))} ETH`);
function txLink(chain, hash) {
  if (!hash) return "";
  if (!chain.explorer) return `<code title="${hash}">${short(hash)}</code> <span class="muted small">${t("tx.noExplorer")}</span>`;
  return `<a href="${chain.explorer}/tx/${hash}" target="_blank" rel="noopener">${short(hash)} ↗</a>`;
}
function addrLink(chain, addr) {
  if (!chain.explorer) return `<code title="${addr}">${short(addr)}</code>`;
  return `<a href="${chain.explorer}/address/${addr}" target="_blank" rel="noopener" title="${addr}"><code>${short(addr)}</code> ↗</a>`;
}
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 5000);
}

// ---------- 交易执行 + 反馈 ----------
// ---------- 交易执行 + 反馈 ----------
async function runTx(label, chain, send) {
  const entry = {
    label,
    chain,
    status: "pending",
    phase: "pending",
    text: lazy("tx.waitSign"),
    time: new Date(),
  };
  state.txs.unshift(entry);
  state.busy = true;
  renderLog();
  renderDynamic();

  try {
    // 1) 等用户签名并广播
    const tx = await send();
    Object.assign(entry, { hash: tx.hash, phase: "running", text: lazy("tx.broadcast") });
    renderLog();

    // 2) 等上链确认
    const receipt = await tx.wait();
    Object.assign(entry, {
      status: "ok",
      phase: "done",
      text: lazy("tx.confirmed", { block: receipt.blockNumber }),
    });
    return receipt;
  } catch (err) {
    const { text } = decodeError(err);
    Object.assign(entry, { status: "fail", phase: "failed", text: lazy("tx.failed"), error: text });
    toast(t("tx.failedToast", { label, err: text }));
    return null;
  } finally {
    state.busy = false;
    renderLog();
    await refresh();
  }
}

// 交易记录：每条交易一个持久的 <li>（不整块重建），这样 Status Mark 能从"等待签名"平滑过渡到"已确认"
const MARK_COLORS = { color: "#bfdbfe", doneColor: "#6ee7b7", errorColor: "#fca5a5", size: 16 };
function renderLog() {
  const list = $("#tx-log");
  const empty = list.querySelector(".tx-empty");
  if (!state.txs.length) {
    if (!empty) list.innerHTML = `<li class="tx-empty muted"></li>`;
    list.querySelector(".tx-empty").textContent = t("tx.none");
    return;
  }
  empty?.remove();
  // state.txs 新的在前：倒序遍历，新条目插到最前
  for (let i = state.txs.length - 1; i >= 0; i--) {
    const x = state.txs[i];
    if (!x.dom) {
      const li = document.createElement("li");
      const mark = createStatusMark({ ...MARK_COLORS, status: x.phase });
      const body = document.createElement("div");
      body.className = "tx-body";
      li.append(mark.el, body);
      list.prepend(li);
      x.dom = { li, mark, body };
    }
    x.dom.li.className = x.status;
    x.dom.mark.set(x.phase);
    x.dom.body.innerHTML = `
      <div><strong>${x.label}</strong> · <span class="muted small">${chainName(x.chain)} · ${clock(x.time)}</span></div>
      <div>${x.text} ${txLink(x.chain, x.hash)}</div>
      ${x.error ? `<div class="err">${x.error}</div>` : ""}`;
  }
}

// ---------- 合约写操作 ----------
async function htlcOn(chain) {
  const signer = await signerOn(chain);
  return chain === MST ? new Contract(MST.htlc, erc20HtlcAbi, signer) : new Contract(ETH.htlc, ethHtlcAbi, signer);
}

const actions = {
  async connect() {
    await connectWallet();
    await refresh();
  },

  generateSecret() {
    const secret = newSecret();
    state.session = { ...state.session, secret, hashlock: hashlockOf(secret) };
    saveSession();
    renderDynamic();
  },

  async approve() {
    const amount = parseUnits($("#a-amount").value || "0", state.decimals);

    const signer = await signerOn(MST);
    const mst = new Contract(MST.mst, erc20Abi, signer);

    await runTx(
      lazy("tx.approve", { amount: fmtMst(amount) }),
      MST,
      () => mst.approve(MST.htlc, amount),
    );
  },

  async lockMst() {
    const { hashlock } = state.session;
    const recipient = $("#a-bob").value.trim();
    const amount = parseUnits($("#a-amount").value || "0", state.decimals);
    const minutes = Number($("#a-t1").value);

    // T1 基于链上最新区块时间，而不是本地时间，和合约判断过期用的是同一个时钟
    const { timestamp: now } = await readProviders.mst.getBlock("latest");
    const t1 = now + Math.round(minutes * 60);

    const htlc = await htlcOn(MST);
    const receipt = await runTx(
      lazy("tx.lockMst", { amount: fmtMst(amount), time: fmtTime(t1) }),
      MST,
      () => htlc.lock(MST.mst, recipient, amount, hashlock, t1),
    );
    if (!receipt) return; // 用户取消或交易失败：不更新 session

    state.session.mstSwapId = swapIdFromReceipt(htlc, receipt);
    saveSession();
    await refresh();
  },

  async verifyMst() {
    const id = $("#b-mst-id").value.trim();
    const expected = $("#b-expect-mst").value ? parseUnits($("#b-expect-mst").value, state.decimals) : null;
    state.session.mstSwapId = id;
    saveSession();
    const swap = await readSwap("mst", id);
    state.swaps.mst = swap;
    state.checks.mst = verifyMstLock(swap, { me: wallet.account, expectedAmount: expected });
    state.session.mstVerified = state.checks.mst.every((c) => c.ok);
    saveSession();
    renderDynamic();
  },

  async lockEth() {
    const mstSwap = await readSwap("mst", state.session.mstSwapId);
    const amount = parseEther($("#b-amount").value || "0");
    const minutes = Number($("#b-t2").value);

    // T2 基于 ETH 链最新区块时间
    const { timestamp: now } = await readProviders.eth.getBlock("latest");
    const t2 = now + Math.round(minutes * 60);

    // T2 必须比 T1 至少早 SAFETY_GAP_SECONDS，否则 Alice 揭示 secret 后 Bob 来不及去 MST 链领取
    if (t2 + SAFETY_GAP_SECONDS > mstSwap.timelock) {
      toast(t("toast.t2Order", { gap: SAFETY_GAP_SECONDS, t2: fmtTime(t2), t1: fmtTime(mstSwap.timelock) }));
      return;
    }

    const htlc = await htlcOn(ETH);
    const receipt = await runTx(
      lazy("tx.lockEth", { amount: fmtEth(amount), time: fmtTime(t2) }),
      ETH,
      () => htlc.lock(mstSwap.sender, mstSwap.hashlock, t2, { value: amount }),
    );
    if (!receipt) return; // 用户取消或交易失败：不更新 session

    state.session.ethSwapId = swapIdFromReceipt(htlc, receipt);
    saveSession();
    await refresh();
  },

  async verifyEth() {
    const id = $("#a-eth-id").value.trim();
    const expected = $("#a-expect-eth").value ? parseEther($("#a-expect-eth").value) : null;
    state.session.ethSwapId = id;
    saveSession();
    const [ethSwap, mstSwap] = await Promise.all([readSwap("eth", id), readSwap("mst", state.session.mstSwapId)]);
    state.swaps.eth = ethSwap;
    state.checks.eth = verifyEthLock(ethSwap, {
      me: wallet.account,
      hashlock: state.session.hashlock,
      mstTimelock: mstSwap.timelock,
      expectedAmount: expected,
    });
    state.session.ethVerified = state.checks.eth.every((c) => c.ok);
    saveSession();
    renderDynamic();
  },

  async fetchSecret() {
    const found = await findRevealedSecret("eth", state.session.ethSwapId);
    if (!found) return toast(t("toast.noClaimYet"));
    const mstSwap = await readSwap("mst", state.session.mstSwapId);
    if (hashlockOf(found.secret) !== mstSwap.hashlock) return toast(t("toast.secretMismatch"));
    state.session.revealedSecret = found.secret;
    state.session.revealTx = found.txHash;
    saveSession();
    renderDynamic();
  },

  async claim(side, secret) {
    const isMst = side === "mst";
    const chain = isMst ? MST : ETH;
    const id = isMst ? state.session.mstSwapId : state.session.ethSwapId;

    if (!isHexString(secret, 32)) return toast(t("toast.badSecret"));

    const htlc = await htlcOn(chain);
    await runTx(
      { toString: () => t("tx.claim", { chain: chainName(chain) }) },
      chain,
      () => htlc.claim(id, secret),
    );
  },

  async refund(side) {
    const isMst = side === "mst";
    const chain = isMst ? MST : ETH;
    const id = isMst ? state.session.mstSwapId : state.session.ethSwapId;

    const htlc = await htlcOn(chain);
    await runTx(
      { toString: () => t("tx.refund", { chain: chainName(chain) }) },
      chain,
      () => htlc.refund(id),
    );
  },

  reset() {
    if (!confirm(t("confirm.reset"))) return;
    state.session = {};
    state.swaps = { mst: null, eth: null };
    state.checks = { mst: null, eth: null };
    saveSession();
    renderSteps();
    renderDynamic();
  },
};

// 包一层：统一捕获非交易类错误（RPC、输入格式等）
function bind(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(decodeError(err).text);
      console.error(err);
    }
  };
}

// ---------- 读链 ----------
async function refresh() {
  const { mst } = readContracts();
  const s = state.session;
  try {
    const tasks = [
      s.mstSwapId ? readSwap("mst", s.mstSwapId) : null,
      s.ethSwapId ? readSwap("eth", s.ethSwapId) : null,
    ];
    if (wallet.account) {
      tasks.push(
        Promise.all([
          mst.balanceOf(wallet.account),
          mst.allowance(wallet.account, MST.htlc),
          readProviders.mst.getBalance(wallet.account),
          readProviders.eth.getBalance(wallet.account),
        ]),
      );
    }
    const [mstSwap, ethSwap, bal] = await Promise.all(tasks);
    state.swaps.mst = mstSwap;
    state.swaps.eth = ethSwap;
    if (bal) state.balances = { mst: bal[0], allowance: bal[1], ethOnMst: bal[2], ethOnEth: bal[3] };

    // Bob：ETH 锁被领取后，自动从 Claimed 事件读出 secret
    const ethClaimed = ethSwap?.status === 2;
    const needSecret = state.role === "bob" && ethClaimed && !s.revealedSecret;
    if (needSecret) await actions.fetchSecret();

    $("#last-refresh").textContent = t("refresh.at", { time: clock() });
  } catch (err) {
    $("#last-refresh").textContent = t("refresh.fail", { err: decodeError(err).text });
  }
  renderDynamic();
}

// ---------- 静态部分：流程步骤（只在切换角色时重建，避免轮询覆盖输入） ----------
function stepBox(id, title, body) {
  return `<div class="step" id="${id}"><div class="step-head"><h3>${title}</h3><span class="step-status"></span></div>${body}</div>`;
}

function renderSteps() {
  document.querySelectorAll(".tab[data-role]").forEach((el) => el.classList.toggle("active", el.dataset.role === state.role));
  // 重建前记下已输入的值（切换语言时也会重建），重建后填回
  const typed = {};
  document.querySelectorAll("#steps input[id]").forEach((el) => (typed[el.id] = el.value));
  const s = state.session;
  const bobDefault = config.testAccounts?.bob || "";
  const html =
    state.role === "alice"
      ? [
          stepBox(
            "st-a1",
            t("a1.title"),
            `<p>${t("a1.desc")}</p>
             <div class="row"><button class="btn" id="a-gen">${t("a1.btn")}</button></div>
             <div id="a-secret-view" class="small"></div>`,
          ),
          stepBox(
            "st-a2",
            t("a2.title", { chain: chainName(MST) }),
            `<div class="row">
               <div class="field"><label>${t("a2.bob")}</label><input id="a-bob" class="mono" value="${bobDefault}" placeholder="0x…" /></div>
             </div>
             <div class="row">
               <div class="field"><label>${t("a2.amount")}</label><input id="a-amount" type="number" min="0" step="any" value="10" /></div>
               <div class="field"><label>${t("a2.t1")}</label><input id="a-t1" type="number" min="1" step="any" value="${config.profile === "local" ? 4 : 10}" /></div>
             </div>
             <div class="row"><button class="btn" id="a-approve">${t("a2.approve")}</button><button class="btn primary" id="a-lock">${t("a2.lock")}</button></div>
             <div id="a-lock-hint" class="hint"></div>`,
          ),
          stepBox(
            "st-a3",
            t("a3.title", { chain: chainName(ETH) }),
            `<p>${t("a3.desc")}</p>
             <div class="row">
               <div class="field"><label>ETH swapId</label><input id="a-eth-id" class="mono" value="${s.ethSwapId || ""}" placeholder="0x…" /></div>
             </div>
             <div class="row">
               <div class="field"><label>${t("a3.expect")}</label><input id="a-expect-eth" type="number" step="any" placeholder="${t("a3.placeholder")}" /></div>
               <button class="btn" id="a-verify">${t("verify.btn")}</button>
             </div>
             <ul id="a-checks" class="checklist"></ul>`,
          ),
          stepBox(
            "st-a4",
            t("a4.title"),
            `<p>${t("a4.desc", { chain: chainName(ETH) })}</p>
             <div class="row"><button class="btn primary" id="a-claim">${t("a4.btn")}</button></div>
             <div id="a-claim-hint" class="hint"></div>`,
          ),
        ].join("")
      : [
          stepBox(
            "st-b1",
            t("b1.title", { chain: chainName(MST) }),
            `<div class="row">
               <div class="field"><label>${t("b1.id")}</label><input id="b-mst-id" class="mono" value="${s.mstSwapId || ""}" placeholder="0x…" /></div>
             </div>
             <div class="row">
               <div class="field"><label>${t("b1.expect")}</label><input id="b-expect-mst" type="number" step="any" placeholder="${t("b1.placeholder")}" /></div>
               <button class="btn" id="b-verify">${t("verify.btn")}</button>
             </div>
             <ul id="b-checks" class="checklist"></ul>`,
          ),
          stepBox(
            "st-b2",
            t("b2.title", { chain: chainName(ETH) }),
            `<p>${t("b2.desc")}</p>
             <div class="row">
               <div class="field"><label>${t("b2.amount")}</label><input id="b-amount" type="number" min="0" step="any" value="0.01" /></div>
               <div class="field"><label>${t("b2.t2")}</label><input id="b-t2" type="number" min="0.5" step="any" value="${config.profile === "local" ? 2 : 5}" /></div>
             </div>
             <div class="row"><button class="btn primary" id="b-lock">${t("b2.btn")}</button></div>
             <div id="b-lock-hint" class="hint"></div>`,
          ),
          stepBox(
            "st-b3",
            t("b3.title", { chain: chainName(ETH) }),
            `<p>${t("b3.desc")}</p>
             <div class="row"><button class="btn" id="b-fetch">${t("b3.btn")}</button></div>
             <div id="b-secret-view" class="small"></div>`,
          ),
          stepBox(
            "st-b4",
            t("b4.title", { chain: chainName(MST) }),
            `<div class="row"><button class="btn primary" id="b-claim">${t("b4.btn")}</button></div>
             <div id="b-claim-hint" class="hint"></div>`,
          ),
        ].join("");
  $("#steps").innerHTML = html;
  for (const [id, value] of Object.entries(typed)) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
  document.querySelectorAll("#steps .step").forEach((el) =>
    attachBorderGlow(el, {
      colors: ["#67e8f9", "#a5b4fc", "#f0abfc"],
      glowColor: "230 90 85",
      glowRadius: 30,
      fillOpacity: 0.35,
    }),
  );

  const on = (id, fn) => $(id)?.addEventListener("click", bind(fn));
  on("#a-gen", actions.generateSecret);
  on("#a-approve", actions.approve);
  on("#a-lock", actions.lockMst);
  on("#a-verify", actions.verifyEth);
  on("#a-claim", () => actions.claim("eth", state.session.secret));
  on("#b-verify", actions.verifyMst);
  on("#b-lock", actions.lockEth);
  on("#b-fetch", actions.fetchSecret);
  on("#b-claim", () => actions.claim("mst", state.session.revealedSecret));
  ["#a-amount", "#a-bob", "#a-t1", "#b-t2"].forEach((id) => $(id)?.addEventListener("input", renderDynamic));
}

// ---------- 动态部分 ----------
function setStep(id, done, current, text) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("done", done);
  el.classList.toggle("current", current);
  el.querySelector(".step-status").textContent = text;
}
function setBtn(id, enabled) {
  const el = $(id);
  if (el) el.disabled = state.busy || !enabled;
}
function setHint(id, text, cls = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `hint ${cls}`;
}
function renderChecks(id, checks) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = (checks || []).map((c) => `<li class="${c.ok ? "" : "fail"}">${c.text}</li>`).join("");
}

let lastCurrentStep = null;
function markSteps(ids, doneFlags) {
  const firstOpen = doneFlags.indexOf(false);
  const currentId = firstOpen >= 0 ? ids[firstOpen] : null;
  if (currentId && currentId !== lastCurrentStep) $(currentId)?.__borderGlow?.sweep();
  lastCurrentStep = currentId;
  ids.forEach((id, i) => setStep(id, doneFlags[i], i === firstOpen, doneFlags[i] ? t("step.done") : i === firstOpen ? t("step.current") : t("step.pending")));
}

// secret / hashlock 显示：值第一次出现时用 Decrypted Text 从乱码逐字解密，之后（重绘、切语言）直接显示
const decrypted = new Set();
function showSecrets(el, rows, emptyText, okText = "") {
  const sig = `${getLang()}|${rows ? rows.map((r) => r[1]).join(",") : ""}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  if (!rows) {
    el.innerHTML = `<span class="muted">${emptyText}</span>`;
    return;
  }
  el.innerHTML = (okText ? `<div class="hint ok">${okText}</div>` : "") + rows.map(([k]) => `<div>${k}: <code data-k="${k}"></code></div>`).join("");
  rows.forEach(([k, value]) => {
    const code = el.querySelector(`code[data-k="${k}"]`);
    // 按"显示位置 + 值"去重：同一浏览器里 Alice 生成过的 secret，Bob 读到时仍会播放一次
    const key = `${el.id}|${value}`;
    if (decrypted.has(key)) {
      code.textContent = value;
      return;
    }
    decrypted.add(key);
    decryptText(code, value, { sequential: true, speed: 18, characters: "0123456789abcdef", scrambleColor: "#a5b4fc" });
  });
}

function renderAlice() {
  const s = state.session;
  const { mst: mstSwap, eth: ethSwap } = state.swaps;
  const connected = !!wallet.account;

  showSecrets($("#a-secret-view"), s.secret ? [["secret", s.secret], ["hashlock", s.hashlock]] : null, t("a1.none"));

  let amount = 0n;
  try {
    amount = parseUnits($("#a-amount").value || "0", state.decimals);
  } catch {
    /* 输入中 */
  }
  const allowance = state.balances?.allowance ?? 0n;
  const balance = state.balances?.mst ?? 0n;
  const locked = !!s.mstSwapId;
  const bobOk = isAddress($("#a-bob").value.trim());
  let lockHint = "";
  if (!connected) lockHint = t("a2.hint.connect");
  else if (!s.secret) lockHint = t("a2.hint.secret");
  else if (locked) lockHint = t("a2.hint.locked");
  else if (!bobOk) lockHint = t("a2.hint.badBob");
  else if (amount <= 0n) lockHint = t("a2.hint.zero");
  else if (balance < amount) lockHint = t("a2.hint.balance", { balance: fmtMst(balance) });
  else if (allowance < amount) lockHint = t("a2.hint.allowance", { allowance: fmtMst(allowance) });
  else lockHint = t("a2.hint.ready", { allowance: fmtMst(allowance) });
  const canLock = connected && s.secret && !locked && bobOk && amount > 0n && balance >= amount && allowance >= amount;
  setBtn("#a-gen", !locked);
  setBtn("#a-approve", connected && !locked && amount > 0n && allowance < amount);
  setBtn("#a-lock", canLock);
  setHint("#a-lock-hint", lockHint, canLock ? "ok" : "");

  setBtn("#a-verify", connected && locked);
  if (state.checks.eth) renderChecks("#a-checks", state.checks.eth);

  const ethState = deriveState(ethSwap, wallet.account);
  const canClaim = !!s.ethVerified && ethState.canClaim && !!s.secret;
  setBtn("#a-claim", canClaim);
  setHint(
    "#a-claim-hint",
    ethSwap?.status === 2 ? t("a4.hint.claimed") : !s.ethVerified ? t("a4.hint.verify") : ethState.claimReason || "",
    ethSwap?.status === 2 ? "ok" : ethState.claimReason ? "bad" : "",
  );

  markSteps(["#st-a1", "#st-a2", "#st-a3", "#st-a4"], [!!s.secret, locked, !!s.ethVerified, ethSwap?.status === 2]);
}

function renderBob() {
  const s = state.session;
  const { mst: mstSwap, eth: ethSwap } = state.swaps;
  const connected = !!wallet.account;

  setBtn("#b-verify", connected);
  if (state.checks.mst) renderChecks("#b-checks", state.checks.mst);

  const ethLocked = !!s.ethSwapId;
  let t2Hint = "";
  if (mstSwap?.timelock) {
    const minutes = Number($("#b-t2").value) || 0;
    const t2 = (ethSwap?.now || mstSwap.now) + Math.round(minutes * 60);
    const ok = t2 + SAFETY_GAP_SECONDS <= mstSwap.timelock;
    t2Hint = t("b2.hint.t2", {
      t1: fmtTime(mstSwap.timelock),
      t2: fmtTime(t2),
      verdict: ok ? t("b2.hint.ok") : t("b2.hint.bad", { gap: SAFETY_GAP_SECONDS }),
    });
    setHint("#b-lock-hint", ethLocked ? t("b2.hint.locked") : t2Hint, ethLocked ? "ok" : ok ? "" : "bad");
  } else {
    setHint("#b-lock-hint", t("b2.hint.verify"));
  }
  setBtn("#b-lock", connected && !!s.mstVerified && !ethLocked);

  setBtn("#b-fetch", !!s.ethSwapId && !s.revealedSecret);
  showSecrets($("#b-secret-view"), s.revealedSecret ? [["secret", s.revealedSecret]] : null, t("b3.none"), t("b3.got"));

  const mstState = deriveState(mstSwap, wallet.account);
  const canClaim = !!s.revealedSecret && mstState.canClaim;
  setBtn("#b-claim", canClaim);
  setHint(
    "#b-claim-hint",
    mstSwap?.status === 2 ? t("b4.hint.claimed") : !s.revealedSecret ? t("b4.hint.wait") : mstState.claimReason || "",
    mstSwap?.status === 2 ? "ok" : mstState.claimReason ? "bad" : "",
  );

  markSteps(["#st-b1", "#st-b2", "#st-b3", "#st-b4"], [!!s.mstVerified, ethLocked, !!s.revealedSecret, mstSwap?.status === 2]);
}

function swapCard(side) {
  const chain = side === "mst" ? MST : ETH;
  const swap = state.swaps[side];
  const id = side === "mst" ? state.session.mstSwapId : state.session.ethSwapId;
  const title = t(side === "mst" ? "card.mstLock" : "card.ethLock", { chain: chainName(chain) });
  if (!id) return `<div class="head"><h3>${title}</h3><span class="state none">${t("card.notCreated")}</span></div><p class="muted small">${t("card.noId")}</p>`;
  if (!swap) return `<div class="head"><h3>${title}</h3><span class="state none">${t("card.loading")}</span></div>`;

  const st = deriveState(swap, wallet.account);
  const amount = side === "mst" ? fmtMst(swap.amount) : fmtEth(swap.amount);
  const secret = side === "eth" ? state.session.secret : state.session.revealedSecret;
  const showActions = swap.status === 1;
  return `
    <div class="head"><h3>${title}</h3><span class="state ${st.key}">${st.label}</span></div>
    <dl class="kv">
      <dt>swapId</dt><dd><code>${swap.swapId}</code></dd>
      <dt>${t("card.status")}</dt><dd>${swap.status} · ${STATUS[swap.status]}</dd>
      <dt>sender</dt><dd><code>${short(swap.sender)}</code>${sameAddr(swap.sender, wallet.account) ? t("card.me") : ""}</dd>
      <dt>recipient</dt><dd><code>${short(swap.recipient)}</code>${sameAddr(swap.recipient, wallet.account) ? t("card.me") : ""}</dd>
      <dt>${t("card.amount")}</dt><dd>${amount}</dd>
      <dt>hashlock</dt><dd><code>${swap.hashlock}</code></dd>
      <dt>timelock</dt><dd>${fmtTime(swap.timelock)} · <span class="countdown">${swap.status === 1 ? fmtCountdown(swap.timelock - swap.now) : "—"}</span></dd>
      <dt>${t("card.chainTime")}</dt><dd>${fmtTime(swap.now)}</dd>
    </dl>
    ${
      showActions
        ? `<div class="actions">
            <button class="btn primary small" data-act="claim" data-side="${side}" ${st.canClaim && secret && !state.busy ? "" : "disabled"}>${t("card.claim")}</button>
            <span class="hold-slot" data-side="${side}" data-enabled="${st.canRefund && !state.busy ? "1" : ""}"></span>
            <span class="muted small">${[st.claimReason && t("card.claimReason", { r: st.claimReason }), st.refundReason && t("card.refundReason", { r: st.refundReason })].filter(Boolean).join(t("card.sep"))}</span>
          </div>
          <div class="actions">
            <button class="linkbtn" data-act="force-claim" data-side="${side}">${t("card.forceClaim")}</button>
            <button class="linkbtn" data-act="force-refund" data-side="${side}">${t("card.forceRefund")}</button>
            <span class="muted small">${t("card.forceNote")}</span>
          </div>`
        : ""
    }`;
}

const holds = {};
function mountHoldButtons() {
  document.querySelectorAll("#monitor-card .hold-slot").forEach((slot) => {
    const side = slot.dataset.side;
    const hb = createHoldButton({
      label: t("hold.refund"),
      doneLabel: t("hold.done"),
      hint: t("hold.hint"),
      size: "xs",
      radius: 999,
      holdTime: 1200,
      backgroundColor: "rgba(248, 113, 113, 0.14)",
      fillColor: "#f87171",
      textColor: "#fca5a5",
      fillTextColor: "#1a0505",
      disabled: !slot.dataset.enabled,
      className: "refund",
      onHold: bind(() => actions.refund(side)),
    });
    slot.replaceWith(hb.el);
    holds[side] = hb;
  });
}

let bannerSig = "";
function renderMonitor() {
  // 正在长按退款时不重绘，否则按钮被替换、进度丢失
  if (Object.values(holds).some((h) => h.isHolding())) return;
  $("#card-mst").innerHTML = swapCard("mst");
  $("#card-eth").innerHTML = swapCard("eth");
  mountHoldButtons();

  const { mst, eth } = state.swaps;
  let kind = "";
  let text = "";
  if (mst?.status === 2 && eth?.status === 2) {
    kind = "ok";
    text = t("banner.done");
  } else if (mst?.status === 3 || eth?.status === 3) {
    const parts = [mst?.status === 3 && t("banner.mstBack"), eth?.status === 3 && t("banner.ethBack")].filter(Boolean);
    kind = "warn";
    text = t("banner.refunded", { parts: parts.join(t("banner.join")) });
  }
  // 横幅内容变了才重建，Shiny Text 的扫光才能连续播放
  const sig = `${kind}|${text}`;
  if (sig === bannerSig) return;
  bannerSig = sig;
  const box = $("#final-banner");
  if (!kind) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="banner ${kind}"><span></span></div>`;
  const span = box.querySelector("span");
  span.textContent = text;
  shinyText(span, { color: kind === "ok" ? "#6ee7b7" : "#fcd34d", shineColor: "#ffffff", speed: 2.4, delay: 1.2 });
}

function renderAccount() {
  const b = state.balances;
  const known = wallet.chainId === MST.chainId || wallet.chainId === ETH.chainId;

  // 顶栏钱包按钮：未连接时是主按钮；连接后显示状态点 + 缩写地址（dev wallet 模式由下拉框显示账户）
  const btn = $("#btn-connect");
  if (!wallet.account) {
    btn.className = "btn primary";
    btn.textContent = t("btn.connect");
    btn.title = "";
  } else {
    btn.className = "btn wallet";
    btn.innerHTML = `<span class="dot ${known ? "ok" : "warn"}"></span>${short(wallet.account)}`;
    btn.title = `${wallet.account} · ${chainLabel(wallet.chainId)}`;
  }
  btn.classList.toggle("hidden", devWalletEnabled && !!wallet.account);
  $("#btn-switch-mst").classList.toggle("active", wallet.chainId === MST.chainId);
  $("#btn-switch-eth").classList.toggle("active", wallet.chainId === ETH.chainId);

  $("#contract-line").innerHTML = [
    ["ERC20HTLC", MST, MST.htlc],
    ["MST", MST, MST.mst],
    ["ETHHTLC", ETH, ETH.htlc],
  ]
    .map(([name, chain, addr]) => `<span>${name} ${addr ? addrLink(chain, addr) : "—"}</span>`)
    .join("");

  const missing = !MST.htlc || !MST.mst || !ETH.htlc;
  // 小卡结构只在语言 / 配置变化时重建；数值用 Count Up 从旧值滚到新值
  const box = $("#account-info");
  const sig = `${getLang()}|${missing}`;
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    const stat = (key, label, mono = false) =>
      `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value${mono ? " mono" : ""}" id="stat-${key}">—</div><div class="stat-sub" id="stat-${key}-sub">&nbsp;</div></div>`;
    box.innerHTML = `
      ${missing ? `<div class="banner warn" style="grid-column: 1 / -1">${t("acct.missing")}</div>` : ""}
      ${stat("acct", t("acct.account"), true)}
      ${stat("mst", t("acct.mstBalance"))}
      ${stat("ethA", t("acct.ethOnMst"))}
      ${stat("ethB", t("acct.ethOnEth"))}`;
  }
  $("#stat-acct").textContent = wallet.account ? short(wallet.account) : "—";
  $("#stat-acct-sub").textContent = wallet.account ? chainLabel(wallet.chainId) : t("pill.disconnected");
  $("#stat-mst-sub").textContent = b ? `${t("acct.allowance")} ${fmtMst(b.allowance)}` : "\u00a0";
  $("#stat-ethA-sub").textContent = t("acct.gas");
  $("#stat-ethB-sub").textContent = chainName(ETH);
  const roll = (key, raw, unit, units) => {
    const el = $(`#stat-${key}`);
    if (raw == null) {
      el.textContent = "—";
      el.__countValue = undefined;
      return;
    }
    const value = Number(trimDecimals(formatUnits(raw, units)));
    if (el.__countTarget === value && el.textContent !== "—") return; // 没变化就不重播
    const places = (String(value).split(".")[1] || "").length;
    countUp(el, value, { decimals: places, suffix: ` ${unit}`, duration: 1.2 });
  };
  roll("mst", b?.mst, "MST", state.decimals);
  roll("ethA", b?.ethOnMst, "ETH", 18);
  roll("ethB", b?.ethOnEth, "ETH", 18);
}

// 概览里的协议进度：只看链上状态（和角色无关），两条链各自读取。
// 节点只建一次，完成时用 Status Mark 画出对勾
let timelineNodes = null;
function renderTimeline() {
  const { mst, eth } = state.swaps;
  const s = state.session;
  const mstLocked = (mst?.status ?? 0) >= 1;
  const ethLocked = (eth?.status ?? 0) >= 1;
  const steps = [
    { title: t("tl.secret"), sub: "keccak256", done: mstLocked || !!s.secret },
    { title: t("tl.lockMst"), sub: mst?.timelock ? `T1 ${fmtTime(mst.timelock)}` : chainName(MST), done: mstLocked },
    { title: t("tl.lockEth"), sub: eth?.timelock ? `T2 ${fmtTime(eth.timelock)}` : chainName(ETH), done: ethLocked },
    { title: t("tl.claimEth"), sub: t("tl.claimEthSub"), done: eth?.status === 2, refunded: eth?.status === 3 },
    { title: t("tl.claimMst"), sub: t("tl.claimMstSub"), done: mst?.status === 2, refunded: mst?.status === 3 },
  ];
  if (!timelineNodes) {
    const ol = $("#timeline");
    ol.innerHTML = "";
    timelineNodes = steps.map(() => {
      const li = document.createElement("li");
      const node = document.createElement("span");
      node.className = "tl-node";
      const num = document.createElement("span");
      num.className = "tl-num";
      const mark = createStatusMark({ color: "#6ee7b7", doneColor: "#6ee7b7", size: 16, status: "pending" });
      node.append(num, mark.el);
      const title = document.createElement("div");
      title.className = "tl-title";
      const sub = document.createElement("div");
      sub.className = "tl-sub";
      li.append(node, title, sub);
      ol.append(li);
      return { li, num, mark, title, sub };
    });
  }
  const anyRefund = steps.some((x) => x.refunded);
  const current = anyRefund ? -1 : steps.findIndex((x) => !x.done);
  steps.forEach((x, i) => {
    const n = timelineNodes[i];
    const cls = x.refunded ? "refunded" : x.done ? "done" : i === current ? "current" : "pending";
    n.li.className = cls;
    n.num.textContent = x.refunded ? "↩" : String(i + 1);
    n.mark.set(x.done && !x.refunded ? "done" : "pending");
    n.title.textContent = x.title;
    n.sub.textContent = x.refunded ? t("tl.refunded") : x.sub;
  });
}

function renderDynamic() {
  renderAccount();
  renderTimeline();
  if (state.role === "alice") renderAlice();
  else renderBob();
  renderMonitor();
}

// ---------- 背景：React Bits Dark Veil ----------
// Storm 预设（color / speed / flow / warp / variation 与官方预设相同），另加 rotation: 180：
// 实测四象限最暗 / 最亮比从 0.40 提到 0.66，光幕分布更均匀。
// 性能：dpr 1（背景本身是模糊光幕，不需要 Retina 分辨率）+ 30fps 上限，GPU 每帧约 1.2ms。
function mountBackground() {
  mountDarkVeil($("#backdrop"), { color: "#3d5afe", speed: 1, flow: 2.2, warp: 0.6, variation: 5, rotation: 180, dpr: 1, fps: 30 });
}

// 切换交换流程的角色（Alice / Bob）；角色没变时不重建步骤，避免打断输入
function setRole(role) {
  if (role === state.role) return;
  state.role = role;
  try {
    localStorage.setItem("htlc-role", role);
  } catch {
    /* 隐私模式 */
  }
  renderSteps();
}
// 当前账户是配置里的哪个测试角色（只有本地 profile 有 testAccounts；其他账户返回 null，不改角色）
function roleForAccount(addr) {
  const ta = config.testAccounts;
  if (!ta || !addr) return null;
  if (sameAddr(addr, ta.alice)) return "alice";
  if (sameAddr(addr, ta.bob)) return "bob";
  return null;
}

// 顶栏中随语言变化、但不在 data-i18n 里的部分
function renderChrome() {
  $("#profile-badge").textContent = t(config.profile === "local" ? "profile.local" : "profile.testnet");
  $("#btn-switch-mst").title = t("net.switchTo", { name: chainName(MST) });
  $("#btn-switch-eth").title = t("net.switchTo", { name: chainName(ETH) });
  document.querySelectorAll(".tab[data-lang]").forEach((el) => {
    const on = el.dataset.lang === getLang();
    el.classList.toggle("active", on);
    el.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#dev-account option").forEach((o) => {
    if (!o.dataset.name) o.textContent = `${t("dev.testAccount")} ${short(o.value)}`;
  });
}

// ---------- 初始化 ----------
async function init() {
  mountBackground();
  applyStatic();
  renderChrome();
  document.querySelectorAll(".tab[data-lang]").forEach((el) => el.addEventListener("click", () => setLang(el.dataset.lang)));
  onLangChange(() => {
    renderChrome();
    renderSteps();
    renderLog();
    refresh(); // 顺带更新「更新于…」时间戳
  });
  $("#btn-connect").addEventListener("click", bind(actions.connect));
  $("#btn-switch-mst").addEventListener("click", bind(() => switchChain(MST).then(renderDynamic)));
  $("#btn-switch-eth").addEventListener("click", bind(() => switchChain(ETH).then(renderDynamic)));
  $("#btn-reset").addEventListener("click", actions.reset);
  // 角色标签 → 账户：本地 dev wallet 下切换角色时自动切到对应测试账户
  document.querySelectorAll(".tab[data-role]").forEach((el) =>
    el.addEventListener("click", () => {
      setRole(el.dataset.role);
      if (devWalletEnabled && config.testAccounts) {
        const addr = config.testAccounts[state.role];
        $("#dev-account").value = addr;
        getInjected().setAccount(addr);
      }
      refresh();
    }),
  );

  // 两张状态卡片上的按钮（事件委托）
  $("#monitor-card").addEventListener(
    "click",
    bind(async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const side = btn.dataset.side;
      const act = btn.dataset.act;
      if (act === "claim" || act === "force-claim") {
        let secret = side === "eth" ? state.session.secret : state.session.revealedSecret;
        if (!secret) secret = prompt(t("prompt.secret")) || "";
        await actions.claim(side, secret);
      } else {
        await actions.refund(side);
      }
    }),
  );

  if (devWalletEnabled) {
    const sel = $("#dev-account");
    sel.classList.remove("hidden");
    // 本地链没启动时 listAccounts 会失败：退回到配置里的两个测试账户，页面照常渲染（状态区显示读取失败）
    let accounts = [];
    try {
      accounts = await getInjected().listAccounts();
    } catch {
      accounts = [config.testAccounts?.alice, config.testAccounts?.bob].filter(Boolean);
    }
    const names = { [config.testAccounts?.alice?.toLowerCase()]: "Alice", [config.testAccounts?.bob?.toLowerCase()]: "Bob" };
    sel.innerHTML = accounts
      .slice(0, 5)
      .map((a) => `<option value="${a}" data-name="${names[a.toLowerCase()] || ""}">${names[a.toLowerCase()] || t("dev.testAccount")} ${short(a)}</option>`)
      .join("");
    sel.value = config.testAccounts?.[state.role] || accounts[0];
    getInjected().setAccount(sel.value);
    sel.addEventListener("change", () => getInjected().setAccount(sel.value));
  }

  // 账户 → 角色：顶部下拉框（或 MetaMask）换成 Alice / Bob 测试账户时，交换流程的标签跟着切换
  onWalletChange(() => {
    const role = roleForAccount(wallet.account);
    if (role) setRole(role);
    if (devWalletEnabled && wallet.account) $("#dev-account").value = wallet.account;
    refresh();
  });
  renderSteps();
  renderLog();

  try {
    if (MST.mst) state.decimals = Number(await readContracts().mst.decimals());
  } catch {
    /* 保持默认 18 */
  }
  // 已授权过的钱包静默恢复连接
  const eth = getInjected();
  if (eth) {
    const accounts = await eth.request({ method: "eth_accounts" });
    if (accounts[0]) await connectWallet();
  }
  await refresh();
  setInterval(() => {
    if (!state.busy) refresh();
  }, 3000);
}

init();
