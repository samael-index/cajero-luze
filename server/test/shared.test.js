'use strict';
// Prueba la propuesta supabase/compartir-stock.sql contra una RÉPLICA local de la estructura real del proyecto
// de Velas Luze (tablas candles y stock_movements con sus reglas de acceso). No toca ningún Supabase.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const URL = process.env.SHARED_URL_TEST || 'postgres://caja:caja_dev@localhost:5432/caja_shared_test';
let pool;
const SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'compartir-stock.sql'), 'utf8');

const replica = `
DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS storage CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role' $$;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
-- permisos por defecto de Supabase en el esquema public
GRANT USAGE ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
-- estructura y reglas copiadas del proyecto real
CREATE TABLE public.candles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, category text NOT NULL DEFAULT 'Sin categoría',
  stock numeric NOT NULL DEFAULT 0, unit text NOT NULL DEFAULT 'unidades', "minStock" numeric NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '', "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.stock_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, candle_id bigint REFERENCES public.candles(id), product_name text NOT NULL,
  quantity numeric NOT NULL, movement_type text NOT NULL, category text NOT NULL DEFAULT '', previous_stock numeric NOT NULL DEFAULT 0,
  final_stock numeric NOT NULL DEFAULT 0, notes text NOT NULL DEFAULT '', user_email text DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.candles ENABLE ROW LEVEL SECURITY; ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY candles_select_authenticated ON public.candles FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY candles_insert_authenticated ON public.candles FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY candles_update_authenticated ON public.candles FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY candles_delete_authenticated ON public.candles FOR DELETE USING (auth.role() = 'authenticated');
CREATE POLICY stock_movements_select_authenticated ON public.stock_movements FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY stock_movements_insert_authenticated ON public.stock_movements FOR INSERT WITH CHECK (auth.role() = 'authenticated');
`;

async function como(role, query, params) {   // ejecuta como lo haría la API de Supabase
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })]);
    return (await c.query(query, params)).rows;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
const mover = (clave, items) => pool.query('SELECT public.caja_aplicar_movimientos($1,$2::jsonb) AS r', [clave, JSON.stringify(items)]).then(r => r.rows[0].r);
const stock = async id => Number((await pool.query('SELECT stock FROM public.candles WHERE id=$1', [id])).rows[0].stock);
let A, B;

before(async () => {
  assert.match(URL, /test/, 'Las pruebas borran la base: la URL debe contener "test"');
  pool = new Pool({ connectionString: URL });
  await pool.query(replica);
  await pool.query(`INSERT INTO public.candles (name, category, stock) VALUES ('Cúpula Margarita','Velas religiosas',10), ('Pareja de amor','Postres y demás',1)`);
  await pool.query(`INSERT INTO public.stock_movements (candle_id, product_name, quantity, movement_type, previous_stock, final_stock) VALUES (1,'Cúpula Margarita',1,'producción',9,10)`);
  await pool.query(SQL);
  await pool.query(SQL);   // idempotente: se puede ejecutar dos veces
  [A, B] = (await pool.query('SELECT id FROM public.candles ORDER BY id')).rows.map(r => r.id);
});
after(async () => { await pool.end(); });

test('lo que ya existe sigue igual y su app sigue pudiendo leer, insertar y editar (las columnas nuevas son opcionales)', async () => {
  const antes = await como('authenticated', 'SELECT count(*)::int n FROM public.candles');
  assert.equal(antes[0].n, 2);
  const nuevo = await como('authenticated', `INSERT INTO public.candles (name) VALUES ('Vela nueva') RETURNING id, price, image_path`);
  assert.equal(nuevo[0].price, null); assert.equal(nuevo[0].image_path, null);
  await como('authenticated', `UPDATE public.candles SET price = 6000, image_path = 'a.jpg' WHERE id = ${A} RETURNING id`);
  assert.equal((await como('authenticated', `SELECT count(*)::int n FROM public.stock_movements`))[0].n, 1);
  assert.equal((await como('anon', `SELECT count(*)::int n FROM public.candles`))[0].n, 0, 'sin sesión sigue sin ver nada');
});

