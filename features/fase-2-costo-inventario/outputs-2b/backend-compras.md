# backend-compras — Compras, cuentas por pagar y el egreso del cajón (pedido 2b)

Construcción del dominio nuevo `purchases` (proveedores, recepciones, cuentas
por pagar y pagos) y de la mitad de `app/shifts/**` que le corresponde a este
agente (el egreso de caja de un pago a proveedor), delimitado exactamente por
`features/fase-2-costo-inventario/spec.md § Alcance de 2b`, secciones
`### Suppliers`, `### Receptions` y `### Payables and payments`.

---

## §1. Qué se construyó

- **Dominio nuevo `app/purchases/**`**: `__init__.py`, `models.py`,
  `schemas.py`, `service.py`, `hooks.py`, `router.py`, `seed.py`. Creado el
  `__init__.py` ANTES de nombrar `"purchases"` en `app.main.DOMAINS` y en
  `app.core.models_registry.MODEL_MODULES` (Paso 0).
- **Proveedores**: `GET/POST/PATCH/DELETE /admin/suppliers`,
  `GET /admin/suppliers/{id}/reliability`. Entidad canónica, NIT único por
  sede (índice parcial), baja lógica.
- **Recepciones**: `POST /receptions` (Idempotency-Key), confirmación
  atómica en una sola transacción (un `record_movement(cause=PURCHASE)` y un
  `create_stock_batch` por línea, más una `Payable` en `pending_review`);
  `GET /admin/receptions`, `GET /admin/receptions/{id}`,
  `PATCH`/`DELETE /admin/receptions/{id}` (reversa atómica con
  `authorizer_pin`). IVA bajo INC como mayor valor del costo (§4.1); dos
  guardas de tecleo (`PRICE_LOOKS_LIKE_PACKAGE`, `PRICE_JUMP`) que preguntan
  y nunca se corrigen solas.
- **Cuentas por pagar y pagos**: `GET /admin/payables`,
  `POST /admin/payables/{id}/approve`, `POST /admin/payables/{id}/payments`
  (Idempotency-Key; un pago en efectivo crea el egreso del turno en la misma
  transacción), `POST /admin/payables/{id}/payments/{payment_id}/void`. El
  saldo se deriva siempre de los pagos vivos: **no existe una columna
  `balance`**.
- **`app/shifts/**` (territorio propio en este pedido, el huérfano de 2a)**:
  `CashMovementCause.SUPPLIER_PAYMENT` nueva; `register_supplier_payment_expense`
  publicado en `app/shifts/hooks.py`; `format` declarado en el contrato de
  `admin_list_shifts` y `admin_employee_activity` (deuda de 1b-2 que este
  pedido cerraba, ver §7 de `outputs-2a/ENTREGA.md`).
- **Migración `alembic/versions/0011_purchases.py`**, `down_revision="0010"`:
  `suppliers`, `receptions`, `reception_lines`, `payables`,
  `purchase_payments`; recreación (defensiva, ver §5) del `cause` de
  `cash_movements` con `batch_alter_table(..., recreate="always")`.
- **`app/purchases/seed.py::seed_purchases(db, store)`**, idempotente: 2
  proveedores (uno `invoices_required`), 2 recepciones confirmadas con lote y
  vencimiento (la segunda con fecha posterior y vencimientos distintos), 1
  cuenta por pagar aprobada con un pago parcial.
- **`app/purchases/hooks.py`** publica hacia `reports` (vía `find_spec_safe`,
  nunca llamado desde adentro de este dominio): `overdue_payables`,
  `pending_review_payables_count`, `reception_invoice_ratio`.

Todo detrás de `require_feature("purchases")` (`400 FEATURE_DISABLED`),
acotado por organización y sede (`404` si es ajena), errores siempre
`{error:{code,message}}`, `Idempotency-Key` en recepción y en pago.

## §2. Modelo de datos

Tablas nuevas (migración `0011`):

- **`suppliers`**: `id, organization_id, store_id, name, nit, payment_term_days,
  contact_name, contact_phone, invoices_required, active, created_at,
  updated_at`. Índice único parcial `uq_suppliers_store_nit` (`store_id, nit`
  donde `nit IS NOT NULL`).
- **`receptions`**: `id, organization_id, store_id, supplier_id,
  invoice_number, invoice_date, no_invoice, photo, received_by_employee_id,
  received_by_employee_name, created_by_employee_id, created_by_employee_name,
  status (confirmed|reversed), price_confirmed,
  price_confirmed_by_employee_id/name, at, business_date, reversed_at,
  reversed_by_employee_id/name`. `received_by_*` es la PIN de atribución
  (quien recibió físicamente); `created_by_*` es el admin que operó la
  pantalla.
