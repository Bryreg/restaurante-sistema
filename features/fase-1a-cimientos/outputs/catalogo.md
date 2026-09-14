# Carta plana — API y pantalla Admin → Carta (pedido 1a)

Agente: `catalogo` (full-stack). Territorio: `backend/app/catalog/**`,
`backend/tests/catalog/**`, `backend/alembic/versions/0002_catalog.py`,
`frontend/src/features/catalog/**`, `frontend/src/api/catalog.ts`. No se tocó
ningún archivo fuera de ese territorio.

## 1. Modelos (`backend/app/catalog/models.py`)

Todos con `organization_id` **y** `store_id` propios (índice en ambos, sin
necesitar un join a `stores` para el aislamiento), dinero en `Integer`, baja
lógica con `active` donde aplica. Nada se borra físicamente.

- **`Category`**: `name`, `sort_order`, `default_course`, `default_station`,
  `active`. `default_course`/`default_station` son String libre (no un enum
  fijo): la sede configura sus propios cursos y estaciones en
  `StoreSalesSettings` (de `backend-core`), y este módulo no impone un
  segundo catálogo cerrado sobre el mismo concepto.
- **`Product`**: `category_id` (FK, obligatorio), `name`, `description`,
  `station`, `default_course` (si no vienen, caen al de la categoría al
  crear), `price_dine_in` obligatorio (`CHECK >= 0`), `price_takeout` /
  `price_delivery` / `price_platform` opcionales (nullable, `CHECK >= 0` si
  vienen), `tax_code` (`inc_8`|`iva_19`|`excluded`, con default la fiscal
  vigente de la sede si no se manda), `active`, `available`, `daily_count` /
  `daily_remaining` opcionales, `unavailable_by_employee_id` (FK real) +
  `unavailable_by_employee_name` (copia congelada) + `unavailable_at`. **Sin
  ningún campo de costo.**
- **`ModifierGroup`**: `product_id`, `name`, `required`, `min`, `max`
  (`CHECK max >= min`), `sort_order`.
- **`ModifierOption`**: `modifier_group_id`, `name`, `price_delta` (puede ser
  negativo), `available`, `unavailable_by_employee_id/name/at`,
  `recipe_effect` (JSON, **siempre `NULL`** en esta fase — la columna ya
  existe para no migrar de nuevo cuando llegue `catalog.recipes` en fase 2).
- **`Combo`**: `name`, `price` (`CHECK >= 0`), `active`, `schedule` (JSON
  `{"days": [0..6], "from": "HH:MM", "to": "HH:MM"}`; `days` con la
  convención de `date.weekday()`: 0 = lunes, 6 = domingo). Un combo sin
  grupos no puede quedar `active=True` (ver §2).
