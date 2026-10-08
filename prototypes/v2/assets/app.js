/* ============================================================================
   API-free 统一面板 · demo 共用底座
   - window.DATA      真实数据快照（2026-10-07 17:12，来自运行中的面板 API）
   - window.SAMPLE    「示例密度」序列，仅在界面明确标注「示例数据」时使用
   - window.LOGOS     四家上游服务的官方 logo（data URI）
   - ic()             16px 线性图标集
   - 图表路径工具      linePath / areaPath / smooth / stackTop / bars
   - fmt 数字与时间格式化
   ========================================================================== */
(function () {
  /* ---------- 错误收集（demo 自检用；脚本解析错误也会进这里） ---------- */
  window.__errs = window.__errs || [];
  window.addEventListener('error', (e) => window.__errs.push(String((e && (e.message || e.error)) || e)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e && e.reason)));

  const D = window.DATA;
  const S = window.SAMPLE;

  /* ---------- 页面上下文（右上角常驻说明） ---------- */
  window.CTX = () => ({ real: D.snapshotAt, sample: S ? S.length + ' 天' : '' });

  /* ---------- 图表数据模式 ----------
     real  = 真实快照（默认）
     sample= 示例密度（数据密集形态，界面上必须明确标注为示例）
     split = 真实数据 + 分服务视图（数据源与 real 相同，只是画法不同） */
  let mode = 'real';
  window.chartMode = () => mode;
  window.chartSeries = () => (mode === 'sample' ? S : D.trend);
  window.setChartMode = (m) => { mode = m; window.dispatchEvent(new CustomEvent('chartmode', { detail: m })); };
  window.toggleChartHTML = function (cls) {
    return `<button class="cmtog ${cls || ''}" data-cmtog type="button" title="真实快照只有 10-06 起两天有流量；切到示例可以看到图表在数据密集时的形态（示例数据会明确标注）">
      <span data-cm="real">真实</span><span data-cm="sample">示例密度</span></button>`;
  };
  window.bindToggles = function (root) {
    (root || document).querySelectorAll('[data-cmtog]').forEach((b) => {
      // split 档的数据源同样是真实快照，所以密度开关在 split 下显示「真实」为选中
      const sync = () => b.querySelectorAll('[data-cm]').forEach((s) => s.classList.toggle('on', s.dataset.cm === (mode === 'sample' ? 'sample' : 'real')));
      sync();
      // 视图每次重挂都会走到这里；开关按钮常驻在框架层，重复绑定会让点一下切换多次。
      if (!b._togBound) {
        b._togBound = true;
        b.addEventListener('click', () => { window.setChartMode(mode === 'sample' ? 'real' : 'sample'); });
      }
      if (!b._togSync) { b._togSync = true; window.addEventListener('chartmode', sync); }
    });
  };
  window.isSample = () => mode === 'sample';

  /* ---------- 图标集（16×16 线性，stroke=currentColor） ---------- */
  const ICONS = {
    grid: 'M1.9 1.9h5v5h-5zM9.1 1.9h5v5h-5zM1.9 9.1h5v5h-5zM9.1 9.1h5v5h-5z',
    bars: 'M2.2 13.6h11.6M4.6 13.6V8.4M8 13.6V3.4M11.4 13.6V6.2',
    lines: 'M2.4 3.6h11.2M2.4 8h11.2M2.4 12.4h7.6',
    sliders: 'M2.4 4.6h11.2M2.4 8h11.2M2.4 11.4h11.2',
    server: 'M2.4 2.6h11.2v4.2H2.4zM2.4 9.2h11.2v4.2H2.4zM4.6 4.7h.02M4.6 11.3h.02',
    user: 'M8 7.6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.2 13.6c.5-2.4 2.5-3.7 4.8-3.7s4.3 1.3 4.8 3.7',
    cpu: 'M8 1.9 13.6 5v6L8 14.1 2.4 11V5zM2.4 5 8 8.1 13.6 5M8 8.1v6',
    gauge: 'M2.6 12.4a6 6 0 1 1 10.8 0M8 8.8l3-2.6',
    clock: 'M8 2.4a5.6 5.6 0 1 1 0 11.2A5.6 5.6 0 0 1 8 2.4ZM8 5.2V8l2 1.4',
    arrow: 'M3.4 8h9.2M9.2 4.6 12.6 8l-3.4 3.4',
    chev: 'M4.6 6.4 8 9.8l3.4-3.4',
    refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.4v3.2h-3.2',
    power: 'M8 2.6v5M12.2 4.4a5.4 5.4 0 1 1-8.4 0',
    ext: 'M6.4 3.2H3.4v9.4h9.4V9.6M9.6 3.2h3.2v3.2M12.8 3.2 7.6 8.4',
    copy: 'M5.6 5.6V3.2h7.2v7.2h-2.4M3.2 5.6h7.2v7.2H3.2z',
    search: 'M7.2 11.2a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM10.2 10.2l2.6 2.6',
    alert: 'M8 2.6 14 13H2zM8 6.6v3M8 11.3h.02',
    check: 'M3.2 8.4 6.4 11.6l6.4-7',
    task: 'M3 3.2h10v9.4H3zM5.6 6.4h4.8M5.6 9.4h3',
    bolt: 'M9.2 1.8 3.6 9.2h3.6l-.6 5 5.8-7.6H8.6z',
    key: 'M9.4 8.2a2.8 2.8 0 1 0-2.6-1 2.9 2.9 0 0 0 .6 1.6L2.4 13.8h1.8v-2h2v-1.6h1.6z',
    dot: 'M8 11.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z',
    down: 'M8 2.6v8M4.6 7.2 8 10.6l3.4-3.4M3.2 13.4h9.6',
    up: 'M8 13.4v-8M4.6 8.8 8 5.4l3.4 3.4M3.2 2.6h9.6',
  };
  window.ic = function (name, size, extra) {
    const d = ICONS[name] || ICONS.dot;
    return `<svg class="ic ${extra || ''}" width="${size || 16}" height="${size || 16}" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  };

  /* ---------- 数字格式化 ---------- */
  const nf = new Intl.NumberFormat('en-US');
  window.fmt = {
    int: (n) => nf.format(Math.round(n || 0)),
    tok: (n) => {
      n = n || 0;
      if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
      if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
      return nf.format(Math.round(n));
    },
    pct: (n, d) => (n * 100).toFixed(d == null ? 0 : d) + '%',
    dur: (s) => {
      s = Math.max(0, Math.round(s || 0));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h ? h + 'h ' + m + 'm' : m + 'm';
    },
    ts: (t) => (t || '').slice(0, 16).replace('T', ' '),
    mmdd: (s) => (s || '').slice(5),
  };

  /* ---------- 服务身份色（图表分类色，各 demo 可按自己的语系重定义） ---------- */
  window.SVC_COLOR = { workbuddy: '#12B886', qoder: '#4C6EF5', cline: '#F08C00', cmdgo: '#E8590C' };

  /* ---------- 图表路径工具（全部返回 SVG path 的 d） ---------- */
  const px = (n) => Math.round(n * 100) / 100;
  window.ch = {
    /* 折线：pts = [[x,y], ...] */
    line(pts) { return pts.map((p, i) => (i ? 'L' : 'M') + px(p[0]) + ' ' + px(p[1])).join(''); },
    /* 面积：折线 + 回落到 baseY */
    area(pts, baseY) {
      if (!pts.length) return '';
      return window.ch.line(pts) + 'L' + px(pts[pts.length - 1][0]) + ' ' + px(baseY) + 'L' + px(pts[0][0]) + ' ' + px(baseY) + 'Z';
    },
    /* 平滑（Catmull-Rom → 三次贝塞尔），tension 越小越平 */
    smooth(pts, t) {
      if (pts.length < 3) return window.ch.line(pts);
      t = t == null ? 0.22 : t;
      let d = 'M' + px(pts[0][0]) + ' ' + px(pts[0][1]);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
        const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
        d += 'C' + px(c1[0]) + ' ' + px(c1[1]) + ' ' + px(c2[0]) + ' ' + px(c2[1]) + ' ' + px(p2[0]) + ' ' + px(p2[1]);
      }
      return d;
    },
    /* 阶梯（时间序列更诚实） */
    step(pts, baseY) {
      let d = 'M' + px(pts[0][0]) + ' ' + px(baseY);
      pts.forEach((p, i) => { d += 'L' + px(p[0]) + ' ' + px(baseY) + 'L' + px(p[0]) + ' ' + px(p[1]); });
      d += 'L' + px(pts[pts.length - 1][0]) + ' ' + px(baseY) + 'Z';
      return d;
    },
    /* 堆叠面积：rows = [{key, vals:[...]}], 返回 [{d, key}] 从上到下
       注意用直线不用平滑：日粒度数据常有陡升，平滑会在跳变处过冲到基线以下。 */
    stack(rows, n, W, H, pad) {
      const max = Math.max(1, ...Array.from({ length: n }, (_, i) => rows.reduce((s, r) => s + (r.vals[i] || 0), 0)));
      const acc = new Array(n).fill(0);
      return rows.map((r) => {
        const top = [], bot = [];
        for (let i = 0; i < n; i++) {
          const x = pad.l + (n === 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
          const y0 = H - pad.b - (acc[i] / max) * (H - pad.t - pad.b);
          acc[i] += r.vals[i] || 0;
          const y1 = H - pad.b - (acc[i] / max) * (H - pad.t - pad.b);
          top.push([x, y0]); bot.push([x, y1]);
        }
        const d = window.ch.line(top) + 'L' + bot.slice().reverse().map((p) => px(p[0]) + ' ' + px(p[1])).join('L') + 'Z';
        return { d, key: r.key };
      });
    },
    /* 竖条：返回 [{x,y,w,h}] */
    bars(vals, W, H, pad, gap) {
      const max = Math.max(1, ...vals);
      const n = vals.length, iw = (W - pad.l - pad.r) / n, g = gap == null ? 0.28 : gap;
      return vals.map((v, i) => {
        const h = (v / max) * (H - pad.t - pad.b);
        return { x: pad.l + i * iw + iw * g / 2, y: H - pad.b - h, w: iw * (1 - g), h: Math.max(v > 0 ? 1.5 : 0, h) };
      });
    },
    /* 文字柱状 sparkline（控制台风） */
    textBars(vals, ramp) {
      ramp = ramp || '▁▂▃▄▅▆▇█';
      const max = Math.max(1, ...vals);
      return vals.map((v) => ramp[Math.min(ramp.length - 1, Math.round((v / max) * (ramp.length - 1)))]).join('');
    },
  };

  /* ---------- 图表按容器实测宽度绘制 ----------
     不要用 preserveAspectRatio="none" 拉伸：那会把文字和线宽一起拉变形。
     这里先量出容器的真实像素宽，再用 1:1 的 viewBox 画。 */
  window.__chartRuns = [];
  window.autoChart = function (sel, draw) {
    const run = () => {
      document.querySelectorAll(sel).forEach((el) => {
        // 优先取实际渲染宽度：clientWidth 在极窄的内联元素上可能为 0，此时退回父级。
        const w = Math.round(el.getBoundingClientRect().width) || el.clientWidth
               || (el.parentElement && el.parentElement.clientWidth) || 0;
        // 量不到宽度说明布局还没就绪。绝不要退回一个「看起来合理」的兜底宽度去画 ——
        // 那会画出尺寸错误的 SVG（曾经把 104px 的格子画成 240px，柱子全跑到可视区外）。
        if (!w) return;
        const W = Math.max(24, w);
        if (el._chartW === W && el._chartSig === window.chartPaintSig) return;
        const H = Math.round(parseFloat(el.getAttribute('data-h')) || 200);
        el.innerHTML = draw(W, H, el);
        el._chartW = W;
        el._chartSig = window.chartPaintSig;
      });
    };
    window.__chartRuns.push(run);
    requestAnimationFrame(run);
    window.addEventListener('resize', run);
  };
  // 每次重绘视图时自增，用来让所有图表无条件重画一次
  window.chartPaintSig = 0;
  window.paintCharts = function () {
    window.chartPaintSig++;
    window.__chartRuns.forEach((r) => r());
    // 布局可能在这一帧才稳定，下一帧补画一次（run 内部会跳过宽度未变的元素）
    requestAnimationFrame(() => window.__chartRuns.forEach((r) => r()));
  };

  /* ---------- 常用片段 ---------- */
  window.statusChip = function (s, label) {
    const map = { running: ['ok', '运行中'], stopped: ['off', '已停止'], starting: ['warn', '启动中'], error: ['err', '异常'] };
    const [k, t] = map[s] || ['off', s];
    return `<span class="chip ${k}"><i></i>${label || t}</span>`;
  };
  window.svcLogo = (id, size) => `<img class="slogo" src="${window.LOGOS[id]}" width="${size}" height="${size}" alt="">`;

  /* ---------- 视图切换（hash 路由，5 个 demo 共用） ---------- */
  window.mountRouter = function (views, onChange) {
    const keys = Object.keys(views);
    function go() {
      const k = (location.hash || '').replace('#', '') || keys[0];
      const act = keys.includes(k) ? k : keys[0];
      document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === act));
      const host = document.getElementById('view');
      if (host) host.innerHTML = views[act]();
      if (onChange) onChange(act);
      window.bindToggles(document);
      if (window.paintCharts) window.paintCharts();
      document.querySelectorAll('[data-nav]').forEach((b) => {
        if (!b._bound) { b._bound = true; b.addEventListener('click', () => { location.hash = b.dataset.nav; }); }
      });
    }
    window.addEventListener('hashchange', go);
    window.__go = go;
    go();
  };

  /* 示例态下的显式角标（不标注就等于假数据混排） */
  window.sampleTag = () => (mode === 'sample'
    ? `<span class="sampletag">示例数据 · 仅用于看图表形态</span>` : '');
})();