- **`reception_lines`**: `id, reception_id, ingredient_id, qty_received_base,
  qty_invoiced_base (milésimas de la unidad base), purchase_unit_price_micros
  (tal como se tecleó, por UNA unidad de compra), unit_cost_micros
  (PRE-impuesto, por unidad base, ya convertido con `purchase_factor`),
  final_unit_cost_micros (el que de verdad viaja al lote y al movimiento —
  con el IVA sumado bajo INC), tax_base, tax_rate, tax_amount (pesos/%,
  tal como la factura), lot_code, expires_at, stock_batch_id (sin FK dura,
  ver §5), stock_movement_id (FK real a `stock_movements`)`.
- **`payables`**: `id, organization_id, store_id, supplier_id, reception_id
  (único), amount (pesos, snapshot original), status (pending_review|
  approved|cancelled), due_date, approved_at, approved_by_employee_id/name,
  created_at, business_date`. **No hay columna `balance`.**
- **`purchase_payments`** (no `payments`, para no chocar con
  `app.payments.models.Payment`): `id, organization_id, store_id,
  payable_id, amount, method (cash|card|transfer|other), paid_at, reference,
  from_cash_drawer, cash_movement_id (FK real a `cash_movements`),
  employee_id/name, authorized_by_employee_id/name, created_at, voided_at,
  voided_reason, voided_by_employee_id/name`.

Tablas ajenas modificadas:

- `app/shifts/models.py::CashMovementCause` gana `SUPPLIER_PAYMENT`.
  `app/shifts/schemas.py::CashMovementCauseLiteral` gana `"supplier_payment"`.

## §3. Endpoints y sus códigos de error por camino de falla

| Endpoint | Éxito | Errores |
|---|---|---|
| `GET/POST /admin/suppliers` | `200`/`201` | `400 FEATURE_DISABLED`; `400 SUPPLIER_DUPLICATE_NIT`; `404` sede ajena |
| `PATCH /admin/suppliers/{id}` | `200` | `404`; `400 SUPPLIER_DUPLICATE_NIT` |
| `DELETE /admin/suppliers/{id}` | `200` (baja lógica) | `404` |
| `GET /admin/suppliers/{id}/reliability` | `200` (`null` sin recepciones) | `404` |
| `POST /receptions` | `201` | `400 FEATURE_DISABLED`; `404` proveedor/insumo ajeno o inexistente; `400 SUPPLIER_INACTIVE`; `400 INVOICE_REQUIRED`; `400 RECEIVED_BY_PIN_INVALID`; `400 VALIDATION_ERROR` (cantidades); `409 PRICE_LOOKS_LIKE_PACKAGE`; `409 PRICE_JUMP`; `400 IDEMPOTENCY_KEY_REQUIRED`; `400 IDEMPOTENCY_MISMATCH` |
| `GET /admin/receptions`, `GET /admin/receptions/{id}` | `200` | `404` |
| `PATCH`/`DELETE /admin/receptions/{id}` | `200` (reversa) | `400 RECEPTION_ALREADY_REVERSED`; `409 PAYABLE_HAS_PAYMENTS`; `409 LOT_CONSUMED`; `400`/`409 AUTHORIZATION_*` |
| `GET /admin/payables` | `200` | `404` sede ajena |
| `POST /admin/payables/{id}/approve` | `200` | `400 PAYABLE_ALREADY_APPROVED`; `400 PAYABLE_CANCELLED`; `400/409 AUTHORIZATION_*` |
| `POST /admin/payables/{id}/payments` | `201` | `409 PAYABLE_NOT_APPROVED`; `400 PAYMENT_EXCEEDS_BALANCE`; `409 NO_OPEN_SHIFT` (sólo si `from_cash_drawer`, y el pago NO queda); `400/409 AUTHORIZATION_*` |
| `POST .../payments/{id}/void` | `200` | `400 PAYMENT_ALREADY_VOIDED`; `404` pago que no pertenece a esa cuenta; `400/409 AUTHORIZATION_*` |

`AUTHORIZATION_REQUIRED`/`AUTHORIZATION_INVALID`/`AUTHORIZATION_NOT_ALLOWED`/
`PIN_LOCKED` los produce `app.auth.service.verify_authorizer` (territorio
ajeno, reusado tal cual).

## §4. Contrato publicado

**`app/purchases/hooks.py`** (hacia `app.inventory`, import perezoso dentro
de cada función, firmas tal cual la misión):

```
create_stock_batch(db, *, organization_id, store_id, ingredient_id, qty_base,
                   unit_cost_micros, cost_source, lot_code=None, expires_at=None,
                   received_at, business_date, source_type, source_id) -> StockBatch
reverse_stock_batch(db, *, batch_id) -> None
```

`source_type="reception"` / `source_id=Reception.id` (alineado con el
docstring que `backend-inventario` dejó en `app.inventory.models.StockBatch`:
"`source_type` es `"reception"` desde `app.purchases`").

Y hacia `reports` (para `find_spec_safe`, nunca llamado desde adentro de este
dominio):

