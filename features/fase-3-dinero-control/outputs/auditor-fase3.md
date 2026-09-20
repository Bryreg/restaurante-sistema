# T6 · `auditor-fase3` — invariantes ejecutables de la fase 3

**Qué es este documento.** No es una confirmación de que los cinco territorios
hicieron lo que dijeron: es el resultado de buscar **dónde mienten los números**.
Cada hallazgo está escrito como **un test rojo a propósito**, con el defecto en el
docstring, su **dueño** y su **remedio**. Ninguno se ablandó para cerrar más
limpio.

**Se escribió en paralelo con los cinco constructores, sobre un árbol que se
movía.** Por eso todo lo que sigue separa dos cosas que el orquestador necesita
distinguir para decidir si itera:

- **ROJO POR DEFECTO** — está construido y el número (o la llamada) miente. Es un
  hallazgo.
- **ROJO POR AUSENCIA** — todavía no existía cuando el invariante se escribió. Es
  información, no un hallazgo.

Al cierre de esta corrida **no queda ningún rojo por ausencia**: los cinco
territorios entregaron. Los 7 rojos que quedan son, los 7, **por defecto**.

---

## 1. Hallazgos, ordenados por daño

### H-1 · D-4 no se aplica: la supresión por habeas data no alcanza a `pending_refunds`

| | |
|---|---|
| **Qué número miente** | Ninguno: miente un **dato personal**. Tras `POST /admin/customers/{id}/erase`, el nombre del titular sigue **intacto** en `pending_refunds`. D-4 dice, con todas las letras, que la supresión **sí** alcanza a esa tabla. |
| **Test** | `backend/tests/audit/test_contract_fase3_invariants.py::test_d4_erasing_a_customer_anonymizes_the_pending_refund_but_never_the_money` |
| **Dueño** | **T1 `backend-banco`** |
| **Estado** | **ROJO POR DEFECTO** |

`app/refunds/service.py::anonymize_pending_refunds_for_customer` está escrita,
está bien escrita (conserva monto, documento, estado y autorizador; anonimiza sólo
el nombre; es idempotente; su auditoría guarda `{"cleared_fields": ["customer_name"]}`)
… y **nadie la llama**. No tiene un solo punto de invocación en producción.

T1 lo declaró como gap (`outputs/backend-banco.md §9.1`) diciendo que
`app/customers/` no es su territorio. **No es así**: §1 de la spec, al asignar D-4,
dice textualmente «**T1** (`backend-banco`), única excepción autorizada a "no
toques `app/refunds/` **ni `app/customers/`**", limitada a extender la supresión
existente». La autorización estaba dada.

**Por qué es el hallazgo nº1.** Es el único de la lista con consecuencia **legal**
(Ley 1581 de 2012, derecho de supresión). Un dueño que responde «ya lo suprimimos»
a un titular, con el nombre todavía en la base, tiene un incumplimiento, no un bug.
Y es el más barato de arreglar de toda la lista.

**Remedio (una línea, más su guarda).** En
`app/customers/service.py::erase_customer`, después de anonimizar el maestro y
antes del `record_audit`:

```python
from app.core.modules import find_spec_safe
if find_spec_safe("app.refunds.service") is not None:
    from app.refunds.service import anonymize_pending_refunds_for_customer
    anonymize_pending_refunds_for_customer(
        db, actor=actor, organization_id=customer.organization_id,
        customer_id=customer.id, reason=reason, now=now,
    )
```

El `find_spec_safe` es el mismo patrón con el que `app.shifts.hooks` protege su
import de `app.payments.models` (lección de 1b-1: un import duro de un dominio que
puede no estar tumba el arranque de toda la API).

---

### H-2 · La pantalla del reparto de propinas y su endpoint **no se pueden hablar**: `422` siempre

| | |
|---|---|
| **Qué número miente** | Ninguno llega a calcularse. `GET /admin/tips/distribution/proposal` exige `shift_id` (lista, `Query(...)`, **obligatorio**); `src/api/payroll.ts::getTipsDistributionProposal` manda `store_id`, `from` y `to`. La pantalla de propinas recibe `422` en **todas** sus cargas: el dueño ve «No se pudo calcular la propuesta» para siempre. D-3 queda inalcanzable desde la interfaz. |
| **Test** | `frontend/src/audit/payroll.test.ts` → «payroll: el cliente manda todos los parámetros que el endpoint exige» |
| **Dueño** | **T3 `backend-nomina-propinas`** (primario), con **T5 `frontend-fase3`** del otro lado |
| **Estado** | **ROJO POR DEFECTO** |

Las «Reglas que valen para todas» del contrato de §2 dicen: «Rango de período con
`from`/`to` en **fecha de negocio**». T3 se apartó —construyó la propuesta keyeada
por `shift_ids`— y **no lo declaró** en su entregable (`outputs/backend-nomina-propinas.md`
lista la ruta como «del contrato mínimo, las seis exactas»). T5, que leyó los
esquemas Pydantic pero no las firmas de los endpoints, implementó la regla general.
Es la «mitad de ida construida sin la mitad de vuelta» que produjo los cinco
hallazgos de cruce de 2b, otra vez.

**Por qué es el nº2.** Es el hallazgo con mayor superficie: **una de las once
capacidades de la fase no se puede usar**, y el `422` no se ve en ningún test de
ninguno de los dos territorios (cada uno probó su mitad, y las dos mitades pasan).

