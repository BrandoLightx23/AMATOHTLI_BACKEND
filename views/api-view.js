// views/api-view.js
const db = require('../config/db');

// ─── URL helpers & caché ──────────────────────────────────────────────────────

// Caché en memoria: url_raw → { resolvedUrl, ts }
// Evita repetir peticiones fallidas o exitosas recientes.
const IMAGE_CACHE = new Map();
const CACHE_TTL_OK  = 24 * 60 * 60 * 1000; // 24h para URLs exitosas
const CACHE_TTL_ERR = 10 * 60 * 1000;       // 10min para URLs que fallaron

/**
 * Normaliza una URL de Wikimedia eliminando doble encoding.
 * El frontend hace encodeURIComponent(url), y la url ya tiene %C3%BC,
 * resultando en %25C3%25BC. Esta función lo deshace correctamente.
 */
function normalizeWikimediaUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    // Decodificar el pathname completamente (puede tener 1 o 2 niveles de encoding)
    let decoded = url.pathname;
    // Decodificar hasta que no cambie (máx 3 pasadas)
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    // Re-encodificar correctamente segmento a segmento
    url.pathname = decoded
      .split('/')
      .map(seg => encodeURIComponent(seg))
      .join('/');
    return url.toString();
  } catch {
    return rawUrl.replace(/ /g, '%20');
  }
}

/** Extrae el nombre de archivo decodificado de una URL de Wikimedia. */
function getFilenameFromWikimediaUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname;
    let name = pathname.split('/').pop();
    // Decodificar hasta estabilizar
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(name);
      if (next === name) break;
      name = next;
    }
    return name; // e.g. "Museum-Rietberg-Zürich-Inv.Nr.-2025.1280-Objekt.jpg"
  } catch {
    return null;
  }
}

/**
 * Consulta la API de Wikimedia Commons para obtener la URL real de un archivo.
 * Útil cuando la URL directa falla (hash incorrecto en la BD).
 */
async function queryCommonsApiUrl(filename) {
  if (!filename) return null;
  const apiUrl = 'https://commons.wikimedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'query',
      format: 'json',
      prop: 'imageinfo',
      iiprop: 'url',
      titles: `File:${filename}`,
      origin: '*',
    });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const resp = await fetch(apiUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'MesoMapBot/2.0 (hackbam.mx)' },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    const pages = data?.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    // Si la página no existe, imageinfo estará vacío
    return page?.imageinfo?.[0]?.url || null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * fetch con soporte de retry automático cuando Wikimedia devuelve 429.
 * Respeta el header Retry-After (máx 30s de espera).
 */
