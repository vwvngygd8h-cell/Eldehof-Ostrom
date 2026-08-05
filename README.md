# Eldehof 3.9.2 – Geräte-Kalibrierung

Geräteprofile können jetzt mit echten Einzelmessungen verbessert werden.

Pro Protokolleintrag bleiben getrennt erhalten:

- ursprünglicher Profil-Schätzwert
- gemessener Verbrauch
- tatsächliche Laufzeit
- Messquelle und optionale Notiz

Eldehof berechnet daraus:

- Median des Verbrauchs je Nutzung
- typische Laufzeit
- Abweichung zum aktuellen Profil
- Nutzungshäufigkeit aus dem lokalen 8-Wochen-Protokoll
- Vertrauensstufe nach Anzahl und Streuung der Messwerte

Ein Profil wird niemals automatisch verändert. Erst „Vorschlag ins
Profil übernehmen“ aktualisiert Verbrauch, Laufzeit oder Häufigkeit.
Bei echten Verbrauchsmessungen wird die Quelle anschließend als
„Messwert“ gekennzeichnet.

Alte Planerprotokolle bleiben kompatibel. Das private Backup enthält
die erweiterten Messfelder automatisch.

Aktive Version:

`3.9.2-GERAETEKALIBRIERUNG-20260806`
