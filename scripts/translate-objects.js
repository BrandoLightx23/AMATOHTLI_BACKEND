#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const db = require('../config/db');

const DEFAULT_TARGET_LANGUAGE = 'en';
const SUPPORTED_TARGET_LANGUAGES = ['en', 'es'];
const DEFAULT_LIBRETRANSLATE_URL = 'http://127.0.0.1:5000';
const PROVIDER = 'libretranslate-local';
const OBJECT_BATCH_SIZE = 20;
const MAX_TEXTS_PER_BATCH = 64;
const MAX_CHARS_PER_BATCH = 20_000;
const MAX_TEXT_LENGTH = 30_000;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const TRANSLATION_CONCURRENCY = 2;
const MIN_AUTO_DETECTION_CONFIDENCE = 50;
const REQUIRED_SOURCE_LANGUAGES = ['de', 'en', 'es', 'it'];
// Some catalogue fields are multilingual, so these hints are used only when auto-detection is uncertain.
const COLLECTION_LANGUAGE_HINTS = {
  'anne-marie-und-caspar-reinhart-collection-at-museum-rietberg-zurich': {
    default: 'de',
    fields: {
      tipo_objeto: 'es',
      material_tecnica: 'es',
      otras_denominaciones: 'es',
    },
  },
  'mayan-art-in-the-cleveland-museum-of-art': {
    default: 'en',
    fields: { tipo_objeto: 'es' },
  },
  'pre-columbian-art-in-the-birmingham-museum-of-art': {
    default: 'en',
  },
  'pre-columbian-metalwork-in-the-cleveland-museum-of-art': {
    default: 'it',
    fields: { material_tecnica: 'en' },
  },
  'pre-columbian-art-in-the-los-angeles-county-museum-of-art': {
    default: 'en',
  },
  'pre-columbian-art-in-the-metropolitan-museum-of-art': {
    default: 'en',
  },
  'pre-columbian-art-in-the-historisches-museum-bern': {
    default: 'it',
    fields: { material_tecnica: 'en' },
  },
};
const SOURCE_FIELDS = [
  'titulo',
  'descripcion',
  'tipo_objeto',
  'material_tecnica',
  'otras_denominaciones',
];
const COLLECTION_FIELDS = ['nombre'];

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: null,
    collection: null,
    target: DEFAULT_TARGET_LANGUAGE,
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--dry-run') args.dryRun = true;
    else if (argv[index] === '--target') {
      args.target = argv[++index];
      if (!SUPPORTED_TARGET_LANGUAGES.includes(args.target)) {
        throw new Error(`--target debe ser uno de: ${SUPPORTED_TARGET_LANGUAGES.join(', ')}`);
      }
    }
    else if (argv[index] === '--limit') {
      const limit = Number(argv[++index]);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('--limit debe ser un entero positivo');
      }
      args.limit = limit;
    } else if (argv[index] === '--collection') {
      args.collection = argv[++index];
      if (!args.collection) throw new Error('--collection requiere un slug');
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      args.help = true;
    } else {
      throw new Error(`Argumento desconocido: ${argv[index]}`);
    }
  }
  return args;
}

function sourceFieldsFor(row, fields = SOURCE_FIELDS) {
  return Object.fromEntries(fields
    .map(field => [field, typeof row[field] === 'string' ? row[field].trim() : ''])
    .filter(([, value]) => value.length > 0));
}

