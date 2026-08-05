# Eldehof 3.9 – Wärmepumpen- & Wetteranalyse

Diese Version erweitert den lokalen myVAILLANT-Import um dauerhaft gespeicherte Monatsaggregate aus den Temperatur- und Systemexporten.

Gespeichert werden ausschließlich Monatswerte:

- Außentemperatur: Mittelwert, Minimum, Maximum und Anzahl Messpunkte
- Raumtemperatur: Mittelwert, Minimum und Maximum
- Raum-Solltemperatur und manueller Sollwert: Monatsmittel
- Warmwasserspeicher: Mittelwert, Minimum und Maximum

Rohzeilen, Dateinamen, Kommentarzeilen und Seriennummern werden nicht gespeichert.

Die Analyse zeigt:

- Wärmepumpenstrom und erzeugte Wärme
- gewichtete Gesamtarbeitszahl
- getrennte Arbeitszahlen für Raumheizung und Warmwasser
- Warmwasseranteil am Wärmepumpenstrom
- Umweltwärme im Analyse-CSV
- Vergleich zum Vorjahresmonat
- wetterbewussten Vergleich bei ähnlicher Außentemperatur
- statistischen Zusammenhang zwischen Außentemperatur und Heizstrom
- beste und schwächste Monatsarbeitszahl

Aktive Version:

`3.9-WAERMEPUMPEN-WETTERANALYSE-20260806`
