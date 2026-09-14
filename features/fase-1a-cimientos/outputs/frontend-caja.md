# Frontend — POS de turno y Admin Dinero / Turnos y personal

Agente `frontend-caja`. Territorio: `frontend/src/features/shifts/**` (reemplaza
el stub de `frontend-core`) y `frontend/src/api/shifts.ts`. No se tocó ningún
otro archivo — confirmado con `git status` antes de entregar (los cambios que
aparecen en otros archivos del árbol son de los agentes que corren en paralelo
en este mismo pedido: `frontend-core`, `catalogo`, etc.).

## 1. Rutas y componentes

### POS (`/pos/*`, dentro de `PosLayout`)

| Ruta | Componente | Qué hace |
|---|---|---|
| `/pos` (index) y `/pos/turno` | `ShiftPage.tsx` | Sin turno abierto: `OpenShiftForm`. Con turno abierto: `Tabs` con Resumen, Movimientos, Cambio (si `cash.swaps`), Retiros (si `cash.pickups`), Relevo (si `cash.handovers`) y Cierre (siempre). |
| — (barra superior de `PosLayout`, todas las rutas `/pos/*`) | `ShiftStatusStrip.tsx` | Día operativo, turno abierto/cerrado, responsable, avisos "Sin turno → Abrir turno" / "Turno abandonado" / efectivo sobre umbral. Sondea `GET /shifts/current` cada 5 s. |

Componentes internos de `ShiftPage` (no son rutas propias, son las pestañas):

- `OpenShiftForm.tsx` — abrir turno.
- `ShiftSummaryPanel.tsx` — resumen (base, reserva aparte, esperado, responsable) + `RosterPanel.tsx` embebido (entrar/salir/pausa).
- `MovementsPanel.tsx` — ingresos y egresos con causa.
- `CashSwapPanel.tsx` — cambio de denominaciones.
- `PickupsPanel.tsx` — retiros y su reversa.
- `HandoverPanel.tsx` — relevo y arqueo sorpresa (una sola pestaña con un selector de modo).
- `CloseWizard.tsx` — cierre a ciegas en tres pasos (`cash.blind_close` encendida).
- `SingleStepCloseForm.tsx` — cierre en un solo paso (`cash.blind_close` apagada). Ver **GAP 1**.
- `PhotoCaptureField.tsx` — helper compartido de captura de foto → data URL (`<input type=file accept=image capture>`), usado por movimientos, retiros, relevo/arqueo y los dos cierres.

### Admin (`/admin/*`, dentro de `AdminLayout`)

| Ruta | Componente | Qué hace |
|---|---|---|
| `/admin/dinero` | `admin/MoneyAdminPage.tsx` | Pestañas Operacional (`admin/OperationalTab.tsx`) e Historial (`admin/HistoryTab.tsx`), ambas abren `admin/ShiftDetailDialog.tsx` para el detalle. |
| `/admin/personal` | `admin/PeopleAdminPage.tsx` | Pestañas Por persona (`admin/PersonActivityTab.tsx`) y Autorizaciones por autorizador (`admin/AuthorizationsTab.tsx`). |

`shiftsFeature.adminNav` registra "Dinero" y "Turnos y personal" **sin** `feature`
(núcleo, igual que Funciones/Configuración/Historial) — así lo pide la misión.
`shiftsFeature.posNav` registra "Turno" (hoy no hay un tab-bar de POS que lo
consuma todavía porque este pedido no tiene más pantallas de POS que ésta; la
navegación real ocurre porque `ShiftStatusStrip` linkea a `/pos/turno` y
`DeviceIdentifyPage`, de `frontend-core`, ya redirige a `/pos` tras
identificarse — el `index: true` que agrego en `posRoutes` es lo que hace que
esa ruta resuelva a algo en vez de quedar en blanco).

## 2. Endpoints consumidos por pantalla

