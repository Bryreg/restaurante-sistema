# backend-cobro — Pedido 1b-1 (comanda y cobro)

Agente: `backend-cobro`. Territorio: `backend/app/payments/**`, `backend/app/fiscal/**`
(sin router: no lo pide 1b-1), `backend/alembic/versions/0005_payments_fiscal.py`,
`backend/tests/payments/**`, `backend/tests/fiscal/**`.

## 1. Resumen

Implementado el cobro completo de 1b-1: tabla de pagos con medios configurables,
pagos mixtos, propina separada, cambio sólo en efectivo, división de cuenta (partes
iguales y por ítems/sub-cuentas con documento propio), versión optimista, idempotencia,
409 ante concurrencia, y el comprobante interno de venta (`fiscal_document`, tipo
`pos_equivalent` con `dian_status="pending"` o `internal_receipt` con `dian_status=NULL`
según el flag `fiscal.dee_pos`) con consecutivo por sede sin huecos, reimpresión contada
y listado admin. **Nada se emite ni se transmite a la DIAN**: no hay `FiscalProvider`,
rangos de numeración, estados de validación ni contingencia — eso es 1b-2, y el modelo
ya deja los campos de evidencia (`cude`, `qr_url`, `xml_ref`, `provider_response`,
`fiscal_range_id`, `validated_at`) en `NULL` para que 1b-2 sólo tenga que llenarlos.

Todo el trabajo se apoyó en `app/orders/{models,service,schemas,money,hooks}.py`, que ya
estaba completo cuando empecé (backend-comanda había terminado su parte): las firmas
públicas de §2.3 del contrato interno (`get_order_or_404`, `get_sub_account_or_404`,
`compute_order_totals`, `compute_sub_account_totals`, `order_out`, `assert_payable`,
`claim_payment`, `auto_send_pending_for_payment`, `business_date_for_sale`) existían
exactamente como las documenta el contrato y se llamaron sin sorpresas. No hubo ningún
gap por módulo ausente.

## 2. Archivos tocados

**Modelos y migración**
- `backend/app/payments/models.py` — `Payment`, `OrderTip`.
- `backend/app/fiscal/models.py` — `FiscalDocumentType`, `DianStatus`, `FiscalCounter`,
  `FiscalDocument`, `DocumentReprint`.
- `backend/alembic/versions/0005_payments_fiscal.py` — DDL a mano (Postgres-first,
  corre en SQLite), `revision="0005"`, `down_revision="0004"`.

**Servicios**
- `backend/app/fiscal/service.py` — `reserve_next_number`, `issue_document`
  (+ `TipSnapshot`, `_resolve_document_type`, `_legend_for`, `_dian_status_for`).
- `backend/app/payments/service.py` — `pay_order`, `get_document_or_404`,
  `get_last_document`, `reprint_document`, `document_printable`, `admin_list_documents`
  (+ helpers privados de validación, asignación de propina por medio, líneas del
  comprobante y snapshot de mesas).

**Esquemas y router**
- `backend/app/payments/schemas.py` — `PaymentIn`/`PaymentOut`, `DocumentPrintableOut`
  y afines, `AdminDocumentListItem`.
- `backend/app/payments/router.py` — los 5 endpoints de §2.4 «Cobro y comprobante».

**Tests**
- `backend/tests/payments/conftest.py`, `test_pay_flow.py`, `test_concurrency.py`,
  `test_split.py`, `test_documents.py`.
- `backend/tests/fiscal/conftest.py`, `test_counter.py`.
- `backend/tests/payments/__init__.py`, `backend/tests/fiscal/__init__.py`.

Ningún archivo de otro territorio fue tocado (verificado: no hay escrituras en
`app/orders`, `app/kitchen`, `app/catalog`, `app/shifts`, `app/auth`, `app/stores`,
`app/core`, `app/audit`, `app/notifications`, `docs/ESTADO.md`, `.claude/launch.json`,
`tests/conftest.py` ni ningún `tests/<otro-dominio>`).

