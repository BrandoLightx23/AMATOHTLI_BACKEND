-- Seed de colecciones nuevas: Cleveland metalurgia, LACMA y Met
-- Idempotente: se puede correr varias veces sin duplicar.
INSERT INTO colecciones (nombre, categoria_commons, slug)
VALUES
  (
    'Pre-Columbian metalwork in the Cleveland Museum of Art',
    'Category:Pre-Columbian metalwork in the Cleveland Museum of Art',
    'pre-columbian-metalwork-in-the-cleveland-museum-of-art'
  ),
  (
    'Pre-Columbian art in the Los Angeles County Museum of Art',
    'Category:Pre-Columbian art in the Los Angeles County Museum of Art',
    'pre-columbian-art-in-the-los-angeles-county-museum-of-art'
  ),
  (
    'Pre-Columbian art in the Metropolitan Museum of Art',
    'Category:Pre-Columbian art in the Metropolitan Museum of Art',
    'pre-columbian-art-in-the-metropolitan-museum-of-art'
  )
ON CONFLICT (categoria_commons) DO UPDATE
SET nombre = EXCLUDED.nombre,
    slug = EXCLUDED.slug,
    updated_at = NOW();