**Remedio (T3, preferido).** Que el endpoint acepte `from`/`to` en fecha de negocio
y resuelva los turnos cerrados del rango del lado del servidor. Ya publica
`shift_ids` en la respuesta —T5 los usa para el «confirmar»—, así que el cambio es
sólo de entrada. Dejar `shift_id` como parámetro **opcional** adicional no rompe
nada y conserva el caso «repartir las propinas de estos dos turnos».
**Alternativa (T5)**, si el orquestador decide que la clave de la propuesta es el
turno y no el período: la pantalla tiene que ofrecer un selector de turnos y mandar
`shift_id`. **Elegir una de las dos, no las dos**: el contrato es vinculante en las
dos direcciones precisamente para que esto no se negocie dos veces.

---

### H-3 · La pantalla de varianza por plato tampoco carga: `count_id` es obligatorio y no se manda

| | |
|---|---|
| **Qué número miente** | Ninguno llega a calcularse. `GET /admin/variance/by-dish` declara `count_id: int = Query(...)` (**obligatorio**); `src/api/analytics.ts::getVarianceByDish` manda sólo `store_id` y documenta, por escrito, que lo cree opcional («`count_id` opcional: el más reciente si se omite»). Es `422` en todas sus cargas. |
| **Test** | `frontend/src/audit/payroll.test.ts` → «analytics: el cliente manda todos los parámetros que el endpoint exige» |
| **Dueño** | **T4 `backend-analitica`** (primario), con **T5 `frontend-fase3`** del otro lado |
| **Estado** | **ROJO POR DEFECTO** |

Mismo patrón que H-2, distinto territorio. T5 escribió en su código el
comportamiento que asumió; T4 lo hizo obligatorio. Los dos lados están
internamente bien y juntos no funcionan.

**Remedio (T4, preferido).** `count_id: int | None = Query(None)`, y cuando falta,
resolver **el conteo aplicado más reciente**. Si no hay ninguno, la respuesta ya
tiene el camino correcto: `available: False` + `reason` (que es lo que la regla de
«`null` con motivo» pide, y lo que la pantalla ya sabe pintar). Eso es exactamente
lo que T5 documentó esperar.
**Alternativa (T5)**: un selector de conteo en la pantalla. Más trabajo y peor
experiencia: el caso normal es «el último».

---

### H-4 · «Por consignar» publica `$0` para un turno que nadie contó

| | |
|---|---|
| **Qué número miente** | `to_deposit`. Un turno cerrado **administrativamente** (sin conteo) aparece en `GET /admin/deposits/pending` con `to_deposit: 0` y `reason: null` — indistinguible de un turno arqueado por su responsable en el que no quedó nada por consignar. La verdad es «nadie abrió ese cajón». |
| **Test** | `backend/tests/audit/test_contract_fase3_invariants.py::test_pending_deposits_reports_null_to_deposit_with_a_reason_for_a_shift_closed_without_count` |
| **Dueño** | **T1 `backend-banco`** |
| **Estado** | **ROJO POR DEFECTO** |

El contrato de §2 lo pide con estas palabras: «`to_deposit: null` con `reason`
**cuando el turno cerró sin conteo**». T1 escribió el `reason` correcto —«El turno
cerró sin conteo (cierre administrativo); no hay saldo por consignar calculable»—
pero lo colgó de la condición equivocada: `shift.to_deposit is None`.

**Un cierre administrativo nunca deja `to_deposit` en `NULL`.**
`app/shifts/service.py:1257` le escribe `breakdown["expected"] − opening_cash_fixed`,
una cifra derivada **del libro**, no de un conteo. Resultado: la rama del `reason`
es **código muerto**, y el turno sin arquear se publica con una cifra (en un turno
sin ventas, exactamente `0`).

Es el **error repetido nº7** con su peor variante: no es un `0` donde iba `null`,
es **una cifra derivada presentada como si alguien hubiera contado la plata**.

**Remedio (T1, sin recalcular nada).** La condición de «cerró sin conteo» es
`Shift.closed_without_count`, que existe desde 1b (`app/shifts/models.py:192`) y
ya se publica en `ShiftOut`. Usar ese campo para decidir `null` + `reason`, y
seguir **leyendo** `Shift.to_deposit` en el caso normal. Dos líneas en
`app/banking/service.py::pending_deposits`.

---

### H-5 · `app/banking/` decide por su cuenta qué medios de pago son electrónicos

| | |
|---|---|
| **Qué número miente** | Todavía ninguno — **miente en cuanto se agregue un medio de pago**, y ya se agregaron dos en 2c. `app/banking/service.py:398` filtra `Payment.method == "transfer"` para el libro del banco y `:686` filtra `Payment.method == "card"` para la conciliación del datáfono. Son dos sitios más que responden «qué medios son electrónicos», y `app/shifts/hooks.py::payment_bucket` es —por decisión explícita del cierre de H-2 de la ronda 2 de 2c— **el único lugar del sistema que decide en qué bolsillo cae un cobro**. |
| **Test** | `backend/tests/audit/test_contract_fase3_invariants.py::test_no_new_domain_decides_by_itself_which_payment_methods_are_electronic` |
| **Dueño** | **T1 `backend-banco`** |
| **Estado** | **ROJO POR DEFECTO** (riesgo latente, no cifra equivocada hoy) |

El docstring de `payment_bucket` cuenta el precio que este proyecto ya pagó por
tener dos respuestas a la misma pregunta: el mismo cuerpo de `GET /shifts/{id}/tips`
llegó a decir que la propina en efectivo del turno era $10.000 por método y $20.000
por empleado. El día que aparezca un medio nuevo, `payment_bucket` lo va a
clasificar y la conciliación del datáfono lo va a omitir **en silencio**: la
diferencia va a aparecer como «falta una liquidación», un síntoma con una causa
completamente distinta, que manda a buscar donde no es.

**Por qué no se ablanda aunque haya una razón técnica.** Es cierto que
`payment_bucket` es una función de Python y acá hace falta un filtro en SQL: no se
puede llamar fila por fila sin traer todos los pagos del período. Eso hace que el
remedio necesite **dos territorios**, no que el problema no exista.