test('una venta descuenta el stock y deja el historial con el mismo formato que usa su app', async () => {
  const r = await mover('t1:venta:1', [{ candle_id: A, delta: -2, tipo: 'venta', nota: 'Venta N° 1' }]);
  assert.equal(r.ya_aplicado, false); assert.equal(r.items[0].stock, 8);
  assert.equal(await stock(A), 8);
  const m = (await pool.query(`SELECT * FROM public.stock_movements WHERE movement_type = 'venta'`)).rows[0];
  assert.equal(Number(m.quantity), -2); assert.equal(Number(m.previous_stock), 10); assert.equal(Number(m.final_stock), 8);
  assert.equal(m.product_name, 'Cúpula Margarita'); assert.equal(m.category, 'Velas religiosas'); assert.equal(m.notes, 'Venta N° 1'); assert.equal(m.user_email, 'caja');
});

test('reintentar la misma venta (tras un corte de internet) no descuenta dos veces', async () => {
  const r = await mover('t1:venta:1', [{ candle_id: A, delta: -2, tipo: 'venta' }]);
  assert.equal(r.ya_aplicado, true); assert.equal(await stock(A), 8);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM public.stock_movements WHERE movement_type = 'venta'`)).rows[0].n, 1);
});

test('devolución y carga suman; el stock nunca queda negativo y se anota lo que faltó', async () => {
  await mover('t1:anulacion:1', [{ candle_id: A, delta: 2, tipo: 'devolución', nota: 'Anulación venta 1' }]);
  assert.equal(await stock(A), 10);
  const r = await mover('t1:venta:2', [{ candle_id: B, delta: -3, tipo: 'venta', nota: 'Venta N° 2' }]);   // había 1, se vendieron 3
  assert.equal(await stock(B), 0); assert.equal(r.items[0].aplicado, -1);
  const m = (await pool.query(`SELECT * FROM public.stock_movements WHERE candle_id = $1 ORDER BY id DESC LIMIT 1`, [B])).rows[0];
  assert.match(m.notes, /faltaron 2 unidades/); assert.equal(Number(m.final_stock) - Number(m.previous_stock), Number(m.quantity), 'anterior + cantidad = final');
});

test('dos ventas simultáneas de la última unidad: nunca queda negativo ni se pierde un movimiento', async () => {
  await pool.query(`UPDATE public.candles SET stock = 1 WHERE id = $1`, [A]);
  const [x, y] = await Promise.all([
    mover('t1:venta:10', [{ candle_id: A, delta: -1, tipo: 'venta' }]),
    mover('t1:venta:11', [{ candle_id: A, delta: -1, tipo: 'venta' }])]);
  assert.equal(await stock(A), 0);
  assert.deepEqual([x, y].map(r => r.items[0].aplicado).sort(), [-1, 0]);
  const n = (await pool.query(`SELECT count(*)::int n FROM public.stock_movements WHERE notes = '' AND movement_type = 'venta' OR notes LIKE '%faltaron%'`)).rows[0].n;
  assert.ok(n >= 2);
});

test('un producto que no existe se informa y no impide aplicar los demás; una lista vacía se rechaza', async () => {
  await pool.query(`UPDATE public.candles SET stock = 5 WHERE id = $1`, [A]);
  const r = await mover('t1:venta:20', [{ candle_id: 99999, delta: -1, tipo: 'venta' }, { candle_id: A, delta: -1, tipo: 'venta' }]);
  assert.equal(r.items.find(i => i.candle_id === 99999).error, 'no_existe'); assert.equal(await stock(A), 4);
  await assert.rejects(mover('t1:venta:21', []), /al menos un movimiento/);
});

test('seguridad: ni la sesión de un usuario ni el visitante pueden llamar la función ni leer el registro de la caja', async () => {
  for (const role of ['authenticated', 'anon']) {
    await assert.rejects(como(role, `SELECT public.caja_aplicar_movimientos('x', '[{"candle_id":1,"delta":-1}]')`), /permission denied/, role);
    await assert.rejects(como(role, `SELECT * FROM public.caja_movimientos_aplicados`), /permission denied/, role);
  }
});

test('el bucket de fotos se crea público y solo escriben usuarios con sesión', async () => {
  const b = (await pool.query(`SELECT public FROM storage.buckets WHERE id = 'productos'`)).rows;
  assert.equal(b.length, 1); assert.equal(b[0].public, true);
  const pol = (await pool.query(`SELECT roles::text, cmd FROM pg_policies WHERE tablename = 'objects' AND policyname = 'productos_escribir'`)).rows;
  assert.equal(pol.length, 1); assert.match(pol[0].roles, /authenticated/); assert.equal(pol[0].cmd, 'ALL');
});
