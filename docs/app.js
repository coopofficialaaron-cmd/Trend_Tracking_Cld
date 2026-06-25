"use strict";

const SIG_CLASS = {"Enter":"Enter","Wait":"Wait","Too High":"TooHigh","Bad Market":"BadMarket"};
// "avoid chasing the top" thresholds — a stock is flagged 过热 if ANY holds.
// Only volatility/extension matter here; ER measures trend strength, not heat.
const DEV_HOT = 2.5;      // ATR偏离(nR) > 2.5
const SELFVOL_HOT = 0.30; // ATR自身波动 > 30%

function hotReasons(s){
  const r=[];
  if(s.dev!=null && s.dev>DEV_HOT) r.push(`ATR偏离 ${fmt.n1(s.dev)} > ${DEV_HOT}`);
  if(s.selfvol!=null && s.selfvol>SELFVOL_HOT) r.push(`ATR自身波动 ${fmt.pct(s.selfvol)} > ${SELFVOL_HOT*100}%`);
  return r;
}

const fmt = {
  n2:(v)=>v==null||v===""?"":Number(v).toFixed(2),
  n1:(v)=>v==null||v===""?"":Number(v).toFixed(1),
  n0:(v)=>v==null||v===""?"":Math.round(Number(v)).toLocaleString("en-US"),
  pct:(v)=>v==null||v===""?"":(Number(v)*100).toFixed(1)+"%",
  er:(v)=>v==null||v===""?"":Number(v).toFixed(2),
  int:(v)=>v==null||v===""?"":Number(v).toLocaleString(),
};

// overview columns: key, label, align, formatter, accessor(summary)
const COLS = [
  {k:"ticker",  t:"代码", l:true, s:true, f:(s,st)=>`${freshDot(st)}<span class="tk">${st.ticker}</span>`, v:(s,st)=>st.ticker},
  {k:"name",    t:"名称", l:true, s:true, f:(s,st)=>`<span class="nm">${st.name||""}</span>`, v:(s,st)=>st.name||""},
  {k:"major",   t:"大类", l:true, s:true, f:(s,st)=>st.major?`<span class="type-tag major">${st.major}</span>`:"", v:(s,st)=>st.major||""},
  {k:"sub",     t:"小类", l:true, s:true, f:(s,st)=>st.sub?`<span class="type-tag">${st.sub}</span>`:"", v:(s,st)=>st.sub||""},
  {k:"signal",  t:"信号",        f:s=>sigTag(s.signal)+hotBadge(s), v:s=>s.signal},
  {k:"shares",  t:"股数",        f:s=>{const x=sharesFor(s.r0);return x!=null?fmt.n0(x):"";}, v:s=>{const x=sharesFor(s.r0);return x==null?-1:x;}},
  {k:"minentry",t:"最低买入",    f:s=>fmt.n2(s.minentry), v:s=>s.minentry},
  {k:"maxentry",t:"最高买入",    f:s=>fmt.n2(s.maxentry), v:s=>s.maxentry},
  {k:"premium", t:"溢价",        f:s=>colSigned(s.premium), v:s=>s.premium},
  {k:"entry_pct",t:"入场分位",   f:s=>fmt.pct(s.entry_pct), v:s=>s.entry_pct==null?-1:s.entry_pct},
  {k:"mktok",   t:"大盘",        f:s=>s.mktok==null?"":(s.mktok?`<span class="pos">✓</span>`:`<span class="neg">✕</span>`), v:s=>s.mktok?1:0},
  {k:"stop",    t:"止损",        f:s=>fmt.n2(s.stop), v:s=>s.stop},
  {k:"close",   t:"收盘",        f:s=>fmt.n2(s.close), v:s=>s.close},
  {k:"r0",      t:"R0",          f:s=>fmt.n2(s.r0), v:s=>s.r0},
  {k:"atr14",   t:"ATR14",       f:s=>fmt.n2(s.atr14), v:s=>s.atr14},
  {k:"atrpct",  t:"ATR%",        f:s=>fmt.pct(s.atrpct), v:s=>s.atrpct},
  {k:"selfvol", t:"ATR自身波动", f:s=>flagged(fmt.pct(s.selfvol), s.selfvol!=null&&s.selfvol>SELFVOL_HOT, "ATR 短期波动 > "+(SELFVOL_HOT*100)+"%，警惕追高"), v:s=>s.selfvol},
  {k:"dev",     t:"ATR偏离(nR)", f:s=>flagged(fmt.n1(s.dev), s.dev!=null&&s.dev>DEV_HOT, "偏离 MA20 > "+DEV_HOT+"×ATR，警惕高位接盘"), v:s=>s.dev},
  {k:"er22",    t:"ER22",        f:s=>fmt.er(s.er22), v:s=>s.er22},
  {k:"er55",    t:"ER55",        f:s=>fmt.er(s.er55), v:s=>s.er55},
  {k:"mult",    t:"ATR倍数",     f:s=>fmt.n1(s.mult), v:s=>s.mult},
  {k:"buf",     t:"EntryBuf",    f:s=>fmt.n2(s.buf), v:s=>s.buf},
];

