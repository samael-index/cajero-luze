'use strict';
// Carga de golpe las fotos de una carpeta: el nombre del archivo es el nombre del producto (Tulipán.jpg, virgen grande.png...).
// Uso: npm run fotos -- <carpeta> [--probar]     (--probar solo muestra qué haría, no cambia nada)
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MAX = 1024 * 1024;
const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

function tipo(b) {   // por el contenido, igual que la caja
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const probar = args.includes('--probar');
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('Uso: npm run fotos -- <carpeta con las fotos> [--probar]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL en el archivo .env'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: prods } = await pool.query('SELECT id, name FROM products WHERE active');
    const byName = new Map();
    for (const p of prods) { const k = norm(p.name); byName.set(k, [...(byName.get(k) || []), p]); }

    const hechas = [], sinProducto = [], grandes = [], malas = [];
    const usados = new Map();
    for (const f of fs.readdirSync(dir).sort()) {
      const ext = path.extname(f).toLowerCase();
      if (!EXT.has(ext)) continue;
      const data = fs.readFileSync(path.join(dir, f));
      const hit = byName.get(norm(path.basename(f, path.extname(f))));
      if (!hit || hit.length !== 1) { sinProducto.push(f); continue; }
      const mime = tipo(data);
      if (!mime || data.length < 100) { malas.push(f); continue; }
      if (data.length > MAX) { grandes.push(`${f} (${(data.length / MAX).toFixed(1)} MB)`); continue; }
      const p = hit[0];
      if (usados.has(p.id)) { sinProducto.push(`${f} (ya hay otra foto para "${p.name}": ${usados.get(p.id)})`); continue; }
      usados.set(p.id, f);
      if (!probar) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`INSERT INTO product_images (product_id, mime, data) VALUES ($1,$2,$3)
                         ON CONFLICT (product_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`, [p.id, mime, data]);
          await c.query(`UPDATE products SET image_ver = nextval('image_seq'), updated_at = now() WHERE id = $1`, [p.id]);
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      }
      hechas.push(`${f}  ->  ${p.name}`);
    }

    console.log(`\n${probar ? 'PRUEBA (no se cambió nada). ' : ''}Fotos ${probar ? 'que se cargarían' : 'cargadas'}: ${hechas.length}`);
    hechas.forEach(x => console.log('  OK  ' + x));
    if (grandes.length) { console.log(`\nPesan más de 1 MB, redúzcalas y vuelva a correr (${grandes.length}):`); grandes.forEach(x => console.log('  ' + x)); }
    if (malas.length) { console.log(`\nNo son una imagen válida (${malas.length}):`); malas.forEach(x => console.log('  ' + x)); }
    if (sinProducto.length) { console.log(`\nSu nombre no coincide con ningún producto (${sinProducto.length}):`); sinProducto.forEach(x => console.log('  ' + x)); }
    const sin = prods.filter(p => !usados.has(p.id)).map(p => p.name);
    if (sin.length) console.log(`\nProductos que siguen sin foto de esta carpeta (${sin.length}): ${sin.join(', ')}`);
  } finally { await pool.end(); }
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