Todos bajo `/api/v1`, exactamente como los lista
`features/fase-1a-cimientos/spec.md` § "Business day & shifts" y "Employees &
audit" (salvo el que se documenta como GAP 1). Formato: método y ruta → códigos
de error que la pantalla maneja explícitamente (además del texto genérico que
`errorMessage()` siempre muestra para cualquier otro 4xx).

**`ShiftStatusStrip`**
- `GET /shifts/current` (sondeo cada 5 s).

**`OpenShiftForm`**
- `POST /shifts/open` (con `Idempotency-Key`) → `400 SHIFT_ALREADY_OPEN`
  (mensaje genérico), `400 OPENING_DIFFERENCE_NEEDS_CAUSE` (revela causa+nota y
  reintenta con clave nueva), `409` (mensaje genérico, no hay reintento
  automático: el usuario reintenta a mano y el turno del otro ya está abierto).

**`ShiftSummaryPanel` + `RosterPanel`**
- `GET /shifts/{id}` (resumen: base, reserva, roster).
- `POST /shifts/{id}/roster` → cualquier 4xx con `errorMessage()` (incluye
  `PIN_LOCKED`, `PIN_INVALID`, `EMPLOYEE_NOT_IN_ROSTER` si el servidor los usa
  acá).

**`MovementsPanel`**
- `GET /shifts/{id}` (lista de movimientos).
- `POST /shifts/{id}/cash-movements` (con `Idempotency-Key`) → `400
  PETTY_CASH_LIMIT` (revela PIN de administrador, reintenta con
  `authorizer_pin` y clave nueva), `400 AUTHORIZATION_REQUIRED` /
  `AUTHORIZATION_INVALID` / `PIN_LOCKED` (mensaje genérico sobre el mismo PIN
  revelado).

**`CashSwapPanel`**
- `POST /shifts/{id}/cash-swaps` (sin `Idempotency-Key`: no está en la lista
  de la spec ni el router la exige) → `400 SWAP_NOT_ZERO` (mensaje genérico,
  tal cual lo manda el servidor).

**`PickupsPanel`**
- `GET /shifts/{id}` (lista de retiros).
- `POST /shifts/{id}/pickups` (con `Idempotency-Key`) → `400 PHOTO_REQUIRED`
  (marca el campo de foto como obligatorio y reintenta con clave nueva),
  `400 AUTHORIZATION_REQUIRED` / `AUTHORIZATION_INVALID` / `PIN_LOCKED`
  (mensaje genérico).
- `POST /shifts/{id}/pickups/{pid}/reverse` → `400 PICKUP_ALREADY_REVERSED`,
  `AUTHORIZATION_*` (mensaje genérico).

**`HandoverPanel`**
- `GET /shifts/{id}` (lista de relevos/arqueos).
- `POST /shifts/{id}/handovers` (con `Idempotency-Key`) → `400
  FEATURE_DISABLED` (no debería poder llegar acá porque la pestaña ya está
  gateada por `hasFeature`, pero si el flag se apaga mientras la pantalla está
  abierta el mensaje del servidor se muestra igual), `AUTHORIZATION_*`
  (mensaje genérico, relevante sobre todo en `spot_check`), `400
  VALIDATION_ERROR` si falta `new_responsible_id` en un relevo.

**`CloseWizard`** (cuando `cash.blind_close` está encendida)
1. `POST /shifts/{id}/close/count` (con `Idempotency-Key`) → `400
   PHOTO_REQUIRED` (marca la foto como obligatoria y reintenta con clave
   nueva).
2. `GET /shifts/{id}/close/{count_id}/review` (sólo se dispara con
   `count_id` ya asignado — nunca antes).
