"use strict";

const SIG_CLASS = {"Enter":"Enter","Wait":"Wait","Too High":"TooHigh","Bad Market":"BadMarket"};
// soft "avoid chasing the top" heuristics (display-only, not part of the signal)
const DEV_HI = 4.0, SELFVOL_HI = 0.6;

const fmt = {
  n2:(v)=>v==null||v===""?"":Number(v).toFixed(2),
  n1:(v)=>v==null||v===""?"":Number(v).toFixed(1),
  pct:(v)=>v==null||v===""?"":(Number(v)*100).toFixed(1)+"%",
  er:(v)=>v==null||v===""?"":Number(v).toFixed(2),
  int:(v)=>v==null||v===""?"":Number(v).toLocaleString(),
};

// overview columns: key, label, align, formatter, accessor(summary)
const COLS = [
  {k:"ticker",  t:"代码", l:true,  f:(s,st)=>`<span class="tk">${st.ticker}</span>`, v:(s,st)=>st.ticker},
  {k:"name",    t:"名称", l:true,  f:(s,st)=>`<span class="nm">${st.name||""}</span>`, v:(s,st)=>st.name||""},
  {k:"major",   t:"大类", l:true,  f:(s,st)=>st.major?`<span class="type-tag major">${st.major}</span>`:"", v:(s,st)=>st.major||""},
  {k:"sub",     t:"小类", l:true,  f:(s,st)=>st.sub?`<span class="type-tag">${st.sub}</span>`:"", v:(s,st)=>st.sub||""},
  {k:"close",   t:"收盘",        f:s=>fmt.n2(s.close), v:s=>s.close},
  {k:"atr14",   t:"ATR14",       f:s=>fmt.n2(s.atr14), v:s=>s.atr14},
  {k:"atrpct",  t:"ATR%",        f:s=>fmt.pct(s.atrpct), v:s=>s.atrpct},
  {k:"selfvol", t:"ATR自身波动", f:s=>flagged(fmt.pct(s.selfvol), s.selfvol>=SELFVOL_HI, "ATR 短期波动明显大于长期（>"+(SELFVOL_HI*100)+"%），警惕追高"), v:s=>s.selfvol},
  {k:"dev",     t:"ATR偏离(nR)", f:s=>flagged(fmt.n1(s.dev), s.dev>=DEV_HI, "已偏离 MA20 超过 "+DEV_HI+"×ATR，警惕高位接盘"), v:s=>s.dev},
  {k:"mktok",   t:"大盘",        f:s=>s.mktok==null?"":(s.mktok?`<span class="pos">✓</span>`:`<span class="neg">✕</span>`), v:s=>s.mktok?1:0},
  {k:"stop",    t:"止损",        f:s=>fmt.n2(s.stop), v:s=>s.stop},
  {k:"minentry",t:"最低买入",    f:s=>fmt.n2(s.minentry), v:s=>s.minentry},
  {k:"maxentry",t:"最高买入",    f:s=>fmt.n2(s.maxentry), v:s=>s.maxentry},
  {k:"premium", t:"溢价",        f:s=>colSigned(s.premium), v:s=>s.premium},
  {k:"signal",  t:"信号",        f:s=>sigTag(s.signal), v:s=>s.signal},
  {k:"entry_pct",t:"入场分位",   f:s=>fmt.pct(s.entry_pct), v:s=>s.entry_pct==null?-1:s.entry_pct},
  {k:"er22",    t:"ER22",        f:s=>fmt.er(s.er22), v:s=>s.er22},
  {k:"er55",    t:"ER55",        f:s=>fmt.er(s.er55), v:s=>s.er55},
  {k:"r0",      t:"R0",          f:s=>fmt.n2(s.r0), v:s=>s.r0},
  {k:"shares",  t:"股数",        f:s=>fmt.n1(s.shares), v:s=>s.shares},
  {k:"mult",    t:"ATR倍数",     f:s=>fmt.n1(s.mult), v:s=>s.mult},
  {k:"buf",     t:"EntryBuf",    f:s=>fmt.n2(s.buf), v:s=>s.buf},
];

