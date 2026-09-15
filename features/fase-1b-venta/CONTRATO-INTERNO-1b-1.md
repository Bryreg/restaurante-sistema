# Contrato interno del pedido 1b-1 (Maestro → equipo)

Acuerdo de construcción entre los seis agentes del pedido **1b-1: comanda y cobro**
(primera mitad del pedido 1b). Lo escribió el Maestro para que tres builders de
backend, dos de frontend y un auditor trabajen **en paralelo sobre un repo que ya
tiene el pedido 1a entregado** (commit base `098d3a0`) sin pisarse. Manda sobre las
preferencias de cada agente; no manda sobre `docs/SPEC-NEGOCIO.md`, `AGENTS.md`,
`docs/ESTADO.md` ni `features/fase-1b-venta/spec.md` (si algo de acá los contradice,
mandan ellos y se reporta el gap en el output).

Hereda de `features/fase-1a-cimientos/CONTRATO-INTERNO.md` todo lo que no se repite
acá (módulos compartidos de `app/core`, `Actor`, `run_idempotent`, `require_feature`,
`record_audit`, `notify`, fixtures base, cliente HTTP del frontend). **Leelo primero.**

Lo que este contrato corrige respecto del de 1a (lección de la entrega 1a §1):

1. **Cada hook cruzado entre territorios lleva el nombre de quién escribe su test de
   punta a punta** (§2.5). Un hook con dueño en cada extremo pero sin dueño del test
   E2E es exactamente lo que dejó D-1 sin detectar.
2. **La fixture `race_app` de `backend/tests/conftest.py` (y su forma extendida
   `race_env`, §3) es la ÚNICA para todo test de concurrencia con hilos.** La fixture
   `db` compartida entrega una sola `Session` a todos los requests y no es segura
   entre hilos (D-2).

Todo lo de código (nombres, firmas, rutas) va en inglés; las explicaciones en español.

---

## 0. Territorios

| Agente | Escribe SOLO en | No toca |
|---|---|---|
| `backend-base` | `backend/app/main.py`, `backend/app/core/**`, `backend/app/auth/**`, `backend/app/stores/**`, `backend/app/audit/**`, `backend/app/notifications/**`, `backend/app/shifts/**` (incluido `hooks.py`), `backend/app/seed.py`, `backend/tests/conftest.py`, `backend/tests/{core,auth,stores,audit_log,notifications,shifts}/**`, `docs/ESTADO.md`, `.claude/launch.json`, `.github/workflows/ci.yml`, sección «Verificación mínima» de `AGENTS.md` | `app/orders`, `app/payments`, `app/fiscal`, `app/kitchen`, `app/catalog`, `tests/orders`, `tests/payments`, `tests/fiscal`, `tests/kitchen`, `tests/catalog`, `tests/audit`, `frontend/`, migraciones `0004`/`0005` |
| `backend-comanda` | `backend/app/orders/**`, `backend/app/kitchen/**`, `backend/alembic/versions/0004_orders.py`, `backend/tests/orders/**`, `backend/tests/kitchen/**` | todo lo demás |
| `backend-cobro` | `backend/app/payments/**`, `backend/app/fiscal/**`, `backend/alembic/versions/0005_payments_fiscal.py`, `backend/tests/payments/**`, `backend/tests/fiscal/**` | todo lo demás |
| `frontend-comanda` | `frontend/src/features/orders/**` (incluye `index.ts`, pantallas Mesas, Comanda, Cocina y Admin → Pedidos), `frontend/src/api/orders.ts`, `frontend/src/api/kitchen.ts` | todo lo demás |
| `frontend-cobro` | `frontend/src/features/payments/**`, `frontend/src/api/payments.ts`, `frontend/src/api/documents.ts`, `frontend/src/api/employees.ts`, `frontend/src/components/EmployeePicker.tsx` (+ test en `frontend/src/components/__tests__/`), `frontend/src/features/auth/DeviceIdentifyPage.tsx` (+ test), `frontend/src/features/shifts/{index.ts,OpenShiftForm.tsx,RosterPanel.tsx,HandoverPanel.tsx}` y `frontend/src/features/shifts/__tests__/OpenShiftForm.test.tsx`, `frontend/src/app/{router.tsx,PosLayout.tsx,PosHome.tsx,AdminLayout.tsx}` (+ tests en `src/app/__tests__/`), `frontend/src/features/features/**` | todo lo demás (en especial `src/features/orders/**` salvo el stub de §7.1) |
| `auditor-venta` | `backend/tests/audit/**`, `frontend/src/audit/**` | todo lo demás (no arregla código ajeno: reporta) |

Archivos compartidos con **dueño único**: `docs/ESTADO.md` y `.claude/launch.json`
(solo `backend-base`, al final); `backend/tests/conftest.py` (solo `backend-base`,
al principio); `frontend/src/app/router.tsx` (solo `frontend-cobro`). Nadie toca
`app/catalog/**` ni `tests/catalog/**`: lo que la comanda necesita de la carta se
**lee** de `app.catalog.models` y se **llama** en `app.catalog.service`
(`set_product_availability`, `combo_active_now`, `assert_combo_sellable`); si falta
algo, se declara en `gaps`. Cada agente escribe su entregable completo en el archivo
de salida que le indica el orquestador (`<outputs>/<id>.md`).

## 1. Orden de arranque, instalaciones y reglas de espera

- **Nadie instala nada.** No hay dependencia nueva en este pedido: la matemática se
  hace con enteros y `random.Random(seed)` para el test de propiedad (sin
  `hypothesis`); la impresión del comprobante es `window.print()` + CSS `@media print`
  (sin librería). Si creés que necesitás una dependencia, no la instales: declarala
  en `gaps` y seguí.
- `backend-base` escribe **primero y en este orden**: `tests/conftest.py` (fixtures
  §3) → `app/main.py` (`DOMAINS`) y `app/core/models_registry.py` (`MODEL_MODULES`)
  → `app/auth/service.py` (`SUPERVISOR_ACTIONS`) y `app/notifications/service.py`
  (`NOTIFICATION_TYPES`) → `GET /device/employees` → el resto de su misión. Es lo
  que destraba a `backend-comanda`, `backend-cobro` y `auditor-venta`.
- `frontend-cobro` escribe primero: `src/api/employees.ts` (`listDeviceEmployees`)
  → `src/components/EmployeePicker.tsx` → **stub** de `src/features/orders/index.ts`
  (solo si no existe, §7.1) → `src/features/payments/index.ts` → `src/app/router.tsx`,
  `PosHome.tsx`, `PosLayout.tsx`.
- Los demás **empiezan escribiendo código sin correr nada**. Antes de ejecutar
  tests comprobá con `ls`/`grep` que existe lo compartido que importás (p. ej.
  `grep -n race_env backend/tests/conftest.py`, `grep -n '"orders"' backend/app/main.py`).
  Si no existe, seguí con tu código y volvé a comprobar más tarde. **Nunca crees vos
  un archivo del territorio de otro.** Si al terminar sigue faltando, corré tus
  tests con `timeout 900` y lo que falle solo por módulos ausentes lo declarás en
  `gaps` (hay ronda 2).
- Tests: cada agente usa su propio `TMPDIR=/tmp/pt-<id>` (creado con `mkdir -p`) y
  corre **solo** sus archivos: `cd backend && TMPDIR=/tmp/pt-<id> python -m pytest tests/<dominio> -q -x`;
  `cd frontend && npx vitest run src/features/<dominio>`. Typecheck completo sí
  (`cd backend && python -m mypy app`, `cd frontend && npm run typecheck`), tolerando
  errores en archivos ajenos a medio escribir (reportalos, no los arregles). Nunca la
  suite completa; nunca `npm run build`; nunca `alembic upgrade head` sobre `dev.db`
  del repo (usá `DATABASE_URL=sqlite:////tmp/pt-<id>/mig.db`).
- Entorno: SQLite en dev y tests; Postgres solo en CI (no hay Postgres local). Todo
  DDL se escribe Postgres-first pero tiene que correr en SQLite (`render_as_batch`,
  índices parciales con `postgresql_where` **y** `sqlite_where`).

## 2. Backend

### 2.1 Convenciones que ya son ley (recordatorio de 1a + `docs/ESTADO.md`)

- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`; `clock.now_utc()` siempre;
  fecha de negocio como `Date` calculada con `app.core.tz` (nunca derivada de UTC).
- Dinero en `Integer` (pesos). Tasas de impuesto como **entero por ciento**
  (`8`, `19`, `0`). Enums `sa.Enum(..., native_enum=False, length=32)`, comparar por
  valor. Todo modelo con `organization_id` y `store_id` indexados; toda consulta
  filtra por ambos y responde `404 NOT_FOUND` ante un id ajeno.
- `get_db` **commitea** también ante `AppError`: **validar antes de escribir**.
- `run_idempotent(db, organization_id=, scope=, key=, request_hash=, fn=)` reserva la
  clave en la transacción; `fn` devuelve `(status, body_json)` con `body`
  serializable (`model_dump(mode="json")`). Scopes de este pedido:
  `orders.items`, `orders.send`, `orders.ready`, `orders.served`,
  `orders.bill_present`, `orders.payments`. `request_hash =
  hash_request_body({"order_id": id, ..., **body})` (el path entra al hash).
- Errores: `AppError(code, message, status, extra)`; `message` nombra la acción
  correctiva. Reglas de negocio en `400`; concurrencia en `409`; nunca `500`.
- Gates de función: `Depends(features.require_feature("clave"))` cuando la clave es
  fija por ruta; `features.assert_feature(db, org, store, "clave")` en el servicio
  cuando depende del body (p. ej. el canal en `POST /orders`).
- Atribución: `employee_id` FK real + `employee_name` congelado; `authorized_by_*`
  cuando otra persona autorizó (`auth_service.verify_authorizer`).
- El operador **no recibe costos**: ningún esquema de respuesta de dispositivo tiene
  `cost`, `margin`, `unit_cost` (la columna `unit_cost` existe en `order_items` y
  queda en `NULL`; **no se serializa** hacia el dispositivo).

### 2.2 Modelos (los escribe cada dueño; los demás los importan)

`backend-comanda` — `app/orders/models.py` (+ `0004_orders.py`):

```
class OrderChannel(str, Enum): COUNTER="counter" DINE_IN="dine_in" TAKEOUT="takeout" DELIVERY="delivery" PLATFORM="platform" STAFF_MEAL="staff_meal"
class OrderStatus(str, Enum): OPEN="open" TO_PAY="to_pay" PAID="paid" MERGED="merged" VOIDED="voided"
class OrderItemStatus(str, Enum): PENDING="pending" SENT="sent" READY="ready" SERVED="served" VOIDED="voided"
class VoidReason(str, Enum): customer_changed_mind server_error kitchen_error long_wait walkout duplicate other
class CourtesyReason(str, Enum): complaint promo_owner guest_of_owner other
class DiscountReason(str, Enum): promo complaint owner employee other

Order            orders(id, organization_id, store_id, shift_id FK shifts NULL (NULL = trasladada, esperando turno),
                 business_date Date, channel, status, version int=1,
                 covers int|NULL, note Text|NULL,
                 takeout_customer_name|NULL, takeout_phone|NULL, promised_at UTCDateTime|NULL,
                 consumed_by_employee_id FK|NULL, consumed_by_employee_name|NULL,          # staff_meal
                 opened_by_employee_id FK, opened_by_employee_name, opened_at,
                 bill_presented_at|NULL, bill_print_count int=0,
                 paid_at|NULL, closed_at|NULL, paid_by_employee_id|NULL, paid_by_employee_name|NULL,
                 voided_at|NULL, void_reason|NULL, void_note|NULL, voided_by_*|NULL, void_authorized_by_*|NULL, void_after_bill bool=False,
                 merged_into_order_id FK orders|NULL, merged_at|NULL,
                 transferred_from_shift_id FK shifts|NULL, transferred_to_shift_id FK shifts|NULL,
                 kitchen_view_enabled bool (snapshot de `kitchen.view` al crear; el ratio de sent_at_payment solo cuenta comandas con True),
                 split_parts int|NULL (división en partes iguales, informativo),
                 created_at, updated_at)
                 índices: (store_id, status), (shift_id), (store_id, business_date)
OrderTable       order_tables(id, order_id FK, table_id FK tables, store_id, seated_at, released_at|NULL)
                 índice único parcial uq_order_tables_one_open_per_table sobre (table_id) WHERE released_at IS NULL
                 (postgresql_where + sqlite_where) → «una comanda abierta por mesa»
OrderRound       order_rounds(id, order_id, round_no int, sent_at, sent_by_employee_id, sent_by_employee_name, sent_at_payment bool=False)
                 UNIQUE(order_id, round_no)
OrderItem        order_items(id, organization_id, store_id, order_id FK, product_id FK products|NULL, combo_id FK combos|NULL,
                 name String(200) (snapshot), qty int>0, seat int|NULL, course String(50), station String(50)|NULL,
                 list_price int (precio de carta del canal, snapshot), unit_price int (0 en staff_meal/cortesía),
                 tax_code String(16), tax_rate int (8|19|0), price_includes_tax bool,
                 modifiers JSON [{option_id, group_name, name, price_delta}], modifiers_text String(500)|NULL,
                 combo_selections JSON [{group_id, group_name, option_id, product_id, product_name}]|NULL,
                 note Text|NULL, status, round_id FK|NULL, round_no int|NULL,
                 sent_at|NULL, ready_at|NULL, served_at|NULL, sent_at_payment bool=False,
                 discount_amount int=0 (Σ descuentos de línea),
                 courtesy_reason|NULL, courtesy_note|NULL, courtesy_authorized_by_employee_id|NULL, courtesy_authorized_by_employee_name|NULL, courtesy_at|NULL, courtesy_after_bill bool=False,
                 void_reason|NULL, void_note|NULL, voided_at|NULL, voided_by_*|NULL, void_authorized_by_*|NULL, void_after_bill bool=False, void_minutes_since_sent int|NULL,
                 unit_cost int|NULL (siempre NULL en 1b), recipe_version int|NULL (siempre NULL en 1b),
                 added_by_employee_id, added_by_employee_name, created_at)
                 índices: (order_id), (order_id, status), (product_id)
OrderDiscount    order_discounts(id, organization_id, store_id, order_id, item_id FK order_items|NULL, scope "order"|"item", kind "percent"|"amount",
                 value int (por ciento o pesos), amount int (pesos efectivamente descontados), reason, note|NULL,
                 employee_id, employee_name, authorized_by_*|NULL, after_bill bool, at, voided_at|NULL)
OrderSubAccount  order_sub_accounts(id, order_id, seq int, label String(100), seat int|NULL, status "open"|"paid", paid_at|NULL, document_id int|NULL (sin FK: lo llena payments), created_at)
OrderSubAccountItem order_sub_account_items(id, sub_account_id FK, order_item_id FK, portions int, of_portions int)   # 1/1 = ítem entero; 1/3 = compartido
OrderEvent       order_events(id, organization_id, store_id, order_id, kind String(32)
                 ("opened","tables_moved","merged_out","merged_in","bill_presented","transferred_out","transferred_in","voided","split"),
                 payload JSON, employee_id|NULL, employee_name|NULL, authorized_by_employee_id|NULL, authorized_by_employee_name|NULL, after_bill bool=False, at)
WasteStub        waste_stubs(id, organization_id, store_id, order_id, order_item_id, product_id|NULL, product_name, qty int, reason (VoidReason), note|NULL,
                 employee_id, employee_name, authorized_by_*|NULL, at, ingredient_id int|NULL (NULL: se resuelve en fase 2), resolved bool=False)
```

`backend-cobro` — `app/payments/models.py` y `app/fiscal/models.py` (+ `0005_payments_fiscal.py`):

```
class PaymentMethod: cash card transfer platform voucher other   (String(16); se valida contra StoreSalesSettings.payment_methods[].code con enabled=True)
Payment          payments(id, organization_id, store_id, shift_id FK shifts, order_id FK orders, sub_account_id FK order_sub_accounts|NULL,
                 document_id FK fiscal_documents|NULL, method, amount int (parte de la VENTA que cubre este pago, sin propina),
                 tip_amount int=0 (propina que viaja en este pago), tendered int|NULL, change int=0 (solo cash), reference String(120)|NULL,
                 employee_id, employee_name, business_date Date, at, voided_at|NULL)
                 índices: (shift_id), (order_id), (shift_id, method)
