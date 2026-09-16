# ENTREGA — pedido 2a (insumos, recetas, preparaciones, consumo teórico y mermas)

**Fecha**: 2026-09-16. **Orquestador**: Maestro (Fable).
**Base del pedido**: `dad3ee1`. **Rondas**: 2 (construcción + conciliación).
**Equipo**: 6 agentes (5 builders en sonnet, 1 auditor en opus).

**Veredicto: se entrega, con nueve rojos declarados y ninguno escondido.**
Ocho son advertencias que el auditor escribió rojas a propósito y documentó una
por una antes de esta corrida. El noveno lo encontró esta verificación y **nadie
del equipo lo había visto**: un invariante heredado que aplica una regla de
dispositivo al documento OpenAPI entero, y que la fase 2a rompe por existir. Es
un test equivocado, no un código equivocado, y §5 lo demuestra campo por campo.

**El código no está commiteado.** `HEAD` sigue siendo `dad3ee1`: 47 archivos
modificados y 145 archivos nuevos sin tracking. Es el primer punto de §6.

---

## 1. Qué equipo armé y por qué

El pedido tiene cinco dimensiones y las corté por **territorio de escritura
disjunto**, no por capa. La regla que seguí es la lección cara de 1b-2: un
archivo sin dueño nombrado es un archivo que queda escrito a medias.

| Agente | Modelo | Territorio | Por qué existe |
|---|---|---|---|
| `backend-inventario` | sonnet | `app/inventory/**`, `app/core/quantity.py`, `app/seed.py`, `tests/inventory/**`, `tests/core/**`, `tests/conftest.py` | El cimiento. Unidad base, aritmética entera, `cost_source`, `record_movement` como única escritura. Todo lo demás lo importa, así que se escribe **primero** y se publica como contrato. |
| `backend-recetas` | sonnet | `app/recipes/**`, `tests/recipes/**` | El razonamiento más denso: versionado con conservación, ciclos por cualquier camino, propagación insumo → preparación → plato (lo que la referencia no hacía), dos modos excluyentes. Dominio nuevo entero, sin un archivo compartido con el anterior. |
| `backend-consumo` | sonnet | `app/orders/**`, `app/reports/**`, `app/main.py`, `models_registry.py`, `NOTIFICATION_TYPES`, `docs/ESTADO.md` (+ `app/fiscal/**` en ronda 2) | La dimensión que cruza territorio ajeno: el hook en `send`, el `WasteStub` con FK real, el espejo de la nota «vuelve», el snapshot congelado, los reportes que sólo se amplían. No construye dominio: modifica el de 1b, y por eso necesita dueño único de los archivos de montaje. |
| `frontend-recetas` | sonnet | `features/recipes/**`, `features/catalog/**`, `api/recipes.ts` | Eje de datos «recetas»: Carta y recetas, Preparaciones, producción rápida en POS. |
| `frontend-inventario` | sonnet | `features/inventory/**`, `features/reports/**`, `app/**`, `components/**`, `features/settings/**`, `features/auth/**`, `api/inventory.ts` | Eje de datos «inventario» + la carcasa (router, layouts) + los huérfanos que 1b-2 dejó sin dueño. |
| `auditor-costos` | **opus** | `tests/audit/**`, `frontend/src/audit/**` | Quince ítems del checklist son invariantes ejecutables, no funcionalidades. Ningún builder es juez de su propio invariante. |

**Por qué opus sólo en el auditor**: los cinco que escriben código de producción
trabajan contra un contrato ya escrito; el único que tiene que razonar contra
código ajeno para romperlo es el auditor. Se pagó solo: de los nueve rojos, ocho
son suyos y los nueve están explicados.

**Tres decisiones de reparto que borraron territorio compartido antes de que
existiera**, y que son la razón de que no haya un solo conflicto de escritura
entre agentes:

1. **`recipe_effect` se modeló como tabla propia** en `app/recipes/models.py`
   (`modifier_option_recipe_effects` + `_lines`, FK a `modifier_options.id`).
   Resultado: **nadie escribió en `app/catalog/**` en el backend**.
