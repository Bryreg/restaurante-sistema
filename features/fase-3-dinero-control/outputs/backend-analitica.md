# Entregable — `backend-analitica` (T4, Fase 3 «dinero y control»)

Territorio: `backend/app/analytics/**` (`schemas.py`, `service.py`, `router.py`,
`hooks.py` — sin `models.py`), `backend/tests/analytics/**`,
`backend/tests/audit/test_analytics_invariants.py`. **Sin migración `0021`** — ver
§2.

---

## 0. Ajuste de iteración 2 — C3/H-3 (`GET /admin/variance/by-dish` devolvía `422` siempre) — CERRADO

**Hallazgo verificado por el Maestro** (cruzando `app/analytics/router.py` contra
`frontend/src/api/analytics.ts`): `count_id` era `Query(...)` **obligatorio** en
mi router, pero `getVarianceByDish` de T5 siempre mandó sólo `{ store_id }` —su
propio comentario documenta por escrito «opcional: el más reciente si se omite».
Resultado: toda carga de la pantalla «Varianza por plato» devolvía `422` y la
capacidad era inalcanzable. **Decisión del orquestador: se mueve el backend, no
el cliente** (T5 tiene instrucción explícita de no tocar `getVarianceByDish`) —
es el lado que sabe cuál fue el último conteo aplicado, y es la misma regla de
«resolver del lado que sabe» que D-1 ya aplica.

**Qué cambié, exactamente:**

1. `app/analytics/router.py::get_variance_by_dish` — `count_id: int = Query(...)`
   → `count_id: int | None = Query(default=None)`.
2. `app/analytics/service.py::variance_by_dish` — firma ahora
   `count_id: int | None`. Con `count_id=None`, resuelve el conteo `full`
   `applied` **más reciente** de la sede con `_applied_full_counts_desc` (la
   MISMA lectura de sólo modelo que ya usaba D-1 antes de este ajuste) — **sólo
   lectura**: no importa `app.inventory.service`, no toca `_variance_level`. Un
   `count_id` explícito sigue el mismo camino de validación que tenía antes
   (existe, es de esta sede, es `full`/`applied`) sin cambiarle una coma.
3. Sede **sin ningún conteo aplicado** (con o sin `count_id` explícito que no
   exista): antes de este ajuste, sin `count_id` la petición ni siquiera llegaba
   a esta rama (`422` de Pydantic antes de tocar el service). Ahora, con
   `count_id=None` y `counts_desc` vacío, devuelve `VarianceByDishOut` con
   `available: false`, `count_id: null` y
   `reason: "todavía no hay ningún conteo aplicado en esta sede, así que no hay
   ventana contra la cual medir varianza"` — **ni `404` ni `422`**, la misma
   regla `null` con motivo que ya aplicaba `control_health_sustained` (D-1) para
   «sin historial suficiente»; acá faltaba.
4. `app/analytics/schemas.py::VarianceByDishOut.count_id` — `int` → `int | None`
   (el único caso en que es `None` es el punto 3: no hay nada que resolver). La
   respuesta siempre devuelve el `count_id` resuelto (explícito o inferido) junto
   con `window_from`/`window_to`, para que la pantalla pueda decir QUÉ ventana
   está mostrando sin inventarla — `frontend/src/api/analytics.ts` ya declaraba
   `count_id?: number` como opcional, así que el cliente no necesita ningún
   cambio de tipos.
5. **La matemática no se tocó**: `method: "prorated"` sigue fijo en el esquema,
   el prorrateo sigue siendo `app.orders.money.prorate(...)`, y con `count_id`
   explícito el resultado es idéntico al de antes del ajuste (test (c) de abajo
   lo prueba).

**Tests nuevos** en `backend/tests/analytics/test_variance_by_dish.py` (por
HTTP, la puerta real):

- (a) `test_variance_by_dish_without_count_id_resolves_the_latest_applied_count`
  — con un conteo aplicado y ventas reales, la respuesta SIN `count_id` es
  **byte a byte idéntica** (`implicit.json() == explicit.json()`) a la respuesta
  CON `count_id` explícito. Éste es el test que faltaba y por el que nadie vio
  el `422`: los 30 tests previos siempre pasaban `count_id` a mano.
