# Auditor fiscal, contable y de privacidad — pedido 1b-2

Rol: **Contador + Legal del equipo**. Convierto las reglas de plata,
consecutivo, concurrencia, inmutabilidad y privacidad en **tests ejecutables**
en territorio propio (`backend/tests/audit/**`, `frontend/src/audit/**`) y
reporto lo que falla con archivo:línea, reproducción y severidad. **No arreglo
código ajeno.**

Fuentes vinculantes: `docs/SPEC-NEGOCIO.md` (§1.1, §2, §3.1, §3.4, §3.5, §6.1,
§6.2, §6.3, §8.2, §8.3, §8.4, §9.3, §10, §11 y §12), `features/fase-1b-venta/spec.md`
(contrato de API y **checklist de entrega**, que es vinculante), `AGENTS.md`,
`docs/ESTADO.md`, `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md` §2 a §6,
`outputs-1b-1/auditor-venta.md` (mi propio antecedente: A-10, A-11, A-12, O-1,
O-2) y los cinco entregables de mis compañeros en `outputs-1b-2/`
(`backend-fiscal`, `backend-clientes-dinero`, `backend-reportes`,
`frontend-fiscal` y `frontend-admin`).

**Resumen en una línea (ronda 2, final):** la plata cierra, **el consecutivo
aguanta** —100 ventas, 3 notas y 2 rechazos del `FakeProvider` dejan las dos
series completas (POS 1..100 y NA 1..3), sin huecos, sin saltos, sin repetidos,
y un rechazo no libera el número— y **los tres bloqueantes están CERRADOS**:
`146 passed, 0 failed` en `tests/audit`, con los tres tests que estaban en rojo
a propósito pasando **sin que se tocara una sola de sus aserciones**. Queda
deuda declarada (A-10 parcial, A-1, A-3, O-1..O-4), ninguna de ella plata que
se pierda ni dato personal que sobreviva.

> **Resumen de la ronda 1 (para leer el histórico):** la plata cerraba y el
> consecutivo aguantaba, pero había **tres hallazgos bloqueantes**, dos de
> privacidad: el `erase` copiaba al registro de auditoría exactamente los datos
> que el titular pidió suprimir (**B-1**), cobrar con datos de cliente teniendo
> `customers` apagada dejaba la comanda `paid` sin documento y sin pago —la
> venta se perdía entera (**B-2**)—, y el documento en contingencia vencido a
> las 48 h no llegaba a «Requiere tu atención» de Hoy (**B-3**). Los tres están
> verificados como cerrados en **§8 (Ronda 2)**.

### Dos correcciones al Conciliador que NO deben volver a viajar como bloqueantes

Se repiten acá, arriba de todo, porque en la ronda 1 dos entregables las
declararon como bloqueantes sin dueño y **ya estaban resueltas** (era mi
observación O-3). Reverificadas en la ronda 2 con el árbol quieto:

| Supuesto bloqueante | Realidad verificada | Evidencia |
|---|---|---|
| «`app.customers` / `app.refunds` no están en `DOMAINS` ni en `MODEL_MODULES`» | **Ya están**, y también `reports` | `backend/app/main.py:29-33` (`"fiscal"`, `"customers"`, `"refunds"`, `"reports"`) y `backend/app/core/models_registry.py:25-28` (mismos cuatro). Las rutas de clientes y devoluciones se montan y responden: mis 13 invariantes de privacidad y los 9 de notas/devoluciones las usan por HTTP |
| «`TAX_RATE_BY_CODE` sigue declarada localmente en `app/orders/service.py`» | **Ya está centralizada** | `backend/app/core/tax.py:27` la define y expone `rate_for_code`; `backend/app/orders/service.py:34` la **importa** (`from app.core.tax import TAX_RATE_BY_CODE`) y la usa en `:792` y `:870`. No queda ninguna copia local |

**Nota de nombres**: los tests que el Conciliador citó para B-2 y B-3 no existen
en el árbol. Los nombres reales de los tres, que son los que hay que mirar, son
los de **§8.1**.

---

## 1. Qué cambió en mi territorio

| Archivo | Qué |
|---|---|
| `backend/tests/audit/conftest.py` | `seed_fiscal_ranges` + fixture **autouse** `fiscal_ranges` (cobrar ahora exige un rango DIAN vigente: sin esto, los 96 invariantes de 1b-1 daban `400 NO_FISCAL_RANGE`), `seed_race_fiscal_range` para la base propia de `race_env`, y `RANGE_PREFIX` (un prefijo por tipo, para poder auditar que la nota no toma números de la serie de la venta) |
| `backend/tests/audit/test_fiscal_invariants.py` | reescrito para 1b-2: **8 → 18** invariantes. El de las 100 ventas pasa a ser el ítem literal del checklist (100 ventas + 3 notas + 2 rechazos); el consecutivo se lee ahora de `FiscalRange`, no de `FiscalCounter`; se reemplaza el «ningún documento trae evidencia DIAN» de 1b-1 (obsoleto por diseño) y se agregan rango, alertas, proveedor, contingencia con reloj simulado, factura por umbral UVT y `amount_due` |
| `backend/tests/audit/test_notes_refunds_invariants.py` | **nuevo** — 9 invariantes de nota (reversa sin editar, consecutivo propio, idempotencia, `NOTE_KIND_MISMATCH`, segunda nota) y de devolución (egreso en el turno abierto, devolución pendiente sin turno, `settle` en ESE turno, «de la mano del dueño», aislamiento) |
| `backend/tests/audit/test_privacy_invariants.py` | **nuevo** — 13 invariantes de habeas data (Ley 1581 de 2012): `erase` campo por campo contra el snapshot fiscal, idempotencia, prueba de consentimiento por cobro, revocación como fila nueva, «lo que es ley no es flag», minimización en el dispositivo, consumidor final sin datos, aislamiento. Dos estuvieron en rojo a propósito (B-1 y B-2) y **en la ronda 2 pasaron a verde solos**; la ronda 2 suma **3 contrapruebas** de esos cierres |
| `backend/tests/audit/test_reports_invariants.py` | **nuevo** — 12 invariantes de reportes: la propina fuera del `net` en las cuatro representaciones, prorrateo del impuesto por medio de pago, snapshots (la carta de hoy no revalora ayer), la nota que sale del período, `null ≠ 0`, aislamiento `404`, `format=csv` en los diez listados, cero campos de costo, propinas del turno como pasivo, reparto sin movimiento de caja. Uno estuvo en rojo a propósito (B-3) y **en la ronda 2 pasó a verde solo**; la ronda 2 suma **1 contraprueba** de ese cierre (dedupe + barrido perezoso que no se movió) |
| `backend/tests/audit/test_sales_invariants.py` | +1: **A-12** con test de propiedad (2.000 casos con residuos difíciles) más el caso exacto del hallazgo y el empate de pesos; se conserva el invariante del otro llamador de `prorate` |
| `backend/tests/audit/test_security_invariants.py` | +3: OpenAPI sin costos sobre **las doce rutas nuevas**, el dispositivo no alcanza ninguna ruta admin de 1b-2 (9 lecturas + 5 escrituras), y la forma única de error sobre los seis códigos nuevos |
| `backend/tests/audit/test_migration_invariants.py` | +2 y uno actualizado: la cadena llega a **`0007`** con las siete tablas nuevas; los `CHECK` del rango en la base; las dos FK reales del documento (`fiscal_range_id`, `reverses_document_id`) |
| `frontend/src/audit/fiscal.test.ts` | **nuevo** — 15 invariantes por inspección de fuente sobre Documentos fiscales, Rangos, Notas, Devoluciones pendientes, Clientes, Hoy y Ventas |
| `frontend/src/audit/sales.test.ts` | actualizado: **A-11 y O-1 cerrados** (se quitan sus tolerancias y se verifica el cierre), **A-10 reclasificado** (lo que se muestra ya no se deriva), y el redondeo de tiempo de `OrdersAdminPage` queda tolerado con verificación línea por línea de que sigue siendo tiempo |

Total tras la ronda 2: **146 invariantes ejecutables en backend** (35 de caja,
12 de venta, 18 de documento fiscal, 9 de notas y devoluciones, **13** de
privacidad, **12** de reportes, 39 de identidad/aislamiento/forma del error, 8
de migraciones) y **36 en frontend**, de los cuales **50 son nuevos de 1b-2** en
backend y **16** en frontend. Los **4 que suma la ronda 2** son contrapruebas
de los cierres B-1/B-2/B-3 (§8.2): no cubren reglas nuevas, cubren el riesgo
propio de una corrección —que el verde se haya conseguido quitando algo o
rompiendo el camino feliz.

**Nadie más tocó mi territorio.** Verificado con
`find backend/tests/audit frontend/src/audit -newermt "2026-09-15 18:54"`
(el minuto en que cerré la ronda 1): salida vacía. Los únicos cambios de la
ronda 2 en `backend/tests/audit/**` son los cuatro tests nuevos que agregué yo,
y las tres aserciones de B-1, B-2 y B-3 quedaron **literalmente intactas**.
`frontend/src/audit/**` no cambió en absoluto en la ronda 2.

---

## 2. Inventario de invariantes (`archivo::test → regla que prueba`)

### 2.1 `backend/tests/audit/test_fiscal_invariants.py` (18)

