# ENTREGA — pedido 2c, «Canales y cocina»

Cierre del ciclo por el Maestro Orchestrator. Todo lo que sigue está medido
contra el código y contra la suite corriendo, no contra los informes de los
agentes. Donde el informe de alguien y el árbol no coincidieron, gana el árbol
y lo digo.

---

## 0. Veredicto en una línea

**El producto está construido, está completo y está verde: la suite entera del
backend da 1 rojo sobre 1.227 casos y ese rojo es el único hallazgo que decidí
diferir. Pero NADA está commiteado —`HEAD` sigue siendo `d936885`—, y ése es el
único problema real que queda abierto en este pedido.**

| | Resultado medido hoy |
|---|---|
| `cd backend && python -m pytest -q` (suite COMPLETA, una corrida, en serie) | **1 failed, 1226 passed** — 3206 s (53:26) |
| El único rojo | `test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three` = **H-3, diferido por decisión mía** |
| `cd backend && python -m mypy app` | **Success: no issues found in 123 source files** |
| `cd frontend && npm run typecheck` | **limpio** (exit 0) |
| `cd frontend && npx vitest run` (suite COMPLETA) | **98 archivos, 490 tests, 0 rojos** — 54,6 s |
| `cd frontend && npm run build` | **✓ built**, 2.571 módulos, sin errores |
| Cadena Alembic | `0012 → 0013 → 0014 → 0015`, **un solo head**, lineal |
| Estado en git | **HEAD == `d936885`. Cero commits. 94 archivos en el árbol de trabajo** |

---

## 1. El equipo que armé, y por qué ése

El reparto no salió de leer la spec: salió de explorar el árbol antes de
repartir. Tres cosas que encontré cambiaron el diseño del equipo, y las tres se
pagaron solas.

**`app/orders/service.py` son 108 KB en un solo archivo, y cuatro de las seis
dimensiones del pedido lo tocan.** Partirlo entre dos agentes garantizaba el
conflicto de escritura que ya había mordido a `inventory` en 2b. Por eso
`app/orders/**` tuvo **un solo dueño**, y por eso `backend-canales-comanda` fue
el agente más grande a propósito.

**`app/shifts/**` era territorio cruzado por tercera vez en el proyecto**, y en
las dos anteriores ahí cayó un hallazgo. Le puse dueño único (`backend-dinero-canales`)
y lo puse en **opus**: no era construir, era no romper el esperado de caja. Esta
vez ahí cayeron **cuatro** de los ocho hallazgos. La apuesta era correcta y el
costo también: fue el agente que necesitó las tres rondas.

**La jugada que borra territorio compartido antes de que exista**, aplicada tres
veces:

- **el cargo de domicilio es un `OrderItem` de verdad**, no un campo — así fluye
  solo por `app/orders/money.py` y por `app/core/tax.py`, y `app/fiscal/**` no
  necesitó una matemática nueva ni un dueño;
- **plataformas y comisiones viven en un dominio nuevo `app/channels/**`**, no
  en `StoreSalesSettings` — la misma jugada que sacó los umbrales de varianza de
  `app/stores/**` en 2b, y que evitó el modelo compartido donde 1b-2 dejó
  `invoice_threshold_uvt` escrito a medias en tres capas;
- **en el frontend nadie toca `src/app/router.tsx` salvo un agente** — el repo
  ya tenía el patrón de manifiesto, así que cada dominio declaró sus `posRoutes`
  y `router.tsx` se editó **una sola vez**, para registrar `kitchenFeature`.

Y el huérfano invisible: **`app/core/models_registry.py` y `app/main.py`**. Dos
agentes creaban `models.py` nuevos y los dos necesitaban esos mismos dos
archivos — exactamente H-0 de 2b. Lo resolví con un dueño único que registró
**ambos** dominios en su primer commit, y con la prohibición explícita al otro
de tocarlos.

| Agente | Modelo | Por qué ese modelo |
|---|---|---|
| `backend-canales-comanda` | sonnet | Construir contra un contrato ya escrito: mucho código, poco razonamiento nuevo |
| `backend-dinero-canales` | **opus** | El único que razonaba contra tres invariantes heredados a la vez, sobre el territorio que ya había mordido dos veces |
| `backend-kds` | sonnet | Write-disjoint de verdad: tablas propias, endpoints propios, cero archivos compartidos |
| `frontend-pos-canales` | sonnet | Pantallas contra tipos ya publicados |
| `frontend-kds-config` | sonnet | Pantallas + el único registro de rutas |
| `auditor-canales-2c` | **opus** | El único que razona contra código ajeno para romperlo. En 2a devolvió 8 de 9 rojos; en 2b, los 10 hallazgos |

