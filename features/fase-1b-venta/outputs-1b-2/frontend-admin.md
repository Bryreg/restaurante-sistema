# frontend-admin — entregable (pedido 1b-2)

Rol: "Frontend Hoy, Ventas y Pedidos del administrador" — pantallas analíticas del
administrador (Hoy, Ventas con el informe del contador, Pedidos ampliado) y la
carcasa de navegación (`src/app/**`, `src/components/**`) de `restaurante-sistema`.
Trabajé en paralelo con `backend-fiscal`, `backend-clientes-dinero`, `backend-reportes`
(cuyo output todavía no estaba publicado cuando escribí esto — leí directamente
`backend/app/reports/{router,schemas,service}.py` y `backend/app/orders/service.py
::admin_list_orders`, ya escritos, para el contrato exacto) y `frontend-fiscal`
(`fiscalFeature`/`customersFeature`, ya construidos cuando llegué).

## Resumen

- **Orden de arranque cumplido primero**: `src/components/DateRangeFilter.tsx` y
  `src/components/CsvExportButton.tsx` con las firmas exactas pedidas, publicados
  antes de tocar cualquier pantalla.
- `src/api/reports.ts` (nuevo): tipos y funciones contra `GET /admin/today`,
  `GET /admin/sales`, `GET /admin/accountant-report`, `GET /admin/unavailable-log`
  — todo campo de un `Out` opcional o `| null`, mismo patrón que `src/api/orders.ts`.
- `src/features/reports/**` (nuevo): "Hoy" (`TodayPage.tsx`) y "Ventas"
  (`SalesPage.tsx` con tres pestañas: Ventas, Informe del contador, Agotados),
  más `charts.tsx` (SVG/CSS propio, sin librería), `AttentionCard.tsx` (tarjetas
  accionables de "Requiere tu atención") y `lib.ts` (etiquetas, ruteo de alertas,
  formato de porcentaje).
- **Pedidos ampliado**: `backend-reportes` ya había extendido
  `GET /admin/orders` de una lista plana a `{rows, kitchen_times_by_station,
  sent_at_payment_ratio}` (tiempos de mesa/cobro, detalle de anulaciones, medios
  de pago, `is_staff_meal`) — actualicé `src/api/orders.ts` y
  `OrdersAdminPage.tsx` para consumir la forma nueva: filtros con
  `DateRangeFilter`/`CsvExportButton`, KPIs de período, p50/p90 de cocina por
  estación (barras + tabla), detalle de anulaciones por ítem, y de paso corregí
  un hallazgo de accesibilidad heredado de 1b-1 (`<tr onClick>` sin equivalente
  de teclado) con un botón "Ver detalle" real por fila.
- **O-1 resuelto**: `DiscountDialog.tsx` ya no redondea en silencio; rechaza
  decimales con el mensaje de siempre.
- Router/nav: registré `reportsFeature`, `fiscalFeature` y `customersFeature`
  (los dos últimos ya existían con la forma exacta `{adminRoutes, adminNav}`
  pedida — no tuve que esperarlos) en `src/app/router.tsx` y `AdminLayout.tsx`;
  la ruta índice de `/admin` pasa de "Funciones" a "Hoy" (es la pantalla por la
  que el dueño abre el admin, SPEC-NEGOCIO §9.3).
- 21 tests nuevos + 2 archivos de tests ya existentes ampliados (ver
  «Verificación»), todos verdes; `tsc --noEmit` limpio.

## 1. Componentes creados/modificados

