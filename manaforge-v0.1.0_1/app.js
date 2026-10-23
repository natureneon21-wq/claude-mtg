'use strict';
/* Manaforge – MTG-Sammlung & Deckbau (Prototyp) */
const APP_VERSION = '0.1.0';

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
      const r = indexedDB.open('manaforge', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('collection', { keyPath: 'key' });
        d.createObjectStore('cards', { keyPath: 'id' });
        d.createObjectStore('decks', { keyPath: 'id' });
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
  clear(store) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
};

const Settings = {
  defaults: { geminiKey: '', geminiModel: 'gemini-flash-latest', unlimitedBasics: true, limitedMaxCopies: 4 },
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
  filter: { q: '', colors: [], type: '', sort: 'name', limit: 150 },
  build: { format: 'casual60', colorMode: 'dual', colors: [], arch: 'auto', forced: '' },
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
      foil, qty: Number.isFinite(qty) && qty > 0 ? qty : 1, lang: get('lang'), cond: get('cond'),
    };
    e.key = e.sid ? `${e.sid}|${foil ? 'f' : 'n'}` : `${name.toLowerCase()}|${e.set}|${e.number}|${foil ? 'f' : 'n'}`;
    const ex = map.get(e.key);
    if (ex) ex.qty += e.qty; else map.set(e.key, e);
  }
  return [...map.values()];
}

/* ============================================================
   Scryfall
   ============================================================ */
