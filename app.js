const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Middleware para parsear JSON
app.use(express.json());
app.use(morgan('dev'));

// ── Servir imágenes locales ─────────────────────────────────────────────────
app.use('/images', express.static(path.join(__dirname, 'public', 'images'), {
  maxAge: '7d',
  immutable: true,
  etag: true,
  lastModified: true,
}));

// ── Rutas de la API ─────────────────────────────────────────────────────────
app.use('/api', require('./routes/api'));

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log(`Imágenes locales: http://localhost:${PORT}/images/`);
});