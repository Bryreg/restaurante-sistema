# ENTREGA — Pedido 2b: compras, lotes, conteos a ciegas, varianza y food cost real

**Maestro orquestador.** Base del pedido: `8116135`. Equipo: 6 agentes, 2 rondas.
Trabajo commiteado hasta `7e112af` más el ajuste de ronda 2 del auditor todavía
sin commitear (tres docstrings y su propio informe).

**Veredicto en una línea: el producto que 2b existía para construir está
construido y verificado contra el sistema corriendo; la suite completa termina
en 4 rojos de backend y 1 de frontend, y de esos cinco sólo dos son los que el
equipo declaró — los otros tres los encontró esta corrida final y ninguno es un
defecto de producto, pero los tres rompen el CI hoy.**

| | Resultado |
|---|---|
| Backend `pytest` (completa, una corrida, árbol quieto) | **4 failed, 966 passed** — 2805,76 s (46:45) |
| Backend `mypy app` | **Success: no issues found in 113 source files** |
| Frontend `npm run typecheck` | **limpio** (exit 0, sin salida) |
| Frontend `npm run test` (1.ª) | **2 failed, 404 passed** (406, 89 archivos) |
| Frontend `npm run test` (2.ª) | **1 failed, 405 passed** — un rojo de la 1.ª **no reprodujo** |
| Frontend `npm run build` | **OK**, 2564 módulos, 2,49 s |
| Alembic desde cero | `0001 → 0012`, **73 tablas** (72 + `alembic_version`) |
| `python -m app.seed` | corre, **idempotente** a la segunda |
| OpenAPI de la app **real** | **0 `Duplicate Operation ID`**, 154 rutas |

---

## 1. El equipo que armé, y por qué

El pedido tenía seis dimensiones. **Las corté por territorio de ESCRITURA
disjunto, no por capa** — la lección cara de 1b-2 y la que funcionó en 2a.

| Agente | Modelo | Territorio |
|---|---|---|
| `backend-compras` | sonnet | `app/purchases/**` (dominio nuevo), `app/shifts/**`, `app/main.py`, `app/core/models_registry.py` |
| `backend-inventario-espejo` | sonnet | `app/inventory/**`, `app/core/quantity.py`, `app/seed.py`, `tests/conftest.py`, `tests/core/**` |
| `backend-lectura-contrato` | sonnet | `app/orders/**`, `app/reports/**`, `app/stores/router.py`, los routers con `format` a medias |
| `frontend-compras` | sonnet | `features/purchases/**`, `app/router.tsx`, la navegación del admin |
| `frontend-inventario-conteos` | sonnet | `features/inventory/**`, `features/settings/**`, `features/reports/**` |
| `auditor-costos-2b` | **opus** | `tests/audit/**`, `teststs/payments/test_documents.py`, `frontend/src/audit/**` |

**Por qué inventario es un solo dueño y no dos.** `models.py`/`schemas.py`/
`router.py`/`service.py` de `inventory` no se pueden repartir por funcionalidad:
partirlo entre «lotes» y «conteos» garantizaba conflicto de escritura en los
mismos cuatro archivos. Es el agente más grande del reparto a propósito.

**Por qué opus sólo en el auditor.** Los cinco constructores trabajan contra un
contrato ya escrito; el auditor es el único que tiene que razonar contra código
ajeno para romperlo. En 2a esa apuesta devolvió ocho de los nueve rojos. En 2b
devolvió los diez hallazgos de la ronda 1, los dos bloqueantes incluidos.

### Las tres decisiones de arquitectura que borraron territorio compartido antes de que existiera

Es el mecanismo que dejó a 2a sin un solo conflicto de escritura, y volvió a
funcionar: **ningún agente pisó el archivo de otro en ninguna de las dos rondas.**

1. **`stock_batch` vive en `app/inventory/models.py`, no en `purchases`.** La
   recepción crea lotes llamando a un hook de `inventory`. Resultado:
   `resolve_ingredient_cost` calcula promedio ponderado y última compra sin
   importar nada de `purchases`, y los cinco escalones de costo quedan enteros
   dentro de un dominio y un dueño.
2. **El promedio ponderado se DERIVA de los lotes desde el último conteo
   completo aplicado; no existe columna `weighted_average_cost`.** Verificado:
   no existe esa columna en el árbol (`app/inventory/hooks.py:633`,
   `weighted_average_cost_micros`, es una función).
3. **Los umbrales de varianza van en `app/inventory/`, no en `app/stores/**`.**
   Eso sacó del reparto el modelo compartido donde 1b-2 dejó
   `invoice_threshold_uvt` escrito a medias en tres capas.