const LEG_KEYS = ['standard', 'pioneer', 'modern', 'pauper', 'legacy', 'vintage', 'commander'];
function slimCard(c) {
  const faces = c.card_faces || [];
  const f0 = faces[0] || {};
  const img = c.image_uris || f0.image_uris || {};
  const leg = {}; LEG_KEYS.forEach(k => leg[k] = c.legalities?.[k] || 'not_legal');
  return {
    id: c.id, oid: c.oracle_id || f0.oracle_id, name: c.name, printed: c.printed_name || f0.printed_name || '',
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
};
const maxCopies = (F) => F.max ?? (+Settings.get('limitedMaxCopies') || 99);
const CURVE = { // Anteile der Zauber je Manawert 1,2,3,4,5,6+
  aggro: [0.2, 0.36, 0.26, 0.12, 0.06, 0],
  midrange: [0.08, 0.27, 0.25, 0.2, 0.12, 0.08],
  control: [0.06, 0.22, 0.24, 0.2, 0.15, 0.13],
};
const CREATURE_FRAC = { aggro: 0.6, midrange: 0.45, control: 0.22 };
const bucketOf = (cmc) => Math.max(0, Math.min(5, Math.round(cmc) - 1));

/** Fasst die Sammlung nach Kartennamen zusammen */
function buildPool() {
  const pool = new Map();
  for (const e of state.collection) {
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
  const unlimited = Settings.get('unlimitedBasics');
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
    score: Math.round(Math.max(0, Math.min(100, score * 11))), created: Date.now(),
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
      if (!best || d.score > best.score) best = d;
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
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
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
  return validateAIDeck(r, { format, colors, arch: archUse, pool });
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
  const pool = buildPool();
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
  back.className = 'sheet-back';
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
  const total = state.collection.reduce((s, e) => s + e.qty, 0);
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
   Sammlung
   ============================================================ */
function grouped() {
  if (state.grouped) return state.grouped;
  const g = new Map();
  for (const e of state.collection) {
    const c = e.sid && state.cards.get(e.sid);
    const name = c ? c.name : e.name;
    let x = g.get(name);
    if (!x) { x = { name, card: c || null, qty: 0, foil: 0, entries: [] }; g.set(name, x); }
    x.qty += e.qty; if (e.foil) x.foil += e.qty; x.entries.push(e);
    if ((!x.card || !x.card.img) && c) x.card = c;
  }
  return (state.grouped = [...g.values()]);
}

function filteredCollection() {
  const f = state.filter, q = f.q.trim().toLowerCase();
  let list = grouped().filter(x => {
    const c = x.card;
    if (q && !(x.name.toLowerCase().includes(q) || (c?.printed || '').toLowerCase().includes(q) || (c?.type || '').toLowerCase().includes(q))) return false;
    if (f.colors.length) {
      if (!c) return false;
      const cols = analyze(c).isLand ? c.ci : c.colors;
      const ok = f.colors.some(fc => fc === 'M' ? cols.length > 1 : fc === 'C' ? cols.length === 0 : cols.includes(fc));
      if (!ok) return false;
    }
    if (f.type) { if (!c || !new RegExp(f.type).test(c.type)) return false; }
    return true;
  });
  const price = (x) => parseFloat(x.card?.eur || 0) * x.qty;
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    cmc: (a, b) => (a.card?.cmc ?? 99) - (b.card?.cmc ?? 99) || a.name.localeCompare(b.name),
    qty: (a, b) => b.qty - a.qty || a.name.localeCompare(b.name),
    price: (a, b) => price(b) - price(a),
  };
  return list.sort(sorters[f.sort]);
}

function renderCollection() {
  const main = $('#main');
  if (!state.collection.length) {
    main.innerHTML = `<div class="empty">
      <svg class="art" viewBox="0 0 120 120"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3dfa8"/><stop offset="1" stop-color="#a8843f"/></linearGradient></defs>
      <rect x="30" y="18" width="52" height="74" rx="7" fill="#251d32" stroke="url(#g1)" stroke-width="3" transform="rotate(-10 56 55)"/>
      <rect x="40" y="24" width="52" height="74" rx="7" fill="#1d1727" stroke="url(#g1)" stroke-width="3" transform="rotate(8 66 61)"/>
      <circle cx="66" cy="60" r="11" fill="none" stroke="url(#g1)" stroke-width="3"/><path d="M66 44v7M66 69v7M50 60h7M75 60h7" stroke="url(#g1)" stroke-width="3" stroke-linecap="round"/></svg>
      <h2>Deine Sammlung ist noch leer</h2>
      <p>Importiere deinen ManaBox-Export. Danach baut dir Manaforge Decks aus den Karten, die du wirklich besitzt.</p>
      <button class="btn primary" data-act="import">ManaBox-CSV importieren</button>
      <div class="panel" style="margin-top:22px;text-align:left"><h3 style="margin-bottom:6px">So exportierst du aus ManaBox</h3>
      <ol class="how small"><li>ManaBox öffnen → <b>Sammlung</b> (oder einen Binder)</li><li>Menü <b>⋮</b> → <b>Exportieren</b> → <b>CSV</b></li><li>Datei speichern oder direkt teilen</li><li>Hier auf „importieren“ tippen und die Datei auswählen</li></ol></div>
    </div>`;
    return;
  }
  const g = grouped();
  const total = state.collection.reduce((s, e) => s + e.qty, 0);
  const value = state.collection.reduce((s, e) => s + (parseFloat(state.cards.get(e.sid)?.eur) || 0) * e.qty, 0);
  const missing = state.collection.filter(e => !e.sid || !state.cards.has(e.sid)).length;
  const f = state.filter;
  const fc = (v, label) => `<button class="fchip ${f.colors.includes(v) ? 'on' : ''}" data-fcolor="${v}">${label}</button>`;
  main.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${total}</b><span>Karten</span></div>
      <div class="stat"><b>${g.length}</b><span>verschiedene</span></div>
      <div class="stat"><b>${value ? Math.round(value) + ' €' : '–'}</b><span>Wert (ca.)</span></div>
    </div>
    ${missing ? `<div class="panel small row"><span class="chip warn">${missing}</span><span class="grow">Einträge ohne Kartendaten. <a href="#" data-act="refetch">Jetzt nachladen</a></span></div>` : ''}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Karte, Typ suchen …" value="${esc(f.q)}" class="grow">
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
}

function renderGrid() {
  const list = filteredCollection();
  const shown = list.slice(0, state.filter.limit);
  $('#gridWrap').innerHTML = `
    <div class="tiny muted" style="margin-top:8px">${list.length} Treffer</div>
    <div class="grid">${shown.map(x => `<div class="tile" data-card="${esc(x.name)}">${imgTag(x.card || { name: x.name })}<span class="qty">${x.qty}×</span>${x.foil ? '<span class="foil">FOIL</span>' : ''}</div>`).join('')}</div>
    ${list.length > shown.length ? `<button class="btn block" style="margin-top:12px" id="more">Weitere ${Math.min(150, list.length - shown.length)} anzeigen</button>` : ''}`;
  $('#more')?.addEventListener('click', () => { state.filter.limit += 150; renderGrid(); });
}

/* Kartendetails */
function decksUsing(name) { return state.decks.filter(d => d.cards.some(c => c.name === name)); }

function openCard(name) {
  const x = grouped().find(g => g.name === name);
  const c = x?.card || state.decks.flatMap(d => d.cards).filter(k => k.name === name).map(k => cardById(k.sid)).find(Boolean);
  if (!c) { toast('Keine Kartendaten vorhanden'); return; }
  const legal = ['standard', 'pioneer', 'modern', 'pauper'].map(k => `<span class="chip ${c.leg?.[k] === 'legal' ? 'good' : 'bad'}">${FORMATS[k].label}</span>`).join(' ');
  const used = decksUsing(name);
  const body = openSheet(`
    <div class="row" style="justify-content:flex-end;margin-bottom:6px"><button class="iconbtn" data-close>${ICON.close}</button></div>
    <div id="cimgWrap">${c.img ? `<img class="cardimg" id="cimg" src="${esc(c.img)}" alt="${esc(c.name)}">` : ''}</div>
    ${c.imgBack ? '<p class="center tiny muted" style="text-align:center">Tippe aufs Bild zum Umdrehen</p>' : ''}
    <div class="row" style="margin-top:14px"><h2 class="grow">${esc(c.name)}</h2>${manaHTML(c.mana)}</div>
    ${c.printed && c.printed !== c.name ? `<div class="muted small">${esc(c.printed)}</div>` : ''}
    <div class="muted small" style="margin:4px 0 10px">${esc(c.type)}</div>
    ${c.text ? `<div class="oracle">${esc(c.text)}</div>` : ''}
    <div class="row wrap" style="margin:12px 0">${legal}</div>
    ${x ? `<h3 style="margin:16px 0 6px">Deine Exemplare (${x.qty})</h3>
      ${x.entries.map(e => { const k = state.cards.get(e.sid); return `<div class="kv small"><span>${esc(k?.setName || e.setName || e.set.toUpperCase())} #${esc(k?.num || e.number)}${e.foil ? ' · <b style="color:#f6a">Foil</b>' : ''}${e.lang ? ' · ' + esc(e.lang) : ''}</span><b>${e.qty}×</b></div>`; }).join('')}` : ''}
    ${used.length ? `<h3 style="margin:16px 0 6px">In Decks</h3>${used.map(d => `<div class="kv small"><span>${esc(d.name)}</span><b>${d.cards.find(k => k.name === name).n}×</b></div>`).join('')}` : ''}
    ${x && !analyze(c).isLand ? `<button class="btn block primary" style="margin-top:16px" data-around>Deck um diese Karte bauen</button>` : ''}
  `);
  body.querySelector('[data-close]').onclick = closeSheet;
  const img = body.querySelector('#cimg');
  if (img && c.imgBack) { let back = false; img.onclick = () => { back = !back; img.src = back ? c.imgBack : c.img; }; }
  body.querySelector('[data-around]')?.addEventListener('click', () => {
    state.build.forced = c.name; state.build.colorMode = 'all'; state.view = 'build';
    closeAllSheets();
    render(); window.scrollTo(0, 0);
  });
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-card]');
  if (t) { openCard(t.dataset.card); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.act === 'import') $('#csvInput').click();
  if (a.dataset.act === 'refetch') refetchCards();
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
  if (!state.collection.length) return doImport(entries, 'replace');
  const body = openSheet(`<h2>Import</h2>
    <p class="muted">${entries.length} Einträge mit insgesamt <b>${total}</b> Karten erkannt.</p>
    <button class="btn primary block" data-m="replace">Sammlung ersetzen</button>
    <p class="tiny muted" style="margin:4px 2px 12px">Empfohlen, wenn du deine komplette ManaBox-Sammlung exportiert hast.</p>
    <button class="btn block" data-m="merge">Zur Sammlung hinzufügen</button>
    <p class="tiny muted" style="margin:4px 2px">Für einzelne Binder oder Neuzugänge.</p>`);
  body.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { closeSheet(); doImport(entries, b.dataset.m); });
});

