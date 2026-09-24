# Restaurante Sistema — estado del proyecto

Documento de referencia para retomar el trabajo sin reconstruir el contexto.
Última actualización: 2026-09-20 (**FASE 3 CERRADA**: las once capacidades de
«dinero y control» construidas, verificadas y caminadas, **y los tres puntos
que la fase había dejado abiertos —A-3, A-4 y A-5— cerrados también**. Suite de
backend **1.526 passed, 0 failed**; vitest **557/557**; mypy y `tsc` limpios;
build OK. Cadena `0001 → 0021` contra **Postgres 16 real**, una sola cabeza, 93
tablas, seed idempotente y el respaldo de `paid_from` leído de vuelta por el
modelo. El objetivo de la fase, visto funcionando: punto de equilibrio
**$3.049.400** con margen 98,38 % sobre ventas cobradas por la puerta del POS.
Los recorridos en navegador encontraron **siete defectos** que las suites no
vieron, ninguno en código de la fase. Lo que sigue abierto, con dueño y razón,
en los puntos 25 a 31 de «Dónde retomar». Las notas más viejas de esta cabecera
se conservan abajo por su detalle técnico, no por su estado).

**Este documento es VIVO.** Si un cambio altera una regla o un flujo descrito acá,
se actualiza en el MISMO PR que el cambio. Un estado desactualizado miente con más
autoridad que no tener estado.

**Este documento es la BITÁCORA: cómo se llegó hasta acá.** Un agente que va a
construir no necesita leerla —necesita el sistema como está hoy, y eso vive en
**`docs/CONTEXTO-AGENTES.md`** (~20 KB contra los ~78 KB de este archivo). La
separación no es cosmética: el contexto de cada agente se paga por token y por
agente, y en la fase 2c se estaban leyendo ~193 KB por agente × 20 agentes.

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
20. **Pedido anotado, sin construir: activar una tablet con un código QR.**
   Encontrado en el recorrido en navegador del 19-09. La raíz de la app manda
   al login de administrador, y hasta hoy **no había ningún camino visible
   hacia `/pos/activate`**: quien montaba una tablet tenía que adivinar la
   URL. Se cerró con un enlace en el login («¿Es una tablet o un PC del
   salón? Activá este dispositivo»), que resuelve el problema y cuesta tres
   líneas.
   **Lo que queda pendiente es el escalón siguiente**, y sólo vale la pena
   cuando haya un cliente con varios aparatos: que el administrador genere un
   **QR desde Configuración** y lo escanee con cada tablet.
   - **Lo que de verdad resuelve** no es el enlace —ése ya está— sino el
     campo **«Número de sede»**: hoy el dueño tiene que saber que su sede es
     la «1». Es el punto donde la gente se traba, y de hecho ya pasó una vez
     en este proyecto (se tecleó el PIN de seis dígitos en ese campo). Un QR
     que lleve la sede adentro lo elimina.
   - **Lo que hay que decidir antes de construirlo**: el QR **no puede llevar
     el PIN de sede**. Si lo lleva, una foto del cartel pegado en la pared
     activa un dispositivo ajeno, y el PIN de sede es lo único que separa al
     salón de cualquiera con el enlace. Las dos salidas razonables son un QR
     que sólo precargue la sede (y el PIN se sigue tecleando), o un token de
     activación de un solo uso y con vencimiento, emitido desde el admin —
     que es más seguro y bastante más trabajo.
   - **Alcance real**: ruta que acepte la sede por parámetro, generación del
     QR en Configuración, y —si se elige el token— tabla, emisión, consumo y
     expiración. No es una pantalla: es una capacidad.
21. **Recorrido en navegador real de 2a y 2b** (2026-09-19, Chromium sobre la
   app servida desde `frontend/dist`, contra **Postgres** con la base sembrada
   desde cero). Es el renglón **#29** del checklist —«1024 px sin scroll
   horizontal, foco visible»— que venía abierto desde 1a, y el primer recorrido
   de las pantallas que 2a y 2b construyeron.
   **Siete defectos, ninguno visible para 1.395 tests.** Los cinco primeros
   están en los puntos 19-20 y en los commits; los dos del final salieron de los
   cuatro caminos de plata:
   - Registrar un pago a proveedor **devolvía `500`**: el `datetime-local` manda
     la hora sin zona. El mismo defecto dormía desde 1b en la hora prometida de
     un pedido para llevar.
   - **Ningún diálogo tenía alto máximo ni scroll**: a 1024×800 el detalle de
     una cuenta por pagar salía de la pantalla y el botón «Anular» era
     inalcanzable.
   - **Nueve selectores** pintaban el código (`cash`, `key_items`, `all`,
     `business_date`, `org`) en vez del texto.
   - **Seis insumos del seed** tenían la alerta de mínimo apagada por un
     error de escala.
   - La cronología del turno decía **«Egreso (supplier_payment)»**.
   - **El cero pegado, otra vez**: teclear sobre los campos de impuesto de una
     recepción daba «062400», «08», «04992». Es el mismo que apareció contando
     efectivo en el POS. `MoneyInput` no podía arreglarlo en el `onFocus`
     porque al enfocar CAMBIA lo que muestra y React borra la selección.
   - **No había camino visible desde el login hasta activar un dispositivo.**
   **Los cuatro caminos de plata, verificados contra la base:**
   - **Venta que mueve inventario**: dos gaseosas vendidas desde un teléfono →
     **una fila del libro por ítem**, cada una atribuida a su `order_item` (la
     corrección a §5.3, funcionando), stock 0 → −2 sin bloquear la venta (§5.2),
     y el ítem con `unit_cost=2500` y `recipe_version=1` **congelados**.
   - **Recepción desde la pantalla**, con PIN de quien recibió: movimiento
     `PURCHASE` +24, lote, cuenta por pagar en `pending_review` y stock −2 → +22,
     todo en una transacción. **El IVA bajo INC entró al costo**: $2.600 +
     $4.992÷24 = **$2.808**, y el `payable` dio $67.392 = la factura.
   - **Conteo a ciegas**: la pantalla muestra el conteo ANTERIOR y no el stock
     teórico (que era −1529,412 y no aparece por ningún lado), no existe ningún
     «todo coincide», el guardado parcial se declara, y aplicar dice al usuario
     la fórmula exacta y que se hace una sola vez. Los ajustes salieron −205 g y
     +1.529,412, dejando el stock en lo contado, con `ref_type=stock_count`.
   - **Varianza**: `inicial + entradas − final = uso real` cierra, se valoriza
     con el origen del costo, y el caso de **fuga pura** —205 g de uso real sin
     uso teórico— sale **Rojo** con el porcentaje en «—», no en `0`. Era el
     hallazgo H-5 del auditor, cerrado de verdad.
   - **Merma desde el POS**: con responsable, sin ningún costo en pantalla, y en
     el libro con `ref_type=waste`.
   **Dos observaciones menores, sin arreglar:**
   - Varias pantallas **piden el endpoint de una función apagada** y reciben un
     `400 FEATURE_DISABLED` que manejan bien en la UI, pero que ensucia la
     consola (visto en «Salud del control» y en Merma, las dos con
     `catalog.preps` apagada). Un `400` esperado enseña a ignorar los `400`.
   - `/admin/features` es la única ruta del admin en inglés; el resto está en
     español (`/admin/hoy`, `/admin/compras`, `/admin/carta`).
   **Y una decisión de producto que dejo planteada, no tomada**: los tres campos
   de impuesto de la recepción arrancan en **cero** en vez de vacíos. En una
   pantalla de transcripción un cero precargado invita a saltear el impuesto, y
   bajo INC eso subestima el costo del insumo. Cambiarlo rompe seis tests que
   codifican el cero como deliberado, así que es del dueño de la spec.

