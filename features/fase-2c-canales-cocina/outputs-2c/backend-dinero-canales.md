# `backend-dinero-canales` — el dinero de los canales nuevos (pedido 2c)

Agente de backend dueño de **plataformas, comisiones, la cuenta por cobrar, el
efectivo de domicilios y la venta compensada**. Dominio nuevo `app/channels/**`,
más `app/payments/**`, `app/shifts/**`, `app/fiscal/**` (sin tocarlo, ver §8),
`app/main.py`, `app/core/models_registry.py` y `alembic/versions/0014_channels_money.py`.

Casi todo este trabajo consiste en que **dos invariantes heredados no se rompan**
mientras entra plata por caminos nuevos. `app/shifts/**` fue territorio cruzado por
tercera vez; las dos anteriores ahí cayó un hallazgo.

---

## 0. PASO 0 y CONTRATO C5 — los dos dominios registrados

**Paso 0, hecho antes de tocar ninguna lista**: `backend/app/channels/__init__.py`
creado (con su docstring explicando por qué existe) **antes** de que la cadena
`"channels"` apareciera en `DOMAINS` o en `MODEL_MODULES`. Sin la carpeta,
`find_spec("app.channels.router")` importa primero el paquete padre y levanta
`ModuleNotFoundError` en vez de resolver `None` — el defecto de 1b-1 que tumbaba
el arranque de toda la API. Verificado corriendo `create_app()` después de cada
edición.

**CONTRATO C5 — los dos registros, con archivo y línea:**

| Qué | Archivo | Línea | Dueño del dominio |
|---|---|---|---|
| `"channels"` en `DOMAINS` | `backend/app/main.py` | **59** | este agente |
| `"channels"` en `MODEL_MODULES` | `backend/app/core/models_registry.py` | **54** | este agente |
| **`"kitchen"` en `MODEL_MODULES`** | `backend/app/core/models_registry.py` | **55** | **`backend-kds`** |

`kitchen` **no es mío** y está registrado igual, a propósito y en el primer commit:
`backend-kds` crea `app/kitchen/models.py` en este pedido (hasta 2b ese dominio no
tenía modelos, por eso nunca estuvo en la lista) y tiene prohibido tocar estos dos
archivos. Sin esa línea sus tablas no entran a `Base.metadata`, y por lo tanto no
existen ni para Alembic ni para `create_all` en los tests, y él no lo podría
arreglar desde su territorio. **Es H-0 de 2b en su forma exacta** —uno agrega al
modelo, otro produce, nadie es dueño del contrato publicado— resuelto de antemano.
`kitchen` ya estaba en `DOMAINS` desde 1b-1 (su router existe), así que ahí no
hacía falta nada.

Los dos comentarios de esas listas nombran al dueño de cada dominio, para que la
próxima lectura no tenga que adivinar por qué un agente registró un dominio ajeno.

---

## 1. Las firmas exactas de los contratos publicados

### CONTRATO C2 — lo que publico para la comanda

```python
# backend/app/channels/hooks.py:50
def get_platform(db: Session, *, store_id: int, platform_id: int) -> PlatformRef | None
```

`PlatformRef` es una `dataclass(frozen=True)` con `id: int`, `name: str`,
`code: str`, `commission_bp: int`, `active: bool`. Devuelve `None` en los tres
casos —no existe, no es de esa sede, está inactiva— y **nunca levanta**: quien
llama decide el código HTTP. Extra publicado en el mismo archivo:
`list_active_platforms(db, *, store_id) -> list[PlatformRef]`, que usa mi ruta de
dispositivo.

**Verificado contra el consumidor real**: `backend-canales-comanda` ya lo llama
desde `app/orders/service.py::_get_platform` con `find_spec_safe` y esa firma
exacta, y traduce el `None` a `400 PLATFORM_NOT_CONFIGURED`. El contrato cierra en
los dos sentidos. Si alguna vez cambia, se declara por escrito nombrándolo.

### CONTRATO C4-bis — el seed

```python
# backend/app/channels/seed.py:42
def seed_channels(db: Session, *, organization: Any, store: Any, admin: Any = None) -> dict[str, Any]
```

Devuelve **al menos** `{"platform_id": int}`, y además `platform_code`,
`commission_bp`, `platform_payment_method_added` y `created`. Siembra **una**
plataforma («Rappi», `commission_bp=1800` = 18 %) y deja el medio de pago
`platform` disponible en la configuración de ventas de la sede.

**Idempotente, y probado corriéndolo dos veces de verdad**
(`tests/channels/test_seed.py::test_seeding_twice_does_not_duplicate_anything`):
segunda corrida devuelve `created=False` y el **mismo** `platform_id`, queda una
sola fila y un solo medio de pago. No se asume: se corre. `tests/channels/test_seed.py`
también fija la firma con `inspect.signature`, que es el invariante barato que
cobra el cruce.

Lo llama `app/seed.py`, territorio de `backend-canales-comanda`. **Yo no lo toqué.**

### CONTRATO C4 — lo que llamo (no publico)

`app.orders.hooks.mark_platform_order_cancelled(db, *, order, actor, now, reason)`,
vía `find_spec_safe`. Ya existe en el árbol con esa firma. **No escribí una línea
en `app/orders/**`.**

---

## 2. EL IDA Y VUELTA DE LA LIQUIDACIÓN DE DOMICILIOS, escrito como contrato

Es la mitad que faltó las dos veces anteriores en `app/shifts/**`. La lección de 2b
fue literal: *nombrar dueño al archivo no alcanza cuando lo que hay que nombrar es
un ida y vuelta*. Acá está el contrato completo.

| | |
|---|---|
| **Quién publica** | `app/shifts/hooks.py` (este agente) |
| **Quién llama la IDA** | `app.channels.service.settle_delivery_cash` → `register_delivery_settlement_income` (`hooks.py:471`) |
| **Quién llama la VUELTA** | `app.channels.service.void_delivery_settlement` → `register_delivery_settlement_reversal` (`hooks.py:522`) |
| **Dónde escribe** | SIEMPRE el turno `OPEN` de la sede **en ese momento**, nunca el turno en que se vendió |
| **Causa** | `CashMovementCause.DELIVERY_SETTLEMENT` (enum nuevo), `kind=INCOME` en la ida, `kind=EXPENSE` en la vuelta |
| **Qué pasa sin turno abierto** | `AppError("NO_OPEN_SHIFT", status=409)` **antes de escribir nada**, y la operación entera se rechaza |
| **Qué pasa cuando se deshace** | ver abajo |

### El estado antes de la liquidación

Un cobro en efectivo de un domicilio propio lo tiene el **domiciliario**. El medio
sigue siendo `cash` —la plata *es* efectivo y el código DIAN no cambia por quién la
sostenga—; lo que cambia es el bolsillo, y eso son dos columnas nuevas en
`payments`: `delivery_courier_employee_id` (+ nombre congelado) y
`delivery_settlement_id`.

