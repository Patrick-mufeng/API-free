/* workbuddy-free · 面板前端逻辑（内联脚本被 CSP 禁止，故独立成文件）
 *
 * Patrick优化
 */
'use strict';
/* ── 状态 ─────────────────────────────────────────────────────────── */
const LS_KEY = 'wb2api.key', LS_THEME = 'wb2api.theme';
let theme = localStorage.getItem(LS_THEME) || 'auto';   // auto | light | dark
let view = 'accounts';
let cfgLoaded = null;
let logPin = true, loginState = null, loginTimer = null;
let refTimer = null;
// 统计页状态提到顶层：首屏直接以 #stats 进入时 go() 会立刻调用 loadStats，
// 若声明在文件后段（let 不提升）会撞上暂时性死区。
let statsRng = '30d', statsData = null, statsPainted = false;
// 图表当前的点位与峰值：读数槽、悬停高亮、错误降级态都要读这几个。
let chartPts = [], chartPeak = null, chartPeakIdx = -1;

const $ = id => document.getElementById(id);

/* ── 主题 ─────────────────────────────────────────────────────────── */
/* 两态翻转（浅/深），首次访问跟随系统偏好；点击总是切换可见外观，符合直觉。 */
function effTheme() {
  return theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
}
function applyTheme() {
  const eff = effTheme();
  document.documentElement.dataset.theme = eff;
  $('icoTheme').innerHTML = eff === 'light'
    ? '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4"/>'
    : '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"/>';
  $('btnTheme').title = eff === 'light' ? '切换到深色' : '切换到浅色';
}
addEventListener('change', applyTheme);
$('btnTheme').onclick = () => {
  theme = effTheme() === 'light' ? 'dark' : 'light';
  localStorage.setItem(LS_THEME, theme);
  applyTheme();
};
applyTheme();

/* ── 请求 ─────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const h = Object.assign({}, opts.headers || {});
  const k = localStorage.getItem(LS_KEY);
  if (k) h['Authorization'] = 'Bearer ' + k;
  if (opts.body) h['Content-Type'] = 'application/json';
  const r = await fetch('/panel/api/' + path, Object.assign({}, opts, { headers: h }));
  if (r.status === 401) { openKey(); throw new Error('密钥无效或未填写'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
function toast(msg, cls) {
  const el = document.createElement('div');
  el.className = 'tst ' + (cls || '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
// esc 文本/属性双安全转义。不能只用 div.innerHTML（它转义 <>& 但不转义引号），
// 否则字符串拼进 HTML 属性（如 title="uid: ..."）时引号可闭合属性并注入事件处理器。
// 显式替换 5 个字符：& < > " '（& 必须最先，避免二次转义）。
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function ago(iso) {
  if (!iso || iso.startsWith('0001-')) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 0) return '刚刚';
  if (s < 60) return Math.floor(s) + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? h + '时' + String(m).padStart(2, '0') + '分' : m ? m + '分' + String(s).padStart(2, '0') + '秒' : s + '秒';
}

// formatTokenCount 中文数量级：万 / 亿 / 万亿（步进 1e4，与国内读数习惯一致）。
// 一万以下走千分位；四舍五入后越界就升级单位，避免出现"10000万"这种写法。
// 注：原先是 k/m/b，与账号池的用量列共用这一个口径，两处一起变成中文单位。
function formatTokenCount(tokens) {
  if (tokens == null || tokens === '') return '—';
  const n = Number(tokens);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1e4) return formatInt(n);
  const units = [['万', 1e4], ['亿', 1e8], ['万亿', 1e12]];
  let unit = units[0];
  for (const candidate of units) {
    if (n >= candidate[1]) unit = candidate;
  }
  let rounded = Number((n / unit[1]).toFixed(1));
  const next = units[units.indexOf(unit) + 1];
  if (next && rounded >= 1e4) {
    unit = next;
    rounded = Number((n / unit[1]).toFixed(1));
  }
  return rounded + unit[0];
}

function formatLatency(ms) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n < 1000 ? Math.round(n) + 'ms' : (n / 1000).toFixed(1).replace(/\.0$/, '') + 's';
}
function formatRate(rate) {
  if (rate == null || rate === '') return '—';
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return '—';
  return n.toFixed(1) + 'tok/s';
}

/* ── 密钥门 ───────────────────────────────────────────────────────── */
function openKey() { $('keyVeil').classList.add('on'); setTimeout(() => $('keyInput').focus(), 60); }
$('btnKey').onclick = async () => {
  const v = $('keyInput').value.trim();
  if (!v) return;
  localStorage.setItem(LS_KEY, v);
  try {
    await api('overview');
    $('keyErr').hidden = true;
    $('keyVeil').classList.remove('on');
    start();
  } catch (e) { $('keyErr').hidden = false; }
};
$('keyInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnKey').click(); });

/* ── 路由 ─────────────────────────────────────────────────────────── */
const TITLES = { accounts: '账号池', stats: '用量统计', taskscenter: '任务中心', models: '模型与档位', config: '配置', logs: '运行日志' };
function go(v) {
  view = v;
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== 'view-' + v);
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.view === v));
  $('ttl').textContent = TITLES[v];
  if (v === 'models' && !$('mdBody').children.length) loadModels();
  if (v === 'config') loadConfig();
  if (v === 'logs') loadLogs();
  // 统计页每次进入都重取一次并重播入场动效：离开这一页期间攒下的量，
  // 回来时应该看到"涨了"，而不是上一轮的静止画面。
  if (v === 'stats') { statsPainted = false; loadStats(true); }
  if (v === 'taskscenter') { loadSchoolStatus(true); pollQueueOnce(); }
}
document.querySelectorAll('.nav a').forEach(a => a.onclick = e => { e.preventDefault(); go(a.dataset.view); history.replaceState(null, '', '#' + a.dataset.view); });
go((location.hash || '#accounts').slice(1) in TITLES ? (location.hash || '#accounts').slice(1) : 'accounts');

/* ── 账号池 ───────────────────────────────────────────────────────── */
function renderAccounts(list) {
  const tb = $('accBody');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="big">账号池是空的</div>点击右上角「添加账号」，用浏览器登录一个 WorkBuddy 账号</div></td></tr>';
    return;
  }
  // 有总额度（credits_total）→ 进度条按自身 剩余/总额 百分比；旧数据无总额 → 退回池内最高=100%
  const maxCred = Math.max(1, ...list.map(s => s.credits || 0));
  tb.innerHTML = list.map(s => {
    const bl = (new Date(s.breaker_until || 0) - Date.now()) / 1000;
    const cool = Math.max(s.cool_remaining_sec || 0, bl > 0 ? bl : 0);
    let cls = '', tag;
    if (s.disabled) { cls = 'off'; tag = '<span class="tag bad">已禁用</span>'; }
    else if (cool > 0) {
      cls = 'cool';
      const kind = bl > (s.cool_remaining_sec || 0) ? '熔断' : (s.cool_kind === 'hard_credit' ? '积分冷却' : '限流冷却');
      tag = '<span class="tag warn">' + kind + ' · ' + dur(cool) + '</span>';
    } else tag = '<span class="tag ok">可用</span>' + (s.in_flight ? '' : '');
    const note = s.reason ? '<div class="hint" style="font-size:11.5px;color:var(--ink-3);margin-top:3px">' + esc(s.reason) + '</div>' : '';
    const short = s.uid.length > 16 ? s.uid.slice(0, 16) + '…' : s.uid;
    const cred = s.credits == null ? '—' : (s.credits_total > 0 ? s.credits + '<span class="of">/' + s.credits_total + '</span>' : String(s.credits));
    const pct = s.credits_total > 0
      ? Math.min(100, Math.round((s.credits || 0) / s.credits_total * 100))
      : Math.round((s.credits || 0) / maxCred * 100);
    const credTip = s.credits_total > 0 ? '剩余 ' + s.credits + ' / 总额 ' + s.credits_total + '（' + pct + '%）' : '积分（相对池内最高）';
    const frozen = s.disabled || cool > 0;
    const tu = s.token_usage || {};
    const req = tu.request_count || 0;
    const totalTok = formatTokenCount(tu.total_tokens);
    const totalTokUnit = totalTok === '—' ? '' : '<em>tok</em>';
    const latency = formatLatency(tu.last_latency_ms);
    const rate = formatRate(tu.last_tokens_per_second);
    const usageTitle = '最近一次：' + req + ' 次 / ' + totalTok + ' / 延迟 ' + latency + ' / ' + rate;
    return '<tr class="' + cls + '" title="uid: ' + esc(s.uid) + '">' +
      '<td class="mark" aria-hidden="true"><i></i></td>' +
      '<td class="who"><div class="nm">' + (s.nickname ? esc(s.nickname) : '<span style="color:var(--ink-3)">未命名</span>') + (s.realm === 'global' ? ' <span class="realm-tag">国际版</span>' : '') + '</div><div class="id">' + esc(short) + '</div></td>' +
      '<td>' + tag + note + '</td>' +
      '<td class="cred" title="' + credTip + '"><div class="n">' + cred + '</div><div class="bar"><i style="width:' + pct + '%"></i></div></td>' +
      '<td class="num">' + (s.success_count || 0) + ' <span style="color:var(--ink-3)">/</span> <span style="color:var(--bad)">' + (s.err_total || 0) + '</span></td>' +
      '<td class="num">' + (s.in_flight || 0) + '</td>' +
      '<td class="num usage-cell" title="' + esc(usageTitle) + '"><span class="usage-line" aria-label="' + esc(usageTitle) + '">' +
        '<span class="usage-item usage-count"><b>' + req + '</b><em>次</em></span>' +
        '<span class="usage-item usage-total"><b>' + totalTok + '</b>' + totalTokUnit + '</span>' +
        '<span class="usage-item usage-latency"><b>' + latency + '</b></span>' +
        '<span class="usage-item usage-rate"><b>' + rate + '</b></span>' +
      '</span></td>' +
      '<td class="num" style="color:var(--ink-3)">' + ago(s.last_success) + '</td>' +
      '<td class="acts">' +
        '<button class="xs ghost" data-a="checkin" data-u="' + esc(s.uid) + '">签到</button>' +
        '<button class="xs ghost" data-a="balance" data-u="' + esc(s.uid) + '">余额</button>' +
        '<button class="xs ghost" data-a="tasks" data-u="' + esc(s.uid) + '">任务</button>' +
        (frozen ? '<button class="xs primary" data-a="revive" data-u="' + esc(s.uid) + '">解冻</button>'
                : '<button class="xs ghost" data-a="disable" data-u="' + esc(s.uid) + '">禁用</button>') +
        '<button class="xs ghost danger" data-a="remove" data-u="' + esc(s.uid) + '">移除</button>' +
      '</td></tr>';
  }).join('');
}

