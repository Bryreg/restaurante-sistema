# frontend-compras — Admin → Compras y la carcasa de navegación (pedido 2b)

Construcción de la sección **Compras** del admin en `frontend/src/features/purchases/**`
(feature nuevo, completo), su cliente de API (`frontend/src/api/purchases.ts`) y el
cableado de la carcasa (`frontend/src/app/router.tsx`, `frontend/src/app/AdminLayout.tsx`),
delimitado exactamente por `features/fase-2-costo-inventario/spec.md § Alcance de 2b`,
secciones `### Suppliers`, `### Receptions`, `### Payables and payments` del
`## API contract — 2b`.

---

## §1. Qué construí, pantalla por pantalla

### Admin → Compras (`/admin/compras`)

Página única con tres pestañas (`PurchasesAdminPage.tsx`, mismo patrón que
`InventoryAdminPage.tsx` de 2a: `?tab=` en la query string, así "Hoy" o cualquier
otra pantalla puede enlazar directo a una pestaña). Detrás de
`hasFeature("purchases")`: apagada, muestra un `EmptyState` que nombra la función
exacta a encender ("Proveedores, recepciones de compra y cuentas por pagar") en vez
de romperse contra un `400 FEATURE_DISABLED`, y no pide nada al servidor (test:
`listSuppliersMock` sin llamar). La lista de proveedores **activos** se trae una
sola vez en la página y se pasa a Recepciones y Cuentas por pagar para resolver
`supplier_id → nombre` en cada fila y para los selectores — un solo `fetch`, no uno
por pestaña.

### Pestaña Proveedores (`SuppliersTab.tsx`, `SupplierForm.tsx`, `SupplierReliabilityDialog.tsx`)

- Tabla: nombre, NIT, plazo de pago, contacto, "Obligado a facturar"/"Factura
  opcional", estado (Activo/Inactivo), con casillero "Mostrar inactivos".
- **Alta y edición** en un diálogo compartido (`SupplierForm.tsx`, mismo patrón que
  `IngredientForm.tsx` de 2a): nombre, NIT opcional, plazo de pago (`≥ 0`), contacto,
  "obligado a facturar" y (sólo al editar) "activo".
- **Baja lógica**: el botón "Desactivar" llama `DELETE /admin/suppliers/{id}`, que en
  el backend es `active: false`, nunca un `DELETE` de fila — mismo criterio que
  `deactivateIngredient` de 2a.
- **`400 SUPPLIER_DUPLICATE_NIT`** se muestra tal cual el servidor lo redactó (el
  mensaje ya nombra la acción correctiva: `Ya existe un proveedor con NIT "900123456"
  en esta sede ("Distribuidora El Surtidor")`) dentro del propio formulario
  (`role="alert"`), **nunca como un toast genérico** — mismo patrón `serverError` que
  ya usa `IngredientForm.tsx`.
- **Confiabilidad** (`SupplierReliabilityDialog.tsx`): diálogo por proveedor con un
  `DateRangeFilter` y `GET /admin/suppliers/{id}/reliability?from&to`. Los tres
  números (recibido ÷ facturado, % de recepciones con factura, deriva promedio de
  precio) llegan **ya calculados**; esta pantalla sólo los formatea con `formatPct`
  (`"87 %"` o `"sin datos"` — nunca `"0 %"` cuando el campo es `null`, que es
  exactamente lo que pasa sin recepciones en el rango).
- Export CSV: ver §5 (hueco de contrato — `GET /admin/suppliers` no declara
  `format=csv`) y §8.

### Pestaña Recepciones (`ReceptionsTab.tsx`, `ReceptionForm.tsx`, `ReceptionLinesEditor.tsx`, `ReceptionDetailDialog.tsx`)

La pantalla más difícil de la misión. Se separa en cuatro archivos:

- **`ReceptionsTab.tsx`**: lista con filtros (rango de fechas, proveedor, estado),
  botón "Nueva recepción" (deshabilitado si no hay proveedores activos, con el aviso
  correspondiente) y exportación CSV real (`GET /admin/receptions` sí declara
  `format` en el contrato).
- **`ReceptionLinesEditor.tsx`**: captura de líneas (insumo, cantidad recibida,
  cantidad facturada, precio por unidad de compra, base/tarifa/valor de IVA, lote,
  vencimiento), con el mismo patrón de `key` estable que
  `src/features/recipes/ComponentLinesEditor.tsx` (territorio ajeno — se replicó el
  patrón, no se importó el archivo). Las cantidades y el precio viajan como texto,
  nunca se parsean a número acá.
