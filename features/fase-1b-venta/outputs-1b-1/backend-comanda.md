# backend-comanda — Entrega (pedido 1b-1)

Territorio: `backend/app/orders/**`, `backend/app/kitchen/**` (solo `router.py`,
sin modelos), `backend/alembic/versions/0004_orders.py`,
`backend/tests/orders/**`, `backend/tests/kitchen/**`.

## 1. Resumen

Implementado completo el dominio de la comanda de Restaurante Sistema para
1b-1: modelos y migración `0004`, la única matemática de la venta
(`app/orders/money.py`), los hooks cruzados con el turno de caja
(`app/orders/hooks.py`), el servicio (`app/orders/service.py`, ~1600 líneas)
con las firmas públicas que llaman `backend-cobro` y `backend-base`, los
esquemas (`app/orders/schemas.py`) con `OrderOut` tal cual §2.4, el router de
comandas (`app/orders/router.py`, 23 endpoints) y la vista mínima de cocina
(`app/kitchen/router.py`). Canales `counter`, `dine_in`, `takeout` y
`staff_meal` detrás de sus flags; mesas con unión/movimiento; comandas con
versión optimista e `Idempotency-Key`; rondas numeradas con contador de
porciones; anulación con motivo tipado y stub de merma; cortesía; descuentos
por ítem/comanda con límite y notificación; precuenta con propina sugerida
≤10 %; división de cuenta por partes iguales y por ítems con sub-cuentas;
admin de comandas con filtros, flags y CSV.

Verificado: **81/81 tests propios pasan** (`tests/orders` + `tests/kitchen`,
corridos dos veces — antes y después de los ajustes de mypy — con el mismo
resultado), `mypy app` **limpio en las 67 fuentes del repo completo** (no solo
las mías: corrí el typecheck total porque ya no reportaba errores ajenos a
medio escribir), migración `0004` sube y baja limpio encadenada con `0001` a
`0005` (backend-cobro ya entregó `0005` durante esta construcción), y los dos
tests E2E de `backend-base` que dependen de mis hooks
(`tests/shifts/test_open_orders_gate.py`) pasan contra mi implementación.

Un hallazgo real corregido durante la construcción: `GET /tables/status` y
`GET /kitchen/rounds` estaban gateadas con `Depends(features.require_feature(...))`,
que resuelve `current_actor` → `current_operator` por dentro y por lo tanto
exige una persona identificada y vigente — rompiendo la promesa del contrato
de que son lecturas de dispositivo con persona **opcional** (una pantalla de
cocina sin nadie identificado, o un sondeo después de que la ventana
deslizante de 3 minutos expiró). Corregido: esas dos rutas validan la función
a mano con `features.assert_feature(...)` sobre el actor real
(`current_device`), sin pasar por `current_operator`. Ver §6.1.

## 2. Archivos tocados

```
backend/app/orders/__init__.py
backend/app/orders/models.py
backend/app/orders/money.py
backend/app/orders/hooks.py
backend/app/orders/service.py
backend/app/orders/schemas.py
backend/app/orders/router.py
backend/app/kitchen/__init__.py
backend/app/kitchen/router.py
backend/alembic/versions/0004_orders.py
backend/tests/orders/__init__.py
backend/tests/orders/conftest.py
backend/tests/orders/test_money.py
backend/tests/orders/test_create.py
backend/tests/orders/test_items.py
backend/tests/orders/test_send.py
backend/tests/orders/test_void_courtesy.py
backend/tests/orders/test_discounts.py
backend/tests/orders/test_authorizations.py
backend/tests/orders/test_limits.py
backend/tests/orders/test_bill.py
backend/tests/orders/test_merge_move.py
backend/tests/orders/test_business_date.py
backend/tests/orders/test_isolation.py
backend/tests/orders/test_admin.py
backend/tests/kitchen/__init__.py
backend/tests/kitchen/conftest.py
backend/tests/kitchen/test_rounds.py
```

No toqué ningún archivo de otro territorio (`app/catalog`, `app/stores`,
`app/shifts`, `app/auth`, `app/core`, `app/payments`, `app/fiscal`,
`tests/conftest.py`, `docs/ESTADO.md`, `.claude/launch.json`, frontend).

## 3. Firmas públicas implementadas (§2.3, sin desviaciones de firma)

`app/orders/money.py`:
- `round_half_up(numerator: int, denominator: int) -> int`
- `prorate(amount: int, weights: list[int]) -> list[int]`
- `LineInput`, `LineTotals`, `TaxLine`, `OrderTotals` (dataclasses frozen, campos exactos al contrato)
- `compute_totals(lines: list[LineInput], order_discounts: list[tuple[str, int]]) -> OrderTotals`