2. **2a no agrega ninguna configuración de sede.** El 15 % de rendimiento y el
   1,5 × de merma son constantes declaradas en código. Eso sacó `app/stores/**`
   del reparto — que es exactamente el modelo compartido donde 1b-2 dejó
   `invoice_threshold_uvt` escrito a medias en tres capas.
3. **Los huérfanos se nombraron desde el arranque**: `app/seed.py`,
   `tests/core/**`, `tests/conftest.py`, `features/settings/**`,
   `features/auth/**`, `app/main.py`, `models_registry.py`.

**Funcionó, y se puede medir**: los tres rojos de 1b-2 cayeron los tres en
archivos sin dueño. Esta vez ninguno de esos archivos falló. El único huérfano
que quedó sin nombrar fue **`app/shifts/**`**, y es exactamente donde cayó A-2.
La regla se cumple hasta donde se aplica, y falla donde no se aplicó.

Del catálogo del framework no entró ningún agente tal cual: `agente-backend.md`
y `agente-frontend.md` sirvieron de base adaptada. `agente-contador`,
`agente-legal`, `agente-analytics` y `agente-datos` no aportaban (no hay régimen
fiscal nuevo, ni dato personal nuevo, ni panel analítico nuevo: los reportes se
amplían, no se rediseñan). `backend-inventario` y `auditor-costos` son roles
nuevos; el primero es el «especialista en inventario y costos» que la tabla de
excepciones de `AGENTS.md` dejó anticipado.

---

## 2. Qué construyó cada agente

### `backend-inventario` — el libro y el contrato numérico

- **`app/core/quantity.py`** (233 líneas) — el cimiento de toda la fase.
  `QTY_SCALE = 1000` (milésimas de la unidad base), `COST_SCALE = 1_000_000`
  (millonésimas de peso por unidad base entera), `apply_yield` con redondeo
  **hacia arriba** (nunca sub-descontar), y el borde de entrada que **rechaza un
  número JSON** para una cantidad. Cero `float`, cero `Decimal` persistido.
- **`app/inventory/**`** (14 archivos, 2.680 líneas): `Ingredient`,
  `StockMovement`, `Waste`; los enums `BaseUnit`, `MovementCause` (11 causas),
  `CostSource` (5), `WasteType` (8, **sin** `staff_meal`); `record_movement` como
  **única** escritura del libro, con fusión automática por
  `(org, sede, insumo, causa, ref_type, ref_id)`; `resolve_consumption_target`
  con un solo camino y cascada al sustituto; `current_stock`, `low_stock_alerts`,
  `negative_stock_alerts` con `probable_cause` derivada de causa tipada.
- **8 endpoints**: insumos (alta, edición, baja **lógica**), libro por insumo,
  `GET /admin/inventory/stock` con los tres filtros, ajuste manual con PIN,
  `POST /waste` (dispositivo), `GET /admin/waste` con KPI semanal, y
  `GET /device/ingredients` (sin un solo campo de costo). `format=csv` en los cinco listados.
- **`alembic/versions/0008_inventory.py`**, `app/seed.py` (5 insumos con
  `yield_pct != 100`, costo oficial y sustituto en cascada), `tests/inventory/**`
  y `tests/core/**` (49 archivos, 5.473 líneas de test).

### `backend-recetas` — fichas, preparaciones y el motor de costo

- **`app/recipes/**`** (18 archivos, 3.803 líneas) y **7 tablas nuevas**:
  `preparations`, `preparation_lines`, `prep_batches`, `recipes`,
  `recipe_versions`, `recipe_lines`, `modifier_option_recipe_effects(_lines)`.
- **Lo difícil, resuelto**: versionado que **conserva** las versiones viejas
  porque los ítems vendidos apuntan a ellas; detección de ciclos por cualquier
  camino (`400 PREP_CYCLE`, probado con un ciclo de tres saltos); **propagación
  de costo en cadena** insumo → preparación → plato, que es justo lo que la
  referencia no hacía; dos modos excluyentes (`batch` descuenta al producir,
  `exploded` al enviar, nunca ambos); `expand_consumption` como el único camino
  de expansión, con `recipe_effect` en sus tres formas.
