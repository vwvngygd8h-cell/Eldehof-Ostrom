# Eldehof Ostrom Auth Fix

Ersetzt im bestehenden Cloudflare-Repository die bisherige `worker.js`.

Verbesserungen:

- entfernt versehentliche Leerzeichen an Client-ID und Client-Secret,
- testet Ostrom bereits bei „Verbinden und testen“,
- unterstützt zwei übliche OAuth-Übertragungsarten,
- zeigt den sicheren Ostrom-Fehlertext und HTTP-Status an,
- unterstützt `OSTROM_ENV=PRODUCTION` oder `SANDBOX`,
- zeigt bei erfolgreichem Test die erkannte Vertrags-ID.

Standardmäßig ist `OSTROM_ENV=PRODUCTION` gesetzt.
