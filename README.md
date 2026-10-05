# Eldehof 6.2.1 – Ostrom-Preisstatistik

Build: `6.2.1-OSTROM-PREISSTATISTIK-20261005`

Ergänzt Eldehof 6.2.0 um eine eigene Preisstatistik unter **Auswertung**.

## Neu

- durchschnittlicher Ostrom-Arbeitspreis je Monat
- verbrauchsgewichteter Durchschnitt je Quartal
- verbrauchsgewichteter Durchschnitt je Jahr
- zusätzlich effektiver ct/kWh-Wert inklusive monatlicher Fixkosten
- Monatsdiagramm für das gewählte Detailjahr
- Monats-Tabelle mit Ostrom-Verbrauch und Datenstatus
- Button **Ostrom-Preise aktualisieren** direkt in der Auswertung
- Preisstatistik wird in privatem Backup und Geräte-Sync mitgeführt

Die Berechnung nutzt die bereits vorhandene Ostrom-Monatsabfrage. Der Monats-Arbeitspreis basiert auf den von Ostrom gelieferten Stundenpreisen und dem tatsächlichen Ostrom-Verbrauch. Quartal und Jahr werden aus Kosten und Verbrauch gewichtet berechnet und nicht als einfacher Mittelwert der Monatswerte.

## Weiter enthalten

- Zählerstände Gesamt + Altenteil
- myVAILLANT-CSV-Import
- automatische Berechnung Schlee/Klus
- Monatsbearbeitung
- Geräte-Sync
- Mehrjahresvergleich Verbrauch
- Ostrom-Livepreis sowie bestes/schlechtestes Zeitfenster
- historische Ostrom-Preise

Die Durable-Object-Migration bleibt unverändert `v5-1-0-sync`.
