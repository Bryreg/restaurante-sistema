# `auditor-canales-2c` — los 15 renglones del checklist como invariantes ejecutables

**Auditor del pedido 2c («Canales y cocina»).** No construí producto: escribí
invariantes para romper el que construyeron los otros cinco agentes, y
**verifiqué cada cierre contra el código y contra el sistema corriendo, nunca
contra los informes**.

Territorio de escritura, respetado sin excepción: `backend/tests/audit/**` y
`frontend/src/audit/**`. **No escribí una sola línea de `backend/app/**` ni de
`frontend/src/` fuera de `src/audit/`.** Los defectos que encontré los reporto
con archivo, línea y el test que los demuestra; ninguno lo arreglé.

---

## Veredicto en una línea

**El producto que 2c existía para construir está construido y los trece
renglones técnicos del checklist tienen test nombrado — pero el pedido rompe
por dos caminos distintos el invariante heredado que la spec declaró como el
más delicado, «el esperado de caja», y los dos son plata: la propina en
efectivo de un domicilio entra al esperado por un camino y no por el otro, y
`GET /shifts/{id}/tips` cuenta esa misma propina dos veces con dos fórmulas
dentro del mismo cuerpo.**

`app/shifts/**` era territorio cruzado **por tercera vez**, y por tercera vez
ahí cayó un hallazgo. Esta vez cayeron dos.

| | Resultado |
|---|---|
| `pytest tests/audit` (los 15 archivos, una corrida en serie) | **6 failed, 409 passed** — 1186,72 s (19:46) |
| Invariantes nuevos escritos | **112** casos en backend (4 archivos), **29** en frontend (1 archivo) |
| **Rojos, y son los SEIS que declaro como hallazgos** | **6** (2 BLOQUEANTES, 4 ADVERTENCIAS). **Ningún invariante heredado de `tests/audit` quedó rojo** |
| `python -m mypy app` | **Success: no issues found in 123 source files** |
| `npm run typecheck` | **limpio** (exit 0, sin salida) |
| `npx vitest run src/audit` | **7 archivos, 107 tests, 0 rojos** (78 heredados + 29 míos) |
| Alembic desde cero | `0001 → 0015`, **79 tablas**, medido corriendo la cadena |
| OpenAPI de la app **real** | **0 `Duplicate Operation ID`**, 171 rutas |
| Barridos de costo de dispositivo | **66 rutas de dispositivo, 104 de admin, 0 filtraciones** |

---

## 1. Los 15 renglones del checklist, uno por uno

### ✅ #1 — Las cuatro flags, en los dos estados, con sus dependencias

**VERDE.** 19 rutas nuevas × 2 estados + las dependencias del catálogo.

| Test | Qué prueba |
|---|---|
| `tests/audit/test_channels_invariants.py::test_every_2c_route_answers_feature_disabled_when_its_flag_is_off` (19 casos) | Con las cuatro flags apagadas, **ninguna** ruta nueva se alcanza: `400 FEATURE_DISABLED` con la forma `{error:{code,message}}` y el `feature` que falta **nombrado en el error** |
| `::test_every_2c_route_gets_past_its_gate_when_the_flag_is_on` (19 casos) | Con la flag encendida el gate deja de ser lo que corta, y **ninguna** responde `500` |
| `::test_the_declared_dependencies_of_the_four_2c_features_are_the_ones_the_catalog_publishes` | Las dependencias se leen de `app/core/features.py`, no de una lista a mano: `pos.delivery→pos.takeout`, `pos.courses→kitchen.view`, `kitchen.kds→kitchen.view`, `pos.platforms→[]` |
| `::test_the_dependencies_are_enforced_where_the_flag_is_turned_on` | `PUT /admin/features/{key}` corta en **los dos sentidos** (`app/stores/router.py:294-309`): no se enciende una función con su dependencia apagada, ni se apaga una de la que otra depende. Probadas las tres dependencias de 2c |
| `::test_a_delivery_order_is_refused_when_its_declared_dependency_is_off` | Defensa en profundidad: con `pos.takeout` apagada a mano, crear un domicilio corta nombrando `pos.takeout`, no la flag propia |
| `::test_with_the_four_flags_off_the_1b_kitchen_view_answers_exactly_as_before` | «Todo lo de 1b sigue IDÉNTICO»: con `kitchen.kds` apagada, `GET /kitchen/rounds` no gana **ni una** de las cuatro claves del KDS (`platform`, `course_fired_at`, `bumped_by`, `bumped_at`) |

**Nota que vale la pena leer**: `backend-kds` decidió que cada ruta chequee
**sólo su propia flag**, no también la dependencia. Lo verifiqué y **es
correcto**, porque el interruptor (`app/stores/router.py`) no deja llegar a un
estado inconsistente por la API. `create_order` sí repite el chequeo para
`pos.delivery→pos.takeout` — no es contradicción, es defensa en profundidad
declarada en el código para el estado que un `UPDATE` a mano puede dejar.

---

### 🔴 #2 — Una venta cobrada por plataforma no mueve el efectivo esperado

**VERDE en lo que el renglón pide literalmente; ROJO en el invariante hermano
que el renglón protege** (ver **H-1**).

| Test | Qué prueba |
|---|---|
| `tests/audit/test_channels_money_invariants.py::test_a_platform_sale_does_not_move_the_expected_cash_of_the_shift` | El test literal: abrir turno, leer el esperado, vender y cobrar $100.000 por plataforma, leer el esperado. **Idéntico** |
| `::test_the_platform_payment_never_lands_in_the_cash_bucket_of_get_sales_totals` | El camino ENTERO, no sólo `compute_breakdown`: `get_sales_totals` (`app/shifts/hooks.py:77`) manda la venta a `.other`, `.cash` queda en 0, y se exige que `"platform"` siga dentro de `_OTHER_METHODS` (`hooks.py:59`) — sacarlo de ahí haría entrar el cobro al esperado sin cambiar una línea de `compute_breakdown` |
| `::test_a_platform_sale_does_not_move_the_arqueo_of_the_blind_close` | **Donde la plata se ve de verdad**: paso 1 y paso 2 del cierre a ciegas. Con la base fija contada exacta, `difference == 0` y `requires_cause is False` después de vender por plataforma. Si el cobro se hubiera colado, quien cuenta vería un faltante de $100.000 y le pedirían causa por plata que nunca estuvo en el cajón |
| `::test_the_expected_cash_formula_never_gained_a_second_term` | Invariante estructural sobre el **AST** de `compute_breakdown`: `expected` se asigna **una sola vez** y esa asignación no contiene `delivery_cash_pending`, `delivery_cash`, `tips_delivery` ni `other`. Un comentario que nombre la fórmula no lo engaña |

---

### ✅ #3 — El cargo de domicilio es una LÍNEA con impuesto

**VERDE**, con la cuenta hecha y con el invariante estructural que lo protege.

| Test | Qué prueba |
|---|---|
| `::test_the_delivery_fee_is_a_line_with_tax_and_enters_the_taxable_base` | Numérico y verificado corriendo. Plato $100.000 + cargo $5.000 → total **$105.000**; la línea del cargo aparece en `FiscalDocument.lines` con `tax_rate = 8`, `base = 4.630`, `tax = 370`, `net = 5.000`; `tax_lines[8].base = 97.223` = base del plato + base del cargo. **Si el cargo no causara impuesto, `base` sería 5.000 y `tax` 0, y el test sería rojo.** El cliente nunca manda el cargo: nace como línea al crear la comanda |
| `::test_no_delivery_fee_field_is_ever_added_by_hand_to_a_total` | El invariante ESTRUCTURAL que pidió la misión: barrido de AST sobre **todo** `app/**` buscando `delivery_fee`/`delivery_fee_amount`/`delivery_fee_total`/`delivery_charge` como anotación, asignación, clave de dict o atributo. Cero. (`is_delivery_fee`, la bandera del producto de la carta, es la excepción declarada por nombre exacto) |
| `::test_the_delivery_fee_line_never_carries_a_hand_written_tax_rate` | Invariante heredado (b): `_build_delivery_fee_item` llama `app.core.tax.rate_for_code` y no contiene **ningún** literal numérico distinto de 0/1 en su cuerpo |

---

### 🔴 #4 — El efectivo de domicilios se arquea aparte

**VERDE en los cuatro caminos que el renglón nombra; el hallazgo H-1 vive en
el monto que entra al liquidar.**

| Test | Qué prueba |
|---|---|
| `::test_delivery_cash_stays_out_of_the_expected_until_the_courier_settles` | El esperado no se mueve al cobrar; `compute_breakdown` publica `delivery_cash_pending = 100.000` con `cash_sales = 0`; y el renglón viaja hasta el **paso 2 del cierre a ciegas** (`GET /shifts/{id}/close/{count}/review`), donde la ecuación sigue cerrando **sin** ese término y la diferencia es 0 |
| `::test_settling_delivery_cash_writes_a_typed_income_in_the_open_shift` | La liquidación escribe **UN** `CashMovement(kind=INCOME, cause=DELIVERY_SETTLEMENT)` — causa **tipada** (enum), nunca `OTHER_INCOME` reciclada — y recién ahí sube el esperado |
| `::test_voiding_a_settlement_writes_the_mirror_and_leaves_the_original_alive` | **El deshacer, que es donde 2b fabricaba un sobrante (H-1 de 2b).** El espejo tiene `kind` opuesto y la **MISMA** causa tipada; el `CashMovement` original **queda vivo**; el esperado vuelve exactamente al valor previo a liquidar |
| `::test_voiding_a_settlement_without_an_open_shift_rejects_the_whole_thing` | Sin turno abierto: `409 NO_OPEN_SHIFT` y la anulación se rechaza **entera** — se relee la fila y se exige `status=SETTLED`, `voided_at is None`, `void_cash_movement_id is None`. No queda nada a medias |
| `::test_the_pending_delivery_cash_is_never_called_a_debt_of_the_employee` | Regla dura del proyecto (CST art. 149): el contrato de `GET /delivery-settlements/pending` no contiene `debt`/`deuda`/`owes`/`debe`/`descuento` en ninguna clave ni texto, a ninguna profundidad |

---

### ✅ #5 — Cancelar una venta de plataforma después de preparar no genera merma

**VERDE**, verificado **en el LIBRO**, no sólo en el reporte.

| Test | Qué prueba |
|---|---|
| `::test_cancelling_a_platform_sale_after_preparing_creates_no_waste_in_the_ledger` | Con receta real y consumo teórico real al enviar: después de cancelar, el LIBRO (`StockMovement`) **no gana ni una fila**, `MovementCause.WASTE` no aparece, `wastes` queda vacía y el stock queda **exactamente** en el valor posterior al envío. El insumo se descontó y se queda descontado |
| `::test_cancelling_a_platform_sale_compensates_the_sale_and_the_commission` | Lo que SÍ se compensa: la cuenta por cobrar pasa a `reversed` (no se borra, y su `amount` no se reescribe) y la comisión recibe su asiento `REVERSAL` con el porcentaje **congelado** del asiento original |
| `::test_the_waste_report_does_not_include_a_cancelled_platform_sale` | La lectura que mira el dueño: `GET /admin/waste` no la incluye |

