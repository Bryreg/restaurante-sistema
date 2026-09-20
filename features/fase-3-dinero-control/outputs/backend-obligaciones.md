# Entregable — `backend-obligaciones` (T2, Fase 3 «dinero y control»)

> **Actualización — iteración 2 (ajuste del Maestro sobre la cadena de Alembic).**
> El Conciliador no levantó ningún conflicto sobre este territorio (`app/expenses/`, D-2,
> punto de equilibrio, utilidad): pasó limpio, nada se rehace de lo de abajo. El único
> ajuste asignado fue el bloqueo de verificación de toda la fase, que vivía en mi propia
> migración `0019`: ver **§7-bis** para el diagnóstico, el fix y la verificación de punta a
> punta (SQLite **y** Postgres) que faltaba. El resto de este documento (§1-6, §8-10) es
> el entregable original de la ronda anterior, sin cambios — sigue describiendo el estado
> real del código.

Territorio: `backend/app/expenses/**`, `backend/alembic/versions/0018_expenses.py`,
`backend/alembic/versions/0019_invoice_total.py`, `backend/tests/expenses/**`,
`backend/tests/audit/test_expenses_invariants.py`, y la excepción D-2 acotada sobre
`app/purchases/` (columna nueva en `receptions`, campo nuevo en su esquema,
`invoice_discrepancy` derivado en la salida de la cuenta por pagar, `confirm_discrepancy`
en su aprobación, y la migración `0019`).

---

## 1. La llave anti doble conteo de este territorio

Diseñada antes de escribir la primera ruta de consulta (está también, en extenso, en el
docstring de `app/expenses/service.py`):

> **PAGO** (proveedor, vía `app.purchases`) vs **MOVIMIENTO DE BANCO** (vía `app.banking`,
> T1) vs **EGRESO DE CAJA** (vía `app.shifts.hooks`) vs **GASTO/OBLIGACIÓN de este
> dominio**. Un mismo peso nunca puede contarse dos veces entre esas cuatro bolsas.

Tres reglas estructurales, no sólo de convención, la hacen cumplir:

1. **`Expense`/`Obligation` nunca leen ni suman `Payable`/`Payment`** (`app.purchases`).
   La plata de una compra a proveedor ya entra al costo del inventario
   (`OrderItem.unit_cost_micros`, congelado al vender); si este dominio también la sumara
   como gasto u obligación, la misma compra pagaría el food cost **y** la utilidad del
   período. `Expense`/`Obligation` son estrictamente lo que NO es compra de inventario
   (arriendo, servicios, impuestos, mantenimiento, mercadeo…).
2. **`Expense`/`Obligation` nunca crean un `CashMovement`.** No hay una sola llamada a
   `app.shifts.hooks` que escriba un movimiento nuevo en todo `app/expenses/`
   (`grep -rn "shifts.hooks\." app/expenses/` no devuelve nada que escriba). El esperado
   del turno (`compute_breakdown`) es estructuralmente imposible de tocar desde acá — no
   es una promesa, es una propiedad del código: la única forma de moverlo sería importar y
   llamar a un hook de escritura de `shifts`, y no existe esa línea.
3. **Cuando un gasto SÍ sale del cajón** (`source == "cash_drawer"`), la plata entra
   PRIMERO por la puerta que `app.shifts` ya publica (`POST /shifts/{id}/cash-movements`,
   causa tipada `petty_expense`/`emergency_purchase`/`other_expense`, ya existentes —
   ninguna causa nueva). Este dominio sólo puede **referenciar** ese movimiento ya creado
   (`cash_movement_id`, validado contra `CashMovement` real, su sede y su causa) — nunca
   crear uno. `POST /admin/expenses`/`POST .../obligations/{id}/settle` rechazan con
   `400 VALIDATION_ERROR` si `source=cash_drawer` sin `cash_movement_id`, o si
   `cash_movement_id` viene con otro `source`; y con `404` si el movimiento referenciado
   no existe en la sede.

