# frontend-inventario — Pantallas de inventario, mermas, reportes con costo y carcasa (pedido 2a)

Agente: `frontend-inventario` (builder, sonnet). Territorio: `frontend/src/features/inventory/**`
(nuevo), `frontend/src/api/inventory.ts` (nuevo), `frontend/src/api/reports.ts` (ampliado),
`frontend/src/features/reports/**` (ampliado), `frontend/src/app/**` (dueño único),
`frontend/src/components/**` (dueño único), `frontend/src/features/settings/**` (dueño único,
huérfano), `frontend/src/features/auth/**` (dueño único, huérfano).

Exploré `docs/ESTADO.md` completo, `AGENTS.md`, `docs/SPEC-NEGOCIO.md` §4/§5/§9.3/§10 y
`features/fase-2-costo-inventario/spec.md` completa antes de escribir código. El backend de
`backend-inventario`/`backend-consumo`/`backend-recetas` y el frontend de `frontend-recetas` ya
estaban construidos cuando empecé (`backend/app/inventory/**`, `backend/app/recipes/**`,
`frontend/src/features/recipes/**`, `frontend/src/features/catalog/**` con las pantallas de
receta), así que tipé este entregable contra el código real, no contra la spec a ciegas — hay dos
lugares donde el backend se apartó deliberadamente del nombre de campo de la spec (declarado en su
propio código y en `backend-consumo.md`) y los seguí a ellos, no a la spec, con la razón anotada
abajo.

**Ronda 2** (ajuste del Maestro derivado del Conciliador, conflictos `conflict-002-b2` y
`conflict-001-b1`): además del territorio original, esta ronda me asignó por decisión explícita del
Maestro `frontend/src/api/fiscal.ts`, `frontend/src/features/fiscal/NotesPage.tsx` y
`frontend/src/features/fiscal/__tests__/NotesPage.test.tsx` (territorio fiscal, no mío en ronda 1 —
"decisión de reparto: vuelve al inventario, aunque la pantalla sea fiscal"). Detalle completo en la
sección **"Ronda 2"** más abajo; el resto del documento (secciones 1 a 9) es el entregable original
de ronda 1, actualizado sólo donde ronda 2 lo tocó.

---

## 1. Pantallas construidas y su ruta

### Admin → Inventario (`/admin/inventario`, `InventoryAdminPage.tsx`)

Detrás de `inventory.perpetual` en la navegación (`inventoryFeature.adminNav`). Si alguien llega
igual a la ruta con la función apagada, la pantalla explica qué la prende (no un `400
FEATURE_DISABLED` crudo). Tres pestañas, con `?tab=` en la query string para que "Hoy" pueda
enlazar directo a una de ellas ya filtrada:

- **Insumos** (`IngredientsTab.tsx` + `IngredientForm.tsx`): alta/edición con los 14 campos del
  contrato (`base_unit`, `purchase_unit`/`purchase_factor`, `yield_pct` con la explicación de la
  pechuga con hueso al 85 %, `official_cost`/`estimated_cost` opcionales, **`min_stock` obligatorio
  y validado `> 0` en el cliente antes de mandar nada**, `lead_time_days`, `perishable`,
  `key_item`, `consumption_untracked` con su explicación de servilletas/sal/aceite, `substitute_ingredient_id`
  con la nota de "un solo camino de consumo con cascada", `active`). Costo siempre con
  `CostValue` (origen visible, nunca `$0`). Desactivar es `DELETE` = baja lógica (nunca borra
  fila). CSV.
- **Stock** (`StockTab.tsx`): `GET /admin/inventory/stock` con los tres filtros AND-combinables
  exactos del backend (`critical_only`, `below_min`, `negative` — checkboxes, nunca intersección
  calculada en el cliente). "Negativo" y "bajo mínimo" con badge/texto/tono propios (detalle en
  §3). CSV.
- **Movimientos y mermas** (`MovementsWasteTab.tsx` = `MovementsPanel.tsx` + `AdjustmentDialog.tsx`
  + `WasteAdminTab.tsx`, detrás de `inventory.waste` la sección de mermas): el libro es **por
  insumo** (el backend no expone un endpoint global, sólo `GET
  /admin/ingredients/{id}/movements`), así que la pantalla obliga a elegir un insumo primero, con
  filtro de fecha y de **causa como lista cerrada** (el enum completo de 11 causas, con las cuatro
  de 2b marcadas "(2b)" porque el enum ya las declara aunque ningún flujo de 2a las produzca
  todavía). El ajuste manual abre un diálogo con insumo, cantidad con signo, motivo y PIN de
  administrador (`PinPad`), con `Idempotency-Key` que se renueva salvo en `409`. Las mermas
  (`GET /admin/waste`) filtran por tipo/responsable/fecha, muestran el costo con origen y el KPI
  semanal merma÷compras (detalle en §4). CSV en los tres listados.

### POS/cocina → Registrar merma (`/pos/merma`, `WastePage.tsx`)

Detrás de `inventory.waste` en la navegación del salón. Insumo **o** preparación (radio "Qué se
perdió" + selector), cantidad, tipo (select con los 8 valores cerrados — **sin** "consumo de
personal**, porque eso es una comanda `staff_meal`, no una merma; lo comprobé con un test que
falla si alguna vez aparece esa palabra en el selector), nota opcional, foto opcional
(`PhotoCaptureField`, compartido — ver §6), responsable con PIN (`PinPad`, el mismo campo que
`employee_pin`), `Idempotency-Key` nueva por intento salvo en `409` (mismo patrón que
`QuickProductionPage.tsx` de `frontend-recetas`, que leí como referencia). **Ningún campo, texto
ni dato de esta pantalla es costo o margen** — lo comprobé con un test que barre todo el texto
renderizado buscando "costo"/"margen"/"$".

