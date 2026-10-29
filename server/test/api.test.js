'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const { createApp, migrate } = require('../app');

const URL = process.env.DATABASE_URL_TEST || 'postgres://caja:caja_dev@localhost:5432/caja_test';
let pool, server, base, token, adminId;

async function api(method, path, body, { tok = token, raw, ctype } = {}) {
  const headers = {};
  if (tok) headers['x-admin-token'] = tok;
  if (body !== undefined) headers['content-type'] = raw ? (ctype || 'application/octet-stream') : 'application/json';
  const res = await fetch(base + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}

before(async () => {
  assert.match(URL, /test/, 'Las pruebas borran la base: la URL debe contener "test"');
  pool = new Pool({ connectionString: URL });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  server = createApp({ pool }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('configuración inicial: un solo primer administrador', async () => {
  const boot = await api('GET', '/api/bootstrap', undefined, { tok: null });
  assert.equal(boot.data.needs_setup, true);
  assert.deepEqual(boot.data.settings.cambio_opciones, [100000, 80000]);
  const bad = await api('POST', '/api/setup', { name: 'Isa', pin: '12' }, { tok: null });
  assert.equal(bad.status, 400);
  const ok = await api('POST', '/api/setup', { name: 'Isa', pin: '4321' }, { tok: null });
  assert.equal(ok.status, 200);
  token = ok.data.token; adminId = ok.data.admin.id;
  const again = await api('POST', '/api/setup', { name: 'Otro', pin: '1111' }, { tok: null });
  assert.equal(again.status, 409);
});

test('PIN: incorrecto falla, correcto entra, 5 fallos bloquean, el PIN no se guarda en claro', async () => {
  const { rows } = await pool.query('SELECT pin_hash FROM admins');
  assert.ok(rows[0].pin_hash.startsWith('scrypt$') && !rows[0].pin_hash.includes('4321'));
  const r = await api('POST', '/api/admins', { name: 'Yamil', pin: '8765' });
  assert.equal(r.status, 200);
  const z = await api('POST', '/api/admins', { name: 'Cero', pin: '0042' });   // PIN con ceros a la izquierda
  assert.equal(z.status, 200);
  assert.equal((await api('POST', '/api/auth/login', { admin_id: z.data.id, pin: '0042' }, { tok: null })).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { admin_id: z.data.id, pin: '42' }, { tok: null })).status, 401);
  await api('DELETE', `/api/admins/${z.data.id}`);
  const wrong = await api('POST', '/api/auth/login', { admin_id: r.data.id, pin: '0000' }, { tok: null });
  assert.equal(wrong.status, 401);
  const good = await api('POST', '/api/auth/login', { admin_id: r.data.id, pin: '8765' }, { tok: null });
  assert.equal(good.status, 200);
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', { admin_id: r.data.id, pin: '0000' }, { tok: null });
  const locked = await api('POST', '/api/auth/login', { admin_id: r.data.id, pin: '8765' }, { tok: null });
  assert.equal(locked.status, 429);
});

test('rutas de administrador exigen sesión; la sesión vence', async () => {
  for (const [m, p] of [['GET', '/api/reports/summary'], ['POST', '/api/cash/retiro'], ['POST', '/api/products'], ['PUT', '/api/settings']]) {
    assert.equal((await api(m, p, m === 'GET' ? undefined : {}, { tok: null })).status, 401, `${m} ${p}`);
  }
  const t = (await api('POST', '/api/auth/login', { admin_id: adminId, pin: '4321' }, { tok: null })).data.token;
  assert.equal((await api('GET', '/api/auth/me', undefined, { tok: t })).data.admin.name, 'Isa');
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
  assert.equal((await api('GET', '/api/reports/summary', undefined, { tok: t })).status, 401);
  token = (await api('POST', '/api/auth/login', { admin_id: adminId, pin: '4321' }, { tok: null })).data.token;
});

let pan, leche, escasa;
test('productos: crear, nombre repetido, costo oculto sin PIN, cargar stock sin PIN', async () => {
  pan = (await api('POST', '/api/products', { name: 'Pan francés', price: 1500, cost: 900, stock: 10 })).data;
  leche = (await api('POST', '/api/products', { name: 'Leche', price: 4200, cost: 0, stock: 5, category: 'Lácteos' })).data;
  escasa = (await api('POST', '/api/products', { name: 'Escasa', price: 1000, stock: 1 })).data;
  assert.equal((await api('POST', '/api/products', { name: 'pan francés', price: 1 })).status, 409);
  const pub = (await api('GET', '/api/products', undefined, { tok: null })).data;
  assert.equal(pub.find(p => p.name === 'Pan francés').cost, undefined);
  assert.equal((await api('GET', '/api/products')).data.find(p => p.name === 'Pan francés').cost, 900);
  const c = await api('POST', `/api/products/${pan.id}/stock`, { qty: 5 }, { tok: null });
  assert.equal(c.data.stock, 15);
  assert.equal((await api('POST', `/api/products/${pan.id}/stock`, { qty: 0 }, { tok: null })).status, 400);
  await pool.query('UPDATE products SET stock = 10 WHERE id = $1', [pan.id]);
});

test('venta en efectivo con descuento: el servidor calcula, descuenta stock y da el vuelto', async () => {
  // 2 panes (3.000) con descuento de 500 + 1 leche (4.200) => 6.700; paga con 10.000 => vuelto 3.300
  const r = await api('POST', '/api/sales', { method: 'efectivo', paid: 10000, items: [{ product_id: pan.id, qty: 2, discount: 500 }, { product_id: leche.id, qty: 1 }] }, { tok: null });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.subtotal, 7200); assert.equal(r.data.discount, 500); assert.equal(r.data.total, 6700); assert.equal(r.data.change, 3300);
  const { rows } = await pool.query('SELECT name, stock FROM products ORDER BY id');
  assert.deepEqual(rows.map(x => x.stock), [8, 4, 1]);
  const items = (await pool.query('SELECT unit_price, discount, line_total FROM sale_items WHERE sale_id=$1 ORDER BY id', [r.data.id])).rows;
  assert.deepEqual(items.map(i => i.line_total), [2500, 4200]);
});

test('venta: validaciones (pago corto, stock, descuento mayor al valor, método)', async () => {
  const s = (b) => api('POST', '/api/sales', b, { tok: null });
  assert.equal((await s({ method: 'efectivo', paid: 1000, items: [{ product_id: pan.id, qty: 1 }] })).data.error, 'pago_insuficiente');
  assert.equal((await s({ method: 'efectivo', paid: 99999, items: [{ product_id: pan.id, qty: 99 }] })).data.error, 'sin_stock');
  assert.equal((await s({ method: 'efectivo', paid: 99999, items: [{ product_id: pan.id, qty: 1, discount: 1501 }] })).status, 400);
  assert.equal((await s({ method: 'cheque', items: [{ product_id: pan.id, qty: 1 }] })).status, 400);
  assert.equal((await s({ method: 'tarjeta', items: [] })).status, 400);
  const t = await s({ method: 'tarjeta', items: [{ product_id: pan.id, qty: 1 }] });
  assert.equal(t.data.paid, 1500); assert.equal(t.data.change, 0);
  const tr = await s({ method: 'transferencia', items: [{ product_id: pan.id, qty: 1, discount: 300 }] });
  assert.equal(tr.data.total, 1200);
});

test('dos ventas simultáneas de la última unidad: solo una se concreta', async () => {
  const body = { method: 'tarjeta', items: [{ product_id: escasa.id, qty: 1 }] };
  const rs = await Promise.all([api('POST', '/api/sales', body, { tok: null }), api('POST', '/api/sales', body, { tok: null })]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal((await pool.query('SELECT stock FROM products WHERE id=$1', [escasa.id])).rows[0].stock, 0);
});

test('anular: devuelve stock, queda registrado quién, y no se anula dos veces', async () => {
  const s = (await api('POST', '/api/sales', { method: 'efectivo', paid: 2000, items: [{ product_id: pan.id, qty: 1 }] }, { tok: null })).data;
  const before = (await pool.query('SELECT stock FROM products WHERE id=$1', [pan.id])).rows[0].stock;
  assert.equal((await api('POST', `/api/sales/${s.id}/void`, { reason: 'Error al cobrar' }, { tok: null })).status, 401);
  assert.equal((await api('POST', `/api/sales/${s.id}/void`, { reason: 'Error al cobrar' })).status, 200);
  assert.equal((await pool.query('SELECT stock FROM products WHERE id=$1', [pan.id])).rows[0].stock, before + 1);
  assert.equal((await pool.query('SELECT voided_by FROM sales WHERE id=$1', [s.id])).rows[0].voided_by, 'Isa');
  assert.equal((await api('POST', `/api/sales/${s.id}/void`, {})).status, 409);
});

test('caja: solo el efectivo entra; saldos por día; retiro con "queda" y motivo', async () => {
  // ayer: se agregaron 120.000 de cambio
  await pool.query(`INSERT INTO cash_moves(created_at,type,amount,left_in_cash,reason,admin_name) VALUES (now() - interval '1 day','ingreso',120000,120000,'Fondo','Isa')`);
  let st = (await api('GET', '/api/cash/state', undefined, { tok: null })).data;
  const [antier, ayer, hoy] = st.dias;
  assert.equal(antier.final, 0); assert.equal(ayer.final, 120000); assert.equal(hoy.inicio, 120000);
  // hoy: venta efectivo 6.700 (tarjeta y transferencia no cuentan) y la anulada de 1.500 suma y resta
  assert.equal(hoy.ventas, 6700 + 1500); assert.equal(hoy.anulaciones, 1500);
  assert.equal(hoy.final, 120000 + 6700); assert.equal(st.en_caja, 126700);
  assert.equal(hoy.tarjeta, 1500 + 1000); assert.equal(hoy.transferencia, 1200);

  assert.equal((await api('POST', '/api/cash/retiro', { mode: 'queda', value: 80000 }, { tok: null })).status, 401);
  assert.equal((await api('POST', '/api/cash/retiro', { mode: 'queda', value: 80000 })).status, 400, 'sin motivo');
  assert.equal((await api('POST', '/api/cash/retiro', { mode: 'saco', value: 999999, reason: 'x' })).data.error, 'sin_fondos');
  const r = await api('POST', '/api/cash/retiro', { mode: 'queda', value: 80000, reason: 'Retiro de los dueños' });
  assert.equal(r.status, 200);
  assert.equal(r.data.amount, 46700); assert.equal(r.data.left_in_cash, 80000); assert.equal(r.data.admin_name, 'Isa');
  st = (await api('GET', '/api/cash/state', undefined, { tok: null })).data;
  assert.equal(st.en_caja, 80000); assert.equal(st.ultimo_retiro.reason, 'Retiro de los dueños'); assert.equal(st.dias_desde_retiro, 0);
  const ing = await api('POST', '/api/cash/ingreso', { amount: 20000, reason: 'Más monedas' });
  assert.equal(ing.data.left_in_cash, 100000);
  const cnt = await api('POST', '/api/cash/count', { counted: 99000 }, { tok: null });
  assert.equal(cnt.data.diff, -1000);
  const mv = (await api('GET', '/api/cash/moves', undefined, { tok: null })).data;
  assert.deepEqual(mv.map(m => m.type).sort(), ['conteo', 'ingreso', 'ingreso', 'retiro']);
});

test('retiro concurrente: no se puede sacar dos veces el mismo dinero', async () => {
  const body = { mode: 'saco', value: 70000, reason: 'Prueba' };
  const rs = await Promise.all([api('POST', '/api/cash/retiro', body), api('POST', '/api/cash/retiro', body)]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 400]);
});

test('reportes: por medio de pago, descuentos, ganancia, por producto', async () => {
  const none = await api('GET', '/api/reports/summary?period=hoy', undefined, { tok: null });
  assert.equal(none.status, 401);
  const r = (await api('GET', '/api/reports/summary?period=hoy')).data;
  // ventas ok: 6.700 efectivo; tarjeta 1.500 + 1.000 (la última unidad de Escasa); transferencia 1.200
  assert.equal(r.por_metodo.efectivo.total, 6700);
  assert.equal(r.por_metodo.transferencia.total, 1200);
  assert.equal(r.por_metodo.tarjeta.total, 1500 + 1000);
  assert.equal(r.resumen.total, 6700 + 1500 + 1200 + 1000);
  assert.equal(r.resumen.descuentos, 500 + 300);
  assert.equal(r.resumen.anuladas, 1);
  assert.ok(r.por_dia.length === 1 && r.por_producto.find(p => p.name === 'Pan francés').unidades >= 4);
  assert.equal((await api('GET', '/api/reports/summary?period=rango&from=2020-01-01&to=2020-01-31')).data.resumen.total, 0);
  assert.equal((await api('GET', '/api/reports/summary?period=nada')).status, 400);
  const csv = await api('GET', '/api/reports/sales.csv?period=hoy');
  assert.match(csv.data.toString(), /Venta N°/);
});

test('Excel: plantilla → vista previa → importar sumando o reemplazando stock', async () => {
  const tpl = await api('GET', '/api/products/template.xlsx', undefined, { tok: null });
  assert.equal(tpl.status, 200);
  const tw = new ExcelJS.Workbook();
  await tw.xlsx.load(tpl.data);
  assert.equal(tw.worksheets[0].getRow(1).getCell(1).value, 'Nombre');
  assert.equal(tw.worksheets[0].getRow(2).getCell(1).value, 'Cúpula Margarita');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Productos');
  ws.addRow(['Nombre', 'Precio', 'Costo', 'Stock', 'Categoría', 'Emoji']);
  ws.addRow(['Pan francés', 1500, 900, 40, 'Panadería', '🍞']);
  ws.addRow(['Leche entera 1L', 4200, 3500, 24, 'Lácteos', '🥛']);
  ws.addRow(['Pan francés', '$ 1.600', 950, 20, 'Panadería', '🍞']); // existente, precio en texto colombiano
  ws.addRow(['', '', '', '', '', '']);
  ws.addRow(['Sin precio negativo', -5, 0, 1, '', '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const pv = await api('POST', '/api/products/parse', buf, { raw: true });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  const by = n => pv.data.rows.find(r => r.name === n);
  const pan2 = pv.data.rows.filter(r => r.name === 'Pan francés');
  assert.equal(pan2.length, 2); assert.equal(pan2[1].error, 'Nombre repetido en el archivo');
  assert.equal(pan2[0].estado, 'actualiza'); assert.equal(by('Leche entera 1L').estado, 'nuevo');
  assert.equal(by('Sin precio negativo').estado, 'error');
  const ok = pv.data.rows.filter(r => r.estado !== 'error');
  const before = (await pool.query(`SELECT stock FROM products WHERE name='Pan francés'`)).rows[0].stock;
  const done = await api('POST', '/api/products/bulk', { rows: ok, stock_mode: 'sumar' });
  assert.deepEqual(done.data, { created: 1, updated: 1 });
  const after = (await pool.query(`SELECT stock, price FROM products WHERE name='Pan francés'`)).rows[0];
  assert.equal(after.stock, before + 40); // suma las 40 de la plantilla; la fila repetida (20) se descartó
  assert.equal(after.price, 1500);
});

test('ajustes: valores de cambio editables solo por administrador', async () => {
  assert.equal((await api('PUT', '/api/settings', { cambio_opciones: [50000] }, { tok: null })).status, 401);
  const s = await api('PUT', '/api/settings', { cambio_opciones: [90000, 100000, 80000, 80000], dias_retiro: 15 });
  assert.deepEqual(s.data.cambio_opciones, [100000, 90000, 80000]);
  assert.equal((await api('PUT', '/api/settings', { cambio_opciones: ['abc'] })).status, 400);
});

test('copia de seguridad JSON no incluye PIN', async () => {
  const b = await api('GET', '/api/backup');
  const txt = JSON.stringify(b.data);
  assert.ok(!txt.includes('pin_hash') && !txt.includes('scrypt'));
  assert.ok(b.data.sales.length > 0 && b.data.admins.length === 2);
});

test('foto del producto: solo el administrador la cambia, se valida por contenido y la versión nunca se repite', async () => {
  const p = (await api('POST', '/api/products', { name: 'Con foto', price: 5000, stock: 3 })).data;
  const png = n => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(n, 7)]);
  const put = (body, ctype = 'image/png', tok = token) => api('PUT', `/api/products/${p.id}/image`, body, { raw: true, ctype, tok });
  assert.equal((await put(png(300), 'image/png', null)).status, 401, 'sin PIN');
  assert.equal((await put(Buffer.from('<html>hola</html>'.repeat(20)))).status, 400, 'HTML disfrazado de PNG');
  assert.equal((await put(png(300), 'text/plain')).status, 400, 'tipo no permitido');
  assert.equal((await put(png(1.2e6))).status, 413, 'más de 1 MB');
  assert.equal((await put(png(10))).status, 400, 'demasiado pequeña para ser una imagen');
  const a = await put(png(300));
  assert.equal(a.status, 200); assert.ok(a.data.image_ver > 0);
  const lista = (await api('GET', '/api/products', undefined, { tok: null })).data.find(x => x.id === p.id);
  assert.equal(lista.image_ver, a.data.image_ver);
  const res = await fetch(`${base}/api/products/${p.id}/image?v=${a.data.image_ver}`);
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/); assert.equal((await res.arrayBuffer()).byteLength, 308);
  const b = await put(png(400));
  assert.ok(b.data.image_ver > a.data.image_ver, 'cada cambio trae una versión nueva (el navegador no muestra la foto vieja)');
  assert.equal((await api('DELETE', `/api/products/${p.id}/image`, undefined, { tok: null })).status, 401);
  assert.equal((await api('DELETE', `/api/products/${p.id}/image`)).data.image_ver, 0);
  assert.equal((await fetch(`${base}/api/products/${p.id}/image`)).status, 404);
  const c = await put(png(300));
  assert.ok(c.data.image_ver > b.data.image_ver, 'tras borrar y volver a subir la versión sigue creciendo');
  assert.equal((await put(png(300), 'image/png')).status, 200);
  assert.equal((await api('PUT', `/api/products/999999/image`, png(300), { raw: true, ctype: 'image/png' })).status, 404);
});
