const express = require('express');
const router = express.Router();
const APIVIEW = require('../views/api-view');

router.get('/', APIVIEW.inicio);
router.get('/objects', APIVIEW.obtenerTodos);
router.get('/objects/anio/:year', APIVIEW.obtenerPorAnio);
router.get('/objects/desconocidos', APIVIEW.obtenerDesconocidos);
router.get('/objects/buscar', APIVIEW.buscar);
router.get('/wiki/:title', APIVIEW.wiki);
router.get('/proxy', APIVIEW.imageProxy);
router.get('/regions', APIVIEW.regions);
router.get('/check-urls', APIVIEW.checkUrls);

module.exports = router;