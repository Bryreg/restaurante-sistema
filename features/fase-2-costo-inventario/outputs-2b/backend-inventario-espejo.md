# Backend — Lotes, conteos a ciegas, varianza y los cinco escalones de costo (pedido 2b)

**Agente**: `backend-inventario-espejo`. **Territorio**: `app/inventory/**`, `app/core/quantity.py`,
`app/seed.py`, `alembic/versions/0012_counts_lots.py`, `tests/inventory/**`, `tests/core/**`,
`tests/conftest.py`.

Esta es la mitad de 2b que confronta la teoría con la realidad: lotes con vencimiento, conteos a
ciegas, varianza, food cost real, salud del control, y los dos escalones de costo que le faltaban
a la jerarquía. Todo vive en `inventory`, que ya existía desde 2a — es el libro mirándose al
espejo, no un dominio aparte.

---

## §1. Qué construí

- **Lotes de compra** (`StockBatch`, SPEC-NEGOCIO §5.7): el lote nace de una recepción confirmada
  (o del seed), con `qty_received` inmutable y `qty_remaining` mutable; FEFO declarado por escrito
  (vencimiento primero, recepción para desempatar, sin vencimiento al final); un lote vencido
  nunca se da de baja solo. `GET /admin/lots` con los cuatro estados.
- **Conteos a ciegas** (`StockCount`/`StockCountLine`, SPEC-NEGOCIO §5.4): `POST /admin/counts`
  abre un conteo sin exponer el stock teórico por ningún camino; `PUT /admin/counts/{id}/lines`
  captura renglón por renglón, sin «todo coincide» y sin que un borrador pise una confirmación;
  `POST /admin/counts/{id}/apply` aplica `contado + (entradas − salidas DESDE EL INSTANTE DEL
  CONTEO)` — nunca desde el instante de aplicar — con `Idempotency-Key` y `409
  COUNT_ALREADY_APPLIED` ante una segunda aplicación.
- **Varianza, food cost real y salud del control** (SPEC-NEGOCIO §5.4): `GET /admin/variance`
  cierra la identidad `inicial + entradas − final = uso real` contra el uso teórico que ya vive en
  el libro (`cause=sale` + `cause=production_out`), en cantidad y en pesos, con semáforo
  configurable por sede; `GET /admin/food-cost` calcula `(inicial + compras − final) ÷ ventas
  netas` sólo entre dos conteos completos consecutivos, `null` con motivo si no los hay o si el
  control lleva más de 14 días sin un conteo completo; `GET /admin/control-health` publica esa
  señal más el % de recepciones con factura (leído de `purchases` con `find_spec_safe`), el % de
  preparaciones `batch` producidas esta semana (leído de `recipes`) y las mermas de la semana.
- **Los dos escalones que faltaban en `resolve_ingredient_cost`**: `official → weighted_average →
  last_purchase → estimated → none`. El promedio ponderado se deriva (nunca se guarda) leyendo los
  `StockBatch` recibidos después del último conteo completo aplicado.
- ~~**La lectura agregada** `GET /admin/orders/{id}/consumption`~~ — construida en la ronda 1,
  **SACADA en la ronda 2** (hallazgo H-2, decisión del Maestro): sobrevive la implementación de
  `app.orders`, que lee el costo CONGELADO de cada fila del libro (snapshot) y suma
  `SALE + NOTE_RETURN`. Ver **§ Ronda 2** al final de este documento.
- **Umbrales de varianza** como configuración de sede (`StoreInventorySettings`, tabla propia de
  `inventory`, no de `app.stores`), con `GET/PUT /admin/stores/{store_id}/inventory-settings`.
- **La deuda declarada de 2a, cerrada**: una sola escala de cantidad publicada (texto decimal,
  `format_qty_base`, con la regla escrita en `app/core/quantity.py` igual que la de costos, y
  auditada por tres tests nuevos en `tests/core/test_quantity.py`); `WasteKpiOut.ratio` pasa de
  `float` a `int` en puntos básicos y deja de ser siempre `null`.
- **Contrato nuevo publicado en `app/inventory/hooks.py`** (seis firmas, más `RECEPTION_REVERSAL`
  en el enum): ver §4. `app/purchases` ya construye contra él — verificado contra su código, no
  asumido (ver §5).
- **Seed** (`app/seed.py`, `app/inventory/seed.py::seed_counts_and_purchase`): dos conteos
  completos aplicados y consecutivos, con una compra en el medio, e invocación de
  `app.purchases.seed.seed_purchases` si existe.

## §2. El modelo de datos nuevo y la migración

Cuatro tablas nuevas, todas en `app/inventory/models.py`, migración `alembic/versions/
0012_counts_lots.py` (`down_revision = "0011"`, la migración de `purchases`):

- **`stock_batches`**: `organization_id`, `store_id`, `ingredient_id` (FK dura — `ingredients` ya
  existe desde `0008`), `qty_received`, `qty_remaining`, `unit_cost_micros`, `cost_source`,
  `lot_code`, `expires_at` (nullable — `NULL` = nunca vence), `received_at`, `business_date`,
  `source_type`/`source_id` (sin FK dura: `receptions` es de `purchases`, mismo patrón que
  `Ingredient.supplier_id`), `reversed_at` (nullable). `CheckConstraint`s: `qty_received > 0`,
  `0 <= qty_remaining <= qty_received`, `unit_cost_micros >= 0`.
- **`stock_counts`**: `scope` (`key_items`/`full`), `status` (`open`/`applied`), `opened_at`
  (**el instante del conteo**, usado tanto por `apply_count` como por `variance_report` como
  frontera de ventana), `business_date`, `opened_by_*`, `applied_at`/`applied_by_*` (nullable
  hasta que se aplica).
- **`stock_count_lines`**: `count_id`, `ingredient_id`, `qty_counted` (nullable — `NULL` hasta que
  se cuenta), `was_counted`, `counted_at`. `UniqueConstraint(count_id, ingredient_id)`.
- **`store_inventory_settings`**: `store_id` (PK), `variance_yellow_threshold_bp`,
  `variance_red_threshold_bp` (defaults 200/400 = 2,00 %/4,00 %), `updated_at`.
  `CheckConstraint(red > yellow)`.

**Nota que corrige una premisa del mandato, verificada contra el código, no asumida**: la
migración `0008_inventory.py` NO crea ningún `CHECK CONSTRAINT` sobre la columna `cause` de
`stock_movements`. `sa.Enum(..., native_enum=False)` en SQLAlchemy 2.0 (la versión de este repo)
tiene `create_constraint=False` por defecto desde 1.4, y `app.inventory.models._enum` nunca pasa
`create_constraint=True`. Lo verifiqué compilando `CreateTable(...)` contra el dialecto SQLite:
la columna es `VARCHAR(32) NOT NULL` a secas, sin `CHECK`. **Agregar `RECEPTION_REVERSAL` al enum
de Python no requirió ninguna migración de esquema** — no hay una lista de valores que recrear en
la base, en ningún dialecto. `0012_counts_lots.py` lo documenta en su docstring para que nadie
salga a buscar un `batch_alter_table` que no hace falta, y
`tests/inventory/test_stock_batch_hooks.py::test_reception_reversal_cause_persists_and_round_trips`
prueba que el valor persiste y se relee tal cual, por SQL crudo además de por el ORM.

