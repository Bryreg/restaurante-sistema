# Restaurante Sistema — estado del proyecto

Documento de referencia para retomar el trabajo sin reconstruir el contexto.
Última actualización: 2026-09-15 (pedido 1b-1 construido y verificado; el
cierre lo hizo el orquestador humano sin Conciliador, ver «Dónde retomar».
Pedido 1a entregado y verificado el 2026-09-14; framework 2.1.0).

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
cada una. Si existe `app.catalog.seed.seed_catalog`, también carga la carta (lo
hace `catalogo`; ver su output). Imprime todos los PIN por consola al correr.

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
3. **Abierto por decisión del dueño de la spec** (advertencias del auditor, en
   `features/fase-1a-cimientos/outputs/ENTREGA.md § 5.4`) — **O-1, A-7 y A-9
   resueltos por default en 1b-1** (ver «Qué está hecho»; `backend-base`):
   sigue abierto A-1 (tope de intentos en `/auth/authorize`); A-2 (validar
   `JWT_SECRET` en producción); A-4 (esperado calculado para turnos abiertos en
   `GET /admin/shifts`); A-6 (idempotencia en `cash-swaps` y reversa de
   retiro); A-8 (`SAVEPOINT` en vez de `rollback()` ante `IntegrityError`).
4. **Gaps declarados por los constructores** (`ENTREGA.md § 5.5`): motivo en
   `DELETE /admin/shifts/{id}`; `close_cause` y base de apertura en el listado de
   turnos; quitar opciones de modificadores y grupos de combos (API y UI);
   agregar grupos a un combo existente desde la UI; tests de las pantallas de
   configuración, personal, auditoría y notificaciones; `shadcn` a
   `devDependencies`; token `--warning`.
5. **Corrección al contrato interno para 1b**: cada hook cruzado entre territorios
   lleva dueño del test de punta a punta, y la fixture `race_app` es la común para
   carreras (ya está en `tests/conftest.py`). Patrón registrado en
   `docs/PATRONES.md` del framework (2.1.0).
6. **Abierto por el auditor de 1b-1** (detalle con archivo:línea en
   `features/fase-1b-venta/outputs-1b-1/auditor-venta.md § 3`; decisión del
   dueño de la spec o trabajo de 1b-2): **A-10** el POS de cobro deriva «Total a
   cobrar» como venta + propina con `?? 0` (`PaymentTargetPanel.tsx`), único
   número de plata calculado en el cliente — que lo mande el backend o mostrar
   dos líneas; **A-11** leyenda legal escrita a mano como respaldo en
   `CheckoutPage.tsx` — debería venir siempre del servidor; **A-12** `prorate`
   puede asignar a una línea más de lo que pesa cuando el saldo total es menor
   que la cantidad de líneas (pesos diminutos; el router ya impide
   `item_discount > gross`) — tope `min(share, weight)` de una línea; **O-1**
   `Math.round` silencioso en `DiscountDialog.tsx`; **O-2** `stripComments` del
   auditor de 1a colapsa saltos de línea y corre los `archivo:línea`.
7. **Gaps declarados por los constructores de 1b-1** (cada `outputs-1b-1/*.md`
   § gaps): `PinPad` compartido escucha el teclado a nivel de `window` sin
   filtrar por foco (se cuela en cualquier input visible; `frontend-cobro` lo
   mitigó en su código sin tocar el componente); no hay ruta de dispositivo
   para leer los medios de pago habilitados de la sede (el POS ofrece los seis
   códigos fijos); división por ítems con UI de armado manual, sin derivar
   grupos por asiento aunque `pos.seats` esté activa; `document-print.css`
   tiene 58/72/80 mm pero no hay configuración de sede para elegir el ancho;
   `TAX_RATE_BY_CODE` declarado localmente en `app/orders/service.py` (conviene
   centralizarlo si 1b-2 agrega tasas); tras unir comandas, las rondas
   históricas de la origen no se listan en la destino (sólo presentación);
   `OrderPage` no tiene botón propio de dividir ni acción «quitar descuento»;
   el tiempo transcurrido de mesas se calcula con el reloj del dispositivo.
8. **El pedido 1b se partió en dos** para que cada mitad quepa en un equipo de
   2 a 6 agentes y en una ventana de uso. **1b-1 está construido y verificado**
   (ver «Qué está hecho»): «Quién opera» con lista de personal (A-9),
   mostrador, mesas, comandas con versión optimista, rondas y cocina mínima,
   precuenta y propina, cobro con pagos mixtos y división, descuentos y
   cortesías, `staff_meal`, O-1 y A-7 resueltos por default. **1b-2**
   (siguiente): documento fiscal con rangos, estados, contingencia y adaptador
   de proveedor (`FiscalProvider`), notas y devoluciones pendientes, clientes y
   consentimientos, Hoy, Ventas e informe del contador, Pedidos; arranca desde
   el commit del cierre de 1b-1 y conviene que su contrato interno tome los
   puntos 6 y 7 de esta lista como entradas. La spec de ambos es
   `features/fase-1b-venta/spec.md`; el pedido delimita:
   ```js
   Workflow({
     scriptPath: '.claude/workflows/orquestador-general.js',
     args: {
       pedido: '<el pedido 1b, sección 14 de la spec>',
       spec: 'features/fase-1b-venta/spec.md',
       outputs: 'features/fase-1b-venta/outputs',
       contexto: ['docs/ESTADO.md', 'AGENTS.md', 'docs/SPEC-NEGOCIO.md'],
       base: '<commit desde el que arranca 1b>',
     },
   })
   ```
9. Lo que no se pudo verificar en este entorno: Postgres real (tipos, índices,
   `SELECT FOR UPDATE` del consecutivo y los `409` literales de carrera, que
   sólo el CI puede probar), el CI en sí, WCAG más allá de Testing Library, y
   el flujo completo de comanda y cobro en un navegador real (1a sí se recorrió
   con Playwright; 1b-1 todavía no).
