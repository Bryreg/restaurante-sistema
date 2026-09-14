# Pedido 1b — Comanda y venta

Segundo pedido al orquestador; construye sobre lo entregado por 1a. Depende de
`docs/SPEC-NEGOCIO.md` (v0.3) y de `AGENTS.md`. Si algo de acá contradice a la spec
de negocio, manda la spec de negocio y se corrige acá.

## Objetivo

Que el restaurante **opere de punta a punta**: abrir mesas, tomar comandas, enviarlas
por rondas a una vista de cocina, presentar la cuenta con la pregunta de propina,
cobrar con pagos mixtos y división, emitir el **documento fiscal** con consecutivo,
estados ante la DIAN y adaptador de proveedor, corregir por notas, y que el
administrador vea Hoy, Ventas (con el informe del contador) y Pedidos.

## Alcance

**Entra**

- Spec de negocio §3.3, §3.4, §3.5, §3.6 (comandas, cobro, notas, mesas y
  estaciones), §6.2 y §6.3 (propinas y devoluciones pendientes), §8.2, §8.3 y §8.4
  (impuesto, documento fiscal, datos personales), §9.1 completo, §9.2 (cocina
  mínima), §9.3 secciones Hoy, Ventas, Pedidos y lo que Turnos y personal y Dinero
  ganan con ventas.
- Canales `dine_in`, `takeout` y `staff_meal`. Los valores `delivery` y `platform`
  existen en el enum y en la configuración (apagados); sus datos llegan en fase 2.
- **Adaptador de proveedor tecnológico**: una interfaz (`FiscalProvider`) con dos
  implementaciones: `PendingTransmissionProvider` (modo pendiente, imprime con
  leyenda y encola) y un `FakeProvider` para tests (valida, rechaza y simula
  contingencia). La implementación real se agrega cuando el dueño elija proveedor.
- Ganchos para fase 2 sin construirla: el ítem congela `unit_cost` y
  `recipe_version` en `null`; `send` crea la fila de «consumo pendiente» vacía;
  `void` de un ítem enviado crea la merma con cantidad y sin insumo (se resuelve en
  fase 2); `note` con «vuelve» registra la devolución sin mover inventario.

**No entra**

- Recetas, inventario, compras, consignaciones, banco, nómina, KDS con «bump»,
  «marchar», impresora térmica, domicilio, plataformas, varias comandas por mesa,
  reparto automático de propinas.

## Convenciones de ingeniería

Las de 1a, más:

- Dominios nuevos: `orders`, `payments`, `fiscal`, `customers`, `kitchen`, `reports`.
- `Idempotency-Key` en `orders/{id}/items`, `send`, `bill/present`, `payments`,
  `items/{id}/ready`, `items/{id}/served`, `notes`.
- Versión optimista en la comanda (`version`); toda mutación manda `expected_version`
  y recibe `409 STALE_VERSION` con la comanda actual.
- Constraints: una comanda abierta por mesa (índice único parcial sobre
  `order_tables`); consecutivo único por `(store, document_type, prefix)`; un
  documento por sub-cuenta.
- Redondeo: por línea `base = round_half_up(total / (1 + rate))`, `tax = total −
  base`; totales = Σ líneas por tarifa; descuento de comanda prorrateado por bruto
  con el residuo en la línea mayor; invariante testeada `Σ líneas = total`.
- Lo que va a cocina y al documento se lee de los **snapshots** del ítem, nunca del
  catálogo actual.

## API contract (English — technical artifact)

Same conventions as 1a. All routes under `/api/v1`.