El domiciliario **sale de la COMANDA**, no de que el POS se acuerde de mandarlo:
`app/payments/service.py::_resolve_channels` (línea 383) lo toma de
`order.courier_employee_id`, y el bloque `delivery` del body sólo sirve para
CORREGIR quién entregó de verdad. Si dependiera del cliente, el turno cuadraría de
más justo cuando alguien se olvidó del bloque, que es el peor error posible.

`app.shifts.hooks.get_sales_totals` saca esos pagos de `.cash` (y su propina de
`.tips_cash`) **siempre**, liquidados o no, y los publica en cuatro campos nuevos:
`delivery_cash`, `delivery_cash_pending`, `tips_delivery`, `tips_delivery_pending`.

### La IDA

`POST /delivery-settlements` (dispositivo, `current_operator`, detrás de
`pos.delivery`, con `Idempotency-Key`). Orden deliberado —validar antes de
escribir, porque `get_db` comitea también ante `AppError`—:

1. El domiciliario existe y es de la organización, si no `404`.
2. Hay cobros pendientes; si no, `400 NOTHING_TO_SETTLE`. **Nunca una liquidación
   de `$0`**: un cero mudo que después nadie sabe leer (H-5 de 2b).
3. `register_delivery_settlement_income` busca el turno `OPEN` y levanta
   `409 NO_OPEN_SHIFT` **antes** de tocar los pagos.
4. Recién ahí se escribe `delivery_settlements` y se marcan los pagos.

La plata entra al esperado por `incomes`, que ya existía. **`compute_breakdown`
no cambió de fórmula.** Y entra **por el monto de la VENTA sola**: la propina en
efectivo del domicilio no mueve el esperado, igual que no lo mueve la de ninguna
otra venta (corregido en la ronda 2 — ver §10.1).

### LA VUELTA — qué pasa cuando se deshace

`POST /delivery-settlements/{id}/void` (mismo gate, `Idempotency-Key`, `reason`
obligatorio):

- Se escribe el movimiento **ESPEJO**: `kind` opuesto (`EXPENSE`), **misma causa
  tipada**, en el turno abierto **al momento de deshacer** —que puede no ser el
  mismo en el que entró la plata: el turno original ya pudo cerrarse, y un turno
  `CLOSED` es inviolable porque su conteo a ciegas ya ocurrió—.
- El `CashMovement` del ingreso original **queda vivo tal cual**. Nada financiero
  se borra. La liquidación pasa a `status=VOIDED` con motivo, quién y cuándo, y
  guarda `void_shift_id` y `void_cash_movement_id`.
- Los pagos vuelven a `delivery_settlement_id = NULL`: no se borra plata, se
  devuelve el cobro al estado *pendiente de liquidar*, que es exactamente lo que
  vuelve a ser cierto.
- **Sin turno abierto, `409 NO_OPEN_SHIFT` y la anulación entera se rechaza**: no
  queda ni el espejo, ni el `voided_at`, ni los pagos liberados. Probado:
  `tests/channels/test_delivery_settlement.py::test_undoing_without_an_open_shift_rejects_the_whole_thing`
  vuelve a leer la fila y exige `status=SETTLED`, `voided_at is None` y el pago
  todavía ligado.

Es literalmente el cierre de **H-1 de 2b** (`register_supplier_payment_expense` /
`register_supplier_payment_reversal`) en el sentido opuesto: allá el egreso salía
del cajón y anularlo lo devolvía; acá el ingreso entra y deshacerlo lo saca.

### El renglón propio en el desglose

`compute_breakdown` (`app/shifts/service.py:226`) devuelve una clave nueva,
`delivery_cash_pending`, **fuera de `expected`**. No se le cambió el significado a
`expected` ni se agregó una segunda fórmula: es plata de la sede que todavía no
está en el cajón, y sumarla mentiría. `BreakdownOut`, `ShiftCurrentOut` y
`ShiftSummaryOut` lo publican; en los dos últimos como `int | None`, gateado por
el **mismo** predicado que el esperado (`_can_see_expected`) — `None`, no `0`,
porque «no te lo puedo mostrar» no es «no hay».

Y sobre todo lo publica **`review_close`** (`app/shifts/service.py:941`, el paso 2
del cierre a ciegas): ése es EL momento en que importa, porque quien acaba de
contar está por justificar una diferencia y el efectivo del domiciliario **no está
en el cajón**. Va al lado del esperado, fuera de la ecuación; hay un test que
recalcula la ecuación sin ese término y exige que siga cerrando.

La lista operativa que el responsable de caja sí necesita para recibir la plata
vive aparte, sin ese gate: `GET /delivery-settlements/pending`, agrupada por
domiciliario. **No es deuda de nadie** (CST art. 149): es efectivo de la sede que
falta entregar, y hay un test que barre el contrato buscando las palabras
`debt`/`deuda`/`owes`/`debe` para que nadie la renombre a eso.

---

## 3. La comisión se registra, no se resta

`app/channels/service.py:83`:

```python
def compute_commission(base_amount: int, commission_bp: int) -> int:
    return round_half_up(base_amount * commission_bp, 10_000)
```

- **Puntos básicos enteros** (100 = 1 %), nunca `float` — el precedente de 2b
  (`WasteKpiOut.ratio` pasó de `float` a `int` en basis points, y el cliente ya
  tiene `formatBasisPoints`).
- **Redondeo half-up, declarado y probado** en el borde exacto
  (`tests/channels/test_commission.py`): `1 × 5000 bp = 0,5 → 1` (un `//` daría
  `0`), `1 × 4999 bp → 0`, `3 × 5000 bp → 2`. Se usa `app.orders.money.round_half_up`,
  la misma función que redondea la propina desde 1b: una sola matemática.
- **Un solo lugar del backend multiplica por `commission_bp`**, y hay un test que
  lo cobra leyendo el **AST** de `app/channels/service.py` (no el texto: un
  comentario que nombra la fórmula no es una segunda implementación).
- Ninguna columna del dominio es `Float`/`Numeric`, y el test que lo verifica lee
  el **modelo**, no una lista a mano: la columna que agregue fase 3 cae sola.
- La comisión se calcula sobre la **venta**, sin propina: la propina no es venta
  del restaurante y la plataforma no comisiona plata ajena.
- `commission_bp` se **congela** en la fila (snapshot): cambiar el porcentaje
  mañana no reescribe la comisión de ayer, y la compensación usa el porcentaje
  congelado, no el de hoy.

**Los dos lugares distintos**: la venta vive en `payments` / `fiscal_documents` /
`platform_receivables.amount`; el costo vive en `platform_commissions.amount`.
Ninguna contamina a la otra.

---

## 4. La salida real del test del esperado de caja, pegada

```
$ cd backend && TMPDIR=/tmp/pt-backend-dinero-canales \
    python -m pytest tests/channels/test_platform_expected_cash.py -v -s

============================= test session starts ==============================
rootdir: /home/user/restaurante-sistema/backend
collecting ... collected 4 items

[esperado de caja] antes=200000 venta_por_plataforma=100000 despues=200000
tests/channels/test_platform_expected_cash.py::test_a_platform_sale_does_not_move_the_expected_cash_of_the_shift PASSED
tests/channels/test_platform_expected_cash.py::test_the_platform_payment_is_not_cash_and_lands_in_other PASSED
tests/channels/test_platform_expected_cash.py::test_the_sale_is_the_sale_and_the_commission_lives_somewhere_else PASSED
tests/channels/test_platform_expected_cash.py::test_the_platform_method_is_rejected_on_a_non_platform_channel PASSED

======================= 4 passed, 12 warnings in 13.27s ========================
```

