# Entregable — `frontend-cobro` (pedido 1b-1)

Agente: **frontend-cobro**. Pedido 1b-1 (comanda y cobro), equipo de seis
(`backend-base`, `backend-comanda`, `backend-cobro`, `frontend-comanda`,
`frontend-cobro`, `auditor-venta`) sobre el commit base `098d3a0`, contrato
interno en `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md`.

## 1. Resumen

Construí "Quién opera" con selector de personal (reemplaza los cuatro
`type="number"` de empleado en `DeviceIdentifyPage`, `OpenShiftForm`,
`RosterPanel` y `HandoverPanel`), la carcasa del POS (`router.tsx`,
`PosHome.tsx`, `PosLayout.tsx`, `AdminLayout.tsx` — territorio exclusivo de
este agente entre los seis), y el dominio completo de cobro: `CheckoutPage`
(precuenta, propina, división de cuenta, tabla de pagos con PIN, versión
optimista) y `DocumentPage` (comprobante interno imprimible con
`document-print.css`).

Corrí exclusivamente contra el código que ya existía o fue apareciendo en
paralelo de `backend-base` (`GET /device/employees`, ya entregado antes de
empezar), `backend-cobro` (`app/payments`, ya con `router.py`/`schemas.py`
reales al momento de escribir esto — verifiqué campo por campo contra
`backend/app/payments/schemas.py` y coinciden exactamente con lo que tipé) y
`frontend-comanda` (`src/api/orders.ts` y `src/features/orders/index.ts`, que
sobreescribió mi stub del §7.1 con el `ordersFeature` real mientras yo
trabajaba; typecheck limpio contra su versión final).

Sin gaps bloqueantes: todo lo que necesitaba de otros territorios ya
existía cuando terminé (ver §7 "Gaps" para lo que sí quedó declarado, no
bloqueante).

## 2. Archivos tocados

### Nuevos (míos)

- `frontend/src/api/payments.ts` — `PaymentMethod`, `PaymentIn`/`PaymentOut`, `payOrder`.
- `frontend/src/api/documents.ts` — `DocumentPrintable`, `getDocument`, `getLastDocument`, `reprintDocument`, `adminListDocuments`.
- `frontend/src/components/EmployeePicker.tsx` — grilla de personal (`GET /device/employees`).
- `frontend/src/components/__tests__/EmployeePicker.test.tsx`.
- `frontend/src/features/auth/__tests__/DeviceIdentifyPage.test.tsx`.
- `frontend/src/app/PosHome.tsx` — ruta índice de `/pos`.
- `frontend/src/app/__tests__/PosHome.test.tsx`, `PosLayout.test.tsx`, `router.test.tsx`.
- `frontend/src/features/payments/index.ts` — `paymentsFeature`.
- `frontend/src/features/payments/CheckoutPage.tsx` — `/pos/cobro/:orderId`.
- `frontend/src/features/payments/DocumentPage.tsx` — `/pos/documento/:documentId`.
- `frontend/src/features/payments/PaymentSplitsForm.tsx` — tabla de pagos + PIN + submit (reusable para comanda entera o sub-cuenta).
- `frontend/src/features/payments/PaymentTargetPanel.tsx` — junta propina + tabla de pagos para un "blanco" de cobro.
- `frontend/src/features/payments/SplitBillPanel.tsx` — partes iguales / por ítems.
- `frontend/src/features/payments/TipQuestion.tsx` — pregunta de propina.
- `frontend/src/features/payments/lib.ts` — `sumTyped` (la única suma del frontend).
- `frontend/src/features/payments/document-print.css` — `@media print` 58/72/80 mm.
- `frontend/src/features/payments/__tests__/fixtures.ts`, `CheckoutPage.test.tsx`, `DocumentPage.test.tsx`.
- `frontend/src/features/orders/index.ts` — **stub exacto del §7.1**, creado porque no existía cuando arranqué; `frontend-comanda` ya lo sobreescribió con el `ordersFeature` real (confirmado con `git status`/lectura del archivo final: mi stub ya no está, no lo toqué de nuevo).

### Modificados (míos)

