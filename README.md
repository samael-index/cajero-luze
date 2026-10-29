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

## Ver stock y ventas desde otro lugar (nube: Supabase o Neon)
**Cómo está pensado:** la base de datos **local** (en el portátil) es la que opera la caja, así que **vender no depende del wifi**. Un sincronizador, que corre dentro del mismo programa, sube los cambios a una base PostgreSQL en la nube cada 30 segundos. Si no hay internet, los cambios quedan **pendientes** en el portátil y se suben solos al volver la conexión (el indicador ☁ de la barra superior muestra "Al día", "Subiendo N cambios" o "Sin internet · N pendientes"). La nube es un **espejo de solo lectura**: se mira desde allí, pero no se vende ni se edita desde allí.

**Por qué no usar la nube como base principal:** si la caja leyera y escribiera directo en la nube, sin internet no se podría vender (ni siquiera con la computadora funcionando). Con una copia local que sube después, el único trabajo que se retrasa es el de *mirar* desde fuera.

**Por qué es seguro subir "después":** cada fila guarda el número de la transacción que la escribió y el sincronizador solo sube filas de transacciones ya terminadas; subir es "insertar o actualizar", así que repetir no duplica; y el progreso solo avanza cuando la nube confirmó. Está probado, incluida una transacción lenta que confirma después de otra más nueva (`server/test/sync.test.js`).

### Qué se ve en la nube
Esquema `caja` (no lo publica la API pública de Supabase). Vistas listas para abrir en el *Table Editor* de Supabase o en la consola SQL de Neon:

| Vista | Qué muestra |
|---|---|
| `caja.v_stock_actual` | Producto, stock, precio, y si está `OK`, `POCO` o `AGOTADO` |
| `caja.v_ventas_por_dia` | Ventas por día (hora de Bogotá): total, efectivo, tarjeta, transferencia, descuentos |
| `caja.v_ventas_detalle` | Cada venta con sus productos, descuentos y si fue anulada |
| `caja.v_caja_movimientos` | Retiros y dinero agregado, con quién, motivo y cuánto quedó en caja |
| `caja.v_caja_saldo` | Efectivo que debe haber en la caja y cuándo fue la última sincronización |

### Activarla con Supabase
1. Cree un proyecto en supabase.com.
2. Botón **Connect** → copie la cadena **Session pooler** (usa IPv4; la conexión directa de Supabase es IPv6 y muchas redes de casa o de local no la tienen).
3. *Database Settings → SSL Configuration*: descargue el certificado y guárdelo, por ejemplo en `C:\Caja\supabase-ca.crt`.
4. En `.env`: `CLOUD_DATABASE_URL=` (la cadena) y `CLOUD_SSL_CA=C:\Caja\supabase-ca.crt`. Reinicie la caja. El esquema se crea solo.
5. En Supabase → *Table Editor* → esquema `caja` → abra las vistas `v_...`.

### Activarla con Neon
En `.env`: `CLOUD_DATABASE_URL=` con la cadena de conexión del proyecto. Neon usa un certificado de una autoridad pública, así que normalmente no hace falta `CLOUD_SSL_CA`. Si diera error de certificado, use el certificado de Neon con `CLOUD_SSL_CA` (`CLOUD_SSL=insecure` cifra pero **no verifica** al servidor: último recurso).

