/**
 * AMATOHTLI — Sincroniza TODAS las colecciones registradas en la tabla `colecciones`.
 *
 * Uso:
 *   node scripts/sync-all.js                    # sincroniza todas, una por una
 *   node scripts/sync-all.js --dry-run          # solo vista previa, sin escribir
 *   node scripts/sync-all.js --dry-run --limit 20
 *
 * Las colecciones se procesan en orden secuencial (nunca en paralelo)
 * para respetar los límites de Wikimedia Commons.
 */

const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const db = require('../config/db');

function parseArgs(argv) {
  const args = { dryRun: false, limit: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

function runSync(category, { dryRun, limit }) {
  return new Promise((resolve) => {
    const args = [path.resolve(__dirname, 'sync-commons.js'), '--category', category];
    if (dryRun) args.push('--dry-run');
    if (limit) args.push('--limit', String(limit));
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => { console.error(err); resolve(1); });
  });
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv);
  const { rows } = await db.query('SELECT id, nombre, categoria_commons FROM colecciones ORDER BY id');
  if (!rows.length) {
    console.log('No hay colecciones registradas en la tabla `colecciones`.');
    await db.end();
    return;
  }
  console.log(`\n🧭 Sincronizando ${rows.length} colecciones${dryRun ? ' (dry-run)' : ''}...\n`);
  let ok = 0, failed = 0;
  for (const row of rows) {
    console.log(`\n===== ${row.nombre} =====`);
    const code = await runSync(row.categoria_commons, { dryRun, limit });
    if (code === 0) ok++; else failed++;
  }
  console.log(`\n✅ Terminado: ${ok} colecciones OK, ${failed} con error.`);
  await db.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('❌ Error en sync-all:', err.message);
  try { await db.end(); } catch {}
  process.exit(1);
});
