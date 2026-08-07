# Eldehof 5.4.1 – Live-Cockpit & Schnellsteuerung

Neu auf „Heute“:
- Ostrom-Schieberegler; der gespeicherte App-Schlüssel bleibt beim Pausieren erhalten
- echter Status getrennt vom Schalter: Zugangsdaten fehlen / pausiert / aktualisiert / verbunden / offline / Fehler
- aktueller Preis, günstigstes und teures Zeitfenster mit nachvollziehbarer Preisampel
- Quellenfrische für Ostrom, Wetter, Smart Meter und Sync
- „Jetzt alles aktualisieren“; aktive Quellen werden unabhängig voneinander aktualisiert
- „Cockpit anpassen“ prominent sichtbar
- Diagramm-Favoriten jeweils kompakt oder groß
- letzter voller Smart-Meter-Tag als kurze Veränderungszeile
- Datenqualitätsfehler kann direkt den ersten betroffenen Monat öffnen
- Offline: letzter bekannter Stand bleibt sichtbar und wird ausdrücklich als offline/alt markiert

Der Ostrom-Schalter zeigt oder überträgt keine Zugangsdaten. Er steuert nur, ob dieses Gerät Ostrom-Live-Daten aktiv abfragt. Wetter und andere Worker-Funktionen können den vorhandenen Eldehof-App-Schlüssel weiterhin verwenden.

Keine Hintergrundgarantie bei geschlossener PWA. Keine Gerätesteuerung, keine erfundenen Messwerte und keine automatische Sync-Konfliktlösung.

Sync-Tresor und Durable-Object-Migration `v5-1-0-sync` bleiben unverändert.

Build: `5.4.1-LIVE-COCKPIT-20260807`
