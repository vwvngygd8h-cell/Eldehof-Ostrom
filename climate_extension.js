  /* Climate 6.3: Vaillant hourly data are reduced to privacy-preserving monthly aggregates. */
  const CLIMATE_MONTH_KEY="eldehof-v6-climate-months-v630";
  const CLIMATE_WEATHER_KEY="eldehof-v6-climate-weather-v630";
  let climateMonths=loadClimateMonths();
  let climateWeather=safeJsonParse(localStorage.getItem(CLIMATE_WEATHER_KEY),{});
  let climateBusy=false;
  function climateNumber(raw){return raw==null||raw===""?null:(Number.isFinite(Number(raw))?Number(raw):null);}
  function climateSanitize(items){
    const map=new Map();
    for(const x of Array.isArray(items)?items:[]){
      const month=String(x?.month||"");
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))continue;
      const row={month,updatedAt:String(x.updatedAt||"")};
      for(const k of ["outdoorMean","outdoorMin","outdoorMax","outdoorHours","roomMean","roomHours","setpointMean","setpointHours","dhwMean","dhwHours"])row[k]=climateNumber(x[k]);
      map.set(month,row);
    }
    return [...map.values()].sort((a,b)=>a.month.localeCompare(b.month));
  }
  function loadClimateMonths(){return climateSanitize(safeJsonParse(localStorage.getItem(CLIMATE_MONTH_KEY),[]));}
  function saveClimateMonths(items){
    climateMonths=climateSanitize(items);
    localStorage.setItem(CLIMATE_MONTH_KEY,JSON.stringify(climateMonths));
    if(!syncApplying)scheduleCloudSync(1200);
  }
  function climatePreview(files){
    const cols={"system-temperature":[["OutdoorTemperature","outdoor"]],"zone-temperature":[["CurrentRoomTemperature","room"],["ManualModeSetpointHeating","setpoint"]],"dhw-temperature":[["DhwTankTemperature","dhw"]]};
    const map=new Map();
    for(const file of files.filter(f=>cols[f.type])){
      for(const r of file.rows){
        if(!map.has(r.monthKey))map.set(r.monthKey,{month:r.monthKey,series:{}});
        const bucket=map.get(r.monthKey);
        for(const [column,kind] of cols[file.type]){
          const value=r.values[column];
          if(!Number.isFinite(value))continue;
          if(!bucket.series[kind])bucket.series[kind]=new Map();
          const old=bucket.series[kind].get(r.dateTime);
          if(old!==undefined&&Math.abs(old-value)>.05)throw Error("Abweichende doppelte Temperaturmessungen in "+r.monthKey);
          bucket.series[kind].set(r.dateTime,value);
        }
      }
    }
    const stamp=new Date().toISOString();
    return [...map.values()].map(b=>{
      const row={month:b.month,updatedAt:stamp};
      for(const kind of ["outdoor","room","setpoint","dhw"]){
        const v=[...(b.series[kind]?.values()||[])];
        if(!v.length)continue;
        row[kind+"Mean"]=Math.round(v.reduce((a,x)=>a+x,0)/v.length*100)/100;
        row[kind+"Hours"]=v.length;
        if(kind==="outdoor"){row.outdoorMin=Math.min(...v);row.outdoorMax=Math.max(...v);}
      }
      return row;
    });
  }
  function climateImport(items){
    const map=new Map(climateMonths.map(r=>[r.month,r]));
    for(const row of items)map.set(row.month,{...map.get(row.month),...row});
    saveClimateMonths([...map.values()]);
  }
  function monthlyVaillantImports(files){
    const map=new Map();
    for(const file of files.filter(f=>f.type==="monthly-energy")){
      for(const row of file.rows){
        const raw=row.values,m=row.monthKey;
        if(raw.complete!==true||raw.estimated===true||m>currentMonthKey())continue;
        const fields=["electricityKWh","heatGeneratedKWh","heatingElectricityKWh","dhwElectricityKWh","heatingHeatKWh","dhwHeatKWh"];
        if(fields.some(k=>!Number.isFinite(raw[k])||raw[k]<0))continue;
        const year=Number(m.slice(0,4)),month=Number(m.slice(5));
        map.set(m,{month:m,electricityKWh:raw.electricityKWh,heatGeneratedKWh:raw.heatGeneratedKWh,heatingElectricityKWh:raw.heatingElectricityKWh,dhwElectricityKWh:raw.dhwElectricityKWh,heatingHeatKWh:raw.heatingHeatKWh,dhwHeatKWh:raw.dhwHeatKWh,complete:true,coverageStart:m+"-01",coverageEnd:m+"-"+String(new Date(year,month,0).getDate()).padStart(2,"0"),blocked:false});
      }
    }
    return [...map.values()];
  }
  const climateFmt=(v,d=0)=>Number.isFinite(v)?num(v,d):"–";
  function climateWeatherFor(month){return climateWeather?.[month.slice(0,4)]?.months?.find(x=>x.month===month)||null;}
  function climateRowsFor(year){
    const reference=new Map();
    for(let i=1;i<=12;i++){
      const mm=String(i).padStart(2,"0");
      const hist=[2024,2025].map(y=>climateWeatherFor(y+"-"+mm)).filter(w=>w?.complete&&Number.isFinite(w.hdd15));
      if(hist.length===2)reference.set(mm,(hist[0].hdd15+hist[1].hdd15)/2);
    }
    return Array.from({length:12},(_,i)=>{
      const month=year+"-"+String(i+1).padStart(2,"0");
      const r=recordForMonth(month),w=climateWeatherFor(month),sensor=climateMonths.find(x=>x.month===month),valid=w?.complete&&Number.isFinite(w.hdd15);
      const heat=Number.isFinite(r?.heatingHeat)?r.heatingHeat:null;
      const dhw=Number.isFinite(r?.dhwHeat)?r.dhwHeat:null;
      const baseline=reference.get(month.slice(5));
      const normalized=heat!==null&&valid&&w.hdd15>1&&Number.isFinite(baseline)?heat*baseline/w.hdd15:null;
      return {month,w,sensor,heat,dhw,valid,normalized};
    });
  }

  function renderClimateMultiYear(){
    const el=$("climateMultiYear");if(!el)return;
    const available=[...new Set(records.map(r=>Number(r.month?.slice(0,4))))].filter(y=>y>=2024&&y<=new Date().getFullYear()).sort();
    const candidates=available.map(y=>({year:y,rows:climateRowsFor(y)})).filter(x=>x.rows.filter(r=>r.normalized!==null).length>=3);
    if(candidates.length<2){el.textContent="Der direkte Jahresvergleich erscheint, sobald mindestens zwei Jahre jeweils drei vollständige vergleichbare Monate mit Heizwärme und Wetterdaten besitzen.";return;}
    const months=Array.from({length:12},(_,i)=>i+1).filter(m=>candidates.every(c=>c.rows[m-1]?.normalized!==null));
    if(months.length<3){el.textContent="Für diese Jahre gibt es noch nicht genügend gemeinsame Monate. Fehlende Vaillant-Wärme- oder Wetterwerte ergänzen.";return;}
    const baseYear=candidates[0].year,baseHeat=months.reduce((s,m)=>s+candidates[0].rows[m-1].normalized,0);
    const header='<p class="muted">Direktvergleich nur gleicher, vollständig erfasster Monate: '+months.map(m=>MONTHS[m-1]).join(", ")+'. Warmwasser ist ausgeschlossen.</p>';
    const table='<div class="table-scroll"><table><thead><tr><th>Jahr</th><th>Heizwärme gemessen kWh</th><th>Witterungsbereinigt kWh</th><th>Gegenüber '+baseYear+'</th></tr></thead><tbody>'+
      candidates.map(c=>{
        const original=months.reduce((s,m)=>s+c.rows[m-1].heat,0);
        const adjusted=months.reduce((s,m)=>s+c.rows[m-1].normalized,0);
        const delta=baseHeat>0?(adjusted/baseHeat-1)*100:null;
        return '<tr><td>'+c.year+'</td><td>'+num(original)+'</td><td>'+num(adjusted)+'</td><td>'+(delta===null?"–":pct(delta))+'</td></tr>';
      }).join("")+'</tbody></table></div>';
    el.innerHTML=header+table;
  }

  function renderClimateAnalysis(){
    if(!$("climateMetrics"))return;
    const year=Number($("analysisYear").value)||new Date().getFullYear(),rows=climateRowsFor(year);
    const h=rows.filter(x=>x.heat!==null),w=rows.filter(x=>x.dhw!==null),n=rows.filter(x=>x.normalized!==null),weather=rows.filter(x=>x.valid);
    const metrics=[
      ["Heizwärme",h.length?climateFmt(h.reduce((s,x)=>s+x.heat,0))+" kWh":"–",h.length+" Monate"],
      ["Warmwasserwärme",w.length?climateFmt(w.reduce((s,x)=>s+x.dhw,0))+" kWh":"–","ohne Witterungsbereinigung"],
      ["Heizgradtage",weather.length?climateFmt(weather.reduce((s,x)=>s+x.w.hdd15,0))+" K·d":"–","Basis 15 °C; vollständige Monate"],
      ["Bereinigte Heizwärme",n.length?climateFmt(n.reduce((s,x)=>s+x.normalized,0))+" kWh":"–",n.length+" vergleichbare Monate"]
    ];
    $("climateMetrics").innerHTML=metrics.map(([a,b,c])=>'<article><span>'+escapeHtml(a)+'</span><strong>'+escapeHtml(b)+'</strong><small>'+escapeHtml(c)+'</small></article>').join("");
    $("climateRows").innerHTML=rows.map(x=>'<tr><td>'+escapeHtml(monthLabel(x.month,false))+'</td><td>'+climateFmt(x.w?.meanTemp,1)+'</td><td>'+climateFmt(x.sensor?.outdoorMean,1)+'</td><td>'+climateFmt(x.sensor?.roomMean,1)+'</td><td>'+climateFmt(x.sensor?.dhwMean,1)+'</td><td>'+climateFmt(x.valid?x.w.hdd15:null)+'</td><td>'+climateFmt(x.heat)+'</td><td>'+climateFmt(x.dhw)+'</td><td>'+climateFmt(x.normalized)+'</td></tr>').join("");
    renderClimateMultiYear();
    $("climateInfo").textContent=(climateBusy?"Historische Wetterdaten werden geladen … ":"")+(n.length?n.length+" witterungsbereinigte Monate.":"Bitte historische Wetterdaten laden. ")+"Referenz je Kalendermonat: Heizgradtage 2024/2025. Nur gleiche Zeiträume vergleichen, Warmwasser getrennt.";
  }
  async function loadClimateWeather(){
    if(climateBusy)return;
    if(!settings.ostromAppKey){toast("Eldehof-App-Schlüssel unter Daten → Ostrom speichern");return;}
    climateBusy=true;renderClimateAnalysis();
    try{
      const years=[...new Set([...records.map(r=>Number(r.month.slice(0,4))),2024,2025])].filter(y=>y>=2023&&y<=new Date().getFullYear()).sort();
      for(const year of years){
        if(climateWeather?.[year]?.complete&&Date.now()-Date.parse(climateWeather[year].cachedAt||"")<90*86400e3)continue;
        const response=await fetch("/api/weather/archive?year="+year,{headers:{"x-eldehof-key":settings.ostromAppKey},cache:"no-store"});
        const payload=await response.json();
        if(!response.ok)throw Error(payload.error||"Historische Wetterdaten fehlen");
        climateWeather[year]=payload;
        localStorage.setItem(CLIMATE_WEATHER_KEY,JSON.stringify(climateWeather));
        renderClimateAnalysis();
      }
      toast("Wetterhistorie aktualisiert");
    }catch(e){toast("Wetter: "+e.message);}
    finally{climateBusy=false;renderClimateAnalysis();}
  }
