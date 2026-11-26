#!/usr/bin/env node
'use strict';

const db = require('../config/db');
const { runCultureAudit } = require('../lib/culture-audit');

async function main() {
  const showAll = process.argv.includes('--all');
  const cultureIndex = process.argv.indexOf('--culture');
  const culture = cultureIndex >= 0 ? process.argv[cultureIndex + 1] : null;
  if (cultureIndex >= 0 && (!culture || culture.startsWith('--'))) {
    throw new Error('Uso: node scripts/audit-cultures.js [--culture NOMBRE] [--all]');
  }
  const report = await runCultureAudit(db, {}, { culture });
  const displayRows = showAll ? report.rows : report.rows.slice(0, 20);

  if (culture) console.log(`Filtro de cultura: ${culture}`);
  console.log(`Objetos revisados: ${report.scanned}`);
  console.log(`Hallazgos: ${report.findings}`);
  console.log(`Estados: ${JSON.stringify(report.status_counts)}`);
  if (!showAll && report.findings > displayRows.length) {
    console.log(`Mostrando ${displayRows.length}; usa --all para imprimir todos los hallazgos.`);
  }
  for (const finding of displayRows) {
    console.log(JSON.stringify(finding));
  }
}

if (require.main === module) {
  main()
    .catch(err => {
      console.error(`Falló la auditoría de culturas: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}

module.exports = { main };