### Qué salió bien del reparto, y qué no

**Los huérfanos nombrados de entrada no fallaron: ninguno de los once.**
`app/seed.py`, `app/inventory/hooks.py`, `app/core/quantity.py`,
`app/reports/schemas.py`, `app/shifts/**`, `frontend/src/features/settings/**`,
`frontend/src/app/router.tsx` y los que agregué yo (`app/main.py`,
`app/core/models_registry.py`, `tests/conftest.py`, `app/orders/**`) están todos
cubiertos.

**Lo que falló es el CRUCE entre dos dueños, no la falta de uno.** Los cinco
hallazgos de cruce de la ronda 1 (H-0, H-1, H-2, H-4, H-8) son, los cinco, «la
mitad de ida construida sin la mitad de vuelta». El caso más elocuente es H-0:
el dueño de `inventory` agregó la causa nueva al **modelo** porque la spec se la
pidió, el dueño de `purchases` la **produjo** porque la spec se la pidió, y
**nadie era dueño del `Literal` publicado** — que vive en `inventory` pero sólo
se rompe cuando `purchases` escribe.

**La regla para el próximo reparto, y esta vez con número:** cuando una
capacidad cruza dos dominios, el reparto tiene que nombrar el **CONTRATO** —
quién publica, quién llama, y **qué pasa cuando se deshace** — no sólo los
archivos. H-8 (el backend *agregó* una causa y el cliente no tenía etiqueta) y
H-11 (el backend *quitó* una causa y el cliente dejó la etiqueta) son el mismo
cruce, en los dos sentidos, en dos rondas seguidas, con dueños distintos, y el
typecheck no vio ninguno de los dos.

---

## 2. Qué construyó cada agente

25.447 líneas agregadas, 185 borradas, 135 archivos.

### `backend-compras` — dominio nuevo `purchases` (2.128 líneas en 7 archivos)

`app/purchases/{models,schemas,service,router,hooks,seed}.py`, migración
`alembic/versions/0011_purchases.py` (`suppliers`, `receptions`,
`reception_lines`, `payables`, `purchase_payments`).

- Proveedores canónicos con NIT único por sede (índice parcial), baja lógica,
  confiabilidad (`recibido ÷ facturado`, % con factura, deriva de precio).
- `POST /receptions` con `Idempotency-Key`: en **una sola transacción** un
  `record_movement(cause=purchase)` por línea, un `stock_batch` por línea con
  vencimiento y costo, y un `payable` en `pending_review`.
- **El IVA bajo INC entra al costo** (`service.py`, §4.1): `tax_amount` se
  reparte proporcional a `qty_invoiced_base`; bajo IVA (franquicia) queda en la
  línea y nunca en `final_unit_cost_micros`. Toda la aritmética entera.
- Las dos guardas de tecleo que **preguntan y nunca corrigen**:
  `409 PRICE_LOOKS_LIKE_PACKAGE`, `409 PRICE_JUMP`, que se limpian con
  `confirm_price: true` y registran quién confirmó.
- **El saldo se deriva**: verificado en el árbol, no existe columna `balance`
  (`app/purchases/models.py:236`); `payable_balance` suma los pagos vivos.
  Confirmado corriendo: cuenta de $500.000 con un pago de $250.000 →
  `balance: 250000`.
- `app/shifts/**`: causa `SUPPLIER_PAYMENT` nueva y
  `register_supplier_payment_expense` — el pago en efectivo escribe el egreso
  del turno en la misma transacción; sin turno abierto, `409 NO_OPEN_SHIFT` y el
  pago no queda.
- **Ronda 2 (H-1)**: `void_payment` (`service.py:779-823`) compensa el egreso
  con `app/shifts/hooks.py:214::register_supplier_payment_reversal`
  (`kind=INCOME`, causa tipada `SUPPLIER_PAYMENT`, en el turno abierto al
  anular), y sin turno abierto rechaza la anulación completa. El `CashMovement`
  original queda vivo: nada financiero se borra.

### `backend-inventario-espejo` — el libro mirándose al espejo (2.270 líneas)

`app/inventory/{models,schemas,service,router,hooks,seed}.py`, migración
`0012_counts_lots.py` (`stock_batches`, `stock_counts`, `stock_count_lines`,
`store_inventory_settings`).

- **Lotes con FEFO declarado por escrito**: vencimiento primero, recepción para
  desempatar, sin vencimiento al final. El gancho vive **dentro** de
  `record_movement` (`hooks.py::_maybe_consume_fefo`), así que ninguna salida lo
  puede esquivar.