OrderTip         order_tips(id, order_id, sub_account_id|NULL, asked bool, accepted bool, modified bool, amount int, suggested_pct Numeric(5,2), suggested_amount int, base int, at)
class FiscalDocumentType: pos_equivalent invoice adjustment_note credit_note debit_note internal_receipt
class DianStatus: pending sent validated rejected contingency
FiscalCounter    fiscal_counters(id, store_id FK, document_type, prefix String(10), next_number int=1)  UNIQUE(store_id, document_type, prefix)
FiscalDocument   fiscal_documents(id, organization_id, store_id, order_id FK orders, sub_account_id FK order_sub_accounts|NULL, shift_id FK shifts,
                 target_key String(40) UNIQUE ("order:{order_id}" o "sub:{sub_account_id}") → «un documento por comanda o sub-cuenta»,
                 document_type, prefix, number int, UNIQUE(store_id, document_type, prefix, number) → «consecutivo único sin reutilización»,
                 dian_status (pending en 1b-1; internal_receipt lleva NULL), legend String(200),
                 business_date Date, issued_at,
                 customer_doc_type String(4)="13", customer_doc_number String(20)="222222222222", customer_name String(200)="Consumidor final",
                 store_snapshot JSON {legal_name, nit, dv, address, municipality_dane, regime, person_type},
                 lines JSON [{item_id, qty, description, unit_price, gross, discount, net, tax_rate, base, tax, courtesy}],
                 subtotal, discount_total, tax_total, total int, tax_lines JSON [{rate, base, tax}],
                 tip_amount int=0, tip_suggested_pct Numeric|NULL, tip_accepted bool|NULL, tip_modified bool|NULL,
                 payments_snapshot JSON [{method, label, dian_code, amount, tip_amount, tendered, change, reference}],
                 channel, tables_text String(100)|NULL, covers|NULL, served_by_name, charged_by_employee_id, charged_by_employee_name,
                 fiscal_range_id int|NULL, cude String(96)|NULL, qr_url|NULL, xml_ref|NULL, provider_response JSON|NULL, validated_at|NULL,   # todo NULL en 1b-1
                 status "issued"|"reversed" = "issued", print_count int=1, reprint_count int=0, created_at)
DocumentReprint  document_reprints(id, document_id FK, employee_id, employee_name, at)
```

Nombres de tabla y columnas son vinculantes: el auditor y el frontend los leen tal
cual; el test de migraciones del auditor compara DDL contra modelos.

### 2.3 Firmas públicas que cruzan territorios

`app/orders/money.py` (backend-comanda) — **la única matemática de la venta**:

```
def round_half_up(numerator: int, denominator: int) -> int          # entero, half-up, sin float
def prorate(amount: int, weights: list[int]) -> list[int]           # Σ = amount; residuo en el peso mayor (primer máximo); pesos 0 reciben 0
@dataclass(frozen=True) class LineInput:  item_id: int; gross: int; tax_rate: int; item_discount: int; is_combo: bool; price_includes_tax: bool
@dataclass(frozen=True) class LineTotals: item_id: int; gross: int; discount: int; net: int; base: int; tax: int; tax_rate: int
@dataclass(frozen=True) class TaxLine:    rate: int; base: int; tax: int
@dataclass(frozen=True) class OrderTotals: subtotal: int; discount_total: int; total: int; tax_total: int; tip_base: int; tax_lines: list[TaxLine]; lines: list[LineTotals]
def compute_totals(lines: list[LineInput], order_discounts: list[tuple[str, int]]) -> OrderTotals
    # gross = unit_price*qty (+ deltas de modificadores*qty); cortesía y anulado → gross 0 (no entran).
    # item_discount nunca supera gross. Cada descuento de comanda (kind, value) se calcula sobre
    # (Σ gross − Σ item_discount − descuentos de comanda previos): percent → round_half_up(base*value, 100), amount → value; tope = esa base.
    # El total de descuentos de comanda se prorratea con prorate() por (gross − item_discount).
    # net = gross − discount. Si price_includes_tax: base = round_half_up(net*100, 100+rate), tax = net − base;
    # si no: base = net, tax = round_half_up(base*rate, 100), y total de la línea = base + tax (net pasa a ser base+tax).
    # tax_lines agrupa por rate (base y tax sumados). subtotal = Σ gross; discount_total = Σ discount; total = Σ net; tax_total = Σ tax; tip_base = total − tax_total.
    # INVARIANTE (test del auditor sobre 1.000 comandas aleatorias): Σ lines.net == total; Σ prorateo == descuento; Σ tax_lines.tax == tax_total.
```

`app/orders/service.py` (backend-comanda) — lo que `backend-cobro` y `backend-base` llaman:

```
def get_order_or_404(db, *, actor: Actor, order_id: int) -> Order            # 404 si otra org/sede (device: su sede; admin: su org)
def compute_order_totals(db, order: Order) -> OrderTotals                     # lee ítems y descuentos vivos
def compute_sub_account_totals(db, sub_account: OrderSubAccount) -> OrderTotals   # porciones: gross de la porción = prorate(net de línea, of_portions)[k]; Σ sub-cuentas == total de la comanda
def order_out(db, order: Order, *, for_device: bool) -> OrderOut             # el esquema de §2.4; for_device=True nunca serializa unit_cost
def assert_payable(db, order: Order, *, sub_account: OrderSubAccount | None) -> None
    # 400 ORDER_NOT_OPEN si status ∉ {open,to_pay}; 400 ORDER_EMPTY sin ítems vivos; 400 SUB_ACCOUNT_REQUIRED si hay sub-cuentas y no se indicó una;
    # 400 SUB_ACCOUNT_ALREADY_PAID; 400 NO_OPEN_SHIFT si la comanda no está en un turno abierto de la sede.
def claim_payment(db, order: Order, *, sub_account: OrderSubAccount | None, actor: Actor, now: datetime) -> bool
    # UPDATE condicional atómico (portable): orders SET status='paid', paid_at, closed_at, paid_by_*, version=version+1 WHERE id=? AND status IN ('open','to_pay') AND paid_at IS NULL;
    # rowcount 0 → raise ConflictError code ORDER_ALREADY_PAID ("Esta comanda ya fue cobrada; consultá el comprobante").
    # Con sub-cuenta: UPDATE order_sub_accounts SET status='paid', paid_at WHERE id=? AND status='open'; rowcount 0 → 409 SUB_ACCOUNT_ALREADY_PAID;
    # devuelve True si con eso la comanda quedó totalmente pagada (entonces también marca la comanda) — libera mesas (released_at) al quedar paid.
def auto_send_pending_for_payment(db, order: Order, *, actor: Actor, now: datetime) -> int
    # pending → sent (o served si sin estación; y SIEMPRE served si order.kitchen_view_enabled es False), sent_at_payment=True en ítems y en la ronda; descuenta daily_remaining; devuelve cuántos.
def business_date_for_sale(db, shift: Shift, store: Store, now: datetime) -> date
    # shift.business_day.business_date; si service.is_shift_stale(shift) → tz.today_business_date(store.cutoff_hour) (SPEC §3.1)
```

`app/orders/hooks.py` (backend-comanda; **no importa `app.orders.service`** para evitar ciclos; solo modelos):

```
def count_open_orders(db, *, shift_id: int) -> int                                   # status in (open, to_pay)
def detach_open_orders(db, *, shift_id: int, actor: Actor) -> list[int]              # shift_id=NULL, transferred_from_shift_id=shift_id, OrderEvent transferred_out; devuelve ids
def adopt_transferred_orders(db, *, store_id: int, shift: Shift, actor: Actor) -> list[int]   # órdenes de la sede con shift_id NULL y status open/to_pay → shift_id=shift.id, transferred_to_shift_id, OrderEvent transferred_in
```

`app/payments/service.py` (backend-cobro):

```
def pay_order(db, *, actor: Actor, store: Store, shift: Shift, order: Order, payload: PaymentIn, now: datetime) -> PaymentOut
def get_document_or_404(db, *, actor: Actor, document_id: int) -> FiscalDocument
def document_printable(db, document: FiscalDocument) -> DocumentPrintableOut
```

`app/fiscal/service.py` (backend-cobro):

```
def reserve_next_number(db, *, store_id: int, document_type: str, prefix: str) -> int
    # SELECT ... FOR UPDATE (with_for_update(); SQLite lo ignora y serializa por lock de escritura) sobre fiscal_counters; crea la fila con next_number=1 si no existe;
    # devuelve n y deja next_number=n+1. Se llama DENTRO de la transacción del cobro: si el cobro falla, el rollback devuelve el número (sin huecos).
