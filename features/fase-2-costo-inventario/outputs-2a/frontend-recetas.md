# frontend-recetas — Carta y recetas, preparaciones y producción rápida

Entregable del builder **frontend-recetas**, pedido 2a
(`features/fase-2-costo-inventario/spec.md`). Construye, sobre lo que ya
entregaron 1a/1b, las pantallas de fichas técnicas, `recipe_effect`,
preparaciones y producción rápida del POS. Verificado contra el contrato
**real** de `backend-recetas` (`backend/app/recipes/router.py` y
`schemas.py`, leídos directo, no contra la spec sola) y contra
`backend-inventario`/`backend-consumo`, cuyos `outputs-2a/*.md` leí antes de
cerrar esto — en particular confirmé en código que `app.main.DOMAINS` ya
incluye `"inventory"`/`"recipes"` (lo cerró `backend-consumo`; sin eso
ninguna de estas pantallas tendría con qué hablar).

**Estado de la entrega (ronda 1)**: código completo, typecheck limpio
(`npm run typecheck`), 44/44 tests de mi territorio en verde (13 archivos,
`src/features/recipes` + `src/features/catalog`). Dos bugs reales los
atrapó mi propia batería de tests antes de cerrar esto (detalle en la
sección 5): un selector de "Tipo" que se desincronizaba de qué insumo o
preparación quedaba elegido, y una condición de carrera entre el aviso
"v1 → v2" y la sincronización automática de líneas que lo borraba en el
mismo render en que aparecía.

**Ronda 2 (ajuste del Maestro, conflicto `conflict-002-b2`)**:
`backend-recetas` cambió `PreparationAdminOut.unit_cost`,
`PrepBatchAdminOut.total_cost`/`.unit_cost` y
`ProductRecipeOut.theoretical_cost` de entero de pesos a **texto decimal en
pesos con precisión completa** (un costo por gramo real, como el $0,003/g de
la sal del seed, redondeado a peso publicaba `0` con origen `official`: el
cero mudo que la spec prohíbe). Retipeé los tres campos en
`frontend/src/api/recipes.ts`, borré mi implementación local de `CostValue`
y `COST_SOURCE_LABEL` en `costDisplay.tsx` y las re-exporté del componente
compartido `@/components/CostValue` (territorio de frontend-inventario, que
lo arregla en esta misma ronda), verifiqué que ningún call site
(`PreparationsAdminPage.tsx`, `PrepBatchesPanel.tsx`, `RecipeEditor.tsx`)
hiciera `Number(...)`/`?? 0`/`toLocaleString`/comparación numérica sobre
esos campos, y actualicé los tres archivos de test a fixtures string más el
caso `unit_cost: "0.003"` que no se pinta `"$ 0"`. Detalle completo,
incluido el estado real de esos dos tests al cerrar esta ronda, en la
sección 8.

---

## 1. Pantallas construidas y su ruta

### Admin → Carta → pestaña **Recetas** (nueva, dentro de la Carta que ya existe)

`frontend/src/features/catalog/CatalogAdminPage.tsx` gana una pestaña
`Recetas`, detrás de `catalog.recipes`, junto a las que ya había
(Categorías/Productos/Modificadores/Combos/Menú del día). Vive en
`frontend/src/features/catalog/RecipesTab.tsx` con tres sub-pestañas:

- **Fichas técnicas** (`RecipeEditor.tsx`): elegir un plato, ver su versión
  vigente, costo teórico con origen, precio neto de impuesto y food cost %
  con la franja del sector (28–35 %) resaltada; editar las líneas de
  insumo/preparación (alta, baja, edición) y guardar. Al guardar muestra
  explícitamente "se guardó como versión N (antes vM)" con la explicación de
  por qué la anterior se conserva.
- **Cobertura** (`CoverageSection.tsx`): platos vendidos en el período que
  no descontaron nada, con `DateRangeFilter` y `CsvExportButton`
  compartidos.
