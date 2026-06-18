#!/usr/bin/env node
/**
 * scripts/diagnoseMissing.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostica las discrepancias de nombres entre los objetos sin imagen_local
 * en la base de datos y los archivos restantes en imagenes_reinhart.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const db    = require('../config/db');

const REINHART_DIR = path.join(__dirname, '..', 'public', 'images', 'thumbnails', 'imagenes_reinhart');

async function main() {
  console.log('\n🔎 DIAGNÓSTICO DE IMÁGENES NO ASOCIADAS');
  console.log('══════════════════════════════════════════════════');

  if (!fs.existsSync(REINHART_DIR)) {
    console.log(`❌ No existe la carpeta temporal: ${REINHART_DIR}`);
    process.exit(0);
  }

  // 1. Leer archivos en la carpeta
  const files = fs.readdirSync(REINHART_DIR).filter(f => f.match(/\.(jpg|jpeg|png|webp|gif)$/i));
  console.log(`📁 Archivos pendientes en imagenes_reinhart: ${files.length}`);

  // 2. Obtener objetos de la base de datos sin imagen_local
  const [objetos] = await db.query(
    'SELECT id, numero_inventario, imagen_url FROM objetos WHERE imagen_local IS NULL'
  );
  console.log(`📊 Objetos en BD sin imagen_local: ${objetos.length}`);

  if (objetos.length === 0 || files.length === 0) {
    console.log('No hay discrepancias para analizar.');
    process.exit(0);
  }

  console.log('\n📋 Analizando posibles coincidencias...\n');

  const unmatchedObjects = [];

  for (const obj of objetos) {
    const dbInv = (obj.numero_inventario || '').trim();
    if (!dbInv) continue;

    // Buscar archivos que contengan el número de inventario de alguna forma
    const normalizedDbInv = dbInv.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const partialMatches = files.filter(file => {
      const normalizedFile = file.toLowerCase().replace(/[^a-z0-9]/g, '');
      return normalizedFile.includes(normalizedDbInv) || normalizedDbInv.includes(normalizedFile);
    });

    if (partialMatches.length > 0) {
      console.log(`❓ Objeto BD: "${dbInv}" (ID ${obj.id})`);
      console.log(`   Archivos candidatos en disco:`);
      partialMatches.forEach(f => console.log(`     - ${f}`));
    } else {
      unmatchedObjects.push(obj);
    }
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('📋 MUESTRA DE OBJETOS SIN NINGUNA COINCIDENCIA (primeros 15):');
  unmatchedObjects.slice(0, 15).forEach(obj => {
    console.log(`  • ID ${obj.id} | Inv: "${obj.numero_inventario}" | URL original: ${obj.imagen_url}`);
  });

  console.log('\n📋 MUESTRA DE ARCHIVOS EN DISCO NO ASOCIADOS (primeros 15):');
  // Encontrar qué archivos no se asocian a ningún inventario de la base de datos
  const [todosLosObjetos] = await db.query('SELECT numero_inventario FROM objetos');
  const dbInvs = new Set(todosLosObjetos.map(o => (o.numero_inventario || '').trim().toLowerCase()));
  
  let printedCount = 0;
  for (const file of files) {
    const match = file.match(/^Inv_([0-9a-zA-Z.-]+)-/);
    if (match) {
      const fileInv = match[1].trim().toLowerCase();
      if (!dbInvs.has(fileInv)) {
        if (printedCount < 15) {
          console.log(`  • Archivo: ${file} (Inventario extraído: "${match[1]}")`);
          printedCount++;
        }
      }
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
