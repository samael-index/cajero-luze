'use strict';
// Simulador mínimo de Supabase SOLO PARA PRUEBAS: inicio de sesión + lectura de vistas con los permisos reales
// de PostgreSQL (rol "authenticated" y claims del token). No reemplaza una prueba contra Supabase de verdad.
const http = require('http');
const { Pool, types } = require('pg');
types.setTypeParser(20, Number); types.setTypeParser(1700, Number);   // PostgREST entrega números JSON
types.setTypeParser(1082, v => v);                                     // date -> "2026-10-28"
types.setTypeParser(1114, v => v.replace(' ', 'T'));                   // timestamp -> "2026-10-28T21:38:23.760804"

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const USERS = { 'isa@ejemplo.com': 'clave-isa', 'intruso@ejemplo.com': 'clave-x' };

function start({ port, dbUrl, key }) {
  const pool = new Pool({ connectionString: dbUrl });
  const live = new Set();            // access tokens vigentes
  const refresh = new Map();         // refresh token -> email
  const stats = { logins: 0, refreshes: 0, rest: 0 };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
  const issue = email => {
    const access = `${b64({ alg: 'HS256' })}.${b64({ email, role: 'authenticated', sub: email })}.${Math.random().toString(36).slice(2)}`;
    const ref = Math.random().toString(36).slice(2);
    live.add(access); refresh.set(ref, email);
    return { access_token: access, refresh_token: ref, expires_in: 3600, token_type: 'bearer', user: { email } };
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const u = new URL(req.url, 'http://x');
    if (req.headers.apikey !== key && !u.pathname.startsWith('/__test')) return send(res, 401, { message: 'Invalid API key' });
    let body = '';
    for await (const ch of req) body += ch;

    if (u.pathname === '/__test/expire') { live.clear(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/__test/stats') return send(res, 200, stats);

    if (u.pathname === '/auth/v1/token') {
      const b = JSON.parse(body || '{}');
      if (u.searchParams.get('grant_type') === 'password') {
        if (USERS[b.email] !== b.password) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        stats.logins++; return send(res, 200, issue(b.email));
      }
      if (u.searchParams.get('grant_type') === 'refresh_token') {
        const email = refresh.get(b.refresh_token);
        if (!email) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        refresh.delete(b.refresh_token); stats.refreshes++; return send(res, 200, issue(email));
      }
    }

    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (m) {
      stats.rest++;
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (!live.has(token)) return send(res, 401, { message: 'JWT expired', code: 'PGRST301' });
      if (req.headers['accept-profile'] !== 'caja') return send(res, 406, { code: 'PGRST106', message: 'The schema must be one of the following: public' });
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
      const ord = (u.searchParams.get('order') || '').match(/^([a-z_]+)\.(asc|desc)$/);
      const lim = Number(u.searchParams.get('limit'));
      const sql = `SELECT * FROM caja.${m[1]}${ord ? ` ORDER BY ${ord[1]} ${ord[2]}` : ''}${Number.isInteger(lim) && lim > 0 ? ` LIMIT ${lim}` : ''}`;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE authenticated');
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        const r = await c.query(sql);
        return send(res, 200, r.rows);
      } catch (e) {
        return send(res, e.code === '42501' ? 403 : 404, { code: e.code, message: e.message });
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
    }
    send(res, 404, { message: 'not found' });
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok({ server, pool, stats, close: () => { server.close(); return pool.end(); } })));
}
module.exports = { start };
