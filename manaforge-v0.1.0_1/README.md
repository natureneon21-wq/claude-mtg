# Manaforge – app folder

This folder contains the deployed Manaforge Progressive Web App (version 0.5.0), served via GitHub Pages:

**https://natureneon21-wq.github.io/claude-mtg/manaforge-v0.1.0_1/**

| File | Purpose |
|---|---|
| `index.html` | Markup, styles and the 16 themes |
| `app.js` | Application logic: import, Scryfall, scanner, deck builder, Gemini, UI |
| `sw.js` | Service worker for offline use and updates |
| `manifest.webmanifest` | PWA manifest (name, icons, colours) |
| `icons/` | App icons |

> The folder name is kept for compatibility: renaming it would change the app URL and break existing installations.

See the [main README](../README.md) for features, installation and documentation, and the [changelog](../CHANGELOG.md) for the version history.

## Deploying an update

Upload the changed files (usually `index.html`, `app.js` and `sw.js`) to this folder and commit to `main`. GitHub Pages redeploys within about a minute; installed apps pick up the new version the next time they are opened online.
