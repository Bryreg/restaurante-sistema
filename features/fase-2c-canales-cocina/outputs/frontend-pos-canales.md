# `frontend-pos-canales` — Domicilio, plataforma, marchar y precios por canal

Agente: **frontend-pos-canales** (builder). Pedido: `features/fase-2c-canales-cocina/spec.md`.
Territorio de escritura: `frontend/src/features/{orders,payments,catalog,shifts}/**` y
`frontend/src/api/{orders,payments,catalog,shifts}.ts`. No toqué nada fuera de esa lista
(`frontend/src/app/**`, `frontend/src/features/{settings,kitchen}/**`,
`frontend/src/api/{kitchen,channels,stores}.ts`, `frontend/src/audit/**`, backend/) salvo
lecturas.

## Resumen de lo construido

1. **Precio por canal en la carta** (`features/catalog/**`): el formulario de producto ya
   tenía los cuatro campos de precio (mesa obligatorio, los otros tres opcionales) de una
   construcción anterior — lo que faltaba y agregué fue el marcador `is_delivery_fee`
   (checkbox "Es el cargo de domicilio de esta sede", con su explicación) en el tipo, el
   formulario y la tabla de productos, y cambié el "—" ambiguo de un precio de canal vacío
   por **"Igual que mesa"**, que es lo que la spec pide decir sin ambigüedad.
2. **Comanda de domicilio propio** (`pos.delivery`): canal nuevo en `NewOrderPage` con
   dirección, teléfono y domiciliario (reusa `EmployeePicker`). El cargo de domicilio no se
   manda desde el cliente — lo agrega el servidor como ítem al crear la comanda — y
   `OrderPage` lo muestra en la cabecera (dirección, teléfono, domiciliario) tal como llega.
3. **Pedido de plataforma** (`pos.platforms`): canal nuevo con selector de plataforma
   (consumiendo `@/api/channels`, CONTRATO C7 — ver sección propia) y `external_id` tecleado
   a mano. `OrderPage` muestra la plataforma y el número de pedido en la cabecera.
4. **Medios de pago publicados por el backend**: ya estaban resueltos por una construcción
   anterior (`GET /device/payment-methods`, `PaymentSplitsForm.tsx`) — verifiqué que sigue
   sin ningún `if method === "platform"` ni lista fija en el cliente. No hice cambios acá.
5. **«Marchar» un curso** (`pos.courses`, requiere `kitchen.view`): sección nueva en
   `OrderPage` con un botón por curso presente en la comanda; una vez marchado, se
   reemplaza por un aviso con la hora — nunca deja marchar dos veces.
6. **Efectivo de domicilios en el turno** (`features/shifts/**`): renglón nuevo en
   `ShiftSummaryPanel` (aparte del esperado), y una pantalla nueva —
   `DeliverySettlementPanel` — con el pendiente por domiciliario y la liquidación, como
   pestaña nueva "Domicilios" de `ShiftPage` (gateada por `pos.delivery`).
7. **Corregí un H-6 real que encontré en el camino**: `NewOrderPage` mandaba la hora
   prometida de "para llevar" con `new Date(promisedAt).toISOString()`, que interpreta el
   `<input type="datetime-local">` con la zona del NAVEGADOR — exactamente el patrón que la
   misión nombra como prohibido. Ahora se manda el string tal cual lo entrega el input; el
   servidor ya lo interpreta con `app/core/tz.py::from_bogota_wall_clock`.
8. **Corregí un cruce real en `CashMovementCause`**: el backend agregó `delivery_settlement`
   a `CashMovementCauseLiteral` (pedido 2c) y la marcó **sólo-sistema**
   (`_SYSTEM_ONLY_MOVEMENT_CAUSES`, rechazada con `400 CAUSE_NOT_MANUAL` si se manda a
   mano). Agregué la causa y su etiqueta (el contrato que audita
   `src/audit/purchases-counts.test.ts` lo exige), y además excluí esa causa del
   desplegable de "nuevo movimiento" de `MovementsPanel` para no ofrecer una opción que el
   backend siempre rechaza — ese segundo paso no lo pide ningún test heredado, lo agregué
   porque el propio comentario del schema del backend lo señala.
9. **Iteración 3 (ajuste del Maestro sobre H-8)**: nuevo tipo `ShiftTips`/función
   `getShiftTips()` en `frontend/src/api/shifts.ts` para `GET /shifts/{id}/tips`, con
   `delivery_tips`, `delivery_tips_pending` y el campo nuevo `delivery_tips_settled` —
   ver la sección "Iteración 3" bajo Verificación para el detalle completo.

## Archivo por archivo

### `frontend/src/api/orders.ts`
- `OrderStatus`: agregado `"compensated"` (venta de plataforma cancelada después de
  preparar — `app/orders/schemas.py::OrderStatusLiteral`).
