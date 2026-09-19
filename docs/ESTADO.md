# Restaurante Sistema — estado del proyecto

Documento de referencia para retomar el trabajo sin reconstruir el contexto.
Última actualización: 2026-09-16 (**pedido 2a cerrado y verificado** por el
orquestador humano: suite de backend **770/770**, vitest **280/280**, mypy y
`tsc` limpios, build OK, Alembic desde cero `0001 → 0010` con 63 tablas. Los
nueve rojos que declaró la entrega están cerrados —ocho eran advertencias del
auditor y el noveno era un invariante heredado mal acotado que además había
deformado el contrato publicado de `/admin/sales`—. Además **el repositorio ya
tiene despliegue**: `render.yaml` en la raíz y `main` al día con todo el código.
Lo que sigue: **2b**. Lo de abajo quedó escrito por un agente a mitad de la
construcción y se conserva por su detalle técnico, no por su estado.
—— Nota original del agente: **pedido 2a, ronda 2 del conciliador**:
cierra el bloqueante **B-1** — la nota «vuelve»/«se usó» ahora SÍ revierte el
consumo teórico de verdad, conectada desde `app.fiscal.service.issue_note` —
y la mitad de **B-2** de este agente, el "cero mudo congelado" de
`_document_cost_stats`. `app/fiscal/**` pasó a territorio de
`backend-consumo` para esta ronda, sólo para la reversión de notas. Antes
(2026-09-15): **pedido 2a construido** — insumos, preparaciones, fichas
técnicas, libro de movimientos, consumo teórico al enviar, mermas y costo en
los reportes; tres agentes de backend [`backend-inventario`,
`backend-recetas`, `backend-consumo`], sin `ENTREGA.md` del Maestro todavía —
este agente [`backend-consumo`] deja el estado al cierre de su propia
construcción, con la verificación completa **pendiente del orquestador
humano**, igual que pasó con 1b-1. Antes de eso: pedido 1b-2 construido y
verificado, con `ENTREGA.md` del Maestro y cierre a mano de los tres rojos que
la entrega declaró; con esto la fase 1b está completa. 1b-1 construido,
verificado y recorrido en navegador real. Pedido 1a entregado y verificado el
2026-09-14; framework 2.1.0).

**Este documento es VIVO.** Si un cambio altera una regla o un flujo descrito acá,
se actualiza en el MISMO PR que el cambio. Un estado desactualizado miente con más
autoridad que no tener estado.

---

## Cómo corre

Backend y frontend existen y corren; `.claude/launch.json` está ajustado a estos
comandos reales. En desarrollo el backend usa SQLite y el frontend proxea `/api`
al backend (mismo origen, cookies `httpOnly`); en producción el backend sirve
`frontend/dist` con fallback SPA.

```bash
# instalación (una sola vez; sin venv, tal como pide CONTRATO-INTERNO §1)
cd backend
pip install -r requirements.txt -r requirements-dev.txt

# esquema (Alembic desde el primer commit — nunca create_all en producción)
alembic upgrade head

# datos de ejemplo — un comando aparte, nunca al arrancar; corre dos veces sin duplicar nada
python -m app.seed

# arranque
PYTHONPATH=. DATABASE_URL=sqlite:///./dev.db uvicorn app.main:app --reload --port 8000
# /docs sirve el OpenAPI; si existe ../frontend/dist, main.py lo sirve con fallback SPA

# frontend
cd frontend
npm install
npm run dev -- --port 5173   # proxea /api -> :8000 (mismo origen; ver vite.config.ts)
```

| Servicio | Directorio | Comando | Puerto |
|---|---|---|---|
| backend | `backend/` | `uvicorn app.main:app --reload --port 8000` | 8000 |
| frontend | `frontend/` | `npm run dev -- --port 5173` | 5173 |

**En producción es UN solo servicio, no dos.** `render.yaml` (raíz) define el
despliegue: el build construye el frontend y `main.py` sirve `frontend/dist` con
fallback SPA, así que API y frontend quedan bajo el mismo origen — que es lo que
exige la cookie `httpOnly`, no una comodidad. No hay Dockerfile ni hace falta.
`DATABASE_URL` se conecta tal como la entregue el host: `normalize_database_url`
le pone el driver **psycopg 3** que este repo instala (una URL `postgresql://`
sin normalizar busca psycopg2 y la API no arranca).

Variables de entorno (ver `backend/app/core/config.py`): `DATABASE_URL` (default
`sqlite:///./dev.db`), `JWT_SECRET`, `ENV` (`dev`\|`test`\|`production`),
`EMPLOYEE_SESSION_MINUTES` (default 3), `PIN_LOCK_ATTEMPTS` (5), `PIN_LOCK_MINUTES`
(15), `DEVICE_SESSION_DAYS` (180), `ADMIN_SESSION_HOURS` (12). El PIN de sede y el
PIN/contraseña de cada persona se configuran desde la app (seed o Admin), no por
variable de entorno. Ninguna credencial va al repo. `TZ` no aplica: la hora de
Bogotá se calcula siempre con `app/core/tz.py`, nunca con la zona del sistema.

**Seed de desarrollo** (`python -m app.seed`, idempotente): una organización perfil
`standard`, una sede con fiscal vigente (natural, ordinario, INC 8 %, precios con
impuesto), PIN de sede `123456`, UVT 2026 = 52.374, admin `admin@demo.local` /
`cambiar` (PIN POS `9000`), supervisor (PIN `5001`), cuatro operadores (PIN `6001`
a `6004`; `6001` puede cobrar), dos zonas ("Salón", "Terraza") con cuatro mesas
cada una, y **cinco rangos de numeración de desarrollo** (`DEVPOS`, `DEVFAC`,
`DEVNC`, `DEVND`, `DEVNA`, 1-5000, vigencia amplia) con resolución
deliberadamente falsa y rotulada (`DEV-NO-ES-RESOLUCION-DIAN`). Sin esos rangos
una base recién sembrada **no puede vender**: `fiscal.dee_pos` viene encendida en
los tres perfiles y el primer cobro corta con `400 NO_FISCAL_RANGE`. Se cargan
en vez de apagar la flag para que el seed ejercite el camino real; antes de
operar de verdad hay que cargar el rango autorizado en Admin → Rangos de
numeración, y el seed lo dice al terminar. Si existe
`app.catalog.seed.seed_catalog`, también carga la carta (lo hace `catalogo`; ver
su output). Imprime todos los PIN por consola al correr.

## Reglas duras

Las decisiones que no se renegocian están en `docs/SPEC-NEGOCIO.md § 11`. Las que
más fácil se rompen sin que se vea en pantalla:

- **Gates en el backend, no en la UI**: sin turno abierto no hay venta; sin
  justificación no cierra un turno con diferencia; anular un ítem enviado o una
  venta cobrada exige motivo y PIN de administrador.
- **Snapshot en el ítem**: precio, impuesto, costo teórico y receta usada se
  congelan al vender. Los reportes nunca revaloran ventas pasadas con la carta
  actual.
- **Un solo descuento de insumo**: al producir la preparación o al enviar el plato,
  nunca ambos.
- **Fecha operativa de negocio** (`America/Bogota`) en columna propia; nunca
  derivada de un timestamp UTC.
- **Nada financiero ni de inventario se borra**: baja lógica + auditoría.
- **Propina separada** de la venta y del impuesto.
- **Sesión en cookie `httpOnly`**; nada sensible en `localStorage`.
- **Cobro, envío y producción idempotentes** (`Idempotency-Key` reservada dentro de
  la transacción) y `409` ante concurrencia.
- **La reserva de caja se declara aparte** y no entra al esperado (Palmetto, 15-ago
  en la referencia).
- **Una sola matemática en el backend**; el frontend no deriva plata; `null` ≠ 0.
- **Causa tipada** en movimientos de caja e inventario.
- **Atribución con FK real** (`employee_id`) más nombre congelado; empleados nunca
  se borran.
- **Producto para varios restaurantes**: organización → sede; toda función opcional
  detrás de su flag, exigido por el backend; lo legal y la integridad no se apagan.

## Glosario español ↔ código

La UI habla español y el código inglés. Para que nadie invente un tercer nombre:

| En la UI / en los docs | En el código |
|---|---|
| organización (el cliente) | `organization` |
| sede | `store` |
| función habilitable / perfil | `feature` / `profile` (`basic`, `standard`, `full`) |
| venta de mostrador | `counter` (canal) |
| día operativo | `business_day` |
| turno de caja | `shift` |
| empleado / operador | `employee` (rol `operator`), `admin` |
| mesa / zona | `table` / `zone` |
| comanda | `order` |
| ítem de comanda | `order_item` |
| canal (mesa, para llevar, domicilio) | `channel` (`dine_in`, `takeout`, `delivery`) |
| cobro / pago | `payment` |
| propina | `tip` |
| tiquete | `ticket` |
| nota crédito | `credit_note` |
| insumo | `ingredient` |
| preparación / lote | `prep` / `prep_batch` |
| plato / producto | `product` |
| ficha técnica (receta) | `recipe` |
| modificador | `modifier_group` / `modifier_option` |
| combo | `combo` |
| movimiento de inventario | `stock_movement` |
| merma | `waste` |
| conteo | `stock_count` |
| recepción de compra | `purchase_receipt` |
| cuenta por pagar | `payable` |
| movimiento de caja | `cash_movement` |
| retiro de efectivo | `cash_pickup` |
| relevo (cuadre sin cerrar) | `shift_handover` |
| reserva de caja | `cash_reserve` |
| hora de corte | `cutoff_hour` |
| rescate (cierre administrativo, reabrir, cancelar, ajustar apertura) | `admin_rescue` (`close_administrative`, `reopen`, `cancel`, `adjust_opening`) |
| estación de cocina | `station` |
| curso (bebida, entrada, fuerte, postre) | `course` |
| ronda (envío a cocina) | `round` |
| cuenta presentada / precuenta | `bill_presented_at` / `pre_bill` |
| sub-cuenta (división) | `sub_account` |
| documento fiscal (equivalente POS, factura, nota) | `fiscal_document` (`pos_equivalent`, `invoice`, `adjustment_note`, `credit_note`) |
| rango de numeración DIAN | `fiscal_range` |
| adquirente / cliente | `customer` |
| consumo de personal | `staff_meal` (canal de comanda) |
| cambio (sencilla) | `cash_swap` |
| arqueo sorpresa | `spot_check` (tipo de `shift_handover`) |
| responsable de caja | `cash_responsible` |
| supervisor / encargado | `supervisor` |
| devolución pendiente | `pending_refund` |
| base fija | `opening_cash_fixed` |
| causa de un movimiento | `cause` |
| proveedor | `supplier` |
| lote | `stock_batch` |
| consignación | `bank_deposit` |