function hashSourceFields(fields) {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function createTranslationJob(row, entityType = 'objeto') {
  const fields = sourceFieldsFor(row, entityType === 'coleccion' ? COLLECTION_FIELDS : SOURCE_FIELDS);
  return {
    entityType,
    id: row.id,
    collectionSlug: row.collection_slug,
    title: row.titulo || row.nombre || `${entityType} ${row.id}`,
    fields,
    sourceHash: hashSourceFields(fields),
    previousSourceHash: row.translated_source_hash,
    translatedFields: {},
  };
}

function chunkSegments(segments) {
  const chunks = [];
  let chunk = [];
  let chars = 0;
  for (const segment of segments) {
    if (segment.text.length > MAX_TEXT_LENGTH) {
      throw new Error(`El texto del campo ${segment.field} supera el límite de ${MAX_TEXT_LENGTH} caracteres`);
    }
    if (chunk.length && (
      chunk.length >= MAX_TEXTS_PER_BATCH
      || chars + segment.text.length > MAX_CHARS_PER_BATCH
    )) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(segment);
    chars += segment.text.length;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function getLibreTranslateUrl(path, baseUrl = process.env.LIBRETRANSLATE_URL || DEFAULT_LIBRETRANSLATE_URL) {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBaseUrl);
}

function sourceLanguageHint(collectionSlug, field, entityType) {
  const collectionHints = COLLECTION_LANGUAGE_HINTS[collectionSlug];
  if (!collectionHints) return undefined;
  return entityType === 'coleccion'
    ? collectionHints.default
    : collectionHints.fields?.[field] || collectionHints.default;
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function checkLibreTranslate(baseUrl, targetLanguage = DEFAULT_TARGET_LANGUAGE) {
  let response;
  try {
    response = await fetch(getLibreTranslateUrl('languages', baseUrl), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `No se pudo conectar con LibreTranslate en ${baseUrl}. Inicia el servicio local y vuelve a intentar: ${error.message}`
    );
  }
  if (!response.ok) {
    throw new Error(`LibreTranslate rechazó la comprobación de idiomas: HTTP ${response.status}`);
  }
  const languages = await response.json();
  if (!Array.isArray(languages)) {
    throw new Error('LibreTranslate devolvió una lista de idiomas inválida');
  }
  const availableLanguages = new Map(languages.map(language => [language?.code, language]));
  const missingLanguages = REQUIRED_SOURCE_LANGUAGES.filter(language => (
    !availableLanguages.get(language)?.targets?.includes(targetLanguage)
  ));
  if (missingLanguages.length) {
    throw new Error(
      `LibreTranslate no tiene modelos hacia ${targetLanguage} para: ${missingLanguages.join(', ')}`
    );
  }
}

async function requestTranslation(text, source, { baseUrl, apiKey, targetLanguage }) {
  const url = getLibreTranslateUrl('translate', baseUrl);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const body = { q: text, source, target: targetLanguage, format: 'text' };
      if (apiKey) body.api_key = apiKey;
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(1000 * (attempt + 1));
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`LibreTranslate devolvió una respuesta JSON inválida (HTTP ${response.status})`);
      }
      if (!response.ok) {
        const message = typeof payload?.error === 'string'
          ? payload.error
          : payload?.error?.message || `HTTP ${response.status}`;
        throw new Error(`LibreTranslate rechazó la solicitud: ${message}`);
      }
      return payload;
    } catch (error) {
      if (attempt < MAX_RETRIES && (error.name === 'AbortError' || error instanceof TypeError)) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('LibreTranslate agotó los reintentos');
}

async function translateOne(text, settings) {
  const { sourceHint, targetLanguage } = settings;
  const payload = await requestTranslation(text, 'auto', settings);
  const detectedLanguage = payload?.detectedLanguage;
  const confidence = Number(detectedLanguage?.confidence);
  if (
    detectedLanguage?.language === targetLanguage
    && Number.isFinite(confidence)
    && confidence >= MIN_AUTO_DETECTION_CONFIDENCE
  ) {
    return text;
  }
  if (sourceHint && Number.isFinite(confidence) && confidence < MIN_AUTO_DETECTION_CONFIDENCE) {
    if (sourceHint === targetLanguage) return text;
    const hintedPayload = await requestTranslation(text, sourceHint, settings);
    if (typeof hintedPayload?.translatedText !== 'string') {
      throw new Error('LibreTranslate devolvió un texto de traducción inválido');
    }
    return hintedPayload.translatedText;
  }
  if (typeof payload?.translatedText !== 'string') {
    throw new Error('LibreTranslate devolvió un texto de traducción inválido');
  }
  return payload.translatedText;
}

async function translateTexts(texts, options = {}, sourceHints = []) {
  const settings = {
    baseUrl: options.baseUrl || process.env.LIBRETRANSLATE_URL || DEFAULT_LIBRETRANSLATE_URL,
    apiKey: options.apiKey || process.env.LIBRETRANSLATE_API_KEY,
    targetLanguage: options.targetLanguage || DEFAULT_TARGET_LANGUAGE,
  };
  const translations = new Array(texts.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(TRANSLATION_CONCURRENCY, texts.length) },
    async () => {
      while (nextIndex < texts.length) {
        const index = nextIndex;
        nextIndex += 1;
        translations[index] = await translateOne(texts[index], {
          ...settings,
          sourceHint: sourceHints[index],
        });
      }
    }
  );
  await Promise.all(workers);
  return translations;
}