- Nuevos tipos de salida: `DeliveryOut` (`address`, `phone`, `courier`),
  `OrderPlatformInfoOut` (`id`, `name`, `external_id`, **sin** `commission_bp`),
  `CourseFireOut` (`course`, `fired_at`, `fired_by`).
- `OrderOut`: agregados `delivery?`, `platform?`, `courses_fired?`.
- Nuevos tipos de entrada: `DeliveryIn` (`address`, `phone`, `courier_employee_id`,
  estricto), `PlatformOrderIn` (`platform_id`, `external_id`, estricto).
- `OrderCreateIn`: agregados `delivery?`, `platform?`.
- Nueva función `fireCourse(orderId, course, body, idempotencyKey)` →
  `POST /orders/{id}/courses/{course}/fire`.

### `frontend/src/api/catalog.ts`
- `ProductAdminOut`, `ProductIn`, `ProductUpdateIn`: agregado `is_delivery_fee` (no
  opcional en `ProductAdminOut`, igual que el resto de los campos que el backend siempre
  manda; opcional en los `In`, con default `false` en el backend).

### `frontend/src/api/shifts.ts`
- `CASH_MOVEMENT_CAUSES`: agregada `"delivery_settlement"`. Nueva constante
  `SYSTEM_ONLY_MOVEMENT_CAUSES` (espejo de `_SYSTEM_ONLY_MOVEMENT_CAUSES` del backend) para
  que la UI sepa qué causas no ofrecer en un desplegable manual.
- `ShiftCurrent` y `ShiftSummary`: agregado `delivery_cash_pending?: number | null`.
- `Breakdown`: agregado `delivery_cash_pending?: number` (informativo, fuera de
  `expected`).
- Sección nueva "Domicilio propio: efectivo pendiente y liquidación" con
  `CourierPending`, `DeliveryPendingList`, `listPendingDeliveryCash()` (`GET
  /delivery-settlements/pending`), `DeliverySettlementIn`, `DeliverySettlement`,
  `createDeliverySettlement()` (`POST /delivery-settlements`), `DeliverySettlementVoidIn`,
  `voidDeliverySettlement()` (`POST /delivery-settlements/{id}/void`). Documenté en el
  archivo por qué estos endpoints (que viven en `app/channels/router.py`, no en
  `app/shifts/router.py`) se publican en `api/shifts.ts`: la pantalla que los consume es
  "el efectivo de domicilios en el turno", mi misión, no la de plataformas.

### `frontend/src/features/orders/lib.ts`
- `channelPriceKey`: ahora resuelve `"delivery"` → `"delivery"` y `"platform"` →
  `"platform"` (antes sólo distinguía `"takeout"` de todo lo demás). Usado por
  `CatalogPanel` e `ItemDialog` para pintar el precio de lista correcto según el canal —
  sin esto, un domicilio o una plataforma mostraban el precio de mesa mientras se armaba el
  pedido (aunque al agregar el ítem el backend ya cobraba bien, la vista previa mentía).
- `ORDER_STATUS_LABEL`: agregado `compensated: "Venta compensada"`.

### `frontend/src/features/orders/NewOrderPage.tsx`
- Dos opciones de canal nuevas: **Domicilio** (`pos.delivery`, ícono `Bike`) y
  **Plataforma** (`pos.platforms`, ícono `Smartphone`).
- Domicilio: campos Dirección, Teléfono y `EmployeePicker` ("Domiciliario"); los tres
  obligatorios (mensajes de validación propios); nota explicando que el cargo lo agrega el
  servidor.
- Plataforma: selector de plataforma (`@/api/channels`, ver CONTRATO C7) con estados de
  carga/error/vacío, y campo de texto para `external_id`; los dos obligatorios.
- Corregido el H-6 de `promised_at` (ver arriba).

### `frontend/src/features/orders/OrderPage.tsx`
- Cabecera: si el canal es `delivery`, agrega dirección, teléfono y "Domiciliario: {nombre}"
  al subtítulo; si es `platform`, agrega el nombre de la plataforma y "Pedido {external_id}".
  Sólo texto, ningún cálculo.
- Sección nueva "Marchar" (sólo con `pos.courses`, y sólo si hay al menos un curso presente
  entre los ítems vivos de la comanda): un botón "Marchar {curso}" por curso no marchado
  aún; una vez marchado, se reemplaza por una insignia "{curso} marchado · {hora}" — nunca
  vuelve a ofrecer el botón (el backend es idempotente, pero una segunda llamada con la
  versión vieja da `409`, así que la UI no depende de esa tolerancia).
- Nuevo manejador `handleFireCourse` con el mismo patrón de manejo de error que el resto de
  la página (`useOrderMutationHandler`, `STALE_VERSION` incluido).

