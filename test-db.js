const db = require('./config/db');

async function test() {
  try {
    console.log("Testing connection...");
    const [rows] = await db.query("SELECT 1 + 1 AS result");
    console.log("Connection success! Result:", rows[0].result);
    
    console.log("Testing query on objetos table...");
    const [rows2] = await db.query("SELECT COUNT(*) AS count FROM objetos");
    console.log("Objects count:", rows2[0].count);
  } catch (err) {
    console.error("Database test failed:", err);
  } finally {
    process.exit();
  }
}

test();
