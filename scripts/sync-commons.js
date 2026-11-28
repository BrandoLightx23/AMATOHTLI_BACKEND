#!/usr/bin/env node
/**
 * scripts/sync-commons.js
 * ─────────────────────────────────────────────────────────────────
 * Sincroniza una colección de Wikimedia Commons en la tabla `objetos`.
 * Pensado para AMATOHTLI + Supabase: la navegación nunca consulta Wikimedia
 * en vivo; este script es la única vía de ingesta, y se corre solo cuando
 * quieres crear o refrescar una colección. Usa la conexión Postgres de
 * Supabase vía config/db.js (no la anon key, por RLS).
 *
 * Qué hace:
 *   1. Lista los archivos de una categoría con paginación (cmlimit=max,
 *      500 por llamada; 681 archivos ≈ 2 llamadas).
 *   2. Enriquece en lotes de 50 con `imageinfo` + `iiurlwidth=800`
 *      (thumburl listo para la galería). No pide `extmetadata` en bulk.
 *   3. Upsert idempotente en `objetos` por `commons_title` (título de
 *      Commons, ej. "File:..."), sin borrar nada: las piezas que ya
 *      existen se actualizan, las nuevas se insertan.
 *   4. Respeta a Wikimedia: User-Agent con contacto, `maxlag=5`,
 *      backoff ante 429 respetando `Retry-After`.
 *
 * Requisitos: haber corrido antes la migración de colecciones
 *   node scripts/migrate-colecciones.js
 *
 * Uso:
 *   node scripts/sync-commons.js --category "Category:Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich"
 *   node scripts/sync-commons.js --category "Category:..." --dry-run   # solo lista, no escribe en la BD
 *   node scripts/sync-commons.js --category "Category:..." --limit 20  # prueba con los primeros 20
 *
 * Notas:
 *   · No descarga imágenes: solo guarda URLs/thumburl en la BD.
 *     La descarga local sigue siendo `npm run download` (skip-and-resume).
 *   · El número de inventario se parsea del título cuando trae
 *     "Inv.Nr.-2025.1280"; si no, queda NULL y la pieza se identifica
 *     por su commons_title.
 *   · Los títulos curados se conservan; solo se reparan títulos existentes
 *     que coinciden exactamente con el formato generado por versiones previas.
 *     Las piezas nuevas reciben un título legible derivado del archivo.
 */

'use strict';

const db = require('../config/db');

// ── Config ──────────────────────────────────────────────────────────────────
const API_URL = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'AMATOHTLI-sync/1.0 (hackathon; contacto: BrandoLightx23)';
const BATCH_SIZE = 50;          // imageinfo acepta hasta 50 títulos por llamada
const THUMB_WIDTH = 800;        // thumburl para galería
const MAX_RETRIES = 4;          // reintentos ante 429 / errores de red
const BASE_DELAY_MS = 1500;     // pausa entre llamadas (amable con la API)
const TIMEOUT_MS = 20_000;