### `frontend/src/features/catalog/ProductForm.tsx`
- Nuevo campo `isDeliveryFee` en `ProductFormValues`, mapeado a/desde
  `is_delivery_fee` en `formValuesToProductIn`/`formValuesToProductUpdateIn`.
- Nuevo checkbox "Es el cargo de domicilio de esta sede" con la explicación (se agrega
  solo, con impuesto, a lo sumo un producto activo por sede).

### `frontend/src/features/catalog/ProductsTab.tsx`
- `priceCell`: "Igual que mesa" en vez de "—" para un precio de canal opcional vacío.
- Columna "Nombre": insignia "Cargo de domicilio" cuando `product.is_delivery_fee`.

### `frontend/src/features/shifts/ShiftSummaryPanel.tsx`
- Renglón nuevo "Efectivo de domicilios pendiente de liquidar (aparte del cajón)",
  visible sólo con `pos.delivery`, pintado tal cual llega de `GET /shifts/{id}`
  (con `GET /shifts/current` como respaldo mientras el resumen completo no cargó) — nunca
  sumado a "Esperado".

### `frontend/src/features/shifts/DeliverySettlementPanel.tsx` (nuevo)
- Pantalla de liquidación: total pendiente (efectivo, propina, total — tal cual llegan),
  tabla por domiciliario con botón "Liquidar" (confirma con nota opcional, sin PIN —
  `DeliverySettlementIn` no lo lleva), y una tabla de "Liquidaciones registradas en esta
  pantalla" con "Deshacer" (motivo obligatorio, tampoco PIN).
- **Gap declarado a propósito** (documentado también en el docstring del componente): no
  existe una ruta de dispositivo/operador para LISTAR liquidaciones ya hechas — sólo `GET
  /admin/delivery-settlements` (`current_admin`). Por eso "Deshacer" sólo alcanza a las
  liquidaciones registradas *en esta pantalla, en esta sesión del navegador* (estado local,
  se pierde al recargar). Si hace falta deshacer una liquidación de un turno anterior o de
  otra tablet, hoy sólo se puede desde Admin (fuera de mi territorio) — no inventé una ruta
  nueva para taparlo.
- **Iteración 2 (ajuste del Maestro sobre H-1, sin cambio de contrato)**: los MISMOS
  números y los MISMOS campos (`amount`, `tip_amount`, `total` de `GET
  /delivery-settlements/pending`) — no toqué `frontend/src/api/shifts.ts` ni
  `frontend/src/api/channels.ts`, no hay ruta nueva. Lo que cambió es el rótulo, porque
  "Efectivo pendiente / Propina pendiente / Total pendiente" pintaba los tres como si
  pesaran igual sobre el esperado del turno, y liquidar un domicilio ahora sólo mueve el
  esperado por la venta — la propina en efectivo entra al cajón pero se salda al cerrar
  turno (`tips_cash_out`), igual que la propina en efectivo de cualquier otra venta.
  Bloque de totales: **"Efectivo — entra al cajón y mueve el esperado al liquidar"** /
  **"Propina — entra al cajón pero no mueve el esperado; se paga como propina"** / "Total
  pendiente (efectivo + propina)". Encabezados de la tabla por domiciliario: **"Efectivo
  (mueve el esperado)"** / **"Propina (no mueve el esperado)"**. Agregué una línea de
  aclaración de una sola oración arriba de la tabla, con el mismo sentido: "Al liquidar,
  el efectivo mueve el esperado del turno; la propina en efectivo entra igual al cajón
  pero no mueve el esperado — se paga como propina, igual que la propina de cualquier
  otra venta." `ShiftSummaryPanel.tsx` no se tocó: su renglón "Efectivo de domicilios
  pendiente de liquidar (aparte del cajón)" seguía siendo correcto.

### `frontend/src/features/shifts/ShiftPage.tsx`
- Pestaña nueva "Domicilios" (gateada por `pos.delivery`) con `DeliverySettlementPanel`.

### `frontend/src/features/shifts/MovementsPanel.tsx`
- `CAUSE_LABEL`: agregado `delivery_settlement: "Liquidación de domicilios"` (el contrato
  que audita `src/audit/purchases-counts.test.ts` — territorio ajeno, sólo lo leí para
  saber qué exige — lee `CashMovementCauseLiteral` del backend y compara contra este mapa).
- Nueva constante `MANUAL_CAUSE_ENTRIES`: las entradas de `CAUSE_LABEL` MENOS las causas de
  `SYSTEM_ONLY_MOVEMENT_CAUSES`. El desplegable "Causa" del formulario de movimiento manual
  ahora usa esta lista en vez de `Object.entries(CAUSE_LABEL)` completo, así que
  `delivery_settlement` nunca aparece como opción manual (el backend la rechazaría con
  `400 CAUSE_NOT_MANUAL`) pero sí tiene etiqueta legible cuando aparece en la tabla de
  movimientos (generada por el sistema al liquidar).