- (b) `test_variance_by_dish_without_count_id_and_without_any_applied_count_is_available_false_not_422`
  — sede recién habilitada, sin ningún conteo aplicado, sin `count_id` → `200`
  con `available: false`, `reason` presente, `count_id: null`, `rows: []`. Nunca
  `422`, nunca `404`.
- (c) `test_variance_by_dish_with_explicit_count_id_behaves_exactly_as_before_the_adjustment`
  — con `count_id` explícito el comportamiento no cambió una coma (mismo
  `available`/`reason`/`count_id` que devolvía antes de este ajuste).

**No toqué** `backend/tests/audit/*` ni `frontend/src/audit/*` (territorio del
auditor — sus cruces son el criterio de aceptación) ni ningún archivo de
`app/inventory/`, `frontend/` o `backend/alembic/versions/0019_invoice_total.py`
(de T2). `_variance_level` sigue intacto — el mismo AST-check de siempre
(`test_analytics_module_never_imports_or_redefines_variance_level`) sigue en
verde.

**Verificación re-corrida tras el ajuste** (ver §8 para el detalle completo):

```
$ cd backend && TMPDIR=/tmp/pt-backend-analitica python -m pytest tests/analytics tests/audit/test_analytics_invariants.py -q
33 passed, 61 warnings in 90.93s

$ cd backend && python -m mypy app
Success: no issues found in 147 source files
```

(33 = los 30 de la ronda anterior + los 3 nuevos de este ajuste; ninguno se
borró ni se ablandó.)

### Ratificación pedida al Maestro (no es un gap, es una decisión cerrada)

El gating de `GET /admin/variance/by-dish` y `GET /admin/control-health/sustained`
contra `inventory.variance` (en vez de `analytics.menu_engineering` o una clave
propia) fue **RATIFICADO por el orquestador**: queda como está, sin cambios. El
razonamiento de §3 (abajo) se sostiene — `app/inventory/router.py` gatea sus
rutas hermanas `/admin/variance`, `/admin/food-cost` y `/admin/control-health`
con esa misma clave para el mismo concepto, y T5 ya gateó su pantalla así, con
entrada de navegación propia. **No es una pregunta abierta**: la frase de §3 que
decía «si el Maestro prefiere una clave propia... es un cambio de una línea»
queda reemplazada por esta ratificación explícita.

---

## 1. Qué construí, qué es derivado y qué NO almacené (con el porqué)

**No hay `models.py` ni migración `0021`. Todo el dominio es derivado**, sobre datos
que ya existen en `orders`, `inventory` (vía `hooks.py` y lectura de sus modelos
públicos) y `fiscal`. No creé ni una sola tabla nueva.

Construí, en `app/analytics/service.py`:

1. **Ingeniería de menú** (`menu_engineering`) — clasificación por plato
   (`star`/`plowhorse`/`puzzle`/`dog`) sobre popularidad (regla del 70 %,
   Kasavana–Smith) y margen de contribución, **sobre el costo CONGELADO**
   (`OrderItem.unit_cost_micros`), leyendo el ingreso neto por ítem reusando
   `app.orders.service.compute_order_totals` (la única matemática de la venta —
   no reimplementé el prorrateo de descuento de comanda).
2. **Varianza por plato** (`variance_by_dish`) — prorratea, por `app.orders.money.
   prorate`, el valor en pesos de la varianza de CADA insumo (entre dos conteos
   completos aplicados consecutivos) entre los platos que teóricamente lo
   consumieron en esa ventana, pesado por su consumo teórico
   (`StockMovement cause=sale, ref_type=order_item`). `method: "prorated"`
   siempre presente y explícito, tal como pide SPEC-NEGOCIO §5.4.
3. **«Sostenido»** (`control_health_sustained`) — D-1 exactamente: ver §4.
4. **Reposición sugerida** (`replenishment`) — `suggested_qty` (siempre
   calculable: `max(0, min_stock − stock_actual)`) y `suggested_min` (mínimo
   PROPUESTO = consumo diario promedio de 30 días × `Ingredient.lead_time_days`,
   `null` con motivo sin lead time o sin consumo).

**Por qué nada se guarda** (§6.1, «derivar en vez de almacenar»): las cuatro
capacidades son lecturas agregadas sobre hechos que YA están en el libro de
movimientos, en los ítems de venta y en los conteos aplicados. Guardar una
columna de "clasificación del plato" o de "sostenido" sería exactamente el tipo
de columna que la referencia desincronizó (la única columna almacenada de ese
tipo del sistema de referencia). Si algún día el volumen de datos hace estas
consultas caras, cachear es un problema de rendimiento, no de arquitectura — y
se resuelve con una tabla de CACHÉ invalidable, no con una fuente de verdad
nueva.