def issue_document(db, *, order, sub_account, shift, store, actor, totals: OrderTotals, tip: ..., payments_snapshot, business_date, now) -> FiscalDocument
    # document_type = "pos_equivalent" si features.is_enabled(...,"fiscal.dee_pos") else "internal_receipt"; prefix "POS" (fijo hasta que 1b-2 traiga rangos);
    # dian_status "pending" (pos_equivalent) o NULL (internal_receipt); legend "DOCUMENTO PENDIENTE DE TRANSMISIÓN A LA DIAN" / "COMPROBANTE INTERNO — no es factura ni documento equivalente".
    # NADA se emite ni transmite en 1b-1: no hay FiscalProvider, ni CUDE, ni QR, ni rangos.
```

`app/shifts/hooks.py` (backend-base):

```
@dataclass(frozen=True) class SalesTotals: cash=0 card=0 transfer=0 other=0 tips_cash=0 tips_card=0 tips_transfer=0 tips_other=0
def get_sales_totals(db, shift_id: int) -> SalesTotals
    # Lee app.payments.models.Payment (find_spec-guarded; sin el módulo devuelve ceros) del turno con voided_at IS NULL:
    # method cash → cash (amount) y tips_cash (tip_amount); card → card/tips_card; transfer → transfer/tips_transfer; platform|voucher|other → other/tips_other (no entran al cajón).
    # compute_breakdown NO cambia: sigue leyendo .cash.