`app/orders/hooks.py` (no importa `app.orders.service`; solo modelos):
- `count_open_orders(db, *, shift_id: int) -> int`
- `detach_open_orders(db, *, shift_id: int, actor: Actor) -> list[int]`
- `adopt_transferred_orders(db, *, store_id: int, shift: Shift, actor: Actor) -> list[int]`

`app/orders/service.py` (lo llaman `backend-cobro` y `backend-base`):
- `get_order_or_404(db, *, actor, order_id) -> Order`
- `compute_order_totals(db, order) -> OrderTotals`
- `compute_sub_account_totals(db, sub_account) -> OrderTotals`
- `order_out(db, order, *, for_device: bool) -> OrderOut`
- `assert_payable(db, order, *, sub_account) -> None`
- `claim_payment(db, order, *, sub_account, actor, now) -> bool`
- `auto_send_pending_for_payment(db, order, *, actor, now) -> int`
- `business_date_for_sale(db, shift, store, now) -> date`

Todas con la firma literal del contrato. Además expongo (no listadas en el
contrato pero necesarias para que `backend-cobro` no tenga que reimplementar
nada): `get_sub_account_or_404(db, order, sub_account_id) -> OrderSubAccount`
y `list_sub_accounts(db, order) -> list[OrderSubAccount]`.

## 4. Endpoints expuestos (todos bajo `/api/v1`)

| Método y ruta | Gate | Lectura/escritura | Idempotencia |
|---|---|---|---|
| `GET /tables/status` | `pos.tables` (a mano, ver §6.1) | `current_device` | — |
| `POST /orders` | canal → flag body-dependiente (`assert_feature` en servicio) | `current_operator` | — |
| `GET /orders` | — | `current_device` | — |
| `GET /orders/favorites` | — | `current_device` | — |
| `GET /orders/{id}` | — | `current_device` | — |
| `POST /orders/{id}/items` | — (flags por ítem: seats/courses/modifiers/combos en servicio) | `current_operator` | scope `orders.items` |
| `PATCH /orders/{id}/items/{item_id}` | — | `current_operator` | — |
| `POST /orders/{id}/send` | `kitchen.view` | `current_operator` | scope `orders.send` |
| `POST /orders/{id}/items/{item_id}/ready` | `kitchen.view` | `current_device` | scope `orders.ready` |
| `POST /orders/{id}/items/{item_id}/served` | — | `current_operator` | scope `orders.served` |
| `POST /orders/{id}/items/{item_id}/void` | — | `current_operator` | — |
| `POST /orders/{id}/items/{item_id}/courtesy` | `pos.courtesies` | `current_operator` | — |
| `POST /orders/{id}/discounts` | `pos.discounts` | `current_operator` | — |
| `DELETE /orders/{id}/discounts/{discount_id}` | `pos.discounts` | `current_operator` | — |
| `POST /orders/{id}/merge` | `pos.tables` | `current_operator` | — |
| `POST /orders/{id}/move` | `pos.tables` | `current_operator` | — |
| `POST /orders/{id}/void` | — | `current_operator` | — |
| `POST /orders/{id}/bill/present` | `pos.pre_bill` | `current_operator` | scope `orders.bill_present` |
| `POST /orders/{id}/bill/split` | `pos.split_bill` | `current_operator` | — |
| `GET /orders/{id}/sub-accounts` | — | `current_device` | — |
| `GET /admin/orders` (+ `format=csv`) | — | `current_admin` + `admin_store` | — |
| `GET /admin/orders/{id}` | — | `current_admin` + `admin_store` | — |
| `GET /kitchen/rounds` | `kitchen.view` (a mano, ver §6.1) | `current_device` | — |

Toda mutación con `expected_version` responde `409 STALE_VERSION` con
`extra.order` = `OrderOut` completo (serializado con `model_dump(mode="json")`).
`record_audit` en toda escritura de negocio (`create`, `add_items`, `send`,
`void` de ítem y de comanda, `courtesy`, descuento, `merge`).

## 5. Tablas de `0004_orders.py` (coinciden columna por columna con `app/orders/models.py`)

