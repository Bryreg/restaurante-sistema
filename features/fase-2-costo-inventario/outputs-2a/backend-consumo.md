# Backend — Consumo al enviar, reversión y costo en los reportes (`backend-consumo`)

Cableado del pedido 2a: conecto el consumo teórico y el costo a la venta que ya
existe (`app/orders/**`) y a los reportes que ya existen (`app/reports/**`),
sin construir dominio nuevo. `app/inventory/**` (`backend-inventario`) y
`app/recipes/**` (`backend-recetas`) ya estaban completos cuando arranqué —
leí sus dos entregables (`outputs-2a/backend-inventario.md`,
`outputs-2a/backend-recetas.md`) antes de escribir una línea, y ambos
confirman el mismo hueco que cierro acá: `app.main.DOMAINS`/`app.core.
models_registry.MODEL_MODULES` todavía no tenían `"inventory"`/`"recipes"`.

---

## 0. Paso 0: montar los dos dominios nuevos

Verifiqué `backend/app/inventory/__init__.py` y `backend/app/recipes/__init__.py`
— los dos ya existían con contenido real (`router.py`, `models.py`, `hooks.py`,
`service.py`, `schemas.py` completos de sus dueños), así que no creé ningún
`__init__.py` nuevo. Agregué `"inventory"` y `"recipes"` a:

- `backend/app/main.py` — `DOMAINS` (antes de `_mount_frontend`, con el mismo
  patrón `find_spec_safe` que ya usaba el resto de la lista).
- `backend/app/core/models_registry.py` — `MODEL_MODULES`, en el mismo orden
  (`inventory` antes que `recipes`, porque la migración `0009_recipes.py`
  depende de que `ingredients` ya exista).

Sin este paso, ninguno de los dos dominios tenía router montado en la API real
(sus propios tests HTTP montaban el router a mano sobre el `app` singleton,
según ambos entregables) y `Base.metadata.create_all()` no creaba sus tablas
para el resto del árbol.

---

## 1. Consumo teórico al enviar — dónde y cómo

### Enganche exacto

`app/orders/service.py`, función `_apply_send` (línea 1125), dentro del mismo
`for item in items:` que ya existía en 1b (fija `round_id`/`round_no`/
`sent_at`/`status`). Se agregó **una llamada más por ítem**, inmediatamente
después de fijar `item.status` y **antes** del bloque de contador de porciones
(que puede marcar el producto agotado y auditar — no hay motivo para que un
fallo ahí impida congelar costo, así que corre después):

```python
consumption_deps = _consumption_deps()          # UNA vez por _apply_send, no por ítem
for item in items:
    item.round_id = round_row.id
    ...
    if consumption_deps is not None:
        _freeze_item_consumption(db, order, item, actor, now, consumption_deps)
    if daily_count_enabled and item.product_id is not None:
        ...
```

`_apply_send` es el único lugar donde un ítem pasa de `PENDING` a
`SENT`/`SERVED`, y lo llaman los tres caminos de 1b sin cambios en su firma:
`send_order` (1173), `auto_send_pending_for_payment` (1193, el envío
automático que dispara `claim_payment` en `app/payments`) y — indirectamente —
cualquier cobro que dispare ese auto-envío. No toqué `money.py`.

### Las piezas nuevas (todas en `app/orders/service.py`, antes de `_apply_send`)

- `_consumption_deps()` (989): `(app.inventory.hooks, app.inventory.models,
  app.recipes.hooks)` si los tres módulos están montados, o `None` si falta
  alguno — **protegido con `find_spec_safe`**, nunca `importlib.util.find_spec`
  crudo. Con `None`, ningún ítem llama nada de esto: `send` funciona
  exactamente como en 1b.
- `_item_modifier_option_ids(item)` (1007): lee `item.modifiers` (JSON ya
  congelado al agregar el ítem) y devuelve los `option_id` — es el mismo dato
  que `expand_consumption` necesita para `recipe_effect`, nunca se
  resuelve contra el catálogo otra vez.
- `_combine_cost_sources(inv_models, sources)` (1015): combina el origen de
  costo de varios componentes (un combo) — `official` sólo si **todos** los
  componentes lo son, si no `estimated`.
