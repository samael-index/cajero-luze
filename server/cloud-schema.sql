-- Espejo de Caja en la nube (Supabase o Neon). Lo crea solo el sincronizador; también se puede
-- pegar en el editor SQL. Es idempotente. Vive en el esquema "caja", que Supabase NO publica por
-- su API pública (solo se publican los esquemas que usted agregue en Settings > API).
CREATE SCHEMA IF NOT EXISTS caja;

CREATE TABLE IF NOT EXISTS caja.stores (
  store_id   uuid PRIMARY KEY,
  name       text NOT NULL,
  stock_bajo integer NOT NULL DEFAULT 5,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_sync  timestamptz
);
CREATE TABLE IF NOT EXISTS caja.products (
  store_id uuid NOT NULL, id bigint NOT NULL, sync_x bigint NOT NULL,
  name text NOT NULL, price bigint NOT NULL, cost bigint NOT NULL, stock integer NOT NULL,
  category text NOT NULL, emoji text NOT NULL, active boolean NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (store_id, id));
CREATE TABLE IF NOT EXISTS caja.sales (
  store_id uuid NOT NULL, id bigint NOT NULL, sync_x bigint NOT NULL,
  created_at timestamptz NOT NULL, subtotal bigint NOT NULL, discount bigint NOT NULL, total bigint NOT NULL,
  method text NOT NULL, paid bigint NOT NULL, change bigint NOT NULL, status text NOT NULL,
  voided_at timestamptz, voided_by text, void_reason text,
  PRIMARY KEY (store_id, id));
CREATE TABLE IF NOT EXISTS caja.sale_items (
  store_id uuid NOT NULL, id bigint NOT NULL, sync_x bigint NOT NULL,
  sale_id bigint NOT NULL, product_id bigint, name text NOT NULL, unit_price bigint NOT NULL,
  cost bigint NOT NULL, qty integer NOT NULL, discount bigint NOT NULL, line_total bigint NOT NULL,
  PRIMARY KEY (store_id, id));
CREATE TABLE IF NOT EXISTS caja.stock_moves (
  store_id uuid NOT NULL, id bigint NOT NULL, sync_x bigint NOT NULL,
  product_id bigint NOT NULL, delta integer NOT NULL, reason text NOT NULL, sale_id bigint, by text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (store_id, id));
CREATE TABLE IF NOT EXISTS caja.cash_moves (
  store_id uuid NOT NULL, id bigint NOT NULL, sync_x bigint NOT NULL,
  created_at timestamptz NOT NULL, type text NOT NULL, amount bigint NOT NULL, left_in_cash bigint NOT NULL,
  reason text NOT NULL, admin_name text NOT NULL,
  PRIMARY KEY (store_id, id));
CREATE TABLE IF NOT EXISTS caja.cash_counts (
  store_id uuid NOT NULL, id bigint NOT NULL, sync_x bigint NOT NULL,
  created_at timestamptz NOT NULL, expected bigint NOT NULL, counted bigint NOT NULL, diff bigint NOT NULL,
  PRIMARY KEY (store_id, id));
CREATE INDEX IF NOT EXISTS sales_created_idx ON caja.sales (store_id, created_at);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON caja.sale_items (store_id, sale_id);

-- Nadie entra a estas tablas por la API pública: sin políticas, RLS lo niega todo.
ALTER TABLE caja.stores      ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja.products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja.sales       ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja.sale_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja.stock_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja.cash_moves  ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja.cash_counts ENABLE ROW LEVEL SECURITY;

-- ===== Vistas para mirar desde cualquier lugar (Table Editor de Supabase o consola SQL de Neon) =====
CREATE OR REPLACE VIEW caja.v_stock_actual WITH (security_invoker = true) AS
  SELECT st.name AS tienda, p.name AS producto, p.category AS categoria, p.stock, p.price AS precio, p.cost AS costo,
         CASE WHEN p.stock <= 0 THEN 'AGOTADO' WHEN p.stock <= st.stock_bajo THEN 'POCO' ELSE 'OK' END AS estado,
         p.updated_at AS actualizado
    FROM caja.products p JOIN caja.stores st USING (store_id)
   WHERE p.active
   ORDER BY p.stock, p.name;

CREATE OR REPLACE VIEW caja.v_ventas_por_dia WITH (security_invoker = true) AS
  SELECT st.name AS tienda, (s.created_at AT TIME ZONE 'America/Bogota')::date AS dia,
         count(*) AS ventas, sum(s.total) AS total,
         coalesce(sum(s.total) FILTER (WHERE s.method = 'efectivo'), 0)      AS efectivo,
         coalesce(sum(s.total) FILTER (WHERE s.method = 'tarjeta'), 0)       AS tarjeta,
         coalesce(sum(s.total) FILTER (WHERE s.method = 'transferencia'), 0) AS transferencia,
         sum(s.discount) AS descuentos
    FROM caja.sales s JOIN caja.stores st USING (store_id)
   WHERE s.status = 'ok'
   GROUP BY 1, 2
   ORDER BY 2 DESC;

CREATE OR REPLACE VIEW caja.v_ventas_detalle WITH (security_invoker = true) AS
  SELECT st.name AS tienda, s.id AS venta,
         to_char(s.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS fecha,
         s.method AS medio_pago, CASE s.status WHEN 'ok' THEN 'OK' ELSE 'ANULADA' END AS estado,
         i.name AS producto, i.qty AS cantidad, i.unit_price AS precio, i.discount AS descuento, i.line_total AS total_linea
    FROM caja.sales s
    JOIN caja.stores st USING (store_id)
    JOIN caja.sale_items i ON i.store_id = s.store_id AND i.sale_id = s.id
   ORDER BY s.created_at DESC, i.id;

CREATE OR REPLACE VIEW caja.v_caja_movimientos WITH (security_invoker = true) AS
  SELECT st.name AS tienda, to_char(m.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS fecha,
         CASE m.type WHEN 'retiro' THEN 'RETIRO' ELSE 'SE AGREGÓ' END AS tipo,
         m.amount AS monto, m.left_in_cash AS quedo_en_caja, m.reason AS motivo, m.admin_name AS quien
    FROM caja.cash_moves m JOIN caja.stores st USING (store_id)
   ORDER BY m.created_at DESC;

CREATE OR REPLACE VIEW caja.v_caja_saldo WITH (security_invoker = true) AS
  SELECT st.name AS tienda,
         coalesce((SELECT sum(s.total)  FROM caja.sales s       WHERE s.store_id = st.store_id AND s.method = 'efectivo' AND s.status = 'ok'), 0)
       + coalesce((SELECT sum(m.amount) FROM caja.cash_moves m  WHERE m.store_id = st.store_id AND m.type = 'ingreso'), 0)
       - coalesce((SELECT sum(m.amount) FROM caja.cash_moves m  WHERE m.store_id = st.store_id AND m.type = 'retiro'), 0) AS en_caja_efectivo,
         st.last_sync AT TIME ZONE 'America/Bogota' AS ultima_sincronizacion
    FROM caja.stores st;