22. **Verificación final del pedido 2c y cierre de H-3** (2026-09-20, orquestador
    humano, árbol quieto, en serie). Números medidos, no estimados:
    `python -m mypy app` limpio (**123 archivos**; 127 después del paso 0 de la
    fase 3); suite de backend **1.226 passed + 1 failed** en 54:32, y ese único
    rojo era el poste de la cadena de Alembic, corregido y reverificado aparte
    (12/12); `tsc` limpio; vitest **493/493** en **100 archivos**; `vite build`
    OK (2.571 módulos). **Y por primera vez la cadena de migraciones se verificó
    contra Postgres 16 real, no sólo SQLite**: `0001 → 0016` limpio, **80 tablas**
    contando `alembic_version` (79 de dominio), `alembic heads` con **una sola
    cabeza**, `downgrade base` deja el esquema vacío, y `python -m app.seed`
    corrido **dos veces** deja 1 organización, 1 sede, 6 empleados, 21 productos.
    Esa es exactamente la verificación que faltó en la fase 2 y que dejó la fase
    entera sin poder desplegarse.

    **El rojo que destapó el cierre de H-3, y por qué el arreglo no fue parchear
    tests.** Extender la guarda de `create_order` a `delivery`/`platform` puso en
    rojo **nueve invariantes** de 2c: la sede de prueba nacía con
    `["counter", "dine_in", "takeout"]` —los tres canales que se gateaban antes—
    así que todo test que vendía por los canales nuevos recibía
    `400 CHANNEL_DISABLED`. Agregarle `activate_channels(...)` a cada test habría
    funcionado y habría sido el arreglo equivocado: el problema no eran nueve
    tests, era **un default**. La sede de prueba ahora es una **sede ya
    configurada** (los cinco canales), que es lo que la migración `0016` deja en
    toda sede existente el día del deploy. El único invariante que necesita el
    caso contrario —función encendida y canal apagado, los dos interruptores
    distintos de §9.3— arma esa precondición él mismo con `deactivate_channels`.
    **La lección, escrita para no repetirla: una precondición heredada del default
    de un fixture deja el test verde por la razón equivocada el día que el default
    se mueve.**

    **El segundo rojo fue un invariante haciendo su trabajo.** El test que fija
    `head` a un valor EXACTO existe para que «agregué una migración y me olvidé de
    encadenarla» sea un rojo y no un deploy desalineado. Agregué `0016` y no moví
    el poste; se puso rojo. Movido a `0016`, con el porqué al lado como hicieron
    2b y 2c. El conteo de tablas **no cambia** (79): `0016` toca datos, no esquema.

23. **Framework sistemas-maestros 2.2.0, promovido desde este proyecto.** El
    Conciliador verificaba contra `git diff` en vez de contra el árbol de trabajo.
    Como en este framework **los agentes nunca commitean** —commitea el
    orquestador humano después de revisar—, cuando el Conciliador corre el trabajo
    del equipo está sin commitear, y un dominio nuevo está además **sin trackear**:
    `git status` muestra la carpeta y no los archivos, y `git diff` no lo muestra
    en absoluto. El `DIFF_HINT` anterior afirmaba justo lo contrario («el trabajo
    YA ESTÁ COMMITEADO»), así que en el pedido 2c declaró `coherente: false` con
    **tres bloqueantes que decían «no está commiteado»** sobre ocho archivos que
    existían y estaban completos, y el Maestro lo repitió al repartir ajustes
    porque el prompt le pedía no cuestionar el veredicto. Una ronda entera gastada
    en arreglar algo que no estaba roto. Corregido en tres piezas que van juntas:
    `ARBOL_ES_LA_VERDAD` reemplaza al `DIFF_HINT`; guardrail en `conciliador.md`
    («no está commiteado» nunca es un conflicto); y **una sola excepción** a «no
    modifiques el veredicto del Conciliador»: todo conflicto que afirme que algo
    falta se verifica abriendo el archivo antes de mandar a nadie a rehacerlo.