- **`ReceptionForm.tsx`**: encabezado (proveedor, número/fecha de factura, "sin
  factura", foto opcional) + líneas + **las dos guardas de tecleo** + PIN de quien
  recibe. Ver §5 para el diseño detallado del flujo de guardas y del paso
  "Continuar" (un hallazgo real de esta construcción, no cosmético: ver abajo).
- **`ReceptionDetailDialog.tsx`**: detalle de una recepción con sus líneas
  (insumo, cantidades, precio, costo final, IVA/INC, lote, vencimiento) y, si sigue
  `confirmed`, "Eliminar recepción" — que muestra **qué se va a revertir antes de
  pedir el PIN** (§4).

### Pestaña Cuentas por pagar (`PayablesTab.tsx`, `PayableDetailDialog.tsx`)

- **`PayablesTab.tsx`**: lista con proveedor resuelto, estado, vencimiento (con
  badge "Vencida" cuando `overdue`), total original y **saldo — el que manda el
  servidor, nunca uno derivado acá**. Filtros por proveedor, estado y "sólo
  vencidas"; exportación CSV real.
- **`PayableDetailDialog.tsx`**: aprobación explícita (PIN de administrador) sólo
  visible en `pending_review`; registro de pago (monto, medio, fecha real de salida,
  comprobante, interruptor "desde el cajón") sólo visible cuando la cuenta está
  `approved` **y** tiene saldo — mientras está `pending_review` **el botón de pagar
  no existe en el DOM**, no que esté deshabilitado (test:
  `queryByRole("button", {name: /registrar pago/i})` → `null`); anulación de un pago
  con motivo y PIN, nunca un borrado. Ver §5 y §8 para el hueco de contrato que esta
  pantalla tiene que rodear (no existe `GET /admin/payables/{id}/payments`).

---

## §2. Rutas y navegación, verificadas en el árbol

- **`frontend/src/features/purchases/index.ts`** declara `purchasesFeature`:
  `adminRoutes: [{ path: "compras", element: <PurchasesAdminPage /> }]`,
  `adminNav: [{ to: "/admin/compras", label: "Compras", feature: "purchases" }]`,
  y **`posRoutes`/`posNav` vacíos a propósito** — nunca una ruta de Compras bajo
  `/pos` (regla dura, ver §"Reglas duras").
- **`frontend/src/app/router.tsx`**: importa `purchasesFeature` y lo agrega al
  spread de `adminRoutes` de `/admin`, junto a `inventoryFeature.adminRoutes` y
  `recipesFeature.adminRoutes` — **nunca** en el spread de `/pos`.
- **`frontend/src/app/AdminLayout.tsx`**: importa `purchasesFeature` y agrega
  `...purchasesFeature.adminNav` a `buildNav()`, **justo después de**
  `inventoryFeature.adminNav` (orden de SPEC-NEGOCIO §9.3: "Carta y recetas,
  Preparaciones, Inventario, **Compras**, Dinero...").

**Verificado en el árbol, no sólo declarado** (la lección de 2a: "un agente reportó
que la carcasa no importaba su feature cuando ya lo hacía, y al revés"):

- `src/app/__tests__/router.test.tsx` — agregué dos tests que corren contra el
  **`purchasesFeature` real, sin mockear** (mismo criterio que el archivo ya usaba
  para `inventoryFeature`/`recipesFeature`): `/admin monta compras
  (purchasesFeature)` busca `compras` entre los `children` reales de la ruta
  `/admin` del router ya construido; `/pos NO monta ninguna ruta de compras`
  confirma que ningún `path` de `/pos` contiene `"compras"`.
- `src/app/__tests__/AdminLayout.test.tsx` — agregué dos tests que renderizan
  `<AdminLayout>` de verdad (con `purchasesFeature` real, sin mockear, mismo
  criterio que ya usaba para `inventoryFeature`) y verifican con Testing Library:
  `purchases: false` → `screen.queryByRole("link", {name: "Compras"})` es `null`;
  `purchases: true` → el link existe **y** su `href` es exactamente `/admin/compras`.
- Los cuatro tests corrieron en verde contra el router y el `AdminLayout` reales
  (no un doble), así que la ruta y el nav están cableados de verdad, no sólo
  declarados en `index.ts`.

---

## §3. Contrato de API que consumo

Todo bajo `require_feature("purchases")` (`app/purchases/router.py`, ya
construido por `backend-compras` cuando empecé). `store_id` es query param
obligatorio en las lecturas y en `POST /receptions`; el resto de las escrituras
resuelve la sede desde el recurso.

| Endpoint | Qué espero de cada campo |
|---|---|
| `GET /admin/suppliers?store_id&active` | `SupplierOut[]`. `nit` nullable. Nunca trae `format=csv` (hueco, §8). |
| `POST /admin/suppliers?store_id` | `SupplierIn` → `SupplierOut` (`201`). `400 SUPPLIER_DUPLICATE_NIT` con el nombre del proveedor existente en el mensaje. |
| `PATCH /admin/suppliers/{id}` | `SupplierUpdateIn` (todos opcionales) → `SupplierOut`. |
| `DELETE /admin/suppliers/{id}` | Baja lógica → `SupplierOut` con `active: false`. |
| `GET /admin/suppliers/{id}/reliability?from&to` | `{supplier_id, date_from, date_to, receptions, received_over_invoiced_pct, invoice_share_pct, avg_price_drift_pct}` — los tres porcentajes `int \| null`, **nunca** un cálculo mío. |
| `POST /receptions?store_id` (Idempotency-Key) | `ReceptionIn` → `ReceptionOut` (`201`). `409 PRICE_LOOKS_LIKE_PACKAGE`/`409 PRICE_JUMP` (ver §4/§5); `400 INVOICE_REQUIRED`; `400 SUPPLIER_INACTIVE`; `400 RECEIVED_BY_PIN_INVALID`; `400 VALIDATION_ERROR` por línea. |
| `GET /admin/receptions?store_id&from&to&supplier_id&status&format` | `ReceptionOut[]`, o CSV con `format=csv` (declarado en el contrato, a diferencia de `/admin/suppliers`). |
| `GET /admin/receptions/{id}` | `ReceptionOut` con `lines: ReceptionLineOut[]` — cada línea trae `unit_cost` (pre-impuesto) y `final_unit_cost` (con el IVA sumado si aplica), texto decimal los dos, **nunca los resto ni los sumo yo**. |
| `PATCH`/`DELETE /admin/receptions/{id}` `{authorizer_pin}` | Reversa atómica → `ReceptionOut` con `status: "reversed"`. `409 LOT_CONSUMED`, `409 PAYABLE_HAS_PAYMENTS`, `400 RECEPTION_ALREADY_REVERSED`. Uso `DELETE` (la acción que la pantalla ofrece es "Eliminar recepción"). |
| `GET /admin/payables?store_id&status&supplier_id&overdue&from&to&format` | `PayableOut[]`. `balance` **siempre derivado por el servidor** — no existe una columna `balance` en el backend y yo tampoco la calculo. `overdue: bool` ya resuelto. |
| `POST /admin/payables/{id}/approve` `{authorizer_pin}` | → `PayableOut` con `status: "approved"`. `400 PAYABLE_ALREADY_APPROVED`, `400 PAYABLE_CANCELLED`. |
| `POST /admin/payables/{id}/payments` (Idempotency-Key) | `PaymentIn` → `PaymentOut` (`201`). `409 PAYABLE_NOT_APPROVED` (defensivo: el botón ya no existe en ese estado), `400 PAYMENT_EXCEEDS_BALANCE`, `409 NO_OPEN_SHIFT` (sólo si `from_cash_drawer`). |
| `POST /admin/payables/{id}/payments/{payment_id}/void` `{reason, authorizer_pin}` | → `PaymentOut` con `voided_at`/`voided_reason`. `400 PAYMENT_ALREADY_VOIDED`. **No existe un `GET` que liste los pagos de una cuenta** (hueco de contrato, §8). |

Todas las cantidades de insumo (`qty_received`, `qty_invoiced`) y el precio
(`purchase_unit_price`, `unit_cost`, `final_unit_cost`) viajan como texto decimal
(`app.core.quantity.format_qty_base`/`format_cost_micros`) — este cliente nunca los
parsea a número ni los multiplica; los muestra tal cual con `formatCOPDecimal`
(costos) o el string crudo con el sufijo de unidad (cantidades). El dinero entero
(`tax_base`, `tax_amount`, `amount`, `balance`, montos de pago) es `int` y se
formatea con `formatCOP`.

---

## §4. Cómo trato cada código de error del backend

| Código | Dónde | Tratamiento |
|---|---|---|
| `400 FEATURE_DISABLED` | Cualquier ruta de `purchases` | No debería llegar nunca: `PurchasesAdminPage` ya bloquea toda la sección con `EmptyState` cuando `hasFeature("purchases")` es falso, antes de pedir nada. |
| `400 SUPPLIER_DUPLICATE_NIT` | `POST`/`PATCH /admin/suppliers` | Mensaje del servidor tal cual, en el propio formulario (`role="alert"`) — nombra el NIT y el proveedor existente. Test. |
| `400 INVOICE_REQUIRED` | `POST /receptions` | Mensaje del servidor tal cual, junto al PIN (dentro del paso "Continuar"). Además, un aviso **no bloqueante** aparece antes de enviar si el proveedor exige factura y "sin factura" está marcado, para no depender sólo del `400`. Test con el mensaje exacto. |
| `409 PRICE_LOOKS_LIKE_PACKAGE` / `409 PRICE_JUMP` | `POST /receptions` | Ver §5 — panel de guarda dedicado, nunca un toast. Dos tests, uno por código. |
| `400 SUPPLIER_INACTIVE`, `400 RECEIVED_BY_PIN_INVALID`, `400 VALIDATION_ERROR` | `POST /receptions` | Mensaje del servidor tal cual, junto al PIN (mismo lugar que `INVOICE_REQUIRED` — son todos "la reviso, no cambio nada sola"). |
| `400 RECEPTION_ALREADY_REVERSED`, `409 LOT_CONSUMED`, `409 PAYABLE_HAS_PAYMENTS` | `DELETE /admin/receptions/{id}` | Mensaje del servidor tal cual dentro del `AlertDialog` de reversa (el mismo diálogo que ya muestra qué se va a revertir). Dos tests, uno por código de los dos que el checklist nombra explícitamente. |
| `400 PAYABLE_ALREADY_APPROVED`, `400 PAYABLE_CANCELLED` | `POST /admin/payables/{id}/approve` | Mensaje del servidor tal cual junto al PIN de aprobación. `cancelled` además tiene su propia explicación permanente en el detalle ("la recepción que la originó se revirtió"), no sólo como error de un intento fallido. |
| `409 PAYABLE_NOT_APPROVED` | `POST /admin/payables/{id}/payments` | Camino defensivo: la pantalla ya no ofrece el formulario de pago si `status !== "approved"`, así que este código sólo puede llegar por una carrera (alguien revierte la aprobación entre que la pantalla cargó y el pago se manda); si llega, se muestra tal cual junto al PIN, igual que los demás. |
| `400 PAYMENT_EXCEEDS_BALANCE` | `POST /admin/payables/{id}/payments` | Mensaje del servidor tal cual (ya incluye el monto pedido y el saldo real). No lo anticipo comparando en el cliente — el saldo mostrado es el mismo que valida el servidor. |
| `409 NO_OPEN_SHIFT` | `POST /admin/payables/{id}/payments` (con `from_cash_drawer`) | Mensaje del servidor tal cual — dice explícitamente "abrí un turno... o registrá el pago por otro medio", nunca "error inesperado". Test con el mensaje exacto. |
| `400 PAYMENT_ALREADY_VOIDED` | `POST .../payments/{id}/void` | Mensaje del servidor tal cual dentro del `AlertDialog` de anulación. |
| Cualquier `401` | Cualquier pantalla | No lo manejo yo: `src/api/client.ts` (territorio ajeno) ya dispara `session:expired` y `SessionProvider` redirige — no repetí esa lógica. |

En todos los casos el mecanismo es el mismo: `errorMessage(mutation.error)` (`@/lib/errors`,
compartido) extrae `err.message` de un `ApiError` y se muestra dentro de un
`role="alert"` cerca de la acción que falló — nunca un toast genérico que oculte
el texto específico del backend.

---

## §5. Decisiones de diseño y su por qué

### Las dos guardas de tecleo: preguntan, nunca corrigen

El backend **no devuelve un número de referencia** en la guarda — el cuerpo del
error es `{code, message}` únicamente (`app/purchases/service.py`: el `AppError`
de `PRICE_LOOKS_LIKE_PACKAGE`/`PRICE_JUMP` no lleva `extra`), y el mensaje es una
frase en español, no un objeto con `{line_index, typed, reference}` (hueco de
contrato declarado en §8). Con eso decidido, el panel de guarda (`ReceptionForm.tsx`)
construye lo que puede mostrar **sin inventar ningún número**:

- El mensaje del servidor, **tal cual**, incluido el rango textual ("entre 10 y 12
  veces la referencia" / "más de 15% del promedio ponderado") — es la única
  descripción de "la referencia" que existe, y no la reemplazo por un número
  calculado en el cliente (eso sería exactamente la matemática en el lugar
  equivocado que `AGENTS.md` prohíbe).
- "Lo que tecleaste": el precio que la propia pantalla ya tiene en su estado (no es
  un dato nuevo, es el mismo valor que el formulario envió), mostrado sin tocar.
- Best-effort: el índice de línea se extrae con una expresión regular sobre
  `lines[N]` al **inicio** del mensaje, sólo para resaltar la fila ofensiva
  (`highlightIndex` en `ReceptionLinesEditor`) — es una ayuda visual, nunca una
  fuente de verdad de negocio; si el mensaje cambiara de forma, el panel sigue
  funcionando (sólo deja de resaltar una fila puntual).
- Dos botones, ningún camino intermedio: **"Volver a revisar el precio"** (limpia
  la guarda y **reactiva la edición**, sin tocar ningún valor) o **"Confirmar que
  el precio es correcto"** (reenvía el **mismo objeto de línea, byte a byte**, sólo
  con `confirm_price: true`). Ningún código redondea, trunca ni "corrige" el precio
  tecleado — el test de las dos guardas compara explícitamente que
  `secondBody.lines[0].purchase_unit_price` es idéntico al primer envío.
- "Confirmando queda registrado que lo revisaste vos, {nombre del admin de la
  sesión}" — no pide un PIN nuevo para confirmar (el backend graba
  `price_confirmed_by_employee_id = actor.id`, el ADMIN de la sesión, no el
  `received_by_pin`; lo verifiqué en `app/purchases/service.py:358-360` antes de
  diseñar esto), así que reusar el PIN de quien recibe que ya se tecleó en el
  primer intento es fiel al contrato, no un atajo.

### El paso "Continuar" antes de mostrar el `PinPad` — un hallazgo real, no cosmético

Mientras escribía el test de las guardas descubrí un bug de verdad, no sólo de
test: `PinPad` (`src/components/PinPad.tsx`, compartido) escucha el teclado a
nivel de `window`, **sin filtrar por foco** — comportamiento ya documentado en
`docs/ESTADO.md` punto 8 ("se cuela en cualquier input visible") y ya esquivado
por `frontend-cobro` en `PaymentSplitsForm.tsx` manteniendo el `PinPad`
`disabled` hasta que el resto del formulario está completo. Mi primer diseño
copiaba ese mismo criterio (`disabled={!canSubmit}`), pero **no alcanza acá**:
`canSubmit` se vuelve `true` en cuanto el ÚLTIMO campo obligatorio deja el string
vacío — que pasa **a mitad de tipear el precio de una línea**, apenas cae el
primer dígito. Con el `PinPad` habilitado en ese instante, cada dígito que
todavía faltaba por teclear del precio se colaba como dígito de PIN y disparaba
un envío prematuro con datos a medio escribir (lo até con un `console.trace`
temporal: `received_by_pin: "5000"`, dígitos robados de "10", "10" y "45000"
tecleados en los campos de cantidad y precio).

La solución no toca el componente compartido (fuera de mi territorio y usado por
media docena de pantallas más): agrega un paso explícito. El formulario nunca
monta el `PinPad` mientras se edita; recién aparece después de un toque en
"Continuar", que además bloquea TODOS los campos de texto (incluida la foto, que
mi primer borrador había dejado afuera del bloqueo — corregido). A esa altura no
queda ningún campo activo que pueda robarle dígitos al `PinPad`. "Volver a
editar" regresa al paso anterior sin perder nada tecleado. Documentado en el
docstring del módulo para que quien retome esta pantalla no reintroduzca el bug
"simplificando" el flujo a un solo paso.

### El saldo, la confiabilidad y el IVA nunca se calculan acá

Ningún componente de esta sección suma, resta ni multiplica nada financiero:
`PayableOut.balance` se pinta tal cual llega; `SupplierReliabilityOut.*_pct` se
pintan tal cual llegan (con `formatPct`, que sólo decide "sin datos" vs `"N %"`,
nunca calcula el número); el costo final de una línea de recepción
(`final_unit_cost`) es el que manda el servidor, nunca `unit_cost + IVA` calculado
en el cliente. El único lugar donde este territorio "arma" un número es
`downloadSuppliersCsv` (ver abajo), y es serialización de columnas ya traídas, no
una cifra nueva.

### CSV de Proveedores armado en el cliente — hueco de contrato, no capricho

`GET /admin/suppliers` (a diferencia de `/admin/receptions` y `/admin/payables`)
no declara `format` ni siquiera recibe `request: Request` en su firma
(`app/purchases/router.py::list_suppliers`) — no hay ningún `format=csv` que
pedirle. "Toda lista exporta" (SPEC-NEGOCIO §9.3) es una regla de la pantalla, no
del backend en particular, así que `downloadSuppliersCsv` (`lib.ts`) arma el CSV
en el cliente a partir de las filas **ya traídas** por `GET /admin/suppliers`
(id, nombre, NIT, plazo, contacto, obligado a facturar, activo) con un `Blob` y
una descarga disparada por `<a download>` — cero matemática, sólo columnas que ya
están en pantalla. Se declara la limitación real en §8: el backend debería sumar
`format=csv` acá, igual que ya lo hace en `/admin/receptions`/`/admin/payables`.

### Pagos de una cuenta por pagar sin `GET` que los liste

`app/purchases/router.py` sólo expone `POST .../payments` (crear) y
`POST .../payments/{id}/void` (anular) — **no existe ningún `GET` que liste los
pagos de una cuenta por pagar**. Sin eso, no hay forma de mostrar el historial de
pagos ni de conocer el `payment_id` de un pago anterior para poder anularlo, salvo
el que la propia pantalla acaba de crear en la sesión actual.
`PayableDetailDialog.tsx` lo resuelve guardando, en el `QueryClient` (vive
mientras dura la pestaña del navegador, nunca en el servidor ni entre sesiones),
los pagos que **esta pantalla** registró, rotulados explícitamente "Pagos
registrados en esta sesión" — nunca presentados como el historial completo,
porque no lo es. El `balance` que sí se muestra siempre es el que manda el
servidor (correcto y completo, exista o no la lista de pagos). Declarado con
nombre propio en §8: el backend necesita un `GET /admin/payables/{id}/payments`.

---

## §6. Tests que escribí, con su resultado EXACTO

> **Esta sección es la foto de la ronda 1.** La ronda 2 (más abajo) agregó 3
> tests (H-6, H-9, H-1) y modificó el conteo total a **`Test Files 15 passed
> (15)`, `Tests 57 passed (57)`** — ver «Ronda 2 § Verificación» para el
> comando y el resultado exacto y actualizado. Se deja el desglose de la
> ronda 1 tal cual corrió entonces, sin reescribirlo, para no perder el
> rastro de qué cambió en cada ronda.

```bash
export TMPDIR=/tmp/pt-frontend-compras && mkdir -p $TMPDIR
cd /home/user/restaurante-sistema/frontend
npx vitest run src/features/purchases src/app
npm run typecheck
```

**Resultado de la ronda 1: `Test Files 14 passed (14)`, `Tests 54 passed (54)`.**
`npm run typecheck` (`tsc --noEmit -p tsconfig.app.json`): limpio, sin salida.

Desglose exacto por archivo (con `--reporter=verbose`):

| Archivo | Tests | Qué prueba |
|---|---|---|
| `src/features/purchases/__tests__/index.test.ts` | **1** | `purchasesFeature` expone `compras`/`Compras` en admin y **nada** en `posRoutes`/`posNav`. |
| `src/features/purchases/__tests__/lib.test.ts` | **4** | `formatPct` nunca dibuja `null` como `"0 %"`; `supplierName` no inventa un nombre para un id ajeno; `downloadSuppliersCsv` serializa columnas ya traídas (con escapado de comillas/comas) y dispara una descarga real (`Blob`/`URL.createObjectURL`/`click`). |
| `src/features/purchases/__tests__/SuppliersTab.test.tsx` | **3** | `400 SUPPLIER_DUPLICATE_NIT` tal cual el servidor lo redactó (no un toast genérico); "Desactivar" llama `DELETE` (baja lógica); "obligado a facturar" se muestra, no se esconde. |
| `src/features/purchases/__tests__/SupplierReliabilityDialog.test.tsx` | **2** | Sin recepciones en el rango, los tres números dicen "sin datos" (nunca "0 %"); con datos, se pintan los tres porcentajes tal cual el servidor los calculó. |
| `src/features/purchases/__tests__/ReceptionsTab.test.tsx` | **2** | Lista con proveedor resuelto y CSV real (`format=csv`, URL `/api/v1/admin/receptions`); sin proveedores activos, avisa y deshabilita "Nueva recepción". |
| `src/features/purchases/__tests__/ReceptionForm.test.tsx` | **6** | `409 PRICE_JUMP`: mensaje del servidor + "lo que tecleaste" + el PIN desaparece + el precio nunca se ajusta solo + confirmar reenvía el **mismo** precio con `confirm_price: true` y una `Idempotency-Key` **rotada** (porque el cuerpo cambió). `409 PRICE_LOOKS_LIKE_PACKAGE`: mismo camino. "Volver a revisar" cierra la pregunta sin reenviar nada. `400 INVOICE_REQUIRED` se muestra tal cual (dentro del `role="alert"` específico, no confundido con el aviso propio no bloqueante que dice casi lo mismo). Un reintento con el **mismo** cuerpo **reusa** la `Idempotency-Key` (no la rota). El botón "Confirmar" llama `onSuccess` con la recepción devuelta. |
| `src/features/purchases/__tests__/ReceptionDetailDialog.test.tsx` | **4** | El resumen de "esto se va a revertir" aparece **antes** del campo de PIN, que arranca vacío y el botón de confirmar deshabilitado sin PIN; `409 LOT_CONSUMED` y `409 PAYABLE_HAS_PAYMENTS` se explican con el motivo exacto del servidor; una recepción ya revertida no ofrece "Eliminar recepción". |
| `src/features/purchases/__tests__/PayablesTab.test.tsx` | **2** | Lista con proveedor resuelto, saldo del servidor, "Vencida" marcada, CSV real; sin cuentas en el rango, explica que una recepción confirmada crea una automáticamente. |
| `src/features/purchases/__tests__/PayableDetailDialog.test.tsx` | **5** | `pending_review`: no existe ningún campo "Monto" ni botón de pago en el DOM (no sólo deshabilitado); aprobar con PIN llama `approvePayable` con el id correcto; `approved` con saldo: el formulario existe y el saldo mostrado es exactamente `formatCOP(balance)` del servidor; `409 NO_OPEN_SHIFT` dice "abrí un turno...", nunca "error inesperado"; `cancelled` explica que la recepción se revirtió, sin ofrecer aprobar ni pagar. |
| `src/features/purchases/__tests__/PurchasesAdminPage.test.tsx` | **3** | `purchases` apagada: `EmptyState` y **cero** llamadas al servidor; encendida: las tres pestañas existen con Proveedores por defecto; `?tab=cuentas-por-pagar` abre directo ahí. |
| `src/app/__tests__/router.test.tsx` | **8** (6 preexistentes + **2 míos**) | Los 6 preexistentes de shifts/catalog/orders/payments/inventory/recipes siguen en verde (no los toqué). Los míos: `/admin` monta `compras` contra el `purchasesFeature` **real** (sin mockear); `/pos` **no** monta ninguna ruta de compras. |
| `src/app/__tests__/AdminLayout.test.tsx` | **9** (7 preexistentes + **2 míos**) | Los 7 preexistentes siguen en verde. Los míos: `purchases: false` → el link "Compras" no existe; `purchases: true` → existe y su `href` es exactamente `/admin/compras`. |
| `src/app/__tests__/PosHome.test.tsx`, `src/app/__tests__/PosLayout.test.tsx` | 2 + 3 | Preexistentes, no tocados; siguen en verde (verificación de que no rompí nada del POS). |

**Total: 54/54 en verde**, incluidos los 4 tests nuevos sobre archivos compartidos
de la carcasa (`router.test.tsx`, `AdminLayout.test.tsx`) que no son míos en
origen pero sí en las líneas que agregué, porque son exactamente el "corré tu test
de navegación" que la misión pide.

---

## §7. Qué NO construí, y por qué

- **Ninguna ruta de Compras bajo `/pos`.** Es una regla dura explícita del mandato
  (invariante heredado #2 de la spec): la recepción lleva precios, el PIN de quien
  recibe es atribución, no una sesión de dispositivo. `purchasesFeature.posRoutes`
  y `.posNav` quedan vacíos a propósito, con un test que lo prueba.
- **Conteos, lotes, varianza, food cost real, salud del control, y las pantallas de
  Inventario que los muestran.** Son `inventory.counts`/`inventory.variance`/
  `inventory.lots`, territorio explícito de otro agente de frontend en este mismo
  pedido (`frontend/src/features/inventory/**`, prohibido para mí). No toqué ese
  directorio ni sus rutas (`/admin/inventario`).
- **Los umbrales de varianza e insumos críticos en Configuración de sede.** Son
  `frontend/src/features/settings/**`, prohibido para mí — la spec ya lo nombra como
  huérfano con dueño asignado a otro agente.
- **`GET /admin/orders/{id}/consumption`** (la lectura agregada de 2a corregida): no
  es de `Suppliers`/`Receptions`/`Payables and payments`, las tres secciones que me
  delimitan; no construí ninguna pantalla contra ese endpoint.
- **Reordenar o modificar `/admin/inventario`.** La consigna es explícita: "Las
  tarjetas de «Hoy» de otro agente van a enlazar a `/admin/compras` — si cambiás esa
  ruta, rompés su enlace." No cambié el path `compras`, ni el orden de sus tres
  pestañas (`proveedores`, `recepciones`, `cuentas-por-pagar`).
- **Un endpoint propio para listar pagos de una cuenta por pagar.** No puedo
  construirlo (es `backend/`, prohibido para mí); lo rodeo con el registro de sesión
  descrito en §5, y lo declaro con nombre en §8.
- **Orden de compra y sugerencia de reposición, documento soporte electrónico.**
  Fuera del alcance de 2b según la propia spec (fase 3); no hay pantalla ni gancho
  para ellos.
- **Modificar `PinPad.tsx`** para que filtre por foco. Es un componente compartido
  usado por media docena de pantallas ajenas (cobro, turnos, mermas, ajustes); tocar
  su comportamiento global a mitad de un pedido con seis agentes en paralelo es un
  riesgo que no me corresponde asumir. Lo rodeé en mi propio territorio (el paso
  "Continuar", §5) y dejo la corrección de raíz como sugerencia de tarea aparte
  (spawneada al cierre de esta construcción).

---

## §8. Huecos del contrato del backend, y todo rojo con nombre

**Ningún test quedó rojo.** Los siguientes son huecos de contrato que rodeé sin
inventar matemática ni datos, cada uno con su nombre:

1. **`GET /admin/suppliers` no declara `format=csv`.** A diferencia de
   `/admin/receptions` y `/admin/payables`, el router de `list_suppliers` ni
   siquiera recibe `request: Request`. Lo rodeé con un CSV armado en el cliente a
   partir de filas ya traídas (`downloadSuppliersCsv`, §5), pero la solución
   correcta es que el backend lo sume — mismo patrón que las otras dos rutas de
   este mismo dominio ya usan. Dueño sugerido: quien tenga próximo territorio en
   `app/purchases/router.py`.
2. **No existe `GET /admin/payables/{id}/payments`.** El contrato de la spec
   (`spec.md § Payables and payments`) sólo pide `POST .../payments` y
   `POST .../payments/{id}/void`, y así lo construyó `backend-compras` — pero sin
   una forma de LISTAR los pagos de una cuenta, ninguna pantalla puede mostrar el
   historial completo ni anular un pago de una sesión anterior (sólo los que la
   propia pantalla creó en la sesión actual, ver §5). Esto es un hueco real de
   producto, no sólo de esta pantalla: un administrador que vuelve al día siguiente
   a revisar una cuenta no puede ver qué se pagó. Pido explícitamente que se sume
   `GET /admin/payables/{id}/payments` al contrato de un próximo pedido.
3. **Las guardas de tecleo no devuelven un valor de referencia ni un índice de línea
   estructurado.** `409 PRICE_LOOKS_LIKE_PACKAGE`/`409 PRICE_JUMP` sólo traen
   `{code, message}`; el mensaje es una frase en español con el índice de línea
   incrustado como texto (`lines[0]: ...`). Esta pantalla muestra "lo tecleado"
   (que ya tiene) y el mensaje del servidor tal cual, pero **no puede mostrar el
   número de referencia exacto contra el que se comparó** — sólo la descripción
   cualitativa que el mensaje ya trae ("entre 10 y 12 veces", "más de 15%"). Un
   contrato más rico (`{code, message, line_index, ingredient_id, typed_price,
   reference_price}`) permitiría una pantalla de guarda más precisa sin ningún
   cambio de comportamiento — declarado, no inventado.
4. **`PayableOut` y `ReceptionOut` no traen el nombre del proveedor**, sólo
   `supplier_id` — resuelto en el cliente con un `Map` a partir de
   `GET /admin/suppliers` (join de presentación, no una cifra nueva), pero un
   `supplier_name` embebido evitaría depender de que la lista de proveedores esté
   cargada para poder mostrar cada fila con sentido.
5. **`PinPad.tsx` (compartido) escucha el teclado a nivel de `window` sin filtrar
   por foco** — no es un hueco de ESTA misión (documentado desde antes en
   `docs/ESTADO.md` punto 8), pero esta construcción encontró un caso real donde
   causa un envío prematuro con datos a medio escribir (§5) en una pantalla con
   varios campos numéricos coexistiendo con un `PinPad` siempre montado. Lo rodeé
   sin tocar el componente compartido; quedó una tarea sugerida aparte para
   corregirlo de raíz (filtrar por `document.activeElement` o exigir que el propio
   `PinPad` tenga el foco) para que ninguna pantalla futura tenga que reinventar el
   mismo paso "Continuar".
6. **(Agregado en ronda 2) `PayablesTab` no lee filtros desde la URL.** El
   pedido de `frontend-inventario-conteos` es que las tarjetas de "Hoy" de esa
   pantalla enlacen a `/admin/compras` con la pestaña de Cuentas por pagar
   pre-filtrada a "vencidas" / "pendientes de revisión" (mismo patrón que
   `?tab=cuentas-por-pagar` que `PurchasesAdminPage` ya soporta para elegir la
   pestaña). Ese enganche — leer `status`/`overdue` de la query string en
   `PayablesTab` y aplicarlos como filtro inicial — **no se construyó en esta
   ronda**: el ajuste de ronda 2 lo excluyó explícitamente del alcance ("NO se
   construye en esta ronda"). Deuda con dueño (yo, `frontend-compras`) para el
   próximo pedido.

Nada de esto bloqueó la construcción: los seis se rodearon con decisiones
explícitas, documentadas en el código y acá, nunca con un cálculo nuevo del lado
del cliente ni con un dato inventado.

---

## Ronda 2 — H-6 (fecha de negocio) y H-9 (`amount ?? 0`)

Ajuste del Maestro derivado del Conciliador, con dos invariantes del auditor en
rojo por cerrar. Territorio de esta ronda: sólo `frontend/src/features/purchases/**`
y `frontend/src/api/purchases.ts` (no se tocó `backend/**`, `src/audit/**`,
`features/inventory/**` ni `features/shifts/**`).

### H-6 — la fecha de negocio se derivaba de la zona del navegador, no de Bogotá

**El defecto.** `PayablesTab.tsx`, `ReceptionsTab.tsx` y
`SupplierReliabilityDialog.tsx` armaban cada una su propio `defaultRange()` con
`new Date().toISOString().slice(0, 10)`. `toISOString()` da la fecha en **UTC**:
en Bogotá (UTC−5), a partir de las 19:00 locales eso ya es el día siguiente.
Consecuencia real: el rango "últimos N días" de estas tres pantallas se corría
un día todas las noches, justo en la franja en la que un administrador suele
revisar recepciones o cuentas del día — una recepción hecha a las 20:00 podía
quedar fuera de un rango "hoy" calculado un minuto después.

**La corrección — un solo helper, no una cuarta fórmula.**
`frontend/src/features/purchases/lib.ts` ahora exporta:

```ts
export function defaultDateRange(days: number): { from: string; to: string } {
  return { from: daysAgoInBogota(days), to: todayInBogota() }
}
```

reusando `todayInBogota`/`daysAgoInBogota` de `frontend/src/features/reports/lib.ts`
(ya público, ya usado con el mismo criterio por `features/inventory/lib.ts` vía
sus alias `todayLocal`/`daysAgoLocal`) — **no se copió la fórmula ni se
inventó una tercera implementación**. Las tres pantallas se editaron para
importar `defaultDateRange` de `./lib` y borrar su `defaultRange()` local:

- `ReceptionsTab.tsx`: `useState(() => defaultDateRange(30))` (mantiene la
  ventana de 30 días que ya tenía, sólo cambia CÓMO se calcula el `to`/`from`).
- `PayablesTab.tsx`: `useState(() => defaultDateRange(90))`.
- `SupplierReliabilityDialog.tsx`: `useState(() => defaultDateRange(90))`.

**Test nombrado, con el reloj fijo** (`src/features/purchases/__tests__/lib.test.ts`,
describe `defaultDateRange — fecha de negocio en America/Bogota, nunca la UTC
del navegador (H-6, ronda 2)`): `vi.setSystemTime(new Date("2026-09-17T01:30:00Z"))`
— exactamente las 20:30 del 16 de septiembre en Bogotá (Colombia no tiene
horario de verano, UTC−5 todo el año) — y verifica que `defaultDateRange(90).to`
sea `"2026-09-16"` (la fecha de negocio local, no `"2026-09-17"` que habría dado
`toISOString().slice(0,10)`) y que `.from` sea exactamente `"2026-06-18"`, 90
días antes de esa fecha (verificado con `datetime.date` de Python al escribir
el test, no a ojo).

**Los dos invariantes del auditor, verificados en verde sin editarlos:**

```
✓ src/audit/purchases-counts.test.ts > la fecha de negocio de las pantallas de
  compras (§ zona horaria) > ninguna pantalla de compras deriva la fecha de la
  zona del navegador
✓ src/audit/security.test.ts > la fecha de negocio no se deriva de la zona del
  navegador > no usa toISOString().slice(0, 10)
```

(`security.test.ts` corre sobre TODO `src/`, así que el mismo patrón en
`features/purchases` también lo hacía fallar a él — un solo defecto, dos
invariantes heredados en rojo, ambos cerrados por el mismo cambio.)

### H-9 — `amount: amount ?? 0` en el POST de pago

**El defecto.** `PayableDetailDialog.tsx` (dentro de `RegisterPaymentForm`)
armaba el cuerpo de `POST .../payments` con `amount: amount ?? 0`. Con
`amount: number | null` en el estado, eso es exactamente "`null` dibujado como
`0`" que `AGENTS.md` prohíbe: hoy no disparaba porque el `PinPad` de esa
pantalla queda `disabled={!amountValid || mutation.isPending}` (con
`amountValid = amount !== null && amount > 0`), pero esa es una guarda
**distinta**, escrita 74 líneas más abajo del `mutationFn` — un refactor que
tocara sólo ese `disabled` (o que cambiara el orden de los campos) podía mandar
un pago de $0 sin que nada del lado del `mutationFn` lo impidiera.

**La corrección — early-return tipado, dentro del propio `mutationFn`:**

```ts
mutationFn: (pin: string) => {
  if (amount === null) {
    // Guarda tipada, no decorativa: sin monto no hay pago que enviar, punto.
    return Promise.reject(new Error("Falta el monto del pago"))
  }
  return createPayment(
    payable.id,
    { amount, method, paid_at: paidAt, reference: reference.trim() === "" ? null : reference.trim(),
      from_cash_drawer: fromCashDrawer, authorizer_pin: pin },
    idempotencyKeyRef.current,
  )
},
```

`amount` a secas (no `amount ?? 0`) porque el early-return ya descartó el caso
`null` — el propio compilador exige esto: sin el `if`, TypeScript rechaza pasar
`amount: number | null` donde `PaymentIn.amount: number` pide `number`. El `if`
no es un comentario, es lo que hace compilar el código sin el `?? 0`.

**Test que lo fija, aislado de la otra defensa** (archivo nuevo
`src/features/purchases/__tests__/PayableDetailDialog.paymentAmountGuard.test.tsx`,
para no acoplarlo al resto de `PayableDetailDialog.test.tsx`): mockea
`@/components/PinPad` con un `PinPad` de prueba que **ignora `disabled`** y
dispara `onSubmit("1234")` con un solo click — exactamente lo que haría un
`PinPad` real si un refactor futuro le quitara el `disabled={!amountValid}`.
Con el campo "Monto" sin tocar (`amount` sigue en `null`), se dispara ese PIN
de prueba y se verifica `expect(createPaymentMock).not.toHaveBeenCalled()`: el
envío ni siquiera ocurre, aun con la otra defensa deliberadamente rota. Esto
prueba la guarda real (la del `mutationFn`), no la del `disabled`, que ya
tenía cobertura en `PayableDetailDialog.test.tsx`.

### H-1 (contexto de backend-compras, no construido acá)

`backend-compras` está cerrando H-1 en esta misma ronda: anular un pago hecho
"desde el cajón" ahora crea un movimiento de caja compensatorio en el turno
abierto, y si NO hay turno abierto la anulación se rechaza con
`409 NO_OPEN_SHIFT`. No toqué `backend/**` ni `features/shifts/**` — es
explícitamente terreno ajeno — pero revisé que `VoidPaymentAction` (dentro de
`PayableDetailDialog.tsx`) ya cae en el camino genérico de error
(`errorMessage(mutation.error)` dentro de un `role="alert"` en el
`AlertDialog` de anulación) sin ningún atajo que dé por hecho que la anulación
funcionó, y sin necesidad de tocar el componente. Igual que pide el ajuste, lo
verifiqué con un test dedicado, agregado a
**`src/features/purchases/__tests__/PayableDetailDialog.test.tsx`** (el mismo
archivo que ya cubría `409 NO_OPEN_SHIFT` en el **pago**; este nuevo describe
cubre el mismo código en la **anulación**), mockeando también `voidPayment`
(sumado al `vi.hoisted` que ya mockeaba `approvePayable`/`createPayment`).

El test registra primero un pago "desde el cajón" real (vía `createPayment`
mockeado con éxito — es la única forma de tener algo que anular, dado el
hueco de contrato §8.2: no existe un `GET` que liste pagos existentes), y
luego intenta anularlo con `voidPayment` mockeado para rechazar con
`new ApiError(409, "NO_OPEN_SHIFT", "No hay un turno abierto en esta sede;
abrí un turno para anular un pago hecho desde el cajón")`. Verifica dos cosas:
el mensaje del servidor se muestra tal cual (`findByText(/no hay un turno
abierto en esta sede/i)`), y el pago **sigue apareciendo en la tabla como
vigente** — ni pintado "Anulado: ...", ni removido de la lista — porque el
backend no lo anuló.

**Deuda con dueño para el próximo pedido (§8 actualizado):** el pedido de
`frontend-inventario-conteos` — que `PayablesTab` lea filtros desde la URL
para que las tarjetas de "Hoy" lleguen pre-filtradas a "vencidas" /
"pendientes de revisión" — **no se construyó en esta ronda**. Queda anotado en
§8 como deuda con dueño (yo) para el próximo pedido.

### Verificación de ronda 2 — sólo el territorio de esta ronda

```bash
export TMPDIR=/tmp/pt-frontend-compras-r2 && mkdir -p $TMPDIR
cd /home/user/restaurante-sistema/frontend
npx vitest run src/features/purchases src/app
npm run typecheck
```

Corrido dos veces en serie, mismo resultado exacto las dos veces:

**`Test Files 15 passed (15)`, `Tests 57 passed (57)`** (14→15 archivos, 54→57
tests: el archivo nuevo `PayableDetailDialog.paymentAmountGuard.test.tsx` con
1 test (H-9), más 1 test nuevo en `lib.test.ts` para `defaultDateRange` (H-6),
más 1 test nuevo en `PayableDetailDialog.test.tsx` para el 409 de la
anulación "desde el cajón" (H-1, contexto).

`npm run typecheck` (`tsc --noEmit -p tsconfig.app.json`): limpio, sin salida,
las dos veces.

Además, verifiqué en modo lectura (sin editarlos, fuera de mi territorio) los
dos invariantes de `src/audit/` que motivaron este ajuste — ambos en verde:
`src/audit/purchases-counts.test.ts` ("la fecha de negocio de las pantallas de
compras") y `src/audit/security.test.ts` ("no usa toISOString().slice(0, 10)").

**Rojo encontrado fuera de mi territorio, nombrado y NO tocado:** al correr
`src/audit/purchases-counts.test.ts` completo (sólo para confirmar que mi
cambio no rompía nada ajeno) apareció un rojo preexistente y ajeno: "el
frontend conoce la causa `supplier_payment` y sabe cómo nombrarla" —
`api/shifts.ts` (`CashMovementCause`) y `features/shifts/MovementsPanel.tsx`
(`CAUSE_LABEL`) todavía no incluyen la causa `supplier_payment` que
`backend-compras` ya produce en 2b. Es explícitamente territorio de
`features/shifts/**`/`api/shifts.ts`, fuera de lo que esta misión y este
ajuste me asignan (el mandato original prohíbe tocar `src/app/PosLayout.tsx`,
`src/app/PosHome.tsx` y "cualquier otro feature"; el ajuste de ronda 2 prohíbe
explícitamente `features/shifts/**`). Lo dejo nombrado acá para que el
Maestro lo asigne a quien tenga `api/shifts.ts`/`features/shifts/**` como
territorio.
