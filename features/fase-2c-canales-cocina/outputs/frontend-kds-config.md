# `frontend-kds-config` — pedido 2c («Canales y cocina»): KDS y Configuración

Agente de frontend dueño de la **pantalla de cocina completa (KDS)**, de
**Configuración** (§9.3) y del **único registro de rutas** (`src/app/**`) en
el pedido 2c. Stack: React + TypeScript + Tailwind + shadcn/ui,
react-router-dom, TanStack Query.

Territorio: `frontend/src/features/kitchen/**` (nuevo, lo creé yo),
`frontend/src/features/settings/**`, `frontend/src/api/kitchen.ts`,
`frontend/src/api/channels.ts` (nuevo), `frontend/src/api/stores.ts` (leído,
no necesité escribirle nada), `frontend/src/app/{router.tsx,nav.ts,
AdminLayout.tsx,PosLayout.tsx}`. No toqué nada fuera de ahí — en particular
no toqué `frontend/src/features/orders/**` (ni `KitchenPage.tsx`),
`features/payments/**`, `features/catalog/**`, `features/shifts/**`,
`features/inventory/**`, `features/purchases/**`,
`frontend/src/api/{orders,payments,catalog,shifts}.ts`, `frontend/src/audit/**`
ni ningún archivo de `backend/`. `nav.ts` no necesitó cambios: `NavItem` ya
era lo bastante genérico.

Leí completos antes de escribir una línea: `docs/ESTADO.md`, `AGENTS.md`,
`docs/SPEC-NEGOCIO.md` (§3.3, §4.3, §9.2, §9.3, §11, §14),
`features/fase-2-costo-inventario/outputs-2b/ENTREGA.md`,
`features/fase-2c-canales-cocina/spec.md`, y los tres entregables de backend
ya publicados en `features/fase-2c-canales-cocina/outputs/`:
`backend-kds.md` (contrato C1 del KDS, con ejemplos de JSON reales),
`backend-canales-comanda.md` (precio por canal, domicilio, curso/marchar,
seed) y `backend-dinero-canales.md` (plataformas, comisión, contrato C2). El
código: `KitchenPage.tsx`/`api/kitchen.ts`/`orders/hooks.ts`/`orders/lib.ts`
(lectura — referencia de estilo, sin tocarlos), `features/settings/**`
completo, `app/{router.tsx,nav.ts,AdminLayout.tsx,PosLayout.tsx}`,
`features/{shifts,orders}/index.ts` (el patrón de manifiesto),
`features/inventory/lib.ts` (`formatBasisPoints`), y el backend real
(`app/kitchen/{router,service,schemas}.py`, `app/channels/{router,schemas,
service}.py`, `app/orders/service.py::_CHANNEL_FEATURE`/`active_channels`,
`app/core/features.py`) para no adivinar un campo ni una regla de gate.

---

## 1. Qué construí, archivo por archivo

### `frontend/src/api/kitchen.ts` (existente, extendido)

Se mantiene `listKitchenRounds`/`KitchenRoundOut`/`KitchenRoundItemOut` de
1b sin tocar su forma base (con `kitchen.kds` apagada el backend no manda
los campos nuevos, así que los tipos los declaran **opcionales**, nunca
requeridos: `course_fired_at?`, `bumped_by?`, `bumped_at?` por ítem,
`platform?` por ronda — `undefined` cuando la flag está apagada, `null`
cuando está encendida pero no aplica; nunca se confunden). Agregado, con el
contrato exacto de `backend-kds.md §2`:

- `EmployeeRef`, `KitchenRoundPlatformOut`.
- `KitchenItemStateOut`, `bumpItem(itemId, idempotencyKey?)`,
  `unbumpItem(itemId, idempotencyKey?)` — `POST /kitchen/items/{id}/bump` /
  `.../unbump`.
- `KitchenExpediteItemOut`, `KitchenExpediteOut`,
  `expediteOrder(orderId, idempotencyKey?)` — `POST
  /kitchen/orders/{id}/expedite`.
