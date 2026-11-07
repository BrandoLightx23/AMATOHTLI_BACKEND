-- ============================================================
-- Migración: añade imagen_local y thumbnail_local a la tabla objetos
-- Ejecutar UNA SOLA VEZ en PostgreSQL / Supabase SQL Editor
-- ============================================================

-- Añade columna para la ruta local de la imagen completa
ALTER TABLE objetos
  ADD COLUMN IF NOT EXISTS imagen_local VARCHAR(255) DEFAULT NULL
;

-- Añade columna para la ruta local del thumbnail (300 px)
ALTER TABLE objetos
  ADD COLUMN IF NOT EXISTS thumbnail_local VARCHAR(255) DEFAULT NULL
;

-- Verifica el resultado
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'objetos'
  AND column_name IN ('imagen_url', 'imagen_local', 'thumbnail_local')
ORDER BY ordinal_position;