- **12 endpoints**, `alembic/versions/0009_recipes.py`, `tests/recipes/**`.

### `backend-consumo` — el consumo al enviar, la reversión y el costo en los reportes

- **El gancho**: `_freeze_item_consumption` en `app/orders/service.py`, llamado
  desde `_apply_send` — el único lugar donde un ítem pasa a `SENT`. Congela
  `recipe_version`, `unit_cost` (pesos) y `unit_cost_micros` (precisión), aplica
  rendimiento y `recipe_effect`, y escribe el libro con `cause=SALE`. Los tres
  canales (venta, cortesía, `staff_meal`) pasan por la misma línea: por eso el
  inventario les queda idéntico **por construcción**.
- **El `WasteStub` que 1b dejó abierto**: `ingredient_id` pasa de `Integer` pelado
  a **FK real** (`0010_consumption.py`), y `_resolve_waste_stub` lo resuelve
  leyendo **el libro**, nunca la ficha de hoy. No repone inventario, y la decisión
  está declarada en el docstring de la función.
- **La nota «vuelve»** (cerrada en ronda 2): `NoteLineIn.returns_to_stock`
  (`app/fiscal/schemas.py:177`) + `app/fiscal/service.py:865` llamando
  `reverse_item_consumption` por línea. El espejo se arma **desde el libro**, no
  desde la ficha, así que sigue siendo exacto aunque la receta haya cambiado.
- **Los reportes que se ampliaron sin rediseñarse**: `/admin/sales` (costo
  teórico, margen, % costeado), `/admin/orders` (cortesías a costo),
  `/admin/today` (las cuatro alertas de la fase), `NOTIFICATION_TYPES` (5 tipos),
  y el montaje de los dos dominios en `DOMAINS`/`MODEL_MODULES`.

### `frontend-recetas` — Carta y recetas, Preparaciones, producción rápida

`features/recipes/**` (13 archivos, 1.841 líneas) y 9 archivos nuevos en
`features/catalog/**`. Pestaña **Recetas** dentro de la Carta que ya existía
(fichas con food cost y su franja 28–35 %, cobertura, unidades sospechosas);
**Modificadores** gana el editor de `recipe_effect`, que estuvo en `null` todo
1b; **Preparaciones** (`/admin/preparaciones`) con cambio de modo tras PIN y
aviso previo de cierre de lotes; **Producir** (`/pos/produccion`), producción
rápida real en dos toques, sin un campo de costo en pantalla.

### `frontend-inventario` — Inventario, mermas, reportes con costo y la carcasa

`features/inventory/**` (19 archivos, 2.228 líneas). **Admin → Inventario** con
tres pestañas (Insumos con los 14 campos y `min_stock` validado `> 0` en el
cliente; Stock con los tres filtros del backend, nunca intersectados en el
cliente; Movimientos y mermas con la causa como **lista cerrada**).
**POS → Registrar merma** con los 8 tipos y sin la palabra «consumo de
personal», probado con un test que falla si aparece. **Hoy** gana cuatro
tarjetas con enlace correctivo; **Ventas** gana tres tiles y tres columnas.
Y la carcasa: `router.tsx`, `AdminLayout`, `PosLayout` registrando los dos
features nuevos — **verificado en el árbol**, no sólo declarado.

### `auditor-costos` — 284 invariantes ejecutables, 102 nuevos

`tests/audit/test_cost_invariants.py` (21), `test_consumption_invariants.py`
(29), `test_inventory_invariants.py` (25), más 3 en `test_security_invariants.py`
y 4 en `test_migration_invariants.py`; `frontend/src/audit/inventory.test.ts`
(15) y `cost-display.test.tsx` (5).

Lo que encontró y nadie más podía encontrar:

- **Los dos bloqueantes de la ronda 1**, los dos reales: la nota «vuelve» no
  revertía nada (y el esquema de entrada no tenía dónde decirlo), y un costo real
  de $0,003/g se publicaba como `0` con origen `official` — el cero mudo que la
  spec prohíbe, en la primera pantalla de la fase.
- **Siete advertencias**, escritas como test rojo, sin bajar ninguna de
  severidad entre rondas.