function flagged(txt, on, tip){ return on ? `${txt}<span class="warn-flag" title="${tip}">⚠</span>` : txt; }
function sigTag(s){ return s?`<span class="sig ${SIG_CLASS[s]||"Wait"}">${s}</span>`:""; }
function colSigned(v){ if(v==null||v==="")return ""; const c=v>=0?"pos":"neg"; return `<span class="${c}">${fmt.n2(v)}</span>`; }
function num(v){ return (v==null||v==="")?null:Number(v); }

let DATA=null, view="overview", sort={k:"signal",dir:1}, q="", fMajor="", fSub="";

async function load(){
  try{
    const r = await fetch("data/latest.json", {cache:"no-store"});
    DATA = await r.json();
  }catch(e){
    document.getElementById("empty").hidden=false;
    document.getElementById("empty").textContent="无法加载数据。请确认 docs/data/latest.json 已生成（运行 GitHub Action 或 python engine/build.py --seed）。";
    return;
  }
  renderMarket();
  renderMeta();
  buildFilters();
  // default sort: Enter first, then by entry proximity
  sortBy("signal");
  document.getElementById("sigCount").textContent =
    DATA.stocks.filter(s=>s.summary.signal==="Enter").length;
  render();
}

function renderMeta(){
  const d=new Date(DATA.generated_at);
  document.getElementById("updated").textContent = "更新 "+d.toLocaleString();
  document.getElementById("source").textContent = "源 "+DATA.source;
}

function renderMarket(){
  const order=["SPY","QQQ","ITA","XLK"];
  const el=document.getElementById("market"); el.innerHTML="";
  order.filter(b=>DATA.market[b]).forEach(b=>{
    const m=DATA.market[b]; const ok=m&&m.ok;
    const div=document.createElement("div");
    div.className="pill "+(ok?"ok":(m?"no":""));
    div.innerHTML=`<span class="dot"></span><b>${b}</b> ${ok?"向上":"回避"}`;
    div.title = m ? `${b} 收盘 ${fmt.n2(m.close)} · SMA100 ${fmt.n2(m.sma100)} · 10日 ${fmt.pct(m.dd10)}` : "";
    el.appendChild(div);
  });
}

function buildFilters(){
  const fill=(id,key)=>{ const sel=document.getElementById(id);
    [...new Set(DATA.stocks.map(s=>s[key]).filter(Boolean))].sort().forEach(t=>{
      const o=document.createElement("option"); o.value=t; o.textContent=t; sel.appendChild(o); }); };
  fill("majorFilter","major"); fill("subFilter","sub");
}

function rows(){
  let list = DATA.stocks.slice();
  if(view==="signals") list = list.filter(s=>s.summary.signal==="Enter");
  if(fMajor) list = list.filter(s=>s.major===fMajor);
  if(fSub) list = list.filter(s=>s.sub===fSub);
  if(q){ const Q=q.toLowerCase();
    list = list.filter(s=>s.ticker.toLowerCase().includes(Q)||(s.name||"").toLowerCase().includes(Q)); }
  const col = COLS.find(c=>c.k===sort.k);
  const sigRank={"Enter":0,"Too High":1,"Wait":2,"Bad Market":3};
  list.sort((a,b)=>{
    let va,vb;
    if(sort.k==="signal"){ va=sigRank[a.summary.signal]??9; vb=sigRank[b.summary.signal]??9; }
    else { va=col.v(a.summary,a); vb=col.v(b.summary,b);
      if(typeof va==="string"){ return sort.dir*va.localeCompare(vb); } }    va=va==null?-Infinity:va; vb=vb==null?-Infinity:vb;
    return sort.dir*(va-vb);
  });
  return list;
}

