# Eldehof 6.2.0 – Geräte-Sync, Jahresvergleich & Ostrom-Historie

Neu:
- verschlüsselter automatischer Geräte-Sync über den bereits vorhandenen Eldehof-Durable-Object-Tresor
- auf App-Start, Rückkehr in die App und während aktiver Nutzung wird der neueste Stand geladen
- Änderungen an Monatswerten, Zählerständen, Vaillant-Daten und relevanten Ostrom-Einstellungen werden automatisch hochgeladen
- weitere Geräte werden einmalig über einen Kopplungsschlüssel verbunden
- Jahresvergleich zeigt alle vorhandenen Jahre gleichzeitig; aktuelles Jahr durchgezogen, vergangene Jahre farbig gestrichelt
- historische Ostrom-Preise/Kosten können für alle verfügbaren Monate nachgeladen werden; stündliche Preise werden mit stündlichem Verbrauch gewichtet
- Monatsgrenzen für Ostrom werden in Europe/Berlin berechnet (inkl. Sommer-/Winterzeit)

Die bestehende Durable-Object-Migration bleibt unverändert `v5-1-0-sync`.