- **Un barrido de AST sobre todo `app/`** que prueba que nadie escribe un
  `StockMovement` fuera de `record_movement`. Es la regla que más fácil se viola
  por comodidad, y está cumplida incluso en el camino nuevo de la reversión.
- **Que el arreglo de un bloqueante puede pasarse de largo**: N-1 prueba que una
  línea «se usó» **no** vuelve al inventario. Sin ese test, el arreglo de B-1
  habría sido peor que el bug.

---

## 3. Coherencia

**Sí, el trabajo es coherente**, y lo verifiqué contra el código, no contra los
reportes.

- **Territorios disjuntos respetados**: 47 archivos modificados + 145 nuevos, sin
  un solo conflicto de escritura entre agentes. `app/catalog/**` y `app/stores/**`
  quedaron intactos en el backend, como pedía el reparto.
- **Los dos dominios están montados de verdad**: `inventory` y `recipes` en
  `DOMAINS` (`app/main.py:40-41`) y en `MODEL_MODULES`
  (`app/core/models_registry.py:32-33`), los dos con `find_spec_safe`.
  La app arranca: **134 rutas** en el OpenAPI, **63 tablas**.
- **Cadena de migraciones íntegra**: `0001 → 0010` sobre una base nueva, limpio.
  `backend-consumo` amplió la `0010` en vez de abrir una `0011`, para no mover el
  head que el invariante de migración fija.
- **Una sola escala numérica**: `app/core/quantity.py` es la única definición, y
  los dos dominios publican el costo con la misma función
  (`format_cost_micros`). La causa raíz de B-2 quedó documentada en el propio
  módulo (`:31-53`), que es la regla que faltaba.
- **La carcasa del frontend está cableada**: `recipesFeature` e `inventoryFeature`
  en `router.tsx`, `AdminLayout` y `PosLayout`.
- **El seed carga el camino nuevo** y es idempotente corriendo dos veces. Es el
  huérfano que hundió a 1b-2 y esta vez tuvo dueño.

**Lo que cambió respecto de los entregables.** Los reportes se escribieron
mientras el árbol se movía, así que hay párrafos que nacieron viejos. Los cierro
acá para que nadie los persiga:

- `frontend-recetas.md §8` declara que «`router.tsx`/`PosLayout`/`AdminLayout`
  todavía no importan `recipesFeature`». **Ya lo hacen**: `frontend-inventario`
  los cableó en la misma ronda.
- `backend-recetas.md §8` declara que falta el paso 0 (`DOMAINS`/
  `MODEL_MODULES`). **Está hecho** por `backend-consumo`.
- `backend-consumo.md §8.1` declara como CRÍTICO que la nota «vuelve» no está
  conectada. **Se cerró en la ronda 2** (B-1).
- `frontend-inventario.md §8.3` y `frontend-recetas.md §8` declaran el `CostValue`
  duplicado y dos tests rojos por eso. **Cerrado**: `costDisplay.tsx` re-exporta
  el componente compartido, y los 68 archivos de frontend están en verde.
- `docs/ESTADO.md` quedó escrito antes de que corrieran los dos frontends y el
  auditor, y **todavía dice que no corrieron**. Hay que actualizarlo (§6).

**Una honestidad que conviene registrar**: el informe del auditor predijo
**ocho** rojos con nombre y apellido. La corrida devolvió exactamente esos ocho,
ni uno más ni uno menos dentro de su territorio. El noveno cayó fuera de él.

---

## 4. Verificación

Corrida por mí, una vez, en serie, con el árbol quieto y sin procesos huérfanos
(`ps` confirmado antes de arrancar), sin builds del frontend mientras la suite
de backend corría.

| Comando | Resultado |
|---|---|
| `cd backend && python -m pytest -q` | **9 failed, 761 passed** en 36:17 |
| `cd backend && python -m mypy app` | limpio — 106 archivos |
| `cd frontend && npm run typecheck` | limpio |
| `cd frontend && npm run test` | **280 passed (280)**, 68 archivos, 57 s |
| `cd frontend && npm run build` | OK — `dist/` generado, 1.145 kB |
| `alembic upgrade head` (base nueva) | `0001 → 0010` limpio, **63 tablas** |
| `python -m app.seed` ×2 | carga insumos + fichas; la segunda no repite nada |
| `app.openapi()` | 134 rutas; 8 de inventario, 10 de recetas |

