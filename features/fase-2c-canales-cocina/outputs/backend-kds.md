# `backend-kds` — pedido 2c («Canales y cocina»): KDS completo

Builder del KDS completo (`kitchen.kds`, que requiere `kitchen.view`): bump por
ítem idempotente, expedición de la comanda completa, impresión por estación, y
el orden respetando «marchar». Construyo sobre la vista mínima de cocina que
ya existía desde 1b-1 (`GET /kitchen/rounds`, sin modelos propios).

Territorio: `backend/app/kitchen/**`, `backend/alembic/versions/0015_kitchen_kds.py`,
`backend/tests/kitchen/**`. No toqué nada fuera de ahí — en particular no toqué
`app/orders/**`, `app/channels/**`, `app/shifts/**`, `app/payments/**`,
`app/catalog/**`, `app/main.py`, `app/core/models_registry.py`, `app/seed.py`,
`tests/audit/**` ni `frontend/**` (verificado con `git status --porcelain` al
terminar: aparecen muchos archivos modificados/nuevos de OTROS agentes que
corrieron en paralelo sobre este mismo árbol —`orders`, `catalog`, `payments`,
`shifts`, `channels`, `frontend`, sus propias migraciones `0013`/`0014`—, pero
del lado mío sólo `backend/app/kitchen/router.py` modificado,
`backend/app/kitchen/{models,schemas,service}.py` y
`backend/alembic/versions/0015_kitchen_kds.py` nuevos, `backend/tests/kitchen/
conftest.py` modificado, seis archivos de test nuevos bajo
`backend/tests/kitchen/`, y este mismo `.md`).

---

## 1. Qué construí, archivo por archivo

### `backend/app/kitchen/models.py` (nuevo)

Hasta 2b este dominio no tenía modelos. Dos tablas nuevas, las dos
**append-only** (nunca `UPDATE`/`DELETE` sobre una fila ya escrita — es
auditoría):

- `KitchenBumpEvent`: una fila por CADA transición real que `bump_item`/
  `unbump_item`/`expedite_order` (CONTRATO C1) produjeron de verdad —
  `action` (`bump`/`unbump`/`expedite`), `from_status`/`to_status` (texto,
  no el enum de `app.orders` — no acoplo mi DDL al tipo declarado en un
  dominio ajeno), `order_id`/`item_id` con FK real, y `employee_id` (FK
  real) + `employee_name` (congelado). Un bump idempotente que NO cambió
  nada (el ítem ya estaba `ready`) **no** escribe fila: no hay nada que
  auditar.
- `KitchenPrintJob`: una fila por CADA vez que alguien confirma "esto se
  imprimió" para una (ronda, estación). `item_count` congela cuántos ítems
  tenía esa estación en ese instante. Reimprimir es legítimo (mismo
  criterio que `Order.bill_print_count`), así que cada confirmación agrega
  una fila nueva — nunca actualiza la anterior.

### `backend/app/kitchen/schemas.py` (nuevo)

`EmployeeRef`, `KitchenItemStateOut` (respuesta de bump/unbump),
`KitchenExpediteOut`/`KitchenExpediteItemOut` (respuesta de expedición),
`PrintJobIn`, `KitchenPrintJobOut`/`KitchenPrintJobItemOut` (docket de
impresión). Ninguno declara `cost`/`margin`/`unit_cost`/`cost_source` — ver
§5. `GET /kitchen/rounds` (1b) sigue devolviendo `list[dict]` sin
`response_model`, tal cual estaba: no le toqué la forma base.

### `backend/app/kitchen/service.py` (nuevo)

- `_OrdersHooksContract` (`Protocol`) + `_orders_hooks()`: el único punto de
  entrada a `app.orders.hooks`, resuelto con `find_spec_safe` +
  `importlib.import_module` (nunca un `import app.orders.hooks` directo —
  ver §3). El `Protocol` + `cast(...)` hace que `mypy` siga chequeando cada
  sitio donde LLAMO a `bump_item`/`unbump_item`/`expedite_order`/
  `fired_at_by_course` contra la firma exacta que verifiqué en el código de
  `backend-canales-comanda`, aunque el `import` en sí sea dinámico.
