/* 持仓管理 — 与信号引擎同源、同收盘价口径、同 ATR 自适应止损
   初始止损 = 入场当日吊灯候选 cand（定 R0）
   今日止损 = 入场锚定：从入场日起对每日 cand 取棘轮最大（只升不降；每晚拿收盘价与它比较，跌破则次日开盘市价卖出）
             入场日晚于最后一根数据时（当晚建仓、入场日填次日）→ 不棘轮，直接用初始止损
   持仓存 localStorage；可同步到仓库 positions.json 跨设备查看。 */
"use strict";

const ADD_MAX=3, MILESTONE=1.5, ADD_FACTOR=0.8, POS_KEY="tt_positions_v1";

const fmt={
  n1:v=>v==null||v===""?"":(+v).toLocaleString("en-US",{maximumFractionDigits:1}),
  n2:v=>v==null||v===""?"":(+v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),
  money:v=>v==null?"":(v<0?"-$":"$")+Math.abs(v).toLocaleString("en-US",{maximumFractionDigits:0}),
  money2:v=>v==null?"":(v<0?"-$":"$")+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),
  pct:v=>v==null||v===""?"":(v*100).toFixed(1)+"%",
  signedPct:v=>v==null?"":(v>=0?"+":"")+(v*100).toFixed(1)+"%",
  er:v=>v==null||v===""?"":(+v).toFixed(2),
  n0:v=>v==null||v===""?"":Math.round(+v).toLocaleString("en-US"),
  pct0:v=>v==null||v===""?"":(v*100).toFixed(0)+"%",
  signedPct0:v=>v==null?"":(v>=0?"+":"")+(v*100).toFixed(0)+"%",
};
const num=v=>(v==null||v==="")?null:Number(v);
function signed(v,f){ if(v==null)return ""; const c=v>=0?"pos":"neg"; return `<span class="${c}">${f(v)}</span>`; }

let DATA=null, SUM={}, ROWS={}, LIVE={}, POS=[], ACCOUNT=20000, RISKPCT=1.0, q="", secFilter="";
let DIRTY=false, CLOUD_EXISTS=false;

const mround=(x,m)=>Math.round(x/m)*m;
const perTradeRisk=()=>ACCOUNT*RISKPCT/100;
const stopOf=r=>(r.final??r.trail??r.cand);

async function load(){
  try{ const r=await fetch("data/index.json",{cache:"no-store"}); DATA=await r.json(); }
  catch(e){ const el=document.getElementById("empty"); el.hidden=false;
    el.innerHTML="无法加载 <code>data/index.json</code>。请确认信号引擎已生成数据。"; return; }
  (DATA.stocks||[]).forEach(s=>{ if(s.summary&&s.summary.date) SUM[s.ticker]={...s.summary,name:s.name,file:s.file,major:s.major,sub:s.sub}; });
  ACCOUNT=Number(localStorage.getItem("acctUsd"))||20000;
  RISKPCT=Number(localStorage.getItem("riskPct"))||1.0;
  await loadPositions();
  initControls(); renderMeta(); fillTickerList();
  await buildLive();
  render();
}

/* ===== 持久化 + 云端同步 ===== */
function saveLocal(){ localStorage.setItem(POS_KEY,JSON.stringify({pos:POS,dirty:DIRTY})); }
function savePositions(){ DIRTY=true; saveLocal(); markDirty(); }
async function loadPositions(){
  let local=null, localDirty=false;
  try{ const o=JSON.parse(localStorage.getItem(POS_KEY)); if(o){ local=Array.isArray(o)?o:(o.pos||[]); localDirty=Array.isArray(o)?false:!!o.dirty; } }catch(e){}
  let cloud=null;
  try{ const r=await fetch("positions.json",{cache:"no-store"}); if(r.ok){ const j=await r.json(); if(Array.isArray(j)){ cloud=j; CLOUD_EXISTS=true; } } }catch(e){}
  if(localDirty&&local){ POS=local; DIRTY=true; }            // 本机有未同步改动 → 保留
  else if(cloud){ POS=cloud; DIRTY=false; saveLocal(); }     // 否则以云端为准
  else if(local){ POS=local; DIRTY=localDirty; }
  else POS=[];
}
function markDirty(){ const b=document.getElementById("syncBtn"); if(b){ b.classList.toggle("dirty",DIRTY); b.textContent=DIRTY?"同步 ●":"同步"; } }

function renderMeta(){
  document.getElementById("updated").textContent=DATA.generated_at?("更新 "+DATA.generated_at.replace("T"," ").slice(0,16)):"—";
  document.getElementById("source").textContent=DATA.source?("源 "+DATA.source):"";
  const mk=DATA.market; const ok=(typeof mk==="object"&&mk)?(mk.ok??mk.bull??true):!!mk;
  const f=document.getElementById("freshness"); f.className="freshness "+(ok?"ok":"stale");
  f.innerHTML=`<span class="dot"></span>${ok?"大盘 OK · 可建仓":"大盘弱 · 暂停新仓"}`;
}

