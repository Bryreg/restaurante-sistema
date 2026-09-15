# frontend-comanda — entregable (pedido 1b-1)

Construí el POS de comanda de Restaurante Sistema: Mesas, Comanda (nueva y abierta),
Cocina y Admin → Pedidos. Sobre el pedido 1a entregado (base `098d3a0`), en paralelo
con `backend-base`, `backend-comanda`, `backend-cobro`, `frontend-cobro` y
`auditor-venta`, siguiendo `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md` (§6
frontend, §2.4 API), `docs/ESTADO.md`, `AGENTS.md` y `docs/SPEC-NEGOCIO.md` §3.3,
§3.6, §9.1, §9.2, §9.3, §11.

## Resumen

- `src/api/orders.ts` y `src/api/kitchen.ts`: tipos y funciones completos contra el
  contrato de API de 1b-1 (§2.4), con todo campo de un tipo `Out` opcional o `| null`
  y los tipos `In` estrictos.
- `src/features/orders/index.ts` (no existía como stub cuando llegué — lo creé de
  cero) exporta `ordersFeature = { posRoutes, adminRoutes, adminNav, posNav }` con
  las cuatro rutas de POS (Mesas, Comanda nueva, Comanda abierta, Cocina) y una de
  Admin (Pedidos), tal como pide §6.2.
- Cinco pantallas (`TablesPage`, `NewOrderPage`, `OrderPage`, `KitchenPage`,
  `OrdersAdminPage`) más ocho componentes de apoyo (catálogo, diálogo de ítem,
  lista de ítems, anulación, cortesía, descuento, precuenta, PIN de autorizador) y
  dos módulos compartidos (`hooks.ts` con las claves de `react-query` y el patrón
  de versión optimista + PIN de autorizador; `lib.ts` con etiquetas y tiempo
  transcurrido — nunca plata).
- Toda mutación manda `expected_version`; ante `409 STALE_VERSION` se reemplaza la
  comanda local por `error.extra.order`, se invalida la query y se avisa "La
  comanda cambió en otra tablet; revisá y repetí." Ante `AUTHORIZATION_REQUIRED`,
  `DISCOUNT_LIMIT_EXCEEDED` o `BILL_PRESENTED_NEEDS_AUTH` se abre un diálogo de PIN
  y se reintenta la MISMA acción con `authorizer_pin` y una `Idempotency-Key`
  nueva (cuando la acción usa idempotencia). El frontend nunca calcula plata:
  todo total, impuesto, propina sugerida y prorrateo sale tal cual de
  `OrderOut.totals`/`tip`/`PreBillOut`/`BillSplitOut`.
- 28 tests (vitest + Testing Library) en 9 archivos, todos verdes; `npm run
  typecheck` limpio (0 errores en todo el proyecto en el momento de cerrar este
  entregable).

## Archivos tocados (todos dentro de mi territorio)

