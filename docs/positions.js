/* 持仓管理 — 与信号引擎同源、同收盘价口径、同 ATR 自适应止损
   初始止损 = 入场当日吊灯候选 cand（定 R0）
   今日止损 = 每只票最新行的 final/trail（棘轮、只升不降，去券商挂这个）
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
};
const num=v=>(v==null||v==="")?null:Number(v);
function signed(v,f){ if(v==null)return ""; const c=v>=0?"pos":"neg"; return `<span class="${c}">${f(v)}</span>`; }

let DATA=null, SUM={}, ROWS={}, LIVE={}, POS=[], ACCOUNT=20000, RISKPCT=1.0, q="";
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
  acct.addEventListener("input",()=>{ const v=Number(acct.value.replace(/[^0-9.]/g,"")); if(v>0){ACCOUNT=v;localStorage.setItem("acctUsd",v);render();} });
  rp.addEventListener("input",()=>{ const v=Number(rp.value); if(v>0){RISKPCT=v;localStorage.setItem("riskPct",v);render();} });
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
  for(let i=rows.length-1;i>=0;i--){ if(rows[i].close!=null){ LIVE[tk]={close:rows[i].close,stop:stopOf(rows[i]),date:rows[i].date}; return; } } }
async function buildLive(){
  const tks=[...new Set(POS.map(h=>h.ticker))].filter(t=>SUM[t]);
  await Promise.all(tks.map(async t=>{ await fetchRows(SUM[t].file); setLiveFromRows(t); }));
}
function liveClose(tk){ return LIVE[tk]?.close ?? (SUM[tk]?.close); }
function liveStop(tk){ return LIVE[tk]?.stop ?? (SUM[tk]?.stop); }

/* ===== 单笔派生计算 ===== */
function compute(h){
  const s=SUM[h.ticker]; if(!s) return null;
  const close=num(liveClose(h.ticker)), stop=num(liveStop(h.ticker)), r0=num(h.r0);
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
  let addWhy="";
  if(!g3) addWhy=`已加满 ${ADD_MAX} 次`;
  else if(exitNow) addWhy="已触发止损，应离场而非加仓";
  else if(!g1) addWhy=`止损 ${fmt.n2(stop)} 未抬过上次加仓价 ${fmt.n2(lastAdd)}`;
  else if(!g2) addWhy=`距上次加仓仅 ${milestone==null?"—":milestone.toFixed(2)}R（需 ≥${MILESTONE}R）`;
  else if(!g4) addWhy="按风险算出的加仓股数不足 1 股";
  return {s,close,stop,shares,avgCost,r0,lastAdd,riskNow,milestone,addShares,exitNow,
    canAdd,addWhy,mktVal,pnl,pnlPct,R,lockedIfStop,distPct,addsCount:adds.length};
}

