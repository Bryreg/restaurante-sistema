# Pedido 1a — Cimientos y caja

Primer pedido al orquestador. Depende de `docs/SPEC-NEGOCIO.md` (v0.3) y de
`AGENTS.md`. Si algo de acá contradice a la spec de negocio, manda la spec de negocio
y se corrige acá.

## Objetivo

Dejar el repositorio vivo y el **turno de caja funcionando con control**: activar la
tablet, identificarse con PIN, abrir turno con base fija y reserva, registrar
movimientos, cambio y retiros, relevar al responsable, cerrar a ciegas en tres pasos
con causa tipada, y que el administrador vea y rescate turnos, configure la sede (con
lo fiscal) y cargue la carta con modificadores, combos y menú del día. **No hay
comandas ni cobro todavía**: eso es el pedido 1b, que construye sobre este.

## Alcance

**Entra**

- **Organización y funciones** (spec §1.1 y §1.2): tabla de organizaciones; sedes y
  administradores pertenecen a una; catálogo de funciones con clave, descripción,
  dependencias y default por perfil; estado por organización con override por sede;
  perfiles `basic`, `standard`, `full`; dependencia `require_feature("clave")` que
  responde `400 FEATURE_DISABLED`; los flags vigentes en `GET /auth/me`; cambios
  auditados; pantalla Admin → Funciones. Todo lo demás de este pedido se construye
  detrás de su flag (`cash.blind_close`, `cash.reserve`, `cash.pickups`,
  `cash.handovers`, `cash.photo_required`, `cash.swaps`, `roles.supervisor`,
  `pos.modifiers`, `pos.combos`, `pos.daily_menu`, `pos.daily_count`, `multi_store`).
- Repositorio: `backend/` (FastAPI + SQLAlchemy + Pydantic, Alembic, pytest, mypy),
  `frontend/` (Vite + React + TypeScript + shadcn/ui + Tailwind, vitest), CI que corre
  typecheck, suite y build en serie y bloquea en rojo, `.claude/launch.json` ajustado.
- Spec de negocio §2 (identidades, roles, PIN, supervisor), §3.1, §3.2 y §3.7 (día,
  turno, rescates), §4.3 sólo la carta **plana** (categorías, productos con precio por
  canal, tasa, estación, curso, disponible, contador; grupos de modificadores con
  ajuste de precio y `recipe_effect` nulo; combos y menú del día con opciones activas
  por día y franja), §7 (empleados y roster), §8.1 (configuración fiscal con vigencia,
  tabla UVT), §9.3 secciones Configuración, Turnos y personal, Dinero, Historial,
  Notificaciones (campana), §11 y §12 completas.
- Seed de desarrollo **fuera del arranque**: una sede con configuración fiscal, un
  administrador, un supervisor, cuatro operadores, dos zonas con ocho mesas, una carta
  de veinte productos con modificadores, un combo y un menú del día.

**No entra** (lo construye 1b o fases posteriores; no se toca por iniciativa propia)

- Comandas, mesas en uso, cocina, precuenta, cobro, propina, documento fiscal, notas,
  devoluciones, Hoy, Ventas, Pedidos.
- Recetas, inventario, compras, consignaciones, banco, nómina.

## Convenciones de ingeniería

- Estructura por dominio: `backend/app/{core,auth,stores,catalog,shifts,audit,
  notifications}` cada uno con `models.py`, `schemas.py`, `service.py`, `router.py`;
  `backend/tests/<dominio>/`; `frontend/src/{api,components,features/<dominio>,pages}`.
- Nombres en inglés según el glosario de `docs/ESTADO.md`.
- Dinero en **enteros de pesos**; porcentajes `Numeric(5,2)`; cantidades `Numeric`.
- `business_date` como `Date` con `America/Bogota` y la hora de corte de la sede;
  instantes en UTC serializados con `Z`; helpers únicos (`core/tz.py`,
  `src/lib/businessDate.ts`); prohibido `new Date("YYYY-MM-DD")` y
  `toISOString().slice(0, 10)`.
- Errores `{ "error": { "code", "message" } }`; reglas de negocio en `400` con código y
  mensaje que nombra la acción correctiva; validación de esquema normalizada a la misma
  forma; `409` concurrencia; `401`/`403` sesión y permisos.
- `Idempotency-Key` en `shifts/open`, `shifts/{id}/close`, `cash-movements`, `pickups`,
  `handovers`; la clave se reserva dentro de la transacción y un replay devuelve la
  respuesta original.