**Decisión de umbral declarada, no asumida en silencio** (`_SUSTAINED_RED_
THRESHOLD_BP_DEFAULT` en `service.py`): D-1 dice "supera el umbral rojo" sin
nombrar de dónde sale ese umbral. Reutilicé `StoreInventorySettings.
variance_red_threshold_bp` (la MISMA configuración de sede que ya calibra el
semáforo por renglón, con el mismo default de 400 bp / 4 puntos que SPEC-NEGOCIO
§5.4 describe textualmente: "< 2 verde, 2-4 revisar, > 4-5 rojo") en vez de
inventar un segundo umbral con otro nombre para el mismo concepto — dos
umbrales rojos distintos para "food cost se fue de madre" habría sido
exactamente la clase de segunda fuente de verdad que estas reglas prohíben. Es
una lectura de sólo el valor numérico de esa fila (no de su lógica), con
fallback al mismo `400` que trae la columna por defecto si la sede nunca la
configuró.

**Límite de import deliberado, documentado en el docstring del módulo (léanlo,
es la decisión más importante de este entregable).** El mandato de este
territorio dice, textual: *"leé `app/inventory/service.py` sólo para ver
`_variance_level` sin tocarlo"*. Pero D-1 y la varianza por plato necesitan
EXACTAMENTE la misma identidad que ya implementan `food_cost_report`/
`variance_report` en ese archivo — extendida a MÚLTIPLES ventanas históricas
(algo que esas funciones no ofrecen: sólo resuelven la ventana más reciente
dentro de un rango). Tenía dos caminos, los dos con un costo:

- Importar `app.inventory.service.food_cost_report`/`variance_report`
  directamente (hay precedente real en este MISMO pedido: `app/expenses/
  service.py`, ya construido por T2, importa `app.reports.service` completo).
  Pero mi mandato es más específico que el de T2 y restringe explícitamente a
  `_variance_level`.
- **Espejar la fórmula, línea por línea, con primitivas PUBLICADAS** —
  `hooks.get_ingredient`, `hooks.resolve_ingredient_cost`, `app.core.quantity.
  line_cost_micros`/`micros_to_pesos` — y lectura de sólo lectura de
  `StockCount`/`StockCountLine`/`StockMovement` (modelos, no lógica privada;
  mismo patrón que `app.reports.service` ya usa para leer `Order`/
  `FiscalDocument` de otros dominios). **Elegí este camino**: respeta la
  instrucción tal como está escrita, y sigue evitando la "segunda matemática"
  porque no INVENTA una fórmula nueva — reproduce la publicada, componiéndola
  con piezas que sí son contrato.

Las funciones `_count_inventory_value`, `_purchases_value`, `_signed_pct_bp` de
`app/analytics/service.py` son ese espejo, con el docstring de cada una
apuntando a su gemela en `app.inventory.service`. **Riesgo declarado**: si la
fórmula de `food_cost_report`/`variance_report` cambia alguna vez, este espejo
puede desincronizarse sin que un test lo note (no hay una comparación cruzada
automática entre los dos archivos). Recomiendo, para un pedido futuro, que
`app.inventory.hooks` publique una función de ventanas históricas (algo como
`food_cost_windows(db, *, store_id, cutoff_hour, limit=3) -> list[...]`) para
que este archivo dependa de UN contrato publicado en vez de un espejo — lo
declaro en `gaps`, no lo resolví yo porque abrir `app/inventory/` no es mi
territorio.

---

## 2. Migración `0021`: **NO LA CREÉ**

Mi territorio no necesita ninguna tabla nueva — las cuatro capacidades son
100 % derivadas (§1). **No creé `backend/alembic/versions/0021_analytics.py`**,
ni vacía ni con contenido: el mandato es explícito en que una migración vacía
"para no romper la cadena" está prohibida. El orquestador humano reencadena el
`down_revision` del siguiente pedido que sí necesite tablas a `"0020"` (el
padre que yo hubiera usado).

Confirmado con `alembic heads` antes de cerrar (una sola cabeza, `0020`, que es
exactamente la última migración de la cadena de esta fase hoy):