**Remedio.** Publicar el conjunto en `app/shifts/hooks.py` —p. ej.
`METHODS_IN_BUCKET: dict[str, frozenset[str]]`, derivado de la misma tabla que usa
`payment_bucket`— e importarlo en `app/banking/service.py` para el `IN (...)`.
Mientras `app/shifts/` no sea territorio de esta fase, T1 puede cerrarlo de dos
formas: **declarando el hook que necesita como gap**, o —si el orquestador lo
autoriza— agregándolo.

---

### H-6 · No se puede registrar una consignación de plata que no se imputa a un turno

| | |
|---|---|
| **Qué número miente** | El `amount` de la consignación, y por arrastre el **saldo de la mano del dueño**. `CreateDepositDialog.tsx:74` arma el monto de la consignación como la **suma de las imputaciones** que la persona teclea (`validAllocations.reduce(...)`). |
| **Test** | `frontend/src/audit/money-after-drawer.test.ts` → «ninguna pantalla de plata totaliza con `reduce` una cifra que el servidor va a guardar» |
| **Dueño** | **T5 `frontend-fase3`** |
| **Estado** | **ROJO POR DEFECTO** |

Dos consecuencias que no son teóricas:

1. `unallocated_amount` **nunca** puede ser distinto de `0`, aunque el backend lo
   publique como campo propio y lo calcule bien.
2. **No se puede registrar la consignación de plata que no se imputa a ningún
   turno** — la que sale de la mano del dueño. Y ése es justamente el flujo que
   `GET /admin/bank/owner-hand` existe para medir: el saldo de la mano sólo puede
   bajar por consignaciones imputadas a turnos, así que un dueño que retira
   $100.000, los guarda una semana y después los consigna, no tiene forma de
   decírselo al sistema.

Es también una cifra de plata calculada en el cliente, que es lo que `AGENTS.md`
prohíbe; pero el daño real no es el redondeo (no hay: son enteros), es el flujo que
queda sin cubrir.

**Remedio (T5).** Que el monto de la consignación sea un campo que la persona
escribe —es lo que dice el comprobante del banco, que además es obligatorio
adjuntar— y que las imputaciones se validen contra él. El backend ya publica
`allocated_amount` y `unallocated_amount` exactamente para eso.

---

### H-7 · El default de reparto de propinas vive en dos lados

| | |
|---|---|
| **Qué número miente** | El método de reparto mostrado mientras carga. `features/payroll/TipsTab.tsx:51` hace `value={query.data?.method ?? "by_hours"}`. |
| **Test** | `frontend/src/audit/payroll.test.ts` → «el default `by_hours` de D-3 no se decide en el cliente» |
| **Dueño** | **T5 `frontend-fase3`** |
| **Estado** | **ROJO POR DEFECTO** (severidad baja, real) |

D-3 dice que el método es **configuración de sede** y que el backend la resuelve
(`service.get_tip_settings` devuelve el default sin necesitar fila creada). Tener
el mismo default escrito también en el cliente significa que el día que el producto
cambie el default —y es una decisión de negocio, no de código— hay que cambiarlo en
dos lugares o quedan dos respuestas a «cómo se reparten las propinas acá». Además,
una sede configurada en `by_area` muestra «Por horas» durante la carga.

**Por qué está en la lista aunque sea cosmético.** Porque es exactamente la forma
en que nacen los otros seis: una regla de negocio duplicada que hoy coincide.

**Remedio (T5).** Mostrar el estado de carga (`—`, o deshabilitar el `Select`)
hasta que llegue la respuesta; nunca un valor de negocio inventado por el cliente.

---

## 2. Qué invariantes escribí y qué cubre cada uno

### `backend/tests/audit/test_contract_fase3_invariants.py` — 133 casos

Mismo patrón de nombre y de escritura que `test_contract_2b_invariants.py` y
`test_contract_2c_invariants.py`. Organizado por los ocho cruces obligatorios, más
las cuatro decisiones y el contrato de API.