function initControls(){
  const acct=document.getElementById("acctInput"), rp=document.getElementById("rpctInput");
  acct.value=ACCOUNT.toLocaleString("en-US"); rp.value=RISKPCT;
  const syncRiskLabel=()=>{ const el=document.getElementById("riskReadout");
    if(el) el.innerHTML=`单笔可亏 <b>$${Math.round(perTradeRisk()).toLocaleString("en-US")}</b>`; };
  syncRiskLabel();
  (function(){ const grp=document.getElementById("riskGroup"), tog=document.getElementById("riskToggle");
    if(!grp||!tog) return;
    tog.onclick=e=>{ e.stopPropagation(); const was=grp.classList.contains("collapsed");
      grp.classList.toggle("collapsed"); if(was) acct.focus(); };
    document.addEventListener("click",e=>{ if(!grp.contains(e.target)) grp.classList.add("collapsed"); });
    document.addEventListener("keydown",e=>{ if(e.key==="Escape") grp.classList.add("collapsed"); });
  })();
  acct.addEventListener("input",()=>{ const v=Number(acct.value.replace(/[^0-9.]/g,"")); if(v>0){ACCOUNT=v;localStorage.setItem("acctUsd",v);syncRiskLabel();render();} });
  rp.addEventListener("input",()=>{ const v=Number(rp.value); if(v>0){RISKPCT=v;localStorage.setItem("riskPct",v);syncRiskLabel();render();} });
  document.getElementById("search").addEventListener("input",e=>{ q=e.target.value.trim().toUpperCase(); render(); });
  document.getElementById("addBtn").addEventListener("click",openAdd);
  document.getElementById("addClose").addEventListener("click",closeAdd);
  document.getElementById("addScrim").addEventListener("click",closeAdd);
  document.getElementById("addSave").addEventListener("click",saveNewPosition);
  ["f_ticker","f_date","f_price","f_stop","f_loss","f_shares"].forEach(id=>
    document.getElementById(id).addEventListener("input",refreshSizePreview));
  document.getElementById("f_ticker").addEventListener("change",onTickerPick);
  document.getElementById("f_date").addEventListener("input",autofillStop);
  document.getElementById("f_stop").addEventListener("input",e=>{e.target.dataset.touched="1";});
  document.getElementById("f_date").addEventListener("change",e=>{e.target.dataset.touched="1";});
  document.getElementById("drawerClose").addEventListener("click",closeDrawer);
  document.getElementById("scrim").addEventListener("click",closeDrawer);
  document.getElementById("exportBtn").addEventListener("click",exportJSON);
  document.getElementById("importBtn").addEventListener("click",()=>document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change",importJSON);
  document.getElementById("syncBtn").addEventListener("click",openSync);
  document.getElementById("syncClose").addEventListener("click",closeSync);
  document.getElementById("syncScrim").addEventListener("click",closeSync);
  document.getElementById("copySync").addEventListener("click",copySync);
  document.getElementById("markSynced").addEventListener("click",markSynced);
  document.getElementById("pullBtn").addEventListener("click",pullCloud);
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"){closeAdd();closeDrawer();closeSync();} });
  markDirty();
}
function fillTickerList(){
  document.getElementById("tkList").innerHTML=Object.keys(SUM).sort()
    .map(t=>`<option value="${t}">${(SUM[t].name||"").replace(/"/g,"")}</option>`).join("");
}

/* ===== 实时止损：用每只持仓最新行的 final（棘轮），而非 summary.stop(候选) ===== */
async function fetchRows(file){ if(ROWS[file])return ROWS[file];
  try{ const r=await fetch(`data/stocks/${file}.json`,{cache:"no-store"}); const j=await r.json(); ROWS[file]=j.rows||[]; }catch(e){ ROWS[file]=[]; } return ROWS[file]; }
function setLiveFromRows(tk){ const s=SUM[tk]; if(!s)return; const rows=ROWS[s.file]||[];
  for(let i=rows.length-1;i>=0;i--){ if(rows[i].close!=null){ LIVE[tk]={close:rows[i].close,stop:stopOf(rows[i]),date:rows[i].date,atrpct:rows[i].atrpct}; return; } } }
async function buildLive(){
  const tks=[...new Set(POS.map(h=>h.ticker))].filter(t=>SUM[t]);
  await Promise.all(tks.map(async t=>{ await fetchRows(SUM[t].file); setLiveFromRows(t); }));
}
function liveClose(tk){ return LIVE[tk]?.close ?? (SUM[tk]?.close); }
function liveStop(tk){ return LIVE[tk]?.stop ?? (SUM[tk]?.stop); }
/* 入场锚定的移动止损：从入场日起，对每日吊灯候选 cand 取棘轮最大，seed=初始止损。
   不继承入场前的旧高点（那正是"一入场就被旧止损打掉"的 bug 根源）。 */
function holdingStopInfo(h){
  const f=SUM[h.ticker]?.file; const rows=ROWS[f]||[];
  if(!rows.length) return {stop:h.initialStop??null,prev:null,changed:false,fresh:true,delta:null};
  let ei=rows.findIndex(r=>r.date>=h.entryDate);
  // 入场日晚于最后一根数据（当晚建仓、入场日填次日）：还没有任何一天可棘轮，
  // 直接用初始止损。绝不能回退到 ei=0，那会从全历史取 cand 峰值，造成"一入场就离场"。
  if(ei<0) return {stop:h.initialStop??null,prev:null,changed:false,fresh:true,delta:null};
  let tr=(h.initialStop!=null)?h.initialStop:(rows[ei].cand??rows[ei].final??null);
  const ser=[];
  for(let k=ei;k<rows.length;k++){ const cd=rows[k].cand; if(cd!=null&&(tr==null||cd>tr)) tr=cd;
    if(tr!=null&&rows[k].close!=null) ser.push(tr); }
  if(!ser.length) return {stop:tr,prev:null,changed:false,fresh:true,delta:null};
  const stop=ser[ser.length-1], prev=ser.length>1?ser[ser.length-2]:null;
  return {stop,prev,changed:prev!=null&&(stop-prev)>1e-6,fresh:ser.length<=1,
          delta:prev!=null?stop-prev:null};
}
function holdingStop(h){ return holdingStopInfo(h).stop; }

/* ===== 单笔派生计算 ===== */
function compute(h){
  const s=SUM[h.ticker]; if(!s) return null;
  const si=holdingStopInfo(h);
  const close=num(liveClose(h.ticker)), stop=num(si.stop), r0=num(h.r0);
  const adds=h.adds||[];
  const shares=h.shares+adds.reduce((a,x)=>a+x.shares,0);
  const costTot=h.entryPrice*h.shares+adds.reduce((a,x)=>a+x.price*x.shares,0);
  const avgCost=shares>0?costTot/shares:h.entryPrice;
  const lastAdd=adds.length?adds[adds.length-1].price:h.entryPrice;
  const riskNow=(close!=null&&stop!=null)?close-stop:null;
  const milestone=(r0&&r0>0&&close!=null)?(close-lastAdd)/r0:null;
  const locked=(stop!=null&&stop>avgCost)?(stop-avgCost)*shares:0;
  const addShares=(riskNow&&riskNow>0&&locked>0)?Math.floor(locked/riskNow*ADD_FACTOR):0;
  const exitNow=(close!=null&&stop!=null&&close<stop);
  const g1=(stop!=null&&stop>=lastAdd), g2=(milestone!=null&&milestone>=MILESTONE), g3=adds.length<ADD_MAX, g4=addShares>=1;
  const canAdd=g1&&g2&&g3&&g4&&!exitNow;
  const mktVal=close!=null?shares*close:null;
  const pnl=mktVal!=null?mktVal-costTot:null;
  const pnlPct=costTot>0&&pnl!=null?pnl/costTot:null;
  const R=(r0&&r0>0&&close!=null)?(close-avgCost)/r0:null;
  const lockedIfStop=(stop!=null)?(stop-avgCost)*shares:null;
  const distPct=(close!=null&&stop!=null&&close)?(close-stop)/close:null;
  // 距止损的 ATR 倍数 = 还需要几个"典型日波幅"才会打到止损（跨波动率可比）
  const atrp=num(LIVE[h.ticker]?.atrpct ?? s.atrpct);
  const distATR=(distPct!=null&&atrp!=null&&atrp>0)?distPct/atrp:null;
  let addWhy="";
  if(!g3) addWhy=`已加满 ${ADD_MAX} 次`;
  else if(exitNow) addWhy="已触发止损，应离场而非加仓";
  else if(!g1) addWhy=`止损 ${fmt.n2(stop)} 未抬过上次加仓价 ${fmt.n2(lastAdd)}`;
  else if(!g2) addWhy=`距上次加仓仅 ${milestone==null?"—":milestone.toFixed(2)}R（需 ≥${MILESTONE}R）`;
  else if(!g4) addWhy="按风险算出的加仓股数不足 1 股";
  return {s,close,stop,shares,avgCost,r0,lastAdd,riskNow,milestone,addShares,exitNow,
    canAdd,addWhy,mktVal,pnl,pnlPct,R,lockedIfStop,distPct,distATR,addsCount:adds.length,
    stopPrev:si.prev,stopChanged:si.changed,stopFresh:si.fresh,stopDelta:si.delta};
}

/* ===== 表格 ===== */
const HEAD=["代码","入场日","均价","股数","现价","今日止损","信号","浮盈$","浮盈%","R","距止损","距止损(ATR)","若止损","加仓",""];
/* 距止损 ATR 倍数：<2 打 ⚠（与信号页各列自己告警的做法一致，不再给「持有」标签染色）
   含义是"一两天的正常波动就够碰到止损"，不是"这笔不好"——回测里 1.5~2.5 ATR 档 PF 1.76，
   高于 >=3.75 档的 1.59。阈值 2.0 是启发式，不是回测标定出来的。 */
const ATR_NEAR=2.0;
function atrDistCell(c){
  if(c.distATR==null) return "";
  const t=c.distATR.toFixed(1);
  return c.distATR<ATR_NEAR
    ? `${t}<span class="warn-flag" title="距止损只有 ${t} 个日均波动（ATR）&#10;一两天的正常波动就够碰到止损，这笔很可能很快就要做决定。&#10;不代表这笔不好，只代表它不是能放很久的仓位。">⚠</span>`
    : t;
}
/* 排序：需要动作的在上面 —— 离场（明早挂单卖出） → 可加仓（明早挂单买入） → 其余按距止损 ATR 升序
   （最可能明天被打掉的浮上来，跑得最顺的沉到底部，那些不需要你动手） */
function actionRank(c){ return c.exitNow?0:(c.canAdd?1:2); }
function sortForReview(list){
  return list.slice().sort((a,b)=>{
    const ra=actionRank(a.c), rb=actionRank(b.c);
    if(ra!==rb) return ra-rb;
    const va=a.c.distATR??a.c.distPct??Infinity, vb=b.c.distATR??b.c.distPct??Infinity;
    if(va!==vb) return va-vb;
    return a.h.ticker.localeCompare(b.h.ticker);
  });
}
function secOf(c){ return (c&&c.s&&c.s.major)||"其他"; }
function render(){
  const open=POS.map((h,i)=>({h,i,c:compute(h)})).filter(o=>o.c&&o.h.status!=="closed");
  let closed=POS.map((h,i)=>({h,i,c:compute(h)})).filter(o=>o.h.status==="closed");
  let list=open;
  if(q) list=list.filter(o=>o.h.ticker.includes(q)||(o.c.s.name||"").toUpperCase().includes(q));
  if(secFilter){ list=list.filter(o=>secOf(o.c)===secFilter); closed=closed.filter(o=>secOf(o.c)===secFilter); }
  list=sortForReview(list);
  const empty=document.getElementById("empty"), wrap=document.getElementById("tableWrap");
  if(!POS.length){ wrap.hidden=true; empty.hidden=false;
    empty.innerHTML='还没有持仓。点右上角 <b>＋ 添加持仓</b> 记录你的第一笔。'; renderTotals(open); return; }
  wrap.hidden=false; empty.hidden=true;
  document.querySelector("#grid thead").innerHTML="<tr>"+HEAD.map((t,i)=>`<th class="${i<2?"l":""}">${t}</th>`).join("")+"</tr>";
  const body=document.querySelector("#grid tbody");
  body.innerHTML=list.map(({h,i,c})=>{
    const cls=c.exitNow?"exit-row":(c.canAdd?"addable":"");
    const sig=c.exitNow?`<span class="tag exit">离场</span>`:`<span class="tag ok">持有</span>`;
    const addCell=c.canAdd?`<span class="tag ok">可加 ${c.addShares} 股</span>`:`<span class="tag no" title="${c.addWhy}">—</span>`;
    return `<tr class="${cls}" data-i="${i}">
      <td class="l"><b>${h.ticker}</b></td>
      <td class="l">${h.entryDate||""}</td>
      <td>${fmt.n2(c.avgCost)}</td>
      <td>${fmt.n1(c.shares)}</td>
      <td>${fmt.n2(c.close)}</td>
      <td class="${(c.stopChanged||c.stopFresh)?"stopcell":"stopcell-flat"}" title="${c.stopChanged?("较上一交易日抬高 "+fmt.n2(c.stopDelta)+"（"+fmt.n2(c.stopPrev)+" → "+fmt.n2(c.stop)+"）· 今晚用新值比收盘"):(c.stopFresh?"新建仓，今晚起用这个比收盘":"与上一交易日相同")}">${fmt.n2(c.stop)}${c.stopChanged?' <span style="font-size:10px">↑</span>':""}</td>
      <td>${sig}</td>
      <td>${signed(c.pnl,fmt.money)}</td>
      <td>${signed(c.pnlPct,fmt.signedPct0)}</td>
      <td>${c.R==null?"":signed(c.R,v=>v.toFixed(1)+"R")}</td>
      <td>${c.distPct==null?"":fmt.pct0(c.distPct)}</td>
      <td title="还需几个典型日波幅（ATR）才会打到止损">${atrDistCell(c)}</td>
      <td>${signed(c.lockedIfStop,fmt.money)}</td>
      <td>${addCell}</td>
      <td><button class="mini" data-open="${i}">管理</button></td>
    </tr>`;
  }).join("")+(closed.length?`<tr><td colspan="15" style="text-align:left;color:var(--faint);padding-top:16px">已平仓 ${closed.length} 笔</td></tr>`+
    closed.map(({h,i,c})=>{
      const rpnl=(h.exit&&c)?(h.exit.price-c.avgCost)*c.shares:null;
      return `<tr data-i="${i}" style="opacity:.6">
        <td class="l"><b>${h.ticker}</b></td><td class="l">${h.entryDate}→${h.exit?h.exit.date:""}</td>
        <td>${fmt.n2(c.avgCost)}</td><td>${fmt.n1(c.shares)}</td>
        <td>${h.exit?fmt.n2(h.exit.price):""}</td><td colspan="2" style="color:var(--faint)">已平仓</td>
        <td>${signed(rpnl,fmt.money)}</td><td colspan="6"></td>
        <td><button class="mini" data-open="${i}">管理</button></td></tr>`;
    }).join(""):"");
  if(!list.length) body.insertAdjacentHTML("afterbegin",
    `<tr><td colspan="15" class="l" style="color:var(--faint);padding:14px 0">没有符合当前筛选的持仓。</td></tr>`);
  body.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();openDrawer(+b.dataset.open);}));
  body.querySelectorAll("tr[data-i]").forEach(tr=>{ tr.style.cursor="pointer";
    tr.addEventListener("click",()=>openDrawer(+tr.dataset.i)); });
  renderTotals(open);
}