## Qué está hecho

- **Adopción del framework** (2026-09-14): sistemas-maestros 2.0.0 con
  `scripts/adoptar.sh`; actualizado a **2.1.0** el mismo día (`args.base` del
  orquestador, promovido desde este proyecto). Versión en `.claude/FRAMEWORK`.
- **Spec de negocio** `docs/SPEC-NEGOCIO.md` v0.4, **aprobada** con los defaults de la
  sección 15 y el requisito de producto comercializable (organización → sede,
  funciones habilitables por flag, perfiles `basic`/`standard`/`full`).
- **Specs de los pedidos** `features/fase-1a-cimientos/spec.md` (entregado) y
  `features/fase-1b-venta/spec.md` (siguiente), con contrato de API.
- **Pedido 1b-2 construido** (documento fiscal, clientes, devoluciones y
  reportes — segunda mitad de 1b; run `wf_53220b41-950` sobre el commit base
  `d1aceb1`; outputs por agente en `features/fase-1b-venta/outputs-1b-2/`, con
  **`ENTREGA.md` del Maestro** esta vez). Dos rondas, veredicto del Conciliador
  **coherente**. Equipo elegido por el Maestro: `backend-fiscal`,
  `backend-clientes-dinero`, `backend-reportes`, `frontend-fiscal`,
  `frontend-admin` (sonnet) y `auditor-fiscal` (opus). Alembic `0006` y `0007`
  (53 tablas).
  - **`backend-fiscal`** (`app/fiscal/**`, `app/payments/**`, `app/stores`
    acotado): `FiscalRange` con reserva del consecutivo **dentro** del rango
    vigente (`SELECT FOR UPDATE`, `400 NO_FISCAL_RANGE` / `FISCAL_RANGE_EXHAUSTED`,
    nunca `500`) y alertas al 80 % y a 30 días; estados ante la DIAN
    (`pending → sent → validated|rejected|contingency`) con barrido de
    contingencia vencida a 48 h; **adaptador `FiscalProvider`** (Protocol) con
    `PendingTransmissionProvider` y `FakeProvider`; notas (`issue_note`) con
    consecutivo de su propio rango y el original a `reversed`; evidencia,
    export y reintento; factura electrónica por `requests_invoice` o por
    `invoice_threshold_uvt` × UVT. `GET /device/payment-methods` cierra el gap
    de «el POS ofrece seis códigos fijos», que dejaba emitir con un medio que
    la sede deshabilitó. **`PaymentOut.amount_due` lo manda el servidor** (A-10,
    parcial: ver punto 6 de «Dónde retomar»).
  - **`backend-clientes-dinero`** (`app/customers/**`, `app/refunds/**`,
    `app/shifts`, `app/notifications`): `Customer`, `CustomerConsent` y
    `CustomerDataRequest`; `upsert_customer_with_consent` como **única** puerta
    de escritura del dispositivo; `erase_customer` idempotente que anonimiza el
    maestro y **deja intacto el snapshot del documento**; `PendingRefund` con
    `settle_or_queue_refund` como única puerta por la que una nota mueve caja;
    propinas por medio y por empleado; cuatro tipos de notificación nuevos.
  - **`backend-reportes`** (`app/reports/**`, `app/orders`, `app/core/tax.py`,
    dueño único de `app/main.py` y `models_registry.py`): Hoy, Ventas con siete
    `group_by`, informe del contador, agotados, `format=csv`; `admin_list_orders`
    con p50/p90 por estación **que sobreviven a un `merge`** (se leen de
    `OrderItem.sent_at`, no de `OrderRound`); `TAX_RATE_BY_CODE` centralizada en
    `app/core/tax.py`; **A-12 corregido** en `prorate` (cada línea topeada a su
    propio peso cuando `amount <= Σ pesos`, con el sobrante pasando a la
    siguiente línea con saldo; el otro llamador —porciones de un ítem
    compartido, donde los pesos no son plata— conserva el comportamiento de
    siempre).
  - **`frontend-fiscal`** (`src/features/{fiscal,customers,payments}/**`):
    Documentos con estado, reintento y evidencia; Rangos; Notas; Devoluciones
    pendientes; Clientes con consentimientos, bitácora y supresión. **A-11
    cerrado**: la leyenda legal ya no está escrita a mano en el cliente, viene
    del servidor y sigue el estado DIAN.
  - **`frontend-admin`** (`src/features/{reports,orders}/**`, `src/app/**`,
    `src/components/**`): `DateRangeFilter`, `CsvExportButton` y `StatTile`
    compartidos; Hoy (pulso y «Requiere tu atención»), Ventas en tres pestañas
    con gráficos en SVG propio y la tabla exacta al lado, Pedidos ampliado. El
    índice de `/admin` pasa de «Funciones» a «Hoy». **O-1 cerrado**
    (`DiscountDialog` ya no redondea en silencio).
  - **`auditor-fiscal`** (opus): 182 invariantes ejecutables (146 backend + 36
    frontend; 50 + 16 nuevos de 1b-2). Halló **tres bloqueantes reales** en la
    ronda 1, escritos como tests rojos a propósito y cerrados en la ronda 2 sin
    tocar una sola aserción: **B-1** `erase_customer` copiaba al `before` de
    `audit_logs` el mismo dato que el titular pedía suprimir (hoy
    `_customer_audit_view` guarda sólo los **nombres** de los campos); **B-2**
    cobrar con `customer` en el body y la flag `customers` apagada dejaba la
    comanda `paid` **sin documento y sin pago** —la venta se perdía entera e
    indetectable— (hoy `assert_feature(…, "customers")` corre antes de
    `claim_payment`); **B-3** el documento en contingencia vencido no llegaba a
    «Requiere tu atención» (hoy `sweep_contingency_overdue` corre dentro de
    `today_report`).
  - **Cierre a mano del orquestador humano**: la entrega declaró tres rojos, los
    tres en archivos que **no estaban en el territorio de ningún agente** —la
    lección de reparto de `ENTREGA.md § 7`—. Corregidos: (1) `app/seed.py` no
    cargaba ningún `FiscalRange` y `fiscal.dee_pos` viene encendida en los tres
    perfiles, así que **una base recién sembrada no podía vender** (`400
    NO_FISCAL_RANGE`); ahora carga cinco rangos de desarrollo con resolución
    deliberadamente falsa y rotulada (`DEV-NO-ES-RESOLUCION-DIAN`), en vez de
    apagar la flag, para que el camino real quede ejercitado; (2)
    `invoice_threshold_uvt` entró como campo **obligatorio** en una entrada que
    ya existía, y convertía la regla de negocio `TIP_PCT_OVER_LIMIT` en un
    `VALIDATION_ERROR` genérico — recuperó su default `5`; (3) `tests/shifts`
    carga rango como sus carpetas hermanas, así que el E2E de totales del turno
    vuelve a probar el camino real de cobro; (4) el test del popup en portal
    (`PaymentSplitsForm`) espera el montaje en vez de consultarlo síncrono; y
    (5) se quitó el montaje manual de routers de `tests/{customers,refunds}/
    conftest.py`, que desde que `create_app()` monta ambos dominios los montaba
    por segunda vez sobre el `app` singleton (de ahí las advertencias
    `Duplicate Operation ID`).