- **Unidades sospechosas** (`SuspiciousUnitsSection.tsx`): las líneas que
  el backend marca como "18 kg donde iban 18 g", con el motivo tal cual lo
  arma el servidor, y `CsvExportButton`.

### Admin → Carta → pestaña **Modificadores** (existente, extendida)

`frontend/src/features/catalog/ModifiersTab.tsx` gana, por cada opción de
modificador y detrás de `catalog.recipes`, un botón **"Efecto en receta"**
que abre `RecipeEffectDialog.tsx` (`frontend/src/features/catalog/`):
elegir `add`/`remove`/`replace`, armar las líneas, y para `replace` elegir
además qué línea de la ficha base reemplaza (poblado desde la ficha vigente
del plato). Quedó en `null` durante todo 1b; ahora se edita.

### Admin → **Preparaciones** (nueva)

`frontend/src/features/recipes/PreparationsAdminPage.tsx`, ruta
`/admin/preparaciones`, detrás de `catalog.preps`. Lista con modo (con la
explicación de por qué "explotada" es el default), rendimiento estándar,
merma de proceso, vida útil, stock (sólo `batch`) y costo con origen; alta y
edición (`PreparationForm.tsx`, receta propia con
`ComponentLinesEditor.tsx`, compartido con la ficha técnica del plato);
cambiar de modo (`PrepModeSwitchDialog.tsx`) con PIN de administrador y el
aviso **antes** de confirmar de que salir de `batch` cierra los lotes
abiertos; ver lotes (`PrepBatchesPanel.tsx`) con rendimiento esperado vs
real y la diferencia resaltada cuando supera 15 %.

### POS/cocina → **Producir** (nueva)

`frontend/src/features/recipes/QuickProductionPage.tsx`, ruta
`/pos/produccion`, detrás de `catalog.preps`. Producción rápida en **dos
toques** (detalle en la sección 5). Sesión de dispositivo: ni un campo de
costo ni de margen en pantalla.

---

## 2. Endpoints y campos que consumo (para el Conciliador)

Todos bajo `/api/v1`. Los leí directo de `backend/app/recipes/router.py` y
`schemas.py` (no de la spec sola), así que reflejan el contrato **real**
tal como está montado hoy.

**Admin — preparaciones** (`app/recipes/router.py`):
- `GET /admin/preparations?store_id&active_only&format` → `PreparationAdminOut[]` (`id, name, mode, standard_yield_qty, standard_yield_unit, process_loss_pct, shelf_life_days, active, current_stock, unit_cost, cost_source, lines[]`) — **ronda 2**: `unit_cost` es **string decimal en pesos con precisión completa** (`"0.003"`), no entero; ídem `PrepBatchAdminOut.total_cost`/`.unit_cost` y `ProductRecipeOut.theoretical_cost` más abajo.
- `POST /admin/preparations?store_id` con `PreparationIn` (`name, mode, standard_yield_qty, standard_yield_unit, process_loss_pct?, shelf_life_days?, lines[]`)
- `PATCH /admin/preparations/{id}` con `PreparationUpdateIn` (sin `mode`: cambiar de modo es sólo por el endpoint siguiente)
- `PATCH /admin/preparations/{id}/mode` con `{mode, authorizer_pin}`
- `GET /admin/preparations/{id}/batches` → `PrepBatchAdminOut[]`

**Dispositivo — producción rápida**:
- `GET /preparations` → `PreparationDeviceOut[]` (`id, name, mode, prefilled_qty, standard_yield_unit, shelf_life_days` — sin costo)
- `POST /preparations/{id}/produce` (`Idempotency-Key`) con `{qty_expected, qty_real, employee_pin, note?}` → `ProduceOut` (sin costo)

**Fichas técnicas**:
- `GET /admin/products/{id}/recipe` → `ProductRecipeOut` (`product_id, version, theoretical_cost, cost_source, food_cost_pct, net_price, lines[]`)
- `PUT /admin/products/{id}/recipe` con `{version, lines[]}`

**`recipe_effect`**:
- `PUT /admin/modifier-options/{id}/recipe-effect` con `{effect, lines: [{ingredient_id|preparation_id, qty, unit, replaces_ingredient_id?, replaces_preparation_id?}]}` → `RecipeEffectOut`

