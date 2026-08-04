# Eldehof – Ostrom 404 Vertragsfix

Der Verbindungstest prüft jetzt nur noch die OAuth-Anmeldung. Die Vertragsnummer wird beim Laden eines Monats verwendet.

Empfohlene Cloudflare-Secrets:

- OSTROM_CLIENT_ID
- OSTROM_CLIENT_SECRET
- ELDEHOF_APP_KEY
- OSTROM_CONTRACT_ID

`OSTROM_CONTRACT_ID` ist deine Ostrom-Vertragsnummer. Sie verhindert den fehlerhaften automatischen Abruf der Vertragsliste.
