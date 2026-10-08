/* qoder-free · 控制台脚本（无依赖；设计语言与交互模式取自 workbuddy-free，MIT） */
"use strict";

const $ = (id) => document.getElementById(id);
const LS_THEME = "qf_theme";

/* ---------- 主题：跟随系统 → 浅色 → 深色 循环 ---------- */
function effTheme() {
  const t = localStorage.getItem(LS_THEME) || "auto";
  if (t !== "auto") return t;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme() { document.documentElement.dataset.theme = effTheme(); }
applyTheme();
addEventListener("change", applyTheme);
$("btnTheme").onclick = () => {
  const order = ["auto", "light", "dark"];
  const cur = localStorage.getItem(LS_THEME) || "auto";
  localStorage.setItem(LS_THEME, order[(order.indexOf(cur) + 1) % order.length]);
  applyTheme();
  toast({ auto: "主题：跟随系统", light: "主题：浅色", dark: "主题：深色" }[(localStorage.getItem(LS_THEME) || "auto")]);
};

/* ---------- 基础 ---------- */
async function api(path, opts = {}) {
  const r = await fetch("/panel/api/" + path, Object.assign({}, opts, { headers: opts.headers || {} }));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
function toast(msg, cls) {
  const el = document.createElement("div");
  el.className = "tst " + (cls || "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ago(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return Math.floor(s) + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
function dur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return d + "d " + h + "h";
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + (sec % 60) + "s";
  return sec + "s";
}
function fmtTok(n) {
  n = Number(n) || 0;
  const units = ["", "万", "亿", "万亿"];
  let u = 0;
  while (n >= 10000 && u < units.length - 1) { n /= 10000; u++; }
  return (u ? n.toFixed(2) : String(n)) + units[u];
}
function fmtInt(n) { return (Number(n) || 0).toLocaleString("en-US"); }

/* ---------- 视图路由 ---------- */
const views = ["accounts", "stats", "models", "config", "logs"];
const titles = { accounts: "账号池", stats: "用量统计", models: "模型", config: "配置", logs: "运行日志" };
let pollTimer = null;
let logTimer = null;
function go(v) {
  if (!views.includes(v)) v = "accounts";
  for (const name of views) $("view-" + name).hidden = name !== v;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === v));
  $("ttl").textContent = titles[v];
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  ({ accounts: loadOverview, stats: loadStats, models: loadModels, config: loadConfig, logs: loadLogs }[v])();
  location.hash = v;
}
addEventListener("hashchange", () => go(location.hash.replace("#", "")));
document.querySelectorAll(".nav a").forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.dataset.view); }));
$("btnRefresh").onclick = () => go(location.hash.replace("#", "") || "accounts");