```
$ cd backend && python -m alembic heads
0020 (head)
```

---

## 3. Rutas publicadas (exactas) y ninguna fuera del contrato

Las cuatro del contrato mínimo, tal cual, bajo `/api/v1`, todas de administrador
(`current_admin`):

| Ruta | Flag | Dependencia validada ANTES |
|---|---|---|
| `GET /admin/menu-engineering?store_id&from&to` | `analytics.menu_engineering` | `catalog.recipes` |
| `GET /admin/variance/by-dish?store_id&count_id` (`count_id` **opcional** — ver §0) | `inventory.variance` (ver nota) | — |
| `GET /admin/control-health/sustained?store_id` | `inventory.variance` (ver nota) | — |
| `GET /admin/replenishment?store_id` | `inventory.replenishment` | `inventory.perpetual` **y** `purchases` |

**No agregué ninguna ruta fuera del contrato.**

**Nota sobre el flag de `variance/by-dish` y `control-health/sustained`**: el
contrato mínimo sólo nombra `analytics.menu_engineering` e `inventory.
replenishment` para T4 — ninguna de las dos gatea, conceptualmente, la varianza
por plato ni «sostenido» (que son, los dos, una extensión de la varianza de
INVENTARIO, no de la ingeniería de menú ni de la reposición). Verifiqué contra
el código de `app.inventory.router` que sus rutas hermanas (`/admin/variance`,
`/admin/food-cost`, `/admin/control-health`) están TODAS gateadas con la misma
clave, `inventory.variance` — sin encadenar manualmente `inventory.counts`/
`inventory.perpetual`/`catalog.recipes` (así lo hace su propio dueño). Reutilicé
esa MISMA clave, con el mismo criterio de quien la publicó, en vez de inventar
una tercera clave nueva para el mismo concepto. **RATIFICADO por el
orquestador en la iteración 2** (§0): queda como está, cerrado, no es una
pregunta abierta ni un gap.

Rutas que **no** son mías, caminadas y confirmadas: «cobro por mesero» **no
lleva ruta nueva** (§6, más abajo) — sigo usando `GET /admin/sales?
group_by=employee`, que ya existe.

---

## 4. D-1 («sostenido»): implementación exacta, con las tres ventanas y el `null` con motivo

`GET /admin/control-health/sustained` → `app.analytics.service.
control_health_sustained`:

1. Lee TODOS los conteos `scope=full` `status=applied` de la sede, del más
   reciente al más viejo (`_applied_full_counts_desc`, lectura de modelo, no
   lógica).
2. Arma ventanas consecutivas (`counts[i]`, `counts[i+1]`) de la más reciente
   hacia atrás, y calcula la brecha (`real % − teórico %`, en puntos básicos)
   de CADA una con `_window_food_cost_gap_bp` — el espejo declarado en §1.
3. **Sólo cuenta una ventana si es COMPUTABLE** (`net_sales > 0` en la ventana
   Y al menos un ítem con costo congelado en ese rango de fechas de negocio):
   una ventana sin datos se SALTA, nunca se cuenta como "no roja" — es la
   lectura literal de "ventanas de food cost real **disponibles**" del texto
   de D-1, no "las últimas 3 que haya, aunque no se puedan calcular".
4. Sigue buscando hacia atrás en el historial hasta juntar 3 ventanas
   computables o quedarse sin conteos.
5. Con **menos de 2** ventanas computables: `sustained_red: null`,
   `windows_evaluated` (0 o 1), `reason: "sin historial suficiente: hacen falta
   al menos dos conteos completos aplicados"` — el texto EXACTO que pide D-1.
6. Con 2 o 3 ventanas computables: `sustained_red = (cuántas superan el umbral
   rojo) >= 2`. Nunca `null`, nunca verde por defecto.

El umbral rojo (`red_threshold_bp`) viaja en la respuesta (`StoreInventory
Settings.variance_red_threshold_bp` de la sede, o `400` por defecto — §1), y
cada ventana evaluada viaja completa (`opening_count_id`, `closing_count_id`,
`window_from`, `window_to`, `real_pct_bp`, `theoretical_pct_bp`, `gap_bp`,
`exceeds_red`) para que la pantalla pueda mostrar el detalle, no sólo el
booleano final.