### `frontend/src/features/shifts/hooks.ts`
- Nuevo `DELIVERY_PENDING_QUERY_KEY` y `usePendingDeliveryCash(enabled)` (sondeo cada 5 s,
  mismo criterio que `useCurrentShift`).

## Endpoints y campos consumidos (para cruzar contra el OpenAPI real)

Todos verificados leyendo `backend/app/{orders,catalog,shifts,channels}/{router,schemas}.py`
directamente (territorio ajeno, sólo lectura) antes de tipar el cliente — no asumí ninguno
a ciegas salvo el marcado como C7 más abajo.

| Método y ruta | Uso | Campos que leo/mando |
|---|---|---|
| `POST /orders` | Crear comanda de domicilio o plataforma | mando `channel`, `delivery: {address, phone, courier_employee_id}` o `platform: {platform_id, external_id}` |
| `GET /orders/{id}` (sondeo existente) | Leer `delivery`, `platform`, `courses_fired` de la comanda | leo `delivery.{address,phone,courier.name}`, `platform.{name,external_id}`, `courses_fired[].{course,fired_at}` |
| `POST /orders/{id}/courses/{course}/fire` | Marchar un curso | mando `{expected_version}`, idempotente |
| `GET /catalog` | Carta del POS (ya existía) | leo `prices.{dine_in,takeout,delivery,platform}` (ya resueltos, nunca `null`) |
| `GET /admin/products`, `POST/PATCH /admin/products` | Carta admin | agregué `is_delivery_fee` a lo que mando y leo |
| `GET /device/payment-methods` | Medios de pago (ya existía, sin cambios míos) | `code`, `label`, `requires_reference` |
| `GET /shifts/current` (sondeo existente) | Efectivo de domicilios pendiente (dato liviano) | agregué lectura de `delivery_cash_pending` |
| `GET /shifts/{id}` (resumen, ya existía) | Efectivo de domicilios pendiente (dato completo) | agregué lectura de `delivery_cash_pending` |
| `POST /shifts/{id}/cash-movements` | Movimiento manual (ya existía) | agregué la causa `delivery_settlement` al tipo, y la EXCLUÍ del desplegable manual |
| `GET /delivery-settlements/pending` | Pendiente por domiciliario | leo `couriers[].{courier_employee_id,courier_employee_name,payments_count,amount,tip_amount,total}`, `amount`, `tip_amount`, `total` |
| `POST /delivery-settlements` | Liquidar | mando `{courier_employee_id, note?}` (nunca mando `payment_ids`: uso el default "liquidar todo lo pendiente") |
| `POST /delivery-settlements/{id}/void` | Deshacer liquidación | mando `{reason}` |
| `GET /device/platforms` (CONTRATO C7) | Selector de plataforma al cargar un pedido | **no lo llamo yo**: lo llama `@/api/channels::listDevicePlatforms()`, que yo importo — ver sección siguiente |
| `GET /shifts/{id}/tips` (iteración 3, H-8) | Referencia de sólo lectura junto al campo de propinas del cierre (`CloseWizard`, `SingleStepCloseForm`) | leo sólo `cash_out`; declaro el resto del contrato (`by_method`, `by_employee`, `electronic_liability`, `delivery_tips`, `delivery_tips_pending`, `delivery_tips_settled`) en `ShiftTips` aunque hoy no pinto esos campos, para que `src/audit/channels-round2.test.ts` (el invariante "no declara un tipo propio... que se desincronice") siga cobrando el contrato completo si alguna pantalla futura empieza a leerlos |

## CONTRATO C7 — qué asumí, y estado real del archivo

`frontend/src/api/channels.ts` **no existía cuando corrí** (lo verifiqué con `ls` al
empezar y de nuevo justo antes de cerrar el entregable). Según la misión, esto se declara y
se deja el import apuntando al nombre acordado — así lo hice, en
`frontend/src/features/orders/NewOrderPage.tsx`:

```ts
import { listDevicePlatforms, type DevicePlatformOut } from "@/api/channels"
```

Forma asumida (verificada contra `backend/app/channels/schemas.py::DevicePlatformOut` y
`backend/app/channels/router.py::device_platforms`, que sí existen y ya construyó
`backend-dinero-canales` en este mismo pedido — confirmé leyendo
`features/fase-2c-canales-cocina/outputs/backend-dinero-canales.md`, que nombra
`GET /device/platforms` como "sin comisión: superficie de dispositivo"):

```ts
export interface DevicePlatformOut {
  id: number
  name: string
  code: string
}
export function listDevicePlatforms(): Promise<DevicePlatformOut[]>
```

