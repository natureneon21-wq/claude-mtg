'use strict';
/* Manaforge – MTG-Sammlung & Deckbau (Prototyp) */
const APP_VERSION = '0.5.0';

/* ============================================================
   Hilfsfunktionen
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const COLORS = ['W', 'U', 'B', 'R', 'G'];
const COLOR_DE = { W: 'Weiß', U: 'Blau', B: 'Schwarz', R: 'Rot', G: 'Grün', C: 'Farblos' };
const BASICS = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const BASIC_NAMES = new Set(Object.values(BASICS).concat(Object.values(BASICS).map(n => 'Snow-Covered ' + n), ['Wastes']));
const GUILDS = { WU: 'Azorius', UB: 'Dimir', BR: 'Rakdos', RG: 'Gruul', WG: 'Selesnya', WB: 'Orzhov', UR: 'Izzet', BG: 'Golgari', WR: 'Boros', UG: 'Simic' };
const ARCH_DE = { aggro: 'Aggro', midrange: 'Midrange', control: 'Kontrolle' };
const sortColors = (cs) => COLORS.filter(c => cs.includes(c));

function toast(msg, ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function overlay(html) {
  let o = $('#overlay');
  if (!html) { o && o.remove(); return; }
  if (!o) { o = document.createElement('div'); o.id = 'overlay'; o.className = 'overlay'; document.body.appendChild(o); }
  o.innerHTML = `<div class="box">${html}</div>`;
}

/* Manakosten → Symbole */
function manaHTML(cost, big = false) {
  if (!cost) return '';
  const syms = cost.match(/\{[^}]+\}/g) || [];
  return `<span class="mana">${syms.map(s => {
    const v = s.slice(1, -1);
    const parts = v.split('/');
    const cols = parts.filter(p => COLORS.includes(p));
    let style = '';
    if (cols.length === 2) style = `style="background:linear-gradient(135deg,var(--${cols[0]}) 50%,var(--${cols[1]}) 50%)"`;
    const cls = cols.length === 1 ? cols[0] : '';
    const label = cols.length ? (parts.includes('P') ? 'φ' : '') : esc(parts[0]);
    return `<span class="ms ${cls} ${big ? 'big' : ''}" ${style}>${label}</span>`;
  }).join('')}</span>`;
}
const pipsHTML = (cs) => sortColors(cs).map(c => `<span class="pip ${c}"></span>`).join('') || '<span class="pip C"></span>';

/* ============================================================
   Speicher (IndexedDB + Einstellungen)
   ============================================================ */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('manaforge', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const [n, k] of [['collection', 'key'], ['cards', 'id'], ['decks', 'id'], ['folders', 'id'], ['loc', 'k']]) {
          if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: k });
        }
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  all(store) {
    return new Promise((res, rej) => {
      const q = this.db.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  putMany(store, items) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      items.forEach(i => os.put(i));
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
  del(store, key) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
  delMany(store, keys) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      keys.forEach(k => os.delete(k));
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
  clear(store) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
};

const Settings = {
  defaults: { geminiKey: '', geminiModel: 'gemini-flash-latest', unlimitedBasics: true, limitedMaxCopies: 4, cardLang: 'scanned', lastBackup: 0, priceSource: 'cardmarket', lastCardRefresh: 0, controlsBottom: false, theme: 'default', deckTheme: true, fx: true, art: true, artPicks: {} },
  data: {},
  load() {
    try { this.data = { ...this.defaults, ...JSON.parse(localStorage.getItem('manaforge-settings') || '{}') }; }
    catch { this.data = { ...this.defaults }; }
  },
  get(k) { return this.data[k]; },
  set(k, v) {
    this.data[k] = v;
    try { localStorage.setItem('manaforge-settings', JSON.stringify(this.data)); } catch { /* privat/blockiert */ }
  },
};

const state = {
  view: 'collection',
  collection: [],          // Einträge aus der CSV (pro Druck/Foil)
  cards: new Map(),        // Scryfall-Daten nach ID
  decks: [],
  folders: [],             // eigene Ordner {id, name, created}
  loc: new Map(),          // Sprachversionen: "oracleId|lang" → {name,type,text,img,imgBack}
  tab: 'all',              // Sammlung: all | folders | sets
  select: null,            // Mehrfachauswahl: Set von Kartennamen oder null
  filter: { q: '', colors: [], type: '', sort: 'name', limit: 150, folder: null, set: null },
  build: { format: 'casual60', colorMode: 'dual', colors: [], arch: 'auto', forced: '', folders: [] },
  results: [],
};

/* ============================================================
   CSV-Import (ManaBox)
   ============================================================ */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const count = (d) => { let n = 0, q = false; for (const ch of first) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; };
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

const LANG_NORM = { english: 'en', englisch: 'en', german: 'de', deutsch: 'de', french: 'fr', französisch: 'fr', italian: 'it', spanish: 'es', portuguese: 'pt', japanese: 'ja', korean: 'ko', russian: 'ru', 'chinese simplified': 'zhs', 'chinese traditional': 'zht', chinese: 'zhs' };
function normLang(v) {
  v = String(v || '').trim().toLowerCase();
  if (!v) return '';
  return LANG_NORM[v] || v.slice(0, 3);
}
/** Eindeutiger Schlüssel eines Sammlungseintrags: Druck + Foil + Ordner */
function entryKey(e) {
  const base = e.sid ? `${e.sid}|${e.foil ? 'f' : 'n'}` : `${(e.name || '').toLowerCase()}|${e.set}|${e.number}|${e.foil ? 'f' : 'n'}`;
  return base + '|' + (e.folder || '');
}
const printKey = (e) => entryKey({ ...e, folder: null });

const COLS = {
  name: ['name', 'cardname', 'card', 'kartenname'],
  set: ['setcode', 'set', 'editioncode', 'edition'],
  setName: ['setname', 'editionname'],
  number: ['collectornumber', 'cardnumber', 'number', 'collector', 'nummer'],
  foil: ['foil', 'printing', 'finish'],
  qty: ['quantity', 'qty', 'count', 'amount', 'anzahl', 'menge'],
  sid: ['scryfallid', 'scryfall'],
  lang: ['language', 'lang', 'sprache'],
  cond: ['condition', 'zustand'],
  binder: ['bindername', 'binder', 'folder', 'ordner', 'listname', 'list'],
  buy: ['purchaseprice', 'kaufpreis', 'buyprice'],
  buyCur: ['purchasepricecurrency', 'purchasecurrency', 'currency', 'waehrung'],
};

function parseManaBox(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Die Datei enthält keine Kartenzeilen.');
  const norm = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const idx = {};
  for (const [k, alts] of Object.entries(COLS)) {
    for (const a of alts) { const i = norm.indexOf(a); if (i >= 0) { idx[k] = i; break; } }
  }
  if (idx.name === undefined && idx.sid === undefined) throw new Error('Keine Spalte „Name“ gefunden – ist das ein ManaBox-CSV-Export?');
  const map = new Map();
  for (const r of rows.slice(1)) {
    const get = (k) => idx[k] !== undefined ? (r[idx[k]] || '').trim() : '';
    const name = get('name');
    const sid = get('sid').toLowerCase();
    if (!name && !sid) continue;
    let set = get('set');
    if (set.length > 6) set = ''; // vermutlich Set-Name statt Code
    const fv = get('foil').toLowerCase();
    const foil = /foil|etched|true|yes|^1$|^ja$/.test(fv) && !/non.?foil|normal/.test(fv);
    const qty = parseInt(get('qty'), 10);
    const e = {
      name, sid: /^[0-9a-f-]{36}$/.test(sid) ? sid : '',
      set: set.toLowerCase(), setName: get('setName'), number: get('number'),
      foil, qty: Number.isFinite(qty) && qty > 0 ? qty : 1, lang: normLang(get('lang')), cond: get('cond'),
      binder: get('binder'), folder: null,
      buy: parseFloat(get('buy').replace(',', '.')) || 0, buyCur: get('buyCur').toUpperCase(),
    };
    e.key = entryKey(e) + '|b:' + e.binder.toLowerCase();
    const ex = map.get(e.key);
    if (ex) ex.qty += e.qty; else map.set(e.key, e);
  }
  return [...map.values()];
}

/* ============================================================
   Scryfall
   ============================================================ */
const LEG_KEYS = ['standard', 'pioneer', 'modern', 'pauper', 'legacy', 'vintage', 'commander', 'historic', 'timeless', 'explorer', 'alchemy'];
function slimCard(c) {
  const faces = c.card_faces || [];
  const f0 = faces[0] || {};
  const img = c.image_uris || f0.image_uris || {};
  const leg = {}; LEG_KEYS.forEach(k => leg[k] = c.legalities?.[k] || 'not_legal');
  return {
    id: c.id, oid: c.oracle_id || f0.oracle_id, name: c.name, lang: c.lang || 'en',
    printed: c.printed_name || (faces.length ? faces.map(f => f.printed_name || f.name).join(' // ') : ''),
    ptype: c.printed_type_line || (faces.length ? faces.map(f => f.printed_type_line || '').filter(Boolean).join(' // ') : ''),
    ptext: c.printed_text || (faces.length ? faces.map(f => f.printed_text || '').filter(Boolean).join('\n—\n') : ''),
    mana: c.mana_cost ?? f0.mana_cost ?? '', cmc: c.cmc || 0,
    type: c.type_line || faces.map(f => f.type_line).join(' // '),
    frontType: f0.type_line || c.type_line || '',
    text: c.oracle_text ?? faces.map(f => f.oracle_text || '').join('\n—\n'),
    colors: c.colors ?? [...new Set(faces.flatMap(f => f.colors || []))],
    ci: c.color_identity || [], kw: c.keywords || [], leg, rarity: c.rarity, set: c.set, setName: c.set_name,
    num: c.collector_number, prod: c.produced_mana || [], pow: c.power ?? f0.power ?? null, tou: c.toughness ?? f0.toughness ?? null,
    rank: c.edhrec_rank || null, img: img.normal || '', imgS: img.small || '',
    imgBack: faces[1]?.image_uris?.normal || '', eur: c.prices?.eur || c.prices?.eur_foil || null,
    usd: c.prices?.usd || c.prices?.usd_foil || null, layout: c.layout,
    prices: { eur: c.prices?.eur || null, eur_foil: c.prices?.eur_foil || null, usd: c.prices?.usd || null, usd_foil: c.prices?.usd_foil || null, usd_etched: c.prices?.usd_etched || null, tix: c.prices?.tix || null },
    shop: { cardmarket: c.purchase_uris?.cardmarket || '', tcgplayer: c.purchase_uris?.tcgplayer || '', cardhoarder: c.purchase_uris?.cardhoarder || '' },
    games: c.games || [], artist: c.artist || c.card_faces?.[0]?.artist || '',
  };
}

let scryPostBroken = false;
/** Fallback ohne POST (falls CORS-Preflight scheitert): einzelne GET-Anfragen */
async function scryOneByOne(identifiers) {
  const data = [], not_found = [];
  for (const i of identifiers) {
    const url = i.id ? `https://api.scryfall.com/cards/${i.id}`
      : i.collector_number ? `https://api.scryfall.com/cards/${encodeURIComponent(i.set)}/${encodeURIComponent(i.collector_number)}`
      : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(i.name)}${i.set ? '&set=' + encodeURIComponent(i.set) : ''}`;
    try { const r = await fetch(url); if (r.ok) data.push(await r.json()); else not_found.push(i); }
    catch { not_found.push(i); }
    await sleep(80);
  }
  return { data, not_found };
}
async function scryCollection(identifiers) {
  if (scryPostBroken) return scryOneByOne(identifiers);
  let res;
  try {
    res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers }),
    });
  } catch (e) {
    if (!navigator.onLine) throw e;
    scryPostBroken = true; return scryOneByOne(identifiers);
  }
  return handleScryRes(res, identifiers);
}
async function handleScryRes(res, identifiers) {
  if (res.status === 429) { await sleep(1500); return scryCollection(identifiers); }
  if (!res.ok) throw new Error('Scryfall HTTP ' + res.status);
  return res.json();
}

function identOf(e, byNameOnly = false) {
  if (byNameOnly) return { k: 'n:' + e.name.toLowerCase(), ident: { name: e.name } };
  if (e.sid) return { k: 'id:' + e.sid, ident: { id: e.sid } };
  if (e.set && e.number) return { k: `sn:${e.set}|${e.number.toLowerCase()}`, ident: { set: e.set, collector_number: e.number } };
  if (e.set) return { k: `ns:${e.name.toLowerCase()}|${e.set}`, ident: { name: e.name, set: e.set } };
  return { k: 'n:' + e.name.toLowerCase(), ident: { name: e.name } };
}
function keysOfCard(c) {
  const ks = ['id:' + c.id, `sn:${c.set}|${String(c.collector_number).toLowerCase()}`, `ns:${c.name.toLowerCase()}|${c.set}`, 'n:' + c.name.toLowerCase()];
  if (c.name.includes(' // ')) { const f = c.name.split(' // ')[0].toLowerCase(); ks.push('n:' + f, `ns:${f}|${c.set}`); }
  return ks;
}

/** Lädt fehlende Kartendaten. Gibt Liste nicht gefundener Einträge zurück. */
async function enrichFromScryfall(entries, onProgress) {
  const todo = entries.filter(e => !(e.sid && state.cards.has(e.sid)));
  const notFound = [];
  for (let pass = 0; pass < 2 && todo.length; pass++) {
    const groups = new Map();
    for (const e of todo) {
      const { k, ident } = identOf(e, pass === 1);
      if (!groups.has(k)) groups.set(k, { ident, entries: [] });
      groups.get(k).entries.push(e);
    }
    const keys = [...groups.keys()];
    const found = new Map();
    for (let i = 0; i < keys.length; i += 75) {
      const chunk = keys.slice(i, i + 75);
      const data = await scryCollection(chunk.map(k => groups.get(k).ident));
      const fresh = [];
      for (const c of data.data || []) {
        const s = slimCard(c); state.cards.set(s.id, s); fresh.push(s);
        keysOfCard(c).forEach(k => { if (!found.has(k)) found.set(k, s.id); });
      }
      await DB.putMany('cards', fresh);
      onProgress && onProgress(Math.min(i + 75, keys.length), keys.length, pass);
      await sleep(110);
    }
    const retry = [];
    for (const [k, g] of groups) {
      const id = found.get(k);
      if (id) g.entries.forEach(e => { e.sid = id; });
      else retry.push(...g.entries);
    }
    todo.length = 0; todo.push(...retry);
  }
  notFound.push(...todo);
  return notFound;
}

/* ============================================================
   Kartenanalyse
   ============================================================ */
const EXCLUDE_LAYOUTS = new Set(['token', 'double_faced_token', 'art_series', 'emblem', 'planar', 'scheme', 'vanguard', 'augment', 'host']);
const EXCLUDE_TYPES = /Conspiracy|Scheme|Phenomenon|Vanguard|Dungeon|Attraction|Stickers|Plane\b|Emblem|Token/;
const RARITY_BONUS = { common: 0, uncommon: 0.4, rare: 0.9, mythic: 1.3, special: 0.5, bonus: 0.5 };
const anCache = new Map();

function analyze(c) {
  if (anCache.has(c.id)) return anCache.get(c.id);
  const t = (c.text || '').toLowerCase();
  const ft = c.frontType || c.type || '';
  const a = {
    excluded: EXCLUDE_LAYOUTS.has(c.layout) || EXCLUDE_TYPES.test(c.type || ''),
    isLand: /\bLand\b/.test(ft),
    isBasic: BASIC_NAMES.has(c.name) || /Basic Land/.test(ft),
    isCreature: /Creature/.test(ft),
    isPW: /Planeswalker/.test(ft),
    isInstant: /Instant/.test(ft), isSorcery: /Sorcery/.test(ft),
    tribes: [], roles: {}, themes: [],
  };
  if (a.isCreature) {
    const sub = (ft.split('—')[1] || '').trim();
    a.tribes = sub ? sub.split(/\s+/).filter(Boolean) : [];
  }
  const R = a.roles;
  R.removal = /destroy (target|each|all) (creature|nonland|permanent|artifact|enchantment|planeswalker)|exile target (creature|nonland|permanent|artifact|enchantment|planeswalker)|deals? (\d+|x|that much) damage to (any target|target creature|each creature|target attacking)|target creature gets -\d+\/-\d+|fights? (target|another|up to)|target (creature|nonland permanent) (an opponent controls )?(gets|loses)|return target (creature|nonland permanent) to its owner's hand|tap target creature\. it doesn't untap|enchanted creature can't attack/.test(t);
  R.counter = /counter target/.test(t);
  R.draw = /draws? (a|two|three|four|x|\w+) cards?|draw cards? equal/.test(t);
  R.ramp = !a.isLand && (/\badd \{|search your library for (a|up to \w+) (basic )?lands?/.test(t));
  R.burnFace = /damage to (any target|each opponent|target player|target opponent|each player)/.test(t);
  R.evasion = a.isCreature && (c.kw.some(k => ['Flying', 'Menace', 'Trample', 'Shadow', 'Fear', 'Intimidate', 'Skulk'].includes(k)) || /can't be blocked/.test(t));
  R.haste = c.kw.includes('Haste');
  R.lifegain = /gain \d+ life|lifelink|gains? life/.test(t) || c.kw.includes('Lifelink');
  if (/\+1\/\+1 counter/.test(t)) a.themes.push('counters');
  if (/create .*token/.test(t)) a.themes.push('tokens');
  if (R.lifegain) a.themes.push('lifegain');
  if (/graveyard/.test(t)) a.themes.push('graveyard');
  if (/whenever you cast (an instant|a noncreature)|instant or sorcery spell/.test(t)) a.themes.push('spells');
  if (/artifact/.test(t) && !a.isLand) a.themes.push('artifacts');
  a.tapped = a.isLand && /enters (the battlefield )?tapped/.test(t) && !/unless|you may pay/.test(t);
  a.pips = countPips(c.mana);
  anCache.set(c.id, a);
  return a;
}

function countPips(cost) {
  const p = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const s of (cost || '').match(/\{[^}]+\}/g) || []) {
    const cols = s.slice(1, -1).split('/').filter(x => COLORS.includes(x));
    cols.forEach(c => p[c] += 1 / cols.length);
  }
  return p;
}
/** Ist die Karte mit den gewählten Farben bezahlbar? (Hybrid/Phyrexanisch beachtet) */
function castable(c, set) {
  const syms = (c.mana || '').match(/\{[^}]+\}/g) || [];
  for (const s of syms) {
    const parts = s.slice(1, -1).split('/');
    const cols = parts.filter(x => COLORS.includes(x));
    if (!cols.length) continue;
    if (parts.includes('P') || parts.some(x => /^\d+$/.test(x))) continue;
    if (!cols.some(x => set.has(x))) return false;
  }
  // Karten ohne Manakosten, aber mit Farbe (z.B. Suspend) über Farbe prüfen
  if (!syms.length && c.colors.length && !c.colors.every(x => set.has(x))) return false;
  return true;
}

function qualityFromRank(rank) {
  if (!rank) return 2.2;
  return Math.max(0.5, Math.min(10, 10 - Math.log10(rank) * 1.9));
}

/** Grundwert einer Karte für einen Archetyp */
function baseScore(c, a, arch, limited) {
  let s = qualityFromRank(c.rank) * 0.55 + (RARITY_BONUS[c.rarity] || 0);
  const R = a.roles, cmc = c.cmc;
  if (R.removal) s += limited ? 2.6 : 1.8;
  if (R.draw) s += 0.7;
  if (a.isPW) s += 1.2;
  if (a.isCreature) {
    const p = parseFloat(c.pow), t = parseFloat(c.tou);
    if (Number.isFinite(p) && Number.isFinite(t)) {
      const eff = (p + t * 0.8) / Math.max(cmc, 1);
      s += Math.max(-1, Math.min(1.5, (eff - 2) * 0.8));
    }
    if (R.evasion) s += limited ? 1 : 0.5;
    s += Math.min(c.kw.length, 3) * 0.15;
  }
  if (arch === 'aggro') {
    if (cmc >= 5) s -= 3; else if (cmc === 4) s -= 0.8;
    if (cmc <= 2 && a.isCreature) s += 0.9;
    if (R.burnFace) s += 1; if (R.haste) s += 0.6; if (R.evasion) s += 0.5;
    if (R.counter) s -= 1; if (R.lifegain && !a.isCreature) s -= 0.5;
  } else if (arch === 'control') {
    if (R.removal) s += 1.2; if (R.counter) s += 1.6; if (R.draw) s += 1;
    if (a.isCreature && cmc <= 2 && !R.removal && !R.draw) s -= 0.8;
    if (cmc >= 7) s -= 1;
  } else if (arch === 'midrange') {
    if (R.counter) s += 0.2; if (R.ramp) s += 0.4;
    if (cmc >= 7) s -= 1.5;
  }
  if (cmc >= 8) s -= 2;
  return s;
}

/* ============================================================
   Deckbau-Algorithmus
   ============================================================ */
const FORMATS = {
  casual60: { label: 'Casual 60', size: 60, max: 4, legal: null, lands: { aggro: 22, midrange: 24, control: 25 } },
  standard: { label: 'Standard', size: 60, max: 4, legal: 'standard', lands: { aggro: 22, midrange: 24, control: 26 } },
  pioneer: { label: 'Pioneer', size: 60, max: 4, legal: 'pioneer', lands: { aggro: 21, midrange: 24, control: 26 } },
  modern: { label: 'Modern', size: 60, max: 4, legal: 'modern', lands: { aggro: 20, midrange: 23, control: 25 } },
  pauper: { label: 'Pauper', size: 60, max: 4, legal: 'pauper', lands: { aggro: 19, midrange: 22, control: 24 } },
  limited40: { label: 'Limited 40', size: 40, max: null, legal: null, limited: true, lands: { aggro: 16, midrange: 17, control: 17 } },
  historic: { label: 'Historic', size: 60, max: 4, legal: 'historic', arena: true, lands: { aggro: 21, midrange: 24, control: 26 } },
  timeless: { label: 'Timeless', size: 60, max: 4, legal: 'timeless', arena: true, lands: { aggro: 20, midrange: 23, control: 25 } },
  explorer: { label: 'Explorer', size: 60, max: 4, legal: 'explorer', arena: true, lands: { aggro: 21, midrange: 24, control: 26 } },
  alchemy: { label: 'Alchemy', size: 60, max: 4, legal: 'alchemy', arena: true, lands: { aggro: 22, midrange: 24, control: 26 } },
};
/** Deckbau ausschließlich aus digitalen Ordnern? */
const isArenaBuild = () => state.build.folders.length > 0 && state.build.folders.every(id => isDigitalFolder(id));
const maxCopies = (F) => F.max ?? (+Settings.get('limitedMaxCopies') || 99);
const CURVE = { // Anteile der Zauber je Manawert 1,2,3,4,5,6+
  aggro: [0.2, 0.36, 0.26, 0.12, 0.06, 0],
  midrange: [0.08, 0.27, 0.25, 0.2, 0.12, 0.08],
  control: [0.06, 0.22, 0.24, 0.2, 0.15, 0.13],
};
const CREATURE_FRAC = { aggro: 0.6, midrange: 0.45, control: 0.22 };
const bucketOf = (cmc) => Math.max(0, Math.min(5, Math.round(cmc) - 1));

/** Fasst die Sammlung nach Kartennamen zusammen */
function buildPool(folders = state.build.folders) {
  const fset = folders && folders.length ? new Set(folders) : null;
  const dig = digitalIds();
  const pool = new Map();
  for (const e of state.collection) {
    if (fset ? !fset.has(e.folder || '_none') : dig.has(e.folder)) continue;
    const c = e.sid && state.cards.get(e.sid);
    if (!c) continue;
    let p = pool.get(c.name);
    if (!p) { p = { name: c.name, card: c, qty: 0, an: analyze(c), base: {}, sids: [] }; pool.set(c.name, p); }
    p.qty += e.qty; p.sids.push(c.id);
    if (!p.card.img && c.img) p.card = c;
  }
  // Stammes-Bezüge („Other Elves you control …“) erkennen
  const tribeCount = new Map();
  for (const p of pool.values()) p.an.tribes.forEach(t => tribeCount.set(t, (tribeCount.get(t) || 0) + 1));
  const vocab = [...tribeCount.entries()].filter(([, n]) => n >= 3).map(([t]) => t);
  const PLURAL = { Elf: 'elves', Dwarf: 'dwarves', Wolf: 'wolves', Werewolf: 'werewolves' };
  const rx = vocab.map(t => [t, new RegExp(`\\b(${t.toLowerCase()}s?|${PLURAL[t] || t.toLowerCase() + 's'})\\b`)]);
  for (const p of pool.values()) {
    const txt = (p.card.text || '').toLowerCase().split(p.name.toLowerCase()).join('cardname').replace(/create[^.]*?tokens?/g, '');
    p.refs = rx.filter(([, r]) => r.test(txt)).map(([t]) => t);
  }
  return pool;
}
const baseOf = (p, arch, limited) => {
  const k = arch + (limited ? 'L' : '');
  return p.base[k] ??= baseScore(p.card, p.an, arch, limited);
};

function landFits(c, a, set, mono) {
  const prod = c.prod.filter(x => COLORS.includes(x));
  if (!prod.length) return false;
  const inSet = prod.filter(x => set.has(x));
  const outSet = prod.filter(x => !set.has(x));
  if (!inSet.length) return false;
  if (mono) return outSet.length === 0;
  return outSet.length === 0 || inSet.length >= 2;
}

function basicCard(color) {
  const name = BASICS[color];
  for (const e of state.collection) {
    const c = e.sid && state.cards.get(e.sid);
    if (c && c.name === name && c.img) return c;
  }
  return { id: 'basic-' + color, name, mana: '', cmc: 0, type: 'Basic Land — ' + name, frontType: 'Basic Land — ' + name, text: '', colors: [], ci: [color], kw: [], leg: {}, rarity: 'common', prod: [color], img: `https://api.scryfall.com/cards/named?exact=${name}&format=image`, imgS: `https://api.scryfall.com/cards/named?exact=${name}&format=image&version=small`, layout: 'normal' };
}

function buildDeck({ format, colors, arch, pool, forced = [] }) {
  const F = FORMATS[format], limited = !!F.limited, maxC = maxCopies(F);
  const set = new Set(colors), mono = colors.length === 1;
  const landTarget = F.lands[arch], spellTarget = F.size - landTarget;
  const spells = [], lands = [];
  for (const p of pool.values()) {
    const c = p.card, a = p.an;
    if (a.excluded || a.isBasic) continue;
    if (F.legal && c.leg[F.legal] !== 'legal') continue;
    if (a.isLand) { if (landFits(c, a, set, mono)) lands.push(p); continue; }
    if (!castable(c, set)) continue;
    spells.push(p);
  }
  const deck = new Map();
  const curveT = CURVE[arch].map(f => Math.round(f * spellTarget));
  const creatureT = CREATURE_FRAC[arch] * spellTarget;
  const bucket = [0, 0, 0, 0, 0, 0], tribes = new Map(), themes = new Map(), refCount = new Map(), distinct = new Map();
  let nSpells = 0, nCreat = 0, scoreSum = 0, synSum = 0;
  const synergyOf = (p) => {
    let s = 0;
    for (const t of p.an.tribes) s += Math.min(refCount.get(t) || 0, 8) * 0.25 + Math.min(tribes.get(t) || 0, 8) * 0.05;
    for (const t of p.refs || []) s += Math.min(tribes.get(t) || 0, 12) * 0.12;
    for (const t of p.an.themes) s += Math.min(themes.get(t) || 0, 8) * 0.06;
    return s;
  };
  const add = (p, n = 1) => {
    const d = deck.get(p.name) || { p, n: 0 }; d.n += n; deck.set(p.name, d);
    if (!p.an.isLand) {
      const fresh = !deck.get(p.name) || deck.get(p.name).n === n;
      synSum += Math.min(synergyOf(p), 3) * n;
      nSpells += n; bucket[bucketOf(p.card.cmc)] += n; scoreSum += baseOf(p, 'neutral', limited) * n;
      if (p.an.isCreature) {
        nCreat += n;
        p.an.tribes.forEach(t => { tribes.set(t, (tribes.get(t) || 0) + n); if (fresh) distinct.set(t, (distinct.get(t) || 0) + 1); });
      }
      (p.refs || []).forEach(t => refCount.set(t, (refCount.get(t) || 0) + n));
      p.an.themes.forEach(t => themes.set(t, (themes.get(t) || 0) + n));
    }
  };
  const limitOf = (p) => Math.min(p.qty, maxC);
  // Pflichtkarten
  for (const name of forced) {
    const p = pool.get(name);
    if (p && !p.an.isLand && spells.includes(p)) add(p, Math.min(limitOf(p), limited ? 1 : 4));
    else if (p && p.an.isLand) add(p, Math.min(limitOf(p), 4));
  }
  while (nSpells < spellTarget) {
    let best = null, bs = -Infinity;
    for (const p of spells) {
      const cur = deck.get(p.name)?.n || 0;
      if (cur >= limitOf(p)) continue;
      let s = baseOf(p, arch, limited);
      const b = bucketOf(p.card.cmc), tg = curveT[b], hv = bucket[b];
      s += hv < tg ? 1.3 * (1 - hv / Math.max(tg, 1)) : -0.9 * (hv - tg + 1);
      if (p.an.isCreature) s += nCreat < creatureT ? 0.9 : -0.5 * ((nCreat - creatureT) / 3 + 1);
      s -= cur * (limited ? 0.6 : 0.3);
      s += synergyOf(p);
      if (s > bs) { bs = s; best = p; }
    }
    if (!best) break;
    add(best);
  }
  // Nichtstandard-Länder
  const maxNB = mono ? Math.min(4, Math.round(landTarget * 0.2)) : Math.round(landTarget * 0.45);
  let nLands = [...deck.values()].filter(d => d.p.an.isLand).reduce((s, d) => s + d.n, 0);
  const lscore = (p) => {
    const prod = p.card.prod.filter(x => set.has(x)).length;
    return prod * 2 + qualityFromRank(p.card.rank) * 0.3 - (p.an.tapped ? (arch === 'aggro' ? 2 : 0.7) : 0);
  };
  lands.sort((x, y) => lscore(y) - lscore(x));
  for (const p of lands) {
    while (nLands < maxNB && (deck.get(p.name)?.n || 0) < limitOf(p)) { add(p); nLands++; }
  }
  // Standardländer nach Farbanteilen
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const d of deck.values()) if (!d.p.an.isLand) COLORS.forEach(c => pips[c] += d.p.an.pips[c] * d.n);
  colors.forEach(c => { if (pips[c] === 0) pips[c] = 0.5; });
  const need = landTarget - nLands;
  const tot = colors.reduce((s, c) => s + pips[c], 0) || 1;
  const alloc = colors.map(c => ({ c, x: need * pips[c] / tot }));
  alloc.forEach(a => a.n = Math.floor(a.x));
  let rest = need - alloc.reduce((s, a) => s + a.n, 0);
  alloc.sort((a, b) => (b.x - b.n) - (a.x - a.n)).forEach(a => { if (rest > 0) { a.n++; rest--; } });
  const missing = [];
  const unlimited = Settings.get('unlimitedBasics') || isArenaBuild();
  for (const a of alloc) {
    if (a.n <= 0) continue;
    let n = a.n;
    if (!unlimited) {
      const owned = pool.get(BASICS[a.c])?.qty || 0;
      if (owned < n) { missing.push({ name: BASICS[a.c], n: n - owned }); n = owned; }
    }
    const bp = pool.get(BASICS[a.c]) || { name: BASICS[a.c], card: basicCard(a.c), qty: 999, an: analyze(basicCard(a.c)), base: {}, sids: [] };
    if (n > 0) add(bp, n);
  }
  // Bewertung
  const warnings = [];
  if (nSpells < spellTarget) warnings.push(`Nur ${nSpells} von ${spellTarget} Zaubern verfügbar`);
  if (missing.length) warnings.push(`Es fehlen ${missing.reduce((s, m) => s + m.n, 0)} Standardländer`);
  let score = scoreSum / spellTarget + Math.min(synSum / spellTarget, 2) * 0.8;
  score -= curveT.reduce((s, t, i) => s + Math.abs(t - bucket[i]), 0) * 0.04;
  if (!mono) {
    const tp = colors.map(c => pips[c]); const share = Math.min(...tp) / (tp.reduce((a, b) => a + b, 0) || 1);
    if (share < 0.2) { score -= 1.2; warnings.push(`${COLOR_DE[colors[tp.indexOf(Math.min(...tp))]]} ist kaum vertreten`); }
  }
  if (nSpells < spellTarget) score -= (spellTarget - nSpells) / spellTarget * 4;
  const topTribe = [...tribes.entries()]
    .filter(([t, n]) => (distinct.get(t) || 0) >= 3 && n >= nCreat * 0.35 && ((refCount.get(t) || 0) > 0 || n >= nCreat * 0.6) && !(t === 'Human' && (refCount.get(t) || 0) < 8))
    .sort((a, b) => b[1] - a[1])[0];
  const tribe = topTribe ? topTribe[0] : null;
  const cards = [...deck.values()].map(d => ({ name: d.p.name, n: d.n, sid: d.p.card.id }));
  return {
    id: uid(), format, colors: sortColors(colors), arch, tribe,
    name: deckName(colors, arch, tribe), cards, missing, warnings,
    score: Math.round(Math.max(0, Math.min(100, score * 11))), raw: score, created: Date.now(),
  };
}

function comboName(colors) {
  const cs = sortColors(colors);
  if (cs.length === 1) return 'Mono-' + COLOR_DE[cs[0]];
  return GUILDS[cs.join('')] || GUILDS[cs.slice().reverse().join('')] || cs.join('');
}
function deckName(colors, arch, tribe) {
  return `${comboName(colors)} ${ARCH_DE[arch]}${tribe ? ` (${tribe})` : ''}`;
}

function colorCombos(mode, picked) {
  if (mode === 'pick') return picked.length ? [sortColors(picked)] : [];
  const mono = COLORS.map(c => [c]);
  const dual = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) dual.push([COLORS[i], COLORS[j]]);
  return mode === 'mono' ? mono : mode === 'dual' ? dual : mono.concat(dual);
}

