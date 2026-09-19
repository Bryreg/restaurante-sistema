# Backend — la lectura agregada, «Hoy» y el contrato publicado que quedó a medias (pedido 2b)

Territorio: `backend/app/reports/**`, `backend/app/orders/**` completos; los routers de
`audit`, `auth`, `catalog`, `customers`, `fiscal`, `notifications`, `payments`, `refunds`,
`stores` sólo para declarar `format`; `backend/tests/reports/**` y `backend/tests/orders/**`.
No construyo dominio nuevo: amplío lecturas que ya existen y pongo en el contrato cosas
que hoy funcionan sin estar declaradas.

**Nota de Ronda 2**: este documento se actualizó, no se duplicó. Las secciones §1–§8 son el
registro de la ronda 1 tal cual quedó entonces (incluidos los dos rojos reales que declaré
ahí); la sección **«Ronda 2»**, al final, es la que trae las resoluciones — léanse juntas.

---

## §1. Qué construí

1. **`GET /admin/orders/{id}/consumption`** (`app/orders/router.py::get_order_consumption`,
   `app/orders/service.py::order_consumption`, `app/orders/schemas.py::
   OrderConsumptionOut`/`OrderConsumptionRowOut`) — la corrección a §5.3 hecha lectura: un
   renglón por insumo/preparación, sumando en Python las filas del libro que
   `_freeze_item_consumption` ya escribió una por `order_item`. No escribe nada.
2. **`GET /admin/today` gana tres grupos de alertas** (`app/reports/service.py::
   _lot_alerts`/`_payables_overdue`/`_payables_pending_review_count`/
   `_inventory_reliability`, `app/reports/schemas.py::LotAlertOut`/`PayableAlertOut`): lotes
   por vencer y vencidos con stock, cuentas por pagar vencidas y pendientes de revisión, e
   "inventario no confiable" pasados 14 días sin conteo completo. Las cuatro respetan
   `_hooks_if_enabled` (módulo montado **y** flag encendida para la sede).
3. **La escala de cantidad unificada** en `app/reports/schemas.py`: `IngredientAlertOut` y
   `NegativeStockAlertOut` pasan `qty_base`/`min_stock` de `int` (milésimas crudas) a `str`
   (`app.core.quantity.format_qty_base`), formateadas en `app/reports/service.py`.
4. **17 endpoints en 10 routers** ganan `format: str | None = Query(...)` en su firma,
   siguiendo el patrón de `app.reports.router.get_sales`, para que el OpenAPI publique
   `format=csv` en vez de que `wants_csv` lo lea a mano de `request.query_params`.
5. **Decisión sobre `MovementCause.VOID_AFTER_SEND`**: NO se produce (docstring reforzado
   de `app.orders.service._resolve_waste_stub`, test que fija la decisión); se recomienda
   sacarla del enum, con el fundamento completo en §6, para el dueño de
   `app/inventory/models.py`. **Resuelto en Ronda 2**: el Maestro tomó esa recomendación —
   `backend-inventario-espejo` la sacó del enum. Ver § Ronda 2.

Test nuevos: 15 en `tests/orders/test_consumption.py` (agregados a los 12 ya existentes de
2a), 10 en `tests/reports/test_today.py` (agregados a los 5 ya existentes) y 2 en
`tests/reports/test_csv_format_contract.py` (archivo nuevo). Resultado exacto en §7.

---

## §2. La lectura agregada y por qué el libro sigue con una fila por ítem

### El problema que resuelve

SPEC-NEGOCIO §5.3 pedía «los consumos del mismo insumo en una comanda se fusionen en un
movimiento». Al cerrar 2a se decidió lo contrario: **el libro guarda una fila por
`order_item`**, porque dos garantías más fuertes dependen de esa granularidad —

- **El espejo exacto de una nota «vuelve»** (`app.orders.hooks.reverse_item_consumption`)
  lee las filas `cause=SALE` con `ref_type="order_item"`, `ref_id=item.id` de ESE ítem y
  las niega una por una. Con una fila fusionada por comanda no hay forma de saber cuánto
  le tocaba a este ítem sin una segunda fuente de verdad.
- **La resolución del `waste_stub`** de un ítem anulado (`app.orders.service.
  _resolve_waste_stub`) hace exactamente lo mismo: lee el libro por `ref_id=item.id` para
  saber qué insumos e insumo descontó ESE ítem específico.