| Bloque | Invariante | Qué cubre |
|---|---|---|
| CRUCE 1 | `test_registering_a_bank_deposit_does_not_move_the_shift_expected_cash` | El esperado leído por HTTP **antes y después** de `POST /admin/deposits`; igualdad exacta. |
| CRUCE 1 | `test_an_expense_that_never_touched_the_drawer_does_not_move_the_expected_cash` | Una transferencia de arriendo (`source: "bank"`) no toca `compute_breakdown`. |
| CRUCE 1 | `test_settling_a_scheduled_obligation_outside_the_drawer_does_not_move_the_expected_cash` | Saldar una obligación por banco tampoco. |
| CRUCE 1 | `test_a_payroll_run_does_not_move_the_expected_cash` | Liquidar la nómina es un cálculo, no un pago. |
| CRUCE 1 | `test_a_drawer_expense_moves_the_expected_exactly_once_never_twice` | El gasto que **sí** sale del cajón mueve el esperado **una** vez (el `CashMovement` con causa tipada), y anotarlo en `app/expenses/` no lo mueve otra vez. |
| CRUCE 2 | `test_no_new_domain_recomputes_the_to_deposit_subtraction` | Ningún dominio nuevo nombra `counted_cash_total`, `opening_cash_fixed` ni `tips_cash_out`: `Shift.to_deposit` se **lee**. |
| CRUCE 2 | `test_compute_breakdown_stays_the_only_formula_of_the_expected_cash` | Firma de la fórmula (`cash_sales`+`pickups`, asignación a `expected_cash`). |
| CRUCE 2 | `test_no_new_domain_decides_by_itself_which_payment_methods_are_electronic` | **H-5.** |
| CRUCE 2 | `test_no_new_domain_rebuilds_the_ingredient_cost_hierarchy` | Nadie reimplementa `resolve_ingredient_cost`. |
| D-1 | `test_d1_did_not_touch_the_per_row_variance_traffic_light` | Firma + **huella AST del cuerpo** (sin docstring) de `_variance_level`. Cambia si y sólo si cambia su lógica. |
| CRUCE 3 | `test_break_even_without_fixed_costs_is_null_with_a_reason_never_zero` | Punto de equilibrio sin costos fijos. |
| CRUCE 3 | `test_profit_without_data_is_null_with_a_reason` | Utilidad del período. |
| CRUCE 3 | `test_menu_engineering_without_sales_is_unavailable_with_a_reason_not_an_empty_table` | Ingeniería de menú sin ventas. |
| CRUCE 3 | `test_sustained_with_less_than_two_windows_is_null_with_a_reason_and_never_green` | D-1: `null` con motivo, **nunca `false`**, con menos de 2 ventanas. |
| CRUCE 3 | `test_pending_deposits_reports_null_to_deposit_with_a_reason_for_a_shift_closed_without_count` | **H-4.** |
| CRUCE 4 | `test_no_new_backend_code_uses_a_float_anywhere` | AST de los 4 dominios + `app/core/hours.py`: literal float, `float(...)`, división verdadera. Única excepción declarada: `Decimal(...) / Decimal(...)`. |
| CRUCE 4 | `test_no_new_model_declares_a_float_column` | `Float`/`REAL`/`DOUBLE_PRECISION` en una tabla nueva. |
| CRUCE 4 | `test_no_new_endpoint_ever_returns_a_json_float` | Barrido de las 17 rutas `GET` de la fase buscando un `float` en el JSON. |
| CRUCE 5 | `test_an_old_period_is_liquidated_with_the_surcharge_table_in_force_back_then` | Dos tablas (2025 y 2026), **jornada real trabajada en junio de 2025** (reloj movido con `app/core/clock.py`), liquidación de ese período: tiene que nombrar la de 2025 y **no** la de 2026. |
| CRUCE 6 | `test_an_operator_device_cannot_reach_any_new_admin_route` (×19) | Sesión **real** del dispositivo con un operador identificado contra las 19 rutas nuevas. |
| CRUCE 6 | `test_no_payroll_response_ever_names_an_employee_debt_or_a_payroll_deduction` | CST art. 149: barrido de las respuestas de nómina buscando `debt`, `deuda`, `owes`, `payroll_deduction`, `descuento_nomina`, `shortage_deduction`. |
| CRUCE 6 | `test_no_new_model_declares_a_column_that_looks_like_an_employee_debt` | Lo mismo, en el **esquema**: una columna así no se arregla no publicándola. |
| CRUCE 7 | `test_every_new_capability_answers_400_feature_disabled_when_its_flag_is_off` (×16) | Encendida y apagada, las 16 combinaciones ruta/flag. |
| CRUCE 7 | `test_the_feature_dependency_is_validated_before_the_store_gate` (×4) | Error repetido nº6: con la función propia **encendida** y su dependencia **apagada**, el `FEATURE_DISABLED` tiene que nombrar la **dependencia**. |
| CRUCE 8 | `test_d4_erasing_a_customer_anonymizes_the_pending_refund_but_never_the_money` | **H-1.** Venta real → documento real → supresión por HTTP. |
| CRUCE 8 | `test_d4_the_erasure_audit_stores_only_field_names_never_the_erased_data` | `before`/`after` de la auditoría de supresión no contienen nombre, documento, correo ni dirección (bloqueante B-1 de 1b-2). |
| Contrato | `test_every_route_of_the_minimum_api_contract_exists_exactly_as_written` (×31) | Las 31 rutas del contrato de §2 contra el OpenAPI de la app real, normalizando sólo el nombre del parámetro de path. |
| D-2 | `test_d2_the_payable_publishes_both_figures_and_amount_keeps_its_meaning` | `invoice_total`, `invoice_discrepancy`, `amount` y `confirm_discrepancy` en el OpenAPI. |
| D-2 | `test_d2_copies_the_confirm_price_pattern_and_does_not_invent_a_second_dialect` | `INVOICE_DISCREPANCY` existe; **no** existen `force_approve`/`ignore_*`/`override_*`; `discrepancy_confirmed_by_employee_id` guardado. |
| D-2 | `test_d2_a_payable_with_a_discrepancy_is_not_approved_on_its_own` | Recepción real con papel ≠ cálculo → `409` que **nombra las dos cifras** → aprobación con `confirm_discrepancy: true` → queda registrado quién. |
| D-3 | `test_d3_the_default_tip_distribution_method_is_by_hours` | Default de sede. |
| D-3 | `test_d3_the_three_distribution_methods_exist` (×3) | Los tres métodos aceptados. |
| D-3 | `test_d3_the_proposal_is_a_proposal_and_writes_absolutely_nothing` | `TipPayout`, `TipPayoutDistribution` y `CashMovement` contados antes y después del `GET`. |
| D-3 | `test_d3_payroll_does_not_create_its_own_tip_payout_tables` | Ningún `__tablename__` nuevo de reparto. |
| D-3 | `test_d3_the_write_path_is_still_the_one_that_already_existed` | `app/payroll/` no escribe un payout a mano. |
| T4 | `test_variance_by_dish_declares_itself_prorated_in_the_response` | `method: "prorated"` en la respuesta. |
| T4 | `test_the_variance_by_dish_schema_pins_the_prorated_method` | `method` fijado al **literal** en el esquema publicado: no se puede apagar con un parámetro. |
| T4 | `test_menu_engineering_uses_the_cost_frozen_in_the_item_not_todays_recipe` | `app/analytics/` usa `unit_cost_micros`/`theoretical_cost_micros`, **no** `item.unit_cost` en pesos por línea, y no lee el costo de `Recipe`/`Product`. |
| T1 | `test_the_owner_hand_equation_holds_withdrawn_minus_deposited_minus_spent` | La identidad se verifica **entre las cifras publicadas**, no derivando nada. |
| T1 | `test_the_same_peso_cannot_be_in_the_hand_and_in_the_bank_at_the_same_time` | Retiro → consignación → el saldo en la mano baja exactamente lo consignado. |
| T1 | `test_reconciling_a_platform_settlement_does_not_duplicate_the_receivable` | Filas de `platform_receivables` antes y después de registrar la liquidación. |
| Transversal | `test_no_new_domain_physically_deletes_a_financial_row` | Ningún `db.delete(...)` en los 4 dominios. |
| Transversal | `test_no_business_rule_of_the_new_routes_ever_answers_500` (×19) | Las 19 rutas con parámetros mínimos **y con rango invertido** (`from > to`). |
| Alembic | `test_alembic_has_exactly_one_head` | Cabezas y huérfanos leídos del árbol de migraciones. |
| Alembic | `test_the_phase_three_migration_chain_is_the_one_the_spec_assigned` | `0017→0016`, `0018→0017`, `0019→0018`, `0020→0019`, `0021→0020`. |
| Alembic | `test_alembic_heads_reports_a_single_head_through_the_real_command` | El mismo invariante por la puerta real. |
| §2 T4 | `test_charge_by_waiter_did_not_grow_a_second_report` | No apareció un segundo reporte de «cobro por mesero»; el que vale es `GET /admin/sales?group_by=employee`. |

