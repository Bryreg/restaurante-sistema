# Fase 1 — Fundación y venta

Spec del primer pedido al orquestador. Depende de `docs/SPEC-NEGOCIO.md` (la spec
de negocio) y de `AGENTS.md` (lo que este proyecto hace distinto). Si algo de acá
contradice a la spec de negocio, manda la spec de negocio y se corrige acá.

## Objetivo

Que el restaurante pueda **operar un día completo** con el sistema: activar la
tablet, abrir turno de caja, abrir mesas, tomar comandas, enviarlas a cocina,
cobrar con pagos mixtos, propina e impuesto, imprimir el tiquete, y cerrar la caja
con conteo y diferencia. Y que el administrador pueda ver, en PC, qué se vendió,
qué comandas hubo y cómo cuadró cada turno.

Recetas, inventario y compras son de la **fase 2**: en esta fase el modelo de datos
los deja previstos (tablas y relaciones de las secciones 4 y 5 de la spec pueden
existir vacías o no existir; lo que NO puede pasar es que el modelo de venta impida
agregarlas después: el ítem de comanda ya congela `unit_cost` y `recipe_version`).

## Alcance

**Entra**

- Secciones 2, 3, 6 (sólo caja física y movimientos de caja), 7, 8 y 9 de la spec
  de negocio, con las reglas duras de la sección 11 completas.
- Autenticación: administrador (correo + contraseña, JWT en cookie `httpOnly`);
  dispositivo de salón (activación con PIN de sede → sesión larga en cookie
  `httpOnly`); PIN personal de 4 dígitos por empleado para atribuir acciones.
- Sedes, zonas, mesas, empleados, carta **plana** (categorías, productos con precio
  por canal y tasa de impuesto, disponible sí/no, modificadores con ajuste de
  precio). Sin recetas todavía.
- Día operativo y turno de caja con todos sus gates; movimientos de caja; retiros.
- Comanda con estados, ítems con estados, envío a cocina, anulaciones con
  autorización, cortesías, unir mesas, traslado de comandas al turno siguiente.
- Cobro: pagos mixtos, división de cuenta, propina preguntada y separada,
  descuentos con límite y autorización, impuesto por tasa de producto, tiquete
  con consecutivo sin huecos, idempotencia y `409`.
- Nota crédito sobre venta cobrada (sólo admin).
- POS completo (sección 9.1 salvo las herramientas de merma y producción).
- Admin: Hoy, Ventas, Pedidos, Turnos y personal, Configuración (sección 9.2).
- Auditoría: registro de quién, cuándo y qué en toda escritura financiera.
- Seed de desarrollo: una sede, un admin, tres empleados, dos zonas con ocho
  mesas, una carta de veinte productos con modificadores.

**No entra** (y no se toca por iniciativa propia)

- Insumos, preparaciones, recetas, consumo teórico, mermas, conteos, compras.
- Vista de cocina, impresora térmica, facturación electrónica, nómina, banco.
- Modo sin conexión más allá de tolerar cortes breves.

## Convenciones de ingeniería de esta fase

- Estructura: `backend/app/{core,models,schemas,routers,services}`, `backend/tests`,
  `backend/alembic` (migraciones desde el primer día: la referencia migró "a mano"
  desde `main.py` y pagó por eso); `frontend/src/{api,components,features,pages}`,
  tests con vitest junto al componente.
- Nombres en inglés según el glosario de `docs/ESTADO.md`.
- Dinero en **enteros de pesos** (COP no usa centavos); porcentajes como
  `Numeric(5,2)`. Nada de `Float` para plata.
- `business_date` como `Date` en columna propia, calculada en el backend con
  `America/Bogota`; `created_at` en UTC.
- Toda respuesta de error con la misma forma `{ "error": { "code", "message" } }`;
  los errores de negocio (sin turno, sin autorización, diferencia sin justificar)
  con código propio y `422`, no `500`.