3. `POST /shifts/{id}/close/{count_id}/confirm` (sin `Idempotency-Key`: el
   router no la exige en este paso) → `400 DIFFERENCE_CHANGED` (vuelve al
   paso 2 con `error.extra.review`), `400 CAUSE_REQUIRED` /
   `IDENTIFIED_CAUSE_REQUIRED` / `PHOTO_REQUIRED` / `CARD_TOTAL_REQUIRED`
   (mensaje genérico; el botón ya se deshabilita localmente cuando
   `requires_cause` está en `true` y no hay causa elegida, para no depender
   sólo del roundtrip).

**`SingleStepCloseForm`** (cuando `cash.blind_close` está apagada — ver GAP 1)
- `POST /shifts/{id}/close` (con `Idempotency-Key`) → `400 CAUSE_REQUIRED` /
  `IDENTIFIED_CAUSE_REQUIRED` / `PHOTO_REQUIRED` / `CARD_TOTAL_REQUIRED`
  (mensaje genérico + reintento con clave nueva para `PHOTO_REQUIRED`).

**`admin/OperationalTab` / `admin/HistoryTab`**
- `GET /admin/shifts?store_id&from&to` (Operacional: `from`/`to` fijados a
  "hoy" en `America/Bogota`, calculado sólo como valor inicial de filtro, no
  como fecha operativa de ningún registro — ver nota en el propio archivo).
- `GET /admin/shifts?store_id&from&to&format=csv` (link de exportar, vía
  `adminShiftsCsvUrl`).

**`admin/ShiftDetailDialog`**
- `GET /admin/shifts/{id}/timeline`.
- `GET /shifts/{id}` (resumen, sólo para decidir si "Cancelar" corresponde:
  sin roster más allá de quien abrió, sin movimientos/cambios/retiros/relevos).
- `POST /admin/shifts/{id}/review`.
- `POST /admin/shifts/{id}/close-administrative` (sólo si `is_stale`).
- `POST /admin/shifts/{id}/reopen` (sólo si `status === "closed"`).
- `DELETE /admin/shifts/{id}` (sólo si `status === "open"` y sin actividad
  detectada) → ver **GAP 2** sobre el motivo.
- `POST /admin/shifts/{id}/adjust-opening`.

**`admin/PersonActivityTab`**
- `GET /admin/employees` (de `frontend-core`, para el selector de persona).
- `GET /admin/employees/{id}/activity?from&to`.

**`admin/AuthorizationsTab`**
- `GET /admin/employees` (selector de autorizador).
- `GET /admin/authorizations?from&to&authorizer_id`.
- `GET /admin/authorizations?...&format=csv` (link de exportar).

## 3. Flags por pantalla (`hasFeature`, `GET /auth/me`)

| Pantalla / pestaña | Flag |
|---|---|
| Pestaña "Cambio" en `ShiftPage` | `cash.swaps` |
| Pestaña "Retiros" en `ShiftPage` | `cash.pickups` |
| Pestaña "Relevo" en `ShiftPage` | `cash.handovers` (comprobado por test: no aparece apagada, sí aparece encendida) |
| Campo "Reserva de caja" en `OpenShiftForm` | `cash.reserve` |
| `CloseWizard` vs `SingleStepCloseForm` en la pestaña "Cierre" | `cash.blind_close` |
| Requerir foto en movimientos/retiros/cierre | **no es un flag que el frontend lea directamente**: `cash.photo_required` vive en el servidor (`_check_photo_required`) y se refleja acá sólo como la respuesta `400 PHOTO_REQUIRED` — nunca se precalcula en el cliente, por diseño (AGENTS.md § "el backend hace cumplir los gates"). |
| `/admin/dinero`, `/admin/personal` | núcleo, sin flag (igual que Funciones/Configuración/Historial). |

## 4. Notas de accesibilidad

- Todo botón de acción usa `h-11` (44 px) o el tamaño por defecto de `Button`
  cuando es una acción secundaria de escritorio (ej. "Reversar" en la tabla de
  retiros); los del `PinPad` ya vienen en 56 px por `frontend-core`.