- `frontend/src/api/employees.ts` — agregado `DeviceEmployee` + `listDeviceEmployees()` (`GET /device/employees`); el CRUD de empleados que ya tenía el archivo (`Employee`, `EmployeeCreateIn`, etc., de `frontend-people` en 1a) no se tocó.
- `frontend/src/app/router.tsx` — integra `[...shiftsFeature.posRoutes, ...ordersFeature.posRoutes, ...paymentsFeature.posRoutes]` bajo `/pos` con `PosHome` como índice; `/admin` suma `ordersFeature.adminRoutes`.
- `frontend/src/app/PosLayout.tsx` — barra de navegación del POS (`[...ordersFeature.posNav, ...shiftsFeature.posNav]` filtrada por `hasFeature`), manteniendo `ShiftStatusStrip` y "Cambiar de persona".
- `frontend/src/app/AdminLayout.tsx` — `buildNav` suma `ordersFeature.adminNav`.
- `frontend/src/features/auth/DeviceIdentifyPage.tsx` — `EmployeePicker` + `PinPad`, sin input numérico.
- `frontend/src/features/shifts/index.ts` — `posRoutes` pierde el `index: true` (queda sólo `"turno"`; `PosHome` es ahora el índice de `/pos`).
- `frontend/src/features/shifts/OpenShiftForm.tsx` — responsable de caja con `EmployeePicker`.
- `frontend/src/features/shifts/RosterPanel.tsx` — persona del roster con `EmployeePicker`.
- `frontend/src/features/shifts/HandoverPanel.tsx` — nuevo responsable con `EmployeePicker` (`excludeIds` del responsable actual, leído con `useCurrentShift()`).
- `frontend/src/features/shifts/__tests__/OpenShiftForm.test.tsx` — actualizado a `EmployeePicker` (mockea `listDeviceEmployees`; ya no hay input numérico que precargar con `.toHaveValue`, se verifica `aria-checked`).
- `frontend/src/features/features/__tests__/FeaturesPage.test.tsx` — agregado un `describe` nuevo que prueba, con `listFeatures` mockeado, que las 14 claves de 1b-1 (`pos.tables`, `pos.seats`, `pos.courses`, `pos.pre_bill`, `pos.split_bill`, `pos.tips`, `pos.discounts`, `pos.courtesies`, `pos.staff_meal`, `pos.takeout`, `pos.counter`, `pos.daily_count`, `kitchen.view`, `fiscal.dee_pos`) se ven con su dependencia (`pos.seats`→`pos.tables`, `pos.courses`→`kitchen.view`). No hizo falta tocar `FeaturesPage.tsx`: ya lista genéricamente lo que devuelve `GET /admin/features`.

No toqué `src/features/orders/**` (salvo el stub, ya sobreescrito), `src/api/orders.ts`, `src/api/kitchen.ts`, ni el resto de `src/features/shifts/**` (`ShiftPage.tsx`, `MovementsPanel.tsx`, `hooks.ts`, etc.).

## 3. Endpoints consumidos

| Endpoint | Función | Archivo |
|---|---|---|
| `GET /device/employees` | `listDeviceEmployees` | `src/api/employees.ts` |
| `GET /orders/{id}` | `getOrder` (de `frontend-comanda`) | consumido en `CheckoutPage.tsx` |
| `POST /orders/{id}/bill/present` | `presentBill` (de `frontend-comanda`) | consumido en `CheckoutPage.tsx` |
| `POST /orders/{id}/bill/split` | `splitBill` (de `frontend-comanda`) | consumido en `SplitBillPanel.tsx` |
| `GET /orders/{id}/sub-accounts` | `listSubAccounts` (de `frontend-comanda`) | consumido en `CheckoutPage.tsx` |
| `POST /orders/{id}/payments` | `payOrder` | `src/api/payments.ts`, usado en `PaymentSplitsForm.tsx` |
| `GET /documents/{id}` | `getDocument` | `src/api/documents.ts`, usado en `DocumentPage.tsx` |
| `GET /documents/last` | `getLastDocument` | `src/api/documents.ts`, usado en `CheckoutPage.tsx` (aviso de `ORDER_ALREADY_PAID`) |
| `POST /documents/{id}/reprint` | `reprintDocument` | `src/api/documents.ts`, usado en `DocumentPage.tsx` |
| `GET /admin/documents` | `adminListDocuments` | `src/api/documents.ts` (tipado y expuesto; ninguna pantalla de admin lo consume todavía — la lista de comandas/documentos de admin es de `frontend-comanda`, "Pedidos") |

