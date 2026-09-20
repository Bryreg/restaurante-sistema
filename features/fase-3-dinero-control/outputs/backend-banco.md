# `backend-banco` (T1) — entregable de Fase 3

Territorio: `backend/app/banking/**`, `backend/alembic/versions/0017_banking.py`,
`backend/tests/banking/**`, `backend/tests/audit/test_banking_invariants.py`, y
la excepción D-4 en `backend/app/refunds/service.py` + su test.

**Iteración 2 (ajuste del Maestro, derivado del Conciliador) — resumen.**
Tres hallazgos, los tres reales:

- **C1/H-1 (bloqueante), cerrado**: `anonymize_pending_refunds_for_customer`
  no tenía punto de llamada real. Agregué UNA línea a
  `app/customers/service.py::erase_customer` que la invoca (import
  protegido con `find_spec_safe`, la excepción de territorio que autorizó
  §1 de la spec) — detalle en `§5`.
- **C4/H-4 (bloqueante), cerrado**: `pending_deposits` cortaba con
  `shift.to_deposit is None`, que un cierre administrativo NUNCA deja en
  `NULL` (escribe `expected - opening_cash_fixed`); la condición correcta
  es `Shift.closed_without_count`. Además, decisión ratificada del Maestro:
  imputar una consignación a un turno cerrado sin conteo ahora se rechaza
  (`400 SHIFT_CLOSED_WITHOUT_COUNT`) — detalle en `§4`.
- **C6/H-5 (advertencia), cerrado**: la conciliación de datáfono y el
  libro del banco filtraban `Payment.method == "card"`/`"transfer"` a mano;
  ahora derivan ese conjunto preguntándole a `payment_bucket`
  (`app.shifts.hooks`), la única autoridad — detalle en `§4`.

El resto del dominio (`app/banking/`) no cambió: 35 tests de la ronda 1 +
5 nuevos = 40, todos verdes; `mypy app` limpio (147 archivos, incluido el
error que T2 reportó en la línea 480, que ya no reproduce). Ver `§8`.

---

## 1. La llave anti doble conteo: retiro vs consignación

**El problema que resuelve.** Una consignación no es un movimiento de caja: la
plata ya salió del cajón antes de consignarse (por un retiro a mitad de turno,
o por el sobrante que queda al cerrar). Si dos registros distintos pudieran
imputarle plata al mismo turno más allá de lo que ese turno tiene pendiente,
el mismo peso quedaría "en la mano" y "en el banco" a la vez — la definición
exacta de doble conteo que `docs/SPEC-NEGOCIO.md §6.1` señala como el defecto
más caro del sistema de referencia.

**El diseño.**

- `Shift.to_deposit` (ya existe, `app/shifts/service.py:1035`) es el **techo**
  de lo que un turno cerrado puede consignar. Es un snapshot de cierre: una
  vez escrito, no vuelve a moverse por nada de este dominio.
- `BankDepositAllocation(deposit_id, shift_id, amount)` es la imputación de
  una consignación a un turno concreto. Una consignación puede tener **cero,
  una o varias** imputaciones (una vuelta al banco puede cubrir varios días de
  caja, o puede ser plata retirada que se consigna sin atar a un turno
  puntual — sigue contando para el libro del banco y la mano del dueño, pero
  no reduce el saldo de ningún turno en particular).
- **Antes de escribir una sola fila** (`app.banking.service._validate_
  allocations`, llamado por `create_deposit`), se valida, turno por turno:

  ```
  Σ imputaciones VIVAS de este turno (de CUALQUIER consignación) + la nueva
  imputación  <=  Shift.to_deposit
  ```

  Si no cuadra, `400 DEPOSIT_EXCEEDS_PENDING` nombrando el sobrante exacto, y
  **no queda nada escrito** (ni la consignación ni ninguna imputación —
  probado en `tests/banking/test_deposits.py::
  test_deposit_allocation_cannot_exceed_shift_to_deposit` y
  `test_two_deposits_cannot_together_exceed_shift_to_deposit`, y como
  invariante cruzado con imputaciones chicas repetidas en
  `tests/audit/test_banking_invariants.py::
  test_anti_double_count_holds_across_many_small_deposits`).