**Checklist vinculante de la spec** (`features/fase-2-costo-inventario/spec.md
§ Verificación del pedido`), ítem por ítem, contra tests que existen y corrieron:

- **17 de 20 en verde**, cada uno con su test nombrado en
  `outputs-2a/auditor-costos.md §2`, y los verifiqué en el árbol.
- **Ítem 8** (consumos del mismo insumo en una comanda se fusionan): **rojo**.
  Es A-1, y §5 explica por qué no es un olvido sino una colisión entre dos
  reglas de la spec.
- **Ítem 17** (dispositivo sin `cost` ni `margin`): **verde en sustancia, rojo en
  un test heredado**. Los seis invariantes acotados a dispositivo pasan, y
  `DeviceIngredientOut` publica `{id, name, base_unit}` y nada más. El rojo es el
  barrido global — R-9 en §5.
- **Ítem 19** (Admin 1024 px, POS 375 px, foco, contraste AA): **no cubierto**.
  Hace falta un navegador real y un medidor de contraste. Mismo hueco abierto
  desde 1a.
- **Ítem 20** (typecheck, suite y build en serie): es esta corrida.

---

## 5. Conflictos NO resueltos

Nueve rojos en la suite y cuatro decisiones pendientes. Ninguno está escondido.

### R-9 (el único rojo que NO es una advertencia declarada) — un invariante heredado aplica una regla de dispositivo al OpenAPI entero

```
FAILED tests/payments/test_documents.py::test_openapi_device_responses_never_expose_cost_fields
```

`tests/payments/test_documents.py:138-145` se llama «device responses» pero hace
esto:

```python
schema = app.openapi()
raw = json.dumps(schema)
for forbidden in ("\"cost\"", "\"margin\"", "\"unit_cost\""):
    assert forbidden not in raw
```

Serializa el documento **completo** y busca el texto. No mira rutas, no mira
sesiones. Los tres esquemas que lo rompen son, los tres, **de administrador**:

| Esquema | Campo | Ruta |
|---|---|---|
| `IngredientOut` | `cost` | `GET/POST/PATCH /admin/ingredients` |
| `PreparationAdminOut` | `unit_cost` | `GET /admin/preparations` |
| `PrepBatchAdminOut` | `unit_cost` | `GET /admin/preparations/{id}/batches` |

**El dispositivo está limpio**, y lo verifiqué yo: `DeviceIngredientOut` publica
`{id, name, base_unit}`, y los seis invariantes que sí están acotados a
dispositivo (`test_security_invariants.py` ~449, ~832, ~1475, más los tres de 2a)
pasan todos. **El test está equivocado, no el código.** Era correcto mientras el
producto no tenía superficie de costo para el administrador; el producto de esta
fase es exactamente esa superficie.

**Y esto convierte O-1 del auditor en una decisión obligatoria, no cosmética.**
Hay al menos tres copias de este barrido en el repo. Los builders esquivaron dos
renombrando campos de `/admin/sales` —publicaron `theoretical_value`,
`gross_contribution` y `recipe_coverage_pct` donde la spec pide
`theoretical_cost`, `gross_margin` y `costed_pct`— y la tercera no se puede
esquivar renombrando, porque el campo de un insumo se llama `cost` y llamarlo de
otra forma sería absurdo. **Un invariante mal acotado ya deformó el contrato
publicado de un reporte.** La salida es una sola: acotar los barridos a las rutas
de sesión de dispositivo, y devolverle a `/admin/sales` los nombres de la spec.

### R-1 a R-8 — los ocho rojos que el auditor escribió a propósito

Todos verificados por mí en el código, no sólo en el informe. Ninguno toca plata
cobrada, integridad del libro ni exposición de costo al operador.