```
overdue_payables(db, *, store_id) -> list[dict]           # {payable_id, supplier_id, supplier_name, due_date, balance, days_overdue}
pending_review_payables_count(db, *, store_id) -> int
reception_invoice_ratio(db, *, store_id, date_from, date_to) -> tuple[int, int]   # (con factura, total)
```

**`app/shifts/hooks.py::register_supplier_payment_expense`**:

```
register_supplier_payment_expense(db, *, organization_id, store_id, amount, actor,
                                  note=None, reference=None) -> CashMovement
```

Busca el turno `OPEN` de la sede; sin uno, `AppError("NO_OPEN_SHIFT",
status=409)` antes de escribir nada. No importa `app.shifts.service` (evita
el ciclo declarado en el docstring del módulo).

**`app/purchases/seed.py::seed_purchases(db, store) -> None`**, idempotente
(firma exacta pedida por la misión).

**`app/purchases/schemas.py`**: `SupplierIn/Out`, `ReceptionIn/Out`,
`PayableOut`, `PaymentIn/Out`, etc. Cantidades y costos por unidad base viajan
como texto decimal (`format_qty_base`/`format_cost_micros`), nunca milésimas
ni millonésimas crudas — la misma forma que ya usa `app.inventory.schemas`.

## §5. Decisiones y su porqué

1. **Unidad de las cantidades de línea.** `qty_received`/`qty_invoiced` se
   piden en **unidad base** (igual que el resto de `inventory`); el que se
   convierte con `purchase_factor` es el **precio** (`purchase_unit_price`,
   tecleado por unidad de COMPRA). La misión pedía explícitamente convertir
   "la unidad de compra a la unidad base con `purchase_factor`" para el
   costo — aplicarlo a la cantidad habría exigido decidir si `qty_received`
   es fraccionaria en unidades de compra (¿"2.5 cajas"?), y mantener las
   cantidades en base evita esa ambigüedad y es consistente con cómo
   `current_stock`/`min_stock`/todo lo demás de `inventory` ya cuenta.
2. **IVA bajo INC** (§4.1): `tax_amount` (pesos, tal como la factura) se
   reparte proporcional a `qty_invoiced_base` para dar un "IVA por unidad
   base", que se SUMA al costo pre-impuesto sólo si la `StoreFiscalConfig`
   vigente en `invoice_date` es `inc_responsible`. Bajo IVA (franquicia) el
   costo final es igual al pre-impuesto: el impuesto queda en la línea
   (`tax_base`/`tax_rate`/`tax_amount`) pero nunca entra a
   `final_unit_cost_micros`. Toda la aritmética es entera, en
   `app.core.quantity.COST_SCALE`/`QTY_SCALE` (nunca `float`).
3. **`tax_base`/`tax_rate`/`tax_amount` se guardan tal como llegan**, sin
   re-derivarlos server-side: son datos de una factura física (fuente de la
   verdad es el papel, no una fórmula), a diferencia de un total de venta
   donde sí manda "una sola matemática en el backend". Se valida rango
   (`0-100` para la tarifa, no-negativos para base/valor), no consistencia
   aritmética entre los tres.
4. **El saldo de una cuenta por pagar se deriva** (`payable_balance`): suma
   de `purchase_payments.amount` con `voided_at IS NULL`, restada de
   `Payable.amount` (que SÍ se guarda: es un snapshot inmutable del total
   original, análogo a un total de documento fiscal, no un saldo vivo).
   Nunca existe una columna `balance`.
5. **`PayableStatus.CANCELLED`**, agregado más allá de lo que el contrato
   nombra explícitamente: cuando se revierte una recepción sin pagos vivos,
   la cuenta por pagar asociada deja de tener sentido como deuda, pero
   "nada financiero se borra" prohíbe eliminarla y dejarla en
   `pending_review`/`approved` mentiría sobre una deuda inexistente.
6. **Guardas de tecleo con referencia propia de `purchases`.** El costo de
   referencia para `PRICE_LOOKS_LIKE_PACKAGE`/`PRICE_JUMP` es el promedio
   ponderado de TODO el historial de recepciones confirmadas de ese insumo
   en esta sede (calculado localmente, sin llamar a `inventory`), cayendo a
   `official_cost` y después a `estimated_cost` si no hay historial. Es
   deliberadamente más simple que "desde el último conteo completo" (la
   versión que construye `inventory` para `resolve_ingredient_cost`): acá
   sólo hace falta un número contra el que comparar un precio recién
   tecleado, no la jerarquía de costo oficial completa.
