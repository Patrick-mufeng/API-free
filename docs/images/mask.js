/* 截图前遮住界面上的个人信息。用法：浏览器控制台 / Playwright evaluate 注入本脚本，
   返回 { maskedCount, masked }。注意：面板被刷新后遮罩会失效，需重新注入再截图。 */
(function () {
// ★ 已知敏感值：用你**自己账号**的真实标识替换这里的占位符。
  // 之所以要精确列表而不只靠正则：界面上邮箱会被截断显示（只给 'xxx.yyy'），
  // 丢掉 '@domain' 后正则匹配不到。填的时候把手机上看到的片段都列上。
  const KNOWN = [
    '13800000000',                          // 手机号（示例）
    'yourname', 'your.name',                // 邮箱前缀 / 昵称（示例）
    'user@example.com',                     // 完整邮箱（示例）
    'aaaaaaaa', 'bbbbbbbbbbbb', 'cccc-dddd-eeee',  // 账号 uid 的首/中/尾段（示例）
    'deadbeef',                             // 短账号 id（示例）
    'qod_', 'sk-',                          // 账号 id 前缀
  ];
  const PATS = [
    { name: '手机号', re: /\b1[3-9]\d{9}\b/ },
    { name: '邮箱', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
    { name: 'UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  ];

  function placeholder(kind, orig) {
    if (kind === '手机号') return '138••••0000';
    if (kind === '邮箱') return 'user@example.com';
    if (kind === 'UUID') return '••••••••-••••-••••';
    if (kind === '账号') return '••••••••';
    return '········';
  }

  function maskTarget(node) {
    let el = node.parentElement;
    for (let i = 0; i < 4 && el; i++) {
      const cls = String(el.className || '');
      if (/^(u-name|u-sub|who|k|nm|id|v|rr|dd|dt|m|mid)$/.test(cls)) return el;
      el = el.parentElement;
    }
    return node.parentElement;
  }

  const masked = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const n of nodes) {
    const t = n.textContent || '';
    if (!t.trim()) continue;

    const low = t.toLowerCase();
    let kind = KNOWN.find((k) => low.includes(k.toLowerCase())) ? '账号' : null;
    if (!kind) {
      const hit = PATS.find((p) => p.re.test(t));
      if (hit) kind = hit.name;
    }
    if (!kind) continue;

    const el = maskTarget(n);
    if (!el || el.dataset.__masked) continue;
    // 日志/代码块交给下面的「子串替换」处理：那里清空容器会整块消失，
    // 而面板的日志页恰恰是要展示给人看的。
    if (el.tagName === 'PRE' || (el.closest && el.closest('pre'))) continue;
    el.dataset.__masked = '1';
    el.style.setProperty('background', 'var(--sunken, #f1efec)');
    el.style.setProperty('border-radius', '4px');
    el.textContent = '';
    const ph = document.createElement('span');
    ph.textContent = placeholder(kind, t.trim());
    ph.style.cssText = 'color:var(--muted,#6b6b6b)';
    el.appendChild(ph);
    masked.push({ kind, sample: t.trim().slice(0, 24), cls: String(el.className).slice(0, 24) });
  }

  // 日志/代码块（<pre>）里的敏感串：只替换子串，不清空容器，
  // 否则一整块日志会消失、看不出面板在展示什么。
  const preMaskedCount = { n: 0 };
  for (const pre of Array.from(document.querySelectorAll('pre, .logpre'))) {
    if (pre.dataset.__maskedText) continue;
    let txt = pre.textContent || '';
    let changed = false;
    for (const k of KNOWN) {
      if (!k || k.length < 6) continue;
      // 用 split/join 做字面量替换，避免正则转义踩坑
      const lowTxt = txt.toLowerCase();
      if (lowTxt.includes(k.toLowerCase())) {
        let out = '';
        let rest = txt;
        for (;;) {
          const idx = rest.toLowerCase().indexOf(k.toLowerCase());
          if (idx < 0) { out += rest; break; }
          out += rest.slice(0, idx) + '••••••••';
          rest = rest.slice(idx + k.length);
        }
        txt = out;
        changed = true;
      }
    }
    if (changed) {
      pre.dataset.__maskedText = '1';
      pre.textContent = txt;
      preMaskedCount.n++;
    }
  }
  masked.push({ kind: '日志文本', sample: 'pre 内敏感串替换', cls: 'pre' });

  return { maskedCount: masked.length, masked }
})();
