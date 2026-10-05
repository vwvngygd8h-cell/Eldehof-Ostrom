# Eldehof 6.0.1 – Verbrauchsbuch

Schlanke Verbrauchsdokumentation mit Ostrom-Preisübersicht.

Neu in 6.0.1:
- lokaler Import der exportierten myVAILLANT-CSV-Dateien (aroTHERM + uniTOWER)
- vollständige Monate sowie der aktuelle Teilmonat können übernommen werden
- vorhandene Werte für Gesamtverbrauch, Altenteil, Preis, Fixkosten und Notiz bleiben erhalten
- historische unvollständige oder widersprüchliche Monate werden nicht automatisch übernommen
- Ostrom aktualisiert bei aktivierter Automatik alle 10 Minuten, solange die App aktiv ist
- nach Rückkehr in die App wird sofort aktualisiert, wenn die Daten älter als 10 Minuten sind

Die Monatsdaten bleiben unter `eldehof-v3-records`, die Vaillant-Monatsdaten unter `eldehof-v3-vaillant-months-v380` kompatibel.
Die Durable-Object-Migration bleibt `v5-1-0-sync`.