24. **La fase 3 va en UN SOLO PEDIDO, y el contexto por agente bajó de ~193 KB a
    ~60 KB.** El método por workflow estaba gastando de más por una razón que es
    mía: a cada agente le iban `docs/ESTADO.md` (78 KB de bitácora) y una ENTREGA
    vieja de 21 KB. Ahora va **`docs/CONTEXTO-AGENTES.md`** (20 KB): el sistema
    como está hoy —costuras, contratos numéricos, convenciones, los ocho errores
    que más veces se repitieron—, sin una línea de historia. Este documento sigue
    siendo la bitácora y **no hace falta leerlo para construir**.

    **Antes de lanzar seis agentes leí contra el código las costuras que la spec
    daba por supuestas, y cuatro ya estaban construidas.** Sin decirlo, el equipo
    habría escrito duplicados — y un duplicado de una fórmula de plata es la
    «segunda matemática» que las reglas duras prohíben:
    - **`Shift.to_deposit` ya existe**, escrito al cerrar el turno con la fórmula
      de §6.1 (`contado − base fija − propinas en efectivo`). La spec le pedía a
      T1 derivarlo otra vez. Ahora dice: leelo. Lo que T1 sí deriva es el **saldo**
      (`to_deposit − consignado`), que es lo que no puede ser columna.
    - **`TipPayout`, `TipPayoutDistribution` y `register_tip_payout` existen desde
      1b-2**, con el docstring que dice «el cálculo del reparto es **manual** en
      esta fase». Fase 3 es la fase del cálculo: T3 computa la propuesta y confirma
      por la puerta que ya está, **sin tablas nuevas**.
    - **«Cobro por mesero» ya está**: `GET /admin/sales?group_by=employee` agrupa
      por `charged_by_employee_id` desde 1b-2. No lleva ruta nueva.
    - **El margen bruto ya lo agrega `app/reports/`**: T2 lo lee en vez de volver a
      sumar documentos de venta.

    **Las cuatro decisiones que estaban abiertas quedaron tomadas por escrito** en
    `features/fase-3-dinero-control/spec.md § 1`, con el razonamiento a la vista
    para poder discutirlas después: **D-1** «sostenido» = la brecha de food cost
    supera el umbral rojo en **2 de las últimas 3 ventanas** (con menos de dos,
    `null` con motivo, nunca verde), y **no se toca `_variance_level`**; **D-2** la
    cuenta por pagar guarda **las dos** cifras —`invoice_total` del papel y el
    `amount` calculado— y **nombra la diferencia**, con el patrón `confirm_price`
    que `create_reception` ya usa; **D-3** los tres métodos de reparto, default
    **por horas**, como propuesta que alguien confirma; **D-4** la supresión por
    habeas data **sí** alcanza a `pending_refunds`: anonimiza la identidad y deja
    intacto el asiento, igual que ya se resolvió para el documento fiscal.

    **Paso 0 hecho antes de lanzar** (y una lección propia): los archivos que
    cuatro backends en paralelo se pelearían —`app/main.py`,
    `app/core/models_registry.py`, `app/core/features.py`— los dejó listos el
    orquestador humano, más los cuatro paquetes nuevos. Al hacerlo **se me cayeron
    `"channels"` y `"kitchen"` de las dos listas** por una sustitución con ancla
    demasiado corta; lo agarró `test_seed_is_idempotent` con un «no such table:
    delivery_platforms» treinta segundos después. Por eso el paso 0 se verifica
    con una corrida de humo (`tests/core tests/stores tests/channels tests/kitchen`
    + el invariante de migraciones: 163 passed) antes de lanzar a nadie.

25. **FASE 3 CONSTRUIDA, VERIFICADA Y CAMINADA** (2026-09-20, run
    `wf_daf94f61-089` sobre el commit base `14256d6`; seis agentes —T1 `banking`,
    T2 `expenses`, T3 `payroll`, T4 `analytics`, T5 frontend, T6 auditor—, dos
    rondas, veredicto del Conciliador **coherente**, cero conflictos finales;
    outputs por agente y `ENTREGA.md` en
    `features/fase-3-dinero-control/outputs/`). Las **once capacidades** de la
    fila 3 de §14 en un solo pedido, como pidió el dueño.

    **Verificación final** (2026-09-20, árbol quieto, en serie): `python -m mypy
    app` limpio (**147 archivos**); suite de backend **1.522 passed, 1 skipped,
    0 failed** (1:08:09); `tsc` limpio; vitest **555/555** en 117 archivos;
    `vite build` OK (2.609 módulos). Sobre **Postgres 16 real**: `0001 → 0020`
    limpio, `alembic heads` con **una sola cabeza**, **93 tablas** de dominio,
    `python -m app.seed` corrido dos veces sin duplicar, y `downgrade base`
    deja el esquema vacío.

    **Lo que entró**: consignaciones y saldo por consignar, libro del banco, mano
    del dueño, conciliación de datáfono y de plataformas (dominio `banking`,
    Alembic `0017`); gastos, obligaciones agendadas, punto de equilibrio y
    utilidad del período (`expenses`, `0018` y `0019`); jornada, tablas de
    recargos **con vigencia**, liquidación de nómina y reparto de propinas en los
    tres métodos de D-3 (`payroll`, `0020`, más `app/core/hours.py` con la escala
    entera de las horas); ingeniería de menú, varianza por plato prorrateada,
    reposición sugerida y «sostenido» (`analytics`, **sin modelos a propósito**:
    todo derivado, que es lo que §6.1 pide). Cadena `0001 → 0020` corrida contra
    **Postgres 16 real**: una sola cabeza, **93 tablas** de dominio,
    `downgrade base` deja el esquema vacío, seed idempotente.

    **La honestidad del reporte, otra vez.** La ENTREGA declaró **5 rojos y 8
    conflictos abiertos** en vez de dar la fase por cerrada, y los cinco rojos
    eran exactamente los que yo medí. Dos de ellos eran **míos**: el poste de la
    cadena de Alembic, y su contraparte en `test_contract_2c_invariants.py`, que
    dejé desalineada al cerrar H-3. Por qué no la vi entonces vale la pena
    escribirlo: **un test que lee el código fuente de otro archivo mide el árbol
    en el instante en que corre**, y yo edité el archivo medido a mitad de
    corrida, así que ese test leyó la versión vieja y pasó.

    **A-1, el hallazgo más caro, y no lo levantó ningún agente**: 18 rutas de
    backend que ninguna pantalla consumía, y tres de ellas eran la **puerta de
    entrada** de un dato sin el cual la capacidad no da un número — costos fijos,
    tarifa por hora, liquidaciones del datáfono. El backend respondía `null` con
    motivo, correctamente; el dato no tenía por dónde entrar. Es el **costo
    conocido del arranque simultáneo**: T5 construyó contra el contrato mínimo,
    los cuatro backends agregaron rutas fuera de él y las declararon, y nadie
    tenía el mandato de volver a cruzar las dos listas al final. **Para la
    próxima fase: ese cruce es un paso del cierre, con dueño.**