Nuevos:
- `/home/user/restaurante-sistema/frontend/src/api/kitchen.ts`
- `/home/user/restaurante-sistema/frontend/src/features/orders/index.ts`
- `/home/user/restaurante-sistema/frontend/src/features/orders/hooks.ts`
- `/home/user/restaurante-sistema/frontend/src/features/orders/lib.ts`
- `/home/user/restaurante-sistema/frontend/src/features/orders/TablesPage.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/NewOrderPage.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/OrderPage.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/KitchenPage.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/OrdersAdminPage.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/CatalogPanel.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/ItemDialog.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/OrderItemsList.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/VoidDialog.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/CourtesyDialog.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/DiscountDialog.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/PreBillDialog.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/AuthorizerDialog.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/fixtures.ts`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/TablesPage.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/NewOrderPage.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/OrderPage.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/KitchenPage.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/OrdersAdminPage.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/CatalogPanel.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/ItemDialog.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/OrderItemsList.test.tsx`
- `/home/user/restaurante-sistema/frontend/src/features/orders/__tests__/index.test.ts`

Escrito desde cero (`src/api/orders.ts` no existía):
- `/home/user/restaurante-sistema/frontend/src/api/orders.ts`

No toqué `router.tsx`, `PosLayout.tsx`, `PosHome.tsx`, `AdminLayout.tsx`,
`features/payments/**`, `features/shifts/**`, `components/EmployeePicker.tsx` ni
`api/payments.ts` — sólo los leí para entender los patrones a reutilizar.

## Endpoints consumidos (ruta y función)

`src/api/orders.ts`:
- `GET /tables/status` → `listTablesStatus()`
- `POST /orders` → `createOrder(body)`
- `GET /orders?status=&channel=` → `listOrders(params)`
- `GET /orders/favorites` → `listFavorites()`
- `GET /orders/{id}` → `getOrder(orderId)`
- `POST /orders/{id}/items` (Idempotency-Key) → `addItems(orderId, body, key)`
- `PATCH /orders/{id}/items/{item_id}` → `patchItem(orderId, itemId, body)`
- `POST /orders/{id}/send` (Idempotency-Key) → `sendOrder(orderId, body, key)`
- `POST /orders/{id}/items/{item_id}/ready` (Idempotency-Key) → `markReady(orderId, itemId, key)`
- `POST /orders/{id}/items/{item_id}/served` (Idempotency-Key) → `markServed(orderId, itemId, key)`
- `POST /orders/{id}/items/{item_id}/void` → `voidItem(orderId, itemId, body)`
- `POST /orders/{id}/items/{item_id}/courtesy` → `courtesyItem(orderId, itemId, body)`
- `POST /orders/{id}/discounts` → `addDiscount(orderId, body)`
- `DELETE /orders/{id}/discounts/{discount_id}?expected_version=` → `removeDiscount(orderId, discountId, expectedVersion)`
  (decisión de `backend-comanda`: la versión va en la query, no en el cuerpo, de un `DELETE`)
- `POST /orders/{id}/merge` → `mergeOrders(orderId, body)`
- `POST /orders/{id}/move` → `moveOrder(orderId, body)`
- `POST /orders/{id}/void` → `voidOrder(orderId, body)`
- `POST /orders/{id}/bill/present` (Idempotency-Key) → `presentBill(orderId, body, key)`
- `POST /orders/{id}/bill/split` → `splitBill(orderId, body)` (tipado y expuesto; sin pantalla propia — ver Gaps)
- `GET /orders/{id}/sub-accounts` → `listSubAccounts(orderId)` (tipado y expuesto; sin pantalla propia — ver Gaps)
- `GET /admin/orders?store_id&from&to&status&channel&flags` (+`format=csv` vía `adminOrdersCsvUrl`) → `adminListOrders(params)`
- `GET /admin/orders/{id}` → `adminGetOrder(orderId)`

`src/api/kitchen.ts`:
- `GET /kitchen/rounds?station=` → `listKitchenRounds(station?)`

## Rutas y nav que exporta `ordersFeature`

```ts
posRoutes: [
  { path: "mesas", element: <TablesPage/> },
  { path: "comanda/nueva", element: <NewOrderPage/> },
  { path: "comanda/:orderId", element: <OrderPage/> },
  { path: "cocina", element: <KitchenPage/> },
]
adminRoutes: [{ path: "pedidos", element: <OrdersAdminPage/> }]
adminNav: [{ to: "/admin/pedidos", label: "Pedidos" }]
posNav: [
  { to: "/pos/mesas", label: "Mesas", feature: "pos.tables" },
  { to: "/pos/comanda/nueva", label: "Comanda" },
  { to: "/pos/cocina", label: "Cocina", feature: "kitchen.view" },
]
```

Navegación interna: `TablesPage` → abrir mesa libre crea la comanda y navega a
`/pos/comanda/:id`; ocupada/por cobrar navega directo a esa comanda.
`NewOrderPage` → crea la comanda (o, si el canal es "Mesa", navega a `/pos/mesas`
para elegirla) y sigue en `/pos/comanda/:id`. `OrderPage` → botón «Cuenta / Cobrar»
(«Cobrar» en mostrador) hace `navigate("/pos/cobro/" + orderId)`, el destino de
`frontend-cobro`. `KitchenPage` no navega a ninguna otra pantalla.

## Flags que lee cada pantalla

- **TablesPage**: `pos.tables` (gate completo de la pantalla).
- **NewOrderPage**: `pos.counter`, `pos.tables` (redirige a Mesas), `pos.takeout`,
  `pos.staff_meal` — sólo se ofrecen los canales habilitados.
- **OrderPage** / `CatalogPanel` / `ItemDialog`: `pos.daily_menu` (+combo
  `active_now`) para la pestaña Menú del día primero; `pos.daily_count` para el
  contador de porciones visible; `pos.modifiers` para el diálogo de modificadores;
  `pos.combos` para la selección de combos; `pos.seats` para el campo de asiento;
  `pos.courses` para el campo de curso; `pos.courtesies` para el botón Cortesía;
  `pos.discounts` para los botones de descuento (ítem y comanda); `kitchen.view`
  para el botón Enviar (sin la flag el botón no existe, ni la pantalla de Cocina);
  `pos.pre_bill` para el botón Presentar cuenta.
- **KitchenPage**: `kitchen.view` (gate completo).
- **OrdersAdminPage**: sin flag propio (núcleo, como Dinero/Turnos y personal).

Todas las flags se leen con `useSession().hasFeature(...)`; el backend sigue
siendo la barrera real (`400 FEATURE_DISABLED`) — el frontend sólo oculta la
acción.

## Patrones obligatorios (§6.3) — cómo quedaron implementados

- **Versión optimista**: cada mutación arma su cuerpo con
  `expected_version: order.version ?? 0`. `hooks.ts` expone
  `isStaleVersionError`, `applyStaleOrder` (escribe `error.extra.order` en la
  caché de `["orders", id]` e invalida) y el mensaje fijo
  `STALE_VERSION_MESSAGE`. `useOrderMutationHandler` centraliza esto para
  `OrderPage`: además de reemplazar la comanda, cierra el diálogo de la acción
  que disparó el error (`onStale`) para que un ítem que ya no exista tal cual no
  quede con un diálogo modal abierto tapando la pantalla (un bug que encontré con
  un test: la comanda "cambiada" no se veía porque el diálogo de anular, modal,
  dejaba el resto de la página `aria-hidden`).
- **PIN de autorizador**: `useAuthorizerFlow` (en `hooks.ts`) encapsula el diálogo
  (`AuthorizerDialog` + `PinPad`) y expone `handleError(err, retry)` — si el
  código es `AUTHORIZATION_REQUIRED` / `DISCOUNT_LIMIT_EXCEEDED` /
  `BILL_PRESENTED_NEEDS_AUTH`, abre el diálogo y guarda el `retry`. Cada acción
  que puede pedir PIN (agregar ítems tras cuenta presentada, anular, descuento)
  vuelve a llamarse a sí misma dentro de `retry`, con `authorizer_pin: pin` y una
  `newIdempotencyKey()` nueva en la llamada HTTP (verificado en el test de
  `addItems`: la segunda llamada lleva `authorizer_pin` y una clave distinta de la
  primera). Cortesía es la excepción a propósito: el backend exige el PIN en el
  primer intento (`CourtesyItemIn.authorizer_pin` no es opcional), así que
  `CourtesyDialog` pide motivo + PIN juntos en vez de reintentar tras un 400.
- **Sondeo**: `useTablesStatus` (5 s, `["tables","status"]`), `useOrder` (5 s,
  `["orders", id]`), `useKitchenRounds` (4 s, `["kitchen", station]`) — una sola
  clave por recurso, `refetchInterval` de `react-query`.
- **Una sola matemática en el backend**: ningún componente suma, resta ni
  multiplica un campo de plata (`price`, `total`, `subtotal`, `discount`, `tax`,
  `gross`, `net`, `amount`); todo se lee tal cual de `OrderOut.totals`/`tip`,
  `PreBillOut`, `BillSplitEqualOut.per_part`. Verificado a mano con
  `grep -nE "(price|total|amount|gross|net|discount|tax|subtotal)[a-zA-Z_.]*\s*[+*/-]"`
  sobre todo `src/features/orders/` — sin resultados de aritmética real (el único
  falso positivo fue `totalSeconds / 60`, tiempo transcurrido, no plata). El
  `Math.round(numericValue)` en `DiscountDialog` sanea lo que la persona tecleó
  para mandar un entero (`value: int` del backend), no deriva ningún total.