/* ===== 表格 ===== */
const HEAD=["代码","入场日","均价","股数","现价","今日止损","信号","浮盈$","浮盈%","R","距止损","若止损","加仓",""];
function render(){
  const open=POS.map((h,i)=>({h,i,c:compute(h)})).filter(o=>o.c&&o.h.status!=="closed");
  const closed=POS.map((h,i)=>({h,i,c:compute(h)})).filter(o=>o.h.status==="closed");
  let list=open;
  if(q) list=list.filter(o=>o.h.ticker.includes(q)||(o.c.s.name||"").toUpperCase().includes(q));
  const empty=document.getElementById("empty"), wrap=document.getElementById("tableWrap");
  if(!POS.length){ wrap.hidden=true; empty.hidden=false;
    empty.innerHTML='还没有持仓。点右上角 <b>＋ 添加持仓</b> 记录你的第一笔。'; renderTotals(open); return; }
  wrap.hidden=false; empty.hidden=true;
  document.querySelector("#grid thead").innerHTML="<tr>"+HEAD.map((t,i)=>`<th class="${i<2?"l":""}">${t}</th>`).join("")+"</tr>";
  const body=document.querySelector("#grid tbody");
  body.innerHTML=list.map(({h,i,c})=>{
    const cls=c.exitNow?"exit-row":(c.canAdd?"addable":"");
    const sig=c.exitNow?`<span class="tag exit">离场</span>`:`<span class="tag ${c.distPct!=null&&c.distPct<0.05?"no":"ok"}">持有</span>`;
    const addCell=c.canAdd?`<span class="tag ok">可加 ${c.addShares} 股</span>`:`<span class="tag no" title="${c.addWhy}">—</span>`;
    return `<tr class="${cls}" data-i="${i}">
      <td class="l"><b>${h.ticker}</b></td>
      <td class="l">${h.entryDate||""}</td>
      <td>${fmt.n2(c.avgCost)}</td>
      <td>${fmt.n1(c.shares)}</td>
      <td>${fmt.n2(c.close)}</td>
      <td class="stopcell">${fmt.n2(c.stop)}</td>
      <td>${sig}</td>
      <td>${signed(c.pnl,fmt.money)}</td>
      <td>${signed(c.pnlPct,fmt.signedPct)}</td>
      <td>${c.R==null?"":signed(c.R,v=>v.toFixed(2)+"R")}</td>
      <td>${c.distPct==null?"":fmt.pct(c.distPct)}</td>
      <td>${signed(c.lockedIfStop,fmt.money)}</td>
      <td>${addCell}</td>
      <td><button class="mini" data-open="${i}">管理</button></td>
    </tr>`;
  }).join("")+(closed.length?`<tr><td colspan="14" style="text-align:left;color:var(--faint);padding-top:16px">已平仓 ${closed.length} 笔</td></tr>`+
    closed.map(({h,i,c})=>{
      const rpnl=(h.exit&&c)?(h.exit.price-c.avgCost)*c.shares:null;
      return `<tr data-i="${i}" style="opacity:.6">
        <td class="l"><b>${h.ticker}</b></td><td class="l">${h.entryDate}→${h.exit?h.exit.date:""}</td>
        <td>${fmt.n2(c.avgCost)}</td><td>${fmt.n1(c.shares)}</td>
        <td>${h.exit?fmt.n2(h.exit.price):""}</td><td colspan="2" style="color:var(--faint)">已平仓</td>
        <td>${signed(rpnl,fmt.money)}</td><td colspan="5"></td>
        <td><button class="mini" data-open="${i}">管理</button></td></tr>`;
    }).join(""):"");
  body.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();openDrawer(+b.dataset.open);}));
  body.querySelectorAll("tr[data-i]").forEach(tr=>tr.addEventListener("click",()=>openDrawer(+tr.dataset.i)));
  renderTotals(open);
}

function renderTotals(open){
  const el=document.getElementById("totals");
  if(!open.length){ el.innerHTML=`<span class="stat">持仓 <b>0</b> 笔</span>`; return; }
  let mkt=0,cost=0,pnl=0,ifstop=0; const bySec={};
  open.forEach(({h,c})=>{ if(c.mktVal!=null){mkt+=c.mktVal;cost+=h.entryPrice*h.shares+(h.adds||[]).reduce((a,x)=>a+x.price*x.shares,0);}
    if(c.pnl!=null)pnl+=c.pnl; if(c.lockedIfStop!=null)ifstop+=c.lockedIfStop;
    const m=c.s.major||"其他"; bySec[m]=(bySec[m]||0)+(c.mktVal||0); });
  const ifstopPct=ACCOUNT>0?ifstop/ACCOUNT:0;
  const chips=Object.entries(bySec).sort((a,b)=>b[1]-a[1]).map(([m,v])=>{
    const p=mkt>0?v/mkt:0; return `<span class="chip ${p>0.4?"hot":""}">${m} <b>${(p*100).toFixed(0)}%</b></span>`; }).join("");
  el.innerHTML=`
    <span class="stat big">持仓 <b>${open.length}</b> 笔</span>
    <span class="stat">市值 <b>${fmt.money(mkt)}</b></span>
    <span class="stat">浮盈 ${signed(pnl,fmt.money)} <span style="color:var(--faint)">(${cost>0?fmt.signedPct(pnl/cost):""})</span></span>
    <span class="stat" title="假设此刻所有持仓都被各自的止损打掉，相对成本的总盈亏">若全部止损 ${signed(ifstop,fmt.money)} <span style="color:var(--faint)">(${fmt.signedPct(ifstopPct)})</span></span>
    <span class="expo"><span style="color:var(--faint);font-size:11.5px">板块敞口</span>${chips}</span>`;
}

