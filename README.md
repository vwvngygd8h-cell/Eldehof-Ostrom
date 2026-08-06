# Eldehof 5.1.0 – Privates Synchronisierungsfundament

Neu ist ein manueller Geräteabgleich über einen SQLite-basierten Cloudflare
Durable Object. Eldehof verschlüsselt das Datenpaket bereits im Browser mit
AES-GCM. Der Schlüssel wird mit HKDF-SHA-256 aus einem separaten
Wiederherstellungsschlüssel abgeleitet.

Der Server erhält nicht:

- Wiederherstellungsschlüssel oder Klartextdaten
- Ostrom- und API-Schlüssel
- Familien-PIN, PIN-Hash oder Salt
- private Backup- oder Roh-CSV-Dateien
- Seriennummern und ausführliche Monatsnotizen

5.1.0 synchronisiert bewusst nur manuell. Bei voneinander abweichenden lokalen
und entfernten Änderungen stoppt Eldehof und verlangt eine Entscheidung. Eine
automatische Zusammenführung auf Datensatzebene folgt erst mit 5.1.1.

Aktive Version: `5.1.0-SYNC-FUNDAMENT-20260806`
