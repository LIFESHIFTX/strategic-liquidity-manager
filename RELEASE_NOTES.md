# Release Notes

## v1.4.1

**Release Candidate für die öffentliche Distribution**

### Strategisches Liquiditätsmodell

- persönlicher monatlicher Liquiditätsbedarf
- Zielreichweite für Topf 3
- konfigurierbarer Multiplikator für Topf 2
- Ist-/Sollwerte und Deckungsgrade
- Fehlbetrag bzw. Überschuss
- Reichweite von Topf 2 und Topf 3 in Monaten
- Reichweite von Topf 1 bei Liquidierung zum aktuellen Marktwert
- einheitliche Darstellung der Zielkennzahlen

### Profile und Parqet-Portfolios

- mehrere lokale Profile
- mehrere Parqet-Portfolios pro Profil
- automatische Aktualisierung beim Profilwechsel
- Positionszuordnung zu Topf 1, 2 oder 3

### Futures und Kredite

- manuelle Futures mit Eigenkapital, Exposure und P&L
- Kreditlinien und Kredite
- Firefish-spezifische Kreditparameter
- freie Kreditliquidität als separate Kennzahl

### Backup und Restore

- Export der lokalen Konfiguration
- Wiederherstellung profilbezogener Einstellungen
- Zielmodell- und Firefish-Parameter werden korrekt restauriert

### Distribution und Usability

- Linux-x64-Distribution (`.deb` und `.tar.gz`)
- Windows-x64-Standalone-Distribution (`.zip`)
- Node.js ist in den Endanwender-Distributionen nicht erforderlich
- kontrollierter Anwendungsshutdown unter Linux und Windows
- Neustart ohne Betriebssystem-Reboot
- scrollbar begrenzte Positionsliste im Verwaltungsbereich
- überarbeitete Reihenfolge der Verwaltungselemente

### Parqet und Datenschutz

- OAuth 2.0 Authorization Code Flow mit PKCE
- ausschließlich `portfolio:read`
- keine Schreibrechte in Parqet
- lokale Speicherung der SLM-Daten
- kein eigener SLM-Cloud-Dienst und kein zusätzliches Benutzerkonto

### Bekannte Hinweise

- SLM verwendet den Standardbrowser als Benutzeroberfläche.
- Ein erneuter Start der Anwendung kann einen weiteren Browser-Tab öffnen.
- Das Schließen eines Browser-Tabs beendet den lokalen Server nicht; dafür ist **Verwaltung → Anwendung beenden** vorgesehen.