- **Conteos a ciegas**: `CountLineOut` (`schemas.py:295`) no tiene ni un campo de
  stock teórico, ni diferencia, ni sugerido — `previous_qty_counted` es la única
  referencia. No existe ninguna ruta «todo coincide».
- **Aplicar usa el instante del conteo**, no el de aplicar: `contado + (entradas
  − salidas desde el instante del conteo)`, con `409 COUNT_ALREADY_APPLIED`.
- **Los cinco escalones de costo**: `official → weighted_average → last_purchase
  → estimated → none`, con el promedio derivado desde el último conteo completo.
- Varianza con semáforo configurable por sede, food cost real sólo entre dos
  conteos completos consecutivos, salud del control.
- Deuda de 2a cerrada: `WasteKpiOut.ratio` pasó de `float` a `int` en puntos
  básicos; una sola escala de cantidad publicada (`format_qty_base`).
- `app/seed.py` + `app/inventory/seed.py`: **dos** conteos completos aplicados y
  consecutivos con una compra en el medio (uno solo dejaría el food cost real
  `null` para siempre).
- **Ronda 2**: H-0 (una línea en `schemas.py:26`), H-3 (sacó
  `VOID_AFTER_SEND` del enum), H-4 (consolidó la matemática en
  `hooks.py:729::inventory_staleness` con `INVENTORY_STALE_DAYS` como única
  constante), H-5 (`service.py:1202-1205`: sin uso teórico, faltante → `red`,
  sobrante → `yellow`, cero → `green`).

### `backend-lectura-contrato` — la lectura agregada, «Hoy» y el contrato a medias

- `GET /admin/orders/{id}/consumption` (`app/orders/router.py:326`): la
  corrección a §5.3 hecha lectura — un renglón por insumo sumando las filas por
  ítem, con el costo **congelado** del libro y `SALE + NOTE_RETURN`. El libro
  sigue guardando una fila por ítem.
- «Hoy» gana lotes por vencer/vencidos con stock, cuentas por pagar vencidas y
  pendientes de revisión, e «inventario no confiable». Las cuatro respetan
  módulo montado **y** flag encendida, y `null` nunca es `false` mudo.
- **17 endpoints en 10 routers** ganaron `format` en su firma. **Declaró la
  discrepancia en vez de tragársela**: la spec decía «cinco», su misión decía
  «19», el barrido de AST da **17**. El auditor, contando distinto (endpoints
  que *ganaron* la declaración en este pedido, incluidos los de otros
  territorios), da **21** sobre 29 que sirven CSV. El test cuenta solo, así que
  la cifra deja de discutirse de memoria.
- Escala unificada en `app/reports/schemas.py`: `qty_base`/`min_stock` pasan de
  `int` en milésimas crudas a texto decimal.
- **Ronda 2**: H-2 (borró el duplicado de `app.inventory` y retipó), H-4 (su
  mitad: `_inventory_reliability` ya no calcula, lee el hook).

### `frontend-compras` — Admin → Compras (3.277 líneas en 23 archivos)

`features/purchases/**` con tres pestañas (Proveedores, Recepciones, Cuentas por
pagar), `router.tsx` y `AdminLayout.tsx` cableados y **verificados contra el
router real, sin mockear**. `posRoutes: []` a propósito: Compras nunca entra
al POS.

**Hallazgo propio, no cosmético**: `PinPad` escucha el teclado a nivel de
`window` sin filtrar por foco, y en el formulario de recepción robaba dígitos
del precio que se estaba tecleando y disparaba un envío prematuro
(`received_by_pin: "5000"`, dígitos de "10", "10" y "45000"). Lo resolvió con un
paso «Continuar» explícito que bloquea todos los campos antes de montar el
`PinPad`, sin tocar el componente compartido.

**Ronda 2**: H-6 (las tres pantallas usan `Intl.DateTimeFormat` con
`America/Bogota`; no queda un solo `toISOString().slice(0,10)` en
`features/**`), H-9 (`amount ?? 0` → guarda explícita en el primer renglón del
`mutationFn`).

### `frontend-inventario-conteos` — conteos, varianza, lotes y configuración (2.229 líneas)

Cuatro pestañas nuevas en Inventario (Conteos, Varianza, Lotes, Salud del
control), `CountCapturePage` con la captura a ciegas, `features/settings/
InventorySection.tsx` (el huérfano nombrado: umbrales de varianza e insumos
críticos) y las tarjetas nuevas de «Hoy».