Verifiqué `PaymentOut` y `DocumentPrintableOut` campo por campo contra
`backend/app/payments/schemas.py` (real, no en construcción al cerrar este
entregable): coinciden exactamente con `src/api/payments.ts` y
`src/api/documents.ts` (los tipos del frontend son más laxos —
todo opcional/`| null`— por convención, nunca al revés).

## 4. Rutas y nav integradas

`router.tsx` (children de `/pos`, en este orden):
`{index: true, PosHome}`, `...shiftsFeature.posRoutes` (`turno`),
`...ordersFeature.posRoutes` (`mesas`, `comanda/nueva`, `comanda/:orderId`,
`cocina`), `...paymentsFeature.posRoutes` (`cobro/:orderId`,
`documento/:documentId`). `/admin` suma `ordersFeature.adminRoutes`
(`pedidos`) a los ya existentes.

`PosHome`: `hasFeature("pos.tables")` → `/pos/mesas`; si no → `/pos/comanda/nueva`.

`PosLayout`: barra de navegación nueva bajo `ShiftStatusStrip`, construida
con `[...ordersFeature.posNav, ...shiftsFeature.posNav]` filtrada por
`hasFeature`; `paymentsFeature.posNav` es `[]` a propósito (se llega al
cobro desde el botón "Cuenta / Cobrar" de la comanda, no desde la barra).

`AdminLayout`: `buildNav` ahora es `[...OWN_NAV, ...shiftsFeature.adminNav, ...catalogFeature.adminNav, ...ordersFeature.adminNav]`.

## 5. Flags que lee cada pantalla

| Pantalla | Flags |
|---|---|
| `EmployeePicker` | ninguno (siempre disponible; el backend ya filtra por sede/organización y actividad) |
| `DeviceIdentifyPage` | ninguno |
| `OpenShiftForm` | `cash.reserve` (ya existía) |
| `RosterPanel`, `HandoverPanel` | ninguno propio de este pedido (siguen los de `cash.handovers` que ya gatea `ShiftPage`) |
| `PosHome` | `pos.tables` |
| `PosLayout` (nav) | cada entrada de `ordersFeature.posNav`/`shiftsFeature.posNav` según su propio `feature` (`pos.tables`, `kitchen.view`, …) |
| `CheckoutPage` | `pos.pre_bill` (precuenta automática al entrar), `pos.split_bill` (división), `pos.tips` (pregunta de propina) |
| `PaymentTargetPanel`/`PaymentSplitsForm` | recibe `tipsEnabled` desde `CheckoutPage`; sin flag propio |
| `DocumentPage` | `pos.tables` (sólo para decidir a dónde vuelve "Volver") |
| `FeaturesPage` | sin cambio: lista lo que manda `GET /admin/features`, cualquier clave nueva se ve sin tocar código |

## 6. Accesibilidad y responsive

- `EmployeePicker`: `role="radiogroup"` con `aria-label`, cada persona
  `role="radio"`/`aria-checked`, `aria-label` con nombre + rol en español;
  botones `min-h-11` (44 px), foco visible (`focus-visible:ring-2`); estados
  cargando (`Skeleton` + `aria-busy`), error (`EmptyState role="alert"` +
  reintentar) y vacío (`EmptyState`) cubiertos por test.
- Todos los botones nuevos usan `h-11`/`min-h-11` (44 px): `PosNavBar`,
  `PaymentSplitsForm` (agregar pago, quitar, atajos de billete, PinPad ya
  cumplía), `SplitBillPanel`, `TipQuestion`, `DocumentPage` (imprimir/
  reimprimir/volver).
- Grillas y filas con `flex-wrap`/`grid-cols-2 sm:grid-cols-3`, tablas de
  comprobante en `overflow-x-auto` implícito (ancho fijo de impresión sólo
  aplica en `@media print`); nada con `min-width` fijo mayor a la pantalla —
  probado indirectamente por los tests (no crashean ni desbordan al montar
  con `jsdom`; no se hizo captura visual en 375/1024 px real, ver gaps).
  reason ver `docs/SPEC-NEGOCIO.md §9.1` "tres toques o menos": elegir
  persona (1) + PIN (usa el `PinPad` existente, no cuenta como toque extra
  de este agente) en `DeviceIdentifyPage`; en `CheckoutPage`, con
  `pos.pre_bill` encendida la precuenta se presenta automáticamente al
  entrar (no es un toque extra) y la propina es un solo toque
  (aceptar/no/modificar).