function flagged(txt, on, tip){ return on ? `${txt}<span class="warn-flag" title="${tip}">⚠</span>` : txt; }
function sigTag(s){ return s?`<span class="sig ${SIG_CLASS[s]||"Wait"}">${s}</span>`:""; }
function hotBadge(s){ const r=hotReasons(s); return r.length?`<span class="hot-badge" title="过热风险，需谨慎：&#10;· ${r.join("&#10;· ")}">⚠ 过热</span>`:""; }
function colSigned(v){ if(v==null||v==="")return ""; const c=v>=0?"pos":"neg"; return `<span class="${c}">${fmt.n2(v)}</span>`; }
function num(v){ return (v==null||v==="")?null:Number(v); }

// per-stock data freshness vs the most recent expected US trading day
function stockFresh(st){
  const d = st.summary && st.summary.date;
  if(!d) return {fresh:false, date:null};
  return {fresh: d>=EXPECTED, date:d};
}
function freshDot(st){
  const f=stockFresh(st);
  if(!f.date) return `<span class="fdot none" title="无数据"></span>`;
  const tip = f.fresh ? `数据最新 · ${f.date}` : `数据滞后 · 最新 ${f.date}，应为 ${EXPECTED}（此信号可能不是当日最新）`;
  return `<span class="fdot ${f.fresh?'ok':'stale'}" title="${tip}"></span>`;
}

let DATA=null, view="signals", sort={k:"er55",dir:-1}, q="", fMajor="", fSub="", EXPECTED="", currentTk=null;
let ACCOUNT=20000, RISKPCT=1.0;   // 账户总额 / 每笔风险%

function mround(x,m){ return Math.round(x/m)*m; }
function perTradeRisk(){ return ACCOUNT * RISKPCT / 100; }       // 单笔可亏金额
function sharesFor(r0){ return (r0!=null && r0>0) ? Math.floor(perTradeRisk()/r0) : null; }
function buyPrice(s){ return s.maxentry!=null ? s.maxentry : s.close; }   // 计仓用的买入价(保守取上沿)
function capitalFor(s){ const sh=sharesFor(s.r0); return sh!=null ? sh*buyPrice(s) : null; }
function worstLossFor(s){ const sh=sharesFor(s.r0); return sh!=null ? sh*s.r0 : null; }

async function load(){
  try{
    const r = await fetch("data/index.json", {cache:"no-store"});
    DATA = await r.json();
  }catch(e){
    document.getElementById("empty").hidden=false;
    document.getElementById("empty").textContent="无法加载数据。请确认 docs/data/index.json 已生成（运行 GitHub Action 或 python engine/build.py --seed）。";
    return;
  }
  EXPECTED = lastUSTradingDay(new Date());   // most recent expected US trading day
  ACCOUNT = Number(localStorage.getItem("acctUsd")) || 20000;
  RISKPCT = Number(localStorage.getItem("riskPct")) || 1.0;
  const ai=document.getElementById("acctInput"); if(ai) ai.value=ACCOUNT.toLocaleString("en-US");
  const pi=document.getElementById("rpctInput"); if(pi) pi.value=RISKPCT;
  renderMarket();
  renderMeta();
  buildFilters();
  // default sort comes from the `sort` global (ER55 descending)
  document.getElementById("sigCount").textContent =
    DATA.stocks.filter(s=>s.summary.signal==="Enter").length;
  render();
}

function renderMeta(){
  const d=new Date(DATA.generated_at);
  document.getElementById("updated").textContent = "更新 "+d.toLocaleString();
  document.getElementById("source").textContent = "源 "+DATA.source;
  renderFreshness();
}

