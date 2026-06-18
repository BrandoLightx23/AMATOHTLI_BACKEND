-- ============================================================
-- Migración: añade imagen_local y thumbnail_local a la tabla objetos
-- Ejecutar UNA SOLA VEZ en MySQL / phpMyAdmin / mysql CLI
-- ============================================================

USE museo_rietberg;

-- Añade columna para la ruta local de la imagen completa
ALTER TABLE objetos
  ADD COLUMN IF NOT EXISTS imagen_local VARCHAR(255) DEFAULT NULL
    COMMENT 'Ruta local servida por Express: /images/2025.385.jpg'
  AFTER imagen_url;

-- Añade columna para la ruta local del thumbnail (300 px)
ALTER TABLE objetos
  ADD COLUMN IF NOT EXISTS thumbnail_local VARCHAR(255) DEFAULT NULL
    COMMENT 'Ruta local del thumbnail: /images/thumbnails/2025.385.jpg'
  AFTER imagen_local;

-- Verifica el resultado
DESCRIBE objetos;
