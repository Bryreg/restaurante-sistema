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

---
---

# RONDA 3 — el cierre de H-4, H-5, H-6, H-7 y H-8, y el único rojo que queda a propósito

> **Esta sección se AGREGA. No se reescribió una sola línea de las rondas 1 y 2.**
> Los hallazgos conservan su número, su historia y su dueño. Lo que cambia acá
> es el ESTADO de cada uno y la FORMA de los tests que los miden, cuando el
> contrato que fijó el Maestro hizo que la forma vieja dejara de medir.

## Veredicto de la ronda 3, en una línea

**Los siete hallazgos que dependían de código están CERRADOS Y CERRADOS POR EL
CÓDIGO —H-1 y H-2 en la ronda 2; H-4, H-5, H-6, H-7 y H-8 en ésta—, la
contradicción entre mi suite y `tests/channels/` desapareció, y NINGÚN
invariante heredado quedó re-apuntado ni aflojado. Queda UN solo rojo, H-3, y
queda rojo porque el Maestro decidió diferirlo: es una deuda con dueño y
remedio, no un defecto que nadie vio.**

| Hallazgo | Ronda 1 | Ronda 2 | Ronda 3 |
|---|---|---|---|
| **H-1** — la propina de domicilio movía el esperado y la de mostrador no | 🔴 BLOQUEANTE | ✅ CERRADO | ✅ sigue cerrado |
| **H-2** — `GET /shifts/{id}/tips` contaba la misma propina dos veces | 🔴 BLOQUEANTE | ✅ CERRADO | ✅ sigue cerrado, y medido otra vez |
| **H-3** — `active_channels` no gatea los canales nuevos | 🟡 abierta | 🟡 abierta | 🟡 **DIFERIDA por decisión del Maestro — roja a propósito** |
| **H-4** — domiciliario `id: 0` (cero mudo) | 🟡 abierta | 🟡 abierta | ✅ **CERRADO** |
| **H-5** — la plataforma del cobro se resuelve con `or` | 🟡 abierta | 🟡 abierta | ✅ **CERRADO** |
| **H-6** — el invariante más caro del pedido, con un `assert` pelado | 🟡 abierta | 🟡 abierta | ✅ **CERRADO** |
| **H-7** — `delivery_cash_pending`, un nombre con dos significados | — | 🟡 nueva | ✅ **CERRADO** |
| **H-8** — la propina ya liquidada queda en el cajón sin autorización de salida | — | 🔴 BLOQUEANTE | ✅ **CERRADO** |

Y los dos renglones del checklist que las rondas 1 y 2 dejaron en rojo quedan
**verdes**: **#2** (una venta de plataforma no mueve el esperado — el hermano
H-1 está cerrado) y **#4** (el efectivo de domicilios se arquea aparte — con
la ida, la vuelta y ahora también la propina). Los quince renglones quedan
como en la ronda 1 salvo esos dos y el **#14**, que sigue amarillo por el
hueco de navegador real que está abierto desde 1a y que no miento sobre él.

---

## 1. Lo primero, porque es lo que se pidió primero: reexpresar mis tests

El contrato final que fijó el Maestro al cerrar H-7 renombra claves de una
respuesta publicada:

| Respuesta | Antes | Ahora |
|---|---|---|
| `GET /shifts/{id}/tips` (`ShiftTipsOut`) | `delivery_cash` | **`delivery_tips`** |
| `GET /shifts/{id}/tips` (`ShiftTipsOut`) | `delivery_cash_pending` | **`delivery_tips_pending`** |
| `GET /shifts/{id}/tips` (`ShiftTipsOut`) | — | **`delivery_tips_settled`** (nuevo, lo publica el servidor) |
| `GET /shifts/{id}` (`BreakdownOut` / `ShiftSummaryOut`) | `delivery_cash_pending` | **igual** — venta + propina, sin cambios |

Verificado en el OpenAPI de la app **real**, no en el archivo:

```
ShiftTipsOut props: ['by_employee', 'by_method', 'cash_out', 'delivery_tips',
                     'delivery_tips_pending', 'delivery_tips_settled', 'electronic_liability']
```

Las dos claves viejas **ya no existen** en esa respuesta.

Ese renombre es el remedio **que yo mismo prescribí**, así que hace explotar
mis propios tests **por `KeyError`, no por el producto**. Reexpresarlos no es
ablandarlos: en los cuatro casos el hecho medido quedó igual o más exigente, y
el nombre e historia del hallazgo se conservan.