- **Pedido 1b-1 construido** (comanda y cobro, primera mitad de 1b; run
  `wf_1ee5978f-ad4` sobre el commit base `098d3a0`; contrato interno del equipo
  en `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md`; outputs por agente en
  `features/fase-1b-venta/outputs-1b-1/`; **no hay `ENTREGA.md`**: el run se
  pausó a pedido del dueño al terminar la construcción, antes de la
  Conciliación, para cuidar la ventana de uso, y el cierre lo hizo a mano el
  orquestador humano — hallazgo B-1 corregido y verificación completa, ver
  «Dónde retomar»). Equipo elegido por el Maestro: `backend-base`,
  `backend-comanda`, `backend-cobro`, `frontend-comanda`, `frontend-cobro`
  (sonnet) y `auditor-venta` (opus).
  - **`backend-comanda`** (`app/orders`, `app/kitchen`, Alembic `0004_orders`):
    la única matemática de la venta en `app/orders/money.py` (enteros, sin
    float; `prorate` reparte exacto y el residuo va a la línea mayor); canales
    `counter`/`dine_in`/`takeout`/`staff_meal` detrás de flags; mesas con unión
    y movimiento (índice único parcial anti-carrera); comandas con versión
    optimista (`409 STALE_VERSION`) e `Idempotency-Key`; rondas numeradas con
    contador de porciones que apaga el producto; anulación con motivo tipado;
    cortesía con límite por turno; descuentos por ítem/comanda con límite por
    empleado/sede y alerta acumulada; precuenta con propina sugerida ≤ 10 %;
    división por partes iguales y por ítems (sub-cuentas cuya suma reproduce el
    total); 23 endpoints bajo `/api/v1` más la vista mínima de cocina (sin
    modelos propios). Firmas que usa `backend-cobro`: `get_order_or_404`,
    `compute_order_totals`, `compute_sub_account_totals`, `order_out`,
    `assert_payable`, `claim_payment`, `auto_send_pending_for_payment`,
    `business_date_for_sale`.
  - **`backend-cobro`** (`app/payments`, `app/fiscal` sin router, Alembic
    `0005_payments_fiscal`): `pay_order` valida todo (versión, `can_charge`,
    PIN propio, sub-cuenta, `assert_payable`, totales, propina, medios y
    splits) **antes** de escribir; luego `auto_send_pending_for_payment`,
    `claim_payment` (`UPDATE` condicional, `409` en carrera),
    `reserve_next_number` + `issue_document` dentro de un `SAVEPOINT`
    (`IntegrityError` → `409 ORDER_ALREADY_PAID`), `OrderTip`, un `Payment` por
    split, `record_audit`. Consecutivo por sede sin huecos (`FiscalCounter`
    con `SELECT FOR UPDATE`); el documento se emite como `pos_equivalent`
    (`dian_status=pending`, sin evidencia DIAN) o `internal_receipt`
    (`dian_status NULL`, leyenda que niega ser factura) según la flag
    `fiscal.dee_pos`. Rangos DIAN, `FiscalProvider`, notas, devoluciones y
    clientes quedan para 1b-2 (columnas ya previstas en `NULL`).
  - **`frontend-comanda`** (`src/features/orders/**`, `src/api/orders.ts`,
    `src/api/kitchen.ts`): Mesas, Comanda nueva y abierta, Cocina y
    Admin → Pedidos; `ordersFeature` exporta `posRoutes`/`adminRoutes`/
    `posNav`/`adminNav`. Toda mutación manda `expected_version` y ante
    `STALE_VERSION` reemplaza la comanda local; `AUTHORIZATION_REQUIRED`,
    `DISCOUNT_LIMIT_EXCEEDED` y `BILL_PRESENTED_NEEDS_AUTH` abren el diálogo
    de PIN del autorizador y reintentan con `Idempotency-Key` nueva. El
    frontend no calcula plata: todo sale de `OrderOut.totals`/`tip`/`PreBillOut`.
  - **`frontend-cobro`** (`src/features/payments/**`, `src/components/
    EmployeePicker.tsx`, carcasa `src/app/*`): «Quién opera» con lista de
    personal (`EmployeePicker` reemplaza los inputs numéricos en identificar,
    apertura, roster y relevo); `PosHome`/`PosLayout`/`AdminLayout` integran
    `shiftsFeature`, `ordersFeature` y `paymentsFeature`; `CheckoutPage`
    (precuenta con leyenda tal cual llega, pregunta de propina, división en
    partes iguales o por ítems, pagos mixtos con PIN e `Idempotency-Key`,
    `STALE_VERSION` y `ORDER_ALREADY_PAID` manejados) y `DocumentPage`
    (comprobante imprimible 58/72/80 mm con `document-print.css`, reimpresión
    contada).
  - **`auditor-venta`** (opus; `backend/tests/audit/**`, `frontend/src/audit/**`):
    32 invariantes nuevos y 6 reescritos por O-1 (96 en backend, 20 en
    frontend). **La plata cierra**: las cinco identidades de `compute_totals`
    se cumplen sobre 1.000 comandas aleatorias (`random.Random(20260915)`) y
    los mismos números aparecen en `OrderOut.totals`, `PreBillOut` y
    `DocumentPrintableOut`; consecutivo 1..100 sin huecos y tres rechazos `400`
    no consumen número; dos cobros concurrentes dejan una venta, un pago y un
    documento; misma `Idempotency-Key` → mismo documento; documento inmutable.
    Hallazgo bloqueante **B-1** (corregido en el cierre, ver abajo) y
    advertencias A-10/A-11/A-12 y observaciones O-1/O-2/O-3 abiertas en
    `features/fase-1b-venta/outputs-1b-1/auditor-venta.md § 3`.
  - **Corrección B-1 del cierre** (orquestador humano, `app/orders/service.py`
    `assert_payable`): cobrar una comanda con `status=paid` o `paid_at` no nulo
    responde `409 ORDER_ALREADY_PAID` (antes `400 ORDER_NOT_OPEN`, que dejaba
    muerta la pantalla «Esta comanda ya fue cobrada» del POS), y
    `SUB_ACCOUNT_ALREADY_PAID` es `409` por los dos caminos (cierra también
    O-3). `tests/payments/test_concurrency.py` y `test_split.py` exigen ahora
    el `409` sin alternativa; el test del auditor pasó a verde sin tocarlo.
  - Lo que entregó `backend-base` (cimientos, caja y personal del dispositivo
    — esto es lo que destrabó al resto):
  - **`GET /device/employees`** («Quién opera», SPEC-NEGOCIO §9.1; cierra A-9
    de 1a): personal activo de la sede del dispositivo **o** de toda la
    organización (`store_id NULL`, los admins), sólo `{id, name, role}` —
    nunca `document`, `email`, `discount_limit_pct`, `can_charge` ni hashes.
  - **O-1 resuelto por default**: con `cash.blind_close` encendida (perfil
    `full`, el del seed y el de los tests, la deja encendida) el responsable
    de caja **no** ve `expected_cash`/`sales`/`tips` en `GET /shifts/current`
    ni en `GET /shifts/{id}` — sólo el admin; el responsable los ve recién en
    el paso 2 del cierre (`GET /shifts/{id}/close/{count_id}/review`). Con la
    flag apagada, el responsable ve todo igual que antes. Un único predicado,
    `app.shifts.router._can_see_expected(db, actor, shift)`.
  - **A-7 resuelto por default**: `document` y `email` de empleados quedan
    fuera del `before`/`after` de `record_audit(entity="employee")`
    (`app.auth.router._employee_audit_view`); `GET /admin/employees` los
    sigue devolviendo al admin sin cambios.
  - **`app/shifts/hooks.py`**: `SalesTotals` ahora trae `other`,
    `tips_card`/`tips_transfer`/`tips_other` además de `cash`/`card`/
    `transfer`/`tips_cash`; `get_sales_totals` lee `app.payments.models.Payment`
    (protegido con `find_spec_safe`, ver más abajo) agrupado por medio del
    turno con `voided_at IS NULL`. `compute_breakdown` no cambió: sigue
    leyendo sólo `.cash`.
  - **Gate de comandas abiertas al cerrar el turno**: `confirm_close` y
    `close_single_step` responden `400 OPEN_ORDERS_EXIST {open_orders: n}` si
    el turno tiene comandas `open`/`to_pay` y no se pidió `transfer_open_orders`
    (el campo ya existía en `CloseConfirmIn`/`SingleStepCloseIn`); con el
    traslado (o siempre, en `close_administrative`, que es un rescate) las
    comandas quedan `shift_id NULL` a la espera del turno siguiente, que las
    adopta al abrir. Los tres hooks (`count_open_orders`, `detach_open_orders`,
    `adopt_transferred_orders`) viven en `app.orders.hooks` (los escribió
    `backend-comanda`; `backend-base` sólo los llama, protegido con
    `find_spec_safe`). `CloseReviewOut` ganó `open_orders: int`.
  - **Fixtures nuevas en `tests/conftest.py`** (sin tocar las existentes):
    `open_shift(*, responsible=None, total=200000, cash_reserve=0,
    opening_cause=None, opening_note=None)`, `catalog_seeded`, y `race_env`
    (dataclass `RaceEnv` con `client`, `employee_id`, `store_id`,
    `organization_id`, `store_pin`, `employee_pin`, `session_factory`, más
    `seed_product(...)` y `open_shift()`); `race_app` quedó como wrapper
    delgado sobre `race_env` — mismo comportamiento externo que en 1a, ningún
    test de carrera existente se tocó.
  - **`app/main.py` (`DOMAINS`) y `app/core/models_registry.py`
    (`MODEL_MODULES`)** ya incluyen `orders`/`payments`/`fiscal`/`kitchen`
    (`kitchen` sin modelos).
  - **Defecto encontrado y corregido** (no estaba en el contrato):
    `importlib.util.find_spec("app.payments.router")` — o cualquier submódulo
    de un dominio que todavía no tiene ni carpeta — **lanza**
    `ModuleNotFoundError` en vez de devolver `None`, porque `find_spec` de un
    nombre con punto importa primero el paquete padre. En 1a esto nunca se vio
    porque todo dominio ausente durante la construcción en paralelo ya tenía
    su `__init__.py`; en 1b-1, mientras `app/payments` y `app/fiscal` no
    tenían carpeta, agregar `"payments"`/`"fiscal"` a `DOMAINS`/`MODEL_MODULES`
    tumbaba el arranque completo de la API (y por lo tanto toda la suite de
    tests, de cualquier dominio). Nuevo helper **`app.core.modules.find_spec_safe`**
    (atrapa `ModuleNotFoundError`) reemplaza el `find_spec` crudo en
    `main.py`, `models_registry.py`, `shifts/hooks.py` y `shifts/service.py`.
  - Confirmado sin cambios (ya cumplía lo pedido): el seed de desarrollo
    (`app/seed.py`) ya declara `active_channels` counter/dine_in/takeout,
    `payment_methods` cash/card/transfer habilitados, `stations`, `courses` y
    `course_target_minutes`.
