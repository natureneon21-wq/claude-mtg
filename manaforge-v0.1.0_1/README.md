# Manaforge – Prototyp v0.3.0

PWA zum Import von ManaBox-CSV-Exporten und zum Deckbau aus der eigenen Sammlung.

## Installation aufs Handy (GitHub Pages, kostenlos)
1. Neues öffentliches Repo auf github.com anlegen (z. B. `manaforge`).
2. Alle Dateien aus diesem Ordner hochladen („Add file → Upload files“).
3. Settings → Pages → Branch `main`, Ordner `/ (root)` → Save.
4. Nach ca. 1 Minute läuft die App unter `https://<name>.github.io/manaforge/`.
5. Auf dem S26 in Chrome öffnen → Menü ⋮ → „Zum Startbildschirm hinzufügen“ / „App installieren“.

Updates: geänderte Dateien ins Repo hochladen; die App lädt beim nächsten Öffnen die neue Version.

## Dateien
- `index.html` – Oberfläche & Styles
- `app.js` – Logik (CSV-Import, Scryfall, Deckbau-Algorithmus, Gemini)
- `sw.js`, `manifest.webmanifest`, `icons/` – Installierbarkeit & Offline

Daten: Scryfall API (Kartendaten/Bilder), optional Gemini API (eigener Key aus Google AI Studio).

## Neu in v0.3.0
- Eigener Kartenscanner (📷 in der Sammlung): Texterkennung auf dem Gerät liest Sammlernummer, Set-Code, Sprache und Namen; Abgleich mit Scryfall; Gemini-Foto-Erkennung als Fallback
- Dauerscan mit Vibration, Rückgängig, „+1 Nochmal“, Ziel-Ordner, Foil-Schalter, Set festlegen, manuelle Suche
- Texterkennung (Tesseract.js, ca. 7 MB) wird beim ersten Scan einmalig von jsDelivr geladen und dann gecacht

## Neu in v0.2.0
- Backup: Sammlung, Ordner, Decks & Einstellungen als JSON sichern/teilen und wiederherstellen
- Ordner (eigene + automatisch aus ManaBox-Bindern), Set-Ansicht, Mehrfachauswahl
- Kartenansicht: durch Karten wischen, Anzahl ändern, Exemplare in Ordner verschieben
- Kartensprache: Wie gescannt / Deutsch / Englisch
- Deckbau nur aus ausgewählten Ordnern

## Update einspielen
Im Repo in den App-Ordner gehen → „Add file“ → „Upload files“ → `index.html`, `app.js`, `sw.js` (und `README.md`) hineinziehen → „Commit changes“. Gleichnamige Dateien werden überschrieben.