| | Qué | Evidencia | Por qué es advertencia |
|---|---|---|---|
| **A-1** | Los consumos del mismo insumo en una comanda **no** se fusionan | `app/orders/service.py:1128-1129` escribe `ref_type="order_item"`, `ref_id=item.id`; la fusión de `app/inventory/hooks.py:94-108` junta por esa clave | El saldo es exacto. Se pierde la unidad de análisis. **Ver abajo: no es un olvido.** |
| **A-2** | `GET /admin/employees/{id}/activity` sin cortesías a costo | `app/shifts/schemas.py` no tiene ningún campo de costo (lo confirmé con un grep: cero coincidencias) | Falta un campo de un reporte; el dato existe a nivel de comanda. **`app/shifts/**` fue el único huérfano sin dueño del reparto.** |
| **A-3** | La cascada al sustituto se resuelve sobre **una** unidad y después se multiplica | `app/recipes/hooks.py:92-94` llama con `qty_final` unitario; `:261` multiplica después | La suma total consumida es exacta; lo que sale mal es **cuál** insumo queda negativo. Hoy afecta al único insumo con sustituto (la leche del seed). |
| **A-4** | Con `inventory.perpetual` apagada, «Hoy» alerta igual sobre insumos bajo mínimo | `app/reports/service.py:618, 625, 632, 639` sólo preguntan `find_spec_safe` (¿existe el módulo?), nunca `features.is_enabled` | Pérdida de señal, no de plata. Con el perfil `full` del seed no se ve — **y por eso hay que apagar la flag a propósito en el recorrido en navegador.** |
| **A-6** ×3 | «Platos que no descuentan» se recalcula con la carta de **hoy** | `app/recipes/hooks.py:354` re-expande la ficha vigente para decidir si una venta **pasada** descontó algo; `:357` publica `Product.name` en vez del nombre congelado del ítem | **La única que rompe una regla dura** (§11.2, snapshot). La cazó un invariante **heredado** de 1b-2, que es exactamente para lo que estaba puesto. |
| **A-7** | Las cortesías a costo de `/admin/orders` pierden el costo sub-peso | `app/orders/service.py:2012` suma `i.unit_cost * i.qty` (pesos ya redondeados por ítem); `unit_cost_micros` existe en `:1099` | Es B-2 sobreviviendo en el reporte hermano. Acotado a < $0,50 por ítem, pero `0` no es `null`. **El arreglo más barato de los nueve.** |

**A-1 merece una aclaración, porque el informe lo hace parecer un descuido y no
lo es.** El builder eligió la clave por ítem **deliberadamente** y lo dejó
escrito en `app/orders/service.py:1035-1044`: fusionar dos ítems distintos en una
sola fila los vuelve indistinguibles después, y ni el `WasteStub` de un ítem
anulado ni la reversión de una nota —que apuntan a un `item_id` concreto— podrían
desarmar cuánto de esa fila le tocaba a cada uno sin una segunda fuente de verdad
que duplique el libro. **Son dos reglas de la spec que chocan**: «se fusionan en
un movimiento» (§5.3) contra «la nota "vuelve" revierte como espejo exacto»
(§3.5). El builder eligió la que protege la integridad del inventario. Es una
decisión del dueño de la spec, no un bug que alguien tenga que ir a arreglar. Y
cerrarlo hoy cuesta más que en la ronda 1: el arreglo de B-1 sumó un tercer
lector por ítem.

### R-10 — el código no está bajo control de versión

`HEAD` es `dad3ee1`, el commit base del pedido. `git status`: **47 archivos
modificados y 145 sin tracking**, unas 30.000 líneas entre los dos grupos
(`backend/app/inventory/**`, `backend/app/recipes/**`, `app/core/quantity.py`,
las migraciones `0008`/`0009`/`0010`, los tres archivos de invariantes nuevos,
`frontend/src/features/{inventory,recipes}/**`, `frontend/src/audit/**`).

El código existe, corre y está verificado. **No está commiteado.** Mientras siga
así, esta verificación no es reproducible por nadie más.

### Decisiones pendientes (no son rojos, son preguntas para el dueño de la spec)

- **O-1 → ahora forzada por R-9**: acotar los barridos de dispositivo y devolver
  los nombres de la spec a `/admin/sales`. Dejarlo como está no es una opción:
  hay un test rojo y un contrato publicado que contradice la spec.