## 3. Endpoints expuestos (`/api/v1`, todos en `backend/app/payments/router.py`)

- `POST /orders/{order_id}/payments` (`current_operator`, `Idempotency-Key` scope
  `orders.payments`) → `201 PaymentOut`.
- `GET /documents/last` (`current_device`) → `DocumentPrintableOut | null`. Declarada
  **antes** de `/documents/{document_id}` (si no, FastAPI la captura como
  `document_id="last"`).
- `GET /documents/{document_id}` (dispositivo o admin — dependencia `_device_or_admin`,
  mismo patrón que `app.catalog.router._catalog_read_actor`) → `DocumentPrintableOut`.
- `POST /documents/{document_id}/reprint` (`current_operator`) → `DocumentPrintableOut`
  con `reprint_count += 1` y una fila nueva en `document_reprints`.
- `GET /admin/documents?store_id&from&to` (`current_admin` + `admin_store`, admite
  `format=csv`) → lista mínima.

Sin rutas de rangos, notas ni contingencia (1b-2). `app/fiscal` no tiene router: el
contrato lo pide así (§2.3 sólo declara `service.py` para `fiscal`).

## 4. Firmas de §2.3 implementadas

```python
# app/payments/service.py
def pay_order(db, *, actor: Actor, store: Store, shift: Shift | None, order: Order,
              payload: PaymentIn, now: datetime) -> PaymentOut
def get_document_or_404(db, *, actor: Actor, document_id: int) -> FiscalDocument
def document_printable(db, document: FiscalDocument) -> DocumentPrintableOut

# app/fiscal/service.py
def reserve_next_number(db, *, store_id: int, document_type: str, prefix: str) -> int
def issue_document(db, *, order, sub_account, shift, store, actor, totals, tip, lines,
                    payments_snapshot, tables_text, business_date, now) -> FiscalDocument
```

`issue_document` recibe `lines` y `tables_text` además de lo que lista el contrato: la
prosa de §2.3 no detalla cómo se arman las líneas del comprobante (`FiscalDocument.lines`
JSON con `qty`/`description`/`courtesy` por línea), así que ese cálculo vive en
`app.payments.service` (única llamadora de `issue_document`) y se pasa ya resuelto —
`reserve_next_number` sí se llama exactamente como la documenta el contrato, dentro de
`issue_document`, dentro de la transacción del cobro.

**Firmas de `app.orders.service` que consumo** (todas existían tal cual el contrato,
sin necesidad de declarar gap): `get_order_or_404`, `get_sub_account_or_404`,
`compute_order_totals`, `compute_sub_account_totals`, `order_out`, `assert_payable`,
`claim_payment`, `auto_send_pending_for_payment`, `business_date_for_sale`. También leo
directamente (sólo lectura, mismo patrón que `orders.service._order_document_id` lee
`app.fiscal.models`) los modelos `Order`, `OrderChannel`, `OrderItem`, `OrderItemStatus`,
`OrderSubAccount`, `OrderSubAccountItem`, `OrderTable` de `app.orders.models` — necesario
porque `compute_order_totals`/`compute_sub_account_totals` sólo devuelven totales por
línea (`item_id`, montos), no `qty`/`nombre`/`courtesy`, que el comprobante sí necesita
en `FiscalDocument.lines`. Ningún import usa `find_spec_safe`: `app.orders` ya existía
completo cuando empecé a escribir código (comprobado con `ls backend/app/orders` antes
de arrancar), así que no hay ambigüedad de orden de arranque que cubrir.

También uso directamente `app.stores.service.{get_sales_settings, current_fiscal}`,
`app.shifts.service.get_current_shift`, `app.auth.service.verify_pin`, y
`app.audit.service.record_audit` — todos exactamente como los documenta
`CONTRATO-INTERNO.md` de 1a / `CONTRATO-INTERNO-1b-1.md`.

## 5. Tablas de la migración 0005