### 1.1 H-8 — `test_a_settled_delivery_tip_becomes_payable_from_the_drawer`

`backend/tests/audit/test_channels_round2_invariants.py`. Mismo escenario y
mismos montos que en la ronda 2: propina de mostrador $10.000 + propina de
domicilio $10.000, liquidación completa.

| | Ronda 2 | Ronda 3 |
|---|---|---|
| de dónde sale «lo liquidado» | lo **restaba el test**: `delivery_cash − delivery_cash_pending` | se **lee del cuerpo**: `delivery_tips_settled` |
| si el servidor no lo publica | el test lo calculaba igual y podía pasar | **`KeyError` → rojo** |
| coherencia del campo nuevo | no se medía | `settled == tips − pending`, exigido |
| el monto absoluto | implícito | `settled == 10.000` y `cash_out == 20.000`, exigidos |
| que cerrar H-8 no reabra H-2 | no se medía acá | `by_method.cash == 10.000` **y** `== sum(by_employee[*].cash)`, exigidos |
| la identidad final | `cash_out == by_method.cash + liquidada` | igual |

**Cinco aserciones nuevas, ninguna quitada.** Que `delivery_tips_settled` se
lea del cuerpo y no se derive **es parte del hallazgo**: obligar al cliente a
restar dos campos para saber cuánta plata puede sacar del cajón es media
matemática del lado del cliente, y la regla dura del proyecto dice una sola y
en el backend.

**Estado: ✅ VERDE.** Medido: `by_method.cash = 10.000`, `cash_out = 20.000`,
`delivery_tips = 10.000`, `delivery_tips_pending = 0`,
`delivery_tips_settled = 10.000`.

### 1.2 H-7 — `test_delivery_cash_pending_means_the_same_thing_in_every_response_that_publishes_it`

Mismo escenario (un domicilio en efectivo con propina de $12.000, sin
liquidar). La forma vieja comparaba los dos valores; con el renombre aplicado
esa comparación ya no puede hacerse, y **hacerla sería ablandar el hallazgo a
nada**. La forma nueva mide las cuatro cosas que el cierre exige:

- **(a)** el cuerpo de `GET /shifts/{id}/tips` **no publica** las claves
  `delivery_cash_pending` ni `delivery_cash` — afirmado sobre las CLAVES del
  JSON, no sobre un valor, así que un servidor que publicara las dos a la vez
  seguiría rojo;
- **(b)** publica `delivery_tips_pending` y vale **sólo la propina**
  (`== pend["tip_amount"]`);
- **(c)** `GET /shifts/{id}` **sigue publicando** `delivery_cash_pending` y
  sigue valiendo venta + propina (`== pend["total"]`);
- **(d)** el puente cierra: `desglose − propinas_pendientes == venta_pendiente`,
  y se exige que los dos números sean **distintos** en este escenario, para que
  el test no mida una igualdad trivial. Es más estricto que la forma de la
  ronda 2, que se conformaba con una igualdad.

**Estado: ✅ VERDE.**

### 1.3 H-4 — `test_a_delivery_order_never_publishes_a_courier_with_id_zero`

`backend/tests/audit/test_channels_invariants.py`. Este también hubo que
reexpresarlo, y por la misma razón: **el remedio correcto rompió la forma del
test**. La versión de la ronda 2 afirmaba `entregado["courier"]["id"] != 0`,
dando por hecho que `courier` siempre viene; el arreglo —el que el hallazgo
pedía— hace que venga `null`. Verificado corriendo, **antes** de reexpresar:

```
tests/audit/test_channels_invariants.py:592: in test_a_delivery_order_never_publishes_a_courier_with_id_zero
    assert entregado["courier"]["id"] != 0, mensaje
E   TypeError: 'NoneType' object is not subscriptable
```

Forma nueva, con **dos filos donde antes había uno**:

- el bloque `delivery` **no desaparece** y **conserva la dirección** — que
  «arreglarlo» borrando el bloque entero no pase, que era el atajo disponible;
- `courier` es `null` **o** un empleado real — nunca `id: 0`, nunca `id: null`,
  nunca nombre vacío.

Sensibilidad del predicado, medida sobre los cinco casos que importan:

| `courier` publicado | veredicto |
|---|---|
| `null` | PASA (es el contrato correcto) |
| `{"id": 0, "name": ""}` | **ROJO** (el defecto original) |
| `{"id": 0, "name": "X"}` | **ROJO** |
| `{"id": null, "name": "X"}` | **ROJO** |
| `{"id": 7, "name": "Juan"}` | PASA |

