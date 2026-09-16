# Auditor de costo e inventario — pedido 2a

**Rol**: auditor (invariantes ejecutables). No construí funcionalidad y no
arreglé código ajeno: lo rompí y lo reporto.
**Territorio escrito**: `backend/tests/audit/**` y `frontend/src/audit/**`.
Nada más se tocó — ni `app/`, ni otros directorios de `tests/`, ni
`frontend/src/features/`, ni `docs/`.
**Fecha**: 2026-09-16. **Ronda 2** (actualiza el informe de la ronda 1; no lo
duplica). **Base**: 2a construido por `backend-inventario`, `backend-recetas`,
`backend-consumo`, `frontend-recetas` y `frontend-inventario`, con Alembic en
`0010` y los dominios `inventory`/`recipes` montados en `app/main.py`.

---

## 0. Qué cambió en la ronda 2 (leer esto primero)

La ronda 1 cerró con **dos bloqueantes abiertos** y el veredicto «no se
entrega». Los dos están **cerrados y verificados**:

| | Ronda 1 | Ronda 2 |
|---|---|---|
| **B-1** — la nota «vuelve» no devolvía nada al inventario, y el esquema de entrada no tenía dónde decirlo | **rojo** | **verde** — `app/fiscal/schemas.py:178` agrega `NoteLineIn.returns_to_stock` (default `True`, con el razonamiento de §3.5 escrito en el propio campo) y `app/fiscal/service.py:865-878` llama `reverse_item_consumption` por línea. |
| **B-2** — un costo real por unidad base se publicaba como `0` con origen `official`/`estimated` | **rojo** | **verde** — `app/recipes/service.py:546, 598-599, 659` pasan a `format_cost_micros`; `frontend/src/lib/money.ts` gana `formatCOPDecimal` y `components/CostValue.tsx` lo usa sin pasar por `Number()`. |

Y se cerraron de paso tres observaciones: **O-2** (`CostValue` duplicado — hoy
`features/recipes/costDisplay.tsx:19` re-exporta el compartido), **O-3** (dos
convenciones de costo entre `inventory` y `recipes` — hoy una sola) y, a medias,
la causa de fondo: `app/core/quantity.py:31-53` documenta ahora **cuál de las
dos funciones de borde va en cada campo**, que es la regla que faltaba.

### Lo que hice yo en esta ronda, y con qué autorización

1. **Re-fijé ocho aserciones al valor y no al tipo** (`test_cost_invariants.py`
   líneas 157, 205, 209, 218, 221, 235, 261 y 279 de la ronda 1). El
   orquestador decidió que todo costo publicado por `recipes` pasa a texto
   decimal en pesos, igual que el de `inventory`; esas ocho fijaban los mismos
   campos como enteros y se iban a poner rojas **por el cambio de tipo, no por
   un defecto**. Ahora comparan con `Decimal(str(...)) == Decimal("…")`. **No
   cambié ningún número esperado ni aflojé ningún mensaje**, y el docstring de
   cada test afectado dice que el cambio fue decisión del orquestador y por qué.
2. **Endurecí el guard del cero mudo** (ronda 1, líneas 516 y 524). Con strings,
   `fila["unit_cost"] == 0` es **falso siempre** —incluso con el campo en
   `"0"`—, así que la aserción escrita contra enteros se habría convertido en un
   test que no puede fallar, que es peor que no tenerlo. Ahora exige
   `Decimal(...) != 0` cuando el campo no es `None` y el origen no es `none`, y
   además fija los dos valores exactos (`"0.003"`/g y `"0.3"` la ficha), que es
   lo que de verdad prueba que no hubo redondeo.
3. **Sumé dos invariantes nuevos, uno por bloqueante**, que hubieran hecho ruido
   antes de que el bloqueante existiera (§3 los explica).
4. **No toqué nada más**: ni `MONEY_SECRETS`, ni ningún invariante de
   dispositivo, ni los nombres de `/admin/sales` (O-1 sigue abierta como
   decisión de spec), ni las seis advertencias, que **siguen rojas a propósito**.
5. **Encontré una advertencia nueva verificando el arreglo de B-2** (A-7): el
   mismo defecto del cero mudo, vivo en `GET /admin/orders`, en el reporte
   hermano del que sí se arregló. La escribí como test rojo, como corresponde.
   No cambia el veredicto: es advertencia, no bloqueante.

---

## 1. Conteo de invariantes y dónde vive cada grupo

### Backend — `backend/tests/audit/**`

| Archivo | Invariantes | De quién |
|---|---:|---|
| `test_cash_invariants.py` | 35 | heredado (1a) |
| `test_sales_invariants.py` | 12 | heredado (1b-1) |
| `test_fiscal_invariants.py` | 18 | heredado (1b-2) |
| `test_notes_refunds_invariants.py` | 9 | heredado (1b-2) |
| `test_privacy_invariants.py` | 13 | heredado (1b-2) |
| `test_reports_invariants.py` | 12 | heredado (1b-2) |
| `test_security_invariants.py` | 42 | 39 heredados + **3 de 2a** |
| `test_migration_invariants.py` | 12 | 8 heredados + **4 de 2a** |
| **`test_cost_invariants.py`** | **21** | **nuevo (2a)** — 19 de la ronda 1 + **2 de la ronda 2** |
| **`test_consumption_invariants.py`** | **29** | **nuevo (2a)** — 28 de la ronda 1 + **1 de la ronda 2** |
| **`test_inventory_invariants.py`** | **25** | **nuevo (2a)** |
| **Total backend** | **228** | 146 heredados + **82 nuevos** |

Dos son parametrizados (`min_stock` con 4 valores; las cuatro funciones
apagadas), así que la corrida ejecuta más casos que funciones.

Qué defiende cada archivo nuevo:

- **`test_cost_invariants.py`** — la aritmética del costo: rendimiento
  (`apply_yield`, ceil), costo con origen, propagación insumo → preparación →
  plato, food cost sobre el precio **neto**, versionado de la ficha y snapshot,
  cantidades sin `float` (propiedad sobre 1.000 casos con
  `random.Random(20260915)`), `min_stock > 0`, **el tipado publicado de todo
  campo de costo (nuevo en la ronda 2)** y lo que ganan los reportes que ya
  existían.
- **`test_consumption_invariants.py`** — el consumo al enviar: descuento único
  por los dos modos, los tres caminos (vender / regalar / comer),
  `recipe_effect` en sus tres formas, el `waste_stub` que 1b dejó abierto, el
  espejo de la nota «vuelve» **y su contrario, la nota «se usó» (nuevo en la
  ronda 2)**, el ciclo de preparaciones de tres saltos, el cambio de modo con
  lotes abiertos, la idempotencia de la producción rápida, las cuatro flags
  encendidas **y** apagadas, la cobertura de recetas, las unidades sospechosas,
  la fecha operativa a las 00:30 y la cascada al sustituto.
- **`test_inventory_invariants.py`** — el libro: una sola escritura (barrido de
  AST sobre `app/`), causa enumerada nunca inferida de un texto, atribución con
  FK real, stock negativo que no bloquea, «negativo» ≠ «bajo mínimo» ≠
  «agotado», mermas (tipos, PIN, KPI sin datos, pico de 1,5×), idempotencia y
  carrera real con `race_env`, baja lógica con auditoría, libro append-only,
  flags apagadas, aislamiento por organización, forma única del error y la
  coherencia entre los dominios que construyó este pedido.

### Frontend — `frontend/src/audit/**`

