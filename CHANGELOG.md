# Changelog

Alle relevanten Änderungen seit Commit 6959d8ff2fee4b511c8c0f374716c2cc5bbf62bd.

## 2026-06-09

### build dashboard (ce9026793290b0c500fbefea62d4864a0a735c5c)

#### Geändert
- Dashboard-Frontend grundlegend aufgebaut und inhaltlich deutlich erweitert.
- Seitenstruktur in der Oberfläche neu organisiert (Panels, KPIs, Charts, Explore-Bereich, Methodik).
- Umfangreiche visuelle Überarbeitung der Startseite.

#### Entfernt
- Alte JavaScript-Implementierung in site/app.js entfernt.

#### Betroffene Dateien
- site/index.html
- site/app.js

### extend statistics (170fe7daa77e8e1d46781c3b6bdf3a748fe5f833)

#### Hinzugefügt
- Modulare Frontend-Architektur mit neuen Dateien:
  - site/js/app.js
  - site/js/charts.js
  - site/js/data.js
- Neue vorverarbeitete Datengrundlage für Zonen-Komposition:
  - site/data/composition.json
- Neue Auswertungen in der UI:
  - Aktivitätsmuster nach Wochentag und Tag des Monats
  - Tagesbezogene Kompositions-Analyse (Längenverteilung, erster Buchstabe)
  - Tages-Insights und Vergleich registriert vs. deregistriert
  - Zone-Composition-Panel als Baseline für den gesamten Bestand

#### Geändert
- scripts/build-stats.mjs erweitert:
  - Berechnung und Schreiben von composition.json
  - Fortlaufende Aktualisierung der Kompositionsdaten pro Lauf
  - Erweiterte Analyse-Logik für Label-Struktur (u. a. Länge, Histogramme, Quantile, Sonderzeichen-Muster)
- site/style.css umfangreich ausgebaut für neue Komponenten, Diagramme und Interaktionszustände.

#### Betroffene Dateien
- scripts/build-stats.mjs
- site/data/composition.json
- site/js/app.js
- site/js/charts.js
- site/js/data.js
- site/style.css

## Gesamtsumme seit 6959d8ff2fee4b511c8c0f374716c2cc5bbf62bd

- 2 Commits
- 8 geänderte Dateien
- 2530 Einfügungen
- 393 Löschungen
