# backend-reportes — Entrega (pedido 1b-2)

Territorio: `backend/app/reports/**` (dominio nuevo), `backend/app/orders/**`,
`backend/app/kitchen/**` (sin cambios: no hizo falta tocar nada ahí),
`backend/app/core/tax.py` (nuevo), `backend/app/main.py` y
`backend/app/core/models_registry.py` (dueño único), `backend/tests/
{reports,orders,kitchen}/**`.

## 0. Resumen en una línea

Los cinco reportes del admin (`GET /admin/today`, `/admin/sales`,
`/admin/accountant-report`, `/admin/orders` ampliado, `/admin/unavailable-log`)
leen exclusivamente snapshots (`FiscalDocument`, `OrderItem`, `Payment` vía
`payments_snapshot`), nunca la carta actual ni una segunda matemática de la
venta; `app/core/tax.py` centraliza la tabla de tarifas que 1b-1 había dejado
duplicada; A-12 quedó corregido en `app/orders/money.py` con un test de
propiedad de 2.000 casos; y los tiempos de cocina p50/p90 **sí sobreviven a
un `merge`** (se leen de `OrderItem.sent_at`/`ready_at`, no de `OrderRound`),
verificado con un test dedicado — el único gap real de "agotados" (que
`app.catalog.service.set_product_availability` no auditaba por sí sola) se
cerró agregando el mismo `record_audit` que ya usaba el router de catálogo,
esta vez alrededor de la llamada que hace `app/orders/service.py` cuando el
contador de porciones llega a cero.

Verificado: **109 tests propios pasan** (`tests/reports` 20 + `tests/orders`
86 + `tests/kitchen` 3, ver §6), `python -m mypy app` limpio en las **89**
fuentes del repo (no sólo las mías — para cuando terminé no quedaban archivos
ajenos a medio escribir; backend-fiscal y backend-clientes-dinero ya habían
entregado).

## 1. Qué construí — archivo → qué

| Archivo | Qué |
|---|---|
| `backend/app/core/tax.py` | **Nuevo.** `TAX_RATE_BY_CODE` (tabla) y `rate_for_code(code) -> int`, centralizados desde el gap declarado en `outputs-1b-1/backend-comanda.md §8`. |
| `backend/app/orders/service.py` | Importa `TAX_RATE_BY_CODE` de `app.core.tax` (ya no lo declara localmente). `admin_list_orders` reescrito: devuelve `{rows, kitchen_times_by_station, sent_at_payment_ratio}` (antes era una lista pelada — cambio de contrato deliberado, ver §2.4). Nuevas funciones privadas `_order_payment_methods`, `_percentile`, `_kitchen_times_by_station`. Nuevo `_check_void_rate_high` (+ `_employee_shift_void_total`, constante `VOID_RATE_ALERT_PCT`), llamado desde `void_item` y `void_order`. `_apply_send` ahora audita (`record_audit`) el 86 automático por contador de porciones, con el mismo `entity="product"`/`action="set_availability"` que ya usaba `app.catalog.router` para el 86 manual (ver §5, gap de "agotados" cerrado). |
| `backend/app/orders/money.py` | **A-12 corregido**: `prorate` ahora topea cada línea a `min(share, weight)` cuando `amount <= sum(weights)` (ver §4). |
| `backend/app/orders/router.py` | `GET /admin/orders`: `format=csv` ahora exporta sólo `rows`. `POST /orders/{id}/items/{item_id}/ready`: **defecto corregido** — tenía `dependencies=[Depends(features.require_feature("kitchen.view"))]`, que resuelve `current_actor` → `current_operator` por dentro y exige una persona identificada y vigente, aunque el propio endpoint usa `current_device` (persona OPCIONAL, tal como lo documenta `CONTRATO-INTERNO-1b-1.md §2.4`). Es el MISMO defecto que `backend-comanda` ya encontró y corrigió en `GET /tables/status` y `GET /kitchen/rounds` (`outputs-1b-1/backend-comanda.md §6.1`) pero no en esta ruta. Lo encontré escribiendo `tests/orders/test_admin_times.py` (un `ready` con el reloj adelantado más de `EMPLOYEE_SESSION_MINUTES` después del `send` devolvía `401 IDENTIFY_REQUIRED` en vez de `200`). Corregido con el mismo patrón: `features.assert_feature(...)` a mano, sin la dependencia. |
| `backend/app/reports/__init__.py` | Nuevo, vacío. |
| `backend/app/reports/schemas.py` | Esquemas de salida de los cinco reportes (§2). Sin `cost`/`margin` en ninguno. |
| `backend/app/reports/service.py` | Toda la lógica de agregación (§2): `aggregate_sales` (compartida por Hoy y Ventas), `sales_report`, `today_report`, `accountant_report`, `unavailable_log`, más los sweeps de alertas (`_sweep_stale_orders`) y la bitácora de agotados (`_unavailable_events`, sobre `app.audit.models.AuditLog`). |
| `backend/app/reports/router.py` | Los cuatro endpoints nuevos bajo `/api/v1/admin/...` (§2), todos `current_admin` + `admin_store` (404 por sede/organización ajena), `format=csv` en `sales`/`accountant-report`/`unavailable-log`. |
| `backend/app/main.py` | `DOMAINS`: agregado `"customers"`, `"refunds"`, `"reports"` (orden de arranque, punto 1 del pedido — esto destrabó a los otros dos agentes). |
| `backend/app/core/models_registry.py` | `MODEL_MODULES`: mismo agregado. `app.reports` no tiene `models.py` propio (reportes de sólo lectura, sin migración) — `find_spec_safe` lo salta sin drama, tal como documenta el propio módulo. |
| `backend/tests/orders/conftest.py` | Nuevo `default_fiscal_range` (autouse): `tests/orders` empezó a necesitar un rango DIAN vigente para los tests que sí llegan a `POST /payments` (`test_admin_times.py`); duplicado a propósito de `tests/payments/conftest.py`/`tests/fiscal/conftest.py`/`tests/reports/conftest.py` (mismo criterio ya establecido en el repo: cada carpeta de test arma su propia base). |
| `backend/tests/orders/test_admin.py` | Actualizado a la nueva forma `{rows, kitchen_times_by_station, sent_at_payment_ratio}`; agregada la aserción de `courtesy_list_value`. |
| `backend/tests/orders/test_admin_times.py` | **Nuevo.** p50/p90 de cocina por estación (3 muestras, valores exactos); tiempos de cocina que sobreviven a un `merge`; `table_minutes`/`payment_methods`/`sent_at_payment_ratio` por fila. |
| `backend/tests/orders/test_limits.py` | Nuevo `test_void_rate_high_notifies_with_dedupe`, mismo patrón que los dos tests de `discount_rate_high`/`courtesy_limit` ya existentes. |
| `backend/tests/orders/test_money.py` | A-12: regresión exacta del hallazgo, un caso de pesos empatados, y dos tests de propiedad (2.000 + 500 casos) — ver §4. |
| `backend/tests/reports/**` | **Nuevo.** `conftest.py` (fixtures + helper `sell`), `test_today.py`, `test_sales.py`, `test_accountant_report.py`, `test_unavailable_log.py` — 20 tests. |