function suggestDecks({ format, colorMode, colors, arch, forced }) {
  const pool = buildPool();
  const combos = colorCombos(colorMode, colors);
  const archs = arch === 'auto' ? ['aggro', 'midrange', 'control'] : [arch];
  const forcedCard = forced && pool.get(forced)?.card;
  const out = [];
  for (const cs of combos) {
    if (forcedCard && !forcedCard.frontType.includes('Land') && !castable(forcedCard, new Set(cs))) continue;
    let best = null;
    for (const a of archs) {
      const d = buildDeck({ format, colors: cs, arch: a, pool, forced: forced ? [forced] : [] });
      if (!best || d.raw > best.raw) best = d;
    }
    if (best) { best.folders = (state.build.folders || []).slice(); best.digital = isArenaBuild(); out.push(best); }
  }
  return out.sort((a, b) => b.raw - a.raw);
}

const cardById = (sid) => state.cards.get(sid) || (String(sid).startsWith('basic-') ? basicCard(sid.slice(6)) : null);

/* ============================================================
   Gemini
   ============================================================ */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function geminiCall(prompt, json = true) {
  const key = Settings.get('geminiKey');
  if (!key) throw new Error('Kein Gemini-API-Key hinterlegt (Einstellungen).');
  const model = (Settings.get('geminiModel') || 'gemini-flash-latest').replace(/^models\//, '');
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Gemini HTTP ' + res.status);
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  if (!text) throw new Error('Leere Antwort von Gemini' + (data.promptFeedback?.blockReason ? ' (' + data.promptFeedback.blockReason + ')' : ''));
  if (!json) return text;
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { throw new Error('Gemini-Antwort war kein gültiges JSON.'); }
}

async function geminiModels() {
  const key = Settings.get('geminiKey');
  if (!key) throw new Error('Bitte zuerst den API-Key eintragen.');
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'HTTP ' + res.status);
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter(m => /gemini/i.test(m.id) && !/tts|image|live|embedding|audio|robotics|computer/i.test(m.id));
}

const shortText = (t, n = 140) => { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function cardLine(p, maxC) {
  const c = p.card;
  return `${Math.min(p.qty, maxC)}x ${c.name} | ${c.mana || '-'} | ${c.type} | ${shortText(c.text)}${c.pow != null ? ` | ${c.pow}/${c.tou}` : ''}`;
}
function formatRules(F) {
  const maxC = maxCopies(F);
  const unl = Settings.get('unlimitedBasics');
  return `Format: ${F.label} – genau ${F.size} Karten, max. ${maxC >= 99 ? 'beliebig viele' : maxC} Kopien pro Karte (außer Standardländer).` +
    (F.legal ? ` Alle Karten müssen in ${F.label} legal sein (die Liste ist bereits gefiltert).` : '') +
    (F.limited ? ' Limited-typisch: ca. 17 Länder, 15-17 Kreaturen, Removal und Evasion sind wichtig.' : ' Typisch: 22-26 Länder.') +
    ` Standardländer (Plains, Island, Swamp, Mountain, Forest) sind ${unl ? 'unbegrenzt verfügbar' : 'nur in der gelisteten Menge verfügbar'}.`;
}

/** Gemini baut ein Deck aus der Sammlung; wird anschließend validiert und aufgefüllt */
async function geminiBuild({ format, colors, arch }) {
  const F = FORMATS[format], maxC = maxCopies(F), set = new Set(colors);
  const pool = buildPool();
  const archUse = arch === 'auto' ? 'midrange' : arch;
  const cands = [...pool.values()].filter(p => {
    const a = p.an;
    if (a.excluded || a.isBasic) return false;
    if (F.legal && p.card.leg[F.legal] !== 'legal') return false;
    return a.isLand ? landFits(p.card, a, set, colors.length === 1) : castable(p.card, set);
  }).sort((x, y) => baseOf(y, archUse, F.limited) - baseOf(x, archUse, F.limited)).slice(0, 280);
  if (cands.length < 10) throw new Error('Zu wenige passende Karten in diesen Farben.');
  const prompt = `Du bist ein erfahrener Magic: The Gathering Deckbauer. Baue ein starkes, spielbares Deck AUSSCHLIESSLICH aus der folgenden Kartenliste. Das ist die physische Sammlung des Spielers; die Zahl vor dem x ist die maximal verfügbare Anzahl.
${formatRules(F)}
Farben: ${colors.map(c => COLOR_DE[c]).join('/')}.
Archetyp: ${arch === 'auto' ? 'wähle den stärksten Archetyp für diese Karten' : ARCH_DE[arch]}.
Achte auf eine saubere Manakurve, genug Interaktion und Synergien.

Antworte NUR mit JSON in diesem Schema:
{"name":"kurzer deutscher Deckname","archetyp":"Aggro|Midrange|Kontrolle|...","strategie":"3-5 Sätze auf Deutsch: Spielplan und Siegbedingung","karten":[{"name":"exakter englischer Kartenname","anzahl":4}],"spieltipps":["kurzer Tipp", "..."],"mulligan":"1-2 Sätze, welche Starthand gut ist"}
Die Summe aller "anzahl" inklusive Länder muss genau ${F.size} ergeben.

Kartenliste (Anzahl x Name | Kosten | Typ | Text | Stärke):
${cands.map(p => cardLine(p, maxC)).join('\n')}`;
  const r = await geminiCall(prompt, true);
  const deck = validateAIDeck(r, { format, colors, arch: archUse, pool });
  deck.folders = (state.build.folders || []).slice();
  deck.digital = isArenaBuild();
  return deck;
}

function validateAIDeck(r, { format, colors, arch, pool }) {
  const F = FORMATS[format], maxC = maxCopies(F), set = new Set(colors);
  const byLower = new Map();
  for (const p of pool.values()) {
    byLower.set(p.name.toLowerCase(), p);
    if (p.name.includes(' // ')) byLower.set(p.name.split(' // ')[0].toLowerCase(), p);
  }
  const unknown = [];
  const deck = new Map();
  const unl = Settings.get('unlimitedBasics');
  for (const it of r.karten || r.cards || []) {
    const nm = String(it.name || '').trim(); let n = parseInt(it.anzahl ?? it.count ?? 1, 10) || 1;
    const basicColor = Object.keys(BASICS).find(k => BASICS[k].toLowerCase() === nm.toLowerCase());
    let p = byLower.get(nm.toLowerCase());
    if (basicColor && !p) p = { name: BASICS[basicColor], card: basicCard(basicColor), qty: unl ? 999 : 0, an: analyze(basicCard(basicColor)), base: {} };
    if (!p) { unknown.push(nm); continue; }
    const lim = p.an.isBasic ? (unl ? 99 : p.qty) : Math.min(p.qty, maxC);
    const cur = deck.get(p.name)?.n || 0;
    n = Math.max(0, Math.min(n, lim - cur));
    if (n) deck.set(p.name, { p, n: cur + n });
  }
  // Größe korrigieren
  let total = [...deck.values()].reduce((s, d) => s + d.n, 0);
  const fixes = [];
  if (total > F.size) {
    const items = [...deck.values()].sort((a, b) => (a.p.an.isLand ? 1 : 0) - (b.p.an.isLand ? 1 : 0) || baseOf(a.p, arch, F.limited) - baseOf(b.p, arch, F.limited));
    for (const d of items) { while (total > F.size && d.n > 0) { d.n--; total--; } }
    fixes.push('auf ' + F.size + ' Karten gekürzt');
  }
  if (total < F.size) {
    const lands = [...deck.values()].filter(d => d.p.an.isLand).reduce((s, d) => s + d.n, 0);
    const landTarget = F.lands[arch] || F.lands.midrange;
    let addL = Math.max(0, Math.min(F.size - total, landTarget - lands));
    let i = 0;
    while (addL > 0 && colors.length) {
      const c = colors[i++ % colors.length];
      const p = pool.get(BASICS[c]) || { name: BASICS[c], card: basicCard(c), qty: 999, an: analyze(basicCard(c)), base: {} };
      if (!unl && (deck.get(p.name)?.n || 0) >= p.qty) { if (i > 20) break; continue; }
      const d = deck.get(p.name) || { p, n: 0 }; d.n++; deck.set(p.name, d); addL--; total++;
    }
    if (total < F.size) {
      const rest = [...pool.values()].filter(p => !p.an.isLand && !p.an.excluded && (!F.legal || p.card.leg[F.legal] === 'legal') && castable(p.card, set))
        .sort((a, b) => baseOf(b, arch, F.limited) - baseOf(a, arch, F.limited));
      for (const p of rest) {
        while (total < F.size && (deck.get(p.name)?.n || 0) < Math.min(p.qty, maxC)) {
          const d = deck.get(p.name) || { p, n: 0 }; d.n++; deck.set(p.name, d); total++;
        }
        if (total >= F.size) break;
      }
    }
    fixes.push('mit Algorithmus auf ' + total + ' Karten aufgefüllt');
  }
  const cards = [...deck.values()].filter(d => d.n > 0).map(d => ({ name: d.p.name, n: d.n, sid: d.p.card.id }));
  const warnings = [];
  if (unknown.length) warnings.push(`${unknown.length} KI-Karte(n) nicht in der Sammlung, entfernt`);
  if (total < F.size) warnings.push(`Nur ${total} von ${F.size} Karten`);
  return {
    id: uid(), format, colors: sortColors(colors), arch, name: (r.name || deckName(colors, arch)) + ' ✦',
    cards, missing: [], warnings, score: null, created: Date.now(), ai: {
      archetype: r.archetyp || '', strategy: r.strategie || '', tips: r.spieltipps || [], mulligan: r.mulligan || '', unknown, fixes,
    },
  };
}

async function geminiAnalyze(deck) {
  const F = FORMATS[deck.format], set = new Set(deck.colors), maxC = maxCopies(F);
  const pool = buildPool(deck.folders || []);
  const inDeck = new Set(deck.cards.map(c => c.name));
  const list = deck.cards.map(c => { const k = cardById(c.sid); return `${c.n}x ${c.name} | ${k?.mana || '-'} | ${k?.type || ''} | ${shortText(k?.text, 110)}`; }).join('\n');
  const others = [...pool.values()].filter(p => !inDeck.has(p.name) && !p.an.excluded && !p.an.isBasic && (!F.legal || p.card.leg[F.legal] === 'legal') &&
    (p.an.isLand ? landFits(p.card, p.an, set, deck.colors.length === 1) : castable(p.card, set)))
    .sort((a, b) => baseOf(b, deck.arch, F.limited) - baseOf(a, deck.arch, F.limited)).slice(0, 160);
  const prompt = `Du bist ein erfahrener Magic: The Gathering Coach. Analysiere dieses Deck und schlage Verbesserungen vor – aber NUR mit Karten aus der Liste „Weitere verfügbare Karten“ (physische Sammlung des Spielers).
${formatRules(F)}

Deck „${deck.name}“:
${list}

Weitere verfügbare Karten (Anzahl x Name | Kosten | Typ | Text):
${others.map(p => cardLine(p, maxC)).join('\n') || '(keine)'}

Antworte NUR mit JSON:
{"bewertung":"2-4 Sätze auf Deutsch","note":"Schulnote 1-6","staerken":["..."],"schwaechen":["..."],"tausch":[{"raus":"Kartenname im Deck","rein":"Kartenname aus der Liste","anzahl":1,"grund":"kurz"}],"spieltipps":["..."]}
Maximal 6 Tauschvorschläge. Die Deckgröße muss gleich bleiben.`;
  return geminiCall(prompt, true);
}

/* ============================================================
   UI – Grundgerüst
   ============================================================ */
const sheets = [];
function openSheet(html, { full = false, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'sheet-back' + (full ? ' full-back' : '');
  back.innerHTML = `<div class="sheet ${full ? 'full' : ''}">${full ? '' : '<div class="grab"></div>'}<div class="sbody">${html}</div></div>`;
  back.addEventListener('click', e => { if (e.target === back) closeSheet(); });
  document.body.appendChild(back);
  sheets.push({ el: back, onClose });
  history.pushState({ sheet: sheets.length }, '');
  return back.querySelector('.sbody');
}
function closeSheet() { if (sheets.length) history.back(); }
function closeAllSheets() { const n = sheets.length; sheets.splice(0).forEach(s => s.el.remove()); if (n) history.go(-n); }
window.addEventListener('popstate', () => {
  const s = sheets.pop();
  if (s) { s.el.remove(); s.onClose && s.onClose(); }
});
const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const spinnerHTML = (t, sub = '') => `<div class="spinner"></div><h3>${esc(t)}</h3><p class="muted small">${sub}</p>`;

function render() {
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  const total = physical().reduce((s, e) => s + e.qty, 0);
  $('#hdrInfo').textContent = total ? `${total} Karten` : '';
  ({ collection: renderCollection, build: renderBuild, decks: renderDecks, settings: renderSettings })[state.view]();
}
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  state.view = b.dataset.view; render(); window.scrollTo(0, 0);
});