**Las cuatro ventanas del checklist, probadas** (`tests/analytics/
test_sustained.py`):

- **0 ventanas** (ningún conteo completo aplicado nunca):
  `test_sustained_with_zero_or_one_applied_counts_is_null_with_a_reason` (primera
  mitad) — `sustained_red: null`, `windows_evaluated: 0`, `reason` presente.
- **1 ventana** (un solo conteo aplicado, no hay con qué formar ninguna
  ventana): misma prueba, segunda mitad — `sustained_red: null`,
  `windows_evaluated: 0` (CERO, no uno: con un solo conteo no hay ni siquiera
  UNA ventana, que necesita DOS conteos).
- **2 ventanas** (3 conteos aplicados, una ventana roja y otra verde):
  `test_sustained_two_windows_one_over_threshold_is_not_red` — hay historial
  SUFICIENTE (2 ventanas computables, el mínimo que exige D-1), pero sólo 1 de
  2 supera el umbral: `sustained_red: False` (nunca `null`: sí hay datos).
- **3 ventanas** (4 conteos aplicados, ventanas 1 y 3 rojas, la 2 verde):
  `test_sustained_two_of_three_windows_over_threshold_is_red` — construida con
  ventas REALES (turno abierto, ficha técnica, `POST /orders` → `/items` →
  `/payments`, para que el costo TEÓRICO congelado exista de verdad) y conteos
  aplicados reales vía HTTP, con `clock` controlado para separar cada ventana
  por un día de negocio limpio. `sustained_red: True`, `windows_evaluated: 3`,
  exactamente 2 de las 3 con `exceeds_red: true`.

Las cuatro corren en verde. El caso de 3 ventanas es el más importante: no es
un cálculo simulado con `record_movement` a mano (mi primer intento, que
descarté porque nunca generaba un costo TEÓRICO congelado y por lo tanto ninguna
ventana llegaba a ser computable) sino el flujo real de venta + conteo, que es
lo único que prueba que la brecha real-vs-teórico se calcula con datos que el
sistema realmente produce.

---

## 5. Prueba de que la ingeniería de menú usa el costo congelado (no revalora)

`test_menu_engineering_uses_the_frozen_cost_never_the_recipe_of_today`
(`tests/analytics/test_menu_engineering.py`):

1. Insumo a `$10/g`, ficha de 100 g → $1.000 de costo teórico congelado por
   plato.
2. Se venden 3 platos (se congela `unit_cost_micros` en cada `OrderItem` al
   momento de la venta).
3. **Después de vender**, la carta CAMBIA: el costo oficial del insumo sube a
   `$999/g`, y la ficha se reescribe a 1 g (una versión nueva, `version=1`).
4. `GET /admin/menu-engineering` sobre el período de la venta.

**Resultado**: `theoretical_cost == 3000` ($1.000 × 3), el número de CUANDO SE
VENDIÓ — no el que daría revalorar con la ficha de hoy (que sería 3 × 1 g ×
$999 = $2.997, un número completamente distinto y, de paso, la prueba de que un
error de revaloración no pasa desapercibido: si el código leyera
`unit_cost_micros` mal o volviera a `expand_consumption`, este test lo
detectaría con un número visiblemente distinto).

**Por qué es estructuralmente imposible que revalore**: `menu_engineering` NUNCA
importa `app.recipes` (ni `expand_consumption` ni `preparation_unit_cost`) —
sólo lee `OrderItem.unit_cost_micros`, que ya está congelado por
`app.orders.service._freeze_item_consumption` al vender. `grep -rn "app.recipes"
app/analytics/` no devuelve nada.

---

## 6. Qué encontré al caminar `GET /admin/sales?group_by=employee` y el «cierre de mesero»

**No construí un segundo reporte.** «Cobro por mesero» ya está: `GET /admin/
sales?group_by=employee` agrupa por `charged_by_employee_id`
(`app.reports.service._group_key`), y `GET /admin/employees/{id}/activity`
(`app.shifts.service.employee_activity` → `app.shifts.activity_metrics.
employee_sales_metrics`) da el «cierre de mesero» completo: ventas netas,
comandas, `avg_ticket`, anulaciones (cantidad, monto, % de ventas, después de
cuenta, en efectivo, walkouts), descuentos, cortesías (con costo teórico),
reimpresiones, `sent_at_payment_pct`, y propinas por medio (efectivo, tarjeta,
transferencia, otro).