- `formatBasisPoints` centraliza la escala 100 = 1 % que usan cinco campos de
  tres endpoints — el patrón que produjo B-2 en 2a, cerrado antes de abrirse.
- El semáforo se pinta con `row.level` tal cual llega, nunca recalculado.
- Deuda de 2a cerrada: `WasteAdminTab` hacía `Math.round(kpi.ratio * 100)`,
  correcto para una fracción y absurdo (`25000%`) para la escala nueva.
- **Ronda 2**: H-2 (retipó contra `app.orders`, leyendo la implementación y no
  sólo el esquema), H-8 (`CASH_MOVEMENT_CAUSES` como array recorrible en tiempo
  de ejecución, no sólo un tipo), H-7 (`COUNT_QTY_SCALE`).

### `auditor-costos-2b` — 81 invariantes en la ronda 1, 11 más en la ronda 2

`tests/audit/test_{purchases,counts,contract_2b}_invariants.py` (nuevos, 63
casos), `frontend/src/audit/purchases-counts.test.ts` (18 casos), más
`tests/audit/conftest.py` ampliado. **No escribió una sola línea de
`backend/app/**` ni de `frontend/src/` fuera de `src/audit/`.**

**El recorte de los barridos heredados (la tarea que le asigné por nombre).**
Encontró que **eran siete barridos de costo, no tres**, y que el recorte
correcto no era por texto del path sino **por sesión**: una ruta es de admin si
y sólo si su árbol de dependencias incluye `current_admin`. Eso resolvió de raíz
el problema que la spec ya anticipaba — `POST /receptions` es admin puro y no
lleva `/admin/` en el path, así que el recorte v2 la acusaba en falso. **Declaró
por escrito qué dejó de estar cubierto** (el costo en respuestas de
administrador, que es lo que 2a y 2b existen para construir) y dónde sigue
vigilado campo por campo.

También encontró **tres invariantes heredados más que la spec no listó** (§3.9)
y los movió con la disciplina correcta: **un invariante que fija un conjunto
exacto se mueve, nunca se afloja a "que contenga al menos"**.

---

## 3. Coherencia

**Ronda 1**: 10 hallazgos, 2 bloqueantes. **Ronda 2**: los 10 cerrados, los dos
bloqueantes **con implementación, no con un test ablandado**.

| | Hallazgo | Cómo se cerró |
|---|---|---|
| **H-0** | Bloq. — revertir una recepción dejaba el libro del insumo ilegible (`500`) | Una línea: `"reception_reversal"` en `MovementCauseLiteral` (`app/inventory/schemas.py:26`) |
| **H-1** | Bloq. — anular un pago del cajón fabricaba un sobrante | Reintegro tipado en el turno abierto; sin turno, `409` y no se anula nada |
| **H-2** | La lectura de consumo estaba montada dos veces y el contrato publicado no era el servido | Sobrevive `app.orders`; se borró el duplicado de `app.inventory` entero |
| **H-3** | `VOID_AFTER_SEND` declarada y nunca producida | Se sacó del enum (producirla dispararía una segunda depleción FEFO real) |
| **H-4** | «Hoy» y «Salud del control» contaban los días distinto | Una sola matemática y una sola constante |
| **H-5** | La varianza sin uso teórico se pintaba verde (fuga pura) | Tres casos: faltante `red`, sobrante `yellow`, cero `green` |
| **H-6** | Tres pantallas derivaban la fecha de negocio de UTC | `Intl.DateTimeFormat` con `America/Bogota` |
| **H-7** | La calculadora del conteo escribía `QTY_SCALE` en el cliente | Excepción declarada por símbolo, con tres tests que le cobran el precio |
| **H-8** | El egreso a proveedor se pintaba sin causa en el turno | Etiqueta + el cruce genérico contra el `Literal` del backend |
| **H-9** | `amount ?? 0` en el POST de pago | Guarda explícita |

**Verifiqué los cierres contra el código, no contra los informes**, y en
particular los que más fácil se tapan: el test de H-1 (`:819`) no perdió una
sola aserción y sigue aceptando las dos salidas correctas; el de H-2 se
reemplazó por uno **más** estricto; el de H-5 pasó de un caso a tres. **Ningún
rojo de la ronda 1 quedó tapado.**

Del checklist de 30 renglones de la spec: **28 verdes con test nombrado**, el
**#29** (1024 px, foco visible, contraste AA) **no cubierto** — hace falta un
navegador real, es el mismo hueco abierto desde 1a — y el **#30** es esta
entrega.