- `bump_item`/`unbump_item`: llaman al hook, refrescan el `OrderItem` (leído,
  nunca escrito a mano), escriben `KitchenBumpEvent` sólo si `changed`, y
  arman `KitchenItemStateOut`.
- `expedite_order`: llama al hook, escribe un `KitchenBumpEvent` por cada id
  que de verdad cambió, arma `KitchenExpediteOut`.
- `enrich_round_for_kds`: el enriquecimiento de `GET /kitchen/rounds` cuando
  `kitchen.kds` está encendida — reordena `items_out` por «marchar»
  (`_course_sort_key`) y agrega `course_fired_at`/`bumped_by`/`bumped_at`
  por ítem y `platform` a nivel de ronda. **No se llama nunca con la flag
  apagada** (ver `router.py`): es aditivo por construcción, no por un `if`
  que compare campo por campo.
- `tables_for_order`, `_station_dockets`, `_print_out`, `list_print_jobs`,
  `register_print_job`: el trabajo de impresión (§6 de la misión).

### `backend/app/kitchen/router.py` (existente, extendido)

- `GET /kitchen/rounds` (1b, sin cambios de comportamiento con `kitchen.kds`
  apagada — ver §4 y el test `test_bump_and_unbump_require_kitchen_kds_flag`/
  `test_platform_info_is_not_shown_without_kitchen_kds`): la única
  diferencia de código es que ahora calcula `kds_enabled` y, si es `True`,
  llama `service.enrich_round_for_kds` antes de devolver.
- Nuevas, todas detrás de `kitchen.kds`:
  - `POST /kitchen/items/{item_id}/bump`
  - `POST /kitchen/items/{item_id}/unbump`
  - `POST /kitchen/orders/{order_id}/expedite`
  - `GET /kitchen/print-jobs`
  - `POST /kitchen/print-jobs`
- `_idempotent`: repetición deliberada (4 líneas) del helper privado de
  `app.orders.router` — no se importa una función privada de un territorio
  ajeno; se arma con las piezas PÚBLICAS de `app.core.idempotency`
  (`idempotency_key`, `hash_request_body`, `run_idempotent`).

### `backend/alembic/versions/0015_kitchen_kds.py` (nuevo, mi única migración)

`down_revision = "0014"`. DDL a mano, Postgres-first, mismo estilo que
`0008`…`0014`. Las dos tablas son NUEVAS así que llevan **todas** sus FK
reales (`create_table` no tiene la limitación de SQLite con
`batch_alter_table` que dejaron escrita `0011`/`0012`), incluidas hacia
`orders`/`order_rounds`/`order_items` (`0004`) y `employees` (`0001`).
Verificado corriendo la cadena de verdad, no razonando sobre ella (§7).

### `backend/tests/kitchen/**`

- `conftest.py`: re-exporta fixtures de `tests/orders/conftest.py`
  (`platform`, `courier`, `delivery_fee_product`, etc. — mismo patrón que ya
  usaba para `main_product`/`drink_product`) y agrega `starter_product`
  (propio: un segundo producto con estación pero curso `starter`, para
  probar el orden por «marchar» contra `main_product`, curso `main`).
- `test_bump.py`, `test_expedite.py`, `test_print_jobs.py`,
  `test_course_order.py`, `test_channels.py`, `test_no_cost_leak.py`: 26
  tests nuevos (`test_rounds.py`, de 1b, sigue igual, sin tocar — sus 3 tests
  originales pasan tal cual).

---

## 2. Contrato de API publicado (para frontend, sin adivinar un campo)

Todas las rutas nuevas están bajo `/api/v1`, detrás de `kitchen.kds` (`400
FEATURE_DISABLED`, `{"error":{"code":"FEATURE_DISABLED","message":"...",
"feature":"kitchen.kds"}}`, si está apagada). Las dos de escritura simples
(bump/unbump) y las dos de "gesto de cocina" (expedite, print) exigen una
persona identificada (`current_operator`): sin identificar, `401
IDENTIFY_REQUIRED`. Las dos lecturas (`GET /kitchen/rounds`, `GET
/kitchen/print-jobs`) NO exigen persona identificada (misma razón que ya
tenía `GET /kitchen/rounds` desde 1b: una pantalla de cocina puede no tener a
nadie identificado).

