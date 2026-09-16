# Fase 2 — Carta con costo, recetas e inventario

Tercer pedido al orquestador; construye sobre lo entregado por 1a y 1b. Depende de
`docs/SPEC-NEGOCIO.md` (v0.4) y de `AGENTS.md`. Si algo de acá contradice a la spec
de negocio, manda la spec de negocio y se corrige acá.

## Objetivo

Que el restaurante **sepa qué le cuesta cada plato y qué se le pierde**: insumos con
rendimiento y costo trazable, preparaciones en dos modos, fichas técnicas, consumo
teórico al enviar a cocina, mermas con responsable, y después compras con
proveedores y cuentas por pagar, conteos a ciegas, varianza y salud del control.

Hasta hoy el sistema vende bien y no sabe nada del costo: `order_items.unit_cost` y
`recipe_version` existen y quedan siempre `NULL`, y anular un ítem enviado deja un
`waste_stubs` con `ingredient_id NULL` y `resolved = false`. **Esta fase los llena.**

## Se parte en dos pedidos

Por el mismo motivo que 1b: para que cada mitad quepa en un equipo de 2 a 6 agentes
y en una ventana de uso.

| | Qué construye |
|---|---|
| **2a** (este pedido) | Insumos, preparaciones y fichas técnicas; el libro de movimientos de inventario con causa tipada; consumo teórico al enviar; mermas; `recipe_effect` en modificadores; costo en los reportes que ya existen |
| **2b** (después) | Compras con proveedores y cuentas por pagar; lotes de compra y vencimientos; conteos de críticos y completos a ciegas; varianza y food cost real; salud del control; reposición |

**Por qué ese corte y no otro.** El consumo teórico (2a) es lo que le da sentido a
un conteo (2b): sin uso teórico no hay varianza contra qué comparar. Y las
preparaciones **por lote** de 2a producen su propio `prep_batch`, que es una entidad
distinta del `stock_batch` que crea una recepción de compra en 2b — el glosario de
`docs/ESTADO.md` ya los separa. El costo del insumo en 2a sale de **costo oficial**
(lo fija el dueño) o **estimado**; 2b agrega el promedio ponderado de compras y la
última compra, que son los otros dos escalones de la jerarquía.

## Alcance de 2a

**Entra**

- Spec de negocio §4.1 (insumos), §4.2 (preparaciones), §4.3 (fichas técnicas,
  `recipe_effect`), §5.1 (un solo libro de movimientos con causa tipada), §5.2
  (stock negativo), §5.3 (consumo teórico), §5.5 (mermas), y lo que Carta y
  recetas, Preparaciones e Inventario ganan en §9.3.
- Cada capacidad detrás de su función, **que ya existen en el catálogo de 1a**:
  `catalog.recipes`, `catalog.preps`, `inventory.perpetual`, `inventory.waste`.
  Con `catalog.recipes` apagada el sistema sigue vendiendo exactamente como hoy y
  el costo queda `null` con su origen visible, nunca `0`.
- **Cerrar los ganchos que 1b dejó sembrados**: `order_items.unit_cost` y
  `recipe_version` se llenan al enviar (congelados, nunca recalculados después);
  `waste_stubs.ingredient_id` y `resolved` se resuelven contra la ficha; el canal
  `staff_meal` descuenta inventario igual que una venta.

**No entra en 2a** (es 2b o fase 3)

- Compras, proveedores, recepciones, cuentas por pagar, pagos; lotes de compra y
  vencimientos; conteos, varianza, food cost real, salud del control; reposición
  sugerida; documento soporte electrónico.
- Domicilio propio, plataformas, KDS con «bump» y «marchar», y la conexión real con
  el proveedor tecnológico. **Están en la fila «fase 2» de la tabla §14 de la spec
  de negocio pero no tienen nada que ver con costo ni inventario**: meterlos acá
  rompería el territorio disjunto. Van en su propio pedido.
- Ingeniería de menú y varianza por plato (fase 3).