| Test | Regla |
|---|---|
| `test_the_series_survives_a_hundred_sales_three_notes_and_two_rejections` | **Checklist del pedido** + SPEC §8.3: 100 ventas (dos emitidas con `FakeProvider(outcome="reject")`) + 3 notas → POS 1..100 y NA 1..3, sin huecos ni repetidos, prefijos disjuntos, `FiscalRange.next_number` avanzado exactamente una vez por documento, y **los dos rechazados conservan su número** |
| `test_a_rejected_payment_does_not_consume_a_number` | §8.3 (reverso del anterior): tres cobros rechazados por validación (`SPLITS_DO_NOT_MATCH`, `PAYMENT_METHOD_INVALID`, `PIN_INVALID`) no mueven `FiscalRange.next_number`; el cobro bueno toma el número que quedó |
| `test_two_concurrent_payments_leave_one_sale_one_payment_and_one_document` | §3.4 sobre `race_env` (con su propio rango): exactamente un `201`, un `Payment`, un `FiscalDocument` |
| `test_a_payment_on_an_already_paid_order_or_sub_account_is_a_409_already_paid` | Contrato §4 (B-1 de 1b-1, ya corregido): `409 ORDER_ALREADY_PAID` y `409 SUB_ACCOUNT_ALREADY_PAID` |
| `test_replaying_the_same_idempotency_key_returns_the_same_document` | §11.9: misma clave → misma respuesta, un solo documento |
| `test_an_issued_document_is_immutable_and_reprinting_only_counts` | §8.3 y §3.4: reimprimir sólo suma `reprint_count` y una fila `document_reprints`; 17 campos intactos |
| `test_a_document_never_claims_evidence_the_provider_did_not_give_it` | §8.3: con `PendingTransmissionProvider` (el real de esta fase) el documento queda `pending`, **sin** CUDE ni QR, lo dice en su leyenda, y **sí** apunta a su rango (`fiscal_range_id` no nulo) — la representación impresa trae el rango con su vigencia |
| `test_with_the_electronic_document_off_it_is_an_internal_receipt_that_never_claims_otherwise` | Pedido 1b: con `fiscal.dee_pos` apagada → `internal_receipt`, `dian_status NULL`, consecutivo propio 1..3, leyenda que niega ser factura **y** documento equivalente |
| `test_charging_without_a_valid_range_is_a_400_that_names_the_corrective_action` | Pedido 1b-2: `400 NO_FISCAL_RANGE` (nunca `500`) con la acción correctiva, **y** la comanda no queda `paid`: cero documentos, cero pagos («un cobro que falla conserva la cuenta», §3.4) |
| `test_an_exhausted_range_is_also_a_400_and_a_new_range_continues_the_series` | §8.3: el consecutivo arranca en el «desde» del rango (900, 901); agotado → `400 FISCAL_RANGE_EXHAUSTED`; un rango nuevo sigue en su propio «desde» (1.000) sin reutilizar nada |
| `test_the_range_alerts_at_eighty_percent_consumed_and_not_before` | §8.3: `fiscal_range_low` al 80 % consumido — y **no** al 40 %, que sería ruido diario |
| `test_the_range_alerts_thirty_days_before_it_expires` | §8.3: la otra mitad de la alerta, por vigencia y sin consumo |
| `test_a_rejected_document_keeps_its_number_notifies_and_can_be_retried` | §8.3: el rechazo notifica `fiscal_rejected` (nivel crítico); reintentar con un proveedor que valida deja número, total y líneas idénticos y cambia estado, leyenda y evidencia (`cude`, `qr_url`, `validated_at`) |
| `test_a_contingency_document_prints_its_legend_and_fires_overdue_at_48_hours` | **Checklist**: leyenda de contingencia con la cita del art. 616-1 ET; **con reloj simulado**, a las 47 h `contingency_overdue=False` y sin alerta, a las 49 h `True` y una sola `fiscal_contingency_overdue` (dedupe verificado) |
| `test_the_legend_always_comes_from_the_server_and_follows_the_dian_state` | **A-11**, lado servidor: los cuatro estados (`pending`, `validated`, `rejected`, `contingency`) producen cuatro leyendas distintas y no vacías |
| `test_an_invoice_over_the_uvt_threshold_needs_an_identified_customer` | §8.3 y checklist: sobre `invoice_threshold_uvt × UVT` sin cliente → `400 CUSTOMER_REQUIRED_FOR_INVOICE`, sin emitir ni consumir número; con cliente → `invoice` con **su propio prefijo** (FE) |
| `test_with_fiscal_invoice_off_asking_for_an_invoice_is_a_feature_disabled` | §1.1: `fiscal.invoice` probada apagada (`400 FEATURE_DISABLED` nombrando la función) **y** encendida |
| `test_the_amount_due_is_summed_by_the_server_never_by_the_client` | **A-10**, lado servidor: `PaymentOut.amount_due = total + tip_amount`, siempre presente, con venta y propina todavía discriminadas |

### 2.2 `backend/tests/audit/test_notes_refunds_invariants.py` (9, nuevo)

| Test | Regla |
|---|---|
| `test_a_note_reverses_the_original_without_touching_a_single_field_of_it` | §8.3 y §11.3: **todos** los campos imprimibles del original idénticos antes y después; sólo `status` pasa a `reversed`; la nota **suma** los montos congelados, no recalcula |
| `test_a_note_takes_its_own_consecutive_and_never_a_number_of_the_sale_series` | §8.3: la nota arranca en 1 de SU serie, con otro prefijo, y la venta siguiente toma el 3 de la suya |
| `test_a_second_note_on_the_same_document_is_a_400_and_the_kind_has_to_match` | §8.3: `NOTE_KIND_MISMATCH` (nota crédito sobre documento equivalente) y `DOCUMENT_ALREADY_REVERSED` |
| `test_replaying_the_idempotency_key_of_a_note_does_not_issue_a_second_one` | §11.9: misma clave → misma nota, un solo consecutivo consumido |
| `test_a_cash_refund_with_an_open_shift_is_an_expense_in_that_shift` | §3.5: un `CashMovement(kind=expense, cause=refund)` **tipado** en el turno abierto, ninguna devolución pendiente |
| `test_a_note_without_an_open_shift_leaves_a_pending_refund_and_notifies` | **Checklist** y §6.3: devolución pendiente con monto, cliente congelado y autorizador; `notify("pending_refund")`; cero movimientos de caja; aparece en `GET /admin/pending-refunds` |
| `test_settling_from_a_shift_creates_the_expense_in_that_shift_and_never_in_the_original` | **Checklist** y §6.3: el egreso va al turno que salda; el turno cerrado conserva `expected_cash`/`counted_cash`/`difference` al peso; el esperado del turno que paga baja; saldar dos veces es `400 PENDING_REFUND_ALREADY_SETTLED` sin segundo egreso |
| `test_settling_from_the_owner_moves_no_cash_but_closes_the_pending_refund` | §6.3: «de la mano del dueño» no toca el cajón de ningún turno |
| `test_the_pending_refund_of_another_organization_is_a_404` | §1.1 y §11.19: `404` en lectura y en escritura |

### 2.3 `backend/tests/audit/test_privacy_invariants.py` (13, nuevo)

| Test | Regla |
|---|---|
| `test_erase_anonymizes_the_master_and_leaves_the_document_snapshot_field_by_field` | **Checklist** y §8.4 vs §8.3: el maestro pierde nombre, correo, dirección y documento; **todas** las columnas de `fiscal_documents` idénticas; el comprobante se sigue imprimiendo con el adquirente que tenía |
| `test_erase_is_idempotent_and_frees_the_document_number_for_a_new_person` | §8.4: la segunda supresión no pisa la fecha de la primera; el número de documento queda libre para una compra futura |
| `test_erase_does_not_leave_the_erased_data_in_the_audit_trail` | **B-1 — CERRADO en ronda 2** (estuvo en rojo a propósito). §8.4 + precedente A-7 de 1b-1: el dato suprimido no puede sobrevivir en `audit_logs` |
| `test_every_sale_with_customer_data_records_its_own_proof_of_consent` | §8.4: una prueba **por cobro** (finalidad `invoice`, texto, canal, fecha, quién la registró); el cliente se reutiliza por documento |
| `test_a_revoked_consent_is_a_new_row_and_never_edits_the_previous_proof` | §8.4: revocar es fila nueva y entra en la bitácora (`kind=revoke`) |
| `test_the_habeas_data_log_and_the_erase_survive_the_customers_feature_being_off` | `AGENTS.md`: «lo que es ley no es un flag» — `GET /admin/customers` es `400 FEATURE_DISABLED`, pero `requests` y `erase` siguen funcionando |
| `test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale` | **B-2 — CERRADO en ronda 2** (estuvo en rojo a propósito). §1.1 (el `400` es correcto) + §3.4 y `docs/ESTADO.md` («validar antes de escribir»): la comanda no puede quedar `paid` sin documento ni pago |
| `test_the_customer_master_is_never_reachable_from_a_device_session` | §8.4 minimización: el dispositivo no lee, no exporta y no escribe el maestro (3 lecturas + 2 escrituras) |
| `test_a_sale_to_consumidor_final_stores_no_personal_data_at_all` | §8.4 y §8.3: cero filas de `customers`/`customer_consents`; adquirente exactamente `13 / 222222222222 / Consumidor final`, sin correo ni dirección |
| `test_a_customer_of_another_organization_is_a_404_in_read_and_in_write` | §1.1: `404` en la bitácora, el `PATCH`, el consentimiento y el `erase` ajenos; el listado propio no lo muestra; el cliente vecino queda intacto |
| `test_the_erase_still_leaves_its_own_trail_after_the_pii_left_the_audit_log` | **Ronda 2, contraprueba de B-1.** §6.1 + §8.4: sacar la PII del `before` no autoriza a sacar la traza — exige **exactamente una** fila `audit_logs(entity="customer", action="erase")` con actor y motivo, **y** una fila `customer_data_requests(kind=erase)` con respuesta y fecha, legible por `GET /admin/customers/{id}/requests` |
| `test_charging_with_customer_data_while_the_feature_is_on_still_creates_master_consent_and_document` | **Ronda 2, contraprueba de B-2.** El gate nuevo no puede cortar con la flag encendida: maestro + consentimiento + documento + pago, con el snapshot del cliente dentro del documento (§8.3); y sin `customer` en el body no se crea ningún cliente de más |
| `test_a_staff_meal_behaves_the_same_with_and_without_customer_data_flag_on_or_off` | **Ronda 2, contraprueba de B-2 (el borde).** Las **4 combinaciones** (flag on/off × `customer` sí/no) sobre un `staff_meal`: siempre `201`, total 0, sin documento, sin pago y **sin una sola fila de PII** (§3.3, §8.2, §8.4 minimización) |

### 2.4 `backend/tests/audit/test_reports_invariants.py` (12, nuevo)

| Test | Regla |
|---|---|
| `test_the_tip_never_enters_net_gross_or_tax_of_any_report` | §6.2, §8.2, §10: la propina fuera de `gross`/`net`/`tax` en `GET /admin/today` (incluidas las ventas por hora), en `GET /admin/sales` (filas y total, y agrupado por medio) y en el informe del contador (`documents_total_*` y `totals_by_method`); presente y discriminada en `tips*` |
| `test_a_mixed_payment_never_gives_a_method_more_tax_than_its_own_share` | §8.2 + A-12 con plata real: Σ medios = documento, Σ impuesto = `tax_total`, y ningún medio con `tax > gross` |
| `test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale` | §11.2: subir el precio un 60 % y cambiar la tarifa y el nombre del producto no mueve ni «Hoy», ni «Ventas», ni el comprobante emitido |
| `test_a_note_takes_the_original_out_of_the_period_and_stands_on_its_own_line` | §10 y §8.2: el reversado sale de «ventas cobradas»; la nota tiene su propia fila (`notes_total_base`/`notes_total_tax`, `notes_count`), nunca neteada en silencio |
| `test_no_data_is_reported_as_null_and_never_as_zero` | §6.1 y §9.3: sin ventas, `avg_ticket`/`avg_per_cover` son `null`; sin turno abierto, `expected_cash` es `null` |
| `test_every_admin_report_of_another_organization_is_a_404` | §1.1 y §11.19: **once** rutas de admin con sede ajena en lectura + una escritura (cargar un rango en la sede del vecino) |
| `test_every_new_admin_list_exports_csv` | Pedido 1b-2: `format=csv` con `content-type: text/csv` en los **diez** listados nuevos |
| `test_no_report_ever_exposes_a_cost_or_a_margin` | `AGENTS.md` y §11.10: seis respuestas de reporte sin `cost`, `unit_cost`, `margin`, `food_cost`, `recipe_version` ni `theoretical_cost` |
| `test_the_shift_tips_are_a_fund_apart_and_the_electronic_ones_are_a_liability` | §6.2 (Ley 1935 de 2018): `cash_out` sólo efectivo, `electronic_liability` el resto, por persona; las ventas del turno y el reporte de ventas dicen lo mismo y ninguno incluye propina |
| `test_a_tip_payout_registers_who_got_what_and_never_invents_a_cash_movement` | §6.2 y §6.1 (llave anti doble conteo): el reparto queda con nombre congelado de quien lo recibió y de quien lo registró, **sin** crear un `CashMovement` |
| `test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it` | **B-3 — CERRADO en ronda 2** (estuvo en rojo a propósito). §8.3 y §9.3: el rechazo y la contingencia vencida a las 48 h (reloj simulado, `advance(hours=49)`) llegan solos a «Requiere tu atención» de Hoy |
| `test_the_contingency_sweep_does_not_duplicate_the_alert_nor_replace_the_lazy_one` | **Ronda 2, contraprueba de B-3.** Dos documentos en contingencia: antes de las 48 h no hay alerta; `GET /admin/fiscal/documents` **sigue** barriendo por su cuenta (el punto viejo se sumó, no se movió); entrar **dos veces** a `GET /admin/today` deja **2** notificaciones, una por documento, con `dedupe_key = fiscal_contingency_overdue:{document_id}`; y barrer no mueve el `dian_status` (§8.3: el documento emitido es inmutable) |

