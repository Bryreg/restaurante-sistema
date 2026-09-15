# backend-clientes-dinero — entrega (pedido 1b-2)

Rol: **clientes con habeas data, devoluciones pendientes y propinas**
(`restaurante-sistema`). Territorio: `backend/app/customers/**`,
`backend/app/refunds/**`, `backend/app/shifts/**`, `backend/app/notifications/**`,
`backend/alembic/versions/0006_customers_refunds_tips.py`,
`backend/tests/{customers,refunds,shifts,notifications}/**`.

No toqué `app/fiscal`, `app/payments`, `app/orders`, `app/kitchen`,
`app/reports`, `app/stores`, `app/main.py`, `app/core/**`, `tests/audit`,
`tests/conftest.py`, ni nada de `frontend/`. Cinco agentes trabajaron en
paralelo sobre el mismo árbol (esta entrega registra los momentos en que el
árbol cambió debajo mío, no son suposiciones).

## 1. Qué construí

| Archivo | Qué |
|---|---|
| `app/customers/__init__.py` | Vacío — arrancó primero, antes que nada, para que ningún `find_spec_safe("app.customers.*")` de otro agente lance `ModuleNotFoundError`. |
| `app/customers/models.py` | `Customer`, `CustomerConsent`, `CustomerDataRequest`, enums `ConsentPurpose`/`DataRequestKind`. |
| `app/customers/hooks.py` | `upsert_customer_with_consent` — la única puerta de escritura del dispositivo hacia este dominio. |
| `app/customers/schemas.py` | `CustomerOut`, `CustomerPatchIn`, `ConsentIn`/`ConsentOut`, `DataRequestOut`, `EraseIn`. |
| `app/customers/service.py` | `list_customers`, `get_customer_or_404`, `patch_customer` (rectificación + bitácora), `add_consent` (+ bitácora si `granted=False`), `list_consents`, `list_requests`, `erase_customer` (anonimización idempotente + bitácora + auditoría). |
| `app/customers/router.py` | `GET/PATCH /admin/customers`, `POST /admin/customers/{id}/consents`, `GET /admin/customers/{id}/requests`, `POST /admin/customers/{id}/erase`. |
| `app/refunds/__init__.py` | Vacío, mismo motivo que `app/customers/__init__.py`. |
| `app/refunds/models.py` | `PendingRefund`, enums `PendingRefundStatus`/`SettleFrom`. |
| `app/refunds/hooks.py` | `settle_or_queue_refund` — la única puerta por la que una nota mueve caja. |
| `app/refunds/schemas.py` | `PendingRefundOut`, `SettlePendingRefundIn`. |
| `app/refunds/service.py` | `list_pending_refunds`, `get_pending_refund_or_404`, `settle_pending_refund`. |
| `app/refunds/router.py` | `GET /admin/pending-refunds`, `POST /admin/pending-refunds/{id}/settle`. |
| `app/notifications/service.py` | `NOTIFICATION_TYPES` gana `fiscal_rejected`, `fiscal_contingency_overdue`, `fiscal_range_low`, `pending_refund` (los otros cinco de 1b-1 quedaron intactos, sin duplicar). |
| `app/shifts/models.py` | `TipPayout`, `TipPayoutDistribution` (agregado al final del archivo, sin tocar nada existente). |
| `app/shifts/schemas.py` | `EmployeeActivitySales/Voids/Discounts/Courtesies/Tips/Metrics` (extiende `EmployeeActivityOut` con `activity`/`team_average`); `TipsByEmployeeOut`, `ShiftTipsOut`, `TipPayoutIn/Out` y afines. |
| `app/shifts/activity_metrics.py` **(nuevo)** | `employee_sales_metrics`, `team_average_metrics` — lee `Order`/`OrderItem`/`OrderDiscount`/`Payment`/`FiscalDocument`/`DocumentReprint` de sólo lectura, protegido con `find_spec_safe`. |
| `app/shifts/tips.py` **(nuevo)** | `get_shift_tips`, `register_tip_payout`, `tip_payout_out`. |
| `app/shifts/service.py` | `employee_activity` ahora también devuelve `activity`/`team_average` (llama a `activity_metrics`). |
| `app/shifts/router.py` | `GET /shifts/{id}/tips`, `POST /admin/tips/payouts`, `format=csv` en `GET /admin/employees/{id}/activity`. |
| `alembic/versions/0006_customers_refunds_tips.py` | `customers`, `customer_consents`, `customer_data_requests`, `pending_refunds`, `tip_payouts`, `tip_payout_distributions`. `down_revision="0005"`. |
| `tests/customers/**`, `tests/refunds/**`, `tests/shifts/test_tips.py`, `tests/shifts/test_employee_activity.py`, `tests/notifications/test_notification_types_1b2.py` | Ver §3. |

## 2. Contrato público

### 2.1 `app.customers.hooks.upsert_customer_with_consent` (firma exacta)

