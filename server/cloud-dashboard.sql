-- Permisos para la página de los dueños (nube/). SOLO PARA SUPABASE (usa auth.jwt() y los roles
-- anon / authenticated). Ejecútelo en el SQL Editor DESPUÉS de que la caja haya sincronizado una vez
-- (así ya existe el esquema "caja"). Es idempotente: se puede ejecutar de nuevo.
--
-- Qué consigue:
--   * Solo los correos de la tabla caja.owners pueden leer. Cualquier otro usuario ve 0 filas.
--   * Es solo lectura: nadie puede insertar, editar ni borrar por la API.
--   * El rol anon (sin iniciar sesión) no tiene ningún acceso.

CREATE TABLE IF NOT EXISTS caja.owners (
  email text PRIMARY KEY CHECK (email = lower(email))
);
ALTER TABLE caja.owners ENABLE ROW LEVEL SECURITY;   -- sin políticas: la API no la puede leer

CREATE OR REPLACE FUNCTION caja.is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM caja.owners o
     WHERE o.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;
REVOKE ALL ON FUNCTION caja.is_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caja.is_owner() TO authenticated;

-- 1) Nada para los anónimos, y nada de escritura para nadie por la API
REVOKE ALL ON SCHEMA caja FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA caja FROM anon;
REVOKE ALL ON caja.owners FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA caja FROM authenticated;

-- 2) Lectura solo para los dueños: permiso de SELECT + política por fila
GRANT USAGE ON SCHEMA caja TO authenticated;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stores','products','sales','sale_items','stock_moves','cash_moves','cash_counts'] LOOP
    EXECUTE format('GRANT SELECT ON caja.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS owners_read ON caja.%I', t);
    EXECUTE format('CREATE POLICY owners_read ON caja.%I FOR SELECT TO authenticated USING (caja.is_owner())', t);
  END LOOP;
END $$;
GRANT SELECT ON caja.v_stock_actual, caja.v_ventas_por_dia, caja.v_ventas_detalle,
                caja.v_caja_movimientos, caja.v_caja_saldo TO authenticated;

-- 3) Los dueños (use sus correos reales, en minúsculas)
-- INSERT INTO caja.owners (email) VALUES ('isa@ejemplo.com'), ('yamil@ejemplo.com') ON CONFLICT DO NOTHING;

-- 4) Publicar el esquema en la API: Supabase > Project Settings > API (o Integrations > Data API)
--    > "Exposed schemas" > agregue "caja". (No lo hacemos por SQL para no pisar la lista que ya tenga.)