### `GET /kitchen/rounds?station=<str>` (existe desde 1b; `kitchen.view`)

Sin cambios de forma con `kitchen.kds` apagada. **Con `kitchen.kds`
encendida**, cada elemento de la lista (una ronda) gana:

```jsonc
{
  "order_id": 42,
  "round_no": 1,
  "sent_at": "2026-09-19T18:00:00+00:00",
  "elapsed_seconds": 300,
  "channel": "platform",
  "tables": [],
  "takeout_name": null,
  "covers": null,
  "platform": {"source": "Rappi", "external_id": "RAPPI-9001"},  // NUEVO. `null` si el canal no es "platform".
  "items": [
    {
      "item_id": 101,
      "name": "Bandeja Paisa",
      "qty": 1,
      "modifiers_text": null,
      "note": null,
      "course": "main",
      "station": "hot_kitchen",
      "status": "sent",               // "sent" | "ready" (los únicos que entran a esta cola)
      "elapsed_seconds": 120,
      "target_minutes": 18,
      "semaphore": "green",           // "green" | "amber" | "red" (reusa `_semaphore`, sin tocar)
      "course_fired_at": "2026-09-19T18:00:05+00:00",  // NUEVO. `null` si el curso no se marchó (o el restaurante no usa "marchar").
      "bumped_by": {"id": 7, "name": "Operator"},       // NUEVO. `null` si el ítem no está `ready`.
      "bumped_at": "2026-09-19T18:03:00+00:00"          // NUEVO. `null` si el ítem no está `ready` (es `item.ready_at`, no un dato propio).
    }
  ]
}
```

El **orden de `items`** respeta «marchar» cuando `kitchen.kds` está
encendida: un ítem de un curso YA marchado (`course_fired_at != null`) nunca
queda detrás de uno sin marchar; entre marchados, el que se marchó primero va
primero; entre no marchados, se conserva el orden de envío. Un restaurante
que nunca usa «marchar» (`fired_at_by_course` siempre vacío) deja el orden
igual al de envío de toda la vida — «marchar» no le cambia nada a quien no lo
usa.

### `GET /kitchen/print-jobs?station=<str>` (nuevo)

Lista los "dockets" pendientes o ya impresos: una entrada por cada (ronda,
estación) con al menos un ítem `sent`/`ready`.

```jsonc
[
  {
    "order_id": 42, "round_id": 17, "round_no": 1, "station": "hot_kitchen",
    "channel": "counter", "tables": ["4"],
    "items": [{"item_id": 101, "name": "Bandeja Paisa", "qty": 1, "modifiers_text": null, "note": null}],
    "item_count": 1,
    "printed": false, "printed_at": null, "printed_by": null, "print_count": 0
  }
]
```

### `POST /kitchen/print-jobs` (nuevo, `Idempotency-Key` obligatorio, operador identificado)

Body: `{"round_id": 17, "station": "hot_kitchen"}`. Respuesta: el mismo
esquema de arriba, con `printed: true`, `printed_at`, `printed_by` y
`print_count` incrementado. Registrar una estación sin ítems pendientes
**no es un error**: se registra igual con `item_count: 0` (mismo criterio
que "expedir sin nada pendiente"). Reimprimir (llamar de nuevo con una
`Idempotency-Key` distinta) es legítimo y suma al `print_count`.

**Dónde termina esto y dónde empezaría la impresora real** (§13, fase 3):
esto es el TRABAJO — qué imprimir, para qué estación, cuándo se confirmó, y
quién. Un driver real reemplazaría la escritura de `KitchenPrintJob` en
`service.register_print_job` por (a) esa misma escritura y (b) el envío
físico a la impresora térmica; no hay ESC/POS, cola de impresión ni
detección de papel acá.

### `POST /kitchen/items/{item_id}/bump` (nuevo, `Idempotency-Key` obligatorio, operador identificado)

Sin body. Respuesta:

```jsonc
{
  "item_id": 101, "order_id": 42, "status": "ready", "ready_at": "2026-09-19T18:03:00+00:00",
  "changed": true,                                    // `false` si ya estaba `ready`: no-op idempotente, no error
  "bumped_by": {"id": 7, "name": "Operator"}, "bumped_at": "2026-09-19T18:03:00+00:00"
}
```

Errores: `404 NOT_FOUND` (el `item_id` no existe en esta sede — un `item_id`
inventado es un error real, no un "ya estaba hecho"); `409
IDEMPOTENCY_IN_PROGRESS` si dos requests concurrentes usan la MISMA
`Idempotency-Key` mientras la primera no terminó (el caso real: dos
dispositivos de cocina bumpeando "a la vez" con una key compartida por un
reintento de red). Dos bumps del mismo ítem con claves DISTINTAS (el caso
normal de "dos toques") nunca chocan: el segundo es `200` con `changed:
false`.

### `POST /kitchen/items/{item_id}/unbump` (nuevo, mismas reglas que bump)

Misma forma de respuesta, `status` vuelve a `"sent"`, `ready_at`/`bumped_by`/
`bumped_at` vuelven a `null` cuando de verdad deshizo algo.

### `POST /kitchen/orders/{order_id}/expedite` (nuevo, `Idempotency-Key` obligatorio, operador identificado)

Sin body. Respuesta:

```jsonc
{
  "order_id": 42,
  "changed": true,                       // `false` si no quedaba nada `sent`: no es un error
  "changed_item_ids": [101, 102],
  "items": [
    {"item_id": 101, "name": "Bandeja Paisa", "status": "ready", "station": "hot_kitchen"},
    {"item_id": 102, "name": "Ceviche", "status": "ready", "station": "cold_kitchen"}
  ],
  "expedited_by": {"id": 7, "name": "Operator"}, "expedited_at": "2026-09-19T18:05:00+00:00"
}
```

Errores: `404 NOT_FOUND` si `order_id` no existe en esta sede.

---

## 3. CONTRATO C1: qué asumí, y qué pasó al verificarlo

Antes de escribir una línea, leí `app/orders/hooks.py` completo (existía
desde antes de empezar: `backend-canales-comanda` ya lo había publicado). Las
cuatro firmas que la misión describía coincidían **exactamente** con el
código real — no tuve que ajustar nada:

```python
def bump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool
def unbump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool
def expedite_order(db: Session, *, order_id: int, store_id: int, actor: "Actor", now: datetime) -> list[int]
def fired_at_by_course(db: Session, *, order_id: int) -> dict[str, datetime]
```

Verificación real (no sólo lectura): `tests/kitchen/test_bump.py`,
`test_expedite.py` y `test_course_order.py` corren contra el código REAL de
`app.orders.hooks` (nada mockeado) — `test_bump_is_idempotent_same_state_same_instant`
prueba que dos bumps dejan el mismo `ready_at`; `test_unbump_reverses_a_bump_and_is_also_idempotent`
prueba el camino de deshacer; `test_the_kds_respects_fired_at_order_between_two_courses`
llama `POST /orders/{id}/courses/main/fire` (endpoint real de
`app.orders.router`, no un doble) y verifica que `fired_at_by_course` mueve
el orden de la cola.

**Grep de guardia** (lo repetí ahora, para este documento, contra el código
final): confirmé que `app/kitchen/service.py` no importa `app.orders.hooks`
con un `import` directo en ningún lado (`grep -n "^from app.orders import
hooks\|^import app.orders.hooks" app/kitchen/*.py` → sin resultados); el
único acceso es `_orders_hooks()`. Si `backend-canales-comanda` cambiara una
firma o borrara el módulo, `_orders_hooks()` levanta `RuntimeError` (nunca un
fallback silencioso ni una copia de la lógica acá) y **mis 26 tests de
`tests/kitchen` lo gritan de inmediato** (fallarían con `500 INTERNAL_ERROR`
en cascada) — no hace falta que nadie lea logs para notarlo.

No cambié nada de C1 y no necesité pedir un cambio: las cuatro funciones
alcanzaron exactamente lo que el KDS necesitaba.

## CONTRATO C5: verificado, ya resuelto por `backend-dinero-canales`