function imgTag(c, cls = '') {
  if (c && c.img) return `<img class="${cls}" loading="lazy" src="${esc(c.img)}" alt="${esc(c.name)}">`;
  return `<div class="ph ${cls}"><span class="t">${esc(c?.name || '?')}</span><span>${manaHTML(c?.mana)}</span></div>`;
}

/* ============================================================
   Sprache (Wie gescannt / Deutsch / Englisch)
   ============================================================ */
const LANG_LABEL = { en: 'EN', de: 'DE', fr: 'FR', it: 'IT', es: 'ES', pt: 'PT', ja: 'JA', ko: 'KO', ru: 'RU', zhs: 'ZH', zht: 'ZH' };

/** Zielsprache für eine Gruppe von Exemplaren (null = so wie der Druck) */
function targetLang(entries) {
  const m = Settings.get('cardLang');
  if (m === 'de' || m === 'en') return m;
  const e = entries && entries.find(x => x.lang);
  return e ? e.lang : null;
}

/** Anzeigedaten einer Karte in der Zielsprache; fehlende Versionen werden im Hintergrund nachgeladen */
function view(c, lang) {
  if (!c) return null;
  const foreign = c.lang && c.lang !== 'en';
  const own = {
    name: foreign && c.printed ? c.printed : c.name, type: foreign && c.ptype ? c.ptype : c.type,
    text: foreign && c.ptext ? c.ptext : c.text, img: c.img, imgBack: c.imgBack, lang: c.lang || 'en',
  };
  if (!lang || lang === own.lang || !c.oid) return own;
  const l = state.loc.get(c.oid + '|' + lang);
  if (l === undefined) queueLoc(c, lang);
  if (lang === 'en') {
    return { name: c.name, type: c.type, text: c.text, img: l?.img || c.img, imgBack: l?.imgBack || c.imgBack, lang: 'en' };
  }
  if (!l) return { ...own, pending: lang };
  if (l.missing) return { ...own, fallback: lang };
  return { name: l.name || c.name, type: l.type || c.type, text: l.text || c.text, img: l.img || c.img, imgBack: l.imgBack || c.imgBack, lang };
}
const displayName = (c, entries, fallback = '') => view(c, targetLang(entries))?.name || c?.name || fallback;

const locQueue = new Map();
let locTimer = null, locRunning = false;
function queueLoc(c, lang) {
  const k = c.oid + '|' + lang;
  if (state.loc.has(k) || locQueue.has(k)) return;
  locQueue.set(k, { oid: c.oid, lang });
  clearTimeout(locTimer); locTimer = setTimeout(runLocQueue, 250);
}
function locFromCard(c) {
  const faces = c.card_faces || [];
  const img = c.image_uris || faces[0]?.image_uris || {};
  return {
    name: c.printed_name || (faces.length ? faces.map(f => f.printed_name || f.name).join(' // ') : c.name),
    type: c.printed_type_line || (faces.length ? faces.map(f => f.printed_type_line || f.type_line).join(' // ') : c.type_line),
    text: c.printed_text || (faces.length ? faces.map(f => f.printed_text || f.oracle_text || '').join('\n—\n') : c.oracle_text),
    img: img.normal || '', imgBack: faces[1]?.image_uris?.normal || '',
  };
}
async function fetchLocBatch(oids, lang) {
  const q = `lang:${lang} (${oids.map(o => 'oracleid:' + o).join(' or ')})`;
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards&include_extras=true`;
  const out = new Map();
  let tries = 0;
  while (url) {
    const r = await fetch(url);
    if (r.status === 404) break;                       // keine Treffer in dieser Sprache
    if (r.status === 429 && tries++ < 3) { await sleep(1500); continue; }
    if (!r.ok) throw new Error('Scryfall HTTP ' + r.status);
    const d = await r.json();
    for (const c of d.data || []) {
      const oid = c.oracle_id || c.card_faces?.[0]?.oracle_id;
      if (oid && !out.has(oid)) out.set(oid, locFromCard(c));
    }
    url = d.has_more ? d.next_page : null;
    if (url) await sleep(100);
  }
  return out;
}
async function runLocQueue() {
  if (locRunning) return;
  locRunning = true;
  try {
    while (locQueue.size) {
      const first = locQueue.values().next().value;
      const batch = [...locQueue.values()].filter(i => i.lang === first.lang).slice(0, 20);
      batch.forEach(i => locQueue.delete(i.oid + '|' + i.lang));
      const got = await fetchLocBatch(batch.map(i => i.oid), first.lang);
      const rows = batch.map(i => ({ k: i.oid + '|' + i.lang, ...(got.get(i.oid) || { missing: true }) }));
      rows.forEach(r => state.loc.set(r.k, r));
      await DB.putMany('loc', rows);
      document.dispatchEvent(new CustomEvent('loc', { detail: new Set(batch.map(i => i.oid)) }));
      await sleep(110);
    }
  } catch (e) {
    console.warn('Sprachversionen', e);
    locQueue.clear();                                   // offline o.ä. – später erneut
  }
  locRunning = false;
}
/** Bilder sichtbarer Kacheln nach dem Nachladen aktualisieren */
document.addEventListener('loc', (ev) => {
  $$('.tile[data-oid]').forEach(t => {
    if (!ev.detail.has(t.dataset.oid)) return;
    const x = cardGroup(t.dataset.card);
    const v = x && view(x.card, targetLang(x.entries));
    const img = t.querySelector('img');
    if (v && img && v.img && img.getAttribute('src') !== v.img) img.src = v.img;
  });
});

/* ============================================================
   Ordner
   ============================================================ */
const folderName = (id) => id ? (state.folders.find(f => f.id === id)?.name || 'Unbekannter Ordner') : 'Ohne Ordner';

async function createFolder(name) {
  name = name.trim();
  if (!name) return null;
  const ex = state.folders.find(f => f.name.toLowerCase() === name.toLowerCase());
  if (ex) return ex;
  const f = { id: uid(), name, created: Date.now() };
  state.folders.push(f);
  await DB.putMany('folders', [f]);
  return f;
}

/** Einträge (ganz oder Teilmenge) in einen Ordner verschieben */
async function moveEntries(list, folder, qty = null) {
  const byKey = new Map(state.collection.map(e => [e.key, e]));
  const removed = [], touched = new Set();
  for (const e of list) {
    const n = qty == null ? e.qty : Math.min(qty, e.qty);
    if (n <= 0) continue;
    const t = { ...e, folder: folder || null, qty: n };
    t.key = entryKey(t);
    if (t.key === e.key) continue;
    const ex = byKey.get(t.key);
    if (ex) { ex.qty += n; touched.add(ex); } else { byKey.set(t.key, t); touched.add(t); }
    e.qty -= n;
    if (e.qty <= 0) { byKey.delete(e.key); removed.push(e.key); touched.delete(e); } else touched.add(e);
  }
  state.collection = [...byKey.values()];
  state.grouped = null;
  if (removed.length) await DB.delMany('collection', removed);
  await DB.putMany('collection', [...touched]);
}

async function changeQty(entry, d) {
  entry.qty += d;
  state.grouped = null;
  if (entry.qty <= 0) {
    state.collection = state.collection.filter(e => e !== entry);
    await DB.del('collection', entry.key);
  } else await DB.putMany('collection', [entry]);
}

/** Auswahl-Sheet für einen Ordner. cb(folderId|null) */
function folderPicker(title, cb, { qtyMax = 0 } = {}) {
  let qty = qtyMax;
  const body = openSheet(`<h2>${esc(title)}</h2>
    ${qtyMax > 1 ? `<div class="row" style="margin:10px 0"><span class="grow muted">Anzahl</span><button class="qbtn" data-qd="-1">−</button><b id="pq" style="width:30px;text-align:center">${qty}</b><button class="qbtn" data-qd="1">+</button></div>` : ''}
    <div class="row" style="margin:10px 0"><input type="text" id="nf" placeholder="Neuer Ordner, z. B. Avatar" class="grow"><button class="btn sm" id="nfb">Anlegen</button></div>
    ${state.folders.slice().sort((a, b) => a.name.localeCompare(b.name)).map(f => `<div class="frow" data-pick="${f.id}"><span class="ficon">${f.digital ? '🎮' : '📁'}</span><span class="grow">${esc(f.name)}${f.digital ? ' <span class="tiny muted">MTG Arena</span>' : ''}</span></div>`).join('')}
    <div class="frow" data-pick=""><span class="ficon">🗂</span><span class="grow muted">Ohne Ordner</span></div>`);
  const done = (id) => { closeSheet(); setTimeout(() => cb(id, qty), 30); };
  body.querySelectorAll('[data-pick]').forEach(r => r.onclick = () => done(r.dataset.pick || null));
  body.querySelectorAll('[data-qd]').forEach(b => b.onclick = () => { qty = Math.max(1, Math.min(qtyMax, qty + +b.dataset.qd)); body.querySelector('#pq').textContent = qty; });
  body.querySelector('#nfb').onclick = async () => { const f = await createFolder(body.querySelector('#nf').value); if (f) done(f.id); };
  if (title.includes('„')) body.querySelector('#nf').value = title.split('„')[1]?.split('“')[0] || '';
}

function openFolderMenu(id) {
  const f = state.folders.find(x => x.id === id);
  if (!f) return;
  const n = state.collection.filter(e => e.folder === id).reduce((s, e) => s + e.qty, 0);
  const body = openSheet(`<h2>Ordner bearbeiten</h2>
    <label class="field"><span>Name</span><input type="text" id="fn" value="${esc(f.name)}"></label>
    <div class="toggle"><div><b>🎮 Digitaler Ordner (MTG Arena)</b><div class="small muted">Getrennt von physischer Sammlung, Wert und normalem Deckbau</div></div><label class="switch"><input type="checkbox" id="fdig" ${f.digital ? 'checked' : ''}><span></span></label></div>
    <button class="btn primary block" id="fsave">Speichern</button>
    <button class="btn danger block" style="margin-top:10px" id="fdel">Ordner löschen</button>
    <p class="tiny muted">Die ${n} Karten darin bleiben in deiner Sammlung und landen in „Ohne Ordner“.</p>`);
  body.querySelector('#fsave').onclick = async () => {
    const v = body.querySelector('#fn').value.trim(); if (!v) return;
    f.name = v; f.digital = body.querySelector('#fdig').checked;
    state.grouped = null; state.build.folders = state.build.folders.filter(id => state.folders.some(x => x.id === id));
    await DB.putMany('folders', [f]); closeSheet(); render();
  };
  body.querySelector('#fdel').onclick = async (e) => {
    const b = e.target;
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Wirklich löschen? Nochmal tippen'; return; }
    await moveEntries(state.collection.filter(x => x.folder === id), null);
    state.folders = state.folders.filter(x => x.id !== id);
    await DB.del('folders', id);
    state.build.folders = state.build.folders.filter(x => x !== id);
    if (state.filter.folder === id) state.filter.folder = null;
    closeSheet(); toast('Ordner gelöscht'); render();
  };
}

/* ============================================================
   Preise & digitale Ordner (MTG Arena)
   ============================================================ */
const PRICE_SRC = {
  cardmarket: { label: 'Cardmarket', cur: '€', hint: 'Trendpreis in Euro' },
  tcgplayer: { label: 'TCGplayer', cur: '$', hint: 'Marktpreis in US-Dollar' },
  cardhoarder: { label: 'Cardhoarder', cur: 'tix', hint: 'MTGO-Tickets' },
  purchase: { label: 'Mein Kaufpreis', cur: '', hint: 'Kaufpreis aus dem ManaBox-Export' },
};
const priceSrc = () => PRICE_SRC[Settings.get('priceSource')] ? Settings.get('priceSource') : 'cardmarket';
/** Stückpreis eines Exemplars nach gewählter Quelle (Foil beachtet) */
function unitPrice(e, c) {
  const src = priceSrc();
  if (src === 'purchase') return +e.buy || 0;
  const p = c?.prices || { eur: c?.eur, usd: c?.usd };
  const pick = (...ks) => { for (const k of ks) { const v = parseFloat(p[k]); if (v) return v; } return 0; };
  if (src === 'tcgplayer') return e.foil ? pick('usd_foil', 'usd_etched', 'usd') : pick('usd', 'usd_foil', 'usd_etched');
  if (src === 'cardhoarder') return pick('tix');
  return e.foil ? pick('eur_foil', 'eur') : pick('eur', 'eur_foil');
}
function purchaseCur() {
  const c = state.collection.find(e => e.buyCur)?.buyCur || 'EUR';
  return { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF' }[c] || c;
}
function fmtMoney(v, exact = false) {
  if (!v) return '–';
  const src = priceSrc();
  const cur = src === 'purchase' ? purchaseCur() : PRICE_SRC[src].cur;
  const n = !exact && v >= 100 ? Math.round(v).toLocaleString('de-DE') : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === '$' ? `$${n}` : `${n} ${cur}`;
}
const entriesValue = (es) => es.reduce((s, e) => s + (isDigital(e) ? 0 : unitPrice(e, state.cards.get(e.sid)) * e.qty), 0);

const digitalIds = () => new Set(state.folders.filter(f => f.digital).map(f => f.id));
const isDigitalFolder = (id) => !!id && !!state.folders.find(f => f.id === id)?.digital;
const isDigital = (e) => isDigitalFolder(e.folder);
/** Physische Sammlung (ohne digitale Ordner) */
function physical() { const d = digitalIds(); return d.size ? state.collection.filter(e => !d.has(e.folder)) : state.collection; }
const nameOf = (e) => state.cards.get(e.sid)?.name || e.name;
/** Alle Exemplare einer Karte (physisch und digital) */
function cardGroup(name) { return groupEntries(state.collection.filter(e => nameOf(e) === name))[0]; }
/** Bestand, gegen den ein Deck geprüft wird: digitale Decks → ihre Ordner, sonst physische Sammlung */
function ownedGroups(deck) {
  if (deck?.digital) return groupEntries(state.collection.filter(e => (deck.folders || []).includes(e.folder || '_none')));
  return grouped();
}

/** Kartendaten (v. a. Preise) für die ganze Sammlung neu laden – Scryfall aktualisiert Preise täglich */
async function refreshAllCards(onProgress) {
  const ids = [...new Set(state.collection.map(e => e.sid).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 75) {
    const data = await scryCollection(ids.slice(i, i + 75).map(id => ({ id })));
    const fresh = (data.data || []).map(slimCard);
    fresh.forEach(c => { state.cards.set(c.id, c); anCache.delete(c.id); });
    await DB.putMany('cards', fresh);
    onProgress && onProgress(Math.min(i + 75, ids.length), ids.length);
    await sleep(110);
  }
  Settings.set('lastCardRefresh', Date.now());
  state.grouped = null;
}

/** Textliste importieren: „4 Lightning Bolt (M10) 146“ (MTG Arena, Moxfield, MTGO …) */
function parseList(text) {
  const out = new Map();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || /^(deck|sideboard|commander|companion|maybeboard|about|name\b|\/\/)/i.test(line)) continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([\w\-★*]+))?)?(?:\s+\*F\*)?\s*$/);
    if (!m) continue;
    const ARENA_SET = { dar: 'dom', conf: 'con' };   // Arena-Kürzel, die von Scryfall abweichen
    const sc = (m[3] || '').toLowerCase();
    const e = { name: m[2].trim(), sid: '', set: ARENA_SET[sc] || sc, setName: '', number: m[4] || '', foil: /\*F\*/.test(line), qty: +m[1], lang: '', cond: '', binder: '', folder: null, buy: 0, buyCur: '' };
    const k = `${e.name.toLowerCase()}|${e.set}|${e.number}|${e.foil}`;
    const x = out.get(k); if (x) x.qty += e.qty; else out.set(k, e);
  }
  return [...out.values()];
}
function openListImport(defaultFolder = null) {
  let folder = defaultFolder;
  const body = openSheet(`<h2>Liste einfügen</h2>
    <p class="small muted">Eine Karte pro Zeile, z. B. <code>4 Lightning Bolt (M10) 146</code> oder <code>2 Counterspell</code>. Passt zum Export aus MTG Arena, Moxfield, Archidekt oder MTGO.</p>
    <textarea id="ltext" rows="9" placeholder="4 Lightning Bolt (M10) 146&#10;2 Counterspell"></textarea>
    <div class="row" style="margin:10px 0"><span class="grow small muted">Ziel</span><button class="fchip on" id="lfolder">📁 ${esc(folderName(folder))}</button></div>
    <button class="btn primary block" id="lok">Importieren</button>`);
  body.querySelector('#lfolder').onclick = () => folderPicker('Liste importieren in', (id) => { folder = id; body.querySelector('#lfolder').textContent = (isDigitalFolder(id) ? '🎮 ' : '📁 ') + folderName(id); });
  body.querySelector('#lok').onclick = async () => {
    const entries = parseList(body.querySelector('#ltext').value);
    if (!entries.length) { toast('Keine Kartenzeilen erkannt.'); return; }
    entries.forEach(e => { e.folder = folder || null; });
    closeSheet();
    await doImport(entries, 'merge');
  };
}

/* ============================================================
   Sammlung
   ============================================================ */
function groupEntries(entries) {
  const g = new Map();
  for (const e of entries) {
    const c = e.sid && state.cards.get(e.sid);
    const name = c ? c.name : e.name;
    let x = g.get(name);
    if (!x) { x = { name, card: c || null, qty: 0, foil: 0, entries: [] }; g.set(name, x); }
    x.qty += e.qty; if (e.foil) x.foil += e.qty; x.entries.push(e);
    if ((!x.card || !x.card.img) && c) x.card = c;
  }
  return [...g.values()];
}
function grouped() { return state.grouped || (state.grouped = groupEntries(physical())); }

function scopeEntries() {
  const f = state.filter;
  if (f.folder == null && f.set == null) return physical();
  return (f.folder == null ? physical() : state.collection).filter(e =>
    (f.folder == null || (f.folder === '_none' ? !e.folder : e.folder === f.folder)) &&
    (f.set == null || (state.cards.get(e.sid)?.set || e.set) === f.set));
}

function filteredCollection() {
  const f = state.filter, q = f.q.trim().toLowerCase();
  const base = (f.folder == null && f.set == null) ? grouped() : groupEntries(scopeEntries());
  const list = base.filter(x => {
    const c = x.card;
    if (q) {
      const de = c?.oid ? state.loc.get(c.oid + '|de')?.name : '';
      const hay = [x.name, c?.printed, de, c?.type, c?.ptype].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.colors.length) {
      if (!c) return false;
      const cols = analyze(c).isLand ? c.ci : c.colors;
      if (!f.colors.some(fc => fc === 'M' ? cols.length > 1 : fc === 'C' ? cols.length === 0 : cols.includes(fc))) return false;
    }
    if (f.type && (!c || !new RegExp(f.type).test(c.type))) return false;
    return true;
  });
  const price = (x) => entriesValue(x.entries);
  const sorters = {
    name: (a, b) => displayName(a.card, a.entries, a.name).localeCompare(displayName(b.card, b.entries, b.name)) || a.name.localeCompare(b.name),
    cmc: (a, b) => (a.card?.cmc ?? 99) - (b.card?.cmc ?? 99) || a.name.localeCompare(b.name),
    qty: (a, b) => b.qty - a.qty || a.name.localeCompare(b.name),
    price: (a, b) => price(b) - price(a),
  };
  return list.sort(sorters[f.sort]);
}

function backupHint() {
  const last = +Settings.get('lastBackup') || 0;
  const hasWork = state.decks.length || state.folders.length;
  if (!hasWork || Date.now() - last < 14 * 864e5) return '';
  return `<div class="panel small row" style="border-color:var(--ai-line)"><span>💾</span><span class="grow">${last ? 'Letztes Backup vor ' + Math.floor((Date.now() - last) / 864e5) + ' Tagen.' : 'Noch kein Backup deiner Decks und Ordner.'}</span><button class="btn sm" data-act="backup">Sichern</button></div>`;
}

function renderCollection() {
  const main = $('#main');
  state.select = null; updateSelectBar();
  if (!state.collection.length) {
    main.innerHTML = `<div class="empty">
      <svg class="art" viewBox="0 0 120 120"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--gold-hi)"/><stop offset="1" style="stop-color:var(--gold2)"/></linearGradient></defs>
      <rect x="30" y="18" width="52" height="74" rx="7" style="fill:var(--card2)" stroke="url(#g1)" stroke-width="3" transform="rotate(-10 56 55)"/>
      <rect x="40" y="24" width="52" height="74" rx="7" style="fill:var(--card)" stroke="url(#g1)" stroke-width="3" transform="rotate(8 66 61)"/>
      <circle cx="66" cy="60" r="11" fill="none" stroke="url(#g1)" stroke-width="3"/><path d="M66 44v7M66 69v7M50 60h7M75 60h7" stroke="url(#g1)" stroke-width="3" stroke-linecap="round"/></svg>
      <h2>Deine Sammlung ist noch leer</h2>
      <p>Scanne deine Karten direkt mit der Kamera, importiere einen ManaBox-Export oder stelle ein Backup wieder her.</p>
      <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap"><button class="btn primary" data-act="scan">📷 Karten scannen</button><button class="btn" data-act="import">ManaBox-CSV importieren</button></div>
      <div style="margin-top:10px"><button class="btn ghost sm" data-act="restore">Backup wiederherstellen</button></div>
      <div class="panel" style="margin-top:22px;text-align:left"><h3 style="margin-bottom:6px">So exportierst du aus ManaBox</h3>
      <ol class="how small"><li>ManaBox öffnen → <b>Sammlung</b> (oder einen Binder)</li><li>Menü <b>⋮</b> → <b>Exportieren</b> → <b>CSV</b></li><li>Datei speichern oder direkt teilen</li><li>Hier auf „importieren“ tippen und die Datei auswählen</li></ol>
      <p class="tiny muted">Binder aus ManaBox werden automatisch zu Ordnern.</p></div>
    </div>`;
    return;
  }
  const f = state.filter;
  const tabs = `<div class="seg" id="ctabs" style="margin-top:10px">
    ${[['all', 'Alle'], ['folders', `Ordner${state.folders.length ? ' · ' + state.folders.length : ''}`], ['sets', 'Sets']].map(([v, l]) => `<button data-tab="${v}" class="${state.tab === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  let content;
  if (state.tab === 'folders' && f.folder == null) content = folderListHTML();
  else if (state.tab === 'sets' && f.set == null) content = setListHTML();
  else content = gridViewHTML();
  main.innerHTML = backupHint() + tabs + content + `<button class="fab" data-act="scan" aria-label="Karten scannen">📷</button>`;
  $$('#ctabs button').forEach(b => b.onclick = () => {
    state.tab = b.dataset.tab; f.folder = null; f.set = null; f.limit = 150; render(); window.scrollTo(0, 0);
  });
  if ($('#gridWrap')) wireGrid();
  $$('[data-folder]').forEach(r => r.addEventListener('click', e => {
    if (e.target.closest('[data-fmenu]')) { openFolderMenu(e.target.closest('[data-fmenu]').dataset.fmenu); return; }
    f.folder = r.dataset.folder; f.limit = 150; render(); window.scrollTo(0, 0);
  }));
  $$('[data-setcode]').forEach(r => r.onclick = () => { f.set = r.dataset.setcode; f.limit = 150; render(); window.scrollTo(0, 0); });
  $('#newFolder')?.addEventListener('click', () => {
    const body = openSheet(`<h2>Neuer Ordner</h2><label class="field"><span>Name</span><input type="text" id="fn" placeholder="z. B. Avatar, Hobbit, MTG Arena"></label>
      <div class="toggle"><div><b>🎮 Digitaler Ordner (MTG Arena)</b><div class="small muted">Zählt nicht zur physischen Sammlung, zum Wert und zum normalen Deckbau</div></div><label class="switch"><input type="checkbox" id="fdig"><span></span></label></div>
      <button class="btn primary block" id="fok">Anlegen</button>`);
    const inp = body.querySelector('#fn'); setTimeout(() => inp.focus(), 100);
    body.querySelector('#fok').onclick = async () => {
      const f = await createFolder(inp.value);
      if (!f) return;
      if (body.querySelector('#fdig').checked && !f.digital) { f.digital = true; await DB.putMany('folders', [f]); state.grouped = null; }
      closeSheet(); render();
    };
  });
}

function thumbs(entries, n = 3) {
  const g = groupEntries(entries).filter(x => x.card?.img).sort((a, b) => (a.card.rank || 1e6) - (b.card.rank || 1e6)).slice(0, n);
  return `<div class="thumbs">${g.map(x => `<img loading="lazy" src="${esc(view(x.card, targetLang(x.entries)).img)}" alt="">`).join('') || '<div class="phm"></div>'}</div>`;
}

function folderListHTML() {
  const rows = state.folders.slice().sort((a, b) => (a.digital ? 1 : 0) - (b.digital ? 1 : 0) || a.name.localeCompare(b.name)).map(fo => {
    const es = state.collection.filter(e => e.folder === fo.id);
    const val = fo.digital ? 0 : entriesValue(es);
    return `<div class="sugg" data-folder="${fo.id}" style="--stripe:${fo.digital ? 'var(--ai)' : 'var(--gold)'}">${thumbs(es)}
      <div class="grow"><h3>${fo.digital ? '🎮' : '📁'} ${esc(fo.name)}</h3><div class="small muted">${es.reduce((s, e) => s + e.qty, 0)} Karten · ${groupEntries(es).length} verschiedene${fo.digital ? ' · MTG Arena' : val ? ' · ' + fmtMoney(val) : ''}</div></div>
      <button class="iconbtn" data-fmenu="${fo.id}" aria-label="Ordner bearbeiten">⋯</button></div>`;
  }).join('');
  const none = state.collection.filter(e => !e.folder);
  return `<button class="btn block" id="newFolder" style="margin-top:12px">＋ Neuer Ordner</button>
    ${rows || '<p class="small muted" style="text-align:center;margin:18px 0">Noch keine eigenen Ordner. Lege z. B. „Avatar“ oder „Hobbit“ an. Unter <b>Sets</b> kannst du ein ganzes Set mit einem Tipp in einen Ordner schieben.</p>'}
    ${none.length ? `<div class="sugg" data-folder="_none" style="--stripe:var(--line)">${thumbs(none)}<div class="grow"><h3 class="muted">🗂 Ohne Ordner</h3><div class="small muted">${none.reduce((s, e) => s + e.qty, 0)} Karten</div></div></div>` : ''}`;
}

function setListHTML() {
  const sets = new Map();
  for (const e of physical()) {
    const c = state.cards.get(e.sid);
    const code = c?.set || e.set || '?';
    const s = sets.get(code) || { code, name: c?.setName || e.setName || code.toUpperCase(), qty: 0, names: new Set() };
    s.qty += e.qty; s.names.add(c?.name || e.name); sets.set(code, s);
  }
  const list = [...sets.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  return `<p class="small muted" style="margin:12px 2px 4px">${list.length} Sets in deiner Sammlung</p>
    ${list.map(s => `<div class="crow" data-setcode="${esc(s.code)}">
      <img class="seticon" src="https://svgs.scryfall.io/sets/${encodeURIComponent(s.code)}.svg" alt="" onerror="this.style.visibility='hidden'">
      <span class="nm">${esc(s.name)} <span class="tiny dim">${esc(s.code.toUpperCase())}</span></span>
      <span class="small muted">${s.names.size} · <b style="color:var(--gold)">${s.qty}</b></span></div>`).join('')}`;
}

function gridViewHTML() {
  const f = state.filter;
  const es = scopeEntries();
  const total = es.reduce((s, e) => s + e.qty, 0);
  const digitalScope = isDigitalFolder(f.folder);
  const value = entriesValue(es);
  const missing = es.filter(e => !e.sid || !state.cards.has(e.sid)).length;
  const scopeTitle = f.folder != null ? (digitalScope ? '🎮 ' : '📁 ') + esc(f.folder === '_none' ? 'Ohne Ordner' : folderName(f.folder))
    : f.set != null ? esc(state.cards.get(es[0]?.sid)?.setName || f.set.toUpperCase()) : '';
  const fc = (v, label) => `<button class="fchip ${f.colors.includes(v) ? 'on' : ''}" data-fcolor="${v}">${label}</button>`;
  return `
    ${scopeTitle ? `<div class="scopehead"><button class="iconbtn" id="scopeBack">${ICON.back}</button><h2 class="grow" style="font-size:17px">${scopeTitle}</h2>
      ${f.folder && f.folder !== '_none' ? `<button class="iconbtn" data-fmenu2="${f.folder}">⋯</button>` : ''}
      ${f.set != null ? `<button class="btn sm" id="setToFolder">In Ordner …</button>` : ''}</div>` : ''}
    <div class="stats" style="margin-top:10px">
      <div class="stat"><b>${total}</b><span>Karten</span></div>
      <div class="stat"><b>${groupEntries(es).length}</b><span>verschiedene</span></div>
      ${digitalScope ? '<div class="stat"><b>🎮</b><span>MTG Arena</span></div>' : `<div class="stat"><b>${fmtMoney(value)}</b><span>Wert · ${PRICE_SRC[priceSrc()].label}</span></div>`}
    </div>
    ${f.folder != null && f.folder !== '_none' ? `<button class="btn block sm" id="listImp" style="margin-top:8px">＋ Liste einfügen (z. B. Arena-Export)</button>` : ''}
    ${missing ? `<div class="panel small row"><span class="chip warn">${missing}</span><span class="grow">Einträge ohne Kartendaten. <a href="#" data-act="refetch">Jetzt nachladen</a></span></div>` : ''}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Karte, Typ suchen …" value="${esc(f.q)}" class="grow">
      <button class="btn sm" id="selBtn">Auswählen</button>
      <button class="btn sm" data-act="import" title="Importieren">＋ CSV</button>
    </div>
    <div class="filters">
      ${COLORS.map(c => fc(c, `<span class="pip ${c}"></span>`)).join('')}${fc('C', 'Farblos')}${fc('M', 'Mehrfarbig')}
      <select id="ftype" class="fchip" style="min-height:0;width:auto;padding:6px 10px">
        ${[['', 'Alle Typen'], ['Creature', 'Kreaturen'], ['Instant', 'Spontanzauber'], ['Sorcery', 'Hexereien'], ['Artifact', 'Artefakte'], ['Enchantment', 'Verzauberungen'], ['Planeswalker', 'Planeswalker'], ['Land', 'Länder']]
      .map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="fsort" class="fchip" style="min-height:0;width:auto;padding:6px 10px">
        ${[['name', 'A–Z'], ['cmc', 'Manawert'], ['qty', 'Anzahl'], ['price', 'Wert']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>Sortierung: ${l}</option>`).join('')}
      </select>
    </div>
    <div id="gridWrap"></div>`;
}

function wireGrid() {
  const f = state.filter;
  renderGrid();
  let t;
  $('#q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; f.limit = 150; renderGrid(); }, 180); });
  $('#ftype').addEventListener('change', e => { f.type = e.target.value; renderGrid(); });
  $('#fsort').addEventListener('change', e => { f.sort = e.target.value; renderGrid(); });
  $$('[data-fcolor]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.fcolor; const i = f.colors.indexOf(v);
    i >= 0 ? f.colors.splice(i, 1) : f.colors.push(v);
    b.classList.toggle('on'); f.limit = 150; renderGrid();
  }));
  $('#scopeBack')?.addEventListener('click', () => { f.folder = null; f.set = null; render(); });
  $('#listImp')?.addEventListener('click', () => openListImport(f.folder));
  $('[data-fmenu2]')?.addEventListener('click', e => openFolderMenu(e.currentTarget.dataset.fmenu2));
  $('#setToFolder')?.addEventListener('click', () => {
    const es = scopeEntries();
    const name = state.cards.get(es[0]?.sid)?.setName || f.set.toUpperCase();
    folderPicker(`Ganzes Set in Ordner verschieben („${name}“)`, async (id) => {
      const n = es.reduce((s, e) => s + e.qty, 0);
      await moveEntries(es.slice(), id);
      toast(`${n} Karten → ${folderName(id)}`);
      render();
    });
  });
  $('#selBtn').addEventListener('click', () => {
    state.select = state.select ? null : new Set();
    $('#selBtn').textContent = state.select ? 'Fertig' : 'Auswählen';
    renderGrid(); updateSelectBar();
  });
}

function tileHTML(x) {
  const v = x.card ? view(x.card, targetLang(x.entries)) : null;
  const c = x.card ? { ...x.card, img: v.img, name: v.name } : { name: x.name };
  const sel = state.select?.has(x.name);
  return `<div class="tile ${sel ? 'selected' : ''}" data-card="${esc(x.name)}" ${x.card?.oid ? `data-oid="${x.card.oid}"` : ''}>${imgTag(c)}<span class="qty">${x.qty}×</span>${x.foil ? `<span class="foil">${x.foil === x.qty ? 'FOIL' : x.foil + '× FOIL'}</span>` : ''}${state.select ? `<span class="check">${sel ? '✓' : ''}</span>` : ''}</div>`;
}

function renderGrid() {
  const list = filteredCollection();
  state.gridList = list.map(x => x.name);
  const shown = list.slice(0, state.filter.limit);
  $('#gridWrap').innerHTML = `
    <div class="tiny muted" style="margin-top:8px">${list.length} Treffer${state.select ? ' · tippe Karten an, um sie auszuwählen' : ''}</div>
    <div class="grid">${shown.map(tileHTML).join('')}</div>
    ${list.length > shown.length ? `<button class="btn block" style="margin-top:12px" id="more">Weitere ${Math.min(150, list.length - shown.length)} anzeigen</button>` : ''}`;
  $('#more')?.addEventListener('click', () => { state.filter.limit += 150; renderGrid(); });
}

function updateSelectBar() {
  let bar = $('#selbar');
  if (!state.select) { bar && bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'selbar'; bar.className = 'selbar'; document.body.appendChild(bar); }
  const n = state.select.size;
  bar.innerHTML = `<span class="grow"><b>${n}</b> ausgewählt</span>
    <button class="btn sm" id="selAll">Alle</button>
    <button class="btn sm primary" id="selMove" ${n ? '' : 'disabled'}>In Ordner …</button>`;
  bar.querySelector('#selAll').onclick = () => { (state.gridList || []).forEach(nm => state.select.add(nm)); renderGrid(); updateSelectBar(); };
  bar.querySelector('#selMove').onclick = () => {
    const names = state.select;
    const es = scopeEntries().filter(e => names.has(state.cards.get(e.sid)?.name || e.name));
    folderPicker(`${n} Karte(n) verschieben`, async (id) => {
      const cnt = es.reduce((s, e) => s + e.qty, 0);
      await moveEntries(es, id);
      toast(`${cnt} Karten → ${folderName(id)}`);
      state.select = null; render();
    });
  };
}

/* Kartendetails mit Blättern */
function decksUsing(name) { return state.decks.filter(d => d.cards.some(c => c.name === name)); }

function cardDetailHTML(name, idx, total) {
  const x = cardGroup(name);
  const c = x?.card || state.decks.flatMap(d => d.cards).filter(k => k.name === name).map(k => cardById(k.sid)).find(Boolean);
  const nav = total > 1 ? `<button class="iconbtn" data-nav="-1" ${idx === 0 ? 'disabled' : ''}>${ICON.back}</button><span class="small muted" style="min-width:64px;text-align:center">${idx + 1} / ${total}</span><button class="iconbtn" data-nav="1" ${idx === total - 1 ? 'disabled' : ''} style="transform:scaleX(-1)">${ICON.back}</button>` : '';
  const head = `<div class="row" style="margin-bottom:8px">${nav}<span class="grow"></span><button class="iconbtn" data-close>${ICON.close}</button></div>`;
  if (!c) return head + `<p class="muted" style="text-align:center;padding:40px 0">Keine Kartendaten zu „${esc(name)}“.</p>`;
  const v = view(c, targetLang(x?.entries));
  const legal = ['standard', 'pioneer', 'modern', 'pauper'].map(k => `<span class="chip ${c.leg?.[k] === 'legal' ? 'good' : 'bad'}">${FORMATS[k].label}</span>`).join(' ');
  const used = decksUsing(name);
  const src = priceSrc();
  const phys = x ? x.entries.filter(e => !isDigital(e)) : [];
  const unit = unitPrice({ foil: false, buy: phys[0]?.buy }, c), unitFoil = src !== 'purchase' ? unitPrice({ foil: true }, c) : 0;
  const shopUrl = c.shop?.[src === 'purchase' ? 'cardmarket' : src];
  const priceRow = `<div class="panel small" style="margin:10px 0">
      <div class="row"><span class="grow muted">Preis · ${PRICE_SRC[src].label}</span><b>${fmtMoney(unit, true)}</b>${unitFoil && unitFoil !== unit ? `<span class="muted">· Foil ${fmtMoney(unitFoil, true)}</span>` : ''}</div>
      ${phys.length ? `<div class="row" style="margin-top:4px"><span class="grow muted">Deine ${phys.reduce((s, e) => s + e.qty, 0)} Exemplare</span><b style="color:var(--gold)">${fmtMoney(entriesValue(phys), true)}</b></div>` : ''}
      ${shopUrl ? `<a href="${esc(shopUrl)}" target="_blank" rel="noopener" class="tiny">Bei ${src === 'purchase' ? 'Cardmarket' : PRICE_SRC[src].label} ansehen ↗</a>` : ''}
    </div>`;
  return `${head}
    <div class="cimgWrap">${v.img ? `<img class="cardimg" id="cimg" src="${esc(v.img)}" alt="${esc(v.name)}">` : `<div class="cardimg ph" style="aspect-ratio:488/680"><span class="t">${esc(v.name)}</span></div>`}</div>
    <p class="tiny muted" style="text-align:center;margin:6px 0 0">${total > 1 ? 'Wischen zum Blättern' : ''}${total > 1 && v.imgBack ? ' · ' : ''}${v.imgBack ? 'Bild antippen zum Umdrehen' : ''}</p>
    <div class="row" style="margin-top:12px"><h2 class="grow">${esc(v.name)}</h2>${manaHTML(c.mana)}</div>
    ${v.name !== c.name ? `<div class="muted small">${esc(c.name)}</div>` : ''}
    ${v.fallback ? `<div class="tiny muted" style="margin-top:2px">Keine ${esc((LANG_LABEL[v.fallback] || v.fallback).toUpperCase())}-Version bei Scryfall – Anzeige auf ${esc((LANG_LABEL[v.lang] || v.lang).toUpperCase())}${/Token/.test(c.type) ? ' (Token gibt es dort fast nur auf Englisch)' : ''}.</div>` : ''}
    <div class="muted small" style="margin:4px 0 10px">${esc(v.type)}</div>
    ${v.text ? `<div class="oracle">${esc(v.text)}</div>` : ''}
    <div class="row wrap" style="margin:12px 0">${legal}</div>
    ${priceRow}
    ${x ? `<h3 style="margin:16px 0 6px">Deine Exemplare (${x.qty})</h3>
      ${x.entries.map((e, i) => { const k = state.cards.get(e.sid); return `<div class="erow">
        <div class="grow small"><div>${esc(k?.setName || e.setName || e.set.toUpperCase())} #${esc(k?.num || e.number)}${e.foil ? ' · <b style="color:#f6a">Foil</b>' : ''} <span class="chip" style="padding:1px 6px;font-size:10.5px">${LANG_LABEL[e.lang || k?.lang] || (e.lang || k?.lang || 'EN').toUpperCase()}</span></div>
        <button class="linkbtn" data-emove="${i}">${isDigital(e) ? '🎮' : '📁'} ${esc(folderName(e.folder))}</button>${!isDigital(e) && unitPrice(e, k) ? ` <span class="tiny muted">· ${fmtMoney(unitPrice(e, k), true)}/Stk.${e.buy && src !== 'purchase' ? ` · gekauft ${e.buy.toLocaleString('de-DE', { minimumFractionDigits: 2 })} ${esc(e.buyCur || '')}` : ''}</span>` : ''}</div>
        <button class="qbtn" data-eq="${i}" data-d="-1">−</button><b style="width:26px;text-align:center">${e.qty}</b><button class="qbtn" data-eq="${i}" data-d="1">+</button></div>`; }).join('')}` : ''}
    ${used.length ? `<h3 style="margin:16px 0 6px">In Decks</h3>${used.map(d => `<div class="kv small"><span>${esc(d.name)}</span><b>${d.cards.find(k => k.name === name).n}×</b></div>`).join('')}` : ''}
    ${x && !analyze(c).isLand ? `<button class="btn block primary" style="margin-top:16px" data-around>Deck um diese Karte bauen</button>` : ''}`;
}

function openCard(name, list) {
  list = list && list.length ? list : [name];
  let idx = Math.max(0, list.indexOf(name));
  let edited = false;
  const onLoc = () => draw();
  const body = openSheet('', {
    onClose: () => {
      document.removeEventListener('loc', onLoc);
      if (edited && state.view === 'collection') render();
    },
  });
  const sheet = body.parentElement;
  const draw = (dir = 0) => {
    body.innerHTML = cardDetailHTML(list[idx], idx, list.length);
    if (dir) { body.classList.remove('slide-l', 'slide-r'); void body.offsetWidth; body.classList.add(dir > 0 ? 'slide-l' : 'slide-r'); }
    const img = body.querySelector('#cimg');
    const x = cardGroup(list[idx]);
    const v = x?.card && view(x.card, targetLang(x.entries));
    if (img && v?.imgBack) { let back = false; img.onclick = () => { back = !back; img.src = back ? v.imgBack : v.img; }; }
  };
  const go = (d) => { const n = idx + d; if (n < 0 || n >= list.length) return; idx = n; draw(d); sheet.scrollTop = 0; };
  document.addEventListener('loc', onLoc);
  draw();
  body.addEventListener('click', async e => {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    const nv = e.target.closest('[data-nav]');
    if (nv) { go(+nv.dataset.nav); return; }
    const x = cardGroup(list[idx]);
    const q = e.target.closest('[data-eq]');
    if (q && x) {
      await changeQty(x.entries[+q.dataset.eq], +q.dataset.d); edited = true; draw(); return;
    }
    const mv = e.target.closest('[data-emove]');
    if (mv && x) {
      const en = x.entries[+mv.dataset.emove];
      folderPicker('Exemplar verschieben', async (id, qty) => { await moveEntries([en], id, qty); edited = true; draw(); }, { qtyMax: en.qty });
      return;
    }
    if (e.target.closest('[data-around]')) {
      state.build.forced = list[idx]; state.build.colorMode = 'all'; state.view = 'build';
      closeAllSheets(); render(); window.scrollTo(0, 0);
    }
  });
  // Wischgesten
  let sx = 0, sy = 0, st = 0;
  sheet.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
  sheet.addEventListener('touchend', e => {
    const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - st < 700) go(dx < 0 ? 1 : -1);
  }, { passive: true });
  sheet.addEventListener('keydown', e => { if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); });
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-card]');
  if (t) {
    if (state.select) {
      const n = t.dataset.card;
      state.select.has(n) ? state.select.delete(n) : state.select.add(n);
      t.classList.toggle('selected');
      const ck = t.querySelector('.check'); if (ck) ck.textContent = state.select.has(n) ? '✓' : '';
      updateSelectBar();
      return;
    }
    openCard(t.dataset.card, state.gridList);
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  e.preventDefault();
  const act = a.dataset.act;
  if (act === 'import') $('#csvInput').click();
  if (act === 'refetch') refetchCards();
  if (act === 'backup') exportBackup();
  if (act === 'restore') $('#jsonInput').click();
  if (act === 'scan') openScanner();
});