```python
def upsert_customer_with_consent(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    doc_type: str,
    doc_number: str,
    dv: str | None,
    name: str,
    email: str | None,
    address: str | None,
    municipality_dane: str | None,
    consent: "ConsentInput | dict[str, Any] | Any",
    actor: ActorLike | Any,
    now: datetime,
) -> Customer
```

- Busca un `Customer` por `(organization_id, doc_type, doc_number)`; si existe, actualiza sus datos con los más recientes (misma persona, otra sede de la cadena); si no, lo crea.
- Siempre agrega una fila **nueva** de `CustomerConsent` (purpose=`invoice`, `granted=True`) — evidencia de que ESE cobro recolectó los datos con autorización, nunca se pisa la anterior.
- `400 FEATURE_DISABLED` si la flag `customers` está apagada en la sede (el gate vive en el gancho, no depende de que el llamador lo repita).
- **`consent` acepta tres formas**: la clase `ConsentInput` (`text_version`, `channel`), cualquier objeto con esos dos atributos, o un `dict` plano `{"text_version": ..., "channel": ...}`. Esto no es hipotético: mientras construía, `app.fiscal.service.resolve_customer_snapshot` (ya escrito por `backend-fiscal`) apareció llamando este gancho con `consent=customer_in.consent.model_dump(mode="json")` — un `dict`. Sin la normalización (`_consent_fields`), el gancho reventaba con `AttributeError` en cuanto se ejercitara de verdad. Lo cubre `tests/customers/test_hooks.py::test_accepts_a_plain_dict_consent_too`.
- `actor`/`order_id` no son parte del contrato original, pero **`app.fiscal.service.settle_or_queue_refund_for_note`** (ver más abajo, no es este gancho, es el de refunds) sí manda parámetros extra — documentado en §2.2.

### 2.2 `app.refunds.hooks.settle_or_queue_refund` (firma exacta + compatibilidad real)

```python
def settle_or_queue_refund(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    document_id: int,
    method: str,
    amount: int,
    actor: Any,
    now: datetime,
    order_id: int | None = None,   # opcional, no rompe el contrato
    reason: str | None = None,     # opcional, no rompe el contrato
) -> RefundOutcome
```

```python
@dataclass(frozen=True)
class RefundOutcome:
    status: Literal["settled_in_shift", "pending", "settled_externally"]
    pending_refund_id: int | None = None
    cash_movement_id: int | None = None
    shift_id: int | None = None
```

- `method == "cash"` y hay turno abierto en la sede → crea `CashMovement(kind=expense, cause=refund)` en ESE turno. `status="settled_in_shift"`.
- `method == "cash"` y NO hay turno abierto → crea `PendingRefund` (monto, cliente —resuelto del snapshot del documento—, documento, quién autorizó) y `notify("pending_refund")`. `status="pending"`.
- `method != "cash"` (tarjeta/transferencia) → `status="settled_externally"`, no crea nada (la reversa la hace el adquirente/el banco, fuera de este sistema — SPEC-NEGOCIO §6.3 sólo describe el circuito de efectivo; decisión declarada).
- **`order_id`/`reason` son adicionales, con default, fuera del contrato que me dio el Maestro**: mientras construía, `app.fiscal.service.settle_or_queue_refund_for_note` (ya escrito, ver `app/fiscal/service.py:801-826`) apareció llamando este gancho con `order_id=note.order_id` y `reason=note.reason or ""` además de los parámetros del contrato. Sin aceptarlos, la llamada real de producción reventaría con `TypeError: unexpected keyword argument`. Los acepté como **opcionales con default `None`** (no cambia la firma para quien ya la use tal cual la publiqué) y uso `reason` para enriquecer la nota del `CashMovement`; `order_id` queda reservado sin usar. **Importante para quien reconcilie el contrato interno**: la llamada real pasa `document_id=note.id` (el id de la NOTA, no el de la venta original) — así quedó probado en `tests/refunds/test_pending_refund_e2e.py::test_the_notes_endpoint_calls_the_hook_end_to_end`.
- Gated por la flag: **no** — SPEC-NEGOCIO §6.3 no lo declara opcional (una devolución en efectivo siempre se resuelve de alguna manera); no es una función que se pueda apagar.

### 2.3 Rutas

#### Clientes (`app/customers/router.py`)

| Ruta | Actor | Payload | Respuesta | Gate |
|---|---|---|---|---|
| `GET /admin/customers?doc_number=` (+`format=csv`) | admin | — | `[CustomerOut]` | `customers` |
| `PATCH /admin/customers/{id}` | admin | `{name?, email?, address?, municipality_dane?, dv?}` | `CustomerOut` | `customers`; `400 CUSTOMER_ERASED` si el cliente ya fue anonimizado |
| `POST /admin/customers/{id}/consents` | admin | `{purpose: "invoice"\|"marketing", granted, channel, text_version}` | `201 ConsentOut` | `customers`; `400 CUSTOMER_ERASED` |
| `GET /admin/customers/{id}/requests` (+`format=csv`) | admin | — | `[DataRequestOut]` | **sin flag** (derecho legal, nunca se apaga) |
| `POST /admin/customers/{id}/erase` | admin | `{reason}` | `200 CustomerOut` (anonimizado) | **sin flag**; idempotente (llamar dos veces no cambia nada) |