## Convenciones de ingeniería

Las de 1a y 1b, más:

- Dominios nuevos: `inventory` (insumos, movimientos, mermas) y `recipes` (fichas y
  preparaciones). Crear la carpeta con su `__init__.py` **antes** de nombrarlos en
  `DOMAINS`/`MODEL_MODULES`, y preguntar por módulos ajenos con
  `app.core.modules.find_spec_safe`, nunca con `importlib.util.find_spec` crudo.
- Alembic arranca en `0008`.
- **Cantidades**: el dinero sigue en enteros (pesos). Las cantidades de insumo
  **no** son pesos: definí una unidad base por insumo (g, ml, unidad) y guardá
  enteros en esa unidad base (milésimas si hace falta), nunca `float`. Declaralo en
  el contrato interno y probalo: un `0.1 + 0.2` en una varianza es un bug que nadie
  encuentra.
- **Toda escritura de inventario pasa por una sola función** (`record_movement`),
  con `cause` enumerada. La causa **no se infiere de un texto**.
- **Costo con origen, nunca un cero mudo**: todo costo viaja con
  `cost_source` (`official`, `weighted_average`, `last_purchase`, `estimated`,
  `none`). Sin costo es `null` con origen `none`, no `0`.
- **El insumo se descuenta una sola vez**: al producir (modo lote) o al enviar
  (modo explotado). Nunca ambos. Es regla dura de `AGENTS.md`.
- **Snapshot**: al enviar se congela la versión de receta y el costo unitario. Los
  reportes nunca revaloran una venta pasada con la ficha actual.
- **El operador no recibe costos ni márgenes** en ninguna respuesta de sesión de
  dispositivo. Ya hay un test sobre el OpenAPI que lo prueba: tiene que seguir
  pasando con los dominios nuevos montados.
- `Idempotency-Key` en producción de preparaciones, registro de merma y ajuste
  manual.

## API contract (English — technical artifact)

Same conventions as 1a/1b. All routes under `/api/v1`.

### Ingredients
- `GET/POST /admin/ingredients` `{name, category, base_unit: "g"|"ml"|"unit", purchase_unit, purchase_factor, yield_pct (default 100), official_cost?, min_stock (required, > 0), lead_time_days?, perishable, key_item, consumption_untracked, substitute_ingredient_id?, supplier_id?, active}` → `400 MIN_STOCK_REQUIRED` when `min_stock <= 0`.
- `PATCH /admin/ingredients/{id}`; `DELETE` is a logical deactivation, never a row delete.
- `GET /admin/ingredients/{id}/movements?from&to&cause` → the ledger for one ingredient.
- `GET /admin/inventory/stock?critical_only&below_min&negative` → theoretical stock per ingredient with `cost`, `cost_source`, `min_stock` and a `negative_since` when applicable. **Negative is not "sold out"**: they are different flags and different alerts.

### Preparations
- `GET/POST /admin/preparations` `{name, mode: "batch"|"exploded", standard_yield_qty, standard_yield_unit, process_loss_pct?, shelf_life_days?, lines: [{ingredient_id|preparation_id, qty, unit}]}` → `400 PREP_CYCLE` if a preparation references itself through any path.
- `PATCH /admin/preparations/{id}/mode` `{mode, authorizer_pin}` → switching out of `batch` closes open batches with a `count_adjustment`; admin-only.
- `POST /preparations/{id}/produce` (Idempotency-Key, device) `{qty_expected, qty_real, employee_pin, note?}` → in `batch` mode: consumes the lines and creates a `prep_batch` with its own cost (`Σ inputs ÷ qty_real`) and expiry; in `exploded` mode → `400 PREP_NOT_BATCH`. Warns when `|qty_real − qty_expected| / qty_expected > 15 %`.
- `GET /preparations` (device, for the two-tap quick production) and `GET /admin/preparations/{id}/batches`.