/* ---------- 账号池 ---------- */
let overviewCache = null;
async function loadOverview(quiet) {
  try {
    const d = await api("overview");
    overviewCache = d;
    renderAccounts(d);
    const p = $("navPulse");
    p.className = "pulse" + (d.healthy > 0 ? "" : " warn");
    $("navState").textContent = d.healthy > 0 ? d.healthy + " 个账号可用" : "无可用账号";
    $("navVer").textContent = "v" + d.version;
    $("navUp").textContent = dur(d.uptime_s);
    $("subMeta").textContent = d.healthy + " 可用 / " + d.total + " 总数 · 运行 " + dur(d.uptime_s);
  } catch (e) {
    if (!quiet) { $("accBody").innerHTML = `<tr><td colspan="8"><div class="empty">${esc(e.message)}</div></td></tr>`; }
    $("navPulse").className = "pulse bad";
    $("navState").textContent = "离线";
  }
}
function statusCell(row) {
  if (!row.enabled) return '<span class="tag mute">已禁用</span>';
  if (row.cool_kind === "quota") return '<span class="tag bad">额度冷却</span>';
  if (row.cool_kind === "soft") return '<span class="tag warn">限流冷却</span>';
  if (row.cool_kind === "breaker") return '<span class="tag bad">熔断</span>';
  if (row.ready) return '<span class="tag ok">就绪</span>';
  if (row.running) return '<span class="tag warn">启动中</span>';
  return '<span class="tag mute">未登录</span>';
}
function credCell(row) {
  if (!row.has_quota) return '<span style="color:var(--ink-3)">—</span>';
  const pct = row.credits_total > 0 ? Math.round((row.credits / row.credits_total) * 100) : 0;
  return `<div class="cred"><div class="n">${row.credits.toFixed(2)}<span class="of"> / ${row.credits_total.toFixed(2)}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div></div>`;
}
function renderAccounts(d) {
  const rows = d.accounts || [];
  $("sTotal").textContent = rows.length;
  $("sHealthy").textContent = d.healthy;
  $("sCooling").textContent = rows.filter((r) => r.enabled && r.cool_kind && r.cool_kind !== "none").length;
  $("sDisabled").textContent = rows.filter((r) => !r.enabled).length;
  const rem = rows.reduce((a, r) => a + (r.has_quota ? r.credits : 0), 0);
  const tot = rows.reduce((a, r) => a + (r.has_quota ? r.credits_total : 0), 0);
  $("sCredits").textContent = tot > 0 ? rem.toFixed(1) + " / " + tot.toFixed(1) : "—";
  $("sSticky").textContent = d.sticky_count ?? 0;
  $("accNote").textContent = rows.length ? "" : "添加账号后自动拉起 worker";
  const apiBase = $("apiBase");
  if (apiBase) apiBase.textContent = location.origin + "/v1";

  const tb = $("accBody");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="8"><div class="empty"><div class="big">账号池是空的</div>点右上角「添加账号」，用 Qoder 账号完成设备授权。</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((row) => {
    const trCls = !row.enabled ? "off" : (row.cool_kind && row.cool_kind !== "none" ? "cool" : "");
    const uid = row.uid ? (row.uid.length > 18 ? row.uid.slice(0, 18) + "…" : row.uid) : "";
    const err = row.last_err
      ? `<div class="hint" style="font-size:11px;color:var(--bad);margin-top:3px" title="${esc(row.last_err)}">${esc(row.last_err.slice(0, 72))}</div>` : "";
    const acts = [
      `<button class="xs" data-a="quota" data-id="${row.id}">额度</button>`,
      row.region === "cn" ? `<button class="xs" data-a="checkin" data-id="${row.id}">签到</button>` : "",
      row.auth_type !== "oauth"
        ? `<button class="xs primary" data-a="login" data-id="${row.id}">登录</button>`
        : `<button class="xs" data-a="rewarm" data-id="${row.id}">重建</button>`,
      row.enabled
        ? `<button class="xs" data-a="disable" data-id="${row.id}">禁用</button>`
        : `<button class="xs" data-a="enable" data-id="${row.id}">启用</button>`,
      `<button class="xs danger" data-a="remove" data-id="${row.id}">删除</button>`,
    ].join("");
    return `<tr class="${trCls}">
      <td class="mark"><i></i></td>
      <td class="who"><div class="nm">${esc(row.name)}<span class="realm-tag">${row.region === "cn" ? "CN" : "GL"}</span></div>
        <div class="id" title="${esc(row.id)}">${esc(row.id)}</div>${err}</td>
      <td>${statusCell(row)}${uid ? `<div class="hint" style="font-size:10.5px;color:var(--ink-3);margin-top:3px" title="${esc(row.uid)}">${esc(uid)}</div>` : ""}</td>
      <td>${credCell(row)}</td>
      <td class="num">${row.success_count} / ${row.err_total}</td>
      <td class="num">${row.in_flight}/${row.max_inflight || 4}</td>
      <td class="num" style="color:var(--ink-3)">${ago(row.last_success)}</td>
      <td class="c-acts"><div class="acts">${acts}</div></td>
    </tr>`;
  }).join("");
}
$("accBody").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-a]");
  if (!b) return;
  const { a, id } = b.dataset;
  const acct = (overviewCache?.accounts || []).find((r) => r.id === id) || {};
  try {
    if (a === "quota") return openQuota(id, acct.name);
    if (a === "login") return openAdd(id, acct.name);
    if (a === "remove") {
      if (!confirm("删除账号「" + (acct.name || id) + "」？（仅移除注册信息，凭证目录 data/homes 保留）")) return;
      await api("accounts/" + id + "/delete", { method: "POST" });
      toast("已删除", "ok");
    } else {
      await api("accounts/" + id + "/" + a, { method: "POST" });
      toast({ enable: "已启用", disable: "已禁用", rewarm: "已请求重建上下文", checkin: "签到完成" }[a] || "完成", "ok");
    }
    loadOverview();
  } catch (e) { toast(e.message, "err"); }
});