### 2.5 `backend/tests/audit/test_sales_invariants.py` (+1)

| Test | Regla |
|---|---|
| `test_prorating_never_gives_a_line_more_than_it_weighs` | **A-12 cerrado**: el caso exacto del hallazgo (`prorate(9,[5,1,1,1,1,1])`), el empate (`prorate(8,[3,3,3])`), **propiedad sobre 2.000 casos** con `amount <= Σ weights` (`0 <= share <= weight` y Σ exacta), y 500 casos con `amount > Σ weights` donde el contrato del otro llamador se conserva |

Los otros 11 siguen midiendo lo mismo que en 1b-1 (identidades de la venta
sobre 1.000 comandas, precuenta y documento, propina fuera del turno, división
por ítems e iguales, `staff_meal`, `kitchen.view` apagada, anulación de enviado,
**venta a las 00:30 en el día del turno** y **venta a las 10:00 sobre turno
pasado de la hora de corte sellada con hoy**).

### 2.6 `backend/tests/audit/test_security_invariants.py` (+3)

| Test | Regla |
|---|---|
| `test_the_openapi_of_the_new_1b2_routes_declares_no_cost_fields` | **Checklist**: el OpenAPI de `/admin/fiscal/**`, `/admin/notes`, `/admin/documents`, `/admin/customers/**`, `/admin/pending-refunds`, `/admin/today`, `/admin/sales`, `/admin/accountant-report`, `/admin/unavailable-log`, `/admin/tips`, `/device/payment-methods` y `/shifts` no declara ningún campo de costo |
| `test_a_device_session_never_reaches_the_new_admin_routes` | §2.2: 9 lecturas y 5 escrituras de admin desde un dispositivo → `401`/`403` con la forma de error de siempre |
| `test_every_new_business_error_of_1b2_has_exactly_one_shape` | §11.18 y §12: `FISCAL_RANGE_INVALID`, `NOTE_KIND_MISMATCH`, `NOTE_EMPTY`, `DOCUMENT_ALREADY_REVERSED` (nota y reintento), `NO_FISCAL_RANGE` y la validación de esquema, todos `400` con `{error:{code,message}}` y mensaje que nombra la acción correctiva. **Nunca `500`** |

### 2.7 `backend/tests/audit/test_migration_invariants.py` (+2, uno actualizado)

| Test | Regla |
|---|---|
| `test_the_chain_reaches_the_four_migrations_of_the_sale` | Cadena `0003 → 0007`; existen las nueve tablas de la comanda, las cinco del cobro y las **siete** de 1b-2 (`fiscal_ranges`, `customers`, `customer_consents`, `customer_data_requests`, `pending_refunds`, `tip_payouts`, `tip_payout_distributions`) |
| `test_the_numbering_range_is_defended_by_check_constraints_in_the_database` | §8.3: `fiscal_ranges` tiene las once columnas del contrato y los cuatro `CHECK` (`to >= from`, `next >= from`, `next <= to + 1`, vigencia no invertida) **en la base**, no sólo en Python |
| `test_the_note_points_at_the_document_it_reverses_and_the_range_that_numbered_it` | §8.3: `fiscal_range_id` es FK real a `fiscal_ranges` (era `Integer` pelado en 1b-1) y `reverses_document_id` es FK auto-referencial real; existen las seis columnas de evidencia |
| (sin cambios de intención) | tablas y columnas del DDL = las de los modelos; `downgrade base` deja la base limpia; índice único parcial de «una comanda abierta por mesa»; UNIQUE del consecutivo |

### 2.8 `frontend/src/audit/fiscal.test.ts` (15, nuevo)

| Test | Regla |
|---|---|
| `ninguna pantalla nueva hace aritmética sobre un campo de plata` | §11.13: nada de `+ - * /` sobre `gross`, `net`, `tax`, `tips`, `amount`, `avg_ticket`, `documents_base`… en Documentos, Rangos, Notas, Devoluciones, Clientes, Hoy y Ventas |
| `ninguna pantalla nueva redondea plata` | El redondeo a peso es de `app/orders/money.py::round_half_up` |
| `lo tolerado en RangesPage sigue siendo el avance del rango, nunca plata` | La única cuenta tolerada (`consumed / total`, días hasta vencer) no puede tocar un campo de plata |
| `«sin datos» no se dibuja como cero` | §9.3 y §6.1: `?? 0` prohibido sobre plata del servidor (una tolerancia enumerada, ver O-1) |
| `ninguna pantalla nueva escribe una leyenda legal a mano` | §8.3: la leyenda depende del estado DIAN → sólo el servidor la escribe |
| `la tolerancia de api/fiscal.ts son etiquetas de estado, no la leyenda impresa` | Cada línea tolerada tiene que ser una entrada de diccionario de etiqueta, y `DocumentPage` sigue imprimiendo `doc.legend` sin armarla con esas etiquetas |
| `el comprobante imprime la leyenda y el estado que llegan, sin inventar evidencia` | §8.3: `doc.legend` + `dian_status`; el CUDE y el QR nunca se arman en el cliente |
| `ninguna pantalla del POS importa ni llama el maestro de clientes` | §8.4: el operador no exporta clientes |
| `ninguna pantalla nueva guarda nada en el navegador` | §11.11: ni `localStorage`, ni `sessionStorage`, ni `indexedDB`, ni `document.cookie` |
| `la supresión de un cliente pide una confirmación explícita antes de disparar` | §8.4: `erase` es irreversible — exige motivo y confirmación |
| `ninguna pantalla nueva usa un color crudo` | §9.3 y WCAG AA: sólo tokens, que es lo que mantiene el contraste en claro y oscuro |
| `ningún Badge de estado se pinta sin texto` | WCAG 1.4.1: el estado nunca sólo por color |
| `toda tabla ancha del administrador viaja dentro de un contenedor con scroll propio` | Checklist: 375 px y 1024 px sin scroll horizontal del documento |
| `ninguna pantalla nueva fija un ancho que no entre en 375 px` | idem |
| `encuentra las pantallas de documento fiscal, clientes y reportes` | Guardia contra el falso verde |

### 2.9 `frontend/src/audit/sales.test.ts` (+1 y tres reescritos)

| Test | Regla |
|---|---|
| `**O-1 cerrado**: el diálogo de descuento ya no redondea en silencio lo tecleado` | O-1 de 1b-1: `Math.round` fuera, `Number.isInteger` con rechazo explícito |
| `**A-11 cerrado**: la precuenta ya no tiene leyenda de respaldo` | A-11: `preBill?.legend` sin `??` con texto |
| `ninguna pantalla escribe una leyenda legal a mano` (reescrito) | Se quitó la tolerancia de `CheckoutPage`: ya no hay ninguna |
| `ninguna pantalla de comanda o cobro redondea plata` (reescrito) | El redondeo tolerado de `OrdersAdminPage` se verifica línea por línea: tiene que seguir hablando de segundos o minutos |

---

## 3. Hallazgos

Severidades: **bloqueante** = viola una regla declarada (spec, `AGENTS.md`,
contrato); **advertencia** = riesgo real sin regla explícita que lo prohíba;
**observación** = deuda menor.

> **Estado tras la ronda 2: B-1, B-2 y B-3 están CERRADOS** (verificación
> campo por campo en **§8**). Se dejan escritos enteros porque el hallazgo es
> el que explica por qué el test existe, y porque el test que los prueba se
> queda en la suite para siempre. A-1, A-2 (A-10), A-3 y O-1..O-4 **siguen
> vivos** y se repiten tal cual.

### B-1 (bloqueante, **CERRADO en ronda 2**) — El `erase` de habeas data copia al registro de auditoría exactamente los datos que el titular pidió suprimir

- **Dónde**: `backend/app/customers/service.py:219-227` (el `before`) y
  `backend/app/customers/service.py:256-267` (el `record_audit`).

  ```python
  # :219
  before = {
      "name": customer.name,
      "email": customer.email,
      "address": customer.address,
      "municipality_dane": customer.municipality_dane,
      "doc_type": customer.doc_type,
      "doc_number": customer.doc_number,
      "dv": customer.dv,
  }
  ...
  # :256
  record_audit(..., entity="customer", action="erase", before=before, ...)
  ```

- **Qué regla viola**: `docs/SPEC-NEGOCIO.md §8.4` («Derechos del titular:
  consultar, rectificar, revocar autorización, **suprimir**. Suprimir anonimiza
  el maestro y conserva intacto el snapshot dentro de los **documentos
  fiscales** ya emitidos —no se puede borrar evidencia fiscal») declara **una
  sola** excepción a la supresión, y es el documento fiscal. `audit_logs` no es
  evidencia fiscal. Y el proyecto ya resolvió esta misma tensión en 1b-1 para
  los empleados: `docs/ESTADO.md` § «Qué está hecho» — «**A-7 resuelto por
  default**: `document` y `email` de empleados quedan fuera del `before`/`after`
  de `record_audit(entity="employee")`». La regla es la misma y acá es más
  fuerte, porque el titular **pidió expresamente** que se borraran.