### Recipes (technical sheets)
- `GET/PUT /admin/products/{id}/recipe` `{lines: [{ingredient_id|preparation_id, qty, unit}], version}` → returns `{version, theoretical_cost, cost_source, food_cost_pct, lines: [...]}`. Saving bumps `version`; **old versions are kept** because sold items point at them.
- `PUT /admin/modifier-options/{id}/recipe-effect` `{effect: "add"|"remove"|"replace", lines: [...]}` — `recipe_effect` was `null` through 1b.
- `GET /admin/recipes/coverage` → products sold with no recipe and no direct ingredient (they discount nothing); `GET /admin/recipes/suspicious-units` → the 18 "kg" that were 18 g.

### Consumption, waste and adjustments
- Sending an item (`POST /orders/{id}/send`, already built in 1b) now also registers the theoretical consumption: recipe lines × qty, with modifiers' `recipe_effect` and `yield_pct` applied (`qty ÷ yield`), freezing `recipe_version` and `unit_cost` on the item. A `note` with "vuelve" reverses it as an **exact mirror**.
- **Corrección a la spec de negocio §5.3, decidida al cerrar 2a.** §5.3 pide que «los consumos del mismo insumo en una comanda se fusionen» en un movimiento. Eso choca con dos garantías más fuertes: el espejo exacto de la nota «vuelve» y la resolución del `waste_stub` de un ítem anulado, que apuntan a un `order_item` concreto y **se resuelven leyendo el libro**. Con la fila fusionada no hay forma de saber cuánto le tocaba a cada ítem sin una segunda fuente de verdad que duplique el libro — y un libro con dos fuentes de verdad deja de ser un libro. **El libro guarda una fila por ítem**, exacta y atribuible; **la fusión por comanda es una operación de lectura**, y se construye en 2b, que es donde hace falta para explicar una varianza. El motivo original de §5.3 (no tener 960 filas redundantes por servicio) lo resuelve igual la lectura agregada.
- `POST /waste` (Idempotency-Key, device) `{ingredient_id|preparation_id, qty, type: "expired"|"overproduction"|"kitchen_error"|"breakage"|"customer_return"|"tasting"|"courtesy_no_dish"|"unidentified", note?, employee_pin, photo?}`. **There is no `staff_meal` waste type**: that is an order channel.
- `POST /admin/inventory/adjustments` `{ingredient_id, qty_delta, reason, authorizer_pin}` → `cause = manual_adjustment`.
- `GET /admin/waste?from&to&type&employee_id` and the weekly KPI (waste ÷ purchases is `null` until 2b brings purchases — say "sin datos", never `0`).

### Reports that gain cost (already exist, do not rebuild)
- `GET /admin/sales` gains `theoretical_cost`, `gross_margin` and `costed_pct` (share of sales that actually had a recipe). `GET /admin/orders` gains courtesies at cost. `GET /admin/employees/{id}/activity` gains courtesies at cost.
- `GET /admin/today` gains the alerts that belong to this phase: ingredients below `min_stock`, negatives with probable cause, preparations in `batch` mode with no production, products sold that discount nothing.
- Every list endpoint keeps accepting `format=csv`.

## Verificación del pedido (checklist de entrega)

Además de la sección 16 de la spec de negocio:

- [ ] Con `catalog.recipes` apagada, vender funciona exactamente como en 1b y
      `unit_cost` queda `null` con origen `none` — **nunca `0`** (test con la flag en
      los dos estados).
- [ ] Enviar un ítem descuenta según la ficha con el **rendimiento aplicado**
      (`qty ÷ yield_pct`): un insumo al 85 % descuenta más que la cantidad limpia
      (test numérico explícito, que es el error que subestima todos los costos).
- [ ] Un modificador con `recipe_effect` de tipo `add`, `remove` y `replace` cambia
      el consumo de las tres formas (test por cada uno).
- [ ] **El insumo se descuenta una sola vez**: una preparación en modo lote
      descuenta al producir y **no** al enviar; en modo explotado, al enviar y
      **no** al producir. Test de los dos modos sobre el mismo insumo, comparando
      el saldo final (es la regla dura que más fácil se rompe).