**El Conciliador cerró con `coherente: true, conflicts: []`.** Eso es cierto y
es limitado: mide conflictos **entre** agentes. Los rojos que quedan son
intra-territorio, y por eso la corrida final existe.

---

## 4. Verificación

Corrida por mí, una vez, en serie, con el árbol quieto y sin ningún proceso
huérfano (`ps` limpio antes de arrancar). Los agentes corrieron sólo su
territorio; **esta es la primera vez que la suite completa corre entera en un
solo proceso, y es exactamente donde aparecieron tres de los cinco rojos.**

### Lo que verifiqué contra el sistema corriendo, no contra los informes

- **Alembic desde cero**: `0001 → 0012` sin error, **73 tablas**.
- **`python -m app.seed`**: corre, y a la segunda dice «ya aplicado» sin
  duplicar nada. Deja 2 proveedores, 2 recepciones, 2 cuentas por pagar, 1 pago,
  5 lotes y **2 conteos completos aplicados y consecutivos**.
- **El saldo derivado, corriendo**: `payables` devuelve `amount: 500000,
  balance: 250000` tras un pago parcial. No hay columna `balance`.
- **La varianza cierra la identidad, corriendo**: `opening 0 + inflow 5005 =
  closing 5005`, uso real 0, teórico 0, varianza 0, `level: green`.
- **Food cost `null` con motivo, nunca `0`**: `{"available": false, "reason":
  "No hay ventas netas registradas en el período entre los dos conteos",
  "pct_bp": null}`, con los dos conteos detectados y
  `opening/purchases/closing_value` calculados.
- **La app real no tiene rutas duplicadas**: `0 Duplicate Operation ID`, 154
  rutas publicadas. **Esto es lo que prueba que dos de los cuatro rojos de
  backend son de la instalación de tests, no del producto.**
- **`reception_invoice_ratio_bp: 0` NO es un defecto**: la única recepción
  dentro de la ventana semanal es la que se sembró sin factura. Lo verifiqué
  antes de reportarlo.

---

## 5. Conflictos y rojos NO resueltos

Cinco rojos en la corrida final. **Dos son los que el equipo declaró y predijo.
Los otros tres los encontró esta corrida, y ninguno de los seis agentes podía
verlos, porque los tres sólo aparecen con la suite entera en un proceso.**

### R-1 — `tests/recipes/conftest.py` monta el router de recetas por segunda vez (causa DOS de los cuatro rojos de backend)

**Rojos que produce:**
- `tests/audit/test_contract_2b_invariants.py::test_the_order_consumption_operation_is_published_exactly_once`
- `tests/orders/test_consumption.py::test_openapi_generation_raises_no_duplicate_operation_id_warning`

**Qué pasa.** `"recipes"` está en `app.main.DOMAINS`, así que `create_app()` ya
monta ese router. `tests/recipes/conftest.py:123` lo monta **otra vez** sobre el
mismo singleton. El guard que tiene (`_recipes_router_mounted`) sólo evita
montarlo dos veces desde el propio conftest — **no comprueba si el dominio ya
está en `DOMAINS`**, que es justamente el guard que sí tiene su vecino
`tests/inventory/conftest.py:23` (`if "inventory" not in main_module.DOMAINS`).
Como el montaje ocurre al **importar** el conftest, para cuando corre el primer
test la app global ya tiene las 12 rutas de recetas duplicadas, y cualquier test
posterior que genere el OpenAPI ve 12 `Duplicate Operation ID`.

**No es un defecto de producto**: lo verifiqué arrancando la app real contra la
base sembrada — **0 duplicados, 154 rutas**. Es la instalación de tests.

**Es exactamente la regresión que el commit `228747b` («1b-2: quitar el doble
montaje de routers en tests») ya había arreglado una vez.** Volvió con el
dominio `recipes` de 2a y nadie la vio porque hace falta la suite entera.

**Los dos invariantes están haciendo su trabajo**: fueron escritos para cazar
«la misma ruta publicada dos veces» y cazaron una duplicación real. Lo que no
cazaron es la que esperaban.

**Remedio (una línea, `tests/recipes/conftest.py:110-111`)**: agregar la condición
que ya usa `tests/inventory/conftest.py` —
`if "recipes" in main_module.DOMAINS: return`.
**Dueño**: `tests/recipes/**` → `backend-recetas` (territorio de 2a; en 2b no
tuvo dueño, es el huérfano de este pedido).

### R-2 — `tests/reports/test_today.py` deriva la fecha de negocio de UTC: es rojo 11 horas por día