- **O-10 — `$ ,003` no es como un restaurante colombiano escribe esa cifra.**
  `frontend/src/lib/money.ts:70-72` omite el cero de la parte entera a propósito,
  y el motivo está escrito: `$ 0,003` repite en los dos primeros caracteres el
  patrón `$ 0` del cero mudo que el auditor persigue con
  `/\$\s*0(\D|$)/` (`cost-display.test.tsx:47`). El builder resolvió el conflicto
  cambiando el formato en vez de la cifra. **No se pierde un decimal**, pero si
  mañana alguien lo escribe `$ 0,003` —que sería lo razonable— el test se pone
  rojo sin que haya un defecto. La aserción correcta es
  `/\$\s*0(?![.,]\d)(\D|$)/`; aflojar un guard es decisión del dueño, no del
  auditor, y por eso quedó señalado y no cambiado.
- **A-5 — la escala de cantidades vive en dos lugares.**
  `app/reports/schemas.py:106-107` publica `qty_base: int`/`min_stock: int` en
  milésimas crudas; `app/inventory/schemas.py:143-144` publica los mismos datos
  como texto decimal. Hoy no hay bug (ninguna pantalla pinta esas cantidades); la
  primera que lo haga va a mostrar `117648 g` o va a dividir por 1.000 en el
  cliente. **Es el mismo modo de falla que B-2**, con cantidades en vez de costos.
- **O-6 — el KPI de mermas declara `float`** (`app/inventory/schemas.py:194`).
  Hoy siempre es `null`. Cuando 2b lo llene será el único número de la fase que
  viaja como `float`. Conviene decidirlo antes de que haya clientes.

### Observaciones menores, verificadas por mí

- **`GET /admin/recipes/coverage` usa `date_from`/`date_to`** mientras todos los
  demás listados admin usan los alias `from`/`to` (`app/reports/router.py:39-40`,
  `app/inventory/router.py:176-177`). `frontend-recetas` lo esquivó y lo
  documentó; nadie lo reportó como algo a corregir. Es un alias de una línea.
- **O-4 — los insumos no están detrás de ninguna flag**: `app/inventory/router.py`
  `:85`, `:102`, `:123`, `:148` y `:317` no tienen `require_feature`. No escriben
  inventario, así que el riesgo es bajo, pero es lo que hace que **A-4 se note**.
- **O-9 — ocho esquemas de respuesta no llegan al OpenAPI** porque sus rutas se
  anotan `-> Any` para poder servir `format=csv`. Dos de ellas son de dispositivo.
  El control no queda descubierto (hay un test que las recorre con datos reales),
  pero queda cubierto por un solo lado.
- **O-5 — `MovementCause.VOID_AFTER_SEND` está declarada y nunca se produce.**
  Decisión declarada en `app/orders/service.py:1240-1252`. Un reporte de merma
  por anulación agrupado por causa devuelve vacío; hay que leerlo de
  `waste_stubs`.

### Gaps estructurales (ninguno resoluble en este entorno)

- **Postgres real y el CI**: todo corrió en SQLite. Sin probar: enums nativos,
  `SELECT FOR UPDATE`, índices parciales y los `409` de carrera bajo bloqueo real.
  El test de producción concurrente acepta `[201,201]` o `[201,409]` por eso:
  **hay que volver a mirarlo en el CI**.
- **Recorrido en navegador real y checklist visual (ítem 19)**: sin Playwright ni
  medidor de contraste acá.
- **Rendimiento**: `low_stock_alerts` y `negative_stock_alerts` llaman
  `current_stock` una vez por insumo, y `_negative_streak` recorre todos los
  movimientos de cada insumo negativo. Con 6 insumos no se nota; con 300 y un año
  de libro, `GET /admin/today` hace 300 agregaciones. No está medido.

---

## 6. Próximos pasos, priorizados

1. **Commitear el trabajo** (R-10). 145 archivos nuevos y 47 modificados fuera de
   git. Es lo único que hoy separa esta fase de ser reproducible, y no depende de
   ninguna decisión: va primero.