| Archivo | Invariantes | De quién |
|---|---:|---|
| `security.test.ts` | 8 | heredado (1a) |
| `sales.test.ts` | 13 | heredado (1b-1) |
| `fiscal.test.ts` | 15 | heredado (1b-2) |
| **`inventory.test.ts`** | **15** | **nuevo (2a)** |
| **`cost-display.test.tsx`** | **5** | **nuevo (2a)** |
| **Total frontend** | **56** | 36 heredados + **20 nuevos** |

`inventory.test.ts` corre en `environment: node` y audita el **código fuente**
(una sola matemática, sin conversión de escala en el cliente, `null` ≠ `0`, el
operador sin costos, causa como lista cerrada, negativo ≠ agotado).
`cost-display.test.tsx` es el único que monta React: la regla «nunca un cero
mudo» sólo se puede probar de verdad mirando lo que el dueño lee en pantalla —
y fue el que dejó B-2 imposible de discutir.

**Total general: 284 invariantes ejecutables (228 backend + 56 frontend), de
los cuales 102 son nuevos de 2a.**

---

## 2. El checklist de la spec, ítem por ítem

`features/fase-2-costo-inventario/spec.md § Verificación del pedido` es
vinculante. Esta es la tabla que hay que leer para decidir si se entrega.

| # | Ítem del checklist | Test que lo defiende | Estado |
|---|---|---|---|
| 1 | Con `catalog.recipes` apagada, vender funciona como en 1b y `unit_cost` queda `null` con origen `none`, nunca `0` (flag en los dos estados) | `test_consumption::test_with_catalog_recipes_disabled_the_sale_works_exactly_like_in_1b`, `…_with_inventory_perpetual_disabled_the_cost_is_still_frozen_but_nothing_moves`, `…_with_catalog_preps_disabled_the_quick_production_is_refused`, `test_inventory::test_an_endpoint_of_a_disabled_function_answers_400_feature_disabled` (4 flags), `…_with_inventory_waste_disabled_the_device_cannot_register_waste` | **verde** |
| 2 | Rendimiento aplicado (`qty ÷ yield_pct`), test numérico explícito | `test_cost::test_apply_yield_always_rounds_up_and_never_under_deducts` (100 g al 85 % = **117.648** milésimas, más la propiedad sobre los 100 rendimientos), `…::test_sending_an_item_deducts_the_gross_quantity_not_the_clean_one` (punta a punta, saldo `-117_648` y costo congelado `$1.706`) | **verde** |
| 3 | `recipe_effect` `add`, `remove` y `replace` (un test por cada uno) | `test_consumption::test_a_modifier_with_effect_add_increases_the_consumption`, `…_remove_decreases_…`, `…_replace_swaps_one_ingredient_for_another` | **verde** |
| 4 | El insumo se descuenta **una sola vez**: lote al producir, explotada al enviar, comparando el saldo final | `test_consumption::test_a_batch_preparation_deducts_at_production_and_not_at_send`, `…_an_exploded_preparation_deducts_at_send_and_cannot_be_produced`, `…_the_same_ingredient_ends_at_the_same_balance_by_both_modes` | **verde** |
| 5 | Vender, regalar y comer (`staff_meal`) dejan el inventario **idéntico** | `test_consumption::test_selling_giving_away_and_staff_meal_leave_the_same_inventory` (los tres deltas y la misma causa `sale`), `…_a_courtesy_is_free_for_the_customer_but_never_free_for_the_inventory` | **verde** |
| 6 | Anular un ítem ya enviado resuelve su `waste_stub` (`ingredient_id` **y** `resolved`) y **no repone** | `test_consumption::test_voiding_a_sent_item_resolves_its_waste_stub_and_does_not_replenish`, `…_voiding_an_item_that_was_never_sent_leaves_no_waste_and_no_movement` | **verde** |
| 7 | Una nota «vuelve» revierte el consumo como **espejo exacto** (test de propiedad) | `test_consumption::test_the_mirror_of_a_consumption_reads_the_ledger_not_the_current_recipe` (con la ficha cambiada entremedio), `…::test_a_note_that_returns_the_dish_reverses_the_consumption_end_to_end` (**cierra B-1**) y, nuevo, `…::test_a_note_line_marked_used_returns_nothing_to_the_inventory` | **verde** (era rojo: B-1) |
| 8 | Consumos del mismo insumo en una comanda se **fusionan** en un movimiento | `test_consumption::test_the_same_ingredient_in_one_order_becomes_one_movement` | **ROJO — A-1** |
| 9 | Vender con stock cero o negativo no bloquea; `negativo` y `agotado` disparan alertas distintas | `test_inventory::test_selling_with_zero_or_negative_stock_never_blocks_the_sale`, `…_negative_and_below_minimum_are_two_different_alerts_with_different_messages`, `…_a_sold_out_product_and_a_negative_ingredient_are_not_the_same_signal` | **verde** |
| 10 | Cambiar de modo con lotes abiertos los cierra con `count_adjustment` y exige PIN de administrador | `test_consumption::test_switching_out_of_batch_closes_open_batches_with_a_count_adjustment`, `…_switching_a_batch_preparation_to_exploded_needs_an_admin_pin` | **verde** |
| 11 | Producir con la misma `Idempotency-Key` no duplica el lote ni el descuento | `test_consumption::test_producing_twice_with_the_same_key_creates_one_batch_and_one_deduction`; concurrencia real (dos hilos, `race_env`): `test_inventory::test_two_concurrent_productions_with_the_same_key_leave_one_batch`; merma y ajuste: `test_inventory::test_the_same_idempotency_key_never_registers_two_wastes`, `…_two_adjustments` | **verde** |
| 12 | Preparación que se referencia a sí misma por cualquier camino → `400 PREP_CYCLE` (ciclo de tres saltos) | `test_consumption::test_a_three_hop_preparation_cycle_is_refused` (A→B→C→A), `…_a_preparation_cannot_reference_itself` | **verde** |
| 13 | El costo del plato **propaga** desde la preparación | `test_cost::test_changing_an_ingredient_cost_propagates_to_the_prep_and_to_the_dish` (cadena de tres eslabones; y propagar no crea versión de ficha) | **verde** |
| 14 | Cantidades sin `float`: `0,1 + 0,2 = 0,3` sobre 1.000 casos aleatorios | `test_cost::test_quantities_are_exact_integers_over_a_thousand_random_cases` (`random.Random(20260915)`, conmutativa, asociativa, ida y vuelta por el borde), `…_a_quantity_sent_as_a_json_number_is_refused_at_the_edge`, `…_no_quantity_ever_leaves_the_api_as_a_json_float` | **verde** |
| 15 | La ficha **versiona**: un ítem vendido contra la v1 sigue reportando el costo de la v1 después de guardar la v2 | `test_cost::test_an_item_sold_against_v1_keeps_reporting_v1_cost_after_v2_is_saved`, `…_old_recipe_versions_are_kept_because_sold_items_point_at_them`, `…_saving_a_recipe_against_a_stale_version_is_refused` | **verde** |
| 16 | `min_stock <= 0` → `400 MIN_STOCK_REQUIRED` | `test_cost::test_an_ingredient_cannot_be_created_with_a_min_stock_of_zero_or_less` (4 valores), `…_an_existing_ingredient_cannot_be_patched_down_to_a_zero_threshold` | **verde** |
| 17 | Sesión de dispositivo: ninguna respuesta contiene `cost` ni `margin`, con los dominios nuevos montados | heredados `test_security::test_openapi_of_catalog_and_shifts…` (~449), `…orders_kitchen_payments_and_documents…` (~832), `…the_new_1b2_routes…` (~1475) **+** `…the_new_2a_routes_declares_no_cost_fields`, `…no_device_response_of_2a_carries_cost_margin_or_recipe_version`, `…a_device_session_never_reaches_the_admin_routes_of_cost_and_inventory` | **verde** |
| 18 | Zona horaria: un consumo a las 00:30 queda sellado con el día del turno | `test_consumption::test_a_consumption_at_half_past_midnight_is_stamped_with_the_shift_day` (05:30 UTC = 00:30 Bogotá, corte 06:00 → día operativo del 15, no del 16) | **verde** |
| 19 | Admin en 1024 px y POS en 375 px sin scroll horizontal; foco visible; contraste AA | — | **no cubierto** (ver §5) |
| 20 | Typecheck, suite completa y build, una vez, en serie, con el árbol quieto | — | **no me corresponde** (paso del orquestador; mi `mypy app` y mi `tsc --noEmit` corrieron: los dos limpios) |

