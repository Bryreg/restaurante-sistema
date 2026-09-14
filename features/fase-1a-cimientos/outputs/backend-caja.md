# Backend — día operativo y turno de caja (pedido 1a)

Agente: `backend-caja`. Territorio: `backend/app/shifts/**`, `backend/tests/shifts/**`,
`backend/alembic/versions/0003_shifts.py`. No se tocó ningún archivo fuera de ese
territorio.

## 1. Modelos y constraints (`app/shifts/models.py`)

Todos con `organization_id` + `store_id` (índice en ambos), dinero en `Integer`,
enums `sa.Enum(..., native_enum=False)` subclaseando `str` (comparables por valor:
`shift.status == "open"` y `shift.status == ShiftStatus.OPEN` son equivalentes).
Nada se borra físicamente.

- **`BusinessDay`**: `store_id`, `business_date` (`Date`), `status` (`open|closed`),
  `opened_at`, `closed_at`. `UNIQUE(store_id, business_date)`
  (`uq_business_days_store_date`) + índice `(store_id, status)`.
- **`Shift`**: `business_day_id`, `status` (`open|closed|cancelled`), `opened_at`,
  `opened_by_employee_id/name`, `cash_responsible_id/name`, `opening_cash_total`,
  `opening_denominations` (JSON), `cash_reserve`, `opening_cause` (enum
  `CashDifferenceCause`, nullable), `opening_note`, `closes_day`, `closed_at`,
  `closed_by_employee_id/name`, `closed_without_count`, `expected_cash`,
  `counted_cash`, `difference`, `close_cause`, `close_note`, `to_deposit`,
  `reviewed_by_employee_id/name`, `reviewed_at`, `reopen_reason`, `reopened_at`,
  `reopened_by_employee_id`, `cancelled_at/reason/by_employee_id`, `adjustments`
  (JSON: historial de ajustes de apertura, nunca se pisa el anterior). Índice único
  parcial **`uq_shifts_one_open_per_store`** sobre `(store_id)` con
  `postgresql_where`/`sqlite_where` `status = 'open'`; `CHECK(opening_cash_total >= 0)`.
  **Decisión de diseño**: no hay columna `active_close_count_id` (puntero a
  `shift_close_counts`) — crearía un ciclo de FK entre las dos tablas que SQLite no
  puede resolver con `ALTER TABLE ADD CONSTRAINT` (`use_alter=True` no funciona ahí).
  El conteo "activo" (el más reciente no superado) se busca por consulta
  (`service._get_active_close_count`), nunca se guarda un puntero.
- **`ShiftRoster`**: `shift_id`, `employee_id/name`, `in_at`, `out_at`, `pauses`
  (JSON `[{"start","end"}]`). Índice `(shift_id, employee_id)`.
- **`CashMovement`**: `kind` (`income|expense`), `cause` (6 valores tipados),
  `amount` (`CHECK > 0`), `note`, `receipt_photo`, `employee_id/name`,
  `authorized_by_employee_id/name` (nullable), `at`.
- **`CashSwap`**: `out_denominations`, `in_denominations` (JSON), `amount`
  (`CHECK >= 0`), `employee_id/name`, `at`. No participa en la matemática del
  esperado.
- **`CashPickup`**: `amount` (`CHECK > 0`), `denominations` (nullable),
  `envelope_ref`, `note`, `photo`, `expected_at_pickup` (snapshot), `employee_id/name`,
  `authorized_by_employee_id/name`, `at`, `reversed_at/reason/by_employee_id/name`
  (reversa = marca, nunca borra).
- **`ShiftHandover`**: `kind` (`handover|spot_check`), `counted_cash(_denominations)`,
  `counted_card`, `counted_transfer`, `breakdown` (JSON congelado:
  `base/cash_sales/incomes/expenses/pickups/expected/counted/difference`),
  `from_responsible_id/name`, `new_responsible_id/name` (nullable),
  `authorized_by_employee_id/name` (nullable), `photo`, `at`.
- **`ShiftCloseCount`** (paso 1 del cierre a ciegas): `counted_cash_total`,
  `counted_cash_denominations`, `counted_card`, `counted_transfer`, `tips_cash_out`,
  `photo`, `created_by_employee_id/name`, `created_at`, `superseded` (bool: queda
  `True` cuando un `reopen` lo deja histórico; la fila **nunca se borra**).

