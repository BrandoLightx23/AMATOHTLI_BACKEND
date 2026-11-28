'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const pool = require('../config/db');
const router = require('../routes/api');
const { obtenerColecciones, obtenerTodos } = require('../views/api-view');

function createResponse() {
  return {
    body: null,
    statusCode: 200,
    json(body) {
      this.body = body;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
  };
}

test('collections API is registered and returns localized collection names', async t => {
  const route = router.stack.find(layer => layer.route?.path === '/colecciones');
  assert.ok(route);
  assert.equal(route.route.methods.get, true);

  t.mock.method(pool, 'query', async (sql, values) => {
    assert.match(sql, /coleccion_traducciones/);
    assert.deepEqual(values, ['en']);
    return {
      rows: [{ id: 2, nombre: 'Museum collection', slug: 'museum', total: 3 }],
    };
  });

  const res = createResponse();
  await obtenerColecciones({ query: { idioma: 'en' } }, res);

  assert.deepEqual(res.body, {
    total: 1,
    colecciones: [{ id: 2, nombre: 'Museum collection', slug: 'museum', total: 3 }],
  });
});

test('objects API returns English fields and collection IDs when requested', async t => {
  t.mock.method(pool, 'query', async (sql, values) => {
    assert.match(sql, /objeto_traducciones/);
    assert.match(sql, /o\.coleccion_id/);
    assert.deepEqual(values, ['en']);
    return {
      rows: [{
        id: 8,
        coleccion_id: 2,
        titulo: 'Vase',
        descripcion: 'Ceremonial vessel',
        autor: 'Unknown artist',
        lugar_origen: 'Perú',
        estilo_cultura: 'Maya',
        fecha: '900 d. C.',
        tipo_objeto: 'Cerámica',
        material_tecnica: 'Cerámica',
        otras_denominaciones: 'Cántaro',
        numero_inventario: 'INV-8',
        dimensiones: '15 cm',
        translated_fields: {
          titulo: 'Ceremonial vessel',
          descripcion: 'A ceremonial container',
          tipo_objeto: 'Vessel',
          material_tecnica: 'Ceramic',
          otras_denominaciones: 'Pitcher',
        },
      }],
    };
  });

  const res = createResponse();
  await obtenerTodos({ query: { idioma: 'en' } }, res);

  assert.equal(res.body.archivos[0].coleccion_id, 2);
  assert.equal(res.body.archivos[0].titulo, 'Ceremonial vessel');
  assert.equal(res.body.archivos[0].descripcion, 'A ceremonial container');
  assert.equal(res.body.archivos[0].tipo_objeto, 'Vessel');
  assert.equal(res.body.archivos[0].material_tecnica, 'Ceramic');
  assert.equal(res.body.archivos[0].otras_denominaciones, 'Pitcher');
});

test('objects API applies Spanish catalog translations when requested', async t => {
  t.mock.method(pool, 'query', async (sql, values) => {
    assert.match(sql, /objeto_traducciones/);
    assert.deepEqual(values, ['es']);
    return {
      rows: [{
        id: 9,
        titulo: 'Original German title',
        material_tecnica: 'German material',
        translated_fields: {
          titulo: 'Título en español',
          material_tecnica: 'Material en español',
        },
      }],
    };
  });

  const res = createResponse();
  await obtenerTodos({ query: { idioma: 'es' } }, res);

  assert.equal(res.body.archivos[0].titulo, 'Título en español');
  assert.equal(res.body.archivos[0].material_tecnica, 'Material en español');
});