**Cobertura y unidades sospechosas**:
- `GET /admin/recipes/coverage?store_id&date_from&date_to&format` → `CoverageItemOut[]` — **ojo**: los parámetros son `date_from`/`date_to`, no `from`/`to` como el resto de los reportes admin del proyecto; lo dejé documentado en `api/recipes.ts` para que no se repita el error a mano.
- `GET /admin/recipes/suspicious-units?store_id&format` → `SuspiciousLineOut[]`

**Líneas insumo/preparación** (`ComponentLineIn`/`ComponentLineOut`, compartido por preparaciones, fichas y `recipe_effect`): `{ingredient_id|preparation_id, qty: string, unit: string}`. `qty` siempre viaja como **string decimal** (`"18.5"`), nunca número JSON — lo hace cumplir el propio `ComponentLineIn` del backend.

**Insumos, sólo para los selectores de línea** (endpoint de otro territorio, `app/inventory/router.py`, ya montado y funcionando — lo verifiqué leyendo el router):
- `GET /admin/ingredients?store_id&active_only` → uso sólo `{id, name, base_unit, category?, active?}` de la respuesta completa (`IngredientOut` trae más campos — costo, umbrales — que no son míos). Tipado localmente en `api/recipes.ts` como `IngredientOption`, **no** duplico el `IngredientOut` completo que le toca a quien construya `src/features/inventory/**`.
- `GET /device/ingredients` existe (`{id, name, base_unit}`) pero **no lo consumo**: mi pantalla de dispositivo (producción rápida) sólo elige preparaciones, nunca insumos sueltos.

Ningún endpoint que consumo estuvo ausente del contrato de `backend-recetas`; el único hueco es la falta de un `GET` para `recipe_effect` (sección 7).

---

## 3. `recipesFeature` — qué exporta y cómo se registra

`frontend/src/features/recipes/index.ts` (Paso 0 cumplido desde el primer
commit de esta tarea, antes de construir ninguna pantalla):

```ts
export const recipesFeature = { posRoutes, adminRoutes, posNav, adminNav }
// posRoutes:  [{ path: "produccion", element: <QuickProductionPage/> }]
// adminRoutes:[{ path: "preparaciones", element: <PreparationsAdminPage/> }]
// posNav:     [{ to: "/pos/produccion", label: "Producir", feature: "catalog.preps" }]
// adminNav:   [{ to: "/admin/preparaciones", label: "Preparaciones", feature: "catalog.preps" }]
```

Mismo patrón que `ordersFeature` (`src/features/orders/index.ts`): quien es
dueño de `src/app/router.tsx`, `PosLayout.tsx` y `AdminLayout.tsx` importa
este símbolo y concatena sus listas — **no toqué ninguno de esos tres
archivos** (fuera de mi territorio). Al momento de cerrar esta entrega,
`router.tsx`/`AdminLayout.tsx`/`PosLayout.tsx` **todavía no importan
`recipesFeature`** (confirmado leyendo los tres): eso es lo que falta para
que "Preparaciones" y "Producir" aparezcan navegables de punta a punta —
está documentado en gaps (sección 7), porque es de otro territorio.

La pantalla de "Carta y recetas" (pestaña `Recetas` dentro de Carta) y el
botón "Efecto en receta" en Modificadores **no necesitan registro nuevo**:
viven dentro de `CatalogAdminPage.tsx`, que ya está montado por
`catalogFeature` desde 1a.

---

## 4. Costo sin origen y `null` frente a `0`

Desde la ronda 2, `CostValue`/`COST_SOURCE_LABEL` **no son míos**: viven en
el componente compartido `frontend/src/components/CostValue.tsx`
(territorio de `frontend-inventario`), y
`frontend/src/features/recipes/costDisplay.tsx` sólo los re-exporta
(`export { CostValue, COST_SOURCE_LABEL } from "@/components/CostValue"`)
para que las pantallas de este módulo y las de inventario compartan una
sola implementación (detalle completo en la sección 8). Lo que sigue
describe el comportamiento visible, que no cambié:

- `CostValue({cost, costSource})`: si `cost === null` **o**
  `costSource === "none"`, pinta "Sin costo" + `Badge` "origen: ninguno" —
  nunca `$0`. Con costo, pinta el pesos formateado + un `Badge` con el
  origen (`official`/`weighted_average`/`last_purchase`/`estimated`) en
  español. `cost` viaja como **string decimal en pesos con precisión
  completa** (`unit_cost`/`total_cost`/`theoretical_cost`, ronda 2) — nunca
  lo convierto yo a número ni lo formateo: se lo paso tal cual al
  componente compartido.
- `FoodCostBadge({pct})`: `pct === null` → "Food cost: sin datos" (nunca
  "0 %"). Con dato, pinta el porcentaje tal cual lo mandó el servidor
  (`food_cost_pct` es un `Decimal` serializado como **string**, p. ej.
  `"31.58"` — nunca lo convierto a número para mostrarlo) y compara ese
  número **sólo** contra la franja 28–35 % para elegir el tono del `Badge`
  (`secondary` dentro de rango, `destructive` fuera). Esa comparación es la
  única aritmética de este módulo sobre un dato de costo: no deriva ni
  redondea nada, sólo clasifica un valor que ya calculó el servidor para
  decidir un color — lo dejo explícito acá por si el auditor prefiere que
  ni eso se compare en el cliente.
- Probado explícitamente (`costDisplay.test.tsx`,
  `RecipeEditor.test.tsx`, `PreparationsAdminPage.test.tsx`): un costo
  `null` nunca renderiza el texto `"$ 0"` ni `"$0"`. Ronda 2 sumó el caso
  específico que motivó el cambio de contrato — un costo **sub-peso**
  (`unit_cost: "0.003"`, `cost_source: "official"`, la sal del seed) que
  tampoco se pinta `"$ 0"` — en `costDisplay.test.tsx` y en
  `PreparationsAdminPage.test.tsx`. **Estado real al cerrar esta ronda**:
  esos dos casos nuevos están **en rojo** porque
  `frontend/src/components/CostValue.tsx` (territorio de
  `frontend-inventario`) todavía hace `Number(cost)` seguido de `formatCOP`
  internamente — que redondea `0.003` a `"$ 0"` — y esta ronda me pide
  explícitamente no editar ese archivo ni improvisar un formateo propio.
  Están escritos para pasar en cuanto `frontend-inventario` cierre su
  arreglo en ese componente; el resto de mi batería (44/46) sigue en verde.
  Detalle en la sección 8.

Cantidades: nunca las parseo a número para operar con ellas. Se muestran
como el string decimal que manda el servidor (`qty`, `standard_yield_qty`,
`current_stock`, `variance_pct`, etc.) concatenado con la unidad. La única
"inteligencia" sobre una cantidad en el cliente es acotar qué unidades
ofrece el `<select>` de una línea según la unidad base del insumo/preparación
elegido (para evitar un `400 UNIT_MISMATCH` evitable) — nunca convierto
entre unidades ni sumo cantidades.

---

## 5. Los dos toques de la producción rápida, contados

`QuickProductionPage.tsx` (POS/cocina, detrás de `catalog.preps`):

1. **Toque 1**: tocar la tarjeta de la preparación. Sólo se listan
   preparaciones en modo `batch` (las `exploded` no se producen: el
   backend respondería `400 PREP_NOT_BATCH`, así que ni se ofrecen). Al
   tocarla, la pantalla pasa directo a la confirmación — no hay una
   pantalla intermedia — con la cantidad **precargada** en
   `prefilled_qty` (= rendimiento estándar) en el campo "Cantidad real
   obtenida", editable sólo si hace falta.
2. **Toque 2**: el cuarto dígito del PIN propio (`PinPad`, que auto-envía
   al completarse). No hay un botón "Confirmar" aparte — completar el PIN
   **es** confirmar.