- El operador nunca recibe `unit_cost`, `margin` ni nada de costos: los esquemas
  Pydantic de respuesta para operador no tienen esos campos, no se filtran después.

## API contract (English — technical artifact)

The team builds against this contract from day one. The backend may add fields
but must not rename or remove these; the frontend must not consume routes that
are not here without reporting them as a gap. All routes are under `/api/v1`.
Money is integer COP. Timestamps are ISO-8601 UTC; `business_date` is `YYYY-MM-DD`.

### Auth
- `POST /auth/admin/login` `{email, password}` → sets httpOnly cookie; returns `{user: {id, name, role}}`.
- `POST /auth/device/activate` `{store_id, store_pin}` → sets long-lived device cookie; returns `{store: {id, name}}`.
- `POST /auth/device/identify` `{employee_id, pin}` → returns `{employee: {id, name, role, permissions: [...]}}` and binds the employee to the device session until `POST /auth/device/release`.
- `POST /auth/logout`.
- `GET /auth/me` → `{kind: "admin" | "device", user | store, employee?}`.

### Catalog (admin writes, device reads)
- `GET /catalog` → `{categories: [{id, name, sort}], products: [{id, category_id, name, description, prices: {dine_in, takeout, delivery}, tax_rate, available, modifier_groups: [{id, name, required, min, max, options: [{id, name, price_delta}]}]}]}`. **No cost fields in this response.**
- `POST/PATCH /admin/categories`, `/admin/products`, `/admin/products/{id}/modifier-groups` — admin CRUD; products soft-deleted with `active=false`.
- `POST /products/{id}/availability` `{available: bool}` — device or admin (the "86").

### Store, zones, tables, employees
- `GET /tables` → `[{id, zone_id, zone_name, number, seats, status: "free"|"open"|"to_pay", open_order_id?, open_since?, total?}]`.
- Admin CRUD: `/admin/zones`, `/admin/tables`, `/admin/employees` (`{name, role, pin}`; PIN stored hashed, never returned).

### Business day & shifts
- `GET /shifts/current` → open shift for the device's store or `null`.
- `POST /shifts/open` `{opening_cash: {denominations: [{value, count}], total}, employee_ids: [...], opening_justification?}` → 422 `SHIFT_ALREADY_OPEN` if one exists; requires justification when `total != expected_opening_cash`.
- `POST /shifts/{id}/cash-movements` `{kind: "income"|"expense"|"pickup", amount, reason, receipt_image?, authorized_by_pin?}` — `pickup` requires admin PIN.
- `POST /shifts/{id}/close` `{counted_cash: {denominations, total}, counted_card, counted_transfer, justification?}` → computes `expected_cash`, `difference`; 422 `DIFFERENCE_NEEDS_JUSTIFICATION`; 422 `OPEN_ORDERS_BLOCK_CLOSE` listing order ids unless `transfer_open_orders: true`.
- `GET /shifts/{id}` → summary: sales by payment method, movements, expected vs counted, difference, employees.

### Orders
- `POST /orders` `{channel: "dine_in"|"takeout"|"delivery", table_id?, covers?, customer_note?}` → 422 `NO_OPEN_SHIFT`; 409 `TABLE_ALREADY_OPEN`.
- `GET /orders/{id}` → full order with items and states.
- `POST /orders/{id}/items` `[{product_id, qty, modifiers: [{option_id}], note?}]` → items in `pending`; each item snapshots `unit_price`, `tax_rate`, `unit_cost` (nullable until phase 2), `modifiers_text`.
- `POST /orders/{id}/send` → all `pending` items → `sent`, stamps `sent_at`.
- `PATCH /orders/{id}/items/{item_id}` `{qty?, note?}` — only while `pending`.
- `POST /orders/{id}/items/{item_id}/void` `{reason, admin_pin?}` — `pending` voids freely; `sent`/`ready` require admin PIN → 422 `ADMIN_PIN_REQUIRED`.
- `POST /orders/{id}/items/{item_id}/courtesy` `{reason, admin_pin}`.
- `POST /orders/{id}/items/{item_id}/ready` and `/served` — state transitions (used by phase 2 kitchen view; available now).
- `POST /orders/{id}/merge` `{from_order_id}` — moves items, closes the source as `merged`.
- `POST /orders/{id}/move` `{table_id}`.
- `POST /orders/{id}/void` `{reason, admin_pin?}` — admin PIN required if any item was sent.
- `POST /orders/{id}/discounts` `{scope: "order"|"item", item_id?, kind: "percent"|"amount", value, reason, admin_pin?}` → 422 `DISCOUNT_LIMIT_EXCEEDED` without admin PIN above the store limit.
- `GET /orders?status=open` — open orders for the device's store.