### `frontend/src/audit/money-after-drawer.test.ts`

Tema: consignaciones, banco, mano del dueño, conciliación, gastos y obligaciones.
Cruza **las rutas que el backend publica** (leídas de los decoradores reales de los
routers, no de una lista a mano) contra **las que la pantalla consume**; prohíbe
aritmética sobre campos de plata del servidor; exige que «por consignar» distinga
`to_deposit === null` y muestre su `reason`; exige que `balance` y `difference` se
pinten como llegan.

### `frontend/src/audit/break-even.test.ts`

Tema: punto de equilibrio, utilidad y D-2 en pantalla. `available`/`reason` antes
de pintar cifra; prohibido `?? 0` sobre un campo de plata; prohibido dividir
costos fijos por un margen en el cliente; prohibido un literal decimal en los
cuatro territorios (CRUCE 4 del lado de TypeScript); y el cruce de
`confirm_discrepancy` en las dos direcciones (esquema Pydantic ↔ cliente).

### `frontend/src/audit/payroll.test.ts`

Tema: D-3, tablas con vigencia y CST 149. Contiene el **cruce de parámetros
requeridos** que encontró H-2 y H-3: lee la firma real de cada endpoint de los
cuatro routers (nombre, `alias=`, y si es obligatorio) y la compara con la query
que manda cada cliente. También: el «confirmar» no se dispara desde un `useEffect`;
la pantalla dice que es una **propuesta**; la liquidación muestra qué tabla usó;
ninguna pantalla de nómina nombra una deuda del empleado; ninguna divide minutos
por 60 en el cliente.

### `frontend/src/audit/menu-engineering.test.tsx`

Tema: ingeniería de menú y varianza por plato, **renderizadas**. Todos sus casos
son respuestas que el backend no debería producir —un margen que no coincide con
la resta, un costo `null`, un `method` distinto de `"prorated"`, una varianza
negativa, una varianza `null`— porque es la única forma de distinguir «la pantalla
pinta lo que llega» de «la pantalla calcula y casualmente coincide». Las dos se ven
idénticas mientras el servidor manda datos consistentes.

---

## 3. Rojos por AUSENCIA vs. rojos por DEFECTO

**Rojos por AUSENCIA (todavía no construido): NINGUNO.**
Los cinco territorios entregaron antes del cierre de esta corrida. Los invariantes
que se escribieron contra rutas que al momento de redactarlos no existían
—`_skip_si_no_existe(...)`— no se activaron: todas las rutas del contrato
responden.

**Rojos por DEFECTO: 7.** Son H-1 a H-7 de §1.

| # | Test | Dueño |
|---|---|---|
| H-1 | `test_contract_fase3_invariants.py::test_d4_erasing_a_customer_anonymizes_the_pending_refund_but_never_the_money` | T1 |
| H-2 | `payroll.test.ts` → «payroll: el cliente manda todos los parámetros que el endpoint exige» | T3 (+T5) |
| H-3 | `payroll.test.ts` → «analytics: el cliente manda todos los parámetros que el endpoint exige» | T4 (+T5) |
| H-4 | `test_contract_fase3_invariants.py::test_pending_deposits_reports_null_to_deposit_with_a_reason_for_a_shift_closed_without_count` | T1 |
| H-5 | `test_contract_fase3_invariants.py::test_no_new_domain_decides_by_itself_which_payment_methods_are_electronic` | T1 |
| H-6 | `money-after-drawer.test.ts` → «ninguna pantalla de plata totaliza con `reduce`…» | T5 |
| H-7 | `payroll.test.ts` → «el default `by_hours` de D-3 no se decide en el cliente» | T5 |

**SKIPPED (1), y por qué no es un hallazgo.**
`test_variance_by_dish_declares_itself_prorated_in_the_response` se salta porque la
base del test no tiene un conteo aplicado sobre el que medir varianza, y armar esa
precondición completa (insumo → ficha → venta → dos conteos completos aplicados)
probaría `app/inventory/` más que a T4. **El invariante se cobra igual** por el
esquema publicado: `test_the_variance_by_dish_schema_pins_the_prorated_method`
exige que `method` sea el literal `"prorated"` fijado en el OpenAPI, que es más
fuerte que verlo una vez en una respuesta (no se puede apagar con un parámetro).
Queda declarado en `gaps`.

