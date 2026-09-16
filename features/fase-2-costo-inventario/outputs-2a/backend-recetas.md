# backend-recetas — Fichas técnicas, preparaciones y motor de costo

Entregable del builder **backend-recetas**, pedido 2a (`features/fase-2-costo-inventario/spec.md`).
Construye el dominio nuevo `app/recipes/**`: fichas técnicas versionadas de los
platos, preparaciones en dos modos (`batch`/`exploded`), el motor de costo que
propaga insumo → preparación → plato, y el `recipe_effect` de las opciones de
modificador.

**Estado de la entrega**: código completo, 33/33 tests de mi territorio en
verde, `mypy app` limpio (106 archivos), migración `0009` probada desde cero
(`upgrade head` y `downgrade -1`) contra una base propia. `app.core.quantity`
(contrato de `backend-inventario`) y el dominio `app.inventory` **ya
convergieron** en el árbol mientras trabajaba (llegaron después de que
empecé): el código de este entregable está escrito contra las firmas
**reales**, no contra un supuesto — incluida la corrección de varios ajustes
finos que sólo se ven al integrar contra el contrato real (ver «Ajustes al
converger» más abajo).

**RONDA 2 (`conflict-002-b2`, ajuste de contrato numérico)**: cerré la mitad
backend del bloqueante — ver «§0. Ronda 2» más abajo, inmediatamente después
de esta nota, antes de las secciones originales (que quedan intactas salvo
por los tipos de costo que cambiaron).

---

## 0. Ronda 2 — costo publicado como texto decimal, no pesos enteros (`conflict-002-b2`)

**Decisión de contrato** (del Maestro, uniforme para `recipes` e
`inventory`): todo costo que sale por la API de `recipes` viaja como
**texto decimal en pesos con precisión completa**
(`app.core.quantity.format_cost_micros`), exactamente como ya lo hacía
`app.inventory.service.ingredient_out` (`cost: str | None`, ver
`backend/app/inventory/service.py:198-207`) desde antes de esta ronda.
`micros_to_pesos` (redondeo half-up a pesos enteros) queda **sólo** para
plata de venta — el snapshot `order_items.unit_cost`, totales de reportes en
pesos — nunca para un costo por unidad base ni para un costo publicado por
este dominio. La escala dejó de vivir en dos lugares con dos reglas de
redondeo distintas.

**Por qué hacía falta**: redondear a pesos ANTES de publicar convertía
cualquier costo por debajo de $1 (una guarnición de sal a $0,003/g, un plato
de $0,30) en `"0"` con `cost_source` distinto de `"none"` — la respuesta
afirmaba conocer el costo y a la vez decía que era cero, exactamente la
combinación que la regla dura «costo con origen, nunca un cero mudo»
prohíbe, y peor que `null` porque `null` al menos se puede detectar. El
mismo redondeo prematuro alimentaba `food_cost_pct`, así que un plato de
$0,30 reportaba `0.00 %` aunque su costo real no fuera cero.

**Cambios exactos**:

1. `app/recipes/schemas.py`: `PreparationAdminOut.unit_cost`,
   `PrepBatchAdminOut.total_cost`/`.unit_cost` y
   `ProductRecipeOut.theoretical_cost` pasan de `int | None` a `str | None`
   (texto decimal, `format_cost_micros`). Docstring de cabecera actualizado
   con la regla nueva. `PreparationDeviceOut`/`ProduceOut` (rutas de
   **dispositivo**) no tocados: siguen sin ningún campo de costo, como exige
   el invariante del OpenAPI de sesión de dispositivo.
2. `app/recipes/service.py`: `preparation_admin_out`, `batch_admin_out` y
   `get_product_recipe` importan y usan `format_cost_micros` en vez de
   `micros_to_pesos`. `None` sigue siendo `None` con `cost_source="none"`:
   nunca `"0"` con origen distinto de `none` — eso no cambió, sólo cambió
   cómo se serializa un costo que SÍ existe.
3. `app/recipes/cost.py::food_cost_pct`: ya no redondea a pesos antes de
   dividir. Fórmula nueva, sobre los micros directamente, sin `float` en
   ningún paso: `(Decimal(cost_micros) * 100 / (Decimal(net_price_pesos) *
   COST_SCALE)).quantize(Decimal("0.01"))`. `None` (nunca `0`) si no hay
   costo o el precio neto no es positivo — invariante intacto. Comentario de
   la fórmula en la cabecera del archivo actualizado.