- **Reproducción**
  (`tests/audit/test_privacy_invariants.py::test_erase_does_not_leave_the_erased_data_in_the_audit_trail`):
  1. Cobrar una venta con `customer: {doc_type:"31", doc_number:"901234567",
     name:"Carolina Restrepo Uribe", email:"carolina.restrepo@correo.test",
     address:"Calle 10 # 43-21 apto 502", …}`.
  2. `POST /api/v1/admin/customers/{id}/erase {"reason":"Solicitud de supresión del titular"}` → `200`.
  3. Leer `audit_logs` donde `entity="customer"`:
     `before = {"name": "Carolina Restrepo Uribe", "email": "carolina.restrepo@correo.test", "address": "Calle 10 # 43-21 apto 502", "doc_number": "901234567", …}`.
- **Por qué importa en la operación real**: la supresión no suprime. El dato
  sale del maestro (donde el negocio lo usaba) y queda en una bitácora que se
  conserva años, que el administrador consulta desde Admin → Historial y que se
  exporta. Frente a una queja ante la SIC, el establecimiento tendría que
  explicar por qué conserva el nombre, el correo y la dirección de alguien que
  ejerció su derecho de supresión — y la respuesta «para auditoría» no cubre la
  copia del dato, sólo el registro del hecho.
- **Corrección sugerida** (misma forma que A-7, y el `after` ya está bien):
  guardar en `before` sólo la existencia del dato, no su contenido —
  `{"had_email": customer.email is not None, "had_address": ..., "doc_type": customer.doc_type}`
  — y dejar el **quién / cuándo / por qué** donde ya está y donde §8.4 lo pide:
  la fila de `customer_data_requests` (que el test verifica que siga
  existiendo). La misma corrección aplica a `patch_customer:63-69`, donde el
  `before`/`after` de una rectificación copia nombre, correo y dirección.
- **Dueño**: `backend-clientes-dinero` (`app/customers/service.py` es su
  territorio).
- **Estado**: **CERRADO en la ronda 2** — `backend-clientes-dinero` aplicó la
  corrección sugerida tal cual y el test pasó a verde **sin que se tocara una
  sola de sus aserciones**. Verificación en **§8.1**.

### B-2 (bloqueante, **CERRADO en ronda 2**) — Cobrar con datos de cliente teniendo `customers` apagada deja la comanda `paid` sin documento y sin pago: la venta se pierde entera

- **Dónde**: el gate está bien, el orden no.
  - `backend/app/customers/hooks.py:91` —
    `features.assert_feature(db, organization_id, store_id, "customers")`,
    dentro de `upsert_customer_with_consent`.
  - `backend/app/payments/service.py:448` — `orders_service.claim_payment(...)`
    (el punto sin retorno).
  - `backend/app/payments/service.py:459` —
    `fiscal_service.resolve_customer_snapshot(...)`, que llama el gancho
    anterior **once líneas después** de `claim_payment`, ya en la fase de
    escritura y **fuera** del `SAVEPOINT` que protege `issue_document`
    (`:467-472`).
- **Qué regla viola**: `docs/SPEC-NEGOCIO.md §3.4` («La venta es **todo o
  nada** —comanda, pagos, documento, consumo, totales del turno, auditoría en
  una transacción—… Un cobro que falla **conserva la cuenta**») y
  `docs/ESTADO.md` § «Decisiones de implementación» («`get_db` hace **commit**
  también ante `AppError`… **Consecuencia: validar antes de escribir**»). Es
  literalmente el mismo defecto que `backend-fiscal` encontró y corrigió en la
  ruta de al lado para `NO_FISCAL_RANGE` (su entregable §5.1: agregó
  `assert_range_available` **antes** del punto sin retorno); acá quedó abierto
  el gemelo por la flag `customers`.
- **Reproducción**
  (`tests/audit/test_privacy_invariants.py::test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale`):
  1. `set_feature("customers", False)`; abrir turno; crear comanda `counter`
     con un ítem.
  2. `POST /api/v1/orders/{id}/payments` con `customer: {...}` →
     `400 {"error":{"code":"FEATURE_DISABLED","message":"…"}}` (correcto).
  3. `GET /api/v1/orders/{id}` → **`status: "paid"`**.
  4. `select count(*) from fiscal_documents` → `0`; `from payments` → `0`.
- **Por qué importa en la operación real**: el POS muestra el error, el cajero
  corrige y vuelve a tocar «Cobrar» — y recibe `409 ORDER_ALREADY_PAID` («Esta
  comanda ya fue cobrada; consultá el comprobante») sobre una comanda que nadie
  cobró y de la que no hay comprobante. La mesa queda liberada, el turno no vio
  el dinero, no hay documento fiscal y el efectivo entra al cajón sin respaldo:
  al cierre aparece un **sobrante sin causa**, que es exactamente el síntoma que
  §3.2 quiere que no exista. Se dispara con una configuración perfectamente
  legítima (una sede que no usa el maestro de clientes) más un operador que
  igual captura los datos para una factura.
- **Corrección sugerida**: en `pay_order`, antes del punto sin retorno (junto a
  `resolve_document_type_for_payment`, `:413`), exigir la flag cuando
  `payload.customer is not None` — `features.assert_feature(db, order.organization_id, store.id, "customers")`
  —, o publicar en `app.customers.hooks` un `assert_customers_enabled(db, ...)`
  puro que `pay_order` llame temprano, dejando el gate del gancho como
  respaldo. Es una línea, y no cambia el código ni el mensaje del error.
- **Dueño**: `backend-fiscal` (`app/payments/service.py` es su territorio y el
  orden de validación de `pay_order` ya lo reordenó dos veces) con
  `backend-clientes-dinero` si se prefiere el helper en `app/customers/hooks.py`.
- **Estado**: **CERRADO en la ronda 2** — `backend-fiscal` movió el gate a
  `app/payments/service.py:449-450`, antes del punto sin retorno, con la misma
  condición bajo la que se llega al gancho. Verificación y contrapruebas del
  camino feliz y del borde `staff_meal` en **§8.1**.

### B-3 (bloqueante, **CERRADO en ronda 2**) — El documento en contingencia vencido no llega a «Requiere tu atención»: el barrido sólo corre si alguien entra a la pantalla de documentos fiscales

- **Dónde**: los dos únicos llamadores del barrido son
  `backend/app/fiscal/service.py:986` (dentro de `admin_list_fiscal_documents`,
  o sea `GET /admin/fiscal/documents`) y `backend/app/fiscal/router.py:210`
  (`GET /admin/fiscal/export`). `backend/app/reports/service.py:478`
  (`today_report`) barre comandas viejas (`_sweep_stale_orders`) pero **no**
  llama `sweep_contingency_overdue`, y `TodayOut`
  (`backend/app/reports/schemas.py:69-91`) no tiene ningún campo de
  contingencia ni de rechazados: sus `alerts` son las notificaciones no leídas.
- **Qué regla viola**: `docs/SPEC-NEGOCIO.md §9.3`, tabla de **Hoy**: las
  alertas incluyen «…**documentos en contingencia o rechazados**, rango de
  numeración por agotarse, cierres sin revisar, devoluciones pendientes»; y
  §8.3: «el plazo legal es de **48 horas** (art. 616-1 ET); los vencidos
  aparecen en "**Requiere tu atención**"». El pedido lo repite: «pasadas 48 h
  dispara `fiscal_contingency_overdue`».
- **Reproducción**
  (`tests/audit/test_reports_invariants.py::test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it`):
  1. Cobrar con `FakeProvider(outcome="reject")` → `GET /admin/today` **sí**
     trae la alerta `fiscal_rejected` (esa mitad funciona: se notifica al
     emitir).
  2. Cobrar con `FakeProvider(outcome="contingency")` → documento
     `dian_status="contingency"`.
  3. `clock.advance(hours=49)`; `GET /admin/today` →
     `alerts` = `['fiscal_rejected']`. **No aparece
     `fiscal_contingency_overdue`.**
  4. Recién después de `GET /admin/fiscal/documents?store_id=…` la
     notificación existe y Hoy la muestra.
- **Por qué importa en la operación real**: el barrido perezoso es una decisión
  razonable (no hay scheduler, y así lo declaró `backend-fiscal` en su §4.5),
  pero **el punto donde se cuelga es el equivocado**. El dueño abre el sistema
  en «Hoy»; a la pantalla de Documentos fiscales entra cuando ya sospecha algo.
  Con el barrido sólo ahí, la alerta que existe para avisar que venció el plazo
  del art. 616-1 ET sólo aparece si el dueño ya fue a buscar el problema — y el
  documento sin transmitir se descubre cuando la DIAN pregunta (sanción del
  art. 657 ET: cierre del establecimiento).
- **Corrección sugerida**: llamar `sweep_contingency_overdue(db, store_id=store.id)`
  al entrar a `today_report` (`app/reports/service.py:478`), junto al
  `_sweep_stale_orders` que ya está ahí — es la misma clase de barrido
  perezoso, en la pantalla que sí se abre todos los días. Opcionalmente, sumar
  `contingency_count` / `rejected_count` a `TodayOut`, que es lo que §9.3 pide
  literalmente («documentos en contingencia o rechazados» como alerta, no sólo
  los vencidos).
- **Dueño**: `backend-reportes` (`app/reports/service.py` es su territorio; la
  función que tiene que llamar ya existe y es pública).
- **Estado**: **CERRADO en la ronda 2** — `backend-reportes` agregó
  `fiscal_service.sweep_contingency_overdue(db, store_id=store.id)` en
  `app/reports/service.py:520`, **antes** de `_recent_alerts`, sin replicar la
  consulta ni el umbral. Verificación (incluido el dedupe y que el barrido
  perezoso viejo no se movió) en **§8.1**.

### A-1 (advertencia) — La supresión no alcanza a `pending_refunds`: el nombre y el documento del titular sobreviven ahí y se exportan

- **Dónde**: `backend/app/refunds/hooks.py:135-150` congela
  `customer_name`/`customer_doc_number` en la fila de `pending_refunds`;
  `backend/app/customers/service.py::erase_customer` (`:198-269`) no los toca —
  por diseño, no importa ese modelo.
- **Qué regla roza**: §8.4 declara **una** excepción a la supresión (el
  snapshot del documento fiscal). `pending_refunds` no es un documento fiscal:
  es una cuenta por pagar operativa. `GET /admin/pending-refunds` la devuelve
  entera y acepta `format=csv`.
- **Reproducción** (verificada a mano, no dejé test porque no hay regla
  explícita que lo prohíba): cobrar con cliente identificado → cerrar el turno
  → emitir una nota con `refund {method:"cash"}` → `POST /admin/customers/{id}/erase`
  → `GET /admin/pending-refunds?store_id=1` devuelve
  `{"customer_name":"Carolina Restrepo Uribe","customer_doc_number":"901234567", …}`.
- **Por qué importa**: hay una tensión real y legítima (hay que saber a quién se
  le debe la plata para poder pagársela), pero hoy el dato sobrevive **también
  después de saldada** la devolución, sin plazo ni anonimización, en una tabla
  exportable. Es el mismo problema de retención que el auditor de 1b-1 ya
  señaló para los datos de para-llevar (§5, punto 4 de `auditor-venta.md`).
