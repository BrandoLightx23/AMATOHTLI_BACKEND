'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const pool = require('../config/db');
const originalQuery = pool.query;
const { obtenerColecciones, obtenerTodos } = require('../views/api-view');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test.after(() => {
  pool.query = originalQuery;
});

test('GET /colecciones returns collection totals in the requested shape', async () => {
  let calledQuery;
  pool.query = async query => {
    calledQuery = query;
    return { rows: [{ id: 2, nombre: 'Colección', slug: 'coleccion', total: 3, ignored: true }] };
  };

  const res = response();
  await obtenerColecciones({}, res);

  assert.match(calledQuery, /LEFT JOIN objetos o ON o\.coleccion_id = c\.id/);
  assert.deepEqual(res.body, [{ id: 2, nombre: 'Colección', slug: 'coleccion', total: 3 }]);
});

test('GET /objects remains unfiltered without coleccion_id', async () => {
  const calls = [];
  pool.query = async (...args) => {
    calls.push(args);
    return { rows: [{ id: 1, fecha: null }] };
  };

  const res = response();
  await obtenerTodos({ query: {} }, res);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.doesNotMatch(calls[0][0], /WHERE coleccion_id/);
  assert.deepEqual(Object.keys(res.body), ['categoria', 'total', 'archivos']);
  assert.equal(res.body.total, 1);
});

test('GET /objects filters using a parameter and preserves the response envelope', async () => {
  let called;
  pool.query = async (...args) => {
    called = args;
    return { rows: [{ id: 1, fecha: null }] };
  };

  const res = response();
  await obtenerTodos({ query: { coleccion_id: '42' } }, res);

  assert.match(called[0], /WHERE coleccion_id = \$1/);
  assert.deepEqual(called[1], [42]);
  assert.deepEqual(Object.keys(res.body), ['categoria', 'total', 'archivos']);
  assert.equal(res.body.total, 1);
});

test('GET /objects rejects invalid collection IDs before querying', async () => {
  let queryCount = 0;
  pool.query = async () => {
    queryCount++;
    return { rows: [] };
  };

  for (const coleccion_id of ['0', '-1', '1.5', 'abc', ['1', '2']]) {
    const res = response();
    await obtenerTodos({ query: { coleccion_id } }, res);
    assert.equal(res.statusCode, 400, String(coleccion_id));
  }
  assert.equal(queryCount, 0);
});
