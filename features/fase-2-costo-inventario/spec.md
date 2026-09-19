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
| **2b** (después) | Compras con proveedores y cuentas por pagar; lotes de compra y vencimientos; conteos de críticos y completos a ciegas; varianza y food cost real; salud del control |

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

---

## Alcance de 2b

Cuarto pedido al orquestador. Construye sobre 1a, 1b y **2a**, que dejó el libro de
movimientos con causa tipada, el consumo teórico congelado al enviar y las mermas.
2b es la mitad que **confronta la teoría con la realidad**: lo que entró (compras), lo
que hay de verdad (conteos), y la diferencia entre ambos (varianza y food cost real).
Sin 2b el sistema sabe lo que un plato *debería* costar; con 2b sabe lo que le está
costando.

**Entra**

- Spec de negocio **§5.6 (compras)**, **§5.7 (lotes y vencimientos)**, **§5.4 (conteos
  y varianza)**, los dos escalones de costo que faltan de **§4.1** (promedio ponderado
  de las compras desde el último conteo completo, y última compra), el KPI de mermas ÷
  compras de §5.5 que hoy siempre es `null`, y lo que **Compras** e **Inventario**
  ganan en §9.3.
- Cada capacidad detrás de su función, **que ya están en el catálogo desde 1a y en
  `app/core/features.py`**: `purchases`, `inventory.counts`, `inventory.variance`,
  `inventory.lots`. Sus dependencias ya están declaradas (las tres primeras requieren
  `inventory.perpetual`; `inventory.variance` requiere `inventory.counts`) y el backend
  las hace cumplir con `400 FEATURE_DISABLED`.
- **Cerrar lo que 2a dejó declarado** (`outputs-2a/ENTREGA.md § 5`, `docs/ESTADO.md`
  punto 13): la escala de cantidades publicada de dos formas distintas, el KPI de
  mermas declarado `float`, los cinco listados que sirven CSV sin declarar `format`, y
  `MovementCause.VOID_AFTER_SEND` declarada y nunca producida.

**No entra en 2b** (fase 3)

- **Orden de compra y sugerencia de reposición.** §5.6 las manda explícitamente a fase
  3. La tabla de este documento decía «reposición» en la fila de 2b: **manda la spec de
  negocio**, y queda corregido arriba.
- Documento soporte electrónico (Res. DIAN 167/2021) para la compra sin factura: la
  recepción se marca `no_invoice` y ahí termina 2b.
- Ingeniería de menú y varianza por plato prorrateada.
- Consignaciones, libro del banco, mano del dueño, gastos y obligaciones (§6.1, §6.4).
- Domicilio, plataformas y KDS: están en la fila «fase 2» de §14 pero no tienen nada
  que ver con costo ni inventario. Van en su propio pedido, igual que en 2a.

## Convenciones propias de 2b

Las de 1a, 1b y 2a, más:

- **Dominio nuevo: `purchases`** (proveedores, recepciones, cuentas por pagar, pagos).
  Los **conteos, lotes y varianza** van en `inventory`, que ya existe: son el libro
  mirándose al espejo, no un dominio aparte. Crear la carpeta con su `__init__.py`
  **antes** de nombrarla en `DOMAINS`/`MODEL_MODULES`, y preguntar por módulos ajenos
  con `app.core.modules.find_spec_safe`, nunca con `importlib.util.find_spec` crudo.
- Alembic arranca en **`0011`**.
- Cantidades y costos siguen el contrato numérico de 2a (`app/core/quantity.py`):
  `QTY_SCALE = 1000`, `COST_SCALE = 1_000_000`, enteros, **sin `float` en ninguna
  parte** — incluido el KPI de mermas, que hoy lo declara y hay que corregir.
- **Una sola escala publicada.** Hoy `app/reports/schemas.py` publica milésimas crudas
  y `app/inventory/schemas.py` texto decimal, para la misma magnitud. La primera
  pantalla de 2b que pinte una cantidad va a mostrar `117648 g`, o va a dividir por
  1.000 en el cliente, que es matemática en el lugar equivocado. Elegir **una** forma,
  declararla en el contrato interno y unificar las dos.