**Estado: ✅ VERDE.**

### 1.4 Los tres renames que no son hallazgos, declarados igual

| Test | Qué cambió | Qué dejó de estar cubierto |
|---|---|---|
| `test_the_shift_tips_body_answers_every_bucket_with_one_and_the_same_formula` | `cuerpo["delivery_cash"]` → `cuerpo["delivery_tips"]`, **+1 aserción** (`delivery_tips_settled == 0`) | **Nada.** Mismos montos ($15.000), una exigencia más |
| `test_the_delivery_tip_row_is_a_whole_number_without_cost_or_commission` | `delivery_cash`/`delivery_cash_pending` → `delivery_tips`/`delivery_tips_pending` | **Nada.** Mismos montos ($9.000) |
| `test_the_pending_delivery_cash_of_the_breakdown_is_sale_plus_tip_of_what_is_pending` | sólo en la lectura de `/tips`; la del desglose queda **igual** | **Nada** |

---

## 2. La sensibilidad, medida y no supuesta

Un test que no se pone rojo cuando el defecto vuelve no mide nada. Reinyecté
los dos defectos **por monkeypatch, sin tocar una línea de `app/**`**, corrí
los dos invariantes reexpresados, capturé la firma exacta del rojo y **borré el
archivo de sondeo y su `.pyc`**.

### H-8 — defecto reinyectado: `cash_out` vuelve a ser sólo `tips_cash`

```python
monkeypatch.setattr(tips_mod, "ShiftTipsOut", defectuoso)   # cash_out = by_method.cash
```

Firma del rojo, literal:

```
`cash_out` = 10000 y en el cajón hay 10000 de propina de mostrador MÁS 10000 de
propina de domicilio ya liquidada (esperado 20000). `cash_out` es lo que sale del
cajón al cierre (app/shifts/schemas.py:545-547) y `to_deposit` resta exactamente eso
(app/shifts/service.py:1035): la propina del domiciliario se consigna como venta en
vez de pagarse a la persona (Ley 1935 de 2018)...
assert 10000 == (10000 + 10000)
```

### H-7 — defecto reinyectado: el cuerpo de propinas vuelve a publicar la clave ambigua

Firma del rojo, literal:

```
`GET /shifts/{id}/tips` todavía publica la clave `delivery_cash_pending`, que en el
desglose del turno significa otra cosa (venta + propina). Claves publicadas:
['by_employee', 'by_method', 'cash_out', 'delivery_cash_pending', 'delivery_tips',
 'delivery_tips_pending', 'delivery_tips_settled', 'electronic_liability']
```

**Una nota honesta sobre CÓMO se reinyectó este segundo defecto**, porque
cambia lo que el sondeo prueba: el `response_model` de FastAPI
(`app/shifts/router.py:339`, que declara `-> ShiftTipsOut`) **descarta toda
clave que el esquema no declare**. Sin editar `app/**` —que no es mi
territorio— el servidor **no puede** volver a publicar `delivery_cash_pending`
en esa ruta. Por eso el defecto se inyectó en el cuerpo que el test lee, no en
el servidor. Lo que el sondeo prueba, entonces, es que **la aserción no es
vacua** (se pone roja si la clave aparece), no que el servidor pueda
reintroducirla. Y ese límite es, en sí mismo, un dato del cierre: el renombre
quedó defendido por el propio `response_model`, no sólo por mi test.

Sondeo borrado, verificado:

```
tests/audit/test_zz_sensitivity_probe_round3.py                       -> borrado
tests/audit/__pycache__/test_zz_sensitivity_probe_round3*.pyc         -> borrado
find /home/user/restaurante-sistema -name "*zz_sensitivity*" | wc -l  -> 0
```

---

## 3. La contradicción entre suites: desapareció

En la ronda 2, `tests/channels/test_tips_single_bucket.py` afirmaba **lo
contrario** de mi invariante H-8: que después de liquidar `cash_out` seguía
siendo sólo la propina de mostrador. Leído hoy en el árbol —no en el informe de
nadie—, las líneas que el Maestro nombró (`:150-159`) ya **no** son una
aserción: son un `print` de las cinco cifras del cuerpo. Y las aserciones que
ocuparon su lugar, en `:220-225`:

```python
assert despues["cash_out"] == PROPINA * 2, (
    f"después de liquidar, del cajón salen las DOS propinas: la de mostrador ({PROPINA}) y la "
    f"de domicilio ya entregada ({PROPINA}). `cash_out` = {despues['cash_out']}"
)
assert despues["cash_out"] == despues["by_method"]["cash"] + despues["delivery_tips_settled"], (
    "la identidad publicada del esquema: `cash_out == by_method.cash + delivery_tips_settled`"
)
```