- **Corrección sugerida** (decisión del dueño de la spec): que `erase_customer`
  anonimice también las devoluciones **ya saldadas** del titular (dejando
  `document_id` como el puente hacia la evidencia fiscal, que sí es inmutable),
  y que declare por qué conserva las pendientes mientras lo estén. Es la misma
  regla que §8.4 aplica al maestro, extendida a la única tabla operativa que
  copia el dato.
- **Dueño**: `backend-clientes-dinero` (dueño de los dos modelos), con decisión
  previa del dueño de la spec.

### A-2 (advertencia) — A-10 quedó **parcialmente** saldado: lo que se muestra ya no se deriva, pero el objetivo del cobro sigue armándose en el cliente

- **Dónde**: `frontend/src/features/payments/PaymentTargetPanel.tsx:105`

  ```tsx
  totalDue={saleTotal + (tip?.amount ?? 0)}
  ```

- **Qué cambió y qué no**: lo que A-10 denunciaba —«Total a cobrar» pintado como
  `(totals.total ?? 0) + (tip?.amount ?? 0)`— **está cerrado**: la pantalla
  muestra venta y propina en dos líneas separadas, cada una tal como llega, y
  dice explícitamente cuando `totals.total` no llegó (verificado en
  `frontend/src/audit/sales.test.ts`). Lo que queda es el número que se le pasa
  a `PaymentSplitsForm` como objetivo interno, que **nunca se muestra** y que el
  backend vuelve a validar con `400 SPLITS_DO_NOT_MATCH`.
- **Por qué sigue abierto**: `PaymentOut.amount_due` (el campo que
  `backend-fiscal` agregó) sólo existe **después** de cobrar. Antes de cobrar,
  `PreBillOut`/`OrderOut.totals`/`SubAccountOut.totals` no traen el monto ya
  sumado, así que el cliente no tiene de dónde leerlo. Los dos entregables lo
  declaran como gap sin dueño (`backend-fiscal.md §7.9`, `frontend-fiscal.md §6.2`):
  `app/orders/schemas.py` no estuvo en el territorio de nadie en 1b-2.
- **Corrección sugerida**: `amount_due` en `PreBillOut` y en
  `OrderOut.totals`/`SubAccountOut.totals`, y `PaymentTargetPanel` pasándolo tal
  cual. Una línea de cada lado.
- **Dueño**: quien tenga `app/orders/schemas.py` en un pedido futuro, más
  `frontend-fiscal`.
- **Estado**: tolerado **con nombre** en `frontend/src/audit/sales.test.ts`
  (ALLOWED, entrada 3, con el motivo escrito).

### A-3 (advertencia) — `GET /admin/fiscal/documents` filtra por estado pero no por tipo, y la pantalla lo suple en el cliente

- **Dónde**: `backend/app/fiscal/router.py:129-141` (sólo `status` como query
  param) y `frontend/src/features/fiscal/DocumentsPage.tsx` (filtra por tipo
  sobre las filas ya traídas; declarado por `frontend-fiscal.md §6.6`).
- **Qué regla roza**: `features/fase-1b-venta/spec.md` pide
  `GET /admin/fiscal/documents?status=pending|contingency|rejected` — el tipo no
  está en el contrato literal, así que **no es un incumplimiento**; lo que sí es
  un riesgo es filtrar en el cliente una lista que hoy no tiene paginación: con
  un año de operación, «ver las notas crédito rechazadas» pide todos los
  documentos de la sede al navegador para descartarlos ahí.
- **Corrección sugerida**: agregar `document_type` como query param (el servicio
  ya filtra por `store_id` y `status`; es una línea) o declarar la paginación.
- **Dueño**: `backend-fiscal` + `frontend-fiscal`.

### O-1 (observación) — `?? 0` sobre un campo de plata en el gráfico de Ventas

- **Dónde**: `frontend/src/features/reports/SalesTab.tsx:101` y `:106` —
  `value: r.net ?? 0`.
- Hoy `SalesBucket.net` es obligatorio en el tipo (`src/api/reports.ts:47`), así
  que la rama nunca corre. Pero §12 del proyecto («despliegue desfasado: todo
  campo nuevo de respuesta es opcional en el cliente; "ausente" se dibuja
  distinto de "vacío" o "0"») y §9.3 («"sin datos" se dice, no se dibuja como
  cero») dicen justamente que ese `?? 0` es la costumbre que termina dibujando
  una barra en cero donde no hubo dato. Mejor: filtrar las filas sin `net` o
  marcarlas como hueco de la serie.
- **Dueño**: `frontend-fiscal` / quien tenga `features/reports`.
- **Estado**: tolerado con nombre en `frontend/src/audit/fiscal.test.ts`, con un
  tope (si crecen, deja de ser una excepción).

### O-2 (observación) — Tres `<button>` crudos en el POS de cobro no pasan por el primitivo `Button`

- **Dónde**: `frontend/src/features/payments/CheckoutPage.tsx:179`, `:233` y
  `:323`.
- Tienen `h-11` (los 44 px que pide §9.1) pero no heredan el
  `focus-visible:ring-*` tokenizado de `src/components/ui/button.tsx`: dependen
  del anillo por defecto del navegador. No es una violación —el foco se ve—,
  pero es el único lugar del POS donde el foco no está bajo el control del tema,
  y el checklist pide «foco visible» explícitamente. Viene de 1b-1.
- **Dueño**: `frontend-fiscal` / `frontend-cobro`.

### O-4 (observación) — Los filtros compartidos ya existen, pero fiscal y clientes siguen con su copia local

- **Dónde**: `frontend/src/components/DateRangeFilter.tsx` y
  `frontend/src/components/CsvExportButton.tsx` existen (los publicó
  `frontend-admin`, ver su §1), pero
  `frontend/src/features/fiscal/DocumentsPage.tsx:31`, `NotesPage.tsx:30`,
  `PendingRefundsPage.tsx:25`, `RangesPage.tsx:27` y
  `frontend/src/features/customers/CustomersPage.tsx` siguen importando
  `LocalDateRangeFilter`/`LocalCsvExportButton` de sus propios
  `features/*/components.tsx`.
- `frontend-fiscal.md §6.5` lo declaró como gap («comprobé con `ls` al empezar
  y de nuevo al cerrar: siguen sin estar publicados») y lo dejó preparado a
  propósito con **la misma forma de props**, para que el cambio sea una línea
  de import por pantalla. Ya se puede hacer: hoy hay tres implementaciones del
  mismo filtro de fechas, y un ajuste de accesibilidad en la compartida no
  alcanza a las pantallas fiscales.
- **Dueño**: `frontend-fiscal`.

### O-3 (observación) — El entregable de dos agentes declara como bloqueante algo que otro ya resolvió

- `backend-clientes-dinero.md §6` y `frontend-fiscal.md §6.1` declaran, como
  bloqueante sin dueño, que `app.customers`/`app.refunds` no están en
  `app.main.DOMAINS` ni en `app.core.models_registry.MODEL_MODULES`. **Ya
  están**: `backend/app/main.py:22-36` y
  `backend/app/core/models_registry.py:17-31` los incluyen (lo hizo
  `backend-reportes`, ver su §7). Verificado: las rutas de clientes y
  devoluciones se montan y responden (mis tests las usan por HTTP). Lo anoto
  para que el Conciliador no persiga un bloqueante que no existe.
- Lo que **sí** queda de ese hilo es real: `FiscalDocument.customer_id` sigue
  siendo `Integer` sin FK dura (`backend/app/fiscal/models.py:190-192`), con el
  motivo ya declarado. Ahora que `MODEL_MODULES` incluye `customers`, la
  migración de una línea que la convierte en FK real es posible; mi test de
  migraciones ya verifica las otras dos FK nuevas y aceptaría ésta sin cambios.

### Lo que verifiqué y **no** dio hallazgo

Ver §5.

---

## 4. Inventario de datos sensibles nuevos de 1b-2 — quién los ve y veredicto

| Dato | Dónde vive | Quién lo ve | Base legal / finalidad | Veredicto |
|---|---|---|---|---|
| **Tipo y número de documento del adquirente** (`customers.doc_type/doc_number`, `fiscal_documents.customer_doc_*`) | maestro + snapshot del documento | admin (maestro); quien tenga el comprobante (snapshot) | Obligación legal de facturar (§8.3, Res. DIAN 000165/2023): es el dato mínimo del adquirente | **Correcto.** Sólo se captura cuando hay factura o el cliente la pide; la venta a consumidor final no crea ninguna fila (probado). El snapshot es inmutable por art. 616-1 ET y el maestro se anonimiza a pedido |
| **Nombre o razón social** | idem | idem | idem | **Correcto**, mismo régimen |
| **Correo electrónico** (`customers.email`, `fiscal_documents.customer_email`) | idem | idem | §8.3: «correo para la **entrega**» de la factura electrónica | **Correcto con una reserva**: la finalidad declarada es la entrega del documento. Cualquier uso de marketing exige un consentimiento **separado**, y el sistema lo modela bien (`ConsentPurpose.marketing`, fila aparte, revocable). Verificado que el consentimiento de cobro se registra siempre con finalidad `invoice`, nunca `marketing` |
| **Dirección y municipio DANE** | idem | idem | §8.3: campos de la representación gráfica de la factura | **Correcto.** Opcionales; no se piden en la venta a consumidor final |
| **Dígito de verificación (`dv`)** | maestro | admin | Derivado del NIT; parte del dato fiscal | **Correcto.** Se borra en el `erase` |
| **Consentimientos** (`customer_consents`: finalidad, otorgado, canal, versión de texto, quién lo registró, cuándo) | tabla propia | admin | §8.4: «conservando la **prueba**» — es la prueba misma | **Correcto y necesario.** Una fila **por cobro** (no una sola para siempre) y la revocación como fila nueva: es la única forma de probar «hasta cuándo» hubo autorización. Sobrevive al `erase` por diseño, y **debe** sobrevivir: sin ella el establecimiento no puede probar que trató los datos con autorización |
| **Bitácora de habeas data** (`customer_data_requests`) | tabla propia | admin (`GET /admin/customers/{id}/requests`, **sin flag**) | §8.4: «Registro de solicitudes con fecha y respuesta» | **Correcto.** Accesible aunque `customers` esté apagada (probado): un derecho no se apaga con un interruptor comercial |
| **Copia del dato suprimido en `audit_logs`** | `audit_logs.before`/`after` de `entity="customer"` | admin, Admin → Historial, exportable | — | **CORREGIDO en la ronda 2 (era B-1).** Ya no hay copia: el `before` lleva sólo **nombres de campo** (`{"cleared_fields": ["name","email","address","municipality_dane","dv","doc_number"]}`, `app/customers/service.py:268-270`) y el `after` sólo los placeholders de anonimización. La rectificación (`patch_customer:117-118`) y la revocación (`:178`) quedaron igual. La traza del hecho sigue completa en `record_audit(action="erase")` con actor y motivo y en `customer_data_requests`, y eso lo fija un test propio (§8.1) |
| **Nombre y documento en `pending_refunds`** | `pending_refunds.customer_name/customer_doc_number` | admin (`GET /admin/pending-refunds`, con `format=csv`) | §6.3: «monto, **cliente**, documento, quién la autorizó» — para poder pagarle | **Aceptable mientras esté pendiente, discutible después — advertencia A-1.** Sobrevive al `erase` y no tiene plazo |
| **Propinas por persona** (`GET /shifts/{id}/tips.by_employee`, `activity.tips`, `tip_payout_distributions`) | respuesta + tablas | admin **y dispositivo** (`GET /shifts/{id}/tips` acepta `current_actor`) | §6.2: «recaudado por medio, por persona que atendió»; §8.4: «datos de empleados… bajo el mismo régimen» | **Correcto, con una nota para el dueño de la spec.** Es dato necesario para repartir (Ley 1935 de 2018 exige que el 100 % llegue al personal, y sin el detalle por persona no hay reparto verificable). Que el dispositivo lo vea es una decisión declarada por `backend-clientes-dinero` (§4.5) y la comparto: la propina no arma el cuadre de caja, así que no compromete el cierre a ciegas. Lo que conviene saber es que en una tablet compartida, cualquiera del turno ve cuánta propina generó cada compañero |
| **Quién autorizó una devolución / una nota** (`authorized_by_employee_*`, `charged_by_employee_*` de la nota) | `pending_refunds`, `fiscal_documents` | admin | §2.1: «Cuando una acción fue autorizada por otra persona, guarda `authorized_by`»; §3.5: reporte por autorizador | **Correcto y necesario.** Es atribución, no dato personal de más |
| **Clave técnica del rango** (`fiscal_ranges.technical_key`) | tabla propia | admin | §8.3: parte de la resolución DIAN | **Correcto**, pero **es un secreto del emisor**: sale en `GET /admin/fiscal/ranges` y en su CSV. Es admin-only y así lo exige el flujo de configuración; queda anotado para el día que exista el rol «contador de sólo lectura» (fase 2), que no debería verla |
| **Evidencia del documento** (`cude`, `qr_url`, `xml_ref`, `provider_response`, hash) | `fiscal_documents` | admin (`/evidence`, `/export`); el CUDE y el QR también en el comprobante impreso | §8.3: «Evidencia persistida por documento… **Conservación mínima 5 años**» | **Correcto.** Hoy siempre `NULL` con el proveedor real de esta fase, y el sistema **no** inventa ninguno (probado). El hash local del manifiesto cumple «no depender sólo del proveedor» |