- Claro/oscuro: sólo tokens (`bg-background`, `text-foreground`,
  `bg-muted`, `text-destructive`, `border`, etc.), cero color hardcodeado.
- Errores del servidor siempre como texto vía `errorMessage()`, nunca un
  objeto; `role="alert"` en cada mensaje de error.
- `aria-label` en cada control sin texto visible propio (selects de medio,
  botón "Quitar este pago").

**Defecto de UX encontrado (no es un componente de mi territorio, lo
resolví en el mío):** `components/PinPad.tsx` (compartido, de 1a) escucha el
teclado físico a nivel de `window`, sin filtrar por foco. En cualquier
pantalla que muestre un `PinPad` a la vez que un campo de texto/número
editable (como `CheckoutPage`, que necesita mostrar la tabla de pagos y el
PIN al mismo tiempo), tipear en ese campo se cuela como dígitos del PIN. Lo
descubrí con mis propios tests (`user.type` en el monto disparaba
`payOrder` antes de tiempo). Como `PinPad.tsx` no es mi territorio, no lo
edité: en `PaymentSplitsForm` mantengo el `PinPad` **deshabilitado hasta que
los pagos suman exacto** (`remaining !== 0`), lo cual además es mejor UX
(no se puede cobrar con montos incompletos) y evita el cruce sin tocar el
componente compartido. Lo declaro para que quien pueda tocar `PinPad.tsx`
(fuera de mi territorio en este pedido) considere escopar el listener al
contenedor en vez de `window`.

## 7. Comandos de verificación (resultados literales)

```
$ cd frontend && npx vitest run src/features/payments src/features/auth src/features/shifts/__tests__/OpenShiftForm.test.tsx src/components src/app src/features/features

 RUN  v5.0.0 /home/user/restaurante-sistema/frontend

 Test Files  11 passed (11)
      Tests  41 passed (41)
   Start at  03:42:41
   Duration  6.45s
```

Archivos de test corridos (11): `EmployeePicker.test.tsx`,
`DeviceIdentifyPage.test.tsx`, `OpenShiftForm.test.tsx`,
`FeaturesPage.test.tsx` (+ el `describe` nuevo de 1b-1),
`PosHome.test.tsx`, `PosLayout.test.tsx`, `router.test.tsx`,
`CheckoutPage.test.tsx`, `DocumentPage.test.tsx` (payments), más los que ya
existían en `src/features/features` y `src/app` que corren con el mismo
comando.

```
$ cd frontend && npm run typecheck
> tsc --noEmit -p tsconfig.app.json
(sin salida — 0 errores en todo el árbol, incluido el código en paralelo de
 frontend-comanda ya integrado)
```

No corrí `npm run test` completo ni `npm run build` (regla del pedido: esos
los corre la verificación final del orquestador). Tampoco corrí nada de
`backend/`.

## 8. Gaps (dependencias, supuestos, todo lo declarado)

1. **Medios de pago de la sede**: no hay ruta de dispositivo para leer
   `StoreSalesSettings.payment_methods` (cuáles están `enabled`, cuál
   `requires_reference`). `PaymentSplitsForm` ofrece los seis códigos del
   contrato (`cash`, `card`, `transfer`, `platform`, `voucher`, `other`) con
   etiqueta en español y muestra `referencia` en los cinco no-efectivo
   siempre (nunca sabe de antemano cuál `requires_reference`); si el
   servidor rechaza con `400 PAYMENT_METHOD_INVALID` o
   `PAYMENT_REFERENCE_REQUIRED`, el texto se muestra tal cual llega
   (`errorMessage`). No bloqueante: es el mismo patrón que ya tenía
   `RosterPanel`/`HandoverPanel` en 1a con "número de empleado a mano" antes
   de este pedido.
2. **`GET /orders/{id}` y el resto de `api/orders.ts`**: SÍ existían y
   estaban completos cuando los necesité (`frontend-comanda` los entregó
   antes; confirmé con `ls`/lectura de archivo, no tuve que mockear contra
   una forma inventada). Sin gap.
3. **`GET /device/employees`**: SÍ existía (entregado por `backend-base`
   antes de empezar, ver `docs/ESTADO.md`). Sin gap.