No toqué `app/fiscal`, `app/payments`, `app/customers`, `app/refunds`,
`app/shifts`, `app/stores`, `app/notifications`, `app/catalog`,
`tests/audit`, `tests/conftest.py`, `frontend/`, ni ninguna migración.

## 2. Rutas, parámetros y la fórmula exacta de cada KPI

Todas bajo `current_admin` + `admin_store(db, actor, store_id)`: un
`store_id` de otra organización es `404`, nunca `403` ni `200` vacío. Todas
leen `FiscalDocument`/`OrderItem`/`Payment` (vía `payments_snapshot`) —
**nunca** la carta actual (`app.catalog`) para valorar una venta pasada.

### 2.1 Qué cuenta como "documento de venta" vs. "nota" (decisión base de todo lo demás)

```python
SALE_DOCUMENT_TYPES = (POS_EQUIVALENT, INVOICE, INTERNAL_RECEIPT)
NOTE_DOCUMENT_TYPES = (ADJUSTMENT_NOTE, CREDIT_NOTE, DEBIT_NOTE)
```

Todo reporte de ventas (`/admin/today`, `/admin/sales`, la columna
"documentos" de `/admin/accountant-report`) sólo suma documentos con
`document_type` en `SALE_DOCUMENT_TYPES` **y** `status == "issued"`
(`FiscalDocument.status` es `"issued"` o `"reversed"`, `app/fiscal/models.py`).
Esto es la lectura **literal** de SPEC-NEGOCIO §10: *"Ventas cobradas = Σ
documentos no anulados ni reversados"*. Consecuencia importante y probada
(`tests/reports/test_accountant_report.py::test_a_note_reverses_the_original_and_both_count_separately`):
cuando una nota corrige un documento, el original pasa a `status="reversed"`
y **deja de contar** como venta del período — la nota es su propia fila
(`notes_count`, `notes_base`, `notes_tax`), nunca neteada en silencio contra
`documents_*`. Quien lee el informe ve las dos columnas y resta si quiere el
neto del período; el sistema no decide eso por él.

### 2.2 `GET /admin/today?store_id`

Responde: *¿cómo va el día?* (SPEC-NEGOCIO §9.3 "Hoy").

