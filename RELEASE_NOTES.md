# Release Notes

## v1.5.0

### Dashboard und Reichweite

- Gesamtreichweite über Topf 1 bis 3 auf Basis des persönlichen monatlichen Liquiditätsbedarfs
- Anzeige der Gesamtreichweite in Monaten und Jahren
- freie Kreditliquidität kann optional in die Gesamtreichweite einbezogen werden
- Kreditliquidität bleibt standardmäßig unberücksichtigt

### Übersicht Topf 1

- Gruppierung der Positionen nach Assetklasse
- separate Darstellung von Krypto, Wertpapieren, Rohstoffen, Cash und sonstigen Positionen
- Anzeige der jeweiligen Gruppensumme
- unbekannte Assettypen werden automatisch unter „Sonstige“ eingeordnet

### Update-Hinweis

- automatische Erkennung neuer SLM-Releases auf GitHub
- installierte Version wird direkt aus der Anwendungsversion ermittelt
- Hinweis auf eine neuere Version direkt im Header
- direkter Link zum verfügbaren GitHub-Release
- Update-Prüfung mit lokalem Cache und Timeout; die Nutzung von SLM bleibt bei nicht erreichbarem GitHub unbeeinträchtigt

### Wartung und Konsistenz

- veraltete interne und sichtbare „Risk Pots“-Bezeichnungen auf „Strategic Liquidity Manager“ vereinheitlicht
- npm-Paketname auf `strategic-liquidity-manager` vereinheitlicht
- portabler Windows-Buildpfad ohne benutzerspezifisches Verzeichnis
- deutsche Benutzertexte und Konsolenausgaben weiter vereinheitlicht
- bestehendes Backup-Format bleibt aus Kompatibilitätsgründen unverändert
- Installationsdokumentation aktualisiert und erfolgreicher Source-Installationsweg unter macOS und Linux dokumentiert

## v1.4.2

### Bugfixes

- verhindert veraltete Profildaten nach einem fehlgeschlagenen Profilwechsel
- bei nicht freigegebenen Parqet-Portfolios bleiben lokale Planungsdaten sichtbar, während Parqet-Istdaten leer bleiben
- verständlichere Hinweise bei fehlenden Portfolio-Berechtigungen
- konsistentes Verhalten zwischen getrenntem Parqet-Zustand und 403-Berechtigungsfehlern

### Dokumentation

- Desktop-Plattformen explizit dokumentiert
- Hinweis zum Reconnect nach vollständigem Parqet-Browser-Logout ergänzt

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
