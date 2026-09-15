# Auditor de venta — pedido 1b-1 (comanda y cobro)

Rol: Contador + Legal del equipo. Convierto las reglas de plata, consecutivo,
concurrencia, aislamiento y privacidad en **tests ejecutables** en territorio propio
(`backend/tests/audit/**`, `frontend/src/audit/**`) y reporto lo que falla con
archivo:línea, reproducción y severidad. **No arreglo código ajeno.**

Fuentes vinculantes: `docs/SPEC-NEGOCIO.md` (§2, §3.1, §3.3–3.6, §6.1, §6.2, §8.2,
§8.3, §8.4, §11, §12), `features/fase-1b-venta/spec.md` (contrato de API y checklist
de 1b, tomando **sólo** los ítems de 1b-1), `AGENTS.md`, `docs/ESTADO.md` y
`features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md` (§2.2 modelos, §2.3 firmas, §2.4
API, §2.5 hooks, §2.6 Alembic, §3 fixtures, §4 códigos, §5 reglas de plata, §6.1 una
sola matemática).

**Resumen en una línea:** la plata cierra. Las cinco identidades de la venta se
cumplen sobre 1.000 comandas aleatorias y de punta a punta por la API; el consecutivo
no tiene huecos tras 100 ventas ni después de tres rechazos; dos cobros concurrentes
dejan una venta, un pago y un documento. **Un hallazgo bloqueante de contrato** (no de
plata): la comanda ya cobrada se rechaza con `400 ORDER_NOT_OPEN` donde el contrato y
la spec declaran `409 ORDER_ALREADY_PAID`, y eso deja muerta la pantalla que el
frontend ya escribió para ese caso.

---

## 1. Qué cambió en mi territorio

| Archivo | Qué |
|---|---|
| `backend/tests/audit/conftest.py` | `expected_of` ahora lee como **administrador** (O-1); fixtures nuevas `sales_products`, `audit_tables`; helpers `create_order`, `add_items`, `get_order`, `pay`, `NO_TIP` |
| `backend/tests/audit/test_cash_invariants.py` | O-1: tres invariantes de 1a reescritos + tres nuevos (flag encendida / apagada / paso 2 del cierre) |
| `backend/tests/audit/test_sales_invariants.py` | **nuevo** — 11 invariantes de plata de la venta |
| `backend/tests/audit/test_fiscal_invariants.py` | **nuevo** — 8 invariantes de consecutivo, concurrencia y evidencia |
| `backend/tests/audit/test_security_invariants.py` | +13 invariantes de privacidad, costos, aislamiento, autorización, versión optimista y forma del error |
| `backend/tests/audit/test_migration_invariants.py` | +3 invariantes de `0004`/`0005`, índice único parcial y UNIQUE del consecutivo |
| `frontend/src/audit/sales.test.ts` | **nuevo** — 12 invariantes por inspección de fuente sobre el territorio de la venta |

Total: **96 invariantes ejecutables** en backend (35 de caja, 11 de venta, 8 de
comprobante, 36 de identidad/aislamiento/privacidad, 6 de migraciones) y **20** en
frontend, de los cuales **32 son nuevos de 1b-1** más 6 reescritos por O-1.

---

## 2. Inventario de invariantes (archivo::test → regla que prueba)

### 2.1 `backend/tests/audit/test_sales_invariants.py` (nuevo)

| Test | Regla |
|---|---|
| `test_the_money_identities_hold_on_a_thousand_random_orders` | Contrato §5.1 y checklist 1b: sobre 1.000 comandas con `random.Random(20260915)` — Σ `lines.net` = `total`; Σ prorrateo = descuento de comanda aplicado; Σ `tax_lines.tax` = `tax_total`; Σ `tax_lines.base` = Σ líneas `base`; `tip_base` = `total` − `tax_total`; ningún descuento supera el bruto de su línea; ningún `net` negativo; `base + tax = net` por línea |
| `test_prorating_never_loses_a_peso_even_on_the_hardest_remainders` | Contrato §2.3 / SPEC §3.4: `prorate` reparte exacto (Σ = monto), el residuo va a la línea mayor, un peso 0 recibe 0 |
| `test_the_same_identity_holds_in_the_order_the_prebill_and_the_document` | Contrato §5.1 + §6.1: la misma identidad y los mismos números en `OrderOut.totals`, `PreBillOut` y `DocumentPrintableOut`; tres tarifas discriminadas (§8.2); precuenta con leyenda de §3.3 y **sin** consecutivo |
| `test_the_tip_never_enters_the_sale_the_tax_or_the_shift_sales` | SPEC §3.4 y §6.2 (Ley 1935 de 2018, art. 512-9 ET): la propina no entra en `subtotal`/`total`/`tax_*` del documento ni en `sales.*` del turno; entra sólo en `tips.*`, por medio de pago |
| `test_splitting_by_items_keeps_the_total_and_issues_one_document_per_sub_account` | Contrato §5.2 / SPEC §3.4: Σ totales de sub-cuentas = total de la comanda; N documentos con consecutivos distintos y **seguidos** |
| `test_splitting_in_equal_parts_issues_one_document_with_n_payments` | SPEC §3.4: «partes iguales = un solo documento con N pagos»; Σ `per_part` = `total` |
| `test_a_staff_meal_is_free_untaxed_untipped_and_leaves_no_document` | Contrato §5.5 / SPEC §3.3 y §8.2: `unit_price` 0, `list_price` conservado, `tax_rate` 0, `tip` nulo, total 0, **sin documento**, no suma a `sales.*` ni al esperado; `consumed_by` presente |
| `test_with_kitchen_view_off_send_is_refused_and_payment_serves_the_items` | Contrato §5.6 / checklist 1b: con `kitchen.view` apagada `send` y `GET /kitchen/rounds` son `FEATURE_DISABLED`; al cobrar los ítems quedan `served` con `sent_at_payment=true`; `kitchen_view_enabled` congelado al abrir |
| `test_voiding_a_sent_item_never_restores_the_counter_and_creates_a_waste_stub` | Contrato §5.7 / SPEC §3.3: anular lo enviado **no** repone `daily_remaining` ni `available`; crea un `waste_stubs` con `ingredient_id NULL`, `resolved=False`, nombre congelado y `minutes_since_sent` |
| `test_a_sale_at_00_30_belongs_to_the_business_date_of_its_shift` | SPEC §3.1 y checklist 1b: venta a las 00:30 de Bogotá → día operativo del turno, en la comanda y en el documento |
| `test_a_sale_on_a_shift_past_the_cutoff_is_stamped_with_today` | SPEC §3.1: turno abandonado (pasada la hora de corte del día siguiente) → la venta se sella con hoy |