| Archivo | Qué |
|---|---|
| `src/components/DateRangeFilter.tsx` | **Nuevo.** Firma exacta pedida: `{from, to, onChange}` (+ `idPrefix`/`fromLabel`/`toLabel`/`disabled` opcionales, para no chocar de `id` cuando una pantalla tiene dos filtros de fecha a la vez). |
| `src/components/CsvExportButton.tsx` | **Nuevo.** Firma exacta pedida: `{href, label?}`. |
| `src/components/StatTile.tsx` | **Nuevo.** "Un KPI que decide, con su contexto" — usado por Hoy, Ventas y ahora también por Pedidos. `tone` (`default/warning/critical`) nunca es la única señal. |
| `src/components/__tests__/DateRangeFilter.test.tsx` | **Nuevo.** 2 tests. |
| `src/components/__tests__/CsvExportButton.test.tsx` | **Nuevo.** 2 tests. |
| `src/api/reports.ts` | **Nuevo.** Tipos + funciones de los 4 endpoints de reportes, más `salesCsvUrl`/`accountantReportCsvUrl`/`unavailableLogCsvUrl`. |
| `src/api/orders.ts` | **Modificado.** `AdminOrderListItem` ganó `closed_at`, `table_minutes`, `bill_to_paid_minutes`, `void_details` (nuevo tipo `AdminOrderVoidDetailOut`), `courtesy_list_value`, `sent_at_payment_ratio`, `is_staff_meal`, `payment_methods`; nuevo tipo `AdminOrderKitchenStationTimeOut`; `adminListOrders` ahora devuelve `AdminOrdersReportOut = {rows, kitchen_times_by_station, sent_at_payment_ratio}` (antes devolvía `AdminOrderListItem[]` a secas — `backend-reportes` ya había ampliado `GET /admin/orders` de ese modo). |
| `src/features/reports/lib.ts` | **Nuevo.** `GROUP_BY_LABEL`, `isSequentialGroupBy`, `methodLabel`, `formatPercent` (sólo formatea una proporción que YA manda el backend), `alertRoute` (tipo de alerta → pantalla donde se resuelve), `todayInBogota`/`daysAgoInBogota` (default de filtro, nunca fecha operativa de un registro). |
| `src/features/reports/charts.tsx` | **Nuevo.** `CategoryBars` (comparación entre categorías, eje desde cero) y `TrendLine` (tendencia en el tiempo) — SVG/CSS propio, sin librería; ambos con `role="img"` + `aria-label` y siempre acompañados de la tabla exacta en la misma pantalla. |
| `src/features/reports/AttentionCard.tsx` | **Nuevo.** Tarjeta accionable de "Requiere tu atención": título + cuerpo + enlace con el nombre de la pantalla donde se resuelve; `tone` nunca es la única señal. |
| `src/features/reports/TodayPage.tsx` | **Nuevo.** "Hoy": pulso + "Requiere tu atención". |
| `src/features/reports/SalesTab.tsx` | **Nuevo.** Pestaña "Ventas" de la pantalla Ventas (agrupación `group_by`). |
| `src/features/reports/AccountantReportTab.tsx` | **Nuevo.** Pestaña "Informe del contador". |
| `src/features/reports/UnavailableLogTab.tsx` | **Nuevo.** Pestaña "Agotados" (`GET /admin/unavailable-log`; ver §3 por qué vive acá y no en Hoy). |
| `src/features/reports/SalesPage.tsx` | **Nuevo.** Shell con las tres pestañas + enlaces a Documentos fiscales/Notas (fiscal, no duplicado acá). |
| `src/features/reports/index.ts` | **Nuevo.** `reportsFeature = {adminRoutes: [hoy, ventas], adminNav}`, sin `feature` (núcleo). |
| `src/features/reports/__tests__/{index,TodayPage,SalesPage}.test.tsx` | **Nuevos.** 3 archivos, 7 tests. |
| `src/features/orders/DiscountDialog.tsx` | **Modificado — O-1.** Ver §4. |
| `src/features/orders/__tests__/DiscountDialog.test.tsx` | **Nuevo.** 3 tests de O-1. |
| `src/features/orders/OrdersAdminPage.tsx` | **Modificado — Pedidos ampliado.** Ver §3. |
| `src/features/orders/__tests__/OrdersAdminPage.test.tsx` | **Modificado.** El mock de `adminListOrders` pasó de devolver un array a `{rows, kitchen_times_by_station, sent_at_payment_ratio}` (la forma nueva del backend); agregué aserciones sobre `kitchen_times_by_station`. |
| `src/app/router.tsx` | **Modificado.** Registra `reportsFeature.adminRoutes`, `fiscalFeature.adminRoutes`, `customersFeature.adminRoutes`; índice de `/admin` → `hoy` (antes `features`). |
| `src/app/AdminLayout.tsx` | **Modificado.** `buildNav` concatena `reportsFeature`/`fiscalFeature`/`customersFeature` en el orden de SPEC-NEGOCIO §9.3 (Hoy, Ventas, Pedidos, Carta, fiscal, Dinero, Turnos y personal, Clientes, `OWN_NAV`). |
| `src/app/__tests__/router.test.tsx` | **Modificado.** +2 tests: rutas de 1b-2 montadas, índice redirige a `hoy`. |
| `src/app/__tests__/AdminLayout.test.tsx` | **Modificado.** +2 tests: nav de 1b-2 sin mockear esos dominios, `Clientes` respeta su `feature`. |
| `src/app/PosLayout.tsx`, `src/app/PosHome.tsx`, `src/app/nav.ts` | **Sin cambios.** Nada de 1b-2 en mi misión tocaba el POS del dispositivo. |