### Checkout
- `GET /orders/{id}/bill` → `{subtotal, discount_total, tax_lines: [{rate, base, tax}], tip_suggested, total_before_tip}`.
- `POST /orders/{id}/payments` with header `Idempotency-Key`: `{tip: {asked: true, accepted: bool, amount}, splits: [{method: "cash"|"card"|"transfer"|"platform"|"other", amount, reference?, tendered?}], customer?: {name, document, email}, requests_invoice?: bool}` → creates ticket, returns `{ticket: {id, number, prefix, ...}, change}`; 409 `ORDER_ALREADY_PAID` on concurrent payment; same key replays the original response.
- `GET /tickets/{id}` → printable ticket data (items, discounts, tax lines, tip, payments, change, employee name, store data, DIAN resolution fields).
- `POST /admin/tickets/{id}/credit-note` `{reason, refund: {method, amount}?}`.

### Admin reports (phase 1 minimum)
- `GET /admin/today?store_id` → sales by hour, net sales, avg ticket, orders count, open orders, expected cash, alerts (differences, voids, unavailable products).
- `GET /admin/sales?from&to&store_id&group_by=day|shift|method|channel|employee|hour` → rows with `net_sales, tax, tips, gross, orders`.
- `GET /admin/tickets?from&to&...` and `GET /admin/credit-notes`.
- `GET /admin/orders?from&to&status` → with `voids` and `discounts` by employee and reason.
- `GET /admin/shifts?from&to` → per shift: employees, expected, counted, difference, justification.
- `GET /admin/employees/{id}/activity?from&to` → sales, voids, discounts, shifts.
- `GET/PUT /admin/settings/{store_id}` → tax regime (`inc_8` | `iva_19`), prices include tax, tip suggested %, discount limit %, payment methods enabled, ticket prefix and DIAN resolution data, UVT value.
- Every list endpoint accepts `format=csv`.

## Verificación de la fase (checklist de entrega)

Además de la sección 15 de la spec de negocio (fase 1), completa:

- [ ] `alembic upgrade head` desde cero crea el esquema y el seed corre.
- [ ] Un tiquete guarda `unit_price`, `tax_rate` y `modifiers_text` por ítem, y un
      cambio posterior de la carta no lo altera (test).
- [ ] `POST /orders/{id}/payments` con la misma `Idempotency-Key` devuelve la misma
      respuesta y no crea un segundo tiquete (test).
- [ ] Dos `POST /orders/{id}/payments` concurrentes: uno `200`, otro `409` (test).
- [ ] `POST /shifts/close` con diferencia ≠ 0 sin `justification` → `422` (test).
- [ ] `POST /orders` sin turno abierto → `422 NO_OPEN_SHIFT` (test).
- [ ] Los esquemas de respuesta usados por el dispositivo no tienen `unit_cost`
      (test que inspecciona el OpenAPI).
- [ ] La cookie de sesión es `httpOnly`; no hay `localStorage.setItem` de tokens en
      el frontend (grep en el paso de verificación).
- [ ] POS en 375 px y en 1024 px sin scroll horizontal; foco visible; contraste AA.
- [ ] Typecheck backend y frontend, suite completa y build, una vez, en serie.
