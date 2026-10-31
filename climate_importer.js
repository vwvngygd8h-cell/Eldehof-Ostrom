  async function importVaillantCsvFiles(fileList){
    const files=[...(fileList||[])];if(!files.length)return;
    setStatus("vaillantImportStatus","Dateien werden lokal geprüft …");
    try{
      const parsed=[];for(let i=0;i<files.length;i++)parsed.push(parseVaillantCsvText(await files[i].text(),i));
      const hasAro=parsed.some(x=>x.type==="arotherm-energy"),hasUni=parsed.some(x=>x.type==="unitower-energy");
      if(hasAro!==hasUni)throw Error("Tägliche Energiewerte nur mit aroTHERM und uniTOWER gemeinsam importieren.");
      const daily=hasAro&&hasUni?buildVaillantImportPreview(parsed):{months:[]};
      const map=new Map(monthlyVaillantImports(parsed).map(x=>[x.month,x]));
      for(const row of daily.months.filter(x=>!x.blocked))map.set(row.month,row);
      const months=[...map.values()],temp=climatePreview(parsed);
      if(!months.length&&!temp.length)throw Error("Keine importierbaren Energiewerte oder Temperaturdateien erkannt.");
      const skipped=daily.months.filter(x=>x.blocked).length;
      if(!confirm(months.length+" Energiemonate und "+temp.length+" Temperaturmonate übernehmen? "+(skipped?skipped+" Energie-Monate werden wegen unvollständiger oder widersprüchlicher Daten übersprungen. ":"")+"Zählerstände, Ostrom-Preise und Notizen bleiben unverändert."))return;
      if(months.length)mergeVaillantImport(months);
      if(temp.length)climateImport(temp);
      renderAll();
      setStatus("vaillantImportStatus",months.length+" Energie-Monate und "+temp.length+" Temperatur-Monate importiert","ok");
      toast("Vaillant-Daten importiert");
    }catch(error){setStatus("vaillantImportStatus",error.message,"error");}
    finally{$("vaillantCsvFilesInput").value="";}
  }
