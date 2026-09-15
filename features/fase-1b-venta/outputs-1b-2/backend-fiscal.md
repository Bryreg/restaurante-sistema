# backend-fiscal — Pedido 1b-2 (documento fiscal, rangos, proveedor, notas y factura)

Agente: `backend-fiscal`. Territorio: `backend/app/fiscal/**`, `backend/app/payments/**`,
`backend/app/stores/**` (mandato acotado: sólo `invoice_threshold_uvt`),
`backend/alembic/versions/0007_fiscal_ranges_notes.py`,
`backend/tests/{fiscal,payments,stores}/**`.

## 1. Resumen

Construido el documento fiscal de verdad que 1b-1 dejó moldeado: rangos de
numeración DIAN (`fiscal_ranges`, con `SELECT ... FOR UPDATE` dentro de la
transacción del cobro/nota), el adaptador `FiscalProvider`
(`PendingTransmissionProvider` real de esta fase + `FakeProvider` de test),
los cinco estados ante la DIAN (`pending → sent → validated | rejected |
contingency`) con evidencia persistida y hash local, contingencia con SLA de
48 h (barrida sin `sleep`, con `app.core.clock`), factura electrónica por
pedido explícito o por umbral UVT con cliente identificado, notas
(`adjustment_note`/`credit_note`/`debit_note`) con consecutivo propio de su
propio rango que reversan el documento original, el gancho de cliente
(`app.customers.hooks.upsert_customer_with_consent`) y el gancho de
devolución (`app.refunds.hooks.settle_or_queue_refund`) llamados desde el
cobro/las notas, `GET /device/payment-methods`, y las correcciones A-10/A-11
de deuda de 1b-1 dentro de mi territorio (A-12 queda fuera: vive en
`app/orders/money.py`, de otro agente — ver §4).

**Invariante que no se negocia y quedó probado**: un rechazo del
`FiscalProvider` NUNCA libera el número — el consecutivo se reserva
`reserve_next_number` ANTES de que el proveedor conteste, y nada revierte
esa reserva salvo el rollback completo de una transacción que todavía no
llegó a reservar nada (validar antes de escribir).

## 2. Archivos tocados

**Modelos y migración**
- `backend/app/fiscal/models.py` — `FiscalRange` (nueva); `FiscalDocument`
  gana `fiscal_range_id` (FK real, era `Integer` pelado desde 1b-1),
  `customer_id` (Integer **sin** FK dura, decisión declarada en §4),
  `customer_email`, `customer_address`, `customer_municipality_dane`,
  `reverses_document_id` (FK auto-referencial), `reason`; `FiscalCounter`
  queda acotado a `internal_receipt` (decisión declarada en §4).
- `backend/alembic/versions/0007_fiscal_ranges_notes.py` — `fiscal_ranges`
  nueva; `fiscal_documents` alterada con `batch_alter_table` (columnas +
  FKs); `store_sales_settings` gana `invoice_threshold_uvt`. `down_revision
  = "0006"`. Probado `upgrade head` → `downgrade base` → `upgrade head` sin
  error, sobre una base nueva bajo `TMPDIR` (nunca `dev.db` del repo).

**Servicios**
- `backend/app/fiscal/provider.py` (nuevo) — `EmitResult`, `ProviderHealth`,
  `FiscalProvider` (Protocol), `PendingTransmissionProvider`, `FakeProvider`,
  `get_provider`, `set_provider_override`.
- `backend/app/fiscal/service.py` — reescrito: `reserve_next_number` (ahora
  por rango), `create_range`, `list_ranges`, `range_out`,
  `resolve_document_type_for_payment`, `resolve_customer_snapshot`,
  `customer_is_identified`, `issue_document` (firma nueva: `document_type` y
  `customer` explícitos), `issue_note`, `settle_or_queue_refund_for_note`,
  `emit_and_apply`, `retry_document`, `sweep_contingency_overdue`,
  `document_evidence`, `export_bundle`, `admin_list_fiscal_documents`,
  `admin_list_notes`.
- `backend/app/fiscal/schemas.py` (nuevo) — `FiscalRangeIn/Out`,
  `AdminFiscalDocumentOut`, `RetryDocumentOut`, `FiscalRangeRefOut`,
  `DocumentEvidenceOut`, `ExportBundleOut`/`ExportManifestEntry`,
  `NoteCreateIn`/`NoteLineIn`/`RefundIn`, `NoteOut`/`NoteLineOut`,
  `AdminNoteListItem`.
- `backend/app/fiscal/router.py` (nuevo) — los 8 endpoints admin de §3.

**Cobro (extendido, no reescrito)**
- `backend/app/payments/schemas.py` — `CustomerConsentIn`, `CustomerIn`;
  `PaymentIn` gana `customer?`/`requests_invoice`; `PaymentOut` gana
  `amount_due` (A-10) y `requires_invoice`; `DocumentCustomerOut` gana
  `email`/`address`/`municipality_dane`; `DocumentFiscalOut` reescrito
  (A-11: `dian_status`, `cude`, `qr_url`, `contingency`, `range`);
  `DevicePaymentMethodOut` (nuevo).
- `backend/app/payments/service.py` — `pay_order`: mueve la resolución de
  `business_date`/`shift_row` antes del punto sin retorno (son lecturas
  puras), resuelve `document_type` (con sus posibles `400` de validación)
  ANTES de escribir, resuelve el cliente (con su escritura) recién en la
  fase de escritura; `document_printable`/`_document_fiscal_out` arma el
  `fiscal` completo (A-11); `admin_list_documents` gana filtros `type`/
  `status`; `device_payment_methods` (nuevo).
- `backend/app/payments/router.py` — `GET /device/payment-methods` (nuevo);
  `GET /admin/documents` gana `type`/`status`.

**`app/stores` (mandato acotado)**
- `backend/app/stores/models.py` — `StoreSalesSettings.invoice_threshold_uvt`
  (`Integer`, default 5).
- `backend/app/stores/schemas.py` — `SalesSettingsIn`/`Out` ganan
  `invoice_threshold_uvt` (requerido en el `PUT`, como el resto del esquema).
- `backend/app/stores/router.py` — `_sales_settings_out` expone el campo
  nuevo (el `PUT` ya lo persistía de forma genérica).

**Tests**
- `backend/tests/fiscal/conftest.py` — `seed_fiscal_ranges` +
  `default_fiscal_range` (autouse: un rango vigente amplio por tipo
  DIAN-trazable, para que pagar en cualquier test de este árbol no tropiece
  con `NO_FISCAL_RANGE`); `main_product`.
- `backend/tests/fiscal/test_counter.py` — reescrito para el consecutivo por
  rango (100 reservas sin huecos; `NO_FISCAL_RANGE`; `FISCAL_RANGE_EXHAUSTED`;
  rechazo no consume; `internal_receipt` sigue con `FiscalCounter`).
