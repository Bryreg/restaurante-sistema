# Auditor — invariantes ejecutables de 2b y el recorte de los barridos heredados

**Rol**: auditor de invariantes del pedido 2b (sucesor de `auditor-costos` de 2a).
**Territorio exclusivo escrito**: `backend/tests/audit/**`,
`backend/tests/payments/test_documents.py`, `frontend/src/audit/**`.
**No escribí una sola línea de `backend/app/**` ni de `frontend/src/` fuera de
`src/audit/`.** Lo que encontré está reportado, no arreglado.

Todo lo que afirmo acá apunta a `archivo:línea` y lo verifiqué **leyendo el
código**, no los informes de los constructores (lección de `outputs-2a/ENTREGA.md
§3`: los reportes nacen viejos porque el árbol se mueve mientras se escriben).

**Veredicto en una línea: 81 invariantes nuevos, 27 de los 30 renglones del
checklist de 2b en verde con test nombrado (1 rojo, 1 no cubierto, 1 que le
toca al orquestador), y diez hallazgos — dos de ellos bloqueantes.**

- **H-0** (bloqueante): después de revertir una recepción, `GET /admin/ingredients/{id}/movements`
  devuelve **500** y el libro de ese insumo queda ilegible para siempre.
  `MovementCauseLiteral` no declara `reception_reversal`. **Se cierra con una
  línea.**
- **H-1** (bloqueante): anular un pago hecho desde el cajón devuelve el saldo de
  la cuenta por pagar y **deja vivo el egreso en el turno**: en el cierre a
  ciegas eso es un sobrante fabricado por el monto exacto del pago.

Mi territorio corrido, en serie: **7 rojos y 298 verdes** en backend, **5 rojos
y 69 verdes** en frontend. Los siete rojos de backend son los seis defectos de
§4 (H-0 lo cazan dos tests); ninguno es un invariante mal escrito.