7. **Atomicidad sin `SAVEPOINT` en `create_reception`, con `SAVEPOINT` en
   `reverse_reception`.** `app.core.db.get_db` comitea también ante un
   `AppError`, así que la única forma de que "si algo falla no queda nada"
   sea cierta es validar TODO (proveedor, cada insumo, las dos guardas)
   antes de escribir una sola fila — `create_reception` separa
   explícitamente una fase de validación y una de escritura. `reverse_reception`
   en cambio SÍ envuelve su escritura en `db.begin_nested()`, porque ahí la
   única guarda que puede fallar a mitad de un loop de varias líneas
   (`LOT_CONSUMED`, si alguien consumió un lote DESPUÉS de que el request
   empezó) depende de una función ajena (`reverse_stock_batch`) que valida
   fila por fila, no antes del loop completo.
8. **`register_supplier_payment_expense` se llama ANTES de crear la fila
   `Payment`** (`app.purchases.service.create_payment`): si no hay turno
   abierto, la excepción sale antes de que exista ningún `Payment` que
   comitear — no hace falta una segunda `SAVEPOINT` para este caso.
9. **Migración del `CHECK` de `cash_movements.cause`, hallazgo declarado.**
   Se implementó `batch_alter_table("cash_movements", recreate="always")`
   tal como pide la misión — pero al inspeccionar el DDL generado (ver
   verificación de la migración) se confirmó que **SQLAlchemy 2.0 no genera
   ningún `CHECK` de base de datos** para `sa.Enum(..., native_enum=False)`
   a menos que se pase `create_constraint=True` explícito (el default
   cambió respecto de versiones previas), y este proyecto nunca lo pasa —
   ni acá ni en ninguna otra tabla con enum no nativo. La validación de
   causas es, en la práctica, enteramente del lado de Python (Pydantic
   `Literal` + `validate_strings=True` de SQLAlchemy al escribir). El paso
   de migración queda de todas formas: es inofensivo (recreación
   verificada, conserva FKs, índices y el `CHECK` de `amount > 0`), documenta
   la intención, y blinda contra un cambio futuro de default. Ver la
   verificación del `sqlite_master` en la corrida de este agente.
10. **`register_supplier_payment_expense` no valida `amount > 0` por su
    cuenta** (lo hace el `CheckConstraint` de la tabla y, antes, el
    `PaymentIn.amount: int = Field(gt=0)` de `purchases`): mismo criterio
    que `create_cash_movement` existente, que tampoco revalida lo que ya
    valida el esquema de entrada.
11. **[SUPERADA EN RONDA 2 — ver «Ronda 2» al final del documento. Se deja
    tachada, no borrada, porque documenta el error real que produjo H-1.]**
    ~~Anular un pago no crea un movimiento de caja compensatorio. El egreso
    original (`SUPPLIER_PAYMENT`) queda en el libro de caja como hecho
    histórico ("nada financiero se borra"); anular el pago sólo lo saca del
    cálculo de `payable_balance`. Si el efectivo tiene que volver
    físicamente al cajón, es un movimiento de caja manual aparte (`income`,
    `other_income`) que el administrador registra — automatizarlo acá
    fabricaría un ingreso de caja que puede no corresponder a un hecho
    real.~~ Esta decisión dejaba vivo el `EXPENSE` mientras el saldo de la
    cuenta por pagar ya volvía, y `compute_breakdown` seguía restando esa
    plata: el cierre a ciegas mostraba un SOBRANTE fabricado por el monto
    anulado (H-1, BLOQUEANTE, hallado por el Conciliador). Corregido en
    Ronda 2 compensando automáticamente en el turno abierto al momento de
    anular, con rechazo explícito (`409 NO_OPEN_SHIFT`) cuando no hay uno.

## §6. Tests y resultado exacto

```bash
export TMPDIR=/tmp/pt-backend-compras && mkdir -p $TMPDIR
cd backend
python -m pytest -q -p no:cacheprovider tests/purchases tests/shifts
python -m mypy --cache-dir=$TMPDIR/mypy app/purchases app/shifts
```

**Resultado de la ronda 1 (histórico): `91 passed, 0 failed, 0 skipped` (174
warnings, todas preexistentes: `DeprecationWarning` de `anyio`/Starlette y
`InsecureKeyLengthWarning` de PyJWT, ninguna de este dominio), en 322.63 s.
mypy: `Success: no issues found in 15 source files`.**

**Resultado tras la Ronda 2 (H-1, ver sección «Ronda 2» al final):
`96 passed, 0 failed, 0 skipped` (182 warnings, mismo origen preexistente),
corrida en serie DOS VECES —341.75 s y 342.75 s respectivamente, ambas
`96 passed` exacto, sin flaky— más una corrida targeted (no la suite
completa) de `tests/audit/test_purchases_invariants.py::
test_voiding_a_cash_drawer_payment_does_not_leave_the_till_short` en verde:
`1 passed in 5.76s`. mypy sobre `app/purchases app/shifts`:
`Success: no issues found in 15 source files`.**

