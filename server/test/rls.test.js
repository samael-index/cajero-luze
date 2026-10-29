'use strict';
// Verifica los permisos de la nube (server/cloud-dashboard.sql) contra PostgreSQL real.
// Imita lo que hace Supabase: roles anon/authenticated y auth.jwt() leyendo request.jwt.claims.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const URL = process.env.RLS_URL_TEST || 'postgres://caja:caja_dev@localhost:5432/caja_rls_test';
const sql = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const STORE = '11111111-1111-1111-1111-111111111111';
let pool;

// Ejecuta una consulta como lo haría la API de Supabase: rol + claims del token.
async function as(role, email, query) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(email ? { email, role } : {})]);
    return (await c.query(query)).rows;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
const denied = (p) => assert.rejects(p, /permission denied/);

before(async () => {
  assert.match(URL, /test/, 'Las pruebas borran la base: la URL debe contener "test"');
  pool = new Pool({ connectionString: URL });
  await pool.query('DROP SCHEMA IF EXISTS caja CASCADE; DROP SCHEMA IF EXISTS auth CASCADE');
  // Equivalente mínimo de Supabase Auth: auth.jwt() lee los claims de la petición
  await pool.query(`CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;`);
  await pool.query(sql('cloud-schema.sql'));
  await pool.query(sql('cloud-dashboard.sql'));
  await pool.query(`INSERT INTO caja.owners(email) VALUES ('isa@ejemplo.com'), ('yamil@ejemplo.com')`);
  await pool.query(`INSERT INTO caja.stores(store_id, name, last_sync) VALUES ('${STORE}', 'Mi tienda', now())`);
  await pool.query(`INSERT INTO caja.products(store_id,id,sync_x,name,price,cost,stock,category,emoji,active,created_at,updated_at)
    VALUES ('${STORE}',1,1,'Pan',1500,900,0,'','',true,now(),now()), ('${STORE}',2,1,'Leche',4200,3500,40,'','',true,now(),now())`);
  await pool.query(`INSERT INTO caja.sales(store_id,id,sync_x,created_at,subtotal,discount,total,method,paid,change,status)
    VALUES ('${STORE}',1,1,now(),1500,0,1500,'efectivo',2000,500,'ok')`);
  await pool.query(`INSERT INTO caja.sale_items(store_id,id,sync_x,sale_id,product_id,name,unit_price,cost,qty,discount,line_total)
    VALUES ('${STORE}',1,1,1,1,'Pan',1500,900,1,0,1500)`);
  await pool.query(`INSERT INTO caja.cash_moves(store_id,id,sync_x,created_at,type,amount,left_in_cash,reason,admin_name)
    VALUES ('${STORE}',1,1,now(),'ingreso',100000,100000,'Fondo','Isa')`);
});
after(async () => { await pool.end(); });

const VIEWS = ['v_stock_actual', 'v_ventas_por_dia', 'v_ventas_detalle', 'v_caja_movimientos', 'v_caja_saldo'];
const TABLES = ['stores', 'products', 'sales', 'sale_items', 'stock_moves', 'cash_moves', 'cash_counts'];

test('un dueño ve los datos en todas las vistas (sin importar mayúsculas)', async () => {
  for (const email of ['isa@ejemplo.com', 'ISA@Ejemplo.com', 'yamil@ejemplo.com']) {
    for (const v of VIEWS) assert.ok((await as('authenticated', email, `SELECT * FROM caja.${v}`)).length > 0, `${email} ${v}`);
  }
  const stock = await as('authenticated', 'isa@ejemplo.com', 'SELECT producto, estado FROM caja.v_stock_actual');
  assert.deepEqual(stock.map(r => [r.producto, r.estado]), [['Pan', 'AGOTADO'], ['Leche', 'OK']]);
  const saldo = await as('authenticated', 'isa@ejemplo.com', 'SELECT en_caja_efectivo FROM caja.v_caja_saldo');
  assert.equal(Number(saldo[0].en_caja_efectivo), 101500);
});

test('una persona con sesión pero que no es dueña ve CERO filas, en vistas y en tablas', async () => {
  for (const email of ['intruso@ejemplo.com', 'isa@ejemplo.com.evil.com', '', null]) {
    for (const v of VIEWS) assert.equal((await as('authenticated', email, `SELECT * FROM caja.${v}`)).length, 0, `${email} ${v}`);
    for (const t of TABLES) assert.equal((await as('authenticated', email, `SELECT * FROM caja.${t}`)).length, 0, `${email} ${t}`);
  }
});

test('sin iniciar sesión (anon) no hay ningún acceso', async () => {
  for (const v of VIEWS) await denied(as('anon', null, `SELECT * FROM caja.${v}`));
  for (const t of TABLES) await denied(as('anon', null, `SELECT * FROM caja.${t}`));
  await denied(as('anon', null, `SELECT caja.is_owner()`));
});

test('solo lectura: ni los dueños pueden escribir por la API', async () => {
  const o = 'isa@ejemplo.com';
  await denied(as('authenticated', o, `INSERT INTO caja.sales(store_id,id,sync_x,created_at,subtotal,discount,total,method,paid,change,status) VALUES ('${STORE}',9,1,now(),1,0,1,'efectivo',1,0,'ok')`));
  await denied(as('authenticated', o, `UPDATE caja.products SET stock = 999`));
  await denied(as('authenticated', o, `DELETE FROM caja.sales`));
  await denied(as('authenticated', o, `TRUNCATE caja.sales`));
});

test('la lista de dueños no se puede leer ni cambiar desde la API', async () => {
  await denied(as('authenticated', 'isa@ejemplo.com', 'SELECT * FROM caja.owners'));
  await denied(as('authenticated', 'intruso@ejemplo.com', `INSERT INTO caja.owners VALUES ('intruso@ejemplo.com')`));
});

test('el sincronizador (dueño de las tablas) sigue pudiendo escribir y no pierde los permisos al re-ejecutar el esquema', async () => {
  await pool.query(`INSERT INTO caja.sales(store_id,id,sync_x,created_at,subtotal,discount,total,method,paid,change,status)
    VALUES ('${STORE}',2,2,now(),3000,0,3000,'tarjeta',3000,0,'ok')`);
  await pool.query(sql('cloud-schema.sql'));   // lo que hace el sincronizador al reconectar
  assert.equal((await as('authenticated', 'isa@ejemplo.com', `SELECT * FROM caja.v_ventas_por_dia`)).length, 1);
  assert.equal(Number((await as('authenticated', 'isa@ejemplo.com', `SELECT total FROM caja.v_ventas_por_dia`))[0].total), 4500);
  await denied(as('anon', null, `SELECT * FROM caja.v_ventas_por_dia`));
  assert.equal((await as('authenticated', 'intruso@ejemplo.com', `SELECT * FROM caja.v_ventas_por_dia`)).length, 0);
});