| Tabla | Filas clave | Constraints |
|---|---|---|
| `fiscal_counters` | `store_id`, `document_type`, `prefix`, `next_number` | `UNIQUE(store_id, document_type, prefix)`; `CHECK(next_number >= 1)` |
| `fiscal_documents` | ver §2.2 del contrato completo | `target_key` `UNIQUE`; `UNIQUE(store_id, document_type, prefix, number)`; `CHECK(number >= 1)`; índices por `order_id`, `sub_account_id`, `shift_id`, `organization_id`, `store_id`, `(store_id, business_date)` |
| `document_reprints` | `document_id`, `employee_id`, `employee_name`, `at` | índice por `document_id` |
| `payments` | `shift_id`, `order_id`, `sub_account_id`, `document_id`, `method`, `amount`, `tip_amount`, `tendered`, `change`, `reference`, `business_date` | `CHECK(amount>=0)`, `CHECK(tip_amount>=0)`, `CHECK(change>=0)`; índices por `shift_id`, `order_id`, `(shift_id, method)` |
| `order_tips` | `order_id`, `sub_account_id`, `asked/accepted/modified`, `amount`, `suggested_pct`, `suggested_amount`, `base` | `CHECK(amount>=0)`; índices por `order_id`, `sub_account_id` |

Verificado columna por columna contra los modelos con un script que compara
`PRAGMA table_info` contra `Base.metadata.tables[...].columns` (sin diferencias) — el
mismo criterio que usa `tests/audit/test_migration_invariants.py`. `downgrade()` deshace
las cinco tablas en orden inverso; probé `upgrade head → downgrade 0004 → upgrade head`
sin error.

## 6. Decisiones declaradas

1. **Orden de validación de `tendered`/cambio, reordenado respecto de la prosa del
   contrato.** El contrato describe el flujo como "…→ `claim_payment` → asignación de
   propina por medio y `change = tendered − amount − tip_amount` (`TENDERED_TOO_LOW`) →
   `reserve_next_number` + `issue_document`…", es decir, después de la escritura que
   marca la comanda `paid`. Pero `validar antes de escribir` es una regla dura del
   proyecto (`get_db` comitea también ante `AppError`) y el cálculo de `TENDERED_TOO_LOW`
   no depende de ningún efecto de `claim_payment` — sólo de `total`, `tip_amount` y los
   `splits` del body. Implementé toda la validación (incluida la asignación de propina
   por medio y el cómputo de cambio) **antes** de `auto_send_pending_for_payment`/
   `claim_payment`: mismo resultado observable, pero un `TENDERED_TOO_LOW` nunca deja la
   comanda marcada `paid` sin pago ni documento. Documentado también como comentario en
   `app/payments/service.py`.
2. **Asignación de propina por medio**: recorriendo `splits` en el orden que llegan,
   cada uno cubre primero lo que falte de la venta (`total`) y el excedente es propina
   de ese medio — un reparto tipo "cascada". Con `splits=[cash:3000, card:2500]` sobre
   `total=5000, tip=500`: `cash.amount=3000, cash.tip=0`; `card.amount=2000,
   card.tip=500` (probado en `test_mixed_cash_card_with_tip_assigned_per_method`).
3. **Tipo de documento por flag**: `fiscal.dee_pos` encendida → `pos_equivalent` +
   `dian_status="pending"` + leyenda "DOCUMENTO PENDIENTE DE TRANSMISIÓN A LA DIAN";
   apagada → `internal_receipt` + `dian_status=NULL` + leyenda "COMPROBANTE INTERNO —
   no es factura ni documento equivalente". Prefijo fijo `"POS"` en ambos casos (hasta
   que 1b-2 traiga rangos DIAN reales). Cada tipo tiene su propio consecutivo
   (`UNIQUE(store_id, document_type, prefix)`), probado en
   `tests/fiscal/test_counter.py::test_internal_receipt_and_pos_equivalent_have_independent_counters`.