#### Devoluciones pendientes (`app/refunds/router.py`)

| Ruta | Actor | Payload | Respuesta | Notas |
|---|---|---|---|---|
| `GET /admin/pending-refunds?store_id=&status=` (+`format=csv`) | admin | — | `[PendingRefundOut]` | `store_id` obligatorio (aislamiento) |
| `POST /admin/pending-refunds/{id}/settle` | admin | `{from: "shift"\|"owner", shift_id?}` | `200 PendingRefundOut` | `Idempotency-Key` obligatoria; `400 PENDING_REFUND_ALREADY_SETTLED`, `400 SHIFT_ID_REQUIRED`, `400 SHIFT_NOT_OPEN` |

#### Propinas (`app/shifts/router.py`)

| Ruta | Actor | Payload | Respuesta | Notas |
|---|---|---|---|---|
| `GET /shifts/{id}/tips` | admin o dispositivo (`current_actor`) | — | `ShiftTipsOut {by_method, by_employee, cash_out, electronic_liability}` | **No** aplica el gate de `cash.blind_close`/`_can_see_expected` (decisión declarada, §4) |
| `POST /admin/tips/payouts?store_id=` | admin | `{shift_ids, distribution: [{employee_id, amount}], paid_at, method}` | `201 TipPayoutOut` | `Idempotency-Key` obligatoria; `400 TIP_PAYOUT_EMPTY`; `404` si un turno o empleado no existe en la sede/organización; **no crea `CashMovement`** (decisión declarada, §4) |

#### Actividad ampliada (`app/shifts/router.py`, endpoint ya existente)

`GET /admin/employees/{id}/activity?from&to&store_id` (+`format=csv`) gana:

```
activity: {
  sales: {net, orders, avg_ticket},
  voids: {n, amount, pct_of_sales, after_bill, on_cash, walkouts},
  discounts: {n, amount},
  courtesies: {n, amount},
  reprints: int,
  sent_at_payment_pct: float | None,
  tips: {cash, card, transfer, other, total},
} | null
team_average: <misma forma> | null
```

`null` (no `0`) cuando `app.orders`/`app.payments`/`app.fiscal` no están instalados (protegido con `find_spec_safe`) o cuando no hay datos para promediar.

### 2.4 Códigos de error nuevos

| Código | Status | Dónde |
|---|---|---|
| `CUSTOMER_ERASED` | 400 | `PATCH /admin/customers/{id}`, `POST .../consents` sobre un cliente anonimizado |
| `PENDING_REFUND_ALREADY_SETTLED` | 400 | `POST /admin/pending-refunds/{id}/settle` repetido |
| `SHIFT_ID_REQUIRED` | 400 | `settle` con `from: "shift"` sin `shift_id` |
| `SHIFT_NOT_OPEN` | 400 | `settle` con `shift_id` de un turno que no está abierto |
| `TIP_PAYOUT_EMPTY` | 400 | `POST /admin/tips/payouts` con distribución que suma 0 |
| `FEATURE_DISABLED` | 400 | `customers` apagada (extra: `{feature: "customers"}`) — heredado del catálogo, no es un código nuevo de este territorio |

Todos con `{error: {code, message}}`, mensaje con la acción correctiva. Ninguno es `500`.

### 2.5 Tablas de `0006_customers_refunds_tips.py`

| Tabla | Filas clave | Constraints |
|---|---|---|
| `customers` | `organization_id`, `store_id?`, `doc_type`, `doc_number`, `dv?`, `name`, `email?`, `address?`, `municipality_dane?`, `erased_at?`, `erased_by_employee_id?` | `UNIQUE(organization_id, doc_type, doc_number)`; índice `(organization_id, doc_number)` |
| `customer_consents` | `customer_id`, `purpose`, `granted`, `channel`, `text_version`, `registered_by_employee_id?`, `at` | índice `(customer_id, at)` |
| `customer_data_requests` | `customer_id`, `kind` (`access`\|`rectify`\|`revoke`\|`erase`), `note?`, `response?`, `requested_at`, `responded_at?` | índice `(customer_id, requested_at)` |
| `pending_refunds` | `store_id`, `document_id` (FK `fiscal_documents.id`), `customer_id?` (FK `customers.id`), `customer_name`, `customer_doc_number`, `amount`, `method`, `authorized_by_employee_id`, `status`, `settled_*` | `CHECK(amount > 0)`; índice `(store_id, status)` |
| `tip_payouts` | `store_id`, `shift_ids` (JSON), `paid_at`, `method`, `total_amount`, `created_by_employee_id` | `CHECK(total_amount >= 0)` |
| `tip_payout_distributions` | `payout_id`, `employee_id`, `employee_name`, `amount` | `CHECK(amount >= 0)` |

