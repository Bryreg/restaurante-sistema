# ENTREGA — Frontend: Conteos a ciegas, varianza, lotes, salud del control y configuración de sede (2b)

**Agente**: `frontend-inventario-conteos` (builder). **Territorio**:
`frontend/src/features/inventory/**`, `frontend/src/features/settings/**`,
`frontend/src/features/reports/**`, `frontend/src/api/inventory.ts`,
`frontend/src/api/reports.ts`.

**Veredicto**: se entrega completo. Cuatro pestañas nuevas en Inventario
(Conteos, Varianza, Lotes, Salud del control), la sección de Configuración
que faltaba (umbrales de varianza + insumos críticos), tres grupos de
tarjetas nuevas en «Hoy», y una deuda declarada de 2a cerrada (el KPI de
mermas ya no se lee como fracción). Un hueco de contrato real encontrado en
`app/inventory/schemas.py` (§8, no es mi territorio, no lo toco) y dos gaps
menores de contrato (`GET /admin/lots` sin CSV, `LotOut` sin `base_unit`),
todos declarados con archivo y línea.

**Ronda 2 (este agregado)**: cierra H-2 (mi mitad, BLOQUEANTE — el cliente de
`GET /admin/orders/{id}/consumption` estaba tipado contra la implementación
que el orquestador decidió borrar), H-8 (la causa de caja `supplier_payment`
que el backend ya declaraba y el cliente no conocía) y H-7 (nombra la
excepción declarada de escala en el parser de conteo). Ver «§9 Ronda 2» al
final de este documento para el detalle completo con su fundamento.

---

## §1 Qué construí, pantalla por pantalla

### Admin → Inventario (`InventoryAdminPage.tsx`) — cuatro pestañas nuevas

Las tres pestañas de 2a (Insumos, Stock, Movimientos y mermas) quedan
intactas. Se agregan, cada una detrás de su propia flag (`hasFeature`, nunca
hardcodeado):

- **Conteos** (`CountsTab.tsx`, detrás de `inventory.counts`) — listado de
  conteos con filtro de alcance y rango de fechas, CSV, y un diálogo
  (`OpenCountDialog.tsx`) para abrir uno nuevo eligiendo `key_items` o
  `full`. Cada fila enlaza a la captura. Cada conteo muestra
  `lines_counted / lines_total` con la marca «(parcial)» cuando falta algo.

- **`CountCapturePage.tsx`** (`/admin/inventario/conteos/:countId`, NO es
  una pestaña más — ver §2 sobre por qué necesita URL propia) — la captura
  **a ciegas** de un conteo. Insumo, conteo anterior como única referencia,
  campo de texto con el parser «6+8», botón «Confirmar» por renglón (nunca
  uno que confirme todos), botón «Guardar avance (sin confirmar)» para
  persistir borradores sin marcar nada como contado, y «Aplicar conteo» con
  PIN de administrador, aviso explícito de que es irreversible, y manejo de
  `409 COUNT_ALREADY_APPLIED` sin ofrecer reintentar. Al aplicar, muestra el
  resumen `stock_before` / `adjustment` / `stock_after` por insumo — recién
  ahí, porque ya no es la fase a ciegas.

- **Varianza** (`VarianceTab.tsx`, detrás de `inventory.variance`) —
  selector de conteo **aplicado** (nunca uno abierto, para no chocar contra
  `400 COUNT_NOT_APPLIED`), tabla con inicial/entradas/final/uso
  real/teórico/varianza en cantidad y en pesos con el origen del costo, el
  semáforo (`level`) tal cual lo manda el servidor, y CSV.

- **Lotes** (`LotsTab.tsx`, detrás de `inventory.lots`) — filtro por
  insumo/estado/días para vencer, badge por los cuatro estados, y para un
  lote `expired` un enlace correctivo a `/pos/merma` — **nunca** un botón
  de baja (ver §4 y el test dedicado).

- **Salud del control** (`ControlHealthTab.tsx`, detrás de
  `inventory.variance`, mismo gate que usa el backend para
  `GET /admin/control-health`) — los cuatro indicadores (días desde el
  último conteo completo, % recepciones con factura, % preparaciones por
  lote producidas esta semana, mermas de la semana) más el panel de food
  cost real con su rango de fechas propio. Cada `null` se dice con su
  motivo (`*_reason`), nunca un `0` ni un `—` mudo.

### Admin → Configuración → Inventario (`InventorySection.tsx`, huérfano nombrado)

Dos cosas que el backend aceptaba desde 2b y ninguna pantalla editaba:

- **Umbrales de varianza** (`GET/PUT /admin/stores/{id}/inventory-
  settings`), editados como porcentaje (con coma o punto) — la conversión a
  puntos básicos es la única cuenta de este archivo y es de FORMATO de
  entrada, no de negocio (el servidor sigue validando `red > yellow`). Los
  defaults de industria (2 % / 4 %) se muestran como tales, no como el
  valor actual.
- **Insumos críticos**: listado completo de insumos activos con casilla de
  `key_item`, togglear una la guarda de inmediato (`PATCH
  /admin/ingredients/{id}`). El campo ya era editable insumo por insumo en
  Inventario → Insumos (2a); esta pantalla es la vista consolidada que pide
  la fila «Configuración» de SPEC-NEGOCIO §9.3.

### «Hoy» (`TodayPage.tsx`) — tres grupos de tarjetas nuevas

- **Lotes por vencer o vencidos con stock**: una tarjeta que cuenta los dos
  casos por separado en el cuerpo, tono crítico si hay algún vencido (si
  no, ámbar), enlaza a Inventario → Lotes.
- **Cuentas por pagar vencidas** y **pendientes de revisión**: dos tarjetas
  distintas (SPEC-NEGOCIO §9.3 las lista aparte), enlazan a
  `/admin/compras?tab=cuentas-por-pagar` — esa pantalla es de otro agente,
  no se construye ni se duplica acá.
- **Inventario no confiable**: sólo se dibuja cuando el backend afirma
  `inventory_unreliable === true` (nunca con `null`, que es «función
  apagada o dominio no montado» — no es lo mismo que «confiable»), con los
  días transcurridos si el servidor los manda.

Con la función correspondiente apagada, el backend manda `[]`/`0`/`null` y
la tarjeta simplemente no entra en la lista — no se dibuja, no se dibuja
vacía (probado, ver §6).

