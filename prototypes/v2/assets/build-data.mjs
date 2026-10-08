import fs from 'node:fs';
// 原始抓取件放在 _raw/（整理后已删除，含密钥，不要提交）；data.js/data.json/sample.js 是派生结果。
const R = f => JSON.parse(fs.readFileSync(new URL('./_raw/' + f, import.meta.url), 'utf8'));
const svc = R('_svc.json'), info = R('_info.json'), stats = R('_stats.json'),
  events = R('_events.json'), access = R('_access.json'),
  wbo = R('wb-overview.json'), cls = R('cline-status.json'),
  qdo = R('qoder-overview.json'), cgo = R('cmdgo-status.json'),
  wbm = R('wb-models.json'), clm = R('cline-models.json');

const TODAY = stats.today || {};
const infoOf = id => (info.services || []).find(s => s.svc === id) || {};
const accOf = id => (access.services || []).find(s => s.svc === id) || {};

// 真实逐日序列（面板聚合库，31 天）
const trend = stats.days.map(d => ({
  date: d.date.slice(5),
  full: d.date,
  tok: (d.total.input || 0) + (d.total.output || 0),
  in: d.total.input || 0, out: d.total.output || 0, reqs: d.total.reqs || 0,
  by: Object.fromEntries(['workbuddy', 'qoder', 'cline', 'cmdgo'].map(k => {
    const s = d.services[k];
    return [k, s ? ((s.input || 0) + (s.output || 0)) : 0];
  })),
}));

const SVC = [
  { id: 'workbuddy', name: 'WorkBuddy-free', short: 'WorkBuddy', port: 7863 },
  { id: 'qoder', name: 'Qoder-free', short: 'Qoder', port: 8210 },
  { id: 'cline', name: 'Cline-free', short: 'Cline', port: 8787 },
  { id: 'cmdgo', name: 'cmdgo-bridge', short: 'cmdgo', port: 8014 },
].map(s => {
  const st = svc.services.find(x => x.id === s.id) || {};
  const i = infoOf(s.id), a = accOf(s.id);
  return {
    ...s,
    status: st.status, pid: st.pid, managed: !!st.managed, restarts: st.restarts || 0,
    accounts: i.accounts ?? null, healthy: i.healthy ?? null,
    cooling: i.cooling ?? null, coolUnit: i.cool_unit ?? '',
    credits: i.credits ?? null,
    models: i.models ?? (a.models ? a.models.length : null),
    tasks: i.tasks ?? null, note: i.note ?? '',
    ok: i.ok !== false,
    panelBase: a.panel_base, localBase: a.local_base,
    protocol: a.protocols || ['openai'],
    keyMasked: a.key_masked || '',
    modelList: (a.models || []).map(m => m.id),
  };
});

// 今日各服务用量（真实，来自面板聚合库分服务）
const todayBySvc = {};
const last = stats.days[stats.days.length - 1];
for (const k of ['workbuddy', 'qoder', 'cline', 'cmdgo']) {
  const s = last.services[k] || {};
  todayBySvc[k] = { tok: (s.input || 0) + (s.output || 0), in: s.input || 0, out: s.output || 0, reqs: s.reqs || 0 };
}

const prev = stats.days[stats.days.length - 2];
const prevTok = prev ? (prev.total.input || 0) + (prev.total.output || 0) : 0;

const DATA = {
  snapshotAt: '2026-10-07 17:12',
  panel: { addr: 'http://127.0.0.1:9000', note: '面板 14:00 启动，四服务 14:10 前全部就绪' },
  summary: {
    todayTok: (TODAY.input || 0) + (TODAY.output || 0), todayIn: TODAY.input || 0, todayOut: TODAY.output || 0,
    todayReqs: TODAY.reqs || 0, active: SVC.filter(s => s.status === 'running').length, total: SVC.length,
    cooling: (stats.cooling || []).reduce((n, c) => n + (c.n || 0), 0),
    prevTok,
  },
  totals30: stats.totals,
  trend,
  services: SVC,
  todayBySvc,
  events: events.events,
  wb: {
    version: wbo.version, uptimeSec: wbo.uptime_sec,
    account: wbo.accounts[0],
    models: (wbm.models || []).map(m => ({
      id: m.id, name: m.name, credits: m.credits || '', effort: m.default_effort,
      efforts: m.supported_efforts, ctx: m.context_length, maxOut: m.max_output_tokens,
      reasoning: m.supports_reasoning, images: m.supports_images,
    })),
  },
  cline: {
    version: cls.version, strategy: cls.strategy, defaultModel: cls.default_model,
    accountCount: cls.account_count, available: cls.accounts_available,
    account: cls.account_details[0],
    models: (clm.data || []).map(m => ({ id: m.id, label: m.label, default: !!m.is_default, ctx: m.context_length })),
  },
  qoder: { version: qdo.version, uptimeSec: qdo.uptime_s, accounts: [] },
  cmdgo: {
    provider: cgo.provider, baseURL: cgo.baseURL, modelCount: cgo.modelCount,
    maxTokens: cgo.maxTokens, accounts: [], login: cgo.login, modelList: (cgo.modelIds || []).slice(0, 12),
  },
};

fs.writeFileSync('data.json', JSON.stringify(DATA, null, 1));
console.log('services:');
for (const s of DATA.services) console.log(' ', s.id.padEnd(10), s.status, 'acc=' + s.accounts, 'models=' + s.models, 'today=' + JSON.stringify(DATA.todayBySvc[s.id]));
console.log('trend', DATA.trend.length, 'nonzero', DATA.trend.filter(x => x.reqs).length);
console.log('wb models', DATA.wb.models.length, '| cline models', DATA.cline.models.length, '| events', DATA.events.length);
console.log('data.json bytes', fs.statSync('data.json').size);

// 同时输出 data.js（file:// 下也能加载，不依赖 fetch）
fs.writeFileSync('data.js', 'window.DATA = ' + JSON.stringify(DATA) + ';\n');
console.log('data.js bytes', fs.statSync('data.js').size);
// 一份「示例密度」序列：仅在明确标注示例时使用，用于评判图表形态
const SAMPLE = (() => {
  const seeds=[0.28,0.41,0.36,0.52,0.44,0.61,0.33,0.47,0.58,0.39,0.66,0.51,0.42,0.55,0.72,0.48,0.37,0.63,0.59,0.45,0.68,0.53,0.61,0.47,0.74,0.58,0.66,0.52,0.43,0.61,0.55];
  const mix=[0.62,0.06,0.24,0.08];
  const day=(i)=>({ date:DATA.trend[i].date, full:DATA.trend[i].full, tok:0, in:0, out:0, reqs:0, by:{} });
  return DATA.trend.map((d,i)=>{
    const s=seeds[i%seeds.length], scale=14000;
    const out=day(i); let tk=0, rq=0;
    ['workbuddy','qoder','cline','cmdgo'].forEach((k,j)=>{
      const v=Math.round(scale*s*mix[j]*(0.7+0.6*((i*7+j*13)%10)/10));
      out.by[k]=v; tk+=v; rq+=Math.round(v/240);
    });
    out.tok=tk; out.in=Math.round(tk*0.62); out.out=tk-out.in; out.reqs=rq;
    return out;
  });
})();
fs.writeFileSync('sample.js', 'window.SAMPLE = ' + JSON.stringify(SAMPLE) + ';\n');
console.log('sample.js bytes', fs.statSync('sample.js').size);
