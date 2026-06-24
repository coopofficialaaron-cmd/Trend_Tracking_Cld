/* 持仓管理 — 与信号引擎同源、同收盘价口径、同 ATR 自适应止损
   数据：data/index.json (summary) + data/stocks/{file}.json (rows, 仅添加时取入场日初始止损)
   持仓存于 localStorage，可导出/导入 JSON 备份。 */

"use strict";

/* ---- 可调参数（与回测结论一致） ---- */
const ADD_MAX     = 3;     // 最多加仓次数
const MILESTONE   = 1.5;   // 距上次加仓价需达到的 R 里程碑才允许再加
const ADD_FACTOR  = 0.8;   // 加仓股数 = 锁定盈亏/当前每股风险 × 该系数（递减金字塔）
const POS_KEY     = "tt_positions_v1";

/* ---- 格式 ---- */
const fmt = {
  n1:v=>v==null||v===""?"":(+v).toLocaleString("en-US",{maximumFractionDigits:1}),
  n2:v=>v==null||v===""?"":(+v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),
  money:v=>v==null?"":(v<0?"-$":"$")+Math.abs(v).toLocaleString("en-US",{maximumFractionDigits:0}),
  money2:v=>v==null?"":(v<0?"-$":"$")+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),
  pct:v=>v==null||v===""?"":(v*100).toFixed(1)+"%",
  signedPct:v=>v==null?"":(v>=0?"+":"")+(v*100).toFixed(1)+"%",
};
const num=v=>(v==null||v==="")?null:Number(v);
function signed(v,f){ if(v==null)return ""; const c=v>=0?"pos":"neg"; return `<span class="${c}">${f(v)}</span>`; }

/* ---- 状态 ---- */
let DATA=null, SUM={}, ROWS={}, POS=[], ACCOUNT=20000, RISKPCT=1.0, q="";

/* ---- 仓位计算（与主 app 同口径） ---- */
const mround=(x,m)=>Math.round(x/m)*m;
const perTradeRisk=()=>ACCOUNT*RISKPCT/100;
const suggestShares=r0=>(r0!=null&&r0>0)?mround(perTradeRisk()/r0,0.5):null;

/* ---- 启动 ---- */
async function load(){
  try{
    const r=await fetch("data/index.json",{cache:"no-store"});
    DATA=await r.json();
  }catch(e){
    document.getElementById("empty").hidden=false;
    document.getElementById("empty").innerHTML="无法加载 <code>data/index.json</code>。请确认信号引擎已生成数据（运行 GitHub Action 或 <code>python engine/build.py</code>）。";
    return;
  }
  (DATA.stocks||[]).forEach(s=>{ if(s.summary&&s.summary.date) SUM[s.ticker]={...s.summary,name:s.name,file:s.file,major:s.major,sub:s.sub}; });
  ACCOUNT=Number(localStorage.getItem("acctUsd"))||20000;
  RISKPCT=Number(localStorage.getItem("riskPct"))||1.0;
  loadPositions();
  initControls();
  renderMeta(); renderMarket();
  fillTickerList();
  render();
}
function loadPositions(){ try{ POS=JSON.parse(localStorage.getItem(POS_KEY))||[]; }catch(e){ POS=[]; } }
function savePositions(){ localStorage.setItem(POS_KEY,JSON.stringify(POS)); }

/* ---- 顶栏 meta / market ---- */
function renderMeta(){
  document.getElementById("updated").textContent=DATA.generated_at?("更新 "+DATA.generated_at.replace("T"," ").slice(0,16)):"—";
  document.getElementById("source").textContent=DATA.source?("源 "+DATA.source):"";
  const mk=DATA.market;
  const ok = (typeof mk==="object"&&mk)?(mk.ok??mk.bull??true):!!mk;
  const f=document.getElementById("freshness");
  f.className="freshness "+(ok?"ok":"stale");
  f.innerHTML=`<span class="dot"></span>${ok?"大盘 OK · 可建仓":"大盘弱 · 暂停新仓"}`;
}
function renderMarket(){ /* 简版：复用信号页查看完整 ETF 状态 */ }

