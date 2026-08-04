# Eldehof – Cloudflare Build Fix

Dieser Fix passt zum bereits eingerichteten Cloudflare **Workers Build** mit dem Deploy-Befehl:

`npx wrangler deploy`

## Enthalten

- `worker.js`: Ostrom-Backend und vollständige Eldehof-App in einer sicheren Worker-Datei
- `wrangler.jsonc`: eindeutige Deployment-Konfiguration

Es gibt absichtlich kein `assets`-Verzeichnis und keine `_worker.js`-Assetdatei. Damit kann Wrangler den Servercode nicht versehentlich als öffentliche statische Datei hochladen.

## Cloudflare

- Build command: leer
- Deploy command: `npx wrangler deploy`
- Root directory: leer beziehungsweise Repository-Wurzel
- Secrets bleiben im Cloudflare-Dashboard:
  - `OSTROM_CLIENT_ID`
  - `OSTROM_CLIENT_SECRET`
  - `ELDEHOF_APP_KEY`

`OSTROM_ZIP_CODE=19306` ist bereits in `wrangler.jsonc` enthalten.
