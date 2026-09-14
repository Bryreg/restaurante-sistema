# Fase 1 — Fundación y venta

Spec del primer pedido al orquestador. Depende de `docs/SPEC-NEGOCIO.md` (la spec de
negocio, v0.2) y de `AGENTS.md` (lo que este proyecto hace distinto). Si algo de acá
contradice a la spec de negocio, manda la spec de negocio y se corrige acá.

## Objetivo

Que el restaurante pueda **operar un día completo** con el sistema: activar la
tablet, abrir turno de caja, abrir mesas, tomar comandas, enviarlas a cocina,
cobrar con pagos mixtos, propina e impuesto, imprimir el tiquete, hacer relevos y
retiros, y cerrar la caja con conteo y diferencia. Y que el administrador pueda ver,
en PC, qué se vendió, qué comandas hubo, cómo cuadró cada turno y quién hizo qué.

Recetas, inventario y compras son de la **fase 2**: esta fase deja los ganchos (el
ítem de comanda congela `unit_cost` y `recipe_version`, nulos por ahora; el envío a
cocina cambia estados y estampa `sent_at` pero todavía no registra consumo) y no
construye nada de las secciones 4 y 5 de la spec de negocio.

## Alcance

**Entra**

- Secciones 2, 3, 6.1 (sólo cajón: turnos, movimientos, retiros, «por consignar»
  calculado), 7, 8 y 9 de la spec de negocio, con las reglas duras de la sección 11
  completas y las convenciones de la sección 12.
- Autenticación: administrador (correo + contraseña → JWT en cookie `httpOnly`);
  dispositivo (activación con PIN de sede → sesión larga en cookie `httpOnly`);
  identificación de persona por PIN de 4 dígitos, ligada a la sesión del
  dispositivo en el servidor; autorización puntual por PIN de administrador.
- Sedes, zonas, mesas, empleados con PIN, carta **plana**: categorías, productos con
  precio por canal y tasa de impuesto, disponible sí/no, grupos de modificadores con
  ajuste de precio, combos con grupos y opciones (producto sombra). Sin recetas.
- Día operativo con hora de corte por sede; turno de caja con apertura (base por
  denominaciones, reserva aparte, justificación), roster con entradas y salidas,
  movimientos de caja, retiros con PIN admin, relevo con snapshot congelado, cierre
  atómico con datáfono y justificación, gates, traslado de comandas, rescates de
  administrador (cierre administrativo, reabrir, cancelar vacío, ajustar apertura).
- Comanda con estados; ítems con estados y snapshot; envío a cocina; anulaciones con
  autorización; cortesías; unir y mover mesas; agotado del día.
- Cobro: tabla de pagos, pagos mixtos, división de cuenta, propina preguntada y
  separada, descuentos con límite y autorización, impuesto por tasa, tiquete con
  consecutivo sin huecos, idempotencia y `409`, datos de cliente cuando pide factura.
- Nota crédito sobre venta cobrada (sólo admin), por línea «se usó / vuelve» (el
  «vuelve» no mueve inventario todavía: queda registrado para la fase 2).
- POS completo (sección 9.1 salvo las herramientas de merma y producción).
- Admin: Hoy, Ventas (incluido informe para el contador y exportes), Pedidos, Dinero,
  Turnos y personal, Historial de auditoría, Configuración (sección 9.2).
- Auditoría con antes y después en toda escritura financiera; falla registrada, no
  silenciada.
- Seed de desarrollo, **fuera del arranque**: una sede, un admin, tres empleados, dos
  zonas con ocho mesas, una carta de veinte productos con modificadores y un combo.

**No entra** (y no se toca por iniciativa propia)

- Insumos, preparaciones, recetas, consumo teórico, mermas, conteos, compras, lotes.
- Vista de cocina, impresora térmica, facturación electrónica, consignaciones, banco,
  nómina, obligaciones.
- Modo sin conexión más allá de tolerar cortes breves.

## Convenciones de ingeniería de esta fase

- Estructura: `backend/app/{core,models,schemas,routers,services}`, `backend/tests`,
  `backend/alembic` (migraciones desde el primer commit; DDL Postgres-first);
  `frontend/src/{api,components,features,pages}`, tests con vitest junto al código.
  Un módulo por dominio (`shifts`, `orders`, `payments`, `catalog`, `auth`, `audit`);
  la referencia llegó a un servicio de 5.362 líneas.