---

## 4. Los ocho cruces obligatorios, uno por uno

| # | Cruce | Estado |
|---|---|---|
| 1 | **La plata cierra.** El esperado del turno no se movió por nada de esta fase. | **VERDE.** Medido por HTTP, antes y después, con igualdad exacta, en los cuatro flujos nuevos que mueven plata fuera del cajón (consignación, gasto por banco, obligación saldada, liquidación de nómina) y en el que sí lo mueve (gasto de cajón: se mueve **una** vez). |
| 2 | **Nadie escribió una segunda matemática.** | **ROJO — H-5.** `compute_breakdown` sigue siendo la única fórmula del esperado ✔; `Shift.to_deposit` se lee y no se recalcula ✔ (ningún dominio nuevo nombra siquiera sus tres términos); `resolve_ingredient_cost` sigue siendo la única jerarquía ✔. **Lo que falla** es `payment_bucket`: `app/banking/` decide por su cuenta qué medios son electrónicos. |
| 3 | **`null` con motivo en todo indicador sin datos.** | **ROJO — H-4.** Punto de equilibrio ✔, utilidad ✔, ingeniería de menú ✔, «sostenido» con menos de dos ventanas ✔ (`null`, nunca `false`). **Lo que falla** es `to_deposit` de un turno cerrado sin conteo: publica `0` sin motivo. |
| 4 | **Ningún `float`, en ninguna de las dos capas.** | **VERDE.** Backend: AST de los cuatro dominios + `app/core/hours.py` (literales, `float(...)`, división verdadera) y barrido del JSON de las 17 rutas `GET`. TypeScript: ningún literal decimal en los cuatro territorios, ninguna división de minutos por 60. `app/core/hours.py` declara `HOURS_SCALE = 60` y acumula en minutos enteros y «peso-minutos», con `Decimal` sólo para **publicar**. |
| 5 | **Una tabla legal vieja recalcula con las tablas de su época.** | **VERDE.** Dos tablas cargadas (2025 y 2026), jornada real trabajada en junio de 2025 con el reloj de negocio movido por `app/core/clock.py`, liquidación de ese período: nombra `valid_from=2025-01-01` y no la de 2026. |
| 6 | **El operador sigue sin ver costos, márgenes, nómina ajena ni propina de otro.** | **VERDE.** Las 19 rutas nuevas probadas con la sesión **real** del dispositivo y un operador identificado: todas `401`/`403`, ninguna `200`. Y ninguna respuesta de nómina —ni ninguna columna nueva— nombra una deuda del empleado (CST art. 149). |
| 7 | **`400 FEATURE_DISABLED` con la función apagada, y la dependencia ANTES del gate de sede.** | **VERDE.** 16 combinaciones ruta/flag probadas encendida y apagada. Las 4 dependencias (`money.bank→money.deposits`, `analytics.menu_engineering→catalog.recipes`, `inventory.replenishment→inventory.perpetual` y `→purchases`) nombran **la dependencia**, no la clave propia: el error repetido nº6 no se repitió. El `_require_bank()` de `app/banking/router.py` es el patrón; T4 lo copió. |
| 8 | **La supresión de D-4 anonimiza, no borra, y su auditoría guarda sólo nombres de campos.** | **ROJO — H-1.** La auditoría **sí** guarda sólo nombres de campos ✔ (el bloqueante B-1 de 1b-2 no se repitió). Pero la supresión **no alcanza** a `pending_refunds`: la función existe y nadie la llama. |

### Los cruces adicionales contra el contrato y las decisiones

| Cruce | Estado |
|---|---|
| Las rutas del contrato mínimo existen **tal cual** | **VERDE.** Las 31 rutas contra el OpenAPI real. |
| Las pantallas consumen **ésas y no otras** | **VERDE en la ruta, ROJO en los parámetros** — H-2 y H-3. Ninguna pantalla llama a una ruta que el backend no publique; dos la llaman con los parámetros equivocados, que es la misma familia de daño con otro nombre. |
| **D-1**: 2 de 3 ventanas, `null` con motivo con menos de 2, nunca verde | **VERDE.** |
| **D-1**: `_variance_level` no se tocó | **VERDE.** Firma idéntica y huella AST del cuerpo idéntica (`47808a06a34eea201af8156a9eba4845`). |
| **D-2**: `invoice_total` e `invoice_discrepancy` existen; `amount` no cambió de significado | **VERDE.** |
| **D-2**: una cuenta con diferencia no se aprueba sola | **VERDE.** `409 INVOICE_DISCREPANCY` nombrando **las dos cifras**; `confirm_discrepancy: true` la aprueba y queda registrado quién. |
| **D-2**: copiaron `confirm_price`, no un segundo dialecto | **VERDE.** Mismo `409`+repetir, y `discrepancy_confirmed_by_employee_*` guardado. |
| **D-3**: tres métodos, default `by_hours` | **VERDE** en el backend; **ROJO menor** en el cliente (H-7). |
| **D-3**: el `GET` de la propuesta no escribe nada | **VERDE.** `TipPayout`, `TipPayoutDistribution` y `CashMovement` contados antes y después. |
| **D-3**: la escritura sigue siendo `register_tip_payout` | **VERDE.** Ninguna tabla de reparto nueva; `app/payroll/` no escribe un payout a mano. |
| Ingeniería de menú sobre el costo **congelado**, en micros, redondeando una vez | **VERDE** por AST (`unit_cost_micros`/`theoretical_cost_micros`, sin `item.unit_cost`, sin leer el costo de `Recipe`/`Product`). **Ver `gaps`**: el cruce dinámico —vender, cambiar la ficha, exigir que el período no se mueva— no se pudo armar en el tiempo de esta corrida. |
| Varianza por plato declarada `method: "prorated"` en respuesta **y** en pantalla | **VERDE.** Literal fijado en el esquema; la pantalla lo muestra tal cual (y el invariante de pantalla prueba que no lo tiene quemado). |
| Un gasto que **no** pasa por el cajón no toca `compute_breakdown`; el que sí, entra con causa tipada existente | **VERDE.** Y no se inventó ninguna causa nueva. |
| La mano del dueño cuadra: `retirado − consignado − gastado = saldo` | **VERDE** en la identidad. **Ver H-6**: el flujo «consignar plata de la mano sin imputarla a un turno» no se puede registrar desde la pantalla. |
| Un mismo peso no está «en la mano» y «en el banco» a la vez | **VERDE.** Retiro → consignación → el saldo baja exactamente lo consignado. |
| La conciliación no duplica la cuenta por cobrar de `channels` | **VERDE.** Filas de `platform_receivables` iguales antes y después. |
| Nada financiero se borra | **VERDE.** Ningún `db.delete(...)` en los cuatro dominios. |
| Ninguna regla de negocio responde `500` | **VERDE.** 19 rutas × 2 formas (parámetros mínimos y rango invertido). |

