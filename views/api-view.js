// views/api-view.js
const pool = require('../config/db');
const { getCountryFromRegion, getCoordinatesForRegion } = require('../lib/geography');

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
  const coordinates = (f.lat != null && f.lon != null)
    ? [Number(f.lon), Number(f.lat)]
    : getCoordinatesForRegion(f.lugar_origen, f.estilo_cultura);
  return {
    id: f.id,
    coleccion_id: f.coleccion_id,
    titulo: f.titulo || 'Sin título',
    wikiTitle: f.numero_inventario || '',
    url: f.imagen_url,                  // URL Wikimedia original (respaldo)
    localImage: f.imagen_local || null, // Ruta local: /images/2025.385.jpg
    thumbnail: f.thumbnail_local || f.thumb_url || null, // Thumbnail local o de Commons (800px)
    year: parsedYear,
    yearRaw: f.fecha,
    region: f.lugar_origen ? (country && country !== 'Desconocido' ? `${f.lugar_origen}, ${country}` : f.lugar_origen) : (country || 'Desconocido'),
    descripcion: `Cultura: ${f.estilo_cultura || 'Desconocida'}. Material/Técnica: ${f.material_tecnica || 'N/A'}. Dimensiones: ${f.dimensiones || 'N/A'}. Inventario: ${f.numero_inventario || 'N/A'}. Autor: ${f.autor || 'Desconocido'}`,
    coordinates,
    
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
exports.obtenerColecciones = async (req, res) => {
  try {
    const query = `
      SELECT c.id, c.nombre, c.slug, COUNT(o.id)::int AS total
      FROM colecciones c
      LEFT JOIN objetos o ON o.coleccion_id = c.id
      GROUP BY c.id
      ORDER BY c.id
    `;
    const { rows } = await pool.query(query);
    res.json(rows.map(({ id, nombre, slug, total }) => ({ id, nombre, slug, total })));
  } catch (e) {
    console.error('Error al obtener las colecciones:', e);
    res.status(500).json({ message: 'Error al obtener las colecciones desde SQL' });
  }
};

exports.obtenerTodos = async (req, res) => {
  try {
    const hasCollectionId = Object.prototype.hasOwnProperty.call(req.query, 'coleccion_id');
    let collectionId;
    if (hasCollectionId) {
      const value = req.query.coleccion_id;
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        return res.status(400).json({ message: 'coleccion_id inválido' });
      }
      collectionId = Number(value);
    }

    const query = `
      SELECT id, coleccion_id, url_objeto, titulo, autor, lugar_origen, estilo_cultura, fecha,
             tipo_objeto, material_tecnica, numero_inventario, dimensiones, creditos, 
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local, thumb_url, lat, lon
      FROM objetos${hasCollectionId ? ' WHERE coleccion_id = $1' : ''}
    `;
    const { rows: filas } = hasCollectionId
      ? await pool.query(query, [collectionId])
      : await pool.query(query);

    const archivos = filas.map(mapRowToObject);

    res.json({ 
      categoria: "Anne-Marie und Caspar Reinhart Collection at Museum Rietberg, Zürich", 
      total: archivos.length, 
      archivos 
    });
  } catch (e) {
    console.error('Error en la consulta SQL:', e);
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
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local, thumb_url, lat, lon
      FROM objetos
    `;
    const { rows: filas } = await pool.query(query);

    const filtrados = filas.filter(f => {
      const parsedYear = CAST_YEAR_NATIVO(f.fecha);
      return parsedYear !== null && parsedYear >= year && parsedYear <= sigloFin;
    });

    const archivos = filtrados.map(mapRowToObject);

    res.json({ year, total: archivos.length, archivos });
  } catch (e) {
    console.error('Error en la consulta SQL:', e);
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
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local, thumb_url, lat, lon
      FROM objetos
    `;
    const { rows: filas } = await pool.query(query);

    const filtrados = filas.filter(f => {
      return CAST_YEAR_NATIVO(f.fecha) === null;
    });

    const archivos = filtrados.map(mapRowToObject);

    res.json({ total: archivos.length, archivos });
  } catch (e) {
    console.error('Error en la consulta SQL:', e);
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
             otras_denominaciones, imagen_url, imagen_local, thumbnail_local, thumb_url, lat, lon
      FROM objetos
      WHERE LOWER(COALESCE(titulo, '')) LIKE LOWER($1)
         OR LOWER(COALESCE(lugar_origen, '')) LIKE LOWER($2)
         OR LOWER(COALESCE(estilo_cultura, '')) LIKE LOWER($3)
         OR LOWER(COALESCE(material_tecnica, '')) LIKE LOWER($4)
    `;
    const patronBusqueda = `%${q}%`;
    const { rows: filas } = await pool.query(query, [patronBusqueda, patronBusqueda, patronBusqueda, patronBusqueda]);

    const archivos = filas.map(mapRowToObject);

    res.json({ query: q, total: archivos.length, archivos });
  } catch (e) {
    console.error('Error en la consulta SQL:', e);
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

    const query = `SELECT imagen_url, imagen_local, thumbnail_local FROM objetos WHERE numero_inventario = $1 OR titulo = $2 LIMIT 1`;
    const { rows: filas } = await pool.query(query, [title, title]);

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
    console.error('Error en la consulta SQL:', e);
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
    const { rows: filas } = await pool.query(query);

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
    console.error('Error en la consulta SQL:', e);
    res.status(500).json({ message: 'Error al verificar URLs' });
  }
};

// ------------------------------------------------------------
// 7. REGIONES
// ------------------------------------------------------------
exports.regions = async (req, res) => {
  try {
    const query = `SELECT DISTINCT lugar_origen FROM objetos WHERE lugar_origen IS NOT NULL AND lugar_origen != 'NULL'`;
    const { rows: filas } = await pool.query(query);
    const listaRegiones = filas.map(f => f.lugar_origen);
    
    res.json({ regions: listaRegiones });
  } catch (e) {
    console.error('Error en la consulta SQL:', e);
    res.status(500).json({ message: 'Error al obtener las regiones' });
  }
};

// Función auxiliar para parsear años
function CAST_YEAR_NATIVO(fechaStr) {
  if (!fechaStr) return null;
  const cleanStr = fechaStr.trim().toLowerCase();
  if (cleanStr === '' || cleanStr === 'null' || cleanStr === 'undefined' || cleanStr.includes('sin fecha') || cleanStr === 's/f' || cleanStr === 's/n') {
    return null;
  }

  const isBC = /a\.\s*c\.|a\.c\.|antes|b\.c\.|bc/i.test(fechaStr);
  const isAD = /d\.\s*c\.|d\.c\.|después|a\.d\.|ad/i.test(fechaStr);

  if (isBC && !isAD && !cleanStr.includes('0-') && !cleanStr.includes('0–')) {
    return null;
  }

  const romanMap = {
    'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10,
    'xi': 11, 'xii': 12, 'xiii': 13, 'xiv': 14, 'xv': 15, 'xvi': 16, 'xvii': 17, 'xviii': 18, 'xix': 19, 'xx': 20
  };
  
  const romanRegex = /siglos?\s+([ixv]+)(?:\s*(?:-|\/|al?|y)\s*([ixv]+))?/i;
  const romanMatch = fechaStr.match(romanRegex);
  if (romanMatch) {
    const startCentury = romanMap[romanMatch[1].toLowerCase()];
    const endCentury = romanMatch[2] ? romanMap[romanMatch[2].toLowerCase()] : startCentury;
    if (startCentury) {
      return Math.round((startCentury + endCentury) / 2) * 100 - 50; 
    }
  }

  const jhRegex = /(\d+)\.(?:-(\d+)\.)?\s*jh/i;
  const jhMatch = fechaStr.match(jhRegex);
  if (jhMatch) {
    const startCentury = parseInt(jhMatch[1]);
    const endCentury = jhMatch[2] ? parseInt(jhMatch[2]) : startCentury;
    return Math.round((startCentury + endCentury) / 2) * 100 - 50;
  }

  const matches = fechaStr.match(/\d{3,4}/g);
  if (matches && matches.length > 0) {
    let year;
    if (matches.length >= 2) {
      if (isBC && isAD) {
        year = parseInt(matches[matches.length - 1]);
      } else {
        year = Math.round((parseInt(matches[0]) + parseInt(matches[matches.length - 1])) / 2);
      }
    } else {
      year = parseInt(matches[0]);
    }

    if (year > 2026) return null;
    return year;
  }
  
  return null;
}