### Orders
- `POST /orders` `{channel: "dine_in"|"takeout"|"staff_meal", table_ids?: [...], covers?, takeout?: {customer_name, phone, promised_at}, consumed_by_employee_id? (staff_meal), note?}` → `400 NO_OPEN_SHIFT`, `409 TABLE_ALREADY_OPEN`, `400 CHANNEL_DISABLED`. Records `opened_by`.
- `GET /orders?status=open|to_pay`; `GET /orders/{id}` → `{id, version, channel, tables, covers, status, opened_by, opened_at, bill_presented_at?, items: [{id, product_id, name, qty, seat?, course, station, unit_price, tax_code, tax_rate, discount, modifiers: [...], modifiers_text, note, status, round_no?, sent_at?, ready_at?, served_at?, sent_at_payment, courtesy?: {reason, authorized_by}, void?: {reason, authorized_by, at, after_bill}}], discounts: [...], totals: {subtotal, discount_total, tax_lines: [{rate, base, tax}], total}}`. **No cost fields for device sessions.**
- `POST /orders/{id}/items` (Idempotency-Key, `expected_version`) `[{product_id | combo_id, qty, seat?, course?, modifiers: [{option_id}], combo_selections?: [{group_id, option_id}], note?}]` → items `pending` with snapshots; `400 PRODUCT_UNAVAILABLE`, `400 COMBO_NOT_ACTIVE`, `400 BILL_PRESENTED_NEEDS_AUTH` (after bill without `authorizer_pin`).
- `PATCH /orders/{id}/items/{item_id}` `{qty?, note?, seat?}` — only while `pending`.
- `POST /orders/{id}/send` (Idempotency-Key) → all `pending` → `sent` as one numbered round; products without station go straight to `served`; decrements `daily_remaining`.
- `POST /orders/{id}/items/{item_id}/void` `{reason: "customer_changed_mind"|"server_error"|"kitchen_error"|"long_wait"|"walkout"|"duplicate"|"other", note?, authorizer_pin?}` → `pending` voids freely; `sent`/`ready`/`served` require an authorizer → `400 AUTHORIZATION_REQUIRED`; records `after_bill`, `minutes_since_sent`, creates the waste stub.
- `POST /orders/{id}/items/{item_id}/courtesy` `{reason: "complaint"|"promo_owner"|"guest_of_owner"|"other", note?, authorizer_pin}`.
- `POST /orders/{id}/items/{item_id}/ready` and `/served` (Idempotency-Key).
- `POST /orders/{id}/merge` `{from_order_id, authorizer_pin?}` → moves all items, source becomes `merged`; requires authorizer if either has `bill_presented_at`.
- `POST /orders/{id}/move` `{table_ids, authorizer_pin?}`.
- `POST /orders/{id}/void` `{reason, note?, authorizer_pin?}` — authorizer required if any item was sent or the bill was presented.
- `POST /orders/{id}/discounts` `{scope: "order"|"item", item_id?, kind: "percent"|"amount", value, reason: "promo"|"complaint"|"owner"|"employee"|"other", note?, authorizer_pin?}` → `400 DISCOUNT_LIMIT_EXCEEDED` without authorizer above `discount_limit_pct`; never exceeds the line gross; combos reject line discounts (`400 COMBO_NO_LINE_DISCOUNT`).
- No route transfers single items between orders (by design).

### Bill & tip
- `POST /orders/{id}/bill/present` (Idempotency-Key) → stamps `bill_presented_at` (first time), increments `bill_print_count`, status `to_pay`; returns the non-fiscal pre-bill `{lines, subtotal, discount_total, tax_lines, tip_base (subtotal net of discounts, without tax), tip_suggested_pct, tip_suggested_amount, legend: "NO ES FACTURA — documento informativo"}`.
- `POST /orders/{id}/bill/split` `{mode: "equal", parts} | {mode: "items", groups: [{seat?: n, item_ids: [...], shared: [{item_id, portions}]}]}` → for `equal` returns one bill with `parts`; for `items` creates N sub-accounts (`GET /orders/{id}/sub-accounts`), each with its own totals and tip question.