2. **Acotar los barridos de dispositivo y devolver los nombres de la spec**
   (R-9 + O-1). Cierra el único rojo que no es una advertencia declarada **y** la
   divergencia entre el contrato publicado y la spec, con una sola decisión.
   Hay que revisar las tres copias, empezando por
   `tests/payments/test_documents.py:145`.
3. **Cerrar A-6** (la cobertura se recalcula con la carta de hoy). Es la única de
   las siete que rompe una **regla dura** (§11.2), la cazó un invariante heredado,
   y la cobertura de recetas alimenta la varianza de 2b: una varianza calculada
   sobre una cobertura que se reescribe sola no se puede defender ante el dueño.
   Se cierra leyendo el snapshot (`recipe_version`, o «sin movimientos con
   `ref_id = item.id`») en vez de re-expandir, y usando `OrderItem.product_name`.
4. **A-7 y A-2, los dos arreglos baratos de reporte.** A-7 es cambiar
   `i.unit_cost * i.qty` por el acumulado en micros que ya existe ocho líneas
   más arriba. A-2 **necesita que alguien sea dueño de `app/shifts/**`** — fue el
   único huérfano del reparto y es exactamente donde cayó.
5. **A-4 y O-4**: preguntar por `features.is_enabled("inventory.perpetual")` en
   los cuatro hooks de `/admin/today`, y poner los insumos detrás de su flag.
   Un restaurante con la función apagada no puede ver seis alarmas que no puede
   resolver.
6. **Decidir A-1** (fusión por comanda vs espejo exacto por ítem). Es una colisión
   entre dos reglas de la spec, no un bug: o se corrige la spec, o se agrega la
   agregación en la lectura. Mi recomendación: **dejar la clave por ítem**
   —protege la integridad del libro por construcción— y agregar por comanda al
   leer, que es donde hace falta para 2b.
7. **Unificar la escala de cantidades** (A-5) antes de que una pantalla pinte
   `qty_base`. Y decidir el tipo del KPI de mermas (O-6) antes de que 2b lo llene.
8. **A-3** (la cascada al sustituto). Pasar la cantidad total a
   `resolve_consumption_target` en vez de la unitaria.
9. **Recorrer 2a en navegador real** con base recreada desde cero, y cerrar el
   ítem 19 con un medidor de contraste. Dos cosas que mirar sí o sí: que
   Inventario → Insumos diga «Sal de mesa $ ,003 estimado» y no `$ 0` (es la
   confirmación visual de B-2), y **A-4 con `inventory.perpetual` apagada a
   propósito**, porque con el perfil `full` del seed no aparece.
10. **Actualizar `docs/ESTADO.md`**: hoy dice que los dos frontends y el auditor
    «no corrieron todavía». Corrieron, y esta verificación cierra la fase.

---

## 7. La lección de reparto de este pedido

1b-2 terminó con tres rojos, y los tres cayeron en archivos que no estaban en el
territorio de nadie. Este pedido nombró dueño para `app/seed.py`,
`tests/core/**`, `tests/conftest.py`, `features/settings/**`, `features/auth/**`
y los tres archivos de montaje. **Ninguno de ellos falló.** El único huérfano que
no se nombró fue `app/shifts/**` — y ahí cayó A-2. La regla funciona exactamente
hasta donde se aplica.

La lección nueva es otra, y la dejó R-9: **un invariante también tiene
territorio, y también envejece**. `test_openapi_device_responses_never_expose_
cost_fields` era correcto cuando el sistema no tenía superficie de costo para el
administrador. La fase 2a existe para construir esa superficie. Nadie lo revisó
porque los invariantes heredados se tratan como piso y no como código — y el
costo real no fue el test rojo: fue que dos builders, para pasar dos copias del
mismo barrido, **renombraron campos del contrato publicado** y lo dejaron
divergiendo de la spec.

Para el próximo reparto: cuando una fase agrega una superficie **nueva por
diseño**, hay que listar de entrada los invariantes heredados que la prohíben, y
asignarle a alguien la decisión de acotarlos. Un guard que nadie puede cambiar se
termina esquivando, y esquivarlo sale más caro que discutirlo.
