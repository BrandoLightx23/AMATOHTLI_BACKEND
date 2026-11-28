-- AMATOHTLI: registra la colección del Historisches Museum Bern
-- Ejecutar una sola vez (idempotente) antes de sincronizar.
INSERT INTO colecciones (nombre, categoria_commons, slug)
VALUES (
  'Pre-Columbian art in the Historisches Museum Bern',
  'Category:Pre-Columbian art in the Historisches Museum Bern',
  'pre-columbian-art-in-the-historisches-museum-bern'
)
ON CONFLICT (categoria_commons) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  slug = EXCLUDED.slug,
  updated_at = NOW();