// ---- US market holiday calendar (full-day closures) ----
function nthWeekday(year, month, weekday, n){ // month 0-based; weekday 0=Sun
  let d=new Date(Date.UTC(year,month,1)), count=0;
  while(true){ if(d.getUTCDay()===weekday){ count++; if(count===n) return d; } d.setUTCDate(d.getUTCDate()+1); }
}
function lastWeekday(year, month, weekday){
  let d=new Date(Date.UTC(year,month+1,0));
  while(d.getUTCDay()!==weekday) d.setUTCDate(d.getUTCDate()-1);
  return d;
}
function observed(dt){ // Sat -> Fri, Sun -> Mon
  const w=dt.getUTCDay();
  if(w===6) dt.setUTCDate(dt.getUTCDate()-1);
  else if(w===0) dt.setUTCDate(dt.getUTCDate()+1);
  return dt;
}
function iso(dt){ return dt.toISOString().slice(0,10); }
function usHolidays(year){
  const H=new Set();
  const fixed=[[0,1],[5,19],[6,4],[11,25]]; // New Year, Juneteenth, July 4, Christmas
  fixed.forEach(([m,day])=>H.add(iso(observed(new Date(Date.UTC(year,m,day))))));
  H.add(iso(nthWeekday(year,0,1,3)));   // MLK: 3rd Mon Jan
  H.add(iso(nthWeekday(year,1,1,3)));   // Presidents: 3rd Mon Feb
  H.add(iso(lastWeekday(year,4,1)));    // Memorial: last Mon May
  H.add(iso(nthWeekday(year,8,1,1)));   // Labor: 1st Mon Sep
  H.add(iso(nthWeekday(year,10,4,4)));  // Thanksgiving: 4th Thu Nov
  return H;
}
function lastUSTradingDay(now){
  // step back from "today in US Eastern" to the most recent weekday that isn't a holiday
  const et=new Date(now.toLocaleString("en-US",{timeZone:"America/New_York"}));
  let d=new Date(Date.UTC(et.getFullYear(),et.getMonth(),et.getDate()));
  // before ~16:20 ET, today's EOD isn't out yet -> expect previous trading day
  const mins=et.getHours()*60+et.getMinutes();
  if(mins < 16*60+20) d.setUTCDate(d.getUTCDate()-1);
  for(let i=0;i<10;i++){
    const w=d.getUTCDay(); const hol=usHolidays(d.getUTCFullYear());
    if(w!==0 && w!==6 && !hol.has(iso(d))) return iso(d);
    d.setUTCDate(d.getUTCDate()-1);
  }
  return iso(d);
}
function renderFreshness(){
  const el=document.getElementById("freshness"); if(!el) return;
  const withData=DATA.stocks.filter(s=>s.summary&&s.summary.date);
  if(!withData.length){ el.style.display="none"; return; }
  el.style.display="";
  const stale=withData.filter(s=>s.summary.date<EXPECTED);
  if(stale.length===0){
    el.className="freshness ok";
    el.innerHTML=`<span class="dot"></span>全部最新 · ${EXPECTED.slice(5).replace("-","/")}`;
    el.title=`全部 ${withData.length} 只都已更新到最近的美股交易日 ${EXPECTED}。`;
  }else{
    el.className="freshness stale";
    el.innerHTML=`<span class="dot"></span>${stale.length} 只滞后`;
    el.title=`最近的美股交易日应为 ${EXPECTED}。\n以下 ${stale.length} 只数据较旧，对应信号可能不是当日最新：\n`+
             stale.map(s=>`· ${s.ticker} (${s.summary.date})`).join("\n");
  }
}

// ETF display names and rough size ranking (largest first)
const ETF_NAME={SPY:"标普500",QQQ:"纳斯达克100",XLK:"科技",SOXX:"半导体",IGV:"软件",
  DTCR:"数据中心",QTUM:"量子计算",ITA:"航空国防",XLE:"能源",SEA:"海运",AMLP:"油气管道",
  XLU:"公用事业",TAN:"太阳能",GRID:"智能电网",NLR:"核能",XME:"金属矿业",GDX:"金矿",
  SIL:"银矿",COPX:"铜矿",URA:"铀",XLF:"金融",MOO:"农业",XLB:"材料",XLI:"工业",
  IYT:"运输",XLV:"医疗",XLRE:"房地产",XBI:"生物科技",IHI:"医疗器械",XLY:"可选消费"};
const ETF_SIZE=["SPY","QQQ","XLK","XLV","XLF","XLE","XLI","XLY","XLB","XLU","XLRE","SOXX","IGV",
  "XBI","GDX","ITA","IHI","XME","URA","TAN","MOO","COPX","SIL","AMLP","IYT","SEA","NLR","GRID","DTCR","QTUM"];
const ETF_PIN={SPY:0,QQQ:1};
function etfRank(b){ const i=ETF_SIZE.indexOf(b); return i<0?999:i; }
function etfLabel(b){ return ETF_NAME[b]?`${b} · ${ETF_NAME[b]}`:b; }

function renderMarket(){
  const el=document.getElementById("market"); el.innerHTML="";
  const keys=Object.keys(DATA.market||{}).filter(b=>DATA.market[b]);
  keys.sort((a,b)=>{
    const pa=ETF_PIN[a]??99, pb=ETF_PIN[b]??99;
    if(pa!==pb && (pa<99||pb<99)) return pa-pb;          // SPY, QQQ pinned first
    const oa=DATA.market[a].ok?0:1, ob=DATA.market[b].ok?0:1;
    if(oa!==ob) return oa-ob;                             // 向上 before 回避
    return etfRank(a)-etfRank(b);                         // then by size
  });
  keys.forEach(b=>{
    const m=DATA.market[b]; const ok=m&&m.ok;
    const div=document.createElement("div");
    div.className="pill "+(ok?"ok":(m?"no":""));
    const nm=ETF_NAME[b]?`(${ETF_NAME[b]})`:"";
    div.innerHTML=`<b>${b}</b>${nm} <span class="arrow">${ok?"↑":"↓"}</span>`;
    div.title = (ETF_NAME[b]?ETF_NAME[b]+" · ":"") + (ok?"向上（可入场）":"回避") +
      (m ? ` · 收盘 ${fmt.n2(m.close)} · SMA100 ${fmt.n2(m.sma100)} · 10日 ${fmt.pct(m.dd10)}` : "");
    el.appendChild(div);
  });
}