Base fija $200.000, venta de $100.000 cobrada por plataforma, **esperado idéntico
antes y después**. El test imprime los tres números a propósito: leer un renglón
del checklist pasar sin ver las cifras no convence a nadie.

Y en el mismo archivo, el ejemplo textual del contrato: venta de $100.000 con 18 %
→ `PaymentOut.total == 100_000`, `amount_due == 100_000`, `Payment.amount == 100_000`,
`PlatformReceivable.amount == 100_000` **y** `PlatformCommission.amount == 18_000`,
en dos tablas distintas.

**Lo que confirmé leyendo, como pedía la misión**: `_OTHER_METHODS = {"platform",
"voucher", "other"}` ya existía en `app/shifts/hooks.py:59` desde 1b-1, así que
`platform` ya caía fuera de `.cash`. Lo que faltaba era todo lo demás: que
`platform` fuera un medio configurable de verdad, que no se pudiera usar fuera del
canal de plataforma, la cuenta por cobrar, y el test que lo prueba.

---

## 5. Qué se construyó, archivo por archivo

### Dominio nuevo `backend/app/channels/**`

| Archivo | Qué |
|---|---|
| `__init__.py` | Paso 0 |
| `models.py` | `DeliveryPlatform`, `PlatformReceivable`, `PlatformCommission`, `DeliverySettlement` + enums `LedgerEntryKind`, `PlatformReceivableStatus`, `DeliverySettlementStatus` |
| `schemas.py` | Contratos de entrada/salida. Sin `cost`/`margin`; la comisión sólo en `/admin/**` |
| `hooks.py` | **C2** `get_platform`, `list_active_platforms` |
| `service.py` | `compute_commission`, CRUD de plataformas con auditoría, `ensure_platform_payment_method`, `record_platform_sale`, `platform_summary`, `pending_delivery_payments`, `settle_delivery_cash`, `void_delivery_settlement`, `cancel_platform_sale` |
| `router.py` | 12 rutas (abajo) |
| `seed.py` | **C4-bis** `seed_channels` |

**Rutas** (todas detrás de su flag, con `400 FEATURE_DISABLED` probado encendida y
apagada):

`pos.platforms` — `GET/POST /admin/platforms`, `PATCH/DELETE /admin/platforms/{id}`,
`GET /admin/platforms/{id}/summary`, `GET /admin/platform-commissions`,
`GET /admin/platform-receivables`, `GET /device/platforms` (sin comisión: superficie
de dispositivo), `POST /admin/platform-cancellations`.

`pos.delivery` — `GET /delivery-settlements/pending`, `POST /delivery-settlements`,
`POST /delivery-settlements/{id}/void`, `GET /admin/delivery-settlements`.

### `backend/app/payments/**`

- `models.py`: cuatro columnas nuevas en `Payment`
  (`delivery_courier_employee_id`, `delivery_courier_employee_name`,
  `delivery_settlement_id`, `platform_id`) + tres índices.
- `schemas.py`: `DeliveryCashIn`; `PaymentIn` gana `platform_id` y `delivery`;
  `PaymentOut` gana `platform_commission`, `platform_receivable_id` y
  `delivery_cash_pending` — los tres `int | None`, **nunca restados** de `total`
  ni de `amount_due`.
- `service.py:383` `_resolve_channels`: las tres reglas que el POS no puede
  sortear — el medio `platform` **sólo** en canal `platform`
  (`400 PLATFORM_METHOD_WRONG_CHANNEL`), la plataforma resuelta por C2
  (`400 PLATFORM_NOT_FOUND`, nunca un id «0»), y `delivery` sólo en canal
  `delivery`. Todo **antes** del punto sin retorno.

### `backend/app/shifts/**`

- `models.py`: `CashMovementCause.DELIVERY_SETTLEMENT` (sin DDL, ver §7).
- `hooks.py`: `SalesTotals` con los cuatro campos nuevos; `get_sales_totals`
  reescrito; `register_delivery_settlement_income` / `_reversal` con el contrato
  del §2 escrito en el módulo.
- `service.py:226` `compute_breakdown`: **misma fórmula**, más la clave
  informativa. `service.py:658` `_SYSTEM_ONLY_MOVEMENT_CAUSES` (abajo).
  `service.py:1462` la etiqueta en español.
- `schemas.py` / `router.py`: el renglón publicado, gateado por `_can_see_expected`.

### `backend/alembic/versions/0014_channels_money.py`

`down_revision = "0013"` (y `0013`, de `backend-canales-comanda`, ya existe en el
árbol con `revision = "0013"`: la cadena cierra). Cuatro tablas + cuatro columnas
en `payments`. **Sin `batch_alter_table` ni `recreate`** en ninguna tabla
existente.

**Defecto real encontrado corriendo la cadena, no razonando sobre ella.** La
primera versión agregaba las columnas de `payments` con `ForeignKey`, y
`alembic upgrade head` murió en `0014`:

```
NotImplementedError: No support for ALTER of constraints in SQLite dialect.
Please refer to the batch mode feature ...
```

La salida que el propio mensaje propone —`batch_alter_table`, que copia y recrea
`payments`— es **exactamente** el DDL que `0011_purchases.py` dejó escrito como la
lección cara: recrear una tabla referenciada rompió la cadena contra Postgres real
con `DependentObjectsStillExist`, y acá `platform_receivables.payment_id` (que
creo yo, en esta misma migración) depende del índice de la clave primaria de
`payments`. Entre una FK declarativa y una cadena que corre en los dos motores,
manda la cadena: **las cuatro columnas quedaron `Integer` sin FK dura, en el DDL
y en el modelo**, con el precedente del repo (`reception_lines.stock_batch_id` en
`0011`, `StockMovement.preparation_id` en `0008`) y el motivo escrito en los dos
archivos. Las tablas **nuevas** sí llevan todas sus FK reales: `create_table` no
tiene esa limitación en ningún motor.

**Verificado de punta a punta** sobre una base SQLite propia bajo
`TMPDIR=/tmp/pt-backend-dinero-canales`:

- `alembic upgrade head` desde cero: `0001 → 0014`, **77 tablas de dominio**.
- Modelos contra DDL: **0 tablas faltantes, 0 sobrantes, 0 diferencias de
  columnas** (el mismo par de invariantes que corre `tests/audit`).
- Mis cuatro tablas presentes: `delivery_platforms`, `delivery_settlements`,
  `platform_receivables`, `platform_commissions`.
- `alembic downgrade base`: deja la base **vacía**, `[]`.

### Tests (todos nuevos)

