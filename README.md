# Eldehof 5.1.1 – Konfliktzentrale & zuverlässige Synchronisierung

5.1.1 erweitert das verschlüsselte 5.1.0-Sync-Fundament um einen lokalen
Drei-Wege-Abgleich. Eldehof vergleicht den letzten gemeinsamen Stand mit dem
aktuellen lokalen und dem aktuellen entfernten Datenpaket.

- Änderungen an unterschiedlichen Datensätzen werden automatisch verbunden.
- Widersprüchliche Änderungen am selben Feld bleiben in der Konfliktzentrale.
- Jede Einzelentscheidung kann lokal oder entfernt gewählt werden.
- Eine abgeleitete Offline-Warteschlange vermeidet doppelte Paketwirkungen.
- Ein begrenztes lokales Protokoll und technische Serverrevisionen zeigen den
  Ablauf, ohne Schlüssel oder Klartext an Cloudflare zu übertragen.
- Beim Öffnen kann Eldehof prüfen, wenn die App aktiv und der Schlüssel für die
  Sitzung entsperrt ist.

Die bestehende Durable-Object-Migration `v5-1-0-sync` bleibt unverändert.
Eine permanente Hintergrundsynchronisierung wird weiterhin nicht versprochen.

Aktive Version: `5.1.1-KONFLIKTZENTRALE-20260806`