`orders`, `order_tables` (+ índice único parcial
`uq_order_tables_one_open_per_table` sobre `table_id` `WHERE released_at IS NULL`,
`postgresql_where` y `sqlite_where`), `order_rounds` (+ `UNIQUE(order_id, round_no)`),
`order_items`, `order_discounts`, `order_sub_accounts` (+
`UNIQUE(order_id, seq)`), `order_sub_account_items`, `order_events`,
`waste_stubs`. Índice por cada FK y por cada filtro de pantalla
(`(store_id, status)`, `(store_id, business_date)`, `(order_id, status)` en
ítems, `(order_id, at)` en eventos). `downgrade()` en orden inverso exacto.

Verificado encadenado con el resto del repo: `0001 → 0002 → 0003 → 0004 → 0005`
sube y `downgrade base` baja limpio (backend-cobro ya había entregado `0005`
para cuando corrí la verificación).

## 6. Decisiones declaradas

### 6.1 `require_feature` como *dependency* en rutas de lectura de dispositivo (corrección, no desviación de contrato)

`app.core.features.require_feature(key)` resuelve `Depends(current_actor)`
internamente, y `current_actor` cae a `current_operator` cuando no hay sesión
de admin — es decir, **exige una persona identificada y vigente**. Usarlo
como `dependencies=[Depends(...)]` en una ruta de **dispositivo** (persona
opcional, como pide el contrato para `GET /tables/status` y
`GET /kitchen/rounds`) rompe exactamente ese contrato: una pantalla de cocina
sin nadie identificado, o cualquier sondeo después de que la ventana
deslizante de la persona (`EMPLOYEE_SESSION_MINUTES`, default 3 minutos)
expiró, recibiría `401 IDENTIFY_REQUIRED` en vez de la lista (vacía o no) que
le corresponde. Lo encontré con un test propio
(`test_kitchen_rounds_semaphore_with_clock`, que mueve el reloj 12 minutos
entre pedidos) y lo corregí: esas dos rutas llaman
`features.assert_feature(db, actor.organization_id, actor.store_id, key)` a
mano, sobre el actor de `current_device`, sin pasar por `require_feature`
como dependencia. Las rutas de escritura (`current_operator`) sí usan
`require_feature` como dependencia normalmente, porque ya exigen persona
identificada por su cuenta.

### 6.2 `DELETE /orders/{id}/discounts/{discount_id}`: `expected_version` en query, no en body

El contrato lo escribe como `{expected_version}` sin aclarar si va en el
body o en la query. `DELETE` con cuerpo JSON no es confiable entre clientes
HTTP (ni `httpx`/`TestClient` en este repo lo soporta con `.delete(json=...)`,
ni todos los `fetch()` de navegador lo garantizan). Lo dejé como
`?expected_version=N` en la query string; `frontend-comanda` tiene que
mandarlo así.

### 6.3 Descuento de comanda: `OrderDiscount.amount` es una foto al crear, no se recalcula en cada lectura

`compute_order_totals` siempre recalcula el total real desde `(kind, value)`
de cada descuento de comanda vivo (fuente de verdad, invariante `Σ prorrateo
== descuento`). El campo `OrderDiscount.amount` (el que usan
`test_limits.py` y la alerta `discount_rate_high` para el acumulado por
persona/turno) queda congelado con el monto calculado al momento de crear el
descuento. Si se agregan ítems a la comanda *después* de aplicar un
descuento porcentual de comanda, el total recalculado en vivo sigue siendo
exacto, pero el `amount` histórico de ese descuento no se actualiza
retroactivamente — es una foto de auditoría, no un valor derivado en cada
lectura. Coherente con cómo se trata el descuento de línea (siempre
congelado) y evita recorridos costosos en cada `GET`.

### 6.4 `order_out(db, order, *, for_device)`: el parámetro existe pero hoy no cambia nada

`unit_cost`/`recipe_version` quedan siempre `NULL` en 1b (fase 2 los llena) y
`OrderItemOut` nunca los serializa, para ningún actor. El parámetro
`for_device` se mantiene en la firma (así lo pide el contrato) para que
`backend-cobro` y una futura fase 2 puedan diferenciar sin tocar la firma,
pero hoy ambas ramas producen el mismo `OrderOut`.

### 6.5 `OrderOut.document_id` se resuelve leyendo `app.fiscal.models.FiscalDocument` con `find_spec_safe`

`Order` no tiene columna `document_id` propia (no está en el modelo del
contrato): el documento fiscal es de `backend-cobro`. `order_out` busca el
último `FiscalDocument` con `order_id` igual y `sub_account_id` nulo, con el
mismo patrón `find_spec_safe` que usa `backend-base` para sus hooks — así
funciona sin acoplarse en duro a un módulo que podía no existir todavía
durante la construcción en paralelo, y automáticamente empieza a devolver el
id real ahora que `app/payments`/`app/fiscal` ya existen.