Desglose: `tests/purchases/` — **39/39** tests (36 de ronda 1 +
**3 nuevos de Ronda 2** en `test_payables.py`). `tests/shifts/` — **57/57**:
8 de este agente (`test_supplier_payment.py` ×5 —3 de ronda 1 +
**2 nuevos de Ronda 2**—, `test_csv_format_contract.py` ×3) + **49
preexistentes de 1a/1b/2a, todos siguen en verde** (confirma que agregar
`CashMovementCause.SUPPLIER_PAYMENT`, los dos `format` de
`admin_list_shifts`/`admin_employee_activity`, y ahora
`register_supplier_payment_reversal`, no rompieron nada previo).

Antes de que `app.inventory.hooks.create_stock_batch`/`reverse_stock_batch`/
`StockBatch`/`MovementCause.RECEPTION_REVERSAL` aterrizaran (ver §8), esta
misma suite corrió **32 passed, 3 failed** (dos por un error de test —
`business_date` se sella con el reloj real, no con `invoice_date`, y los
tests comparaban contra un rango fijo sin fijar el reloj — y uno porque
`TestClient` con `raise_server_exceptions=True` deja pasar la excepción
inyectada en vez de convertirla en la `Response(500)` que igual genera el
handler genérico registrado; los tres corregidos sin tocar la lógica de
producción) y **1 skipped** (la reversa feliz, guardada tras un
`hasattr(MovementCause, "RECEPTION_REVERSAL")` explícito). En cuanto la
dependencia aterrizó a mitad de esta construcción, se re-corrió la suite
completa y quedó **91/91 en verde de punta a punta**, incluida la reversa
contra el `StockBatch` real.

Cobertura por invariante del checklist de 2b (los que tocan a este agente):
recepción confirma atómicamente movimiento + lote + cuenta por pagar
(`test_create_reception_confirms_atomically`); IVA bajo INC vs IVA con la
diferencia exacta (`test_inc_vs_iva_costs_differ_by_exactly_the_tax`);
jerarquía de guardas que preguntan y no corrigen
(`test_price_jump_guard_asks_and_confirm_price_clears_it`,
`test_price_looks_like_package_guard`,
`test_guard_never_self_corrects_the_price`); atomicidad con fallo inyectado
(`test_atomicity_injected_failure_leaves_nothing`); saldo derivado y
reversible por anulación
(`test_partial_payment_reduces_balance_and_void_restores_it`); control
mínimo recibir/pagar (`test_payment_blocked_before_approval`); pago en
efectivo crea egreso en la MISMA transacción y sin turno no queda nada
(`test_cash_payment_creates_expense_in_open_shift`,
`test_cash_payment_without_open_shift_leaves_nothing`); reversa de recepción
atómica con los dos caminos de falla nombrados
(`test_reversal_blocked_when_lot_already_consumed`,
`test_reversal_happy_path_reverses_lot_and_writes_mirror_movement`); sellado
de zona horaria a las 00:30
(`test_receptions_sealed_with_shift_business_date_at_0030`);
`Idempotency-Key` en recepción y en pago; flags apagados/prendidos
(`test_feature_disabled_returns_400`); seed idempotente con dos recepciones
de fecha y vencimiento distintos (`test_seed_purchases_*`).

## §7. Qué NO se construyó (y por qué)

- **Orden de compra y sugerencia de reposición**: la spec de negocio §5.6 las
  manda explícitamente a fase 3; la corrección ya está declarada en
  `docs/ESTADO.md` punto 15.
- **Documento soporte electrónico** (Res. DIAN 167/2021) para la compra sin
  factura: la recepción se marca `no_invoice` y ahí termina 2b, tal como
  pide el alcance.