/* ---------- 添加账号 / 登录 ---------- */
let addPollTimer = null;
let addAccountId = null;
let addAuthUrl = "";
function openAdd(existingId, existingName) {
  addAccountId = existingId || null;
  addAuthUrl = "";
  $("addTitle").textContent = existingId ? "登录 · " + (existingName || existingId) : "添加账号";
  $("addPick").hidden = !!existingId;
  $("addName").value = "";
  $("addLoad").hidden = true;
  $("addReady").hidden = true;
  $("addDone").hidden = true;
  $("addErr").hidden = true;
  $("addErr").textContent = "";
  $("btnStartLogin").hidden = false;
  $("btnStartLogin").disabled = false;
  $("btnCopyUrl").hidden = true;
  $("btnOpenUrl").hidden = true;
  $("addVeil").classList.add("on");
}
$("btnAdd").onclick = () => openAdd();
$("btnCloseAdd").onclick = () => { $("addVeil").classList.remove("on"); stopAddPoll(); loadOverview(); };
$("btnStartLogin").onclick = async () => {
  $("btnStartLogin").disabled = true;
  $("addErr").hidden = true;
  try {
    if (!addAccountId) {
      const realm = document.querySelector('input[name="addRealm"]:checked').value;
      const created = await api("accounts", {
        method: "POST",
        body: JSON.stringify({ name: $("addName").value.trim(), region: realm }),
      });
      addAccountId = created.id;
    }
    $("addPick").hidden = true;
    $("addLoad").hidden = false;
    const started = await api("accounts/" + addAccountId + "/login/start", { method: "POST", body: "{}" });
    if (!started.authUrl) throw new Error(started.message || "未返回授权链接");
    addAuthUrl = started.authUrl;
    $("addLoad").hidden = true;
    $("addReady").hidden = false;
    $("addUrl").textContent = addAuthUrl;
    $("btnCopyUrl").hidden = false;
    $("btnOpenUrl").hidden = false;
    startAddPoll();
  } catch (e) {
    $("addLoad").hidden = true;
    $("addPick").hidden = !!addAccountId;
    $("btnStartLogin").disabled = false;
    $("addErr").hidden = false;
    $("addErr").textContent = e.message;
  }
};
$("btnCopyUrl").onclick = async () => {
  try { await navigator.clipboard.writeText(addAuthUrl); toast("链接已复制", "ok"); }
  catch { toast("复制失败，请手动选择链接", "err"); }
};
$("btnOpenUrl").onclick = () => window.open(addAuthUrl, "_blank", "noopener");
function stopAddPoll() { if (addPollTimer) { clearInterval(addPollTimer); addPollTimer = null; } }
function startAddPoll() {
  stopAddPoll();
  addPollTimer = setInterval(async () => {
    try {
      const state = await api("accounts/" + addAccountId + "/login/poll", { method: "POST", body: "{}" });
      if (state.status === "ok") {
        stopAddPoll();
        $("addPoll").textContent = "";
        $("addDone").hidden = false;
        $("addDone").textContent = "登录成功，worker 将自动就绪。";
        setTimeout(() => { $("addVeil").classList.remove("on"); loadOverview(); }, 900);
      } else if (state.message && $("addPoll")) {
        $("addPoll").textContent = state.message;
      }
    } catch {}
  }, 3000);
}