- Toda escritura de inventario sigue pasando por `record_movement` con `cause`
  enumerada. Las causas nuevas (`purchase`, `count_adjustment`, `reception_reversal`)
  se agregan al enum; **la causa no se infiere de un texto**.
- **El IVA pagado en compras bajo INC es mayor valor del costo** (§4.1); bajo IVA es
  descontable y se reporta aparte. Cada línea de recepción guarda base, tarifa y valor.
  Ignorarlo subestima el costo cerca de un 19 % en insumos gravados.
- **El saldo de una cuenta por pagar se deriva de los pagos vivos** (§5.6). No existe
  un campo `balance` guardado: es la misma regla que ya rige los saldos de caja.
- `Idempotency-Key` en recepción, pago de cuenta por pagar y aplicación de conteo.
- **Nada financiero se borra.** Eliminar una recepción es una reversa con causa, no un
  `DELETE` de filas.

## API contract — 2b (English — technical artifact)

Same conventions as 1a/1b/2a. All routes under `/api/v1`.

### Suppliers
- `GET/POST /admin/suppliers` `{name, nit?, payment_term_days, contact_name?, contact_phone?, invoices_required, active}` → canonical entity, never free text (41 spellings for 23 suppliers in the reference). `400 SUPPLIER_DUPLICATE_NIT`.
- `PATCH /admin/suppliers/{id}`; `DELETE` is a logical deactivation, never a row delete.
- `GET /admin/suppliers/{id}/reliability?from&to` → received ÷ invoiced, share of receptions with an invoice, average price drift.

### Receptions
- `POST /receptions` (Idempotency-Key) `{supplier_id, invoice_number?, invoice_date, no_invoice, photo?, received_by_pin, lines: [{ingredient_id, qty_received, qty_invoiced, purchase_unit_price, tax_base, tax_rate, tax_amount, lot_code?, expires_at?}]}`.
  - `400 INVOICE_REQUIRED` when `no_invoice` and the supplier is `invoices_required`.
  - **Typing guards, which ask and never self-correct**: `409 PRICE_LOOKS_LIKE_PACKAGE` (10–12 × the reference = package price typed as unit price) and `409 PRICE_JUMP` (> 15 % against the weighted average). Both clear with an explicit `confirm_price: true`, and who confirmed is recorded.
  - On confirm, in **one transaction**: a `record_movement(cause=purchase)` per line, a `stock_batch` per line with expiry and cost, the weighted average recomputed, and a `payable` in `pending_review`.
- `GET /admin/receptions?from&to&supplier_id&status&format`; `GET /admin/receptions/{id}`.
- `PATCH`/`DELETE /admin/receptions/{id}` `{authorizer_pin}` → reverses everything downstream **atomically or fails explaining why**: `409 LOT_CONSUMED`, `409 PAYABLE_HAS_PAYMENTS`. The reversal is a movement with `cause=reception_reversal`.

### Payables and payments
- `GET /admin/payables?status&supplier_id&overdue&from&to&format` → balance **derived** from live payments.
- `POST /admin/payables/{id}/approve` `{authorizer_pin}` → `pending_review` → `approved`. Paying an unapproved payable → `409 PAYABLE_NOT_APPROVED`: this is the minimum control between whoever receives and whoever pays.
- `POST /admin/payables/{id}/payments` (Idempotency-Key) `{amount, method, paid_at, reference?, from_cash_drawer, authorizer_pin}` → a cash payment out of the drawer creates the shift expense **in the same transaction**; with no open shift → `409 NO_OPEN_SHIFT` and no payment is left behind.
- `GET /admin/payables/{id}/payments?include_voided&format` → the payment history, oldest first. **Added when closing 2b: this route was missing from the contract above, and without it the payable was half-built** — a payment could be registered and voided by id, but never *seen*, so an administrator returning the next day could not void anything (the `payment_id` only ever existed in the response of the `POST` that created it). Voided payments are listed and marked (`voided_at`, `voided_reason`, `voided_by_employee_name`): nothing financial disappears, and the balance stays derived from the live ones alone.
- `POST /admin/payables/{id}/payments/{payment_id}/void` `{reason, authorizer_pin}` — never a delete.

