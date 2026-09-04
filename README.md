# Eldehof 6.0 – Verbrauchsbuch

Build: `6.0.0-VERBRAUCHSBUCH-20260904`

Eldehof 6.0 reduziert die Oberfläche auf vier klare Bereiche:

- **Übersicht** – letzter dokumentierter Monat, Ostrom-Preisübersicht und Verbrauchsverlauf
- **Verbrauch** – Monatswerte erfassen und bearbeiten
- **Auswertung** – Aufteilung, Jahresvergleich, Kosten und optionale Wärmepumpen-Arbeitszahl
- **Daten** – Datenqualität, Backup/Import/CSV, Ostrom-Verbindung und Kosten-Fallbacks

## Datenkompatibilität

Die vorhandenen Monatswerte bleiben unter `eldehof-v3-records` kompatibel. Vorhandene Vaillant-Monatsdaten unter `eldehof-v3-vaillant-months-v380` werden nicht gelöscht. Bestehende Ostrom-Einstellungen aus `eldehof-v3-settings` werden weiterverwendet.

Beim Speichern eines Monats wird der vorherige Monatsbestand zusätzlich als lokale Schattenkopie gesichert. Ein leerer Startzustand wird nicht automatisch über vorhandene Monatsdaten geschrieben. Wird ein leerer Primärspeicher bei vorhandener Schattenkopie erkannt, erscheint eine Wiederherstellungsoption.

## Ostrom auf der Übersicht

Angezeigt werden:

- aktueller Preis
- bestes Preiszeitfenster
- schlechtestes Preiszeitfenster

Die Fensterlänge ist unter **Daten → Ostrom** auf 1–4 Stunden einstellbar. Der vorhandene Eldehof-App-Schlüssel wird lokal weiterverwendet.

## Cloudflare

Die bestehende Durable-Object-Migration bleibt unverändert:

`v5-1-0-sync`

Der alte Sync-Backendcode bleibt aus Sicherheits-/Migrationsgründen im Worker erhalten, ist in der 6.0-Oberfläche aber nicht mehr sichtbar.

## Deployment

Die fünf Dateien dieses Pakets in das bestehende Cloudflare-Worker-Projekt übernehmen und deployen. Bestehende Secrets nicht löschen.

Version prüfen:

`https://eldehof.6wdkh7ysv2.workers.dev/api/version?check=600`

Erwarteter Build:

`6.0.0-VERBRAUCHSBUCH-20260904`