26. **El recorrido en navegador real de la fase 3, y los cuatro defectos que
    2.070 tests no vieron.** Instancia real (Postgres para migrar, SQLite
    sembrada, uvicorn + vite + Chromium), las 20 pantallas nuevas, registrando
    toda respuesta `>= 400` y todo error de consola. Las 20 cargan limpias.
    **Ninguno de los cuatro defectos estaba en código de la fase 3**:

    - **`MoneyInput` sólo avisaba el monto al SALIR del campo.** Los formularios
      que habilitan su botón según el monto —18 archivos— dejaban el botón gris
      mientras el campo tuviera el foco, y **hacer clic en un botón deshabilitado
      no saca el foco del campo** en Chromium. La persona teclea y no tiene cómo
      destrabarlo salvo adivinar que primero hay que tocar en otro lado.
    - **`PinPad` se comía las teclas de cualquier otro campo**: su atajo escucha
      en `window` sin mirar dónde está el foco. Al arreglar el anterior quedó a
      la vista: tecleando «50000» en el monto de un pago a proveedor, el primer
      dígito habilita el PIN y el teclado se traga los cuatro ceros siguientes —
      cuatro dígitos es un PIN completo, así que **dispara el pago solo, con un
      PIN inventado**, y el PIN equivocado cuenta para el bloqueo por intentos.
    - **Tres clientes sin `Idempotency-Key`** en rutas que pasan por
      `run_idempotent`: `400` garantizado. Los tests no lo vieron porque llaman
      al cliente con el mock puesto, no al backend real.
    - **Un literal inventado**: el cliente decía `SettlementStatus = "pending"` y
      el servidor publica `recorded`. El botón «Conciliar» no se renderizaba
      nunca. `tsc` no lo ve: los dos lados son literales válidos, cada uno en su
      lenguaje.

    **Y un mensaje que le ponía el nombre de una función de Python en la pantalla
    al dueño de un restaurante** (`reason: "app.payroll.hooks.period_payroll_cost
    no tiene datos suficientes"`), más otro que nombraba a dos agentes del equipo
    y dos heredados de la fase 2.

    Los cinco quedan fijados por invariantes nuevos:
    `frontend/src/audit/pin-and-money-inputs.test.tsx`,
    `frontend/src/audit/api-literal-types.test.ts` (cruza cada
    `export type X` del cliente contra el `XLiteral` del esquema; **verificado
    reintroduciendo el defecto a propósito**) y
    `backend/tests/audit/test_user_facing_messages.py`.

27. **El objetivo de la fase, visto funcionando contra el producto corriendo.**
    Cargué costos fijos por $3.000.000 desde la pantalla y vendí dos platos por
    la puerta real del POS (activar dispositivo con PIN de sede, identificarse,
    abrir turno, comanda, propina **preguntada** —el gate `TIP_NOT_ASKED` cortó
    el primer intento—, cobro, documento fiscal emitido):

        GET /admin/break-even -> margen 98,38 %, punto de equilibrio $3.049.400
        GET /admin/profit     -> ventas netas $88.888, costo $1.440

    La aritmética cierra: `3.000.000 / 0,9838 = 3.049.400`.

    **Y de paso quedó demostrada la regla del snapshot**: el primer plato se
    vendió **sin ficha técnica**, su costo se congeló en «sin costo», y ponerle
    la ficha después **no revaloró esa venta** — hubo que vender de nuevo para
    que el período tuviera costo. Es exactamente lo que manda `AGENTS.md`, visto
    en vivo y no por un test.

28. **A-3, A-4 y A-5, cerrados.** Eran los tres que la fase dejó abiertos. Dos
    de ellos producían o podían producir un número equivocado; el tercero no se
    puede implementar sin un contador, y lo que se cerró es que el producto
    **dejara de aparentar que ya lo tiene**.

    - **A-3 · la misma plata restada dos veces.** `TipPayout` no decía si un
      reparto en efectivo salió **del cajón** —donde ya redujo el `to_deposit`
      de ese turno, que `withdrawn_from_shift_close` suma— o **de la mano**, y
      `owner_hand` restaba los dos. Ahora el origen es un dato
      (`paid_from`, migración `0021`) y la pantalla lo pregunta, pero sólo
      cuando el método es efectivo, que es cuando significa algo.

      **El respaldo no inventa el pasado**: las filas que ya existían quedan
      `unknown`, no `owner_hand`. Se tratan como salidas de la mano —el sesgo
      que muestra menos plata, el único que este proyecto tolera— y
      `tip_payouts_unknown_source` publica cuántas son, para que la suposición
      esté a la vista y no escondida en un default.

      De paso cayó un defecto de la misma familia: el **método** del reparto
      era un campo de **texto libre** y `owner_hand` filtra por
      `method == "cash"`. Un «efectivo» o un «Cash» tecleados a mano
      desaparecían del cálculo en silencio. Hoy es un conjunto cerrado en los
      dos lados, y el invariante de literales lo cruza.

    - **A-4 · tablas legales que nadie con firma revisó.** No hacía falta una
      columna: una vigencia sembrada por la migración `0020` no tiene
      `created_by_employee_id` y una que cargó una persona sí. **Se deriva.**
      Ahora la lista marca «Sin revisar», la pantalla explica cómo
      confirmarlas, y **la liquidación lo arrastra en su snapshot** — confirmar
      la tabla mañana no reescribe la historia de una nómina vieja.

    - **A-5 · la fórmula del CST no está implementada, y ahora el producto lo
      dice.** No la improvisé: combinar las ocho categorías
      (HED/HEN/HEDD/HEND) es una liquidación legal y se hace con la norma
      adelante y un contador, no de memoria. Lo que sí estaba mal era **dónde**
      vivía esa limitación: en un docstring y en un informe. El riesgo real no
      es que la cifra sea aproximada, es que alguien le pague a su personal con
      ella creyendo que es la legal. La respuesta publica
      `calculation_method: "additive_surcharges"` y la pantalla de
      liquidaciones lo dice arriba de la tabla, con todas las letras.

      El literal deja lugar para `"cst_full"` el día que se implemente, y las
      liquidaciones viejas van a seguir diciendo con cuál se calcularon.

