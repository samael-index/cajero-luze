'use strict';
// Prueba de la página de los dueños con navegador real + simulador de Supabase + PostgreSQL con RLS.
// Uso: NODE_PATH=$(npm root -g):<caja>/node_modules node test-nube/dashboard.e2e.js
// Además comprueba que la página funciona con las MISMAS cabeceras de seguridad (CSP) de nube/netlify.toml.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Pool } = require('pg');
const { start } = require('./mock-supabase');

const DB = process.env.RLS_URL_TEST || 'postgres://caja:caja_dev@localhost:5432/caja_rls_test';
const KEY = 'sb_publishable_TEST';
const OUT = process.env.SHOTS || '/tmp';
const root = path.join(__dirname, '..', 'nube');
const server = path.join(__dirname, '..', 'server');
// La política de seguridad real de Netlify, con el simulador local en lugar de supabase.co
const CSP = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8').match(/Content-Security-Policy = "([^"]+)"/)[1]
  .replace('https://*.supabase.co', 'http://127.0.0.1:3200');
const STORE = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const txt = async (p, s) => (await p.locator(s).first().innerText()).replace(/\s+/g, ' ').trim();

async function seed(pool) {
  await pool.query('DROP SCHEMA IF EXISTS caja CASCADE; DROP SCHEMA IF EXISTS auth CASCADE');
  await pool.query(`CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
    $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;`);
  await pool.query(fs.readFileSync(path.join(server, 'cloud-schema.sql'), 'utf8'));
  await pool.query(fs.readFileSync(path.join(server, 'cloud-dashboard.sql'), 'utf8'));
  await pool.query(`INSERT INTO caja.owners VALUES ('isa@ejemplo.com')`);
  await pool.query(`INSERT INTO caja.stores(store_id,name,stock_bajo,last_sync) VALUES ($1,'Mi tienda',5,now())`, [STORE]);
  const P = (id, name, stock, price, cat) => pool.query(
    `INSERT INTO caja.products(store_id,id,sync_x,name,price,cost,stock,category,emoji,active,created_at,updated_at) VALUES ($1,$2,1,$3,$4,0,$5,$6,'',true,now(),now())`, [STORE, id, name, price, stock, cat]);
  await P(1, 'Pan', 0, 1500, 'Panadería'); await P(2, 'Leche', 3, 4200, 'Lácteos'); await P(3, 'Arroz', 40, 4800, 'Granos');
  await P(4, 'Gaseosa', 12, 5000, 'Bebidas'); await P(5, '<img src=x onerror="window.__xss=1">', 9, 1000, 'Prueba');
  const S = (id, ago, subtotal, disc, method, status) => pool.query(
    `INSERT INTO caja.sales(store_id,id,sync_x,created_at,subtotal,discount,total,method,paid,change,status) VALUES ($1,$2,1,now() - $3::interval,$4,$5,$6,$7,$6,0,$8)`,
    [STORE, id, ago, subtotal, disc, subtotal - disc, method, status]);
  const I = (id, sale, name, price, qty, disc) => pool.query(
    `INSERT INTO caja.sale_items(store_id,id,sync_x,sale_id,product_id,name,unit_price,cost,qty,discount,line_total) VALUES ($1,$2,1,$3,1,$4,$5::bigint,0,$6::int,$7::bigint,$5::bigint*$6::int-$7::bigint)`, [STORE, id, sale, name, price, qty, disc]);
  await S(1, '0 minutes', 20000, 2000, 'efectivo', 'ok'); await I(1, 1, 'Gaseosa', 5000, 4, 2000);
  await S(2, '0 minutes', 3000, 0, 'tarjeta', 'ok'); await I(2, 2, 'Pan', 1500, 2, 0);
  await S(3, '0 minutes', 4800, 0, 'transferencia', 'ok'); await I(3, 3, 'Arroz', 4800, 1, 0);
  await S(4, '0 minutes', 1500, 0, 'efectivo', 'anulada'); await I(4, 4, 'Pan', 1500, 1, 0);
  await S(5, '1 day', 10000, 0, 'efectivo', 'ok'); await I(5, 5, 'Leche', 4200, 1, 0);
  await pool.query(`INSERT INTO caja.cash_moves(store_id,id,sync_x,created_at,type,amount,left_in_cash,reason,admin_name) VALUES
    ($1,1,1,now() - interval '1 day','ingreso',100000,100000,'Fondo','Isa'), ($1,2,1,now(),'retiro',54200,80000,'Retiro de los dueños','Yamil')`, [STORE]);
}