Es **exactamente** lo que exige mi H-8, con los mismos números. Y el docstring
del mismo test (`:126-141`) deja escrito **por qué** cambió, que importa tanto
como el cambio: «Este test afirmaba antes que después de liquidar `cash_out`
seguía siendo sólo la propina de mostrador. Era el contrario exacto de lo que
pasa físicamente».

**NO edité ese archivo**: no es mi territorio. Lo leí y lo verifiqué.
**No hay bloqueante que reportar acá.**

---

## 4. H-5, H-6 y H-4 cerrados POR EL CÓDIGO — la prueba de mtimes

La regla que el Maestro fijó en la ronda 2 y que sigue valiendo: un rojo se
cierra cambiando el producto, no el test. Los mtimes lo demuestran — **el
código cambió DESPUÉS de que mis tests quedaran escritos, y a mis tests no los
tocó nadie**:

| Archivo | mtime | qué es |
|---|---|---|
| `backend/tests/audit/test_channels_money_invariants.py` | `2026-09-19 23:39:56` | mío, rondas 1-2 |
| `backend/tests/audit/test_channels_invariants.py` | `2026-09-19 23:20:39` | mío, ronda 1 |
| `backend/tests/audit/test_channels_round2_invariants.py` | `2026-09-20 00:22:56` | mío, **antes** de los arreglos |
| `backend/app/payments/service.py` | `2026-09-20 00:51:19` | **H-5** |
| `backend/app/channels/service.py` | `2026-09-20 00:51:39` | **H-6** |
| `backend/app/shifts/tips.py` | `2026-09-20 00:52:20` | **H-8** |
| `backend/app/shifts/schemas.py` | `2026-09-20 00:52:46` | **H-7** |
| `backend/app/shifts/hooks.py` | `2026-09-20 00:52:54` | H-7/H-8 |
| `backend/app/orders/service.py` | `2026-09-20 00:54:50` | **H-4** |
| `backend/tests/channels/test_tips_single_bucket.py` | `2026-09-20 00:55:36` | del constructor |

Ningún archivo de `backend/tests/audit/**` ni de `frontend/src/audit/**` fue
modificado por otro agente. Los únicos mtimes nuevos de esta ronda en mi
territorio son los de los tres archivos que reexpresé yo.

### H-5 — `app/payments/service.py:~421`: `is not None`, y no `or`

```python
from_order = getattr(order, "platform_id", None)
from_payload = getattr(payload, "platform_id", None)
candidate = from_order if from_order is not None else from_payload
if candidate is None:
    raise AppError("PLATFORM_REQUIRED", "Indicá la plataforma que cobró este pedido antes de cerrarlo", status=400)
```

El `or` desapareció, la comanda manda sobre el body, y el caso «no hay
plataforma» se responde con `AppError` tipado en vez de con un `0` inventado.
`::test_the_platform_of_a_payment_is_resolved_with_is_not_none_and_never_with_or`
(AST sobre `_resolve_channels`, busca `BoolOp/Or` que nombre `platform_id`):
**✅ VERDE**.

### H-6 — `app/channels/service.py:~760`: `AppError` tipado, cero `assert` pelados

```python
if returned_ids:
    db.rollback()
    raise AppError(
        "PLATFORM_CANCEL_WOULD_RESTOCK",
        "La cancelación de esta venta de plataforma habría repuesto inventario ...",
        status=409,
    )
```

`::test_no_business_invariant_of_2c_is_defended_with_a_bare_assert` (AST: cero
nodos `ast.Assert` en `app/channels/service.py` y `app/kitchen/service.py`):
**✅ VERDE**.

Y una cosa que el constructor hizo bien y conviene dejar dicha, porque es
justo lo que 2b tuvo que aprender a los golpes: el `db.rollback()` **va antes**
del `raise` y no es decorativo — `get_db` (`app/core/db.py:122`) comitea
**también** ante `AppError`, así que sin él se guardaría exactamente el
movimiento de inventario que el error existe para impedir.

### H-4 — `app/orders/service.py:452-466`: el bloque sigue, el cero mudo se fue

```python
delivery = DeliveryOut(
    address=order.delivery_address,
    phone=order.delivery_phone or "",
    courier=(
        EmployeeRef(id=order.courier_employee_id, name=order.courier_employee_name or "")
        if order.courier_employee_id is not None
        else None
    ),
)
```