/* ============================================================
   Import
   ============================================================ */
$('#csvInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  let entries;
  try { entries = parseManaBox(await file.text()); }
  catch (e) { toast(e.message, 5000); return; }
  const total = entries.reduce((s, e) => s + e.qty, 0);
  const binders = new Set(entries.map(e => e.binder).filter(Boolean));
  if (!state.collection.length && !state.folders.some(f => f.digital)) return doImport(entries, 'replace');
  let target = null;
  const body = openSheet(`<h2>Import</h2>
    <p class="muted">${entries.length} Einträge mit insgesamt <b>${total}</b> Karten erkannt${binders.size ? ` aus ${binders.size} Binder(n) → werden zu Ordnern` : ''}.</p>
    <div class="row" style="margin:6px 0 12px"><span class="grow small muted">Ziel</span><button class="fchip on" id="itarget">Ganze Sammlung</button></div>
    <button class="btn primary block" data-m="replace" id="irep">Sammlung ersetzen</button>
    <p class="tiny muted" style="margin:4px 2px 12px" id="irephint">Empfohlen beim Export der kompletten Sammlung. Ordnerzuordnungen und digitale Ordner bleiben erhalten.</p>
    <button class="btn block" data-m="merge">Hinzufügen</button>
    <p class="tiny muted" style="margin:4px 2px">Für einzelne Binder oder Neuzugänge.</p>`);
  body.querySelector('#itarget').onclick = () => folderPicker('Import in Ordner', (id) => {
    target = id;
    body.querySelector('#itarget').textContent = id ? (isDigitalFolder(id) ? '🎮 ' : '📁 ') + folderName(id) : 'Ganze Sammlung';
    body.querySelector('#irep').textContent = id ? 'Ordner ersetzen' : 'Sammlung ersetzen';
    body.querySelector('#irephint').textContent = id ? 'Ersetzt nur den Inhalt dieses Ordners.' : 'Empfohlen beim Export der kompletten Sammlung. Ordnerzuordnungen und digitale Ordner bleiben erhalten.';
  });
  body.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    closeSheet();
    if (target) entries.forEach(e => { if (!e.binder) e.folder = target; });
    doImport(entries, b.dataset.m, target);
  });
});

/** Ordnerzuordnung alter Einträge auf neue (ohne Binder) übertragen */
function preserveFolders(entries, old) {
  const dist = new Map();
  for (const e of old) if (e.folder) {
    const k = printKey(e);
    if (!dist.has(k)) dist.set(k, []);
    dist.get(k).push({ folder: e.folder, qty: e.qty });
  }
  const out = [];
  for (const e of entries) {
    const d = !e.folder && dist.get(printKey(e));
    if (!d) { out.push(e); continue; }
    let rest = e.qty;
    for (const x of d) {
      const n = Math.min(x.qty, rest);
      if (n <= 0) continue;
      out.push({ ...e, folder: x.folder, qty: n }); x.qty -= n; rest -= n;
    }
    if (rest > 0) out.push({ ...e, qty: rest });
  }
  return out;
}
function normalizeCollection(coll) {
  const m = new Map();
  for (const e of coll) {
    e.folder = e.folder || null;
    e.key = entryKey(e);
    const x = m.get(e.key);
    if (x) x.qty += e.qty; else m.set(e.key, e);
  }
  return [...m.values()];
}