async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 20_000);
    try {
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '5', 10);
        const waitMs = Math.min(retryAfter * 1000, 30_000);
        console.warn(`[proxy] 429 rate-limit, reintentando en ${waitMs}ms (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries && err.name !== 'AbortError') {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// Ruta base de prueba
exports.inicio = (req, res) => {
  res.json({ mensaje: 'API funcionando con Base de Datos SQL Real' });
};

// Helper para mapear una fila a objeto JSON consistente
function mapRowToObject(f) {
  const country = getCountryFromRegion(f.lugar_origen, f.estilo_cultura);
  const parsedYear = f.fecha ? CAST_YEAR_NATIVO(f.fecha) : null;
  return {
    id: f.id,
    titulo: f.titulo || 'Sin título',
    wikiTitle: f.numero_inventario || '',
    url: f.imagen_url,                  // URL Wikimedia original (respaldo)
    localImage: f.imagen_local || null, // Ruta local: /images/2025.385.jpg
    thumbnail: f.thumbnail_local || null, // Thumbnail: /images/thumbnails/2025.385.jpg
    year: parsedYear,
    yearRaw: f.fecha,
    region: f.lugar_origen ? `${f.lugar_origen}, ${country}` : country,
    descripcion: `Cultura: ${f.estilo_cultura || 'Desconocida'}. Material/Técnica: ${f.material_tecnica || 'N/A'}. Dimensiones: ${f.dimensiones || 'N/A'}. Inventario: ${f.numero_inventario || 'N/A'}. Autor: ${f.autor || 'Desconocido'}`,
    coordinates: getCoordinatesForRegion(f.lugar_origen, f.estilo_cultura),
    
    // Metadatos individuales unificados
    autor: f.autor || 'Desconocido',
    lugar_origen: f.lugar_origen || '',
    pais: country,
    estilo_cultura: f.estilo_cultura || 'Desconocida',
    fecha: f.fecha || '',
    tipo_objeto: f.tipo_objeto || '',
    material_tecnica: f.material_tecnica || 'N/A',
    numero_inventario: f.numero_inventario || 'N/A',
    dimensiones: f.dimensiones || 'N/A',
    creditos: f.creditos || ''
  };
}

// ------------------------------------------------------------
// 1. OBTENER TODOS
// ------------------------------------------------------------
exports.obtenerTodos = async (req, res) => {
  try {
    const query = `
      SELECT id, url_objeto, titulo, autor, lugar_origen, estilo_cultura, fecha, 
             tipo_objeto, material_tecnica, numero_inventario, dimensiones, creditos, 
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local
      FROM objetos
    `;
    const [filas] = await db.query(query);

    const archivos = filas.map(mapRowToObject);

    res.json({ 
      categoria: "Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich", 
      total: archivos.length, 
      archivos 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error al obtener los datos desde SQL' });
  }
};

// ------------------------------------------------------------
// 2. FILTRAR POR AÑO
// ------------------------------------------------------------
exports.obtenerPorAnio = async (req, res) => {
  try {
    const year = Number(req.params.year);
    if (isNaN(year)) return res.status(400).json({ message: 'Año inválido' });

    const sigloFin = year + 99;

    const query = `
      SELECT id, url_objeto, titulo, autor, lugar_origen, estilo_cultura, fecha, 
             tipo_objeto, material_tecnica, numero_inventario, dimensiones, creditos, 
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local
      FROM objetos
    `;
    const [filas] = await db.query(query);

    const filtrados = filas.filter(f => {
      const parsedYear = CAST_YEAR_NATIVO(f.fecha);
      return parsedYear !== null && parsedYear >= year && parsedYear <= sigloFin;
    });

    const archivos = filtrados.map(mapRowToObject);

    res.json({ year, total: archivos.length, archivos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error al filtrar por año en SQL' });
  }
};

// ------------------------------------------------------------
// 3. OBTENER DESCONOCIDOS
// ------------------------------------------------------------
exports.obtenerDesconocidos = async (req, res) => {
  try {
    const query = `
      SELECT id, url_objeto, titulo, autor, lugar_origen, estilo_cultura, fecha, 
             tipo_objeto, material_tecnica, numero_inventario, dimensiones, creditos, 
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local
      FROM objetos
    `;
    const [filas] = await db.query(query);

    const filtrados = filas.filter(f => {
      return CAST_YEAR_NATIVO(f.fecha) === null;
    });

    const archivos = filtrados.map(mapRowToObject);

    res.json({ total: archivos.length, archivos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error al obtener desconocidos desde SQL' });
  }
};

// ------------------------------------------------------------
// 4. BUSCADOR
// ------------------------------------------------------------
exports.buscar = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ total: 0, archivos: [] });

    const query = `
      SELECT id, url_objeto, titulo, autor, lugar_origen, estilo_cultura, fecha, 
             tipo_objeto, material_tecnica, numero_inventario, dimensiones, creditos, 
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local
      FROM objetos
      WHERE LOWER(IFNULL(titulo, '')) LIKE LOWER(?) 
         OR LOWER(IFNULL(lugar_origen, '')) LIKE LOWER(?) 
         OR LOWER(IFNULL(estilo_cultura, '')) LIKE LOWER(?)
         OR LOWER(IFNULL(material_tecnica, '')) LIKE LOWER(?)
    `;
    const patronBusqueda = `%${q}%`;
    const [filas] = await db.query(query, [patronBusqueda, patronBusqueda, patronBusqueda, patronBusqueda]);

    const archivos = filas.map(mapRowToObject);

    res.json({ query: q, total: archivos.length, archivos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error en el motor de búsqueda SQL' });
  }
};

// ------------------------------------------------------------
// 5. WIKI INDIVIDUAL
// ------------------------------------------------------------
exports.wiki = async (req, res) => {
  try {
    const title = req.params.title;
    if (!title) return res.status(400).json({ message: 'Se requiere identificador/inventario' });

    const query = `SELECT imagen_url, imagen_local, thumbnail_local FROM objetos WHERE numero_inventario = ? OR titulo = ? LIMIT 1`;
    const [filas] = await db.query(query, [title, title]);

    if (filas.length > 0) {
      const f = filas[0];
      return res.json({
        url: f.imagen_url,
        image: f.imagen_local || f.imagen_url,  // Prefiere ruta local
        localImage: f.imagen_local || null,
        thumbnail: f.thumbnail_local || null,
      });
    }

    res.status(404).json({ message: 'Imagen no encontrada con el inventario provisto' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error al obtener la imagen' });
  }
};

// SVG placeholder reutilizable
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#f0ece2"/>
  <rect x="150" y="90" width="100" height="80" rx="8" fill="#d9d0bc" opacity="0.6"/>
  <circle cx="175" cy="115" r="12" fill="#a09080" opacity="0.5"/>
  <polygon points="150,170 200,120 250,170" fill="#a09080" opacity="0.4"/>
  <text x="200" y="215" text-anchor="middle" font-family="serif" font-size="13" fill="#7a6e5f">Imagen no disponible</text>
  <text x="200" y="235" text-anchor="middle" font-family="serif" font-size="10" fill="#a09080">Museo Rietberg</text>
</svg>`;

function sendPlaceholder(res) {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Image-Source', 'placeholder');
  return res.send(PLACEHOLDER_SVG);
}

// ------------------------------------------------------------
// 6. PROXY DE IMÁGENES — robusto con caché, Commons API y retry
// ------------------------------------------------------------
exports.imageProxy = async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ message: 'URL requerida' });

  // ── 1. Revisar caché ────────────────────────────────────────
  const cacheKey = rawUrl;
  const cached = IMAGE_CACHE.get(cacheKey);
  if (cached) {
    const age = Date.now() - cached.ts;
    const ttl = cached.ok ? CACHE_TTL_OK : CACHE_TTL_ERR;
    if (age < ttl) {
      if (!cached.ok) return sendPlaceholder(res);
      // URL exitosa en caché: hacer fetch directo a la URL resuelta
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20_000);
        const resp = await fetch(cached.resolvedUrl, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; MesoMapBot/2.0; hackbam.mx)',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Referer': 'https://commons.wikimedia.org/',
          },
        });
        clearTimeout(timer);
        if (resp.ok) {
          res.setHeader('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.setHeader('X-Image-Source', cached.resolvedUrl);
          const buffer = await resp.arrayBuffer();
          return res.send(Buffer.from(buffer));
        }
        // URL resuelta ya no funciona → eliminar del caché y continuar
        IMAGE_CACHE.delete(cacheKey);
      } catch {
        IMAGE_CACHE.delete(cacheKey);
      }
    }
  }

  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; MesoMapBot/2.0; hackbam.mx)',
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
    'Referer': 'https://commons.wikimedia.org/',
  };

  // ── 2. Construir candidatos ──────────────────────────────────
  // Candidato 1: URL normalizada (corrige doble encoding)
  const normalizedUrl = normalizeWikimediaUrl(rawUrl);

  // Función para intentar una URL y devolver la respuesta o null
  async function tryFetch(url) {
    if (!url) return null;
    try {
      const resp = await fetchWithRetry(url, { ...fetchHeaders, timeoutMs: 20_000 });
      if (resp.ok) return resp;
      console.warn(`[proxy] ${resp.status} → ${url.slice(0, 90)}`);
      return null;
    } catch (err) {
      console.warn(`[proxy] err → ${url.slice(0, 90)}: ${err.message}`);
      return null;
    }
  }

  // ── 3. Intentar URL normalizada ──────────────────────────────
  let goodResp = await tryFetch(normalizedUrl);
  let resolvedUrl = normalizedUrl;

  // ── 4. Fallback: API de Commons (busca por nombre de archivo) ─
  if (!goodResp) {
    const filename = getFilenameFromWikimediaUrl(rawUrl);
    if (filename) {
      const commonsUrl = await queryCommonsApiUrl(filename);
      if (commonsUrl && commonsUrl !== normalizedUrl) {
        goodResp = await tryFetch(commonsUrl);
        resolvedUrl = commonsUrl;
      }
    }
  }

  // ── 5. Responder con la imagen ───────────────────────────────
  if (goodResp) {
    IMAGE_CACHE.set(cacheKey, { ok: true, resolvedUrl, ts: Date.now() });
    const contentType = goodResp.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Image-Source', resolvedUrl);
    const buffer = await goodResp.arrayBuffer();
    return res.send(Buffer.from(buffer));
  }

  // ── 6. Todos fallaron → placeholder ──────────────────────────
  IMAGE_CACHE.set(cacheKey, { ok: false, resolvedUrl: null, ts: Date.now() });
  return sendPlaceholder(res);
};

