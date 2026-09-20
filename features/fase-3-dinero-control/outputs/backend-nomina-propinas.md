# backend-nomina-propinas (T3) — jornada, recargos con vigencia, nómina y reparto de propinas

Territorio T3 de `features/fase-3-dinero-control/spec.md § 2`. Construye `app/payroll/`
(dominio nuevo), la única excepción autorizada en `app/core/` de esta fase
(`app/core/hours.py`), y su migración `0020_payroll.py`. No toca `app/shifts/`, ni
ningún otro archivo fuera de su territorio.

## 0. Iteración 2 (C2/H-2) — el cambio quirúrgico de esta ronda

`GET /admin/tips/distribution/proposal` exigía `shift_id` (`Query(...)`,
obligatorio) y la pantalla (`frontend/src/api/payroll.ts::getTipsDistributionProposal`)
manda `{store_id, from, to}`, sin `shift_id`: toda carga de la pantalla de propinas
devolvía `422`. Decisión del Maestro: se mueve el backend, no la pantalla (spec §2
fija `from`/`to` como la forma del período de la fase; T5 tiene instrucción de NO
tocar el cliente).

**Un solo cambio, quirúrgico** — nada más de este territorio se tocó:

- `router.get_tip_proposal`: la firma pasa a `store_id: int`, `date_from: date =
  Query(..., alias="from")`, `date_to: date = Query(..., alias="to")`, `method: str
  | None = None`, con el mismo patrón de alias que
  `app.analytics.router.get_menu_engineering`. `shift_id: list[int] | None =
  Query(default=None, alias="shift_id")` queda como **override opcional** para el
  detalle de un turno puntual — cuando viene, se usa tal cual (igual que antes);
  cuando no viene, `from`/`to` solos alcanzan.
- `service.resolve_period_shift_ids(db, *, store, date_from, date_to) -> list[int]`
  (función nueva): turnos **CERRADOS** de la sede cuya `BusinessDay` cae en
  `[date_from, date_to]` — mismo patrón de join que
  `app.banking.service.pending_deposits` (`Shift` × `BusinessDay` por
  `business_day_id`), orden determinístico. Fecha de NEGOCIO, nunca timestamp UTC
  ni `date.today()`; un turno que cruza medianoche ya quedó partido en dos
  `BusinessDay` por `app.shifts.service`, así que este join no necesita saberlo.
- `service.get_tip_proposal_for_period(...)` (función nueva): resuelve el override
  o `resolve_period_shift_ids`, y si no hay ningún turno cerrado en el rango
  devuelve `available=False` con `reason="No hay turnos cerrados en ese rango para
  esta sede."` (nunca `422`, nunca `rows: []` con `available=True` — la regla de
  null-con-motivo de la fase). Si hay turnos, delega **TODO** el cálculo a
  `compute_tip_proposal` — la única matemática de D-3, sin tocar; no hay una
  segunda lectura de propinas ni un segundo reparto. Devuelve
  `(shift_ids_usados, TipProposalResult)`: el router nombra esos `shift_ids` en la
  respuesta (`TipProposalOut.shift_ids`), porque el cliente los reusa para el
  "confirmar" (`POST /admin/tips/payouts`, ya existente, no tocado).
- `router.py` sigue siendo sólo borde HTTP: la resolución y la rama "sin turnos"
  viven en `service.py`.

**No se tocó**: el gate (`pos.tips`, mismo orden `require_feature` antes de
`admin_store`), la matemática de reparto de los tres métodos, ni el test de "la
propuesta nunca escribe" (`test_proposal_never_writes_anything`, intacto).

Detalle completo abajo (§ 3 rutas, § 5 D-3, § 9 verificación, § 10 gaps —
actualizados con este ajuste).

## 1. La llave anti doble conteo — propina vs venta

El monto a repartir de un turno sale **siempre** de
`app.shifts.tips.get_shift_tips(db, shift=shift)`: la única función que ya separa la
propina de la venta y del impuesto (Ley 1935 de 2018) y que ya resolvió H-2/H-8
(propina de mostrador vs propina de domicilio, liquidada o no). `app/payroll/`
**nunca** vuelve a sumar `Payment.tip_amount` ni `Payment.amount` por su cuenta —
hacerlo sería la "segunda matemática" que `docs/CONTEXTO-AGENTES.md §8` prohíbe, y
el mismo billete podría aparecer una vez como propina a repartir y otra vez como
venta del turno.

