#!/usr/bin/env node
/**
 * scripts/migrate.js
 * Ejecuta la migración SQL directamente usando la conexión mysql2 del proyecto.
 * Compatible con XAMPP (no requiere el cliente mysql en el PATH).
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
        ADD COLUMN imagen_local VARCHAR(255) DEFAULT NULL
          COMMENT 'Ruta local servida por Express: /images/2025.385.jpg'
        AFTER imagen_url
      `,
    },
    {
      name: 'Añadir columna thumbnail_local',
      sql: `
        ALTER TABLE objetos
        ADD COLUMN thumbnail_local VARCHAR(255) DEFAULT NULL
          COMMENT 'Ruta local del thumbnail 300px: /images/thumbnails/2025.385.jpg'
        AFTER imagen_local
      `,
    },
  ];

  for (const step of steps) {
    try {
      await db.query(step.sql);
      console.log(`  ✅ ${step.name}`);
    } catch (err) {
      // Error 1060 = Duplicate column name → columna ya existe, OK
      if (err.errno === 1060) {
        console.log(`  ♻️  ${step.name} (ya existía, se omite)`);
      } else {
        console.error(`  ❌ ${step.name}: ${err.message}`);
        throw err;
      }
    }
  }

  // Verificar resultado
  const [cols] = await db.query(`
    SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'museo_rietberg'
      AND TABLE_NAME   = 'objetos'
      AND COLUMN_NAME IN ('imagen_url', 'imagen_local', 'thumbnail_local')
    ORDER BY ORDINAL_POSITION
  `);

  console.log('\n📋 Columnas de imagen en la tabla objetos:\n');
  cols.forEach(c => {
    console.log(`  ${c.COLUMN_NAME.padEnd(20)} ${c.COLUMN_TYPE.padEnd(15)} nullable=${c.IS_NULLABLE}`);
  });

  // Contar objetos con/sin imagen_local
  const [[counts]] = await db.query(`
    SELECT
      COUNT(*)                                    AS total,
      SUM(imagen_local IS NOT NULL)               AS con_local,
      SUM(imagen_local IS NULL)                   AS sin_local
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