- **Pedido 1a entregado** (orquestador, dos rondas, veredicto del Conciliador
  **coherente**; entrega del Maestro en `features/fase-1a-cimientos/outputs/ENTREGA.md`,
  outputs por agente en el mismo directorio, contrato interno del equipo en
  `features/fase-1a-cimientos/CONTRATO-INTERNO.md`). Equipo: `backend-core`,
  `backend-caja`, `catalogo` (rol nuevo, full-stack), `frontend-core`,
  `frontend-caja`, `auditor-control` (opus, 58 invariantes ejecutables en
  `backend/tests/audit/` y `frontend/src/audit/`).
  - **Backend** (`backend/app/`): `core` (config, `UTCDateTime`, reloj, tz, dinero,
    errores de una sola forma, seguridad con cookies `httpOnly`, idempotencia,
    catálogo de 41 funciones con perfiles y `require_feature`), `auth` (empleados,
    sesión de dispositivo, PIN con bloqueo, autorizaciones supervisor/admin),
    `stores` (organización, sedes, fiscal con vigencia, ajustes de caja y ventas,
    UVT, zonas, mesas, flags con override por sede), `audit`, `notifications`,
    `catalog` (carta plana: categorías, productos con precio por canal y tasa,
    modificadores, combos y menú del día con franjas, agotados y contador; sin
    campos de costo), `shifts` (día operativo con hora de corte y `closes_day`,
    turno con base fija y reserva aparte, roster, movimientos con causa, cambio
    neto cero, retiros con snapshot, relevo y arqueo sorpresa, cierre a ciegas en
    tres pasos, cierre en un paso cuando `cash.blind_close` está apagada, rescates
    de admin, actividad por persona). Alembic `0001 → 0002 → 0003` (31 tablas),
    `python -m app.seed` aparte e idempotente, CI en `.github/workflows/ci.yml`
    (Postgres 16; backend y frontend en serie).
  - **Frontend** (`frontend/src/`): Vite + React 19 + TypeScript 6 + Tailwind v4 +
    shadcn sobre `@base-ui/react`; `api/client.ts` con `credentials: "include"`;
    login admin, activar dispositivo, identificarse, Admin → Funciones,
    Configuración (8 pestañas), Carta, Dinero (operacional, historial, cronología,
    rescates), Turnos y personal (actividad y autorizaciones), Historial,
    Notificaciones; POS → Turno (abrir, roster, movimientos, cambio, retiros,
    relevo, cierre a ciegas o en un paso según flag, foto).
  - **Verificación final** (orquestador humano, árbol quieto, en serie): mypy
    limpio; `tsc` limpio; Alembic desde cero y `downgrade base`; seed dos veces sin
    duplicar; vitest 61/61; `vite build` OK; suite de backend completa (ver «Dónde
    retomar» para el resultado posterior a las correcciones).
  - **Correcciones posteriores a la entrega** (commit `31db8cb`): D-1 (el hook que
    agrega al roster al identificarse se buscaba en `app.shifts.service` y vive en
    `app.shifts.hooks`; test de punta a punta), D-2 (`race_app`, una sesión por
    request, promovida a `tests/conftest.py`; el test de carrera de `tests/shifts`
    corre sobre ella y acepta `409 SHIFT_OPEN_RACE` o `400 SHIFT_ALREADY_OPEN`),
    A-3 (`app/shifts/models.py` usa `UTCDateTime`).
- **Pedido 2a construido y verificado** (insumos, preparaciones, fichas
  técnicas, libro de movimientos, consumo teórico al enviar, mermas y costo en
  los reportes que ya existían — primera mitad de la fase 2; run
  `wf_630a825c-c41` sobre el commit base `dad3ee1`, outputs en
  `features/fase-2-costo-inventario/outputs-2a/` **con `ENTREGA.md` del
  Maestro**). Dos rondas, veredicto del Conciliador **coherente**. Alembic
  `0008 → 0009 → 0010` (**63 tablas**). Equipo de seis: `backend-inventario`,
  `backend-recetas`, `backend-consumo`, `frontend-recetas`,
  `frontend-inventario` (sonnet) y `auditor-costos` (opus). **Los seis
  corrieron**: el párrafo que decía que el frontend y el auditor no habían
  corrido se escribió a mitad de la construcción y quedó viejo.
  - **`backend-inventario`** (`app/inventory/**`, Alembic `0008`, dueño del
    contrato numérico `app/core/quantity.py`): `Ingredient` (rendimiento,
    costo oficial/estimado con origen, `min_stock` obligatorio > 0,
    `consumption_untracked`, sustituto con cascada); el libro único
    `StockMovement` con `record_movement` como **única** escritura (fusiona
    por `(org, sede, insumo/prep, causa, ref_type, ref_id)`, nunca bloquea por
    stock, nunca cero mudo); `Waste`; `low_stock_alerts`/
    `negative_stock_alerts` (negativo y agotado como alertas distintas, causa
    probable derivada de causas tipadas, nunca texto). `QTY_SCALE=1000`
    (milésimas), `COST_SCALE=1_000_000` (millonésimas), redondeo half-up sólo
    en el borde — probado con 1.000 casos aleatorios en
    `tests/core/test_quantity.py`.
  - **`backend-recetas`** (`app/recipes/**`, Alembic `0009`): `Preparation`
    en dos modos (`batch`/`exploded`, default `exploded`) con `PrepBatch` y
    producción rápida con `Idempotency-Key`; `Recipe`/`RecipeVersion`/
    `RecipeLine` versionadas (las viejas se conservan); `recipe_effect`
    (`add`/`remove`/`replace`) en opciones de modificador, que quedó en
    `null` todo 1b; costo con propagación en cadena insumo → preparación →
    plato; `PREP_CYCLE` con ciclo de tres saltos; `expand_consumption` —
    **pura**, no escribe — como contrato publicado para `orders`
    (rendimientos, `recipe_effect` y modo de preparación ya resueltos,
    líneas del mismo insumo fusionadas, sustituto resuelto por el único
    camino de `inventory.hooks`).
  - **`backend-consumo`** (`app/orders/**`, `app/reports/**`, dueño único de
    `app/main.py`/`app/core/models_registry.py`/`NOTIFICATION_TYPES`/
    `docs/ESTADO.md`, Alembic `0010`): **paso 0** — agregó `"inventory"`/
    `"recipes"` a `DOMAINS`/`MODEL_MODULES` (ninguno de los dos estaba
    montado en la API real hasta acá, confirmado por los propios entregables
    de `backend-inventario`/`backend-recetas`). Consumo teórico enganchado en
    `app.orders.service._apply_send` (llama `_freeze_item_consumption` por
    ítem, `ref_type="order_item"`): congela `unit_cost`/`recipe_version`/
    `cost_source` (columna nueva) en el ítem y escribe el consumo vía
    `record_movement(cause=SALE)` — un solo camino para venta, cortesía y
    `staff_meal`. `WasteStub.ingredient_id` pasa a FK real (migración `0010`)
    y se resuelve contra el libro al anular (`void_item`/`void_order`,
    `resolved=True` siempre, insumo por insumo, varias filas si hace falta,
    nunca repone). `GET /admin/sales` ganó
    `theoretical_value`/`gross_contribution`/`recipe_coverage_pct`;
    `GET /admin/orders` ganó `courtesies_theoretical_value`; `GET /admin/today`
    ganó las cuatro alertas de la fase. Nombres sin `cost`/`margin` a
    propósito: dos invariantes de `tests/audit/test_security_invariants.py`
    (no tocado) barren el OpenAPI de esas rutas de *admin* buscando esas
    subcadenas — decisión declarada en `outputs-2a/backend-consumo.md §5`.
    Detalle completo, con los números de línea, en
    `features/fase-2-costo-inventario/outputs-2a/backend-consumo.md`.
  - **Ronda 2 del conciliador (2026-09-16), `backend-consumo`** — cierra
    **B-1** (bloqueante) y su mitad de **B-2**:
    - **B-1 — la nota «vuelve» ahora SÍ revierte de verdad.** La ronda 1 había
      dejado el espejo (`app.orders.hooks.reverse_item_consumption`)
      construido y probado, pero **sin conectar** — nadie lo llamaba. Esta
      ronda amplía `app/fiscal/**` (territorio asignado SOLO para esto) y
      conecta: `NoteLineIn` gana `returns_to_stock: bool = True` (§3.5:
      "se usó" es la EXCEPCIÓN marcada, "vuelve" es el default);
      `app.fiscal.service.issue_note` llama
      `app.orders.hooks.reverse_item_consumption` por cada línea con
      `used=True and returns_to_stock=True`, después de `emit_and_apply` y
      antes de marcar `original.status="reversed"`; una nota `kind="debit"`
      fuerza `returns_to_stock=False` en TODAS sus líneas (cobra más, nunca
      devuelve producto), ignorando lo que mande el cliente, sin devolver
      `400`. `NoteOut` gana `returned_to_stock_item_ids`. `issue_note` ahora
      devuelve `(FiscalDocument, list[int])`; único caller
      (`app.fiscal.router.post_note`) actualizado. 6 tests nuevos en
      `tests/fiscal/test_notes.py` (default `True` revierte exacto;
      `returns_to_stock=False` no revierte y no escribe `NOTE_RETURN`; ficha
      cambiada entremedio → vuelve lo del LIBRO, no lo de la ficha de hoy;
      mismo `Idempotency-Key` dos veces → una sola reversión, confirmado con
      `run_idempotent`, no asumido; `inventory.perpetual` apagada → `201` sin
      movimientos ni excepción; nota débito → nunca revierte aunque se lo
      pidan). `tests/audit/test_consumption_invariants.py::
      test_a_note_that_returns_the_dish_reverses_the_consumption_end_to_end`
      (territorio del auditor, no tocado) es el mismo invariante por el
      camino HTTP real — debería estar en verde ahora.
    - **B-2 (mitad de este agente) — "el cero mudo congelado" en los
      reportes.** `order_items.unit_cost` (pesos, redondeado half-up POR
      ÍTEM) es correcto para un ítem individual, pero
      `app.reports.service._document_cost_stats` sumaba `unit_cost * qty`
      en PESOS a través de muchos documentos/ítems — un plato de $0,30 de
      costo teórico congela (correctamente) `unit_cost=0`, y sumar cientos
      de esos daba `theoretical_value=0` en vez de la plata real. Se agregó
      `order_items.unit_cost_micros` (`BigInteger`, nullable — **no**
      `Integer`: un costo de $10.000 ya son 10^10 micros, fuera de rango de
      32 bits), ampliando la MISMA migración `0010` (no se creó una `0011`:
      `tests/audit/test_migration_invariants.py:391` fija `head=="0010"`).
      `_freeze_item_consumption` llena `unit_cost`/`unit_cost_micros`/
      `cost_source` siempre juntos. `_document_cost_stats` ahora devuelve
      MICROS (no pesos); `aggregate_sales` acumula
      `_Bucket.theoretical_cost_micros` a través de TODOS los documentos del
      bucket/total y convierte a pesos con `micros_to_pesos` una sola vez, en
      `_to_out` — nunca por documento ni por ítem. El tipo publicado de
      `theoretical_value` en `/admin/sales` no cambió (sigue `int` de pesos).
      `order_items.unit_cost` no cambió de semántica ni de tipo (los
      invariantes verdes del auditor que lo fijan en pesos enteros siguen
      intactos). 2 tests nuevos en `tests/reports/test_cost.py` (100 platos
      de $0,30 dan $30, no $0; el caso `== 1000` de
      `tests/audit/test_cost_invariants.py` sigue exacto).
    - **Hallazgo colateral, corregido, fuera del alcance nominal de B-1/B-2**:
      al verificar, `tests/reports/test_sales.py` (5 tests) y dos tests
      preexistentes de `tests/reports/test_cost.py` fallaban por una
      dependencia de reloj real preexistente, no por B-1/B-2 — usaban
      `date.today().isoformat()` como rango de `/admin/sales`, pero
      `business_date` (`app.core.tz`, cutoff de sede) puede quedar un día
      detrás de la fecha calendario UTC durante varias horas cada día
      (Bogotá es UTC-5); la sesión corrió cerca de la medianoche UTC y lo
      hizo evidente. Se reemplazó por el rango ancho fijo `2020-01-01`/
      `2099-12-31` que ya usa `tests/audit/test_cost_invariants.py` — mismo
      patrón, cero dependencia de la hora real. Confirmado con
      `git blame`/lectura que la lógica de `business_date` no cambió en
      ninguna ronda de este agente: es un defecto preexistente de los tests,
      no del código de producción.