`service._shift_tip_total` es el **único** punto donde esta regla se aplica:

```python
total += (
    shift_tips.by_method.cash
    + shift_tips.by_method.card
    + shift_tips.by_method.transfer
    + shift_tips.by_method.other
    + shift_tips.delivery_tips
)
```

`delivery_tips` entra COMPLETA (liquidada o no): la Ley 1935 la debe 100 % a quien
la generó desde que se cobra, no desde que el domiciliario la entrega — a
diferencia de `cash_out` (que sólo autoriza sacar del cajón la propina de domicilio
YA liquidada), acá la pregunta es "cuánta propina generó el turno", no "cuánta
plata hay físicamente en el cajón hoy".

Probado explícitamente en `tests/payroll/test_tip_distribution.py` (los tres
métodos sobre un turno con una propina real cobrada vía `POST
/orders/{id}/payments`, no simulada) y en `test_proposal_never_writes_anything`
(cuenta `TipPayout`/`TipPayoutDistribution` antes y después de la propuesta: no
cambia).

## 2. Qué se construyó — modelo de datos

`app/payroll/models.py`:

| Tabla | Qué es |
|---|---|
| `SurchargeTable` (`payroll_surcharge_tables`) | Tabla legal de recargos, versionada: ventana nocturna, recargo nocturno, recargo dominical/festivo, recargo de hora extra, jornada ordinaria semanal. Rige la de mayor `valid_from <=` la fecha consultada — mismo patrón de `StoreFiscalConfig`. |
| `PayrollHoliday` (`payroll_holidays`) | Festivos declarados por la sede (fecha + nombre). Sin vigencia: una fecha es un hecho. |
| `PayrollWageRate` (`payroll_wage_rates`) | Tarifa por hora de una persona, CON vigencia (mismo patrón). `app.auth.models.Employee` no tiene este campo y no es territorio de este pedido tocarlo — la tarifa vive acá. |
| `PayrollAreaAssignment` (`payroll_area_assignments`) | Área de una persona (para `by_area`), sin vigencia — última gana, con auditoría del cambio. |
| `TipDistributionSettings` (`payroll_tip_distribution_settings`) | `tip_distribution_method` de D-3, por sede — vive acá, no en `app.stores.models` (§3 de la spec del pedido). |
| `PayrollRun` / `PayrollRunLine` (`payroll_runs` / `payroll_run_lines`) | Liquidación del período: un documento cerrado (como una recepción o un cierre de turno), con snapshot de qué tabla(s) de recargos usó (`tables_used`) y una línea por persona. Nunca se pisa: una corrección es una liquidación nueva. |

### La escala entera de las horas — `app/core/hours.py`

```python
HOURS_SCALE = 60   # jornada: entero en MINUTOS (60 minutos = 1 hora)
```

Elegido minutos (no décimas/centésimas de hora en base 10) porque el dato de
origen (`ShiftRoster.in_at`/`.out_at`/`.pauses`) son instantes reales de reloj de
pared, y el minuto es la unidad en la que dos instantes se restan sin perder nada
ni inventar redondeo — la misma granularidad que cualquier planilla de nómina
colombiana ya usa. Toda la matemática de jornada y de recargos se acumula en
minutos enteros (o en "peso-minutos" enteros — `wage_minutes`/`minutes_pay_to_pesos`,
el mismo patrón "acumular fino, redondear una sola vez al borde" que
`app.core.quantity.line_cost_micros`/`micros_to_pesos` ya usa para costos) hasta
que cierra un total. `format_hours(minutes) -> str` es la única función que
convierte a texto decimal, y es sólo para publicar/mostrar — nunca se vuelve a leer
ese texto para seguir calculando.

Ningún `float` en ninguna capa, en ningún cálculo: verificado por construcción (la
matemática de plata usa sólo enteros — `wage_minutes`, `_round_half_up`,
`minutes_pay_to_pesos`) y por los tests de `test_runs.py`, que verifican los pesos
exactos de una liquidación a mano contra la fórmula (`base_pay == 20_000`,
`sunday_holiday_surcharge == 15_000`, etc., sin ningún margen de redondeo).

