#!/usr/bin/env node
/**
 * Ejecuta la migración multi-colección de forma transaccional y aditiva.
 *
 * Uso: node scripts/migrate-colecciones.js
 */

'use strict';

const db = require('../config/db');

const DEFAULT_COLLECTION = {
  name: 'Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich',
  category: 'Category:Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich',
  slug: 'anne-marie-und-caspar-reinhart-collection-at-museum-rietberg-zurich',
};

async function migrate() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS colecciones (
        id                SERIAL PRIMARY KEY,
        nombre            TEXT NOT NULL,
        categoria_commons TEXT NOT NULL UNIQUE,
        slug              TEXT UNIQUE,
        created_at        TIMESTAMPTZ DEFAULT now(),
        updated_at        TIMESTAMPTZ DEFAULT now()
      )
    `);

    const columns = [
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS coleccion_id INT REFERENCES colecciones(id)',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS commons_title TEXT',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS commons_pageid INT',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS thumb_url TEXT',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS image_width INT',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS image_height INT',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS mime TEXT',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION',
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION',
      "ALTER TABLE objetos ADD COLUMN IF NOT EXISTS estilo_cultura_source TEXT NOT NULL DEFAULT 'legacy'",
      "ALTER TABLE objetos ADD COLUMN IF NOT EXISTS lugar_origen_source TEXT NOT NULL DEFAULT 'legacy'",
      'ALTER TABLE objetos ADD COLUMN IF NOT EXISTS descripcion TEXT',
      'ALTER TABLE objetos ALTER COLUMN descripcion TYPE TEXT',
    ];
    for (const sql of columns) await client.query(sql);
    await client.query(`
      UPDATE objetos
      SET estilo_cultura_source = COALESCE(estilo_cultura_source, 'legacy'),
          lugar_origen_source = COALESCE(lugar_origen_source, 'legacy')
      WHERE estilo_cultura_source IS NULL OR lugar_origen_source IS NULL
    `);

    await client.query(
      `INSERT INTO colecciones (nombre, categoria_commons, slug)
       VALUES ($1, $2, $3)
       ON CONFLICT (categoria_commons) DO NOTHING`,
      [DEFAULT_COLLECTION.name, DEFAULT_COLLECTION.category, DEFAULT_COLLECTION.slug]
    );
    await client.query(
      `UPDATE objetos
       SET coleccion_id = (
         SELECT id FROM colecciones WHERE categoria_commons = $1
       )
       WHERE coleccion_id IS NULL`,
      [DEFAULT_COLLECTION.category]
    );

    const { rows: duplicateTitles } = await client.query(`
      SELECT commons_title, COUNT(*) AS count
      FROM objetos
      WHERE commons_title IS NOT NULL
      GROUP BY commons_title
      HAVING COUNT(*) > 1
      ORDER BY commons_title
      LIMIT 5
    `);
    if (duplicateTitles.length) {
      throw new Error(
        `No se puede crear el índice de Commons: títulos duplicados (${duplicateTitles
          .map(row => row.commons_title).join(', ')})`
      );
    }

    const { rows: duplicateInventory } = await client.query(`
      SELECT coleccion_id, numero_inventario, COUNT(*) AS count
      FROM objetos
      WHERE coleccion_id IS NOT NULL AND numero_inventario IS NOT NULL
      GROUP BY coleccion_id, numero_inventario
      HAVING COUNT(*) > 1
      ORDER BY coleccion_id, numero_inventario
      LIMIT 5
    `);
    if (duplicateInventory.length) {
      throw new Error(
        `No se puede migrar la unicidad del inventario: duplicados dentro de una colección (${duplicateInventory
          .map(row => `${row.coleccion_id}:${row.numero_inventario}`).join(', ')})`
      );
    }

    await client.query('DROP INDEX IF EXISTS uk_inventario');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_inventario_coleccion
      ON objetos (coleccion_id, numero_inventario)
      WHERE coleccion_id IS NOT NULL AND numero_inventario IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS objetos_commons_title_unique
      ON objetos (commons_title)
      WHERE commons_title IS NOT NULL
    `);

    await client.query('COMMIT');
    console.log('✅ Migración multi-colección completada sin borrar datos.');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      err.message += ` (también falló ROLLBACK: ${rollbackError.message})`;
    }
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .catch(err => {
      console.error('\n💥 Error en la migración:', err.message);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}

module.exports = { migrate };