29. **Diez mensajes le nombraban una ruta de API al dueño del restaurante**, y
    fue el recorrido de A-3/A-4/A-5 el que los destapó. Al liquidar una nómina
    en una sede recién creada, el sistema contestó «cargá una en
    `POST /admin/payroll/surcharge-tables`». Esa persona no tiene cómo hacer un
    POST.

    Es **el hallazgo A-1 en su forma original** —el motivo del punto de
    equilibrio nombraba la ruta que faltaba— y yo había arreglado la pantalla
    sin arreglar el mensaje: media lección aprendida. El barrido encontró diez,
    en cinco dominios. Todos reescritos para nombrar la pantalla, y el
    invariante de mensajes ahora también barre rutas de API.

    **Y un defecto de ubicación en mi propio arreglo de A-5**: el aviso de «no
    es la liquidación legal» lo puse DENTRO del detalle de una liquidación, así
    que con cero liquidaciones no se veía nunca — justo cuando más importa, que
    es antes de liquidar por primera vez. Movido a la pestaña. El test pasaba;
    la pantalla no servía. Es exactamente para eso que existe el recorrido.

    **Algo que conviene saber de la migración `0020`**: siembra las vigencias
    de recargos para las sedes que **existían al migrar**. Una sede creada
    después —la del seed, o una real dada de alta por un administrador— nace
    **sin ninguna tabla**, y no puede liquidar hasta que alguien las cargue. El
    sistema lo dice con `SURCHARGE_TABLE_MISSING` y ahora apunta a la pantalla
    correcta, pero es un paso de alta que conviene tener presente.

30. **Verificación final, con A-3/A-4/A-5 cerrados** (2026-09-20, árbol quieto,
    en serie): `python -m mypy app` limpio (147 archivos); suite de backend
    **1.526 passed, 1 skipped, 0 failed** (1:13:57); `tsc` limpio; vitest
    **557/557** en 117 archivos; `vite build` OK (2.609 módulos). Sobre
    **Postgres 16 real**: `0001 → 0021` limpio, una sola cabeza, **93 tablas**
    de dominio (`0021` agrega una columna, no una tabla), seed corrido dos
    veces sin duplicar, `downgrade base` deja el esquema vacío, y el respaldo
    de `paid_from` leído de vuelta por el modelo sobre una fila insertada
    **antes** de que la columna existiera.

31. **Lo que queda abierto de la fase 3, con dueño y razón.** Lo que sigue NO son olvidos:

    - **Los valores legales siguen esperando una firma.** A-4 está cerrado como
      defecto de producto —el sistema ya dice cuáles no revisó nadie— pero eso
      no revisa los valores: sigue haciendo falta que alguien con la norma
      adelante confirme las vigencias sembradas, cargándolas de nuevo desde
      Admin → Nómina → Tablas de recargos para que queden a su nombre. **Es lo
      único de esta lista con consecuencia legal**, y ahora se ve en la
      pantalla en vez de vivir en este documento.
    - **A-5 sigue sin la fórmula del CST.** Declarado en la respuesta y en la
      pantalla; implementarlo es un pedido propio, con la norma adelante y un
      contador. No es algo que se improvise de memoria.
    - **A-6 · dos invariantes que el auditor no alcanzó a armar**: el cruce
      **dinámico** del costo congelado (hoy probado por AST, no por
      comportamiento) y la aritmética del prorrateo de varianza por plato. El
      tercero que el informe pedía —el caso positivo de D-1— **sí existe**:
      `tests/analytics/test_sustained.py` lo cubre con dos conteos completos
      aplicados y ventas reales. El informe subestimó su propia cobertura.
    - **Heredado, sin cambios**: los tres campos de impuesto de una recepción
      arrancan en cero en vez de vacíos (decisión del dueño de la spec, rompe
      seis tests que codifican el cero como deliberado), y el QR de activación
      de tablet, que no puede llevar el PIN de sede.

32. **No había botón de salir** (2026-09-20). Lo encontró el dueño usando la
    app, no un test: en `/admin` **no existía ninguna forma de cerrar sesión**.
    `logout()` estaba en `src/api/auth.ts` desde la fase 1a y
    `deviceDeactivate()` desde 1b; las dos tipaban bien, las dos apuntaban a un
    endpoint que existe y funciona, y **ninguna tenía un solo llamador en toda
    la app**. Un envoltorio de API sin llamador no rompe `tsc`, no rompe ningún
    test de pantalla —nadie renderiza lo que no existe— y no aparece en ninguna
    cobertura: simplemente la capacidad no existe para quien usa el producto.

    Con las credenciales del seed publicadas en un repositorio público y
    vivas en la instancia de Render, «cerrar sesión» además no es una comodidad.

    Lo que se agregó:

    - **Admin**: botón «Salir» en el encabezado, junto a la campana y el tema.
    - **Salón**: «Desactivar este dispositivo», que es la salida que faltaba del
      otro lado. «Cambiar de persona» libera a la persona y el dispositivo sigue
      activado; para mover la tablet a otra sede —o corregir la sede
      equivocada— hay que desactivar el dispositivo, y eso no estaba en ninguna
      pantalla. Va detrás de una confirmación y visualmente apagado al lado de
      «Cambiar de persona»: tocarlo por error deja al salón sin vender hasta que
      aparezca alguien con el PIN de sede. **La confirmación explica la
      consecuencia, no autoriza**: el backend no pide PIN para desactivar y la
      interfaz no inventa un gate que el servidor no hace cumplir.

    **La regla que se llevó el arreglo**: la sesión del cliente se olvida
    DESPUÉS de que el servidor respondió bien, nunca antes. La cookie es
    `httpOnly` y la borra el servidor; limpiar `me` igual dejaría a la persona
    en `/login` con la sesión todavía viva, y al recargar volvería a entrar
    sola creyendo que había salido. Hay un test para cada lado que lo fija.

    **El invariante nuevo** (`src/audit/session-exits.test.ts`): por cada forma
    de entrar a una sesión —admin, dispositivo, persona— la función que la
    cierra tiene que llamarse desde un módulo de pantalla. Es la primera
    versión que mide lo único que falló acá, que es que nadie la llamara.
    Verificado a la inversa: con los dos layouts restaurados a su versión
    anterior, los 9 tests nuevos caen y el tercer renglón —persona /
    `deviceRelease`, que nunca estuvo roto— queda verde.

    Recorrido en navegador real contra el backend con el seed: admin entra,
    «Salir» borra `admin_session`, vuelve a `/login` y `/admin` ya no deja
    entrar; en el salón, activar con PIN de sede, identificarse, cancelar la
    confirmación no desactiva nada, confirmar borra `device_session` y `/pos`
    manda a `/pos/activate`. Sin desborde horizontal a 390 px.

