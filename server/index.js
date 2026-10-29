'use strict';
const path = require('path');
const { Pool } = require('pg');
const { createApp, migrate } = require('./app');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL, por ejemplo: postgres://caja:clave@localhost:5432/caja');
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 3000;
// Por defecto solo escucha en esta computadora. Para abrirlo a la red, HOST=0.0.0.0 (ver README).
const HOST = process.env.HOST || '127.0.0.1';

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10, ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined });
  await migrate(pool);
  const app = createApp({ pool, publicDir: path.join(__dirname, '..', 'public') });
  app.listen(PORT, HOST, () => console.log(`Caja lista en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
})().catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