function renderTotals(open){
  const el=document.getElementById("totals");
  if(!open.length){ el.innerHTML=`<span class="stat">持仓 <b>0</b> 笔</span>`; return; }
  let mkt=0,cost=0,pnl=0,ifstop=0; const bySec={}, tkSec={};
  open.forEach(({h,c})=>{ if(c.mktVal!=null){mkt+=c.mktVal;cost+=h.entryPrice*h.shares+(h.adds||[]).reduce((a,x)=>a+x.price*x.shares,0);}
    if(c.pnl!=null)pnl+=c.pnl; if(c.lockedIfStop!=null)ifstop+=c.lockedIfStop;
    const m=secOf(c); bySec[m]=(bySec[m]||0)+(c.mktVal||0);
    (tkSec[m]=tkSec[m]||[]).push({t:h.ticker,v:c.mktVal||0}); });
  const ifstopPct=ACCOUNT>0?ifstop/ACCOUNT:0;
  const chips=Object.entries(bySec).sort((a,b)=>b[1]-a[1]).map(([m,v])=>{
    const p=mkt>0?v/mkt:0, act=secFilter===m;
    const tks=(tkSec[m]||[]).slice().sort((a,b)=>b.v-a.v).map(x=>x.t);
    const tip=`${m}：${tks.join(" · ")}（${tks.length} 笔 · ${fmt.money(v)}）\n${act?"再点一次显示全部":"点击只看这个板块"}`;
    return `<span class="chip ${(p>0.4&&!act)?"hot":""} ${act?"active":""}" data-sec="${m}" title="${tip}">`
      +`${m} <b>${(p*100).toFixed(0)}%</b> <span style="opacity:.6;font-size:10.5px">${tks.length}</span></span>`; }).join("");
  const nSell=open.filter(({c})=>c.exitNow).length;
  const nBuy=open.filter(({c})=>c.canAdd).length;
  el.innerHTML=`
    <span class="stat big">持仓 <b>${open.length}</b> 笔</span>
    <span class="stat">市值 <b>${fmt.money(mkt)}</b></span>
    <span class="stat">浮盈 ${signed(pnl,fmt.money)} <span style="color:var(--faint)">(${cost>0?fmt.signedPct(pnl/cost):""})</span></span>
    <span class="stat" title="假设此刻所有持仓都被各自的止损打掉，相对成本的总盈亏">若全部止损 ${signed(ifstop,fmt.money)} <span style="color:var(--faint)">(${fmt.signedPct(ifstopPct)})</span></span>
    <span class="stat sep" title="收盘已跌破止损、需次日开盘市价卖出的笔数">明早卖出 <b style="color:${nSell?"var(--bad)":"var(--faint)"}">${nSell}</b> 笔</span>
    <span class="stat" title="四道闸门全过、可在次日开盘加仓的笔数">明早加仓 <b style="color:${nBuy?"var(--enter)":"var(--faint)"}">${nBuy}</b> 笔</span>
    <span class="expo"><span style="color:var(--faint);font-size:11.5px">板块敞口</span>${chips}</span>`;
  el.querySelectorAll(".chip[data-sec]").forEach(ch=>ch.addEventListener("click",()=>{
    const s=ch.dataset.sec||"";
    secFilter=(s&&secFilter!==s)?s:"";
    render();
  }));
}