(async () => {
  const pool = new Pool({ connectionString: DB });
  await seed(pool);
  const mock = await start({ port: 3200, dbUrl: DB, key: KEY });
  const web = http.createServer((req, res) => {   // sirve nube/ y entrega un config.js que apunta al simulador
    const f = req.url === '/config.js' ? null : path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!f) { res.writeHead(200, { 'content-type': 'text/javascript', 'content-security-policy': CSP }); return res.end(`window.CAJA_NUBE={url:'http://127.0.0.1:3200',key:'${KEY}',schema:'caja'}`); }
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html', 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' }); res.end(d); });
  }).listen(3300);

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()) && errs.push(m.text()));
  await p.goto('http://127.0.0.1:3300/');
  const login = async (em, pw) => { await p.fill('#em', em); await p.fill('#pw', pw); await p.click('button[type=submit]'); };

  await p.waitForSelector('#f');
  await login('isa@ejemplo.com', 'mala');
  await p.waitForFunction(() => document.querySelector('#err')?.textContent.length > 0);
  ok((await txt(p, '#err')).includes('Invalid login credentials'), 'clave incorrecta: se muestra el error de Supabase');

  await login('intruso@ejemplo.com', 'clave-x');
  await p.waitForSelector('.alert.amber');
  ok((await txt(p, '.alert')).includes('No hay datos para mostrar'), 'usuario válido pero NO dueño: la base devuelve cero filas y la página lo explica');
  await p.click('[data-a=salir]');

  await p.waitForSelector('#f');
  await login('isa@ejemplo.com', 'clave-isa');
  await p.waitForSelector('.kpis');
  const k = await txt(p, '.kpis');
  ok(k.includes('Vendido hoy $25.800') && k.includes('3 ventas') && k.includes('ayer $10.000'), 'hoy: 25.800 (la anulada no cuenta) y ayer 10.000: ' + k.slice(0, 90));
  ok(k.includes('Efectivo hoy $18.000') && k.includes('Tarjeta hoy $3.000') && k.includes('Transferencia hoy $4.800'), 'por medio de pago');
  ok(k.includes('Descuentos hoy $2.000'), 'descuentos del día');
  ok(k.includes('En la caja (efectivo) $73.800'), 'en caja = 18.000 + 10.000 + 100.000 − 54.200');
  ok((await txt(p, '#sync')).includes('Datos al día'), 'sincronización reciente: aviso verde');
  const mov = await txt(p, 'text=Retiro de los dueños >> xpath=ancestor::tr');
  ok(mov.includes('Yamil') && mov.includes('−$54.200') && mov.includes('$80.000'), 'retiro con motivo, quién y cuánto quedó: ' + mov);
  ok((await p.locator('tr.void').count()) === 1, 'la venta anulada aparece tachada');
  ok(await p.evaluate(() => window.__xss === undefined), 'un nombre de producto con HTML no ejecuta código');
  ok((await txt(p, '.card:has(h2:text("Stock"))')).includes('<img src=x'), 'y se muestra como texto');

  await p.click('[data-f=AGOTADO]');
  ok(await p.locator('.card:has(h2:text("Stock")) tbody tr:has(.tag)').count() === 1 && (await txt(p, '.tag.AGOTADO >> xpath=ancestor::tr')).includes('Pan'), 'filtro Agotados: solo Pan');
  await p.click('[data-f=todos]'); await p.fill('#q', 'lech');
  ok((await p.locator('.card:has(h2:text("Stock")) tr:has(.tag)').count()) === 1 && (await txt(p, '.tag.POCO >> xpath=ancestor::tr')).includes('Leche'), 'buscar "lech": Leche aparece como POCO');
  await p.fill('#q', '');
  await p.screenshot({ path: `${OUT}/d1-escritorio.png`, fullPage: true });

  // caja sin sincronizar hace rato (sin internet / apagada)
  await pool.query(`UPDATE caja.stores SET last_sync = now() - interval '40 minutes'`);
  await p.click('[data-a=refrescar]'); await p.waitForSelector('.alert.amber');
  ok((await txt(p, '#sync')).includes('no ha enviado datos'), 'sin sincronizar hace 40 min: aviso naranja');
  await p.screenshot({ path: `${OUT}/d2-desactualizado.png` });

  // el token vence: la página lo renueva sola
  const before = (await (await fetch('http://127.0.0.1:3200/__test/stats')).json());
  await fetch('http://127.0.0.1:3200/__test/expire');
  await p.click('[data-a=refrescar]'); await p.waitForSelector('.kpis');
  const after = (await (await fetch('http://127.0.0.1:3200/__test/stats')).json());
  ok(after.refreshes > before.refreshes && (await txt(p, '.kpis')).includes('$25.800'), 'sesión vencida: se renueva con el refresh token sin pedir clave');

  await p.reload(); await p.waitForSelector('.kpis');
  ok(true, 'al recargar la página la sesión sigue');

  // móvil + modo oscuro
  await p.setViewportSize({ width: 390, height: 844 });
  const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  ok(w.sw <= w.w, `móvil 390px: sin desborde horizontal de la página (${w.sw}/${w.w})`);
  await p.screenshot({ path: `${OUT}/d3-movil.png`, fullPage: false });
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.screenshot({ path: `${OUT}/d4-movil-oscuro.png`, fullPage: false });

  await p.click('[data-a=salir]'); await p.waitForSelector('#f');
  ok(await p.evaluate(() => localStorage.getItem('caja_nube_sesion')) === null, 'Salir borra la sesión del navegador');
  console.log('errores JS de la página:', errs);
  await b.close(); web.close(); await mock.close(); await pool.end();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