33. **Una demo de un día de venta, y lo que encontró** (2026-09-20). Jugué
    nueve situaciones reales en la interfaz —abrir turno contando la base,
    mesa que pide y paga con datáfono, mostrador en efectivo con vuelto,
    anular un plato ya enviado, descuento por encima del tope, cortesía,
    retiro de efectivo, cierre a ciegas contando mal a propósito, y el admin
    mirando el día— verificando **la plata contra la base**, no contra la
    pantalla. Informe con capturas:
    <https://claude.ai/artifact/RPNtm2BhoquTfBHcSLtFtj>.

    **El defecto grave: un descuento rechazado quedaba aplicado.** El
    operador con tope del 10 % pedía 40 %, el sistema respondía `400
    DISCOUNT_LIMIT_EXCEEDED` «pedí el PIN de un supervisor», él no lo pedía —
    y el descuento entraba. Sin fila en `order_discounts` y sin auditoría, o
    sea invisible para cualquier reporte de descuentos por autorizador.
    Repitiendo el rechazo cuatro veces, un plato de $26.000 quedaba en $0.
    `test_discount_over_limit_needs_authorizer` no lo veía porque miraba el
    código de error y después el caso autorizado: **nunca miró la plata**.

    La causa estaba en `add_discount`: sumaba a `item.discount_amount` y ocho
    líneas después comprobaba el tope. `app/core/db.py` hace `commit()` al
    levantar un `AppError` —a propósito, y documentado ahí mismo: si no, cinco
    PIN fallidos nunca bloquean nada—. El precio de esa decisión es un
    contrato que ese servicio rompía: **para cuando un servicio escribe, la
    operación ya tiene que estar decidida**.

    **Y no estaba solo.** Un barrido por caminos de ejecución —no por líneas—
    encontró cuatro más: `add_items` (dos platos, el segundo inválido: el
    primero entra igual, y después sale dos veces a cocina),
    `update_ingredient` (nombre y costo oficial guardados en un 400),
    `update_platform` (la comisión, que mueve plata, cambiada tras un 409) y
    `_upsert_combo_options`. Todos arreglados, con
    `tests/audit/test_write_before_reject.py` como invariante: recorre `app/`
    entero y falla si alguien vuelve a escribir antes de validar. Los caminos
    legítimos están declarados con su motivo (`verify_authorizer` resultó NO
    serlo: escribe recién al final).

    **El otro de plata, más silencioso: la caja descuadraba en datáfono todos
    los días, por el monto exacto de las propinas.** El operador teclea lo que
    marca el lote ($126.741) y el cierre comparaba contra la venta sola
    ($116.000): diferencia $10.741, al peso la propina de tarjeta. No se
    pierde plata, pero una diferencia que aparece siempre enseña a ignorar las
    diferencias, que es justo lo que el arqueo a ciegas existe para evitar.
    Ahora `card_registered = sales.card + sales.tips_card` (ídem
    transferencias), y la pantalla dice de qué se compone: «Registrado = venta
    $116.000 + propina $10.741». **El esperado del efectivo no se tocó**: la
    propina en efectivo se sigue saldando por `tips_cash_out`/`to_deposit`.

    **Un mensaje que pedía algo que la pantalla no ofrecía.** Con comandas
    abiertas, el cierre decía «Cobrá o anulá las comandas abiertas, o marcá
    trasladarlas al turno siguiente». El backend soportaba
    `transfer_open_orders` y lo implementaba bien; el wizard mandaba `false`
    fijo y no tenía la casilla en ninguna parte. Es la misma familia que el
    botón de salir del renglón 32: una capacidad del servidor sin llamador en
    la interfaz. Agregada en los dos cierres — en el de tres pasos se muestra
    desde la review (`open_orders`), en el de un solo paso aparece recién
    cuando el servidor contesta `OPEN_ORDERS_EXIST`, que es cuando se sabe.

    **Dos de acabado**: el botón de cerrar de todos los diálogos decía
    «Close», en una interfaz que es toda en español (y es el único nombre que
    tiene para un lector de pantalla); y cada selector con causa tipada
    avisaba por consola que pasaba de no controlado a controlado — el estado
    controlado «sin valor» de Base UI es `null`, no `undefined`, y se
    normaliza una sola vez en el envoltorio de `Select`, no en los
    veinticinco sitios de llamada.

    **Y el monto que el sistema ya sabía.** En cada cobro en efectivo había
    que teclear a mano un total que estaba en pantalla; los botones rápidos
    llenan «Recibido», no «Monto». Ahora la primera fila arranca con lo que
    hay que cobrar y «Agregar pago» trae el saldo — editable, que es como se
    arma un pago dividido.

    **Lo que aguantó**, probado intentando romperlo: impuesto por ítem con el
    peso de redondeo hacia el lado seguro ($8.594 contra $8.593 sobre el
    agregado); la propina preguntada como manda la Ley 1935 y bloqueando el
    cobro hasta que alguien responda; anulación de un plato enviado con
    supervisor, las dos personas guardadas por separado y los minutos desde el
    envío; **el insumo que NO vuelve al inventario** cuando se anula un plato
    ya cocinado; topes de descuento acumulados; retiro que exige administrador
    y rechaza al supervisor por nombre; cierre a ciegas que no filtra el
    esperado ni en la columna de retiros; y el documento equivalente POS
    consecutivo y completo.