**Rojo:** `tests/reports/test_today.py::test_lots_alert_respects_flag_and_reports_expiring_and_expired`
→ `AssertionError: assert 'expiring' == 'expired'`

**Qué pasa.** El test hace `today = clock.now_utc().date()` y siembra el lote
«vencido» en `today - 1 día`. El servidor —**correctamente**— responde con la
**fecha de negocio** de la sede (`tz.today_business_date(store.cutoff_hour)`,
Bogotá, corte a las 06:00). Corrí la suite a las **04:37 UTC** = 23:37 del día
anterior en Bogotá: la fecha de negocio era el 18 y el `today` del test era el
19, así que el lote que vencía el 18 todavía no estaba vencido → `expiring`.

**El código de producción es correcto; el test es el que viola la regla dura de
zona horaria de `AGENTS.md`.** Es la misma clase de defecto que H-6, pero en un
test de backend, y ningún agente lo vio porque corrieron en la ventana en la que
pasa.

**Ventana exacta**: verde de 11:00 a 23:59 UTC (06:00–18:59 Bogotá), **rojo de
00:00 a 10:59 UTC**. Un CI nocturno falla todas las noches.

**Remedio**: el test tiene que derivar su `today` de
`tz.today_business_date(store.cutoff_hour)`, como el servidor.
**Dueño**: `tests/reports/**` → `backend-lectura-contrato`.

### R-3 — H-10 (declarado y predicho): el umbral de 14 días reescrito a mano en el seed

**Rojo:** `tests/audit/test_counts_invariants.py::test_nobody_rewrites_the_14_day_threshold_as_a_bare_day_count`
→ `['app/inventory/seed.py:257 (timedelta(days=14))']`

Confirmado leyendo el código: `INVENTORY_STALE_DAYS = 14` vive en
`app/inventory/hooks.py:712` y el seed repite el número. Y está **exactamente
sobre el borde** (`unreliable = días > 14`). No mueve plata; es señal.
**Remedio de una línea**: importar la constante y restarle margen explícito.
**Dueño**: `backend-inventario-espejo`.

### R-4 — H-11 (declarado y predicho): el cliente ofrece un filtro por una causa que el backend ya no acepta

**Rojo:** `src/audit/purchases-counts.test.ts` → «el cliente declara EXACTAMENTE
las causas de movimiento que el backend publica»

Verificado: `frontend/src/api/inventory.ts:51` declara `"void_after_send"`,
`frontend/src/features/inventory/lib.ts:25` le pone etiqueta, y
`features/inventory/MovementsPanel.tsx:80` arma el desplegable con
`Object.entries(CAUSE_LABEL)`. El admin elige «Anulación tras envío», el cliente
manda `?cause=void_after_send` y FastAPI la rechaza con `422` antes de entrar al
endpoint. **Un filtro que siempre falla es peor que no tener el filtro.**

#### R-4 bis — y su remedio NO es de dos líneas: dos invariantes del auditor se contradicen

**Esto no lo declaró nadie y lo encontré verificando.**

- `frontend/src/audit/purchases-counts.test.ts:486` (nuevo, ronda 2) exige que
  el cliente **NO** declare `void_after_send`. Hoy: **rojo**.
- `frontend/src/audit/inventory.test.ts:282-294` (heredado de 2a, **no
  re-apuntado**) exige que `features/inventory/lib.ts` **CONTENGA** la cadena
  `void_after_send`. Hoy: **verde**, precisamente porque la etiqueta sigue ahí.

`CAUSE_LABEL` está tipado `Record<MovementCause, string>` (`lib.ts:21`), así que
sacar el valor de la unión **obliga** a sacar la etiqueta — y al sacarla, el
heredado se pone rojo. **Los dos no pueden estar verdes con el mismo árbol.**

Peor: ese test heredado enumera las once causas a mano y **no incluye
`reception_reversal`**, la que 2b agregó — no exige etiqueta para ella. Y como
compara con una regex sobre el **texto del archivo**, un comentario que mencione
`void_after_send` lo dejaría verde por accidente: un falso verde.

**Remedio real, tres archivos**: `api/inventory.ts:51`,
`features/inventory/lib.ts:25` y `audit/inventory.test.ts:282-294` — donde lo
correcto es **borrar ese test**, porque el cruce genérico de
`purchases-counts.test.ts:486` ya cubre lo mismo sin lista a mano y en las dos
direcciones. **Dueños**: `frontend-inventario-conteos` + `auditor-costos-2b`.