- `KitchenPrintJobItemOut`, `KitchenPrintJobOut`, `listPrintJobs(station?)`,
  `registerPrintJob({round_id, station}, idempotencyKey?)` — `GET`/`POST
  /kitchen/print-jobs`.

Las cuatro funciones de escritura reciben una `Idempotency-Key` con default
`newIdempotencyKey()` (evaluado en cada llamada, no memoizado): quien llama
puede pasar la suya (para un test, o para un reintento deliberado con la
MISMA clave) y si no, cada click es una clave nueva — el caso normal de "dos
toques" nunca choca con `409 IDEMPOTENCY_IN_PROGRESS` (ese código sólo sale
si dos requests concurrentes comparten clave mientras la primera no
terminó, `backend-kds.md §2`).

Ningún tipo de este archivo declara `cost`/`margin`/`unit_cost`: no es una
omisión, es que el backend no los manda (verificado leyendo
`app/kitchen/schemas.py` completo, que lo dice en su propio docstring y lo
prueba `tests/kitchen/test_no_cost_leak.py`).

### `frontend/src/api/channels.ts` (nuevo — CONTRATO C7)

Ver §4.

### `frontend/src/features/kitchen/` (nuevo, territorio propio)

| Archivo | Qué hace |
|---|---|
| `lib.ts` | Puro formato: `CHANNEL_LABEL`/`channelLabel` (conjunto declarado desde `backend/app/orders/models.py::OrderChannel`), `COURSE_LABEL`/`courseLabel` (defaults de §3.3, cae al texto crudo para un curso configurado que no está en la lista — `StoreSalesSettings.courses` es libre por sede), `elapsedFromSeconds`, `SEMAPHORE_LABEL`/`SEMAPHORE_CLASS` (mismo criterio tokenizado-con-excepción que `KitchenPage.tsx`, documentado en el propio archivo). Nada de plata, nada de recálculo: el semáforo y el orden los pinta tal cual el backend. |
| `hooks.ts` | `useKdsRounds`/`useKdsPrintJobs` con sondeo cada 5 s (mismo rango 3-8 s que SPEC-NEGOCIO §9.1 pide para mesas/turno/agotados) y namespace de caché propio (`["kds", ...]`), separado del de `features/orders/hooks.ts` (`["kitchen", ...]`) — las dos pantallas piden el MISMO `GET /kitchen/rounds` pero son cachés independientes, sin estado compartido con territorio ajeno. |
| `KdsPage.tsx` | La pantalla. Ver detalle abajo. |
| `index.ts` | `kitchenFeature = { posRoutes, posNav }` — el manifiesto (CONTRATO C8, ver §5). Sin `adminRoutes`/`adminNav`: el KDS es puramente de dispositivo (§9.2). |
| `__tests__/fixtures.ts`, `KdsPage.test.tsx`, `index.test.ts`, `lib.test.ts` | Ver §6. |

**`KdsPage.tsx`**, gateada por `hasFeature("kitchen.kds")` (si está apagada,
`EmptyState` que nombra la acción correctiva, y **no pide ningún dato** —
verificado con test: `listKitchenRoundsMock` no se llama):

- **Filtro por estación**: mismo patrón que `KitchenPage.tsx` — se deriva de
  las estaciones presentes en las rondas actuales (chips «Todas» + una por
  estación conocida). Declarado como decisión en §7: no lo saco de
  `GET /admin/stores/{id}/sales-settings` porque esa ruta exige
  `current_admin` y es **inalcanzable desde una sesión de dispositivo**.
- **Rondas agrupadas por comanda** (`groupRoundsByOrder`): la API devuelve
  rondas sueltas, pero «expedir» actúa sobre la comanda COMPLETA (todas sus
  rondas), así que agrupo antes de pintar y pongo un solo botón «Expedir
  comanda» por comanda — nunca uno por ronda, que insinuaría que sólo
  expedita esa ronda.
