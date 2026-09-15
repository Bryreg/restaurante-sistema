# frontend-fiscal — entrega (pedido 1b-2)

Agente: **frontend-fiscal**. Rol: "Frontend fiscal, clientes y POS de cobro".
Territorio: `frontend/src/features/fiscal/**` (nuevo), `frontend/src/features/customers/**`
(nuevo), `frontend/src/features/payments/**`, `frontend/src/api/{fiscal,customers,payments,documents}.ts`.
No toqué `src/app/**`, `src/components/**`, ni ningún otro `src/features/**`/`src/api/*.ts`
fuera de esa lista, ni nada de `backend/`.

## 1. Resumen

Construí las cuatro pantallas de administración de documento fiscal
(Documentos fiscales, Rangos de numeración, Notas, Devoluciones pendientes),
la pantalla de Clientes con habeas data, y saldé la deuda de 1b-1 en el POS
de cobro: A-10 (el frontend dejó de sumar «venta + propina»), A-11 (la
leyenda legal dejó de tener respaldo hardcodeado), `DocumentPage` ahora
muestra estado DIAN/CUDE/QR, y `PaymentSplitsForm` ahora consume
`GET /device/payment-methods` en vez de ofrecer los seis códigos fijos.

Trabajé contra el backend real de `backend-fiscal` y `backend-clientes-dinero`
(sus entregables ya estaban en `features/fase-1b-venta/outputs-1b-2/` cuando
empecé) — leí `app/fiscal/{router,schemas,service,provider}.py`,
`app/payments/{router,schemas,service}.py`, `app/customers/{router,schemas}.py`
y `app/refunds/{router,schemas}.py` directamente en el árbol para tipar campo
por campo, no sólo sus entregables en prosa.

**Gap crítico para el Conciliador, no bloqueante para mi entrega pero sí
para que el sistema funcione de punta a punta**: `app.customers`/`app.refunds`
todavía NO están en `app.main.DOMAINS` ni en
`app.core.models_registry.MODEL_MODULES` (confirmado leyendo `app/main.py`
en el momento de escribir esto). Sus routers **no están montados** en la app
real — `GET/PATCH/POST /admin/customers/*` y `GET/POST /admin/pending-refunds/*`
responden `404` hoy, aunque el código de esos dos dominios existe y está
probado en aislamiento (`backend-clientes-dinero.md §6` ya lo declaró como
bloqueante sin dueño asignado). Construí `CustomersPage` y
`PendingRefundsPage` igual, contra el contrato publicado — no es un endpoint
inventado, es un endpoint real sin cablear — y lo repito acá para que quien
cierre 1b-2 no lo pierda de vista.

## 2. Componentes creados y modificados

### Nuevos

