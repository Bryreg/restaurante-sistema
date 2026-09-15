# backend-base — entrega (pedido 1b-1: comanda y cobro)

Rol: **cimientos, caja y personal del dispositivo**. Escribí primero lo que
destraba a `backend-comanda`, `backend-cobro` y `auditor-venta` (fixtures de
`tests/conftest.py`, `DOMAINS`/`MODEL_MODULES`, `SUPERVISOR_ACTIONS`,
`NOTIFICATION_TYPES`, `GET /device/employees`), y después el resto de mi
misión (O-1, A-7, hooks de venta, gate de comandas abiertas al cerrar el
turno, tests E2E cuyo dueño soy yo, `docs/ESTADO.md`).

## 1. Resumen

- **`GET /device/employees`** (SPEC-NEGOCIO §9.1, «Quién opera»; cierra A-9
  de 1a): lista `{id, name, role}` del personal activo de la sede del
  dispositivo más los admins de toda la organización, ordenado por nombre.
  Nunca `document`, `email`, `discount_limit_pct`, `can_charge` ni hashes.
- **O-1 resuelto por default**: con `cash.blind_close` encendida (perfil
  `full`, el de los tests y el seed) el responsable de caja no ve
  `expected_cash`/`sales`/`tips` en `GET /shifts/current` ni en
  `GET /shifts/{id}` — sólo el admin. El responsable los ve recién en el
  paso 2 del cierre (`GET /shifts/{id}/close/{count_id}/review`). Con la
  flag apagada, el responsable ve todo como antes.
- **A-7 resuelto por default**: `document` y `email` de empleados quedan
  fuera del `before`/`after` de la auditoría de `entity="employee"`.
  `GET /admin/employees` los sigue devolviendo al admin, sin cambios.
- **`shifts.hooks.get_sales_totals`** ahora lee `app.payments.models.Payment`
  (protegido con `find_spec_safe`) y separa `cash`/`card`/`transfer`/`other`
  con sus propinas; `compute_breakdown` no cambió (sigue leyendo `.cash`).
- **Gate de comandas abiertas** al cerrar el turno (`confirm_close`,
  `close_single_step`): `400 OPEN_ORDERS_EXIST {open_orders: n}` sin
  `transfer_open_orders`; con el traslado (o siempre, en
  `close_administrative`) las comandas quedan huérfanas y el turno siguiente
  las adopta al abrir. Los hooks (`count_open_orders`, `detach_open_orders`,
  `adopt_transferred_orders`) los escribió `backend-comanda` en
  `app/orders/hooks.py`; yo sólo los llamo, protegido con `find_spec_safe`.
- Fixtures nuevas y promovidas en `tests/conftest.py`: `open_shift`,
  `catalog_seeded`, `race_env` (con `seed_product`/`open_shift`); `race_app`
  queda como wrapper delgado sobre `race_env`.
- **Defecto encontrado y corregido** (no estaba en el contrato, bloqueaba a
  todo el equipo): `find_spec` sobre un submódulo de un dominio **sin
  carpeta todavía** (`app/payments`, `app/fiscal` al momento de escribir
  `DOMAINS`/`MODEL_MODULES`) lanza `ModuleNotFoundError` en vez de devolver
  `None`, y tumbaba el arranque completo de la API — por lo tanto, toda la
  suite de tests de cualquier dominio. Nuevo helper
  `app.core.modules.find_spec_safe` lo resuelve; lo usan `main.py`,
  `models_registry.py`, `shifts/hooks.py` y `shifts/service.py`.
- Seed de desarrollo (`app/seed.py`): confirmado sin cambios — ya declaraba
  `active_channels` counter/dine_in/takeout, `payment_methods` cash/card/
  transfer habilitados, `stations`, `courses` y `course_target_minutes`.
- `docs/ESTADO.md` y `.claude/launch.json` actualizados al estado real de
  1b-1 (ver sus diffs; no repito el contenido acá).

## 2. Archivos tocados

Backend, territorio propio:

- `backend/app/main.py` — `DOMAINS += ["orders","payments","fiscal","kitchen"]`
  (antes de `"audit","notifications"`, orden del contrato); `find_spec_safe`
  en vez de `importlib.util.find_spec` crudo.
- `backend/app/core/models_registry.py` — `MODEL_MODULES += ["orders","payments","fiscal"]`
  (`kitchen` no tiene modelos); `find_spec_safe`.
- `backend/app/core/modules.py` **(nuevo)** — `find_spec_safe(module_name) -> ModuleSpec | None`.
- `backend/app/auth/router.py` — `GET /device/employees`; helper
  `_employee_audit_view` (A-7) usado en `create_employee`/`update_employee`.
- `backend/app/auth/schemas.py` — `DeviceEmployeeOut {id, name, role}`.
- `backend/app/auth/service.py` — `SUPERVISOR_ACTIONS += {"void_order","after_bill_change"}`.
- `backend/app/notifications/service.py` — `NOTIFICATION_TYPES += ["discount_rate_high","courtesy_limit","void_rate_high","order_unsent_too_long","order_unpaid_too_long"]`.
- `backend/app/shifts/hooks.py` — `SalesTotals` con `other`/`tips_card`/
  `tips_transfer`/`tips_other`; `get_sales_totals` lee `Payment` real
  (find_spec-guarded).
- `backend/app/shifts/router.py` — `_can_see_expected(db, actor, shift)` (O-1,
  firma cambiada: ahora recibe `db`); `_sales_and_tips` helper; `sales`/`tips`
  en `_shift_summary` y `get_current`; `transfer_open_orders` pasado a
  `service.confirm_close`.
- `backend/app/shifts/schemas.py` — `SalesByMethodOut`; `sales`/`tips` en
  `ShiftSummaryOut`/`ShiftCurrentOut`; `CloseReviewOut.open_orders: int`.
- `backend/app/shifts/service.py` — `_orders_hooks_module`/`_count_open_orders`/
  `_detach_open_orders`/`_adopt_transferred_orders`/`_apply_open_orders_gate`
  (find_spec-guarded contra `app.orders.hooks`); gate llamado desde
  `confirm_close` y `close_single_step`; `close_administrative` traslada
  siempre; `open_shift` adopta comandas trasladadas; `review_close` gana
  `open_orders`.
- `backend/tests/conftest.py` — fixtures nuevas `open_shift`, `catalog_seeded`,
  `race_env` (dataclass `RaceEnv`); `race_app` reescrito como wrapper sobre
  `race_env` (mismo comportamiento externo).
- `backend/tests/auth/test_device_employees.py` **(nuevo)** — 5 tests de
  `GET /device/employees` (orden, campos, PII, inactivos, aislamiento por
  sede dentro de la misma organización, sin persona identificada).
- `backend/tests/auth/test_employees.py` — test nuevo de A-7 (la auditoría de
  `employee` nunca trae `document`/`email`).
- `backend/tests/shifts/test_expected_visibility.py` — 2 tests nuevos de O-1
  (responsable con la flag encendida no ve nada hasta la revisión del
  cierre; responsable con la flag apagada ve todo).
- `backend/tests/shifts/test_open_orders_gate.py` **(nuevo)** — gate de
  comandas abiertas: bloqueo, traslado, adopción en el turno siguiente,
  cierre administrativo que traslada siempre.
- `backend/tests/shifts/test_sales_totals_e2e.py` **(nuevo)** — guardado del
  `find_spec` de `get_sales_totals` (corre siempre) + el E2E completo del
  contrato (`test_sales_totals_flow_into_shift`, con `skipif` mientras
  `app.orders.router`/`app.payments.models` no existan).
- `docs/ESTADO.md` — «Qué está hecho» (bloque de 1b-1/`backend-base`),
  «Dónde retomar» (verificación de mi territorio, O-1/A-7/A-9 cerrados,
  estado del resto del equipo), fecha de última actualización.
- `.claude/launch.json` — descripción menciona 1b-1 (sin cambios de comandos).

