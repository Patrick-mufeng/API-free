# docs/images 说明

本目录的 PNG 是 README 用的截图，全部用同一套遮罩流程产出。

**关键顺序：先遮住个人信息，再截屏**（不是截完再修图）。

`mask.js` 是遮罩脚本，可直接在浏览器控制台或 Playwright 的 `evaluate` 里注入，
返回 `{ maskedCount, masked }`。两条规则：

1. **已知敏感值的精确子串匹配**优先于正则。因为界面上邮箱可能被截断显示
   （例如只显示 `yourname` 而丢了 `@gmail.com`），纯正则匹配不到。
2. `<pre>`（日志区）不整块清空，只做**子串替换**——清空会让整块日志消失，
   而日志页恰恰是要展示给人看的。

`arch.html` 是顶部架构图的源文件（渲染后即 `00-arch.png`），改图时编辑它再截图。

生成截图：浏览器打开面板 → 注入 `mask.js` → 截屏。窗口高度按内容实测高度设置
（`.wrap` 各子元素的 `getBoundingClientRect().bottom` 最大值 + 28），避免大片空白。

宽度：除总览外都是 1600（沿用最初一批的宽度）。**总览用 1920** —— 服务卡在 ≥1720px
时才按服务数排成一行，1600 下折成 4+1，看不出那行的效果。

截屏前把面板重启一次：面板事件是环形缓冲，README 的截图里不该留着一串调试性的启停
记录（重启后只会剩「面板启动，监督 N 个服务」这一条）。

---
以下是 `mask.js` 源码：

```js
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
```