34. **Dos semanas de operación simulada, y lo que encontraron** (2026-09-22).
    `python -m app.demo --days 14` (después del seed) opera la sede por HTTP
    como un restaurante real: seis proveedores, ~40 insumos con precio de
    plaza, fichas técnicas de toda la carta, 32 compras con lote, 457 ventas
    de todos los canales, 27 facturas, retiros, cierres con diferencia,
    conteos, gastos, nómina, consignaciones y conciliaciones. Imprime cada
    rechazo de la API como hallazgo. Después, recorrido en Chromium de las 22
    pantallas del admin (con sus pestañas) y las 7 del POS.

    **Arreglados en este cambio:**
    - **La jornada de quien no marcaba salida no terminaba nunca.** La
      responsable de caja no puede marcar salida (`NOT_CASH_RESPONSIBLE`) y el
      cierre no cerraba su roster: nómina y reparto de propinas por horas la
      contaban hasta «ahora» — 740 horas extra en una semana y el 60 % de las
      propinas. El cierre (normal y administrativo) termina las entradas
      abiertas a su hora, con auditoría. En el cierre ADMINISTRATIVO de un
      turno abandonado eso es la hora del rescate: revisar esas horas.
    - `POST /admin/tips/payouts` daba `500` con la hora que manda la pantalla
      (`datetime-local` sin zona). Pasa por `from_bogota_wall_clock`.
    - Preparaciones pedía insumos con `store_id=-1` (404) antes de saber la
      sede; el libro del banco repetía claves de React (`id` de tablas
      distintas); «Nómina» y «Propinas» se encendían juntas en el rail.

    **Resueltos el 2026-09-23, con la decisión del dueño:**
    - **KDS**: `app.kitchen.service.live_rounds` / `visible_items`. Anuladas,
      fusionadas y compensadas salen; de días anteriores sólo sigue lo
      abierto; de lo cobrado hoy sólo sigue lo pendiente (en mostrador se
      cobra antes de cocinar). Lo mismo para la cola de impresión.
    - **POS en bucle con el admin abierto**: un navegador, un rol. Activar el
      dispositivo cierra la sesión de administrador en ese navegador, y la
      pantalla lo avisa antes.
    - **La campana de notificaciones tumbaba la app** (`Menu.GroupLabel`
      fuera de `Menu.Group`), y tocar un aviso no lo marcaba leído (`onSelect`
      es de Radix). Admin y POS tienen `errorElement` en español. Las reglas
      mostraban 14 tipos con el código crudo; ahora todos tienen nombre y
      explicación, con un test que cruza la lista del backend.
    - El seed ya no siembra insumos duplicados, y el cargo de domicilio no
      sale como «plato que no descuenta nada».
    - **DIAN**: se puede emitir con software propio (factura y DE POS).
      Plan en `docs/PLAN-DIAN.md`, pendiente de aprobación.

    **Sigue abierto:**
    - Las dos comandas de ejemplo del seed (`shift_id=NULL`) las adopta el
      primer turno; el cierre ofrece trasladarlas, así que no bloquea.
    - Consola: «Encountered a script tag while rendering React component» en
      todas las pantallas y avisos de Base UI `nativeButton` en tablas.

35. **La dirección visual «Un solo libro, dos mesas», completa** (2026-09-23).
    Aplica `docs/diseno/propuesta.html` en todo el sistema. Dos desvíos a
    propósito: el salón es **claro** por defecto, con «Pantalla oscura» por
    tablet (la cocina siempre en pizarra), y no hay «Volver a contar» en el
    cierre porque rompería el cierre a ciegas. El menú del admin conserva
    los grupos de a2 (`EL DÍA · LA CARTA Y EL COSTO · LA PLATA…`): se probó
    agruparlo por las preguntas de la propuesta y el dueño eligió quedarse
    con a2, que son más cortos. Las preguntas siguen como subtítulo de cada
    pantalla.
    - **Piezas nuevas** (`src/components`):
      - `SinDato`: rayado, siempre con motivo. `StatTile` la usa cuando el
        valor es `null`, y `cifraOSinDato` sirve para las cifras de plata.
      - `Diferencia`: ▲/▼ + palabra, con la cifra con su signo tal como
        llega. En caja falta el negativo; en inventario, el positivo.
      - `DesdeHacia`: la confirmación de lo que mueve plata. Nunca calcula
        «cómo queda». La usan retiro, consignación, pago a proveedor,
        devolución y movimientos del cajón.
      - `Cargando`: esqueleto con texto, en lugar de los 57 «Cargando…» sueltos.
      - Los totales de tabla y de la banda de cifra van con doble raya.
    - **Comanda**:
      - un toque suma el plato; el diálogo sólo se abre si el plato exige
        modificadores;
      - la carta muestra un número en insignia; lo agotado sigue visible,
        rayado;
      - el pedido va por ronda y curso, con los modificadores en línea;
      - el botón dice «Enviar a cocina · N ítems».
    - **Cuenta dividida**:
      - partes numeradas con estado, medio y «con factura»;
      - el botón dice «Cobrar parte N · $X»;
      - el comprobante ofrece «Seguir cobrando la mesa».
    - **Barra del salón según quién se identificó**:
      - Turno lo ve todo el que se identifica, porque ahí cada persona
        marca su entrada, salida y pausa (se probó ocultárselo al mesero y
        perdía cómo marcar su salida);
      - Cocina, Tiquetes de cocina, Producción y Merma van al final;
      - cada entrada tiene su ícono;
      - se renombró «Comanda» a «Mostrador», «KDS» a «Tiquetes de cocina» y
        «Producir» a «Producción».
    - **Celular del dueño**:
      - barra inferior Hoy · Ventas · Plata · Avisos · Más;
      - Hoy se lee primero la cifra, después los avisos y al final los
        indicadores;
      - los avisos de atención se cortan en 3 con «Ver N más».
      - Todavía no hay comparación semanal: `GET /admin/today` no la trae.
    - **Autorizaciones**: el diálogo de PIN nombra a quién pedírselo (los
      administradores, y los supervisores si `roles.supervisor` está prendida).
    - **Backend**: `PATCH /orders/{id}/items/{item_id}` ahora exige el PIN
      después de presentar la cuenta y respeta el contador de porciones del
      día. Subir la cantidad era la puerta de atrás de `add_items`.

36. **El restaurante es persona natural no responsable del impuesto al
    consumo** (2026-09-24). El dueño confirmó: persona natural, no inscrita en
    el Régimen Simple, un solo local e ingresos de 2025 por debajo de 3.500 UVT
    ($ 174.296.500). Por el art. 512-13 E.T. no es responsable del impuesto al
    consumo de restaurantes y, al no ser responsable de IVA ni de INC, no está
    obligada a facturar electrónicamente.
    - **Arreglo**: con la fiscal de la sede en `inc_responsible=false` e
      `iva_responsible=false`, la venta ya no lleva impuesto aunque el plato
      esté cargado `inc_8` (`orders.service._sale_tax`, única regla para
      plato, combo y cargo de domicilio). Antes la cuenta seguía
      discriminando el 8 %.
    - **Configuración en producción**: `fiscal.invoice` y `fiscal.dee_pos`
      apagadas (cada venta sale con comprobante interno) y una versión nueva
      de la fiscal de la sede como persona natural no responsable.
    - `docs/PLAN-DIAN.md` queda en pausa para este restaurante. Vuelve a
      aplicar si pasa los topes, abre otro local o se inscribe en el Simple:
      el 3.500 UVT de 2026 son $ 183.309.000 (UVT $ 52.374).