- **Por ítem**: nombre, cantidad, modificadores, nota, badge de curso,
  badge «Marchado» si `course_fired_at != null`, semáforo **pintado tal
  cual llega** (`item.semaphore`/`item.elapsed_seconds`, nunca recalculado
  en el cliente), y un botón «Bump» (`sent` → `ready`) o «Deshacer»
  (`ready` → `sent`) según `item.status`. Deshabilitado mientras hay un
  pedido en vuelo — un doble toque del mismo dedo nunca dispara dos
  requests; si igual llegaran dos (dos personas en la misma pantalla
  compartida), el backend responde `changed: false` sin error y la pantalla
  no queda en un estado raro (probado: test «bumpear dos veces… no rompe la
  pantalla»).
- **«Expedir comanda»**: `POST /kitchen/orders/{id}/expedite`. Deshabilitado
  si no queda ningún ítem `sent` en ninguna de sus rondas (`changed: false`
  del backend no es error, pero tampoco tiene sentido ofrecer el botón
  cuando no hay nada que expedir).
- **Plataforma**: si `round.platform` no es `null`, una badge
  `«{source} · {external_id}»` — **nunca** un campo de comisión (el backend
  no lo manda al KDS; si algún día lo mandara sería un defecto DEL BACKEND,
  no algo que este archivo esconda).
- **Pestaña «Impresión por estación»**: lista `GET /kitchen/print-jobs`
  (dockets por ronda+estación) con un texto explícito arriba («no envía
  nada a una impresora física — impresora térmica real: fase 3») y un botón
  «Confirmar impresión» / «Reimprimir» por docket, que llama `POST
  /kitchen/print-jobs`. **No simula que imprimió**: sólo registra.
- **Accesibilidad/responsive**: botones `h-11` (≥44 px), foco visible
  (heredado de los componentes shadcn/ui del proyecto, sin overrides),
  grid `grid-cols-1 md:grid-cols-2 xl:grid-cols-3` (sin scroll horizontal a
  375/1024 px — verificado por inspección de clases, no en navegador real:
  ver §7), semáforo con texto+color (no sólo color) para contraste AA.
- **No navega a ninguna otra pantalla** (mismo invariante que
  `KitchenPage.tsx`): probado.

### `frontend/src/features/settings/ChannelsSection.tsx` (nuevo)

Ver §4 y §5.

### `frontend/src/features/settings/SettingsPage.tsx` (editado)