- **Decisiones de implementación que todo servicio nuevo tiene que conocer**:
  - `app.core.db.UTCDateTime` en todo `Mapped[datetime]` (SQLite devuelve *naive*
    al leer `DateTime(timezone=True)`).
  - `get_db` hace **commit** también ante `AppError`: un contador de PIN fallido
    tiene que sobrevivir a su propio 400. Consecuencia: validar antes de escribir.
  - `current_device` = dispositivo activado, persona **opcional** y sin renovar su
    ventana; `current_operator` = persona **obligatoria** y vigente, única que
    renueva la ventana deslizante.
  - `run_idempotent` guarda un error de negocio como respuesta resuelta.
  - `multi_store` no gatea `GET /admin/stores` (selector de interfaz); `UvtValue`
    es por organización.
  - **`app.core.modules.find_spec_safe(name)`** (nuevo en 1b-1): reemplaza el
    `importlib.util.find_spec(name)` crudo en todo punto que pregunta "¿existe
    este dominio todavía?". `find_spec("app.payments.router")` importa primero
    el paquete padre (`app.payments`) para resolver su `__path__`; si ese
    paquete existe (tiene `__init__.py`, aunque el archivo puntual falte)
    devuelve `None` sin drama — así funcionó siempre en 1a, porque un dominio
    ausente durante la construcción en paralelo YA tenía su carpeta. Pero si el
    paquete no existe en absoluto (ni carpeta, como pasó con `app/payments` y
    `app/fiscal` en un punto de la construcción de 1b-1) `find_spec` no
    devuelve `None`: lanza `ModuleNotFoundError` y tumba el arranque de toda la
    API. `find_spec_safe` atrapa esa excepción. Usado en `app/main.py`
    (`DOMAINS`), `app/core/models_registry.py` (`MODEL_MODULES`) y
    `app/shifts/hooks.py`/`service.py`; cualquier dominio nuevo que agregue su
    propio `find_spec` sobre un módulo de otro dominio que puede no existir
    tiene que usar este helper, no `importlib.util.find_spec` directo.

## Dónde retomar

1. **Verificación final del pedido 1a** (2026-09-14, árbol quieto, en serie):
   mypy limpio; suite de backend completa **214 passed, 0 failed** (SQLite,
   8 min); `tsc` limpio; vitest 61/61; `vite build` OK; Alembic desde cero
   `0001 → 0002 → 0003` y seed idempotente. El CI del repo debería estar en verde
   con esto; no se pudo ejecutar acá (sin runner ni Postgres local).
2. **Verificación final del pedido 1b-1** (2026-09-15, orquestador humano,
   árbol quieto, en serie, después de corregir B-1): `python -m mypy app` limpio
   (67 archivos); suite de backend completa **377 passed, 0 failed** (SQLite, 15 min); `tsc` limpio;
   vitest **129/129** (34 archivos); `vite build` OK; Alembic desde cero
   `0001 → 0005` (45 tablas), seed idempotente y `downgrade base` limpio.
   Sin Conciliador ni `ENTREGA.md`: el run `wf_1ee5978f-ad4` quedó pausado al
   terminar la construcción; se puede retomar con `resumeFromRunId` (los seis
   constructores se reutilizan de caché y corren sólo Conciliador, ajustes y
   entrega), o darlo por cerrado con esta verificación — el contrato de
   coherencia lo cubrió el auditor y este cierre.
   **Recorrido en navegador real** (2026-09-15, Playwright sobre Chromium, base
   recreada desde cero: `alembic upgrade head` + `python -m app.seed`): activar
   dispositivo (PIN de sede) → «Quién opera» (Operador 1, PIN propio) → abrir
   turno con conteo por denominación (base fija $200.000) → Mesas → abrir Mesa 1
   con 2 comensales → comanda con modificador **obligatorio** (punto de la carne)
   y dos platos → enviar a cocina (ronda numerada) → Cuenta/Cobrar con pregunta
   de propina → pago en efectivo → **documento equivalente POS-000001** → la mesa
   vuelve a `libre`. La plata cerró en pantalla contra la matemática del backend:
   venta $80.000 con precios impuesto incluido → base $74.074 e **INC 8 %
   $5.926** discriminados, propina sugerida 10 % sobre la base neta **$7.407**,
   total a cobrar $87.407, recibido $100.000, vuelto **$12.593**. Respuestas
   observadas: `201 POST /orders`, `200 POST /orders/{id}/items`,
   `201 POST /orders/{id}/payments` (emitió la fila de `fiscal_documents`).
   Esto cierra el último punto de la lista 9 para 1b-1; lo que sigue sin poder
   probarse acá es Postgres real y el CI.
3. **Verificación final del pedido 1b-2** (2026-09-15, orquestador humano, árbol
   quieto, en serie, después de cerrar los tres rojos que declaró la entrega):
   `python -m mypy app` limpio (89 archivos); suite de backend completa
   **538 passed, 0 failed** (SQLite, 26:12) —la corrida previa a los arreglos
   daba **2 failed, 536 passed**, exactamente los dos que `ENTREGA.md § 5`
   declaraba, así que el reporte del Maestro era honesto—; `tsc` limpio; vitest
   **184/184** (48 archivos); `vite build` OK; Alembic desde cero `0001 → 0007`
   (**53 tablas**) y seed idempotente. Las 893 advertencias `Duplicate Operation
   ID` de cada corrida desaparecieron al quitar el doble montaje de routers.
   **Recorrido en navegador real** (Playwright sobre Chromium, base recreada
   desde cero): venta completa de mesa → **documento equivalente POS
   `DEVPOS-000001`** con **Estado DIAN «Pendiente de transmisión»** y la leyenda
   que ahora manda el servidor; el documento quedó con `fiscal_range_id` apuntando
   al rango real y el rango consumió exactamente un número (1/5000). Una segunda
   venta emitió `DEVPOS-000002`: **el consecutivo avanza sin huecos**. En el
   admin se recorrieron Hoy, Ventas, Documentos fiscales, Rangos de numeración,
   Notas, Devoluciones pendientes, Clientes y Pedidos. La matemática de Hoy
   cerró contra el backend con dos ventas: netas **$148.148** ($160.000 cobrados
   − $11.852 de impuesto), ticket promedio $74.074, ticket por comensal $37.037
   sobre 4 comensales, efectivo esperado $360.000 (base $200.000 + lo cobrado) y
   **propinas $14.814 por fuera del neto** — el invariante de que la propina
   nunca entra en el `net` de un reporte, visto en pantalla.
   **Defecto encontrado en el recorrido y corregido** (nadie del equipo lo vio,
   y es la misma lección de reparto): `frontend/src/features/auth/LoginPage.tsx`
   navegaba a `/admin/features` escrito a mano, así que aunque `router.tsx` ya
   mandaba el índice de `/admin` a «Hoy», el administrador seguía aterrizando en
   «Funciones» después de entrar. Ahora navega a `/admin` y decide el índice del
   router, que es el único lugar donde debería decidirse.
