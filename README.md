# Eldehof 3.6.3 – Harter Timeout

Diese Version beseitigt das endlose Warten auf zwei Ebenen:

- Jeder Ostrom-Subrequest wird mit `Promise.race` hart begrenzt.
  Der Worker kehrt zurück, auch wenn `AbortController.abort()` den
  eigentlichen Netzwerkabruf nicht sofort beendet.
- Der sichtbare Sekundenzähler beendet die App-Analyse selbstständig.
  Für 30 Tage geschieht das spätestens nach 60 Sekunden.
- Der Abbrechen-Button besitzt zusätzlich einen direkten Aufruf.
- Im Analysebereich steht sichtbar `App 3.6.3`, damit Frontend und
  Worker getrennt geprüft werden können.