**Probado, no sólo declarado** (`tests/expenses/test_expenses.py` y
`tests/audit/test_expenses_invariants.py`):
- Un gasto `source="bank"` deja el esperado del turno **exactamente igual**, medido antes
  y después (`test_expense_that_never_touched_the_drawer_leaves_expected_cash_unchanged`,
  `test_an_expense_that_never_moves_the_shift_expected`).
- Un gasto `source="cash_drawer"` que referencia un movimiento real **no** vuelve a mover
  el esperado (`test_expense_referencing_an_existing_cash_drawer_movement_does_not_move_expected_again`).
- El conteo real de filas en `cash_movements` **no crece** al crear un gasto, con y sin
  referencia (`test_expenses_never_write_a_second_cash_movements_row`, parametrizado).

---

## 2. Qué construí y el modelo de datos

`app/expenses/models.py` (migración `0018`):

- **`Expense`** — gasto del período (ad hoc, sin vencimiento): `category`
  (`supplies`/`maintenance`/`utilities`/`marketing`/`transport`/`other`), `description`,
  `amount` (pesos, `> 0`), `business_date`, `source`
  (`cash_drawer`/`bank`/`other`) + `cash_movement_id` opcional (FK real a
  `cash_movements`, sólo con `source=cash_drawer`), atribución
  (`created_by_employee_id/_name`), y baja lógica (`voided_at/_reason/_by_*`) — nada se
  borra.
- **`Obligation`** — obligación agendada (arriendo, servicios, impuestos): `category`
  (`rent`/`utilities`/`taxes`/`other`), `description`, `amount`, `due_date`, `status`
  (`pending`/`paid`), saldado (`settled_at/_by_*/_source`, `cash_movement_id` opcional,
  mismo contrato que `Expense`), atribución de creación, y cancelación lógica
  (`cancelled_at/_reason/_by_*`). **`overdue` no es una columna**: se deriva en la salida
  (`cancelled_at is None and status == "pending" and due_date < hoy`), mismo criterio que
  `PayableOut.overdue` en `purchases`.
- **`StoreExpensesSettings`** — costos fijos declarados por la sede (`fixed_costs: int |
  None`), PK `store_id`. Vive en **este** dominio, no en `app.stores.models` (precedente
  de 2a/2b, `StoreInventorySettings`); `app/stores/` no es territorio de nadie en este
  pedido.

`app/expenses/service.py` tiene **toda** la matemática (punto de equilibrio, utilidad,
las validaciones de la llave anti doble conteo); `router.py` es sólo borde HTTP.
`hooks.py` existe por la anatomía de dominio del proyecto pero queda **vacío a
propósito**: ningún otro territorio de esta fase declaró consumir algo de `expenses` (T1
arma la mano del dueño sólo con `CashPickup`; T4 no lo menciona).

---

## 3. Rutas publicadas

Todas bajo `/api/v1`, todas de admin (`current_admin` + `admin_store`), todas detrás de
`require_feature("money.obligations")` a nivel de router (así que **ninguna** puede
responder sin el gate, incluida una que yo hubiera olvidado proteger a mano).

**Del contrato mínimo, exactas:**
- `GET`/`POST /admin/expenses`
- `GET`/`POST /admin/obligations`
- `POST /admin/obligations/{id}/settle` (`Idempotency-Key`)
- `GET /admin/break-even` — `fixed_costs`, `contribution_margin_pct_bp`,
  `break_even_amount`, `available`, `reason`. Sin costos fijos: `break_even_amount: null`
  con `reason`, nunca `0` (probado).
- `GET /admin/profit` — `net_sales`, `cost`, `expenses`, `obligations`, `payroll`,
  `payroll_reason`, `profit`, `available`, `reason`.
- `GET /admin/payables/{id}` (extensión D-2) — gana `invoice_total`/`invoice_discrepancy`.
- `POST /admin/payables/{id}/approve` (extensión D-2) — acepta `confirm_discrepancy`.