## 2. Endpoints que consumo (para que el Conciliador la cruce)

Todos bajo `/api/v1`, ya verificados contra el código real de `backend/app/reports/**` y
`backend/app/orders/service.py::admin_list_orders` (no inventé nada; el output
`backend-reportes.md` todavía no existía en el árbol cuando escribí esto):

- `GET /admin/today?store_id`
- `GET /admin/sales?store_id&from&to&group_by` (+ `format=csv`)
- `GET /admin/accountant-report?store_id&year&bimester|month` (+ `format=csv`)
- `GET /admin/unavailable-log?store_id&from&to` (+ `format=csv`)
- `GET /admin/orders?store_id&from&to&status&channel&flags` (+ `format=csv`) —
  ya consumido en 1b-1, ahora leo la forma ampliada `{rows,
  kitchen_times_by_station, sent_at_payment_ratio}`.
- `GET /admin/orders/{id}` — sin cambios.

**No consumo** (son enlaces de navegación, no llamadas a la API, a pantallas de
otro territorio): `/admin/fiscal/documents`, `/admin/fiscal/ranges`,
`/admin/documents/{id}/notes`, `/admin/notes`, `/admin/pending-refunds` (todos
`fiscalFeature`), ni ninguna ruta de `app/catalog` (enlace a "Carta").

## 3. Qué pregunta responde cada elemento — y qué descarté

### Hoy

| Elemento | Pregunta que responde |
|---|---|
| Ventas netas (hero, grande y primero) | ¿Cuánto vendimos hoy, de verdad — sin el impuesto que no es nuestro? |
| Ventas cobradas + impuesto (subtexto del hero) | ¿Cuánto pagó el cliente en total, y cuánto de eso es impuesto discriminado? |
| Comandas pagadas | ¿Cuántas ventas cerramos hoy? |
| Ticket promedio / por comensal | ¿Cuánto deja en promedio una comanda, y cada persona sentada? |
| Comensales | ¿Cuánta gente comió hoy? |
| Mesas ocupadas (n/total) | ¿Qué tan lleno está el salón ahora mismo? |
| Comandas abiertas (+ aviso sin enviar/sin cobrar) | ¿Cuántas comandas siguen en curso, y cuántas están atascadas? |
| Efectivo esperado | ¿Cuánto debería haber en caja ahora? (tarjeta de "sin turno" si no hay turno abierto — nunca "$0") |
| Propinas de hoy / por medio | ¿Cuánto se dejó de propina hoy, aparte de la venta, y por qué medio? |
| Ventas por hora (barras) | ¿A qué hora se vende más? (categorías discretas de hora, no una serie continua — por eso barras, no línea) |
| Comandas abiertas (tabla) | ¿Cuáles exactamente están abiertas, hace cuánto, y cuáles cruzaron el umbral? |
| Requiere tu atención (tarjetas) | ¿Qué necesita que yo actúe ahora, y a qué pantalla voy para resolverlo? |

