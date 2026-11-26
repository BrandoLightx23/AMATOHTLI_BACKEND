'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractDimensions,
  extractFecha,
  isLegacyGeneratedTitle,
  legacyGeneratedTitle,
  parseInventory,
  cleanTitle,
  saveObject,
} = require('../scripts/sync-commons');

function time(year) {
  const sign = year < 0 ? '-' : '+';
  return { time: `${sign}${String(Math.abs(year)).padStart(4, '0')}-00-00T00:00:00Z` };
}

function quantity(amount, unit) {
  return { mainsnak: { datavalue: { value: { amount: String(amount), unit } } } };
}

function fakePool(rows, updateRowCount = 1) {
  const calls = [];
  return {
    calls,
    async connect() {
      return {
        async query(sql, values) {
          calls.push({ sql, values });
          if (sql.trimStart().startsWith('SELECT id, coleccion_id')) {
            return { rows };
          }
          if (sql.startsWith('UPDATE objetos SET')) return { rowCount: updateRowCount };
          if (sql.startsWith('INSERT INTO objetos')) return { rowCount: 1 };
          return { rowCount: 0 };
        },
        release() {},
      };
    },
  };
}

const syncItem = {
  title: 'File:Inv.Nr.-2025.352.2-Object.jpg',
  pageid: 44,
  thumburl: 'https://commons.example/thumb.jpg',
  url: 'https://commons.example/image.jpg',
  width: 1200,
  height: 800,
  mime: 'image/jpeg',
  fecha: '1900 d. C.',
};

test('parseInventory retains dotted inventory subnumbers', () => {
  assert.equal(parseInventory('File:Inv.Nr.-2025.352.2-Object.jpg'), '2025.352.2');
  assert.equal(parseInventory('File:No inventory.jpg'), null);
});

test('cleanTitle removes Commons metadata and keeps the artifact name readable', () => {
  assert.equal(
    cleanTitle('File:Museum-Rietberg-Zürich-Inv.Nr.-2025.292-Figürchen.jpg'),
    'Figürchen'
  );
  assert.equal(
    cleanTitle('Museum_Rietberg_Zürich-Museum-Rietberg-Zürich_Inv.Nr.-2025.292.1_Figürchen.png'),
    'Figürchen'
  );
});

test('legacy title detection matches only the previous filename-derived format', () => {
  const commonsTitle = 'File:Museum-Rietberg-Zürich-Inv.Nr.-2025.292-Figürchen.jpg';
  const oldGeneratedTitle = 'Museum-Rietberg-Zürich-Inv.Nr.-2025.292-Figürchen';

  assert.equal(legacyGeneratedTitle(commonsTitle), oldGeneratedTitle);
  assert.equal(isLegacyGeneratedTitle(oldGeneratedTitle, commonsTitle), true);
  assert.equal(isLegacyGeneratedTitle('Figura ceremonial', commonsTitle), false);
  assert.equal(isLegacyGeneratedTitle(null, commonsTitle), false);
});

test('extractFecha prefers Wikidata date-range qualifiers over the main date', () => {
  const entity = {
    claims: {
      P571: [{
        mainsnak: { datavalue: { value: time(1900) } },
        qualifiers: {
          P1319: [{ datavalue: { value: time(1850) } }],
          P1326: [{ datavalue: { value: time(1920) } }],
        },
      }],
    },
  };

  assert.equal(extractFecha(entity), '1850 d. C. – 1920 d. C.');
});

test('extractFecha formats a single date qualifier when only one bound exists', () => {
  const entity = {
    claims: {
      P571: [{
        mainsnak: { datavalue: { value: time(1900) } },
        qualifiers: {
          P1319: [{ datavalue: { value: time(-200) } }],
        },
      }],
    },
  };

  assert.equal(extractFecha(entity), 'Desde 200 a. C.');
});

test('extractDimensions skips unsupported units instead of labeling them as cm', () => {
  const entity = {
    claims: {
      P2048: [quantity(2, 'http://www.wikidata.org/entity/Q11573')],
      P2049: [quantity(35, 'http://www.wikidata.org/entity/Q174728')],
      P2043: [quantity(8, 'http://www.wikidata.org/entity/Q174789')],
      P2386: [quantity(3, 'http://www.wikidata.org/entity/Q999999')],
    },
  };

  assert.equal(extractDimensions(entity), 'Alto: 2 m, Ancho: 35 cm, Largo: 8 mm');
});

test('saveObject updates a legacy inventory row without replacing curated columns', async () => {
  const pool = fakePool([{
    id: 8,
    coleccion_id: 3,
    commons_title: null,
    numero_inventario: '2025.352.2',
  }]);

  assert.equal(await saveObject(pool, 3, syncItem), 'updated');
  const update = pool.calls.find(call => call.sql.startsWith('UPDATE objetos SET'));
  assert.ok(update);
  assert.doesNotMatch(update.sql, /(?:^|,)\s*(?:coleccion_id|autor|creditos|imagen_local)\s*=/);
  assert.match(update.sql, /titulo = CASE WHEN \$3::boolean THEN \$8::varchar ELSE titulo END/);
  assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO objetos')), false);
});

