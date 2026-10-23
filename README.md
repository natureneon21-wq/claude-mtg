<p align="center">
  <img src="docs/banner.png" alt="Manaforge – scan, collect and build Magic: The Gathering decks" width="100%">
</p>

<p align="center">
  <a href="https://natureneon21-wq.github.io/manaforge/"><b>▶ Open the live app</b></a>
  &nbsp;·&nbsp; <a href="#features">Features</a>
  &nbsp;·&nbsp; <a href="#installation">Installation</a>
  &nbsp;·&nbsp; <a href="#how-it-works">How it works</a>
  &nbsp;·&nbsp; <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.5.1-d6b26a">
  <img alt="Platform" src="https://img.shields.io/badge/platform-PWA%20%C2%B7%20Android%20%C2%B7%20iOS-3e8ed6">
  <img alt="No build step" src="https://img.shields.io/badge/build-none%20(vanilla%20JS)-2f9e5a">
  <img alt="Status" src="https://img.shields.io/badge/status-prototype-e0563f">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-a59cb5"></a>
</p>

---

**Manaforge** is a mobile-first web app for *Magic: The Gathering* players. It imports your collection from ManaBox (or scans cards with the phone camera), keeps it organised in folders, and suggests playable decks built **only from the cards you physically own** – with an optional Gemini-powered AI deck builder on top.

It runs entirely in the browser, can be installed to the home screen like a native app, works offline and stores all data locally on your device.

> The user interface is currently in **German**.

<p align="center">
  <img src="docs/screenshots.png" alt="Screenshots: theme picker, deck suggestions, deck view, folders" width="100%">
</p>

## Features

### 📦 Collection
- **ManaBox CSV import** – binders become folders automatically; re-importing keeps your folder assignments
- **Text list import** – paste deck lists from MTG Arena, Moxfield, Archidekt or MTGO
- **Folders & set view** – custom folders, multi-select, move a whole set into a folder with one tap
- **Digital folders** for MTG Arena, kept separate from your paper collection, value and deck building
- **Card detail view** – swipe through cards, edit quantities, move copies between folders
- **Card language** – show cards as scanned, always German or always English (localised names, text and images via Scryfall)
- **Collection value** – Cardmarket (€), TCGplayer ($), Cardhoarder (tix) or your own purchase price; foil prices, shop links, weekly price refresh

### 📷 Card scanner
- Built-in camera scanner with **on-device OCR** (Tesseract.js) – no account, no upload
- Reads **collector number, set code and language** from the card's bottom line and cross-checks the **card name** → the exact printing in the correct language
- Continuous scanning with haptic feedback, undo, “+1”, target folder, foil toggle and set lock
- Optional **Gemini vision fallback** for older cards and special frames

### 🃏 Deck building
- Formats: Casual 60, Standard, Pioneer, Modern, Pauper, Limited 40 – plus Historic, Timeless, Explorer and Alchemy for Arena folders
- Mono-colour, two-colour or all combinations; Aggro, Midrange, Control or automatic
- Considers mana curve, creature count, removal, card draw, tribal synergies and land base – and never uses more copies than you own
- **Build around a card**, build only from selected folders, legality checks
- **Gemini AI** (optional, bring your own free API key): AI-built decks with strategy, play tips and mulligan advice; deck analysis with one-tap swap suggestions
- Export to ManaBox, Moxfield, Archidekt and MTG Arena; warns when a card is used in more saved decks than you own copies

### 🎨 Themes
- **16 themes** – six mono-colour themes and one for each two-colour guild, each with its own typography, textures, animated particles and hand-drawn, animated edge decorations (nodding characters, swaying mushrooms, fluttering fairies …) that fade towards the centre
- Optional **card art backgrounds**, picked from your own collection
- Decks automatically open in the theme of their colours, headed by the art of their strongest card

### 💾 Data & privacy
- Everything is stored locally (IndexedDB) – no server, no account
- JSON **backup & restore** (download or share to e.g. Google Drive)
- Network requests only go to Scryfall (card data) and – if you enable it – the Gemini API

## Installation

Manaforge is a Progressive Web App and needs no app store.