`tests/channels/{conftest,test_commission,test_platform_expected_cash,test_delivery_settlement,test_platform_cancellation,test_platforms_admin,test_seed}.py`
y `tests/shifts/test_delivery_cash_apart.py`. **No toqué ningún test existente.**

---

## 6. Los renglones del checklist que este agente cierra

| Renglón | Test |
|---|---|
| Una venta por plataforma **no mueve el esperado** | `test_platform_expected_cash.py::test_a_platform_sale_does_not_move_the_expected_cash_of_the_shift` |
| El efectivo de domicilios se arquea **aparte** hasta liquidar | `test_delivery_settlement.py::test_delivery_cash_stays_out_of_the_expected_until_it_is_settled` + `tests/shifts/test_delivery_cash_apart.py` |
| Cancelar una venta de plataforma compensa la VENTA y **no genera merma**; el inventario **no se repone** | `test_platform_cancellation.py` (4 tests) |
| La comisión **se registra y no se resta** | `test_commission.py` + `test_platform_expected_cash.py::test_the_sale_is_the_sale_and_the_commission_lives_somewhere_else` |
| **Sin `float`** en comisiones | `test_commission.py::test_no_float_appears_in_the_money_columns_of_the_domain` (lee el modelo) |
| Flags encendida y apagada con `400 FEATURE_DISABLED` | `test_platforms_admin.py` (2 tests, 11 rutas) |
| Zona horaria: pedido de plataforma a las **00:30** sellado con el día del **turno** | `test_platforms_admin.py::test_a_platform_sale_at_00_30_is_sealed_with_the_business_day_of_the_shift` |
| Ninguna respuesta de dispositivo trae comisión | `test_platforms_admin.py::test_the_device_platform_list_never_shows_the_commission` |

Los demás renglones (precio por canal, cargo de domicilio como línea con impuesto,
inventario idéntico por los tres canales, `fired_at`, bump, KDS, 375/1024 px) son
de los otros agentes.

---

## 7. Decisiones declaradas

1. **El medio `platform` es configuración de sede, no código en `app/stores/**`.**
   `DEFAULT_PAYMENT_METHODS` vive en `app/stores/service.py`, que **no es mi
   territorio**. En vez de tocarlo, `channels` **siembra el dato** en
   `StoreSalesSettings.payment_methods` (`ensure_platform_payment_method`,
   idempotente) al crear la primera plataforma y desde el seed. A partir de ahí
   `app/payments/service.py:_payment_methods_by_code` lo valida como cualquier otro
   medio, **sin una sola rama especial**. Si el administrador lo deshabilita desde
   Configuración, crear otra plataforma **no** se lo vuelve a encender.

2. **`dian_code` del medio `platform` = `"ZZZ"`** (UNCL4461, «Otro»). No es
   efectivo (10), ni tarjeta (48), ni la transferencia (20) que la sede ya usa. El
   mapeo definitivo lo fija quien conecte el proveedor tecnológico real, que está
   fuera del alcance de 2c por decisión comercial. Queda como duda en §9.

3. **Agregar `DELIVERY_SETTLEMENT` al enum no requiere DDL.** `_enum` no pide
   `create_constraint`, así que `cash_movements.cause` es un `VARCHAR(32)` pelado
   en los dos motores. Está escrito en el modelo, en la migración y verificado
   contra la nota que `0011_purchases.py` dejó tras romper el CI con Postgres real.

4. **Nadie puede teclear a mano un movimiento con causa `delivery_settlement`**
   (`app/shifts/service.py:658`, `400 CAUSE_NOT_MANUAL`). Si se pudiera, habría dos
   puertas hacia el mismo efectivo y el cajón cuadraría el doble, sin que nada lo
   detectara hasta el conteo a ciegas. **`supplier_payment` (2b) tiene exactamente
   el mismo agujero y NO lo toqué**: cerrarlo cambiaría el comportamiento publicado
   de otro pedido sin su dueño presente. Va como observación en §9.

5. **El domiciliario se deriva de la comanda** y el gate `pos.delivery` **no** se
   exige cuando se deriva (sólo cuando el cliente manda el bloque explícito):
   apagar la flag con un domicilio abierto no puede dejar esa venta sin poder
   cobrarse.

6. **Tipos de nota según el documento original**: `pos_equivalent` → nota de
   **ajuste**, `invoice` → nota **crédito** (`ORIGINAL_TYPE_FOR_NOTE`, §8.3). Un
   `internal_receipt` (sede con `fiscal.dee_pos` apagada) **no es un documento
   fiscal** y no tiene rango de notas: la cancelación se registra igual, sin nota.
   No es un caso olvidado — emitir una nota contra algo que declara no ser factura
   sería peor. Igual con una comanda sin cobrar: se cancela y **tampoco** genera
   merma ni repone inventario, dicho en el código y probado.

7. **La propina de domicilio en efectivo sale de `tips_cash` siempre** (y se
   publica en `tips_delivery`/`tips_delivery_pending`). Meterla en el `tips_cash`
   del turno que liquida le atribuiría a ese turno una propina ganada en otro.

   > **CORREGIDO EN LA RONDA 2 (H-1).** Lo que decía acá —«el efectivo entra
   > completo (venta + propina) por el `INCOME` de la liquidación, así que el
   > esperado es exacto»— **razonaba al revés y era falso**. Entrar «completo» no
   > hacía exacto el esperado: lo hacía *distinto según el canal*. En todo el
   > resto del sistema la propina en efectivo **no mueve el esperado** (la fórmula
   > heredada de 1b sólo lee `.cash`, y la propina se salda al cierre por
   > `tips_cash_out`/`to_deposit`), así que sumar venta + propina en la
   > liquidación fabricaba una segunda matemática del esperado para la misma
   > plata. **Hoy el `INCOME` se escribe por la venta sola**, y la propina en
   > efectivo de un domicilio se trata exactamente igual que la de cualquier otra
   > venta. Ver §10.

8. **No toqué `app/fiscal/**`, y eso es el resultado, no un olvido.** Mi
   territorio lo permitía «sólo si la venta compensada lo exige», y no lo exigió:
   `issue_note` ya acepta `returns_to_stock=False` por línea desde la ronda 2 de
   2a, que es exactamente lo que la venta compensada necesita. Tampoco agregué
   tests en `tests/fiscal/`: el camino de la nota queda ejercitado por HTTP desde
   `tests/channels/test_platform_cancellation.py`, que además verifica en el
   LIBRO que no se escribió ningún `NOTE_RETURN`.

9. **`app/core/tax.py` no se tocó ni se leyó para calcular nada.** El cargo de
   domicilio es una LÍNEA que construye `backend-canales-comanda`; no hay ningún
   campo `delivery_fee` en mi territorio, y si aparece la tentación es señal de que
   se rompió el diseño.

---

## 8. Verificación

```bash
cd backend && TMPDIR=/tmp/pt-backend-dinero-canales \
  python -m pytest tests/channels tests/payments tests/shifts tests/fiscal -q
cd backend && python -m mypy app
```

