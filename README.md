# Caja — punto de venta táctil

Un solo archivo (`index.html`), sin internet ni instalación. Los datos se guardan en el navegador de la PC (`localStorage`).

## Instalar en la PC táctil
1. Copie la carpeta `caja/` a un lugar fijo, por ejemplo `C:\Caja\`.
2. Abra `index.html` con **Chrome** o **Edge**.
3. Para que parezca un programa (pantalla completa, sin barra de direcciones), cree un acceso directo en el escritorio con destino:
   - Edge: `msedge.exe --kiosk file:///C:/Caja/index.html --edge-kiosk-type=fullscreen`
   - Chrome: `chrome.exe --kiosk file:///C:/Caja/index.html`

> **Importante:** abra siempre el archivo desde la misma ruta y con el mismo navegador. Los datos pertenecen a ese navegador y a esa ruta; si cambia cualquiera de los dos, la caja aparecerá vacía (se recupera con una copia de seguridad).

## Pantallas
| Pestaña | Para qué sirve |
|---|---|
| 🛒 Vender | Productos a la izquierda; cuenta, "Paga con", **Devuelve** y teclado numérico a la derecha. Descuenta el stock al cobrar. |
| 📦 Productos | Agregar/editar productos, **➕ Cargar** unidades que llegan, avisos de stock bajo/agotado. |
| 📊 Ventas | Reporte por período (hoy, ayer, 15 días, mes, desde el último retiro, todo): total, por día, por producto, cada venta; anular ventas; imprimir; exportar a Excel (CSV). |
| 💵 Caja | Dinero que debe haber ahora = dinero agregado + ventas − retiros; retiros (cada 15 días, configurable) con aviso; "Contar la caja" para ver sobrante/faltante; copia de seguridad; ajustes. |

## Cómo se calcula el dinero en caja
`En caja = dinero agregado (cambio/fondo) + ventas no anuladas − retiros`
Todas las ventas se toman como efectivo. Anular una venta devuelve las unidades al stock y resta su dinero de la caja.

## Datos y respaldo
- Cada venta guarda nombre y precio del momento, así que cambiar un precio no altera el historial.
- Se hace una copia interna diaria automática, y la pestaña Caja descarga una copia `.json` (avisa si pasan más de 7 días sin copia). Guárdela en un pendrive o en el correo.
- Si los datos guardados quedan ilegibles, no se sobrescriben: se conservan bajo la clave `caja.v1.corrupto.*`.