**Resultado del reparto: cero conflictos de escritura entre agentes en las tres
rondas.** Ningún agente pisó el territorio de otro, ni una vez. Eso es lo que el
diseño del equipo existía para comprar, y lo compró.

---

## 2. Qué construyó cada agente

### `backend-canales-comanda` — la comanda y la carta

- `app/catalog/models.py`: `Product.is_delivery_fee`. El cargo de domicilio es
  **un producto real de la carta**, no una tabla de configuración nueva.
- `app/catalog/service.py`: `get_delivery_fee_product`, a lo sumo un producto de
  cargo activo por sede (`409 DELIVERY_FEE_ALREADY_CONFIGURED`); el cargo se
  excluye del `GET /catalog` que ve el operador.
- `app/orders/models.py`: doce columnas nuevas en `Order` (dirección, teléfono,
  domiciliario con **FK real + nombre congelado**, plataforma con snapshot de
  `platform_commission_bp`, `platform_external_id`, los cuatro campos de
  cancelación), `OrderStatus.COMPENSATED`, y la tabla `OrderCourseFire` con
  `UNIQUE(order_id, course)`.
- `app/orders/service.py`: `_channel_list_price` extendida a `delivery` y
  `platform` con `is not None` (nunca `or`: 0 no es falsy acá); `fire_course`
  («marchar»), idempotente por construcción; `_build_delivery_fee_item`, con
  `station=None` para que el cargo nunca ensucie cocina.
- `app/orders/hooks.py`: **CONTRATO C1** (bump/unbump/expedite/lectura de
  cursos) y **C4** — el punto por el que el KDS escribe sin tocar `orders`.
- `alembic/versions/0013_channels_orders.py`.

### `backend-dinero-canales` — el dinero de los canales

- **`app/channels/**` entero (dominio nuevo, ~2.400 líneas)**: `DeliveryPlatform`,
  `PlatformCommission`, `PlatformReceivable`, `DeliverySettlement`; la comisión
  en **puntos básicos enteros** con `round_half_up`, congelada en la fila
  (cambiar el porcentaje no reescribe el pasado).
- El medio `platform` como **cuenta por cobrar**, fuera del efectivo esperado.
- El efectivo de domicilios **arqueado aparte** del cajón hasta que el
  domiciliario liquida, con la ida, la vuelta (anular una liquidación escribe el
  espejo y deja viva la original) y el `409 NO_OPEN_SHIFT`.
- La **venta compensada** de la cancelación de plataforma después de preparar.
- `app/core/models_registry.py` + `app/main.py`: registró **los dos** dominios
  nuevos (el suyo y el de `kitchen`) — el huérfano de §1, cerrado por contrato.
- `alembic/versions/0014_channels_money.py`.

### `backend-kds` — el KDS completo

- `app/kitchen/models.py` (nuevo): `KitchenBumpEvent` y `KitchenPrintJob`, las
  dos **append-only**. Un bump idempotente que no cambió nada **no escribe fila**:
  no hay nada que auditar.
- `app/kitchen/service.py` (nuevo): toda escritura sobre `OrderItem` pasa por los
  hooks de `orders` (**C1**), resueltos con `find_spec_safe` + `Protocol` + `cast`
  para que mypy siga chequeando las llamadas aunque el import sea dinámico.
  Nunca escribe `status` a mano. Ese contrato se cumplió sin una sola excepción.
- Cinco rutas nuevas detrás de `kitchen.kds`; `GET /kitchen/rounds` sin un solo
  cambio de comportamiento con la flag apagada.
- `alembic/versions/0015_kitchen_kds.py`.

### `frontend-pos-canales` — el POS

- Canales en la comanda, formulario de domicilio, pedido de plataforma con
  `external_id`, «marchar», precios por canal en la carta.
- `DeliverySettlementPanel.tsx` + su test: el desglose de caja con el efectivo de
  domicilios, y el `cash_out` de referencia al lado del campo de propina del
  cierre.
- `src/api/channels.ts`, `orders.ts`, `shifts.ts`, `catalog.ts` sincronizados.

### `frontend-kds-config` — pantalla KDS, Configuración y el único registro de rutas

- `src/features/kitchen/**` completo (`KdsPage.tsx`, `hooks.ts`, `lib.ts`,
  `index.ts` + tests): el KDS con bump, expedición, filtro por estación y orden
  por «marchar».
- `src/features/settings/ChannelsSection.tsx` + test: §9.3 de la spec (canales,
  plataformas y comisiones, estaciones, cursos y tiempos objetivo).