Una pestaña nueva, «Canales y plataformas», entre «Ventas» y «UVT» (mismo
orden en que §9.3 los nombra en la fila de Configuración: "...propina
sugerida, límites de descuento, motivos, medios de pago..., **canales
activos, estaciones, cursos y tiempos objetivo, plataformas y
comisiones**..."). Dos líneas: el `import` y las dos entradas
(`TabsTrigger`/`TabsContent`). No toqué ninguna otra pestaña.

### `frontend/src/app/router.tsx` (editado, CONTRATO C8)

Import de `kitchenFeature` + `...kitchenFeature.posRoutes` en los hijos de
`/pos`, junto al resto (`shiftsFeature`, `ordersFeature`, `paymentsFeature`,
`inventoryFeature`, `recipesFeature`). Sin `adminRoutes` que agregar. Un
comentario nuevo en el docstring del array `routes` nombrando el contrato.
No toqué ningún manifiesto ajeno (`ordersFeature`, `shiftsFeature`, etc.) ni
ninguna ruta que no fuera la mía.

### `frontend/src/app/PosLayout.tsx` (editado, CONTRATO C8)

`kitchenFeature.posNav` agregado al final de `buildPosNav` (después de
`inventoryFeature.posNav`), con el comentario del bloque actualizado. La
vista mínima de 1b («Cocina», `kitchen.view`) sigue viniendo de
`ordersFeature.posNav`, **sin tocar** — con `kitchen.kds` apagada, la barra
del POS queda byte a byte igual a como estaba (verificado: el test
`PosLayout.test.tsx` que afirma "oculta Cocina, con pos.tables encendida y
kitchen.view apagada" sigue pasando tal cual, sin mockear `kitchenFeature`
—se deja real, igual que `recipesFeature`/`inventoryFeature`— y sin que yo
lo haya tenido que tocar).

### `frontend/src/app/AdminLayout.tsx`, `frontend/src/app/nav.ts`

**No los toqué.** El KDS no tiene pantalla de admin propia; «Configuración»
ya existe en `OWN_NAV` de `AdminLayout.tsx` desde 1a. `NavItem` (`nav.ts`)
ya era lo bastante genérico (`{to, label, feature?, icon?}`) para mi
manifiesto.

### `frontend/src/app/__tests__/router.test.tsx` (editado)

Agregué una prueba nueva (`/pos monta kds (kitchenFeature) — pedido 2c,
CONTRATO C8`) que verifica `findChild(children, "kds")` contra el router
REAL (sin mockear `kitchenFeature`, mismo criterio que `inventoryFeature`/
`recipesFeature`/`purchasesFeature`) y que `cocina` (la ruta de 1b) sigue
ahí. Actualicé el comentario que explica qué se deja real y por qué.

---

## 2. Lista EXACTA de endpoints y campos que consumo (para el conciliador, contra el OpenAPI real)

### Desde `features/kitchen/**`

| Método y ruta | Campos que leo | Campos que mando |
|---|---|---|
| `GET /kitchen/rounds?station=` | `order_id, round_no, sent_at, elapsed_seconds, channel, tables, takeout_name, covers, items[].{item_id,name,qty,modifiers_text,note,course,station,status,elapsed_seconds,target_minutes,semaphore}` (1b, sin cambios) **+ con `kitchen.kds`:** `platform.{source,external_id}\|null`, `items[].course_fired_at`, `items[].bumped_by.{id,name}\|null`, `items[].bumped_at` | `station` (query, opcional) |
| `POST /kitchen/items/{item_id}/bump` | `item_id, order_id, status, ready_at, changed, bumped_by.{id,name}\|null, bumped_at` | nada en el body; header `Idempotency-Key` |
| `POST /kitchen/items/{item_id}/unbump` | igual que arriba | igual que arriba |
| `POST /kitchen/orders/{order_id}/expedite` | `order_id, changed, changed_item_ids[], items[].{item_id,name,status,station}, expedited_by.{id,name}, expedited_at` | nada en el body; `Idempotency-Key` |
| `GET /kitchen/print-jobs?station=` | `order_id, round_id, round_no, station, channel, tables[], items[].{item_id,name,qty,modifiers_text,note}, item_count, printed, printed_at, printed_by.{id,name}\|null, print_count` | `station` (query, opcional) |
| `POST /kitchen/print-jobs` | igual que el `GET`, un solo objeto | `{round_id, station}`; `Idempotency-Key` |

### Desde `features/settings/ChannelsSection.tsx`

| Método y ruta | Campos que leo | Campos que mando |
|---|---|---|
| `GET /admin/platforms?store_id=&active=` | `id, store_id, name, code, commission_bp, active, created_at, updated_at` (array) | `store_id`, `active` (query, opcional — sin él trae activas E inactivas) |
| `POST /admin/platforms?store_id=` | igual, un objeto | body `{name, code, commission_bp}` |
| `PATCH /admin/platforms/{id}?store_id=` | igual | body `{name?, commission_bp?, active?}` |
| `DELETE /admin/platforms/{id}?store_id=` | igual | — |

Ninguna de las dos pantallas manda ni lee `cost`/`margin`/`unit_cost`/
`commission_bp` fuera de `/admin/**`. `GET /admin/stores/{id}/sales-settings`
(estaciones/cursos/tiempos objetivo) **no lo toqué**: ya lo consume
`SalesSection.tsx` desde 1b (ver §6).

---

## 3. Qué NO consumo (gap declarado, no adivinado)

`backend-dinero-canales.md` publica también `GET /admin/platforms/{id}/summary`,
`GET /admin/platform-commissions`, `GET /admin/platform-receivables` y `POST
/admin/platform-cancellations`. **No los consumo.** Mi misión es KDS +
Configuración (§9.3: "canales activos, plataformas y comisiones, estaciones,
cursos y tiempos objetivo"), no el reporte de comisiones/cuentas por cobrar
ni la cancelación de una venta de plataforma — eso es lectura y acción de
**Admin → Dinero/Pedidos** (`app/channels/router.py` lo llama "superficie de
admin" en su propio docstring, distinto de la CRUD de configuración de
§9.3), y no hay ningún agente de frontend corriendo en este equipo que lo
tenga asignado (declarado también por `backend-dinero-canales.md § Rojos y
dudas` y por `backend-canales-comanda.md § Rojos y dudas`, ambos con la
misma observación). Publicar esos tipos sin un consumidor real sería
inventar contrato de más; los dejo como gap explícito para que el próximo
reparto los nombre.

---

## 4. CONTRATO C7 — qué publiqué en `src/api/channels.ts`, con sus tipos exactos

```ts
export interface DevicePlatformOut { id: number; name: string; code: string }
export function listDevicePlatforms(): Promise<DevicePlatformOut[]>

export interface PlatformOut {
  id: number; store_id: number; name: string; code: string
  commission_bp: number; active: boolean; created_at: string; updated_at: string
}
export interface PlatformIn { name: string; code: string; commission_bp: number }
export interface PlatformUpdateIn { name?: string; commission_bp?: number; active?: boolean }

export function listPlatforms(storeId: number, params?: { active?: boolean }): Promise<PlatformOut[]>
export function createPlatform(storeId: number, data: PlatformIn): Promise<PlatformOut>
export function updatePlatform(storeId: number, platformId: number, data: PlatformUpdateIn): Promise<PlatformOut>
export function deactivatePlatform(storeId: number, platformId: number): Promise<PlatformOut>
```

`commission_bp` viaja como `number` entero (puntos básicos, 100 = 1 %) en
TODOS los tipos — nunca `float`, mismo criterio que publica
`backend-dinero-canales.md §3`. No hay una segunda función de formato: la
única que sabe que 100 = 1 % es `formatBasisPoints`
(`features/inventory/lib.ts`, precedente de 2b), y la importo tal cual en
`ChannelsSection.tsx` en vez de escribir `bp / 100` o `bp * 100` sueltos —
es literalmente lo que pide C7 ("la escala se centraliza en UNA sola
función de formato").

**Verificado contra el consumidor real, no sólo declarado**: leí
`frontend/src/features/orders/NewOrderPage.tsx` (territorio de
`frontend-pos-canales`) ANTES de escribir el archivo — ya tenía
`import { listDevicePlatforms, type DevicePlatformOut } from "@/api/channels"`
con un comentario que nombra el contrato, y su test
(`__tests__/NewOrderPage.test.tsx`) mockea `@/api/channels` con la forma
`{id, name, code}` exacta que publiqué. Corrí ESE test (ajeno, de sólo
lectura — no lo modifiqué) para confirmar que mi archivo lo satisface de
punta a punta:

```
$ TMPDIR=/tmp/pt-frontend-kds-config npx vitest run src/features/orders/__tests__/NewOrderPage.test.tsx
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

El nombre no cambió (`listDevicePlatforms`/`DevicePlatformOut`), y no lo
duplico en ningún otro archivo: `ChannelsSection.tsx` importa `PlatformOut`
del MISMO `api/channels.ts`, nunca redeclara la forma.

---

## 5. CONTRATO C8 — cómo verifiqué el cableado de rutas contra el router REAL, sin mockear

1. Antes de tocar `router.tsx`/`PosLayout.tsx`, leí `features/orders/index.ts`
   y `features/shifts/index.ts` completos para copiar el patrón exacto de
   manifiesto (`RouteObject[]`/`NavItem[]` con `createElement`, sin JSX en el
   archivo de manifiesto).
2. Después de cablear, corrí `src/app/__tests__/router.test.tsx` — que
   **construye el router real** (`const { router } = await import("../router")`)
   y sólo mockea `shiftsFeature`/`catalogFeature`/`ordersFeature` (declarado en
   el propio archivo, con el motivo escrito); `kitchenFeature` queda **real**,
   igual que `paymentsFeature`/`inventoryFeature`/`recipesFeature`/
   `purchasesFeature` — es la verificación de que `router.tsx` integra mi
   manifiesto TAL COMO lo exporta `features/kitchen/index.ts`, no una versión
   mockeada que podría divergir del archivo real.
3. Agregué la prueba que falta (ver §1) y confirmé que la ruta de 1b
   (`cocina`) sigue montada sin cambios — checklist de la spec ("con
   `kitchen.kds` apagada, todo lo de 1b sigue idéntico").
4. Corrí también `src/app/__tests__/PosLayout.test.tsx` (que sí construye el
   layout real con `renderWithProviders`, mockeando sólo `ordersFeature`/
   `shiftsFeature`) para confirmar que agregar `kitchenFeature.posNav` a
   `buildPosNav` no rompe ninguna aserción existente sobre qué aparece y qué
   no según flags.
5. No corrí un navegador real (ver §7 — gap declarado, mismo que dejaron
   abiertos los tres agentes de backend de este pedido).

Salida real de las dos pruebas de integración (parte de la corrida completa
de §6):

```
✓ src/app/__tests__/router.test.tsx > ... > /pos monta kds (kitchenFeature) — pedido 2c, CONTRATO C8
✓ src/app/__tests__/PosLayout.test.tsx > ... > muestra Cocina cuando kitchen.view está encendida
✓ src/app/__tests__/PosLayout.test.tsx > ... > muestra Mesas y Turno, oculta Cocina, con pos.tables encendida y kitchen.view apagada
```

---

## 6. Estaciones, cursos y tiempos objetivo: qué YA existía, qué agregué

**Ya existía, completo, desde 1b** (`SalesSection.tsx`, líneas ~243-291 al
momento de leerlo): un `Textarea` de «Estaciones» (una por línea, escribe
`StoreSalesSettings.stations`), un `Textarea` de «Cursos» que además
reinicia `course_target_minutes` para cursos nuevos con un default de 10
minutos (`setCourses`), y un `fieldset` con un `Input` numérico de minutos
por cada curso configurado — los tres contra `GET/PUT
/admin/stores/{id}/sales-settings`, con `SalesSettings` ya tipado en
`api/stores.ts`. Es exactamente lo que el KDS necesita: el semáforo que
pinta `KdsPage.tsx` lo calcula el backend leyendo estas mismas columnas
(`app/kitchen/router.py::get_kitchen_rounds` lee
`settings.course_target_minutes`).

**Agregué**: nada a `SalesSection.tsx`. Construir una segunda pantalla para
el mismo campo habría sido "dos formularios que escriben el mismo campo",
que es exactamente lo que la misión pidió evitar. Lo único que agregué es
un **puntero** de tres líneas en `ChannelsSection.tsx` («Ya se editan en la
pestaña Ventas…») para que quien busque "estaciones/cursos" bajo «Canales y
plataformas» (donde §9.3 los nombra en la misma fila) no crea que faltan.

**Canales activos**: también existía, completo, desde 1a
(`StoreFormDialog.tsx`, pestaña Sedes): un checkbox por canal contra
`Store.active_channels`. Lo verifiqué contra el backend real
(`app/orders/service.py::create_order`, línea ~673) y confirmé que
`active_channels` sólo se chequea para `counter`/`dine_in`/`takeout` — los
canales `delivery` y `platform` de este pedido se gatean EXCLUSIVAMENTE por
su flag (`_CHANNEL_FEATURE`, línea ~617: `DELIVERY → "pos.delivery"`,
`PLATFORM → "pos.platforms"`). No agregué una casilla «Domicilio»/
«Plataforma» a `active_channels` porque sería un control que no controla
nada — ver §7, R-1, sobre la casilla «Domicilio» que YA está ahí (de antes
de este pedido) sin ningún efecto.

---

## 7. Rojos y dudas

- **R-1 — `StoreFormDialog.tsx` (pre-existente, no construido por mí) tiene
  una casilla «Domicilio» en `active_channels` que no controla nada.**
  `app/orders/service.py::create_order` sólo lee `active_channels` para
  `counter`/`dine_in`/`takeout` (verificado leyendo el código, línea 673);
  el canal `delivery` se gatea únicamente por `pos.delivery`. Prender o
  apagar esa casilla no tiene ningún efecto sobre si se puede crear una
  comanda de domicilio. No es un defecto de 2c —la casilla es anterior— y
  no lo toqué: sacarla cambiaría comportamiento de UI publicado fuera del
  alcance de mi misión sin que nadie lo pidiera. Lo dejo señalado con el
  archivo y la línea exactos para que el dueño de la spec decida si se
  saca la casilla o se le da un efecto real.
- **R-2 — el filtro por estación del KDS se deriva de las rondas en
  pantalla, no de `StoreSalesSettings.stations`.** Decisión declarada
  (§1): `GET /admin/stores/{id}/sales-settings` exige `current_admin` y es
  inalcanzable desde la sesión de dispositivo que corre el KDS. Mismo
  límite que ya tenía `KitchenPage.tsx` desde 1b (no es una regresión).
  Efecto: una estación configurada sin ningún ítem pendiente ahora mismo no
  aparece como chip de filtro hasta que le llegue algo.
- **R-3 — el gate de identidad de `/pos/*` es más estricto que lo que el
  backend permite para el KDS.** `PosLayout.tsx` redirige a
  `/pos/identify` si no hay `me.employee`, para TODO `/pos/*` — heredado,
  sin tocar (afecta a los ocho dominios de `/pos`, no sólo al mío). Pero
  `backend-kds.md §2` documenta que `GET /kitchen/rounds` y `GET
  /kitchen/print-jobs` **no** exigen persona identificada a propósito
  ("una pantalla de cocina puede no tener a nadie identificado"). Hoy esa
  posibilidad no se aprovecha: sin identificarse, ni siquiera se puede
  MIRAR el KDS. No lo cerré porque tocar el gate de `PosLayout.tsx`
  cambiaría el comportamiento de las otras siete pantallas de `/pos` que no
  son mías, a mitad de una construcción en paralelo. Señalado para que se
  discuta como cambio propio, con dueño.
- **No construí ninguna pantalla para
  `PlatformSummaryOut`/`PlatformCommissionOut`/`PlatformReceivableOut`/
  `PlatformCancellationOut`.** Ver §3: gap declarado, no adivinado — es
  Admin → Dinero/Pedidos, no Configuración, y ningún agente de este equipo
  lo tiene asignado.
- **No verifiqué el recorrido en navegador real** (checklist de la spec,
  último ítem): no corrí un navegador contra `frontend/dist` — es el mismo
  gap que los tres agentes de backend de este pedido dejaron declarado (no
  hay build compartido corriendo hasta que el orquestador lo arme en serie
  al final). 375/1024 px sin scroll horizontal lo verifiqué por inspección
  de clases (`grid-cols-1 md:...`, sin anchos fijos ni `w-screen`), no con
  un medidor real de contraste ni con la ventana redimensionada de verdad.
- **`docs/ESTADO.md` § "Glosario español↔código" no tiene entradas para lo
  que trae 2c** (`delivery`→domicilio, `platform`→plataforma, `course_fired_at`
  /`fire_course`→marchar, `bump_item`/`expedite_order`→bump/expedir,
  `kitchen.kds`→KDS completo). No lo toqué: es el mismo patrón que siguieron
  los tres agentes de backend de este pedido (ninguno tocó `docs/ESTADO.md`
  — se actualiza de una vez cuando el Maestro cierra el pedido, como pasó al
  cerrar 2a/2b). Lo señalo para ese momento.
- **No construí un tercer `courseLabel`/`CHANNEL_LABEL` compartido entre
  `features/orders/lib.ts` y `features/kitchen/lib.ts`.** Son dos copias
  del mismo mapa pequeño (seis canales, cuatro cursos), declaradas cada una
  contra `backend/app/orders/models.py::OrderChannel` como fuente — decisión
  deliberada (no un descuido): importar de `features/orders/**`
  (territorio ajeno, en construcción en paralelo en este mismo pedido)
  habría creado un acoplamiento no declarado como contrato; el precedente
  del repo (`features/shifts/__tests__/*`, `features/inventory/__tests__/*`,
  cada una con su propio `deviceMe`) es exactamente "cada feature con su
  propia copia chica de fixtures/formato", no un `lib.ts` compartido entre
  dominios sin dueño.
- **Nada más quedó sin cerrar dentro de mi territorio**: los tres puntos
  de la misión (KDS, Configuración, router) están construidos y verificados
  contra el contrato real publicado por los tres agentes de backend
  (`backend-kds.md`, `backend-canales-comanda.md`, `backend-dinero-canales.md`),
  leídos completos antes de escribir cada tipo.

---

## 8. Verificación (territorio propio, no la suite completa)

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-kds-config npx vitest run src/features/kitchen src/features/settings src/app --reporter=verbose

 ✓ src/features/settings/__tests__/ChannelsSection.test.tsx (7 tests)
 ✓ src/features/settings/__tests__/InventorySection.test.tsx (5 tests, preexistente — sigue en verde)
 ✓ src/features/kitchen/__tests__/KdsPage.test.tsx (8 tests)
 ✓ src/features/kitchen/__tests__/lib.test.ts (3 tests)
 ✓ src/features/kitchen/__tests__/index.test.ts (2 tests)
 ✓ src/app/__tests__/AdminLayout.test.tsx (9 tests, preexistente — sigue en verde)
 ✓ src/app/__tests__/PosLayout.test.tsx (3 tests, preexistente — sigue en verde)
 ✓ src/app/__tests__/PosHome.test.tsx (2 tests, preexistente — sigue en verde)
 ✓ src/app/__tests__/router.test.tsx (9 tests: 8 preexistentes + 1 nueva)

 Test Files  9 passed (9)
      Tests  48 passed (48)
   Start at  22:57:29
   Duration  5.85s
```

```
$ cd frontend && npm run typecheck
> tsc --noEmit -p tsconfig.app.json
(sin salida — limpio)
```

Además, de sólo lectura (no forma parte de mi territorio, pero confirma que
CONTRATO C7 cierra del otro lado sin que yo edite nada ajeno):

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-kds-config npx vitest run src/features/orders/__tests__/NewOrderPage.test.tsx
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

No corrí `npm run test` completo ni `npm run build` (AGENTS.md, regla de
verificación: la suite completa y el build son del paso de verificación del
orquestador, en serie, con el árbol quieto — cinco agentes corriendo en
paralelo sobre este mismo repo).

Archivos nuevos: `frontend/src/api/channels.ts`,
`frontend/src/features/kitchen/{lib,hooks,index}.ts`,
`frontend/src/features/kitchen/KdsPage.tsx`,
`frontend/src/features/kitchen/__tests__/{fixtures,index,lib}.test.ts`,
`frontend/src/features/kitchen/__tests__/KdsPage.test.tsx`,
`frontend/src/features/settings/ChannelsSection.tsx`,
`frontend/src/features/settings/__tests__/ChannelsSection.test.tsx`.
Archivos editados: `frontend/src/api/kitchen.ts`,
`frontend/src/features/settings/SettingsPage.tsx`,
`frontend/src/app/router.tsx`, `frontend/src/app/PosLayout.tsx`,
`frontend/src/app/__tests__/router.test.tsx`.