/* ===== 添加持仓 ===== */
function latestBarDate(){ let m=""; for(const t in SUM){ const d=SUM[t].date; if(d&&d>m) m=d; } return m; }
/* 入场日期默认值 = 实际成交那天。你的流程是：当晚（数据日 D）看信号 → 次日开盘市价成交，
   所以填表时的"今天"就是成交日，而不是数据最后一根K线的日期 D。
   周末填表则是在补录周五开盘的成交，回退到最新K线日期。 */
function defaultEntryDate(){
  const t=new Date(), wd=t.getDay();
  if(wd===0||wd===6) return latestBarDate();
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
}
function openAdd(){ dupPending=""; document.getElementById("addScrim").hidden=false; document.getElementById("addModal").hidden=false;
  document.getElementById("f_date").value=defaultEntryDate();
  ["f_ticker","f_price","f_stop","f_loss","f_shares"].forEach(id=>{const e=document.getElementById(id);e.value="";delete e.dataset.touched;});
  document.getElementById("f_loss").placeholder=`留空 → 按 ${RISKPCT}% (≈${fmt.money(perTradeRisk())})`;
  const bn=document.getElementById("barNote"); if(bn) bn.textContent="";
  refreshSizePreview(); }
function closeAdd(){ dupPending=""; document.getElementById("addScrim").hidden=true; document.getElementById("addModal").hidden=true; document.getElementById("addNote").textContent=""; }
function candOnOrBefore(rows,date){ let best=null; for(const r of rows){ if(r.date&&r.date<=date&&r.cand!=null) best=r; } return best; }
async function onTickerPick(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase(); const s=SUM[tk]; if(!s)return;
  // 价格取该股票"最新那根K线"的收盘价作参考，你应改成实际成交价
  const rows=await fetchRows(s.file);
  let last=null; for(let i=rows.length-1;i>=0;i--){ if(rows[i].close!=null){ last=rows[i]; break; } }
  const bar=last||{date:s.date,close:s.close};
  // 只预填价格；日期保持成交日（选股票不再把它改回K线日期）
  const pEl=document.getElementById("f_price");
  if(!pEl.value) pEl.value=fmt.n2(bar.close);
  const bn=document.getElementById("barNote");
  if(bn) bn.textContent=`最新收盘 ${fmt.n2(bar.close)} @ ${bar.date}（数据最后一个交易日）`;
  const dup=POS.filter(p=>p.ticker===tk&&p.status!=="closed");
  const nt=document.getElementById("addNote");
  if(nt) nt.innerHTML=dup.length?`<span class="warn-txt">注意：${tk} 已有 ${dup.length} 笔未平仓记录（${dup.map(p=>p.entryDate).join("、")}）。</span>`:"";
  await autofillStop();
}
async function autofillStop(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const date=document.getElementById("f_date").value; const s=SUM[tk]; if(!s||!date)return;
  const rows=await fetchRows(s.file); const row=candOnOrBefore(rows,date);
  if(row&&row.cand!=null&&!document.getElementById("f_stop").dataset.touched)
    document.getElementById("f_stop").value=fmt.n2(row.cand);
  refreshSizePreview();
}
function sizeFromInputs(){
  const price=num(document.getElementById("f_price").value);
  const stop=num(document.getElementById("f_stop").value);
  const sharesIn=num(document.getElementById("f_shares").value);
  const loss=num(document.getElementById("f_loss").value);
  if(price==null||stop==null) return {err:"need"};
  const r0=price-stop; if(r0<=0) return {err:"stop"};
  const shares=(sharesIn!=null&&sharesIn>0)?sharesIn:mround((loss!=null?loss:perTradeRisk())/r0,0.5);
  return {r0,shares,worst:shares*r0,stop};
}
function refreshSizePreview(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const box=document.getElementById("sizePreview"); box.className="addbox";
  if(!SUM[tk]){ box.textContent="输入一个有效的代码（需在信号池中）。"; return; }
  const r=sizeFromInputs();
  if(r.err==="need"){ box.textContent="填入入场价与初始止损后计算。"; return; }
  if(r.err==="stop"){ box.innerHTML=`<span class="warn-txt">初始止损必须低于入场价。</span>`; return; }
  box.className="addbox ok";
  box.innerHTML=`止损若触发 <b>${fmt.n2(r.stop)}</b>，亏 ≈ <b>${fmt.money(r.worst)}</b>（${ACCOUNT>0?fmt.pct(r.worst/ACCOUNT):""} 账户）· 买入 <b>${fmt.n1(r.shares)}</b> 股`;
}
let dupPending="";
function saveNewPosition(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const date=document.getElementById("f_date").value;
  const price=num(document.getElementById("f_price").value);
  const stop=num(document.getElementById("f_stop").value);
  const note=document.getElementById("addNote");
  if(!SUM[tk]){ note.textContent="代码无效"; return; }
  const dup=POS.filter(p=>p.ticker===tk&&p.status!=="closed");
  if(dup.length&&dupPending!==tk){ dupPending=tk;
    note.innerHTML=`<span class="warn-txt">已有 ${dup.length} 笔未平仓的 ${tk}（${dup.map(p=>`${p.entryDate} @ ${fmt.n2(p.entryPrice)}`).join("、")}）。
      加仓请用该行「管理」里的「记录加仓」。确实要新建独立的一笔，再点一次「确认」。</span>`; return; }
  if(!date||price==null||stop==null){ note.textContent="请填日期、入场价、初始止损"; return; }
  const r=sizeFromInputs();
  if(r.err==="stop"){ note.textContent="止损须低于入场价"; return; }
  if(r.shares<1){ note.textContent="股数不足 1，请提高股数或预算"; return; }
  POS.push({ticker:tk,file:SUM[tk].file,name:SUM[tk].name,major:SUM[tk].major,
    entryDate:date,entryPrice:price,initialStop:stop,r0:r.r0,shares:r.shares,adds:[],status:"open",createdAt:Date.now()});
  setLiveFromRows(tk); savePositions(); closeAdd(); render();
}

