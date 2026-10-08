// 生成定稿 logo：两个梯子搭成的一个 A
// 每条腿 = 一把梯子：两条平行轨 + 垂直于轨的横档；两梯在顶点相靠；
// 上半档两两对齐连成 A 的横杠；脚底沿水平线切平（梯子立在地上）；
// 轨用多边形精确构造（顶端垂直于轨身、底端水平），横档用短线段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const add=(a,b)=>[a[0]+b[0],a[1]+b[1]], sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const mul=(a,k)=>[a[0]*k,a[1]*k];
const norm=a=>{const l=Math.hypot(a[0],a[1]);return [a[0]/l,a[1]/l]};
const perp=a=>[a[1],-a[0]];
const f=n=>+n.toFixed(2);

const TOP=[16,4.55], FOOT_L=[6.75,27.6];
const HALF_W=2.5, RAIL_W=2.3, RUNG_W=2.25, T0=0.055;
const RUNGS=[0.335,0.70];
const mirror=p=>[32-p[0],p[1]];

/* 每把梯子 → 一组多边形（轨）+ 线段（横档） */
function ladder(top,bottom){
  const u=norm(sub(bottom,top)), p=perp(u);
  const at=t=>add(top,mul(sub(bottom,top),t));
  const dy=(bottom[1]-top[1]);
  const footY=bottom[1] + HALF_W*Math.abs(p[1]);   // 让较低的那条边也算进包围盒
  const out=[];
  for (const s of [HALF_W,-HALF_W]){
    const a1=add(at(T0),mul(p,s-RAIL_W/2/HALF_W*HALF_W));
    // 轨的上端：垂直于轨身切（即 at(T0) 两侧偏移 ±RAIL_W/2）
    const t1=at(T0);
    const up1=add(t1,mul(p,s)), up2=add(t1,mul(p,s));
    // 两条边线：中心线偏移 s±RAIL_W/2
    const edge=(off)=>{
      const base=add(top,mul(p,off));           // 该边上 y=top.y 处的点
      const y0=base[1], need=(bottom[1])-y0;    // 到脚底高度所需增量
      const tEnd=need/dy;                        // 沿中心线方向的参数
      const end=add(base,mul(sub(bottom,top),tEnd));
      const tStart=t1[1]===y0?0:(at(T0)[1]-y0)/dy;
      const start=add(base,mul(sub(bottom,top),tStart));
      return [start,end];
    };
    const [i1,i2]=edge(s+RAIL_W/2), [o1,o2]=edge(s-RAIL_W/2);
    out.push(`<path d="M${f(i1[0])} ${f(i1[1])}L${f(i2[0])} ${f(i2[1])}L${f(o2[0])} ${f(o2[1])}L${f(o1[0])} ${f(o1[1])}Z"/>`);
  }
  for (const t of RUNGS){
    const c=at(t);
    const a=add(c,mul(p,-HALF_W)), b=add(c,mul(p,HALF_W));
    out.push(`<path d="M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}" stroke="currentColor" stroke-width="${RUNG_W}" stroke-linecap="butt"/>`);
  }
  return out.join('');
}

const inner = ladder(TOP,FOOT_L) + ladder(TOP,mirror(FOOT_L));
const wrap = (fill,pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="API-free">
  <title>API-free</title>
  <g fill="currentColor" stroke="currentColor" stroke-linejoin="miter" ${pad}>${inner}</g>
</svg>`;

const mark = wrap(null,'');
// favicon 是独立文件、没有 CSS 上下文：currentColor 会落到黑色，在墨底上等于隐形，
// 所以这里把横档的 stroke 落成实色。
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="API-free">
  <title>API-free</title>
  <rect width="32" height="32" rx="9" fill="#17181A"/>
  <g fill="#fff" stroke="#fff" stroke-linejoin="miter" transform="translate(16 16.4) scale(0.70) translate(-16 -15.4)">${inner.replace(/currentColor/g, '#fff')}</g>
</svg>`;

// 输出到脚本自身所在目录（不写死机器路径，谁克隆下来都能跑）
const DIR = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(`${DIR}/logo.svg`, mark+'\n');
fs.writeFileSync(`${DIR}/favicon.svg`, tile+'\n');
fs.writeFileSync(`${DIR}/logo-inner.svg`, inner+'\n');
console.log('logo.svg', mark.length, 'B   favicon.svg', tile.length, 'B');
console.log('\n--- inner ---\n'+inner);

// 供展示页与后续组件复用的内联片段
fs.writeFileSync(`${DIR}/logo-inner.js`, 'window.LOGO_INNER = ' + JSON.stringify(inner) + ';\n');
console.log('logo-inner.js written');