### 2.2 `backend/tests/audit/test_fiscal_invariants.py` (nuevo)

| Test | Regla |
|---|---|
| `test_one_hundred_sales_produce_a_sequence_without_holes` | SPEC §8.3 / contrato §5.4: 100 ventas → consecutivo 1..100, sin huecos, saltos ni repetidos, un solo prefijo |
| `test_a_rejected_payment_does_not_consume_a_number` | SPEC §8.3: tres rechazos `400` (`SPLITS_DO_NOT_MATCH`, `PAYMENT_METHOD_INVALID`, `PIN_INVALID`) no mueven `fiscal_counters.next_number`; el cobro bueno toma el número que quedó |
| `test_two_concurrent_payments_leave_one_sale_one_payment_and_one_document` | SPEC §3.4 / contrato §5.4, sobre `race_env`: exactamente un `201`, un `Payment`, un `FiscalDocument`; la perdedora rechazada |
| `test_a_payment_on_an_already_paid_order_or_sub_account_is_a_409_already_paid` | **ROJO — hallazgo B-1.** Contrato §4 y checklist 1b: `409 ORDER_ALREADY_PAID` y `409 SUB_ACCOUNT_ALREADY_PAID` |
| `test_replaying_the_same_idempotency_key_returns_the_same_document` | SPEC §11.9 / checklist 1b: misma `Idempotency-Key` → misma respuesta (`paid_at` incluido) y un solo documento |
| `test_an_issued_document_is_immutable_and_reprinting_only_counts` | SPEC §8.3 y §3.4: reimprimir sólo suma `reprint_count` y una fila `document_reprints`; 17 campos del documento intactos; ninguno queda `reversed` en 1b-1 |
| `test_no_document_of_this_phase_carries_dian_evidence` | Contrato §2.2 y el pedido: `dian_status=pending`, `cude`/`qr_url`/`xml_ref`/`provider_response`/`fiscal_range_id`/`validated_at` siempre `NULL`; leyenda «pendiente de transmisión»; `fiscal` del printable todo en `null` |
| `test_with_the_electronic_document_off_it_is_an_internal_receipt_that_never_claims_otherwise` | Pedido 1b: con `fiscal.dee_pos` apagada → `internal_receipt`, `dian_status` `NULL`, consecutivo propio 1..3, leyenda que niega ser factura **y** documento equivalente, y `type_label` que tampoco lo dice |

### 2.3 `backend/tests/audit/test_cash_invariants.py` (O-1, tarea A)

| Test | Regla |
|---|---|
| `test_with_blind_close_on_the_cash_responsible_does_not_see_the_expected` | **O-1 invertido.** Contrato §2.4 «Caja» y §5.8: con `cash.blind_close` encendida (default del perfil `full`) el responsable recibe `expected_cash`, `sales` y `tips` en `null` en `current` y en `{id}` |
| `test_with_blind_close_off_the_cash_responsible_sees_the_expected_again` | La misma regla al revés: con la flag apagada vuelve el contrato de 1a |
| `test_the_expected_reaches_the_responsible_only_in_step_two_of_the_close` | §3.2: el paso 1 (`close/count`) sigue a ciegas; el paso 2 (`review`) le revela el esperado al mismo responsable |
| `test_reading_the_current_shift_does_not_extend_the_person_session` (reescrito) | §2.1 (la lectura no renueva la ventana) **+** O-1: `/shifts/current` devuelve `expected_cash: null` al responsable |
| `test_a_handover_moves_the_responsibility_and_with_blind_close_off_the_expected_moves_with_it` (reescrito) | §3.2 con la flag apagada: el relevo mueve la responsabilidad y el esperado |
| `test_with_blind_close_on_a_handover_hides_the_expected_from_both_responsibles` | §3.2 con la flag encendida: el relevo mueve la responsabilidad igual, ninguno de los dos ve el esperado ni el `breakdown`, el administrador sí |

Sin cambios de intención: los otros 29 invariantes de caja de 1a. La fixture
`expected_of` (`tests/audit/conftest.py:181`) pasó a leer el esperado **como
administrador**, que es el único observador cuya visibilidad no depende de una flag;
los cinco tests de la ecuación del esperado que dependían de ella siguen midiendo lo
mismo.