```

`app/auth/service.py` (backend-base): `SUPERVISOR_ACTIONS = {"void_sent_item", "courtesy", "discount_over_limit", "void_order", "after_bill_change"}`
(el admin sigue autorizando todo). `verify_authorizer(db, organization_id=, store_id=, pin=, action=, requested_by=, reference=)` sin cambios de firma.

`app/notifications/service.py` (backend-base): `NOTIFICATION_TYPES += ["discount_rate_high", "courtesy_limit", "void_rate_high", "order_unsent_too_long", "order_unpaid_too_long"]`
(en 1b-1 solo emiten `discount_rate_high` y `courtesy_limit`, desde `backend-comanda`; los otros tres quedan declarados para 1b-2).

`app/main.py`: `DOMAINS = ["auth","stores","catalog","shifts","orders","payments","fiscal","kitchen","audit","notifications"]`;
`app/core/models_registry.py`: `MODEL_MODULES += ["orders","payments","fiscal"]` (`kitchen` no tiene modelos).

### 2.4 Contrato de API de 1b-1 (todo bajo `/api/v1`; delimita `spec.md` a esta mitad)

Lectura de comanda/mesas/cocina/documento: `current_device` (persona opcional).
Escritura: `current_operator` (persona vigente). Admin: `current_admin` + `store_id`.

**Personal del dispositivo** (`backend-base`)
- `GET /device/employees` (device) → `[{id, name, role}]` activos de la organización cuyo `store_id` es la sede del dispositivo **o NULL** (admins de toda la organización), orden por `name`. **Nunca** `document`, `email`, `discount_limit_pct`, `can_charge`, hashes.

**Mesas** (`backend-comanda`, `pos.tables`)
- `GET /tables/status` → `{zones: [{id, name, tables: [{id, number, seats, status: "free"|"occupied"|"to_pay", order_id?, opened_at?, covers?, total?}]}]}` (mesas y zonas activas de la sede; `total` = `compute_order_totals(...).total` — lo calcula el servidor).

**Comandas** (`backend-comanda`)
- `POST /orders` (operator) `{channel, table_ids?: [int], covers?, takeout?: {customer_name, phone?, promised_at?}, consumed_by_employee_id?, note?}` → `201 OrderOut`.
  Orden de validación: flag del canal (`pos.counter`|`pos.tables`|`pos.takeout`|`pos.staff_meal` → `400 FEATURE_DISABLED {feature}`) → canal ∈ `store.active_channels` (solo counter/dine_in/takeout → `400 CHANNEL_DISABLED`) → turno abierto (`400 NO_OPEN_SHIFT` «Abrí un turno para poder vender») → `dine_in` exige `table_ids` no vacío (`400 TABLE_REQUIRED`) y mesas activas de la sede (`404`) → `409 TABLE_ALREADY_OPEN {table_id}` si alguna tiene comanda abierta (chequeo previo + índice parcial como respaldo: `IntegrityError` → 409) → `staff_meal` exige `consumed_by_employee_id` activo de la sede (`400 STAFF_MEAL_CONSUMER_REQUIRED`). `covers` default = Σ `seats` de las mesas. `business_date = business_date_for_sale(...)`. `kitchen_view_enabled` snapshot. `OrderEvent opened`. `record_audit`.
- `GET /orders?status=open|to_pay|paid&channel=` (device) → `[OrderOut]` de la sede (los `paid` solo del turno abierto actual); orphans (`shift_id NULL`) incluidos cuando `open|to_pay`.
- `GET /orders/favorites` (device) → `[{product_id, qty}]` top 12 por cantidad vendida (ítems no anulados de comandas `paid`) en los últimos 7 días operativos de la sede; `[]` sin historia.
- `GET /orders/{id}` (device) → `OrderOut`.
- `POST /orders/{id}/items` (operator, `Idempotency-Key`, scope `orders.items`) `{expected_version, items: [{product_id? | combo_id?, qty, seat?, course?, modifiers?: [{option_id}], combo_selections?: [{group_id, option_id}], note?}], authorizer_pin?}` → `OrderOut`.
  Reglas: `status` open/to_pay (`400 ORDER_NOT_OPEN`); `bill_presented_at` no nulo → exige `authorizer_pin` (acción `after_bill_change`) o `400 BILL_PRESENTED_NEEDS_AUTH`; producto activo, `available`, y si `pos.daily_count` y `daily_remaining` no nulo: `qty <= daily_remaining` (`400 PRODUCT_UNAVAILABLE {product_id, remaining}`); modificadores: `pos.modifiers` encendido (si no, y vienen → `FEATURE_DISABLED`), opciones del producto, `available` (`400 OPTION_UNAVAILABLE`), `min/max/required` por grupo (`400 MODIFIER_SELECTION_INVALID`); combo: `pos.combos`, `combo.active`, `assert_combo_sellable`, `combo_active_now(schedule, now)` (`400 COMBO_NOT_ACTIVE`), exactamente una opción `active_today && available_today` por grupo (`400 COMBO_SELECTION_INVALID`); `seat` solo con `pos.seats` (si no → `FEATURE_DISABLED`), `course` solo con `pos.courses`.
  Snapshot: `name`; `list_price` = precio del canal (`counter`→`dine_in`, `dine_in`→`dine_in`, `takeout`→`takeout` resuelto (cae a dine_in), `staff_meal`→`dine_in`); `unit_price` = `list_price` + Σ `price_delta` (0 en `staff_meal`); `tax_code` = producto (combo: `default_tax` de la fiscal vigente); `tax_rate` 8/19/0 (0 en `staff_meal`); `price_includes_tax` de la fiscal vigente; `course` = body, si no `product.default_course`, si no `"main"`; `station` = `product.station` normalizado (`None`, `""`, `"none"` → `None`; combo: la primera estación no nula de sus productos elegidos); `modifiers_text` = nombres unidos por `", "`; `unit_cost`/`recipe_version` `NULL`. Ítems nuevos `pending`. `version += 1`.
- `PATCH /orders/{id}/items/{item_id}` (operator) `{expected_version, qty?, note?, seat?}` — solo `pending` (`400 ITEM_NOT_PENDING`).
- `POST /orders/{id}/send` (operator, `Idempotency-Key`, `kitchen.view`) `{expected_version}` → `OrderOut`. Sin pendientes → `400 NOTHING_TO_SEND`. Crea `OrderRound(round_no = max+1)`; pendientes → `sent` (`station` no nula) o `served` (sin estación; `sent_at`=`served_at`=now); descuenta `daily_remaining` por producto (solo con `pos.daily_count`; al llegar a 0 llama `catalog.service.set_product_availability(db, product, available=False, daily_count=None, actor=actor)`).
- `POST /orders/{id}/items/{item_id}/ready` (device, `Idempotency-Key`, `kitchen.view`) — `sent → ready` (idempotente: ya `ready`/`served` devuelve 200 sin cambio). `POST .../served` (operator, `Idempotency-Key`) — `sent|ready → served`.
- `POST /orders/{id}/items/{item_id}/void` (operator) `{expected_version, reason, note?, authorizer_pin?}` → `OrderOut`. `pending`: libre. `sent|ready|served`: `verify_authorizer(action="void_sent_item")` (sin PIN → `400 AUTHORIZATION_REQUIRED`); guarda `void_minutes_since_sent`, crea `WasteStub` (nunca repone `daily_remaining` ni `available`). Si `bill_presented_at` → `void_after_bill=True` **y** exige autorizador aunque esté `pending`. `reason="other"` exige `note`.
- `POST /orders/{id}/items/{item_id}/courtesy` (operator, `pos.courtesies`) `{expected_version, reason, note?, authorizer_pin}` → `verify_authorizer(action="courtesy")`; `unit_price=0`, conserva `list_price`; `after_bill` si aplica; al superar `courtesy_shift_limit` cortesías del turno (cualquier persona) → `notify(type="courtesy_limit", level="warning", dedupe_key=f"courtesy_limit:{shift_id}")`.
- `POST /orders/{id}/discounts` (operator, `pos.discounts`) `{expected_version, scope: "order"|"item", item_id?, kind: "percent"|"amount", value, reason, note?, authorizer_pin?}` → `OrderOut`.
  Combo → `400 COMBO_NO_LINE_DISCOUNT`; línea: `amount` ≤ gross (`400 DISCOUNT_EXCEEDS_LINE`); límite = `employee.discount_limit_pct` si no es nulo, si no `StoreSalesSettings.discount_limit_pct`; si (Σ descuentos vivos de la comanda incl. este) / subtotal × 100 > límite → `verify_authorizer(action="discount_over_limit")` (sin PIN → `400 DISCOUNT_LIMIT_EXCEEDED {limit_pct, requested_pct}`); acumulado por persona/turno: Σ `amount` de sus descuentos del turno / Σ `total` de sus comandas pagadas del turno > `discount_daily_limit_pct` (solo si hay ventas > 0) → `notify(type="discount_rate_high", level="warning", dedupe_key=f"discount_rate_high:{shift_id}:{employee_id}")`. `DELETE /orders/{id}/discounts/{discount_id}` `{expected_version}` → `voided_at` (baja lógica).
- `POST /orders/{id}/merge` (operator, `pos.tables`) `{expected_version (de la destino), from_order_id, authorizer_pin?}` → mueve TODOS los ítems, descuentos de línea y sub-cuentas de la origen; origen `merged` (`merged_into_order_id`), sus mesas pasan a la destino (nuevas filas `order_tables`; las viejas `released_at`); descuentos de comanda de la origen quedan anulados con nota. Si alguna tiene `bill_presented_at` → `verify_authorizer(action="after_bill_change")`. `MERGE_SAME_ORDER`, `MERGE_NOT_OPEN`.
- `POST /orders/{id}/move` (operator, `pos.tables`) `{expected_version, table_ids, authorizer_pin?}` → `TABLE_ALREADY_OPEN` si destino ocupada; `after_bill_change` si hubo cuenta. `OrderEvent tables_moved`.
- `POST /orders/{id}/void` (operator) `{expected_version, reason, note?, authorizer_pin?}` → si algún ítem fue enviado o hay `bill_presented_at` → `verify_authorizer(action="void_order")`; ítems enviados generan `WasteStub`; mesas liberadas; `status voided`.
- `POST /orders/{id}/bill/present` (operator, `Idempotency-Key`, scope `orders.bill_present`, `pos.pre_bill`) `{expected_version}` → `PreBillOut {order_id, version, lines: [{description, qty, unit_price, gross, discount, net}], subtotal, discount_total, tax_lines, tax_total, total, tip: {base, suggested_pct, suggested_amount}|null, legend: "NO ES FACTURA — documento informativo", bill_presented_at, bill_print_count}`. Primera vez estampa `bill_presented_at` y `status=to_pay`; cada llamada `bill_print_count += 1` y `OrderEvent bill_presented`. `ORDER_EMPTY` sin ítems vivos.
- `POST /orders/{id}/bill/split` (operator, `pos.split_bill`) `{expected_version, mode: "equal", parts} | {expected_version, mode: "items", groups: [{label?, seat?, item_ids: [int], shared: [{item_id, portions: int}]}]}`.
  `equal` → `{mode, parts, per_part: [int] (prorate(total, [1]*parts)), total}` y guarda `split_parts`. `items` → crea N `OrderSubAccount` (`seq` 1..N) + `OrderSubAccountItem` (`portions/of_portions`; un ítem compartido entre k grupos lleva `1/k` en cada uno); todo ítem vivo debe quedar asignado (`400 SPLIT_ITEMS_INCOMPLETE {missing_item_ids}`); reemplaza una división previa si ninguna sub-cuenta está pagada. `pos.seats` permite `groups` derivados de `seat`. Devuelve `{mode, sub_accounts: [SubAccountOut]}`.
- `GET /orders/{id}/sub-accounts` (device) → `[SubAccountOut {id, seq, label, seat, status, items: [{item_id, name, qty, portions, of_portions, share}], totals: {subtotal, discount_total, tax_lines, tax_total, total}, tip: {base, suggested_pct, suggested_amount}|null, document_id}]`.
- Admin (`backend-comanda`): `GET /admin/orders?store_id&from&to&status&channel&flags=voided|courtesy|discounted|staff_meal|transferred|after_bill` (`format=csv`) → `[{id, business_date, shift_id, channel, tables: [numbers], covers, status, opened_by, opened_at, bill_presented_at, paid_at, items_count, total, voided_items: n, voids_after_bill: n, courtesies: n, discount_total, sent_at_payment_items: n, transferred: bool}]`; `GET /admin/orders/{id}` → `OrderOut` (variante admin, mismo shape). Los tiempos p50/p90, «Pedidos completo», Hoy y Ventas son de 1b-2.

`OrderOut` (vinculante para `frontend-comanda`, `frontend-cobro`, `backend-cobro`):

```
{id, version, channel, status, business_date, shift_id, tables: [{id, number, zone_name}], covers, note,
 takeout: {customer_name, phone, promised_at} | null, consumed_by: {id, name} | null,
 opened_by: {id, name}, opened_at, bill_presented_at, bill_print_count, paid_at, closed_at, paid_by: {id,name}|null,
 voided_at, void_reason, merged_into_order_id, transferred_from_shift_id, kitchen_view_enabled, split_parts,
 rounds: [{round_no, sent_at, sent_at_payment}],
 items: [{id, product_id, combo_id, name, qty, seat, course, station, list_price, unit_price, tax_code, tax_rate,
          modifiers: [{option_id, group_name, name, price_delta}], modifiers_text, combo_selections, note,
          status, round_no, sent_at, ready_at, served_at, sent_at_payment,
          gross, discount, net, tax,            # de compute_order_totals (0 en cortesía/anulado)
          courtesy: {reason, note, authorized_by: {id,name}, at, after_bill} | null,
          void: {reason, note, by: {id,name}, authorized_by: {id,name}|null, at, after_bill, minutes_since_sent} | null}],
 discounts: [{id, scope, item_id, kind, value, amount, reason, note, by: {id,name}, authorized_by, after_bill, at}],
 sub_accounts: [SubAccountOut] | [],
 totals: {subtotal, discount_total, tax_lines: [{rate, base, tax}], tax_total, total},
 tip: {base, suggested_pct, suggested_amount} | null,      # null si pos.tips apagada o staff_meal
 document_id: int | null}
