-- Seed de colecciones adicionales para AMATOHTLI (CoAfina 2026, anexo).
-- Ejecutar DESPUÉS de migrate-colecciones.sql / migrate-colecciones.js.
-- Idempotente: ON CONFLICT (categoria_commons) DO UPDATE.

INSERT INTO colecciones (nombre, categoria_commons, slug) VALUES
  (
    'Pre-Columbian art in the Birmingham Museum of Art',
    'Category:Pre-Columbian art in the Birmingham Museum of Art',
    'pre-columbian-art-in-the-birmingham-museum-of-art'
  ),
  (
    'Mayan art in the Cleveland Museum of Art',
    'Category:Mayan art in the Cleveland Museum of Art',
    'mayan-art-in-the-cleveland-museum-of-art'
  )
ON CONFLICT (categoria_commons) DO UPDATE
SET nombre = EXCLUDED.nombre,
    slug = EXCLUDED.slug,
    updated_at = now();

-- Verificación:
-- SELECT id, nombre, categoria_commons, slug FROM colecciones ORDER BY id;