**Agregadas, declaradas acá** (todas bajo `money.obligations`, todas con
`Idempotency-Key` en las que escriben):
- `POST /admin/expenses/{id}/void` — baja lógica de un gasto cargado por error («nada
  financiero se borra» exige *algún* camino de corrección; el contrato mínimo no lo
  incluía).
- `POST /admin/obligations/{id}/cancel` — baja lógica de una obligación, simétrico al
  anterior.
- `GET`/`PATCH /admin/expenses/settings` — costos fijos de la sede. `GET /admin/break-even`
  necesita leerlos de algún lado, y este dominio no tiene permitido guardarlos en
  `app.stores`; sin esta ruta, nadie podría cargarlos nunca.

**Ninguna** ruta del contrato mínimo se cambió de forma (mismo verbo, mismo path, mismos
campos base) — sólo se extendió `PayableOut`/`PayableApproveIn` con los campos que D-2
nombra explícitamente.

---

## 4. Cómo consumo la agregación de `app/reports/` (prueba de que no sumo documentos de venta)

`compute_profit` y `_contribution_margin_pct_bp` (en `service.py`) llaman **una sola vez**
a `app.reports.service.aggregate_sales(db, store_id=..., date_from=..., date_to=...,
group_by=None)` y leen su `total` (`net`, `theoretical_cost`, `gross_margin`, `orders`)
tal cual — no hay ningún `select(FiscalDocument...)` ni `select(OrderItem...)` en todo
`app/expenses/`.

**Prueba ejecutable** (`tests/expenses/test_profit.py::test_profit_with_costed_sale_matches_reports_aggregation`
y `tests/expenses/test_settings_break_even.py::test_break_even_with_fixed_costs_and_costed_sales_computes_amount`):
el test vende un producto con receta costeada, pide `GET /admin/sales` (la agregación
real) y `GET /admin/profit`/`GET /admin/break-even` por separado, y compara: `net_sales ==
total["net"]`, `cost == total["theoretical_cost"]`, y `contribution_margin_pct_bp`/
`break_even_amount` recalculados a mano con la MISMA fórmula (`money.round_half_up`,
`app.orders.money`, el mismo utilitario que usa el resto del proyecto) sobre
`total["gross_margin"]`/`total["net"]`. Si `app.expenses` hubiera vuelto a sumar
documentos por su cuenta, cualquier divergencia de un solo peso habría roto el test.

**Caso "hubo ventas pero sin costo"**: `total.orders > 0` y `theoretical_cost is None`
(producto sin ficha técnica) hace que `cost` salga `None` con motivo y `profit`/
`break-even` salgan `unavailable` — nunca fingen que el costo fue `0`
(`test_profit_unavailable_when_there_were_sales_without_theoretical_cost`).

**Caso "no hubo ventas"**: `total.orders == 0` hace que `cost = 0` sea el valor correcto
(no `None`): no hubo nada que costear, así que `0` es un hecho, no una ausencia de dato.

---

## 5. Cómo consumo (o dejo declarada) la nómina de `app/payroll/`

`_period_payroll_cost` (en `service.py`) es la costura declarada hacia T3:

1. Si `payroll` está apagada para la sede: `payroll = 0` (legítimo — la sede decidió no
   llevar nómina, no es "sin datos").
2. Si está encendida:
   - `find_spec_safe("app.payroll.hooks")` es `None` (el módulo todavía no aterrizó
     cuando yo construí) → `payroll = None`, `payroll_reason` nombra que el dominio no
     está instalado. `profit` sale `unavailable` con ese motivo.
   - Si el módulo existe pero no publica `period_payroll_cost`, mismo resultado con un
     motivo que nombra la función exacta que falta.
   - Si publica la función, la llamo y uso su resultado tal cual — **nunca** calculo una
     nómina propia.

**Contrato esperado, declarado para que T3 lo pueda alinear** (o el orquestador
reconciliar si T3 usó otro nombre):