| Archivo | Qué |
|---|---|
| `frontend/src/api/fiscal.ts` | Tipos y funciones para rangos, documentos/estados DIAN, evidencia, exportación, notas y devoluciones pendientes. |
| `frontend/src/api/customers.ts` | Tipos y funciones para el maestro de clientes, consentimientos, bitácora de habeas data y `erase`. |
| `frontend/src/features/fiscal/index.ts` | `fiscalFeature = { adminRoutes, adminNav }` — patrón de `src/features/orders/index.ts`. |
| `frontend/src/features/fiscal/DocumentsPage.tsx` | Admin → Documentos fiscales: filtro por estado (servidor) y tipo (cliente, ver §5 gaps), reintento, evidencia (diálogo), export de evidencia. |
| `frontend/src/features/fiscal/RangesPage.tsx` | Admin → Rangos de numeración: listado con avance y alertas (80 % consumido / 30 días para vencer), alta de rango nuevo. |
| `frontend/src/features/fiscal/NotesPage.tsx` | Admin → Notas: alta (busca el documento original, arma líneas, tipo, motivo, devolución opcional) y listado. |
| `frontend/src/features/fiscal/PendingRefundsPage.tsx` | Admin → Devoluciones pendientes: listado y `settle` (desde el turno abierto o de la mano del dueño). |
| `frontend/src/features/fiscal/components.tsx` | `LocalDateRangeFilter`/`LocalCsvExportButton` — versión local de los compartidos que todavía no existen (gap, ver §5). |
| `frontend/src/features/fiscal/__tests__/{RangesPage,DocumentsPage,NotesPage,PendingRefundsPage}.test.tsx` | Tests de cada pantalla. |
| `frontend/src/features/customers/index.ts` | `customersFeature = { adminRoutes, adminNav }`. |
| `frontend/src/features/customers/CustomersPage.tsx` | Admin → Clientes: búsqueda, corrección, consentimientos, bitácora, `erase` con el diálogo de confirmación textual exigido. |
| `frontend/src/features/customers/components.tsx` | Copia local de `LocalDateRangeFilter`/`LocalCsvExportButton` (mismo gap, duplicado a propósito para no acoplar features). |
| `frontend/src/features/customers/__tests__/CustomersPage.test.tsx` | Tests de la pantalla. |
| `frontend/src/features/payments/__tests__/PaymentSplitsForm.test.tsx` | Tests nuevos: medios de pago de la sede (filtrado, referencia, loading/error/vacío). |
| `frontend/src/features/payments/__tests__/PaymentTargetPanel.test.tsx` | Tests nuevos: A-10 (venta/propina separadas, `null ≠ 0`). |

### Modificados

| Archivo | Qué cambió |
|---|---|
| `frontend/src/api/payments.ts` | `PaymentOut` gana `amount_due`/`requires_invoice`; `PaymentIn` gana `customer?`/`requests_invoice?`; nuevos `CustomerIn`/`CustomerConsentIn`; nuevo `DevicePaymentMethod` + `listDevicePaymentMethods()` (`GET /device/payment-methods`). |
| `frontend/src/api/documents.ts` | `DocumentFiscalInfo` reescrito (`dian_status`, `contingency`, `range` tipado); `DocumentCustomerRef` gana `email`/`address`/`municipality_dane`; `AdminDocumentListItem`/`adminListDocuments` ganan `type`/`status` + `adminDocumentsCsvUrl` (nadie más lo consume todavía, ver §5). |
| `frontend/src/features/payments/PaymentTargetPanel.tsx` | **A-10.** Ver §3. |
| `frontend/src/features/payments/CheckoutPage.tsx` | **A-11.** Ver §3. |
| `frontend/src/features/payments/PaymentSplitsForm.tsx` | Consume `GET /device/payment-methods`; ya no ofrece los seis códigos fijos; el campo "Referencia" sólo aparece si el servidor marca `requires_reference`; el éxito de cobro pinta `amount_due` tal cual llega. |
| `frontend/src/features/payments/DocumentPage.tsx` | Muestra estado DIAN (badge con texto, nunca sólo color), CUDE y QR cuando llegan. La leyenda de contingencia no necesitó bloque propio: `doc.legend` ya trae el texto completo redactado por el servidor (`LEGEND_CONTINGENCY` en `app/fiscal/service.py`) y `DocumentPage` ya lo pintaba tal cual desde 1b-1. |
| `frontend/src/features/payments/__tests__/fixtures.ts` | `buildPaymentOut` gana `amount_due`/`requires_invoice`; `buildDocument().fiscal` gana `dian_status`/`contingency`. |
| `frontend/src/features/payments/__tests__/CheckoutPage.test.tsx` | Mockea `listDevicePaymentMethods`; la aserción de «Total a cobrar» se reemplaza por las dos líneas separadas (A-10). |
| `frontend/src/features/payments/__tests__/DocumentPage.test.tsx` | Dos tests nuevos: estado DIAN validado con CUDE/QR, y contingencia con su leyenda. |

## 3. A-10 y A-11: antes y después