```
# los cuatro directorios juntos
179 passed, 315 warnings in 518.91s (0:08:38)

# y de nuevo al cierre, después de los dos últimos cambios
# (el renglón en `review_close` y las FK de la migración):
tests/channels                       34 passed, 55 warnings in 83.13s
tests/shifts tests/payments tests/fiscal   146 passed, 263 warnings in 435.28s (0:07:15)
```

- `python -m mypy app` → **Success: no issues found in 120 source files** (corrido
  después del último cambio).
- **180 tests en verde en mi territorio, 0 rojos**, en dos corridas: la conjunta de
  los cuatro directorios y la de cierre.
- **39 tests nuevos**: 34 en `tests/channels` y 5 en
  `tests/shifts/test_delivery_cash_apart.py`. **No toqué ningún test existente.**
- **No corrí la suite completa**: cinco agentes trabajan en paralelo sobre el mismo
  árbol y N suites simultáneas se pisan.

> **Nota de la corrida**: dos veces el árbol quedó transitoriamente roto por
> ediciones ajenas en curso (`app/orders/models.py` con `sa.Enum(..., length=16)` y
> un miembro de 18 caracteres; después el miembro se renombró a `COMPENSATED`).
> No es un hallazgo: es construcción en paralelo. Lo anoto porque mi test de
> cancelación **dejó de afirmar sobre el nombre del miembro del enum** y pasó a
> afirmar sobre el efecto estable del contrato C4 (`platform_cancelled_at`,
> `platform_cancel_reason`, y «ya no es una venta viva»). Un test ajeno que fija a
> mano el nombre de un enum de otro dominio es el espejo frágil que 2b pagó cuatro
> veces.

---

## 9. Rojos y dudas

### ROJO PREDICHO — R-1: el invariante de migraciones fija `head == "0012"`

`backend/tests/audit/test_migration_invariants.py:399` afirma `version == "0012"` y
`len(tablas) == 72`. Con `0013` (de `backend-canales-comanda`) y `0014` (mía) eso
queda rojo.

**No lo esquivo y no lo toco**: `tests/audit/**` es territorio prohibido para mí, y
además el propio docstring del test dice que **hay que moverlo en cada pedido que
agregue una migración** («no es acotar un invariante: es moverle el poste al que
está atado»). Queda **discutido y acotado por escrito**: el dueño de `tests/audit/**`
tiene que dejar `head == "0014"` y el conteo en **77** —lo medí corriendo la
cadena completa, no estimándolo: 72 al cerrar 2b + 1 de `0013` + 4 mías
(`delivery_platforms`, `delivery_settlements`, `platform_receivables`,
`platform_commissions`)— y agregar esos cuatro nombres al conjunto que el test
enumera. Nadie más que él puede hacerlo.

### ROJO PREDICHO — R-2: el cruce backend→cliente de la causa de caja

Agregué `"delivery_settlement"` a `CashMovementCauseLiteral`
(`app/shifts/schemas.py:39`) y su etiqueta en `_MOVEMENT_CAUSE_LABEL`
(`app/shifts/service.py:1462`). **Del otro lado del espejo, que no es mi
territorio**, hace falta:

- `frontend/src/api/shifts.ts` → agregar `"delivery_settlement"` al tipo
  `CashMovementCause`.
- `frontend/src/features/shifts/MovementsPanel.tsx` → `CAUSE_LABEL` gana
  `delivery_settlement: "Liquidación de domicilios"` (sin «Egreso»/«Ingreso»:
  `kind` ya distingue).

Si no se hace, **`frontend/src/audit/purchases-counts.test.ts` se pone rojo a
propósito**: ese invariante LEE mi `Literal` y exige una etiqueta por cada valor.
Es H-8 y H-11 de 2b, el mismo cruce en los dos sentidos, **nombrado de entrada en
vez de descubierto después**. El invariante funciona; alguien tiene que cerrarlo
del lado del cliente.

### Dudas y observaciones

- **O-1 — `supplier_payment` se puede cargar a mano como movimiento de caja.**
  Mismo agujero que cerré para `delivery_settlement`, abierto desde 2b: un ingreso
  manual con esa causa duplicaría un reintegro real. No lo cerré porque cambiaría
  el comportamiento publicado de otro pedido. Es una línea:
  agregarlo a `_SYSTEM_ONLY_MOVEMENT_CAUSES` (`app/shifts/service.py:658`). Decide
  el dueño de la spec.
- **O-2 — el `dian_code` del medio `platform` es `"ZZZ"`.** Razonable y estándar,
  pero el mapeo definitivo lo fija quien conecte el proveedor tecnológico real. No
  hay forma de verificarlo acá y ése es exactamente el motivo por el que la
  conexión real queda fuera de 2c.
- **O-3 — CERRADO en la ronda 2.** Decía: «`ShiftTipsOut.cash_out` no incluye las
  propinas de domicilio ya liquidadas… es trabajo, no decisión». Se hizo ese
  trabajo, y de paso se corrigió la premisa: **la propina de domicilio no tiene
  que entrar a `cash_out`**, porque `cash_out` es lo que sale del cajón al cierre
  y esa propina no está en el cajón. Lo que faltaba era que **no desapareciera de
  la pantalla**, y eso ahora se publica en renglón propio y aditivo:
  `TipsByEmployeeOut.delivery` por persona, y `delivery_cash` /
  `delivery_cash_pending` en el cuerpo de `ShiftTipsOut`. Se ve, se sabe de quién
  es, y no se puede pagar del cajón hasta que entre. Ver §10.2.
- **O-4 — la conciliación de la cuenta por cobrar es fase 3 y no se construyó.**
  `PlatformReceivable.status` sólo toma `pending` y `reversed`. Está declarado en
  el modelo y en el router: nadie debe leer esa tabla como «lo que la plataforma ya
  pagó».
- **O-5 — la liquidación parcial acepta `payment_ids` explícitos**, y `null` ≠ `[]`:
  una lista vacía es un error de quien llama (`400`), no «liquidá todo». Está en el
  esquema y probado.
- **O-6 — `payments.platform_id` es `Integer` sin FK dura** a `delivery_platforms`
  (mismo patrón que `reception_lines.stock_batch_id` en `0011`). Quien lea la
  plataforma de un pago pasa por el CONTRATO C2. `delivery_settlement_id` **sí** es
  FK real: esa tabla nace en la misma migración.
- **Lo que este entorno no puede verificar**: Postgres real — el índice único
  parcial de `delivery_platforms` (SQLite lo acepta con `sqlite_where`, pero el
  comportamiento bajo carrera sólo lo prueba el motor real), los `409` literales
  de concurrencia, y los `SELECT FOR UPDATE`. La cadena de Alembic **sí** quedó
  verificada acá, en los dos sentidos, y el problema que encontró era real.

---

# 10. RONDA 2 — el cierre de los dos bloqueantes (H-1 y H-2)

Esta sección es de la segunda ronda. **Alcance cerrado**: sólo H-1 y H-2. H-3 a
H-6 son advertencias y no se abrió ningún frente por ellas.

