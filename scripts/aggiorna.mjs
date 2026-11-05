// Concerti Italia — aggiornamento dati (eseguito da GitHub Actions)
// Node >= 20, nessuna dipendenza esterna.
// Legge le fonti, unisce gli stessi concerti, confronta i prezzi, invia gli avvisi
// e scrive i file statici in data/ letti dalla pagina.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const ENV = process.env;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const GEO_UA = 'ConcertiItalia/1.0 (aggiornamento automatico GitHub Actions)';

/* ---------------- utilità ---------------- */
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim();
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const log = (...a) => console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a);
function hash(s) { let h = 0x811c9dc5; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }
function haversine(a, b, c, d) { const R = 6371, r = x => x * Math.PI / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const num = v => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

async function readJson(file, def) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return def; } }
async function writeJson(file, obj, pretty = false) { await writeFile(file, JSON.stringify(obj, null, pretty ? 1 : 0) + '\n'); }

async function http(url, { json = true, headers = {}, retries = 2, method = 'GET', body } = {}) {
  for (let t = 0; ; t++) {
    let r;
    try {
      const h = json ? { Accept: 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site' }
        : { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' };
      r = await fetch(url, { method, body, redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.6', 'Cache-Control': 'no-cache', Pragma: 'no-cache',
        'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', ...h, ...headers }, signal: AbortSignal.timeout(30000) });
    } catch (e) { if (t < retries) { await sleep(1500 * (t + 1)); continue; } throw new Error('rete: ' + e.message); }
    if ((r.status === 429 || r.status >= 500) && t < retries) { await sleep(2000 * (t + 1)); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return json ? r.json() : r.text();
  }
}

/* ---------------- configurazione ---------------- */
async function loadConfig() {
  const cfg = await readJson(path.join(ROOT, 'config', 'config.json'), {});
  let artisti = [];
  try {
    artisti = (await readFile(path.join(ROOT, 'config', 'artisti.txt'), 'utf8')).split(/\r?\n/)
      .map(s => s.replace(/#.*/, '').trim()).filter(Boolean);
  } catch {}
  return { cfg, artisti: [...new Set(artisti)] };
}

/* ================= FONTE 1: TICKETMASTER ================= */
const TM = 'https://app.ticketmaster.com/discovery/v2/events.json';
function tmImage(imgs = []) {
  const c = imgs.filter(i => i.ratio === '16_9' && i.width >= 500 && i.width <= 1100);
  return (c[0] || [...imgs].sort((a, b) => b.width - a.width)[0] || {}).url || '';
}
export function tmNorm(ev) {
  const v = ev._embedded?.venues?.[0] || {};
  const at = ev._embedded?.attractions || [];
  const cl = ev.classifications?.[0] || {};
  const pr = ev.priceRanges?.[0];
  const st = ev.dates?.status?.code;
  return {
    id: 'tm:' + ev.id, src: 'tm', title: ev.name, artist: at[0]?.name || ev.name,
    date: ev.dates?.start?.localDate || '', time: (ev.dates?.start?.localTime || '').slice(0, 5),
    venue: v.name || '', city: v.city?.name || '', address: v.address?.line1 || '',
    lat: v.location ? +v.location.latitude : null, lon: v.location ? +v.location.longitude : null,
    priceMin: num(pr?.min), priceMax: num(pr?.max), currency: pr?.currency || 'EUR',
    url: ev.url || '', image: tmImage(ev.images),
    genre: [cl.genre?.name, cl.subGenre?.name].find(g => g && !/^(undefined|other)$/i.test(g)) || '',
    status: st === 'cancelled' ? 'Annullato' : st === 'postponed' ? 'Rinviato' : st === 'rescheduled' ? 'Riprogrammato' : '',
    onsale: ev.sales?.public?.startDateTime || ''
  };
}
async function fonteTicketmaster(cfg) {
  const key = ENV.TM_KEY;
  if (!key) throw new Error('secret TM_KEY non impostato');
  const out = new Map();
  const giorni = cfg.finestraGiorni || 365;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + giorni * 864e5);
  const iso = d => d.toISOString().slice(0, 19) + 'Z';
  let calls = 0;
  async function page(s, e, p) {
    const q = new URLSearchParams({ apikey: key, countryCode: 'IT', segmentId: 'KZFzniwnSyZfZ7v7nJ', size: '200', page: String(p), sort: 'date,asc', locale: '*', startDateTime: iso(s), endDateTime: iso(e) });
    calls++; await sleep(230);
    return http(TM + '?' + q, { retries: 4 });
  }
  async function window(s, e, depth = 0) {
    const first = await page(s, e, 0);
    const tot = first.page?.totalElements || 0;
    if (tot > 1000 && depth < 6 && e - s > 864e5) {
      const mid = new Date(s.getTime() + (e - s) / 2);
      await window(s, mid, depth + 1); await window(mid, e, depth + 1); return;
    }
    const add = j => (j._embedded?.events || []).forEach(ev => out.set(ev.id, tmNorm(ev)));
    add(first);
    const pages = Math.min(first.page?.totalPages || 0, 5);
    for (let p = 1; p < pages; p++) add(await page(s, e, p));
  }
  for (let s = new Date(start); s < end;) {
    const e = new Date(Math.min(end, new Date(s.getFullYear(), s.getMonth() + 1, 1)));
    await window(s, e); s = e;
  }
  log('Ticketmaster:', out.size, 'eventi in', calls, 'richieste');
  return [...out.values()];
}

/* ================= FONTE 2: TICKETONE (API pubblica Eventim) ================= */
const MUSICA = /concert|musica|music|rock|pop|jazz|blues|rap|hip.?hop|metal|indie|elettronic|electronic|dance|classica|lirica|opera|festival|cantautor|soul|funk|reggae|punk|folk|tribute|tour/i;
export function eventimNorm(p, src = 'to') {
  const le = p.typeAttributes?.liveEntertainment || {};
  const loc = le.location || {};
  const sd = le.startDate || '';
  const cats = (p.categories || []).map(c => c.name).filter(Boolean);
  return {
    id: src + ':' + (p.productId || p.productGroupId || hash(p.link || p.name + sd)), src, title: p.name || '',
    artist: p.attractions?.[0]?.name || p.name || '', date: sd.slice(0, 10), time: sd.slice(11, 16),
    venue: loc.name || '', city: loc.city || '', address: '',
    lat: num(loc.geoLocation?.latitude), lon: num(loc.geoLocation?.longitude),
    priceMin: num(p.price ?? p.priceMin), priceMax: num(p.priceMax), currency: 'EUR',
    url: p.link || (p.url ? (p.url.domain || '') + (p.url.path || '') : ''),
    image: p.imageUrl || p.image || '', genre: cats.find(c => !/^(concerti?|musica|music|altro|altri)$/i.test(c)) || '',
    status: p.inStock === false ? 'Esaurito' : '', onsale: '', _cats: cats
  };
}
const DIAG = { ticketone: [] };
async function fonteTicketone(cfg) {
  const c = { webId: 'web__ticketone-it', language: 'it', categorie: ['Concerti'], maxRichieste: 400, ...(cfg.ticketone || {}) };
  const base = 'https://public-api.eventim.com/websearch/search/api/exploration/v1/products';
  const H = { Origin: 'https://www.ticketone.it', Referer: 'https://www.ticketone.it/' };
  const res = new Map(); let calls = 0, pieni = 0;
  async function get(from, to, page = 1) {
    const q = new URLSearchParams({ webId: c.webId, language: c.language, page: String(page), top: '50', sort: 'DateAsc', date_from: from, date_to: to });
    for (const k of c.categorie || []) q.append('categories', k);
    calls++; await sleep(300);
    return http(base + '?' + q, { retries: 3, headers: H });
  }
  // l'API restituisce al massimo 50 prodotti e la paginazione non è affidabile:
  // si interroga per intervalli di date, dividendo quelli pieni fino al singolo giorno
  async function finestra(a, b) {
    if (calls >= c.maxRichieste) return;
    const from = ymd(a), to = ymd(b), j = await get(from, to);
    const prod = j.products || [];
    for (const pr of prod) { const e = eventimNorm(pr, 'to'); if (e.date) res.set(e.id, e); }
    if (prod.length < 50) return;
    const giorni = Math.round((b - a) / 864e5);
    if (giorni >= 1) { const mid = new Date(a.getTime() + Math.floor(giorni / 2) * 864e5); await finestra(a, mid); await finestra(new Date(mid.getTime() + 864e5), b); return; }
    pieni++; // giorno singolo con più di 50 eventi: prova le pagine successive
    for (let p = 2; p <= 4 && calls < c.maxRichieste; p++) { const k = res.size; const j2 = await get(from, to, p);
      for (const pr of j2.products || []) { const e = eventimNorm(pr, 'to'); if (e.date) res.set(e.id, e); } if (res.size === k) break; }
  }
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const fine = new Date(start.getTime() + (cfg.finestraGiorni || 365) * 864e5);
  for (let a = new Date(start); a < fine; a = new Date(a.getTime() + 30 * 864e5)) {
    const b = new Date(Math.min(fine.getTime(), a.getTime() + 29 * 864e5)); await finestra(a, b);
  }
  const ev = [...res.values()]; ev.forEach(e => delete e._cats);
  DIAG.ticketone = [{ richieste: calls, eventi: ev.length, giorniPieni: pieni }];
  log('TicketOne:', ev.length, 'eventi in', calls, 'richieste');
  if (!ev.length) throw new Error('nessun evento (categoria: ' + (c.categorie || []).join(', ') + ')');
  return ev;
}

/* ================= FONTE 3: BANDSINTOWN (artisti preferiti) ================= */
async function fonteBandsintown(cfg, artisti) {
  const id = ENV.BIT_APP_ID || cfg.bandsintown?.appId || 'concerti-italia';
  if (!artisti.length) throw new Error('nessun artista in config/artisti.txt');
  const out = [];
  for (const name of artisti) {
    const u = 'https://rest.bandsintown.com/artists/' + encodeURIComponent(name.replace(/\//g, '%252F')) + '/events?date=upcoming&app_id=' + encodeURIComponent(id);
    let j; try { j = await http(u, { retries: 1 }); } catch (e) { log('Bandsintown', name, e.message); if (/HTTP 40[13]/.test(e.message)) throw new Error(e.message + ': app_id non accettato, serve BIT_APP_ID'); continue; }
    if (!Array.isArray(j)) continue;
    for (const e of j) {
      if (!e.venue || !/^(italy|italia|it)$/i.test(e.venue.country || '')) continue;
      const [d, t = ''] = (e.datetime || '').split('T');
      const tk = (e.offers || []).find(o => /ticket/i.test(o.type)) || (e.offers || [])[0];
      out.push({ id: 'bit:' + e.id, src: 'bit', title: e.title || (e.lineup || []).join(', ') || name, artist: e.lineup?.[0] || name,
        date: d, time: t.slice(0, 5), venue: e.venue.name || '', city: e.venue.city || '', address: e.venue.street_address || '',
        lat: num(e.venue.latitude), lon: num(e.venue.longitude), priceMin: null, priceMax: null, currency: 'EUR',
        url: tk?.url || e.url, image: '', genre: '', status: tk?.status === 'sold out' ? 'Esaurito' : '', onsale: e.on_sale_datetime || '' });
    }
    await sleep(300);
  }
  log('Bandsintown:', out.length, 'date in Italia per', artisti.length, 'artisti');
  return out;
}

/* ================= FONTE 4: PAGINE CON DATI STRUTTURATI (Vivaticket, locali, festival) ================= */
export function extractJsonLd(html) {
  const blocks = []; const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    const raw = m[1].replace(/^\s*<!--/, '').replace(/-->\s*$/, '').trim();
    try { blocks.push(JSON.parse(raw)); } catch { try { blocks.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))); } catch {} }
  }
  const events = [], links = [];
  const walk = o => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const t = [].concat(o['@type'] || []).join(' ');
    if (/Event\b/.test(t) && o.startDate) events.push(o);
    if (/ListItem/.test(t) && typeof o.url === 'string') links.push(o.url);
    for (const k of ['@graph', 'itemListElement', 'subEvent', 'item', 'event', 'events', 'mainEntity']) if (o[k]) walk(o[k]);
  };
  blocks.forEach(walk);
  return { events, links };
}
const txt = v => (typeof v === 'string' ? v : Array.isArray(v) ? txt(v[0]) : v && typeof v === 'object' ? (v.name || v['@value'] || '') : '');
export function jsonLdNorm(o, src, pageUrl) {
  const loc = [].concat(o.location || [])[0] || {};
  const addr = typeof loc.address === 'string' ? { streetAddress: loc.address } : (loc.address || {});
  const country = txt(addr.addressCountry);
  if (country && !/^(it|ita|italy|italia)$/i.test(country)) return null;
  const offers = [].concat(o.offers || []).flatMap(x => x && x.offers ? [].concat(x.offers) : [x]).filter(Boolean);
  const prices = offers.flatMap(x => [num(x.lowPrice), num(x.price), num(x.highPrice)]).filter(Boolean);
  const sd = String(o.startDate || '');
  const perf = [].concat(o.performer || [])[0];
  let url = txt(o.url) || offers.find(x => x.url)?.url || pageUrl;
  try { url = new URL(url, pageUrl).href; } catch {}
  const sold = offers.length && offers.every(x => /SoldOut/i.test(x.availability || ''));
  const cancelled = /Cancelled/i.test(o.eventStatus || ''), postponed = /Postponed|Rescheduled/i.test(o.eventStatus || '');
  return {
    id: src + ':' + hash(url + '|' + sd), src, title: txt(o.name), artist: txt(perf) || txt(o.name),
    date: sd.slice(0, 10), time: /T\d\d:\d\d/.test(sd) ? sd.slice(11, 16) : '',
    venue: txt(loc.name), city: txt(addr.addressLocality) || txt(addr.addressRegion), address: txt(addr.streetAddress),
    lat: num(loc.geo?.latitude), lon: num(loc.geo?.longitude),
    priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
    currency: offers.find(x => x.priceCurrency)?.priceCurrency || 'EUR', url,
    image: txt(o.image) || (o.image && o.image.url) || '', genre: '',
    status: cancelled ? 'Annullato' : postponed ? 'Rinviato' : sold ? 'Esaurito' : '', onsale: offers.find(x => x.validFrom)?.validFrom || ''
  };
}
/* link ai singoli eventi trovati nell'HTML (quando la pagina elenco non ha dati strutturati) */
const LINK_EVENTO = '/(eventi?|events?|evento|concerti?|concerts?|shows?|spettacol[io]|programma|tickets?|biglietti)/[^?#"\'\\s<>]{3,}';
export function eventLinks(html, base, pattern) {
  const re = new RegExp(pattern || LINK_EVENTO, 'i'), host = new URL(base).hostname.replace(/^www\./, '');
  const out = new Set(); const a = /<a\b[^>]*href=["']([^"'#]+)["']/gi; let m;
  while ((m = a.exec(html))) {
    let u; try { u = new URL(m[1].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== host) continue;
    if (!re.test(u.pathname)) continue;
    u.hash = ''; if (u.href.replace(/\/$/, '') !== base.replace(/\/$/, '')) out.add(u.href);
  }
  return [...out];
}
/* pagine evento senza dati strutturati: titolo da og:title, data e ora dal testo, luogo dalla configurazione */
const MESI_IT = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };
const meta = (h, k) => { const m = h.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + k + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')) || h.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + k + '["\']', 'i')); return m ? decodeHtml(m[1]).trim() : ''; };
const decodeHtml = t => String(t).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&euro;/g, '€');
function testoPagina(h) { return decodeHtml(h.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '); }
export function dateNelTesto(t, oggi = ymd(new Date())) {
  const out = [];
  for (const m of t.matchAll(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b(?:[^0-9]{1,12}(\d{1,2})[:.](\d{2}))?/g)) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; out.push({ d: y + '-' + pad(+m[2]) + '-' + pad(+m[1]), t: m[4] ? pad(+m[4]) + ':' + m[5] : '', i: m.index }); }
  for (const m of t.matchAll(/\b(\d{1,2})(?:°|º)?\s+(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[a-z]*\.?\s+(\d{4})(?:[^0-9]{1,14}(\d{1,2})[:.](\d{2}))?/gi)) {
    out.push({ d: m[3] + '-' + pad(MESI_IT[m[2].toLowerCase()]) + '-' + pad(+m[1]), t: m[4] ? pad(+m[4]) + ':' + m[5] : '', i: m.index }); }
  return out.filter(x => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(x.d) && x.d >= oggi && x.d <= ymd(new Date(Date.now() + 730 * 864e5))).sort((a, b) => a.i - b.i);
}
export function paginaEvento(html, url, item, src) {
  const ogT = meta(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '', ogD = meta(html, 'og:description');
  // Mailticket: «… a partire da € 28,00, le prevendite per TITOLO - LUOGO - sabato 21/11/2026 - 21:00»
  const mt = ogD.match(/prevendite per\s+(.+?)\s+-\s+(.+?)\s+-\s+\S+\s+(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+-\s+(\d{1,2}):(\d{2}))?/i);
  const mtp = (ogD.match(/a partire da\s*€\s*([\d.]*\d(?:,\d{2})?)/i) || [])[1];
  if (mt) return { id: src + ':' + hash(url), src, title: mt[1], artist: mt[1].replace(/\s+(in concerto|live|tour.*|a teatro)$/i, ''), date: mt[5] + '-' + pad(+mt[4]) + '-' + pad(+mt[3]), time: mt[6] ? pad(+mt[6]) + ':' + mt[7] : '',
    venue: mt[2], city: item.citta || '', address: '', lat: null, lon: null, priceMin: mtp ? num(mtp.replace(/\./g, '').replace(',', '.')) : null, priceMax: null, currency: 'EUR', url, image: meta(html, 'og:image'), genre: '', status: '', onsale: '' };
  const testo = testoPagina(html), d = dateNelTesto(testo)[0];
  if (!ogT || !d) return null;
  if (item.musica && !new RegExp(item.musica, 'i').test(url + ' ' + testo.slice(0, 4000))) return null;
  const seg = ogT.split(/\s+[|–-]\s+/).map(x => x.trim()).filter(x => x && !/^biglietti$/i.test(x));
  const title = (seg[0] || '').replace(/\s+Biglietti$/i, '').trim();
  if (!title || title.length < 3) return null;
  // «Titolo - Artista - Luogo - Biglietti» (Do It Yourself e simili)
  const artist = !item.venue && seg.length >= 3 ? seg[1] : title, venueT = !item.venue && seg.length >= 3 ? seg[seg.length - 1] : '';
  const prezzi = [...testo.matchAll(/€\s*(\d{1,3}(?:[.,]\d{2})?)|(\d{1,3}(?:[.,]\d{2})?)\s*€/g)].map(m => num(m[1] || m[2])).filter(v => v && v < 1000).slice(0, 8);
  return { id: src + ':' + hash(url), src, title, artist, date: d.d, time: d.t, venue: item.venue || venueT, city: item.citta || '', address: '', lat: item.lat ?? null, lon: item.lon ?? null,
    priceMin: prezzi.length ? Math.min(...prezzi) : null, priceMax: prezzi.length ? Math.max(...prezzi) : null, currency: 'EUR', url, image: meta(html, 'og:image'), genre: '', status: '', onsale: '' };
}
async function fontePagine(cfg, chiave, esiti) {
  const lista = (cfg[chiave] && cfg[chiave].pagine) || [];
  if (!lista.length) throw new Error('nessuna pagina configurata in config.json');
  const maxDettagli = cfg[chiave].maxDettagli ?? 30;
  const out = new Map(); const errors = [];
  const add = (o, src, l, item, u) => { const e = jsonLdNorm(o, src, l); if (!e || !e.date) return 0;
    e.fonte = item.nome || new URL(u).hostname.replace(/^www\./, ''); out.set(e.id, e); return 1; };
  for (const raw of lista) {
    const item = typeof raw === 'string' ? { url: raw } : raw; const u = item.url;
    const src = item.sigla || (chiave === 'vivaticket' ? 'vt' : 'web');
    const es = { fonte: chiave, url: u, ...(item.regione ? { regione: item.regione } : {}), eventi: 0 };
    try {
      const html = await http(u, { json: false });
      const { events, links } = extractJsonLd(html);
      for (const o of events) es.eventi += add(o, src, u, item, u);
      // pagine elenco: segue i link dei singoli eventi (dati strutturati o, in mancanza, link nell'HTML)
      if (!events.length) {
        const det = (links.length ? links : eventLinks(html, u, item.link)).slice(0, item.max ?? maxDettagli);
        es.link = det.length; let falliti = 0;
        for (const l of det) {
          try { const lu = new URL(l, u).href, h2 = await http(lu, { json: false, retries: 1 });
            const ld = extractJsonLd(h2).events; let n = 0;
            for (const o of ld) n += add(o, src, l, item, u);
            if (!n && item.riserva !== false) { const e = paginaEvento(h2, lu, item, src); if (e && e.date) { e.fonte = item.nome || new URL(u).hostname.replace(/^www\./, ''); out.set(e.id, e); n = 1; es.riserva = (es.riserva || 0) + 1; } }
            es.eventi += n;
          } catch { falliti++; }
          await sleep(450);
        }
        if (falliti) es.linkFalliti = falliti;
        if (!es.eventi) {
          es.nota = det.length ? 'pagine evento senza dati strutturati' : 'nessun evento né link a eventi trovati';
          // per regolare il riconoscimento dei link: dimensione della pagina e campione dei percorsi interni
          const host = new URL(u).hostname.replace(/^www\./, ''), seen = new Set();
          for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) { try { const x = new URL(m[1].replace(/&amp;/g, '&'), u); if (x.hostname.replace(/^www\./, '') === host && x.pathname.length > 1) seen.add(x.pathname); } catch {} }
          es.diag = { byte: html.length, linkInterni: seen.size, esempi: [...seen].slice(0, 25), ldJson: (html.match(/application\/ld\+json/gi) || []).length,
            ticketone: (html.match(/ticketone\.it\/[^"' ]+/gi) || []).slice(0, 5), vivaticket: (html.match(/vivaticket\.[a-z]+\/[^"' ]+/gi) || []).slice(0, 5) };
          if (det.length) { try { const h2 = await http(new URL(det[0], u).href, { json: false, retries: 1 }); es.diag.primoEvento = { url: det[0], byte: h2.length, ldJson: (h2.match(/application\/ld\+json/gi) || []).length,
            microdata: /itemtype=["'][^"']*schema\.org\/[A-Za-z]*Event/i.test(h2), og: (h2.match(/<meta[^>]+property=["']og:(title|description)["'][^>]*>/gi) || []).slice(0, 2), date: (h2.match(/\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b|\b\d{1,2} (gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[a-z]* \d{4}/gi) || []).slice(0, 5) }; } catch (e) { es.diag.primoEvento = { url: det[0], errore: e.message }; } }
        }
      }
    } catch (e) { es.errore = e.message; errors.push(u + ' → ' + e.message); }
    if (esiti) esiti.push(es);
    await sleep(600);
  }
  if (!out.size && errors.length) throw new Error(errors.length + ' pagine in errore: ' + errors.slice(0, 4).join(' | '));
  log(chiave + ':', out.size, 'eventi', errors.length ? '(' + errors.length + ' pagine in errore)' : '');
  return [...out.values()];
}

/* ================= GEOCODING (Nominatim, con cache) ================= */
async function geocodeMissing(events, budget) {
  const cacheFile = path.join(DATA, 'geocache.json');
  const cache = await readJson(cacheFile, {});
  let used = 0;
  const lookup = async q => {
    const k = norm(q); if (k in cache) return cache[k];
    if (used >= budget) return undefined;
    used++; await sleep(1100);
    try {
      const j = await http('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=it&q=' + encodeURIComponent(q), { headers: { 'User-Agent': GEO_UA } });
      cache[k] = j[0] ? [+(+j[0].lat).toFixed(5), +(+j[0].lon).toFixed(5)] : null;
    } catch { return undefined; }
    return cache[k];
  };
  for (const e of events) {
    if (e.lat != null && e.lon != null) continue;
    let g = e.venue && e.city ? await lookup(e.venue + ', ' + e.city) : undefined;
    if (!g && e.city) g = await lookup(e.city);
    if (!g && e.venue && !e.city) g = await lookup(e.venue);
    if (g) { e.lat = g[0]; e.lon = g[1]; }
  }
  await writeJson(cacheFile, cache);
  log('Geocoding: nuove richieste', used);
}
export async function geocodeOne(q) {
  try { const j = await http('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=it&q=' + encodeURIComponent(q), { headers: { 'User-Agent': GEO_UA } });
    return j[0] ? { lat: +(+j[0].lat).toFixed(5), lon: +(+j[0].lon).toFixed(5), nome: j[0].display_name.split(',')[0] } : null; } catch { return null; }
}

/* ================= FUSIONE E CONFRONTO ================= */
const STOP = new Set(['tour', 'live', 'concerto', 'concert', 'the', 'and', 'con', 'presenta', 'special', 'guest', 'world', 'italia', 'italy', 'teatro', 'arena', 'festival', 'in', 'di', 'del', 'della', 'feat', 'ft', 'vs', 'plus', 'night', 'show', 'estate', 'summer', 'winter', 'inverno', 'club', 'edition', 'anniversary']);
const toks = s => new Set(norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)));
export function sameArtist(a, b) {
  const na = norm(a.artist), nb = norm(b.artist);
  if (na && na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = toks(a.artist + ' ' + a.title), tb = toks(b.artist + ' ' + b.title);
  const ka = toks(a.artist), kb = toks(b.artist);
  if (ka.size && [...ka].every(x => tb.has(x))) return true;
  if (kb.size && [...kb].every(x => ta.has(x))) return true;
  return false;
}
export function samePlace(a, b) {
  if (a.lat != null && b.lat != null) return haversine(a.lat, a.lon, b.lat, b.lon) < 25;
  const ca = norm(a.city).split(' ')[0], cb = norm(b.city).split(' ')[0];
  return !!ca && ca === cb;
}
const NOMI = { tm: 'Ticketmaster', to: 'TicketOne', bit: 'Bandsintown', vt: 'Vivaticket', web: 'Sito ufficiale', dice: 'DICE', sms: 'Ticketsms', mt: 'Mailticket', diy: 'Do It Yourself' };
// varianti dello stesso concerto che i rivenditori pubblicano come eventi a parte
export const SPECIALE = /riservat|mastercard|amex|american express|vip|hospitality|pacchett|package|premium|upgrade|esperienz|experience|meet ?(&|and) ?greet|soundcheck|parcheggi|parking|pullman|bus|navett|prevendita|presale/i;
export function merge(list) {
  const byDate = new Map();
  const PRI = { tm: 0, to: 1, vt: 2, dice: 3, sms: 4, mt: 5, diy: 6, web: 7, bit: 8 };
  list.sort((a, b) => (PRI[a.src] ?? 9) - (PRI[b.src] ?? 9));
  for (const e of list) {
    if (!e.date) continue;
    const arr = byDate.get(e.date) || []; byDate.set(e.date, arr);
    const offer = { src: e.src, nome: e.fonte && (e.src === 'web' || !NOMI[e.src]) ? e.fonte : (NOMI[e.src] || e.src), url: e.url, min: e.priceMin, max: e.priceMax, valuta: e.currency, stato: e.status || '', det: e.title || '' };
    const m = arr.find(x => samePlace(x, e) && sameArtist(x, e));
    if (!m) {
      arr.push({ ...e, sources: [e.src], ids: [e.id], offers: [offer] });
      continue;
    }
    if (m.ids.includes(e.id)) continue;
    m.ids.push(e.id); if (!m.sources.includes(e.src)) m.sources.push(e.src);
    if (!m.offers.some(o => o.url === offer.url)) m.offers.push(offer);
    for (const f of ['image', 'time', 'genre', 'address', 'venue', 'onsale']) if (!m[f] && e[f]) m[f] = e[f];
    // titolo della scheda: meglio la vendita generale che una variante (posti riservati, VIP, pacchetti…)
    if (SPECIALE.test(m.title || '') && e.title && !SPECIALE.test(e.title)) m.title = e.title;
    if (m.lat == null && e.lat != null) { m.lat = e.lat; m.lon = e.lon; }
  }
  const out = [];
  for (const arr of byDate.values()) for (const m of arr) {
    const prices = m.offers.flatMap(o => [o.min, o.max]).filter(v => v != null);
    m.priceMin = prices.length ? Math.min(...prices) : null;
    m.priceMax = prices.length ? Math.max(...prices) : null;
    m.offers.sort((a, b) => (a.min ?? 1e9) - (b.min ?? 1e9));
    // "Esaurito" vale per il concerto solo se lo è presso tutti i rivenditori
    if (m.status === 'Esaurito' && !m.offers.every(o => o.stato === 'Esaurito')) m.status = '';
    m.id ='c' + hash(m.date + '|' + norm(m.artist) + '|' + norm(m.city).split(' ')[0]);
    delete m.src; delete m.fonte; delete m.url; delete m.currency;
    out.push(m);
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/* prezzi mancanti: legge i dati strutturati della pagina evento (solo dove serve al confronto) */
async function arricchisciPrezzi(events, artistiNorm, budget) {
  let used = 0;
  const cand = events.filter(e => e.offers.some(o => o.min == null && o.src !== 'bit' && o.url)
    && (e.offers.length > 1 || artistiNorm.some(a => matchFav(e, a))));
  for (const e of cand) {
    for (const o of e.offers) {
      if (o.min != null || o.src === 'bit' || !o.url || used >= budget) continue;
      used++;
      try {
        const html = await http(o.url, { json: false, retries: 1 });
        const ld = extractJsonLd(html).events.map(x => jsonLdNorm(x, o.src, o.url)).filter(Boolean);
        const hit = ld.find(x => x.date === e.date) || ld[0];
        if (hit && hit.priceMin != null) { o.min = hit.priceMin; o.max = hit.priceMax; }
      } catch {}
      await sleep(600);
    }
    const prices = e.offers.flatMap(o => [o.min, o.max]).filter(v => v != null);
    if (prices.length) { e.priceMin = Math.min(...prices); e.priceMax = Math.max(...prices); }
    e.offers.sort((a, b) => (a.min ?? 1e9) - (b.min ?? 1e9));
  }
  log('Prezzi: lette', used, 'pagine evento');
}

/* ================= AVVISI ================= */
export const matchFav = (e, fav) => (' ' + norm(e.artist + ' ' + e.title) + ' ').includes(' ' + fav + ' ');
function fmt(e) {
  const [y, m, d] = e.date.split('-');
  return d + '/' + m + '/' + y + (e.time ? ' ' + e.time : '') + ' · ' + [e.venue, e.city].filter(Boolean).join(', ');
}
async function notifica(nuovi, cfg, sito) {
  if (!nuovi.length) return 0;
  const righe = nuovi.slice(0, 15).map(e => '🎤 ' + e.artist + ' — ' + fmt(e) + (e.priceMin != null ? ' — da ' + e.priceMin + ' €' : ''));
  const titolo = nuovi.length === 1 ? 'Nuova data: ' + nuovi[0].artist : nuovi.length + ' nuove date dei tuoi artisti';
  const testo = righe.join('\n') + (nuovi.length > 15 ? '\n…e altre ' + (nuovi.length - 15) : '');
  const link = sito ? sito + '#preferiti' : (nuovi[0].offers[0]?.url || '');
  let inviati = 0;
  if (ENV.NTFY_TOPIC) {
    try {
      await http((ENV.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '') + '/', { method: 'POST', retries: 1,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: ENV.NTFY_TOPIC, title: titolo, message: testo, tags: ['musical_note'], click: link || undefined }) });
      inviati++; log('Avviso ntfy inviato');
    } catch (e) { log('ntfy:', e.message); }
  }
  if (ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID) {
    try {
      await http('https://api.telegram.org/bot' + ENV.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', retries: 1,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text: '🔔 ' + titolo + '\n\n' + testo + (link ? '\n\n' + link : ''), disable_web_page_preview: true }) });
      inviati++; log('Avviso Telegram inviato');
    } catch (e) { log('Telegram:', e.message); }
  }
  return inviati;
}

/* ================= MAIN ================= */
async function main() {
  const t0 = Date.now();
  await mkdir(DATA, { recursive: true });
  const { cfg, artisti } = await loadConfig();
  const artistiNorm = artisti.map(norm).filter(Boolean);
  const prev = await readJson(path.join(DATA, 'events.json'), null);
  const prevById = new Map((prev?.events || []).map(e => [e.id, e]));
  const prevIds = new Set((prev?.events || []).flatMap(e => [e.id, ...(e.ids || [])]));

  const esiti = [];
  const fonti = [
    ['tm', 'Ticketmaster', () => fonteTicketmaster(cfg)],
    ['to', 'TicketOne', () => cfg.ticketone?.attiva === false ? Promise.reject(new Error('disattivata')) : fonteTicketone(cfg)],
    ['vt', 'Vivaticket', () => cfg.vivaticket?.attiva === false ? Promise.reject(new Error('disattivata')) : fontePagine(cfg, 'vivaticket', esiti)],
    ['bigl', 'Altre biglietterie (DICE, Ticketsms, Mailticket, Do It Yourself)', () => cfg.biglietterie?.attiva === false ? Promise.reject(new Error('disattivata')) : fontePagine(cfg, 'biglietterie', esiti)],
    ['web', 'Siti di locali, palazzetti e festival', () => cfg.siti?.attiva === false ? Promise.reject(new Error('disattivata')) : fontePagine(cfg, 'siti', esiti)],
    ['bit', 'Bandsintown', () => fonteBandsintown(cfg, artisti)]
  ];
  const status = { aggiornato: new Date().toISOString(), fonti: [] };
  const all = [];
  for (const [id, nome, fn] of fonti) {
    const s = Date.now();
    try { const ev = await fn(); all.push(...ev); status.fonti.push({ id, nome, ok: true, eventi: ev.length, secondi: Math.round((Date.now() - s) / 1000) }); }
    catch (e) { log(nome, 'ERRORE:', e.message); status.fonti.push({ id, nome, ok: false, errore: String(e.message).slice(0, 300), eventi: 0 }); }
  }

  const oggi = ymd(new Date());
  const valid = all.filter(e => e.date && e.date >= oggi && e.date.length === 10);
  await geocodeMissing(valid, cfg.geocodingMax ?? 80);
  let events = merge(valid);
  await arricchisciPrezzi(events, artistiNorm, cfg.prezziMax ?? 120);

  // data di prima comparsa (per "NUOVO" e per gli avvisi)
  const now = new Date().toISOString();
  for (const e of events) {
    const p = prevById.get(e.id);
    e.visto = p?.visto || (e.ids.some(i => prevIds.has(i)) ? (p?.visto || now) : now);
    e.fav = artistiNorm.some(a => matchFav(e, a)) || undefined;
  }

  // avvisi: solo eventi di preferiti mai visti prima (dalla seconda esecuzione in poi)
  const nuovi = prev ? events.filter(e => e.fav && !prevById.has(e.id) && !e.ids.some(i => prevIds.has(i))) : [];
  const sito = ENV.SITE_URL || (ENV.GITHUB_REPOSITORY ? 'https://' + ENV.GITHUB_REPOSITORY.split('/')[0].toLowerCase() + '.github.io/' + ENV.GITHUB_REPOSITORY.split('/')[1] + '/' : '');
  const inviati = await notifica(nuovi, cfg, sito);

  // casa
  const meta = await readJson(path.join(DATA, 'meta.json'), {});
  if (cfg.casa && (!meta.casa || meta.casa.query !== cfg.casa)) {
    const g = await geocodeOne(cfg.casa); if (g) meta.casa = { query: cfg.casa, ...g };
  }
  if (!cfg.casa) delete meta.casa;
  meta.raggio = cfg.raggioPredefinito || 50;
  meta.repo = ENV.GITHUB_REPOSITORY || meta.repo || '';
  meta.artisti = artisti;
  meta.ntfy = ENV.NTFY_TOPIC ? (ENV.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '') + '/' + ENV.NTFY_TOPIC : '';

  // pulizia campi vuoti per ridurre il peso
  const slim = events.map(e => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))));
  status.eventi = slim.length;
  status.confrontabili = events.filter(e => e.offers.length > 1).length;
  status.nuoviPreferiti = nuovi.length;
  status.avvisiInviati = inviati;
  status.durataSecondi = Math.round((Date.now() - t0) / 1000);
  status.pagine = esiti;
  status.diagnostica = DIAG; // esito di ogni pagina letta (per capire quali siti rispondono)

  // se tutte le fonti hanno fallito, non sovrascrive i dati buoni precedenti
  if (!slim.length && prev?.events?.length) {
    log('Nessun evento letto: mantengo i dati precedenti');
    status.eventi = prev.events.length; status.datiPrecedenti = true;
  } else {
    await writeJson(path.join(DATA, 'events.json'), { generato: now, eventi: slim.length, events: slim });
  }
  await writeJson(path.join(DATA, 'status.json'), status, true);
  await writeJson(path.join(DATA, 'meta.json'), meta, true);
  log('Fatto:', status.eventi, 'concerti,', status.confrontabili, 'con più rivenditori,', nuovi.length, 'nuovi per i preferiti');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