```python
# app/payroll/hooks.py
def period_payroll_cost(db: Session, *, store_id: int, date_from: date, date_to: date) -> int | None:
    """Costo de nómina del período, en pesos enteros. `None` sólo si la
    función misma no tiene datos suficientes para ese rango."""
```

Al momento de escribir este entregable, `app/payroll/` **no existía todavía** en el
árbol (T3 corría en paralelo). El test `tests/expenses/test_profit.py::test_profit_payroll_seam`
verifica el comportamiento de la costura en los dos estados posibles (módulo ausente ⇒
`payroll: null` con motivo y `profit` no disponible; módulo presente ⇒ el test se adapta
dinámicamente a lo que encuentre, sin asumir un valor). **Gap declarado en §10**: si para
cuando el orquestador corra la verificación final `app.payroll.hooks` ya existe con otro
nombre de función, hay que reconciliar el nombre acá o en `app/payroll/hooks.py` — nunca
calculando la nómina en `app/expenses/`.

---

## 6. D-2: cómo quedó, con el `409` y su mensaje literal

- `Reception` gana `invoice_total: int | None` (columna, migración `0019`). `ReceptionIn`
  gana el mismo campo; `create_reception` lo persiste tal cual, sin tocar el resto de la
  función.
- `Payable.amount` **no cambió de significado**: sigue siendo `Σ (pesos(costo pretax de la
  línea) + tax_amount)`, calculado, sin tocar una línea de esa fórmula.
- `invoice_discrepancy` es **derivado**, nunca almacenado: `app.purchases.service
  .get_invoice_discrepancy(db, payable=payable)` lee `Reception.invoice_total` (por
  `payable.reception_id`) y devuelve `(invoice_total, invoice_total - amount)`, o
  `(None, None)` si la recepción no capturó papel. `PayableOut` (usado por el listado, por
  `approve`, por `create_payment`, y por el `GET /admin/payables/{id}` nuevo) llama a esa
  función una vez por respuesta.
- `POST /admin/payables/{id}/approve` gana `confirm_discrepancy: bool = False`.
  `approve_payable` calcula la diferencia; si es distinta de cero y `confirm_discrepancy`
  es falso, corta:

  ```
  409 INVOICE_DISCREPANCY
  "La factura del proveedor dice $<invoice_total> pero el cálculo de la recepción da
  $<amount>; si es correcto, repetí la aprobación con confirm_discrepancy: true"
  ```

  con los dos números interpolados literalmente (probado por substring en
  `tests/expenses/test_invoice_discrepancy.py::test_approve_with_discrepancy_blocks_without_confirmation_naming_both_figures`
  y en el invariante de auditoría). Con `confirm_discrepancy: true`, aprueba y guarda
  `Payable.discrepancy_confirmed = True` +
  `discrepancy_confirmed_by_employee_id/_name` (el `actor`, mismo patrón que
  `Reception.price_confirmed_by_employee_*` de `confirm_price`, que es exactamente el
  patrón que copié — no inventé un segundo mecanismo de confirmación).
- Sin diferencia (`invoice_total is None` o `invoice_total == amount`), `approve_payable`
  no pide `confirm_discrepancy` y `discrepancy_confirmed` queda `False`.
- **Una cuenta con diferencia NO se aprueba sola**: probado también en negativo
  (`invoice_total < amount`, diferencia negativa) — también bloquea.
- Añadí `GET /admin/payables/{id}` porque el contrato de API mínimo lo nombra
  explícitamente y **no existía** antes de esta fase (sólo había listado). Es la extensión
  mínima para que esa ruta exista tal cual la pantalla la va a llamar.

**Estrictamente acotado a lo que D-2 enumera** — no toqué nada más de `app/purchases/`:
ni `list_payables`, ni `create_payment`, ni `void_payment`, ni `reverse_reception`, ni un
solo test de `tests/purchases/` existente (verificado: `git diff --stat` sobre
`app/purchases/` muestra sólo `models.py`, `schemas.py`, `service.py`, `router.py`, nada
en `tests/purchases/`).