function buildFilters(){
  renderMajorTiles();
  refreshSubOptions();
}

function hasData(s){ return s.summary && s.summary.date; }
function renderMajorTiles(){
  const pool=DATA.stocks.filter(hasData);
  const counts={};
  pool.forEach(s=>{ if(s.major) counts[s.major]=(counts[s.major]||0)+1; });
  const majors=Object.keys(counts).sort((a,b)=>counts[b]-counts[a] || a.localeCompare(b));
  const el=document.getElementById("majorTiles"); el.innerHTML="";
  const mk=(val,label)=>{
    const b=document.createElement("button");
    b.className="tile"+((fMajor===val)?" active":"");
    b.innerHTML=label; b.dataset.val=val;
    b.onclick=()=>{ fMajor=val; refreshSubOptions(); renderMajorTiles(); render(); };
    el.appendChild(b);
  };
  mk("",`全部 <span class="tcount">${pool.length}</span>`);
  majors.forEach(m=>mk(m,`${m} <span class="tcount">${counts[m]}</span>`));
}

function refreshSubOptions(){
  const pool=DATA.stocks.filter(s=>hasData(s) && (!fMajor||s.major===fMajor));
  const subs=[...new Set(pool.map(s=>s.sub).filter(Boolean))].sort();
  if(fSub && !subs.includes(fSub)) fSub="";
  const sel=document.getElementById("subFilter");
  sel.innerHTML='<option value="">全部小类</option>'+
    subs.map(s=>`<option value="${s}"${s===fSub?" selected":""}>${s}</option>`).join("");
}

function rows(){
  let list = DATA.stocks.filter(s=>s.summary && s.summary.date);  // hide no-data tickers
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
  head.innerHTML="<tr>"+COLS.map((c,i)=>{
    const arrow = sort.k===c.k?`<span class="arrow">${sort.dir>0?"▲":"▼"}</span>`:"";
    const cls=(c.l?"l ":"")+(c.s?`sticky col${i}`:"");
    return `<th class="${cls.trim()}" data-k="${c.k}">${c.t}${arrow}</th>`;
  }).join("")+"</tr>";
  head.querySelectorAll("th").forEach(th=>th.onclick=()=>{ sortBy(th.dataset.k); render(); });

  const list=rows();
  const body=document.querySelector("#grid tbody");
  body.innerHTML = list.map(st=>{
    const s=st.summary;
    const hot = (view==="signals") && hotReasons(s).length>0;
    const cls = hot ? "hot" : (s.signal==="Enter" ? "enter" : "");
    return `<tr data-tk="${st.ticker}" class="${cls}">`+
      COLS.map((c,i)=>`<td class="${(c.l?"l ":"")+(c.s?`sticky col${i}`:"")}">${c.f(s,st)??""}</td>`).join("")+`</tr>`;
  }).join("");
  body.querySelectorAll("tr").forEach(tr=>tr.onclick=()=>openDetail(tr.dataset.tk));

  const empty=document.getElementById("empty");
  empty.hidden = list.length>0;
  if(!list.length) empty.textContent = view==="signals"?"当前没有 ENTER 信号。":"没有匹配的股票。";
  renderRiskReadout();
}

function sortBy(k){
  if(sort.k===k) sort.dir*=-1;
  else { sort.k=k; sort.dir = (k==="ticker"||k==="name"||k==="major"||k==="sub"||k==="signal")?1:-1; }
}

/* ---------- detail drawer ---------- */
function detailFresh(st){
  const f=stockFresh(st); if(!f.date) return "";
  return f.fresh
    ? `<span class="freshness ok sm"><span class="dot"></span>数据最新 · ${f.date}</span>`
    : `<span class="freshness stale sm" title="应为 ${EXPECTED}"><span class="dot"></span>数据滞后 · ${f.date}</span>`;
}
async function openDetail(tk){
  const st=DATA.stocks.find(s=>s.ticker===tk); if(!st) return;
  currentTk=tk;
  // show drawer immediately with a loading note
  document.getElementById("scrim").hidden=false;
  const dr=document.getElementById("drawer"); dr.hidden=false; dr.setAttribute("aria-hidden","false"); dr.scrollTop=0;
  if(!st.rows){
    document.getElementById("detail").innerHTML=
      `<div class="d-head"><h2>${st.ticker}</h2><span class="dname">${st.name||""}</span></div><p class="loading">加载历史数据…</p>`;
    if(st.file){
      try{ const r=await fetch(`data/stocks/${st.file}.json`,{cache:"no-store"}); const j=await r.json(); st.rows=j.rows||[]; }
      catch(e){ st.rows=[]; }
    } else { st.rows=[]; }
    if(currentTk!==tk) return;   // user moved on while loading
  }
  renderDetailBody(st);
  wireChart();
}