- `src/app/router.tsx`: **editado una sola vez**, para registrar
  `kitchenFeature.posRoutes`. El contrato C8 se cumplió.

### `auditor-canales-2c` — los 15 renglones como invariantes ejecutables

- `backend/tests/audit/test_channels_invariants.py`,
  `test_channels_money_invariants.py`, `test_channels_round2_invariants.py`,
  `test_contract_2c_invariants.py`, `test_kitchen_invariants.py`;
  `frontend/src/audit/channels-kds.test.ts`, `channels-round2.test.ts`.
- **429 casos de invariante en backend, 115 en frontend.** Ocho hallazgos, dos
  de ellos bloqueantes, **los cuatro más caros en `app/shifts/**`**.
- Re-apuntó los barridos heredados que 2c toca por diseño (cadena de migraciones
  a `0015`/79 tablas) dejando escrito el antes, el después y qué dejó de estar
  cubierto (nada).
- Midió la **sensibilidad** de sus propios invariantes reinyectando los defectos
  por monkeypatch, sin tocar `app/**`, y borró el sondeo después.

---

## 3. Coherencia — las tres rondas

Hicieron falta tres rondas y todas se gastaron en el mismo lugar: **el esperado
de caja**.

| Hallazgo | Qué era | Cierre |
|---|---|---|
| **H-1** 🔴 | La propina de domicilio movía el esperado y la de mostrador no: dos matemáticas para la misma plata | Ronda 2, por el código |
| **H-2** 🔴 | `GET /shifts/{id}/tips` contaba la misma propina en efectivo dos veces, con dos fórmulas dentro del mismo cuerpo | Ronda 2, por el código |
| **H-4** 🟡 | Domiciliario publicado como `{"id": 0, "name": ""}` — un cero mudo | Ronda 3 |
| **H-5** 🟡 | La plataforma del cobro resuelta con `or` en vez de `is not None` | Ronda 3 |
| **H-6** 🟡 | El invariante más caro del pedido defendido con un `assert` pelado | Ronda 3 |
| **H-7** 🟡 | `delivery_cash_pending`: **el mismo nombre publicado con dos cantidades** en dos respuestas | Ronda 3, renombrando a `delivery_tips*` en `/tips` |
| **H-8** 🔴 | La propina de domicilio ya liquidada quedaba en el cajón **sin autorización de salida**: se consignaba como venta en vez de pagarse a la persona (Ley 1935 de 2018) | Ronda 3 |
| **H-3** 🟡 | `active_channels` no gatea `delivery` ni `platform` | **DIFERIDO por decisión mía** — §5 |

**Los siete que dependían de código están cerrados y cerrados por el código, no
por el test.** Lo verifiqué: los tres pins heredados (`cash_out == by_method.cash`
en tres archivos distintos) siguen en el **mismo número de línea** que antes, y
el pin por AST del texto exacto de `expected` y `to_deposit` sigue verde. Nadie
aflojó un poste para comprar un verde.

Un episodio que vale registrar como patrón del framework: en la ronda 3 el
renombre de H-7 —**remedio que el propio auditor había prescrito**— rompió cinco
de sus tests por `KeyError`. `backend-dinero-canales` **frenó y reportó en vez de
resolverlo por su cuenta**: no revirtió el renombre, no tocó `tests/audit/**` y,
sobre todo, **no agregó un alias** `delivery_cash = delivery_tips` para que los
cinco pasaran (habría sido H-7 otra vez, escondido). El auditor los reexpresó
dejando cada aserción igual o más exigente, con la columna «qué dejó de estar
cubierto» llena. Ése es el momento más peligroso de toda auditoría y se manejó
bien.

---

## 4. Verificación — exactamente lo que corrí

Una sola corrida de cada cosa, en serie, con el árbol quieto y sin ningún otro
agente trabajando. Confirmé con `ps` que no quedaba ningún proceso de test o
build huérfano antes de empezar, y no lancé el build del frontend mientras la
suite corría.

```bash
cd backend  && python -m pytest -q      # 1 failed, 1226 passed — 3206,08 s (0:53:26)
cd backend  && python -m mypy app       # Success: no issues found in 123 source files
cd frontend && npm run typecheck        # exit 0, sin salida
cd frontend && npx vitest run           # 98 archivos, 490 tests, 0 rojos — 54,63 s
cd frontend && npm run build            # ✓ built, 2.571 módulos
cd backend  && python -m alembic heads  # 0015 (head) — uno solo
```

### Lo que verifiqué a mano contra el código, no contra los informes

- **La cadena de migraciones NO está rota.** `0012 → 0013 → 0014 → 0015`, un
  solo head, lineal, cada `down_revision` fijado de antemano. Nadie renumeró.