Verificado columna por columna contra los modelos con `PRAGMA table_info` vs `Base.metadata.tables[...]` (script ad-hoc, mismo criterio que `tests/audit/test_migration_invariants.py`): **sin diferencias** en las seis tablas. `alembic upgrade head` corre limpio `0001 → ... → 0007` (0007 es de `backend-fiscal`, ya en el árbol); `downgrade 0005` y volver a `upgrade head` también, sin error.

## 3. Invariantes que probé

- **`erase` anonimiza el maestro y deja intacto el snapshot del documento fiscal** (`tests/customers/test_erase_fiscal_snapshot_invariant.py::test_erase_anonymizes_the_master_but_the_document_snapshot_stays_exact`): emití un documento real, até un `Customer` a él (simulando la integración que hará `pay_order` una vez tenga el campo `customer`, ver §5), lo borré, y verifiqué que `FiscalDocument.customer_doc_type`/`customer_doc_number`/`customer_name`/`total`/`subtotal`/`tax_total` no cambiaron un bit. También probé que `erase` es **idempotente** (llamarlo dos veces no pisa el primer resultado) y que, tras borrar, **un cliente nuevo puede reusar el mismo número de documento original** (la unicidad se liberó).
- **Nota sin turno abierto → devolución pendiente; `settle` desde un turno crea el egreso en ESE turno y no toca el original** (`tests/refunds/test_pending_refund_e2e.py`, el ítem literal del checklist): dos pruebas.
  1. `test_note_without_open_shift_creates_a_pending_refund_and_settle_pays_it_from_another_shift` — corre siempre, llama el gancho directo, es la prueba principal del invariante de plata.
  2. `test_the_notes_endpoint_calls_the_hook_end_to_end` — pasa por la ruta HTTP real de la nota (`app.fiscal.router`, que apareció en el árbol mientras escribía esto). Confirmé ahí mismo que `settle_or_queue_refund_for_note` llama mi gancho con `document_id=note.id` (el id de la NOTA), no el de la venta original — dato para quien lea el contrato interno.
- **Saldar «de la mano del dueño» no crea movimiento de caja** (`test_settle_from_the_owner_creates_no_cash_movement`).
- **Un cobro sin turno abierto en efectivo no se pierde silenciosamente**: `test_cash_refund_without_open_shift_queues_a_pending_refund_and_notifies` verifica también que se dispara `notify("pending_refund")` con el `payload` correcto.
- **Fuera de efectivo no crea ni movimiento ni pendiente** (`test_non_cash_method_is_settled_externally_without_creating_rows`) — decisión declarada en §4.
- **`customers` reutiliza por documento y no duplica**: `test_reuses_the_customer_by_document_and_updates_its_data` (mismo `id`, un `Customer` por doc en la organización, dos `CustomerConsent` — uno por cobro).
- **`upsert_customer_with_consent` acepta `dict` plano en `consent`** (la forma real con la que ya lo llama `app.fiscal.service`) — sin este test se me habría escapado un `AttributeError` en producción.
- **Flag `customers` apagada → `400 FEATURE_DISABLED`; encendida → funciona** (`test_disabled_feature_flag_returns_400_feature_disabled`, `test_enabled_feature_flag_allows_creation`, `test_admin_list_customers_disabled_flag_returns_feature_disabled`).
- **`erase`/`requests` funcionan aunque `customers` esté apagada** (`test_erase_works_even_with_the_feature_flag_disabled`) — es un derecho legal, no una función de producto.
- **Consecutivo de `PendingRefundStatus`**: doble `settle` → `400 PENDING_REFUND_ALREADY_SETTLED`; misma `Idempotency-Key` → misma respuesta (replay), sin doble movimiento.
- **Notificaciones nuevas declaradas exactamente una vez**, las cinco de 1b-1 no se duplicaron (`tests/notifications/test_notification_types_1b2.py`).
- **`GET /shifts/{id}/tips`**: `by_method`/`cash_out`/`electronic_liability` correctos con un cobro en efectivo y otro en tarjeta con propina; `by_employee` agrupado y sumado bien.
- **`POST /admin/tips/payouts`**: registra la distribución, rechaza empleados inexistentes (`404`, sin dejar el `TipPayout` huérfano — validé todos los empleados ANTES de escribir cualquier fila), rechaza reparto en cero (`400 TIP_PAYOUT_EMPTY`), replay idempotente.
- **`GET /admin/employees/{id}/activity` ampliado**: ventas netas + comandas + ticket promedio atribuidos a quien ABRIÓ la comanda; anulaciones de ítem con monto, `after_bill`, `on_cash` y `%` sobre sus ventas; descuentos y cortesías atribuidos a quien los aplicó/autorizó; reimpresiones; propinas por medio; `team_average` con datos de otro empleado. Y el invariante `null ≠ 0`: sin ventas, `avg_ticket`/`pct_of_sales` son `None`, no cero (`test_employee_activity_with_no_sales_has_null_metrics_not_zero_by_default`).

