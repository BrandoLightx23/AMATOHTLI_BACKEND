#!/usr/bin/env node
/**
 * scripts/syncToAiven.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Este script clona la estructura y todos los datos de tu base de datos local
 * hacia el servidor de Aiven de forma automática usando Node.js.
 * No requiere que tengas instalado 'mysqldump' ni el cliente 'mysql' en Windows.
 *
 * Configuración necesaria en backend/.env:
 *   AIVEN_HOST=tu_host_de_aiven
 *   AIVEN_PORT=tu_puerto_de_aiven
 *   AIVEN_USER=avnadmin
 *   AIVEN_PASSWORD=tu_contraseña_de_aiven
 *   AIVEN_NAME=defaultdb
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  console.log('\n🔄 EMPEZANDO MIGRACIÓN AUTOMÁTICA DE LOCAL A AIVEN');
  console.log('══════════════════════════════════════════════════');

  // 1. Validar variables de Aiven
  if (!process.env.AIVEN_HOST || !process.env.AIVEN_PASSWORD) {
    console.error('❌ Falta configurar las variables de Aiven en tu archivo .env');
    console.error('Asegúrate de agregar: AIVEN_HOST, AIVEN_PORT, AIVEN_USER, AIVEN_PASSWORD y AIVEN_NAME');
    process.exit(1);
  }

  // 2. Crear las conexiones a los Pools
  console.log('🔌 Conectando a Base de Datos Local...');
  const localPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'museo_rietberg',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    waitForConnections: true,
    connectionLimit: 2
  });

  console.log('🔌 Conectando a Aiven (requiere SSL)...');
  const aivenPool = mysql.createPool({
    host: process.env.AIVEN_HOST,
    port: parseInt(process.env.AIVEN_PORT || '21156', 10),
    user: process.env.AIVEN_USER || 'avnadmin',
    password: process.env.AIVEN_PASSWORD,
    database: process.env.AIVEN_NAME || 'defaultdb',
    ssl: {
      rejectUnauthorized: false // Aiven exige SSL, esto evita errores de certificado autofirmado
    },
    waitForConnections: true,
    connectionLimit: 2
  });

  try {
    // 3. Obtener el DDL (la consulta CREATE TABLE) de la tabla local
    console.log('📥 Obteniendo estructura de la tabla local "objetos"...');
    const [createTableResult] = await localPool.query('SHOW CREATE TABLE objetos');
    
    if (createTableResult.length === 0) {
      throw new Error('No se encontró la tabla "objetos" en la base de datos local.');
    }

    const createTableSQL = createTableResult[0]['Create Table'];
    console.log('   Estructura obtenida correctamente.');

    // 4. Preparar la tabla en Aiven
    console.log('🗑 Limpiando tabla "objetos" en Aiven si ya existía...');
    await aivenPool.query('DROP TABLE IF EXISTS objetos');

    console.log('🏗 Creando tabla "objetos" en Aiven...');
    await aivenPool.query(createTableSQL);
    console.log('   Tabla creada con éxito.');

    // 5. Leer todos los datos de la tabla local
    console.log('📥 Leyendo filas de la base de datos local...');
    const [rows] = await localPool.query('SELECT * FROM objetos');
    console.log(`   Se leyeron ${rows.length} filas locales.`);

    if (rows.length === 0) {
      console.log('⚠ La tabla local está vacía. No hay filas para migrar.');
      process.exit(0);
    }

    // 6. Insertar filas en Aiven (en bloques de 50 para mayor velocidad)
    console.log('📤 Subiendo datos a Aiven...');
    
    // Obtener los nombres de las columnas
    const columns = Object.keys(rows[0]);
    const columnsSQL = columns.map(c => `\`${c}\``).join(', ');
    
    const batchSize = 50;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      
      // Construir la consulta preparada
      const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
      const sql = `INSERT INTO objetos (${columnsSQL}) VALUES ${placeholders}`;
      
      // Aplanar los valores del bloque para pasarlos como parámetros
      const values = [];
      batch.forEach(row => {
        columns.forEach(col => {
          values.push(row[col]);
        });
      });

      await aivenPool.query(sql, values);
      console.log(`   Sincronizadas ${Math.min(i + batchSize, rows.length)} / ${rows.length} filas...`);
    }

    console.log('\n══════════════════════════════════════════════════');
    console.log('🎉 ¡MIGRACIÓN COMPLETADA CON ÉXITO!');
    console.log(`   Se crearon y subieron ${rows.length} registros a Aiven.`);
    console.log('══════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ Ocurrió un error durante la migración:', err.message);
  } finally {
    // Cerrar las conexiones
    await localPool.end();
    await aivenPool.end();
  }
}

main().catch(err => {
  console.error('💥 Error fatal:', err.message);
});
