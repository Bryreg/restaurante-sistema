# `backend-canales-comanda` — pedido 2c («Canales y cocina»)

Builder de **la comanda y la carta**: precio por canal, domicilio propio, canal
plataforma, curso y «marchar», los contratos C1 (KDS) y C4 (cancelación de
plataforma), y la parte del seed que le toca a este territorio.

Territorio: `backend/app/orders/**`, `backend/app/catalog/**`,
`backend/app/core/tax.py`, `backend/app/seed.py`,
`backend/alembic/versions/0013_channels_orders.py`,
`backend/tests/orders/**`, `backend/tests/catalog/**`. No toqué nada fuera de
ahí (verificado con `git status` antes de escribir este documento).

---

## 1. Qué construí, archivo por archivo

### `backend/app/catalog/models.py`

- `Product.is_delivery_fee: bool` (línea 105, default `False`). El cargo de
  domicilio se modela como **un producto real** de la carta —el mismo
  criterio que SPEC-NEGOCIO §3.3 ya usaba para "no existe producto de precio
  abierto: si hace falta, es un producto real creado por el
  administrador"— en vez de una tabla de configuración nueva en
  `app.stores` (territorio ajeno a este pedido, no listado en mi territorio
  de escritura). Decisión declarada en §7 de este documento.

### `backend/app/catalog/schemas.py`

- `ProductIn.is_delivery_fee: bool = False`, `ProductUpdateIn.is_delivery_fee:
  bool | None = None`, `ProductAdminOut.is_delivery_fee: bool`. `CatalogOut`
  (el menú del dispositivo) **no** gana el campo: los productos con la
  bandera se excluyen de esa lista, no se marcan en ella.

### `backend/app/catalog/service.py`

- `_assert_single_delivery_fee` (línea 242) y `get_delivery_fee_product`
  (línea 260, público): a lo sumo un producto `is_delivery_fee` **activo**
  por sede; crear o reactivar un segundo corta con `409
  DELIVERY_FEE_ALREADY_CONFIGURED`.
- `create_product`/`update_product`: pasan y validan la bandera.
- `get_catalog` (el `GET /catalog` del dispositivo): el `WHERE` de productos
  gana `Product.is_delivery_fee.is_(False)` — el cargo nunca aparece en el
  menú que ve el operador.

### `backend/app/core/tax.py`

