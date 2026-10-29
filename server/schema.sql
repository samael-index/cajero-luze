-- Esquema de Caja (PostgreSQL). Es idempotente: se ejecuta en cada arranque.
-- Todos los montos son pesos colombianos enteros (BIGINT), sin decimales.

CREATE TABLE IF NOT EXISTS admins (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  pin_hash   text NOT NULL,                 -- scrypt$sal$hash (nunca el PIN)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS admins_name_uq ON admins (lower(name));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,              -- sha256 del token entregado al navegador
  admin_id   integer NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  admin_name text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id         bigserial PRIMARY KEY,
  name       text    NOT NULL CHECK (length(btrim(name)) > 0),
  price      bigint  NOT NULL CHECK (price >= 0),
  cost       bigint  NOT NULL DEFAULT 0 CHECK (cost >= 0),
  stock      integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  category   text    NOT NULL DEFAULT '',
  emoji      text    NOT NULL DEFAULT '',
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS products_name_uq ON products (lower(name)) WHERE active;

CREATE TABLE IF NOT EXISTS sales (
  id          bigserial PRIMARY KEY,         -- es el N.º de venta
  created_at  timestamptz NOT NULL DEFAULT now(),
  subtotal    bigint NOT NULL,               -- antes de descuentos
  discount    bigint NOT NULL DEFAULT 0,
  total       bigint NOT NULL,               -- subtotal - discount
  method      text   NOT NULL CHECK (method IN ('efectivo','tarjeta','transferencia')),
  paid        bigint NOT NULL,               -- con cuánto pagó (efectivo) o = total
  change      bigint NOT NULL DEFAULT 0,     -- vuelto
  status      text   NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','anulada')),
  voided_at   timestamptz,
  voided_by   text,
  void_reason text,
  CHECK (total = subtotal - discount),
  CHECK (method <> 'efectivo' OR paid >= total)
);
CREATE INDEX IF NOT EXISTS sales_created_idx ON sales (created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id         bigserial PRIMARY KEY,
  sale_id    bigint NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id bigint REFERENCES products(id) ON DELETE SET NULL,
  name       text    NOT NULL,               -- nombre y precios del momento de la venta
  unit_price bigint  NOT NULL,
  cost       bigint  NOT NULL DEFAULT 0,
  qty        integer NOT NULL CHECK (qty > 0),
  discount   bigint  NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_total bigint  NOT NULL,
  CHECK (line_total = unit_price * qty - discount AND line_total >= 0)
);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items (sale_id);

CREATE TABLE IF NOT EXISTS stock_moves (
  id         bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  delta      integer NOT NULL,
  reason     text NOT NULL,                  -- venta | anulacion | carga | ajuste | importacion
  sale_id    bigint REFERENCES sales(id) ON DELETE SET NULL,
  by         text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_moves (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  type          text   NOT NULL CHECK (type IN ('ingreso','retiro')),
  amount        bigint NOT NULL CHECK (amount > 0),
  left_in_cash  bigint NOT NULL,             -- saldo de la caja justo después del movimiento
  reason        text   NOT NULL DEFAULT '',
  admin_name    text   NOT NULL
);
CREATE INDEX IF NOT EXISTS cash_moves_created_idx ON cash_moves (created_at);

CREATE TABLE IF NOT EXISTS cash_counts (
  id         bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expected   bigint NOT NULL,
  counted    bigint NOT NULL,
  diff       bigint NOT NULL
);

-- ===== Sincronización con la nube (espejo de solo lectura para los dueños) =====
-- Cada fila lleva en sync_x el id de la transacción que la escribió por última vez.
-- El sincronizador solo sube filas de transacciones ya terminadas (ver server/sync.js).
CREATE OR REPLACE FUNCTION caja_sync_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_x := pg_current_xact_id()::text::bigint;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','sales','sale_items','stock_moves','cash_moves','cash_counts'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t AND column_name = 'sync_x') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN sync_x bigint NOT NULL DEFAULT 0', t);
      EXECUTE format('CREATE INDEX %I ON %I (sync_x, id)', t || '_sync_idx', t);
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS caja_sync ON %I', t);
    EXECUTE format('CREATE TRIGGER caja_sync BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION caja_sync_touch()', t);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS sync_state (          -- hasta dónde se subió de cada tabla
  tbl     text PRIMARY KEY,
  last_x  bigint NOT NULL DEFAULT -1,
  last_id bigint NOT NULL DEFAULT -1
);
CREATE TABLE IF NOT EXISTS sync_status (         -- una sola fila: cómo va la sincronización
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_ok    timestamptz,
  last_try   timestamptz,
  last_error text
);
INSERT INTO sync_status (id) VALUES (1) ON CONFLICT DO NOTHING;