### 2.4 `backend/tests/audit/test_security_invariants.py` (tareas B y E)

| Test | Regla |
|---|---|
| `test_the_employee_audit_trail_never_stores_the_document_or_the_email` | **A-7.** SPEC §8.4 / contrato §5.9: el `before`/`after` de `entity="employee"` no guarda `document` ni `email`, ni como clave ni como valor; `GET /admin/employees` los sigue mostrando |
| `test_the_device_employee_list_shows_only_id_name_and_role` | **A-9.** SPEC §9.1 / contrato §2.4: `GET /device/employees` devuelve exactamente `{id, name, role}`; no lista inactivos ni personal de otra sede; sí a los admins de la organización; nunca `document`, `email`, `discount_limit_pct`, `can_charge` ni hashes |
| `test_the_device_employee_list_requires_an_activated_device` | La misma lista sin dispositivo → `401` con la forma de error de siempre |
| `test_no_sale_response_for_a_device_carries_cost_margin_or_unit_cost` | Contrato §5.10 / AGENTS.md: nueve respuestas de dispositivo (comandas, favoritos, mesas, cocina, precuenta, cobro, documento, último documento) sin `cost`, `margin`, `unit_cost`, `food_cost` ni `recipe_version` |
| `test_the_openapi_of_orders_kitchen_payments_and_documents_declares_no_cost_fields` | Lo mismo sobre el contrato publicado, incluyendo `/admin/orders` y `/admin/documents` |
| `test_a_device_gets_404_on_an_order_a_kitchen_round_and_a_document_of_another_store` | SPEC §1.1 y §11.1: `404 NOT_FOUND` (nunca `403` ni `200`) en dos lecturas y tres escrituras, para otra sede de la misma organización **y** para otra organización; los listados (`/orders`, `/kitchen/rounds`, `/documents/last`) dejan de mostrarla |
| `test_the_table_map_of_a_device_only_shows_its_own_store` | La misma regla en `GET /tables/status` y al abrir comanda sobre una mesa ajena (`404`) |
| `test_a_supervisor_authorizes_voids_and_after_bill_changes_but_never_a_pickup` | SPEC §2.2 / contrato §2.3: el supervisor autoriza `after_bill_change` y `void_order`; el mismo PIN en un retiro → `AUTHORIZATION_NOT_ALLOWED` |
| `test_voiding_a_sent_item_without_a_pin_names_the_corrective_action` | SPEC §3.3 + §11.18: `pending` se anula libre; `sent` sin PIN → `400 AUTHORIZATION_REQUIRED` con un mensaje que nombra el PIN |
| `test_charging_requires_the_persons_own_pin_and_the_permission_to_charge` | SPEC §2.1 y §2.2: PIN ajeno → `PIN_INVALID`; sin `can_charge` → `CANNOT_CHARGE`; con ambos → `201` |
| `test_every_mutation_with_a_stale_version_returns_409_with_the_current_order` | SPEC §3.3 / contrato §2.4: **las 12 mutaciones** con `expected_version` devuelven `409 STALE_VERSION` con `extra.order` = la comanda vigente (con sus ítems) |
| `test_every_new_business_error_of_the_sale_has_exactly_one_shape` | SPEC §11.18 y §12 / contrato §4: 12 códigos nuevos con `{error:{code,message}}`, `400`, mensaje para humanos; `OPEN_ORDERS_EXIST` con `open_orders` |
| `test_the_takeout_customer_data_travels_only_where_it_is_needed` | SPEC §8.4: el teléfono de para-llevar vive en la comanda, **no** en el comprobante ni en `GET /admin/orders` (exportable a CSV); adquirente «consumidor final» |

### 2.5 `backend/tests/audit/test_migration_invariants.py` (tarea F)

| Test | Regla |
|---|---|
| `test_the_chain_reaches_the_two_migrations_of_the_sale` | Contrato §2.6: `alembic upgrade head` sobre SQLite nuevo deja `alembic_version = "0005"` y las 14 tablas de comanda y cobro |
| `test_one_open_order_per_table_is_defended_by_a_partial_unique_index` | SPEC §3.3 y §11.9: `uq_order_tables_one_open_per_table` existe, es **único**, es sobre `(table_id)` y es **parcial** (`WHERE released_at IS NULL`) |
| `test_the_consecutive_is_defended_by_unique_constraints_in_the_database` | SPEC §8.3 / contrato §2.2: `UNIQUE(store_id, document_type, prefix)` en `fiscal_counters`; `UNIQUE(target_key)` y `UNIQUE(store_id, document_type, prefix, number)` en `fiscal_documents`, inspeccionados con `sqlalchemy.inspect` |
| (ya existían, ahora cubren `0004`/`0005` automáticamente) | tablas del DDL = tablas de los modelos; columnas del DDL = columnas de cada modelo; `downgrade base` deja sólo `alembic_version` |

### 2.6 `frontend/src/audit/sales.test.ts` (tarea G, nuevo)