No toqué `app/orders/**`, `app/kitchen/**`, `app/payments/**`, `app/fiscal/**`,
`tests/orders/**`, `tests/kitchen/**`, `tests/audit/**`, `frontend/**` ni
migraciones. `app/orders/{__init__.py,hooks.py,models.py,money.py,schemas.py}`
y `app/kitchen/__init__.py` ya existían al empezar (los escribió
`backend-comanda` en paralelo); sólo los **leí** para escribir mis hooks
(`_orders_hooks_module`) y mi test de punta a punta.

## 3. Endpoints expuestos y cambiados

### Nuevo

`GET /device/employees` (`current_device`, persona opcional) → `200
[{id, name, role}]`, activos de la organización cuyo `store_id` es la sede
del dispositivo **o** `NULL` (admins), orden por `name`.

### Cambiados (`/shifts/*`)

- `GET /shifts/current`, `GET /shifts/{id}`: `expected_cash` (ya existía) más
  **`sales: {cash, card, transfer, other} | null`** y
  **`tips: {cash, card, transfer, other} | null`**, todos gobernados por
  `_can_see_expected(db, actor, shift)`. Con `cash.blind_close` encendida el
  responsable de caja recibe `null` en los tres; con la flag apagada, o si es
  admin, los recibe llenos. `pickups[].expected_at_pickup` y
  `handovers[].breakdown` siguen el mismo predicado (sin cambio de
  comportamiento, sólo de firma interna).
- `GET /shifts/{id}/close/{count_id}/review`: `CloseReviewOut` gana
  `open_orders: int` (siempre visible en este paso, sin gate — es la
  revisión previa a confirmar).
- `POST /shifts/{id}/close/{count_id}/confirm`, `POST /shifts/{id}/close`
  (un paso): con comandas `open`/`to_pay` en el turno y sin
  `transfer_open_orders: true` en el body (el campo ya existía en
  `CloseConfirmIn`/`SingleStepCloseIn`) → **`400 OPEN_ORDERS_EXIST
  {open_orders: n}`**; con el traslado, cierran normalmente y las comandas
  quedan `shift_id NULL`.
- `POST /admin/shifts/{id}/close-administrative`: traslada las comandas
  abiertas **siempre**, sin exigir `transfer_open_orders` (es un rescate de
  administrador, no algo que el responsable pueda resolver cobrando).
- `POST /shifts/open`: si hay comandas huérfanas (`shift_id NULL`,
  `open`/`to_pay`) de la sede, el turno nuevo las adopta.

Las respuestas directas de `POST /shifts/{id}/pickups` y
`POST /shifts/{id}/handovers` **no cambiaron** (decisión ya documentada en la
entrega de 1a: siguen devolviendo el snapshot al actor que ejecuta la acción).

### Admin (sin cambio de forma, sólo de fuente de datos)

`GET /admin/employees`, `POST /admin/employees`, `PATCH /admin/employees/{id}`
siguen igual; sólo cambió qué entra a `record_audit` (ver A-7 abajo).

## 4. Fixtures nuevas (firma)

```python
# tests/conftest.py — para dominios sin conftest propio (orders, payments).
# tests/audit y tests/shifts ya tenían su propio `open_shift` con la misma
# semántica (parámetro `cash_responsible` en vez de `responsible` en el de
# tests/shifts/conftest.py): son sombras intencionales, CONTRATO-INTERNO-1b-1 §1.
def open_shift(
    *, responsible=None, total=200_000, cash_reserve=0,
    opening_cause=None, opening_note=None,
) -> dict: ...

def catalog_seeded(db, store) -> None: ...  # app.catalog.seed.seed_catalog + commit

@dataclass
class RaceEnv:
    client: TestClient
    employee_id: int
    store_id: int
    organization_id: int
    store_pin: str
    employee_pin: str
    session_factory: Callable[[], Session]

    def seed_product(
        self, name="Gaseosa", price=5000, station=None, tax_code="inc_8",
    ) -> int: ...  # categoría + producto en la base de la carrera

    def open_shift(self) -> dict: ...  # abre turno por API con self.client

def race_env(tmp_path) -> Iterator[RaceEnv]: ...  # una sesión por request

def race_app(race_env: RaceEnv) -> tuple[TestClient, int]:
    return race_env.client, race_env.employee_id  # wrapper delgado, sin cambios de comportamiento
```