La decisión de fondo la tomó el Maestro y no se negocia: **la matemática del
esperado es HEREDADA (1b) y ya está publicada por dos pedidos** —
`expected = base + sales.cash + incomes − expenses − pickups`
(`app/shifts/service.py:259`), con la propina en efectivo **fuera** del esperado y
saldándose por `tips_cash_out`/`to_deposit` (`app/shifts/service.py:1035`)—. 2c no
la reescribe en su última ronda: **es el código nuevo el que se acomoda al
invariante viejo**. Quedó descartada la alternativa de que `get_sales_totals`
empezara a sumar `tip_amount` a `.cash`.

Es exactamente la lección que el pedido traía escrita: *si un test heredado
prohíbe lo que este pedido existe para construir, se discute y se acota, nunca se
esquiva deformando un contrato publicado*. Acá el test heredado no prohibía nada
de lo que 2c vino a construir — **era mi código el que estaba deformando el
contrato publicado del esperado**, y lo escribí creyendo lo contrario. Lo digo
así de claro porque el §7.7 de la ronda 1 razonaba al revés y hay que poder leer
por qué.

## 10.1 H-1 — la liquidación mueve el esperado por la venta, nunca por la propina

**El defecto.** Una venta en efectivo de $100.000 con $10.000 de propina movía el
esperado del turno **+$100.000 por mostrador** y **+$110.000 por domicilio
liquidado**. Dos matemáticas del esperado para la misma plata. La consecuencia es
del conteo a ciegas: la diferencia del arqueo cambiaba exactamente por el valor de
la propina según el canal, y quien cuenta tenía que justificar con causa tipada
una diferencia que no existe.

**El arreglo, línea por línea:**

| Qué cambió | Archivo | Línea | Antes | Ahora |
|---|---|---|---|---|
| La IDA | `backend/app/channels/service.py` | **517** | `amount=total` (`amount + tip_amount`) | `amount=amount` |
| La VUELTA | `backend/app/channels/service.py` | **597** | `amount=total` (`settlement.amount + settlement.tip_amount`) | `amount=settlement.amount` |

La variable `total` desapareció de las dos funciones: ya no existe el número que
mezclaba las dos cosas, así que no se puede volver a usar por distracción.

**Lo que NO cambió, a propósito y por instrucción:**

- `DeliverySettlement.amount` y `.tip_amount` se siguen registrando por separado, y
  la respuesta del endpoint sigue trayendo `total = amount + tip_amount`
  (`app/channels/router.py:85`). **El domiciliario sigue entregando venta +
  propina y eso se sigue registrando.** Lo único que cambió es cuánto mueve el
  ESPERADO.
- `compute_breakdown` no se tocó. La línea 269
  (`delivery_cash_pending = delivery_cash_pending + tips_delivery_pending`) queda
  igual: es **informativa y es cierta** — el domiciliario sostiene venta y
  propina, y el renglón dice cuánta plata de la sede está fuera del cajón.
- No se tocó `to_deposit`, ni `tips_cash_out`, ni el cierre a ciegas.

**Los docstrings que contaban la historia vieja, corregidos** (son la explicación
que el próximo pedido va a leer, así que no alcanzaba con cambiar el número):

- `app/shifts/hooks.py::register_delivery_settlement_income` — dice ahora, textual:
  *el efectivo de domicilios entra al cajón por `incomes` sólo por el monto de la
  venta; la propina en efectivo del domicilio se trata igual que la propina en
  efectivo de cualquier otra venta — no mueve el esperado.*
- `app/shifts/hooks.py::register_delivery_settlement_reversal` — «espejo» quiere
  decir **el mismo monto que la ida**.
- `app/shifts/hooks.py::SalesTotals` — el párrafo nuevo «Ronda 2, cierre de H-1 —
  por cuánto mueve el esperado».
- `app/channels/service.py::settle_delivery_cash` y el docstring del módulo.

## 10.2 H-2 — una sola función decide el bolsillo de un `Payment`

**El defecto.** `GET /shifts/{id}/tips` respondía la misma pregunta con dos
fórmulas dentro del MISMO cuerpo: `by_method.cash`/`cash_out` salían de
`get_sales_totals().tips_cash` (que desde 2c excluye la propina de domicilio) y
`by_employee[*].cash` se recalculaba a mano en `app/shifts/tips.py` sin esa
exclusión. Con $10.000 de propina de mostrador y $10.000 de domicilio, el mismo
JSON decía `10.000` por método y `20.000` por empleado. Es propina de un empleado
(Ley 1935 de 2018, pasivo con el personal): el reparto por persona ofrecía plata
que `cash_out` no autoriza a sacar del cajón. **H-4 de 2b en su forma exacta**,
ahora dentro de una sola respuesta.

**La función única, publicada:**

```python
# backend/app/shifts/hooks.py:74
def payment_bucket(method: Any, courier_employee_id: int | None) -> str:
    """El único lugar del sistema que decide en qué bolsillo cae un cobro."""
    # -> "cash" | "card" | "transfer" | "other" | "delivery"
```

- `platform` / `voucher` / `other` colapsan en `"other"` (`_OTHER_METHODS`, que
  **sigue existiendo** con ese nombre en `hooks.py` porque un invariante del
  auditor lo lee por nombre).
- efectivo **con** `courier_employee_id` no nulo → `"delivery"`.
- un medio desconocido cae en `"other"` antes que romper el esperado del turno con
  un `KeyError`.
- **Lo que esta función no decide**: si un cobro de domicilio ya está liquidado.
  Eso se sigue derivando de `delivery_settlement_id`, aparte, porque es un hecho
  del cobro y no del bolsillo.

**Quién la llama ahora (los dos lados, ningún tercero clasificando a mano):**

| Llamador | Archivo | Línea |
|---|---|---|
| `get_sales_totals` | `backend/app/shifts/hooks.py` | **222** |
| `get_shift_tips` (`by_employee`) | `backend/app/shifts/tips.py` | **86** |

Hay un tercer clasificador en el repo, `app/shifts/activity_metrics.py:212-219`,
que **no** se tocó a propósito: no es una lectura del cajón sino de RR. HH., y
ruteárlo habría cambiado comportamiento publicado sin tener dónde publicarlo. Está
nombrado con archivo y línea en **O-8** (§10.7), no escondido.

El `_OTHER_METHODS` local de `app/shifts/tips.py` (línea 33 de la ronda 1) **se
borró**, y con él el reclasificado a mano del bucle de `by_employee`. El resultado
numérico de `.cash`/`.tips_cash`/`.delivery_cash`/`.tips_delivery` y sus
`_pending` **no cambió**: es refactor, no comportamiento — lo cobran los 99 tests
de `tests/channels` + `tests/shifts` que ya estaban en verde antes de tocar nada y
siguieron en verde después.

**El renglón aditivo, para que la propina de domicilio no desaparezca de la
pantalla** (cierre de mi propio O-3):

