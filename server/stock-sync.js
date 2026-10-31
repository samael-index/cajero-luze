'use strict';
/*
 * Stock compartido con "Control de Stock" (tabla public.candles en la nube).
 * La nube es la fuente del stock; la caja vende con su copia local y funciona sin internet.
 *
 *  1. Subir: cada movimiento local de stock (venta, anulación, carga...) se aplica en la nube como un
 *     CAMBIO (-2), no como una cantidad, con una clave única por movimiento: reintentar tras un corte no
 *     descuenta dos veces (función public.caja_aplicar_movimientos, ver supabase/compartir-stock.sql).
 *  2. Bajar: se trae el catálogo y el stock. Stock local = stock de la nube + lo vendido que aún no subió.
 *  3. Precio: la caja manda; si un producto tiene precio local, se escribe en candles.price.
 */
const TIPO = { venta: 'venta', anulacion: 'devolución', carga: 'ingreso', ajuste: 'ajuste manual', importacion: 'ajuste manual' };
const NOTA = { venta: 'Venta N°', anulacion: 'Anulación de la venta N°' };
const BATCH = 200;

function createStockSync({ local, storeId }) {
  async function available(c) {
    const { rows: [r] } = await c.query(
      `SELECT to_regclass('public.candles') IS NOT NULL AS tabla,
              to_regprocedure('public.caja_aplicar_movimientos(text,jsonb,text)') IS NOT NULL AS funcion,
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='candles' AND column_name='price') AS precio`);
    return r.tabla && r.funcion && r.precio;
  }

  async function push(c) {
    for (;;) {
      const { rows } = await local.query(
        `SELECT m.id, m.delta, m.reason, m.sale_id, p.remote_id
           FROM stock_moves m JOIN products p ON p.id = m.product_id
          WHERE NOT m.remote_pushed AND p.remote_id IS NOT NULL ORDER BY m.id LIMIT ${BATCH}`);
      if (!rows.length) return;
      for (const m of rows) {
        const nota = m.sale_id ? `${NOTA[m.reason] || 'Venta N°'} ${m.sale_id}` : `Caja (${m.reason})`;
        await c.query('SELECT public.caja_aplicar_movimientos($1, $2::jsonb, $3)',
          [`${storeId}:move:${m.id}`, JSON.stringify([{ candle_id: Number(m.remote_id), delta: m.delta, tipo: TIPO[m.reason] || 'ajuste manual', nota }]), 'caja']);
        await local.query('UPDATE stock_moves SET remote_pushed = true WHERE id = $1', [m.id]);
      }
    }
  }

  async function pull(c) {
    const { rows: remote } = await c.query('SELECT id, name, category, stock, price FROM public.candles');
    const t = await local.connect();
    try {
      await t.query('BEGIN');
      const { rows: prods } = await t.query('SELECT id, remote_id, name, category, stock, price FROM products WHERE active ORDER BY id FOR UPDATE');
      const pend = new Map((await t.query('SELECT product_id, sum(delta)::int AS d FROM stock_moves WHERE NOT remote_pushed GROUP BY 1')).rows.map(r => [Number(r.product_id), r.d]));
      const byRemote = new Map(prods.filter(p => p.remote_id).map(p => [Number(p.remote_id), p]));
      const byName = new Map(prods.filter(p => !p.remote_id).map(p => [p.name.toLowerCase(), p]));
      const seen = new Set();
      for (const r of remote) {
        seen.add(Number(r.id));
        const name = String(r.name).trim();
        const category = String(r.category || '').slice(0, 40);
        let p = byRemote.get(Number(r.id));
        let pending = 0;
        if (!p) {
          p = byName.get(name.toLowerCase());
          if (p) {
            // primer enlace: lo que la caja tenía antes de enlazarse ya no cuenta como pendiente
            await t.query('UPDATE products SET remote_id = $2 WHERE id = $1', [p.id, r.id]);
            await t.query('UPDATE stock_moves SET remote_pushed = true WHERE product_id = $1', [p.id]);
          }
        } else pending = pend.get(Number(p.id)) || 0;
        const stock = Math.max(0, Math.round(Number(r.stock)) + pending);
        await t.query('SAVEPOINT s');
        try {
          if (!p) {
            const price = r.price == null ? 0 : Math.round(Number(r.price));
            const { rows: [n] } = await t.query(
              'INSERT INTO products(name, price, stock, category, remote_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, price, stock, category, r.id]);
            if (stock > 0) await t.query(`INSERT INTO stock_moves(product_id, delta, reason, by, remote_pushed) VALUES ($1,$2,'sistema','Control de Stock',true)`, [n.id, stock]);
            continue;
          }
          const sets = [], vals = [p.id];
          const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
          if (stock !== p.stock) set('stock', stock);
          if (category !== p.category) set('category', category);
          if (name !== p.name) set('name', name);
          if (r.price != null && Number(p.price) === 0) set('price', Math.round(Number(r.price)));
          if (!sets.length) continue;
          await t.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
          if (stock !== p.stock) await t.query(`INSERT INTO stock_moves(product_id, delta, reason, by, remote_pushed) VALUES ($1,$2,'sistema','Control de Stock',true)`, [p.id, stock - p.stock]);
        } catch (e) { await t.query('ROLLBACK TO s'); }   // p. ej. otro producto ya usa ese nombre: se omite esa fila
      }
      // si desaparece del sistema de stock, deja de ofrecerse en la caja (no se borra: conserva su historial)
      if (remote.length) {
        for (const p of prods) if (p.remote_id && !seen.has(Number(p.remote_id))) await t.query('UPDATE products SET active = false, updated_at = now() WHERE id = $1', [p.id]);
      }
      await t.query('COMMIT');
    } catch (e) { await t.query('ROLLBACK').catch(() => {}); throw e; } finally { t.release(); }
    return remote;
  }

  async function pushPrices(c, remote) {
    const rp = new Map(remote.map(r => [Number(r.id), r.price == null ? null : Math.round(Number(r.price))]));
    const { rows } = await local.query('SELECT remote_id, price FROM products WHERE active AND remote_id IS NOT NULL AND price > 0');
    for (const p of rows) {
      const id = Number(p.remote_id);
      if (rp.has(id) && rp.get(id) !== Number(p.price)) await c.query('UPDATE public.candles SET price = $2 WHERE id = $1', [id, p.price]);
    }
  }

  // Devuelve false si la nube no tiene preparado el stock compartido (no es un error: solo no se usa).
  async function run(c) {
    if (!(await available(c))) return false;
    await push(c);
    const remote = await pull(c);
    await pushPrices(c, remote);
    return true;
  }
  return { run };
}

module.exports = { createStockSync };