**✅ VERDE**, con el test reexpresado de §1.3.

---

## 5. Un invariante NUEVO que esta ronda obligaba a escribir: la mitad de vuelta de H-8

El arreglo de H-8 hace que `cash_out` **crezca** cuando el domiciliario
liquida. Los cinco hallazgos de cruce de 2b fueron, los cinco, «la mitad de ida
construida sin la mitad de vuelta», así que la pregunta era obligatoria:
**¿qué pasa cuando la liquidación se deshace?** El movimiento espejo saca esa
plata del cajón; si `cash_out` no bajara con ella, el cierre autorizaría un
retiro contra plata que ya no está — un faltante fabricado, que es H-1 de 2b
en la otra dirección.

Escribí el test que faltaba:
`backend/tests/audit/test_channels_round2_invariants.py::test_voiding_a_settlement_takes_the_delivery_tip_back_out_of_cash_out`.

| momento | `cash_out` | `delivery_tips_pending` | `delivery_tips_settled` | esperado |
|---|---|---|---|---|
| antes de liquidar | 10.000 | 10.000 | 0 | `E` |
| después de liquidar | **20.000** | 0 | **10.000** | `E + venta` |
| después de anular | **10.000** | **10.000** | **0** | **`E`** |

**✅ VERDE.** La ida y la vuelta cierran, y cierran juntas: el `void` devuelve
los pagos a `delivery_settlement_id = NULL` (`app/channels/service.py:608-612`)
y las dos lecturas —la de consejo y la del arqueo— vuelven al mismo número.
Es una buena noticia para el constructor: **construyó la vuelta, no sólo la
ida.** Pero no estaba cobrada por ningún test, y ahora lo está.

---

## 6. H-3 — ROJA POR DECISIÓN DEL MAESTRO, no por descuido

**No la cerré, no la ablandé, no borré su test, no la moví de severidad.**
`tests/audit/test_channels_invariants.py::test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three`
queda **roja**, con su cuerpo intacto, y con la razón de la diferición escrita
en su propio docstring para que el próximo que la lea no la confunda con un
defecto suelto. Así se ve el rojo hoy:

```
E   AssertionError: la sede tiene `active_channels` = ['counter', 'dine_in', 'takeout'] y aun así
    acepta comandas de los canales nuevos: ['delivery -> 201', 'platform -> 201'].
    `app/orders/service.py:673-680` sólo mira la lista para `counter`/`dine_in`/`takeout`
```

**Por qué se difiere (razón del Maestro, registrada tal cual):** gatear
`delivery`/`platform` por `active_channels` **sin backfill** dejaría a toda
sede existente sin poder vender por domicilio el día del deploy —el default del
alta es `["counter", "dine_in", "takeout"]`—, y la casilla que el administrador
necesitaría para activarlos (`StoreFormDialog.tsx`) es territorio de otro
pedido.

**La deuda, con dueño y remedio, para que no se pierda:**

| | |
|---|---|
| **Dueño** | `backend-canales-comanda` |
| **Remedio** | Extender la guarda de `create_order` a `DELIVERY`/`PLATFORM` **junto con** (a) una migración que agregue `delivery`/`platform` a `active_channels` de las sedes que ya tengan la función encendida, y (b) la casilla en `StoreFormDialog.tsx`. |
| **Por qué las tres juntas** | Cualquier remedio parcial rompe sedes vivas: la guarda sin el backfill apaga el domicilio de todos; el backfill sin la casilla deja al administrador sin forma de apagarlo. |
| **Cuándo se cierra sola** | El test se pone verde el día que las tres vayan juntas. No hay que tocarlo. |
| **Riesgo mientras tanto** | Bajo y acotado: el canal igual está detrás de su flag (`pos.delivery`, `pos.platforms`) con `400 FEATURE_DISABLED`. Lo que falta es el segundo interruptor, no el primero. |

---

## 7. NINGÚN invariante heredado quedó re-apuntado

Lo digo con la lista completa, y medido, no razonado.

### 7.1 Las tres afirmaciones `cash_out == by_method.cash`: sin tocar y verdes

| Archivo:línea | Afirmación | Estado |
|---|---|---|
| `tests/audit/test_channels_round2_invariants.py:442` | `cuerpo["cash_out"] == por_metodo["cash"]` | **sin tocar, verde** |
| `tests/audit/test_channels_money_invariants.py:1450` | `cuerpo["cash_out"] == por_empleado` | **sin tocar, verde** |
| `tests/audit/test_reports_invariants.py:491` | `propinas["cash_out"] == 5_000` | **sin tocar, verde** |