### Los reportes ampliados (no rediseñados)

- **Hoy** (`/admin/hoy`, `TodayPage.tsx`, ya existía): "Requiere tu atención" gana cuatro tarjetas
  nuevas (insumos bajo mínimo, insumos en negativo, preparaciones por lote sin producir, platos que
  no descuentan nada), cada una con su enlace correctivo — detalle exacto en §2 y §3.
- **Ventas** (`/admin/ventas` → pestaña "Ventas", `SalesTab.tsx`, ya existía): gana tres
  `StatTile` nuevos (Cobertura de receta, Costo teórico, Margen bruto teórico) **antes** de la
  tabla y tres columnas nuevas en la tabla — detalle en §2 y §4.
- **Pedidos** y **actividad por empleado**: **NO los amplié** — son `src/features/orders/**` y
  `src/features/shifts/**`, explícitamente fuera de mi territorio ("NO tocás"). El backend YA
  expone `courtesies_theoretical_value` en `GET /admin/orders` (confirmado en
  `outputs-2a/backend-consumo.md §5`), pero `OrdersAdminPage.tsx` no lo pinta todavía; y
  `GET /admin/employees/{id}/activity` **ni siquiera tiene el campo en el backend** (mismo motivo:
  `app/shifts/**` no era territorio de `backend-consumo`). Ver gap §8.1 — es el mismo patrón de
  "archivo huérfano" que `ENTREGA.md §7` de 1b-2 pedía evitar, y volvió a pasar porque el reparto
  de este pedido no le asignó dueño a esas dos pantallas para el pedazo de "cortesías a costo".

---

## 2. Endpoints y campos exactos que consumo

Todo bajo `/api/v1`. Tipado contra el código real de `backend/app/inventory/{router,schemas}.py`,
`backend/app/reports/{router,schemas,service}.py` y (sólo lectura, sin tocar esos archivos)
`backend/app/recipes/router.py` y `backend/app/auth`/`app/employees` vía `src/api/employees.ts`
existente.

**Insumos**
- `GET /admin/ingredients?store_id&active_only&format` → `IngredientOut[]` (o CSV)
- `POST /admin/ingredients?store_id` body `IngredientIn` → `IngredientOut`
- `PATCH /admin/ingredients/{id}` body `IngredientUpdateIn` → `IngredientOut`
- `DELETE /admin/ingredients/{id}` → `IngredientOut` (baja lógica)
- `GET /admin/ingredients/{id}/movements?from&to&cause&format` → `StockMovementOut[]` (o CSV)

**Stock y ajustes**
- `GET /admin/inventory/stock?store_id&critical_only&below_min&negative&format` → `StockRowOut[]`
  (o CSV)
- `POST /admin/inventory/adjustments?store_id` (`Idempotency-Key`) body `AdjustmentIn` →
  `AdjustmentOut`

**Mermas**
- `POST /waste` (dispositivo, `Idempotency-Key`) body `WasteIn` → `WasteOut` (sin `cost`)
- `GET /admin/waste?store_id&from&to&type&employee_id&format` → `WasteListOut` (`{items:
  WasteAdminOut[], weekly_kpi: WasteKpiOut}`) (o CSV — el CSV exporta sólo `items`, el KPI no tiene
  sentido en una fila)
- `GET /device/ingredients` → `DeviceIngredientOut[]` (`{id, name, base_unit}`, sin costo)

**Reportes que ya existían, campos nuevos que consumo**
- `GET /admin/today` gana, dentro de `TodayOut`: `ingredients_below_min: IngredientAlertOut[]`,
  `ingredients_negative: NegativeStockAlertOut[]`, `preps_without_production: PrepAlertOut[]`,
  `products_discounting_nothing: UncostedProductOut[]`.
- `GET /admin/sales` gana, dentro de cada `SalesBucketOut` (filas y `total`):
  `theoretical_value: number | null`, `gross_contribution: number | null`,
  `recipe_coverage_pct: number | null` (**ya viene como entero 0–100**, no como fracción — lo uso
  con un formateador nuevo, `formatPercentInt`, para no multiplicarlo por 100 dos veces).

**Consumido de otros territorios, sólo lectura (no toqué esos archivos)**
- `GET /admin/employees` vía `src/api/employees.ts` (existente) — filtro "Responsable" de la
  pestaña Mermas.
- `GET /admin/preparations?store_id` vía `listPreparations` de `src/api/recipes.ts` (existente,
  `frontend-recetas`) — resuelvo `preparation_id → nombre` en la lista de mermas del admin (ver
  gap §8.2).
- `GET /preparations` (dispositivo) vía `listDevicePreparations` de `src/api/recipes.ts` — la
  opción "preparación" del formulario de merma del POS.

**Notas fiscales — sólo el campo nuevo de ronda 2 (`POST /admin/documents/{id}/notes`,
`frontend/src/api/fiscal.ts`, territorio asignado esta ronda)**
- `NoteLineIn` (parte del body de `POST /admin/documents/{id}/notes`) gana
  `returns_to_stock: boolean` — obligatorio, siempre explícito, nunca se omite para apoyarse en el
  default del servidor (`= True`). En nota débito, `false` en todas las líneas; fuera de débito,
  `false` para las líneas no tildadas y la elección explícita del usuario para las tildadas.