Migración `alembic/versions/0003_shifts.py`: `revision="0003"`, `down_revision="0002"`
(ver gap §5), DDL Postgres-first escrito a mano (índices por cada FK y por cada
filtro de pantalla, `CHECK` constraints, el índice único parcial con
`postgresql_where`/`sqlite_where`). Sin la FK circular (ver arriba), no hace falta
`ALTER TABLE` al final ni `batch_alter_table`.

## 2. La matemática — una sola función (`app/shifts/service.py::compute_breakdown`)

```python
def compute_breakdown(db, shift) -> dict[str, int]:
    sales = hooks.get_sales_totals(db, shift.id)   # 1a: siempre {cash:0,...} — comentario para 1b
    incomes = sum(CashMovement.amount where kind=income)
    expenses = sum(CashMovement.amount where kind=expense)
    pickups = sum(CashPickup.amount where reversed_at IS NULL)
    expected = shift.opening_cash_total + sales.cash + incomes - expenses - pickups
    return {base, cash_sales, incomes, expenses, pickups, expected}
```

- **La reserva no entra** (no aparece en la función).
- **El `cash_swap` no entra** (ni se consulta).
- **Los retiros reversados no restan** (filtro `reversed_at IS NULL`).
- **Ajustar apertura** reescribe `opening_cash_total`/`cash_reserve` y llama a la
  misma función para recalcular lo derivado — no hay una segunda fórmula.
- Todo lo que necesita "el esperado en este instante" (revelar en `review`, snapshot
  de un retiro, relevo, arqueo, `GET /shifts/current` para admin/responsable) pasa
  por acá. La evaluación del cierre (`_evaluate_close`/`CloseEvaluation`) envuelve
  esta función para agregar `difference`, tolerancias y lo de datáfono/transferencias,
  pero nunca reimplementa la suma.
- `to_deposit = counted − opening_cash_fixed (de la sede, `StoreCashSettings`) −
  tips_cash_out`. Vive en `_finalize_close` (cierre normal) y en
  `close_administrative` (sin conteo, usa `expected` en lugar de `counted`).
- `is_stale`: el turno sigue `open` después de la hora de corte del **día
  siguiente** a su `business_date` (`service.is_shift_stale`, usa `core.tz.BOGOTA`
  y `core.clock.now_utc()`, nunca `datetime.now()`).
- `cash_over_threshold`: `expected >= cash_pickup_threshold` (`service.cash_over_threshold`).

## 3. Endpoints (contrato de `spec.md`)

Todas las rutas se registran sin prefijo en `app/shifts/router.py`; `app.main`
agrega `/api/v1`. `Idempotency-Key` usa `app.core.idempotency.run_idempotent` +
`hash_request_body` (ya provistos por `backend-core`, no reimplementados).

