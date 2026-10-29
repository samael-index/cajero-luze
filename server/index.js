'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createApp, migrate } = require('./app');
const { createSync } = require('./sync');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL, por ejemplo: postgres://caja:clave@localhost:5432/caja');
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 3000;
// Por defecto solo escucha en esta computadora. Para abrirlo a la red, HOST=0.0.0.0 (ver README).
const HOST = process.env.HOST || '127.0.0.1';

/* Conexión a la nube (Supabase / Neon). El cifrado se verifica siempre, salvo que se pida lo contrario. */
function cloudPool(url) {
  const u = new URL(url);
  // pg le da prioridad al texto de conexión sobre las opciones: se quitan estos parámetros para decidir aquí
  for (const k of ['sslmode', 'ssl', 'channel_binding']) u.searchParams.delete(k);
  let ssl = { rejectUnauthorized: true };
  if (process.env.CLOUD_SSL_CA) ssl = { ca: fs.readFileSync(process.env.CLOUD_SSL_CA, 'utf8'), rejectUnauthorized: true };
  else if (process.env.CLOUD_SSL === 'insecure') ssl = { rejectUnauthorized: false };
  else if (process.env.CLOUD_SSL === 'off') ssl = false; // solo para pruebas con una base local sin cifrado
  const pool = new Pool({ connectionString: u.toString(), ssl, max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000, statement_timeout: 60000 });
  pool.on('error', e => console.warn('[nube] conexión inactiva cerrada:', e.message)); // sin esto, un corte tumba el programa
  return pool;
}

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10, ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined });
  pool.on('error', e => console.warn('[base local] conexión inactiva cerrada:', e.message));
  await migrate(pool);

  let sync;
  if (process.env.CLOUD_DATABASE_URL) {
    const { rows: [{ id }] } = await pool.query(`SELECT value #>> '{}' AS id FROM settings WHERE key = 'store_id'`);
    sync = createSync({ local: pool, cloud: cloudPool(process.env.CLOUD_DATABASE_URL), storeId: id, intervalMs: (Number(process.env.SYNC_SECONDS) || 30) * 1000 });
    sync.start();
    console.log('Sincronización con la nube activada');
  }
  const app = createApp({ pool, publicDir: path.join(__dirname, '..', 'public'), sync });
  app.listen(PORT, HOST, () => console.log(`Caja lista en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
})().catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