- `PinPad` (de `frontend-core`) ya trae `role="group"`, `aria-label`,
  navegación por teclado físico y `aria-live` de progreso — se reutiliza sin
  cambios en Roster, Movimientos (reintento), Retiros y Relevo/Arqueo.
- Todo mensaje de error de servidor se pinta con `role="alert"` (nunca sólo
  color): `OpenShiftForm`, `MovementsPanel`, `CashSwapPanel`, `PickupsPanel`,
  `HandoverPanel`, `CloseWizard`, `SingleStepCloseForm`.
- `ShiftStatusStrip` marca "Turno abandonado" y "Efectivo sobre el umbral"
  con `role="alert"` + ícono (`AlertTriangle`, `CircleDollarSign`) + texto —
  nunca sólo color, y el ícono nunca es el único portador del significado.
- Iconografía 100 % `lucide-react` (`Camera`, `X`, `Clock`, `AlertTriangle`,
  `CircleDollarSign`, `Download`, `Delete` heredado de `PinPad`), sin emojis.
- `PhotoCaptureField`: botón con texto visible ("Tomar o elegir foto" /
  "Reemplazar foto"), input real oculto con `sr-only` (no `display:none`, para
  que quede en el árbol de accesibilidad si algún día se necesita foco
  programático), miniatura con `alt` descriptivo, botón de "Quitar foto" con
  `aria-label`.
- Sin colores hardcodeados salvo un caso: `ShiftStatusStrip` usa
  `bg-amber-500/10 text-amber-700 dark:text-amber-400` para "efectivo sobre
  el umbral" porque el design system (`src/index.css`, de `frontend-core`) no
  define un token semántico "warning" — sólo `destructive`. Se probó
  contraste en ambos temas (texto ámbar 700/400 sobre fondo translúcido) pero
  queda declarado como mejora pendiente: cuando exista un token `--warning`,
  este archivo es el único que hay que tocar para adoptarlo.
- Formularios: `Label` con `htmlFor` en todo campo (nunca sólo `placeholder`),
  `Textarea`/`Input` con `id` explícito, mensajes de error cerca del campo
  (no sólo en un resumen al final).
- `DenominationsInput`, `MoneyInput`, `EmptyState` se reutilizan sin
  modificación — no se tocó ningún archivo de `src/components/**`.

## 5. Tests (`cd frontend && npx vitest run src/features/shifts`)

```
Test Files  5 passed (5)
     Tests  15 passed (15)
```

| Archivo | Qué prueba |
|---|---|
| `__tests__/shiftsApi.test.ts` | `openShift`, `closeCount`, `closeSingleStep`, `createCashMovement`, `createPickup` y `createHandover` mandan el encabezado `Idempotency-Key` que se les pasa (mock de `global.fetch`, mismo patrón que `src/lib/__tests__/apiClient.test.ts` de `frontend-core`). |
| `__tests__/ShiftPage.test.tsx` | (1) "Relevo" no aparece con `cash.handovers` apagado; (2) sí aparece (`getByRole("tab")`) con el flag encendido; (3) la reserva se muestra en una fila propia distinta de "Base fija" (y no está sumada ahí), y "Esperado" ausente se pinta "—" y nunca contiene un "0". |
| `__tests__/OpenShiftForm.test.tsx` | El campo "Reserva de caja" con su leyenda "no entra al cuadre" sólo aparece con `cash.reserve` encendida; el responsable de caja se precarga con el `employee_id` de la persona identificada. |
| `__tests__/MovementsPanel.test.tsx` | Tras `400 PETTY_CASH_LIMIT` aparece el `PinPad` de administrador; al completarlo, el segundo intento manda `authorizer_pin` y usa una `Idempotency-Key` **distinta** de la primera (el cuerpo cambió). |
| `__tests__/CloseWizard.test.tsx` | (1) El paso 1 nunca llama a `getCloseReview` y no muestra la etiqueta "Esperado" hasta tener `count_id`; recién entonces se dispara la revisión y aparece el esperado. (2) Ante `400 DIFFERENCE_CHANGED`, el wizard vuelve al paso 2 mostrando la `review` nueva que trae el propio error (no la vieja), y el botón "Confirmar cierre" del paso 3 desaparece. |

