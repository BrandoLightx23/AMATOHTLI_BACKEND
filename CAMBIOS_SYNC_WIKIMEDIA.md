# Cambios de sincronización Wikimedia Commons + Wikidata (PostgreSQL)

Documentación del proceso realizado para pasar de la base anterior a una nueva base de datos PostgreSQL (Supabase) que funciona como caché persistente alimentada desde la API de Wikimedia Commons y Wikidata.

---

## 1. Nueva base de datos en Supabase (PostgreSQL) como caché de Wikimedia
- Se creó un **nuevo proyecto limpio en Supabase (PostgreSQL)** para pruebas e ingesta, separado de la base de datos de producción existente (y reemplazando el flujo anterior basado en MySQL/MariaDB y MySQL Workbench).
- La estructura base de `objetos` se puede crear desde `museo_rietberg_pg.sql`; el volcado estático solo se inserta cuando `objetos` está vacía, sin reemplazar filas existentes.
- El esquema funciona como **caché persistente**: los scripts ingieren y actualizan las piezas bajo demanda, mientras que la API de Express y el frontend leen exclusivamente desde PostgreSQL sin consultar a Wikimedia en vivo durante la navegación.

---

## 2. Creación de los scripts de migración y sincronización
- **`backend/scripts/migrate-colecciones.sql` y `backend/scripts/migrate-colecciones.js`**:
  - Crean la tabla `colecciones` (`nombre`, `categoria_commons`, `slug`, `created_at`, `updated_at`) para soportar múltiples colecciones.
  - Agregan a `objetos` las columnas de Wikimedia/Wikidata (`coleccion_id`, `commons_title`, `commons_pageid`, `thumb_url`, `image_width`, `image_height`, `mime`, `lat`, `lon`).
  - Ejecutan cambios aditivos dentro de una transacción, validan duplicados antes de crear índices y cambian la unicidad global de inventario por unicidad `(coleccion_id, numero_inventario)`, para permitir el mismo número en colecciones distintas sin borrar filas.
- **`backend/scripts/sync-commons.js`**:
  - Nuevo script CLI que lista archivos de una categoría de Wikimedia Commons (`list=categorymembers`, `cmlimit=max`), consulta detalles en lotes de 50 (`prop=imageinfo|revisions`, `iiurlwidth=800`), respeta límites de la API (`User-Agent`, `maxlag=5`, pausas y reintentos ante `429`) e inserta o actualiza cada pieza de forma transaccional.
  - Antes de insertar, reutiliza una fila heredada con el mismo inventario dentro de la colección; si el título Commons y el inventario señalan filas distintas, informa el conflicto sin fusionarlas ni borrarlas.
  - Informa conteos separados de insertadas, actualizadas, sin cambios y fallidas; cualquier fallo por pieza da código de salida distinto de cero.
  - El `UPDATE` usa parámetros contiguos e independientes de los del `INSERT`; el `commons_pageid` nullable (`$4`) lleva cast explícito a `integer` para que PostgreSQL resuelva su tipo. Una prueba de regresión cubre el caso `pageid: null` y verifica la correspondencia de los parámetros.
  - La sincronización en vivo contra Supabase no se ejecutó; la validación del arreglo se hizo con pruebas locales.
  - Los nuevos registros marcan `estilo_cultura_source` y `lugar_origen_source` como `wikidata`. Los valores preexistentes se clasifican como `legacy` mediante las columnas aditivas de la migración y el sync no los sobrescribe. Si una fila está marcada `wikidata`, sus valores se refrescan desde la fuente y pueden limpiarse cuando Wikidata ya no aporta ese dato.
  - Incluye soporte de `--dry-run` y `--limit N` para pruebas antes de escribir en la base.

---

## 3. Carga automática de `.env` y soporte SSL configurable
**Archivo:** `backend/config/db.js`

- **Problema:** `require('dotenv').config()` solo estaba en `backend/app.js`, por lo que al ejecutar scripts directamente (`node scripts/migrate-colecciones.js`, `node scripts/sync-commons.js`), `process.env.DB_HOST` quedaba `undefined` y `pg` fallaba intentando conectarse a `localhost:5432`.
- **Cambio:**
  - Se carga `backend/.env` explícitamente con `path.resolve(__dirname, '../.env')`.
  - Se respeta `process.env.DB_SSL === 'true'` para activar/desactivar SSL según el entorno (Supabase vs. PostgreSQL local).

