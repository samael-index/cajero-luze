-- =====================================================================================================
-- PROPUESTA (NO APLICADA): compartir el stock entre la caja y el sistema "Control de Stock" de Velas Luze.
-- Es ADITIVA: no borra ni cambia nada de lo que ya existe, y su app actual sigue funcionando igual.
-- Probada contra una réplica local de la estructura real (server/test/shared.test.js).
-- Se aplica en el SQL Editor de Supabase (o con una migración) SOLO cuando usted lo apruebe.
-- =====================================================================================================

-- 1) Precio y foto por producto. Columnas opcionales: su app actual no las usa ni se rompe.
ALTER TABLE public.candles
  ADD COLUMN IF NOT EXISTS price      numeric CHECK (price IS NULL OR price >= 0),   -- precio de venta en pesos
  ADD COLUMN IF NOT EXISTS image_path text;                                           -- ruta de la foto en el bucket "productos"

-- 2) Bucket de fotos (lectura pública para poder mostrarlas con un enlace; solo usuarios con sesión las cambian)
INSERT INTO storage.buckets (id, name, public) VALUES ('productos', 'productos', true) ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS productos_escribir ON storage.objects;
CREATE POLICY productos_escribir ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'productos') WITH CHECK (bucket_id = 'productos');

-- 3) Registro de lo que la caja ya aplicó (para no descontar dos veces la misma venta si reintenta tras un corte)
CREATE TABLE IF NOT EXISTS public.caja_movimientos_aplicados (
  clave       text PRIMARY KEY,                       -- ej. "<tienda>:venta:123"
  aplicado_en timestamptz NOT NULL DEFAULT now(),
  detalle     jsonb NOT NULL
);
ALTER TABLE public.caja_movimientos_aplicados ENABLE ROW LEVEL SECURITY;   -- sin políticas: la API pública no la toca
REVOKE ALL ON public.caja_movimientos_aplicados FROM anon, authenticated;

-- 4) Una sola función, atómica e idempotente, para mover el stock desde la caja.
--    p_items = [{"candle_id": 7, "delta": -2, "tipo": "venta", "nota": "Venta N° 123"}, ...]
--    delta negativo descuenta (venta); positivo suma (carga de mercancía, devolución, anulación).
--    El stock nunca queda negativo: si se vendió más de lo que figuraba, queda en 0 y se anota cuántas faltaron.
--    Escribe en su historial (stock_movements) con el mismo formato que usa su app.
CREATE OR REPLACE FUNCTION public.caja_aplicar_movimientos(p_clave text, p_items jsonb, p_usuario text DEFAULT 'caja')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  it jsonb; c public.candles%ROWTYPE; nuevo numeric; delta numeric; aplicado numeric; nota text; salida jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'p_items debe ser una lista con al menos un movimiento';
  END IF;
  INSERT INTO public.caja_movimientos_aplicados (clave, detalle) VALUES (p_clave, p_items) ON CONFLICT (clave) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('ya_aplicado', true); END IF;       -- reintento: no se descuenta otra vez

  FOR it IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY (value ->> 'candle_id')::bigint LOOP   -- orden fijo: sin bloqueos cruzados
    SELECT * INTO c FROM public.candles WHERE id = (it ->> 'candle_id')::bigint FOR UPDATE;
    IF NOT FOUND THEN
      salida := salida || jsonb_build_object('candle_id', (it ->> 'candle_id')::bigint, 'error', 'no_existe');
      CONTINUE;
    END IF;
    delta  := (it ->> 'delta')::numeric;
    nuevo  := GREATEST(c.stock + delta, 0);
    aplicado := nuevo - c.stock;
    nota := coalesce(it ->> 'nota', '');
    IF aplicado <> delta THEN nota := trim(nota || ' (faltaron ' || (abs(delta) - abs(aplicado))::text || ' unidades en el sistema)'); END IF;
    UPDATE public.candles SET stock = nuevo, "updatedAt" = now() WHERE id = c.id;
    INSERT INTO public.stock_movements (candle_id, product_name, quantity, movement_type, category, previous_stock, final_stock, notes, user_email)
    VALUES (c.id, c.name, aplicado, coalesce(it ->> 'tipo', 'ajuste manual'), c.category, c.stock, nuevo, nota, p_usuario);
    salida := salida || jsonb_build_object('candle_id', c.id, 'stock', nuevo, 'aplicado', aplicado);
  END LOOP;
  RETURN jsonb_build_object('ya_aplicado', false, 'items', salida);
END $$;

-- Solo la conexión de la caja (rol postgres / service_role) puede llamarla; nadie desde la API pública.
REVOKE ALL ON FUNCTION public.caja_aplicar_movimientos(text, jsonb, text) FROM PUBLIC, anon, authenticated;