- Constraints en la base: un turno abierto por sede (índice único parcial); un día
  operativo por sede y fecha; `Idempotency-Key` única por alcance.
- **Alcance por organización**: la sesión (admin o dispositivo) lleva `organization_id`;
  todo repositorio de datos filtra por organización y sede; un id de otra organización
  es `404`. Test de aislamiento desde el primer módulo.
- **Flags**: un decorador/dependencia `require_feature` por endpoint opcional; el
  frontend arma menús y pantallas a partir de `features` en `GET /auth/me`; cada
  módulo opcional tiene al menos un test con el flag apagado.
- Auditoría con antes y después en toda escritura de caja, configuración, empleados y
  carta; si falla, se registra en log, nunca se traga.
- PostgreSQL en CI; SQLite en desarrollo y tests con `busy_timeout`.
- Todo campo nuevo de respuesta es opcional en los tipos del frontend.

## API contract (English — technical artifact)

Routes under `/api/v1`. Money is integer COP. Instants are ISO-8601 UTC with `Z`;
`business_date` is `YYYY-MM-DD`. Every error has the shape
`{ "error": { "code": "...", "message": "..." } }`. The backend may add fields but must
not rename or remove these; the frontend must not consume routes not listed here
without reporting them as a gap.

### Organizations & features
- `GET /auth/me` includes `{organization: {id, name}, features: {"pos.tables": true, ...}}` for the current store (org value with store override applied).
- `GET /admin/organization` → `{id, name, profile, declared_not_obliged_to_invoice?: {at, by}}`; `PATCH /admin/organization` `{name}`.
- `GET /admin/features` → `[{key, description, enabled, source: "org"|"store_override"|"profile_default", requires: [...], available_from_phase}]`; `PUT /admin/features/{key}` `{enabled, store_id?}` → `400 FEATURE_DEPENDENCY` naming the missing dependency, `400 FEATURE_IS_CORE` for non-optional capabilities; audited.
- `POST /admin/organization/profile` `{profile: "basic"|"standard"|"full"}` → resets flags to the profile defaults (audited).
- Any endpoint of a disabled feature → `400 FEATURE_DISABLED` `{feature: "..."}`.

### Auth & identity
- `POST /auth/admin/login` `{email, password}` → httpOnly cookie; `{user: {id, name, role: "admin"}, organization: {...}}`.
- `POST /auth/device/activate` `{store_id, store_pin}` → long-lived httpOnly device cookie; `{store: {id, name, cutoff_hour, active_channels}}`.
- `POST /auth/device/identify` `{employee_id, pin}` → binds the active employee to the device session (server side), adds them to the open shift roster with `in_at` if a shift is open; `{employee: {id, name, role, can_charge, discount_limit_pct}}`. `400 PIN_LOCKED` after 5 failures (15 min).
- `POST /auth/device/release`; `POST /auth/device/deactivate`; `POST /auth/logout`.
- `GET /auth/me` → `{kind: "admin"|"device", user?, store?, employee?, employee_expires_at?}`.
- `POST /auth/authorize` `{pin, action}` → `{authorizer: {id, name, role}}` for a one-shot authorization; every privileged endpoint also accepts `authorizer_pin` in its body and re-verifies. Supervisors may authorize `void_sent_item`, `courtesy`, `discount_over_limit`; admins everything.

### Store & settings
- `GET /admin/stores`, `POST /admin/stores`, `PATCH /admin/stores/{id}` → `{name, nit, dv, legal_name, address, municipality_dane, opening_hours: [{weekday, open, close}], cutoff_hour, active_channels: [...]}`.
- `GET/PUT /admin/stores/{id}/fiscal` (versioned by `valid_from`) → `{person_type: "natural"|"legal", regime: "ordinary"|"simple", franchise: bool, inc_responsible: bool, iva_responsible: bool, rut_codes: [...], price_includes_tax: bool, default_tax: "inc_8"|"iva_19"|"excluded"}`; `GET /admin/stores/{id}/fiscal/history`.
- `GET/PUT /admin/stores/{id}/cash-settings` → `{opening_cash_fixed, cash_reserve_default, tolerance_unknown_cause, tolerance_identified_cause, critical_difference, cash_pickup_threshold, petty_cash_limit, photo_required_on_close, photo_required_on_pickup, streak_alert_shifts}`.
- `GET/PUT /admin/stores/{id}/sales-settings` → `{tip_suggested_pct (≤ 10), discount_limit_pct, discount_daily_limit_pct, courtesy_shift_limit, payment_methods: [{code, label, dian_code, enabled, requires_reference}], void_reasons, discount_reasons, courtesy_reasons, courses: [...], stations: [...], course_target_minutes: {...}}` (values; the capabilities themselves are features).
- `GET/PUT /admin/uvt` → `[{year, value}]`.
- `POST /admin/stores/{id}/rotate-pin` `{new_pin}`.

