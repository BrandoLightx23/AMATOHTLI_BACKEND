'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCultureAudit, runCultureAudit } = require('../lib/culture-audit');

function fakePool(rows) {
  const statements = [];
  const parameters = [];
  return {
    statements,
    parameters,
    async connect() {
      return {
        async query(sql, values) {
          statements.push(sql.trim());
          parameters.push(values);
          if (sql.includes('FROM objetos')) {
            const culture = values?.[0]?.replace(/%/g, '').toLowerCase();
            return {
              rows: culture
                ? rows.filter(row => row.estilo_cultura?.toLowerCase().includes(culture))
                : rows,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
}

function claim(id) {
  return { mainsnak: { datavalue: { value: { id } } } };
}

test('culture audit is read-only and reports only mismatches and absent sources', async () => {
  const pool = fakePool([
    {
      id: 1,
      numero_inventario: '2025.1',
      commons_title: 'File:one.jpg',
      estilo_cultura: 'Azteca',
      lugar_origen: 'Colombia',
    },
    {
      id: 2,
      numero_inventario: '2025.2',
      commons_title: 'File:two.jpg',
      estilo_cultura: 'Calima',
      lugar_origen: 'Colombia',
    },
    {
      id: 3,
      numero_inventario: '2025.3',
      commons_title: null,
      estilo_cultura: 'Legacy',
      lugar_origen: null,
    },
  ]);
  const api = {
    async enrichBatch(titles) {
      return titles.map((title, index) => ({
        title,
        wikidataQid: index === 0 ? 'Q1' : null,
      }));
    },
    async fetchWikidataEntities(ids) {
      if (ids.includes('Q1')) {
        return { Q1: { claims: { P2596: [claim('Q10')], P1071: [claim('Q20')] } } };
      }
      return {
        Q10: { labels: { es: { value: 'Calima' } } },
        Q20: { labels: { es: { value: 'Colombia' } } },
      };
    },
  };

  const report = await runCultureAudit(pool, api);

  assert.equal(pool.statements[0], 'BEGIN READ ONLY');
  assert.equal(
    pool.statements[1].replace(/\s+/g, ' '),
    'SELECT id, numero_inventario, commons_title, estilo_cultura, lugar_origen FROM objetos ORDER BY id'
  );
  assert.equal(pool.statements[2], 'COMMIT');
  assert.equal(report.scanned, 3);
  assert.equal(report.findings, 3);
  assert.deepEqual(report.rows[0], {
    object_id: 1,
    inventory: '2025.1',
    commons_title: 'File:one.jpg',
    qid: 'Q1',
    saved_values: { culture: 'Azteca', origin: 'Colombia' },
    source_values: { culture: 'Calima', origin: 'Colombia' },
    status: ['culture_mismatch'],
  });
  assert.deepEqual(report.rows[1].status, ['absent_wikidata_qid']);
  assert.deepEqual(report.rows[2].status, ['absent_commons_link']);
  assert.equal(pool.statements.some(statement => /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(statement)), false);
});

test('culture audit reports saved values where Wikidata has no corresponding source claims', async () => {
  const pool = fakePool([{
    id: 7,
    numero_inventario: '2025.7',
    commons_title: 'File:seven.jpg',
    estilo_cultura: 'Manual culture',
    lugar_origen: null,
  }]);

  const report = await runCultureAudit(pool, {
    async enrichBatch() {
      return [{ title: 'File:seven.jpg', wikidataQid: 'Q7' }];
    },
    async fetchWikidataEntities(ids) {
      return ids.includes('Q7') ? { Q7: { claims: {} } } : {};
    },
  });

  assert.deepEqual(report.rows[0].status, ['culture_source_absent', 'origin_source_absent']);
  assert.deepEqual(report.rows[0].source_values, { culture: null, origin: null });
});

test('culture audit detects the exact Calima-Colombia versus Mexico conflict', () => {
  const claims = ids => ids.map(id => claim(id));
  const findings = buildCultureAudit(
    [{
      id: 21,
      numero_inventario: '2025.21',
      commons_title: 'File:calima.jpg',
      estilo_cultura: 'Calima',
      lugar_origen: 'México',
    }],
    [{ title: 'File:calima.jpg', wikidataQid: 'Q21' }],
    {
      Q21: {
        claims: {
          P2596: claims(['QCALIMA']),
          P1071: claims(['QMEXICO']),
        },
      },
    },
    {
      QCALIMA: { labels: { es: { value: 'Calima' } } },
      QMEXICO: { labels: { es: { value: 'México' } } },
    }
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].qid, 'Q21');
  assert.deepEqual(findings[0].source_values, { culture: 'Calima', origin: 'México' });
  assert.deepEqual(findings[0].status, ['culture_origin_conflict']);
});

test('culture audit uses an exact saved Calima label when Wikidata omits P2596', () => {
  const findings = buildCultureAudit(
    [{
      id: 23,
      numero_inventario: '2025.23',
      commons_title: 'File:calima-no-claim.jpg',
      estilo_cultura: 'Cultura Calima',
      lugar_origen: 'México',
    }],
    [{ title: 'File:calima-no-claim.jpg', wikidataQid: 'Q23' }],
    {
      Q23: { claims: { P1071: [claim('QMEXICO')] } },
    },
    {
      QMEXICO: { labels: { es: { value: 'México' } } },
    }
  );

  assert.equal(findings[0].qid, 'Q23');
  assert.deepEqual(findings[0].source_values, { culture: null, origin: 'México' });
  assert.deepEqual(findings[0].status, ['culture_source_absent', 'culture_origin_conflict']);
});

test('culture audit does not infer a conflict for multiple cultures or non-country origins', () => {
  const claims = ids => ids.map(id => claim(id));
  const findings = buildCultureAudit(
    [{
      id: 22,
      numero_inventario: '2025.22',
      commons_title: 'File:mixed.jpg',
      estilo_cultura: 'Calima, Azteca',
      lugar_origen: 'Región histórica',
    }],
    [{ title: 'File:mixed.jpg', wikidataQid: 'Q22' }],
    {
      Q22: {
        claims: {
          P2596: claims(['QCALIMA', 'QAZTECA']),
          P1071: claims(['QREGION']),
        },
      },
    },
    {
      QCALIMA: { labels: { es: { value: 'Calima' } } },
      QAZTECA: { labels: { es: { value: 'Azteca' } } },
      QREGION: { labels: { es: { value: 'Región histórica' } } },
    }
  );

  assert.deepEqual(findings, []);
});

test('culture filter selects only matching rows inside a read-only transaction', async () => {
  const pool = fakePool([
    {
      id: 1,
      numero_inventario: '2025.1',
      commons_title: 'File:calima.jpg',
      estilo_cultura: 'Calima',
      lugar_origen: 'México',
    },
    {
      id: 2,
      numero_inventario: '2025.2',
      commons_title: 'File:aztec.jpg',
      estilo_cultura: 'Azteca',
      lugar_origen: 'Mexico',
    },
  ]);
  const report = await runCultureAudit(pool, {
    async enrichBatch(titles) {
      return titles.map(title => ({ title, wikidataQid: 'Q1' }));
    },
    async fetchWikidataEntities(ids) {
      if (ids.includes('Q1')) {
        return { Q1: { claims: { P2596: [claim('Q10')], P1071: [claim('Q20')] } } };
      }
      return {
        Q10: { labels: { es: { value: 'Calima' } } },
        Q20: { labels: { es: { value: 'México' } } },
      };
    },
  }, { culture: 'Calima' });

  assert.equal(report.scanned, 1);
  assert.deepEqual(report.rows[0].status, ['culture_origin_conflict']);
  assert.match(pool.statements[1], /WHERE estilo_cultura ILIKE \$1::text/);
  assert.deepEqual(pool.parameters[1], ['%Calima%']);
  assert.equal(pool.statements[0], 'BEGIN READ ONLY');
});
