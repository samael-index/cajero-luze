'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const pg = require('pg');
const ExcelJS = require('exceljs');

// BIGINT (20) y NUMERIC (1700) llegan como texto por defecto; los montos son pesos enteros (< 2^53).
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

const TZ = process.env.TZ_NEGOCIO || 'America/Bogota';
if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(TZ)) throw new Error('TZ_NEGOCIO no es una zona horaria válida'); // se usa dentro de SQL
const SESSION_MINUTES = 10; // el modo administrador se cierra tras 10 min sin usarse
const METHODS = ['efectivo', 'tarjeta', 'transferencia'];
const DEFAULT_SETTINGS = {
  negocio: 'Mi tienda',
  cambio_opciones: [100000, 80000],
  dias_retiro: 15,
  stock_bajo: 5,
  motivos_retiro: ['Retiro de los dueños', 'Pago a proveedor', 'Gasto del local']
};

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (msg, code = 'invalido') => new HttpError(400, code, msg);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- utilidades ---------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}
function checkPin(pin, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const got = crypto.scryptSync(pin, salt, 32);
  const exp = Buffer.from(hash, 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}
const isInt = v => Number.isSafeInteger(v);
function intField(v, name, { min = 0, max = 1e12 } = {}) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (!isInt(n) || n < min || n > max) throw bad(`${name} no es válido`);
  return n;
}
function textField(v, name, { max = 120, required = false } = {}) {
  const s = String(v ?? '').trim();
  if (required && !s) throw bad(`Falta ${name}`);
  if (s.length > max) throw bad(`${name} es muy largo`);
  return s;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parsePesos(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'object' && v.result !== undefined) return parsePesos(v.result);
  const s = String(v).replace(/[^\d.,-]/g, '');
  return Math.round(parseFloat(s.replace(/\./g, '').replace(',', '.'))) || 0;
}

