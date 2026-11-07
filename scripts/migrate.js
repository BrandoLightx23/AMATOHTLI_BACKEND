#!/usr/bin/env node
/**
 * scripts/migrate.js
 * Ejecuta la migración SQL directamente usando la conexión PostgreSQL del proyecto.
 *
 * Uso:
 *   node scripts/migrate.js
 */

'use strict';

const db = require('../config/db');

async function migrate() {
  console.log('\n🔧 Ejecutando migración de base de datos...\n');

  const steps = [
    {
      name: 'Añadir columna imagen_local',
      sql: `
        ALTER TABLE objetos
        ADD COLUMN IF NOT EXISTS imagen_local VARCHAR(255) DEFAULT NULL
      `,
    },
    {
      name: 'Añadir columna thumbnail_local',
      sql: `
        ALTER TABLE objetos
        ADD COLUMN IF NOT EXISTS thumbnail_local VARCHAR(255) DEFAULT NULL
      `,
    },
  ];

  for (const step of steps) {
    try {
      await db.query(step.sql);
      console.log(`  ✅ ${step.name}`);
    } catch (err) {
      console.error(`  ❌ ${step.name}: ${err.message}`);
      throw err;
    }
  }

  // Verificar resultado
  const { rows: cols } = await db.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'objetos'
      AND column_name IN ('imagen_url', 'imagen_local', 'thumbnail_local')
    ORDER BY ordinal_position
  `);

  console.log('\n📋 Columnas de imagen en la tabla objetos:\n');
  cols.forEach(c => {
    console.log(`  ${c.column_name.padEnd(20)} ${c.data_type.padEnd(15)} nullable=${c.is_nullable}`);
  });

  // Contar objetos con/sin imagen_local
  const { rows: [counts] } = await db.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(imagen_local) AS con_local,
      COUNT(*) - COUNT(imagen_local) AS sin_local
    FROM objetos
  `);

  console.log(`\n📊 Estado actual:`);
  console.log(`   Total objetos:         ${counts.total}`);
  console.log(`   Con imagen_local:      ${counts.con_local}`);
  console.log(`   Sin imagen_local:      ${counts.sin_local}`);
  console.log(`\n✅ Migración completada. Ahora ejecuta:\n`);
  console.log(`   npm run download\n`);

  process.exit(0);
}

migrate().catch(err => {
  console.error('\n💥 Error en la migración:', err.message);
  process.exit(1);
});