## 5. Decisiones declaradas

- **O-1**: implementado tal como pide el contrato — un único predicado
  (`_can_see_expected`) gobierna `expected_cash`, `sales`, `tips`,
  `pickups[].expected_at_pickup` y `handovers[].breakdown`; el responsable
  ve el esperado recién en el paso 2 del cierre. No hay ninguna otra ruta
  donde el responsable pueda inferir el esperado antes de eso (ni `sales` ni
  `tips` se filtran por ningún otro endpoint de 1b-1: `payments`/`fiscal` no
  existen todavía y cuando existan, sus respuestas al dispositivo son sobre
  la comanda/documento, no sobre el turno).
- **A-7**: `_employee_audit_view` excluye `document` y `email` del `before`/
  `after`; el resto de los campos (`name`, `role`, `store_id`, `can_charge`,
  `discount_limit_pct`, `active`) sigue viajando, así que la auditoría no
  queda vacía. `GET /admin/employees` no cambió.
- **Mapeo de medios a `other`**: `platform`, `voucher` y cualquier método que
  no sea `cash`/`card`/`transfer` caen en el bucket `other` de `sales`/`tips`
  (ninguno de los tres entra al cajón físico, así que ninguno debía tener
  bucket propio en la caja — `compute_breakdown` sólo usa `.cash`).
- **`find_spec_safe`**: decisión de ingeniería, no de negocio, pero la dejo
  explícita porque cambia un patrón que el contrato daba por sentado
  ("un dominio ausente no rompe nada"). Cualquier `find_spec` nuevo sobre un
  módulo de OTRO dominio que pueda faltar tiene que usar este helper, no
  `importlib.util.find_spec` directo.

## 6. Comandos de verificación (resultados literales)

```
$ mkdir -p /tmp/pt-backend-base && cd backend && TMPDIR=/tmp/pt-backend-base \
  python -m pytest tests/core tests/auth tests/stores tests/audit_log tests/notifications tests/shifts -q -x
........................................................................ [ 57%]
....................................................s                    [100%]
124 passed, 1 skipped, 185 warnings in 260.76s (0:04:20)
```

El único skip es `tests/shifts/test_sales_totals_e2e.py::test_sales_totals_flow_into_shift`,
condicionado (`pytest.mark.skipif`) a que existan `app.orders.router` y
`app.payments.models`; ninguno de los dos existía al cerrar este output (ver
§7). El resto de ese mismo archivo (`test_get_sales_totals_without_payments_module_is_zero`)
sí corre y pasa: confirma que `hooks.get_sales_totals` no revienta sin el
módulo de pagos.

Antes de este resultado corregí 3 fallas reales que encontré al correr mis
propios tests por primera vez (documentadas para que no se repitan): `PHOTO_REQUIRED`
faltante en los `POST /shifts/{id}/close/count` que escribí (la sede tiene
`cash.photo_required` encendida por defecto); usé el nombre de parámetro
`responsible=` de la fixture de nivel superior en un test que en realidad
resuelve contra la fixture-sombra de `tests/shifts/conftest.py`, cuyo
parámetro se llama `cash_responsible=`; y un `error.extra` que en realidad
viaja **aplanado** dentro de `error` (`AppError.body()` hace
`payload.update(self.extra)`), no anidado bajo `error.extra`.

```
$ cd backend && python -m mypy app
app/orders/service.py:363,374,375,433,449,450: error [arg-type] (EmployeeRef.name: str | None)
app/orders/service.py:1519,1520: error [attr-defined] ("FromClause" has no attribute "delete")
app/orders/service.py:1576,1589: error [attr-defined] ("Result[Any]" has no attribute "rowcount")
Found 10 errors in 1 file (checked 57 source files)
```