| Método y ruta | Éxito | Errores de negocio | Flag |
|---|---|---|---|
| `GET /shifts/current` | 200 (o `null`) | — | `cash_over_threshold`/`shift_stale` se notifican con dedupe diario en cada llamada |
| `POST /shifts/open` (Idempotency-Key) | 201 | `SHIFT_ALREADY_OPEN` 400, `409 SHIFT_OPEN_RACE` (IntegrityError del índice parcial), `OPENING_DIFFERENCE_NEEDS_CAUSE` 400 | `cash.reserve` (si está apagada, `cash_reserve` se ignora y queda en 0) |
| `GET /shifts/{id}` | 200 | `404 NOT_FOUND` (otra org/sede) | — |
| `POST /shifts/{id}/roster` | 200 | `PIN_INVALID`, `NOT_CASH_RESPONSIBLE` (el responsable sale por `handovers`), `EMPLOYEE_NOT_IN_ROSTER` | — |
| `POST /shifts/{id}/handovers` (Idempotency-Key) | 201 | `SHIFT_NOT_OPEN`, `VALIDATION_ERROR` (falta `new_responsible_id` en `handover`), + lo que levante `verify_authorizer` (`AUTHORIZATION_REQUIRED/INVALID/NOT_ALLOWED`, `PIN_LOCKED`) para `spot_check` | `cash.handovers` (`require_feature`) |
| `POST /shifts/{id}/cash-movements` (Idempotency-Key) | 201 | `SHIFT_NOT_OPEN`, `PETTY_CASH_LIMIT` (egreso > `petty_cash_limit` sin `authorizer_pin`) | — (no está en el catálogo de flags: es capacidad core) |
| `POST /shifts/{id}/cash-swaps` | 201 | `SHIFT_NOT_OPEN`, `SWAP_NOT_ZERO` | `cash.swaps` |
| `POST /shifts/{id}/pickups` (Idempotency-Key) | 201 | `SHIFT_NOT_OPEN`, `PHOTO_REQUIRED`, + `verify_authorizer` (`action="pickup"`, admin-only) | `cash.pickups` |
| `POST /shifts/{id}/pickups/{pid}/reverse` | 200 | `PICKUP_ALREADY_REVERSED`, `verify_authorizer` (`action="pickup_reverse"`) | `cash.pickups` |
| `POST /shifts/{id}/close/count` (Idempotency-Key) | 201 → `{count_id}` | `SHIFT_NOT_OPEN`, `PHOTO_REQUIRED`, `CARD_TOTAL_REQUIRED`, `TRANSFER_TOTAL_REQUIRED` | `cash.blind_close` |
| `GET /shifts/{id}/close/{count_id}/review` | 200 | `404 NOT_FOUND` (conteo ajeno) | `cash.blind_close` |
| `POST /shifts/{id}/close/{count_id}/confirm` | 200 → `{to_deposit, closes_day}` | `DIFFERENCE_CHANGED` (con `extra.review` recalculado), `CAUSE_REQUIRED`, `IDENTIFIED_CAUSE_REQUIRED` | `cash.blind_close` |
| `POST /shifts/{id}/close` (un solo paso) | 200 → `{to_deposit, closes_day, expected, difference}` | mismos códigos que el flujo de 3 pasos (comparte `create_close_count`/`_evaluate_close`/`_finalize_close`) | ver §4 (decisión de diseño) |
| `GET /admin/shifts?store_id&from&to[&format=csv]` | 200 | `404` (sede ajena, vía `admin_store`) | — |
| `GET /admin/shifts/{id}/timeline` | 200 | `404` (turno de otra org) | — |
| `POST /admin/shifts/{id}/review` | 200 | `404` | — |
| `POST /admin/shifts/{id}/close-administrative` | 200 | `SHIFT_NOT_OPEN`, `SHIFT_NOT_STALE` | — |
| `POST /admin/shifts/{id}/reopen` | 200 | `409 CONFLICT` (no estaba cerrado) | — |
| `DELETE /admin/shifts/{id}` | 200 | `409 CONFLICT` (no estaba abierto), `SHIFT_HAS_ACTIVITY` | — |
| `POST /admin/shifts/{id}/adjust-opening` | 200 | `409 CONFLICT` (turno cancelado) | — |
| `GET /admin/business-days?store_id&from&to` | 200 | `404` (sede ajena) | — |
| `GET /admin/employees/{id}/activity?from&to[&store_id]` | 200 | `404` (empleado de otra org) | — |

Todo `400` de negocio usa `AppError(code, message, status)` (provisto por
`backend-core`, `app/core/errors.py`) con `message` que nombra la acción correctiva
(ninguna regla de negocio devuelve 500). El operador (`current_operator`, Actor de
dispositivo) nunca recibe `expected_cash` salvo que su `employee_id` sea el
`cash_responsible_id` del turno o su rol sea `admin`; se resuelve en
`_shift_summary`/`GET /shifts/current` comparando contra el Actor, nunca en el
frontend.

## 4. Decisión de diseño: `cash.blind_close` apagado/encendido

`spec.md` dice "apagado: un solo `POST /shifts/{id}/close}`... con flag encendido,
los tres pasos". Implementé:

- Los tres endpoints `close/count`, `close/{count_id}/review`,
  `close/{count_id}/confirm` están **gateados** con `require_feature("cash.blind_close")`
  → `400 FEATURE_DISABLED` cuando está apagada (test del checklist).