| Test | Regla |
|---|---|
| `ninguna pantalla de comanda o cobro hace aritmética sobre un campo de plata` | Contrato §6.1 / AGENTS.md §11.13: nada de `+ - * /` sobre `subtotal`, `total`, `tax`, `tip`, `discount`, `change`, `per_part`, `base`, salvo la lista `ALLOWED` enumerada con archivo y motivo |
| `ninguna pantalla de comanda o cobro redondea plata` | El redondeo a peso es de `app/orders/money.py:round_half_up` |
| `la única excepción declarada es sumTyped, y sigue siendo sólo una suma` | Contrato §6.1: `features/payments/lib.ts` exporta **una** función, y es una suma (sin `-`, `*`, `/`) |
| `el cambio, las partes iguales y los totales de sub-cuenta se pintan como llegan` | `PaymentOut.change`, `split.per_part` y `SubAccountOut.totals` nunca se derivan |
| `DeviceEmployee tiene exactamente id, name y role` | Contrato §6.2 y SPEC §8.4 |
| `EmployeePicker no nombra documento, correo ni límites de descuento` | idem |
| `ninguna pantalla nueva pide el maestro de empleados del administrador` | §9.1 / A-9: el POS usa `GET /device/employees` |
| `las pantallas de comanda, cocina y cobro no usan localStorage ni sessionStorage` | SPEC §11.11 / AGENTS.md |
| `ninguna pantalla escribe una leyenda legal a mano` | SPEC §3.3 y §8.3, con una única tolerancia enumerada |
| `el comprobante muestra la leyenda del servidor y no tiene alternativa fija` | §8.3: `DocumentPage` lee `doc.legend` y no tiene respaldo escrito |
| `la tolerancia de la precuenta sigue siendo un respaldo, no la fuente` | La excepción de `CheckoutPage` no puede volverse la fuente (tiene que seguir siendo `legend ??`) |
| `encuentra los archivos de comanda, cobro y selector de personal` | Guardia contra el falso verde: si el territorio no existiera, todo lo de arriba pasaría sin mirar nada |

---

## 3. Hallazgos

Severidades: **bloqueante** = viola una regla declarada (spec, contrato o AGENTS);
**advertencia** = riesgo real sin regla explícita que lo prohíba; **observación** =
mejora o deuda menor.

### B-1 (bloqueante) — La comanda ya cobrada se rechaza con `400 ORDER_NOT_OPEN`, no con `409 ORDER_ALREADY_PAID`

- **Dónde**: `backend/app/orders/service.py:1555-1556` (comanda) y
  `backend/app/orders/service.py:1563-1564` (sub-cuenta).

  ```python
  # :1555
  if order.status not in _OPEN_ORDER_STATUSES:
      raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta", status=400)
  # :1563
  if sub_account is not None and sub_account.status != "open":
      raise AppError("SUB_ACCOUNT_ALREADY_PAID", "Esta sub-cuenta ya fue cobrada", status=400)
  ```

- **Qué regla viola**: `CONTRATO-INTERNO-1b-1.md §4` declara `SUB_ACCOUNT_ALREADY_PAID`
  como **409** y `409 ORDER_ALREADY_PAID` como el código de la carrera de cobro;
  `features/fase-1b-venta/spec.md` (checklist) pide literalmente «Dos `payments`
  concurrentes: `200` y `409`»; SPEC-NEGOCIO §3.4: «Dos dispositivos cobrando la
  misma comanda: uno gana, el otro `409`».
- **Reproducción** (`tests/audit/test_fiscal_invariants.py::test_a_payment_on_an_already_paid_order_or_sub_account_is_a_409_already_paid`):
  1. Abrir turno, crear comanda `counter` con un ítem, cobrarla → `201`.
  2. Cobrar otra vez con una `Idempotency-Key` nueva →
     `400 {"error":{"code":"ORDER_NOT_OPEN","message":"La comanda no está abierta"}}`.
  3. Igual en carrera real sobre `race_env` con `ThreadPoolExecutor(2)`: la perdedora
     vuelve con `(400, "ORDER_NOT_OPEN")`.
  4. Con dos sub-cuentas y una pagada, cobrar de nuevo esa sub-cuenta →
     `400 SUB_ACCOUNT_ALREADY_PAID` (el contrato dice 409).
- **Por qué importa, más allá del número**: `claim_payment`
  (`app/orders/service.py:1591`) sí levanta el `409 ORDER_ALREADY_PAID` correcto, con
  el mensaje correcto («Esta comanda ya fue cobrada; consultá el comprobante»), pero
  `assert_payable` corta antes y esa rama queda prácticamente inalcanzable: en SQLite
  el lock de escritura serializa los dos requests, y en Postgres sólo se alcanza en la
  ventana entre el `SELECT` y el `UPDATE`. Consecuencia concreta en el frontend:
  `frontend/src/features/payments/PaymentSplitsForm.tsx:136` ramifica sobre
  `err.code === "ORDER_ALREADY_PAID"` y `CheckoutPage.tsx:216` pinta «Esta comanda ya
  fue cobrada / Ver el último comprobante». **Esa pantalla nunca se enciende**: la
  segunda tablet de la mesa recibe «La comanda no está abierta», que suena a error del
  sistema, y el cajero reintenta o cobra por fuera.
- **Corrección sugerida** (tres líneas, sin tocar el orden de validación): en
  `assert_payable`, distinguir el caso pagado antes del genérico —
  `if order.status == OrderStatus.PAID or order.paid_at is not None: raise ConflictError("Esta comanda ya fue cobrada; consultá el comprobante", code="ORDER_ALREADY_PAID")`
  — y subir `SUB_ACCOUNT_ALREADY_PAID` a `ConflictError` para igualar `claim_payment:1578`.
- **Dueño**: `backend-comanda` (es su archivo; `assert_payable` y `claim_payment` son
  suyos por el contrato §2.3). `backend-cobro` sólo lo llama; su
  `tests/payments/test_concurrency.py` debería exigir el mismo código.