### El motor de jornada (`service._employee_pieces`)

Parte cada intervalo trabajado del roster (`in_at`/`out_at`, restando `pauses`) en
piezas que no cruzan ni la hora de corte de la sede (día de NEGOCIO, para filtrar
por período) ni la medianoche (día CALENDARIO, que es el que manda para
domingo/festivo/ventana nocturna) ni el borde de la ventana nocturna vigente en
cada fecha. Es la generalización explícita de "los turnos que cruzan medianoche se
parten en dos días de negocio" (`_split_by_hour_boundaries`, con
`hour_marks = {0, cutoff_hour, night_start_hour, night_end_hour}`).

Cinco categorías publicadas por `GET /admin/payroll/hours`, **no mutuamente
excluyentes entre sí** (una hora nocturna de domingo es nocturna Y dominical a la
vez, para efectos de recargo):

- `ordinary_minutes` / `overtime_minutes`: mutuamente excluyentes entre sí —
  jornada ordinaria semanal vigente (`SurchargeTable.weekly_ordinary_hours`), por
  semana ISO, cronológico: las primeras horas de la semana son ordinarias, el
  resto es extra.
- `night_minutes`: subconjunto de minutos dentro de la ventana nocturna vigente en
  su fecha.
- `sunday_minutes` / `holiday_minutes`: mutuamente excluyentes entre sí (festivo
  gana si coinciden) — subconjunto por fecha calendario.

## 3. Rutas publicadas

Del contrato mínimo (`features/fase-3-dinero-control/spec.md § 2`, tabla T3), las
seis exactas:

| Ruta | Flag |
|---|---|
| `GET /admin/payroll/hours` | `payroll` |
| `GET`/`POST /admin/payroll/surcharge-tables` | `payroll` |
| `GET /admin/payroll/runs` · `POST /admin/payroll/runs` | `payroll` |
| `GET /admin/tips/distribution/proposal` | `pos.tips` |
| `GET`/`PATCH /admin/tips/settings` | `pos.tips` |

**`GET /admin/tips/distribution/proposal`, forma exacta de sus parámetros
(iteración 2, C2/H-2 — ver § 0)**: `store_id: int`, `from`/`to: date` (alias,
FECHA DE NEGOCIO, obligatorios), `method: str | None` opcional, y `shift_id:
list[int] | None` como **override opcional** para el detalle de un turno
puntual (si viene, manda; si no, `from`/`to` resuelven los turnos CERRADOS del
rango). La respuesta siempre nombra `shift_ids` — los que resolvió, o los del
override.

`POST /admin/tips/payouts` **no se tocó ni se duplicó** — sigue siendo de
`app.shifts.router`, tal cual publicado desde 1b-2.

**Agregadas, fuera del contrato** (necesarias porque la ley da los RECARGOS, no la
TARIFA por hora de cada persona ni su ÁREA, y `app.auth.models.Employee` no tiene
esos campos — no es territorio de este pedido tocarlo):

| Ruta | Por qué hace falta |
|---|---|
| `GET /admin/payroll/runs/{run_id}` | Detalle con líneas de una liquidación puntual (el listado es sólo resumen). |
| `GET`/`POST /admin/payroll/holidays` | Festivos declarados por la sede — sin esto, "festivas" del contrato no tiene de dónde salir (no hay librería de calendario colombiano en el proyecto, y calcularlo mal sería peor que pedirlo). |
| `GET`/`POST /admin/payroll/wages` | Tarifa por hora, CON vigencia — sin esto, ninguna liquidación puede convertir horas en pesos. |
| `GET`/`POST /admin/payroll/areas` | Área de cada persona — sin esto, el método `by_area` de D-3 no tiene con qué agrupar. |

Todas bajo `/admin/payroll/**`, gateadas por `payroll` (las de tarifa/área/festivos
son configuración de ESTE dominio, no una capacidad aparte).

## 4. El hook para `app/expenses/`

`app/payroll/hooks.py::period_payroll_cost` — firma exacta, la que
`app/expenses/service.py::_period_payroll_cost` ya declaró como contrato **antes**
de que este dominio existiera:

```python
def period_payroll_cost(db: Session, *, store_id: int, date_from: date, date_to: date) -> int | None:
```

Pesos enteros del período, o `None` si no hay datos suficientes (sin tabla de
recargos configurada, o alguna persona sin tarifa por hora para el período — T2 no
inventa un `0` mudo en la utilidad por una nómina a medio configurar). Internamente
llama **exactamente** a la misma función que usa `service.create_run`
(`service._compute_employee_pay`, sobre las mismas piezas de
`service._employee_pieces`) — nunca reimplementa el cálculo: el número que ve `GET
/admin/profit` y el que produciría `POST /admin/payroll/runs` para el mismo período
**siempre coinciden**. No lee `PayrollRun`/`PayrollRunLine` ya guardadas a
propósito: la utilidad del período no depende de que alguien haya apretado
"liquidar" antes.

## 5. D-3 — los tres métodos, y la prueba de que la propuesta no mueve plata

Configurables por sede en `TipDistributionSettings.method`
(`equal_shares` | `by_hours` | `by_area`), default `by_hours` si nunca se
configuró (`service.get_tip_settings` devuelve el default sin necesitar fila
creada de antemano). `POST /admin/tips/payouts` sigue siendo la única puerta de
escritura del reparto; `GET /admin/tips/distribution/proposal` es una función
pura de lectura — no hay un solo `db.add`/`db.flush` en todo
`service.compute_tip_proposal` ni en las funciones que llama.

- **`by_hours`** (default): minutos trabajados de cada persona en los
  `shift_ids` pedidos (roster, sin cutoff-splitting — no hace falta partir por
  día de negocio para un peso relativo dentro del mismo turno), repartidos con
  `app.orders.money.prorate` (la función de prorrateo exacto que ya existe,
  reusada — `docs/CONTEXTO-AGENTES.md §8` pide exactamente esto).
- **`equal_shares`**: `prorate(total, [1]*N)` entre quienes tienen una entrada de
  roster en esos turnos.
- **`by_area`**: el total se reparte en partes iguales entre las ÁREAS presentes
  (quien no tiene área asignada cae en "sin área", así nadie queda afuera del
  reparto por falta de configuración) y, dentro de cada área, en partes iguales
  entre sus personas. **Supuesto declarado**: la spec no fija el sub-algoritmo de
  `by_area` más allá de nombrarlo; ésta es una elección razonable, no una cita.

**Prueba de que nunca mueve plata**:
`tests/payroll/test_tip_distribution.py::test_proposal_never_writes_anything`
cuenta `TipPayout`/`TipPayoutDistribution` (las tablas de 1b-2, las únicas donde
un reparto CONFIRMADO deja rastro) antes y después de pedir la propuesta, y
verifica que no cambian. Los tres métodos están probados con un turno con
propina real (`_pay_with_tip`, por HTTP, no simulada) en
`test_by_hours_is_the_default_and_splits_proportionally`, `test_equal_shares` y
`test_by_area`.

**Iteración 2 (C2/H-2) — dos tests nuevos, la puerta que la pantalla usa
realmente**:

- `test_proposal_by_period_matches_proposal_by_shift_id`: pega a la ruta con
  `{store_id, from, to}` **y nada más** (sin `shift_id` — exactamente lo que
  manda `frontend/src/api/payroll.ts`), sobre un turno **cerrado** por la puerta
  real (los tres pasos a ciegas), y verifica que obtiene el mismo reparto
  (`by_hours`, los mismos montos) que pedirlo con `shift_id` explícito. Es el
  test que no existía y por eso nadie vio el `422` (ninguna de las dos mitades
  lo veía: cada una probaba sus propios parámetros).