- [ ] Vender, regalar (cortesía) y comer (`staff_meal`) dejan el inventario
      **idéntico** (test que compara los tres caminos).
- [ ] Anular un ítem ya enviado resuelve su `waste_stub` contra la ficha
      (`ingredient_id` y `resolved`) y **no repone** inventario (test sobre el stub
      que 1b dejó abierto).
- [ ] Una nota con «vuelve» revierte el consumo como **espejo exacto**: el saldo
      vuelve al valor previo al peso (test de propiedad).
- [ ] Consumos del mismo insumo en una comanda: **una fila por ítem**, exacta y
      atribuida a su `order_item`, y un agregado por comanda que da un solo
      renglón por insumo (test). Ver la corrección a §5.3 más arriba: la fusión
      es lectura, no escritura, porque el libro tiene que poder desarmar qué
      consumió cada ítem para revertir una nota y resolver una merma.
- [ ] Vender con stock en cero o negativo **no bloquea**: la venta pasa y queda la
      alerta; `negativo` y `agotado` disparan alertas **distintas** (test).
- [ ] Cambiar de modo una preparación con lotes abiertos los cierra con
      `count_adjustment` y exige PIN de administrador (test).
- [ ] Producir con la misma `Idempotency-Key` no duplica el lote ni el descuento
      (test).
- [ ] Una preparación que se referencia a sí misma por cualquier camino →
      `400 PREP_CYCLE` (test con un ciclo de tres saltos).
- [ ] El costo del plato **propaga** desde la preparación: cambiar el costo de un
      insumo cambia el costo de la preparación y el del plato que la usa (test en
      cadena; en la referencia no propagaba).
- [ ] Cantidades sin `float`: un consumo de 0,1 + 0,2 de la unidad base da
      exactamente 0,3 (test de propiedad sobre 1.000 casos aleatorios).
- [ ] La ficha guardada **versiona**: un ítem vendido contra la versión 1 sigue
      reportando el costo de la versión 1 después de guardar la versión 2 (test —
      es el snapshot, la regla dura).
- [ ] `min_stock <= 0` → `400 MIN_STOCK_REQUIRED` (en la referencia 55 de 56
      productos quedaron con el motor de alertas apagado).
- [ ] Sesión de dispositivo: ninguna respuesta contiene `cost` ni `margin`, con los
      dominios nuevos montados (test sobre el OpenAPI, ya existe: tiene que seguir
      pasando).
- [ ] Zona horaria: un consumo a las 00:30 queda sellado con el día del turno.
- [ ] Admin en 1024 px y POS en 375 px sin scroll horizontal; foco visible;
      contraste AA.
- [ ] Typecheck, suite completa y build, una vez, en serie, con el árbol quieto.

## Archivos huérfanos: con dueño asignado desde el arranque

Lección de `outputs-1b-2/ENTREGA.md § 7`: los tres rojos de 1b-2 cayeron, los tres,
en archivos que no estaban en el territorio de ningún agente. El reparto de este
pedido **tiene que nombrar dueño** para, como mínimo:

- `backend/app/seed.py` — si esta fase agrega insumos, preparaciones o fichas, el
  seed las carga; una base recién sembrada tiene que poder ejercitar el camino
  nuevo, igual que hoy carga los rangos de numeración.
- `backend/tests/core/**` — los tests transversales que se rompen cuando cambia un
  esquema de entrada compartido.
- `frontend/src/features/settings/**` — si esta fase agrega configuración de sede
  (insumos críticos, umbrales de varianza), alguien tiene que pintarla: un campo
  que el backend acepta y ninguna pantalla edita está escrito a medias.
- `frontend/src/features/auth/**` — la navegación post-login vive ahí y ya se
  desincronizó una vez del router.

Y la regla general: cuando un mandato acotado toca un modelo compartido, se le
asigna **también** su esquema de entrada, sus tests y la pantalla que lo edita.
