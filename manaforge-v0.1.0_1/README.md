# Manaforge – Prototyp v0.1.0

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