### Ítems del mandato que no están en el checklist de la spec

| Ítem | Test | Estado |
|---|---|---|
| Migraciones `0001 → 0010` desde cero, `downgrade base` limpio, conteo de tablas | `test_migration::test_the_chain_reaches_the_three_migrations_of_cost_and_inventory` (`test_migration_invariants.py:391`, head **`0010`** — `backend-consumo` amplió la `0010` con `order_items.unit_cost_micros` en vez de crear una `0011`, justamente para no mover el head), `…the_migration_chain_builds_exactly_the_tables_of_the_models`, `…every_migrated_table_has_exactly_the_columns_of_its_model`, `…downgrading_to_base…` | **verde** |
| `waste_stubs.ingredient_id` con FK real; el ítem con `unit_cost`/`recipe_version`/`cost_source` | `test_migration::test_the_waste_stub_points_at_a_real_ingredient_with_a_foreign_key` | **verde** |
| El libro defendido por `CHECK` en la base (XOR, cantidad ≠ 0, `min_stock`) | `test_migration::test_the_ledger_is_defended_by_check_constraints_in_the_database` | **verde** |
| El seed corre **dos veces** sin duplicar y deja una base que ejercita el camino nuevo | `test_migration::test_the_development_seed_runs_twice_without_duplicating_and_can_exercise_2a` | **verde** |
| `record_movement` es la única escritura del libro | `test_inventory::test_no_module_writes_a_stock_movement_outside_record_movement` (AST sobre todo `app/`) | **verde** |
| La forma del error (`400` con acción correctiva, nunca `500`, carreras en `409`) | `test_inventory::test_every_business_error_of_this_phase_has_exactly_one_shape` (6 casos) | **verde** |
| `GET /admin/sales` gana costo teórico, margen bruto y % costeado; `null` y no `0` sin ventas costeadas | `test_cost::test_the_sales_report_gains_theoretical_cost_gross_margin_and_costed_share`, `…_a_period_without_any_recipe_reports_null_not_zero` | **verde** |
| `GET /admin/orders` gana las cortesías a costo | `test_inventory::test_the_admin_orders_report_values_courtesies_at_cost` (el campo existe y valora) | **verde** |
| …y esa valoración no pierde el costo sub-peso | `test_cost::test_the_courtesies_of_admin_orders_do_not_lose_the_sub_peso_cost` (**nuevo, ronda 2**) | **ROJO — A-7** |
| `GET /admin/employees/{id}/activity` gana las cortesías a costo | `test_cost::test_the_employee_activity_report_gains_courtesies_at_cost` | **ROJO — A-2** |
| Costo con origen, **nunca un cero mudo**, también por unidad base | `test_cost::test_a_real_cost_below_one_peso_is_never_reported_as_zero` (**cierra B-2**); `frontend/src/audit/cost-display.test.tsx` (5 casos, los 2 de B-2 incluidos) | **verde** (era rojo: B-2) |
| Ningún campo de costo de `inventory`/`recipes` tipado como número en el contrato publicado | `test_cost::test_no_cost_field_of_inventory_or_recipes_is_typed_as_an_integer` (**nuevo, ronda 2**) | **verde** |
| Un solo camino de consumo con cascada al sustituto | `test_consumption::test_the_substitute_cascade_splits_the_whole_quantity_of_the_line` | **ROJO — A-3** |
| Una función apagada no habla por otra pantalla | `test_inventory::test_with_inventory_perpetual_disabled_today_reports_no_inventory_alerts` | **ROJO — A-4** |
| Ningún reporte revalora el pasado con la carta de hoy (§11.2), aplicado a la cobertura de recetas | `test_consumption::test_the_coverage_report_answers_about_the_past_not_about_todays_recipe`, `…_uses_the_frozen_product_name`, y el heredado `test_reports::test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale` | **ROJO — A-6** |
| El frontend no deriva plata ni cantidades; `null` ≠ `0`; el operador sin costos; causa como lista cerrada | `frontend/src/audit/inventory.test.ts` (15) | **verde** |

**Resumen: 0 bloqueantes, 7 advertencias (A), 8 observaciones (O).**
Quedan **8 rojos en backend** y **0 en frontend**, todos advertencias escritas
como rojo a propósito. A-7 es **nueva de esta ronda** y salió de verificar que
el arreglo de B-2 estuviera completo; no lo estaba en el reporte hermano.

---

## 3. Los dos invariantes nuevos de la ronda 2

Los dos existen por la misma razón: un bloqueante se cierra mal con tanta
facilidad como se abre, y el arreglo no puede quedar defendido sólo por el test
que lo descubrió.

### N-1 — `test_consumption::test_a_note_line_marked_used_returns_nothing_to_the_inventory`

`backend/tests/audit/test_consumption_invariants.py:638`. Es **el espejo del
rojo de B-1**. §3.5 no dice «una nota devuelve al inventario»: dice «por línea
"se usó" (**no vuelve al inventario**) o "vuelve"». El arreglo de B-1 se pasa de
largo revertiendo *toda* línea que entre en la nota, y el resultado sería peor
que el bug original: el plato que el cliente **se comió** volvería al stock
teórico y 2b lo leería como sobrante permanente del mismo insumo. Un solo test
que mira el caso «vuelve» no distingue «lo llama cuando corresponde» de «lo
llama siempre».

Dos aserciones, porque el saldo solo no alcanza: además del saldo (que tiene que
quedarse donde lo dejó la venta), el libro no puede tener **ningún** movimiento
`note_return` para ese insumo — un movimiento de reversión compensado por otro
lado daría el mismo saldo y dejaría el libro mintiendo (§5.1).

**Verde**: `app/fiscal/service.py:865` filtra por `line.used and
line.returns_to_stock`, que es exactamente la lectura correcta de §3.5.

### N-2 — `test_cost::test_no_cost_field_of_inventory_or_recipes_is_typed_as_an_integer`

`backend/tests/audit/test_cost_invariants.py:619`. Es **el espejo del rojo de
B-2**, y barre el **esquema**, no la respuesta. El rojo de B-2 miraba un valor
concreto (la sal a $0,003/g); este mira el contrato: recorre los 31 esquemas
Pydantic de `app.inventory.schemas` y `app.recipes.schemas`, se queda con toda
propiedad llamada `cost` o `*_cost` (regla de nombre deliberadamente amplia,
para cubrir el campo de costo que se agregue mañana sin tocar el test; excluye
los `clear_*`, que son banderas, y los `*_pct`, que son porcentajes) y exige que
el tipo declarado sea `string` y **nunca** `integer` ni `number`.