### Payments & fiscal document
- `POST /orders/{id}/payments` (Idempotency-Key) `{sub_account_id?, tip: {asked: true, accepted: bool, modified: bool, amount}, splits: [{method: "cash"|"card"|"transfer"|"platform"|"voucher"|"other", amount, reference?, tendered?}], customer?: {doc_type: "13"|"31"|"22"|"41"|..., doc_number, dv?, name, email, address?, municipality_dane?, consent: {text_version, channel}}, requests_invoice?: bool}` → creates the fiscal document (type `pos_equivalent`, or `invoice` when `requests_invoice` or net > `invoice_threshold_uvt` × UVT and the customer is identified); returns `{document: {id, type, prefix, number, dian_status, cude?, qr_url?, contingency: bool}, change, requires_invoice: bool}`; `409 ORDER_ALREADY_PAID`; `400 SPLITS_DO_NOT_MATCH`; `400 TIP_NOT_ASKED`; `400 CUSTOMER_REQUIRED_FOR_INVOICE`. Pending items are auto-sent with `sent_at_payment = true`.
- `GET /documents/{id}` → printable representation (all fields of spec §8.3, tip line, table, channel, covers, served_by, charged_by, legend when pending/contingency). `GET /documents/last` (device). `POST /documents/{id}/reprint` → counted.
- Admin fiscal: `GET/POST /admin/fiscal/ranges` `[{store_id, document_type, prefix, from, to, resolution_number, resolution_date, valid_from, valid_until, technical_key, consumed}]` with alerts at 80 % and 30 days; `GET /admin/fiscal/documents?status=pending|contingency|rejected`; `POST /admin/fiscal/documents/{id}/retry`; `GET /admin/fiscal/documents/{id}/evidence` (XML, DIAN response, hashes); `GET /admin/fiscal/export?from&to` (evidence bundle).
- `POST /admin/documents/{id}/notes` `{kind: "adjustment"|"credit"|"debit", reason, lines: [{item_id, used: bool}], refund?: {method, amount}}` → own consecutive from its own range; original becomes `reversed`; cash refund creates a `refund` movement in the open shift or a **pending refund** (`GET /admin/pending-refunds`, `POST /admin/pending-refunds/{id}/settle` `{from: "shift"|"owner", shift_id?}`).
- `FiscalProvider` interface (internal): `emit(document) → {status, cude, qr_url, xml_ref, response}`, `retry(document)`, `health()`. Documents in `contingency` older than 48 h raise `fiscal_contingency_overdue`.

### Customers (admin; device only creates via payment)
- `GET /admin/customers?doc_number=`; `PATCH /admin/customers/{id}`; `POST /admin/customers/{id}/consents` `{purpose: "invoice"|"marketing", granted, channel, text_version}`; `POST /admin/customers/{id}/erase` → anonymizes the master, keeps document snapshots; `GET /admin/customers/{id}/requests` (habeas data log).

### Kitchen (device with station)
- `GET /kitchen/rounds?station=` → rounds ordered by `sent_at` with elapsed seconds, course, target minutes and semaphore; `POST /orders/{id}/items/{item_id}/ready` as above. Polling every 3–5 s.

### Tips
- `GET /shifts/{id}/tips` → `{by_method: {cash, card, transfer}, by_employee: [...], cash_out, electronic_liability}`; `POST /admin/tips/payouts` `{shift_ids, distribution: [{employee_id, amount}], paid_at, method}` — registers the distribution (calculation is manual in this phase).