Detalles de la implementación:
- `qty_expected` que se manda es siempre `prefilled_qty` (el rendimiento
  estándar de la preparación); `qty_real` es el campo editable, precargado
  igual. Si difieren, el backend calcula la variación y avisa con
  `variance_alert`; la pantalla lo muestra con un `toast.warning` (nunca
  bloquea).
- `Idempotency-Key` nueva por intento (`newIdempotencyKey()`), guardada en
  un `useRef` para sobrevivir re-renders. Se regenera al terminar con
  éxito y ante cualquier error **que no sea** `409` (un PIN mal tecleado,
  por ejemplo, tiene que poder reintentarse con una clave nueva: si se
  reintentara con la misma clave y un PIN distinto, el servidor respondería
  `IDEMPOTENCY_MISMATCH` en vez del error real). Ante
  `409 IDEMPOTENCY_IN_PROGRESS` (la misma clave todavía en vuelo, típico de
  un doble toque accidental) la clave **se mantiene a propósito**, para no
  duplicar el lote — probado (`QuickProductionPage.test.tsx`, siete casos:
  dos toques, filtro sólo `batch`, aviso de variación, clave nueva por
  intento, clave estable ante 409, clave nueva ante un error de negocio).
- **Mitigación del defecto conocido de `PinPad`** (escucha `keydown` a
  nivel de `window` sin filtrar por foco, componente compartido, ajeno,
  reportado también por `frontend-cobro` en 1b-1): el campo "Cantidad real
  obtenida" es el único texto libre que convive con el `PinPad` en esta
  pantalla, y el `PinPad` queda `disabled` mientras ese campo tiene el
  foco (`onFocus`/`onBlur`), para que un dígito tecleado ahí no se cuele
  como dígito de PIN. A diferencia de la mitigación de `PaymentSplitsForm`
  en 1b-1 (que deshabilita el `PinPad` hasta que los montos "cierran"), acá
  el campo puede quedar vacío sin que eso sea un error, así que la gobierno
  por foco en vez de por un estado derivado. No toqué `PinPad.tsx` (no es
  mi territorio).
- Ruta de dispositivo: `PreparationDeviceOut` y `ProduceOut` no tienen
  ningún campo de costo — no hay nada que "no pintar", directamente no
  llega. Probado explícitamente que la pantalla no renderiza ningún `$`.

---

## 6. 375 px / 1024 px / foco / contraste

- **POS a 375 px**: `QuickProductionPage` en una columna (`max-w-sm
  mx-auto`), grilla de preparaciones `grid-cols-2` (sube a `sm:grid-cols-3`
  en pantallas más anchas), botones e inputs con alto ≥ 44 px
  (`h-12`/`h-14`, dígitos del `PinPad` ya cumplían esto). Sin overflow
  horizontal: nada usa ancho fijo, todo es `flex`/`grid` con `gap`.
- **Admin a 1024 px**: toda tabla nueva (`Preparaciones`, lotes, cobertura,
  unidades sospechosas) va envuelta en `overflow-x-auto` (mismo patrón que
  `PickupsPanel`/`DocumentsPage` de 1b), así que un exceso de columnas
  scrollea la tabla, nunca la página. Formularios en `grid` responsivo
  (`grid-cols-2 sm:grid-cols-4`, etc.).
- **Foco visible**: todo botón/input/select nuevo usa los componentes
  compartidos (`Button`, `Input`, `Select`, `PinPad`), que ya traen
  `focus-visible:ring-*`; las tarjetas de preparación a tocar en el POS
  (elemento propio, no un componente compartido) copian el mismo patrón de
  foco que usa `EmployeePicker.tsx`
  (`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`).
- **Contraste AA**: sin colores nuevos — todo sale de los tokens ya
  auditados del proyecto (`text-muted-foreground`, `text-destructive`,
  variantes de `Badge`, `border-destructive/*`).