- Nombres en inglés según el glosario de `docs/ESTADO.md`.
- Dinero en **enteros de pesos**; porcentajes como `Numeric(5,2)`. Nada de `Float`
  para plata ni para cantidades.
- `business_date` como `Date` en columna propia, calculado en el backend con
  `America/Bogota` y la hora de corte de la sede; `created_at` en UTC y serializado
  con marca de zona (`Z`). El frontend nunca hace `new Date("YYYY-MM-DD")` ni
  `toISOString().slice(0, 10)` para «hoy»: helpers únicos (`tz.py`,
  `businessDate.ts`).
- Errores con una sola forma `{ "error": { "code", "message" } }`; reglas de negocio
  en `400` con código propio y mensaje para humanos que nombra la acción correctiva;
  validación de esquema normalizada a la misma forma; `409` para concurrencia;
  `401`/`403` para sesión y permisos. Nunca `500` por una regla de negocio.
- Toda escritura que mueve plata o estado (`send`, `payments`, `shifts/open`,
  `shifts/close`, `cash-movements`, `void`) acepta `Idempotency-Key`; la clave se
  reserva dentro de la transacción y un replay devuelve la respuesta original.
- El operador nunca recibe `unit_cost`, `margin` ni nada de costos: los esquemas
  Pydantic de respuesta para dispositivo no tienen esos campos (test sobre OpenAPI).
- Constraints en la base, no sólo en código: un turno abierto por sede (índice único
  parcial), una comanda abierta por mesa (índice único parcial), consecutivo de
  tiquete único por sede, `Idempotency-Key` única por alcance.
- PostgreSQL en CI; SQLite permitido en desarrollo y tests con `busy_timeout` y
  evitando las trampas listadas en la spec de negocio §12.
- Todo campo nuevo de respuesta es opcional en los tipos del frontend.

## API contract (English — technical artifact)

The team builds against this contract from day one. The backend may add fields but
must not rename or remove these; the frontend must not consume routes that are not
here without reporting them as a gap. All routes are under `/api/v1`. Money is
integer COP. Instants are ISO-8601 UTC with `Z`; `business_date` is `YYYY-MM-DD`.
Every error has the shape `{ "error": { "code": "...", "message": "..." } }`.

### Auth
- `POST /auth/admin/login` `{email, password}` → sets httpOnly cookie; returns `{user: {id, name, role}}`.
- `POST /auth/device/activate` `{store_id, store_pin}` → sets long-lived device cookie; returns `{store: {id, name, cutoff_hour}}`.
- `POST /auth/device/identify` `{employee_id, pin}` → binds the employee to the device session server-side; returns `{employee: {id, name, role, can_charge, discount_limit_pct}}`.
- `POST /auth/device/release` → clears the active employee.
- `POST /auth/device/deactivate` → clears the device session (called after close).
- `POST /auth/admin-pin/verify` `{pin}` → `{authorized: true, admin_id}` for one-shot authorizations (the actual privileged endpoints also accept `admin_pin` in the body and re-verify).
- `POST /auth/logout`; `GET /auth/me` → `{kind: "admin" | "device", user | store, employee?}`.

### Catalog (admin writes, device reads)
- `GET /catalog` → `{categories: [{id, name, sort}], products: [{id, category_id, name, description, station, prices: {dine_in, takeout, delivery}, tax_rate, available, modifier_groups: [{id, name, required, min, max, options: [{id, name, price_delta}]}]}], combos: [{id, name, price, groups: [{id, name, options: [{id, name}]}]}]}`. **No cost fields.**
- Admin CRUD: `/admin/categories`, `/admin/products`, `/admin/modifier-groups`, `/admin/combos`. Soft delete with `active=false`.
- `POST /products/{id}/availability` `{available: bool}` — device (records who) or admin.

### Store, zones, tables, employees, settings
- `GET /tables` → `[{id, zone_id, zone_name, number, seats, status: "free"|"open"|"to_pay", open_order_id?, open_since?, total?}]`.
- Admin CRUD: `/admin/zones`, `/admin/tables`, `/admin/employees` (`{name, role, pin, can_charge, discount_limit_pct}`; PIN stored hashed, never returned; deactivate, never delete).
- `GET/PUT /admin/settings/{store_id}` → `{tax: {regime: "inc_8"|"iva_19", price_includes_tax, valid_from}, tip_suggested_pct, discount_limit_pct, payment_methods: [...], ticket: {prefix, next_number, business_name, nit, address, phone, footer, paper_width_mm, dian_resolution?: {number, date, prefix, range_from, range_to, valid_until}}, cutoff_hour, cash_difference_tolerance, cash_difference_critical, uvt_value}`.

