# Eldehof 3.6.1 – Analyse stabil

Behebt eine Langzeitanalyse, die dauerhaft bei „Analysiert …“ stehen bleiben konnte.

Änderungen:
- jede Ostrom-Anfrage hat ein festes Zeitlimit und einen Wiederholungsversuch,
- Monatsabschnitte werden stabil nacheinander verarbeitet,
- fehlende Preisdaten blockieren die Verbrauchsanalyse nicht mehr,
- echte Laufzeitanzeige mit Sekunden,
- Abbrechen-Schaltfläche,
- Fehlermeldungen bleiben sichtbar,
- Diagnosewerte zu Dauer, Monatsabschnitten und Teilfehlern,
- neuer Service-Worker-Cache gegen alte PWA-Dateien.
