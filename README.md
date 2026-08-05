# Eldehof 3.6.5 – Vorbereitungs-Fix

Behoben wird der Zustand:

`Abschnitt 0/5 • Vorbereitung • 0 geladen`

Ursache:
Der Fortschritts-Renderer aktualisierte zunächst die Anzeige, lief danach
aber weiter und griff auf `historyData.summary` zu. Nach einer zuvor
fehlgeschlagenen Analyse war `historyData` leer. Der JavaScript-Fehler
entstand vor Beginn der Abschnittsschleife; nur der Sekundenzähler blieb
aktiv.

Änderungen:

- Während einer laufenden Analyse beendet der Renderer seine Arbeit direkt
  nach der Fortschrittsanzeige.
- Die Anzeige startet unmittelbar mit `Abschnitt 1/5`.
- Der alte, inkompatible Analyse-Ergebniscache wird nicht mehr geladen.
- Zusätzliche Null-Prüfungen schützen die Diagramme.
- Der Worker-Endpunkt der 7-Tage-Abschnittsanalyse bleibt unverändert.