async function doImport(entries, mode) {
  let coll;
  if (mode === 'merge') {
    const m = new Map(state.collection.map(e => [e.key, { ...e }]));
    for (const e of entries) { const x = m.get(e.key); if (x) x.qty += e.qty; else m.set(e.key, e); }
    coll = [...m.values()];
  } else coll = entries;
  overlay(spinnerHTML('Lade Kartendaten von Scryfall …', 'Bei großen Sammlungen kann das etwas dauern.'));
  let notFound = [], offline = false;
  try {
    notFound = await enrichFromScryfall(coll, (d, t, pass) =>
      overlay(spinnerHTML(pass ? 'Zweiter Versuch über Kartennamen …' : 'Lade Kartendaten von Scryfall …', `${d} / ${t}<div class="bar"><i style="width:${Math.round(d / t * 100)}%"></i></div>`)));
  } catch (e) { offline = true; console.warn(e); }
  await DB.clear('collection'); await DB.putMany('collection', coll);
  state.collection = coll; state.grouped = null;
  overlay(); state.view = 'collection'; render();
  const total = coll.reduce((s, e) => s + e.qty, 0);
  if (offline) toast('Scryfall nicht erreichbar – Kartendaten später nachladen (Einstellungen).', 6000);
  else if (notFound.length) {
    const body = openSheet(`<h2>Import fertig</h2><p class="muted">${total} Karten importiert. ${notFound.length} Einträge wurden bei Scryfall nicht gefunden und werden beim Deckbau ignoriert:</p>
      <ul class="list-plain small">${notFound.slice(0, 60).map(e => `<li>${esc(e.name)} <span class="dim">(${esc(e.set.toUpperCase())} ${esc(e.number)})</span></li>`).join('')}</ul>
      <button class="btn block" style="margin-top:14px" data-close>OK</button>`);
    body.querySelector('[data-close]').onclick = closeSheet;
  } else toast(`Import fertig: ${total} Karten ✓`);
}