---

## 4. Soporte de coordenadas (`lat`, `lon`) en el esquema
**Archivos:** `backend/scripts/migrate-colecciones.js`, `backend/scripts/migrate-colecciones.sql`

- Se añadieron las columnas `lat` y `lon` (`DOUBLE PRECISION`) a la tabla `objetos` mediante `ALTER TABLE objetos ADD COLUMN IF NOT EXISTS`:
  - `lat DOUBLE PRECISION`
  - `lon DOUBLE PRECISION`
- Estas columnas permiten ubicar piezas de cualquier colección directamente en el mapa sin depender exclusivamente de diccionarios de países.

---

## 5. Corrección de subnúmeros de inventario y enriquecimiento desde Wikidata
**Archivo:** `backend/scripts/sync-commons.js`

### 5.1 Parseo completo de `numero_inventario`
- **Problema:** `parseInventory(title)` usaba `/Inv\.Nr\.?-(\d{4}\.\d+)/i`, recortando el tercer segmento (`.1`, `.2`) y provocando colisiones en `uk_inventario` para piezas como `2025.1209.2`, `2025.352.2` y `2025.353.2` (678 guardadas, 3 fallidas).
- **Cambio:** Se actualizó la expresión regular a `/Inv\.Nr\.?-(\d{4}\.\d+(?:\.\d+)*)/i`. Los registros heredados coincidentes se actualizan en su fila actual en vez de intentar insertar una fila duplicada.
- **Resultado:** `681 guardadas/actualizadas, 0 fallidas`.

### 5.2 Enriquecimiento de metadatos en español y coordenadas desde Wikidata
- En `enrichBatch(titles)`, la consulta a Wikimedia Commons solicita `prop=imageinfo|revisions` (`rvprop=content`, `rvslots=main`) para extraer el identificador de Wikidata (`wikidata=Q...`) del wikitext de cada archivo en la misma llamada.
- Se añadió `enrichWithWikidata(items)` usando `https://www.wikidata.org/w/api.php` (`action=wbgetentities`, en lotes de 50, con `languages: 'es|en|de'` y prioridad `es → en → de` en `getLabel`):
  - **`lugar_origen`**: etiquetas de `P1071` (*lugar de creación*).
  - **`lat`, `lon`**: coordenadas `P625` del lugar más específico en `P1071` (prefiriendo entidades que no sean país `Q6256`, con fallback al país si es el único con coordenadas).
  - **`estilo_cultura`**: etiquetas de `P2596` (*cultura*).
  - **`tipo_objeto`**: etiqueta de `P31` (*instancia de*).
  - **`material_tecnica`**: etiquetas de `P186` (*material*) y `P2079` (*método de fabricación*).
  - **`fecha`**: año o rango (`P571` y calificadores `P1319` / `P1326`), formateado con `a. C.` / `d. C.`.
  - **`dimensiones`**: medidas físicas reales del objeto extraídas con `extractDimensions(entity)` desde Wikidata (`P2048` Alto, `P2049` Ancho, `P2043` Largo, `P2386` Diámetro, `P2610` Grosor), en lugar de las dimensiones en píxeles de la fotografía (`image_width × image_height`). Se conservan las unidades conocidas (`cm`, `m`, `mm`) y se omiten las desconocidas; no se etiquetan como centímetros sin conversión.
  - **`url_objeto`**: ficha en el museo (`P973`).
- En filas existentes, Commons/Wikidata solo actualiza sus columnas de origen cuando recibe un valor distinto. No se modifican título curado, autor, créditos, denominaciones, imágenes locales ni la pertenencia a la colección existente. Cultura y lugar se actualizan o limpian solo cuando su procedencia es `wikidata`; la migración conserva el contenido preexistente y lo marca `legacy`.
- `P1319` y `P1326` se consultan antes de la fecha principal de `P571`, para conservar rangos de fecha como rangos. Si solo existe un límite se muestra como “Desde” o “Hasta”.

---

## 6. Auditoría de cultura y lugar de origen
**Archivo:** `backend/scripts/audit-cultures.js`