async function loadRows(collection, targetLanguage) {
  const values = [targetLanguage];
  let condition = '';
  if (collection) {
    values.push(collection);
    condition = 'WHERE c.slug = $2';
  }
  const { rows } = await db.query(`
    SELECT o.id, o.titulo, o.descripcion, o.tipo_objeto, o.material_tecnica,
           c.slug AS collection_slug,
           o.otras_denominaciones, t.source_hash AS translated_source_hash
    FROM objetos o
    LEFT JOIN colecciones c ON c.id = o.coleccion_id
    LEFT JOIN objeto_traducciones t
      ON t.objeto_id = o.id AND t.idioma = $1
    ${condition}
    ORDER BY o.id
  `, values);
  return rows;
}

async function loadCollectionRows(collection, targetLanguage) {
  const values = [targetLanguage];
  let condition = '';
  if (collection) {
    values.push(collection);
    condition = 'WHERE c.slug = $2';
  }
  const { rows } = await db.query(`
    SELECT c.id, c.slug AS collection_slug, c.nombre,
           t.source_hash AS translated_source_hash
    FROM colecciones c
    LEFT JOIN coleccion_traducciones t
      ON t.coleccion_id = c.id AND t.idioma = $1
    ${condition}
    ORDER BY c.id
  `, values);
  return rows;
}

async function translateJobBatch(jobs, options) {
  const byId = new Map(jobs.map(job => [`${job.entityType}:${job.id}`, job]));
  const segments = jobs.flatMap(job => Object.entries(job.fields)
    .map(([field, text]) => ({
      entityType: job.entityType,
      id: job.id,
      collectionSlug: job.collectionSlug,
      field,
      text,
    })));

  for (const segmentBatch of chunkSegments(segments)) {
    const translations = await translateTexts(
      segmentBatch.map(segment => segment.text),
      options,
      segmentBatch.map(segment => sourceLanguageHint(
        segment.collectionSlug,
        segment.field,
        segment.entityType
      ))
    );
    segmentBatch.forEach((segment, index) => {
      byId.get(`${segment.entityType}:${segment.id}`).translatedFields[segment.field] = translations[index];
    });
  }
}