- `POST /shifts/{id}/close` (un solo paso) queda **siempre disponible**, sin
  `require_feature`, y reutiliza exactamente la misma cadena interna
  (`create_close_count` → `_evaluate_close` → `_validate_close_cause` →
  `_finalize_close`) en una sola llamada. Sigue siendo "a ciegas" en el sentido de
  que el cliente nunca ve el esperado antes de mandar el conteo+causa; la única
  diferencia con el flujo de tres pasos es que no hay ida y vuelta HTTP.
- No inventé un código de error nuevo para "estás con `blind_close` encendido y
  llamaste al de un paso": simplemente ambos caminos conviven. Documento esto como
  gap de interpretación en §5 por si el Maestro quiere que el de un paso responda
  `FEATURE_DISABLED` cuando el flag está prendido (forzando el flujo de tres pasos).

## 5. Gaps (todo lo que depende de otro agente o queda ambiguo)

**Bloqueantes de verificación completa (no dependen de mí):**

1. **`alembic upgrade head` no corre completo**: `backend/alembic/versions/0002_catalog.py`
   (territorio de `catalogo`) todavía no existe al momento de este entregable. Mi
   `0003_shifts.py` queda con `down_revision="0002"` tal como indica el contrato;
   `DATABASE_URL=sqlite:////tmp/pt-backend-caja/mig.db python -m alembic upgrade head`
   falla con `KeyError: '0002'`. La cadena `0001→0002→0003` hay que volver a
   verificarla en la ronda de integración final, cuando `catalogo` haya entregado.
2. **Test de concurrencia real bloqueado por el fixture compartido `db`**
   (`tests/conftest.py`, territorio de `backend-core`): `_override_get_db` cierra
   sobre **un solo objeto `Session`** (`session = testing_session_local()`, creado
   una vez por test) y lo devuelve para *todas* las requests de ese test, incluidas
   las que llegan desde hilos distintos. `Session` de SQLAlchemy no es thread-safe
   para uso concurrente: dos hilos escribiendo a la vez producen
   `InvalidRequestError("Session is already flushing")` /
   `ResourceClosedError("This transaction is closed")`, y la request nunca llega a
   devolver 200 ni 409 — mi test
   `test_two_concurrent_opens_one_wins_one_gets_409` (que ejercita exactamente la
   regla del checklist: dos `POST /shifts/open` con hilos → uno 200/201, otro 409)
   falla por esto, no por mi código (el índice único parcial y el manejo de
   `IntegrityError` en `service.open_shift` están escritos y se ejercitan
   correctamente en el resto de la suite). Sugerencia concreta para
   `backend-core`: que `_override_get_db` cree una sesión nueva
   (`testing_session_local()`) en cada llamada en lugar de cerrar sobre la del
   fixture — el motor/pool ya soporta múltiples conexiones (`check_same_thread=False`,
   sin `StaticPool`), falta que cada request tenga su propia `Session`.
3. Encontré (y no toqué, no es mi territorio) que **`DateTime(timezone=True)` sobre
   SQLite no preserva el `tzinfo` al releer** (trampa listada en
   `docs/SPEC-NEGOCIO.md §12`): confirmé con un repro aislado que un valor aware
   escrito vuelve `tzinfo=None` al leerlo en una sesión nueva. Esto puede volver a
   aparecer como `TypeError: can't compare offset-naive and offset-aware datetimes`
   en cualquier comparación tipo `columna_datetime <= clock.now_utc()` (lo vi una
   vez en `app.auth.deps.current_operator` contra `employee_expires_at`, en una
   corrida anterior a este entregable; en la corrida final ya no se reprodujo de
   forma aislada, probablemente por cambios de `backend-core` en curso, pero el
   riesgo estructural sigue latente para cualquier columna `DateTime(timezone=True)`
   que se relea después de que la sesión expire sus objetos). Si vuelve a aparecer
   en ronda 2, la causa es esta, y la corrección va en `app/core/db.py` (un
   `TypeDecorator` que reatache `tzinfo=UTC` al leer en SQLite), no en cada dominio.

**Ambigüedades de la spec que interpreté (declaradas, no asumidas en silencio):**

