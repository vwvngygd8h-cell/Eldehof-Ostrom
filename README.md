# Eldehof 3.6.4 – Abschnittsanalyse

Die Langzeitanalyse wird nicht mehr in einem einzigen großen
Cloudflare-/Ostrom-Aufruf berechnet.

Stattdessen:

- Der gewählte Zeitraum wird in feste 7-Tage-Abschnitte zerlegt.
- Die App lädt einen Abschnitt nach dem anderen.
- Fortschritt erscheint als `Abschnitt 2/5`.
- Jeder erfolgreiche Abschnitt wird sofort lokal gespeichert.
- Ein langsamer Abschnitt wird übersprungen; andere Ergebnisse bleiben.
- Der Abbrechen-Button beendet den aktuellen Abschnitt und die Schleife.
- 30 Tage benötigen ungefähr fünf kleine API-Aufrufe.

Neue API:

`/api/history-chunk?startDate=...&endDate=...`

Aktive Version:

`3.6.4-ABSCHNITTSANALYSE-20260805`
