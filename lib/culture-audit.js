'use strict';

const {
  BATCH_SIZE,
  chunk,
  enrichBatch,
  fetchWikidataEntities,
  getClaimIds,
  getLabel,
} = require('../scripts/sync-commons');

const KNOWN_CULTURE_COUNTRIES = new Map([
  ['calima', 'colombia'],
]);

const EXPLICIT_ORIGIN_COUNTRIES = new Map([
  ['colombia', 'colombia'],
  ['mexico', 'mexico'],
  ['peru', 'peru'],
]);

function normalizedLabels(value) {
  return String(value || '')
    .split(/[,;|]/)
    .map(label => label.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .sort();
}

function normalizedCultureLabels(value) {
  return [...new Set(normalizedLabels(value).map(label => label
    .replace(/^(?:cultura|culture)\s+/, '')
    .replace(/\s+(?:cultura|culture)$/, '')
    .trim()))].filter(Boolean).sort();
}

function labelsMatch(saved, source) {
  const savedLabels = normalizedLabels(saved);
  const sourceLabels = [...new Set(normalizedLabels(source))];
  return savedLabels.length === sourceLabels.length &&
    savedLabels.every((label, index) => label === sourceLabels[index]);
}

function buildCultureAudit(rows, commonsItems, entities, referencedEntities) {
  const commonsByTitle = new Map(commonsItems.map(item => [item.title, item]));
  const findings = [];

  for (const row of rows) {
    const statuses = [];
    let qid = null;
    let sourceCulture = null;
    let sourceOrigin = null;

    if (!row.commons_title) {
      statuses.push('absent_commons_link');
    } else {
      const commons = commonsByTitle.get(row.commons_title);
      if (!commons) {
        statuses.push('absent_commons_file');
      } else if (!commons.wikidataQid) {
        statuses.push('absent_wikidata_qid');
      } else {
        qid = commons.wikidataQid;
        const entity = entities[qid];
        if (!entity) {
          statuses.push('absent_wikidata_entity');
        } else {
          const cultureIds = getClaimIds(entity, 'P2596');
          const originIds = getClaimIds(entity, 'P1071');
          sourceCulture = [...new Set(cultureIds
            .map(id => getLabel(referencedEntities[id]))
            .filter(Boolean))].join(', ') || null;
          sourceOrigin = [...new Set(originIds
            .map(id => getLabel(referencedEntities[id]))
            .filter(Boolean))].join(', ') || null;

          if (!sourceCulture) statuses.push('culture_source_absent');
          else if (normalizedCultureLabels(row.estilo_cultura).join('|') !==
              normalizedCultureLabels(sourceCulture).join('|')) statuses.push('culture_mismatch');

          if (!sourceOrigin) statuses.push('origin_source_absent');
          else if (!labelsMatch(row.lugar_origen, sourceOrigin)) statuses.push('origin_mismatch');

          const cultureLabels = normalizedCultureLabels(sourceCulture || row.estilo_cultura);
          const originLabels = normalizedLabels(sourceOrigin);
          const expectedCountry = cultureLabels.length === 1
            ? KNOWN_CULTURE_COUNTRIES.get(cultureLabels[0])
            : null;
          const actualCountry = originLabels.length === 1
            ? EXPLICIT_ORIGIN_COUNTRIES.get(originLabels[0])
            : null;
          if (expectedCountry && actualCountry && expectedCountry !== actualCountry) {
            statuses.push('culture_origin_conflict');
          }
        }
      }
    }

    if (statuses.length) {
      findings.push({
        object_id: row.id,
        inventory: row.numero_inventario,
        commons_title: row.commons_title,
        qid,
        saved_values: {
          culture: row.estilo_cultura,
          origin: row.lugar_origen,
        },
        source_values: {
          culture: sourceCulture,
          origin: sourceOrigin,
        },
        status: statuses,
      });
    }
  }

  return findings;
}

async function loadAuditRows(pool, culture) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`
      SELECT id, numero_inventario, commons_title, estilo_cultura, lugar_origen
      FROM objetos
      ${culture ? 'WHERE estilo_cultura ILIKE $1::text' : ''}
      ORDER BY id
    `, culture ? [`%${culture}%`] : undefined);
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      err.message += ` (también falló ROLLBACK: ${rollbackError.message})`;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function runCultureAudit(pool, api = {}, options = {}) {
  const loadCommonsBatch = api.enrichBatch || enrichBatch;
  const loadEntities = api.fetchWikidataEntities || fetchWikidataEntities;
  const rows = await loadAuditRows(pool, options.culture);
  const linkedRows = rows.filter(row => row.commons_title);
  const commonsItems = [];

  for (const batch of chunk(linkedRows.map(row => row.commons_title), BATCH_SIZE)) {
    commonsItems.push(...await loadCommonsBatch(batch));
  }

  const qids = [...new Set(commonsItems.map(item => item.wikidataQid).filter(Boolean))];
  const entities = qids.length ? await loadEntities(qids) : {};
  const referenceIds = new Set();
  for (const qid of qids) {
    const entity = entities[qid];
    if (!entity) continue;
    for (const property of ['P2596', 'P1071']) {
      for (const id of getClaimIds(entity, property)) referenceIds.add(id);
    }
  }

  const referencedEntities = referenceIds.size
    ? await loadEntities([...referenceIds])
    : {};
  const findings = buildCultureAudit(rows, commonsItems, entities, referencedEntities);
  const statusCounts = {};
  for (const finding of findings) {
    for (const status of finding.status) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
  }

  return {
    scanned: rows.length,
    findings: findings.length,
    status_counts: statusCounts,
    rows: findings,
  };
}

module.exports = {
  buildCultureAudit,
  labelsMatch,
  runCultureAudit,
};
