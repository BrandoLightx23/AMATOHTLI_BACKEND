#!/usr/bin/env node
/**
 * scripts/processLocalImages.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Este script procesa las imágenes descargadas manualmente que están en:
 *   public/images/thumbnails/imagenes_reinhart/
 *
 * Hace lo siguiente:
 *   1. Lee todas las imágenes de esa carpeta.
 *   2. Extrae el número de inventario de cada nombre de archivo (ej. "Inv_2025.1162-Gürtel.jpg" -> "2025.1162").
 *      Utiliza la regla: todo lo que esté entre "Inv_" y el primer guión "-".
 *   3. Consulta la base de datos MySQL y asocia cada imagen con su fila correspondiente usando "numero_inventario".
 *   4. Mueve y renombra la imagen a la carpeta principal "public/images/[numero_inventario].jpg".
 *   5. Usa Sharp para optimizar la imagen y generar un thumbnail de 300px en "public/images/thumbnails/[numero_inventario].jpg".
 *   6. Actualiza la base de datos con las rutas locales:
 *        - imagen_local: /images/[numero_inventario].jpg
 *        - thumbnail_local: /images/thumbnails/[numero_inventario].jpg
 *   7. Limpia la carpeta temporal "imagenes_reinhart" una vez finalizado todo con éxito.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const sharp = require('sharp');
const db    = require('../config/db');

// ── Rutas ──────────────────────────────────────────────────────────────────
const REINHART_DIR = path.join(__dirname, '..', 'public', 'images', 'thumbnails', 'imagenes_reinhart');
const PUBLIC_DIR   = path.join(__dirname, '..', 'public', 'images');
const THUMB_DIR    = path.join(PUBLIC_DIR, 'thumbnails');
const THUMB_WIDTH  = 300;

async function main() {
  console.log('\n📦 PROCESADOR DE IMÁGENES LOCALES');
  console.log('══════════════════════════════════════════════════');

  if (!fs.existsSync(REINHART_DIR)) {
    console.error(`❌ Carpeta origen no encontrada: ${REINHART_DIR}`);
    console.error('Asegúrate de que las imágenes estén dentro de la carpeta indicada.');
    process.exit(1);
  }

  // 1. Asegurar directorios de destino
  [PUBLIC_DIR, THUMB_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // 2. Leer archivos de la carpeta
  const files = fs.readdirSync(REINHART_DIR).filter(f => f.match(/\.(jpg|jpeg|png|webp|gif)$/i));
  console.log(`📁 Imágenes encontradas en origen: ${files.length}`);

  if (files.length === 0) {
    console.log('⚠ No se encontraron imágenes en la carpeta. Finalizando.');
    process.exit(0);
  }

  // 3. Crear mapa de número de inventario -> nombre de archivo
  // Formato esperado: "Inv_2025.1162-Gürtel.jpg" -> "2025.1162"
  const fileMap = new Map();
  for (const file of files) {
    // Captura todo lo que no sea un guión justo después de "Inv_"
    const match = file.match(/^Inv_([^-]+)-/);
    if (match) {
      const invNum = match[1].trim();
      fileMap.set(invNum.toLowerCase(), {
        originalFilename: file,
        fullPath: path.join(REINHART_DIR, file)
      });
    } else {
      console.log(`  ⚠ Omitido archivo con formato no compatible: ${file}`);
    }
  }

  console.log(`🎯 Mapeadas correctamente de nombre a inventario: ${fileMap.size} imágenes.`);

  // 4. Obtener todos los objetos del Museo en la base de datos
  const [objetos] = await db.query(
    'SELECT id, numero_inventario, imagen_url, imagen_local FROM objetos'
  );
  console.log(`📊 Objetos registrados en base de datos: ${objetos.length}`);

  let successCount = 0;
  let notFoundInDirCount = 0;
  let alreadyProcessedCount = 0;

  // 5. Procesar e integrar cada objeto
  for (const obj of objetos) {
    const dbInv = (obj.numero_inventario || '').trim();
    if (!dbInv) continue;

    const key = dbInv.toLowerCase();
    const fileData = fileMap.get(key);

    if (!fileData) {
      notFoundInDirCount++;
      continue;
    }

    // Nombre de destino limpio (reemplaza caracteres no permitidos en sistemas de archivos)
    const sanitizedInv = dbInv.replace(/[\/\\?%*:|"<>]/g, '_');
    const targetFilename = `${sanitizedInv}.jpg`;
    
    const targetLocalPath = path.join(PUBLIC_DIR, targetFilename);
    const targetThumbPath = path.join(THUMB_DIR, targetFilename);
    
    const localRoute = `/images/${targetFilename}`;
    const thumbRoute = `/images/thumbnails/${targetFilename}`;

    try {
      // Si la imagen completa y el thumbnail ya existen, solo actualiza la base de datos si es necesario
      if (fs.existsSync(targetLocalPath) && fs.existsSync(targetThumbPath)) {
        if (obj.imagen_local !== localRoute) {
          await db.query(
            'UPDATE objetos SET imagen_local = ?, thumbnail_local = ? WHERE id = ?',
            [localRoute, thumbRoute, obj.id]
          );
        }
        alreadyProcessedCount++;
        successCount++;
        continue;
      }

      // Procesar imagen completa optimizada
      await sharp(fileData.fullPath)
        .jpeg({ quality: 85, progressive: true })
        .toFile(targetLocalPath);

      // Generar thumbnail
      await sharp(fileData.fullPath)
        .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toFile(targetThumbPath);

      // Actualizar Base de Datos
      await db.query(
        'UPDATE objetos SET imagen_local = ?, thumbnail_local = ? WHERE id = ?',
        [localRoute, thumbRoute, obj.id]
      );

      successCount++;
    } catch (err) {
      console.error(`❌ Error al procesar objeto ID ${obj.id} [${dbInv}]:`, err.message);
    }
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('📊 RESUMEN DEL PROCESO');
  console.log('══════════════════════════════════════════════════');
  console.log(`✅ Procesados y guardados con éxito:  ${successCount}`);
  console.log(`♻  Ya existían previamente:           ${alreadyProcessedCount}`);
  console.log(`❌ No encontradas en imagenes_reinhart: ${notFoundInDirCount}`);
  console.log('══════════════════════════════════════════════════');

  // 6. Limpiar la carpeta temporal si todo salió bien
  if (successCount > 0 && notFoundInDirCount === 0) {
    try {
      // Eliminar archivos individuales
      for (const file of files) {
        fs.unlinkSync(path.join(REINHART_DIR, file));
      }
      // Eliminar el directorio vacío
      fs.rmdirSync(REINHART_DIR);
      console.log('🧹 Carpeta temporal "imagenes_reinhart" limpiada con éxito.');
    } catch (cleanErr) {
      console.warn('⚠ No se pudo eliminar la carpeta temporal:', cleanErr.message);
    }
  } else if (successCount > 0) {
    console.log('ℹ Se mantendrá la carpeta temporal para revisiones ya que algunos objetos no se encontraron.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('\n💥 Error fatal:', err.message);
  process.exit(1);
});