// ── Args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { category: null, dryRun: false, limit: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--category') args.category = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Uso: node scripts/sync-commons.js --category "Category:..." [--dry-run] [--limit N]');
      return;
    } else {
      console.error(`Argumento desconocido: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (!args.category) {
    console.error('Falta --category "Category:..."');
    process.exit(1);
  }
  if (!args.category.startsWith('Category:')) {
    console.error('La categoría debe empezar con "Category:"');
    process.exit(1);
  }
  return args;
}

// ── HTTP con retry / 429 ────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJsonWithRetry(baseUrl, params) {
  const url = `${baseUrl}?${new URLSearchParams({
    format: 'json',
    ...params,
  })}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      });
      clearTimeout(timer);

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '5', 10);
        const waitMs = Math.min(Math.max(retryAfter * 1000, 2000), 30_000);
        if (attempt < MAX_RETRIES) {
          console.warn(`  ⏳ 429 rate-limit, esperando ${waitMs}ms (intento ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(waitMs);
          continue;
        }
        throw new Error('429 persistente tras reintentos');
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status} al consultar ${baseUrl}`);
      return await resp.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES && err.name !== 'AbortError') {
        await sleep(BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function apiGet(params) {
  return fetchJsonWithRetry(API_URL, {
    formatversion: '2',
    maxlag: '5',
    origin: '*',
    ...params,
  });
}

// ── 1. Listar archivos de la categoría (paginado) ───────────────────────────
async function listCategoryFiles(category) {
  const files = [];
  let cmcontinue = null;

  do {
    const params = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: category,
      cmtype: 'file',
      cmlimit: 'max',
      cmprop: 'ids|title|timestamp',
    };
    if (cmcontinue) params.cmcontinue = cmcontinue;

    const data = await apiGet(params);
    const members = data?.query?.categorymembers || [];
    files.push(...members);
    cmcontinue = data?.continue?.cmcontinue || null;
    if (cmcontinue) await sleep(BASE_DELAY_MS);
  } while (cmcontinue);

  return files;
}

// ── 2. Enriquecer en lotes de 50 ────────────────────────────────────────────
async function enrichBatch(titles) {
  const data = await apiGet({
    action: 'query',
    prop: 'imageinfo|revisions',
    iiprop: 'url|size|mime',
    iiurlwidth: String(THUMB_WIDTH),
    rvprop: 'content',
    rvslots: 'main',
    titles: titles.join('|'),
  });

  const pages = data?.query?.pages || [];
  return pages.map(page => {
    const info = page.imageinfo?.[0] || {};
    const wikitext = page.revisions?.[0]?.slots?.main?.content || '';
    const qMatch = wikitext.match(/\|\s*wikidata\s*=\s*(Q\d+)/i);
    return {
      pageid: page.pageid ?? null,
      title: page.title || null,          // "File:..."
      url: info.url || null,              // original
      thumburl: info.thumburl || null,    // escalada a 800px
      width: info.width ?? null,
      height: info.height ?? null,
      mime: info.mime || null,
      wikidataQid: qMatch ? qMatch[1].toUpperCase() : null,
      wikitext,
    };
  });
}

// ── 2b. Enriquecimiento desde Wikidata (lugar, coordenadas, cultura, etc.) ─
async function fetchWikidataEntities(ids) {
  const entities = {};
  const unique = [...new Set(ids.filter(Boolean))];
  for (const batch of chunk(unique, BATCH_SIZE)) {
    const data = await fetchJsonWithRetry(WIKIDATA_API_URL, {
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'labels|claims',
      languages: 'es|en|de',
    });
    Object.assign(entities, data?.entities || {});
    if (batch.length === BATCH_SIZE) await sleep(500);
  }
  return entities;
}

function getLabel(entity) {
  if (!entity?.labels) return null;
  return entity.labels.es?.value || entity.labels.en?.value || entity.labels.de?.value || null;
}

function getClaimIds(entity, prop) {
  return (entity?.claims?.[prop] || [])
    .map(c => c?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function formatWikidataYear(timeVal) {
  const m = timeVal?.time?.match(/^([+-]?\d+)-/);
  if (!m) return null;
  const yr = parseInt(m[1], 10);
  if (Number.isNaN(yr) || yr === 0) return null;
  return yr < 0 ? `${Math.abs(yr)} a. C.` : `${yr} d. C.`;
}

function extractFecha(entity) {
  const claims = entity?.claims?.P571;
  if (!claims?.length) return null;
  const claim = claims.find(c => c?.rank === 'preferred') || claims[0];
  const start = formatWikidataYear(claim?.qualifiers?.P1319?.[0]?.datavalue?.value);
  const end = formatWikidataYear(claim?.qualifiers?.P1326?.[0]?.datavalue?.value);
  if (start && end) return `${start} – ${end}`;
  if (start) return `Desde ${start}`;
  if (end) return `Hasta ${end}`;
  return formatWikidataYear(claim?.mainsnak?.datavalue?.value);
}

const UNIT_MAP = {
  Q174728: 'cm',
  Q11573: 'm',
  Q174789: 'mm',
};

function extractDimensions(entity) {
  const defs = [
    ['P2048', 'Alto'],
    ['P2049', 'Ancho'],
    ['P2043', 'Largo'],
    ['P2386', 'Diámetro'],
    ['P2610', 'Grosor'],
  ];
  const parts = [];
  for (const [prop, label] of defs) {
    const val = entity?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
    if (!val?.amount) continue;
    const num = parseFloat(val.amount);
    if (Number.isNaN(num)) continue;
    const unitQid = val.unit?.split('/').pop();
    const unit = UNIT_MAP[unitQid];
    if (!unit) continue;
    parts.push(`${label}: ${num} ${unit}`);
  }
  return parts.length ? parts.join(', ') : null;
}

async function enrichWithWikidata(items) {
  const qids = items.map(i => i.wikidataQid).filter(Boolean);
  if (!qids.length) return items;

  const artworkEntities = await fetchWikidataEntities(qids);
  const refIds = new Set();
  for (const qid of qids) {
    const ent = artworkEntities[qid];
    if (!ent) continue;
    for (const p of ['P1071', 'P2596', 'P31', 'P186', 'P2079']) {
      for (const id of getClaimIds(ent, p)) refIds.add(id);
    }
  }

  const refEntities = await fetchWikidataEntities([...refIds]);

  return items.map(item => {
    const ent = item.wikidataQid ? artworkEntities[item.wikidataQid] : null;
    if (!ent) return item;

    const placeIds = getClaimIds(ent, 'P1071');
    const placeLabels = placeIds.map(id => getLabel(refEntities[id])).filter(Boolean);
    const lugar_origen = placeLabels.length ? [...new Set(placeLabels)].join(', ') : null;

    // Preferir coordenadas P625 del lugar más específico (no país Q6256)
    let lat = null, lon = null;
    const placeCandidates = placeIds
      .map(id => {
        const pe = refEntities[id];
        const coord = pe?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
        const isCountry = getClaimIds(pe, 'P31').includes('Q6256');
        return coord ? { lat: coord.latitude, lon: coord.longitude, isCountry } : null;
      })
      .filter(Boolean);
    const chosen = placeCandidates.find(c => !c.isCountry) || placeCandidates[0];
    if (chosen) {
      lat = chosen.lat;
      lon = chosen.lon;
    }

    const cultura = getClaimIds(ent, 'P2596').map(id => getLabel(refEntities[id])).filter(Boolean);
    const tipos = getClaimIds(ent, 'P31').map(id => getLabel(refEntities[id])).filter(Boolean);
    const materiales = [
      ...getClaimIds(ent, 'P186').map(id => getLabel(refEntities[id])),
      ...getClaimIds(ent, 'P2079').map(id => getLabel(refEntities[id])),
    ].filter(Boolean);
    const url_objeto = ent?.claims?.P973?.[0]?.mainsnak?.datavalue?.value || null;
    const invRaw = ent?.claims?.P217?.[0]?.mainsnak?.datavalue?.value;
    const numero_inventario = typeof invRaw === 'string' && /^\d{4}\.\d+(?:\.\d+)?$/.test(invRaw.trim()) ? invRaw.trim() : null;

    return {
      ...item,
      lugar_origen: item.lugar_origen || lugar_origen,
      lat: item.lat ?? lat,
      lon: item.lon ?? lon,
      estilo_cultura: item.estilo_cultura || (cultura.length ? cultura.join(', ') : null),
      tipo_objeto: item.tipo_objeto || (tipos.length ? tipos[0] : null),
      material_tecnica: item.material_tecnica || (materiales.length ? [...new Set(materiales)].join(', ') : null),
      fecha: item.fecha || extractFecha(ent),
      dimensiones: item.dimensiones || extractDimensions(ent),
      url_objeto: item.url_objeto || url_objeto,
      numero_inventario: item.numero_inventario || numero_inventario,
    };
  });
}


// ── 2c. Metadatos desde la plantilla {{Artwork}} de Commons ────────────────
// Birmingham/Cleveland no tienen ítem Wikidata, pero sí ficha rica en el
// wikitexto (title, description, date, medium, dimensions, place of creation,
// accession number, source, credit line...). Aquí se parsea sin dependencias.

/** Extrae el bloque {{Artwork ... }} respetando anidamiento {{ }}. */
function extractArtworkBlock(wikitext) {
  if (!wikitext) return null;
  const start = wikitext.search(/\{\{\s*Artwork\b/i);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--; i++;
      if (depth === 0) return wikitext.slice(start, i + 1);
    }
  }
  return null;
}

/** Divide por un separador solo en profundidad 0 (fuera de {{ }} y [[ ]]). */
function splitTopLevel(str, sep) {
  const parts = [];
  let depthT = 0, depthL = 0, cur = '';
  for (let i = 0; i < str.length; i++) {
    const two = str.slice(i, i + 2);
    if (two === '{{') { depthT++; cur += two; i++; continue; }
    if (two === '}}') { depthT = Math.max(0, depthT - 1); cur += two; i++; continue; }
    if (two === '[[') { depthL++; cur += two; i++; continue; }
    if (two === ']]') { depthL = Math.max(0, depthL - 1); cur += two; i++; continue; }
    if (str[i] === sep && depthT === 0 && depthL === 0) { parts.push(cur); cur = ''; continue; }
    cur += str[i];
  }
  parts.push(cur);
  return parts;
}

/** Primer '=' en profundidad 0, o -1. */
function indexOfTopLevelEquals(str) {
  let depthT = 0, depthL = 0;
  for (let i = 0; i < str.length; i++) {
    const two = str.slice(i, i + 2);
    if (two === '{{') { depthT++; i++; continue; }
    if (two === '}}') { depthT = Math.max(0, depthT - 1); i++; continue; }
    if (two === '[[') { depthL++; i++; continue; }
    if (two === ']]') { depthL = Math.max(0, depthL - 1); i++; continue; }
    if (str[i] === '=' && depthT === 0 && depthL === 0) return i;
  }
  return -1;
}

/** Devuelve los parámetros de una plantilla como mapa { clave: valorCrudo }. */
function parseTemplateParams(block) {
  const inner = block.replace(/^\{\{\s*Artwork\b/i, '').replace(/\}\}\s*$/, '');
  const params = {};
  for (const part of splitTopLevel(inner, '|')) {
    const eq = indexOfTopLevelEquals(part);
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key) params[key] = value;
  }
  return params;
}

/** Quita comentarios HTML y colapsa espacios. */
function stripComments(s) {
  let out = (s || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch { return ''; } });
  return out.replace(/\s+/g, ' ').trim();
}

/** Texto plano de un valor wikitexto: resuelve plantillas comunes y enlaces. */
function cleanWikiValue(raw) {
  if (!raw) return null;
  let s = stripComments(raw);
  // {{en|1=...}} / {{en|...}} → contenido
  s = s.replace(/\{\{\s*en\s*\|[^}]*?\}\}/gi, (m) => {
    const inner = m.replace(/^\{\{\s*en\s*\|/i, '').replace(/\}\}$/, '');
    const eq = inner.indexOf('=');
    return eq >= 0 ? inner.slice(eq + 1) : inner;
  });
  // {{other date|circa|750}} → "circa 750" ; {{other date|~|400|900}} → "circa 400-900"
  s = s.replace(/\{\{\s*other date\s*\|([^}]*)\}\}/gi, (_, inner) => {
    const parts = inner.split('|').map(x => x.trim()).filter(Boolean);
    const nums = parts.filter(x => /^\d{1,4}$/.test(x));
    const words = parts.filter(x => !/^\d{1,4}$/.test(x));
    const prefix = words.join(' ').replace(/^~$/, 'circa').replace(/^c\.?$/i, 'circa');
    if (nums.length >= 2) return `${prefix} ${nums[0]}-${nums[1]}`.trim();
    if (nums.length === 1 && /century/i.test(prefix)) {
      const n = parseInt(nums[0], 10);
      const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
      return `${n}${suffix} century`;
    }
    return [...words, ...nums].join(' ');
  });
  // {{size|in|9.5|3.25|2.5}} → "9.5 × 3.25 × 2.5 in"
  s = s.replace(/\{\{\s*size\s*\|([^}]*)\}\}/gi, (_, inner) => {
    const p = inner.split('|').map(x => x.trim());
    const unit = p[0] || '';
    return p.slice(1).join(' × ') + (unit ? ` ${unit}` : '');
  });
  // {{Technique|low relief|Limestone}} → "Limestone, low relief"
  s = s.replace(/\{\{\s*Technique\s*\|([^}]*)\}\}/gi, (_, inner) => {
    const p = inner.split('|').map(x => x.trim()).filter(Boolean);
    return p.length > 1 ? `${p[p.length - 1]}, ${p.slice(0, -1).join(', ')}` : (p[0] || '');
  });
  // {{institution:Cleveland Museum of Art}} → "Cleveland Museum of Art"
  s = s.replace(/\{\{\s*institution\s*:\s*([^}]*)\}\}/gi, (_, inner) => inner.trim());
  // {{cite ...}} y otras plantillas → quitar
  s = s.replace(/\{\{[^{}]*\}\}/g, ' ');
  // [[Archivo:...]] / [[File:...]] → quitar
  s = s.replace(/\[\[\s*(?:File|Archivo|Image|Imagen)\s*:[^\]]*\]\]/gi, ' ');
  // [[destino|texto]] → texto ; [[destino]] → destino
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
  // enlaces externos [http://... texto] → texto
  s = s.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1').replace(/\[https?:\/\/[^\]]+\]/g, ' ');
  // negritas/cursivas
  s = s.replace(/'{2,}/g, '');
  s = stripComments(s);
  return s || null;
}

