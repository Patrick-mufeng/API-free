/* ============================================================
   API-free · 素瓷 · 共享脚本
   toast / 开关 / 复制 / 页签 / 弹层 / 图表 / 格式化 / 跨页导航
   ============================================================ */
(function () {
  'use strict';

  window.$ = function (sel, root) { return (root || document).querySelector(sel); };
  window.$$ = function (sel, root) { return [...(root || document).querySelectorAll(sel)]; };

  /* ---------- toast ---------- */
  let toastBox = null;
  window.toast = function (msg, kind) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.id = 'toasts';
      document.body.appendChild(toastBox);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 3200);
  };

  /* ---------- 开关（role=switch） ---------- */
  window.wireSwitches = function (root) {
    $$('button.sw', root || document).forEach(sw => {
      if (sw.dataset.wired) return;
      sw.dataset.wired = '1';
      sw.addEventListener('click', () => {
        if (sw.disabled) return;
        sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
        sw.dispatchEvent(new CustomEvent('swchange', { bubbles: true }));
      });
    });
  };

  /* ---------- 复制 ---------- */
  window.copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    fallbackCopy(text);
    return Promise.resolve();
  };
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy],[data-copy-text]');
    if (!b) return;
    let val;
    if (b.dataset.copyText != null) val = b.dataset.copyText;
    else {
      const src = b.dataset.copy === 'self' ? b : $(b.dataset.copy);
      val = src ? (src.tagName === 'INPUT' ? src.value : src.textContent) : '';
    }
    if (!val) { flash(b, '无内容'); return; }
    copyText(val).then(() => flash(b, '已复制'));
  });
  function flash(btn, txt) {
    const old = btn.textContent;
    btn.textContent = txt;
    setTimeout(() => { btn.textContent = old; }, 1400);
  }

  /* ---------- 页签 ---------- */
  window.initTabs = function (navSel, onChange) {
    const nav = $(navSel);
    if (!nav) return;
    nav.addEventListener('click', e => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      $$('button', nav).forEach(x => x.classList.toggle('on', x === b));
      $$('.tabpanel').forEach(p => p.classList.toggle('on', p.id === 'tp-' + b.dataset.t));
      if (onChange) onChange(b.dataset.t);
    });
  };

  /* ---------- 弹层 ---------- */
  window.openVeil = function (v) {
    v.classList.add('show'); v.classList.remove('hide');
    const f = v.querySelector('input,button,select,textarea');
    if (f) setTimeout(() => f.focus(), 60);
  };
  window.closeVeil = function (v) {
    v.classList.add('hide');
    setTimeout(() => v.classList.remove('show', 'hide'), 170);
  };
  window.wireVeil = function (v) {
    if (!v || v.dataset.wired) return;
    v.dataset.wired = '1';
    v.addEventListener('click', e => {
      if (e.target === v || e.target.closest('[data-close]')) closeVeil(v);
    });
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('.veil.show').forEach(closeVeil);
  });

  /* ---------- 格式化 ---------- */
  window.fmtInt = n => Number(n || 0).toLocaleString('en-US');
  window.fmtTok = n => {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return fmtInt(n);
  };
  window.ago = ts => {
    if (!ts) return '—';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return Math.floor(s) + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  };
  window.durTxt = s => {
    if (s < 60) return Math.round(s) + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分' + Math.round(s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 时' + Math.round((s % 3600) / 60) + ' 分';
  };

  /* ---------- 跨页导航（iframe → 外壳） ---------- */
  window.nav = function (target) {
    parent.postMessage({ type: 'nav', target: target }, '*');
  };
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-nav]');
    if (!a) return;
    e.preventDefault();
    nav(a.dataset.nav);
  });

  /* ---------- 图表（平滑曲线 + 渐变面积 + 悬停读数） ---------- */
  window.dayLabel = function (i, total) {
    const d = new Date(2026, 9, 6 - (total - 1 - i));
    return (d.getMonth() + 1) + '/' + d.getDate();
  };
  function smoothPath(pts) {
    if (pts.length < 3) return 'M' + pts.map(p => p[0] + ' ' + p[1]).join(' L');
    let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d;
  }
  /**
   * chart(svg, tip, series, mode, labels, opts)
   * series: [{name,color,data:[…]}]  mode: 'area' | 'split'
   * opts.onHover(i, vals) 自定义读数; opts.reqData 请求次数序列（画底部细条）
   */
  window.chart = function (svg, tip, series, mode, labels, opts) {
    opts = opts || {};
    const vb = svg.getAttribute('viewBox').split(/[\s,]+/);
    const W = +vb[2] || 1000, H = +vb[3] || 230, padB = opts.reqData ? 40 : 22, padT = 10;
    const n = series[0].data.length;
    const max = Math.max(1, ...series.flatMap(s => s.data)) * 1.12;
    labels = labels || series[0].data.map((_, i) => dayLabel(i, n));
    const x = i => i / (n - 1) * W, y = v => padT + (1 - v / max) * (H - padT - padB);
    let g = '';
    for (let gi = 1; gi <= 4; gi++) {
      const gy = padT + (H - padT - padB) * gi / 4;
      g += '<line class="grid-line" x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '"/>';
    }
    const marks = [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round(n - 1 - (n - 1) / 4), n - 1];
    marks.forEach(i => {
      g += '<text class="axis-t" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + labels[i] + '</text>';
    });
    const gid = 'g' + Math.random().toString(36).slice(2, 7);
    let paths = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + series[0].color + '" stop-opacity=".22"/>' +
      '<stop offset="1" stop-color="' + series[0].color + '" stop-opacity=".03"/></linearGradient></defs>';
    if (mode === 'area') {
      const d = smoothPath(series[0].data.map((v, i) => [x(i), y(v)]));
      paths += '<path d="' + d + ' L' + W + ' ' + (H - padB) + ' L0 ' + (H - padB) + ' Z" fill="url(#' + gid + ')"/>';
      paths += '<path d="' + d + '" fill="none" stroke="' + series[0].color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
      series.forEach(s => {
        const d = smoothPath(s.data.map((v, i) => [x(i), y(v)]));
        paths += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>';
      });
    }
    let bars = '';
    if (opts.reqData) {
      const rMax = Math.max(1, ...opts.reqData);
      opts.reqData.forEach((v, i) => {
        const h = Math.max(v > 0 ? 2 : 1, v / rMax * 22);
        bars += '<rect x="' + (x(i) - 3) + '" y="' + (H - padB + 14 - h) + '" width="6" height="' + h + '" rx="1.5" fill="rgba(28,28,26,.18)"/>';
      });
    }
    svg.innerHTML = g + '<g class="pl">' + paths + bars + '</g>' +
      '<line class="guide" x1="0" y1="' + padT + '" x2="0" y2="' + (H - padB) + '" stroke="rgba(28,28,26,.2)" stroke-width="1" opacity="0"/>' +
      '<circle class="dot" r="3.5" fill="' + series[0].color + '" stroke="#fff" stroke-width="2" opacity="0"/>';
    svg.style.cursor = 'crosshair';
    svg.onmousemove = ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(px / (W / (n - 1)))));
      const gx = x(i), guide = svg.querySelector('.guide'), dot = svg.querySelector('.dot');
      guide.setAttribute('x1', gx); guide.setAttribute('x2', gx); guide.setAttribute('opacity', '1');
      const vals = series.map(s => s.data[i]);
      const top = mode === 'split' ? vals[0] : vals.reduce((a, b) => a + b, 0);
      dot.setAttribute('cx', gx); dot.setAttribute('cy', y(top)); dot.setAttribute('opacity', '1');
      if (opts.onHover) { tip.innerHTML = opts.onHover(i, vals); }
      else {
        const lbl = series.map(s => '<span style="color:' + s.color + '">●</span> ' + fmtTok(s.data[i])).join('&nbsp; ');
        tip.innerHTML = '<b>' + labels[i] + '</b>' + (mode === 'split' ? lbl : '合计 ' + fmtTok(top));
      }
      tip.style.opacity = '1';
      tip.style.left = (gx / W * r.width) + 'px';
      tip.style.top = (y(top) / H * r.height) + 'px';
    };
    svg.onmouseleave = () => {
      tip.style.opacity = '0';
      svg.querySelector('.guide').setAttribute('opacity', '0');
      svg.querySelector('.dot').setAttribute('opacity', '0');
    };
  };

  /* 初始化通用开关 */
  document.addEventListener('DOMContentLoaded', () => wireSwitches());
})();