async function loadOverview(quiet) {
  try {
    const d = await api('overview');
    $('sTotal').textContent = d.total;
    $('sHealthy').textContent = d.healthy;
    $('sCooling').textContent = d.cooling;
    $('sDisabled').textContent = d.disabled;
    const remSum = (d.accounts || []).reduce((a, s) => a + (s.credits || 0), 0);
  const totSum = (d.accounts || []).reduce((a, s) => a + (s.credits_total || 0), 0);
  $('sCredits').textContent = totSum > 0 ? remSum + ' / ' + totSum : remSum;
    $('sSticky').textContent = d.sticky_sessions;
    // 版本号只在侧栏底部的 #navVer 显示一处；#navSub 保留静态副标题，
    // 此前两处都写版本号，视觉上重复。
    $('navVer').textContent = 'v' + d.version;
    $('navRedis').textContent = d.redis_mode === 'upstash' ? 'Redis 镜像' : '本地内存';
    $('navState').textContent = d.healthy > 0 ? '服务正常' : (d.total ? '无可用账号' : '待添加账号');
    const p = $('navPulse');
    p.className = 'pulse' + (d.healthy > 0 ? '' : (d.total ? ' warn' : ' bad'));
    $('accNote').textContent = d.in_flight_full ? d.in_flight_full + ' 个账号在途占满' : '';
    const up = Math.floor(d.uptime_sec);
    $('subMeta').textContent = '运行 ' + (up >= 86400 ? Math.floor(up / 86400) + ' 天 ' : '') + Math.floor(up % 86400 / 3600) + ' 时 ' + Math.floor(up % 3600 / 60) + ' 分';
    renderAccounts(d.accounts || []);
  } catch (e) { if (!quiet) toast(e.message, 'err'); }
}

$('accBody').addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-a]');
  if (!b) return;
  const u = b.dataset.u, a = b.dataset.a;
  if (a === 'remove' && !confirm('移除账号将删除池状态与 auths/ 下的凭证文件，且不可恢复。确认移除？')) return;
  if (a === 'disable' && !confirm('禁用后该账号不再参与选号，需手动解冻才能恢复。确认禁用？')) return;
  b.disabled = true;
  try {
    if (a === 'checkin') {
      const r = await api('accounts/' + encodeURIComponent(u) + '/checkin', { method: 'POST' });
      toast('签到完成' + (r.credits != null ? '，积分 ' + r.credits + (r.credits_total > 0 ? '/' + r.credits_total : '') : '') + (r.checkin_message ? '（' + r.checkin_message + '）' : ''), 'ok');
    } else if (a === 'balance') {
      const r = await api('accounts/' + encodeURIComponent(u) + '/balance', { method: 'POST' });
      toast('余额已更新：' + r.credits + (r.credits_total > 0 ? ' / ' + r.credits_total : ''), 'ok');
    } else if (a === 'revive') {
      await api('accounts/' + encodeURIComponent(u) + '/revive', { method: 'POST' });
      toast('已解冻', 'ok');
    } else if (a === 'disable') {
      await api('accounts/' + encodeURIComponent(u) + '/disable', { method: 'POST' });
      toast('已禁用', 'ok');
    } else if (a === 'tasks') {
      openTasks(u);
    } else if (a === 'remove') {
      const r = await api('accounts/' + encodeURIComponent(u) + '/remove', { method: 'POST' });
      toast(r.file_error ? '已移除（凭证文件删除失败：' + r.file_error + '）' : '已移除', 'ok');
    }
  } catch (e) { toast(e.message, 'err'); }
  finally { b.disabled = false; loadOverview(true); }
});

