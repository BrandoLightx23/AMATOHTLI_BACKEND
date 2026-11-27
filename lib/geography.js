'use strict';

const COUNTRY_NAMES = [
  ['Peru', ['peru']],
  ['Colombia', ['colombia']],
  ['Ecuador', ['ecuador']],
  ['Bolivia', ['bolivia']],
  ['Brazil', ['brazil', 'brasil']],
  ['Costa Rica', ['costa rica']],
  ['Guatemala', ['guatemala']],
  ['Honduras', ['honduras']],
  ['Belize', ['belize', 'belice']],
  ['El Salvador', ['el salvador']],
  ['Nicaragua', ['nicaragua']],
  ['Panama', ['panama']],
  ['Mexico', ['mexico']],
];

const REGION_COUNTRIES = [
  ['Peru', ['chancay', 'ica', 'inca', 'chimu', 'moche', 'nazca', 'paracas', 'chavin', 'sican', 'vicus', 'cupisnique', 'huari', 'tiwanaku']],
  ['Ecuador', ['valdivia', 'bahia', 'chorrera', 'guangala', 'jama coaque', 'machalilla', 'mantena', 'tuncahuan']],
  ['Colombia', ['calima', 'quimbaya', 'tairona', 'narino', 'tumaco']],
  ['Costa Rica', ['guanacaste', 'vertiente atlantica']],
  ['Guatemala', ['maya']],
  ['Mexico', ['colima', 'guerrero', 'jalisco', 'michoacan', 'oaxaca', 'veracruz', 'guanajuato', 'tlatilco', 'chupicuaro', 'teotihuacan', 'olmeca', 'tarasca']],
];

const CULTURE_COUNTRIES = new Map([
  ...['chancay', 'inca', 'chimu', 'moche', 'nazca', 'paracas', 'chavin', 'sican', 'vicus', 'cupisnique', 'huari', 'tiwanaku', 'ica', 'chimu inca']
    .map(culture => [culture, 'Peru']),
  ...['valdivia', 'bahia', 'chorrera', 'guangala', 'jama coaque', 'machalilla', 'mantena', 'tuncahuan']
    .map(culture => [culture, 'Ecuador']),
  ...['calima', 'quimbaya', 'tairona', 'narino', 'tumaco']
    .map(culture => [culture, 'Colombia']),
  ...['maya'].map(culture => [culture, 'Guatemala']),
  ...['azteca', 'mezcala', 'chontal', 'nayarit', 'olmeca', 'tarasca']
    .map(culture => [culture, 'Mexico']),
]);

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPhrase(text, phrase) {
  const normalizedPhrase = normalizeLabel(phrase);
  return Boolean(normalizedPhrase) && ` ${text} `.includes(` ${normalizedPhrase} `);
}

function normalizeCulture(value) {
  return normalizeLabel(value)
    .replace(/^(?:cultura|culture)\s+/, '')
    .replace(/\s+(?:cultura|culture)$/, '')
    .trim();
}

function getCountryFromRegion(region, estiloCultura) {
  const normalizedRegion = normalizeCulture(region);
  if (!normalizedRegion && !estiloCultura) return 'Desconocido';

  for (const [country, labels] of COUNTRY_NAMES) {
    if (labels.some(label => hasPhrase(normalizedRegion, label))) return country;
  }

  for (const [country, labels] of REGION_COUNTRIES) {
    if (labels.some(label => hasPhrase(normalizedRegion, label))) return country;
  }

  const cultures = String(estiloCultura || '').split(/[,;|]/);
  for (const culture of cultures) {
    const country = CULTURE_COUNTRIES.get(normalizeCulture(culture));
    if (country) return country;
  }

  return 'Desconocido';
}

function getCoordinatesForRegion(region, estiloCultura) {
  const country = getCountryFromRegion(region, estiloCultura);
  switch (country) {
    case 'Peru': return [-75.0152, -9.1900];
    case 'Colombia': return [-74.2973, 4.5709];
    case 'Ecuador': return [-78.1834, -1.8312];
    case 'Bolivia': return [-63.5887, -16.2902];
    case 'Brazil': return [-51.9253, -14.2350];
    case 'Costa Rica': return [-83.7534, 9.7489];
    case 'Guatemala': return [-90.2308, 15.7835];
    case 'Belize': return [-88.4976, 17.1899];
    case 'Honduras': return [-86.2419, 15.1999];
    case 'El Salvador': return [-88.8965, 13.7942];
    case 'Nicaragua': return [-85.2072, 12.8654];
    case 'Panama': return [-80.7821, 8.5380];
    case 'Mexico': return [-102.5528, 23.6345];
    default: return null;
  }
}

module.exports = { getCountryFromRegion, getCoordinatesForRegion };
