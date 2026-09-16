# Backend — Insumos, libro de movimientos y mermas (`backend-inventario`)

> **Actualización — Ronda 2 (ajuste quirúrgico sobre B-2 / conflict-002-b2).**
> El Conciliador detectó que `inventory` publicaba costo por unidad base
> como texto decimal (`format_cost_micros`, correcto) mientras `recipes`
> publicaba el mismo tipo de campo como pesos enteros redondeados
> (`micros_to_pesos`), porque el contrato numérico nunca dejó por escrito
> EN QUÉ ESCALA sale un costo publicado — sólo cómo se acumula y redondea
> internamente. Mi implementación no cambió (ni una línea de
> comportamiento de `app/core/quantity.py`): agregué la regla a los
> docstrings del módulo, de `micros_to_pesos` y de `format_cost_micros`
> (§1 más abajo, ya actualizado con el texto vigente), y un test de
> contrato nuevo (`tests/core/test_quantity.py::
> test_inventory_cost_fields_are_published_as_decimal_strings` /
> `test_recipes_cost_fields_are_published_as_decimal_strings`) que recorre
> las anotaciones de los esquemas publicados de los dos dominios y falla
> nombrando el campo si sale `int` en vez de `str | None`. El de `recipes`
> se importa protegido con `find_spec_safe` para no acoplarse a que ese
> dominio exista. `backend-recetas` corrigió sus esquemas
> (`PreparationAdminOut.unit_cost`, `PrepBatchAdminOut.total_cost`/
> `.unit_cost`, `ProductRecipeOut.theoretical_cost`) a `str | None` en esta
> misma ronda, en paralelo; mi test es el que lo deja clavado para que no
> se repita. Verificado de nuevo: `pytest tests/core tests/inventory` y
> `mypy app` en verde (detalle al final de §7).

Entregable del especialista en inventario y costos, pedido 2a
(`features/fase-2-costo-inventario/spec.md`). Construye el dominio nuevo
`app/inventory/**`: insumos, el libro único de movimientos con causa tipada,
stock teórico, mermas y ajustes manuales. Es también el dueño del contrato
numérico (`app/core/quantity.py`) que importan los otros agentes de 2a.

**No toca** `app/recipes/**` (fichas técnicas y preparaciones, territorio de
`backend-recetas`), `app/orders/**`, `app/reports/**`, `app/catalog/**`,
`app/stores/**`, `app/notifications/**`, `app/main.py`,
`app/core/models_registry.py`, ni ningún otro archivo de `app/core/` más
allá de `app/core/quantity.py`.

---

## 1. El contrato numérico (`app/core/quantity.py`)

Transcrito literal — es lo que el resto del equipo cita. **Nadie lo
redefine ni lo aproxima con otra escala.**

**EN QUÉ ESCALA SALE UN COSTO** (regla agregada en Ronda 2, sin cambiar
comportamiento — ver aviso al comienzo de este documento): este módulo
publica costos en dos formas, intercambiables sólo dentro de cada una,
nunca entre sí.

- **`format_cost_micros` es la ÚNICA forma correcta de publicar un costo
  POR UNIDAD BASE** (por gramo, por mililitro, por unidad): todo `cost`/
  `official_cost`/`estimated_cost` de `app.inventory.schemas` y todo
  `unit_cost`/`total_cost`/`theoretical_cost` de `app.recipes.schemas`.
  Texto decimal, precisión completa. Ejemplo concreto del propio docstring:
  la sal de mesa del seed cuesta $0,003/g (`cost_source="official"`);
  `format_cost_micros(3_000)` publica `"0.003"`. Pasar ese mismo `3_000`
  por `micros_to_pesos` en cambio, daría `0` — un costo oficial real leído
  como si no hubiera costo, el cero mudo que SPEC-NEGOCIO §4.1 prohíbe.
- **`micros_to_pesos` queda acotada a TOTALES DE PLATA de venta ya
  cerrados** (el snapshot `order_items.unit_cost`, un total de reporte),
  redondeando **una sola vez, al cerrar el total** — nunca por ítem, nunca
  por gramo, nunca dentro de una ficha o cadena de preparaciones.
- Probado por anotación de tipo: `tests/core/test_quantity.py::
  test_inventory_cost_fields_are_published_as_decimal_strings` y
  `::test_recipes_cost_fields_are_published_as_decimal_strings` recorren
  los esquemas publicados de los dos dominios y fallan si un campo de
  costo sale `int` en vez de `str | None`.