Es el mismo espejo backend↔cliente de H-8 y H-11, por tercera vez, ahora dentro
del territorio del propio auditor.

### R-5 — Un test de frontend es inestable bajo carga (falso rojo en CI)

`src/features/inventory/__tests__/MovementsPanel.test.tsx:72` falló en la **1.ª**
corrida de la suite completa (`getByRole("option", {name: "Merma"})` no
encontrado) y **no reprodujo** en la 2.ª. Lo corrí aislado **5 veces: 5 verdes**.
Es una carrera de temporización del portal del `Select` que sólo aparece con los
89 entornos jsdom compitiendo por CPU. No es un defecto de producto, pero va a
producir rojos falsos en CI. **Dueño**: `frontend-inventario-conteos`.

### Deuda declarada que NO es rojo, pero que alguien tiene que decidir

- **O-5 — el monto de la cuenta por pagar no se arma con los números de la
  factura.** `app/purchases/service.py:421-422` calcula `Σ (qty_invoiced ×
  precio pre-impuesto) + tax_amount`, no `Σ (tax_base + tax_amount)`, que es lo
  que dice el papel. Con precios redondos coinciden; con una factura que
  redondea, el `payable` que el administrador aprueba **difiere en pesos del
  documento que tiene en la mano**. Verificado en el código. El contrato de 2b no
  fija cuál de las dos es la buena: **es pregunta para el dueño de la spec.**
- **O-6 — los lotes y el libro se separan hacia abajo, por diseño.** FEFO
  consume lotes en cada salida, pero **ninguna entrada que no sea una compra
  crea lote**: una nota «vuelve» y un ajuste de conteo positivo suben el saldo
  del libro y no devuelven nada a los lotes (`hooks.py`: `if qty_base >= 0:
  return`). `Σ qty_remaining` queda por debajo de `current_stock` y
  `GET /admin/lots` sub-reporta. Es coherente con «FEFO no bloquea» y no
  contradice ningún renglón del checklist, pero **conviene que esté escrito
  antes de que alguien sume lotes para cuadrar un conteo.**
- **Comentarios podridos**, los dos verificados contra el árbol de hoy:
  `frontend/src/api/inventory.ts:34-46` anuncia como GAP abierto el `500` de H-0
  que ya está cerrado; `frontend/src/api/reports.ts:222-229` dice que el backend
  **no** usa `theoretical_cost`/`gross_margin`/`costed_pct` mientras las tres
  propiedades declaradas seis líneas más abajo se llaman exactamente así.
- **«Sostenido» del semáforo rojo** (SPEC-NEGOCIO §5.4: «> 4–5 sostenido rojo»)
  no está implementado: hay semáforo por conteo individual. La spec no define
  «sostenido» con precisión suficiente para implementarlo sin inventar un
  criterio. **Decisión del dueño de la spec.**
- **Huecos de contrato de Compras** que el frontend rodeó sin inventar
  matemática: no existe `GET /admin/payables/{id}/payments` (un administrador
  que vuelve al día siguiente **no puede ver qué se pagó**);
  `GET /admin/suppliers` no declara `format=csv`; las guardas de tecleo no
  devuelven el valor de referencia ni el índice de línea estructurado;
  `PayableOut`/`ReceptionOut` no traen `supplier_name`.
- **Nunca se probó contra Postgres.** Todo corrió en SQLite: sin enums nativos,
  sin `SELECT FOR UPDATE`, sin índices parciales reales y sin los `409` de
  carrera bajo bloqueo. La atomicidad de la recepción se probó con un fallo
  **inyectado**, no con una carrera.
- **El bundle del frontend pesa 1,22 MB** (340 kB gzip), sobre el umbral de
  aviso de 500 kB. Sin code splitting.

---

## 6. Próximos pasos, priorizados

**Primero — los cinco rojos, para que el CI vuelva a verde (todos de una o dos líneas):**

1. **R-1**, `tests/recipes/conftest.py:110-111` — agregar el guard de `DOMAINS` que
   ya usa `tests/inventory/conftest.py`. Cierra **dos** rojos de una vez.
2. **R-2**, `tests/reports/test_today.py:244` — derivar el `today` del test de
   la fecha de negocio de la sede. Es rojo 11 horas por día hoy.
3. **R-4 + R-4 bis**, los **tres** archivos del cliente, y **borrar**
   `audit/inventory.test.ts:282-294` en vez de parcharlo.
4. **R-3**, `app/inventory/seed.py:257` — importar `INVENTORY_STALE_DAYS`.
5. **R-5** — estabilizar `MovementsPanel.test.tsx` (esperar el portal abierto
   antes de buscar la opción).