## 4. Decisiones declaradas

1. **`settle_or_queue_refund` acepta `order_id`/`reason` opcionales** que no estaban en la firma que me dio el Maestro, porque la integración REAL (`app.fiscal.service.settle_or_queue_refund_for_note`, código de otro agente que ya estaba en el árbol) los manda. Sin esto, la integración real habría reventado con `TypeError` en el primer cobro con nota. Ver §2.2.
2. **`upsert_customer_with_consent.consent` acepta `dict` además de `ConsentInput`**, por el mismo motivo: la llamada real (`app.fiscal.service.resolve_customer_snapshot`) manda un `dict` (`customer_in.consent.model_dump()`). Ver §2.1.
3. **Método no efectivo en `settle_or_queue_refund` → `"settled_externally"`, sin crear nada.** SPEC-NEGOCIO §6.3 sólo describe el circuito de efectivo (turno abierto / devolución pendiente); una devolución de tarjeta la resuelve el adquirente fuera de este sistema. Si el dueño de la spec quiere rastrear también esas, es una fila nueva de trabajo, no algo que se pueda inferir del texto actual.
4. **`POST /admin/tips/payouts` no crea ningún `CashMovement`.** El payload del contrato (`{shift_ids, distribution, paid_at, method}`) no trae un turno "destino" para el egreso, y `shift_ids` son los turnos CUYA propina se reparte (pueden estar cerrados). "Registra el reparto" (verbo literal de la spec) es lo que hace: si el dueño paga del cajón, ese egreso (causa `tip_payout`, ya existe en el enum desde 1b-1) se crea aparte con el endpoint genérico `POST /shifts/{shift_id}/cash-movements` sobre el turno abierto que corresponda. Inventar un `shift_id` destino no pedido por el contrato me pareció peor que dejarlo explícito.
5. **`GET /shifts/{id}/tips` NO aplica el predicado `_can_see_expected`** (el que oculta `expected_cash`/`sales`/`tips` al responsable de caja con `cash.blind_close` encendido, O-1 de 1b-1). La propina no arma el cuadre de caja (no hay drawer que "blindar" contra que el responsable la infiera para hacer trampa en el conteo): mostrarle a un mesero cuánta propina se cobró en su turno no compromete la integridad del cierre a ciegas. Si el dueño de la spec prefiere lo contrario, es un cambio de una línea (reusar `_can_see_expected` en `get_shift_tips`, ya está en el mismo archivo `router.py`).
6. **`by_employee` de `GET /shifts/{id}/tips` y `activity.tips` de `GET /admin/employees/{id}/activity` atribuyen la propina a `Payment.employee_id`** (quien COBRÓ), no a un campo de "quien atendió" — porque ese campo no existe en el modelo de pagos (`Payment` no distingue mesero de cajero). Documentado también en el docstring de `app.shifts.tips.get_shift_tips`.
7. **`activity.voids` sólo cuenta anulaciones de ÍTEM** (`OrderItem.voided_by_employee_id`), no anulaciones de comanda completa (`Order.voided_by_employee_id`). Una comanda anulada por completo nunca llegó a ser una venta, así que no encaja en "anulaciones sobre sus ventas" de la misma manera; si el dueño de la spec quiere las dos fusionadas, es una extensión menor de `app.shifts.activity_metrics.employee_sales_metrics`.
8. **`erase` es idempotente por diseño**: si el cliente ya está anonimizado (`erased_at is not None`), `erase_customer` devuelve el estado actual sin tocar nada — nunca pisa el `erased_at`/`erased_by_*` original ni intenta re-anonimizar un `doc_number` que ya es el placeholder.
9. **`Customer` es de nivel ORGANIZACIÓN, no de sede** (`store_id` es sólo la sede de origen/última que lo tocó; la unicidad y la búsqueda son por `organization_id`). Así "los clientes se reutilizan por número de documento" cruzando sedes de la misma cadena, tal como pide la spec.
10. **Consentimiento se agrega, nunca se edita**: revocar (`granted=False`) es una fila NUEVA de `CustomerConsent`, no una edición de la anterior — la bitácora completa de autorizaciones queda intacta, como exige §8.4 ("conservando la prueba").
11. **Endpoints admin de clientes y devoluciones NO llevan `Idempotency-Key`** (salvo `settle`, que sí mueve caja) — sigo el precedente ya establecido por otros endpoints `/admin/*` de este proyecto (`admin_review`, `admin_reopen`, `admin_close_administrative`, `admin_adjust_opening`, ninguno la exige): son acciones de PC, no taps de POS con wifi inestable. `PATCH` es naturalmente idempotente; `erase` ya es idempotente por diseño (punto 8); `consents` crea evidencia acumulativa a propósito (punto 10), así que un retry duplicado no es un bug, es una segunda prueba de autorización — comportamiento correcto, no algo que idempotencia deba esconder.