Dato **sin** riesgo de privacidad pero que conviene anotar: el consecutivo y el
prefijo de cada documento son públicos por norma (van impresos); el que no puede
filtrarse es el **rango completo con su clave técnica**, y no lo hace.

---

## 5. Lo que verifiqué y **no** dio hallazgo

- **El consecutivo aguanta.** 100 ventas + 3 notas + 2 rechazos del
  `FakeProvider`: POS 1..100 y NA 1..3, sin huecos, sin saltos, sin repetidos;
  `FiscalRange.next_number` avanzó exactamente una vez por documento emitido;
  los dos documentos rechazados conservan su número. Tres rechazos de validación
  (`SPLITS_DO_NOT_MATCH`, `PAYMENT_METHOD_INVALID`, `PIN_INVALID`) no consumen
  ninguno.
- **El rango se respeta de punta a punta.** Sin rango: `400 NO_FISCAL_RANGE` con
  la acción correctiva y **sin dejar la comanda cobrada**. Agotado:
  `400 FISCAL_RANGE_EXHAUSTED`. El consecutivo arranca en el «desde» de la
  resolución (900, 901) y un rango nuevo sigue en el suyo (1.000). Nunca un
  `500`.
- **La contingencia funciona donde se la mira.** Leyenda con la cita del art.
  616-1 ET; `contingency_overdue` `False` a las 47 h y `True` a las 49 h; una
  sola notificación, deduplicada. Con reloj simulado, sin un `sleep` en ningún
  lado. (Lo que falla es **dónde** se dispara el barrido: B-3.)
- **El documento es inmutable.** Ni la nota ni el reintento de transmisión ni la
  reimpresión cambian un solo campo imprimible del original; la nota sólo pone
  `status="reversed"`; reimprimir suma el contador y una fila.
- **La plata de la devolución cae donde debe.** Con turno abierto, egreso
  `refund` tipado en ese turno; sin turno, devolución pendiente con
  notificación y cero movimientos; al saldar, el egreso entra al esperado del
  turno que paga (200.000 − 25.000) y el turno cerrado conserva
  `expected_cash`/`counted_cash`/`difference` al peso.
- **La propina nunca entra en el `net`** — verificado en las cuatro
  representaciones a la vez (Hoy incluidas las ventas por hora, Ventas agrupado
  y total, por medio de pago, e informe del contador incluido
  `totals_by_method`), y sí aparece discriminada en `tips*`.
- **Los reportes leen snapshots.** Subir el precio un 60 %, cambiar la tarifa y
  renombrar el producto no mueve ni un peso de «Hoy», «Ventas» ni del
  comprobante emitido.
- **`erase` no toca el documento.** Comparación **columna por columna** de
  `fiscal_documents` antes y después: idéntico. El maestro sí queda anonimizado
  y el número de documento vuelve a quedar libre.
- **Lo que es ley no es flag.** Con `customers` apagada, el listado es
  `400 FEATURE_DISABLED` pero `GET /admin/customers/{id}/requests` y
  `POST /admin/customers/{id}/erase` siguen funcionando.
- **Aislamiento.** `404` (nunca `403` ni `200`) en once rutas de reporte y
  fiscal con sede ajena, en el `POST` de rango sobre la sede del vecino, y en
  las cuatro rutas de cliente ajeno (lectura y escritura), con el maestro vecino
  intacto después.
- **Costos.** Ninguna de las seis respuestas de reporte ni el OpenAPI de las
  doce rutas nuevas declara `cost`, `unit_cost`, `margin`, `food_cost`,
  `recipe_version` ni `theoretical_cost`.
- **Forma del error.** Los seis códigos nuevos y la validación de esquema
  responden `400` con `{error:{code,message}}` y mensaje que nombra la acción
  correctiva. Ningún `500`.
- **`format=csv`** responde con `text/csv` en los diez listados nuevos.
- **Migraciones.** Cadena `0001 → 0007`, tablas y columnas del DDL idénticas a
  los modelos, `downgrade base` limpio, los cuatro `CHECK` del rango y las dos
  FK reales del documento presentes **en la base**.
- **Deuda de 1b-1.** **A-11 cerrada** (no queda ninguna leyenda escrita a mano
  en el frontend; la del servidor cambia con los cuatro estados DIAN). **A-12
  cerrada** (`prorate(9,[5,1,1,1,1,1])` → `[5,1,1,1,1,0]`; propiedad sobre
  2.000 casos; el otro llamador conserva su contrato). **O-1 cerrada**
  (`Math.round` fuera del diálogo de descuento, reemplazado por rechazo
  explícito del no-entero). **A-10 parcialmente** (ver A-2). **O-2 de 1b-1**
  (el `stripComments` que corría los números de línea) no se tocó en
  `security.test.ts`; los dos archivos nuevos usan la versión corregida.
- **`TAX_RATE_BY_CODE` centralizado** en `app/core/tax.py` (lo hizo
  `backend-reportes`); `app/orders/service.py` lo importa. Tres de los cuatro
  entregables lo declaran como gap abierto: ya no lo está.
- **`app.customers`/`app.refunds` montados** en `DOMAINS` y `MODEL_MODULES`
  (ver O-3): sus rutas responden por HTTP, y mis tests las usan así.

---

## 6. Gaps

1. ~~**Tres tests quedan en rojo a propósito** (B-1, B-2, B-3)~~ — **cerrado en
   la ronda 2**: los tres pasaron a verde con las correcciones de §3 aplicadas
   tal cual y **sin que se tocara una sola de sus aserciones**. Ver §8.
2. **Postgres real.** Todo corrió en SQLite. Siguen sin probarse aquí el
   `SELECT … FOR UPDATE` de `reserve_next_number` sobre `fiscal_ranges` (SQLite
   lo ignora y serializa por el lock de escritura: el **invariante** del
   consecutivo está probado, el **mecanismo** que lo protege en producción no),
   los índices únicos parciales con `postgresql_where`, y qué código exacto
   devuelve una carrera cuando dos transacciones se solapan de verdad. Es del
   CI con Postgres 16.
3. **La ventana de carrera entre `assert_range_available` y
   `reserve_next_number`** la declaró `backend-fiscal` y no la forcé: para
   alcanzarla haría falta agotar el rango entre las dos llamadas, lo que sólo
   se consigue manipulando la base a mano. Queda declarada, no probada.
4. **Dos notas concurrentes sobre el mismo documento**: probé la idempotencia
   (misma clave → una nota) y la segunda nota secuencial (`400`), pero no una
   carrera real con hilos sobre `race_env`. El `UNIQUE(target_key)` con
   `note:{id}` es el respaldo en la base; en Postgres debería dar `409`.
5. **`GET /admin/employees/{id}/activity` ampliado** (ventas, anulaciones,
   descuentos, cortesías, reimpresiones, propinas, `team_average`) lo audita su
   dueño `backend-clientes-dinero` en `tests/shifts/test_employee_activity.py`.
   Yo sólo verifico que no filtre costos y que respete el aislamiento.
6. **Los percentiles p50/p90 por estación y los tiempos de `GET /admin/orders`**
   los audita `backend-reportes` en `tests/orders/test_admin_times.py`. Yo sólo
   verifico el aislamiento, el CSV y la ausencia de costos.
7. **La heurística de «ventas perdidas» de `GET /admin/unavailable-log`** (media
   de 7 días de negocio valorizada al precio del momento del 86) es una
   estimación declarada por su autor, no un invariante contable: no la audito
   como número, sólo que no revalore con la carta actual y que diga `null` en
   vez de `0` cuando no hay historia.
8. **Frontend: por inspección de fuente**, como manda el pedido. No monto
   pantallas; los tests de render son de `frontend-fiscal`. En particular, «375
   px y 1024 px sin scroll horizontal, foco visible, contraste AA» se audita por
   lo que se puede leer en el código (anchos fijos, `overflow-x-auto`, colores
   crudos, `Badge` sin texto): **un render real a 375 px y un medidor de
   contraste siguen pendientes** y son del recorrido en navegador del
   orquestador.
9. **El árbol se movía mientras auditaba.** La auditoría de frontend es por
   inspección de fuente: una línea de aritmética sobre plata agregada después de
   mi última corrida no la vio nadie. `npx vitest run src/audit` en la
   verificación final —con el árbol quieto— es lo que cierra esto, y por eso los
   patrones están escritos para fallar con `archivo:línea`, no para pasar.