**Verificado además, y no era obvio**: cancelar **dos veces** no emite una
segunda nota fiscal ni un segundo asiento de reversión — el documento original
queda `reversed` y el segundo intento no encuentra nada `issued`. Lo probé
corriendo, no razonando.

---

### ✅ #6 — El precio por canal cae al de mesa, y un `0` fijado se respeta

**VERDE**, en los tres canales y en las dos direcciones.

| Test | Qué prueba |
|---|---|
| `test_channels_invariants.py::test_a_product_without_a_channel_price_is_sold_at_the_dine_in_price` (3 casos) | `takeout`, `delivery` y `platform` sin precio propio → la línea se congela al precio de mesa. Nunca 0, nunca `null`, y lo decide el servidor |
| `::test_a_channel_price_set_to_zero_is_respected_and_does_not_fall_back` (3 casos) | **El caso que separa `null` de `0`**: un precio de canal fijado en 0 se respeta como 0 en los tres canales. Si cayera al de mesa, el backend estaría leyendo `0` como «no hay dato» |
| `::test_the_catalog_of_the_device_never_serves_a_null_channel_price` | Del lado del contrato: `GET /catalog` resuelve los cuatro precios en el SERVIDOR; ninguno sale `null` |
| `frontend/src/audit/channels-kds.test.ts` → «el cliente no resuelve el precio de canal» | Y el cliente no repite la regla: ningún `prices.delivery ?? …` ni `||` en `features/orders`/`features/payments` |

---

### ✅ #7 — La comisión se registra y no se resta

**VERDE**, con la cuenta hecha y con el barrido que impide una segunda
matemática.

| Test | Qué prueba |
|---|---|
| `::test_the_commission_is_recorded_per_order_and_platform_and_never_subtracted` | Venta de $100.000 al 18 %: el pago, el documento fiscal y `PlatformReceivable.amount` dicen **100.000**; `PlatformCommission.amount` dice **18.000** con `commission_bp = 1.800` congelado, ligado a ese `order_id` y a esa `platform_id`, con el `external_id` viajando a la cuenta por cobrar. **El 82.000 no existe en ningún lado** (se verifica explícitamente) |
| `::test_only_one_place_in_the_backend_multiplies_by_commission_bp` | Barrido de AST sobre todo `app/**`: `commission_bp` sólo aparece dentro de una operación aritmética en `app/channels/service.py`. Una escala escrita dos veces es un rojo esperando (B-2 de 2a, H-7 de 2b) |
| `::test_the_device_never_sees_the_commission` | Ni `GET /device/platforms` ni la comanda del dispositivo traen `commission_bp`/`commission`/`platform_commission_bp`, a ninguna profundidad |

---

### ✅ #8 — Los tres canales dejan el inventario idéntico

**VERDE.** `::test_selling_by_table_delivery_and_platform_leaves_the_inventory_identical`:
mismo producto, misma cantidad (2), tres canales con **tres precios distintos**
(mesa 100.000, domicilio 120.000, plataforma 140.000), receta real. El consumo
de insumo es **el mismo número** en los tres, y se exige que sea `> 0` para que
el test no pase por no descontar nada. Hermano del test de 2a que compara
venta, cortesía y `staff_meal`.

---

### ✅ #9 — «Marchar» sella `fired_at` por curso y el KDS lo respeta en el orden

**VERDE**, incluida la parte que importa de verdad (el orden).

| Test | Qué prueba |
|---|---|
| `test_kitchen_invariants.py::test_firing_a_course_seals_fired_at_for_that_course_only` | Marchar `main` no sella `starter`: una sola fila en `order_course_fires` |
| `::test_firing_the_same_course_twice_does_not_move_the_first_fired_at` | Con el reloj adelantado entre las dos llamadas, el sello **no se mueve** |
| `::test_the_kds_orders_the_queue_by_fired_at_and_never_puts_an_unfired_course_first` | El KDS reordena: `starter` se envió primero (id menor) y, al marchar `main`, el fuerte **pasa al frente**. Un curso marchado nunca queda detrás de uno sin marchar, y el que no se marchó sigue con `course_fired_at: null`. Sin este test, «marchar» sería un sello decorativo |

---

### ✅ #10 — «Bump» por ítem es idempotente

**VERDE**, probado en serio: las dos formas de repetición, el deshacer, la
comanda completa y la auditoría.

| Test | Qué prueba |
|---|---|
| `::test_bumping_twice_with_two_different_keys_is_a_no_op_the_second_time` | Dos `Idempotency-Key` DISTINTAS (el caso real de dos toques): el segundo es `200` con `changed: false`, **el mismo `ready_at`** y la atribución del primero intacta |
| `::test_bumping_twice_with_the_same_key_replays_the_stored_response` | La MISMA clave (un reintento de red): devuelve **exactamente** la misma respuesta, no una segunda ejecución |
| `::test_unbumping_reverses_the_bump_and_is_also_idempotent` | El deshacer: `ready → sent` y repetirlo es un no-op, no un error |
| `::test_expediting_twice_bumps_everything_once_and_the_second_time_changes_nothing` | Para la comanda completa: `changed_item_ids` con los dos ítems la primera vez, `[]` la segunda |
| `::test_a_bump_that_changed_nothing_writes_no_audit_row` | **El corolario en la AUDITORÍA**: un bump idempotente no escribe una fila de `kitchen_bump_events`. Si la escribiera, el reporte de «quién bumpeó» contaría dos veces el mismo plato por un doble toque |
| `::test_bumping_an_item_of_another_store_is_404_and_never_500` | Un id ajeno es `404`, nunca `403` ni `500` |

**No cubierto: la concurrencia real.** Dos requests simultáneas con la misma
clave dan `409 IDEMPOTENCY_IN_PROGRESS` **por diseño declarado**, pero este
entorno corre SQLite en un proceso: no hay forma honesta de probar la carrera.
Declarado en §5.

---

### ✅ #11 — Sesión de dispositivo: ninguna respuesta del KDS trae costo

**VERDE**, y **el barrido del OpenAPI no alcanzaba**: lo demuestro.

| Test | Qué prueba |
|---|---|
| `::test_no_kds_response_body_ever_contains_a_cost_or_margin_key` | **En RUNTIME y anidado**, con una receta cargada para que el ítem TENGA costo congelado del otro lado: se recorren los cuerpos reales de `GET /kitchen/rounds`, `GET`/`POST /kitchen/print-jobs`, `bump`, `unbump` y `expedite`, y ninguna clave contiene `cost` ni `margin`, ni los cinco nombres exactos de la misión |
| `::test_the_kds_never_exposes_the_delivery_address_or_the_platform_commission` | Mínimo privilegio sobre la superficie nueva: el KDS no filtra dirección ni teléfono del cliente de domicilio ni la comisión, **y sí** distingue un pedido de plataforma (`platform.external_id`) |
| `::test_the_inherited_openapi_cost_sweep_actually_sees_the_new_2c_routes` | **Invariante heredado (c), re-apuntado.** Las 10 rutas nuevas de dispositivo caen DENTRO de `device_reachable_paths()` y ninguna en `admin_only_paths()`; las 5 de admin caen FUERA. El recorte sigue siendo **por sesión** (`current_admin` en el árbol de dependencias), no por texto del path |
| `::test_the_openapi_cost_sweep_is_blind_to_the_kds_because_it_declares_no_response_model` | **El hueco, fijado por escrito.** `GET /kitchen/rounds` devuelve `list[dict[str, Any]]` y bump/unbump/expedite devuelven `JSONResponse`: el barrido de propiedades del OpenAPI **no ve ni una propiedad** del cuerpo de esas cuatro rutas y **pasa en vacío sobre ellas**. El test exige que sigan sin esquema; el día que lo declaren, se pone rojo y se borra — es la señal de que el hueco se cerró |
| `frontend/.../channels-kds.test.ts` → «el contrato del KDS, que ningún typecheck puede vigilar» (3 tests) | Consecuencia del mismo hueco del otro lado: como el backend no publica esquema, el cliente lo tipó a mano. El invariante compara las CLAVES literales que arma `app/kitchen/router.py`/`service.py` contra los campos de `api/kitchen.ts::KitchenRoundOut`/`KitchenRoundItemOut`, en las dos direcciones |

Corrido sobre la app real: **66 rutas de dispositivo, 104 de admin, 0
filtraciones de `cost`/`margin`**.

---

### ✅ #12 — Zona horaria: un pedido de plataforma a las 00:30 queda con el día del turno

**VERDE**, y escrito como pide la advertencia cara de 2b.

`::test_a_platform_order_loaded_at_00_30_is_sealed_with_the_business_day_of_the_shift`:
turno abierto a las 20:00 de Bogotá, pedido cargado y cobrado a las **00:30**
de Bogotá (05:30 UTC), antes del corte de las 06:00. La comanda, la cuenta por
cobrar **y** el asiento de comisión quedan los tres con el día del turno.

**La fecha esperada se deriva como la deriva el SERVIDOR**
(`app.core.tz.today_business_date(store.cutoff_hour)`), **jamás** de
`clock.now_utc().date()`. En 2b (R-2) un test que hizo eso era rojo de 00:00 a
10:59 UTC todas las noches y nadie lo vio porque los agentes corrieron en la
ventana verde. Este test fija el reloj con la fixture `clock`, así que **no
depende de la hora a la que se corra**.

---

### ✅ #13 — Sin `float` en comisiones ni en precios por canal

**VERDE**, por las tres puertas: base, esquema y JSON.

| Test | Qué prueba |
|---|---|
| `::test_no_money_or_percentage_column_of_the_new_domains_is_a_float` | Leído del **MODELO**, no de una lista a mano: ninguna columna de las cuatro tablas de `channels`, ni los cuatro precios de `products`, ni `orders.platform_commission_bp` es `Float`/`Numeric`. Una columna que agregue fase 3 cae sola |
| `::test_no_schema_of_the_new_domains_declares_a_float_field` | Recorre los modelos Pydantic de `app.channels.schemas`, `app.orders.schemas` y `app.payments.schemas` |
| `::test_no_float_ever_travels_in_the_json_of_the_new_routes` | **La única puerta que ve un `float` construido a mano dentro de un `dict[str, Any]` sin `response_model`**: se recorre recursivamente el JSON real de 7 rutas nuevas y ningún valor numérico es `float` |

**Excepción heredada, declarada y no tapada**: `suggested_pct` (la propina
sugerida de 1b) es `float` en `app.orders.schemas.TipInfoOut` y en
`app.payments.schemas.DocumentTipOut`. **No es de 2c**, no es comisión ni
precio por canal. El invariante la enumera **por nombre exacto** para que un
`float` NUEVO no se cuele detrás de ella. Queda como deuda heredada en §6.