| Campo | Esquema | Línea | Qué es |
|---|---|---|---|
| `delivery: int = 0` | `TipsByEmployeeOut` | `app/shifts/schemas.py:538` | propina en efectivo de domicilio **por persona** |
| `delivery_cash: int = 0` | `ShiftTipsOut` | `app/shifts/schemas.py:554` | toda la del turno |
| `delivery_cash_pending: int = 0` | `ShiftTipsOut` | `app/shifts/schemas.py:555` | la que el domiciliario todavía no entregó |

Todo **entero**, jamás `float`, sin costo ni comisión (el operador no ve costos).
`total` de `TipsByEmployeeOut` ahora suma también `delivery`: es «cuánta propina
generó esta persona», no «cuánta se le puede pagar hoy» — lo que se puede pagar
del cajón lo dice `cash_out`, y esa plata todavía no está en el cajón.

**Es un agregado sin cruce de contrato**: `GET /shifts/{id}/tips` no tiene
consumidor en el frontend (verificado por el Maestro y confirmado acá con un grep
sobre `frontend/src`: no hay una sola referencia a `by_employee` ni a la ruta). No
se inventó ninguna ruta nueva ni se cambió ninguna existente. Los tres campos son
aditivos con default `0`.

## 10.3 Lo que vale ahora, billete por billete

```
by_method.cash == cash_out == sum(e.cash for e in by_employee)
```

y lo mismo para `card`, `transfer` y `other`. Probado bolsillo por bolsillo en
`tests/channels/test_tips_single_bucket.py::test_the_shift_tips_reading_counts_the_same_cash_tip_once`.

## 10.4 La salida real de los tests de esta ronda, pegada

```
$ cd backend && TMPDIR=/tmp/pt-backend-dinero-canales \
    python -m pytest tests/channels/test_expected_cash_parity.py \
                     tests/channels/test_tips_single_bucket.py -v -s
```

```
============================= test session starts ==============================
platform linux -- Python 3.11.15, pytest-9.1.1, pluggy-1.6.0
rootdir: /home/user/restaurante-sistema/backend
collecting ... collected 7 items

tests/channels/test_expected_cash_parity.py::test_the_same_cash_moves_the_expected_by_the_same_amount_through_both_channels
[esperado de caja] venta=100000 propina=10000 | mostrador: antes=200000 despues=300000 delta=100000 | domicilio liquidado: antes=300000 despues=400000 delta=100000
PASSED
tests/channels/test_expected_cash_parity.py::test_the_settlement_cash_movement_is_written_for_the_sale_alone PASSED
tests/channels/test_expected_cash_parity.py::test_undoing_a_settlement_leaves_the_expected_exactly_where_it_was
[ida y vuelta] antes=200000 despues_de_liquidar=300000 despues_de_deshacer=200000
PASSED
tests/channels/test_tips_single_bucket.py::test_the_shift_tips_reading_counts_the_same_cash_tip_once PASSED
tests/channels/test_tips_single_bucket.py::test_the_delivery_cash_tip_is_published_in_its_own_row_and_never_disappears PASSED
tests/channels/test_tips_single_bucket.py::test_payment_bucket_is_the_single_place_that_decides_the_pocket PASSED
tests/channels/test_tips_single_bucket.py::test_tips_by_employee_and_by_method_agree_with_no_delivery_at_all PASSED

======================= 7 passed, 17 warnings in 24.11s ========================
```

**Los dos caminos, con los MISMOS números, leidos del esperado real del turno:**

| Camino | Venta | Propina | Esperado antes | Esperado después | Delta |
|---|---:|---:|---:|---:|---:|
| Mostrador, efectivo | $100.000 | $10.000 | $200.000 | $300.000 | **+$100.000** |
| Domicilio propio, efectivo, liquidado | $100.000 | $10.000 | $300.000 | $400.000 | **+$100.000** |

Y la VUELTA: `antes=200000 → despues_de_liquidar=300000 → despues_de_deshacer=200000`.
El espejo devuelve exactamente lo que la ida trajo.

Antes de este arreglo la segunda fila decía **+$110.000**.

## 10.5 Tests nuevos de la ronda 2 (todos en mi territorio)

`backend/tests/channels/test_expected_cash_parity.py` — **nuevo**:

- `test_the_same_cash_moves_the_expected_by_the_same_amount_through_both_channels`
  — los MISMOS números por los dos caminos (venta $100.000 + propina $10.000):
  mostrador y domicilio liquidado mueven el esperado **exactamente +$100.000 los
  dos**. Para que las dos ventas sean *la misma venta* y no una comparación
  tramposa, la de domicilio es un plato de $94.000 **más el cargo de domicilio de
  $6.000 como LÍNEA** — el cargo es una línea con impuesto, nunca un campo aparte.
  Los números van en el mensaje del assert y además se imprimen.
- `test_the_settlement_cash_movement_is_written_for_the_sale_alone` — el
  `CashMovement` de la IDA mirado de cerca: `INCOME`, causa tipada, y `amount` = la
  venta sola.
- `test_undoing_a_settlement_leaves_the_expected_exactly_where_it_was` — **la
  VUELTA**: liquidar y deshacer deja el esperado donde estaba; ida y espejo tienen
  el mismo monto; el original queda vivo; y el renglón informativo vuelve a
  mostrar venta + propina pendientes.

`backend/tests/channels/test_tips_single_bucket.py` — **nuevo**:

- `test_the_shift_tips_reading_counts_the_same_cash_tip_once` — los cuatro
  bolsillos, `by_method` contra `by_employee`, más `cash_out`.
- `test_the_delivery_cash_tip_is_published_in_its_own_row_and_never_disappears` —
  la propina de domicilio se ve por persona y en el cuerpo, y **liquidar no la
  mueve a `cash`**.
- `test_payment_bucket_is_the_single_place_that_decides_the_pocket` — la función
  sola, incluido el medio desconocido que cae en `other` en vez de reventar.
- `test_tips_by_employee_and_by_method_agree_with_no_delivery_at_all` — sin un
  solo domicilio el cuerpo da exactamente lo que daba en 1b.

**No se tocó un solo test existente** (los 99 de `tests/channels` + `tests/shifts`
de la ronda 1 pasaron sin modificación: los que fijaban el monto del movimiento lo
hacían sobre cobros **sin propina**, donde venta y total coinciden, así que no
había nada que actualizar). **`tests/audit/**` y `frontend/src/audit/**` no se
tocaron: ni una línea.**

## 10.6 Verificación de la ronda 2

```bash
cd backend && TMPDIR=/tmp/pt-backend-dinero-canales \
  python -m pytest tests/channels tests/shifts tests/audit -q -p no:randomly
cd backend && python -m mypy app
```

```
4 failed, 528 passed, 900 warnings in 1510.86s (0:25:10)

FAILED tests/audit/test_channels_invariants.py::test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three
FAILED tests/audit/test_channels_invariants.py::test_a_delivery_order_never_publishes_a_courier_with_id_zero
FAILED tests/audit/test_channels_invariants.py::test_the_platform_of_a_payment_is_resolved_with_is_not_none_and_never_with_or
FAILED tests/audit/test_channels_invariants.py::test_no_business_invariant_of_2c_is_defended_with_a_bare_assert
```

```
$ python -m mypy app
Success: no issues found in 123 source files
```