- El turno se lee con `SELECT ... FOR UPDATE`
  (`app.banking.service._closed_shift_for_update`) para que dos
  consignaciones concurrentes no pasen las dos la validación contra el mismo
  saldo (el mismo patrón de `app.fiscal` para el consecutivo). Las
  imputaciones de un mismo `POST /admin/deposits` se ordenan por `shift_id`
  antes de bloquear, para no generar un deadlock si dos requests concurrentes
  tocan los mismos turnos en distinto orden. (No hay un test de carrera real
  contra Postgres en este entregable — ver `gaps`.)
- **Reversar una consignación** (`POST /admin/deposits/{id}/reverse`, baja
  lógica — nunca se borra ni se edita el monto) libera su imputación de
  inmediato: `_allocated_live_for_shift` sólo suma imputaciones cuya
  consignación sigue `status=live`. Probado en
  `test_reverse_deposit_frees_up_outstanding_again` y como invariante
  (`test_deposit_never_touches_the_shift_close_snapshot`, que además prueba
  que ni consignar ni reversar tocan el snapshot del turno).

Esta llave es la que hace correcto todo lo demás: `GET /admin/deposits/pending`
(el saldo por turno) y `GET /admin/bank/owner-hand` (la mano del dueño, más
abajo) son las dos DERIVACIONES de la misma llave, no dos fórmulas distintas.

---

## 2. Qué construí, con el modelo de datos

Cuatro tablas nuevas (`0017_banking.py`), ninguna otra:

- **`bank_deposits`** — una consignación con comprobante obligatorio
  (`receipt_photo`, `min_length=1`). `business_date` + `deposited_at`,
  `bank_name`/`bank_reference` opcionales, `status` (`live`/`reversed`) +
  motivo/quién/cuándo de la reversa. Por qué existe: es el hecho físico
  "esta plata llegó al banco", con su rastro documental.
- **`bank_deposit_allocations`** — la llave anti doble conteo hecha tabla
  (arriba). Tabla de línea, sin `organization_id`/`store_id` propios (se
  consulta siempre vía `deposit_id`/`shift_id`, mismo criterio que
  `ReceptionLine` en `app.purchases`).
- **`card_settlements`** — una liquidación del datáfono: `sales_business_date`
  (qué ventas cubre) vs. `settled_business_date` (cuándo llegó la plata — el
  rezago es la resta, derivada en la salida, nunca guardada),
  `gross_amount`/`commission_amount`/`retention_amount` (el neto se deriva:
  `gross - commission - retention`), `status`
  (`recorded` → `matched` → o `reversed`). Por qué existe: el datáfono
  descuenta comisión y retención antes de acreditar, y la conciliación
  necesita las tres cifras por separado (nunca neteadas silenciosamente).
- **`platform_settlements`** — el pago que una plataforma hizo por un
  **rango** de días (paga semanal, típicamente, no por día), con
  `platform_id` (FK de sólo lectura a `app.channels.models.DeliveryPlatform`).
  Misma forma que `card_settlements`, mismo ciclo de vida.

**Lo que decidí NO construir como tabla nueva** (derivar en vez de almacenar,
§6.1): el "saldo por consignar" de un turno, la "mano del dueño" y las filas
`transfer` del libro del banco. Los tres se calculan en cada lectura; el
detalle está en `§4`.

---

## 3. Rutas publicadas, exactas

### Del contrato de API mínimo (sin cambios respecto a lo fijado)

| Ruta | Flag |
|---|---|
| `GET /admin/deposits` | `money.deposits` |
| `POST /admin/deposits` (`Idempotency-Key`) | `money.deposits` |
| `GET /admin/deposits/pending` | `money.deposits` |
| `GET /admin/bank/ledger` | `money.bank` |
| `GET /admin/bank/owner-hand` | `money.bank` |
| `GET /admin/reconciliation/card` | `money.bank` |
| `GET /admin/reconciliation/platform` | `money.bank` |
| `POST /admin/reconciliation/card/{id}/settle` (`Idempotency-Key`) | `money.bank` |