**Descartado en Hoy:**
- Un delta "vs. ayer" en cada `StatTile`: `GET /admin/today` no manda el número de
  ayer — fabricarlo con una segunda llamada a `/admin/sales` habría sido inventar
  una comparación que el backend no ofreció como parte de este contrato; queda en
  `gaps`.
- Rellenar con $0 las horas del día sin ventas (para dibujar 24 barras completas):
  `sales_by_hour` sólo trae las horas con al menos un documento; inventar ceros
  para las horas sin sesión (antes de abrir, de madrugada) sería mostrar un dato
  que el backend no calculó como "cero real" — se muestran sólo las horas con
  datos.
- Un gráfico de torta para "mesas ocupadas vs. libres": son dos categorías, cabría
  la regla de "máximo 3 porciones", pero un stat tile con "2/8" responde la
  pregunta más rápido que un dibujo — se descartó el gráfico.

### Ventas

| Elemento | Pregunta que responde |
|---|---|
| StatTiles del total (bruto, neto, impuesto, propinas, comandas, comensales, tickets) | ¿Cuánto vendí y cómo se compone, en el período elegido? |
| Línea (business_date/shift) o barras (method/channel/employee/hour/zone) | ¿Cómo evolucionó la venta en el tiempo, o cómo se compara entre categorías? |
| Tabla con el desglose completo + fila Total | ¿Cuál es el número exacto de cada fila, para conciliar o exportar? |
| Informe del contador: base/impuesto por tarifa, documentos, notas, propinas | ¿Qué declaro este mes/bimestre, por día operativo y por tarifa? |
| Totales por medio (informe del contador) | ¿Cuánto entró por cada medio de pago en el período? |
| Agotados: producto, desde cuándo, por quién, unidades/ventas perdidas estimadas | ¿Qué me quedé sin vender, y cuánto me costó (estimado)? |
| Enlaces "Documentos con detalle"/"Notas" | ¿Dónde veo cada comprobante con su estado DIAN, o cada nota? (no acá: ver abajo) |

**Descartado / decisión declarada en Ventas:**
- **No duplico "documentos con detalle" ni "notas"** dentro de Ventas. Las pantallas
  `fiscalFeature` (`/admin/fiscal/documentos`, `/admin/fiscal/notas`) ya existían,
  ya construidas por `frontend-fiscal`, con estado DIAN, evidencia y reintento —
  volver a listarlos acá con otra consulta habría sido dos fuentes de verdad para
  el mismo dato. Ventas enlaza a esas pantallas en vez de reconstruirlas (dentro
  de mi territorio: `src/features/reports/**`, nunca `src/features/fiscal/**`).
- **`GET /admin/unavailable-log` vive en Ventas, no en Hoy.** Hoy ya muestra el
  agotado *actual* (`unavailable_products`, parte de `TodayOut`) como alerta
  accionable. El log histórico con venta perdida estimada es un reporte de
  período con `format=csv`, igual que Ventas/Informe del contador — encaja mejor
  ahí que como una cuarta pestaña sin dueño claro. Lo declaro explícito porque no
  hay una instrucción literal que diga dónde va.
- **Barras sólo hasta 12 categorías.** `group_by=employee` o `=hour` puede traer
  más filas de las que una comparación visual puede leer sin volverse ruido; más
  allá de 12 se muestra sólo la tabla (que de todos modos es la fuente exacta y
  la que exporta).
