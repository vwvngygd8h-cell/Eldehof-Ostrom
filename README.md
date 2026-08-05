# Eldehof 3.6.2 – Abbruch- und Gesamtzeit-Fix

Behebt den wirkungslosen Abbrechen-Button und endlos wirkende Analysen.

- Der Abbruch beendet die Oberfläche sofort.
- Eine verspätete Serverantwort wird verworfen.
- 30 Tage haben serverseitig etwa 65 Sekunden Gesamtzeit.
- Einzelne History-Abrufe haben höchstens 16 Sekunden und keinen Retry.
- Vorhandene Teildaten werden ausgewertet statt verworfen.

Aktive Version:

`3.6.2-ABBRUCH-GESAMTZEIT-20260805`