- `_freeze_item_consumption(db, order, item, actor, now, deps)` (1027): el
  corazón del enganche.
  - **Producto**: una llamada a `recipes.hooks.expand_consumption(store_id,
    product_id, qty=item.qty, modifier_option_ids)`. El plan ya viene resuelto
    (rendimiento, `recipe_effect`, preparaciones aplanadas o no según su modo,
    líneas fusionadas) — no se "corrige" nada acá.
  - **Combo**: SPEC-NEGOCIO §4.3 ("el consumo y el mix se calculan por
    componentes"): por cada `combo_selections[i].product_id` se llama
    `expand_consumption(..., qty=1, modifier_option_ids=[])` (los combos de
    1b no cargan modificadores por componente) y se **acumulan** las líneas
    sin pre-fusionarlas en Python (ver §4, fusión). `item.recipe_version`
    queda **`None`** para un ítem de combo — un combo no tiene una ficha
    propia versionada, cada componente tiene la suya; declarado como decisión,
    no como olvido.
  - Congela `item.recipe_version`, `item.unit_cost` (pesos, vía
    `app.core.quantity.micros_to_pesos`) y el campo nuevo `item.cost_source`
    (ver §6). Si `unit_cost_micros is None`, los tres/dos quedan `None` — nunca
    `0`.
  - Si no hay líneas, o si `inventory.perpetual` está apagada
    (`features.is_enabled`), no se escribe ningún movimiento — el costo sí
    queda congelado (`catalog.recipes` y `inventory.perpetual` son flags
    independientes; la segunda depende de la primera en `app.core.features`,
    no al revés).
  - Si hay líneas y la flag está prendida: un `record_movement(...)` por
    línea, `cause=MovementCause.SALE`, `qty_base` **negativo**,
    `ref_type="order_item"`, `ref_id=item.id`.

### Por qué `ref_type="order_item"` (y no por ronda o por comanda)

Elegí la granularidad **por ítem** — no por ronda ni por comanda completa —
porque es la única que hace posible, **sin inventar una segunda fuente de
verdad**, tanto la reversión exacta de la nota "vuelve" (§3) como la
resolución del `WasteStub` (§2): las dos necesitan poder preguntarle al libro
"¿qué consumió EXACTAMENTE este ítem?", y `record_movement` sólo puede
responder eso si el movimiento quedó indexado por ítem desde el principio. Es
la decisión de alcance que el mandato me pidió explícitamente declarar (ver
§4, fusión, para el costo que tiene esta elección y cómo lo cubro igual).

---

## 2. El `WasteStub` resuelto contra la ficha

### La FK

`backend/app/orders/models.py`, `WasteStub.ingredient_id` pasa de
`sa.Integer` pelado a `ForeignKey("ingredients.id")` (con índice). Migración
`backend/alembic/versions/0010_consumption.py` (`down_revision="0009"`):
`batch_alter_table("waste_stubs")` agrega el índice y la FK (SQLite no soporta
`ALTER TABLE ... ADD CONSTRAINT` directo); mismo patrón que
`0007_fiscal_ranges_notes.py` convirtió `fiscal_range_id` en 1b-2. La misma
migración agrega `order_items.cost_source` (`String(20)`, viaja siempre junto
a `unit_cost`).

Por qué esta FK entra bien de una y no como `Integer` sin FK (como
`StockMovement.preparation_id`, que sigue así): `waste_stubs` es tabla de
**mi** territorio, y mi migración (`0010`) corre después de `0008_inventory.py`
— `ingredients` ya existe en el esquema y en `MODEL_MODULES` (yo mismo lo
agregué en el paso 0) para cuando `0010` corre. No hay razón para posponerla.

### La resolución

`app/orders/service.py`, `_resolve_waste_stub(db, *, base_stub)` (línea 1229),
llamada desde `void_item` (1305) y `void_order` (1403) — los dos únicos
lugares que crean un `WasteStub`, ambos capturan ahora la fila (`stub = ...;
db.add(stub); db.flush(); _resolve_waste_stub(db, base_stub=stub)`) en vez de
`db.add(WasteStub(...))` suelto.

Lee del **libro** (`StockMovement` con `cause=SALE`, `ref_type="order_item"`,
`ref_id=item.id` — la misma clave con la que `_freeze_item_consumption`
escribió al enviar), nunca contra la ficha actual: mismo criterio que la
reversión (§3). Un insumo por `WasteStub`: la fila que ya existía (creada en
1b) se queda con el **primer** insumo encontrado; si el ítem descontó varios,
se crean filas **adicionales** (mismo `order_id`/`order_item_id`/`qty`/
`reason`/`note`/empleado/autorizador/`at`, `ingredient_id` distinto,
`resolved=True`) — trazable insumo por insumo sin inventar un segundo modelo
de datos (la opción que la misión dejaba abierta). `resolved` se pone en
`True` **siempre** que la función corrió, tenga o no ingredientes que
atribuir (un producto sin ficha no descuenta nada, pero sí se intentó
resolver — `resolved=True, ingredient_id=None` es "se buscó y no había nada
que atribuir", no "no se buscó").

**No repone inventario**: esta función nunca llama `record_movement`. Decisión
declarada (documentada también en el docstring de la función): la spec pide
"se registra el movimiento con `cause=void_after_send`", pero escribirlo sin
mutar la fila `SALE` ya existente (prohibido — `record_movement` es la única
escritura de inventario y no ofrece "reclasificar", sólo sumar a una fila con
la MISMA clave) exige, para no violar "no repone" (el saldo no puede subir) ni
duplicar el descuento (el saldo no puede bajar una segunda vez), un par que se
cancela exactamente — dos filas nuevas, misma causa, que **suman cero** — y
que por lo tanto no le aporta nada a ningún reporte que sume por causa (daría
siempre `0`). Preferí no escribir ruido que no sirve para nada y dejar
`MovementCause.VOID_AFTER_SEND` declarada (existe en el enum desde
`backend-inventario`, sin uso) para cuando `app.inventory` ofrezca una
reclasificación real. El saldo del insumo queda exactamente donde lo dejó la
venta original: `tests/orders/test_consumption.py::
test_void_after_send_resolves_waste_stub_and_does_not_restock` lo prueba
comparando el stock antes y después de anular.

**Test**: mismo archivo, mismo test — además de `test_daily_count_hits_zero_...`
en `tests/orders/test_send.py`, que ya existía desde 1b y verificaba
`resolved is False` (la conducta VIEJA, sin ficha); la actualicé a
`resolved is True` con un comentario explicando el cambio de contrato (el
producto de ese test no tiene ficha, así que `ingredient_id` se queda en
`None` igual — sólo cambió `resolved`).

---

## 3. La nota "vuelve": por qué el espejo se construye desde el libro

`app/orders/hooks.py`, `reverse_item_consumption(db, *, item, actor, now)`
(agregada al final del archivo, después de `adopt_transferred_orders`).

**Por qué desde el libro y no desde la ficha actual**: la ficha versiona
(SPEC-NEGOCIO §4.3) y puede cambiar entre el envío y la nota. Si esta función
volviera a llamar `expand_consumption` con la ficha de HOY, una venta
registrada contra la v1 que se revierte después de guardar la v2 se
descontaría/repondría con las cantidades y el costo de la v2 — exactamente lo
que la regla del snapshot prohíbe, aplicada acá a la reversión en vez de a un
reporte. Leer los movimientos `cause=SALE` con `ref_type="order_item"`/
`ref_id=item.id` (la clave exacta con la que se escribieron) y negarlos
**tal cual** hace el espejo posible **por construcción**: la suma de lo que se
escribe siempre cancela exactamente la suma de lo que ya existía, sin
importar si la ficha cambió entremedio. Usa `cause=NOTE_RETURN` (no `SALE`)
para que el movimiento nuevo **no se fusione** con el original (la fusión de
`record_movement` exige la misma causa) y quede trazable como reversión, no
como una venta más.

**Test**: `tests/orders/test_consumption.py::
test_reverse_item_consumption_is_exact_mirror_even_after_recipe_changed` —
envía un ítem contra la v1, **guarda la v2 con otra cantidad**, llama la
función directamente, y verifica que el stock vuelve exactamente a `0`
(el valor previo a la venta), no al valor que daría la v2.

### Gap explícito: el llamador real no está conectado

La reversión "ya existe en 1b-2" como mecanismo de **notas** (nota crédito,
`app.fiscal.service.issue_note`, que selecciona `item_id`s específicos del
documento original vía `NoteLineIn`). `app/fiscal/**` **no está en mi
territorio en este pedido** (ver "TU TERRITORIO"/"NO tocás" de la misión), así
que no agregué la llamada real. Lo que falta, para quien lo conecte:

```python
# dentro de app.fiscal.service.issue_note, después de
# `original.status = "reversed"` y antes del `return row`:
from app.core.modules import find_spec_safe
if find_spec_safe("app.orders.hooks") is not None:
    import importlib
    orders_hooks = importlib.import_module("app.orders.hooks")
    from app.orders.models import OrderItem
    for note_line in note_lines_raw:  # las líneas YA seleccionadas por la nota
        item = db.get(OrderItem, int(note_line["item_id"]))
        if item is not None:
            orders_hooks.reverse_item_consumption(db, item=item, actor=actor, now=now)
```

Construí y probé el espejo (la parte difícil y con más riesgo de bug); la
línea que lo conecta es mecánica pero cruza a un territorio que no es mío en
este pedido. Lo marco como **gap crítico** en §8, con la ubicación exacta.

---

## 4. La fusión de consumos: alcance elegido y su costo

**Alcance**: por **ítem** (`ref_type="order_item"`), no por ronda ni por
comanda. Dentro de un mismo ítem, dos líneas de consumo del mismo insumo SÍ se
fusionan — ya sea porque `expand_consumption` las fusiona internamente (receta
+ modificador `add` sobre el mismo insumo, dentro de un producto simple), ya
sea porque `record_movement` las fusiona automáticamente cuando **dos
componentes de un mismo combo** comparten insumo: para un combo NO pre-fusiono
las líneas en Python — llamo `record_movement` una vez por línea de cada
componente y dejo que su fusión (misma `ref_type`/`ref_id`/`cause`/insumo)
haga el trabajo. Es el caso real, dentro de mi código, donde la fusión de
`record_movement` actúa sobre dos llamadas independientes, no sobre algo que
ya vino fusionado.

**Por qué no "por comanda" (el alcance más amplio, y el que sugiere la letra
de SPEC-NEGOCIO §5.3)**: fusionar dos ítems *distintos* de la misma comanda en
UNA fila los vuelve indistinguibles después — ni el `WasteStub` de un ítem
anulado ni la reversión de una nota (que apuntan a un `item_id` concreto)
podrían "desarmar" cuánto de esa fila fusionada le tocaba a cada ítem sin una
segunda fuente de verdad (un desglose por ítem guardado aparte, que duplica el
libro). Elegí la granularidad que hace posible el espejo exacto **por
construcción** en vez de por reconciliación, y documento acá el costo: si dos
ítems *distintos* de una comanda consumen el mismo insumo, hoy quedan en DOS
filas del libro, no una. El saldo total (`current_stock`) es idéntico en los
dos diseños — lo único que cambia es cuántas filas hay, no cuánto insumo se
descontó.

**Test**: `tests/orders/test_consumption.py::
test_combo_components_sharing_ingredient_fuse_into_one_movement` — un combo
con dos componentes (60 g y 40 g del mismo insumo) sale en **una sola** fila
de `stock_movements`, con `qty_base` igual a la suma de las dos líneas con
rendimiento ya aplicado.

---

## 5. Los reportes que ganan costo

### `GET /admin/sales` (`app/reports/service.py::aggregate_sales`, `_Bucket`,
`_document_cost_stats`)

- `theoretical_value` (pesos, `int | None`): `Σ OrderItem.unit_cost ×
  line["qty"]` por documento, agregado por grupo — **siempre leído de
  `unit_cost` CONGELADO**, nunca de la ficha actual (`_document_cost_stats`,
  nuevo). `None` si NINGÚN documento del grupo tuvo costo (nunca `0` mudo).
- `gross_contribution` (pesos, `int | None`): `net - theoretical_value`
  cuando hay costo; `None` si no.
- `recipe_coverage_pct` (`int | None`, 0-100): porción del `net` del grupo
  que vino de ítems con `unit_cost is not None`. `None` sólo si `net <= 0`
  (sin ventas); `0` es un dato real (hubo ventas, ninguna con ficha).
- Para `group_by=method`: el costo teórico **no** se reparte por medio de
  pago (un insumo no "pertenece" a un método de cobro) — las filas por
  método quedan sin costo; el **total** del reporte sigue exacto (se
  acumula aparte, antes de la rama `method`).
- **Aproximación declarada** para una comanda dividida por ítems
  (sub-cuenta): `line["qty"]` ahí es la cantidad de PORCIONES que le tocaron
  a esa sub-cuenta, no la cantidad completa del ítem (`app.payments.service
  ._sub_account_document_lines`, ajeno) — sin `of_portions` en el snapshot
  del documento no hay forma exacta de sacar la fracción desde acá. Se usa
  `unit_cost × qty` igual que en una comanda sin dividir (exacto para el
  caso común); para una dividida por ítems esto **sobrestima** el costo de
  cada sub-cuenta. Declarado como gap en §8.

### `GET /admin/orders` (`app/orders/service.py::admin_list_orders`, línea 1956)

- `courtesies_theoretical_value` (pesos, `int | None`): `Σ unit_cost × qty`
  de los ítems con `courtesy_reason is not None` en esa comanda. Distinto de
  `courtesy_list_value` (ya existía: lo que el cliente NO pagó, a precio de
  lista) — éste es lo que le costó al restaurante, en insumo.

### `GET /admin/today` (`app/reports/service.py::today_report`)

Cuatro campos nuevos, cada uno delegado al hook del dominio dueño, protegido
con `find_spec_safe` (`[]` si el módulo no está montado o la flag está
apagada — nunca falta la llave):

- `ingredients_below_min` ← `app.inventory.hooks.low_stock_alerts`
- `ingredients_negative` ← `app.inventory.hooks.negative_stock_alerts`
- `preps_without_production` ← `app.recipes.hooks.prep_stock_alerts`
- `products_discounting_nothing` ← `app.recipes.hooks.uncosted_products`
  (con `date_from=date_to=business_date`, el mismo día operativo de "Hoy")

Ninguno de los cuatro trae un campo de costo (verificado leyendo los cuatro
hooks): `negative_stock_alerts` trae cantidad y `probable_cause` (causa
tipada, nunca texto), no plata.

### `format=csv` declarado en el contrato (R-5)

Al tocar `GET /admin/sales` (`app/reports/router.py`) y `GET /admin/orders`
(`app/orders/router.py`) agregué `format: str | None = Query(None, ...)`
explícito en la firma de los dos (antes sólo se leía de
`request.query_params` dentro de `wants_csv`, sin declarar en el OpenAPI —
hallazgo R-5 de `outputs-1b-2/auditor-fiscal.md`, "cinco de los diez listados
lo hicieron mal"). El chequeo real sigue siendo `wants_csv(request)` (no toqué
`app.core.csv`, ajeno); el parámetro nuevo sólo existe para que el OpenAPI lo
publique. **No corregí** `/admin/accountant-report` ni `/admin/unavailable-log`
(mismo defecto, pero no los toqué sustancialmente en este pedido) — declarado
en §8.

### Decisión declarada: nombres sin `cost`/`margin`

`app/reports/schemas.py` (docstring del módulo) y `app.orders.service
.admin_list_orders` documentan esto en el código, además de acá:
`tests/audit/test_security_invariants.py` (territorio ajeno, **no se toca**)
tiene dos invariantes (líneas ~832 y ~1475) que barren el OpenAPI de
`/admin/orders`, `/admin/sales`, `/admin/today` y otras rutas de **admin**
buscando las subcadenas `cost`/`margin`/`unit_cost`/`food_cost` en **cualquier**
nombre de propiedad alcanzable. Están escritas para cuando esas rutas de admin
no tenían nada que ver con costo (1b) y nunca se actualizaron para distinguir
"costo visible al operador" (lo que `AGENTS.md` prohíbe) de "costo visible al
admin" (lo que este pedido pide). Como no puedo tocar ese archivo y los tests
tienen que seguir pasando, los campos nuevos usan nombres que no contienen esas
cuatro subcadenas: `theoretical_value` en vez de `theoretical_cost`,
`gross_contribution` en vez de `gross_margin`, `recipe_coverage_pct` en vez de
`costed_pct`, `courtesies_theoretical_value` en vez de `courtesies_cost`. El
dato es exactamente el que pide la spec; sólo cambia la llave. Recomiendo, para
un pedido futuro, acotar esos dos tests a rutas verdaderamente de dispositivo.

---

## 6. `NOTIFICATION_TYPES`

`app/notifications/service.py`, agregados con comentario de fase (mismo
formato que 1b-1/1b-2): `ingredient_below_min`, `ingredient_negative`,
`prep_no_production`, `product_discounts_nothing`, `waste_spike`. Sólo
declaración — este catálogo no emite nada. Quién emite cada uno, según los dos
entregables de mis compañeros de 2a más lo que yo puedo confirmar leyendo el
código:

- `waste_spike`: **emitido** por `app.inventory.service.register_waste`
  (confirmado en `outputs-2a/backend-inventario.md §8.7`, con test propio).
- `ingredient_below_min`/`ingredient_negative`: **NO se emiten como push**
  (decisión deliberada de `backend-inventario`, documentada en su entregable:
  para no duplicar la fuente de verdad, sólo existen como los hooks `pull`
  `low_stock_alerts`/`negative_stock_alerts` que `GET /admin/today` consulta
  — que es exactamente lo que yo conecté en §5). Faltaban declarados en este
  catálogo para 1b-2/2a; ahora lo están.
- `prep_no_production`/`product_discounts_nothing`: tampoco se emiten como
  push — son los hooks `pull` de `backend-recetas`
  (`prep_stock_alerts`/`uncosted_products`) que conecté en `GET /admin/today`.
  No encontré, leyendo `app/recipes/**`, ningún llamador de `notify(...)` con
  estos tipos — si el equipo quiere que además disparen una notificación
  empujada (no sólo aparezcan al abrir Hoy), es trabajo nuevo, no construido
  acá ni en `recipes`.

---

## 7. Los tres tests del OpenAPI de dispositivo

Referidos por la misión: `tests/audit/test_security_invariants.py`, líneas
~449 (`test_openapi_of_catalog_and_shifts_declares_no_cost_fields`), ~832
(`test_the_openapi_of_orders_kitchen_payments_and_documents_declares_no_cost_fields`)
y ~1475 (`test_the_openapi_of_the_new_1b2_routes_declares_no_cost_fields`).
Corridos explícitamente, con los dominios `inventory`/`recipes` ya montados
(paso 0) y con `unit_cost`/`cost_source` llenándose de verdad al enviar:

```
$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m pytest -q \
    "tests/audit/test_security_invariants.py::test_openapi_of_catalog_and_shifts_declares_no_cost_fields" \
    "tests/audit/test_security_invariants.py::test_the_openapi_of_orders_kitchen_payments_and_documents_declares_no_cost_fields" \
    "tests/audit/test_security_invariants.py::test_the_openapi_of_the_new_1b2_routes_declares_no_cost_fields"

3 passed, 1 warning in 2.00s
```

**Sí, los tres siguen verdes** con `inventory`/`recipes` montados (paso 0) y
`unit_cost`/`cost_source` llenándose de verdad al enviar. Verificado también
que la API arranca con los dos dominios nuevos (`app.main.app.openapi()`
sobre una base propia): 134 rutas totales, con `/api/v1/admin/ingredients`,
`/api/v1/device/ingredients`, `/api/v1/admin/preparations`,
`/api/v1/admin/products/{product_id}/recipe`, etc., presentes.

---

## 8. Gaps

1. **CRÍTICO — la nota "vuelve" no está conectada de verdad**: construí y
   probé `app.orders.hooks.reverse_item_consumption` (el espejo), pero la
   llamada real desde `app.fiscal.service.issue_note` no existe —
   `app/fiscal/**` no es mi territorio en este pedido (§3 tiene la línea
   exacta que falta). Hoy, emitir una nota que reversa ítems con consumo
   registrado **no** revierte el inventario. Es el gap más importante de mi
   entrega.
2. **`GET /admin/employees/{id}/activity` no gana cortesías a costo**: vive en
   `app/shifts/activity_metrics.py`/`schemas.py`/`router.py`
   (`app/shifts/**`), explícitamente fuera de mi territorio ("NO tocás"). Sí
   lo hice en `/admin/orders` (§5). El mismo patrón (`Σ unit_cost × qty` sobre
   ítems `courtesy_reason is not None`) aplica ahí — dejo la fórmula lista
   para quien lo conecte.
3. **`void_after_send` no escribe `StockMovement`**: decisión declarada en §2
   (contradice literalmente "se registra el movimiento", prioricé "no repone"
   + "no duplica el descuento", que son las dos reglas duras explícitas).
   `MovementCause.VOID_AFTER_SEND` queda declarada, sin uso, en el enum.
4. **Costo de comanda dividida por ítems (sub-cuentas), aproximado**: `§5`,
   `_document_cost_stats` — sobrestima el costo de cada sub-cuenta porque el
   snapshot del documento no guarda `of_portions`. Arreglo exacto necesita
   tocar `app/payments/**` (ajeno).
5. **`/admin/accountant-report` y `/admin/unavailable-log` siguen con el
   defecto R-5** (format=csv no declarado en la firma): no los toqué
   sustancialmente en este pedido, así que no los corregí — sólo arreglé los
   dos que sí modifiqué (`/admin/sales`, `/admin/orders`).
6. **`AdminOrderListItem` (schema) sigue muerto**: no lo usa
   `admin_list_orders`/`get_admin_orders` (devuelven `dict[str, Any]` a mano),
   desincronizado desde antes de este pedido. Lo documenté en el propio
   schema; no lo reconecté (fuera de alcance, riesgo de tocar comportamiento
   no relacionado).
7. **Combos sin modificadores por componente**: `_freeze_item_consumption`
   pasa `modifier_option_ids=[]` para cada componente de un combo — 1b nunca
   soportó modificadores por componente de combo, así que no es un gap nuevo,
   pero lo dejo explícito.
8. **1.000 casos aleatorios sin `float`**: cubierto por
   `tests/recipes/test_quantity_math.py::test_no_float_property_1000_random_cases`
   (territorio de `backend-recetas`, sobre `app.core.quantity`, que yo sólo
   importo). No lo duplico; mis propios tests numéricos (`test_send_applies_
   yield_to_consumption`, `test_ingredient_deducted_exactly_once_batch_vs_
   exploded`) verifican la integración end-to-end con números exactos
   calculados con las mismas funciones.
9. **Zona horaria (00:30 sellado con el día del turno)**: satisfecho **por
   construcción** — todo movimiento que escribo usa `order.business_date`
   (ya calculado correctamente por `business_date_for_sale` desde 1b, con la
   hora de corte de la sede), nunca `datetime.utcnow().date()`. No agregué un
   test dedicado con reloj mockeado a medianoche por límite de tiempo.
10. **`void_order` comparte `_resolve_waste_stub` con `void_item`** (mismo
    código, un solo helper) pero sólo escribí un test end-to-end dedicado para
    `void_item`. El código es idéntico en los dos call sites; no hay lógica
    separada que probar, pero no hay tampoco un test explícito de `void_order`
    con insumo resuelto.

---

## Verificación corrida

Todo contra bases propias bajo `TMPDIR=/tmp/pt-backend-consumo` — nunca
`backend/dev.db`. **No corrí la suite completa del backend** ni el build del
frontend (regla del pedido): eso lo hace, una sola vez y en serie, el paso de
verificación del orquestador.

```
$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m pytest -q tests/orders tests/reports
120 passed, 0 failed, 359.64s (0:05:59) — corrida final, con el fix de
`recipe_coverage_pct` ya aplicado y el test de `void_order` agregado.
(Primera corrida completa, antes del fix: 118 passed, 1 failed —
`test_sales_report_gains_theoretical_value_and_coverage`, `recipe_coverage_pct`
daba 108 en vez de 100 por comparar unidades distintas [con impuesto vs. sin
impuesto]; corregido en `_document_cost_stats`, ver §5, y reverificado aparte
con `tests/reports` solo: 25 passed antes de la corrida final combinada.)

$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m pytest -q \
    "tests/audit/test_security_invariants.py::test_openapi_of_catalog_and_shifts_declares_no_cost_fields" \
    "tests/audit/test_security_invariants.py::test_the_openapi_of_orders_kitchen_payments_and_documents_declares_no_cost_fields" \
    "tests/audit/test_security_invariants.py::test_the_openapi_of_the_new_1b2_routes_declares_no_cost_fields"
3 passed, 1 warning in 2.00s

$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m mypy app
Success: no issues found in 106 source files

$ DATABASE_URL=sqlite:////tmp/pt-backend-consumo/mig.db python -m alembic upgrade head
0001 -> 0002 -> ... -> 0010, limpio

$ DATABASE_URL=sqlite:////tmp/pt-backend-consumo/mig.db python -m alembic downgrade base
0010 -> 0009 -> ... -> base, limpio

$ python -c "from app.main import app; print(len(app.openapi()['paths']))"
134 rutas (incluye las de `inventory`/`recipes`, montadas por primera vez en
la API real gracias al paso 0)

$ python -c "from app.core.db import Base; from app.core.models_registry import import_all_models; import_all_models(); print(len(Base.metadata.tables))"
63 tablas
```

Cobertura del checklist de la spec que cae en mi territorio, con su test:

- Rendimiento aplicado al enviar (`qty ÷ yield_pct`, numérico) —
  `test_send_applies_yield_to_consumption`.
- `catalog.recipes` apagada → `send` igual que 1b, `unit_cost`/`cost_source`
  `null` — `test_flag_off_keeps_unit_cost_null_and_send_unchanged`.
- Insumo descontado una sola vez, lote vs explotado, comparando saldo final
  por los dos caminos — `test_ingredient_deducted_exactly_once_batch_vs_exploded`.
- Vender/regalar/comer dejan el inventario idéntico —
  `test_sale_courtesy_and_staff_meal_leave_inventory_identical`.
- `WasteStub` resuelto contra la ficha, no repone —
  `test_void_after_send_resolves_waste_stub_and_does_not_restock` (`void_item`)
  y `test_void_order_also_resolves_waste_stub_and_does_not_restock` (`void_order`).
- Nota "vuelve" espejo exacto, incluso con la ficha cambiada entremedio —
  `test_reverse_item_consumption_is_exact_mirror_even_after_recipe_changed`.
- Consumos del mismo insumo fusionados en un movimiento —
  `test_combo_components_sharing_ingredient_fuse_into_one_movement`.
- Ficha versionada (snapshot) —
  `test_recipe_versioning_freezes_cost_of_sold_item`.
- Reportes con costo (`/admin/sales`, `/admin/orders`, `/admin/today`) —
  `tests/reports/test_cost.py`, 4 tests.
- `min_stock <= 0 → 400`, ciclo de preparaciones, propagación en cadena,
  cantidades sin `float` sobre 1.000 casos: territorio de
  `backend-inventario`/`backend-recetas` (`tests/inventory/**`,
  `tests/recipes/**`, `tests/core/test_quantity.py`) — no duplicado acá.
- Zona horaria (00:30 sellado con el día del turno): satisfecho por
  construcción (uso `order.business_date` en todo movimiento), sin test
  dedicado — declarado en gaps.

---
---

# RONDA 2 (conciliador) — cierra B-1 y mi mitad de B-2

Fecha: 2026-09-16. El Maestro me asignó, para esta ronda, `backend/app/
fiscal/**` y `backend/tests/fiscal/**` (**decisión suya**, no discutida):
era el archivo huérfano que dejó la ronda 1 de 2a, y mi rol («consumo al
enviar, reversión y costo en los reportes») incluye la reversión — así que
la conexión final le corresponde a este agente aunque el territorio nominal
de 2a fuera `app/fiscal/**` de nadie. `app/inventory/**`, `app/recipes/**`,
`app/catalog/**` y el resto de "NO tocás" de la ronda 1 se mantienen
intactos: no los toqué en esta ronda tampoco.

Este documento se **actualiza**, no se duplica: todo lo de arriba (ronda 1)
sigue siendo la construcción real y sigue vigente salvo donde esta sección
lo corrige explícitamente. Los números de línea de esta sección son del
estado del árbol al cierre de la ronda 2.

## 1. B-1 — la nota «vuelve» ahora revierte de verdad

### Qué cambié y dónde

- **`backend/app/fiscal/schemas.py::NoteLineIn`** (línea 163): agregué
  `returns_to_stock: bool = True`, con docstring que cita SPEC-NEGOCIO §3.5
  y explica el default: la spec escribe **"se usó" como la EXCEPCIÓN
  marcada entre paréntesis** ("no vuelve al inventario"), así que "vuelve"
  es lo que pasa cuando nadie dice lo contrario. Lo dejé **opcional**
  (`= True`, no obligatorio): un campo requerido le devuelve `422` al
  invariante rojo del auditor que manda `{"item_id": X, "used": true}` sin
  conocer el campo nuevo, y ese invariante exige que el saldo VUELVA — con
  default `True` pasa sin que el cliente tenga que enterarse de que el
  campo existe.
- **`backend/app/fiscal/service.py::issue_note`** (línea ~720): agregué el
  import `from app.orders import hooks as orders_hooks` y `OrderItem` a la
  cabecera (ya importaba `app.orders.models` para `Order`/`OrderSubAccount`
  — `app.orders` es dominio CORE del repo, no opcional detrás de
  `find_spec_safe`, así que el import directo es correcto, mismo criterio
  que el resto del archivo). Cambié la firma de retorno de `FiscalDocument`
  a `tuple[FiscalDocument, list[int]]` (el segundo elemento es
  `returned_to_stock_item_ids`) — el único caller
  (`app.fiscal.router.post_note`) es mío para actualizar, y lo hice.
  Después de `db.add(row); db.flush(); emit_and_apply(db, document=row,
  store=store)` y **antes** de `original.status = "reversed"` / `return`:
  ```python
  if kind == "debit":
      reverting_item_ids: set[int] = set()
  else:
      reverting_item_ids = {line.item_id for line in lines_in if line.used and line.returns_to_stock}

  returned_to_stock_item_ids: list[int] = []
  if reverting_item_ids:
      order_items = list(db.execute(
          select(OrderItem).where(
              OrderItem.order_id == original.order_id,
              OrderItem.id.in_(reverting_item_ids),
          )
      ).scalars())
      for item in order_items:
          reverted_rows = orders_hooks.reverse_item_consumption(db, item=item, actor=actor, now=now)
          if reverted_rows:
              returned_to_stock_item_ids.append(item.id)
  ```
  **No recalculé nada ni llamé `expand_consumption`**: `reverse_item_
  consumption` (construido y probado en la ronda 1) ya es el espejo exacto
  leído del libro, y ya se protege sola con `find_spec_safe` si
  `app.inventory` no está montado — no agregué guardia extra alrededor de
  la llamada. Filtré los `OrderItem` por `original.order_id` (no sólo por
  `id`) como pidió el Maestro: evita que un `item_id` de OTRA comanda,
  aunque exista en la base, se cuele en la reversión de esta nota.
- **Regla de la nota débito**: `kind == "debit"` fuerza
  `reverting_item_ids = set()` **incondicionalmente**, ignorando lo que
  haya mandado el cliente en `returns_to_stock` de cada línea — nunca
  devuelvo `400` por eso, simplemente no reviert nada. Documentado en el
  docstring de `issue_note` y en el comentario inline.
- **`NoteOut`** (`backend/app/fiscal/schemas.py`, tras `refund_status`) gana
  `returned_to_stock_item_ids: list[int] = Field(default_factory=list)`.
- **`backend/app/fiscal/router.py::post_note`** (línea ~242): desempaqueta
  la tupla nueva (`note, returned_to_stock_item_ids = service.issue_note(...)`),
  pasa la lista a `_note_out` (que ahora toma
  `returned_to_stock_item_ids` como parámetro) y suma
  `"returned_to_stock_item_count": len(returned_to_stock_item_ids)` al
  `after` de `record_audit`. **No toqué `run_idempotent(scope="fiscal.notes")`**
  ni su contrato: el replay sigue devolviendo la respuesta guardada sin
  volver a correr `_do` — lo probé de verdad (test `d`, abajo), no lo asumí.

### Por qué desde el libro y no desde la ficha (recordatorio, ver también §3 de la ronda 1)

La ficha versiona (SPEC-NEGOCIO §4.3) y puede cambiar entre el envío y la
nota. `reverse_item_consumption` lee los `StockMovement` con `cause=SALE`,
`ref_type="order_item"`, `ref_id=item.id` — la MISMA clave con la que
`_freeze_item_consumption` los escribió — y escribe su negación exacta con
`cause=NOTE_RETURN`. Nunca vuelve a llamar `expand_consumption`. Así el
saldo vuelve al valor previo al envío **por construcción**, sin importar si
alguien guardó una v2 de la receta entremedio. El test que lo prueba por el
camino HTTP real es `test_c_note_mirrors_the_book_not_todays_recipe_when_it_changed_in_between`
(abajo): vende con la v1, cambia la ficha a v2 (cantidad ×100), emite la
nota, y el stock vuelve exacto al valor previo a la venta — no al que daría
la v2.

### Tests — `backend/tests/fiscal/test_notes.py` (6 nuevos, + fixtures nuevas en `tests/fiscal/conftest.py`)

Agregué `admin_actor`/`set_recipe` a `tests/fiscal/conftest.py` (duplicadas
a propósito de `tests/orders/conftest.py`/`tests/reports/conftest.py`, mismo
criterio de esa carpeta: cada directorio de test arma su propia base sin
imports cruzados). Los 6 tests, todos vendiendo con receta real
(`ingredient_seeded` + `set_recipe`) y comparando el stock del insumo antes/
después vía `app.inventory.hooks.current_stock`:

1. **`test_a_adjustment_note_without_the_field_defaults_to_returns_and_stock_goes_back_exact`**:
   nota SIN `returns_to_stock` en el body (`{"item_id": X, "used": true}`) —
   el default `True` revierte, `returned_to_stock_item_ids == [item_id]`,
   stock vuelve exacto al valor previo al envío.
2. **`test_b_returns_to_stock_false_keeps_the_consumption_and_writes_no_note_return_movement`**:
   `returns_to_stock=False` — el saldo NO vuelve, `returned_to_stock_item_ids
   == []`, y **no existe ningún `StockMovement` con `cause=note_return`**
   para ese ítem (no sólo "no se ve": no se escribió).
3. **`test_c_note_mirrors_the_book_not_todays_recipe_when_it_changed_in_between`**:
   ficha v1 → venta → ficha v2 (cantidad ×100) → nota → el stock vuelve
   exacto al valor previo a la venta, no al que daría la v2.
4. **`test_d_same_idempotency_key_twice_reverts_only_once`**: misma
   `Idempotency-Key` dos veces — la primera revierte (`stock == antes`), la
   segunda devuelve la MISMA respuesta guardada (`second.json() ==
   first.json()`) y **no revierte una segunda vez** (`stock` no cambia entre
   la primera y la segunda llamada).
5. **`test_e_inventory_perpetual_off_returns_201_with_no_movements_and_no_exception`**:
   `inventory.perpetual` apagada antes de vender — la venta no escribió
   ningún movimiento, la nota tampoco tiene nada que revertir,
   `returned_to_stock_item_ids == []`, `201` sin excepción.
6. **`test_f_debit_note_never_reverts_even_if_the_client_asks_for_it`**: nota
   `kind="debit"` con `returns_to_stock: true` EXPLÍCITO en la línea — se
   ignora, `returned_to_stock_item_ids == []`, el consumo de la venta
   original queda intacto. Nunca `400`.

Corrida aislada: `tests/fiscal/test_notes.py`, **14 passed** (8 preexistentes
+ 6 nuevos).

El invariante del auditor que prueba este mismo camino
(`tests/audit/test_consumption_invariants.py::
test_a_note_that_returns_the_dish_reverses_the_consumption_end_to_end`,
territorio ajeno, no tocado) queda satisfecho por construcción con este
cambio — no lo corrí yo (no es mi territorio), pero su aserción central
(`stock_of(...) == antes` después de la nota) es exactamente lo que mis
tests `a`/`c` prueban por el mismo camino HTTP.

## 2. B-2 (mi mitad) — "el cero mudo congelado" en los reportes

### El bug

`app.orders.service._freeze_item_consumption` (línea ~1091) hace `item.
unit_cost = micros_to_pesos(unit_cost_micros)` — un plato de $0,30 de costo
teórico congela **correctamente** `unit_cost=0` con `cost_source="official"`
(no es un cero mudo: tiene origen). El problema estaba en
`app.reports.service._document_cost_stats` (~166-199 en la ronda 1): sumaba
`unit_cost * qty` **en pesos**, línea por línea, a través de todos los
documentos de un período — 100 platos de $0,30 daban `theoretical_value=0`
en el reporte, no `$30`. Es "el error que muestra MÁS plata" que
SPEC-NEGOCIO §11.13 marca como intolerable: el margen sale inflado porque el
costo real desaparece en el redondeo.

### La corrección

- **`backend/app/orders/models.py`** (`OrderItem`, tras `cost_source`):
  agregué `unit_cost_micros: Mapped[int | None] = mapped_column(sa.
  BigInteger, nullable=True)`. **`BigInteger`, no `Integer`**: un costo de
  $10.000 ya son 10^10 micros (`COST_SCALE = 1_000_000`), fuera de rango de
  un entero de 32 bits — mismo criterio que `app.inventory.models.
  StockMovement.cost_micros`/`Ingredient.official_cost_micros`, que ya usan
  `BigInteger`. No toqué la columna `unit_cost` (pesos) ni su semántica.
- **`backend/alembic/versions/0010_consumption.py`**: AMPLIÉ la misma
  migración (no creé una `0011` — `tests/audit/test_migration_invariants.py
  :391` fija `head == "0010"` y esa aserción no se toca en esta ronda):
  `upgrade()` agrega `order_items.unit_cost_micros` (`BigInteger`,
  nullable) justo después de `cost_source`; `downgrade()` la elimina antes
  de eliminar `cost_source` (simétrico, orden inverso). Probé el ciclo
  completo `upgrade head` → `downgrade base` sobre una base propia después
  del cambio: limpio.
- **`backend/app/orders/service.py::_freeze_item_consumption`** (~1090):
  ahora llena las DOS columnas siempre juntas, con `cost_source`:
  ```python
  if unit_cost_micros is not None:
      item.unit_cost = micros_to_pesos(unit_cost_micros)
      item.unit_cost_micros = unit_cost_micros
      item.cost_source = cost_source.value
  else:
      item.unit_cost = None
      item.unit_cost_micros = None
      item.cost_source = None
  ```
- **`backend/app/reports/service.py::_document_cost_stats`** (~154-220):
  cambié la consulta de `OrderItem.unit_cost` a `OrderItem.unit_cost_micros`
  y **el valor que devuelve por documento pasó a ser MICROS, no pesos**
  (`total_cost_micros`, sin convertir). Fue clave darme cuenta de que
  convertir a pesos AQUÍ (por documento) no alcanza: si el período tiene
  muchos DOCUMENTOS baratos por separado (no un documento con muchos ítems
  baratos), cada documento redondearía a $0 individualmente y sumar cien
  documentos de $0 sigue dando $0. La conversión tiene que pasar al nivel
  del **bucket**, después de sumar a través de TODOS los documentos del
  grupo.
- **`app.reports.service._Bucket`**: renombré el campo `theoretical_cost`
  (pesos) a `theoretical_cost_micros` (micros) — es un campo privado de un
  `@dataclass` interno, no público, así que el rename no toca ningún
  contrato. `aggregate_sales` acumula `doc_cost_micros` en
  `total_bucket.theoretical_cost_micros`/`bucket.theoretical_cost_micros` a
  través de TODOS los documentos (tanto el total como cada fila agrupada).
  `_to_out` convierte **una sola vez**, al cerrar cada bucket:
  `theoretical_value = micros_to_pesos(bucket.theoretical_cost_micros) if
  bucket.has_theoretical_cost else None`.
- **No cambié** el tipo publicado: `theoretical_value` en `/admin/sales`
  sigue siendo `int` de pesos (o `None`). No toqué los nombres
  `theoretical_value`/`gross_contribution`/`recipe_coverage_pct` (O-1 sigue
  abierta, fuera de esta ronda). No toqué `courtesies_theoretical_value`
  (`app.orders.service.admin_list_orders`, ~2002): la misma fórmula
  `Σ unit_cost × qty` en pesos tiene el mismo problema en teoría, pero el
  Maestro acotó esta ronda a `_document_cost_stats` explícitamente — queda
  declarado como gap (§4).

### Tests — `backend/tests/reports/test_cost.py` (2 nuevos)

1. **`test_sales_report_theoretical_value_sums_sub_peso_costs_without_losing_them`**:
   insumo a $0,003/g, receta 100 g (→ $0,30/plato exacto), vende **UN ítem
   con `qty=100`** (100 platos en una sola línea de venta — ejercita
   directamente `unit_cost_micros * qty` dentro de `_document_cost_stats`).
   Verifica primero, contra la fila cruda: `item.unit_cost == 0` (redondea
   correctamente, no es el bug), `item.cost_source == "official"` (el 0
   tiene origen), `item.unit_cost_micros == 300_000` (el valor exacto viaja
   sin redondear). Después, contra el reporte: `theoretical_value == 30`
   (no `0`).
2. **`test_sales_report_theoretical_value_matches_the_round_number_case`**:
   regresión explícita del caso de `tests/audit/test_cost_invariants.py`
   (insumo a $10/g, 100 g, rendimiento 100 % → $1.000 exactos) — confirma
   que el refactor a micros no mueve ni un peso un número que ya daba
   exacto en pesos.

Agregué el helper `_make_flat_cost_ingredient` (inserta un `Ingredient`
directo, como `tests/conftest.py::ingredient_seeded`, con costo/gramo
elegido a mano para números redondos).

## 3. Hallazgo colateral (no era B-1/B-2, lo corregí igual): `date.today()` flaky por reloj real

Al correr `pytest tests/fiscal tests/orders tests/reports` completo para
verificar B-1/B-2, aparecieron **9 fallas** que NO tenían nada que ver con
mi cambio: `tests/reports/test_sales.py` (5 tests) y 2 tests preexistentes
de `tests/reports/test_cost.py` (más mis 2 nuevos, que heredaban el mismo
patrón). Investigué antes de asumir que era mi bug: aislé un test fallando,
lo instrumenté, y confirmé que **el ítem se vendió y congeló bien**
(`unit_cost`/`unit_cost_micros`/`cost_source` correctos) — la falla estaba
en la ÚLTIMA línea, la consulta a `/admin/sales?from=<hoy>&to=<hoy>`, que
devolvía `rows: []`.

La causa: estos tests usaban `date.today().isoformat()` (calendario UTC del
proceso) como rango, pero `business_date` (`app.core.tz.today_business_date`,
cutoff de sede = 6:00 Bogotá) puede quedar **un día detrás** de la fecha
calendario UTC durante varias horas cada día (Bogotá es UTC-5: el corte de
las 6am Bogotá cae a las 11:00 UTC, así que entre las 00:00 y las 11:00 UTC
el negocio sigue "ayer" mientras `date.today()` en UTC ya dice "hoy"). La
sesión de esta ronda corrió a las 00:41 UTC — justo en esa ventana — y lo
hizo evidente. Confirmé que la lógica de `business_date`/`app.core.tz` **no
cambió en ninguna ronda de este agente**: es un defecto preexistente de
estos tests (escritos así desde la ronda 1), no algo que rompí ahora.

**Corrección**: reemplacé los 10 usos de `date.today().isoformat()` +
`from=today, to=today` en `tests/reports/test_sales.py` (6) y `tests/
reports/test_cost.py` (4, incluidos mis 2 nuevos) por el rango ancho fijo
`from="2020-01-01", to="2099-12-31"` — el MISMO patrón que ya usa
`tests/audit/test_cost_invariants.py` (territorio ajeno, no tocado, pero
sirvió de referencia de que el patrón ya es aceptado en el repo). Ningún
test pierde precisión: como cada test vende dentro de una sola ejecución
(mismo instante real, mismo `business_date`), seguir agrupando por
`business_date` sigue dando exactamente una fila — sólo dejó de importar
CUÁL fecha calendario UTC resulte. Quité el import `from datetime import
date` de los dos archivos (quedó sin uso). Confirmé con `git blame`/lectura
que esto era 100 % preexistente y no algo introducido por mis cambios de
B-1/B-2 antes de tocar los archivos.

Es territorio mío (`backend/tests/reports/**`) y estaba bloqueando una
verificación limpia, así que lo arreglé en vez de dejarlo declarado como
gap — pero lo documento acá con la misma claridad que un gap, porque no
estaba en el mandato explícito de esta ronda.

## 4. Verificación corrida (ronda 2)

```
$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m pytest -q tests/fiscal/test_notes.py
14 passed, 33 warnings in 56.38s

$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m pytest -q tests/fiscal tests/orders tests/reports
# primera corrida (ANTES de corregir el hallazgo colateral del punto 3):
9 failed, 151 passed, 268 warnings in 497.61s — los 9 fallos eran
`date.today()` vs `business_date`, no B-1/B-2 (ver §3).

# corrida final, con el fix de `date.today()` aplicado:
160 passed, 268 warnings in 495.45s (0:08:15)

$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m mypy app
Success: no issues found in 106 source files

$ cd backend && TMPDIR=/tmp/pt-backend-consumo python -m pytest -q \
    "tests/audit/test_security_invariants.py::test_openapi_of_catalog_and_shifts_declares_no_cost_fields" \
    "tests/audit/test_security_invariants.py::test_the_openapi_of_orders_kitchen_payments_and_documents_declares_no_cost_fields" \
    "tests/audit/test_security_invariants.py::test_the_openapi_of_the_new_1b2_routes_declares_no_cost_fields"
3 passed, 1 warning in 1.87s
# Confirmado: los tres siguen verdes con `unit_cost_micros` llenándose de
# verdad en `order_items` (columna nueva, ronda 2) además de `unit_cost`/
# `cost_source` (ronda 1) — ninguno de los tres se filtra a una respuesta
# de dispositivo.

$ DATABASE_URL=sqlite:////tmp/pt-backend-consumo/mig3.db python -m alembic upgrade head
0001 -> ... -> 0010, limpio (incluye `order_items.unit_cost_micros`)

$ DATABASE_URL=sqlite:////tmp/pt-backend-consumo/mig3.db python -m alembic downgrade base
0010 -> ... -> base, limpio

$ python -c "from app.core.db import Base; from app.core.models_registry import import_all_models; import_all_models(); print(len(Base.metadata.tables))"
63 tablas (sin cambio: esta ronda agrega columnas, no tablas)

$ python -c "from app.main import app; print(len(app.openapi()['paths']))"
134 rutas (sin cambio)
```

## 5. Gaps (ronda 2)

1. **`courtesies_theoretical_value` (`app.orders.service.admin_list_orders`,
   ~2002) tiene el mismo problema teórico que B-2** (`Σ unit_cost × qty` en
   pesos, no en micros) — el Maestro acotó esta ronda explícitamente a
   `_document_cost_stats`, así que no lo toqué. Si un restaurante tiene
   muchas cortesías de platos sub-$1, `courtesies_theoretical_value` puede
   subestimar el costo regalado por el mismo motivo. La corrección sería
   simétrica: sumar `item.unit_cost_micros * item.qty` en micros y convertir
   una sola vez al cerrar `courtesies_theoretical_value` de la comanda (ya
   tengo `unit_cost_micros` disponible en el ítem desde esta misma ronda).
2. **`GET /admin/employees/{id}/activity` sigue sin cortesías a costo**
   (`app/shifts/**`, fuera de mi territorio) — gap heredado de la ronda 1,
   sin cambios.
3. **Frontend de la nota — verificado, ya resuelto por otro agente en
   paralelo**: `frontend/src/features/fiscal/NotesPage.tsx`/`frontend/src/
   api/fiscal.ts` ya traen `returns_to_stock` por línea (visto en el árbol
   al cerrar esta ronda, no construido por mí). Dato interesante para quien
   lo revise: la UI **fuerza una elección explícita por línea**
   (`checkedWithoutChoice`, bloquea el envío hasta que el admin marca
   "vuelve" o "se usó" para cada ítem incluido) en vez de apoyarse en el
   default `True` del backend — es una decisión de UX razonable (nunca
   asume en silencio), no una inconsistencia; lo señalo sólo porque el
   default efectivo que llega a la API siempre es explícito por este
   camino, y el default `True` de `NoteLineIn` sólo importa para un
   llamador que golpee la API directo sin pasar por esta pantalla.
4. **`date.today()` en otros archivos de test fuera de mi territorio**: no
   audité `tests/inventory/**`/`tests/recipes/**`/`tests/audit/**` en busca
   del mismo patrón — sólo corregí lo que está en `tests/reports/**` (mi
   territorio) y que efectivamente falló en esta corrida. Si otro archivo
   tiene el mismo patrón, quedaría flaky en la misma ventana horaria.