### Business day & shifts
- `GET /shifts/current` → open shift for the device's store or `null`; includes `expected_cash`, `is_stale` (past cutoff), roster.
- `POST /shifts/open` `{opening_cash: {denominations: [{value, count}], total}, cash_reserve, employee_ids: [...], justification?}` → `400 SHIFT_ALREADY_OPEN` / `409` on race; `400 OPENING_DIFFERENCE_NEEDS_JUSTIFICATION` when `total != expected_opening_cash` and no justification.
- `POST /shifts/{id}/roster` `{employee_id, action: "in"|"out"}` — who enters/leaves; `out` requires the counted cash (`handover`).
- `POST /shifts/{id}/handovers` `{counted_cash: {denominations, total}, counted_card?, note?}` → stores the frozen breakdown (`base, cash_sales, incomes, expenses, pickups, expected, counted, difference`).
- `POST /shifts/{id}/cash-movements` `{kind: "income"|"expense", amount, reason, receipt_image?}`.
- `POST /shifts/{id}/pickups` `{amount, admin_pin, note?}` — owner takes cash out.
- `POST /shifts/{id}/close` `{counted_cash: {denominations, total}, counted_card, counted_transfer, tips_cash_out, difference_seen, justification?, transfer_open_orders?: bool, photo?}` → atomic; `400 DIFFERENCE_CHANGED` with the recomputed difference when `difference_seen` is stale; `400 DIFFERENCE_NEEDS_JUSTIFICATION`; `400 OPEN_ORDERS_BLOCK_CLOSE` listing order ids unless `transfer_open_orders`; `400 CARD_TOTAL_REQUIRED` when there were card sales.
- `GET /shifts/{id}` → summary: sales by payment method, movements, pickups, handovers, expected vs counted, difference, `to_deposit`, roster, tips by method.
- Admin rescues: `POST /admin/shifts/{id}/close-administrative` `{reason}` (only stale shifts), `POST /admin/shifts/{id}/reopen` `{reason}`, `DELETE /admin/shifts/{id}` (only without activity), `POST /admin/shifts/{id}/adjust-opening` `{opening_cash, cash_reserve, reason}`.

### Orders
- `POST /orders` `{channel: "dine_in"|"takeout"|"delivery", table_id?, covers?, note?}` → `400 NO_OPEN_SHIFT`; `409 TABLE_ALREADY_OPEN`.
- `GET /orders?status=open`; `GET /orders/{id}` → full order with items, states and timestamps.
- `POST /orders/{id}/items` `[{product_id | combo_id, qty, modifiers: [{option_id}], combo_selections?: [{group_id, option_id}], note?}]` → items in `pending`; each item snapshots `name, unit_price, tax_rate, unit_cost (null), recipe_version (null), modifiers_text`.
- `POST /orders/{id}/send` (Idempotency-Key) → all `pending` → `sent`, stamps `sent_at`.
- `PATCH /orders/{id}/items/{item_id}` `{qty?, note?}` — only while `pending`.
- `POST /orders/{id}/items/{item_id}/void` `{reason, admin_pin?}` — `pending` voids freely; `sent`/`ready` require `admin_pin` → `400 ADMIN_PIN_REQUIRED`; a voided sent item is recorded as `void_after_send` (waste hook for phase 2).
- `POST /orders/{id}/items/{item_id}/courtesy` `{reason, admin_pin}`.
- `POST /orders/{id}/items/{item_id}/ready` and `/served` (Idempotency-Key) — used by the phase-2 kitchen view; available now.
- `POST /orders/{id}/merge` `{from_order_id}` — moves items; source becomes `merged`.
- `POST /orders/{id}/move` `{table_id}`.
- `POST /orders/{id}/void` `{reason, admin_pin?}` — admin PIN required if any item was sent.
- `POST /orders/{id}/discounts` `{scope: "order"|"item", item_id?, kind: "percent"|"amount", value, reason, admin_pin?}` → `400 DISCOUNT_LIMIT_EXCEEDED` without admin PIN above the limit; never exceeds the line gross.

