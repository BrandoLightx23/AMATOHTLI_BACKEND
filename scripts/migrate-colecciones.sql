-- Migración aditiva para colecciones Wikimedia y sincronización Commons.
-- No elimina objetos ni los vuelve a sembrar. Si hay duplicados que impiden
-- la nueva unicidad, aborta la transacción y conserva el esquema anterior.

BEGIN;

CREATE TABLE IF NOT EXISTS colecciones (
  id                SERIAL PRIMARY KEY,
  nombre            TEXT NOT NULL,
  categoria_commons TEXT NOT NULL UNIQUE,
  slug              TEXT UNIQUE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE objetos ADD COLUMN IF NOT EXISTS coleccion_id   INT REFERENCES colecciones(id);
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS commons_title  TEXT;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS commons_pageid INT;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS thumb_url      TEXT;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS image_width    INT;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS image_height   INT;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS mime           TEXT;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS lat            DOUBLE PRECISION;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS lon            DOUBLE PRECISION;
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS estilo_cultura_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS lugar_origen_source   TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE objetos ADD COLUMN IF NOT EXISTS descripcion        TEXT;

UPDATE objetos
SET estilo_cultura_source = COALESCE(estilo_cultura_source, 'legacy'),
    lugar_origen_source = COALESCE(lugar_origen_source, 'legacy')
WHERE estilo_cultura_source IS NULL OR lugar_origen_source IS NULL;

INSERT INTO colecciones (nombre, categoria_commons, slug)
VALUES (
  'Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich',
  'Category:Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich',
  'anne-marie-und-caspar-reinhart-collection-at-museum-rietberg-zurich'
)
ON CONFLICT (categoria_commons) DO NOTHING;

UPDATE objetos
SET coleccion_id = (
  SELECT id FROM colecciones
  WHERE categoria_commons = 'Category:Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich'
)
WHERE coleccion_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM objetos
    WHERE commons_title IS NOT NULL
    GROUP BY commons_title
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migración abortada: hay commons_title duplicados; resuélvelos antes de crear el índice.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM objetos
    WHERE coleccion_id IS NOT NULL AND numero_inventario IS NOT NULL
    GROUP BY coleccion_id, numero_inventario
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migración abortada: hay números de inventario duplicados dentro de una colección.';
  END IF;
END
$$;

-- Reemplaza la unicidad global: distintas colecciones pueden compartir
-- número de inventario, pero una misma colección no.
DROP INDEX IF EXISTS uk_inventario;
CREATE UNIQUE INDEX IF NOT EXISTS uk_inventario_coleccion
  ON objetos (coleccion_id, numero_inventario)
  WHERE coleccion_id IS NOT NULL AND numero_inventario IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS objetos_commons_title_unique
  ON objetos (commons_title)
  WHERE commons_title IS NOT NULL;

COMMIT;