- **`ComboGroup`**: `combo_id`, `name`, `sort_order`.
- **`ComboOption`**: `combo_group_id`, `product_id` (siempre ligada a un
  producto real: no tiene nombre propio), **dos banderas independientes**:
  `active_today` (si es parte del menú de hoy — la controla "armar el menú
  de hoy") y `available_today` (si, estando en el menú de hoy, se agotó),
  más `unavailable_by_employee_id/name/at`.

**Decisión de diseño explícita** — `active_today` por defecto `True` (todo
incluido) tanto al crear una opción como al `reset_daily_availability`: así
un combo fijo simple (sin curaduría diaria) queda vendible sin que el admin
tenga que "armar" nada, y el menú del día se arma **recortando** con el
checklist lo que no se sirve hoy, no construyendo desde cero cada mañana. Es
más rápido para el caso común ("en menos de dos minutos") y no rompe combos
que no son un menú del día.

## 2. Reglas de negocio (`service.py`)

- `resolve_tax_code`: `tax_code` explícito, o `StoreFiscalConfig.default_tax`
  vigente (vía `app.stores.service.current_fiscal`), o `inc_8` si la sede
  todavía no tiene fiscal configurada.
- **Precio por canal**: en `GET /admin/products` (crudo, `null` si no se
  configuró — es lo que la tabla de admin pinta como "—") vs. `GET /catalog`
  (resuelto: `takeout`/`delivery`/`platform` ausentes caen al de mesa,
  **nunca `null`** ahí — SPEC-NEGOCIO §4.3).
- `combo_active_now(schedule, now_utc)`: convierte a `America/Bogota`
  (`app.core.tz`) y compara día de semana + minuto del día contra
  `days`/`from`/`to`; resuelve franjas que cruzan medianoche (`from > to`)
  comparando también contra el día anterior. 9 tests unitarios puros en
  `tests/catalog/test_schedule.py` (dentro y fuera de franja, día no
  listado, cruce de medianoche en sus tres tramos, validación de
  `schedule`).
- `assert_combo_sellable`: `COMBO_WITHOUT_GROUPS` si el combo no tiene
  ningún `ComboGroup` — se exige al crear con `active=true` y al activar por
  `PATCH`.
- `set_combo_today`: reemplazo completo de `active_today` sobre **todas**
  las opciones del combo (las pedidas quedan `True`, el resto `False`) — no
  incremental.
- `set_product_availability` / `set_modifier_option_availability` /
  `set_combo_option_availability`: registran quién y cuándo
  (`unavailable_by_employee_id` FK real + nombre congelado + `at`); al
  marcar un producto no disponible, `notify(..., type="product_unavailable",
  dedupe_key=f"product_unavailable:{id}")` (dedupe diario ya probado con dos
  llamados el mismo día → una sola notificación).
- `reset_daily_availability(db, *, store_id)`: limpia `available`/
  `daily_remaining`/`unavailable_*` de productos y opciones de modificador, y
  `active_today`/`available_today`/`unavailable_*` de opciones de combo. La
  llama `app.shifts.service` al abrir el día (protegido con `find_spec` desde
  el lado de `backend-caja`, `CONTRATO-INTERNO.md §2`); lo prueba
  `tests/catalog/test_availability.py` mutando filas directamente y llamando
  la función.
- Upsert-only en anidados (`ModifierGroupUpdateIn.options`,
  `ComboUpdateIn.groups`/`ComboGroupIn.options`): un `id` presente actualiza,
  uno ausente crea; **no se borra ni se desactiva** lo que queda afuera de la
  lista (declarado como gap en §6 — `ModifierOption` no tiene un campo de
  baja lógica propio en esta fase, y overloadear `available` para eso
  rompería el significado de "agotado hoy").

## 3. Endpoints (`router.py`) — contrato de `spec.md`

Todas las rutas sin prefijo (`app.main` agrega `/api/v1`).

| Ruta | Éxito | Errores de negocio | Flag |
|---|---|---|---|
| `GET /catalog` | 200 | — | núcleo; `modifier_groups`/`combos` vacíos si `pos.modifiers`/`pos.combos` apagados; `daily_count`/`daily_remaining` ocultos (`null`) si `pos.daily_count` apagado |
| `GET/POST /admin/categories`, `PATCH /admin/categories/{id}` | 200 | `404` aislamiento | núcleo |
| `GET/POST /admin/products`, `PATCH /admin/products/{id}` | 200 | `404` aislamiento | núcleo |
| `POST /products/{id}/availability` | 200 | `404`; `400 FEATURE_DISABLED {feature:"pos.daily_count"}` si manda `daily_count` con el flag apagado | núcleo (contador detrás de `pos.daily_count`) |
| `GET/POST /admin/modifier-groups`, `PATCH .../{id}` | 200 | `404`; `400 FEATURE_DISABLED` | `pos.modifiers` |
| `POST /modifier-options/{id}/availability` | 200 | `404`; `400 FEATURE_DISABLED` | `pos.modifiers` |
| `GET/POST /admin/combos`, `PATCH .../{id}` | 200 | `404`; `400 FEATURE_DISABLED`; `400 COMBO_WITHOUT_GROUPS` al crear/activar sin grupos | `pos.combos` |
| `PUT /admin/combos/{id}/today` | 200 | `404`; `400 FEATURE_DISABLED` | `pos.daily_menu` (no `pos.combos`: así lo pide el checklist de `spec.md`) |
| `POST /combo-options/{id}/availability` | 200 | `404`; `400 FEATURE_DISABLED` | `pos.combos` |

- `GET /catalog` acepta un actor **admin o dispositivo sin persona
  identificada** (`_catalog_read_actor`: admin, si no dispositivo activado —
  ver la carta no es una acción sensible); las escrituras de disponibilidad
  usan `current_actor` (admin o dispositivo **con** persona identificada,
  para poder atribuir quién marcó el agotado).
- Aislamiento: toda entidad por `id` se resuelve con `_scoped_or_404` (org
  siempre; sede también si quien pregunta es un dispositivo) → `404`, nunca
  `403`. Probado con un producto real de otra organización (no sólo un id
  inexistente) en `test_admin_categories_products.py`.
- Toda escritura llama `record_audit` con `before`/`after` (creación,
  edición, disponibilidad, "armar el menú de hoy").
- `format=csv` en `/admin/categories`, `/admin/products`, `/admin/combos`
  (mismo patrón `wants_csv`/`csv_response` de `backend-core`).
- Ninguna Idempotency-Key: el contrato de la fase 1a sólo la exige en
  `shifts/*` (territorio de `backend-caja`); la carta no la necesita en esta
  fase.

## 4. Seed (`app/catalog/seed.py`)

`seed_catalog(db, store)`, idempotente (si la sede ya tiene alguna categoría,
no repite nada). Veinte productos en cinco categorías (Entradas 4, Sopas 3,
Platos Fuertes 7, Bebidas 4, Postres 2) con precios reales colombianos;
`Bandeja paisa` y `Lomo al trapo` con grupo de modificador **obligatorio**
("Término de la carne"), `Pechuga a la plancha` con uno opcional
("Acompañamiento extra"). Un combo fijo ("Combo Ejecutivo", todos los días
11:00–21:00) y el menú del día ("Corrientazo del día", lunes a sábado
11:30–15:00) con cuatro grupos (Sopa, Principio, Proteína, Jugo) — el grupo
Proteína deja el pescado **fuera** del menú de hoy a propósito, para que el
seed demuestre una curaduría real, no "todo prendido". La llama
`app.seed.seed()` vía `find_spec` (ya provisto por `backend-core`).

## 5. Migración (`alembic/versions/0002_catalog.py`)

`revision="0002"`, `down_revision="0001"`. DDL Postgres-first escrito a mano:
`categories`, `products`, `modifier_groups`, `modifier_options`, `combos`,
`combo_groups`, `combo_options`, con índice en cada FK y en cada columna que
un router filtra, `CHECK` de precios/`min`/`max` no negativos. Verificado
`0001 → 0002` solo y `0001 → 0002 → 0003` (encadenando con la migración de
`backend-caja`, que ya declaraba `down_revision="0002"` antes de que este
archivo existiera — coordinación explícita del Maestro en
`CONTRATO-INTERNO.md §4`, confirmada funcionando).

## 6. Tests backend — resultado

`cd backend && TMPDIR=/tmp/pt-catalogo python -m pytest tests/catalog -q` →
**43 passed**. `python -m mypy app/catalog` → **sin errores**; `python -m
mypy app` (los 49 archivos que ya existían de todos los dominios) → también
sin errores. `alembic upgrade 0002` y `alembic upgrade head` desde una base
vacía → sin errores.

Archivos: `test_schedule.py` (9, `combo_active_now`/`validate_schedule`
puros), `test_catalog_endpoint.py` (9, incluye el escaneo recursivo de la
respuesta **y** el recorrido de `app.openapi()` resolviendo todos los `$ref`
alcanzables desde el esquema de `GET /catalog` en busca de `cost`/`margin`/
`unit_cost`, precio de canal cayendo al de mesa, `pos.modifiers`/`pos.combos`
apagados, `pos.daily_menu` apagado bloqueando `PUT .../today`, opción de
combo agotada quedando listada con `available_today=false`),
`test_admin_categories_products.py` (7, incluye el caso central de
aislamiento: un `Product` real insertado a mano en la organización B
responde `404` a un admin de la A), `test_admin_modifiers.py` (4),
`test_admin_combos.py` (5, incluye `COMBO_WITHOUT_GROUPS` al crear y al
activar por `PATCH`, y "armar el menú de hoy" dejando la opción no elegida
en `active_today=false`), `test_availability.py` (7, contador de porciones,
gate de `pos.daily_count`, notificación con dedupe diario probado con dos
llamados, `reset_daily_availability`, alcance de actor en
`combo-options/.../availability`), `test_seed.py` (2).

## 7. Frontend — rutas y componentes (`src/features/catalog/`)

- **`index.ts`** (sobreescribe el stub de `frontend-core`, **`.ts` sin JSX**
  — usa `createElement` en vez de `<CatalogAdminPage />`): exporta
  `catalogFeature = { adminRoutes: [{path:"carta", element}], adminNav:
  [{to:"/admin/carta", label:"Carta"}] }`. Ya está enganchado por
  `src/app/router.tsx` (spread en `/admin/*`) y `src/app/AdminLayout.tsx`
  (spread del nav) — confirmado leyendo esos dos archivos, no supuesto.
- **`CatalogAdminPage.tsx`**: consume `useSession().hasFeature` y
  `useStoreSelection()` de `@/app/storeContext` (el selector de sede
  compartido que armó `frontend-core` — no se construyó uno propio; una
  versión anterior de este archivo sí lo hacía con un hook local,
  reemplazada apenas `storeContext.tsx` apareció). `Tabs` con Categorías y
  Productos siempre visibles, Modificadores/Combos/Menú del día detrás de
  `pos.modifiers`/`pos.combos`/`pos.daily_menu`.
- **`CategoriesTab.tsx`**: alta rápida + tabla con `Switch` de activa/baja
  lógica.
- **`ProductsTab.tsx`** + **`ProductForm.tsx`**: tabla con búsqueda, precio
  por canal formateado (`formatCOP`/`parseCOP` de `@/lib/money`) con "—"
  para el opcional ausente, alta y edición en `Dialog`, tasa de impuesto,
  estación, curso, contador de porciones.
- **`ModifiersTab.tsx`**: selector de producto → sus grupos con opciones
  editables (nombre + ajuste de precio) y `Checkbox` de disponibilidad por
  opción; alta de grupo nuevo.
- **`CombosTab.tsx`**: lista con precio y franja activa ahora, alta con
  selector de días/horario y una primera tanda de opciones (para poder
  activarlo de una), `Checkbox` de activo/inactivo.
- **`DailyMenuTab.tsx`**: elige el combo (se auto-selecciona si hay uno
  solo, para no gastar un clic), checklist por grupo con el estado real de
  `active_today` precargado, marcar agotado por opción, "Guardar menú de
  hoy" → `PUT .../today` con la lista completa de ids marcados.
- **`src/api/catalog.ts`**: tipos (todo campo nuevo opcional) y funciones
  sobre `api<T>` de `@/api/client`, un tipo por forma exacta del contrato
  (`ProductPricesRawOut` con canales `null` vs. `ProductPricesResolvedOut`
  resuelto; `ComboOptionOut` vs. `ComboOptionAdminOut` con `active_today`
  sólo en la vista de admin).

Primitivos usados: **sólo** `@/components/ui/*` (button, input, label, card
no, dialog, table, tabs, badge, select, switch, checkbox, textarea) y
`@/components/*` propios de este módulo; nada de color hardcodeado (todo por
clases de tema `text-muted-foreground`/`text-destructive`/etc.); labels
asociados (`htmlFor`/`id`, o `<label>` envolvente con `Checkbox`), foco
visible y teclado los da la base de `@base-ui/react` sin overrides; estados
de carga/vacío/error por recurso con `errorMessage` de `@/lib/errors`; nada
en `localStorage`.

**Bug real encontrado y corregido durante la construcción**: el patrón
`<DialogTrigger asChild><Button/></DialogTrigger>` (estilo Radix) **no
existe** en esta base (`@base-ui/react`): el patrón correcto es
`<DialogTrigger render={<Button/>}>texto</DialogTrigger>`. Lo tenía mal en
`ProductsTab.tsx` (×2), `ProductForm.tsx` y `CombosTab.tsx`; lo corregí ahí.
El mismo bug sigue sin corregir en dos archivos que no son mi territorio —
`src/app/AdminLayout.tsx:117` (`SheetTrigger asChild`) y
`src/features/notifications/NotificationBell.tsx:37` — los reporto en §8, no
los toqué.

## 8. Tests frontend — resultado

`cd frontend && npx vitest run src/features/catalog` → **3 archivos, 4 tests,
todos pasan**: `CatalogAdminPage.test.tsx` (la pestaña Combos —y Menú del
día— no se renderizan con `pos.combos`/`pos.daily_menu` apagados, y sí con
ambos encendidos), `ProductsTab.test.tsx` (precios formateados y "—" cuando
falta el canal opcional), `DailyMenuTab.test.tsx` (armar el menú envía
`active_option_ids` correctos: parte del estado real de `active_today`,
saca una opción, agrega otra, y verifica el payload exacto de
`setComboToday`). Los tres mockean `@/api/catalog` con `vi.mock` (con
`vi.hoisted` para los fixtures, por el hoisting de `vi.mock`), así que no
dependen de que el backend esté corriendo.

`npm run typecheck` (el script real) **falla para todo el repo**, no por mi
código: `tsconfig.app.json` usa `baseUrl`, que TypeScript 6.0.3 (la versión
instalada) marca como error fatal de configuración
(`TS5101`, pide `"ignoreDeprecations": "6.0"`) — corta el compilador antes de
mirar un solo archivo fuente. Es un archivo de `frontend-core`, no lo toqué.
Para verificar mis archivos sin ese bloqueo, corrí `tsc --noEmit` con una
copia temporal de `tsconfig.app.json` + `ignoreDeprecations` (nunca
commiteada, borrada al terminar) desde `frontend/` (necesita estar ahí para
que `node_modules`/`vite/client` resuelvan): **cero errores en
`src/features/catalog/**` ni en `src/api/catalog.ts`**. Quedan tres errores
ajenos (no los toqué): el `asChild` de `AdminLayout.tsx`/`NotificationBell.tsx`
ya mencionado, `React` sin usar en `scroll-area.tsx`, y dos imports de
páginas que `router.tsx` todavía no tiene escritas
(`AuditPage`/`NotificationsPage`/`SettingsPage` — más `PeoplePage` sin
import, que no genera error de módulo pero sí un `no-undef` en tiempo de
build).

Nunca corrí `npm run build` ni la suite completa de ninguno de los dos
lados — sólo mi territorio, como exige la regla de verificación.

## 9. Gaps

- **`tsconfig.app.json` bloquea `npm run typecheck` para todo el repo**
  (TS5101 por `baseUrl` bajo TypeScript 6.0.3) — hace falta que
  `frontend-core` agregue `"ignoreDeprecations": "6.0"` (o baje la versión de
  `typescript`) antes de que la verificación final del Maestro pueda correr
  ese comando con sentido.
- El patrón `asChild` (Radix) no existe en `@base-ui/react`; usar `render={}`.
  Ya lo corregí en mi territorio; quedan `src/app/AdminLayout.tsx:117` y
  `src/features/notifications/NotificationBell.tsx:37` (ajenos).
- `src/app/router.tsx` importa `AuditPage`/`NotificationsPage`/
  `SettingsPage`/`PeoplePage` que todavía no existen o no están importadas
  (`PeoplePage` se usa sin import) — de `frontend-core`, en progreso mientras
  yo trabajaba; no lo toqué.
- Upsert-only en `ModifierGroupUpdateIn.options`/`ComboUpdateIn.groups`: un
  `id` que no viene en la lista **no se borra ni se desactiva** (no hay campo
  de baja lógica en `ModifierOption`/`ComboGroup`/`ComboOption` en esta
  fase). Si el negocio necesita "quitar una opción de un grupo" como acción
  explícita antes de fase 2, es un endpoint o un campo nuevo — no lo inventé
  por no estar en el contrato.
- `default_course`/`default_station` son `String` libre, no validados contra
  `StoreSalesSettings.courses`/`stations` de la sede (que son configurables
  y viven en JSON, no en una tabla): quedó así para no acoplar un módulo con
  otro antes de que exista una necesidad real de esa validación cruzada.
- La pantalla Admin → Carta no tiene una forma de **borrar** una opción de
  modificador o un grupo de combo ya creados (sólo agregarlos/editarlos y
  marcarlos agotados) — coherente con el gap anterior de la API.
- `frontend/src/features/catalog/CombosTab.tsx` crea combos con un solo
  grupo inicial ("Opciones") al momento de creación; agregar grupos
  adicionales a un combo ya existente desde la UI no está implementado (la
  API sí lo permite vía `PATCH .../combos/{id}` con `groups`) — quedó fuera
  por tiempo, es una mejora de UI, no un gap de contrato.