- `backend/tests/fiscal/test_ranges.py`, `test_provider.py`,
  `test_contingency.py`, `test_notes.py`, `test_evidence_export.py` (nuevos).
- `backend/tests/payments/conftest.py` — `seed_fiscal_ranges` +
  `default_fiscal_range` (autouse, misma razón; duplicado a propósito,
  directorio hermano).
- `backend/tests/payments/test_concurrency.py` — `_seed_order` crea su
  propio rango en la base de `race_env` (no comparte `db`/`store`).
- `backend/tests/payments/test_documents.py` — actualicé las aserciones de
  `fiscal`/`customer` al nuevo shape.
- `backend/tests/payments/test_customer_hook.py`,
  `test_invoice_and_amount_due.py`, `test_device_payment_methods.py`
  (nuevos).
- `backend/tests/stores/test_settings.py` — `test_invoice_threshold_uvt_default_and_update`.

Ningún archivo de otro territorio fue escrito (`app/orders`, `app/kitchen`,
`app/customers`, `app/refunds`, `app/reports`, `app/shifts`,
`app/notifications`, `app/main.py`, `app/core/**`, `tests/audit`,
`tests/conftest.py`, `frontend/`): confirmado con `git status`/diff manual
sobre lo que edité.

## 3. Contrato público

### 3.1 `app.fiscal.service` (firmas exactas)

```python
def assert_range_available(
    db: Session, *, store_id: int, document_type: FiscalDocumentType, business_date: date
) -> None
    # Chequeo PURO (sin FOR UPDATE, sin reservar): mismo criterio de
    # reserve_next_number, pero de sólo lectura. `pay_order` lo llama ANTES
    # de auto_send_pending_for_payment/claim_payment (validar antes de
    # escribir); `reserve_next_number` (dentro de issue_document, después
    # de claim_payment) sigue siendo la reserva autoritativa. Sin este
    # chequeo temprano, un NO_FISCAL_RANGE que sólo aparece dentro de
    # issue_document dejaría la comanda `paid` sin documento — bug real que
    # encontré y corregí durante la verificación (ver §6).

def reserve_next_number(
    db: Session, *, organization_id: int, store_id: int, document_type: FiscalDocumentType, business_date: date
) -> tuple[FiscalRange, int]
    # SELECT ... FOR UPDATE sobre fiscal_ranges: el de mayor valid_from vigente
    # en business_date con next_number <= to_number. 400 NO_FISCAL_RANGE (nada
    # vigente) o 400 FISCAL_RANGE_EXHAUSTED (vigente, agotado). Sólo para
    # document_type en RANGE_BACKED_TYPES = {pos_equivalent, invoice,
    # adjustment_note, credit_note, debit_note}. internal_receipt usa
    # _reserve_internal_receipt_number (FiscalCounter, sin rango).

def create_range(db, *, organization_id, store_id, document_type, prefix, from_number, to_number,
                  resolution_number, resolution_date, valid_from, valid_until, technical_key, now) -> FiscalRange
def list_ranges(db, *, store_id: int) -> list[FiscalRange]
def range_out(row: FiscalRange) -> FiscalRangeOut

def resolve_document_type_for_payment(
    db, *, organization_id, store_id, total_net: int, business_date: date,
    customer_identified: bool, requests_invoice: bool
) -> FiscalDocumentType
    # internal_receipt si fiscal.dee_pos apagada. Si no: pos_equivalent por
    # default; invoice si requests_invoice o total_net > invoice_threshold_uvt
    # × UVT(business_date.year) Y customer_identified (si no, 400
    # CUSTOMER_REQUIRED_FOR_INVOICE). requests_invoice con fiscal.invoice
    # apagada → 400 FEATURE_DISABLED {feature: "fiscal.invoice"}. total_net =
    # totals.tip_base (neto de impuesto) del target que se está cobrando
    # (comanda completa o sub-cuenta).

def resolve_customer_snapshot(db, *, organization_id, store_id, customer_in, actor, now) -> CustomerSnapshot
    # CustomerSnapshot{id, doc_type, doc_number, name, email, address, municipality_dane}.
    # customer_in=None -> CONSUMER_FINAL (id=None, "13"/"222222222222"/"Consumidor final").
    # Si no, llama app.customers.hooks.upsert_customer_with_consent (find_spec_safe-guarded).
def customer_is_identified(customer_in: Any | None) -> bool

def issue_document(
    db, *, order, sub_account, shift, store, actor, document_type: FiscalDocumentType,
    totals, tip: TipSnapshot, lines, payments_snapshot, tables_text, business_date, now,
    customer: CustomerSnapshot,
) -> FiscalDocument
    # Reserva el número (reserve_next_number o _reserve_internal_receipt_number
    # según document_type), arma la fila, y llama emit_and_apply antes de devolver.

def issue_note(
    db, *, original: FiscalDocument, kind: str ("adjustment"|"credit"|"debit"), reason: str,
    lines_in: list[NoteLineIn], actor, store, business_date, now,
) -> FiscalDocument
    # 400 NOTE_KIND_MISMATCH si el par no corresponde (adjustment<->pos_equivalent,
    # credit/debit<->invoice). 400 DOCUMENT_ALREADY_REVERSED si original.status != "issued".
    # 400 NOTE_EMPTY si ningún lines_in[].used=True matchea un item_id del original.
    # Suma (no recalcula) los montos de las líneas originales seleccionadas — la
    # única matemática sigue siendo la que produjo esos números (app.orders.money).
    # Reserva su propio número en SU propio rango (mismo document_type que la
    # nota); marca original.status = "reversed"; emite vía emit_and_apply.

def settle_or_queue_refund_for_note(db, *, note: FiscalDocument, refund_in, actor, now) -> str | None
    # None si no había refund o app.refunds.hooks no existe; si no, el
    # RefundOutcome.status real ("settled_in_shift"|"pending"|"settled_externally").

def emit_and_apply(db, *, document: FiscalDocument, store: Store) -> FiscalDocument
def retry_document(db, *, document: FiscalDocument, store: Store, now: datetime) -> FiscalDocument
    # 400 FISCAL_RETRY_NOT_APPLICABLE si internal_receipt; 400
    # DOCUMENT_ALREADY_REVERSED si ya tiene nota.
def sweep_contingency_overdue(db, *, store_id: int) -> int
    # documentos en contingency con issued_at <= now - 48h -> notify(fiscal_contingency_overdue).
    # Se llama al entrar a GET /admin/fiscal/documents y GET /admin/fiscal/export
    # (no hay scheduler en el proyecto; ver gaps).
def document_evidence(db, *, document: FiscalDocument) -> DocumentEvidenceOut
def export_bundle(db, *, store_id: int, date_from: date, date_to: date) -> ExportBundleOut
def admin_list_fiscal_documents(db, *, store_id: int, status: str | None) -> list[dict]
def admin_list_notes(db, *, store_id: int, date_from: date | None, date_to: date | None) -> list[dict]
```