Por qué el esquema y no la respuesta: una respuesta puede traer un valor que no
delata la escala —`5` es un costo plausible en pesos y un costo absurdo en
micros—, el tipo declarado no. Los dos modos en que B-2 se manifestó (pesos
enteros redondeados, o micros crudos filtrándose) son los dos un `integer` en el
contrato.

Dos detalles que lo hacen valer:

- **También audita por anotación de Pydantic**, no sólo por OpenAPI. Seis
  esquemas de respuesta de estos dominios (`StockRowOut`, `StockMovementOut`,
  `WasteAdminOut`, `WasteOut`, `ProduceOut`, `AdjustmentOut`) **no llegan al
  OpenAPI** porque sus rutas devuelven `Any` para poder servir `format=csv`
  (`app/inventory/router.py:85, 172, 198, 219, 256, 287`). Un barrido sólo sobre
  el OpenAPI no miraría justo donde el contrato está menos declarado. Esto es
  también la observación **O-9**, abajo.
- **No puede pasar por vacío**: exige que el barrido haya tocado diez campos
  nominados (`IngredientOut.cost`, `ProductRecipeOut.theoretical_cost`,
  `StockRowOut.cost`, …). Si alguien renombra un esquema, el test se rompe en
  vez de dejar de mirar en silencio.

El snapshot `order_items.unit_cost` queda **fuera a propósito** y sigue siendo
entero de pesos: es plata de venta ya cerrada (`app/core/money.py`), no un costo
por unidad base. Esa distinción es la que `app/core/quantity.py:31-53` dejó
escrita en esta ronda, y las tres aserciones de
`test_cost_invariants.py:121, 309, 320` la fijan por el otro lado.

---

## 4. Hallazgos

Los dos bloqueantes de la ronda 1 están cerrados (§0). Las seis advertencias
siguen abiertas, **rojas a propósito**, sin bajar de severidad. Verifiqué en
esta ronda que ninguna se movió, leyendo el código, no sólo el resultado.

### A-1 (advertencia) — Los consumos del mismo insumo en una comanda no se fusionan

**Regla que rompe.** §5.3 y el checklist, literal: «consumos del mismo insumo en
una comanda se **fusionan** en un movimiento».

**Evidencia.** `backend/app/orders/service.py:1119-1120` escribe cada consumo con
`ref_type="order_item"` / `ref_id=item.id`, y la fusión de
`backend/app/inventory/hooks.py:94-108` junta por
`(org, sede, insumo, cause, ref_type, ref_id)`. La clave es el **ítem**, no la
**comanda**: dos platos distintos que comparten el aceite dejan dos renglones.
El comentario de `app/orders/service.py:1040-1044` declara esta decisión (fundir
sólo los componentes de un combo dentro de un mismo ítem).

**Cómo reproducirlo.**
`test_consumption_invariants.py::test_the_same_ingredient_in_one_order_becomes_one_movement`
→ `el mismo insumo dejó 2 movimientos en una sola comanda`.

**Riesgo y mitigación.** El saldo es correcto (`-50_000` en el test): no se
pierde ni se duplica nada. Lo que se pierde es la unidad de análisis: el
movimiento «por insumo y por comanda» es con lo que 2b explica una varianza, y
un servicio de 120 comandas × 8 líneas deja el libro con una fila por línea.
Mitigación disponible: agrupar en la lectura. Cerrarlo de verdad es cambiar la
clave de fusión a `ref_type="order"` / `ref_id=order.id` — y ahora **cuesta más
que en la ronda 1**, porque el cierre de B-1 sumó un tercer lector por ítem:
`_resolve_waste_stub`, `reverse_item_consumption` (`app/orders/hooks.py:152`) y
el filtro por línea de `app/fiscal/service.py:865`.

---

### A-2 (advertencia) — `GET /admin/employees/{id}/activity` no ganó las cortesías a costo

**Regla que rompe.** Contrato de la API del pedido: «`GET /admin/employees/{id}/
activity` gana las cortesías a costo»; §10, «anulaciones, cortesías, descuentos:
n, $, % de ventas de la persona…».

**Evidencia.** `backend/app/shifts/schemas.py:436-438` —
`EmployeeActivityCourtesies` sigue siendo `{n, amount}`, con `amount` a precio
de venta. `GET /admin/orders` sí ganó `courtesies_theoretical_value`
(`app/orders/service.py:2037`) y `GET /admin/sales` ganó su costo teórico
(ahora acumulado en micros y redondeado una sola vez,
`app/reports/service.py:367`), pero el informe **por persona** no.

**Cómo reproducirlo.**
`test_cost_invariants.py::test_the_employee_activity_report_gains_courtesies_at_cost`
→ imprime todas las claves del informe; no hay ninguna de costo teórico.

**Riesgo y mitigación.** Una cortesía valorada al precio de la carta exagera lo
que el restaurante regaló, que es justamente la cifra con la que se habla con
una persona. Mitigación: el dato existe a nivel de comanda; hay que agregarlo al
informe por persona. **Es un archivo huérfano**: `app/shifts/**` no estuvo en el
territorio de ningún agente de 2a (`docs/ESTADO.md § Dónde retomar 11.2`).

---

### A-3 (advertencia) — La cascada al sustituto se resuelve sobre una unidad y después se multiplica

**Regla que rompe.** §4.1: «sustituto opcional con **un solo camino de consumo**
y cascada… (en la referencia dos caminos dejaron la leche entera en −4 y la
deslactosada en +19)».

**Evidencia.** `backend/app/recipes/hooks.py:92-94` llama
`resolve_consumption_target(db, ingredient, qty_final)` con la cantidad de **una
unidad** del plato, y recién en `app/recipes/hooks.py:261`
(`qty_total = qty_unit * qty`) multiplica por la cantidad vendida. La cascada,
por lo tanto, nunca ve la cantidad total.

**Cómo reproducirlo.**
`test_consumption_invariants.py::test_the_substitute_cascade_splits_the_whole_quantity_of_the_line`
— 10 g de leche entera en stock, sustituto deslactosada, una comanda de 3 platos
× 4 g = 12 g. Esperado: entera `0`, deslactosada `-2.000`. Observado: entera
`-2.000`, deslactosada `0`.

**Riesgo y mitigación.** La suma total consumida es exacta (el test lo verifica
aparte), así que no se pierde inventario. Lo que sale mal es **cuál** insumo
queda negativo: la alerta de negativo apunta al principal cuando el que de
verdad se consumió de más es el sustituto, y el sustituto queda sobrevalorado
para siempre. Es la forma —aunque no la magnitud— del bug de la referencia.
Mitigación: por ahora sólo afecta a los insumos con sustituto configurado (hoy,
la leche del seed).

---

### A-4 (advertencia) — Con `inventory.perpetual` apagada, «Hoy» alerta igual sobre insumos bajo mínimo

**Regla que rompe.** §11.19 y `AGENTS.md`: «toda función opcional vive detrás de
su flag, **que hace cumplir el backend**», probada encendida **y apagada».

**Evidencia.** `backend/app/reports/service.py:617` `_low_stock_alerts`, `:624`
`_negative_stock_alerts`, `:631` `_prep_alerts` y `:638` `_uncosted_products`
sólo preguntan por `find_spec_safe` (¿existe el módulo?), nunca por la flag. Con
`inventory.perpetual` apagada no hay libro, así que **todos** los insumos están
en cero y **todos** caen bajo su mínimo.