**Lo que la spec sugería como posible falta —"la propina por mesero al lado de
la venta"— YA ESTÁ**: confirmé leyendo `app.reports.service.aggregate_sales`
que cuando `group_by == "employee"` el bucket acumula `tips` igual que
`gross`/`tax` (no hay un `continue` temprano como sí lo hay para
`group_by == "method"`), así que `GET /admin/sales?group_by=employee` YA
devuelve la propina junto a la venta, por mesero. No hacía falta agregar nada
para ese caso puntual.

**Gap real que SÍ encontré** (van a `gaps`, no al código — `app/reports/` no es
mi territorio):

1. **`employee_sales_metrics.sales` no desglosa por MEDIO DE PAGO.** Tiene
   `net`/`orders`/`avg_ticket`, pero no `{cash, card, transfer, ...}` como sí
   tiene la sección de propinas del mismo esquema. Cruzar empleado × medio hoy
   exige dos llamadas (`GET /admin/sales?group_by=employee` para el total por
   empleado, sin medio, y `GET /admin/employees/{id}/activity` para el
   detalle sin medio) — ninguna da las dos dimensiones juntas.
2. **`void_pct` y `sent_at_payment_pct` en `app.shifts.activity_metrics` son
   `float` de Python** (`void_amount / sales_net`, `statistics.fmean(...)`),
   no enteros en puntos básicos. Es plata/porcentaje calculado con `float` —
   exactamente lo que `AGENTS.md` prohíbe — pero vive en `app/shifts/`, no en
   mi territorio; no lo toqué.
3. **No hay una forma de listar "las comandas de este mesero"** directamente
   (sólo agregados): `employee_sales_metrics` cuenta `orders_count` pero no
   expone los `order_id`. Si el "cierre de mesero" necesita el detalle
   comanda por comanda, no está.

---

## 7. Qué NO toqué

- **`app/inventory/service.py::_variance_level`**: no se importa, no se llama,
  no se reimplementa. `tests/analytics/test_sustained.py::
  test_variance_level_semaphore_is_untouched_by_this_territory` y
  `tests/audit/test_analytics_invariants.py::
  test_analytics_module_never_imports_or_redefines_variance_level` lo prueban
  por código fuente (ni `def _variance_level` ni una llamada `_variance_level(`
  aparecen en `app/analytics/service.py`, y tampoco hay ningún `import` de
  `app.inventory.service`). `tests/audit/test_analytics_invariants.py::
  test_variance_level_semaphore_keeps_its_published_contract` además prueba,
  por HTTP, que `GET /admin/variance?count_id=` sigue devolviendo `level` en
  `{green, yellow, red}` con normalidad.
- **`app/inventory/`, `app/recipes/`, `app/orders/`**: ninguno de los tres
  tiene un archivo tocado por mí (`git diff --stat` confirmado antes de
  cerrar). Todo lo que necesité de esos tres dominios está publicado en sus
  `hooks.py`/esquemas, o es una lectura de modelo de sólo lectura (mismo
  patrón que `app.reports.service` ya usa con `Order`/`FiscalDocument`/
  `Product`/`Table`/`Zone` de otros dominios).
- **`app/purchases/`**: no lo toqué (esa excepción es de T2, D-2). Sí LEÍ
  `Supplier`/`Ingredient` para confirmar que `lead_time_days` ya vive en
  `Ingredient` (no en `Supplier`, donde lo esperaba mi mandato original) — así
  que reposición sugerida no necesitó ningún gap ahí.
- **`app/main.py`, `app/core/models_registry.py`, `app/core/features.py`**: sin
  cambios. Las dos claves que uso (`analytics.menu_engineering`, `inventory.
  replenishment`) y la que reutilizo (`inventory.variance`) ya estaban en el
  catálogo.
- **`app/reports/`, `app/stores/`**: sin cambios (sólo lectura, y ni eso de
  `app/stores/` — no necesité nada de ahí más que `Store` como tipo).

---

## 8. Comandos de verificación corridos (resultado literal)

**Ronda 1** (30 tests, antes del ajuste de iteración 2):

```
$ cd backend && TMPDIR=/tmp/pt-backend-analitica python -m pytest tests/analytics tests/audit/test_analytics_invariants.py -q
..............................                                           [100%]
30 passed, 55 warnings in 80.37s (0:01:20)

$ cd backend && python -m mypy app
Success: no issues found in 147 source files

$ cd backend && python -m alembic heads
0020 (head)
```