4. **Abierto por decisión del dueño de la spec** (advertencias del auditor, en
   `features/fase-1a-cimientos/outputs/ENTREGA.md § 5.4`) — **O-1, A-7 y A-9
   resueltos por default en 1b-1** (ver «Qué está hecho»; `backend-base`):
   sigue abierto A-1 (tope de intentos en `/auth/authorize`); A-2 (validar
   `JWT_SECRET` en producción); A-4 (esperado calculado para turnos abiertos en
   `GET /admin/shifts`); A-6 (idempotencia en `cash-swaps` y reversa de
   retiro); A-8 (`SAVEPOINT` en vez de `rollback()` ante `IntegrityError`).
5. **Gaps declarados por los constructores** (`ENTREGA.md § 5.5`): motivo en
   `DELETE /admin/shifts/{id}`; `close_cause` y base de apertura en el listado de
   turnos; quitar opciones de modificadores y grupos de combos (API y UI);
   agregar grupos a un combo existente desde la UI; tests de las pantallas de
   configuración, personal, auditoría y notificaciones; `shadcn` a
   `devDependencies`; token `--warning`.
6. **Corrección al contrato interno para 1b**: cada hook cruzado entre territorios
   lleva dueño del test de punta a punta, y la fixture `race_app` es la común para
   carreras (ya está en `tests/conftest.py`). Patrón registrado en
   `docs/PATRONES.md` del framework (2.1.0).
7. **Hallazgos del auditor de 1b-1, saldados por 1b-2** (detalle en
   `features/fase-1b-venta/outputs-1b-1/auditor-venta.md § 3`): **A-11**
   (leyenda legal a mano en el cliente) **cerrado** —viene del servidor y sigue
   el estado DIAN—; **A-12** (`prorate` asignando a una línea más de lo que
   pesa) **cerrado** con tope por línea y test de propiedad; **O-1**
   (`Math.round` silencioso en `DiscountDialog.tsx`) **cerrado**. **A-10 quedó
   a medias y sigue abierto**: `amount_due` lo manda el servidor **sólo después
   de cobrar** (`PaymentOut`), así que antes de cobrar `PaymentTargetPanel.tsx`
   todavía arma el objetivo como `venta + propina` —lo que se *muestra* ya no
   se deriva, lo que se *cobra* sí—. Cerrarlo del todo es `amount_due` en
   `PreBillOut`/`OrderOut.totals`/`SubAccountOut.totals`: `app/orders/schemas.py`
   no tuvo dueño en 1b-2 y hay que asignárselo a alguien. Sigue abierto **O-2**
   (el `stripComments` del auditor de 1a colapsa saltos de línea y corre los
   `archivo:línea`).
8. **Gaps declarados por los constructores de 1b-1** (cada `outputs-1b-1/*.md`
   § gaps). **Cerrados por 1b-2**: la ruta de dispositivo para los medios de
   pago habilitados de la sede (`GET /device/payment-methods` — no era
   prolijidad: con seis códigos fijos el POS podía emitir un documento con un
   medio que la sede deshabilitó) y la centralización de `TAX_RATE_BY_CODE` en
   `app/core/tax.py`. **Siguen abiertos**: `PinPad` compartido escucha el
   teclado a nivel de `window` sin filtrar por foco (se cuela en cualquier
   input visible; `frontend-cobro` lo mitigó en su código sin tocar el
   componente) — el Maestro de 1b-2 decidió explícitamente no meterlo porque
   ninguna pantalla suya era del POS con PIN; `document-print.css` tiene
   58/72/80 mm pero no hay configuración de sede para elegir el ancho (misma
   razón: habría abierto Configuración sin dueño); división por ítems con UI de
   armado manual, sin derivar grupos por asiento aunque `pos.seats` esté
   activa; tras unir comandas, las rondas históricas de la origen no se listan
   en la destino — **los reportes ya no se ven afectados** (p50/p90 se leen de
   `OrderItem.sent_at`), la vista de cocina en vivo sí; `OrderPage` no tiene
   botón propio de dividir ni acción «quitar descuento»; el tiempo transcurrido
   de mesas se calcula con el reloj del dispositivo.
9. **Abierto por el auditor y el Maestro de 1b-2** (detalle en
   `features/fase-1b-venta/outputs-1b-2/ENTREGA.md § 5` y
   `outputs-1b-2/auditor-fiscal.md`). Lo único que pide **decisión del dueño de
   la spec**: **A-1** la supresión de habeas data no alcanza `pending_refunds`
   —nombre y documento del titular sobreviven ahí, también después de saldada, y
   se exportan por CSV—; hay una tensión real (hay que saber a quién pagarle)
   pero no hay obligación de conservación que la justifique una vez pagada. La
   recomendación del Maestro: anonimizar las saldadas, conservar las pendientes
   mientras lo estén, y declarar por qué. Lo demás es trabajo: **A-3**
   `GET /admin/fiscal/documents` filtra por estado pero no por tipo, y la
   pantalla lo suple en el cliente sobre una lista sin paginación; **R-5**
   cinco de los diez listados nuevos sirven CSV leyendo `request.query_params`
   en vez de declarar `format` en el contrato, así que el OpenAPI no lo publica;
   **O-3** `FiscalDocument.customer_id` sigue `Integer` sin FK dura (la razón
   que lo justificaba —`customers` fuera de `MODEL_MODULES`— ya no existe: hoy
   es una migración de una línea); **O-4** fiscal y clientes importan su copia
   local del filtro de fechas y del botón de CSV aunque los compartidos ya
   existen; y `invoice_threshold_uvt` **no es editable desde ninguna pantalla**
   aunque la spec lo define como configuración de sede.
10. **La fase 1b está completa**: 1b-1 (comanda y cobro) y 1b-2 (documento
   fiscal, clientes, devoluciones y reportes) construidos y verificados. El
   restaurante opera de punta a punta. Lo que sigue es la **fase 2**, que es lo
   que 1b dejó explícitamente afuera y para lo que ya hay ganchos sembrados:
   recetas y fichas técnicas, preparaciones y lotes, inventario con mermas y
   conteos, compras y cuentas por pagar, y el costo real de la venta —hoy el
   ítem congela `unit_cost` y `recipe_version` en `null`, `send` crea la fila de
   consumo pendiente vacía, y `void` de un ítem enviado crea la merma con
   cantidad y sin insumo—. `AGENTS.md` ya anticipa que el Maestro puede
   necesitar un rol nuevo de **especialista en inventario y costos**.
   **La spec está escrita**: `features/fase-2-costo-inventario/spec.md`, y por el
   mismo motivo que 1b se parte en dos —**2a** insumos, preparaciones, fichas
   técnicas, libro de movimientos, consumo teórico al enviar y mermas; **2b**
   compras y cuentas por pagar, lotes de compra, conteos a ciegas, varianza,
   food cost real y salud del control—. El corte no es arbitrario: el consumo
   teórico de 2a es contra qué comparar un conteo de 2b, el `prep_batch` que
   produce una preparación es una entidad distinta del `stock_batch` que crea
   una recepción, y el costo del insumo en 2a sale de «oficial» o «estimado»
   mientras 2b agrega los otros dos escalones de la jerarquía. **Domicilio,
   plataformas, KDS y la conexión real con el proveedor tecnológico** están en
   la fila «fase 2» de la tabla §14 de la spec de negocio pero no tienen nada
   que ver con costo ni inventario: van en su propio pedido, no acá.
   **2a arranca ahora** (2026-09-15), sobre el commit de esta anotación:
   ```js
   Workflow({
     scriptPath: '.claude/workflows/orquestador-general.js',
     args: {
       pedido: '<la mitad 2a, delimitada contra lo que 1a y 1b ya construyeron>',
       spec: 'features/fase-2-costo-inventario/spec.md',
       outputs: 'features/fase-2-costo-inventario/outputs-2a',
       contexto: ['docs/ESTADO.md', 'AGENTS.md', 'docs/SPEC-NEGOCIO.md'],
       base: '<commit de esta anotación>',
     },
   })
   ```
   **Lección de reparto que el próximo pedido tiene que usar** (`ENTREGA.md
   § 7`): los tres rojos de 1b-2 cayeron, los tres, en archivos que no estaban
   en el territorio de ningún agente (`app/seed.py`, `tests/core/**`,
   `frontend/src/features/settings/**`). El reparto debe incluir, además del
   territorio, una lista explícita de **archivos huérfanos con dueño asignado**;
   y cuando un mandato acotado toca un modelo compartido, hay que asignarle
   también su esquema de entrada, sus tests y la pantalla que lo edita, o el
   campo queda escrito a medias en tres capas.