### Lots and expiry
- `GET /admin/lots?ingredient_id&status&expiring_within_days` → `active`, `expiring` (≤ 7 days), `expired`, `depleted`.
- Every issue consumes **the lot closest to expiring first**, and at equal expiry the one received first. Declare the rule in the internal contract: "the oldest" (§5.7) is ambiguous and a silent choice here moves money.
- An expired lot **is never written off automatically**: the system raises "about to expire" and "expired with stock", and a person writes it off through `POST /waste type=expired`, which already exists.

### Counts
- `POST /admin/counts` `{scope: "key_items"|"full"}` → opens a **blind** count: no response in the capture flow carries theoretical stock, by any path. The on-screen reference is the **previous count**.
- `PUT /admin/counts/{id}/lines` `{lines: [{ingredient_id, qty_counted, was_counted}]}` — `was_counted` is written line by line by whoever counts. **There is no "everything matches"**: no route and no button marks every line at once (it erased real shortfalls of −10.065 g in the reference). A partial save says so; a local draft never overwrites a confirmed value.
- `POST /admin/counts/{id}/apply` `{authorizer_pin}` → explicit admin action, **once** (`409 COUNT_ALREADY_APPLIED`), applying `stock = counted + (ins − outs since the instant of the count)`, not since the instant of applying. The adjustment carries `cause=count_adjustment`.
- `GET /admin/counts?scope&from&to&format`; `GET /admin/counts/{id}`.

### Variance, food cost and control health
- `GET /admin/variance?count_id&format` → per ingredient: opening + ins − closing = real usage, against theoretical usage (sales × recipe + productions); variance in **quantity and in pesos, with the cost source**. Traffic light from **store configuration** with industry defaults (< 2 points green, 2–4 review, > 4–5 sustained red), never hard-coded.
- `GET /admin/food-cost?from&to` → (opening inventory + purchases − closing) ÷ net sales, **only between two consecutive full counts**; without them `null` **with the reason**, never `0`.
- `GET /admin/control-health` → days since the last full count (> 14 → `inventory_unreliable`, and real food cost is not published), share of receptions with an invoice, share of `batch` preparations produced this week, waste entries this week.
- The §5.5 weekly KPI (waste ÷ purchases) stops being `null` once there are purchases in the period, and stays `null` when there are none.

### Reads that 2a asked for
- `GET /admin/orders/{id}/consumption` → **the per-order merge**: one row per ingredient, summing the ledger's per-item rows. This is the §5.3 correction made real: the merge is a **read**; the ledger still stores one row per item.
- `resolve_ingredient_cost` (`app/inventory/hooks.py`) gains the two missing rungs: today `official → estimated → none`, in 2b `official → weighted_average → last_purchase → estimated → none`. The weighted average is computed **since the last full count**, not since forever.
- `GET /admin/today` gains: lots about to expire and expired with stock, payables overdue and pending review, and "inventory not reliable" past 14 days without a full count.

## Invariantes heredados que 2b toca por diseño

Lección de `outputs-2a/ENTREGA.md § 7`: **un invariante también tiene territorio y
también envejece**. En 2a, tres barridos del OpenAPI prohibían la superficie que la
fase existía para construir; como eran inesquivables, dos constructores renombraron
campos publicados en vez de discutirlos. Se lista de entrada, con dueño:

1. **Los tres barridos de costo del OpenAPI**, ya acotados en 2a
   (`tests/payments/test_documents.py`, `tests/audit/test_reports_invariants.py`).
   2b agrega superficie de costo en `/admin/suppliers*`, `/admin/receptions*`,
   `/admin/payables*`, `/admin/counts*`, `/admin/variance`, `/admin/food-cost`. Los
   barridos tienen que **seguir pasando y cubrir las rutas nuevas**. Acotarlos otra vez
   si hace falta es tarea de alguien **nombrado**, no de quien tropiece.