### 3.2 `app.fiscal.provider`

```python
@dataclass(frozen=True) class EmitResult: status: Literal["pending","sent","validated","rejected","contingency"]; cude: str|None=None; qr_url: str|None=None; xml_ref: str|None=None; response: dict[str,Any]=field(default_factory=dict)
@dataclass(frozen=True) class ProviderHealth: ok: bool; detail: str
class FiscalProvider(Protocol): def emit(document) -> EmitResult; def retry(document) -> EmitResult; def health() -> ProviderHealth
class PendingTransmissionProvider:   # el proveedor real de 1b-2: emit/retry siempre EmitResult(status="pending", ...), nunca falla.
class FakeProvider:                  # sólo tests. __init__(*, outcome: "validate"|"reject"|"contingency"="validate", reject_reason=...)
                                      # .emit_calls / .retry_calls (list[int] de document.id) para verificar que se llamó.
def set_provider_override(provider: FiscalProvider | None) -> None   # sólo tests, como clock.set_clock
def get_provider(db: Session, store: Store) -> FiscalProvider        # el ÚNICO punto que un proveedor real cambiaría
```

Probado por inspección de fuente (`tests/fiscal/test_provider.py
::test_pay_order_and_issue_document_never_mention_a_concrete_provider`) que
ni `app/payments/service.py` ni `app/fiscal/service.py` mencionan
`PendingTransmissionProvider` ni `FakeProvider` por nombre.

### 3.3 Rutas nuevas (`/api/v1`, todas `current_admin` salvo la marcada)

| Ruta | Payload | Respuesta | Errores propios |
|---|---|---|---|
| `GET /admin/fiscal/ranges?store_id=` (+`format=csv`) | — | `[FiscalRangeOut]` | — |
| `POST /admin/fiscal/ranges` | `FiscalRangeIn` (`from_number`/`to_number`, no `from`/`to` — ver §4) | `201 FiscalRangeOut` | `400 FISCAL_RANGE_INVALID` |
| `GET /admin/fiscal/documents?store_id=&status=` (+`format=csv`) | — | `[AdminFiscalDocumentOut]` (incluye `contingency`/`contingency_overdue`) | — |
| `POST /admin/fiscal/documents/{id}/retry` (`Idempotency-Key`) | — | `200 RetryDocumentOut` | `400 FISCAL_RETRY_NOT_APPLICABLE`, `400 DOCUMENT_ALREADY_REVERSED` |
| `GET /admin/fiscal/documents/{id}/evidence` | — | `DocumentEvidenceOut` (incluye `content_hash` sha256) | — |
| `GET /admin/fiscal/export?store_id=&from=&to=` | — | `ExportBundleOut` (manifiesto + hash por documento + hash del manifiesto) | — |
| `POST /admin/documents/{id}/notes` (`Idempotency-Key`) | `NoteCreateIn {kind, reason, lines: [{item_id, used}], refund?: {method, amount}}` | `201 NoteOut` (incluye `refund_status`) | `400 NOTE_KIND_MISMATCH`, `400 DOCUMENT_ALREADY_REVERSED`, `400 NOTE_EMPTY` |
| `GET /admin/notes?store_id=&from=&to=` (+`format=csv`) | — | `[AdminNoteListItem]` | — |
| `GET /device/payment-methods` (`current_device`) | — | `[DevicePaymentMethodOut]` | — |

**Extendidas** (`app/payments/router.py`, ya existían desde 1b-1):
- `POST /orders/{id}/payments`: `PaymentIn` gana `customer?: CustomerIn`,
  `requests_invoice?: bool`; `PaymentOut` gana `amount_due` (siempre
  presente, `total + tip_amount`, A-10) y `requires_invoice`.
- `GET /documents/{id}` / `POST /documents/{id}/reprint`:
  `DocumentPrintableOut.customer` gana `email`/`address`/`municipality_dane`;
  `.fiscal` es ahora `{dian_status, cude, qr_url, contingency, range:
  {id, prefix, from_number, to_number, resolution_number, valid_until} |
  null}` (A-11).
- `GET /admin/documents?store_id&from&to&type&status`.

### 3.4 Códigos de error nuevos

| Código | Status | Mensaje (acción correctiva) |
|---|---|---|
| `NO_FISCAL_RANGE` | 400 | «Cargá el rango de numeración autorizado por la DIAN en Admin → Rangos de numeración» |
| `FISCAL_RANGE_EXHAUSTED` | 400 | «El rango de numeración vigente se agotó: cargá un nuevo rango...» |
| `FISCAL_RANGE_INVALID` | 400 | rango con `to < from` o vigencia invertida |
| `CUSTOMER_REQUIRED_FOR_INVOICE` | 400 | «Esta venta requiere factura electrónica: capturá el documento del cliente antes de cobrar» |
| `FEATURE_DISABLED` (reutilizado) | 400 | `fiscal.invoice` apagada y se pidió factura explícita, o `customers` apagada y se mandó `customer` |
| `NOTE_KIND_MISMATCH` | 400 | el tipo de nota no corresponde al tipo del documento original |
| `DOCUMENT_ALREADY_REVERSED` | 400 | el documento ya tiene una nota, o se intenta reintentar transmisión de uno reversado |
| `NOTE_EMPTY` | 400 | ninguna línea seleccionada para la nota |
| `FISCAL_RETRY_NOT_APPLICABLE` | 400 | reintentar un `internal_receipt` (nunca se transmite) |

Ninguna regla de negocio responde `500`; probado explícitamente para
`NO_FISCAL_RANGE`/`FISCAL_RANGE_EXHAUSTED` (spec: «nunca un 500»).

## 4. Decisiones declaradas

1. **`FiscalCounter` no se absorbe en `FiscalRange`.** Queda acotado a
   `internal_receipt` (sede que declaró no estar obligada, `fiscal.dee_pos`
   apagada): un comprobante interno no es un documento DIAN y no tiene
   sentido exigirle al admin que cargue un rango autorizado por una entidad
   que ese comprobante explícitamente dice no representar. Todo lo demás
   (`pos_equivalent`, `invoice`, las tres notas) usa `FiscalRange`. El
   `UNIQUE(store_id, document_type, prefix)` de `fiscal_counters` no se tocó
   (lo exige `tests/audit/test_migration_invariants.py`, verificado).