/** Normaliza una fecha de Artwork a texto legible con era. */
function parseArtworkDate(raw) {
  if (!raw) return null;
  const cleaned = cleanWikiValue(raw);
  if (!cleaned) return null;
  // Rangos y fechas textuales: conservar tal cual (con era traducida si es simple)
  if (/millennium|century|\bcentury\b/i.test(cleaned)) return cleaned;
  const range = cleaned.match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*(B\.?C\.?|BCE|A\.?D\.?|CE)?/i);
  if (range && /[-–—]/.test(cleaned)) {
    const eraRaw = (range[3] || '').toUpperCase().replace(/[\.\s]/g, '');
    const era = /BC|BCE/.test(eraRaw) ? 'a. C.' : /AD|CE/.test(eraRaw) ? 'd. C.' : '';
    return era ? `${range[1]}–${range[2]} ${era}` : `${range[1]}–${range[2]}`;
  }
  const m = cleaned.match(/(\d{1,4})/);
  if (!m) return cleaned;
  const year = parseInt(m[1], 10);
  if (year < 10) return null; // fecha truncada en la ficha (p. ej. "1"), mejor desconocida
  const isBC = /b\.?\s*c\.?|bce/i.test(cleaned);
  const era = isBC ? 'a. C.' : 'd. C.';
  const circa = /circa|ca\.?|c\./i.test(cleaned) ? 'circa ' : '';
  return `${circa}${year} ${era}`;
}

/** Normaliza dimensiones; convierte pulgadas a cm si viene {{size|in|...}}. */
function parseArtworkDimensions(raw) {
  if (!raw) return null;
  const sizeMatch = raw.match(/\{\{\s*size\s*\|\s*(in|cm|mm|m)\s*\|([^}]*)\}\}/i);
  if (sizeMatch) {
    const unit = sizeMatch[1].toLowerCase();
    const nums = sizeMatch[2].split('|').map(x => parseFloat(x.trim())).filter(n => !Number.isNaN(n));
    if (!nums.length) return null;
    const factor = unit === 'in' ? 2.54 : unit === 'mm' ? 0.1 : unit === 'm' ? 100 : 1;
    const converted = nums.map(n => Math.round(n * factor * 100) / 100);
    return `${converted.join(' × ')} cm`;
  }
  return cleanWikiValue(raw);
}

/** Extrae lugar/cultura/periodo de "place of creation" o de la descripción. */
function parsePlaceAndCulture(placeRaw, description) {
  let lugar = null;
  let cultura = null;
  const place = placeRaw ? cleanWikiValue(placeRaw) : null;
  if (place) {
    const segments = place.split(',').map(x => x.trim()).filter(Boolean);
    const kept = [];
    for (const seg of segments) {
      if (/maya/i.test(seg)) { cultura = 'Maya'; continue; }
      const knownCulture = seg.match(/\b(Olmec|Aztec|Mexica|Inca|Incan|Chavin|Chavín|Valdivia|Moche|Nazca|Nasca|Wari|Tiahuanaco|Tiwanaku|Teotihuacan|Toltec|Zapotec|Mixtec|Mixteca|Chimu|Chimú|Sican|Sicán|Lambayeque|Conte|Chocholá|Chochola|Jaina|Coclé|Cocle|Nicoya|Colima|Michoacán|Michoacan|Punuk|Mezcala|Mississippian|Micmac|Calima|Yotoco|Sinú|Sinu|Chimú|Chimu|Paracas)\b/i);
      if (knownCulture) { cultura = knownCulture[1]; continue; }
      const styleMatch = seg.match(/^(.+?)\s+style$/i);
      if (styleMatch) { cultura = styleMatch[1].trim(); continue; }
      if (/style|period|classic|postclassic|preclassic|formative|century/i.test(seg)) continue;
      if (/^\d{2,4}\s*[-–—]\s*\d{2,4}$/.test(seg) || /^\d{2,4}$/.test(seg)) continue;
      if (/\d{3,4}\s*[-–—]\s*\d{3,4}/.test(seg)) continue;
      if (/\d{3,4}/.test(seg) && /(a\.?\s*d\.?|b\.?\s*c\.?|century)/i.test(seg)) continue;
      kept.push(seg);
    }
    if (kept.length) lugar = kept.join(', ');
  }
  if (!cultura && description) {
    if (/maya/i.test(description)) cultura = 'Maya';
    else {
      const km = description.match(/\b(Olmec|Aztec|Mexica|Inca|Chavin|Chavín|Valdivia|Moche|Nazca|Wari|Teotihuacan|Toltec|Zapotec|Mixtec|Chimu|Sican|Lambayeque|Conte|Calima|Yotoco|Cocle|Coclé)\b/i);
      if (km) cultura = km[1];
    }
  }
  if (!lugar && description) {
    const matches = [...description.matchAll(/from\s+([^.]+?)(?:\.|$)/gi)];
    if (matches.length) lugar = matches[matches.length - 1][1].trim();
  }
  return { lugar, cultura };
}


