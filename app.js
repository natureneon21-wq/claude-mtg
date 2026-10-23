'use strict';
/* Manaforge – MTG-Sammlung & Deckbau (Prototyp) */
const APP_VERSION = '0.5.2';

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
/** Bewegte Rand-Details je Design (eigene SVG-Zeichnungen, Animation per CSS) */
const THEME_ANIM = {"default": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><defs><filter id='glt' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='2' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-pulse' style='--d:3.5s;--dl:0s'><path d='M200 6 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z' fill='#f3dfa8'/></g></svg>"}, "green": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><ellipse cx='15.4' cy='-1.7' rx='4.7' ry='1.9' transform='rotate(234 15.4 -1.7)' fill='#2b5220'/><ellipse cx='0.2' cy='19.3' rx='5.0' ry='2.0' transform='rotate(327 0.2 19.3)' fill='#25471c'/><ellipse cx='22.6' cy='-5.3' rx='5.6' ry='2.2' transform='rotate(33 22.6 -5.3)' fill='#2b5220'/><ellipse cx='2.2' cy='2.3' rx='6.9' ry='2.7' transform='rotate(226 2.2 2.3)' fill='#2b5220'/><ellipse cx='32.6' cy='-6.2' rx='5.9' ry='2.4' transform='rotate(80 32.6 -6.2)' fill='#25471c'/><ellipse cx='13.1' cy='-1.9' rx='5.3' ry='2.1' transform='rotate(42 13.1 -1.9)' fill='#2b5220'/><ellipse cx='5.9' cy='18.1' rx='5.4' ry='2.2' transform='rotate(230 5.9 18.1)' fill='#2b5220'/><ellipse cx='41.0' cy='10.4' rx='5.7' ry='2.3' transform='rotate(223 41.0 10.4)' fill='#2b5220'/><ellipse cx='22.2' cy='4.3' rx='5.6' ry='2.3' transform='rotate(211 22.2 4.3)' fill='#1d3a16'/><ellipse cx='10.4' cy='-0.2' rx='4.7' ry='1.9' transform='rotate(281 10.4 -0.2)' fill='#1d3a16'/><ellipse cx='28.7' cy='24.4' rx='5.2' ry='2.1' transform='rotate(263 28.7 24.4)' fill='#25471c'/><ellipse cx='1.8' cy='11.4' rx='4.9' ry='2.0' transform='rotate(273 1.8 11.4)' fill='#1d3a16'/><ellipse cx='21.8' cy='29.9' rx='5.9' ry='2.4' transform='rotate(28 21.8 29.9)' fill='#1d3a16'/><ellipse cx='16.4' cy='6.4' rx='6.5' ry='2.6' transform='rotate(179 16.4 6.4)' fill='#25471c'/><ellipse cx='49.4' cy='20.1' rx='6.2' ry='2.5' transform='rotate(171 49.4 20.1)' fill='#25471c'/><ellipse cx='42.3' cy='2.0' rx='6.2' ry='2.5' transform='rotate(208 42.3 2.0)' fill='#1d3a16'/><ellipse cx='12.8' cy='8.4' rx='4.6' ry='1.8' transform='rotate(241 12.8 8.4)' fill='#1d3a16'/><ellipse cx='17.5' cy='17.0' rx='5.0' ry='2.0' transform='rotate(178 17.5 17.0)' fill='#1d3a16'/><ellipse cx='397.5' cy='3.4' rx='6.7' ry='2.7' transform='rotate(141 397.5 3.4)' fill='#25471c'/><ellipse cx='395.0' cy='10.2' rx='4.8' ry='1.9' transform='rotate(100 395.0 10.2)' fill='#1d3a16'/><ellipse cx='349.0' cy='0.1' rx='5.4' ry='2.2' transform='rotate(150 349.0 0.1)' fill='#1d3a16'/><ellipse cx='342.8' cy='-3.9' rx='5.1' ry='2.0' transform='rotate(63 342.8 -3.9)' fill='#25471c'/><ellipse cx='405.2' cy='29.5' rx='5.2' ry='2.1' transform='rotate(66 405.2 29.5)' fill='#25471c'/><ellipse cx='378.3' cy='6.6' rx='6.9' ry='2.8' transform='rotate(204 378.3 6.6)' fill='#2b5220'/><ellipse cx='349.3' cy='19.8' rx='6.3' ry='2.5' transform='rotate(236 349.3 19.8)' fill='#1d3a16'/><ellipse cx='346.6' cy='14.1' rx='6.5' ry='2.6' transform='rotate(315 346.6 14.1)' fill='#1d3a16'/><ellipse cx='379.7' cy='7.7' rx='5.5' ry='2.2' transform='rotate(173 379.7 7.7)' fill='#25471c'/><ellipse cx='401.6' cy='1.7' rx='5.4' ry='2.1' transform='rotate(58 401.6 1.7)' fill='#25471c'/><ellipse cx='399.2' cy='18.5' rx='6.9' ry='2.7' transform='rotate(193 399.2 18.5)' fill='#2b5220'/><ellipse cx='404.3' cy='31.8' rx='4.9' ry='1.9' transform='rotate(221 404.3 31.8)' fill='#1d3a16'/><ellipse cx='342.9' cy='8.3' rx='4.8' ry='1.9' transform='rotate(171 342.9 8.3)' fill='#1d3a16'/><ellipse cx='340.5' cy='4.2' rx='4.7' ry='1.9' transform='rotate(174 340.5 4.2)' fill='#25471c'/><ellipse cx='356.5' cy='15.5' rx='6.2' ry='2.5' transform='rotate(172 356.5 15.5)' fill='#2b5220'/><ellipse cx='404.5' cy='35.2' rx='4.9' ry='1.9' transform='rotate(190 404.5 35.2)' fill='#2b5220'/><ellipse cx='345.7' cy='13.2' rx='6.1' ry='2.4' transform='rotate(107 345.7 13.2)' fill='#25471c'/><ellipse cx='360.1' cy='0.6' rx='4.9' ry='2.0' transform='rotate(132 360.1 0.6)' fill='#25471c'/><path d='M2.1 154.2 L2.6 152.1 L3.2 149.5 L4.3 146.6 L6.0 143.6 L8.1 140.5 L10.3 137.2 L12.1 133.5 L13.5 129.6 L14.9 125.6 L16.6 121.9 L18.5 118.6 L20.6 115.5 L22.5 112.5 L24.0 109.3 L25.2 105.9 L26.2 102.6 L27.5 99.4 L29.1 96.4 L30.9 93.7 L32.7 90.9 L34.2 88.1 L35.5 85.1 L36.9 82.2 L38.5 79.4 L40.7 76.8 L43.0 74.4 L45.4 71.9 L47.5 69.3 L49.5 66.5 L51.5 63.7 L53.8 61.1 L56.4 58.8 L59.1 56.7 L61.8 54.7 L64.4 52.5 L66.9 50.1 L69.5 47.8 L72.4 45.8 L75.4 44.0 L78.6 42.4 L81.9 40.9 L85.1 39.1 L88.2 37.2 L91.5 35.4 L94.8 33.7 L98.3 32.3 L101.9 31.1 L105.4 29.9 L108.9 28.5 L112.6 27.0 L116.3 25.5 L120.2 24.2 L124.2 23.2 L128.3 22.4 L132.3 21.5 L136.2 20.4 L140.0 19.3 L143.7 18.2 L147.2 17.2 L150.6 16.5 L153.8 15.9 L157.1 15.2 L160.2 14.4 L163.3 13.6 L166.3 12.8 L169.2 12.1 L172.0 11.6 L174.5 11.2 L176.9 10.8 L179.0 10.4 L180.8 9.9 L182.3 9.4 L181.7 6.6 L180.2 6.7 L178.4 6.8 L176.3 7.0 L173.9 7.4 L171.3 7.9 L168.5 8.4 L165.6 8.7 L162.5 9.1 L159.2 9.5 L156.0 10.0 L152.7 10.7 L149.4 11.5 L146.1 12.3 L142.5 12.9 L138.7 13.5 L134.8 14.1 L130.8 14.9 L126.7 15.9 L122.7 17.0 L118.6 18.1 L114.5 19.1 L110.4 20.0 L106.4 20.9 L102.6 22.1 L99.0 23.6 L95.4 25.2 L91.9 26.7 L88.2 28.1 L84.6 29.3 L80.9 30.6 L77.4 32.2 L74.1 34.2 L70.9 36.2 L67.7 38.2 L64.4 40.1 L61.1 41.9 L57.8 43.8 L54.8 46.0 L52.0 48.6 L49.4 51.2 L46.8 53.9 L44.0 56.3 L41.1 58.6 L38.3 61.1 L35.8 63.7 L33.6 66.7 L31.6 69.7 L29.5 72.6 L27.1 75.4 L24.7 78.1 L22.4 81.0 L20.5 84.0 L19.0 87.3 L17.7 90.6 L16.2 93.7 L14.4 96.7 L12.4 99.5 L10.4 102.4 L8.8 105.3 L7.4 108.5 L6.0 111.9 L4.3 115.4 L2.1 118.9 L-0.4 122.3 L-2.8 125.7 L-4.8 129.3 L-6.3 133.0 L-7.6 136.5 L-9.1 139.6 L-10.8 142.2 L-12.6 144.2 L-14.1 145.8Z' fill='#4a3822'/><path d='M2.1 154.2 L2.6 152.1 L3.2 149.5 L4.3 146.6 L6.0 143.6 L8.1 140.5 L10.3 137.2 L12.1 133.5 L13.5 129.6 L14.9 125.6 L16.6 121.9 L18.5 118.6 L20.6 115.5 L22.5 112.5 L24.0 109.3 L25.2 105.9 L26.2 102.6 L27.5 99.4 L29.1 96.4 L30.9 93.7 L32.7 90.9 L34.2 88.1 L35.5 85.1 L36.9 82.2 L38.5 79.4 L40.7 76.8 L43.0 74.4 L45.4 71.9 L47.5 69.3 L49.5 66.5 L51.5 63.7 L53.8 61.1 L56.4 58.8 L59.1 56.7 L61.8 54.7 L64.4 52.5 L66.9 50.1 L69.5 47.8 L72.4 45.8 L75.4 44.0 L78.6 42.4 L81.9 40.9 L85.1 39.1 L88.2 37.2 L91.5 35.4 L94.8 33.7 L98.3 32.3 L101.9 31.1 L105.4 29.9 L108.9 28.5 L112.6 27.0 L116.3 25.5 L120.2 24.2 L124.2 23.2 L128.3 22.4 L132.3 21.5 L136.2 20.4 L140.0 19.3 L143.7 18.2 L147.2 17.2 L150.6 16.5 L153.8 15.9' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M90.1 34.2 L91.5 33.9 L93.4 33.5 L95.6 33.3 L98.1 33.0 L100.7 32.7 L103.4 32.3 L106.2 31.9 L108.9 31.5 L111.5 31.3 L113.8 31.3 L115.8 31.6 L117.4 32.0 L118.7 32.4 L119.9 33.0 L121.0 33.8 L122.0 34.8 L122.9 36.0 L123.7 37.4 L124.5 38.8 L125.3 40.1 L126.2 41.5 L127.2 42.7 L128.1 43.9 L129.1 44.9 L130.1 45.8 L131.1 46.6 L132.2 47.3 L133.3 47.8 L134.3 48.3 L135.3 48.7 L136.2 49.2 L137.1 49.6 L137.8 50.0 L138.5 50.2 L139.1 50.4 L139.7 50.6 L140.3 49.4 L139.9 49.0 L139.3 48.6 L138.7 48.2 L137.9 47.9 L137.1 47.5 L136.2 47.0 L135.3 46.5 L134.4 45.8 L133.6 45.1 L132.7 44.5 L131.8 43.8 L130.9 43.1 L130.1 42.3 L129.4 41.2 L128.8 39.9 L128.2 38.5 L127.4 37.1 L126.6 35.7 L125.6 34.2 L124.5 32.8 L123.4 31.4 L122.1 30.0 L120.5 28.9 L118.6 28.0 L116.4 27.6 L114.0 27.5 L111.4 27.5 L108.7 27.5 L105.8 27.5 L102.9 27.6 L100.1 27.9 L97.4 28.3 L95.0 28.8 L92.8 29.1 L91.0 29.3 L89.6 29.2Z' fill='#4a3822'/><path d='M90.1 34.2 L91.5 33.9 L93.4 33.5 L95.6 33.3 L98.1 33.0 L100.7 32.7 L103.4 32.3 L106.2 31.9 L108.9 31.5 L111.5 31.3 L113.8 31.3 L115.8 31.6 L117.4 32.0 L118.7 32.4 L119.9 33.0 L121.0 33.8 L122.0 34.8 L122.9 36.0 L123.7 37.4 L124.5 38.8 L125.3 40.1 L126.2 41.5 L127.2 42.7 L128.1 43.9 L129.1 44.9 L130.1 45.8 L131.1 46.6 L132.2 47.3 L133.3 47.8 L134.3 48.3 L135.3 48.7' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M31.7 83.4 L32.3 82.6 L33.3 81.8 L34.3 80.8 L35.5 79.7 L36.6 78.4 L37.7 77.0 L38.9 75.7 L40.1 74.5 L41.4 73.5 L42.6 72.8 L43.6 72.3 L44.4 72.0 L45.1 71.8 L46.0 71.7 L47.1 72.0 L48.2 72.5 L49.3 73.2 L50.4 73.9 L51.7 74.6 L53.0 75.2 L54.2 75.8 L55.4 76.4 L56.6 77.0 L57.7 77.4 L58.8 77.5 L59.8 77.4 L60.8 77.2 L61.7 76.9 L62.5 76.6 L63.2 76.3 L64.0 76.0 L64.6 75.7 L65.1 75.4 L65.6 75.1 L65.9 74.8 L66.2 74.7 L65.8 73.3 L65.4 73.4 L64.8 73.5 L64.3 73.7 L63.7 73.9 L63.1 74.2 L62.5 74.4 L61.9 74.7 L61.2 74.8 L60.4 74.8 L59.7 74.8 L59.0 74.7 L58.3 74.6 L57.5 74.5 L56.6 74.1 L55.6 73.5 L54.6 72.6 L53.5 71.8 L52.3 70.9 L51.0 70.1 L49.6 69.5 L48.2 68.9 L46.8 68.4 L45.2 68.0 L43.6 68.0 L42.0 68.4 L40.4 69.3 L39.0 70.3 L37.6 71.5 L36.1 72.7 L34.6 73.9 L33.2 75.0 L31.9 76.2 L30.8 77.5 L29.9 78.6 L29.2 79.4 L28.5 79.9Z' fill='#4a3822'/><path d='M31.7 83.4 L32.3 82.6 L33.3 81.8 L34.3 80.8 L35.5 79.7 L36.6 78.4 L37.7 77.0 L38.9 75.7 L40.1 74.5 L41.4 73.5 L42.6 72.8 L43.6 72.3 L44.4 72.0 L45.1 71.8 L46.0 71.7 L47.1 72.0 L48.2 72.5 L49.3 73.2 L50.4 73.9 L51.7 74.6 L53.0 75.2 L54.2 75.8 L55.4 76.4 L56.6 77.0 L57.7 77.4 L58.8 77.5 L59.8 77.4 L60.8 77.2 L61.7 76.9 L62.5 76.6 L63.2 76.3' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M413.7 164.9 L413.3 162.9 L412.8 160.3 L411.9 157.4 L410.4 154.3 L408.4 151.0 L406.4 147.5 L404.7 143.7 L403.4 139.7 L402.3 135.6 L400.9 131.7 L399.1 128.2 L397.1 125.0 L395.2 121.9 L393.6 118.8 L392.5 115.4 L391.5 112.0 L390.2 108.6 L388.5 105.4 L386.5 102.4 L384.5 99.3 L382.7 96.2 L381.2 92.8 L379.7 89.5 L378.0 86.3 L375.8 83.4 L373.4 80.7 L371.0 78.1 L368.7 75.2 L366.8 72.3 L364.8 69.3 L362.6 66.4 L360.0 63.9 L357.3 61.6 L354.5 59.3 L351.9 56.8 L349.5 54.3 L347.1 51.7 L344.4 49.3 L341.5 47.2 L338.5 45.3 L335.4 43.5 L332.5 41.5 L329.6 39.4 L326.7 37.2 L323.7 35.3 L320.5 33.6 L317.1 32.2 L313.7 30.7 L310.4 29.1 L307.0 27.4 L303.5 25.7 L299.9 24.2 L296.2 22.9 L292.4 21.9 L288.6 20.8 L284.9 19.7 L281.3 18.4 L277.8 17.2 L274.3 16.1 L270.8 15.2 L267.2 14.5 L263.6 13.8 L259.8 13.0 L256.1 12.2 L252.4 11.4 L248.8 10.7 L245.3 10.3 L242.0 9.9 L239.0 9.6 L236.4 9.2 L234.1 8.8 L232.3 8.5 L231.7 11.5 L233.5 11.9 L235.8 12.3 L238.4 12.9 L241.4 13.6 L244.6 14.4 L247.9 15.3 L251.5 16.0 L255.2 16.7 L258.8 17.5 L262.4 18.4 L265.9 19.5 L269.2 20.8 L272.5 22.0 L275.9 23.1 L279.5 24.1 L283.1 25.2 L286.6 26.6 L290.1 28.1 L293.5 29.8 L297.0 31.4 L300.4 32.8 L303.9 34.2 L307.2 35.6 L310.3 37.3 L313.2 39.2 L316.0 41.3 L318.8 43.2 L321.7 45.0 L324.7 46.7 L327.5 48.5 L330.2 50.6 L332.6 52.9 L335.0 55.3 L337.4 57.6 L339.9 59.7 L342.5 61.7 L345.0 63.9 L347.2 66.3 L349.2 69.0 L351.1 71.8 L353.0 74.5 L355.2 77.0 L357.5 79.4 L359.7 81.9 L361.5 84.7 L363.1 87.7 L364.5 90.8 L366.0 93.7 L367.8 96.4 L369.8 99.1 L371.5 101.9 L372.9 105.0 L373.9 108.2 L374.8 111.6 L375.9 114.8 L377.4 118.0 L379.2 121.0 L380.8 124.2 L382.0 127.6 L382.9 131.0 L383.8 134.6 L385.0 138.3 L386.7 142.0 L388.7 145.6 L390.5 149.4 L391.8 153.2 L392.7 157.1 L393.5 160.8 L394.4 164.2 L395.8 166.9 L397.2 169.2 L398.3 171.1Z' fill='#4a3822'/><path d='M413.7 164.9 L413.3 162.9 L412.8 160.3 L411.9 157.4 L410.4 154.3 L408.4 151.0 L406.4 147.5 L404.7 143.7 L403.4 139.7 L402.3 135.6 L400.9 131.7 L399.1 128.2 L397.1 125.0 L395.2 121.9 L393.6 118.8 L392.5 115.4 L391.5 112.0 L390.2 108.6 L388.5 105.4 L386.5 102.4 L384.5 99.3 L382.7 96.2 L381.2 92.8 L379.7 89.5 L378.0 86.3 L375.8 83.4 L373.4 80.7 L371.0 78.1 L368.7 75.2 L366.8 72.3 L364.8 69.3 L362.6 66.4 L360.0 63.9 L357.3 61.6 L354.5 59.3 L351.9 56.8 L349.5 54.3 L347.1 51.7 L344.4 49.3 L341.5 47.2 L338.5 45.3 L335.4 43.5 L332.5 41.5 L329.6 39.4 L326.7 37.2 L323.7 35.3 L320.5 33.6 L317.1 32.2 L313.7 30.7 L310.4 29.1 L307.0 27.4 L303.5 25.7 L299.9 24.2 L296.2 22.9 L292.4 21.9 L288.6 20.8 L284.9 19.7 L281.3 18.4 L277.8 17.2 L274.3 16.1 L270.8 15.2 L267.2 14.5' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M331.5 43.1 L329.8 41.6 L327.4 39.8 L324.5 37.8 L321.1 35.6 L317.6 33.2 L314.0 30.6 L310.5 27.9 L307.2 25.2 L304.1 22.6 L301.3 20.4 L299.0 18.5 L297.4 16.9 L296.6 15.7 L296.3 14.8 L296.4 14.1 L296.5 13.5 L296.8 12.8 L297.3 12.0 L298.0 11.2 L298.8 10.3 L299.7 9.5 L300.6 8.6 L301.2 7.4 L301.4 6.1 L301.2 4.9 L300.9 3.8 L300.5 2.8 L300.2 1.7 L299.7 0.7 L299.3 -0.3 L298.7 -1.1 L298.1 -1.9 L297.6 -2.7 L297.2 -3.3 L296.9 -3.9 L296.7 -4.3 L295.3 -3.7 L295.5 -3.2 L295.8 -2.6 L296.2 -1.8 L296.5 -1.0 L296.9 -0.2 L297.2 0.8 L297.7 1.7 L298.1 2.6 L298.4 3.5 L298.6 4.4 L298.7 5.2 L298.6 5.9 L298.4 6.4 L298.1 6.8 L297.6 7.5 L296.9 8.3 L296.0 9.0 L294.9 9.9 L293.9 10.8 L293.1 12.1 L292.7 13.7 L292.8 15.5 L293.5 17.2 L294.6 19.1 L296.2 21.2 L298.4 23.5 L301.2 26.0 L304.4 28.6 L307.9 31.2 L311.5 33.9 L315.1 36.6 L318.4 39.3 L321.5 41.8 L324.3 44.0 L326.7 45.7 L328.5 46.9Z' fill='#4a3822'/><path d='M331.5 43.1 L329.8 41.6 L327.4 39.8 L324.5 37.8 L321.1 35.6 L317.6 33.2 L314.0 30.6 L310.5 27.9 L307.2 25.2 L304.1 22.6 L301.3 20.4 L299.0 18.5 L297.4 16.9 L296.6 15.7 L296.3 14.8 L296.4 14.1 L296.5 13.5 L296.8 12.8 L297.3 12.0 L298.0 11.2 L298.8 10.3 L299.7 9.5 L300.6 8.6 L301.2 7.4 L301.4 6.1 L301.2 4.9 L300.9 3.8 L300.5 2.8 L300.2 1.7 L299.7 0.7 L299.3 -0.3' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M379.9 99.7 L378.7 99.3 L377.2 98.7 L375.4 97.9 L373.4 96.8 L371.3 95.5 L369.0 94.3 L366.7 93.1 L364.3 92.1 L362.0 91.4 L359.8 90.7 L357.8 90.3 L355.9 90.1 L354.1 90.4 L352.5 91.2 L351.3 92.3 L350.3 93.6 L349.5 95.0 L348.8 96.4 L348.0 97.7 L347.3 99.0 L346.7 100.3 L346.1 101.4 L345.7 102.4 L345.2 103.1 L344.5 103.7 L343.8 104.1 L343.0 104.6 L342.3 105.0 L341.7 105.4 L341.0 105.8 L340.3 106.2 L339.7 106.4 L339.1 106.6 L338.5 106.8 L338.1 107.0 L337.7 107.3 L338.3 108.7 L338.7 108.6 L339.2 108.5 L339.7 108.3 L340.3 108.1 L341.0 107.9 L341.8 107.7 L342.6 107.5 L343.4 107.2 L344.3 106.8 L345.1 106.2 L346.0 105.6 L346.8 104.9 L347.8 104.0 L348.7 103.0 L349.5 101.8 L350.2 100.5 L350.8 99.2 L351.4 97.9 L352.1 96.7 L353.0 95.7 L353.8 95.0 L354.6 94.5 L355.3 94.1 L356.1 93.9 L357.2 93.9 L358.8 94.3 L360.6 95.1 L362.6 96.1 L364.7 97.3 L366.9 98.4 L369.1 99.5 L371.3 100.6 L373.2 101.7 L374.9 102.8 L376.4 103.8 L377.5 104.6Z' fill='#4a3822'/><path d='M379.9 99.7 L378.7 99.3 L377.2 98.7 L375.4 97.9 L373.4 96.8 L371.3 95.5 L369.0 94.3 L366.7 93.1 L364.3 92.1 L362.0 91.4 L359.8 90.7 L357.8 90.3 L355.9 90.1 L354.1 90.4 L352.5 91.2 L351.3 92.3 L350.3 93.6 L349.5 95.0 L348.8 96.4 L348.0 97.7 L347.3 99.0 L346.7 100.3 L346.1 101.4 L345.7 102.4 L345.2 103.1 L344.5 103.7 L343.8 104.1 L343.0 104.6 L342.3 105.0 L341.7 105.4 L341.0 105.8' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M4.0 128.0 Q6.5 122.8 9.0 128.0 Q11.5 122.1 14.0 128.0 Q16.5 123.4 19.0 128.0 Q21.5 123.7 24.0 128.0Z' fill='#4f8a33'/><circle cx='19.0' cy='123.8' r='1.2' fill='#8cc65e' opacity='.8'/><circle cx='18.9' cy='124.3' r='1.1' fill='#8cc65e' opacity='.8'/><circle cx='9.6' cy='125.2' r='0.8' fill='#8cc65e' opacity='.8'/><circle cx='6.5' cy='126.7' r='0.8' fill='#8cc65e' opacity='.8'/><circle cx='10.1' cy='124.7' r='1.3' fill='#8cc65e' opacity='.8'/><path d='M52.0 52.0 Q54.0 47.9 56.0 52.0 Q58.0 46.7 60.0 52.0 Q62.0 46.5 64.0 52.0 Q66.0 46.6 68.0 52.0Z' fill='#4f8a33'/><circle cx='58.3' cy='50.4' r='0.8' fill='#8cc65e' opacity='.8'/><circle cx='56.1' cy='50.5' r='1.0' fill='#8cc65e' opacity='.8'/><circle cx='65.1' cy='48.9' r='0.9' fill='#8cc65e' opacity='.8'/><circle cx='62.0' cy='49.0' r='0.7' fill='#8cc65e' opacity='.8'/><path d='M372.0 104.0 Q374.5 98.4 377.0 104.0 Q379.5 97.7 382.0 104.0 Q384.5 98.1 387.0 104.0 Q389.5 98.1 392.0 104.0Z' fill='#4f8a33'/><circle cx='381.6' cy='102.3' r='1.2' fill='#8cc65e' opacity='.8'/><circle cx='379.3' cy='100.4' r='1.3' fill='#8cc65e' opacity='.8'/><circle cx='380.3' cy='101.6' r='1.3' fill='#8cc65e' opacity='.8'/><circle cx='385.6' cy='102.3' r='0.7' fill='#8cc65e' opacity='.8'/><circle cx='376.4' cy='100.1' r='1.2' fill='#8cc65e' opacity='.8'/><path d='M318.0 38.0 Q320.0 34.6 322.0 38.0 Q324.0 32.9 326.0 38.0 Q328.0 32.5 330.0 38.0 Q332.0 33.4 334.0 38.0Z' fill='#4f8a33'/><circle cx='324.1' cy='35.6' r='0.7' fill='#8cc65e' opacity='.8'/><circle cx='319.8' cy='34.6' r='1.1' fill='#8cc65e' opacity='.8'/><circle cx='326.3' cy='34.7' r='0.9' fill='#8cc65e' opacity='.8'/><circle cx='330.8' cy='34.9' r='0.7' fill='#8cc65e' opacity='.8'/><g class='a-leaf' style='--d:3.97s;--dl:-1.3s;--o:0.9px 138.8px'><path d='M2.3 140.0 C1.7 145.6 7.3 149.3 12.0 149.0 C11.9 144.2 7.8 138.9 2.3 140.0Z' fill='#6aa84a'/><path d='M2.3 140.0 C1.7 145.6 7.3 149.3 12.0 149.0Z' fill='#4f8a33'/><path d='M0.9 138.8 L12.0 149.0' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M4.7 142.3 L4.2 145.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M4.7 142.3 L7.8 141.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M6.7 144.1 L6.2 147.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M6.7 144.1 L9.7 143.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M8.6 145.8 L8.1 149.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M8.6 145.8 L11.7 145.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.24s;--dl:-1.42s;--o:12.3px 117.2px'><path d='M12.8 119.2 C8.9 124.1 12.0 130.9 16.6 133.4 C19.3 128.9 18.6 121.5 12.8 119.2Z' fill='#4f8a33'/><path d='M12.8 119.2 C8.9 124.1 12.0 130.9 16.6 133.4Z' fill='#3f7a35'/><path d='M12.3 117.2 L16.6 133.4' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M13.8 122.8 L11.4 125.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M13.8 122.8 L17.1 123.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M14.5 125.6 L12.2 128.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M14.5 125.6 L17.8 126.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M15.3 128.5 L12.9 131.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M15.3 128.5 L18.6 129.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.36s;--dl:-3.67s;--o:21.8px 98.6px'><path d='M22.8 100.3 C20.4 105.8 25.0 111.4 30.0 112.7 C31.4 107.7 28.8 101.0 22.8 100.3Z' fill='#8cc65e'/><path d='M22.8 100.3 C20.4 105.8 25.0 111.4 30.0 112.7Z' fill='#6aa84a'/><path d='M21.8 98.6 L30.0 112.7' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M24.6 103.4 L23.1 106.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M24.6 103.4 L28.0 103.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M26.0 105.9 L24.5 108.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M26.0 105.9 L29.4 106.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M27.5 108.3 L25.9 111.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M27.5 108.3 L30.9 108.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.52s;--dl:-3.49s;--o:32.0px 80.8px'><path d='M33.1 82.5 C30.9 88.2 35.9 93.7 41.0 94.6 C42.2 89.5 39.2 82.8 33.1 82.5Z' fill='#8cc65e'/><path d='M33.1 82.5 C30.9 88.2 35.9 93.7 41.0 94.6Z' fill='#6aa84a'/><path d='M32.0 80.8 L41.0 94.6' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M35.1 85.5 L33.7 88.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M35.1 85.5 L38.5 85.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M36.7 88.0 L35.3 91.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M36.7 88.0 L40.1 88.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M38.2 90.4 L36.8 93.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M38.2 90.4 L41.7 90.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.91s;--dl:-1.89s;--o:45.3px 64.6px'><path d='M46.3 66.5 C43.5 72.6 48.4 79.0 53.9 80.5 C55.7 75.0 53.0 67.4 46.3 66.5Z' fill='#6aa84a'/><path d='M46.3 66.5 C43.5 72.6 48.4 79.0 53.9 80.5Z' fill='#4f8a33'/><path d='M45.3 64.6 L53.9 80.5' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M48.2 70.0 L46.4 73.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M48.2 70.0 L52.0 70.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M49.8 72.8 L47.9 76.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M49.8 72.8 L53.5 73.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M51.3 75.6 L49.5 78.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M51.3 75.6 L55.0 75.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.83s;--dl:-2.12s;--o:61.1px 50.1px'><path d='M62.3 52.0 C59.8 58.1 64.9 64.1 70.5 65.3 C71.9 59.8 68.8 52.5 62.3 52.0Z' fill='#7bbf55'/><path d='M62.3 52.0 C59.8 58.1 64.9 64.1 70.5 65.3Z' fill='#5d9c43'/><path d='M61.1 50.1 L70.5 65.3' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M64.3 55.3 L62.7 58.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M64.3 55.3 L68.0 55.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M66.0 58.0 L64.4 61.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M66.0 58.0 L69.7 58.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M67.6 60.6 L66.0 64.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M67.6 60.6 L71.3 60.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.7s;--dl:-0.77s;--o:79.7px 38.6px'><path d='M80.3 40.5 C76.8 45.4 80.1 51.9 84.8 54.1 C87.3 49.5 86.1 42.3 80.3 40.5Z' fill='#8cc65e'/><path d='M80.3 40.5 C76.8 45.4 80.1 51.9 84.8 54.1Z' fill='#6aa84a'/><path d='M79.7 38.6 L84.8 54.1' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M81.4 43.9 L79.3 46.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M81.4 43.9 L84.8 44.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M82.3 46.6 L80.2 49.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M82.3 46.6 L85.7 47.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M83.2 49.4 L81.1 52.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M83.2 49.4 L86.6 50.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.61s;--dl:-3.04s;--o:100.4px 29.4px'><path d='M101.9 30.2 C102.4 35.4 108.1 37.7 112.4 36.5 C111.4 32.2 106.6 28.2 101.9 30.2Z' fill='#5d9c43'/><path d='M101.9 30.2 C102.4 35.4 108.1 37.7 112.4 36.5Z' fill='#3e6e2c'/><path d='M100.4 29.4 L112.4 36.5' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M104.5 31.8 L104.6 34.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M104.5 31.8 L107.1 30.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M106.6 33.1 L106.7 36.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M106.6 33.1 L109.2 31.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M108.7 34.3 L108.8 37.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M108.7 34.3 L111.3 33.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.35s;--dl:-2.42s;--o:123.5px 22.1px'><path d='M124.9 23.9 C123.1 30.7 129.2 36.4 135.2 36.9 C136.0 31.0 131.9 23.7 124.9 23.9Z' fill='#8cc65e'/><path d='M124.9 23.9 C123.1 30.7 129.2 36.4 135.2 36.9Z' fill='#6aa84a'/><path d='M123.5 22.1 L135.2 36.9' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M127.5 27.2 L126.2 30.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M127.5 27.2 L131.4 26.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M129.5 29.8 L128.3 33.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M129.5 29.8 L133.5 29.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M131.6 32.4 L130.3 36.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M131.6 32.4 L135.5 32.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.56s;--dl:-1.91s;--o:146.6px 16.8px'><path d='M148.0 18.0 C147.5 23.4 153.0 27.0 157.7 26.6 C157.5 21.9 153.4 16.8 148.0 18.0Z' fill='#8cc65e'/><path d='M148.0 18.0 C147.5 23.4 153.0 27.0 157.7 26.6Z' fill='#6aa84a'/><path d='M146.6 16.8 L157.7 26.6' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M150.4 20.1 L150.0 23.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M150.4 20.1 L153.4 19.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M152.4 21.9 L151.9 24.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M152.4 21.9 L155.4 21.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M154.3 23.6 L153.8 26.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M154.3 23.6 L157.3 22.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.26s;--dl:-3.57s;--o:165.9px 12.8px'><path d='M166.9 14.9 C163.3 21.0 167.8 28.2 173.4 30.3 C175.8 24.8 173.7 16.5 166.9 14.9Z' fill='#7bbf55'/><path d='M166.9 14.9 C163.3 21.0 167.8 28.2 173.4 30.3Z' fill='#5d9c43'/><path d='M165.9 12.8 L173.4 30.3' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M168.5 18.8 L166.3 22.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M168.5 18.8 L172.4 19.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M169.8 21.8 L167.6 25.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M169.8 21.8 L173.7 22.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M171.1 24.9 L168.9 28.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M171.1 24.9 L175.0 25.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.82s;--dl:-1.77s;--o:400.6px 156.1px'><path d='M399.6 157.6 C394.1 158.0 391.6 164.1 392.7 168.7 C397.3 167.7 401.6 162.7 399.6 157.6Z' fill='#5d9c43'/><path d='M399.6 157.6 C394.1 158.0 391.6 164.1 392.7 168.7Z' fill='#3e6e2c'/><path d='M400.6 156.1 L392.7 168.7' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M397.9 160.4 L394.8 160.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M397.9 160.4 L399.2 163.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M396.5 162.6 L393.4 162.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M396.5 162.6 L397.8 165.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M395.1 164.8 L392.0 164.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M395.1 164.8 L396.5 167.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.98s;--dl:-1.21s;--o:391.5px 133.4px'><path d='M390.9 135.0 C385.9 136.5 384.8 142.7 386.8 146.7 C390.8 144.8 393.8 139.3 390.9 135.0Z' fill='#4f8a33'/><path d='M390.9 135.0 C385.9 136.5 384.8 142.7 386.8 146.7Z' fill='#3f7a35'/><path d='M391.5 133.4 L386.8 146.7' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M389.8 137.9 L387.0 138.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M389.8 137.9 L391.6 140.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M389.0 140.3 L386.2 141.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M389.0 140.3 L390.8 142.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M388.2 142.6 L385.3 143.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M388.2 142.6 L390.0 144.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.86s;--dl:-3.53s;--o:383.0px 113.7px'><path d='M381.7 114.8 C376.5 113.4 372.2 118.1 371.8 122.6 C376.3 123.3 381.9 120.1 381.7 114.8Z' fill='#7bbf55'/><path d='M381.7 114.8 C376.5 113.4 372.2 118.1 371.8 122.6Z' fill='#5d9c43'/><path d='M383.0 113.7 L371.8 122.6' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M379.2 116.8 L376.3 115.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M379.2 116.8 L379.5 119.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M377.2 118.3 L374.4 117.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M377.2 118.3 L377.5 121.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M375.2 119.9 L372.4 118.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M375.2 119.9 L375.5 122.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.32s;--dl:-1.95s;--o:373.8px 95.0px'><path d='M373.1 97.2 C366.3 99.4 365.0 107.8 367.8 113.2 C373.3 110.6 377.2 103.0 373.1 97.2Z' fill='#4f8a33'/><path d='M373.1 97.2 C366.3 99.4 365.0 107.8 367.8 113.2Z' fill='#3f7a35'/><path d='M373.8 95.0 L367.8 113.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M371.7 101.2 L367.9 102.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M371.7 101.2 L374.3 104.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M370.7 104.4 L366.8 105.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M370.7 104.4 L373.2 107.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M369.6 107.6 L365.8 108.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M369.6 107.6 L372.2 110.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.87s;--dl:-3.98s;--o:362.1px 77.8px'><path d='M360.2 79.2 C353.4 76.9 347.3 82.9 346.3 88.9 C352.3 90.1 360.0 86.4 360.2 79.2Z' fill='#6aa84a'/><path d='M360.2 79.2 C353.4 76.9 347.3 82.9 346.3 88.9Z' fill='#4f8a33'/><path d='M362.1 77.8 L346.3 88.9' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M356.7 81.6 L353.0 80.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M356.7 81.6 L356.9 85.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M354.0 83.6 L350.2 82.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M354.0 83.6 L354.1 87.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M351.2 85.5 L347.4 84.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M351.2 85.5 L351.3 89.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.17s;--dl:-2.89s;--o:348.5px 62.4px'><path d='M347.5 64.1 C341.6 64.7 339.0 71.3 340.4 76.2 C345.3 75.0 349.8 69.5 347.5 64.1Z' fill='#7bbf55'/><path d='M347.5 64.1 C341.6 64.7 339.0 71.3 340.4 76.2Z' fill='#5d9c43'/><path d='M348.5 62.4 L340.4 76.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M345.7 67.1 L342.4 67.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M345.7 67.1 L347.2 70.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M344.3 69.5 L341.0 69.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M344.3 69.5 L345.8 72.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M342.9 71.9 L339.5 72.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M342.9 71.9 L344.4 74.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.87s;--dl:-1.54s;--o:332.8px 49.0px'><path d='M331.8 50.4 C326.7 50.2 323.7 55.5 324.3 59.9 C328.6 59.4 333.1 55.3 331.8 50.4Z' fill='#5d9c43'/><path d='M331.8 50.4 C326.7 50.2 323.7 55.5 324.3 59.9Z' fill='#3e6e2c'/><path d='M332.8 49.0 L324.3 59.9' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M329.9 52.7 L327.0 52.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M329.9 52.7 L330.8 55.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M328.4 54.6 L325.5 54.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M328.4 54.6 L329.3 57.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M326.9 56.5 L324.0 56.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M326.9 56.5 L327.8 59.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.8s;--dl:-3.67s;--o:315.1px 37.7px'><path d='M314.3 39.6 C308.4 41.0 306.6 48.2 308.7 53.0 C313.6 51.1 317.5 44.9 314.3 39.6Z' fill='#4f8a33'/><path d='M314.3 39.6 C308.4 41.0 306.6 48.2 308.7 53.0Z' fill='#3f7a35'/><path d='M315.1 37.7 L308.7 53.0' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M312.9 42.9 L309.5 43.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M312.9 42.9 L314.9 45.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M311.8 45.6 L308.4 46.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M311.8 45.6 L313.8 48.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M310.7 48.3 L307.3 48.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M310.7 48.3 L312.6 51.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.08s;--dl:-0.16s;--o:294.9px 28.4px'><path d='M293.3 29.3 C288.1 27.3 283.2 31.7 282.2 36.4 C286.8 37.5 292.9 34.9 293.3 29.3Z' fill='#4f8a33'/><path d='M293.3 29.3 C288.1 27.3 283.2 31.7 282.2 36.4Z' fill='#3f7a35'/><path d='M294.9 28.4 L282.2 36.4' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M290.5 31.1 L287.7 29.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M290.5 31.1 L290.5 34.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M288.3 32.5 L285.5 31.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M288.3 32.5 L288.3 35.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M286.1 33.9 L283.2 32.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M286.1 33.9 L286.1 37.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.08s;--dl:-3.4s;--o:273.4px 21.0px'><path d='M272.6 23.1 C266.1 24.8 264.4 32.7 266.8 37.9 C272.1 35.7 276.2 28.8 272.6 23.1Z' fill='#6aa84a'/><path d='M272.6 23.1 C266.1 24.8 264.4 32.7 266.8 37.9Z' fill='#4f8a33'/><path d='M273.4 21.0 L266.8 37.9' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M271.1 26.8 L267.4 27.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M271.1 26.8 L273.4 29.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M270.0 29.8 L266.3 30.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M270.0 29.8 L272.2 32.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M268.8 32.7 L265.1 33.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M268.8 32.7 L271.1 35.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.87s;--dl:-3.68s;--o:252.0px 15.7px'><path d='M250.1 16.7 C244.2 13.9 238.0 18.6 236.5 24.0 C241.8 25.7 249.1 23.1 250.1 16.7Z' fill='#5d9c43'/><path d='M250.1 16.7 C244.2 13.9 238.0 18.6 236.5 24.0Z' fill='#3e6e2c'/><path d='M252.0 15.7 L236.5 24.0' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M246.7 18.5 L243.5 16.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M246.7 18.5 L246.4 22.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M244.0 20.0 L240.7 18.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M244.0 20.0 L243.7 23.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M241.3 21.4 L238.0 19.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M241.3 21.4 L240.9 25.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.1s;--dl:-3.2s;--o:140.0px 50.0px'><path d='M139.5 52.2 C133.3 55.1 132.8 63.3 136.1 68.2 C141.1 65.1 144.1 57.4 139.5 52.2Z' fill='#4f8a33'/><path d='M139.5 52.2 C133.3 55.1 132.8 63.3 136.1 68.2Z' fill='#3f7a35'/><path d='M140.0 50.0 L136.1 68.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M138.7 56.2 L135.1 57.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M138.7 56.2 L141.4 59.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M138.0 59.4 L134.4 60.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M138.0 59.4 L140.7 62.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M137.3 62.6 L133.7 64.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M137.3 62.6 L140.1 65.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.29s;--dl:-2.54s;--o:66.0px 74.0px'><path d='M65.2 75.9 C59.1 77.2 57.2 84.5 59.2 89.4 C64.2 87.5 68.3 81.3 65.2 75.9Z' fill='#7bbf55'/><path d='M65.2 75.9 C59.1 77.2 57.2 84.5 59.2 89.4Z' fill='#5d9c43'/><path d='M66.0 74.0 L59.2 89.4' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M63.7 79.3 L60.2 79.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M63.7 79.3 L65.6 82.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M62.5 82.0 L59.0 82.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M62.5 82.0 L64.4 84.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M61.3 84.7 L57.9 85.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M61.3 84.7 L63.2 87.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.72s;--dl:-3.45s;--o:338.0px 108.0px'><path d='M339.0 110.2 C335.5 116.6 340.4 123.8 346.3 125.8 C348.5 120.0 346.1 111.6 339.0 110.2Z' fill='#6aa84a'/><path d='M339.0 110.2 C335.5 116.6 340.4 123.8 346.3 125.8Z' fill='#4f8a33'/><path d='M338.0 108.0 L346.3 125.8' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M340.8 114.1 L338.7 117.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M340.8 114.1 L344.9 114.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M342.3 117.2 L340.1 120.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M342.3 117.2 L346.4 117.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M343.7 120.3 L341.6 123.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M343.7 120.3 L347.8 120.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.62s;--dl:-3.98s;--o:296.0px -2.0px'><path d='M295.6 -4.1 C300.0 -8.6 297.5 -15.8 293.0 -18.8 C289.8 -14.5 290.0 -6.9 295.6 -4.1Z' fill='#5d9c43'/><path d='M295.6 -4.1 C300.0 -8.6 297.5 -15.8 293.0 -18.8Z' fill='#3e6e2c'/><path d='M296.0 -2.0 L293.0 -18.8' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M295.0 -7.8 L297.6 -10.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M295.0 -7.8 L291.7 -9.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M294.5 -10.7 L297.1 -13.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M294.5 -10.7 L291.2 -12.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M293.9 -13.7 L296.6 -16.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M293.9 -13.7 L290.6 -15.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.27s;--dl:-1.07s;--o:296.0px -2.0px'><path d='M297.4 -3.2 C302.7 -1.9 307.0 -6.8 307.4 -11.5 C302.7 -12.0 297.0 -8.6 297.4 -3.2Z' fill='#5d9c43'/><path d='M297.4 -3.2 C302.7 -1.9 307.0 -6.8 307.4 -11.5Z' fill='#3e6e2c'/><path d='M296.0 -2.0 L307.4 -11.5' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M299.9 -5.3 L302.8 -4.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M299.9 -5.3 L299.5 -8.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M301.9 -6.9 L304.8 -6.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M301.9 -6.9 L301.5 -10.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M303.9 -8.6 L306.8 -7.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M303.9 -8.6 L303.5 -11.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.68s;--dl:-2.84s;--o:182.0px 8.0px'><path d='M179.9 8.8 C174.3 5.0 167.2 9.0 164.9 14.2 C170.0 16.8 178.0 15.2 179.9 8.8Z' fill='#6aa84a'/><path d='M179.9 8.8 C174.3 5.0 167.2 9.0 164.9 14.2Z' fill='#4f8a33'/><path d='M182.0 8.0 L164.9 14.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M176.1 10.1 L173.1 7.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M176.1 10.1 L175.3 13.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M173.1 11.2 L170.1 8.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M173.1 11.2 L172.3 14.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M170.1 12.3 L167.1 10.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M170.1 12.3 L169.3 16.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.34s;--dl:-1.05s;--o:182.0px 8.0px'><path d='M183.0 9.7 C180.6 15.1 185.1 20.6 190.0 21.8 C191.4 17.0 188.9 10.3 183.0 9.7Z' fill='#4f8a33'/><path d='M183.0 9.7 C180.6 15.1 185.1 20.6 190.0 21.8Z' fill='#3f7a35'/><path d='M182.0 8.0 L190.0 21.8' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M184.7 12.7 L183.2 15.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M184.7 12.7 L188.1 12.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M186.1 15.2 L184.6 18.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M186.1 15.2 L189.5 15.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M187.5 17.6 L186.0 20.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M187.5 17.6 L190.9 17.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.96s;--dl:-1.25s;--o:232.0px 10.0px'><path d='M234.1 10.8 C236.0 17.2 244.0 18.8 249.1 16.2 C246.8 11.0 239.7 7.0 234.1 10.8Z' fill='#6aa84a'/><path d='M234.1 10.8 C236.0 17.2 244.0 18.8 249.1 16.2Z' fill='#4f8a33'/><path d='M232.0 10.0 L249.1 16.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M237.9 12.1 L238.7 15.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M237.9 12.1 L240.9 9.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M240.9 13.2 L241.7 16.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M240.9 13.2 L243.9 10.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M243.9 14.3 L244.7 18.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M243.9 14.3 L246.9 12.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.56s;--dl:-0.82s;--o:232.0px 10.0px'><path d='M231.0 11.7 C225.1 12.3 222.6 19.0 224.0 23.8 C228.9 22.6 233.4 17.1 231.0 11.7Z' fill='#7bbf55'/><path d='M231.0 11.7 C225.1 12.3 222.6 19.0 224.0 23.8Z' fill='#5d9c43'/><path d='M232.0 10.0 L224.0 23.8' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M229.3 14.7 L225.9 14.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M229.3 14.7 L230.8 17.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M227.9 17.2 L224.5 17.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M227.9 17.2 L229.4 20.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M226.5 19.6 L223.1 19.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M226.5 19.6 L228.0 22.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 200' width='400' height='200'><defs><filter id='glgb' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='2.5' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><path d='M2.8 122.0 L3.4 123.8 L4.5 126.1 L5.8 128.9 L6.9 132.1 L7.8 135.8 L8.6 139.7 L9.4 143.7 L10.7 147.7 L12.4 151.6 L14.3 155.3 L16.0 158.8 L17.6 162.2 L19.2 165.4 L20.9 168.5 L23.0 171.5 L25.3 174.2 L27.8 176.7 L30.2 179.2 L32.5 181.8 L34.6 184.4 L36.8 186.8 L39.1 188.9 L41.5 190.8 L43.9 192.4 L46.3 194.0 L48.7 195.6 L51.1 197.1 L53.6 198.4 L56.1 199.4 L58.5 200.2 L60.9 200.8 L63.1 201.4 L65.0 202.0 L66.7 202.6 L68.2 203.1 L69.3 203.5 L70.7 200.5 L69.5 199.8 L68.0 199.2 L66.3 198.5 L64.5 197.7 L62.5 196.8 L60.5 195.6 L58.4 194.4 L56.2 193.2 L54.0 192.0 L51.8 190.8 L49.8 189.3 L48.1 187.6 L46.4 185.5 L44.6 183.4 L42.6 181.2 L40.5 179.0 L38.3 176.7 L36.3 174.3 L34.5 171.5 L32.9 168.7 L31.3 165.8 L29.7 163.0 L28.0 160.4 L26.4 157.8 L25.0 154.9 L24.1 151.6 L23.3 147.9 L22.6 144.1 L21.6 140.3 L20.4 136.6 L19.3 132.9 L18.4 129.4 L18.0 126.0 L17.8 122.8 L17.7 120.1 L17.2 118.0Z' fill='#3a2b18'/><path d='M2.8 122.0 L3.4 123.8 L4.5 126.1 L5.8 128.9 L6.9 132.1 L7.8 135.8 L8.6 139.7 L9.4 143.7 L10.7 147.7 L12.4 151.6 L14.3 155.3 L16.0 158.8 L17.6 162.2 L19.2 165.4 L20.9 168.5 L23.0 171.5 L25.3 174.2 L27.8 176.7 L30.2 179.2 L32.5 181.8 L34.6 184.4 L36.8 186.8 L39.1 188.9 L41.5 190.8 L43.9 192.4 L46.3 194.0 L48.7 195.6 L51.1 197.1 L53.6 198.4 L56.1 199.4 L58.5 200.2' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M2.7 150.7 L3.3 152.1 L4.0 153.9 L4.6 156.1 L4.9 158.6 L5.1 161.3 L5.4 164.2 L5.9 167.1 L6.7 170.0 L7.4 172.8 L8.1 175.6 L8.5 178.2 L8.7 180.5 L9.1 182.7 L9.6 184.9 L10.3 187.1 L11.0 189.2 L11.6 191.3 L12.0 193.3 L12.4 195.2 L12.8 197.0 L13.2 198.6 L13.8 200.0 L14.3 201.3 L14.6 202.3 L17.4 201.7 L17.3 200.7 L17.4 199.4 L17.3 197.8 L17.2 196.2 L16.8 194.4 L16.5 192.5 L16.1 190.4 L16.0 188.3 L15.9 186.1 L15.8 183.9 L15.6 181.6 L15.3 179.5 L14.8 177.2 L14.5 174.7 L14.4 171.9 L14.4 169.0 L14.4 166.0 L14.1 163.1 L13.7 160.2 L13.2 157.5 L12.9 155.0 L12.9 152.8 L13.1 150.8 L13.3 149.3Z' fill='#3a2b18'/><path d='M2.7 150.7 L3.3 152.1 L4.0 153.9 L4.6 156.1 L4.9 158.6 L5.1 161.3 L5.4 164.2 L5.9 167.1 L6.7 170.0 L7.4 172.8 L8.1 175.6 L8.5 178.2 L8.7 180.5 L9.1 182.7 L9.6 184.9 L10.3 187.1 L11.0 189.2 L11.6 191.3 L12.0 193.3 L12.4 195.2 L12.8 197.0' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M383.7 118.2 L383.5 120.2 L382.7 122.4 L381.6 125.2 L380.6 128.3 L379.8 131.9 L379.2 135.8 L378.7 139.8 L377.9 143.9 L377.0 147.9 L376.1 151.9 L375.5 155.9 L375.5 159.8 L375.9 163.6 L376.6 167.6 L377.3 171.7 L377.9 175.9 L378.5 180.0 L379.3 184.1 L380.4 187.9 L381.5 191.5 L382.5 194.8 L383.4 197.8 L384.0 200.3 L384.5 202.3 L387.5 201.7 L387.3 199.7 L386.9 197.1 L386.6 194.0 L386.2 190.6 L385.9 186.8 L385.4 182.9 L384.8 179.0 L384.2 175.0 L383.8 171.0 L383.7 167.1 L384.0 163.5 L384.5 160.2 L385.1 157.0 L385.7 153.6 L386.3 149.9 L387.1 146.2 L388.4 142.5 L390.0 139.0 L391.7 135.6 L393.1 132.3 L394.0 129.1 L394.7 126.2 L395.5 123.7 L396.3 121.8Z' fill='#3a2b18'/><path d='M383.7 118.2 L383.5 120.2 L382.7 122.4 L381.6 125.2 L380.6 128.3 L379.8 131.9 L379.2 135.8 L378.7 139.8 L377.9 143.9 L377.0 147.9 L376.1 151.9 L375.5 155.9 L375.5 159.8 L375.9 163.6 L376.6 167.6 L377.3 171.7 L377.9 175.9 L378.5 180.0 L379.3 184.1 L380.4 187.9 L381.5 191.5' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M389.4 150.5 L389.5 152.1 L389.5 154.2 L389.8 156.6 L390.3 159.2 L391.1 162.1 L391.8 165.2 L392.3 168.3 L392.7 171.5 L393.0 174.6 L393.4 177.5 L394.0 180.2 L394.8 182.6 L395.6 184.8 L396.3 186.9 L396.9 189.0 L397.4 191.1 L398.1 193.0 L398.9 194.8 L399.7 196.4 L400.5 197.9 L401.2 199.3 L401.7 200.5 L402.1 201.6 L402.5 202.5 L405.5 201.5 L405.3 200.5 L405.0 199.4 L404.6 198.1 L404.2 196.6 L403.9 195.0 L403.6 193.2 L403.3 191.4 L402.7 189.5 L402.1 187.6 L401.6 185.6 L401.3 183.5 L401.2 181.4 L401.1 179.1 L401.0 176.4 L400.6 173.6 L400.1 170.6 L399.6 167.5 L399.5 164.3 L399.5 161.2 L399.6 158.2 L399.6 155.5 L399.3 153.1 L398.9 151.1 L398.6 149.5Z' fill='#3a2b18'/><path d='M389.4 150.5 L389.5 152.1 L389.5 154.2 L389.8 156.6 L390.3 159.2 L391.1 162.1 L391.8 165.2 L392.3 168.3 L392.7 171.5 L393.0 174.6 L393.4 177.5 L394.0 180.2 L394.8 182.6 L395.6 184.8 L396.3 186.9 L396.9 189.0 L397.4 191.1 L398.1 193.0 L398.9 194.8 L399.7 196.4 L400.5 197.9' stroke='#6b5333' stroke-width='1.3' fill='none' opacity='.7' stroke-linecap='round'/><path d='M-6 202 L-6 168 Q30 164 70 180 Q130 196 200 197 Q270 196 300 190 Q340 186 380 170 Q396 164 406 166 L406 202Z' fill='#1b2412'/><path d='M-4.0 172.0 Q-1.5 166.2 1.0 172.0 Q3.5 165.8 6.0 172.0 Q8.5 164.6 11.0 172.0 Q13.5 166.2 16.0 172.0 Q18.5 166.0 21.0 172.0 Q23.5 165.7 26.0 172.0 Q28.5 167.2 31.0 172.0 Q33.5 166.0 36.0 172.0 Q38.5 165.6 41.0 172.0 Q43.5 165.0 46.0 172.0 Q48.5 167.5 51.0 172.0 Q53.5 166.7 56.0 172.0 Q58.5 167.5 61.0 172.0 Q63.5 165.0 66.0 172.0 Q68.5 165.4 71.0 172.0 Q73.5 167.7 76.0 172.0Z' fill='#2f5e2a'/><circle cx='66.9' cy='167.2' r='1.1' fill='#4f8a33' opacity='.8'/><circle cx='43.4' cy='170.0' r='0.6' fill='#4f8a33' opacity='.8'/><circle cx='37.8' cy='170.4' r='0.7' fill='#4f8a33' opacity='.8'/><circle cx='19.5' cy='170.5' r='0.9' fill='#4f8a33' opacity='.8'/><circle cx='32.2' cy='167.7' r='1.0' fill='#4f8a33' opacity='.8'/><circle cx='45.0' cy='168.9' r='1.1' fill='#4f8a33' opacity='.8'/><circle cx='33.3' cy='169.6' r='1.3' fill='#4f8a33' opacity='.8'/><circle cx='67.7' cy='167.7' r='1.1' fill='#4f8a33' opacity='.8'/><circle cx='24.2' cy='169.8' r='0.8' fill='#4f8a33' opacity='.8'/><circle cx='8.5' cy='167.9' r='0.9' fill='#4f8a33' opacity='.8'/><circle cx='58.2' cy='169.2' r='1.3' fill='#4f8a33' opacity='.8'/><circle cx='58.2' cy='170.6' r='0.7' fill='#4f8a33' opacity='.8'/><circle cx='62.3' cy='169.0' r='1.3' fill='#4f8a33' opacity='.8'/><circle cx='29.4' cy='170.3' r='1.0' fill='#4f8a33' opacity='.8'/><circle cx='53.8' cy='169.7' r='0.7' fill='#4f8a33' opacity='.8'/><circle cx='25.3' cy='167.2' r='1.1' fill='#4f8a33' opacity='.8'/><circle cx='11.6' cy='169.7' r='0.7' fill='#4f8a33' opacity='.8'/><circle cx='7.8' cy='167.8' r='0.7' fill='#4f8a33' opacity='.8'/><circle cx='39.8' cy='169.0' r='0.7' fill='#4f8a33' opacity='.8'/><circle cx='50.8' cy='170.1' r='1.1' fill='#4f8a33' opacity='.8'/><path d='M380.0 172.0 Q382.6 168.1 385.2 172.0 Q387.8 167.1 390.4 172.0 Q393.0 167.8 395.6 172.0 Q398.2 167.6 400.8 172.0 Q403.4 165.5 406.0 172.0Z' fill='#2f5e2a'/><circle cx='399.3' cy='169.9' r='1.2' fill='#4f8a33' opacity='.8'/><circle cx='387.0' cy='169.6' r='1.2' fill='#4f8a33' opacity='.8'/><circle cx='396.0' cy='170.5' r='1.3' fill='#4f8a33' opacity='.8'/><circle cx='387.0' cy='170.0' r='1.1' fill='#4f8a33' opacity='.8'/><circle cx='389.4' cy='169.9' r='0.7' fill='#4f8a33' opacity='.8'/><circle cx='384.5' cy='169.1' r='0.8' fill='#4f8a33' opacity='.8'/><path d='M70.0 186.0 Q72.5 182.4 75.0 186.0 Q77.5 182.9 80.0 186.0 Q82.5 182.7 85.0 186.0 Q87.5 181.7 90.0 186.0 Q92.5 182.6 95.0 186.0 Q97.5 182.5 100.0 186.0 Q102.5 181.9 105.0 186.0 Q107.5 183.2 110.0 186.0 Q112.5 183.3 115.0 186.0 Q117.5 181.8 120.0 186.0 Q122.5 182.0 125.0 186.0 Q127.5 183.1 130.0 186.0 Q132.5 183.2 135.0 186.0 Q137.5 182.1 140.0 186.0 Q142.5 181.7 145.0 186.0 Q147.5 183.2 150.0 186.0 Q152.5 181.7 155.0 186.0 Q157.5 181.8 160.0 186.0 Q162.5 182.4 165.0 186.0 Q167.5 182.8 170.0 186.0 Q172.5 183.4 175.0 186.0 Q177.5 183.5 180.0 186.0 Q182.5 181.7 185.0 186.0 Q187.5 183.1 190.0 186.0 Q192.5 182.2 195.0 186.0 Q197.5 183.1 200.0 186.0 Q202.5 182.0 205.0 186.0 Q207.5 182.4 210.0 186.0 Q212.5 183.0 215.0 186.0 Q217.5 183.2 220.0 186.0 Q222.5 182.2 225.0 186.0 Q227.5 183.5 230.0 186.0 Q232.5 183.1 235.0 186.0 Q237.5 182.5 240.0 186.0 Q242.5 181.9 245.0 186.0 Q247.5 182.4 250.0 186.0 Q252.5 183.0 255.0 186.0 Q257.5 181.8 260.0 186.0 Q262.5 183.2 265.0 186.0 Q267.5 183.6 270.0 186.0 Q272.5 183.1 275.0 186.0 Q277.5 182.7 280.0 186.0 Q282.5 183.5 285.0 186.0 Q287.5 183.2 290.0 186.0 Q292.5 182.9 295.0 186.0 Q297.5 182.5 300.0 186.0Z' fill='#243a18'/><circle cx='117.2' cy='184.5' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='273.4' cy='183.9' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='200.5' cy='184.9' r='0.6' fill='#2f5e2a' opacity='.8'/><circle cx='96.3' cy='183.4' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='270.1' cy='185.2' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='181.7' cy='183.7' r='0.8' fill='#2f5e2a' opacity='.8'/><circle cx='276.9' cy='185.0' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='228.6' cy='183.4' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='222.5' cy='183.6' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='157.7' cy='183.8' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='253.3' cy='184.4' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='251.9' cy='184.1' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='163.3' cy='184.0' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='107.8' cy='183.9' r='1.3' fill='#2f5e2a' opacity='.8'/><circle cx='254.9' cy='183.7' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='228.2' cy='184.0' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='247.3' cy='185.0' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='98.5' cy='184.0' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='135.4' cy='183.8' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='206.1' cy='183.4' r='0.8' fill='#2f5e2a' opacity='.8'/><circle cx='95.1' cy='184.6' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='130.3' cy='184.9' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='214.4' cy='184.3' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='153.2' cy='183.9' r='0.7' fill='#2f5e2a' opacity='.8'/><circle cx='172.3' cy='183.6' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='255.0' cy='184.4' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='151.2' cy='184.9' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='247.0' cy='183.5' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='267.8' cy='184.6' r='0.7' fill='#2f5e2a' opacity='.8'/><circle cx='175.9' cy='184.6' r='0.7' fill='#2f5e2a' opacity='.8'/><circle cx='169.2' cy='183.9' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='151.0' cy='183.5' r='1.3' fill='#2f5e2a' opacity='.8'/><circle cx='176.3' cy='185.1' r='0.6' fill='#2f5e2a' opacity='.8'/><circle cx='253.6' cy='185.1' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='198.0' cy='184.6' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='96.5' cy='184.9' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='97.5' cy='183.5' r='0.8' fill='#2f5e2a' opacity='.8'/><circle cx='118.9' cy='185.1' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='175.2' cy='183.9' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='241.6' cy='183.3' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='129.7' cy='184.2' r='0.7' fill='#2f5e2a' opacity='.8'/><circle cx='95.0' cy='184.3' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='126.0' cy='184.7' r='0.8' fill='#2f5e2a' opacity='.8'/><circle cx='221.3' cy='184.2' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='232.1' cy='184.4' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='259.7' cy='185.0' r='1.3' fill='#2f5e2a' opacity='.8'/><circle cx='225.9' cy='184.9' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='208.1' cy='183.4' r='0.9' fill='#2f5e2a' opacity='.8'/><circle cx='197.7' cy='183.4' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='266.7' cy='184.3' r='1.1' fill='#2f5e2a' opacity='.8'/><circle cx='130.7' cy='183.8' r='1.2' fill='#2f5e2a' opacity='.8'/><circle cx='211.1' cy='183.8' r='0.7' fill='#2f5e2a' opacity='.8'/><circle cx='258.6' cy='183.2' r='1.3' fill='#2f5e2a' opacity='.8'/><circle cx='191.8' cy='183.6' r='0.8' fill='#2f5e2a' opacity='.8'/><circle cx='260.4' cy='183.5' r='0.8' fill='#2f5e2a' opacity='.8'/><circle cx='108.2' cy='184.3' r='1.0' fill='#2f5e2a' opacity='.8'/><circle cx='234.4' cy='184.2' r='0.6' fill='#2f5e2a' opacity='.8'/><path d='M10.0 176 Q12.6 168.2 14.2 163.0 Q13.6 168.2 13.0 176Z' fill='#3e7a33' opacity='0.79'/><path d='M14.8 176 Q18.8 167.6 22.5 162.0 Q19.8 167.6 17.8 176Z' fill='#3e7a33' opacity='0.80'/><path d='M42.0 176 Q39.5 170.8 33.5 167.3 Q40.5 170.8 45.0 176Z' fill='#3e7a33' opacity='0.75'/><path d='M49.5 176 Q53.4 171.8 56.9 168.9 Q54.4 171.8 52.5 176Z' fill='#3e7a33' opacity='0.69'/><path d='M16.4 176 Q21.9 171.9 27.8 169.2 Q22.9 171.9 19.4 176Z' fill='#3e7a33' opacity='0.90'/><path d='M76.8 176 Q74.5 168.6 68.9 163.7 Q75.5 168.6 79.8 176Z' fill='#3e7a33' opacity='0.73'/><path d='M41.3 176 Q46.4 171.5 51.8 168.5 Q47.4 171.5 44.3 176Z' fill='#3e7a33' opacity='0.75'/><path d='M9.1 176 Q7.6 167.5 3.0 161.8 Q8.6 167.5 12.1 176Z' fill='#3e7a33' opacity='0.97'/><path d='M37.1 176 Q37.3 169.0 35.5 164.3 Q38.3 169.0 40.1 176Z' fill='#3e7a33' opacity='0.79'/><path d='M12.1 176 Q16.5 171.9 20.9 169.2 Q17.5 171.9 15.1 176Z' fill='#3e7a33' opacity='0.69'/><path d='M67.8 176 Q73.1 171.0 78.7 167.6 Q74.1 171.0 70.8 176Z' fill='#3e7a33' opacity='0.96'/><path d='M65.5 176 Q67.6 167.8 68.6 162.3 Q68.6 167.8 68.5 176Z' fill='#3e7a33' opacity='0.89'/><path d='M6.0 176 Q10.1 169.4 14.1 165.0 Q11.1 169.4 9.0 176Z' fill='#3e7a33' opacity='0.68'/><path d='M81.3 176 Q82.1 167.0 81.0 161.1 Q83.1 167.0 84.3 176Z' fill='#3e7a33' opacity='0.75'/><path d='M36.9 176 Q42.4 169.9 48.3 165.9 Q43.4 169.9 39.9 176Z' fill='#3e7a33' opacity='0.75'/><path d='M-3.0 176 Q0.3 171.6 2.9 168.7 Q1.3 171.6 0.0 176Z' fill='#3e7a33' opacity='1.00'/><path d='M41.1 176 Q43.0 169.3 43.6 164.9 Q44.0 169.3 44.1 176Z' fill='#3e7a33' opacity='0.90'/><path d='M15.4 176 Q17.3 168.7 18.0 163.8 Q18.3 168.7 18.4 176Z' fill='#3e7a33' opacity='0.85'/><path d='M11.5 176 Q11.8 171.2 9.9 168.0 Q12.8 171.2 14.5 176Z' fill='#3e7a33' opacity='0.97'/><path d='M27.1 176 Q27.0 168.7 24.7 163.9 Q28.0 168.7 30.1 176Z' fill='#3e7a33' opacity='0.64'/><path d='M0.7 176 Q4.4 167.5 7.7 161.8 Q5.4 167.5 3.7 176Z' fill='#3e7a33' opacity='0.75'/><path d='M58.7 176 Q63.4 168.3 68.2 163.1 Q64.4 168.3 61.7 176Z' fill='#3e7a33' opacity='0.98'/><path d='M32.8 176 Q38.0 166.5 43.5 160.1 Q39.0 166.5 35.8 176Z' fill='#3e7a33' opacity='0.84'/><path d='M77.5 176 Q78.0 169.3 76.5 164.9 Q79.0 169.3 80.5 176Z' fill='#3e7a33' opacity='0.70'/><path d='M76.9 176 Q74.9 171.2 69.7 168.0 Q75.9 171.2 79.9 176Z' fill='#3e7a33' opacity='0.92'/><path d='M67.2 176 Q71.4 169.4 75.5 165.0 Q72.4 169.4 70.2 176Z' fill='#3e7a33' opacity='0.62'/><path d='M284.2 196 Q288.9 190.8 293.6 187.3 Q289.9 190.8 287.2 196Z' fill='#355f2a' opacity='0.63'/><path d='M221.0 196 Q222.7 192.5 223.1 190.1 Q223.7 192.5 224.0 196Z' fill='#355f2a' opacity='0.65'/><path d='M145.0 196 Q144.2 192.4 140.9 190.0 Q145.2 192.4 148.0 196Z' fill='#355f2a' opacity='0.78'/><path d='M113.2 196 Q116.4 193.6 118.9 191.9 Q117.4 193.6 116.2 196Z' fill='#355f2a' opacity='0.77'/><path d='M205.9 196 Q206.3 191.5 204.6 188.4 Q207.3 191.5 208.9 196Z' fill='#355f2a' opacity='0.62'/><path d='M257.3 196 Q260.1 191.9 261.9 189.2 Q261.1 191.9 260.3 196Z' fill='#355f2a' opacity='0.85'/><path d='M292.9 196 Q296.5 192.7 299.6 190.4 Q297.5 192.7 295.9 196Z' fill='#355f2a' opacity='0.75'/><path d='M217.2 196 Q217.2 191.7 215.0 188.8 Q218.2 191.7 220.2 196Z' fill='#355f2a' opacity='0.63'/><path d='M198.6 196 Q200.8 191.5 201.9 188.5 Q201.8 191.5 201.6 196Z' fill='#355f2a' opacity='0.78'/><path d='M230.6 196 Q229.5 193.3 225.6 191.4 Q230.5 193.3 233.6 196Z' fill='#355f2a' opacity='0.73'/><path d='M263.5 196 Q261.9 193.2 257.3 191.3 Q262.9 193.2 266.5 196Z' fill='#355f2a' opacity='0.64'/><path d='M115.9 196 Q118.0 192.9 118.9 190.9 Q119.0 192.9 118.9 196Z' fill='#355f2a' opacity='0.93'/><path d='M171.4 196 Q171.2 192.6 168.6 190.4 Q172.2 192.6 174.4 196Z' fill='#355f2a' opacity='0.72'/><path d='M256.2 196 Q255.8 192.1 252.9 189.4 Q256.8 192.1 259.2 196Z' fill='#355f2a' opacity='0.64'/><path d='M257.4 196 Q261.6 191.5 265.5 188.6 Q262.6 191.5 260.4 196Z' fill='#355f2a' opacity='0.70'/><path d='M212.1 196 Q214.4 190.9 215.5 187.4 Q215.4 190.9 215.1 196Z' fill='#355f2a' opacity='0.98'/><path d='M140.3 196 Q138.2 190.7 132.9 187.1 Q139.2 190.7 143.3 196Z' fill='#355f2a' opacity='0.77'/><path d='M112.9 196 Q115.9 191.2 118.2 188.0 Q116.9 191.2 115.9 196Z' fill='#355f2a' opacity='0.99'/><path d='M261.4 196 Q263.3 190.8 263.7 187.3 Q264.3 190.8 264.4 196Z' fill='#355f2a' opacity='1.00'/><path d='M250.8 196 Q256.1 192.7 261.8 190.5 Q257.1 192.7 253.8 196Z' fill='#355f2a' opacity='0.75'/><path d='M145.2 196 Q146.5 193.6 146.0 192.0 Q147.5 193.6 148.2 196Z' fill='#355f2a' opacity='0.68'/><path d='M285.9 196 Q285.1 190.8 281.7 187.3 Q286.1 190.8 288.9 196Z' fill='#355f2a' opacity='0.64'/><path d='M209.0 196 Q210.9 193.3 211.4 191.5 Q211.9 193.3 212.0 196Z' fill='#355f2a' opacity='0.93'/><path d='M156.6 196 Q161.3 192.5 166.1 190.1 Q162.3 192.5 159.6 196Z' fill='#355f2a' opacity='0.78'/><path d='M173.6 196 Q177.6 190.9 181.4 187.6 Q178.6 190.9 176.6 196Z' fill='#355f2a' opacity='0.96'/><path d='M239.2 196 Q242.2 192.5 244.5 190.2 Q243.2 192.5 242.2 196Z' fill='#355f2a' opacity='0.93'/><path d='M230.0 196 Q229.9 193.1 227.4 191.1 Q230.9 193.1 233.0 196Z' fill='#355f2a' opacity='0.76'/><path d='M255.1 196 Q257.0 192.0 257.6 189.4 Q258.0 192.0 258.1 196Z' fill='#355f2a' opacity='0.93'/><path d='M129.1 196 Q129.3 191.8 127.3 189.0 Q130.3 191.8 132.1 196Z' fill='#355f2a' opacity='0.82'/><path d='M267.2 196 Q272.3 193.0 277.7 191.1 Q273.3 193.0 270.2 196Z' fill='#355f2a' opacity='0.63'/><path d='M401.5 172 Q399.2 167.4 393.5 164.3 Q400.2 167.4 404.5 172Z' fill='#3e7a33' opacity='1.00'/><path d='M382.9 172 Q385.6 167.5 387.5 164.4 Q386.6 167.5 385.9 172Z' fill='#3e7a33' opacity='0.74'/><path d='M399.8 172 Q405.0 166.8 410.5 163.4 Q406.0 166.8 402.8 172Z' fill='#3e7a33' opacity='0.73'/><path d='M392.9 172 Q395.9 162.8 398.1 156.7 Q396.9 162.8 395.9 172Z' fill='#3e7a33' opacity='0.97'/><path d='M395.5 172 Q400.0 167.9 404.6 165.1 Q401.0 167.9 398.5 172Z' fill='#3e7a33' opacity='0.84'/><path d='M386.0 172 Q390.3 167.1 394.5 163.8 Q391.3 167.1 389.0 172Z' fill='#3e7a33' opacity='0.83'/><path d='M401.0 172 Q406.2 163.7 411.7 158.2 Q407.2 163.7 404.0 172Z' fill='#3e7a33' opacity='0.83'/><path d='M395.3 172 Q394.8 164.6 391.9 159.7 Q395.8 164.6 398.3 172Z' fill='#3e7a33' opacity='0.98'/><path d='M386.0 172 Q391.1 163.7 396.6 158.1 Q392.1 163.7 389.0 172Z' fill='#3e7a33' opacity='0.86'/><path d='M381.9 172 Q384.8 163.4 386.8 157.7 Q385.8 163.4 384.9 172Z' fill='#3e7a33' opacity='0.67'/><g class='a-sway' style='--d:4.74s;--dl:-1.72s'><path d='M7.8 172 Q6.8 163.8 3.1 158.4 Q7.8 163.8 10.8 172Z' fill='#4f8a33' opacity='0.97'/><path d='M4.8 172 Q8.8 162.8 12.5 156.7 Q9.8 162.8 7.8 172Z' fill='#4f8a33' opacity='0.92'/><path d='M16.8 172 Q18.4 160.5 18.7 152.9 Q19.4 160.5 19.8 172Z' fill='#4f8a33' opacity='0.71'/><path d='M8.6 172 Q12.5 164.3 16.0 159.2 Q13.5 164.3 11.6 172Z' fill='#4f8a33' opacity='0.63'/><path d='M15.4 172 Q20.6 164.6 26.2 159.7 Q21.6 164.6 18.4 172Z' fill='#4f8a33' opacity='0.88'/><path d='M11.6 172 Q14.8 165.0 17.5 160.3 Q15.8 165.0 14.6 172Z' fill='#4f8a33' opacity='0.88'/><path d='M17.0 172 Q18.9 162.7 19.4 156.6 Q19.9 162.7 20.0 172Z' fill='#4f8a33' opacity='0.83'/></g><g class='a-sway slow' style='--d:5.37s;--dl:-3.66s'><path d='M36.8 176.0 Q36.2 168.5 35.6 163.5 L40.6 163.5 Q42.2 168.5 43.2 176.0Z' fill='#efe3c4'/><path d='M35.4 167.2 q2.8 1.8 5.5 0' stroke='#d8c7a0' stroke-width='1.0' fill='none'/><g class='a-sway' style='--d:2.24s;--dl:-1.6s'><path d='M26.9 164.8 Q28.1 149.8 38.1 149.1 Q48.1 149.8 49.4 164.8 Q38.1 167.2 26.9 164.8Z' fill='#d9473b'/><path d='M27.5 164.2 Q38.1 166.5 48.8 164.2' stroke='#d8c7a0' stroke-width='1.5' fill='none' opacity='.8'/><path d='M30.6 156.0 Q34.4 151.0 39.4 150.6' stroke='#fff' stroke-width='1.2' fill='none' opacity='.25' stroke-linecap='round'/><circle cx='32.5' cy='158.5' r='1.8' fill='#fff7e8'/><circle cx='39.4' cy='153.5' r='1.5' fill='#fff7e8'/><circle cx='44.4' cy='159.8' r='1.9' fill='#fff7e8'/><circle cx='37.5' cy='160.4' r='1.1' fill='#fff7e8'/><circle cx='35.6' cy='154.1' r='1.0' fill='#fff7e8'/></g></g><g class='a-sway' style='--d:5s;--dl:-0.7s'><path d='M61.5 182.0 Q60.1 173.9 62.4 168.5 L69.6 168.5 Q71.8 173.9 70.5 182.0Z' fill='#efe3c4'/><path d='M61.5 176.6 q-4 1.8 -5 5.4' stroke='#efe3c4' stroke-width='1.4' fill='none' stroke-linecap='round'/><path d='M70.5 176.6 q4 -2.7 6 -6.3' stroke='#efe3c4' stroke-width='1.4' fill='none' stroke-linecap='round'/><g class='a-blink' style='--d:4.5s;--dl:-0.7s'><ellipse cx='64.2' cy='173.0' rx='0.9' ry='1.4' fill='#2a1c10'/><ellipse cx='67.8' cy='173.0' rx='0.9' ry='1.4' fill='#2a1c10'/></g><path d='M64.7 175.7 q1.4 1.3 2.7 0' stroke='#2a1c10' stroke-width='0.5' fill='none'/><circle cx='62.8' cy='175.0' r='0.8' fill='#e88a7a' opacity='.6'/><circle cx='69.2' cy='175.0' r='0.8' fill='#e88a7a' opacity='.6'/><g class='a-nod' style='--d:2.6s;--dl:-0.7s'><path d='M56.1 170.3 Q66.0 154.1 75.9 170.3Z' fill='#d9473b'/><circle cx='61.5' cy='165.8' r='1.4' fill='#fff7e8'/><circle cx='66.9' cy='161.3' r='1.2' fill='#fff7e8'/><circle cx='71.4' cy='166.7' r='1.5' fill='#fff7e8'/><circle cx='65.1' cy='167.6' r='0.9' fill='#fff7e8'/></g></g><g class='a-sway slow' style='--d:5.8s;--dl:-2.07s'><path d='M82.4 188.0 Q82.8 184.4 83.5 182.0 L85.9 182.0 Q85.7 184.4 85.6 188.0Z' fill='#efe3c4'/><path d='M83.4 183.8 q1.3 0.8 2.6 0' stroke='#d8c7a0' stroke-width='0.5' fill='none'/><g class='a-sway' style='--d:2.76s;--dl:-3.0s'><path d='M79.3 182.6 Q79.9 175.4 84.7 175.1 Q89.5 175.4 90.1 182.6 Q84.7 183.8 79.3 182.6Z' fill='#d9473b'/><path d='M79.6 182.4 Q84.7 183.4 89.8 182.4' stroke='#d8c7a0' stroke-width='0.7' fill='none' opacity='.8'/><path d='M81.1 178.4 Q82.9 176.0 85.3 175.8' stroke='#fff' stroke-width='0.6' fill='none' opacity='.25' stroke-linecap='round'/><circle cx='82.0' cy='179.6' r='0.8' fill='#fff7e8'/><circle cx='85.3' cy='177.2' r='0.7' fill='#fff7e8'/><circle cx='87.7' cy='180.2' r='0.9' fill='#fff7e8'/><circle cx='84.4' cy='180.5' r='0.5' fill='#fff7e8'/><circle cx='83.5' cy='177.5' r='0.5' fill='#fff7e8'/></g></g><g class='a-sway slow' style='--d:5.76s;--dl:-2.32s'><path d='M22.7 180.0 Q22.8 177.0 23.0 175.0 L25.0 175.0 Q25.2 177.0 25.3 180.0Z' fill='#efe3c4'/><path d='M22.9 176.5 q1.1 0.7 2.2 0' stroke='#d8c7a0' stroke-width='0.4' fill='none'/><g class='a-sway' style='--d:3.01s;--dl:-1.32s'><path d='M19.5 175.5 Q20.0 169.5 24.0 169.2 Q28.0 169.5 28.5 175.5 Q24.0 176.5 19.5 175.5Z' fill='#c9862f'/><path d='M19.8 175.3 Q24.0 176.2 28.2 175.3' stroke='#d8c7a0' stroke-width='0.6' fill='none' opacity='.8'/><path d='M21.0 172.0 Q22.5 170.0 24.5 169.8' stroke='#fff' stroke-width='0.5' fill='none' opacity='.25' stroke-linecap='round'/></g></g><g class='a-sway' style='--d:3.88s;--dl:-1.68s'><path d='M95.3 192.0 L95.5 187.5 L96.5 187.5 L96.7 192.0Z' fill='#d9e8c8'/><g class='a-pulse' style='--d:3.53s;--dl:-2.27s'><path d='M93.3 187.9 Q96.0 183.0 98.7 187.9Z' fill='#9ff5d0' filter='url(#glgb)'/></g></g><g class='a-sway' style='--d:3.33s;--dl:-1.54s'><path d='M102.4 194.0 L102.7 190.5 L103.3 190.5 L103.6 194.0Z' fill='#d9e8c8'/><g class='a-pulse' style='--d:3.75s;--dl:-1.68s'><path d='M100.9 190.8 Q103.0 187.0 105.1 190.8Z' fill='#9ff5d0' filter='url(#glgb)'/></g></g><g class='a-sway' style='--d:4.34s;--dl:-2.86s'><path d='M7.4 176.0 L7.6 172.0 L8.4 172.0 L8.6 176.0Z' fill='#d9e8c8'/><g class='a-pulse' style='--d:3.86s;--dl:-0.77s'><path d='M5.6 172.4 Q8.0 168.0 10.4 172.4Z' fill='#9ff5d0' filter='url(#glgb)'/></g></g><g class='a-sway' style='--d:4.8s;--dl:-0.83s'><path d='M62.4 184 Q64.2 178.6 64.5 175.0 Q65.2 178.6 65.4 184Z' fill='#6aa84a' opacity='0.91'/><path d='M61.2 184 Q60.4 180.4 56.9 178.0 Q61.4 180.4 64.2 184Z' fill='#6aa84a' opacity='0.77'/><path d='M56.2 184 Q56.6 177.8 55.1 173.6 Q57.6 177.8 59.2 184Z' fill='#6aa84a' opacity='0.85'/><path d='M54.3 184 Q58.2 180.6 61.8 178.3 Q59.2 180.6 57.3 184Z' fill='#6aa84a' opacity='0.69'/><path d='M46.8 184 Q48.1 180.3 47.7 177.8 Q49.1 180.3 49.8 184Z' fill='#6aa84a' opacity='0.96'/></g><g class='a-sway' style='--d:5s;--dl:-1.9s'><path d='M293.8 194.0 Q292.5 186.3 294.6 181.2 L301.4 181.2 Q303.5 186.3 302.2 194.0Z' fill='#efe3c4'/><path d='M293.8 188.9 q-4 1.7 -5 5.1' stroke='#efe3c4' stroke-width='1.4' fill='none' stroke-linecap='round'/><path d='M302.2 188.9 q4 -2.5 6 -6.0' stroke='#efe3c4' stroke-width='1.4' fill='none' stroke-linecap='round'/><g class='a-blink' style='--d:4.5s;--dl:-1.9s'><ellipse cx='296.3' cy='185.5' rx='0.8' ry='1.3' fill='#2a1c10'/><ellipse cx='299.7' cy='185.5' rx='0.8' ry='1.3' fill='#2a1c10'/></g><path d='M296.7 188.1 q1.3 1.2 2.5 0' stroke='#2a1c10' stroke-width='0.5' fill='none'/><circle cx='294.9' cy='187.4' r='0.8' fill='#e88a7a' opacity='.6'/><circle cx='301.1' cy='187.4' r='0.8' fill='#e88a7a' opacity='.6'/><g class='a-nod' style='--d:2.6s;--dl:-1.9s'><path d='M288.6 182.9 Q298.0 167.7 307.4 182.9Z' fill='#c9862f'/><circle cx='293.8' cy='178.7' r='1.4' fill='#fff7e8'/><circle cx='298.9' cy='174.4' r='1.1' fill='#fff7e8'/><circle cx='303.1' cy='179.6' r='1.4' fill='#fff7e8'/><circle cx='297.1' cy='180.4' r='0.8' fill='#fff7e8'/></g></g><g class='a-sway slow' style='--d:5.05s;--dl:-2.29s'><path d='M280.6 196.0 Q280.5 192.7 280.3 190.5 L282.6 190.5 Q283.1 192.7 283.4 196.0Z' fill='#efe3c4'/><path d='M280.2 192.2 q1.2 0.8 2.4 0' stroke='#d8c7a0' stroke-width='0.4' fill='none'/><g class='a-sway' style='--d:3.22s;--dl:-2.91s'><path d='M276.5 191.1 Q277.1 184.4 281.4 184.2 Q285.8 184.4 286.4 191.1 Q281.4 192.2 276.5 191.1Z' fill='#d9473b'/><path d='M276.8 190.8 Q281.4 191.8 286.1 190.8' stroke='#d8c7a0' stroke-width='0.7' fill='none' opacity='.8'/><path d='M278.1 187.2 Q279.8 185.0 282.0 184.8' stroke='#fff' stroke-width='0.6' fill='none' opacity='.25' stroke-linecap='round'/><circle cx='279.0' cy='188.3' r='0.8' fill='#fff7e8'/><circle cx='282.0' cy='186.1' r='0.7' fill='#fff7e8'/><circle cx='284.2' cy='188.8' r='0.8' fill='#fff7e8'/><circle cx='281.2' cy='189.1' r='0.5' fill='#fff7e8'/><circle cx='280.3' cy='186.4' r='0.4' fill='#fff7e8'/></g></g><g class='a-sway' style='--d:4.01s;--dl:-1.82s'><path d='M269.4 197.0 L269.6 193.5 L270.4 193.5 L270.6 197.0Z' fill='#d9e8c8'/><g class='a-pulse' style='--d:2.8s;--dl:-1.61s'><path d='M267.9 193.8 Q270.0 190.0 272.1 193.8Z' fill='#9ff5d0' filter='url(#glgb)'/></g></g><g class='a-sway slow' style='--d:5.03s;--dl:-1.6s'><path d='M387.9 170.0 Q388.3 165.2 389.0 162.0 L392.2 162.0 Q392.2 165.2 392.1 170.0Z' fill='#efe3c4'/><path d='M388.9 164.4 q1.8 1.1 3.5 0' stroke='#d8c7a0' stroke-width='0.6' fill='none'/><g class='a-sway' style='--d:2.23s;--dl:-2.91s'><path d='M383.4 162.8 Q384.2 153.2 390.6 152.8 Q397.0 153.2 397.8 162.8 Q390.6 164.4 383.4 162.8Z' fill='#d9473b'/><path d='M383.8 162.5 Q390.6 163.9 397.4 162.5' stroke='#d8c7a0' stroke-width='1.0' fill='none' opacity='.8'/><path d='M385.8 157.2 Q388.2 154.0 391.4 153.8' stroke='#fff' stroke-width='0.8' fill='none' opacity='.25' stroke-linecap='round'/><circle cx='387.0' cy='158.8' r='1.1' fill='#fff7e8'/><circle cx='391.4' cy='155.6' r='1.0' fill='#fff7e8'/><circle cx='394.6' cy='159.6' r='1.2' fill='#fff7e8'/><circle cx='390.2' cy='160.0' r='0.7' fill='#fff7e8'/><circle cx='389.0' cy='156.0' r='0.6' fill='#fff7e8'/></g></g><g class='a-sway' style='--d:5s;--dl:-3.1s'><path d='M379.5 196.0 Q378.8 191.5 380.0 188.5 L384.0 188.5 Q385.2 191.5 384.5 196.0Z' fill='#efe3c4'/><path d='M379.5 193.0 q-4 1.0 -5 3.0' stroke='#efe3c4' stroke-width='0.8' fill='none' stroke-linecap='round'/><path d='M384.5 193.0 q4 -1.5 6 -3.5' stroke='#efe3c4' stroke-width='0.8' fill='none' stroke-linecap='round'/><g class='a-blink' style='--d:4.5s;--dl:-3.1s'><ellipse cx='381.0' cy='191.0' rx='0.5' ry='0.8' fill='#2a1c10'/><ellipse cx='383.0' cy='191.0' rx='0.5' ry='0.8' fill='#2a1c10'/></g><path d='M381.2 192.5 q0.8 0.7 1.5 0' stroke='#2a1c10' stroke-width='0.3' fill='none'/><circle cx='380.2' cy='192.1' r='0.5' fill='#e88a7a' opacity='.6'/><circle cx='383.8' cy='192.1' r='0.5' fill='#e88a7a' opacity='.6'/><g class='a-nod' style='--d:2.6s;--dl:-3.1s'><path d='M376.5 189.5 Q382.0 180.5 387.5 189.5Z' fill='#d9473b'/><circle cx='379.5' cy='187.0' r='0.8' fill='#fff7e8'/><circle cx='382.5' cy='184.5' r='0.7' fill='#fff7e8'/><circle cx='385.0' cy='187.5' r='0.8' fill='#fff7e8'/><circle cx='381.5' cy='188.0' r='0.5' fill='#fff7e8'/></g></g><g class='a-sway' style='--d:4.98s;--dl:-0.49s'><path d='M395.6 170 Q395.6 160.5 393.2 154.2 Q396.6 160.5 398.6 170Z' fill='#4f8a33' opacity='0.74'/><path d='M390.2 170 Q390.9 161.6 389.7 156.1 Q391.9 161.6 393.2 170Z' fill='#4f8a33' opacity='0.89'/><path d='M400.8 170 Q400.5 162.9 397.7 158.2 Q401.5 162.9 403.8 170Z' fill='#4f8a33' opacity='0.74'/><path d='M391.8 170 Q396.9 164.4 402.2 160.6 Q397.9 164.4 394.8 170Z' fill='#4f8a33' opacity='0.73'/><path d='M401.6 170 Q407.1 161.9 413.0 156.5 Q408.1 161.9 404.6 170Z' fill='#4f8a33' opacity='0.75'/></g></svg>", "frame": "<svg xmlns='http://www.w3.org/2000/svg' class='fr-l' viewBox='0 0 60 1000' preserveAspectRatio='none'><defs><linearGradient id='gtrl' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#241a0e'/><stop offset='.55' stop-color='#4a3822'/><stop offset='.85' stop-color='#6b5333'/><stop offset='1' stop-color='#2e2314'/></linearGradient></defs><path d='M-4.0 0.0 L41.3 0.0 L39.6 20.0 L37.6 40.0 L34.8 60.0 L31.1 80.0 L26.7 100.0 L22.3 120.0 L20.9 140.0 L20.5 160.0 L21.3 180.0 L23.0 200.0 L25.0 220.0 L26.6 240.0 L27.3 260.0 L27.2 280.0 L26.6 300.0 L25.9 320.0 L25.8 340.0 L26.6 360.0 L28.2 380.0 L30.3 400.0 L32.2 420.0 L33.3 440.0 L33.3 460.0 L32.1 480.0 L30.3 500.0 L28.5 520.0 L27.2 540.0 L26.8 560.0 L27.2 580.0 L28.0 600.0 L28.5 620.0 L28.3 640.0 L27.1 660.0 L25.2 680.0 L23.0 700.0 L21.3 720.0 L20.6 740.0 L21.0 760.0 L22.5 780.0 L24.3 800.0 L25.9 820.0 L26.8 840.0 L26.9 860.0 L26.2 880.0 L25.5 900.0 L25.2 920.0 L25.8 940.0 L27.4 960.0 L29.5 980.0 L31.6 1000.0 L-4.0 1000.0Z' fill='url(#gtrl)'/><path d='M3.0 0 L2.9 25 L4.5 50 L4.3 75 L5.3 100 L5.4 125 L3.3 150 L2.6 175 L4.6 200 L2.1 225 L1.3 250 L3.2 275 L1.1 300 L2.1 325 L1.0 350 L1.8 375 L0.8 400 L3.0 425 L4.5 450 L4.0 475 L5.3 500 L5.4 525 L3.6 550 L5.7 575 L4.8 600 L3.3 625 L1.8 650 L3.7 675 L1.8 700 L2.1 725 L2.3 750 L1.7 775 L2.5 800 L1.3 825 L3.1 850 L2.7 875 L5.0 900 L5.4 925 L3.4 950 L3.8 975 L4.1 1000' stroke='#1e150b' stroke-width='1.5' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M7.6 0 L9.4 25 L10.0 50 L8.7 75 L8.9 100 L7.9 125 L7.1 150 L7.2 175 L6.6 200 L7.1 225 L6.2 250 L7.0 275 L7.1 300 L8.0 325 L7.6 350 L6.7 375 L9.6 400 L10.5 425 L10.7 450 L9.8 475 L10.2 500 L8.3 525 L9.7 550 L8.3 575 L6.6 600 L5.2 625 L7.2 650 L7.3 675 L4.3 700 L6.7 725 L5.8 750 L5.5 775 L6.7 800 L8.9 825 L9.9 850 L7.7 875 L9.9 900 L8.1 925 L10.1 950 L8.5 975 L9.6 1000' stroke='#1e150b' stroke-width='1.5' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M12.2 0 L13.6 25 L14.6 50 L11.7 75 L10.3 100 L11.3 125 L9.0 150 L9.3 175 L9.9 200 L10.8 225 L9.8 250 L10.0 275 L13.4 300 L12.3 325 L15.0 350 L15.2 375 L13.8 400 L14.0 425 L13.9 450 L13.9 475 L13.1 500 L12.2 525 L11.7 550 L12.2 575 L10.4 600 L10.0 625 L11.0 650 L9.8 675 L10.5 700 L13.3 725 L12.6 750 L13.3 775 L12.2 800 L13.8 825 L14.5 850 L12.5 875 L14.1 900 L13.6 925 L11.1 950 L12.2 975 L11.0 1000' stroke='#1e150b' stroke-width='1.3' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M16.8 0 L15.9 25 L16.4 50 L16.0 75 L13.4 100 L13.4 125 L15.5 150 L16.9 175 L15.2 200 L16.5 225 L17.7 250 L17.4 275 L18.1 300 L18.2 325 L18.4 350 L18.9 375 L17.5 400 L17.1 425 L17.7 450 L14.6 475 L15.7 500 L15.8 525 L14.2 550 L14.0 575 L16.1 600 L14.8 625 L15.2 650 L16.7 675 L18.3 700 L16.9 725 L17.7 750 L18.3 775 L19.8 800 L18.2 825 L19.0 850 L16.2 875 L16.0 900 L16.3 925 L16.5 950 L14.8 975 L13.9 1000' stroke='#1e150b' stroke-width='0.9' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M21.4 0 L19.6 25 L18.4 50 L20.5 75 L21.0 100 L18.9 125 L17.6 150 L18.0 175 L20.0 200 L22.4 225 L22.8 250 L22.2 275 L22.6 300 L22.8 325 L21.5 350 L21.0 375 L20.6 400 L19.9 425 L19.4 450 L20.8 475 L18.3 500 L18.1 525 L21.5 550 L21.9 575 L23.0 600 L21.9 625 L24.2 650 L22.7 675 L20.0 700 L18.0 725 L17.7 750 L19.0 775 L21.3 800 L20.6 825 L20.0 850 L19.1 875 L18.2 900 L19.7 925 L18.8 950 L20.8 975 L18.9 1000' stroke='#1e150b' stroke-width='1.4' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><ellipse cx='14.0' cy='520' rx='5' ry='14' fill='#140e07'/><ellipse cx='14.0' cy='520' rx='7' ry='17' fill='none' stroke='#6b5333' stroke-width='1.2' vector-effect='non-scaling-stroke' opacity='.7'/><path d='M26.4 23.8 Q40.9 31.1 39.9 45.8 Q40.9 60.5 26.4 67.8 Q22.4 45.8 26.4 23.8Z' fill='#4f8a33' opacity='.85'/><ellipse cx='27.5' cy='48.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='36.8' cy='54.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='35.1' cy='38.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='29.9' cy='46.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M18.3 75.2 Q31.3 82.6 30.3 97.4 Q31.3 112.2 18.3 119.6 Q14.3 97.4 18.3 75.2Z' fill='#4f8a33' opacity='.85'/><ellipse cx='24.2' cy='88.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='19.5' cy='96.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='20.2' cy='92.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='25.5' cy='98.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M10.8 157.3 Q24.8 161.4 23.8 169.5 Q24.8 177.7 10.8 181.7 Q6.8 169.5 10.8 157.3Z' fill='#4f8a33' opacity='.85'/><ellipse cx='11.6' cy='175.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='12.6' cy='159.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='14.5' cy='176.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='20.3' cy='165.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M16.2 196.2 Q28.3 201.8 27.3 213.1 Q28.3 224.3 16.2 229.9 Q12.2 213.1 16.2 196.2Z' fill='#4f8a33' opacity='.85'/><ellipse cx='20.5' cy='220.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='24.3' cy='201.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='23.3' cy='202.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='23.7' cy='225.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M18.4 279.5 Q30.9 283.2 29.9 290.6 Q30.9 298.0 18.4 301.8 Q14.4 290.6 18.4 279.5Z' fill='#4f8a33' opacity='.85'/><ellipse cx='24.2' cy='287.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='23.9' cy='293.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='21.9' cy='288.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='25.3' cy='287.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M16.2 311.5 Q29.8 317.2 28.8 328.7 Q29.8 340.2 16.2 345.9 Q12.2 328.7 16.2 311.5Z' fill='#4f8a33' opacity='.85'/><ellipse cx='22.1' cy='317.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='24.0' cy='325.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='20.0' cy='336.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='22.1' cy='337.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M22.9 388.1 Q34.7 393.3 33.7 403.7 Q34.7 414.1 22.9 419.3 Q18.9 403.7 22.9 388.1Z' fill='#4f8a33' opacity='.85'/><ellipse cx='26.8' cy='408.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='27.4' cy='408.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='27.1' cy='397.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='26.5' cy='408.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M25.3 431.6 Q37.5 436.8 36.5 447.1 Q37.5 457.5 25.3 462.7 Q21.3 447.1 25.3 431.6Z' fill='#4f8a33' opacity='.85'/><ellipse cx='26.3' cy='458.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='30.4' cy='457.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='27.0' cy='441.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='29.7' cy='437.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M17.4 510.8 Q31.8 517.0 30.8 529.4 Q31.8 541.8 17.4 548.0 Q13.4 529.4 17.4 510.8Z' fill='#4f8a33' opacity='.85'/><ellipse cx='19.5' cy='534.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='20.1' cy='531.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='26.7' cy='532.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='27.7' cy='518.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M21.1 577.7 Q31.5 581.2 30.5 588.2 Q31.5 595.3 21.1 598.8 Q17.1 588.2 21.1 577.7Z' fill='#4f8a33' opacity='.85'/><ellipse cx='26.9' cy='594.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='26.4' cy='580.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='22.1' cy='581.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='22.1' cy='591.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M18.9 627.7 Q31.8 635.2 30.8 650.1 Q31.8 665.0 18.9 672.5 Q14.9 650.1 18.9 627.7Z' fill='#4f8a33' opacity='.85'/><ellipse cx='20.7' cy='633.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='21.0' cy='650.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='21.4' cy='636.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='21.1' cy='665.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M15.6 672.6 Q28.4 677.4 27.4 686.8 Q28.4 696.3 15.6 701.0 Q11.6 686.8 15.6 672.6Z' fill='#4f8a33' opacity='.85'/><ellipse cx='17.1' cy='681.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='22.8' cy='681.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='19.0' cy='692.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='20.9' cy='683.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M12.8 742.3 Q24.9 747.2 23.9 756.9 Q24.9 766.6 12.8 771.5 Q8.8 756.9 12.8 742.3Z' fill='#4f8a33' opacity='.85'/><ellipse cx='20.2' cy='756.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='13.0' cy='754.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='14.9' cy='749.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='15.3' cy='762.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M17.8 808.5 Q30.3 814.1 29.3 825.2 Q30.3 836.4 17.8 841.9 Q13.8 825.2 17.8 808.5Z' fill='#4f8a33' opacity='.85'/><ellipse cx='20.8' cy='835.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='25.0' cy='814.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='20.0' cy='836.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='21.9' cy='823.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M18.6 874.1 Q30.0 878.3 29.0 886.6 Q30.0 894.8 18.6 899.0 Q14.6 886.6 18.6 874.1Z' fill='#4f8a33' opacity='.85'/><ellipse cx='24.5' cy='888.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='23.7' cy='881.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='20.9' cy='895.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='23.8' cy='890.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M16.8 916.3 Q29.7 923.3 28.7 937.4 Q29.7 951.5 16.8 958.5 Q12.8 937.4 16.8 916.3Z' fill='#4f8a33' opacity='.85'/><ellipse cx='23.3' cy='927.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='25.5' cy='936.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='22.3' cy='926.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='22.5' cy='931.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/></svg><svg xmlns='http://www.w3.org/2000/svg' class='fr-r' viewBox='0 0 60 1000' preserveAspectRatio='none'><defs><linearGradient id='gtrr' x1='1' y1='0' x2='0' y2='0'><stop offset='0' stop-color='#241a0e'/><stop offset='.55' stop-color='#4a3822'/><stop offset='.85' stop-color='#6b5333'/><stop offset='1' stop-color='#2e2314'/></linearGradient></defs><path d='M64.0 0.0 L18.8 0.0 L20.7 20.0 L22.3 40.0 L24.4 60.0 L27.4 80.0 L31.2 100.0 L35.7 120.0 L37.7 140.0 L39.1 160.0 L39.4 180.0 L38.6 200.0 L36.9 220.0 L35.0 240.0 L33.6 260.0 L33.0 280.0 L33.2 300.0 L33.9 320.0 L34.5 340.0 L34.5 360.0 L33.6 380.0 L31.8 400.0 L29.7 420.0 L27.7 440.0 L26.7 460.0 L26.8 480.0 L28.0 500.0 L29.8 520.0 L31.5 540.0 L32.6 560.0 L32.8 580.0 L32.3 600.0 L31.5 620.0 L31.1 640.0 L31.4 660.0 L32.8 680.0 L34.8 700.0 L37.0 720.0 L38.7 740.0 L39.3 760.0 L38.8 780.0 L37.4 800.0 L35.6 820.0 L34.1 840.0 L33.4 860.0 L33.5 880.0 L34.2 900.0 L35.0 920.0 L35.1 940.0 L34.4 960.0 L32.7 980.0 L30.5 1000.0 L64.0 1000.0Z' fill='url(#gtrr)'/><path d='M57.0 0 L56.4 25 L56.1 50 L56.4 75 L53.8 100 L56.6 125 L55.3 150 L54.5 175 L57.8 200 L57.0 225 L57.5 250 L59.9 275 L59.2 300 L58.3 325 L59.1 350 L57.9 375 L59.2 400 L58.3 425 L58.0 450 L56.0 475 L54.1 500 L54.8 525 L54.1 550 L55.5 575 L54.7 600 L57.3 625 L57.4 650 L56.9 675 L57.4 700 L58.9 725 L60.2 750 L59.7 775 L59.7 800 L59.1 825 L56.8 850 L58.1 875 L55.2 900 L54.6 925 L56.7 950 L55.4 975 L55.0 1000' stroke='#1e150b' stroke-width='0.8' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M52.4 0 L50.7 25 L49.1 50 L51.9 75 L50.8 100 L52.9 125 L52.2 150 L51.8 175 L54.7 200 L55.7 225 L55.7 250 L54.2 275 L55.6 300 L54.9 325 L53.0 350 L50.9 375 L51.8 400 L51.3 425 L50.1 450 L51.7 475 L50.2 500 L51.9 525 L51.0 550 L50.5 575 L54.1 600 L53.2 625 L53.6 650 L55.4 675 L55.1 700 L52.7 725 L52.3 750 L54.6 775 L52.0 800 L50.5 825 L52.2 850 L50.4 875 L51.9 900 L50.8 925 L50.0 950 L50.7 975 L50.7 1000' stroke='#1e150b' stroke-width='0.9' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M47.8 0 L46.9 25 L45.8 50 L47.4 75 L48.5 100 L49.3 125 L47.9 150 L49.5 175 L51.3 200 L48.6 225 L49.7 250 L48.7 275 L48.7 300 L47.3 325 L47.0 350 L47.4 375 L45.4 400 L47.1 425 L45.2 450 L48.1 475 L46.3 500 L47.0 525 L48.6 550 L48.5 575 L50.4 600 L49.0 625 L50.0 650 L50.3 675 L47.4 700 L48.5 725 L47.9 750 L45.7 775 L46.7 800 L45.4 825 L46.9 850 L44.8 875 L47.1 900 L48.3 925 L46.0 950 L49.3 975 L47.5 1000' stroke='#1e150b' stroke-width='1.5' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M43.2 0 L43.3 25 L45.8 50 L46.2 75 L46.1 100 L45.6 125 L44.7 150 L43.1 175 L44.5 200 L44.5 225 L42.4 250 L43.2 275 L42.8 300 L41.1 325 L40.6 350 L42.8 375 L42.1 400 L41.9 425 L42.4 450 L44.3 475 L43.3 500 L46.0 525 L44.5 550 L44.3 575 L43.7 600 L44.4 625 L45.0 650 L44.5 675 L42.3 700 L42.8 725 L42.1 750 L42.5 775 L40.4 800 L42.5 825 L43.7 850 L43.8 875 L43.6 900 L44.0 925 L45.1 950 L46.1 975 L45.3 1000' stroke='#1e150b' stroke-width='1.5' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><path d='M38.6 0 L40.4 25 L39.2 50 L42.0 75 L38.5 100 L39.2 125 L41.5 150 L42.4 175 L41.6 200 L39.4 225 L38.1 250 L36.1 275 L36.6 300 L37.8 325 L37.7 350 L37.8 375 L40.4 400 L39.2 425 L40.4 450 L40.6 475 L40.1 500 L41.8 525 L39.6 550 L39.7 575 L37.4 600 L38.8 625 L36.2 650 L36.1 675 L37.8 700 L40.5 725 L42.1 750 L42.1 775 L40.4 800 L38.2 825 L39.7 850 L41.4 875 L41.4 900 L40.2 925 L41.5 950 L41.6 975 L40.1 1000' stroke='#1e150b' stroke-width='1.1' fill='none' opacity='.75' vector-effect='non-scaling-stroke'/><ellipse cx='46.0' cy='520' rx='5' ry='14' fill='#140e07'/><ellipse cx='46.0' cy='520' rx='7' ry='17' fill='none' stroke='#6b5333' stroke-width='1.2' vector-effect='non-scaling-stroke' opacity='.7'/><path d='M32.3 30.7 Q18.4 34.2 19.4 41.1 Q18.4 48.0 32.3 51.4 Q36.3 41.1 32.3 30.7Z' fill='#4f8a33' opacity='.85'/><ellipse cx='25.7' cy='45.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='22.5' cy='48.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='28.2' cy='48.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='32.2' cy='46.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M36.0 73.7 Q24.8 78.5 25.8 88.2 Q24.8 97.9 36.0 102.7 Q40.0 88.2 36.0 73.7Z' fill='#4f8a33' opacity='.85'/><ellipse cx='34.4' cy='81.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='30.4' cy='79.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='29.7' cy='98.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='35.8' cy='85.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M48.0 151.2 Q35.4 156.5 36.4 167.2 Q35.4 178.0 48.0 183.3 Q52.0 167.2 48.0 151.2Z' fill='#4f8a33' opacity='.85'/><ellipse cx='42.5' cy='170.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='41.4' cy='161.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='43.8' cy='159.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='43.1' cy='178.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M48.1 194.3 Q34.1 198.1 35.1 205.7 Q34.1 213.2 48.1 217.0 Q52.1 205.7 48.1 194.3Z' fill='#4f8a33' opacity='.85'/><ellipse cx='38.7' cy='201.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='46.7' cy='207.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='40.3' cy='197.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='40.9' cy='202.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M42.9 266.3 Q29.0 273.9 30.0 289.0 Q29.0 304.1 42.9 311.7 Q46.9 289.0 42.9 266.3Z' fill='#4f8a33' opacity='.85'/><ellipse cx='41.9' cy='304.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='41.7' cy='304.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='42.6' cy='274.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='36.1' cy='279.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M42.3 326.7 Q30.6 332.2 31.6 343.1 Q30.6 354.1 42.3 359.5 Q46.3 343.1 42.3 326.7Z' fill='#4f8a33' opacity='.85'/><ellipse cx='41.1' cy='340.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='36.2' cy='337.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='38.2' cy='346.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='39.0' cy='341.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M40.4 375.4 Q28.7 380.4 29.7 390.6 Q28.7 400.7 40.4 405.8 Q44.4 390.6 40.4 375.4Z' fill='#4f8a33' opacity='.85'/><ellipse cx='34.0' cy='391.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='34.2' cy='395.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='37.8' cy='381.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='37.5' cy='386.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M36.6 440.5 Q22.7 446.5 23.7 458.4 Q22.7 470.3 36.6 476.3 Q40.6 458.4 36.6 440.5Z' fill='#4f8a33' opacity='.85'/><ellipse cx='35.4' cy='465.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='28.8' cy='459.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='30.0' cy='444.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='32.2' cy='457.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M40.9 516.8 Q26.8 521.5 27.8 531.0 Q26.8 540.5 40.9 545.2 Q44.9 531.0 40.9 516.8Z' fill='#4f8a33' opacity='.85'/><ellipse cx='36.0' cy='521.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='38.0' cy='526.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='36.2' cy='521.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='30.9' cy='540.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M39.6 554.3 Q28.8 558.3 29.8 566.3 Q28.8 574.2 39.6 578.2 Q43.6 566.3 39.6 554.3Z' fill='#4f8a33' opacity='.85'/><ellipse cx='33.4' cy='572.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='39.5' cy='569.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='35.5' cy='573.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='36.2' cy='559.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M38.4 631.0 Q27.1 635.9 28.1 645.7 Q27.1 655.5 38.4 660.4 Q42.4 645.7 38.4 631.0Z' fill='#4f8a33' opacity='.85'/><ellipse cx='33.4' cy='643.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='32.4' cy='648.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='37.5' cy='647.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='31.2' cy='650.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M43.6 669.4 Q29.3 674.8 30.3 685.6 Q29.3 696.4 43.6 701.8 Q47.6 685.6 43.6 669.4Z' fill='#4f8a33' opacity='.85'/><ellipse cx='40.3' cy='696.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='41.1' cy='679.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='34.8' cy='684.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='40.3' cy='678.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M47.0 735.2 Q35.3 741.8 36.3 754.9 Q35.3 768.1 47.0 774.7 Q51.0 754.9 47.0 735.2Z' fill='#4f8a33' opacity='.85'/><ellipse cx='43.9' cy='756.4' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='46.5' cy='740.0' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='40.7' cy='763.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='44.5' cy='742.2' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M45.3 796.3 Q32.6 800.5 33.6 809.0 Q32.6 817.5 45.3 821.8 Q49.3 809.0 45.3 796.3Z' fill='#4f8a33' opacity='.85'/><ellipse cx='44.5' cy='803.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='38.4' cy='812.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='40.3' cy='816.1' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='45.3' cy='817.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M40.0 870.0 Q29.7 875.5 30.7 886.5 Q29.7 897.4 40.0 902.9 Q44.0 886.5 40.0 870.0Z' fill='#4f8a33' opacity='.85'/><ellipse cx='38.8' cy='883.8' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='36.6' cy='889.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='39.8' cy='887.9' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='39.5' cy='898.7' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><path d='M45.6 912.9 Q31.1 917.8 32.1 927.5 Q31.1 937.3 45.6 942.2 Q49.6 927.5 45.6 912.9Z' fill='#4f8a33' opacity='.85'/><ellipse cx='43.1' cy='938.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='37.1' cy='928.3' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='44.9' cy='928.5' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/><ellipse cx='42.1' cy='938.6' rx='1.1' ry='2' fill='#8cc65e' opacity='.8'/></svg>", "side": "<svg xmlns='http://www.w3.org/2000/svg' class='da-s l' style='left:0;top:34%;width:64px' viewBox='0 0 64 120' width='64' height='120'><g class='a-swing' style='--d:3.94s;--dl:-3.35s'><path d='M7.5 18 Q10.5 23.6 7.5 29.2 Q4.5 34.8 7.5 40.4 Q10.5 46.0 7.5 51.6 Q4.5 57.2 7.5 62.8 Q10.5 68.4 7.5 74.0 Q4.5 79.6 7.5 85.2' stroke='#2f5e2a' stroke-width='1.6' fill='none'/><ellipse cx='6.8' cy='24.4' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='7.3' cy='35.6' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='5.3' cy='46.8' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='9.5' cy='58.0' rx='2.2' ry='1.3' fill='#8cc65e'/><ellipse cx='6.3' cy='69.2' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='5.9' cy='80.4' rx='2.2' ry='1.3' fill='#6aa84a'/></g><g class='a-swing' style='--d:4.65s;--dl:-1.08s'><path d='M13.5 18 Q16.5 24.0 13.5 30.0 Q10.5 36.0 13.5 42.0 Q16.5 48.0 13.5 54.0 Q10.5 60.0 13.5 66.0 Q16.5 72.0 13.5 78.0 Q10.5 84.0 13.5 90.0' stroke='#2f5e2a' stroke-width='1.6' fill='none'/><ellipse cx='11.7' cy='24.9' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='11.7' cy='36.8' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='12.9' cy='48.8' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='14.3' cy='60.8' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='11.7' cy='72.8' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='11.2' cy='84.8' rx='2.2' ry='1.3' fill='#4f8a33'/></g><g class='a-swing' style='--d:3.87s;--dl:-2.51s'><path d='M19.2 18 Q22.2 25.2 19.2 32.3 Q16.2 39.5 19.2 46.7 Q22.2 53.8 19.2 61.0 Q16.2 68.2 19.2 75.3 Q22.2 82.5 19.2 89.7 Q16.2 96.8 19.2 104.0' stroke='#2f5e2a' stroke-width='1.6' fill='none'/><ellipse cx='18.6' cy='26.2' rx='2.2' ry='1.3' fill='#8cc65e'/><ellipse cx='18.7' cy='40.5' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='18.9' cy='54.9' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='21.1' cy='69.2' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='16.9' cy='83.5' rx='2.2' ry='1.3' fill='#8cc65e'/><ellipse cx='17.8' cy='97.9' rx='2.2' ry='1.3' fill='#6aa84a'/></g><g class='a-swing' style='--d:4.4s;--dl:-1.31s'><path d='M24.1 18 Q27.1 23.4 24.1 28.9 Q21.1 34.3 24.1 39.8 Q27.1 45.2 24.1 50.7 Q21.1 56.1 24.1 61.6 Q27.1 67.0 24.1 72.5 Q21.1 77.9 24.1 83.4' stroke='#2f5e2a' stroke-width='1.6' fill='none'/><ellipse cx='23.5' cy='24.2' rx='2.2' ry='1.3' fill='#8cc65e'/><ellipse cx='24.3' cy='35.1' rx='2.2' ry='1.3' fill='#8cc65e'/><ellipse cx='24.5' cy='46.0' rx='2.2' ry='1.3' fill='#8cc65e'/><ellipse cx='25.0' cy='56.9' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='25.9' cy='67.8' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='25.0' cy='78.7' rx='2.2' ry='1.3' fill='#4f8a33'/></g><g class='a-swing' style='--d:3.82s;--dl:-0.6s'><path d='M30.1 18 Q33.1 23.7 30.1 29.4 Q27.1 35.1 30.1 40.9 Q33.1 46.6 30.1 52.3 Q27.1 58.0 30.1 63.7 Q33.1 69.4 30.1 75.2 Q27.1 80.9 30.1 86.6' stroke='#2f5e2a' stroke-width='1.6' fill='none'/><ellipse cx='28.1' cy='24.5' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='28.6' cy='36.0' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='28.9' cy='47.4' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='27.9' cy='58.8' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='32.5' cy='70.3' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='29.3' cy='81.7' rx='2.2' ry='1.3' fill='#4f8a33'/></g><g class='a-swing' style='--d:3.22s;--dl:-2.14s'><path d='M35.1 18 Q38.1 24.5 35.1 31.1 Q32.1 37.6 35.1 44.1 Q38.1 50.7 35.1 57.2 Q32.1 63.8 35.1 70.3 Q38.1 76.8 35.1 83.4 Q32.1 89.9 35.1 96.4' stroke='#2f5e2a' stroke-width='1.6' fill='none'/><ellipse cx='37.0' cy='25.5' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='35.6' cy='38.5' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='34.5' cy='51.6' rx='2.2' ry='1.3' fill='#6aa84a'/><ellipse cx='34.2' cy='64.7' rx='2.2' ry='1.3' fill='#8cc65e'/><ellipse cx='35.1' cy='77.8' rx='2.2' ry='1.3' fill='#4f8a33'/><ellipse cx='34.1' cy='90.8' rx='2.2' ry='1.3' fill='#4f8a33'/></g><circle cx='38.0' cy='21.6' r='5.2' fill='#4f8a33'/><circle cx='6.2' cy='8.6' r='7.5' fill='#4f8a33'/><circle cx='14.4' cy='9.9' r='7.4' fill='#4f8a33'/><circle cx='18.4' cy='15.3' r='6.6' fill='#3f7a35'/><circle cx='27.2' cy='9.4' r='7.9' fill='#3f7a35'/><circle cx='10.9' cy='16.9' r='6.9' fill='#4f8a33'/><circle cx='17.5' cy='11.6' r='5.2' fill='#4f8a33'/><circle cx='0.5' cy='13.8' r='6.3' fill='#2f5e2a'/><circle cx='15.1' cy='16.2' r='4.5' fill='#3f7a35'/><circle cx='25.1' cy='14.5' r='6.7' fill='#4f8a33'/><circle cx='24.4' cy='11.9' r='6.0' fill='#3f7a35'/><circle cx='2.4' cy='17.5' r='7.9' fill='#4f8a33'/><circle cx='25.1' cy='12.2' r='6.4' fill='#2f5e2a'/><circle cx='14.6' cy='12.4' r='5.5' fill='#3f7a35'/><circle cx='10.6' cy='19.0' r='4.4' fill='#2f5e2a'/><circle cx='38.9' cy='17.6' r='4.5' fill='#3f7a35'/><circle cx='8.9' cy='19.3' r='5.0' fill='#2f5e2a'/><circle cx='27.1' cy='17.1' r='4.4' fill='#3f7a35'/><circle cx='14.2' cy='10.7' r='1.3' fill='#8cc65e'/><circle cx='18.7' cy='18.0' r='0.8' fill='#8cc65e'/><circle cx='14.8' cy='15.1' r='1.3' fill='#8cc65e'/><circle cx='19.1' cy='9.2' r='0.8' fill='#8cc65e'/><circle cx='22.1' cy='8.7' r='1.3' fill='#8cc65e'/><circle cx='33.9' cy='8.6' r='0.9' fill='#8cc65e'/><circle cx='32.7' cy='15.0' r='1.3' fill='#8cc65e'/><circle cx='15.1' cy='7.8' r='0.9' fill='#8cc65e'/><circle cx='32.2' cy='9.8' r='0.9' fill='#8cc65e'/><circle cx='17.8' cy='11.9' r='1.0' fill='#8cc65e'/><circle cx='37.0' cy='8.2' r='0.7' fill='#8cc65e'/><circle cx='37.8' cy='18.3' r='1.4' fill='#8cc65e'/><circle cx='18.5' cy='19.3' r='1.3' fill='#8cc65e'/><circle cx='10.4' cy='16.4' r='1.3' fill='#8cc65e'/></svg><svg xmlns='http://www.w3.org/2000/svg' class='da-s r' style='right:0;top:36%;width:70px' viewBox='0 0 70 150' width='70' height='150'><path d='M68.8 4.5 L68.1 5.2 L67.1 5.8 L65.9 6.5 L64.5 7.3 L63.0 8.4 L61.5 9.6 L60.0 11.0 L58.4 12.4 L56.7 13.8 L55.1 15.4 L53.6 17.1 L52.4 19.0 L51.4 21.1 L50.4 23.3 L49.3 25.6 L48.2 28.0 L47.1 30.4 L46.1 33.0 L45.2 35.8 L44.5 38.5 L43.9 41.4 L43.4 44.2 L42.9 47.0 L42.5 49.9 L42.3 52.8 L42.5 55.8 L42.9 58.8 L43.4 61.8 L44.0 64.9 L44.6 68.0 L45.1 71.1 L45.6 74.2 L46.1 77.2 L46.6 80.2 L46.9 83.1 L46.8 85.9 L46.5 88.8 L46.0 91.6 L45.3 94.5 L44.6 97.4 L43.8 100.4 L43.0 103.3 L42.1 106.2 L41.2 109.0 L40.4 111.8 L39.7 114.6 L39.2 117.3 L39.0 119.9 L39.0 122.5 L39.1 125.2 L39.3 127.8 L39.6 130.4 L40.1 132.9 L40.6 135.3 L41.2 137.6 L41.8 139.7 L42.3 141.7 L42.7 143.4 L43.0 144.9 L43.2 146.1 L44.8 145.9 L44.6 144.6 L44.2 143.1 L43.7 141.3 L43.3 139.4 L42.8 137.2 L42.4 134.9 L42.0 132.5 L41.5 130.1 L41.2 127.6 L40.9 125.0 L40.8 122.5 L41.0 120.1 L41.4 117.6 L41.9 115.1 L42.5 112.4 L43.2 109.6 L44.1 106.8 L45.0 103.9 L46.0 101.0 L47.0 98.1 L47.8 95.1 L48.5 92.1 L48.9 89.1 L49.2 86.1 L49.2 83.0 L49.1 79.9 L48.9 76.8 L48.5 73.7 L47.9 70.6 L47.2 67.5 L46.5 64.4 L46.0 61.4 L45.7 58.4 L45.5 55.6 L45.5 52.8 L45.5 50.1 L45.8 47.4 L46.2 44.7 L46.8 42.0 L47.6 39.4 L48.5 36.8 L49.4 34.2 L50.3 31.7 L51.2 29.2 L52.2 26.9 L53.3 24.7 L54.4 22.7 L55.6 21.0 L56.7 19.4 L57.9 17.8 L59.2 16.3 L60.6 14.9 L62.1 13.7 L63.7 12.6 L65.3 11.7 L66.8 10.8 L68.1 9.8 L69.3 8.9 L70.3 8.1 L71.2 7.5Z' fill='#3a5a24'/><g class='a-leaf' style='--d:3.46s;--dl:-0.36s;--o:67.0px 8.1px'><path d='M64.9 8.1 C61.3 3.1 54.0 4.2 50.3 8.0 C53.9 11.8 61.2 13.1 64.9 8.1Z' fill='#5d9c43'/><path d='M64.9 8.1 C61.3 3.1 54.0 4.2 50.3 8.0Z' fill='#3e6e2c'/><path d='M67.0 8.1 L50.3 8.0' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M61.3 8.1 L59.4 5.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M61.3 8.1 L59.4 11.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M58.4 8.1 L56.5 5.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M58.4 8.1 L56.4 11.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M55.4 8.0 L53.6 5.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M55.4 8.0 L53.5 10.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.04s;--dl:-3.06s;--o:56.5px 16.6px'><path d='M58.1 18.4 C56.5 25.5 63.2 31.2 69.4 31.5 C70.0 25.3 65.4 17.8 58.1 18.4Z' fill='#7bbf55'/><path d='M58.1 18.4 C56.5 25.5 63.2 31.2 69.4 31.5Z' fill='#5d9c43'/><path d='M56.5 16.6 L69.4 31.5' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M60.9 21.7 L59.8 25.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M60.9 21.7 L65.0 21.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M63.2 24.3 L62.0 28.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M63.2 24.3 L67.3 23.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M65.4 26.9 L64.3 30.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M65.4 26.9 L69.5 26.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.0s;--dl:-3.31s;--o:48.7px 31.1px'><path d='M46.3 31.0 C42.1 25.1 33.5 26.3 29.1 30.7 C33.3 35.2 41.9 36.8 46.3 31.0Z' fill='#7bbf55'/><path d='M46.3 31.0 C42.1 25.1 33.5 26.3 29.1 30.7Z' fill='#5d9c43'/><path d='M48.7 31.1 L29.1 30.7' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M42.0 30.9 L39.8 27.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M42.0 30.9 L39.7 34.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M38.5 30.9 L36.4 27.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M38.5 30.9 L36.2 34.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M35.1 30.8 L32.9 27.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M35.1 30.8 L32.8 34.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.09s;--dl:-3.23s;--o:44.0px 50.0px'><path d='M46.1 51.8 C45.7 60.0 54.2 65.1 61.3 64.3 C60.7 57.2 54.2 49.7 46.1 51.8Z' fill='#4f8a33'/><path d='M46.1 51.8 C45.7 60.0 54.2 65.1 61.3 64.3Z' fill='#3f7a35'/><path d='M44.0 50.0 L61.3 64.3' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M49.9 54.9 L49.4 59.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M49.9 54.9 L54.4 53.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M52.9 57.4 L52.4 62.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M52.9 57.4 L57.4 56.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M56.0 59.9 L55.4 64.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M56.0 59.9 L60.5 58.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.12s;--dl:-3.47s;--o:46.5px 70.8px'><path d='M44.5 71.6 C39.1 68.3 32.5 72.2 30.5 77.3 C35.4 79.6 42.9 77.8 44.5 71.6Z' fill='#7bbf55'/><path d='M44.5 71.6 C39.1 68.3 32.5 72.2 30.5 77.3Z' fill='#5d9c43'/><path d='M46.5 70.8 L30.5 77.3' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M41.0 73.1 L38.0 71.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M41.0 73.1 L40.3 76.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M38.2 74.2 L35.2 72.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M38.2 74.2 L37.5 77.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M35.4 75.3 L32.4 73.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M35.4 75.3 L34.7 78.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.76s;--dl:-2.42s;--o:47.2px 91.9px'><path d='M49.8 92.4 C53.2 99.7 62.9 100.1 68.5 96.2 C64.9 90.4 55.8 87.0 49.8 92.4Z' fill='#7bbf55'/><path d='M49.8 92.4 C53.2 99.7 62.9 100.1 68.5 96.2Z' fill='#5d9c43'/><path d='M47.2 91.9 L68.5 96.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M54.5 93.4 L56.2 97.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M54.5 93.4 L57.7 90.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M58.3 94.1 L59.9 98.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M58.3 94.1 L61.5 90.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M62.0 94.9 L63.7 99.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M62.0 94.9 L65.2 91.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.05s;--dl:-1.12s;--o:41.4px 112.1px'><path d='M39.2 112.8 C33.4 108.5 25.6 112.3 22.9 117.7 C28.2 120.7 36.8 119.6 39.2 112.8Z' fill='#6aa84a'/><path d='M39.2 112.8 C33.4 108.5 25.6 112.3 22.9 117.7Z' fill='#4f8a33'/><path d='M41.4 112.1 L22.9 117.7' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M35.1 114.0 L32.0 111.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M35.1 114.0 L33.9 117.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M31.8 115.0 L28.7 112.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M31.8 115.0 L30.7 118.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M28.6 116.0 L25.5 113.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M28.6 116.0 L27.4 119.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.11s;--dl:-0.03s;--o:40.6px 130.2px'><path d='M43.2 130.8 C46.4 138.1 56.0 138.6 61.7 134.8 C58.1 129.0 49.2 125.5 43.2 130.8Z' fill='#8cc65e'/><path d='M43.2 130.8 C46.4 138.1 56.0 138.6 61.7 134.8Z' fill='#6aa84a'/><path d='M40.6 130.2 L61.7 134.8' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M47.8 131.8 L49.4 136.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M47.8 131.8 L51.0 128.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M51.5 132.6 L53.1 136.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M51.5 132.6 L54.7 129.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M55.2 133.4 L56.8 137.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M55.2 133.4 L58.4 130.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.13s;--dl:-2.03s;--o:43.8px 144.8px'><path d='M41.2 144.8 C36.5 138.8 27.4 140.5 23.0 145.4 C27.7 150.0 36.8 151.2 41.2 144.8Z' fill='#7bbf55'/><path d='M41.2 144.8 C36.5 138.8 27.4 140.5 23.0 145.4Z' fill='#5d9c43'/><path d='M43.8 144.8 L23.0 145.4' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M36.7 145.0 L34.2 141.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M36.7 145.0 L34.4 148.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M33.0 145.1 L30.5 141.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M33.0 145.1 L30.8 148.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M29.4 145.2 L26.9 141.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M29.4 145.2 L27.1 148.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g></svg><svg xmlns='http://www.w3.org/2000/svg' class='da-s r' style='right:0;top:60%;width:64px' viewBox='0 0 64 90' width='64' height='90'><defs><filter id='glbf5' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='1.6' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><path d='M64.0 13 Q45.3 8 30.0 22 Q47.0 27 64.0 25Z' fill='#c9862f'/><path d='M30.0 22 Q47.0 27 64.0 25' stroke='#f3e2b8' stroke-width='2' fill='none' opacity='.9'/><path d='M60.0 16 Q47.0 13 35.1 21' stroke='#7a4a1a' stroke-width='.8' fill='none' opacity='.6'/><g class='a-pulse' style='--d:3.51s;--dl:-2.7s'><circle cx='44.3' cy='17.3' r='1.3' fill='#fff2b0' filter='url(#glbf5)'/><circle cx='37.3' cy='17.3' r='1.4' fill='#fff2b0' filter='url(#glbf5)'/><circle cx='57.4' cy='18.7' r='1.4' fill='#fff2b0' filter='url(#glbf5)'/></g><path d='M64.0 37 Q40.9 32 22.0 46 Q43.0 51 64.0 49Z' fill='#b4722a'/><path d='M22.0 46 Q43.0 51 64.0 49' stroke='#f3e2b8' stroke-width='2' fill='none' opacity='.9'/><path d='M60.0 40 Q43.0 37 28.3 45' stroke='#7a4a1a' stroke-width='.8' fill='none' opacity='.6'/><g class='a-pulse' style='--d:3.67s;--dl:-0.48s'><circle cx='54.6' cy='42.7' r='0.9' fill='#fff2b0' filter='url(#glbf5)'/><circle cx='41.7' cy='42.1' r='0.8' fill='#fff2b0' filter='url(#glbf5)'/><circle cx='51.5' cy='43.6' r='1.3' fill='#fff2b0' filter='url(#glbf5)'/></g><path d='M64.0 61 Q47.5 56 34.0 70 Q49.0 75 64.0 73Z' fill='#d9a04a'/><path d='M34.0 70 Q49.0 75 64.0 73' stroke='#f3e2b8' stroke-width='2' fill='none' opacity='.9'/><path d='M60.0 64 Q49.0 61 38.5 69' stroke='#7a4a1a' stroke-width='.8' fill='none' opacity='.6'/><g class='a-pulse' style='--d:3.82s;--dl:-0.87s'><circle cx='43.7' cy='68.3' r='1.2' fill='#fff2b0' filter='url(#glbf5)'/><circle cx='55.7' cy='69.0' r='1.3' fill='#fff2b0' filter='url(#glbf5)'/><circle cx='54.2' cy='67.9' r='1.4' fill='#fff2b0' filter='url(#glbf5)'/></g><g class='a-sway' style='--d:5s;--dl:-1.3s'><path d='M43.2 41.0 Q42.4 36.0 43.8 32.8 L48.2 32.8 Q49.6 36.0 48.8 41.0Z' fill='#efe3c4'/><path d='M43.2 37.7 q-4 1.1 -5 3.3' stroke='#efe3c4' stroke-width='0.9' fill='none' stroke-linecap='round'/><path d='M48.8 37.7 q4 -1.7 6 -3.9' stroke='#efe3c4' stroke-width='0.9' fill='none' stroke-linecap='round'/><g class='a-blink' style='--d:4.5s;--dl:-1.3s'><ellipse cx='44.9' cy='35.5' rx='0.6' ry='0.8' fill='#2a1c10'/><ellipse cx='47.1' cy='35.5' rx='0.6' ry='0.8' fill='#2a1c10'/></g><path d='M45.2 37.1 q0.8 0.8 1.7 0' stroke='#2a1c10' stroke-width='0.3' fill='none'/><circle cx='44.0' cy='36.7' r='0.5' fill='#e88a7a' opacity='.6'/><circle cx='48.0' cy='36.7' r='0.5' fill='#e88a7a' opacity='.6'/><g class='a-nod' style='--d:2.6s;--dl:-1.3s'><path d='M40.0 33.9 Q46.0 23.9 52.0 33.9Z' fill='#d9473b'/><circle cx='43.2' cy='31.1' r='0.9' fill='#fff7e8'/><circle cx='46.5' cy='28.4' r='0.7' fill='#fff7e8'/><circle cx='49.3' cy='31.6' r='0.9' fill='#fff7e8'/><circle cx='45.5' cy='32.2' r='0.6' fill='#fff7e8'/></g></g></svg><svg xmlns='http://www.w3.org/2000/svg' class='da-s l' style='left:0;top:58%;width:60px' viewBox='0 0 60 130' width='60' height='130'><g class='a-curl' style='--d:7s;--dl:4s'><path d='M-1.4 5.0 L-0.8 6.0 L-0.0 7.2 L1.0 8.6 L2.2 10.1 L3.5 11.7 L4.7 13.5 L6.0 15.4 L7.3 17.4 L8.6 19.4 L10.0 21.3 L11.5 23.1 L12.8 24.9 L14.2 26.6 L15.6 28.4 L17.1 30.2 L18.7 32.0 L20.3 33.7 L21.9 35.3 L23.5 37.0 L24.9 38.8 L26.0 40.6 L27.0 42.5 L27.9 44.4 L28.6 46.4 L29.2 48.5 L29.6 50.8 L29.8 53.2 L29.8 55.8 L29.6 58.4 L29.4 61.0 L29.1 63.6 L28.9 66.3 L28.5 68.8 L28.0 71.2 L27.4 73.5 L26.8 75.6 L26.1 77.6 L25.3 79.4 L24.4 81.2 L23.2 83.0 L22.0 84.6 L20.7 86.2 L19.4 87.8 L18.1 89.3 L17.1 90.9 L16.2 92.6 L15.5 94.2 L15.1 95.8 L14.9 97.5 L14.9 99.3 L15.1 101.0 L15.6 102.8 L16.2 104.5 L16.9 106.1 L17.6 107.6 L18.3 109.0 L19.1 110.3 L19.9 111.4 L20.8 112.2 L21.7 112.7 L22.7 112.9 L23.8 112.6 L24.8 112.1 L25.9 111.4 L26.9 110.5 L27.9 109.5 L28.8 108.4 L29.7 107.4 L30.6 106.4 L31.3 105.6 L32.0 104.9 L32.4 104.5 L31.6 103.5 L31.0 104.0 L30.4 104.7 L29.7 105.6 L28.8 106.6 L27.9 107.5 L26.9 108.5 L25.9 109.4 L24.9 110.2 L24.1 110.9 L23.3 111.3 L22.7 111.4 L22.3 111.3 L21.9 110.9 L21.2 110.2 L20.5 109.3 L19.8 108.2 L19.0 106.9 L18.4 105.4 L17.9 103.9 L17.4 102.3 L17.1 100.7 L16.9 99.1 L16.8 97.6 L16.9 96.2 L17.3 94.8 L18.0 93.5 L18.9 92.1 L19.9 90.7 L21.1 89.1 L22.3 87.5 L23.6 85.9 L24.9 84.2 L26.2 82.4 L27.4 80.5 L28.5 78.5 L29.2 76.4 L29.7 74.1 L30.2 71.7 L30.7 69.2 L31.3 66.6 L31.8 64.0 L32.1 61.3 L32.3 58.5 L32.3 55.8 L32.2 53.1 L32.1 50.5 L31.8 48.0 L31.4 45.6 L30.7 43.3 L29.7 41.2 L28.4 39.2 L27.0 37.2 L25.6 35.3 L24.1 33.4 L22.6 31.6 L21.0 29.8 L19.5 28.1 L17.9 26.5 L16.4 24.8 L15.2 23.1 L14.0 21.3 L12.8 19.4 L11.5 17.4 L10.1 15.5 L8.6 13.6 L7.3 11.7 L6.0 9.9 L4.9 8.2 L3.9 6.5 L3.0 5.1 L2.2 3.9 L1.4 3.0Z' fill='#3a5a24'/><g class='a-leaf' style='--d:2.6s;--dl:-2.65s;--o:1.5px 6.2px'><path d='M2.8 5.4 C7.1 7.2 11.4 3.6 12.4 -0.2 C8.5 -1.3 3.3 0.7 2.8 5.4Z' fill='#3f7a35'/><path d='M2.8 5.4 C7.1 7.2 11.4 3.6 12.4 -0.2Z' fill='#2f5e2a'/><path d='M1.5 6.2 L12.4 -0.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M5.2 4.0 L7.6 5.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M5.2 4.0 L5.3 1.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M7.1 2.8 L9.5 4.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M7.1 2.8 L7.2 0.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M9.0 1.7 L11.4 2.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M9.0 1.7 L9.1 -0.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.17s;--dl:-0.09s;--o:8.7px 16.4px'><path d='M7.4 15.2 C8.1 9.8 2.7 6.0 -2.0 6.2 C-2.0 10.9 2.0 16.1 7.4 15.2Z' fill='#3f7a35'/><path d='M7.4 15.2 C8.1 9.8 2.7 6.0 -2.0 6.2Z' fill='#2f5e2a'/><path d='M8.7 16.4 L-2.0 6.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M5.0 12.9 L5.6 9.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M5.0 12.9 L2.0 13.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M3.2 11.1 L3.8 8.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M3.2 11.1 L0.2 11.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M1.3 9.3 L1.9 6.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M1.3 9.3 L-1.7 10.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.35s;--dl:-2.15s;--o:16.8px 27.5px'><path d='M15.4 26.3 C15.6 20.9 9.9 17.6 5.3 18.2 C5.7 22.8 10.1 27.7 15.4 26.3Z' fill='#3f7a35'/><path d='M15.4 26.3 C15.6 20.9 9.9 17.6 5.3 18.2Z' fill='#2f5e2a'/><path d='M16.8 27.5 L5.3 18.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M12.8 24.3 L13.2 21.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M12.8 24.3 L9.9 25.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M10.8 22.7 L11.2 19.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M10.8 22.7 L7.9 23.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M8.8 21.0 L9.2 18.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M8.8 21.0 L5.9 22.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.05s;--dl:-1.06s;--o:25.9px 38.0px'><path d='M27.3 36.9 C32.2 38.2 36.4 33.6 36.7 29.2 C32.3 28.7 27.0 31.8 27.3 36.9Z' fill='#3f7a35'/><path d='M27.3 36.9 C32.2 38.2 36.4 33.6 36.7 29.2Z' fill='#2f5e2a'/><path d='M25.9 38.0 L36.7 29.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M29.6 35.0 L32.4 35.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M29.6 35.0 L29.3 32.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M31.5 33.4 L34.3 34.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M31.5 33.4 L31.2 30.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M33.4 31.9 L36.2 32.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M33.4 31.9 L33.1 29.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.77s;--dl:-3.2s;--o:30.8px 50.7px'><path d='M32.3 50.1 C36.3 52.8 41.3 50.0 43.0 46.3 C39.3 44.5 33.7 45.5 32.3 50.1Z' fill='#3f7a35'/><path d='M32.3 50.1 C36.3 52.8 41.3 50.0 43.0 46.3Z' fill='#2f5e2a'/><path d='M30.8 50.7 L43.0 46.3' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M35.0 49.2 L37.1 50.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M35.0 49.2 L35.6 46.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M37.1 48.4 L39.3 50.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M37.1 48.4 L37.8 45.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M39.3 47.6 L41.4 49.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M39.3 47.6 L39.9 45.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.95s;--dl:-2.54s;--o:30.1px 66.4px'><path d='M28.7 67.0 C25.0 64.7 20.5 67.3 19.1 70.8 C22.5 72.4 27.6 71.2 28.7 67.0Z' fill='#3f7a35'/><path d='M28.7 67.0 C25.0 64.7 20.5 67.3 19.1 70.8Z' fill='#2f5e2a'/><path d='M30.1 66.4 L19.1 70.8' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M26.3 67.9 L24.3 66.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M26.3 67.9 L25.8 70.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M24.4 68.7 L22.4 67.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M24.4 68.7 L23.9 71.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M22.5 69.5 L20.4 68.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M22.5 69.5 L22.0 71.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:4.22s;--dl:-3.31s;--o:26.4px 80.0px'><path d='M25.2 80.7 C21.2 79.1 17.3 82.5 16.5 86.1 C20.1 87.0 24.8 85.0 25.2 80.7Z' fill='#3f7a35'/><path d='M25.2 80.7 C21.2 79.1 17.3 82.5 16.5 86.1Z' fill='#2f5e2a'/><path d='M26.4 80.0 L16.5 86.1' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M23.0 82.1 L20.8 81.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M23.0 82.1 L23.0 84.5' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M21.3 83.1 L19.1 82.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M21.3 83.1 L21.2 85.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M19.6 84.2 L17.4 83.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M19.6 84.2 L19.5 86.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:2.95s;--dl:-2.3s;--o:19.0px 90.0px'><path d='M17.3 90.7 C12.6 87.6 6.7 90.9 4.8 95.3 C9.1 97.4 15.7 96.1 17.3 90.7Z' fill='#3f7a35'/><path d='M17.3 90.7 C12.6 87.6 6.7 90.9 4.8 95.3Z' fill='#2f5e2a'/><path d='M19.0 90.0 L4.8 95.3' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M14.2 91.8 L11.6 89.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M14.2 91.8 L13.5 94.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M11.7 92.7 L9.1 90.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M11.7 92.7 L11.0 95.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M9.2 93.7 L6.6 91.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M9.2 93.7 L8.5 96.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.37s;--dl:-1.43s;--o:15.9px 99.2px'><path d='M17.3 98.5 C21.4 100.7 25.9 97.5 27.2 93.7 C23.4 92.3 18.1 93.9 17.3 98.5Z' fill='#3f7a35'/><path d='M17.3 98.5 C21.4 100.7 25.9 97.5 27.2 93.7Z' fill='#2f5e2a'/><path d='M15.9 99.2 L27.2 93.7' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M19.8 97.3 L22.0 98.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M19.8 97.3 L20.1 94.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M21.7 96.3 L24.0 97.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M21.7 96.3 L22.1 93.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M23.7 95.4 L26.0 96.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M23.7 95.4 L24.0 92.8' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.55s;--dl:-0.47s;--o:19.0px 108.6px'><path d='M20.4 107.3 C26.0 108.4 30.3 103.1 30.4 98.2 C25.6 97.9 19.8 101.6 20.4 107.3Z' fill='#3f7a35'/><path d='M20.4 107.3 C26.0 108.4 30.3 103.1 30.4 98.2Z' fill='#2f5e2a'/><path d='M19.0 108.6 L30.4 98.2' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M22.9 105.0 L26.1 105.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M22.9 105.0 L22.4 101.9' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M24.9 103.2 L28.1 104.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M24.9 103.2 L24.4 100.0' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M26.9 101.4 L30.1 102.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M26.9 101.4 L26.4 98.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.47s;--dl:-0.55s;--o:23.6px 112.0px'><path d='M22.2 112.6 C18.2 110.5 13.7 113.6 12.5 117.3 C16.1 118.6 21.3 117.1 22.2 112.6Z' fill='#3f7a35'/><path d='M22.2 112.6 C18.2 110.5 13.7 113.6 12.5 117.3Z' fill='#2f5e2a'/><path d='M23.6 112.0 L12.5 117.3' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M19.8 113.8 L17.6 112.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M19.8 113.8 L19.4 116.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M17.8 114.7 L15.6 113.4' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M17.8 114.7 L17.5 117.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M15.9 115.6 L13.7 114.3' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M15.9 115.6 L15.5 118.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g><g class='a-leaf' style='--d:3.54s;--dl:-0.75s;--o:29.3px 107.0px'><path d='M30.5 108.4 C29.1 113.9 34.3 118.4 39.2 118.8 C39.7 113.9 36.2 108.0 30.5 108.4Z' fill='#3f7a35'/><path d='M30.5 108.4 C29.1 113.9 34.3 118.4 39.2 118.8Z' fill='#2f5e2a'/><path d='M29.3 107.0 L39.2 118.8' stroke='#2e5a22' stroke-width='.9' opacity='.75'/><path d='M32.6 111.0 L31.7 114.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M32.6 111.0 L35.8 110.6' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M34.4 113.1 L33.4 116.1' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M34.4 113.1 L37.6 112.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M36.1 115.1 L35.2 118.2' stroke='#2e5a22' stroke-width='.6' opacity='.55'/><path d='M36.1 115.1 L39.3 114.7' stroke='#2e5a22' stroke-width='.6' opacity='.55'/></g></g></svg><svg xmlns='http://www.w3.org/2000/svg' class='da-s l' style='left:6px;top:24%;width:60px' viewBox='0 0 60 60' width='60' height='60'><defs><filter id='glfy1' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='3' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-fly' style='--d:9s;--dl:0s'><g class='a-bob' style='--d:3.2s;--dl:0s'><circle cx='30.0' cy='34.0' r='11.5' fill='#e6ff9a' opacity='.28' filter='url(#glfy1)'/><g class='a-flap' style='--d:0.35s;--dl:0s'><ellipse cx='23.1' cy='31.7' rx='7.6' ry='3.4' transform='rotate(-35 30.0 34.0)' fill='#c9f3ff' opacity='.6'/><ellipse cx='24.2' cy='31.7' rx='6.3' ry='2.8' transform='rotate(-10 30.0 34.0)' fill='#c9f3ff' opacity='.6'/><ellipse cx='36.9' cy='31.7' rx='7.6' ry='3.4' transform='rotate(35 30.0 34.0)' fill='#c9f3ff' opacity='.6'/><ellipse cx='35.8' cy='31.7' rx='6.3' ry='2.8' transform='rotate(10 30.0 34.0)' fill='#c9f3ff' opacity='.6'/></g><circle cx='30.0' cy='28.8' r='2.2' fill='#f4e9c8'/><path d='M30.0 30.6 L28.3 39.2 L31.7 39.2Z' fill='#f4e9c8'/><circle cx='34.6' cy='36.3' r='1.1' fill='#fffbd0'/></g></g></svg><svg xmlns='http://www.w3.org/2000/svg' class='da-s r' style='right:8px;top:23%;width:60px' viewBox='0 0 60 60' width='60' height='60'><defs><filter id='glfy2' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='3' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-fly rev' style='--d:11s;--dl:-4s'><g class='a-bob' style='--d:2.7s;--dl:-1s'><circle cx='30.0' cy='34.0' r='10.0' fill='#e6ff9a' opacity='.28' filter='url(#glfy2)'/><g class='a-flap' style='--d:0.35s;--dl:-1s'><ellipse cx='24.0' cy='32.0' rx='6.6' ry='3.0' transform='rotate(-35 30.0 34.0)' fill='#ffd6f4' opacity='.6'/><ellipse cx='25.0' cy='32.0' rx='5.5' ry='2.4' transform='rotate(-10 30.0 34.0)' fill='#ffd6f4' opacity='.6'/><ellipse cx='36.0' cy='32.0' rx='6.6' ry='3.0' transform='rotate(35 30.0 34.0)' fill='#ffd6f4' opacity='.6'/><ellipse cx='35.0' cy='32.0' rx='5.5' ry='2.4' transform='rotate(10 30.0 34.0)' fill='#ffd6f4' opacity='.6'/></g><circle cx='30.0' cy='29.5' r='1.9' fill='#f4e9c8'/><path d='M30.0 31.0 L28.5 38.5 L31.5 38.5Z' fill='#f4e9c8'/><circle cx='34.0' cy='36.0' r='1.0' fill='#fffbd0'/></g></g></svg>"}, "black": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><g class='a-bob' style='--d:4s;--dl:0s'><g class='a-flapv' style='--d:0.5s;--dl:0s'><path d='M18.0 140.0 q-6.0 -6.0 -14.0 -2.0 q4.0 1.0 3.0 5.0 q4.0 -2.0 5.0 1.0 q1.0 -3.0 6.0 -1.0 q5.0 -2.0 6.0 1.0 q1.0 -3.0 5.0 -1.0 q-1.0 -4.0 3.0 -5.0 q-8.0 -4.0 -14.0 2.0Z' fill='#4a423b'/></g></g><g class='a-bob' style='--d:5s;--dl:-1.5s'><g class='a-flapv' style='--d:0.5s;--dl:-1.5s'><path d='M386.0 120.0 q-5.4 -5.4 -12.6 -1.8 q3.6 0.9 2.7 4.5 q3.6 -1.8 4.5 0.9 q0.9 -2.7 5.4 -0.9 q4.5 -1.8 5.4 0.9 q0.9 -2.7 4.5 -0.9 q-0.9 -3.6 2.7 -4.5 q-7.2 -3.6 -12.6 1.8Z' fill='#4a423b'/></g></g><g class='a-bob' style='--d:3.6s;--dl:-0.8s'><g class='a-flapv' style='--d:0.5s;--dl:-0.8s'><path d='M378.0 158.0 q-3.6 -3.6 -8.4 -1.2 q2.4 0.6 1.8 3.0 q2.4 -1.2 3.0 0.6 q0.6 -1.8 3.6 -0.6 q3.0 -1.2 3.6 0.6 q0.6 -1.8 3.0 -0.6 q-0.6 -2.4 1.8 -3.0 q-4.8 -2.4 -8.4 1.2Z' fill='#3a3430'/></g></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><path d='M40.0 154.0 c-9.8 0 -15.4 7.0 -15.4 14.0 c0 5.6 2.8 8.4 5.6 9.8 v5.6 h19.6 v-5.6 c2.8 -1.4 5.6 -4.2 5.6 -9.8 c0 -7.0 -5.6 -14.0 -15.4 -14.0z' fill='#cfc8b8'/><circle cx='34.4' cy='169.4' r='3.6' fill='#0b0b0b'/><circle cx='45.6' cy='169.4' r='3.6' fill='#0b0b0b'/><g class='a-jaw' style='--d:3.2s;--dl:0s'><path d='M31.6 175.0 h16.8 v4.2 q-8.4 4.2 -16.8 0z' fill='#cfc8b8'/><line x1='34.4' y1='175.0' x2='34.4' y2='178.5' stroke='#0b0b0b' stroke-width='0.7'/><line x1='38.2' y1='175.0' x2='38.2' y2='178.5' stroke='#0b0b0b' stroke-width='0.7'/><line x1='42.0' y1='175.0' x2='42.0' y2='178.5' stroke='#0b0b0b' stroke-width='0.7'/><line x1='45.7' y1='175.0' x2='45.7' y2='178.5' stroke='#0b0b0b' stroke-width='0.7'/></g><path d='M360.0 161.0 c-7.7 0 -12.1 5.5 -12.1 11.0 c0 4.4 2.2 6.6 4.4 7.7 v4.4 h15.4 v-4.4 c2.2 -1.1 4.4 -3.3 4.4 -7.7 c0 -5.5 -4.4 -11.0 -12.1 -11.0z' fill='#cfc8b8'/><circle cx='355.6' cy='173.1' r='2.9' fill='#0b0b0b'/><circle cx='364.4' cy='173.1' r='2.9' fill='#0b0b0b'/><g class='a-jaw' style='--d:3.2s;--dl:-1.4s'><path d='M353.4 177.5 h13.2 v3.3 q-6.6 3.3 -13.2 0z' fill='#cfc8b8'/><line x1='355.6' y1='177.5' x2='355.6' y2='180.2' stroke='#0b0b0b' stroke-width='0.6'/><line x1='358.6' y1='177.5' x2='358.6' y2='180.2' stroke='#0b0b0b' stroke-width='0.6'/><line x1='361.5' y1='177.5' x2='361.5' y2='180.2' stroke='#0b0b0b' stroke-width='0.6'/><line x1='364.5' y1='177.5' x2='364.5' y2='180.2' stroke='#0b0b0b' stroke-width='0.6'/></g><path d='M78.0 172.0 c-5.6 0 -8.8 4.0 -8.8 8.0 c0 3.2 1.6 4.8 3.2 5.6 v3.2 h11.2 v-3.2 c1.6 -0.8 3.2 -2.4 3.2 -5.6 c0 -4.0 -3.2 -8.0 -8.8 -8.0z' fill='#a59e90'/><circle cx='74.8' cy='180.8' r='2.1' fill='#0b0b0b'/><circle cx='81.2' cy='180.8' r='2.1' fill='#0b0b0b'/><g class='a-jaw' style='--d:3.2s;--dl:-2.1s'><path d='M73.2 184.0 h9.6 v2.4 q-4.8 2.4 -9.6 0z' fill='#a59e90'/><line x1='74.8' y1='184.0' x2='74.8' y2='186.0' stroke='#0b0b0b' stroke-width='0.4'/><line x1='77.0' y1='184.0' x2='77.0' y2='186.0' stroke='#0b0b0b' stroke-width='0.4'/><line x1='79.1' y1='184.0' x2='79.1' y2='186.0' stroke='#0b0b0b' stroke-width='0.4'/><line x1='81.3' y1='184.0' x2='81.3' y2='186.0' stroke='#0b0b0b' stroke-width='0.4'/></g></svg>"}, "red": {"bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-flicker' style='--d:1.06s;--dl:-0.05s'><path d='M-11.4 190 Q-15.7 150.0 6.5 110.1 Q35.6 150.0 31.4 190Z' fill='#7a1c06' opacity='0.90'/><path d='M-7.2 190 Q-10.6 158.8 10.3 127.6 Q30.5 158.8 27.1 190Z' fill='#d8461a' opacity='0.82'/><path d='M-2.9 190 Q-5.4 167.6 8.9 145.2 Q25.4 167.6 22.8 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M1.4 190 Q-0.3 176.4 6.4 162.8 Q20.2 176.4 18.5 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:1.14s;--dl:-1.33s'><path d='M27.9 190 Q24.6 153.4 43.5 116.7 Q63.6 153.4 60.3 190Z' fill='#7a1c06' opacity='0.90'/><path d='M31.1 190 Q28.5 161.4 46.7 132.9 Q59.7 161.4 57.1 190Z' fill='#d8461a' opacity='0.82'/><path d='M34.4 190 Q32.4 169.5 41.1 149.0 Q55.8 169.5 53.8 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M37.6 190 Q36.3 177.5 41.9 165.1 Q51.9 177.5 50.6 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.78s;--dl:-0.43s'><path d='M54.9 190 Q50.0 139.9 75.7 89.8 Q108.6 139.9 103.7 190Z' fill='#7a1c06' opacity='0.90'/><path d='M59.8 190 Q55.9 150.9 82.2 111.8 Q102.7 150.9 98.8 190Z' fill='#d8461a' opacity='0.82'/><path d='M64.7 190 Q61.7 161.9 77.6 133.9 Q96.9 161.9 93.9 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M69.5 190 Q67.6 173.0 76.4 155.9 Q91.0 173.0 89.1 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.74s;--dl:-0.29s'><path d='M96.7 190 Q92.5 148.8 118.5 107.6 Q142.3 148.8 138.2 190Z' fill='#7a1c06' opacity='0.90'/><path d='M100.8 190 Q97.5 157.9 116.4 125.7 Q137.3 157.9 134.0 190Z' fill='#d8461a' opacity='0.82'/><path d='M105.0 190 Q102.5 166.9 117.8 143.9 Q132.4 166.9 129.9 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M109.1 190 Q107.5 176.0 113.9 162.0 Q127.4 176.0 125.7 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:1.19s;--dl:-0.34s'><path d='M125.7 190 Q122.1 138.6 144.7 87.2 Q166.0 138.6 162.3 190Z' fill='#7a1c06' opacity='0.90'/><path d='M129.4 190 Q126.5 149.9 143.6 109.8 Q161.6 149.9 158.6 190Z' fill='#d8461a' opacity='0.82'/><path d='M133.0 190 Q130.8 161.2 142.4 132.4 Q157.2 161.2 155.0 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M136.7 190 Q135.2 172.5 146.4 155.1 Q152.8 172.5 151.3 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.99s;--dl:-1.06s'><path d='M148.1 190 Q143.4 134.6 173.4 79.2 Q199.7 134.6 195.0 190Z' fill='#7a1c06' opacity='0.90'/><path d='M152.8 190 Q149.0 146.8 169.8 103.6 Q194.0 146.8 190.3 190Z' fill='#d8461a' opacity='0.82'/><path d='M157.4 190 Q154.6 159.0 175.4 127.9 Q188.4 159.0 185.6 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M162.1 190 Q160.3 171.2 168.5 152.3 Q182.8 171.2 180.9 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.92s;--dl:-0.97s'><path d='M173.5 190 Q170.4 136.1 190.6 82.2 Q208.2 136.1 205.0 190Z' fill='#7a1c06' opacity='0.90'/><path d='M176.7 190 Q174.2 147.9 191.4 105.9 Q204.4 147.9 201.9 190Z' fill='#d8461a' opacity='0.82'/><path d='M179.8 190 Q178.0 159.8 189.9 129.6 Q200.6 159.8 198.7 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M183.0 190 Q181.7 171.7 192.3 153.3 Q196.9 171.7 195.6 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.74s;--dl:-0.98s'><path d='M214.1 190 Q210.2 132.3 236.4 74.7 Q257.2 132.3 253.3 190Z' fill='#7a1c06' opacity='0.90'/><path d='M218.0 190 Q214.9 145.0 237.2 100.0 Q252.5 145.0 249.3 190Z' fill='#d8461a' opacity='0.82'/><path d='M221.9 190 Q219.6 157.7 233.5 125.4 Q247.8 157.7 245.4 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M225.8 190 Q224.3 170.4 235.0 150.8 Q243.1 170.4 241.5 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:1.02s;--dl:-0.24s'><path d='M243.1 190 Q238.5 115.3 264.3 40.6 Q293.6 115.3 289.0 190Z' fill='#7a1c06' opacity='0.90'/><path d='M247.7 190 Q244.0 131.7 265.2 73.4 Q288.1 131.7 284.4 190Z' fill='#d8461a' opacity='0.82'/><path d='M252.3 190 Q249.5 148.2 267.4 106.3 Q282.6 148.2 279.8 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M256.9 190 Q255.0 164.6 262.2 139.2 Q277.1 164.6 275.3 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.76s;--dl:-0.63s'><path d='M258.1 190 Q253.6 153.8 277.6 117.6 Q307.5 153.8 303.0 190Z' fill='#7a1c06' opacity='0.90'/><path d='M262.5 190 Q258.9 161.8 278.5 133.6 Q302.1 161.8 298.5 190Z' fill='#d8461a' opacity='0.82'/><path d='M267.0 190 Q264.3 169.7 279.7 149.5 Q296.7 169.7 294.0 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M271.5 190 Q269.7 177.7 283.5 165.4 Q291.3 177.7 289.5 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:1.32s;--dl:-1.34s'><path d='M301.7 190 Q297.1 119.8 327.5 49.6 Q352.1 119.8 347.5 190Z' fill='#7a1c06' opacity='0.90'/><path d='M306.2 190 Q302.6 135.3 322.8 80.5 Q346.6 135.3 343.0 190Z' fill='#d8461a' opacity='0.82'/><path d='M310.8 190 Q308.1 150.7 323.9 111.4 Q341.1 150.7 338.4 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M315.4 190 Q313.6 166.1 323.5 142.3 Q335.6 166.1 333.8 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.7s;--dl:-0.59s'><path d='M325.6 190 Q322.1 149.0 341.0 108.0 Q364.1 149.0 360.6 190Z' fill='#7a1c06' opacity='0.90'/><path d='M329.1 190 Q326.3 158.0 343.0 126.0 Q359.9 158.0 357.1 190Z' fill='#d8461a' opacity='0.82'/><path d='M332.6 190 Q330.5 167.0 343.8 144.1 Q355.7 167.0 353.6 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M336.1 190 Q334.7 176.1 341.2 162.1 Q351.5 176.1 350.1 190Z' fill='#ffd36b' opacity='0.66'/></g><g class='a-flicker' style='--d:0.74s;--dl:-1.26s'><path d='M356.4 190 Q351.6 132.9 382.1 75.8 Q409.6 132.9 404.8 190Z' fill='#7a1c06' opacity='0.90'/><path d='M361.2 190 Q357.4 145.5 380.7 100.9 Q403.8 145.5 399.9 190Z' fill='#d8461a' opacity='0.82'/><path d='M366.1 190 Q363.2 158.0 381.5 126.0 Q398.0 158.0 395.1 190Z' fill='#ff9a3c' opacity='0.74'/><path d='M370.9 190 Q369.0 170.6 382.0 151.2 Q392.2 170.6 390.3 190Z' fill='#ffd36b' opacity='0.66'/></g></svg>"}, "blue": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><defs><filter id='glt' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='3' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-spin' style='--d:40s;--dl:0s'><circle cx='12' cy='130' r='14' fill='none' stroke='#6fd3ff' stroke-width='1.4' opacity='.8'/><circle cx='12' cy='130' r='10.9' fill='none' stroke='#6fd3ff' stroke-width='.8' stroke-dasharray='3 4' opacity='.7'/><path d='M22.4 126.2 L26.4 132.2 M26.4 126.2 L24.4 129.2' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M20.4 133.9 L24.4 139.9 M24.4 133.9 L22.4 136.9' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M15.7 138.1 L19.7 144.1 M19.7 138.1 L17.7 141.1' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M10.5 139.4 L14.5 145.4 M14.5 139.4 L12.5 142.4' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M3.8 137.8 L7.8 143.8 M7.8 137.8 L5.8 140.8' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M-0.7 133.3 L3.3 139.3 M3.3 133.3 L1.3 136.3' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M-2.5 126.7 L1.5 132.7 M1.5 126.7 L-0.5 129.7' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M-0.5 120.2 L3.5 126.2 M3.5 120.2 L1.5 123.2' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M3.0 116.7 L7.0 122.7 M7.0 116.7 L5.0 119.7' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M9.0 114.6 L13.0 120.6 M13.0 114.6 L11.0 117.6' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M16.9 116.6 L20.9 122.6 M20.9 116.6 L18.9 119.6' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M20.7 120.6 L24.7 126.6 M24.7 120.6 L22.7 123.6' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><polygon points='12.0,121.6 20.0,127.4 16.9,136.8 7.1,136.8 4.0,127.4' fill='none' stroke='#6fd3ff' stroke-width='.9' opacity='.6'/></g><g class='a-spin rev' style='--d:30s;--dl:0s'><circle cx='388' cy='150' r='12' fill='none' stroke='#6fd3ff' stroke-width='1.4' opacity='.8'/><circle cx='388' cy='150' r='9.4' fill='none' stroke='#6fd3ff' stroke-width='.8' stroke-dasharray='3 4' opacity='.7'/><path d='M396.6 147.8 L400.6 153.8 M400.6 147.8 L398.6 150.8' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M394.8 153.0 L398.8 159.0 M398.8 153.0 L396.8 156.0' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M392.0 155.8 L396.0 161.8 M396.0 155.8 L394.0 158.8' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M386.8 157.7 L390.8 163.7 M390.8 157.7 L388.8 160.7' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M380.1 155.9 L384.1 161.9 M384.1 155.9 L382.1 158.9' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M376.5 152.0 L380.5 158.0 M380.5 152.0 L378.5 155.0' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M375.3 146.7 L379.3 152.7 M379.3 146.7 L377.3 149.7' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M376.6 142.0 L380.6 148.0 M380.6 142.0 L378.6 145.0' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M380.8 137.7 L384.8 143.7 M384.8 137.7 L382.8 140.7' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M386.2 136.3 L390.2 142.3 M390.2 136.3 L388.2 139.3' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M391.5 137.8 L395.5 143.8 M395.5 137.8 L393.5 140.8' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><path d='M394.9 141.1 L398.9 147.1 M398.9 141.1 L396.9 144.1' stroke='#6fd3ff' stroke-width='.9' opacity='.8'/><polygon points='388.0,142.8 394.8,147.8 392.2,155.8 383.8,155.8 381.2,147.8' fill='none' stroke='#6fd3ff' stroke-width='.9' opacity='.6'/></g><g class='a-pulse' style='--d:4s;--dl:0s'><circle cx='390' cy='112' r='7' fill='none' stroke='#b3e9ff' stroke-width='1.4' opacity='.8'/><circle cx='390' cy='112' r='5.5' fill='none' stroke='#b3e9ff' stroke-width='.8' stroke-dasharray='3 4' opacity='.7'/><path d='M394.2 108.7 L398.2 114.7 M398.2 108.7 L396.2 111.7' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M393.4 112.2 L397.4 118.2 M397.4 112.2 L395.4 115.2' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M391.2 114.3 L395.2 120.3 M395.2 114.3 L393.2 117.3' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M387.9 115.2 L391.9 121.2 M391.9 115.2 L389.9 118.2' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M384.8 114.3 L388.8 120.3 M388.8 114.3 L386.8 117.3' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M382.9 112.5 L386.9 118.5 M386.9 112.5 L384.9 115.5' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M381.8 109.5 L385.8 115.5 M385.8 109.5 L383.8 112.5' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M382.8 105.6 L386.8 111.6 M386.8 105.6 L384.8 108.6' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M384.7 103.7 L388.7 109.7 M388.7 103.7 L386.7 106.7' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M387.7 102.8 L391.7 108.8 M391.7 102.8 L389.7 105.8' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M391.6 103.9 L395.6 109.9 M395.6 103.9 L393.6 106.9' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><path d='M393.4 105.9 L397.4 111.9 M397.4 105.9 L395.4 108.9' stroke='#b3e9ff' stroke-width='.9' opacity='.8'/><polygon points='390.0,107.8 394.0,110.7 392.5,115.4 387.5,115.4 386.0,110.7' fill='none' stroke='#b3e9ff' stroke-width='.9' opacity='.6'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-drift' style='--d:7s;--dl:0s'><path d='M0 190 L0 162 L0 162.0 L10 166.7 L20 167.8 L30 164.6 L40 159.4 L50 156.2 L60 157.3 L70 162.0 L80 166.7 L90 167.8 L100 164.6 L110 159.4 L120 156.2 L130 157.3 L140 162.0 L150 166.7 L160 167.8 L170 164.6 L180 159.4 L190 156.2 L200 157.3 L210 162.0 L220 166.7 L230 167.8 L240 164.6 L250 159.4 L260 156.2 L270 157.3 L280 162.0 L290 166.7 L300 167.8 L310 164.6 L320 159.4 L330 156.2 L340 157.3 L350 162.0 L360 166.7 L370 167.8 L380 164.6 L390 159.4 L400 156.2 L410 157.3 L420 162.0 L430 166.7 L440 167.8 L450 164.6 L460 159.4 L470 156.2 L480 157.3 L490 162.0 L500 166.7 L510 167.8 L520 164.6 L520 190Z' fill='#1d77b0' opacity='0.8'/></g><g class='a-swim' style='--d:16s;--dl:-3s'><path d='M-30.0 150.0 q8.8 -5.5 17.6 0 q-8.8 5.5 -17.6 0 Z M-12.4 150.0 l5.5 -4.4 l0 8.8Z' fill='#0a2a44'/></g><g class='a-swim rev' style='--d:21s;--dl:-9s'><path d='M430.0 168.0 q-7.2 -4.5 -14.4 0 q7.2 4.5 14.4 0 Z M415.6 168.0 l-4.5 -3.6 l0 7.2Z' fill='#0a2a44'/></g><g class='a-swim' style='--d:12s;--dl:-7s'><path d='M-30.0 132.0 q5.6 -3.5 11.2 0 q-5.6 3.5 -11.2 0 Z M-18.8 132.0 l3.5 -2.8 l0 5.6Z' fill='#3aa0d8'/></g><g class='a-sway' style='--d:5s;--dl:-1s'><path d='M14 190 Q22.0 184.4 23.0 178.8 Q31.0 173.1 12.3 167.5 Q20.3 161.9 4.0 156.2 Q12.0 150.6 10.4 145.0 Q18.4 139.4 22.0 133.8 Q30.0 128.1 21.9 122.5 Q29.9 116.9 10.2 111.2 Q18.2 105.6 4.1 100.0' stroke='#1b5f8a' stroke-width='3' fill='none'/><path d='M23.0 178.8 Q18.3 173.4 11.5 175.5 Q16.2 180.8 23.0 178.8Z' fill='#1b5f8a' opacity='0.85'/><path d='M12.3 167.5 Q8.1 163.0 2.3 164.9 Q6.4 169.4 12.3 167.5Z' fill='#1b5f8a' opacity='0.85'/><path d='M4.0 156.2 Q-1.0 152.8 -6.3 156.0 Q-1.2 159.4 4.0 156.2Z' fill='#1b5f8a' opacity='0.85'/><path d='M10.4 145.0 Q4.9 140.0 -2.0 142.9 Q3.5 147.9 10.4 145.0Z' fill='#1b5f8a' opacity='0.85'/><path d='M22.0 133.8 Q18.8 126.6 10.9 126.5 Q14.1 133.7 22.0 133.8Z' fill='#1b5f8a' opacity='0.85'/><path d='M21.9 122.5 Q18.5 117.1 12.2 117.9 Q15.6 123.3 21.9 122.5Z' fill='#1b5f8a' opacity='0.85'/><path d='M10.2 111.2 Q5.7 104.6 -2.2 106.0 Q2.3 112.6 10.2 111.2Z' fill='#1b5f8a' opacity='0.85'/><path d='M4.1 100.0 Q-2.0 95.8 -8.3 99.6 Q-2.2 103.8 4.1 100.0Z' fill='#1b5f8a' opacity='0.85'/></g><g class='a-sway' style='--d:5.6s;--dl:-2s'><path d='M386 190 Q394.0 183.8 387.2 177.5 Q395.2 171.2 376.8 165.0 Q384.8 158.8 379.8 152.5 Q387.8 146.2 391.9 140.0 Q399.9 133.8 395.3 127.5 Q403.3 121.2 385.1 115.0 Q393.1 108.8 376.2 102.5 Q384.2 96.2 381.7 90.0' stroke='#1b5f8a' stroke-width='3' fill='none'/><path d='M387.2 177.5 Q394.0 177.2 396.6 171.0 Q389.8 171.3 387.2 177.5Z' fill='#1b5f8a' opacity='0.85'/><path d='M376.8 165.0 Q370.1 159.8 362.6 163.6 Q369.3 168.9 376.8 165.0Z' fill='#1b5f8a' opacity='0.85'/><path d='M379.8 152.5 Q374.0 145.9 365.5 148.4 Q371.4 155.0 379.8 152.5Z' fill='#1b5f8a' opacity='0.85'/><path d='M391.9 140.0 Q397.9 141.1 401.4 136.2 Q395.4 135.1 391.9 140.0Z' fill='#1b5f8a' opacity='0.85'/><path d='M395.3 127.5 Q392.5 120.3 384.8 119.9 Q387.7 127.1 395.3 127.5Z' fill='#1b5f8a' opacity='0.85'/><path d='M385.1 115.0 Q392.4 115.3 395.8 108.7 Q388.4 108.4 385.1 115.0Z' fill='#1b5f8a' opacity='0.85'/><path d='M376.2 102.5 Q382.0 103.9 385.7 99.2 Q379.9 97.8 376.2 102.5Z' fill='#1b5f8a' opacity='0.85'/><path d='M381.7 90.0 Q388.7 92.8 394.3 87.6 Q387.2 84.7 381.7 90.0Z' fill='#1b5f8a' opacity='0.85'/></g></svg>"}, "white": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><g class='a-pulse' style='--d:6s;--dl:0s'><path d='M200 -30 L419.7 -41.0 L419.7 -19.0Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L412.4 27.4 L405.6 48.4Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L384.2 90.3 L371.3 108.0Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L338.0 141.3 L320.3 154.2Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L278.4 175.6 L257.4 182.4Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L211.0 189.7 L189.0 189.7Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L142.6 182.4 L121.6 175.6Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L79.7 154.2 L62.0 141.3Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L28.7 108.0 L15.8 90.3Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L-5.6 48.4 L-12.4 27.4Z' fill='#fff5d6' opacity='0.5'/><path d='M200 -30 L-19.7 -19.0 L-19.7 -41.0Z' fill='#fff5d6' opacity='0.5'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-sway' style='--d:5.0s;--dl:0s'><path d='M30 190 q-10 -40 6 -80 q8 30 -6 80z' fill='#e9dcb8' opacity='.8'/></g><g class='a-sway' style='--d:5.7s;--dl:-1s'><path d='M52 190 q-10 -40 6 -80 q8 30 -6 80z' fill='#e9dcb8' opacity='.8'/></g><g class='a-sway' style='--d:6.4s;--dl:-2s'><path d='M350 190 q-10 -40 6 -80 q8 30 -6 80z' fill='#e9dcb8' opacity='.8'/></g><g class='a-sway' style='--d:7.1s;--dl:-3s'><path d='M372 190 q-10 -40 6 -80 q8 30 -6 80z' fill='#e9dcb8' opacity='.8'/></g></svg>"}, "wu": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><defs><filter id='glt' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='3' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-spin' style='--d:36s;--dl:0s'><circle cx='23' cy='120' r='9' fill='none' stroke='#9cc6ff' stroke-width='1.4' opacity='.8'/><circle cx='23' cy='120' r='7.0' fill='none' stroke='#9cc6ff' stroke-width='.8' stroke-dasharray='3 4' opacity='.7'/><path d='M29.0 116.9 L33.0 122.9 M33.0 116.9 L31.0 119.9' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M28.0 120.9 L32.0 126.9 M32.0 120.9 L30.0 123.9' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M25.4 123.7 L29.4 129.7 M29.4 123.7 L27.4 126.7' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M20.5 125.0 L24.5 131.0 M24.5 125.0 L22.5 128.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M17.6 124.3 L21.6 130.3 M21.6 124.3 L19.6 127.3' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M14.1 121.0 L18.1 127.0 M18.1 121.0 L16.1 124.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M13.0 116.4 L17.0 122.4 M17.0 116.4 L15.0 119.4' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M13.8 113.5 L17.8 119.5 M17.8 113.5 L15.8 116.5' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M17.1 110.0 L21.1 116.0 M21.1 110.0 L19.1 113.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M21.2 109.0 L25.2 115.0 M25.2 109.0 L23.2 112.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M24.4 109.8 L28.4 115.8 M28.4 109.8 L26.4 112.8' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M27.9 112.8 L31.9 118.8 M31.9 112.8 L29.9 115.8' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><polygon points='23.0,114.6 28.1,118.3 26.2,124.4 19.8,124.4 17.9,118.3' fill='none' stroke='#9cc6ff' stroke-width='.9' opacity='.6'/></g><g class='a-spin rev' style='--d:30s;--dl:0s'><circle cx='377' cy='120' r='9' fill='none' stroke='#9cc6ff' stroke-width='1.4' opacity='.8'/><circle cx='377' cy='120' r='7.0' fill='none' stroke='#9cc6ff' stroke-width='.8' stroke-dasharray='3 4' opacity='.7'/><path d='M383.0 117.1 L387.0 123.1 M387.0 117.1 L385.0 120.1' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M382.0 120.9 L386.0 126.9 M386.0 120.9 L384.0 123.9' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M378.9 124.0 L382.9 130.0 M382.9 124.0 L380.9 127.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M375.4 125.0 L379.4 131.0 M379.4 125.0 L377.4 128.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M370.6 123.7 L374.6 129.7 M374.6 123.7 L372.6 126.7' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M367.8 120.6 L371.8 126.6 M371.8 120.6 L369.8 123.6' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M367.0 116.8 L371.0 122.8 M371.0 116.8 L369.0 119.8' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M367.8 113.4 L371.8 119.4 M371.8 113.4 L369.8 116.4' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M371.0 110.0 L375.0 116.0 M375.0 110.0 L373.0 113.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M374.8 109.0 L378.8 115.0 M378.8 109.0 L376.8 112.0' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M378.7 109.9 L382.7 115.9 M382.7 109.9 L380.7 112.9' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><path d='M382.2 113.6 L386.2 119.6 M386.2 113.6 L384.2 116.6' stroke='#9cc6ff' stroke-width='.9' opacity='.8'/><polygon points='377.0,114.6 382.1,118.3 380.2,124.4 373.8,124.4 371.9,118.3' fill='none' stroke='#9cc6ff' stroke-width='.9' opacity='.6'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-drift slow' style='--d:18s;--dl:0s'><circle cx='20.0' cy='176.0' r='22.4' fill='#e8f0fb' opacity='0.55'/><circle cx='45.6' cy='166.4' r='25.6' fill='#e8f0fb' opacity='0.55'/><circle cx='74.4' cy='176.0' r='20.8' fill='#e8f0fb' opacity='0.55'/><circle cx='48.8' cy='185.6' r='19.2' fill='#e8f0fb' opacity='0.55'/><circle cx='0.8' cy='182.4' r='14.4' fill='#e8f0fb' opacity='0.55'/><circle cx='150.0' cy='186.0' r='18.2' fill='#cfdcf0' opacity='0.45'/><circle cx='170.8' cy='178.2' r='20.8' fill='#cfdcf0' opacity='0.45'/><circle cx='194.2' cy='186.0' r='16.9' fill='#cfdcf0' opacity='0.45'/><circle cx='173.4' cy='193.8' r='15.6' fill='#cfdcf0' opacity='0.45'/><circle cx='134.4' cy='191.2' r='11.7' fill='#cfdcf0' opacity='0.45'/><circle cx='300.0' cy='178.0' r='23.8' fill='#e8f0fb' opacity='0.55'/><circle cx='327.2' cy='167.8' r='27.2' fill='#e8f0fb' opacity='0.55'/><circle cx='357.8' cy='178.0' r='22.1' fill='#e8f0fb' opacity='0.55'/><circle cx='330.6' cy='188.2' r='20.4' fill='#e8f0fb' opacity='0.55'/><circle cx='279.6' cy='184.8' r='15.3' fill='#e8f0fb' opacity='0.55'/><circle cx='430.0' cy='182.0' r='19.6' fill='#e8f0fb' opacity='0.5'/><circle cx='452.4' cy='173.6' r='22.4' fill='#e8f0fb' opacity='0.5'/><circle cx='477.6' cy='182.0' r='18.2' fill='#e8f0fb' opacity='0.5'/><circle cx='455.2' cy='190.4' r='16.8' fill='#e8f0fb' opacity='0.5'/><circle cx='413.2' cy='187.6' r='12.6' fill='#e8f0fb' opacity='0.5'/></g></svg>"}, "ub": {"bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-curl' style='--d:7s;--dl:0s'><path d='M3.0 199.9 L2.8 195.3 L3.2 190.7 L4.3 185.9 L6.1 181.1 L8.6 176.1 L11.7 171.1 L15.5 166.0 L19.8 161.0 L24.5 156.0 L29.7 151.0 L35.1 146.2 L40.7 141.4 L46.5 136.7 L52.4 132.2 L58.2 127.7 L64.0 123.3 L69.6 118.9 L74.9 114.7 L79.9 110.6 L84.6 106.5 L88.8 102.4 L92.4 98.4 L95.4 94.5 L97.7 90.5 L99.2 86.4 L99.7 82.4 L99.0 78.6 L97.2 75.1 L94.4 72.0 L90.0 70.0 L90.0 70.0 L92.4 74.0 L94.1 77.0 L94.7 79.7 L94.5 82.2 L93.5 84.6 L91.8 87.1 L89.4 89.8 L86.3 92.6 L82.6 95.6 L78.3 98.7 L73.4 101.9 L68.1 105.3 L62.5 108.8 L56.5 112.4 L50.3 116.1 L44.0 120.0 L37.5 124.0 L31.0 128.2 L24.6 132.6 L18.3 137.1 L12.1 141.9 L6.1 146.9 L0.5 152.2 L-4.8 157.7 L-9.6 163.7 L-13.8 170.0 L-17.5 176.8 L-20.3 184.1 L-22.2 191.9 L-23.0 200.1Z' fill='#0b2e33'/><circle cx='-14.7' cy='192.9' r='3.8' fill='#5fd3c8' opacity='.7'/><circle cx='-7.9' cy='173.3' r='3.4' fill='#5fd3c8' opacity='.7'/><circle cx='5.0' cy='156.3' r='3.1' fill='#5fd3c8' opacity='.7'/><circle cx='21.7' cy='141.3' r='2.7' fill='#5fd3c8' opacity='.7'/><circle cx='40.2' cy='127.8' r='2.3' fill='#5fd3c8' opacity='.7'/><circle cx='58.8' cy='115.6' r='2.0' fill='#5fd3c8' opacity='.7'/><circle cx='75.4' cy='104.5' r='1.6' fill='#5fd3c8' opacity='.7'/><circle cx='88.2' cy='94.4' r='1.3' fill='#5fd3c8' opacity='.7'/><circle cx='95.2' cy='85.2' r='0.9' fill='#5fd3c8' opacity='.7'/></g><g class='a-curl rev' style='--d:8s;--dl:-3s'><path d='M422.0 200.8 L421.6 193.2 L419.8 186.0 L416.9 179.5 L413.1 173.6 L408.6 168.2 L403.6 163.3 L398.1 158.7 L392.2 154.5 L385.9 150.4 L379.4 146.6 L372.6 143.0 L365.7 139.5 L358.8 136.2 L351.8 132.9 L345.0 129.8 L338.2 126.8 L331.7 123.9 L325.5 121.1 L319.7 118.3 L314.4 115.6 L309.6 113.0 L305.4 110.5 L301.9 108.1 L299.1 105.7 L297.2 103.5 L296.0 101.5 L295.6 99.3 L296.0 96.8 L297.6 93.9 L300.0 90.0 L300.0 90.0 L295.7 92.0 L293.0 95.1 L291.4 98.5 L291.1 102.2 L292.1 106.0 L294.1 109.6 L296.9 113.2 L300.5 116.7 L304.7 120.2 L309.5 123.6 L314.8 127.1 L320.4 130.6 L326.4 134.2 L332.7 137.8 L339.1 141.4 L345.5 145.1 L352.0 148.9 L358.4 152.8 L364.6 156.8 L370.6 160.8 L376.2 164.9 L381.4 169.0 L386.0 173.2 L390.0 177.4 L393.2 181.5 L395.7 185.4 L397.4 189.2 L398.3 192.7 L398.5 196.0 L398.0 199.2Z' fill='#0b2e33'/><circle cx='405.4' cy='195.2' r='3.5' fill='#5fd3c8' opacity='.7'/><circle cx='400.9' cy='181.9' r='3.2' fill='#5fd3c8' opacity='.7'/><circle cx='389.6' cy='168.8' r='2.8' fill='#5fd3c8' opacity='.7'/><circle cx='373.2' cy='156.5' r='2.5' fill='#5fd3c8' opacity='.7'/><circle cx='354.1' cy='145.1' r='2.2' fill='#5fd3c8' opacity='.7'/><circle cx='334.3' cy='134.5' r='1.8' fill='#5fd3c8' opacity='.7'/><circle cx='316.3' cy='124.5' r='1.5' fill='#5fd3c8' opacity='.7'/><circle cx='302.0' cy='114.8' r='1.2' fill='#5fd3c8' opacity='.7'/><circle cx='293.6' cy='105.2' r='0.8' fill='#5fd3c8' opacity='.7'/></g><g class='a-curl' style='--d:6s;--dl:-1.5s'><path d='M68.0 200.8 L68.0 199.2 L68.5 197.3 L69.7 195.1 L71.6 192.8 L74.2 190.3 L77.5 187.8 L81.3 185.3 L85.6 182.9 L90.3 180.5 L95.3 178.2 L100.5 176.0 L105.9 173.8 L111.4 171.6 L116.9 169.5 L122.3 167.4 L127.6 165.3 L132.8 163.2 L137.7 161.0 L142.3 158.9 L146.5 156.7 L150.2 154.4 L153.5 152.0 L156.2 149.5 L158.2 146.7 L159.5 143.8 L159.7 140.7 L158.8 137.6 L157.0 134.8 L154.3 132.0 L150.0 130.0 L150.0 130.0 L152.6 133.8 L154.7 136.6 L155.7 139.0 L155.8 140.9 L155.3 142.6 L154.2 144.1 L152.5 145.8 L150.1 147.4 L147.0 149.1 L143.4 150.7 L139.4 152.4 L134.8 154.0 L130.0 155.6 L124.8 157.2 L119.4 158.9 L113.8 160.5 L108.2 162.2 L102.5 164.0 L96.8 165.8 L91.2 167.7 L85.7 169.7 L80.4 171.8 L75.4 174.1 L70.7 176.5 L66.3 179.2 L62.2 182.2 L58.6 185.6 L55.6 189.5 L53.3 194.0 L52.0 199.2Z' fill='#123d42'/><circle cx='57.7' cy='195.6' r='2.3' fill='#5fd3c8' opacity='.7'/><circle cx='65.0' cy='185.4' r='2.1' fill='#5fd3c8' opacity='.7'/><circle cx='77.2' cy='177.4' r='1.9' fill='#5fd3c8' opacity='.7'/><circle cx='92.4' cy='170.9' r='1.7' fill='#5fd3c8' opacity='.7'/><circle cx='109.1' cy='165.0' r='1.5' fill='#5fd3c8' opacity='.7'/><circle cx='125.6' cy='159.6' r='1.3' fill='#5fd3c8' opacity='.7'/><circle cx='140.2' cy='154.3' r='1.1' fill='#5fd3c8' opacity='.7'/><circle cx='151.1' cy='148.8' r='0.9' fill='#5fd3c8' opacity='.7'/><circle cx='156.5' cy='142.9' r='0.8' fill='#5fd3c8' opacity='.7'/></g><path d='M0 190 L0 175 L0 175.0 L10 177.8 L20 179.0 L30 177.8 L40 175.0 L50 172.2 L60 171.0 L70 172.2 L80 175.0 L90 177.8 L100 179.0 L110 177.8 L120 175.0 L130 172.2 L140 171.0 L150 172.2 L160 175.0 L170 177.8 L180 179.0 L190 177.8 L200 175.0 L210 172.2 L220 171.0 L230 172.2 L240 175.0 L250 177.8 L260 179.0 L270 177.8 L280 175.0 L290 172.2 L300 171.0 L310 172.2 L320 175.0 L330 177.8 L340 179.0 L350 177.8 L360 175.0 L370 172.2 L380 171.0 L390 172.2 L400 175.0 L400 190Z' fill='#06191c' opacity='0.9'/></svg>"}, "br": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><g class='a-swing' style='--d:4s;--dl:0s'><ellipse cx='0.5' cy='14.9' rx='9' ry='5' transform='rotate(5 0.5 14.9)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='21.5' cy='24.3' rx='9' ry='5' transform='rotate(95 21.5 24.3)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='42.5' cy='32.7' rx='9' ry='5' transform='rotate(5 42.5 32.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='63.5' cy='39.3' rx='9' ry='5' transform='rotate(95 63.5 39.3)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='84.5' cy='43.7' rx='9' ry='5' transform='rotate(5 84.5 43.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='105.5' cy='45.7' rx='9' ry='5' transform='rotate(95 105.5 45.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='126.5' cy='45.3' rx='9' ry='5' transform='rotate(5 126.5 45.3)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='147.5' cy='42.7' rx='9' ry='5' transform='rotate(95 147.5 42.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='168.5' cy='38.3' rx='9' ry='5' transform='rotate(5 168.5 38.3)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='189.5' cy='32.9' rx='9' ry='5' transform='rotate(95 189.5 32.9)' fill='none' stroke='#5a5250' stroke-width='2.6'/></g><g class='a-swing' style='--d:4.6s;--dl:-1s'><ellipse cx='210.5' cy='32.7' rx='9' ry='5' transform='rotate(-7 210.5 32.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='231.5' cy='37.7' rx='9' ry='5' transform='rotate(83 231.5 37.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='252.5' cy='41.7' rx='9' ry='5' transform='rotate(-7 252.5 41.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='273.5' cy='43.9' rx='9' ry='5' transform='rotate(83 273.5 43.9)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='294.5' cy='43.9' rx='9' ry='5' transform='rotate(-7 294.5 43.9)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='315.5' cy='41.5' rx='9' ry='5' transform='rotate(83 315.5 41.5)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='336.5' cy='36.7' rx='9' ry='5' transform='rotate(-7 336.5 36.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='357.5' cy='29.7' rx='9' ry='5' transform='rotate(83 357.5 29.7)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='378.5' cy='20.9' rx='9' ry='5' transform='rotate(-7 378.5 20.9)' fill='none' stroke='#5a5250' stroke-width='2.6'/><ellipse cx='399.5' cy='11.1' rx='9' ry='5' transform='rotate(83 399.5 11.1)' fill='none' stroke='#5a5250' stroke-width='2.6'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-flicker' style='--d:0.83s;--dl:-0.72s'><path d='M-10.8 190 Q-16.0 148.3 14.8 106.6 Q46.2 148.3 41.0 190Z' fill='#4a0808' opacity='0.90'/><path d='M-5.6 190 Q-9.8 157.5 15.1 125.0 Q40.0 157.5 35.8 190Z' fill='#a3150f' opacity='0.82'/><path d='M-0.5 190 Q-3.6 166.7 15.8 143.3 Q33.7 166.7 30.6 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.19s;--dl:-0.06s'><path d='M36.7 190 Q33.2 141.3 52.8 92.5 Q75.5 141.3 71.9 190Z' fill='#4a0808' opacity='0.90'/><path d='M40.2 190 Q37.4 152.0 51.1 114.0 Q71.2 152.0 68.4 190Z' fill='#a3150f' opacity='0.82'/><path d='M43.8 190 Q41.7 162.7 56.8 135.4 Q67.0 162.7 64.9 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.07s;--dl:-0.08s'><path d='M76.2 190 Q71.6 136.1 100.3 82.1 Q127.3 136.1 122.6 190Z' fill='#4a0808' opacity='0.90'/><path d='M80.8 190 Q77.1 147.9 96.7 105.9 Q121.7 147.9 118.0 190Z' fill='#a3150f' opacity='0.82'/><path d='M85.5 190 Q82.7 159.8 95.5 129.6 Q116.1 159.8 113.3 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.06s;--dl:-0.9s'><path d='M89.4 190 Q86.0 157.9 106.1 125.9 Q126.7 157.9 123.3 190Z' fill='#4a0808' opacity='0.90'/><path d='M92.8 190 Q90.1 165.0 105.9 140.0 Q122.6 165.0 119.9 190Z' fill='#a3150f' opacity='0.82'/><path d='M96.2 190 Q94.1 172.0 109.1 154.1 Q118.6 172.0 116.5 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.29s;--dl:-0.99s'><path d='M128.8 190 Q124.5 145.2 148.2 100.4 Q175.5 145.2 171.2 190Z' fill='#4a0808' opacity='0.90'/><path d='M133.0 190 Q129.6 155.1 154.0 120.1 Q170.4 155.1 167.0 190Z' fill='#a3150f' opacity='0.82'/><path d='M137.2 190 Q134.7 164.9 154.0 139.8 Q165.3 164.9 162.7 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.29s;--dl:-0.54s'><path d='M157.6 190 Q153.7 158.3 173.7 126.6 Q200.6 158.3 196.7 190Z' fill='#4a0808' opacity='0.90'/><path d='M161.5 190 Q158.4 165.3 179.3 140.6 Q196.0 165.3 192.8 190Z' fill='#a3150f' opacity='0.82'/><path d='M165.4 190 Q163.1 172.2 176.4 154.5 Q191.3 172.2 188.9 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.39s;--dl:-0.56s'><path d='M215.3 190 Q211.9 139.6 229.6 89.2 Q251.9 139.6 248.6 190Z' fill='#4a0808' opacity='0.90'/><path d='M218.6 190 Q215.9 150.7 235.2 111.4 Q247.9 150.7 245.3 190Z' fill='#a3150f' opacity='0.82'/><path d='M221.9 190 Q219.9 161.8 231.7 133.6 Q243.9 161.8 241.9 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.37s;--dl:-1.06s'><path d='M211.3 190 Q206.4 146.2 233.9 102.4 Q265.1 146.2 260.2 190Z' fill='#4a0808' opacity='0.90'/><path d='M216.2 190 Q212.3 155.8 232.5 121.7 Q259.2 155.8 255.3 190Z' fill='#a3150f' opacity='0.82'/><path d='M221.1 190 Q218.2 165.5 234.4 141.0 Q253.4 165.5 250.4 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.09s;--dl:-0.63s'><path d='M252.9 190 Q249.4 157.8 267.1 125.6 Q291.8 157.8 288.3 190Z' fill='#4a0808' opacity='0.90'/><path d='M256.5 190 Q253.6 164.9 273.0 139.8 Q287.6 164.9 284.7 190Z' fill='#a3150f' opacity='0.82'/><path d='M260.0 190 Q257.9 172.0 268.0 153.9 Q283.3 172.0 281.2 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:0.85s;--dl:-0.38s'><path d='M288.4 190 Q284.8 143.1 307.5 96.2 Q327.9 143.1 324.3 190Z' fill='#4a0808' opacity='0.90'/><path d='M292.0 190 Q289.1 153.4 303.3 116.9 Q323.6 153.4 320.7 190Z' fill='#a3150f' opacity='0.82'/><path d='M295.6 190 Q293.4 163.7 305.7 137.5 Q319.3 163.7 317.1 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:1.3s;--dl:-0.9s'><path d='M346.0 190 Q342.0 140.9 368.8 91.9 Q389.3 140.9 385.4 190Z' fill='#4a0808' opacity='0.90'/><path d='M349.9 190 Q346.8 151.7 363.4 113.5 Q384.6 151.7 381.5 190Z' fill='#a3150f' opacity='0.82'/><path d='M353.9 190 Q351.5 162.5 364.9 135.1 Q379.9 162.5 377.5 190Z' fill='#ff4a2a' opacity='0.74'/></g><g class='a-flicker' style='--d:0.91s;--dl:-0.1s'><path d='M351.2 190 Q347.5 135.3 368.1 80.6 Q392.6 135.3 388.8 190Z' fill='#4a0808' opacity='0.90'/><path d='M355.0 190 Q352.0 147.4 372.2 104.7 Q388.1 147.4 385.1 190Z' fill='#a3150f' opacity='0.82'/><path d='M358.7 190 Q356.5 159.4 368.6 128.8 Q383.5 159.4 381.3 190Z' fill='#ff4a2a' opacity='0.74'/></g><path d='M200.0 166.0 c-8.4 0 -13.2 6.0 -13.2 12.0 c0 4.8 2.4 7.2 4.8 8.4 v4.8 h16.8 v-4.8 c2.4 -1.2 4.8 -3.6 4.8 -8.4 c0 -6.0 -4.8 -12.0 -13.2 -12.0z' fill='#d6cdbd'/><circle cx='195.2' cy='179.2' r='3.1' fill='#0b0b0b'/><circle cx='204.8' cy='179.2' r='3.1' fill='#0b0b0b'/><g class='a-jaw' style='--d:3.2s;--dl:-0.5s'><path d='M192.8 184.0 h14.4 v3.6 q-7.2 3.6 -14.4 0z' fill='#d6cdbd'/><line x1='195.2' y1='184.0' x2='195.2' y2='187.0' stroke='#0b0b0b' stroke-width='0.6'/><line x1='198.4' y1='184.0' x2='198.4' y2='187.0' stroke='#0b0b0b' stroke-width='0.6'/><line x1='201.7' y1='184.0' x2='201.7' y2='187.0' stroke='#0b0b0b' stroke-width='0.6'/><line x1='204.9' y1='184.0' x2='204.9' y2='187.0' stroke='#0b0b0b' stroke-width='0.6'/></g></svg>"}, "rg": {"bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-sway' style='--d:5s;--dl:0s'><path d='M19.9 190 Q22.6 175.2 24.4 165.4 Q23.6 175.2 22.9 190Z' fill='#5a7a2a' opacity='0.98'/><path d='M52.7 190 Q56.1 180.0 58.9 173.4 Q57.1 180.0 55.7 190Z' fill='#5a7a2a' opacity='0.86'/><path d='M59.1 190 Q59.8 175.4 58.5 165.7 Q60.8 175.4 62.1 190Z' fill='#5a7a2a' opacity='0.91'/><path d='M22.2 190 Q26.9 180.4 31.7 174.0 Q27.9 180.4 25.2 190Z' fill='#5a7a2a' opacity='0.74'/><path d='M50.6 190 Q53.1 174.1 54.7 163.5 Q54.1 174.1 53.6 190Z' fill='#5a7a2a' opacity='0.66'/><path d='M108.8 190 Q107.6 175.6 103.6 166.0 Q108.6 175.6 111.8 190Z' fill='#5a7a2a' opacity='0.86'/><path d='M23.1 190 Q21.3 179.2 16.3 171.9 Q22.3 179.2 26.1 190Z' fill='#5a7a2a' opacity='0.68'/><path d='M194.1 190 Q199.5 178.4 205.4 170.7 Q200.5 178.4 197.1 190Z' fill='#5a7a2a' opacity='0.78'/><path d='M120.0 190 Q123.0 173.4 125.2 162.3 Q124.0 173.4 123.0 190Z' fill='#5a7a2a' opacity='0.64'/><path d='M116.3 190 Q115.3 176.0 111.4 166.6 Q116.3 176.0 119.3 190Z' fill='#5a7a2a' opacity='0.64'/><path d='M173.5 190 Q172.5 177.3 168.8 168.8 Q173.5 177.3 176.5 190Z' fill='#5a7a2a' opacity='0.78'/><path d='M42.1 190 Q43.6 174.2 43.6 163.6 Q44.6 174.2 45.1 190Z' fill='#5a7a2a' opacity='0.64'/><path d='M162.1 190 Q161.9 181.8 159.2 176.4 Q162.9 181.8 165.1 190Z' fill='#5a7a2a' opacity='0.61'/><path d='M146.6 190 Q148.3 181.6 148.6 176.0 Q149.3 181.6 149.6 190Z' fill='#5a7a2a' opacity='0.64'/><path d='M94.6 190 Q96.4 175.4 96.8 165.7 Q97.4 175.4 97.6 190Z' fill='#5a7a2a' opacity='0.78'/><path d='M95.5 190 Q97.7 178.1 98.9 170.1 Q98.7 178.1 98.5 190Z' fill='#5a7a2a' opacity='0.64'/><path d='M93.4 190 Q97.8 180.2 102.2 173.7 Q98.8 180.2 96.4 190Z' fill='#5a7a2a' opacity='0.98'/><path d='M11.8 190 Q14.9 181.3 17.4 175.4 Q15.9 181.3 14.8 190Z' fill='#5a7a2a' opacity='0.83'/><path d='M2.3 190 Q7.4 175.2 12.7 165.3 Q8.4 175.2 5.3 190Z' fill='#5a7a2a' opacity='0.77'/><path d='M68.0 190 Q73.0 176.7 78.3 167.8 Q74.0 176.7 71.0 190Z' fill='#5a7a2a' opacity='0.71'/><path d='M59.0 190 Q61.5 180.8 63.0 174.6 Q62.5 180.8 62.0 190Z' fill='#5a7a2a' opacity='0.79'/><path d='M49.7 190 Q47.5 178.6 41.9 171.0 Q48.5 178.6 52.7 190Z' fill='#5a7a2a' opacity='0.72'/><path d='M195.1 190 Q194.8 176.5 192.2 167.5 Q195.8 176.5 198.1 190Z' fill='#5a7a2a' opacity='0.97'/><path d='M70.2 190 Q67.9 180.1 62.4 173.5 Q68.9 180.1 73.2 190Z' fill='#5a7a2a' opacity='0.66'/><path d='M38.3 190 Q42.8 180.3 47.3 173.9 Q43.8 180.3 41.3 190Z' fill='#5a7a2a' opacity='0.71'/><path d='M48.2 190 Q53.1 176.3 58.1 167.1 Q54.1 176.3 51.2 190Z' fill='#5a7a2a' opacity='0.72'/><path d='M150.8 190 Q152.8 178.8 153.5 171.4 Q153.8 178.8 153.8 190Z' fill='#5a7a2a' opacity='0.84'/><path d='M187.0 190 Q188.5 174.6 188.6 164.4 Q189.5 174.6 190.0 190Z' fill='#5a7a2a' opacity='0.94'/><path d='M71.8 190 Q77.0 178.7 82.5 171.1 Q78.0 178.7 74.8 190Z' fill='#5a7a2a' opacity='0.82'/><path d='M153.2 190 Q158.0 179.4 163.0 172.3 Q159.0 179.4 156.2 190Z' fill='#5a7a2a' opacity='0.85'/></g><g class='a-sway' style='--d:5.5s;--dl:-2s'><path d='M391.5 190 Q394.9 182.7 397.8 177.8 Q395.9 182.7 394.5 190Z' fill='#5a7a2a' opacity='0.66'/><path d='M395.8 190 Q400.3 182.6 404.9 177.7 Q401.3 182.6 398.8 190Z' fill='#5a7a2a' opacity='0.87'/><path d='M370.0 190 Q369.4 172.0 366.3 160.0 Q370.4 172.0 373.0 190Z' fill='#5a7a2a' opacity='0.74'/><path d='M340.1 190 Q339.7 179.8 336.9 172.9 Q340.7 179.8 343.1 190Z' fill='#5a7a2a' opacity='0.69'/><path d='M370.1 190 Q373.9 173.4 377.5 162.3 Q374.9 173.4 373.1 190Z' fill='#5a7a2a' opacity='0.69'/><path d='M383.5 190 Q382.8 177.3 379.6 168.8 Q383.8 177.3 386.5 190Z' fill='#5a7a2a' opacity='0.78'/><path d='M282.5 190 Q284.5 181.9 285.3 176.6 Q285.5 181.9 285.5 190Z' fill='#5a7a2a' opacity='0.74'/><path d='M312.4 190 Q315.1 172.8 316.8 161.3 Q316.1 172.8 315.4 190Z' fill='#5a7a2a' opacity='0.76'/><path d='M371.2 190 Q372.6 172.1 372.5 160.1 Q373.6 172.1 374.2 190Z' fill='#5a7a2a' opacity='0.98'/><path d='M202.3 190 Q201.1 181.3 197.2 175.5 Q202.1 181.3 205.3 190Z' fill='#5a7a2a' opacity='0.98'/><path d='M336.6 190 Q336.4 175.0 333.8 165.1 Q337.4 175.0 339.6 190Z' fill='#5a7a2a' opacity='0.80'/><path d='M375.9 190 Q374.3 181.7 369.7 176.2 Q375.3 181.7 378.9 190Z' fill='#5a7a2a' opacity='0.62'/><path d='M292.2 190 Q294.2 173.7 294.8 162.9 Q295.2 173.7 295.2 190Z' fill='#5a7a2a' opacity='0.76'/><path d='M298.9 190 Q304.0 180.9 309.4 174.8 Q305.0 180.9 301.9 190Z' fill='#5a7a2a' opacity='0.74'/><path d='M245.6 190 Q249.7 179.4 253.6 172.4 Q250.7 179.4 248.6 190Z' fill='#5a7a2a' opacity='0.73'/><path d='M379.5 190 Q380.5 179.2 379.8 171.9 Q381.5 179.2 382.5 190Z' fill='#5a7a2a' opacity='0.63'/><path d='M380.0 190 Q381.3 174.2 381.0 163.7 Q382.3 174.2 383.0 190Z' fill='#5a7a2a' opacity='0.65'/><path d='M297.0 190 Q301.2 178.7 305.3 171.2 Q302.2 178.7 300.0 190Z' fill='#5a7a2a' opacity='0.97'/><path d='M346.7 190 Q344.6 179.7 339.0 172.8 Q345.6 179.7 349.7 190Z' fill='#5a7a2a' opacity='0.96'/><path d='M387.4 190 Q388.9 181.1 388.9 175.1 Q389.9 181.1 390.4 190Z' fill='#5a7a2a' opacity='0.79'/><path d='M393.8 190 Q391.8 182.3 386.5 177.2 Q392.8 182.3 396.8 190Z' fill='#5a7a2a' opacity='0.94'/><path d='M312.4 190 Q316.1 177.8 319.5 169.7 Q317.1 177.8 315.4 190Z' fill='#5a7a2a' opacity='0.84'/><path d='M337.0 190 Q335.2 180.0 330.2 173.4 Q336.2 180.0 340.0 190Z' fill='#5a7a2a' opacity='0.60'/><path d='M265.1 190 Q265.7 175.8 264.2 166.3 Q266.7 175.8 268.1 190Z' fill='#5a7a2a' opacity='0.74'/><path d='M322.2 190 Q324.5 175.2 325.6 165.3 Q325.5 175.2 325.2 190Z' fill='#5a7a2a' opacity='0.72'/><path d='M362.8 190 Q367.5 174.2 372.2 163.6 Q368.5 174.2 365.8 190Z' fill='#5a7a2a' opacity='0.96'/><path d='M201.5 190 Q201.8 175.6 200.0 166.0 Q202.8 175.6 204.5 190Z' fill='#5a7a2a' opacity='0.76'/><path d='M302.1 190 Q301.6 181.2 298.6 175.4 Q302.6 181.2 305.1 190Z' fill='#5a7a2a' opacity='0.99'/><path d='M264.7 190 Q267.7 172.9 269.9 161.6 Q268.7 172.9 267.7 190Z' fill='#5a7a2a' opacity='0.73'/><path d='M262.2 190 Q265.4 176.3 267.8 167.1 Q266.4 176.3 265.2 190Z' fill='#5a7a2a' opacity='0.74'/></g><path d='M330 40 q8 30 2 60' stroke='#ff9a4d' stroke-width='3' fill='none' stroke-linecap='round'/><path d='M340 40 q8 30 2 60' stroke='#ff9a4d' stroke-width='4' fill='none' stroke-linecap='round'/><path d='M350 40 q8 30 2 60' stroke='#ff9a4d' stroke-width='3' fill='none' stroke-linecap='round'/></svg>"}, "gw": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><g class='a-sway slow' style='--d:8s;--dl:0s'><path d='M0 120 Q80 10 200 18' stroke='#5a4524' stroke-width='7' fill='none' stroke-linecap='round'/><path d='M0.0 120.0 Q-6.3 125.0 -4.4 132.9 Q1.9 127.9 0.0 120.0Z' fill='#c9d86a' opacity='0.92'/><path d='M6.2 111.7 Q0.7 121.1 6.9 130.1 Q12.4 120.7 6.2 111.7Z' fill='#86b04a' opacity='0.92'/><path d='M12.5 103.8 Q5.1 107.7 5.6 116.1 Q13.0 112.2 12.5 103.8Z' fill='#c9d86a' opacity='0.92'/><path d='M19.0 96.2 Q12.4 106.1 18.6 116.3 Q25.2 106.4 19.0 96.2Z' fill='#86b04a' opacity='0.92'/><path d='M25.6 88.9 Q24.5 99.0 33.1 104.2 Q34.2 94.2 25.6 88.9Z' fill='#c9d86a' opacity='0.92'/><path d='M32.2 82.1 Q29.8 88.8 34.9 93.8 Q37.3 87.1 32.2 82.1Z' fill='#86b04a' opacity='0.92'/><path d='M39.1 75.5 Q41.0 85.9 51.2 88.6 Q49.3 78.1 39.1 75.5Z' fill='#c9d86a' opacity='0.92'/><path d='M46.0 69.3 Q44.8 81.1 55.0 87.1 Q56.2 75.3 46.0 69.3Z' fill='#86b04a' opacity='0.92'/><path d='M53.0 63.5 Q55.0 71.8 63.3 73.5 Q61.3 65.2 53.0 63.5Z' fill='#c9d86a' opacity='0.92'/><path d='M60.2 58.0 Q49.3 65.2 51.3 78.1 Q62.2 70.9 60.2 58.0Z' fill='#86b04a' opacity='0.92'/><path d='M67.5 52.8 Q58.9 61.7 63.3 73.2 Q71.9 64.3 67.5 52.8Z' fill='#c9d86a' opacity='0.92'/><path d='M74.9 48.0 Q72.9 55.1 78.5 59.8 Q80.4 52.8 74.9 48.0Z' fill='#86b04a' opacity='0.92'/><path d='M82.4 43.6 Q83.4 53.6 92.9 56.9 Q91.9 46.9 82.4 43.6Z' fill='#c9d86a' opacity='0.92'/><path d='M90.0 39.5 Q85.7 51.5 94.9 60.5 Q99.2 48.4 90.0 39.5Z' fill='#86b04a' opacity='0.92'/><path d='M97.8 35.8 Q90.5 39.2 90.6 47.3 Q97.9 43.8 97.8 35.8Z' fill='#c9d86a' opacity='0.92'/><path d='M105.6 32.4 Q98.0 34.3 96.6 42.1 Q104.2 40.1 105.6 32.4Z' fill='#86b04a' opacity='0.92'/><path d='M113.6 29.3 Q107.6 37.1 112.1 45.8 Q118.1 38.0 113.6 29.3Z' fill='#c9d86a' opacity='0.92'/><path d='M121.7 26.6 Q117.0 34.4 122.1 42.0 Q126.9 34.2 121.7 26.6Z' fill='#86b04a' opacity='0.92'/><path d='M129.9 24.2 Q131.9 32.2 140.0 33.8 Q138.0 25.8 129.9 24.2Z' fill='#c9d86a' opacity='0.92'/><path d='M138.3 22.2 Q137.0 34.4 147.5 40.7 Q148.8 28.5 138.3 22.2Z' fill='#86b04a' opacity='0.92'/><path d='M146.7 20.6 Q146.0 32.3 156.4 37.9 Q157.1 26.2 146.7 20.6Z' fill='#c9d86a' opacity='0.92'/><path d='M155.3 19.3 Q143.1 23.3 141.6 36.0 Q153.8 32.1 155.3 19.3Z' fill='#86b04a' opacity='0.92'/><path d='M164.0 18.3 Q154.1 24.3 155.4 35.9 Q165.3 29.9 164.0 18.3Z' fill='#c9d86a' opacity='0.92'/><path d='M172.8 17.7 Q164.1 23.7 165.9 34.1 Q174.6 28.1 172.8 17.7Z' fill='#86b04a' opacity='0.92'/><path d='M181.8 17.5 Q177.8 24.2 182.3 30.7 Q186.3 23.9 181.8 17.5Z' fill='#c9d86a' opacity='0.92'/><path d='M190.8 17.6 Q190.3 29.6 200.9 35.1 Q201.5 23.1 190.8 17.6Z' fill='#86b04a' opacity='0.92'/></g><g class='a-sway slow' style='--d:9s;--dl:-3s'><path d='M400 120 Q320 10 200 18' stroke='#5a4524' stroke-width='7' fill='none' stroke-linecap='round'/><path d='M400.0 120.0 Q400.7 132.8 412.7 137.5 Q411.9 124.7 400.0 120.0Z' fill='#e6cf7a' opacity='0.92'/><path d='M393.8 111.7 Q386.6 112.7 384.4 119.6 Q391.6 118.7 393.8 111.7Z' fill='#86b04a' opacity='0.92'/><path d='M387.5 103.8 Q388.2 112.0 396.0 114.7 Q395.2 106.5 387.5 103.8Z' fill='#e6cf7a' opacity='0.92'/><path d='M381.0 96.2 Q377.8 106.7 385.9 114.0 Q389.2 103.5 381.0 96.2Z' fill='#86b04a' opacity='0.92'/><path d='M374.4 88.9 Q373.2 101.3 383.9 107.6 Q385.1 95.3 374.4 88.9Z' fill='#e6cf7a' opacity='0.92'/><path d='M367.8 82.1 Q364.5 94.5 374.4 102.6 Q377.7 90.2 367.8 82.1Z' fill='#86b04a' opacity='0.92'/><path d='M360.9 75.5 Q350.6 78.1 348.6 88.6 Q359.0 86.0 360.9 75.5Z' fill='#e6cf7a' opacity='0.92'/><path d='M354.0 69.3 Q343.2 72.2 341.3 83.2 Q352.1 80.4 354.0 69.3Z' fill='#86b04a' opacity='0.92'/><path d='M347.0 63.5 Q349.4 74.5 360.5 76.9 Q358.1 65.9 347.0 63.5Z' fill='#e6cf7a' opacity='0.92'/><path d='M339.8 58.0 Q331.6 67.2 336.6 78.5 Q344.8 69.3 339.8 58.0Z' fill='#86b04a' opacity='0.92'/><path d='M332.5 52.8 Q332.3 61.8 340.3 65.8 Q340.6 56.8 332.5 52.8Z' fill='#e6cf7a' opacity='0.92'/><path d='M325.1 48.0 Q317.2 57.2 322.2 68.3 Q330.2 59.1 325.1 48.0Z' fill='#86b04a' opacity='0.92'/><path d='M317.6 43.6 Q306.6 49.9 307.8 62.6 Q318.8 56.2 317.6 43.6Z' fill='#e6cf7a' opacity='0.92'/><path d='M310.0 39.5 Q301.9 49.4 307.5 61.0 Q315.6 51.0 310.0 39.5Z' fill='#86b04a' opacity='0.92'/><path d='M302.2 35.8 Q294.4 43.9 298.6 54.4 Q306.4 46.2 302.2 35.8Z' fill='#e6cf7a' opacity='0.92'/><path d='M294.4 32.4 Q285.9 34.1 283.9 42.5 Q292.4 40.8 294.4 32.4Z' fill='#86b04a' opacity='0.92'/><path d='M286.4 29.3 Q278.6 33.7 279.3 42.6 Q287.1 38.3 286.4 29.3Z' fill='#e6cf7a' opacity='0.92'/><path d='M278.3 26.6 Q268.8 35.2 272.7 47.4 Q282.1 38.8 278.3 26.6Z' fill='#86b04a' opacity='0.92'/><path d='M270.1 24.2 Q262.8 27.6 262.8 35.6 Q270.1 32.2 270.1 24.2Z' fill='#e6cf7a' opacity='0.92'/><path d='M261.7 22.2 Q261.5 33.3 271.5 38.2 Q271.7 27.1 261.7 22.2Z' fill='#86b04a' opacity='0.92'/><path d='M253.3 20.6 Q248.9 26.6 252.6 33.1 Q256.9 27.0 253.3 20.6Z' fill='#e6cf7a' opacity='0.92'/><path d='M244.7 19.3 Q237.6 21.2 236.3 28.4 Q243.4 26.5 244.7 19.3Z' fill='#86b04a' opacity='0.92'/><path d='M236.0 18.3 Q230.3 26.7 235.5 35.4 Q241.2 27.0 236.0 18.3Z' fill='#e6cf7a' opacity='0.92'/><path d='M227.2 17.7 Q220.0 24.0 222.7 33.2 Q229.9 26.9 227.2 17.7Z' fill='#86b04a' opacity='0.92'/><path d='M218.2 17.5 Q215.3 29.7 225.2 37.4 Q228.1 25.2 218.2 17.5Z' fill='#e6cf7a' opacity='0.92'/><path d='M209.2 17.6 Q203.1 24.6 206.9 33.1 Q213.0 26.1 209.2 17.6Z' fill='#86b04a' opacity='0.92'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-sway' style='--d:3.5s;--dl:0.0s'><path d='M40 190 q2 -8 0 -14' stroke='#4f7a2e' stroke-width='1.5' fill='none'/><circle cx='44.0' cy='176.0' r='3.2' fill='#fff6d8'/><circle cx='41.2' cy='179.8' r='3.2' fill='#fff6d8'/><circle cx='36.8' cy='178.4' r='3.2' fill='#fff6d8'/><circle cx='36.8' cy='173.6' r='3.2' fill='#fff6d8'/><circle cx='41.2' cy='172.2' r='3.2' fill='#fff6d8'/><circle cx='40' cy='176' r='2.2' fill='#e6c34a'/></g><g class='a-sway' style='--d:3.9s;--dl:-0.7s'><path d='M70 190 q2 -8 0 -14' stroke='#4f7a2e' stroke-width='1.5' fill='none'/><circle cx='74.0' cy='176.0' r='3.2' fill='#fff6d8'/><circle cx='71.2' cy='179.8' r='3.2' fill='#fff6d8'/><circle cx='66.8' cy='178.4' r='3.2' fill='#fff6d8'/><circle cx='66.8' cy='173.6' r='3.2' fill='#fff6d8'/><circle cx='71.2' cy='172.2' r='3.2' fill='#fff6d8'/><circle cx='70' cy='176' r='2.2' fill='#e6c34a'/></g><g class='a-sway' style='--d:4.3s;--dl:-1.4s'><path d='M120 190 q2 -8 0 -14' stroke='#4f7a2e' stroke-width='1.5' fill='none'/><circle cx='124.0' cy='176.0' r='3.2' fill='#fff6d8'/><circle cx='121.2' cy='179.8' r='3.2' fill='#fff6d8'/><circle cx='116.8' cy='178.4' r='3.2' fill='#fff6d8'/><circle cx='116.8' cy='173.6' r='3.2' fill='#fff6d8'/><circle cx='121.2' cy='172.2' r='3.2' fill='#fff6d8'/><circle cx='120' cy='176' r='2.2' fill='#e6c34a'/></g><g class='a-sway' style='--d:4.7s;--dl:-2.0999999999999996s'><path d='M280 190 q2 -8 0 -14' stroke='#4f7a2e' stroke-width='1.5' fill='none'/><circle cx='284.0' cy='176.0' r='3.2' fill='#fff6d8'/><circle cx='281.2' cy='179.8' r='3.2' fill='#fff6d8'/><circle cx='276.8' cy='178.4' r='3.2' fill='#fff6d8'/><circle cx='276.8' cy='173.6' r='3.2' fill='#fff6d8'/><circle cx='281.2' cy='172.2' r='3.2' fill='#fff6d8'/><circle cx='280' cy='176' r='2.2' fill='#e6c34a'/></g><g class='a-sway' style='--d:5.1s;--dl:-2.8s'><path d='M330 190 q2 -8 0 -14' stroke='#4f7a2e' stroke-width='1.5' fill='none'/><circle cx='334.0' cy='176.0' r='3.2' fill='#fff6d8'/><circle cx='331.2' cy='179.8' r='3.2' fill='#fff6d8'/><circle cx='326.8' cy='178.4' r='3.2' fill='#fff6d8'/><circle cx='326.8' cy='173.6' r='3.2' fill='#fff6d8'/><circle cx='331.2' cy='172.2' r='3.2' fill='#fff6d8'/><circle cx='330' cy='176' r='2.2' fill='#e6c34a'/></g><g class='a-sway' style='--d:5.5s;--dl:-3.5s'><path d='M365 190 q2 -8 0 -14' stroke='#4f7a2e' stroke-width='1.5' fill='none'/><circle cx='369.0' cy='176.0' r='3.2' fill='#fff6d8'/><circle cx='366.2' cy='179.8' r='3.2' fill='#fff6d8'/><circle cx='361.8' cy='178.4' r='3.2' fill='#fff6d8'/><circle cx='361.8' cy='173.6' r='3.2' fill='#fff6d8'/><circle cx='366.2' cy='172.2' r='3.2' fill='#fff6d8'/><circle cx='365' cy='176' r='2.2' fill='#e6c34a'/></g></svg>"}, "wb": {"bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><defs><filter id='glb' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='2.5' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-pulse' style='--d:3s;--dl:0s'><circle cx='40' cy='176' r='10' fill='#d9b35a'/><circle cx='40' cy='176' r='7.2' fill='none' stroke='#8f7232' stroke-width='1.2'/></g><g class='a-pulse' style='--d:3.4s;--dl:-1s'><circle cx='58' cy='170' r='9' fill='#e3c06a'/><circle cx='58' cy='170' r='6.5' fill='none' stroke='#8f7232' stroke-width='1.2'/></g><g class='a-pulse' style='--d:2.8s;--dl:-2s'><circle cx='350' cy='178' r='11' fill='#d9b35a'/><circle cx='350' cy='178' r='7.9' fill='none' stroke='#8f7232' stroke-width='1.2'/></g><rect x='317.5' y='176.0' width='5.0' height='14.0' fill='#efe6cf'/><g class='a-flicker' style='--d:0.9s;--dl:0s'><path d='M320.0 168.0 q3.0 4.0 0 7.0 q-3.0 -3.0 0 -7.0z' fill='#ffcf5a' filter='url(#glb)'/></g><rect x='78.0' y='178.8' width='4.0' height='11.2' fill='#efe6cf'/><g class='a-flicker' style='--d:0.9s;--dl:-0.4s'><path d='M80.0 172.4 q2.4 3.2 0 5.6 q-2.4 -2.4 0 -5.6z' fill='#ffcf5a' filter='url(#glb)'/></g><path d='M200.0 171.0 c-6.3 0 -9.9 4.5 -9.9 9.0 c0 3.6 1.8 5.4 3.6 6.3 v3.6 h12.6 v-3.6 c1.8 -0.9 3.6 -2.7 3.6 -6.3 c0 -4.5 -3.6 -9.0 -9.9 -9.0z' fill='#e9e2d0'/><circle cx='196.4' cy='180.9' r='2.3' fill='#3a2a10'/><circle cx='203.6' cy='180.9' r='2.3' fill='#3a2a10'/><g class='a-jaw' style='--d:3.2s;--dl:-1s'><path d='M194.6 184.5 h10.8 v2.7 q-5.4 2.7 -10.8 0z' fill='#e9e2d0'/><line x1='196.4' y1='184.5' x2='196.4' y2='186.8' stroke='#3a2a10' stroke-width='0.5'/><line x1='198.8' y1='184.5' x2='198.8' y2='186.8' stroke='#3a2a10' stroke-width='0.5'/><line x1='201.3' y1='184.5' x2='201.3' y2='186.8' stroke='#3a2a10' stroke-width='0.5'/><line x1='203.7' y1='184.5' x2='203.7' y2='186.8' stroke='#3a2a10' stroke-width='0.5'/></g></svg>"}, "ur": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><defs><filter id='glt' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='2.5' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-spin' style='--d:12s;--dl:0s'><polygon points='26.0,118.0 22.0,122.6 22.6,128.6 16.7,129.9 13.6,135.1 8.0,132.8 2.4,135.1 -0.7,129.9 -6.6,128.6 -6.0,122.6 -10.0,118.0 -6.0,113.4 -6.6,107.4 -0.7,106.1 2.4,100.9 8.0,103.2 13.6,100.9 16.7,106.1 22.6,107.4 22.0,113.4' fill='none' stroke='#c77a3a' stroke-width='2'/><circle cx='8' cy='118' r='6.3' fill='none' stroke='#c77a3a' stroke-width='2'/></g><g class='a-spin rev' style='--d:7s;--dl:0s'><polygon points='26.0,150.0 23.6,153.1 23.1,157.1 19.1,157.6 16.0,160.0 12.9,157.6 8.9,157.1 8.4,153.1 6.0,150.0 8.4,146.9 8.9,142.9 12.9,142.4 16.0,140.0 19.1,142.4 23.1,142.9 23.6,146.9' fill='none' stroke='#c77a3a' stroke-width='2'/><circle cx='16' cy='150' r='3.5' fill='none' stroke='#c77a3a' stroke-width='2'/></g><g class='a-spin rev' style='--d:10s;--dl:0s'><polygon points='408.0,132.0 404.3,136.5 404.3,142.3 398.6,143.4 394.8,147.8 389.7,144.9 384.0,145.9 381.9,140.4 377.0,137.5 378.9,132.0 377.0,126.5 381.9,123.6 384.0,118.1 389.7,119.1 394.8,116.2 398.6,120.6 404.3,121.7 404.3,127.5' fill='none' stroke='#c77a3a' stroke-width='2'/><circle cx='392' cy='132' r='5.6' fill='none' stroke='#c77a3a' stroke-width='2'/></g><g class='a-zap' style='--d:3s;--dl:0s'><polyline points='20,60 10,73 19,86 27,99 20,111 20,124 18,137 23,150' fill='none' stroke='#8fd0ff' stroke-width='2' filter='url(#glt)'/></g><g class='a-zap' style='--d:3.7s;--dl:-1.6s'><polyline points='382,60 395,71 407,83 395,94 383,106 393,117 399,129 404,140' fill='none' stroke='#ffb070' stroke-width='2' filter='url(#glt)'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><defs><filter id='glb' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='2.5' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-zap' style='--d:2.6s;--dl:-0.5s'><polyline points='80,120 73,130 74,140 70,150 73,160 77,170 65,180 51,190' fill='none' stroke='#8fd0ff' stroke-width='2' filter='url(#glb)'/></g><g class='a-zap' style='--d:3.1s;--dl:-2s'><polyline points='320,110 313,121 301,133 299,144 289,156 277,167 274,179 286,190' fill='none' stroke='#ff8a4d' stroke-width='2' filter='url(#glb)'/></g></svg>"}, "bg": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><g class='a-swing' style='--d:4.0s;--dl:-0.5s'><path d='M15 0 q4 30 -2 65' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:4.6s;--dl:-2.0s'><path d='M46 0 q4 30 -2 56' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:5.2s;--dl:0.0s'><path d='M77 0 q4 30 -2 87' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:5.8s;--dl:-1.5s'><path d='M108 0 q4 30 -2 78' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:6.4s;--dl:-3.0s'><path d='M139 0 q4 30 -2 69' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:4.0s;--dl:-1.0s'><path d='M170 0 q4 30 -2 60' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:4.6s;--dl:-2.5s'><path d='M201 0 q4 30 -2 51' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:5.2s;--dl:-0.5s'><path d='M232 0 q4 30 -2 82' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:5.8s;--dl:-2.0s'><path d='M263 0 q4 30 -2 73' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:6.4s;--dl:0.0s'><path d='M294 0 q4 30 -2 64' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:4.0s;--dl:-1.5s'><path d='M325 0 q4 30 -2 55' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:4.6s;--dl:-3.0s'><path d='M356 0 q4 30 -2 86' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g><g class='a-swing' style='--d:5.2s;--dl:-1.0s'><path d='M387 0 q4 30 -2 77' stroke='#5b6b2a' stroke-width='2' fill='none' opacity='.8'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><defs><filter id='glb' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='3' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter></defs><g class='a-sway' style='--d:3.5s;--dl:0.0s'><path d='M24.6 189.0 L25.7 172.8 L34.3 172.8 L35.4 189.0Z' fill='#cfc6a8'/><path d='M13.8 174.6 Q30.0 149.4 46.2 174.6Z' fill='#6b4f8a' filter=\"url(#glb)\"/></g><g class='a-pulse' style='--d:3.0s;--dl:0s'><circle cx='30' cy='162.0' r='18.0' fill='#6b4f8a' opacity='.25' filter='url(#glb)'/></g><g class='a-sway' style='--d:4.0s;--dl:-0.8s'><path d='M54.7 189.0 L55.4 179.1 L60.6 179.1 L61.3 189.0Z' fill='#cfc6a8'/><path d='M48.1 180.2 Q58.0 164.8 67.9 180.2Z' fill='#9a7bb8' filter=\"url(#glb)\"/></g><g class='a-sway' style='--d:4.5s;--dl:-1.6s'><path d='M85.8 189.0 L86.6 176.4 L93.4 176.4 L94.2 189.0Z' fill='#cfc6a8'/><path d='M77.4 177.8 Q90.0 158.2 102.6 177.8Z' fill='#b7c95a' filter=\"url(#glb)\"/></g><g class='a-pulse' style='--d:3.6s;--dl:-2s'><circle cx='90' cy='168.0' r='14.0' fill='#b7c95a' opacity='.25' filter='url(#glb)'/></g><g class='a-sway' style='--d:5.0s;--dl:-2.4000000000000004s'><path d='M295.2 189.0 L296.2 174.6 L303.8 174.6 L304.8 189.0Z' fill='#cfc6a8'/><path d='M285.6 176.2 Q300.0 153.8 314.4 176.2Z' fill='#6b4f8a' filter=\"url(#glb)\"/></g><g class='a-sway' style='--d:5.5s;--dl:-3.2s'><path d='M327.0 189.0 L327.6 180.0 L332.4 180.0 L333.0 189.0Z' fill='#cfc6a8'/><path d='M321.0 181.0 Q330.0 167.0 339.0 181.0Z' fill='#b7c95a' filter=\"url(#glb)\"/></g><g class='a-pulse' style='--d:4.2s;--dl:-4s'><circle cx='330' cy='174.0' r='10.0' fill='#b7c95a' opacity='.25' filter='url(#glb)'/></g><g class='a-sway' style='--d:6.0s;--dl:-4.0s'><path d='M354.0 189.0 L355.2 171.0 L364.8 171.0 L366.0 189.0Z' fill='#cfc6a8'/><path d='M342.0 173.0 Q360.0 145.0 378.0 173.0Z' fill='#8a6aa8' filter=\"url(#glb)\"/></g><g class='a-sway' style='--d:6.5s;--dl:-4.800000000000001s'><path d='M382.0 189.0 L382.6 180.0 L387.4 180.0 L388.0 189.0Z' fill='#cfc6a8'/><path d='M376.0 181.0 Q385.0 167.0 394.0 181.0Z' fill='#b7c95a' filter=\"url(#glb)\"/></g><g class='a-pulse' style='--d:4.8s;--dl:-6s'><circle cx='385' cy='174.0' r='10.0' fill='#b7c95a' opacity='.25' filter='url(#glb)'/></g><path d='M200.0 176.0 c-5.6 0 -8.8 4.0 -8.8 8.0 c0 3.2 1.6 4.8 3.2 5.6 v3.2 h11.2 v-3.2 c1.6 -0.8 3.2 -2.4 3.2 -5.6 c0 -4.0 -3.2 -8.0 -8.8 -8.0z' fill='#b8b39a'/><circle cx='196.8' cy='184.8' r='2.1' fill='#1a1a0e'/><circle cx='203.2' cy='184.8' r='2.1' fill='#1a1a0e'/><g class='a-jaw' style='--d:3.2s;--dl:-2s'><path d='M195.2 188.0 h9.6 v2.4 q-4.8 2.4 -9.6 0z' fill='#b8b39a'/><line x1='196.8' y1='188.0' x2='196.8' y2='190.0' stroke='#1a1a0e' stroke-width='0.4'/><line x1='199.0' y1='188.0' x2='199.0' y2='190.0' stroke='#1a1a0e' stroke-width='0.4'/><line x1='201.1' y1='188.0' x2='201.1' y2='190.0' stroke='#1a1a0e' stroke-width='0.4'/><line x1='203.3' y1='188.0' x2='203.3' y2='190.0' stroke='#1a1a0e' stroke-width='0.4'/></g></svg>"}, "rw": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><g class='a-flutter' style='--d:2.4s;--dl:0s'><path d='M16 6 h34 v110 l-17.0 -19.8 l-17.0 19.8Z' fill='#a8301c' stroke='#e6b84a' stroke-width='1.5'/><line x1='12' y1='6' x2='54' y2='6' stroke='#e6b84a' stroke-width='3'/></g><g class='a-flutter' style='--d:2.8s;--dl:-1s'><path d='M350 6 h34 v110 l-17.0 -19.8 l-17.0 19.8Z' fill='#a8301c' stroke='#e6b84a' stroke-width='1.5'/><line x1='346' y1='6' x2='388' y2='6' stroke='#e6b84a' stroke-width='3'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-flicker' style='--d:1.18s;--dl:-0.77s'><path d='M-4.2 190 Q-7.0 175.6 12.8 161.2 Q26.0 175.6 23.3 190Z' fill='#7a2a10' opacity='0.90'/><path d='M-1.5 190 Q-3.7 178.8 10.1 167.5 Q22.7 178.8 20.5 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.29s;--dl:-0.62s'><path d='M17.8 190 Q14.4 168.7 36.8 147.4 Q54.8 168.7 51.4 190Z' fill='#7a2a10' opacity='0.90'/><path d='M21.1 190 Q18.4 173.4 35.9 156.8 Q50.7 173.4 48.0 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.13s;--dl:-0.08s'><path d='M36.0 190 Q32.4 176.7 51.2 163.4 Q75.4 176.7 71.8 190Z' fill='#7a2a10' opacity='0.90'/><path d='M39.5 190 Q36.7 179.6 55.1 169.2 Q71.1 179.6 68.2 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.21s;--dl:-1.03s'><path d='M75.6 190 Q71.8 178.3 97.3 166.6 Q117.4 178.3 113.6 190Z' fill='#7a2a10' opacity='0.90'/><path d='M79.4 190 Q76.4 180.9 92.3 171.7 Q112.8 180.9 109.8 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.39s;--dl:-0.07s'><path d='M89.7 190 Q87.0 169.5 106.4 149.1 Q119.2 169.5 116.6 190Z' fill='#7a2a10' opacity='0.90'/><path d='M92.4 190 Q90.2 174.0 104.6 158.1 Q116.0 174.0 113.9 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.29s;--dl:-0.42s'><path d='M115.9 190 Q112.5 170.2 130.4 150.5 Q153.4 170.2 150.0 190Z' fill='#7a2a10' opacity='0.90'/><path d='M119.3 190 Q116.6 174.6 136.0 159.2 Q149.3 174.6 146.6 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:0.98s;--dl:-0.03s'><path d='M138.1 190 Q135.0 169.6 155.0 149.1 Q172.3 169.6 169.2 190Z' fill='#7a2a10' opacity='0.90'/><path d='M141.2 190 Q138.7 174.1 153.6 158.1 Q168.6 174.1 166.1 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.08s;--dl:-1.23s'><path d='M160.4 190 Q156.8 172.4 177.8 154.9 Q199.9 172.4 196.3 190Z' fill='#7a2a10' opacity='0.90'/><path d='M164.0 190 Q161.1 176.3 180.3 162.6 Q195.6 176.3 192.7 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.3s;--dl:-1.22s'><path d='M202.8 190 Q200.1 174.3 212.9 158.6 Q232.6 174.3 229.9 190Z' fill='#7a2a10' opacity='0.90'/><path d='M205.5 190 Q203.4 177.8 212.7 165.5 Q229.4 177.8 227.2 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.16s;--dl:-1.05s'><path d='M226.3 190 Q222.8 177.2 240.8 164.5 Q264.7 177.2 261.2 190Z' fill='#7a2a10' opacity='0.90'/><path d='M229.8 190 Q227.0 180.1 246.9 170.1 Q260.5 180.1 257.7 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.01s;--dl:-1.03s'><path d='M246.4 190 Q242.6 173.0 268.9 156.0 Q287.9 173.0 284.1 190Z' fill='#7a2a10' opacity='0.90'/><path d='M250.1 190 Q247.1 176.7 263.2 163.5 Q283.3 176.7 280.3 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:0.85s;--dl:-0.96s'><path d='M276.1 190 Q272.9 173.1 295.7 156.2 Q311.0 173.1 307.9 190Z' fill='#7a2a10' opacity='0.90'/><path d='M279.3 190 Q276.8 176.8 290.2 163.6 Q307.2 176.8 304.7 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.32s;--dl:-1.05s'><path d='M292.0 190 Q289.0 166.4 310.3 142.8 Q324.9 166.4 321.9 190Z' fill='#7a2a10' opacity='0.90'/><path d='M295.0 190 Q292.6 171.6 306.0 153.2 Q321.3 171.6 318.9 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.17s;--dl:-0.09s'><path d='M329.6 190 Q326.8 175.8 339.5 161.6 Q359.8 175.8 357.0 190Z' fill='#7a2a10' opacity='0.90'/><path d='M332.3 190 Q330.1 178.9 340.7 167.9 Q356.5 178.9 354.3 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.17s;--dl:-0.17s'><path d='M342.3 190 Q339.5 171.0 354.6 151.9 Q372.3 171.0 369.6 190Z' fill='#7a2a10' opacity='0.90'/><path d='M345.0 190 Q342.8 175.1 353.8 160.3 Q369.0 175.1 366.9 190Z' fill='#d8561a' opacity='0.82'/></g><g class='a-flicker' style='--d:1.38s;--dl:-1.25s'><path d='M382.1 190 Q378.5 170.5 400.4 151.0 Q421.4 170.5 417.8 190Z' fill='#7a2a10' opacity='0.90'/><path d='M385.7 190 Q382.8 174.8 399.9 159.6 Q417.1 174.8 414.2 190Z' fill='#d8561a' opacity='0.82'/></g></svg>"}, "gu": {"top": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 170' width='400' height='170'><g class='a-pulse' style='--d:4s;--dl:0s'><circle cx='12' cy='120' r='12' fill='#5fe3b0' fill-opacity='.12' stroke='#5fe3b0' stroke-opacity='.6'/><circle cx='15.0' cy='117.6' r='3.6' fill='#5fe3b0' opacity='.45'/></g><g class='a-pulse' style='--d:3s;--dl:-1s'><circle cx='20' cy='150' r='6' fill='#5fe3b0' fill-opacity='.12' stroke='#5fe3b0' stroke-opacity='.6'/><circle cx='21.5' cy='148.8' r='1.8' fill='#5fe3b0' opacity='.45'/></g><g class='a-pulse' style='--d:5s;--dl:-2s'><circle cx='388' cy='130' r='13' fill='#4fc3f7' fill-opacity='.12' stroke='#4fc3f7' stroke-opacity='.6'/><circle cx='391.2' cy='127.4' r='3.9' fill='#4fc3f7' opacity='.45'/></g><g class='a-pulse' style='--d:3.4s;--dl:-0.5s'><circle cx='380' cy='160' r='5' fill='#4fc3f7' fill-opacity='.12' stroke='#4fc3f7' stroke-opacity='.6'/><circle cx='381.2' cy='159.0' r='1.5' fill='#4fc3f7' opacity='.45'/></g></svg>", "bot": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 190' width='400' height='190'><g class='a-sway' style='--d:5s;--dl:0s'><path d='M20 190 Q28.0 180.6 27.5 171.2 Q35.5 161.9 15.6 152.5 Q23.6 143.1 10.2 133.8 Q18.2 124.4 19.2 115.0 Q27.2 105.6 29.4 96.2 Q37.4 86.9 25.8 77.5 Q33.8 68.1 13.7 58.8 Q21.7 49.4 10.8 40.0' stroke='#2e8a62' stroke-width='3' fill='none'/><path d='M27.5 171.2 Q22.8 166.9 16.8 169.3 Q21.5 173.7 27.5 171.2Z' fill='#2e8a62' opacity='0.85'/><path d='M15.6 152.5 Q23.1 154.0 27.7 147.8 Q20.1 146.3 15.6 152.5Z' fill='#2e8a62' opacity='0.85'/><path d='M10.2 133.8 Q4.3 129.4 -2.1 132.9 Q3.8 137.3 10.2 133.8Z' fill='#2e8a62' opacity='0.85'/><path d='M19.2 115.0 Q25.1 116.0 28.6 111.1 Q22.6 110.0 19.2 115.0Z' fill='#2e8a62' opacity='0.85'/><path d='M29.4 96.2 Q25.1 88.7 16.5 89.4 Q20.8 97.0 29.4 96.2Z' fill='#2e8a62' opacity='0.85'/><path d='M25.8 77.5 Q22.0 71.8 15.2 72.8 Q19.0 78.6 25.8 77.5Z' fill='#2e8a62' opacity='0.85'/><path d='M13.7 58.8 Q20.0 58.1 22.0 52.1 Q15.8 52.8 13.7 58.8Z' fill='#2e8a62' opacity='0.85'/><path d='M10.8 40.0 Q8.8 34.3 2.8 33.8 Q4.8 39.5 10.8 40.0Z' fill='#2e8a62' opacity='0.85'/></g><g class='a-sway' style='--d:4.4s;--dl:-1.6s'><path d='M48 190 Q56.0 183.1 46.4 176.2 Q54.4 169.4 38.1 162.5 Q46.1 155.6 44.3 148.8 Q52.3 141.9 55.9 135.0 Q63.9 128.1 56.0 121.2 Q64.0 114.4 44.3 107.5 Q52.3 100.6 38.1 93.8 Q46.1 86.9 46.3 80.0' stroke='#3aa07a' stroke-width='3' fill='none'/><path d='M46.4 176.2 Q38.9 170.7 30.7 175.2 Q38.2 180.8 46.4 176.2Z' fill='#3aa07a' opacity='0.85'/><path d='M38.1 162.5 Q34.7 156.1 27.5 156.5 Q30.9 162.9 38.1 162.5Z' fill='#3aa07a' opacity='0.85'/><path d='M44.3 148.8 Q52.6 149.1 56.4 141.8 Q48.1 141.4 44.3 148.8Z' fill='#3aa07a' opacity='0.85'/><path d='M55.9 135.0 Q52.2 129.5 45.6 130.6 Q49.3 136.1 55.9 135.0Z' fill='#3aa07a' opacity='0.85'/><path d='M56.0 121.2 Q62.2 123.3 66.6 118.5 Q60.4 116.5 56.0 121.2Z' fill='#3aa07a' opacity='0.85'/><path d='M44.3 107.5 Q52.9 109.7 58.4 102.9 Q49.9 100.7 44.3 107.5Z' fill='#3aa07a' opacity='0.85'/><path d='M38.1 93.8 Q44.7 97.4 50.7 92.9 Q44.1 89.3 38.1 93.8Z' fill='#3aa07a' opacity='0.85'/><path d='M46.3 80.0 Q55.2 81.8 60.5 74.4 Q51.7 72.7 46.3 80.0Z' fill='#3aa07a' opacity='0.85'/></g><g class='a-sway' style='--d:5.6s;--dl:-2.4s'><path d='M372 190 Q380.0 180.0 362.8 170.0 Q370.8 160.0 365.7 150.0 Q373.7 140.0 377.8 130.0 Q385.8 120.0 381.4 110.0 Q389.4 100.0 371.2 90.0 Q379.2 80.0 362.2 70.0 Q370.2 60.0 367.5 50.0 Q375.5 40.0 379.4 30.0' stroke='#2e8a62' stroke-width='3' fill='none'/><path d='M362.8 170.0 Q358.2 165.0 351.8 167.1 Q356.4 172.1 362.8 170.0Z' fill='#2e8a62' opacity='0.85'/><path d='M365.7 150.0 Q361.3 143.2 353.3 144.4 Q357.7 151.2 365.7 150.0Z' fill='#2e8a62' opacity='0.85'/><path d='M377.8 130.0 Q386.9 130.5 391.2 122.4 Q382.1 121.9 377.8 130.0Z' fill='#2e8a62' opacity='0.85'/><path d='M381.4 110.0 Q388.0 111.7 392.2 106.4 Q385.7 104.7 381.4 110.0Z' fill='#2e8a62' opacity='0.85'/><path d='M371.2 90.0 Q378.7 92.5 384.1 86.7 Q376.6 84.2 371.2 90.0Z' fill='#2e8a62' opacity='0.85'/><path d='M362.2 70.0 Q359.7 64.0 353.2 63.8 Q355.7 69.8 362.2 70.0Z' fill='#2e8a62' opacity='0.85'/><path d='M367.5 50.0 Q363.5 43.3 355.8 44.1 Q359.7 50.8 367.5 50.0Z' fill='#2e8a62' opacity='0.85'/><path d='M379.4 30.0 Q375.0 25.7 369.2 27.8 Q373.6 32.2 379.4 30.0Z' fill='#2e8a62' opacity='0.85'/></g><g class='a-swim' style='--d:14s;--dl:-4s'><path d='M-30.0 150.0 q7.2 -4.5 14.4 0 q-7.2 4.5 -14.4 0 Z M-15.6 150.0 l4.5 -3.6 l0 7.2Z' fill='#2a8f7a'/></g></svg>"}};
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
  const da = $('#decoAnim');
  if (da) {
    const an = THEME_ANIM[t] || {};
    da.innerHTML = (an.top ? an.top.replace('<svg ', '<svg class="da-top" ') : '') + (an.bot ? an.bot.replace('<svg ', '<svg class="da-bot" ') : '') + (an.side || '');
    const fr = $('#frame');
    if (fr) fr.innerHTML = an.frame || '';
  }
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
