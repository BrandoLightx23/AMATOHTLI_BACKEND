'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  chunkSegments,
  createTranslationJob,
  hashSourceFields,
  parseArgs,
  translateTexts,
} = require('../scripts/translate-objects');

test('translation jobs include descriptive fields but exclude names and identifiers', () => {
  const job = createTranslationJob({
    id: 8,
    titulo: 'Vasija ceremonial',
    autor: 'Nombre propio',
    fecha: '900 d. C.',
    numero_inventario: 'INV-123',
    tipo_objeto: 'Vasija',
    material_tecnica: 'Cerámica',
  });

  assert.deepEqual(job.fields, {
    titulo: 'Vasija ceremonial',
    tipo_objeto: 'Vasija',
    material_tecnica: 'Cerámica',
  });
  assert.equal(job.previousSourceHash, undefined);
  assert.match(job.sourceHash, /^[a-f0-9]{64}$/);
});

test('source hash changes only when translatable source text changes', () => {
  const original = hashSourceFields({ titulo: 'Vasija', material_tecnica: 'Cerámica' });
  assert.equal(original, hashSourceFields({ titulo: 'Vasija', material_tecnica: 'Cerámica' }));
  assert.notEqual(original, hashSourceFields({ titulo: 'Vasija', material_tecnica: 'Oro' }));
});

test('translation batches respect text count and character bounds', () => {
  const segments = Array.from({ length: 70 }, (_, index) => ({
    id: index,
    field: 'titulo',
    text: `Pieza ${index}`,
  }));
  const chunks = chunkSegments(segments);

  assert.deepEqual(chunks.map(chunk => chunk.length), [64, 6]);
  assert.equal(chunks.flat().length, segments.length);
});

test('LibreTranslate receives local auto-detected requests and returns translated text', async t => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ translatedText: `English ${payload.q}` }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const translated = await translateTexts(['Cerámica', 'Vasija'], {
    baseUrl: `http://127.0.0.1:${address.port}`,
  });

  assert.deepEqual(translated, ['English Cerámica', 'English Vasija']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.source === 'auto'));
  assert.ok(requests.every(request => request.target === 'en'));
  assert.ok(requests.every(request => request.format === 'text'));
});

test('low-confidence auto-detection retries with the collection source-language hint', async t => {
  const sources = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      sources.push(payload.source);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload.source === 'auto'
        ? {
          detectedLanguage: { confidence: 0, language: 'en' },
          translatedText: payload.q,
        }
        : { translatedText: 'textile' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const translated = await translateTexts(['textil'], {
    baseUrl: `http://127.0.0.1:${address.port}`,
  }, ['es']);

  assert.deepEqual(translated, ['textile']);
  assert.deepEqual(sources, ['auto', 'es']);
});

test('Spanish target preserves Spanish source and translates English source', async t => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload.q === 'textil'
        ? {
          detectedLanguage: { confidence: 0, language: 'en' },
          translatedText: 'wrong translation',
        }
        : {
          detectedLanguage: { confidence: 100, language: 'en' },
          translatedText: 'escultura',
        }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const translated = await translateTexts(['textil', 'sculpture'], {
    baseUrl: `http://127.0.0.1:${address.port}`,
    targetLanguage: 'es',
  }, ['es', 'en']);

  assert.deepEqual(translated, ['textil', 'escultura']);
  assert.ok(requests.every(request => request.target === 'es'));
});

test('translation CLI validates limits and supports dry-run', () => {
  assert.deepEqual(parseArgs(['node', 'translate-objects.js', '--dry-run', '--limit', '10']), {
    dryRun: true,
    limit: 10,
    collection: null,
    target: 'en',
  });
  assert.equal(parseArgs(['node', 'translate-objects.js', '--target', 'es']).target, 'es');
  assert.throws(() => parseArgs(['node', 'translate-objects.js', '--limit', '0']), /entero positivo/);
  assert.throws(() => parseArgs(['node', 'translate-objects.js', '--target', 'de']), /--target debe ser uno de/);
});
