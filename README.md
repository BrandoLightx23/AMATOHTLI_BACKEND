# Museo_Rietberg
Proyecto de difusión de piezas del museo.

## Traducciones del catálogo

Las traducciones al inglés o español se guardan aparte de los textos originales en
`objeto_traducciones` y `coleccion_traducciones`. El frontend pide `idioma=en` o
`idioma=es`; si un campo no tiene traducción, la API conserva el valor fuente.

1. Ejecuta la migración en la base de datos configurada:

   ```sh
   npm run migrate-translations
   ```

2. Inicia LibreTranslate localmente con Docker:

   ```sh
   docker run --detach --name amatohtli-libretranslate \
     --publish 127.0.0.1:5000:5000 \
     libretranslate/libretranslate:latest --load-only en,es,de,it
   ```

   La primera ejecución puede descargar los modelos de idioma. Para iniciarlo
   después de detenerlo, usa `docker start amatohtli-libretranslate`. El servicio debe
   responder en `http://127.0.0.1:5000`. No se requiere una API key en una
   instancia local. Si usas otra dirección, configura `LIBRETRANSLATE_URL` en
   el entorno del backend; `LIBRETRANSLATE_API_KEY` solo es necesario si
   habilitaste claves en tu instancia.

3. Revisa cuántos registros necesitan traducción al español sin llamar al servicio:

   ```sh
   npm run translate-objects -- --target es --dry-run
   ```

4. Prueba primero con 20 registros y revisa el resultado; después traduce al
   español en lotes reanudables:

   ```sh
   npm run translate-objects -- --target es --limit 20
   npm run translate-objects -- --target es
   ```

   Usa `--target en` para el inglés o `--collection <slug>` para limitarlo a un
   acervo. El script evita reprocesar registros cuyo texto fuente no cambió.

El traductor procesa títulos, descripciones, tipos de objeto, materiales/técnicas,
otras denominaciones y nombres de colecciones. Conserva autores, fechas, inventarios,
dimensiones, procedencias y los demás datos originales.