test('saveObject reports unchanged when no source-owned fields differ', async () => {
  const pool = fakePool([{
    id: 8,
    coleccion_id: 3,
    commons_title: syncItem.title,
    numero_inventario: '2025.352.2',
  }], 0);

  assert.equal(await saveObject(pool, 3, syncItem), 'unchanged');
});

test('saveObject repairs an exactly matched legacy-generated title', async () => {
  const legacyTitle = legacyGeneratedTitle(syncItem.title);
  const pool = fakePool([{
    id: 8,
    coleccion_id: 3,
    commons_title: syncItem.title,
    numero_inventario: '2025.352.2',
    titulo: legacyTitle,
  }]);

  assert.equal(await saveObject(pool, 3, syncItem), 'updated');
  const update = pool.calls.find(call => call.sql.startsWith('UPDATE objetos SET'));
  assert.equal(update.values[2], true);
  assert.equal(update.values[7], cleanTitle(syncItem.title));
});

test('saveObject does not repair a curated title', async () => {
  const pool = fakePool([{
    id: 8,
    coleccion_id: 3,
    commons_title: syncItem.title,
    numero_inventario: '2025.352.2',
    titulo: 'Figura ceremonial',
  }], 0);

  assert.equal(await saveObject(pool, 3, syncItem), 'unchanged');
  const update = pool.calls.find(call => call.sql.startsWith('UPDATE objetos SET'));
  assert.equal(update.values[2], false);
  assert.equal(update.values[7], cleanTitle(syncItem.title));
});

test('saveObject binds nullable page IDs with an explicit PostgreSQL type', async () => {
  const pool = fakePool([{
    id: 8,
    coleccion_id: 3,
    commons_title: syncItem.title,
    numero_inventario: '2025.352.2',
    titulo: 'Figura ceremonial',
  }], 0);

  assert.equal(await saveObject(pool, 3, { ...syncItem, pageid: null }), 'unchanged');
  const update = pool.calls.find(call => call.sql.startsWith('UPDATE objetos SET'));
  assert.equal(update.values[3], null);
  assert.match(update.sql, /COALESCE\(\$4::integer, commons_pageid\)/);
  assert.match(update.sql, /\$4::integer IS NOT NULL/);

  const usedParameters = new Set([...update.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
  assert.equal(Math.max(...usedParameters), update.values.length);
  for (let parameter = 1; parameter <= update.values.length; parameter++) {
    assert.equal(usedParameters.has(parameter), true);
  }
});

test('saveObject rejects conflicting legacy matches and rolls back', async () => {
  const pool = fakePool([
    { id: 8, coleccion_id: 4, commons_title: syncItem.title, numero_inventario: null },
    { id: 9, coleccion_id: 3, commons_title: null, numero_inventario: '2025.352.2' },
  ]);

  await assert.rejects(
    saveObject(pool, 3, syncItem),
    /apuntan a objetos distintos/
  );
  assert.equal(pool.calls.some(call => call.sql.trim() === 'ROLLBACK'), true);
  assert.equal(pool.calls.some(call => call.sql.startsWith('UPDATE objetos SET')), false);
});

test('saveObject inserts a new item', async () => {
  const pool = fakePool([]);

  assert.equal(await saveObject(pool, 3, syncItem), 'inserted');
  const insert = pool.calls.find(call => call.sql.startsWith('INSERT INTO objetos'));
  assert.ok(insert);
  assert.match(insert.sql, /estilo_cultura_source, lugar_origen_source/);
  assert.match(insert.sql, /'wikidata', 'wikidata'\)$/);
});

test('saveObject only replaces and clears culture fields managed by Wikidata', async () => {
  const pool = fakePool([{
    id: 8,
    coleccion_id: 3,
    commons_title: syncItem.title,
    numero_inventario: '2025.352.2',
    titulo: 'Título curado',
  }]);

  assert.equal(await saveObject(pool, 3, { ...syncItem, estilo_cultura: null, lugar_origen: null }), 'updated');
  const update = pool.calls.find(call => call.sql.startsWith('UPDATE objetos SET'));
  assert.match(update.sql, /CASE WHEN lugar_origen_source = 'wikidata' THEN \$13::varchar ELSE lugar_origen END/);
  assert.match(update.sql, /CASE WHEN estilo_cultura_source = 'wikidata' THEN \$14::varchar ELSE estilo_cultura END/);
  assert.match(update.sql, /lugar_origen_source = 'wikidata' AND lugar_origen IS DISTINCT FROM \$13::varchar/);
  assert.match(update.sql, /estilo_cultura_source = 'wikidata' AND estilo_cultura IS DISTINCT FROM \$14::varchar/);
});