| Campo | Fórmula | Fuente |
|---|---|---|
| `sales_by_hour[]` | por hora de Bogotá de `FiscalDocument.issued_at` (`app.core.tz.to_bogota(...).hour`): `gross = Σ total`, `net = Σ (total − tax_total)` | `_sale_documents` del día operativo actual |
| `gross` | Σ `FiscalDocument.total` de hoy (sale docs, `issued`) | ídem |
| `net` | `gross − tax` | — |
| `tax` | Σ `FiscalDocument.tax_total` | — |
| `tips_total` / `tips_by_method[]` | Σ `tip_amount` de cada `split` en `payments_snapshot`, por medio | — |
| `orders` | nº de `order_id` distintos entre los documentos de hoy | — |
| `covers` | Σ `Order.covers` de esos `order_id` (`None` si ninguno la tiene) | `Order.covers` |
| `avg_ticket` | `round_half_up(net, orders)` si `orders > 0`, si no `null` | **una sola matemática**: `app.orders.money.round_half_up` |
| `avg_per_cover` | `round_half_up(net, covers)` si `covers > 0`, si no `null` | ídem |
| `tables_occupied` / `tables_total` | reusa `app.orders.service.tables_status` (no reimplementado) | `OrderTable`/`Table`/`Zone` |
| `open_orders[]` | comandas `open`/`to_pay` de la sede, con `minutes_since_opened`, `minutes_since_bill_presented`, `unsent_flag`, `unpaid_flag`, `total` (`compute_order_totals`, no una cuenta propia) | `Order`, `OrderItem` |
| `unsent_count` / `unpaid_count` | nº de comandas con `unsent_flag`/`unpaid_flag` en `True`, **en vivo** (no el conteo de notificaciones ya emitidas, que dedupean por día) | ídem |
| `expected_cash` | `shifts_service.compute_breakdown(db, shift)["expected"]` del turno abierto; `null` si no hay turno abierto ("nadie contó" ≠ "$0") | reusa `app.shifts.service`, no reimplementado |
| `unavailable_products[]` | productos con `available=False` ahora mismo, con `unavailable_at`/`unavailable_by_*` | `app.catalog.models.Product`, sólo lectura |
| `pending_refunds_count` | conteo de `PendingRefund.status == PENDING` de la sede, `find_spec_safe("app.refunds.models")` | degrada a `0` si el módulo no existiera |
| `unreviewed_closes_count` | conteo de `Shift.status == CLOSED and reviewed_by_employee_id IS NULL` | `app.shifts.models`, sólo lectura |
| `alerts[]` | las `Notification` **no leídas** de la sede (`read_at IS NULL`), más recientes primero, límite 30 — el mismo canal que ya usan `shift_stale`, `discount_rate_high`, `fiscal_rejected`, etc. | `app.notifications.models.Notification` |

**Bandera "> X min sin enviar / > Y min sin cobrar"** (SPEC §9.3): dos
umbrales declarados como constantes de módulo, `UNSENT_MINUTES_THRESHOLD =
15` y `UNPAID_MINUTES_THRESHOLD = 20` — ver §5 (gap: no son configurables por
sede todavía).

`today_report` también **sweepea** y emite (`notify(...)`, sin tocar
`app.notifications.service`) `order_unsent_too_long`/`order_unpaid_too_long`
por cada comanda que cruza el umbral, con `dedupe_key=f"order_unsent_too_long:
{order.id}"` (mismo criterio de dedupe diario que ya usan
`discount_rate_high`/`courtesy_limit`).

### 2.3 `GET /admin/sales?from&to&store_id&group_by=`

Responde: *¿qué vendí y cómo me pagaron, agrupado cómo?* (SPEC-NEGOCIO §9.3
"Ventas", contrato §10). `group_by` ∈ `business_date|shift|method|channel|
employee|hour|zone`. Devuelve `{store_id, date_from, date_to, group_by, rows:
[...], total: {...}}` — `total` es la MISMA agregación sin partir por grupo
(nunca puede ser distinta de la suma de `rows`, verificado en
`test_business_date_grouping_matches_the_kpi_formulas` y en el smoke test de
los cinco `group_by`).

Cada fila (`SalesBucketOut`): `{key, label, gross, net, tax, tips, orders,
covers, avg_ticket, avg_per_cover}` — mismas fórmulas que §2.2, por grupo:

- `business_date`/`shift`/`channel`/`employee`/`hour`: se agrupa el
  **documento entero** (`FiscalDocument.business_date`/`shift_id`/`channel`/
  `charged_by_employee_id`/hora de Bogotá de `issued_at`).
- `zone`: se resuelve `order_id → (zona, mesa más chica)` con un join
  `OrderTable → Table → Zone`; una comanda con mesas unidas se atribuye a la
  **primera mesa por número** (gap declarado en §5, no parte la venta entre
  dos filas).
- `method`: el ÚNICO caso que reparte un documento entre varias filas
  (pagos mixtos). `gross`/`tips` de cada medio salen directo de su `split`
  en `payments_snapshot`; el `tax` de cada `split` se calcula con
  **`app.orders.money.prorate(document.tax_total, [amounts de los
  splits])`** — la misma función que reparte descuentos y sub-cuentas, no
  una cuenta nueva. Como `Σ splits.amount == document.total >=
  document.tax_total`, este es exactamente el caso donde el tope de A-12
  (`share <= weight`) entra en juego de verdad: ningún medio puede terminar
  con más impuesto del que le corresponde por su propia parte de la venta —
  probado en `test_group_by_method_splits_a_mixed_payment_prorating_the_tax`
  con una aserción explícita `rows[key]["tax"] <= rows[key]["gross"]`.