La misión advertía que `"kitchen"` podía faltar en `MODEL_MODULES`
(`app/core/models_registry.py`) porque el dominio nunca había tenido
modelos. Verifiqué **antes de escribir `app/kitchen/models.py`**:

```
$ python -c "from app.core.models_registry import MODEL_MODULES; print(MODEL_MODULES)"
['core', 'auth', 'stores', 'catalog', 'shifts', 'orders', 'payments', 'fiscal',
 'customers', 'refunds', 'reports', 'audit', 'notifications', 'inventory',
 'recipes', 'purchases', 'channels', 'kitchen']
```

`"kitchen"` YA estaba (junto con `"channels"`), con un comentario en el
archivo que nombra exactamente este contrato (C5) y dice que
`backend-dinero-canales` lo agregó en su primer commit, tal como se había
comprometido. También verifiqué `app/main.py:32` (`DOMAINS`): `"kitchen"` ya
está ahí desde 1b-1, sin cambios. **No toqué ninguno de los dos archivos.**
Corrí la cadena de Alembic completa (`alembic upgrade head` contra una base
SQLite propia bajo `/tmp/pt-backend-kds/`) y confirmé que mis dos tablas
nuevas aparecen en el esquema real — la prueba de que el contrato cierra de
los dos lados, no sólo que el registro tenga la clave (§7).

---

## 4. Cómo verifiqué la idempotencia del bump

Test: `tests/kitchen/test_bump.py::test_bump_is_idempotent_same_state_same_instant`.
Envía una comanda con un ítem a cocina, lo bumpea, y lo vuelve a bumpear con
una `Idempotency-Key` DISTINTA (dos toques reales, no un replay de la misma
clave) — verifica que el segundo bump devuelve `200` (nunca error), `changed:
false`, el MISMO `ready_at` que el primero (no se movió el instante), y
conserva la atribución (`bumped_by`) del primer bump. Hay un segundo test,
`test_bump_replays_with_the_same_idempotency_key`, que cubre el otro caso
(misma clave repetida = replay de la respuesta guardada, no una segunda
ejecución).

Salida real (`pytest -v`, corrida ahora mismo contra el código final):

```
$ TMPDIR=/tmp/pt-backend-kds python -m pytest tests/kitchen/test_bump.py -v
tests/kitchen/test_bump.py::test_bump_is_idempotent_same_state_same_instant PASSED [ 16%]
tests/kitchen/test_bump.py::test_bump_replays_with_the_same_idempotency_key PASSED [ 33%]
tests/kitchen/test_bump.py::test_bump_unknown_item_is_404_not_500 PASSED [ 50%]
tests/kitchen/test_bump.py::test_bump_requires_identified_operator PASSED [ 66%]
tests/kitchen/test_bump.py::test_unbump_reverses_a_bump_and_is_also_idempotent PASSED [ 83%]
tests/kitchen/test_bump.py::test_bump_and_unbump_require_kitchen_kds_flag PASSED [100%]
======================= 6 passed, 16 warnings in 19.19s ========================
```

(Las 16 advertencias son `InsecureKeyLengthWarning` de PyJWT sobre el secreto
de test, heredadas de `tests/conftest.py` — no las causa este código.)

## Suite completa de mi territorio y typecheck

```
$ cd backend && TMPDIR=/tmp/pt-backend-kds python -m pytest tests/kitchen -q
26 passed, 52 warnings in 76.41s (0:01:16)

$ cd backend && TMPDIR=/tmp/pt-backend-kds python -m mypy app
Success: no issues found in 123 source files
```

`tests/kitchen/test_rounds.py` (de 1b, sin tocar) está DENTRO de esos 26 y
sus 3 tests originales pasan tal cual — prueba directa de que "con
`kitchen.kds` apagada, todo lo de 1b sigue idéntico" (checklist de la spec).

---

## 5. Campos que mis respuestas NO traen, y por qué