**Cómo reproducirlo.**
`test_inventory_invariants.py::test_with_inventory_perpetual_disabled_today_reports_no_inventory_alerts`
→ con dos insumos creados y la flag apagada, `ingredients_below_min` trae los
dos. Con el seed de desarrollo (6 insumos) y un perfil `basic`, «Requiere tu
atención» abre con seis alarmas que el restaurante no puede resolver porque la
función está apagada.

**Riesgo y mitigación.** No hay pérdida de plata; hay pérdida de señal, que es
como mueren las alertas (§4.1: «55 de 56 productos con el motor de alertas
apagado»). Mitigación: en el perfil `full` —el del seed y el de los tests— la
flag viene encendida, así que no se ve en la demo. Es la mitigación que la hace
**advertencia y no bloqueante**, y también la razón por la que no se va a ver en
el recorrido en navegador si se hace con el perfil de siempre.

---

### A-5 (advertencia) — `GET /admin/today` publica cantidades como enteros crudos en milésimas

**Regla en riesgo.** §11.13, «una sola matemática en el backend; el frontend no
deriva».

**Evidencia.** `backend/app/reports/schemas.py:106-107, 114-115, 125` declaran
`qty_base: int`, `min_stock: int` y `current_stock: int` — enteros en milésimas
de la unidad base (`{'qty_base': 0, 'min_stock': 1000000}` en una respuesta
real). El mismo dato, en `backend/app/inventory/schemas.py:143-144`, viaja como
**texto decimal** (`qty_base: str`, `"117.648"`).

**Riesgo y mitigación.** Hoy no hay bug visible: `frontend/src/features/reports/
TodayPage.tsx:135-165` usa sólo `name` y el conteo. Pero la primera pantalla que
pinte esas cantidades va a mostrar `117648 g` o va a dividir por 1.000 en el
cliente — la escala (`QTY_SCALE`) escrita en dos lugares, y el día que cambie
sólo cambia uno. **Es exactamente el mismo modo de falla que B-2**, con
cantidades en vez de costos, en el único borde que la ronda 2 no unificó: la
ronda 2 arregló el tipo del **costo** en `recipes` y dejó el tipo de la
**cantidad** en `reports`. Mi invariante de frontend (`inventory.test.ts::nadie
multiplica ni divide por la escala`) caza la segunda mitad; la primera se cierra
unificando el borde.

---

### A-6 (advertencia) — «Platos que no descuentan» se recalcula con la carta de hoy, y **rompe un invariante heredado de 1b-2**

**Regla que rompe.** §11.2 y `AGENTS.md`: «precio, impuesto, costo teórico y
receta usada se congelan al vender. **Ninguna consulta de reportes vuelve a la
carta actual para valorar una venta pasada**». Es una regla dura.

**Cómo se descubrió.** No lo escribí yo primero: lo cazó un invariante
**heredado** de 1b-2,
`tests/audit/test_reports_invariants.py::test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale`,
que compara el payload entero de `GET /admin/today` antes y después de tocar la
carta. Con 2a montado, **falla**: el único campo que se mueve es
`products_discounting_nothing[].product_name` (`'Bandeja'` → `'Bandeja (nombre
nuevo)'`). Es exactamente para lo que ese test estaba puesto.

**Evidencia.** `backend/app/recipes/hooks.py:329-366` — `uncosted_products`:

- `:354` llama `expand_consumption(db, store_id=…, product_id=…, qty=1, …)`, es
  decir **vuelve a expandir la ficha vigente hoy** para decidir si una venta
  pasada descontó algo. La respuesta correcta ya está congelada en el ítem
  (`OrderItem.recipe_version`, `app/orders/models.py:296`) y en el libro
  (`StockMovement` con `ref_type="order_item"`).
- `:357` hace `db.get(Product, product_id)` y publica `Product.name`, la carta
  de hoy, en vez de `OrderItem.product_name` (`app/orders/models.py:441`), que
  1b congela justamente para esto.

**Cómo reproducirlo.**
- `test_consumption_invariants.py::test_the_coverage_report_answers_about_the_past_not_about_todays_recipe`
  — vender un plato sin ficha (aparece en cobertura), cargarle la ficha hoy, y
  volver a pedir cobertura: **desaparece**. La venta sigue sin haber descontado
  un solo gramo; el reporte dice que sí.
- `test_consumption_invariants.py::test_the_coverage_report_uses_the_frozen_product_name`
  — renombrar el plato después de venderlo: el reporte muestra el nombre nuevo.
- `test_reports_invariants.py::test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale`
  (heredado, rojo).

**Riesgo y mitigación.** Nadie pierde plata, pero **ningún número de cobertura
es reproducible**: `recipe_coverage_pct` de un período cerrado cambia cada vez
que alguien edita una ficha, y cargar la receta que faltaba borra
retroactivamente la evidencia de que durante una semana no se descontó nada —
que es justamente lo que el reporte existe para mostrar. Cerrarlo es leer el
snapshot (`recipe_version IS NULL` o «sin movimientos con `ref_id = item.id`»)
en vez de re-expandir, y usar el nombre congelado. **De las seis advertencias es
la que más conviene cerrar antes de 2b**: la cobertura de recetas es uno de los
insumos de la varianza, y una varianza calculada sobre una cobertura que se
reescribe sola no se puede defender ante el dueño.

---

### A-7 (advertencia NUEVA de esta ronda) — Las cortesías a costo de `GET /admin/orders` pierden el costo sub-peso: es el defecto de B-2 sobreviviendo en el reporte hermano

**Regla que rompe.** §4.1, «nunca un cero mudo», y `app/core/quantity.py:78-95`:
el redondeo a pesos pasa **una sola vez, al cerrar el total**, nunca por ítem.

**Cómo apareció.** No lo buscaba: lo encontré verificando que el arreglo de B-2
fuera completo. La ronda 2 cambió `app/reports/service.py:154`
(`_document_cost_stats`) para acumular `OrderItem.unit_cost_micros` en vez de
sumar `unit_cost` en pesos, y dejó el razonamiento escrito en su propio
docstring (`:161-171`): «un plato de $0,30 congela `unit_cost=0`; 100 de esos
daban $0 en vez de $30». **El reporte hermano no se cambió.**

**Evidencia.** `backend/app/orders/service.py:2011-2012`:

```python
if i.courtesy_reason is not None and i.unit_cost is not None:
    courtesy_costed_values.append(i.unit_cost * i.qty)
```

`unit_cost` es pesos ya redondeados half-up **por ítem** al enviar
(`app/orders/service.py:1091`). `unit_cost_micros` —el campo correcto, creado en
esta misma ronda para esto— está en la línea siguiente (`:1099`) y no se usa.

**Cómo reproducirlo.**
`backend/tests/audit/test_cost_invariants.py::test_the_courtesies_of_admin_orders_do_not_lose_the_sub_peso_cost`
— 100 porciones de cortesía de un plato de $0,30 de costo real (100 g de sal a
$0,003/g, el costo del propio seed). El snapshot es correcto (`unit_cost=0`,
`unit_cost_micros=300_000`, y el test lo verifica antes de seguir); el reporte
dice `courtesies_theoretical_value: 0`. Real: $30.

**Por qué advertencia y no bloqueante.** El error está acotado a menos de $0,50
por ítem: con platos de miles de pesos es invisible, y muerde sólo con costos
por porción menores al peso. No se pierde inventario ni plata real — se pierde
una cifra de un reporte. Pero `0` no es `null`: la respuesta afirma que valoró
las cortesías y que el valor es cero, que es la definición del cero mudo, y el
campo correcto ya existe a dos líneas de distancia.