- **No pude medir contraste con una herramienta real** ni recorrer esto en
  un navegador (sin runner de Playwright disponible en este entorno) — lo
  mismo que declaran los entregables de 1a/1b para este mismo punto del
  checklist. Verificado por inspección de fuente y por los tests con
  Testing Library (46 a día de hoy), que sí exigen roles/labels accesibles
  reales (no `data-testid` a secas) en todo lo interactivo.

---

## 7. Ronda 2 — costos a texto decimal (`conflict-002-b2`)

Ajuste del Maestro sobre el contrato publicado por `backend-recetas`:
`PreparationAdminOut.unit_cost`, `PrepBatchAdminOut.total_cost`/`.unit_cost`
y `ProductRecipeOut.theoretical_cost` pasan de entero de pesos a **texto
decimal en pesos con precisión completa** (mismo formato que `inventory`),
porque un costo por gramo real ($0,003/g de la sal del seed) redondeado a
pesos publicaba `0` con origen `official` — el cero mudo que la spec
prohíbe.

**Lo que cambié:**

1. `frontend/src/api/recipes.ts`: los tres campos retipados de
   `number | null` a `string | null`, con un comentario en cada uno que
   explica por qué (el caso de la sal). `food_cost_pct` seguía siendo
   `string | null` desde la ronda 1 y no cambió; `cost_source` tampoco.
2. `frontend/src/features/recipes/costDisplay.tsx`: borré mi `CostValue` y
   `COST_SOURCE_LABEL` locales; ahora el archivo los re-exporta tal cual de
   `@/components/CostValue` (`export { CostValue, COST_SOURCE_LABEL } from
   "@/components/CostValue"`). No toqué `CostValue.tsx` — es territorio de
   `frontend-inventario`, que lo arregla en esta misma ronda. `FoodCostBadge`,
   `foodCostInBand` y `VarianceBadge` siguen acá, sin cambios de lógica (ya
   trabajaban sobre strings desde la ronda 1).
3. Revisé los cuatro call sites que la ronda me pidió verificar
   (`PreparationsAdminPage.tsx:78`, `PrepBatchesPanel.tsx:88` y `:91`,
   `RecipeEditor.tsx:162`): ninguno hace `Number(...)`, `?? 0`,
   `toLocaleString` ni comparación numérica sobre `unit_cost`/`total_cost`/
   `theoretical_cost` — todos pasan el campo tal cual a `<CostValue
   cost={...} costSource={...} />`. No hizo falta tocar ninguno de los tres
   archivos de código.
4. Tests actualizados a fixtures string
   (`costDisplay.test.tsx`, `PreparationsAdminPage.test.tsx`,
   `RecipeEditor.test.tsx`) y agregué el caso pedido — una preparación con
   `unit_cost: "0.003"`, `cost_source: "official"` (bauticé la fixture
   `SAL`, la sal del seed que motivó el cambio) que no debe pintar `"$ 0"` —
   tanto sobre `CostValue` directo (`costDisplay.test.tsx`) como sobre la
   pantalla real (`PreparationsAdminPage.test.tsx`).
5. Confirmé que `QuickProductionPage.tsx` sigue sin importar `CostValue` ni
   `costDisplay` (invariante de sesión de dispositivo, sin cambios).

**Estado real de la verificación de esta ronda** (`npx vitest run
src/features/recipes src/features/catalog` + `npm run typecheck`):
typecheck **limpio**. Tests: **44/46 en verde, 2 en rojo** — exactamente
los dos casos nuevos del punto 4 (`costDisplay.test.tsx` y
`PreparationsAdminPage.test.tsx`), porque al momento de correr esta
verificación `frontend/src/components/CostValue.tsx` **todavía no tenía**
el arreglo de `frontend-inventario`: internamente sigue haciendo
`typeof cost === "string" ? Number(cost) : cost` y después `formatCOP(...)`,
que redondea `0.003` a `"$ 0"` (confirmado leyendo el archivo, sin
tocarlo). Los dos tests están escritos correctamente contra el contrato
nuevo y van a pasar solos en cuanto ese componente compartido deje de
redondear — no es algo que yo pueda cerrar desde mi territorio sin
duplicar formateo, que es justo lo que esta ronda pide evitar. Esto queda
como el primer punto de la sección de gaps.

