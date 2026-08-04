# Eldehof 3.1 – Ostrom

Dieses Repository wird über **Cloudflare Pages mit Git-Integration** bereitgestellt.

## Kein Build-Prozess

- Framework preset: None
- Build command: leer lassen
- Build output directory: `.`
- Production branch: `main`

Die Datei `_worker.js` ist eine Cloudflare-Pages-Function im Advanced Mode. Sie:
- liefert die statische Eldehof-App aus,
- lädt Ostrom-Preise,
- lädt Smart-Meter-Verbrauch,
- berechnet Monatsverbrauch, verbrauchsgewichteten Preis und Kosten,
- schützt alle API-Aufrufe mit `ELDEHOF_APP_KEY`.

## Cloudflare Secrets

Unter `Settings → Variables and Secrets` verschlüsselt anlegen:

- `OSTROM_CLIENT_ID`
- `OSTROM_CLIENT_SECRET`
- `ELDEHOF_APP_KEY`

Optional:
- `OSTROM_CONTRACT_ID` bei mehreren Verträgen

Normale Variable:
- `OSTROM_ZIP_CODE` = `19306`

Keine Secret-Werte in GitHub-Dateien eintragen.

## Datenschutz

Die App enthält keine persönlichen Verbrauchsdaten. Monatswerte und der App-Schlüssel werden lokal im Safari-Speicher abgelegt. Die Ostrom-Secrets liegen ausschließlich verschlüsselt in Cloudflare.
