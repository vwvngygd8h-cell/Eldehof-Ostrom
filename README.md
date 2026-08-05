# Eldehof 3.8.3.1 – CSV-Präzisions-Hotfix

Der Hotfix behebt das Springen zum Feld „Erzeugte Wärme“, wenn ein
importierter Monatswert erneut gespeichert wird.

Ursache:

- myVAILLANT-CSV-Werte besitzen drei Nachkommastellen
- das bisherige Monatsformular erlaubte nur 0,1- oder 1-kWh-Schritte
- Safari blockierte den Submit vor Eldehofs eigener Validierung

Korrektur:

- relevante Energie- und Wärmefelder akzeptieren 0,001 kWh
- Monats- und Vaillant-Formulare verwenden Eldehofs eigene Prüfung
- CSV-Import, Ostrom-Daten und bestehende Monatswerte bleiben erhalten

Aktive Version:

`3.8.3.1-CSV-PRAEZISIONS-HOTFIX-20260806`