async function refetchCards() {
  overlay(spinnerHTML('Lade Kartendaten …'));
  try {
    const nf = await enrichFromScryfall(state.collection, (d, t) => overlay(spinnerHTML('Lade Kartendaten …', `${d} / ${t}`)));
    await DB.putMany('collection', state.collection);
    state.grouped = null;
    toast(nf.length ? `${nf.length} Einträge weiterhin nicht gefunden` : 'Alle Kartendaten geladen ✓');
  } catch { toast('Scryfall nicht erreichbar.'); }
  overlay(); render();
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
      <div class="filters" data-seg="format">${Object.entries(FORMATS).map(([k, F]) => `<button class="fchip ${b.format === k ? 'on' : ''}" data-v="${k}">${F.label}</button>`).join('')}</div>
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
      <button class="btn block" id="goAI" style="margin-top:8px;border-color:#33405e;color:#9ec1ff">✦ Mit Gemini bauen${hasKey ? '' : ' (API-Key fehlt)'}</button>
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
      ${d.score != null ? `<div class="bar"><i style="width:${d.score}%"></i></div>` : '<div class="tiny" style="color:#9ec1ff;margin-top:6px">✦ Gemini-Vorschlag</div>'}
      ${d.warnings.length ? `<div class="tiny" style="color:#f0b35a;margin-top:5px">⚠ ${esc(d.warnings[0])}</div>` : ''}
    </div>
  </div>`;
}

function resultsHTML() {
  if (!state.results.length) return '';
  const top = state.results.find(d => d.score != null);
  const thin = top && top.warnings.some(w => w.startsWith('Nur'));
  return `${thin ? `<div class="panel small" style="border-color:#5a4520;margin-top:16px">⚠ Für <b>${FORMATS[top.format].label}</b> hast du in diesen Farben nicht genug passende Karten für ein volles Deck. Probier „Casual 60“, „Limited 40“ oder andere Farben.</div>` : ''}
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
function isSaved(deck) { return state.decks.some(d => d.id === deck.id); }

function usageConflicts(deck) {
  const owned = new Map(grouped().map(x => [x.name, x.qty]));
  const out = new Map();
  for (const it of deck.cards) {
    const c = cardById(it.sid);
    if (c && analyze(c).isBasic && Settings.get('unlimitedBasics')) continue;
    const other = state.decks.filter(d => d.id !== deck.id).reduce((s, d) => s + (d.cards.find(k => k.name === it.name)?.n || 0), 0);
    if (other && other + it.n > (owned.get(it.name) || 0)) out.set(it.name, other);
  }
  return out;
}

function openDeck(deck) {
  const body = openSheet('', { full: true, onClose: () => { if (state.view === 'decks') renderDecks(); } });
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
    body.innerHTML = `
      <div class="shead"><button class="iconbtn" data-x>${ICON.back}</button><h2 class="grow" style="font-size:17px">${esc(deck.name)}</h2></div>
      <div class="row wrap" style="gap:6px">
        <span class="chip">${pipsHTML(deck.colors)}</span><span class="chip">${F.label}</span><span class="chip">${ARCH_DE[deck.arch] || deck.arch}</span>
        ${deck.score != null ? `<span class="chip good">Stärke ${deck.score}</span>` : ''}
        <span class="chip ${st.total === F.size ? 'good' : 'warn'}">${st.total}/${F.size}</span>
      </div>
      ${deck.warnings.map(w => `<div class="chip warn" style="margin-top:8px">⚠ ${esc(w)}</div>`).join(' ')}
      ${deck.missing?.length ? `<div class="small muted" style="margin-top:6px">Fehlt: ${deck.missing.map(m => `${m.n}× ${m.name}`).join(', ')}</div>` : ''}
      ${conflicts.size ? `<div class="panel small" style="border-color:#5a4520">⚠ ${conflicts.size} Karte(n) sind zusätzlich in anderen gespeicherten Decks verbaut und du besitzt nicht genug Exemplare für beide (markiert).</div>` : ''}
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
        <button class="btn" data-ai style="border-color:#33405e;color:#9ec1ff;grid-column:1/-1">✦ KI-Analyse</button>
      </div>
      ${order.filter(g => groups.has(g)).map(g => {
        const items = groups.get(g).sort((a, b) => (a.c?.cmc ?? 0) - (b.c?.cmc ?? 0) || a.it.name.localeCompare(b.it.name));
        return `<div class="group"><h3><span>${g}</span><span class="small muted">${items.reduce((s, x) => s + x.it.n, 0)}</span></h3>
          ${items.map(({ it, c }) => `<div class="crow ${conflicts.has(it.name) ? 'conflict' : ''}" data-cname="${esc(it.name)}">
            <span class="n">${it.n}</span><span class="nm">${esc(it.name)}${conflicts.has(it.name) ? ' <span class="tiny" style="color:#f0b35a">⚠</span>' : ''}</span>
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
        const owned = grouped().find(x => x.name === name)?.qty || 0;
        const lim = basic && Settings.get('unlimitedBasics') ? 99 : Math.min(owned, basic ? 99 : maxCopies(F));
        if (it.n >= lim) { toast(owned < maxCopies(F) && !basic ? `Du besitzt nur ${owned}×` : 'Maximum erreicht'); return; }
        it.n++;
      } else { it.n--; if (it.n <= 0) deck.cards = deck.cards.filter(c => c !== it); }
      deck.score = deck.score != null ? deck.score : null;
      if (isSaved(deck)) await DB.putMany('decks', [deck]);
      draw(); return;
    }
    const row = e.target.closest('[data-cname]');
    if (row && !edit) { openCard(row.dataset.cname); return; }
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
  const inG = grouped().find(x => x.card && (x.name.toLowerCase() === String(t.rein).toLowerCase() || x.name.split(' // ')[0].toLowerCase() === String(t.rein).toLowerCase()));
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
  main.innerHTML = `
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
      <div class="kv small"><span>Gespeicherte Decks</span><b>${state.decks.length}</b></div>
      <button class="btn block" style="margin-top:12px" data-act="import">ManaBox-CSV importieren</button>
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
async function init() {
  Settings.load();
  try {
    await DB.open();
    const [coll, cards, decks] = await Promise.all([DB.all('collection'), DB.all('cards'), DB.all('decks')]);
    state.collection = coll;
    cards.forEach(c => state.cards.set(c.id, c));
    state.decks = decks.sort((a, b) => b.created - a.created);
  } catch (e) {
    console.error(e);
    toast('Lokaler Speicher nicht verfügbar – Daten gehen beim Schließen verloren.', 6000);
    DB.putMany = DB.del = DB.clear = async () => {};
  }
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
}
init();