/* 加仓框里显示信号表当前状态。只是让你看见自己在追高/接回调，不做硬性拦截：
   加仓机制本身不在回测里（replay 在持仓期间跳过重复信号），而买入区间跟着 22 日高点走，
   一笔已经跑出利润的仓位收盘几乎不可能落回那个窄带，所以把 Enter 设成闸门等于取消加仓。 */
function signalNote(c){
  const s=c.s||{}, sig=s.signal||"—", cl=num(c.close), mx=num(s.maxentry), mn=num(s.minentry);
  let extra="";
  if(cl!=null&&mx!=null&&cl>mx) extra=`收盘高于买入上限 ${fmt.n2(mx)}，相当于追高 ${fmt.signedPct((cl-mx)/mx)}`;
  else if(cl!=null&&mn!=null&&cl<mn) extra=`收盘低于买入下限 ${fmt.n2(mn)}，相当于接回调 ${fmt.signedPct((cl-mn)/mn)}`;
  else if(cl!=null&&mn!=null&&mx!=null) extra=`收盘落在买入区间 ${fmt.n2(mn)}–${fmt.n2(mx)} 内`;
  if(s.mktok===false) extra=(extra?extra+"；":"")+"大盘不允许新仓";
  return `<div class="why" style="margin-top:6px;border-top:1px solid var(--line);padding-top:6px">
    信号表现在是 <b>${sig}</b>${extra?" · "+extra:""}</div>`;
}