---

### 🟡 #14 — POS y KDS en 375 px y 1024 px, foco visible

**PARCIAL, y lo declaro sin maquillaje.**

Lo que **sí** cubrí con tests de fuente en `frontend/src/audit/channels-kds.test.ts`
(bloque «375 px y 1024 px: la parte del renglón #14 que un test de fuente sí
puede cobrar»):

- `ninguna pantalla nueva fija un ancho mayor al viewport de 375 px` — barre
  `min-w-[…px]`/`w-[…px]` sobre `features/kitchen/**`,
  `DeliverySettlementPanel.tsx`, `ChannelsSection.tsx`, `NewOrderPage.tsx` y
  `OrderPage.tsx`. El único ancho fijo es `min-w-[104px]`
  (`KdsPage.tsx:86`), que cabe.
- `ninguna pantalla nueva apaga el foco visible sin reemplazarlo` — ningún
  `outline-none` sin su `focus-visible:`.
- `toda tabla de las pantallas nuevas vive dentro de un contenedor que se desliza`
  — las tres tablas nuevas están en `overflow-x-auto`, así que no empujan el
  documento.

Lo que **NO** cubrí, y ningún test de este entorno puede cubrir:

- Que a 375 px y a 1024 px **no haya scroll horizontal de documento**. Depende
  del layout calculado (anchos intrínsecos, `flex` que no encoge, texto largo
  sin `truncate`), y **jsdom no calcula layout**: no tiene motor de cajas.
- Que el **contraste** sea AA (4.5:1) en claro y en oscuro.
- Que el **orden de tabulación** sea correcto y que el anillo de foco **se vea**
  (existir ≠ verse).

Es el mismo hueco abierto desde 1a (`docs/ESTADO.md` punto 21). **Decirlo es
mejor que fingir que esos tres tests lo cierran.**

---

### ⬜ #15 — La entrega

No me corresponde: la corre el Maestro.

---

## 2. Hallazgos, por severidad

> Un hallazgo que no se puede reproducir no es un hallazgo. **Los seis van con
> su test, con archivo y línea, y los seis están rojos hoy.**

---

### 🔴 H-1 — BLOQUEANTE. La propina en efectivo de un domicilio entra al esperado; la de cualquier otra venta, no

**Test:** `backend/tests/audit/test_channels_money_invariants.py::test_the_same_cash_moves_the_expected_by_the_same_amount_whatever_channel_it_came_through`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_money_invariants.py -k same_cash_moves -q`
**Agente responsable:** `backend-dinero-canales`
**Archivos:** `backend/app/channels/service.py:484-487`, `backend/app/shifts/hooks.py:157-168`

**Medido corriendo, con los números impresos:**

```
[MOSTRADOR]  venta 100.000 + propina 10.000 en efectivo -> esperado 200.000 -> 300.000  (delta 100.000)
[DOMICILIO]  cobro (100.000 + propina 10.000) en efectivo -> esperado 300.000 -> 300.000  (delta 0)
[LIQUIDACIÓN] amount 100.000 + tip 10.000                -> esperado 300.000 -> 410.000  (delta 110.000)
```

**Qué pasa.** `get_sales_totals` (`app/shifts/hooks.py:166-168`) suma
`Payment.amount` a `.cash` y `Payment.tip_amount` a `.tips_cash` —**la propina
en efectivo nunca entra al esperado por ningún camino de 1b**; se salda al
cierre con `tips_cash_out` (`app/shifts/service.py:1035`). Pero
`settle_delivery_cash` calcula `total = amount + tip_amount`
(`app/channels/service.py:484-486`) y manda **ese total** a
`register_delivery_settlement_income`, que lo escribe como `INCOME` y por lo
tanto lo suma a `expected` vía `incomes`.

**Son dos matemáticas del esperado para la misma plata.** El mismo billete de
propina mueve el esperado según por qué canal entró.

**Por qué es plata y no cosmética.** La consecuencia cae entera en el conteo a
ciegas: la diferencia del arqueo cambia exactamente en el valor de las propinas
de domicilio del turno, y quien acaba de contar tiene que **justificar con
causa tipada** una diferencia que no existe — que es precisamente el defecto
que el cierre a ciegas de este proyecto existe para no tener (el «sobrante
fabricado» de H-1 de 2b, en otra forma).

**El entregable de `backend-dinero-canales` §7.7 declara la mitad del asunto
y razona al revés**: dice *«El efectivo entra completo (venta + propina) por el
`INCOME` de la liquidación, así que el esperado es exacto»*. Es exacto sólo si
el esperado incluyera la propina en los demás caminos, y **no la incluye**. Lo
verifiqué contra el código y contra el sistema corriendo, no contra el informe.

**Remedio (una decisión, después una línea).** La liquidación tiene que mover
el esperado por el **mismo término** que mueve una venta en efectivo. Las dos
salidas coherentes son:

1. El `INCOME` de la liquidación es **sólo `amount`**, y la propina de domicilio
   se salda como cualquier otra propina en efectivo (por `tips_cash`). Es la
   que menos toca: una línea en `app/channels/service.py:486`, más sumar
   `tips_delivery` a `tips_cash` en `get_sales_totals` cuando la liquidación
   ocurrió.
2. `get_sales_totals` empieza a sumar `tip_amount` a `.cash` en **todos** los
   caminos. Cambia el significado de `expected` para todo el producto y arrastra
   `tips_cash_out` y `to_deposit`: es una decisión del dueño de la spec, no del
   pedido.

Lo que no puede quedar es una sí y la otra no.

---

### 🔴 H-2 — BLOQUEANTE. `GET /shifts/{id}/tips` cuenta la misma propina en efectivo dos veces, con dos fórmulas, en el mismo cuerpo

**Test:** `backend/tests/audit/test_channels_money_invariants.py::test_the_shift_tips_reading_counts_the_same_cash_tip_once`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_money_invariants.py -k tips_reading -q`
**Agente responsable:** `backend-dinero-canales`
**Archivos:** `backend/app/shifts/hooks.py:157-164`, `backend/app/shifts/tips.py:42-46` y `:49-78`

**Cuerpo real de la respuesta, con una propina de mostrador de $10.000 y una de
domicilio de $10.000:**

```json
{"by_method":{"cash":10000,...},
 "by_employee":[{"employee_name":"Cashier","cash":20000,...}],
 "cash_out":10000,"electronic_liability":0}
```

**Qué pasa.** `by_method.cash` y `cash_out` salen de
`get_sales_totals().tips_cash`, que desde 2c **excluye** la propina de un cobro
con domiciliario (`hooks.py:157-164` desvía el pago entero a
`delivery_cash`/`tips_delivery` y hace `continue`). `by_employee[*].cash` se
calcula **aparte**, en `app/shifts/tips.py:49-78`, releyendo `Payment` y
clasificando por `method` **sin esa exclusión**: ahí la propina de domicilio sí
cuenta.

El mismo cuerpo dice que las propinas en efectivo del turno son 10.000 y
también 20.000.

**Por qué es plata.** Es propina de un empleado — pasivo con el personal, Ley
1935 de 2018. El reparto por persona ofrece $20.000 y `cash_out` autoriza a
sacar $10.000 del cajón: o se le paga de menos a alguien, o se saca del cajón
plata que el cierre no contempla. Y es **H-4 de 2b en su forma exacta** —la
misma pregunta respondida dos veces, con dos fórmulas— ahora dentro de una sola
respuesta.

**Remedio.** Una sola función que clasifique un `Payment` en su bolsillo, usada
por los dos caminos; o publicar el renglón de domicilio también por empleado
(`tips_delivery` por persona), para que las dos vistas sumen lo mismo. **No se
cierra ablandando el test**: el invariante exige igualdad, que es lo que un
lector de esa pantalla asume sin pensarlo.

---

### 🟡 H-3 — ADVERTENCIA. «Canales activos» de la sede no gatea los dos canales nuevos

**Test:** `backend/tests/audit/test_channels_invariants.py::test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_invariants.py -k active_channels -q`
**Agente responsable:** `backend-canales-comanda` (y una pregunta para el dueño de la spec)
**Archivo:** `backend/app/orders/service.py:673-680`

`create_order` compara el canal contra `store.active_channels` **sólo** para
`counter`, `dine_in` y `takeout`. Una sede cuyo `active_channels` es
`["counter","dine_in","takeout"]` —el default del alta— acepta comandas de
`delivery` y de `platform` en cuanto alguien enciende la flag. Verificado
corriendo: los dos devuelven `201`.

§9.3 lista «canales activos» en **Configuración**, distinto de la función
habilitable de §1.2. Hoy el código dice dos cosas distintas sobre la misma
lista, y el administrador no puede apagar un canal sin apagar la función.

**Este hallazgo tiene una mitad ya escrita del otro lado**, y por eso vale
doble: `frontend/src/features/settings/ChannelsSection.tsx:217-227` documenta
exactamente la misma observación y decide, coherentemente, **no** ofrecer una
casilla para domicilio/plataforma *«porque sería un control que no controla
nada y mentiría sobre qué apaga el canal»*. Los dos lados ya divergieron por
escrito: hace falta una decisión, no un parche.

**Remedio**: extender la guarda a `DELIVERY`/`PLATFORM`, **o** declarar en la
spec que `active_channels` no gatea los canales nuevos y dejar el comentario
del cliente como la única verdad.

---

### 🟡 H-4 — ADVERTENCIA (cero mudo). Una comanda de domicilio puede publicar el domiciliario `id: 0`

**Test:** `backend/tests/audit/test_channels_invariants.py::test_a_delivery_order_never_publishes_a_courier_with_id_zero`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_invariants.py -k courier_with_id_zero -q`
**Agente responsable:** `backend-canales-comanda`
**Archivo:** `backend/app/orders/service.py:457`

```python
courier=EmployeeRef(id=order.courier_employee_id or 0, name=order.courier_employee_name or ""),
```

`orders.courier_employee_id` es **nullable** en `0013_channels_orders` y
`create_order` sólo la exige en el alta. Cualquier comanda de domicilio que
llegue con la columna en `NULL` se publica con **`courier: {"id": 0, "name": ""}`**:
un empleado inexistente presentado como dato real. Verificado corriendo — la
respuesta sale exactamente así.

No es hipotético: el propio constructor **declaró como gap** que no existe
endpoint para reasignar el domiciliario después de creada la comanda
(`outputs/backend-canales-comanda.md §7.2`), y ése es justamente el endpoint
que dejaría la columna en `NULL` de forma legítima.

`AGENTS.md`: **«`null` no es 0»**. Lo correcto es
`DeliveryOut.courier: EmployeeRef | None` (o no serializar el bloque), nunca un
id 0. **Remedio**: dos líneas, `app/orders/schemas.py` + `app/orders/service.py:457`.

---

### 🟡 H-5 — ADVERTENCIA. La plataforma de un cobro se resuelve con `or`, que trata el `0` como ausencia

**Test:** `backend/tests/audit/test_channels_invariants.py::test_the_platform_of_a_payment_is_resolved_with_is_not_none_and_never_with_or`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_invariants.py -k is_not_none -q`
**Agente responsable:** `backend-dinero-canales`
**Archivo:** `backend/app/payments/service.py:421`