- **Estado**: el test queda **escrito y en rojo** a propósito. Es el único rojo de mi
  territorio; con la corrección de arriba pasa a verde sin tocar el test.

### A-10 (advertencia) — El frontend deriva y muestra «Total a cobrar» (venta + propina), con `?? 0` sobre plata

- **Dónde**: `frontend/src/features/payments/PaymentTargetPanel.tsx:51`

  ```tsx
  const totalDue = (target.totals.total ?? 0) + (tip?.amount ?? 0);
  ```

  y se muestra en `:63` como «Total a cobrar: {formatCOP(totalDue)}».
- **Qué regla roza**: `CONTRATO-INTERNO-1b-1.md §6.1` («el frontend NUNCA calcula… los
  pinta tal como llegan; lo único que puede sumar es lo tecleado en los `splits`») y
  `AGENTS.md` / `docs/ESTADO.md` («una sola matemática en el backend; **`null` no es
  0**»). El contrato enumera lo prohibido y «venta + propina» no está en la lista, por
  eso es advertencia y no bloqueante — pero es el único número de plata que el POS
  arma por su cuenta y que el cliente ve.
- **Riesgo concreto**: `?? 0` convierte un `total` ausente en `$0`. Con la convención
  del proyecto (todo campo nuevo de respuesta es **opcional** en los tipos `Out`), un
  `OrderOut` sin `totals.total` —una comanda recién creada, un `409` mal manejado—
  pinta «Total a cobrar: $0» y la tabla de pagos acepta `0` sin decir nada; el backend
  la frena después con `SPLITS_DO_NOT_MATCH`, así que no hay pérdida de plata, pero sí
  un número falso en pantalla, que es exactamente lo que §11.13 quiere evitar.
- **Corrección sugerida**: que el backend devuelva el monto a cobrar ya sumado (en
  `PreBillOut`/`SubAccountOut`, junto a `tip`), o mostrar dos líneas («Venta $X» /
  «Propina $Y») sin sumarlas; y no usar `?? 0` sobre un campo de plata: si falta,
  `formatCOP(null)` ya muestra «—».
- **Dueño**: `frontend-cobro` (decisión de pantalla) + `backend-cobro` si se decide
  mandarlo del servidor. **Decisión del dueño de la spec** si se prefiere dejarlo.

### A-11 (advertencia) — Leyenda legal escrita a mano como respaldo en el cobro

- **Dónde**: `frontend/src/features/payments/CheckoutPage.tsx:197`

  ```tsx
  const legend = preBill?.legend ?? "NO ES FACTURA — documento informativo";
  ```