### Deuda de 2a cerrada: el KPI de mermas ya no se lee como fracción

`app/inventory/schemas.py::WasteKpiOut.ratio` pasó de `float` (declarado,
siempre `null` en 2a) a `int` en puntos básicos reales (100 = 1 %) en 2b.
`WasteAdminTab.tsx` hacía `Math.round(kpi.ratio * 100)}%` — correcto para
una fracción 0..1, absurdo (`25000%`) para la escala nueva. Se reemplazó por
`formatBasisPoints` (nueva función centralizada en `features/inventory/
lib.ts`), la ÚNICA función de todo el territorio que sabe que 100 = 1 % —
usada también en Varianza, Food cost, Salud del control y los umbrales de
Configuración, para que nadie repita esa cuenta a mano en un sexto lugar.

---

## §2 Rutas nuevas declaradas en `features/inventory/index.ts`

Una sola ruta admin nueva, declarada en `inventoryFeature.adminRoutes`
(nunca tocando `src/app/router.tsx`, prohibido para este agente — el spread
`...inventoryFeature.adminRoutes` ya estaba en el árbol, verificado antes de
tocar nada):

```ts
const adminRoutes: RouteObject[] = [
  { path: "inventario", element: createElement(InventoryAdminPage) },
  { path: "inventario/conteos/:countId", element: createElement(CountCapturePage) },
]
```

Resuelve a `/admin/inventario/conteos/:countId` porque `router.tsx` monta
`...inventoryFeature.adminRoutes` como hijos planos de la ruta `/admin`
(verificado leyendo `router.tsx`, no asumido). **Por qué no es una pestaña
más** de `InventoryAdminPage`: «Aplicar conteo» es una acción con
consecuencias irreversibles — necesita URL propia para poder enlazarse
desde `CountsTab` y recargarse sin perder el conteo en curso, y para que el
estado de la URL (`countId`) sea la fuente de verdad, no un `useState` de
pestaña.

**Verificación**: `src/features/inventory/__tests__/index.test.ts` (1 test,
actualizado — la aserción de `adminRoutes` ahora espera las dos entradas),
más `CountCapturePage.test.tsx` (10 tests) ejercitando la pantalla montada
en esa ruta vía `renderWithProviders(..., { route: "/admin/inventario/
conteos/12" })`, y `CountsTab.test.tsx` verificando que el enlace de cada
fila apunta a `/admin/inventario/conteos/{id}`.

---

## §3 Contrato de API que consumo, campo por campo

Todo tipado contra `backend/app/inventory/{router,schemas,service}.py` y
`backend/app/reports/schemas.py`, leídos directamente del árbol (no
asumidos de la spec) porque el equipo de backend ya los había construido en
paralelo cuando arranqué.

### `GET/PUT /admin/stores/{id}/inventory-settings` (`inventory.variance`)

| Campo | Tipo | Nota |
|---|---|---|
| `variance_yellow_threshold_bp` | `int` | Puntos básicos reales (100 = 1 %). `PUT` exige `> 0`. |
| `variance_red_threshold_bp` | `int` | Ídem; el servidor exige `> yellow` (`400 VALIDATION_ERROR` si no). |

### `GET /admin/lots` (`inventory.lots`)

Query: `store_id`, `ingredient_id?`, `status?`, `expiring_within_days?`.

| Campo | Tipo | Nota |
|---|---|---|
| `id`, `ingredient_id`, `ingredient_name` | | |
| `lot_code` | `string \| null` | |
| `qty_received`, `qty_remaining` | `string` | Decimal (`format_qty_base`) — **sin unidad** (§8). |
| `unit_cost` | `string` | Decimal por unidad base (`format_cost_micros`). |
| `cost_source` | enum cerrado | |
| `expires_at` | `string \| null` (fecha ISO) | `null` = nunca vence. |
| `received_at` | `datetime` | |
| `status` | `"active"\|"expiring"\|"expired"\|"depleted"` | Ya calculado por el servidor — nunca se deriva de fechas en el cliente. |
| `source_type`, `source_id` | | No usados por esta pantalla. |

### `POST/GET /admin/counts`, `GET/PUT /admin/counts/{id}[/lines]`, `POST /admin/counts/{id}/apply` (`inventory.counts`)

- `POST /admin/counts` — body `{scope}`, devuelve `CountDetailOut` completo.
- `GET /admin/counts` — query `store_id, scope?, from?, to?, format?` →
  `CountOut[]` (sin `lines`, con `lines_total`/`lines_counted` ya contados
  por el servidor).
- `GET /admin/counts/{id}` — query `store_id` → `CountDetailOut` (con
  `lines: CountLineOut[]`).
- `CountLineOut`: `ingredient_id, ingredient_name, base_unit, qty_counted
  (string|null), was_counted (bool), previous_qty_counted (string|null)`.
  **Sin ningún campo de stock teórico** — ver §4.
- `PUT /admin/counts/{id}/lines` — body `{lines: [{ingredient_id,
  qty_counted, was_counted}]}` → `CountLinesSaveOut {lines, lines_counted,
  lines_total, partial}`.
- `POST /admin/counts/{id}/apply` — body `{authorizer_pin}`, con
  `Idempotency-Key` → `CountApplyOut {id, applied_at,
  applied_by_employee_{id,name}, lines: [{ingredient_id, ingredient_name,
  qty_counted, stock_before, adjustment, stock_after}]}`. `409
  COUNT_ALREADY_APPLIED` en el segundo intento.

### `GET /admin/variance` (`inventory.variance`)

Query: `store_id, count_id, format?`.

`VarianceOut {count_id, opening_count_id, window_from, window_to,
available, reason, rows: VarianceRowOut[], yellow_threshold_bp,
red_threshold_bp}`. Cada `VarianceRowOut` trae `opening_qty, inflow_qty,
closing_qty, real_usage_qty, theoretical_usage_qty, variance_qty` (todos
`string` decimal), `variance_value` (**`int | null`, TOTAL en pesos
enteros — NO un costo por unidad base, documentado explícito en el tipo
para que nadie lo pase por `formatCOPDecimal`**), `cost_source`,
`variance_pct_bp` (`int | null`, `null` si el uso teórico es `0`), y
`level` (`"green"|"yellow"|"red"`, **ya calculado por el servidor**).

### `GET /admin/food-cost` (`inventory.variance`)