2. **`FiscalDocument.customer_id` queda `Integer` sin `ForeignKey` dura**,
   pese a que `0006_customers_refunds_tips.py` (de otro agente, cuyo
   docstring dice explícitamente que se secuenció ANTES que ésta «para que
   `fiscal_documents.customer_id` pueda tener FK real») ya crea la tabla
   `customers`. Verifiqué empíricamente
   (`sqlalchemy.exc.NoReferencedTableError`) que `Base.metadata.create_all()`
   — lo que usa `tests/conftest.py::db`, la fixture compartida de **todo**
   el árbol de tests — revienta si una `ForeignKey("customers.id")` apunta a
   una tabla cuyo modelo no fue importado antes. `app.core.models_registry
   .MODEL_MODULES` y `app.main.DOMAINS` **todavía no incluyen `"customers"`
   ni `"refunds"`** (archivo fuera de mi territorio, `app/core/**`): agregar
   la FK ahora habría roto `create_all()` — y por lo tanto la suite entera,
   no sólo la mía — para cualquier proceso de test que importe
   `app.fiscal.models` sin haber importado antes `app.customers.models`
   (la gran mayoría de los dominios). Elegí no romper eso. Cuando
   `MODEL_MODULES`/`DOMAINS` se actualicen (hace falta de todos modos para
   que `app.customers`/`app.refunds` tengan router montado — ver gap #1), una
   migración de una línea (`batch_alter_table(...).create_foreign_key(...)`)
   agrega la FK real, igual que ESTE pedido hizo con `fiscal_range_id`.
   Documentado también en el docstring de `app/fiscal/models.py` y en la
   migración `0007`.

3. **`FiscalRangeIn`/`Out` usan `from_number`/`to_number`, no `from`/`to`**
   literales en el JSON. `spec.md` («API contract → Admin fiscal») pide
   `from`/`to`; `from` es palabra reservada de Python, y la alternativa
   (`Field(alias="from")` + `populate_by_name=True`) exige el plugin de
   mypy de Pydantic, que este proyecto no tiene configurado
   (`pyproject.toml § [tool.mypy]`, fuera de mi territorio) — verificado que
   sin el plugin, mypy rechaza construir el modelo con el nombre del campo
   (`Unexpected keyword argument`). Configurar el plugin a mano habría
   cambiado el comportamiento de mypy para TODO el árbol. El CSV de
   `GET /admin/fiscal/ranges?format=csv` sí usa los encabezados `from`/`to`
   literales (se arman a mano en el router, no pasan por el esquema
   Pydantic) para no perder la letra del contrato ahí donde es gratis
   cumplirla.

4. **El umbral de factura (`invoice_threshold_uvt`) se evalúa sobre
   `totals.tip_base`** (neto de impuesto del TARGET que se está cobrando —
   la comanda completa o la sub-cuenta), no sobre el total con impuesto ni
   sobre el total de la comanda completa cuando se cobra una sub-cuenta.
   `SPEC-NEGOCIO §8.2` define "neto" como `total ÷ (1 + tasa)`, que es
   exactamente lo que `tip_base` ya representa (reutiliza el número que
   `app.orders.money.compute_totals` ya calculó — ninguna matemática nueva).
   No hay guía explícita en la spec sobre si el umbral se evalúa por
   sub-cuenta o por comanda completa cuando hay división; evaluarlo por
   sub-cuenta es consistente con que cada sub-cuenta emite su propio
   documento independiente.

5. **Contingencia sin scheduler.** El proyecto no tiene infraestructura de
   tareas periódicas (ninguna dependencia nueva permitida,
   `CONTRATO-INTERNO-1b-1.md §1`). `sweep_contingency_overdue` es una
   función pura, testeable con la fixture `clock` (`advance(hours=49)`,
   nunca `sleep`), que se invoca al entrar a `GET /admin/fiscal/documents` y
   `GET /admin/fiscal/export` («barrido perezoso»). Un cron/beat real que la
   llame periódicamente queda fuera de este pedido — declarado en gaps.

6. **`GET /admin/fiscal/export` no arma un ZIP con XML reales.** No hay
   proveedor real todavía (sólo `PendingTransmissionProvider`/`FakeProvider`),
   así que no hay XML que empaquetar. El manifiesto JSON con hash sha256 por
   documento y un hash del manifiesto entero es la evidencia exportable de
   esta fase — cumple «conservación 5 años» y «no depender sólo del
   proveedor» de forma verificable, pero no es un paquete de archivos.

7. **Orden de validación en `pay_order` reordenado una vez más** (ya había
   una desviación documentada por `backend-cobro` en 1b-1 para
   `TENDERED_TOO_LOW`): `business_date`/`shift_row` (lecturas puras) y
   `resolve_document_type_for_payment` (que puede levantar `400
   CUSTOMER_REQUIRED_FOR_INVOICE`/`FEATURE_DISABLED`) se resuelven ANTES del
   punto sin retorno, aunque la prosa del contrato original los ubicaba
   después de `claim_payment`. Mismo criterio que la desviación de 1b-1:
   "validar antes de escribir" es una regla dura, no una sugerencia de
   orden.

8. **El umbral UVT no fuerza factura si no hay `UvtValue` cargada** para el
   año de `business_date` (`_net_over_invoice_threshold` devuelve `False`
   sin ella). Decisión conservadora: sin UVT no hay con qué comparar, y
   bloquear ventas por una tabla que el admin no cargó sería peor que dejar
   pasar el `pos_equivalent` por default (el operador siempre puede pedir
   factura a mano con `requests_invoice`).

## 5. Invariantes probados (archivo::test → qué prueba)

1. **Consecutivo sin huecos, por tipo y sede, dentro del rango vigente**:
   `tests/fiscal/test_counter.py::test_reserve_next_number_no_gaps_after_100_reservations`
   (100 reservas directas, `1..100` sin huecos).
2. **Sin rango vigente → `400 NO_FISCAL_RANGE` con acción correctiva, nunca
   `500`**: `test_counter.py::test_no_fiscal_range_blocks_the_sale_with_400_and_correction_action`.
3. **Rango agotado → `400 FISCAL_RANGE_EXHAUSTED`**:
   `test_counter.py::test_fiscal_range_exhausted_blocks_the_sale`.
4. **Un cobro rechazado por validación (`400`) no consume número**:
   `test_counter.py::test_rejected_payment_does_not_consume_a_validation_number`.
5. **Un rechazo del `FiscalProvider` (documento SÍ se crea, DIAN lo rechaza)
   tampoco libera el número — el consecutivo sigue avanzando sin huecos
   incluso mezclando rechazos y validaciones**:
   `test_provider.py::test_fake_provider_rejects_and_does_not_release_the_number`.
6. **`FakeProvider` valida (CUDE/QR sintéticos), rechaza y simula
   contingencia**: `test_provider.py::test_fake_provider_validates_with_cude_and_qr`,
   `::test_fake_provider_rejects_and_does_not_release_the_number`,
   `::test_fake_provider_simulates_contingency`.
7. **`pay_order`/`issue_document` nunca mencionan una implementación
   concreta del proveedor** (inspección de fuente):
   `test_provider.py::test_pay_order_and_issue_document_never_mention_a_concrete_provider`.
8. **Documento en `contingency` se imprime con su leyenda; a las 48 h
   dispara `fiscal_contingency_overdue` (reloj simulado, nunca `sleep`); no
   dispara antes de las 48 h; dedup dentro del mismo día**:
   `test_contingency.py::test_contingency_document_prints_with_its_legend`,
   `::test_sweep_does_not_fire_before_48_hours`,
   `::test_sweep_fires_fiscal_contingency_overdue_after_48_hours`.
9. **Alertas de rango al 80 % consumido y a menos de 30 días de vencer**:
   `test_ranges.py::test_alert_fires_at_80_percent_consumed`,
   `::test_alert_fires_when_less_than_30_days_to_expire`.
10. **Factura automática sobre el umbral UVT con cliente identificado;
    `400 CUSTOMER_REQUIRED_FOR_INVOICE` sin cliente; `requests_invoice`
    fuerza factura aunque no supere el umbral; `fiscal.invoice` probada
    encendida y apagada (`400 FEATURE_DISABLED` apagada)**:
    `test_invoice_and_amount_due.py` (5 tests).
11. **`amount_due` siempre presente y sumado por el servidor (A-10)**:
    `test_invoice_and_amount_due.py::test_amount_due_is_always_present_and_summed_by_the_server`,
    `::test_amount_due_with_no_tip_equals_total`.
12. **Notas: consecutivo propio de su propio rango, el original queda
    `reversed`, `NOTE_KIND_MISMATCH` en ambos sentidos, una segunda nota
    sobre el mismo original es `400`, `Idempotency-Key` sin duplicar,
    listado y CSV**: `test_notes.py` (8 tests).
13. **El gancho de devolución (`app.refunds.hooks.settle_or_queue_refund`)
    se invoca desde la nota con los datos correctos; con turno abierto
    devuelve `"settled_in_shift"`**:
    `test_notes.py::test_note_with_refund_settles_in_the_open_shift`. El
    comportamiento fino (turno cerrado → pendiente) es del dueño de
    `app.refunds` (declarado, no es mi test E2E).
14. **El gancho de cliente (`app.customers.hooks.upsert_customer_with_consent`)
    crea/reutiliza el maestro por `(doc_type, doc_number)`, registra el
    consentimiento, y el documento fiscal congela `customer_id` +
    snapshot completo**: `test_customer_hook.py::test_paying_with_customer_creates_the_master_and_freezes_the_snapshot`,
    `::test_same_doc_number_reuses_the_same_customer_row`. Soy el dueño de
    este test E2E (mandato explícito del Maestro).
15. **`customers` apagada bloquea el cobro con `customer` en el body**:
    `test_customer_hook.py::test_customer_feature_disabled_blocks_the_payment`
    (el gate vive en el propio gancho, `app.customers.hooks`).
16. **`erase` anonimiza el maestro y deja INTACTO el snapshot del documento
    fiscal ya emitido**:
    `test_customer_hook.py::test_erase_customer_anonymizes_the_master_and_keeps_the_document_snapshot_intact`
    (llama `app.customers.service.erase_customer` directo — su router no
    está montado, ver gap #1).
17. **Evidencia con hash sha256 y referencia al rango; export con
    manifiesto + hash por documento + hash del manifiesto**:
    `test_evidence_export.py` (2 tests).
18. **`retry` idempotente** (misma `Idempotency-Key` → misma respuesta);
    **`retry` sobre `internal_receipt` es `400 FISCAL_RETRY_NOT_APPLICABLE`**:
    `test_evidence_export.py::test_retry_is_idempotent_and_reapplies_the_provider_outcome`,
    `::test_retry_on_internal_receipt_is_not_applicable`.
19. **`GET /device/payment-methods` sólo lista los habilitados de la sede;
    ninguna respuesta de dispositivo lleva `cost`/`margin`/`unit_cost`**:
    `test_device_payment_methods.py` (2 tests).
20. **`invoice_threshold_uvt` expuesto en `GET`/`PUT
    /admin/stores/{id}/sales-settings`, default 5**:
    `tests/stores/test_settings.py::test_invoice_threshold_uvt_default_and_update`.
21. **Los invariantes heredados de 1b-1 siguen en verde** (pendientes →
    `sent_at_payment`, mesas liberadas, propina por medio, `staff_meal` en
    cero, `SPLITS_DO_NOT_MATCH`/`TENDERED_TOO_LOW`/etc., división igual/por
    ítems con documentos propios, concurrencia con `race_env`): todos los
    tests de `tests/payments/test_pay_flow.py`, `test_split.py`,
    `test_concurrency.py`, `test_documents.py` pasan sin cambios de
    comportamiento (sólo actualicé fixtures/aserciones al nuevo shape del
    documento, nunca la lógica que prueban).

## 5.1 Bug encontrado y corregido durante la propia verificación

Mi primera corrida de tests detectó que `test_no_fiscal_range_blocks_the_sale_with_400_and_correction_action`
dejaba la comanda `paid` a pesar de responder `400 NO_FISCAL_RANGE`: la
reserva del número (y por lo tanto el chequeo de rango vigente) vivía sólo
dentro de `issue_document`, que se llama DESPUÉS de
`orders_service.claim_payment(...)` — y el `AppError` que levanta
`reserve_next_number` sólo revierte el `SAVEPOINT` de `issue_document`, no
la escritura de `claim_payment` que quedó afuera. Agregué
`assert_range_available` (chequeo puro, sin reservar) y lo llamo en
`pay_order` ANTES del punto sin retorno — igual criterio que
`resolve_document_type_for_payment`. Corregido y reverificado (§6);
documentado el residual de carrera que sigue quedando entre el chequeo
temprano y la reserva real (ventana microscópica, mismo tipo de riesgo que
`backend-cobro` ya aceptó en 1b-1 para `target_key`).

## 6. Verificación (comandos y resultado literal)

```
$ cd backend && mkdir -p /tmp/pt-backend-fiscal
$ TMPDIR=/tmp/pt-backend-fiscal python -m pytest tests/fiscal tests/payments tests/stores -q
...............................................................................
...............................................................................
..................
95 passed, 181 warnings in 306.84s (0:05:06)
```

(Las 181 advertencias son `DeprecationWarning`/`InsecureKeyLengthWarning` ya
presentes en el resto de la suite, ajenas a este territorio — mismo patrón
que reportó `backend-cobro` en 1b-1.)

Primera corrida completa: `92 passed, 3 failed` — los tres hallazgos
(uno real, dos de mi propio arnés de test) están descritos y corregidos en
§5.1 y en los puntos siguientes; la corrida de arriba es la que queda
después de corregirlos:
1. **Bug real de `pay_order`** (§5.1): `NO_FISCAL_RANGE` dejaba la comanda
   `paid` porque el chequeo vivía sólo dentro del `SAVEPOINT` de
   `issue_document`, después de `claim_payment`. Corregido con
   `assert_range_available` llamado antes del punto sin retorno.
2. **`no such table: customers`**: el primer test del proceso que pagaba
   con `customer`/nota con `refund` reventaba porque
   `app.core.models_registry.MODEL_MODULES` no incluye `"customers"`/
   `"refunds"` todavía (gap #1) y `Base.metadata.create_all()` sólo crea las
   tablas de los `models.py` ya importados. Corregido con un import a nivel
   de módulo (guardado con `find_spec_safe`) en `tests/fiscal/conftest.py`
   y `tests/payments/conftest.py` — sin tocar `app/core/**`.
3. **`401 NOT_AUTHENTICATED`** en un test que combinaba `admin_client` con
   la fixture `clock` en el orden equivocado: pytest arma las fixtures
   independientes en el orden en que aparecen como parámetro, y el JWT del
   admin se firma con `now_utc()` (mockeada) — si `clock` se resuelve ANTES
   que `admin_client`, el `exp` del token queda calculado sobre una fecha de
   prueba fija (2026-01-15) muy anterior a la fecha real del entorno
   (2026-09-15), y el token nace "expirado" contra la validación de tiempo
   real de PyJWT. Corregido reordenando los parámetros del test (`admin_client`
   antes de `clock`) y documentado inline para que no se repita.

```
$ cd backend && python -m mypy app
Success: no issues found in 84 source files
```

```
$ mkdir -p /tmp/pt-backend-fiscal && rm -f /tmp/pt-backend-fiscal/mig.db
$ DATABASE_URL=sqlite:////tmp/pt-backend-fiscal/mig.db python -m alembic upgrade head
... 0001 -> 0002 -> 0003 -> 0004 -> 0005 -> 0006 -> 0007 ...
$ DATABASE_URL=sqlite:////tmp/pt-backend-fiscal/mig.db python -m alembic downgrade base
... limpio, sin error ...
$ DATABASE_URL=sqlite:////tmp/pt-backend-fiscal/mig.db python -m alembic upgrade head   # de nuevo, sin error
```

`GET /api/v1/openapi.json` sin `"cost"`/`"margin"`/`"unit_cost"` en ningún
esquema, verificado a mano (`app.openapi()` + `json.dumps` + búsqueda de las
tres cadenas) y con `tests/payments/test_documents.py
::test_openapi_device_responses_never_expose_cost_fields` (heredado de
1b-1, sigue en verde) y `test_device_payment_methods.py
::test_device_payment_methods_never_exposes_cost_fields`.

No corrí la suite completa (`pytest -q` sin filtro), `alembic upgrade head`
sobre `dev.db` del repo, ni `npm run build`/tests de otro territorio: eso es
del paso de verificación final del orquestador.

## 7. Gaps

1. **`app.core.models_registry.MODEL_MODULES` y `app.main.DOMAINS` no
   incluyen `"customers"` ni `"refunds"`** (archivo `app/core/**`, fuera de
   mi territorio). Consecuencias concretas:
   - `app.customers.router`/`app.refunds.router` no están montados: `GET/POST
     /admin/customers/*`, `GET /admin/pending-refunds`, `POST
     /admin/pending-refunds/{id}/settle` no son alcanzables por HTTP todavía
     (verificado: no aparecen en `app.openapi()`).
   - Por eso `test_customer_hook.py
     ::test_erase_customer_anonymizes_the_master_and_keeps_the_document_snapshot_intact`
     llama `app.customers.service.erase_customer` directo en vez de por
     HTTP — cubre el invariante que me toca (el snapshot no se toca), pero
     no prueba el endpoint `POST /admin/customers/{id}/erase` en sí (eso es
     checklist del pedido pero pertenece a `app.customers`).
   - `FiscalDocument.customer_id` queda sin FK dura por la misma razón
     (decisión declarada en §4, punto 2) — contradice lo que el docstring de
     `0006_customers_refunds_tips.py` asumía. **No es un desacuerdo de
     diseño: es que agregar la FK ahora rompe `Base.metadata.create_all()`
     para cualquier test que no importe `app.customers.models` primero**
     (verificado empíricamente con `NoReferencedTableError`). Quien agregue
     `"customers"`/`"refunds"` a esos dos archivos puede además convertir la
     FK en real con una migración de una línea.
   - Recomiendo al Maestro asignar esto explícitamente: ninguno de los
     agentes de 1b-2 tiene ese archivo en su territorio declarado (yo no;
     `app.customers`/`app.refunds` tampoco, a juzgar por el mismo patrón de
     "no tocás app/core/**" que heredé), así que sin una asignación
     explícita nadie lo hace.

2. **`app/orders/money.py::prorate` (A-12)** — mi mandato lista A-12 entre
   "deuda de 1b-1 que 1b-2 salda", pero `app/orders/money.py` es
   explícitamente territorio ajeno (`app/orders`, en mi lista de "No
   tocás"). No lo toqué. Sigue abierto tal como lo dejó el auditor de 1b-1
   (`outputs-1b-1/auditor-venta.md §3`, A-12): `prorate` puede asignar a una
   línea más de lo que pesa cuando el saldo total es menor que la cantidad
   de líneas (caso con precios reales, inalcanzable). Es trabajo de quien
   tenga `app/orders/**` en su territorio en este pedido 1b-2, si alguien lo
   tiene.

3. **`TAX_RATE_BY_CODE` sigue declarado localmente en
   `app/orders/service.py`** (no en `app/core/tax.py`): comprobé con `grep`
   al empezar y de nuevo ahora — sigue sin existir `app/core/tax.py`. No lo
   creé (sería territorio de `app/core`, ajeno) y no lo necesité: todo mi
   código lee tasas ya resueltas en snapshots (`item.tax_rate`,
   `line.tax_rate`), nunca resuelve `tax_code → rate` por su cuenta.

4. **Contradicción encontrada entre `spec.md` y `docs/SPEC-NEGOCIO.md`**:
   ninguna que afecte a mi territorio. `spec.md` («API contract → Payments &
   fiscal document») describe el contrato técnico consistente con
   SPEC-NEGOCIO §8.3; donde `spec.md` no precisa un detalle (p. ej. si el
   umbral UVT se evalúa por sub-cuenta o por comanda completa en una
   división), tomé la decisión más conservadora y la declaré en §4 en vez
   de inventar una lectura de la spec de negocio que no está.

5. **No pude verificar Postgres real** (el `SELECT ... FOR UPDATE` de
   `reserve_next_number` sobre `fiscal_ranges`, igual que ya lo dejó
   declarado `backend-cobro` para `fiscal_counters` en 1b-1): todo corrió
   sobre SQLite, que lo ignora y serializa por el lock de escritura. El
   invariante del consecutivo está probado; el mecanismo que lo protege en
   producción, no — eso es del CI.

6. **`fiscal_documents.reason`** (columna nueva, sólo para notas) no está
   pedida explícitamente por `spec.md`/`SPEC-NEGOCIO.md` como campo de
   `FiscalDocument`, pero `POST /admin/documents/{id}/notes` sí recibe
   `reason` como parte del body y el admin necesita poder verlo después
   (`GET /admin/notes`); decidí persistirlo en vez de perderlo. Declarado
   por transparencia, no es una contradicción con nada.

7. **`tests/audit/test_migration_invariants.py::test_the_chain_reaches_the_two_migrations_of_the_sale`**
   (archivo ajeno, `tests/audit`, no lo toqué) afirma literalmente
   `version == "0005"`. Con `0006`/`0007` ya en la cadena, esa aserción
   puntual queda desactualizada — no es un bug de mi código, es una
   aserción de 1b-1 que 1b-2 vuelve obsoleta por diseño (la cadena avanza).
   Corresponde a quien tenga `tests/audit` en su territorio en este pedido
   (probablemente un auditor de 1b-2) actualizarla; no era seguro para mí
   tocar ese archivo.

8. **No verifiqué el flujo completo en navegador real** (Playwright): fuera
   del alcance de un builder de backend; lo hace el orquestador humano al
   cerrar el pedido, como en 1b-1.

9. **A-10 sólo lo cerré donde mi territorio llega.** El hallazgo señala
   `PaymentTargetPanel.tsx` (frontend, ajeno) derivando «Total a cobrar» =
   `target.totals.total + tip?.amount` ANTES de cobrar — ese número sale de
   `OrderOut.totals`/`SubAccountOut.totals` + `OrderOut.tip`/`SubAccountOut.tip`,
   que viven en `app/orders/schemas.py` (territorio ajeno, explícitamente
   "no tocás" en mi mandato). Lo que agregué es `PaymentOut.amount_due`
   (siempre presente, `total + tip_amount`) para el momento DESPUÉS de
   cobrar (`POST /orders/{id}/payments`, `DocumentPrintableOut` ya lo
   discrimina). El número que el operador ve mientras arma los `splits`
   (ANTES de cobrar, en la pantalla de checkout) sigue siendo un cálculo
   del cliente sobre dos números del servidor — el arreglo completo (un
   `amount_due` en `PreBillOut`/`SubAccountOut`) necesita que alguien con
   `app/orders/schemas.py` en su territorio en este pedido 1b-2 lo agregue,
   y que `frontend-cobro` dejar de sumar en `PaymentTargetPanel.tsx`. Lo
   declaro explícito para que no se dé por cerrado sin querer.

## 8. Ronda 2 — B-2 (corrección, ronda de iteración del Conciliador)

### 8.1 El hallazgo

B-2 (bloqueante, plata): cobrar con `customer` en el body y la flag
`customers` apagada respondía el `400 FEATURE_DISABLED` correcto, pero el
gate que lo levanta (`features.assert_feature(..., "customers")`, dentro de
`app/customers/hooks.py::upsert_customer_with_consent`) corría **después**
de `orders_service.claim_payment` — y `app.core.db.get_db` comitea también
ante `AppError` (`AGENTS.md`, `docs/ESTADO.md § Reglas duras`: "validar
antes de escribir"). Resultado real antes del arreglo: la comanda quedaba
`paid`, sin `Payment` y sin `FiscalDocument` — la venta se perdía entera,
mismo defecto de forma que el `NO_FISCAL_RANGE` que yo mismo encontré y
corregí en la ronda anterior (§5.1 de este entregable) con
`assert_range_available`.

### 8.2 El arreglo — archivo:línea antes/después

**Antes** (ronda 1, `backend/app/payments/service.py`): el único chequeo
temprano en el bloque de validación (líneas ~428-431 de la ronda 1) era el
de rango fiscal; no existía ningún chequeo de la flag `customers` antes del
punto sin retorno. El primer punto donde el cobro podía tropezar con
`FEATURE_DISABLED` por `customers` era `resolve_customer_snapshot` (línea
~459 de la ronda 1), llamada DESPUÉS de `claim_payment` (línea ~448 de la
ronda 1).

**Después** (`backend/app/payments/service.py:449-450`, dentro de
`pay_order`, inmediatamente después del bloque
`if split_results: fiscal_service.assert_range_available(...)` que cierra
en la línea 431, y ANTES de `orders_service.auto_send_pending_for_payment`
(línea 466) / `orders_service.claim_payment` (línea 467)):

```python
    if split_results and payload.customer is not None:
        features.assert_feature(db, order.organization_id, store.id, "customers")
```

`from app.core import clock, features` ya estaba importado (línea 32 del
archivo, sin cambios): no agregué ningún import nuevo. Uso
`features.assert_feature`, la MISMA función que llama
`app/customers/hooks.py:91` — mismo status (400 por default de `AppError`),
mismo código (`FEATURE_DISABLED`), mismo mensaje
(`f'La función "{key}" está apagada; habilitala en Admin → Funciones'`,
`app/core/features.py:386-392`) y mismo `extra={"feature": "customers"}`.
No escribí un mensaje a mano ni inventé un código nuevo — verificado
leyendo `app/core/features.py:386-392` antes de escribir la línea.

`features.assert_feature(..., "customers")` dentro de
`app/customers/hooks.py::upsert_customer_with_consent` (línea 91) **se
queda donde está**: no lo toqué (no es mi territorio) y sigue siendo
defensa en profundidad — si algún día otro camino llega a
`upsert_customer_with_consent` sin pasar por mi gate nuevo, ese sigue
cortando.

### 8.3 La condición elegida, y por qué

`if split_results and payload.customer is not None:` — exactamente la
condición bajo la cual `pay_order` llega HOY a
`fiscal_service.resolve_customer_snapshot` (que es lo único que puede
disparar el gancho de `app.customers`): dentro de `if split_results:`
(una comanda 100% cortesía/`staff_meal`, sin `splits`, nunca emite
documento ni toca clientes — con o sin `customer` en el body) y sólo si
`payload.customer` no es `None` (sin `customer`, `resolve_customer_snapshot`
devuelve `CONSUMER_FINAL` sin tocar `app.customers` en absoluto, `app/fiscal
/service.py:509-510`). Elegí replicar esta condición en vez de una más
amplia (p. ej. `if split_results:` a secas, sin mirar `payload.customer`)
porque una condición más amplia habría convertido la flag `customers` en
bloqueante para TODO cobro con splits, incluidos los que nunca la
necesitan — cambio de comportamiento que el veredicto no pidió y que
`docs/ESTADO.md § Reglas duras` prohíbe ("lo que es ley... NO es un flag",
pero el corolario simétrico también vale: una flag apagada no puede
bloquear lo que no depende de ella). Verificado con el test de no
regresión (§8.5): mismo cobro, flag apagada, sin `customer` → sigue en
`201`.

### 8.4 Barrido del punto 4 (todo lo que corre después de `claim_payment`)

Recorrí, línea por línea, todo lo que se ejecuta desde
`orders_service.claim_payment` (línea 467) hasta el `return PaymentOut(...)`
final, buscando cualquier otra validación capaz de levantar `AppError`
después del punto sin retorno:

- **`resolve_customer_snapshot`** (`app/fiscal/service.py:499-544`): ya
  cubierto por este arreglo. Dentro, `upsert_customer_with_consent` sólo
  hace `assert_feature` (cubierto), un `SELECT`/`INSERT` de `Customer` y un
  `INSERT` de `CustomerConsent` — ninguno de los dos levanta `AppError`.
- **`methods_by_code`** (`_payment_methods_by_code`) y la resolución/
  validación completa de los `splits` (`_validate_and_allocate_splits`,
  con `PAYMENT_METHOD_INVALID`, `PAYMENT_REFERENCE_REQUIRED`,
  `CHANGE_ONLY_ON_CASH`, `SPLITS_DO_NOT_MATCH`, `TENDERED_TOO_LOW`): **ya
  corren ANTES** del punto sin retorno (líneas 395-398, antes de la
  resolución de `business_date`/`document_type`/rango) — no son parte del
  barrido, las encontré en su lugar correcto (esto es lo que ya dejó
  hecho la ronda 1, no un hallazgo nuevo).
- **`issue_document`** (`app/fiscal/service.py:609-712`): la única llamada
  que puede levantar `AppError` ahí adentro es `reserve_next_number`
  (`NO_FISCAL_RANGE`/`FISCAL_RANGE_EXHAUSTED`) — ya cubierta por
  `assert_range_available`, el chequeo temprano equivalente que agregué en
  la ronda 1 (mismo patrón que este arreglo). Queda la ventana de carrera
  microscópica entre el chequeo puro y la reserva real dentro del
  `SAVEPOINT` (documentada como residual ya aceptado en §5.1 de este mismo
  entregable, mismo tipo de riesgo que `backend-cobro` aceptó para
  `target_key` en 1b-1) — no es un hallazgo nuevo de este barrido, es el
  mismo residual ya declarado. El resto de `issue_document` (armar la fila,
  `db.add`, `db.flush()`, `emit_and_apply`) no valida nada que pueda
  fallar con `AppError`.
- **`emit_and_apply`** (`app/fiscal/service.py:419-428`): llama
  `get_provider(db, store).emit(document)`. Ni `PendingTransmissionProvider`
  ni `FakeProvider` levantan `AppError` — devuelven siempre un `EmitResult`
  (inclusive el rechazo y la contingencia son resultados, no excepciones).
  Sin validación de negocio ahí.
- **Escritura de `OrderTip`/`Payment`** (líneas ~495-533 de esta ronda):
  son `db.add(...)` puros sobre dataclasses ya validadas más arriba
  (`_resolve_tip`, `_validate_and_allocate_splits`); ninguna línea de este
  bloque contiene un `raise`.
- **`record_audit`** (línea ~535 en adelante): sólo escribe, no valida.

**Resultado del barrido: no apareció ninguna otra validación además de la
de `customers` que este arreglo ya cubre.** Lo declaro con esa palabra tal
como pide el punto 4 del ajuste de iteración: ninguna.

### 8.5 Tests nuevos (`backend/tests/payments/test_customer_hook.py`)

1. `test_customer_feature_disabled_blocks_the_payment` (reescrito, mismo
   nombre que ya existía en la ronda 1 pero con aserciones incompletas —
   sólo comprobaba el `400`/código; lo completé con las CUATRO
   verificaciones que pide el ajuste): cobra con `customer` en el body y la
   flag `customers` apagada, y comprueba (1) `400` con `code
   "FEATURE_DISABLED"`, (2) `GET /orders/{id}` responde `status != "paid"`,
   (3) `count(Payment) == 0`, (4) `count(FiscalDocument) == 0`. Es la
   réplica, en mi territorio, del rojo real de B-2
   (`tests/audit/test_privacy_invariants.py
   ::test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale`,
   territorio ajeno, no lo edité).
2. `test_customer_feature_disabled_without_customer_in_body_still_charges`
   (nuevo): mismo cobro, misma flag apagada, SIN `customer` en el body →
   `201`, documento emitido a "Consumidor final". Prueba explícitamente que
   el arreglo no cambió el comportamiento del caso que ya funcionaba (la
   condición de §8.3).

### 8.6 Verificación (comandos y resultado literal)

```
$ cd backend && TMPDIR=/tmp/pt-backend-fiscal python -m pytest tests/payments tests/fiscal -q
........................................................................ [ 97%]
..                                                                       [100%]
74 passed, 138 warnings in 252.12s (0:04:12)
```

```
$ cd backend && TMPDIR=/tmp/pt-backend-fiscal python -m pytest "tests/audit/test_privacy_invariants.py::test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale" -q
.                                                                        [100%]
1 passed, 6 warnings in 3.74s
```

El rojo citado por el Conciliador pasó a VERDE. No toqué ningún archivo
bajo `backend/tests/audit/`: verificado con el diff de esta ronda (sólo
`app/payments/service.py` y `tests/payments/test_customer_hook.py`
cambiaron) — el rojo se apagó con código de producción
(`app/payments/service.py`), nunca aflojando la aserción del test ajeno.

```
$ cd backend && python -m mypy app
Success: no issues found in 89 source files
```

(89 archivos fuente esta ronda contra 84 de la ronda 1 — el delta son
archivos de otros territorios que avanzaron en paralelo; ninguno mío.)

### 8.7 Alcance de esta ronda

No abrí A-10/`amount_due` en `app/orders/schemas.py`, ni la FK dura de
`FiscalDocument.customer_id`, ni el ZIP de evidencia — siguen exactamente
como quedaron declarados en gaps (§7, puntos 2, y la decisión §4.2) al
cierre de la ronda 1. Esta ronda tocó únicamente
`backend/app/payments/service.py` (el gate nuevo) y
`backend/tests/payments/test_customer_hook.py` (los dos tests). No edité
`backend/app/customers/**` ni `backend/tests/audit/**`.