$('btnCheckinAll').onclick = async () => {
  try { await api('checkin_all', { method: 'POST' }); toast('全部签到已开始，结果见日志', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
$('btnKeepaliveAll').onclick = async () => {
  try { await api('keepalive_all', { method: 'POST' }); toast('全部保活已开始，结果见日志', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
$('btnTravelAll').onclick = async () => {
  try { await api('travel_all', { method: 'POST' }); toast('旅行巡检已开始（含领养链路），结果见日志', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
$('btnActivityAll').onclick = async () => {
  try { await api('activity_all', { method: 'POST' }); toast('活跃上报已开始，结果见日志', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};

/* ── 模型 ─────────────────────────────────────────────────────────── */
async function loadModels() {
  const tb = $('mdBody');
  tb.innerHTML = '<tr><td colspan="7"><div class="empty">正在向上游查询…</div></td></tr>';
  try {
    const d = await api('models');
    const list = d.models || [];
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7"><div class="empty">上游未返回模型</div></td></tr>'; return; }
    tb.innerHTML = list.map(m => {
      const eff = (m.supported_efforts || []).slice();
      if (m.can_disable_thinking && eff.length && !eff.includes('off')) eff.push('off（可关）');
      const effs = eff.length ? eff.map(e => '<span class="tag warn">' + esc(e) + '</span>').join(' ')
        : '<span style="color:var(--ink-3);font-size:12.5px">' + (m.supports_reasoning ? '固定档 · 默认 ' + esc(m.default_effort || '?') : '不支持思考') + '</span>';
      return '<tr><td class="mark" aria-hidden="true"><i></i></td><td class="who"><div class="nm">' + esc(m.id) + '</div><div class="id">' + esc(m.name || '') + '</div></td>' +
        '<td class="num">' + (m.credits ? esc(m.credits) : '—') + '</td>' +
        '<td>' + (m.default_effort ? '<span class="tag ok">' + esc(m.default_effort) + '</span>' : '<span style="color:var(--ink-3)">—</span>') + '</td>' +
        '<td class="efs" style="white-space:normal">' + effs + '</td>' +
        '<td class="num">' + (m.context_length ? Math.round(m.context_length / 1000) + 'K' : '—') + '</td>' +
        '<td class="num">' + (m.max_output_tokens ? Math.round(m.max_output_tokens / 1000) + 'K' : '—') + '</td></tr>';
    }).join('');
    $('mdNote').textContent = list.length + ' 个模型 · 已刷新降级缓存';
  } catch (e) {
    tb.innerHTML = '<tr><td colspan="7"><div class="empty">' + esc(e.message) + '</div></td></tr>';
  }
}
$('btnModels').onclick = loadModels;

/* ── 日志（频道：全部/任务/对话/系统） ─────────────────────────────── */
let logCh = 'all';
$('logChips').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-ch]');
  if (!b) return;
  logCh = b.dataset.ch;
  document.querySelectorAll('#logChips .chip').forEach(c => c.classList.toggle('on', c === b));
  loadLogs();
});
async function loadLogs() {
  const box = $('logBox');
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  try {
    const d = await api('logs');
    const entries = (d.entries || []).filter(e => logCh === 'all' || e.ch === logCh);
    box.innerHTML = entries.length
      ? entries.map(e => {
        const lvl = /error|失败|错误/.test(e.text) ? ' e' : /warn|冷却|熔断/.test(e.text) ? ' w' : '';
        const t = e.ts ? new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        const ch = logCh === 'all' ? '<i class="lch c-' + esc(e.ch) + '">' + ({ task: '任务', chat: '对话', sys: '系统' }[e.ch] || e.ch) + '</i>' : '';
        return '<span class="ln' + lvl + '">' + ch + esc(t + ' ' + e.text) + '</span>';
      }).join('')
      : '<span style="color:var(--ink-3)">暂无日志</span>';
    if (logPin && atEnd) box.scrollTop = box.scrollHeight;
    const counts = {};
    for (const e of (d.entries || [])) counts[e.ch] = (counts[e.ch] || 0) + 1;
    $('logNote').textContent = logCh === 'all'
      ? '任务 ' + (counts.task || 0) + ' · 对话 ' + (counts.chat || 0) + ' · 系统 ' + (counts.sys || 0)
      : (logCh === 'task' ? '任务' : logCh === 'chat' ? '对话' : '系统') + ' ' + entries.length + ' 行';
  } catch (e) { /* 概览已提示 */ }
}
$('btnLogPin').onclick = () => {
  logPin = !logPin;
  $('btnLogPin').textContent = '自动滚动：' + (logPin ? '开' : '关');
};

/* ── 用量统计 ─────────────────────────────────────────────────────── */
/* 动效策略（一次编排，而非散落的过渡）：
   - 只动 transform / opacity / 数字，不碰 width/height/top：不触发重排；
   - 只在首次绘制、切换口径、重新进入本页时播放：5s 的静默刷新只更新数值，
     否则画面每 5 秒抖一次，读表的人会被自己的面板烦到；
   - prefers-reduced-motion 下直接落终态：CSS 里那条媒体查询只关得住 transition
     与 animation，关不住这里的 rAF 补间，必须显式判一次。 */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const easeOut = p => 1 - Math.pow(1 - p, 3);

// FMT 数值格式化表：数字滚动与静态渲染共用同一套口径，避免两处写法漂移。
// 只列统计页真正会滚动的几种量（耗时没有滚动展示位，故不收在这里）。
const FMT = {
  tok: formatTokenCount,
  int: formatInt,
  rate: v => (Number(v) || 0).toFixed(1) + ' tok/s',
};

// formatInt 千分位。请求次数动辄四位数，裸数字读不出量级；token 在"万"以下也复用它，
// 免得同一行里出现 "5,948 次" 与 "5948" 两种写法。
function formatInt(n) {
  n = Math.round(Number(n) || 0);
  return n >= 1000 ? n.toLocaleString('en-US') : String(n);
}

// tween 进度补间：fn 收缓动后的 0..1。起点恒为 0 而不读元素当前值——
// 重复触发时起点不会漂移（"从当前值开始"会让连点后的动画越缩越短）。
function tween(dur, fn, done) {
  if (reduceMotion.matches) { fn(1); if (done) done(); return; }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    fn(easeOut(p));
    if (p < 1) requestAnimationFrame(step); else if (done) done();
  };
  requestAnimationFrame(step);
}

// staggerTween 对 n 个目标错峰补间：第 i 个延后 i*gap 开始、各跑 dur。
// 末尾强制补一帧 local=1：否则最后一帧可能停在 0.98，柱子就"差一点长不到顶"。
function staggerTween(n, dur, gap, fn, done) {
  if (n <= 0) { if (done) done(); return; }
  if (reduceMotion.matches) { for (let i = 0; i < n; i++) fn(i, 1); if (done) done(); return; }
  const total = dur + gap * (n - 1);
  const t0 = performance.now();
  const step = now => {
    const el = now - t0;
    if (el >= total) { for (let i = 0; i < n; i++) fn(i, 1); if (done) done(); return; }
    for (let i = 0; i < n; i++) fn(i, easeOut(Math.max(0, Math.min(1, (el - i * gap) / dur))));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// timeline 串行执行各段（段形如 (done) => void）。编排集中在一处，
// 避免散落的 setTimeout 互相打架。
function timeline(steps) {
  const run = i => { if (i < steps.length) steps[i](() => run(i + 1)); };
  run(0);
}

// mdOf 日期键 "2026-09-18" → "09-18"（轴上只留月日，年份对近 30 天无信息量）。
function mdOf(day) { return String(day).slice(5); }

// setNum 落终态并把目标值记在 dataset 上：入场动效据此从 0 滚到目标，
// 静默刷新只需重新调用本函数。
function setNum(el, value, fmt) {
  const to = Number(value) || 0;
  el.dataset.to = String(to);
  el.dataset.fmt = fmt;
  el.textContent = FMT[fmt](to);
}

// syncRangeChips 口径按钮的选中态以 statsRng 为唯一来源。HTML 里预置的 .on 只是
// 无 JS 时的兜底外观——两处各写一份默认值迟早会漂移（改了 JS 默认值却忘了改 HTML，
// 页面就会出现"高亮着 30 天、数据却是今日"的错位）。
function syncRangeChips() {
  document.querySelectorAll('#rngChips .chip').forEach(c => c.classList.toggle('on', c.dataset.rng === statsRng));
}

$('rngChips').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-rng]');
  if (!b || b.dataset.rng === statsRng) return;
  statsRng = b.dataset.rng;
  syncRangeChips();
  statsPainted = false; // 换口径 = 换内容，值得重播一次入场
  loadStats(false);
});
syncRangeChips();

async function loadStats(quiet) {
  try {
    const d = await api('stats?range=' + encodeURIComponent(statsRng));
    statsData = d;
    renderStats(d, !statsPainted);
    statsPainted = true;
  } catch (e) {
    // 501（统计被 config 关掉）与网络错误都走这里：把话说在读数槽与空表里，
    // 而不是留一页"看着正常但一个数字都没有"的假象。
    statsUnavailable(e.message);
    if (!quiet) toast(e.message, 'err');
  }
}

// lifetimeFootnote 头条脚注：说清"这个数是哪段时间的"，并把池的历史总账作为
// 参照附上。两个口径的差别（有无按日明细）必须写在脸上——此前只标了口径名，
// 用户第一眼仍读成"顶部有数、下面全空 = 页面坏了"。
function lifetimeFootnote(ss, pt) {
  const hist = pt.total_tokens > 0
    ? '；账号历史总账 ' + formatTokenCount(pt.total_tokens) + '（统计启用前，无按日明细）'
    : '';
  return ss.since
    ? '自 ' + mdOf(ss.since) + ' 起累计（' + (ss.active_accounts || 0) + ' 个账号），不随统计保留窗口缩减' + hist
    : '尚未统计到请求：网关首次转发后开始累积' + hist;
}

// statsUnavailable 统计取不到时的整页降级态。
function statsUnavailable(msg) {
  for (const id of ['ltTotal', 'ltPrompt', 'ltCompletion', 'ltRequests', 'ltAccounts',
    'stTotal', 'stPrompt', 'stCompletion', 'stRequests', 'stFailed', 'stRate']) {
    const el = $(id);
    el.textContent = '—';
    delete el.dataset.to;
  }
  // 图表状态一并清空：否则鼠标移出图表区触发的 selectPoint(-1) 会用上一轮的峰值
  // 覆写掉这里的错误提示，用户看到的就是"报错一闪而过，变成一组旧数字"。
  chartPts = [];
  chartPeak = null;
  chartPeakIdx = -1;
  $('stFailCell').className = 'stat';
  $('stFailK').textContent = '失败';
  $('chartReadout').textContent = msg;
  $('chartPlot').innerHTML = '';
  $('chartStrip').innerHTML = '';
  $('chartScale').innerHTML = '';
  $('chartUnit').textContent = '';
  $('rngNote').textContent = '';
  $('mdStatNote').textContent = '';
  $('acStatNote').textContent = '';
  const row = '<tr><td colspan="6"><div class="empty"><div class="big">统计不可用</div>' + esc(msg) + '</div></td></tr>';
  $('mdStatBody').innerHTML = row;
  $('acStatBody').innerHTML = row;
}

function renderStats(d, animate) {
  const t = d.totals || {}, ss = d.since_start || {}, pt = d.pool_total || {};

  /* 累计头条：口径是"自统计启用起"，与下方时间序列同一个聚合器——头条与区间因此
     永远自洽，不会出现"上面有数、下面全空"的观感。
     池的历史总账（含统计功能上线之前的部分）降级进脚注：它只有总数、没有按日明细，
     摆成头条只会让人以为页面自相矛盾。 */
  setNum($('ltTotal'), ss.total_tokens, 'tok');
  setNum($('ltPrompt'), ss.prompt_tokens, 'tok');
  setNum($('ltCompletion'), ss.completion_tokens, 'tok');
  setNum($('ltRequests'), ss.requests, 'int');
  setNum($('ltAccounts'), ss.active_accounts, 'int');
  $('ltFoot').textContent = lifetimeFootnote(ss, pt);

  /* 区间观测条。 */
  const reqs = t.requests || 0, failed = t.failed || 0;
  setNum($('stTotal'), t.total_tokens, 'tok');
  setNum($('stPrompt'), t.prompt_tokens, 'tok');
  setNum($('stCompletion'), t.completion_tokens, 'tok');
  setNum($('stRequests'), reqs, 'int');
  setNum($('stFailed'), failed, 'int');
  // 平均速率：区间聚合吞吐（生成 token / 累计耗时），无数据时显示 "—"。
  if (t.avg_tokens_per_sec > 0) setNum($('stRate'), t.avg_tokens_per_sec, 'rate');
  else { $('stRate').textContent = '—'; delete $('stRate').dataset.to; }
  $('stFailCell').className = 'stat' + (failed > 0 ? ' bad' : '');
  $('stFailK').textContent = failed > 0 && reqs > 0
    ? '失败 · 成功率 ' + (t.success_rate * 100).toFixed(1) + '%'
    : '失败';

  /* 口径说明：统计文件实际覆盖到哪一段，说清楚而不是让用户猜"为什么只有两天数据"。
     覆盖度按"天"计（Days/Covered 都是日粒度）——写"小时"会让今日视图读成
     "覆盖 1 / 1 小时"，那是柱子的粒度，不是覆盖范围。 */
  const notes = [];
  if (d.first_day) notes.push('统计自 ' + mdOf(d.first_day) + ' 起');
  notes.push('覆盖 ' + (d.covered_days || 0) + ' / ' + (d.days || 0) + ' 天');
  if (d.keep_days) notes.push('保留 ' + d.keep_days + ' 天');
  $('rngNote').textContent = notes.join(' · ');

  renderChart(d, animate);
  renderStatTables(d);
  $('chartUnit').textContent = (d.unit === 'hour' ? '按小时（CST）' : '按自然日（CST）')
    + (chartPeak ? ' · 峰值 ' + formatTokenCount(chartPeak.tokens) + ' @ ' + chartPeak.label : '');

  if (animate) playStatsIntro();
}

// chartPeak 当前图上的峰值点（给整张图一个量级参照，无刻度的柱图读不出大小）。
// 状态本身声明在文件顶部的状态区，这里只消费。
function renderChart(d, animate) {
  const pts = d.series || [];
  const plot = $('chartPlot'), strip = $('chartStrip'), scale = $('chartScale');
  chartPts = pts;
  chartPeak = null;
  const maxT = Math.max(1, ...pts.map(p => p.total_tokens || 0));
  const maxR = Math.max(1, ...pts.map(p => p.requests || 0));

  chartPeakIdx = -1;
  pts.forEach((p, i) => {
    if ((p.total_tokens || 0) > 0 && (chartPeakIdx < 0 || p.total_tokens > pts[chartPeakIdx].total_tokens)) chartPeakIdx = i;
  });
  if (chartPeakIdx >= 0) {
    const pk = pts[chartPeakIdx];
    chartPeak = {
      tokens: pk.total_tokens,
      label: d.unit === 'hour' ? pk.key + ' 时' : mdOf(pk.key),
    };
  }

  plot.innerHTML = pts.map((p, i) => {
    const tok = p.total_tokens || 0;
    const h = tok > 0 ? Math.max(3, Math.round(tok / maxT * 100)) : 0;
    const cls = 'col' + (tok > 0 ? '' : ' zero') + (i === chartPeakIdx ? ' peak' : '');
    return '<div class="' + cls + '" data-i="' + i + '" tabindex="0" aria-label="' +
      esc(pointSegs(d, i).join(' · ')) + '" style="--h:' + h + '%"><i class="fill"></i></div>';
  }).join('');

  strip.innerHTML = pts.map(p => {
    const r = p.requests || 0;
    const h = r > 0 ? Math.max(8, Math.round(r / maxR * 100)) : 0;
    return '<div class="col-r"><i class="r' + (r > 0 ? '' : ' zero') + '" style="--r:' + h + '%"></i></div>';
  }).join('');

  // 刻度：按列数取约 7 个位置（24 小时取每 3 小时）。末尾必标，但若离前一个标签
  // 太近就跳过它——窄屏上两个标签贴在一起比少一个标签难读得多。
  const n = pts.length;
  const step = n > 12 ? Math.ceil(n / 7) : 1;
  scale.innerHTML = pts.map((p, i) => {
    const label = d.unit === 'hour' ? p.key : mdOf(p.key);
    if (i === n - 1) return '<span>' + esc(label) + '</span>';
    if (i % step || (n - 1 - i) < step * 0.6) return '<span></span>';
    return '<span>' + esc(label) + '</span>';
  }).join('');

  // 入场起点：柱体与量条先压到 0（在首帧渲染前设好，避免"先满高再缩回"的闪跳）。
  const fills = plot.querySelectorAll('.fill');
  if (animate) fills.forEach(f => f.style.transform = 'scaleY(0)');

  // 空序列（range=all 且统计文件里还没有任何一天）与"整区间零请求"（刚上线、还没流量）
  // 都要显式写空态：前者 selectPoint 会提前返回留下上一轮读数，后者会显示某一天的
  // "无请求"——都没回答"这一页为什么是空的"。
  const hasAny = pts.some(p => (p.requests || 0) > 0);
  if (!pts.length) $('chartReadout').textContent = '统计区间内还没有记录';
  else if (!hasAny) $('chartReadout').textContent = '区间内还没有请求记录（网关首次转发后开始累积）';
  else selectPoint(-1);
}

// pointSegs 某个时间点的明细分段（读数槽、柱子 aria-label、空态共用一套取数）。
function pointSegs(d, i) {
  const p = (d.series || [])[i];
  if (!p) return ['—'];
  const label = d.unit === 'hour' ? p.key + ' 时' : mdOf(p.key);
  if (!p.requests) return [label, '无请求'];
  const seg = [label, formatTokenCount(p.total_tokens) + ' tok', formatInt(p.requests) + ' 次'];
  if (p.failed) seg.push('失败 ' + formatInt(p.failed));
  return seg;
}

// pointReadout 读数槽用的 HTML：token 数值与失败数是这一段里唯一需要抢眼的两个值。
function pointReadout(d, i) {
  const seg = pointSegs(d, i);
  if (seg.length > 2) seg[1] = '<b>' + seg[1].replace(/ tok$/, '') + '</b> tok';
  if (seg[seg.length - 1].startsWith('失败')) {
    seg[seg.length - 1] = '<span class="bad">' + seg[seg.length - 1] + '</span>';
  }
  return seg.join(' · ');
}

// selectPoint 高亮第 i 个点并刷新读数槽；i < 0 回到峰值点（图上永远有一个读数）。
function selectPoint(i) {
  $('chartPlot').querySelectorAll('.col').forEach(c => c.classList.toggle('on', Number(c.dataset.i) === i));
  if (!chartPts.length) return;
  $('chartReadout').innerHTML = pointReadout(statsData, i >= 0 ? i : Math.max(0, chartPeakIdx));
}
$('chartPlot').addEventListener('mouseover', ev => {
  const c = ev.target.closest('.col');
  if (c) selectPoint(Number(c.dataset.i));
});
$('chartPlot').addEventListener('mouseleave', () => selectPoint(-1));
$('chartPlot').addEventListener('focusin', ev => {
  const c = ev.target.closest('.col');
  if (c) selectPoint(Number(c.dataset.i));
});
$('chartPlot').addEventListener('focusout', () => selectPoint(-1));

// paintStatFinals 把所有观测数字落回 dataset 里记录的目标值。setNum 渲染时已经写过
// 一次终态，这里是给动效兜底用的（见 playStatsIntro 的定时器）。
function paintStatFinals() {
  for (const el of statNumEls()) {
    if (el.dataset.to != null) el.textContent = FMT[el.dataset.fmt](Number(el.dataset.to));
  }
}

// statNumEls 统计页上参与"滚动"的数字（观测条 + 累计头条），其余表格数字不参与
// 动效——表格每 5 秒重绘一次，跟着跳数字会让人没法读。
function statNumEls() {
  return [...$('view-stats').querySelectorAll('.stat .v')]
    .concat([$('ltTotal'), $('ltPrompt'), $('ltCompletion'), $('ltRequests'), $('ltAccounts')]);
}

// playStatsIntro 入场编排：读数先滚起来，柱图与量条随后生长（两处并行，各占一片区域）。
let statsIntroToken = 0;
function playStatsIntro() {
  const token = ++statsIntroToken;
  const nums = statNumEls().filter(el => el.dataset.to != null);
  const fills = [...$('chartPlot').querySelectorAll('.fill')];
  const bars = [...$('view-stats').querySelectorAll('.bar i')];
  // 量条从 0 开始长：起始状态在首帧前设好。
  bars.forEach(b => b.style.transform = 'scaleX(0)');

  timeline([
    done => tween(420, p => {
      if (token !== statsIntroToken) { done(); return; } // 已被新一轮渲染接管：别再写旧值
      for (const el of nums) el.textContent = FMT[el.dataset.fmt](Number(el.dataset.to) * p);
    }, done),
    done => {
      // 两处并行：柱图在左、量条在右，同时启动比串行更利落；全部结束才推进下一段。
      let left = 2;
      const fin = () => { if (--left === 0) done(); };
      // 30 根柱子若每根错峰 16ms 会拖到 740ms，故把总错峰压到 ≈260ms 以内。
      const gap = fills.length > 1 ? Math.min(16, 260 / (fills.length - 1)) : 0;
      staggerTween(fills.length, 280, gap, (i, p) => { fills[i].style.transform = 'scaleY(' + p + ')'; }, fin);
      staggerTween(bars.length, 320, 26, (i, p) => { bars[i].style.transform = 'scaleX(' + p + ')'; }, fin);
    },
  ]);

  // 兜底落终态：rAF 在后台标签页与被截图的浏览器里会被暂停，补间可能永久停在中间值上，
  // 页面就会显示"错的数字"（889.2m 而真值是 1.1b）——统计页宁可不动效也不能停错数。
  // 目标值取自 dataset（每轮渲染都会刷新），故晚到的兜底写入不会写回过期数据。
  setTimeout(() => { if (token === statsIntroToken) paintStatFinals(); }, 1600);
}

// renderStatTables 模型分布与账号用量两张排行表（同一套 .acc 表格语言，
// 占比列复用账号表的抖动量条）。
// token 字段一律走 `|| 0`：聚合桶的 json tag 带 omitempty（落盘体积所必需），
// 零值字段在报文里是缺键而不是 0，直接交给 formatTokenCount 会渲染成 "—"。
function renderStatTables(d) {
  const models = d.by_model || [];
  const accounts = d.by_account || [];
  $('mdStatBody').innerHTML = models.length ? models.map(m => {
    const pct = Math.round((m.share || 0) * 1000) / 10;
    return '<tr><td class="mark" aria-hidden="true"></td>' +
      '<td class="who"><div class="nm">' + esc(m.key) + '</div></td>' +
      '<td class="num">' + formatTokenCount(m.total_tokens || 0) + '</td>' +
      '<td class="cred" title="占区间总量 ' + pct + '%"><div class="n">' + pct + '%</div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div></td>' +
      '<td class="num">' + formatInt(m.requests) + '</td>' +
      '<td class="num" style="color:var(--ink-3)">' + formatTokenCount(m.prompt_tokens || 0) + ' / ' + formatTokenCount(m.completion_tokens || 0) + '</td></tr>';
  }).join('') : '<tr><td colspan="6"><div class="empty">区间内没有调用记录</div></td></tr>';
  $('mdStatNote').textContent = models.length ? models.length + ' 个模型' : '';

  $('acStatBody').innerHTML = accounts.length ? accounts.map(a => {
    const pct = Math.round((a.share || 0) * 1000) / 10;
    const name = a.label ? esc(a.label) : '<span style="color:var(--ink-3)">未命名</span>';
    const short = a.key.length > 16 ? a.key.slice(0, 16) + '…' : a.key;
    return '<tr><td class="mark" aria-hidden="true"></td>' +
      '<td class="who" title="uid: ' + esc(a.key) + '"><div class="nm">' + name + '</div>' +
      '<div class="id">' + esc(short) + '</div></td>' +
      '<td class="num">' + formatTokenCount(a.total_tokens || 0) + '</td>' +
      '<td class="cred" title="占区间总量 ' + pct + '%"><div class="n">' + pct + '%</div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div></td>' +
      '<td class="num">' + formatInt(a.requests) + '</td>' +
      '<td class="num" style="color:' + (a.failed ? 'var(--bad)' : 'var(--ink-3)') + '">' + formatInt(a.failed) + '</td></tr>';
  }).join('') : '<tr><td colspan="6"><div class="empty">区间内没有调用记录</div></td></tr>';
  $('acStatNote').textContent = accounts.length ? accounts.length + ' 个账号' : '';
}

/* ── 配置 ─────────────────────────────────────────────────────────── */
const CFG_MAP = {
  listen: ['listen'], api_key: ['api_key'],
  checkin_hours: ['schedule', 'checkin_hours'], checkin_enabled: ['schedule', 'checkin_enabled'],
  travel_hours: ['schedule', 'travel_hours'], travel_enabled: ['schedule', 'travel_enabled'],
  activity_hours: ['schedule', 'activity_hours'], activity_enabled: ['schedule', 'activity_enabled'],
  keepalive_hours: ['schedule', 'keepalive_hours'], keepalive_enabled: ['schedule', 'keepalive_enabled'],
  balance_refresh_enabled: ['schedule', 'balance_refresh_enabled'], balance_refresh_minutes: ['schedule', 'balance_refresh_minutes'],
  max_body_mb: ['server', 'max_body_mb'],
  max_in_flight: ['pool', 'max_in_flight'], breaker_threshold: ['pool', 'breaker_threshold'],
  soft_rate: ['cooldown', 'soft_rate'], soft_rate_max: ['cooldown', 'soft_rate_max'],
  breaker_cooldown: ['pool', 'breaker_cooldown'], breaker_cooldown_max: ['pool', 'breaker_cooldown_max'],
  idle_weight_per_hour: ['pool', 'idle_weight_per_hour'], idle_weight_max: ['pool', 'idle_weight_max'],
  ttl: ['session_sticky', 'ttl'],
  timeout_seconds: ['upstream', 'timeout_seconds'], header_timeout_seconds: ['upstream', 'header_timeout_seconds'],
  idle_timeout_seconds: ['upstream', 'idle_timeout_seconds'], user_agent: ['upstream', 'user_agent'],
  prompt_mode: ['prompt', 'mode'], prompt_file: ['prompt', 'file'],
  sanitize_blacklist_fingerprints: ['features', 'sanitize_blacklist_fingerprints'],
  session_sticky_enabled: ['session_sticky', 'enabled'],
  stats_enabled: ['stats', 'enabled'], stats_keep_days: ['stats', 'keep_days'],
};
function dig(obj, path) { return path.reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function put(obj, path, val) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) { if (typeof o[path[i]] !== 'object' || o[path[i]] === null) o[path[i]] = {}; o = o[path[i]]; }
  o[path[path.length - 1]] = val;
}

async function loadConfig() {
  try {
    const d = await api('config');
    cfgLoaded = d.config;
    $('cfgPath').textContent = d.path || '';
    const f = $('cfgForm');
    for (const [name, path] of Object.entries(CFG_MAP)) {
      const el = f.elements[name];
      if (!el) continue;
      const v = dig(cfgLoaded, path);
      if (el.type === 'checkbox') el.checked = !!v;
      else if (Array.isArray(v)) el.value = v.join(', ');
      else el.value = v == null ? '' : v;
    }
    $('cfgNote').textContent = '';
  } catch (e) { toast('读取配置失败：' + e.message, 'err'); }
}
function collectConfig() {
  const f = $('cfgForm'), out = {};
  for (const [name, path] of Object.entries(CFG_MAP)) {
    const el = f.elements[name];
    if (!el) continue;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') { v = el.value.trim() === '' ? undefined : Number(el.value); }
    else {
      const raw = el.value.trim();
      if (raw === '') v = undefined;
      else if (name.endsWith('_hours')) v = raw.split(/[,，\s]+/).filter(Boolean).map(Number);
      else v = raw;
    }
    if (v !== undefined) put(out, path, v);
  }
  return out;
}
$('btnEye').onclick = () => {
  const el = $('cfgKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('btnEye').textContent = show ? '隐藏' : '显示';
};
$('btnCfgReload').onclick = loadConfig;
$('cfgForm').onsubmit = async ev => {
  ev.preventDefault();
  const btn = $('btnCfgSave');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await api('config', { method: 'POST', body: JSON.stringify(collectConfig()) });
    const n = (r.restart_required || []).length;
    toast(n ? '配置已保存，其中 ' + n + ' 项需重启进程生效' : '配置已保存并立即生效', 'ok');
    // 密钥可能已改：本次会话沿用新值，避免下一次轮询被 401。
    const k = $('cfgKey').value.trim();
    if (k) localStorage.setItem(LS_KEY, k);
    loadConfig();
    loadOverview(true);
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '保存配置'; }
};

/* ── 添加账号 ─────────────────────────────────────────────────────── */
function openAdd() {
  $('addVeil').classList.add('on');
  // 重置到选域态：选域可见、加载/就绪/完成/错误全收，起始按钮亮起。
  $('addPick').hidden = false;
  $('addLoad').hidden = true; $('addReady').hidden = true;
  $('addDone').hidden = true; $('addErr').hidden = true;
  $('btnCopyUrl').hidden = true; $('btnOpenUrl').hidden = true;
  $('btnStartLogin').hidden = false; $('btnStartLogin').disabled = false;
  stopPoll();
}
function startAddLogin() {
  const realm = (document.querySelector('input[name="addRealm"]:checked') || {}).value || 'cn';
  $('btnStartLogin').disabled = true;
  $('addLoad').hidden = false; $('addErr').hidden = true;
  api('login/start', { method: 'POST', body: JSON.stringify({ realm }) }).then(r => {
    loginState = r.state;
    $('addUrl').textContent = r.url;
    $('addPick').hidden = true; // 选域锁定（会话已按该域发起）
    $('addLoad').hidden = true; $('addReady').hidden = false;
    $('btnStartLogin').hidden = true;
    $('btnCopyUrl').hidden = false; $('btnOpenUrl').hidden = false;
    loginTimer = setInterval(pollLogin, 3000);
  }).catch(e => {
    $('addLoad').hidden = true;
    $('btnStartLogin').disabled = false;
    $('addErr').hidden = false;
    $('addErr').textContent = e.message;
  });
}
function stopPoll() { if (loginTimer) { clearInterval(loginTimer); loginTimer = null; } }
async function pollLogin() {
  if (!loginState) return;
  try {
    const r = await api('login/poll?state=' + encodeURIComponent(loginState));
    if (r.done) {
      stopPoll();
      $('addReady').hidden = true;
      $('addDone').hidden = false;
      $('addDone').textContent = '已添加 ' + (r.nickname || r.uid) + (r.realm === 'global' ? '（国际版）' : '') + (r.credits >= 0 ? ' · 积分 ' + r.credits + (r.credits_total > 0 ? '/' + r.credits_total : '') : '') + '，账号已载入池中';
      setTimeout(() => { closeAdd(); loadOverview(true); }, 1600);
    }
  } catch (e) {
    stopPoll();
    $('addReady').hidden = true;
    $('addErr').hidden = false;
    $('addErr').textContent = e.message + '（关闭后重新添加）';
  }
}
function closeAdd() { stopPoll(); loginState = null; $('addVeil').classList.remove('on'); }
$('btnCloseAdd').onclick = closeAdd;
$('btnStartLogin').onclick = startAddLogin;
$('btnOpenUrl').onclick = () => open($('addUrl').textContent, '_blank');
$('btnCopyUrl').onclick = () => navigator.clipboard.writeText($('addUrl').textContent)
  .then(() => toast('链接已复制', 'ok'), () => toast('复制失败，请手动选择复制', 'err'));

/* ── 顶部动作 ─────────────────────────────────────────────────────── */
$('btnAdd').onclick = openAdd;
$('btnRefresh').onclick = async () => {
  const b = $('btnRefresh');
  b.disabled = true; b.textContent = '刷新中…';
  try {
    await api('balance_all', { method: 'POST' });
    await loadOverview(true);
    toast('余额已从上游刷新', 'ok');
  } catch (e) { toast('刷新失败：' + e.message, 'err'); await loadOverview(true); }
  finally { b.disabled = false; b.textContent = '刷新'; }
  if (view === 'logs') loadLogs();
};

/* ── 轮询 ─────────────────────────────────────────────────────────── */
function refreshVisible() {
  if (view === 'accounts') loadOverview(true);
  else if (view === 'logs') loadLogs();
  else if (view === 'stats') loadStats(true);
  else if (view === 'taskscenter') pollQueueOnce();
}
function start() {
  loadOverview(true);
  if (refTimer) clearInterval(refTimer);
  refTimer = setInterval(refreshVisible, 5000);
  checkAuthGate();
}
async function checkAuthGate() {
  try { await api('overview'); }
  catch (e) { if (String(e.message).includes('密钥') || String(e.message).includes('api_key')) return; }
}
start();

/* ── 积分任务 ─────────────────────────────────────────────────────── */
let taskUID = null;

// 可自动完成的任务（与后端 autoActions 表一致）：判据为行为事件、可经网关复现。
// 其余任务需在官方客户端内交互，面板只展示指引（行 title 提示）。
// 注意：键含点号（Model_chat_GLM5.2）必须加引号，否则会被解析成属性访问 + 数字字面量。
const AUTO_TASKS = {
  'chat_5': '上报 5 条对话活跃事件（自动补足差额）',
  'first_buddy': '上报解锁 → 同意协议 → 领取第一只 Buddy',
  'Model_chat_GLM5.2': '接受任务 → glm-5.2 真实对话一次 → 对齐模型上报',
  'RichMeow_Chat': '桌面指纹事件链上报（已验证可点亮）',
  'Buddy_App': '上报「进入 Buddy 应用」事件链（已验证可点亮）',
  'Buddy_App_QQ': '上报「进入企鹅教师助手」事件链（已验证可点亮）',
  'automation_1': '上报「定时任务创建」事件（已验证可点亮）',
  'Library_read': '上报「读资料库介绍」事件（已验证可点亮）',
  'template_5': '上报「使用模板创建任务」事件组 ×5（三账号实测点亮）',
  'playbook_prompt': '上报「灵感案例做同款发送 Prompt」事件组（三账号实测点亮）',
  'create_canvas': '上报「设计创意画布创建」事件组（三账号实测点亮，+300 分）',
  'expert_5': '真实专家召唤+使用链 ×5（专家市场+真实 chat，三账号实测点亮）',
  'Expert_team_use_3': '真实专家团召唤+使用链 ×3（三账号实测点亮）',
  'Hp_Appearance': '设置主题 API + 皮肤生效事件（两账号实测点亮）',
  'black_cat': '夜猫子：23:00–08:00 窗口内 glm-5.2 对话补足（窗口外提示等 23 点排程）',
  'Expert_lighthouse': '真实轻量云专家召唤+使用链（真实对话 requestId，两账号实测点亮）',
  'skill_1': '真实对话 + skill_info 技能加载事件（实测点亮）'
};

function openTasks(uid) {
  taskUID = uid;
  $('taskWho').textContent = uid.slice(0, 16);
  $('taskVeil').classList.add('on');
  $('btnTaskReload').hidden = false;
  loadTasks();
}
function closeTasks() { $('taskVeil').classList.remove('on'); taskUID = null; }
$('btnCloseTask').onclick = closeTasks;
$('btnTaskReload').onclick = loadTasks;

// 全部接受：把该账号未接受的任务一次性报名（幂等，跳过已接受/已领取）。
$('btnTaskAcceptAll').onclick = async () => {
  if (!taskUID) return;
  const btn = $('btnTaskAcceptAll');
  btn.disabled = true; btn.textContent = '接受中…';
  try {
    const r = await api('accounts/' + encodeURIComponent(taskUID) + '/tasks/accept_all', { method: 'POST' });
    const n = r.accepted || 0;
    if (r.failed && r.failed.length) {
      toast(`已接受 ${n} 个，${r.failed.length} 个被上游拒绝（可重试）`, 'err');
    } else {
      toast(n ? `已接受 ${n} 个任务` : (r.message || '所有任务均已接受'), 'ok');
    }
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '全部接受'; loadTasks(); }
};

// 一键完成全部可自动任务（耗时较长：含真实对话，逐项回读验证）。
$('btnTaskAutoAll').onclick = async () => {
  if (!taskUID) return;
  const btn = $('btnTaskAutoAll');
  if (!confirm('将依次执行：补报对话事件、领取 Buddy、glm-5.2 对话、尝试上报。\n过程约 1-2 分钟（含真实对话），确认继续？')) return;
  btn.disabled = true; btn.textContent = '执行中…';
  try {
    const r = await api('accounts/' + encodeURIComponent(taskUID) + '/tasks/auto_all', { method: 'POST' });
    const okN = (r.results || []).filter(x => x.status === 'done').length;
    const skipN = (r.results || []).filter(x => x.status === 'skipped').length;
    const errN = (r.results || []).filter(x => x.status === 'error').length;
    toast(`执行完成：成功 ${okN} 项，跳过 ${skipN} 项${errN ? '，失败 ' + errN + ' 项' : ''}`, errN ? 'err' : 'ok');
    console.log('auto_all results:', r.results);
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '一键完成可自动任务'; loadTasks(); }
};

async function loadTasks() {
  if (!taskUID) return;
  const st = $('taskState'), tb = $('taskTable');
  st.hidden = false;
  st.className = 'state';
  st.innerHTML = '<span class="dots">查询中</span>';
  tb.hidden = true;
  try {
    const d = await api('accounts/' + encodeURIComponent(taskUID) + '/tasks');
    const list = d.tasks || [];
    if (!list.length) {
      st.className = 'state';
      st.textContent = '该账号暂无任务';
      return;
    }
    // 有进度或可领取的排前面，已领取沉底——一眼看到"现在该做什么"。
    list.sort((a, b) => (a.claimed - b.claimed) || (b.claimable - a.claimable) || String(a.task_code).localeCompare(String(b.task_code)));
    $('taskBody').innerHTML = list.map(t => {
      // 进度：current 可能缺失（0 或被上游省略）——用 ?? 兜底，避免渲染成 "undefined / N"
      const cur = t.current ?? 0, tgt = t.target ?? 0;
      const prog = tgt ? cur + ' / ' + tgt : (tgt === 0 && cur > 0 ? String(cur) : '—');
      const parts = [];
      if (t.credit) parts.push('+' + t.credit + ' 分');
      if (t.energy) parts.push('+' + t.energy + ' 能');
      if (t.reward_buddy) parts.push('Buddy');
      const reward = parts.length ? parts.join(' ') : '—';
      const badge = t.claimed ? '<span class="tag ok">已领取</span>'
        : t.claimable ? '<span class="tag warn">可领取</span>'
        : t.locked ? '<span class="tag mute">未解锁</span>'
        : t.accept_status === 'accepted' ? '<span class="tag mute">进行中</span>'
        : '<span class="tag mute">未接受</span>';
      const acted = t.claimed || t.locked ? ''
        : t.claimable ? '<button class="xs primary" data-t="claim" data-c="' + esc(t.task_code) + '">领取</button>'
        : AUTO_TASKS[t.task_code] ? '<button class="xs primary" data-t="auto" data-c="' + esc(t.task_code) + '" title="' + esc(AUTO_TASKS[t.task_code]) + '">一键完成</button>'
        : t.accept_status === 'accepted' ? ''
        : '<button class="xs" data-t="accept" data-c="' + esc(t.task_code) + '">接受</button>';
      // 操作指引（description/task_desc）挂 title 提示：如何完成交给用户看
      const tip = [t.title, t.task_desc || t.description, t.jump_url ? '跳转：' + t.jump_url : ''].filter(Boolean).join('\n');
      return '<tr title="' + esc(tip) + '"><td class="mark" aria-hidden="true"><i></i></td>' +
        '<td class="who"><div class="nm">' + esc(t.title || t.task_code) + '</div><div class="id">' + esc(t.task_code) + (t.tag ? ' · ' + esc(t.tag) : '') + '</div></td>' +
        '<td class="num">' + esc(prog) + '</td>' +
        '<td class="num">' + esc(reward) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td class="acts">' + acted + '</td></tr>';
    }).join('');
    st.hidden = true;
    tb.hidden = false;
  } catch (e) {
    st.className = 'state err';
    st.textContent = e.message;
  }
}

$('taskBody').addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-t]');
  if (!b || !taskUID) return;
  const kind = b.dataset.t, code = b.dataset.c;
  b.disabled = true;
  try {
    if (kind === 'auto') {
      // 一键完成：后端执行动作 → 回读进度 → 汇报（耗时可到分钟级，含真实对话）
      b.textContent = '执行中…';
      const r = await api('accounts/' + encodeURIComponent(taskUID) + '/tasks/auto', {
        method: 'POST', body: JSON.stringify({ task_code: code })
      });
      if (r.skipped) {
        toast(r.message || '已跳过', 'ok');
      } else {
        const advanced = r.progress_before !== r.progress_after;
        let msg = r.message || '已执行';
        if (r.progress_after) msg += `（进度 ${r.progress_before} → ${r.progress_after}）`;
        if (r.claimed) msg += '，奖励已自动到账';
        else if (r.claimable) msg += r.claim_error ? '，可点「领取」重试' : '';
        else if (r.attempt && !advanced) msg += '；进度未动，该任务可能需要官方客户端';
        toast(msg, (r.claimed || advanced) ? 'ok' : 'err');
      }
      loadOverview(true);
    } else {
      const path = 'accounts/' + encodeURIComponent(taskUID) + '/tasks/' + (kind === 'claim' ? 'claim' : 'accept');
      const body = kind === 'claim' ? { task_code: code } : { task_codes: [code] };
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      toast(kind === 'claim' ? '已领取奖励' : '已接受任务', 'ok');
      if (kind === 'claim') loadOverview(true);
    }
  } catch (e) { toast(e.message, 'err'); }
  finally { loadTasks(); }
});

/* ── 任务中心：开学季 + 全账号扫描/队列 ──────────────────────────── */
const SCHOOL_META = [
  ['share_invite', '分享'],
  ['desktop_chat_1_time', '桌面'],
  ['chat_3_times', '对话×3'],
  ['expert_use', '专家'],
  ['task_student_verify', '认证'],
];
// 开学季任务单元：✓ 已领（绿）｜◐ x/y 进行中（琥珀）｜○ 未做（灰）
function staskHTML(t) {
  if (!t) return '<span class="stask todo"><span class="mark">·</span>—</span>';
  if (t.status === 'claimed') return '<span class="stask ok"><span class="mark">✓</span>已领</span>';
  if (t.status === 'completed') return '<span class="stask warn"><span class="mark">◆</span>可领</span>';
  if (t.status === 'in_progress') {
    const fr = t.target_count ? '<span class="fr">' + t.progress + '/' + t.target_count + '</span>' : '';
    return '<span class="stask warn"><span class="mark">◐</span>' + fr + '</span>';
  }
  return '<span class="stask todo"><span class="mark">○</span>未做</span>';
}
const LUCK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.2 5.2 5 1.8l3 2.4 3-2.4 1.8 3.4-1.4 2.6 1.4 2.6-3.4 2.2H6l-3.4-2.2 1.4-2.6z" opacity=".9"/><circle cx="8" cy="9" r="1.1" fill="currentColor" stroke="none"/></svg>';
async function loadSchoolStatus(quiet) {
  const st = $('schoolState'), list = $('schoolList');
  if (!quiet) { st.hidden = false; st.className = 'state'; st.innerHTML = '<span class="dots">查询中</span>'; list.innerHTML = ''; }
  try {
    const d = await api('school/status');
    const arr = d.accounts || [];
    if (!arr.length) {
      st.hidden = false; st.className = 'state'; st.textContent = '暂无可用账号';
      list.innerHTML = ''; return;
    }
    let allDone = 0;
    const head = '<div class="shead"><div class="who">账号</div><div class="stasks">' +
      SCHOOL_META.map(([, name]) => '<span>' + esc(name) + '</span>').join('') +
      '</div><div class="luck">剩余抽奖</div></div>';
    list.innerHTML = head + arr.map(v => {
      const by = {};
      (v.tasks || []).forEach(t => by[t.task_code] = t);
      const cells = SCHOOL_META.map(([code]) => {
        const t = by[code];
        const html = code === 'task_student_verify'
          ? '<span class="stask todo"><span class="mark">—</span>不做</span>'
          : staskHTML(t);
        return '<span title="' + esc(SCHOOL_TITLES[code] || code) + '">' + html + '</span>';
      }).join('');
      const done = SCHOOL_META.filter(([code]) => code !== 'task_student_verify' && by[code] && by[code].status === 'claimed').length;
      allDone += done === 4 ? 1 : 0;
      return '<div class="srow">' +
        '<div class="who"><div class="nm" title="' + esc(v.nickname || '') + '">' + esc(v.nickname || '未命名') + '</div><div class="id">' + esc(v.uid) + '</div></div>' +
        '<div class="stasks">' + cells + '</div>' +
        '<div class="luck" title="剩余抽奖次数">' + LUCK_SVG + (v.chances == null ? '—' : v.chances) + '</div>' +
        (v.error ? '<div class="err">' + esc(v.error) + '</div>' : '') +
        '</div>';
    }).join('');
    $('schoolSummary').textContent = allDone === arr.length ? '今日全部完成 🎉' : allDone + '/' + arr.length + ' 个账号今日全部完成';
    st.hidden = true;
  } catch (e) {
    st.hidden = false; st.className = 'state err'; st.textContent = e.message;
  }
}
const SCHOOL_TITLES = {
  share_invite: '分享活动 +100c', desktop_chat_1_time: '桌面端体验 +100c（单次）',
  chat_3_times: '和 AI 对话 3 次 +50c', expert_use: '召唤开学季专家 +50c',
  task_student_verify: '学生认证 +100c（需真实认证，不做）',
};
$('btnSchoolRefresh').onclick = () => loadSchoolStatus(false);
$('btnSchoolRunAll').onclick = async () => {
  if (!confirm('将对全部账号执行开学季闭环（分享/桌面/对话/专家 + 抽奖），约 1-2 分钟。确认继续？')) return;
  try {
    await api('school/run_all', { method: 'POST' });
    toast('开学季闭环已开始，结果看任务日志', 'ok');
    setTimeout(() => loadSchoolStatus(true), 15000);
  } catch (e) { toast(e.message, 'err'); }
};

/* 成长任务队列。lastQueueSeq 记录本页启动过的队列代次：执行结束后的残留 items
   （running=false 但 seq 停在旧值）不再回写视图——否则扫描结果 3 秒后被上一轮
   队列状态覆盖。 */
let queueTimer = null, lastQueueSeq = 0;
const GROWTH_TITLES = {}; // code → 展示名（扫描时从任务列表带出）
$('btnScanAll').onclick = async () => {
  const b = $('btnScanAll');
  b.disabled = true; b.textContent = '扫描中…';
  try {
    const d = await api('tasks/scan_all', { method: 'POST' });
    renderQueue(groupItems(d), null, '没有待办任务 🎉', '全部账号的成长任务与开学季活动都已完成，明日再来。');
  } catch (e) { toast(e.message, 'err'); }
  finally { b.disabled = false; b.textContent = '扫描待办'; }
};
$('btnRunQueue').onclick = async () => {
  const conc = Number($('qcConc').value) || 1;
  if (!confirm('扫描全部账号待办并排队执行（账号并发 ' + conc + '，账号内串行）。\n含真实对话的任务耗时较长，确认继续？')) return;
  const b = $('btnRunQueue');
  b.disabled = true; b.textContent = '启动中…';
  try {
    const r = await api('tasks/run_queue', { method: 'POST', body: JSON.stringify({ concurrency: conc }) });
    if (!r.started) { toast(r.message || '没有待办任务', 'ok'); return; }
    lastQueueSeq = r.seq || 0;
    toast('队列已启动：' + r.total + ' 项（并发 ' + conc + '）', 'ok');
    startQueuePolling();
  } catch (e) { toast(e.message, 'err'); }
  finally { b.disabled = false; b.textContent = '执行全部待办'; }
};
// 扫描结果 → 分组条目（无执行状态）
function groupItems(d) {
  const groups = [];
  for (const a of (d.accounts || [])) {
    const rows = [];
    for (const t of (a.growth || [])) {
      GROWTH_TITLES[t.task_code] = t.title || t.task_code;
      rows.push({ kind: 'growth', code: t.task_code, prog: t.target ? t.current + '/' + t.target : '—', status: 'scan' });
    }
    for (const t of (a.school || [])) {
      if (t.task_code === 'task_student_verify') continue; // 需真实认证，永不出现在待办
      rows.push({ kind: 'school', code: t.task_code, prog: t.target_count ? t.progress + '/' + t.target_count : '—', status: 'scan' });
    }
    if (rows.length) groups.push({ uid: a.uid, nick: a.nickname, rows });
  }
  return groups;
}
const ST_WORDS = { done: '完成', running: '执行中', error: '失败', skipped: '跳过', pending: '排队', scan: '待执行' };
function qrowHTML(it) {
  const isSchool = it.kind === 'school';
  const title = isSchool ? '开学季闭环' : (GROWTH_TITLES[it.code] || it.code);
  const dotCls = it.status === 'scan' ? 'wait' : it.status === 'running' ? 'run' : it.status === 'error' ? 'err' : it.status === 'skipped' ? 'skip' : it.status === 'done' ? 'done' : 'wait';
  const stWord = it.status === 'scan' ? '待执行' : (ST_WORDS[it.status] || it.status);
  return '<div class="qrow" title="' + esc(it.message || '') + '">' +
    '<span class="code">' + esc(it.code) + '</span>' +
    '<span class="name"><span class="t">' + esc(title) + '</span>' + (isSchool ? '<span class="tag mute">开学季</span>' : '') + '</span>' +
    '<span class="prog">' + esc(it.prog || '') + '</span>' +
    '<span class="st"><span class="qdot ' + dotCls + '"></span>' + stWord + '</span>' +
    '<span class="msg">' + esc(it.message || '') + '</span>' +
    '</div>';
}
function renderQueue(groups, progress, emptyTitle, emptyDesc) {
  const empty = $('tcEmpty'), list = $('qcList');
  if (!groups.length) {
    empty.style.display = '';
    if (emptyTitle) empty.querySelector('.t').textContent = emptyTitle;
    if (emptyDesc) empty.querySelector('.d').textContent = emptyDesc;
    list.innerHTML = '';
    $('qProg').hidden = true; $('qcSummary').textContent = '';
    return;
  }
  empty.style.display = 'none';
  let total = 0;
  list.innerHTML = groups.map(g => {
    total += g.rows.length;
    return '<div class="qgroup"><header><span class="nm">' + esc(g.nick || g.uid.slice(0, 12)) + '</span><span class="cnt">' + g.rows.length + ' 项待办</span></header>' +
      g.rows.map(qrowHTML).join('') + '</div>';
  }).join('');
  $('qcSummary').textContent = total + ' 项';
  updateProgress(progress);
}
function updateProgress(q) {
  if (!q || !q.items) { $('qProg').hidden = true; return; }
  const total = q.items.length;
  const done = q.items.filter(it => it.status === 'done' || it.status === 'error' || it.status === 'skipped').length;
  $('qProg').hidden = false;
  $('qBarFill').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  $('qProgText').textContent = (q.running ? '执行中 ' : '已结束 ') + done + ' / ' + total;
}
// 队列状态 → 分组（执行时轮询）
function groupsFromQueue(items) {
  const by = new Map();
  for (const it of items) {
    if (!by.has(it.uid)) by.set(it.uid, { uid: it.uid, nick: it.nickname, rows: [] });
    by.get(it.uid).rows.push({
      kind: it.kind, code: it.code,
      prog: it.kind === 'school' ? '—' : '',
      status: it.status, message: it.message,
    });
  }
  return Array.from(by.values());
}
async function pollQueueOnce() {
  try {
    const q = await api('tasks/queue');
    if (!q.started) return;
    // 只渲染本页启动过的那轮队列（q.running 时也要同代次——刷新页面后不再接管旧队列）。
    if (lastQueueSeq && q.seq !== lastQueueSeq) return;
    renderQueue(groupsFromQueue(q.items || []), q);
  } catch (e) { /* 静默 */ }
}
function startQueuePolling() {
  if (queueTimer) clearInterval(queueTimer);
  queueTimer = setInterval(async () => {
    await pollQueueOnce();
    try {
      const q = await api('tasks/queue');
      if (!q.running) {
        clearInterval(queueTimer); queueTimer = null;
        toast('任务队列执行结束', 'ok');
        loadSchoolStatus(true);
      }
    } catch (e) { /* 忽略 */ }
  }, 3000);
}
