# Eldehof 3.8 – Wärmepumpen-Automatik

## Sofort nutzbar

- Vaillant-Monatswerte lokal aus der myVAILLANT-App erfassen
- Wärmepumpenstrom und erzeugte Wärme speichern
- Arbeitszahl automatisch berechnen
- Heizung und Warmwasser optional getrennt erfassen
- Monatswerte um Vaillant-Daten ergänzen
- Schnellabschluss: nur noch Altenteil eingeben
- Gesamt, Tarif und Fixkosten automatisch von Ostrom abrufen
- Übriges Haus automatisch berechnen:
  `Ostrom Gesamt - Vaillant Wärmepumpe - Altenteil`
- Backup und CSV enthalten Wärmemenge, Arbeitszahl und Datenquelle
- Warnung bei niedriger Wärmepumpen-Arbeitszahl

## Offizielle Live-Anbindung

Der direkte produktive Vaillant-Zugriff wird erst nach Freigabe der
offiziellen Energy Management API aktiviert. Eldehof enthält dafür einen
sicheren, nur lesenden Adapter.

Cloudflare-Konfiguration nach Bereitstellung eines offiziellen Adapters:

- Secret/Variable `VAILLANT_DATA_URL`
  - HTTPS-URL
  - `{month}` kann als Platzhalter verwendet werden
- optionales Secret `VAILLANT_DATA_TOKEN`

Erwartetes Antwortformat steht in `vaillant-month-schema.json`.

Eldehof speichert:
- kein Vaillant-Passwort im Browser
- keine Seriennummer im Browser oder GitHub
- keine Vaillant-API-Zugangsdaten im Frontend

## API

- `/api/vaillant/status`
- `/api/vaillant/month?month=YYYY-MM`

Aktive Version:

`3.8-WAERMEPUMPEN-AUTOMATIK-20260805`
