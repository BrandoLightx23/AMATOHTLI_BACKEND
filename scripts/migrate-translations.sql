BEGIN;

CREATE TABLE IF NOT EXISTS objeto_traducciones (
  objeto_id BIGINT NOT NULL REFERENCES objetos(id) ON DELETE CASCADE,
  idioma VARCHAR(10) NOT NULL,
  campos JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_hash CHAR(64) NOT NULL,
  proveedor VARCHAR(50) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'automatica'
    CHECK (estado IN ('automatica', 'revisada')),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (objeto_id, idioma),
  CHECK (jsonb_typeof(campos) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_objeto_traducciones_idioma
  ON objeto_traducciones (idioma);

CREATE TABLE IF NOT EXISTS coleccion_traducciones (
  coleccion_id INT NOT NULL REFERENCES colecciones(id) ON DELETE CASCADE,
  idioma VARCHAR(10) NOT NULL,
  nombre TEXT NOT NULL,
  source_hash CHAR(64) NOT NULL,
  proveedor VARCHAR(50) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'automatica'
    CHECK (estado IN ('automatica', 'revisada')),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (coleccion_id, idioma)
);

COMMIT;