4. `POST /shifts/{id}/roster` no trae `pin` en el ejemplo JSON de `spec.md`, pero el
   pedido del Maestro y la regla "PIN de la persona: `verify_pin`" lo exigen.
   Agregué `pin: str` al body (`RosterActionIn`) — es un campo agregado, no un
   renombre, así que no rompe el contrato ("el backend puede agregar campos").
5. `POST /shifts/{id}/pickups` en `spec.md` no lista `photo` en el JSON de ejemplo,
   pero `cash.photo_required` + `photo_required_on_pickup` (spec de negocio §3.2 y
   `StoreCashSettings`) exigen algo que validar. Agregué `photo?: str` opcional al
   body y lo exijo con `PHOTO_REQUIRED` cuando corresponde — mismo criterio que el
   punto anterior.
6. `closes_day_suggested` en la respuesta de `review`: no está en el JSON de
   `spec.md` pero sí en el pedido del Maestro. Lo calculé como "no hay otro turno
   abierto para el mismo `business_day_id`" (heurística razonable; la spec de
   negocio solo dice que por defecto lo marca el turno cuya hora de cierre es la
   última del horario de la sede, algo que 1a no modela todavía porque
   `opening_hours` de `Store` llega vacío en el seed).
7. `DELETE /admin/shifts/{id}` no lleva body en el contrato (verbo DELETE); usé un
   motivo fijo en el audit log (`"Cancelado por administrador..."`) en vez de pedir
   `reason` en el body. Si el frontend necesita un motivo libre acá, es un cambio de
   una línea (agregar un body opcional) que puede pedirse en ronda 2.
8. "Racha de `streak_alert_shifts` cierres con diferencia por la misma persona" la
   interpreté como: los últimos `N` turnos **cerrados** de la sede cuyo
   `cash_responsible_id` es esta persona, ordenados por `closed_at` descendente,
   todos con `difference != 0`. Cubierto por `service._check_difference_streak`
   (para notificar en el cierre) y `service.employee_activity` (para reportarlo en
   `GET /admin/employees/{id}/activity`, con el mismo criterio pero de lectura).
9. `"actividad"` que bloquea `DELETE /admin/shifts/{id}` (`SHIFT_HAS_ACTIVITY`): la
   spec no la define con precisión. Implementé: cualquier `CashMovement`, `CashSwap`,
   `CashPickup`, `ShiftHandover` o `ShiftCloseCount`, **o** más de una entrada en el
   roster, **o** una entrada de roster con `out_at`/pausas. Un turno recién abierto
   (solo la entrada automática del responsable) se puede cancelar; cualquier otra
   cosa, no.
10. `employee_activity` no tiene `format=csv` implementado (sí lo tienen
    `/admin/shifts` y, por construcción, `/admin/business-days` reutilizando el
    mismo serializador). Es una fila más de trabajo si se necesita.

**Dependencias de otros agentes ya resueltas (documentadas, no son gap real):**

- `app.catalog.service.reset_daily_availability` se llama protegido con
  `importlib.util.find_spec("app.catalog.service")` desde `open_shift` cuando el
  día se crea — hoy no existe (`catalogo` no llegó ahí todavía), así que es un
  no-op; cuando exista, se activa solo.
- `app.shifts.hooks.get_sales_totals` devuelve siempre ceros con el comentario de
  reemplazo para 1b (no hay comandas ni cobro en 1a, por alcance del pedido).
- `app.shifts.hooks.on_employee_identified` está escrito y probado directamente
  (`tests/shifts/test_roster_and_hooks.py`); falta que `backend-core` lo esté
  llamando de verdad desde `POST /auth/device/identify` — no pude confirmarlo
  leyendo `app/auth/router.py` en el momento de escribir esto (no es mi
  territorio inspeccionarlo a fondo, pero si no lo llama, identificarse no agrega
  al roster y es un bug de integración a reportar en la ronda de verificación
  final, no mío).

## 6. Tests escritos y resultado final

Comando: `cd backend && TMPDIR=/tmp/pt-backend-caja python -m pytest tests/shifts -q`.

**Resultado: 30 passed, 1 failed** (el único fallo es el gap #2 de arriba, ajeno a
este código — confirmado con la traza exacta `Session is already flushing` /
`ResourceClosedError`).