---

## 5. Estado de la cadena de Alembic

```
0016_active_channels_backfill   (poste, de 2c)
  └─ 0017_banking        down_revision = "0016"   T1
       └─ 0018_expenses  down_revision = "0017"   T2
            └─ 0019_invoice_total  down_revision = "0018"   T2 (D-2)
                 └─ 0020_payroll   down_revision = "0019"   T3   ← ÚNICA CABEZA
```

**`0021_analytics` NO existe, y eso es correcto.** T4 construyó `app/analytics/`
sin `models.py`: todo se deriva, nada se almacena, que es lo que §6.1 pide
(«derivar en vez de almacenar»). La spec previó este caso: «si tu territorio no
necesita tablas, no crees la migración y decilo en tu entregable». Como `0021` era
**la última** de la cadena, **no hay nada que reencadenar**: `0020` es la cabeza.

```
$ cd backend && alembic heads
0020 (head)
```

Una sola cabeza. `alembic upgrade head` sigue existiendo como comando.

**Lo que este auditor NO verificó**, y queda para el paso de verificación del
orquestador: que `alembic upgrade head` desde cero corra **en Postgres**, no sólo
en SQLite (error repetido nº4: un `batch_alter_table` que en SQLite pasa y en
Postgres tumba el deploy). Mis invariantes leen la cadena, no la ejecutan contra un
Postgres.

---

## 6. Comandos de verificación corridos, y su resultado literal

```
$ cd backend && TMPDIR=/tmp/pt-auditor-fase3 python -m pytest tests/audit/test_contract_fase3_invariants.py -q
3 failed, 129 passed, 1 skipped, 205 warnings in 321.57s (0:05:21)

  FAILED ::test_no_new_domain_decides_by_itself_which_payment_methods_are_electronic   (H-5)
  FAILED ::test_pending_deposits_reports_null_to_deposit_with_a_reason_for_a_shift_closed_without_count   (H-4)
  FAILED ::test_d4_erasing_a_customer_anonymizes_the_pending_refund_but_never_the_money   (H-1)
  SKIPPED ::test_variance_by_dish_declares_itself_prorated_in_the_response
          "AUSENCIA de precondición: no hay conteo aplicado (count_id=1) sobre el que
           medir varianza; el invariante del método se cobra igual en el test de
           esquema de abajo"

$ cd backend && python -m mypy app
Success: no issues found in 147 source files

$ cd frontend && npm run typecheck
> tsc --noEmit -p tsconfig.app.json
(sin salida: limpio)

$ cd frontend && TMPDIR=/tmp/pt-auditor-fase3 npx vitest run src/audit/money-after-drawer.test.ts \
      src/audit/break-even.test.ts src/audit/payroll.test.ts src/audit/menu-engineering.test.tsx
 Test Files  2 failed | 2 passed (4)
      Tests  4 failed | 30 passed (34)

$ cd backend && alembic heads
0020 (head)
```

**No corrí la suite completa de backend ni de frontend, ni `npm run build`.** Cinco
agentes trabajaban en paralelo sobre el mismo árbol; N suites simultáneas se pisan
(CPU, temporales, bases de prueba borradas por el teardown ajeno) y no terminan
nunca. Temporales en `TMPDIR=/tmp/pt-auditor-fase3`, propio.

**Archivos que escribí, y son los únicos:**

- `backend/tests/audit/test_contract_fase3_invariants.py`
- `frontend/src/audit/money-after-drawer.test.ts`
- `frontend/src/audit/break-even.test.ts`
- `frontend/src/audit/payroll.test.ts`
- `frontend/src/audit/menu-engineering.test.tsx`

**Ningún archivo de producción, ni de backend ni de frontend**, ni siquiera para
arreglar lo que encontré roto: lo que encontré está escrito como test rojo con su
dueño, y lo arregla su dueño. Ningún nombre pisa uno existente; los
`tests/audit/test_<dominio>_invariants.py` de los cinco constructores no se
tocaron.

---

## 7. Dos invariantes que estaban mal medidos, y se corrigieron por escrito

Un invariante no se acota para que algo pase. Pero un invariante **mal medido** no
es un invariante: es ruido que enseña a ignorar el rojo. Los dos casos, declarados:

1. **`test_compute_breakdown_stays_the_only_formula_of_the_expected_cash`** cazaba
   el nombre suelto `expected` y marcó `app/banking/service.py:710` y `:892`. Ahí
   `expected` es «lo esperado del datáfono / de la plataforma» — una cifra
   distinta, que **el propio contrato de §2 nombra así** («lo esperado, lo
   liquidado, la diferencia»). Se acotó a `expected_cash`, que es el nombre del
   campo del turno, y se conservó la firma fuerte de la fórmula
   (`cash_sales`+`pickups`). **Se corrigió el invariante, que estaba mal; no se
   ablandó una regla que estuviera bien.**

2. **`menu-engineering.test.tsx`**, primera versión, medía `margin_pct_bp` en
   pantalla. La pantalla no publica ese campo — y no mostrar un dato **no es
   mentir**: la clasificación Kasavana–Smith va por popularidad y margen **en
   pesos**, que sí se muestran. El invariante se reescribió para medir el campo que
   la pantalla de verdad pinta (`contribution_margin`), con una respuesta
   inconsistente a propósito, que es lo que separa «pinta» de «calcula y coincide».

Y un límite, declarado como límite y no como permiso: el margen **porcentual** no
se mide sobre el `textContent` concatenado de una tabla (las celdas «$ 12.345» y
«100 %» quedan pegadas y parecen un decimal). Si algún día la pantalla lo muestra,
el invariante que lo cobre tiene que leer **la celda**, no el contenedor.

---

## 8. `gaps` — lo que no pude auditar, y por qué

1. **El cruce dinámico del costo congelado de la ingeniería de menú.** Lo verifiqué
   **por AST** (`app/analytics/` usa `unit_cost_micros`/`theoretical_cost_micros`,
   nunca `item.unit_cost` en pesos por línea, y nunca lee el costo de
   `Recipe`/`Product`), que es fuerte pero no es el cruce que la misión pide:
   **vender, cambiar la carta DESPUÉS, y exigir que el resultado del período no se
   mueva**. Armar esa precondición completa —insumo, ficha técnica, venta, cambio
   de ficha— en el tiempo de esta corrida no alcanzó. **Es el invariante que más
   falta**, y es el que yo pediría en la siguiente iteración.

2. **La varianza por plato en un período real.** Mismo motivo:
   `test_variance_by_dish_declares_itself_prorated_in_the_response` necesita un
   conteo aplicado, y armar dos conteos completos consecutivos probaría
   `app/inventory/` más que a T4. El `method: "prorated"` se cobra por el esquema
   publicado, que es más fuerte (no se puede apagar con un parámetro), pero la
   **aritmética del prorrateo** —que Σ de las filas cuadre con
   `total_variance_value − unattributed_variance_value`— **no está auditada**.

3. **«Sostenido» (D-1) con 2 de 3 ventanas reales.** Auditado el caso «menos de 2
   ventanas → `null` con motivo, nunca verde», que es el que la decisión subraya.
   **No auditado** el caso positivo: que con 3 ventanas y 2 en rojo devuelva `true`,
   y con 3 y 1 devuelva `false`. Necesita el mismo andamiaje de conteos del gap 2.

4. **`alembic upgrade head` desde cero en Postgres.** Mis invariantes leen la cadena
   de migraciones y corren `alembic heads`; no ejecutan el upgrade contra un
   Postgres real. El error repetido nº4 (un `batch_alter_table` que en SQLite pasa
   y en Postgres tumba el deploy) **sólo se ve ahí**, y es del paso de verificación
   del orquestador.

5. **El recorrido en navegador real.** Es el punto 8 de la lista de «lo que más
   veces salió mal»: siete defectos de la fase 2 los encontró caminar la aplicación,
   no los 1.395 tests. H-2 y H-3 son exactamente de esa familia —dos pantallas que
   pasan sus tests y no cargan nunca contra el servidor real— y los encontré por
   cruce estático, no caminando. **Puede haber más de la misma familia que no vi.**

6. **Las dos observaciones que T1 declaró y que confirmo, sin escribirles un rojo
   propio porque el remedio está fuera de esta fase:**
   - `spent_on_tips` de la mano del dueño cuenta **todo** `TipPayout(method="cash")`
     como gastado de la mano, aunque el dueño lo haya pagado del cajón (donde ya
     redujo `to_deposit`). Es una **doble resta**, no un doble conteo: el sesgo
     muestra **menos** plata en la mano, que es la dirección tolerada por la regla
     dura, y T1 lo declaró. El remedio correcto —un campo en `TipPayout` que diga
     de dónde salió la plata— es de `app/shifts/models.py`, territorio de nadie en
     este pedido.
   - No hay test de carrera real (dos consignaciones concurrentes) contra Postgres.
     El `SELECT ... FOR UPDATE` está; en SQLite no bloquea de verdad.

7. **La reachability de «Varianza por plato» y «Salud sostenida» detrás de
   `inventory.variance` en vez de `analytics.menu_engineering`.** T5 la declaró como
   decisión propia y pidió que el Conciliador la confirme. **Mis invariantes la
   aceptan** —`inventory.variance` es una función habilitable y el gate funciona
   encendido y apagado— pero **no es una decisión de auditoría**: es de diseño, y el
   orquestador tiene que ratificarla o corregirla. La dejo señalada, no resuelta.

8. **Lo que NO audité porque no es de esta fase.** El `to_deposit` que
   `app/shifts/service.py:1257` escribe en un cierre administrativo es una cifra
   derivada del libro presentada con el mismo nombre que un snapshot de conteo. H-4
   lo trata donde se **publica** (T1, que es quien puede arreglarlo sin salir de su
   territorio), pero la raíz está en `app/shifts/`, de 1b. **Si el orquestador
   quiere cerrarlo de raíz**, la pregunta es si ese campo debería quedar en `NULL`
   en un cierre sin conteo — y esa es una decisión de negocio, no un bug que yo
   pueda declarar.