### Cuál elegir (datos de la documentación oficial)
- **Supabase gratis:** pausa los proyectos con poca actividad después de 1 semana ([docs](https://supabase.com/docs/guides/platform/free-project-pausing)). Supabase dice que unas pocas solicitudes al día suelen bastar para mantenerlo activo, sin garantía; en planes de pago no se pausa. Tiene editor de tablas con clics, cómodo para los dueños.
- **Neon gratis:** el cómputo se suspende tras 5 minutos sin uso y despierta al conectarse (la primera conexión tarda unos cientos de milisegundos) ([docs](https://neon.com/docs/guides/scale-to-zero-guide)). Para un espejo que se conecta cada 30 segundos no es problema.
- Los límites de los planes gratuitos cambian; confírmelos en su página de precios antes de decidir.

### Importante
- **No borre ni reemplace la base local con una copia vieja mientras la nube está activa**: los números de venta se repetirían y pisarían datos de la nube. Para empezar de cero, borre también las filas de la tienda en el esquema `caja`.
- Si el computador se daña, la nube **no** es una copia restaurable de todo (no guarda administradores ni PIN): para restaurar use las copias de `pg_dump` de abajo.

## Copias de seguridad (PostgreSQL)
La copia verdadera es la de la **base de datos** (`pg_dump`). Una copia guardada *dentro* de la misma base se perdería junto con ella, por eso:
- **`respaldar.bat`** (Windows) / **`scripts/respaldar.sh`** crean `backups/caja-FECHA.dump` y conservan 30 días. Programe `respaldar.bat` a diario en el *Programador de tareas* y copie la carpeta `backups` a un pendrive. Eso funciona **sin internet**.
- **Restaurar** en una base vacía: `pg_restore --no-owner -d caja backups\caja-FECHA.dump`.
- Ajustes → *Descargar copia (JSON)* baja una copia legible (sin PIN) para revisar o migrar datos.

## API interna (la que usa la pantalla)
La pantalla habla con el servidor local por HTTP/JSON; **no se usa ninguna API de terceros**. Ver `server/app.js`.

| Grupo | Rutas | PIN |
|---|---|---|
| Arranque | `GET /api/bootstrap`, `GET /api/health` | no |
| Acceso | `POST /api/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | no |
| Administradores | `POST /api/admins`, `PUT /api/admins/:id/pin`, `DELETE /api/admins/:id` | sí |
| Ajustes | `PUT /api/settings` | sí |
| Productos | `GET /api/products`, `POST /api/products/:id/stock` (cargar unidades) | no |
| | `POST/PUT/DELETE /api/products`, `POST /api/products/parse`, `POST /api/products/bulk`, `GET /api/products/export.xlsx` | sí |
| | `GET /api/products/template.xlsx` | no |
| Ventas | `POST /api/sales` | no |
| | `POST /api/sales/:id/void` | sí |
| Reportes | `GET /api/reports/summary`, `GET /api/reports/sales.csv` | sí |
| Caja | `GET /api/cash/state`, `GET /api/cash/moves`, `POST /api/cash/count` | no |
| | `POST /api/cash/retiro`, `POST /api/cash/ingreso` | sí |
| Nube | `GET /api/sync/status` | no |
| | `POST /api/sync/run` | sí |
| Copia | `GET /api/backup` | sí |

Librerías: `express` (servidor), `pg` (PostgreSQL), `exceljs` (leer y escribir Excel). En el navegador solo se usa `fetch`.

## Desarrollo y pruebas
```bash
npm install
docker compose up -d                 # o use un PostgreSQL local
export DATABASE_URL=postgres://caja:caja_dev@localhost:5432/caja
npm start                            # http://localhost:3000
DATABASE_URL_TEST=postgres://caja:caja_dev@localhost:5432/caja_test npm test   # BORRA la base de pruebas
```
Las pruebas usan PostgreSQL real. `api.test.js`: PIN, descuentos, los tres medios de pago, compras y retiros simultáneos, saldos por día, reportes, Excel. `sync.test.js` (necesita además `DATABASE_URL_TEST2` y `CLOUD_URL_TEST`, otras dos bases vacías con "test" en el nombre): espejo en la nube, caída de internet y recuperación, transacciones lentas y subida por páginas.

## Seguridad
- La conexión a la nube verifica el certificado del servidor; sin la autoridad correcta falla en vez de aceptar cualquiera.
- El servidor escucha solo en `127.0.0.1` (esta computadora). Si se publica en internet o en la red, **hay que agregar una clave de acceso al sistema completo**: hoy cualquiera que lo alcance podría vender y ver stock sin PIN.
- Las consultas usan parámetros (sin inyección SQL) y toda la pantalla escapa el texto que muestra.
- `npm audit` reporta 2 avisos *moderados* de `uuid` dentro de `exceljs` (solo afecta a `uuid` v3/v5/v6 con un búfer propio; `exceljs` usa v4). Se aceptan por ahora.