function renderDetailBody(st){
  const s=st.summary;
  const keyCards=[
    ["最新日期",s.date||"—"],["最新收盘",fmt.n2(s.close)],["ATR%",fmt.pct(s.atrpct)],
    ["ATR偏离(nR)",fmt.n1(s.dev)],["ATR自身波动",fmt.pct(s.selfvol)],["ATR14",fmt.n2(s.atr14)],
  ];
  const restCards=[
    ["止损(候选)",fmt.n2(s.stop)],["最低买入",fmt.n2(s.minentry)],["最高买入",fmt.n2(s.maxentry)],
    ["溢价",fmt.n2(s.premium)],["入场分位",fmt.pct(s.entry_pct)],
    ["ER22",fmt.er(s.er22)],["ER55",fmt.er(s.er55)],["ATR50",fmt.n2(s.atr50)],
    ["R0(每股风险)",fmt.n2(s.r0)],["可建仓股数",(()=>{const x=sharesFor(s.r0);return x!=null?fmt.n0(x):"—";})()],
    ["占用资金",(()=>{const c=capitalFor(s);return c!=null?"$"+fmt.n0(c):"—";})()],
    ["最坏亏损",(()=>{const w=worstLossFor(s);return w!=null?"−$"+fmt.n0(w):"—";})()],
    ["ATR倍数",fmt.n1(s.mult)],["EntryBuffer",fmt.n2(s.buf)],
  ];
  const cardHTML=(arr)=>arr.map(([k,v])=>`<div class="card"><div class="k">${k}</div><div class="v">${v||"—"}</div></div>`).join("");
  const flags=hotReasons(s);
  const note = flags.length
      ? `⚠ 过热风险，需谨慎：${flags.join("；")}`
      : (s.signal==="Enter"?"收盘位于买入区间内，大盘向上，止损低于入场价。":"");

  document.getElementById("detail").innerHTML = `
    <div class="d-head">
      <h2>${st.ticker}</h2><span class="dname">${st.name||""}</span>
      ${detailFresh(st)}
      ${st.major?`<span class="type-tag major">${st.major}</span>`:""}
      ${st.sub?`<span class="type-tag">${st.sub}</span>`:""}
    </div>
    <div class="signal-row">
      ${sigTag(s.signal)}
      <span class="note">对标 ${st.benchmark}（${DATA.market[st.benchmark]&&DATA.market[st.benchmark].ok?"向上":"回避"}）· 账户 $${fmt.n0(ACCOUNT)} × 每笔 ${RISKPCT}% = 单笔可亏 $${fmt.n0(perTradeRisk())} · 突破确认 +${fmt.pct(st.breakout)}</span>
    </div>
    ${note?`<div class="${flags.length?"hot-banner":"calm-note"}">${note}</div>`:""}
    <div class="hero">
      <div class="hero-left">${gaugeHTML(s)}</div>
      <div class="hero-right"><div class="cards">${cardHTML(keyCards)}</div></div>
    </div>
    <div class="cards">${cardHTML(restCards)}</div>
    ${chartHTML(st)}
    <div class="hist-head"><h3>历史数据与逐日计算</h3><span class="hint">与你原表的股票 tab 一致（最近在上）</span></div>
    ${histTable(st)}
  `;
}
function closeDetail(){
  currentTk=null;
  document.getElementById("scrim").hidden=true;
  const dr=document.getElementById("drawer"); dr.hidden=true; dr.setAttribute("aria-hidden","true");
}

/* horizontal entry gauge: close position within the buy zone; stop shown separately */
function gaugeHTML(s){
  const mn=num(s.minentry), mx=num(s.maxentry), cl=num(s.close), stop=num(s.stop);
  if([mn,mx,cl].some(v=>v==null)) return `<div class="gauge"><div class="gauge-head"><span class="g-pos">暂无入场区间</span></div></div>`;
  const zone=Math.max(mx-mn, mx*0.004);
  // domain centred on the buy zone (independent of how far close sits), so the
  // band always keeps a readable width and labels never collide
  const lo=mn-zone*0.9, hi=mx+zone*0.9;
  const pct=v=> Math.max(0,Math.min(100, ((v-lo)/(hi-lo))*100 ));
  const inZone = cl>=mn && cl<mx;
  const clColor = inZone?"var(--enter)":(cl>=mx?"var(--toohigh)":"var(--accent)");
  const posTxt = inZone? `区间内 · 分位 ${fmt.pct(s.entry_pct)}` : (cl>=mx? "高于上限 · 追高":"低于入场价");
  const sh=sharesFor(s.r0); const cap=capitalFor(s); const wl=worstLossFor(s);
  return `<div class="gauge">
    <div class="gauge-head">
      <span class="g-close" style="color:${clColor}">收盘 ${fmt.n2(cl)}</span>
      <span class="g-pos" style="color:${clColor}">${posTxt}</span>
    </div>
    <div class="gauge-track">
      <div class="g-zone" style="left:${pct(mn)}%;width:${Math.max(pct(mx)-pct(mn),2)}%"></div>
      <div class="g-mark" style="left:${pct(cl)}%;background:${clColor}"></div>
    </div>
    <div class="gauge-scale"><span>最低 ${fmt.n2(mn)}</span><span>最高 ${fmt.n2(mx)}</span></div>
    <div class="gauge-foot">
      <span><i style="background:var(--bad)"></i>止损候选 <b>${fmt.n2(stop)}</b></span>
      <span>可建仓 <b>${sh!=null?fmt.n0(sh):"—"}</b> 股</span>
      <span>占用 <b>${cap!=null?"$"+fmt.n0(cap):"—"}</b></span>
      <span>最坏 <b>${wl!=null?"−$"+fmt.n0(wl):"—"}</b></span>
    </div>
  </div>`;
}