async function saveJobs(jobs, targetLanguage) {
  if (!jobs.length) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const job of jobs) {
      if (job.entityType === 'coleccion') {
        await client.query(`
          INSERT INTO coleccion_traducciones
            (coleccion_id, idioma, nombre, source_hash, proveedor, estado, actualizado_en)
          VALUES ($1, $2, $3, $4, $5, 'automatica', now())
          ON CONFLICT (coleccion_id, idioma) DO UPDATE SET
          nombre = EXCLUDED.nombre,
          source_hash = EXCLUDED.source_hash,
          proveedor = EXCLUDED.proveedor,
          estado = 'automatica',
          actualizado_en = now()
          WHERE coleccion_traducciones.estado <> 'revisada'
        `, [
          job.id,
          targetLanguage,
          job.translatedFields.nombre,
          job.sourceHash,
          PROVIDER,
        ]);
      } else {
        await client.query(`
          INSERT INTO objeto_traducciones
            (objeto_id, idioma, campos, source_hash, proveedor, estado, actualizado_en)
          VALUES ($1, $2, $3::jsonb, $4, $5, 'automatica', now())
          ON CONFLICT (objeto_id, idioma) DO UPDATE SET
            campos = EXCLUDED.campos,
            source_hash = EXCLUDED.source_hash,
            proveedor = EXCLUDED.proveedor,
            estado = 'automatica',
            actualizado_en = now()
            WHERE objeto_traducciones.estado <> 'revisada'
        `, [
          job.id,
          targetLanguage,
          JSON.stringify(job.translatedFields),
          job.sourceHash,
          PROVIDER,
        ]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function run(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      'Uso: npm run translate-objects -- [--target en|es] [--dry-run] [--limit N] [--collection SLUG]'
    );
    return;
  }

  const [rows, collectionRows] = await Promise.all([
    loadRows(args.collection, args.target),
    loadCollectionRows(args.collection, args.target),
  ]);
  const objectJobs = rows
    .map(row => createTranslationJob(row, 'objeto'))
    .filter(job => job.sourceHash !== job.previousSourceHash)
    .filter(job => Object.keys(job.fields).length > 0);
  const collectionJobs = collectionRows
    .map(row => createTranslationJob(row, 'coleccion'))
    .filter(job => job.sourceHash !== job.previousSourceHash)
    .filter(job => Object.keys(job.fields).length > 0);
  const allJobs = [...objectJobs, ...collectionJobs];
  const jobs = allJobs.slice(0, args.limit || allJobs.length);
  const unchanged = rows.length + collectionRows.length - allJobs.length;
  const fields = jobs.reduce((sum, job) => sum + Object.keys(job.fields).length, 0);
  const chars = jobs.reduce((sum, job) => sum
    + Object.values(job.fields).reduce((length, value) => length + value.length, 0), 0);

  console.log(`Obras consultadas: ${rows.length}; colecciones consultadas: ${collectionRows.length}`);
  console.log(`Traducciones nuevas o desactualizadas hacia ${args.target}: ${jobs.length}`);
  console.log(`Campos de texto: ${fields}; caracteres aproximados: ${chars}`);
  console.log(`Sin cambios: ${unchanged}`);
  jobs.slice(0, 5).forEach(job => console.log(`  - ${job.entityType} ${job.id}: ${job.title}`));

  if (args.dryRun || jobs.length === 0) {
    if (args.dryRun) console.log('Dry-run: no se llamó a LibreTranslate ni se modificó la base.');
    return;
  }

  const baseUrl = process.env.LIBRETRANSLATE_URL || DEFAULT_LIBRETRANSLATE_URL;
  await checkLibreTranslate(baseUrl, args.target);
  const options = {
    baseUrl,
    apiKey: process.env.LIBRETRANSLATE_API_KEY,
    targetLanguage: args.target,
  };

  let translatedCount = 0;
  for (let index = 0; index < jobs.length; index += OBJECT_BATCH_SIZE) {
    const batch = jobs.slice(index, index + OBJECT_BATCH_SIZE);
    await translateJobBatch(batch, options);
    await saveJobs(batch, args.target);
    translatedCount += batch.length;
    console.log(`Traducidas y guardadas: ${translatedCount}/${jobs.length}`);
  }
}

if (require.main === module) {
  run()
    .catch(error => {
      console.error(`\n💥 Error de traducción: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}

module.exports = {
  SOURCE_FIELDS,
  checkLibreTranslate,
  chunkSegments,
  createTranslationJob,
  hashSourceFields,
  parseArgs,
  run,
  translateTexts,
};