- **Ninguna librería de charts.** Dos formas (`CategoryBars`, `TrendLine`) en
  SVG/CSS propio alcanzan para las dos preguntas que aparecen en 1b-2
  (comparación, tendencia); no las instalé, y si una pantalla futura necesitara
  algo más complejo (un mapa de calor por hora × día, por ejemplo) queda
  declarado como decisión pendiente, no como instalación silenciosa.

## 4. O-1 — cómo quedó

`src/features/orders/DiscountDialog.tsx:62` (1b-1) mandaba
`onConfirm(kind, Math.round(numericValue), ...)`: redondeaba en silencio lo que la
persona tecleó (un "10,6 %" se mandaba como "11 %") sin que el operador viera que
su número cambió.

Corrección: se saca el `Math.round`. Antes de llamar a `onConfirm` se valida
`Number.isInteger(numericValue)`; si no lo es, se rechaza con el mismo mecanismo de
error de siempre (`role="alert"`, mensaje que nombra la acción correctiva:
*"Ingresá un porcentaje entero, sin decimales (por ejemplo 10, no 10,6)."* o
*"Ingresá un monto entero, sin decimales."* según `kind`), sin llamar a `onConfirm`.
El campo sigue siendo `type="number"` (con `step={1}` agregado como pista nativa),
porque restringir el `<input>` a nivel de teclado habría bloqueado pegar un valor o
usar las flechas del navegador — la validación real es al confirmar, igual que el
resto de las validaciones del mismo diálogo (motivo obligatorio, valor > 0).
Test nuevo: `src/features/orders/__tests__/DiscountDialog.test.tsx` (3 casos:
porcentaje con decimales rechazado, monto con decimales rechazado, entero aceptado
tal cual — nunca redondeado).

## 5. Accesibilidad y responsive

- **Botones e interactivos ≥ 44 px** (`min-h-11`/`h-11`/`h-10` en filtros, igual
  que el resto del proyecto) en `AttentionCard`, `StatTile` no interactivo (no
  necesita target), filtros y `CsvExportButton`.
- **Gráficos con alternativa de tabla siempre visible** (WCAG 2.1: "tabla
  accesible como alternativa de todo gráfico"): `CategoryBars`/`TrendLine` llevan
  `role="img"` + `aria-label` que dice explícitamente "el detalle exacto está en
  la tabla de abajo", y esa tabla SIEMPRE se renderiza al lado (nunca detrás de
  un toggle) en Hoy (ventas por hora), Ventas (group_by) y Pedidos (cocina por
  estación).
- **Color nunca como única señal**: `tone` (`default/warning/critical`) de
  `StatTile`/`AttentionCard` cambia borde y color de texto, pero el texto
  (`hint`, título, cuerpo) y a veces el ícono ya dicen lo mismo; nunca un color
  crudo — todo sale de tokens (`--destructive`, `--border`, `--primary`,
  `--muted`) referenciados por variable CSS o clase de Tailwind, nunca un
  hex/oklch a mano. Claro/oscuro heredado gratis de los tokens existentes.
- **Foco visible**: `AttentionCard` y el botón "Ver detalle" de Pedidos declaran
  `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`
  explícito; el resto de los interactivos nuevos son `<input>`/`<select>`/`<a>`
  nativos, que heredan el anillo de foco por defecto del proyecto
  (`index.css`: `* { outline-ring/50 }`, nunca `outline: none`).
- **Corrección de accesibilidad heredada de 1b-1**: `OrdersAdminPage.tsx` abría el
  detalle de una comanda con `<TableRow onClick={...}>`, sin ningún equivalente de
  teclado (un `<tr>` no es focoseable ni dispara `onClick` con Enter/Espacio). Se
  agregó un botón real ("Ver detalle #N →") por fila, operable con teclado y con
  nombre accesible único por fila; el `onClick` de la fila se dejó como
  conveniencia de mouse (no rompe nada, sólo deja de ser la única forma de
  abrir el detalle).