/* SVG price chart: close line + entry band + chandelier trail + entry markers */
function chartHTML(st){
  const r=st.rows.filter(x=>x.close!=null); if(r.length<2) return "";
  const N=Math.min(r.length,180); const data=r.slice(-N);
  const W=820,H=250,padL=46,padR=14,padT=12,padB=26;
  const xs=data.map((_,i)=>padL+(i/(data.length-1))*(W-padL-padR));
  const allV=[]; data.forEach(d=>{[d.close,d.minentry,d.maxentry,d.trail].forEach(v=>{if(v!=null)allV.push(v)});});
  let lo=Math.min(...allV),hi=Math.max(...allV); const pad=(hi-lo)*0.06||1; lo-=pad;hi+=pad;
  const y=v=> padT+(1-(v-lo)/(hi-lo))*(H-padT-padB);
  const path=(key)=>{ let d="",pen=false; data.forEach((p,i)=>{const v=p[key]; if(v==null){pen=false;return;}
    d+=(pen?" L":" M")+xs[i].toFixed(1)+" "+y(v).toFixed(1); pen=true;}); return d; };
  // entry band area between min and max
  let band="",seg=[];
  const flush=()=>{ if(seg.length>1){ let top="M",bot="";
      seg.forEach(p=>top+=` ${p.x.toFixed(1)} ${y(p.mx).toFixed(1)} L`);
      top=top.replace(/ L$/,"");
      for(let i=seg.length-1;i>=0;i--){bot+=` L ${seg[i].x.toFixed(1)} ${y(seg[i].mn).toFixed(1)}`;}
      band+=`<path d="${top}${bot} Z" fill="var(--band)" stroke="none"/>`; } seg=[]; };
  data.forEach((p,i)=>{ if(p.minentry!=null&&p.maxentry!=null){seg.push({x:xs[i],mn:p.minentry,mx:p.maxentry});} else flush(); });
  flush();
  const markers=data.map((p,i)=> p.enter==="ENTER"
    ? `<circle cx="${xs[i].toFixed(1)}" cy="${y(p.close).toFixed(1)}" r="3.4" fill="var(--enter)" stroke="#fff" stroke-width="1.5"/>`:"").join("");
  // y gridlines
  let grid="";
  for(let g=0;g<=4;g++){ const val=lo+(hi-lo)*g/4; const yy=y(val);
    grid+=`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-padR}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`+
          `<text x="${padL-6}" y="${(yy+3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--faint)" font-family="JetBrains Mono, monospace">${val.toFixed(0)}</text>`; }
  // monthly x ticks
  let xticks="", lastM="";
  data.forEach((p,i)=>{ const ym=p.date.slice(0,7);
    if(ym!==lastM){ lastM=ym;
      const lab = p.date.slice(2,7).replace("-","/");   // YY/MM
      xticks+=`<line x1="${xs[i].toFixed(1)}" y1="${padT}" x2="${xs[i].toFixed(1)}" y2="${H-padB}" stroke="var(--line)" stroke-width="1" opacity="0.6"/>`+
              `<text x="${xs[i].toFixed(1)}" y="${H-8}" text-anchor="middle" font-size="9.5" fill="var(--faint)" font-family="JetBrains Mono, monospace">${lab}</text>`;
    }});
  // points payload for interaction
  const pts=data.map((p,i)=>({x:+xs[i].toFixed(1), cy:+y(p.close).toFixed(1),
    date:p.date, close:p.close, trail:p.trail, mn:p.minentry, mx:p.maxentry, enter:p.enter==="ENTER"}));
  CHART={pts, W, H, padT, padB:H-padB};
  return `<div class="chart-box" id="chartBox">
    <svg id="priceChart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid}${xticks}${band}
      <path d="${path("trail")}" fill="none" stroke="var(--bad)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.85"/>
      <path d="${path("close")}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>
      ${markers}
      <g id="chartCross" style="display:none">
        <line id="crossX" y1="${padT}" y2="${H-padB}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
        <circle id="crossDot" r="4" fill="var(--accent)" stroke="#fff" stroke-width="1.5"/>
      </g>
      <rect id="chartHit" x="${padL}" y="${padT}" width="${W-padL-padR}" height="${H-padT-padB}" fill="transparent"/>
    </svg>
    <div id="chartTip" class="chart-tip" style="display:none"></div>
    <div class="chart-legend">
      <span><i style="background:var(--accent)"></i>收盘</span>
      <span><i style="background:var(--band)"></i>买入区间</span>
      <span><i style="background:var(--bad)"></i>吊灯止损(trail)</span>
      <span><i style="background:var(--enter)"></i>ENTER 日</span>
    </div>
  </div>`;
}