function render(){
  const head=document.querySelector("#grid thead");
  head.innerHTML="<tr>"+COLS.map(c=>{
    const arrow = sort.k===c.k?`<span class="arrow">${sort.dir>0?"▲":"▼"}</span>`:"";
    return `<th class="${c.l?"l":""}" data-k="${c.k}">${c.t}${arrow}</th>`;
  }).join("")+"</tr>";
  head.querySelectorAll("th").forEach(th=>th.onclick=()=>{ sortBy(th.dataset.k); render(); });

  const list=rows();
  const body=document.querySelector("#grid tbody");
  body.innerHTML = list.map(st=>{
    const s=st.summary;
    return `<tr data-tk="${st.ticker}" class="${s.signal==="Enter"?"enter":""}">`+
      COLS.map(c=>`<td class="${c.l?"l":""}">${c.f(s,st)??""}</td>`).join("")+`</tr>`;
  }).join("");
  body.querySelectorAll("tr").forEach(tr=>tr.onclick=()=>openDetail(tr.dataset.tk));

  const empty=document.getElementById("empty");
  empty.hidden = list.length>0;
  if(!list.length) empty.textContent = view==="signals"?"当前没有 ENTER 信号。":"没有匹配的股票。";
}

function sortBy(k){
  if(sort.k===k) sort.dir*=-1;
  else { sort.k=k; sort.dir = (k==="ticker"||k==="name"||k==="major"||k==="sub"||k==="signal")?1:-1; }
}

/* ---------- detail drawer ---------- */
function openDetail(tk){
  const st=DATA.stocks.find(s=>s.ticker===tk); if(!st) return;
  const s=st.summary;
  const cards=[
    ["最新收盘",fmt.n2(s.close)],["ATR14",fmt.n2(s.atr14)],["ATR%",fmt.pct(s.atrpct)],
    ["ATR自身波动",fmt.pct(s.selfvol)],["ATR偏离(nR)",fmt.n1(s.dev)],
    ["止损(候选)",fmt.n2(s.stop)],["最低买入",fmt.n2(s.minentry)],["最高买入",fmt.n2(s.maxentry)],
    ["溢价",fmt.n2(s.premium)],["入场分位",fmt.pct(s.entry_pct)],
    ["ER22",fmt.er(s.er22)],["ER55",fmt.er(s.er55)],
    ["R0(每股风险)",fmt.n2(s.r0)],["可建仓股数",fmt.n1(s.shares)],
    ["ATR倍数",fmt.n1(s.mult)],["EntryBuffer",fmt.n2(s.buf)],
  ];
  const flags=[];
  if(s.dev>=DEV_HI) flags.push(`偏离 MA20 达 ${fmt.n1(s.dev)}×ATR`);
  if(s.selfvol>=SELFVOL_HI) flags.push(`ATR 短期波动放大 ${fmt.pct(s.selfvol)}`);
  const note = flags.length?`⚠ 注意追高风险：${flags.join("；")}`
              : (s.signal==="Enter"?"收盘位于买入区间内，大盘向上，止损低于入场价。":"");

  document.getElementById("detail").innerHTML = `
    <div class="d-head">
      <h2>${st.ticker}</h2><span class="dname">${st.name||""}</span>
      ${st.major?`<span class="type-tag major">${st.major}</span>`:""}
      ${st.sub?`<span class="type-tag">${st.sub}</span>`:""}
    </div>
    <div class="signal-row">
      ${sigTag(s.signal)}
      <span class="note">对标 ${st.benchmark}（${DATA.market[st.benchmark]&&DATA.market[st.benchmark].ok?"向上":"回避"}）· 可亏限额 $${st.risk} · 突破确认 +${fmt.pct(st.breakout)}</span>
    </div>
    ${note?`<div class="signal-row"><span class="note ${flags.length?"":""}" style="color:${flags.length?"var(--warn)":"var(--muted)"}">${note}</span></div>`:""}
    ${ladderHTML(s)}
    <div class="cards">${cards.map(([k,v])=>`<div class="card"><div class="k">${k}</div><div class="v">${v||"—"}</div></div>`).join("")}</div>
    ${chartHTML(st)}
    <div class="hist-head"><h3>历史数据与逐日计算</h3><span class="hint">与你原表的股票 tab 一致（最近在上）</span></div>
    ${histTable(st)}
  `;
  document.getElementById("scrim").hidden=false;
  const dr=document.getElementById("drawer"); dr.hidden=false; dr.setAttribute("aria-hidden","false");
  dr.scrollTop=0;
}
function closeDetail(){
  document.getElementById("scrim").hidden=true;
  const dr=document.getElementById("drawer"); dr.hidden=true; dr.setAttribute("aria-hidden","true");
}