### 2.4 `GET /admin/orders?from&to&status&channel&flags=` (ampliado)

Responde: *¿qué comandas están en curso y cuáles se anularon?* (SPEC §9.3
"Pedidos"). **Cambio de contrato deliberado**: antes devolvía una lista
pelada; ahora `{rows: [...], kitchen_times_by_station: [...],
sent_at_payment_ratio: float|null}`. Es un cambio de forma de API, no
cosmético — lo declaro explícitamente porque el contrato original
(`CONTRATO-INTERNO-1b-1.md`) lo documentaba como lista: un percentil por
estación y una razón `sent_at_payment` son agregados del período completo,
no una fila por comanda, y forzarlos dentro de cada fila (o inventar un
tipo de fila distinto) hubiera sido peor. `format=csv` sigue exportando sólo
`rows` (la tabla plana), consistente con el resto del admin. Actualicé el
único test que dependía de la forma vieja (`tests/orders/test_admin.py`, mi
territorio) y agregué `tests/orders/test_admin_times.py`. **No hay agente de
frontend para esta pantalla en este pedido** (mi misión es sólo backend), así
que no hay una UI que dependiera de la forma vieja en este mismo run.

Cada fila de `rows` (por comanda, ganó campos nuevos sobre lo que ya
entregó `backend-comanda`):

| Campo nuevo | Fórmula |
|---|---|
| `closed_at`, `table_minutes` | `table_minutes = (closed_at − opened_at) // 60` si `closed_at` no es `null` (lo pone `claim_payment` al cobrar); si no, `null` — "tiempo de mesa" (SPEC §10) |
| `bill_to_paid_minutes` | `(paid_at − bill_presented_at) // 60` si ambos existen, si no `null` — "cuenta presentada → pagada" (SPEC §10) |
| `void_details[]` | por cada ítem `voided`: `{item_id, reason, after_bill, minutes_since_sent, authorized_by}` — ya estaban en `OrderItem`, sólo se exponen acá |
| `courtesy_list_value` | Σ `list_price × qty` de los ítems con `courtesy_reason` (SPEC §9.3: "cortesías a precio de lista") — `list_price` es el snapshot congelado al agregar el ítem, nunca cambia aunque `courtesy_item` ponga `unit_price=0` |
| `sent_at_payment_ratio` | `sent_at_payment_items / items_count` (por comanda), o `null` si `items_count == 0` |
| `is_staff_meal` | `channel == "staff_meal"` |
| `payment_methods[]` | medios distintos usados en los `payments_snapshot` de TODOS los documentos de esa comanda (junta los de sub-cuentas si la dividió) |

`kitchen_times_by_station[]` (`{station, p50_seconds, p90_seconds,
samples}`): sobre **todos** los `OrderItem` con `station`, `sent_at` y
`ready_at` no nulos de las comandas que matchean `from`/`to`/`status`/
`channel` — **no** se filtra por `flags` (ese filtro sólo recorta qué filas
se muestran; el agregado del período es del período completo, declarado en
el docstring de `admin_list_orders`). Percentil por **rango más cercano**
(nearest-rank, sin interpolar — `_percentile`, `index = min(n-1,
int(pct*n))`): para una métrica operativa en segundos, no en pesos, alcanza
y es auditable a mano. `p50 = pct 0.5`, `p90 = pct 0.9`.

`sent_at_payment_ratio` (top-level) = `Σ sent_at_payment_items / Σ
items_count` de TODAS las filas devueltas por el filtro de fecha/estado/canal
(antes de `flags`).

### 2.5 `GET /admin/accountant-report?year&bimester|month&store_id`

Responde: *¿qué le entrego al contador este bimestre/mes?* (SPEC-NEGOCIO
§8.2). Exactamente uno de `bimester` (1..6) o `month` (1..12); los dos o
ninguno → `400 VALIDATION_ERROR`. Bimestres DIAN estándar: 1=ene-feb,
2=mar-abr, 3=may-jun, 4=jul-ago, 5=sep-oct, 6=nov-dic.

`{store_id, year, period_kind, period, date_from, date_to, rows: [...],
totals_by_method, documents_total_base, documents_total_tax,
notes_total_base, notes_total_tax, tips_total}`.