Fusionar en la escritura rompería las dos. La spec de 2b (§ "Corrección a la spec de negocio
§5.3") ya deja esto resuelto: **la fusión es una operación de lectura**, y la construyo yo.

### Cómo lo construí

`app.orders.service.order_consumption` (línea 2107):

1. Junta los `id` de todos los `OrderItem` de la comanda.
2. Lee **todas** las filas de `StockMovement` con `ref_type="order_item"` y `ref_id` en ese
   conjunto, **sin filtrar por causa** — incluye `cause=SALE` (el consumo original) y
   `cause=NOTE_RETURN` (la reversión de una nota), porque las dos ya usan la misma clave
   `ref_type`/`ref_id` (`app.orders.hooks.reverse_item_consumption`). Si una nota revirtió
   parte del consumo, el renglón agregado da el neto real, no lo que se vendió antes de
   revertir.
3. Agrupa en Python por `(ingredient_id, preparation_id)` — sumando `qty_base` y
   acumulando el costo en MICROS (`app.core.quantity.line_cost_micros` por fila, sumado a
   través de todas las filas del grupo, convertido a pesos con `micros_to_pesos` **una sola
   vez** al cerrar cada renglón — mismo patrón que `app.reports.service.aggregate_sales`
   usa para el costo teórico de un período).
4. Resuelve nombres de insumo/preparación con una sola consulta cada uno (`IN (...)`), no
   una consulta por fila.

**Snapshot, no revaloración**: el costo de cada fila es el que `record_movement` congeló en
ESE movimiento — nunca se vuelve a llamar `resolve_ingredient_cost` ni se re-expande la
ficha vigente. `test_order_consumption_uses_the_frozen_cost_not_todays_price` lo prueba
explícitamente: cambia el costo oficial del insumo DESPUÉS de enviar la comanda y confirma
que la lectura sigue mostrando el costo de ENTONCES.

### El test obligatorio, con las dos mitades

`test_order_consumption_aggregates_by_ingredient_while_the_ledger_keeps_one_row_per_item`
(`tests/orders/test_consumption.py`): dos platos DISTINTOS de la misma comanda, los dos con
el mismo insumo en su ficha (100 g y 50 g).

- **La escritura NO fusiona**: consulto el libro directo (`StockMovement` con
  `ref_type="order_item"`, `ref_id IN (item_a, item_b)`, `ingredient_id=X`) y confirmo
  **2 filas**, una por `order_item`.
- **La lectura SÍ agrega**: `GET /admin/orders/{id}/consumption` da **1 renglón** para ese
  insumo, con `qty_base` igual a la suma de los dos consumos con rendimiento aplicado.

### Ruta, flag, alcance

`GET /admin/orders/{order_id}/consumption`, `current_admin` + `admin_store` (404 si la
comanda es de otra organización o de una sede ajena), **nunca `current_device`** — no hay
ningún camino de dispositivo hacia este endpoint. La flag se valida a mano
(`features.assert_feature(db, order.organization_id, order.store_id, "inventory.perpetual")`)
DESPUÉS de resolver `order.store_id`, no con `dependencies=[Depends(require_feature(...))]`
en el decorador: la ruta no tiene `store_id` en el path ni en la query, así que
`require_feature` como *dependency* resolvería la sede con
`_admin_store_id_from_request` (`None`, evalúa a nivel de organización, no de la sede real
de ESTA comanda) — mismo patrón ya usado en `app.catalog.router.set_product_availability`.

**Un hallazgo real de coordinación entre agentes, documentado en §8**: `app/inventory/router.py`
(territorio de `backend-inventario-espejo`, agente paralelo de este mismo pedido) publica
OTRA implementación de la misma ruta, con un diseño distinto y, a mi criterio, con dos
defectos reales. Ver §8.

---

## §3. Las alertas nuevas de «Hoy» y cómo respetan las flags

Seguí exactamente el patrón de `_hooks_if_enabled` que ya usan las cuatro alertas de 2a
(`app/reports/service.py:618`): el módulo tiene que existir (`find_spec_safe`) **y** la
función tiene que estar encendida para la sede (`features.is_enabled`). Con cualquiera de
las dos condiciones sin cumplir, la lista queda vacía (o `None`/`0` en los campos
escalares) — nunca una alarma que la sede no puede resolver, nunca un error.

| Alerta | Campo en `TodayOut` | Hook que envuelve | Flag |
|---|---|---|---|
| Lotes por vencer (≤7 días) y vencidos con stock | `lots_expiring_or_expired: list[LotAlertOut]` | `app.inventory.hooks.expiring_or_expired_lots` | `inventory.lots` |
| Cuentas por pagar vencidas | `payables_overdue: list[PayableAlertOut]` | `app.purchases.hooks.overdue_payables` | `purchases` |
| Cuentas por pagar pendientes de revisión | `payables_pending_review_count: int` | `app.purchases.hooks.pending_review_payables_count` | `purchases` |
| Inventario no confiable (>14 días sin conteo completo) | `inventory_unreliable: bool \| None`, `days_since_last_full_count: int \| None` | `app.inventory.hooks.last_applied_full_count_at` | `inventory.variance` |

**Por qué `inventory.variance` para la última** (no `inventory.counts`): es exactamente la
misma flag que ya exige `app.inventory.router.get_control_health` (`inventory.py:544`) para
`GET /admin/control-health` — "confiable/no confiable" es una afirmación que sólo tiene
sentido si la sede lleva el control de varianza, no sólo si cuenta insumos.

**`null` no es `false` mudo**: con la flag apagada, `inventory_unreliable` es `None`, no
`False` — "no sabemos" no es lo mismo que "está confiable". Sin ningún conteo completo
aplicado NUNCA, `inventory_unreliable=True` pero `days_since_last_full_count=None` (nunca
un número inventado): no hay línea de base, así que es, por definición, menos confiable
que "más de 14 días sin uno".

Los cuatro tests en `tests/reports/test_today.py` prueban cada flag en los dos estados
(apagada → vacío/`None`; encendida → con datos reales), más el umbral de 14 días con un
`StockCount` armado a mano en 20 y en 3 días de antigüedad (§7).

---

## §4. Los 17 endpoints a los que declaré `format` — la discrepancia con «cinco» y con «19»

La spec (`spec.md § Alcance de 2b`) dice que 2b cierra «los cinco listados que sirven CSV
sin declarar `format`» (heredado de `outputs-2a/ENTREGA.md § 5`). Mi propia misión decía
«no son cinco: son 19 endpoints en 10 routers». Corrí el mismo barrido de AST que describe
la misión (funciones que llaman `wants_csv` sin un parámetro `format` en su firma) sobre
**todo** `app/`, y el resultado es **17**, no 19 — la lista que la misión enumera a
continuación son, contadas una por una, exactamente estas 17:

| # | Archivo | Función |
|---|---|---|
| 1 | `app/audit/router.py` | `list_audit` |
| 2 | `app/auth/router.py` | `list_employees` |
| 3 | `app/auth/router.py` | `list_authorizations` |
| 4 | `app/catalog/router.py` | `list_categories` |
| 5 | `app/catalog/router.py` | `list_products` |
| 6 | `app/catalog/router.py` | `list_combos` |
| 7 | `app/customers/router.py` | `admin_list_customers` |
| 8 | `app/customers/router.py` | `admin_list_requests` |
| 9 | `app/fiscal/router.py` | `get_ranges` |
| 10 | `app/fiscal/router.py` | `get_fiscal_documents` |
| 11 | `app/fiscal/router.py` | `get_notes` |
| 12 | `app/notifications/router.py` | `list_notifications` |
| 13 | `app/payments/router.py` | `get_admin_documents` |
| 14 | `app/refunds/router.py` | `admin_list_pending_refunds` |
| 15 | `app/reports/router.py` | `get_accountant_report` |
| 16 | `app/reports/router.py` | `get_unavailable_log` |
| 17 | `app/stores/router.py` | `list_stores` |

Los otros 12 endpoints que llaman `wants_csv` en todo el árbol **ya declaraban `format`**
antes de que yo tocara nada: `app.inventory.router` (6, territorio de `backend-inventario-
espejo`), `app.orders.router.get_admin_orders` (1, ya lo cerró `backend-consumo` en 2a),
`app.purchases.router` (2, territorio de `backend-compras`), `app.shifts.router` (2, de
otro agente de 2b — **no los toqué**, per el reparto), `app.reports.router.get_sales` (1,
2a). Total en el árbol: **29** funciones llaman `wants_csv`; **17** las corregí yo, **12**
ya estaban bien.

**Declaro la discrepancia con «19»** (mi propia misión) sin poder explicarla: recorrí el
árbol completo con el mismo criterio que describe la misión (AST sobre funciones que llaman
`wants_csv`) y el número que da es 17, dos menos. No encontré ningún endpoint adicional que
sirviera CSV por otro mecanismo (por ejemplo, `Response(media_type="text/csv")` sin pasar
por `wants_csv`) al revisar el árbol a mano.

**El test de contrato** (`tests/reports/test_csv_format_contract.py`,
`test_every_endpoint_that_serves_csv_declares_format_in_its_signature`) recorre
`app/**/router.py` con AST y falla si CUALQUIER función que llama `wants_csv` no declara
`format` en su firma — cubre routers futuros sin que nadie tenga que acordarse de agregarlos
a una lista. Un segundo test (`test_the_seventeen_endpoints...`) fija la cifra de 17 contra
código, para que no se vuelva a discutir de memoria.

---

## §5. La escala unificada y los esquemas que cambié

**Deuda cerrada** (`outputs-2a/ENTREGA.md § 5`, A-5; `docs/ESTADO.md` punto 13):
`app/reports/schemas.py` publicaba `qty_base`/`min_stock` como `int` en milésimas crudas
(`IngredientAlertOut`, `NegativeStockAlertOut`) mientras `app/inventory/schemas.py` los
publica como texto decimal. Elegí la forma que la spec ya declara ganadora —
`app.core.quantity.format_qty_base`— y la apliqué:

- `IngredientAlertOut.qty_base: int → str`, `.min_stock: int → str`.
- `NegativeStockAlertOut.qty_base: int → str`, `.min_stock: int → str`.
- Formateo en el borde de publicación, `app/reports/service.py::_low_stock_alerts`/
  `_negative_stock_alerts`: los hooks de `app.inventory.hooks` (territorio ajeno) siguen
  devolviendo milésimas crudas en el `dict` — nunca los toqué — y `format_qty_base` se
  aplica acá, no dentro del hook ni en el esquema.
- Los dos campos nuevos que agrego en este mismo pedido (`LotAlertOut.qty_base`) nacen
  directamente como `str`, nunca como `int`.

**No toqué** `app/core/quantity.py` ni `app/inventory/schemas.py` (son de
`backend-inventario-espejo`, que los está alineando contra esta misma regla desde su lado:
`tests/core/test_quantity.py::test_inventory_qty_fields_are_published_as_decimal_strings`
ya está en verde).

**Barrí el resto de `app/*/schemas.py` buscando un tercer lugar** con la misma magnitud en
otra escala (`grep` de campos `qty*`/`min_stock` anotados `int`): no encontré ninguno. Los
`qty: int` que sí existen (`app.orders.schemas`, `app.payments.schemas`,
`app.fiscal.schemas`, `.qty_sold` en `app.recipes.schemas`/`app.reports.schemas`) son
**cantidad de UNIDADES DE PRODUCTO vendidas** (2 platos, 3 gaseosas) — una magnitud
distinta, entera por naturaleza, que no usa la escala de milésimas de
`app.core.quantity.QTY_SCALE`. No es la misma deuda.

El barrido de contrato sobre el OpenAPI completo que ya existía en 2a
(`tests/core/test_quantity.py::test_openapi_has_no_raw_integer_qty_base_or_min_stock_fields`,
territorio de `backend-inventario-espejo`, no tocado) confirma esto: corrí ese archivo
informalmente (no es mi territorio de verificación formal) y sus 28 tests pasan, incluidos
los dos que estaban declarados «rojo a propósito» esperando mi corrección
(`test_reports_qty_fields_are_published_as_decimal_strings` y el barrido de OpenAPI).

---

## §6. La decisión sobre `MovementCause.VOID_AFTER_SEND`

**Decisión: NO se produce. Recomiendo sacarla del enum** — decisión que le toca al dueño de
`app/inventory/models.py`, no a mí.

### El argumento de 2a, que sigue en pie

`app/orders/service.py::_resolve_waste_stub` no repone inventario cuando se anula un ítem
ya enviado (correcto: el plato ya se cocinó). 2a consideró escribir un movimiento adicional
`cause=void_after_send` y lo descartó: `record_movement` es la única escritura de
inventario y no ofrece «reclasificar» una fila ya escrita, sólo sumar. Producir esta causa
sin volver a descontar el insumo exige un PAR que se cancela exactamente (un alta y una baja
nuevas, mismo insumo). Ese par no cambia el saldo agregado, y una suma por causa lo da
exactamente cero — no aporta nada a un reporte que sume por causa.

### El argumento nuevo que 2a no pudo ver, y que decide esto

2b agregó FEFO **dentro** de `record_movement`
(`app.inventory.hooks._maybe_consume_fefo`, decisión de arquitectura #3 del pedido 2b):
**cualquier** llamada con `qty_base < 0` (con `inventory.lots` encendida) consume lotes de
verdad vía `consume_lots_fefo`, usando el delta de ESA llamada, no el neto acumulado de la
fila fusionada. La mitad negativa del par necesario para producir `void_after_send`
dispararía una **segunda depleción real** de `StockBatch.qty_remaining` para una cantidad
que YA se consumió de esos lotes al vender — corrompe la contabilidad por lote aunque el
saldo AGREGADO del insumo quede exacto (porque la mitad positiva del par lo compensa). Es
un bug nuevo, no cosmético: un lote que en la realidad tiene 3 kg podría aparecer con menos
stock del que tiene.

Con este argumento, "no producirla" deja de ser sólo "sin ganancia real" (2a) y pasa a ser
"activamente riesgoso" (2b). No es una decisión que me corresponda ejecutar (`app/inventory/
models.py` es territorio ajeno), pero sí nombrarla con el fundamento completo, que es lo que
hago acá.

### Qué cierro yo, en mi territorio

- Reforcé el docstring de `_resolve_waste_stub` (`app/orders/service.py:1240`) con el
  argumento de FEFO, citando este entregable.
- Escribí `tests/orders/test_consumption.py::
  test_void_after_send_is_never_produced_and_the_reason_is_pinned`: envía un ítem, lo anula
  ya enviado, y confirma que **cero** filas `StockMovement` con `cause=VOID_AFTER_SEND`
  existen para ese insumo — y que el saldo del insumo no se movió por la anulación (el
  insumo se descuenta una sola vez, regla dura). El test documenta la decisión en su propio
  docstring, no sólo la verifica.

### Rojo declarado, no escondido

El checklist de la spec pide: «un reporte de merma por anulación agrupado por causa no
devuelve vacío, o el enum ya no ofrece una causa que nadie produce». Mi trabajo deja el
SEGUNDO camino recomendado pero **no ejecutado** — sacar el valor del enum es de
`app/inventory/models.py`, territorio prohibido para mí. El primer camino (producirla) lo
descarté con fundamento nuevo. Este ítem del checklist **queda rojo hasta que el dueño de
ese archivo decida**; está nombrado acá, con el argumento completo, no escondido.

**RESUELTO EN RONDA 2**: el Maestro tomó el segundo camino — `backend-inventario-espejo` sacó
`VOID_AFTER_SEND` de `app/inventory/models.py`. Ver § Ronda 2 / H-3 para lo que le tocó a este
territorio (un test roto por la consecuencia esperada, arreglado, y un docstring reescrito).

---

## §7. Tests que escribí, con su resultado exacto

```bash
export TMPDIR=/tmp/pt-backend-lectura && mkdir -p $TMPDIR
cd backend
python -m pytest -q -p no:cacheprovider tests/reports tests/orders
python -m mypy --cache-dir=$TMPDIR/mypy app/reports app/orders
```

- `python -m mypy app/reports app/orders`: **`Success: no issues found in 11 source
  files`**.
- `pytest tests/reports tests/orders`: **135 passed, 0 failed, 0 skipped en 417.82 s**
  (SQLite; 225 warnings, todos preexistentes — `DeprecationWarning` de `anyio`/Starlette e
  `InsecureKeyLengthWarning` de PyJWT, ninguno de este territorio). Corrida completa, en un
  solo comando, tal como pide la verificación de mi misión.

Por archivo (desglose de esos 135; todos corridos también en aislamiento antes de la
combinada final, mismo resultado):

| Archivo | Tests | Resultado |
|---|---|---|
| `tests/orders/test_consumption.py` | 15 (12 de 2a + 5 nuevos de este pedido: la lectura agregada con las dos mitades, el snapshot de costo, la flag `FEATURE_DISABLED`, el `404` de organización ajena, el conflicto de ruta con `app.inventory.router`, y `VOID_AFTER_SEND`) | 15 passed |
| `tests/reports/test_today.py` | 10 (5 de 1b/2a + 5 nuevos: cantidades como texto decimal ×2, lotes, cuentas por pagar, inventario no confiable) | 10 passed |
| `tests/reports/test_csv_format_contract.py` (archivo nuevo) | 2 | 2 passed |
| Resto de `tests/orders/**` y `tests/reports/**` (sin tocar, sólo afectado por el cambio de tipo de esquema donde aplica) | 108 | 108 passed |

Tests nuevos por checklist:

- **§2 (lectura agregada, las dos mitades en la misma prueba)**:
  `test_order_consumption_aggregates_by_ingredient_while_the_ledger_keeps_one_row_per_item`.
- **§2 (snapshot)**: `test_order_consumption_uses_the_frozen_cost_not_todays_price`.
- **§2 (flag)**: `test_order_consumption_requires_inventory_perpetual_flag`.
- **§2 (404 org ajena)**: `test_order_consumption_other_org_order_is_404`.
- **§2 (guarda de regresión sobre el conflicto de ruta)**:
  `test_order_consumption_route_served_by_orders_not_by_the_duplicate_in_inventory`.
- **§3 (cantidad como texto decimal, alertas heredadas de 2a)**:
  `test_ingredient_alert_quantities_are_published_as_decimal_strings`,
  `test_negative_stock_alert_quantities_are_published_as_decimal_strings`.
- **§3 (lotes, flag en los dos estados)**:
  `test_lots_alert_respects_flag_and_reports_expiring_and_expired`.
- **§3 (cuentas por pagar, flag en los dos estados)**:
  `test_payables_alerts_respect_flag_and_show_overdue_and_pending_review`.
- **§3 (inventario no confiable, flag + umbral de 14 días)**:
  `test_inventory_unreliable_reflects_flag_and_last_full_count`.
- **§4 (contrato de `format` sobre el OpenAPI)**:
  `test_every_endpoint_that_serves_csv_declares_format_in_its_signature`,
  `test_the_seventeen_endpoints_this_pedido_fixed_are_exactly_these`.
- **§6 (`VOID_AFTER_SEND` nunca se produce, decisión fijada)**:
  `test_void_after_send_is_never_produced_and_the_reason_is_pinned`.

---

## §8. Qué NO construí, qué le queda a otro territorio, y todo rojo con nombre

### Rojo real #1 — colisión de rutas: `GET /admin/orders/{id}/consumption` está construido DOS VECES

**RESUELTO EN RONDA 2 — ver § Ronda 2 / H-2.** El Maestro decidió que la implementación de
este documento sobrevive; `backend-inventario-espejo` borró el duplicado de `app/inventory/
router.py:555`. Lo que sigue es el registro de ronda 1, sin editar, para que quede el rastro
de cómo se encontró y con qué evidencia se argumentó la resolución.

`app/inventory/router.py::get_order_consumption` (territorio de `backend-inventario-
espejo`, agente paralelo de este mismo pedido 2b) publica **la misma ruta**
(`/admin/orders/{order_id}/consumption`, mismo método) que yo, con una implementación
distinta (`app/inventory/service.py::order_consumption`, línea 1537). `app.main.app.
openapi()` avisa con `UserWarning: Duplicate Operation ID` cada vez que arranca.

**A quién sirve la ruta en runtime, verificado, no asumido**: `app.main.DOMAINS` monta
`orders` (índice 4) antes que `inventory` (índice 15); Starlette hace *match* de rutas en el
orden en que se agregan, así que la mía (registrada primero) es la que responde. Lo
confirmé con un test de regresión
(`tests/orders/test_consumption.py::
test_order_consumption_route_served_by_orders_not_by_the_duplicate_in_inventory`): pide la
ruta SIN `store_id` (que la de `inventory` exige como query obligatoria) y confirma `200`.
Si el orden de `DOMAINS` cambiara alguna vez, este test se pone rojo antes que un cliente
real note la diferencia.

**Por qué creo que la mía tiene que ser la que quede, con evidencia, no sólo territorio**:

1. **Snapshot**: la versión de `inventory` llama `hooks.resolve_ingredient_cost(db,
   ingredient)` — el costo **vigente**, no el congelado en el movimiento. Es exactamente el
   hallazgo A-6 de 2a («re-expandir la ficha vigente para decidir si una venta pasada
   descontó algo» — regla dura §11.2, snapshot) repetido. Mi
   `test_order_consumption_uses_the_frozen_cost_not_todays_price` prueba el camino correcto
   con un número exacto.
2. **La nota «vuelve»**: la versión de `inventory` filtra
   `StockMovement.cause == MovementCause.SALE` únicamente — nunca suma `NOTE_RETURN`. Si una
   nota revirtió el consumo de un ítem, esa implementación seguiría mostrando el consumo
   ORIGINAL, no el neto real. La mía suma todas las causas atadas a `ref_type="order_item"`
   de la comanda, así que refleja la reversión.
3. **`store_id` redundante y potencialmente inconsistente**: la de `inventory` pide
   `store_id` como query obligatoria además de `order_id` en el path — dos fuentes para el
   mismo dato, que podrían no coincidir (un `store_id` de otra sede con el `order_id`
   correcto). La mía deriva la sede del `order_id` únicamente.

**No edité `app/inventory/router.py` ni `app/inventory/service.py`** (territorio prohibido
para mí). Esto es una decisión para el Conciliador/Maestro: lo correcto es que
`backend-inventario-espejo` retire su duplicado (o lo redirija a llamar
`app.orders.service.order_consumption`, que es el contrato publicado por la spec bajo
`orders`, dominio dueño de `OrderItem`/`StockMovement.ref_type="order_item"`).

### Rojo real #2 — `POST /receptions` (territorio de `backend-compras`) expone `unit_cost` en una ruta que el barrido heredado trata como "de dispositivo"

Corrí informalmente (no es mi verificación formal; un solo archivo, para confirmar que mi
propio endpoint nuevo no rompía nada) `tests/payments/test_documents.py::
test_openapi_device_responses_never_expose_cost_fields` — el barrido heredado que la propia
spec de este pedido (§ "Invariantes heredados que 2b toca por diseño", ítem 1) dice que
tiene que seguir pasando y cubrir las rutas nuevas de 2b. **Falla**, y no por nada mío: el
barrido clasifica como "ruta de dispositivo" a toda ruta cuyo path no contiene `/admin/`
(`device_paths = [p for p in schema["paths"] if "/admin/" not in p]`), y `POST /receptions`
(el contrato de la spec lo define exactamente así, sin `/admin`, aunque
`docs/ESTADO.md` punto 15 y `outputs-2b/backend-compras.md` declaran que es pantalla de
ADMIN, autenticada con `current_admin`, no con sesión de dispositivo) publica `unit_cost` en
`ReceptionLineOut`.

El barrido usa un heurístico de PREFIJO DE URL para decidir "es de dispositivo", que dejó de
ser cierto en cuanto el contrato de la spec puso una ruta administrada fuera de `/admin/`.
No es mi territorio (`app/purchases/router.py`, `tests/payments/**`) y no lo toqué. Lo
declaro acá porque es exactamente el tipo de hallazgo que el ítem 1 de "Invariantes
heredados" de la spec pide nombrar con dueño: el barrido necesita mirar la dependencia de
auth real (`current_admin` vs `current_device`), no el prefijo del path.

### Deuda de otro agente que verifiqué de pasada (no rojo, información)

`tests/core/test_quantity.py` (28 tests, territorio de `backend-inventario-espejo`) pasa
completo tras mi cambio a `app/reports/schemas.py` — los dos tests que estaban declarados
"rojo a propósito" esperando mi corrección (`test_reports_qty_fields_are_published_as_
decimal_strings`, el barrido de OpenAPI) ya están en verde.

### Qué NO construí, fuera de mi alcance por diseño

- **El KPI de mermas ÷ compras y su tipo entero**: es `app.inventory.schemas.WasteKpiOut`,
  territorio de `backend-inventario-espejo` — su propio entregable (§1) declara que ya lo
  cerró (`float → int` en puntos básicos). No lo toqué ni lo verifiqué.
- **`resolve_ingredient_cost` con los dos escalones nuevos**: ya estaba construido
  (`app/inventory/hooks.py:245`) cuando empecé a leer el árbol — territorio de
  `backend-inventario-espejo`, no mío.
- **Umbrales de varianza e insumos críticos en Configuración de sede**: `app/stores/**`
  (fuera de mi lista de routers) y `frontend/**` — no es parte de mi misión.
- **Las pantallas de admin (Compras, Inventario)**: fuera de mi territorio (backend puro).

### Suites que no corrí, y por qué

Toqué routers de `audit`, `auth`, `catalog`, `customers`, `fiscal`, `notifications`,
`payments`, `refunds`, `stores` — SOLO para agregar un parámetro de query con default
`None` (`format`), que no cambia ningún comportamiento existente (confirmado: cada función
sigue leyendo el valor real de `wants_csv(request)`, el parámetro nuevo se descarta con
`del format`). No corrí las suites de esos dominios (`tests/audit`, `tests/auth`,
`tests/catalog`, `tests/customers`, `tests/fiscal`, `tests/notifications`, `tests/payments`,
`tests/refunds`, `tests/stores`): las verifica el paso final del orquestador, en serie, como
manda mi misión. Sí verifiqué, informalmente y fuera de mi obligación formal, que la app
sigue arrancando (`python -c "import app.main"`, limpio) y que el OpenAPI se genera sin
excepciones (aparte de las dos advertencias de operación duplicada, ya explicadas en el
Rojo real #1, preexistente a mi cambio).

### Gap declarado, no corregido

No encontré un tercer lugar donde `qty_base`/`min_stock` (o la misma magnitud con otro
nombre) se publique en otra escala fuera de `app/reports/schemas.py` (ver §5, barrido
completo). Si aparece uno en el futuro, el test de contrato de `tests/core/
test_quantity.py::test_openapi_has_no_raw_integer_qty_base_or_min_stock_fields` (ajeno, no
tocado) lo va a atrapar sin que nadie tenga que acordarse de agregarlo a una lista.

---

## Ronda 2 (ajuste del Maestro, derivado del Conciliador)

Territorio sin cambios respecto de ronda 1: `app/orders/**`, `app/reports/**`,
`tests/orders`, `tests/reports`. No toqué `app/inventory/**`, `app/purchases/**`,
`tests/audit/**` ni `frontend/**`. Este pedido era la otra mitad de H-2 (bloqueante) y de
H-4 (advertencia), más una verificación sobre H-3.

### H-2 (bloqueante) — resuelto: sobrevive `app.orders`, se borró el duplicado de `app.inventory`

**Decisión del Maestro, ejecutada por `backend-inventario-espejo`** (yo NO borré nada de
`app/inventory/**`, ni me correspondía): la implementación de ESTE territorio
(`app.orders.service.order_consumption`, publicada en `app/orders/router.py:326`) es la
que sobrevive. El duplicado que en ronda 1 vivía en `app/inventory/router.py:555` ya no
existe — lo verifiqué con `grep -rn "consumption" app/inventory/router.py` (sin
resultados) y `grep -rn "OrderConsumption" app/inventory` (sin resultados; confirmado
también, del lado del otro agente, en `outputs-2b/backend-inventario-espejo.md § H-2`).

**Fundamento** (tal como lo dio el Maestro, y que mi propio trabajo de ronda 1 ya había
verificado con evidencia, no de oídas — ver «Rojo real #1» arriba):

1. **Snapshot contra revaloración**: mi implementación lee el costo CONGELADO de cada fila
   del libro (`movement.cost_micros`, resuelto por `record_movement` al momento de
   escribir cada movimiento) — nunca vuelve a llamar `resolve_ingredient_cost`. La
   implementación descartada de `app.inventory` llamaba `resolve_ingredient_cost` con el
   costo VIGENTE al leer, exactamente el defecto que 2a ya había encontrado una vez
   (hallazgo A-6: "re-expandir la ficha vigente para decidir si una venta pasada descontó
   algo" — regla dura de `AGENTS.md`, snapshot).
2. **Consumo neto (`SALE + NOTE_RETURN`) contra sólo `SALE`**: mi implementación suma
   TODAS las causas atadas a `ref_type="order_item"` de la comanda — si una nota "vuelve"
   revirtió parte del consumo, el renglón agregado refleja el neto real. La
   implementación descartada filtraba únicamente `cause == MovementCause.SALE`, así que
   una comanda con una nota aplicada seguía mostrando el consumo ORIGINAL, no el neto.
3. **Ya era la que despachaba**: `app.main.DOMAINS` monta `orders` (índice 4) antes que
   `inventory` (índice 15); Starlette hace *match* de rutas en el orden de registro, así
   que la mía respondía en runtime desde la ronda 1. Borrar la otra no cambia una sola
   respuesta servida — sólo alinea el contrato PUBLICADO (el OpenAPI, que con dos rutas en
   el mismo path+método publicaba la SEGUNDA registrada, es decir la de `inventory`,
   mientras el servidor de verdad respondía con la de `orders`: contrato y comportamiento
   estaban desalineados) con lo que el servidor siempre sirvió.

**Las tres tareas del mandato, hechas en mi territorio**:

**(a)** `tests/orders/test_consumption.py::
test_order_consumption_is_published_exactly_once_with_this_contract` — invariante de
contrato sobre el OpenAPI publicado (`client.get("/openapi.json")`, no una inspección de
código): confirma que `GET /admin/orders/{order_id}/consumption` aparece UNA sola vez en
`spec["paths"]`; que su `200` referencia `OrderConsumptionOut`, cuyo `rows[].qty_base` es
`type: string` (texto decimal, puede ser negativo como texto — salida neta) y
`rows[].cost` es `anyOf: [integer, null]` (entero de pesos o `null`, nunca `0` mudo); que
ni `OrderConsumptionOut` ni su fila tienen `item_count` (el campo que sólo tenía el diseño
descartado); y que el único parámetro publicado es `order_id` — sin `store_id` (la sede se
deriva de `order.store_id`, una sola fuente, nunca dos que puedan no coincidir, como pedía
la implementación borrada).

**(b)** `tests/orders/test_consumption.py::
test_openapi_generation_raises_no_duplicate_operation_id_warning` — genera el OpenAPI con
`warnings.simplefilter("error", UserWarning)` (fuerza la regeneración real con
`app.openapi_schema = None` antes y después, para no leer un caché de otro test ni
contaminar el de los que corren después) y confirma que la generación NO levanta ninguna
`UserWarning` — en particular, ya no "Duplicate Operation ID". Verificado también a mano,
fuera del test:

```
$ python3 -c "
import warnings
from app.main import app
app.openapi_schema = None
with warnings.catch_warnings():
    warnings.simplefilter('error', UserWarning)
    app.openapi()
print('OK, no exception')
"
OK, no exception
```

**(c)** Conservé `test_order_consumption_route_served_by_orders_not_by_the_duplicate_in_inventory`
(el test de regresión de despacho de ronda 1) y actualicé su docstring para decir lo que
hoy es cierto — sigue verde, sigue probando lo mismo (la ruta responde sin exigir
`store_id`), pero ya no describe un conflicto ACTIVO sino una regresión permanente sobre
uno resuelto.

**No quedó ningún rojo de H-2 de mi lado**: no encontré la ruta duplicada en el árbol al
verificar; si algún día reapareciera, las tres pruebas de esta sección se ponen rojas antes
que un cliente real note la diferencia.

### H-4 (advertencia) — resuelto: `_inventory_reliability` ya no calcula nada, lee el hook

**Lo que hice en mi territorio** (`app/reports/service.py`, único archivo tocado para
esto): borré `_CONTROL_HEALTH_STALE_DAYS = 14` (la constante local, una segunda
declaración del mismo umbral que ya vive en `app.inventory.hooks.INVENTORY_STALE_DAYS`) y
la resta de instantes UTC (`(now - last_applied).days`) de `_inventory_reliability`. La
función quedó reducida a una lectura: `hooks = _hooks_if_enabled(...)` (sin cambios —
mismo criterio de flag+módulo montado de siempre); si `hooks` es `None`, `(None, None)`
(sin cambios: `inventory.variance` apagada o `app.inventory` sin montar siguen sin tener
nada que afirmar). Con `hooks` presente, un
`getattr(hooks, "inventory_staleness", None)` — si el atributo todavía no existiera
(construcción en paralelo con `backend-inventario-espejo`), `(None, None)`, NUNCA un
cálculo propio de reemplazo, que es exactamente el defecto que este hallazgo existe para
cerrar (en la práctica ya existía cuando llegué a esta tarea). Si existe, llamo
`hooks.inventory_staleness(db, store_id=store.id, cutoff_hour=store.cutoff_hour)` y
devuelvo `(staleness.unreliable, staleness.days_since_last_full_count)` tal cual — sin
sumar, restar ni redondear un solo número de mi lado. El único call site (`today_report`)
perdió el argumento `now=now`, que ya no hacía falta.

**El test nombrado que el mandato pidió**:
`tests/reports/test_today.py::test_today_and_control_health_agree_exactly_at_the_14_day_boundary`.
Arma el caso EXACTO donde la vieja resta de instantes UTC y la fecha de negocio correcta
discrepan: `cutoff_hour=6` (el de la sede, sin cambiarlo — no hace falta forzar uno
distinto), el último conteo completo aplicado el 1° de marzo de 2026 a las 23:00 hora de
Bogotá (día operativo 1° de marzo), y el reloj fijo el 16 de marzo a las 20:00 hora de
Bogotá (día operativo 16 de marzo — 15 días de negocio exactos), que en UTC cae el 17 de
marzo a la 01:00 (Bogotá es UTC-5 todo el año, sin horario de verano): un día calendario
UTC completo por delante del día operativo real. Verificado a mano antes de escribir la
prueba (`tz.business_date_for` sobre los dos instantes, con Python directo contra el
código real):

```
bd_last 2026-03-01   bd_now 2026-03-16   diff (fecha de negocio) = 15
(now - last_applied).days (resta cruda de instantes UTC) = 14
```

Exactamente la discrepancia de un día, a caballo del umbral de 14, que hacía que la vieja
`_inventory_reliability` pudiera decir `unreliable=False` (14 no es `> 14`) mientras la
fecha de negocio correcta ya decía `True` (15 sí es `> 14`). El test pide
`GET /admin/today` y `GET /admin/control-health` sobre el mismo caso y afirma cuatro
cosas: los dos `days_since_*` son 15 (no 14, el valor viejo y equivocado); los dos
`*_unreliable`/`inventory_unreliable` son `True`; y —la aserción central— los dos pares de
valores son iguales entre sí. Es el test que prueba que la contradicción de ronda 1
(«Hoy» diciendo una cosa y «Salud del control» diciendo otra en la misma pantalla) no
puede volver mientras ambos sigan leyendo la misma fuente.

`app/inventory/service.py::control_health` (territorio ajeno, sólo LEÍDO para escribir el
test) ya leía `hooks.inventory_staleness` desde su propia ronda 2 — confirmado en el
código (`app/inventory/service.py:1534`) y en
`outputs-2b/backend-inventario-espejo.md § H-4`: la misma fuente, la misma semántica,
verificada acá contra el endpoint real, no contra el código leído.

### H-3 — verificado, sin cambios de decisión; un test roto por la consecuencia esperada, arreglado, y un docstring reescrito

El mandato pedía sólo VERIFICAR que `app/orders/service.py:1250-1285` no nombrara
`MovementCause.VOID_AFTER_SEND` en código ni en un import, y ajustar el docstring.
Verificado: nunca la nombró en código ni en import (sólo en prosa de docstring, como
texto). Lo que sí encontré al correr mis tests: el enum YA NO tiene `VOID_AFTER_SEND` (lo
sacó `backend-inventario-espejo` en su propia ronda 2, decisión del Maestro sobre H-3), así
que mi test de ronda 1 (`test_void_after_send_is_never_produced_and_the_reason_is_pinned`)
hacía `MovementCause.VOID_AFTER_SEND` y rompía con `AttributeError` — el propio
`backend-inventario-espejo` lo declaró por escrito en su entregable como "un arreglo de una
línea, para quien tenga `tests/orders/**`". Lo arreglé: renombré el test a
`test_void_after_send_writes_no_new_movement_and_the_cause_is_gone_from_the_enum`, que
ahora afirma `not hasattr(MovementCause, "VOID_AFTER_SEND")` en vez de filtrar el libro por
esa causa, y conserva la mitad de comportamiento que siempre probó: anular un ítem ya
enviado no agrega NINGUNA fila nueva al libro para ese insumo (antes comparaba contra cero
filas de una causa específica; ahora compara el conjunto de IDs del libro antes y después
de anular, una aserción más fuerte — cubre CUALQUIER causa nueva, no sólo la que ya no
existe). También reescribí el docstring de `_resolve_waste_stub`
(`app/orders/service.py:1240`) para decir «la causa YA NO EXISTE EN EL ENUM» en vez de
«existe y no se produce», con el mismo argumento de FEFO de ronda 1 (sigue siendo el
motivo por el que, aunque hubiera existido, no se habría producido) más una frase nueva
que cierra el círculo: la Ronda 2 tomó la segunda salida que el checklist ofrecía.

### Resultado de la verificación de mi territorio, Ronda 2

```
cd backend
python -m pytest -q -p no:cacheprovider tests/reports tests/orders
python -m mypy --cache-dir=$TMPDIR/mypy app/reports app/orders
```

- `mypy app/reports app/orders`: **`Success: no issues found in 11 source files`**.
- `pytest tests/reports tests/orders`: **138 passed, 0 failed, 0 skipped en 418.05 s**
  (corrida completa, un solo comando; sube de los 135 de ronda 1 a 138 por los tres tests
  nuevos de esta ronda: las dos pruebas de contrato de H-2 y la prueba nombrada de H-4 —
  el test de `VOID_AFTER_SEND` se RENOMBRÓ, no se sumó, así que no cuenta como test
  nuevo).
- Antes de la corrida combinada, corrí sólo los dos archivos que toqué
  (`pytest tests/orders/test_consumption.py tests/reports/test_today.py`): **28 passed**
  (17 en `test_consumption.py` + 11 en `test_today.py`).

### Las nueve suites que en ronda 1 declaré sin correr, corridas ahora

En ronda 1 toqué `audit`, `auth`, `catalog`, `customers`, `fiscal`, `notifications`,
`payments`, `refunds`, `stores` SOLO para agregar `format: str | None = Query(None, ...)`
— un parámetro con default `None` que ningún handler existente lee (cada uno sigue
resolviendo `wants_csv(request)` de la request cruda, con `del format` para que el linter
no se queje de un argumento sin usar) — y declaré que no había corrido esas suites, per mi
misión de ronda 1. El mandato de ronda 2 pidió correrlas ahora:

```
python -m pytest -q -p no:cacheprovider tests/audit tests/auth tests/catalog tests/customers \
  tests/fiscal tests/notifications tests/payments tests/refunds tests/stores
```

**Resultado exacto: 1 failed, 506 passed, 889 warnings en 1623.52 s (27 min 3 s).**

**La única falla, con nombre, y por qué NO es mía**:
`tests/audit/test_inventory_invariants.py::
test_the_ledger_declares_the_causes_of_section_5_1_and_nothing_else`. Es un test de
`tests/audit/**` (territorio del auditor, no mío ni antes ni ahora) que fija el conjunto
CERRADO de valores de `MovementCause` con una lista literal — una lista que, HOY, todavía
incluye `"void_after_send"` en el `assert declaradas == {...}` (su propio docstring, leído
por mí para confirmarlo, dice explícitamente: «`void_after_send` sigue declarada y sin
producirse nunca» — texto que ya no es cierto después de la resolución de H-3). No es un
efecto de ningún cambio de `app/orders/**` ni `app/reports/**`: es la consecuencia esperada
y ya documentada de que `backend-inventario-espejo` sacó `VOID_AFTER_SEND` del enum en su
propia ronda 2 (§ H-3 de este mismo documento) — un test de OTRO territorio que fija ese
mismo enum con una lista hardcodeada y que nadie actualizó todavía. No lo arreglé (no es
mi territorio, `tests/audit/**` está prohibido para mí en las dos rondas) pero lo dejo
nombrado con precisión para que el dueño de `tests/audit/**` (o, en su defecto,
`backend-inventario-espejo`, que fue quien cambió el enum que este test fija) lo actualice
— es un cambio de una lista de doce elementos a once.

**Ninguna de las 506 pasadas ni la 1 fallada tiene relación con mi cambio de `format`**:
recorrí la lista completa de warnings y el resumen — nada menciona `format`, `csv`,
`wants_csv` ni ninguno de los nueve routers que toqué de forma que sugiera una regresión de
mi lado. Los nueve routers con el parámetro nuevo (`audit`, `auth`, `catalog`, `customers`,
`fiscal`, `notifications`, `payments`, `refunds`, `stores`) pasan sus propias suites
completas sin ninguna falla atribuible a mí: **si alguna suite estuviera roja por mi
cambio de contrato, sería mía** (per el mandato) — ésta no lo está, y lo declaro con la
misma precisión con la que declararía lo contrario.

### Qué queda igual de esta ronda en adelante

- `docs/PATRONES.md`/`AGENTS.md` no cambiaron por esta ronda; ninguna regla dura nueva.
- La lista de rojos reales de §8 baja de 2 a 1: el Rojo real #1 (H-2) está resuelto; el
  Rojo real #2 (`POST /receptions` sin `/admin/`, barrido de dispositivo por prefijo de
  URL) sigue abierto, sin cambios — no era parte del mandato de esta ronda y sigue siendo
  territorio de `backend-compras`/`tests/payments`.
- Nuevo rojo declarado, de OTRO territorio, encontrado al correr la verificación pedida:
  `tests/audit/test_inventory_invariants.py::
  test_the_ledger_declares_the_causes_of_section_5_1_and_nothing_else` (ver arriba).