// ------------------------------------------------------------
// 6b. VERIFICACIÓN EN BATCH DE URLs (para reporte de salud)
// ------------------------------------------------------------
exports.checkUrls = async (req, res) => {
  try {
    const query = `SELECT id, titulo, imagen_url FROM objetos WHERE imagen_url IS NOT NULL LIMIT 681`;
    const [filas] = await db.query(query);

    const TIMEOUT_MS = 10_000;
    const CONCURRENCY = 15;
    const results = [];
    let idx = 0;

    async function worker() {
      while (idx < filas.length) {
        const fila = filas[idx++];
        const normalizedUrl = normalizeWikimediaUrl(fila.imagen_url);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const resp = await fetch(normalizedUrl, {
            method: 'HEAD',
            signal: controller.signal,
            headers: { 'User-Agent': 'MesoMapBot/2.0', 'Referer': 'https://commons.wikimedia.org/' },
          });
          clearTimeout(timer);
          results.push({ id: fila.id, titulo: fila.titulo, url: fila.imagen_url, status: resp.status, ok: resp.ok });
        } catch (err) {
          clearTimeout(timer);
          const isTimeout = err.name === 'AbortError';
          results.push({ id: fila.id, titulo: fila.titulo, url: fila.imagen_url, status: isTimeout ? 'TIMEOUT' : 'ERROR', ok: false, error: err.message });
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const valid = results.filter(r => r.ok);
    const invalid = results.filter(r => !r.ok);
    res.json({
      generated: new Date().toISOString(),
      total: results.length,
      valid: valid.length,
      invalid: invalid.length,
      valid_urls: valid,
      invalid_urls: invalid,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error al verificar URLs' });
  }
};

// ------------------------------------------------------------
// 7. REGIONES
// ------------------------------------------------------------
exports.regions = async (req, res) => {
  try {
    const query = `SELECT DISTINCT lugar_origen FROM objetos WHERE lugar_origen IS NOT NULL AND lugar_origen != 'NULL'`;
    const [filas] = await db.query(query);
    const listaRegiones = filas.map(f => f.lugar_origen);
    
    res.json({ regions: listaRegiones });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error al obtener las regiones' });
  }
};

// Función auxiliar para parsear años
function CAST_YEAR_NATIVO(fechaStr) {
  if (!fechaStr) return null;
  const cleanStr = fechaStr.trim().toLowerCase();
  if (cleanStr === '' || cleanStr === 'null' || cleanStr === 'undefined' || cleanStr === 'sin fecha' || cleanStr === 's/f' || cleanStr === 's/n') {
    return null;
  }

  // Detectar si es antes de Cristo (a.C.)
  const isBC = /a\.\s*c\.|a\.c\.|antes|b\.c\.|bc/i.test(fechaStr);

  const matches = fechaStr.match(/\d{3,4}/g);
  if (matches && matches.length > 0) {
    let year;
    if (matches.length >= 2) {
      year = Math.round((parseInt(matches[0]) + parseInt(matches[matches.length - 1])) / 2);
    } else {
      year = parseInt(matches[0]);
    }

    // Si es a.C. o es del futuro (ej. 3000), devolvemos null para agruparlo en desconocido
    if (isBC || year > 2026) {
      return null;
    }
    return year;
  }
  return null;
}

function getCountryFromRegion(region, estiloCultura) {
  if (!region) return "Peru";
  const reg = region.toLowerCase();
  const cult = (estiloCultura || "").toLowerCase();

  if (reg.includes("perú") || reg.includes("peru") || reg.includes("chancay") || cult.includes("chancay") || cult.includes("inca") || cult.includes("chimú") || cult.includes("moche") || cult.includes("nazca") || cult.includes("paracas") || cult.includes("chavín") || cult.includes("sican") || cult.includes("sicán") || cult.includes("vicús") || cult.includes("vicus") || cult.includes("cupisnique") || cult.includes("huari") || cult.includes("tiwanaku") || cult.includes("ica")) {
    return "Peru";
  }
  if (reg.includes("ecuador") || reg.includes("valdivia") || cult.includes("valdivia") || cult.includes("bahía") || cult.includes("bahia") || cult.includes("chorrera") || cult.includes("guangala") || cult.includes("jama-coaque") || cult.includes("machalilla") || cult.includes("manteña") || cult.includes("mantena") || cult.includes("tuncahuán") || cult.includes("tuncahuan")) {
    return "Ecuador";
  }
  if (reg.includes("colombia") || cult.includes("quimbaya") || cult.includes("tairona") || cult.includes("nariño") || cult.includes("narino") || cult.includes("tumaco")) {
    return "Colombia";
  }
  if (reg.includes("bolivia")) {
    return "Bolivia";
  }
  if (reg.includes("brasil") || reg.includes("brazil")) {
    return "Brazil";
  }
  if (reg.includes("costa rica") || reg.includes("guanacaste") || reg.includes("vertiente atlántica") || reg.includes("vertiente atlantica")) {
    return "Costa Rica";
  }
  if (reg.includes("guatemala") || reg.includes("maya")) {
    return "Guatemala";
  }
  if (reg.includes("méxico") || reg.includes("mexico") || reg.includes("colima") || reg.includes("guerrero") || reg.includes("jalisco") || reg.includes("michoacán") || reg.includes("michoacan") || reg.includes("oaxaca") || reg.includes("veracruz") || reg.includes("guanajuato") || reg.includes("tlatilco") || reg.includes("chupícuaro") || reg.includes("chupicuaro") || reg.includes("teotihuacán") || reg.includes("teotihuacan") || reg.includes("olmeca") || reg.includes("tarasca") || cult.includes("azteca") || cult.includes("mezcala") || cult.includes("chontal") || cult.includes("nayarit")) {
    return "Mexico";
  }

  // Fallback checks
  if (reg.includes("peru") || reg.includes("perú")) return "Peru";
  if (reg.includes("colombia")) return "Colombia";
  if (reg.includes("ecuador")) return "Ecuador";
  if (reg.includes("bolivia")) return "Bolivia";
  if (reg.includes("brazil") || reg.includes("brasil")) return "Brazil";
  if (reg.includes("costa rica")) return "Costa Rica";
  if (reg.includes("guatemala")) return "Guatemala";
  if (reg.includes("honduras")) return "Honduras";
  if (reg.includes("belize") || reg.includes("belice")) return "Belize";
  if (reg.includes("el salvador")) return "El Salvador";
  if (reg.includes("nicaragua")) return "Nicaragua";
  if (reg.includes("panama") || reg.includes("panamá")) return "Panama";

  return "Peru";
}

function getCoordinatesForRegion(region, estiloCultura) {
  const country = getCountryFromRegion(region, estiloCultura);
  switch (country) {
    case "Peru": return [-75.0152, -9.1900];
    case "Colombia": return [-74.2973, 4.5709];
    case "Ecuador": return [-78.1834, -1.8312];
    case "Bolivia": return [-63.5887, -16.2902];
    case "Brazil": return [-51.9253, -14.2350];
    case "Costa Rica": return [-83.7534, 9.7489];
    case "Guatemala": return [-90.2308, 15.7835];
    case "Belize": return [-88.4976, 17.1899];
    case "Honduras": return [-86.2419, 15.1999];
    case "El Salvador": return [-88.8965, 13.7942];
    case "Nicaragua": return [-85.2072, 12.8654];
    case "Panama": return [-80.7821, 8.5380];
    case "Mexico":
    default:
      return [-102.5528, 23.6345];
  }
}