4. **`target_key` como respaldo de `claim_payment`**: `issue_document` corre dentro de
   un `db.begin_nested()` (SAVEPOINT) junto con `reserve_next_number`; un
   `IntegrityError` (por `target_key` o por el consecutivo) hace `rollback` de la
   savepoint — el número reservado también se libera, sin huecos — y se traduce a
   `409 ORDER_ALREADY_PAID`. En la práctica `claim_payment` (UPDATE condicional atómico
   con `rowcount`) ya resuelve la carrera principal antes de llegar acá; este es un
   backstop defensivo, sin test dedicado a forzarlo (haría falta manipular la base a
   mano para producir la colisión).
5. **Líneas del comprobante para sub-cuentas**: `compute_sub_account_totals` (de
   `orders.service`) devuelve `lines=[]` a propósito (no está en la lista de firmas
   públicas). Repliqué el mismo criterio de `orders.service._sub_account_item_allocations`
   (prorratear cada línea de la comanda completa entre TODAS las sub-cuentas que
   comparten ese ítem, con `money.prorate`, y quedarme sólo con las porciones de la
   sub-cuenta que se está cobrando) usando únicamente piezas públicas
   (`compute_order_totals` + `app.orders.money.prorate`), en
   `app.payments.service._sub_account_document_lines`. Documentado en el código.
6. **Snapshot de mesas y líneas ANTES de `claim_payment`**: `claim_payment` libera las
   mesas (`_release_tables`) en el mismo `UPDATE` que marca la comanda `paid`; leer
   `tables_text`/las líneas del ítem *después* de esa escritura ya no encontraría las
   mesas ocupadas. Por eso el comprobante arma su snapshot (líneas, mesas) inmediatamente
   después de validar todo y **antes** de `auto_send_pending_for_payment`/`claim_payment`.
7. **`served_by_name` del comprobante** = `order.opened_by_employee_name` (quien abrió/
   atendió la comanda): el modelo de `Order` no tiene un campo de "mesero asignado"
   separado; es la única persona atribuible al servicio de la mesa en 1b-1.