### Checkout
- `GET /orders/{id}/bill` → `{subtotal, discount_total, tax_lines: [{rate, base, tax}], tip_suggested, total}`.
- `POST /orders/{id}/payments` (Idempotency-Key) `{tip: {asked: true, accepted: bool, amount}, splits: [{method: "cash"|"card"|"transfer"|"platform"|"other", amount, reference?, tendered?}], customer?: {name, document, email}, requests_invoice?: bool}` → creates the ticket; returns `{ticket: {id, number, prefix, ...}, change}`; `409 ORDER_ALREADY_PAID` on a concurrent payment; the same key replays the original response; `400 INVOICE_REQUIRED_ABOVE_THRESHOLD` is **not** an error but a flag `requires_invoice: true` in the response when net total > 5 UVT.
- `GET /tickets/{id}` → printable ticket (items with modifiers, discounts, tax lines, tip, payments, change, table, channel, employee names, store data, DIAN resolution fields).
- `GET /tickets/last` → last ticket of the current shift (reprint).
- `POST /admin/tickets/{id}/credit-note` `{reason, lines: [{item_id, used: bool}], refund: {method, amount}?}` → ticket becomes `reversed`; cash refund creates an expense in the open shift or a pending refund.

### Admin reports (phase 1 minimum)
- `GET /admin/today?store_id` → sales by hour, gross and net sales, tips, avg ticket, orders count, open orders, expected cash, alerts (no shift / stale shift, differences, voids, discounts, unavailable products).
- `GET /admin/sales?from&to&store_id&group_by=business_date|shift|method|channel|employee|hour` → rows with `gross, net, tax, tips, orders, avg_ticket`.
- `GET /admin/accountant-report?year&month&store_id` → per business date: by method, by tax rate, credit notes, tips, running total.
- `GET /admin/tickets?from&to&...`; `GET /admin/credit-notes?from&to`.
- `GET /admin/orders?from&to&status` → with voids, courtesies and discounts by employee and reason; table and kitchen times.
- `GET /admin/shifts?from&to` → per shift: roster, expected, counted, difference, justification, pickups, to_deposit; `GET /admin/shifts/{id}/timeline`.
- `GET /admin/employees/{id}/activity?from&to` → sales, voids, discounts, differences, shifts.
- `GET /admin/audit?from&to&entity&employee_id` → audit rows with before/after.
- Every list endpoint accepts `format=csv`.

## Verificación de la fase (checklist de entrega)

Además de la sección 16 de la spec de negocio (fase 1), completa:

- [ ] `alembic upgrade head` desde cero crea el esquema; el seed corre con un comando
      aparte, no al arrancar.
- [ ] Un tiquete guarda `unit_price`, `tax_rate` y `modifiers_text` por ítem, y un
      cambio posterior de la carta no lo altera (test).
- [ ] `POST /orders/{id}/payments` con la misma `Idempotency-Key` devuelve la misma
      respuesta y no crea un segundo tiquete (test); lo mismo para `send`.
- [ ] Dos `POST /orders/{id}/payments` concurrentes: uno `200`, otro `409` (test).
- [ ] Dos `POST /shifts/open` concurrentes: uno `200`, otro `409` (test).
- [ ] `POST /shifts/close` con diferencia ≠ 0 sin `justification` → `400` (test); con
      `difference_seen` desactualizada → `400 DIFFERENCE_CHANGED` con la nueva.
- [ ] La reserva declarada al abrir no cambia el esperado del cierre (test).
- [ ] `POST /orders` sin turno abierto → `400 NO_OPEN_SHIFT` con mensaje que nombra la
      acción (test).
- [ ] Los esquemas de respuesta usados por el dispositivo no tienen `unit_cost` (test
      que inspecciona el OpenAPI).
- [ ] La cookie de sesión es `httpOnly`; no hay `localStorage.setItem` de tokens en el
      frontend (grep en el paso de verificación).
- [ ] Una venta a las 00:30 Bogotá cae en el día del turno; una a las 10:00 sobre un
      turno pasado de la hora de corte se sella con hoy (test de zona horaria).
- [ ] POS en 375 px y en 1024 px sin scroll horizontal; foco visible; contraste AA.
- [ ] Typecheck backend y frontend, suite completa y build, una vez, en serie.