- **El renombre de H-7 es real y está completo.** `ShiftTipsOut` publica
  `delivery_tips`, `delivery_tips_pending` y `delivery_tips_settled`; el desglose
  del turno conserva `delivery_cash_pending` con su significado de siempre
  (venta + propina). Las claves viejas ya no existen en `/tips`.
- **El KDS no filtra costos.** Ni `cost` ni `margin` ni `unit_cost` en
  `app/kitchen/schemas.py` ni en `service.py`.
- **Sin `float` en comisiones ni en precios por canal.** La única aritmética con
  `commission_bp` en todo `app/**` está en `app/channels/service.py:102`, con
  `round_half_up`. Una sola escala, en un solo lugar.
- **H-3 está abierto tal cual lo describe el auditor**: `create_order` mira
  `active_channels` sólo para `counter`/`dine_in`/`takeout`.
- **`router.tsx` se editó una sola vez.** Un único `import { kitchenFeature }` y
  un único `...kitchenFeature.posRoutes`.
- **Dos afirmaciones del informe de `backend-dinero-canales` que el árbol
  desmentía (R-1 y R-2) ya estaban corregidas** en la ronda 3. No hay dos rojos
  que perseguir.

### Lo que NO verifiqué, y no lo maquillo

- **Recorrido en navegador real (renglón #14 del checklist).** No lo hice. jsdom
  no calcula layout: «375 px y 1024 px sin scroll horizontal, foco visible» está
  verificado por inspección de clases, **no con una ventana de verdad**. Es un
  hueco abierto desde 1a y sigue abierto. La spec lo pide explícitamente como
  paso previo a cerrar, y **no está cumplido**.
- **PostgreSQL.** Toda la suite corrió contra SQLite. El índice único parcial de
  `delivery_platforms`, los `409` literales de concurrencia y los `SELECT FOR
  UPDATE` no se probaron contra el motor de producción.
- **Concurrencia real.** Dos liquidaciones del mismo domiciliario a la vez: un
  proceso, SQLite, no se puede.

---

## 5. Conflictos NO resueltos

### 5.1 BLOQUEANTE OPERATIVO — nada está commiteado

**Éste es el problema real de este pedido, y no es el que el Conciliador
reportó.**

El Conciliador levantó cinco bloqueantes (C001–C005) diciendo que
`app/channels/**`, `app/kitchen/{models,schemas,service}.py`, las tres
migraciones, `features/kitchen/**` y `ChannelsSection.tsx` «no están
commiteados» y que «la cadena de migraciones está rota». Verifiqué:

**`HEAD` es exactamente `d936885`. No hay un solo commit. Los 94 archivos del
pedido —modificados y nuevos— están en el árbol de trabajo.** Los cinco
bloqueantes no son cinco problemas distintos: son cinco síntomas de uno solo.

Lo importante: **el código existe, está completo y pasa.** `app/channels/**` son
~2.400 líneas reales; `app/kitchen/{models,schemas,service}.py`, ~2.900 entre los
dos dominios; la cadena de migraciones es lineal con un head; y la suite completa
da 1226 verdes. **Lo que falta no es código: es un `git add` y un `git commit`.**

**Riesgo concreto mientras siga así**: los dominios nuevos están `untracked`. Un
`git checkout`, un `git clean -fd` o un `git stash` mal puesto **borra el pedido
entero sin recuperación posible**. Es el paso siguiente y es urgente.

### 5.2 H-3 — diferido por decisión mía, con dueño y remedio

Es el único rojo de la suite y **es rojo a propósito**. `active_channels` no
gatea `delivery` ni `platform`.

No lo cerré porque el remedio parcial rompe sedes vivas: gatearlos sin backfill
dejaría a **toda sede existente sin poder vender por domicilio el día del
deploy** (el default del alta es `["counter","dine_in","takeout"]`), y la casilla
que el administrador necesitaría para activarlos vive en `StoreFormDialog.tsx`,
territorio de otro pedido.

| | |
|---|---|
| **Dueño** | `backend-canales-comanda` |
| **Remedio** | Las tres cosas **juntas**: (a) extender la guarda de `create_order`, (b) migración que agregue `delivery`/`platform` a las sedes que ya tengan la función encendida, (c) la casilla en `StoreFormDialog.tsx` |
| **Riesgo mientras tanto** | Bajo y acotado: el canal igual está detrás de su flag con `400 FEATURE_DISABLED`. Falta el segundo interruptor, no el primero |
| **Cuándo se cierra sola** | El día que las tres vayan juntas. El test no hay que tocarlo |

Relacionado: `StoreFormDialog.tsx` ya tiene hoy una casilla «Domicilio» en
`active_channels` **que no controla nada**. Es anterior a 2c y nadie la tocó,
pero el administrador la ve y no hace nada.

### 5.3 Abiertas de negocio, no de código

- **O-7 — el arqueo acusa toda propina en efectivo como sobrante.**
  `difference = counted_cash_total − expected` y la propina en efectivo nunca
  entró al esperado, así que **hoy todo turno con propina en efectivo cierra con
  diferencia** y exige causa tipada. Es comportamiento de **1b**, idéntico para
  mostrador desde antes de 2c. Si el dueño de la spec decide que el arqueo no
  debe acusar propinas, el arreglo es en `_evaluate_close` (1b), no en 2c — y
  hay que decidirlo **antes** de salir a producción.
- **`tips_cash_out` se escribe a mano** y nada obliga a que coincida con el
  `cash_out` que ahora el servidor publica. Ahora que `cash_out` incluye propina
  de un empleado, vale decidir si ese campo debería venir pre-llenado.
- **Propina liquidada en un turno distinto al de la venta.** Si un domicilio se
  cobra en el turno A y se liquida en el B, el `cash_out` del A puede autorizar
  plata que entró físicamente en el B. En el uso real no pasa (el domiciliario
  liquida antes del cierre), pero nada lo impide.
- **O-8 — tercer clasificador** en `app/shifts/activity_metrics.py:212-219`,
  fuera de alcance por decisión mía, sin tocar.

### 5.4 Huecos de alcance declarados, no olvidados

- **Ninguna pantalla para `PlatformSummaryOut` / `PlatformCommissionOut` /
  `PlatformReceivableOut` / `PlatformCancellationOut`.** Es Admin → Dinero, no
  Configuración, y ningún agente de este equipo lo tenía asignado. Los datos se
  registran y no se ven en ningún lado.
- **`DeliverySettlementPanel` no tiene histórico** consultable desde el POS:
  sólo deshace lo liquidado en la misma sesión de pantalla.
- **El KDS exige persona identificada** aunque el backend a propósito no lo pide
  (`PosLayout.tsx` redirige todo `/pos/*`). Heredado; tocarlo afecta a las otras
  siete pantallas.
- **`docs/ESTADO.md` §Glosario no tiene las entradas de 2c** (`delivery`,
  `platform`, `fire_course`, `bump_item`, `kitchen.kds`).

---

## 6. Próximos pasos, por prioridad

1. **Commitear el pedido.** Urgente y antes que nada: hoy un `git clean` borra
   2c entero. Los 94 archivos, con las tres migraciones y los dos dominios
   nuevos incluidos.
2. **Recorrido en navegador real** (renglón #14, el único del checklist que no
   está cumplido): levantar backend + frontend y recorrer POS y KDS a 375 px y
   1024 px. La spec lo pide como condición para cerrar.
3. **Decidir O-7** —si el arqueo debe seguir acusando la propina en efectivo como
   sobrante—, porque hoy todo turno con propina cierra con diferencia y el
   arreglo es en 1b.
4. **Cerrar H-3 completo**: guarda + backfill + casilla, las tres juntas. Se
   lleva puesta también la casilla muerta de `StoreFormDialog.tsx`.
5. **Correr la suite contra PostgreSQL** antes de producción: el índice único
   parcial y los `SELECT FOR UPDATE` nunca se ejercitaron en el motor real.
6. **Las pantallas de admin de plataformas** (comisiones, cuentas por cobrar,
   cancelaciones): el backend las publica y nadie las mira.
7. **Actualizar `docs/ESTADO.md`** con el glosario de 2c y anotar el pedido como
   cerrado.

---

## 7. La lección del pedido

Las tres rondas dejaron el mismo dibujo, y es el más útil que este pedido deja
para el framework: **los ocho hallazgos salieron de cruzar dos lecturas de la
misma plata**, nunca de mirar una regla sola. H-2 cruzó `by_method` con
`by_employee`. H-7 cruzó la misma clave en dos respuestas. H-8 cruzó el antes y
el después de la liquidación — el momento que ni el test de la ida ni el de la
vuelta miran, porque los dos terminan en el instante de la escritura.

Y la que se paga en el diseño del equipo, no en la auditoría: **`app/shifts/**`
lleva tres pedidos seguidos siendo territorio cruzado y tres pedidos seguidos
dejando hallazgos.** Ponerle dueño único y el modelo más caro fue correcto y
alcanzó para que ninguno de los cuatro llegara al producto — pero que siga
saliendo caro cada vez dice que ese módulo pide una fase propia, no otro dueño
único.