Typecheck (`npm run typecheck`, árbol completo — incluye archivos de otros
agentes): limpio, cero errores, en la última corrida antes de este entregable.

No se corrió `npm run build` ni la suite completa del frontend (reservado a la
verificación final del Maestro, por instrucción explícita).

## 6. Gaps

1. **Cierre en un solo paso sin ruta en el contrato escrito.**
   `features/fase-1a-cimientos/spec.md` § "Close, three steps" sólo documenta
   el cierre en tres pasos; no lista una ruta para cuando `cash.blind_close`
   está apagada. `backend/app/shifts/router.py` (de `backend-caja`, mismo
   pedido) sí expone `POST /shifts/{id}/close` con
   `SingleStepCloseIn`/`SingleStepCloseOut`. Usé esa ruta (documentada como
   tal en `api/shifts.ts`, función `closeSingleStep`) porque la instrucción
   de este agente permite "el endpoint que la spec/backends definan", pero
   **el contrato escrito no la avala**: si el Maestro concilia una ruta
   distinta (o decide que 1a no necesita este caso porque `cash.blind_close`
   viene encendida por perfil en todos los casos del seed), hay que tocar
   sólo `api/shifts.ts` y `SingleStepCloseForm.tsx`.

2. **`DELETE /admin/shifts/{id}` (cancelar) no acepta motivo en el cuerpo.**
   La misión pide "confirmación y motivo obligatorio" en los cuatro
   rescates, pero el router de `backend-caja` no declara ningún `Body` en
   este endpoint (`service.cancel_shift` recibe un motivo fijo, hardcodeado
   por el propio backend: `"Cancelado por administrador (turno abierto por
   error)"`). La UI (`admin/ShiftDetailDialog.tsx`, botón "Cancelar") sí pide
   la confirmación explícita (`AlertDialog`) pero no puede mandar un motivo
   propio porque el contrato no lo recibe; queda una nota visible en el
   propio diálogo para que quede trazado. Si se concilia un cuerpo
   `{reason}` en el backend, hay que agregarlo a `adminCancelShift` en
   `api/shifts.ts` y pasarlo desde el botón.

3. **`GET /admin/shifts` (`AdminShiftListItem`) no trae `close_cause` ni la
   base fija de apertura.** La misión pide que "Dinero → Operacional" muestre
   "base, esperado, contado, diferencia y causa" por turno, pero el esquema
   real (`backend/app/shifts/schemas.py`, `AdminShiftListItem`) sólo trae
   `id, business_date, store_id, status, opened_at, closed_at,
   cash_responsible, expected_cash, counted_cash, difference, is_stale,
   reviewed_at` — sin `opening_cash_total` ni `close_cause`. La tabla de
   `admin/OperationalTab.tsx` y `admin/HistoryTab.tsx` muestra Esperado,
   Contado, Diferencia y "Revisado/Sin revisar" en vez de la causa (que sí
   se puede ver abriendo el detalle y leyendo la cronología, pero no como
   columna). Si se agrega `close_cause`/`opening_cash_total` a
   `AdminShiftListItem`, alcanza con sumarlos como campos opcionales en
   `AdminShiftListItem` de `api/shifts.ts` y una columna más en las dos
   tablas.