### A-10 — el frontend sumaba «venta + propina»

- **Antes**: `frontend/src/features/payments/PaymentTargetPanel.tsx:51`
  ```tsx
  const totalDue = (target.totals.total ?? 0) + (tip?.amount ?? 0);
  ```
  pintado en `:63` como `<p>Total a cobrar: {formatCOP(totalDue)}</p>`.
- **Después**: `frontend/src/features/payments/PaymentTargetPanel.tsx:64-99`. La
  venta (`target.totals.total`) y la propina (`tip.amount`) se pintan en dos
  líneas **separadas**, cada una tal cual llega — nunca sumadas por el
  cliente. Si `target.totals.total` no llegó, la pantalla lo dice
  explícitamente (`role="alert"`, "No se pudo calcular el total de esta
  cuenta") en vez de ofrecer cobrar sobre `$0`. El único lugar donde sigue
  existiendo una suma en este componente es `totalDue` que se le pasa a
  `PaymentSplitsForm` (`saleTotal + (tip?.amount ?? 0)`, línea 105) — y ese
  número **nunca se muestra**: es sólo el objetivo interno contra el que
  `PaymentSplitsForm` calcula su guía "Faltan $X" (la única suma tolerada
  desde 1b-1, `lib.ts::sumTyped`, que el servidor vuelve a validar con
  `400 SPLITS_DO_NOT_MATCH`).
  - Además, el `?? 0` sobre `tip?.amount` en ese cálculo interno **no** es el
    mismo problema que denunciaba A-10: `tip` es estado local que arma
    `TipQuestion` (nunca `undefined` salvo "todavía no se respondió la
    propina", que ya está bloqueado antes de llegar a esta rama), no un
    campo de plata que el backend pueda omitir.
  - **Gap declarado** (ver §5): el arreglo completo de A-10 — que el propio
    backend mande un monto YA sumado antes de cobrar — necesita un campo
    nuevo en `OrderOut.totals`/`SubAccountOut.totals`/`PreBillOut`
    (`app/orders/schemas.py`), que ningún agente de 1b-2 tuvo en su
    territorio (`backend-fiscal.md §7` punto 9 ya lo señala desde el lado
    del backend). `PaymentOut.amount_due` sí existe, pero recién en la
    respuesta DESPUÉS de cobrar — lo pinto ahí (ver `PaymentSplitsForm.tsx`,
    toast de éxito), no antes.

### A-11 — leyenda legal con respaldo hardcodeado

- **Antes**: `frontend/src/features/payments/CheckoutPage.tsx:197`
  ```tsx
  const legend = preBill?.legend ?? "NO ES FACTURA — documento informativo";
  ```
  y se pintaba siempre que `pos.pre_bill` estaba encendida, **incluso con
  `preBill` en `null`** (mientras `bill/present` viajaba o había fallado).
- **Después**: `frontend/src/features/payments/CheckoutPage.tsx:209`
  ```tsx
  const legend = preBill?.legend;
  ```
  y el bloque que la pinta (línea ~272) ahora es
  `{legend ? <p>…{legend}</p> : null}` — si no llegó, no se muestra nada.
  Mismo patrón que ya usaba `DocumentPage.tsx` desde 1b-1. La leyenda sigue
  siendo, en todos los casos, el texto que compone `app/fiscal/service.py`
  según el estado DIAN y la contingencia (`LEGEND_*`), nunca un texto que
  arma el cliente.

## 4. Endpoints consumidos (para el Conciliador)

| Endpoint | Función | Archivo |
|---|---|---|
| `GET /admin/fiscal/ranges?store_id=` | `listFiscalRanges` | `src/api/fiscal.ts`, `RangesPage.tsx` |
| `POST /admin/fiscal/ranges` | `createFiscalRange` | `src/api/fiscal.ts`, `RangesPage.tsx` |
| `GET /admin/fiscal/ranges?format=csv` | `fiscalRangesCsvUrl` (enlace directo) | `RangesPage.tsx` |
| `GET /admin/fiscal/documents?store_id=&status=` | `listFiscalDocuments` | `src/api/fiscal.ts`, `DocumentsPage.tsx` |
| `GET /admin/fiscal/documents?format=csv` | `fiscalDocumentsCsvUrl` | `DocumentsPage.tsx` |
| `POST /admin/fiscal/documents/{id}/retry` | `retryFiscalDocument` | `src/api/fiscal.ts`, `DocumentsPage.tsx` |
| `GET /admin/fiscal/documents/{id}/evidence` | `getFiscalDocumentEvidence` | `src/api/fiscal.ts`, `DocumentsPage.tsx` (diálogo) |
| `GET /admin/fiscal/export?store_id=&from=&to=` | `fiscalExportUrl` (enlace directo), `getFiscalExportBundle` (tipada, sin consumidor de pantalla todavía) | `DocumentsPage.tsx` |
| `POST /admin/documents/{id}/notes` | `createNote` | `src/api/fiscal.ts`, `NotesPage.tsx` |
| `GET /admin/notes?store_id=&from=&to=` | `listNotes` | `src/api/fiscal.ts`, `NotesPage.tsx` |
| `GET /admin/notes?format=csv` | `notesCsvUrl` | `NotesPage.tsx` |
| `GET /admin/pending-refunds?store_id=&status=` | `listPendingRefunds` | `src/api/fiscal.ts`, `PendingRefundsPage.tsx` |
| `GET /admin/pending-refunds?format=csv` | `pendingRefundsCsvUrl` | `PendingRefundsPage.tsx` |
| `POST /admin/pending-refunds/{id}/settle` | `settlePendingRefund` | `src/api/fiscal.ts`, `PendingRefundsPage.tsx` |
| `GET /documents/{id}` | `getDocument` (de `frontend-cobro`, 1b-1) | `NotesPage.tsx` (busca el documento original para armar la nota) |
| `GET /admin/customers?doc_number=` | `listCustomers` | `src/api/customers.ts`, `CustomersPage.tsx` |
| `GET /admin/customers?format=csv` | `customersCsvUrl` | `CustomersPage.tsx` |
| `PATCH /admin/customers/{id}` | `patchCustomer` | `src/api/customers.ts`, `CustomersPage.tsx` |
| `POST /admin/customers/{id}/consents` | `addCustomerConsent` | `src/api/customers.ts`, `CustomersPage.tsx` |
| `GET /admin/customers/{id}/requests` | `listCustomerRequests` | `src/api/customers.ts`, `CustomersPage.tsx` |
| `GET /admin/customers/{id}/requests?format=csv` | `customerRequestsCsvUrl` | `CustomersPage.tsx` |
| `POST /admin/customers/{id}/erase` | `eraseCustomer` | `src/api/customers.ts`, `CustomersPage.tsx` |
| `POST /orders/{id}/payments` | `payOrder` (de `frontend-cobro`, 1b-1; `PaymentIn`/`PaymentOut` ampliados por mí) | `PaymentSplitsForm.tsx` |
| `GET /device/payment-methods` | `listDevicePaymentMethods` (nuevo) | `src/api/payments.ts`, `PaymentSplitsForm.tsx` |
| `GET /documents/{id}` | `getDocument` (de `frontend-cobro`, 1b-1; `DocumentPrintable.fiscal` ampliado por mí) | `DocumentPage.tsx` |
| `POST /documents/{id}/reprint` | `reprintDocument` (de `frontend-cobro`, 1b-1) | `DocumentPage.tsx` (sin cambios de mi parte) |
| `GET /admin/shifts?store_id=` | `listAdminShifts` (de otro agente, sólo lectura) | `PendingRefundsPage.tsx` (encuentra el turno abierto para ofrecer `settle {from: "shift"}`) |

No inventé ningún endpoint: cada uno de los de arriba está publicado en
`backend/app/{fiscal,payments,customers,refunds}/router.py` (leídos
directamente) o ya existía de 1b-1. `GET /admin/documents` (general, con
`type`/`status`) quedó tipado en `documents.ts` porque está en mi territorio
de archivo, pero ninguna pantalla mía lo consume (no es parte de mi mandato
de pantallas — "Ventas"/"Pedidos" son de otro agente).

## 5. Accesibilidad y responsive

- **Estado nunca sólo por color**: todo `Badge` de estado DIAN, contingencia
  vencida, cliente anonimizado/activo, etc. lleva texto (`DIAN_STATUS_LABEL`)
  y nunca depende sólo de `variant`.
- **Botones ≥ 44 px** en toda acción del POS (`h-11`/`min-h-11`: filas de
  `PaymentSplitsForm`, `PaymentTargetPanel`); en el admin (PC) seguí el
  criterio ya usado por `OrdersAdminPage`/`ShiftPage` (`h-9`/`h-10`/`h-11`
  según si es una acción de fila o una acción primaria).
- **Foco visible y navegación por teclado**: todo control es `Button`/
  `Input`/`Select`/`Checkbox`/`Textarea` de `src/components/ui/**`, que ya
  trae `focus-visible:ring-*` — no escribí ningún elemento interactivo sin
  pasar por esos primitivos.
- **Labels**: cada campo de formulario nuevo tiene `<Label htmlFor>` (con
  `useId()` en los componentes locales para no colisionar si la pantalla se
  monta más de una vez) o `aria-label` cuando el control no tiene texto
  visible propio (selects de filtro, checkboxes de línea en `NotesPage`).
- **Errores del servidor como texto legible**: todo error pasa por
  `errorMessage()` (nunca se renderiza un objeto) y vive en un elemento
  `role="alert"`.
- **`null` ≠ 0**: `formatCOP` (nunca `?? 0` sobre un campo de plata que venga
  del servidor) en toda pantalla nueva; el caso explícito lo prueba
  `PaymentTargetPanel.test.tsx` ("null ≠ 0: sin `totals.total` todavía
  cargado…").
- **Claro/oscuro, sin color hardcodeado**: sólo tokens (`bg-muted`,
  `text-destructive`, `border`, `bg-primary`, etc.); la barra de avance del
  rango (`RangesPage`) usa `bg-muted`/`bg-primary`, no un color fijo.
  Íconos de `lucide-react` (`Download`), nunca emojis.
- **Responsive**: ninguna pantalla nueva fija un ancho mínimo mayor a la
  pantalla; filtros y acciones usan `flex flex-wrap`, tablas van en
  `overflow-x-auto` (mismo patrón que `OrdersAdminPage`). Las pantallas
  nuevas son de **admin (PC)**, no del POS — el ítem del checklist "POS en
  375 px y 1024 px sin scroll horizontal" aplica a `CheckoutPage`/
  `DocumentPage`/`PaymentSplitsForm`/`PaymentTargetPanel`, que ya cumplían
  desde 1b-1 y mis cambios ahí (líneas Venta/Propina, badges de estado DIAN)
  reusan las mismas clases `flex flex-wrap`/`space-y-*` sin anchos fijos.
  No hice una corrida real en navegador a 375/1024 px (ver gaps).
- **Toda lista exporta `format=csv`**: `RangesPage`, `DocumentsPage`,
  `NotesPage`, `PendingRefundsPage`, `CustomersPage` y la bitácora de
  habeas data dentro del diálogo de cliente tienen su botón de exportar.

## 6. Gaps

1. **`app.customers`/`app.refunds` no están montados en la app real**
   (`app.main.DOMAINS`/`app.core.models_registry.MODEL_MODULES`) — ya
   declarado por `backend-clientes-dinero.md §6` como bloqueante sin dueño.
   Confirmé de nuevo leyendo `app/main.py` al momento de cerrar este
   entregable: sigue sin `"customers"`/`"refunds"` en `DOMAINS`. Consecuencia
   concreta para mi territorio: `CustomersPage` y `PendingRefundsPage`
   existen, están tipadas contra el contrato real y tienen tests que pasan
   (mockeando la API), pero contra un backend real sin ese wiring, sus
   llamadas HTTP responden `404`. No es un endpoint inventado por mí: es un
   endpoint real sin cablear. Se lo señalo de nuevo al Conciliador porque
   ninguno de los tres agentes de backend/frontend de 1b-2 tiene
   `app/main.py`/`app/core/models_registry.py` en su territorio declarado.

2. **A-10 no se cierra del todo en el frontend porque el campo que lo
   cerraría no existe todavía en el backend, ANTES de cobrar.** Ver §3 —
   `PaymentOut.amount_due` (después de cobrar) ya lo pinto; un
   `amount_due`/monto ya sumado en `PreBillOut`/`OrderOut.totals`/
   `SubAccountOut.totals` (antes de cobrar) necesita a alguien con
   `app/orders/schemas.py` en su territorio, que ningún agente de 1b-2 tuvo
   asignado (confirmado con `backend-fiscal.md §7` punto 9). Mientras tanto,
   "venta" y "propina" se muestran como dos líneas separadas — la
   alternativa que el propio hallazgo A-10 dejó declarada.

3. **A-12 (`app/orders/money.py::prorate`) sigue abierto.** No es
   territorio de este agente (es backend, dominio `orders`); ni
   `backend-fiscal` ni `backend-clientes-dinero` lo tocaron tampoco (ambos
   lo declararon explícitamente fuera de su territorio). Sigue exactamente
   como lo dejó el auditor de 1b-1.

4. **`TAX_RATE_BY_CODE` sigue declarado localmente en
   `app/orders/service.py`**, no centralizado en `app/core/tax.py` —
   confirmado con `grep` al escribir esto. Es backend, fuera de mi
   territorio; ni `backend-fiscal` lo centralizó (lo declaró explícitamente:
   "no lo creé, sería territorio de `app/core`, ajeno").

5. **`src/components/DateRangeFilter.tsx` y `src/components/CsvExportButton.tsx`
   todavía no existen** — comprobé con `ls` al empezar a escribir las
   pantallas de listado y de nuevo al cerrar este entregable: siguen sin
   estar publicados. Usé versiones locales
   (`src/features/fiscal/components.tsx`, duplicada en
   `src/features/customers/components.tsx`) con la MISMA forma de props que
   el Maestro describió para los compartidos (`{from, to, onChange}` y
   `{href, label?}`), para que el día que se publiquen, cambiar el import
   sea un cambio de una línea por pantalla. No creé ningún archivo dentro de
   `src/components/**` (territorio ajeno).

6. **Filtro por tipo de documento en "Documentos fiscales" es del lado del
   cliente.** `GET /admin/fiscal/documents` (el endpoint real, leído en
   `app/fiscal/router.py`) sólo acepta `status` como query param, no
   `document_type`, aunque `spec.md` describe el filtro como "por estado y
   tipo". Filtré por tipo sobre las filas ya traídas (no es plata, es
   filtrar una lista ya cargada) y lo documenté en el comentario de
   `listFiscalDocuments` (`src/api/fiscal.ts`). No inventé un query param
   que el servidor ignoraría en silencio.

7. **`GET /admin/fiscal/export` no arma un ZIP con XML reales** — tal como
   ya lo declaró `backend-fiscal.md §4` punto 6 (no hay proveedor real
   todavía). Mi botón "Exportar paquete de evidencia" abre el manifiesto
   JSON en una pestaña nueva (mismo patrón que el resto de los CSV); no
   ofrezco una descarga de archivo binario porque no hay archivo binario
   que ofrecer en esta fase.

8. **Captura de cliente / solicitud de factura en el POS de cobro (checkout)
   no está en esta entrega.** El backend soporta `customer?`/
   `requests_invoice?` en `POST /orders/{id}/payments` (SPEC-NEGOCIO §8.3:
   "el POS ofrece factura electrónica y captura tipo y número de
   documento…") y yo tipé esos campos en `src/api/payments.ts`
   (`CustomerIn`, `CustomerConsentIn`), pero mi mandato explícito de
   pantallas del POS ("Qué construís → POS de cobro") lista exactamente
   cuatro puntos — A-10, A-11, `DocumentPage`, medios de pago de la sede —
   y ninguno es "capturar cliente al cobrar". No construí esa UI para no
   exceder el territorio que se me delimitó explícitamente. Consecuencia
   concreta: una venta que supera
   `invoice_threshold_uvt` × UVT sin cliente identificado falla con
   `400 CUSTOMER_REQUIRED_FOR_INVOICE` (el texto se ve legible, vía
   `errorMessage()`, porque `PaymentSplitsForm` ya maneja cualquier error de
   `payOrder` así) pero el POS no ofrece todavía una manera de capturar los
   datos y reintentar. Declarado explícitamente para que no se dé por
   cerrado sin querer — es del alcance de "Qué construís", no un olvido.

9. **`erase`/`requests` de clientes quedan alcanzables sólo si `customers`
   está encendida**, porque gateé toda la entrada de navegación
   ("Clientes") detrás de esa flag (igual que "Mesas" detrás de
   `pos.tables`), aunque el backend nunca gatea esas dos rutas puntuales
   (son un derecho legal, `backend-clientes-dinero.md §2.3`). Si una sede
   apaga `customers` después de haber creado clientes, alguien necesitaría
   prender la flag de nuevo (o entrar por URL directa a `/admin/clientes`,
   que sigue registrada) para tramitar una supresión. Decisión declarada,
   no un bug: coincide con el patrón de todas las demás secciones opcionales
   del admin.

10. **No corrí Playwright ni un auditor de contraste real** — verificación
    más allá de Testing Library queda para el paso final del orquestador
    (mismo alcance que declararon los agentes de 1b-1 y 1b-2 anteriores).

11. **`AdminDocumentListItem`/`adminListDocuments`/`adminDocumentsCsvUrl`**
    (`src/api/documents.ts`, `GET /admin/documents` general) quedaron
    actualizados con `type`/`status` porque el archivo es mío, pero ninguna
    pantalla mía los consume — la lista general de documentos en "Ventas"
    (si existe) es de otro agente, fuera de mi mandato de pantallas.

## 7. Verificación (comandos y resultado literal)

```
$ cd frontend && npx vitest run src/features/fiscal src/features/customers src/features/payments

 RUN  v5.0.0 /home/user/restaurante-sistema/frontend

 Test Files  9 passed (9)
      Tests  31 passed (31)
```

Archivos de test corridos (9): `PaymentSplitsForm.test.tsx`,
`PaymentTargetPanel.test.tsx`, `CheckoutPage.test.tsx`, `DocumentPage.test.tsx`
(los cuatro de `src/features/payments/__tests__`), `RangesPage.test.tsx`,
`DocumentsPage.test.tsx`, `NotesPage.test.tsx`, `PendingRefundsPage.test.tsx`
(los cuatro de `src/features/fiscal/__tests__`), `CustomersPage.test.tsx`
(`src/features/customers/__tests__`).

```
$ cd frontend && npm run typecheck
> tsc --noEmit -p tsconfig.app.json
(sin salida — 0 errores en todo el árbol)
```

No corrí `npm run test` (suite completa) ni `npm run build`: regla del
pedido — los corre una sola vez, en serie, el orquestador. Tampoco corrí
nada de `backend/` (lo leí, no lo escribí).
