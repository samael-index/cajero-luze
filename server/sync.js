'use strict';
/*
 * Sincronización local -> nube (Supabase / Neon). La base LOCAL es la que opera la caja; la nube es un
 * espejo de solo lectura para ver stock y ventas desde otro sitio. Si no hay internet, la caja sigue
 * igual y los cambios quedan pendientes; al volver la conexión se suben solos.
 *
 * Por qué es seguro (no pierde ni duplica filas):
 *  - Cada fila guarda en sync_x el id de la transacción que la escribió (trigger en schema.sql).
 *  - Cada vuelta toma xmin = la transacción abierta más antigua. Toda transacción con id < xmin ya
 *    terminó, así que sus filas están completas y visibles. Solo se suben esas.
 *    (Un cursor por número de secuencia fallaría: una transacción lenta puede confirmar después de
 *    otra más nueva y su fila quedaría por detrás del cursor, sin subir nunca.)
 *  - Se sube con INSERT ... ON CONFLICT DO UPDATE: repetir una subida no duplica nada.
 *  - El cursor local solo avanza después de que la nube confirmó la página.
 */
const fs = require('fs');
const path = require('path');

const CURSOR_END = Number.MAX_SAFE_INTEGER;
// Orden: primero las tablas de las que dependen las otras.
const TABLES = [
  { name: 'products', cols: ['id', 'name', 'price', 'cost', 'stock', 'category', 'emoji', 'active', 'created_at', 'updated_at'] },
  { name: 'sales', cols: ['id', 'created_at', 'subtotal', 'discount', 'total', 'method', 'paid', 'change', 'status', 'voided_at', 'voided_by', 'void_reason'] },
  { name: 'sale_items', cols: ['id', 'sale_id', 'product_id', 'name', 'unit_price', 'cost', 'qty', 'discount', 'line_total'] },
  { name: 'stock_moves', cols: ['id', 'product_id', 'delta', 'reason', 'sale_id', 'by', 'created_at'] },
  { name: 'cash_moves', cols: ['id', 'created_at', 'type', 'amount', 'left_in_cash', 'reason', 'admin_name'] },
  { name: 'cash_counts', cols: ['id', 'created_at', 'expected', 'counted', 'diff'] }
];
const PAGE = 500;

function createSync({ local, cloud, storeId, intervalMs = 30000, log = console }) {
  let running = null;
  let timer = null;
  let schemaReady = false;
  const cloudSql = fs.readFileSync(path.join(__dirname, 'cloud-schema.sql'), 'utf8');

  async function cursor(tbl) {
    const { rows } = await local.query('SELECT last_x, last_id FROM sync_state WHERE tbl = $1', [tbl]);
    return rows[0] || { last_x: -1, last_id: -1 };
  }
  const saveCursor = (tbl, x, id) => local.query(
    `INSERT INTO sync_state (tbl, last_x, last_id) VALUES ($1,$2,$3)
     ON CONFLICT (tbl) DO UPDATE SET last_x = EXCLUDED.last_x, last_id = EXCLUDED.last_id`, [tbl, x, id]);

  async function upsert(c, t, rows) {
    const cols = [...t.cols, 'sync_x'];
    const width = cols.length + 1;
    const vals = [];
    const ph = rows.map((r, i) => {
      vals.push(storeId, ...cols.map(k => r[k]));
      return `(${Array.from({ length: width }, (_, j) => `$${i * width + j + 1}`).join(',')})`;
    });
    const set = cols.filter(k => k !== 'id').map(k => `${k} = EXCLUDED.${k}`).join(', ');
    await c.query(
      `INSERT INTO caja.${t.name} (store_id, ${cols.join(', ')}) VALUES ${ph.join(',')}
       ON CONFLICT (store_id, id) DO UPDATE SET ${set} WHERE caja.${t.name}.sync_x <= EXCLUDED.sync_x`, vals);
  }

  async function pushTable(c, t, xmin) {
    let { last_x: lx, last_id: li } = await cursor(t.name);
    for (;;) {
      const { rows } = await local.query(
        `SELECT ${t.cols.map(k => `"${k}"`).join(', ')}, sync_x FROM ${t.name}
          WHERE sync_x < $1 AND (sync_x, id) > ($2, $3) ORDER BY sync_x, id LIMIT ${PAGE}`, [xmin, lx, li]);
      if (!rows.length) break;
      await c.query('BEGIN');
      try { await upsert(c, t, rows); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      const last = rows[rows.length - 1];
      lx = last.sync_x; li = last.id;
      await saveCursor(t.name, lx, li);
    }
    // Todo lo anterior a xmin ya está en la nube.
    await saveCursor(t.name, xmin - 1, CURSOR_END);
  }

  async function runOnce() {
    if (!cloud) return;
    await local.query('UPDATE sync_status SET last_try = now()');
    try {
      const c = await cloud.connect();
      try {
        if (!schemaReady) { await c.query(cloudSql); schemaReady = true; }
        const { rows: [{ xmin }] } = await local.query(`SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS xmin`);
        const { rows: [cfg] } = await local.query(
          `SELECT coalesce((SELECT value #>> '{}' FROM settings WHERE key = 'negocio'), 'Mi tienda') AS name,
                  coalesce((SELECT (value #>> '{}')::int FROM settings WHERE key = 'stock_bajo'), 5) AS stock_bajo`);
        await c.query(
          `INSERT INTO caja.stores (store_id, name, stock_bajo) VALUES ($1,$2,$3)
           ON CONFLICT (store_id) DO UPDATE SET name = EXCLUDED.name, stock_bajo = EXCLUDED.stock_bajo`, [storeId, cfg.name, cfg.stock_bajo]);
        for (const t of TABLES) await pushTable(c, t, xmin);
        await c.query('UPDATE caja.stores SET last_sync = now() WHERE store_id = $1', [storeId]);
      } finally { c.release(); }
      await local.query('UPDATE sync_status SET last_ok = now(), last_error = NULL');
    } catch (e) {
      schemaReady = false; // si la nube cambió o se reinició, se revisa de nuevo la próxima vez
      await local.query('UPDATE sync_status SET last_error = $1', [String(e.message || e).slice(0, 300)]).catch(() => {});
      log.warn?.('[sync] no se pudo sincronizar:', e.message);
    }
  }

  const api = {
    enabled: () => !!cloud,
    useCloud(pool) { cloud = pool; schemaReady = false; },
    // Una sola vuelta a la vez; quien llame mientras corre espera esa misma vuelta.
    run() {
      if (!running) running = runOnce().finally(() => { running = null; });
      return running;
    },
    async status() {
      const { rows: [s] } = await local.query('SELECT last_ok, last_try, last_error FROM sync_status');
      let pending = 0;
      for (const t of TABLES) {
        const cur = await cursor(t.name);
        const { rows: [r] } = await local.query(`SELECT count(*)::int AS n FROM ${t.name} WHERE (sync_x, id) > ($1, $2)`, [cur.last_x, cur.last_id]);
        pending += r.n;
      }
      return { enabled: !!cloud, last_ok: s.last_ok, last_try: s.last_try, last_error: s.last_error, pending };
    },
    start() {
      if (!cloud || timer) return;
      setTimeout(() => api.run(), 3000).unref();
      timer = setInterval(() => api.run(), intervalMs);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
  return api;
}

module.exports = { createSync, TABLES };