```

`409 STALE_VERSION` viene con `extra={"order": OrderOut}` (la comanda actual) en **toda** mutación con `expected_version`.

**Cocina** (`backend-comanda`, `app/kitchen/router.py`, `kitchen.view`)
- `GET /kitchen/rounds?station=` (device) → `[{order_id, round_no, sent_at, elapsed_seconds, channel, tables: [numbers], takeout_name, covers,
  items: [{item_id, name, qty, modifiers_text, note, course, station, status ("sent"|"ready"), elapsed_seconds, target_minutes|null, semaphore: "green"|"amber"|"red"}]}]`
  ordenado por `sent_at` asc; solo ítems `sent|ready` (nunca `served`/`voided`); `station` filtra (sin param: todas). `target_minutes` = `StoreSalesSettings.course_target_minutes[course]` (nulo si no hay); semáforo: sin objetivo → `green`; `elapsed < target` → `green`; `< 1.5×target` → `amber`; si no `red`. El `ready` vive en `/orders/{id}/items/{item_id}/ready` (arriba).

**Cobro y comprobante** (`backend-cobro`)
- `POST /orders/{id}/payments` (operator, `Idempotency-Key`, scope `orders.payments`)
  `{expected_version?, sub_account_id?, pin, tip?: {asked: bool, accepted: bool, modified: bool, amount: int}, splits: [{method, amount, tendered?, reference?}]}` → `201 PaymentOut {order_id, sub_account_id, document: {id, document_type, prefix, number, full_number, dian_status, legend, cude: null, qr_url: null, contingency: false} | null, total, tip_amount, change, paid_at, order: OrderOut}`.
  Orden: `get_order_or_404` → `expected_version` si viene (`409 STALE_VERSION`) → `can_charge` del actor (`400 CANNOT_CHARGE` «Pedí a alguien con permiso de cobro») → `auth_service.verify_pin(db, employee_actual, pin)` (`400 PIN_INVALID` / `PIN_LOCKED`; cobrar re-pide el PIN propio, SPEC §2.1) → `assert_payable` → totales (`compute_order_totals` o `compute_sub_account_totals`) → propina: con `pos.tips` y canal ≠ `staff_meal`, `tip.asked` obligatorio (`400 TIP_NOT_ASKED`), `amount ≥ 0` (`400 TIP_INVALID`); con `pos.tips` apagada el `tip` se ignora y `tip_amount = 0` → medios: cada `method` ∈ `payment_methods` habilitados (`400 PAYMENT_METHOD_INVALID`), `reference` si `requires_reference` (`400 PAYMENT_REFERENCE_REQUIRED`), `tendered` solo en `cash` (`400 CHANGE_ONLY_ON_CASH`), `Σ splits.amount == totals.total + tip_amount` (`400 SPLITS_DO_NOT_MATCH {expected, received}`); si `totals.total == 0` (staff_meal o todo cortesía) `splits` puede ser `[]` y no se emite documento → `auto_send_pending_for_payment` → `claim_payment` (**409 `ORDER_ALREADY_PAID`** en la carrera) → asignación de propina por medio: recorriendo `splits` en orden, cada uno cubre primero venta y lo que excede es propina de ese medio (`Payment.amount` = venta, `tip_amount` = propina); `change = tendered − amount − tip_amount` solo en cash (≥ 0, si no `400 TENDERED_TOO_LOW`) → `reserve_next_number` + `issue_document` (`target_key` UNIQUE como respaldo: `IntegrityError` → `409 ORDER_ALREADY_PAID`) → `OrderTip` → `Payment` por split con `business_date = business_date_for_sale(...)` → `record_audit(entity="order", action="pay")`. Todo o nada: un `AppError` a mitad deja la comanda intacta (validar antes de escribir; el consecutivo se reserva después de validar).
- `GET /documents/{id}` (device o admin) → `DocumentPrintableOut {id, document_type, type_label, prefix, number, full_number ("POS-000123"), dian_status, legend, business_date, issued_at, store: {legal_name, nit, dv, address, municipality_dane}, customer: {doc_type, doc_number, name}, order: {id, channel, tables: [numbers], covers, served_by, charged_by}, lines, subtotal, discount_total, tax_lines, tax_total, total, tip: {amount, suggested_pct, accepted, modified}|null, payments: [{method, label, dian_code, amount, tip_amount, tendered, change, reference}], change, print_count, reprint_count, reprints: [{at, by}], fiscal: {range: null, cude: null, qr_url: null}}`.
- `GET /documents/last` (device) → el último documento emitido en la sede (o `null`). `POST /documents/{id}/reprint` (operator) → `reprint_count += 1`, `DocumentReprint`, devuelve `DocumentPrintableOut`. `GET /admin/documents?store_id&from&to` → lista mínima `[{id, full_number, document_type, dian_status, business_date, issued_at, order_id, total, tip_amount, charged_by}]` (`format=csv`) — lo completo es 1b-2.

**Caja** (`backend-base`, cambios sobre 1a)
- `GET /shifts/current` y `GET /shifts/{id}`: `_can_see_expected(db, actor, shift)` → `True` para admin (tipo o rol); para el **responsable de caja solo si `cash.blind_close` está apagada** en su sede; el operador no responsable nunca. Se aplica a `expected_cash`, `pickups[].expected_at_pickup`, `handovers[].breakdown` y a los nuevos `sales: {cash, card, transfer, other} | null` y `tips: {cash, card, transfer, other} | null` de `ShiftSummaryOut`/`ShiftCurrentOut`. El responsable ve el esperado recién en `GET /shifts/{id}/close/{count_id}/review` (paso 2). Las respuestas directas de `POST /pickups` y `POST /handovers` no cambian (decisión declarada en 1a).
- Cierre (`confirm`, `close` en un paso, `close-administrative`): si `orders.hooks.count_open_orders(shift) > 0` y no viene `transfer_open_orders=true` → `400 OPEN_ORDERS_EXIST {open_orders: n}` («Cobrá o anulá las comandas abiertas, o marcá trasladarlas al turno siguiente»); con `transfer_open_orders` → `detach_open_orders`. El cierre administrativo traslada siempre. `open_shift` → `adopt_transferred_orders`. `CloseReviewOut` gana `open_orders: int`.
- Auditoría de empleados (A-7): `before`/`after` de `entity="employee"` **sin** `document` ni `email` (helper `_employee_audit_view`). `GET /admin/employees` sigue devolviéndolos al admin.

### 2.5 Hooks cruzados — dueño de cada extremo y **dueño del test de punta a punta**

| Hook | Llama | Implementa | Test E2E (archivo) |
|---|---|---|---|
| `POST /auth/device/identify` → `shifts.hooks.on_employee_identified` | backend-base | backend-base | ya existe (1a, `tests/shifts/test_roster_and_hooks.py`) |
| `open_shift` → `catalog.service.reset_daily_availability` | backend-base | catálogo (1a) | ya existe (1a) |
| `compute_breakdown`/`_evaluate_close` → `shifts.hooks.get_sales_totals` leyendo `payments` | backend-base | backend-base | **backend-base**: `tests/shifts/test_sales_totals_e2e.py` (abre turno, comanda counter por API, cobra cash+card con propina, `GET /shifts/{id}` como admin: `expected = base + cash`, `sales.card`, `tips.cash`; `close/count` exige `counted_card`) |
| Cierre → `orders.hooks.count_open_orders` / `detach_open_orders`; `open_shift` → `adopt_transferred_orders` | backend-base | backend-comanda | **backend-base**: `tests/shifts/test_open_orders_gate.py` (comanda abierta → `OPEN_ORDERS_EXIST`; con traslado cierra, abre otro turno y la comanda aparece con `shift_id` nuevo y `transferred_from_shift_id`) |
| `pay_order` → `orders.service.{assert_payable, compute_*_totals, auto_send_pending_for_payment, claim_payment, business_date_for_sale}` | backend-cobro | backend-comanda | **backend-cobro**: `tests/payments/test_pay_flow.py` (pendientes → `sent_at_payment`; comanda `paid`; mesas liberadas) y `tests/payments/test_concurrency.py` (dos cobros con `race_env`: uno 201, otro 409; misma clave → mismo documento) |
| `send`/`auto_send` → `catalog.service.set_product_availability` al llegar a 0 | backend-comanda | catálogo (1a) | **backend-comanda**: `tests/orders/test_send.py` (contador 2 → dos envíos → `available=false`; `GET /catalog` lo refleja; un `void` no lo repone) |
| `void`/`courtesy`/`discount`/`merge`/`move`/`void order` → `auth.service.verify_authorizer` con acciones nuevas | backend-comanda | backend-base | **backend-comanda**: `tests/orders/test_authorizations.py` (supervisor autoriza `void_order`/`after_bill_change`; un operador no) + **backend-base** `tests/auth/test_authorize.py` (matriz) |
| `courtesy`/`discount` → `notifications.service.notify` con tipos nuevos | backend-comanda | backend-base | **backend-comanda**: `tests/orders/test_limits.py` |
| Frontend `EmployeePicker` → `GET /device/employees` | frontend-cobro | backend-base | **auditor-venta**: invariante de privacidad sobre la ruta (backend) + `frontend-cobro` test de componente con API mockeada |
| Frontend `OrderPage` → `/pos/cobro/:orderId` → `POST /orders/{id}/payments` | frontend-comanda → frontend-cobro | backend-cobro | **frontend-cobro**: `src/features/payments/__tests__/CheckoutPage.test.tsx` con `OrderOut` de fixture |

### 2.6 Alembic

| Archivo | `revision` | `down_revision` | Dueño | Tablas |
|---|---|---|---|---|
| `0004_orders.py` | `"0004"` | `"0003"` | backend-comanda | `orders`, `order_tables`, `order_rounds`, `order_items`, `order_discounts`, `order_sub_accounts`, `order_sub_account_items`, `order_events`, `waste_stubs` |
| `0005_payments_fiscal.py` | `"0005"` | `"0004"` | backend-cobro | `fiscal_counters`, `fiscal_documents`, `document_reprints`, `payments`, `order_tips` |

DDL a mano, Postgres-first, índice por cada FK y por cada filtro de pantalla; índices
únicos parciales con `postgresql_where` **y** `sqlite_where`; `downgrade` deshace
exactamente lo suyo en orden inverso. El test del auditor
(`tests/audit/test_migration_invariants.py`) compara tabla por tabla y columna por
columna contra los modelos: una columna que agregás al modelo y no a la migración
rompe la suite. Verificación local: `cd backend && mkdir -p /tmp/pt-<id> && rm -f /tmp/pt-<id>/mig.db && DATABASE_URL=sqlite:////tmp/pt-<id>/mig.db python -m alembic upgrade head` (si `0004` no existe todavía cuando `backend-cobro` prueba, lo declara en gaps y sigue).

