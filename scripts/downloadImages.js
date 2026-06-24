#!/usr/bin/env node
/**
 * scripts/downloadImages.js  v3  — "skip-and-resume" para Wikimedia
 * ─────────────────────────────────────────────────────────────────
 * Estrategia:
 *  · En 429 → NO esperar, marcar como pendiente y continuar con el siguiente.
 *  · Ejecutar varias veces: cada pasada descarga más hasta completar los 681.
 *  · 1 imagen a la vez, 6-10 s de delay, headers de navegador real.
 *  · Reanuda automáticamente: omite lo que ya está en disco.
 *
 * USO:
 *   npm run download           ← primera pasada / reanudación
 *   npm run download           ← segunda pasada (reintenta los 429 previos)
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const PQueue      = require('p-queue').default ?? require('p-queue');
const cliProgress = require('cli-progress');
const sharp       = require('sharp');
const db          = require('../config/db');

// ── Ajustes ────────────────────────────────────────────────────────────────
const CONCURRENCY  = 1;
const DELAY_MIN_MS = 6_000;   // 6 s
const DELAY_MAX_MS = 10_000;  // 10 s
const TIMEOUT_MS   = 35_000;
const MAX_RETRIES  = 2;       // sólo para errores de red, NO para 429
const THUMB_WIDTH  = 300;

const PUBLIC_DIR  = path.join(__dirname, '..', 'public', 'images');
const THUMB_DIR   = path.join(PUBLIC_DIR, 'thumbnails');
const REPORT_FILE = path.join(__dirname, '..', 'download-report.json');

[PUBLIC_DIR, THUMB_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Headers de navegador real (no de bot) ─────────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept'          : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language' : 'es-MX,es;q=0.9,en;q=0.8',
  'Accept-Encoding' : 'gzip, deflate, br',
  'Referer'         : 'https://commons.wikimedia.org/',
  'Sec-Fetch-Dest'  : 'image',
  'Sec-Fetch-Mode'  : 'no-cors',
  'Sec-Fetch-Site'  : 'cross-site',
  'Cache-Control'   : 'no-cache',
  'Connection'      : 'keep-alive',
};

// ── Helpers ────────────────────────────────────────────────────────────────
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const randDelay = ()  => sleep(DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

/** Normaliza URL: deshace doble encoding */
function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    let decoded = url.pathname;
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    url.pathname = decoded.split('/').map(s => encodeURIComponent(s)).join('/');
    return url.toString();
  } catch {
    return rawUrl.replace(/ /g, '%20');
  }
}

/** Extrae nombre de archivo de una URL de Wikimedia */
function getFilename(rawUrl) {
  try {
    let name = new URL(rawUrl).pathname.split('/').pop();
    for (let i = 0; i < 3; i++) {
      const n2 = decodeURIComponent(name);
      if (n2 === name) break;
      name = n2;
    }
    return name;
  } catch { return null; }
}

/**
 * Descarga una URL usando https nativo (menor fingerprint que axios).
 * Sigue redirects. Devuelve { ok, status, buffer } o { ok:false, status, error }.
 */