8. **Test de concurrencia con `threading.Thread` + criterio de aceptación doble**
   (`400 ORDER_NOT_OPEN` **o** `409 ORDER_ALREADY_PAID` para la perdedora), igual que
   `tests/shifts/test_open.py::test_two_concurrent_opens_one_wins_and_the_other_is_rejected`
   (la carrera análoga de 1a, documentada en `docs/ESTADO.md` como D-2). Motivo: la
   línea de defensa real (`claim_payment`'s `UPDATE ... WHERE status IN (...) AND
   paid_at IS NULL`) sólo produce `409` si ambos hilos alcanzan a leer la comanda
   todavía `open` antes de que el ganador comitee; en SQLite con GIL, sin un punto de
   sincronización explícito, a veces el segundo hilo arranca después de que el primero
   ya comiteó — en ese caso `assert_payable` (territorio de `backend-comanda`, no lo
   cambio) corta antes con `400 ORDER_NOT_OPEN`, que también es un rechazo limpio y
   declarado. Corrí el test 5 veces seguidas sin fallos (ver §7); en ninguna corrida
   hubo doble `201` ni un documento duplicado, que es el invariante real que importa.
9. **`Employee.can_charge`** se resuelve leyendo `db.get(Employee, actor.employee_id)`
   dentro de `pay_order` (no hay un campo `can_charge` en `Actor`): coherente con cómo
   ya se resuelve el PIN propio (`auth_service.verify_pin` también recibe el `Employee`,
   no el `Actor`).

## 7. Verificación (comandos y resultado literal)

```
$ cd backend && mkdir -p /tmp/pt-backend-cobro
$ TMPDIR=/tmp/pt-backend-cobro python -m pytest tests/payments tests/fiscal -q -x
................................                                         [100%]
32 passed, 63 warnings in 94.12s (0:01:34)
```

(las advertencias son `StarletteDeprecationWarning`/`InsecureKeyLengthWarning`, ajenas
a este territorio, ya presentes en el resto de la suite).

Repetí `tests/payments/test_concurrency.py` 5 veces seguidas para confirmar que el
criterio de aceptación doble (§6.8) es estable — 5/5 en verde, sin `201` duplicado ni
`fiscal_document` duplicado en ninguna corrida.

```
$ DATABASE_URL=sqlite:////tmp/pt-backend-cobro/mig.db python -m alembic upgrade head
INFO  [alembic.runtime.migration] Running upgrade  -> 0001, ...
INFO  [alembic.runtime.migration] Running upgrade 0001 -> 0002, ...
INFO  [alembic.runtime.migration] Running upgrade 0002 -> 0003, ...
INFO  [alembic.runtime.migration] Running upgrade 0003 -> 0004, ...
INFO  [alembic.runtime.migration] Running upgrade 0004 -> 0005, Pagos y comprobante interno: ...
```

`upgrade head → downgrade 0004 → upgrade head` sin error. Columnas de las 5 tablas
verificadas una por una contra los modelos (`PRAGMA table_info` vs
`Base.metadata.tables[...].columns`): sin diferencias.

```
$ python -m mypy app
Success: no issues found in 67 source files
```

(Nota: al empezar a trabajar, `docs/ESTADO.md` reportaba 10 errores de mypy en
`app/orders/service.py`, territorio de `backend-comanda`. Al cerrar mi trabajo, ese
archivo ya estaba limpio — lo corrigió `backend-comanda` en paralelo; no toqué ese
archivo.)

`GET /api/v1/openapi.json` sin `"cost"`/`"margin"`/`"unit_cost"` en ningún esquema
(verificado con un script y con `tests/payments/test_documents.py::test_openapi_device_responses_never_expose_cost_fields`).

No corrí la suite completa (`pytest -q` sin filtro) ni `npm run build`: eso es del paso
de verificación final del Maestro, como manda el contrato (`AGENTS.md`,
`CONTRATO-INTERNO-1b-1.md §8`).

## 8. Qué queda preparado para 1b-2 y qué NO se construyó

**Preparado, sin construir:**
- `FiscalDocument` ya tiene todas las columnas de evidencia DIAN (`fiscal_range_id`,
  `cude`, `qr_url`, `xml_ref`, `provider_response`, `validated_at`) en `NULL`;
  `DianStatus` ya declara `sent`/`validated`/`rejected`/`contingency` (sin usar);
  `FiscalDocumentType` ya declara `invoice`/`adjustment_note`/`credit_note`/`debit_note`
  (sin usar). 1b-2 sólo necesita agregar el adaptador `FiscalProvider`, la tabla de
  rangos DIAN y el proceso de transmisión/reintento — no tocar el esquema de
  `fiscal_documents`.
- `DocumentPrintableOut.fiscal` ya expone la forma `{range, cude, qr_url}` (siempre
  `null` en 1b-1); el frontend de 1b-2 no necesita un cambio de contrato, sólo datos.
- `payments_snapshot`/`store_snapshot`/`lines` en el documento ya congelan todo lo que
  una representación gráfica fiscal necesita (medio con `dian_code`, adquirente,
  totales por tarifa) salvo el CUDE/QR.

**Explícitamente NO construido (es 1b-2):** rangos de numeración DIAN, estados de
validación, contingencia de 48 h y su notificación (`fiscal_contingency_overdue`),
`FiscalProvider` (interfaz ni implementaciones), notas de ajuste/crédito/débito,
devoluciones pendientes, maestro de clientes y consentimientos, factura electrónica a
cliente identificado (`fiscal.invoice`, el flag existe pero nada la usa), `GET
/admin/fiscal/*`, `POST /admin/documents/{id}/notes`.

## 9. Gaps

Ninguno. `app/orders` (modelos, `service.py`, `schemas.py`, `router.py`, `hooks.py`,
`money.py`) y `app/shifts` (`service.py`, `hooks.py`, `get_current_shift`) ya existían
completos y probados cuando arranqué, con las firmas exactas del contrato — no hubo que
declarar nada como bloqueado ni seguir con supuestos a comprobar después.