- **Tablas con `overflow-x-auto` propio** (única excepción a "sin scroll
  horizontal" permitida, igual que 1b-1) — las pantallas de Admin no llevan la
  restricción de 375 px del POS (esa es sólo para `PosLayout`/`PosHome`, que no
  toqué).
- **No pude verificar en navegador real** (mismo motivo que 1b-1: sin entorno
  gráfico en esta sesión): contraste AA y el layout a 375/1024 px de estas
  pantallas de Admin se verificaron por estructura y por las clases usadas
  (tokens del proyecto ya auditados en 1a/1b-1), no por captura visual.

## 6. Gaps

1. **`backend-reportes.md` no existía cuando escribí esto** (`outputs-1b-2/`
   sólo tenía `backend-clientes-dinero.md`, `backend-fiscal.md`,
   `frontend-fiscal.md`). Leí el código real de `backend/app/reports/**` y de
   `admin_list_orders` en `backend/app/orders/service.py` directamente (ya
   escrito y funcional) para construir el contrato de `src/api/reports.ts` y la
   ampliación de `src/api/orders.ts`. El Conciliador debería cruzar §2 contra
   `backend-reportes.md` cuando exista — si ese output declara algo distinto de
   lo que el código tenía al momento de escribir esto, manda el output.
2. **Sin comparación "vs. ayer" ni "vs. el promedio"** en ningún `StatTile` de
   Hoy o Ventas: ninguno de los cuatro endpoints que consumo manda un período de
   comparación. Si el dueño de la spec la quiere, es un campo nuevo en el
   backend (`GET /admin/today` con `yesterday: {...}`, por ejemplo), no algo que
   el frontend puede calcular con una segunda consulta sin arriesgar una
   comparación de fechas de negocio mal alineada.
3. **`Ventas por hora` no rellena las horas sin ventas con 0** (ver §3): si se
   quiere el "shape" completo del día (por ejemplo, para comparar aperturas
   distintas entre sedes), hace falta que el backend mande el rango de horas de
   operación de la sede o una lista ya completa de 24 buckets.
4. **`GET /admin/employees/{id}/activity` y `/admin/documents`/`/admin/notes` no
   son territorio mío** (shifts/payments/fiscal, respectivamente) — Ventas
   enlaza a las pantallas que ya los consumen en vez de duplicarlos. Si el dueño
   de la spec prefiere ver "documentos con detalle" embebido dentro de Ventas en
   vez de como enlace, es una decisión de producto, no algo que yo pueda resolver
   sin invadir el territorio de `frontend-fiscal`.
5. **No verifiqué contra un backend corriendo** (mismo patrón que el resto del
   equipo en este pedido): todos los tests mockean `@/api/reports`/`@/api/orders`;
   no hay un test de integración de punta a punta contra `uvicorn` real acá.
6. **`PinPad`, medios de pago del dispositivo, ancho de impresión por sede y
   rondas tras unir comandas** (gaps de 1b-1, `docs/ESTADO.md § Dónde retomar`
   punto 7): ninguno entra en mi misión de 1b-2 (Hoy/Ventas/Pedidos/router). No
   los toqué y no desaparecen en silencio — siguen declarados donde ya estaban.

## 7. Verificación (comandos y resultado literal)

```
$ cd frontend && npx vitest run src/features/reports src/features/orders src/app src/components
 Test Files  20 passed (20)
      Tests  62 passed (62)

$ cd frontend && npm run typecheck
> frontend@0.0.0 typecheck
> tsc --noEmit -p tsconfig.app.json
(sin salida — limpio)
```

No corrí `npm run test` completo ni `npm run build` (prohibidos para este agente,
hay otros cuatro agentes en paralelo sobre el mismo árbol). No instalé ninguna
librería nueva (`package.json` sin tocar).
