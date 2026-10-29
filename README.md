# Caja — punto de venta táctil con PostgreSQL

Sistema de caja para un local en Colombia: vende con **efectivo, tarjeta o transferencia**, descuenta el stock, calcula el vuelto, aplica descuentos, y lleva el **dinero en efectivo de la caja** (saldo de antier, ayer y hoy, retiros con motivo). Los reportes y los retiros se protegen con **PIN de administrador**. Pensado para un portátil táctil convertible (Lenovo Yoga): funciona en horizontal y en vertical.

## Cómo funciona
| Parte | Qué es |
|---|---|
| `public/index.html` | La pantalla (HTML/CSS/JS sin librerías). |
| `server/` | Servidor Node.js + Express que habla con PostgreSQL. Toda la lógica de dinero y stock se calcula aquí, no en la pantalla. |
| `server/schema.sql` | Tablas de PostgreSQL. Se crean solas al arrancar. |
| PostgreSQL | Guarda productos, ventas, movimientos de caja, administradores y ajustes. Los montos son pesos enteros (`BIGINT`). |

## Qué exige PIN y qué no
| Sin PIN (trabajador) | Con PIN de administrador |
|---|---|
| Vender (los tres medios de pago) y dar descuentos | Reporte de ventas, descargas a Excel |
| Ver productos y **cargar** unidades que llegan | Agregar, editar, eliminar, importar/exportar productos (y ver el costo) |
| Ver los saldos de la caja y **contar la caja** | **Retirar** o **agregar** dinero a la caja, anular ventas |
| | Ajustes: valores de cambio, motivos de retiro, administradores, copia JSON |

El modo administrador se cierra solo a los 10 minutos sin usarlo. 5 PIN errados bloquean 1 minuto. Los PIN se guardan cifrados (scrypt), nunca en claro.

## Dinero en caja
- **Solo el efectivo entra a la caja.** Tarjeta y transferencia se reportan aparte.
- La pestaña **Caja** muestra antier, ayer y hoy: *con cuánto empezó el día + ventas en efectivo + dinero agregado − ventas anuladas − retiros = quedó en la caja*. El saldo con que empieza un día es el que quedó al cerrar el anterior.
- **Retirar dinero:** el administrador elige cuánto debe **quedar** en la caja (botones con los valores de cambio, por defecto $100.000 y $80.000, editables en Ajustes) o cuánto **saca**, y el **motivo**. Queda anotado quién, cuándo, cuánto se retiró y cuánto quedó.
- El día se calcula en la zona horaria `America/Bogota` (variable `TZ_NEGOCIO`).

## Descuentos
En la cuenta, cada producto tiene el botón **% Descuento**: se puede escribir **el precio final** ("te lo dejo en 18.000") y el sistema muestra cuánto y qué porcentaje se descontó, o escribir **el porcentaje** y ver cómo queda el precio. Si luego cambia la cantidad, el descuento se quita (para no dar uno que ya no corresponde). El reporte muestra los descuentos dados.

## Cargar productos
- **Uno por uno:** Productos → AGREGAR PRODUCTO.
- **Muchos a la vez (sin límite de cantidad):** Productos → *Plantilla de Excel* → llenarla (columnas Nombre, Precio, Costo, Stock, Categoría, Emoji) → IMPORTAR DESDE EXCEL. Se ve una vista previa; los productos con el mismo nombre se **actualizan** y se puede elegir si las cantidades **se suman** al stock o lo **reemplazan**. Hasta 20.000 filas por archivo.
- **Cuando llega mercancía:** ➕ CARGAR en el producto.

## Instalación en el portátil (Windows)
1. Instale **Node.js 22 LTS** (nodejs.org) y **PostgreSQL 16** (postgresql.org). Anote la clave del usuario `postgres`.
2. Cree la base y un usuario (en *SQL Shell (psql)*):
   ```sql
   CREATE USER caja WITH PASSWORD 'una-clave-larga';
   CREATE DATABASE caja OWNER caja;
   ```
3. Copie esta carpeta (`caja/`) a `C:\Caja\`, abra una terminal allí y ejecute `npm install`.
4. Copie `.env.example` como `.env` y escriba la `DATABASE_URL` con su usuario y clave.
5. Doble clic en **`iniciar-caja.bat`**: arranca el servidor y abre Edge en pantalla completa. La primera vez pide crear el administrador (nombre y PIN). El segundo dueño se agrega en Ajustes → Administradores.
6. Para que arranque con la computadora, ponga un acceso directo a `iniciar-caja.bat` en `shell:startup`.

> Los `.bat` no se pudieron probar en Windows desde el entorno donde se desarrolló; revíselos en la primera instalación.

## Copias de seguridad (PostgreSQL)
La copia verdadera es la de la **base de datos** (`pg_dump`). Una copia guardada *dentro* de la misma base se perdería junto con ella, por eso:
- **`respaldar.bat`** (Windows) / **`scripts/respaldar.sh`** crean `backups/caja-FECHA.dump` y conservan 30 días. Programe `respaldar.bat` a diario en el *Programador de tareas* y copie la carpeta `backups` a un pendrive o a la nube.
- **Restaurar** en una base vacía: `pg_restore --no-owner -d caja backups\caja-FECHA.dump`.
- Si la base está en un servicio gestionado (por ejemplo Supabase), use además sus copias automáticas.
- Ajustes → *Descargar copia (JSON)* baja una copia legible (sin PIN) para revisar o migrar datos.

## Desarrollo y pruebas
```bash
npm install
docker compose up -d                 # o use un PostgreSQL local
export DATABASE_URL=postgres://caja:caja_dev@localhost:5432/caja
npm start                            # http://localhost:3000
DATABASE_URL_TEST=postgres://caja:caja_dev@localhost:5432/caja_test npm test   # BORRA la base de pruebas
```
Las pruebas (`server/test/api.test.js`) usan PostgreSQL real y cubren PIN, descuentos, los tres medios de pago, compras simultáneas de la última unidad, retiros simultáneos, saldos por día, reportes e importación de Excel.

## Seguridad
- El servidor escucha solo en `127.0.0.1` (esta computadora). Si se publica en internet o en la red, **hay que agregar una clave de acceso al sistema completo**: hoy cualquiera que lo alcance podría vender y ver stock sin PIN.
- Las consultas usan parámetros (sin inyección SQL) y toda la pantalla escapa el texto que muestra.
- `npm audit` reporta 2 avisos *moderados* de `uuid` dentro de `exceljs` (solo afecta a `uuid` v3/v5/v6 con un búfer propio; `exceljs` usa v4). Se aceptan por ahora.