> **LEÉ PRIMERO — este documento tiene DOS rondas.** Las secciones §1 a §7 son
> el informe de la **ronda 1** y se dejan **intactas, como registro**: dicen lo
> que el árbol era el día que se escribieron. Lo que vale hoy está en la
> sección **[Ronda 2](#ronda-2)**, al final: ahí están los diez hallazgos de
> §4 cerrados uno por uno, los invariantes que cambiaron por decisión del
> orquestador, los doce invariantes nuevos, la excepción de escala declarada y
> los dos hallazgos nuevos. **Donde §4 y Ronda 2 discrepen, manda Ronda 2.**

---

## 1. Cuántos invariantes escribí y dónde

| Archivo | Casos | Qué cubre |
|---|---:|---|
| `backend/tests/audit/test_purchases_invariants.py` (nuevo) | **31** | Atomicidad de la recepción, IVA bajo INC, guardas de tecleo, saldo derivado, pagos y el cajón, reversa de recepción, zona horaria, `min_stock`, idempotencia, las cuatro flags de 2b y sus dependencias, confiabilidad del proveedor |
| `backend/tests/audit/test_counts_invariants.py` (nuevo) | **16** | Conteo a ciegas, «no existe todo coincide», el conteo de las 13:07 aplicado a las 15:42, doble aplicación, varianza (identidad + pesos + semáforo), food cost real, salud del control, FEFO con tres lotes, vencido que no se da de baja solo, snapshot |
| `backend/tests/audit/test_contract_2b_invariants.py` (nuevo) | **16** | Los cinco escalones de costo, el promedio desde el último conteo, la lectura agregada de consumo, la deuda declarada de 2a (KPI de mermas, `VOID_AFTER_SEND`), una sola escala publicada, `format` en todo listado, `float` en lo nuevo, `StockBatch` con una sola escritura, las causas nuevas producidas |
| `backend/tests/payments/test_documents.py` (reescrito el barrido + 1 nuevo) | **8** (2 son míos) | El barrido de costo acotado por **sesión** y su hermano: toda ruta `/admin/` exige `current_admin` |
| `frontend/src/audit/purchases-counts.test.ts` (nuevo) | **18** | «Todo coincide» en la UI, conteo a ciegas en pantalla, una sola matemática, `null ≠ 0`, compras fuera del POS, umbrales editables, el cruce `purchases → shifts`, zona horaria |
| `backend/tests/audit/conftest.py` (ampliado) | — | Helpers de 2b por HTTP (`make_supplier`, `post_reception`, `open_count`, `apply_count`, `lots_of`, `set_iva_regime`) y la **clasificación de rutas por sesión** que comparten los tres barridos |
| `test_security_invariants.py`, `test_inventory_invariants.py`, `test_migration_invariants.py` (acotados) | — | Tres invariantes heredados **míos** que 2b rompe por diseño: el barrido de la venta que barría rutas de admin, el enum de causas y el punto de llegada de la cadena de migraciones (§3.9) |

**Total: 81 casos nuevos** (63 de backend en tres archivos nuevos, 18 de frontend), más el
barrido heredado de `test_documents.py` reescrito, un invariante hermano nuevo
en ese mismo archivo (8 casos en total ahí, 2 míos) y **tres invariantes
heredados acotados** (§3.9).

Los helpers de 2b entran **todos por HTTP**, igual que los de 2a: un invariante
que arma la fila con `db.add(...)` se saltea la validación que existe para
defender. Las dos excepciones declaradas son lecturas (`stock_of`, `lots_of`),
porque pedirlas por HTTP mezclaría «el saldo está bien» con «el borde lo
formatea bien» en una sola aserción.

---

## 2. El checklist de 2b, ítem por ítem

Cada renglón con **el nombre del test que lo cubre y su estado real**. «Verde»
sin test nombrado no es una respuesta; «no cubierto» sí lo es.

| # | Renglón del checklist | Test | Estado |
|---|---|---|---|
| 1 | Flags de 2b en los dos estados, respetando dependencias | `test_each_2b_capability_answers_400_feature_disabled_when_its_flag_is_off` (8 casos), `test_with_purchases_off_everything_2a_built_keeps_working`, `test_the_declared_dependencies_between_2b_flags_are_enforced` | **verde** |
| 2 | Recepción confirmada: movimiento + lote + promedio + `payable`, en una transacción; con fallo inyectado no queda nada | `test_a_confirmed_reception_leaves_movement_lot_average_and_payable_in_one_transaction`, `test_a_failure_injected_on_the_last_line_leaves_nothing_behind` | **verde** |
| 3 | El IVA bajo INC entra al costo; la diferencia es exactamente el impuesto | `test_the_tax_enters_the_cost_under_inc_and_the_difference_is_exactly_the_tax` | **verde** |
| 4 | Los cinco escalones de la jerarquía de costo, un test por escalón | `test_rung_1_with_an_official_cost_the_average_never_rules`, `test_rung_2_without_an_official_cost_the_weighted_average_rules`, `test_rung_3_without_purchases_since_the_last_full_count_the_last_purchase_rules`, `test_rung_4_with_only_an_estimate_the_source_is_estimated`, `test_rung_5_with_nothing_the_cost_is_null_with_source_none_never_zero` | **verde** |
| 5 | Una compra anterior al último conteo completo no mueve el promedio | `test_a_purchase_before_the_last_full_count_does_not_move_the_average` | **verde** |
| 6 | Las dos guardas de tecleo preguntan y no corrigen solas | `test_the_two_typing_guards_ask_and_never_self_correct` | **verde** |
| 7 | El saldo se deriva; no existe columna `balance` | `test_the_payable_has_no_stored_balance_column`, `test_voiding_a_payment_returns_it_to_the_derived_balance` | **verde** — pero ver **H-1**: anular un pago del cajón deja la caja descuadrada |
| 8 | Pago en efectivo del cajón: egreso en la misma transacción; sin turno, `409` y el pago no queda | `test_a_cash_payment_creates_the_shift_expense_in_the_same_transaction`, `test_without_an_open_shift_a_cash_payment_is_409_and_no_payment_is_left_behind`, `test_the_cash_payment_lowers_the_expected_cash_of_the_shift_by_exactly_the_amount` | **verde** |
| 9 | No se puede pagar antes de aprobar | `test_paying_before_approving_is_409` | **verde** |
| 10 | Eliminar una recepción revierte todo o falla con nombre propio; nada se borra | `test_reversing_a_reception_undoes_everything_and_deletes_nothing`, `test_reversing_a_reception_whose_lot_was_consumed_fails_by_name`, `test_reversing_a_reception_with_live_payments_fails_by_name` | **verde** — pero ver **H-0**: después de revertir, el libro de ese insumo ya no se puede leer (`500`) |
| 11 | El conteo es a ciegas (test sobre el JSON) | `test_no_response_of_the_capture_flow_carries_the_theoretical_stock` + frontend `el conteo es a ciegas` (2 casos) | **verde** |
| 12 | No existe «todo coincide» (contrato + revisión de la UI) | `test_there_is_no_everything_matches_shortcut`, `test_a_local_draft_never_overwrites_a_confirmed_value` + frontend `no existe «todo coincide» (§5.4)` (3 casos) | **verde** |
| 13 | Aplicar un conteo usa «contado + (entradas − salidas desde el instante del conteo)» | `test_applying_a_count_uses_the_movements_since_the_instant_of_the_count`, `test_applying_a_count_with_a_real_shortfall_writes_exactly_that_shortfall` | **verde** |
| 14 | Aplicar el mismo conteo dos veces no duplica el ajuste (`409`) | `test_applying_the_same_count_twice_does_not_duplicate_the_adjustment` | **verde** |
| 15 | Food cost real `null` con motivo sin dos conteos; se calcula sólo entre ellos; jamás `0` | `test_real_food_cost_is_null_with_a_reason_without_two_consecutive_full_counts`, `test_real_food_cost_is_computed_only_between_two_consecutive_full_counts` | **verde** |
| 16 | > 14 días sin conteo completo: inventario no confiable y el food cost no se publica | `test_past_14_days_without_a_full_count_the_control_is_unreliable_and_food_cost_is_not_published` | **verde** — pero ver **H-4**: «Hoy» y «Salud del control» cuentan los días distinto |
| 17 | La varianza cierra la identidad y publica pesos con origen del costo | `test_the_variance_closes_the_identity_and_publishes_pesos_with_the_cost_source` (caso armado a mano, no generado) | **verde** |
| 18 | Los umbrales del semáforo son configuración de sede | `test_the_traffic_light_thresholds_are_store_configuration` | **verde** — pero ver **H-5**: sin uso teórico el semáforo siempre es verde |
| 19 | FEFO: vencimiento primero, recepción para desempatar (tres lotes) | `test_an_issue_consumes_the_lot_closest_to_expiring_and_ties_break_by_reception` | **verde** |
| 20 | Un lote vencido no se da de baja solo | `test_an_expired_lot_is_never_written_off_automatically` | **verde** |
| 21 | `GET /admin/orders/{id}/consumption` agrega; el libro no fusiona | `test_the_order_consumption_read_aggregates_while_the_ledger_keeps_one_row_per_item` | **verde** — pero ver **H-2**: la ruta está montada dos veces y el contrato publicado no es el que se sirve |
| 22 | Mermas ÷ compras deja de ser `null`, sigue `null` sin compras, no es `float` | `test_the_waste_over_purchases_kpi_stops_being_null_and_is_not_a_float` | **verde** |
| 23 | Una sola escala de cantidad publicada (contrato sobre el OpenAPI) | `test_the_same_magnitude_is_never_published_in_two_scales` | **verde** |
| 24 | Todo listado declara `format`; los de 1b-2 quedan arreglados | `test_every_listing_that_serves_csv_declares_format_in_the_contract` | **verde** — la spec dice «cinco»; **son 21** (ver §4, O-1) |
| 25 | `MovementCause.VOID_AFTER_SEND` se produce o se saca | `test_void_after_send_is_either_produced_or_removed_from_the_enum` | **ROJO — H-3** |
| 26 | Sesión de dispositivo sin `cost` ni `margin`, con `purchases` montado; los tres barridos siguen pasando y cubren las rutas nuevas | `test_openapi_device_responses_never_expose_cost_fields`, `test_every_admin_path_is_served_only_under_an_admin_session`, `test_no_purchases_route_is_reachable_under_a_device_session`, + los heredados de `test_security_invariants.py` | **verde** (ver §3) |
| 27 | Cantidades sin `float` en todo lo nuevo (propiedad sobre 1.000 casos) | `test_no_new_model_or_schema_of_2b_declares_a_float` (AST + anotaciones + OpenAPI) y el heredado `test_cost_invariants.py::test_quantities_are_exact_integers_over_a_thousand_random_cases` (los 1.000 casos, sigue vigente sobre el contrato numérico que 2b no cambió) | **verde** |
| 28 | Zona horaria: una recepción a las 00:30 queda sellada con el día del turno | `test_a_reception_at_0030_is_sealed_with_the_business_day_of_the_shift` | **verde** — pero ver **H-6**: tres pantallas de Compras sí derivan la fecha de la zona del navegador |
| 29 | Admin en 1024 px sin scroll horizontal; foco visible; contraste AA | — | **no cubierto** (§5) |
| 30 | Typecheck, suite completa y build, una vez, en serie | — | **no me corresponde**: lo corre el orquestador |

**Renglones de mi misión que no están en el checklist de la spec pero sí en el
mandato**:

| Qué | Test | Estado |
|---|---|---|
| `record_movement` sigue siendo la única escritura de inventario, **con los caminos nuevos** | heredado `test_inventory_invariants.py::test_no_module_writes_a_stock_movement_outside_record_movement` (barrido de AST sobre todo `app/`, ahora incluye `app/purchases/**`) | **verde** |
| El segundo libro de 2b (`StockBatch`) también tiene una sola escritura | `test_no_module_writes_a_stock_batch_outside_the_inventory_hooks` | **verde** |
| Snapshot: ningún conteo ni varianza revalora una venta pasada | `test_no_count_and_no_variance_ever_revalues_a_past_sale` | **verde** |
| Las tres causas nuevas se producen de verdad | `test_the_new_2b_causes_are_produced_and_typed` | **verde** |
| El egreso del cajón baja el esperado del turno | `test_the_cash_payment_lowers_the_expected_cash_of_the_shift_by_exactly_the_amount` | **verde** |

---

## 3. El recorte de los barridos heredados (tarea asignada)

### 3.1 Cuántas copias hay, de verdad

Busqué por `"cost"`, `"margin"`, `unit_cost`, `MONEY_SECRETS` y `forbidden` en
todo `tests/`. **Hay siete barridos de costo sobre el OpenAPI, no tres**:

| # | Dónde | Alcance | Dueño |
|---|---|---|---|
| 1 | `tests/payments/test_documents.py:139` `test_openapi_device_responses_never_expose_cost_fields` | Documento OpenAPI, acotado | **mío** (reescrito) |
| 2 | `tests/audit/test_reports_invariants.py:410` `test_no_report_ever_exposes_a_cost_or_a_margin` | Respuestas reales de seis reportes admin, lista blanca por reporte | mío (heredado de 1b-2, acotado en 2a) |
| 3 | `tests/audit/test_security_invariants.py:449` `test_openapi_of_catalog_and_shifts_declares_no_cost_fields` | Rutas de dispositivo de 1a | mío |
| 4 | `tests/audit/test_security_invariants.py:832` `..._orders_kitchen_payments_and_documents_...` | Rutas de la venta — **incluía `/admin/orders` y `/admin/documents`**; acotado en 2b (§3.9) | mío |
| 5 | `tests/audit/test_security_invariants.py:1475` `..._the_new_1b2_routes_...` | Rutas de dispositivo de 1b-2 | mío |
| 6 | `tests/audit/test_security_invariants.py:1703` `..._the_new_2a_routes_...` | Rutas de dispositivo de 2a | mío |
| 7 | `tests/recipes/test_openapi_no_cost.py:55` `test_device_preparation_routes_never_declare_cost_fields` | Rutas de preparaciones de dispositivo | **`backend-recetas`**, no mío |

El 2 quedó acotado al cerrar 2a y sigue vigente sin cambios; el 3, el 5, el 6 y
el 7 nacieron acotados a un puñado de rutas de dispositivo nombradas a mano, así
que no tienen forma de acusar a una ruta nueva de compras.

**2b rompe dos: el 1 y el 4.** El 1 lo recorté por sesión (§3.2-3.4). El 4 se
llama «de la venta» pero incluía `/admin/orders` y `/admin/documents` entre sus
prefijos — la misma trampa de R-9, un barrido de operador barriendo rutas de
administrador. En 2a pasaba **por accidente**: esas dos rutas se anotan
`-> Any` para servir `format=csv`, así que sus esquemas nunca llegaron al
OpenAPI y no había nada que barrer. 2b lo destapó, y está en §3.9.

### 3.2 Qué prohibía antes

Tres versiones sucesivas, con su daño documentado:

**v1 (1b, hasta el cierre de 2a).** Serializaba `app.openapi()` **entero** y
buscaba el texto:

```python
raw = json.dumps(app.openapi())
for forbidden in ('"cost"', '"margin"', '"unit_cost"'):
    assert forbidden not in raw
```

Se llamaba «device responses» y no miraba ni rutas ni sesiones: prohibía el
costo **en todo el producto**. Era correcto mientras el producto no tenía
superficie de costo. **El daño**: como era inesquivable y nadie estaba
autorizado a cambiarlo, dos constructores de 2a renombraron campos del contrato
publicado de `/admin/sales` para pasarlo.

**v2 (cierre de 2a, commit `17f5a28`).** Acotado a `"/admin/" not in path`, con
coincidencia **exacta** de nombre contra `("cost", "margin", "unit_cost",
"food_cost")`. Cerró el rojo R-9, pero dejó dos agujeros que 2b destapa:

- **(a) El path no dice quién sirve la ruta.** `POST /receptions` es admin puro
  (`app/purchases/router.py:190`, `current_admin` + `admin_store`) y **no lleva
  `/admin/` en el path** porque el contrato de la spec lo fija así, literal.
  v2 lo mete en el conjunto «de dispositivo» y lo acusa por
  `ReceptionLineOut.unit_cost` / `.final_unit_cost`
  (`app/purchases/schemas.py:109-110`). **Lo verifiqué: con el árbol de hoy, v2
  está en rojo.** Es exactamente la trampa de 2a otra vez — un guard mal
  acotado empujando a renombrar un campo publicado.
- **(b) La coincidencia exacta deja pasar el rodeo.** `theoretical_cost`,
  `unit_cost_micros`, `gross_margin` o `food_cost_pct` en una ruta de
  dispositivo no coinciden con ninguno de los cuatro nombres exactos. Es
  precisamente el nombre que elegiría quien quisiera esquivarlo.

### 3.3 Qué prohíbe ahora (v3)

El alcance se resuelve por **sesión**, no por texto del path:

> Una ruta es **de administrador** si y sólo si su árbol de dependencias de
> FastAPI incluye `app.auth.deps.current_admin`. Sin cookie de admin esa
> dependencia levanta `401` antes de entrar al endpoint, así que un dispositivo
> no puede alcanzarla. **Todo lo demás bajo `/api/v1` entra al barrido.**

La mecánica vive en `tests/audit/conftest.py` (`iter_api_routes`,
`admin_only_paths`, `device_reachable_paths`,
`openapi_properties_reachable_from`), compartida por los tres barridos para que
no vuelvan a divergir entre sí. Hoy da **57 rutas de dispositivo y 97 de
admin**.

Detalle de implementación que vale registrar: FastAPI 0.141 **no clona las
rutas al `include_router`** — deja un `_IncludedRouter` que apunta al router
original. Recorrer `app.routes` a secas devuelve **una sola** ruta (el fallback
de la SPA), así que un barrido escrito de la forma obvia pasaría por vacío. El
helper baja por `original_router.routes` acumulando el prefijo del
`include_context`, y el test tiene una guarda explícita (`len(device_paths) >
30` más cuatro rutas ancla) para que un falso verde por lista vacía sea
imposible.

La coincidencia pasó de **exacta** a **subcadena** (`cost`, `margin`): sobre el
conjunto que sí manda, v3 es **más estricto que v1**. Un
`DeviceIngredientOut.theoretical_cost_micros` inventado mañana cae.

**Y cubre las rutas nuevas de 2b por construcción**: no hay ninguna lista de
rutas escrita a mano. Una ruta de dispositivo agregada mañana entra al barrido
sola, que es lo que el punto 3 de mi misión pedía.

### 3.4 La otra mitad del recorte

Acotar por sesión abre una pregunta nueva: si el alcance ya no depende del
path, ¿qué impide ampliarlo renombrando una ruta? Nada — por eso escribí el
invariante hermano `test_every_admin_path_is_served_only_under_an_admin_session`
(mismo archivo). Exige que «lo que está bajo `/admin/`» y «lo que exige
`current_admin`» coincidan, con dos excepciones **declaradas por escrito**:

- `POST /api/v1/auth/admin/login` lleva `/admin/` y es pública por definición
  (es la puerta por la que se consigue la sesión).
- `POST /api/v1/receptions` es admin y no lleva `/admin/` (el contrato de 2b lo
  fija así).

Cualquier otra ruta que entre o salga de esos conjuntos rompe el test con
nombre y apellido. Es además lo que hace **bloqueante** el invariante heredado
#2 de la spec: si mañana aparece una ruta de compras bajo sesión de
dispositivo, este test la nombra antes de que el costo llegue a la tablet del
salón. Lo complementé con
`test_no_purchases_route_is_reachable_under_a_device_session`, que lo prueba
con la sesión **real** de un dispositivo activado (doce rutas, ninguna
contesta algo distinto de 401/403/404).

### 3.5 Qué dejó de estar cubierto

**El costo en respuestas de administrador** — que es precisamente lo que las
fases 2a y 2b existen para construir. No queda al aire:

- `tests/audit/test_reports_invariants.py:410` sigue barriendo las **respuestas
  reales** de los seis reportes de admin campo por campo, con una lista blanca
  explícita por reporte (`sales: {theoretical_cost, gross_margin}`,
  `orders: {courtesies_cost}`, el resto vacío). Un campo de costo nuevo en
  `/admin/today` sigue siendo una filtración.
- `test_a_device_session_never_reaches_the_admin_routes_of_cost_and_inventory`
  (`test_security_invariants.py:1815`) prueba que el dispositivo no llega a
  esas rutas.
- Los cuatro barridos por fase (1a, 1b, 1b-2, 2a) siguen vigilando sus rutas de
  dispositivo con listas nombradas.

Lo que **de verdad** se perdió respecto de v1 es la propiedad «ningún esquema
del producto, de nadie, menciona costo». Esa propiedad no era un invariante:
era la ausencia de una funcionalidad.

### 3.6 La deuda de nombres de `/admin/sales`: **cerrada, con un comentario podrido**

La spec pide `theoretical_cost`, `gross_margin` y `costed_pct`; 2a publicó
`theoretical_value`, `gross_contribution` y `recipe_coverage_pct` para esquivar
el barrido. **Comprobé contra el código, no contra el informe:**

- `backend/app/reports/schemas.py:238-240` publica hoy
  `theoretical_cost: int | None`, `gross_margin: int | None`,
  `costed_pct: int | None`. Los tres nombres de la spec.
- `backend/app/reports/service.py:370-388` los arma con esos nombres.
- **Ya no existe ninguna ocurrencia de `theoretical_value`,
  `gross_contribution` ni `recipe_coverage_pct` en el backend.** Se cerró en el
  commit `17f5a28`, al cerrar 2a.

Mi recorte **no borra el rastro**: `test_reports_invariants.py:445-447` nombra
`theoretical_cost` y `gross_margin` uno por uno en la lista blanca de `sales`,
así que si alguien los vuelve a renombrar, el test se pone rojo por el lado
contrario (el campo esperado desaparece de la respuesta y aparece otro sin
permiso).

**Lo único que queda de esa deuda es un comentario que miente**:
`frontend/src/api/reports.ts:182-193` sigue diciendo *«El backend los nombra así
(no `theoretical_cost`/`gross_margin`/`costed_pct`) para no chocar con dos
invariantes de OpenAPI»* — mientras las tres propiedades que declara justo
debajo **ya se llaman** `theoretical_cost`, `gross_margin` y `costed_pct`. Es
documentación podrida, no un defecto de contrato: severidad advertencia baja,
lo dejo declarado en §4 (O-2) porque `frontend/src/api/**` es territorio ajeno.

### 3.7 Los otros tres invariantes heredados de la lista de la spec

| # | Invariante | Verificado | Estado |
|---|---|---|---|
| 1 | Los barridos de costo | §3.1-3.6 | **acotado y verde**, cubriendo las rutas nuevas |
| 2 | «El operador no ve costos», y 2b **no** lo toca | `test_no_purchases_route_is_reachable_under_a_device_session`, `test_every_admin_path_is_served_only_under_an_admin_session`, frontend `compras no registra ninguna ruta en el POS` (`app/purchases/router.py:190` exige `current_admin`; `frontend/src/features/purchases/index.ts:28` publica `posRoutes: []`) | **verde**, sin hallazgo bloqueante |
| 3 | El KPI de mermas declaraba `float` | `app/inventory/schemas.py:201` publica hoy `ratio: int | None` (puntos básicos); `app/inventory/service.py:626-628` arma la etiqueta sin `float`. Cubierto por `test_the_waste_over_purchases_kpi_stops_being_null_and_is_not_a_float` | **verde, cerrado** |
| 4 | `min_stock` obligatorio; la recepción no crea insumos por la puerta de atrás | `test_a_reception_cannot_create_ingredients_through_the_back_door` (los dos lados: `400 MIN_STOCK_REQUIRED` sigue vivo, y `ReceptionLineIn` sólo acepta `ingredient_id`, sin `name` ni `create_if_missing`; un id inexistente es `404`) | **verde** |

### 3.8 Un invariante heredado del frontend que 2b rompió, y que decidí NO acotar

Mi mandato incluye acotar con la misma disciplina cualquier invariante heredado
que 2b rompa y que no esté en la lista. Encontré uno, y **decidí no acotarlo**:

`frontend/src/audit/inventory.test.ts:165-173` («nadie multiplica ni divide por
la escala de cantidades o de costos») ahora está **rojo** por
`frontend/src/features/inventory/lib.ts:117-118`, que es código nuevo de 2b
(`parseCountInput`, la calculadora que deja teclear `10+20+5` en la captura de
un conteo).

**Por qué no lo acoto**: el criterio para acotar un invariante es que prohíba
*lo que el pedido existe para construir*. Una calculadora de sumas en la
captura no es eso — `§5.4` no la pide, y el conteo funciona igual sin ella. La
regla que el guard defiende sigue siendo correcta: `QTY_SCALE = 1000` vive en
`backend/app/core/quantity.py` y no se cruza al frontend; escrita también en
`lib.ts:117` queda en dos lugares, y el día que cambie sólo cambia uno. Ver
**H-7** en §4 con las dos salidas.

### 3.9 Tres invariantes heredados más del backend que 2b rompe por diseño, y que la spec no lista

La spec listó **cuatro** invariantes heredados «que 2b toca por diseño». Con el
del frontend de §3.8 y estos tres, **son ocho**. Los tres de acá son míos, los
encontró la corrida de mi propio territorio (no la lista), y los acoté con la
misma disciplina y por escrito. Los tres estaban en verde al cerrar 2a y los
tres se ponen rojos con el árbol de hoy **sin que haya nada mal en el código de
2b**:

| Invariante | Por qué 2b lo rompe | Qué hice |
|---|---|---|
| `tests/audit/test_security_invariants.py:832` `test_the_openapi_of_orders_kitchen_payments_and_documents_declares_no_cost_fields` | Barría `/orders`, `/tables`, `/kitchen`, `/documents` **y también `/admin/orders` y `/admin/documents`**. La lectura agregada `GET /admin/orders/{id}/consumption` que la corrección a §5.3 manda construir publica `cost` y `cost_source` porque es de admin, y es la primera ruta bajo `/admin/orders` cuyo esquema llega al OpenAPI (las otras se anotan `-> Any` para el CSV) | **Acotado** a las cuatro superficies de dispositivo; los dos prefijos `/admin/` salieron, con el motivo y lo que deja de cubrir escritos en el docstring |
| `tests/audit/test_inventory_invariants.py:814` `test_the_ledger_declares_the_four_causes_of_2b_without_using_them` | Fijaba **once** causas exactas. Las «Convenciones propias de 2b» agregan `reception_reversal` con nombre y apellido, y `reverse_reception` la produce | **Movido el poste**, no aflojado: el conjunto exacto pasa a doce, sigue siendo `==` y no `⊇`, y se renombró a `test_the_ledger_declares_the_causes_of_section_5_1_and_nothing_else` |
| `tests/audit/test_migration_invariants.py:370` `test_the_chain_reaches_the_three_migrations_of_cost_and_inventory` | Fijaba `head == "0010"` y 63 tablas. La spec de 2b dice «Alembic arranca en `0011`» | **Movido el poste**: `head == "0012"`, 72 tablas (63 + 5 de `0011_purchases` + 4 de `0012_counts_lots`), más la comprobación de que las nueve tablas nuevas existen. Sigue siendo un valor exacto, que es lo que convierte «me olvidé de encadenar» en un rojo |

Los dos últimos no son «acotar»: son invariantes que fijan un valor exacto a
propósito, y moverlos es parte del trabajo de cada pedido. Lo registro igual
porque el criterio importa: **un invariante que fija un conjunto exacto se
mueve, nunca se afloja a "que contenga al menos"**. Aflojarlo es la forma
silenciosa de perderlo.

Y hay un cuarto que **no toqué a propósito**, porque no está roto: lo que
encontró es un defecto real, y es **H-0**.

---

## 4. Hallazgos, por severidad

Severidad **bloqueante** = plata cobrada, integridad del libro, exposición de
costo al operador, o una regla dura de §11. **No bajé ninguna severidad** y no
la voy a mover entre rondas.

### H-0 — BLOQUEANTE. Después de revertir una recepción, el libro de ese insumo deja de poder leerse (500)

**Dónde**: `backend/app/inventory/schemas.py:18-30` (`MovementCauseLiteral`)
contra `backend/app/inventory/models.py:75`
(`MovementCause.RECEPTION_REVERSAL`), que `backend/app/purchases/service.py:491`
**sí produce**.

**Modo de falla, reproducido**: se recibe mercancía, se revierte la recepción
(`DELETE /admin/receptions/{id}`, que la spec manda soportar: «eliminar una
recepción es una reversa con causa, nunca un `DELETE` de filas»), y después se
abre el libro de ese insumo:

```
GET /api/v1/admin/ingredients/1/movements?store_id=1
  -> 500  Error interno no controlado
  app/inventory/service.py:286  pydantic_core.ValidationError:
  cause  Input should be 'sale', 'production_in', ... or 'transfer_out'
         [input_value='reception_reversal']
```

`StockMovementOut.cause` (`app/inventory/schemas.py:120`) está tipado con un
`Literal` que se quedó con las once causas de 2a. El movimiento de reversa
existe, es correcto, y **el libro es append-only**: la fila no se va nunca, así
que la lectura de ese insumo queda rota **para siempre**. El filtro `?cause=`
de esa misma ruta usa el mismo `Literal`, así que tampoco hay forma de pedir
las reversas.

**Qué integridad toca**: el **libro de movimientos**, que es la fuente de
verdad de toda la fase 2 — el único lugar donde se puede explicar de dónde salió
un faltante. Y es un `500` sobre una lectura, no un `400` con código: `AGENTS.md`
prohíbe explícitamente el `500` por una regla de negocio, y acá ni siquiera hay
una regla de negocio, hay un desfase de tipos.

**Cómo apareció**: lo cazó un invariante **heredado**,
`tests/audit/test_inventory_invariants.py:799::test_the_cost_source_of_the_api_is_the_same_enum_as_the_model`,
puesto en 2a con este docstring textual: *«Si el `Literal` del esquema y el enum
del modelo se separan, el día que 2b agregue `weighted_average` de verdad la API
lo va a rechazar… Es el tipo de desfase que no falla en ningún test de
comportamiento.»* Acertó de lleno, con otra causa. **No lo acoté**: está bien
como está, y por eso lo dejo rojo.

**Tests**: dos rojos, uno estático y uno de comportamiento (fijar el `Literal`
cierra los dos):
`tests/audit/test_inventory_invariants.py::test_the_cost_source_of_the_api_is_the_same_enum_as_the_model`
(heredado) y
`tests/audit/test_contract_2b_invariants.py::test_the_ledger_can_be_read_after_a_reception_is_reversed`
(mío, reproduce el 500 completo).

**Se cierra agregando una línea**: `"reception_reversal"` a
`MovementCauseLiteral`. Dueño: `app/inventory/schemas.py`
(`backend-inventario-espejo`). Es el arreglo más barato de los diez y el más
caro de no hacer.

### H-1 — BLOQUEANTE. Anular un pago hecho desde el cajón fabrica un sobrante en la caja

**Dónde**: `backend/app/purchases/service.py:744-773` (`void_payment`) y
`backend/app/purchases/models.py:288` (`Payment.cash_movement_id`).

**Modo de falla, concreto**: turno abierto con base de $200.000. Se paga una
cuenta por pagar con $50.000 **del cajón** (`from_cash_drawer: true`): el
sistema crea el `CashMovement(kind=EXPENSE, cause=supplier_payment)` y el
esperado baja a $150.000. Alguien se da cuenta de que el pago se registró por
error y lo anula. `void_payment` escribe `voided_at`, `voided_reason` y el
autorizador — y **nunca toca `cash_movement_id`**. Resultado:

- la cuenta por pagar vuelve a deber los $50.000 (correcto, lo pide el
  checklist);
- el egreso sigue vivo en el turno, así que `compute_breakdown`
  (`app/shifts/service.py:239-242`) sigue restando esos $50.000: el esperado se
  queda en $150.000.

En el **cierre a ciegas** eso aparece como un **sobrante de exactamente
$50.000** que el responsable de caja tiene que tipificar con una causa que no
existe. Fabricar sobrantes es literalmente el bug de la referencia que
`AGENTS.md` nombra por escrito en la fila «Caja» de su tabla de excepciones
(«fabricaron sobrantes dobles»), y el sistema **nunca** puede calcular deuda de
un empleado (CST art. 149): la diferencia la escribe una persona.

**Qué plata toca**: el efectivo contado en el cierre, contra el saldo de un
proveedor. Los dos libros cuentan el mismo hecho al revés.

**Test**: `tests/audit/test_purchases_invariants.py::test_voiding_a_cash_drawer_payment_does_not_leave_the_till_short`
— **rojo hoy**, y acepta **cualquiera de las dos salidas correctas**:
(1) anular revierte también el egreso con un movimiento compensatorio de causa
tipada en el turno abierto (nunca borrando la fila), o (2) anular un pago que
salió del cajón se rechaza con nombre propio cuando no se puede compensar, y el
mensaje nombra la acción correctiva. Lo que no puede pasar es que el saldo
vuelva y la caja no se entere.

**Dueño**: `app/purchases/service.py` (`backend-compras`), con el cruce a
`app/shifts/hooks.py` — que es **el huérfano donde ya cayó el hallazgo A-2 de
2a**.

### H-2 — Advertencia alta. `GET /admin/orders/{id}/consumption` está montada dos veces y el contrato publicado no es el que se sirve

**Dónde**: `backend/app/orders/router.py:326` y
`backend/app/inventory/router.py:555`. Los dos dominios construyeron la misma
lectura de 2b y nadie borró la otra.

**Modo de falla, verificado en el árbol, tres consecuencias**:

1. **Despacha `orders`** (se registra primero: `orders` va antes que
   `inventory` en `app/main.py:27,42`), pero **el OpenAPI publica `inventory`**
   (al armar el documento, la segunda ocurrencia del mismo path+método pisa a
   la primera). Lo comprobé sobre `app.openapi()`: el contrato publicado
   declara `store_id` como query **obligatoria** y el esquema
   `app__inventory__schemas__OrderConsumptionOut`, cuyas filas traen
   `item_count` y no traen `unit`; lo que el servidor devuelve es
   `app__orders__schemas__OrderConsumptionOut`, cuyas filas traen `unit`, no
   traen `item_count`, publican `cost` como **entero de pesos** (la otra lo
   publica como texto decimal) y publican `qty_base` **negativo** (las filas de
   venta son salidas) donde la otra lo publica positivo.
2. FastAPI emite `UserWarning: Duplicate Operation ID
   get_order_consumption_api_v1_admin_orders__order_id__consumption_get` al
   generar el OpenAPI. Cualquier generador de clientes rompe o silencia una de
   las dos.
3. `frontend/src/api/inventory.ts:745-764` está tipado contra la versión de
   `inventory` (`item_count: number`, `cost: string | null`, `qty_base`
   documentado como «positivo»). El servidor devuelve la de `orders`. Hoy no
   hay pantalla que lo consuma (el propio archivo lo declara en su comentario),
   así que no se ve; la primera que se escriba lee `undefined` y pinta un signo
   cambiado.

**Qué integridad toca**: ninguna plata se mueve hoy, pero es **exactamente el
modo de falla que 2a dejó documentado** — un contrato publicado que difiere del
servido — y además es una segunda implementación de la misma lectura, con
semánticas distintas (la de `orders` suma **todas** las causas, incluida
`note_return`; la de `inventory` suma sólo `SALE`). Un libro con dos lectores
que no coinciden deja de ser un libro.

**Test**: `tests/audit/test_contract_2b_invariants.py::test_the_order_consumption_route_is_registered_exactly_once` — **rojo**.
El ítem 21 del checklist en sí está **verde**
(`test_the_order_consumption_read_aggregates_while_the_ledger_keeps_one_row_per_item`
pasa contra la implementación que se sirve).

**Dueño**: decisión del orquestador sobre cuál de las dos queda; el cruce es
`orders ↔ inventory`, dos territorios.

### H-3 — Advertencia. `MovementCause.VOID_AFTER_SEND` sigue declarada y sigue sin producirse: el checklist pide una de dos salidas y no se tomó ninguna

**Dónde**: `backend/app/inventory/models.py:63` (declarada) y
`backend/app/orders/service.py:1250-1285` (la decisión de no producirla).

**Qué pasó**: el razonamiento de **no producirla** es correcto y está muy bien
argumentado — producirla exigiría un par alta+baja que se cancela, y desde 2b
la mitad negativa dispararía una **segunda depleción FEFO real** de
`StockBatch.qty_remaining` (`app/inventory/hooks.py:236-242`) sobre cantidad que
ya se consumió al vender. Eso corrompería la contabilidad por lote aunque el
saldo agregado quede exacto. El propio docstring lo dice y
`tests/orders/test_consumption.py:746` lo fija.

**Lo que quedó sin hacer es la otra mitad**: sacarla del enum. El builder lo
declara explícitamente como «territorio de `app/inventory/models.py`, fuera de
este territorio», y el dueño de ese archivo no la sacó. El renglón del
checklist dice «**se produce o se saca**», y no se hizo ninguna de las dos.

**Modo de falla**: un lector del contrato tiene que suponer que existen mermas
por anulación agrupables por causa. No las hay: un reporte de merma por
anulación agrupado por causa devuelve vacío, y hay que leerlo de `waste_stubs`.
Es pérdida de señal, no de plata.

**Test**: `tests/audit/test_contract_2b_invariants.py::test_void_after_send_is_either_produced_or_removed_from_the_enum` — **rojo**.
Se cierra borrando una línea de `app/inventory/models.py` (y el renglón
correspondiente de
`tests/audit/test_inventory_invariants.py:814-839`, que es mío y actualizo yo
cuando la decisión esté tomada).

### H-4 — Advertencia. «Hoy» y «Salud del control» cuentan distinto los días desde el último conteo completo

**Dónde**: `backend/app/inventory/service.py:1505-1507` (`control_health`, resta
**fechas de negocio** con `tz.business_date_for`) contra
`backend/app/reports/service.py:729-730` (`_inventory_reliability`, resta
**instantes UTC**: `(now - last_applied).days`, que trunca hacia abajo y
descuenta la hora del día). La constante, además, está declarada dos veces:
`CONTROL_HEALTH_STALE_DAYS` (`inventory/service.py:1495`),
`FOOD_COST_STALE_DAYS` (`inventory/service.py:1279`) y
`_CONTROL_HEALTH_STALE_DAYS` (`reports/service.py:726`).

**Modo de falla, con números**: conteo completo aplicado a las 18:00 de Bogotá
del 15 de enero; se consulta a las 09:00 de Bogotá del 30. Por fecha de negocio
han pasado **15** días → `GET /admin/control-health` dice
`inventory_unreliable: true` y `GET /admin/food-cost` **deja de publicar** el
food cost real. Restando instantes UTC han pasado 14 días y 15 horas, que
truncado da **14**, y 14 no es «> 14» → `GET /admin/today` dice
`inventory_unreliable: false`. El tablero que el dueño mira todas las mañanas
dice que el inventario es confiable mientras el número que le importa ya no se
publica, y nadie le dice por qué.

**Qué regla toca**: «una sola matemática, en el backend» (`AGENTS.md`), la misma
pregunta con dos fórmulas.

**Test**: `tests/audit/test_counts_invariants.py::test_today_and_control_health_agree_on_the_days_since_the_last_full_count` — **rojo**.

### H-5 — Advertencia. La varianza sin uso teórico se pinta verde: el caso de fuga pura es el único que el semáforo no alerta

**Dónde**: `backend/app/inventory/service.py:1169-1177` (`_variance_level`
devuelve `"green"` cuando `pct_bp is None`) y `:1237-1241` (`variance_pct_bp`
queda `None` siempre que el uso teórico del período sea `0`).

**Modo de falla, con números**: un insumo con $500 por unidad, conteo inicial
1.000, conteo final 600, **ninguna venta ni producción que lo explique**. La
varianza en cantidad es 400 y en pesos $200.000 — y los dos se publican bien.
El semáforo dice **verde**, porque `theoretical == 0` y el porcentaje queda
`null`. Es decir: el caso más sospechoso de todos (desapareció stock y nada lo
justifica) es el único que no levanta la alarma. Un insumo que se fuga por robo
puro tiene exactamente esta forma.

**Qué plata toca**: la plata está contada (`variance_value` sale correcto); lo
que se pierde es la alarma, que es para lo que existe un semáforo.

**Test**: `tests/audit/test_counts_invariants.py::test_variance_without_theoretical_usage_is_painted_green` — **rojo**.
Se cierra con una línea: cuando no hay uso teórico pero sí varianza, el nivel no
puede ser verde.

### H-6 — Advertencia. Tres pantallas de Compras derivan la fecha de negocio de la zona del navegador

**Dónde**: `frontend/src/features/purchases/PayablesTab.tsx:24`,
`ReceptionsTab.tsx:25` y `SupplierReliabilityDialog.tsx:16`, las tres con
`const iso = (d: Date) => d.toISOString().slice(0, 10)`.

**Modo de falla**: `toISOString()` da la fecha **UTC**. En Bogotá (UTC−5),
desde las 19:00 locales en adelante eso ya es **mañana**. El rango por defecto
de Compras, de Cuentas por pagar y de la confiabilidad del proveedor queda
corrido un día **todas las noches** — que es justo cuando un administrador
revisa el día. Una recepción hecha a las 20:00 no aparece en «los últimos 90
días» calculados a las 20:01.

**Qué regla toca**: la fila «Fecha y hora» de `AGENTS.md` — la fecha operativa
se resuelve en `America/Bogota`, en columna propia, y un día que «cambia» a las
7 pm por derivar la fecha de UTC es un bug real de la referencia. **El helper
correcto ya existe en el árbol**: `frontend/src/features/reports/lib.ts:122`
(`new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" })`).

**Tests**: dos rojos por el mismo defecto (fijar uno cierra los dos):
`frontend/src/audit/security.test.ts` → `no usa toISOString().slice(0, 10)`
(heredado, lo cazó él solo) y
`frontend/src/audit/purchases-counts.test.ts` → `ninguna pantalla de compras
deriva la fecha de la zona del navegador` (mío, nombra el territorio y el
remedio).

### H-7 — Advertencia. La calculadora del conteo escribe `QTY_SCALE` en el cliente

**Dónde**: `frontend/src/features/inventory/lib.ts:117-118`
(`parseCountInput`), código nuevo de 2b.

**Modo de falla**: no hay error numérico hoy — el regex de la línea 104 limita a
tres decimales y `Math.round(Number(t) * 1000)` es exacto en ese rango. Lo que
hay es **la escala escrita dos veces**: `QTY_SCALE = 1000` vive en
`backend/app/core/quantity.py:31` y no se cruza al frontend por contrato (la
API manda y recibe texto decimal ya convertido). El día que cambie la precisión
base, sólo cambia uno de los dos, y el que se queda viejo es el que trunca lo
que el operador teclea en un conteo.

**Dos salidas**: (1) sacar la calculadora de sumas —`§5.4` no la pide y la
captura funciona igual—, o (2) dejarla y **declarar la excepción por escrito**
en el barrido, con archivo y símbolo, como ya se hace con el resto de las
excepciones de ese archivo. La segunda es legítima; lo que no es legítimo es
dejar el guard rojo sin decisión.

**Test**: `frontend/src/audit/inventory.test.ts` → `nadie multiplica ni divide
por la escala de cantidades o de costos` (heredado, mío) — **rojo**. Ver §3.8
para por qué no lo acoté yo.

### H-8 — Advertencia. El egreso del pago a proveedor se pinta sin causa en la pantalla del turno

**Dónde**: `backend/app/shifts/schemas.py:26` agregó `"supplier_payment"` al
contrato de causas de caja, y el frontend no se enteró:
`frontend/src/api/shifts.ts:33-39` (la unión `CashMovementCause`) y
`frontend/src/features/shifts/MovementsPanel.tsx:35-42` (`CAUSE_LABEL`) siguen
con las seis causas de 1a.

**Modo de falla**: `MovementsPanel.tsx:203` pinta
`{movement.cause ? CAUSE_LABEL[movement.cause] : "—"}`. Para
`supplier_payment` el índice da `undefined` y la celda sale **en blanco**. El
responsable de caja ve, en la lista de movimientos del turno que está por
cerrar **a ciegas**, un egreso de $50.000 **sin nombre**. El typecheck no lo
caza porque `Record<CashMovementCause, string>` sólo es exhaustivo sobre la
unión, y la unión es la que quedó desactualizada.

**Qué toca**: no mueve plata (el monto y el esperado están bien), pero degrada
justo el momento en que una persona tiene que explicar una diferencia. Es el
cruce `purchases → shifts` otra vez, el huérfano de 2a.

**Test**: `frontend/src/audit/purchases-counts.test.ts` → `el frontend conoce la
causa 'supplier_payment' y sabe cómo nombrarla` — **rojo**.

### H-9 — Advertencia baja. Un monto de pago que se cae a `0` en el cliente

**Dónde**: `frontend/src/features/purchases/PayableDetailDialog.tsx:186`,
`amount: amount ?? 0` dentro del cuerpo que se manda a
`POST /admin/payables/{id}/payments`.

**Modo de falla**: hoy **no puede dispararse** — el botón está deshabilitado con
`!amountValid` (`:260`) y el backend defiende con `PaymentIn.amount: int =
Field(gt=0)` (`app/purchases/schemas.py:166`), así que lo peor sería un `422`.
Pero es exactamente el patrón que `AGENTS.md` prohíbe («`null` no es 0»), la
guarda está 74 líneas más arriba, y un refactor que la mueva manda un pago de
$0 sin que nada en el archivo lo impida. Severidad honesta: baja, con la
mitigación declarada.

**Test**: `frontend/src/audit/purchases-counts.test.ts` → `ningún costo, saldo,
porcentaje ni razón se reemplaza por cero al pintarlo` — **rojo**.

### Observaciones verificadas que NO escribí como test

No son hallazgos: son decisiones que conviene que estén sobre la mesa.

- **O-1 — la spec dice «cinco» listados y son veintiuno.** Conté con un barrido
  de AST sobre todo `app/**/router.py`: **29 endpoints sirven `format=csv`** y
  **los 29 lo declaran** en su firma. De ésos, **21 ganaron la declaración en
  este pedido** (12 routers: `audit`, `auth` ×2, `catalog` ×3, `customers` ×2,
  `fiscal` ×3, `notifications`, `payments`, `refunds`, `reports` ×2, `shifts`
  ×2, `stores`). La deuda de 1b-2 era cuatro veces más grande de lo que la spec
  declaraba, y quedó cerrada entera. Mi test cuenta solo, así que sigue valiendo
  cuando aparezca el treinta.
- **O-2 — un comentario podrido en `frontend/src/api/reports.ts:182-193`**:
  dice que el backend usa nombres de rodeo para `/admin/sales`, y el backend ya
  usa los de la spec desde `17f5a28`. Territorio ajeno; ver §3.6.
- **O-3 — hay dos «promedios ponderados» distintos.**
  `app/purchases/service.py:145` (`_weighted_average_reference`, **pre-impuesto**
  y sobre **todo** el histórico, para las guardas de tecleo) y
  `app/inventory/hooks.py:619` (`weighted_average_cost_micros`,
  **con impuesto bajo INC** y **desde el último conteo completo**, para la
  jerarquía de costo). Cada uno es correcto para lo suyo y el primero declara
  la simplificación en su docstring. El roce está en el mensaje al usuario:
  «se aleja más de 15 % **del promedio ponderado**» compara contra un número
  que no es el `cost` que la misma pantalla muestra para ese insumo.
- **O-4 — `GET /admin/variance`, `/admin/food-cost` y `/admin/control-health`
  se anotan `-> Any`** (`app/inventory/router.py:509, 526, 539`) para poder
  servir CSV, así que **sus esquemas no llegan al OpenAPI**. Es la observación
  O-9 de 2a, ahora sobre la superficie de costo más nueva de la fase: los tests
  de contrato sobre el documento (una sola escala, campos `number`) **no los
  ven**. Los cubro por respuesta real, con datos cargados, pero el control
  queda por un solo lado.
- **O-5 — el monto de la cuenta por pagar no se arma con los números de la
  factura.** `app/purchases/service.py:421-422` calcula
  `Σ (qty_invoiced × unit_cost_pre-impuesto) + tax_amount`, no
  `Σ (tax_base + tax_amount)`, que es lo que dice el papel. Con precios
  redondos coinciden; con una factura que redondea, el `payable` que el
  administrador aprueba difiere en pesos del documento que tiene en la mano. No
  lo escribí como test porque el contrato de 2b no fija cuál de las dos es la
  buena: es una pregunta para el dueño de la spec.
- **O-6 — los lotes y el libro se separan hacia abajo, por diseño.** FEFO
  consume lotes en cada salida (`hooks.py:236-242`) pero ninguna **entrada** que
  no sea una compra crea lote: la reversión de una nota «vuelve» y un ajuste de
  conteo **positivo** suben el saldo del libro y no devuelven nada a los lotes.
  `Σ qty_remaining` queda por debajo de `current_stock`, y `GET /admin/lots`
  sub-reporta. Es coherente con «FEFO no bloquea», está implícito en el diseño
  y no lo contradice ningún renglón del checklist — pero conviene que esté
  escrito antes de que alguien sume lotes para cuadrar un conteo.
- **O-7 — la guarda de tecleo usa el costo oficial como referencia cuando no
  hay compras** (`app/purchases/service.py:168-176`). La **primera** recepción
  de un insumo con costo oficial puesto se corta con `409 PRICE_JUMP` si el
  precio real se aparta más de 15 % de lo que el dueño estimó. Es defendible
  («pregunta, no corrige»), y se limpia con `confirm_price: true`; lo dejo
  anotado porque en el recorrido en navegador se va a ver en la primera compra
  y puede leerse como un bug.

---

## 5. Lo que NO pude verificar en este entorno

- **Ítem 29 del checklist (Admin en 1024 px sin scroll horizontal, foco
  visible, contraste AA).** Hace falta un navegador real y un medidor de
  contraste. Mismo hueco abierto desde 1a; no lo puedo cerrar con un test de
  nodo. Lo que sí cubrí desde `src/audit/` es la parte que se puede leer en el
  código: que las pantallas existen y están cableadas, que el conteo a ciegas no
  trae el teórico y que no hay ningún control de «marcar todo».
- **Postgres real.** Todo corrió en SQLite. Sin probar: enums nativos,
  `SELECT FOR UPDATE`, índices parciales y los `409` de carrera bajo bloqueo
  real. En particular, la atomicidad de la recepción y el `409` de aplicar un
  conteo dos veces se probaron **sin** concurrencia real: mi test de atomicidad
  inyecta el fallo, no lo produce una carrera. **Hay que volver a mirarlo en el
  CI.**
- **La transacción de verdad.** El test de atomicidad se apoya en que
  `app/core/db.py:110-121` hace `rollback()` ante cualquier excepción que no sea
  `AppError`, y en que el override de `get_db` de los tests
  (`tests/conftest.py:90-108`) espeja esa política con un `SAVEPOINT`. Es un
  espejo fiel, pero es un espejo: la garantía sobre una conexión real de
  Postgres queda para el CI.
- **`GET /admin/variance` y `/admin/food-cost` desde el OpenAPI** (O-4): sus
  esquemas no están publicados, así que los barridos de contrato no los
  alcanzan. Los cubrí por respuesta real.
- **El recorrido con el seed real.** No corrí `python -m app.seed` (base
  compartida, cinco agentes en paralelo). Leí `app/seed.py:253-299`,
  `app/purchases/seed.py` y `app/inventory/seed.py:175`: los tres huérfanos
  nombrados por la spec están cubiertos —dos proveedores, recepciones con lote
  y vencimiento, y **dos** conteos completos aplicados y consecutivos (la
  decisión de hacer dos y no uno está declarada, y es correcta: con uno solo el
  food cost real sería `null` para siempre en una base sembrada)—, pero
  **verificado por lectura, no por ejecución**.
- **La suite completa.** No la corrí, por la regla de verificación: cinco
  agentes trabajan sobre el mismo árbol. Corrí sólo mi territorio.

**Lo que sí corrí, entero y en serie** (`TMPDIR=/tmp/pt-auditor`, propio):

```
cd backend && python -m pytest -q -p no:cacheprovider tests/audit tests/payments/test_documents.py
  -> 7 failed, 298 passed  (17:05)
cd backend && python -m mypy tests/audit/test_purchases_invariants.py \
    tests/audit/test_counts_invariants.py tests/audit/test_contract_2b_invariants.py \
    tests/payments/test_documents.py tests/audit/conftest.py
  -> Success: no issues found in 5 source files
cd frontend && npx vitest run src/audit
  -> 5 failed, 69 passed (74)
cd frontend && npx tsc --noEmit
  -> limpio
```

---

## 6. Predicción de la corrida final

En 2a esta predicción acertó ocho de ocho dentro del territorio auditado. La
vara es ésa.

### Backend — `tests/audit/**` + `tests/payments/test_documents.py`

**Predigo 7 rojos, con nombre y apellido** (6 defectos: H-0 lo cazan dos tests):

| # | Test | Hallazgo |
|---|---|---|
| 1 | `tests/audit/test_inventory_invariants.py::test_the_cost_source_of_the_api_is_the_same_enum_as_the_model` | **H-0, bloqueante** (heredado, lo cazó él solo) |
| 2 | `tests/audit/test_contract_2b_invariants.py::test_the_ledger_can_be_read_after_a_reception_is_reversed` | **H-0, bloqueante** (mismo defecto, por comportamiento) |
| 3 | `tests/audit/test_purchases_invariants.py::test_voiding_a_cash_drawer_payment_does_not_leave_the_till_short` | **H-1, bloqueante** |
| 4 | `tests/audit/test_contract_2b_invariants.py::test_the_order_consumption_route_is_registered_exactly_once` | H-2 |
| 5 | `tests/audit/test_contract_2b_invariants.py::test_void_after_send_is_either_produced_or_removed_from_the_enum` | H-3 |
| 6 | `tests/audit/test_counts_invariants.py::test_today_and_control_health_agree_on_the_days_since_the_last_full_count` | H-4 |
| 7 | `tests/audit/test_counts_invariants.py::test_variance_without_theoretical_usage_is_painted_green` | H-5 |

**No es una predicción a ciegas: es la corrida.** Corrí mi territorio entero
—`tests/audit` + `tests/payments/test_documents.py`, 305 casos— dos veces, en
serie, con el árbol de hoy:

| Corrida | Resultado |
|---|---|
| 1.ª (antes de acotar los invariantes heredados) | **7 failed, 293 passed** en 16:51 |
| 2.ª (con §3.9 acotado y H-0 reproducido) | **7 failed, 298 passed** en 17:05 |

Los siete rojos de la segunda corrida son **exactamente** los siete de la tabla
de arriba. En la primera, cuatro de los siete eran invariantes heredados míos
que 2b rompe por diseño (§3.9) y uno era H-0 sin su test de comportamiento;
después de acotar los tres que correspondía acotar y de escribir la
reproducción de H-0, el conjunto quedó en los seis defectos reales.

Los **56 casos restantes** de mis tres archivos nuevos están **verdes**.
`tests/payments/test_documents.py` está **en verde completo (8 de 8)**, incluidos
el barrido recortado y su hermano nuevo.

### Frontend — `src/audit/**`

**Predigo 5 rojos, que son 4 defectos** (dos tests cazan H-6):

| # | Test | Hallazgo |
|---|---|---|
| 6 | `security.test.ts` → `no usa toISOString().slice(0, 10)` | H-6 |
| 7 | `purchases-counts.test.ts` → `ninguna pantalla de compras deriva la fecha de la zona del navegador` | H-6 (mismo defecto) |
| 8 | `inventory.test.ts` → `nadie multiplica ni divide por la escala de cantidades o de costos` | H-7 |
| 9 | `purchases-counts.test.ts` → `el frontend conoce la causa 'supplier_payment' y sabe cómo nombrarla` | H-8 |
| 10 | `purchases-counts.test.ts` → `ningún costo, saldo, porcentaje ni razón se reemplaza por cero al pintarlo` | H-9 |

Los otros **69 casos** de `src/audit/**` están verdes. Corrido dos veces:
**5 failed, 69 passed (74)**, idéntico las dos.

### Fuera de mi territorio

No predigo nada sobre `tests/inventory/**`, `tests/purchases/**`,
`tests/reports/**`, `tests/orders/**`, `tests/shifts/**` ni
`tests/core/**`: son de sus constructores y no los corrí. Dos avisos, sí:

- **`tests/audit/conftest.py` creció** con los helpers de 2b. No redefiní
  ninguna fixture existente ni toqué una sola línea previa —sólo agregué al
  final—, así que no debería mover ningún test heredado; si algún archivo de
  `tests/audit/**` se pusiera rojo por un `ImportError`, es mío y es de una
  línea.
- **H-0 se cierra con una línea** (`"reception_reversal"` en
  `MovementCauseLiteral`, `app/inventory/schemas.py:18-30`) y **no mueve ningún
  test de otro territorio**: el `Literal` sólo se amplía. Es lo primero que
  haría.
- **Si el orquestador cierra H-3 sacando `VOID_AFTER_SEND` del enum**, hay que
  actualizar con él
  `tests/audit/test_inventory_invariants.py::test_the_ledger_declares_the_causes_of_section_5_1_and_nothing_else`
  (es mío, es una línea) y `tests/recipes/_inventory_stub.py:40`, que replica el
  enum para los tests de recetas (territorio ajeno).
- **Si el orquestador cierra H-2 borrando la ruta de `app/inventory/router.py`**,
  se caen los tests de `tests/inventory/test_order_consumption.py` que la
  prueban con `store_id` obligatorio; si la cierra borrando la de
  `app/orders/router.py`, se caen los de `tests/orders/test_consumption.py`.
  **Cualquiera de las dos salidas mueve tests de otro territorio**: no es una
  decisión que pueda tomar un solo constructor.

### Y un aviso sobre el `UserWarning` que va a aparecer en la corrida

`app.openapi()` emite
`UserWarning: Duplicate Operation ID get_order_consumption_...` cada vez que se
genera el documento. Aparece en la salida de cualquier test que toque el
OpenAPI y **no es ruido**: es H-2 avisando.

---

## 7. La lección de este pedido, para el próximo reparto

La regla de nombrar dueño a los huérfanos volvió a funcionar donde se aplicó:
`app/seed.py`, `app/inventory/hooks.py`, `app/core/quantity.py`,
`app/reports/schemas.py`, `frontend/src/features/settings/**` y
`frontend/src/app/router.tsx` están todos cubiertos y ninguno falló. **Y volvió
a fallar donde el cruce es entre dos dueños, no donde falta uno**:

- **H-1** y **H-8** caen en `purchases → shifts`. `app/shifts/**` **sí** tuvo
  dueño esta vez —la spec lo nombró— y aun así el cruce falló, porque el dueño
  de `shifts` construyó la mitad que le pedían (`register_supplier_payment_expense`)
  y el dueño de `purchases` no pidió la otra (revertirla). **Nombrar dueño a un
  archivo no alcanza cuando lo que hay que nombrar es un ida y vuelta.**
- **H-2** cae en `orders ↔ inventory`: dos dueños construyeron la **misma** ruta
  porque la spec la menciona en la sección de `inventory` («Reads that 2a asked
  for») y el dato vive en `orders`. Nadie invadió territorio ajeno; los dos
  creyeron que era suyo.
- **H-4** cae en `inventory → reports`: la misma constante y la misma pregunta,
  respondidas dos veces.
- **H-0** cae en `purchases → inventory`, y es el más elocuente de los cinco:
  el dueño de `inventory` agregó la causa nueva al **modelo** (`models.py:75`)
  porque la spec se la pidió, el dueño de `purchases` la **produjo** porque la
  spec se la pidió, y **nadie era dueño del `Literal` publicado**
  (`schemas.py:18-30`), que está en `inventory` pero sólo se rompe cuando
  `purchases` escribe. Un contrato de ida sin la vuelta, otra vez.

La regla nueva que propongo para el próximo pedido, y que se puede medir:
**cuando una capacidad cruza dos dominios, el reparto tiene que nombrar el
CONTRATO, no sólo los archivos** — quién publica la función, quién la llama, y
**qué pasa cuando se deshace**. Los tres hallazgos de arriba son, los tres, la
mitad de ida construida sin la mitad de vuelta.

La lección de 2a sobre los invariantes envejecidos también se sostuvo, y con dos
correcciones. La primera: **eran siete copias, no tres**, y el recorte correcto
no era acotar por texto del path sino por **sesión**. La segunda: la spec listó
cuatro invariantes heredados «que 2b toca por diseño» y **son siete** (§3.9) —
los tres que faltaban los encontró la corrida de mi propio territorio, no la
lista. Nombrar los invariantes heredados de entrada funciona, pero **la lista
la escribe quien redacta la spec y por definición no puede ver los que
envejecieron sin que nadie los mirara**. La única forma de encontrarlos es
correr el territorio heredado entero antes de declarar nada — que es
exactamente lo que destapó H-0. Un invariante acotado por una cadena de
texto se vuelve a romper en cuanto una ruta legítima no sigue la convención de
nombres — que es exactamente lo que hizo `POST /receptions`, con el contrato de
la spec de su lado.