- `test_proposal_empty_range_is_available_false_with_reason`: rango sin ningún
  turno cerrado -> `200` con `available: false`, `reason` no vacío, `rows: []`,
  `shift_ids: []` — nunca `422`, nunca `available: true` con `rows` vacías (que
  en pantalla se leería como "no hubo propina" en vez de "no hay con qué
  calcular").

**Nota sobre los números de esos tests**: `open_shift()` (fixture compartida)
agrega sola a la cajera (responsable de caja) al roster del turno
(`app.shifts.service.open_shift` -> `hooks.on_employee_identified`), y no hay
forma de sacarla por acá (el responsable de caja "no sale por acá",
`NOT_CASH_RESPONSIBLE`) — así que es una TERCERA persona legítima del reparto en
esos tests, y las cifras esperadas la incluyen explícitamente (documentado en
cada test).

## 6. Vigencia de las tablas legales, y el test que recalcula un período viejo

`SurchargeTable` es una FOTO completa por vigencia (no un delta por campo) — igual
que `StoreFiscalConfig`. `service._table_for` resuelve, para una fecha CALENDARIO
dada, la de mayor `valid_from <=` esa fecha. La resolución es **por pieza de
jornada**, usando su propia fecha calendario — nunca "la de hoy" — así que una
liquidación de un período viejo usa automáticamente la tabla que regía en su época,
incluso si hoy ya existe una vigencia más nueva en la base.

`POST /admin/payroll/runs` congela, en `PayrollRun.tables_used`, cada tabla
efectivamente usada (snapshot completo, no sólo el id) — la respuesta **nombra
qué tabla vigente usó**, y si el período cruza un cambio de vigencia, nombra las
dos.

**El test explícito**
(`tests/payroll/test_runs.py::test_run_uses_the_vigente_table_of_its_own_period`):
siembra una vigencia "vieja" (`valid_from=2024-01-01`, recargo dominical 75 %) y
una "nueva" (`valid_from=2026-07-01`, recargo dominical 90 %, jornada 42h) — LAS
DOS ya en la base — y liquida un domingo de 2025 (posterior a la vieja, anterior a
la nueva). Verifica que `tables_used == [{"valid_from": "2024-01-01", ...}]` (la
nueva NO aparece) y que el recargo dominical de la línea se calculó con 75 %, no
con 90 % (`sunday_holiday_surcharge == 15_000`, pesos exactos, no una tolerancia).

**Migración con backfill** (`0020_payroll.py`, `docs/CONTEXTO-AGENTES.md §12`):
siembra, por cada sede que ya existe, seis vigencias que reconstruyen los tres
cambios legales que la spec cita explícitamente: ventana nocturna 19:00-06:00
desde dic-2025, recargo dominical/festivo 80/90/100 % en 2025/2026/2027 (Ley 2466
de 2025), jornada ordinaria semanal 42h desde jul-2026 (Ley 2101 de 2021) — más
una vigencia "desde siempre" con los valores previos. **Los valores previos a esos
tres puntos de cambio (ventana 21:00-06:00, recargo dominical 75 %, jornada 46h) y
el recargo nocturno (35 %)/de hora extra (25 %), que la spec no cita con fecha de
cambio, son un SUPUESTO razonable, declarado en el docstring de la migración y acá
— ver `gaps`.**

## 7. Migración

`backend/alembic/versions/0020_payroll.py`, `revision = "0020"`,
`down_revision = "0019"` — exactos, como fija §2 de la spec del pedido. DDL a mano
(Postgres-first, sin `batch_alter_table`: siete tablas nuevas, ninguna columna
existente que tocar). `downgrade()` simétrico (`DROP TABLE` en orden inverso de
FKs).

**Verificado en aislamiento** (ver § 9): `upgrade()`/`downgrade()` corren limpio
sobre una base SQLite construida hasta el estado equivalente a `0019`, incluido el
backfill de las seis vigencias por sede. **No pude verificar la cadena completa
`0016 -> ... -> 0020` con `alembic upgrade head`** porque `0019_invoice_total.py`
(T2, `backend-obligaciones`) falla en SQLite con
`NotImplementedError: No support for ALTER of constraints in SQLite dialect` al
agregar una columna con FK vía `add_column` — un bug pre-existente de esa
migración, no de la mía, y no es mi territorio corregirlo. Declarado en `gaps`.

## 8. Qué NO se tocó

`app/shifts/**` (ni `tips.py` ni `models.py` ni `service.py`) — se **leyó**
`get_shift_tips`, `Shift`, `ShiftRoster`; nunca se escribió ni se llamó a
`register_tip_payout`. `app/stores/**`, `app/reports/**`, `app/inventory/**`,
`app/main.py`, `app/core/models_registry.py`, `app/core/features.py`, ningún
archivo EXISTENTE de `app/core/` (sólo se agregó el archivo nuevo
`app/core/hours.py`), los `__init__.py` de los cuatro paquetes nuevos de la fase.
Ningún archivo de `app/banking/`, `app/expenses/` ni `app/analytics/` (los
territorios de T1, T2 y T4).

## 9. Verificación corrida

**Iteración 2 (C2/H-2), tras el ajuste** — repetida al final de esta ronda:

```
$ cd backend && TMPDIR=/tmp/pt-backend-nomina python -m pytest tests/payroll tests/audit/test_payroll_invariants.py -q
..................................                                      [100%]
34 passed, 69 warnings in 107.81s (0:01:47)

$ cd backend && TMPDIR=/tmp/pt-backend-nomina python -m mypy app
Success: no issues found in 147 source files
```

34 tests (32 de la ronda anterior + los 2 nuevos de § 5: `..._matches_by_shift_id`
y `..._empty_range_...`), todos verdes; `mypy` limpio. (Una corrida intermedia de
`mypy app` en esta misma ronda, mientras T4 todavía tenía un cambio a medio
guardar en `app/analytics/service.py:688`, mostró un error transitorio ajeno a
este territorio — no volvió a aparecer en la corrida final de arriba, que es la
que cuenta; verificado además, en ese momento, que **cero** errores caían en
`app/payroll/**` ni en `app/core/hours.py` con
`mypy app 2>&1 | grep -i "payroll\|core/hours"` -> sin salida.)

(Los *warnings* son `InsecureKeyLengthWarning` de PyJWT sobre la clave HMAC de
prueba del proyecto — preexistentes, no de este territorio.)

**Resultado previo (antes del ajuste de iteración 2), para referencia**:

```
$ cd backend && python -m mypy app
Success: no issues found in 143 source files

$ cd backend && TMPDIR=/tmp/pt-backend-nomina python -m pytest tests/payroll tests/audit/test_payroll_invariants.py -q
................................                                         [100%]
32 passed, 65 warnings in 100.86s (0:01:40)
```

**Migración, en aislamiento** (script ad hoc, no parte de la suite): sobre una
base SQLite con todas las tablas EXCEPTO `payroll_*` creadas vía
`Base.metadata.create_all` (equivalente al estado post-`0019`) más una
organización y una sede de prueba, se invocó `0020_payroll.upgrade()` a través de
`alembic.operations.Operations`/`MigrationContext` directamente (sin pasar por
`alembic upgrade head`, bloqueado por el bug de `0019` descrito en § 7 y en
`gaps`):

```
('2020-01-01', 21, 6, 7500, 46)
('2025-01-01', 21, 6, 8000, 46)
('2025-12-01', 19, 6, 8000, 46)
('2026-01-01', 19, 6, 9000, 46)
('2026-07-01', 19, 6, 9000, 42)
('2027-01-01', 19, 6, 10000, 42)
total surcharge rows: 6
downgrade OK
```

**No corrí** `pytest -q` (suite completa) ni `npm run build`/`npm run test`: son
del paso de verificación final del orquestador.

## 10. Gaps

1. **`alembic upgrade head` no se pudo verificar de punta a punta.**
   `0019_invoice_total.py` (T2) falla en SQLite (`NotImplementedError` de Alembic
   al agregar una columna con FK vía `ALTER`, fuera de `batch_alter_table`) —
   bloquea la cadena antes de llegar a `0020`. No es mi migración ni mi
   territorio corregirlo; verifiqué `0020` en aislamiento (§ 9) pero el
   orquestador tiene que confirmar la cadena completa en Postgres (donde este
   patrón de `ADD COLUMN ... REFERENCES` sí es válido — el problema parece ser
   específico del dialecto SQLite de Alembic, no necesariamente de Postgres, pero
   no lo pude confirmar sin un Postgres disponible en este entorno).

2. **Los valores legales previos a los tres cambios que la spec cita
   explícitamente (ventana nocturna antes de dic-2025, recargo dominical antes de
   2025, jornada antes de jul-2026) y el recargo nocturno (35 %)/de hora extra
   (25 %), que la spec no cita con ninguna fecha de cambio, son un SUPUESTO mío,
   no una cita textual** — declarados en el docstring de `0020_payroll.py` y en
   § 6. El Contador/Legal del equipo debería confirmarlos o corregirlos con la
   norma exacta antes de ir a producción; mientras tanto son totalmente
   editables vía `POST /admin/payroll/surcharge-tables` (una fila por vigencia,
   sin tocar código).

3. **Simplificación de recargos combinados**: este dominio no implementa la
   taxonomía completa colombiana de horas extra (HED/HEN/HEDD/HEND, ocho
   categorías con multiplicadores distintos combinando nocturno+dominical+extra).
   En cambio, cada minuto trabajado paga la tarifa base (`base_pay`), más
   recargos ADITIVOS independientes por cada condición especial que aplique
   (nocturno, dominical/festivo, extra) — un minuto que es nocturno Y extra a la
   vez suma los dos recargos sobre la base, en vez de multiplicar la tarifa de
   hora extra por el recargo nocturno como haría la fórmula legal exacta. Es una
   aproximación razonable y transparente (cada recargo se puede auditar por
   separado), pero no es la fórmula CST completa. Declarado en el docstring de
   `SurchargeTable` y acá; si hace falta la fórmula exacta, es trabajo de una
   fase siguiente con el Contador involucrado.

4. **El umbral de horas extra semanales se mide sólo con las horas DENTRO del
   período consultado**, no con la semana ISO completa si el período empieza o
   termina a mitad de semana. Un período alineado a semanas completas (lo
   habitual para liquidar) no lo sufre; uno que corta una semana al medio puede
   subestimar o sobrestimar levemente las horas extra de los bordes. Declarado en
   el docstring de `service._split_ordinary_overtime`.

5. **No hay vista para que un operador consulte SUS PROPIAS horas o su propio
   reparto de propinas** — el contrato de esta fase sólo pide rutas de
   administrador (`/admin/payroll/**`, `/admin/tips/**`), y así quedó
   construido: un operador no tiene, hoy, ninguna pantalla propia de nómina. Si
   el negocio quiere que cada persona vea su propio recibo, es una capacidad
   nueva (rutas `current_operator`, fuera de este pedido) para una fase
   siguiente.

6. **`app/auth/models.Employee` no tiene un campo de tarifa por hora ni de
   área** — ninguno de los dos es territorio de este pedido tocar, así que viven
   en tablas propias de `app/payroll/` (`PayrollWageRate`, `PayrollAreaAssignment`)
   con `employee_id` como FK real + `employee_name` congelado, como manda
   `AGENTS.md`. Si en una fase futura esos campos migran a `Employee`, hay que
   decidir la migración de datos entre los dos lugares; no se intentó acá.

7. **D-1, D-2 y D-4 no son territorio de T3** y no se tocaron. D-3 se construyó
   tal cual está escrita en `features/fase-3-dinero-control/spec.md § 1`; no
   generó ninguna objeción de este agente.

8. **(Iteración 2, C2/H-2) `backend/tests/audit/test_contract_fase3_invariants.py::
   test_d3_the_proposal_is_a_proposal_and_writes_absolutely_nothing` (línea ~1652)
   pega a `GET /admin/tips/distribution/proposal` con `{"store_id": ...,
   "shift_id": turno["id"]}`, sin `from`/`to`.** Con la firma nueva (`from`/`to`
   obligatorios; § 0 de este documento), esa llamada va a devolver `422` en vez
   de `200`, y ese test va a fallar. **No lo edité**: es
   `backend/tests/audit/*`, territorio del auditor, y la instrucción de esta
   ronda fue explícita en no tocarlo. La otra prueba de ese mismo archivo que sí
   importa para este ajuste —`test_an_operator_device_cannot_reach_any_new_admin_route`
   (CRUCE 6, parametrizada, ya manda `{store_id, from, to}` para TODAS las rutas
   de la fase, sin `shift_id`)— sigue en verde sin cambios: la valida un `401`
   de `current_admin` que corta la ejecución ANTES de que FastAPI llegue a
   validar los query params (el orden real de resolución de dependencias), así
   que es indiferente a si `from`/`to` son requeridos o no. Declarado para que
   el auditor actualice esa única línea (`shift_id` -> agregar `from`/`to`, o
   sacar `shift_id` y dejar que la resuelva el período) en su propia pasada.