/* ---------- 额度 ---------- */
let quotaId = null;
function quotaBlocks(q) {
  const row = (label, b) => {
    if (!b) return "";
    const pct = b.total > 0 ? Math.round((b.remaining / b.total) * 100) : 0;
    return `<div style="margin-top:12px"><div class="state" style="justify-content:space-between">
      <span>${esc(label)}</span><b class="num">${(b.remaining || 0).toFixed(2)} / ${(b.total || 0).toFixed(2)} ${esc(b.unit || "")}</b></div>
      <div class="bar" style="max-width:none"><i style="width:${pct}%"></i></div></div>`;
  };
  const total = (q.userQuota?.total || 0) + (q.addOnQuota?.total || 0) + (q.orgResourcePackage?.total || 0);
  const remaining = (q.userQuota?.remaining || 0) + (q.addOnQuota?.remaining || 0) + (q.orgResourcePackage?.remaining || 0);
  const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
  return `<div><div class="state" style="justify-content:space-between">
      <span>剩余 / 总额</span><b class="num" style="font-size:14px">${remaining.toFixed(2)} / ${total.toFixed(2)}（${pct}%）</b></div>
    <div class="bar" style="max-width:none;margin-top:8px"><i style="width:${pct}%"></i></div>
    ${row("基础额度", q.userQuota)}${row("加量包", q.addOnQuota)}${row("组织包", q.orgResourcePackage)}
    ${q.isQuotaExceeded ? '<div class="state err" style="margin-top:12px">上游标记额度已用尽</div>' : ""}</div>`;
}
async function openQuota(id, name) {
  quotaId = id;
  $("quotaWho").textContent = name || id;
  $("quotaState").hidden = false;
  $("quotaState").className = "state";
  $("quotaState").innerHTML = '<span class="dots">查询中</span>';
  $("quotaBody").hidden = true;
  $("quotaVeil").classList.add("on");
  await fetchQuota(false);
}
async function fetchQuota(refresh) {
  try {
    const q = await api("accounts/" + quotaId + "/quota" + (refresh ? "?refresh=1" : ""));
    $("quotaState").hidden = true;
    $("quotaBody").hidden = false;
    $("quotaBody").innerHTML = quotaBlocks(q);
  } catch (e) {
    $("quotaState").hidden = false;
    $("quotaState").className = "state err";
    $("quotaState").textContent = e.message;
  }
}
$("btnQuotaRefresh").onclick = () => fetchQuota(true);
$("btnCloseQuota").onclick = () => { $("quotaVeil").classList.remove("on"); loadOverview(); };

/* ---------- 模型 ---------- */
async function loadModels() {
  const tb = $("mdBody");
  tb.innerHTML = `<tr><td colspan="6"><div class="empty"><span class="dots">加载中</span></div></td></tr>`;
  try {
    const d = await api("models");
    const rows = d.models || [];
    $("mdNote").textContent = rows.length ? rows.length + " 个模型 · 实时 catalog" : "就绪账号登录后才会拉到 catalog";
    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="6"><div class="empty"><div class="big">暂无模型</div>账号需要完成登录且 worker 就绪。</div></td></tr>`;
      return;
    }
    tb.innerHTML = rows.map((m) => {
      const billing = m.free
        ? '<span class="tag ok">免费</span>'
        : m.price_label
          ? `<span class="tag mute" title="积分倍率">${esc(m.price_label)}</span>`
          : '<span class="tag mute">按额度</span>';
      return `<tr>
      <td class="mark"><i></i></td>
      <td class="num">${esc(m.id)}</td>
      <td>${esc(m.display_name || "—")}</td>
      <td>${m.region === "cn" ? '<span class="realm-tag">CN</span>' : '<span class="realm-tag">GL</span>'}</td>
      <td>${m.is_reasoning ? '<span class="tag warn">推理</span>' : '<span class="tag mute">标准</span>'}</td>
      <td>${billing}</td>
    </tr>`;
    }).join("");
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="6"><div class="empty">${esc(e.message)}</div></td></tr>`;
  }
}
$("btnModels").onclick = loadModels;

/* ---------- 用量统计 ---------- */
let statRange = "30d";
async function loadStats() {
  try {
    const rep = await api("stats?range=" + statRange);
    if (rep.enabled === false) {
      $("chartPlot").innerHTML = "";
      $("rngNote").textContent = "统计已关闭（配置页可开启）";
      return;
    }
    const grand = rep.grand || {};
    $("ltTotal").textContent = fmtTok((grand.prompt_tokens || 0) + (grand.completion_tokens || 0));
    $("ltPrompt").textContent = fmtTok(grand.prompt_tokens || 0);
    $("ltCompletion").textContent = fmtTok(grand.completion_tokens || 0);
    $("ltRequests").textContent = fmtInt(grand.requests || 0);
    $("ltAccounts").textContent = (rep.by_account || []).length;

    const t = rep.totals || {};
    $("stTotal").textContent = fmtTok((t.prompt_tokens || 0) + (t.completion_tokens || 0));
    $("stPrompt").textContent = fmtTok(t.prompt_tokens || 0);
    $("stCompletion").textContent = fmtTok(t.completion_tokens || 0);
    $("stRequests").textContent = fmtInt(t.requests || 0);
    $("stFailed").textContent = fmtInt(t.failures || 0);
    $("stCredits").textContent = "—";
    $("rngNote").textContent = statRange === "today" ? "仅今天" : statRange === "7d" ? "最近 7 天" : "最近 30 天";
    renderChart(rep.series || []);
    renderRanking($("mdStatBody"), rep.by_model || [], (t.prompt_tokens || 0) + (t.completion_tokens || 0), "model");
    renderRanking($("acStatBody"), rep.by_account || [], (t.prompt_tokens || 0) + (t.completion_tokens || 0), "account");
  } catch (e) {
    $("rngNote").textContent = e.message;
  }
}
$("rngChips").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-rng]");
  if (!b) return;
  statRange = b.dataset.rng;
  document.querySelectorAll("#rngChips .chip").forEach((c) => c.classList.toggle("on", c === b));
  loadStats();
});

