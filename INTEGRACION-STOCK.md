# Compartir el stock entre la caja y "Control de Stock" (Velas Luze)

**Estado: PROPUESTA. No se ha aplicado nada en su proyecto de Supabase.**
Lo único hecho con su proyecto fue **leer** su estructura (tablas, reglas de acceso, conteos y 2 filas del historial).

## Lo que hay hoy en su proyecto
| | |
|---|---|
| `public.candles` | 31 productos en 3 categorías (Estantería ramos 6, Postres y demás 16, Velas religiosas 9), ~99 unidades en total. Columnas: `id, name, category, stock, unit, minStock, notes, updatedAt`. **Sin precio y sin foto.** |
| `public.stock_movements` | Historial de movimientos (2 filas: `producción`, `ajuste manual`). `quantity` lleva signo (+1 / −1) y guarda `previous_stock` y `final_stock`. |
| Acceso | RLS activo: cualquier usuario con sesión (hoy 2) puede leer y modificar `candles`; el historial solo se puede insertar y leer (no editar ni borrar). |
| Almacenamiento | Ningún bucket: no hay dónde guardar fotos todavía. |

## Qué se comparte
El **stock** (`candles.stock`) y su **historial** (`stock_movements`) son la fuente única. La caja lee de ahí y, cuando vende, descuenta ahí.
La caja agrega por producto **precio** y **foto**, que hoy no existen.

## Cambios propuestos en su proyecto (`supabase/compartir-stock.sql`, aditivos)
1. `candles.price` y `candles.image_path` (opcionales; su app actual ni se entera).
2. Bucket público `productos` para las fotos (lectura por enlace; solo usuarios con sesión escriben).
3. Tabla `caja_movimientos_aplicados` (privada) + función `caja_aplicar_movimientos(...)`: descuenta o suma stock de forma **atómica e idempotente** y escribe en `stock_movements` con el mismo formato de su app (`venta`, `devolución`, `ingreso`). Reintentar la misma venta tras un corte de internet **no descuenta dos veces**. El stock **nunca queda negativo**: si se vendió más de lo que figuraba, queda en 0 y la nota dice cuántas faltaron. Solo la conexión de la caja puede llamarla.

Probado contra una réplica local de su estructura y reglas: `server/test/shared.test.js` (8 pruebas: su app sigue funcionando, descuento, historial, reintento, no negativo, ventas simultáneas, seguridad, bucket).

## Cómo funcionaría con la caja (sin perder el trabajo sin wifi)
- **Con internet:** cada ~30 s la caja trae de `candles` el catálogo, el stock, el precio y las fotos. Al vender, descuenta en `candles` y deja el movimiento en el historial.
- **Sin internet:** la caja sigue vendiendo con su copia local. Cada venta queda en cola y se aplica al volver el internet (la función evita duplicados). El stock que muestra la caja es *el último conocido menos lo vendido sin subir*.
- **Quien cambie stock desde el sistema actual** (producción, ajustes) se refleja en la caja en el siguiente ciclo. No se pisan: la caja envía **cambios** (−2), no cantidades absolutas.
- **Panel de los dueños:** pasa a leer el stock directamente de `candles` (ya no necesita su propia copia); ventas, descuentos y caja siguen en el esquema `caja`.

## Qué falta decidir
1. ¿Aprueba aplicar el SQL en su proyecto? (se aplica en el SQL Editor; se puede revertir quitando las columnas, el bucket, la tabla y la función).
2. ¿Dónde se crean y editan los productos (nombre, categoría, mínimo)? Recomendado: **en su sistema actual**; la caja solo agrega **precio y foto** y carga mercancía. Así no hay dos lugares para lo mismo.
3. Fotos: **Storage** (recomendado; las verá también su sistema actual y el panel) o guardarlas dentro de la base. Storage necesita una llave secreta guardada solo en el computador de la caja (`.env`).
4. Nombre del movimiento de venta en su historial: propuesto `venta` (minúscula, como `producción` y `ajuste manual`). Si su app usa otro texto para ventas, se cambia en un solo lugar.
5. Qué hacer cuando la caja vende algo que el sistema ya figura en 0: propuesto dejar en 0 y anotar la diferencia (la venta ya ocurrió).