### Admin reports
- `GET /admin/today?store_id` → sales by hour, gross and net, tips by method, avg ticket per order and per cover, covers, occupied tables, open orders with age (flag > X min unsent / > Y min unpaid), expected cash, unavailable products, and alerts (stale shift, differences, unusual voids/discounts, contingency/rejected documents, range nearly exhausted, unreviewed closes, pending refunds).
- `GET /admin/sales?from&to&store_id&group_by=business_date|shift|method|channel|employee|hour|zone` → `{gross, net, tax, tips, orders, covers, avg_ticket, avg_per_cover}`.
- `GET /admin/accountant-report?year&bimester|month&store_id` → per business date and tax rate: base, tax, documents, notes, tips (informative); totals by method.
- `GET /admin/documents?from&to&type&status`; `GET /admin/notes?from&to`.
- `GET /admin/orders?from&to&status&flags=voided|courtesy|discounted|staff_meal|transferred` → with times (table, kitchen p50/p90 by station, bill→paid), voids (`after_bill`, minutes, payment method, authorizer), courtesies at list price (cost in phase 2), discounts, `sent_at_payment` ratio.
- `GET /admin/employees/{id}/activity` gains: sales, avg ticket, orders, voids (n, $, %, after_bill, on cash), discounts, courtesies, walkouts, reprints, `% sent_at_payment`, tips; compared to team average.
- `GET /admin/unavailable-log?from&to` → product, who, when, estimated lost sales.
- Notification types added: `void_rate_high`, `discount_rate_high`, `courtesy_limit`, `order_unsent_too_long`, `order_unpaid_too_long`, `fiscal_rejected`, `fiscal_contingency_overdue`, `fiscal_range_low`, `pending_refund`.
- Every list endpoint accepts `format=csv`.

## Verificación del pedido (checklist de entrega)

Además de la sección 16 de la spec de negocio (pedido 1b):

- [ ] `POST /orders` sin turno → `400 NO_OPEN_SHIFT` con la acción correctiva (test).
- [ ] Mutación con `expected_version` vieja → `409 STALE_VERSION` y la comanda actual
      (test); `items` con la misma `Idempotency-Key` no duplica (test).
- [ ] `send` crea una ronda numerada sólo con los pendientes; un producto sin
      estación queda `served` (test).
- [ ] `payments` con ítems pendientes los marca `sent_at_payment` (test).
- [ ] `bill/present` + `void` sin autorizador → `400 AUTHORIZATION_REQUIRED`; con
      autorizador queda `after_bill = true` y `minutes_since_sent` (test).
- [ ] `void` de ítem `sent` no repone nada y crea el stub de merma (test).
- [ ] `payments` sin `tip.asked` → `400 TIP_NOT_ASKED`; `tip_suggested_pct = 11` en
      configuración → `400`; el documento y la precuenta discriminan la propina; la
      propina no entra en `net` de ningún reporte (tests).
- [ ] Invariante de redondeo `Σ líneas = total` y prorrateo de descuento sin perder un
      peso, sobre 1.000 comandas aleatorias (test de propiedad).
- [ ] Dos `payments` concurrentes: `200` y `409`; misma clave → misma respuesta, un
      solo documento (test).
- [ ] `bill/split` por ítems produce N documentos con consecutivos propios; `equal`
      produce uno con N pagos (test).
- [ ] Consecutivo por tipo y sede sin huecos tras 100 ventas, 3 notas y 2 rechazos del
      `FakeProvider`; un rechazo no libera el número (test).
- [ ] Documento en `contingency` se imprime con leyenda; a las 48 h dispara
      `fiscal_contingency_overdue` (test con reloj simulado).
- [ ] `customers/{id}/erase` anonimiza el maestro y deja intacto el snapshot del
      documento (test).
- [ ] Nota sin turno abierto → devolución pendiente; `settle` desde un turno crea el
      egreso `refund` en ese turno y no toca el original (test).
- [ ] Sesión de dispositivo: ninguna respuesta contiene `cost` (test sobre OpenAPI).
- [ ] Zona horaria: venta a las 00:30 en el día del turno; a las 10:00 sobre turno
      pasado de la hora de corte, sellada con hoy (test).
- [ ] POS en 375 px y 1024 px sin scroll horizontal; foco visible; contraste AA.
- [ ] Typecheck, suite completa y build, una vez, en serie.
