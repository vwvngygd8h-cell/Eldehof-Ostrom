# Eldehof 3.8.1 – Monatsassistent & Plausibilitätsprüfung

Der neue Monatsassistent führt in vier Schritten durch den Abschluss:

1. Abrechnungsmonat wählen und Ostrom automatisch laden
2. Wärmepumpenstrom und erzeugte Wärme aus myVAILLANT prüfen
3. nur den Verbrauch des Altenteils bestätigen
4. Ergebnis, Vormonatsvergleich und Plausibilität prüfen

Automatische Vorbelegung:

- zuletzt abgeschlossener Kalendermonat
- bestehender Ostrom-/Monatsdatensatz
- bereits gespeicherte Vaillant-Werte
- Altenteilwert des direkten Vormonats als sichtbarer Vorschlag
- vorhandene Notiz und Abschlussstatus

Geprüft werden:

- alle Pflichtwerte
- keine negativen Verbräuche
- Ostrom Gesamt >= Wärmepumpe + Altenteil
- Arbeitszahl auf auffällige Werte
- Summe Heizung + Warmwasser gegen Vaillant-Gesamt
- Vergleich mit dem Vormonat
- Vergleich des Gesamtverbrauchs mit dem Vorjahresmonat
- Ostrom-Arbeitspreis und Fixkosten
- laufender oder zukünftiger Monat

Der Entwurf wird ausschließlich lokal gespeichert und kann nach dem
Schließen fortgesetzt werden.

Aktive Version:

`3.8.1-MONATSASSISTENT-20260805`