- **Qué regla roza**: SPEC §3.3 («la precuenta… con la leyenda "NO ES FACTURA —
  documento informativo" — la SIC reprochó las "prefacturas" en 2022») y §8.3
  (representación gráfica y leyendas las define el emisor). El texto legal vive en el
  backend (`app/orders/schemas.py:270`); duplicado en el frontend, una corrección legal
  exige desplegar las dos mitades, y mientras tanto el POS afirma algo que el servidor
  no dijo.
- **Riesgo concreto**: el bloque que lo usa se renderiza cuando `pos.pre_bill` está
  encendida **aunque `preBill` sea `null`** (mientras `bill/present` viaja o si falló):
  la pantalla muestra la leyenda de una precuenta que no se presentó.
- **Corrección sugerida**: mostrar la leyenda sólo cuando llega (`preBill?.legend`), sin
  respaldo. `DocumentPage.tsx:214` ya lo hace bien (`{doc.legend}`, sin alternativa).
- **Dueño**: `frontend-cobro`.
- **Estado**: tolerado con nombre en `frontend/src/audit/sales.test.ts` y con un test
  que verifica que **siga siendo un respaldo** (`legend ??`) y nunca la fuente.

### A-12 (advertencia) — `prorate` puede asignar a una línea más de lo que esa línea pesa

- **Dónde**: `backend/app/orders/money.py:34-56`.
- **Qué pasa**: el residuo del reparto se suma entero al peso mayor
  (`shares[max_index] += residual`), que es lo que manda el contrato §2.3. Con pesos
  grandes (pesos colombianos reales) el residuo es a lo sumo `n − 1` y nunca alcanza;
  con pesos diminutos sí: `prorate(9, [5, 1, 1, 1, 1, 1])` → `[9, 0, 0, 0, 0, 0]`, y
  esa línea quedaría con más descuento que bruto (`net` negativo, y
  `round_half_up` levantaría `ValueError` sobre un numerador negativo — un `500`).
- **Por qué no es bloqueante**: para llegar ahí toda la comanda tendría que quedar con
  menos pesos de saldo que líneas tiene (p. ej. seis líneas de $5 después de los
  descuentos de línea). El test de propiedad con 1.000 comandas de precios reales no lo
  alcanza nunca, y el router ya impide `item_discount > gross`.
- **Corrección sugerida**: tope por peso en `prorate` (`min(share, weight)`) repartiendo
  el sobrante hacia la siguiente línea con saldo, o un `assert` defensivo. Es una línea.
- **Dueño**: `backend-comanda`. Decisión menor del dueño de la spec si se prefiere dejar
  el comportamiento literal del contrato.

### O-1 (observación) — `Math.round` sobre el valor tecleado en el diálogo de descuento

- **Dónde**: `frontend/src/features/orders/DiscountDialog.tsx:62`.
- `onConfirm(kind, Math.round(numericValue), ...)`: redondea en silencio lo que la
  persona escribió (un `10,6 %` se manda como `11 %`). No deriva plata del servidor,
  así que no viola §11.13, pero el operador no ve que su número cambió. Mejor: restringir
  el campo a enteros y rechazar el resto con el mensaje de siempre.
- **Dueño**: `frontend-comanda`.

### O-2 (observación) — El auditor de 1a reportaba `archivo:línea` corridos

- **Dónde**: `frontend/src/audit/security.test.ts:63-68` (`stripComments` reemplaza un
  bloque `/* … */` por **un espacio**, colapsando sus saltos de línea).
- Consecuencia: el número de línea que ese archivo reporta en un hallazgo no coincide
  con el archivo real cuando hay comentarios de bloque arriba — y el número de línea es
  lo único que un hallazgo tiene que entregar bien. En
  `frontend/src/audit/sales.test.ts` lo corregí (se reemplaza cada carácter del bloque
  por un espacio, conservando los saltos). Vale la pena traer la misma corrección a
  `security.test.ts`.
- **Dueño**: mío en una ronda 2, o de quien toque ese archivo. No lo cambié ahora
  porque no hay ningún hallazgo abierto que dependa de él.

### O-3 (observación) — `SUB_ACCOUNT_ALREADY_PAID` aparece con dos estados distintos según el camino

- `app/orders/service.py:1564` lo emite como `400` y `app/orders/service.py:1578` como
  `409` (`ConflictError`). Aunque se corrija B-1, conviene dejar **un solo** estado por
  código: un `code` que a veces es 400 y a veces 409 obliga al frontend a ramificar por
  las dos cosas. Mismo dueño y misma corrección que B-1.

### Lo que verifiqué y **no** dio hallazgo (vale registrarlo)

- La matemática de la venta: 1.000 comandas aleatorias con semilla fija, cinco
  identidades, cero fallos. Y las mismas cifras en las tres representaciones
  (`OrderOut`, precuenta, documento).
- Consecutivo: 100 ventas → 1..100; tres rechazos `400` no consumen número; reimprimir
  no toca nada más que los contadores.
- Concurrencia de cobro: una venta, un pago, un documento (el código del rechazo es
  B-1, la plata está bien).
- Aislamiento: `404` en las cinco rutas nuevas, por sede y por organización, en lectura
  y en escritura; `GET /documents/last` y `GET /kitchen/rounds` también se acotan.
- Privacidad: A-7 y A-9 cerrados de verdad (ver §4).
- Costos: ninguna de las nueve respuestas de dispositivo ni el OpenAPI de
  `/orders`, `/tables`, `/kitchen`, `/documents`, `/admin/orders` y `/admin/documents`
  declara `cost`, `margin`, `unit_cost` ni `recipe_version`.
- Migraciones: `0004` y `0005` al día con los modelos, índice parcial correcto,
  `downgrade base` limpio.

---

## 4. Inventario de datos sensibles nuevos de 1b-1 — quién los ve y veredicto

| Dato | Dónde vive | Quién lo ve | Base legal / finalidad | Veredicto |
|---|---|---|---|---|
| **Nombre de quien pide para llevar** (`orders.takeout_customer_name`) | fila `orders`, `OrderOut.takeout` | dispositivo de **su** sede (persona opcional), admin de la organización en `GET /admin/orders/{id}` | Finalidad declarada y acotada: llamar cuando el pedido está listo (§3.3). No entra al documento fiscal ni al listado exportable | **Correcto.** Verificado por `test_the_takeout_customer_data_travels_only_where_it_is_needed`. Queda para 1b-2 definir la retención (hoy vive para siempre en la comanda) |
| **Teléfono de para llevar** (`orders.takeout_phone`) | idem | idem | idem | **Correcto**, con la misma reserva de retención. No aparece en `GET /documents/{id}` ni en `GET /admin/orders` (que acepta `format=csv`) |
| **`consumed_by` del consumo de personal** (`consumed_by_employee_id` + `_name`) | fila `orders`, `OrderOut.consumed_by` | dispositivo de su sede, admin | Dato de empleado bajo el mismo régimen (§8.4, «datos de empleados… bajo el mismo régimen»); finalidad: reportar el consumo por empleado y mes (§3.3) | **Correcto y necesario.** Sin él, el consumo de personal no se puede reportar. El nombre congelado es atribución, no dato de más |
| **Lista de personal del dispositivo** (`GET /device/employees`) | respuesta, no se persiste | cualquier dispositivo **activado** de la sede, sin persona identificada | Minimización estricta: `{id, name, role}` y nada más | **Correcto.** Exactamente tres campos, sin inactivos, sin personal de otra sede, `401` sin dispositivo. Es el punto más expuesto del sistema (tablet compartida en el mostrador) y es el que mejor quedó |
| **Documento y correo de empleados** en la auditoría | ya **no** se copian a `audit_log.before/after` | admin en `GET /admin/employees` (maestro) | A-7 resuelto: la finalidad de la auditoría es el cambio, no el dato personal | **Correcto.** El dato no se pierde, deja de replicarse en un registro que se conserva años y se exporta |
| **Líneas del documento** (`fiscal_documents.lines`, `payments_snapshot`, `store_snapshot`) | fila `fiscal_documents` | dispositivo de su sede y admin, vía `GET /documents/{id}` | Evidencia fiscal: inmutable y conservable 5 años (§8.3) | **Correcto.** No contienen datos del cliente (adquirente «consumidor final», tipo 13, 222222222222) ni costos. La captura de cliente es 1b-2, y con ella llega el consentimiento (§8.4) |
| **Quién cobró / quién atendió** (`charged_by_*`, `served_by_name`) en el documento | fila `fiscal_documents`, impreso | quien tenga el comprobante en la mano | §8.3 pide «quién atendió y quién cobró» en la representación gráfica | **Correcto por norma**, con una nota para el dueño de la spec: se imprime el **nombre** del empleado en un papel que se lleva el cliente. Es lo que la norma pide; si se quisiera minimizar, sólo cabría un identificador corto, y habría que verificarlo con el contador |
| **PIN, hash de PIN, contraseña** | `employees` | nadie, en ninguna respuesta | — | **Correcto**, cubierto desde 1a y re-verificado |
| **`discount_limit_pct` / `can_charge`** | `employees` | sólo admin | No es dato personal pero sí el mapa de quién autoriza qué | **Correcto**: fuera de `GET /device/employees`. Exponerlo sería decirle a cualquiera en el mostrador a quién conviene pedirle el PIN |

Dato nuevo **sin** riesgo de privacidad pero que conviene anotar: `waste_stubs` guarda
`employee_id` y `authorized_by_*` de cada anulación de ítem enviado. Es atribución
esperada por §3.5 (reporte de anulaciones por persona); no es dato personal de más.

---

## 5. Decisiones que quedan para el dueño de la spec

1. **A-10** (`totalDue` en el frontend): ¿el backend devuelve el monto a cobrar
   (venta + propina) o la pantalla muestra dos líneas sin sumarlas? Hoy el POS es el
   único que arma ese número y el cliente lo ve.
2. **A-12** (`prorate` con residuo mayor que el peso mayor): ¿se deja el
   comportamiento literal del contrato §2.3 o se agrega el tope por peso? Es un caso
   inalcanzable con precios reales, y por eso es una decisión, no un bug.
3. **Nombre del empleado impreso en el comprobante** (§8.3 lo pide). Confirmar con el
   contador que basta con el nombre y que no hay que ofrecer una alternativa
   (identificador corto) para restaurantes que no quieran imprimirlo.
4. **Retención de los datos de para llevar**: hoy el nombre y el teléfono viven para
   siempre en la fila `orders`. §8.4 exige finalidad, no plazo, pero un plazo
   («se anonimizan a los N días») es lo que convierte la minimización en algo
   verificable. Encaja naturalmente con el `customers/{id}/erase` de 1b-2.
5. **Cortesía y consumo de personal bajo IVA**: §8.2 declara la interpretación propia
   («sin precio, no generan base bajo INC») y el propio texto pide verificarla con el
   contador, señalando que **bajo IVA puede ser retiro de inventarios gravado (art. 421
   ET)**. Hoy `staff_meal` fuerza `tax_rate = 0` para todas las sedes, incluidas las de
   IVA 19 % (franquicias). Mi test lo prueba **tal como está declarado**; si el contador
   dice otra cosa, cambia la regla y cambia el test.
6. Sigue abierto de 1a, sin cambios en 1b-1: **A-1** (sin tope de intentos en
   `POST /auth/authorize`), **A-2** (`JWT_SECRET` sin guardia de producción), **A-4**,
   **A-6**, **A-8**. A-1 se vuelve más relevante en 1b-1: ahora hay cinco acciones
   autorizables y el POS las pide muchas más veces por turno.

---

## 6. Lo que no se pudo verificar en este entorno

- **Postgres real.** Todo corrió en SQLite. Quedan sin probar aquí: el
  `SELECT … FOR UPDATE` de `app/fiscal/service.py:reserve_next_number` (SQLite lo
  ignora y serializa por el lock de escritura, así que el invariante del consecutivo
  se verifica, pero **no el mecanismo** que lo protegerá en producción); el
  comportamiento real de los índices únicos parciales con `postgresql_where`; y qué
  código exacto devuelve una carrera cuando dos transacciones sí se solapan (en SQLite
  la segunda siempre llega después de la primera). **El CI con Postgres 16 es el único
  que puede cerrar esto**, y es donde B-1 podría mostrarse distinto: allí la perdedora
  sí puede llegar a `claim_payment` y recibir el `409` correcto — por eso B-1 se
  verifica también sin hilos, para que no dependa de la temporización.
- **Una carrera de cobro con tres o más dispositivos**: probada con dos.
- **La impresión real** (`window.print()`, CSS `@media print` a 58/72/80 mm): se audita
  por inspección de fuente, no por render.
- **Accesibilidad** de las pantallas nuevas más allá de lo que cada frontend verificó
  con Testing Library.
- **La suite completa y el build**: por contrato los corre una sola vez la verificación
  final del Maestro, con el árbol quieto.

---

## 7. Comandos de verificación y resultados literales

### Backend (solo `tests/audit`)

```
mkdir -p /tmp/pt-auditor-venta
cd backend && TMPDIR=/tmp/pt-auditor-venta timeout 900 python -m pytest tests/audit -q
```

```
=========================== short test summary info ============================
FAILED tests/audit/test_fiscal_invariants.py::test_a_payment_on_an_already_paid_order_or_sub_account_is_a_409_already_paid
1 failed, 95 passed, 176 warnings in 284.60s (0:04:44)
```

**El único rojo es el hallazgo B-1**, escrito a propósito (§3). Los otros 95
invariantes pasan: 35 de caja (incluidos los seis de O-1), 11 de venta, 8 de
comprobante menos el rojo, 36 de identidad/aislamiento/privacidad y 6 de
migraciones.

Por archivo, corridos también uno por uno mientras los escribía:

```
tests/audit/test_sales_invariants.py      11 passed in 28.93s
tests/audit/test_fiscal_invariants.py      7 passed, 1 failed in 53.94s
tests/audit/test_migration_invariants.py   6 passed in 1.79s
```

Estado de partida, para que se vea qué invirtió O-1: **antes** de tocar nada,
`tests/audit` daba `8 failed, 50 passed` — los ocho fallos eran los invariantes de 1a
que afirmaban que el responsable de caja ve el esperado, exactamente lo que O-1
resolvió al revés (cinco de ellos indirectamente, por la fixture `expected_of`).

Nota: el `--timeout 900` del comando del pedido no existe en este entorno (no está
instalado `pytest-timeout`); el propio comando trae la alternativa con `timeout 900`,
que es la que usé:

```
cd backend && TMPDIR=/tmp/pt-auditor-venta python -m pytest tests/audit -q --timeout 900
ERROR: usage: python -m pytest [options] [file_or_dir] ...
python -m pytest: error: unrecognized arguments: --timeout 900
```

### Frontend (solo `src/audit`)

```
cd frontend && npx vitest run src/audit
```

```
 RUN  v5.0.0 /home/user/restaurante-sistema/frontend

 Test Files  2 passed (2)
      Tests  20 passed (20)
   Duration  335ms
```

### Typecheck del frontend

```
cd frontend && npm run typecheck
> tsc --noEmit -p tsconfig.app.json
```

Sin salida: limpio.

### Comprobación de que el auditor no da un verde falso

Los patrones de `frontend/src/audit/sales.test.ts` se verificaron vaciando la lista
`ALLOWED` a mano: con la lista vacía el test encuentra las tres líneas reales de
aritmética sobre plata y las cuatro de redondeo, con el `archivo:línea` correcto
(`features/payments/PaymentTargetPanel.tsx:51`,
`features/payments/PaymentSplitsForm.tsx:95`,
`features/orders/DiscountDialog.tsx:62`, `features/orders/lib.ts:14,19,21`). Con la
lista puesta, cero. Un auditor que no se prueba contra sí mismo no prueba nada.

No corrí: la suite completa de backend, `npm run build`, `alembic upgrade head` sobre
`dev.db` del repo, ni tests de territorio ajeno. Las migraciones se prueban sobre un
SQLite nuevo bajo el `tmp_path` del test, que respeta `TMPDIR`.

---

## 8. Gaps (tests escritos que esperan algo que no depende de mí)

1. **`test_a_payment_on_an_already_paid_order_or_sub_account_is_a_409_already_paid` está
   en rojo** y lo seguirá estando hasta que se aplique la corrección de B-1
   (`backend-comanda`, `app/orders/service.py:1555` y `:1563`). Es un hallazgo, no un
   gap de módulo ausente: el código existe y contradice el contrato.
2. **`with_for_update` sin Postgres**: el invariante del consecutivo está probado; el
   mecanismo que lo protege en producción, no. Queda para el CI.
3. **No audité `app/orders/hooks.py` de punta a punta** (`count_open_orders`,
   `detach_open_orders`, `adopt_transferred_orders`): el contrato §2.5 le da el test
   E2E a `backend-base` (`tests/shifts/test_open_orders_gate.py`). Sí verifico su
   efecto visible en el error `OPEN_ORDERS_EXIST` con `open_orders: 1`.
4. **No audité los totales del turno de punta a punta contra el cierre**
   (`get_sales_totals` → `expected`): el contrato §2.5 se lo da a `backend-base`
   (`tests/shifts/test_sales_totals_e2e.py`). Sí verifico que la venta y la propina
   caen en `sales.*`/`tips.*` por medio de pago.
5. **Cocina**: sólo audito que `GET /kitchen/rounds` respeta la flag, el aislamiento y
   que no filtra costos. El semáforo, `target_minutes` y el orden por `sent_at` son de
   `backend-comanda` (`tests/kitchen/`).
6. **Frontend**: la auditoría es por inspección de fuente, como manda el pedido. No
   monto pantallas: los tests de render son de `frontend-comanda` y `frontend-cobro`.
7. **`security.test.ts` de 1a sigue con el `stripComments` que corre los números de
   línea** (O-2). No lo toqué para no mezclar una corrección de estilo con los
   hallazgos de este pedido.
8. **Retención y anonimización** de los datos de para llevar: no hay nada que auditar
   todavía porque la regla no existe (§5, punto 4).
9. **El árbol se movía mientras auditaba.** `frontend-comanda` y `frontend-cobro`
   seguían escribiendo cuando corrí `frontend/src/audit`, y esa auditoría es por
   inspección de fuente: una línea de aritmética sobre plata agregada después de mi
   última corrida no la vio nadie. `npx vitest run src/audit` en la verificación final
   —con el árbol quieto— es lo que cierra esto, y por eso los patrones están escritos
   para fallar con `archivo:línea` en vez de para pasar.
10. **Mi propio territorio depende de fixtures ajenas** (`race_env`, `open_shift`,
    `set_feature`, `clock`, `idem` de `tests/conftest.py`, de `backend-base`). Estaban
    todas al empezar (`grep -n race_env backend/tests/conftest.py` → líneas 424, 426,
    491, 506, 664); no tuve que escribir nada contra el contrato a ciegas.