/* ===== 止损 vs 股价 走势图（信号页同款样式） ===== */
function stopChartSVG(rows,h,c){
  const data=(rows||[]).filter(x=>x.close!=null);
  if(data.length<2) return "";
  const N=Math.min(data.length,180), d=data.slice(-N);
  // entry-anchored trailing stop (ratchet cand from entry, NOT full-window)
  let tei=rows.findIndex(r=>r.date>=h.entryDate);
  const trailMap={};
  if(tei<0){
    // 入场日晚于最后一根数据：只在最后一根上标出初始止损，不画历史止损线
    const lastRow=data[data.length-1];
    if(h.initialStop!=null&&lastRow) trailMap[lastRow.date]=h.initialStop;
  }else{
    let ttr=(h.initialStop!=null)?h.initialStop:(rows[tei]?.cand);
    for(let k=tei;k<rows.length;k++){ const cd=rows[k].cand; if(cd!=null&&(ttr==null||cd>ttr)) ttr=cd; if(ttr!=null) trailMap[rows[k].date]=ttr; }
  }
  const trailAt=p=>trailMap[p.date];
  const W=820,H=250,padL=46,padR=54,padT=12,padB=26;
  const xs=d.map((_,i)=>padL+(i/(d.length-1))*(W-padL-padR));
  const allV=[]; d.forEach(p=>{ [p.close,trailAt(p)].forEach(v=>{if(v!=null)allV.push(v);}); }); allV.push(c.avgCost);
  let lo=Math.min(...allV),hi=Math.max(...allV); const pad=(hi-lo)*0.06||1; lo-=pad;hi+=pad;
  const y=v=>padT+(1-(v-lo)/(hi-lo))*(H-padT-padB);
  const path=(fn)=>{ let s="",pen=false; d.forEach((p,i)=>{const v=fn(p); if(v==null){pen=false;return;}
    s+=(pen?" L":" M")+xs[i].toFixed(1)+" "+y(v).toFixed(1); pen=true;}); return s; };
  let grid="";
  for(let g=0;g<=4;g++){ const val=lo+(hi-lo)*g/4, yy=y(val);
    grid+=`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-padR}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`+
          `<text x="${padL-6}" y="${(yy+3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--faint)" font-family="JetBrains Mono, monospace">${val.toFixed(0)}</text>`; }
  let xticks="",lastM="";
  const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  d.forEach((p,i)=>{ const ym=p.date.slice(0,7); if(ym!==lastM){ lastM=ym; const lab=MON[(+p.date.slice(5,7))-1]+p.date.slice(2,4);
    xticks+=`<line x1="${xs[i].toFixed(1)}" y1="${padT}" x2="${xs[i].toFixed(1)}" y2="${H-padB}" stroke="var(--line)" stroke-width="1" opacity="0.6"/>`+
            `<text x="${xs[i].toFixed(1)}" y="${H-8}" text-anchor="middle" font-size="9.5" fill="var(--faint)" font-family="JetBrains Mono, monospace">${lab}</text>`; }});
  // cost line + entry marker (black, larger)
  const costLine=`<line x1="${padL}" y1="${y(c.avgCost).toFixed(1)}" x2="${W-padR}" y2="${y(c.avgCost).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 3" opacity=".55"/>`;
  let entryLine="",entryDot=""; const ei=d.findIndex(p=>p.date===h.entryDate);
  if(ei>=0){
    entryLine=`<line x1="${xs[ei].toFixed(1)}" y1="${padT}" x2="${xs[ei].toFixed(1)}" y2="${H-padB}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3"/>`;
    entryDot=`<circle cx="${xs[ei].toFixed(1)}" cy="${y(d[ei].close).toFixed(1)}" r="4.5" fill="var(--bad)"/>`;
  }
  // 加仓标记：空心环 + 序号。环画在价格线之上（addDots），竖线画在下面（addLines）
  const addList=(h.adds||[]).filter(a=>a&&a.date).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const addAt={}; let addLines="",addDots="";
  addList.forEach((a,k)=>{
    if(a.date<d[0].date) return;                       // 早于可见窗口，不画（否则会被挤到左边缘误导）
    let ai=d.findIndex(p=>p.date===a.date);
    if(ai<0) ai=d.findIndex(p=>p.date>a.date);         // 假日/非交易日 → 顺延到下一根
    if(ai<0) return;                                   // 晚于最后一根数据
    (addAt[ai]=addAt[ai]||[]).push({k:k+1,shares:a.shares,price:a.price,date:a.date});
    const X=+xs[ai].toFixed(1), Y=+y(d[ai].close).toFixed(1);
    const LY=Math.max(padT+8,Y-11);                    // 序号贴顶时不越界
    addLines+=`<line x1="${X}" y1="${padT}" x2="${X}" y2="${H-padB}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="2 4" opacity=".7"/>`;
    addDots+=`<circle cx="${X}" cy="${Y}" r="4" fill="#fff" stroke="var(--bad)" stroke-width="2"/>`+
      `<text x="${X}" y="${LY.toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--bad)" font-family="JetBrains Mono, monospace">${k+1}</text>`;
  });
  // latest values at right edge (nudge apart if overlapping)
  const lastClose=d[d.length-1].close, lastStop=trailAt(d[d.length-1]);
  const rx=W-padR+5; let ycL=y(lastClose), ysL=(lastStop!=null?y(lastStop):null);
  if(ysL!=null&&Math.abs(ycL-ysL)<12){ if(ycL<=ysL) ysL=ycL+12; else ysL=ycL-12; }
  const rlabels=`<text x="${rx}" y="${(ycL+3).toFixed(1)}" font-size="11" fill="var(--ink)" font-family="JetBrains Mono, monospace">${fmt.n2(lastClose)}</text>`+
    (lastStop!=null?`<text x="${rx}" y="${(ysL+3).toFixed(1)}" font-size="11" fill="var(--bad)" font-family="JetBrains Mono, monospace">${fmt.n2(lastStop)}</text>`:"");
  const pts=d.map((p,i)=>({x:+xs[i].toFixed(1),cy:+y(p.close).toFixed(1),date:p.date,close:p.close,trail:trailAt(p),enter:p.enter==="ENTER",add:addAt[i]||null}));
  POSCHART={pts,W,cost:c.avgCost};
  return `<div class="chart-box" id="posChartBox">
    <svg id="posChart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid}${xticks}${costLine}${entryLine}${addLines}
      <path d="${path(p=>trailAt(p))}" fill="none" stroke="var(--bad)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.9"/>
      <path d="${path(p=>p.close)}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>
      ${entryDot}${addDots}${rlabels}
      <g id="posCross" style="display:none">
        <line id="posCrossX" y1="${padT}" y2="${H-padB}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
        <circle id="posCrossDot" r="4" fill="var(--accent)" stroke="#fff" stroke-width="1.5"/>
      </g>
      <rect id="posHit" x="${padL}" y="${padT}" width="${W-padL-padR}" height="${H-padT-padB}" fill="transparent"/>
    </svg>
    <div id="posChartTip" class="chart-tip" style="display:none"></div>
    <div class="chart-legend">
      <span><i style="background:var(--accent)"></i>收盘</span>
      <span><i style="background:var(--bad);height:0;border-top:2px dashed var(--bad)"></i>移动止损(trail)</span>
      <span><i style="background:var(--muted)"></i>成本</span>
      <span><i style="width:9px;height:9px;border-radius:50%;background:var(--bad)"></i>入场</span>
      ${addList.length?`<span><i style="width:9px;height:9px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 2px var(--bad)"></i>加仓</span>`:""}
    </div>
    <p class="chart-note">止损线在往上走 = 即便被打掉，亏损也越来越小。当前若被止损：<b style="color:${c.lockedIfStop>=0?'var(--enter)':'var(--bad)'}">${fmt.money(c.lockedIfStop)}</b></p>
  </div>`;
}

let POSCHART=null;
function wirePosChart(){
  const svg=document.getElementById("posChart"); if(!svg||!POSCHART) return;
  const hit=document.getElementById("posHit"), cross=document.getElementById("posCross");
  const cx=document.getElementById("posCrossX"), dot=document.getElementById("posCrossDot");
  const tip=document.getElementById("posChartTip"), box=document.getElementById("posChartBox");
  const {pts,W,cost}=POSCHART;
  const move=(ev)=>{
    const rect=svg.getBoundingClientRect();
    const clientX=(ev.touches?ev.touches[0].clientX:ev.clientX);
    const vbX=(clientX-rect.left)/rect.width*W;
    let best=pts[0],bd=1e9; for(const p of pts){const dd=Math.abs(p.x-vbX); if(dd<bd){bd=dd;best=p;}}
    cross.style.display=""; cx.setAttribute("x1",best.x); cx.setAttribute("x2",best.x);
    dot.setAttribute("cx",best.x); dot.setAttribute("cy",best.cy);
    const row=(cl,k,v)=>v==null?"":`<div class="tr"><span class="sw" style="background:${cl}"></span>${k}<b>${fmt.n2(v)}</b></div>`;
    tip.innerHTML=`<div class="dt">${best.date}${best.enter?' · <span style="color:var(--enter)">ENTER</span>':''}</div>`+
      (best.add?best.add.map(a=>`<div class="dt" style="color:var(--bad);border:0;padding-top:0">加仓#${a.k} · ${fmt.n1(a.shares)}股 @ ${fmt.n2(a.price)}</div>`).join(""):"")+
      row('var(--accent)','收盘',best.close)+row('var(--bad)','移动止损',best.trail)+row('var(--muted)','成本',cost);
    tip.style.display="";
    const brect=box.getBoundingClientRect();
    let left=clientX-brect.left+14; if(left+170>brect.width) left=clientX-brect.left-184;
    tip.style.left=Math.max(4,left)+"px"; tip.style.top="14px";
  };
  const leave=()=>{cross.style.display="none"; tip.style.display="none";};
  hit.addEventListener("mousemove",move);
  hit.addEventListener("touchmove",move,{passive:true});
  hit.addEventListener("mouseleave",leave);
  hit.addEventListener("touchend",leave);
}