---

## 7. Las dos migraciones

- **`0018_expenses.py`** — `revision="0018"`, `down_revision="0017"` (T1 `banking`).
  Crea `expenses`, `obligations`, `store_expenses_settings`. Sólo `CREATE TABLE` (DDL
  Postgres-first, sin `batch_alter_table`); los `_enum(...)` son `VARCHAR` planos en los
  dos motores. `downgrade` simétrico (`DROP TABLE` en orden inverso).
- **`0019_invoice_total.py`** — `revision="0019"`, `down_revision="0018"`. `ADD COLUMN`
  puro sobre `receptions`/`payables` (nunca `batch_alter_table`), todas nullable o con
  `server_default`, así que corre limpio sobre filas existentes. `downgrade` simétrico
  (`DROP COLUMN`, orden inverso). **Ver §7-bis**: la FK inline que llevaba
  `discrepancy_confirmed_by_employee_id` se sacó del `add_column` y se recrea aparte,
  guardada por dialecto.

---

## 7-bis. Ajuste de iteración 2 — la cadena de Alembic no llegaba a `head`

**Diagnóstico** (confirmado por el Maestro, verificado de nuevo acá antes de tocar nada):
`0019_invoice_total.py` línea 40 agregaba
`discrepancy_confirmed_by_employee_id` con una `sa.ForeignKey("employees.id")` **inline**
dentro del mismo `op.add_column`. `ADD COLUMN ... REFERENCES` por `ALTER TABLE` no lo
soporta SQLite fuera de `batch_alter_table` (`NotImplementedError`) — y
`batch_alter_table` es exactamente lo que el docstring de la propia migración (línea 7)
prohíbe, con razón, porque en Postgres reconstruye la tabla entera y puede tumbar el
deploy (`docs/CONTEXTO-AGENTES.md §12`, error repetido nº4). El defecto no era el
`ADD COLUMN` en sí — era la constraint metida adentro.

**Fix aplicado**, exactamente como lo pidió el Maestro:

1. La columna se agrega **plana**, sin la FK inline:
   `sa.Column("discrepancy_confirmed_by_employee_id", sa.Integer(), nullable=True)`.
2. El modelo (`app/purchases/models.py:271`) sigue declarando la FK real — no se tocó; es
   consistente con sus hermanos (152, 155, 163, 173, 260) y esa consistencia está bien.
3. La FK se crea **aparte**, sólo en motores que la soportan por `ALTER`:
   ```python
   if op.get_bind().dialect.name != "sqlite":
       op.create_foreign_key(
           "fk_payables_discrepancy_confirmed_by_employee_id",
           "payables", "employees",
           ["discrepancy_confirmed_by_employee_id"], ["id"],
       )
   ```
   con nombre de constraint explícito (no autogenerado), para que el `downgrade` lo pueda
   nombrar de vuelta sin ambigüedad.
4. `downgrade` simétrico: `drop_constraint` con el mismo guard de dialecto, **antes** de
   `drop_column` (si no, Postgres se queja de la constraint colgando de la columna que se
   intenta borrar).
5. Comentario corto en el código, sobre la línea del `add_column`, explicando el porqué
   del guard (para que el próximo `add_column` con FK en esta fase no repita el defecto).
6. Revisé `0018_expenses.py` (mío) y `0017_banking.py`/`0020_payroll.py` (ajenos, sólo
   inspección, sin editarlos) buscando el mismo patrón
   (`grep -n "add_column" ... | grep -i ForeignKey`): **ninguna otra migración de la fase
   tiene una FK inline en un `add_column`**. `0018` sólo tiene `create_table` (la FK
   inline en `create_table` no es el problema — ahí SQLite la soporta sin `ALTER`).
   `0017`/`0020` tampoco tienen ningún `add_column`. Nada que reportar como gap nuevo
   sobre territorio ajeno.

**Verificación de punta a punta — literal, en los dos motores:**

Cadena completa en SQLite, base limpia (`/tmp/pt-backend-obligaciones/chain_verify.db`,
recién creada):