async function doImport(entries, mode, target = null) {
  // Binder → Ordner
  const byName = new Map(state.folders.map(f => [f.name.toLowerCase(), f]));
  const newFolders = [];
  for (const e of entries) {
    if (!e.binder) continue;
    let f = byName.get(e.binder.toLowerCase());
    if (!f) { f = { id: uid(), name: e.binder, created: Date.now() }; byName.set(e.binder.toLowerCase(), f); newFolders.push(f); }
    e.folder = f.id;
  }
  // Ersetzen betrifft nur den Zielbereich: einen Ordner – oder die physische Sammlung (digitale Ordner bleiben)
  const keep = mode === 'merge' ? state.collection.map(e => ({ ...e }))
    : target ? state.collection.filter(e => e.folder !== target).map(e => ({ ...e }))
      : state.collection.filter(e => isDigital(e)).map(e => ({ ...e }));
  const oldScope = mode === 'merge' ? [] : target ? state.collection.filter(e => e.folder === target) : physical();
  let coll = keep.concat(entries);
  overlay(spinnerHTML('Lade Kartendaten von Scryfall …', 'Bei großen Sammlungen kann das etwas dauern.'));
  let notFound = [], offline = false;
  try {
    notFound = await enrichFromScryfall(coll, (d, t, pass) =>
      overlay(spinnerHTML(pass ? 'Zweiter Versuch über Kartennamen …' : 'Lade Kartendaten von Scryfall …', `${d} / ${t}<div class="bar"><i style="width:${Math.round(d / t * 100)}%"></i></div>`)));
  } catch (e) { offline = true; console.warn(e); }
  notFound = notFound.filter(e => entries.includes(e));
  if (mode !== 'merge' && !target) coll = keep.concat(preserveFolders(entries, oldScope));
  coll = normalizeCollection(coll);
  if (newFolders.length) { state.folders.push(...newFolders); await DB.putMany('folders', newFolders); }
  await DB.clear('collection'); await DB.putMany('collection', coll);
  state.collection = coll; state.grouped = null;
  overlay(); state.view = 'collection'; render();
  const total = coll.reduce((s, e) => s + e.qty, 0);
  if (offline) toast('Scryfall nicht erreichbar – Kartendaten später nachladen (Einstellungen).', 6000);
  else if (notFound.length) {
    const body = openSheet(`<h2>Import fertig</h2><p class="muted">${total} Karten importiert${newFolders.length ? `, ${newFolders.length} neue Ordner` : ''}. ${notFound.length} Einträge wurden bei Scryfall nicht gefunden und werden beim Deckbau ignoriert:</p>
      <ul class="list-plain small">${notFound.slice(0, 60).map(e => `<li>${esc(e.name)} <span class="dim">(${esc(e.set.toUpperCase())} ${esc(e.number)})</span></li>`).join('')}</ul>
      <button class="btn block" style="margin-top:14px" data-close>OK</button>`);
    body.querySelector('[data-close]').onclick = closeSheet;
  } else toast(`Import fertig: ${total} Karten${newFolders.length ? ` · ${newFolders.length} neue Ordner` : ''} ✓`);
}

async function refetchCards() {
  overlay(spinnerHTML('Lade Kartendaten …'));
  try {
    const nf = await enrichFromScryfall(state.collection, (d, t) => overlay(spinnerHTML('Lade Kartendaten …', `${d} / ${t}`)));
    const old = state.collection.map(e => e.key);
    state.collection = normalizeCollection(state.collection);
    await DB.delMany('collection', old); await DB.putMany('collection', state.collection);
    state.grouped = null;
    toast(nf.length ? `${nf.length} Einträge weiterhin nicht gefunden` : 'Alle Kartendaten geladen ✓');
  } catch { toast('Scryfall nicht erreichbar.'); }
  overlay(); render();
}

/* ============================================================
   Backup
   ============================================================ */
function backupData(withKey) {
  const settings = { ...Settings.data };
  if (!withKey) delete settings.geminiKey;
  return {
    app: 'manaforge', format: 1, version: APP_VERSION, created: new Date().toISOString(),
    collection: state.collection, folders: state.folders, decks: state.decks, settings,
  };
}
function exportBackup() {
  const total = state.collection.reduce((s, e) => s + e.qty, 0);
  const body = openSheet(`<h2>Backup erstellen</h2>
    <p class="small muted">Sichert Sammlung (${total} Karten), ${state.folders.length} Ordner, ${state.decks.length} Decks und Einstellungen in eine Datei. Kartenbilder und -texte werden beim Wiederherstellen neu von Scryfall geladen.</p>
    <div class="toggle"><div><b>Gemini-Key mitsichern</b><div class="small muted">Nur aktivieren, wenn du die Datei nicht weitergibst</div></div>
      <label class="switch"><input type="checkbox" id="bkey"><span></span></label></div>
    <div class="row" style="margin-top:8px"><button class="btn primary grow" id="bdl">Herunterladen</button>${navigator.canShare ? '<button class="btn grow" id="bsh">Teilen …</button>' : ''}</div>
    <p class="tiny muted" style="margin-top:8px">„Teilen“ speichert z. B. direkt in Google Drive oder schickt die Datei per Mail.</p>`);
  const make = () => {
    const json = JSON.stringify(backupData(body.querySelector('#bkey').checked));
    const name = `manaforge-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return { json, name, blob: new Blob([json], { type: 'application/json' }) };
  };
  const ok = () => { Settings.set('lastBackup', Date.now()); toast('Backup erstellt ✓'); closeSheet(); if (state.view === 'settings' || state.view === 'collection') setTimeout(render, 60); };
  body.querySelector('#bdl').onclick = () => {
    const { blob, name } = make();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ok();
  };
  body.querySelector('#bsh')?.addEventListener('click', async () => {
    const { blob, name } = make();
    const file = new File([blob], name, { type: 'application/json' });
    if (!navigator.canShare({ files: [file] })) { toast('Teilen von Dateien wird hier nicht unterstützt – bitte „Herunterladen“.'); return; }
    try { await navigator.share({ files: [file], title: 'Manaforge-Backup' }); ok(); }
    catch (e) { if (e.name !== 'AbortError') toast('Teilen fehlgeschlagen: ' + e.message); }
  });
}

$('#jsonInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Die Datei ist kein gültiges Backup.'); return; }
  if (data?.app !== 'manaforge' || !Array.isArray(data.collection)) { toast('Das ist kein Manaforge-Backup.'); return; }
  const total = data.collection.reduce((s, e) => s + (e.qty || 0), 0);
  const body = openSheet(`<h2>Backup wiederherstellen</h2>
    <p class="muted">Backup vom <b>${new Date(data.created).toLocaleString('de-DE')}</b> (v${esc(data.version)}):<br>${total} Karten · ${(data.folders || []).length} Ordner · ${(data.decks || []).length} Decks</p>
    <p class="small" style="color:var(--warn)">⚠ Deine aktuelle Sammlung, Ordner und Decks auf diesem Gerät werden ersetzt.</p>
    <button class="btn primary block" id="rok">Wiederherstellen</button>`);
  body.querySelector('#rok').onclick = async () => {
    closeSheet();
    const coll = normalizeCollection(data.collection.map(e => ({ ...e })));
    await Promise.all(['collection', 'folders', 'decks'].map(s => DB.clear(s)));
    await DB.putMany('collection', coll); await DB.putMany('folders', data.folders || []); await DB.putMany('decks', data.decks || []);
    state.collection = coll; state.folders = data.folders || []; state.decks = (data.decks || []).sort((a, b) => b.created - a.created);
    state.grouped = null; state.results = []; state.filter.folder = null; state.filter.set = null;
    const key = Settings.get('geminiKey');
    Object.entries(data.settings || {}).forEach(([k, v]) => Settings.set(k, v));
    if (!data.settings?.geminiKey && key) Settings.set('geminiKey', key);
    if (state.collection.some(e => !e.sid || !state.cards.has(e.sid))) await refetchCards();
    else render();
    toast('Backup wiederhergestellt ✓');
  };
});

/* ============================================================
   Scanner (Kamera → Texterkennung auf dem Gerät → Scryfall, Gemini als Fallback)
   ============================================================ */
const TESS = {
  lib: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
  lang: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
};
const CARD_LANG = { EN: 'en', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', SP: 'es', PT: 'pt', JP: 'ja', JA: 'ja', KO: 'ko', KR: 'ko', RU: 'ru', CS: 'zhs', CT: 'zht', PH: 'ph' };
// Bereiche relativ zur Karte (x0, y0, x1, y1)
const NAME_BOX = [0.05, 0.03, 0.80, 0.105];
const INFO_BOX = [0.025, 0.885, 0.66, 0.985];
const NAME_BOX_TIGHT = [0.06, 0.04, 0.75, 0.10];
let ocr = null;

function loadScript(src) {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((res, rej) => {
    [...document.scripts].filter(x => x.src === src).forEach(x => x.remove());   // fehlgeschlagenen Versuch entfernen
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => window.Tesseract ? res() : rej(new Error('Texterkennung unvollständig geladen'));
    s.onerror = () => { s.remove(); rej(new Error('Konnte Texterkennung nicht laden (Internet?)')); };
    document.head.appendChild(s);
  });
}
async function initOCR(onStatus) {
  if (ocr) return ocr;
  await loadScript(TESS.lib);
  const opts = { workerPath: TESS.worker, corePath: TESS.core, langPath: TESS.lang, logger: m => onStatus && onStatus(m) };
  const [info, name, name2] = await Promise.all([1, 2, 3].map(() => Tesseract.createWorker('eng', 1, opts)));
  await info.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/•·.*-', tessedit_pageseg_mode: '6' });
  await name.setParameters({ tessedit_pageseg_mode: '11' });
  await name2.setParameters({ tessedit_pageseg_mode: '7' });
  return (ocr = { info, name, name2 });
}

/* --- Bildverarbeitung --- */
function subRect(r, b) { return { x: r.x + r.w * b[0], y: r.y + r.h * b[1], w: r.w * (b[2] - b[0]), h: r.h * (b[3] - b[1]) }; }
/** Ausschnitt vergrößern, in Graustufen, bei dunklem Hintergrund invertieren, Kontrast strecken */
function prepCrop(src, r, targetH) {
  const scale = Math.max(1, targetH / r.h);
  const c = document.createElement('canvas');
  c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  const hist = new Uint32Array(256); let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = v; hist[v]++; sum += v; }
  const n = d.length / 4, mean = sum / n, inv = mean < 110;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  const k = 255 / Math.max(20, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = Math.max(0, Math.min(255, (d[i] - lo) * k));
    if (inv) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(im, 0, 0);
  return c;
}
/** Tatsächliche Kartenkanten im Bereich um den Rahmen suchen (Kantenprofile) – gleicht ungenaues Halten aus */
function findCard(src, g) {
  const pad = 0.14;
  const sx = Math.max(0, g.x - g.w * pad), sy = Math.max(0, g.y - g.h * pad);
  const sw = Math.min(src.width - sx, g.w * (1 + 2 * pad)), sh = Math.min(src.height - sy, g.h * (1 + 2 * pad));
  const W = 240, H = Math.round(W * sh / sw);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x2 = c.getContext('2d', { willReadFrequently: true });
  x2.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  const d = x2.getImageData(0, 0, W, H).data, gr = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gr[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
  const col = new Float32Array(W), row = new Float32Array(H);
  const y0 = Math.round(H * 0.25), y1 = Math.round(H * 0.75), xa = Math.round(W * 0.25), xb = Math.round(W * 0.75);
  for (let y = y0; y < y1; y++) for (let x = 1; x < W - 1; x++) col[x] += Math.abs(gr[y * W + x + 1] - gr[y * W + x - 1]);
  for (let y = 1; y < H - 1; y++) for (let x = xa; x < xb; x++) row[y] += Math.abs(gr[(y + 1) * W + x] - gr[(y - 1) * W + x]);
  const outer = (p, from, to, dir) => {
    let mx = 0; for (let i = from; i < to; i++) mx = Math.max(mx, p[i]);
    if (mx <= 0) return null;
    if (dir > 0) { for (let i = from; i < to; i++) if (p[i] >= mx * 0.55) return i; }
    else { for (let i = to - 1; i >= from; i--) if (p[i] >= mx * 0.55) return i; }
    return null;
  };
  const l = outer(col, 1, Math.round(W * 0.4), 1), r = outer(col, Math.round(W * 0.6), W - 1, -1);
  const t = outer(row, 1, Math.round(H * 0.4), 1), b = outer(row, Math.round(H * 0.6), H - 1, -1);
  if ([l, r, t, b].some(v => v == null)) return g;
  const k = sw / W;
  const res = { x: sx + l * k, y: sy + t * k, w: (r - l) * k, h: (b - t) * k };
  const ar = res.w / res.h, sz = res.h / g.h;
  return Math.abs(ar - 63 / 88) < 0.07 && sz > 0.7 && sz < 1.25 ? res : g;
}
function thumbOf(src, r) {
  const c = document.createElement('canvas'); c.width = 24; c.height = 34;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, 24, 34);
  const d = g.getImageData(0, 0, 24, 34).data, out = new Float32Array(24 * 34);
  let m = 0;
  for (let i = 0; i < out.length; i++) { out[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; m += out[i]; }
  m /= out.length;
  let v = 0; for (const x of out) v += (x - m) ** 2;
  out.variance = v / out.length;
  return out;
}
const thumbDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

/* --- Texte auswerten --- */
function parseInfo(t) {
  const T = (t || '').toUpperCase().replace(/[•·*]/g, ' • ');
  const out = [];
  const langRx = /([A-Z0-9]{3,5})\s*[•.\-~]?\s*(EN|DE|FR|IT|ES|SP|PT|JP|JA|KO|KR|RU|CS|CT|PH)(?![A-Z])/g;
  let m;
  const sets = [];
  while ((m = langRx.exec(T))) sets.push({ set: m[1].toLowerCase(), lang: CARD_LANG[m[2]] });
  // Sprachcode unlesbar? Set-Code = erstes Buchstabenwort der Zeile nach der Nummer
  if (!sets.length) {
    const lines = T.split('\n').map(l => l.trim()).filter(Boolean);
    const ni = lines.findIndex(l => /\d{2,}/.test(l));
    const tok = (lines[ni + 1] || lines[lines.length - 1] || '').match(/[A-Z0-9]{3,6}/);
    if (tok && /[A-Z].*[A-Z]/.test(tok[0])) { sets.push({ set: tok[0].slice(0, 3).toLowerCase(), lang: null }); if (tok[0].length > 3) sets.push({ set: tok[0].slice(0, 4).toLowerCase(), lang: null }); }
  }
  const nums = [];
  for (const mm of T.matchAll(/(?<![A-Z0-9])(\d{1,8})(?:\s*\/\s*(\d{1,4}))?(?![0-9])/g)) {
    let raw = mm[1];
    if (raw.length === 4 && +raw >= 1993 && +raw <= 2035 && !raw.startsWith('0')) continue; // Jahreszahl
    if (raw.length > 4) { // „/“ nicht erkannt, z. B. 0004281 = 0004/281
      nums.push({ num: String(+raw.slice(0, 4)), strong: raw.startsWith('0') }, { num: String(+raw.slice(0, 3)), strong: false });
      continue;
    }
    nums.push({ num: String(+raw), strong: !!mm[2] || raw.startsWith('0') });
  }
  nums.sort((a, b) => b.strong - a.strong);
  for (const s of sets.slice(0, 2)) for (const n of nums.slice(0, 2)) out.push({ ...s, ...n });
  return out.slice(0, 4);
}
/** Aus dem Namensbereich die Zeile mit den meisten Buchstaben nehmen */
const cleanName = (t) => (t || '').split('\n')
  .map(l => l.replace(/[^A-Za-zÀ-ÿß',\- ]/g, ' ').replace(/\s+/g, ' ').trim())
  .sort((a, b) => b.replace(/[^A-Za-zÀ-ÿß]/g, '').length - a.replace(/[^A-Za-zÀ-ÿß]/g, '').length)[0] || '';
const normName = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function nameScoreOne(ocrName, card) {
  const a = normName(ocrName);
  if (a.length < 3) return 0;
  const cands = [card.printed_name, card.name, ...(card.card_faces || []).flatMap(f => [f.printed_name, f.name])].filter(Boolean).map(normName);
  return Math.max(0, ...cands.map(b => {
    const bb = b.slice(0, Math.max(a.length, Math.min(b.length, a.length + 3)));  // abgeschnittene Namen tolerieren
    return 1 - lev(a, bb) / Math.max(a.length, bb.length);
  }));
}

/* --- Scryfall-Abfragen (mit Cache) --- */
const scryCache = new Map();
function scryGet(url) {
  if (!scryCache.has(url)) scryCache.set(url, fetch(url).then(r => r.ok ? r.json() : null).catch(() => null));
  return scryCache.get(url);
}
async function lookupPrint(set, num, lang) {
  let c = lang && lang !== 'en' ? await scryGet(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(num)}/${lang}`) : null;
  if (!c) c = await scryGet(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(num)}`);
  return c && c.object !== 'error' ? c : null;
}
async function lookupByName(name, set, lang) {
  let c = await scryGet(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}${set ? '&set=' + encodeURIComponent(set) : ''}`);
  if (!c && set) c = await scryGet(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
  if (!c || c.object === 'error') return null;
  if (lang && lang !== 'en' && c.lang !== lang) c = (await lookupPrint(c.set, c.collector_number, lang)) || c;
  return c;
}

/** Ein Erkennungsversuch auf dem Gerät. Ergebnis: {card, sure, how} oder null */
async function recognizeLocal(cv, r, lockedSet) {
  const infoC = prepCrop(cv, subRect(r, INFO_BOX), 150);
  const nameC = prepCrop(cv, subRect(r, NAME_BOX), 72);
  // Name zweifach lesen (lockerer + enger Ausschnitt, verschiedene Modi) – parallel, robuster gegen Rahmenlinien
  const nameC2 = prepCrop(cv, subRect(r, NAME_BOX_TIGHT), 72);
  const [ri, n1, n2] = await Promise.all([ocr.info.recognize(infoC), ocr.name.recognize(nameC), ocr.name2.recognize(nameC2)]);
  const names = [cleanName(n1.data.text), cleanName(n2.data.text)].filter(t => normName(t).length >= 3);
  const nameTxt = names.sort((a, b) => normName(b).length - normName(a).length)[0] || '';
  const nameScore = (_, card) => Math.max(0, ...names.map(t => nameScoreOne(t, card)));
  let cands = parseInfo(ri.data.text);
  if (lockedSet) cands = cands.map(c => ({ ...c, set: lockedSet })).concat(cands);
  const dbg = { info: ri.data.text.trim(), name: nameTxt };
  let fallback = null;
  const pref = Settings.get('cardLang') === 'en' ? 'en' : 'de';
  for (const cd of cands) {
    const card = await lookupPrint(cd.set, cd.num, cd.lang);
    if (!card) continue;
    if (nameScore(nameTxt, card) >= 0.6) return { card, sure: true, how: 'Nummer + Name', dbg };
    // Sprache unklar oder falsch gelesen: andere Sprachversionen desselben Drucks über den Namen prüfen
    if (normName(nameTxt).length >= 4) {
      for (const L of [pref, 'de', 'en', 'fr', 'it', 'es', 'pt'].filter((x, i, a) => a.indexOf(x) === i && x !== cd.lang)) {
        const c2 = L === 'en' ? await scryGet(`https://api.scryfall.com/cards/${encodeURIComponent(cd.set)}/${encodeURIComponent(cd.num)}`) : await scryGet(`https://api.scryfall.com/cards/${encodeURIComponent(cd.set)}/${encodeURIComponent(cd.num)}/${L}`);
        if (c2 && c2.object !== 'error' && nameScore(nameTxt, c2) >= 0.6) return { card: c2, sure: true, how: 'Nummer + Name', dbg };
      }
    }
    if (!fallback && cd.lang) fallback = { card, sure: false, how: 'Nummer', dbg };
  }
  const lang0 = cands[0]?.lang;
  if (normName(nameTxt).length >= 4) {
    const card = await lookupByName(nameTxt, lockedSet || cands[0]?.set, lang0);
    if (card && nameScore(nameTxt, card) >= 0.6) {
      const setOk = (lockedSet && card.set === lockedSet) || cands.some(c => c.set === card.set);
      return { card, sure: setOk, how: setOk ? 'Name + Set' : 'Name', dbg };
    }
  }
  return fallback ? fallback : { card: null, dbg };
}

