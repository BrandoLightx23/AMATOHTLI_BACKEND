/**
 * analyze-urls-static.js
 * Análisis estático de las 681 URLs sin peticiones HTTP.
 * Detecta patrones problemáticos, doble-encoding, espacios, etc.
 */
const fs = require('fs');
const path = require('path');

const URLS_FILE = path.join(__dirname, 'all_image_urls.txt');
const raw = fs.readFileSync(URLS_FILE, 'utf-8');
const urls = raw.split('\n').map(l => l.trim()).filter(Boolean);

console.log(`Total URLs: ${urls.length}\n`);

const stats = {
  total: urls.length,
  wikimedia: 0,
  other_domain: 0,
  has_unencoded_space: 0,
  has_double_encoding: 0,    // %25XX
  has_invalid_chars: 0,       // < > " { } | \ ^ `
  has_raw_unicode: 0,          // caracteres fuera de ASCII sin codificar
  has_parenthesis: 0,         // paréntesis problemáticos
  too_short: 0,
  duplicate: 0,
  by_domain: {},
  by_extension: {},
  sample_issues: [],
};

const seen = new Set();

for (const url of urls) {
  // Dominio
  const domainMatch = url.match(/^https?:\/\/([^/]+)/);
  const domain = domainMatch ? domainMatch[1] : 'unknown';
  stats.by_domain[domain] = (stats.by_domain[domain] || 0) + 1;

  if (domain.includes('wikimedia.org') || domain.includes('wikipedia.org')) {
    stats.wikimedia++;
  } else {
    stats.other_domain++;
  }

  // Extensión
  const extMatch = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'unknown';
  stats.by_extension[ext] = (stats.by_extension[ext] || 0) + 1;

  // Espacios sin codificar (después del dominio)
  const urlPath = url.replace(/^https?:\/\/[^/]+/, '');
  if (/ /.test(urlPath)) {
    stats.has_unencoded_space++;
    stats.sample_issues.push({ url: url.slice(0, 120), issue: 'unencoded_space' });
  }

  // Doble encoding
  if (/%25[0-9A-Fa-f]{2}/.test(url)) {
    stats.has_double_encoding++;
    stats.sample_issues.push({ url: url.slice(0, 120), issue: 'double_encoding' });
  }

  // Caracteres inválidos en URL path
  if (/[<>"{}|\\^`]/.test(urlPath)) {
    stats.has_invalid_chars++;
    stats.sample_issues.push({ url: url.slice(0, 120), issue: 'invalid_chars' });
  }

  // Unicode crudo (no codificado) — ü, ä, ö, á, é, etc.
  if (/[^\x00-\x7F]/.test(url)) {
    stats.has_raw_unicode++;
    stats.sample_issues.push({ url: url.slice(0, 120), issue: 'raw_unicode' });
  }

  // Paréntesis sin codificar
  if (/[()]/.test(urlPath)) {
    stats.has_parenthesis++;
    // Solo registrar si no estaban ya codificados
  }

  // Muy corta
  if (url.length < 30) {
    stats.too_short++;
    stats.sample_issues.push({ url, issue: 'too_short' });
  }

  // Duplicados
  if (seen.has(url)) {
    stats.duplicate++;
  } else {
    seen.add(url);
  }
}

// Longitud promedio de URLs
const avgLen = Math.round(urls.reduce((a, u) => a + u.length, 0) / urls.length);

// URLs con %25 (doble encoding) — extraer para reporte
const doubleEncoded = urls.filter(u => /%25[0-9A-Fa-f]{2}/.test(u));
// URLs con unicode crudo
const rawUnicode = urls.filter(u => /[^\x00-\x7F]/.test(u));
// URLs con espacios
const spacedUrls = urls.filter(u => / /.test(u.replace(/^https?:\/\/[^/]+/, '')));

console.log('=== ANÁLISIS ESTÁTICO ===\n');
console.log(`Dominio Wikimedia/Wikipedia: ${stats.wikimedia}`);
console.log(`Otro dominio:                ${stats.other_domain}`);
console.log(`Duplicadas:                  ${stats.duplicate}`);
console.log(`Longitud promedio:           ${avgLen} caracteres`);
console.log('\n--- Problemas detectados ---');
console.log(`Espacios sin codificar:      ${stats.has_unencoded_space}`);
console.log(`Doble encoding (%25XX):      ${stats.has_double_encoding}`);
console.log(`Caracteres inválidos:        ${stats.has_invalid_chars}`);
console.log(`Unicode crudo (no codif.):   ${stats.has_raw_unicode}`);
console.log(`Con paréntesis:              ${stats.has_parenthesis}`);
console.log(`Muy cortas (<30 chars):      ${stats.too_short}`);

console.log('\n--- Por extensión ---');
Object.entries(stats.by_extension).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
  console.log(`  .${k}: ${v}`);
});

console.log('\n--- Por dominio ---');
Object.entries(stats.by_domain).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
  console.log(`  ${k}: ${v}`);
});

if (doubleEncoded.length) {
  console.log('\n--- URLs con doble encoding (primeras 5) ---');
  doubleEncoded.slice(0, 5).forEach(u => console.log(' ', u.slice(0, 120)));
}

if (rawUnicode.length) {
  console.log('\n--- URLs con unicode crudo (primeras 5) ---');
  rawUnicode.slice(0, 5).forEach(u => console.log(' ', u.slice(0, 120)));
}

if (spacedUrls.length) {
  console.log('\n--- URLs con espacios (primeras 5) ---');
  spacedUrls.slice(0, 5).forEach(u => console.log(' ', u.slice(0, 120)));
}

// Guardar reporte estático
const staticReport = {
  generated: new Date().toISOString(),
  note: 'Análisis estático (sin peticiones HTTP). Las URLs son de Wikimedia Commons.',
  summary: {
    total: stats.total,
    wikimedia: stats.wikimedia,
    other_domain: stats.other_domain,
    duplicates: stats.duplicate,
    avg_url_length: avgLen,
    issues: {
      unencoded_spaces: stats.has_unencoded_space,
      double_encoding: stats.has_double_encoding,
      invalid_chars: stats.has_invalid_chars,
      raw_unicode: stats.has_raw_unicode,
      parentheses_in_path: stats.has_parenthesis,
      too_short: stats.too_short,
    },
    by_extension: stats.by_extension,
    by_domain: stats.by_domain,
  },
  double_encoded_urls: doubleEncoded,
  raw_unicode_urls: rawUnicode,
  spaced_urls: spacedUrls,
};

fs.writeFileSync(
  path.join(__dirname, 'static_url_report.json'),
  JSON.stringify(staticReport, null, 2),
  'utf-8'
);
console.log('\nReporte estático guardado en: static_url_report.json');