```python
candidate = getattr(order, "platform_id", None) or getattr(payload, "platform_id", None)
```

No rompe hoy (los ids nacen en 1), pero es **literalmente** el patrón que la
regla dura prohíbe, en el lugar donde se decide **qué plataforma cobró una
venta** — y es el mismo que produjo B-2 en 2a. Lo correcto:
`candidato = a if a is not None else b`. **Una línea.**

---

### 🟡 H-6 — ADVERTENCIA. El invariante más caro del pedido se defiende con un `assert` pelado

**Test:** `backend/tests/audit/test_channels_invariants.py::test_no_business_invariant_of_2c_is_defended_with_a_bare_assert`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_invariants.py -k bare_assert -q`
**Agente responsable:** `backend-dinero-canales`
**Archivo:** `backend/app/channels/service.py:736`

```python
assert not returned_ids, (
    "una cancelación de plataforma revirtió consumo de inventario: ..."
)
```

El invariante es **bueno** —es exactamente el renglón #5 del checklist cobrado
en el momento—; el mecanismo, no:

- Un `assert` **desaparece con `python -O`**, que es como se corre un proceso
  de producción afinado. El guardrail se evapora justo donde hace falta.
- Si se cumple, sale como `AssertionError` → `500`, no como la forma
  `{error:{code,message}}` del proyecto.

**Remedio**: `AppError` tipado (o revertir la transacción con un error
nombrado). El `assert` es el único de los dos dominios nuevos; el barrido
cubre `app/channels/**` y `app/kitchen/**` para que no vuelva.

---

## 3. Los siete contratos cruzados, auditados en los dos sentidos

La lección de 2b, con número: los cinco hallazgos de cruce de aquella ronda
fueron, los cinco, «la mitad de ida construida sin la mitad de vuelta».
`tests/audit/test_contract_2c_invariants.py` (19 tests) y
`frontend/src/audit/channels-kds.test.ts` cobran los siete.

| Contrato | Estado | Cómo lo verifiqué |
|---|---|---|
| **C1** `app/orders/hooks.py` (bump/unbump/expedite/fired_at) entre `orders` y `kitchen` | ✅ | Las cuatro firmas con **los nombres de parámetro exactos** (`inspect.signature`), `app/kitchen/**` sin un solo import directo de `app.orders.hooks`, y el KDS **no escribe** `OrderItem.status`/`ready_at`/`sent_at`/`served_at` a mano (AST) |
| **C2** `app/channels/hooks.py::get_platform` entre `channels` y `orders` | ✅ | Firma publicada; **`None` en los TRES casos** probado con filas reales (no existe / otra sede / inactiva) y sin levantar; `app/orders/**` sin un import directo de `app.channels` |
| **C4** `mark_platform_order_cancelled` entre `orders` y `channels` | ✅ | Firma publicada + `app/channels/**` sin import directo + `app/channels/service.py` sin importar `app.orders.service` |
| **C4-bis** `seed_channels` llamado desde `app/seed.py` | ✅ | Firma publicada, el llamado presente, **y el seed corrido de verdad**: deja plataforma con comisión > 0, comanda de domicilio con los tres datos y **el cargo como línea**, y comanda de plataforma con `external_id` y `platform_commission_bp` congelado |
| **C5** `"channels"` **y** `"kitchen"` en `MODEL_MODULES` | ✅ | **Es el que decide si todo lo demás es humo.** Los dos están (`app/core/models_registry.py:54-55`), y —lo que de verdad importa— `kitchen_bump_events` y `kitchen_print_jobs` **llegan a `Base.metadata`** después de `import_all_models()`. No alcanza con que el registro tenga la clave |
| **C6** cadena Alembic `0013→0014→0015` | ✅ | Los tres `down_revision` leídos del AST y encadenados; `0001 → 0015` corrido desde cero deja **79 tablas**; `0 Duplicate Operation ID` sobre la app real; y ningún `conftest` que monte un router lo hace sin mirar `DOMAINS` (la regresión R-1 de 2b, como invariante y no como sorpresa) |
| **C7** `src/api/channels.ts` entre los dos agentes de frontend | ✅ | Existe, exporta `listDevicePlatforms`/`DevicePlatformOut`, `DevicePlatformOut` **no declara comisión**, y las rutas que llama existen en `app/channels/router.py`. **Ojo**: cuando empecé a auditar este archivo **no existía** y `NewOrderPage.tsx` no se podía transformar; `frontend-kds-config` lo publicó mientras yo escribía. El invariante queda escrito para que el próximo pedido lo cobre solo |
| **C8** `src/app/router.tsx` con dueño único | ✅ | `kitchenFeature.posRoutes` montado, ruta `kds` presente, y `features/kitchen/**` con pantalla real |

**Verificado además, en los dos sentidos y sin nombrar ningún valor a mano**
(el patrón que en 2b cazó H-11 en su primera corrida):

- estados de comanda: `OrderStatusLiteral` ↔ `api/orders.ts::OrderStatus` ↔
  `ORDER_STATUS_LABEL` — incluye `compensated`, con etiqueta propia («Venta
  compensada», **no** «Anulada»: confundirlas falsearía el reporte de
  anulaciones);
- canales: `Channel` ↔ `OrderChannel` ↔ `CHANNEL_LABEL`;
- causas de caja: `CashMovementCauseLiteral` ↔ `CASH_MOVEMENT_CAUSES`, con
  `delivery_settlement` etiquetada;
- causas **sólo-sistema**: `_SYSTEM_ONLY_MOVEMENT_CAUSES` ↔
  `SYSTEM_ONLY_MOVEMENT_CAUSES`, **y** que el desplegable de movimiento manual
  no recorra `Object.entries(CAUSE_LABEL)` entero (ofrecer una causa que el
  servidor rechaza siempre es el bug de R-4 de 2b);
- claves del KDS: las que arma el backend ↔ las que declara `api/kitchen.ts`.

---

## 4. Invariantes heredados que re-apunté — el antes, el después y lo que dejó de estar cubierto

**Uno solo, y se MOVIÓ, no se aflojó.**

### `tests/audit/test_migration_invariants.py::test_the_chain_reaches_the_three_migrations_of_cost_and_inventory`

| | |
|---|---|
| **Qué decía** | `assert version == "0012"` · `assert len(tablas) == 72` · conjunto enumerado con las tablas de 2a y 2b |
| **Qué dice ahora** | `assert version == "0015"` · `assert len(tablas) == 79` · el mismo conjunto **más** los siete nombres nuevos: `order_course_fires` (0013), `delivery_platforms`, `delivery_settlements`, `platform_receivables`, `platform_commissions` (0014), `kitchen_bump_events`, `kitchen_print_jobs` (0015) |
| **Por qué** | La spec de 2c dice «Alembic arranca en `0013`» y la cadena llega a `0015`. El propio docstring del test dice que hay que moverlo en cada pedido que agregue una migración: «no es acotar un invariante, es moverle el poste al que está atado» |
| **Qué dejó de estar cubierto** | **Nada.** Sigue siendo una **igualdad exacta** (`==`), no «que contenga al menos», y el conjunto enumerado **creció** con los siete nombres. Una tabla de más o de menos sigue siendo roja |
| **Medido, no estimado** | Corrí `alembic upgrade head` contra una base SQLite propia bajo `TMPDIR=/tmp/pt-auditor-canales-2c`: `0001 → 0015`, 79 tablas de dominio |

Y le puse **un segundo candado desde otro archivo**:
`test_contract_2c_invariants.py::test_the_migration_chain_pin_was_moved_to_the_head_of_2c`
lee el texto del test heredado y exige `"0015"`, `79` y **que no aparezca un
`>=` dentro de esa función**. Si alguien «arregla» el heredado aflojándolo a una
desigualdad, este otro se pone rojo.

### Los cuatro invariantes heredados que 2c toca por diseño

| Invariante | Qué hice | Resultado |
|---|---|---|
| **(a) El esperado de caja** (`app/shifts/**`, **tercer pedido seguido** como territorio cruzado) | No lo re-apunté: lo **cobré más fuerte**. Al test literal del renglón #2 le agregué el camino entero (`get_sales_totals`, `_OTHER_METHODS`), el **arqueo del cierre a ciegas**, el invariante de AST sobre la fórmula, el ciclo completo de la liquidación y su deshacer | **Ahí cayeron H-1 y H-2.** Ningún invariante heredado del esperado se aflojó ni se movió |
| **(b) La matemática del impuesto** (`app/core/tax.py`) | Test numérico de la base gravable del cargo + invariante de AST: `_build_delivery_fee_item` resuelve con `rate_for_code` y no tiene ningún literal de tasa | **Intacto.** `app/core/tax.py` no se tocó en 2c |
| **(c) «El operador no ve costos»**, con el KDS como superficie nueva | Verifiqué que el barrido **por sesión** de 2b **ve** las 10 rutas nuevas de dispositivo, y **encontré que sobre el KDS pasaba en vacío** (sin `response_model` no hay propiedades que barrer). Lo cerré con un test de **runtime** y dejé el hueco fijado por escrito | **Reforzado.** El barrido heredado no cambió ni una línea; se le sumó cobertura donde era ciego |
| **(d) El consumo de inventario de 2a** | El test hermano del de 2a (venta/cortesía/`staff_meal`) para los tres canales, más la verificación **en el LIBRO** de que la cancelación de plataforma no escribe merma ni repone | **Intacto.** Ningún test heredado de 2a prohibía lo que 2c construyó |

**Ningún invariante heredado se esquivó deformando un contrato publicado** —que
es lo que pasó en 2a y costó una ronda—. El único que se movió es el poste de
la cadena de migraciones, con el antes, el después y el «nada dejó de estar
cubierto» escritos arriba.

---

## 5. Lo que NO pude cubrir, declarado sin maquillaje

1. **Navegador real (checklist #14, parte).** Scroll horizontal de documento a
   375/1024 px, contraste AA en claro y oscuro, orden de tabulación y anillo de
   foco *visible*. jsdom no calcula layout. **Hueco abierto desde 1a.** Lo que
   sí cubrí está en #14; lo que no, está ahí arriba con nombre.
2. **Concurrencia real.** Dos bumps simultáneos con la misma `Idempotency-Key`,
   dos liquidaciones del mismo domiciliario a la vez, `SELECT FOR UPDATE`, el
   índice único parcial de `delivery_platforms`, los `409` de carrera. Todo
   corrió en **SQLite, en un proceso**. La idempotencia está probada por
   repetición secuencial (las dos formas), no por carrera.
3. **Postgres.** Igual que 2b: enums nativos, índices parciales reales y el
   comportamiento del DDL bajo el motor de producción. La cadena de Alembic sí
   la corrí entera, en los dos sentidos.
4. **El recorrido de punta a punta del flujo nuevo con la base sembrada.**
   Verifiqué que el seed deja el camino visible (corriéndolo), pero no navegué
   el POS → KDS → cobro → liquidación con un navegador.
5. **La conciliación de la cuenta por cobrar** (`PlatformReceivable` sólo toma
   `pending`/`reversed`) es fase 3 por diseño declarado: no la audité como si
   existiera.
6. **La suite completa.** Corrí **sólo `tests/audit` y `src/audit`** más los dos
   typechecks, como manda la regla de verificación. La suite entera la corre el
   Maestro; en 2b ahí aparecieron tres de los cinco rojos, y por eso escribí el
   invariante de `Duplicate Operation ID` sobre la app real y el del guard de
   `DOMAINS` en los conftests — los dos verdes hoy.

---

## 6. Observaciones que no son hallazgos, pero que alguien tiene que leer

- **O-1 — `suggested_pct` sigue siendo `float`** en
  `app.orders.schemas.TipInfoOut` y `app.payments.schemas.DocumentTipOut`
  (heredado de 1b, no de 2c). Mi invariante de `float` lo enumera **por nombre
  exacto** para que un `float` nuevo no se cuele detrás. Es porcentaje de plata
  en un contrato publicado: vale cerrarlo cuando alguien toque propinas.
- **O-2 — la comisión está atada al MEDIO de pago, no al CANAL.** Una comanda
  de canal `platform` cobrada en **efectivo** no registra cuenta por cobrar ni
  comisión (`app/payments/service.py:712`: `if channels.platform_id is not None`,
  y `platform_id` sólo se resuelve cuando algún split usa el medio `platform`).
  Es coherente con la letra de la spec, y en la operación real un pedido de
  plataforma pagado contra entrega **igual** paga comisión. **Pregunta para el
  dueño de la spec**, no defecto.
- **O-3 — `supplier_payment` sigue pudiéndose teclear a mano** como movimiento
  de caja. `backend-dinero-canales` cerró ese agujero para
  `delivery_settlement` (`_SYSTEM_ONLY_MOVEMENT_CAUSES`,
  `app/shifts/service.py:658`) y **no lo tocó para la causa de 2b**, con buen
  criterio (no es su pedido). Verificado: sigue abierto. Una línea.
- **O-4 — la escala de puntos básicos de ENTRADA vive en dos archivos**:
  `features/settings/InventorySection.tsx:33` (2b) y
  `features/settings/ChannelsSection.tsx:41` (2c), los dos con
  `Math.round(value * 100)`. El entregable de `frontend-kds-config` §4 afirma
  que no escribió `bp * 100` suelto; el código dice otra cosa. **No lo llamo
  hallazgo** porque el fundamento es el mismo que se aceptó para
  `COUNT_QTY_SCALE` en 2b (conversión de formato de un campo de entrada que el
  servidor revalida), pero **le escribí el precio**: tres tests en
  `frontend/src/audit/channels-kds.test.ts` que exigen que la excepción viva
  sólo en esos dos archivos, que la salida pase siempre por
  `formatBasisPoints`, y que lo que se manda sea el entero. Si alguno cae, la
  excepción deja de ser legítima.
- **O-5 — `GET /kitchen/rounds` hace una consulta de `fired_at_by_course` por
  ronda.** Es un N+1 en la pantalla que más se sondea del producto (cada 5 s).
  No es correctitud; es la primera cosa que va a doler en una cocina con 30
  comandas abiertas.
- **O-6 — `BreakdownOut.delivery_cash_pending: int = 0`** tiene default 0
  (`app/shifts/schemas.py:178`). Hoy `review_close` siempre lo provee, así que
  el default nunca se usa — pero es un cero mudo esperando a que alguien arme un
  `BreakdownOut` sin ese campo. `ShiftCurrentOut`/`ShiftSummaryOut` lo hacen
  bien (`int | None`, gateado por `_can_see_expected`).
- **No auditado por ausencia de consumidor**: `GET /admin/platforms/{id}/summary`,
  `GET /admin/platform-commissions` y `GET /admin/platform-receivables` no los
  consume ninguna pantalla (declarado por `frontend-kds-config` §3). Sus
  contratos existen y responden `200`; nadie los mira. No es defecto de 2c, es
  el hueco de producto que deja.

---

## 7. Verificación — exactamente lo que corrí

```bash
# Backend, SOLO mi territorio
cd backend && TMPDIR=/tmp/pt-auditor-canales-2c python -m pytest tests/audit -q
#   -> 6 failed, 409 passed en 1186,72 s (19:46)
#   -> los 6 rojos son EXACTAMENTE los seis hallazgos de §2, con estos nombres:
#        test_the_same_cash_moves_the_expected_by_the_same_amount_whatever_channel_it_came_through  (H-1)
#        test_the_shift_tips_reading_counts_the_same_cash_tip_once                                  (H-2)
#        test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three                (H-3)
#        test_a_delivery_order_never_publishes_a_courier_with_id_zero                               (H-4)
#        test_the_platform_of_a_payment_is_resolved_with_is_not_none_and_never_with_or              (H-5)
#        test_no_business_invariant_of_2c_is_defended_with_a_bare_assert                            (H-6)
#   -> ningún invariante HEREDADO de `tests/audit` quedó rojo (incluido el poste re-apuntado)
cd backend && python -m mypy app
#   -> Success: no issues found in 123 source files

# Frontend, SOLO mi territorio
cd frontend && TMPDIR=/tmp/pt-auditor-canales-2c npx vitest run src/audit
#   -> 7 archivos, 107 tests (78 heredados + 29 míos), 0 rojos
cd frontend && npm run typecheck
#   -> limpio (exit 0, sin salida)

# La cadena de migraciones, corrida de verdad contra una base propia
cd backend && DATABASE_URL=sqlite:////tmp/pt-auditor-canales-2c/chain.db python -m alembic upgrade head
#   -> 0001 -> 0015, 79 tablas de dominio
```

**No corrí la suite completa del proyecto ni `npm run build`**: cinco agentes
trabajaban en paralelo sobre el mismo árbol.

### Archivos que escribí (los únicos)

| Archivo | Tests |
|---|---|
| `backend/tests/audit/conftest.py` | *(ampliado, no redefine nada)*: `enable_2c`, `courier`, `delivery_fee_product`, `platform`, `receivables_of`, `commissions_of`, `wastes_of`, `cash_movements_of` |
| `backend/tests/audit/test_channels_invariants.py` | 53 casos — flags, precio por canal, y H-3/H-4/H-5/H-6 |
| `backend/tests/audit/test_channels_money_invariants.py` | 25 tests — esperado de caja, cargo con impuesto, liquidación, venta compensada, comisión, inventario idéntico, zona horaria, `float`, y H-1/H-2 |
| `backend/tests/audit/test_kitchen_invariants.py` | 13 tests — marchar, bump idempotente, costo en runtime, el hueco del OpenAPI |
| `backend/tests/audit/test_contract_2c_invariants.py` | 21 casos — los siete contratos, `Duplicate Operation ID`, el guard de `DOMAINS`, el poste de la cadena |
| `backend/tests/audit/test_migration_invariants.py` | *(re-apuntado, §4)* |
| `frontend/src/audit/channels-kds.test.ts` | 29 tests — C7, los conjuntos publicados en las dos direcciones, una sola matemática, ceros mudos, costo, zona horaria, KDS sin esquema, 375/1024 px, escala de puntos básicos |

---

## 8. La lección de esta auditoría

**Los seis hallazgos salieron de dos lugares, y los dos estaban anunciados.**

Los dos bloqueantes cayeron en `app/shifts/**` — **tercer pedido seguido como
territorio cruzado, tercera vez que ahí cae un hallazgo**. Y no cayeron por
falta de dueño: `backend-dinero-canales` escribió el ida y vuelta de la
liquidación como contrato, con quién publica, quién llama y qué pasa cuando se
deshace, y **esa parte quedó impecable** (el deshacer, el espejo, el `409` sin
turno abierto: todo verde a la primera). Cayeron en el **monto**: la mitad de
ida y la mitad de vuelta estaban bien construidas, pero el término que cruza no
era el mismo que usa el camino de al lado. Nombrar el contrato ya no alcanza:
cuando lo que cruza es **plata**, hay que nombrar **con qué término** cruza, y
compararlo contra el camino que ya existía.

Y los cuatro restantes salieron del mismo sitio de siempre: el **cero mudo**
(H-4), el **`or` que lee `0` como ausencia** (H-5), la **regla escrita dos
veces** (H-3, la lista de canales activos) y el **guardrail que se evapora**
(H-6). Cuatro de cuatro son patrones que ya aparecieron en 2a y en 2b, con
dueños distintos cada vez.

Lo que sí funcionó del reparto, y conviene repetir: los **siete contratos
nombrados de antemano cerraron los siete**, y el que más miedo daba —`kitchen`
en `MODEL_MODULES`, registrado por un agente para otro— estaba hecho en el
primer commit y verificado por los dos lados. Cuando el cruce se nombra antes,
se cumple.

---
---

# RONDA 2 — verificación del cierre de H-1 y H-2

> **Esta sección se AGREGA. No se reescribió una sola línea de lo anterior.**
> H-1 y H-2 existieron, están documentados arriba tal como los medí en la
> ronda 1, y el veredicto de aquella ronda se mantiene. Lo que sigue es qué
> cambió el constructor, qué verifiqué corriendo y en qué estado quedan.

## Veredicto de la ronda 2, en una línea

**H-1 y H-2 están CERRADOS, y cerrados por el CÓDIGO: ni un assert se ablandó,
los dos tests que mandan pasaron sin que nadie los tocara, y la fórmula
heredada del esperado quedó intacta letra por letra. Pero la verificación
destapó dos hallazgos nuevos — uno de ellos, H-8, es plata de una persona: la
propina que el domiciliario ya entregó queda en el cajón y ninguna lectura
autoriza sacarla.**

| | Ronda 1 | Ronda 2 |
|---|---|---|
| **H-1** — la propina de domicilio movía el esperado y la de mostrador no | 🔴 BLOQUEANTE | ✅ **CERRADO** |
| **H-2** — `GET /shifts/{id}/tips` contaba la misma propina dos veces | 🔴 BLOQUEANTE | ✅ **CERRADO** |
| **H-3** — `active_channels` no gatea los canales nuevos | 🟡 abierta | 🟡 **abierta, sin mover** |
| **H-4** — domiciliario `id: 0` (cero mudo) | 🟡 abierta | 🟡 **abierta, sin mover** |
| **H-5** — la plataforma del cobro se resuelve con `or` | 🟡 abierta | 🟡 **abierta, sin mover** |
| **H-6** — el invariante de inventario se defiende con un `assert` pelado | 🟡 abierta | 🟡 **abierta, sin mover** (la línea se corrió de `:736` a `:760`) |
| **H-7** — `delivery_cash_pending` publica dos cantidades distintas con el mismo nombre | — | 🟡 **NUEVA (advertencia)** |
| **H-8** — la propina de domicilio YA LIQUIDADA no entra a `cash_out` | — | 🔴 **NUEVA (bloqueante)** — nació en la ronda 1, la tapaba H-2 |

---

## 1. Qué cambió el constructor, medido contra el árbol y no contra su informe

El conjunto de archivos tocados después de que cerré la ronda 1 (23:39 del
2026-09-19) es **exactamente éste** —lo leí del sistema de archivos, no del
entregable—:

```
backend/app/shifts/hooks.py
backend/app/shifts/tips.py
backend/app/shifts/schemas.py
backend/app/channels/service.py
frontend/src/features/shifts/DeliverySettlementPanel.tsx  (+ su test)
```

Y, lo que más importa: **`backend/app/shifts/service.py` NO está en la lista.**
Su `mtime` es `2026-09-19 22:04:49`, anterior al cierre de la ronda 1. El
esperado heredado no se tocó — ni por accidente.

| Archivo y línea | Qué hace ahora |
|---|---|
| `app/shifts/hooks.py:74-110` | **`payment_bucket(method, courier_employee_id)`**: la única función del sistema que decide el bolsillo de un cobro. `_OTHER_METHODS` (`:66`) quedó como detalle interno suyo; `PAYMENT_BUCKETS` (`:71`) publica los cinco bolsillos |
| `app/shifts/hooks.py:222` | `get_sales_totals` delega en ella (antes clasificaba en línea) |
| `app/shifts/tips.py:86` | `get_shift_tips` **llama a la misma función** (antes reclasificaba a mano releyendo `Payment` sin la exclusión: eso ERA H-2) |
| `app/shifts/tips.py:100,111-112` | Publica el renglón nuevo: `delivery` por empleado, `delivery_cash` y `delivery_cash_pending` en el cuerpo |
| `app/shifts/schemas.py:538` | `TipsByEmployeeOut.delivery: int = 0` |
| `app/shifts/schemas.py:554-555` | `ShiftTipsOut.delivery_cash: int = 0`, `delivery_cash_pending: int = 0` |
| `app/channels/service.py:502-521` | El `CashMovement(INCOME, DELIVERY_SETTLEMENT)` se escribe por **`amount`** (la venta sola). `tip_amount` se sigue calculando (`:503`) y guardando en la liquidación (`:531`), pero **no** viaja al movimiento |
| `app/channels/service.py:593-601` | El espejo de anulación, por **`settlement.amount`**: la vuelta devuelve lo mismo que movió la ida |
| `frontend/.../DeliverySettlementPanel.tsx` | Pinta `amount`, `tip_amount` y `total` del servidor. **No deriva ninguno** (verificado con un barrido nuevo) |

---

## 2. Los dos tests que mandan: verde, y verde por el código

```
cd backend && python -m pytest \
  "tests/audit/test_channels_money_invariants.py::test_the_same_cash_moves_the_expected_by_the_same_amount_whatever_channel_it_came_through" \
  "tests/audit/test_channels_money_invariants.py::test_the_shift_tips_reading_counts_the_same_cash_tip_once" -q
->  2 passed en 8,76 s
```

**Ni un assert se ablandó, y lo puedo demostrar sin pedir que me crean:** el
`mtime` de `tests/audit/test_channels_money_invariants.py` es
`2026-09-19 23:39:56` — **anterior** a los cuatro archivos de producto que el
constructor tocó (`00:03:04` a `00:04:08`). El test que estaba rojo es, byte
por byte, el mismo que hoy está verde. Lo único que cambió es el producto.

### La sensibilidad, medida y no supuesta

Que un test pase no prueba que sirva. Reinyecté el defecto de la ronda 1 por
monkeypatch (**sin tocar `app/**`**) y medí que los invariantes se ponen rojos:

| Defecto reinyectado | Qué midió el invariante |
|---|---|
| El `INCOME` de la liquidación vuelve a ser `amount + tip_amount` | `brecha mostrador = 10.000` · `brecha domicilio = 0` → **rojo** (con el arreglo: `10.000` y `10.000`) |
| `tips.py` vuelve a clasificar ignorando el domiciliario | `by_method.cash = 10.000` · `sum(by_employee[*].cash) = 19.000` → **rojo** (con el arreglo: iguales) |

Las dos firmas son exactamente las de H-1 y H-2. El archivo de sondeo se borró
después de medir; no queda nada fuera de mi territorio.

---

## 3. Los cinco puntos que el Maestro pidió cobrar

### 3.1 ✅ La fórmula heredada quedó intacta **letra por letra**

| Test | Qué prueba |
|---|---|
| `tests/audit/test_channels_round2_invariants.py::test_the_inherited_expected_formula_is_intact_letter_by_letter` | No compara "a ojo": extrae por AST la **única** asignación a `expected` dentro de `compute_breakdown` y a `to_deposit` dentro de `_finalize_close`, las `ast.unparse`, y las compara **string contra string** con el texto de 1b: `expected = base + sales.cash + incomes - expenses - pickups` y `to_deposit = count.counted_cash_total - settings.opening_cash_fixed - (count.tips_cash_out or 0)`. Un espacio distinto lo caza; un comentario que nombre la fórmula, no |
| `::test_the_expected_never_gained_a_delivery_term_anywhere_in_the_module` | El corolario, por si el término nuevo aparece en OTRA línea del mismo módulo: ninguna asignación a `expected`/`to_deposit` de `app/shifts/service.py` puede nombrar `delivery_cash`, `delivery_cash_pending`, `tips_delivery` ni `tips_delivery_pending` |
| `frontend/src/audit/channels-round2.test.ts` → «`compute_breakdown` conserva la fórmula de 1b letra por letra» | El mismo candado desde el otro lado del árbol, para que no haga falta correr pytest para verlo caer |

**Resultado: los tres verdes.** `compute_breakdown` (`app/shifts/service.py:226-270`)
y `to_deposit` (`:1035`) están idénticos. **No hay hallazgo nuevo por acá.**

### 3.2 ✅ Hay UNA sola función de clasificación, y los dos caminos la llaman

| Test | Qué prueba |
|---|---|
| `::test_only_one_function_in_the_backend_classifies_a_payment_into_its_pocket` | Barrido de AST sobre **todo** `app/**`: `_OTHER_METHODS` se define **una vez** y sólo en `app/shifts/hooks.py`; `payment_bucket` se define **una vez**. Un `_OTHER_METHODS` duplicado en cualquier módulo lo caza |
| `::test_both_readers_of_the_shift_money_call_the_single_classifier` | Los **dos** llamadores, por AST: `get_sales_totals` (hooks) y `get_shift_tips` (tips) contienen una llamada a `payment_bucket`. Si alguno deja de llamarla, rojo |
| `::test_the_tips_module_never_reclassifies_a_payment_method_by_hand` | El candado fino sobre `app/shifts/tips.py`: ni un `"cash"`/`"card"`/`"transfer"`/`"platform"`/`"voucher"` dentro de una comparación ni de un literal de conjunto/lista/tupla **dentro de `get_shift_tips`**. Se permiten como claves del acumulador (la forma del resultado), no como regla |
| `::test_the_shift_tips_body_answers_every_bucket_with_one_and_the_same_formula` | **El invariante que pidió el Maestro, por código**: con propinas de mostrador **y** de domicilio mezcladas en el mismo turno, **dos cobradores distintos** y los cuatro medios (efectivo, tarjeta, transferencia, plataforma), se exige `by_method.X == sum(by_employee[*].X)` para `cash`/`card`/`transfer`/`other`, más `by_method.cash == cash_out` y `electronic_liability == card + transfer + other`. Y que el renglón nuevo también cierre: `sum(by_employee[*].delivery) == delivery_cash` |

**Resultado: los cuatro verdes.** No quedó un `_OTHER_METHODS` duplicado ni un
bucle que reclasifique a mano. Medido en el cuerpo real:
`by_method.cash = 10.000`, `cash_out = 10.000`, `sum(by_employee[*].cash) = 10.000`,
`delivery_cash = 15.000` repartido por persona.

### 3.3 ✅ La plata no desapareció al sacarla de `.cash` — con una salvedad, que es H-8

| Test | Qué prueba |
|---|---|
| `::test_the_delivery_tip_row_is_a_whole_number_without_cost_or_commission` | El renglón nuevo, por las tres puertas: recorrido recursivo del JSON **real** buscando cualquier `float` (cero); ninguna clave con `cost`/`margin`/`commission` a ninguna profundidad; y `total` por empleado sigue sumando **los cinco** bolsillos, así que la propina que salió de `.cash` **se ve** |
| `::test_the_pending_delivery_cash_of_the_breakdown_is_sale_plus_tip_of_what_is_pending` | El puente entre las tres lecturas: `GET /delivery-settlements/pending` (`total == amount + tip_amount`), el `delivery_cash_pending` del desglose del turno (que tiene que ser **ese total**) y el de la respuesta de propinas (que es **la parte de propina**). Y después de liquidar: el esperado sube **exactamente por `amount`**, el `CashMovement` vale **exactamente `amount`**, y el pendiente queda en 0 |
| `frontend/src/audit/channels-round2.test.ts` → «el renglón de domicilio como ENTERO» | El esquema publicado: `TipsByEmployeeOut.delivery: int` y ningún `float` en el bloque de propinas |

**Resultado: los tres verdes.** El renglón es entero, sin costo ni comisión, y
venta+propina de lo pendiente coincide con `delivery_cash_pending` del
desglose. **Pero** al cruzar las tres lecturas aparecieron dos cosas que no
cierran: el mismo nombre con dos significados (**H-7**) y la propina liquidada
que nadie autoriza a sacar del cajón (**H-8**). Van en §4.

### 3.4 ✅ La anulación deja el esperado exactamente donde estaba

| Test | Qué prueba |
|---|---|
| `::test_settling_and_voiding_leaves_the_expected_exactly_where_it_was` | Liquidar → deshacer → **el mismo número**, con igualdad exacta. Además: los **dos** `CashMovement` de causa `delivery_settlement` valen **lo mismo** y valen `settlement.amount` (si la ida cambió a la venta sola y el espejo se hubiera quedado en venta + propina, el deshacer **fabricaría un faltante** del valor de la propina — H-1 de 2b en la otra dirección); sus `kind` son `{income, expense}`; el movimiento original queda **vivo** (`cash_movement_id is not None`); y los cobros vuelven a estar pendientes por el **mismo total** |
| `test_channels_money_invariants.py::test_voiding_a_settlement_without_an_open_shift_rejects_the_whole_thing` *(ronda 1, sin tocar)* | Sigue verde: `409 NO_OPEN_SHIFT` y la anulación se rechaza **entera** — se relee la fila y se exige `status=SETTLED`, `voided_at is None`, `void_cash_movement_id is None` |
| `test_channels_money_invariants.py::test_voiding_a_settlement_writes_the_mirror_and_leaves_the_original_alive` *(ronda 1, sin tocar)* | Sigue verde con el monto nuevo |

**Resultado: verde.** La ida y la vuelta se mueven por el mismo término.

### 3.5 ✅ Y donde la plata se ve de verdad: el arqueo

`::test_the_same_cash_opens_the_same_arqueo_gap_whatever_channel_it_came_through`
es el invariante que cierra H-1 en el conteo a ciegas, que es donde el defecto
se cobraba. Para cada canal mide

> **brecha = (efectivo que entró físicamente al cajón) − (lo que subió el esperado)**

y exige que sean **iguales**. Medido hoy:

```
[MOSTRADOR]  entró 110.000 (venta 100.000 + propina 10.000)  ·  esperado +100.000  ->  brecha 10.000
[DOMICILIO]  entró 115.000 (venta 105.000 + propina 10.000)  ·  esperado +105.000  ->  brecha 10.000
[ARQUEO]     diferencia del paso 2 del cierre a ciegas = 20.000 = 10.000 + 10.000
```

Con el defecto de la ronda 1 reinyectado, la brecha del domicilio era **0** y
la del mostrador **10.000**: quien contaba a ciegas veía una diferencia que
cambiaba según el canal. Hoy no. Y el test no se conforma con comparar las dos
brechas: **cierra el turno de verdad** y exige que la diferencia del paso 2 sea
exactamente la suma de las dos, para que no haya una tercera matemática en el
camino.

`::test_a_platform_sale_still_does_not_move_the_expected_after_the_round_2_fix`
es la regresión del renglón #2 sobre lo que ya estaba verde: tocar el
clasificador de bolsillos es tocar el camino por el que la venta de plataforma
se mantiene fuera del cajón. Verde: el esperado no se movió, `sales.cash == 0`,
`sales.other > 0`.

---

## 4. Hallazgos NUEVOS de la ronda 2

> Los dos salieron de cruzar lecturas que por separado están bien. Ninguno es
> regresión de la fórmula heredada.

### 🔴 H-8 — BLOQUEANTE. La propina de domicilio **ya liquidada** queda en el cajón y `cash_out` no la deja salir

**Test:** `backend/tests/audit/test_channels_round2_invariants.py::test_a_settled_delivery_tip_becomes_payable_from_the_drawer`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_round2_invariants.py -k settled_delivery_tip -q`
**Agente responsable:** `backend-dinero-canales`
**Archivos:** `backend/app/shifts/hooks.py:74-110` (`payment_bucket`), `backend/app/shifts/tips.py:62-67`, `backend/app/shifts/service.py:1035` (`to_deposit`)

**Medido corriendo, con los números impresos:**

```
[LIQUIDACIÓN]      amount 105.000 + tip 10.000 = total 115.000   (el domiciliario entrega las dos cosas)
[ANTES DE LIQUIDAR]  cash_out 10.000 · delivery_cash 10.000 · delivery_cash_pending 10.000
[DESPUÉS]            cash_out 10.000 · delivery_cash 10.000 · delivery_cash_pending 0
```

**Qué pasa.** `payment_bucket` (`hooks.py:107-108`) manda a `"delivery"`
**todo** cobro en efectivo con domiciliario, **mire o no** el
`delivery_settlement_id`. Entonces `tips_cash` —y por lo tanto `by_method.cash`
y `cash_out`— nunca incluye la propina de un domicilio, **ni siquiera después
de que el domiciliario la entregó**. El `pending` baja a 0 (la plata llegó) y
`cash_out` no se mueve.

**Por qué es plata, y de una persona.** `cash_out` es, por contrato publicado
(`app/shifts/schemas.py:545-547`), *«efectivo: sale del cajón al cierre»*, y
`to_deposit = contado − base fija − tips_cash_out` (`service.py:1035`). Si
quien cierra le hace caso a `cash_out`, los $10.000 del domiciliario **se
consignan como venta** en vez de pagarse a la persona. Es pasivo con el
personal (Ley 1935 de 2018), la misma ley que obliga a llevar la propina
separada de la venta.

**El código contradice su propio contrato escrito**, y eso es lo que lo hace
un defecto y no una decisión:

- `app/shifts/tips.py:58-60` promete: *«Es propina en efectivo que todavía
  tiene el domiciliario: se ve, se sabe de quién es, y **no se puede pagar del
  cajón hasta que entre**»*. Entra, y nunca se puede pagar.
- `app/shifts/hooks.py:98-100` declara: *«Lo que esta función no decide: si un
  cobro de domicilio ya está liquidado o sigue pendiente. Eso **se deriva de
  `delivery_settlement_id`, aparte**»*. Nadie lo deriva.

**No es regresión del arreglo.** El bolsillo `delivery` excluía la propina de
`tips_cash` desde la ronda 1. Lo declaro ahora y no antes porque en la ronda 1
**H-2 lo tapaba**: `by_employee` contaba esa propina igual, así que el reparto
por persona sí la ofrecía —mal, con otra fórmula, y eso era el hallazgo—.
Cerrada la contradicción, el hueco queda limpio y sin compensación. Es el
riesgo conocido de cerrar dos lecturas en la que decía de menos.

**Y no es un descuido: está DECIDIDO y fijado por escrito del otro lado.** El
constructor escribió en la ronda 2 su propio test
`backend/tests/channels/test_tips_single_bucket.py:150-159`, que afirma lo
contrario del mío:

```python
_settle(device_client, employees)
despues = _tips(admin_client, shift["id"])
assert despues["delivery_cash_pending"] == 0, "ya la entregó: deja de estar pendiente"
assert despues["by_method"]["cash"] == PROPINA, (
    "liquidar no mueve la propina a `cash`: la propina en efectivo se salda al cierre por "
    "`tips_cash_out`, igual que la de cualquier otra venta")
assert despues["cash_out"] == PROPINA          # ← sólo la de MOSTRADOR
```

**El propio motivo que el test escribe es el que lo desmiente**: «igual que la
de cualquier otra venta» es precisamente lo que NO pasa. Para una propina de
mostrador, `cash_out` la incluye y quien cierra teclea ese número en
`tips_cash_out`; para una de domicilio ya entregada, `cash_out` no la incluye y
nadie la teclea. Es la firma de H-1 otra vez —el mismo billete tratado distinto
según el canal— movida del `expected` al `cash_out`.

**Consecuencia práctica para el Maestro:** en la suite completa hay ahora **dos
tests que afirman cosas opuestas sobre el mismo número**
(`tests/channels/test_tips_single_bucket.py:159` en verde y
`tests/audit/test_channels_round2_invariants.py::test_a_settled_delivery_tip_becomes_payable_from_the_drawer`
en rojo). No se resuelve borrando uno: hace falta la decisión de negocio. **Yo
no ablando el mío**, que es la instrucción de esta ronda; lo dejo rojo con el
número medido.

**Remedio (una decisión, después una línea).** Las dos salidas coherentes:

1. `cash_out` suma las propinas de domicilio **ya liquidadas**
   (`tips_delivery − tips_delivery_pending`), que es exactamente el dato que
   `SalesTotals` ya calcula. Es la que menos toca y no roza `compute_breakdown`.
2. La liquidación deja de recibir la propina —el domiciliario se la queda— y
   entonces `DeliverySettlement.tip_amount` y el `total` de la pantalla tienen
   que **dejar de decir que la entrega**.

Lo que no puede quedar es que la plata entre al cajón y ninguna lectura
autorice sacarla.

### 🟡 H-7 — ADVERTENCIA. `delivery_cash_pending` publica dos cantidades distintas con el mismo nombre

**Test:** `backend/tests/audit/test_channels_round2_invariants.py::test_delivery_cash_pending_means_the_same_thing_in_every_response_that_publishes_it`
**Reproducir:** `cd backend && python -m pytest tests/audit/test_channels_round2_invariants.py -k means_the_same_thing -q`
**Agente responsable:** `backend-dinero-canales`
**Archivos:** `backend/app/shifts/schemas.py:178` y `:367` (desglose) contra `:555` (propinas); `app/shifts/service.py:269` contra `app/shifts/tips.py:112`

**Medido:** con un domicilio de $105.000 y $12.000 de propina,

```
GET /shifts/{id}        -> delivery_cash_pending = 117.000   (venta + propina)
GET /shifts/{id}/tips   -> delivery_cash_pending =  12.000   (sólo la propina)
```

Es el patrón de «conjunto publicado que el cliente duplica» en su forma más
silenciosa: **la misma clave, dos cantidades**, los dos `int`, y ningún
typecheck que lo vea. Quien lea `delivery_cash_pending` sin mirar de qué
respuesta vino va a mostrar un número por otro — y el error va en la dirección
que muestra **más** plata pendiente, que es la que `AGENTS.md` prohíbe.

No es plata mal calculada (los dos números son correctos), por eso es
advertencia y no bloqueante. **Remedio**: renombrar el de propinas a
`delivery_tips_pending` antes de que alguien construya la pantalla. Hoy nadie
consume `GET /shifts/{id}/tips` desde el cliente, así que el costo de
renombrarlo es cero; mañana no.

---

## 5. H-3, H-4, H-5 y H-6: abiertas, y nadie las movió de contrabando

Las corrí y las cuatro siguen rojas exactamente como las dejé. **No entran en
esta ronda** y no las convertí en trabajo de esta ronda: dejo constancia de
que siguen abiertas.

```
cd backend && python -m pytest tests/audit/test_channels_invariants.py -q \
  -k "active_channels or courier_with_id_zero or is_not_none or bare_assert"
->  4 failed, 49 deselected
```

| | Estado | Mensaje medido hoy |
|---|---|---|
| **H-3** | 🟡 abierta, sin mover | `active_channels = ['counter','dine_in','takeout']` y aun así `delivery -> 201`, `platform -> 201` |
| **H-4** | 🟡 abierta, sin mover | la comanda publica `courier = {'id': 0, 'name': ''}` |
| **H-5** | 🟡 abierta, sin mover | la plataforma del cobro se sigue resolviendo con `or` (`app/payments/service.py:421`) |
| **H-6** | 🟡 abierta, sin mover | el `assert` pelado sigue ahí; **la línea se corrió de `app/channels/service.py:736` a `:760`** porque el archivo creció con el arreglo de H-1. El test lo sigue encontrando solo (barre el AST, no la línea) |

El corrimiento de H-6 es la única diferencia, y es de numeración, no de
contenido: el `assert` es el mismo.

---

## 5-bis. Dos afirmaciones del entregable del constructor que el código desmiente (y para bien)

Verifiqué también lo que el entregable de `backend-dinero-canales` §10.7
declara como abierto, porque la instrucción de esta ronda es leer el código y
no el informe. **Las dos están CERRADAS**, así que la corrección va en la
dirección barata: el informe es más pesimista que el árbol.

| Lo que dice `outputs/backend-dinero-canales.md §10.7` | Lo que dice el código |
|---|---|
| *«R-1 sigue en pie (el invariante de migraciones fija `head == "0012"`)»* | **Falso hoy.** Lo re-apunté en la ronda 1: `tests/audit/test_migration_invariants.py:417` exige `version == "0015"` y `:454` exige `len(tablas) == 79`, con el conjunto enumerado. Verde |
| *«R-2 sigue en pie (la etiqueta `delivery_settlement` del lado del cliente)»* | **Falso hoy.** `frontend/src/features/shifts/MovementsPanel.tsx:62` tiene `delivery_settlement: "Liquidación de domicilios"`, y mi invariante de conjuntos publicados lo cobra desde la ronda 1. Verde |

No es un hallazgo: es un informe que quedó atrás de su propio árbol. Lo dejo
escrito para que el Maestro no persiga dos rojos que no existen.

**Y una que el constructor sí vio a medias**: su O-7 nuevo advierte que
`ShiftTipsOut.delivery_cash` es *propina*, no venta, y que conviene leer el
comentario antes de nombrar la columna. Es la mitad del problema. La otra
mitad —la que un comentario no arregla— es que
`ShiftTipsOut.delivery_cash_pending` y `BreakdownOut.delivery_cash_pending`
son **el mismo nombre publicado con dos cantidades**, y ésa es **H-7**.

---

## 6. Invariantes heredados: ninguno re-apuntado en esta ronda

**Cero re-apuntados.** No aflojé, no moví ni borré ningún invariante heredado
en la ronda 2. El único poste que se movió en todo el pedido sigue siendo el de
la cadena de migraciones, documentado arriba en §4 de la ronda 1 con su antes,
su después y su «nada dejó de estar cubierto».

Los cuatro invariantes que 2c toca por diseño, al cierre de la ronda 2:

| Invariante | Estado |
|---|---|
| **(a) El esperado de caja** | **Intacto, y ahora con candado de texto exacto.** La ronda 2 agregó el pin letra-por-letra de `expected` y de `to_deposit` desde dos archivos distintos (backend y frontend), más el invariante de que ninguna asignación del módulo nombre el efectivo de domicilios |
| **(b) La matemática del impuesto** (`app/core/tax.py`) | **Intacto.** No se tocó en la ronda 2 |
| **(c) «El operador no ve costos»** | **Intacto.** Los barridos siguen verdes; el renglón nuevo de propinas se verificó sin `cost`/`margin`/`commission` a ninguna profundidad |
| **(d) El consumo de inventario de 2a** | **Intacto.** La ronda 2 no tocó `orders` ni `inventory` |

---

## 6-bis. O-7 — una observación HEREDADA de 1b que la ronda 2 vuelve visible

**No es hallazgo de 2c y no lo cuento como tal**, pero alguien tiene que
leerlo porque el arreglo de H-1 lo pone bajo la luz.

`difference = counted_cash_total − expected` (`app/shifts/service.py:907`) y
`tips_cash_out` **no entra** en esa resta (sólo en `to_deposit`, `:1035`). Como
el esperado nunca incluyó la propina en efectivo, **toda propina en efectivo
que esté en el cajón al momento de contar aparece como SOBRANTE** y exige causa
tipada. Medido hoy con dos propinas de $10.000:

```
diferencia del paso 2 del cierre a ciegas = 20.000 = las dos propinas en efectivo
```

Es comportamiento de **1b**, idéntico para mostrador desde antes de 2c; el
invariante que lo pinta es
`::test_the_same_cash_opens_the_same_arqueo_gap_whatever_channel_it_came_through`
(su última aserción). Lo que hizo la ronda 2 fue **meter la propina de
domicilio en la misma pila**, que es exactamente la consistencia que H-1 pedía.
Si el dueño de la spec decide que el arqueo no debe acusar las propinas, el
arreglo es en 1b (`_evaluate_close`), no en 2c — y hay que hacerlo **antes** de
que el producto salga, porque hoy todo turno con propina en efectivo cierra con
diferencia.

---

## 7. Corrida final, con los números exactos

```bash
# Backend — SOLO mi territorio
cd backend && TMPDIR=/tmp/pt-auditor-canales-2c python -m pytest tests/audit -q
#   -> 6 failed, 422 passed en 1232,77 s (20:32)
#      (la ronda 1 daba 6 failed, 409 passed sobre 415 casos; hoy son 428 casos)

cd backend && python -m mypy app
#   -> Success: no issues found in 123 source files

# Frontend — SOLO mi territorio
cd frontend && TMPDIR=/tmp/pt-auditor-canales-2c npx vitest run src/audit
#   -> 8 archivos, 113 tests, 0 rojos  (107 de la ronda 1 + 6 nuevos)

cd frontend && npm run typecheck
#   -> limpio (exit 0, sin salida)
```

**No corrí la suite completa del proyecto ni `npm run build`.**

### Los rojos que quedan, nombrados con archivo y línea

Quedan **seis rojos, y son exactamente los seis hallazgos abiertos** — ninguno
es un invariante heredado y ninguno es H-1 ni H-2:

| Test rojo | Hallazgo | Archivo del defecto |
|---|---|---|
| `tests/audit/test_channels_invariants.py::test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three` | **H-3** (advertencia, ronda 1) | `app/orders/service.py:673-680` |
| `tests/audit/test_channels_invariants.py::test_a_delivery_order_never_publishes_a_courier_with_id_zero` | **H-4** (advertencia, ronda 1) | `app/orders/service.py:457` |
| `tests/audit/test_channels_invariants.py::test_the_platform_of_a_payment_is_resolved_with_is_not_none_and_never_with_or` | **H-5** (advertencia, ronda 1) | `app/payments/service.py:421` |
| `tests/audit/test_channels_invariants.py::test_no_business_invariant_of_2c_is_defended_with_a_bare_assert` | **H-6** (advertencia, ronda 1) | `app/channels/service.py:760` |
| `tests/audit/test_channels_round2_invariants.py::test_a_settled_delivery_tip_becomes_payable_from_the_drawer` | **H-8** (BLOQUEANTE, nuevo) | `app/shifts/hooks.py:107-108` |
| `tests/audit/test_channels_round2_invariants.py::test_delivery_cash_pending_means_the_same_thing_in_every_response_that_publishes_it` | **H-7** (advertencia, nueva) | `app/shifts/schemas.py:555` contra `:178`/`:367` |

**Los dos rojos de la ronda 1 que esta ronda existía para cerrar NO están en
esta lista.** Ése es el veredicto, y es el único que cuenta.

La cuenta cierra exacta contra la ronda 1: **415 casos → 428** (los 13 nuevos
del archivo de la ronda 2), **409 verdes → 422**: `409 + 11` (los 13 nuevos menos los 2
que nacen rojos) `+ 2` (H-1 y H-2, que pasaron de rojo a verde) `= 422`. Y los
rojos siguen siendo 6, pero **no son los mismos seis**: salieron H-1 y H-2,
entraron H-7 y H-8. Ningún invariante heredado de `tests/audit` quedó rojo.

### Archivos que escribí en la ronda 2 (los únicos)

| Archivo | Tests |
|---|---|
| `backend/tests/audit/test_channels_round2_invariants.py` | **13** — el pin letra-por-letra de la fórmula heredada, el clasificador único y sus dos llamadores, el cuerpo de propinas bolsillo por bolsillo, el renglón entero sin costo, el puente entre las tres lecturas del pendiente, liquidar→deshacer, la brecha del arqueo por canal, la regresión de plataforma, y H-7 y H-8 |
| `frontend/src/audit/channels-round2.test.ts` | **6** — venta y propina ya no pesan igual (nadie las suma en el cliente), la pantalla de liquidación pinta los tres números del servidor, el renglón de propina como entero, y el pin de la fórmula heredada desde el árbol del frontend |

**No escribí una sola línea de `backend/app/**` ni de `frontend/src/` fuera de
`src/audit/`.** Los dos informes (`outputs/` y `outputs-2c/`) se **ampliaron**;
no se editó nada de lo anterior.

---

## 8. Lo que la ronda 2 NO pudo cubrir

Lo mismo que la ronda 1 (§5 de arriba, que sigue vigente palabra por palabra),
más una que nace acá:

1. **Navegador real** (checklist #14, parte). Sin cambios: jsdom no calcula
   layout. Hueco abierto desde 1a.
2. **Concurrencia real.** Dos liquidaciones del mismo domiciliario a la vez
   siguen sin poder probarse: SQLite, un proceso.
3. **Postgres.** Sin cambios.
4. **Recorrido de punta a punta con la base sembrada.** Sin cambios.
5. **Nuevo: el reparto de propinas de punta a punta.** `POST /admin/tips/payouts`
   registra el reparto pero **no lo calcula** (decisión de 1b, `SPEC-NEGOCIO §6.2`)
   y **ninguna pantalla del cliente consume `GET /shifts/{id}/tips`**. O sea que
   H-8 hoy no tiene superficie donde verse: el número equivocado no se muestra
   en ningún lado todavía. Eso lo hace más barato de arreglar y más fácil de
   olvidar. Lo digo para que no se confunda «nadie lo ve» con «no pasa».

---

## 9. La lección de la ronda 2

**El arreglo fue el correcto y fue quirúrgico** —cuatro archivos, cero líneas
en el esperado heredado, una sola función donde antes había dos fórmulas— y
los dos bloqueantes cerraron por el código, con los tests intactos. Eso es
exactamente lo que había que hacer.

Y aun así aparecieron dos hallazgos, **y los dos salieron del mismo gesto**:
cruzar lecturas que por separado están bien. H-7 salió de leer
`delivery_cash_pending` en las dos respuestas que lo publican. H-8 salió de
preguntarle al sistema qué pasa **después** de liquidar, cuando la plata ya
entró — el momento que ni el test de la ida ni el de la vuelta miran, porque
los dos terminan en el instante de la escritura.

La lección, que es la de 2b afinada un paso: cuando se cierra una contradicción
entre dos lecturas de la misma plata, **hay que preguntar cuál de las dos tenía
razón**. Acá las dos decían cosas distintas y se las hizo coincidir en la que
decía de menos; nadie verificó que «de menos» fuera lo correcto, y no lo era
para la propina ya entregada. Unificar la fórmula no es lo mismo que acertarle
a la fórmula.