**Consecuencia real, medida, no supuesta**: con el archivo ausente, Vite no puede resolver
el import y esto rompe la transformación de `NewOrderPage.tsx` — no sólo el typecheck.
Corrí la suite completa de mi territorio para medir el alcance exacto (ver "Tests" abajo):
sólo dos archivos de test quedan sin poder ejecutarse
(`src/features/orders/__tests__/NewOrderPage.test.tsx` y
`src/features/orders/__tests__/index.test.ts`, éste último porque `orders/index.ts`
reexporta `NewOrderPage`), con error `Failed to resolve import "@/api/channels"`. Los otros
28 archivos de test de mi territorio (95 tests) corren y pasan normalmente — el gap no se
propaga más allá de ese archivo. El typecheck del proyecto entero queda con exactamente dos
errores, los dos originados en esa misma línea (`Cannot find module '@/api/channels'` y un
error en cascada de tipos en la misma función).

Elegí **no** crear un `@/api/channels.ts` propio ni copiar el tipo/fetch (la misión lo
prohíbe explícitamente y dice que el typecheck final lo tiene que cobrar) y **no** usar un
`import()` dinámico con especificador no-literal para evadir la resolución de Vite/TS — eso
habría escondido justo el cruce que este contrato existe para exponer. Dejé escritas las
pruebas de `NewOrderPage.test.tsx` para el flujo de domicilio y de plataforma (mockeando
`@/api/channels` con la forma de arriba): no pude correrlas hoy, pero en cuanto
`frontend-kds-config` publique el archivo con esa forma, deberían pasar sin que yo toque
nada más. Si la forma real difiere (otro nombre de función, otros campos), el conciliador
lo va a ver como un error de tipos o de resolución, no como un bug silencioso.

## Rutas y navegación

**No agregué ninguna ruta ni entrada de navegación nueva.** `pos.delivery` y `pos.platforms`
son variantes del canal dentro de la ruta ya existente `/pos/comanda/nueva`
(`NewOrderPage`, ya declarada en `features/orders/index.ts` antes de este pedido) y
`/pos/comanda/:orderId` (`OrderPage`, ídem). La liquidación de domicilios vive como pestaña
nueva dentro de `/pos/turno` (`ShiftPage`, ya declarada en `features/shifts/index.ts`), no
como ruta propia. Por lo tanto **no toqué** `features/orders/index.ts`,
`features/shifts/index.ts`, `features/catalog/index.ts` ni `src/app/router.tsx` — nada del
CONTRATO C8 necesitaba cambiar para este pedido, del lado de mi territorio.

## PinPad y campos de texto

Ninguna pantalla nueva que escribí combina un `PinPad` con campos de texto nuevos: la
comanda de domicilio/plataforma (`NewOrderPage`) no tiene `PinPad`; `DeliverySettlementPanel`
tampoco (`DeliverySettlementIn`/`DeliverySettlementVoidIn` no llevan PIN). El único
`PinPad` que sigue coexistiendo con un campo de texto es el de `PaymentSplitsForm`
(preexistente, cobro con medio que requiere referencia), que ya estaba `disabled` mientras
los montos no cuadran exacto — no lo toqué y no encontré ahí el defecto H-6/PinPad que la
misión advierte, porque no agregué ningún campo nuevo a esa pantalla.

## Verificación

### Typecheck

```
$ npm run typecheck
src/features/orders/NewOrderPage.tsx(24,61): error TS2307: Cannot find module '@/api/channels' or its corresponding type declarations.
src/features/orders/NewOrderPage.tsx(70,9): error TS2740: Type '{}' is missing the following properties from type 'DevicePlatformOut[]': length, pop, push, concat, and 35 more.
```

Los dos errores son consecuencia de la MISMA línea (el import de `@/api/channels`, CONTRATO
C7, ver sección propia): el segundo (`Type '{}' is missing...`) es el error en cascada de
que `DevicePlatformOut`/`listDevicePlatforms` no resuelven. No creé un stub de
`@/api/channels.ts` para confirmar esto de forma automatizada — hubiera sido escribir fuera
de mi territorio, aunque fuera transitorio — así que la confianza en que el resto de
`NewOrderPage.tsx` tipa bien es por revisión manual (los únicos campos que leo de
`DevicePlatformOut` son `.id` y `.name`, y la forma que asumí para el tipo/función sigue
exactamente el patrón ya usado en el repo para `DeviceEmployee`/`listDeviceEmployees` y
`DevicePaymentMethod`/`listDevicePaymentMethods`).

### Tests de mi territorio

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-pos-canales npx vitest run src/features/orders src/features/payments src/features/catalog src/features/shifts

 ❯ src/features/orders/__tests__/NewOrderPage.test.tsx (0 test)
 ❯ src/features/orders/__tests__/index.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/features/orders/__tests__/NewOrderPage.test.tsx [ src/features/orders/__tests__/NewOrderPage.test.tsx ]