### Agregadas, fuera del contrato (declaradas, como pide §2)

Necesarias porque el contrato fija la CONCILIACIÓN (`GET`) y el "settle" de
tarjeta, pero no de dónde sale la liquidación cruda que se concilia — sin un
`POST` que la registre no hay `{id}` que conciliar:

| Ruta | Por qué |
|---|---|
| `POST /admin/deposits/{id}/reverse` (`Idempotency-Key`) | Nada financiero se borra: una consignación mal cargada necesita una baja lógica, no sólo un alta. |
| `POST /admin/reconciliation/card` (`Idempotency-Key`) | Registra la liquidación cruda del datáfono (lo que dice el extracto), paso previo a `.../settle`. |
| `GET /admin/reconciliation/card/settlements` | Lista las liquidaciones registradas (para poder elegir cuál conciliar o reversar). |
| `POST /admin/reconciliation/card/{id}/reverse` (`Idempotency-Key`) | Baja lógica de una liquidación cargada por error. |
| `POST /admin/reconciliation/platform` (`Idempotency-Key`) | Simétrico de `.../card` para plataformas: registra el pago crudo. |
| `GET /admin/reconciliation/platform/settlements` | Simétrico de listado. |
| `POST /admin/reconciliation/platform/{id}/settle` (`Idempotency-Key`) | El contrato sólo fija el `settle` de tarjeta; plataforma necesita el mismo verbo por la misma razón (conciliar es una acción explícita, no automática). |
| `POST /admin/reconciliation/platform/{id}/reverse` (`Idempotency-Key`) | Baja lógica, igual que el de tarjeta. |

Todas bajo `/api/v1`, todas de admin (`current_admin`), todas acotadas por
organización y sede (`admin_store`, 404 ante un id ajeno). Todas las que
mueven plata o estado aceptan `Idempotency-Key` reservada dentro de la
transacción (`app.core.idempotency.run_idempotent`), incluidas las que
agregué (no sólo las que el contrato exigía explícitamente).

No cambié ninguna ruta del contrato. No necesité ninguna ruta de dispositivo:
las once capacidades de este territorio son enteramente de escritorio.

---

## 4. Cómo derivo el saldo por consignar, y la prueba de que no recalculé `to_deposit`

**Derivación** (`app.banking.service.pending_deposits`, detrás de
`GET /admin/deposits/pending`): por cada turno `CLOSED` del período (join con
`BusinessDay` para la fecha de negocio — nunca derivada de un timestamp UTC),

```
to_deposit  = Shift.to_deposit                          (LEÍDO, no calculado)
deposited   = Σ BankDepositAllocation.amount vivas de este turno
outstanding = to_deposit - deposited                     (None si to_deposit es None)
```

**Corrección de la iteración 2 (bloqueante C4/H-4 del Conciliador).** La
condición real de "no hay saldo por consignar verificable" **no es**
`Shift.to_deposit is None` — es `Shift.closed_without_count`. El Conciliador
verificó que `app/shifts/service.py` (cierre administrativo, `~línea 1257`)
escribe `to_deposit = expected − opening_cash_fixed` en TODO cierre sin
conteo: una cifra derivada del libro, nunca `NULL`. Mi condición original
sólo miraba `to_deposit is None`, así que esa rama del `reason` era código
muerto y un turno abandonado (sin arqueo real) se publicaba con una CIFRA,
indistinguible de un turno arqueado a mano con saldo real cero. Corregido a:

```
if shift.closed_without_count or shift.to_deposit is None:
    to_deposit = None; outstanding = None
    reason = "cerró administrativamente, sin conteo: to_deposit es derivado
              del libro, no un arqueo" (si closed_without_count)
           | "cerró sin conteo" (defensa: to_deposit is None sigue
              cubierto, aunque hoy ningún camino HTTP deja esa combinación)
else:
    to_deposit = Shift.to_deposit; outstanding = to_deposit - deposited
```

