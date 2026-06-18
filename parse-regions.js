const fs = require('fs');

const sql = fs.readFileSync('/home/bran_marea23/Documentos/Hack_BAM/Karla/proyecto-brando-hackbam/museo_rietberg.sql', 'utf8');
const lines = sql.split('\n');

const regiones = new Set();
const culturas = new Set();
const fechas = new Set();

for (const line of lines) {
  if (line.includes("INSERT INTO objetos") || line.trim().startsWith("(")) {
    // We can extract parts of the SQL insert
    // Example: ('https://rietberg.ch/...', 'titulo', 'autor', 'lugar_origen', 'estilo_cultura', ...)
    // Let's split by simple comma, but taking care of quotes.
    // An easier way is just matching string values:
    const matches = line.match(/'([^']*)'/g);
    if (matches && matches.length >= 5) {
      const lugar = matches[3] ? matches[3].replace(/'/g, "") : "";
      const cultura = matches[4] ? matches[4].replace(/'/g, "") : "";
      const fecha = matches[5] ? matches[5].replace(/'/g, "") : "";
      if (lugar) regiones.add(lugar);
      if (cultura) culturas.add(cultura);
      if (fecha) fechas.add(fecha);
    }
  }
}

console.log("REGIONES UNIQUE VALUES:");
console.log(Array.from(regiones).sort());
console.log("\nCULTURAS UNIQUE VALUES:");
console.log(Array.from(culturas).sort());
console.log("\nFECHAS UNIQUE VALUES:");
console.log(Array.from(fechas).sort().slice(0, 50)); // first 50