function createApp({ pool, publicDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    });
    next();
  });
  app.use(express.json({ limit: '12mb' }));
  const rawXlsx = express.raw({ type: '*/*', limit: '15mb' });

  /* ---------- configuración ---------- */
  async function getSettings(db = pool) {
    const { rows } = await db.query('SELECT key, value FROM settings');
    const s = { ...DEFAULT_SETTINGS };
    for (const r of rows) s[r.key] = r.value;
    return s;
  }

  /* ---------- sesión de administrador ---------- */
  async function adminFrom(req) {
    const token = req.get('x-admin-token');
    if (!token) return null;
    const { rows } = await pool.query(
      `UPDATE sessions SET expires_at = now() + make_interval(mins => $2)
        WHERE token_hash = $1 AND expires_at > now()
        RETURNING admin_id AS id, admin_name AS name`, [sha256(token), SESSION_MINUTES]);
    return rows[0] || null;
  }
  const requireAdmin = wrap(async (req, res, next) => {
    const a = await adminFrom(req);
    if (!a) throw new HttpError(401, 'admin_required', 'Se necesita el PIN de administrador');
    req.admin = a;
    next();
  });

  const fails = new Map(); // intentos fallidos de PIN por administrador (en memoria)
  async function createSession(admin) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    await pool.query(
      `INSERT INTO sessions(token_hash, admin_id, admin_name, expires_at)
       VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
      [sha256(token), admin.id, admin.name, SESSION_MINUTES]);
    return token;
  }

  /* ---------- arranque de la pantalla ---------- */
  app.get('/api/health', wrap(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  app.get('/api/bootstrap', wrap(async (req, res) => {
    const [settings, products, admins] = await Promise.all([
      getSettings(),
      pool.query(`SELECT id, name, price, stock, category, emoji FROM products WHERE active ORDER BY name`),
      pool.query('SELECT id, name FROM admins ORDER BY id')
    ]);
    res.json({ settings, products: products.rows, admins: admins.rows, needs_setup: admins.rows.length === 0 });
  }));

  /* ---------- administradores y PIN ---------- */
  const pinField = v => {
    const pin = String(v ?? '');
    if (!/^\d{4,8}$/.test(pin)) throw bad('El PIN debe tener de 4 a 8 números');
    return pin;
  };

  app.post('/api/setup', wrap(async (req, res) => {
    const name = textField(req.body.name, 'el nombre', { max: 40, required: true });
    const pin = pinField(req.body.pin);
    const { rows } = await pool.query(
      `INSERT INTO admins(name, pin_hash) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM admins) RETURNING id, name`,
      [name, hashPin(pin)]);
    if (!rows[0]) throw new HttpError(409, 'ya_configurado', 'Ya existe un administrador');
    res.json({ token: await createSession(rows[0]), admin: rows[0] });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const id = intField(req.body.admin_id, 'el administrador', { min: 1 });
    const f = fails.get(id);
    if (f && f.until > Date.now()) {
      throw new HttpError(429, 'bloqueado', `Demasiados intentos. Espere ${Math.ceil((f.until - Date.now()) / 1000)} segundos`);
    }
    const { rows } = await pool.query('SELECT id, name, pin_hash FROM admins WHERE id = $1', [id]);
    const a = rows[0];
    if (!a || !/^\d{4,8}$/.test(String(req.body.pin ?? '')) || !checkPin(String(req.body.pin), a.pin_hash)) {
      const n = (f ? f.n : 0) + 1;
      fails.set(id, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
      if (n >= 5) fails.set(id, { n: 0, until: Date.now() + 60000 });
      throw new HttpError(401, 'pin_incorrecto', 'PIN incorrecto');
    }
    fails.delete(id);
    res.json({ token: await createSession(a), admin: { id: a.id, name: a.name } });
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    const t = req.get('x-admin-token');
    if (t) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(t)]);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', wrap(async (req, res) => {
    const a = await adminFrom(req);
    res.json({ admin: a });
  }));

  app.post('/api/admins', requireAdmin, wrap(async (req, res) => {
    const name = textField(req.body.name, 'el nombre', { max: 40, required: true });
    const pin = pinField(req.body.pin);
    try {
      const { rows } = await pool.query('INSERT INTO admins(name, pin_hash) VALUES ($1,$2) RETURNING id, name', [name, hashPin(pin)]);
      res.json(rows[0]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'nombre_repetido', 'Ya hay un administrador con ese nombre');
      throw e;
    }
  }));

  app.put('/api/admins/:id/pin', requireAdmin, wrap(async (req, res) => {
    const id = intField(req.params.id, 'el administrador', { min: 1 });
    const pin = pinField(req.body.pin);
    if (id !== req.admin.id) throw new HttpError(403, 'solo_propio', 'Cada administrador cambia su propio PIN');
    const { rows } = await pool.query('SELECT pin_hash FROM admins WHERE id = $1', [id]);
    if (!rows[0] || !checkPin(String(req.body.old_pin ?? ''), rows[0].pin_hash)) throw new HttpError(401, 'pin_incorrecto', 'El PIN actual no es correcto');
    await pool.query('UPDATE admins SET pin_hash = $2 WHERE id = $1', [id, hashPin(pin)]);
    res.json({ ok: true });
  }));

  app.delete('/api/admins/:id', requireAdmin, wrap(async (req, res) => {
    const id = intField(req.params.id, 'el administrador', { min: 1 });
    if (id === req.admin.id) throw new HttpError(409, 'no_a_si_mismo', 'No puede eliminarse a sí mismo');
    await pool.query('DELETE FROM admins WHERE id = $1', [id]);
    res.json({ ok: true });
  }));

  /* ---------- ajustes ---------- */
  app.put('/api/settings', requireAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const out = {};
    if ('negocio' in b) out.negocio = textField(b.negocio, 'el nombre del negocio', { max: 60, required: true });
    if ('dias_retiro' in b) out.dias_retiro = intField(b.dias_retiro, 'los días de retiro', { min: 1, max: 365 });
    if ('stock_bajo' in b) out.stock_bajo = intField(b.stock_bajo, 'el stock bajo', { min: 0, max: 100000 });
    if ('cambio_opciones' in b) {
      if (!Array.isArray(b.cambio_opciones) || b.cambio_opciones.length > 8) throw bad('Los valores de cambio no son válidos');
      out.cambio_opciones = [...new Set(b.cambio_opciones.map(v => intField(v, 'el valor de cambio', { min: 0, max: 1e9 })))].sort((x, y) => y - x);
    }
    if ('motivos_retiro' in b) {
      if (!Array.isArray(b.motivos_retiro) || b.motivos_retiro.length > 12) throw bad('Los motivos no son válidos');
      out.motivos_retiro = b.motivos_retiro.map(m => textField(m, 'el motivo', { max: 60, required: true }));
    }
    for (const [k, v] of Object.entries(out)) {
      await pool.query(`INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
    }
    res.json(await getSettings());
  }));

  /* ---------- productos ---------- */
  function productBody(b) {
    return {
      name: textField(b.name, 'el nombre', { max: 80, required: true }),
      price: intField(b.price, 'el precio', { min: 0, max: 1e9 }),
      cost: intField(b.cost ?? 0, 'el costo', { min: 0, max: 1e9 }),
      stock: intField(b.stock ?? 0, 'el stock', { min: 0, max: 1e7 }),
      category: textField(b.category, 'la categoría', { max: 40 }),
      emoji: textField(b.emoji, 'el dibujo', { max: 8 })
    };
  }
  const nameTaken = e => { if (e.code === '23505') throw new HttpError(409, 'nombre_repetido', 'Ya existe un producto con ese nombre'); throw e; };

  app.get('/api/products', wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT id, name, price, cost, stock, category, emoji FROM products WHERE active ORDER BY name`);
    // el costo solo lo ve un administrador
    const a = await adminFrom(req);
    res.json(rows.map(r => (a ? r : { ...r, cost: undefined })));
  }));

  app.post('/api/products', requireAdmin, wrap(async (req, res) => {
    const p = productBody(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(
        `INSERT INTO products(name,price,cost,stock,category,emoji) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [p.name, p.price, p.cost, p.stock, p.category, p.emoji]);
      if (p.stock > 0) await c.query(`INSERT INTO stock_moves(product_id,delta,reason,by) VALUES ($1,$2,'carga',$3)`, [rows[0].id, p.stock, req.admin.name]);
      await c.query('COMMIT');
      res.json(rows[0]);
    } catch (e) { await c.query('ROLLBACK'); nameTaken(e); } finally { c.release(); }
  }));

  app.put('/api/products/:id', requireAdmin, wrap(async (req, res) => {
    const id = intField(req.params.id, 'el producto', { min: 1 });
    const p = productBody(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [old] } = await c.query('SELECT stock FROM products WHERE id=$1 AND active FOR UPDATE', [id]);
      if (!old) throw new HttpError(404, 'no_existe', 'El producto no existe');
      const { rows } = await c.query(
        `UPDATE products SET name=$2, price=$3, cost=$4, stock=$5, category=$6, emoji=$7, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, p.name, p.price, p.cost, p.stock, p.category, p.emoji]);
      if (p.stock !== old.stock) await c.query(`INSERT INTO stock_moves(product_id,delta,reason,by) VALUES ($1,$2,'ajuste',$3)`, [id, p.stock - old.stock, req.admin.name]);
      await c.query('COMMIT');
      res.json(rows[0]);
    } catch (e) { await c.query('ROLLBACK'); nameTaken(e); } finally { c.release(); }
  }));

  app.delete('/api/products/:id', requireAdmin, wrap(async (req, res) => {
    const id = intField(req.params.id, 'el producto', { min: 1 });
    await pool.query('UPDATE products SET active=false, updated_at=now() WHERE id=$1', [id]);
    res.json({ ok: true });
  }));

  // Cargar unidades que llegaron: lo puede hacer cualquier trabajador.
  app.post('/api/products/:id/stock', wrap(async (req, res) => {
    const id = intField(req.params.id, 'el producto', { min: 1 });
    const qty = intField(req.body.qty, 'la cantidad', { min: 1, max: 1e6 });
    const by = (await adminFrom(req))?.name || null;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('UPDATE products SET stock = stock + $2, updated_at=now() WHERE id=$1 AND active RETURNING id, name, stock', [id, qty]);
      if (!rows[0]) throw new HttpError(404, 'no_existe', 'El producto no existe');
      await c.query(`INSERT INTO stock_moves(product_id,delta,reason,by) VALUES ($1,$2,'carga',$3)`, [id, qty, by]);
      await c.query('COMMIT');
      res.json(rows[0]);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

  /* ---------- Excel: plantilla, exportar, importar ---------- */
  const COLS = [
    ['Nombre', 'name', 34], ['Precio', 'price', 14], ['Costo', 'cost', 14],
    ['Stock', 'stock', 10], ['Categoría', 'category', 20], ['Emoji', 'emoji', 8]
  ];
  async function sendXlsx(res, filename, rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    ws.columns = COLS.map(([header, key, width]) => ({ header, key, width }));
    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(r));
    ws.getColumn('price').numFmt = '#,##0'; ws.getColumn('cost').numFmt = '#,##0';
    const buf = await wb.xlsx.writeBuffer();
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(Buffer.from(buf));
  }
  app.get('/api/products/template.xlsx', wrap((req, res) => sendXlsx(res, 'plantilla-productos.xlsx', [
    { name: 'Pan francés', price: 1500, cost: 900, stock: 40, category: 'Panadería', emoji: '🍞' },
    { name: 'Leche entera 1L', price: 4200, cost: 3500, stock: 24, category: 'Lácteos', emoji: '🥛' }
  ])));
  app.get('/api/products/export.xlsx', requireAdmin, wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT name, price, cost, stock, category, emoji FROM products WHERE active ORDER BY name');
    await sendXlsx(res, `productos-${new Date().toISOString().slice(0, 10)}.xlsx`, rows);
  }));

  const HEADER_ALIAS = {
    name: ['nombre', 'producto', 'articulo', 'descripcion'],
    price: ['precio', 'precioventa', 'preciodeventa', 'pvp', 'valor'],
    cost: ['costo', 'preciocosto', 'costounitario'],
    stock: ['stock', 'cantidad', 'existencias', 'inventario', 'unidades'],
    category: ['categoria', 'grupo', 'tipo'],
    emoji: ['emoji', 'dibujo', 'icono']
  };
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const cellText = v => (v && typeof v === 'object' ? (v.richText ? v.richText.map(t => t.text).join('') : v.text ?? v.result ?? '') : v ?? '');

  app.post('/api/products/parse', requireAdmin, rawXlsx, wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('No llegó ningún archivo');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.body); } catch { throw bad('Ese archivo no es un Excel (.xlsx) válido'); }
    const ws = wb.worksheets[0];
    if (!ws) throw bad('El Excel no tiene hojas');
    const head = {};
    ws.getRow(1).eachCell((cell, n) => {
      const h = norm(cellText(cell.value));
      for (const [key, aliases] of Object.entries(HEADER_ALIAS)) if (aliases.includes(h)) head[key] = n;
    });
    if (!head.name || !head.price) throw bad('Faltan las columnas "Nombre" y "Precio" en la primera fila');
    const existing = new Map((await pool.query('SELECT lower(name) AS k FROM products WHERE active')).rows.map(r => [r.k, true]));
    const seen = new Set();
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = k => (head[k] ? cellText(row.getCell(head[k]).value) : '');
      const name = String(get('name')).trim();
      if (!name && !String(get('price')).trim()) continue; // fila vacía
      const item = { fila: r, name, price: parsePesos(get('price')), cost: parsePesos(get('cost')), stock: parsePesos(get('stock')), category: String(get('category')).trim().slice(0, 40), emoji: String(get('emoji')).trim().slice(0, 8) };
      let error = null;
      if (!name) error = 'Falta el nombre';
      else if (name.length > 80) error = 'Nombre muy largo';
      else if (item.price < 0 || item.cost < 0 || item.stock < 0) error = 'Hay números negativos';
      else if (item.price > 1e9 || item.cost > 1e9 || item.stock > 1e7) error = 'Un número es demasiado grande';
      else if (seen.has(name.toLowerCase())) error = 'Nombre repetido en el archivo';
      seen.add(name.toLowerCase());
      rows.push({ ...item, estado: error ? 'error' : existing.has(name.toLowerCase()) ? 'actualiza' : 'nuevo', error });
      if (rows.length > 20000) throw bad('El archivo tiene más de 20.000 productos; divídalo en partes');
    }
    if (!rows.length) throw bad('El Excel no tiene productos para importar');
    res.json({ rows });
  }));

  app.post('/api/products/bulk', requireAdmin, wrap(async (req, res) => {
    const mode = req.body.stock_mode === 'sumar' ? 'sumar' : 'reemplazar';
    const items = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!items.length || items.length > 20000) throw bad('No hay productos para importar');
    const c = await pool.connect();
    let created = 0, updated = 0;
    try {
      await c.query('BEGIN');
      for (const raw of items) {
        const p = productBody(raw);
        const { rows: [old] } = await c.query('SELECT id, stock FROM products WHERE lower(name)=lower($1) AND active FOR UPDATE', [p.name]);
        if (old) {
          const stock = mode === 'sumar' ? old.stock + p.stock : p.stock;
          await c.query('UPDATE products SET price=$2, cost=$3, stock=$4, category=$5, emoji=$6, updated_at=now() WHERE id=$1', [old.id, p.price, p.cost, stock, p.category, p.emoji]);
          if (stock !== old.stock) await c.query(`INSERT INTO stock_moves(product_id,delta,reason,by) VALUES ($1,$2,'importacion',$3)`, [old.id, stock - old.stock, req.admin.name]);
          updated++;
        } else {
          const { rows: [n] } = await c.query('INSERT INTO products(name,price,cost,stock,category,emoji) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [p.name, p.price, p.cost, p.stock, p.category, p.emoji]);
          if (p.stock > 0) await c.query(`INSERT INTO stock_moves(product_id,delta,reason,by) VALUES ($1,$2,'importacion',$3)`, [n.id, p.stock, req.admin.name]);
          created++;
        }
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    res.json({ created, updated });
  }));

  /* ---------- ventas ---------- */
  app.post('/api/sales', wrap(async (req, res) => {
    const method = req.body.method;
    if (!METHODS.includes(method)) throw bad('Elija cómo paga el cliente');
    const lines = Array.isArray(req.body.items) ? req.body.items : [];
    if (!lines.length || lines.length > 200) throw bad('La cuenta está vacía');
    const want = new Map();
    for (const l of lines) {
      const pid = intField(l.product_id, 'el producto', { min: 1 });
      if (want.has(pid)) throw bad('Un producto está repetido en la cuenta');
      want.set(pid, { qty: intField(l.qty, 'la cantidad', { min: 1, max: 1e6 }), discount: intField(l.discount ?? 0, 'el descuento', { min: 0, max: 1e10 }) });
    }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: prods } = await c.query('SELECT id, name, price, cost, stock FROM products WHERE id = ANY($1) AND active ORDER BY id FOR UPDATE', [[...want.keys()]]);
      if (prods.length !== want.size) throw new HttpError(409, 'producto_no_existe', 'Un producto de la cuenta ya no existe');
      let subtotal = 0, discount = 0;
      const items = prods.map(p => {
        const { qty, discount: d } = want.get(p.id);
        if (p.stock < qty) throw new HttpError(409, 'sin_stock', `Solo quedan ${p.stock} de ${p.name}`);
        const gross = p.price * qty;
        if (d > gross) throw bad(`El descuento de ${p.name} es mayor que su valor`);
        subtotal += gross; discount += d;
        return { p, qty, d, line_total: gross - d };
      });
      const total = subtotal - discount;
      let paid = total, change = 0;
      if (method === 'efectivo') {
        paid = intField(req.body.paid, 'el pago', { min: 0, max: 1e12 });
        if (paid < total) throw bad(`Faltan $${total - paid} para completar el pago`, 'pago_insuficiente');
        change = paid - total;
      }
      const { rows: [sale] } = await c.query(
        `INSERT INTO sales(subtotal, discount, total, method, paid, change) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [subtotal, discount, total, method, paid, change]);
      for (const it of items) {
        await c.query(
          `INSERT INTO sale_items(sale_id, product_id, name, unit_price, cost, qty, discount, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [sale.id, it.p.id, it.p.name, it.p.price, it.p.cost, it.qty, it.d, it.line_total]);
        await c.query('UPDATE products SET stock = stock - $2, updated_at=now() WHERE id=$1', [it.p.id, it.qty]);
        await c.query(`INSERT INTO stock_moves(product_id,delta,reason,sale_id) VALUES ($1,$2,'venta',$3)`, [it.p.id, -it.qty, sale.id]);
      }
      await c.query('COMMIT');
      res.json(sale);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

  app.post('/api/sales/:id/void', requireAdmin, wrap(async (req, res) => {
    const id = intField(req.params.id, 'la venta', { min: 1 });
    const reason = textField(req.body.reason, 'el motivo', { max: 200 });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [s] } = await c.query('SELECT id, status FROM sales WHERE id=$1 FOR UPDATE', [id]);
      if (!s) throw new HttpError(404, 'no_existe', 'La venta no existe');
      if (s.status === 'anulada') throw new HttpError(409, 'ya_anulada', 'Esa venta ya estaba anulada');
      const { rows: items } = await c.query('SELECT product_id, qty FROM sale_items WHERE sale_id=$1 AND product_id IS NOT NULL ORDER BY product_id', [id]);
      for (const it of items) {
        await c.query('UPDATE products SET stock = stock + $2, updated_at=now() WHERE id=$1', [it.product_id, it.qty]);
        await c.query(`INSERT INTO stock_moves(product_id,delta,reason,sale_id,by) VALUES ($1,$2,'anulacion',$3,$4)`, [it.product_id, it.qty, id, req.admin.name]);
      }
      await c.query(`UPDATE sales SET status='anulada', voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`, [id, req.admin.name, reason]);
      await c.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

  /* ---------- reportes (solo administrador) ---------- */
  async function resolveRange(q) {
    const { rows: [{ today }] } = await pool.query(`SELECT (now() AT TIME ZONE $1)::date::text AS today`, [TZ]);
    const period = q.period || 'hoy';
    let from = null, to = null, fromTs = null, label;
    switch (period) {
      case 'hoy': from = today; to = addDays(today, 1); label = 'Hoy'; break;
      case 'ayer': from = addDays(today, -1); to = today; label = 'Ayer'; break;
      case '15d': from = addDays(today, -14); to = addDays(today, 1); label = 'Últimos 15 días'; break;
      case 'mes': from = today.slice(0, 8) + '01'; to = addDays(today, 1); label = 'Este mes'; break;
      case 'rango':
        if (!DATE_RE.test(q.from || '') || !DATE_RE.test(q.to || '') || q.from > q.to) throw bad('Las fechas no son válidas');
        from = q.from; to = addDays(q.to, 1); label = `Del ${q.from} al ${q.to}`; break;
      case 'retiro': {
        const { rows } = await pool.query(`SELECT max(created_at) AS t FROM cash_moves WHERE type='retiro'`);
        fromTs = rows[0].t; label = 'Desde el último retiro'; break;
      }
      case 'todo': label = 'Todo'; break;
      default: throw bad('Período no válido');
    }
    let toTs = null;
    if (from) {
      const { rows: [r] } = await pool.query(`SELECT ($1::date)::timestamp AT TIME ZONE $3 AS f, ($2::date)::timestamp AT TIME ZONE $3 AS t`, [from, to, TZ]);
      fromTs = r.f; toTs = r.t;
    }
    return { fromTs, toTs, label, today };
  }
  const inRange = `($1::timestamptz IS NULL OR s.created_at >= $1) AND ($2::timestamptz IS NULL OR s.created_at < $2)`;

  async function buildReport(q) {
    const r = await resolveRange(q);
    const p = [r.fromTs, r.toTs];
    const [tot, methods, days, prods, tickets] = await Promise.all([
      pool.query(`SELECT count(*) AS ventas, coalesce(sum(s.total),0) AS total, coalesce(sum(s.discount),0) AS descuentos,
                         coalesce(sum(s.subtotal),0) AS bruto,
                         (SELECT coalesce(sum(i.qty),0) FROM sale_items i JOIN sales s2 ON s2.id=i.sale_id WHERE s2.status='ok' AND ($1::timestamptz IS NULL OR s2.created_at >= $1) AND ($2::timestamptz IS NULL OR s2.created_at < $2)) AS unidades,
                         (SELECT coalesce(sum(i.line_total - i.cost*i.qty),0) FROM sale_items i JOIN sales s2 ON s2.id=i.sale_id WHERE s2.status='ok' AND i.cost>0 AND ($1::timestamptz IS NULL OR s2.created_at >= $1) AND ($2::timestamptz IS NULL OR s2.created_at < $2)) AS ganancia,
                         (SELECT count(*) FROM sales s3 WHERE s3.status='anulada' AND ($1::timestamptz IS NULL OR s3.created_at >= $1) AND ($2::timestamptz IS NULL OR s3.created_at < $2)) AS anuladas
                    FROM sales s WHERE s.status='ok' AND ${inRange}`, p),
      pool.query(`SELECT s.method, count(*) AS ventas, sum(s.total) AS total FROM sales s WHERE s.status='ok' AND ${inRange} GROUP BY s.method`, p),
      pool.query(`SELECT (s.created_at AT TIME ZONE '${TZ}')::date::text AS dia, count(*) AS ventas, sum(s.total) AS total,
                         coalesce(sum(s.total) FILTER (WHERE s.method='efectivo'),0) AS efectivo,
                         coalesce(sum(s.total) FILTER (WHERE s.method='tarjeta'),0) AS tarjeta,
                         coalesce(sum(s.total) FILTER (WHERE s.method='transferencia'),0) AS transferencia,
                         coalesce(sum(s.discount),0) AS descuentos
                    FROM sales s WHERE s.status='ok' AND ${inRange} GROUP BY 1 ORDER BY 1 DESC`, p),
      pool.query(`SELECT i.name, sum(i.qty) AS unidades, sum(i.line_total) AS total, sum(i.discount) AS descuentos
                    FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status='ok' AND ${inRange} GROUP BY i.name ORDER BY sum(i.line_total) DESC LIMIT 200`, p),
      pool.query(`SELECT s.id, s.created_at, s.subtotal, s.discount, s.total, s.method, s.paid, s.change, s.status, s.voided_by, s.void_reason,
                         (SELECT json_agg(json_build_object('name', i.name, 'qty', i.qty, 'unit_price', i.unit_price, 'discount', i.discount, 'line_total', i.line_total) ORDER BY i.id)
                            FROM sale_items i WHERE i.sale_id = s.id) AS items
                    FROM sales s WHERE ${inRange} ORDER BY s.created_at DESC LIMIT 300`, p)
    ]);
    const byMethod = { efectivo: { ventas: 0, total: 0 }, tarjeta: { ventas: 0, total: 0 }, transferencia: { ventas: 0, total: 0 } };
    methods.rows.forEach(m => { byMethod[m.method] = { ventas: m.ventas, total: m.total }; });
    return { label: r.label, resumen: tot.rows[0], por_metodo: byMethod, por_dia: days.rows, por_producto: prods.rows, ventas: tickets.rows };
  }
  app.get('/api/reports/summary', requireAdmin, wrap(async (req, res) => res.json(await buildReport(req.query))));

  app.get('/api/reports/sales.csv', requireAdmin, wrap(async (req, res) => {
    const r = await resolveRange(req.query);
    const { rows } = await pool.query(
      `SELECT s.id, to_char(s.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS fecha, to_char(s.created_at AT TIME ZONE '${TZ}', 'HH24:MI') AS hora,
              s.method, s.status, i.name, i.qty, i.unit_price, i.discount, i.line_total
         FROM sales s JOIN sale_items i ON i.sale_id = s.id WHERE ${inRange} ORDER BY s.created_at, i.id`, [r.fromTs, r.toTs]);
    const cell = v => `"${String(v).replace(/"/g, '""')}"`;
    const head = ['Venta N°', 'Fecha', 'Hora', 'Medio de pago', 'Estado', 'Producto', 'Cantidad', 'Precio', 'Descuento', 'Total línea'];
    const body = rows.map(x => [x.id, x.fecha, x.hora, x.method, x.status === 'ok' ? 'OK' : 'ANULADA', x.name, x.qty, x.unit_price, x.discount, x.line_total].map(cell).join(';'));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ventas.csv"' });
    res.send('﻿' + [head.map(cell).join(';'), ...body].join('\r\n'));
  }));

  /* ---------- caja (efectivo) ---------- */
  const CASH_EVENTS = `
    SELECT (created_at AT TIME ZONE $1)::date::text AS d, 'venta' AS k, total AS amt FROM sales WHERE method='efectivo'
    UNION ALL SELECT (voided_at AT TIME ZONE $1)::date::text, 'anulacion', total FROM sales WHERE method='efectivo' AND status='anulada'
    UNION ALL SELECT (created_at AT TIME ZONE $1)::date::text, type, amount FROM cash_moves`;
  const SIGN = { venta: 1, ingreso: 1, anulacion: -1, retiro: -1 };

  async function cashBalance(db) {
    const { rows } = await db.query(
      `SELECT coalesce(sum(CASE WHEN k IN ('venta','ingreso') THEN amt ELSE -amt END),0) AS bal FROM (${CASH_EVENTS}) e`, [TZ]);
    return rows[0].bal;
  }

  app.get('/api/cash/state', wrap(async (req, res) => {
    const { rows: [{ today }] } = await pool.query(`SELECT (now() AT TIME ZONE $1)::date::text AS today`, [TZ]);
    const dates = [addDays(today, -2), addDays(today, -1), today];
    const [ev, bymethod, last, since] = await Promise.all([
      pool.query(`SELECT d, k, sum(amt) AS amt FROM (${CASH_EVENTS}) e GROUP BY d, k`, [TZ]),
      pool.query(`SELECT (created_at AT TIME ZONE $1)::date::text AS d, method, sum(total) AS total FROM sales
                   WHERE status='ok' AND (created_at AT TIME ZONE $1)::date >= $2::date GROUP BY 1, 2`, [TZ, dates[0]]),
      pool.query(`SELECT created_at, amount, left_in_cash, reason, admin_name FROM cash_moves WHERE type='retiro' ORDER BY created_at DESC LIMIT 1`),
      pool.query(`SELECT coalesce(sum(total) FILTER (WHERE method='efectivo'),0) AS efectivo,
                         coalesce(sum(total) FILTER (WHERE method<>'efectivo'),0) AS otros
                    FROM sales WHERE status='ok' AND created_at > coalesce((SELECT max(created_at) FROM cash_moves WHERE type='retiro'), '-infinity')`)
    ]);
    const days = dates.map(date => {
      const get = k => ev.rows.filter(e => e.d === date && e.k === k).reduce((t, e) => t + e.amt, 0);
      const opening = ev.rows.filter(e => e.d < date).reduce((t, e) => t + SIGN[e.k] * e.amt, 0);
      const row = { fecha: date, inicio: opening, ventas: get('venta'), ingresos: get('ingreso'), anulaciones: get('anulacion'), retiros: get('retiro') };
      row.final = opening + row.ventas + row.ingresos - row.anulaciones - row.retiros;
      row.tarjeta = bymethod.rows.find(m => m.d === date && m.method === 'tarjeta')?.total || 0;
      row.transferencia = bymethod.rows.find(m => m.d === date && m.method === 'transferencia')?.total || 0;
      return row;
    });
    const settings = await getSettings();
    const lr = last.rows[0] || null;
    let diasDesde = null;
    if (lr) diasDesde = (await pool.query(`SELECT ($1::date - (($2::timestamptz) AT TIME ZONE $3)::date) AS n`, [today, lr.created_at, TZ])).rows[0].n;
    res.json({ today, en_caja: days[2].final, dias: days, ultimo_retiro: lr, dias_desde_retiro: diasDesde, dias_retiro: settings.dias_retiro,
      desde_retiro: since.rows[0] });
  }));

  app.get('/api/cash/moves', wrap(async (req, res) => {
    const limit = Math.min(intField(req.query.limit ?? 40, 'el límite', { min: 1, max: 200 }), 200);
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT id, created_at, type, amount, left_in_cash, reason, admin_name, NULL::bigint AS diff FROM cash_moves
         UNION ALL SELECT id, created_at, 'conteo', counted, expected, '', '', diff FROM cash_counts
       ) m ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  }));

  async function cashTx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(7001)'); // un solo retiro/ingreso a la vez
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  app.post('/api/cash/retiro', requireAdmin, wrap(async (req, res) => {
    const mode = req.body.mode === 'saco' ? 'saco' : 'queda';
    const value = intField(req.body.value, 'el valor', { min: 0, max: 1e12 });
    const reason = textField(req.body.reason, 'el motivo', { max: 120, required: true });
    res.json(await cashTx(async c => {
      const bal = await cashBalance(c);
      const amount = mode === 'queda' ? bal - value : value;
      if (amount <= 0) throw bad('No hay dinero para retirar con ese valor');
      if (amount > bal) throw bad(`No hay tanto dinero: en la caja hay $${bal}`, 'sin_fondos');
      const { rows } = await c.query(
        `INSERT INTO cash_moves(type, amount, left_in_cash, reason, admin_name) VALUES ('retiro',$1,$2,$3,$4) RETURNING *`,
        [amount, bal - amount, reason, req.admin.name]);
      return rows[0];
    }));
  }));

  app.post('/api/cash/ingreso', requireAdmin, wrap(async (req, res) => {
    const amount = intField(req.body.amount, 'el monto', { min: 1, max: 1e12 });
    const reason = textField(req.body.reason || 'Cambio / fondo', 'el motivo', { max: 120 });
    res.json(await cashTx(async c => {
      const bal = await cashBalance(c);
      const { rows } = await c.query(
        `INSERT INTO cash_moves(type, amount, left_in_cash, reason, admin_name) VALUES ('ingreso',$1,$2,$3,$4) RETURNING *`,
        [amount, bal + amount, reason, req.admin.name]);
      return rows[0];
    }));
  }));

  app.post('/api/cash/count', wrap(async (req, res) => {
    const counted = intField(req.body.counted, 'el conteo', { min: 0, max: 1e12 });
    const expected = await cashBalance(pool);
    const { rows } = await pool.query(`INSERT INTO cash_counts(expected, counted, diff) VALUES ($1,$2,$3) RETURNING *`, [expected, counted, counted - expected]);
    res.json(rows[0]);
  }));

  /* ---------- copia de seguridad en JSON (administrador) ---------- */
  app.get('/api/backup', requireAdmin, wrap(async (req, res) => {
    const tables = ['products', 'sales', 'sale_items', 'stock_moves', 'cash_moves', 'cash_counts', 'settings'];
    const out = { generado: new Date().toISOString(), version: 2 };
    for (const t of tables) out[t] = (await pool.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
    out.admins = (await pool.query('SELECT id, name, created_at FROM admins ORDER BY id')).rows; // sin PIN
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="caja-copia-${new Date().toISOString().slice(0, 10)}.json"` });
    res.send(JSON.stringify(out));
  }));

  /* ---------- pantalla ---------- */
  if (publicDir) app.use(express.static(publicDir, { index: 'index.html', etag: true, maxAge: 0, setHeaders: r => r.set('Cache-Control', 'no-cache') }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'no_existe', message: 'Ruta no encontrada' }));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalido', message: 'Datos mal formados' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'muy_grande', message: 'El archivo es demasiado grande' });
    console.error(err);
    res.status(500).json({ error: 'error_interno', message: 'Ocurrió un error en el servidor' });
  });
  return app;
}

async function migrate(pool) {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, JSON.stringify(v)]);
  }
}

module.exports = { createApp, migrate, TZ };