4. **Sin ruta de dispositivo para listar personal activo de la sede.**
   Gap ya declarado por `frontend-core` en `DeviceIdentifyPage.tsx` (para
   identificarse) y compartido acá en tres lugares: `RosterPanel.tsx`
   (elegir quién entra/sale/pausa), `OpenShiftForm.tsx` (elegir el
   responsable de caja si no es quien abre) y `HandoverPanel.tsx` (elegir el
   nuevo responsable en un relevo). Los tres piden el número de empleado a
   mano en vez de un selector con nombres — mismo patrón, mismo texto de
   gap. La única ruta existente (`GET /admin/employees`) exige sesión de
   admin y un dispositivo no puede llamarla. Si se agrega una ruta de
   dispositivo tipo `GET /store/employees` (sin PIN, sólo nombres e ids,
   filtrada por sede — nunca el PIN hasheado), hay que reemplazar el
   `<input type=number>` de esos tres archivos por un selector.

5. **Cronología con foto**: `admin/ShiftDetailDialog.tsx` intenta mostrar la
   foto de un evento leyendo `event.data.photo` (un campo dentro del `dict`
   genérico `TimelineEventOut.data`), porque `TimelineEvent.data` está
   tipado como `Record<string, unknown>` (la spec no fija qué claves trae
   `data` por tipo de evento). Si `backend-caja` no incluye la foto ahí para
   los eventos que la tienen (cierre, retiro, relevo), esa miniatura
   simplemente no aparece — no hay endpoint alternativo en el contrato para
   pedirla suelta, así que no se inventó ninguno.

6. **`admin/OperationalTab.tsx` calcula "hoy" con `Intl.DateTimeFormat` en
   `America/Bogota`** sólo como valor inicial de un filtro de pantalla (el
   usuario puede cambiarlo), nunca como una fecha operativa que se guarda o
   se manda a ningún endpoint de escritura. Es intencionalmente distinto de
   las trampas prohibidas en `lib/businessDate.ts` (parte de "ahora", no de
   un `business_date` ya guardado), pero lo declaro para que quede claro que
   no es un segundo helper de fecha operativa compitiendo con el de
   `frontend-core`.

7. **Sin token semántico "warning" en el design system** (detalle en la
   sección de accesibilidad, punto 4): `ShiftStatusStrip` usa `amber-500` de
   Tailwind en vez de un token del sistema porque no existe uno todavía.

8. **Verificación de aislamiento por organización/sede**: no escribí un test
   propio de "un admin de la organización A recibe 404 al leer un turno de
   la organización B" porque ese comportamiento lo garantiza el backend
   (`backend-caja`, ya con su propio test) y este agente no tiene acceso a
   una API real corriendo — todos mis tests mockean `@/api/shifts`. Ese
   comportamiento de extremo a extremo lo cubre la verificación final del
   Maestro (o `backend-caja` con `httpx.TestClient`).

## 7. Archivos tocados

- `frontend/src/api/shifts.ts` (nuevo).
- `frontend/src/features/shifts/index.ts` (reemplaza el stub de
  `frontend-core`).
- `frontend/src/features/shifts/{hooks.ts, PhotoCaptureField.tsx,
  ShiftStatusStrip.tsx, OpenShiftForm.tsx, RosterPanel.tsx,
  MovementsPanel.tsx, CashSwapPanel.tsx, PickupsPanel.tsx,
  HandoverPanel.tsx, CloseWizard.tsx, SingleStepCloseForm.tsx,
  ShiftSummaryPanel.tsx, ShiftPage.tsx}` (nuevos).
- `frontend/src/features/shifts/admin/{MoneyAdminPage.tsx,
  OperationalTab.tsx, HistoryTab.tsx, ShiftDetailDialog.tsx,
  PeopleAdminPage.tsx, PersonActivityTab.tsx, AuthorizationsTab.tsx}`
  (nuevos).
- `frontend/src/features/shifts/__tests__/{shiftsApi.test.ts,
  ShiftPage.test.tsx, OpenShiftForm.test.tsx, MovementsPanel.test.tsx,
  CloseWizard.test.tsx}` (nuevos).

Ningún otro archivo del repo se tocó.