/** Parsea la descripción estilo LACMA (líneas ":...") en campos sueltos. Maneja formato v1 (Sculpture/Jadeite/Height) y v2 (Lugar, fecha / Departamento; objeto / Material / Dimensiones / Gift). */
function parseLacmaDescription(rawDescription) {
  if (!rawDescription) return {};
  const cleaned = rawDescription
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/&amp;/gi, '&');
  const lines = cleaned.split(/\n/).map(l => l.replace(/^\s*:\s*/, '').trim()).filter(Boolean);
  if (lines.length < 2) return {};
  const out = {};
  const placeRe = /^(Mexico|Peru|Panama|Costa Rica|Ecuador|Guatemala|Honduras|Belize|Colombia|Bolivia|Chile|El Salvador|Nicaragua|Venezuela|Brazil)\b/i;
  for (const line of lines) {
    if (/\{\{/.test(line)) continue;
    const cleanLine = cleanWikiValue(line);
    if (!cleanLine) continue;
    if (/art of the ancient americas|currently on public view/i.test(cleanLine)) continue;
    if (/^(gift of|the .+ collection|purchase|bequest)/i.test(cleanLine)) { out.creditos = cleanLine; continue; }
    if (/^(height|length|diameter|overall|w\.|h\.|l\.)\s*[-:]?\s*\d/i.test(cleanLine) || /^\d+.*\bin\.\s*\(/i.test(cleanLine) || /^\d+\s*x\s*\d+/i.test(cleanLine)) {
      out.dimensiones = cleanLine.replace(/^(height|length|diameter|overall)\s*[-:]?\s*/i, '');
      continue;
    }
    if (placeRe.test(cleanLine)) { out.lugar_raw = cleanLine; continue; }
    if (cleanLine.includes(';')) {
      const parts = cleanLine.split(';').map(x => x.trim()).filter(Boolean);
      if (parts[1]) out.tipo_objeto = parts[1];
      else if (parts[0]) out.tipo_objeto = parts[0];
      continue;
    }
    if (!out.tipo_objeto && cleanLine.length < 60) { out.tipo_objeto = cleanLine; continue; }
    if (!out.material_tecnica && cleanLine.length < 80) { out.material_tecnica = cleanLine; continue; }
  }
  // Si el primer formato (v1) dejó tipo=material cruzado, corregir: Sculpture/Jadeite ya están bien por orden
  return out;
}

/** Parsea descripción estilo Met "Cultura; Objeto; Material-Tipo". */
function parseMetDescription(description) {
  if (!description || !description.includes(';') || description.includes(':')) return {};
  if (description.length > 120) return {};
  const parts = description.split(';').map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return {};
  if (parts.some(x => x.length > 50)) return {};
  const out = {};
  if (!out.estilo_cultura) out.estilo_cultura = parts[0];
  if (parts[1]) out.tipo_objeto = parts[1];
  return out;
}

/** Extrae Culture/Object_Name del JSON oculto metadata_mapped_json (Met/GWToolset). */
function parseMappedJsonCulture(wikitext) {
  if (!wikitext) return {};
  const m = wikitext.match(/<metadata_mapped_json>([\s\S]*?)<\/metadata_mapped_json>/i);
  if (!m) return {};
  try {
    const json = JSON.parse(m[1].replace(/\\\//g, '/'));
    const out = {};
    if (json.Culture) out.estilo_cultura = String(json.Culture).trim();
    if (json.Object_Name && !out.tipo_objeto) out.tipo_objeto = String(json.Object_Name).trim();
    return out;
  } catch { return {}; }
}

/** Extrae el bloque {{Information ... }} (LACMA/Flickr) respetando anidamiento. */
function extractInformationBlock(wikitext) {
  if (!wikitext) return null;
  const start = wikitext.search(/\{\{\s*Information\b/i);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--; i++;
      if (depth === 0) return wikitext.slice(start, i + 1);
    }
  }
  return null;
}

function parseTemplateParamsGeneric(block, templateName) {
  const re = new RegExp(`^\\{\\{\\s*${templateName}\\b`, 'i');
  const inner = block.replace(re, '').replace(/\}\}\s*$/, '');
  const params = {};
  for (const part of splitTopLevel(inner, '|')) {
    const eq = indexOfTopLevelEquals(part);
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key) params[key] = value;
  }
  return params;
}


/** Parsea metadatos desde el nombre del archivo (italiano/español/inglés descriptivo). */
function parseFilenameMetadata(title) {
  if (!title) return {};
  let name = title.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').trim();
  name = name.replace(/\s*-\s*Cleveland Museum of Art$/i, '').replace(/\s*\(\d{6,}\)\s*$/, '').trim();
  const out = { titulo: name.replace(/_/g, ' ') };
  const lower = name.toLowerCase();
  // Fecha en el nombre
  const mixedM = name.match(/(\d{3,4})\s*(ac|a\.c\.|bc)\s*[-–]\s*(\d{3,4})\s*(dc|d\.c\.|ad)/i);
  const rangeM = mixedM ? null : name.match(/(\d{3,4})\s*[-–]\s*(\d{3,4})\s*(ac|dc|a\.c\.|d\.c\.|bc|ad)?/i);
  if (mixedM) out.fecha = `${mixedM[1]} a. C.–${mixedM[3]} d. C.`;
  const romanM = name.match(/\b([IVX]+)\s*[-–]\s*([IVX]+)\s+secolo/i);
  if (romanM) out.fecha = `${romanM[1]}–${romanM[2]} siglo`;
  else if (mixedM) { /* fecha ya asignada */ }
  else if (rangeM) {
    const eraRaw = (rangeM[3] || '').toLowerCase().replace(/[\.\s]/g, '');
    const era = /ac|bc/.test(eraRaw) ? 'a. C.' : /dc|ad/.test(eraRaw) ? 'd. C.' : '';
    out.fecha = era ? `${rangeM[1]}–${rangeM[2]} ${era}` : `${rangeM[1]}–${rangeM[2]}`;
  } else {
    const singleM = name.match(/(\d{3,4})\s*(ac|dc)\b/i);
    if (singleM) out.fecha = `${singleM[1]} ${/ac/i.test(singleM[2]) ? 'a. C.' : 'd. C.'}`;
  }
  // Cultura
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const cultureRe = /\b(maya|lambayeque|sican|nazca|nasca|inca|calima|yotoco|valdivia|cocle|moche|chavin|aztec|olmec|zapotec|mixtec|toltec|teotihuacan|wari|tiahuanaco|tiwanaku|chimu|paracas|pachacamac|huastec|huaxtec|jaina)\b/i;
  if (/\bmaya\b/i.test(normalized)) out.estilo_cultura = 'Maya';
  else {
    const cm = normalized.match(cultureRe);
    if (cm) out.estilo_cultura = cm[1][0].toUpperCase() + cm[1].slice(1);
  }
  // Material
  if (/\boro\b|gold/i.test(name)) out.material_tecnica = 'Gold';
  else if (/plata|silver/i.test(name)) out.material_tecnica = 'Silver';
  else if (/diorite|diorita/i.test(name)) out.material_tecnica = 'Diorite';
  else if (/obsidian|obsidiana/i.test(name)) out.material_tecnica = 'Obsidian';
  else if (/jade|jadeite/i.test(name)) out.material_tecnica = 'Jade';
  else if (/ceramic|cerámica|terracotta/i.test(name)) out.material_tecnica = 'Ceramic';
  else if (/stone|piedra|basalt/i.test(name)) out.material_tecnica = 'Stone';
  else if (/tessil|textil/i.test(name)) out.material_tecnica = 'Textile';
  // Lugar: primer segmento si es país/región
  const firstSeg = name.split(',')[0].trim();
  if (/^(ecuador|colombia|panama|panamá|peru|perú|mexico|méxico|guatemala|honduras|costa rica|bolivia|chile|venezuela)\b/i.test(firstSeg)) out.lugar_origen = firstSeg;
  else if (/costa del nord|north coast/i.test(name)) out.lugar_origen = 'Peru, North Coast';
  else if (/costa del sud|south coast/i.test(name)) out.lugar_origen = 'Peru, South Coast';
  else if (/ande centrali|central andes/i.test(name)) out.lugar_origen = 'Central Andes';
  else if (/\bmessico\b/i.test(name)) out.lugar_origen = 'Mexico';
  else if (/\bpachacamac\b/i.test(name)) out.lugar_origen = 'Peru';
  // Lugar en medio del nombre: "600–900 Mexico, Campeche, Jaina Island, Maya"
  const mexM = name.match(/\b(Mexico(?:,\s*[^,]+){0,2})/i);
  if (!out.lugar_origen && mexM) out.lugar_origen = mexM[1].trim();
  return out;
}

/** Extrae pistas de cultura/material desde [[Category:...]] */
function parseCategories(wikitext) {
  if (!wikitext) return {};
  const cats = [...wikitext.matchAll(/\[\[Category:([^\]|]+)/gi)].map(m => m[1].trim());
  const out = {};
  const cultureRe = /\b(Lambayeque|Sicán|Sican|Nazca|Nasca|Inca|Calima|Yotoco|Valdivia|Coclé|Cocle|Moche|Chavin|Chavín|Maya|Aztec|Olmec|Zapotec|Mixtec|Toltec|Teotihuacan|Wari|Tiahuanaco|Tiwanaku|Chimu|Chimú|Nicoya|Colima|Michoacán|Michoacan|Paracas|Pachacamac|Huastec|Huaxtec)\b/i;
  for (const c of cats) {
    if (!out.estilo_cultura) {
      const m = c.match(cultureRe);
      if (m) out.estilo_cultura = m[1];
    }
    if (!out.lugar_origen) {
      const pm = c.match(/^Pre-Columbian art of (.+)$/i);
      if (pm) out.lugar_origen = pm[1].trim();
    }
    if (!out.material_tecnica) {
      if (/gold|oro|golden/i.test(c)) out.material_tecnica = 'Gold';
      else if (/silver|plata/i.test(c)) out.material_tecnica = 'Silver';
      else if (/obsidian/i.test(c)) out.material_tecnica = 'Obsidian';
      else if (/jade/i.test(c)) out.material_tecnica = 'Jade';
      else if (/ceramic|terracotta|earthenware/i.test(c)) out.material_tecnica = 'Ceramic';
      else if (/basalt|stone/i.test(c)) out.material_tecnica = 'Stone';
      else if (/textile/i.test(c)) out.material_tecnica = 'Textile';
    }
  }
  return out;
}

/** Parsea ficha {{Information}} (LACMA vía Flickr/WLA). */
function parseInformation(wikitext) {
  const block = extractInformationBlock(wikitext);
  if (!block) return null;
  const p = parseTemplateParamsGeneric(block, 'Information');
  const get = (k) => (p[k] !== undefined && p[k] !== '' ? p[k] : null);
  const rawDesc = get('description') || '';
  const description = cleanWikiValue(rawDesc);
  const out = {
    titulo: null,
    descripcion: description,
    fecha: null, // Date en {{Information}} es fecha de la foto, no de la pieza
    material_tecnica: null,
    dimensiones: null,
    creditos: null,
    autor: cleanWikiValue(get('author')),
    numero_inventario: null,
    url_objeto: null,
    lugar_origen: null,
    estilo_cultura: null,
    tipo_objeto: null,
  };
  // Descripción multi-línea LACMA: "Mexico, probably Guerrero, Olmec\nBloodletter Handle, 1000-600BC\nJadeite\nGift...\nAC1993.217.1"
  const descText = rawDesc.replace(/\{\{\s*en\s*\|[^}]*?\}\}/gi, (m) => {
    const inner = m.replace(/^\{\{\s*en\s*\|/i, '').replace(/\}\}$/, '');
    const eq = inner.indexOf('=');
    return eq >= 0 ? inner.slice(eq + 1) : inner;
  });
  const lines = descText.split(/\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const acc = line.match(/^(AC)?(\d{4}\.\d+(?:\.\d+)?)$/i);
    if (acc && !out.numero_inventario) { out.numero_inventario = line.toUpperCase(); continue; }
    if (/^accession\s*#/i.test(line)) continue;
    if (/^location\s*:/i.test(line)) continue;
    if (/^team\s*:/i.test(line)) continue;
    if (/^gift of/i.test(line)) { out.creditos = cleanWikiValue(line); continue; }
    if (/^\d{4}\s*[-–—]?\s*\d{0,4}\s*(bc|bce|ad|ce)?$/i.test(line) || /,\s*\d{3,4}\s*[-–—]?\s*\d{0,4}\s*(bc|bce)?$/i.test(line)) {
      // línea "Título, fecha" o solo fecha
      const parts = line.split(',');
      if (parts.length > 1) {
        out.titulo = cleanWikiValue(parts.slice(0, -1).join(','));
        out.fecha = parseArtworkDate(parts[parts.length - 1]);
      } else {
        out.fecha = parseArtworkDate(line);
      }
      continue;
    }
    if (!out.lugar_origen && line.length < 120 && /,/.test(line) && /mexico|guerrero|olmec|maya|aztec|inca|peru|ecuador|guatemala|honduras|belize/i.test(line)) {
      const { lugar, cultura } = parsePlaceAndCulture(line, description);
      out.lugar_origen = lugar || line;
      out.estilo_cultura = cultura;
      continue;
    }
    if (!out.material_tecnica && /^[A-Z][a-z]+(?:ite|e|a)?$/.test(line) && line.length < 30) {
      out.material_tecnica = cleanWikiValue(line);
      continue;
    }
  }
  if (!out.titulo) out.titulo = cleanWikiValue(get('title'));
  // Fecha/materia/lugar desde la descripción libre (p. ej. Coclé pendant)
  if (description) {
    if (!out.fecha) {
      const dm = description.match(/between\s+(\d{3,4})\s+and\s+(\d{3,4})\s*(AD|BC|a\.C\.|d\.C\.)?/i);
      if (dm) {
        const era = /bc/i.test(dm[3] || '') ? 'a. C.' : 'd. C.';
        out.fecha = `${dm[1]}–${dm[2]} ${era}`;
      } else {
        const sm = description.match(/(\d{3,4})\s*[-–]\s*(\d{3,4})\s*(AD|BC)/i);
        if (sm) out.fecha = `${sm[1]}–${sm[2]} ${/bc/i.test(sm[3]) ? 'a. C.' : 'd. C.'}`;
      }
    }
    if (!out.material_tecnica && /\bgold\b|\boro\b/i.test(description)) out.material_tecnica = 'Gold';
    if (!out.material_tecnica && /\bjade\b/i.test(description)) out.material_tecnica = 'Jade';
    if (!out.lugar_origen) {
      const lm = description.match(/from the\s+([^,\.]+?)(?:\s+region)?\s+of\s+([^,\.]+)/i);
      if (lm) out.lugar_origen = `${lm[1].trim()}, ${lm[2].trim()}`;
      else if (/\bPanama\b/i.test(description)) out.lugar_origen = 'Panama';
    }
  }
  return out;
}

/** Parsea la ficha {{Artwork}} de un wikitexto; null si no hay plantilla. */
function parseArtwork(wikitext) {
  const block = extractArtworkBlock(wikitext);
  if (!block) return parseInformation(wikitext);
  const p = parseTemplateParams(block);
  const get = (k) => (p[k] !== undefined && p[k] !== '' ? p[k] : null);

  const description = cleanWikiValue(get('description'));
  const title = cleanWikiValue(get('title'));
  const date = parseArtworkDate(get('date'));
  const medium = cleanWikiValue(get('medium'));
  const dimensions = parseArtworkDimensions(get('dimensions'));
  const institution = cleanWikiValue(get('institution'));
  const creditLine = cleanWikiValue(get('credit line'));
  const accession = cleanWikiValue(get('accession number'));
  const sourceRaw = get('source');
  const sourceUrl = (() => {
    if (!sourceRaw) return null;
    const m = sourceRaw.match(/https?:\/\/[^\s\]}{]+/);
    return m ? m[0] : null;
  })();
  const sourceName = sourceUrl ? null : cleanWikiValue(sourceRaw);
  const author = cleanWikiValue(get('artist') || get('author'));
  const { lugar, cultura } = parsePlaceAndCulture(get('place of creation'), description);
  const lacma = parseLacmaDescription(get('description'));
  const met = parseMetDescription(description);
  const mapped = parseMappedJsonCulture(wikitext);

  const readableDesc = lacma.lugar_raw
    ? [lacma.lugar_raw, lacma.tipo_objeto, lacma.material_tecnica, lacma.dimensiones, lacma.creditos].filter(Boolean).join(' · ')
    : (description || null);
  return {
    titulo: title || null,
    descripcion: readableDesc,
    fecha: date,
    material_tecnica: medium || lacma.material_tecnica || null,
    dimensiones: dimensions || lacma.dimensiones || null,
    creditos: creditLine || lacma.creditos || institution || sourceName || null,
    autor: author,
    numero_inventario: accession && /^(AC)?\d{4}\.\d+(?:\.\d+)?$/i.test(accession) ? accession.toUpperCase() : (accession || null),
    url_objeto: sourceUrl && !/collections\.lacma\.org\/sites\/default\/files\/remote_images/i.test(sourceUrl) ? sourceUrl : null,
    lugar_origen: lugar || (() => {
      if (!lacma.lugar_raw) return null;
      const { lugar: l2, cultura: c2 } = parsePlaceAndCulture(lacma.lugar_raw, null);
      return l2 || lacma.lugar_raw.split(',').slice(0, 2).join(',').trim();
    })(),
    estilo_cultura: cultura || met.estilo_cultura || mapped.estilo_cultura || (() => {
      if (!lacma.lugar_raw) return null;
      const { cultura: c2 } = parsePlaceAndCulture(lacma.lugar_raw, null);
      return c2;
    })() || null,
    tipo_objeto: lacma.tipo_objeto || met.tipo_objeto || mapped.tipo_objeto || null,
  };
}

/** Enriquece cada item con su ficha {{Artwork}} sin pisar datos de Wikidata. */
function enrichWithCommonsArtwork(items) {
  return items.map(item => {
    let art = parseArtwork(item.wikitext);
    const fileMeta = parseFilenameMetadata(item.title);
    const catMeta = parseCategories(item.wikitext);
    if (!art) {
      art = { titulo: fileMeta.titulo || null, descripcion: null, fecha: fileMeta.fecha || null, material_tecnica: fileMeta.material_tecnica || catMeta.material_tecnica || null, dimensiones: null, creditos: null, autor: null, numero_inventario: null, url_objeto: null, lugar_origen: fileMeta.lugar_origen || null, estilo_cultura: fileMeta.estilo_cultura || catMeta.estilo_cultura || null, tipo_objeto: null };
    } else {
      // Fallbacks desde nombre/categorías cuando la ficha no trae el campo
      if (!art.titulo) art.titulo = fileMeta.titulo;
      if (!art.fecha) art.fecha = fileMeta.fecha;
      if (!art.material_tecnica) art.material_tecnica = fileMeta.material_tecnica || catMeta.material_tecnica;
      if (!art.lugar_origen) art.lugar_origen = fileMeta.lugar_origen;
      if (!art.estilo_cultura) art.estilo_cultura = fileMeta.estilo_cultura || catMeta.estilo_cultura;
    }
    if (!art) return item;
    const merged = { ...item };
    const fill = (key, value, sourceKey) => {
      if (value && !merged[key]) {
        merged[key] = value;
        if (sourceKey) merged[sourceKey] = 'commons';
      }
    };
    fill('titulo', art.titulo);
    fill('descripcion', art.descripcion);
    fill('fecha', art.fecha);
    fill('material_tecnica', art.material_tecnica);
    fill('dimensiones', art.dimensiones);
    fill('creditos', art.creditos);
    fill('autor', art.autor);
    fill('numero_inventario', art.numero_inventario);
    fill('url_objeto', art.url_objeto);
    fill('lugar_origen', art.lugar_origen, 'lugar_origen_source');
    fill('estilo_cultura', art.estilo_cultura, 'estilo_cultura_source');
    fill('tipo_objeto', art.tipo_objeto);
    // Accession desde la URL del museo (p. ej. clevelandart.org/art/1980.127);
    // corrige accesiones truncadas en la ficha (p. ej. "1996.4" -> "1996.400")
    if (merged.url_objeto) {
      const um = merged.url_objeto.match(/(\d{4}\.\d+(?:\.\d+)?)/);
      if (um) {
        const urlAcc = um[1];
        if (!merged.numero_inventario) merged.numero_inventario = urlAcc;
        else if (urlAcc.length > merged.numero_inventario.length && urlAcc.startsWith(merged.numero_inventario)) merged.numero_inventario = urlAcc;
      }
    }
    // Seguridad: campos varchar(255) no deben desbordar la BD
    for (const k of ['titulo','lugar_origen','estilo_cultura','fecha','tipo_objeto','material_tecnica','dimensiones','creditos','numero_inventario','url_objeto']) {
      if (typeof merged[k] === 'string' && merged[k].length > 255) merged[k] = merged[k].slice(0, 255);
    }
    return merged;
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
/** Parsea "Inv.Nr.-2025.1280" del título de Commons; null si no trae. */
function parseInventory(title) {
  if (!title) return null;
  const m = title.match(/Inv\.Nr\.?(\d{4}\.\d+(?:\.\d+)*)/i);
  if (m) return m[1];
  // Fallback Cleveland / museos con accession "YYYY.NNN[.M]" en el título.
  const acc = title.match(/(\d{4}\.\d+(?:\.\d+)?)/);
  return acc ? acc[1] : null;
}

/** Reproduce exactamente los títulos automáticos de las versiones anteriores. */
function legacyGeneratedTitle(title) {
  if (!title) return 'Sin título';
  let t = title.replace(/^File:/i, '');
  t = t.replace(/\.[a-z0-9]+$/i, '');
  return t.replace(/_/g, ' ').trim() || 'Sin título';
}

function isLegacyGeneratedTitle(existingTitle, commonsTitle) {
  return Boolean(existingTitle) && existingTitle === legacyGeneratedTitle(commonsTitle);
}

/** Convierte el nombre técnico de Commons en un título legible. */
function cleanTitle(title) {
  if (!title) return 'Sin título';
  let t = title.replace(/^File:/i, '');
  t = t.replace(/\.[a-z]{2,5}$/i, '');
  t = t.replace(/^(?:(?:museum[-_\s]+rietberg)(?:[-_\s]+(?:zürich|zurich))?[-_\s]*)+/i, '');
  t = t.replace(/(?:^|[-_\s])inv\.?\s*nr\.?[-_\s]*\d{4}(?:\.\d+)+(?:[-_\s]*)/ig, ' ');
  t = t.replace(/(?:^|[-_\s])\d{4}(?:\.\d+)+(?:$|[-_\s])/g, ' ');
  return t.replace(/[-_–—]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sin título';
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** True si el archivo es un recorte/detalle, no la foto principal de la pieza. */
function isCroppedOrDetail(title) {
  return /\(cropped\)|\bdetail\b|\bdeatil\b/i.test(title || '');
}

/** Extrae el accession "YYYY.NNN[.M]" del título; null si no trae. */
function extractAccession(title) {
  const m = (title || '').match(/(\d{4}\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** Puntúa qué foto conservar cuando hay varias del mismo accession. */
function accessionScore(item) {
  const t = item.title || '';
  let score = 0;
  if (/^File:Clevelandart \d{4}\.\d+(?:\.\d+)?\.jpg$/i.test(t)) score += 30;
  else if (/^File:Clevelandart /i.test(t)) score += 20;
  if (/\.jpg$/i.test(t)) score += 10;
  if (/\.tif{1,2}$/i.test(t)) score -= 10;
  if (/Cleveland Museum of Art/i.test(t)) score -= 2;
  // Vistas múltiples (Met "VS1994 389 3/4"): preferir la vista con número menor
  const viewMatch = t.match(/\bVS\d{4}[\s_]+\d+[\s_]+(\d+)\b/i) || t.match(/\s(\d{1,2})\.(?:jpg|jpeg|png|tif)$/i);
  if (viewMatch) score -= parseInt(viewMatch[1], 10);
  return score;
}

/**
 * Deduplica por accession number (Cleveland, etc.):
 *  - descarta recortes/detalles "(cropped)", "Detail", "Deatil"
 *  - por accession conserva solo la mejor foto (principal .jpg)
 *  - "1967.155.1" y "1967.155.2" se tratan como piezas distintas
 * Devuelve { kept, skippedCropped, skippedDuplicates }.
 */
function deduplicateByAccession(items) {
  const skippedCropped = [];
  const candidates = [];
  for (const item of items) {
    if (isCroppedOrDetail(item.title)) skippedCropped.push(item);
    else candidates.push(item);
  }
  const groups = new Map();
  const kept = [];
  for (const item of candidates) {
    const acc = item.numero_inventario || extractAccession(item.title);
    if (!acc) { kept.push(item); continue; }
    if (!groups.has(acc)) groups.set(acc, []);
    groups.get(acc).push(item);
  }
  const skippedDuplicates = [];
  for (const [acc, group] of groups) {
    if (group.length === 1) { kept.push(group[0]); continue; }
    const ranked = [...group].sort((a, b) => accessionScore(b) - accessionScore(a));
    kept.push(ranked[0]);
    skippedDuplicates.push(...ranked.slice(1));
  }
  kept.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return { kept, skippedCropped, skippedDuplicates };
}

// ── 3. Upsert en BD ─────────────────────────────────────────────────────────
async function ensureCollection(category) {
  const slug = category
    .replace(/^Category:/i, '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  const { rows } = await db.query(
    `INSERT INTO colecciones (nombre, categoria_commons, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (categoria_commons) DO UPDATE
       SET nombre = EXCLUDED.nombre, slug = EXCLUDED.slug, updated_at = now()
     RETURNING id`,
    [category.replace(/^Category:/i, ''), category, slug]
  );
  return rows[0].id;
}

async function saveObject(pool, coleccionId, item) {
  const inventario = parseInventory(item.title);
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;

    const { rows } = await client.query(
      `SELECT id, coleccion_id, commons_title, numero_inventario, titulo
       FROM objetos
       WHERE commons_title = $1
          OR ($2::varchar IS NOT NULL
              AND coleccion_id = $3
              AND numero_inventario = $2)
       FOR UPDATE`,
      [item.title, inventario, coleccionId]
    );
    const byTitle = rows.find(row => row.commons_title === item.title);
    const byInventory = inventario
      ? rows.find(row => row.numero_inventario === inventario && row.coleccion_id === coleccionId)
      : null;

    if (byTitle && byInventory && byTitle.id !== byInventory.id) {
      throw new Error(`El título Commons y el inventario ${inventario} apuntan a objetos distintos`);
    }

    const existing = byTitle || byInventory;
    if (existing?.commons_title && existing.commons_title !== item.title) {
      throw new Error(`El inventario ${inventario} ya está asociado a ${existing.commons_title}`);
    }

    const title = cleanTitle(item.title);
    const repairLegacyTitle = isLegacyGeneratedTitle(existing?.titulo, item.title);

    if (!existing) {
      await client.query(
        `INSERT INTO objetos (
           coleccion_id, commons_title, commons_pageid, thumb_url,
           imagen_url, numero_inventario, titulo, dimensiones,
           image_width, image_height, mime, lugar_origen, estilo_cultura,
           fecha, tipo_objeto, material_tecnica, url_objeto, lat, lon,
           estilo_cultura_source, lugar_origen_source, descripcion
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          coleccionId,
          item.title,
          item.pageid ?? null,
          item.thumburl ?? null,
          item.url ?? null,
          inventario,
          title,
          item.dimensiones ?? null,
          item.width ?? null,
          item.height ?? null,
          item.mime ?? null,
          item.lugar_origen ?? null,
          item.estilo_cultura ?? null,
          item.fecha ?? null,
          item.tipo_objeto ?? null,
          item.material_tecnica ?? null,
          item.url_objeto ?? null,
          item.lat ?? null,
          item.lon ?? null,
          item.estilo_cultura_source || 'wikidata',
          item.lugar_origen_source || 'wikidata',
          item.descripcion ?? null,
        ]
      );
      await client.query('COMMIT');
      inTransaction = false;
      return 'inserted';
    }

    const { rowCount } = await client.query(
      `UPDATE objetos SET
         commons_title = COALESCE(commons_title, $2::text),
         titulo = CASE WHEN $3::boolean THEN $8::varchar ELSE titulo END,
         commons_pageid = COALESCE($4::integer, commons_pageid),
         thumb_url = COALESCE($5::text, thumb_url),
         imagen_url = COALESCE($6::text, imagen_url),
         numero_inventario = COALESCE(numero_inventario, $7::varchar),
         image_width = COALESCE($9::integer, image_width),
         image_height = COALESCE($10::integer, image_height),
         mime = COALESCE($11::text, mime),
         dimensiones = COALESCE($12::varchar, dimensiones),
         lugar_origen = CASE WHEN lugar_origen_source IN ('wikidata', 'commons') THEN $13::varchar ELSE lugar_origen END,
         estilo_cultura = CASE WHEN estilo_cultura_source IN ('wikidata', 'commons') THEN $14::varchar ELSE estilo_cultura END,
         fecha = COALESCE($15::varchar, fecha),
         tipo_objeto = COALESCE($16::varchar, tipo_objeto),
         material_tecnica = COALESCE($17::text, material_tecnica),
         url_objeto = COALESCE($18::text, url_objeto),
         lat = COALESCE($19::double precision, lat),
         lon = COALESCE($20::double precision, lon),
         descripcion = COALESCE(descripcion, $21::text)
       WHERE id = $1 AND (
         commons_title IS DISTINCT FROM $2::text
         OR ($3::boolean AND titulo IS DISTINCT FROM $8::varchar)
         OR ($4::integer IS NOT NULL AND commons_pageid IS DISTINCT FROM $4::integer)
         OR ($5::text IS NOT NULL AND thumb_url IS DISTINCT FROM $5::text)
         OR ($6::text IS NOT NULL AND imagen_url IS DISTINCT FROM $6::text)
         OR (numero_inventario IS NULL AND $7::varchar IS NOT NULL)
         OR ($9::integer IS NOT NULL AND image_width IS DISTINCT FROM $9::integer)
         OR ($10::integer IS NOT NULL AND image_height IS DISTINCT FROM $10::integer)
         OR ($11::text IS NOT NULL AND mime IS DISTINCT FROM $11::text)
         OR ($12::varchar IS NOT NULL AND dimensiones IS DISTINCT FROM $12::varchar)
         OR (lugar_origen_source IN ('wikidata', 'commons') AND lugar_origen IS DISTINCT FROM $13::varchar)
         OR (estilo_cultura_source IN ('wikidata', 'commons') AND estilo_cultura IS DISTINCT FROM $14::varchar)
         OR ($15::varchar IS NOT NULL AND fecha IS DISTINCT FROM $15::varchar)
         OR ($16::varchar IS NOT NULL AND tipo_objeto IS DISTINCT FROM $16::varchar)
         OR ($17::text IS NOT NULL AND material_tecnica IS DISTINCT FROM $17::text)
         OR ($18::text IS NOT NULL AND url_objeto IS DISTINCT FROM $18::text)
         OR ($19::double precision IS NOT NULL AND lat IS DISTINCT FROM $19::double precision)
         OR ($20::double precision IS NOT NULL AND lon IS DISTINCT FROM $20::double precision)
         OR ($21::text IS NOT NULL AND descripcion IS DISTINCT FROM $21::text)
       )
       RETURNING id`,
      [
        existing.id,
        item.title,
        repairLegacyTitle,
        item.pageid ?? null,
        item.thumburl ?? null,
        item.url ?? null,
        inventario,
        title,
        item.width ?? null,
        item.height ?? null,
        item.mime ?? null,
        item.dimensiones ?? null,
        item.lugar_origen ?? null,
        item.estilo_cultura ?? null,
        item.fecha ?? null,
        item.tipo_objeto ?? null,
        item.material_tecnica ?? null,
        item.url_objeto ?? null,
        item.lat ?? null,
        item.lon ?? null,
        item.descripcion ?? null,
      ]
    );

    await client.query('COMMIT');
    inTransaction = false;
    return rowCount ? 'updated' : 'unchanged';
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        err.message += ` (también falló ROLLBACK: ${rollbackError.message})`;
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const { category, dryRun, limit } = parseArgs(process.argv);

  console.log(`\n📚 Sincronizando colección Commons: ${category}`);
  if (dryRun) console.log('   (dry-run: no se escribirá en la BD)');

  // 1. Listar
  console.log('\n1/3 Listando archivos de la categoría...');
  let files = await listCategoryFiles(category);
  console.log(`   ${files.length} archivos encontrados.`);
  if (limit) files = files.slice(0, limit);

  // 2. Enriquecer
  console.log('\n2/3 Enriqueciendo con imageinfo (lotes de 50)...');
  const enriched = [];
  const batches = chunk(files.map(f => f.title), BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    const batch = await enrichBatch(batches[i]);
    enriched.push(...batch);
    console.log(`   lote ${i + 1}/${batches.length}: ${batch.length} piezas`);
    if (i < batches.length - 1) await sleep(BASE_DELAY_MS);
  }

  const rawWithImage = enriched.filter(e => e.url);
  console.log(`   ${rawWithImage.length}/${enriched.length} con imagen disponible.`);

  console.log('\n2b/3 Enriqueciendo metadatos y coordenadas desde Wikidata...');
  const withWikidata = await enrichWithWikidata(rawWithImage);
  const withImage = enrichWithCommonsArtwork(withWikidata);
  const conLugar = withImage.filter(e => e.lugar_origen).length;
  const conCoords = withImage.filter(e => e.lat != null && e.lon != null).length;
  console.log(`   ${conLugar}/${withImage.length} con lugar_origen, ${conCoords}/${withImage.length} con coordenadas.`);

  // 2c. Deduplicación por accession (Cleveland: recortes/detalles y .tif duplicados)
  const { kept, skippedCropped, skippedDuplicates } = deduplicateByAccession(withImage);
  if (skippedCropped.length || skippedDuplicates.length) {
    console.log(`\n2c/3 Deduplicación por accession:`);
    console.log(`   ${skippedCropped.length} recortes/detalles omitidos, ${skippedDuplicates.length} duplicados por accession omitidos.`);
    for (const d of skippedDuplicates) {
      console.log(`   - duplicado omitido: ${d.title}`);
    }
    console.log(`   ${withImage.length} \u2192 ${kept.length} piezas únicas.`);
  }
  const deduped = kept;

  // Reportar archivos sin ficha de objeto (p. ej. fotos de sala/museo en Met)
  const sinFicha = deduped.filter(e => !e.titulo && !e.descripcion && !e.numero_inventario);
  if (sinFicha.length) {
    console.log(`\n⚠️ ${sinFicha.length} archivos sin ficha de objeto (sin título/descripción/accession) — revisar antes de sincronizar:`);
    for (const e of sinFicha) console.log(`   - ${e.title}`);
  }

  if (dryRun) {
    console.log('\n3/3 Dry-run terminado. Primeras 5 piezas:');
    deduped.slice(0, 5).forEach(e => {
      console.log(`   - ${e.title} | lugar=${e.lugar_origen || 'N/A'} | coords=${e.lat ?? 'N/A'},${e.lon ?? 'N/A'}`);
    });
    console.log('\n✅ Sin cambios en la BD.');
    process.exit(0);
  }

  // 3. Guardar
  console.log('\n3/3 Guardando en la BD...');
  const counts = { inserted: 0, updated: 0, unchanged: 0, failed: 0 };
  try {
    const coleccionId = await ensureCollection(category);
    console.log(`   colección id=${coleccionId}`);

    for (const item of deduped) {
      try {
        counts[await saveObject(db, coleccionId, item)]++;
      } catch (err) {
        counts.failed++;
        console.warn(`   ⚠️ ${item.title}: ${err.message}`);
      }
    }
  } catch (err) {
    counts.failed = deduped.length;
    console.error(`   ❌ No se pudo preparar la colección: ${err.message}`);
  }

  console.log(
    `\nResultado: ${counts.inserted} insertadas, ${counts.updated} actualizadas, ` +
    `${counts.unchanged} sin cambios, ${counts.failed} fallidas.`
  );
  console.log('   Siguiente paso (opcional): npm run download  ← descarga imágenes locales');
  if (counts.failed) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch(err => {
      console.error('\n💥 Error:', err.message);
      if (/colecciones|commons_title|thumb_url|uk_inventario_coleccion/.test(err.message)) {
        console.error('   Parece que falta la migración. Corre primero:');
        console.error('   node scripts/migrate-colecciones.js');
      }
      process.exitCode = 1;
    })
    .finally(() => db.end());
}

module.exports = {
  BATCH_SIZE,
  chunk,
  deduplicateByAccession,
  enrichWithCommonsArtwork,
  parseArtwork,
  extractAccession,
  isCroppedOrDetail,
  cleanTitle,
  enrichBatch,
  extractDimensions,
  extractFecha,
  fetchWikidataEntities,
  getClaimIds,
  getLabel,
  isLegacyGeneratedTitle,
  legacyGeneratedTitle,
  parseInventory,
  saveObject,
};