---

## 8. Gaps

- **Dos tests en rojo a la espera del arreglo de `frontend-inventario` en
  `CostValue.tsx`** (no es un gap de mi territorio, pero afecta mi
  resultado de verificación y hay que dejarlo trazado): al cerrar la ronda
  2, `costDisplay.test.tsx` → "un costo sub-peso ($0,003) con origen
  oficial NO se pinta como «$ 0»" y `PreparationsAdminPage.test.tsx` → "un
  costo sub-peso con origen oficial (la sal, $0,003) no se pinta «$ 0»"
  fallan porque el componente compartido `@/components/CostValue` todavía
  redondea con `Number(cost)` + `formatCOP` antes de pintar. Detalle
  completo en la sección 7. Nada que resolver de mi lado sin invadir ese
  territorio.
- **`router.tsx`/`PosLayout.tsx`/`AdminLayout.tsx` todavía no importan
  `recipesFeature`** (verificado leyendo los tres archivos al cerrar esta
  entrega): mientras eso no pase, `/admin/preparaciones` y `/pos/produccion`
  no aparecen en la navegación ni son alcanzables — el símbolo ya existe
  (Paso 0) para que quien sea dueño de esos tres archivos sólo tenga que
  concatenar las cuatro listas, igual que ya hace con `ordersFeature`. No
  es mi territorio.
- **No hay `GET` para `recipe_effect`** (confirmado en
  `app/recipes/router.py`: sólo existe
  `PUT /admin/modifier-options/{id}/recipe-effect`, y `GET
  /admin/modifier-groups` de `app.catalog` tampoco lo trae embebido).
  `RecipeEffectDialog.tsx` es por eso un editor de **sólo escritura**:
  abre siempre en blanco, nunca puede mostrar qué efecto quedó guardado en
  una sesión anterior, y `ModifiersTab.tsx` no puede pintar ni un indicio
  ("esta opción ya tiene un efecto") en la lista de opciones. Probado así
  a propósito (`RecipeEffectDialog.test.tsx`, "abre siempre en blanco").
  Pido: o un `GET /admin/modifier-options/{id}/recipe-effect`, o que
  `ModifierOptionOut` (de `app.catalog`, que ese dominio dejó de sólo
  lectura este pedido) embeba el efecto vigente.
- **Un insumo desactivado que sigue referenciado por una ficha o
  preparación vieja no tiene nombre en el selector**: `GET
  /admin/ingredients` que uso para poblar `ComponentLinesEditor` pide
  `active_only=true`; si una línea ya guardada apunta a un insumo que
  después se desactivó, esa línea se sigue mostrando (su `ingredient_id`
  no se pierde) pero el `<select>` no tiene una opción con ese id para
  mostrar el nombre — queda en blanco hasta que se lo reemplace o se
  reactive el insumo. No construí un `active_only=false` de reserva para
  este caso porque no es mi endpoint y no quise ensanchar un contrato
  ajeno sin acuerdo; lo dejo señalado para quien sea dueño de
  `GET /admin/ingredients`.
- **La producción rápida no pide `note`** (el campo existe en `ProduceIn`):
  decisión deliberada para no sumar un tercer campo a la pantalla de "dos
  toques" — spec y checklist piden dos toques, no tres campos. Si el
  negocio necesita motivo obligatorio en la producción, es un cambio
  chico pero afecta el conteo de toques, así que lo dejo para decisión
  explícita del dueño de la spec en vez de agregarlo por mi cuenta.
- **No construí pantallas de Inventario** (stock, movimientos por causa,
  mermas, negativos con causa probable): están explícitamente fuera de mi
  territorio (`src/features/inventory/**`) según el reparto de este
  pedido, aunque §9.3 las menciona en la misma sección "Preparaciones". Lo
  mismo para insumos críticos/umbrales en Configuración
  (`src/features/settings/**`, tampoco mío) — no vi ningún campo de
  configuración de sede nuevo en el contrato que consumí que quedara sin
  pantalla por mi culpa; si `backend-inventario`/`backend-recetas` agregó
  alguno, no lo vi documentado como tal en sus entregables.