4. `tests/recipes/_quantity_stub.py`/`conftest.py`: agregué
   `format_cost_micros` al doble de `app.core.quantity` que este directorio
   instala SOLO si el módulo real no es importable (no debería activarse ya
   que `app.core.quantity` convergió de verdad, pero mantenerlo fiel al
   contrato completo evita que un futuro cambio de orden de colección lo
   deje desactualizado).
5. Tests propios actualizados para comparar costo con `Decimal(respuesta[...])`
   en vez de `int` (`tests/recipes/test_cost_propagation.py`), y **dos casos
   nuevos** en `tests/recipes/test_cost_precision.py`: una preparación de sal
   a $0,003/g que publica `unit_cost == "0.003"` con `cost_source ==
   "official"` (no `"0"`), y una ficha de 100 g de esa sal que publica
   `theoretical_cost == "0.3"` con `food_cost_pct == Decimal("0.03")`
   (precio neto bajo a propósito, para que el cociente real no desaparezca
   al redondear a 2 decimales).

**Verificación de esta ronda**: corrí SÓLO lo que me tocaba.

```
cd backend && TMPDIR=/tmp/pt-backend-recetas python -m pytest -q tests/recipes
# 33 passed (31 de antes + 2 casos nuevos de precisión)

cd backend && python -m mypy app
# Success: no issues found in 106 source files

cd backend && TMPDIR=/tmp/pt-backend-recetas python -m pytest -q \
  tests/audit/test_cost_invariants.py::test_a_real_cost_below_one_peso_is_never_reported_as_zero
# 1 passed — el rojo que cerraba esta ronda, sin tocar `tests/audit/**`
```

No toqué `tests/audit/**`, `app/inventory/**`, `app/orders/**`,
`app/core/quantity.py` ni `frontend/**`, como indicó el Maestro. Los gaps
declarados en rondas anteriores (§8 más abajo) no entraron en esta ronda.

---

## 1. Firmas literales de `app/recipes/hooks.py`

```python
@dataclass(frozen=True)
class ConsumptionLine:
    ingredient_id: int | None
    preparation_id: int | None      # sólo si la preparación es modo batch
    qty_base: int                   # positivo; ya con rendimiento y modificadores aplicados
    cost_micros: int | None
    cost_source: CostSource

@dataclass(frozen=True)
class ConsumptionPlan:
    recipe_version: int | None      # None = el plato no descuenta nada (cobertura)
    unit_cost_micros: int | None    # costo teórico de UNA unidad del plato
    cost_source: CostSource
    lines: list[ConsumptionLine]

def expand_consumption(db, *, store_id: int, product_id: int, qty: int,
                       modifier_option_ids: list[int]) -> ConsumptionPlan: ...

def prep_stock_alerts(db, *, store_id: int) -> list[dict[str, Any]]: ...

def uncosted_products(db, *, store_id: int, date_from: date, date_to: date) -> list[dict[str, Any]]: ...
```

`expand_consumption` es **pura**: no escribe nada, nunca llama a
`record_movement`. Nunca lanza y nunca devuelve `0`: con `catalog.recipes`
apagada, o un producto sin ficha ni línea, devuelve
`ConsumptionPlan(recipe_version=None, unit_cost_micros=None, cost_source=CostSource.NONE, lines=[])`.
Aplana preparaciones `exploded` hasta insumos (recursivo, cortado por
`visiting`), deja las `batch` como una sola línea de preparación, fusiona
líneas del mismo insumo resultante en un único `ConsumptionLine`, aplica
`recipe_effect` de los modificadores (`add`/`remove`/`replace`) y resuelve
sustitutos por el **único camino** publicado por `backend-inventario`:
`app.inventory.hooks.resolve_consumption_target(db, ingredient, qty_base) ->
list[tuple[Ingredient, int]]` (cascada por stock disponible, no por un
`active` inventado por mí — ver «Ajustes al converger»).

`prep_stock_alerts` devuelve las preparaciones `batch` activas con stock
agregado `<= 0` (`{"type": "prep_no_production", "preparation_id",
"preparation_name", "current_stock", "unit"}`), para que `GET /admin/today`
(ajeno) arme la alerta. `uncosted_products` recorre `OrderItem` (sólo
lectura, `app.orders.models`) del rango de fechas pedido, agrupa por
`product_id` no anulado y llama `expand_consumption(qty=1)` por cada uno:
si el plan sale vacío, el plato entra al reporte de cobertura.

---

## 2. Modelo de datos

Todas las tablas llevan `organization_id`/`store_id` indexados,
`app.core.db.UTCDateTime` en cada `datetime`, enums `native_enum=False`,
`BigInteger` en toda columna de cantidad/costo (un costo en micros de una
preparación cara cruza los ~2.1e9 que entran en un `Integer` de 4 bytes en
Postgres — detalle que la spec no menciona pero que revienta en producción
si se usa `Integer` a secas).

| Tabla | Columnas clave | Notas |
|---|---|---|
| `preparations` | `mode` (`batch`\|`exploded`, default `exploded`), `standard_yield_qty`/`standard_yield_unit`, `process_loss_pct`, `shelf_life_days`, `active` | No versiona: `PrepBatch` congela su propio costo real al producir, así que cambiar las líneas hoy no revalora un lote ya producido. |
| `preparation_lines` | `preparation_id` (dueña), `ingredient_id` **xor** `component_preparation_id`, `qty_base`, `unit` | `CheckConstraint` exactamente un componente. `ingredient_id` FK real a `ingredients.id` (0008 corre antes que 0009). |
| `prep_batches` | `qty_expected`/`qty_real`, `variance_pct_x100`, `variance_alert`, `total_cost_micros`/`unit_cost_micros`/`cost_source`, `expiry_date`, `produced_by_employee_id`+nombre, `closed_at`/`closed_by_*`/`closed_reason` | Un lote por `POST /preparations/{id}/produce`. `closed_*` es lo que deja "cerrar los lotes abiertos" auditable al cambiar de modo. |
| `recipes` | `product_id` (único por sede), `current_version` (`0` = sin ficha) | Una por producto. |
| `recipe_versions` | `recipe_id`, `version`, `created_by_employee_*` | **Nunca se borra ni se pisa**: `UniqueConstraint(recipe_id, version)`. |
| `recipe_lines` | `recipe_version_id`, `ingredient_id` **xor** `preparation_id`, `qty_base`, `unit` | El costo NO se guarda acá — se calcula al vuelo (§4). |
| `modifier_option_recipe_effects` | `modifier_option_id` (único, FK a `modifier_options.id` de `app.catalog`), `effect` | Tabla propia de este dominio: `app/catalog/**` es de sólo lectura este pedido, así que el efecto no vive en la columna JSON `ModifierOption.recipe_effect` (que queda `NULL` para siempre) sino acá. |
| `modifier_option_recipe_effect_lines` | `effect_id`, `ingredient_id` **xor** `preparation_id`, `qty_base`, `unit`, `replaces_ingredient_id`/`replaces_preparation_id` (a lo sumo uno, sólo con `effect=replace`) | Decisión de esquema documentada en `models.py`/`hooks.py`: sin un "qué reemplaza" explícito, `replace` sería indistinguible de `add`. |

**Cómo versiona sin perder versiones viejas**: `PUT /admin/products/{id}/recipe`
nunca actualiza una `RecipeVersion` existente — siempre inserta una fila
nueva con `version = recipe.current_version + 1` y mueve el puntero
`recipes.current_version`. Las versiones anteriores (y sus `RecipeLine`)
quedan intactas para siempre; `OrderItem.recipe_version` (que llena
`backend-consumo` al enviar) sigue apuntando a un número de versión válido
después de guardar cualquier cantidad de versiones nuevas. Lo probé en
`tests/recipes/test_recipe_versioning.py::test_saving_bumps_version_and_keeps_old_versions_and_lines`:
guardo v1 (insumo A), confirmo que `expand_consumption` usa A; guardo v2
(insumo B); confirmo que `expand_consumption` ahora usa B (versión vigente);
y **releo directo de la tabla** `recipe_versions`/`recipe_lines` que la fila
`version=1` sigue ahí con su línea de insumo A intacta. También
`test_stale_version_is_rejected_with_409`: guardar con un `version` que ya
quedó atrás responde `409 RECIPE_VERSION_STALE` (bloqueo optimista, mismo
espíritu que `expected_version` en `app.orders`), para que dos ediciones
concurrentes no se pisen en silencio.

---

## 3. El insumo se descuenta una sola vez

**Cómo se garantiza (estructural, no por convención)**: `expand_consumption`
nunca devuelve líneas de insumo para una preparación en modo `batch` —
devuelve **una línea de la preparación misma** (`ConsumptionLine(preparation_id=X,
ingredient_id=None, ...)`). El insumo de una preparación `batch` sólo se
toca en `produce_preparation` (`app/recipes/service.py`), al producir. Para
una preparación `exploded`, `expand_consumption` la aplana hasta insumos —
pero como una preparación `exploded` **nunca tiene `produce()`** (mi
servicio corta con `400 PREP_NOT_BATCH` si se intenta), el insumo de una
preparación explotada sólo se toca al aplicar el plan de consumo (venta).
No existe ningún camino de código donde el mismo insumo se descuente por
los dos lados a la vez: la rama que produce (`service.produce_preparation`)
y la rama que consume (`hooks.expand_consumption`) usan la **misma**
función de aplanado (`hooks._accumulate`) pero **el modo de la preparación
decide cuál de las dos rutas se ejecuta**, nunca ambas.

**El test que lo prueba, con el número exacto** (`tests/recipes/test_single_discount.py::test_ingredient_is_discounted_exactly_once_batch_vs_exploded`):
dos preparaciones con la **misma receta** (1200 g de un insumo para rendir
1000 g), una en cada modo:

- **Camino batch**: `produce_preparation(qty_expected=1000g, qty_real=1000g)`
  descuenta 1200 g del insumo (`production_out`) y suma 1000 g a la
  preparación (`production_in`). Después, "vender" 1000 g de esa
  preparación aplica un único movimiento de **preparación**
  (`sale`, `qty_base=-1000g`) que **no toca el insumo**: confirmado
  consultando `stock_movements` (`cause=sale, ingredient_id=<insumo> ->
  []`, lista vacía).
- **Camino exploded**: sin `produce()` (no existe para este modo). "Vender"
  1000 g de esa preparación aplana directo a 1200 g del insumo
  (`sale`, `qty_base=-1200g`). Confirmado que no hay ningún movimiento
  `production_out`/`production_in` para este insumo (nunca se produjo).
- **El número que se compara**: `current_stock` del insumo al final de cada
  camino es **exactamente el mismo**, `-1_200_000` (milésimas de gramo,
  o sea −1200 g) — el mismo insumo, la misma receta, el mismo consumo
  total, sin importar por qué modo pasó. Si el insumo se hubiera
  descontado dos veces por algún camino, este número habría sido
  `-2_400_000`.

**Además**: `switch_preparation_mode` (`PATCH
/admin/preparations/{id}/mode`) cierra los lotes abiertos con un
`count_adjustment` (`_close_open_batches`) cuando se sale de `batch`,
exactamente para que, tras el cambio, no quede stock "fantasma" de la
preparación que alguien pueda vender sin que exista ya un camino de
producción que lo respalde. Probado por HTTP en
`tests/recipes/test_produce_http.py::test_mode_switch_closes_open_batches_and_requires_authorizer_pin`
(produce → cambia a `exploded` con PIN de admin → el lote queda con
`closed_at`/`closed_reason` → un segundo intento de `produce()` da
`400 PREP_NOT_BATCH`).

---

## 4. Propagación de costo en cadena, e invalidación

**Decisión explícita (la pide la misión)**: el costo se calcula **siempre al
vuelo**, nunca se materializa en una columna. `RecipeVersion`/`RecipeLine`
no tienen columnas de costo — sólo guardan qué insumos/preparaciones y
cuánto. `preparation_unit_cost`/`preparation_standard_unit_cost`/
`recipe_lines_cost` (`app/recipes/cost.py`) recorren las líneas y resuelven
el costo VIGENTE de cada insumo (`app.inventory.hooks.resolve_ingredient_cost`)
en cada llamada.

**Por qué al vuelo y no materializado-con-invalidación**: una preparación
puede estar en muchas fichas y una preparación puede usar otra preparación
— invalidar "transitivamente" un grafo así es exactamente la clase de bug
que dejó a la referencia sin propagación (cambiaba el costo del insumo y
nadie tocaba la fila cacheada aguas arriba). Con volúmenes de una carta de
restaurante (decenas de productos, no miles) el costo de recalcular en
cada lectura es insignificante frente a la garantía de que "cambiar el
costo de un insumo cambia el costo de la preparación y el del plato que la
usa" sea **siempre** cierto sin que nadie tenga que acordarse de invalidar
nada. La única memoización es *por llamada* (el parámetro `visiting`, para
no recalcular preparaciones repetidas dentro de una misma ficha y para
cortar cualquier recursión — defensivo, los ciclos reales ya se bloquean al
guardar).

**El costo real por lote SÍ se congela** (a propósito): `PrepBatch.total_cost_micros`/
`unit_cost_micros` se calculan una vez, al producir, con el costo de los
insumos EN ESE MOMENTO — eso es lo que "real por lote" significa (§4.2), y
es distinto de "estándar" (que sigue recalculándose al vuelo mientras no
haya lote, o cuando el lote se agota).

**Test en cadena** (`tests/recipes/test_cost_propagation.py`):
`test_ingredient_cost_change_propagates_to_preparation_and_product` — tomate
a $5/g → salsa (`exploded`, 1000 g de tomate por 1000 g de rendimiento) →
plato (200 g de salsa) da costo teórico $1.000; cambio el `official_cost_micros`
del tomate a $8/g **sin llamar ninguna función de este dominio** (la
escritura la hará `PATCH /admin/ingredients/{id}` de `backend-inventario`)
y, sin volver a guardar la ficha, `GET /admin/products/{id}/recipe` ya
reporta $1.600. `test_cost_propagates_through_a_nested_preparation` repite
la cadena con **dos** saltos de preparación (insumo → preparación A →
preparación B que usa A → plato): duplicar el costo del insumo duplica el
costo final del plato.

---

## 5. Criterio de "receta sospechosa de unidad"

Declarado y documentado en `app/recipes/service.py` (constantes
`SUSPICIOUS_CATEGORY_MULTIPLIER = 100`, `MIN_CATEGORY_SAMPLE = 3`,
`SUSPICIOUS_CEILING_BASE_UNIT = {"g": 10_000, "ml": 10_000, "unit": 500}`).
Para cada línea de insumo de la **versión vigente** de cada ficha de la
sede, se marca sospechosa si **cualquiera** de estos dos criterios se
cumple:

1. **Techo absoluto por unidad base**: la cantidad de la línea (en unidades
   base enteras) supera el techo de su `base_unit` — 10 kg, 10 L o 500
   unidades en una sola línea de un plato. Cubre el caso sin categoría
   comparable todavía (el primer insumo de una categoría nueva).
2. **Mediana de su categoría**: si hay al menos `MIN_CATEGORY_SAMPLE` (3)
   otras líneas de insumo de la **misma categoría** (`Ingredient.category`)
   y la **misma unidad base**, la línea se marca si se aparta **dos
   órdenes de magnitud** de la mediana de esas otras líneas (`>= 100×` o
   `<= 1/100`).

`GET /admin/recipes/suspicious-units` devuelve
`{product_id, product_name, ingredient_id, ingredient_name, qty, unit,
reason}` por cada línea marcada, con `reason` en texto ("supera el techo de
10000 g por línea" / "100x la mediana de su categoría (…)"). Probado en
`tests/recipes/test_suspicious_units.py` con los dos caminos por separado
(15 kg de sal donde 200 g es lo normal → techo; 400 unidades de una fruta
cuya categoría tiene mediana ~3 → mediana), y confirmando que las líneas
normales de cada caso **no** se marcan entre sí.

---

## 6. Endpoints

Todos bajo `/api/v1`, error siempre `{"error": {"code", "message"}}`, nunca
`500` por una regla de negocio.

| Método y ruta | Actor | Flag | Payload / notas | Errores propios |
|---|---|---|---|---|
| `GET/POST /admin/preparations` | admin | `catalog.preps` | `{name, mode, standard_yield_qty, standard_yield_unit, process_loss_pct?, shelf_life_days?, lines:[{ingredient_id\|preparation_id, qty, unit}]}`. `format=csv` declarado en la firma. | `PREP_CYCLE` (400) si una línea cierra un ciclo |
| `PATCH /admin/preparations/{id}` | admin | `catalog.preps` | Campos opcionales; si manda `lines`, reemplaza la receta completa (con el mismo chequeo de ciclo). | `PREP_CYCLE` |
| `PATCH /admin/preparations/{id}/mode` | admin | `catalog.preps` | `{mode, authorizer_pin}`. Sale de `batch` → cierra lotes abiertos con `count_adjustment`. | `AUTHORIZATION_REQUIRED`/`AUTHORIZATION_INVALID`/`AUTHORIZATION_NOT_ALLOWED` (vía `app.auth.service.verify_authorizer`, acción `preparation_mode_change`, **siempre admin**, nunca supervisor) |
| `GET /admin/preparations/{id}/batches` | admin | `catalog.preps` | `format=csv`. | — |
| `GET /preparations` | dispositivo (`current_device`) | `catalog.preps` | **Sin costo**: `PreparationDeviceOut` no tiene `cost`/`margin`/`unit_cost`/`food_cost`. `prefilled_qty = standard_yield_qty`. | — |
| `POST /preparations/{id}/produce` | dispositivo identificado (`current_operator`) | `catalog.preps` | `Idempotency-Key` obligatoria (`run_idempotent`). `{qty_expected, qty_real, employee_pin, note?}`; `employee_pin` reconfirma el PIN del operador YA identificado (no busca "cuál empleado" por PIN a ciegas). Alerta si `\|real-esperado\|/esperado > 15 %`. Respuesta sin costo. | `PREP_NOT_BATCH` (400, con la acción correctiva en el mensaje), `IDENTIFY_REQUIRED`, `EMPLOYEE_PIN_INVALID`, `409` en carrera con la misma clave (vía `run_idempotent`) |
| `GET/PUT /admin/products/{id}/recipe` | admin | `catalog.recipes` | `PUT {version, lines:[...]}`. Devuelve `{version, theoretical_cost, cost_source, food_cost_pct, net_price, lines}`. | `RECIPE_VERSION_STALE` (409) si `version` quedó atrás |
| `PUT /admin/modifier-options/{id}/recipe-effect` | admin | `catalog.recipes` | `{effect: add\|remove\|replace, lines:[{ingredient_id\|preparation_id, qty, unit, replaces_ingredient_id?, replaces_preparation_id?}]}` | `VALIDATION_ERROR` si `replace` sin `replaces_*`, o si `add`/`remove` traen `replaces_*` |
| `GET /admin/recipes/coverage` | admin | `catalog.recipes` | `date_from`/`date_to` opcionales (default: últimos 30 días de negocio). `format=csv`. | — |
| `GET /admin/recipes/suspicious-units` | admin | `catalog.recipes` | `format=csv`. | — |

Todas las rutas `/admin/*` de creación/edición usan `admin_store`/
`preparation_or_404` (404 ante id de otra organización o, para dispositivo,
de otra sede — nunca 403, nunca delata que existe). Todas verificadas
**encendidas y apagadas**: con `catalog.preps`/`catalog.recipes` apagada,
`400 FEATURE_DISABLED` en cada endpoint (`test_feature_disabled_blocks_preparations_endpoints`);
con `catalog.recipes` apagada, `expand_consumption` devuelve el plan vacío
en vez de tocar nada (`test_feature_disabled_returns_empty_plan_never_zero_never_exception`).

**Sesión de dispositivo, sin costo**: `PreparationDeviceOut`/`ProduceOut` no
declaran `cost`/`margin`/`unit_cost`/`food_cost` en ningún campo. Probado
con dos tests propios en `tests/recipes/test_openapi_no_cost.py`
(`test_device_preparation_routes_never_declare_cost_fields`, que barre el
OpenAPI publicado bajo `/api/v1/preparations` con el mismo criterio que
`MONEY_SECRETS` de `tests/audit/test_security_invariants.py`, y un control
negativo que confirma que las rutas admin SÍ declaran costo, para probar
que el escaneo mira algo real). Nota honesta: `POST /preparations/{id}/produce`
devuelve un `JSONResponse` crudo (mismo patrón que **todo** endpoint
idempotente de este proyecto — `shifts/open`, `shifts/close`, etc. — ver
`app/shifts/router.py`), así que FastAPI no puede publicar un schema OpenAPI
rico para ese endpoint puntual (ni el mío ni los de `shifts` lo tienen); la
garantía de "sin costo" ahí descansa en que `ProduceOut` (el objeto que se
serializa a mano) no tiene esos campos, no en el escaneo del OpenAPI — igual
que en el resto del proyecto.

---

## 7. Ajustes al converger con `app.core.quantity`/`app.inventory` reales

Empecé a escribir este dominio cuando `app/core/quantity.py` y
`app/inventory/**` todavía no existían (como anticipaba la misión), con un
doble de pruebas fiel al contrato dado
(`tests/recipes/_quantity_stub.py`/`_inventory_stub.py`, usado **sólo** si
el módulo real no es importable — `tests/recipes/conftest.py` lo instala
con import perezoso). A mitad de la construcción ambos módulos aparecieron
de verdad en el árbol (`backend-inventario` los terminó en paralelo); ajusté
el código contra las firmas reales antes de cerrar la entrega:

- **Sustituto**: el contrato real no expone sólo `get_ingredient`/
  `resolve_ingredient_cost`/`current_stock`/`record_movement` — también
  publica `resolve_consumption_target(db, ingredient, qty_base) ->
  list[tuple[Ingredient, int]]`, el único camino oficial de sustituto en
  cascada (por stock disponible, no por `active` como yo había asumido).
  `hooks._accumulate` usa esa función tal cual; mi propia resolución de
  sustituto (que sí llegué a escribir) se borró entera.
- **`record_movement` fusiona sola** por `(ref_type, ref_id, cause,
  insumo/preparación)` — no lo sabía cuando escribí `service.produce_preparation`,
  pero como cada insumo de una receta tiene su propio `ingredient_id`, mis
  llamadas nunca colisionan entre sí; no hizo falta cambiar nada ahí.
- **Invariante `(cost_micros is None) <=> (cost_source is CostSource.NONE)`**
  y **`qty_base != 0`**, los dos exigidos por `record_movement` antes de
  escribir: encontré y corregí un caso real en `produce_preparation` donde
  un lote con `qty_real = 0` (se quemó toda la producción) hubiera violado
  los dos — ahora el `cost_source` se degrada a `NONE` cuando no hay
  `unit_cost_micros`, y el movimiento `production_in` se omite entero
  cuando `qty_real == 0` (no hay entrada que registrar).
- **`Ingredient.base_unit` es un enum `BaseUnit(str, Enum)`, no un string
  pelado** — mi `seed.py` pasaba literales `"g"`/`"unit"`; los cambié a
  `BaseUnit.G`/`BaseUnit.UNIT` explícitos para no depender de la coerción
  implícita de SQLAlchemy.
- **`app.main.DOMAINS`/`app.core.models_registry.MODEL_MODULES` siguen sin
  `"recipes"`/`"inventory"`** (confirmado al momento de cerrar esta
  entrega): no es mi archivo, así que mis tests HTTP montan el router
  directamente sobre el `app.main.app` singleton desde
  `tests/recipes/conftest.py` (insertando las rutas **antes** del catch-all
  del SPA, que si no las tapa en cualquier `GET`), sin tocar `app/main.py`
  en disco. Documentado como gap abajo.

---

## 8. Gaps (todo lo que la spec pide y no construí, con su razón)

- **`app.main.DOMAINS`/`app.core.models_registry.MODEL_MODULES` sin
  `"recipes"`/`"inventory"`**: sin esto, la API real (no la de mis tests,
  que monta el router a mano) no expone ningún endpoint de este dominio.
  No es mi archivo (explícitamente fuera de mi territorio); falta el PASO 0
  del reparto: alguien tiene que agregarlos con `find_spec_safe`, en ese
  orden (inventory antes que recipes, porque mi migración depende de la
  suya).
- **`replace` no sigue la cascada de sustituto del insumo que reemplaza**:
  si `replaces_ingredient_id` tiene sustituto y ese sustituto llegó a
  activarse dentro del mismo plan, `expand_consumption` busca la clave por
  el id ORIGINAL en el acumulador y no la encuentra (documentado en el
  código, `hooks.py`, función `expand_consumption`, rama `REPLACE`). El
  caso común (sin sustituto, o sustituto sin activar) queda cubierto y
  probado; el cruce sustituto+reemplazo simultáneo no.
- **`prep_stock_alerts`/`uncosted_products` no tienen un endpoint propio**:
  se publican como funciones puras para que `GET /admin/today` (ajeno) las
  llame; no construí ninguna pantalla ni ruta que las sirva directo, porque
  el contrato de la API del pedido no la pide (sólo pide que
  `GET /admin/today` "gane" esas alertas).
- **`GET /admin/recipes/coverage` no distingue "nunca se vendió" de "se
  vendió pero no descuenta nada"**: `uncosted_products` sólo mira
  `OrderItem` existentes en el rango pedido; un producto activo que
  **nunca** se vendió no aparece en ningún lado todavía (ninguno de los dos
  reportes lo cubre) — fiel a la letra de la spec ("un plato **vendido**
  sin receta..."), pero si el equipo quiere una alerta preventiva
  ("producto activo sin ficha, aunque nunca se haya vendido") hace falta un
  endpoint nuevo, no lo until construí.
- **Redundancia de nombres entre `app.recipes.seed.seed_recipes` y
  `app.inventory.seed.seed_inventory`**: los dos crean insumos de ejemplo
  con nombres distintos ("Pechuga de pollo" vs. "Pollo en pechuga", etc.)
  porque no coordiné con `backend-inventario` qué nombres iba a usar. Mi
  seed es idempotente por nombre (si encuentra un insumo con el nombre
  exacto que necesita, lo reutiliza; si no, lo crea), así que **no rompe
  nada**, pero deja ~7 insumos "de más" en una base sembrada con los dos
  seeds corridos. Verificado que el conjunto combinado funciona end-to-end
  (fichas, preparación `batch` con lote, `exploded`, `recipe_effect`,
  `expand_consumption` real) en una corrida manual contra una base
  Postgres-equivalente (SQLite) desde cero. Quien conecte `app/seed.py`
  (huérfano con dueño asignado en el reparto) puede resolverlo con un
  cambio de una línea si le importa la prolijidad del seed de desarrollo;
  no bloquea nada funcional.
- **No hay pantalla de frontend**: fuera de mi territorio en este pedido
  (backend puro); `frontend/src/features/settings/**` y las pantallas de
  Carta y recetas/Preparaciones/Inventario que pide `docs/ESTADO.md §9.3`
  quedan para el agente de frontend de este mismo pedido.
- **No pude correr la suite completa del backend ni el build**: por
  instrucción explícita (cinco agentes en paralelo sobre el mismo árbol);
  eso lo corre el paso de verificación del orquestador, una vez, en serie.
- **Postgres real**: no lo pude probar en este entorno (sin runner ni
  Postgres local, misma limitación que el resto del proyecto hasta ahora);
  la migración está escrita "Postgres-first" (mismo estilo que
  `0001`-`0008`) pero sólo la corrí contra SQLite.
- **`process_loss_pct` es declarativo, no entra en ninguna fórmula de
  costo**: lo guardo y lo expongo, pero el costo estándar/real de una
  preparación usa `standard_yield_qty`/`qty_real` directamente (que ya
  capturan "cuánto rinde de verdad"); no encontré en la spec una fórmula
  explícita que combine `process_loss_pct` con el costo sin duplicar lo que
  `standard_yield_qty` ya expresa. Queda declarado para que 2b (varianza,
  salud del control) lo use si hace falta.

---

## Archivos de este entregable

- `backend/app/recipes/__init__.py`, `models.py`, `schemas.py`, `service.py`,
  `router.py`, `hooks.py`, `cost.py`, `units.py`, `seed.py`
- `backend/alembic/versions/0009_recipes.py`
- `backend/tests/recipes/__init__.py`, `conftest.py`, `_quantity_stub.py`,
  `_inventory_stub.py`, y los `test_*.py` (versionado, ciclos, propagación,
  descuento único, `expand_consumption`, cobertura, unidades sospechosas,
  producción/HTTP, matemática de cantidades, OpenAPI sin costo, **precisión
  de costo — `test_cost_precision.py`, nuevo en ronda 2**)

## Verificación corrida

**Ronda 1** (migración, probada desde cero contra una base propia — no
vuelta a correr en ronda 2 porque `0009` no cambió):

```
cd backend && DATABASE_URL="sqlite:////tmp/pt-backend-recetas/migration_test.db" python -m alembic upgrade head
cd backend && DATABASE_URL="sqlite:////tmp/pt-backend-recetas/migration_test.db" python -m alembic downgrade -1
# las dos corren limpio; downgrade deja 0008 intacto (ingredients/stock_movements/wastes)
# y sólo borra las 7 tablas de este dominio.
```

**Ronda 2** (contrato de costo como texto decimal — ver §0):

```
cd backend && TMPDIR=/tmp/pt-backend-recetas python -m pytest -q tests/recipes
# 33 passed

cd backend && python -m mypy app
# Success: no issues found in 106 source files

cd backend && TMPDIR=/tmp/pt-backend-recetas python -m pytest -q \
  tests/audit/test_cost_invariants.py::test_a_real_cost_below_one_peso_is_never_reported_as_zero
# 1 passed
```
