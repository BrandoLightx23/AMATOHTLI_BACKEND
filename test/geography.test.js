'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getCoordinatesForRegion,
  getCountryFromRegion,
} = require('../lib/geography');

test('Calima maps to Colombia rather than Mexico', () => {
  assert.equal(getCountryFromRegion(null, 'Calima'), 'Colombia');
  assert.deepEqual(getCoordinatesForRegion(null, 'Cultura Calima'), [-74.2973, 4.5709]);
});

test('an explicit country in the origin takes precedence over culture labels', () => {
  assert.equal(getCountryFromRegion('Calima, Colombia', 'Azteca'), 'Colombia');
});

test('existing exact culture and place mappings remain available', () => {
  assert.equal(getCountryFromRegion(null, 'Cultura Inca'), 'Peru');
  assert.equal(getCountryFromRegion(null, 'Azteca'), 'Mexico');
  assert.equal(getCountryFromRegion(null, 'Valdivia'), 'Ecuador');
  assert.equal(getCountryFromRegion('Lima, Perú', null), 'Peru');
});

test('culture matching uses complete labels rather than incidental substrings', () => {
  assert.equal(getCountryFromRegion(null, 'Calimán'), 'Desconocido');
  assert.equal(getCountryFromRegion(null, 'Unknown'), 'Desconocido');
});