### Zones, tables, employees
- Admin CRUD `/admin/zones`, `/admin/tables` (`{zone_id, number, seats}`), `/admin/employees` (`{name, role: "operator"|"supervisor"|"admin", pin, can_charge, discount_limit_pct?, document?}`; PIN hashed, never returned; `active=false` instead of delete).
- `GET /tables` (device) → `[{id, zone_id, zone_name, number, seats, status: "free"|"open"|"to_pay", open_order_id?, open_since?, total?, covers?}]` — in 1a always `free`.

### Catalog
- `GET /catalog` (device and admin) → `{categories, products: [{id, category_id, name, description, station, default_course, prices: {dine_in, takeout, delivery?, platform?}, tax_code, available, daily_count?, daily_remaining?, modifier_groups: [{id, name, required, min, max, options: [{id, name, price_delta, available}]}]}], combos: [{id, name, price, active_now, schedule: {days, from, to}, groups: [{id, name, options: [{id, name, product_id, available_today}]}]}]}`. **No cost fields.**
- Admin CRUD `/admin/categories`, `/admin/products`, `/admin/modifier-groups` (with `recipe_effect: null` in this phase), `/admin/combos`.
- `PUT /admin/combos/{id}/today` `{active_option_ids: [...]}` — "armar el menú de hoy".
- `POST /products/{id}/availability` `{available, daily_count?}`; `POST /modifier-options/{id}/availability`; `POST /combo-options/{id}/availability` — device or admin; records who and when; cleared at day open.

### Business day & shifts
- `GET /shifts/current` → open shift for the device's store or `null`: `{id, business_date, opened_at, cash_responsible: {id, name}, roster: [{employee, in_at, out_at?}], expected_cash?, is_stale, cash_over_threshold}` (`expected_cash` only for admin or the cash responsible).
- `POST /shifts/open` (Idempotency-Key) `{opening_cash: {denominations: [{value, count}], total}, cash_reserve, cash_responsible_id, opening_cause?: "counting_error"|"unknown"|..., opening_note?}` → `400 SHIFT_ALREADY_OPEN` / `409` on race; `400 OPENING_DIFFERENCE_NEEDS_CAUSE` when `total != opening_cash_fixed` and no cause.
- `POST /shifts/{id}/roster` `{employee_id, action: "in"|"out"|"pause_start"|"pause_end"}` — PIN + time; no count unless the employee is the cash responsible (then use `handovers`).
- `POST /shifts/{id}/handovers` (Idempotency-Key) `{kind: "handover"|"spot_check", counted_cash: {denominations, total}, counted_card?, counted_transfer?, new_responsible_id?, authorizer_pin?, photo?}` → stores the frozen breakdown `{base, cash_sales, incomes, expenses, pickups, expected, counted, difference}`; `spot_check` requires admin PIN.
- `POST /shifts/{id}/cash-movements` (Idempotency-Key) `{kind: "income"|"expense", cause: "petty_expense"|"emergency_purchase"|"refund"|"tip_payout"|"other_income"|"other_expense", amount, note, receipt_photo?, authorizer_pin?}` → `400 PETTY_CASH_LIMIT` above `petty_cash_limit` without authorizer.
- `POST /shifts/{id}/cash-swaps` `{out: {denominations}, in: {denominations}}` → net must be zero (`400 SWAP_NOT_ZERO`); does not change expected cash.
- `POST /shifts/{id}/pickups` (Idempotency-Key) `{amount, denominations?, envelope_ref?, authorizer_pin, note?}` → admin PIN required; stores `expected_at_pickup` snapshot; `POST /shifts/{id}/pickups/{pid}/reverse` `{reason, authorizer_pin}`.
- Close, three steps, one transaction each:
  1. `POST /shifts/{id}/close/count` (Idempotency-Key) `{counted_cash: {denominations, total}, counted_card, counted_transfer, tips_cash_out, photo?}` → freezes the count; returns `{count_id}` only (never the expected).
  2. `GET /shifts/{id}/close/{count_id}/review` → `{expected, difference, equation: {base, cash_sales, incomes, expenses, pickups}, card: {registered, counted, difference}, transfer: {...}, requires_cause: bool, requires_identified_cause: bool, is_critical: bool}`.
  3. `POST /shifts/{id}/close/{count_id}/confirm` `{difference_seen, cause?: "change_error"|"expense_without_voucher"|"tips_mixed"|"unrecorded_sale"|"counting_error"|"unknown", note?, closes_day: bool, transfer_open_orders?: bool}` → `400 DIFFERENCE_CHANGED` (returns the new review), `400 CAUSE_REQUIRED`, `400 IDENTIFIED_CAUSE_REQUIRED`, `400 PHOTO_REQUIRED`, `400 CARD_TOTAL_REQUIRED`, `400 OPEN_ORDERS_BLOCK_CLOSE` (1b); on critical difference it closes and notifies. Returns `{to_deposit, closes_day}`.