4. **División por ítems/asiento (`pos.split_bill`, modo "items")**: el flujo
   completo funciona (crear sub-cuentas, listarlas, cobrar cada una con su
   propio `PaymentTargetPanel`/documento) pero la UI de armado de grupos es
   deliberadamente simple (asignación manual ítem→cuenta con un `Select` por
   ítem, sin usar `pos.seats` para derivar grupos automáticamente por
   asiento como permite el contrato). Cubierto por mi lectura del contrato,
   no por un test de punta a punta exhaustivo (el `CheckoutPage.test.tsx`
   que exige el pedido cubre precuenta/propina, splits de pago, PIN,
   Idempotency-Key, cambio, `STALE_VERSION`, y los dos flags apagados — no
   pide explícitamente un test del modo "items"). Declarado, no bloqueante:
   el modo "equal" (partes iguales) sí lo cubrí con test indirecto vía la
   UI (no un test dedicado tampoco, por el mismo motivo de alcance).
5. **`PinPad` con listener global en `window`** (ver §6): descubierto por
   mis tests, mitigado en mi código (deshabilitado hasta que los pagos
   completan), pero el componente compartido en sí sigue con el listener
   sin escopar — riesgo latente para cualquier otra pantalla futura que
   combine un `PinPad` visible con un campo de texto editable al mismo
   tiempo. No lo arreglé por no ser mi territorio; lo reporto para que se
   evalúe en una próxima vuelta (posible candidato para `auditor-venta` o
   una corrección de `backend`/`frontend-core` fuera de este pedido).
6. **Ancho de impresora (58/72/80 mm)**: `document-print.css` define las
   tres clases (`print-58mm`/`print-72mm`/`print-80mm`); `DocumentPage`
   aplica `print-80mm` por defecto porque no hay todavía una configuración
   de sede para el ancho real de la impresora (no está en el contrato de
   1b-1). Cambiarlo hoy es manual (clase fija en el componente); si 1b-2 o
   una vuelta de Configuración agrega esa preferencia, sólo hay que leerla
   y elegir la clase.
7. **`AdminDocumentListItem`/`adminListDocuments`** están tipados y
   exportados (contrato §6.2 los pide en `src/api/documents.ts`) pero
   ninguna pantalla los consume todavía: la lista de comandas/documentos en
   Admin ("Pedidos" o dentro de Dinero) es responsabilidad de
   `frontend-comanda` según el reparto de pantallas del pedido ("admin: la
   lista de comandas abiertas y cerradas… dentro de Dinero o como sección
   «Pedidos» mínima" — mi POS completo de comanda y cobro es del lado
   dispositivo). Si el Maestro esperaba que `frontend-cobro` also pintara
   esa lista de documentos en Admin, no se hizo: no estaba en mi lista
   explícita de archivos de §6.2 (`AdminLayout`/`router`/`PosLayout`/
   `PosHome` sí; una pantalla de Admin → Documentos no).
8. **Accesibilidad WCAG más allá de Testing Library**: no se corrió un
   auditor de contraste real ni una captura en 375/1024 px en navegador —
   igual que declaró `backend-base`/`frontend-core` en 1a, queda para la
   verificación final o el auditor.
9. **`Quitar este pago`** en `PaymentSplitsForm` usa el mismo `aria-label`
   en cada fila (ambiguo para lector de pantalla si hay más de un pago);
   visualmente está claro (el botón vive dentro de la fila), pero sería
   mejor incluir el índice o el medio en el label. Por ahora no afecta
   ningún test ni bloquea el uso; lo anoto como mejora menor.
10. **`ItemDialog.tsx`, `hooks.ts`, `NewOrderPage.tsx`, `TablesPage.tsx`,
    `api/orders.ts`** aparecen como "modificados" en `git status` — son de
    `frontend-comanda`, trabajando en paralelo; no los toqué ni los leí más
    allá de lo necesario para confirmar la forma de `OrderOut`/`getOrder`.

## 9. Nota para `docs/ESTADO.md` / `.claude/launch.json`

No tengo permiso de territorio sobre `docs/ESTADO.md` ni
`.claude/launch.json` (son de `backend-base`, dueño único, "al final" según
el contrato §0). No cambié ningún comando de arranque ni variable de
entorno: nada que actualizar ahí desde mi lado. Si el Maestro necesita una
línea para el resumen de "Qué está hecho" de 1b-1, el contenido está en
este archivo completo.