2. **«El operador no ve costos» sigue en pie y 2b no lo toca.** La recepción lleva
   precios, así que es pantalla de **Admin**: el PIN de quien recibe es atribución, no
   una sesión de dispositivo. Si a alguien le parece que la recepción debería hacerse
   desde una tablet del salón, eso **cambia una regla dura** y es decisión del dueño de
   la spec, no de un constructor.
3. **El KPI de mermas declara `float`.** Es el único número no entero de la fase, y 2b
   es exactamente quien lo hace dejar de ser `null`. Quien lo llene lo pasa a entero.
4. **`min_stock` obligatorio** (`400 MIN_STOCK_REQUIRED`) ya existe: la recepción no
   puede crear insumos por la puerta de atrás sin umbral.

## Archivos huérfanos: con dueño asignado desde el arranque (2b)

La regla funcionó en 2a —ninguno de los nombrados falló— y el único huérfano **sin**
nombrar, `app/shifts/**`, es justo donde cayó un hallazgo. En 2b vuelve a estar en el
camino. Se nombra dueño para, como mínimo:

- `backend/app/seed.py` — proveedores, al menos una recepción con lote y **un conteo
  completo aplicado**: sin dos conteos completos el food cost real es `null` para
  siempre, y una base sembrada nunca podría mostrarlo.
- `backend/app/inventory/hooks.py` — `resolve_ingredient_cost` es de `inventory` pero
  lo consumen `recipes` y `orders`; extenderlo mueve el costo de toda la fase 2.
- `backend/app/core/quantity.py`, `backend/app/reports/schemas.py` y
  `backend/app/inventory/schemas.py` — la escala publicada de dos formas.
- `backend/tests/audit/**` y `backend/tests/payments/test_documents.py` — los barridos
  heredados de la lista de arriba.
- `backend/app/shifts/**` — un pago en efectivo desde el cajón crea un egreso en el
  turno abierto. Es de `shifts` y lo escribe `purchases`.
- `frontend/src/features/settings/**` — umbrales de varianza e insumos críticos son
  configuración de sede (§9.3): un campo que el backend acepta y ninguna pantalla edita
  está escrito a medias.
- `frontend/src/app/router.tsx` y la navegación del admin — **Compras** es una sección
  nueva y Conteos entra dentro de Inventario.

## Verificación del pedido 2b (checklist de entrega)

Además de la sección 16 de la spec de negocio:

- [ ] Con `purchases` apagada todo lo de 2a sigue igual y las rutas nuevas responden
      `400 FEATURE_DISABLED`; ídem `inventory.counts`, `inventory.variance` e
      `inventory.lots`, **respetando sus dependencias declaradas** (test con cada flag
      en los dos estados).
- [ ] Una recepción confirmada deja, **en una sola transacción**, un movimiento por
      línea, un lote con vencimiento y costo, el promedio ponderado recalculado y una
      cuenta por pagar en `pending_review`. Si algo falla no queda **nada** (test de
      atomicidad, con un fallo inyectado en la última línea).
- [ ] **El IVA bajo INC entra al costo**: dos recepciones idénticas, una bajo INC y
      otra bajo IVA, dejan costos distintos y la diferencia es exactamente el IVA (test
      numérico — ignorarlo subestima el costo cerca de 19 %).
- [ ] La jerarquía de costo respeta el orden de §4.1 en los **cinco** escalones: con
      oficial puesto el promedio no manda; sin oficial manda el promedio; sin compras
      desde el último conteo completo manda la última compra; luego `estimated`; y sin
      nada `null` con origen `none`, **nunca `0`** (un test por escalón).
- [ ] El promedio ponderado se calcula **desde el último conteo completo**: una compra
      anterior a ese conteo no lo mueve (test).
- [ ] Las dos guardas de tecleo **preguntan y no corrigen solas**: precio 10–12 × la
      referencia y salto > 15 % contra el promedio; confirmadas pasan y queda quién
      confirmó (test de las dos).
