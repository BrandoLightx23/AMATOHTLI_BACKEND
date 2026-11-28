#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../config/db');

async function migrate() {
  const migrationPath = path.join(__dirname, 'migrate-translations.sql');
  const migrationSql = await fs.readFile(migrationPath, 'utf8');
  await db.query(migrationSql);
  console.log('✅ Tablas de traducciones de obras y colecciones listas.');
}

if (require.main === module) {
  migrate()
    .catch(error => {
      console.error('\n💥 Error en la migración de traducciones:', error.message);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}

module.exports = { migrate };