let CHART=null;
function wireChart(){
  const svg=document.getElementById("priceChart"); if(!svg||!CHART) return;
  const hit=document.getElementById("chartHit"), cross=document.getElementById("chartCross");
  const cx=document.getElementById("crossX"), dot=document.getElementById("crossDot");
  const tip=document.getElementById("chartTip"), box=document.getElementById("chartBox");
  const {pts,W}=CHART;
  const move=(ev)=>{
    const rect=svg.getBoundingClientRect();
    const clientX=(ev.touches?ev.touches[0].clientX:ev.clientX);
    const vbX=(clientX-rect.left)/rect.width*W;
    let best=pts[0],bd=1e9;
    for(const p of pts){const d=Math.abs(p.x-vbX); if(d<bd){bd=d;best=p;}}
    cross.style.display=""; cx.setAttribute("x1",best.x); cx.setAttribute("x2",best.x);
    dot.setAttribute("cx",best.x); dot.setAttribute("cy",best.cy);
    const row=(c,k,v)=>v==null?"":`<div class="tr"><span class="sw" style="background:${c}"></span>${k}<b>${fmt.n2(v)}</b></div>`;
    tip.innerHTML=`<div class="dt">${best.date}${best.enter?' · <span style="color:var(--enter)">ENTER</span>':''}</div>`+
      row('var(--accent)','收盘',best.close)+
      ((best.mn!=null)?`<div class="tr"><span class="sw" style="background:var(--band);border:1px solid var(--accent)"></span>买入区间<b>${fmt.n2(best.mn)}–${fmt.n2(best.mx)}</b></div>`:'')+
      row('var(--bad)','止损',best.trail);
    tip.style.display="";
    // position tooltip within the box, follow cursor
    const brect=box.getBoundingClientRect();
    let left=clientX-brect.left+14;
    if(left+170>brect.width) left=clientX-brect.left-184;
    tip.style.left=Math.max(4,left)+"px";
    tip.style.top="14px";
  };
  const leave=()=>{cross.style.display="none"; tip.style.display="none";};
  hit.addEventListener("mousemove",move);
  hit.addEventListener("touchmove",move,{passive:true});
  hit.addEventListener("mouseleave",leave);
  hit.addEventListener("touchend",leave);
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
document.getElementById("subFilter").addEventListener("change",e=>{fSub=e.target.value;render();});
function applySizing(){
  const rawAcct = (document.getElementById("acctInput").value||"").replace(/[, ]/g,"");
  ACCOUNT = Math.max(0, Number(rawAcct)||0);
  RISKPCT = Math.max(0.1, Number(document.getElementById("rpctInput").value)||0);
  localStorage.setItem("acctUsd", String(ACCOUNT));
  localStorage.setItem("riskPct", String(RISKPCT));
  document.getElementById("acctInput").value = ACCOUNT.toLocaleString("en-US");
  document.getElementById("rpctInput").value = RISKPCT;
  render();
  if(currentTk && !document.getElementById("drawer").hidden){ openDetail(currentTk); }
}
function renderRiskReadout(){
  const el=document.getElementById("riskReadout"); if(!el) return;
  el.innerHTML=`单笔可亏 <b>$${fmt.n0(perTradeRisk())}</b>`;
}
["acctInput","rpctInput"].forEach(id=>{
  const el=document.getElementById(id); if(!el) return;
  el.addEventListener("change",applySizing);
  el.addEventListener("keydown",e=>{if(e.key==="Enter"){applySizing();el.blur();}});
});

/* ---------- in-app add stock ---------- */
const CFG_COLS=["ticker","exchange","benchmark","major","sub"];
function csvCell(v){ v=(v==null?"":String(v)); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }
function currentConfigRows(){
  // reconstruct current config.csv rows from loaded data (committed source of truth)
  const seen=new Set(), out=[];
  DATA.stocks.forEach(s=>{
    const k=(s.ticker||"").toUpperCase();
    if(!k || seen.has(k)) return;     // drop duplicate tickers
    seen.add(k);
    out.push([s.ticker,s.exchange||"",s.benchmark||"",s.major||"",s.sub||""]);
  });
  return out;
}
let pending=[];
try{ pending=JSON.parse(localStorage.getItem("pendingAdds")||"[]"); }catch(e){ pending=[]; }

function ghEditUrl(){
  // derive owner/repo from a github.io URL: {owner}.github.io/{repo}/...
  const h=location.hostname, parts=location.pathname.split("/").filter(Boolean);
  if(h.endsWith("github.io") && parts.length){
    const owner=h.split(".")[0], repo=parts[0];
    return `https://github.com/${owner}/${repo}/edit/main/config.csv`;
  }
  return null;
}
function fillDatalists(){
  const uniq=(k)=>[...new Set(DATA.stocks.map(s=>s[k]).filter(Boolean))].sort();
  // benchmark options: known config ETFs + the full named set, with name labels
  const used=uniq("benchmark");
  const all=[...new Set([...used, ...Object.keys(ETF_NAME)])];
  all.sort((a,b)=>etfRank(a)-etfRank(b));
  document.getElementById("benchList").innerHTML=
    all.map(b=>`<option value="${b}">${etfLabel(b)}</option>`).join("");
  document.getElementById("majorList").innerHTML=uniq("major").map(v=>`<option value="${v}">`).join("");
  document.getElementById("exchList").innerHTML=uniq("exchange").map(v=>`<option value="${v}">`).join("");
  refreshAddSubs();
}
function refreshAddSubs(){
  const mj=document.getElementById("f_major").value.trim();
  const pool=DATA.stocks.filter(s=>s.sub && (!mj || s.major===mj));
  const subs=[...new Set(pool.map(s=>s.sub))].sort();
  document.getElementById("subList").innerHTML=subs.map(v=>`<option value="${v}">`).join("");
}
function openAdd(){
  fillDatalists();
  document.getElementById("addScrim").hidden=false;
  document.getElementById("addModal").hidden=false;
  document.getElementById("dupNote").textContent="";
  document.getElementById("f_ticker").classList.remove("dup");
  document.getElementById("addQueue").disabled=false;
  renderPending();
}
function closeAdd(){
  document.getElementById("addScrim").hidden=true;
  document.getElementById("addModal").hidden=true;
}
function checkDup(){
  const inp=document.getElementById("f_ticker");
  const note=document.getElementById("dupNote");
  const btn=document.getElementById("addQueue");
  const t=(inp.value||"").trim().toUpperCase();
  if(!t){ note.textContent=""; inp.classList.remove("dup"); btn.disabled=false; return false; }
  const inCfg = currentConfigRows().some(r=>r[0]===t);
  const inPend = pending.some(r=>r[0]===t);
  if(inCfg || inPend){
    const where = inCfg ? "已在清单中" : "已在待添加中";
    note.textContent = `⚠ ${t} ${where}，无需重复添加`;
    inp.classList.add("dup"); btn.disabled=true; return true;
  }
  note.textContent=""; inp.classList.remove("dup"); btn.disabled=false; return false;
}
function queueAdd(){
  if(checkDup()) return;                      // block duplicates
  const g=id=>document.getElementById(id).value.trim();
  const t=g("f_ticker").toUpperCase();
  if(!t){ document.getElementById("f_ticker").focus(); return; }
  pending.push([t, g("f_exch"), g("f_bench")||"SPY", g("f_major")||"国防航空航天", g("f_sub")]);
  localStorage.setItem("pendingAdds",JSON.stringify(pending));
  ["f_ticker","f_exch","f_bench","f_major","f_sub"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("dupNote").textContent="";
  document.getElementById("f_ticker").focus();
  renderPending();
}
function renderPending(){
  const box=document.getElementById("pendingBox"), note=document.getElementById("pendingNote");
  if(!pending.length){ box.hidden=true; note.textContent=""; return; }
  box.hidden=false;
  note.textContent=`待添加 ${pending.length} 只`;
  document.getElementById("pendingList").innerHTML = pending.map((r,i)=>
    `<span class="pchip">${r[0]} <span class="px" data-i="${i}">×</span></span>`).join("");
  document.getElementById("pendingList").querySelectorAll(".px").forEach(x=>x.onclick=()=>{
    pending.splice(+x.dataset.i,1); localStorage.setItem("pendingAdds",JSON.stringify(pending)); renderPending();
  });
  const all=[CFG_COLS, ...currentConfigRows(), ...pending];
  document.getElementById("cfgOut").value = all.map(r=>r.map(csvCell).join(",")).join("\n");
  const url=ghEditUrl(); const link=document.getElementById("ghLink"); const hint=document.getElementById("ghHint");
  if(url){ link.href=url; link.style.display=""; hint.textContent="点开后：全选粘贴覆盖 → Commit changes，提交即自动重算。"; }
  else { link.style.display="none"; hint.textContent="本地预览：把上面内容保存为仓库根目录的 config.csv 后提交。"; }
}
document.getElementById("addBtn").onclick=openAdd;
document.getElementById("addClose").onclick=closeAdd;
document.getElementById("addScrim").onclick=closeAdd;
document.getElementById("addQueue").onclick=queueAdd;
document.getElementById("f_ticker").addEventListener("keydown",e=>{if(e.key==="Enter")queueAdd();});
document.getElementById("f_ticker").addEventListener("input",checkDup);
document.getElementById("f_major").addEventListener("input",refreshAddSubs);
document.getElementById("clearPending").onclick=()=>{ pending=[]; localStorage.removeItem("pendingAdds"); renderPending(); };
document.getElementById("copyCfg").onclick=()=>{
  const ta=document.getElementById("cfgOut"); ta.select();
  navigator.clipboard?.writeText(ta.value).then(()=>{
    const b=document.getElementById("copyCfg"); b.textContent="已复制 ✓"; setTimeout(()=>b.textContent="复制全部",1500);
  }).catch(()=>document.execCommand("copy"));
};
document.getElementById("drawerClose").onclick=closeDetail;
document.getElementById("scrim").onclick=closeDetail;
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeDetail();});

load();