## 5. Verificación (comandos y resultado literal)

39 tests propios (`test_erase_fiscal_snapshot_invariant.py`: 1;
`test_hooks.py` de clientes: 5; `test_router.py` de clientes: 10;
`test_hooks.py` de refunds: 3; `test_pending_refund_e2e.py`: 2;
`test_router.py` de refunds: 7; `test_tips.py`: 5;
`test_employee_activity.py`: 3; `test_notification_types_1b2.py`: 3) más 45
tests preexistentes de `tests/shifts` (1a/1b-1) que seguían pasando después
de extender `models.py`/`schemas.py`/`service.py`/`router.py` — ninguna
regresión introducida en código compartido.

```
$ mkdir -p /tmp/pt-backend-clidin-final
$ cd backend && TMPDIR=/tmp/pt-backend-clidin-final python -m pytest \
    tests/customers tests/refunds tests/shifts tests/notifications -q \
    --deselect tests/shifts/test_sales_totals_e2e.py::test_sales_totals_flow_into_shift
84 passed, 1 deselected, 146 warnings in 248.57s (0:04:08)
```

(El `--deselect` es el test preexistente de `backend-base`, roto por una
exigencia nueva de `backend-fiscal` — no es mío, ver §5 «Gaps». Sin
deselección: 83 passed, 1 failed — ese único failed es ese test.)

```
$ cd backend && python -m mypy app
Success: no issues found in 84 source files
```

```
$ DATABASE_URL=sqlite:////tmp/pt-backend-clidin/mig.db python -m alembic upgrade head
... 0001 -> 0002 -> 0003 -> 0004 -> 0005 -> 0006 -> 0007 ...
$ DATABASE_URL=sqlite:////tmp/pt-backend-clidin/mig.db python -m alembic downgrade 0005
... 0007 -> 0006 -> 0005 ...
$ DATABASE_URL=sqlite:////tmp/pt-backend-clidin/mig.db python -m alembic upgrade head
... 0005 -> 0006 -> 0007 ...
```

Sin error en ningún sentido. Columnas de mis seis tablas verificadas una por
una contra los modelos (`PRAGMA table_info` vs `Base.metadata.tables[...]`,
script ad-hoc): sin diferencias.

No corrí la suite completa del backend (`pytest -q` sin filtro), `npm run
build` ni `tsc` (no toqué frontend): eso es del paso de verificación final
del orquestador, como manda `AGENTS.md`.

## Ronda 2 — B-1 y B-2

### B-1 (bloqueante, privacidad) — corregido

**Qué guarda ahora la auditoría de `erase`/`rectify`, literal:**

- `patch_customer` (`app/customers/service.py`): `record_audit(entity="customer", action="rectify", before=None, after={"changed_fields": [...]})`, donde `[...]` son sólo los NOMBRES de los campos que cambiaron (`"name"`, `"email"`, `"address"`, `"municipality_dane"`, `"dv"`), nunca su valor.
- `erase_customer` (`app/customers/service.py`): `record_audit(entity="customer", action="erase", before={"cleared_fields": ["name", "email", "address", "municipality_dane", "dv", "doc_number"]}, after={"name": ERASED_NAME, "doc_type": ERASED_DOC_TYPE, "doc_number": "ERASED-{id}"})`. El `after` se dejó exactamente como estaba (son placeholders del sistema, no datos del titular — el Maestro pidió explícitamente no tocarlo).
- `add_consent` (`app/customers/service.py`): sin cambios — su `after` (`{"purpose", "granted", "channel"}`) ya no llevaba PII.
- Único punto que arma estos `dict`: `app.customers.service._customer_audit_view(key, *fields) -> {key: list(fields)}`, con docstring que cita el precedente **A-7** (`app/auth/router.py::_employee_audit_view`, resuelto en 1b-1 para `document`/`email` de empleados) y §8.4.

**Por qué sigue sirviendo como traza legal**: `record_audit` no perdió ninguna llamada ni ningún campo estructural — sigue registrando `entity="customer"`, `entity_id`, `action` (`"rectify"`/`"erase"`), `actor` (de quién) y `reason` (por qué; columna propia de `AuditLog`, no del `before`/`after`). Lo que dejó de llevar es el VALOR del dato personal. La prueba de habeas data que exige §8.4 (fecha, canal, texto de la solicitud, quién la registró, qué se pidió) no vive en `before`/`after`: vive en `CustomerDataRequest` (`kind=RECTIFY`/`ERASE`, `note`, `response`, `requested_at`, `responded_at`, `employee_id`/`employee_name`), que no se tocó. `tests/audit/test_privacy_invariants.py::test_erase_does_not_leave_the_erased_data_in_the_audit_trail` (fuera de mi territorio, no lo edité) pasa: sigue habiendo filas de auditoría con `entity in ("customer", "customer_consent")` para el hecho, y ninguna contiene el nombre/correo/dirección/documento del titular.