## 3. Fixtures de tests (`backend/tests/conftest.py`, las escribe `backend-base`)

Las de 1a siguen (`db`, `client`, `org`, `store`, `store_b`, `org_b`, `employees`,
`admin_client`, `device_client`, `identify`, `set_feature`, `clock`, `idem`,
`race_app`). `backend-base` agrega, **sin cambiar las existentes**:

```
open_shift(*, responsible=None, total=200000, cash_reserve=0, opening_cause=None, opening_note=None) -> dict
                  # identifica al responsable (cashier por defecto: PIN "1111", can_charge=True) y abre con la base fija (denominaciones reales). Copia de tests/audit/conftest.py.
catalog_seeded    # app.catalog.seed.seed_catalog(db, store) + commit; los tests leen ids con GET /catalog
race_env          # dataclass RaceEnv(client: TestClient activado e identificado, employee_id, store_id, organization_id, store_pin, employee_pin, session_factory)
                  # + método seed_product(name="Gaseosa", price=5000, station=None, tax_code="inc_8") -> int (crea categoría y producto en la base de la carrera)
                  # + método open_shift() -> dict (abre turno por API con el client)
race_app          # queda como wrapper: `return race_env.client, race_env.employee_id` (misma base). ES LA ÚNICA FIXTURE PARA TESTS CON HILOS.
```

Los dominios agregan `tests/<dominio>/conftest.py` con fixtures propias (p. ej.
`new_order`, `add_items`, `paid_order`), nunca redefinen las de arriba. Los tests
de concurrencia se escriben **siempre** sobre `race_env`/`race_app` con
`ThreadPoolExecutor` y aceptan como rechazo de la perdedora el código que dice
este contrato (`409 ORDER_ALREADY_PAID`, `409 TABLE_ALREADY_OPEN`); en SQLite la
serialización llega por el lock de escritura y `busy_timeout`.

## 4. Códigos de error nuevos (todos `400` salvo los marcados; `message` con acción correctiva)

`NO_OPEN_SHIFT`, `CHANNEL_DISABLED`, `TABLE_REQUIRED`, `STAFF_MEAL_CONSUMER_REQUIRED`,
`ORDER_NOT_OPEN`, `ORDER_EMPTY`, `ITEM_NOT_PENDING`, `PRODUCT_UNAVAILABLE`,
`OPTION_UNAVAILABLE` (1a), `MODIFIER_SELECTION_INVALID`, `COMBO_NOT_ACTIVE`,
`COMBO_SELECTION_INVALID`, `BILL_PRESENTED_NEEDS_AUTH`, `NOTHING_TO_SEND`,
`DISCOUNT_LIMIT_EXCEEDED`, `DISCOUNT_EXCEEDS_LINE`, `COMBO_NO_LINE_DISCOUNT`,
`MERGE_SAME_ORDER`, `MERGE_NOT_OPEN`, `SPLIT_ITEMS_INCOMPLETE`, `SUB_ACCOUNT_REQUIRED`,
`SUB_ACCOUNT_ALREADY_PAID` (409), `CANNOT_CHARGE`, `TIP_NOT_ASKED`, `TIP_INVALID`,
`PAYMENT_METHOD_INVALID`, `PAYMENT_REFERENCE_REQUIRED`, `CHANGE_ONLY_ON_CASH`,
`TENDERED_TOO_LOW`, `SPLITS_DO_NOT_MATCH`, `OPEN_ORDERS_EXIST` ·
`409 STALE_VERSION` (con `order`), `409 TABLE_ALREADY_OPEN` (con `table_id`),
`409 ORDER_ALREADY_PAID` · reutilizados de 1a: `FEATURE_DISABLED`,
`AUTHORIZATION_REQUIRED`, `AUTHORIZATION_INVALID`, `AUTHORIZATION_NOT_ALLOWED`,
`PIN_INVALID`, `PIN_LOCKED`, `IDEMPOTENCY_*`, `NOT_FOUND`, `VALIDATION_ERROR`.

## 5. Reglas de plata que el auditor convierte en invariantes (y nadie discute)

1. Σ `lines.net` = `total`; Σ prorrateo = descuento de comanda; Σ `tax_lines.tax` = `tax_total`; sobre 1.000 comandas aleatorias (semilla fija).
2. Σ totales de las sub-cuentas de una división por ítems = total de la comanda; N documentos con N consecutivos distintos y seguidos.
3. La propina nunca entra en `subtotal`, `total`, `tax_*` ni en `sales.*` del turno; entra solo en `tips.*`; `tip_base = total − tax_total`.
4. Consecutivo por `(store, document_type, prefix)` sin huecos tras 100 cobros; un cobro rechazado (400) no consume número; dos cobros concurrentes: 201 + 409 y un solo documento; misma `Idempotency-Key` → misma respuesta y un solo documento.
5. `staff_meal`: `unit_price=0`, `tax_rate=0`, `tip=null`, total 0, sin documento, no suma a `sales.*`.
6. Con `kitchen.view` apagada no existe `send` (`FEATURE_DISABLED`), y al cobrar los ítems quedan `served` con `sent_at_payment=true`.
7. Anular un ítem enviado nunca repone `daily_remaining` ni `available`; crea `waste_stubs` con `ingredient_id NULL`.
8. Con `cash.blind_close` encendida el responsable no ve `expected_cash`, `sales`, `expected_at_pickup` ni `breakdown` en `current`/`{id}`; el admin sí; el paso 2 del cierre lo revela.
9. La auditoría de `employee` nunca guarda `document` ni `email`; `GET /device/employees` nunca los expone.
10. Ninguna respuesta de dispositivo (comandas, cocina, cobro, documentos, OpenAPI) contiene `cost`, `margin`, `unit_cost`.

## 6. Frontend

### 6.1 Convenciones (1a + este pedido)

Stack real: Vite + React 19 + TypeScript 6 + Tailwind v4 + shadcn sobre
`@base-ui/react` (**no existe `asChild`**: mirá cómo lo resuelven los componentes de
`src/components/ui/*` y `src/features/shifts/*`). `api<T>()` de `src/api/client.ts`
(`idempotencyKey`, `query`, `ApiError {status, code, extra}`), `newIdempotencyKey()`,
`useSession().hasFeature`, `renderWithProviders`/`buildMe` de `src/test/utils.tsx`,
`PinPad`, `MoneyInput`, `EmptyState`, `formatCOP` (`null` → «—»), `formatInstant`,
`formatBusinessDate`, `errorMessage`. Botones ≥ 44 px; foco visible; `aria-label`;
375 px y 1024 px sin scroll horizontal; claro/oscuro con tokens (nunca colores
hardcodeados salvo el semáforo de cocina, que usa `bg-emerald/amber/red` de Tailwind
con texto accesible). Todo campo nuevo de respuesta es **opcional** en los tipos
`Out`; los tipos `In` son estrictos. Nada de sesión en `localStorage`. Todo error
del servidor se muestra como texto (`errorMessage`), nunca un objeto.

