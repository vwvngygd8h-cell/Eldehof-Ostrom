# Eldehof 5.0 – Familienmodus

Eldehof besitzt jetzt drei lokale Bedienebenen:

- Verwaltung: vollständige App
- Haushalt: einfache Tagesaufgaben mit großen Aktionen
- Nur ansehen: Tagesplan und Status ohne Änderungen

Der Verwaltungsbereich kann mit einer sechsstelligen lokalen PIN geschützt
werden. Die PIN wird nicht im Klartext gespeichert, sondern lokal mit
zufälligem Salt und SHA-256 geprüft.

Wichtig: Dies ist eine Oberflächensperre und keine Verschlüsselung. Personen
mit vollständigem Zugriff auf das Gerät, den Browser-Speicher oder
Entwicklerwerkzeuge können lokale Daten technisch weiterhin erreichen.

Im Alltagsmodus können bestätigte Tagesaufgaben gestartet, erledigt,
15 Minuten verschoben oder ausgelassen werden. „Erledigt“ wird ohne
Messwert gespeichert und zählt deshalb nicht als belastbar gemessene
Einsparung.

Es gibt keine Online-Konten, keine Cloud-Synchronisierung und keine Geräte-,
Wärmepumpen-, Speicher- oder Wallbox-Steuerung.

Aktive Version: `5.0-FAMILIENMODUS-20260806`