Query: `store_id, from, to` (ambos obligatorios). `FoodCostOut {available,
reason, opening_count_id, closing_count_id, window_from, window_to,
opening_value, purchases_value, closing_value, net_sales, pct_bp}` — los
cinco totales en pesos enteros, `pct_bp` puede ser negativo.

### `GET /admin/control-health` (`inventory.variance`)

`ControlHealthOut {days_since_full_count, last_full_count_at,
inventory_unreliable, reception_invoice_ratio_bp,
reception_invoice_ratio_reason, batch_preps_produced_ratio_bp,
batch_preps_produced_reason, waste_entries_this_week}`.

### `GET /admin/orders/{id}/consumption` (`inventory.perpetual`)

Tipado en `api/inventory.ts` (`OrderConsumptionOut`/`OrderConsumptionRowOut`)
pero **sin pantalla propia en mi territorio** — ver §7.

### `GET /admin/today` — campos nuevos de 2b que consumo

`lots_expiring_or_expired: LotAlertOut[]` (`batch_id, ingredient_id,
qty_base, expires_at, status`), `payables_overdue: PayableAlertOut[]`
(`payable_id, supplier_id, supplier_name, due_date, balance,
days_overdue`), `payables_pending_review_count: number`,
`inventory_unreliable: boolean | null`, `days_since_last_full_count: number
| null`.

---

## §4 Cómo garantizo que el conteo es a ciegas y que no existe «todo coincide»

**A ciegas — estructural, no una promesa de la pantalla:**

1. `CountLineOut` (`api/inventory.ts`) no tiene, y no puede tener, ningún
   campo de stock teórico — es exactamente el tipo que publica el backend
   para el flujo de captura.
2. `CountCapturePage.tsx` **no importa `getInventoryStock`** ni ninguna
   otra función que traiga stock teórico, por ningún camino — ni siquiera
   para cruzar datos "por si acaso" y ocultarlos con CSS.