Las tres siguen en el **mismo número de línea** que en la ronda 2 — la forma
más barata de demostrar que nadie las movió.

**Y por qué siguen siendo verdes, medido y no razonado:** en los tres
escenarios **nadie liquida**, así que `delivery_tips_settled` vale `0` y la
identidad nueva (`cash_out == by_method.cash + delivery_tips_settled`) colapsa
en la heredada. En vez de afirmarlo de palabra lo **clavé midiendo**: agregué
en `test_channels_round2_invariants.py`, después del bloque de la línea 442 y
**sin tocarlo**,

```python
assert cuerpo["delivery_tips_settled"] == 0, (
    f"nadie liquidó en este turno y `delivery_tips_settled` = {cuerpo['delivery_tips_settled']}: "
    "si no es 0, la igualdad `cash_out == by_method.cash` de arriba dejó de medir lo que dice medir"
)
```

Si mañana alguien hace que ese escenario liquide, la igualdad heredada dejaría
de medir lo que dice medir **en silencio**; ahora avisa.

### 7.2 El pin por AST de `expected` y de `to_deposit`: reconfirmado letra por letra

`tests/audit/test_channels_round2_invariants.py:95` compara el `ast.unparse` de
la **única** asignación de cada nombre contra el texto exacto de 1b:

```
expected   = base + sales.cash + incomes - expenses - pickups
to_deposit = count.counted_cash_total - settings.opening_cash_fixed - (count.tips_cash_out or 0)
```

**Verde, las dos.** Y el corolario (`:126`): ninguna asignación a
`expected`/`to_deposit` puede nombrar `delivery_cash`, `delivery_cash_pending`,
`tips_delivery` ni `tips_delivery_pending`. **Verde.**

Esto es lo que garantiza que el cierre de H-8 **no se comió el esperado por la
puerta de atrás**. `cash_out` es una lectura **de consejo** —cuánto puede sacar
el cajero—; lo que efectivamente sale del cajón sigue siendo el `tips_cash_out`
que la persona escribe al cerrar (`CloseWizard.tsx:104`,
`SingleStepCloseForm.tsx:99`), con `cash_out` pintado al lado «tal cual llega,
nunca sumado ni restado» (`CloseWizard.tsx:91-92`). La aritmética del arqueo no
cambió: el sobrante del conteo a ciegas sigue siendo exactamente la propina en
efectivo que hay en el cajón, con la diferencia de que ahora la propina del
domiciliario ya entregada **está autorizada a salir**.

### 7.3 Y ningún conjunto exacto se aflojó a «que contenga al menos»

El barrido de claves prohibidas (`cost`, `margin`, `commission`) del cuerpo de
propinas sigue siendo sobre **todas** las claves anidadas; el pin de
`expected`/`to_deposit` sigue siendo igualdad de **texto exacto**; el barrido
de `float` sobre el JSON real de `/tips` sigue recorriendo el árbol entero. No
toqué ninguno.

### 7.4 Frontend: el mismo cuidado, y dos invariantes nuevos

`frontend/src/audit/channels-round2.test.ts`:

- el test que exigía que el cliente declarara el renglón de domicilio ahora
  exige **los tres** campos (`delivery_tips`, `delivery_tips_pending`,
  `delivery_tips_settled`) en vez de dos: **más exigente**;
- **nuevo**: ninguna pantalla puede derivar `delivery_tips_settled` restando
  `delivery_tips − delivery_tips_pending`. El servidor lo publica; derivarlo
  sería una segunda matemática de la plata que se puede sacar del cajón — la
  regla dura que H-8 existió para defender;
- **nuevo**: el renombre **no se propagó al desglose**. `src/api/shifts.ts`
  sigue declarando `delivery_cash_pending` para `ShiftCurrent`/`ShiftSummary`,
  y el tipo de `ShiftTips` ya **no** lo declara. Si alguien «termina de
  renombrar» y se lleva puesto el desglose, la pantalla del turno deja de ver
  los domicilios pendientes y este test lo dice.

---

## 8. Dos comprobaciones que no me pidieron y que hice igual

### 8.1 El renombre no dejó cabos sueltos en ningún árbol

Un renombre de una clave publicada es exactamente donde se rompe un lector que
nadie miró. Barrí los dos árboles:

- **`backend/app/**`**: los únicos `delivery_cash*` que quedan son los del
  desglose (`shifts/service.py:269`, `:953`; `shifts/schemas.py:110`, `:178`,
  `:367`; `shifts/router.py:175-292`) y los nombres de función/ruta de
  liquidación (`settle_delivery_cash`, `pending_delivery_cash`). Ninguno es la
  respuesta de propinas. **Correcto.**
- **`backend/tests/**` fuera de mi territorio**: los cinco archivos que nombran
  `delivery_cash` (`tests/channels/test_tips_single_bucket.py`,
  `test_platform_expected_cash.py`, `test_delivery_settlement.py`,
  `test_expected_cash_parity.py`, `tests/shifts/test_delivery_cash_apart.py`)
  leen **el desglose** o el atributo interno `SalesTotals.delivery_cash`, no el
  cuerpo de `/tips`. **Ninguno queda colgado del renombre.** Es el dato que le
  importa al Maestro para su corrida en serie: **el renombre no debería
  producirle un solo rojo fuera de mi territorio.**
- **`frontend/src/**`**: `src/api/shifts.ts` declara las tres claves nuevas en
  `ShiftTips` y conserva `delivery_cash_pending` en el desglose; ninguna
  pantalla deriva nada.

### 8.2 OpenAPI de la app real, otra vez

```
rutas: 170   operaciones: 200   Duplicate Operation ID: []
```

Cero duplicados. (En la ronda 1 eran 171 rutas; la diferencia es de otros
agentes, no del renombre, que no toca rutas.)

**Una observación menor, HEREDADA y fuera del renglón #13** (que habla de
comisiones y precios por canal, no de esto): `SalesSettingsIn/Out.tip_suggested_pct`
viaja como `number` (float) en el OpenAPI. Es de **1b-2** y está **idéntico a
`HEAD`** — no lo tocó 2c. Y no es aritmética con float: la columna es
`Numeric(5,2)` y el cálculo usa `Decimal(str(...))`
(`app/orders/service.py:269`, `app/payments/service.py:149`). Lo dejo anotado
para que nadie lo descubra en la fase 3 creyendo que nació acá.

---

## 9. Corrida final, con los números exactos

```bash
# Backend — SOLO mi territorio
cd backend && TMPDIR=/tmp/pt-auditor-canales-2c python -m pytest tests/audit -q
#   -> 1 failed, 428 passed en 1226,54 s (0:20:26)  — 429 casos
#      (la ronda 2 daba 6 failed, 422 passed sobre 428 casos)

cd backend && python -m mypy app
#   -> Success: no issues found in 123 source files

# Frontend — SOLO mi territorio
cd frontend && npx vitest run src/audit
#   -> 8 archivos, 115 tests, 0 rojos  (113 de la ronda 2 + 2 nuevos)

cd frontend && npm run typecheck
#   -> limpio (exit 0, sin salida)
```

**No corrí la suite completa del proyecto ni `npm run build`.**

### La cuenta, para que cierre contra la ronda 2

| | Ronda 1 | Ronda 2 | **Ronda 3** |
|---|---|---|---|
| Casos de `tests/audit` | 415 | 428 | **429** (+1: el test de la mitad de vuelta, §5) |
| Verdes | 409 | 422 | **428** |
| Rojos | 6 | 6 | **1** |

`422 + 1` (el caso nuevo, que nace verde) `+ 5` (H-4, H-5, H-6, H-7 y H-8, que
pasaron de rojo a verde) `= 428`. Los rojos bajan de **6 a 1**: salieron los
cinco, no entró ninguno. **Ningún invariante heredado de `tests/audit` quedó
rojo.**

Corrida intermedia, por transparencia sobre el método: la primera corrida
completa de esta ronda (antes de reexpresar H-4) dio **2 failed, 426 passed**,
y el segundo rojo era el `TypeError` de §1.3 — el test viejo explotando contra
el arreglo correcto, no el producto fallando. La corrida que reporto arriba es
posterior a la reexpresión y es la que vale.

### El único rojo que queda, nombrado con su hallazgo y su dueño

| Test rojo | Hallazgo | Dueño | Estado |
|---|---|---|---|
| `tests/audit/test_channels_invariants.py::test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three` | **H-3** (advertencia, ronda 1) | `backend-canales-comanda` | 🟡 **DIFERIDA por decisión del Maestro** — deuda documentada en §6 |

**Los cinco rojos de la ronda 2 que esta ronda existía para cerrar NO están en
esta lista.** El total bajó de **6 → 1**, y el que queda es exactamente el que
el Maestro decidió diferir. Sin maquillaje: **no hay ningún rojo inesperado, ni
uno solo.**