/* ===== 添加持仓 ===== */
function openAdd(){ document.getElementById("addScrim").hidden=false; document.getElementById("addModal").hidden=false;
  document.getElementById("f_date").value=DATA.generated_at?DATA.generated_at.slice(0,10):"";
  ["f_ticker","f_price","f_stop","f_loss","f_shares"].forEach(id=>{const e=document.getElementById(id);e.value="";delete e.dataset.touched;});
  document.getElementById("f_loss").placeholder=`留空 → 按 ${RISKPCT}% (≈${fmt.money(perTradeRisk())})`;
  refreshSizePreview(); }
function closeAdd(){ document.getElementById("addScrim").hidden=true; document.getElementById("addModal").hidden=true; document.getElementById("addNote").textContent=""; }
function candOnOrBefore(rows,date){ let best=null; for(const r of rows){ if(r.date&&r.date<=date&&r.cand!=null) best=r; } return best; }
async function onTickerPick(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase(); const s=SUM[tk]; if(!s)return;
  if(!document.getElementById("f_price").value) document.getElementById("f_price").value=fmt.n2(s.close);
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
function saveNewPosition(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const date=document.getElementById("f_date").value;
  const price=num(document.getElementById("f_price").value);
  const stop=num(document.getElementById("f_stop").value);
  const note=document.getElementById("addNote");
  if(!SUM[tk]){ note.textContent="代码无效"; return; }
  if(!date||price==null||stop==null){ note.textContent="请填日期、入场价、初始止损"; return; }
  const r=sizeFromInputs();
  if(r.err==="stop"){ note.textContent="止损须低于入场价"; return; }
  if(r.shares<1){ note.textContent="股数不足 1，请提高股数或预算"; return; }
  POS.push({ticker:tk,file:SUM[tk].file,name:SUM[tk].name,major:SUM[tk].major,
    entryDate:date,entryPrice:price,initialStop:stop,r0:r.r0,shares:r.shares,adds:[],status:"open",createdAt:Date.now()});
  setLiveFromRows(tk); savePositions(); closeAdd(); render();
}

/* ===== 止损 vs 股价 走势图（信号页同款样式） ===== */
function stopChartSVG(rows,h,c){
  const data=(rows||[]).filter(x=>x.close!=null);
  if(data.length<2) return "";
  const N=Math.min(data.length,180), d=data.slice(-N);
  const W=820,H=250,padL=46,padR=54,padT=12,padB=26;
  const xs=d.map((_,i)=>padL+(i/(d.length-1))*(W-padL-padR));
  const allV=[]; d.forEach(p=>{ [p.close,stopOf(p)].forEach(v=>{if(v!=null)allV.push(v);}); }); allV.push(c.avgCost);
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
  let entryMark=""; const ei=d.findIndex(p=>p.date===h.entryDate);
  if(ei>=0) entryMark=`<line x1="${xs[ei].toFixed(1)}" y1="${padT}" x2="${xs[ei].toFixed(1)}" y2="${H-padB}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3"/>`+
    `<circle cx="${xs[ei].toFixed(1)}" cy="${y(d[ei].close).toFixed(1)}" r="4.5" fill="var(--ink)" stroke="#fff" stroke-width="1.6"/>`;
  // latest values at right edge (nudge apart if overlapping)
  const lastClose=d[d.length-1].close, lastStop=stopOf(d[d.length-1]);
  const rx=W-padR+5; let ycL=y(lastClose), ysL=(lastStop!=null?y(lastStop):null);
  if(ysL!=null&&Math.abs(ycL-ysL)<12){ if(ycL<=ysL) ysL=ycL+12; else ysL=ycL-12; }
  const rlabels=`<text x="${rx}" y="${(ycL+3).toFixed(1)}" font-size="11" fill="var(--ink)" font-family="JetBrains Mono, monospace">${fmt.n2(lastClose)}</text>`+
    (lastStop!=null?`<text x="${rx}" y="${(ysL+3).toFixed(1)}" font-size="11" fill="var(--bad)" font-family="JetBrains Mono, monospace">${fmt.n2(lastStop)}</text>`:"");
  const pts=d.map((p,i)=>({x:+xs[i].toFixed(1),cy:+y(p.close).toFixed(1),date:p.date,close:p.close,trail:stopOf(p),enter:p.enter==="ENTER"}));
  POSCHART={pts,W,cost:c.avgCost};
  return `<div class="chart-box" id="posChartBox">
    <svg id="posChart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid}${xticks}${costLine}${entryMark}
      <path d="${path(p=>stopOf(p))}" fill="none" stroke="var(--bad)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.9"/>
      <path d="${path(p=>p.close)}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>
      ${rlabels}
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
      <span><i style="background:var(--ink)"></i>入场</span>
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
function histTable(rows){
  if(!rows||!rows.length) return "";
  const rs=rows.slice().reverse();
  const head="<tr>"+HCOLS.map(c=>`<th class="${c[2]?"l":""}">${c[1]}</th>`).join("")+"</tr>";
  const body=rs.map(r=>`<tr class="${r.enter==="ENTER"?"enter":""}">`+
    HCOLS.map(c=>`<td class="${c[2]?"l":""}">${c[3](r[c[0]])}</td>`).join("")+"</tr>").join("");
  return `<div class="hist-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ===== 管理抽屉 ===== */
let drawerIdx=null;
async function openDrawer(i){ drawerIdx=i; const h=POS[i]; const c=compute(h); if(!c)return;
  const rows=await fetchRows(h.file);
  const adds=h.adds||[];
  const addLog=adds.length?`<div class="addlog">${adds.map((a,k)=>`<div><span>加仓#${k+1} ${a.date}</span><span>${fmt.n1(a.shares)}股 @ ${fmt.n2(a.price)}</span></div>`).join("")}</div>`:"";
  const addBox=c.canAdd
    ? `<div class="addbox ok"><b>可以加仓 ✓</b> 建议买入 <b>${c.addShares}</b> 股
        <div class="why">用整仓已锁定盈利 ${fmt.money((c.stop-c.avgCost)*c.shares)} 作缓冲，按当前每股风险 ${fmt.n2(c.riskNow)} × ${ADD_FACTOR} 算出，越加越少。</div></div>`
    : `<div class="addbox"><b>暂不加仓</b><div class="why">${c.addWhy||"—"}</div></div>`;
  const closed=h.status==="closed";
  document.getElementById("detail").innerHTML=`
    <div class="pdetail">
      <h3>${h.ticker} ${c.exitNow?'<span class="tag exit">离场信号</span>':''}</h3>
      <p class="psub">${c.s.name||""} · ${c.s.major||""} / ${c.s.sub||""}</p>
      ${stopChartSVG(rows,h,c)}
      <dl class="kv">
        <dt>今日止损（去券商改这个）</dt><dd class="stopcell" style="font-size:15px">${fmt.n2(c.stop)}</dd>
        <dt>现价 / 距止损</dt><dd>${fmt.n2(c.close)} / ${c.distPct==null?"":fmt.pct(c.distPct)}</dd>
        <dt>均价成本 / 股数</dt><dd>${fmt.n2(c.avgCost)} / ${fmt.n1(c.shares)}</dd>
        <dt>初始止损 / R0</dt><dd>${fmt.n2(h.initialStop)} / ${fmt.n2(h.r0)}</dd>
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