- `GET /shifts/{id}` → full summary (movements, swaps, pickups, handovers, roster, expected vs counted, difference and cause, to_deposit, reviewed_by).
- Admin: `GET /admin/shifts?from&to&store_id`, `GET /admin/shifts/{id}/timeline`, `POST /admin/shifts/{id}/review`, `POST /admin/shifts/{id}/close-administrative` `{reason}` (only stale), `POST /admin/shifts/{id}/reopen` `{reason}`, `DELETE /admin/shifts/{id}` (only without activity), `POST /admin/shifts/{id}/adjust-opening` `{opening_cash, cash_reserve, reason}`.
- `GET /admin/business-days?from&to` → `[{business_date, status, shifts: [...]}]`.

### Employees & audit (admin)
- `GET /admin/employees/{id}/activity?from&to` → shifts, in/out, differences and streak, authorizations given (sales fields arrive in 1b).
- `GET /admin/authorizations?from&to&authorizer_id` → what each authorizer approved.
- `GET /admin/audit?from&to&entity&employee_id` → rows with before/after.
- `GET /admin/notifications`, `POST /admin/notifications/{id}/read`, `GET/PUT /admin/notification-rules` → `[{type, enabled, threshold?, level}]`. Types in 1a: `shift_stale`, `cash_difference`, `cash_difference_critical`, `difference_streak`, `cash_over_threshold`, `pin_locked`, `product_unavailable`.
- Every list endpoint accepts `format=csv`.

## Verificación del pedido (checklist de entrega)

Además de la sección 16 de la spec de negocio (pedido 1a):

- [ ] `alembic upgrade head` desde cero crea el esquema; `python -m app.seed` siembra
      aparte; CI verde con typecheck backend y frontend, suite y build en serie.
- [ ] `PUT /admin/features/cash.handovers {enabled: false}` → `POST /shifts/{id}/handovers`
      responde `400 FEATURE_DISABLED` y el POS no muestra «Relevo» (tests).
- [ ] Habilitar `pos.daily_menu` sin `pos.combos` → `400 FEATURE_DEPENDENCY`; elegir
      `basic` deja los flags de §1.2 (tests).
- [ ] Un admin de la organización A recibe `404` al leer o escribir un turno de la
      organización B (test).
- [ ] Dos `POST /shifts/open` concurrentes: uno `200`, otro `409` (test).
- [ ] `POST /shifts/{id}/close/count` no devuelve el esperado; `review` sí; `confirm`
      con `difference_seen` vieja → `400 DIFFERENCE_CHANGED` (test).
- [ ] `cash_reserve` no altera `expected`; `cash-swaps` no altera `expected`; un
      `pickup` lo baja y guarda `expected_at_pickup` (test).
- [ ] Cierre con foto exigida y sin foto → `400 PHOTO_REQUIRED` (test).
- [ ] Cinco `identify` fallidos → `400 PIN_LOCKED`; la persona activa expira (test con
      reloj simulado).
- [ ] Un supervisor autoriza `discount_over_limit` y no `pickup` (test).
- [ ] `GET /catalog` con sesión de dispositivo no contiene ninguna clave `cost`,
      `margin` ni `unit_cost` (test que inspecciona el OpenAPI y la respuesta).
- [ ] El menú del día aparece `active_now` sólo en su franja y días (test con reloj
      simulado); una opción agotada no viene `available_today`.
- [ ] No hay `localStorage.setItem` de tokens ni de sesión (grep en verificación).
- [ ] Todo `400` de negocio trae `code` y `message` con la acción correctiva (test de
      forma sobre una muestra).