function downloadNative(url, redirectsLeft = 5) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      path    : parsed.pathname + parsed.search,
      headers : BROWSER_HEADERS,
      timeout : TIMEOUT_MS,
    };

    const req = lib.get(opts, (res) => {
      // Seguir redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (loc && redirectsLeft > 0) {
          res.resume();
          const newUrl = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.hostname}${loc}`;
          return resolve(downloadNative(newUrl, redirectsLeft - 1));
        }
        return resolve({ ok: false, status: res.statusCode, error: 'too many redirects' });
      }

      if (res.statusCode === 429) {
        res.resume();
        return resolve({ ok: false, status: 429, error: '429' });
      }

      if (res.statusCode === 404) {
        res.resume();
        return resolve({ ok: false, status: 404, error: '404' });
      }

      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ ok: true, status: 200, buffer: Buffer.concat(chunks) }));
      res.on('error', err => resolve({ ok: false, status: 0, error: err.message }));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'timeout' });
    });
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }));
  });
}

/**
 * Consulta la API de Commons para obtener la URL real del archivo.
 * Útil cuando el hash en la BD es incorrecto.
 */
async function commonsApiUrl(filename) {
  if (!filename) return null;
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      action: 'query', format: 'json', prop: 'imageinfo',
      iiprop: 'url', titles: `File:${filename}`, origin: '*',
    });
    const opts = {
      hostname: 'commons.wikimedia.org',
      path    : `/w/api.php?${params}`,
      headers : { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
      timeout : 12_000,
    };
    const req = https.get(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data  = JSON.parse(Buffer.concat(chunks).toString());
          const pages = data?.query?.pages;
          if (!pages) return resolve(null);
          const page = Object.values(pages)[0];
          if (page?.missing !== undefined) return resolve(null);
          resolve(page?.imageinfo?.[0]?.url || null);
        } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * Intenta descargar con reintentos para errores de red.
 * En 429 devuelve { ok:false, status:429 } INMEDIATAMENTE (sin esperar).
 */
async function tryDownload(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await downloadNative(url);

    if (result.ok)               return result;
    if (result.status === 429)   return result;  // ← saltar, NO esperar
    if (result.status === 404)   return result;  // ← 404 definitivo

    // Error de red → reintentar con pequeño delay
    if (attempt < MAX_RETRIES) await sleep(4_000 * attempt);
  }
  return { ok: false, status: 0, error: `${MAX_RETRIES} reintentos agotados` };
}

// ── Procesa un objeto ──────────────────────────────────────────────────────
async function processObject(obj, bar) {
  const inv = (obj.numero_inventario || '').trim();
  if (!inv) {
    bar.increment(1, { filename: '(sin inventario)' });
    return { id: obj.id, inv, status: 'skipped' };
  }

  const fname      = `${inv}.jpg`;
  const localPath  = path.join(PUBLIC_DIR, fname);
  const thumbPath  = path.join(THUMB_DIR, fname);
  const localRoute = `/images/${fname}`;
  const thumbRoute = `/images/thumbnails/${fname}`;

  // ── Ya existe: actualizar BD si falta y continuar ──────────────────────
  if (fs.existsSync(localPath) && fs.existsSync(thumbPath)) {
    if (!obj.imagen_local) {
      await db.query(
        'UPDATE objetos SET imagen_local = ?, thumbnail_local = ? WHERE id = ?',
        [localRoute, thumbRoute, obj.id]
      );
    }
    bar.increment(1, { filename: `♻  ${inv}` });
    return { id: obj.id, inv, status: 'already_exists' };
  }

  // ── Delay antes de cada petición real ──────────────────────────────────
  await randDelay();

  // ── Intentar URL normalizada ────────────────────────────────────────────
  let imageUrl = normalizeUrl(obj.imagen_url);
  let result   = await tryDownload(imageUrl);

  // ── 429: saltar inmediatamente, marcar como pendiente ──────────────────
  if (result.status === 429) {
    bar.increment(1, { filename: `⏸  ${inv} [429→próxima pasada]` });
    return { id: obj.id, inv, status: 'rate_limited', url: imageUrl };
  }

  // ── 404: buscar URL correcta en API de Commons ─────────────────────────
  if (result.status === 404 || (!result.ok && result.status !== 429)) {
    const filename = getFilename(obj.imagen_url);
    const realUrl  = await commonsApiUrl(filename);
    if (realUrl && realUrl !== imageUrl) {
      await randDelay();
      result   = await tryDownload(realUrl);
      imageUrl = realUrl;
    }
  }

  if (!result.ok) {
    const label = result.status === 429 ? '⏸' : '❌';
    bar.increment(1, { filename: `${label} ${inv} [${result.error}]` });
    const status = result.status === 429 ? 'rate_limited' : 'error';
    return { id: obj.id, inv, status, error: result.error, url: imageUrl };
  }

  // ── Guardar imagen + thumbnail con Sharp ───────────────────────────────
  try {
    await sharp(result.buffer)
      .jpeg({ quality: 85, progressive: true })
      .toFile(localPath);
    await sharp(result.buffer)
      .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toFile(thumbPath);
  } catch {
    fs.writeFileSync(localPath, result.buffer);
    try {
      await sharp(localPath).resize(THUMB_WIDTH).jpeg({ quality: 80 }).toFile(thumbPath);
    } catch {
      fs.copyFileSync(localPath, thumbPath);
    }
  }

  // ── Actualizar BD ────────────────────────────────────────────────────────
  await db.query(
    'UPDATE objetos SET imagen_local = ?, thumbnail_local = ? WHERE id = ?',
    [localRoute, thumbRoute, obj.id]
  );

  bar.increment(1, { filename: inv });
  return { id: obj.id, inv, status: 'downloaded', localRoute, thumbRoute };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🖼️  Descargador de Imágenes — Museo Rietberg  v3');
  console.log('════════════════════════════════════════════════════');
  console.log('📋 Estrategia: skip-and-resume (los 429 se reintentan en la próxima pasada)');
  console.log('   Puedes interrumpir con Ctrl+C y volver a ejecutar.\n');

  const [rows] = await db.query(
    `SELECT id, numero_inventario, imagen_url, imagen_local
     FROM objetos WHERE imagen_url IS NOT NULL ORDER BY id`
  );

  // Separar: los que ya tienen imagen_local Y el archivo en disco
  const yaListo   = rows.filter(r => r.imagen_local &&
    fs.existsSync(path.join(PUBLIC_DIR, `${r.numero_inventario}.jpg`)));
  const pendientes = rows.filter(r => !yaListo.find(y => y.id === r.id));

  console.log(`📦 Total: ${rows.length} | ♻  En disco: ${yaListo.length} | ⏳ Pendientes: ${pendientes.length}\n`);

  if (pendientes.length === 0) {
    console.log('✅ ¡Todas las imágenes ya están descargadas!\n');
    process.exit(0);
  }

  // Tiempo estimado (sin contar 429s)
  const avgSec  = (DELAY_MIN_MS + DELAY_MAX_MS) / 2 / 1000 + 1;
  const estMin  = Math.round((pendientes.length * avgSec) / 60);
  console.log(`⏱  Tiempo estimado esta pasada: ~${estMin} min (sin contar 429s saltados)\n`);

  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {value}/{total} | {filename}',
    barCompleteChar:   '█',
    barIncompleteChar: '░',
    hideCursor: true,
    clearOnComplete: false,
  }, cliProgress.Presets.shades_classic);

  bar.start(rows.length, yaListo.length, { filename: 'Iniciando...' });

  const results = [
    ...yaListo.map(r => ({ status: 'already_exists', inv: r.numero_inventario }))
  ];

  const queue = new PQueue({ concurrency: CONCURRENCY });

  for (const obj of pendientes) {
    queue.add(async () => {
      const r = await processObject(obj, bar);
      results.push(r);
    });
  }

  const saveAndExit = () => { bar.stop(); printReport(results, rows.length); process.exit(0); };
  process.on('SIGINT',  saveAndExit);
  process.on('SIGTERM', saveAndExit);

  await queue.onIdle();
  bar.stop();
  printReport(results, rows.length);
  process.exit(0);
}

// ── Reporte ────────────────────────────────────────────────────────────────
function printReport(results, total) {
  const downloaded   = results.filter(r => r.status === 'downloaded');
  const existed      = results.filter(r => r.status === 'already_exists');
  const rateLimited  = results.filter(r => r.status === 'rate_limited');
  const errors       = results.filter(r => r.status === 'error');
  const err404       = errors.filter(r => r.error === '404');
  const unprocessed  = total - results.length;

  console.log('\n════════════════════════════════════════════════════');
  console.log('📊 RESUMEN DE ESTA PASADA');
  console.log('════════════════════════════════════════════════════');
  console.log(`✅ Descargadas:         ${downloaded.length}`);
  console.log(`♻️  Ya existían:         ${existed.length}`);
  console.log(`⏸  Saltadas (429):      ${rateLimited.length}  ← volver a ejecutar`);
  console.log(`❌ Errores (404/otros): ${errors.length}`);
  if (err404.length)  console.log(`   🔴 404 definitivo:  ${err404.length}`);
  if (unprocessed > 0) console.log(`⏳ Sin procesar:        ${unprocessed}  ← Ctrl+C prematuro`);

  const pending = rateLimited.length + unprocessed;
  if (pending > 0) {
    console.log(`\n🔁 Ejecuta de nuevo para obtener las ${pending} restantes:`);
    console.log('   npm run download\n');
  } else {
    console.log('\n🎉 ¡Descarga completada! La app ya no depende de Wikimedia.\n');
  }

  const report = {
    generated   : new Date().toISOString(),
    summary     : {
      total, downloaded: downloaded.length,
      already_existed: existed.length,
      rate_limited_skipped: rateLimited.length,
      errors: errors.length,
      errors_404: err404.length,
      unprocessed,
      pending_next_run: pending,
    },
    downloaded   : downloaded.map(r => ({ inv: r.inv, route: r.localRoute })),
    rate_limited : rateLimited.map(r => ({ inv: r.inv, url: r.url })),
    errors       : errors.map(r => ({ inv: r.inv, error: r.error, url: r.url })),
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`📄 Reporte: ${REPORT_FILE}`);
  console.log('════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n💥 Error fatal:', err.message);
  process.exit(1);
});
