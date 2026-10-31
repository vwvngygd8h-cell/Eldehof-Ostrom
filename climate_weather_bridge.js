async function buildClimateArchive(year,env){
  const zip=clean(env.OSTROM_ZIP_CODE)||"19306";
  const geo=new URL("https://geocoding-api.open-meteo.com/v1/search");
  geo.searchParams.set("name",zip);
  geo.searchParams.set("count","1");
  geo.searchParams.set("countryCode","DE");
  const lookup=await fetchJsonWithTimeout(geo.toString(),{headers:{accept:"application/json"}},{timeoutMs:12000,retries:1,label:"Wetterstandort"});
  const location=lookup.payload?.results?.[0];
  if(!lookup.response.ok||!Number.isFinite(location?.latitude)||!Number.isFinite(location?.longitude))throw httpError(502,"Wetterstandort konnte nicht ermittelt werden.");
  const now=new Date();
  const end=year===now.getUTCFullYear()?new Date(Date.now()-7*864e5).toISOString().slice(0,10):year+"-12-31";
  const u=new URL("https://archive-api.open-meteo.com/v1/archive");
  for(const [k,v] of Object.entries({latitude:location.latitude,longitude:location.longitude,start_date:year+"-01-01",end_date:end,daily:"temperature_2m_mean",timezone:"Europe/Berlin",models:"era5_land"}))u.searchParams.set(k,String(v));
  const r=await fetchJsonWithTimeout(u.toString(),{headers:{accept:"application/json"}},{timeoutMs:20000,retries:1,label:"Wetterarchiv"});
  if(!r.response.ok)throw httpError(502,"Wetterhistorie konnte nicht geladen werden.");
  const days=r.payload?.daily?.time||[],temps=r.payload?.daily?.temperature_2m_mean||[],group=new Map();
  for(let i=0;i<days.length;i++){
    const key=String(days[i]).slice(0,7),temp=Number(temps[i]);
    if(!/^\d{4}-\d{2}$/.test(key)||!Number.isFinite(temp))continue;
    if(!group.has(key))group.set(key,{month:key,days:0,sum:0,hdd15:0});
    const x=group.get(key);
    x.days++;x.sum+=temp;x.hdd15+=Math.max(0,15-temp);
  }
  const months=[...group.values()].map(x=>({month:x.month,days:x.days,complete:x.days===new Date(Number(x.month.slice(0,4)),Number(x.month.slice(5,7)),0).getDate(),meanTemp:round(x.sum/x.days,2),hdd15:round(x.hdd15,2)}));
  return {year,provider:"Open-Meteo",model:"ERA5-Land",location:zip,baseTempC:15,cachedAt:new Date().toISOString(),complete:year<now.getUTCFullYear()&&months.length===12&&months.every(x=>x.complete),months};
}