/* ===== 历史数据与逐日计算（与信号页一致） ===== */
// 突破新鲜度 = (HC55 − HC22) / ATR14 ——「真·55日新高突破」还是「只是反弹」
// HC55/HC22 由引擎直接算好(前 55/22 天最高收盘),这里直接读原值
const FRESH_WARN = 2.0;
function freshFromRow(r){
  if(!r || !r.atr14 || r.hc55==null || r.hc22==null) return null;
  return (r.hc55 - r.hc22) / r.atr14;
}
// 回撤%:按价格算的深度(新鲜度用 ATR 归一化,高波动时会被摊薄)
function ddPctRow(r){
  if(!r || !r.hc55 || r.hc22==null) return null;
  return Math.max(0, (r.hc55-r.hc22)/r.hc55);
}
function freshCell(v){
  if(v==null) return "";
  if(v<0) v=0;                       // HC55 ⊇ HC22 的窗口，负值只是浮点误差
  const txt=fmt.n1(v);
  return v>FRESH_WARN
    ? `${txt}<span class="warn-flag" title="HC22 比 HC55 低 ${txt} 个 ATR —— 非 55 日新高，只是反弹；上方仍有前高压制">⚠</span>`
    : txt;
}
// same sizing as the signals page (account × per-trade risk% ÷ R0, floored)
function sharesFor(r0){ return (r0!=null && r0>0) ? Math.floor(perTradeRisk()/r0) : null; }

const HCOLS=[
  // 基础
  ["date","日期","l",v=>v],["close","收盘","",fmt.n2],
  // 波动
  ["tr","TR","",fmt.n2],["atr14","ATR14","",fmt.n2],["atr50","ATR50","",fmt.n2],
  ["selfvol","自身波动","",fmt.pct],
  // 趋势位置
  ["ma20","MA20","",fmt.n2],["dev","偏离nR","",fmt.n1],
  ["er22","ER22","",fmt.er],["er55","ER55","",fmt.er],
  // 突破结构(HC22/HC55 相邻,新鲜度紧跟其后)
  ["hc22","HC22","",fmt.n2],["hc55","HC55","",fmt.n2],
  ["__fresh","突破新鲜度","l",(v,r)=>freshCell(freshFromRow(r))],
  ["__dd","回撤%","l",(v,r)=>{const d=ddPctRow(r);return d==null?"":fmt.pct(d);}],
  ["hi_age","距前高","l",v=>v==null?"":fmt.n0(v)],
  // 吊灯止损
  ["mult","倍数","",fmt.n1],["cand","Chand候选","",fmt.n2],["trail","Chand止损","",fmt.n2],
  // 入场区间
  ["buf","Buf","",fmt.n2],["minentry","最低买入","",fmt.n2],["maxentry","最高买入","",fmt.n2],
  // 输出
  ["mktok","大盘","",v=>v==null?"":(v?"✓":"✕")],["enter","信号","",v=>v||""],
  ["r0","R0","",fmt.n2],
  ["r0","股数","",v=>{const x=sharesFor(v);return x!=null?Math.round(x).toLocaleString("en-US"):"";}],
];
function histTable(rows){
  if(!rows||!rows.length) return "";
  const rs=rows.slice().reverse();
  const head="<tr>"+HCOLS.map(c=>`<th class="${c[2]?"l":""}">${c[1]}</th>`).join("")+"</tr>";
  const body=rs.map(r=>`<tr class="${r.enter==="ENTER"?"enter":""}">`+
    HCOLS.map(c=>`<td class="${c[2]?"l":""}">${c[3](r[c[0]], r)}</td>`).join("")+"</tr>").join("");
  return `<div class="hist-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ===== 管理抽屉 ===== */
let drawerIdx=null;
function fmtWhen(ts){ if(!ts) return "—（旧记录）"; const d=new Date(ts), p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
async function openDrawer(i){ try{ await openDrawerInner(i); }
  catch(err){
    const d=document.getElementById("detail");
    if(d) d.innerHTML=`<div class="pdetail"><h3>详情渲染出错</h3>
      <p class="psub">请把下面这段发给我，便于定位。</p>
      <pre style="white-space:pre-wrap;font-size:12px;color:var(--bad);background:var(--panel-2);padding:12px;border-radius:8px">${(err&&err.stack||err)}</pre></div>`;
    document.getElementById("scrim").hidden=false;
    const dr=document.getElementById("drawer"); dr.hidden=false; dr.setAttribute("aria-hidden","false");
    console.error("openDrawer failed:",err);
  } }
async function openDrawerInner(i){ drawerIdx=i; const h=POS[i]; const c=compute(h); if(!c)return;
  const rows=await fetchRows(h.file);
  const adds=h.adds||[];
  const addLog=adds.length?`<div class="addlog">${adds.map((a,k)=>`<div><span>加仓#${k+1} ${a.date}</span><span>${fmt.n1(a.shares)}股 @ ${fmt.n2(a.price)}</span></div>`).join("")}</div>`:"";
  const addBox=c.canAdd
    ? `<div class="addbox ok"><b>可以加仓 ✓</b> 建议买入 <b>${c.addShares}</b> 股
        <div class="why">用整仓已锁定盈利 ${fmt.money((c.stop-c.avgCost)*c.shares)} 作缓冲，按当前每股风险 ${fmt.n2(c.riskNow)} × ${ADD_FACTOR} 算出，越加越少。</div>
        ${signalNote(c)}</div>`
    : `<div class="addbox"><b>暂不加仓</b><div class="why">${c.addWhy||"—"}</div>${signalNote(c)}</div>`;
  const closed=h.status==="closed";
  const dupOther=POS.filter((p,k)=>k!==i&&p.ticker===h.ticker&&p.status!=="closed");
  const dupBox=dupOther.length?`<div class="addbox"><b class="warn-txt">疑似重复记录 ⚠</b>
      <div class="why">另有 ${dupOther.length} 笔未平仓的 ${h.ticker}：${dupOther.map(p=>`${p.entryDate} @ ${fmt.n2(p.entryPrice)} · ${fmt.n1(p.shares)}股 · 初始止损 ${fmt.n2(p.initialStop)}（录入 ${fmtWhen(p.createdAt)}）`).join("；")}。
      若是同一笔成交被录了两次，删掉多余的那条；加仓请用抽屉里的「记录加仓」。</div></div>`:"";
  document.getElementById("detail").innerHTML=`
    <div class="pdetail">
      <h3>${h.ticker} ${c.exitNow?'<span class="tag exit">离场信号</span>':''}</h3>
      <p class="psub">${c.s.name||""} · ${c.s.major||""} / ${c.s.sub||""}</p>
      ${dupBox}
      ${stopChartSVG(rows,h,c)}
      <dl class="kv">
        <dt>今日止损（收盘跌破 → 次日开盘卖出）</dt><dd class="${(c.stopChanged||c.stopFresh)?"stopcell":"stopcell-flat"}" style="font-size:15px">${fmt.n2(c.stop)}${c.stopChanged?`<span style="font-size:11px;color:var(--enter)"> ↑ +${fmt.n2(c.stopDelta)}</span>`:(c.stopFresh?'<span style="font-size:11px;color:var(--muted)"> 首次</span>':'<span style="font-size:11px;color:var(--faint)"> 未变</span>')}</dd>
        <dt>现价 / 距止损</dt><dd>${fmt.n2(c.close)} / ${c.distPct==null?"":fmt.pct(c.distPct)}${c.distATR==null?"":'<span style="color:var(--faint)"> · '+c.distATR.toFixed(1)+' ATR</span>'}</dd>
        <dt>均价成本 / 股数</dt><dd>${fmt.n2(c.avgCost)} / ${fmt.n1(c.shares)}</dd>
        <dt>初始止损 / R0</dt><dd>${fmt.n2(h.initialStop)} / ${fmt.n2(h.r0)}</dd>
        <dt>建仓日期 / 录入时间</dt><dd>${h.entryDate||"—"} <span style="color:var(--faint)">· ${fmtWhen(h.createdAt)}</span></dd>
        <dt>浮动盈亏</dt><dd>${signed(c.pnl,fmt.money2)} (${c.pnlPct==null?"":fmt.signedPct(c.pnlPct)})</dd>
        <dt>当前盈利倍数</dt><dd>${c.R==null?"":c.R.toFixed(2)+"R"}</dd>
        <dt>此刻被止损则</dt><dd>${signed(c.lockedIfStop,fmt.money)}</dd>
        <dt>加仓次数</dt><dd>${c.addsCount} / ${ADD_MAX}</dd>
      </dl>
      ${closed?`<div class="addbox">已于 ${h.exit.date} 按 ${fmt.n2(h.exit.price)} 平仓。</div>`:`
      ${addBox}${addLog}
      <div class="section-h">记录加仓</div>
      <div class="frow">
        <div class="fld">日期<input id="a_date" type="date"></div>
        <div class="fld">价格<input id="a_price" inputmode="decimal" placeholder="成交价"></div>
      </div>
      <div class="fld">股数<input id="a_shares" inputmode="decimal" placeholder="${c.canAdd?('建议 '+c.addShares):'自填股数'}"></div>
      <button class="btn-primary" id="doAdd">确认加仓</button>
      <div class="section-h">平仓</div>
      <div class="frow">
        <div class="fld">平仓日期<input id="x_date" type="date"></div>
        <div class="fld">平仓价格<input id="x_price" inputmode="decimal" placeholder="成交价"></div>
      </div>
      <button class="mini" id="doClose">标记平仓</button>
      `}
      <div class="section-h">其他</div>
      <button class="mini danger" id="doDelete">删除这笔记录</button>
      <div class="hist-head" style="margin-top:20px"><h3>历史数据与逐日计算</h3><span class="hint">与信号页一致（最近在上）</span></div>
      ${histTable(rows)}
    </div>`;
  document.getElementById("scrim").hidden=false;
  const dr=document.getElementById("drawer"); dr.hidden=false; dr.setAttribute("aria-hidden","false");
  if(!closed){ document.getElementById("doAdd").addEventListener("click",doAdd); document.getElementById("doClose").addEventListener("click",doClose); }
  document.getElementById("doDelete").addEventListener("click",doDelete);
  wirePosChart();
}
function closeDrawer(){ const dr=document.getElementById("drawer"); dr.hidden=true; dr.setAttribute("aria-hidden","true"); document.getElementById("scrim").hidden=true; drawerIdx=null; }
function doAdd(){ const h=POS[drawerIdx];
  const date=document.getElementById("a_date").value, price=num(document.getElementById("a_price").value), sh=num(document.getElementById("a_shares").value);
  if(!date||price==null||!sh||sh<1)return;
  (h.adds=h.adds||[]).push({date,price,shares:sh}); savePositions(); openDrawer(drawerIdx); render(); }
function doClose(){ const h=POS[drawerIdx];
  const date=document.getElementById("x_date").value, price=num(document.getElementById("x_price").value);
  if(!date||price==null)return;
  h.status="closed"; h.exit={date,price}; savePositions(); openDrawer(drawerIdx); render(); }
function doDelete(){ if(!confirm("删除这笔持仓记录？无法撤销。"))return; POS.splice(drawerIdx,1); savePositions(); closeDrawer(); render(); }

/* ===== 同步（仓库 positions.json，跨设备） ===== */
function ghPositionsUrl(){
  const h=location.hostname, parts=location.pathname.split("/").filter(Boolean);
  if(!h.endsWith("github.io")) return null;
  const owner=h.split(".")[0], repo=parts[0];
  return CLOUD_EXISTS
    ? `https://github.com/${owner}/${repo}/edit/main/docs/positions.json`
    : `https://github.com/${owner}/${repo}/new/main/docs?filename=positions.json`;
}
function openSync(){
  document.getElementById("syncOut").value=JSON.stringify(POS,null,2);
  const link=document.getElementById("syncLink"), hint=document.getElementById("syncHint");
  const url=ghPositionsUrl();
  if(url){ link.href=url; link.style.display=""; hint.textContent=CLOUD_EXISTS?"提交后，其他设备打开本页会自动读到最新持仓。":"首次会让你新建 docs/positions.json，把内容粘进去提交即可。"; }
  else{ link.style.display="none"; hint.textContent="非 GitHub Pages 环境：手动把内容存成 docs/positions.json 并提交。"; }
  document.getElementById("syncScrim").hidden=false; document.getElementById("syncModal").hidden=false;
}
function closeSync(){ document.getElementById("syncScrim").hidden=true; document.getElementById("syncModal").hidden=true; }
function markSynced(){ DIRTY=false; CLOUD_EXISTS=true; saveLocal(); markDirty();
  document.getElementById("syncHint").textContent="已标记为同步（棕色提醒已清除）。"; }
