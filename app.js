(() => {
  "use strict";

  const DATA_KEY = "eldehof-v3-records";
  const SETTINGS_KEY = "eldehof-v3-settings";
  const LEGACY_KEYS = ["eldehof-v1-data", "enerhaus-v1-data"];
  const COLORS = {total:"#72dc57",heatPump:"#ff9f43",annex:"#4d9cff",schleeKlus:"#f2d15f",grid:"rgba(164,190,214,.14)",text:"#8fa3b8",bg:"#0b1929"};
  const MONTHS = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
  const $ = id => document.getElementById(id);

  let records = loadRecords();
  let settings = loadSettings();
  let toastTimer;
  let resizeTimer;
  let ostromPrices=[];
  let ostromSummary=null;
  let ostromBusy=false;

  function loadRecords(){
    try{
      const stored = JSON.parse(localStorage.getItem(DATA_KEY));
      if(Array.isArray(stored)) return sanitizeRecords(stored);
      for(const key of LEGACY_KEYS){
        const legacy = JSON.parse(localStorage.getItem(key));
        if(Array.isArray(legacy)){
          const migrated = sanitizeRecords(legacy);
          localStorage.setItem(DATA_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
    }catch{}
    return [];
  }

  function loadSettings(){
    const defaults = {fallbackPrice:0.32, defaultBaseFee:0, ostromAppKey:""};
    try{return {...defaults,...JSON.parse(localStorage.getItem(SETTINGS_KEY))};}catch{return defaults;}
  }

  function sanitizeRecords(items){
    const map = new Map();
    for(const raw of items || []){
      if(!/^\d{4}-\d{2}$/.test(String(raw.month||""))) continue;
      map.set(raw.month, {
        month:raw.month,
        heatPump:nullableNumber(raw.heatPump),
        annex:nullableNumber(raw.annex),
        total:nullableNumber(raw.total),
        priceCt:nullableNumber(raw.priceCt ?? raw.averagePriceCt),
        baseFee:nullableNumber(raw.baseFee),
        note:String(raw.note||"").trim()
      });
    }
    return [...map.values()].sort((a,b)=>a.month.localeCompare(b.month));
  }

  function nullableNumber(value){
    if(value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function saveAll(){
    localStorage.setItem(DATA_KEY,JSON.stringify(records));
    localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));
  }

  function sorted(){return [...records].sort((a,b)=>a.month.localeCompare(b.month));}
  function complete(r){return [r.heatPump,r.annex,r.total].every(Number.isFinite) && derived(r) >= 0;}
  function derived(r){
    if(![r.heatPump,r.annex,r.total].every(Number.isFinite)) return null;
    return r.total-r.heatPump-r.annex;
  }
  function yearOf(r){return Number(r.month.slice(0,4));}
  function monthIndex(r){return Number(r.month.slice(5,7))-1;}
  function latest(){return sorted().filter(r=>Number.isFinite(r.total)).at(-1) || sorted().at(-1) || null;}
  function monthLabel(month, long=true){
    const [y,m] = month.split("-").map(Number);
    return new Intl.DateTimeFormat("de-DE",long?{month:"long",year:"numeric"}:{month:"short",year:"2-digit"}).format(new Date(y,m-1,1));
  }
  function num(v,digits=0){return Number.isFinite(v)?new Intl.NumberFormat("de-DE",{maximumFractionDigits:digits,minimumFractionDigits:digits}).format(v):"–";}
  function euro(v){return Number.isFinite(v)?new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"}).format(v):"–";}
  function percent(v){return Number.isFinite(v)?`${v>0?"+":""}${num(v,1)} %`:"–";}

  function recordCost(r){
    if(!Number.isFinite(r?.total)) return null;
    const variable = Number.isFinite(r.priceCt) ? r.total*r.priceCt/100 : r.total*Number(settings.fallbackPrice||0);
    const fixed = Number.isFinite(r.baseFee) ? r.baseFee : Number(settings.defaultBaseFee||0);
    return variable + fixed;
  }

  function compareYear(r, field="total"){
    if(!r || !Number.isFinite(r[field])) return null;
    const previous = records.find(x=>x.month===`${yearOf(r)-1}-${r.month.slice(5)}`);
    if(!previous || !Number.isFinite(previous[field]) || previous[field]===0) return null;
    return (r[field]-previous[field])/previous[field]*100;
  }

  function yearRecords(year){return sorted().filter(r=>yearOf(r)===Number(year));}
  function sumYear(year, field){return yearRecords(year).reduce((s,r)=>s+(Number.isFinite(field==="schleeKlus"?derived(r):r[field])?(field==="schleeKlus"?derived(r):r[field]):0),0);}
  function completeMonths(year){return yearRecords(year).filter(complete).length;}

  function render(){
    renderHome();
    renderAnalytics();
    renderData();
    renderSettings();
    renderOstrom();
  }

  function renderHome(){
    const r = latest();
    if(!r){
      $("heroMonth").textContent="Noch keine Daten";
      $("heroTotal").textContent="–";
      $("heroComparison").textContent="Privates Backup importieren";
      $("heroCost").textContent="Kosten –";
      $("yearProgressText").textContent="–";
      $("heroProgress").style.width="0%";
      $("editLatestBtn").disabled=true;
      $("kpiGrid").innerHTML=emptyKpis();
      $("annualGrid").innerHTML=emptyAnnual();
      setInsight("Bereit für deine Daten","Importiere dein privates Backup oder füge den ersten Monat über den Plus-Button hinzu.");
      drawHomeChart([]);
      return;
    }
    $("editLatestBtn").disabled=false;
    $("heroMonth").textContent=monthLabel(r.month);
    $("heroTotal").textContent=num(r.total);
    const comp=compareYear(r);
    $("heroComparison").textContent=Number.isFinite(comp)?`${percent(comp)} zum Vorjahr`:"Kein Vorjahreswert";
    $("heroComparison").style.color=Number.isFinite(comp)?(comp<=0?COLORS.total:COLORS.heatPump):"";
    $("heroCost").textContent=`Kosten ${euro(recordCost(r))}`;
    const progress=((monthIndex(r)+1)/12)*100;
    $("heroProgress").style.width=`${progress}%`;
    $("yearProgressText").textContent=`${monthIndex(r)+1} von 12 Monaten`;
    renderKpis(r);
    renderInsight(r);
    drawHomeChart(sorted().filter(x=>Number.isFinite(x.total)).slice(-12));
    renderAnnual(r);
  }

  function emptyKpis(){return [
    ["🔥","Wärmepumpe","–"],["⌂","Altenteil","–"],["⌂","Schlee/Klus","–"],["€","Monatskosten","–"]
  ].map(([i,l,v])=>`<article class="kpi-card"><div class="kpi-head"><small>${l}</small><span class="kpi-icon">${i}</span></div><strong>${v}</strong><span class="unit">noch keine Daten</span></article>`).join("");}
  function emptyAnnual(){return ["Verbrauch","Prognose","Kosten","Monate"].map(x=>`<div class="annual-stat"><span>${x}</span><strong>–</strong><small>noch keine Daten</small></div>`).join("");}

  function renderKpis(r){
    const items=[
      {icon:"🔥",label:"Wärmepumpe",value:r.heatPump,field:"heatPump",color:COLORS.heatPump},
      {icon:"⌂",label:"Altenteil",value:r.annex,field:"annex",color:COLORS.annex},
      {icon:"⌂",label:"Schlee/Klus",value:derived(r),field:"schleeKlus",color:COLORS.schleeKlus},
      {icon:"€",label:"Monatskosten",value:recordCost(r),field:"cost",color:COLORS.total,currency:true}
    ];
    $("kpiGrid").innerHTML=items.map(item=>{
      let delta=null;
      if(item.field==="schleeKlus"){
        const prev=records.find(x=>x.month===`${yearOf(r)-1}-${r.month.slice(5)}`);
        const pv=prev?derived(prev):null;
        if(Number.isFinite(item.value)&&Number.isFinite(pv)&&pv!==0)delta=(item.value-pv)/pv*100;
      }else if(item.field==="cost"){
        const prev=records.find(x=>x.month===`${yearOf(r)-1}-${r.month.slice(5)}`);
        const pv=recordCost(prev);
        if(Number.isFinite(item.value)&&Number.isFinite(pv)&&pv!==0)delta=(item.value-pv)/pv*100;
      }else delta=compareYear(r,item.field);
      const cls=!Number.isFinite(delta)?"neutral":delta<=0?"good":"bad";
      const deltaText=Number.isFinite(delta)?`${percent(delta)} zum Vorjahr`:"kein Vorjahreswert";
      return `<article class="kpi-card" style="border-top-color:${item.color}"><div class="kpi-head"><small>${item.label}</small><span class="kpi-icon">${item.icon}</span></div><strong>${item.currency?euro(item.value):num(item.value)}</strong><span class="unit">${item.currency?"inkl. Fixkosten":"kWh"}</span><span class="delta ${cls}">${deltaText}</span></article>`;
    }).join("");
  }

  function setInsight(title,text){$("insightTitle").textContent=title;$("insightText").textContent=text;}
  function renderInsight(r){
    if(!complete(r)){setInsight("Monat noch unvollständig",`${monthLabel(r.month)} enthält noch nicht alle drei Messwerte.`);return;}
    const candidates=[
      {name:"Wärmepumpe",value:compareYear(r,"heatPump")},
      {name:"Altenteil",value:compareYear(r,"annex")},
      {name:"Gesamtverbrauch",value:compareYear(r,"total")}
    ].filter(x=>Number.isFinite(x.value)).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
    if(candidates.length){
      const c=candidates[0];
      if(Math.abs(c.value)<5)setInsight("Stabiler Monatswert",`${c.name} liegt mit ${percent(c.value)} nahe am Vorjahresmonat.`);
      else if(c.value>0)setInsight(`${c.name} ist gestiegen`,`${monthLabel(r.month)} liegt ${num(Math.abs(c.value),1)} % über dem gleichen Monat des Vorjahres.`);
      else setInsight(`${c.name} ist gesunken`,`${monthLabel(r.month)} liegt ${num(Math.abs(c.value),1)} % unter dem gleichen Monat des Vorjahres.`);
      return;
    }
    const share=r.total?Math.round(r.heatPump/r.total*100):0;
    setInsight("Verteilung des Monats",`Die Wärmepumpe verursacht ${share} % des Gesamtverbrauchs im ${monthLabel(r.month)}.`);
  }

  function renderAnnual(r){
    const year=yearOf(r), months=completeMonths(year), total=sumYear(year,"total");
    const projection=months?total/months*12:null;
    const cost=yearRecords(year).reduce((s,x)=>s+(recordCost(x)||0),0);
    const prevTotal=sumYear(year-1,"total");
    const comparablePrev=yearRecords(year-1).filter(x=>monthIndex(x)<=monthIndex(r)).reduce((s,x)=>s+(x.total||0),0);
    const yoy=comparablePrev?((total-comparablePrev)/comparablePrev*100):null;
    $("annualTitle").textContent=String(year);
    $("annualGrid").innerHTML=`
      <div class="annual-stat"><span>Verbrauch bisher</span><strong>${num(total)} kWh</strong><small>${Number.isFinite(yoy)?percent(yoy)+" zum Vorjahr":"laufendes Jahr"}</small></div>
      <div class="annual-stat"><span>Hochrechnung</span><strong>${num(projection)} kWh</strong><small>auf 12 Monate</small></div>
      <div class="annual-stat"><span>Kosten bisher</span><strong>${euro(cost)}</strong><small>Tarifwerte/Fallback</small></div>
      <div class="annual-stat"><span>Vollständige Monate</span><strong>${months}</strong><small>von 12</small></div>`;
    const last12=sorted().filter(x=>Number.isFinite(x.total)).slice(-12);
    if(last12.length>=2){
      const first=last12[0].total,last=last12.at(-1).total;
      const t=first?((last-first)/first*100):null;
      $("trendBadge").textContent=Number.isFinite(t)?percent(t):"–";
      $("trendBadge").style.color=Number.isFinite(t)?(t<=0?COLORS.total:COLORS.heatPump):"";
    }
  }

  function renderAnalytics(){
    const years=[...new Set(records.filter(r=>Number.isFinite(r.total)).map(yearOf))].sort((a,b)=>b-a);
    const current=$("shareYear").value;
    $("shareYear").innerHTML=years.length?years.map(y=>`<option value="${y}">${y}</option>`).join(""):`<option>–</option>`;
    if(years.includes(Number(current)))$("shareYear").value=current;
    const limit=$("periodSelect").value||"12";
    const rows=sorted().filter(r=>Number.isFinite(r.total));
    const display=limit==="all"?rows:rows.slice(-Number(limit));
    drawLineChart($("lineChart"),display);
    drawStackedChart($("stackedChart"),display.slice(-12));
    drawYearChart($("yearChart"),years.slice().reverse());
    renderLegends();
    renderDonut(Number($("shareYear").value)||years[0]);
  }

  function renderLegends(){
    const items=[["Gesamt",COLORS.total],["Wärmepumpe",COLORS.heatPump],["Altenteil",COLORS.annex],["Schlee/Klus",COLORS.schleeKlus]];
    const html=items.map(([n,c])=>`<span class="legend-item"><i class="legend-dot" style="background:${c}"></i>${n}</span>`).join("");
    $("lineLegend").innerHTML=html;$("stackLegend").innerHTML=items.slice(1).map(([n,c])=>`<span class="legend-item"><i class="legend-dot" style="background:${c}"></i>${n}</span>`).join("");
  }

  function renderDonut(year){
    const values=[sumYear(year,"heatPump"),sumYear(year,"annex"),sumYear(year,"schleeKlus")];
    const total=values.reduce((a,b)=>a+b,0);
    drawDonut($("donutChart"),values,total,year);
    const names=["Wärmepumpe","Altenteil","Schlee/Klus"],colors=[COLORS.heatPump,COLORS.annex,COLORS.schleeKlus];
    $("shareList").innerHTML=names.map((name,i)=>`<div class="share-row"><div><span><i class="legend-dot" style="display:inline-block;background:${colors[i]};margin-right:6px"></i>${name}</span><span>${total?num(values[i]/total*100,1):0} %</span></div><strong>${num(values[i])} kWh</strong></div>`).join("");
  }

  function renderData(){
    const years=[...new Set(records.map(yearOf))].sort((a,b)=>b-a);
    const selected=$("dataYearFilter").value||"all";
    $("dataYearFilter").innerHTML=`<option value="all">Alle Jahre</option>${years.map(y=>`<option value="${y}">${y}</option>`).join("")}`;
    if(selected==="all"||years.includes(Number(selected)))$("dataYearFilter").value=selected;
    let rows=sorted().reverse();
    if($("dataYearFilter").value!=="all")rows=rows.filter(r=>yearOf(r)===Number($("dataYearFilter").value));
    if(!rows.length){
      $("timeline").innerHTML=`<section class="empty-state"><div class="empty-icon">⌂⚡</div><h2>Noch keine Monatswerte</h2><p>Importiere dein privates Backup oder lege den ersten Monat an.</p></section>`;
      return;
    }
    $("timeline").innerHTML=rows.map(r=>{
      const sk=derived(r), cost=recordCost(r);
      return `<button class="month-card ${complete(r)?"":"incomplete"}" data-month="${r.month}"><div><div class="month-title">${monthLabel(r.month)}</div><div class="month-sub"><span style="color:${COLORS.heatPump}">🔥 ${num(r.heatPump)}</span><span style="color:${COLORS.annex}">⌂ ${num(r.annex)}</span><span style="color:${COLORS.schleeKlus}">⌂ ${num(sk)}</span>${r.note?`<span>✎ ${escapeHtml(r.note.slice(0,35))}</span>`:""}</div></div><div class="month-right"><strong>${num(r.total)}</strong><small>kWh gesamt</small><span class="month-cost">${euro(cost)}</span></div></button>`;
    }).join("");
    document.querySelectorAll(".month-card").forEach(b=>b.addEventListener("click",()=>openEntry(b.dataset.month)));
  }

  function renderSettings(){
    $("fallbackPrice").value=Number(settings.fallbackPrice||0).toFixed(3);
    $("defaultBaseFee").value=Number(settings.defaultBaseFee||0).toFixed(2);
    $("ostromAppKeyInput").value=settings.ostromAppKey||"";
    if(!$("ostromMonthSelect").value)$("ostromMonthSelect").value=currentMonthKey();
  }


  function currentMonthKey(){
    const d=new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  }

  async function ostromFetch(path){
    if(!settings.ostromAppKey)throw new Error("App-Schlüssel fehlt.");
    const response=await fetch(path,{
      headers:{"x-eldehof-key":settings.ostromAppKey,"accept":"application/json"},
      cache:"no-store"
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||payload.message||`Fehler ${response.status}`);
    return payload;
  }

  async function connectOstrom(){
    const key=$("ostromAppKeyInput").value.trim();
    if(!key){$("ostromConnectionStatus").textContent="Bitte App-Schlüssel eintragen.";$("ostromConnectionStatus").className="connection-status error";return;}
    settings.ostromAppKey=key;saveAll();
    $("ostromConnectionStatus").textContent="Verbindung wird geprüft …";
    $("ostromConnectionStatus").className="connection-status";
    try{
      const health=await ostromFetch("/api/health");
      if(!health.configured)throw new Error("Cloudflare-Secrets sind noch nicht vollständig eingerichtet.");
      $("ostromConnectionStatus").textContent="Ostrom-Verbindung ist bereit.";
      $("ostromConnectionStatus").className="connection-status ok";
      await refreshOstrom(true);
    }catch(error){
      $("ostromConnectionStatus").textContent=error.message;
      $("ostromConnectionStatus").className="connection-status error";
      ostromPrices=[];ostromSummary=null;renderOstrom();
    }
  }

  function disconnectOstrom(){
    settings.ostromAppKey="";saveAll();ostromPrices=[];ostromSummary=null;
    $("ostromAppKeyInput").value="";
    $("ostromConnectionStatus").textContent="Verbindung entfernt.";
    $("ostromConnectionStatus").className="connection-status";
    renderOstrom();toast("Ostrom-Verbindung entfernt");
  }

  async function refreshOstrom(showToast=false){
    if(ostromBusy||!settings.ostromAppKey){renderOstrom();return;}
    ostromBusy=true;renderOstrom();
    try{
      const payload=await ostromFetch("/api/prices");
      ostromPrices=Array.isArray(payload.prices)?payload.prices:[];
      renderOstrom();
      if(showToast)toast("Ostrom-Preise aktualisiert");
    }catch(error){
      $("ostromDisconnected").textContent=error.message;
      $("ostromDisconnected").classList.remove("hidden");
      $("ostromLiveContent").classList.add("hidden");
    }finally{ostromBusy=false;renderOstrom();}
  }

  async function loadOstromMonth(){
    const month=$("ostromMonthSelect").value;
    if(!month)return;
    ostromBusy=true;ostromSummary=null;renderOstrom();
    try{
      ostromSummary=await ostromFetch(`/api/month?month=${encodeURIComponent(month)}`);
      renderOstrom();toast(`${monthLabel(month)} geladen`);
    }catch(error){
      alert(`Ostrom-Monat konnte nicht geladen werden: ${error.message}`);
    }finally{ostromBusy=false;renderOstrom();}
  }

  function applyOstromMonth(){
    if(!ostromSummary?.month)return;
    const month=ostromSummary.month;
    const existing=records.find(r=>r.month===month);
    const message=`${monthLabel(month)} übernehmen?\n\nGesamt: ${num(ostromSummary.totalKWh,3)} kWh\nØ Preis: ${num(ostromSummary.weightedAverageCtPerKWh,3)} ct/kWh\nFixkosten: ${euro(ostromSummary.fixedCostEur)}`;
    if(!confirm(message))return;
    const record={
      month,
      heatPump:existing?.heatPump??null,
      annex:existing?.annex??null,
      total:Number.isFinite(Number(ostromSummary.totalKWh))?Number(ostromSummary.totalKWh):existing?.total??null,
      priceCt:Number.isFinite(Number(ostromSummary.weightedAverageCtPerKWh))?Number(ostromSummary.weightedAverageCtPerKWh):existing?.priceCt??null,
      baseFee:Number.isFinite(Number(ostromSummary.fixedCostEur))?Number(ostromSummary.fixedCostEur):existing?.baseFee??null,
      note:existing?.note||""
    };
    records=records.filter(r=>r.month!==month);records.push(record);records=sanitizeRecords(records);saveAll();render();
    toast("Ostrom-Monat übernommen");
  }

  function renderOstrom(){
    const connected=Boolean(settings.ostromAppKey);
    $("ostromDisconnected").classList.toggle("hidden",connected);
    $("ostromLiveContent").classList.toggle("hidden",!connected);
    $("refreshOstromBtn").disabled=ostromBusy||!connected;
    $("loadOstromMonthBtn").disabled=ostromBusy||!connected;
    $("ostromDisconnected").textContent=connected?"Daten werden geladen …":"Unter „Mehr“ den persönlichen Eldehof-App-Schlüssel eintragen.";
    if(!connected)return;

    if(!ostromPrices.length){
      $("ostromKpis").innerHTML=`<article class="ostrom-kpi"><small>Status</small><strong>${ostromBusy?"Laden …":"Bereit"}</strong><span>Preise aktualisieren</span></article>`;
      drawOstromPriceChart([]);
    }else{
      const now=Date.now();
      const normalized=ostromPrices.map(p=>({...p,time:new Date(p.date).getTime(),price:Number(p.totalCtPerKWh)})).filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.price));
      const future=normalized.filter(p=>p.time>=now).slice(0,24);
      const pool=future.length?future:normalized.slice(-24);
      const current=normalized.find(p=>p.time<=now&&p.time+3600000>now)||pool[0];
      const cheapest=pool.reduce((a,b)=>b.price<a.price?b:a,pool[0]);
      const max=pool.reduce((a,b)=>b.price>a.price?b:a,pool[0]);
      const avg=pool.reduce((s,p)=>s+p.price,0)/(pool.length||1);
      const t=p=>new Intl.DateTimeFormat("de-DE",{weekday:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(p.date));
      $("ostromKpis").innerHTML=`
        <article class="ostrom-kpi"><small>Jetzt</small><strong>${num(current?.price,2)} ct</strong><span>pro kWh</span></article>
        <article class="ostrom-kpi"><small>Günstigste Stunde</small><strong>${num(cheapest?.price,2)} ct</strong><span>${cheapest?t(cheapest):"–"}</span></article>
        <article class="ostrom-kpi"><small>Ø nächste 24 h</small><strong>${num(avg,2)} ct</strong><span>pro kWh</span></article>
        <article class="ostrom-kpi"><small>Teuerste Stunde</small><strong>${num(max?.price,2)} ct</strong><span>${max?t(max):"–"}</span></article>`;
      drawOstromPriceChart(pool);
    }

    if(ostromSummary){
      $("ostromMonthSummary").innerHTML=`<div class="ostrom-summary-grid">
        <div>Smart-Meter-Verbrauch<strong>${num(ostromSummary.totalKWh,3)} kWh</strong></div>
        <div>Ø Arbeitspreis<strong>${num(ostromSummary.weightedAverageCtPerKWh,3)} ct/kWh</strong></div>
        <div>Variable Kosten<strong>${euro(ostromSummary.variableCostEur)}</strong></div>
        <div>Fixkosten<strong>${euro(ostromSummary.fixedCostEur)}</strong></div>
        <div>Gesamtkosten<strong>${euro(ostromSummary.totalCostEur)}</strong></div>
        <div>Datenabdeckung<strong>${ostromSummary.matchedIntervals}/${ostromSummary.consumptionIntervals}</strong></div>
      </div>`;
      $("applyOstromMonthBtn").classList.remove("hidden");
    }else{
      $("ostromMonthSummary").innerHTML="";
      $("applyOstromMonthBtn").classList.add("hidden");
    }
  }

  function drawOstromPriceChart(rows){
    const {ctx,w,h}=setupCanvas($("ostromPriceChart"));ctx.clearRect(0,0,w,h);
    if(w<80||h<80||!rows.length)return;
    const values=rows.map(r=>Number(r.price));
    const min=Math.min(0,...values),max=niceMax(Math.max(...values));
    const l=43,r=8,t=14,b=34,pw=w-l-r,ph=h-t-b;
    const x=i=>l+(rows.length===1?pw/2:i*pw/(rows.length-1));
    const y=v=>t+ph-(v-min)/(max-min||1)*ph;
    ctx.strokeStyle=COLORS.grid;ctx.fillStyle=COLORS.text;ctx.font="9px -apple-system";
    for(let i=0;i<=4;i++){const yy=t+ph*i/4,val=max-(max-min)*i/4;ctx.beginPath();ctx.moveTo(l,yy);ctx.lineTo(w-r,yy);ctx.stroke();ctx.fillText(`${Math.round(val)} ct`,2,yy+3);}
    ctx.strokeStyle=COLORS.total;ctx.lineWidth=2.7;ctx.beginPath();
    rows.forEach((row,i)=>i?ctx.lineTo(x(i),y(row.price)):ctx.moveTo(x(i),y(row.price)));ctx.stroke();
    const step=Math.max(1,Math.ceil(rows.length/6));ctx.textAlign="center";
    rows.forEach((row,i)=>{if(i%step===0)ctx.fillText(new Intl.DateTimeFormat("de-DE",{weekday:"short",hour:"2-digit"}).format(new Date(row.date)),x(i),h-9);});
    ctx.textAlign="start";
  }

  function openEntry(month=null){
    const r=month?records.find(x=>x.month===month):null;
    $("entryForm").reset();
    $("originalMonth").value=r?.month||"";
    $("dialogTitle").textContent=r?monthLabel(r.month):"Monat hinzufügen";
    $("monthInput").value=r?.month||nextMonth();
    $("heatPumpInput").value=r?.heatPump??"";
    $("annexInput").value=r?.annex??"";
    $("totalInput").value=r?.total??"";
    $("priceCtInput").value=r?.priceCt??"";
    $("baseFeeInput").value=r?.baseFee??"";
    $("noteInput").value=r?.note||"";
    $("deleteEntryBtn").classList.toggle("hidden",!r);
    $("formError").textContent="";
    updateCalculated();
    $("entryDialog").showModal();
  }

  function nextMonth(){
    const r=sorted().at(-1);
    if(!r){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;}
    const [y,m]=r.month.split("-").map(Number),d=new Date(y,m,1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  }

  function updateCalculated(){
    const hp=nullableNumber($("heatPumpInput").value),ann=nullableNumber($("annexInput").value),total=nullableNumber($("totalInput").value);
    const value=[hp,ann,total].every(Number.isFinite)?total-hp-ann:null;
    $("calculatedValue").textContent=Number.isFinite(value)?`${num(value)} kWh`:"–";
    $("calculatedValue").style.color=Number.isFinite(value)&&value<0?"#ff8b8b":"";
  }

  function submitEntry(event){
    event.preventDefault();
    const month=$("monthInput").value;
    const hp=nullableNumber($("heatPumpInput").value),ann=nullableNumber($("annexInput").value),total=nullableNumber($("totalInput").value);
    if(!month){$("formError").textContent="Bitte einen Monat auswählen.";return;}
    if([hp,ann,total].some(v=>v!==null&&v<0)){$("formError").textContent="Verbrauchswerte dürfen nicht negativ sein.";return;}
    if([hp,ann,total].every(Number.isFinite)&&total-hp-ann<0){$("formError").textContent="Gesamt muss mindestens Wärmepumpe plus Altenteil entsprechen.";return;}
    const original=$("originalMonth").value;
    if(month!==original&&records.some(r=>r.month===month)){$("formError").textContent="Für diesen Monat existiert bereits ein Eintrag.";return;}
    const record={month,heatPump:hp,annex:ann,total,priceCt:nullableNumber($("priceCtInput").value),baseFee:nullableNumber($("baseFeeInput").value),note:$("noteInput").value.trim()};
    records=records.filter(r=>r.month!==original&&r.month!==month);records.push(record);records=sanitizeRecords(records);saveAll();
    $("entryDialog").close();render();toast("Monatswert gespeichert");
  }

  function deleteEntry(){
    const month=$("originalMonth").value;if(!month)return;
    if(!confirm(`${monthLabel(month)} wirklich löschen?`))return;
    records=records.filter(r=>r.month!==month);saveAll();$("entryDialog").close();render();toast("Monat gelöscht");
  }

  function exportBackup(){
    const payload={version:3,app:"Eldehof",purpose:"Privates lokales Backup – nicht öffentlich hochladen",exportedAt:new Date().toISOString(),settings,records};
    downloadBlob(JSON.stringify(payload,null,2),`Eldehof_PRIVATE_Backup_${dateStamp()}.json`,"application/json");toast("Backup erstellt");
  }

  function exportCsv(){
    const rows=[["Monat","Wärmepumpe kWh","Altenteil kWh","Schlee/Klus kWh","Gesamt kWh","Ø Preis ct/kWh","Fixkosten EUR","Monatskosten EUR","Notiz"]];
    for(const r of sorted())rows.push([r.month,r.heatPump??"",r.annex??"",derived(r)??"",r.total??"",r.priceCt??"",r.baseFee??"",recordCost(r)??"",r.note||""]);
    const csv="\uFEFF"+rows.map(row=>row.map(csvCell).join(";")).join("\n");downloadBlob(csv,`Eldehof_Export_${dateStamp()}.csv`,"text/csv;charset=utf-8");toast("CSV erstellt");
  }

  async function importBackup(file){
    try{
      const payload=JSON.parse(await file.text());
      const incoming=Array.isArray(payload)?payload:(Array.isArray(payload.records)?payload.records:payload.data);
      if(!Array.isArray(incoming))throw new Error("Keine Monatsdaten gefunden");
      const cleaned=sanitizeRecords(incoming);
      if(!cleaned.length&&!confirm("Die Datei enthält keine Monatswerte. Trotzdem importieren?"))return;
      records=cleaned;
      if(payload.settings){
        settings={...settings,...payload.settings};
        if(Number.isFinite(Number(payload.settings.price))&&!Number.isFinite(Number(payload.settings.fallbackPrice)))settings.fallbackPrice=Number(payload.settings.price);
      }
      saveAll();render();toast(`${records.length} Monatswerte importiert`);
    }catch(error){alert(`Import nicht möglich: ${error.message}`);}
    finally{document.querySelectorAll('input[type="file"]').forEach(i=>i.value="");}
  }

  function resetApp(){
    if(!confirm("Alle lokal gespeicherten Eldehof-Daten löschen? Vorher ein Backup exportieren."))return;
    records=[];settings={fallbackPrice:.32,defaultBaseFee:0,ostromAppKey:""};saveAll();render();toast("Eldehof wurde zurückgesetzt");
  }

  function downloadBlob(content,name,type){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);}
  function csvCell(value){const s=String(value??"").replace(/"/g,'""');return `"${s}"`;}
  function dateStamp(){return new Date().toISOString().slice(0,10);}
  function escapeHtml(s){return s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
  function toast(message){clearTimeout(toastTimer);$("toast").textContent=message;$("toast").classList.add("show");toastTimer=setTimeout(()=>$("toast").classList.remove("show"),2400);}

  function setupCanvas(canvas){
    const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2),w=Math.max(1,rect.width),h=Math.max(1,rect.height);
    canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.lineCap="round";ctx.lineJoin="round";return{ctx,w,h};
  }
  function niceMax(value){if(!value||value<=0)return 100;const p=10**Math.floor(Math.log10(value));return Math.ceil(value/p)*p;}
  function drawGrid(ctx,w,h,l,r,t,b,max,steps=4){ctx.strokeStyle=COLORS.grid;ctx.fillStyle=COLORS.text;ctx.font="10px -apple-system";for(let i=0;i<=steps;i++){const y=t+(h-t-b)*i/steps;ctx.beginPath();ctx.moveTo(l,y);ctx.lineTo(w-r,y);ctx.stroke();ctx.fillText(num(max*(steps-i)/steps),2,y+3);}}

  function drawHomeChart(rows){
    const {ctx,w,h}=setupCanvas($("homeChart"));ctx.clearRect(0,0,w,h);if(w<80||h<80||rows.length<2)return;
    const l=30,r=30,t=16,b=25,max=niceMax(Math.max(...rows.map(x=>x.total||0))),pw=w-l-r,ph=h-t-b,x=i=>l+i*pw/(rows.length-1),y=v=>t+ph-v/max*ph;
    const grad=ctx.createLinearGradient(0,t,0,h-b);grad.addColorStop(0,"rgba(114,220,87,.28)");grad.addColorStop(1,"rgba(114,220,87,0)");ctx.beginPath();rows.forEach((row,i)=>i?ctx.lineTo(x(i),y(row.total)):ctx.moveTo(x(i),y(row.total)));ctx.lineTo(x(rows.length-1),h-b);ctx.lineTo(x(0),h-b);ctx.closePath();ctx.fillStyle=grad;ctx.fill();ctx.beginPath();rows.forEach((row,i)=>i?ctx.lineTo(x(i),y(row.total)):ctx.moveTo(x(i),y(row.total)));ctx.strokeStyle=COLORS.total;ctx.lineWidth=3;ctx.stroke();ctx.fillStyle=COLORS.text;ctx.font="9px -apple-system";ctx.textAlign="center";[0,Math.floor((rows.length-1)/2),rows.length-1].forEach(i=>ctx.fillText(monthLabel(rows[i].month,false),x(i),h-7));ctx.textAlign="start";
  }

  function drawLineChart(canvas,rows){
    const {ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);if(w<80||h<80||!rows.length)return;
    const l=42,r=9,t=14,b=34,pw=w-l-r,ph=h-t-b,max=niceMax(Math.max(...rows.map(x=>x.total||0))),x=i=>l+(rows.length===1?pw/2:i*pw/(rows.length-1)),y=v=>t+ph-(v||0)/max*ph;drawGrid(ctx,w,h,l,r,t,b,max);
    const series=[{field:"total",color:COLORS.total},{field:"heatPump",color:COLORS.heatPump},{field:"annex",color:COLORS.annex},{field:"schleeKlus",color:COLORS.schleeKlus}];
    series.forEach(s=>{ctx.strokeStyle=s.color;ctx.lineWidth=s.field==="total"?2.8:2;ctx.beginPath();let started=false;rows.forEach((row,i)=>{const v=s.field==="schleeKlus"?derived(row):row[s.field];if(!Number.isFinite(v)){started=false;return;}if(!started){ctx.moveTo(x(i),y(v));started=true}else ctx.lineTo(x(i),y(v));});ctx.stroke();});
    ctx.fillStyle=COLORS.text;ctx.font="9px -apple-system";ctx.textAlign="center";const labelCount=Math.min(6,rows.length);const labelIndices=[...new Set(Array.from({length:labelCount},(_,j)=>Math.round(j*(rows.length-1)/Math.max(1,labelCount-1))))];labelIndices.forEach(i=>ctx.fillText(monthLabel(rows[i].month,false),x(i),h-9));ctx.textAlign="start";
  }

  function drawStackedChart(canvas,rows){
    const {ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);if(w<80||h<80||!rows.length)return;
    const l=42,r=8,t=14,b=36,pw=w-l-r,ph=h-t-b,max=niceMax(Math.max(...rows.map(x=>complete(x)?x.total:0))),slot=pw/rows.length,bw=Math.min(28,slot*.62);drawGrid(ctx,w,h,l,r,t,b,max);
    rows.forEach((row,i)=>{if(!complete(row))return;const vals=[row.heatPump,row.annex,derived(row)],colors=[COLORS.heatPump,COLORS.annex,COLORS.schleeKlus];let bottom=h-b;vals.forEach((v,j)=>{const bh=v/max*ph;ctx.fillStyle=colors[j];ctx.fillRect(l+i*slot+(slot-bw)/2,bottom-bh,bw,bh);bottom-=bh;});});
    ctx.fillStyle=COLORS.text;ctx.font="9px -apple-system";ctx.textAlign="center";rows.forEach((row,i)=>{if(rows.length<=12||i%2===0)ctx.fillText(MONTHS[monthIndex(row)],l+i*slot+slot/2,h-10)});ctx.textAlign="start";
  }

  function drawYearChart(canvas,years){
    const {ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);if(w<80||h<80||!years.length)return;
    const totals=years.map(y=>sumYear(y,"total")),max=niceMax(Math.max(...totals)),l=42,r=8,t=14,b=35,pw=w-l-r,ph=h-t-b,slot=pw/years.length,bw=Math.min(45,slot*.55);drawGrid(ctx,w,h,l,r,t,b,max);
    years.forEach((year,i)=>{const bh=totals[i]/max*ph,x=l+i*slot+(slot-bw)/2,y=h-b-bh;const grad=ctx.createLinearGradient(0,y,0,h-b);grad.addColorStop(0,COLORS.total);grad.addColorStop(1,"#329c51");ctx.fillStyle=grad;roundRect(ctx,x,y,bw,bh,7);ctx.fill();ctx.fillStyle=COLORS.text;ctx.textAlign="center";ctx.font="10px -apple-system";ctx.fillText(year,x+bw/2,h-10);ctx.fillStyle="#dbe9df";ctx.fillText(num(totals[i]),x+bw/2,Math.max(11,y-6));});ctx.textAlign="start";
  }

  function drawDonut(canvas,values,total,year){
    const {ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);if(w<80||h<80)return;const cx=w/2,cy=h/2,r=Math.min(w,h)*.34,thick=Math.max(20,r*.28),colors=[COLORS.heatPump,COLORS.annex,COLORS.schleeKlus];ctx.lineWidth=thick;ctx.strokeStyle="rgba(255,255,255,.07)";ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();if(total){let a=-Math.PI/2;values.forEach((v,i)=>{const span=v/total*Math.PI*2;ctx.strokeStyle=colors[i];ctx.beginPath();ctx.arc(cx,cy,r,a+.015,a+span-.015);ctx.stroke();a+=span;});}ctx.fillStyle=COLORS.text;ctx.font="10px -apple-system";ctx.textAlign="center";ctx.fillText(String(year||"–"),cx,cy-8);ctx.fillStyle="#f5f8fb";ctx.font="bold 22px -apple-system";ctx.fillText(`${num(total)} kWh`,cx,cy+17);ctx.textAlign="start";
  }
  function roundRect(ctx,x,y,w,h,r){const rr=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+rr,y);ctx.arcTo(x+w,y,x+w,y+h,rr);ctx.arcTo(x+w,y+h,x,y+h,rr);ctx.arcTo(x,y+h,x,y,rr);ctx.arcTo(x,y,x+w,y,rr);ctx.closePath();}

  function switchView(view){document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===view));document.querySelectorAll(".bottom-nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===view));$("addMonthFab").classList.toggle("hidden",view==="settingsView");window.scrollTo({top:0,behavior:"smooth"});setTimeout(render,70);}

  document.querySelectorAll(".bottom-nav button").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
  document.querySelectorAll("[data-open-view]").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.openView)));
  [$("addMonthFab"),$("addMonthTop")].forEach(b=>b.addEventListener("click",()=>openEntry()));
  $("editLatestBtn").addEventListener("click",()=>latest()&&openEntry(latest().month));
  $("closeDialog").addEventListener("click",()=>$("entryDialog").close());
  $("entryForm").addEventListener("submit",submitEntry);
  $("deleteEntryBtn").addEventListener("click",deleteEntry);
  [$("heatPumpInput"),$("annexInput"),$("totalInput")].forEach(i=>i.addEventListener("input",updateCalculated));
  $("periodSelect").addEventListener("change",renderAnalytics);
  $("shareYear").addEventListener("change",()=>renderDonut(Number($("shareYear").value)));
  $("dataYearFilter").addEventListener("change",renderData);
  [$("exportBackupBtn"),$("settingsBackupBtn")].forEach(b=>b.addEventListener("click",exportBackup));
  [$("exportCsvBtn"),$("settingsCsvBtn")].forEach(b=>b.addEventListener("click",exportCsv));
  [$("importBackupInput"),$("settingsImportInput")].forEach(i=>i.addEventListener("change",e=>e.target.files[0]&&importBackup(e.target.files[0])));
  $("saveSettingsBtn").addEventListener("click",()=>{settings.fallbackPrice=Math.max(0,Number($("fallbackPrice").value)||0);settings.defaultBaseFee=Math.max(0,Number($("defaultBaseFee").value)||0);saveAll();render();toast("Einstellungen gespeichert");});
  $("connectOstromBtn").addEventListener("click",connectOstrom);
  $("disconnectOstromBtn").addEventListener("click",disconnectOstrom);
  $("refreshOstromBtn").addEventListener("click",()=>refreshOstrom(true));
  $("loadOstromMonthBtn").addEventListener("click",loadOstromMonth);
  $("applyOstromMonthBtn").addEventListener("click",applyOstromMonth);
  $("resetAppBtn").addEventListener("click",resetApp);
  window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(render,120)});

  if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js?v=3.1.0").catch(()=>{}));
  render();
  if(settings.ostromAppKey)refreshOstrom(false);
})();