- [ ] El saldo de una cuenta por pagar **se deriva** de los pagos vivos: anular un pago
      lo devuelve al saldo, y no existe ningún campo `balance` guardado (test y revisión
      del modelo).
- [ ] Un pago en efectivo desde el cajón crea el egreso en el turno abierto **en la
      misma transacción**; sin turno abierto, `409` y **el pago no queda** (test).
- [ ] Una cuenta por pagar no se puede pagar antes de ser aprobada (test): es el
      control mínimo entre quien recibe y quien paga.
- [ ] Eliminar una recepción revierte todo aguas abajo **o falla con nombre propio**:
      lote ya consumido, cuenta con pagos vivos (test de los dos caminos). La reversa es
      un movimiento; **nada se borra**.
- [ ] El conteo es **a ciegas**: ninguna respuesta del flujo de captura contiene el
      stock teórico por ningún camino (test sobre el JSON, no sobre la pantalla).
- [ ] **No existe «todo coincide»**: ninguna ruta ni botón marca todos los renglones de
      una vez (test de contrato y revisión de la UI).
- [ ] Aplicar un conteo usa `contado + (entradas − salidas desde el instante del
      conteo)`, **no desde el instante de aplicar**: un conteo de las 13:07 aplicado a
      las 15:42, con movimientos en el medio, no inventa un faltante (test — es el caso
      que «mandó a buscar un robo que no existe»).
- [ ] Aplicar el mismo conteo dos veces no duplica el ajuste (`409`, test).
- [ ] Food cost real es `null` **con motivo** sin dos conteos completos consecutivos, y
      se calcula sólo entre ellos (test de los dos casos). Jamás `0`.
- [ ] Con más de 14 días sin conteo completo, «salud del control» dice **inventario no
      confiable** y el food cost real **no se publica** (test).
- [ ] La varianza cierra la identidad `inicial + entradas − final = uso real` y publica
      `uso real − uso teórico` en cantidad **y en pesos con el origen del costo** (test
      numérico con un caso armado a mano, no generado).
- [ ] Los umbrales del semáforo son configuración de sede con defaults: cambiar el
      umbral cambia el color (test).
- [ ] Una salida consume el lote más próximo a vencer, y a igualdad el recibido primero
      (test con tres lotes).
- [ ] Un lote vencido **no se da de baja solo**: queda la alerta «vencido con stock» y
      el stock sigue hasta que alguien registre la merma (test).
- [ ] `GET /admin/orders/{id}/consumption` da **un renglón por insumo** sumando las
      filas por ítem, y el libro sigue guardando una fila por ítem (test: la lectura
      agrega, la escritura no fusiona).
- [ ] Mermas ÷ compras deja de ser `null` con compras en el período, sigue `null` sin
      ellas, y **no es un `float`** (test).
- [ ] **Una sola escala de cantidad publicada**: ningún esquema publica milésimas
      crudas mientras otro publica texto decimal para la misma magnitud (test de
      contrato sobre el OpenAPI).
- [ ] Todo listado nuevo declara `format` en el contrato, y **los cinco de 1b-2 que lo
      leen de `request.query_params` quedan arreglados** (test sobre el OpenAPI).
- [ ] `MovementCause.VOID_AFTER_SEND` **se produce o se saca**: hoy está declarada y
      nunca se emite, así que un reporte de merma por anulación agrupado por causa
      devuelve vacío (test).
- [ ] Sesión de dispositivo: ninguna respuesta contiene `cost` ni `margin`, con
      `purchases` montado. Los tres barridos acotados en 2a **siguen pasando y cubren
      las rutas nuevas**.
- [ ] Cantidades sin `float` en todo lo nuevo (test de propiedad sobre 1.000 casos).
- [ ] Zona horaria: una recepción a las 00:30 queda sellada con el día del turno.
- [ ] Admin en 1024 px sin scroll horizontal; foco visible; contraste AA.
- [ ] Typecheck, suite completa y build, una vez, en serie, con el árbol quieto.