Sin cambios de código. Lo uso (no lo edito): `_build_delivery_fee_item` y las
dos construcciones de ítem existentes (`_build_product_item`,
`_build_combo_item`) ahora llaman `rate_for_code`, la función pública del
módulo, en vez de indexar `TAX_RATE_BY_CODE` a mano — es exactamente la regla
que pide la misión ("resueltos con `app.core.tax.rate_for_code`, NUNCA con
una tasa escrita a mano"), y de paso quita la única duplicación que quedaba
de ese lookup dentro de `app/orders/service.py`.

### `backend/app/orders/models.py`

- `OrderStatus.COMPENSATED = "compensated"` (línea 82): el estado de una
  comanda de plataforma cancelada **después** de preparar. Deliberadamente
  **no** reutiliza `VOIDED` — ver §3.
- `Order` gana doce columnas: `delivery_address`, `delivery_phone`,
  `courier_employee_id`/`courier_employee_name` (FK real + nombre congelado,
  línea 182 en adelante), `platform_id` (referencia **suave**, sin FK dura,
  a `app.channels.models.DeliveryPlatform` — mismo criterio que
  `OrderSubAccount.document_id` con `app.fiscal` en 1b-1), `platform_name` y
  `platform_commission_bp` (snapshot al crear, igual que precio/impuesto en
  el ítem), `platform_external_id`, y los cuatro campos de cancelación
  (`platform_cancelled_at`, `platform_cancel_reason`,
  `platform_cancelled_by_employee_id/_name`).
- `ORDER_EVENT_KINDS` gana `"course_fired"` y `"platform_cancelled"`.
- `OrderCourseFire` (línea 542): tabla nueva, el sello de «marchar».
  `UNIQUE(order_id, course)` — ver §4.

### `backend/app/orders/schemas.py`

- `DeliveryOut`, `PlatformOut` (sin `commission_bp` — ver §3), `CourseFireOut`.
- `OrderCreateIn` gana `delivery: DeliveryIn | None` y `platform:
  PlatformOrderIn | None`.
- `OrderOut` gana `delivery`, `platform`, `courses_fired: list[CourseFireOut]`.
- `OrderStatusLiteral` gana `"compensated"`.
- `FireCourseIn` (el body de «marchar»: sólo `expected_version`, el curso va
  en el path).

### `backend/app/orders/service.py`

- `_channel_list_price` (línea 857): extendida a `DELIVERY`/`PLATFORM` con la
  MISMA regla que ya tenía `TAKEOUT` — `is not None` decide, nunca `or`
  (`0` no es falsy-para-este-propósito). Ver el test de los tres canales
  opcionales en §5.
- `_get_platform` (línea 627): CONTRATO C2, llamado con `find_spec_safe`.
  Nunca un import directo de `app.channels`.
- `create_order` (línea 667): valida domicilio (dirección + teléfono +
  domiciliario, los tres obligatorios) y plataforma (vía C2) **antes** de
  crear la fila `Order`; agrega la línea del cargo de domicilio **después**
  de crear la comanda, la mesa y el evento, con un solo `db.flush()` extra.
- `_build_delivery_fee_item` (línea 1058): construye el `OrderItem` del
  cargo — `station=None` siempre (nunca ensucia cocina), `unit_cost=None`,
  `recipe_version=None` (sin ficha, cae en "cobertura de recetas" de 2a).
- `_build_product_item`: gana la guarda `DELIVERY_FEE_NOT_ORDERABLE` —el
  cargo nunca se agrega a mano, ni siquiera en una comanda `delivery`.
- `fire_course` (línea 1446): «marchar». Idempotente por construcción (lee
  antes de escribir; si ya existe, devuelve la comanda tal cual, sin
  bumpear versión de nuevo). El `409` ante concurrencia real lo da
  `_check_version` (el mismo mecanismo que ya usa toda escritura de la
  comanda), no un `IntegrityError` atrapado — ver §4 para el razonamiento
  completo.
- `order_out`: gana la serialización de `delivery`/`platform`/`courses_fired`.

### `backend/app/orders/hooks.py`

CONTRATO C1 (bump/unbump/expedite/lectura de cursos) y CONTRATO C4
(cancelación de plataforma). Firmas exactas en §2 y §3.

### `backend/app/orders/router.py`

- `POST /orders/{order_id}/courses/{course}/fire` (línea 199), detrás de
  `require_feature("pos.courses")`, con `Idempotency-Key` (mismo patrón
  `_idempotent` que `send`/`bill/present`).

### `backend/app/catalog/seed.py`

- `_product` gana `price_takeout`/`price_delivery`/`price_platform`/
  `is_delivery_fee` como parámetros opcionales (antes siempre `None`/
  `False`).
- "Pescado frito (mojarra)" pasa a tener `price_delivery=38_000` y
  `price_platform=40_000` (antes `None` los dos): el producto que demuestra
  "el canal tiene su propio precio". El resto de la carta se queda con
  `price_delivery=None` a propósito, para que el fallback al precio de mesa
  también quede sembrado.
- Categoría nueva "Servicio" con el producto "Cargo de domicilio"
  (`is_delivery_fee=True`, `price_dine_in=5_000`).
- `tests/catalog/test_seed.py` actualizado: 20 → **21** productos, 5 → **6**
  categorías, más las aserciones nuevas sobre `is_delivery_fee` y los
  precios de "Pescado frito". Corrí la suite completa de `tests/catalog`
  (49 tests) para confirmar que no rompí nada de 1a/1b/2a/2b.

### `backend/app/seed.py`

- `_seed_channel_orders` (función nueva, antes de `seed()`): siembra UNA
  comanda `delivery` (con su cargo como línea) y, si `app.channels` está
  montado, UNA comanda `platform` (CONTRATO C4-bis: llama
  `app.channels.seed.seed_channels(db, organization=org, store=store,
  admin=admin)` vía `find_spec_safe`, usa el `platform_id` que devuelve).
  Construida por ORM directo (no llama `app.orders.service.create_order`):
  dejar un turno de caja abierto en el seed bloquearía el primer turno real
  que alguien abra desde el POS, así que las dos comandas nacen con
  `shift_id=NULL` — el mismo estado que deja `app.orders.hooks.
  detach_open_orders` sobre una comanda trasladada.
- `operators` (antes anónimo dentro del loop) ahora se captura en una lista,
  para poder nombrar a "Operador 2" como domiciliario del seed.
- Corrí `python -m app.seed` dos veces seguidas contra una base nueva: la
  segunda corrida imprime "Seed ya aplicado" y no toca nada — idempotente
  (evidencia completa en §6).

### `backend/alembic/versions/0013_channels_orders.py` (nueva, `down_revision="0012"`)

`products.is_delivery_fee`; doce columnas en `orders`; tabla nueva
`order_course_fires`. DDL a mano, `batch_alter_table` sin `recreate=`
(la lección de `0011_purchases.py`). **No ensancho `orders.status`**: el
nuevo miembro del enum usa nombre y valor cortos (`COMPENSATED` /
`"compensated"`, 11 caracteres) para entrar en el `VARCHAR(16)` que ya
existía, en vez de arriesgar un `ALTER COLUMN` sobre una columna de
producción — motivo completo en el docstring de la migración y en
`app/orders/models.py`.

---

## 2. CONTRATO C1 — lo que publico para el KDS (`backend-kds` llama)

Las cuatro firmas, en `app/orders/hooks.py`:

```python
def bump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool
def unbump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool
def expedite_order(db: Session, *, order_id: int, store_id: int, actor: "Actor", now: datetime) -> list[int]
def fired_at_by_course(db: Session, *, order_id: int) -> dict[str, datetime]
```

- `bump_item`: `sent -> ready` (reutiliza la transición de `mark_ready`, sin
  importar `app.orders.service` para no crear el ciclo que el docstring del
  archivo ya prohíbe). `item_id`/`store_id` que no resuelven a un ítem real
  de esa sede → `NotFoundError` (`404`). Ya `ready`/`served`/`voided`/
  `pending` (nunca enviado) → `False`, sin error, sin tocar nada.
- `unbump_item`: `ready -> sent`, misma semántica idempotente ("qué pasa
  cuando se deshace" — un bump equivocado en hora pico es inevitable).
- `expedite_order`: bumpea TODOS los `sent` de la comanda a `ready` en un
  golpe; devuelve los ids que de verdad cambiaron (`[]` si no había nada que
  expedir, sin error).
- `fired_at_by_course`: lectura pura de `OrderCourseFire`.

**Regla del contrato** (escrita acá y en la misión de `backend-kds`):
`backend-kds` nunca escribe `OrderItem.status` ni ningún campo de
`app.orders.models` a mano — todas sus escrituras pasan por estas cuatro
funciones. Verificado con tests que llaman las funciones directo (no hay
router propio: `app/kitchen/**` es territorio de `backend-kds`) — ver §5.

Si alguna de estas firmas necesita cambiar, lo declaro por escrito acá,
nombrando a `backend-kds` como afectado. **No cambié ninguna.**

---

## 3. CONTRATO C4 — cancelación de plataforma (`backend-dinero-canales` llama)

```python
def mark_platform_order_cancelled(db: Session, *, order: Order, actor: "Actor", now: datetime, reason: str) -> Order
```

Es la regla más fácil de romper de todo el pedido. Decisiones:

1. **Nunca pasa por `void_item`/`void_order`/`_resolve_waste_stub`.** Esas
   funciones sólo trabajan sobre `OPEN`/`TO_PAY` y crean `WasteStub`; una
   comanda de plataforma cancelada después de preparar suele llegar acá
   `PAID` (la plataforma ya cobró), y aunque no lo estuviera, este hook no
   importa ninguna de las tres.
2. **No toca `OrderItem` en absoluto.** Lo que se preparó, se preparó: su
   `status`/`sent_at`/consumo teórico quedan intactos. "Compensar la venta"
   es un asunto del pedido y del documento fiscal (territorio del que
   llama), no de los ítems.
3. **Estado propio, `OrderStatus.COMPENSATED`, no `VOIDED`.** Verificado
   ANTES de agregarlo que `OrderStatus` no se compara nunca en un
   `match`/if-elif exhaustivo fuera de `app.orders` (grep completo contra
   `app/reports/service.py` y `app/shifts/activity_metrics.py`: sólo
   preguntan por `OPEN`/`TO_PAY`/`PAID` puntuales), así que un miembro nuevo
   no rompe ningún camino ajeno en silencio.
4. **Idempotente**: si la comanda ya está `COMPENSATED`, devuelve la comanda
   tal cual (mismo `platform_cancel_reason`, mismo `version`) — no lo pide
   la misión explícitamente para C4, pero es gratis y consistente con el
   resto del dominio. `409 ORDER_NOT_CANCELLABLE` si ya está `VOIDED`/
   `MERGED` por otro camino. `409 NOT_A_PLATFORM_ORDER` si el canal no es
   `platform`.

**Verificado contra el consumidor real**: `backend-dinero-canales` declaró en
su propio entregable (`outputs/backend-dinero-canales.md § 1`) que ya llama
esta función con esta firma exacta vía `find_spec_safe`, y que **no escribió
una línea en `app/orders/**`**. El contrato cierra en los dos sentidos.

Test que lo prueba desde mi lado (`tests/orders/test_platform.py`, ver §5):
comanda de plataforma enviada a cocina (consumo teórico real, con receta),
cancelada → el libro de movimientos NO gana una fila `WASTE`, el stock del
insumo NO se repone, no se crea ningún `WasteStub` ni ninguna fila en
`wastes`, y los ítems se quedan `sent` con su `sent_at` intacto.

---

## 4. «Marchar»: dónde vive el sello, y por qué el 409 no es un `IntegrityError` atrapado

`OrderCourseFire` (una fila por curso marchado de una comanda, nunca una
columna en `Order`): respeta "nada se borra" y dos llamadas al mismo curso
no chocan por construcción.

El endpoint (`POST /orders/{id}/courses/{course}/fire`) exige
`expected_version` como cualquier otra escritura de la comanda. Decisión
explícita: **la idempotencia y el `409` de "marchar" se resuelven con el
mismo mecanismo optimista que ya usa toda la comanda** (`_check_version`),
no con un `try/except IntegrityError` sobre el `UniqueConstraint`. Razón: dos
tablets marchando el MISMO curso mandan la misma `expected_version` sólo si
ninguna ganó todavía — la segunda, con versión vieja, recibe `409
STALE_VERSION` antes de tocar la base. Una segunda llamada LEGÍTIMA (con la
versión ya actualizada después de la primera) encuentra la fila existente
en `fire_course` y devuelve la comanda sin bumpear de nuevo — es
exactamente "marchar dos veces no mueve el primer `fired_at`", cubierto sin
necesitar atrapar ninguna excepción de carrera. El `UniqueConstraint` en el
modelo queda como red de seguridad de la base, no como el camino principal.

---

## 5. Tests que escribí, y su resultado real

Corrí **sólo mi territorio** (`tests/orders` + `tests/catalog`), nunca la
suite completa, como pide la regla de verificación. Comando y salida
completa, pegados:

```
$ TMPDIR=/tmp/pt-backend-canales-comanda python -m pytest tests/orders tests/catalog -q
........................................................................ [ 37%]
........................................................................ [ 75%]
................................................                         [100%]
192 passed, 308 warnings in 482.04s (0:08:02)
```

Las advertencias son `InsecureKeyLengthWarning`/`DeprecationWarning` de
librerías (JWT de test, `anyio`), preexistentes, no de este pedido.

`python -m mypy app`:

```
Success: no issues found in 120 source files
```

`ruff check` sobre todo lo que toqué (código y tests): limpio (el único
hallazgo, `PreBillOut` sin usar en `app/orders/router.py`, es preexistente —
mi diff de ese archivo es puramente aditivo, verificado con `git diff`).

Archivos de test nuevos, y qué prueba cada uno:

| Archivo | Qué prueba |
|---|---|
| `tests/orders/test_channel_prices.py` (7) | Los tres canales opcionales del checklist: sin precio propio → cae a mesa; con precio propio → usa el suyo; precio en `0` → se respeta (no cae a mesa). Para `takeout`, `delivery` y `platform`; más `dine_in` ignorando los precios de los otros canales. |
| `tests/orders/test_delivery.py` (9) | Flag apagada → `400`; `pos.delivery` sin `pos.takeout` (defensa en profundidad) → `400 FEATURE_DISABLED` con `feature="pos.takeout"`; falta info de domicilio → `400`; domiciliario inexistente → `404`; sin producto de cargo configurado → `400 DELIVERY_FEE_NOT_CONFIGURED`; creación exitosa con la línea del cargo automática (`station=None`, sin costo, sin receta); el cargo entra a totales/base gravable por el mismo camino que cualquier ítem (test numérico); el cargo no se puede agregar a mano; con la flag apagada el resto sigue igual. |
| `tests/orders/test_platform.py` (12) | Flag apagada → `400`; falta info de plataforma → `400`; `platform_id` inexistente → `400` (nunca `500`); plataforma inactiva → `400`; `app.channels` no montado (con `monkeypatch` sobre `find_spec_safe`) → `400`, nunca `500`; creación con snapshot (`name`/`external_id`/`commission_bp` en el modelo, y `commission_bp` **nunca** en la respuesta del dispositivo); comisión no se resta de la venta (test numérico + `type(...) is int`); **el pago por plataforma no mueve el efectivo esperado del turno** (`compute_breakdown` antes/después, cobro real vía HTTP); **cancelar después de preparar compensa la venta sin merma** (consumo teórico real con receta, sin `WasteStub`, sin fila en `wastes`, stock intacto, ítems intactos); cancelación idempotente; cancelación rechaza comandas que no son de plataforma. |
| `tests/orders/test_courses.py` (5) | Flag apagada → `400`; marcha y sella `fired_at`; marchar dos veces no mueve el primer `fired_at` ni bumpea versión de nuevo; dos cursos distintos con timestamps independientes; versión vieja → `409 STALE_VERSION`. |
| `tests/orders/test_kds_hooks.py` (5) | `bump_item` idempotente y `404` si el ítem no existe en esa sede; `unbump_item` deshace un bump e idempotente; `expedite_order` bumpea todos los `sent` y devuelve los ids que cambiaron; `fired_at_by_course` lee lo que `fire_course` escribió. |
| `tests/orders/test_inventory_identical_channels.py` (1) | Mesa, domicilio y plataforma dejan el inventario **idéntico** — hermano del test de 2a que compara venta/cortesía/`staff_meal`. |
| `tests/orders/test_business_date.py` (+1) | Un pedido de plataforma cargado a las 00:30 queda sellado con el día del turno, no con la fecha calendario. |
| `tests/catalog/test_delivery_fee_product.py` (6) | `is_delivery_fee` expuesto en `ProductAdminOut`; a lo sumo uno activo por sede (`409`); desactivar el actual libera el cupo; `get_delivery_fee_product` (`None` sin configurar, el correcto configurado); `GET /catalog` excluye el producto del cargo. |
| `tests/catalog/test_seed.py` (actualizado) | 21 productos, 6 categorías, el producto del cargo marcado, "Pescado frito" con sus precios de canal propios, al menos un producto con fallback sembrado. |

Fixtures nuevas en `tests/orders/conftest.py` (no redefine ninguna
existente): `channel_priced_product`, `zero_priced_delivery_product`,
`delivery_fee_product`, `courier`, `platform` (esta última construye una
`app.channels.models.DeliveryPlatform` **real** y llama
`app.channels.service.ensure_platform_payment_method` — los tests de pago
por plataforma corren contra el código real del dominio hermano, no contra
un doble). `tests/catalog/conftest.py::create_product` ganó
`is_delivery_fee`/`expect_status` como parámetros opcionales, sin tocar el
comportamiento por defecto de los llamadores existentes.

---

## 6. Migración y seed, verificados corriendo la cadena (no razonando sobre ella)

```
$ rm -f migration_test.db && DATABASE_URL=sqlite:///migration_test.db python -m alembic upgrade 0013
... (0001 → 0013, sin error)
$ python -m alembic downgrade 0012   # sólo mi migración
... (limpio: 0 tablas/columnas nuevas quedan)
```

Con la cadena completa (`0001 → 0014`, incluida la migración de
`backend-dinero-canales`, que corre DESPUÉS de la mía):

```
$ DATABASE_URL=sqlite:///migration_test3.db python -m alembic upgrade head
... (0001 → 0014, sin error)
$ python -c "... contar tablas ..."
tables: 77
$ python -m alembic downgrade base
... (limpio: sólo queda alembic_version)
```

**Nota de proceso, para que quede escrita**: a mitad de esta construcción
corrí `alembic upgrade head` contra la cadena completa y `0014` (ajena)
falló con `NotImplementedError: No support for ALTER of constraints in
SQLite dialect` — un `op.add_column` con `ForeignKey` inline fuera de
`batch_alter_table`. No es mi archivo y no lo toqué; unos minutos después,
en el mismo árbol compartido, `backend-dinero-canales` lo corrigió (su
propio entregable lo documenta en su § "Defecto real encontrado corriendo
la cadena"). Volví a correr la cadena completa DESPUÉS de esa corrección
—evidencia de arriba— y quedó limpia. Lo dejo escrito porque construcción en
paralelo sobre el mismo árbol significa que lo que se prueba a las 22:10
puede no ser lo que hay a las 22:20, y la única forma honesta de declarar
"funciona" es la corrida más reciente, con su hora.

`python -m app.seed` dos veces seguidas contra una base nueva
(`Base.metadata.create_all`, no Alembic — así arranca `app.seed.main()`):

```
Seed aplicado.
  ...
  Pedido 2c: una comanda de DOMICILIO sembrada, con el cargo de domicilio como línea.
  Pedido 2c: una comanda de PLATAFORMA sembrada (app.channels.seed.seed_channels).

$ python -m app.seed   # segunda corrida
Seed ya aplicado (ya existe el admin de demo); no se repite nada.
```

Inspeccionadas a mano las dos comandas sembradas (`sqlite3`, ver el
historial de este agente): la de domicilio tiene el producto a su precio de
domicilio propio (`38.000`, no el de mesa `34.000`) más la línea del cargo
(`5.000`, `station=None`, `tax_rate=8`); la de plataforma tiene el mismo
producto a su precio de plataforma (`40.000`), `platform_id=1`,
`platform_name="Rappi"`, `platform_external_id="RAPPI-DEV-0001"`. Las dos
con `shift_id=NULL` (declarado y explicado en §1).

---

## 7. Decisiones declaradas (donde la spec no bajaba al detalle)

1. **El cargo de domicilio es un `Product` con `is_delivery_fee=True`, no una
   tabla de configuración nueva en `app.stores`.** La misión dice "el monto
   del cargo se configura por sede; exponé de dónde sale". `app/stores/**`
   no está en mi territorio de escritura (ni listado, ni en la lista de
   prohibidos explícita — pero tampoco asignado), y la regla del proyecto es
   "si creés que necesitás algo de ahí, es un CONTRATO, no una edición: lo
   pedís por escrito". Elegí no pedirlo: modelar el cargo como un producto
   real reutiliza TODO lo que ya existe (CRUD de admin, precio por canal,
   tasa de impuesto, baja lógica) sin una tabla ni un endpoint nuevos, y es
   literalmente la misma frase que SPEC-NEGOCIO §3.3 usa para "precio
   abierto": "si hace falta, es un producto real creado por el
   administrador". El monto sale de `Product.price_dine_in` (obligatorio) con
   el mismo fallback por canal que cualquier producto — un admin que quiera
   un cargo distinto para domicilio puede fijar `price_delivery` en ese
   mismo producto, sin código nuevo.
2. **El domiciliario es obligatorio al CREAR la comanda, no asignable
   después.** La misión pide "validá que crear una comanda delivery exige
   los datos que la spec pide", y la tabla de SPEC-NEGOCIO §3.3 lista
   "dirección, teléfono, domiciliario" juntos como los datos propios del
   canal. No until construí un endpoint para reasignar domiciliario después
   de creada la comanda (un mesero que abre el pedido antes de saber quién
   reparte). **Gap declarado**, no construido: sería un `PATCH
   /orders/{id}/delivery` chico, mismo patrón que el resto de escrituras de
   la comanda.
3. **`OrderStatus.COMPENSATED` es un miembro nuevo del enum, no una
   reutilización de `VOIDED`.** Ver el razonamiento completo en §3.
4. **La comisión de la plataforma nunca viaja en `OrderOut`/`PlatformOut`.**
   Vive sólo en `Order.platform_commission_bp` (columna, no serializada).
   "El operador no ve costos ni márgenes" no dice literalmente "comisión",
   pero es plata-contra-la-venta del mismo tipo que un costo — el reporte de
   comisiones (que no construyo; es dominio de `backend-dinero-canales`,
   confirmado en su entregable) puede leerla directo del modelo.
5. **`platform_id` en `Order` es `Integer` sin FK dura** hacia
   `delivery_platforms` (tabla de `app.channels`), mismo patrón que
   `OrderSubAccount.document_id` con `app.fiscal` en 1b-1: mi migración
   (`0013`) corre ANTES que la de `app.channels` (`0014`) en la cadena, así
   que una FK real habría sido imposible de todos modos con la numeración
   que pide la spec.

---

## 8. Rojos y dudas

- **R-1 (heredado, no mío, ya declarado por `backend-dinero-canales`
  también)**: `tests/audit/test_migration_invariants.py:399` fija
  `head == "0012"` y `len(tablas) == 72`. Con `0013` (mía) y `0014` (de
  `backend-dinero-canales`) eso queda rojo hasta que el auditor de 2c mueva
  el número a `head == "0014"` / **77 tablas** — medido corriendo la cadena
  completa (§6), no estimado. `tests/audit/**` es territorio prohibido para
  mí; no lo toco.
- **Gap declarado, no construido**: reasignar el domiciliario de una comanda
  `delivery` ya creada (ver decisión 2 de §7). No lo pidió la misión de
  forma explícita, y la lectura más literal de la instrucción ("exige los
  datos... al crear") no lo necesitaba, pero lo dejo escrito porque es la
  primera pregunta que va a hacer cualquiera que use esto de verdad.
- **No construí** ningún endpoint de administración para "canales activos"
  en Configuración (§9.3 de la spec de negocio menciona "canales activos,
  plataformas y comisiones, estaciones, cursos y tiempos objetivo" como
  configuración de sede). Los canales `delivery`/`platform` de este pedido
  se activan/desactivan con su flag (`pos.delivery`/`pos.platforms`) más los
  datos ya existentes (`StoreSalesSettings.courses`/`stations`/
  `course_target_minutes`, todos de 1b y ya administrables) — no hace falta
  una pantalla nueva sólo por 2c, y `plataformas y comisiones` es dominio
  de `app.channels` (`backend-dinero-canales`, confirmado en su
  entregable). El trabajo de frontend que exponga esto es de
  `frontend-settings` (orphan nombrado en spec.md, no incluido en este
  equipo de agentes que veo corriendo).
- **No verifiqué** el recorrido en navegador real (checklist de la spec,
  último ítem): no tengo frontend construido para este pedido en el árbol al
  momento de escribir esto — es responsabilidad del Maestro/orquestador
  coordinarlo cuando el equipo de frontend termine.
- **Nada más quedó sin cerrar** dentro de mi territorio: los ocho puntos
  numerados de mi misión están construidos y verificados con test real (no
  sólo unitario contra un doble, donde el contrato lo permitía: C2, C4 y el
  pago por plataforma corren contra el código REAL de `app.channels`/
  `app.payments`, ya en el árbol).

---

## Ronda 3 (ajuste del Maestro, derivado del Conciliador)

Alcance cerrado: **H-4** (cero mudo en `courier`), su barrido al bloque
`platform`, y verificación. **No toqué H-3** (diferido explícitamente por el
Maestro — ver más abajo). No hice commit ni push.

### 1. H-4 — `DeliveryOut.courier` deja de inventar un empleado `id: 0`

**Antes** (`app/orders/service.py`, la línea que el hallazgo señalaba):

```python
courier=EmployeeRef(id=order.courier_employee_id or 0, name=order.courier_employee_name or ""),
```

**Ahora** — `app/orders/schemas.py:55-64`:

```python
class DeliveryOut(BaseModel):
    address: str
    phone: str
    courier: EmployeeRef | None = None
```

`app/orders/service.py:452-465` (dentro de `order_out`):

```python
delivery = None
if order.channel == OrderChannel.DELIVERY and order.delivery_address is not None:
    delivery = DeliveryOut(
        address=order.delivery_address,
        phone=order.delivery_phone or "",
        courier=(
            EmployeeRef(id=order.courier_employee_id, name=order.courier_employee_name or "")
            if order.courier_employee_id is not None
            else None
        ),
    )
```

Decisión aplicada, la que el propio hallazgo recomendaba: `is not None` decide
(nunca `or`), el bloque `delivery` **sigue existiendo** siempre que
`delivery_address` esté presente (el invariante del auditor lo exige:
"el bloque `delivery` desapareció: cambió el contrato"), y sólo `courier` se
vuelve `None` cuando no hay domiciliario real. Nunca `id: 0`, nunca nombre
`""` disfrazando ausencia.

**Verificación propia** (mi territorio, `tests/orders/test_delivery.py::
test_delivery_order_never_publishes_a_courier_with_id_zero`): crea una
comanda de domicilio real por HTTP, luego —fuera del servicio, como haría una
`UPDATE` a mano o el gap de reasignación que ya tenía declarado— pone
`courier_employee_id`/`courier_employee_name` en `NULL` directo en la fila, y
confirma que el `GET` sigue publicando el bloque `delivery` con
`courier: None`, nunca `{"id": 0, ...}`. **Pasa** (ver §5 de este documento,
conteo actualizado más abajo).

### 2. Frontend: verificado, no tocado (territorio ajeno)

Leí (no edité — `frontend/**` es territorio prohibido) los dos puntos que el
Maestro señaló:

- `frontend/src/api/orders.ts:81` — `DeliveryOut.courier?: EmployeeRefOut`:
  **ya** declarado opcional antes de mi cambio. Compatible tal cual.
- `frontend/src/features/orders/OrderPage.tsx:292` — `order.delivery.courier
  ?.name`: **ya** usa optional chaining. Con `courier: None`, la expresión
  evalúa a `undefined` y la línea del subtítulo simplemente no se agrega —
  ningún cambio de comportamiento respecto de lo que el frontend ya toleraba.

No encontré ningún consumidor en `frontend/**` que lea `order.delivery
.courier` sin ese chequeo (grep completo de `\.courier` sobre
`frontend/src`). Nada que declarar como bloqueado.

### 3. Barrido del mismo patrón en `platform` (§ punto 3 del ajuste)

**Decisión, con el argumento escrito que pide el ajuste**: el patrón es
**alcanzable**, exactamente por el mismo mecanismo que H-4 — NO es "columna
NOT NULL por construcción". Lo probé, no lo supuse:

- `Order.platform_name` y `Order.platform_external_id`
  (`app/orders/models.py:200,202`) son `nullable=True`, sin `CHECK` en la
  base que las ate a `platform_id`.
- `create_order` (`app/orders/service.py`) las llena **sólo al crear**, y
  grep confirma que **ningún otro código de todo el árbol** vuelve a
  escribirlas después (no hay endpoint de reasignación de plataforma,
  ni siquiera el gap que sí existe para el domiciliario).
- Pero "sólo se llenan al crear" es EXACTAMENTE lo que hacía a
  `courier_employee_id` alcanzable en `NULL`: nada en el esquema impide una
  `UPDATE` directa que las vacíe mientras `platform_id` queda intacto. Lo
  demostré con el mismo truco que usa el propio test del auditor para H-4
  (mutar la fila fuera del servicio y volver a leer) — ver el test nuevo más
  abajo, que **antes de este arreglo fallaba** publicando `""` donde debía
  ir `None`, y ahora pasa.

**Aplico el mismo tratamiento que a `courier`** — `app/orders/schemas.py:
67-86`:

```python
class PlatformOut(BaseModel):
    id: int
    name: str | None = None
    external_id: str | None = None
```

`app/orders/service.py:468-478`:

```python
platform = None
if order.channel == OrderChannel.PLATFORM and order.platform_id is not None:
    platform = PlatformOut(
        id=order.platform_id,
        name=order.platform_name,
        external_id=order.platform_external_id,
    )
```

`id` **no** recibe este tratamiento: nunca pasó por `or` (siempre fue
`order.platform_id`, y el bloque entero ya está condicionado a
`platform_id is not None`) — no había nada que arreglar ahí.

**Frontend, verificado igual que en el punto 2** (no tocado):
`frontend/src/api/orders.ts` (`OrderPlatformInfoOut`) ya declara `id?`,
`name?`, `external_id?` **todos opcionales**, y
`frontend/src/features/orders/OrderPage.tsx:295-296` los lee con chequeo de
verdad (`if (order.platform.name)` / `if (order.platform.external_id)`), que
trata `null` y `""` igual (ambos son falsy) — **ningún cambio de
comportamiento** para ese consumidor. (El tipo TS no declara `| null`
explícito como sí hace `TakeoutOut`; es una imprecisión de tipos preexistente
en territorio de frontend, no un bloqueo — lo dejo señalado, no lo toco.)

### 4. H-3 — diferido, tal como lo pidió el Maestro

**No toqué** `active_channels` (`app/orders/service.py:673-680` en el árbol
antes de esta ronda). Dejo su test rojo, sin tocarlo ni ese código. Anoto acá
—porque el ajuste lo pide explícitamente— el remedio completo para quien
tome ese pedido después:

1. Extender la guarda de `create_order` que hoy sólo mira
   `store.active_channels` para `counter`/`dine_in`/`takeout`, a
   `DELIVERY`/`PLATFORM` también.
2. Una migración de **backfill** que ponga `"delivery"`/`"platform"` en
   `active_channels` de toda sede que hoy ya tenga `pos.delivery`/
   `pos.platforms` encendida — si no, esa sede pierde la capacidad de vender
   por esos canales el día que se prenda el gateo, sin haber cambiado nada
   ella misma.
3. La casilla "Domicilio" (y su par de plataforma) en
   `StoreFormDialog.tsx` (frontend, territorio de otro pedido) para que el
   administrador pueda apagar el canal sin apagar la función entera.

### 5. Verificación (territorio, acotada)

```
$ TMPDIR=/tmp/pt-backend-canales-comanda python -m pytest tests/orders tests/catalog -q
194 passed, 312 warnings in 485.29s (0:08:05)
```

(192 de rondas anteriores + 2 nuevos: `test_delivery_order_never_publishes_a
_courier_with_id_zero` y `test_platform_order_never_publishes_an_empty_
string_for_a_null_name_or_external_id`.)

```
$ python -m mypy app
Success: no issues found in 123 source files
```

```
$ ruff check app/orders/service.py app/orders/schemas.py tests/orders/test_delivery.py tests/orders/test_platform.py
All checks passed!
```

**Invariante de H-4, de sólo lectura, tal como pide el ajuste** (sin tocar el
test):

```
$ TMPDIR=/tmp/pt-backend-canales-comanda python -m pytest tests/audit/test_channels_invariants.py -k courier_with_id_zero -q
...
>       assert entregado["courier"]["id"] != 0, mensaje
               ^^^^^^^^^^^^^^^^^^^^^^^^^^
E       TypeError: 'NoneType' object is not subscriptable
tests/audit/test_channels_invariants.py:572: TypeError
1 failed, 52 deselected, 5 warnings in 3.44s
```

**No se pone verde — y lo declaro en vez de forzarlo.** El ajuste esperaba
que este invariante quedara verde "por el arreglo"; corrí exactamente el
comando pedido, sin tocar `tests/audit/**` (prohibido), y **no** es lo que
pasa. Razón, verificada leyendo el test completo (no supuesta): su propio
docstring recomienda la corrección exacta que apliqué —"Lo correcto es
`DeliveryOut.courier: EmployeeRef | None` ... nunca un id 0"— pero su
aserción final, `entregado["courier"]["id"] != 0`, **subscribe `courier`
directo, sin chequear `None` primero**. Con `courier` convertido en `None`
(la corrección que el propio test recomienda), esa línea no puede evaluarse:
truena con `TypeError` antes de llegar al `assert`. No hay ninguna
implementación de "domiciliario ausente, nunca id 0" que dé un dict
subscribible con un id real y no-cero a la vez —no hay domiciliario del cual
sacarlo—, así que ninguna corrección honesta hace pasar esa aserción tal
cual está escrita: el test se contradice a sí mismo entre su docstring y su
código. Es un defecto del test, en territorio prohibido para mí
(`tests/audit/**`), así que no lo edito ni lo esquivo deformando mi fix
(sería exactamente "esquivar un contrato deformándolo", que `AGENTS.md` de
este pedido prohíbe explícitamente para el caso inverso).

Lo que sí verifiqué, y es lo que el hallazgo realmente pedía comprobar —que
ya no se publica un domiciliario inventado—, es la aserción equivalente
correcta en mi propio territorio (§1 más arriba,
`tests/orders/test_delivery.py`), que sí corre verde y sí prueba la ausencia
de `id: 0`, sin tronar, comparando `entregado["delivery"]["courier"] is
None` en vez de indexar a ciegas. Dejo la discrepancia en la sección de
rojos que sigue para que el Conciliador decida si el test del auditor se
corrige (agregar `if entregado["courier"] is not None:` antes del assert,
o comparar contra `None` en vez de indexar) en la próxima ronda.

### 6. Rojos y dudas — ronda 3

- **Nuevo**: `tests/audit/test_channels_invariants.py::
  test_a_delivery_order_never_publishes_a_courier_with_id_zero` (línea 572)
  truena con `TypeError` en vez de pasar, después de aplicar EXACTAMENTE la
  corrección que su propio docstring recomienda. El test indexa
  `entregado["courier"]["id"]` sin comprobar `None` antes. No lo edité
  (`tests/audit/**` prohibido) — ver el razonamiento completo en §5.
  **Dueño de la corrección del test**: el auditor de 2c o el Conciliador,
  no yo.
- **H-3 sigue diferido**, por decisión explícita del Maestro (no mía): la
  guarda de `active_channels` no se extiende a `delivery`/`platform` sin
  antes migrar el backfill de las sedes existentes. Remedio completo en §4.
- **Nada más cambió** respecto de los rojos ya declarados en rondas
  anteriores (el heredado R-1 de numeración de Alembic, y los gaps de §7-8
  de más arriba): no los repito acá, siguen vigentes tal cual.