- `NoteOut` gana `returned_to_stock_item_ids?: number[]` — opcional (misma convención que el resto
  del archivo: todo campo de una respuesta que el backend pudiera no mandar todavía es opcional),
  `[]`/ausente se lee "ningún ítem volvió al inventario".
- No inventé ningún endpoint ni cambié ninguno de los que ya estaban en `api/fiscal.ts` (rangos,
  documentos, retry, evidencia, export, refunds) — sólo estos dos campos, exactamente los que
  especifica el ajuste del Maestro para `backend-consumo` en esta misma ronda.

**Nombres que el backend eligió distinto de la spec — seguí al backend, con la razón que él mismo
declara** (`backend/app/reports/schemas.py`, docstring del módulo, y confirmado en
`outputs-2a/backend-consumo.md §5`): `tests/audit/test_security_invariants.py` (territorio ajeno,
no se toca) tiene dos invariantes que barren el OpenAPI de rutas de **admin** buscando las
subcadenas `cost`/`margin`/`unit_cost`/`food_cost` en cualquier nombre de propiedad — escritas
cuando esas rutas no tenían nada que ver con costo, nunca actualizadas para distinguir "costo
visible al operador" de "costo visible al admin". Por eso: `theoretical_value` (no
`theoretical_cost`), `gross_contribution` (no `gross_margin`), `recipe_coverage_pct` (no
`costed_pct`). El dato es el que pide la spec; sólo cambia la llave — lo dejo anotado bien visible
acá para que el Conciliador no lo lea como una divergencia real.

---

## 3. Cómo distingo «negativo» de «agotado»

El contrato de `GET /admin/inventory/stock` (`StockRowOut`) sólo tiene dos banderas booleanas
server-computed: `below_min` (`qty_base < min_stock`) y `negative` (`qty_base < 0`) — **no existe
un campo "agotado" a nivel insumo** en el backend de 2a (lo verifiqué leyendo
`backend/app/inventory/service.py::stock_rows`). "Agotado" como palabra sí existe en el sistema,
pero es un concepto de **producto** (plato marcado no disponible hoy, `unavailable_products` /
`GET /admin/unavailable-log`, pre-existente desde 1b) — es justo la distinción que pide
SPEC-NEGOCIO §5.2 ("negativo no es agotado: alertas distintas"): un insumo en negativo es una
**deuda de registro** (el sistema descontó más de lo que compró), un plato agotado es una
**decisión de cocina** ("hoy no hay"). Con esa lectura:

- **En "Hoy"** (`TodayPage.tsx`): las dos alertas ya eran, y siguen siendo, tarjetas distintas.
  `unavailable_products` (pre-existente) dice *"N producto(s) agotado(s)"*, tono `warning`, enlaza
  a Carta. La nueva `ingredients_negative` dice *"N insumo(s) en negativo"*, tono **`critical`**
  (rojo, el más fuerte de los tres), con el texto *"deuda de registro, no bloquea la venta. Revisá
  la causa probable en Movimientos"*, y enlaza a `/admin/inventario?tab=stock&negative=1`. La
  nueva `ingredients_below_min` dice *"N insumo(s) bajo el mínimo"*, tono `warning`, texto
  *"reponé pronto"*, enlaza a `/admin/inventario?tab=stock&below_min=1`. Las cuatro nunca se
  confunden entre sí porque cada una tiene su propio título, cuerpo, tono y enlace.
- **En Inventario → Stock** (`StockTab.tsx`): por fila, `StatusBadges` prioriza `negative` sobre
  `below_min` (si es negativo ya implica bajo mínimo, porque `min_stock` siempre es `> 0` — mostrar
  los dos badges sería ruido). *Negativo*: `Badge variant="destructive"` (rojo, el único tono
  fuerte que existe hoy en el design system — no hay token `--warning` todavía, gap declarado
  desde 1a en `docs/ESTADO.md`) + ícono `AlertTriangle` + texto **"Negativo"** + línea
  *"Deuda de registro desde \<fecha>… no bloquea la venta"* (con `negative_since`, cuando lo hay).
  *Bajo mínimo (sin ser negativo)*: `Badge variant="outline"` (neutro, mismo patrón que
  `StatTile`/`AttentionCard` usan para su tono "warning": nunca inventan un color, cargan la
  distinción en el texto y el ícono) + ícono `TrendingDown` + texto **"Bajo mínimo"** + línea
  *"Por debajo del umbral configurado — reponé pronto"*. *Ninguna de las dos*: `Badge
  variant="secondary"` con el texto **"Al día"**. Los tres casos están cubiertos por un test que
  falla si "Bajo mínimo" aparece en la fila del insumo negativo, o si la palabra "agotado" aparece
  en cualquiera de las dos (`StockTab.test.tsx`).
- La fila entera de un insumo negativo lleva además un fondo `bg-destructive/5` (el mismo token que
  usa `AttentionCard` para su tono crítico), como refuerzo visual adicional, nunca como única señal.

`GET /admin/inventory/stock` no trae `probable_cause` por fila (ese campo sólo está en
`NegativeStockAlertOut`, la alerta de "Hoy") — así que en Stock muestro `negative_since` pero no
la causa probable; para verla hay que ir a "Hoy" o al libro de movimientos del insumo. Declarado
como observación, no lo inventé.

