#!/usr/bin/env node
/**
 * scripts/uploadToCloudinary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Este script sube las imágenes locales de alta calidad a Cloudinary
 * y actualiza la base de datos con las URLs generadas por Cloudinary.
 *
 * Requisitos:
 *   1. Instalar el SDK de Cloudinary: npm install cloudinary
 *   2. Configurar las variables en tu .env:
 *      CLOUDINARY_CLOUD_NAME=tu_cloud_name
 *      CLOUDINARY_API_KEY=tu_api_key
 *      CLOUDINARY_API_SECRET=tu_api_secret
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const db = require('../config/db');

// Configurar Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Función para transformar URL de Cloudinary en thumbnail
function getCloudinaryThumbnailUrl(originalUrl) {
  if (!originalUrl) return null;
  // Añade la transformación w_300,q_auto,f_auto para optimizar el peso del thumbnail
  return originalUrl.replace('/upload/', '/upload/w_300,q_auto,f_auto/');
}

async function main() {
  console.log('\n🚀 SUBIDA DE IMÁGENES A CLOUDINARY');
  console.log('══════════════════════════════════════════════════');

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('❌ Falta configurar las variables de entorno de Cloudinary en el .env');
    console.error('Asegúrate de agregar: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET');
    process.exit(1);
  }

  // 1. Obtener objetos de la base de datos que tengan imágenes locales aún no subidas
  const [objetos] = await db.query(
    'SELECT id, numero_inventario, imagen_local, thumbnail_local FROM objetos'
  );
  
  // Filtrar los que tienen imagen local y cuya imagen no empiece ya con http (lo que significa que ya está en Cloudinary u otro hosting)
  const aProcesar = objetos.filter(obj => {
    return obj.imagen_local && !obj.imagen_local.startsWith('http');
  });

  console.log(`📊 Total de objetos en BD: ${objetos.length}`);
  console.log(`📁 Objetos con imágenes locales pendientes de subir: ${aProcesar.length}`);

  if (aProcesar.length === 0) {
    console.log('🎉 No hay imágenes locales pendientes de subir a Cloudinary. ¡Todo al día!');
    process.exit(0);
  }

  let successCount = 0;
  let errorCount = 0;

  // 2. Procesar y subir cada imagen
  for (let i = 0; i < aProcesar.length; i++) {
    const obj = aProcesar[i];
    const dbInv = (obj.numero_inventario || '').trim();
    
    // Ruta absoluta en disco local de la imagen
    const localPath = path.join(PUBLIC_DIR, obj.imagen_local);

    console.log(`\n[${i + 1}/${aProcesar.length}] Procesando objeto ID ${obj.id} (Inv: ${dbInv})...`);

    if (!fs.existsSync(localPath)) {
      console.warn(`  ⚠ Archivo local no encontrado en: ${localPath}. Omitiendo.`);
      errorCount++;
      continue;
    }

    try {
      // Limpiar identificador público para Cloudinary
      const sanitizedInv = dbInv.replace(/[\/\\?%*:|"<>]/g, '_');
      const publicId = `amatohtli_${sanitizedInv}`;

      console.log(`  Subiendo a Cloudinary con public_id: amatohtli/${publicId}...`);
      
      const uploadResult = await cloudinary.uploader.upload(localPath, {
        folder: 'amatohtli',
        public_id: publicId,
        overwrite: true,
        resource_type: 'image'
      });

      const cloudinaryUrl = uploadResult.secure_url;
      const cloudinaryThumbUrl = getCloudinaryThumbnailUrl(cloudinaryUrl);

      console.log(`  ✅ Subido con éxito: ${cloudinaryUrl}`);
      console.log(`  ✨ Thumbnail dinámico: ${cloudinaryThumbUrl}`);

      // Actualizar Base de Datos
      await db.query(
        'UPDATE objetos SET imagen_local = ?, thumbnail_local = ? WHERE id = ?',
        [cloudinaryUrl, cloudinaryThumbUrl, obj.id]
      );

      console.log(`  💾 Base de datos actualizada.`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ Error al subir a Cloudinary/actualizar BD para ID ${obj.id}:`, err.message);
      errorCount++;
    }
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('📊 RESUMEN DE SUBIDA A CLOUDINARY');
  console.log('══════════════════════════════════════════════════');
  console.log(`✅ Subidas con éxito: ${successCount}`);
  console.log(`❌ Errores u omitidos:  ${errorCount}`);
  console.log('══════════════════════════════════════════════════\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\n💥 Error fatal en script de Cloudinary:', err.message);
  process.exit(1);
});