### Archivos que escribí en la ronda 3 (los únicos)

| Archivo | Qué le hice |
|---|---|
| `backend/tests/audit/test_channels_round2_invariants.py` | Reexpresé H-7 y H-8 contra el contrato nuevo (§1.1, §1.2), renombré la clave en tres tests más (§1.4), agregué la aserción que clava el «`settled == 0`» de los escenarios heredados (§7.1) y **escribí el test nuevo de la mitad de vuelta** (§5). **14 casos** (13 + 1) |
| `backend/tests/audit/test_channels_invariants.py` | Reexpresé H-4 (§1.3) y documenté la diferición de H-3 en su docstring, **sin tocar su cuerpo** (§6). **53 casos**, sin cambio de cuenta |
| `frontend/src/audit/channels-round2.test.ts` | Los tres campos en vez de dos, y **dos invariantes nuevos** (§7.4). **8 casos** (6 + 2) |

**No escribí una sola línea de `backend/app/**` ni de `frontend/src/` fuera de
`src/audit/`.** `features/fase-2c-canales-cocina/outputs-2c/` quedó
**idéntico** (`diff` vacío contra su estado previo). Ningún commit, ningún push.

---

## 10. Lo que la ronda 3 NO pudo cubrir

Lo de las rondas 1 y 2 sigue vigente palabra por palabra (§5 de la ronda 1, §8
de la ronda 2). Con dos cambios:

1. **Navegador real** (checklist #14, parte). Sin cambios: jsdom no calcula
   layout. Hueco abierto desde 1a. **No lo maquillo.**
2. **Concurrencia real.** Dos liquidaciones del mismo domiciliario a la vez
   siguen sin poder probarse: SQLite, un proceso.
3. **Postgres.** Sin cambios: mis tests corren contra SQLite.
4. **Recorrido de punta a punta con la base sembrada.** Sin cambios.
5. **El reparto de propinas de punta a punta** (era el hueco #5 de la ronda 2).
   **Cambió, y para mejor**: `GET /shifts/{id}/tips` ya tiene consumidor
   —`CloseWizard.tsx:218` y `SingleStepCloseForm.tsx:170` pintan `cash_out` al
   lado del campo `tips_cash_out`—, así que el número que H-8 arregló **ahora
   sí se ve**. Lo que sigue sin poder probarse acá es que la persona que cierra
   **le haga caso**: `tips_cash_out` se escribe a mano y nada obliga a que
   coincida con `cash_out`. Es una decisión de producto de 1b, no un defecto de
   2c — pero ahora que `cash_out` incluye propina de un empleado, vale la pena
   que alguien decida si ese campo debería venir pre-llenado. **Lo dejo como
   pregunta abierta para la fase 3, no como hallazgo.**
6. **Nuevo: la reinyección server-side del defecto de H-7.** Declarada en §2:
   el `response_model` impide reintroducir la clave sin editar `app/**`, así
   que el sondeo midió la **aserción**, no el servidor. No es un hueco grave
   —el `response_model` es mejor defensa que mi test— pero no voy a decir que
   probé algo que no probé.

---

## 11. La lección de la ronda 3

Las tres rondas de este pedido dejaron el mismo dibujo, cada vez más nítido:
**los hallazgos no salieron de mirar una regla, salieron de cruzar dos lecturas
de la misma plata.** H-2 cruzó `by_method` con `by_employee`. H-7 cruzó la
misma clave en dos respuestas. H-8 cruzó el antes y el después de la
liquidación. Y el test nuevo de §5 salió de cruzar la ida con la vuelta.

Pero la lección propia de esta ronda es otra, y es incómoda: **cuando el
auditor prescribe un remedio, se le rompen los tests propios — y ése es el
momento más peligroso de toda la auditoría.** Tres de mis cuatro tests
reexpresados explotaban por `KeyError` o por `TypeError`, **no por el
producto**. La salida floja estaba a un `try/except` de distancia y la salida
cómoda —bajarlos a «que contenga al menos»— a una línea. Nadie se habría dado
cuenta: el hallazgo seguiría figurando como cerrado y el invariante ya no
mediría nada.

La disciplina que lo evita es una sola y es aburrida: **el hecho medido tiene
que quedar igual o más exigente, escrito en una tabla, con la columna «qué dejó
de estar cubierto» llena aunque diga "nada".** Si esa columna no se puede
llenar, no era una reexpresión: era un ablandamiento. Por eso está en §1.4 y en
§7.3, y por eso cada reexpresión de esta ronda agregó aserciones en vez de
quitarlas.