**LOS DOS TESTS DEL AUDITOR QUE TENÍAN QUE PASAR SOLOS, PASARON SOLOS** — por el
arreglo, no por un test ablandado (`tests/audit/**` no se tocó: ni una línea):

| Test del auditor | Hallazgo | Resultado |
|---|---|---|
| `test_channels_money_invariants.py::test_the_same_cash_moves_the_expected_by_the_same_amount_whatever_channel_it_came_through` | **H-1** | **verde** |
| `test_channels_money_invariants.py::test_the_shift_tips_reading_counts_the_same_cash_tip_once` | **H-2** | **verde** |

Ninguno de los dos aparece en la lista de `FAILED`, y `tests/audit/test_channels_money_invariants.py`
quedó entero en verde.

**Los 4 rojos que quedan NO son de esta ronda y NO los causó este cambio.** Son,
uno a uno, los tests que el auditor escribió para **H-3, H-4, H-5 y H-6**, que son
**advertencias** y que el Maestro dejó explícitamente fuera del alcance de esta
ronda («no abras ningún otro frente»). Lo verifiqué línea por línea antes de
afirmarlo: los cuatro apuntan a código que **no toqué en esta ronda**
—`app/orders/service.py:457` y `:673-680` (que además tienen otro dueño y me están
prohibidos), `app/payments/service.py:421` y `app/channels/service.py:760`—,
mientras que mis ediciones de la ronda 2 caen en
`app/channels/service.py:{448-460, 503-521, 590-600}`, `app/shifts/hooks.py`,
`app/shifts/tips.py` y `app/shifts/schemas.py`.

Dos de los cuatro **sí son de mi territorio** y los dejo nombrados con archivo,
línea y arreglo exacto, para que quien abra esa ronda no tenga que volver a
buscarlos:

| Hallazgo | Archivo y línea | Dueño | El arreglo, en una línea |
|---|---|---|---|
| H-3 | `app/orders/service.py:673-680` | `backend-canales-comanda` | la lista `active_channels` tiene que gatear también `delivery` y `platform` |
| H-4 | `app/orders/service.py:457` | `backend-canales-comanda` | publicar `courier: null`, no `{id: 0, name: ""}` |
| **H-5** | **`app/payments/service.py:421`** | **este agente** | `getattr(order, "platform_id", None) or getattr(payload, ...)` → resolver con `is not None`, porque `0` no es ausencia |
| **H-6** | **`app/channels/service.py:760`** | **este agente** | el `assert not returned_ids` es un guardrail que **desaparece con `python -O`** y, si se cumple, sale como `500` en vez de la forma de error del proyecto → `AppError` tipado |

**No los arreglé, y es una decisión, no un olvido**: el alcance de esta ronda lo
cerró el Maestro en H-1 y H-2, y tocar dos archivos más por mi cuenta —uno de
ellos en el camino del cobro— es exactamente el tipo de frente extra que el
pedido me pidió no abrir. Los dos son de una línea cada uno y están medidos; que
entren o no en una ronda 3 lo decide quien conduce, no yo.

## 10.7 Rojos y dudas de la ronda 2

- **Ningún rojo nuevo por este cambio.** La corrida dejó `4 failed, 528 passed`, y
  los cuatro son los tests que el auditor escribió para **H-3/H-4/H-5/H-6**
  —advertencias, explícitamente fuera del alcance de esta ronda—, sobre código que
  no toqué. El detalle, con dueño y arreglo por cada uno, está en §10.6.
  `tests/audit/test_channels_money_invariants.py`, que es el archivo de los dos
  bloqueantes, quedó **entero en verde**.
- **R-1 sigue en pie** (el invariante de migraciones fija `head == "0012"`): no es
  de esta ronda y sigue siendo del dueño de `tests/audit/**`, con el número ya
  medido y escrito en §9.
- **R-2 sigue en pie** (la etiqueta `delivery_settlement` del lado del cliente):
  tampoco es de esta ronda.
- **O-7 (nueva, menor) — `ShiftTipsOut.delivery_cash` es propina, no venta.**
  El nombre viene de la instrucción de la ronda y se mantuvo literal, pero dentro
  de `ShiftTipsOut` **todo** es propina: `delivery_cash` es *la propina en efectivo
  de domicilios del turno*, no el efectivo de las ventas de domicilio (ése vive en
  `SalesTotals.delivery_cash` y en el `delivery_cash_pending` del desglose). Está
  documentado en el esquema y en `tips.py`. Si alguien va a consumirlo desde el
  cliente, conviene leer ese comentario antes de nombrar la columna en pantalla.
- **O-8 (nueva, encontrada al cerrar H-2 y NO tocada a propósito) — hay un TERCER
  lugar que clasifica un `Payment` por medio, y no es del cajón.**
  `app/shifts/activity_metrics.py:212-219` (`GET /admin/employees/{id}/activity`,
  «propinas que esta persona cobró») tiene su propio `_OTHER_TIP_METHODS`
  (línea 36) y arma sus propios cuatro bolsillos. **No lo cambié**, por dos
  razones y las dos importan:
  1. El alcance de esta ronda estaba cerrado en H-1 y H-2, y los puntos 5-8
     nombran `get_sales_totals` y `tips.py`. Abrir un tercer frente es
     exactamente lo que se me pidió no hacer.
  2. Ruteándolo por `payment_bucket` **cambiaría comportamiento publicado sin
     tener dónde publicarlo**: un cobro de domicilio daría `"delivery"`, que no
     es una clave de ese diccionario, y caería en `"other"` — una propina en
     efectivo se movería de `cash` a `other` en una pantalla de RR. HH. sin que
     nadie lo haya pedido. Sería el arreglo peor que el defecto.

  **Lo acoto, que es lo que corresponde**: esa lectura es *por empleado y por
  rango de fechas*, no del cajón de un turno, y responde «por qué medio cobró»,
  no «qué hay en la caja». Hoy una propina en efectivo de domicilio aparece ahí
  como `cash`, que para esa pregunta no es falso. Si el dueño de la spec quiere
  que también distinga el domicilio, es un renglón nuevo en su esquema más la
  llamada a `payment_bucket`, y entra como trabajo de fase 3 con su propio
  contrato de cliente. Lo dejo nombrado con archivo y línea para que no se
  descubra tarde, que es el error que 2b pagó cuatro veces.

- **Alcance de la afirmación «una sola función»**, dicho con precisión para que
  nadie lo lea de más: `payment_bucket` es el único lugar que decide el bolsillo
  **para el esperado del turno y para `GET /shifts/{id}/tips`** — los dos lados
  que se habían separado y que tocan la plata del cajón. `activity_metrics` sigue
  clasificando aparte (O-8), y está dicho.

- **O-1, O-2, O-4, O-5, O-6 sin cambios.** **O-3 queda CERRADO** (§9, reescrito).
- **H-3, H-4, H-5 y H-6 no se tocaron**: son advertencias y el alcance de esta
  ronda estaba cerrado en H-1 y H-2. No se abrió ningún frente por ellas.