/* ---- 控件 ---- */
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
  ["f_ticker","f_date","f_price","f_stop","f_loss"].forEach(id=>
    document.getElementById(id).addEventListener("input",refreshSizePreview));
  document.getElementById("f_ticker").addEventListener("change",onTickerPick);
  document.getElementById("drawerClose").addEventListener("click",closeDrawer);
  document.getElementById("scrim").addEventListener("click",closeDrawer);
  document.getElementById("exportBtn").addEventListener("click",exportJSON);
  document.getElementById("importBtn").addEventListener("click",()=>document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change",importJSON);
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"){closeAdd();closeDrawer();} });
}
function fillTickerList(){
  document.getElementById("tkList").innerHTML=Object.keys(SUM).sort()
    .map(t=>`<option value="${t}">${(SUM[t].name||"").replace(/"/g,"")}</option>`).join("");
}

/* ===== 单笔持仓的派生计算（用引擎实时 summary） ===== */
function compute(h){
  const s=SUM[h.ticker]; if(!s) return null;
  const close=num(s.close), stop=num(s.stop), r0=num(h.r0);
  const adds=h.adds||[];
  const shares=h.shares+adds.reduce((a,x)=>a+x.shares,0);
  const costTot=h.entryPrice*h.shares+adds.reduce((a,x)=>a+x.price*x.shares,0);
  const avgCost=shares>0?costTot/shares:h.entryPrice;
  const lastAdd=adds.length?adds[adds.length-1].price:h.entryPrice;
  const riskNow=(close!=null&&stop!=null)?close-stop:null;      // 当前每股风险
  const milestone=(r0&&r0>0&&close!=null)?(close-lastAdd)/r0:null;
  const locked=(stop!=null&&stop>avgCost)?(stop-avgCost)*shares:0; // 整仓已锁定盈利
  const addShares=(riskNow&&riskNow>0&&locked>0)?Math.floor(locked/riskNow*ADD_FACTOR):0;
  const exitNow=(close!=null&&stop!=null&&close<stop);
  const g1=(stop!=null&&stop>=lastAdd);          // 止损已抬过上次加仓价（上一笔无风险）
  const g2=(milestone!=null&&milestone>=MILESTONE);
  const g3=adds.length<ADD_MAX;
  const g4=addShares>=1;
  const canAdd=g1&&g2&&g3&&g4&&!exitNow;
  const mktVal=close!=null?shares*close:null;
  const pnl=mktVal!=null?mktVal-costTot:null;
  const pnlPct=costTot>0&&pnl!=null?pnl/costTot:null;
  const R=(r0&&r0>0&&close!=null)?(close-avgCost)/r0:null;
  const openRisk=(close!=null&&stop!=null)?shares*Math.max(0,close-stop):null; // 到现止损还会亏多少
  const lockedIfStop=(stop!=null)?(stop-avgCost)*shares:null;                  // 此刻被打止损的盈亏
  const distPct=(close!=null&&stop!=null&&close)?(close-stop)/close:null;
  let addWhy="";
  if(!g3) addWhy=`已加满 ${ADD_MAX} 次`;
  else if(exitNow) addWhy="已触发止损，应离场而非加仓";
  else if(!g1) addWhy=`止损 ${fmt.n2(stop)} 未抬过上次加仓价 ${fmt.n2(lastAdd)}`;
  else if(!g2) addWhy=`距上次加仓仅 ${milestone==null?"—":milestone.toFixed(2)}R（需 ≥${MILESTONE}R）`;
  else if(!g4) addWhy="按风险算出的加仓股数不足 1 股";
  return {s,close,stop,shares,avgCost,r0,lastAdd,riskNow,milestone,addShares,exitNow,
    canAdd,addWhy,mktVal,pnl,pnlPct,R,openRisk,lockedIfStop,distPct,addsCount:adds.length};
}