## §3. Los endpoints, con su código de error por camino

Todos bajo `/api/v1`, todos `current_admin`, todos con su `require_feature`:

| Ruta | Flag | Errores de negocio |
|---|---|---|
| `GET /admin/lots` | `inventory.lots` | — (lectura) |
| `GET/PUT /admin/stores/{id}/inventory-settings` | `inventory.variance` | `400 VALIDATION_ERROR` si `red <= yellow` |
| `POST /admin/counts` | `inventory.counts` | — |
| `GET /admin/counts`, `GET /admin/counts/{id}` | `inventory.counts` | `404 NOT_FOUND` |
| `PUT /admin/counts/{id}/lines` | `inventory.counts` | `409 COUNT_ALREADY_APPLIED` si ya se aplicó; `400 VALIDATION_ERROR` si el insumo no está en el alcance del conteo o la cantidad no es texto decimal |
| `POST /admin/counts/{id}/apply` (Idempotency-Key) | `inventory.counts` | `409 COUNT_ALREADY_APPLIED`; PIN inválido → `400 AUTHORIZATION_INVALID` |
| `GET /admin/variance?count_id` | `inventory.variance` | `404 NOT_FOUND`; `400 COUNT_NOT_APPLIED` si el conteo no está aplicado |
| `GET /admin/food-cost?from&to` | `inventory.variance` | — (nunca error de negocio: `available=false` con `reason`, nunca `0`) |
| `GET /admin/control-health` | `inventory.variance` | — |

`GET /admin/orders/{id}/consumption` **ya no está en esta tabla**: se sacó de `app.inventory` en la
ronda 2 (H-2). La ruta la sirve `app.orders` — ver **§ Ronda 2**.

## §4. El contrato que publico

Seis firmas nuevas en `app/inventory/hooks.py`, verificadas contra el código real de
`app/purchases/hooks.py` (que ya las importa y las llama, ver §5 — el contrato no quedó en
promesa, otro agente ya construyó contra él):

```python
create_stock_batch(db, *, organization_id, store_id, ingredient_id, qty_base,
                    unit_cost_micros, cost_source, lot_code=None, expires_at=None,
                    received_at, business_date, source_type, source_id) -> StockBatch
reverse_stock_batch(db, *, batch_id) -> None   # AppError("LOT_CONSUMED", status=409) si ya se consumió en parte; idempotente si ya estaba revertido
consume_lots_fefo(db, *, store_id, ingredient_id, qty_base) -> list[tuple[StockBatch, int]]
weighted_average_cost_micros(db, *, store_id, ingredient_id) -> int | None
last_purchase_cost_micros(db, *, store_id, ingredient_id) -> int | None
last_applied_full_count_at(db, *, store_id) -> datetime | None
```

Más `current_stock(db, *, store_id, ingredient_id=None, preparation_id=None, as_of=None) -> int`
(extensión retrocompatible de la firma de 2a: `as_of` es un kwarg nuevo al final, con default
`None` que preserva el comportamiento anterior; nadie que ya la llamaba se rompe).

Y en `app/inventory/models.py`, `MovementCause` gana `RECEPTION_REVERSAL = "reception_reversal"`
(ver §2 — sin migración de esquema porque no hay `CHECK` que recrear). **Corrección de la ronda 2
(H-0)**: en la ronda 1 el valor existía en el enum del modelo pero `app.inventory.schemas.
MovementCauseLiteral` (el espejo que valida el filtro `?cause=` del router y cada fila publicada de
`StockMovementOut`) no lo declaraba — hoy sí, y es el único espejo de ese enum en todo el dominio
(verificado con `grep -rn "count_adjustment" app/inventory`, que ahora encuentra exactamente dos
apariciones: la del modelo y la del `Literal`).

**Contrato nuevo de la ronda 2 (hallazgo H-4)**, publicado en `hooks.py` junto a las seis firmas de
arriba:

```python
INVENTORY_STALE_DAYS = 14  # constante única; antes vivía duplicada (ver § Ronda 2)

@dataclass(frozen=True)
class InventoryStaleness:
    days_since_last_full_count: int | None
    unreliable: bool
    stale_days: int

inventory_staleness(db, *, store_id: int, cutoff_hour: int) -> InventoryStaleness
```

Ver el detalle completo (semántica, quién la consume, por qué el nombre) en **§ Ronda 2** al final
de este documento.

**Escala unificada**: `format_qty_base` es la única forma correcta de publicar una cantidad de
insumo en cualquier esquema de respuesta, de cualquier dominio — la regla está escrita en
`app/core/quantity.py` con el mismo peso que la de costos, y auditada por
`tests/core/test_quantity.py::test_openapi_has_no_raw_integer_qty_base_or_min_stock_fields`
(recorre el OpenAPI completo, no sólo los esquemas que el archivo conoce por nombre).

## §5. Las decisiones y su por qué

**FEFO declarado, por escrito, en el docstring de `consume_lots_fefo`**: el lote **más próximo a
vencer** primero (`expires_at` ascendente); a igualdad, el **recibido primero** (`received_at`
ascendente, `id` como desempate final); un lote **sin** vencimiento se ordena **al final**, nunca
al principio. «El más antiguo» (§5.7) es ambiguo entre fecha de recepción y de vencimiento, y una
elección silenciosa acá mueve plata — probado con tres lotes
(`test_fefo_consumes_nearest_expiry_first_then_received_first_then_no_expiry_last`) más un caso de
empate y un caso de stock insuficiente que no bloquea.

**El FEFO vive DENTRO de `record_movement`**, no en cada llamador (decisión de arquitectura #3 ya
tomada por el Maestro): cuando `qty_base < 0`, hay `ingredient_id` y `inventory.lots` está
encendida, `record_movement` descuenta de los lotes con el `qty_base` de ESA llamada — así las
salidas que ya existen (venta, merma, producción, ajuste) consumen lotes sin tocar `app/orders/**`
ni `app/recipes/**`. **Excepción que tuve que descubrir y declarar yo, no estaba en el mandato**:
`cause=RECEPTION_REVERSAL` NUNCA dispara FEFO acá. Verifiqué el código real de
`app/purchases/service.py::reverse_reception` (que ya existía cuando llegué a esta parte): llama
`purchases_hooks.reverse_stock_batch(batch_id=...)` (que vacía el lote EXACTO que se revierte) y
DESPUÉS escribe `record_movement(cause=RECEPTION_REVERSAL, qty_base=-línea, ...)`. Si mi FEFO
corriera sobre ese movimiento, consumiría de un lote **distinto** (el que hoy esté más próximo a
vencer) — un bug de doble descuento que ningún test de `purchases` iba a atrapar, porque desde su
lado el saldo total del libro cierra igual (es la contabilidad DE LOTES la que queda inconsistente).
Lo até con `test_reception_reversal_never_triggers_fefo_on_a_different_batch`.