async function recognizeGemini(cv, r) {
  const c = document.createElement('canvas');
  const s = Math.min(1, 900 / r.h);
  c.width = Math.round(r.w * s); c.height = Math.round(r.h * s);
  c.getContext('2d').drawImage(cv, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
  const prompt = `Identifiziere diese Magic: The Gathering Karte auf dem Foto. Lies unten links Set-Code, Sammlernummer und Sprachcode, falls vorhanden.
Antworte NUR mit JSON: {"name":"englischer Kartenname","printed_name":"Name wie aufgedruckt","set":"Set-Code klein","number":"Sammlernummer ohne führende Nullen","lang":"en|de|fr|it|es|pt|ja|ko|ru|zhs|zht","confidence":0.0}
Wenn keine Karte erkennbar ist: {"name":null}`;
  const r2 = await geminiCall([{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: prompt }], true);
  if (!r2?.name) return null;
  let card = r2.set && r2.number ? await lookupPrint(String(r2.set).toLowerCase(), String(r2.number).replace(/^0+/, ''), r2.lang) : null;
  if (card && nameScoreOne(r2.name, card) < 0.6 && nameScoreOne(r2.printed_name || '', card) < 0.6) card = null;
  if (!card) card = await lookupByName(r2.name, r2.set ? String(r2.set).toLowerCase() : null, r2.lang);
  return card ? { card, sure: (r2.confidence ?? 0.8) >= 0.6, how: 'Gemini' } : null;
}

/* --- Sammlung ergänzen --- */
async function addScanned(sc, opts) {
  const s = slimCard(sc);
  if (!state.cards.has(s.id)) { state.cards.set(s.id, s); await DB.putMany('cards', [s]); }
  const e = { name: s.name, sid: s.id, set: s.set, setName: s.setName, number: s.num, foil: !!opts.foil, qty: 1, lang: s.lang, cond: '', binder: '', folder: opts.folder || null };
  e.key = entryKey(e);
  const ex = state.collection.find(x => x.key === e.key);
  if (ex) { ex.qty++; await DB.putMany('collection', [ex]); } else { state.collection.push(e); await DB.putMany('collection', [e]); }
  state.grouped = null;
  return e.key;
}
async function undoScanned(key) {
  const e = state.collection.find(x => x.key === key);
  if (e) await changeQty(e, -1);
}

/* --- Scanner-Oberfläche --- */
function openScanner() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Kamera wird von diesem Browser nicht unterstützt.'); return; }
  const S = Settings;
  const cfg = { folder: S.get('scanFolder') || null, foil: false, lockedSet: S.get('scanSet') || '' };
  if (cfg.folder && !state.folders.some(f => f.id === cfg.folder)) cfg.folder = null;
  const session = [];
  let stream = null, timer = null, busy = false, closed = false, paused = false;
  let lastUnsure = null, prev = null, stable = 0, armed = true, accepted = null, fails = 0, lastTry = 0, geminiTried = false, pending = null, torch = false;

  const body = openSheet(`
    <div class="scanwrap" id="scanwrap">
      <video id="scanvid" playsinline muted autoplay></video>
      <div class="scanframe" id="scanframe"><i class="nb"></i><i class="ib"></i></div>
      <div class="scantop">
        <button class="iconbtn" data-x>${ICON.close}</button>
        <span class="grow"></span>
        <button class="iconbtn" id="torch" title="Licht">🔦</button>
      </div>
      <div class="scanstatus" id="sstat">Starte Kamera …</div>
    </div>
    <div class="scanctl">
      <button class="fchip on" id="sfolder">📁 ${esc(folderName(cfg.folder))}</button>
      <button class="fchip ${cfg.foil ? 'on' : ''}" id="sfoil">✨ Foil</button>
      <button class="fchip ${cfg.lockedSet ? 'on' : ''}" id="sset">Set: ${cfg.lockedSet ? esc(cfg.lockedSet.toUpperCase()) : 'auto'}</button>
    </div>
    <div class="row" style="gap:8px;margin:8px 0">
      <button class="btn grow" id="sshot">Auslösen</button>
      <button class="btn grow" id="sagain" disabled title="Letzte Karte noch einmal hinzufügen">＋1</button>
      <button class="btn grow" id="ssearch">Suchen</button>
    </div>
    <div id="spending"></div>
    <div class="row" style="margin-top:6px"><h3 class="grow">Gescannt <span id="scount" class="muted small"></span></h3></div>
    <div id="slist"><p class="small muted">Halte die Karte gerade und füllend in den Rahmen – die Zeile unten links (Nummer · Set · Sprache) sollte gut lesbar sein.</p></div>`,
  { full: true, onClose: stop });
  const video = body.querySelector('#scanvid'), wrap = body.querySelector('#scanwrap'), frameEl = body.querySelector('#scanframe');
  const stat = (t, cls = '') => { const el = body.querySelector('#sstat'); if (el) { el.textContent = t; el.className = 'scanstatus ' + cls; } };
  const cv = document.createElement('canvas');

  function stop() {
    closed = true; clearInterval(timer);
    stream && stream.getTracks().forEach(t => t.stop());
    if (state.view === 'collection') render();
  }
  /** Rahmen in Videokoordinaten (object-fit: cover beachten) */
  function guideRect() {
    const W = wrap.clientWidth, H = wrap.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
    const gh = Math.min(H * 0.86, W * 0.8 * 88 / 63), gw = gh * 63 / 88;
    const gx = (W - gw) / 2, gy = (H - gh) / 2;
    Object.assign(frameEl.style, { left: gx + 'px', top: gy + 'px', width: gw + 'px', height: gh + 'px' });
    const sc = Math.max(W / vw, H / vh), ox = (W - vw * sc) / 2, oy = (H - vh * sc) / 2;
    return { x: (gx - ox) / sc, y: (gy - oy) / sc, w: gw / sc, h: gh / sc };
  }
  function grab() {
    if (cv.width !== video.videoWidth) { cv.width = video.videoWidth; cv.height = video.videoHeight; }
    cv.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
    return guideRect();
  }

  function renderList() {
    const total = session.reduce((s, x) => s + x.n, 0);
    body.querySelector('#scount').textContent = total ? `· ${total}` : '';
    body.querySelector('#sagain').disabled = !session.length;
    if (!session.length) return;
    body.querySelector('#slist').innerHTML = session.map((x, i) => `<div class="erow">
      ${x.img ? `<img src="${esc(x.img)}" alt="" onerror="this.style.visibility='hidden'" style="width:34px;height:47px;border-radius:4px;object-fit:cover">` : ''}
      <div class="grow small"><b>${esc(x.name)}</b>${x.n > 1 ? ` <span style="color:var(--gold)">×${x.n}</span>` : ''}<div class="tiny muted">${esc(x.set.toUpperCase())} #${esc(x.num)} · ${LANG_LABEL[x.lang] || x.lang.toUpperCase()}${x.foil ? ' · Foil' : ''} · ${esc(x.how)}</div></div>
      <button class="qbtn" data-undo="${i}" title="Rückgängig">↶</button></div>`).join('');
  }
  async function accept(card, how) {
    const key = await addScanned(card, cfg);
    const v = view(slimCard(card), card.lang);
    const last = session[0];
    if (last && last.key === key) last.n++;
    else session.unshift({ key, name: v.name, set: card.set, num: card.collector_number, lang: card.lang, foil: cfg.foil, img: v.img, how, n: 1 });
    navigator.vibrate?.(60);
    stat(`✓ ${v.name} · ${card.set.toUpperCase()} · ${(LANG_LABEL[card.lang] || card.lang).toUpperCase()}`, 'ok');
    renderList();
  }
  function showPending(card, how) {
    paused = true;
    const v = view(slimCard(card), card.lang);
    navigator.vibrate?.([30, 40, 30]);
    stat('Bitte bestätigen', 'warn');
    body.querySelector('#spending').innerHTML = `<div class="ai-box" style="margin:4px 0;display:flex;gap:10px;align-items:center">
      ${v.img ? `<img src="${esc(v.img)}" style="width:60px;border-radius:6px" alt="">` : ''}
      <div class="grow small"><b>${esc(v.name)}</b><div class="tiny muted">${esc(card.set_name)} · #${esc(card.collector_number)} · ${(LANG_LABEL[card.lang] || card.lang).toUpperCase()} · erkannt über ${esc(how)}</div>
      <div class="row" style="gap:6px;margin-top:6px"><button class="btn sm primary" data-pok>Hinzufügen</button><button class="btn sm" data-pprint>Anderer Druck</button><button class="btn sm ghost" data-pno>Verwerfen</button></div></div></div>`;
    pending = { card, how };
  }
  function clearPending() { body.querySelector('#spending').innerHTML = ''; pending = null; paused = false; }

  async function attempt(force = false) {
    if (busy || closed || paused) return;
    busy = true;
    try {
      const g = grab();
      const r = findCard(cv, g);
      window.__scanRect = r;
      stat('Erkenne …');
      let res = await recognizeLocal(cv, r, cfg.lockedSet);
      if (!res.card && fails >= 1 && !geminiTried && Settings.get('geminiKey')) {
        geminiTried = true; stat('Frage Gemini …');
        try { res = (await recognizeGemini(cv, r)) || res; } catch (e) { console.warn(e); stat('Gemini: ' + e.message, 'warn'); }
      }
      if (closed) return;
      if (res.card && (res.sure || res.how === 'Gemini')) {
        await accept(res.card, res.how);
        armed = false; accepted = thumbOf(cv, g); fails = 0; geminiTried = false; pending = null;
      } else if (res.card) {
        // unsicher: zweimal dasselbe Ergebnis = sicher, sonst nachfragen
        if (lastUnsure === res.card.id) { await accept(res.card, res.how + ' (2×)'); armed = false; accepted = thumbOf(cv, g); fails = 0; lastUnsure = null; }
        else if (force || fails >= 2) showPending(res.card, res.how);
        else { lastUnsure = res.card.id; fails++; stat('Fast … Karte ruhig halten'); }
      } else {
        fails++;
        stat(fails >= 3 ? 'Nicht erkannt – Licht/Winkel ändern oder „Suchen“' : 'Karte ruhig und gerade halten …', fails >= 3 ? 'warn' : '');
      }
      window.__scanDebug = res.dbg;
    } catch (e) { console.error(e); stat('Fehler: ' + e.message, 'warn'); }
    finally { busy = false; lastTry = Date.now(); }
  }

  function tick() {
    if (busy || closed || paused || !video.videoWidth) return;
    const r = grab();
    const th = thumbOf(cv, r);
    const d = prev ? thumbDiff(th, prev) : 255;
    prev = th;
    if (!armed && accepted && thumbDiff(th, accepted) > 22) { armed = true; fails = 0; geminiTried = false; stat('Bereit'); }
    stable = d < 7 && th.variance > 250 ? stable + 1 : 0;
    if (armed && stable >= 2 && Date.now() - lastTry > (fails ? 900 : 150)) attempt();
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (closed) { stream.getTracks().forEach(t => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      guideRect();
      window.addEventListener('resize', () => !closed && video.videoWidth && guideRect());
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() || {};
      if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      if (!caps.torch) body.querySelector('#torch').style.display = 'none';
    } catch (e) {
      stat(e.name === 'NotAllowedError' ? 'Kamera-Zugriff verweigert – bitte in Chrome erlauben' : 'Kamera nicht verfügbar: ' + e.message, 'warn');
      return;
    }
    stat('Lade Texterkennung … (einmalig ca. 7 MB)');
    try {
      let ready = false;
      await initOCR(m => { if (!ready && m.status && !/recogniz/.test(m.status) && m.progress != null && m.progress < 1) stat(`Lade Texterkennung … ${Math.round(m.progress * 100)} %`); });
      ready = true;
    } catch (e) { stat(e.message, 'warn'); return; }
    if (closed) return;
    stat('Halte eine Karte in den Rahmen');
    timer = setInterval(tick, 220);
  }

  body.addEventListener('click', async e => {
    if (e.target.closest('[data-x]')) { closeSheet(); return; }
    const u = e.target.closest('[data-undo]');
    if (u) {
      const x = session[+u.dataset.undo];
      await undoScanned(x.key); x.n--;
      if (x.n <= 0) session.splice(+u.dataset.undo, 1);
      renderList(); if (!session.length) body.querySelector('#slist').innerHTML = '';
      toast('Rückgängig gemacht'); return;
    }
    if (e.target.closest('[data-pok]') && pending) { const p = pending; clearPending(); await accept(p.card, p.how); armed = false; accepted = prev; fails = 0; return; }
    if (e.target.closest('[data-pno]')) { clearPending(); fails = 0; lastUnsure = null; stat('Verworfen'); return; }
    if (e.target.closest('[data-pprint]') && pending) { const p = pending; clearPending(); paused = true; pickPrint(p.card.name, async c => { paused = false; if (c) { await accept(c, 'manuell'); armed = false; accepted = prev; } }); return; }
  });
  body.querySelector('#torch').onclick = async () => {
    const t = stream?.getVideoTracks()[0]; if (!t) return;
    torch = !torch; await t.applyConstraints({ advanced: [{ torch }] }).catch(() => { torch = false; });
    body.querySelector('#torch').classList.toggle('on', torch);
  };
  body.querySelector('#sfoil').onclick = (e) => { cfg.foil = !cfg.foil; e.currentTarget.classList.toggle('on', cfg.foil); };
  body.querySelector('#sfolder').onclick = () => {
    paused = true;
    folderPicker('Gescannte Karten in Ordner', (id) => { cfg.folder = id; S.set('scanFolder', id || ''); body.querySelector('#sfolder').textContent = '📁 ' + folderName(id); paused = false; });
    sheets[sheets.length - 1].onClose = () => { paused = false; };
  };
  body.querySelector('#sset').onclick = () => {
    paused = true;
    const sb = openSheet(`<h2>Set festlegen</h2><p class="small muted">Optional, wie „Set sperren“ in ManaBox: Hilft bei schwer lesbaren Karten, wenn du einen Stapel aus einem Set scannst.</p>
      <label class="field"><span>Set-Code (z. B. MOM, LTR, TLA)</span><input type="text" id="setc" value="${esc(cfg.lockedSet.toUpperCase())}" maxlength="6" style="text-transform:uppercase"></label>
      <div class="row"><button class="btn primary grow" id="setok">Übernehmen</button><button class="btn grow" id="setauto">Automatisch</button></div>`, { onClose: () => { paused = false; } });
    const apply = (v) => { cfg.lockedSet = v.trim().toLowerCase(); S.set('scanSet', cfg.lockedSet); const b = body.querySelector('#sset'); b.textContent = 'Set: ' + (cfg.lockedSet ? cfg.lockedSet.toUpperCase() : 'auto'); b.classList.toggle('on', !!cfg.lockedSet); closeSheet(); };
    sb.querySelector('#setok').onclick = () => apply(sb.querySelector('#setc').value);
    sb.querySelector('#setauto').onclick = () => apply('');
  };
  body.querySelector('#sshot').onclick = () => { armed = true; geminiTried = fails >= 1 ? geminiTried : false; attempt(true); };
  body.querySelector('#sagain').onclick = async () => {
    const x = session[0]; if (!x) return;
    const c = state.cards.get(state.collection.find(e => e.key === x.key)?.sid);
    if (!c) return;
    const e = state.collection.find(k => k.key === x.key); e.qty++; await DB.putMany('collection', [e]); state.grouped = null;
    x.n++; navigator.vibrate?.(40); renderList();
  };
  body.querySelector('#ssearch').onclick = () => {
    paused = true;
    manualAdd(async c => { paused = false; if (c) await accept(c, 'Suche'); });
  };
  start();
}

/** Karte per Namenssuche wählen, dann Druck + Sprache */
function manualAdd(cb) {
  let done = false;
  const body = openSheet(`<h2>Karte suchen</h2>
    <input type="search" id="msq" placeholder="Englischer Kartenname …" autocomplete="off">
    <div id="msres" style="margin-top:8px"></div>`, { onClose: () => { if (!done) cb(null); } });
  const inp = body.querySelector('#msq'); setTimeout(() => inp.focus(), 150);
  let t;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim(); if (q.length < 2) return;
      const r = await scryGet(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`);
      body.querySelector('#msres').innerHTML = (r?.data || []).slice(0, 12).map(n => `<div class="frow" data-mn="${esc(n)}">${esc(n)}</div>`).join('') || '<p class="small muted">Keine Treffer</p>';
    }, 250);
  });
  body.addEventListener('click', e => {
    const r = e.target.closest('[data-mn]'); if (!r) return;
    done = true; closeSheet();
    setTimeout(() => pickPrint(r.dataset.mn, cb), 60);
  });
}
function pickPrint(name, cb) {
  let done = false;
  const body = openSheet(`<h2>${esc(name)}</h2><p class="small muted">Welcher Druck und welche Sprache?</p>
    <div class="seg" id="pplang" style="margin-bottom:8px">${['en', 'de', 'fr', 'it', 'es', 'ja'].map(l => `<button data-l="${l}" class="${l === (Settings.get('cardLang') === 'de' ? 'de' : 'en') ? 'on' : ''}">${l.toUpperCase()}</button>`).join('')}</div>
    <div id="pplist"><div class="spinner" style="margin:20px auto"></div></div>`, { onClose: () => { if (!done) cb(null); } });
  let lang = Settings.get('cardLang') === 'de' ? 'de' : 'en';
  body.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { lang = b.dataset.l; body.querySelectorAll('[data-l]').forEach(x => x.classList.toggle('on', x === b)); });
  scryGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent('!"' + name + '"')}&unique=prints&order=released`).then(r => {
    const list = r?.data || [];
    body.querySelector('#pplist').innerHTML = list.slice(0, 60).map((c, i) => {
      const img = c.image_uris?.small || c.card_faces?.[0]?.image_uris?.small || '';
      return `<div class="erow" data-pp="${i}" style="cursor:pointer">${img ? `<img src="${esc(img)}" style="width:40px;border-radius:4px" alt="">` : ''}<div class="grow small"><b>${esc(c.set_name)}</b><div class="tiny muted">${esc(c.set.toUpperCase())} #${esc(c.collector_number)} · ${esc(c.released_at || '')}</div></div></div>`;
    }).join('') || '<p class="small muted">Keine Drucke gefunden.</p>';
    body.querySelectorAll('[data-pp]').forEach(el => el.onclick = async () => {
      const c = list[+el.dataset.pp];
      const card = (await lookupPrint(c.set, c.collector_number, lang)) || c;
      if (lang !== 'en' && card.lang !== lang) toast(`Keine ${lang.toUpperCase()}-Version dieses Drucks – Englisch übernommen`);
      done = true; closeSheet(); cb(card);
    });
  });
}

/* ============================================================
   Deckbau
   ============================================================ */
function renderBuild() {
  const b = state.build, main = $('#main');
  if (!state.collection.length) {
    main.innerHTML = `<div class="empty"><h2>Erst die Sammlung importieren</h2><p>Für Deckvorschläge brauche ich deine Karten.</p><button class="btn primary" data-act="import">ManaBox-CSV importieren</button></div>`;
    return;
  }
  const names = grouped().filter(x => x.card && !analyze(x.card).isLand).map(x => x.name).sort();
  const seg = (key, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${b[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const hasKey = !!Settings.get('geminiKey');
  main.innerHTML = `
    <div class="panel">
      <label class="field"><span>Format</span></label>
      <div class="filters" data-seg="format">${Object.entries(FORMATS).filter(([, F]) => !F.arena || state.folders.some(f => f.digital)).map(([k, F]) => `<button class="fchip ${b.format === k ? 'on' : ''}" data-v="${k}">${F.label}</button>`).join('')}</div>
      ${state.folders.length ? `<label class="field"><span>Karten aus</span></label>
      <div class="filters" id="bfolders"><button class="fchip ${b.folders.length ? '' : 'on'}" data-bf="">Ganze Sammlung (physisch)</button>
        ${state.folders.map(f => `<button class="fchip ${b.folders.includes(f.id) ? 'on' : ''}" data-bf="${f.id}">${f.digital ? '🎮' : '📁'} ${esc(f.name)}</button>`).join('')}
        <button class="fchip ${b.folders.includes('_none') ? 'on' : ''}" data-bf="_none">Ohne Ordner</button></div>` : ''}
      <label class="field"><span>Farben</span></label>
      ${seg('colorMode', [['mono', 'Mono'], ['dual', 'Zweifarbig'], ['all', 'Alle'], ['pick', 'Wählen']])}
      <div class="colorpick ${b.colorMode === 'pick' ? '' : 'hidden'}" style="margin-top:12px" id="cpick">
        ${COLORS.map(c => `<button class="${c} ${b.colors.includes(c) ? 'on' : ''}" data-c="${c}" aria-label="${COLOR_DE[c]}">${c}</button>`).join('')}
      </div>
      <label class="field"><span>Spielstil</span></label>
      ${seg('arch', [['auto', 'Auto'], ['aggro', 'Aggro'], ['midrange', 'Midrange'], ['control', 'Kontrolle']])}
      <label class="field"><span>Um eine Karte herum bauen (optional)</span>
        <input type="search" id="forced" list="cardnames" placeholder="Kartenname …" value="${esc(b.forced)}">
        <datalist id="cardnames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      </label>
      <button class="btn primary block" id="go">Deckvorschläge berechnen</button>
      <button class="btn block" id="goAI" style="margin-top:8px;border-color:var(--ai-line);color:var(--ai)">✦ Mit Gemini bauen${hasKey ? '' : ' (API-Key fehlt)'}</button>
    </div>
    <div id="results">${resultsHTML()}</div>`;

  $$('[data-seg]', main).forEach(el => el.addEventListener('click', e => {
    const btn = e.target.closest('[data-v]'); if (!btn) return;
    b[el.dataset.seg] = btn.dataset.v;
    $$('[data-v]', el).forEach(x => x.classList.toggle('on', x === btn));
    if (el.dataset.seg === 'colorMode') $('#cpick').classList.toggle('hidden', b.colorMode !== 'pick');
  }));
  $$('#cpick button').forEach(btn => btn.addEventListener('click', () => {
    const c = btn.dataset.c, i = b.colors.indexOf(c);
    if (i >= 0) b.colors.splice(i, 1);
    else { if (b.colors.length >= 3) { toast('Maximal 3 Farben'); return; } b.colors.push(c); }
    btn.classList.toggle('on');
  }));
  $('#forced').addEventListener('change', e => { b.forced = e.target.value.trim(); });
  $$('#bfolders [data-bf]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.bf;
    if (!id) b.folders = [];
    else { const i = b.folders.indexOf(id); i >= 0 ? b.folders.splice(i, 1) : b.folders.push(id); }
    $$('#bfolders [data-bf]').forEach(x => x.classList.toggle('on', x.dataset.bf ? b.folders.includes(x.dataset.bf) : !b.folders.length));
  }));
  $('#go').addEventListener('click', runSuggest);
  $('#goAI').addEventListener('click', runGemini);
}

function readForced() {
  const v = $('#forced')?.value.trim() || '';
  state.build.forced = v;
  if (!v) return '';
  const hit = grouped().find(x => x.name.toLowerCase() === v.toLowerCase());
  if (!hit) { toast('Karte nicht in der Sammlung gefunden'); return null; }
  return hit.name;
}

function runSuggest() {
  const b = state.build;
  const forced = readForced(); if (forced === null) return;
  if (b.colorMode === 'pick' && !b.colors.length) { toast('Bitte mindestens eine Farbe wählen'); return; }
  overlay(spinnerHTML('Berechne Decks …'));
  setTimeout(() => {
    try {
      const t0 = performance.now();
      state.results = suggestDecks({ ...b, forced }).slice(0, 10);
      console.log('suggest', Math.round(performance.now() - t0) + 'ms');
    } catch (e) { console.error(e); toast('Fehler: ' + e.message); }
    overlay();
    $('#results').innerHTML = resultsHTML();
    $('#results').scrollIntoView({ behavior: 'smooth' });
  }, 30);
}

async function runGemini() {
  const b = state.build;
  if (!Settings.get('geminiKey')) { toast('Bitte zuerst einen Gemini-API-Key in den Einstellungen eintragen.', 4000); return; }
  const forced = readForced(); if (forced === null) return;
  let colors = b.colorMode === 'pick' ? b.colors.slice() : null;
  if (!colors || !colors.length) {
    const top = suggestDecks({ ...b, forced })[0];
    if (!top) { toast('Keine passende Farbkombination gefunden'); return; }
    colors = top.colors;
  }
  overlay(spinnerHTML('Gemini baut dein Deck …', `${comboName(colors)} · ${FORMATS[b.format].label}`));
  try {
    const deck = await geminiBuild({ format: b.format, colors, arch: b.arch });
    overlay();
    state.results.unshift(deck);
    $('#results').innerHTML = resultsHTML();
    openDeck(deck);
  } catch (e) {
    overlay(); console.error(e);
    toast('Gemini: ' + e.message, 6000);
  }
}

function deckStats(deck) {
  let lands = 0, creatures = 0, total = 0, cmcSum = 0, spells = 0;
  const curve = [0, 0, 0, 0, 0, 0, 0];
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const it of deck.cards) {
    const c = cardById(it.sid); total += it.n;
    if (!c) continue;
    const a = analyze(c);
    if (a.isLand) { lands += it.n; continue; }
    spells += it.n; cmcSum += c.cmc * it.n;
    if (a.isCreature) creatures += it.n;
    curve[Math.min(6, Math.round(c.cmc))] += it.n;
    COLORS.forEach(k => pips[k] += a.pips[k] * it.n);
  }
  return { lands, creatures, total, spells, avg: spells ? cmcSum / spells : 0, curve, pips };
}

function suggHTML(d, i, saved = false) {
  const st = deckStats(d);
  const top = d.cards.map(c => ({ c, k: cardById(c.sid) })).filter(x => x.k && !analyze(x.k).isLand)
    .sort((a, b) => (b.k.rank ? 1 / b.k.rank : 0) - (a.k.rank ? 1 / a.k.rank : 0)).slice(0, 3);
  const stripe = d.colors.length === 1 ? `var(--${d.colors[0]})` : `linear-gradient(var(--${d.colors[0]}),var(--${d.colors[1] || d.colors[0]}))`;
  return `<div class="sugg" data-deck="${i}" data-saved="${saved ? 1 : ''}" style="--stripe:${stripe}">
    <div class="thumbs">${top.map(x => x.k.imgS || x.k.img ? `<img loading="lazy" src="${esc(x.k.imgS || x.k.img)}" alt="">` : '<div class="phm"></div>').join('')}</div>
    <div class="grow">
      <h3>${esc(d.name)}</h3>
      <div class="row small muted" style="gap:6px">${pipsHTML(d.colors)} <span>${FORMATS[d.format].label} · ${st.total} Karten · Ø ${st.avg.toFixed(1)}</span></div>
      ${d.score != null ? `<div class="bar"><i style="width:${d.score}%"></i></div>` : '<div class="tiny" style="color:var(--ai);margin-top:6px">✦ Gemini-Vorschlag</div>'}
      ${d.warnings.length ? `<div class="tiny" style="color:var(--warn);margin-top:5px">⚠ ${esc(d.warnings[0])}</div>` : ''}
    </div>
  </div>`;
}

function resultsHTML() {
  if (!state.results.length) return '';
  const top = state.results.find(d => d.score != null);
  const thin = top && top.warnings.some(w => w.startsWith('Nur'));
  return `${thin ? `<div class="panel small" style="border-color:var(--warn-line);margin-top:16px">⚠ Für <b>${FORMATS[top.format].label}</b> hast du in diesen Farben nicht genug passende Karten für ein volles Deck. Probier „Casual 60“, „Limited 40“ oder andere Farben.</div>` : ''}
    <h2 style="margin:18px 0 4px">Vorschläge</h2><p class="small muted" style="margin:0 0 6px">Sortiert nach Stärke-Schätzung. Tippe für Details.</p>
    ${state.results.map((d, i) => suggHTML(d, i)).join('')}`;
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-deck]');
  if (!t) return;
  const list = t.dataset.saved ? state.decks : state.results;
  const d = list[+t.dataset.deck];
  if (d) openDeck(d);
});