```
$ DATABASE_URL="sqlite:////tmp/pt-backend-obligaciones/chain_verify.db" python -m alembic upgrade head
INFO  [alembic.runtime.migration] Running upgrade 0016 -> 0017, `banking`: ...
INFO  [alembic.runtime.migration] Running upgrade 0017 -> 0018, Gastos, obligaciones agendadas ...
INFO  [alembic.runtime.migration] Running upgrade 0018 -> 0019, D-2 (...): la recepción gana `invoice_total` ...
INFO  [alembic.runtime.migration] Running upgrade 0019 -> 0020, Jornada, tablas de recargos con vigencia, liquidación de nómina ...
(sin errores — llega a 0020 sin cortarse)

$ DATABASE_URL="sqlite:////tmp/pt-backend-obligaciones/chain_verify.db" python -m alembic heads
0020 (head)

$ DATABASE_URL="sqlite:////tmp/pt-backend-obligaciones/chain_verify.db" python -m alembic downgrade 0016
INFO  [alembic.runtime.migration] Running downgrade 0020 -> 0019, Jornada, ...
INFO  [alembic.runtime.migration] Running downgrade 0019 -> 0018, D-2 (...) ...
INFO  [alembic.runtime.migration] Running downgrade 0018 -> 0017, Gastos, obligaciones agendadas ...
INFO  [alembic.runtime.migration] Running downgrade 0017 -> 0016, `banking`: ...
(sin errores — downgrade simétrico completo, incluido el drop de columnas sin FK que recrear en SQLite)

$ DATABASE_URL="sqlite:////tmp/pt-backend-obligaciones/chain_verify.db" python -m alembic upgrade head
(vuelve a 0020 sin errores — round-trip completo)
```

Cadena completa **en Postgres** (cluster local `postgresql/16`, arrancado para esta
verificación; base `chain_verify_t2`, creada limpia y borrada al terminar):

```
$ sudo -u postgres psql -c "CREATE DATABASE chain_verify_t2;"
CREATE DATABASE

$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chain_verify_t2" python -m alembic upgrade head
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade 0016 -> 0017, `banking`: ...
INFO  [alembic.runtime.migration] Running upgrade 0017 -> 0018, Gastos, obligaciones agendadas ...
INFO  [alembic.runtime.migration] Running upgrade 0018 -> 0019, D-2 (...) ...
INFO  [alembic.runtime.migration] Running upgrade 0019 -> 0020, Jornada, ...
(sin errores — 0001 a 0020 de punta a punta en Postgres real)

$ sudo -u postgres psql -d chain_verify_t2 -c "\d payables" | grep -A3 "Foreign-key"
Foreign-key constraints:
    "fk_payables_discrepancy_confirmed_by_employee_id" FOREIGN KEY (discrepancy_confirmed_by_employee_id) REFERENCES employees(id)
    "payables_approved_by_employee_id_fkey" FOREIGN KEY (approved_by_employee_id) REFERENCES employees(id)
    "payables_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id)
# ↑ confirma que en Postgres la FK real SÍ se creó (a diferencia de SQLite, guard correcto)

$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chain_verify_t2" python -m alembic heads
0020 (head)

$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chain_verify_t2" python -m alembic downgrade 0016
INFO  [alembic.runtime.migration] Running downgrade 0020 -> 0019, Jornada, ...
INFO  [alembic.runtime.migration] Running downgrade 0019 -> 0018, D-2 (...) ...
INFO  [alembic.runtime.migration] Running downgrade 0018 -> 0017, Gastos, obligaciones agendadas ...
INFO  [alembic.runtime.migration] Running downgrade 0017 -> 0016, `banking`: ...
(sin errores — downgrade simétrico completo en Postgres, incluido el drop_constraint de
 la FK real antes del drop_column)

$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chain_verify_t2" python -m alembic upgrade head
(vuelve a 0020 sin errores)
$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chain_verify_t2" python -m alembic heads
0020 (head)

$ sudo -u postgres psql -c "DROP DATABASE chain_verify_t2;"
DROP DATABASE
```