function copySync(){ const t=document.getElementById("syncOut"); t.select(); document.execCommand&&document.execCommand("copy");
  navigator.clipboard&&navigator.clipboard.writeText(t.value); document.getElementById("syncHint").textContent="已复制。到 GitHub 把它存为 docs/positions.json 并提交。"; }
async function pullCloud(){
  try{ const r=await fetch("positions.json",{cache:"no-store"}); if(!r.ok){alert("还没有 positions.json，请先同步一次。");return;}
    const j=await r.json(); if(!Array.isArray(j)){alert("positions.json 格式不对");return;}
    if(DIRTY&&!confirm("本机有未同步改动，确定用云端覆盖？"))return;
    POS=j; DIRTY=false; CLOUD_EXISTS=true; saveLocal(); markDirty(); await buildLive(); render();
  }catch(e){ alert("拉取失败"); }
}

/* ===== 导出 / 导入（本地文件备份） ===== */
function exportJSON(){ const blob=new Blob([JSON.stringify(POS,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`positions_${(DATA.generated_at||"").slice(0,10)||"backup"}.json`; a.click(); URL.revokeObjectURL(a.href); }
function importJSON(e){ const f=e.target.files[0]; if(!f)return; const r=new FileReader();
  r.onload=async()=>{ try{ const arr=JSON.parse(r.result); if(Array.isArray(arr)&&confirm(`导入 ${arr.length} 笔持仓，覆盖当前 ${POS.length} 笔？`)){ POS=arr; savePositions(); await buildLive(); render(); } }catch(err){ alert("文件格式不对"); } };
  r.readAsText(f); e.target.value=""; }

load();