/* ============================================================
   Deckansicht
   ============================================================ */
const GROUPS = [
  ['Kreaturen', a => a.isCreature], ['Planeswalker', a => a.isPW], ['Spontanzauber', a => a.isInstant],
  ['Hexereien', a => a.isSorcery], ['Weitere Zauber', () => true],
];
function groupOf(c) {
  const a = analyze(c);
  if (a.isLand) return 'Länder';
  return GROUPS.find(([, f]) => f(a))[0];
}
function deckRowName(name, c) {
  if (!c || Settings.get('cardLang') === 'en') return name;
  const x = cardGroup(name);
  return displayName(c, x?.entries) || name;
}
function isSaved(deck) { return state.decks.some(d => d.id === deck.id); }

function usageConflicts(deck) {
  if (deck.digital) return new Map();
  const owned = new Map(grouped().map(x => [x.name, x.qty]));
  const out = new Map();
  for (const it of deck.cards) {
    const c = cardById(it.sid);
    if (c && analyze(c).isBasic && Settings.get('unlimitedBasics')) continue;
    const other = state.decks.filter(d => d.id !== deck.id && !d.digital).reduce((s, d) => s + (d.cards.find(k => k.name === it.name)?.n || 0), 0);
    if (other && other + it.n > (owned.get(it.name) || 0)) out.set(it.name, other);
  }
  return out;
}

function openDeck(deck) {
  const body = openSheet('', { full: true, onClose: () => { if (state.view === 'decks') renderDecks(); } });
  const hero = applyDeckTheme(body.parentElement, deck);
  let edit = false;
  const draw = () => {
    const st = deckStats(deck), F = FORMATS[deck.format];
    const conflicts = usageConflicts(deck);
    const groups = new Map();
    deck.cards.forEach(it => {
      const c = cardById(it.sid); const g = c ? groupOf(c) : 'Weitere Zauber';
      if (!groups.has(g)) groups.set(g, []); groups.get(g).push({ it, c });
    });
    const order = ['Kreaturen', 'Planeswalker', 'Spontanzauber', 'Hexereien', 'Weitere Zauber', 'Länder'];
    const maxCurve = Math.max(1, ...st.curve);
    const pipTot = COLORS.reduce((s, k) => s + st.pips[k], 0) || 1;
    const saved = isSaved(deck);
    body.innerHTML = `${hero ? '<div class="deckart"></div>' : ''}
      <div class="shead"><button class="iconbtn" data-x>${ICON.back}</button><h2 class="grow" style="font-size:17px">${esc(deck.name)}</h2></div>
      ${hero ? `<div class="artcredit">${esc(hero.name)}${hero.artist ? ' · Illus. ' + esc(hero.artist) : ''}</div>` : ''}
      <div class="row wrap" style="gap:6px">
        <span class="chip">${pipsHTML(deck.colors)}</span><span class="chip">${F.label}</span><span class="chip">${ARCH_DE[deck.arch] || deck.arch}</span>
        ${deck.score != null ? `<span class="chip good">Stärke ${deck.score}</span>` : ''}
        <span class="chip ${st.total === F.size ? 'good' : 'warn'}">${st.total}/${F.size}</span>
        ${deck.folders?.length ? `<span class="chip">${deck.digital ? '🎮' : '📁'} ${deck.folders.map(id => esc(folderName(id === '_none' ? null : id))).join(', ')}</span>` : ''}
        ${deck.digital ? '' : (() => { const v = deck.cards.reduce((s, it) => { const c = cardById(it.sid); return s + (c && !analyze(c).isBasic ? unitPrice({ foil: false, buy: physical().find(e => e.sid === it.sid)?.buy }, c) * it.n : 0); }, 0); return v ? `<span class="chip">≈ ${fmtMoney(v)}</span>` : ''; })()}
      </div>
      ${deck.warnings.map(w => `<div class="chip warn" style="margin-top:8px">⚠ ${esc(w)}</div>`).join(' ')}
      ${deck.missing?.length ? `<div class="small muted" style="margin-top:6px">Fehlt: ${deck.missing.map(m => `${m.n}× ${m.name}`).join(', ')}</div>` : ''}
      ${conflicts.size ? `<div class="panel small" style="border-color:var(--warn-line)">⚠ ${conflicts.size} Karte(n) sind zusätzlich in anderen gespeicherten Decks verbaut und du besitzt nicht genug Exemplare für beide (markiert).</div>` : ''}
      ${deck.ai ? aiDeckHTML(deck.ai) : ''}
      ${deck.analysis ? analysisHTML(deck.analysis) : ''}
      <div class="stats" style="grid-template-columns:repeat(4,1fr);margin-top:12px">
        <div class="stat"><b>${st.lands}</b><span>Länder</span></div>
        <div class="stat"><b>${st.creatures}</b><span>Kreaturen</span></div>
        <div class="stat"><b>${st.spells - st.creatures}</b><span>andere</span></div>
        <div class="stat"><b>${st.avg.toFixed(2)}</b><span>Ø Manawert</span></div>
      </div>
      <div class="panel">
        <div class="row"><h3 class="grow">Manakurve</h3><div class="row small" style="gap:8px">${COLORS.filter(k => st.pips[k] > 0).map(k => `<span class="row" style="gap:4px"><span class="pip ${k}"></span>${Math.round(st.pips[k] / pipTot * 100)}%</span>`).join('')}</div></div>
        <div class="curve">${st.curve.map((n, i) => `<div><em>${n || ''}</em><i style="height:${n / maxCurve * 70}px"></i><b>${i === 6 ? '6+' : i}</b></div>`).join('')}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${saved ? '' : '<button class="btn primary" data-save style="grid-column:1/-1">Deck speichern</button>'}
        <button class="btn" data-share>Exportieren</button>
        <button class="btn" data-edit>${edit ? 'Fertig' : 'Bearbeiten'}</button>
        <button class="btn" data-ai style="border-color:var(--ai-line);color:var(--ai);grid-column:1/-1">✦ KI-Analyse</button>
      </div>
      ${order.filter(g => groups.has(g)).map(g => {
        const items = groups.get(g).sort((a, b) => (a.c?.cmc ?? 0) - (b.c?.cmc ?? 0) || a.it.name.localeCompare(b.it.name));
        return `<div class="group"><h3><span>${g}</span><span class="small muted">${items.reduce((s, x) => s + x.it.n, 0)}</span></h3>
          ${items.map(({ it, c }) => `<div class="crow ${conflicts.has(it.name) ? 'conflict' : ''}" data-cname="${esc(it.name)}">
            <span class="n">${it.n}</span><span class="nm">${esc(deckRowName(it.name, c))}${conflicts.has(it.name) ? ' <span class="tiny" style="color:var(--warn)">⚠</span>' : ''}</span>
            ${edit ? `<button class="qbtn" data-q="-1">−</button><button class="qbtn" data-q="1">+</button>` : manaHTML(c?.mana)}
          </div>`).join('')}</div>`;
      }).join('')}
      ${saved ? '<button class="btn danger block" style="margin-top:20px" data-del>Deck löschen</button>' : ''}
      <p class="tiny dim" style="text-align:center;margin-top:16px">Kartenbilder &amp; -daten: Scryfall</p>`;
  };
  draw();
  body.addEventListener('click', async e => {
    const q = e.target.closest('[data-q]');
    if (q) {
      e.stopPropagation();
      const name = q.closest('[data-cname]').dataset.cname;
      const it = deck.cards.find(c => c.name === name);
      const d = +q.dataset.q;
      if (d > 0) {
        const c = cardById(it.sid), F = FORMATS[deck.format];
        const basic = c && analyze(c).isBasic;
        const owned = ownedGroups(deck).find(x => x.name === name)?.qty || 0;
        const lim = basic && Settings.get('unlimitedBasics') ? 99 : Math.min(owned, basic ? 99 : maxCopies(F));
        if (it.n >= lim) { toast(owned < maxCopies(F) && !basic ? `Du besitzt nur ${owned}×` : 'Maximum erreicht'); return; }
        it.n++;
      } else { it.n--; if (it.n <= 0) deck.cards = deck.cards.filter(c => c !== it); }
      deck.score = deck.score != null ? deck.score : null;
      if (isSaved(deck)) await DB.putMany('decks', [deck]);
      draw(); return;
    }
    const row = e.target.closest('[data-cname]');
    if (row && !edit) { openCard(row.dataset.cname, $$('[data-cname]', body).map(r => r.dataset.cname)); return; }
    if (e.target.closest('[data-x]')) { closeSheet(); return; }
    if (e.target.closest('[data-edit]')) { edit = !edit; draw(); return; }
    if (e.target.closest('[data-save]')) {
      state.decks.unshift(deck); await DB.putMany('decks', [deck]);
      toast('Deck gespeichert ✓'); draw(); return;
    }
    if (e.target.closest('[data-del]')) {
      if (!confirmInline(e.target.closest('[data-del]'))) return;
      state.decks = state.decks.filter(d => d.id !== deck.id); await DB.del('decks', deck.id);
      toast('Deck gelöscht'); closeSheet(); return;
    }
    if (e.target.closest('[data-share]')) { shareDeck(deck); return; }
    const sw = e.target.closest('[data-swap]');
    if (sw) { applySwap(deck, +sw.dataset.swap); draw(); return; }
    if (e.target.closest('[data-ai]')) {
      if (!Settings.get('geminiKey')) { toast('Bitte zuerst einen Gemini-API-Key in den Einstellungen eintragen.', 4000); return; }
      overlay(spinnerHTML('Gemini analysiert das Deck …'));
      try {
        deck.analysis = await geminiAnalyze(deck);
        if (isSaved(deck)) await DB.putMany('decks', [deck]);
        overlay(); draw();
        body.querySelector('.ai-box.analysis')?.scrollIntoView({ behavior: 'smooth' });
      } catch (err) { overlay(); toast('Gemini: ' + err.message, 6000); }
    }
  });
}

/* Zweistufiges Löschen ohne Browser-Dialog */
function confirmInline(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; btn.textContent = 'Wirklich löschen? Nochmal tippen';
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Deck löschen'; } }, 3500);
  return false;
}

const ul = (arr) => arr?.length ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
function aiDeckHTML(ai) {
  return `<div class="ai-box"><h3>✦ Strategie (Gemini)</h3>
    ${ai.archetype ? `<div class="tiny muted">${esc(ai.archetype)}</div>` : ''}
    <p style="margin:6px 0">${esc(ai.strategy)}</p>
    ${ai.tips?.length ? `<b class="small">Spieltipps</b>${ul(ai.tips)}` : ''}
    ${ai.mulligan ? `<b class="small">Mulligan</b><p class="small" style="margin:4px 0">${esc(ai.mulligan)}</p>` : ''}
    ${ai.unknown?.length ? `<p class="tiny dim">Nicht in Sammlung (entfernt): ${esc(ai.unknown.join(', '))}</p>` : ''}
    ${ai.fixes?.length ? `<p class="tiny dim">Korrektur: ${esc(ai.fixes.join(', '))}</p>` : ''}</div>`;
}
function analysisHTML(an) {
  return `<div class="ai-box analysis"><h3>✦ KI-Analyse ${an.note ? `<span class="chip" style="margin-left:6px">Note ${esc(an.note)}</span>` : ''}</h3>
    <p style="margin:6px 0">${esc(an.bewertung)}</p>
    ${an.staerken?.length ? `<b class="small">Stärken</b>${ul(an.staerken)}` : ''}
    ${an.schwaechen?.length ? `<b class="small">Schwächen</b>${ul(an.schwaechen)}` : ''}
    ${an.tausch?.length ? `<b class="small">Tauschvorschläge</b>${an.tausch.map((t, i) => `<div class="swap small"><div class="grow"><span style="color:var(--danger)">− ${esc(t.anzahl || 1)}× ${esc(t.raus)}</span><br><span style="color:var(--ok)">+ ${esc(t.anzahl || 1)}× ${esc(t.rein)}</span><div class="tiny muted">${esc(t.grund)}</div></div>${t.done ? '<span class="chip good">✓</span>' : `<button class="btn sm" data-swap="${i}">Übernehmen</button>`}</div>`).join('')}` : ''}
    ${an.spieltipps?.length ? `<b class="small">Spieltipps</b>${ul(an.spieltipps)}` : ''}</div>`;
}

function applySwap(deck, i) {
  const t = deck.analysis?.tausch?.[i]; if (!t) return;
  const n = Math.max(1, parseInt(t.anzahl, 10) || 1);
  const out = deck.cards.find(c => c.name.toLowerCase() === String(t.raus).toLowerCase() || c.name.split(' // ')[0].toLowerCase() === String(t.raus).toLowerCase());
  const inG = ownedGroups(deck).find(x => x.card && (x.name.toLowerCase() === String(t.rein).toLowerCase() || x.name.split(' // ')[0].toLowerCase() === String(t.rein).toLowerCase()));
  if (!out || !inG) { toast('Karte nicht gefunden – Tausch nicht möglich'); return; }
  const have = deck.cards.find(c => c.name === inG.name);
  const k = Math.min(n, out.n, inG.qty - (have?.n || 0));
  if (k <= 0) { toast('Nicht genug Exemplare vorhanden'); return; }
  out.n -= k; if (out.n <= 0) deck.cards = deck.cards.filter(c => c !== out);
  if (have) have.n += k; else deck.cards.push({ name: inG.name, n: k, sid: inG.card.id });
  t.done = true;
  if (isSaved(deck)) DB.putMany('decks', [deck]);
  toast(`${k}× ${out.name} → ${inG.name}`);
}

function deckText(deck) {
  const sorted = deck.cards.slice().sort((a, b) => {
    const la = analyze(cardById(a.sid) || {}).isLand ? 1 : 0, lb = analyze(cardById(b.sid) || {}).isLand ? 1 : 0;
    return la - lb || a.name.localeCompare(b.name);
  });
  return sorted.map(c => {
    const k = cardById(c.sid);
    const nm = k && ['transform', 'modal_dfc', 'adventure', 'flip'].includes(k.layout) ? c.name.split(' // ')[0] : c.name;
    return `${c.n} ${nm}`;
  }).join('\n');
}
async function shareDeck(deck) {
  const text = deckText(deck);
  const body = openSheet(`<h2>Exportieren</h2><p class="small muted">Format „Anzahl Name“ – funktioniert in ManaBox, Moxfield, Archidekt und MTG Arena.</p>
    <textarea readonly rows="10" style="font-size:13px">${esc(text)}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary grow" data-copy>Kopieren</button>${navigator.share ? '<button class="btn grow" data-sh>Teilen</button>' : ''}</div>`);
  body.querySelector('[data-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast('Kopiert ✓'); }
    catch { const ta = body.querySelector('textarea'); ta.select(); document.execCommand('copy'); toast('Kopiert ✓'); }
  };
  body.querySelector('[data-sh]')?.addEventListener('click', () => navigator.share({ title: deck.name, text }).catch(() => {}));
}

/* ============================================================
   Gespeicherte Decks
   ============================================================ */
function renderDecks() {
  const main = $('#main');
  if (!state.decks.length) {
    main.innerHTML = `<div class="empty"><h2>Noch keine Decks gespeichert</h2><p>Lass dir unter „Deckbau“ Vorschläge machen und speichere die, die du spielen willst.</p><button class="btn primary" id="toBuild">Zum Deckbau</button></div>`;
    $('#toBuild').onclick = () => { state.view = 'build'; render(); };
    return;
  }
  main.innerHTML = `<h2 style="margin:6px 0 4px">Meine Decks</h2><p class="small muted" style="margin:0">${state.decks.length} gespeichert</p>
    ${state.decks.map((d, i) => suggHTML(d, i, true)).join('')}`;
}

/* ============================================================
   Einstellungen
   ============================================================ */