10. **La fixture `fiscal_ranges` que agregué es autouse** en `tests/audit`: si
    un pedido futuro quiere auditar el caso «sin rango», tiene que borrarlos o
    vencerlos a mano dentro del test (los dos patrones están usados y
    comentados). Borrarlos con `DELETE` falla si ya hay documentos emitidos —la
    FK real a `fiscal_ranges` lo impide, que es justamente lo que §8.3 quiere—,
    así que el patrón correcto es **vencer** la vigencia.
11. **`app/orders/schemas.py` no tuvo dueño en 1b-2**, y por eso A-10 no cerró
    del todo (A-2). No es un gap mío: lo declaro porque es la única deuda de
    1b-1 que el pedido listaba como «trabajo de 1b-2» y que queda abierta.

---

## 7. Comandos de verificación y resultados literales (ronda 1 — histórico)

> **Los resultados vigentes son los de §8.2** (`146 passed, 0 failed`). Esta
> sección se conserva como el estado de la ronda 1, que es lo que motivó las
> tres correcciones.

### Backend (sólo `tests/audit`)

```
mkdir -p /tmp/pt-auditor
cd backend && TMPDIR=/tmp/pt-auditor python -m pytest tests/audit -q
```

```
=========================== short test summary info ============================
FAILED tests/audit/test_privacy_invariants.py::test_erase_does_not_leave_the_erased_data_in_the_audit_trail
FAILED tests/audit/test_privacy_invariants.py::test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale
FAILED tests/audit/test_reports_invariants.py::test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it
3 failed, 139 passed, 269 warnings in 484.61s (0:08:04)
```

Los **tres rojos son exactamente los hallazgos B-1, B-2 y B-3**, escritos a
propósito (§3), y son los únicos de mi territorio. Los **96 invariantes de
1b-1 siguen en verde** con el rango DIAN cargado por la fixture nueva —
incluidas las cinco identidades de la venta sobre 1.000 comandas y las dos de
fecha operativa (venta a las 00:30 sellada con el día del turno, venta a las
10:00 sobre turno pasado de la hora de corte sellada con hoy).

Por archivo, corridos también uno por uno mientras los escribía:

```
tests/audit/test_fiscal_invariants.py        18 passed
tests/audit/test_notes_refunds_invariants.py  9 passed
tests/audit/test_privacy_invariants.py        8 passed, 2 failed  (B-1, B-2)
tests/audit/test_reports_invariants.py       10 passed, 1 failed  (B-3)
tests/audit/test_migration_invariants.py      8 passed
tests/audit/test_sales_invariants.py (prorate) 2 passed
```

### mypy

```
cd backend && python -m mypy app
Success: no issues found in 89 source files
```

(No toqué código de producción; lo corro porque el pedido lo exige y porque un
`mypy` roto en un árbol compartido invalida cualquier corrida ajena.)

### Frontend (sólo `src/audit`)

```
cd frontend && npx vitest run src/audit
```

```
 Test Files  3 passed (3)
      Tests  36 passed (36)
   Duration  712ms
```

### Typecheck del frontend

```
cd frontend && npm run typecheck
> tsc --noEmit -p tsconfig.app.json
```

Sin salida: limpio.

### Comprobación de que el auditor no da un verde falso

- `frontend/src/audit/fiscal.test.ts`: vacié a mano la lista `ALLOWED` y el
  test encontró **una** cuenta (`features/fiscal/RangesPage.tsx:44:
  return range.consumed / total;`) y **cinco** redondeos
  (`RangesPage.tsx:54,365,371`, `reports/AccountantReportTab.tsx:89`,
  `reports/lib.ts:44`), todos con el `archivo:línea` correcto. Con la lista
  puesta, cero. Un auditor que no se prueba contra sí mismo no prueba nada.
- `frontend/src/audit/sales.test.ts`: el test de redondeo encontró las tres
  líneas nuevas de `OrdersAdminPage.tsx` (`:139`, `:156`, `:157`) **antes** de
  que las tolerara, que es como se descubrió que había que separar el redondeo
  de tiempo del de plata.
- Backend: los tres rojos se verificaron **primero** como comportamiento real
  (no como un test mal escrito): B-1 imprimiendo el `before` de `audit_logs`,
  B-2 leyendo `GET /orders/{id}.status` después del `400`, y B-3 comparando la
  mitad que sí funciona (`fiscal_rejected` llega a Hoy) contra la que no.
- La advertencia A-1 se verificó con una corrida desechable que imprimió la
  fila real de `pending_refunds` y la respuesta de `GET /admin/pending-refunds`
  después del `erase`; el archivo de prueba se borró (no dejo tests que
  documenten un comportamiento que no es una regla).

No corrí: la suite completa de backend, `npm run test`, `npm run build`, ni
`alembic upgrade head` sobre `dev.db` del repo. Las migraciones se prueban sobre
un SQLite nuevo bajo el `tmp_path` del test, que respeta `TMPDIR`.

---

## 8. Ronda 2 — re-verificación de los tres cierres

**Veredicto de la ronda: los tres bloqueantes están CERRADOS.**
`146 passed, 0 failed` en `tests/audit`, `mypy` limpio, `36 passed` en
`src/audit`, `tsc --noEmit` limpio. Ninguno de los tres pasó a verde por un
cambio en mi test: las aserciones de los tres son **byte por byte** las de la
ronda 1.

### 8.0 Integridad de mi territorio

`find backend/tests/audit frontend/src/audit -newermt "2026-09-15 18:54" -type f`
(el minuto en que cerré la ronda 1) devolvió **vacío** antes de que yo tocara
nada. **Nadie más editó `backend/tests/audit/**` ni `frontend/src/audit/**`.**
Los únicos cambios de la ronda 2 en mi territorio son míos y son **aditivos**:

| Archivo | Qué agregué en la ronda 2 |
|---|---|
| `backend/tests/audit/test_privacy_invariants.py` | sección `(f)` al final: 3 contrapruebas (`test_the_erase_still_leaves_its_own_trail_after_the_pii_left_the_audit_log`, `test_charging_with_customer_data_while_the_feature_is_on_still_creates_master_consent_and_document`, `test_a_staff_meal_behaves_the_same_with_and_without_customer_data_flag_on_or_off`). **No toqué** los tests de B-1 ni de B-2 |
| `backend/tests/audit/test_reports_invariants.py` | sección `(g)` al final: 1 contraprueba (`test_the_contingency_sweep_does_not_duplicate_the_alert_nor_replace_the_lazy_one`). **No toqué** el test de B-3 |
| `frontend/src/audit/**` | **nada**. El frontend no cambió en la ronda 2 (`find frontend/src -newermt "2026-09-15 18:54"` → vacío), así que la deuda de frontend es idéntica |

Un detalle a propósito: los tres tests cerrados **conservan su docstring
`ROJO A PROPÓSITO`**, que ahora describe historia, no estado. No la toqué
porque la consigna de la ronda era no tocar esos tests, y prefiero un
comentario desactualizado a un diff sobre el archivo que prueba el cierre.
Quien pase después puede reemplazar esas tres primeras líneas de docstring por
«cerrado en 1b-2 ronda 2, ver `outputs-1b-2/auditor-fiscal.md §8.1`» — es un
cambio de texto, no de aserciones.

### 8.1 Cierre por cierre

#### B-1 — CERRADO

- **Test**: `backend/tests/audit/test_privacy_invariants.py::test_erase_does_not_leave_the_erased_data_in_the_audit_trail` → **verde**.
- **Corrección verificada**: `backend/app/customers/service.py`
  - `:31` — helper nuevo `_customer_audit_view(key, *fields) -> {key: [nombres]}`,
    con la doctrina escrita (`:32-46`) y el precedente A-7 citado. Es el
    **único** punto del módulo que arma esos `dict`, que era exactamente la
    corrección sugerida.
  - `:268-270` — `record_audit(..., action="erase", before=_customer_audit_view("cleared_fields", "name", "email", "address", "municipality_dane", "dv", "doc_number"), after={"name": ERASED_NAME, "doc_type": ERASED_DOC_TYPE, "doc_number": customer.doc_number})`.
    El `before` lleva **nombres de campo**, no valores; el `after` lleva los
    placeholders de anonimización, que no son datos del titular.
  - `:117-118` — la misma corrección alcanzó a `patch_customer`
    (`before=None`, `after=_customer_audit_view("changed_fields", …)`), que era
    la segunda mitad de mi sugerencia y que no había test rojo que la forzara.
  - `:178` — la revocación de consentimiento también quedó con `before=None` y
    un `after` sin PII (`purpose`/`granted`/`channel`).
- **Comprobación a mano de que el verde NO se logró borrando la traza** (lo que
  el Maestro pidió explícitamente, porque eso sería una regresión de §6.1):
  - `record_audit` **sigue llamándose** en `erase_customer` (`:260-272`), con
    `action="erase"` (`:267`).
  - El `CustomerDataRequest(kind=DataRequestKind.ERASE, …)` **sigue
    escribiéndose** (`:239-250`), con `note` = el motivo, `response`, `requested_at`,
    `responded_at`, `employee_id` y `employee_name`.
  - Esto no queda en la lectura de código: lo fija el test nuevo
    `test_the_erase_still_leaves_its_own_trail_after_the_pii_left_the_audit_log`,
    que exige **exactamente una** fila `audit_logs(entity="customer", action="erase")`
    con `actor_employee_id`/`actor_employee_name` y con `reason` igual al motivo
    enviado, **más** exactamente una fila `customer_data_requests(kind=erase)`
    con `note`, `response` y `responded_at`, **más** que
    `GET /admin/customers/{id}/requests` la devuelva. Si alguien «cierra» B-1
    borrando el `record_audit`, este test se pone rojo.

#### B-2 — CERRADO

- **Test**: `backend/tests/audit/test_privacy_invariants.py::test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale` → **verde**.
- **Corrección verificada**: `backend/app/payments/service.py:449-450`

  ```python
  if split_results and payload.customer is not None:
      features.assert_feature(db, order.organization_id, store.id, "customers")
  ```

  Está **antes** del punto sin retorno: `claim_payment` vive en `:467`, y el
  comentario de `:437-448` deja escrito por qué (el gate del gancho vive
  después, `get_db` comitea también ante `AppError`, y el `SAVEPOINT` de
  `issue_document` no revierte `claim_payment`). Es el mismo patrón que el
  `assert_range_available` de `:428-431`, que era la corrección sugerida.
- **Contraprueba del camino feliz** (`test_charging_with_customer_data_while_the_feature_is_on_still_creates_master_consent_and_document`,
  **verde**): con `customers` **ENCENDIDA**, el mismo cobro con `customer` en el
  body sigue dando `201` y deja: 1 fila en `customers` con el nombre y el
  documento enviados y `erased_at is None`; 1 fila en `customer_consents` con el
  `text_version` enviado; 1 `fiscal_document` con `customer_doc_number`,
  `customer_name` y `customer_id` apuntando al maestro (el snapshot de §8.3); y
  1 `payment`. Además, el mismo cobro **sin** `customer` con la flag encendida
  no crea un cliente de más: el gate nuevo no convirtió el cliente en
  obligatorio.