---

### Observaciones

**O-1 (sigue abierta, y por decisión del orquestador NO se resuelve en esta
ronda) — Los nombres de `GET /admin/sales` divergen del contrato de la spec.**
El contrato del pedido pide `theoretical_cost`, `gross_margin` y `costed_pct`;
`backend/app/reports/schemas.py:191-193` publica `theoretical_value`,
`gross_contribution` y `recipe_coverage_pct`, y el archivo declara por qué
(`app/reports/schemas.py:21-23`): dos invariantes heredados
(`test_security_invariants.py:1475` y `:832`) barren el OpenAPI de
`/admin/today` y `/admin/sales` buscando `cost|margin|unit_cost|food_cost`. Esos
invariantes son de 1b-2 y defienden una regla de **dispositivo** aplicada a
rutas de **administrador**, que es donde el costo **sí** tiene que estar.
`frontend/src/api/reports.ts:181-193` documenta la divergencia en vez de
arrastrar los nombres de la spec, así que hoy no hay bug: hay una spec que dice
una cosa y un código que dice otra. **No acoté `MONEY_SECRETS` ni renombré
nada** (instrucción explícita de la ronda 2); mi test
`test_the_sales_report_gains_theoretical_cost_gross_margin_and_costed_share`
sigue aceptando **los dos nombres** a propósito. Recomendación sin cambiar:
acotar el barrido a las rutas de dispositivo y devolver los nombres de la spec,
o corregir la spec. Dejarlo así no es una tercera opción.

**O-2 — CERRADA.** `frontend/src/features/recipes/costDisplay.tsx:19` ahora
re-exporta `CostValue`/`COST_SOURCE_LABEL` de `@/components/CostValue` en vez de
tener su propia copia, y lo dice en el docstring.

**O-3 — CERRADA.** Los dos dominios publican el costo de la misma forma
(`format_cost_micros`, texto decimal). Era la causa raíz de B-2.

**O-4 (sigue abierta) — Los insumos no están detrás de ninguna flag.**
`backend/app/inventory/router.py:85` (`GET`), `:102` (`POST`), `:123` (`PATCH`),
`:148` (`DELETE`) y `:317` (`GET /device/ingredients`) no tienen
`require_feature` — las que sí lo tienen son `:182, :208, :226` (`inventory.
perpetual`) y `:262, :298` (`inventory.waste`). Con las cuatro funciones de la
fase apagadas, un administrador puede crear insumos y un dispositivo puede
listarlos. No escriben inventario, así que el riesgo es bajo; pero es lo que
hace que **A-4** se note (el seed carga insumos aunque la función esté apagada).

**O-5 (sigue abierta) — `void_after_send` queda declarada y sin uso.**
`backend/app/orders/service.py:1240-1252` declara la decisión: anular un ítem ya
enviado resuelve el `waste_stub` pero **no escribe ningún movimiento**. Es
defendible (el saldo no cambia), pero deja `MovementCause.VOID_AFTER_SEND` sin
producir nunca, y un reporte de «merma por anulación tras envío» agrupado por
causa devuelve vacío: hay que leerlo de `waste_stubs`. Que 2b lo resuelva junto
con la reclasificación real, o que el reporte lo diga.

**O-6 (sigue abierta) — El KPI de mermas declara un `float` en el contrato.**
`backend/app/inventory/schemas.py:194` — `WasteKpiOut.ratio: float | None`. Hoy
siempre es `null` («sin datos», correcto y probado). Cuando 2b lo llene va a ser
el único número de la fase que viaja como `float` en una API donde todo lo demás
es entero o texto decimal **por decisión explícita del orquestador en esta misma
ronda**. Conviene decidirlo ahora (texto decimal, igual que `food_cost_pct`) y
no cuando ya haya clientes.

**O-7 (sigue abierta) — El conteo de tablas de `docs/ESTADO.md` se cuenta de dos
maneras.** `docs/ESTADO.md:183` anota «53 tablas» para 1b (contando
`alembic_version`) y `:432` «63 tablas» para 2a (sin contarla). Mi invariante
fija **63 tablas de dominio** y lo dice en el mensaje de error, para que la
próxima persona no persiga un fantasma.

**O-8 (sigue abierta) — `IngredientAlertOut` incluye insumos con
`consumption_untracked`.** `backend/app/inventory/hooks.py:192-210` recorre
todos los insumos activos. La sal de mesa (`consumption_untracked=True`,
`app/inventory/seed.py:134`) no tiene receta y por definición **nunca** se
descuenta sola: va a estar bajo mínimo de forma permanente hasta que 2b traiga
compras y conteos. Ruido garantizado en «Requiere tu atención» desde el día uno.

**O-10 (nueva, de esta ronda, y es una observación sobre MI propio test) — el
costo sub-peso se pinta `$ ,003` y no `$ 0,003`, porque mi regex no distingue
las dos cosas.** `frontend/src/lib/money.ts:70-72` omite deliberadamente el cero
de la parte entera cuando hay decimales no nulos, y el docstring (`:47-51`) dice
por qué: «mostrarlo ("$ 0,003") repite, en los dos primeros caracteres visibles,
el mismo patrón "$ 0" del cero mudo». La razón de fondo es mía: mi aserción en
`frontend/src/audit/cost-display.test.tsx:47` usa `/\$\s*0(\D|$)/`, que no puede
distinguir `$ 0` (el cero mudo real) de `$ 0,003` (un costo correcto que empieza
en cero) — y el builder resolvió el conflicto cambiando el formato en vez de la
cifra. **No pierde ni un decimal y el invariante de fondo se cumple**, pero
`$ ,003` no es la forma en que un restaurante colombiano escribe esa cifra, y
—más importante— si alguien más adelante la escribe como `$ 0,003`, que sería
razonable, **mi test se pone rojo sin que haya ningún defecto**. Es una trampa
que dejo señalada en vez de desactivar sola: la aserción correcta es
`/\$\s*0(?![.,]\d)(\D|$)/` (cero mudo sí, cero con decimales no), y cambiarla es
aflojar un guard, que no hago sin que lo decida el dueño de la spec — la misma
razón por la que no toqué O-1. No la cambié tampoco porque la ronda 2 me pidió
explícitamente no aflojar ningún mensaje.

**O-9 (nueva, de esta ronda) — Ocho esquemas de respuesta de `inventory`/
`recipes` no llegan al OpenAPI.** `StockRowOut`, `StockMovementOut`,
`WasteAdminOut`, `WasteOut`, `WasteListOut`, `WasteKpiOut`, `AdjustmentOut` y
`ProduceOut` no aparecen en `components.schemas` porque sus rutas se anotan
`-> Any` para poder devolver tanto JSON como CSV (`app/inventory/router.py:85,
172, 198, 219, 256, 287`; `app/recipes/router.py:165`). El contrato publicado no
describe su respuesta. Importa por dos razones concretas:

- **Los invariantes que barren el OpenAPI buscando campos de costo no pueden ver
  esas rutas**, y dos de ellas son de **dispositivo** (`POST /waste`,
  `POST /preparations/{id}/produce`). El control no queda sin cubrir —
  `test_security::test_no_device_response_of_2a_carries_cost_margin_or_recipe_version`
  las recorre con datos reales y está verde— pero queda cubierto **por un solo
  lado** justo donde el mandato pedía los dos.
- Un cliente generado del OpenAPI no tiene tipos para ellas.