/* entry ladder: where close sits relative to stop / min / max */
function ladderHTML(s){
  const stop=num(s.stop), mn=num(s.minentry), mx=num(s.maxentry), cl=num(s.close);
  if([stop,mn,mx,cl].some(v=>v==null)) return "";
  const vals=[stop,mn,mx,cl];
  let lo=Math.min(...vals), hi=Math.max(...vals); const pad=(hi-lo)*0.12||1; lo-=pad; hi+=pad;
  const H=150, top=6, bot=H-6;
  const y=v=> bot-( (v-lo)/(hi-lo) )*(bot-top);
  const yMin=y(mn), yMax=y(mx), yStop=y(stop), yCl=y(cl);
  const bandTop=Math.min(yMin,yMax), bandH=Math.abs(yMin-yMax);
  const clColor = (cl>=mn&&cl<mx)?"var(--enter)":(cl>=mx?"var(--toohigh)":"var(--accent)");
  return `<div class="ladder-wrap">
    <div class="ladder" style="height:${H}px">
      <div class="rail"></div>
      <div class="band" style="top:${bandTop}px;height:${bandH}px"></div>
      <div class="lvl" style="top:${yMax}px;background:var(--toohigh)"></div>
      <div class="lvl" style="top:${yMin}px;background:var(--accent)"></div>
      <div class="lvl" style="top:${yStop}px;background:var(--bad)"></div>
      <div class="px" style="top:${yCl}px;background:${clColor}"></div>
    </div>
    <div class="ladder-legend">
      <div class="row"><span class="sw" style="background:${clColor}"></span>收盘 <b>${fmt.n2(cl)}</b></div>
      <div class="row"><span class="sw" style="background:var(--toohigh)"></span>最高买入 <b>${fmt.n2(mx)}</b></div>
      <div class="row"><span class="sw" style="background:var(--accent)"></span>最低买入 <b>${fmt.n2(mn)}</b></div>
      <div class="row"><span class="sw" style="background:var(--bad)"></span>止损候选 <b>${fmt.n2(stop)}</b></div>
    </div>
  </div>`;
}