**Resultado**: la cadena `0016 → 0017 → 0018 → 0019 → 0020` corre completa, en las dos
direcciones, en **los dos motores** (SQLite y Postgres real, no sólo por inspección), y
termina siempre en una sola cabeza (`0020`). Nada quedó sin probar de lo que pidió el
ajuste — el punto 4 del ajuste ("si no tenés Postgres, declaralo") no aplica: sí lo tuve
disponible (`pg_ctlcluster`/`psql` en el entorno) y corrí la cadena completa ahí también.

---

## 8. Qué NO toqué

`app/main.py`, `app/core/models_registry.py`, `app/core/features.py`, los `__init__.py`
de los cuatro paquetes nuevos, `app/reports/**`, `app/shifts/**`, `app/inventory/**`,
`app/channels/**`, `app/stores/**`, `app/banking/**`, `app/payroll/**`, `app/analytics/**`,
y de `app/purchases/` **todo excepto** las cuatro cosas que D-2 enumera. Tampoco toqué
ningún archivo de `tests/` fuera de `tests/expenses/**` y `tests/audit/test_expenses_invariants.py`
(nuevo), ni `tests/audit/conftest.py` (fixtures compartidas, sólo las leo/importo).

---

## 9. Comandos de verificación corridos y su resultado literal

**Ronda anterior** (sin cambios de código en `app/`, se mantiene como registro):

```
$ cd backend && TMPDIR=/tmp/pt-backend-obligaciones python -m pytest tests/expenses tests/audit/test_expenses_invariants.py -q
.....................................................                    [100%]
53 passed, 107 warnings in 146.24s (0:02:26)
```

(La primera corrida encontró 6 fallos + 1 error de fixture, todos en el arnés de los
tests, no en el código de producción: `sell()` no preguntaba la propina —`TIP_NOT_ASKED`—,
dos tests fijaban una fecha ya pasada para "no vencida" en vez de usar una fecha lejana o
el reloj mockeado, dos tests de utilidad asumían `payroll` apagada sin apagarla
explícitamente —el perfil `full` la trae encendida por default—, y el test de auditoría
de D-2 pedía `make_ingredient`/`make_supplier` como fixtures en vez de importarlas como
funciones de `tests/audit/conftest.py`. Los cinco se corrigieron en los tests; ningún
archivo de `app/` cambió por esto.)

```
$ cd backend && python -m mypy app
app/banking/service.py:480: error: Argument 1 to "int" has incompatible type "int | None"; expected "str | Buffer | SupportsInt | SupportsIndex | SupportsTrunc"  [arg-type]
Found 1 error in 1 file (checked 137 source files)
```

**Iteración 2** (después del fix de §7-bis sobre `0019_invoice_total.py`, único cambio de
código de esta ronda), re-corrido completo:

```
$ cd backend && rm -rf /tmp/pt-backend-obligaciones && TMPDIR=/tmp/pt-backend-obligaciones python -m pytest tests/expenses tests/audit/test_expenses_invariants.py -q
.....................................................                    [100%]
53 passed, 107 warnings in 145.39s (0:02:25)
```

Los 53 tests siguen en verde sin ningún ajuste adicional (el fix fue puramente de
migración, no tocó `app/expenses/**` ni el resto de D-2).

```
$ cd backend && python -m mypy app
Success: no issues found in 147 source files
```

**El error de `app/banking/service.py:480` que reporté la ronda anterior ya no aparece**
— su dueño (T1 `backend-banco`) lo resolvió por su cuenta entre rondas. `mypy app` da
limpio en todo el árbol (147 archivos, 10 más que la corrida anterior por los paquetes
`payroll`/`analytics` ya materializados). Cero errores en `app/expenses/**` y en los
cuatro archivos de la excepción D-2 sobre `app/purchases/`.

