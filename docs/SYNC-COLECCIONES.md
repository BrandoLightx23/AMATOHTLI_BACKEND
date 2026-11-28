# Sincronización de nuevas colecciones (Birmingham + Cleveland)

Rama: `feat/commons-sync-collections`
Autor del cambio: Brando (preparado con asistencia de Rumi, revisado por Brando).

## Colecciones revisadas en Commons (2026-11-27)

### 1. Birmingham Museum of Art
- Categoría: `Category:Pre-Columbian art in the Birmingham Museum of Art`
- Archivos: 13
- Licencia: CC BY 3.0 (Sean Pathasema / Birmingham Museum of Art, VRTS)
- Inventario: no trae número de inventario ni ítem Wikidata. Identificar por `commons_title`.
- Slug: `pre-columbian-art-in-the-birmingham-museum-of-art`

### 2. Cleveland Museum of Art — arte maya
- Categoría: `Category:Mayan art in the Cleveland Museum of Art`
- Archivos: 64 (incluye recortes y detalles duplicados)
- Licencia: CC0, con enlace a catálogo `clevelandart.org/art/...`
- Inventario: número de acceso en el título, ej. `Clevelandart 1962.32.jpg`
- Slug: `mayan-art-in-the-cleveland-museum-of-art`
- **Regla de deduplicación:** agrupar por número de acceso (ej. `1962.32`) y quedarse con la foto principal (sin `(cropped)`, sin `Detail/Deatil`). Las versiones recortadas NO deben crear objetos duplicados.

## Reglas de sincronización

1. Nunca consultar Wikimedia en vivo desde el frontend. La ingesta es solo vía `scripts/sync-commons.js` hacia Supabase/PostgreSQL.
2. Respetar Wikimedia: User-Agent con contacto, `maxlag=5`, lotes de 50, backoff ante 429 respetando `Retry-After`.
3. Upsert idempotente por `commons_title`. No sobrescribir metadatos curados (usar `COALESCE` como ya hace el script).
4. Procedencia: si no hay dato, dejar `NULL` / “por confirmar”. No afirmar proveniencia arqueológica para toda la colección.
5. Ámbito geográfico: no etiquetar todo como “Mesoamérica”; usar el nombre de la colección y la cultura/lugar real de cada pieza.
6. Cleveland: deduplicar por número de acceso antes del upsert final. Birmingham: aceptar sin inventario, clave = `commons_title`.

## Pasos para sincronizar desde tu equipo

```bash
# 1. Cambiar a la rama
git checkout feat/commons-sync-collections
git pull

# 2. Registrar las colecciones (idempotente)
psql "$DATABASE_URL" -f scripts/seed-colecciones-birmingham-cleveland.sql
# o con el cliente de tu preferencia apuntando a Supabase

# 3. Dry-run Birmingham (13 archivos, sin escribir en BD)
node scripts/sync-commons.js --category "Category:Pre-Columbian art in the Birmingham Museum of Art" --dry-run

# 4. Dry-run Cleveland limitado (validar deduplicación)
node scripts/sync-commons.js --category "Category:Mayan art in the Cleveland Museum of Art" --dry-run --limit 20

# 5. Sync real Birmingham
node scripts/sync-commons.js --category "Category:Pre-Columbian art in the Birmingham Museum of Art"

# 6. Sync real Cleveland (tras revisar duplicados por acceso)
node scripts/sync-commons.js --category "Category:Mayan art in the Cleveland Museum of Art"
```

## Notas
- El script ya soporta `--category`, `--dry-run` y `--limit`; no requiere reescritura.
- La sincronización real debe correr donde estén los secretos de BD (tu equipo o GitHub Actions con `DB_*` en Secrets), nunca con la anon key por RLS.
- Tras sincronizar, verificar conteos por `coleccion_id` y revisar piezas sin inventario / sin coordenadas antes de exponerlas en el front.