## Notas de accesibilidad y responsive

- Botones ≥ 44 px (`h-11`/`size-11`) en toda acción táctil: mesas, cantidad,
  anular/cortesía/descuento, enviar, presentar cuenta, cobrar, "Listo" de cocina.
- `aria-label` en todo botón sin texto visible suficiente (mesas con su estado,
  +/- de cantidad, anular/cortesía/descuento por ítem, marcar listo por ítem,
  producto/combo del catálogo con "Agregar X" para no chocar con "Anular X" del
  mismo producto en la lista de ítems).
- `role="radiogroup"`/`role="radio"` en el selector de canal de `NewOrderPage` y
  en el selector de mesas al unir/mover; `role="alert"` en todo mensaje de error;
  `role="status"`/`role="alert"` en `EmptyState` (ya existente).
- Semáforo de cocina: única excepción a los tokens (`bg-emerald-600` /
  `bg-amber-600` / `bg-red-600` con texto blanco, contraste AA), como autoriza
  §6.1. Todo lo demás usa variantes tokenizadas de `Badge` (`default`,
  `secondary`, `outline`, `destructive`, `ghost`) para estado/curso de ítem y
  estado de mesa — nunca un color crudo.
- Responsive: grillas `grid-cols-2 sm:grid-cols-3`/`md:grid-cols-4` para mesas y
  catálogo; `flex-wrap` en barras de acciones (incluida la barra fija de
  `OrderPage`) para que a 375 px las acciones bajen de línea en vez de generar
  scroll horizontal; tablas de `OrdersAdminPage` y `PreBillDialog` en
  `overflow-x-auto` propio (la única excepción permitida). No probé un navegador
  real a 375/1024 px (sin entorno gráfico acá); lo verifiqué por estructura
  (nada con `min-width` fijo, gutter lateral heredado del layout de `PosLayout`).