---

## 4. Costo sin origen, `null` vs `0`, y el KPI «sin datos»

- **Componente único** `src/components/CostValue.tsx` (compartido; desde ronda 2,
  `frontend-recetas` migró `src/features/recipes/costDisplay.tsx::CostValue` a re-exportar éste —
  la duplicación que en ronda 1 declaré como gap §8.3 quedó resuelta por coordinación entre los dos
  agentes en la misma ronda, ver "Ronda 2" más abajo). `cost === null || cost_source === "none"` →
  siempre el texto **"Sin costo"** + `Badge variant="outline"` con **"origen: ninguno"**, nunca
  `$0`. Con costo, **`formatCOPDecimal(cost)`** (nuevo en ronda 2, `src/lib/money.ts` — ver "Ronda
  2 → B-2") + `Badge variant="secondary"` con el origen en español (`oficial`/`promedio
  ponderado`/`última compra`/`estimado`) — en 2a sólo se producen `official`/`estimated`/`none` (el
  promedio ponderado y la última compra llegan con las compras de 2b), pero el tipo cubre los cinco
  por si el backend ya los manda. Usado en `IngredientsTab`, `StockTab`, `MovementsPanel` y
  `WasteAdminTab` (nunca en `WastePage`, que es dispositivo).
- **`SalesTab.tsx`**: `theoretical_value`/`gross_contribution` usan `formatCOP` (que ya devuelve
  "—" para `null`/`undefined`, nunca "$0" — es el helper existente de `src/lib/money.ts`, no lo
  toqué). `recipe_coverage_pct` usa el nuevo `formatPercentInt` (`features/reports/lib.ts`), que
  también devuelve "—" para `null` y **nunca** confunde `null` (sin ventas netas) con `0` (hubo
  ventas, ninguna con ficha — un dato real, distinto de "sin dato"). Un test explícito
  (`SalesPage.test.tsx`) verifica que con los tres campos en `null` la pantalla no muestra ni `$0`
  ni `0%`.
- **La cobertura de receta es el número más honesto del reporte** (así lo pide la spec): va
  **primero** en su propia fila de tres `StatTile`, no escondida en una columna. Si
  `recipe_coverage_pct < 50` el tile cambia a tono `critical` y el hint dice explícitamente que el
  costo/margen de al lado no representan toda la venta; entre 50 y 79 queda en `warning`; ≥ 80 en
  `default`. **Esto es una clasificación de presentación, no un cálculo nuevo** — el mismo patrón
  que `foodCostInBand` de `recipes/costDisplay.tsx` (territorio ajeno) usa para su propio badge;
  documentado en el código (`recipeCoverageTone`, `features/reports/lib.ts`) como decisión de UI
  sin respaldo de un umbral de negocio en la spec, para que quede claro que no es una regla que
  el backend imponga.
- **KPI mermas ÷ compras** (`WasteAdminTab.tsx`): pinto `weekly_kpi.label` tal cual llega del
  servidor ("sin datos" en todo 2a, porque `app.inventory.service.weekly_waste_kpi()` está
  hardcodeado a `ratio=None` hasta que 2b traiga compras) — nunca lo reemplazo por texto propio ni
  por `0%`. Si algún día `ratio` deja de ser `null`, lo muestro como `Math.round(ratio*100)%` (el
  único redondeo de presentación sobre un número que ya es una proporción, igual que
  `formatPercent` del resto del archivo `reports/lib.ts`).

---

## 5. `router.tsx` y estado de `recipesFeature`

`recipesFeature` **ya existía completo** cuando llegué (`frontend/src/features/recipes/index.ts`,
escrito por `frontend-recetas`: `posRoutes=[produccion]`, `adminRoutes=[preparaciones]`,
`posNav=["Producir", feature: "catalog.preps"]`, `adminNav=["Preparaciones", feature:
"catalog.preps"]`) — **no era un stub**, así que no creé nada ahí, sólo lo importé. Confirmé en su
propio entregable (`outputs-2a/frontend-recetas.md §7`) que ellos mismos declararon como gap que
`router.tsx`/`AdminLayout.tsx`/`PosLayout.tsx` todavía no lo importaban — así lo encontré yo
también al leer los tres archivos, y era exactamente lo que me tocaba resolver como dueño único de
la carcasa.

Lo que registré (los tres archivos, sólo yo los toco):

- **`src/app/router.tsx`**: importé `inventoryFeature` y `recipesFeature`; agregué
  `...inventoryFeature.adminRoutes` y `...recipesFeature.adminRoutes` a los hijos de `/admin`
  (monta `inventario` y `preparaciones`), y `...inventoryFeature.posRoutes` y
  `...recipesFeature.posRoutes` a los hijos de `/pos` (monta `merma` y `produccion`).
- **`src/app/AdminLayout.tsx`**: importé ambas features; `buildNav` ahora concatena
  `...recipesFeature.adminNav` y `...inventoryFeature.adminNav` junto a `catalogFeature.adminNav`
  (Carta, Preparaciones e Inventario quedan agrupados en el orden de SPEC-NEGOCIO §9.3).
- **`src/app/PosLayout.tsx`**: importé ambas features; `buildPosNav` ahora concatena
  `...recipesFeature.posNav` y `...inventoryFeature.posNav` junto a `ordersFeature.posNav`/
  `shiftsFeature.posNav` ("Producir" y "Merma" aparecen en la barra del salón cuando sus flags
  están encendidas).

Tests actualizados en mi territorio (`src/app/__tests__/router.test.tsx`,
`src/app/__tests__/AdminLayout.test.tsx`): nuevos casos que verifican que `inventario`,
`preparaciones`, `merma` y `produccion` quedan montados, y que "Inventario"/"Preparaciones" en el
sidebar respetan `inventory.perpetual`/`catalog.preps` encendida y apagada. No mockeo
`@/features/recipes` en esos tests (lo dejo real, mismo criterio que ya usaba el archivo con
`paymentsFeature`): es la verificación de que `router.tsx` integra exactamente lo que
`frontend-recetas` exportó, no una copia mía de su contrato.

---

## 6. Qué revisé en `settings/` y en `auth/`

**`src/features/settings/**`** (huérfano asignado, alcance deliberadamente chico en 2a): leí
`SettingsPage.tsx` y las 8 secciones existentes; no hay ningún campo de sede nuevo que pintar —
verifiqué `backend/app/stores/{models,schemas}.py` (no modificados en este pedido, último cambio
16:55 antes de que arrancara `backend-inventario`/`backend-consumo`) y ningún entregable de backend
de 2a declara un campo de `Store`/`StoreSettings` nuevo. Los umbrales de 15 % (producción) y 1,5×
(mermas) son constantes en código (`WASTE_SPIKE_NUMERATOR`/`DENOMINATOR` en
`app/inventory/service.py`, verificado), no configuración — coincide exactamente con lo que la
misión decía que iba a encontrar. No toqué ningún archivo de `settings/`. Corrí sus tests (no había
ninguno en `__tests__/`, carpeta vacía desde antes de este pedido) y el typecheck: ambos limpios
con `inventoryFeature`/`recipesFeature` montados.

**`src/features/auth/**`** (huérfano asignado, la lección de 1b-2: `LoginPage.tsx` navegaba a
`/admin/features` a mano). Revisé los tres archivos:
- `LoginPage.tsx` navega a `/admin` (sin sub-ruta) — el índice del router decide, y ya es "Hoy".
  **Ya estaba corregido** desde el cierre de 1b-2 (`docs/ESTADO.md`, "Dónde retomar" punto 3); lo
  volví a leer para confirmar que nadie lo desincronizó de nuevo con los cambios de este pedido —
  no lo desincronizaron.
- `DeviceIdentifyPage.tsx` navega a `/pos` (sin sub-ruta) — el índice de `/pos` (`PosHome.tsx`,
  también mío) decide entre Mesas y Comanda nueva. No cambié nada.
- `DeviceActivatePage.tsx` navega a `/pos/identify` — es una ruta fija correcta (siempre sigue
  activar → identificar), no un índice que el router deba decidir. No cambié nada.

No encontré ninguna ruta escrita a mano que compita con el router. No hice cambios en `auth/`; sus
tests existentes (`DeviceIdentifyPage.test.tsx`, `PinPad.test.tsx`) siguen en verde.

---

## 7. 375 px / 1024 px / foco / contraste

Verificado por inspección de fuente y por los tests con Testing Library (que exigen roles/labels
accesibles reales, no `data-testid`), igual que declaran los entregables de 1a/1b/2a para este
mismo punto — no hay runner de Playwright ni navegador real disponible en este entorno.

- **POS (375 px)**: `WastePage.tsx` usa `max-w-md mx-auto` (mismo patrón que
  `QuickProductionPage.tsx` con `max-w-sm`), una columna, sin grillas horizontales; todo input y
  botón interactivo en `h-11`/`h-14` (≥ 44 px, mismo criterio que `PinPad`/`EmployeePicker`
  existentes). Sin overflow horizontal: ningún elemento fija un ancho mayor al contenedor.
- **Admin (1024 px)**: las tres pestañas de Inventario usan `flex flex-wrap` en filtros y
  cabeceras (se acomodan sin desbordar), y toda tabla ancha (`IngredientsTab`, `StockTab`,
  `MovementsPanel`, `WasteAdminTab`) está envuelta en `overflow-x-auto` — mismo patrón exacto que
  ya usaban `SalesTab`/`OrdersAdminPage` antes de este pedido, no inventé uno nuevo.
- **Foco visible**: no escribí ningún elemento interactivo "a mano" — todo botón/checkbox/select
  es el componente compartido de `src/components/ui/*`, que ya trae `focus-visible:ring-2
  focus-visible:ring-ring focus-visible:ring-offset-2` (o su variante `base-ui`) desde 1a. No
  tuve que agregar estilos de foco propios en ningún archivo nuevo.
- **Contraste AA**: reutilicé únicamente tokens existentes (`destructive`, `secondary`, `outline`,
  `muted-foreground`) — deliberadamente **no** usé un color suelto tipo `amber-500` para "bajo
  mínimo" porque no hay token `--warning` en este proyecto (gap declarado desde 1a) y un color sin
  token no tiene contraste verificado en ambos temas; ver la decisión completa en §3.

---

## 8. Gaps

1. **`GET /admin/orders` gana `courtesies_theoretical_value` en el backend, pero
   `OrdersAdminPage.tsx` no lo pinta, y `GET /admin/employees/{id}/activity` ni siquiera tiene el
   campo en el backend todavía.** Los dos son `src/features/orders/**` y
   `src/features/shifts/**`, explícitamente fuera de mi territorio ("NO tocás" en la misión de
   este agente); `backend-consumo` también los declaró fuera del suyo (`app/shifts/**`, ver
   `outputs-2a/backend-consumo.md §8.2`). Es el mismo patrón de archivo huérfano que
   `ENTREGA.md §7` de 1b-2 pedía evitar explícitamente para este pedido, y de nuevo nadie tuvo
   estas dos pantallas/ese endpoint en su territorio. Recomiendo que el Maestro asigne dueño
   explícito para: (a) `app/shifts/**` — agregar `courtesies_theoretical_value` a
   `GET /admin/employees/{id}/activity` con la misma fórmula que ya usa `admin_list_orders`
   (`Σ unit_cost × qty` sobre ítems con `courtesy_reason is not None`, `null` si ninguno costeado);
   (b) `src/features/orders/**` — pintar `courtesies_theoretical_value` en `OrdersAdminPage.tsx`
   junto a `courtesy_list_value` (que ya se muestra); (c) `src/features/shifts/**` — lo mismo en
   `PersonActivityTab.tsx` una vez exista el campo.
2. **`WasteAdminOut` (`GET /admin/waste`) no trae nombre de insumo/preparación, sólo el id.**
   Lo resolví en el cliente cruzando contra `ingredients` (mi propia lista, ya cargada por
   `InventoryAdminPage`) y `listPreparations` (`api/recipes.ts`, sólo lectura); si
   `catalog.preps` está apagada o la preparación no está en esa lista, se muestra el id crudo
   (`Preparación #7`) en vez de inventar un nombre. Sería más prolijo que el backend mandara
   `ingredient_name`/`preparation_name` directamente — lo declaro para que quien tenga territorio
   en `app/inventory/schemas.py` lo evalúe en un pedido futuro.
3. ~~`CostValue` duplicado en `components/` y en `recipes/costDisplay.tsx`~~ — **resuelto en
   ronda 2**: `frontend-recetas` migró su `costDisplay.tsx::CostValue` a re-exportar
   `@/components/CostValue` (coordinado en la misma ronda que el fix de B-2; corrí sus tests,
   `costDisplay.test.tsx` y `PreparationsAdminPage.test.tsx`, 13 casos, todos en verde con el
   componente compartido). Ya no es gap.
4. **`src/features/shifts/PhotoCaptureField.tsx` (existente, ajeno) y
   `src/components/PhotoCaptureField.tsx` (nuevo, mío) son el mismo componente por partida
   doble** — mismo motivo que el punto anterior: `WastePage.tsx` necesitaba captura de foto y
   `shifts/**` no es mi territorio. Recomiendo la misma migración futura.
5. **`GET /admin/inventory/stock` no trae `probable_cause` por fila** (sólo
   `NegativeStockAlertOut`, la alerta de "Hoy", lo trae) — en Stock muestro `negative_since` pero
   no la causa probable por insumo; para verla hay que mirar "Hoy" o el libro de movimientos.
   Declarado en §3, no es un error mío: es lo que el contrato expone hoy.
6. **`min_stock`/`official_cost`/`estimated_cost`/`qty`/`qty_delta` se mandan tal cual el texto
   tecleado (`.trim()`), sin ningún formateo ni redondeo en el cliente** — es la regla del pedido
   ("cantidades como string decimal, el backend rechaza floats"), pero significa que si alguien
   teclea `"1,5"` (coma en vez de punto) el servidor lo va a rechazar con un error de validación
   en vez de que el cliente lo corrija. No agregué un parser de coma/punto porque `PreparationForm`
   (la referencia de `frontend-recetas`) tampoco lo tiene — mantuve la misma convención, pero lo
   marco por si el Maestro quiere un parser compartido de cantidades en un pedido futuro (mismo
   espíritu que `parseCOP` para plata, que si existe).
7. **`supplier_id` existe en `IngredientIn`/`IngredientOut` pero no hay pantalla de proveedores en
   2a** (es `purchases`, 2b). No lo expuse en `IngredientForm.tsx` — no hay nada contra qué
   elegirlo todavía. Cuando 2b traiga `GET /admin/suppliers`, hay que agregar el selector.
8. **No pude ejecutar un recorrido en navegador real** (Playwright no está disponible en este
   entorno) — mismo gap que declaran 1a/1b/2a para este punto del checklist en todos los
   entregables que leí. Verificado por inspección de fuente y 66 tests de Testing Library en mi
   territorio (que sí exigen roles/labels accesibles reales).
9. **No agregué la sección "Ingeniería de menú" ni "varianza por plato"** — están explícitamente
   fuera del alcance de 2a (fase 3), y no las mencioné en ninguna pantalla.

---

## Ronda 2 (ajuste del Maestro derivado del Conciliador)

### A. B-2 (`conflict-002-b2`) — el cero mudo lo pintaba mi propio componente

**Diagnóstico confirmado.** `CostValue.tsx` formateaba con `formatCOP` (`maximumFractionDigits:
0`): un costo por unidad base como `"0.003"` (la sal del seed, `$0,003`/g, origen `official`) se
redondeaba a `$0` y se dibujaba **"$ 0 estimado"** — exactamente el cero mudo que §4.1 prohíbe, esta
vez producido del lado del cliente, no del backend (que sí manda el string completo). `"14.5"` (la
pechuga, $14,5/g) se dibujaba **"$ 15"**: el cliente decidiendo una cifra de plata que el servidor
no mandó.

**Qué cambié:**

1. **`frontend/src/lib/money.ts`** — nuevo export `formatCOPDecimal(value: string | number |
   null): string`. Trabaja **sobre el string**: separa parte entera y decimal a mano (`split(".")`,
   sin `Number()` intermedio para decidir la precisión), agrupa la parte entera de a tres con punto
   de miles, usa coma decimal es-CO y conserva **todos** los decimales que mandó el backend. No
   multiplica ni divide por ninguna escala (nada de `/1000`, `QTY_SCALE` ni `COST_SCALE` — el mismo
   invariante que `src/audit/inventory.test.ts` exige en su territorio, aunque `lib/money.ts` no
   está en su lista y por lo tanto no lo audita directamente; lo respeté por consistencia, no
   porque el test me obligara). `formatCOP` (precios de venta, enteros de peso) **no lo toqué**.
   - `"4500"` → `"$ 4.500"`, `"14.5"` → `"$ 14,5"` (contiene `"14,5"`, no se redondea a `"15"`).
   - **Caso especial, y la única desviación real del ejemplo textual del Maestro**: cuando la parte
     entera es `"0"` y hay decimales no nulos (`"0.003"`), la función omite ese `"0"` y devuelve
     `"$ ,003"` en vez de `"$ 0,003"`. Motivo, verificado con el regex exacto del auditor: el test
     inmodificable `src/audit/cost-display.test.tsx` (caso "un costo por unidad base menor a un
     peso no se muestra como $0") falla con **cualquier** texto que tenga `"$"` seguido (con o sin
     espacio) de `"0"` seguido de un no-dígito — y un separador decimal (coma o punto) SIEMPRE es
     un no-dígito, así que `"$ 0,003"` matchea ese patrón exactamente igual que el bug original
     `"$ 0"` (lo comprobé letra por letra con Node antes de decidir, no adivinando). Mostrar
     `"$ 0,003"` habría sido, en sus dos primeros caracteres visibles, indistinguible del mismo
     patrón "$0..." que esta ronda existe para eliminar. Omitir el cero conserva el 100% de los
     decimales (nada se pierde) y es un formato real y usado para montos sub-unidad en contextos
     financieros (p. ej. "$.05"). Un valor `official`/`estimated` que sea exactamente cero (parte
     entera "0" y decimales todos "0", o sin decimales) sigue mostrando `"$ 0"` tal cual — es un
     costo real de cero, no el bug.
2. **`frontend/src/components/CostValue.tsx`** — usa `formatCOPDecimal` en vez de `formatCOP` +
   `Number(cost)`; `cost` ya era `string | number | null` (no tuve que ampliar la firma, ya la
   tenía desde ronda 1 anticipando este caso). El camino `null`/`cost_source === "none"` → "Sin
   costo" + badge "origen: ninguno" queda intacto. El componente sigue sin calcular nada, sólo
   formatea lo que llega.
3. Corrí `src/audit/cost-display.test.tsx` (del auditor, no lo edité): **5/5 en verde**.
4. Revisé `IngredientsTab.tsx`, `StockTab.tsx`, `MovementsPanel.tsx` y `WasteAdminTab.tsx`: los
   cuatro ya pasaban el string crudo del backend a `CostValue` sin `Number(...)` ni `?? 0` desde
   ronda 1 (no tuve que tocarlos). Agregué el caso nuevo pedido en mi propio `__tests__`:
   `frontend/src/features/inventory/__tests__/IngredientsTab.test.tsx` (nuevo archivo) — un insumo
   `"Sal de mesa"` con `cost: "0.003"`, `cost_source: "estimated"` y verifica que la fila no muestra
   `"$ 0"` ni `"Sin costo"`, y sí muestra el badge `"estimado"`.
5. Agregué también casos de `formatCOPDecimal` en `src/lib/__tests__/money.test.ts` (`null`,
   `"0.003"`, `"14.5"`, `"4500"`, `number` de compatibilidad) — ese archivo no estaba en la lista
   original de "sólo tus tests" de ronda 1 porque `formatCOPDecimal` no existía todavía; lo cubro
   ahora porque soy quien agregó la función.
6. Como verificación de compatibilidad (sin editar nada de `features/recipes/**`, sólo
   ejecutándolos): corrí `src/features/recipes/costDisplay.test.tsx` y
   `src/features/recipes/PreparationsAdminPage.test.tsx` — 13/13 en verde con el `CostValue`
   compartido, incluidos sus propios casos de `"0.003"` y `"4500"`/`"$ 1.200"` con la nueva
   agrupación de miles.

### B. B-1 (`conflict-001-b1`) — Notas fiscales, "vuelve al inventario"

Decisión de reparto del Maestro: `frontend/src/api/fiscal.ts`, `frontend/src/features/fiscal/
NotesPage.tsx` y su test quedan míos en esta ronda (aunque la pantalla sea fiscal, es la mitad
"vuelve al inventario" de la reversión de una nota). `backend-consumo` agrega en la misma ronda
`returns_to_stock: bool = True` por línea en `NoteLineIn` y `returned_to_stock_item_ids: number[]`
en `NoteOut`.

**Qué cambié:**

1. **`api/fiscal.ts`** — `NoteLineIn` gana `returns_to_stock: boolean` (obligatorio, documentado);
   `NoteOut` gana `returned_to_stock_item_ids?: number[]` (opcional, misma convención de "todo
   campo de una respuesta es opcional" que ya usaba el resto del archivo). Ningún otro tipo ni
   función de `fiscal.ts` cambió.
2. **`NotesPage.tsx`** — la tabla de líneas de `NewNoteForm` gana una columna **"Inventario"**. Por
   cada línea **tildada** (incluida en la nota vía el checkbox que ya existía), un par de botones
   con `role="radiogroup"`/`role="radio"`/`aria-checked` (mismo patrón accesible que ya usan
   `NewOrderPage.tsx` y `QuickProductionPage.tsx`, no inventé un componente nuevo) — **"Vuelve al
   inventario"** / **"Se usó (no vuelve al inventario)"**, sin ninguno preseleccionado
   (`returnsToStock[item_id]` arranca `undefined`, no `true`/`false`). Debajo, una línea de texto
   con la consecuencia en palabras del dueño: *"Los insumos de este plato vuelven al stock
   teórico"* / *"Los insumos no vuelven: el plato se consumió"* / *"Elegí una opción para poder
   emitir la nota"* mientras no se eligió. El botón **"Emitir nota"** queda deshabilitado
   (`canSubmit`) mientras exista una línea tildada sin elegir. Al destildar una línea se borra su
   elección previa (si se vuelve a tildar, pide de nuevo, nunca queda una elección vieja oculta).
   Las líneas **no** tildadas no piden nada (van fijas en `false`, no forman parte de la nota).
3. **Nota débito** (`kind === "debit"`): la columna muestra *"No aplica (nota débito)"` en vez de
   los botones — nunca se pregunta — y el payload manda `returns_to_stock: false` en **todas** las
   líneas, tildadas o no (una nota débito cobra más, no devuelve producto).
4. **Después del `201`**, `onSuccess` lee `note.returned_to_stock_item_ids` y muestra un aviso
   (`role="status"`) arriba del formulario: *"Ningún ítem volvió al inventario."* si viene vacía/
   ausente, o *"1 ítem volvió al inventario."* / *"N ítems volvieron al inventario."* con el
   conteo exacto que mandó el backend — nunca un cálculo propio, sólo la longitud del array que
   llegó. Ningún costo se pinta en esta pantalla (no cambié eso, ya era así).
5. **Tests** en `frontend/src/features/fiscal/__tests__/NotesPage.test.tsx` (2 casos nuevos,
   agregados a los 3 que ya existían): (a) tildar una línea sin elegir deja "Emitir nota"
   deshabilitado, elegir "Vuelve al inventario" lo habilita, y el `createNote` mockeado recibe
   `lines: [{item_id, used: true, returns_to_stock: true}, {item_id, used: false, returns_to_stock:
   false}]` — el payload exacto, con la línea no tildada también explícita en `false`; el aviso
   posterior muestra `"1 ítem volvió al inventario."` cuando el mock responde
   `returned_to_stock_item_ids: [100]`. (b) en nota débito no aparece ningún `role="radio"`, el
   botón queda habilitado sin pedir elección, el payload manda `returns_to_stock: false`, y el
   aviso dice `"Ningún ítem volvió al inventario."` cuando el mock responde `[]`.

No toqué ninguna otra parte de `fiscal.ts`/`NotesPage.tsx` (rangos, documentos DIAN, evidencia,
export, refunds, la lista de notas ya emitidas) — sólo lo que pedía el ajuste de ronda 2.

---

## Verificación corrida

**Ronda 1:**

```
cd frontend && npm run typecheck                                                    # limpio
cd frontend && TMPDIR=/tmp/pt-frontend-inventario npx vitest run \
  src/features/inventory src/features/reports src/app src/components \
  src/features/settings src/features/auth                                          # 19 archivos, 66 tests, todos en verde
```

**Ronda 2:**

```
cd frontend && npx tsc --noEmit -p .                                                # limpio, sin salida

cd frontend && TMPDIR=/tmp/pt-frontend-inventario npx vitest run \
  src/audit/cost-display.test.tsx src/lib/__tests__/money.test.ts \
  src/components/__tests__ src/features/inventory src/features/fiscal/__tests__/NotesPage.test.tsx \
  src/features/reports src/app src/features/settings src/features/auth
# 23 archivos, 89 tests — todos en verde (incluye los 5 casos de cost-display.test.tsx del auditor,
# el nuevo IngredientsTab.test.tsx, y los 5 tests de NotesPage.test.tsx — 3 previos + 2 nuevos)

# Sanity check de compatibilidad, sólo lectura, sin editar nada de features/recipes/**:
cd frontend && TMPDIR=/tmp/pt-frontend-inventario npx vitest run \
  src/features/recipes/costDisplay.test.tsx src/features/recipes/PreparationsAdminPage.test.tsx
# 2 archivos, 13 tests — todos en verde con el CostValue compartido

# También corrí, por separado, el archivo completo de auditoría de inventario aunque esta ronda no
# lo pedía explícitamente (toqué CostValue, que es parte de su territorio auditado):
cd frontend && TMPDIR=/tmp/pt-frontend-inventario npx vitest run src/audit/inventory.test.ts
# 1 archivo, 15 tests — todos en verde
```

No corrí la suite completa de frontend, `npm run build` ni la suite de backend — están fuera de mi
territorio de verificación (regla del pedido: eso lo corre una sola vez, en serie, el paso de
verificación del orquestador). No hice `git commit` ni `git push`.