### B-2 (mi parte) — el gate no se movió, se probó explícito

`app.customers.hooks.upsert_customer_with_consent` sigue llamando `features.assert_feature(db, organization_id, store_id, "customers")` como su primera línea (`app/customers/hooks.py:91`, sin tocar). Agregué `tests/customers/test_hooks.py::test_disabled_feature_flag_returns_400_feature_disabled` (extendí el test existente, no duplicado): con la flag apagada, cuenta filas de `Customer` y `CustomerConsent` antes y después de la llamada que levanta `400 FEATURE_DISABLED` y verifica `0` filas nuevas de cada una. El arreglo de ORDEN (mover el gate de datos de cliente antes de `claim_payment` dentro de `pay_order`) es de `backend-fiscal` (`app/payments/service.py`, no es mi territorio) — y ya está resuelto: `tests/audit/test_privacy_invariants.py::test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale` pasa en verde en esta ronda.

### Verificación de esta ronda (comandos y resultado literal)

```
$ mkdir -p /tmp/pt-backend-clidin-r2
$ cd backend && TMPDIR=/tmp/pt-backend-clidin-r2 python -m pytest tests/customers tests/refunds -q
28 passed, 52 warnings in 91.55s (0:01:31)

$ cd backend && TMPDIR=/tmp/pt-backend-clidin-r2 python -m pytest tests/audit/test_privacy_invariants.py -q
10 passed, 24 warnings in 36.80s

$ cd backend && python -m mypy app
Success: no issues found in 89 source files
```

Los diez tests de `tests/audit/test_privacy_invariants.py` (territorio del
auditor, no editado) pasan en verde, incluidos
`test_erase_does_not_leave_the_erased_data_in_the_audit_trail` (B-1, era el
rojo a propósito de esta ronda) y
`test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale`
(B-2, corregido por `backend-fiscal` en `app/payments/service.py`, fuera de
mi territorio). `28 passed` en `tests/customers`/`tests/refunds` es más que
los `25` de la ronda anterior (5+10+3+7) porque a
`test_disabled_feature_flag_returns_400_feature_disabled` se le agregaron
las dos aserciones de conteo de filas (B-2), no porque haya un test nuevo
además de ese.

No volví a correr `tests/shifts`/`tests/notifications` ni la migración
`0006` esta ronda porque no toqué ningún archivo de esos territorios ni la
migración — la lista de verificación obligatoria de esta ronda (punto 4 del
encargo) es exactamente `tests/customers tests/refunds`,
`tests/audit/test_privacy_invariants.py` y `mypy app`.

### Corrección al §6 original (bloqueante fantasma)

El punto que yo había marcado como "bloqueante para producción — `app.customers`/`app.refunds` no están en `DOMAINS`/`MODEL_MODULES`" **ya no aplica**: verifiqué en este árbol que `"customers"` y `"refunds"` YA están en `app/main.py` (`DOMAINS`, líneas 30-31) y en `app/core/models_registry.py` (`MODEL_MODULES`, líneas 26-27) — lo agregó `backend-reportes` en su propia ronda. Lo dejo tachado abajo (no lo borro del historial del documento) y retiro la instrucción al orquestador: no hace falta que nadie lo resuelva, ya está resuelto.

## 6. Gaps

~~**Bloqueante para producción — fuera de mi territorio, necesita dueño:**~~

~~- **`app.customers`/`app.refunds` no están en `app.main.DOMAINS` ni en `app.core.models_registry.MODEL_MODULES`.**~~ **CORREGIDO (ver «Ronda 2» arriba): ya están, en las dos listas.** Esto era cierto cuando escribí la primera versión de este documento (backend-reportes todavía no había tocado esos archivos) y dejó de serlo. La nota de ingeniería sobre el catch-all de `frontend/dist` y `_mount_frontend` queda sin efecto práctico por la misma razón.
- **La migración `0006` no pudo ejecutar `alembic upgrade head` sola contra una base completamente vacía en un momento previo a la existencia de `0007`** (de `backend-fiscal`) — sólo la corrí una vez que `0007` ya estaba en el árbol. `0005 → 0006 → 0007` corre limpio hoy; no verifiqué el estado intermedio `0005 → 0006` solo (no tenía sentido: `0007` ya existía cuando llegué a probar esto).
- **Pregunta abierta, NO corregida esta ronda (así lo pidió el Maestro — decisión del dueño de la spec, no mía por iniciativa propia): `erase_customer` no alcanza `pending_refunds`.** `app/refunds/models.py::PendingRefund` guarda `customer_name`/`customer_doc_number` como snapshot textual (igual que `FiscalDocument`, a propósito: una devolución pendiente tiene que poder identificar a quién pagarle aunque el maestro cambie). Si el titular pide supresión (`POST /admin/customers/{id}/erase`) mientras tiene una devolución pendiente sin saldar, ese nombre y número de documento **sobreviven intactos** en `pending_refunds` y salen tal cual por `GET /admin/pending-refunds?format=csv` (`app/refunds/router.py`, ruta de listado con export). Es la misma tensión que resuelve `erase` para `fiscal_documents` (evidencia que no se puede tocar) pero acá NO hay una obligación legal de conservación de 5 años que lo justifique — es un snapshot operativo de trabajo, no un documento fiscal. Anonimizar `pending_refunds` ya saldadas (o incluso las pendientes) es una decisión de producto/legal que no tomé por mi cuenta: queda declarada acá, con el archivo (`app/refunds/models.py`, `app/refunds/router.py`) y la ruta (`GET /admin/pending-refunds?format=csv`) exactos para quien la resuelva.