- **No verifiqué contra Postgres real ni en un navegador** (sin runner ni
  Postgres/Playwright disponibles en este entorno) — mismo límite que
  declaran 1a/1b y los otros dos entregables de este mismo pedido.
- **No corrí la suite completa ni el build**: por instrucción explícita
  (varios agentes en paralelo sobre el mismo árbol); eso lo corre el
  paso de verificación del orquestador, una vez, en serie, con el árbol
  quieto.

---

## Archivos tocados

**Nuevos** (todo bajo mi territorio: `frontend/src/features/recipes/**`,
`frontend/src/features/catalog/**`, `frontend/src/api/recipes.ts`):

- `frontend/src/api/recipes.ts`
- `frontend/src/features/recipes/index.ts` (+ `index.test.ts`)
- `frontend/src/features/recipes/costDisplay.tsx` (+ test)
- `frontend/src/features/recipes/ComponentLinesEditor.tsx` (+ test)
- `frontend/src/features/recipes/PreparationForm.tsx`
- `frontend/src/features/recipes/PrepModeSwitchDialog.tsx`
- `frontend/src/features/recipes/PrepBatchesPanel.tsx`
- `frontend/src/features/recipes/PreparationsAdminPage.tsx` (+ test)
- `frontend/src/features/recipes/QuickProductionPage.tsx` (+ test)
- `frontend/src/features/catalog/RecipesTab.tsx`
- `frontend/src/features/catalog/RecipeEditor.tsx` (+ test)
- `frontend/src/features/catalog/CoverageSection.tsx` (+ test)
- `frontend/src/features/catalog/SuspiciousUnitsSection.tsx` (+ test)
- `frontend/src/features/catalog/RecipeEffectDialog.tsx` (+ test)
- `frontend/src/features/catalog/ModifiersTab.test.tsx` (el componente no tenía tests todavía)

**Editados** (existentes, extendidos):

- `frontend/src/features/catalog/CatalogAdminPage.tsx` (pestaña "Recetas" detrás de `catalog.recipes`)
- `frontend/src/features/catalog/ModifiersTab.tsx` (botón "Efecto en receta" por opción, detrás de `catalog.recipes`)
- `frontend/src/features/catalog/CatalogAdminPage.test.tsx` (dos casos nuevos para la pestaña)

**Editados en ronda 2** (`conflict-002-b2`, costos a texto decimal — sección 7):

- `frontend/src/api/recipes.ts` (`PreparationAdminOut.unit_cost`, `PrepBatchAdminOut.total_cost`/`.unit_cost`, `ProductRecipeOut.theoretical_cost`: `number | null` → `string | null`)
- `frontend/src/features/recipes/costDisplay.tsx` (`CostValue`/`COST_SOURCE_LABEL` locales borrados; re-exportados de `@/components/CostValue`)
- `frontend/src/features/recipes/costDisplay.test.tsx` (fixture string + caso `unit_cost: "0.003"`)
- `frontend/src/features/recipes/PreparationsAdminPage.test.tsx` (fixture string + fixture `SAL` con `unit_cost: "0.003"` y su caso)
- `frontend/src/features/catalog/RecipeEditor.test.tsx` (fixture `theoretical_cost` a string)

**Verificación corrida** (este territorio únicamente):

```
npx vitest run src/features/recipes src/features/catalog   # 13 archivos
npm run typecheck                                            # limpio
```

**Ronda 1**: 44/44 tests en verde.
**Ronda 2**: typecheck limpio; tests **44/46 en verde, 2 en rojo**
(`costDisplay.test.tsx` y `PreparationsAdminPage.test.tsx`, el caso
`unit_cost: "0.003"` — en rojo por el redondeo todavía sin arreglar en
`frontend/src/components/CostValue.tsx`, territorio de
`frontend-inventario`; detalle y por qué no lo toco en la sección 7-8).