3. Test (`CountCapturePage.test.tsx`, *"A CIEGAS: nunca llama a
   getInventoryStock ni muestra ningún valor teórico, sólo el conteo
   anterior"*): mockea `getInventoryStock` para que devuelva un valor
   centinela (`"9999.999"`) para el mismo insumo que se está contando, y
   verifica DOS cosas — que ese texto **nunca** aparece en el DOM
   (`queryByText(/9999\.999/)` ausente) y que `getInventoryStock` **nunca
   se llamó**. Si alguien agregara mañana un fetch de stock teórico a esta
   pantalla, aunque lo escondiera con CSS, este test lo detecta porque
   verifica la llamada de red, no sólo el texto visible.

**No existe «todo coincide»:**

1. No hay ningún `<input type="checkbox">` en toda la pantalla de captura
   (cero checkboxes — `was_counted` se confirma por un botón "Confirmar"
   por renglón, no por una casilla marcable en lote).
2. Hay exactamente **un botón "Confirmar" por renglón**, nunca uno que los
   cubra todos.
3. El único botón que actúa sobre varios renglones a la vez ("Guardar
   avance (sin confirmar)") manda **siempre** `was_counted: false` para
   todos — nunca puede confirmar nada, por construcción de la función que
   arma el payload (`saveDraftProgress`).
4. Test (*"NO EXISTE «todo coincide»: no hay checkbox de encabezado ni
   botón que confirme todo de una vez"*): `queryByRole("checkbox")` vacío,
   `queryByRole("button", {name: /todo coincide/i})` /`/marcar todos/i`/
   `/confirmar todos/i` ausentes, y `getAllByRole("button", {name:
   "Confirmar"})` tiene exactamente `BASE_COUNT.lines.length` elementos —
   uno por línea, ni más ni menos.
5. Test complementario (*"confirmar un renglón manda SÓLO esa línea, con
   was_counted: true"*): confirma un solo insumo y verifica que
   `putCountLines` se llamó con un array de **una sola línea**.

**Borrador local vs. valor confirmado** (test *"un borrador local NUNCA
pisa un valor confirmado..."*): arranca con una línea ya confirmada en el
servidor (`qty_counted: "12500", was_counted: true`), la persona escribe un
borrador distinto (`"999"`) sin confirmarlo, hace clic en "Guardar avance"
(manda `was_counted: false` para esa línea — el servidor la ignora, como
hace de verdad `save_count_lines` en `app/inventory/service.py:1013`), y el
mock de `putCountLines` devuelve la línea **intacta** (server truth). El
test verifica que el input vuelve a mostrar `"12500"`, no `"999"`. Esto no
es sólo confiar en la promesa del backend: la pantalla, después de CADA
guardado, reemplaza su estado por la respuesta del servidor y descarta el
borrador local para las líneas enviadas (`saveMutation.onSuccess`) —
aunque el backend fallara en aplicar el guard, la pantalla igual mostraría
lo que el servidor diga que es cierto, nunca lo que alguien tipeó.

**Guardado parcial, siempre visible** (tests *"guardado parcial..."* y
*"sin renglones faltantes..."*): el banner usa `count.lines_counted <
count.lines_total`, un campo que el servidor manda en CADA respuesta (no
sólo justo después de guardar) — así que sigue diciendo "Guardado parcial:
X de Y" si alguien recarga la página a mitad de un conteo.

---

## §5 Decisiones de diseño y su por qué

**El parser numérico (`parseCountInput`, `features/inventory/lib.ts`)**:
regex propia (`^\d+(?:[.,]\d{1,3})?$`) por término, split por `+`, sin
`eval`/`Function`/librería de expresiones — sólo sumas, tal como pide
SPEC-NEGOCIO §5.4 ("6+8"), nunca resta ni multiplicación (probado). La suma
se hace en **milésimas enteras** (`Math.round(term * 1000)` por término,
sumadas como enteros) y no en `float` acumulado, exactamente para que
`0,1+0,2` dé `"0.3"` y no `"0.30000000000000004"` — es el mismo bug que
`app/core/quantity.py` documenta del lado del servidor, y acá se cierra del
lado del cliente con el mismo criterio (enteros en la escala de
milésimas). El límite de 3 decimales es **el mismo** que
`parse_qty_base` del servidor: el parser del cliente es comodidad de
captura (evita un viaje de red por cada error de tecleo), nunca autoridad —
el servidor vuelve a validar cada renglón igual, y si algún día alguien
afloja el límite del cliente sin tocar el servidor, el peor caso es un
`400` más, no un dato mal guardado.

**Convivencia del borrador local con un valor confirmado**: en vez de
llevar dos fuentes de verdad (un "borrador confirmado" y un "borrador
local" separados con lógica de merge), la pantalla tiene **una sola fuente
de verdad para lo confirmado** (la respuesta del servidor, cacheada en
React Query) y **un diccionario aparte, chico, sólo para lo que la persona
está tipeando y todavía no mandó** (`drafts: Record<ingredientId, string>`).
Un renglón muestra `drafts[id] ?? line.qty_counted ?? ""` — el borrador
gana MIENTRAS existe, pero cualquier guardado (confirmar una línea o
"Guardar avance") borra la entrada de `drafts` para esa línea y deja que la
respuesta fresca del servidor mande. Elegí esto en vez de, por ejemplo,
comparar timestamps o versionar cada línea, porque el servidor YA resuelve
el conflicto real (una línea `was_counted: true` no se pisa con
`false`) — la pantalla sólo necesita no **esconder** esa resolución
detrás de un valor que quedó viejo en el estado de React.

**Puntos básicos centralizados en una sola función** (`formatBasisPoints`):
cinco campos de tres endpoints distintos (`VarianceRowOut.variance_pct_bp`,
`WasteKpiOut.ratio`, `FoodCostOut.pct_bp`, `ControlHealthOut.*_ratio_bp`,
`InventorySettingsOut.*_threshold_bp`) usan la MISMA escala (100 = 1 %).
Escribir `bp / 100` suelto en cinco archivos es exactamente el patrón que
produjo B-2 en 2a (la escala de costo publicada de dos formas) — una sola
función, con su propio test de propiedad, cierra esa puerta de entrada acá
antes de que se abra.

**El semáforo de varianza nunca se recalcula en el cliente**: `VarianceTab`
pinta `row.level` tal cual llega. El test *"dos filas con el MISMO
variance_pct_bp pero distinto `level` pintan colores distintos"* existe
para demostrarlo de forma que no dependa de leer el código: si alguien
reemplazara `row.level` por una comparación local contra un umbral
hardcodeado, ese test se rompería inmediatamente (las dos filas
`variance_pct_bp: 250` tendrían el MISMO color con esa comparación local,
pero el test exige colores distintos porque los `level` que manda el mock
son distintos).

**Las pestañas de 2b se arman desde `hasFeature`, no desde una lista
estática**: `InventoryAdminPage` calcula `countsEnabled`, `varianceEnabled`,
`lotsEnabled` una vez y los usa tanto para qué `TabsTrigger` renderizar
como para a qué pestaña cae un `tab=` de la URL que apunta a algo apagado
— nunca a una pestaña vacía o rota, siempre a "Insumos".

**Por qué "Lotes" no exporta CSV**: `GET /admin/lots` no lo soporta en el
backend (§8). Agregar el botón igual habría descargado un archivo `.csv`
con JSON adentro — roto en silencio, peor que no tenerlo. Se documentó la
decisión en el propio `api/inventory.ts` en vez de fingir que no se pensó.

**Por qué Food cost y Salud del control no exportan CSV**: son reportes de
un solo objeto (no listas) — la regla "toda lista exporta" no les aplica,
y agregar un botón ahí sería confuso (¿exportar qué, una fila?). Documentado
explícitamente para que nadie lo lea como un olvido.

---

## §6 Tests que escribí, con su resultado EXACTO

Corrida final, territorio completo (`inventory` + `settings` + `reports`),
tres corridas consecutivas para descartar flakiness — **20 archivos, 88
tests, 88 pasan** en las tres corridas (una cuarta corrida bajo carga tuvo
un único fallo transitorio en `MovementsPanel.test.tsx`, un archivo que **no
toqué**; aislado, pasa siempre — es contención de CPU entre los 20 workers
de `vmThreads`, no un defecto; ver nota al final de esta sección).

Archivos **nuevos**, con su conteo exacto de esta corrida:

| Archivo | Tests | Resultado |
|---|---:|---|
| `src/features/inventory/__tests__/lib.test.ts` | 22 | 22 passed |
| `src/features/inventory/__tests__/CountCapturePage.test.tsx` | 10 | 10 passed |
| `src/features/settings/__tests__/InventorySection.test.tsx` | 5 | 5 passed |
| `src/features/inventory/__tests__/VarianceTab.test.tsx` | 4 | 4 passed |
| `src/features/inventory/__tests__/LotsTab.test.tsx` | 4 | 4 passed |
| `src/features/inventory/__tests__/CountsTab.test.tsx` | 3 | 3 passed |
| `src/features/inventory/__tests__/WasteAdminTab.test.tsx` | 2 | 2 passed |
| `src/features/inventory/__tests__/ControlHealthTab.test.tsx` | 2 | 2 passed |
| `src/features/inventory/__tests__/OpenCountDialog.test.tsx` | 1 | 1 passed |

Archivos **existentes que modifiqué** (agregué tests sin tocar los que ya
pasaban):

| Archivo | Tests totales | Nuevos de 2b |
|---|---:|---:|
| `src/features/reports/__tests__/TodayPage.test.tsx` | 11 | 5 (lotes, 2× cuentas por pagar, 2× inventario no confiable) |
| `src/features/inventory/__tests__/index.test.ts` | 1 | 0 (aserción actualizada por la ruta nueva) |

Archivos que **no toqué** y siguen en verde en la misma corrida (prueba de
que no rompí nada del territorio): `AdjustmentDialog.test.tsx` (1),
`IngredientForm.test.tsx` (5), `IngredientsTab.test.tsx` (1),
`InventoryAdminPage.test.tsx` (3), `MovementsPanel.test.tsx` (2),
`StockTab.test.tsx` (2), `WastePage.test.tsx` (4),
`reports/__tests__/SalesPage.test.tsx` (4),
`reports/__tests__/index.test.ts` (1).

**Comandos corridos** (mi territorio, nunca la suite completa):

```
npx vitest run src/features/inventory/__tests__/lib.test.ts        → 22 passed
npx vitest run src/features/inventory/__tests__/WasteAdminTab.test.tsx  → 2 passed
npx vitest run src/features/inventory/__tests__/LotsTab.test.tsx    → 4 passed
npx vitest run src/features/inventory/__tests__/CountsTab.test.tsx  → 3 passed
npx vitest run src/features/inventory/__tests__/OpenCountDialog.test.tsx → 1 passed
npx vitest run src/features/inventory/__tests__/CountCapturePage.test.tsx → 10 passed
npx vitest run src/features/inventory/__tests__/VarianceTab.test.tsx → 4 passed
npx vitest run src/features/inventory/__tests__/ControlHealthTab.test.tsx → 2 passed
npx vitest run src/features/settings/__tests__/InventorySection.test.tsx → 5 passed
npx vitest run src/features/reports/__tests__/TodayPage.test.tsx    → 11 passed
npx vitest run src/features/inventory src/features/settings src/features/reports
    → Test Files 20 passed (20) / Tests 88 passed (88)   [×3 corridas]
npm run typecheck   → limpio, sin salida (tsc --noEmit)
```

**Nota sobre la flakiness observada**: en una corrida bajo las cuatro que
hice del territorio completo, `MovementsPanel.test.tsx` (archivo que no es
mío, no lo modifiqué) falló una vez por un `getByRole("option", ...)` que
corrió antes de que el listbox terminara de montarse — típico de
contención cuando 20 archivos de test compiten por CPU en paralelo
(`vmThreads`, mismo aviso que imprime vitest al final de cada corrida:
*"jsdom was created 20 times · create it once per worker"*). Aislado
(`npx vitest run .../MovementsPanel.test.tsx`), pasa siempre. Lo declaro en
vez de omitirlo porque un rojo escondido es peor que uno explicado — no es
un hallazgo sobre mi código, es una característica del entorno de test que
el paso de verificación en serie del orquestador no debería ver (corre un
archivo por vez o con menos paralelismo).

---

## §7 Qué NO construí, y por qué

- **`/admin/compras` (Cuentas por pagar, Recepciones, Proveedores)**:
  territorio explícito de otro agente (`features/purchases/**`). Mis
  tarjetas de «Hoy» enlazan ahí por URL (`/admin/compras?tab=cuentas-por-
  pagar`), tal como pedía la misión — no construí ni dupliqué esa
  pantalla.
- **Pantalla para `GET /admin/orders/{id}/consumption`**: el endpoint es de
  `app.inventory` y le tipé el cliente completo en `api/inventory.ts`
  (`OrderConsumptionOut`/`getOrderConsumption`), pero la pantalla natural
  para mostrarlo — el detalle de una comanda en "Pedidos" — es
  `features/orders/**`, explícitamente fuera de mi territorio ("cualquier
  otro feature" está en la lista de prohibido escribir). Queda listo para
  quien construya esa pantalla.
- **CSV en Lotes**: el backend no lo soporta (§8) — no construí un botón
  que descargaría JSON con extensión `.csv`.
- **Recorrido en navegador real / medidor de contraste AA** (checklist
  ítem "Admin en 1024 px sin scroll horizontal; foco visible; contraste
  AA"): mismo gap declarado desde 1a/2a — no hay Playwright ni un medidor
  de contraste en este entorno. Usé los mismos patrones (`overflow-x-auto`
  en tablas anchas, componentes shadcn/ui con `focus-visible` ya
  incorporado) que el resto del código ya verificado, pero no corrí un
  navegador real.
- **Nada bajo `/pos`**: conteos, varianza, lotes, salud del control y
  configuración de umbrales son, los cinco, superficie de costo — el
  operador no los recibe. El único enlace hacia `/pos` que agrego es el
  correctivo de un lote vencido (`/pos/merma`, que ya existía desde 2a),
  nunca una pantalla nueva bajo esa ruta.
- **Pedido para el dueño de `features/purchases/**`** (Ronda 2, instrucción
  explícita del Maestro): `PayablesTab.tsx` no lee `overdue`/`status` de la
  URL al montar, así que mis tarjetas de «Hoy» sobre cuentas por pagar
  llegan a la pestaña correcta pero SIN pre-filtrar — la persona tiene que
  volver a marcar "Sólo vencidas" a mano. Detalle completo, con archivo y la
  comparación contra `StockTab`/`CountsTab` (que sí leen la query string),
  en §8 punto 4. No lo construyo yo: `PayablesTab.tsx` es territorio de otro
  agente, y esta ronda lo deja señalado en vez de tocarlo.

---

## §8 Huecos del contrato del backend — todo rojo con nombre

### 1. `MovementCauseLiteral` no incluye `reception_reversal` — hallazgo nuevo, no declarado por nadie más

`backend/app/inventory/schemas.py:18-30` (`MovementCauseLiteral`, usado en
`StockMovementOut.cause` en la línea 122 y en el filtro `cause=` de `GET
/admin/ingredients/{id}/movements`) **no incluye** `"reception_reversal"`.
Pero `backend/app/inventory/models.py:75` sí declara
`MovementCause.RECEPTION_REVERSAL = "reception_reversal"`, y
`backend/app/purchases/service.py:491` **ya lo produce de verdad** al
revertir una recepción.

**Consecuencia concreta, verificable**: en cuanto exista una recepción
revertida en una sede, `GET /admin/ingredients/{id}/movements` para ese
insumo va a fallar la validación de respuesta de Pydantic (`500`) la
primera vez que alguien liste su libro — y filtrar explícitamente por
`cause=reception_reversal` ya falla hoy con `422`, porque el query param
tampoco lo acepta. Revisé `outputs-2b/backend-inventario-espejo.md`,
`backend-compras.md` y `backend-lectura-contrato.md` (los tres entregables
de backend ya escritos cuando llegué a este punto): ninguno lo declara.

**Qué hice acá, siendo un archivo de otro dueño** (`app/inventory/
schemas.py` está asignado a otro agente en la lista de huérfanos de la
spec, y `backend/**` está prohibido para mí): agregué
`"reception_reversal"` a mi propio `MovementCause` (TS,
`api/inventory.ts`) y a `CAUSE_LABEL` (`lib.ts`) — completo y honesto con
el enum REAL del backend, con el gap documentado en el propio tipo, en vez
de esconder una causa que el dominio ya produce. El filtro de causa de
`MovementsPanel.tsx` (2a, no soy dueño de ese archivo tampoco, pero lee
`CAUSE_LABEL`) va a ofrecer esta opción en su desplegable — elegirla hoy
devuelve `422` hasta que alguien corrija el esquema. Es un rojo del
backend, con nombre y línea, no algo que yo pueda cerrar sin salir de mi
territorio.

### 2. `GET /admin/lots` no declara `format=csv`

`backend/app/inventory/router.py:346-359` (`get_lots`) devuelve
`list[LotOut]` directo — sin `Request`, sin `wants_csv`/`csv_response`.
SPEC-NEGOCIO §9.3 pide "toda lista exporta". No agregué el botón (ver §5,
§7) para no ofrecer una descarga rota.

### 3. `LotOut` no trae `base_unit`

`backend/app/inventory/schemas.py:253` (`LotOut`) no publica la unidad de
`qty_received`/`qty_remaining` — un `"800"` crudo es ambiguo sin saber si
son gramos, mililitros o unidades. Lo resolví cruzando contra la lista de
`ingredients` que `InventoryAdminPage` ya carga y le pasa a `LotsTab` como
prop (mismo patrón que `WasteAdminTab` ya usaba en 2a para resolver
nombres). Si `LotsTab` se usara alguna vez sin ese prop poblado, la unidad
queda en blanco en vez de inventada — nunca se adivina.

### 4. `PayablesTab.tsx` (otro agente) no lee filtros de la URL

Mis tarjetas de «Hoy» enlazan a `/admin/compras?tab=cuentas-por-pagar`, y
esa parte funciona (llega a la pestaña correcta). Pero a diferencia de
`StockTab`/`CountsTab` (que sí leen `below_min`/`negative`/`scope` de la
query string al montar), `PayablesTab.tsx` arranca sus filtros
(`overdue`, `status`) siempre en el estado por defecto — así que la
persona llega a la pestaña correcta pero tiene que volver a marcar "Sólo
vencidas" a mano. No es mi archivo (`features/purchases/**`), así que lo
dejo señalado acá para quien sea dueño, en vez de tocarlo.

### No son huecos, son decisiones documentadas para que nadie las "corrija" después

- `variance_value` (Varianza) y los cinco campos de `FoodCostOut` son
  TOTALES de plata (pesos enteros), no un costo por unidad base — a
  propósito nunca pasan por `formatCOPDecimal`/`CostValue`, sólo por
  `formatCOP`.
- `variance_pct_bp`, `WasteKpiOut.ratio`, `*_ratio_bp`,
  `*_threshold_bp` son puntos básicos REALES (100 = 1 %) — una sola
  función (`formatBasisPoints`) los formatea en todo el territorio.

---

## §9 Ronda 2 — H-2 (bloqueante, mi mitad), H-8, H-7

Ajuste de iteración del Maestro. Territorio de esta ronda: los mismos
archivos de siempre más una incursión acotada y autorizada en dos símbolos
de `src/features/shifts/**` (detallados en H-8). No toqué `backend/**`,
`frontend/src/audit/**` ni `features/purchases/**`.

### H-2 (BLOQUEANTE) — retipado de `GET /admin/orders/{id}/consumption`

**El problema**: en la ronda anterior tipé el cliente de este endpoint
contra `OrderConsumptionRowOut`/`OrderConsumptionOut` de `app.inventory` —
la implementación que existía cuando escribí `api/inventory.ts`. El
orquestador decidió que la implementación que **sobrevive** es la de
`app.orders` (costo CONGELADO del libro al momento de cada movimiento,
consumo NETO `SALE + NOTE_RETURN`) y borró la de `app.inventory`. Mi tipo
apuntaba a un contrato que ya no se sirve.

**Qué cambié, en `frontend/src/api/inventory.ts`** (la función se queda en
este archivo — no es mi territorio moverla a un `api/orders.ts` que no
existe, y el endpoint es de lectura agregada sobre el libro de inventario
aunque el dominio dueño del router sea `app.orders`; el comentario de
cabecera ahora lo dice sin ambigüedad):

1. **Cabecera reescrita**: ya no dice `app.inventory` como dueño del
   endpoint. Dice explícitamente que vive en
   `backend/app/orders/router.py` (`get_order_consumption`) y que su
   esquema está en `backend/app/orders/schemas.py:322-364`
   (`OrderConsumptionRowOut`/`OrderConsumptionOut`), y por qué la
   implementación de `app.orders` es la que ganó (leí el docstring de
   `service.order_consumption` y el de `OrderConsumptionRowOut` en el
   propio `schemas.py` para confirmarlo antes de tocar nada, en vez de
   copiar la instrucción sin verificar contra el código real).

2. **`OrderConsumptionRowOut` reescrito campo por campo**, verificado
   contra `backend/app/orders/schemas.py:322-364` Y contra
   `backend/app/orders/service.py::order_consumption` (líneas ~2109-2224,
   la función que arma el diccionario `group` y construye cada fila) —
   leí la implementación, no sólo el esquema, porque un campo puede ser
   `str | None` en Pydantic y en la práctica nunca tomar uno de los dos
   valores en este camino de código en particular (ver el matiz de
   `cost_source` abajo):

   ```ts
   export interface OrderConsumptionRowOut {
     ingredient_id: number | null
     preparation_id: number | null
     name: string
     unit: string
     qty_base: string       // decimal ya escalado, PUEDE ser negativo o "0"
     cost: number | null    // TOTAL en pesos enteros del renglón, null = sin costo (nunca 0 mudo)
     cost_source: CostSource | null
   }
   ```

   - `qty_base`: confirmé en `service.py` que es
     `format_qty_base(group["qty_base"])` sobre una suma que empieza en
     `0` y acumula `movement.qty_base` de CUALQUIER causa (`sale` resta,
     `note_return` suma de vuelta) — por eso puede dar negativo (salida
     neta) o exactamente `"0"` (una nota que devolvió todo). Lo documenté
     en el propio tipo para que nadie lo lea como un bug si algún día
     alguien arma la pantalla consumidora y ve un negativo.
   - `cost`: `micros_to_pesos(...)` se aplica sólo si `group["has_cost"]`
     es `true` — si NINGÚN movimiento del grupo tuvo costo, quedó en `0`
     acumulado pero `has_cost=False`, y el código manda `cost=None`
     explícitamente (`cost = micros_to_pesos(...) if group["has_cost"]
     else None`). Es el mismo patrón "`None` con motivo, nunca `0` mudo"
     que ya uso en el resto del territorio — no lo inventé para este
     campo, lo verifiqué que el servidor también lo respeta acá.
   - `cost_source`: **acá afiné el tipo más allá de la instrucción
     literal.** El diccionario `group` arranca con `"cost_source": None`
     (Python `None`, no el string `"none"` del enum `CostSource.NONE`) y
     sólo se sobreescribe con `movement.cost_source.value` cuando un
     movimiento SÍ tuvo costo. Es decir: cuando `cost` es `null`,
     `cost_source` en la práctica **siempre** es `null` también — nunca
     llega el string `"none"` por este camino (a diferencia de otros
     endpoints del territorio donde sí puede llegar `CostSource.NONE`
     como string). Por eso tipé `cost_source: CostSource | null` en vez de
     sólo `CostSource` — el `| null` no es un capricho de "por las dudas",
     es lo que la implementación real hace.
   - **Borré `item_count`**: el servidor no lo manda — ni en el `Pydantic
     BaseModel` de `schemas.py` ni en la construcción de `service.py`. Un
     campo que el tipo del cliente promete y el servidor nunca manda es
     exactamente el tipo de hueco que este pedido existe para cerrar, no
     para agregar uno nuevo.

3. **`getOrderConsumption` perdió el parámetro `storeId`**: confirmé en
   `backend/app/orders/router.py` que la ruta servida (`get_order_
   consumption`) toma `order_id` del path y resuelve la sede con
   `admin_store(db, actor, order.store_id)` — nunca lee `store_id` de la
   query. Mandarlo igual no rompería nada (el servidor lo ignoraría), pero
   sería un parámetro fantasma en la firma del cliente — se lo saqué.

   ```ts
   export function getOrderConsumption(orderId: number): Promise<OrderConsumptionOut> {
     return api<OrderConsumptionOut>(`/admin/orders/${orderId}/consumption`)
   }
   ```

**Por qué no borré el cliente en vez de retiparlo** (la alternativa que el
Maestro explícitamente pidió NO hacer): un tipo correcto sin pantalla
consumidora es un contrato listo para quien construya "Pedidos" en
`features/orders/**` (fuera de mi territorio); borrarlo habría dejado ese
trabajo por hacer desde cero, sin ningún beneficio — ya estaba escrito, sólo
estaba mal apuntado.

**Verificado que no rompí nada**: `grep -rn "getOrderConsumption\|
OrderConsumption" src/` fuera de `api/inventory.ts` da vacío — sigue sin
consumidor en este territorio, exactamente como en la ronda anterior, así
que no había ningún otro archivo que actualizar.

### H-8 — causa de caja `supplier_payment`

`backend/app/shifts/schemas.py:26` (`CashMovementCauseLiteral`) ya declaraba
`"supplier_payment"` (pedido 2b de compras: el pago en efectivo de una
cuenta por pagar desde el cajón, y su reintegro cuando se anula un pago) y
el cliente no se había enterado. Incursión autorizada, exactamente estos dos
símbolos:

1. **`frontend/src/api/shifts.ts`** — `CashMovementCause` dejó de ser una
   unión de literales sueltos y pasó a derivarse de un array `const`
   recorrible:

   ```ts
   export const CASH_MOVEMENT_CAUSES = [
     "petty_expense",
     "emergency_purchase",
     "refund",
     "tip_payout",
     "supplier_payment",
     "other_income",
     "other_expense",
   ] as const;
   export type CashMovementCause = (typeof CASH_MOVEMENT_CAUSES)[number];
   ```

   Esto es la causa raíz que pedía el ajuste: antes, si el backend agregaba
   una causa nueva, nada en el cliente la exigía — el tipo simplemente no
   la incluía y nadie se enteraba hasta que alguien viera una causa vacía
   en pantalla. Ahora existe un array recorrible en tiempo de ejecución
   (no sólo un tipo que sólo existe en tiempo de compilación), que un test
   puede iterar.

2. **`frontend/src/features/shifts/MovementsPanel.tsx`** —
   `CAUSE_LABEL.supplier_payment = "Pago a proveedor"`. La etiqueta NO dice
   "Egreso" ni "Salida" a propósito: el dato que me pasó el Maestro es que
   el reintegro de un pago anulado (backend-compras, H-1 de ese pedido)
   llega con la MISMA causa `supplier_payment` pero `kind: "income"` — la
   columna de `kind` (`Ingreso`/`Egreso`, ya existente, `KIND_LABEL`) es la
   que distingue dirección; la causa sólo dice "de qué se trata".

   También exporté `CAUSE_LABEL` (antes era un `const` privado del
   archivo) para que el test de abajo pueda importarlo sin duplicar el
   diccionario ni renderizar el componente completo sólo para leer un
   mapa de strings.

3. **Test nuevo**, `frontend/src/features/shifts/__tests__/
   MovementsPanel.test.tsx` (agregado a la suite existente, sin tocar el
   test que ya pasaba):

   ```ts
   describe("MovementsPanel — CAUSE_LABEL cubre toda causa cerrada", () => {
     it("tiene una etiqueta no vacía para cada miembro de CASH_MOVEMENT_CAUSES", () => {
       expect(CASH_MOVEMENT_CAUSES.length).toBeGreaterThan(0);
       for (const cause of CASH_MOVEMENT_CAUSES) {
         expect(CAUSE_LABEL[cause]).toBeTruthy();
         expect(CAUSE_LABEL[cause].trim().length).toBeGreaterThan(0);
       }
     });

     it("supplier_payment no dice «Egreso» ni «Salida»: kind ya distingue ingreso de egreso", () => {
       expect(CAUSE_LABEL.supplier_payment).toBe("Pago a proveedor");
       expect(CAUSE_LABEL.supplier_payment.toLowerCase()).not.toMatch(/egreso|salida/);
     });
   });
   ```

   Nota honesta sobre qué SÍ protege este test y qué no: con `CAUSE_LABEL`
   tipado `Record<CashMovementCause, string>`, TypeScript YA obliga a
   listar toda causa que esté en el tipo `CashMovementCause` — eso protege
   contra "está en el tipo pero falta la etiqueta". Lo que el tipo NO
   protege es que alguien agregue una causa nueva al backend y el `array`
   `CASH_MOVEMENT_CAUSES` del cliente simplemente no se actualice — ese
   desfasaje (justo el que produjo este hallazgo) ningún tipo de TS lo
   puede cazar solo, porque no hay nada que sincronice el `Literal` de
   Python con el `const` de TS. El test no cierra ESE hueco tampoco —
   ningún test de este lado puede, sin generar tipos desde el OpenAPI—
   pero sí asegura que, el día que alguien SÍ actualice el array, no se
   olvide de traducir la etiqueta, que es la mitad del problema que puedo
   controlar desde acá.

4. **Efecto colateral que dejo señalado, no corregido** (fuera del
   símbolo autorizado): el formulario de "Registrar movimiento" arma su
   `<Select>` de causas iterando `Object.entries(CAUSE_LABEL)` (línea
   preexistente, no la toqué) — así que agregar `supplier_payment` a
   `CAUSE_LABEL` lo vuelve seleccionable también en el alta MANUAL de un
   movimiento, no sólo en la columna de causa de un movimiento ya
   registrado. Ese movimiento en particular lo crea el backend en la misma
   transacción del pago (`app.shifts.hooks.register_supplier_payment_
   expense`/`register_supplier_payment_reversal`), no el operador desde
   este formulario — pero nada en el cliente ni en el servidor impide hoy
   que alguien lo elija a mano. No es uno de los dos símbolos autorizados
   para esta ronda (tocar la lista del `<Select>` sería un tercer cambio),
   así que lo dejo declarado acá en vez de ampliarme el mandato solo.

### H-7 — excepción de escala declarada: `COUNT_QTY_SCALE`

**Decisión del orquestador, no mía**: la calculadora de sumas del conteo
(el parser "6+8" de SPEC-NEGOCIO §5.4) se queda — contar "6+8 cajas" es
ergonomía real de conteo físico — y la excepción al barrido de escala del
OpenAPI se declara por escrito en vez de esquivarse.

**Lo que hice**, en `frontend/src/features/inventory/lib.ts`: saqué el
`1000` desnudo de `parseCountInput` (antes repetido tres veces en la
función: para escalar cada término, para el cociente entero y para el
resto) a una constante nombrada:

```ts
export const COUNT_QTY_SCALE = 1000
```

con un comentario que dice, tal como pedía el ajuste, las tres cosas:

1. **Es un ESPEJO**: mismo valor que `QTY_SCALE = 1000` en
   `backend/app/core/quantity.py` (verifiqué el número de línea real,
   `89` en el árbol actual — no el `31` que traía la instrucción, que
   corresponde a otra revisión del archivo; preferí citar la línea que
   confirmé leyendo el código en vez de copiar un número sin chequear).
2. **La matemática autoritativa es del servidor**: la pantalla manda
   SIEMPRE texto decimal a `PUT /admin/counts/{id}/lines`, nunca un
   número, y `app.core.quantity.parse_qty_base` revalida cada renglón del
   lado del servidor y rechaza con `422` cualquier término que exceda esta
   misma precisión.
3. **La suma local es sólo ayuda de tecleo**, nunca una cifra de negocio:
   no se muestra en ningún reporte, no se guarda tal cual, y el peor caso
   de un desfasaje acá es un `422` de más, nunca un dato mal guardado.

El nombre exacto del símbolo, para `auditor-costos-2b` (quien declara la
excepción formal en el barrido del OpenAPI — no yo, no toco
`frontend/src/audit/**`):

> `frontend/src/features/inventory/lib.ts` :: `COUNT_QTY_SCALE` /
> `parseCountInput`

**Tests que fijan el borde** (`lib.test.ts`, los dos que pedía el ajuste ya
existían de la ronda anterior — "0,1+0,2" → "0.3" en la línea 29-30
original, un término de 4 decimales rechazado en la línea 38 original — así
que agregué un `describe` nuevo, específico sobre la constante recién
exportada, en vez de duplicar esos dos):

```ts
describe("COUNT_QTY_SCALE — espejo declarado de QTY_SCALE del servidor (Ronda 2, H-7)", () => {
  it("es 1.000 (milésimas), la misma escala que backend/app/core/quantity.py::QTY_SCALE", () => {
    expect(COUNT_QTY_SCALE).toBe(1000)
  })
  it("un término con exactamente 3 decimales (el borde de COUNT_QTY_SCALE) es válido", () => {
    expect(parseCountInput("0,001")).toEqual({ valid: true, value: "0.001" })
  })
  it("un término con 4 decimales excede COUNT_QTY_SCALE y se rechaza — nunca se manda al servidor", () => {
    expect(parseCountInput("0,0001")).toEqual({ valid: false, value: null })
    expect(parseCountInput("1,2555")).toEqual({ valid: false, value: null })
  })
})
```

### Verificación de Ronda 2 — territorio ampliado por la incursión de H-8

Corrida en serie, dos veces, del territorio completo de esta ronda
(`inventory` + `settings` + `reports` + `api` + `shifts`, este último sólo
por la incursión autorizada):

```
npx vitest run src/features/inventory src/features/settings src/features/reports src/api src/features/shifts
  → corrida 1: Test Files  26 passed (26) / Tests  109 passed (109)
  → corrida 2: Test Files  26 passed (26) / Tests  109 passed (109)

npm run typecheck
  → limpio, sin salida, exit 0 (tsc --noEmit -p tsconfig.app.json)
```

Desglose de dónde salen los 109 (para que el número no quede como una caja
negra): el mismo comando de la ronda anterior (`inventory` + `settings` +
`reports`, sin `api` ni `shifts`) da ahora **91** (era 88; +3 por el
`describe("COUNT_QTY_SCALE...")` nuevo en `lib.test.ts`) — y `src/api` +
`src/features/shifts` juntos dan **18** en **6** archivos (`shiftsApi.
test.ts` 6, `MovementsPanel.test.tsx` de shifts 3 —de los cuales 2 son
nuevos de esta ronda—, `CloseWizard.test.tsx` 2, `ShiftPage.test.tsx` 3,
`OpenShiftForm.test.tsx` 3, `SingleStepCloseForm.test.tsx` 1). `91 + 18 =
109`, `20 + 6 = 26` — cuadra con la corrida conjunta de arriba.

Archivos que **no existían como test antes de esta ronda** y no tocan mi
territorio exclusivo pero sí la incursión autorizada:
ninguno — `MovementsPanel.test.tsx` de `shifts` ya existía (1 test, la
ronda del reintento tras `PETTY_CASH_LIMIT`); le agregué 2 tests nuevos
dentro del mismo archivo, sin tocar el que ya pasaba.

No corrí la suite completa (`npm run test`) ni `npm run build`, tal como
manda la regla de verificación — sólo mi territorio más la incursión
autorizada, dos veces en serie.