```python
QTY_SCALE = 1000
COST_SCALE = 1_000_000


def line_cost_micros(qty_base: int, cost_micros: int) -> int:
    """Costo de una línea, en millonésimas de peso.

    `qty_base` en milésimas de la unidad base; `cost_micros` en millonésimas
    de peso por unidad base ENTERA (no por milésima). División entera
    (trunca): el residuo de truncar cada línea es el precio de no redondear
    a pesos todavía — se sigue acumulando en millonésimas hasta el borde, así
    que ese residuo nunca se pierde de verdad, sólo viaja sin redondear.
    """
    return qty_base * cost_micros // QTY_SCALE


def micros_to_pesos(micros: int) -> int:
    """Redondeo half-up de millonésimas de peso a pesos enteros. Acotada a
    TOTALES DE PLATA DE VENTA ya cerrados (`order_items.unit_cost`, un
    total de reporte), redondeando UNA sola vez al cerrar el total — nunca
    por ítem, nunca por gramo, nunca dentro de una ficha o cadena de
    preparaciones (ahí el redondeo intermedio subestima costos en cadena).
    NUNCA para publicar un costo por unidad base (`format_cost_micros` es
    esa función): la sal de mesa del seed a $0,003/g pasada por acá da `0`
    — el cero mudo que §4.1 prohíbe.
    """
    if micros >= 0:
        return (micros + COST_SCALE // 2) // COST_SCALE
    return -((-micros + COST_SCALE // 2) // COST_SCALE)


def apply_yield(qty_base: int, yield_pct: int) -> int:
    """Cantidad a descontar del insumo dado lo que la receta pide LIMPIO.

    La ficha expresa cantidad limpia (lo que el cocinero pesa después de
    pelar/deshuesar); el consumo teórico tiene que descontar más que eso,
    porque el insumo bruto rinde menos. `qty_base ÷ (yield_pct / 100)`,
    redondeado **hacia arriba** (`ceil`), nunca hacia abajo: redondear hacia
    abajo subestima el consumo — es el modo de falla documentado de la
    referencia, donde todos los costos quedaban subestimados y la varianza
    se leía como robo crónico. `yield_pct` es entero 1..100 (100 = sin
    merma, la cantidad no cambia).

    `apply_yield(qty_base, yield_pct) == -(-qty_base * 100 // yield_pct)`
    (truco de la doble negación para `ceil` con división entera de Python,
    que trunca hacia `-inf`, no hacia cero).
    """
    # valida 1 <= yield_pct <= 100, si no: 400 VALIDATION_ERROR
    return -(-qty_base * 100 // yield_pct)


def parse_qty_base(value: str, *, field: str = "qty") -> int:
    """String decimal ("18.5") -> entero en milésimas de la unidad base.
    Rechaza `float` de Python y cualquier valor con más de tres decimales
    con 400 VALIDATION_ERROR. Acepta coma o punto decimal."""


def format_qty_base(qty_base: int) -> str:
    """Inverso de `parse_qty_base`. 1250 -> "1.25"; -400 -> "-0.4"; 3000 -> "3"."""


def parse_cost_micros(value: str, *, field: str = "cost") -> int:
    """String decimal de PESOS por unidad base entera -> millonésimas
    (`COST_SCALE`). "18000.5" -> 18_000_500_000. Rechaza `float`, negativos
    y más de seis decimales."""


def format_cost_micros(micros: int) -> str:
    """Inverso de `parse_cost_micros`: la ÚNICA forma correcta de publicar
    un costo por unidad base en cualquier esquema de `inventory`/`recipes`
    (`IngredientOut.cost`/`.official_cost`/`.estimated_cost`,
    `StockRowOut.cost`, `StockMovementOut.cost`, `WasteAdminOut.cost`,
    `PreparationAdminOut.unit_cost`, `PrepBatchAdminOut.total_cost`/
    `.unit_cost`, `ProductRecipeOut.theoretical_cost`). Sin redondear
    (precisión completa) — redondear acá es el cero mudo que §4.1 prohíbe.
    """
```

**Por qué cada decisión** (docstring completo del archivo):

- **Milésimas y no gramos/mililitros enteros**: un insumo puede recetarse en
  fracciones finas (0,5 g de un saborizante) y el `yield`/la cascada de
  sustituto encadenan divisiones; milésimas da margen sin más escala.
- **Millonésimas de peso y no pesos enteros por línea**: acumular a pesos
  línea por línea en una ficha de varios insumos arrastra un redondeo por
  línea — el food cost teórico se desvía sistemáticamente. Se acumula en
  millonésimas a lo largo de TODA la ficha y sólo se redondea a pesos en el
  borde (`micros_to_pesos`), una sola vez.
- **`apply_yield` redondea hacia arriba a propósito**: subestimar el costo
  es el modo de falla documentado de la referencia.
- **`null` ≠ `0`**: `cost_micros=None` viaja siempre junto con
  `cost_source=CostSource.NONE`; nunca un cero mudo, en ningún camino.
- **Parseo de entrada en el borde**: el cliente manda cantidad y costo como
  string decimal, nunca como número JSON; se convierte con `Decimal` acá y
  se guarda `int`. Los esquemas de entrada (`app/inventory/schemas.py`)
  declaran estos campos como `str`, así que un `float` de JSON ya lo
  rechaza la validación de Pydantic antes de llegar a estas funciones; las
  funciones además defienden el mismo contrato para quien las llame directo.

**Probado** en `tests/core/test_quantity.py` (25 tests, +2 en Ronda 2):
propiedad sobre 1.000 casos aleatorios (`random.Random(20260915)`) de que
`0,1 + 0,2` de la unidad base da exactamente `0,3` (`100 + 200 == 300` en
milésimas) y que la suma de N cantidades es asociativa y conmutativa
exacta, contra `Decimal` puro; `apply_yield` numérico explícito (850
milésimas al 85 % → descuenta 1000; 100 % → identidad; redondeo hacia
arriba cuando no es exacto); `line_cost_micros`/`micros_to_pesos` con un
caso que demuestra por qué NO se redondea línea por línea (tres líneas de
0,167 g a $3/g: redondeado por
línea suman $3, acumulado y redondeado una vez da $2 — la cifra correcta);
`parse_qty_base`/`parse_cost_micros` rechazando `float`, exceso de
decimales y basura; round-trip completo `parse_*` ↔ `format_*` sobre 500
casos aleatorios cada uno; **(Ronda 2)** contrato de publicación —
`test_inventory_cost_fields_are_published_as_decimal_strings` y
`test_recipes_cost_fields_are_published_as_decimal_strings` recorren
`model_fields[...].annotation` de los esquemas publicados de los dos
dominios (`IngredientOut.cost`/`.official_cost`/`.estimated_cost`,
`StockMovementOut.cost`, `StockRowOut.cost`, `WasteAdminOut.cost` de
`inventory`; `PreparationAdminOut.unit_cost`, `PrepBatchAdminOut.total_cost`/
`.unit_cost`, `ProductRecipeOut.theoretical_cost` de `recipes`, importado
protegido con `find_spec_safe`) y fallan nombrando el campo exacto si sale
`int` en vez de `str | None` — el test que deja clavada la corrección de
B-2 para que no se repita.

---

## 2. Firmas exactas de `app/inventory/hooks.py`

```python
def record_movement(
    db: Session, *, organization_id: int, store_id: int,
    ingredient_id: int | None = None, preparation_id: int | None = None,
    qty_base: int,                     # signo: negativo = salida, positivo = entrada
    cause: MovementCause,
    cost_micros: int | None, cost_source: CostSource,
    actor: Actor, business_date: date, at: datetime,
    ref_type: str | None = None, ref_id: int | None = None,
    note: str | None = None,
) -> StockMovement: ...

def resolve_ingredient_cost(db: Session, ingredient: Ingredient) -> tuple[int | None, CostSource]: ...
def current_stock(db: Session, *, store_id: int, ingredient_id: int | None = None, preparation_id: int | None = None) -> int: ...
def get_ingredient(db: Session, *, store_id: int, ingredient_id: int) -> Ingredient | None: ...
def low_stock_alerts(db: Session, *, store_id: int) -> list[dict]: ...
def negative_stock_alerts(db: Session, *, store_id: int) -> list[dict]: ...
def resolve_consumption_target(db: Session, ingredient: Ingredient, qty_base: int) -> list[tuple[Ingredient, int]]: ...
```

Notas de comportamiento vinculantes:

- **`record_movement` es la ÚNICA escritura de inventario del sistema
  entero.** Nadie hace `db.add(StockMovement(...))` fuera de acá, ni
  siquiera otro archivo de este mismo dominio (`service.py` la llama, nunca
  la esquiva).
- Valida **antes** de escribir (insumo XOR preparación, `qty_base != 0`,
  `cost_source` consistente con `cost_micros`, actor identificado) — nunca
  bloquea por stock insuficiente: vender con stock en cero o negativo no es
  un error de esta función.
- **Fusión automática**: si `ref_type` y `ref_id` vienen los dos y ya existe
  un movimiento con el mismo `(organization_id, store_id, ingrediente o
  preparación, cause, ref_type, ref_id)`, la llamada se fusiona en esa fila
  (`qty_base` se suma) en vez de crear una fila nueva. Esto resuelve
  "consumos del mismo insumo en una comanda se fusionan en un movimiento"
  (SPEC-NEGOCIO §5.3) **dentro del hook**, sin que cada llamador (recipes,
  orders) tenga que pre-agregar por su cuenta antes de llamar. Una venta y
  su reversión ("vuelve") usan causas distintas (`sale` vs `note_return`) y
  por lo tanto NUNCA se fusionan entre sí, aunque compartan `ref`.
- `resolve_ingredient_cost`: oficial → estimado → `(None, CostSource.NONE)`.
  Los otros dos escalones (`weighted_average`, `last_purchase`) son de 2b.
- `resolve_consumption_target`: un solo camino de consumo con cascada al
  sustituto. Toma de cada insumo hasta su stock disponible (nunca negativo)
  antes de caer al siguiente; lo que sobra al final de la cadena (sin más
  sustituto, o un ciclo detectado — protegido con `visited: set[int]`) se
  apila en el último insumo, que sí puede quedar negativo. La suma de
  cantidades devueltas es siempre exactamente `qty_base`. Venta, cortesía,
  `staff_meal` y producción tienen que llamar **esta misma función**, nunca
  decidir el sustituto cada uno por su cuenta.
- `low_stock_alerts`/`negative_stock_alerts`: dos funciones distintas, dos
  formas de dict distintas. `negative_stock_alerts` incluye
  `negative_since` (ISO, o `null`) y `probable_cause` (el valor de
  `MovementCause` que concentra más cantidad de salida dentro de la racha
  negativa actual — nunca un texto libre).

---

## 3. Los tres enums completos (`app/inventory/models.py`)

```python
class MovementCause(str, enum.Enum):
    SALE = "sale"
    PRODUCTION_IN = "production_in"
    PRODUCTION_OUT = "production_out"
    VOID_AFTER_SEND = "void_after_send"
    WASTE = "waste"
    NOTE_RETURN = "note_return"
    MANUAL_ADJUSTMENT = "manual_adjustment"
    # Declaradas para 2b, sin uso en 2a:
    PURCHASE = "purchase"
    COUNT_ADJUSTMENT = "count_adjustment"
    TRANSFER_IN = "transfer_in"
    TRANSFER_OUT = "transfer_out"


class CostSource(str, enum.Enum):
    OFFICIAL = "official"
    # Declarados para 2b, sin uso en 2a:
    WEIGHTED_AVERAGE = "weighted_average"
    LAST_PURCHASE = "last_purchase"
    ESTIMATED = "estimated"
    NONE = "none"


class WasteType(str, enum.Enum):
    EXPIRED = "expired"
    OVERPRODUCTION = "overproduction"
    KITCHEN_ERROR = "kitchen_error"
    BREAKAGE = "breakage"
    CUSTOMER_RETURN = "customer_return"
    TASTING = "tasting"
    COURTESY_NO_DISH = "courtesy_no_dish"
    UNIDENTIFIED = "unidentified"
    # NO existe staff_meal: es canal de comanda (app.orders), no merma.
```

También publicado, aunque no es un enum de negocio: `BaseUnit` (`g`, `ml`,
`unit`).

**Nota de implementación importante para quien escriba raw SQL o
migraciones contra estas tablas**: `sa.Enum(pyenum, native_enum=False)`
persiste el **nombre** del miembro de Python (`"SALE"`, `"NONE"`, mayúscula),
no su `.value` (`"sale"`, `"none"`). Los `CheckConstraint` de
`stock_movements`/`wastes` que comparan `cost_source` contra un literal SQL
usan `'NONE'` (mayúscula) por eso — se verificó empíricamente antes de
fijarlo, porque el primer intento con `'none'` (minúscula, el `.value`)
rompía el `CheckConstraint` en cada inserción válida. Todo el resto del
código Python compara contra el enum o contra `.value` normalmente (Pydantic
serializa siempre `.value` hacia el JSON), así que esto sólo importa para
quien escriba SQL crudo.

---

## 4. Endpoints

Todos bajo `/api/v1`. `Ingredient` es **dato maestro sin flag propia**
(decisión declarada más abajo en gaps/decisiones); `inventory.perpetual`
gatea movimientos/stock/ajustes, `inventory.waste` gatea mermas.

| Método y ruta | Payload | Errores de negocio | Flag |
|---|---|---|---|
| `GET /admin/ingredients?store_id&active_only&format` | — | — | ninguna |
| `POST /admin/ingredients?store_id` | `IngredientIn` (ver abajo) | `400 MIN_STOCK_REQUIRED`, `400 VALIDATION_ERROR`, `404` (sustituto inexistente) | ninguna |
| `PATCH /admin/ingredients/{id}` | `IngredientUpdateIn` (parcial, con `clear_official_cost`/`clear_estimated_cost`/`clear_substitute` explícitos) | `400 MIN_STOCK_REQUIRED`, `400 VALIDATION_ERROR` (sustituto = sí mismo), `404` | ninguna |
| `DELETE /admin/ingredients/{id}` | — | `404` | ninguna (baja lógica, nunca `DELETE` de fila) |
| `GET /admin/ingredients/{id}/movements?from&to&cause&format` | — | `400 VALIDATION_ERROR` (fecha/causa inválida vía FastAPI `Query`), `404` | `inventory.perpetual` |
| `GET /admin/inventory/stock?store_id&critical_only&below_min&negative&format` | — | — | `inventory.perpetual` |
| `POST /admin/inventory/adjustments?store_id` (Idempotency-Key) | `AdjustmentIn {ingredient_id, qty_delta, reason, authorizer_pin}` | `400 IDEMPOTENCY_KEY_REQUIRED`, `400 AUTHORIZATION_INVALID`, `400 PIN_LOCKED`, `400 VALIDATION_ERROR` (delta cero), `404`, `409 IDEMPOTENCY_MISMATCH`/replay | `inventory.perpetual` |
| `POST /waste` (dispositivo, Idempotency-Key) | `WasteIn {ingredient_id\|preparation_id, qty, type, note?, employee_pin, photo?}` | `400 IDEMPOTENCY_KEY_REQUIRED`, `400 AUTHORIZATION_INVALID`, `400 PIN_LOCKED`, `400 VALIDATION_ERROR`, `404` | `inventory.waste` |
| `GET /admin/waste?store_id&from&to&type&employee_id&format` | — devuelve `{items, weekly_kpi: {ratio: null, label: "sin datos"}}` | — | `inventory.waste` |
| `GET /device/ingredients` | — devuelve `[{id, name, base_unit}]`, **sin ningún campo de costo** | `401` (sin dispositivo activado) | ninguna |

`IngredientIn`: `{name, category?, base_unit: "g"|"ml"|"unit", purchase_unit,
purchase_factor (int > 0), yield_pct (1..100, default 100), official_cost?
(string decimal, pesos por unidad base), estimated_cost? (ídem), min_stock
(string decimal, **obligatorio**), lead_time_days?, perishable,
key_item, consumption_untracked, substitute_ingredient_id?, supplier_id?,
active}`.

**Decisión de gating declarada**: `Ingredient` (CRUD) no lleva flag propia,
igual que `Category`/`Product` en `catalog`. Motivo: `catalog.recipes`
(fichas técnicas, territorio de `backend-recetas`) no depende de
`inventory.perpetual` en el catálogo de funciones (`app/core/features.py`:
`inventory.perpetual` depende de `catalog.recipes`, no al revés), así que
una sede puede tener fichas técnicas costeadas sin tener el libro de
movimientos encendido — y para eso necesita poder leer/crear insumos igual.
Gatear `Ingredient` detrás de `inventory.perpetual` habría roto ese caso.

**`format=csv` declarado en el contrato** (no leído sólo de
`request.query_params`, que fue el hallazgo R-5 de 1b-2, todavía abierto en
el resto del repo a la fecha de este entregable): los cuatro listados
(`ingredients`, movimientos, stock, `waste`) declaran `format: str | None =
Query(None)` explícito en la firma del endpoint además de llamar
`wants_csv(request)`, así que el parámetro aparece en el OpenAPI.

**Idempotencia**: `POST /waste` y `POST /admin/inventory/adjustments` usan
`app.core.idempotency.run_idempotent` con scopes `"inventory.waste"` e
`"inventory.adjustment"`; un replay con la misma clave devuelve la misma
respuesta sin duplicar el movimiento (probado); una clave reutilizada con
body distinto es `400 IDEMPOTENCY_MISMATCH`.

**PIN de responsable de merma** (`WasteIn.employee_pin`, sin `employee_id`
explícito, tal como lo pide el contrato de `spec.md`): se busca por PIN
entre el personal activo de la sede o de toda la organización (los admin),
mismo patrón de búsqueda por PIN que `app.auth.service.verify_authorizer`
pero sin acotar a rol admin/supervisor — cualquier empleado activo puede ser
"el responsable". Puede ser una persona distinta de la identificada en el
dispositivo (igual que `RosterActionIn` en `shifts`).

**PIN de autorización de ajuste manual** (`AdjustmentIn.authorizer_pin`):
como el endpoint ya exige `current_admin` (sesión de administrador
autenticada), este PIN re-confirma a esa MISMA persona
(`app.auth.service.verify_pin`, con su contador de intentos y bloqueo) en
vez de reutilizar `app.auth.service.verify_authorizer` — esa función sólo
autoriza acciones ya registradas en su propia matriz `SUPERVISOR_ACTIONS`
(territorio ajeno) y un ajuste manual de inventario es siempre cosa de
administrador, nunca de supervisor.

---

## 5. Modelo de datos

Migración `backend/alembic/versions/0008_inventory.py`
(`down_revision = "0007"`), DDL a mano, Postgres-first.

### `ingredients`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | PK | |
| `organization_id`, `store_id` | FK, indexadas | |
| `name` | `String(200)` | |
| `category` | `String(100)`, nullable | |
| `base_unit` | enum `BaseUnit` | `g`\|`ml`\|`unit` |
| `purchase_unit` | `String(50)` | |
| `purchase_factor` | `Integer`, `CHECK > 0` | unidades base por unidad de compra |
| `yield_pct` | `Integer`, `CHECK 1..100`, default `100` | |
| `official_cost_micros` | `BigInteger`, nullable | millonésimas de peso/unidad base |
| `estimated_cost_micros` | `BigInteger`, nullable | ídem |
| `min_stock` | `Integer`, `CHECK > 0` | milésimas de la unidad base; nunca `0` |
| `lead_time_days` | `Integer`, nullable | |
| `perishable`, `key_item`, `active`, `consumption_untracked` | `Boolean` | |
| `substitute_ingredient_id` | FK a `ingredients.id`, nullable | auto-referencial |
| `supplier_id` | `Integer`, nullable, **sin FK** | `suppliers` es tabla de 2b (comentario en el modelo con la migración de una línea que hará falta) |
| `created_at`, `updated_at` | `UTCDateTime` | |

Índices: `organization_id`, `store_id`, `(store_id, active)`, `(store_id,
key_item)`.

### `stock_movements`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | PK | |
| `organization_id`, `store_id` | FK, indexadas | |
| `ingredient_id` | FK a `ingredients.id`, nullable | |
| `preparation_id` | `Integer`, nullable, **sin FK** | `preparations` es tabla de `recipes` (otro agente de 2a); ver nota abajo |
| `qty_base` | `Integer`, `CHECK != 0` | con signo |
| `cause` | enum `MovementCause` | |
| `cost_micros` | `BigInteger`, nullable | |
| `cost_source` | enum `CostSource` | `CHECK`: nulo ⟺ `cost_source='NONE'` |
| `employee_id` | FK real a `employees.id` | |
| `employee_name` | `String(200)` | congelado |
| `at` | `UTCDateTime` | |
| `business_date` | `Date` | fecha operativa, columna propia |
| `ref_type` | `String(40)`, nullable | |
| `ref_id` | `Integer`, nullable | |
| `note` | `Text`, nullable | |

`CHECK`: exactamente uno de `ingredient_id`/`preparation_id`. Índices:
`organization_id`, `store_id`, `ingredient_id`, `preparation_id`,
`(store_id, ingredient_id, at)`, `(store_id, preparation_id, at)`,
`(store_id, business_date, cause)`, `(ref_type, ref_id)`.

### `wastes`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | PK | |
| `organization_id`, `store_id` | FK, indexadas | |
| `type` | enum `WasteType` | |
| `ingredient_id` | FK a `ingredients.id`, nullable | |
| `preparation_id` | `Integer`, nullable, **sin FK** | |
| `qty_base` | `Integer`, `CHECK > 0` | siempre positivo (cantidad perdida) |
| `cost_micros` | `BigInteger`, nullable | |
| `cost_source` | enum `CostSource` | mismo `CHECK` de consistencia |
| `employee_id` | FK real a `employees.id` | responsable, con PIN |
| `employee_name` | `String(200)` | congelado |
| `note` | `Text`, nullable | |
| `photo_url` | `String(500)`, nullable | |
| `at` | `UTCDateTime` | |
| `business_date` | `Date` | |
| `stock_movement_id` | FK a `stock_movements.id`, nullable | el movimiento que generó |

`CHECK`: exactamente uno de `ingredient_id`/`preparation_id`. Índices:
`organization_id`, `store_id`, `ingredient_id`, `preparation_id`,
`(store_id, business_date, type)`, `(store_id, ingredient_id,
business_date)`.

**Sobre las FK ausentes a propósito** (`preparation_id` en ambas tablas,
`supplier_id` en `ingredients`): se verificó **empíricamente** (no por
suposición) que `Base.metadata.create_all()` — lo que usa la fixture
compartida `tests/conftest.py::db` — necesita que el modelo de la tabla
referenciada esté importado en el proceso ANTES de crear el esquema, o
lanza `NoReferencedTableError`/deja la tabla sin crear. Como `preparations`
es de `app.recipes` (otro agente de este mismo pedido 2a, que puede no
tener ni carpeta en un punto de la construcción en paralelo) y `suppliers`
es de 2b (no existe todavía), declarar la FK ahora habría roto
`create_all()` para cualquier proceso de test que no haya importado esos
módulos primero — la mayoría. Mismo patrón que `fiscal_range_id` antes de
volverse FK real en 1b-2. Confirmado también contra la migración: mi propia
`alembic upgrade head`/`downgrade base` (ver §7) sólo corre hasta donde
llegan las migraciones existentes al momento de correrla (`0008` en
soledad, y luego `0008→0009` una vez que `backend-recetas` publicó su
`0009_recipes.py` en el mismo árbol) — una FK dura a `preparations` habría
hecho fallar mi propio `alembic upgrade head` mientras `0009` no existiera
todavía, porque Postgres (y la intención real de la migración) exige que la
tabla referenciada ya exista al `CREATE TABLE`.

---

## 6. Qué carga el seed

`app/inventory/seed.py::seed_inventory(db, store)` — idempotente (si la
sede ya tiene algún insumo, no repite nada) — carga **cinco insumos** que
ejercitan a propósito cada rincón del camino nuevo:

1. **Pechuga de pollo** — `yield_pct=85` (para que `apply_yield` se vea en
   acción: 850 milésimas limpias descuentan 1000 brutas), costo oficial
   ($14,5/g), `min_stock=5000` (5 kg), `key_item=True`, perecedero.
2. **Leche deslactosada** — el sustituto (se crea primero para poder
   referenciarlo), costo oficial, perecedera.
3. **Leche entera** — `substitute_ingredient_id` apuntando a la
   deslactosada: el caso exacto de la referencia ("leche entera en -4 y
   deslactosada en +19"), ahora resuelto por el único camino de
   `hooks.resolve_consumption_target`.
4. **Sal de mesa** — `consumption_untracked=True`, costo **estimado** (no
   oficial), sin receta.
5. **Arroz blanco** — `yield_pct=100` (la identidad de `apply_yield`), costo
   estimado (todavía sin costo oficial fijado por el dueño).

Todos con `min_stock > 0` (nunca `0`, que sería rechazado por el propio
endpoint con `400 MIN_STOCK_REQUIRED` si se intentara crear así).

`app/seed.py` (archivo huérfano, dueño único de este territorio) fue
editado para:

- Llamar `seed_inventory(db, store)` después de `seed_catalog`, siempre
  (dominio propio, sin `find_spec_safe` porque siempre existe).
- Llamar `app.recipes.seed.seed_recipes(db, store)` **protegido con
  `app.core.modules.find_spec_safe`** (territorio de `backend-recetas`;
  podía no existir todavía durante la construcción), exactamente como ya se
  hacía con `seed_catalog`.
- **Bug real encontrado y corregido durante la construcción** (no estaba en
  el mandato): `app.seed.main()` llamaba `import_all_models()` (que no
  incluye `"recipes"` en `MODEL_MODULES` todavía — es trabajo del
  integrador) y después `Base.metadata.create_all(engine)`, así que cuando
  `app.recipes.seed.seed_recipes` apareció en el árbol compartido (otro
  agente construyendo en paralelo) y `main()` intentó llamarlo, la tabla
  `recipes` no existía todavía en el esquema recién creado →
  `OperationalError: no such table: recipes`. Se corrigió con un import
  defensivo de `app.recipes.models` (protegido con `find_spec_safe`) ANTES
  de `create_all()`, dentro de `main()`. El mismo problema afectaba a
  `tests/core/test_seed.py` (mi territorio, ya existía desde 1a) y a mi
  propio `tests/inventory/test_seed.py` — ambos corrigen con el mismo
  import defensivo a nivel de módulo (se ejecuta en la colección de tests,
  antes de que la fixture `db` cree el esquema). Verificado con
  `python -m app.seed` de punta a punta sobre una base propia: carga los
  cinco insumos, cae en `seed_recipes` y termina con
  "Fichas y preparaciones: cargadas".

`python -m app.seed` corrido dos veces no duplica nada (probado en
`tests/inventory/test_seed.py` y manualmente contra
`/tmp/pt-backend-inventario/seed.db`).

---

## 7. Verificación

```
cd backend && TMPDIR=/tmp/pt-backend-inventario python -m pytest -q tests/inventory tests/core
→ 115 passed (0 failed), ~187s

cd backend && TMPDIR=/tmp/pt-backend-inventario python -m mypy app
→ Success: no issues found in 106 source files (todo el backend, incluido lo
  que otros agentes ya llevaban escrito en el árbol compartido — mypy es
  barato y no pisa a nadie, como indica la regla de verificación)

DATABASE_URL=sqlite:////tmp/pt-backend-inventario/mig.db alembic upgrade head
DATABASE_URL=sqlite:////tmp/pt-backend-inventario/mig.db alembic downgrade base
→ ambas rutas limpias, verificadas dos veces: primero con sólo `0008` en la
  cabeza del árbol, y de nuevo después de que `0009_recipes.py` apareciera
  en `alembic/versions/` (0007→0008→0009 upgrade, 0009→...→base downgrade)

python -m app.seed (contra base propia, `TMPDIR=/tmp/pt-backend-inventario`)
→ primera corrida: "Seed aplicado" + 5 insumos + fichas/preparaciones
  cargadas; segunda corrida: "Seed ya aplicado... no se repite nada"
```

**Re-verificado en Ronda 2** (sólo el ajuste quirúrgico de §1: docstrings de
`app/core/quantity.py` + dos tests nuevos de contrato; nada más del
territorio cambió):

```
cd backend && TMPDIR=/tmp/pt-backend-inventario python -m pytest -q tests/inventory tests/core
→ 117 passed (0 failed), 187.37s
  (115 previos + test_inventory_cost_fields_are_published_as_decimal_strings
  + test_recipes_cost_fields_are_published_as_decimal_strings; este último
  corrió de verdad contra `app.recipes.schemas`, ya presente en el árbol —
  no se saltó por `find_spec_safe`)

cd backend && TMPDIR=/tmp/pt-backend-inventario python -m mypy app
→ Success: no issues found in 106 source files
```

Cobertura del checklist de la spec que cae en mi territorio: el rendimiento
aplicado (`apply_yield`, test numérico explícito); cantidades sin `float`
sobre 1.000 casos aleatorios; `min_stock <= 0` → `400 MIN_STOCK_REQUIRED`;
vender con stock en cero o negativo no bloquea (`record_movement` nunca
lanza por stock insuficiente, probado); negativo y agotado como alertas
distintas (`low_stock_alerts` vs `negative_stock_alerts`, con
`probable_cause` derivado de causas tipadas, nunca texto libre); consumos
del mismo insumo fusionados en un movimiento; una nota de reversión (causa
`note_return`) revierte el consumo como espejo exacto sobre 200 casos
aleatorios; ningún `cost`/`margin` en `DeviceIngredientOut` ni `WasteOut`
(schemas y el endpoint HTTP real); zona horaria (un ajuste a las 00:30
Bogotá sella el día operativo anterior cuando es antes de la hora de
corte). Los ítems del checklist que dependen de `recipes`/`orders`
(rendimiento aplicado AL ENVIAR un ítem, los dos modos de preparación, el
ciclo de preparaciones, la propagación de costo en cadena, la ficha
versionada, el `waste_stub` resuelto) son territorio de otros agentes; mis
tests cubren el lado del contrato que yo controlo (`hooks.py`), no la
integración completa — eso lo prueba quien la construye, con mi contrato ya
publicado y estable.

**No corrí la suite completa del backend ni el build del frontend** (regla
del pedido: eso lo hace una sola vez, en serie, el paso de verificación del
orquestador). Tampoco toqué `backend/dev.db`: todo corrió contra bases
propias bajo `/tmp/pt-backend-inventario`.

---

## 8. Gaps (todo lo que la spec pide y no construí, o quedó a medias)

1. **Costo de la merma de una preparación** (`Waste.preparation_id` no
    nulo): en 2a queda siempre `cost_micros=None`, `cost_source=NONE` (nunca
    un cero mudo, pero tampoco un costo real). El costeo de una preparación
    (estándar mientras no hay lote, real por lote cuando lo hay) es
    territorio de `backend-recetas`; mi contrato publicado
    (`app.inventory.hooks`) no incluye un `resolve_preparation_cost` porque
    el mandato no me lo pidió. Si se quiere costo real en la merma de
    preparaciones, hace falta un hook nuevo del lado de `recipes` que
    `app/inventory/service.py::register_waste` pueda llamar (protegido con
    `find_spec_safe`, mismo patrón que el seed).
2. **KPI semanal mermas ÷ compras**: `weekly_waste_kpi()` devuelve siempre
   `{ratio: null, label: "sin datos"}`. No hay compras todavía (son de 2b);
   está declarado en el propio contrato, no es un olvido.
3. **`weighted_average` y `last_purchase`** en `CostSource`, y `purchase`/
   `count_adjustment`/`transfer_in`/`transfer_out` en `MovementCause`:
   declarados en el enum, sin ningún camino que los produzca en 2a. Los
   llena 2b (compras, conteos, traslados).
4. **`supplier_id` sin FK dura**: `Integer` comentado, a la espera de que
   2b cree `suppliers` y agregue la FK en una migración de una línea
   (mismo patrón documentado que `fiscal_range_id` en 1b-2).
5. **`GET /admin/today` (alertas de esta fase)**: no es mío — lo consume
   otro agente (`backend-reportes` o quien construya `/admin/today` en este
   pedido) usando `hooks.low_stock_alerts`/`hooks.negative_stock_alerts`
   directamente. No construí ese endpoint ni sus otras alertas (preparación
   en modo lote sin producción, platos que no descuentan): son de
   `recipes`/`orders`.
6. **`GET /admin/sales` con `theoretical_cost`/`gross_margin`/`costed_pct`,
   cortesías a costo en `/admin/orders` y actividad por empleado**: no son
   míos (`app/reports/**`, `app/orders/**`); mi contrato
   (`hooks.resolve_ingredient_cost`, `hooks.current_stock`) es lo que esos
   reportes necesitan para calcularlo, ya publicado y probado.
7. **Notificaciones nuevas** (`ingredient_below_min`, `ingredient_negative`,
   `waste_spike`): las **emito** desde este territorio (`waste_spike` desde
   `register_waste`, probado con un test que verifica la fila de
   `Notification`; `ingredient_below_min`/`ingredient_negative` **no las
   emito como push** — sólo existen como las funciones `pull`
   `low_stock_alerts`/`negative_stock_alerts` que otro agente consulta desde
   `/admin/today`, decisión deliberada para no duplicar la fuente de verdad
   de la alerta), pero **no están declaradas en
   `app.notifications.service.NOTIFICATION_TYPES`** (archivo fuera de mi
   territorio: "otro agente lo declara" según el mandato). Funcionalmente
   `notify()` no exige que el tipo esté en ese catálogo para crear la fila,
   así que `waste_spike` funciona igual; sólo falta declarar los tres tipos
   ahí para que aparezcan en la pantalla de reglas de notificación
   (`GET /admin/notification-rules`).
8. **Pantallas del admin** (Carta y recetas, Preparaciones, Inventario) y
   la producción rápida en el POS/cocina: no son mías (`frontend/**`, fuera
   de mi territorio backend). El contrato de API que necesitan ya está
   completo y probado.
9. **`WasteStub.ingredient_id`/`resolved`** (el stub que 1b dejó abierto al
   anular un ítem enviado): resolverlo contra la ficha es integración con
   `app/orders/**` y `app/recipes/**`, ninguno de los dos mío. No lo toqué.
10. **`order_items.unit_cost`/`recipe_version`** y el registro de consumo
    teórico al enviar (`POST /orders/{id}/send`): territorio de
    `recipes`/`orders`. Mi parte es que exista `hooks.record_movement` con
    fusión automática y `hooks.resolve_consumption_target` con un solo
    camino — listos para que ese código los llame.
11. **`PATCH /admin/preparations/{id}/mode`** (cierre de lotes abiertos con
    `count_adjustment` al cambiar de modo): territorio de `recipes`. Ese
    endpoint sí necesitará llamar a `hooks.record_movement` con
    `cause=MovementCause.COUNT_ADJUSTMENT` (declarada, sin uso hasta ahora)
    — el enum ya está listo para que lo use.
12. **`GET /admin/recipes/coverage`** y **`GET /admin/recipes/suspicious-units`**:
    no son míos (recetas).
13. **Umbral de la alerta de merma (1,5×)**: constante en código
    (`WASTE_SPIKE_NUMERATOR = 3`, `WASTE_SPIKE_DENOMINATOR = 2`,
    `app/inventory/service.py`), no configurable por sede — tal como pide
    el mandato explícitamente ("no agregues ninguna configuración de sede").
    El umbral configurable llega en 2b junto con la varianza.
14. **`frontend/src/features/settings/**` y `frontend/src/features/auth/**`**:
    archivos huérfanos que la spec pide asignar con dueño — no soy yo
    (backend, sin territorio frontend). No agregué ninguna configuración de
    sede nueva que necesite pantalla, así que no hay campo huérfano que
    dejar a medias desde este territorio.
15. **`negative_since`/`probable_cause`**: el algoritmo (`_negative_streak`
    en `hooks.py`) reconstruye la racha negativa actual recorriendo TODOS
    los movimientos del insumo en memoria, ordenados por `at`. Es correcto
    y está probado, pero no está indexado/optimizado para un insumo con
    miles de movimientos históricos — aceptable para 2a (el volumen de un
    restaurante), declarado como límite conocido si `GET
    /admin/inventory/stock?negative=true` alguna vez se sintiera lento en
    producción con años de historia.