La verificación de la cadena de Alembic de punta a punta (SQLite y Postgres, upgrade +
downgrade + heads) está en **§7-bis**, con la salida literal completa.

Temporales de test en `TMPDIR=/tmp/pt-backend-obligaciones` (propio, para no pisar el de
otro agente). No corrí la suite completa (`pytest -q` sin acotar): eso sigue siendo del
paso de verificación del orquestador, en serie, al final. La cadena de Alembic sí la
corrí esta vez de punta a punta (SQLite y Postgres) porque era exactamente lo que pedía
el ajuste — no una corrida general de la suite.

---

## 10. Gaps

1. **D-1 (`_variance_level`/"sostenido")**: no aplica a mi territorio (T4). No lo toqué.
2. **D-3 (reparto de propinas)**: no aplica a mi territorio (T3). No lo toqué.
3. **D-4 (supresión habeas data en `pending_refunds`)**: territorio de T1, no lo toqué.
4. **Nómina (`app.payroll.hooks.period_payroll_cost`)**: al cerrar este entregable,
   `app/payroll/` no existía todavía en el árbol. Dejé la costura declarada (§5) con la
   firma exacta que espero; si T3 publicó algo con otro nombre, hay que reconciliar —
   nunca calculando una nómina propia en `app/expenses/`.
5. **`app/banking/service.py:480`**: reportado en la ronda anterior como único error de
   `mypy app`, fuera de mi territorio. **Resuelto**: en la re-corrida de la iteración 2
   (§9) `mypy app` ya no lo reporta — T1 lo corrigió por su cuenta. Sin acción de mi
   parte; queda este punto como registro, no como gap abierto.
6. **"Validar la dependencia de la función antes del gate de sede"**: `money.obligations`
   no declara `requires` en `app/core/features.py` (no lo toqué; ya estaba así). No hay
   nada que testear ahí específico de mi dominio más allá del test genérico de
   `FEATURE_DISABLED` que ya escribí.
7. **`GET /admin/expenses`/`GET /admin/obligations` sin `from`/`to`**: los dejé
   OPCIONALES (igual que `GET /admin/payables` de `purchases`), no obligatorios como
   `break-even`/`profit`. Si el frontend necesita que sean obligatorios para alguna
   pantalla, es un ajuste de contrato menor a declarar por separado.
8. **Prorrateo del costo teórico por sub-cuenta** (la aproximación ya declarada por
   `app/reports/service.py` para comandas divididas por ítems) se hereda tal cual en
   `compute_profit`/`_contribution_margin_pct_bp`, porque llamo a esa misma agregación —
   no es un gap nuevo de este territorio, es el mismo gap ya declarado por `reports`,
   propagado.
9. **Autorización de `settle`/`void`/`cancel`**: decidí que estas tres rutas sólo exigen
   `current_admin` (ya autenticado), sin un PIN de autorizador adicional (a diferencia de
   `purchases.approve_payable`/`create_payment`, que sí lo piden). Razón: son pantallas
   exclusivamente de administrador (no hay un cajero pidiéndole el PIN a un supervisor
   desde el POS), así que un segundo PIN sería teatro. Si el Contador/Legal prefieren
   exigirlo, es un ajuste menor y localizado en `service.py`.
10. **(Iteración 2)** El fix de §7-bis (FK guardada por dialecto en `0019`) usó un
    cluster Postgres 16 local del propio entorno de ejecución (`pg_ctlcluster`, package
    del sistema, no un servicio externo) para la verificación de punta a punta — no es
    necesariamente el mismo Postgres que usa el CI/producción del proyecto, aunque sí es
    la misma versión mayor (16) y el mismo dialecto (`postgresql+psycopg2`). Si el CI usa
    una versión de Postgres distinta o extensiones específicas, vale la pena que el
    orquestador confirme la cadena una vez más ahí; lo que sí quedó probado acá es que el
    defecto (FK inline en `ADD COLUMN`) está genuinamente resuelto por el guard de
    dialecto, no sólo "no falla en SQLite".