**Una sola matemática, en el backend.** El frontend NUNCA calcula subtotales,
impuestos, descuentos, propina sugerida, totales de sub-cuentas, partes iguales ni
cambio: los pinta tal como llegan (`OrderOut.totals`, `OrderOut.tip`,
`PreBillOut`, `split.per_part`, `PaymentOut.change`). Lo único que puede sumar es
lo que la persona tecleó en los `splits` para decir «faltan $X» como guía de
tecleo (el backend valida con `SPLITS_DO_NOT_MATCH`). El auditor lo verifica por
inspección de fuente en `src/audit/`.

### 6.2 Módulos y rutas

```
src/api/employees.ts     (frontend-cobro) + export interface DeviceEmployee {id; name; role}; listDeviceEmployees(): Promise<DeviceEmployee[]>  → GET /device/employees
src/components/EmployeePicker.tsx (frontend-cobro)
                         props {value: number | null; onChange(id: number, employee: DeviceEmployee): void; label: string; roles?: string[]; excludeIds?: number[]; disabled?: boolean}
                         grilla de botones ≥ 44px con iniciales (avatar) + nombre + rol, `role="radiogroup"`/`aria-checked`; carga con react-query key ["device","employees"]; estados cargando/error/vacío.
src/api/orders.ts        (frontend-comanda) tipos OrderOut, OrderItemOut, SubAccountOut, PreBillOut, TablesStatusOut, FavoriteOut + funciones:
                         listTablesStatus, createOrder, listOrders, getOrder, listFavorites, addItems(orderId, body, key), patchItem, sendOrder(orderId, body, key),
                         markReady(orderId, itemId, key), markServed(...), voidItem, courtesyItem, addDiscount, removeDiscount, mergeOrders, moveOrder, voidOrder,
                         presentBill(orderId, body, key), splitBill, listSubAccounts, adminListOrders, adminGetOrder
src/api/kitchen.ts       (frontend-comanda) listKitchenRounds(station?)
src/api/payments.ts      (frontend-cobro) PaymentIn/PaymentOut, payOrder(orderId, body, key)
src/api/documents.ts     (frontend-cobro) DocumentPrintable, getDocument, getLastDocument, reprintDocument, adminListDocuments
src/features/orders/index.ts   (frontend-comanda) export const ordersFeature = { posRoutes, adminRoutes, adminNav, posNav }
                         posRoutes: [{path:"mesas", TablesPage}, {path:"comanda/nueva", NewOrderPage}, {path:"comanda/:orderId", OrderPage}, {path:"cocina", KitchenPage}]
                         adminRoutes: [{path:"pedidos", OrdersAdminPage}]; adminNav: [{to:"/admin/pedidos", label:"Pedidos"}]
                         posNav: [{to:"/pos/mesas", label:"Mesas", feature:"pos.tables"}, {to:"/pos/comanda/nueva", label:"Comanda"}, {to:"/pos/cocina", label:"Cocina", feature:"kitchen.view"}]
src/features/payments/index.ts (frontend-cobro) export const paymentsFeature = { posRoutes: [{path:"cobro/:orderId", CheckoutPage}, {path:"documento/:documentId", DocumentPage}], posNav: [] }
src/features/shifts/index.ts   (frontend-cobro edita) posRoutes SIN `index: true` (queda solo "turno"); posNav igual
src/app/PosHome.tsx      (frontend-cobro) ruta index de /pos: si hasFeature("pos.tables") → <Navigate to="/pos/mesas"/>; si no → "/pos/comanda/nueva"
src/app/router.tsx       (frontend-cobro) children de /pos: [{index: true, PosHome}, ...shiftsFeature.posRoutes, ...ordersFeature.posRoutes, ...paymentsFeature.posRoutes]; /admin: + ordersFeature.adminRoutes
src/app/PosLayout.tsx    (frontend-cobro) barra de navegación del POS a partir de [...ordersFeature.posNav, ...shiftsFeature.posNav] filtrada por hasFeature; botones ≥ 44px; ShiftStatusStrip se mantiene
src/app/AdminLayout.tsx  (frontend-cobro) buildNav agrega ordersFeature.adminNav
```

Navegación acordada: `OrderPage` → botón «Cuenta / Cobrar» → `navigate("/pos/cobro/${orderId}")`
(pasa por precuenta si `pos.pre_bill`); `NewOrderPage` con canal `counter` crea la
comanda y sigue en `OrderPage` con un botón «Cobrar» prominente (mostrador: crear →
enviar si hay cocina → cobrar en un solo flujo); `CheckoutPage` tras cobrar muestra el
comprobante (`/pos/documento/:id`, con botones «Imprimir» = `window.print()` y
«Reimprimir» contado) y desde ahí «Volver» → `/pos/mesas` si `pos.tables`, si no
`/pos/comanda/nueva`. `KitchenPage` no navega a ninguna otra.

### 6.3 Patrones obligatorios

- **Autorizador**: ante `AUTHORIZATION_REQUIRED`, `DISCOUNT_LIMIT_EXCEEDED` o
  `BILL_PRESENTED_NEEDS_AUTH`, abrir un diálogo con `PinPad` («PIN de supervisor o
  administrador») y reintentar la misma acción con `authorizer_pin` y una
  `Idempotency-Key` **nueva** (el body cambió) — igual que `MovementsPanel` con
  `PETTY_CASH_LIMIT`.
- **Versión optimista**: toda mutación manda `expected_version = order.version`;
  ante `409 STALE_VERSION`, reemplazar la comanda local por `error.extra.order`,
  invalidar la query y avisar «La comanda cambió en otra tablet; revisá y repetí».
- **Sondeo**: comanda abierta y mesas cada 5 s; cocina cada 4 s; con
  `refetchInterval` de react-query y una sola clave por recurso
  (`["orders", id]`, `["tables","status"]`, `["kitchen", station]`).
- **Flags**: cada acción opcional se muestra solo con su flag (`pos.tables`,
  `pos.seats`, `pos.courses`, `pos.pre_bill`, `pos.split_bill`, `pos.tips`,
  `pos.discounts`, `pos.courtesies`, `pos.staff_meal`, `pos.takeout`, `pos.counter`,
  `kitchen.view`, `pos.daily_count`, `pos.modifiers`, `pos.combos`, `pos.daily_menu`)
  y el backend sigue siendo la barrera.
- **Impresión**: `DocumentPage` usa CSS `@media print` en un archivo propio del
  feature (`src/features/payments/document-print.css`) para 58/72/80 mm; muestra
  la leyenda del documento tal cual llega (`legend`) y la línea de propina aparte.
- **Tests**: vitest + Testing Library; `vi.mock("@/api/orders")` etc. con fixtures
  de `OrderOut` en `src/features/<dominio>/__tests__/fixtures.ts`; al menos un
  test por pantalla y uno por flag que oculta una acción.

## 7. Stubs y hand-off

### 7.1 Stub de `src/features/orders/index.ts`

`frontend-cobro` lo crea **solo si no existe** con este contenido exacto, y
`frontend-comanda` lo sobreescribe con el real:

```ts
import type { RouteObject } from "react-router-dom";
import type { NavItem } from "@/app/nav";
const posRoutes: RouteObject[] = [];
const adminRoutes: RouteObject[] = [];
const adminNav: NavItem[] = [];
const posNav: NavItem[] = [];
export const ordersFeature = { posRoutes, adminRoutes, adminNav, posNav };
```

### 7.2 Backend

Ningún stub: `main.py` y `models_registry.py` descubren con `find_spec`. Los hooks
cruzados se llaman con `importlib.util.find_spec` en el lado que llama (patrón de
1a), y el lado que implementa existe desde el primer commit de su dueño.

## 8. Verificación por agente (recordatorio)

Solo tus tests y el typecheck. La suite completa, `alembic upgrade head` sobre una
base nueva desde cero, el seed dos veces y `npm run build` los corre la verificación
final del Maestro, una vez, en serie, con el árbol quieto.
