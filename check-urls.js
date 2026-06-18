/**
 * check-urls.js
 * Verifica las 681 URLs de imágenes del museo_rietberg.sql
 * Uso: node check-urls.js
 */

const fs = require('fs');
const path = require('path');

const URLS_FILE = path.join(__dirname, 'all_image_urls.txt');
const REPORT_FILE = path.join(__dirname, 'url_report.json');
const CONCURRENCY = 20;   // peticiones paralelas
const TIMEOUT_MS = 12000; // 12 segundos por petición

// Detecta caracteres problemáticos ANTES del encode
function detectProblems(url) {
  const issues = [];
  // Espacios sin codificar
  if (/ /.test(url)) issues.push('unencoded_space');
  // Caracteres especiales no codificados fuera del hostname
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (/[<>"{}|\\^`]/.test(path)) issues.push('invalid_chars');
  // Doble encoding (%25 seguido de hex hex)
  if (/%25[0-9A-Fa-f]{2}/.test(url)) issues.push('double_encoded');
  // URL vacía o solo http
  if (!url || url.length < 15) issues.push('too_short');
  return issues;
}

// Intenta reparar una URL problemática
function fixUrl(url) {
  let fixed = url.trim();
  // Codifica espacios literales en el path
  fixed = fixed.replace(/ /g, '%20');
  // Elimina caracteres inválidos en URLs
  fixed = fixed.replace(/[<>"{}|\\^`]/g, '');
  return fixed;
}

async function checkUrl(url, index, total) {
  const issues = detectProblems(url);
  const fixedUrl = fixUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(fixedUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'MesoMapBot/1.0 (educational project; checking image availability)',
      },
    });
    clearTimeout(timer);

    const status = response.status;
    const ok = status === 200 || status === 301 || status === 302;

    if ((index + 1) % 50 === 0 || index === total - 1) {
      process.stdout.write(`  Progreso: ${index + 1}/${total}\r`);
    }

    return {
      url,
      fixedUrl: fixedUrl !== url ? fixedUrl : null,
      status,
      ok,
      issues,
      error: null,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';

    if ((index + 1) % 50 === 0 || index === total - 1) {
      process.stdout.write(`  Progreso: ${index + 1}/${total}\r`);
    }

    return {
      url,
      fixedUrl: fixedUrl !== url ? fixedUrl : null,
      status: isTimeout ? 'TIMEOUT' : 'ERROR',
      ok: false,
      issues,
      error: isTimeout ? 'timeout' : err.message,
    };
  }
}

async function runPool(urls, concurrency) {
  const results = new Array(urls.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      const i = nextIndex++;
      results[i] = await checkUrl(urls[i], i, urls.length);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log('=== Verificador de URLs – Museo Rietberg ===\n');

  if (!fs.existsSync(URLS_FILE)) {
    console.error('ERROR: No se encontró all_image_urls.txt');
    process.exit(1);
  }

  const raw = fs.readFileSync(URLS_FILE, 'utf-8');
  const urls = raw.split('\n').map(l => l.trim()).filter(Boolean);
  console.log(`Total URLs a verificar: ${urls.length}`);
  console.log(`Concurrencia: ${CONCURRENCY} | Timeout: ${TIMEOUT_MS}ms\n`);

  const startTime = Date.now();
  const results = await runPool(urls, CONCURRENCY);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n\nTiempo total: ${elapsed}s\n`);

  // Clasificar resultados
  const valid     = results.filter(r => r.ok);
  const invalid   = results.filter(r => !r.ok);
  const timeout   = results.filter(r => r.status === 'TIMEOUT');
  const err404    = results.filter(r => r.status === 404);
  const err403    = results.filter(r => r.status === 403);
  const errOther  = results.filter(r => !r.ok && r.status !== 'TIMEOUT' && r.status !== 'ERROR' && r.status !== 404 && r.status !== 403);
  const errConn   = results.filter(r => r.status === 'ERROR');
  const withIssues = results.filter(r => r.issues.length > 0);

  // Deduplicar URLs con problemas de caracteres especiales
  const specialCharUrls = results.filter(r =>
    r.url !== (r.fixedUrl || r.url) || /[^\x00-\x7F]/.test(decodeURIComponent(r.url))
  );

  const report = {
    generated: new Date().toISOString(),
    summary: {
      total: urls.length,
      valid: valid.length,
      invalid: invalid.length,
      breakdown: {
        timeout: timeout.length,
        '404': err404.length,
        '403': err403.length,
        other_http_error: errOther.length,
        connection_error: errConn.length,
      },
      with_special_char_issues: withIssues.length,
      elapsed_seconds: parseFloat(elapsed),
    },
    valid_urls: valid.map(r => ({ url: r.url, status: r.status })),
    invalid_urls: invalid.map(r => ({
      url: r.url,
      status: r.status,
      error: r.error,
      issues: r.issues,
      fixedUrl: r.fixedUrl,
    })),
    special_char_urls: withIssues.map(r => ({
      url: r.url,
      issues: r.issues,
      fixedUrl: r.fixedUrl,
      status: r.status,
      ok: r.ok,
    })),
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');

  // Imprimir resumen en consola
  console.log('=== RESUMEN ===');
  console.log(`✅ Válidas (200/301/302): ${valid.length}`);
  console.log(`❌ Inválidas total:       ${invalid.length}`);
  console.log(`   ⏱  Timeout:           ${timeout.length}`);
  console.log(`   🔴 404 Not Found:      ${err404.length}`);
  console.log(`   🔒 403 Forbidden:      ${err403.length}`);
  console.log(`   ⚠️  Otros HTTP:        ${errOther.length}`);
  console.log(`   💥 Error conexión:     ${errConn.length}`);
  console.log(`🔣 Con caracteres esp.:   ${withIssues.length}`);
  console.log(`\nReporte guardado en: ${REPORT_FILE}`);

  if (invalid.length > 0) {
    console.log('\n--- URLs Inválidas (primeras 20) ---');
    invalid.slice(0, 20).forEach(r => {
      console.log(`  [${r.status}] ${r.url.slice(0, 100)}`);
    });
  }
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