- Claro/oscuro: todo con tokens de Tailwind del proyecto (`text-muted-foreground`,
  `bg-primary/5`, `border-border`, etc.), mismos que el resto del POS.
- Nada en `localStorage`/`sessionStorage` (verificado con grep).

## Comandos de verificación (resultados literales)

```
$ cd frontend && npx vitest run src/features/orders
 Test Files  9 passed (9)
      Tests  28 passed (28)
   Duration  5.34s

$ cd frontend && npm run typecheck
> frontend@0.0.0 typecheck
> tsc --noEmit -p tsconfig.app.json
(sin salida — 0 errores en todo el proyecto en este momento)
```

No corrí `npm run test` completo ni `npm run build` (prohibidos para este agente).
No instalé nada.

## Gaps

- **`src/features/orders/bill/split` y sub-cuentas sin pantalla propia**:
  `splitBill`/`listSubAccounts` están tipados y expuestos en `src/api/orders.ts`
  tal como pide la firma del contrato, pero la misión de `OrderPage` que me dieron
  no lista una acción "dividir cuenta" entre sus botones (sólo enviar, presentar
  cuenta, anular, descuentos, cortesía y «Cuenta / Cobrar»); la división por
  partes iguales o por ítems/asiento vive naturalmente en el flujo de cobro
  (`frontend-cobro`, `CheckoutPage`/`SplitBillPanel`, que ya existen en su
  territorio). Si la división tuviera que iniciarse desde `OrderPage`, falta ese
  botón — lo dejo señalado en vez de inventar una pantalla que el contrato no
  pidió en mi misión.
