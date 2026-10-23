# Changelog

All notable changes to Manaforge are documented here.

## [0.5.1] – 2026-10-23
### Added
- Animated edge details in every theme: swaying mushrooms and ferns, a nodding and blinking mushroom character and a head-tilting owl (Mushroom Forest), fluttering fairies, flapping bats, clattering skulls, flickering flames, swimming fish, curling tentacles, spinning gears and runes, waving banners, pulsing cells and more
- Animations pause when background animations are switched off or the system prefers reduced motion
### Changed
- Theme decorations are stored more compactly (base64 instead of URL-encoded SVG)

## [0.5.0] – 2026-10-23
### Changed
- Repository renamed to `manaforge`; the app is now served from the repository root at https://natureneon21-wq.github.io/manaforge/ (existing installations need to be re-added; local data is kept)

### Added
- 16 themes: six mono-colour themes (Arcane Gold, Mushroom Forest, Grave Chant, Dragon Forge, Deep Sea, Cathedral) and one theme per two-colour guild
- Hand-drawn edge decorations per theme that fade towards the centre, plus animated particles (fireflies, leaves, embers, rain, spores, bubbles …)
- Card art backgrounds picked from your own collection (Scryfall art crops, with artist credit)
- Decks open in the theme of their colours, headed by the art of their strongest card
- Settings to toggle animations, card art and deck colour themes

## [0.4.0] – 2026-10-23
### Added
- Selectable price source: Cardmarket, TCGplayer, Cardhoarder or own purchase price (from ManaBox); foil prices, shop links, deck value, weekly price refresh
- Digital folders for MTG Arena, separate from the paper collection; Arena formats Historic, Timeless, Explorer and Alchemy
- Text list import (MTG Arena, Moxfield, Archidekt, MTGO), including Arena-specific set codes
- CSV import into a specific folder
- Option to place close/back controls at the bottom
### Fixed
- Full-screen views (scanner, deck) were cut off at the top on iPhones; safe areas for notch and Dynamic Island
- Collection tiles showed a single “FOIL” badge next to the total count when only some copies were foil
- Language hint when Scryfall has no localised version (e.g. most tokens)
- OCR could not be reloaded after a failed first start without restarting the app

## [0.3.0] – 2026-10-23
### Added
- Built-in card scanner: on-device OCR of collector number, set code, language and name, verified against Scryfall
- Continuous scanning with haptic feedback, undo, “+1”, target folder, foil toggle, set lock and manual search
- Gemini vision fallback for hard-to-read cards

## [0.2.0] – 2026-10-23
### Added
- JSON backup and restore, backup reminder
- Folders (custom and from ManaBox binders), set view, multi-select
- Card detail view with swiping, quantity editing and moving copies between folders
- Card language setting: as scanned / German / English
- Deck building from selected folders

## [0.1.0] – 2026-10-22
### Added
- First prototype: ManaBox CSV import with Scryfall enrichment
- Collection grid with search, colour/type filters and sorting
- Heuristic deck builder for Casual 60, Standard, Pioneer, Modern, Pauper and Limited 40
- Optional Gemini AI deck builder and deck analysis
- Saved decks, editing and export
- Installable PWA with offline support