/* ===== 表格 ===== */
const HEAD=["代码","入场日","均价","股数","现价","今日止损","信号","浮盈$","浮盈%","R","距止损","加仓",""];
function render(){
  const open=POS.map((h,i)=>({h,i,c:compute(h)})).filter(o=>o.c&&o.h.status!=="closed");
  const closed=POS.map((h,i)=>({h,i,c:compute(h)})).filter(o=>o.h.status==="closed");
  let list=open;
  if(q) list=list.filter(o=>o.h.ticker.includes(q)||(o.c.s.name||"").toUpperCase().includes(q));

  const empty=document.getElementById("empty"), wrap=document.getElementById("tableWrap");
  if(!POS.length){ wrap.hidden=true; empty.hidden=false;
    empty.innerHTML='还没有持仓。点右上角 <b>＋ 添加持仓</b> 记录你的第一笔，系统会算出每天该挂的止损价与加仓时机。'; renderTotals(open); return; }
  wrap.hidden=false; empty.hidden=true;

  const thead=document.querySelector("#grid thead");
  thead.innerHTML="<tr>"+HEAD.map((t,i)=>`<th class="${i<2?"l":""}">${t}</th>`).join("")+"</tr>";
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
      <td>${addCell}</td>
      <td><button class="mini" data-open="${i}">管理</button></td>
    </tr>`;
  }).join("")+(closed.length?`<tr><td colspan="13" style="text-align:left;color:var(--faint);padding-top:16px">已平仓 ${closed.length} 笔</td></tr>`+
    closed.map(({h,i,c})=>{
      const rpnl=(h.exit&&c)? (h.exit.price-c.avgCost)*c.shares : null;
      return `<tr data-i="${i}" style="opacity:.6">
        <td class="l"><b>${h.ticker}</b></td><td class="l">${h.entryDate}→${h.exit?h.exit.date:""}</td>
        <td>${fmt.n2(c.avgCost)}</td><td>${fmt.n1(c.shares)}</td>
        <td>${h.exit?fmt.n2(h.exit.price):""}</td><td colspan="2" style="color:var(--faint)">已平仓</td>
        <td>${signed(rpnl,fmt.money)}</td><td colspan="4"></td>
        <td><button class="mini" data-open="${i}">管理</button></td></tr>`;
    }).join(""):"");

  body.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();openDrawer(+b.dataset.open);}));
  body.querySelectorAll("tr[data-i]").forEach(tr=>tr.addEventListener("click",()=>openDrawer(+tr.dataset.i)));
  renderTotals(open);
}

function renderTotals(open){
  const el=document.getElementById("totals");
  if(!open.length){ el.innerHTML=`<span class="stat">持仓 <b>0</b> 笔</span>`; return; }
  let mkt=0,cost=0,pnl=0,risk=0; const bySec={};
  open.forEach(({h,c})=>{ if(c.mktVal!=null){mkt+=c.mktVal;cost+=h.entryPrice*h.shares+(h.adds||[]).reduce((a,x)=>a+x.price*x.shares,0);}
    if(c.pnl!=null)pnl+=c.pnl; if(c.openRisk!=null)risk+=c.openRisk;
    const m=c.s.major||"其他"; bySec[m]=(bySec[m]||0)+(c.mktVal||0); });
  const riskPct=ACCOUNT>0?risk/ACCOUNT:0;
  const rb=riskPct>0.12?"over":(riskPct>0.08?"warn":"");
  const chips=Object.entries(bySec).sort((a,b)=>b[1]-a[1]).map(([m,v])=>{
    const p=mkt>0?v/mkt:0; return `<span class="chip ${p>0.4?"hot":""}">${m} <b>${(p*100).toFixed(0)}%</b></span>`; }).join("");
  el.innerHTML=`
    <span class="stat big">持仓 <b>${open.length}</b> 笔</span>
    <span class="stat">市值 <b>${fmt.money(mkt)}</b></span>
    <span class="stat">浮盈 ${signed(pnl,fmt.money)} <span style="color:var(--faint)">(${cost>0?fmt.signedPct(pnl/cost):""})</span></span>
    <span class="stat">组合在险 <b>${fmt.signedPct(riskPct).replace("+","")}</b>
      <span class="riskbar"><i class="${rb}" style="width:${Math.min(100,riskPct/0.15*100)}%"></i></span></span>
    <span class="expo"><span style="color:var(--faint);font-size:11.5px">板块敞口</span>${chips}</span>`;
}

/* ===== 添加持仓 ===== */
function openAdd(){ document.getElementById("addScrim").hidden=false; document.getElementById("addModal").hidden=false;
  document.getElementById("f_date").value=DATA.generated_at?DATA.generated_at.slice(0,10):"";
  ["f_ticker","f_price","f_stop","f_loss"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("f_loss").placeholder=`留空=按 ${RISKPCT}% (≈${fmt.money(perTradeRisk())})`;
  refreshSizePreview(); }
function closeAdd(){ document.getElementById("addScrim").hidden=true; document.getElementById("addModal").hidden=true; document.getElementById("addNote").textContent=""; }

async function fetchRows(file){ if(ROWS[file])return ROWS[file];
  try{ const r=await fetch(`data/stocks/${file}.json`,{cache:"no-store"}); const j=await r.json(); ROWS[file]=j.rows||[]; }catch(e){ ROWS[file]=[]; } return ROWS[file]; }
function rowOnOrBefore(rows,date){ let best=null; for(const r of rows){ if(r.date&&r.date<=date&&(r.final!=null||r.cand!=null)) best=r; } return best; }

async function onTickerPick(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const s=SUM[tk]; if(!s)return;
  document.getElementById("f_price").value=document.getElementById("f_price").value||fmt.n2(s.close);
  await autofillStop();
}
async function autofillStop(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const date=document.getElementById("f_date").value; const s=SUM[tk];
  if(!s||!date)return;
  const rows=await fetchRows(s.file);
  const row=rowOnOrBefore(rows,date);
  const stop=row?(row.final??row.cand):null;
  if(stop!=null&&!document.getElementById("f_stop").dataset.touched)
    document.getElementById("f_stop").value=fmt.n2(stop);
  refreshSizePreview();
}
document.addEventListener("input",e=>{ if(e.target&&e.target.id==="f_stop")e.target.dataset.touched="1"; if(e.target&&e.target.id==="f_date")autofillStop(); });

function refreshSizePreview(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const price=num(document.getElementById("f_price").value);
  const stop=num(document.getElementById("f_stop").value);
  const loss=num(document.getElementById("f_loss").value);
  const box=document.getElementById("sizePreview"); box.className="addbox";
  if(!SUM[tk]){ box.textContent="输入一个有效的代码（需在信号池中）。"; return; }
  if(price==null||stop==null){ box.textContent="填入入场价与初始止损后计算 R0 与股数。"; return; }
  const r0=price-stop;
  if(r0<=0){ box.className="addbox"; box.innerHTML=`<span class="warn-txt">初始止损 ${fmt.n2(stop)} 必须低于入场价 ${fmt.n2(price)}。</span>`; return; }
  const budget=loss!=null?loss:perTradeRisk();
  const shares=mround(budget/r0,0.5);
  const cap=shares*price, worst=shares*r0;
  box.className="addbox ok";
  box.innerHTML=`R0(每股风险) <b>${fmt.n2(r0)}</b> · 可亏预算 <b>${fmt.money(budget)}</b>
    → 建议买入 <b>${fmt.n1(shares)}</b> 股 · 占用资金 <b>${fmt.money(cap)}</b> · 最坏亏损 <b>${fmt.money(worst)}</b>
    <div class="why">止损若触发 ${fmt.n2(stop)}，亏 ≈ ${fmt.money(worst)}（${ACCOUNT>0?fmt.pct(worst/ACCOUNT):""} 账户）</div>`;
}
function saveNewPosition(){
  const tk=document.getElementById("f_ticker").value.trim().toUpperCase();
  const date=document.getElementById("f_date").value;
  const price=num(document.getElementById("f_price").value);
  const stop=num(document.getElementById("f_stop").value);
  const loss=num(document.getElementById("f_loss").value);
  const note=document.getElementById("addNote");
  if(!SUM[tk]){ note.textContent="代码无效"; return; }
  if(!date||price==null||stop==null){ note.textContent="请填日期、入场价、初始止损"; return; }
  const r0=price-stop; if(r0<=0){ note.textContent="止损须低于入场价"; return; }
  const budget=loss!=null?loss:perTradeRisk();
  const shares=mround(budget/r0,0.5);
  if(shares<1){ note.textContent="算出的股数不足 1，请提高预算"; return; }
  POS.push({ticker:tk,file:SUM[tk].file,name:SUM[tk].name,major:SUM[tk].major,
    entryDate:date,entryPrice:price,initialStop:stop,r0,shares,adds:[],status:"open",createdAt:Date.now()});
  savePositions(); closeAdd(); render();
}

/* ===== 管理抽屉（加仓 / 平仓 / 删除） ===== */
let drawerIdx=null;
function openDrawer(i){ drawerIdx=i; const h=POS[i]; const c=compute(h); if(!c)return;
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
      <dl class="kv">
        <dt>今日止损（去券商改这个）</dt><dd class="stopcell" style="font-size:15px">${fmt.n2(c.stop)}</dd>
        <dt>现价 / 距止损</dt><dd>${fmt.n2(c.close)} · ${c.distPct==null?"":fmt.pct(c.distPct)}</dd>
        <dt>均价成本 / 股数</dt><dd>${fmt.n2(c.avgCost)} · ${fmt.n1(c.shares)}</dd>
        <dt>初始止损 / R0</dt><dd>${fmt.n2(h.initialStop)} · ${fmt.n2(h.r0)}</dd>
        <dt>浮动盈亏</dt><dd>${signed(c.pnl,fmt.money2)} (${c.pnlPct==null?"":fmt.signedPct(c.pnlPct)})</dd>
        <dt>当前盈利倍数</dt><dd>${c.R==null?"":c.R.toFixed(2)+"R"}</dd>
        <dt>此刻被止损则</dt><dd>${signed(c.lockedIfStop,fmt.money)}</dd>
        <dt>加仓次数</dt><dd>${c.addsCount} / ${ADD_MAX}</dd>
      </dl>
      ${closed?`<div class="addbox">已于 ${h.exit.date} 按 ${fmt.n2(h.exit.price)} 平仓。</div>`:`
      ${addBox}${addLog}
      <div class="section-h">记录加仓</div>
      <div class="frow">
        <div class="fld">日期<input id="a_date" type="date" value="${DATA.generated_at?DATA.generated_at.slice(0,10):""}"></div>
        <div class="fld">价格<input id="a_price" inputmode="decimal" value="${fmt.n2(c.close)}"></div>
      </div>
      <div class="fld">股数<input id="a_shares" inputmode="decimal" value="${c.canAdd?c.addShares:""}" placeholder="${c.canAdd?c.addShares:'按建议或自填'}"></div>
      <button class="btn-primary" id="doAdd">确认加仓</button>
      <div class="section-h">平仓</div>
      <div class="frow">
        <div class="fld">平仓日期<input id="x_date" type="date" value="${DATA.generated_at?DATA.generated_at.slice(0,10):""}"></div>
        <div class="fld">平仓价格<input id="x_price" inputmode="decimal" value="${fmt.n2(c.close)}"></div>
      </div>
      <button class="mini" id="doClose">标记平仓</button>
      `}
      <div class="section-h">其他</div>
      <button class="mini danger" id="doDelete">删除这笔记录</button>
    </div>`;
  document.getElementById("scrim").hidden=false;
  const dr=document.getElementById("drawer"); dr.hidden=false; dr.setAttribute("aria-hidden","false");
  if(!closed){
    document.getElementById("doAdd").addEventListener("click",doAdd);
    document.getElementById("doClose").addEventListener("click",doClose);
  }
  document.getElementById("doDelete").addEventListener("click",doDelete);
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

/* ===== 导出 / 导入 ===== */
function exportJSON(){ const blob=new Blob([JSON.stringify(POS,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`positions_${(DATA.generated_at||"").slice(0,10)||"backup"}.json`; a.click(); URL.revokeObjectURL(a.href); }
function importJSON(e){ const f=e.target.files[0]; if(!f)return; const r=new FileReader();
  r.onload=()=>{ try{ const arr=JSON.parse(r.result); if(Array.isArray(arr)){ if(confirm(`导入 ${arr.length} 笔持仓，覆盖当前 ${POS.length} 笔？`)){ POS=arr; savePositions(); render(); } } }catch(err){ alert("文件格式不对"); } };
  r.readAsText(f); e.target.value=""; }

load();