- Ejecuta una lectura de `objetos` dentro de `BEGIN READ ONLY`, obtiene los QID enlazados en el wikitext de Commons y compara `estilo_cultura`/`lugar_origen` con las etiquetas actuales de Wikidata (`P2596`/`P1071`).
- No actualiza la base ni requiere aplicar primero la migración de procedencia. Informa únicamente discrepancias o casos sin enlace/fuente; cada hallazgo incluye ID, inventario, título Commons, QID, valores guardados, valores fuente y estado.
- Reutiliza el tamaño de lote, los reintentos y el manejo de rate limits de las consultas Wikimedia/Wikidata existentes.
- Ejecutar con `npm run audit-cultures`; muestra hasta 20 ejemplos. Añade `-- --all` para imprimir todos los hallazgos. No se corrigen datos automáticamente.
- Para revisar solo una cultura guardada en la BD, usa `npm run audit-cultures -- --culture Calima`; esta opción añade un filtro al `SELECT` dentro de la misma transacción de solo lectura.
- También marca contradicciones cruzadas con reglas conservadoras de cultura exacta y país explícito. Por ahora incluye `Calima` → Colombia; solo compara cuando hay exactamente una cultura fuente conocida y un país fuente reconocido. No infiere conflictos en casos con varias culturas o regiones ambiguas.

La migración aditiva añade `estilo_cultura_source` y `lugar_origen_source`, con valor `legacy` para las filas existentes. Las nuevas filas importadas quedan bajo gestión de Wikidata (`wikidata`). Revisar los hallazgos de la auditoría antes de aplicar migraciones o correcciones.

**Snapshots de solo lectura (2026-11-26):** la comparación inicial por campo revisó 681 objetos; 134 tenían al menos un campo sin fuente Wikidata (`culture_source_absent`: 116; `origin_source_absent`: 38; hay solapamiento). No detectó discrepancias por campo ni faltantes de vínculo/QID. La auditoría focalizada `--culture Calima` revisó 9 objetos y encontró 4 contradicciones cruzadas: cultura fuente `Cultura Calima` con `P1071` México (3 objetos) o Perú (1). Ejemplo: objeto `277`, inventario `2025.418`, QID `Q140161434`, valores guardado/fuente `Cultura Calima` + `México`. No se aplicaron migraciones ni se modificaron filas.

---

## 7. Títulos legibles y asignación geográfica
**Archivos:** `backend/scripts/sync-commons.js`, `backend/lib/geography.js`, `backend/views/api-view.js`

- `cleanTitle` elimina los prefijos repetidos de Museum Rietberg, números de inventario, extensión y separadores del nombre Commons; por ejemplo, `Museum-Rietberg-Zürich-Inv.Nr.-2025.292-Figürchen.jpg` se convierte en `Figürchen`.
- En filas existentes, el sync solo corrige el título si coincide exactamente con el resultado del limpiador de versiones anteriores. Los títulos curados permanecen intactos.
- La asignación de país usa nombres explícitos, alias regionales de palabras completas y etiquetas culturales exactas normalizadas; `Calima` se asigna a Colombia y una ubicación que ya nombra un país tiene prioridad sobre la cultura.

## 8. Uso de coordenadas y thumbnails en la API
**Archivo:** `backend/views/api-view.js`

- Las consultas de `objetos` ahora seleccionan también `thumb_url`, `lat` y `lon`.
- `mapRowToObject`:
  - Usa `[Number(f.lon), Number(f.lat)]` para `coordinates` cuando existen `lat` y `lon` en la BD, manteniendo `getCoordinatesForRegion` como respaldo.
  - Usa `f.thumbnail_local || f.thumb_url || null` para `thumbnail`.
- `getCountryFromRegion` y `getCoordinatesForRegion`:
  - Cuando una pieza no tiene `lugar_origen` ni `estilo_cultura` reconocibles, devuelve `"Desconocido"` y `coordinates: null` en lugar de asignarla por defecto a `"Peru"`.

---

## 9. Comandos útiles (desde `backend/`)

```powershell
# 1. Aplicar o verificar migración de esquema (colecciones + lat/lon)
node scripts/migrate-colecciones.js

# 2. Probar sincronización sin escribir en la BD
node scripts/sync-commons.js --category "Category:Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich" --dry-run --limit 20

# 3. Sincronizar toda la colección hacia PostgreSQL
node scripts/sync-commons.js --category "Category:Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich"

# Auditoría de cultura/lugar: solo lectura; no aplica migraciones ni corrige filas
npm run audit-cultures
npm run audit-cultures -- --culture Calima
```