- **`cost`, `unit_cost`, `unit_cost_micros`, `cost_source`, `margin`, o
  cualquier variante**: ninguna ruta de `app/kitchen/**` los declara, ni
  anidados. Verificado con dos tests propios que recorren el OpenAPI de
  verdad (`tests/kitchen/test_no_cost_leak.py`, mismo mecanismo — por
  sustring, no por nombre de path — que usa el barrido compartido de
  `tests/payments/test_documents.py`, acotado a mis 5 paths):
  `test_no_kitchen_response_schema_declares_cost_or_margin` (nada de
  `MONEY_LEAK_SUBSTRINGS = ("cost", "margin")` en ningún esquema
  alcanzable) y `test_no_kitchen_route_requires_current_admin` (ninguna de
  mis rutas está en `admin_only_paths()` — todas son de sesión de
  dispositivo, el criterio ESTRICTO que usa el barrido real, no el texto
  del path). `OrderItem.unit_cost`/`unit_cost_micros`/`cost_source` los LEO
  en `app.orders.models` (para nada relacionado con esto — nunca los toco)
  pero jamás los serializo: mis schemas de salida (`schemas.py`) simplemente
  no tienen esos campos declarados.
- **Dirección y teléfono del cliente de domicilio** (`Order.delivery_address`/
  `delivery_phone`): existen en `app.orders.models` y los podría leer, pero
  no los expongo en ninguna ruta del KDS. Decisión de mínimo privilegio: la
  cocina necesita saber que un pedido es "domicilio" (ya lo sabe por
  `channel`) para no confundirlo con uno de mesa, pero no necesita el
  teléfono ni la dirección del cliente para cocinar — eso lo necesita el
  domiciliario/el mesero, no la pantalla de cocina.
- **`platform_commission_bp`**: existe en `Order` (snapshot de la comisión al
  crear) y lo dejo afuera del KDS a propósito. La comisión es plata (un
  costo del pedido), y aunque no es "costo de insumo" en el sentido del
  barrido de `cost`/`margin`, no tiene ninguna utilidad para quien cocina —
  es dato de `app.channels`/reportes de admin.
- **`recipe_version`**: existe en `OrderItem` (snapshot de qué versión de
  ficha se usó) y tampoco lo expongo: es dato de trazabilidad de costo/
  receta para reportes, no algo que la cocina necesite para preparar un
  plato ya congelado con nombre, modificadores y nota.

---

## 6. Decisiones declaradas (donde la spec/misión no bajaba al detalle)

1. **Qué rutas exigen persona identificada.** Bumpear, deshacer un bump,
   expedir e imprimir son gestos deliberados de cocina — los cuatro piden
   `current_operator`. Las dos lecturas (`GET /kitchen/rounds`, `GET
   /kitchen/print-jobs`) NO lo exigen: mismo criterio que ya tenía `GET
   /kitchen/rounds` desde 1b (una pantalla de cocina puede sondear sin que
   nadie esté identificado). Decidí que **imprimir también es atribuible**
   (aunque la misión sólo daba el ejemplo del bump): saber quién confirmó
   que una estación imprimió importa tanto como saber quién bumpeó, por la
   misma razón ("cocina es pantalla compartida").
2. **`kitchen.kds` sólo se chequea a sí misma en cada ruta, no también
   `kitchen.view` de forma redundante.** Es el patrón dominante del repo
   (verificado contra `app/channels/router.py`: sus rutas de `pos.delivery`
   no chequean también `pos.takeout`, aunque el catálogo declara esa
   dependencia) — la dependencia entre flags la hace cumplir quien las
   ENCIENDE (`app.stores.router`, territorio ajeno), no cada endpoint que
   las consume. Documentado acá por si un auditor lo lee como un hueco: no
   lo es, es consistente con el resto del árbol.
3. **La impresión es por (ronda, estación), no por comanda completa.** Una
   estación imprime SU docket, no la comanda entera (que puede tener ítems
   de varias estaciones) — es la lectura literal de "impresión por
   estación", y evita que la estación de bar reciba un ticket con los platos
   calientes de otra estación.
4. **Registrar una impresión sin ítems pendientes no es error.** Mismo
   criterio que `expedite_order` con `changed_item_ids: []`: "no había nada
   que hacer" es información, no un fallo — probado en
   `test_registering_a_station_with_nothing_pending_is_not_an_error`.