function renderSettings() {
  const S = Settings;
  const main = $('#main');
  const lang = S.get('cardLang');
  const last = +S.get('lastBackup') || 0;
  const cur = THEMES[S.get('theme')] ? S.get('theme') : 'default';
  main.innerHTML = `
    <div class="panel">
      <h2>Design</h2>
      ${[['Einfarbig', k => THEMES[k].colors.length <= 1], ['Zweifarbig · Gilden', k => THEMES[k].colors.length === 2]].map(([label, f]) => `<div class="themehead">${label}</div>
      <div class="themegrid sthemes">${Object.keys(THEMES).filter(f).map(k => { const t = THEMES[k]; return `<button class="themecard ${cur === k ? 'on' : ''}" data-theme="${k}" data-th="${k}">
        <span class="orn"></span><b>${esc(t.name)}</b><small>${esc(t.desc)}</small>
        <span class="sw">${t.colors ? t.colors.split('').map(c => `<span class="pip ${c}"></span>`).join('') : t.sw.slice(1, 4).map(c => `<i style="background:${c}"></i>`).join('')}</span></button>`; }).join('')}</div>`).join('')}
      <div class="toggle" style="margin-top:8px"><div><b>Kartenkunst im Hintergrund</b><div class="small muted" id="artinfo">${(() => { const p = (S.get('artPicks') || {})[cur]; return p ? `${esc(p.name)}${p.artist ? ' · Illus. ' + esc(p.artist) : ''}${p.own ? ' · aus deiner Sammlung' : ''}` : 'Passendes Artwork aus deiner Sammlung'; })()}</div></div>
        <label class="switch"><input type="checkbox" id="sart" ${S.get('art') ? 'checked' : ''}><span></span></label></div>
      ${S.get('art') ? '<button class="btn sm block" id="sartnew">Anderes Artwork</button>' : ''}
      <div class="toggle" style="margin-top:6px"><div><b>Decks in ihren Farben</b><div class="small muted">Ein rotes Deck öffnet im roten Design, zweifarbige mit Schimmer der zweiten Farbe</div></div>
        <label class="switch"><input type="checkbox" id="sdeckth" ${S.get('deckTheme') ? 'checked' : ''}><span></span></label></div>
      <div class="toggle"><div><b>Hintergrund-Animationen</b><div class="small muted">Glühwürmchen, Funken, Blasen …</div></div>
        <label class="switch"><input type="checkbox" id="sfx" ${S.get('fx') ? 'checked' : ''}><span></span></label></div>
    </div>
    <div class="panel">
      <h2>Kartensprache</h2>
      <p class="small muted">Wie Namen, Texte und Bilder angezeigt werden. Deckbau und Export nutzen intern immer die englischen Namen.</p>
      <div class="seg" id="slang">${[['scanned', 'Wie gescannt'], ['de', 'Deutsch'], ['en', 'Englisch']].map(([v, l]) => `<button data-v="${v}" class="${lang === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="tiny muted" style="margin:8px 2px">${lang === 'scanned' ? 'Jede Karte in der Sprache deines physischen Exemplars (laut ManaBox).' : lang === 'de' ? 'Deutsche Version, wo es eine gibt – sonst Englisch. Wird beim Ansehen nachgeladen.' : 'Immer die englische Originalversion.'}</p>
      ${lang !== 'en' ? `<button class="btn block" id="sprefetch">Sprachversionen jetzt für alle Karten laden</button>` : ''}
    </div>
    <div class="panel">
      <h2>Kartenwert</h2>
      <p class="small muted">Welche Preisquelle für Sammlungswert, Sortierung und Karten verwendet wird. Preise kommen täglich aktualisiert über Scryfall.</p>
      <div class="filters" id="sprice">${Object.entries(PRICE_SRC).map(([k, v]) => `<button class="fchip ${priceSrc() === k ? 'on' : ''}" data-v="${k}">${v.label}</button>`).join('')}</div>
      <p class="tiny muted" style="margin:6px 2px">${PRICE_SRC[priceSrc()].hint}${priceSrc() === 'purchase' ? ' – fehlt der Kaufpreis bei einer Karte, zählt sie mit 0.' : ''}. Stand: ${+S.get('lastCardRefresh') ? new Date(+S.get('lastCardRefresh')).toLocaleDateString('de-DE') : 'beim Import'}</p>
      <button class="btn block sm" id="sprefresh">Preise jetzt aktualisieren</button>
    </div>
    <div class="panel">
      <h2>Darstellung</h2>
      <div class="toggle"><div><b>Bedienknöpfe unten</b><div class="small muted">Zurück/Schließen in Vollbild-Ansichten (Deck, Scanner) unten statt oben – praktisch auf großen iPhones</div></div>
        <label class="switch"><input type="checkbox" id="sctlb" ${S.get('controlsBottom') ? 'checked' : ''}><span></span></label></div>
    </div>
    <div class="panel">
      <h2>💾 Backup</h2>
      <p class="small muted">Sammlung, Ordner, Decks und Einstellungen als Datei sichern, z. B. in Google Drive. Letztes Backup: <b>${last ? new Date(last).toLocaleDateString('de-DE') : 'noch nie'}</b></p>
      <div class="row"><button class="btn primary grow" data-act="backup">Backup erstellen</button><button class="btn grow" data-act="restore">Wiederherstellen</button></div>
    </div>
    <div class="panel">
      <h2>✦ Gemini (KI)</h2>
      <p class="small muted">Optional. Hol dir einen kostenlosen API-Key in <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>. Der Key bleibt nur auf diesem Gerät gespeichert.</p>
      <label class="field"><span>API-Key</span>
        <div class="row"><input type="password" id="gkey" value="${esc(S.get('geminiKey'))}" placeholder="AIza…" autocomplete="off" class="grow"><button class="btn sm" id="gshow">👁</button></div></label>
      <label class="field"><span>Modell</span>
        <div class="row"><input type="text" id="gmodel" list="gmodels" value="${esc(S.get('geminiModel'))}" class="grow"><button class="btn sm" id="gload">Laden</button></div>
        <datalist id="gmodels"></datalist></label>
      <div id="gmodelList"></div>
      <button class="btn block" id="gtest">Verbindung testen</button>
    </div>
    <div class="panel">
      <h2>Deckbau</h2>
      <div class="toggle"><div><b>Standardländer unbegrenzt</b><div class="small muted">Plains, Island usw. müssen nicht in der Sammlung sein</div></div>
        <label class="switch"><input type="checkbox" id="sbasics" ${S.get('unlimitedBasics') ? 'checked' : ''}><span></span></label></div>
      <label class="field"><span>Max. Kopien im Limited (40)</span>
        <select id="slim">${[[1, '1 (Singleton)'], [2, '2'], [4, '4'], [99, 'beliebig']].map(([v, l]) => `<option value="${v}" ${+S.get('limitedMaxCopies') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="panel">
      <h2>Daten</h2>
      <div class="kv small"><span>Sammlungseinträge</span><b>${state.collection.length}</b></div>
      <div class="kv small"><span>Kartendaten im Cache</span><b>${state.cards.size}</b></div>
      <div class="kv small"><span>Ordner</span><b>${state.folders.length}</b></div>
      <div class="kv small"><span>Gespeicherte Decks</span><b>${state.decks.length}</b></div>
      <div class="kv small"><span>Sprachversionen im Cache</span><b>${state.loc.size}</b></div>
      <button class="btn block" style="margin-top:12px" data-act="import">ManaBox-CSV importieren</button>
      <button class="btn block" style="margin-top:8px" id="slist">Liste einfügen (Arena, Moxfield …)</button>
      <button class="btn block" style="margin-top:8px" id="srefetch">Fehlende Kartendaten nachladen</button>
      <button class="btn block" style="margin-top:8px" id="supdate">Alle Kartendaten aktualisieren</button>
      <button class="btn danger block" style="margin-top:8px" id="sclear">Sammlung löschen</button>
    </div>
    <p class="tiny dim" style="text-align:center">Manaforge v${APP_VERSION} · Prototyp<br>Kartendaten &amp; Bilder von Scryfall. Nicht mit Wizards of the Coast verbunden.</p>`;

  $('#gkey').addEventListener('change', e => { S.set('geminiKey', e.target.value.trim()); toast('Key gespeichert'); });
  $('#gshow').onclick = () => { const i = $('#gkey'); i.type = i.type === 'password' ? 'text' : 'password'; };
  $('#gmodel').addEventListener('change', e => S.set('geminiModel', e.target.value.trim() || Settings.defaults.geminiModel));
  $('#gload').onclick = async () => {
    S.set('geminiKey', $('#gkey').value.trim());
    try {
      const ms = await geminiModels();
      $('#gmodels').innerHTML = ms.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
      $('#gmodelList').innerHTML = `<div class="filters" style="margin-bottom:10px">${ms.map(m => `<button class="fchip ${m.id === S.get('geminiModel') ? 'on' : ''}" data-mid="${esc(m.id)}">${esc(m.id)}</button>`).join('')}</div>`;
      $$('[data-mid]').forEach(b => b.onclick = () => { S.set('geminiModel', b.dataset.mid); $('#gmodel').value = b.dataset.mid; $$('[data-mid]').forEach(x => x.classList.toggle('on', x === b)); });
      toast(`${ms.length} Modelle gefunden`);
    } catch (e) { toast('Fehler: ' + e.message, 5000); }
  };
  $('#gtest').onclick = async () => {
    S.set('geminiKey', $('#gkey').value.trim()); S.set('geminiModel', $('#gmodel').value.trim() || Settings.defaults.geminiModel);
    overlay(spinnerHTML('Teste Gemini …'));
    try { const r = await geminiCall('Antworte nur mit JSON {"ok":true,"gruss":"kurzer Magic-Gruß auf Deutsch"}', true); overlay(); toast('✓ ' + (r.gruss || 'Verbindung ok'), 4000); }
    catch (e) { overlay(); toast('Fehler: ' + e.message, 6000); }
  };
  $('#sbasics').onchange = e => S.set('unlimitedBasics', e.target.checked);
  $$('#slang [data-v]').forEach(b => b.onclick = () => { S.set('cardLang', b.dataset.v); renderSettings(); });
  $$('#sprice [data-v]').forEach(b => b.onclick = () => { S.set('priceSource', b.dataset.v); renderSettings(); });
  $$('.sthemes [data-th]').forEach(b => b.onclick = async () => { S.set('theme', b.dataset.th); applyDisplay(); $$('.sthemes [data-th]').forEach(x => x.classList.toggle('on', x === b)); await pickArt(b.dataset.th); if (state.view === 'settings') renderSettings(); });
  $('#sart').onchange = e => { S.set('art', e.target.checked); applyArt(); renderSettings(); };
  $('#sartnew')?.addEventListener('click', async () => { const k = document.documentElement.dataset.theme; await pickArt(k, true); applyArt(); renderSettings(); });
  $('#sdeckth').onchange = e => S.set('deckTheme', e.target.checked);
  $('#sfx').onchange = e => { S.set('fx', e.target.checked); applyDisplay(); };
  $('#sctlb').onchange = e => { S.set('controlsBottom', e.target.checked); applyDisplay(); };
  $('#slist').onclick = () => openListImport(null);
  $('#sprefresh').onclick = async () => {
    overlay(spinnerHTML('Aktualisiere Preise …'));
    try { await refreshAllCards((d, t) => overlay(spinnerHTML('Aktualisiere Preise …', `${d} / ${t}`))); toast('Preise aktualisiert ✓'); }
    catch { toast('Scryfall nicht erreichbar.'); }
    overlay(); renderSettings();
  };
  $('#sprefetch')?.addEventListener('click', async () => {
    const groups = grouped().filter(x => x.card?.oid);
    groups.forEach(x => view(x.card, targetLang(x.entries)));   // stellt fehlende in die Warteschlange
    const total = locQueue.size;
    if (!total) { toast('Alle Sprachversionen sind schon geladen ✓'); return; }
    overlay(spinnerHTML('Lade Sprachversionen …', `0 / ${total}`));
    while (locQueue.size || locRunning) {
      await sleep(400);
      overlay(spinnerHTML('Lade Sprachversionen …', `${total - locQueue.size} / ${total}<div class="bar"><i style="width:${Math.round((total - locQueue.size) / total * 100)}%"></i></div>`));
    }
    overlay(); toast('Sprachversionen geladen ✓'); renderSettings();
  });
  $('#slim').onchange = e => S.set('limitedMaxCopies', +e.target.value);
  $('#srefetch').onclick = refetchCards;
  $('#supdate').onclick = async () => {
    state.cards.clear(); anCache.clear(); await DB.clear('cards');
    // IDs behalten – werden neu geladen
    refetchCards();
  };
  $('#sclear').onclick = async (e) => {
    const b = e.target;
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Wirklich? Nochmal tippen'; return; }
    await DB.clear('collection'); state.collection = []; state.grouped = null; state.results = [];
    toast('Sammlung gelöscht'); render();
  };
}

/* ============================================================
   Start
   ============================================================ */
/** Kartendaten aus v0.1 enthalten noch keine Sprachfelder → einmalig im Hintergrund neu laden */
async function upgradeCardCache() {
  if (!navigator.onLine || !state.collection.length) return;
  const stale = [...state.cards.values()].filter(c => c.lang === undefined || c.prices === undefined || c.leg?.historic === undefined || c.artist === undefined);
  if (!stale.length) {
    // Preise wöchentlich still im Hintergrund auffrischen
    if (Date.now() - (+Settings.get('lastCardRefresh') || 0) > 7 * 864e5) {
      refreshAllCards().then(() => { if (state.view === 'collection' && !sheets.length) render(); }).catch(e => console.warn(e));
    }
    return;
  }
  toast('Aktualisiere Kartendaten für die Sprachfunktion …', 3000);
  stale.forEach(c => { state.cards.delete(c.id); anCache.delete(c.id); });
  try {
    await enrichFromScryfall(state.collection);
    Settings.set('lastCardRefresh', Date.now());
    state.grouped = null;
    if (state.view === 'collection' && !sheets.length) render();
    toast('Kartendaten aktualisiert ✓');
  } catch (e) {
    console.warn(e);
    stale.forEach(c => { if (!state.cards.has(c.id)) state.cards.set(c.id, c); });
  }
}

/* ============================================================
   Designs
   ============================================================ */
const THEMES = {"default": {"name": "Arkanes Gold", "desc": "Das bisherige Design", "colors": "", "fx": [["sparkle", 12]], "art": {"types": ["Angel", "Sphinx", "Dragon"], "q": "t:legendary t:creature"}, "light": false, "sw": ["#0f0c14", "#1d1727", "#d6b26a", "#a8843f", "#ece6f5"]}, "green": {"name": "Pilzwald", "desc": "Wald, Ranken, Pilze, Feen", "colors": "G", "fx": [["fireflies", 14], ["leaves", 8]], "art": {"types": ["Faerie", "Dryad", "Elf", "Treefolk", "Fungus"], "q": "(t:dryad or t:faerie or t:treefolk) c:g"}, "light": false, "sw": ["#0a120c", "#15231a", "#b9d873", "#6f9a3a", "#e9f2e1"]}, "black": {"name": "Grabgesang", "desc": "Black & Death Metal, Zombies", "colors": "B", "fx": [["ash", 18]], "art": {"types": ["Zombie", "Skeleton", "Demon", "Horror", "Vampire"], "q": "(t:zombie or t:skeleton or t:demon) c:b"}, "light": false, "sw": ["#060606", "#141212", "#e3dccb", "#8f1d1d", "#ebe5d8"]}, "red": {"name": "Drachenschmiede", "desc": "Glut, Lava, Funken", "colors": "R", "fx": [["embers", 22]], "art": {"types": ["Dragon", "Elemental", "Phoenix", "Goblin"], "q": "t:dragon c:r"}, "light": false, "sw": ["#130806", "#25110b", "#ff9a4d", "#c2410c", "#fde9dc"]}, "blue": {"name": "Tiefsee", "desc": "Wasser, Magie, Runen", "colors": "U", "fx": [["bubbles", 12], ["sparkle", 8]], "art": {"types": ["Leviathan", "Kraken", "Merfolk", "Sphinx", "Wizard"], "q": "(t:leviathan or t:kraken or t:merfolk) c:u"}, "light": false, "sw": ["#040c16", "#0d1d2f", "#5fcaf7", "#1f7fb8", "#e2f0fb"]}, "white": {"name": "Kathedrale", "desc": "Elfenbein, Gold, Licht", "colors": "W", "fx": [["motes", 16]], "art": {"types": ["Angel", "Cleric", "Pegasus"], "q": "t:angel c:w"}, "light": true, "sw": ["#f5efe1", "#fffcf4", "#a67a22", "#c9a24a", "#2a2317"]}, "wu": {"name": "Himmelsarchiv", "desc": "Azorius · Säulen, Wolken, Gesetzesrunen", "colors": "WU", "fx": [["motes", 10], ["sparkle", 8]], "art": {"types": ["Sphinx", "Spirit", "Bird", "Advisor"], "q": "c=wu t:creature"}, "light": false, "sw": ["#0c1424", "#16233a", "#cfe3ff", "#4d7fc4", "#eef3fb"]}, "ub": {"name": "Versunkene Welt", "desc": "Dimir · Tiefsee-Apokalypse im Film-Blau", "colors": "UB", "fx": [["rain", 26], ["snow", 14]], "art": {"types": ["Horror", "Kraken", "Leviathan", "Faerie", "Rogue", "Zombie"], "q": "c=ub (t:horror or t:kraken or t:faerie or t:zombie)"}, "light": false, "sw": ["#03080a", "#0b171c", "#4ec9c0", "#1b6b73", "#d6ebee"]}, "br": {"name": "Höllenzirkus", "desc": "Rakdos · Ketten, Flammen, Wahnsinn", "colors": "BR", "fx": [["embers", 16], ["ash", 10]], "art": {"types": ["Demon", "Devil", "Vampire", "Ogre"], "q": "c=br t:creature"}, "light": false, "sw": ["#0d0505", "#1e0b0b", "#ff5a3c", "#8f1414", "#f5e3dc"]}, "rg": {"name": "Urgewalt", "desc": "Gruul · Fels, Krallen, Wildnis", "colors": "RG", "fx": [["embers", 10], ["leaves", 6]], "art": {"types": ["Beast", "Dinosaur", "Giant", "Warrior"], "q": "c=rg (t:beast or t:dinosaur or t:giant)"}, "light": false, "sw": ["#120d07", "#241a0f", "#e0862f", "#6c8a2a", "#f4ead9"]}, "gw": {"name": "Weltenbaum", "desc": "Selesnya · Äste, Blüten, Sonnenlicht", "colors": "GW", "fx": [["motes", 12], ["leaves", 8]], "art": {"types": ["Dryad", "Treefolk", "Elf", "Unicorn", "Elemental"], "q": "c=gw t:creature"}, "light": false, "sw": ["#0d140b", "#1a2616", "#e6cf7a", "#7aa03e", "#f3f5e6"]}, "wb": {"name": "Goldene Kathedrale", "desc": "Orzhov · Gotik, Gold, Geister", "colors": "WB", "fx": [["motes", 12], ["sparkle", 6]], "art": {"types": ["Spirit", "Cleric", "Advisor", "Knight"], "q": "c=wb t:creature"}, "light": false, "sw": ["#0c0a08", "#1a1715", "#e3c06a", "#8f7232", "#f2ece2"]}, "ur": {"name": "Blitzlabor", "desc": "Izzet · Blitze, Zahnräder, Experimente", "colors": "UR", "fx": [["sparks", 18]], "art": {"types": ["Weird", "Wizard", "Elemental", "Dragon"], "q": "c=ur t:creature"}, "light": false, "sw": ["#0a0b14", "#161a2a", "#57b8ff", "#d9452b", "#eef0fb"]}, "bg": {"name": "Moderreich", "desc": "Golgari · Pilze, Wurzeln, Sporen", "colors": "BG", "fx": [["spores", 18]], "art": {"types": ["Fungus", "Zombie", "Insect", "Elf", "Plant"], "q": "c=bg (t:fungus or t:zombie or t:insect)"}, "light": false, "sw": ["#0b0d07", "#171b10", "#b7c95a", "#6b4f8a", "#e7ead6"]}, "rw": {"name": "Sonnenlegion", "desc": "Boros · Banner, Sonnenfeuer", "colors": "RW", "fx": [["embers", 10], ["motes", 8]], "art": {"types": ["Soldier", "Angel", "Knight", "Dwarf"], "q": "c=rw t:creature"}, "light": false, "sw": ["#140c08", "#261911", "#ffcf5a", "#c23b22", "#fbefe2"]}, "gu": {"name": "Biolabor", "desc": "Simic · Korallen, Zellen, Mutationen", "colors": "GU", "fx": [["bubbles", 12], ["cells", 6]], "art": {"types": ["Mutant", "Fish", "Frog", "Merfolk", "Kraken"], "q": "c=gu t:creature"}, "light": false, "sw": ["#041211", "#0c2223", "#5fe3b0", "#2a8fb0", "#dff7f1"]}};
const COLOR_THEME = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
const PAIR_THEME = { WU: 'wu', UB: 'ub', BR: 'br', RG: 'rg', WG: 'gw', WB: 'wb', UR: 'ur', BG: 'bg', WR: 'rw', UG: 'gu' };
const themeForColors = (cs) => cs.length === 1 ? COLOR_THEME[cs[0]] : cs.length === 2 ? PAIR_THEME[sortColors(cs).join('')] : null;
const DECK_TINT = { W: 'rgba(255,240,200,.20)', U: 'rgba(60,150,230,.30)', B: 'rgba(150,20,20,.32)', R: 'rgba(255,90,30,.30)', G: 'rgba(80,170,70,.28)' };
const rnd = (a, b) => a + Math.random() * (b - a);

/** Hintergrund-Partikel für das Design erzeugen: list = [[art, anzahl], …] */
function spawnFx(list) {
  const fx = $('#fx'); if (!fx) return;
  fx.innerHTML = '';
  if (!Settings.get('fx')) return;
  const P = {
    sparkle: () => ({ s: rnd(2, 4), d: rnd(3, 7), dx: 0, dy: 0 }),
    fireflies: () => ({ s: rnd(3, 5), d: rnd(7, 14), dx: rnd(-60, 60), dy: rnd(-50, 50) }),
    embers: () => ({ s: rnd(2, 5), d: rnd(6, 13), dx: rnd(-80, 80), dy: 0 }),
    bubbles: () => ({ s: rnd(6, 16), d: rnd(12, 24), dx: rnd(-40, 40), dy: 0 }),
    ash: () => ({ s: rnd(2, 5), d: rnd(12, 22), dx: rnd(-90, 90), dy: 0 }),
    motes: () => ({ s: rnd(2, 4), d: rnd(8, 16), dx: rnd(-40, 40), dy: rnd(-40, 40) }),
    leaves: () => ({ s: rnd(6, 10), d: rnd(11, 19), dx: rnd(-120, 120), dy: 0 }),
    rain: () => ({ s: rnd(3, 6), d: rnd(1.1, 2.2), dx: rnd(-40, -10), dy: 0 }),
    snow: () => ({ s: rnd(1.5, 3), d: rnd(16, 28), dx: rnd(-50, 50), dy: 0 }),
    spores: () => ({ s: rnd(2, 4), d: rnd(14, 26), dx: rnd(-60, 60), dy: 0 }),
    sparks: () => ({ s: rnd(2, 3.5), d: rnd(2.5, 5), dx: rnd(-50, 50), dy: rnd(-50, 50) }),
    cells: () => ({ s: rnd(14, 30), d: rnd(14, 24), dx: rnd(-50, 50), dy: rnd(-50, 50) }),
  };
  const out = [];
  for (const [kind, n] of list || []) {
    for (let i = 0; i < n; i++) {
      const v = P[kind] ? P[kind]() : P.sparkle();
      out.push(`<i class="k-${kind}" style="--x:${rnd(0, 100).toFixed(1)}%;--y:${rnd(5, 95).toFixed(1)}%;--s:${v.s.toFixed(1)}px;--d:${v.d.toFixed(1)}s;--dl:-${rnd(0, v.d).toFixed(1)}s;--dx:${v.dx.toFixed(0)}px;--dy:${v.dy.toFixed(0)}px"></i>`);
    }
  }
  fx.innerHTML = out.join('');
}

/* Kartenkunst im Hintergrund: passendes Artwork aus der eigenen Sammlung, sonst Zufall von Scryfall */
const artCrop = (url) => url ? url.replace('/normal/', '/art_crop/').replace('/large/', '/art_crop/') : '';
function artCandidates(key) {
  const t = THEMES[key], want = t.colors ? t.colors.split('') : null;
  const seen = new Set(), out = [];
  for (const e of physical()) {
    const c = state.cards.get(e.sid);
    if (!c || !c.img || seen.has(c.oid) || analyze(c).isLand || analyze(c).excluded) continue;
    seen.add(c.oid);
    if (want) {
      if (want.length === 1 && !(c.colors.length === 1 && c.colors[0] === want[0])) continue;
      if (want.length === 2 && !(c.colors.length === 2 && want.every(x => c.colors.includes(x)))) continue;
    } else if (!/Legendary/.test(c.type)) continue;
    const typeHit = (t.art.types || []).some(ty => (c.type || '').includes(ty));
    out.push({ c, score: (typeHit ? 2 : 0) + (c.rarity === 'mythic' ? 1 : c.rarity === 'rare' ? .6 : 0) + (c.rank ? 2 - Math.log10(c.rank) / 2.5 : 0) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.c);
}
async function pickArt(key, reroll = false) {
  const picks = Settings.get('artPicks') || {};
  if (picks[key] && !reroll) return picks[key];
  const cands = artCandidates(key).filter(c => !reroll || artCrop(c.img) !== picks[key]?.url);
  let pick = null;
  if (cands.length && (!reroll || Math.random() < .7)) {
    const c = cands[Math.floor(Math.random() * cands.length)];
    pick = { url: artCrop(c.img), name: c.printed && c.lang !== 'en' ? c.printed : c.name, artist: c.artist || '', own: true };
  } else {
    try {
      const r = await fetch(`https://api.scryfall.com/cards/random?q=${encodeURIComponent(THEMES[key].art.q + ' game:paper')}`);
      if (r.ok) {
        const c = await r.json();
        const iu = c.image_uris || c.card_faces?.[0]?.image_uris || {};
        if (iu.art_crop) pick = { url: iu.art_crop, name: c.name, artist: c.artist || '', own: false };
      }
    } catch { /* offline */ }
  }
  if (pick) { picks[key] = pick; Settings.set('artPicks', picks); }
  return pick;
}
async function applyArt() {
  const el = $('#art'); if (!el) return;
  document.body.classList.toggle('no-art', !Settings.get('art'));
  if (!Settings.get('art')) return;
  const key = document.documentElement.dataset.theme;
  const p = await pickArt(key);
  if (document.documentElement.dataset.theme !== key) return;
  el.style.setProperty('--art-img', p ? `url("${p.url}")` : 'none');
}

window.addEventListener('scroll', () => document.body.classList.toggle('scrolled', window.scrollY > 40), { passive: true });

function applyDisplay() {
  document.body.classList.toggle('ctl-bottom', !!Settings.get('controlsBottom'));
  const t = THEMES[Settings.get('theme')] ? Settings.get('theme') : 'default';
  document.documentElement.dataset.theme = t;
  document.body.classList.toggle('no-fx', !Settings.get('fx'));
  spawnFx(THEMES[t].fx);
  applyArt();
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = THEMES[t].sw[0];
}

/** Deck-Ansicht im Design der Deckfarben (ein- und zweifarbig) + Artwork der stärksten Karte */
function applyDeckTheme(sheet, deck) {
  sheet.removeAttribute('data-theme'); sheet.style.removeProperty('--deck2'); sheet.style.removeProperty('--hero');
  if (!Settings.get('deckTheme')) return null;
  const key = themeForColors(deck.colors || []);
  if (key) sheet.dataset.theme = key;
  const top = deck.cards.map(it => cardById(it.sid)).filter(c => c && c.img && !analyze(c).isLand)
    .sort((a, b) => (a.rank || 1e6) - (b.rank || 1e6) || (b.rarity === 'mythic') - (a.rarity === 'mythic'))[0];
  if (top && Settings.get('art')) { sheet.style.setProperty('--hero', `url("${artCrop(top.img)}")`); return top; }
  return null;
}

async function init() {
  Settings.load();
  applyDisplay();
  try {
    await DB.open();
    const [coll, cards, decks, folders, loc] = await Promise.all(['collection', 'cards', 'decks', 'folders', 'loc'].map(st => DB.all(st)));
    cards.forEach(c => state.cards.set(c.id, c));
    loc.forEach(l => state.loc.set(l.k, l));
    state.folders = folders;
    // Migration v0.1 → v0.2: Schlüssel mit Ordner, Sprache normalisieren
    const oldKeys = coll.map(e => e.key);
    coll.forEach(e => { if (e.folder === undefined) e.folder = null; e.lang = normLang(e.lang); });
    state.collection = normalizeCollection(coll);
    if (state.collection.some((e, i) => e.key !== oldKeys[i]) || state.collection.length !== coll.length) {
      await DB.delMany('collection', oldKeys); await DB.putMany('collection', state.collection);
    }
    state.decks = decks.sort((a, b) => b.created - a.created);
  } catch (e) {
    console.error(e);
    toast('Lokaler Speicher nicht verfügbar – Daten gehen beim Schließen verloren.', 6000);
    DB.putMany = DB.del = DB.delMany = DB.clear = async () => {};
  }
  render();
  upgradeCardCache();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
}
init();