Lo detecté escribiendo N-2, y por eso N-2 audita **también** por anotación de
Pydantic. La salida limpia es la que ya usa el resto de `recipes`
(`app/recipes/router.py:73, 132, 233, 254`): `response_model=` explícito, y el
CSV por una ruta o un parámetro que no cambie la anotación.

---

## 5. Cruces entre agentes que revisé

Lo que no mira nadie porque cada uno respetó su frontera. Revisado de nuevo en
esta ronda, sobre el árbol de la ronda 2.

1. **¿Alguien escribe un `StockMovement` sin pasar por `record_movement`?** No,
   y sigue sin pasar después del cierre de los dos bloqueantes. Verificado con
   el barrido de AST sobre todo `app/`
   (`test_no_module_writes_a_stock_movement_outside_record_movement`, verde).
   **Es la regla que más fácil se viola por comodidad y está cumplida**, incluso
   en el camino nuevo: el cierre de B-1 revierte desde
   `app/orders/hooks.py:152`, que también pasa por el hook.
2. **¿El cierre de B-2 dejó los dos dominios diciendo lo mismo?** Sí, y ahora
   hay un invariante que lo fija (N-2). `app/core/quantity.py:31-53` documenta
   cuál de las dos funciones de borde va en cada campo —`format_cost_micros`
   para costo por unidad base, `micros_to_pesos` para totales de plata de
   venta— que es la regla que faltaba y causó B-2.
3. **¿El frontend quedó alineado con el tipo nuevo?** Sí.
   `frontend/src/api/recipes.ts:94, 142-143, 170` declara los costos como
   `string | null` y `frontend/src/api/inventory.ts` ya lo hacía; `tsc --noEmit`
   pasa limpio y los 56 invariantes de frontend están verdes. Ningún consumidor
   quedó leyendo un `number` que ahora es un `string` — que era el riesgo real
   de un cambio de tipo a mitad de una fase con cinco agentes en paralelo.
4. **¿`micros_to_pesos` se quedó donde tiene que estar?** Sus dos usos sí:
   `app/orders/service.py:1091` (el snapshot congelado del ítem) y
   `app/reports/service.py:367` (el total del bucket, redondeado una sola vez
   sobre `unit_cost_micros` acumulado). Pero **la pregunta completa no es dónde
   se llama, sino quién lee el resultado**, y ahí apareció **A-7**:
   `app/orders/service.py:2011` suma el `unit_cost` **ya redondeado** de cada
   ítem para valorar las cortesías, que es la operación que la ronda 2 eliminó
   de `/admin/sales` por perder plata real. El campo correcto
   (`unit_cost_micros`) está ocho líneas más arriba, en el mismo archivo. Es el
   cruce típico: dos agentes distintos (`backend-consumo` escribe el snapshot,
   `orders` lo lee) y nadie mira el par.
5. **¿`expand_consumption` devuelve lo que `send` espera?** Sí. El contrato
   publicado (`app/recipes/hooks.py:183`) y el consumidor
   (`app/orders/service.py:1053`) coinciden en firma y en semántica.
   **Salvedad**: la cascada al sustituto se resuelve dentro de
   `expand_consumption` sobre una unidad (A-3).
6. **¿El `cost_source` que viaja en la API es el mismo enum que el del
   modelo?** Sí, fijado por
   `test_the_cost_source_of_the_api_is_the_same_enum_as_the_model`, que compara
   `CostSourceLiteral`/`MovementCauseLiteral`/`WasteTypeLiteral` contra
   `CostSource`/`MovementCause`/`WasteType`. El frontend declara los mismos
   cinco orígenes (`components/CostValue.tsx:8`).
7. **¿La superficie nueva filtra costo al operador?** No. Los tres invariantes
   heredados (`test_security_invariants.py` ~449, ~832, ~1475) siguen verdes con
   los dominios nuevos montados, y los tres nuevos de 2a también — ahora que
   `unit_cost` deja de ser `NULL` y además `unit_cost_micros` existe. Ninguno se
   acotó ni se debilitó en esta ronda.
8. **¿El seed deja una base que puede ejercitar 2a?** Sí: insumos +
   preparaciones + fichas, e idéntico al correr dos veces. La lección de 1b-2
   (`app/seed.py` sin rangos, base incapaz de vender) **no se repitió**. Es el
   archivo huérfano que esta vez sí tuvo dueño.
9. **¿2a rompió algún invariante heredado?** Uno, y sigue roto a propósito:
   `test_reports_invariants.py::test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale`
   → A-6. El otro que había en la ronda 1
   (`test_sales_invariants.py::test_voiding_a_sent_item_…`) era una **aserción
   obsoleta por diseño** (exigía `stub.resolved is False` porque 1b no podía
   resolverlo) y se actualizó en la ronda 1; es la única aserción heredada que
   toqué en todo el pedido. Los otros 144 invariantes heredados siguen verdes.
10. **Archivos huérfanos del reparto**: `backend/tests/core/**` verde con el
    contrato numérico (`tests/core/test_quantity.py`, del dueño del contrato);
    `frontend/src/features/auth/**` sin desincronizar del router;
    `frontend/src/features/settings/**` sin configuración nueva de esta fase, así
    que no quedó un campo escrito a medias. El huérfano de B-1 (`app/fiscal/**`)
    **quedó cubierto en esta ronda**; el de A-2 (`app/shifts/**`) sigue sin
    dueño.

---

## 6. Lo que no pude verificar en este entorno

- **Postgres real y el CI.** Todo corrió en SQLite. Quedan sin probar: los tipos
  y enums nativos, el `SELECT FOR UPDATE` del consecutivo, los índices parciales
  y los `409` literales de carrera bajo un motor con bloqueo real. La carrera de
  producción (`test_two_concurrent_productions_with_the_same_key_leave_one_batch`)
  acepta `[201, 201]` o `[201, 409]` porque en SQLite la serialización puede
  resolver la segunda por idempotencia antes de que haya conflicto; en Postgres
  el resultado esperado es `[201, 409]`. **Hay que volver a mirar ese test en el
  CI.**
- **El checklist visual (ítem 19).** «Admin en 1024 px y POS en 375 px sin
  scroll horizontal; foco visible; contraste AA» no está cubierto por ningún
  invariante mío: hace falta un navegador real y un medidor de contraste, no
  Testing Library. Mismo punto abierto que en 1a y 1b.
- **El recorrido en navegador real.** No lo corrí. Ahora que B-2 está cerrado, lo
  que conviene mirar ahí es la **confirmación** del arreglo —Admin → Inventario →
  Insumos tiene que decir «Sal de mesa $ 0,003 estimado» y «Pechuga $ 14,5
  oficial», no `$ 0` ni `$ 15`— y **A-4** (Hoy con `inventory.perpetual`
  apagada, que con el perfil `full` del seed **no se ve**: hay que apagar la flag
  a propósito).
- **La suite completa y el build.** No los corrí, por la regla del pedido: sólo
  `tests/audit`, `mypy app`, `vitest run src/audit` y `tsc --noEmit`. La corrida
  en serie con el árbol quieto es del orquestador. Es el único paso que puede
  confirmar que el cambio de tipo de la ronda 2 no rompió un test de otro agente
  fuera de mi territorio.
- **`GET /admin/waste` con datos de más de dos semanas.** El invariante del pico
  de 1,5× mueve el reloj con la fixture `clock`; no probé el barrido sobre un
  histórico largo ni el `dedupe_key` a lo largo de meses.