- **`EmployeePicker` y `src/api/employees.ts`**: no eran un gap al cerrar este
  entregable — `frontend-cobro` ya los había escrito (`listDeviceEmployees`,
  `DeviceEmployee`, `EmployeePicker` con la firma exacta del contrato §6.2) cuando
  llegué a usarlos en `NewOrderPage`. Igual mockeo `@/components/EmployeePicker`
  en los tests de `NewOrderPage`, como pide la misión, para no depender de
  `GET /device/employees` real en el test.
- **`removeDiscount` no tiene botón en `OrderPage`**: la función está expuesta en
  `src/api/orders.ts` (`DELETE /orders/{id}/discounts/{discount_id}`), pero
  `OrderItemsList`/`OrderPage` no listan los descuentos vivos con una acción
  "quitar" — sólo agregarlos. La misión no pidió explícitamente "quitar
  descuento" entre las acciones de `OrderPage` (sí "descuentos por ítem o
  comanda" en el sentido de agregarlos); lo declaro porque el endpoint ya está
  tipado y listo para que una vuelta futura lo use.
- **Elapsed time y estaciones de cocina se derivan en el cliente**: `tables/status`
  no manda `elapsed_seconds` (sólo `opened_at`), así que `elapsedLabel` en
  `lib.ts` calcula `ahora − opened_at` en el navegador. No es plata (permitido),
  pero como toda cuenta de tiempo relativo, depende del reloj del dispositivo —
  igual que "tiempo transcurrido" en cualquier POS; no hay drift real porque se
  refresca cada 5 s con el sondeo.
- **Estaciones de cocina conocidas se calculan de la vista "Todas"**: el selector
  de estación de `KitchenPage` arma su lista de botones a partir de los ítems que
  trae la respuesta SIN filtro (`station=undefined`); al filtrar por una estación
  puntual esa lista queda "congelada" con el último snapshot sin filtro (evita
  una segunda query de sondeo). Si una estación nueva aparece recién cuando ya
  hay un filtro activo, no se ve hasta volver a "Todas". Lo señalo como decisión
  de diseño, no como bug — no estaba especificado en el contrato cómo descubrir
  la lista de estaciones.
- **Split de "mostrador: crear → enviar → cobrar en un solo flujo"**: implementé
  el botón "Cobrar" prominente para `channel === "counter"` navegando
  directamente a `/pos/cobro/:id` (el backend auto-envía los pendientes al cobrar
  vía `auto_send_pending_for_payment`, así que no hace falta un `POST /send`
  explícito desde el frontend antes de navegar). Si el Maestro esperaba que el
  frontend llamara a `sendOrder` explícitamente antes de navegar (en vez de
  confiar en el auto-envío del backend), es un cambio de una línea en
  `OrderPage.tsx` — lo dejo señalado porque el contrato no lo pide de forma
  literal y el backend ya lo cubre.
- **No pude probar un navegador real** (sin entorno gráfico en esta sesión): la
  verificación de 375 px/1024 px sin scroll horizontal y el contraste AA del
  semáforo de cocina quedan verificados por estructura y por las clases usadas,
  no por captura visual. Es lo mismo que declaró `backend-base`/1a para su parte
  no verificable en este entorno.
- **No verifiqué contra un backend corriendo**: todos los tests mockean
  `@/api/orders`, `@/api/kitchen` y `@/api/catalog`; no hay un test de integración
  end-to-end contra `uvicorn` real en este entregable (no lo pedía la misión;
  `backend-comanda` ya tiene su propia suite de `tests/orders` y `tests/kitchen`
  sobre las mismas rutas).