11. **Verificación final del pedido 2a** (2026-09-16, orquestador humano, árbol
   quieto, en serie): `python -m mypy app` limpio (**106 archivos**); suite de
   backend completa **770 passed, 0 failed** (SQLite, 36 min); `tsc` limpio;
   vitest **280/280** (68 archivos); `vite build` OK; Alembic desde cero
   `0001 → 0010` (**63 tablas**) y seed idempotente. La corrida previa a los
   arreglos daba **9 failed, 761 passed**, exactamente los nueve que
   `ENTREGA.md § 5` declaraba: el reporte del Maestro volvió a ser honesto.
   **Los nueve cerrados**, y el más importante no era un bug de código:
   - **Tres invariantes heredados barrían el OpenAPI entero** buscando la
     subcadena `cost`. Se llamaban «device responses» y citaban «el operador no
     ve costos» — y pedían con `admin_client`. Eran correctos mientras el
     producto no tenía superficie de costo para el administrador; 2a existe para
     construir esa superficie, así que la prohibían por existir. **Un guard
     inesquivable no se discute, se esquiva**: dos constructores publicaron
     `theoretical_value`, `gross_contribution` y `recipe_coverage_pct` donde la
     spec pide `theoretical_cost`, `gross_margin` y `costed_pct`, y lo dejaron
     declarado. Se acotaron los tres barridos a lo que la regla dice (rutas que
     no son `/admin/`, y por reporte los campos que 2a agregó a propósito) y
     **volvieron los nombres de la spec**.
   - **La cobertura de recetas** se re-expandía con la ficha de hoy para juzgar
     si una venta pasada descontó algo, y publicaba el nombre actual del plato:
     rompía el snapshot (regla dura) y alimenta la varianza de 2b. Hoy se lee del
     **libro** (`ref_type="order_item"`) y del nombre congelado.
   - **Las cortesías a costo** sumaban pesos ya redondeados por ítem y perdían el
     sub-peso, en `/admin/orders` y en la actividad por persona —que además no
     traía el costo—: las dos suman en micros y convierten una sola vez.
   - **Las alertas de inventario de «Hoy»** preguntaban si el módulo existía, no
     si la función estaba encendida: una sede con `inventory.perpetual` apagada
     veía alarmas que no podía resolver.
   - **La cascada al sustituto** se resolvía sobre una unidad y se multiplicaba
     después: con 400 g en stock y diez platos de 100 g mandaba los 1.000 g al
     insumo principal en vez de repartir 400 y 600. Ahora se resuelve sobre el
     total.
   - **Corrección a la spec de negocio §5.3, no al código**: §5.3 pide fusionar
     los consumos del mismo insumo en una comanda, pero eso choca con el espejo
     exacto de la nota «vuelve» y con el `waste_stub` de un ítem anulado, que
     apuntan a un `order_item` y se resuelven leyendo el libro. Entre integridad
     y conteo de filas manda la integridad: **el libro guarda una fila por ítem**
     y la fusión por comanda pasa a ser una **lectura**, que se construye en 2b.
     Queda escrito en `features/fase-2-costo-inventario/spec.md`.
12. **El repositorio ya tiene despliegue** (2026-09-16). `render.yaml` en la raíz:
   **un solo servicio web** (`main.py` sirve `frontend/dist` con fallback SPA, y
   partirlo rompería el mismo origen que protege la cookie `httpOnly`) más
   Postgres administrado. **No hace falta Dockerfile**: los runtimes nativos de
   Render traen `node` y `npm` también en el de Python, así que el servicio se
   construye el frontend solo. **`main` ya tiene todo el código** (hasta 2a
   estaba sólo en la rama de trabajo; `main` tenía únicamente las specs).
   - **Defecto encontrado al preparar el despliegue, que ningún test podía ver**:
     la app sólo se había corrido contra Postgres con `postgresql+psycopg://`
     escrito a mano en `ci.yml`. Todo host administrado entrega la URL estándar
     `postgresql://`, que SQLAlchemy mapea a **psycopg2** —un paquete que este
     repo no instala—, así que la API no arranca y el error no menciona la base.
     **`app.core.db.normalize_database_url`** le pone el driver que el repo sí
     instala y respeta cualquier URL que ya lo declare (7 tests en
     `tests/core/test_db_url.py`). Quién es el driver lo decide el repo, no la
     consola del proveedor.
   - Dos condiciones del plan gratuito que están anotadas en el propio
     `render.yaml` y que hay que respetar: el servicio web **se duerme** a los 15
     minutos y tarda ~1 minuto en despertar (en una demo, ese minuto en blanco
     decide la venta), y la base **expira a los 30 días** y **no tiene
     respaldos**. Para un cliente real: Postgres pago con point-in-time recovery,
     porque son ventas y documentos fiscales con consecutivo ante la DIAN.
   - `preDeployCommand` no existe en plan gratuito, así que las migraciones
     corren en el arranque; queda anotado cómo moverlas al pasar a pago.
13. **Lo que sigue: el pedido 2b** — compras con proveedores y cuentas por pagar,
   lotes de compra y vencimientos, conteos de críticos y completos a ciegas,
   varianza y food cost real, salud del control. La spec ya está escrita
   (`features/fase-2-costo-inventario/spec.md`) y depende del consumo teórico que
   2a deja construido. **Entradas para su contrato interno**, de
   `outputs-2a/ENTREGA.md § 5`: la escala de cantidades se publica de dos formas
   (`app/reports/schemas.py` en milésimas crudas, `app/inventory/schemas.py` como
   texto decimal) y la primera pantalla que las pinte va a mostrar `117648 g` o a
   dividir por 1.000 en el cliente; el KPI de mermas declara `float`, el único
   número de la fase que no es entero, y hoy siempre es `null`; cinco listados
   sirven CSV leyendo `request.query_params` sin declarar `format` en el
   contrato; `GET /admin/fiscal/documents` filtra por estado pero no por tipo;
   `FiscalDocument.customer_id` sigue `Integer` sin FK dura (hoy es una migración
   de una línea); los insumos no están detrás de ninguna flag; y
   `MovementCause.VOID_AFTER_SEND` está declarada y nunca se produce, así que un
   reporte de merma por anulación agrupado por causa devuelve vacío.
   **Y la lección de reparto de 2a** (`ENTREGA.md § 7`): la regla de nombrar
   dueño para los archivos huérfanos funcionó —ninguno de los nombrados falló—,
   y el único huérfano sin nombrar, `app/shifts/**`, es exactamente donde cayó
   un hallazgo. La lección nueva: **un invariante también tiene territorio y
   también envejece**. Cuando una fase agrega una superficie nueva por diseño,
   hay que listar de entrada los invariantes heredados que la prohíben y
   asignarle a alguien la decisión de acotarlos.
14. Lo que no se pudo verificar en este entorno: Postgres real (tipos, índices,
   `SELECT FOR UPDATE` del consecutivo y los `409` literales de carrera, que
   sólo el CI puede probar), el CI en sí, y WCAG más allá de Testing Library
   (el ítem «POS en 375 px y 1024 px, foco visible, contraste AA» del checklist
   se auditó por inspección de fuente, sin medidor de contraste). Tampoco hay
   **scheduler**: `sweep_contingency_overdue` es un barrido perezoso que corre
   al entrar a Hoy o a la pantalla fiscal, no un cron. Y no hay **proveedor
   tecnológico real**: `GET /admin/fiscal/export` devuelve un manifiesto JSON
   con hash por documento, no un ZIP con XML, porque todavía no hay XML que
   empaquetar.
15. **El pedido 2b arrancó** (2026-09-16), sobre el commit `8116135`, que es el
   que escribe su delimitación. **La spec de 2b ya está escrita**:
   `features/fase-2-costo-inventario/spec.md § Alcance de 2b`, con su contrato
   de API, sus invariantes heredados y un checklist de entrega de 30 puntos.
   ```js
   Workflow({
     scriptPath: '.claude/workflows/orquestador-general.js',
     args: {
       pedido: '<la mitad 2b, delimitada contra lo que 1a, 1b y 2a construyeron>',
       spec: 'features/fase-2-costo-inventario/spec.md',
       outputs: 'features/fase-2-costo-inventario/outputs-2b',
       contexto: ['docs/ESTADO.md', 'AGENTS.md', 'docs/SPEC-NEGOCIO.md',
                  'features/fase-2-costo-inventario/outputs-2a/ENTREGA.md'],
       base: '8116135',
     },
   })
   // run: wf_a4ed1dec-258 — se puede retomar con resumeFromRunId
   ```
   **Tres decisiones de spec que se tomaron al delimitar** y que no estaban
   resueltas antes:
   - **«Reposición» sale de 2b.** La tabla del propio documento la ponía en 2b,
     pero §5.6 de la spec de negocio manda la orden de compra y la sugerencia de
     reposición a fase 3. Manda la spec de negocio y la tabla queda corregida.
   - **La recepción es pantalla de administrador, no del POS.** Lleva precios
     unitarios, base y IVA por línea; el PIN de quien recibe es **atribución**,
     no una sesión de dispositivo. Así la regla dura de que el operador no ve
     costos no se toca. Si alguien quiere recibir desde una tablet del salón,
     eso cambia una regla dura y es decisión del dueño de la spec.
   - **FEFO explícito.** §5.7 dice «toda salida consume el más antiguo», que es
     ambiguo entre fecha de recepción y vencimiento. Queda declarado:
     vencimiento primero, recepción para desempatar. Una elección silenciosa acá
     mueve plata.
   **Sigue abierta la única decisión que espera al dueño de la spec**: A-1 de
   1b-2, si la supresión de habeas data alcanza `pending_refunds`. No bloquea
   2b, pero es deuda legal y no se arregla sola.