| Archivo | Qué prueba | Resultado |
|---|---|---|
| `tests/shifts/conftest.py` | fixture propia `open_shift(...)` (abre con base fija por defecto, o con `total`/`denominations`/`opening_cause` custom) | — (fixture, no test) |
| `test_open.py` | día operativo + roster al abrir; `SHIFT_ALREADY_OPEN`; `OPENING_DIFFERENCE_NEEDS_CAUSE` → acepta con causa; dos aperturas concurrentes por hilos → uno gana, otro `409` | 3 OK, 1 **bloqueado por gap #2** |
| `test_cash_operations.py` | reserva no cambia el esperado; swap neto cero no cambia el esperado; `SWAP_NOT_ZERO`; retiro baja el esperado y guarda `expected_at_pickup`; reversa de retiro (y doble reversa → `PICKUP_ALREADY_REVERSED`); `PETTY_CASH_LIMIT` con/sin `authorizer_pin`; gasto menor bajo el límite no pide PIN; replay de `Idempotency-Key` no duplica el movimiento | 8 OK |
| `test_close.py` | `count` no revela el esperado, `review` sí; `confirm` con `difference_seen` vieja → `DIFFERENCE_CHANGED`; tolerancia `unknown` / causa identificada obligatoria / crítica (cierra igual); `PHOTO_REQUIRED`; `cash.handovers` apagado → `FEATURE_DISABLED`; `cash.blind_close` apagado → cierre en un paso (y el flujo de 3 pasos da `FEATURE_DISABLED`) | 9 OK |
| `test_admin.py` | admin de otra organización → `404` (turno y listado); cierre administrativo solo si stale; reopen conserva el conteo anterior (`superseded=True`, valores intactos); cancelar con actividad → `400`; `adjust-opening` recalcula el esperado con la misma fórmula; racha de 3 cierres con diferencia → notifica `difference_streak` (verificado con `monkeypatch` sobre `service.notify`, no contra el esquema de `Notification` que no es mi territorio) | 6 OK |
| `test_roster_and_hooks.py` | `hooks.on_employee_identified` agrega al roster (llamado directo, idempotente); sin turno abierto es no-op; el responsable de caja no sale por `roster` (`NOT_CASH_RESPONSIBLE`); entrada/salida de un operador normal; PIN incorrecto → `PIN_INVALID` | 4 OK |

`python -m mypy app/shifts` → **`Success: no issues found in 6 source files`**.

`DATABASE_URL=sqlite:////tmp/pt-backend-caja/mig.db alembic upgrade head` → falla
por `0002_catalog.py` ausente (gap #1); la sintaxis y el DDL de `0003_shifts.py` se
verificaron con `python -m py_compile` y una revisión manual columna por columna
contra `models.py`.

Nota de método: antes de que existieran `backend/tests/conftest.py` y
`backend/app/core/idempotency.py`, escribí todo el código (modelos, schemas,
service, router, hooks, migración y los seis archivos de test) sin ejecutar nada,
como pedía el orden de arranque. Cuando `backend-core` los publicó, alineé las
firmas exactas (`AppError`, `run_idempotent`, `hash_request_body`,
`verify_authorizer`/`verify_pin`, `Actor`, `admin_store`, `get_cash_settings`,
`record_audit`, `notify`) contra el código real (no contra mi suposición) y corregí
7 errores de tipos que `mypy` encontró en esa alineación (conversión de `Literal`
str a los enums de SQLAlchemy en las respuestas, narrowing de `Optional`, y una
variable con dos tipos inferidos en `get_or_create_business_day`).

## 7. Archivos tocados

- `backend/app/shifts/__init__.py`
- `backend/app/shifts/models.py`
- `backend/app/shifts/schemas.py`
- `backend/app/shifts/service.py`
- `backend/app/shifts/router.py`
- `backend/app/shifts/hooks.py`
- `backend/alembic/versions/0003_shifts.py`
- `backend/tests/shifts/__init__.py`
- `backend/tests/shifts/conftest.py`
- `backend/tests/shifts/test_open.py`
- `backend/tests/shifts/test_cash_operations.py`
- `backend/tests/shifts/test_close.py`
- `backend/tests/shifts/test_admin.py`
- `backend/tests/shifts/test_roster_and_hooks.py`