| Platform | Steps |
|---|---|
| **Android** (Chrome) | Open the [live app](https://natureneon21-wq.github.io/manaforge/) → menu **⋮** → **Install app** / **Add to home screen** |
| **iPhone / iPad** (Safari) | Open the live app → **Share** → **Add to Home Screen** |
| **Desktop** (Chrome / Edge) | Open the live app → install icon in the address bar |

Updates are picked up automatically the next time the app is opened online.

### Getting your collection in
1. **ManaBox:** *Collection* → **⋮** → *Export* → *CSV*, then import the file in Manaforge.
2. **Scan:** tap the 📷 button in the collection view.
3. **MTG Arena:** create a 🎮 digital folder, export a deck in Arena and use *“Liste einfügen”* (paste list).

### Optional: Gemini AI
Create a free API key in [Google AI Studio](https://aistudio.google.com/apikey) and paste it under *Einstellungen → Gemini*. The key never leaves your device except for requests to Google. Note that Google may use free-tier requests to improve its models.

## How it works

```
ManaBox CSV / text list / camera
              │
              ▼
   Scryfall API ──► card data, prices, localised printings, art
              │
              ▼
   IndexedDB (local) ──► collection · folders · decks · settings
              │
      ┌───────┴────────┐
      ▼                ▼
 deck builder     Gemini (optional)
 (heuristics)     AI build & analysis
```

- **Scanner pipeline:** camera frame → card edge detection → three OCR passes in parallel (bottom info line + two name crops) → Scryfall lookup by set / number / language → name verification. Unsure results need a second identical read or a confirmation; failures fall back to Gemini vision or manual search.
- **Deck builder:** each card gets a base score (popularity, rarity, removal, card advantage, stats), adjusted by archetype; a greedy builder fills curve and creature targets with tribal/theme synergy bonuses, then adds dual lands and basics proportional to colour pips. All colour combinations and archetypes are ranked by a neutral score.
- **AI builder:** Gemini only receives the list of cards you own; every returned card is validated against your collection and the deck is repaired to the exact format size.

## Tech stack

- Vanilla JavaScript, HTML and CSS – no framework, no build step
- Progressive Web App (manifest + service worker, offline-capable)
- IndexedDB for storage
- [Scryfall API](https://scryfall.com/docs/api) for card data and images
- [Tesseract.js](https://github.com/naptha/tesseract.js) for on-device OCR
- [Gemini API](https://ai.google.dev/) (optional) for AI deck building, analysis and scan fallback
- Google Fonts (Cinzel, Inter, Uncial Antiqua, Pirata One, Metamorphous, Marcellus, Cormorant Garamond, Grenze Gotisch, Almendra, Cinzel Decorative)

## Project structure

```
index.html             markup, styles and the 16 themes
app.js                 all application logic
sw.js                  service worker (offline cache)
manifest.webmanifest   PWA manifest
icons/                 app icons
docs/                  images used in this README
CHANGELOG.md           version history
LICENSE                MIT license
```

The repository root is served directly via GitHub Pages – every commit to `main` is live within about a minute.

## Local development

No tooling is required – serve the repository with any static web server:

```bash
git clone https://github.com/natureneon21-wq/manaforge.git
cd manaforge
python3 -m http.server 8080
# open http://localhost:8080
```

The camera scanner and installation require HTTPS (or `localhost`).

## Roadmap

- Commander support (100 cards, colour identity, commander selection)
- Share CSV files directly from ManaBox into the app (Web Share Target)
- English UI
- Packaged Android build (APK)

## Credits

- Card data and images: [Scryfall](https://scryfall.com) – card art © the respective artists and Wizards of the Coast
- OCR: [Tesseract.js](https://github.com/naptha/tesseract.js)
- Developed as an AI-assisted development experiment together with Claude (Anthropic)

## License

The source code is released under the [MIT License](LICENSE). Card data, card images and card art are not covered by this license – they belong to their respective owners (see below).

## Legal

Manaforge is unofficial Fan Content permitted under the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

Manaforge is not affiliated with ManaBox, Scryfall, Cardmarket, TCGplayer, Cardhoarder or Google.