### 6.6 `bill/split` por asiento (`pos.seats` deriva `groups` de `seat`) — no implementado

El contrato menciona "`pos.seats` permite `groups` derivados de `seat`" sin
especificar la forma exacta de ese atajo. Implementé el modo `items`
completo tal como lo describe el bloque de request/response (`groups` con
`item_ids` y `shared` explícitos, unificados internamente antes de repartir
por `money.prorate`), pero no agregué un modo abreviado que arme `groups`
automáticamente a partir de `OrderItem.seat` cuando `pos.seats` está
encendida. El frontend puede construir esos `groups` a partir de los
`seat` de cada ítem con la información que ya tiene en `OrderOut.items`.
Declarado en `gaps`.

### 6.7 Reglas de validación no explícitas en el contrato, decididas con criterio conservador

- Anular un ítem que **ya está anulado** responde `400 VALIDATION_ERROR`
  ("Este ítem ya está anulado") — el contrato no define un código para este
  caso puntual.
- `bill/split` en modo `items` cuando ya existe una división previa **sin
  ninguna sub-cuenta pagada**: la reemplaza por completo (se borran las
  filas viejas y se crean las nuevas). Si alguna sub-cuenta ya está pagada,
  `400 VALIDATION_ERROR` ("Ya hay sub-cuentas pagadas: no se puede rehacer
  la división") — tampoco tiene código propio en el contrato.
- `merge`: las rondas (`OrderRound`) de la comanda origen **no se mueven**
  con los ítems (mover la fila rompería `UNIQUE(order_id, round_no)` contra
  las rondas ya existentes de la destino). Los ítems movidos conservan su
  `round_no` propio (queda en el ítem, visible), pero el arreglo `rounds` de
  la comanda destino en `OrderOut` sólo lista las rondas creadas
  directamente para ella. No afecta cocina (que filtra por `round_id`
  real) ni la matemática de la venta; sólo es una imprecisión menor en el
  resumen de rondas después de una unión.

## 7. Comandos de verificación (resultados literales)

```
$ mkdir -p /tmp/pt-backend-comanda && cd backend && TMPDIR=/tmp/pt-backend-comanda python -m pytest tests/orders tests/kitchen -q -x
........................................................................ [ 88%]
.........                                                                [100%]
81 passed, 129 warnings in 194.45s (0:03:14)
```

(Corrido dos veces con el mismo resultado — 81/81 — la segunda vez después de
las correcciones de mypy.)

```
$ cd backend && python -m mypy app
Success: no issues found in 67 source files
```

(Typecheck del repo completo, no sólo mi territorio: para cuando terminé ya
no quedaban archivos ajenos a medio escribir.)

```
$ cd backend && rm -f /tmp/pt-backend-comanda/mig.db && DATABASE_URL=sqlite:////tmp/pt-backend-comanda/mig.db python -m alembic upgrade head
INFO  [alembic.runtime.migration] Running upgrade  -> 0001, ...
INFO  [alembic.runtime.migration] Running upgrade 0001 -> 0002, ...
INFO  [alembic.runtime.migration] Running upgrade 0002 -> 0003, ...
INFO  [alembic.runtime.migration] Running upgrade 0003 -> 0004, Comanda: mesas, rondas, ítems, descuentos, sub-cuentas, eventos y merma.
INFO  [alembic.runtime.migration] Running upgrade 0004 -> 0005, Pagos y comprobante interno: ...

$ cd backend && DATABASE_URL=sqlite:////tmp/pt-backend-comanda/mig.db python -m alembic downgrade base
INFO  [alembic.runtime.migration] Running downgrade 0005 -> 0004, ...
INFO  [alembic.runtime.migration] Running downgrade 0004 -> 0003, Comanda: mesas, rondas, ítems, descuentos, sub-cuentas, eventos y merma.
INFO  [alembic.runtime.migration] Running downgrade 0003 -> 0002, ...
INFO  [alembic.runtime.migration] Running downgrade 0002 -> 0001, ...
INFO  [alembic.runtime.migration] Running downgrade 0001 -> , ...
```

Sube y baja limpio, encadenado con las migraciones de `backend-base` (0001,
0003) y `backend-cobro` (0005).

```
$ cd backend && mkdir -p /tmp/pt-backend-comanda-check && TMPDIR=/tmp/pt-backend-comanda-check python -m pytest tests/shifts/test_open_orders_gate.py -q
..
2 passed, 7 warnings in 6.42s
```

(No es mi territorio correrlo — lo hace `backend-base` en la verificación
final — pero lo corrí para confirmar que mis hooks (`count_open_orders`,
`detach_open_orders`, `adopt_transferred_orders`) funcionan contra su test
E2E de punta a punta antes de entregar.)

No corrí la suite completa del backend, `npm run build` ni `alembic upgrade
head` sobre `dev.db` del repo, tal como pide la regla de verificación.

## 8. Gaps

- **`bill/split` con `pos.seats`**: no implementé el atajo "`groups`
  derivados de `seat`" mencionado sin especificar en el contrato (§6.6).
  Frontend-comanda puede construir `groups` a mano a partir de
  `OrderOut.items[].seat`.
- **Mapeo `tax_code` → tasa entera** (`TAX_RATE_BY_CODE = {"inc_8": 8,
  "iva_19": 19, "excluded": 0}`): no existe un helper así en
  `app.catalog`/`app.stores` (ambos territorios ajenos); lo declaré
  localmente en `app/orders/service.py`. Si el pedido 1b-2 agrega más tasas o
  un método más flexible, convendría centralizarlo en `catalog` o `stores`.
- **`merge` y el resumen de rondas** (§6.7): después de unir comandas, el
  arreglo `rounds` de la comanda destino no incluye las rondas históricas de
  la comanda origen (sólo los ítems, con su `round_no` propio, se mueven).
  No rompe cocina ni la matemática; es una imprecisión menor de
  presentación que declaro para que el auditor o 1b-2 lo revise si hace
  falta un historial de rondas exacto post-unión.
- **`OrderOut.document_id` y `SubAccountOut.document_id`** dependen de que
  `backend-cobro` mantenga `FiscalDocument.order_id` / `.sub_account_id` / `.id`
  tal como los describe el contrato (§2.2 de `CONTRATO-INTERNO-1b-1.md`). Ya
  verifiqué que `app/fiscal/models.py` existe (backend-cobro entregó `0005`
  durante esta construcción) pero no corrí una prueba cruzada real de cobro
  end-to-end contra `document_id` (eso es contenido de
  `tests/payments/test_pay_flow.py`, territorio de `backend-cobro`).
- **`frontend-comanda`**: no es mi territorio, pero dejo dicho que
  `DELETE /orders/{id}/discounts/{discount_id}` espera `expected_version`
  como **query param**, no en el body (§6.2) — relevante para quien
  implemente `src/api/orders.ts`.
- No pude correr Postgres real (sólo SQLite): el índice único parcial de
  `order_tables` y los tipos de columna sólo quedaron probados en SQLite; el
  CI del repo con Postgres 16 es quien los prueba de verdad.

## 9. Reglas de plata verificadas (contrato §5)

1. `Σ lines.net == total`, `Σ prorrateo == descuento`, `Σ tax_lines.tax ==
   tax_total`: cubierto con ejemplos a mano en `test_money.py` (8 %
   inclusivo, 19 % exclusivo, descuento de comanda prorrateado, cortesía en
   0, descuento capado a la base restante). La prueba de propiedad sobre
   1.000 comandas aleatorias es del auditor (`tests/audit/`).
2. `Σ` sub-cuentas de una división por ítems == total de la comanda:
   `test_split_bill_items_creates_sub_accounts_summing_to_total` (asiento
   compartido 1/3 + 2/3 incluido).
3. La propina nunca entra en `subtotal`/`total`/`tax_*`: `tip` es un objeto
   aparte en `OrderOut`/`PreBillOut`/`SubAccountOut`, `tip_base = total −
   tax_total`; `staff_meal` no la calcula (`tip: null`).
4. Consecutivo de documento: no es mi territorio (`backend-cobro`).
5. `staff_meal`: `unit_price=0`, `tax_rate=0`, `tip=null`, sin documento
   (mientras `total == 0`, la emisión queda del lado de `backend-cobro`);
   cubierto en `test_create.py::test_staff_meal_requires_consumer_and_freezes_price`
   y `test_bill.py::test_staff_meal_has_no_tip`.
6. `kitchen.view` apagada → no existe `send` (`FEATURE_DISABLED`);
   `auto_send_pending_for_payment` fuerza `served` cuando
   `order.kitchen_view_enabled` es `False`, para que `backend-cobro` lo use
   tal cual desde `pay_order`.
7. Anular un ítem enviado nunca repone `daily_remaining`/`available`, crea
   `WasteStub` con `ingredient_id NULL`: cubierto en `test_send.py` (E2E
   dueño de este hook, contador 2 → dos envíos → `available=false` en
   `GET /catalog` → un `void` no lo repone).