Error: Failed to resolve import "@/api/channels" from "src/features/orders/NewOrderPage.tsx". Does the file exist?
 FAIL  src/features/orders/__tests__/index.test.ts [ src/features/orders/__tests__/index.test.ts ]
Error: Failed to resolve import "@/api/channels" from "src/features/orders/NewOrderPage.tsx". Does the file exist?

 Test Files  2 failed | 28 passed (30)
      Tests  95 passed (95)
   Start at  22:44:18
   Duration  18.04s
```

Los 28 archivos / 95 tests que sí corren incluyen todo lo demás de mi territorio: los tests
preexistentes (que seguí sin romper) y los que escribí para este pedido. Detalle de lo nuevo:

- **`frontend/src/features/orders/__tests__/OrderPage.test.tsx`** (agregadas, corridas y en
  verde): muestra dirección/teléfono/domiciliario de una comanda de domicilio; muestra
  plataforma y `external_id`; sin `pos.courses` no aparece ningún botón "Marchar"; marcha un
  curso pendiente y, una vez marchado, ya no ofrece el botón (aparece el aviso con la hora).
- **`frontend/src/features/orders/__tests__/NewOrderPage.test.tsx`** (agregadas, **no
  corridas** por el gap de C7, ver arriba): domicilio exige dirección/teléfono/domiciliario
  y no manda ningún campo de plata para el cargo; plataforma exige elegir plataforma y
  `external_id`, consumiendo el selector de `@/api/channels`.
- **`frontend/src/features/catalog/ProductForm.test.tsx`** (nuevo archivo, corrido y en
  verde): mesa es obligatorio y los tres canales opcionales dicen "Igual que mesa" cuando
  están vacíos; un canal vacío se manda como `null`, nunca como `0`; marcar "es el cargo de
  domicilio" manda `is_delivery_fee: true`.
- **`frontend/src/features/catalog/ProductsTab.test.tsx`** (actualizado, corrido y en
  verde): el texto ahora es "Igual que mesa" en vez de "—"; agregada una prueba de que la
  insignia "Cargo de domicilio" no aparece si el producto no lo es.
- **`frontend/src/features/catalog/{ModifiersTab,RecipeEditor}.test.tsx`** (fixtures
  actualizadas para incluir `is_delivery_fee: false`, sin cambio de comportamiento —
  las rompía el tipo más estricto de `ProductAdminOut`).
- **`frontend/src/features/shifts/__tests__/MovementsPanel.test.tsx`** (agregadas, corridas
  y en verde): `delivery_settlement` tiene la etiqueta "Liquidación de domicilios"; el
  desplegable de causa manual NO la incluye (aunque sí liste otras causas, para descartar
  un falso verde por desplegable roto).
- **`frontend/src/features/shifts/__tests__/ShiftPage.test.tsx`** (agregadas, corridas y en
  verde): sin `pos.delivery` no aparece el renglón de efectivo de domicilios pendiente; con
  la flag encendida aparece con el monto exacto, y el renglón "Esperado" sigue sin incluirlo.
- **`frontend/src/features/shifts/__tests__/DeliverySettlementPanel.test.tsx`** (nuevo
  archivo, corrido y en verde): pinta el pendiente por domiciliario tal cual llega (sin
  resumar `amount + tip_amount` a mano); liquidar manda `courier_employee_id` y no pide PIN.

### Iteración 2 (ajuste del Maestro sobre H-1) — verificación acotada al cambio

Sólo toqué `frontend/src/features/shifts/DeliverySettlementPanel.tsx` (rótulos y una línea
de aclaración, mismos números y mismos campos) y agregué un test en
`frontend/src/features/shifts/__tests__/DeliverySettlementPanel.test.tsx`. No toqué
`frontend/src/api/shifts.ts` ni `frontend/src/api/channels.ts`, ni
`frontend/src/features/shifts/ShiftSummaryPanel.tsx`, ni nada bajo `src/audit/**`.

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-pos-canales npx vitest run src/features/shifts

 RUN  v5.0.0 /home/user/restaurante-sistema/frontend

 Test Files  7 passed (7)
      Tests  25 passed (25)
   Start at  00:02:29
   Duration  4.85s (environment 37%, import 23%, tests 22%, transform 11%, setup 7%)
```

```
$ npm run typecheck

> frontend@0.0.0 typecheck
> tsc --noEmit -p tsconfig.app.json
```

Sin salida = sin errores. Ningún rojo nuevo. El error de C7 (`@/api/channels` no resuelve,
documentado arriba) es de `src/features/orders/**` y no aparece al correr sólo
`src/features/shifts` — sigue siendo el mismo gap declarado, no cambió en esta ronda.

El test nuevo (`"deja escrito que la propina no mueve el esperado del turno (iteración 2,
H-1)"`) cubre las tres superficies de la copia nueva — el bloque de totales, la línea de
aclaración arriba de la tabla y los encabezados de columna — y además reafirma que los
números pintados (`27.000` / `3.000` / `30.000`) son los mismos de siempre: sólo cambió el
rótulo, nunca el cálculo.

### Iteración 3 (ajuste del Maestro sobre H-8) — verificación acotada al cambio

**Alcance**: sólo `frontend/src/features/shifts/**` y `frontend/src/api/shifts.ts`, como
pide el ajuste. Nada de `src/audit/**`, `src/features/kitchen/**` ni `src/app/**`.

**1) `DeliverySettlementPanel.tsx`** — el rótulo de propina de iteración 2 («Propina — entra
al cajón pero no mueve el esperado; se paga como propina») conserva su primera mitad LETRA
POR LETRA; completé la segunda para decir qué pasa DESPUÉS de liquidar: ahora dice "...al
cerrar el turno sale del cajón como propina, no como plata a consignar". Mismo criterio en
la línea de aclaración arriba de la tabla y en el encabezado de columna ("Propina (no mueve
el esperado; sale al cierre como propina)"). **No toqué ningún número ni campo pintado**:
`amount`, `tip_amount` y `total` de `GET /delivery-settlements/pending` siguen siendo
exactamente los mismos — lo verifiqué con un test nuevo que reafirma `27.000`/`3.000`/
`30.000` en la fila y en el bloque de totales.

**2) Tipos en `src/api/shifts.ts`** — agregué `ShiftTips`, `SalesByMethod`,
`TipsByEmployee` y `getShiftTips()` para `GET /shifts/{id}/tips`, siguiendo el contrato
nuevo del Maestro: `delivery_tips`, `delivery_tips_pending` y el campo nuevo
`delivery_tips_settled` (más `cash_out`, `electronic_liability`, `by_method`,
`by_employee`, verificados letra por letra contra `backend/app/shifts/schemas.py::
ShiftTipsOut`/`TipsByEmployeeOut` y `backend/app/shifts/tips.py::get_shift_tips`). **No
renombré** `Breakdown.delivery_cash_pending` (`api/shifts.ts:197` original) ni el de
`ShiftCurrent` (`:116` original): los dejé intactos, nombre y significado (venta + propina
pendientes, no propina de `ShiftTipsOut`) — son el campo que sigue consumiendo
`ShiftSummaryPanel.tsx`, sin tocar.

**3) Referencia de sólo lectura junto al campo de propina del cierre** — SÍ es alcanzable
desde el POS, lo verifiqué antes de construir nada: `GET /shifts/{shift_id}/tips`
(`backend/app/shifts/router.py:338-339`) usa `Depends(current_actor)`, y
`current_actor` (`backend/app/auth/deps.py:162-168`) devuelve el actor admin autenticado
**o** `current_operator` — un dispositivo con una persona identificada por PIN —, sin exigir
ningún rol ni permiso adicional dentro del handler (sólo compara `actor.store_id` con la
sede del turno). A diferencia de `expected_cash`, esta ruta declara explícitamente en su
propio docstring que NO aplica el gate `_can_see_expected`. Construí entonces
`useShiftTips(shiftId)` en `features/shifts/hooks.ts` y, al lado del campo "Propinas en
efectivo retiradas" en `CloseWizard.tsx` (paso 1) y `SingleStepCloseForm.tsx`, un párrafo de
sólo lectura: *"Referencia del sistema (no se usa para calcular nada acá): lo que el sistema
calcula que sale del cajón como propina es {formatCOP(cash_out)}."* — `cash_out` se PINTA
tal cual llega (`formatCOP`, que además hace que `undefined`/`null` se vean como "—", nunca
"$0"); no se suma, resta ni compara contra `tipsCashOut` en ningún punto del código.

**4) Regla dura (no derivar plata)**: verificado por lectura — ni `CloseWizard.tsx` ni
`SingleStepCloseForm.tsx` usan `tipsQuery.data?.cash_out` en ninguna expresión aritmética ni
en el cuerpo del `POST` (`tips_cash_out` que se manda sigue siendo exclusivamente el valor
tecleado por el cajero, `tipsCashOut ?? 0`, sin cambios). No toqué `src/audit/**`,
`src/features/kitchen/**` ni `src/app/**`.

**5) Coordinación con `backend-dinero-canales`**: verifiqué el contrato leyendo el código
real del backend en el repo (no un mock de mi invención) y `GET /shifts/{id}/tips` YA
publica
`delivery_tips`/`delivery_tips_pending`/`delivery_tips_settled` (`backend/app/shifts/
schemas.py:581-583`, `backend/app/shifts/tips.py:128-136`) — el renombre que el Maestro dijo
que backend iba a hacer esta ronda ya está en el árbol. No hizo falta declarar un gap acá.

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-pos-canales npx vitest run src/features/shifts

 RUN  v5.0.0 /home/user/restaurante-sistema/frontend

 Test Files  7 passed (7)
      Tests  29 passed (29)
   Start at  01:12:36
   Duration  5.20s (environment 35%, tests 25%, import 24%, transform 11%, setup 6%)
```

```
$ npm run typecheck

> frontend@0.0.0 typecheck
> tsc --noEmit -p tsconfig.app.json
```

Sin salida = sin errores. 29 tests en verde (25 de antes + 4 nuevos: 1 en
`DeliverySettlementPanel.test.tsx` sobre la copia nueva, 1 en `CloseWizard.test.tsx` y 1 en
`SingleStepCloseForm.test.tsx` sobre la referencia de `cash_out`, y 1 en `shiftsApi.test.ts`
sobre `getShiftTips`). También corrí, de más, los tres archivos de `src/audit/**` que tocan
`api/shifts.ts`/`features/shifts` (`channels-kds.test.ts`, `channels-round2.test.ts`,
`purchases-counts.test.ts`, territorio ajeno, sólo para verificar que no rompí ningún
invariante publicado): 58 tests, todos en verde.

## Rojos y dudas

- **CONTRATO C7 sin resolver todavía** (`@/api/channels`): ver sección propia arriba. Es el
  único bloqueante real de mi entregable, y es exactamente el tipo de cruce que el checklist
  del pedido pide vigilar. Nombro el archivo, la forma exacta que asumí, y el alcance medido
  del daño (2 de 30 archivos de test de mi territorio).
- **`DeliverySettlementPanel` no tiene histórico consultable desde el POS** (declarado
  también en el docstring del componente): sólo puede "Deshacer" lo liquidado en la misma
  sesión de pantalla. No inventé una ruta de dispositivo nueva para listar liquidaciones
  pasadas porque no está en mi misión y `GET /admin/delivery-settlements` es de admin. Si el
  Maestro lo quiere, es un endpoint de dispositivo nuevo — trabajo de
  `backend-dinero-canales`, no mío.
- **No até `is_delivery_fee` a ninguna advertencia si la sede vende por domicilio sin tener
  un producto marcado**: el backend ya corta la creación de la comanda con
  `400 DELIVERY_FEE_NOT_CONFIGURED` y mi `NewOrderPage` muestra ese mensaje tal cual (no
  inventé uno propio) — no agregué una advertencia proactiva en la carta porque no está
  pedida explícitamente y hubiera significado cruzar a leer el catálogo completo desde el
  flujo de creación de comanda sólo para esa alerta.
- **No toqué `CheckoutPage.tsx`** para mostrar dirección/plataforma en la pantalla de cobro:
  la mission no lo pide explícitamente (pide que el medio de pago `platform` funcione, que
  ya funcionaba) y `OrderPage` ya muestra esos datos antes de llegar al cobro. Lo declaro
  como una decisión de alcance, no un olvido.
- **Verifiqué, no construí, "operador no ve costos" para mis pantallas nuevas**: ningún tipo
  ni componente que agregué (`DeliveryOut`, `OrderPlatformInfoOut`, `CourseFireOut`,
  `CourierPending`, `DeliverySettlement`) tiene `cost`, `margin` ni `commission`. La comisión
  de plataforma vive sólo en rutas `/admin/**` que no toqué.
- **No hice recorrido en navegador real**: este entorno no tiene forma de levantar
  backend+frontend y navegar a mano; el checklist del pedido lo pide como paso del
  Maestro/orquestador antes de cerrar, no de cada agente por separado — lo declaro para que
  quede explícito, no lo doy por hecho.
- **Iteración 3 — declaré `ShiftTips` completo aunque hoy sólo pinto `cash_out`**: el
  contrato tiene `by_employee` (propina por persona, con el bolsillo `delivery`) y
  `by_method`, que ninguna pantalla mía consume todavía — el ajuste pidió sólo la referencia
  de `cash_out` junto al campo de propina del cierre, así que no agregué una pantalla de
  reparto que nadie pidió. Si el Maestro quiere ver el desglose por domiciliario en algún
  punto, el tipo ya está declarado y sincronizado con el backend; falta sólo la pantalla.
- **No até el `cash_out` de referencia a ninguna validación del formulario**: si
  `tipsCashOut` (lo que teclea el cajero) difiere del `cash_out` de referencia, no bloqueo ni
  advierto — es intencional (el ajuste lo pide como REFERENCIA, no como regla), pero lo
  declaro por si el Maestro esperaba una alerta de discrepancia.