/* SVG price chart: close line + entry band + chandelier trail + entry markers */
function chartHTML(st){
  const r=st.rows.filter(x=>x.close!=null); if(r.length<2) return "";
  const N=Math.min(r.length,180); const data=r.slice(-N);
  const W=820,H=240,padL=46,padR=12,padT=12,padB=22;
  const xs=data.map((_,i)=>padL+(i/(data.length-1))*(W-padL-padR));
  const allV=[]; data.forEach(d=>{[d.close,d.minentry,d.maxentry,d.trail].forEach(v=>{if(v!=null)allV.push(v)});});
  let lo=Math.min(...allV),hi=Math.max(...allV); const pad=(hi-lo)*0.06||1; lo-=pad;hi+=pad;
  const y=v=> padT+(1-(v-lo)/(hi-lo))*(H-padT-padB);
  const path=(key)=>{ let d="",pen=false; data.forEach((p,i)=>{const v=p[key]; if(v==null){pen=false;return;}
    d+=(pen?" L":" M")+xs[i].toFixed(1)+" "+y(v).toFixed(1); pen=true;}); return d; };
  // entry band as area between min and max
  let band="",pen=false,seg=[];
  const flush=()=>{ if(seg.length>1){ let top="M",bot="";
      seg.forEach(p=>top+=` ${p.x.toFixed(1)} ${y(p.mx).toFixed(1)} L`);
      top=top.replace(/ L$/,"");
      for(let i=seg.length-1;i>=0;i--){bot+=` L ${seg[i].x.toFixed(1)} ${y(seg[i].mn).toFixed(1)}`;}
      band+=`<path d="${top}${bot} Z" fill="rgba(57,197,207,.10)" stroke="none"/>`; } seg=[]; };
  data.forEach((p,i)=>{ if(p.minentry!=null&&p.maxentry!=null){seg.push({x:xs[i],mn:p.minentry,mx:p.maxentry});} else flush(); });
  flush();
  const markers=data.map((p,i)=> p.enter==="ENTER"
    ? `<circle cx="${xs[i].toFixed(1)}" cy="${y(p.close).toFixed(1)}" r="3.4" fill="var(--enter)" stroke="var(--bg)" stroke-width="1.5"/>`:"").join("");
  // y gridlines
  let grid="";
  for(let g=0;g<=4;g++){ const val=lo+(hi-lo)*g/4; const yy=y(val);
    grid+=`<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>`+
          `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-size="10" fill="var(--faint)" font-family="JetBrains Mono, monospace">${val.toFixed(0)}</text>`; }
  const firstD=data[0].date, lastD=data[data.length-1].date;
  return `<div class="chart-box">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid}${band}
      <path d="${path("trail")}" fill="none" stroke="var(--bad)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.8"/>
      <path d="${path("close")}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>
      ${markers}
      <text x="${padL}" y="${H-6}" font-size="10" fill="var(--faint)" font-family="JetBrains Mono, monospace">${firstD}</text>
      <text x="${W-padR}" y="${H-6}" text-anchor="end" font-size="10" fill="var(--faint)" font-family="JetBrains Mono, monospace">${lastD}</text>
    </svg>
    <div class="chart-legend">
      <span><i style="background:var(--accent)"></i>收盘</span>
      <span><i style="background:rgba(57,197,207,.5)"></i>买入区间</span>
      <span><i style="background:var(--bad)"></i>吊灯止损(trail)</span>
      <span><i style="background:var(--enter)"></i>ENTER 日</span>
    </div>
  </div>`;
}

const HCOLS=[
  ["date","日期","l",v=>v],["close","收盘","",fmt.n2],["tr","TR","",fmt.n2],
  ["atr14","ATR14","",fmt.n2],["atr50","ATR50","",fmt.n2],["selfvol","自身波动","",fmt.pct],
  ["ma20","MA20","",fmt.n2],["dev","偏离nR","",fmt.n1],["hc55","HC55","",fmt.n2],
  ["mult","倍数","",fmt.n1],["cand","Chand候选","",fmt.n2],["trail","Chand止损","",fmt.n2],
  ["hc22","HC22","",fmt.n2],["mktok","大盘","",v=>v==null?"":(v?"✓":"✕")],
  ["buf","Buf","",fmt.n2],["minentry","最低买入","",fmt.n2],["maxentry","最高买入","",fmt.n2],
  ["enter","信号","",v=>v||""],["r0","R0","",fmt.n2],["shares","股数","",fmt.n1],
  ["er22","ER22","",fmt.er],["er55","ER55","",fmt.er],
];
function histTable(st){
  const rows=st.rows.slice().reverse();
  const head="<tr>"+HCOLS.map(c=>`<th class="${c[2]?"l":""}">${c[1]}</th>`).join("")+"</tr>";
  const body=rows.map(r=>`<tr class="${r.enter==="ENTER"?"enter":""}">`+
    HCOLS.map(c=>`<td class="${c[2]?"l":""}">${c[3](r[c[0]])}</td>`).join("")+"</tr>").join("");
  return `<div class="hist-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- wiring ---------- */
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  b.classList.add("active"); view=b.dataset.view; render();
});
document.getElementById("search").addEventListener("input",e=>{q=e.target.value.trim();render();});
document.getElementById("majorFilter").addEventListener("change",e=>{fMajor=e.target.value;render();});
document.getElementById("subFilter").addEventListener("change",e=>{fSub=e.target.value;render();});
document.getElementById("drawerClose").onclick=closeDetail;
document.getElementById("scrim").onclick=closeDetail;
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeDetail();});

load();