- **Contraprueba del borde** (`test_a_staff_meal_behaves_the_same_with_and_without_customer_data_flag_on_or_off`,
  **verde**): las **cuatro** combinaciones (flag `False`/`True` × `customer`
  ausente/presente) sobre una comanda `staff_meal` cobrada con `splits: []` dan
  el **mismo** resultado: `201`, `total == 0`, `document is None`, y al final
  **cero** `fiscal_documents`, **cero** `payments` y **cero** `customers`. Es el
  borde que la mitad `split_results` del gate protege: si alguien lo
  simplificara a `if payload.customer is not None:`, la combinación
  (flag off + `customer` en el body) pasaría a ser un `400 FEATURE_DISABLED`
  sobre una comida de empleado que nunca toca el maestro, y este test lo
  atraparía. La cara de privacidad también queda fijada: mandar `customer`
  junto a un consumo de personal **no** crea un maestro (§8.4, minimización).

#### B-3 — CERRADO

- **Test**: `backend/tests/audit/test_reports_invariants.py::test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it` → **verde**.
- **Corrección verificada**: `backend/app/reports/service.py:520` —
  `fiscal_service.sweep_contingency_overdue(db, store_id=store.id)`, junto al
  `_sweep_stale_orders(db, store, now)` de `:508` y **antes** de
  `_recent_alerts(db, store)` (`:548`), que es el orden que hace que la
  notificación recién disparada ya esté en la tabla cuando se arman los
  `alerts`. Llama a la función pública del dueño de `app/fiscal` (importada en
  `:37`): **no** replica la consulta ni el umbral de 48 h, que era la corrección
  sugerida.
- **Contraprueba** (`test_the_contingency_sweep_does_not_duplicate_the_alert_nor_replace_the_lazy_one`,
  **verde**), sobre **dos** documentos en contingencia:
  1. **Antes de las 48 h no hay alerta**: entrar a Hoy no dispara nada (cero
     notificaciones `fiscal_contingency_overdue`). El barrido nuevo no adelantó
     el plazo legal.
  2. **El barrido perezoso viejo sigue vivo por su cuenta**: tras
     `clock.advance(hours=49)`, un `GET /admin/fiscal/documents?store_id=…`
     —sin pasar por Hoy— deja las dos notificaciones, una por documento. El
     cierre de B-3 **sumó** un punto de barrido, no reemplazó el que tenía
     `backend-fiscal`: el contador que entra derecho a Documentos fiscales o al
     paquete de evidencia sigue viendo el vencimiento ahí.
  3. **Entrar dos veces a Hoy no duplica**: tras dos `GET /admin/today`
     seguidos, siguen siendo **2** notificaciones, con
     `dedupe_key ∈ {fiscal_contingency_overdue:{doc_a}, fiscal_contingency_overdue:{doc_b}}`
     — el dedupe de `notifications_service.notify` (`app/fiscal/service.py:483`)
     es lo que lo garantiza, y ahora que el barrido corre en la pantalla más
     visitada del sistema es una propiedad que hay que tener atada con un test,
     no con un comentario.
  4. **La banda «Requiere tu atención» muestra una alerta por documento** (no
     una ni cuatro), y **barrer no mueve el `dian_status`**: los dos documentos
     siguen en `CONTINGENCY`. Avisar del vencimiento no es emitir ni corregir:
     un documento emitido es inmutable y sólo el proveedor decide su estado
     (§8.3).

### 8.2 Los cuatro comandos, resultado literal

```
cd /home/user/restaurante-sistema/backend && TMPDIR=/tmp/pt-auditor python -m pytest tests/audit -q
```

```
146 passed, 277 warnings in 500.37s (0:08:20)
```

Cero `FAILED`, cero `ERROR`. **El objetivo de la ronda (`0 failed`) se cumplió.**
Desglose de la corrida (146 = 142 de la ronda 1 + 4 contrapruebas nuevas):

```
tests/audit/test_cash_invariants.py           35 passed
tests/audit/test_sales_invariants.py          12 passed
tests/audit/test_fiscal_invariants.py         18 passed
tests/audit/test_notes_refunds_invariants.py   9 passed
tests/audit/test_privacy_invariants.py        13 passed   (B-1 y B-2 en verde + 3 contrapruebas)
tests/audit/test_reports_invariants.py        12 passed   (B-3 en verde + 1 contraprueba)
tests/audit/test_security_invariants.py       39 passed
tests/audit/test_migration_invariants.py       8 passed
```

```
cd /home/user/restaurante-sistema/backend && python -m mypy app
```

```
Success: no issues found in 89 source files
```

```
cd /home/user/restaurante-sistema/frontend && npx vitest run src/audit
```

```
 Test Files  3 passed (3)
      Tests  36 passed (36)
   Duration  600ms
```

```
cd /home/user/restaurante-sistema/frontend && npx tsc --noEmit
```

Sin salida, código de salida `0`: limpio.

### 8.3 Tests de otros dominios: ninguno se puso rojo por estas correcciones

Las tres correcciones tocan exactamente tres archivos de producción
(`app/customers/service.py`, `app/payments/service.py`, `app/reports/service.py`).
Corrí **los cinco dominios que esos archivos atraviesan** —no la suite completa,
que es del orquestador—, con el árbol quieto:

```
cd /home/user/restaurante-sistema/backend && python -m pytest tests/customers tests/payments tests/reports tests/refunds tests/fiscal -q
```

```
123 passed, 234 warnings in 417.69s (0:06:57)
```

Cero rojos. Además, revisado a mano lo que podría haberse roto en silencio:

- **Forma del `before`/`after` de `record_audit(entity="customer")`**: ningún
  test fuera de `tests/audit` asserta sobre su contenido
  (`grep -rn "\.before\|\.after" tests/customers/` sólo trae
  `test_erase_fiscal_snapshot_invariant.py:89-94`, que compara el **snapshot del
  documento**, no la auditoría). El cambio de forma no rompió a nadie.
- **El gate nuevo de `pay_order`**: su dueño escribió su propia réplica en
  `backend/tests/payments/test_customer_hook.py:133` (flag apagada + `customer`
  → `400` y comanda intacta) y `:192`
  (`test_customer_feature_disabled_without_customer_in_body_still_charges`:
  flag apagada **sin** `customer` → `201` con documento). Las dos en verde.
- **El barrido en `today_report`**: su dueño escribió
  `backend/tests/reports/test_today.py:150,160,174` (47 h sin alerta, 49 h con
  alerta, segunda entrada sin duplicar). Las tres en verde.

### 8.4 Deuda que sigue viva (se repite, no se asciende)

Ninguna de estas cambió en la ronda 2 — las reverifiqué una por una con el
árbol quieto y todas siguen tal cual estaban:

| # | Qué | Dónde (reverificado en ronda 2) | Severidad | Dueño |
|---|---|---|---|---|
| **A-2 (A-10)** | A-10 quedó **parcialmente** saldado: `amount_due` lo manda el backend **sólo después de cobrar** (`app/payments/schemas.py:106`, `PaymentOut`), pero **no** está en `PreBillOut`, ni en `OrderOut.totals`, ni en `SubAccountOut.totals`. Por eso el **objetivo del cobro** se sigue armando en el cliente: `frontend/src/features/payments/PaymentTargetPanel.tsx:105` — `totalDue={saleTotal + (tip?.amount ?? 0)}`. Lo que se **muestra** ya no se deriva; lo que se **cobra**, sí | `app/orders/schemas.py` **no tuvo dueño en 1b-2** | advertencia | quien tome `app/orders/schemas.py` + `frontend-cobro` |
| **A-1** | La supresión no alcanza a `pending_refunds`: `app/refunds/models.py:69-70` congela `customer_name`/`customer_doc_number` y `app/refunds/hooks.py:140-141` los escribe; `app/customers/service.py::erase_customer` no los toca (cero menciones de `refund` en el módulo). El nombre y el documento del titular sobreviven ahí y se exportan | sin cambios | advertencia | `backend-clientes-dinero` |
| **A-3** | `GET /admin/fiscal/documents` filtra por `status` pero no por tipo (`app/fiscal/router.py:129-141`: los únicos `Query` son `store_id` y `status`), y la pantalla lo suple en el cliente | sin cambios | advertencia | `backend-fiscal` |
| **O-1** | `?? 0` sobre un campo de plata en el gráfico de Ventas (`frontend/src/features/reports/SalesTab.tsx:101,106`) — §9.3 y §12: «sin datos» se dice, no se dibuja como cero | frontend sin cambios en ronda 2 | observación | quien tenga `features/reports` |
| **O-2** | Tres `<button>` crudos en `frontend/src/features/payments/CheckoutPage.tsx:179,233,323` no heredan el `focus-visible:ring-*` tokenizado | sin cambios | observación | `frontend-fiscal` / `frontend-cobro` |
| **O-3** | Dos entregables declararon como bloqueante algo ya resuelto (ver la tabla del encabezado). Lo que **sí** queda de ese hilo: `FiscalDocument.customer_id` sigue `Integer` sin FK dura (`app/fiscal/models.py:192`), hoy ya convertible porque `customers` está en `MODEL_MODULES` | sin cambios | observación | `backend-fiscal` |
| **O-4** | Los filtros compartidos existen (`components/DateRangeFilter.tsx`, `components/CsvExportButton.tsx`) pero fiscal y clientes siguen importando su copia local | frontend sin cambios en ronda 2 | observación | `frontend-fiscal` |

Y los gaps de §6 siguen íntegros: Postgres real (el `SELECT … FOR UPDATE` y los
índices parciales sólo se prueban ahí), la ventana de carrera entre
`assert_range_available` y `reserve_next_number`, dos notas concurrentes sobre
el mismo documento con hilos, y el render real a 375 px con medidor de
contraste, que es del recorrido en navegador del orquestador.

### 8.5 Hallazgos nuevos de la ronda 2

**Ninguno.** No apareció plata que se pierda, ni dato personal que sobreviva, ni
regresión introducida por B-1, B-2 o B-3. Las tres correcciones son mínimas,
están en el archivo del dueño, no replican lógica ajena y llevan escrito el
motivo. La única cosa que anoto y que **no** asciendo a hallazgo, porque no
viola ninguna regla declarada y ahora está cubierta por un test:

- Mandar `customer` en el body de un cobro `staff_meal` / 100 % cortesía
  (`splits: []`) **se ignora en silencio**: no se crea maestro, no se pide la
  flag y no se avisa. Es el comportamiento correcto desde privacidad
  (minimización: no hay documento al que asociar el dato) y desde producto (no
  hubo venta), y es el que el gate de `:449` preserva a propósito. Lo dejo
  escrito para que nadie lo «arregle» sin leer
  `test_a_staff_meal_behaves_the_same_with_and_without_customer_data_flag_on_or_off`.