/* 消费节律：抖动柱 + 请求量细条 + 悬停读数（与参考项目同一套 grid 轨道） */
let chartData = [];
function renderChart(series) {
  chartData = series;
  const plot = $("chartPlot"), strip = $("chartStrip"), scale = $("chartScale");
  const maxTok = Math.max(1, ...series.map((d) => (d.prompt_tokens || 0) + (d.completion_tokens || 0)));
  const maxReq = Math.max(1, ...series.map((d) => d.requests || 0));
  const peakDay = series.find((d) => (d.prompt_tokens || 0) + (d.completion_tokens || 0) === maxTok);
  plot.innerHTML = series.map((d) => {
    const total = (d.prompt_tokens || 0) + (d.completion_tokens || 0);
    const h = Math.max(0.6, Math.round((total / maxTok) * 100));
    const cls = total === 0 ? "col zero" : "col" + (d === peakDay ? " peak" : "");
    return `<div class="${cls}" data-day="${esc(d.day)}" tabindex="0" style="--h:${h}%"><div class="fill"></div></div>`;
  }).join("");
  strip.innerHTML = series.map((d) => {
    const r = Math.max(8, Math.round(((d.requests || 0) / maxReq) * 100));
    const cls = (d.requests || 0) === 0 ? "r zero" : "r";
    return `<div class="${cls}" style="--r:${r}%"></div>`;
  }).join("");
  scale.innerHTML = series.map((d) => `<span title="${esc(d.day)}">${esc(d.day.slice(5))}</span>`).join("");
  $("chartReadout").textContent = series.length ? "— 悬停查看明细" : "暂无数据";
}
$("chartPlot").addEventListener("mouseover", (ev) => {
  const col = ev.target.closest(".col");
  if (!col) return;
  const d = chartData.find((x) => x.day === col.dataset.day);
  if (!d) return;
  document.querySelectorAll("#chartPlot .col.on").forEach((c) => c.classList.remove("on"));
  col.classList.add("on");
  const total = (d.prompt_tokens || 0) + (d.completion_tokens || 0);
  $("chartReadout").innerHTML =
    `<b>${esc(d.day)}</b> · ${fmtTok(total)} tok · ${d.requests} 次` + (d.failures ? ` · <span class="bad">失败 ${d.failures}</span>` : "");
});
$("chartPlot").addEventListener("mouseleave", () => {
  document.querySelectorAll("#chartPlot .col.on").forEach((c) => c.classList.remove("on"));
  $("chartReadout").textContent = chartData.length ? "— 悬停查看明细" : "暂无数据";
});

function renderRanking(tbody, rows, grandTotal, kind) {
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty">暂无数据</div></td></tr>`;
    return;
  }
  const maxTok = Math.max(1, ...rows.map((r) => (r.prompt_tokens || 0) + (r.completion_tokens || 0)));
  const names = overviewCache?.accounts || [];
  tbody.innerHTML = rows.map((r) => {
    const total = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    const pct = grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0;
    const w = Math.round((total / maxTok) * 100);
    const label = kind === "model" ? esc(r.key)
      : esc(((names.find((a) => a.id === r.key) || {}).name) || r.key);
    return `<tr>
      <td class="mark"><i></i></td>
      <td class="who"><div class="nm" title="${esc(r.key)}">${label}</div></td>
      <td class="num">${fmtTok(total)}</td>
      <td class="share"><span class="num">${pct}%</span><div class="bar"><i style="width:${w}%"></i></div></td>
      <td class="num">${r.requests}</td>
      <td class="num">${kind === "model" ? fmtInt(r.prompt_tokens) + " / " + fmtInt(r.completion_tokens) : r.failures}</td>
    </tr>`;
  }).join("");
}