5. **No dupliqué ninguna lista configurable.** Las estaciones salen de
   `StoreSalesSettings.stations` (leídas donde ya se leían, en
   `get_kitchen_rounds`/mis dockets); no hay una lista de estaciones nueva
   en `app/kitchen/**`. Los cursos marchados los leo con
   `fired_at_by_course`, nunca duplico `OrderCourseFire`.
6. **`bumped_at` es literalmente `item.ready_at`, no un timestamp propio.**
   Evita una segunda fuente de verdad para "cuándo quedó listo" — mi tabla
   sólo aporta el dato que `app.orders` no tiene: QUIÉN.

---

## 7. Rojos y dudas

- **R-1 heredado, ya declarado por `backend-canales-comanda` y
  `backend-dinero-canales`, y ahora con el número real de MI migración
  incluida**: `tests/audit/test_migration_invariants.py` (territorio
  prohibido para mí) fija en algún punto `head == "0012"` con un conteo de
  tablas viejo. Con `0013` (`backend-canales-comanda`), `0014`
  (`backend-dinero-canales`) y `0015` (esta), medí corriendo la cadena
  completa contra una base SQLite propia (`/tmp/pt-backend-kds/`, no
  estimado): **`alembic upgrade head` llega a `0015` y deja 79 tablas**
  (77 sin las mías + `kitchen_bump_events` + `kitchen_print_jobs`). Ese test
  necesita que el auditor de 2c mueva el número a `head == "0015"` / **79
  tablas**. También corrí (sólo como chequeo propio, sin tocar el archivo)
  `tests/audit/test_migration_invariants.py::test_the_migration_chain_builds_exactly_the_tables_of_the_models`,
  `test_every_migrated_table_has_exactly_the_columns_of_its_model` y
  `test_downgrading_to_base_leaves_no_table_of_the_application` — los tres
  pasan contra mi migración (el DDL a mano coincide exactamente con
  `Base.metadata`, y el `downgrade` deja la base limpia).
- **No construí ninguna pantalla de Configuración** para "estaciones, cursos
  y tiempos objetivo" (§9.3): ya existen como columnas administrables de
  `StoreSalesSettings` desde 1b (`stations`, `courses`,
  `course_target_minutes`) — no agregué UI ni endpoints de escritura nuevos
  para eso porque no hacía falta ningún dato nuevo; el KDS sólo LEE esas
  columnas donde ya se leían. Si `app.stores.router` no expone todavía un
  `PATCH` para esas tres columnas específicas, es gap de configuración, no
  mío (`app/stores/**` no está en mi territorio de escritura).
- **No construí ningún endpoint de administración/reporte sobre
  `kitchen_bump_events`/`kitchen_print_jobs`** (p. ej. "quién bumpeó más
  hoy", "cuántas reimpresiones tuvo la estación de bar"): la misión pedía el
  KDS operativo, no un reporte de admin sobre él. Las dos tablas quedan
  listas para que un pedido futuro (o `frontend-settings`/reportes) las
  consuma; documentado acá para que no se asuma que ya existe esa pantalla.
- **No verifiqué el recorrido en navegador real** (último ítem del
  checklist de la spec): no hay frontend para el KDS en el árbol al momento
  de escribir esto — es trabajo de un agente de frontend que no veo corriendo
  en este equipo, y el recorrido final es responsabilidad del
  Maestro/orquestador cuando ese frontend exista.
- **Ambigüedad que resolví por mi cuenta, documentada por si se lee
  distinto**: la spec no dice si "impresión por estación" es un botón que
  aprieta una persona de cocina o algo automático al enviar la ronda. Elegí
  "botón que aprieta alguien" (§6, decisión 1) porque no tengo forma de
  enganchar un hook de "al enviar" sin tocar `app/orders/**` (fuera de mi
  territorio) — si la intención real era "automático", es un cambio de una
  función en `service.py` (llamar `register_print_job` para cada estación
  con ítems nuevos), no una re-arquitectura, y lo dejo señalado acá en vez
  de adivinarlo.
- **Nada más quedó sin cerrar dentro de mi territorio**: los seis puntos
  numerados de la misión (precio por canal no es mío — lo construyó
  `backend-canales-comanda`; los otros cinco sí) están construidos y
  verificados con test real contra el código real de `app.orders.hooks`
  (nada mockeado donde el contrato lo permitía).