Cada fila de `rows` es **una fecha de negocio** (SPEC §8.2 "por fecha de
negocio y por tarifa"): `{business_date, documents_count, notes_count,
tips_amount, by_rate: [{rate, documents_base, documents_tax, notes_base,
notes_tax}]}`. `by_rate` sale directo de `FiscalDocument.tax_lines`
(`[{rate, base, tax}]`, ya calculado por la única matemática de la venta al
emitir el documento — este reporte no vuelve a calcular ni un peso de base
ni de impuesto, sólo sub-suma lo que el documento ya trae). `tips_amount` es
**informativa**: nunca entra en `documents_base`/`documents_tax` ni en
ningún neto. `totals_by_method` sale de `payments_snapshot.amount` (sin
propina) sumado por medio, sobre **todo** el período (no por fecha).

Alimenta el formulario 310 (ordinario) o el anticipo 2593/declaración 260
(SIMPLE) — el sistema exporta los números, no genera el formulario (SPEC
§8.2, "El sistema no genera formularios").

### 2.6 `GET /admin/unavailable-log?from&to&store_id`

Responde: *¿qué se agotó, quién lo marcó y cuánta venta se perdió?* (SPEC
§9.3 "Hoy"/"agotados del día"). Ver §5 para el porqué de leer `audit_logs` en
vez del snapshot de `Product`.

`estimated_lost_units`/`estimated_lost_sales` — heurística **declarada, no
inventada de la nada**: promedio de unidades vendidas por día (comandas
`paid`, ítems no anulados de ESE producto) en los **7 días de negocio
anteriores** al que quedó agotado, `round_half_up(Σ qty, 7)`, valorizado al
**precio vigente en el momento del 86** (leído del propio snapshot de
auditoría, `after.prices.dine_in` — no del catálogo actual: una venta
perdida hipotética de hace dos meses no se revalora al precio de hoy).
**Sin ventas previas → `null` en los dos campos, nunca `0`** — "no vendió
nunca" y "no perdió nada" son cosas distintas y la API las distingue.

## 3. `app/core/tax.py` — firma pública y quién la consume

```python
TAX_RATE_BY_CODE: dict[str, int] = {"inc_8": 8, "iva_19": 19, "excluded": 0}

def rate_for_code(code: str) -> int:
    """Tasa entera (%) para un tax_code de la carta; código desconocido -> 0."""