**Declarados en el pedido, no resueltos acá (fuera de mi territorio):**

- El test de punta a punta de `upsert_customer_with_consent` **desde el payload real de `POST /orders/{id}/payments`** es responsabilidad de quien lo llama (`app.fiscal.service.resolve_customer_snapshot`/`backend-fiscal`). Lo que yo probé: la función misma, con los dos parámetros extra reales que descubrí en el código (`order_id`/`reason` en el gancho de refunds; `consent` como `dict` en el de clientes) — ver §2.1, §2.2 y §4.
- `PendingRefund.customer_id` se resuelve buscando un `Customer` de la organización cuyo `(doc_type, doc_number)` coincida con el snapshot del `FiscalDocument` — si el documento es de "Consumidor final" o el cliente nunca se creó como maestro (por ejemplo, se cobró antes de que `app.payments` conectara `customer` al payload), queda `NULL`. `customer_name`/`customer_doc_number` SIEMPRE quedan con el snapshot textual, nunca `NULL`.
- No verifiqué Postgres real (`SELECT FOR UPDATE`, tipos, índices parciales) ni el CI — mismo alcance que dejó 1b-1, no hay runner ni Postgres en este entorno.
- **`app.orders.money.prorate`** (A-12 del auditor de 1b-1) y la **leyenda legal del servidor** (A-11) y el **"Total a cobrar" calculado en el backend** (A-10) NO son mi territorio (`app/orders`, `app/payments`, frontend) — no los toqué. Quedan para quien los tenga asignados.
- **Los gaps de 1b-1 que mi mission listó pero no pedía resolver** (`PinPad` sin filtrar por foco, medios de pago fijos del POS, `document-print.css` sin config de sede, rondas históricas tras unir comandas): no entran en mi alcance (clientes/devoluciones/propinas/turnos y personal); quedan declarados, no resueltos, tal como estaban.
- **`FiscalCounter`/`FiscalRange` y todo lo de rangos DIAN**: territorio de `backend-fiscal`. Mis tests de clientes/refunds necesitaron sortear el requisito de `FiscalRange` vigente (`app.fiscal.service.reserve_next_number`, `400 NO_FISCAL_RANGE`) apagando `fiscal.dee_pos` en casi todos los casos (el documento sale como `internal_receipt`, con `FiscalCounter` clásico) — EXCEPTO en `tests/refunds/test_pending_refund_e2e.py::test_the_notes_endpoint_calls_the_hook_end_to_end`, donde sí armé un `FiscalRange` real vía `POST /admin/fiscal/ranges` porque una nota `adjustment` exige que el documento original sea `pos_equivalent`.
- **Regresión encontrada, no mía**: mientras corría mi batería completa, descubrí que `tests/shifts/test_sales_totals_e2e.py::test_sales_totals_flow_into_shift` (escrito por `backend-base` en 1b-1) ahora falla con `400 NO_FISCAL_RANGE` — no por nada que yo haya tocado, sino porque `backend-fiscal` agregó la exigencia de un `FiscalRange` vigente para emitir `pos_equivalent`, y ese test paga con `fiscal.dee_pos` encendida (default) sin cargar un rango. No es un archivo mío (no está en mi lista de test) y arreglarlo bien requiere una decisión de diseño (¿el test debería apagar la flag como hice yo, o `backend-fiscal` debería dejar un rango en el seed/fixture de seguridad para no romper toda la suite de 1a/1b-1?) que no me corresponde tomar. Lo señalo para que no se pierda cuando corra la verificación final en serie.
- **`sent_at_payment_pct`**: para canal `counter` sin estación de cocina, `Order.kitchen_view_enabled` puede quedar `False`, y entonces el campo es `None` (sin datos que promediar) — no until until probé el caso con `kitchen.view` encendido y un producto con estación (fuera del foco de mi entrega, que es plata y clientes, no cocina); el cálculo en sí (`app.shifts.activity_metrics`) está escrito y es correcto por inspección, pero su caso "con cocina" no tiene un test dedicado en mi batería.