**El promedio ponderado se deriva, nunca se guarda** (decisión de arquitectura #2 ya tomada): no
hay ni puede haber una columna `weighted_average_cost` en `Ingredient`. `weighted_average_cost_
micros` lee los `StockBatch` recibidos **después** del último conteo completo aplicado
(`last_applied_full_count_at`), ponderando por `qty_received` (lo que entró a ese precio, no lo
que queda hoy — eso es una pregunta distinta, la que responde `food-cost`). **Sin conteo completo
previo, pondera TODA la historia** — decisión mía, no estaba explícita en el mandato: una sede
recién sembrada con compras pero sin conteos todavía tiene que poder mostrar un promedio, no
`null` para siempre esperando un conteo que nadie pidió.

**`current_stock` gana `as_of` como kwarg nuevo, no una función aparte**: extender la firma
publicada de 2a en vez de duplicarla. El álgebra que hace que `apply_count` no invente un
faltante sale directo de acá: si `target = contado + movimientos_desde_el_conteo` y `ahora =
stock_al_conteo + movimientos_desde_el_conteo` (el libro es aditivo), entonces `ajuste = target −
ahora = contado − stock_al_conteo` — los movimientos que pasaron entre el conteo y el `apply` se
CANCELAN en el álgebra. Por eso `apply_count` no necesita sumar entradas y salidas a mano: le
alcanza con `hooks.current_stock(..., as_of=count.opened_at)`. Es el mismo principio (una sola
matemática, una sola fuente de verdad) aplicado a que ni siquiera YO tuve que reimplementar la
suma dos veces.

**Los dos conteos del seed, con una compra en el medio, ambos «limpios» a propósito**: la spec
pide «un conteo completo aplicado», pero con uno solo el food cost real es `null` para siempre —
hacen falta dos consecutivos para que la resta tenga con qué cerrar, y una base sembrada nunca
podría demostrarlo. Elegí que los dos conteos sean exactamente iguales al stock del libro en ese
instante (`qty_counted = hooks.current_stock(..., as_of=count.opened_at)`), así el ajuste de
aplicar cada uno da `0` para todos los insumos. Fabricar una diferencia (un «faltante» de
demostración) habría sido una decisión de negocio silenciosa que no le corresponde a un seed de
desarrollo, y habría dejado un `count_adjustment` arbitrario en la base que después hay que
explicarle a quien la recorra. No depende de que `app.purchases` exista: crea su propio
`stock_batch` y su propio movimiento `cause=purchase` con mis propios hooks.

**El KPI de mermas mantiene el texto `"sin datos"` para el caso nulo**, aunque ahora SÍ calcula
cuando hay compras. Encontré, corriendo mi propia suite, que `tests/inventory/test_waste.py`
(2a, territorio propio) ya fijaba ese texto exacto como contrato. Cambié mi implementación para
no romper ese test en vez de reescribirlo sin necesidad: es exactamente el mismo mensaje, sólo que
ahora deja de aparecer en cuanto hay con qué dividir.

**`OrderConsumptionRowOut.cost` publica el costo resuelto de HOY por unidad base** (mismo campo,
misma forma que `StockRowOut.cost`/`IngredientOut.cost`), no un total ya multiplicado. Lo decidí
así por dos motivos: (1) mantiene la convención ya establecida y ya auditada del dominio (`cost`
es siempre "por unidad", el total lo arma quien lee multiplicando por `qty_base`, que también
está en la fila); y (2) hay un invariante heredado,
`tests/audit/test_cost_invariants.py::test_no_cost_field_of_inventory_or_recipes_is_typed_as_an_
integer` (territorio del auditor, no mío), que exige que TODO campo `cost`/`*_cost` de
`app.inventory.schemas` sea texto decimal — publicar un total como `int` bajo el nombre `cost`
lo habría roto. Por la misma razón nombré `VarianceRowOut.variance_value` (no `variance_cost`):
ese campo SÍ es un total de plata ya cerrado (`variance_qty × costo`, redondeado una sola vez,
`app.core.money`), y llamarlo `variance_cost` habría forzado ese barrido heredado a mentir sobre
lo que audita en vez de acotarlo sin necesidad. Ningún campo mío quedó fuera de ese barrido por
accidente: lo revisé campo por campo antes de nombrar cada uno.

**`OrderConsumptionRowOut.item_count`** cuenta en cuántos `order_items` distintos aparece el
insumo (útil para saber si una fila agregada mezcla varios platos), sin exponer los `id` de esos
ítems — eso ya está disponible leyendo `GET /admin/ingredients/{id}/movements` por separado, que
sí trae `ref_id`. No dupliqué esa información acá.

**`_reception_invoice_ratio` verificada contra el código real de `purchases`, no asumida**: mi
primera versión asumía `reception_invoice_ratio(...) -> int | None` en puntos básicos (lo que el
mandato sugería sin firmar). Cuando `app/purchases/hooks.py` aterrizó en el árbol durante mi
construcción, leí su código: publica `tuple[int, int]` = `(con_factura, total)`, una razón sin
calcular — "una sola matemática" también significa que quien PUBLICA el número decide la escala,
no cada consumidor por su cuenta. Corregí mi función antes de que ese bug llegara a producción
(habría sido un `500` en `GET /admin/control-health`, capturado tarde: mi primer `try/except
TypeError` no lo atrapaba, porque la llamada en sí no fallaba — el `int()` sobre una tupla sí, y
eso estaba FUERA del bloque protegido).

**Varianza excluye `count_adjustment` de «entradas» a propósito**: la ventana de `_movement_sum`
para «entradas» va de `previous.opened_at` (exclusivo) a `count.opened_at` (inclusivo), pero
excluye explícitamente `cause=count_adjustment`. El ajuste del conteo ANTERIOR ya quedó absorbido
en `inicial` (que es el valor CONTADO de ese conteo, no el del libro); sumarlo de nuevo en
«entradas» lo contaría dos veces y desarmaría la identidad. Es la misma cautela algebraica de
`current_stock(as_of=...)`, aplicada a un cálculo distinto.

**Food cost usa el costo resuelto de HOY para valorizar los dos conteos**, no un costo congelado
en el momento de cada conteo. No es una revalorización de una venta pasada (prohibida por
`AGENTS.md`): valoriza un CONTEO, que es una foto de stock física, no una venta con snapshot
propio. Las compras del período, en cambio, se valorizan con el `cost_micros` que cada movimiento
`cause=purchase` ya tiene congelado — nunca se resuelve de nuevo.

**`GET /admin/variance`/`GET /admin/food-cost` responden sobre CUALQUIER conteo aplicado anterior**,
no sólo el inmediato consecutivo por `scope`: la «referencia en pantalla» y la «entradas/salidas
desde el conteo anterior» buscan el conteo aplicado más reciente ANTES del actual, sin filtrar por
`scope` — un conteo de críticos del martes es antecedente válido para el conteo completo del
jueves. Para food cost, en cambio, la spec es explícita: **sólo entre dos `full` consecutivos**,
así que ahí sí filtro por `scope=full` antes de tomar el par más reciente dentro del rango pedido.

## §6. Los tests que escribí, con su resultado EXACTO

**ESTADO ACTUAL (post ronda 2) — ver el detalle completo de qué cambió en § Ronda 2.**
Verificación corrida por mí, en mi territorio únicamente (`tests/inventory tests/core`), con
`TMPDIR=/tmp/pt-backend-inventario` propio, **dos veces en serie**:

```
python -m pytest -q -p no:cacheprovider tests/inventory tests/core
```

**`184 passed in 342.27s (0:05:42)`** la primera corrida, **`184 passed in 342.41s (0:05:42)`** la
segunda — **cero rojos, ninguno escondido**. Los dos rojos que la ronda 1 había declarado en §8
(`test_reports_qty_fields_are_published_as_decimal_strings`,
`test_openapi_has_no_raw_integer_qty_base_or_min_stock_fields`) están **verdes**: confirmado, no
asumido — corrieron dentro de las dos corridas de arriba sin que yo tocara `tests/core/
test_quantity.py` en esta ronda. `backend-lectura-contrato` cerró la deuda de `app/reports/
schemas.py` (§5, ronda 1) que los mantenía rojos.

El número bajó de 185 (183 verdes + 2 rojos, ronda 1) a 184 por el neto de la ronda 2: **-3**
(`tests/inventory/test_order_consumption.py`, borrado completo por H-2) **+1** (H-0:
`test_reversed_reception_leaves_the_ledger_readable`) **+1** (H-5:
`test_variance_semaphore_is_red_when_stock_is_missing_with_zero_theoretical_usage`) **+2** (los dos
que pasan de rojo a verde sin que yo los toque) = 183 − 3 + 1 + 1 + 2 = 184.

Sección de la ronda 1, sin cambios (para el detalle completo de cómo se llegó a los 183/185
originales, ver el historial de este archivo o los mensajes de la ronda 1); lo que sigue es la foto
de la ronda 1 tal cual quedó, con la corrección de encabezado de arriba como fuente de verdad
actual:

Archivos de test que escribí, **estado post ronda 2** (63 tests nuevos, los 63 en verde — cero
rojos declarados):

| Archivo | Tests | Qué prueba |
|---|---|---|
| `tests/inventory/test_lots.py` | 13 | FEFO con tres lotes (vencimiento > recepción > sin vencer), empate de vencimiento, stock insuficiente no bloquea, `record_movement` dispara/no dispara FEFO según la flag, `RECEPTION_REVERSAL` nunca dispara FEFO, `reverse_stock_batch` (`409 LOT_CONSUMED`, idempotencia), lote vencido no se da de baja solo, lote sin vencimiento nunca es `expiring`/`expired`, `400 FEATURE_DISABLED` |
| `tests/inventory/test_cost_hierarchy.py` | 7 | Los cinco escalones, uno por test, más «una compra anterior al conteo no mueve el promedio» y «sin conteo, pondera toda la historia» |
| `tests/inventory/test_counts.py` | 11 | A ciegas (recorre el JSON entero), no existe «todo coincide», un borrador no pisa un valor confirmado, **el test de las 13:07/15:42**, un faltante real se escribe tal cual, doble aplicación → `409`, editar tras aplicar → `409`, número JSON crudo rechazado, `key_items` vs `full`, referencia = conteo anterior, flag |
| `tests/inventory/test_variance_food_cost.py` | 11 (+1 ronda 2) | Identidad armada a mano, sin conteo anterior → no disponible con motivo, semáforo cambia de color con el umbral, defaults y validación de `inventory-settings`, food cost null sin dos conteos, food cost con dos conteos (valores correctos, null por falta de ventas — un caso real, no forzado), redondeo del `pct_bp` sin `float`, salud del control > 14 días, salud del control sin conteo nunca, flag, **+ H-5: `test_variance_semaphore_is_red_when_stock_is_missing_with_zero_theoretical_usage`** |
| ~~`tests/inventory/test_order_consumption.py`~~ | ~~3~~ 0 | **Borrado completo en la ronda 2 (H-2)** — ver § Ronda 2 |
| `tests/inventory/test_waste_kpi.py` | 3 | `ratio` nunca `float` (por anotación), `null` sin compras, deja de ser `null` con compras (por la ruta real de merma) |
| `tests/inventory/test_feature_flags_2b.py` | 7 | Las cuatro rutas nuevas con su flag en los dos estados, y las dependencias declaradas respetadas por la ruta REAL de `PUT /admin/features/{key}` (no sólo por el catálogo) |
| `tests/inventory/test_stock_batch_hooks.py` | 5 (+1 ronda 2) | Validaciones de `create_stock_batch`, persistencia y round-trip de `RECEPTION_REVERSAL` (por ORM y por SQL crudo), `weighted_average`/`last_purchase` sin lotes, **+ H-0: `test_reversed_reception_leaves_the_ledger_readable`** |
| `tests/core/test_quantity.py` (+3 sobre las de 2a) | 3 | Campos de cantidad de `inventory` en texto decimal; los de `app.reports` (**ahora verde**, cerrado por `backend-lectura-contrato`); auditoría de contrato sobre el OpenAPI completo (**ahora verde**) |

Más las correcciones a `app/inventory/**` que hacen que la suite **heredada de 2a** (65 tests en
`tests/inventory/test_business_date.py`, `test_device_ingredients.py`, `test_hooks.py`,
`test_ingredients.py`, `test_seed.py`, `test_stock_and_movements.py`, `test_waste.py`) siga en
verde con `record_movement` (FEFO), `resolve_ingredient_cost` (cinco escalones) y `current_stock`
(`as_of`) todos cambiados por dentro.

**mypy**: `python -m mypy --cache-dir=$TMPDIR/mypy app/inventory app/core` → **limpio, 23
archivos**.

**Seed**: `python -m app.seed` corrido dos veces sobre una base nueva → la segunda vez no repite
nada («Seed ya aplicado»); la primera vez deja `last_applied_full_count_at` con valor,
`resolve_ingredient_cost` de un insumo con `key_item=True` resolviendo a `official` (el costo
oficial del seed manda, como corresponde), y `GET /admin/control-health` respondiendo
`inventory_unreliable=False` — verificado a mano contra la base sembrada, no sólo leído del log.

## §7. Qué NO construí, y por qué

**Nota post ronda 2**: dos ítems de esta sección cambiaron de estado. `GET /admin/orders/{id}/
consumption` SÍ se construyó en la ronda 1 y se SACÓ en la ronda 2 (H-2) — ya no es "algo que
falta", es "algo que se decidió no publicar desde acá". `MovementCause.VOID_AFTER_SEND` pasó de
"declarada y sin producir" (gap de §8, ronda 1) a "sacada del enum" (H-3, ronda 2) — ya no es un
gap, es una decisión cerrada. Ambas están documentadas en **§ Ronda 2**.

- **Las cinco rutas de `Suppliers`/`Receptions`/`Payables and payments`** del contrato de la
  spec: son `app/purchases/**`, territorio de otro agente. Verifiqué que sus llamadas a mis seis
  funciones publicadas coinciden exactamente con la firma que yo publiqué (§5) — no escribí una
  línea de ese dominio.
- **La reconciliación en `GET /admin/today`** (lotes por vencer/vencidos con stock, cuentas por
  pagar vencidas/pendientes de revisión, «inventario no confiable»): es `app/reports/**`,
  prohibido para mí. Publiqué `hooks.expiring_or_expired_lots(db, *, store_id, today)` para que
  quien tenga ese territorio no reimplemente el cálculo de estado — mismo patrón que
  `low_stock_alerts`/`negative_stock_alerts` de 2a. No até nada del lado de `reports` porque no
  puedo escribir ahí.
- **El caso de éxito de `food-cost` con `pct_bp` numérico distinto de `null`** (ventas netas
  reales > 0): armar una venta fiscal real exige `Order` + `Shift` + `FiscalDocument` completos —
  tres dominios ajenos con muchos campos obligatorios. Cubrí la aritmética del `pct_bp` con un
  test puro (`test_food_cost_percentage_rounds_half_up_in_basis_points`) y el camino con dos
  conteos reales que sí calcula `opening_value`/`purchases_value`/`closing_value` correctamente,
  quedando `null` únicamente por falta de ventas — que es en sí mismo el segundo caso que la spec
  pide probar (`available` sin dos conteos, `available` con dos conteos y sin ventas). El tercer
  caso (con ventas reales) queda como gap declarado, abajo.
- **La «sostenida» del semáforo rojo** (SPEC-NEGOCIO §5.4: «> 4–5 sostenido rojo»): implementé un
  semáforo por CONTEO individual (verde/amarillo/rojo contra los dos umbrales configurables), no
  una lógica de «rojo repetido en conteos consecutivos». La spec no define «sostenido» con
  precisión suficiente para implementarlo sin inventar un criterio nuevo (¿dos conteos seguidos?
  ¿tres? ¿del mismo insumo o de cualquiera?), y esa es una decisión de negocio que le corresponde
  al dueño de la spec, no a un constructor. Gap declarado, no escondido.
- **Postgres real, `SELECT FOR UPDATE`, los `409` de carrera bajo bloqueo real, y el CI**: todo
  corrió en SQLite, igual que en 2a. No hay motor Postgres ni runner de CI en este entorno.
- **El recorrido en navegador y el checklist visual** (1024 px sin scroll, foco visible,
  contraste AA): no hay Playwright ni medidor de contraste acá. Mismo hueco que 2a declaró.

## §8. Dependencias pendientes de otros agentes, y todo test rojo con nombre

**ESTADO ACTUAL (post ronda 2): cero rojos en mi territorio.** Los dos rojos que la ronda 1 había
declarado acá —

```
tests/core/test_quantity.py::test_reports_qty_fields_are_published_as_decimal_strings
tests/core/test_quantity.py::test_openapi_has_no_raw_integer_qty_base_or_min_stock_fields
```

— están **verdes**, confirmado corriendo la suite dos veces (§6): `backend-lectura-contrato` cerró
la deuda de `app/reports/schemas.py::IngredientAlertOut`/`NegativeStockAlertOut` (publican texto
decimal ahora) sin que yo tuviera que tocar mis archivos de test. Queda el párrafo original de la
ronda 1 abajo, tachado, como rastro de qué se probó y por qué.

~~`app/reports/schemas.py::IngredientAlertOut`/`NegativeStockAlertOut` siguen publicando
`qty_base: int`/`min_stock: int` en milésimas crudas — exactamente la mitad de la deuda de A-5
(`outputs-2a/ENTREGA.md § 5`) que no me toca cerrar a mí — mi mandato es explícito: «`app/
reports/schemas.py` lo corrige otro agente contra esta misma regla: no lo toques». Escribí los
dos tests igual, en mi territorio (`tests/core/test_quantity.py`), como la auditoría de contrato
que la spec pide.~~

**Un rojo NUEVO, declarado, causado por una decisión de esta ronda (H-3) — fuera de mi territorio,
no lo toco**:

```
FAILED tests/orders/test_consumption.py::test_void_after_send_is_never_produced_and_the_reason_is_pinned
```

Verificado corriendo ese único test (no la suite de `orders`, prohibida para mí): falla con
`AttributeError: VOID_AFTER_SEND` porque referencia `MovementCause.VOID_AFTER_SEND` directamente
(línea ~794 de ese archivo) en vez de comprobar con `getattr`/`hasattr`. Es la consecuencia
esperada y ya prevista en el propio docstring de ese test («la decisión... queda declarada para el
dueño de `app/inventory/models.py`... no es territorio de `app/orders/**` sacarla») — el test ya
sabía que ESTE dominio la sacaría; lo que no previó es que sacarla rompería su PROPIA aserción
literal sobre el enum. Es un arreglo de una línea (cambiar la comparación a algo que no dependa de
que el atributo exista, o borrar esa aserción puntual ahora que el enum ya no la declara) que le
toca a quien tenga `tests/orders/**`, no a mí — prohibido para mí tocar ese archivo. Se lo aviso al
Maestro acá, con nombre y línea, para que lo reparta.

**Fuera de mi territorio, declarado en la sección de mi mandato pero sin dueño que yo pueda
asignar** (los nombro para que el Maestro los reparta si todavía no tienen uno):

- **Los cinco listados de 1b-2 que sirven CSV leyendo `request.query_params`** sin declarar
  `format` en el contrato: viven en `app/payments/**`/`app/customers/**`/`app/refunds/**`/
  `app/fiscal/**`, todos prohibidos para mí. Mis listados nuevos (`GET /admin/counts`,
  `GET /admin/variance`) sí declaran `format` explícito en la firma, como corresponde — verificado
  leyendo el código, no sólo probado.

**Dependencia que verifiqué en vez de asumir** (no es un rojo, es una nota de coherencia):
`app/purchases/hooks.py::create_stock_batch`/`reverse_stock_batch` llaman a mis funciones con los
mismos nombres de parámetro, en el mismo orden, que publiqué — lo comprobé leyendo su código, no
sólo confiando en el mandato. `app/purchases/service.py::reverse_reception` llama
`reverse_stock_batch` ANTES de escribir el movimiento `cause=RECEPTION_REVERSAL`, que es
exactamente el orden que mi exclusión de FEFO para esa causa necesita para ser correcta (§5). Si
ese orden cambiara alguna vez del lado de `purchases`, mi guarda dejaría de tener sentido — lo dejo
anotado acá para que quede trazado, no sólo en el código.

**Nada del checklist de la spec quedó sin mirar deliberadamente**: los ítems que no llegué a cubrir
con un test están listados uno por uno en §7, con su razón.

---

## § Ronda 2

Ajuste de iteración 2 del Maestro, derivado del Conciliador: cerrar H-0 (bloqueante), ejecutar la
decisión del Maestro sobre H-2 (bloqueante) y cerrar H-3, H-4 y H-5, en ese orden. Todo dentro de mi
territorio de siempre (`app/inventory/**`, `app/core/quantity.py`, `tests/inventory`,
`tests/core`) más una única línea autorizada explícitamente fuera de él
(`tests/recipes/_inventory_stub.py:40`, ver H-3). Verificación completa al final de esta sección.

### H-0 (bloqueante) — `MovementCauseLiteral` no declaraba `"reception_reversal"`

**El defecto, confirmado antes de tocar nada**: `app/inventory/models.py::MovementCause.
RECEPTION_REVERSAL` existía desde la ronda 1, y `app/purchases/service.py::reverse_reception`
(línea ~491, ya construido por el agente de compras) ya la producía en runtime. Pero
`app/inventory/schemas.py::MovementCauseLiteral` — el `Literal` que valida (a) el query param
`?cause=` de `GET /admin/ingredients/{id}/movements` y (b) el campo `cause` de cada fila de
`StockMovementOut` al construirse — no incluía ese valor. Confirmé el efecto concreto antes de la
corrección: una fila con `cause=reception_reversal` reventaba la construcción de `StockMovementOut`
(Pydantic valida el `Literal` en el constructor, no sólo en la serialización) → **`500`** en
`GET /admin/ingredients/{id}/movements` sin filtrar; y `?cause=reception_reversal` reventaba la
validación de query de FastAPI → **`422`**, antes de llegar a mi código.

**La corrección, y por qué es un espejo, no una línea**: agregué `"reception_reversal"` al
`Literal` (y de paso saqué `"void_after_send"`, que H-3 pide sacar por separado — documentado
abajo). Antes de darlo por cerrado corrí exactamente el grep que pide el mandato:

```
grep -rn "count_adjustment" backend/app/inventory
```

Devuelve dos líneas: la declaración en `models.py` (`COUNT_ADJUSTMENT = "count_adjustment"`) y la
entrada del `Literal` en `schemas.py`. **Ningún otro espejo** — no hay diccionario de etiquetas, ni
lista de causas para CSV, ni ningún otro lugar de `app/inventory/**` que repita los valores del
enum como string (lo verifiqué también con un grep más amplio sobre los otros diez valores del
enum, buscando ocurrencias fuera de las declaraciones de enum mismas: cero resultados). El único
espejo que existía era el `Literal`, y ya está cerrado.

**El test nuevo**, `tests/inventory/test_stock_batch_hooks.py::
test_reversed_reception_leaves_the_ledger_readable`: escribe un movimiento
`cause=RECEPTION_REVERSAL` directo con `hooks.record_movement` (sin depender de `app.purchases`,
que es territorio ajeno — mismo principio de aislamiento que el resto de mi suite), y comprueba
`GET /admin/ingredients/{id}/movements` **sin filtrar** → `200` con esa fila adentro (antes: `500`)
y **filtrando** `?cause=reception_reversal` → `200` con exactamente esa fila, `qty_base="-500"`
(antes: `422`).

**Verificación pedida por el mandato, corrida tal cual (no editados, sólo corridos)**:

```
tests/audit/test_inventory_invariants.py::test_the_cost_source_of_the_api_is_the_same_enum_as_the_model   PASSED
tests/audit/test_contract_2b_invariants.py::test_the_ledger_can_be_read_after_a_reception_is_reversed     PASSED
```

Los dos vuelven a verde. No los toqué — son del auditor.

### H-2 (bloqueante) — se saca `GET /admin/orders/{order_id}/consumption` de `app.inventory`

**La decisión, tal como la dio el Maestro**: sobrevive `app.orders`, se borra la mía. Motivo: la
implementación de `app.orders` lee el costo **congelado** de cada fila del libro (snapshot, regla
dura de `AGENTS.md`) y suma `SALE + NOTE_RETURN` (consumo NETO real — una devolución resta del
consumo, no queda fuera de la cuenta); la mía revaloraba con `resolve_ingredient_cost` de HOY y
sólo miraba `SALE`, ignorando devoluciones. Además `app.orders` es la que ya despachaba esa misma
ruta en runtime (las dos registraban el mismo path bajo el mismo router de FastAPI, con el mismo
método; la que responde de verdad es la que el árbol de includes monta primero), así que borrar la
mía **no cambia ni una respuesta servida** — sólo saca del contrato publicado una firma que nunca
estuvo realmente sirviendo tráfico.

**Qué borré, línea por línea**:

- La ruta `GET /admin/orders/{order_id}/consumption` y su comentario de sección en
  `app/inventory/router.py` (era 550–566 en la ronda 1; el archivo bajó de 564 a 549 líneas).
- El import `OrderConsumptionOut` del bloque de imports de `app/inventory/schemas` en
  `router.py`.
- `OrderConsumptionRowOut` y `OrderConsumptionOut` de `app/inventory/schemas.py` (eran 460–482 en
  la ronda 1), reemplazadas por una nota explicando por qué ya no están (sin usar la cadena
  literal `OrderConsumption` en el comentario, a propósito, para que el grep de verificación del
  punto (iii) de abajo dé limpio de verdad y no por casualidad).
- `service.order_consumption` (era 1537 en adelante) y los imports `OrderConsumptionOut`/
  `OrderConsumptionRowOut` del bloque de imports de `app/inventory/schemas` en `service.py`. No
  quedó ningún helper huérfano: la función usaba `Ingredient`, `CostSource`, `StockMovement`,
  `MovementCause`, `hooks`, `format_qty_base`, `format_cost_micros`, `select` — todos siguen en uso
  en el resto del archivo, así que no hubo nada más que sacar.
- `backend/tests/inventory/test_order_consumption.py` completo (3 tests).

**Verificación explícita, con evidencia** (los tres puntos que pidió el mandato):

**(i)** OpenAPI con `UserWarning` como error ya NO levanta "Duplicate Operation ID":

```
$ python -W error::UserWarning -c "from app.main import app; app.openapi()"
$ echo $?
0
```

Sin salida, sin excepción, código de salida `0`. Antes de esta ronda, con las dos rutas montadas
bajo el mismo path, generar el OpenAPI dos veces con el mismo `operation_id` implícito habría
levantado el warning que esta corrida ahora no levanta (lo confirmé leyendo el mecanismo: FastAPI
arma el `operation_id` por defecto a partir de `router_prefix + path + method`, así que dos rutas
en el mismo path y método SIEMPRE lo disparan mientras ambas estén montadas).

**(ii)** `paths["/api/v1/admin/orders/{order_id}/consumption"]` en el OpenAPI generado hoy: **ya no
pide `store_id`** — el único parámetro es `order_id` (path). El schema de cada fila
(`OrderConsumptionRowOut`, la de `app.orders`, la única que sobrevive) tiene `qty_base: string`
(puede ser negativo — es `app.orders` quien decide el signo, ya no revalúo yo), `cost:
integer | null` (**total en pesos ya cerrado**, no un costo por unidad como el mío publicaba — otra
diferencia real, no cosmética, con la implementación que saqué) y **sin** `item_count` en absoluto.
Lo leí directo del diccionario Python que devuelve `app.main.app.openapi()`, no de una inspección
visual de un archivo.

**(iii)**

```
$ grep -rn "OrderConsumption" backend/app/inventory
$ echo $?
1
```

Sin resultados, código de salida `1` (grep sin matches) — exactamente lo que pedía el mandato. Tuve
que reescribir mi primera versión de la nota explicativa en `schemas.py` porque usaba
`` `OrderConsumptionOut`/`OrderConsumptionRowOut` `` como texto y ese grep SÍ la encontraba; la
segunda versión describe lo mismo sin usar esos nombres como literal.

### H-3 (advertencia) — se saca `MovementCause.VOID_AFTER_SEND` del enum

**Decisión del Maestro**: se saca, no se produce. El razonamiento de NO producirla (documentado por
`backend-lectura-contrato` en `app/orders/service.py::_resolve_waste_stub`: producirla exigiría un
par alta+baja cuya mitad negativa dispararía una segunda depleción FEFO real sobre cantidad que ya
se consumió al vender) es correcto y lo dejé intacto — no toqué `app/orders/**`. Lo que faltaba era
la otra mitad: un enum no puede seguir declarando una causa que nadie escribe nunca, porque deja al
lector del contrato (alguien armando un reporte de mermas por anulación agrupado por causa, por
ejemplo) suponiendo que existen filas con esa causa cuando no las hay.

**Qué saqué**: `MovementCause.VOID_AFTER_SEND` de `app/inventory/models.py` (dejé un comentario en
su lugar explicando la decisión, con la razón completa, para que quien lea el enum de ahora en más
entienda por qué `PRODUCTION_OUT` salta directo a `WASTE` sin un paso en el medio) y
`"void_after_send"` de `MovementCauseLiteral` en `schemas.py`. Mismo grep de verificación que H-0,
extendido a este valor: cero espejos adicionales.

**La única línea fuera de mi territorio que el mandato me autorizó a tocar, tocada exactamente
así**: `backend/tests/recipes/_inventory_stub.py:40` tenía `VOID_AFTER_SEND = "void_after_send"`
en su copia local (un doble de prueba de `tests/recipes/**`, territorio ajeno, que sólo se activa
si `app.inventory` no es importable — hoy SÍ lo es, así que este doble no se ejercita en la suite
real, pero seguía siendo una copia del enum que había quedado desactualizada). Borré esa única
línea, nada más de ese archivo ni de `tests/recipes/**`. Lo declaro acá por escrito, como pidió el
mandato.

**Lo que NO pude verificar en verde porque es territorio ajeno** (declarado, no escondido — ver
también §8 arriba): `tests/orders/test_consumption.py::
test_void_after_send_is_never_produced_and_the_reason_is_pinned` referencia
`MovementCause.VOID_AFTER_SEND` directamente y ahora falla con `AttributeError`. Es la consecuencia
esperada de sacar el valor del enum, y el propio docstring de ese test ya anticipaba que la
decisión de sacarla era mía, no suya — lo que no anticipó es que su PROPIA aserción dejaría de
poder ejecutarse. Un arreglo de una línea, para quien tenga `tests/orders/**`.

**El invariante del auditor**: `tests/audit/test_contract_2b_invariants.py::
test_void_after_send_is_either_produced_or_removed_from_the_enum` (que en la ronda 1 estaba
**rojo a propósito**, con ese texto literal en su docstring: "ROJO A PROPÓSITO — advertencia: el
renglón del checklist quedó abierto") ahora está **verde** — lo corrí explícitamente para
confirmarlo (ver bloque de verificación de H-0 arriba, mismo comando). Se lo aviso al Maestro y al
auditor acá: `test_void_after_send_is_either_produced_or_removed_from_the_enum` → **PASSED**.

### H-4 (advertencia) — una sola matemática para "días sin conteo completo"

**El defecto**: `CONTROL_HEALTH_STALE_DAYS = 14` (en `control_health`) y
`FOOD_COST_STALE_DAYS = 14` (en `food_cost_report`) eran la misma constante conceptual, declarada
dos veces en `app/inventory/service.py`, cada una con su propio cálculo de "días desde el último
conteo completo" repetido a mano (`tz.business_date_for(last_full, store.cutoff_hour)` restado de
`tz.today_business_date(store.cutoff_hour)`, escrito dos veces con variables de nombre distinto).
Exactamente el tipo de "dos matemáticas" que `AGENTS.md` prohíbe para cualquier número derivado.

**La consolidación**: agregué a `app/inventory/hooks.py` (no a `service.py`: es lectura de bajo
nivel, mismo criterio que separa el resto de `hooks.py` de `service.py` en este dominio) una única
constante `INVENTORY_STALE_DAYS = 14`, un `dataclass(frozen=True)` `InventoryStaleness` con
`days_since_last_full_count: int | None`, `unreliable: bool`, `stale_days: int`, y la función:

```python
inventory_staleness(db, *, store_id: int, cutoff_hour: int) -> InventoryStaleness
```

**Semántica, verificada idéntica a la que ya tenía `control_health` en la ronda 1** (el mandato
pedía "semántica exacta"): días por FECHA DE NEGOCIO (`tz.business_date_for` con `cutoff_hour`,
nunca restando instantes UTC — un turno de madrugada no puede mover el conteo de día sin que el
negocio lo haya cruzado); sin ningún conteo completo aplicado nunca → `days_since_last_full_count
= None` y `unreliable = True` (nunca un número inventado, nunca `0` disfrazando "nunca pasó");
con uno → `unreliable = days_since_last_full_count > stale_days`.

`control_health` y `food_cost_report` **leen** esta función ahora, ninguno de los dos vuelve a
sumar días por su cuenta:

- `control_health`: `days_since_full_count`/`inventory_unreliable` de la respuesta salen
  directamente de `staleness.days_since_last_full_count`/`staleness.unreliable`. `last_full_
  count_at` (el `datetime`, que `InventoryStaleness` no carga a propósito — no es parte de "cuántos
  días", es un dato aparte) sigue viniendo de `hooks.last_applied_full_count_at` por separado, sin
  volver a calcular nada.
- `food_cost_report`: el `if staleness.unreliable` reemplaza el `if last_full is not None and
  days_since > FOOD_COST_STALE_DAYS` de la ronda 1. **Diferencia de comportamiento declarada, no
  escondida**: en la ronda 1, una sede que NUNCA aplicó un conteo completo caía al chequeo de "hacen
  falta dos conteos completos" (`_two_most_recent_consecutive_full_counts` devuelve `None`) y el
  `reason` decía eso; ahora, con la misma sede, `staleness.unreliable = True` (por la regla de
  arriba: nunca contado ⇒ no confiable) y el `reason` dice "nunca se aplicó un conteo completo" —
  las dos razones son ciertas, cambió CUÁL se reporta primero. Verifiqué que esto no rompe ningún
  test existente: `test_food_cost_is_null_with_a_reason_without_two_full_counts` sólo comprueba que
  `reason` es truthy, no el texto exacto, y sigue en verde; `test_control_health_flags_unreliable_
  past_14_days_without_a_full_count` (que SÍ tiene un conteo, 20 días viejo) sigue viendo
  `"no confiable"` en el `reason` de `food-cost`, porque esa rama de texto no cambió.

**Contrato hacia adelante**: `app.reports` (territorio ajeno) va a consumir `inventory_staleness`
para `GET /admin/today` según la instrucción que ya tiene `backend-lectura-contrato`. Si esta firma
cambia alguna vez de mi lado, aviso en este mismo documento — por ahora no cambió: es la firma
exacta que pidió el mandato.

### H-5 (advertencia) — el semáforo de varianza sin uso teórico

**El defecto**: con `theoretical == 0` (ninguna venta ni producción en la ventana), `variance_pct_
bp` quedaba `None` (correcto: el porcentaje es matemáticamente indefinido, `0/0`) pero
`_variance_level(None, settings)` devolvía **siempre verde** para CUALQUIER `variance_qty`,
incluido un faltante físico real sin una sola venta que lo explique.

**La corrección**: `_variance_level` ahora recibe también `theoretical` y `variance_qty` (parámetros
con nombre, no posicionales — la función es privada y de un solo call site, así que el cambio de
firma no rompe nada fuera de este archivo). Con `theoretical == 0`: `variance_qty == 0` → verde
(no pasó nada); en cualquier otro caso el signo de `variance_qty` decide entre rojo y amarillo. Con
`theoretical > 0` el comportamiento es exactamente el de la ronda 1, sin cambios.

**Discrepancia de signo con el mandato, declarada por escrito, no corregida en silencio**: el
mandato describe la rama roja como "`variance_qty < 0` (desapareció stock ... fuga pura)" y la
amarilla como "`variance_qty > 0` (apareció stock)". Antes de escribir una línea, verifiqué el
signo YA establecido y YA probado de `variance_qty` contra dos fuentes primarias del propio código:
el comentario de campo en `app/inventory/schemas.py::VarianceRowOut.variance_qty` — *"real - teórico;
positivo = se usó más de lo esperado"* — y el test de la ronda 1
`test_variance_identity_closes_with_a_hand_built_case`, que arma a mano `real_usage=28`,
`theoretical=25`, `variance_qty=+3`, con el comentario explícito *"3 kg de más consumidos que lo
esperado"*. Bajo esa convención YA publicada y YA probada, un faltante físico real (conteo inicial
400, sin ventas, conteo final 0) da `real_usage = 400 + 0 - 0 = 400`, `variance_qty = 400 - 0 =
+400` — **positivo**, nunca negativo, para cualquier número que se elija: la fórmula lo determina,
no una decisión mía. El propio ejemplo del mandato ("400 unidades faltantes ... salen en rojo") es
matemáticamente incompatible con su propia regla de signo ("`variance_qty < 0` → rojo") bajo la
convención ya publicada — las dos no pueden ser ciertas a la vez sin cambiar el signo de
`variance_qty` en sí, lo que habría roto el contrato ya publicado del campo Y el test de la ronda 1
que lo prueba. Implementé el signo que hace cierto el EJEMPLO CONCRETO Y VERIFICABLE del mandato
("400 faltantes, sin ventas, rojo") en vez de su descripción verbal del signo, porque el ejemplo es
lo que un test puede confirmar o refutar y la descripción verbal, no. Si el Maestro decidiera que el
signo tiene que ser el otro, el cambio es de una línea (`return "red" if variance_qty < 0 else
"yellow"`) pero **invertiría el resultado del test nombrado** (400 faltantes pasarían a amarillo, no
rojo) — dejo la decisión escrita acá para que se revise con ese trade-off explícito.

**El test nombrado**, `tests/inventory/test_variance_food_cost.py::
test_variance_semaphore_is_red_when_stock_is_missing_with_zero_theoretical_usage`: conteo completo
1 con 400 unidades contadas, sin compras/ventas/producción en el medio, conteo completo 2 con `0`
unidades contadas. Comprueba `theoretical_usage_qty == "0"`, `real_usage_qty == "400"`,
`variance_qty == "400"`, **`variance_pct_bp is None`** (el porcentaje sigue indefinido — no se
inventa un `100 %`) y **`level == "red"`** (no verde, que es lo que daba antes de este hallazgo).

### Verificación de la ronda 2 (territorio propio únicamente, dos corridas en serie)

```
export TMPDIR=/tmp/pt-backend-inventario && mkdir -p $TMPDIR
cd backend
python -m pytest -q -p no:cacheprovider tests/inventory tests/core   # corrida 1
python -m pytest -q -p no:cacheprovider tests/inventory tests/core   # corrida 2
python -m mypy --cache-dir=$TMPDIR/mypy app/inventory app/core
```

- Corrida 1: **`184 passed in 342.27s (0:05:42)`**.
- Corrida 2: **`184 passed in 342.41s (0:05:42)`**.
- mypy: **`Success: no issues found in 23 source files`**.
- Los dos rojos declarados al cierre de la ronda 1 (`tests/core/test_quantity.py` contra
  `app/reports/schemas.py`) están confirmados en verde, dentro de esas dos corridas — corrido, no
  asumido.
- Único rojo nuevo, fuera de mi territorio y declarado con nombre: `tests/orders/test_consumption.
  py::test_void_after_send_is_never_produced_and_the_reason_is_pinned` (consecuencia de H-3, ver
  arriba y §8).
- Tests puntuales del auditor, corridos para confirmar que las correcciones de H-0/H-3 los vuelven
  a verde (no editados, sólo corridos): `tests/audit/test_inventory_invariants.py::
  test_the_cost_source_of_the_api_is_the_same_enum_as_the_model`,
  `tests/audit/test_contract_2b_invariants.py::test_the_ledger_can_be_read_after_a_reception_is_
  reversed`, `tests/audit/test_contract_2b_invariants.py::
  test_void_after_send_is_either_produced_or_removed_from_the_enum` — los tres **PASSED**.