/* ---------- 配置 ---------- */
async function loadConfig() {
  try {
    const cfg = await api("config");
    $("cfgPath").textContent = "config.json · 保存立即写入";
    const form = $("cfgForm");
    form.listen.value = cfg.listen || "";
    form.api_key.value = cfg.api_key || "";
    form.max_in_flight.value = cfg.max_in_flight || 4;
    form.max_retry_accounts.value = cfg.max_retry_accounts || 3;
    form.cooldown_soft_seconds.value = cfg.cooldown_soft_seconds || 600;
    form.session_sticky.checked = !!cfg.session_sticky;
    form.stats_enabled.checked = !!cfg.stats_enabled;
    form.stats_keep_days.value = cfg.stats_keep_days || 30;
    form.proxy_url.value = cfg.proxy_url || "";
    $("cfgNote").textContent = "";
  } catch (e) {
    $("cfgNote").textContent = "加载失败：" + e.message;
  }
}
$("btnCfgReload").onclick = loadConfig;
$("btnCopyKey").onclick = async () => {
  try {
    const { api_key } = await api("config/api-key");
    if (!api_key) throw new Error("API key 未生成");
    await navigator.clipboard.writeText(api_key);
    toast("API key 已复制", "ok");
  } catch (e) {
    toast("复制失败：" + e.message, "err");
  }
};
$("cfgForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = $("cfgForm");
  try {
    await api("config", {
      method: "POST",
      body: JSON.stringify({
        max_in_flight: +form.max_in_flight.value,
        max_retry_accounts: +form.max_retry_accounts.value,
        cooldown_soft_seconds: +form.cooldown_soft_seconds.value,
        session_sticky: form.session_sticky.checked,
        stats_enabled: form.stats_enabled.checked,
        stats_keep_days: +form.stats_keep_days.value,
        proxy_url: form.proxy_url.value.trim(),
      }),
    });
    $("cfgNote").textContent = "";
    toast("配置已保存", "ok");
  } catch (e) {
    $("cfgNote").textContent = e.message;
  }
});

/* ---------- 日志 ---------- */
let logCh = "all";
let logAfter = 0;
let logPin = true;
async function loadLogs(reset) {
  const box = $("logBox");
  if (reset) { box.innerHTML = ""; logAfter = 0; }
  try {
    const d = await api("logs?after=" + logAfter);
    const entries = d.entries || [];
    if (!entries.length) return;
    logAfter = entries[entries.length - 1].id;
    const frag = document.createDocumentFragment();
    const chName = { worker: "worker", chat: "对话", sys: "系统" };
    for (const e of entries) {
      if (logCh !== "all" && e.ch !== logCh) continue;
      const div = document.createElement("span");
      const lvl = /error|失败|错误|exited|panic/i.test(e.text) ? " e" : /warn|冷却|熔断|not ready/i.test(e.text) ? " w" : "";
      div.className = "ln" + lvl;
      div.innerHTML = `<i class="lch c-${esc(e.ch)}">${chName[e.ch] || e.ch}</i>`;
      div.appendChild(document.createTextNode(e.ts + "  " + e.text));
      frag.appendChild(div);
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.appendChild(frag);
    while (box.childNodes.length > 900) box.removeChild(box.firstChild);
    if (logPin && nearBottom) box.scrollTop = box.scrollHeight;
  } catch {}
}
$("logChips").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-ch]");
  if (!b) return;
  logCh = b.dataset.ch;
  document.querySelectorAll("#logChips .chip").forEach((c) => c.classList.toggle("on", c === b));
  loadLogs(true);
});
$("btnLogPin").onclick = () => {
  logPin = !logPin;
  $("btnLogPin").textContent = "自动滚动：" + (logPin ? "开" : "关");
};

/* ---------- 启动 ---------- */
go(location.hash.replace("#", "") || "accounts");
loadOverview(true);
pollTimer = setInterval(() => loadOverview(true), 5000);
logTimer = setInterval(() => {
  const v = location.hash.replace("#", "") || "accounts";
  if (v === "logs") loadLogs(false);
}, 2000);