`tests/banking/test_deposits.py::
test_pending_deposit_distinguishes_administrative_null_from_counted_zero`
prueba los DOS casos en el mismo período para que se distingan entre sí: un
turno cerrado `POST /admin/shifts/{id}/close-administrative` (con el reloj
de prueba adelantado hasta que `is_shift_stale` lo permite) publica
`to_deposit: null` + `reason`; un turno arqueado a mano con
`counted_cash == opening_cash_fixed` (saldo real $0) publica `to_deposit: 0`
sin `reason` — publicar `null` ahí escondería un dato real, y publicar un
número en el primer caso sería el cero mudo con otro disfraz (error
repetido nº7).

**Decisión declarada (ratificada por el Maestro, no la reabro): si "por
consignar" publica `null` para un turno cerrado sin conteo, imputarle una
consignación a ESE turno se rechaza.** Si no, la misma pregunta ("¿cuánto
queda por consignar de este turno?") vuelve a tener dos respuestas — el
mismo H-4 de 2b otra vez. Antes, `_closed_shift_for_update` sólo cortaba con
`shift.to_deposit is None` (que un cierre administrativo nunca deja en
`NULL`), así que un turno sin conteo SÍ era imputable — la misma grieta que
en la publicación. Agregué el rechazo ahí mismo: `shift.closed_without_count`
→ `400 SHIFT_CLOSED_WITHOUT_COUNT`, con un mensaje que además le dice a
quien lo lea que la consignación SÍ se puede registrar sin imputarla a ese
turno (`allocations: []`, que ya funcionaba — `DepositIn.amount` es un
campo propio del usuario, no depende de ningún turno). Esto no deja plata
sin poder consignarse; sólo le saca el turno concreto como destino de la
imputación. Probado en `tests/banking/test_deposits.py::
test_create_deposit_rejects_allocation_to_shift_closed_without_count`
(rechaza la imputación al turno, y confirma que la misma consignación se
acepta con `allocations: []`).

**La prueba de que no hay una segunda matemática**: `to_deposit` se LEE con
`db.get(Shift, ...)` — no hay una resta `counted - fixed - tips` en ningún
archivo de `app/banking/`. Grep de control:

```
$ grep -rn "opening_cash_fixed\|counted_cash_total" app/banking/
(sin resultados)
```

`tests/banking/test_deposits.py::
test_pending_deposit_reads_shift_to_deposit_without_recalculating` cierra un
turno por HTTP (`POST /shifts/{id}/close`), lee el `to_deposit` que ESE
endpoint devuelve, y verifica que `GET /admin/deposits/pending` reporta
**el mismo número, exacto** — si `app/banking` tuviera su propia fórmula,
cualquier divergencia en el redondeo o en qué se resta la delataría.
`tests/audit/test_banking_invariants.py::
test_deposit_never_touches_the_shift_close_snapshot` va un paso más allá:
congela `(expected_cash, counted_cash, difference, to_deposit)` del turno
ANTES de consignar y reversar, y prueba que los cuatro siguen bit a bit
iguales después de las dos operaciones.

**La mano del dueño** (`GET /admin/bank/owner-hand`,
`app.banking.service.owner_hand`) es la misma llave, vista distinta:

```
withdrawn = Σ CashPickup.amount vivos del período     (retiro a mitad de turno)
          + Σ Shift.to_deposit de turnos CLOSED        (el sobrante al cerrar)
deposited = Σ BankDeposit.amount vivas del período
spent     = Σ PendingRefund.amount (settled_from=OWNER, del período)
          + Σ TipPayout.total_amount (method="cash", del período)
balance   = withdrawn - deposited - spent
```

`spent` son las dos ÚNICAS fuentes de "salió de la mano sin pasar por un
`CashMovement`" que el sistema ya documenta explícitamente: el `settle_from
=owner` de `app.refunds.service.settle_pending_refund` (SPEC-NEGOCIO §6.3,
"no crea movimiento de caja") y el `TipPayout(method="cash")` de
`app.shifts.tips.register_tip_payout` ("no crea ningún `CashMovement`"). La
ambigüedad de esta segunda fuente está declarada en `§ gaps`.
`tests/audit/test_banking_invariants.py::test_owner_hand_equation_holds_
literally` prueba la ecuación literal para cualquier escenario, y
`tests/banking/test_bank_ledger_owner_hand.py` la prueba con números
concretos (retiro + cierre + consignación parcial; y con un `PendingRefund`
saldado por el dueño).

**Corrección de la iteración 2 (advertencia C6/H-5 del Conciliador).** La
conciliación de datáfono (`card_reconciliation_rows`) y el renglón
"transferencias" del libro del banco filtraban `Payment.method == "card"` /
`== "transfer"` escritos a mano — una SEGUNDA clasificación de qué medio
cae en qué bolsillo, cuando `app.shifts.hooks.payment_bucket` es, por
diseño explícito del proyecto (su propio docstring documenta el bug H-2/H-4
de 2b que produjo esa duplicación antes), el único lugar autorizado a
responder esa pregunta. Corregido sin mover el cálculo a Python ni perder
el SQL: dos tuplas módulo-nivel, derivadas UNA vez preguntándole a
`payment_bucket` sobre cada valor de `app.payments.models.
PAYMENT_METHOD_VALUES` (el mismo catálogo que usa `Payment`):

```python
CARD_PAYMENT_METHODS = tuple(m for m in PAYMENT_METHOD_VALUES if payment_bucket(m, None) == "card")
TRANSFER_PAYMENT_METHODS = tuple(m for m in PAYMENT_METHOD_VALUES if payment_bucket(m, None) == "transfer")
```

y los dos `WHERE` pasan a `Payment.method.in_(CARD_PAYMENT_METHODS)` /
`.in_(TRANSFER_PAYMENT_METHODS)`. Así, si mañana se agrega un medio nuevo,
lo clasifica la única autoridad y `app/banking` no lo omite en silencio.
`tests/banking/test_reconciliation.py::
test_card_and_transfer_method_sets_are_derived_from_payment_bucket_not_
hardcoded` prueba, desde afuera de `app/banking/`, que los dos conjuntos
siguen siendo exactamente el resultado de esa derivación (no una copia
hardcodeada) y que no se solapan; la cobertura end-to-end de que un pago
`method="card"` entra a `GET /admin/reconciliation/card` ya estaba en
`test_card_reconciliation_matches_expected_against_settlement` (ronda 1) y
sigue pasando sin cambios.

---

## 5. D-4: cómo quedó, y qué guarda exactamente la auditoría

**Alcance real del modelo.** `PendingRefund` sólo guarda dos campos
personales de la fila: `customer_name` y `customer_doc_number` — no hay
columna de teléfono en esta tabla (la mención de "nombre y teléfono" en la
decisión es la formulación general de D-4; en este modelo concreto sólo
aplica el nombre). `customer_doc_number` **no se anonimiza**: es la llave con
la que la persona reclama la devolución presentándose con su documento — D-4
es explícita en que "la devolución le sigue siendo pagadera a quien aparezca
con el documento". Anonimizarlo dejaría la plata sin poder pagarse, que es
exactamente lo que D-4 prohíbe.

**Lo que hice** (`app.refunds.service.anonymize_pending_refunds_for_
customer`, la única función nueva en el único archivo que tenía autorizado
tocar):

- Recibe `customer_id` + `organization_id`, busca TODAS las `pending_refunds`
  de ese cliente en esa organización.
- Por cada fila no anonimizada todavía, pisa `customer_name` con
  `ANONYMIZED_CUSTOMER_NAME = "Titular suprimido"` — nada más. `amount`,
  `document_id`, `status`, `authorized_by_employee_*`, `settled_*` no se
  tocan.
- **Idempotente**: si `customer_name` ya es el placeholder, la fila se salta
  (no vuelve a auditar). Probado en
  `test_anonymize_is_idempotent_and_does_not_duplicate_audit`.
- La auditoría (`record_audit`, `entity="pending_refund"`,
  `action="anonymize_personal_data"`) guarda `before={"cleared_fields":
  ["customer_name"]}` — **sólo el nombre del campo**, nunca "Juan Pérez" ni
  ningún dato suprimido — y `after={"customer_name": "Titular suprimido"}`
  (el placeholder, que no es un dato personal). Es el mismo criterio que
  `app.customers.service._customer_audit_view` ya usa para el maestro, y
  cierra explícitamente el bloqueante B-1 de 1b-2 (que esa lección no se
  repitiera era condición explícita de D-4). Probado en
  `test_audit_before_never_carries_the_suppressed_value` (con `deep_
  contains_text` sobre TODO el `AuditLog`, no sólo `before`) y otra vez como
  invariante cruzado en `tests/audit/test_banking_invariants.py::
  test_d4_anonymization_audit_never_leaks_the_name`.
- `test_anonymize_only_touches_the_named_customer` prueba que un segundo
  cliente con otra devolución pendiente no se toca.

**Wiring cerrado en la iteración 2 (bloqueante C1/H-1 del Conciliador).**
La ronda 1 dejó `anonymize_pending_refunds_for_customer` completa y probada
pero sin ningún punto de llamada real: `erase_customer`
(`app/customers/service.py:204`) es el único disparador real de una
supresión de cliente, y sólo mis propios tests la llamaban directo. El
Conciliador lo verificó abriendo el árbol (`grep` sobre `*.py`: sólo
`app/refunds/service.py` y mis tests la mencionaban) y lo marcó bloqueante:
una función que nadie llama no cumple la Ley 1581 — el titular pide
supresión y su nombre sigue en `pending_refunds`.

**Lo que agregué, exactamente** (única línea de código nueva de este
territorio en `app/customers/service.py`, la única excepción de territorio
adicional que autorizó el bloqueante — ver `§7`): en
`erase_customer`, **después** del `db.flush()` que ya deja el maestro
anonimizado y **antes** del `db.add(CustomerDataRequest(...))` /
`record_audit`, una llamada a `anonymize_pending_refunds_for_customer`,
protegida con `app.core.modules.find_spec_safe("app.refunds.service")` e
importada DENTRO de la función (nunca en el tope del módulo) — mismo patrón
con el que `app.shifts.hooks.get_sales_totals` protege su import de
`app.payments.models`. Si `app.refunds` no está presente, `erase_customer`
sigue funcionando exactamente igual. Queda naturalmente idempotente: está
después del guard `if customer.erased_at is not None: return customer`, y
la función de `refunds` ya se saltea las filas ya anonimizadas. **No toqué
el `before=` de `record_audit`** de `erase_customer` ni agregué el dato
suprimido a ninguna auditoría — esa es la lección del bloqueante B-1 de
1b-2 y sigue intacta.

**La prueba de que la puerta real ya la toca**: `tests/banking/
test_d4_pending_refunds_erasure.py::
test_erase_customer_over_http_anonymizes_pending_refunds` crea un cliente
con una `PendingRefund` viva, llama `POST /api/v1/admin/customers/{id}/erase`
**por HTTP** (no la función de servicio directa — el hallazgo era
precisamente que ese camino no la tocaba) y confirma que `customer_name`
quedó anonimizado mientras `amount`, `document_id`, `status` y
`customer_doc_number` quedaron idénticos.
`test_erase_customer_over_http_is_idempotent_for_pending_refunds` prueba
que una segunda llamada HTTP no duplica la auditoría de `pending_refund`.
El resto de los tests de ese archivo (`test_anonymize_*`,
`test_audit_before_never_carries_the_suppressed_value`) siguen llamando
`anonymize_pending_refunds_for_customer` directo porque son tests de unidad
de esa función — el detalle fino de auditoría no tiene una ruta HTTP propia
que lo exponga — y quedan declarados así en el docstring del archivo.

`tests/audit/test_contract_fase3_invariants.py` (territorio del auditor)
tenía ya su propio invariante para este mismo hallazgo; no lo toqué —
tiene que ponerse en verde solo con este wiring.

---

## 6. Migración: `0017` sobre `0016`

`backend/alembic/versions/0017_banking.py`, `revision="0017"`,
`down_revision="0016"` — exactos, como fija §2. Crea las cuatro tablas de
arriba, con un índice por FK y por filtro de pantalla y los mismos
`CheckConstraint` que los modelos. Ningún `ALTER` sobre una tabla ajena
(`payments`, `shifts`, `delivery_platforms`...), así que no hay ningún
`batch_alter_table` ni riesgo de `DependentObjectsStillExist` en Postgres —
son cuatro `create_table` limpios. `_enum` sin `create_constraint`: los
`status` son `VARCHAR` planos en los dos motores.

Verificado en aislamiento (no con `alembic upgrade head`, que ahora mismo
mezcla migraciones de otros tres agentes construyendo en paralelo):

```
$ alembic upgrade 0017   # desde 0016, en SQLite: limpio
$ alembic downgrade 0016 # las cuatro tablas desaparecen, ninguna otra se toca
```

`alembic heads` en este momento ya muestra `0019` (T2 llegó hasta ahí): mi
tramo de la cadena (`0016 -> 0017`) es consistente con eso. Ver `gaps` por un
problema que encontré en `0019` (no mío, no lo toqué).

---

## 7. Qué NO toqué

`app/main.py`, `app/core/models_registry.py`, `app/core/features.py`, los
`__init__.py` de los cuatro paquetes nuevos, `app/shifts/**`,
`app/channels/**`, `app/payments/**`, `app/purchases/**` (más allá de LEER
sus modelos — nunca escribo en esos archivos, confirmado con
`git diff --stat`), `app/reports/**`, `app/inventory/**`, `app/stores/**`,
`app/analytics/`, `app/payroll/`, `app/expenses/`,
`alembic/versions/0019_invoice_total.py` (territorio de T2), `frontend/**`,
y ningún archivo nuevo en `app/core/`. De `app/refunds/` sólo toqué
`service.py` (la excepción D-4, más una actualización de docstring en la
iteración 2 — nada de lógica); no toqué `app/refunds/models.py`,
`router.py` ni `schemas.py`. **De `app/customers/` toqué únicamente
`service.py::erase_customer`** — la única excepción de territorio adicional
que autorizó el bloqueante C1/H-1 de la iteración 2 (una llamada de 15
líneas, con su import protegido adentro de la función, nada más de ese
archivo ni de ningún otro archivo de `app/customers/`).

---

## 8. Verificación — comandos corridos y resultado literal

**Iteración 2** (después de C1, C4, C6 y el `mypy` que reportó T2):

```
$ cd backend && TMPDIR=/tmp/pt-backend-banco python -m pytest tests/banking tests/audit/test_banking_invariants.py -q
........................................                                 [100%]
40 passed, 81 warnings in 111.69s (0:01:51)

$ cd backend && python -m mypy app
Success: no issues found in 147 source files
```

40 = los 35 de la ronda 1 + 5 nuevos (2 tests HTTP de D-4/C1, 2 tests de
C4 — distinción null/0 y rechazo de imputación —, 1 test de C6 sobre los
conjuntos derivados). El error que T2 reportó en
`app/banking/service.py:480` (`Argument 1 to "int" has incompatible type
"int | None"; expected "int"`) ya no reproduce contra el árbol actual —
`mypy app` corre limpio sobre las 147 fuentes, incluidas
`app/customers/service.py` y `app/refunds/service.py` (los dos archivos que
esta ronda tocó fuera de `app/banking/`). No hay una segunda ocurrencia del
mismo patrón (`int(...)` sobre una columna `nullable`) en el archivo: todas
las conversiones a `int` en `app/banking/service.py` van sobre expresiones
`func.coalesce(..., 0)` o llevan su propio `or 0` explícito, ver `§4`.

(Las advertencias son todas `InsecureKeyLengthWarning` de PyJWT sobre la
clave HMAC de prueba — preexistentes en todo el proyecto, ninguna de este
territorio.)

También corrí, aparte (no es la suite del territorio, es diagnóstico de la
migración, sin tocar ninguna base compartida — `sqlite:////tmp/pt-backend-
banco/alembic-check/test.db`, propia), sin cambios respecto a la ronda 1
(la migración `0017` no se tocó en esta iteración):

```
$ alembic upgrade 0017    # limpio
$ alembic downgrade 0016  # limpio, simétrico
```

No corrí `pytest -q` (la suite completa) ni `npm run build`: son del paso de
verificación del orquestador, con el árbol quieto.

---

## 9. `gaps`

1. **D-4: gap CERRADO en la iteración 2** (bloqueante C1/H-1 del
   Conciliador). `anonymize_pending_refunds_for_customer` ya tiene su punto
   de llamada real: `app/customers/service.py::erase_customer` la invoca
   después de anonimizar el maestro, con el import protegido con
   `find_spec_safe("app.refunds.service")` DENTRO de la función. Ver `§5`
   para el detalle completo y `tests/banking/
   test_d4_pending_refunds_erasure.py::
   test_erase_customer_over_http_anonymizes_pending_refunds` para la prueba
   de punta a punta por HTTP.

2. **`spent_on_tips` de la mano del dueño es una aproximación declarada, con
   sesgo hacia "menos plata en la mano".** `TipPayout(method="cash")` no
   distingue si el dueño pagó del CAJÓN (con un `CashMovement(cause=
   tip_payout)` aparte, que ya redujo `to_deposit` de ese turno) o de la
   MANO (plata ya retirada). Sin ese vínculo, cuento TODO pago en efectivo
   como gastado de la mano — el sesgo que "muestra menos plata" (la regla
   dura del proyecto). Si en algún caso el pago salió del cajón, esta cifra
   sobreestima `spent` y subestima `balance` en esa misma proporción. La
   solución correcta es un campo en `TipPayout` (territorio de T3,
   `app/shifts/models.py`) que diga de dónde salió la plata — lo señalo acá
   porque lo descubrí construyendo `owner-hand`, no porque sea mío
   arreglarlo.

3. **Sin test de la carrera real contra dos consignaciones concurrentes.**
   El `SELECT ... FOR UPDATE` está (`_closed_shift_for_update`), con el mismo
   criterio que usa `app.fiscal` para el consecutivo, pero no escribí un test
   con threads/procesos reales contra Postgres (needs infra que este
   territorio no monta). En SQLite el `FOR UPDATE` no bloquea de verdad entre
   conexiones, así que un test así no cazaría nada acá — quedaría cazando
   sólo en CI contra Postgres real.

4. **`0019_invoice_total.py` (T2, no mío): RESUELTO, verificado de nuevo en
   la iteración 2.** El gap de la ronda 1 (`op.add_column` con constraint
   inline rompía `alembic upgrade head` en SQLite) ya no reproduce: corrí
   `alembic upgrade head` desde cero contra una base SQLite propia
   (`sqlite:////tmp/pt-backend-banco/alembic-check2/test.db`, sin tocar
   ninguna base compartida) y la cadena completa `0001 → 0020` corre limpia,
   incluida mi `0017` y la `0019` de T2 (que ahora agrega la FK con
   `if op.get_bind().dialect.name != "sqlite"`, el mismo patrón que
   `docs/CONTEXTO-AGENTES.md §12` pide). No hice nada — T2 ya lo corrigió —,
   dejo la verificación acá para que el orquestador no tenga que repetirla.

5. **`money.bank`/`money.deposits` no tienen un límite de fecha para
   `from`/`to`.** Un rango de varios años sobre `bank_ledger`/`owner-hand`
   hace varias consultas agregadas sin paginar. Para el tamaño de datos de
   un restaurante esto no debería importar en la práctica, pero no medí el
   caso extremo.

6. **El catálogo de `app/core/features.py` no encadena `requires`
   automáticamente** (`assert_feature`/`require_feature` evalúan una sola
   clave). Lo resolví LOCALMENTE para `money.bank -> money.deposits`
   (`_require_bank()`), pero el mismo patrón (`inventory.replenishment` con
   dos `requires`, `analytics.menu_engineering` con uno) existe en OTROS
   territorios y no lo arreglé ahí — no es mi archivo. Si el orquestador
   quiere una solución genérica, el lugar natural es `app/core/features.py`
   (fuera de mi alcance) con un `require_feature` que camine `requires`
   recursivamente.