- **Conteos, lotes (lectura/FEFO), varianza, food cost real, salud del
  control**: van en `app.inventory` (territorio de `backend-inventario` en
  este mismo pedido), no en `purchases` — el corte lo fija la spec
  ("Los conteos, lotes y varianza van en inventory... son el libro mirándose
  al espejo, no un dominio aparte").
- **`GET /admin/orders/{id}/consumption`**: pertenece al contrato general de
  2b pero no a las secciones `### Suppliers`/`### Receptions`/
  `### Payables and payments` que delimitan a este agente.
- **`ReceptionLine.stock_batch_id` sigue sin FK dura** aunque
  `app.inventory.models.StockBatch` ya existe (aterrizó a mitad de esta
  construcción, ver §8): se dejó el mismo patrón declarado
  (`Integer` sin FK) para no reabrir la migración ya verificada; una
  migración de una línea puede tensarla en cualquier momento posterior,
  igual que `Ingredient.supplier_id` quedó pendiente en 2a.
- **UI de admin (Compras, Inventario)**: fuera del territorio de este
  agente (backend puro); el reparto del pedido 2b la asigna a un agente de
  frontend.

## §8. Dependencias de otros agentes

`create_stock_batch`, `reverse_stock_batch`, `StockBatch` y
`MovementCause.RECEPTION_REVERSAL` (`app/inventory/**`, territorio de
`backend-inventario` en este mismo pedido 2b) **aterrizaron durante esta
construcción** — no estaban cuando este agente empezó a escribir
`app/purchases/**`, y sí estaban para la corrida final de verificación (§6).
Mientras no existían, `tests/purchases/_stock_batch_stub.py` +
`tests/purchases/conftest.py` parcheaban un doble fiel a la firma publicada
sobre `app.inventory.hooks` (sólo si los atributos reales faltan —
`_STUB_ACTIVE = not hasattr(inventory_hooks_module, "create_stock_batch")` —
así que en cuanto la dependencia real aterrizó, el parche se desactivó solo
y los tests pasaron a ejercitar el camino real sin tocar una línea de test).
**No quedó ningún test rojo por esta causa en la corrida final (§6): 91/91
en verde.**

Un ajuste que sí hizo falta al confirmar la integración real (no una
sorpresa de comportamiento, sólo de convención de datos): el docstring que
`backend-inventario` dejó en `app.inventory.models.StockBatch` documenta
`source_type="reception"` (no `"reception_line"`, que es lo que este agente
había usado antes de poder leer ese docstring) para las llamadas de
`app.purchases`. Se corrigió `app/purchases/service.py` y
`app/purchases/seed.py` para pasar `source_type="reception"`,
`source_id=Reception.id` — `StockMovement.ref_type`/`ref_id` (el otro par,
de `record_movement`) sigue siendo `"reception_line"`/`ReceptionLine.id`,
que es un campo distinto sin ese mismo requisito documentado y donde la
granularidad por línea es la que corresponde ("una fila por ítem", mismo
criterio que ya rige `order_items`).

Nada más quedó pendiente de otro agente dentro del territorio de este
entregable: `app.auth.service.verify_authorizer`, `app.stores.service
.current_fiscal`, `app.audit.service.record_audit` y
`app.core.idempotency.run_idempotent` ya existían y se usaron tal cual,
sin necesidad de ningún doble de prueba.

---

## Ronda 2 — H-1 BLOQUEANTE: el sobrante fabricado al anular un pago desde el cajón

### El modo de falla

`void_payment` (`app/purchases/service.py`, ronda 1) cambiaba `voided_at`,
`voided_reason` y el autorizador del `Payment`, y devolvía correctamente el
saldo de la cuenta por pagar (`payable_balance` se deriva de los pagos
vivos, y un pago anulado deja de contar). Pero **nunca tocaba
`Payment.cash_movement_id`**: si el pago había salido del cajón
(`from_cash_drawer=True`), el `CashMovement(kind=EXPENSE,
cause=SUPPLIER_PAYMENT)` que `create_payment` había creado en el turno
abierto seguía vivo sin que nada lo contrapesara.

Consecuencia exacta: `compute_breakdown` (`app/shifts/service.py`, `expected
= base + cash_sales + incomes − expenses − pickups`) seguía restando el
monto del pago anulado. La cuenta por pagar decía «no está pagada» (correcto)
y la caja seguía diciendo «la plata salió» (ya no correcto). En el cierre a
ciegas del turno eso aparece como un **SOBRANTE** de exactamente el monto
anulado — el arqueo físico (más plata de la que el sistema esperaba) no
tiene ninguna causa que lo explique, porque la causa real (el pago anulado)
ya no está en el cálculo del lado del egreso pero tampoco entró del lado del
ingreso. Lo encontró el Conciliador; lo asignó el Maestro como H-1,
bloqueante, en esta ronda.

### La decisión y su fundamento

Se implementó la salida (1) del Conciliador — **compensar**, nunca borrar —
con la salida (2) sólo como borde cuando compensar no es posible:

- **Nada financiero se borra ni se reescribe** (`AGENTS.md`): el
  `CashMovement` del egreso original queda exactamente como quedó al
  pagar. La anulación no lo toca, no le cambia `amount`, no le cambia
  `cause`. Se agrega un `CashMovement` NUEVO, compensatorio
  (`kind=INCOME`, `cause=SUPPLIER_PAYMENT`, causa tipada existente — nunca
  `OTHER_INCOME` reciclada, nunca un ajuste manual sin causa), por el mismo
  monto. Los dos movimientos quedan vivos; el libro de caja sigue siendo un
  historial completo de lo que pasó, no una versión editada de lo que
  debería haber pasado.
- **Un turno ya `CLOSED` es inviolable**: su conteo a ciegas ya ocurrió, y
  reescribir su `expected` después de que alguien ya lo comparó contra el
  efectivo físico sería falsificar un arqueo ya hecho. Por eso el
  reintegro se registra en el turno **`OPEN` al momento de anular**, que
  puede ser un turno distinto de aquel en el que se pagó. Es exactamente el
  mismo criterio que ya rige pickups/handovers reversados: la reversa vive
  en el presente, no reescribe el pasado.
- **La plata vuelve al cajón HOY, que es lo que pasa físicamente**: si se
  anula un pago hecho en efectivo, alguien físicamente pone esa plata de
  vuelta en el cajón en el momento de la anulación, no en el momento
  (pasado) del pago. Registrar el `INCOME` en el turno abierto actual es
  la única forma de que el libro de caja describa un hecho real y no una
  ficción retroactiva.
- **Espejo exacto de `create_payment`**: `create_payment` ya
  valida-antes-de-escribir con `NO_OPEN_SHIFT` (si no hay turno abierto, el
  pago no queda). `void_payment` ahora hace lo mismo en la dirección
  opuesta: si no hay turno abierto para recibir el reintegro, la anulación
  se rechaza ENTERA con `409 NO_OPEN_SHIFT` y el pago sigue vivo, su saldo
  sigue contando, y no se escribe ni una línea — ni del reintegro, ni de
  `voided_at`. La alternativa (anular igual y dejar la plata "por
  cobrar manualmente") fue descartada: dejaría un estado a medio corregir
  sin ningún registro de que hace falta corregirlo, y el checklist exige
  explícitamente que "el saldo vuelva y la caja no se entere" sea imposible
  en las dos direcciones, no sólo en la de pagar.
- **Inconsistencia `from_cash_drawer=True` sin `cash_movement_id`** (no
  debería poder existir, pero si existiera sería un dato roto, no un pago
  sin efectivo): se rechaza con un código propio,
  `409 PAYMENT_CASH_MOVEMENT_MISSING`, con mensaje de acción correctiva
  ("revisalo manualmente antes de anular"). Nunca se anula a ciegas un pago
  cuyo rastro de caja no cierra.
- **Trazabilidad sin columnas nuevas ni migración**: tal como pidió el
  Maestro, no se agregó ninguna columna. El id del `CashMovement`
  compensatorio queda en el `note` del propio movimiento
  (`"Reintegro por anulación del pago a proveedor #<payment_id>"`, que
  nombra el pago) y en `record_audit(..., after={"voided_at": ...,
  "reversal_cash_movement_id": <id o None>})` de la auditoría del `void`.
  Cualquiera que audite una anulación encuentra el movimiento que la
  compensó sin necesitar una columna dedicada.

### Implementación

- **`app/shifts/hooks.py::register_supplier_payment_reversal`** — hermano
  exacto de `register_supplier_payment_expense`: busca el turno `OPEN` de
  la sede; sin uno, `AppError("NO_OPEN_SHIFT", status=409)` con el mensaje
  correctivo ANTES de escribir nada; con uno, crea el `CashMovement
  (kind=INCOME, cause=SUPPLIER_PAYMENT, amount=payment.amount)`. Publicado
  en el docstring del módulo, al lado del de `register_supplier_payment_
  expense`. No importa `app.purchases` ni `app.purchases.service` (el
  ciclo sigue siendo el mismo que ya documentaba el módulo: `service`
  importa `hooks`, nunca al revés).
- **`app/purchases/service.py::void_payment`** — reordenado con el mismo
  patrón validar-antes-de-escribir que `create_reception`/`create_payment`:
  1. Guarda `PAYMENT_ALREADY_VOIDED` (sin cambios; sigue impidiendo la
     doble anulación, verificado con el hook ya en el medio).
  2. `verify_authorizer` (sin cambios).
  3. **Nuevo**: si `payment.from_cash_drawer`, valida
     `cash_movement_id is not None` (si no, `409
     PAYMENT_CASH_MOVEMENT_MISSING`) y llama a
     `register_supplier_payment_reversal` — si levanta `NO_OPEN_SHIFT`, ese
     mismo `AppError` sale del endpoint tal cual, sin envolverlo ni
     traducirlo.
  4. Recién ahí, `voided_at`/`voided_reason`/`voided_by_*` y el `flush()`.
  5. `record_audit` con el id del movimiento de reintegro en `after`.
- **`compute_breakdown` no se tocó** (`app/shifts/service.py`): el `INCOME`
  nuevo entra por el término `+ incomes` de la misma fórmula que ya resta el
  `EXPENSE` original por `− expenses`; se neutralizan por construcción, sin
  ninguna segunda fórmula ni caso especial para `SUPPLIER_PAYMENT`.
- **Ninguna columna ni migración nueva.** `0011_purchases.py` no cambió en
  esta ronda.

### Cómo llega esto a la UI del turno

El reintegro es un `CashMovement` normal, visible donde ya se listan los
movimientos del turno (`GET /shifts/{id}` / `GET /shifts/current` /
`GET /admin/shifts/{id}`, lo que ya exponía `income`/`expense` antes de esta
ronda): aparece como un **INGRESO** (`kind=income`) con **causa
`supplier_payment`** — la misma causa tipada que ya usa el egreso original,
sólo que del lado de `income`. `frontend-inventario-conteos` (dueño de la
etiqueta de esta causa en la UI, según el reparto de este pedido) necesita
distinguir los dos casos para no mostrar "Pago a proveedor" en un ingreso:
el criterio disponible sin tocar el esquema es `kind` (`expense` = pago
salió, `income` = pago anulado/reintegrado) combinado con `cause=
supplier_payment`, y el `note` del movimiento ya trae el texto distinguible
("Pago a proveedor — cuenta por pagar #N" vs. "Reintegro por anulación del
pago a proveedor #N") por si la UI prefiere mostrarlo tal cual en vez de
armar una etiqueta propia.

### Tests nuevos (Ronda 2)

En `tests/purchases/test_payables.py` (extremo a extremo, vía API):

1. `test_voiding_cash_drawer_payment_restores_expected_and_keeps_both_movements`
   — paga desde el cajón, anula, y verifica que `compute_breakdown(...)
   ["expected"]` del turno vuelve EXACTAMENTE al valor previo al pago (no a
   cero movimientos: quedan dos `CashMovement` vivos con
   `cause=SUPPLIER_PAYMENT`, uno `EXPENSE` y uno `INCOME` del mismo monto),
   y que el saldo de la cuenta por pagar también volvió.
2. `test_voiding_cash_drawer_payment_without_open_shift_rejects_and_writes_nothing`
   — cierra el único turno abierto entre el pago y la anulación; la
   anulación responde `409 NO_OPEN_SHIFT` y NADA se escribió:
   `payment.voided_at` sigue `None` y el saldo del `payable` no se movió.
3. `test_voiding_non_cash_drawer_payment_creates_no_cash_movement` — anular
   un pago con `from_cash_drawer=False` no crea ningún `CashMovement` nuevo
   con `cause=SUPPLIER_PAYMENT` (el conteo de esa causa no cambia).

En `tests/shifts/test_supplier_payment.py` (unitarios sobre el hook, mismo
estilo que los de `register_supplier_payment_expense` ya existentes):

4. `test_register_supplier_payment_reversal_creates_typed_income_movement`
   — crea el egreso, después el reintegro con el hook directo, y verifica
   `cause=SUPPLIER_PAYMENT`, `kind=INCOME`, que el movimiento original
   sigue vivo con su `kind=EXPENSE` intacto, y que `compute_breakdown`
   vuelve al `opening_cash_total` sin ninguna segunda fórmula.
5. `test_register_supplier_payment_reversal_without_open_shift_raises_and_writes_nothing`
   — sin turno abierto, `AppError(code="NO_OPEN_SHIFT", status=409)` y cero
   filas `CashMovement` con esa causa.

Además, **sin editarlo**, quedó VERDE el invariante del auditor
`tests/audit/test_purchases_invariants.py::
test_voiding_a_cash_drawer_payment_does_not_leave_the_till_short` (corrida
individual, no la suite completa de `tests/audit`: `1 passed in 5.76s`).

### Resultado exacto de esta ronda

```bash
export TMPDIR=/tmp/pt-backend-compras && mkdir -p $TMPDIR
cd backend
python -m pytest -q -p no:cacheprovider tests/purchases tests/shifts   # corrida 1
python -m pytest -q -p no:cacheprovider tests/purchases tests/shifts   # corrida 2 (en serie)
python -m mypy --cache-dir=$TMPDIR/mypy app/purchases app/shifts
```

- Corrida 1: **`96 passed, 0 failed, 0 skipped`** en 341.75 s (182 warnings,
  mismo origen preexistente que en ronda 1: `DeprecationWarning` de
  anyio/Starlette, `InsecureKeyLengthWarning` de PyJWT).
- Corrida 2 (en serie, misma sesión): **`96 passed, 0 failed, 0 skipped`**
  en 342.75 s. Mismo número exacto que la corrida 1 — sin flaky.
- `mypy --cache-dir=$TMPDIR/mypy app/purchases app/shifts`:
  **`Success: no issues found in 15 source files`**.
- `pytest tests/audit/test_purchases_invariants.py::
  test_voiding_a_cash_drawer_payment_does_not_leave_the_till_short` (un solo
  test, no la suite de `tests/audit`, sólo como verificación de que el
  invariante del auditor quedó satisfecho sin tocarlo): **`1 passed in
  5.76s`**.

### Qué NO se tocó en esta ronda

`app/inventory/**`, `app/orders/**`, `app/reports/**`, `tests/audit/**`,
`frontend/**` (la etiqueta de la causa en la UI del turno sigue asignada a
`frontend-inventario-conteos`, con la nota de arriba sobre cómo distinguir
`kind=income` de `kind=expense` para esa causa). `PaymentOut` (esquema) no
cambió: ni `cash_movement_id` ni ningún campo nuevo — el reintegro no es un
campo del pago, es un `CashMovement` aparte que se consulta donde ya se
consultan los movimientos del turno. `0011_purchases.py` no cambió: sin
columnas nuevas, sin migración nueva.
