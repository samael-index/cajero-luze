'use strict';
// Stock compartido: la caja (base local) contra una réplica de la nube con candles y la función de supabase/compartir-stock.sql.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createApp, migrate } = require('../app');
const { createSync } = require('../sync');

const LOCAL = process.env.DATABASE_URL_TEST3 || 'postgres://caja:caja_dev@localhost:5432/caja_test3';
const CLOUD = process.env.STOCK_CLOUD_URL_TEST || 'postgres://caja:caja_dev@localhost:5432/caja_stock_test';
const SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'compartir-stock.sql'), 'utf8');
let local, cloud, server, base, sync, token, storeId;

async function api(method, p, body, tok = token) {
  const headers = { 'content-type': 'application/json' };
  if (tok) headers['x-admin-token'] = tok;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const one = async (pool, sql, p) => (await pool.query(sql, p)).rows[0];
const nube = async id => Number((await one(cloud, 'SELECT stock FROM public.candles WHERE id=$1', [id])).stock);
const lstock = async name => (await one(local, 'SELECT stock FROM products WHERE name=$1 AND active', [name])).stock;
const sell = (items) => api('POST', '/api/sales', { method: 'efectivo', paid: 1000000, items }, null);
let A, B;

before(async () => {
  for (const u of [LOCAL, CLOUD]) assert.match(u, /test/, 'Las pruebas borran las bases: sus URL deben contener "test"');
  local = new Pool({ connectionString: LOCAL });
  cloud = new Pool({ connectionString: CLOUD });
  await local.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await cloud.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS caja CASCADE; CREATE SCHEMA public;
    CREATE TABLE public.candles (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, category text NOT NULL DEFAULT 'Sin categoría',
      stock numeric NOT NULL DEFAULT 0, unit text NOT NULL DEFAULT 'unidades', "minStock" numeric NOT NULL DEFAULT 0, notes text NOT NULL DEFAULT '', "updatedAt" timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.stock_movements (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, candle_id bigint REFERENCES public.candles(id), product_name text NOT NULL,
      quantity numeric NOT NULL, movement_type text NOT NULL, category text NOT NULL DEFAULT '', previous_stock numeric NOT NULL DEFAULT 0,
      final_stock numeric NOT NULL DEFAULT 0, notes text NOT NULL DEFAULT '', user_email text DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO public.candles (name, category, stock) VALUES ('Cúpula Margarita','Postres y demás',10), ('Virgen grande','Velas religiosas',3);`);
  await migrate(local);
  storeId = (await one(local, `SELECT value #>> '{}' AS id FROM settings WHERE key='store_id'`)).id;
  sync = createSync({ local, cloud, storeId, log: { warn() {} } });
  server = createApp({ pool: local, sync }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await api('POST', '/api/setup', { name: 'Isa', pin: '4321' }, null)).data.token;
});
after(async () => { server.close(); sync.stop(); await local.end(); await cloud.end(); });

test('sin la función en la nube, la caja sincroniza el espejo y simplemente no usa el stock compartido', async () => {
  await sync.run();
  const st = await sync.status();
  assert.equal(st.last_error, null);
  assert.equal((await one(local, 'SELECT count(*)::int n FROM products')).n, 0);
});

test('con la función instalada, la caja trae los productos y su stock', async () => {
  await cloud.query(SQL);
  await sync.run();
  assert.equal((await sync.status()).last_error, null);
  assert.equal(await lstock('Cúpula Margarita'), 10);
  assert.equal(await lstock('Virgen grande'), 3);
  const p = await one(local, `SELECT category, price, remote_id FROM products WHERE name='Cúpula Margarita'`);
  assert.equal(p.category, 'Postres y demás'); assert.equal(Number(p.price), 0); assert.ok(p.remote_id);
  [A, B] = (await local.query('SELECT id, remote_id FROM products ORDER BY id')).rows;
});

test('una venta descuenta en la nube y queda en su historial', async () => {
  const r = await sell([{ product_id: A.id, qty: 2 }]);
  assert.equal(r.status, 200);
  assert.equal(await lstock('Cúpula Margarita'), 8);
  await sync.run();
  assert.equal(await nube(A.remote_id), 8);
  const m = await one(cloud, `SELECT * FROM public.stock_movements WHERE movement_type='venta'`);
  assert.equal(Number(m.quantity), -2); assert.match(m.notes, /Venta N°/);
});

test('sincronizar de nuevo no descuenta dos veces', async () => {
  await sync.run(); await sync.run();
  assert.equal(await nube(A.remote_id), 8);
  assert.equal((await one(cloud, `SELECT count(*)::int n FROM public.stock_movements WHERE movement_type='venta'`)).n, 1);
});

test('un cambio de stock hecho en el sistema de stock llega a la caja', async () => {
  await cloud.query('UPDATE public.candles SET stock = 20 WHERE id = $1', [B.remote_id]);
  await sync.run();
  assert.equal(await lstock('Virgen grande'), 20);
});

test('sin internet la caja sigue vendiendo; al volver, aplica lo vendido sobre el stock que haya en la nube', async () => {
  const caida = new Pool({ connectionString: 'postgres://caja:x@127.0.0.1:1/nada', connectionTimeoutMillis: 800 });
  caida.on('error', () => {});
  sync.useCloud(caida);
  await sell([{ product_id: B.id, qty: 5 }]);
  await sync.run();                                  // falla: no hay nube
  assert.ok((await sync.status()).last_error);
  assert.equal(await lstock('Virgen grande'), 15);
  await cloud.query('UPDATE public.candles SET stock = 30 WHERE id = $1', [B.remote_id]);   // mientras tanto producen más
  sync.useCloud(cloud);
  await sync.run();
  assert.equal(await nube(B.remote_id), 25, '30 de la nube - 5 vendidos sin internet');
  assert.equal(await lstock('Virgen grande'), 25);
  await caida.end().catch(() => {});
});

test('una venta pendiente no se pierde ni se cuenta doble cuando se trae el stock', async () => {
  sync.useCloud(new Pool({ connectionString: 'postgres://caja:x@127.0.0.1:1/nada', connectionTimeoutMillis: 800 }).on('error', () => {}));
  await sell([{ product_id: A.id, qty: 1 }]);
  sync.useCloud(cloud);
  await sync.run();
  assert.equal(await nube(A.remote_id), 7); assert.equal(await lstock('Cúpula Margarita'), 7);
});

test('anular una venta devuelve el stock a la nube', async () => {
  const { rows: [v] } = await local.query(`SELECT id FROM sales WHERE status='ok' ORDER BY id LIMIT 1`);
  const r = await api('POST', `/api/sales/${v.id}/void`, { reason: 'Error de cobro' });
  assert.equal(r.status, 200);
  await sync.run();
  assert.equal(await nube(A.remote_id), 9);
  assert.equal(await lstock('Cúpula Margarita'), 9);
  assert.ok((await one(cloud, `SELECT 1 FROM public.stock_movements WHERE movement_type='devolución'`)));
});

test('el precio que se pone en la caja se guarda también en el sistema de stock', async () => {
  await api('PUT', `/api/products/${A.id}`, { name: 'Cúpula Margarita', price: 6000, cost: 0, stock: 9, category: 'Postres y demás' });
  await sync.run();
  assert.equal(Number((await one(cloud, 'SELECT price FROM public.candles WHERE id=$1', [A.remote_id])).price), 6000);
});

test('un producto nuevo del sistema de stock aparece; uno que desaparece deja de ofrecerse', async () => {
  await cloud.query(`INSERT INTO public.candles (name, category, stock, price) VALUES ('Tulipán','Postres y demás',4,5000)`);
  await cloud.query('DELETE FROM public.stock_movements WHERE candle_id = $1', [B.remote_id]);
  await cloud.query('DELETE FROM public.candles WHERE id = $1', [B.remote_id]);
  await sync.run();
  const t = await one(local, `SELECT stock, price FROM products WHERE name='Tulipán' AND active`);
  assert.equal(t.stock, 4); assert.equal(Number(t.price), 5000);
  assert.equal((await one(local, `SELECT active FROM products WHERE name='Virgen grande'`)).active, false);
});

test('un producto que la caja ya tenía se enlaza por nombre sin duplicarse ni sumar su stock', async () => {
  await api('POST', '/api/products', { name: 'Ramillete', price: 7000, cost: 0, stock: 99 });
  await cloud.query(`INSERT INTO public.candles (name, category, stock) VALUES ('ramillete','Postres y demás',1)`);
  await sync.run();
  assert.equal((await one(local, `SELECT count(*)::int n FROM products WHERE lower(name)='ramillete' AND active`)).n, 1);
  assert.equal((await one(local, "SELECT stock FROM products WHERE lower(name)='ramillete' AND active")).stock, 1, 'manda el stock del sistema de stock');
});