- **Rendimiento.** `low_stock_alerts` y `negative_stock_alerts` llaman
  `current_stock` **una vez por insumo** (`app/inventory/hooks.py:199` y `:263`),
  y `_negative_streak` recorre todos los movimientos de cada insumo negativo. Con
  6 insumos no se nota; con 300 insumos y un año de libro, `GET /admin/today`
  hace 300 agregaciones más un recorrido completo por cada negativo. No lo medí y
  no escribí un invariante de rendimiento (no tengo con qué medirlo acá).

---

## 7. Cómo correr lo mío

```bash
# backend (territorio del auditor, nunca la suite completa)
cd backend && TMPDIR=/tmp/pt-auditor-costos python -m pytest -q tests/audit
cd backend && python -m mypy app

# frontend
cd frontend && TMPDIR=/tmp/pt-auditor-costos npx vitest run src/audit
cd frontend && npx tsc --noEmit
```

### Resultado de la corrida de la ronda 2

| Corrida | Resultado |
|---|---|
| `pytest tests/audit` (228 invariantes, **234 casos** con los parametrizados) | **226 verdes, 8 rojos a propósito** |
| `vitest run src/audit` (56 invariantes, 5 archivos) | **56 verdes, 0 rojos** |
| `python -m mypy app` | **limpio** (106 archivos) |
| `npx tsc --noEmit` | **limpio** |

La corrida completa de `tests/audit` tardó 12 min 41 s y cerró en `7 failed,
226 passed`; A-7 se agregó después de esa corrida y se verificó aparte
(`pytest tests/audit/test_cost_invariants.py` → `2 failed, 22 passed`), de ahí
los 8 rojos del total.

**Los dos bloqueantes de la ronda 1 están cerrados y verificados uno por uno:**

| Verificación pedida | Resultado |
|---|---|
| `test_consumption_invariants.py::test_a_note_that_returns_the_dish_reverses_the_consumption_end_to_end` (B-1) | **verde** |
| `test_cost_invariants.py::test_a_real_cost_below_one_peso_is_never_reported_as_zero` (B-2) | **verde** |
| Los 5 casos de `frontend/src/audit/cost-display.test.tsx` | **verdes** |
| `test_migration_invariants.py:391` — `head == "0010"` | **verde** (la `0010` se amplió con `order_items.unit_cost_micros` en vez de abrir una `0011`) |
| OpenAPI de sesión de dispositivo sin `cost`/`margin`/`unit_cost` | **verde** — los 3 heredados (`test_security_invariants.py` ~449, ~832, ~1475) y los 3 de 2a |
| Snapshot `order_items.unit_cost` en pesos enteros (`test_cost_invariants.py:121, 309, 320`) | **verde** |
| Los dos invariantes nuevos de esta ronda (N-1 y N-2) | **verdes** |

**Los ocho rojos, uno por uno:**

| Test | Hallazgo |
|---|---|
| `test_consumption::test_the_same_ingredient_in_one_order_becomes_one_movement` | A-1 |
| `test_cost::test_the_employee_activity_report_gains_courtesies_at_cost` | A-2 |
| `test_consumption::test_the_substitute_cascade_splits_the_whole_quantity_of_the_line` | A-3 |
| `test_inventory::test_with_inventory_perpetual_disabled_today_reports_no_inventory_alerts` | A-4 |
| `test_consumption::test_the_coverage_report_answers_about_the_past_not_about_todays_recipe` | A-6 |
| `test_consumption::test_the_coverage_report_uses_the_frozen_product_name` | A-6 |
| `test_reports::test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale` (**heredado de 1b-2**) | A-6 |
| `test_cost::test_the_courtesies_of_admin_orders_do_not_lose_the_sub_peso_cost` | **A-7 (nuevo)** |

Los siete primeros son **los mismos siete de la ronda 1** (menos los dos
bloqueantes, que se cerraron): ninguno se movió, ninguno bajó de severidad,
ninguna aserción se aflojó. A-5 sigue abierta como advertencia **sin test rojo**
(es un riesgo de contrato, no un comportamiento incorrecto hoy).

---

## 8. Veredicto

### **SE ENTREGA.**

No queda ningún bloqueante. Los dos de la ronda 1 se cerraron **sin tocar una
sola aserción mía**: la única razón por la que toqué ocho aserciones fue el
cambio de tipo que el orquestador decidió, y las reescribí comparando el valor,
con los mismos números y sin aflojar un mensaje. El estándar de 1b-2 se
sostuvo.

Lo que se entrega **con estos ocho rojos abiertos**, y por qué cada uno es
aceptable:

- **A-1** (los consumos del mismo insumo en una comanda no se fusionan) — el
  saldo es exacto; se pierde la unidad de análisis del libro, no plata. **Pero
  cerrarlo se encareció esta ronda**: el arreglo de B-1 sumó un tercer lector
  por ítem.
- **A-2** (`/admin/employees/{id}/activity` sin cortesías a costo) — falta un
  campo de un reporte; el dato existe a nivel de comanda. `app/shifts/**` sigue
  sin dueño en el reparto.
- **A-3** (la cascada al sustituto se resuelve sobre una unidad) — la suma total
  consumida es exacta; lo que sale mal es **cuál** insumo queda negativo. Hoy
  sólo afecta al único insumo con sustituto configurado.
- **A-4** (con `inventory.perpetual` apagada, «Hoy» alerta igual) — pérdida de
  señal, no de plata, y con el perfil `full` del seed no se ve. **Ojo con
  esto en el recorrido en navegador: hay que apagar la flag a propósito o no
  aparece.**
- **A-6** (×3: «platos que no descuentan» se recalcula con la carta de hoy) —
  **es la que más conviene cerrar antes de 2b**, y la única que rompe una regla
  dura (§11.2). La cazó un invariante **heredado**, que es exactamente para lo
  que estaba puesto. Ningún número de cobertura es reproducible mientras siga
  así, y la cobertura alimenta la varianza de 2b.
- **A-7** (las cortesías a costo de `/admin/orders` pierden el costo sub-peso) —
  **nueva de esta ronda**, encontrada verificando que el arreglo de B-2
  estuviera completo. Acotada a menos de $0,50 por ítem; el campo correcto
  (`unit_cost_micros`) ya existe ocho líneas más arriba en el mismo archivo. Es
  el arreglo más barato de los ocho.

Ninguno de los ocho toca plata cobrada, integridad del libro ni exposición de
costo al operador, que son los tres criterios de bloqueo. Los tres están
verificados verdes: `record_movement` sigue siendo la única escritura del libro
(barrido de AST sobre todo `app/`), el snapshot congela y no se revalora, y el
operador no ve un costo ni en el OpenAPI ni en ninguna respuesta real con los
dominios nuevos montados y `unit_cost` ya lleno.

**Lo que el orquestador tiene que decidir aparte, porque no es mío**: **O-1**
(los nombres de `/admin/sales` divergen de la spec porque dos invariantes
heredados de dispositivo alcanzan a una ruta de administrador) y **O-10** (mi
propia aserción de frontend no distingue `$ 0` de `$ 0,003`, y el builder
resolvió el conflicto cambiando el formato a `$ ,003`). Las dos son decisiones
de spec: acotar un invariante o aflojar un guard no lo hace el auditor.

**Y una condición**: la suite completa y el build, una sola vez y en serie con
el árbol quieto, todavía no corrieron. El cambio de tipo de la ronda 2 tocó el
contrato publicado de dos dominios; mi territorio y los dos typechecks están
limpios, pero **el único paso que puede confirmar que ningún test de otro agente
quedó leyendo un `int` que ahora es un `str` es esa corrida**. Se entrega
después de ella, no antes.
