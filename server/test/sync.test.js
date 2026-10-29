'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createApp, migrate } = require('../app');
const { createSync } = require('../sync');

const LOCAL = process.env.DATABASE_URL_TEST2 || 'postgres://caja:caja_dev@localhost:5432/caja_test2';
const CLOUD = process.env.CLOUD_URL_TEST || 'postgres://caja:caja_dev@localhost:5432/caja_cloud_test';
let local, cloud, deadCloud, server, base, sync, token, storeId;

async function api(method, path, body, tok = token) {
  const headers = { 'content-type': 'application/json' };
  if (tok) headers['x-admin-token'] = tok;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const q = async (pool, sql, p) => (await pool.query(sql, p)).rows;
const one = async (pool, sql, p) => (await q(pool, sql, p))[0];

before(async () => {
  for (const u of [LOCAL, CLOUD]) assert.match(u, /test/, 'Las pruebas borran las bases: sus URL deben contener "test"');
  local = new Pool({ connectionString: LOCAL });
  cloud = new Pool({ connectionString: CLOUD });
  deadCloud = new Pool({ connectionString: 'postgres://caja:x@127.0.0.1:1/nada', connectionTimeoutMillis: 1500 });
  deadCloud.on('error', () => {});
  await local.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await cloud.query('DROP SCHEMA IF EXISTS caja CASCADE');
  await migrate(local);
  storeId = (await one(local, `SELECT value #>> '{}' AS id FROM settings WHERE key='store_id'`)).id;
  sync = createSync({ local, cloud, storeId, log: { warn() {} } });
  server = createApp({ pool: local, sync }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await api('POST', '/api/setup', { name: 'Isa', pin: '4321' }, null)).data.token;
});
after(async () => { server.close(); sync.stop(); await local.end(); await cloud.end(); await deadCloud.end().catch(() => {}); });

const sell = (items, method = 'efectivo', paid = 100000) => api('POST', '/api/sales', { method, paid, items }, null);
const cloudCount = async t => (await one(cloud, `SELECT count(*)::int n FROM caja.${t} WHERE store_id=$1`, [storeId])).n;

let pan, leche;
test('la primera sincronización crea el espejo en la nube y sube todo', async () => {
  pan = (await api('POST', '/api/products', { name: 'Pan', price: 1500, cost: 900, stock: 20 })).data;
  leche = (await api('POST', '/api/products', { name: 'Leche', price: 4200, stock: 3 })).data;
  await sell([{ product_id: pan.id, qty: 2, discount: 300 }, { product_id: leche.id, qty: 1 }]);
  await sell([{ product_id: pan.id, qty: 1 }], 'tarjeta');
  await api('POST', '/api/cash/ingreso', { amount: 100000, reason: 'Fondo' });
  const before = await sync.status();
  assert.ok(before.pending > 0 && before.last_ok === null);
  await sync.run();
  const st = await sync.status();
  assert.equal(st.last_error, null); assert.equal(st.pending, 0); assert.ok(st.last_ok);
  assert.equal(await cloudCount('products'), 2); assert.equal(await cloudCount('sales'), 2);
  assert.equal(await cloudCount('sale_items'), 3); assert.equal(await cloudCount('cash_moves'), 1);
  assert.ok((await cloudCount('stock_moves')) >= 5);
  const p = await one(cloud, `SELECT stock, price FROM caja.products WHERE store_id=$1 AND name='Pan'`, [storeId]);
  assert.equal(p.stock, 17); assert.equal(p.price, 1500);
});

test('las vistas para los dueños dan lo mismo que la caja local', async () => {
  const stock = await q(cloud, `SELECT producto, stock, estado FROM caja.v_stock_actual`);
  assert.deepEqual(stock.map(r => [r.producto, r.stock, r.estado]), [['Leche', 2, 'POCO'], ['Pan', 17, 'OK']]);
  const dia = (await q(cloud, `SELECT * FROM caja.v_ventas_por_dia`))[0];
  assert.equal(Number(dia.total), (3000 - 300) + 4200 + 1500);   // pan con descuento + leche + pan con tarjeta
  assert.equal(Number(dia.efectivo), 6900); assert.equal(Number(dia.tarjeta), 1500); assert.equal(Number(dia.descuentos), 300);
  const saldo = Number((await one(cloud, `SELECT en_caja_efectivo FROM caja.v_caja_saldo`)).en_caja_efectivo);
  const local_ = (await api('GET', '/api/cash/state', undefined, null)).data.en_caja;
  assert.equal(saldo, local_); assert.equal(saldo, 100000 + 6900);
  assert.equal((await q(cloud, `SELECT * FROM caja.v_ventas_detalle`)).length, 3);
  assert.equal((await q(cloud, `SELECT * FROM caja.v_caja_movimientos`))[0].motivo, 'Fondo');
});

test('repetir la sincronización no duplica ni cambia nada', async () => {
  await sync.run();
  assert.equal(await cloudCount('sales'), 2); assert.equal(await cloudCount('sale_items'), 3);
});

test('anular una venta se refleja en la nube (fila actualizada y stock devuelto)', async () => {
  const id = (await one(local, `SELECT id FROM sales WHERE method='tarjeta'`)).id;
  assert.equal((await api('POST', `/api/sales/${id}/void`, { reason: 'Error' })).status, 200);
  await sync.run();
  assert.equal((await one(cloud, `SELECT status FROM caja.sales WHERE store_id=$1 AND id=$2`, [storeId, id])).status, 'anulada');
  assert.equal((await one(cloud, `SELECT stock FROM caja.products WHERE store_id=$1 AND name='Pan'`, [storeId])).stock, 18);
});

test('sin internet: la caja sigue vendiendo y los cambios quedan pendientes; al volver se suben todos', async () => {
  sync.useCloud(deadCloud);
  const r1 = await sell([{ product_id: pan.id, qty: 1 }]);
  const r2 = await sell([{ product_id: leche.id, qty: 1 }], 'transferencia');
  assert.equal(r1.status, 200); assert.equal(r2.status, 200, 'la venta local no depende de la nube');
  await api('POST', '/api/cash/retiro', { mode: 'queda', value: 50000, reason: 'Retiro de los dueños' });
  const t0 = Date.now();
  await sync.run();
  assert.ok(Date.now() - t0 < 6000, 'el intento sin internet termina rápido');
  let st = await sync.status();
  assert.ok(st.last_error, 'queda registrado el error'); assert.ok(st.pending >= 6, 'pendientes: ' + st.pending);
  assert.equal(await cloudCount('sales'), 2, 'la nube no cambió');
  await sell([{ product_id: pan.id, qty: 1 }]);   // sigue vendiendo con la nube caída
  sync.useCloud(cloud);                            // vuelve el internet
  await sync.run();
  st = await sync.status();
  assert.equal(st.last_error, null); assert.equal(st.pending, 0);
  assert.equal(await cloudCount('sales'), 5);
  assert.equal(await cloudCount('cash_moves'), 2);
  const saldo = Number((await one(cloud, `SELECT en_caja_efectivo FROM caja.v_caja_saldo`)).en_caja_efectivo);
  assert.equal(saldo, (await api('GET', '/api/cash/state', undefined, null)).data.en_caja);
  assert.equal(saldo, 50000 + 1500, 'el retiro dejó 50.000 y después entró una venta de 1.500');
});

test('una transacción lenta que confirma tarde no se pierde (no hay filas olvidadas)', async () => {
  const slow = await local.connect();
  await slow.query('BEGIN');
  await slow.query(`INSERT INTO products(name, price, stock) VALUES ('Tardío', 999, 7)`);   // tx abierta, aún sin confirmar
  await sell([{ product_id: pan.id, qty: 1 }]);                                              // otra tx más nueva SÍ confirma
  await sync.run();
  assert.equal((await q(cloud, `SELECT 1 FROM caja.products WHERE store_id=$1 AND name='Tardío'`, [storeId])).length, 0);
  await slow.query('COMMIT'); slow.release();
  await sync.run();
  assert.equal((await one(cloud, `SELECT stock FROM caja.products WHERE store_id=$1 AND name='Tardío'`, [storeId])).stock, 7, 'la fila lenta llegó');
  assert.equal(await cloudCount('sales'), 6, 'y la venta más nueva también');
  assert.equal((await sync.status()).pending, 0);
});

test('importar muchos productos sube todo, por páginas', async () => {
  const rows = Array.from({ length: 1300 }, (_, i) => ({ name: `Masivo ${i}`, price: 1000 + i, cost: 0, stock: 5, category: 'Prueba', emoji: '' }));
  assert.equal((await api('POST', '/api/products/bulk', { rows, stock_mode: 'reemplazar' })).status, 200);
  await sync.run();
  assert.equal(await cloudCount('products'), 3 + 1300);
  assert.equal((await sync.status()).pending, 0);
});

test('cada tienda queda separada y se ve cuándo fue la última sincronización', async () => {
  const s = await one(cloud, `SELECT name, last_sync FROM caja.stores WHERE store_id=$1`, [storeId]);
  assert.equal(s.name, 'Mi tienda'); assert.ok(s.last_sync);
  const { status, data } = await api('GET', '/api/sync/status', undefined, null);
  assert.equal(status, 200); assert.equal(data.enabled, true); assert.equal(data.pending, 0);
  assert.equal((await api('POST', '/api/sync/run', {}, null)).status, 401);
  assert.equal((await api('POST', '/api/sync/run', {})).status, 200);
  assert.ok(!JSON.stringify((await api('GET', '/api/bootstrap', undefined, null)).data).includes(storeId), 'el id de la tienda no se expone');
});