16. **Verificación final del pedido 2b** (2026-09-19, orquestador humano, árbol
   quieto, en serie): `python -m mypy app` limpio (**113 archivos**); suite de
   backend completa **970 passed, 0 failed** (SQLite, 46:58); `tsc` limpio;
   vitest **405/405** (89 archivos); `vite build` OK; Alembic desde cero
   `0001 → 0012` (**73 tablas**), seed idempotente y `downgrade base` limpio.
   La corrida previa a los arreglos daba **4 failed, 966 passed**, y los cuatro
   eran **exactamente** los que `outputs-2b/ENTREGA.md § 5` declaraba, con los
   mismos nombres: **tercer pedido seguido en que el reporte del Maestro es
   honesto**.
   **El run se cortó por límite semanal** después de la ronda 2 de los
   constructores, en la ronda 2 del auditor, la conciliación y la ENTREGA. Se
   retomó con `resumeFromRunId` tres días después: los catorce agentes
   terminados volvieron de caché y sólo corrieron los tres que faltaban. El
   mecanismo funciona; lo que hay que recordar es **commitear el árbol antes**,
   no después (acá quedaron 134 archivos sin commitear tres días).
   **Los cinco rojos, cerrados a mano. Tres no eran lo que el informe suponía**:
   - **R-1**: `tests/recipes/conftest.py` montaba el router de recetas por
     segunda vez. Su guard sólo evitaba montarlo dos veces **desde ahí**; no
     preguntaba si el dominio ya estaba en `DOMAINS`, que es justo lo que sí
     hace su vecino `tests/inventory/conftest.py`. **Es la regresión que el
     commit `228747b` ya cerró una vez en 1b-2** y que volvió con el dominio
     nuevo de 2a. Producía dos rojos, y sólo se ve con la suite entera en un
     proceso. La app real no tenía rutas duplicadas: era la instalación de
     tests.
   - **R-2**: el test de lotes derivaba su `today` de UTC mientras el servidor
     usa la fecha de negocio de la sede. **El código de producción estaba bien;
     el test violaba la regla dura de zona horaria**, y era rojo 11 horas por
     día (00:00–10:59 UTC). Un CI nocturno habría fallado todas las noches.
   - **R-3**: el `days=14` del seed **no era el umbral repetido a mano**. Es el
     conteo completo de apertura de la ventana de food cost real, y coincidía
     con `INVENTORY_STALE_DAYS` por casualidad, justo sobre su borde. El remedio
     que proponía el auditor (`INVENTORY_STALE_DAYS - 7`) lo habría puesto a 7
     días, **encima de la compra sembrada**, rompiendo la ventana. Quedó como
     `SEED_OPENING_FULL_COUNT_DAYS_AGO = 21`, con escrito que no tiene relación
     con el umbral.
   - **R-4**: tocaba **cuatro** archivos, no tres. Sacar `void_after_send` del
     cliente rompe también el test que afirmaba que el desplegable contiene
     «Anulación tras envío». Y la lista a mano del invariante heredado se
     **borró** en vez de parchearse: exigía una causa que 2b sacó y no exigía la
     que 2b agregó, así que daba **a la vez** un rojo imposible de cerrar y un
     verde falso. La reemplaza el cruce genérico que lee
     `app/inventory/schemas.py::MovementCauseLiteral` en las dos direcciones.
   - **R-5**: `getByRole` síncrono sobre el popup de un portal, mismo patrón que
     `WastePage.test.tsx`.
   **Y dos comentarios que describían un árbol que ya no existe**:
   `api/inventory.ts` anunciaba como GAP abierto el `500` que la ronda 2 cerró;
   `api/reports.ts` decía que el backend **no** usa
   `theoretical_cost`/`gross_margin`/`costed_pct` cuando las tres propiedades
   declaradas seis líneas más abajo se llaman exactamente así — el fósil de la
   deformación de contrato de 2a. Completado también
   `tests/recipes/_inventory_stub.py`, que declaraba diez causas contra once.
17. **La lección de 2b, para el próximo reparto.** Nombrar dueño a los archivos
   huérfanos **volvió a funcionar**: once nombrados, ninguno falló. **Lo que
   falla es el CRUCE entre dos dueños**, y falla en los dos sentidos: un
   contrato de ida construido sin la mitad de vuelta. El mismo espejo
   backend↔cliente se rompió **cuatro veces** en este pedido, con dueños
   distintos cada vez, y el typecheck no vio ninguna:
   - **H-0** (bloqueante): `inventory` agregó la causa nueva al **modelo**
     porque la spec se lo pidió, `purchases` la **produjo** porque la spec se lo
     pidió, y **nadie era dueño del `Literal` publicado** —que vive en
     `inventory` pero sólo se rompe cuando `purchases` escribe—. Revertir una
     recepción dejaba el libro de ese insumo ilegible con un `500`.
   - **H-8**: el backend **agregó** una causa y el cliente no tenía etiqueta.
   - **H-11**: el backend **quitó** una causa y el cliente dejó la etiqueta, así
     que el desplegable ofrecía un filtro que el servidor rechaza con `422`.
   - **R-4 bis**: dos invariantes del propio auditor, contradictorios entre sí.
   - **H-2** es el mismo patrón sin culpa de nadie: `orders` e `inventory`
     construyeron la **misma** ruta porque la spec la menciona en la sección de
     `inventory` y el dato vive en `orders`. Los dos creyeron que era suyo.
   **La regla para el próximo pedido: cuando una capacidad cruza dos dominios,
   el reparto tiene que nombrar el CONTRATO, no sólo los archivos** — quién
   publica, quién llama, y **qué pasa cuando se deshace**. Y el invariante
   barato que lo cobra ya está probado: uno que **lee el contrato del otro lado**
   en vez de repetir una lista a mano.
18. **Abierto al cerrar 2b. Lo que pide decisión del dueño de la spec:**
   - **O-5 — el monto de la cuenta por pagar no se arma con los números de la
     factura.** `app/purchases/service.py` calcula `Σ (cantidad facturada ×
     precio) + IVA`, no `Σ (base + IVA)`, que es lo que dice el papel. Con
     precios redondos coinciden; con una factura que redondea, **el número que
     el administrador aprueba difiere en pesos del documento que tiene en la
     mano**. Recomendación: manda el papel, y si `cantidad × precio` no coincide
     con el total facturado, **esa diferencia es lo que el control tiene que
     mostrar**, no algo que el sistema tape recalculando por su cuenta.
   - **«Sostenido» del semáforo rojo** (§5.4: «> 4–5 sostenido rojo»): hoy hay
     semáforo por conteo individual. La spec no lo define con precisión
     suficiente para implementarlo sin inventar el criterio.
   - Sigue abierta desde 1b-2: si la supresión de habeas data alcanza
     `pending_refunds`.
   **Lo que es trabajo, priorizado:**
   - ~~**`GET /admin/payables/{id}/payments` no existe.**~~ **CERRADO** el
     mismo día (ver punto 19).
   - `GET /admin/suppliers` no declara `format=csv`; las guardas de tecleo no
     devuelven el valor de referencia estructurado; `PayableOut`/`ReceptionOut`
     no traen `supplier_name`; los filtros de «Hoy» → Cuentas por pagar no están
     enganchados.
   - **O-6, que conviene documentar antes de que alguien lo lea como un bug**:
     los lotes y el libro **se separan hacia abajo por diseño**. FEFO consume
     lotes en cada salida, pero **ninguna entrada que no sea una compra crea
     lote**: una nota «vuelve» y un ajuste de conteo positivo suben el saldo del
     libro y no devuelven nada a los lotes. `Σ qty_remaining` queda por debajo
     de `current_stock` y `GET /admin/lots` sub-reporta. **Nadie debe sumar
     lotes para cuadrar un conteo.**
   - El bundle del frontend pesa 1,22 MB en un solo chunk (340 kB gzip), sobre
     el umbral de aviso. Sin code splitting.
   **Lo que este entorno no puede cerrar**: Postgres real (la atomicidad de la
   recepción se probó con un fallo **inyectado**, no con una carrera; faltan
   `SELECT FOR UPDATE`, índices parciales y los `409` de concurrencia), el CI, y
   el renglón **#29** del checklist (1024 px sin scroll horizontal, foco
   visible, contraste AA con un medidor real) — **el único de los 30 que cierra
   como no cubierto**, y viene abierto desde 1a. Tampoco se recorrió 2b en
   navegador real. Dos cosas que ahí se van a ver raras y **no son bugs**: la
   primera recepción de un insumo con costo oficial puesto se corta con
   `409 PRICE_JUMP` si el precio real se aparta más de 15 % (la guarda pregunta,
   no corrige), y **el perfil `standard` del seed deja `inventory.variance` e
   `inventory.lots` apagadas**, así que Food cost, Salud del control y Lotes
   responden `400 FEATURE_DISABLED` hasta encenderlas en Admin → Funciones.
19. **Cerrado el hueco de los pagos** (2026-09-19, después del cierre de 2b).
   `GET /admin/payables/{id}/payments` ya existe, y con él la cuenta por pagar
   deja de estar a medias: se podía registrar un pago y anular uno por id, pero
   **no verlos**, así que un administrador que volvía al día siguiente no sabía
   qué se había pagado y **no podía anular nada**, porque el `payment_id` sólo
   había existido en la respuesta del `POST` que lo creó.
   **No era culpa de los constructores: faltaba en el contrato que escribí yo.**
   La spec de 2b queda corregida con la ruta y con el motivo escrito, para que
   la próxima lectura del contrato no repita la omisión.
   - El historial viene del más viejo al más nuevo e **incluye los anulados,
     marcados** con motivo y con **quién anuló** (`voided_by_employee_name`,
     nuevo en `PaymentOut`): anular un pago a proveedor devuelve plata al cajón
     y eso tiene responsable. Esconderlos habría dejado al administrador viendo
     dos pagos contra un saldo calculado sobre otra cosa. El saldo lo sigue
     derivando `payable_balance` de los pagos vivos, que es el único que decide.
   - `include_voided=false` filtra, y **los vivos suman exactamente lo que el
     saldo dice que ya se pagó**: hay un test que lo cobra, porque si esas dos
     lecturas no cierran, una miente.
   - Declara `format` en el contrato publicado, no lo lee de
     `request.query_params` — la regla de 2b, cumplida por la ruta nueva.
   - **La pantalla dejaba ver el rodeo**: `PayableDetailDialog.tsx` guardaba los
     pagos **en memoria de la sesión** y lo decía en pantalla («esta tabla sólo
     muestra los pagos que se registraron con esta pantalla abierta»). Ahora lee
     del servidor, dice cuando no pudo cargar en vez de dibujar una tabla vacía
     que parece «no hay pagos», y muestra el estado de cada pago.
   - De paso, `create_payable` se movió de `test_payables.py` al conftest de
     `tests/purchases/`: dos copias de una fixture se separan sin avisar, que es
     exactamente la lección que este pedido ya pagó cuatro veces.
   **Verificación** (2026-09-19, árbol quieto, en serie): `python -m mypy app`
   limpio (113 archivos); `tests/purchases` **45 passed**; suite de backend
   completa **976 passed, 0 failed** (SQLite, 42:36); `tsc` limpio; vitest
   **408/408** (89 archivos).