37. **«Orden y aire»: el admin en ocho secciones y siete reglas de
    presentación** (2026-09-24). El dueño comparó el admin con el de
    café-sistema y lo encontró agobiante (Hoy: 485 palabras en la primera
    pantalla contra 165 del café). Aprobó un mapa de pantallas y eligió
    empezar por acá. Sólo presentación: ningún cálculo, endpoint ni flag
    cambió.
    - **Rail**: de 25 entradas en seis grupos a ocho secciones — Hoy ·
      Informes · Caja · Inventario · Carta · Plata · Equipo · Ajustes — con
      las pantallas como pestañas de sección (`app/AdminLayout.tsx`, `RAIL`).
      Ninguna ruta cambió. Documentos y Notas van en Informes (con
      comprobante interno siguen existiendo), Devoluciones en Caja, Rangos en
      Ajustes. Celular: Hoy · Informes · Caja · Avisos · Más.
    - **Piezas compartidas**: cuerpo de 16 px en la oficina; la pregunta de
      `PageHeader` plegada en «¿Qué es esto?»; `DenseTable` pliega leyenda y
      nota en «Cómo leer esta tabla» y esconde las columnas `secondary` tras
      «Más columnas»; `MenuDeFila` (⋯), `MasPestanas` («Más ▾», mismo
      `?tab=`), `Explicacion`; `NoticeRail` con `limit`.
    - **Pantallas**: todas quedan con 3 pestañas a la vista como máximo y
      tablas de 5 columnas a la vista. Hoy: la venta neta primero, 5 avisos y
      el resto en «Ver n más» (367 → ~260 palabras en la primera pantalla).
      Gastos abre en Utilidad; Carta en Productos y ahora lleva `?tab=`.
    - **Censo de controles**: la regex no veía `<DropdownMenuItem onClick={()
      => …}>Editar<` (la flecha cortaba la etiqueta); ahora sí. Bajas
      declaradas a mano en `censo-controles.test.ts`: frases de franjas de
      contexto, y «Propinas», que pasó a ser pestaña de sección.
    - **Siguiente, según el mapa**: la rutina del turno (abrir con días por
      consignar, no vender sin apertura, consignar desde el POS con
      confirmación del admin, bandeja en Hoy) y después Informes en un solo
      scroll con el consolidado de sedes.
    - Pendiente chico: el cuerpo de cada aviso de Hoy no se puede plegar
      (`NoticeRail` lo pone en un `<p>`); `FormSection` no pliega
      `governs`/`reading`/`doesNotDo`, que es lo que más texto deja en
      Tarifas y en el método de reparto de propinas.

38. **Las fotos no cabían: ninguna foto real se guardó nunca en producción**
    (2026-09-24). La pantalla manda la foto como *data URL* (cientos de KB) y
    cada dominio la guardaba en una columna `String(500)`: en Postgres el
    `INSERT` de un movimiento, retiro, relevo o cierre con foto fallaba por
    largo, y una consignación con comprobante la rechazaba el esquema
    (`max_length=500`). SQLite no hace cumplir el largo y los tests usaban
    `"c.jpg"`: nada lo veía.
    - **Arreglo**: dominio `app/photos` (tabla `photos`, migración `0023`).
      `PhotoIn` valida la foto al entrar (imagen JPG/PNG/WebP, hasta 4 MB);
      `photos.hooks.store_photo` la guarda al escribir el registro y la
      columna de siempre se queda con `/api/v1/photos/<id>`.
      `GET /photos/{id}` la sirve al admin y a la tablet de la misma
      organización; a otra, 404.
    - **Tablet**: `lib/foto.ts` achica la foto a 1600 px en JPEG (~200 KB)
      antes de mandarla; si el navegador no puede, manda la original.
    - Tests: `tests/photos/test_photos.py` mide el **largo** de lo guardado,
      que es lo que Postgres rechaza y SQLite no.

---

## Rediseño del admin — dónde quedó (rama `claude/keen-ptolemy-l8fpe8`)

Cuatro commits sobre `main`. `main` está en `2834ab1`, con CI verde; todo lo
de abajo vive sólo en la rama y **no se fusionó**.

### Hecho

- **`docs/PATRONES-ADMIN.md`** — 13 patrones del escritorio del dueño.
- **Censo de controles** (`src/audit/censo.ts`, `censo-controles.test.ts`,
  `regenerar-censo.ts`): por archivo, los rótulos visibles de cada control.
  Agregar no falla, quitar sí. Base actual: 133 archivos, 812 rótulos.
- **Capa compartida** en `src/components/admin/` — un componente por patrón.
  Las reglas se cumplen por tipos: el compilador rechaza un botón rojo en la
  zona de consecuencia, una acción destructiva sin consecuencias declaradas y
  un vacío por filtro que no nombre al culpable.
- **`tolerance_identified_cause` eliminado** (migración `0022`): era editable
  y no lo leía ninguna lógica. Con la escalera dibujada en Ajustes y la
  validación de orden (`400 CRITICAL_BELOW_TOLERANCE`).
- **21 de 24 pantallas** con los patrones aplicados.

### Pendiente

1. **Tres pantallas sin tocar**: Preparaciones, Compras, Turnos y personal.
2. **`features/people/PeopleSection.tsx`** (pestaña Empleados de Ajustes):
   quedó fuera del reparto de territorios. Ahí viven el PIN personal y el
   límite de descuento, que son marcas de alcance.
3. **La suite completa no se corrió sobre el estado final.** `tsc` en 0 y
   censo verde, nada más. Es lo primero que hay que hacer, con el árbol
   quieto y guardando toda la salida.
4. **Cinco huecos de la capa compartida**, reportados por los agentes. El más
   general no es del admin: `DialogContent` trae `sm:max-w-sm` y le gana a
   cualquier `max-w-*` del sitio de llamada, así que hay diálogos en 384 px
   en monitores de 1440. La corrección va en `src/components/ui/dialog.tsx`.
5. **El censo tiene un punto ciego**: un control escrito como
   `Button render={<Link/>}` deja el rótulo dentro de un atributo y se vuelve
   invisible para la red. Le pasó al enlace «Activá este dispositivo».
6. **El regenerador global es peligroso con trabajo en paralelo**: relee el
   árbol entero y bendice en silencio los renombres ajenos. Correrlo sólo con
   todo quieto, o regenerar por archivo.

### Dos cosas de infraestructura que conviene recordar

- **En esta rama el CI no corre.** Sólo en `main` y en pull requests, por
  cuota de Actions (está explicado en `.github/workflows/ci.yml`). El verde
  sale de una corrida local o de abrir el pull request.
- La instancia viva es `restaurante-sistema-jvts.onrender.com`, sirviendo lo
  que hay en `main`.