**Segundo — las dos preguntas que sólo el dueño de la spec puede responder:**

6. **O-5**: ¿el `payable` se arma con la suma de la factura (`tax_base +
   tax_amount`) o con el precio por cantidad? Hoy difiere del papel cuando la
   factura redondea, y es plata que alguien aprueba.
7. **«Sostenido»** del semáforo rojo: ¿dos conteos seguidos? ¿tres? ¿del mismo
   insumo?

**Tercero — lo que el producto necesita y 2b no alcanzó:**

8. **`GET /admin/payables/{id}/payments`.** Sin esto el historial de pagos no
   existe y no se puede anular un pago de una sesión anterior. Es el hueco de
   producto más grande que dejó este pedido.
9. **`format=csv` en `GET /admin/suppliers`**, para sacar el CSV armado en el
   cliente.
10. **Enganchar los filtros de «Hoy» → Cuentas por pagar** (`PayablesTab` leyendo
    `status`/`overdue` de la query string). Deuda con dueño: `frontend-compras`.
11. **Documentar O-6** (lotes y libro se separan hacia abajo) en
    `docs/ESTADO.md`, antes de que alguien lo lea como un bug y «arregle» los
    lotes para cuadrar un conteo.

**Cuarto — lo que ningún test de este entorno puede cerrar:**

12. **Postgres y CI reales**: atomicidad bajo carrera, `SELECT FOR UPDATE`,
    índices parciales, los `409` de concurrencia.
13. **Checklist #29 en navegador real**: 1024 px sin scroll horizontal, foco
    visible, contraste AA. Es el único renglón del checklist que cierra como
    **no cubierto**, y viene abierto desde 1a.
14. **Recorrido en navegador del flujo completo de 2b** con la base sembrada.
    Ojo con dos cosas que se ven raras y no son bugs: la primera recepción de un
    insumo con costo oficial puesto se corta con `409 PRICE_JUMP` si el precio
    real se aparta más de 15 % de lo estimado (O-7, «pregunta, no corrige»), y
    **el perfil `standard` del seed deja `inventory.variance` y `inventory.lots`
    apagadas**, así que Food cost, Salud del control y Lotes responden
    `400 FEATURE_DISABLED` hasta que se encienden en Admin → Funciones.

**Quinto — mantenimiento:**

15. **`docs/ESTADO.md` sigue diciendo que «lo que sigue es 2b»**. Hay que
    escribir el cierre de 2b (y de paso corregir «checklist de 31 puntos»: son
    30).
16. **Code splitting del frontend** (1,22 MB en un solo chunk).
17. **`backend/tests/recipes/_inventory_stub.py` declara diez causas y el enum
    real tiene once** — no rompe nada hoy porque no hay ninguna aserción de
    igualdad. Es el mismo espejo sin invariante de H-0, H-11 y R-4 bis,
    esperando el pedido que lo pise. **Es el cuarto del día: vale la pena
    cerrarlo ahora.**

---

## 7. La lección de este pedido

**Nombrar dueño a los huérfanos funciona: once nombrados, cero fallaron.** Lo que
falla es el **cruce** entre dos dueños, y falla en los dos sentidos: un contrato
de ida construido sin la mitad de vuelta. El mismo espejo backend↔cliente se
rompió **cuatro veces** en este pedido (H-0, H-8, H-11 y R-4 bis) con dueños
distintos cada vez, y el typecheck no vio ninguna.

La forma barata de cerrarlo ya está escrita y probada: el invariante que **lee
el contrato del backend y exige igualdad exacta en las dos direcciones, sin
nombrar ningún valor**. El auditor lo escribió después de H-8 sin saber que iba
a cazar H-11 en su primera corrida. Eso es lo que hay que generalizar en el
próximo reparto: **cuando una capacidad cruza dos dominios, el reparto nombra el
contrato — quién publica, quién llama, y qué pasa cuando se deshace — no sólo
los archivos.**

Y la lección específica de esta corrida final, que vale para el framework:
**tres de los cinco rojos sólo existen con la suite entera en un proceso.** Un
agente que corre bien su territorio puede estar dejando rojo el de otro sin
ninguna forma de enterarse — por un conftest que contamina el singleton al
importarse, o por un test que depende de la hora a la que se corre. **La corrida
final del Maestro no es un trámite de confirmación: es el único lugar donde
aparecen los defectos de interacción entre territorios.** En 2a esta corrida
confirmó lo que el auditor predijo; en 2b encontró tres cosas que nadie podía
ver.