Los 10 errores están **todos** en `app/orders/service.py` (territorio de
`backend-comanda`, archivo a medio escribir mientras yo verificaba). **Cero
errores en mi territorio.** No los arreglé, como manda la regla de
verificación (reportar, no tocar código ajeno).

No corrí Alembic (`0004_orders.py`/`0005_payments_fiscal.py` no existían al
cerrar este output), `npm run build` ni la suite completa: son del paso de
verificación final del Maestro.

## 7. Gaps

Nota de timing: `backend-comanda` y `backend-cobro` construyen en paralelo
sobre el mismo árbol. Los tres primeros puntos describen lo que faltaba
**al momento de escribir y correr mis tests** (mi verificación de §6 es
literal contra ese estado); dejo también, entre corchetes, lo que noté que
ya había cambiado al cerrar este documento, sin haber vuelto a correr mi
suite completa contra eso (no es mi verificación oficial, es información de
cortesía para quien retome).

- **`test_sales_totals_flow_into_shift`** (mío, `tests/shifts/test_sales_totals_e2e.py`)
  queda `skip` (`pytest.mark.skipif`) hasta que exista `app.orders.router`
  **y** `app.payments.models`. Al correr mi verificación (§6), ninguno de
  los dos existía. [Nota: `app/orders/router.py` y
  `alembic/versions/0004_orders.py` aparecieron en el árbol mientras yo
  verificaba — `backend-comanda` avanzó en paralelo. `app/payments` seguía
  sin existir. El test sigue en `skip` porque la condición es un `and`; en
  cuanto `backend-cobro` cree `app/payments/models.py` con `Payment`, corre
  solo, sin que nadie tenga que tocar el `skipif`.] Agrupa `cash`+`card` con
  propina, valida `GET /shifts/{id}` como admin (`expected == base + cash`,
  `sales.card`, `tips.cash`) y que `close/count` exija `counted_card`.
- **`tests/shifts/test_open_orders_gate.py`** SÍ corre completo hoy (no es un
  gap): usa `app.orders.models.Order`/`OrderChannel`/`OrderStatus` y
  `app.orders.hooks.{count_open_orders,detach_open_orders,adopt_transferred_orders}`
  directamente (ya existían desde el principio, los escribió
  `backend-comanda`), sin pasar por `POST /orders`. Ahora que
  `app/orders/router.py` existe, vale la pena que `backend-comanda` o el
  auditor agreguen un test equivalente que sí pase por la API completa (crear
  la comanda por `POST /orders` en vez de insertar el modelo a mano) — lo
  dejo señalado, no lo escribo yo porque tocaría fixtures que no son mi
  territorio (`tests/orders/`).
- **Alembic `0005_payments_fiscal.py`**: no existía al cerrar este output
  (`0004_orders.py` sí apareció, ver arriba); no pude correr
  `alembic upgrade head` desde cero para confirmar que el esquema completo
  migra en SQLite. Quien verifique al final tiene que correrlo una sola vez
  con `DATABASE_URL=sqlite:////tmp/<algo>/mig.db`.
- **`app/orders/service.py` (10 errores de mypy en mi corrida de §6)**: no
  son míos; se los señalo a `backend-comanda` por si todavía no corrió su
  propio `mypy app` (`EmployeeRef.name` no acepta `str | None` — necesita
  `or ""` o revisar de dónde sale ese `None`; `FromClause.delete`/
  `Result.rowcount` sugieren una consulta SQLAlchemy 2 armada con la API
  vieja de Core, probablemente en el `UPDATE ... WHERE` condicional de
  `claim_payment`/algo similar). Puede que ya estén resueltos si
  `backend-comanda` siguió trabajando después de mi corrida.
- **`GET /device/employees` y el resto de mi entrega no tienen dependencias
  pendientes**: `frontend-cobro` puede consumir la ruta ya mismo
  (`listDeviceEmployees` en `src/api/employees.ts`); no hay nada de mi lado
  bloqueando ese trabajo.
- Nada de lo mío depende de Postgres real; no hay gap ahí más allá de lo que
  ya arrastraba 1a (CI/Postgres no corren en este entorno).
