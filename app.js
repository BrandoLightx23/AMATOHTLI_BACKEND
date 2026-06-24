require('dotenv').config();
const express = require('express');
const morgan  = require('morgan');
const cors    = require('cors');
const path    = require('path');
const app     = express();
const port    = 3000;

app.use(cors());

// Middleware para parsear JSON
app.use(express.json());
app.use(morgan('dev'));

// ── Servir imágenes locales ─────────────────────────────────────────────────
// Las imágenes descargadas en public/images/ se sirven directamente.
// Nunca se contacta a Wikimedia durante la navegación.
app.use('/images', express.static(path.join(__dirname, 'public', 'images'), {
  maxAge: '7d',          // caché del navegador 7 días
  immutable: true,       // los archivos no cambian, caché agresivo
  etag: true,
  lastModified: true,
}));

// ── Rutas de la API ─────────────────────────────────────────────────────────
app.use('/api', require('./routes/api'));

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
  console.log(`Imágenes locales:   http://localhost:${port}/images/`);
});