**Ronda 2** (33 tests, después del ajuste C3/H-3 de §0 — 30 anteriores + 3
nuevos de `count_id` opcional):

```
$ cd backend && TMPDIR=/tmp/pt-backend-analitica python -m pytest tests/analytics tests/audit/test_analytics_invariants.py -q
.................................                                        [100%]
33 passed, 61 warnings in 90.93s (0:01:30)

$ cd backend && python -m mypy app
Success: no issues found in 147 source files
```

(Los warnings son `InsecureKeyLengthWarning` de PyJWT sobre el secreto corto de
la fixture de test — preexistentes en toda la suite, no introducidos acá. No
volví a correr `alembic heads`: este ajuste no tocó ninguna migración, la
cadena sigue exactamente igual que en la ronda 1.)

**No corrí la suite completa** (`pytest -q` sin acotar) ni `npm run build`: es
el paso del orquestador, en serie, con el árbol quieto.

---

## 9. `gaps`

1. **D-1, discutible pero construido tal cual**: mido «sostenido» sobre la
   brecha de food cost DE TODA LA SEDE (real % de ventas netas − teórico % de
   ventas netas), reconstruyendo esa brecha ventana por ventana porque
   `app.inventory.hooks` no publica una función de ventanas históricas de food
   cost real (sólo `last_applied_full_count_at`, singular). Construí lo que
   D-1 dice; mi objeción, si el Maestro la quiere discutir: sería más robusto
   que `app.inventory.hooks` publicara esto directamente, para que este
   archivo deje de necesitar espejar una fórmula ajena (riesgo de divergencia
   silenciosa si esa fórmula cambia — ver §1).
2. **El umbral rojo de "sostenido" reutiliza `StoreInventorySettings.
   variance_red_threshold_bp`** (misma sede, mismo número por defecto que
   describe SPEC-NEGOCIO §5.4) en vez de una columna de configuración propia.
   Es una decisión razonada (§1), no un atajo, pero declarada para que el
   Maestro la revise: si algún día "sostenido" necesita su PROPIO umbral
   (distinto del de varianza por conteo), hace falta una tabla de
   configuración propia de `analytics` — hoy no existe ninguna.
3. **`app.shifts.activity_metrics.employee_sales_metrics` no desglosa las
   ventas del mesero por medio de pago** (§6, gap 1) — cruzar empleado × medio
   hoy necesita dos llamadas. No es mi territorio (`app/shifts/`), lo declaro
   para quien construya la pantalla de "cierre de mesero" completa.
4. **`app.shifts.activity_metrics` usa `float`** para `void_pct` y
   `sent_at_payment_pct` (§6, gap 2) — ajeno a mi territorio, declarado porque
   lo encontré caminando el código que la misión me pidió recorrer.
5. **Varianza por plato puede dejar valor "no atribuido"**
   (`unattributed_variance_value` en la respuesta): si un insumo con varianza
   no tuvo NINGÚN movimiento `cause=sale, ref_type=order_item` en la ventana
   (por ejemplo, todo su consumo fue vía una preparación por lote, no vía venta
   directa), esa porción de la varianza no se puede repartir entre platos y
   queda declarada aparte, nunca escondida ni forzada a un reparto arbitrario.
   Es el límite honesto de "estimación prorrateada" que pide §5.4, no un
   defecto a arreglar.
6. **Rendimiento no evaluado a escala**: `menu_engineering` llama
   `compute_order_totals` una vez POR COMANDA PAGADA del período (para no
   reimplementar el prorrateo de descuento). En un período con miles de
   comandas esto es O(comandas) consultas — correcto, pero no optimizado. Si
   se vuelve un problema real, la solución NO es reimplementar `compute_
   totals` en batch (segunda matemática), sino que `app.orders` publique una
   agregación de sólo lectura en su `hooks.py`.
7. **`replenishment` usa una ventana fija de 30 días** para el consumo
   promedio (`REPLENISHMENT_LOOKBACK_DAYS`), sin configuración por sede. Si
   una sede quiere calibrar esa ventana, hoy no hay dónde — mismo criterio que
   el gap 2 (necesitaría una tabla de configuración propia de `analytics`, que
   hoy no existe).