```

Consumidores: `app/orders/service.py` (`from app.core.tax import
TAX_RATE_BY_CODE`, usado tal cual en `_build_product_item`/
`_build_combo_item` — antes era una copia local idéntica). Ningún otro
dominio la importaba todavía a la hora de escribir esto (`app/fiscal`
guarda la tasa **congelada** en `FiscalDocument.tax_lines`/`OrderItem.
tax_rate`, nunca la recalcula desde `tax_code`, así que no necesita esta
tabla — sólo la comanda, al vender, convierte `tax_code → tasa` por primera
vez). Queda centralizada para que notas y facturas de fases futuras que sí
necesiten volver a mapear un `tax_code` no inventen una segunda copia.

## 4. A-12: cómo quedó, y qué prueba el test de propiedad

**Antes** (`outputs-1b-1/auditor-venta.md §3`): `prorate` podía asignar a una
línea más de lo que esa línea pesa cuando el saldo total era menor que la
cantidad de líneas — `prorate(9, [5, 1, 1, 1, 1, 1])` daba `[9, 0, 0, 0, 0,
0]` (la primera línea, peso 5, recibía 9). Eso hubiera dejado `net = gross −
discount` negativo y `round_half_up` revienta con un numerador negativo: un
`500`, no un `400`.

**Ahora** (`app/orders/money.py::prorate`): cuando `amount <= sum(weights)`
(el caso real de un descuento de comanda, donde cada peso es el bruto
restante de SU línea — misma unidad que `amount`), el residuo del redondeo
ya no se le dumpea entero a la línea de mayor peso sin mirar: se reparte,
en orden de peso descendente (empate por índice), dándole a cada línea sólo
el `room = weight − share` que le queda, y pasando el sobrante a la
siguiente. Matemáticamente, cuando `amount <= total_weight` siempre hay
saldo total suficiente (`Σ room_i = total_weight − amount + residual >=
residual`), así que el reparto SIEMPRE termina en `remaining == 0` sin
recurrir al `if remaining:` defensivo que quedó como respaldo (nunca se
alcanza, pero está ahí por si el razonamiento tuviera un agujero que no vi).

**Cuando `amount > sum(weights)`** — el OTRO uso real de `prorate`
(`_sub_account_item_allocations`, repartir plata entre *porciones* de un
ítem compartido: `weights` son cantidades chicas de porciones, no pesan en
la misma unidad que `amount`) — el tope **no** se aplica: ahí no hay forma de
que cada "porción" absorba su propio peso en pesos, y el contrato de ese
llamador es justamente que `amount` se reparta igual sin ese tope. Se
conserva el comportamiento literal de siempre (`test_a12_property_amount_
over_capacity_keeps_the_legacy_shape`). Esto es importante: un tope
incondicional hubiera roto `_sub_account_item_allocations` (la división por
ítems dejaría de sumar el total de la comanda) — el A-12 real está acotado
al caso donde `weight` y `amount` están en la misma unidad.

**Tests** (`tests/orders/test_money.py::TestProrate`):

1. `test_a12_regression_small_weights_never_exceed_their_own_weight`: el
   caso exacto del hallazgo, `prorate(9, [5,1,1,1,1,1])`.
2. `test_a12_ties_can_overflow_the_single_largest_line`: `prorate(8,
   [3,3,3])` — con pesos reales (no extremos) ya alcanzaba para romperlo con
   el algoritmo viejo (`[4,2,2]`, 4 > 3).
3. `test_a12_property_amount_within_capacity_never_exceeds_any_weight`
   (**el test de propiedad pedido**): 2.000 combinaciones aleatorias
   (`random.Random(20260915)`, 1 a 8 pesos entre 0 y 50, `amount` entre 0 y
   `Σ weights`) — para cada una: `Σ shares == amount`, `share <= weight` en
   cada línea, `share >= 0`, y un peso en `0` recibe `0`.
4. `test_a12_property_amount_over_capacity_keeps_the_legacy_shape`: 500
   casos con `amount > Σ weights` — sólo exige `Σ shares == amount` y
   `weight == 0 → share == 0` (el invariante que ese llamador necesita).

Y de yapa, la prueba **de producción real** de que el tope funciona con
plata de verdad: `tests/reports/test_sales.py::
test_group_by_method_splits_a_mixed_payment_prorating_the_tax` reparte el
impuesto de un documento entre dos medios de pago con `prorate` y verifica
`tax <= gross` en cada medio.

No rompí el invariante que el auditor ya prueba: `sum(shares) == amount`
(`tests/audit/test_sales_invariants.py::
test_prorating_never_loses_a_peso_even_on_the_hardest_remainders`, que no
toqué —vive en `tests/audit`, ajeno— corrí ese archivo puntual a mano y sigue
en verde) y "el residuo a la línea mayor" sigue siendo el comportamiento
real en el caso común (pesos reales, residuo chico: la línea mayor casi
siempre tiene room de sobra y se lleva todo el residuo en un solo paso,
exactamente como antes).

## 5. Gaps

1. **Tiempos de cocina de comandas unidas: NO quedaron incompletos** (es el
   gap que el pedido pedía verificar explícitamente). El gap real de 1b-1
   ("tras `merge`, las rondas históricas de la comanda origen no se listan en
   la destino", `outputs-1b-1/backend-comanda.md §6.7/§8`) es sobre
   `OrderOut.rounds` — un arreglo de **presentación** que arma la lista de
   "ronda #N enviada a las…" para la UI de la comanda. `merge_orders` mueve
   los ÍTEMS a la comanda destino con un `UPDATE order_items SET order_id =
   :dest ...`; `sent_at`/`ready_at`/`station` son columnas del propio
   `OrderItem`, así que viajan con él. Mi cálculo de p50/p90
   (`_kitchen_times_by_station`) lee esas columnas directo, sin pasar nunca
   por `OrderRound` — verificado con
   `tests/orders/test_admin_times.py::test_kitchen_times_survive_a_merge`
   (un ítem enviado y marcado `ready` en la comanda origen, después unida a
   una comanda vacía: el percentil sigue viendo esa muestra, y la fila de
   `rows` de la comanda destino cuenta ese ítem). Lo que SÍ sigue roto tras
   un `merge` es la vista `GET /kitchen/rounds` (de `backend-comanda`/
   `app/kitchen`, no mi territorio): esa ruta arma la lista uniendo
   `OrderRound.order_id` con `Order`, y como la ronda de origen sigue
   apuntando a la comanda YA fusionada (status `merged`), un ítem recién
   unido puede mostrarse en cocina bajo el `order_id` viejo. Lo declaro para
   quien lo retome, pero es un defecto de presentación de cocina en vivo, no
   de reportes.

2. **Umbrales sin configuración de sede**: `UNSENT_MINUTES_THRESHOLD = 15`,
   `UNPAID_MINUTES_THRESHOLD = 20` (`app/reports/service.py`) y
   `VOID_RATE_ALERT_PCT = 10.0` (`app/orders/service.py`) son constantes de
   producto, no campos de `StoreSalesSettings` — ese modelo es de
   `app/stores`, territorio ajeno. Mismo patrón que
   `discount_daily_limit_pct`/`courtesy_shift_limit`, que si SON
   configurables porque ya existían en `StoreSalesSettings` desde 1a/1b-1.
   Un pedido futuro que toque `app/stores` debería subir estos tres al mismo
   lugar.

3. **`group_by=zone` atribuye toda la venta a la PRIMERA mesa** (por
   número) de la comanda. Una comanda con mesas unidas (varias zonas)
   reparte su venta entera a una sola fila en vez de partirla — declarado
   en el docstring de `_order_zone_map`. Partir la venta entre zonas
   exigiría prorratear por algo (¿tiempo en cada mesa? ¿ítems servidos en
   cada una?) que el modelo no registra; no lo inventé.

4. **`GET /admin/orders`: `kitchen_times_by_station` y
   `sent_at_payment_ratio` no respetan `flags`** (sólo `from`/`to`/`status`/
   `channel`). Es una decisión, no un olvido: un percentil de "sólo las
   comandas anuladas" no es una métrica operativa útil — declarado en el
   docstring de `admin_list_orders`.

5. **`unavailable-log` depende de que el 86 pase por una de las dos vías
   auditadas** (`POST /products/{id}/availability` del admin/POS, o el
   automático de `_apply_send` que agregué). Si algún día aparece un TERCER
   camino que toque `Product.available` sin pasar por ninguna de las dos
   (por ejemplo, un `PATCH /admin/products/{id}` que en algún momento
   agregue un campo `available` — hoy `ProductUpdateIn` no lo tiene), ese
   evento no quedaría en la bitácora. Puramente hipotético con el código
   actual, pero lo declaro porque el reporte depende de una convención
   (auditar `set_availability`), no de una restricción de base de datos.

6. **`GET /admin/employees/{id}/activity`** (mencionado en la sección 4 del
   pedido general) ya lo entrega `app/shifts/router.py` — no es mío por
   territorio (`app/shifts` está prohibido) y mi lista concreta de "Qué
   construís" tampoco lo incluye; lo confirmé por `grep` antes de escribir
   una línea, no lo até por las dudas.

7. **Índices**: `payments_snapshot`/`tax_lines` viven en `FiscalDocument`
   (índice ya existente `ix_fiscal_documents_store_business_date`, que cubre
   los cuatro reportes de este territorio) — no agregué ninguna consulta
   que escanee `payments`/`order_items` sin un índice ya presente por
   `(store_id, status)`/`(order_id, status)`, salvo
   `_estimated_lost_sales` (`unavailable-log`, filtra `OrderItem.product_id`
   sin índice propio sobre esa columna combinada con `Order.business_date`)
   y `_unavailable_events` (`AuditLog` filtra por `store_id, entity, action`
   sin un índice compuesto — hoy `AuditLog` sólo indexa `entity`/`store_id`/
   `at` por separado). Volumen esperado bajo (bitácora de agotados, no de
   cada venta) así que no bloqueó la entrega, pero lo declaro: no puedo
   crear migraciones desde este territorio.

## 6. Verificación (comandos y resultado literal)

```
$ mkdir -p /tmp/pt-backend-rep
$ cd backend && TMPDIR=/tmp/pt-backend-rep python -m pytest tests/reports tests/orders tests/kitchen -q
.........................................................................
.........................................................................
109 passed, 177 warnings in 323.48s (0:05:23)
```

(Resultado literal de la corrida final, los tres directorios juntos con el
mismo comando y el mismo `TMPDIR` que pide la misión. También corrido por
partes mientras escribía: `tests/reports` 20/20, `tests/orders` 86/86,
`tests/kitchen` 3/3 — sin fallos en ninguna corrida, incluidas dos
repeticiones completas de `tests/orders` después de la corrección del
`ready`/`require_feature` y de agregar el `record_audit` al 86 automático.)

```
$ cd backend && python -m mypy app
Success: no issues found in 89 source files
```

No corrí la suite completa del backend, `npm run build`, ni `alembic upgrade
head` sobre `dev.db`: mis reportes no tienen migración propia (son de
lectura pura sobre tablas que ya existen), y la suite completa la corre el
orquestador una sola vez, en serie.

## 7. Decisión: `TAX_RATE_BY_CODE`/dominios en `DOMAINS` — hecho primero

Como pedía el "orden de arranque" de la misión, lo primero que hice fue (1)
`app/core/tax.py` y (2) agregar `"customers"`, `"refunds"`, `"reports"` a
`DOMAINS` (`app/main.py`) y `MODEL_MODULES` (`app/core/models_registry.py`)
— verificado con un `python -c` que monta la app e imprime los paths de
OpenAPI de `/admin/customers`, `/admin/pending-refunds`, `/admin/today`, etc.
antes de escribir una sola línea más, para no bloquear a `backend-fiscal`/
`backend-clientes-dinero` (que para ese momento ya tenían `app/customers` y
`app/refunds` con carpeta propia, así que `find_spec_safe` no tenía nada
peligroso que saltar — pero el orden lo respeté igual, por si alguno todavía
no había llegado a ese punto).

## Ronda 2 — B-3 (bloqueante, alertas fiscales)

**El hallazgo**: `GET /admin/today` no traía `fiscal_contingency_overdue` a
«Requiere tu atención» porque `sweep_contingency_overdue`
(`app/fiscal/service.py:453-484`) sólo corría al entrar a
`GET /admin/fiscal/documents`/`GET /admin/fiscal/export`
(`app/fiscal/router.py:210`, barrido perezoso — decisión de `backend-fiscal`
por no haber scheduler, `CONTRATO-INTERNO-1b-1.md §1`). Hoy es la pantalla
que el dueño abre primero; un documento podía pasar de largo las 48 h del
art. 616-1 ET sin que nadie se enterara, salvo que además entrara a
Documentos fiscales.

**El arreglo** (`app/reports/service.py`):

- Import nuevo, línea 37: `from app.fiscal import service as fiscal_service`
  (al lado de `from app.fiscal.models import FiscalDocument,
  FiscalDocumentType` que ya estaba en la línea siguiente). Confirmé que no
  hay ciclo: `app/fiscal/service.py` no importa `app.reports` en ningún lado
  (`grep -rn "app\.reports" app/fiscal/` → sin resultados) y la suite de mi
  territorio (que importa ambos módulos en el mismo proceso) corre limpia.
- Llamado nuevo, `app/reports/service.py:520`, dentro de `today_report`,
  inmediatamente después de `unsent_count, unpaid_count =
  _sweep_stale_orders(db, store, now)` (línea 508) y **antes** de que se
  arme `open_orders`/`alerts=_recent_alerts(db, store)` (línea 548):

  ```python
  fiscal_service.sweep_contingency_overdue(db, store_id=store.id)
  ```

**Por qué va antes de `_recent_alerts`**: `_recent_alerts` (línea 470-482)
hace un `SELECT` sobre `Notification` filtrando `read_at IS NULL`, ordenado
por `created_at DESC`, límite 30 — es una lectura de lo que YA está en la
tabla en el momento en que se ejecuta. `sweep_contingency_overdue` es quien
escribe la fila `fiscal_contingency_overdue` (vía `notifications_service
.notify(...)`, con `dedupe_key=f"fiscal_contingency_overdue:{row.id}"`)
cuando un documento en `contingency` lleva más de 48 h desde su
`issued_at`. Si el sweep corriera después de `_recent_alerts`, o no
corriera, la alerta recién aparecería en la SIGUIENTE llamada a `/admin/
today` — que es exactamente el bug: el dueño que abre Hoy una sola vez no la
ve. Llamarlo antes de armar la respuesta hace que la misma request que
detecta el vencimiento sea la que lo muestra.

**Por qué un `GET` escribe una notificación**: mismo precedente que ya
existía en este mismo archivo, `_sweep_stale_orders(db, store, now)`
(línea 508 de esta ronda, dentro de `today_report`), que ya notifica
`order_unsent_too_long`/`order_unpaid_too_long` al entrar a `GET /admin/
today` (documentado en §2.2 de este entregable, "`today_report` también
**sweepea** y emite"), y el barrido perezoso original de
`sweep_contingency_overdue` en `app/fiscal/router.py:210` (dentro de un
`GET`, no de un `POST`). Un barrido sin scheduler necesita un disparador, y
el disparador que el pedido eligió es "una pantalla del admin se abre" —
`today_report` ya seguía ese patrón para sus propios sweeps; sumar el de
contingencia es consistente con la decisión ya tomada, no una nueva.
`notify(...)` dedupea por `dedupe_key`, así que entrar a Hoy repetidas veces
el mismo día no duplica la alerta (verificado en el test nuevo, ver abajo).

**No se tocó** `app/fiscal/**` (se llama la función del dueño, no se copia
la consulta ni el umbral de 48 h ni el texto de la notificación) ni
`backend/tests/audit/**`.

**Test propio** (`backend/tests/reports/test_today.py::
test_contingency_overdue_reaches_today_without_visiting_fiscal_documents`,
`tests/reports` es mi territorio): con la fixture `clock`, emite un
documento con `FakeProvider(outcome="contingency")` (`app.fiscal.provider`),
verifica el caso **negativo** a las 47 h (`fiscal_contingency_overdue` NO
está en `alerts`), avanza 2 h más (49 h totales) y verifica que `GET
/admin/today` SÍ trae la alerta sin pasar por `/admin/fiscal/documents`, que
sólo se creó UNA `Notification` en la base, y que una segunda llamada a
`/admin/today` no duplica (dedupe). Es una réplica reducida, en mi propio
territorio, del test que trajo esta ronda
(`tests/audit/test_reports_invariants.py::
test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it`),
que no toqué.

**Alcance cerrado**: sólo B-3. Los gaps declarados en §5 (reparto por zona
con mesas unidas, umbrales `UNSENT_MINUTES_THRESHOLD`/
`UNPAID_MINUTES_THRESHOLD`/`VOID_RATE_ALERT_PCT` sin configuración de sede,
índices compuestos, relleno de horas sin ventas) siguen declarados, sin
tocar, en esta ronda.

### Verificación (comandos y salida literal)

```
$ mkdir -p /tmp/pt-backend-rep-r2
$ cd backend && TMPDIR=/tmp/pt-backend-rep-r2 python -m pytest tests/reports tests/orders tests/kitchen -q
........................................................................ [ 65%]
......................................                                   [100%]
110 passed, 179 warnings in 318.54s (0:05:18)
```

(109 de la entrega anterior + 1 nuevo:
`test_contingency_overdue_reaches_today_without_visiting_fiscal_documents`.)

```
$ mkdir -p /tmp/pt-backend-rep-r2-audit
$ cd backend && TMPDIR=/tmp/pt-backend-rep-r2-audit python -m pytest "tests/audit/test_reports_invariants.py::test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it" -q
.                                                                        [100%]
1 passed, 7 warnings in 4.41s
```

(El test rojo de B-3 — nombre real confirmado, no el que citó el
Conciliador — pasa a VERDE.)

```
$ cd backend && python -m mypy app
Success: no issues found in 89 source files
```

No se editó ningún archivo bajo `backend/tests/audit/`. No se corrió la
suite completa del backend ni `alembic upgrade head` sobre `dev.db`.
