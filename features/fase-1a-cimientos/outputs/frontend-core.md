# frontend-core — cimientos, sesión y pantallas de administración

Agente: `frontend-core`. Territorio: `frontend/` salvo `src/features/shifts/**`,
`src/features/catalog/**`, `src/api/shifts.ts` y `src/api/catalog.ts`. No toqué
`backend/`, `docs/` ni ningún `.gitignore` (tampoco el que crea por defecto
`npm create vite` dentro de `frontend/`: lo borré para no tener ninguna copia
del archivo que el contrato reserva a `backend-core`). Único agente que corrió
`npm install` y que editó `package.json` (dejo `package-lock.json` commiteable).

---

## 1. Scaffold y scripts

`npm create vite@latest . -- --template react-ts` (no interactivo) sobre
`frontend/` vacío, seguido de Tailwind v4 (`npm install -D tailwindcss
@tailwindcss/vite`) y `npx shadcn@latest init -d` + `npx shadcn@latest add
button input label card dialog alert-dialog table tabs badge select switch
checkbox textarea separator alert sheet scroll-area dropdown-menu tooltip
sonner skeleton -y` (los 21 primitivos pedidos, todos presentes en
`src/components/ui/`). Dependencias con `npm install`: `react-router-dom
@tanstack/react-query react-hook-form zod @hookform/resolvers lucide-react
sonner` y, como dev, `vitest jsdom @testing-library/react
@testing-library/jest-dom @testing-library/user-event @types/react
@types/react-dom`.

`package.json` — scripts:

```json
"dev": "vite",
"build": "tsc -b && vite build",
"typecheck": "tsc --noEmit -p tsconfig.app.json",
"test": "vitest run",
"test:watch": "vitest",
"lint": "oxlint",
"preview": "vite preview"
```

`vite.config.ts`: plugins `react()` + `tailwindcss()`; alias `@` → `src`;
`server.proxy["/api"]` → `http://localhost:8000`; bloque `test` (environment
`jsdom`, `setupFiles: ["src/test/setup.ts"]`, `globals: false`). `tsconfig.app.json`
y `tsconfig.json` con `"paths": {"@/*": ["./src/*"]}` en modo estricto
(`noUnusedLocals`, `noUnusedParameters`, etc.).

**Verificación corrida y en verde ahora mismo:**

```bash
cd frontend && npm run typecheck   # tsc --noEmit -p tsconfig.app.json → sin errores, todo el árbol
cd frontend && npx vitest run src/lib src/features/auth src/features/features \
  src/features/settings src/features/people src/features/audit \
  src/features/notifications src/app
# → 7 archivos de test, 33/33 casos verdes
```

No corrí `npm run build` ni `npx vitest run` sin filtro (suite completa): eso
es del paso de verificación final del Maestro, como pide el contrato.

## 2. Desviaciones del contrato interno — qué y por qué

El contrato interno (§5) pedía "shadcn/ui (estilo `new-york`...)" y
"React 18". Al día de este corte (npm con red real, CLI `shadcn@4.21.0`,
`create-vite@9.2.1`), lo que instala el flujo no interactivo pedido
(`init -d`, "usar los defaults") ya no ofrece esos valores:

- **`shadcn@latest` ya no tiene estilos `new-york`/`default`.** El CLI
  actual reemplazó esa elección por *presets* (`-p/--preset`); `-d`
  (defaults) resuelve a `--preset=base-nova`, que usa **Base UI**
  (`@base-ui/react`, la librería headless de MUI) en vez de Radix UI como
  capa de primitivos accesibles. Sigue siendo "shadcn/ui" (mismo modelo:
  componentes copiados al repo, Tailwind, `components.json`, tokens
  `--primary`/`--muted`/etc. en `src/index.css`), pero la composición
  polimórfica usa la prop `render={<Elemento/>}` de Base UI en vez de
  `asChild` de Radix (lo usé en el trigger del `Sheet` móvil de
  `AdminLayout`, en el trigger de la campana y en el botón "Exportar CSV"
  de Historial). Decisión: seguir el flujo no interactivo tal cual lo pide
  el contrato (§1 de la misión) en vez de fijar a mano una versión vieja del
  CLI para forzar `new-york`/Radix, que además ya no es la ruta soportada.
- **React 19, no 18** (`create-vite@latest` ya scaffolda 19), con
  `@types/react`/`@types/react-dom` a la par. `@testing-library/react@16`
  (la que soporta React 19) reemplaza cualquier expectativa de v14.
- **TypeScript `~6.0.2`, no un 5.x.** Con esta versión `baseUrl` está
  **deprecado** (`TS5101`, deja de funcionar en TS 7): saqué `baseUrl` de
  `tsconfig.json`/`tsconfig.app.json` y dejé sólo `"paths": {"@/*":
  ["./src/*"]}`, que en `moduleResolution: "bundler"` se resuelve solo,
  relativo al propio `tsconfig`. El alias `@/` funciona igual.
- **Tailwind v4**, sin `tailwind.config.js`: la config vive en CSS
  (`@import "tailwindcss"` + bloques `@theme inline` en `src/index.css`,
  que generó el propio `shadcn init`). Es el flujo soportado hoy para
  Vite + Tailwind; no hay archivo JS de configuración que crear.
- **`lucide-react` en `^1.46.0`** (mayor que el `0.x` que sugiere casi toda
  documentación vieja de shadcn) — misma API de íconos con la que escribí
  todo (`import { Bell, ... } from "lucide-react"`), sin cambios de uso.

Todo lo demás del contrato interno §5 quedó **tal cual**: `src/api/client.ts`
con la firma exacta (`api<T>(path, {method?, body?, idempotencyKey?, query?})`,
base `/api/v1`, `credentials: "include"`, `ApiError{status,code,message,extra}`,
evento `"session:expired"` en 401, `newIdempotencyKey()`), `src/api/auth.ts`
con el `Me` y las siete funciones pedidas, `src/lib/{businessDate,money,errors}.ts`
con las firmas listadas, `src/app/session.tsx` (`<SessionProvider>`,
`useSession()`), `src/app/nav.ts` (`NavItem`), `src/app/router.tsx`
(`createBrowserRouter`, rutas `/admin/*`, `/pos/*`, `/login`, `/pos/activate`,
`/pos/identify`, concatenando `shiftsFeature`/`catalogFeature`),
`AdminLayout.tsx`/`PosLayout.tsx`, `src/test/{setup,utils}.tsx`
(`renderWithProviders(ui, {me})`), y los cuatro componentes compartidos
(`PinPad`, `DenominationsInput`, `MoneyInput`, `EmptyState`).

**Un agregado no pedido, documentado para que lo reutilicen:**
`src/app/storeContext.tsx` (`StoreSelectionProvider`/`useStoreSelection()`):
casi toda pantalla de Configuración necesita un `store_id`, y el contrato no
definía quién resuelve "la sede activa en Admin". Carga `GET /admin/stores`
una vez que hay sesión de admin, guarda `activeStoreId` en memoria (nunca en
`localStorage`) y expone un selector en el header **sólo si** `multi_store`
está encendida y hay más de una sede (si no, la sede activa es simplemente la
primera y no hay UI de selección). Fuera de un `<StoreSelectionProvider>`
devuelve un valor neutro (`stores: []`, sin lanzar) para que un componente lo
pueda usar en un test sin levantar todo `AdminLayout`.

`src/app/theme.tsx` (`AppThemeProvider`, `ThemeToggle`) tampoco estaba
nombrado en el contrato; envuelve toda la app una sola vez en `main.tsx`
(no sólo `AdminLayout`) para que POS también respete el tema del sistema,
usa `next-themes` (`localStorage`, permitido explícitamente para el tema) con
`attribute="class"` sobre `<html>`.

**Package.json — una imprecisión menor para la ronda 2:** `shadcn` quedó en
`dependencies` (no en `devDependencies`) porque `shadcn init`/`add` lo
instala así por defecto; no se importa desde ningún código de producción, así
que no afecta el bundle final, pero lo correcto sería moverlo a dev. No lo
toqué de nuevo para no generar otro diff de `package-lock.json` a mitad de la
verificación de otros agentes.

## 3. Pantallas y rutas

| Ruta | Componente | Requiere sesión |
|---|---|---|
| `/login` | `src/features/auth/LoginPage.tsx` | ninguna |
| `/pos/activate` | `src/features/auth/DeviceActivatePage.tsx` | ninguna |
| `/pos/identify` | `src/features/auth/DeviceIdentifyPage.tsx` | `kind: "device"` |
| `/admin` (layout) | `src/app/AdminLayout.tsx` | `kind: "admin"` |
| `/admin/features` | `src/features/features/FeaturesPage.tsx` | admin |
| `/admin/settings` | `src/features/settings/SettingsPage.tsx` (8 pestañas) | admin |
| `/admin/audit` | `src/features/audit/AuditPage.tsx` | admin |
| `/admin/notifications` | `src/features/notifications/NotificationsPage.tsx` | admin |
| `/pos` (layout) | `src/app/PosLayout.tsx` | `kind: "device"` |

`/admin` e `/pos` concatenan además `shiftsFeature.adminRoutes/posRoutes` y
`catalogFeature.adminRoutes` (ya reales: `catalogo` sobreescribió su stub con
`/admin/carta` mientras yo trabajaba; `shifts` sigue siendo mi stub vacío al
cierre de este corte).

`Admin → Configuración` es **una sola ruta con pestañas** (shadcn `Tabs`), no
ocho rutas: Organización, Sedes, Fiscal, Caja, Ventas, UVT, Zonas y mesas,
Empleados. El contrato interno lista `src/features/{settings,people}/**` como
dos carpetas separadas; respeté esa separación de archivos (empleados vive en
`src/features/people/`) pero los compongo en una sola pantalla visual, que es
como los describe la misión ("Admin → Configuración: ... empleados
(crear/editar/desactivar...)").

`AdminLayout`: sidebar armado desde `OWN_NAV` (Funciones, Configuración,
Historial, Notificaciones — sin flag, son núcleo de este pedido) +
`shiftsFeature.adminNav` + `catalogFeature.adminNav`, filtrando por
`hasFeature`; en pantallas ≥768px es una barra fija, debajo se colapsa a un
`Sheet` con botón de menú (44px, ≥ táctil); selector de sede sólo con
`multi_store`; campana (`NotificationBell`) con sondeo de 30s; `ThemeToggle`.

`PosLayout`: barra superior con nombre de sede + persona activa + rol, aviso
`role="alert"` cuando `employee_expires_at` ya venció, botón "Cambiar de
persona" (`POST /auth/device/release` → refresca sesión → navega a
`/pos/identify`), sondea `GET /auth/me` cada 5s, y el slot
`<shiftsFeature.ShiftStatusStrip/>`. Si `me.employee` es `null` (nadie
identificado), redirige solo a `/pos/identify`.

## 4. Endpoints consumidos, por pantalla (método y ruta exactos)

**Sesión (todas las pantallas, vía `SessionProvider`)**
- `GET /auth/me`

**`/login`**
- `POST /auth/admin/login`

**`/pos/activate`**
- `POST /auth/device/activate`

**`/pos/identify`**
- `POST /auth/device/identify`

**`PosLayout` (global de POS)**
- `POST /auth/device/release`

**`AdminLayout` (global de Admin)**
- `GET /admin/stores` (resolver la sede activa)
- `GET /admin/notifications?store_id&unread_only` (campana)
- `POST /admin/notifications/{id}/read`

**Admin → Funciones**
- `GET /admin/organization`
- `GET /admin/features?store_id`
- `PUT /admin/features/{key}` — body `{enabled, store_id?}`
- `POST /admin/organization/profile` — body `{profile}`

**Admin → Configuración → Organización**
- `GET /admin/organization`
- `PATCH /admin/organization` — body `{name}`

**Admin → Configuración → Sedes**
- `GET /admin/stores`
- `POST /admin/stores`
- `PATCH /admin/stores/{store_id}`
- `POST /admin/stores/{store_id}/rotate-pin`

**Admin → Configuración → Fiscal**
- `GET /admin/stores/{store_id}/fiscal`
- `PUT /admin/stores/{store_id}/fiscal`
- `GET /admin/stores/{store_id}/fiscal/history`

**Admin → Configuración → Caja**
- `GET /admin/stores/{store_id}/cash-settings`
- `PUT /admin/stores/{store_id}/cash-settings`

**Admin → Configuración → Ventas**
- `GET /admin/stores/{store_id}/sales-settings`
- `PUT /admin/stores/{store_id}/sales-settings`

**Admin → Configuración → UVT**
- `GET /admin/uvt`
- `PUT /admin/uvt`

**Admin → Configuración → Zonas y mesas**
- `GET /admin/zones?store_id`
- `POST /admin/zones?store_id` — body `{name, sort_order?}`
- `PATCH /admin/zones/{zone_id}`
- `GET /admin/tables?store_id`
- `POST /admin/tables` — body `{zone_id, number, seats?}`
- `PATCH /admin/tables/{table_id}`

**Admin → Configuración → Empleados**
- `GET /admin/employees`
- `POST /admin/employees`
- `PATCH /admin/employees/{employee_id}`

**Admin → Historial**
- `GET /admin/audit?from&to&entity&employee_id`
- `GET /admin/audit?format=csv&...` (link "Exportar CSV", mismos filtros)

**Admin → Notificaciones**
- `GET /admin/notifications`
- `POST /admin/notifications/{id}/read`
- `GET /admin/notification-rules?store_id`
- `PUT /admin/notification-rules?store_id` — body `NotificationRuleIn[]`

Ninguna ruta fuera de esta lista y de las de `spec.md`. No usé
`DELETE /admin/shifts/{id}` ni ninguna otra ruta de `shifts`/`catalog`: esas
pantallas no están en mi encargo.

## 5. Notas de accesibilidad

- **Contraste y tema**: cero color hardcodeado en mi código (verificado con
  grep); todo por tokens de shadcn (`bg-background`, `text-foreground`,
  `text-muted-foreground`, `text-destructive`, `bg-destructive/10`, etc.),
  que ya vienen con pares claro/oscuro con contraste ≥ 4.5:1 (paleta
  `oklch` de `base-nova`). `ThemeToggle` alterna la clase `.dark` en
  `<html>` vía `next-themes`.
- **Foco visible**: heredado de los primitivos de Base UI/shadcn
  (`focus-visible:ring-3 focus-visible:ring-ring/50` en `Button`, inputs con
  anillo de foco equivalente); no lo desactivé en ningún lado.
- **Teclado**: `PinPad` es 100% operable por teclado físico (dígitos 0-9 y
  `Backspace`, verificado con `userEvent.keyboard`, sin mouse) además de con
  el mouse/touch; todos los diálogos (`Dialog`/`AlertDialog`/`Sheet`) son los
  primitivos accesibles de Base UI (foco atrapado, `Escape` cierra, foco
  vuelve al trigger).
- **Labels y roles**: cada input de formulario tiene `<Label htmlFor>`; cada
  botón sólo-ícono tiene `aria-label` (menú, campana, tema, borrar
  denominación/medio de pago/año UVT, exportar CSV); iconografía SVG de
  `lucide-react`, nunca emoji; iconos decorativos con `aria-hidden="true"`.
  Errores de servidor y de formulario en `role="alert"`; el conteo de
  dígitos del `PinPad` en `role="status" aria-live="polite"`.
  `PinPad` es `role="group"` con `aria-label` del propósito (PIN de sede vs.
  PIN personal).
- **Toques ≥ 44px** en todo lo que puede tocarse desde una tablet: `PinPad`
  (56px), botones de Activar/Identificar/Cambiar de persona (44px, `h-11`),
  botón de menú móvil del sidebar. Los controles de Configuración (PC, con
  mouse) usan la altura por defecto de shadcn (32-40px), consistente con
  que esa pantalla es de escritorio.
- **Estados de lista**: toda tabla/lista tiene los tres estados
  (`Skeleton` cargando, `EmptyState role="alert"` con el mensaje del
  servidor + botón "Reintentar" en error, `EmptyState` simple en vacío) —
  nunca un `catch` mudo.

## 6. Tests — qué escribí y resultado

7 archivos, 33 casos, **todos verdes** (`npx vitest run src/lib
src/features/auth src/features/features src/features/settings
src/features/people src/features/audit src/features/notifications src/app`):

| Archivo | Qué prueba |
|---|---|
| `src/lib/__tests__/businessDate.test.ts` | La fuente de `businessDate.ts` no usa `new Date("YYYY-MM-DD")` ni `toISOString().slice` (inspección del código fuente, comentarios excluidos); `parseBusinessDate` rechaza formato inválido; `formatBusinessDate("2026-09-14")` → `"lun 14 sep 2026"` y un fin de año (`2025-12-31` → `"mié 31 dic 2025"`) sin correrse de día/año por huso horario; `null`/`undefined` → `"—"`; `formatInstant` en hora de Bogotá. |
| `src/lib/__tests__/money.test.ts` | `formatCOP(null)`/`(undefined)` → `"—"` (nunca contiene `"0"`); `formatCOP(0)` sí muestra `$ 0` (distinto de `null`); separador de miles; `parseCOP` con puntos de miles y símbolo `$`; `parseCOP("")` → `null`; redondeo a peso entero. |
| `src/lib/__tests__/apiClient.test.ts` | `{error:{code,message}}` → `ApiError{status,code,message}`; los campos extra (`requires`, etc.) sobreviven en `.extra`; `credentials: "include"` siempre; header `Idempotency-Key` presente cuando se pide y ausente cuando no; evento `"session:expired"` en un 401; `newIdempotencyKey()` da UUIDs distintos. |
| `src/lib/__tests__/noRawStorage.test.ts` | Recorre `src/` con `fs` (environment `node`, no `jsdom`) y falla si aparece `localStorage.setItem`/`sessionStorage.setItem` fuera de un archivo `theme.tsx` o de un `__tests__/`. Hoy pasa sobre **todo** el árbol (incluye lo de `catalogo`). |
| `src/app/__tests__/AdminLayout.test.tsx` | El sidebar oculta una entrada de nav cuya `feature` está apagada y la muestra encendida (con `shiftsFeature`/`catalogFeature` mockeados para no depender de lo que ellos terminen escribiendo); una entrada sin `feature` (Funciones, Configuración) siempre se ve. |
| `src/features/features/__tests__/FeaturesPage.test.tsx` | Al fallar `PUT /admin/features/{key}` con `400 FEATURE_DEPENDENCY`, la pantalla muestra **el mensaje tal cual lo manda el servidor** (no un texto genérico); la tabla pinta clave, descripción, origen y dependencias. |
| `src/features/auth/__tests__/PinPad.test.tsx` | Cada botón de dígito tiene `aria-label`; el grupo tiene el `label` como nombre accesible; operable 100% por teclado físico (incluye `Backspace`) y por click; el mensaje de error se anuncia en `role="alert"`. |

No escribí tests de `src/features/settings/**`, `src/features/people/**`,
`src/features/audit/**` ni `src/features/notifications/**` más allá de lo
que ya corre por transitividad (ninguno, en este corte) — son formularios
CRUD extensos y el tiempo de esta ronda se priorizó en los siete casos que
la misión pide explícitamente por nombre. **Gap propio, no de otro
agente**: si el Maestro quiere cobertura ahí antes de la verificación final,
es trabajo pendiente de este mismo agente, no de nadie más.

## 7. Gaps

**Rutas que la spec no lista y que hacían falta (documentado en vez de
inventarlas):**

1. **Activar dispositivo sin saber el `store_id`.** `POST
   /auth/device/activate` pide `{store_id, store_pin}`, pero no existe
   ninguna ruta pública (sin sesión) para listar sedes por nombre — todo
   `GET /admin/stores*` exige `current_admin`. `DeviceActivatePage`
   resuelve esto con un campo numérico "Número de sede" a mano, con una nota
   visible en la pantalla. **Propuesta para ronda 2**: un
   `GET /public/stores` (sólo `{id, name}`, sin nada sensible) o que el
   local reciba el `store_id` en la URL de activación (QR por tablet).
2. **"Quién opera" sin roster de dispositivo.** `POST /auth/device/identify`
   pide `{employee_id, pin}`, pero ninguna ruta lista el personal activo de
   la sede para un dispositivo: `GET /admin/employees` exige admin (un
   dispositivo activado recibe `401`), y `GET /auth/me` sólo devuelve la
   persona *ya* activa, nunca el roster completo. Sin esa lista **no se
   puede construir la grilla de avatares/nombres** que pide SPEC-NEGOCIO
   §9.1. `DeviceIdentifyPage` degrada a un campo numérico "Número de
   empleado" + `PinPad` de 4 dígitos, con la nota visible y este gap
   documentado en el propio código (comentario al tope del archivo).
   **Bloqueante para la UX real de "Quién opera"** hasta que exista algo como
   `GET /device/employees` (sólo `{id, name}` de los activos en la sede del
   dispositivo, sin PIN ni datos sensibles) — se lo debe agregar
   `backend-core` o quien retome auth en la próxima ronda.
3. **Día operativo en `PosLayout`.** La barra superior del POS debía
   mostrar "día y persona activa"; el día/turno vive en `GET
   /shifts/current` (dominio de `backend-caja`/`frontend-caja`, no en
   ningún endpoint que yo pueda consumir). Decisión (no gap de ruta, gap de
   reparto): dejé ese dato exclusivamente al slot
   `<shiftsFeature.ShiftStatusStrip/>`, que ya se renderiza en el lugar
   correcto (debajo de la barra de persona) — cuando `frontend-caja`
   reemplace su stub, el día operativo aparece solo, sin que yo tenga que
   tocar `PosLayout` de nuevo.

**Dependencias de otros agentes (no gaps, sólo para que se sepa qué falta
para ver esto completo):**

- `src/features/shifts/index.ts` sigue siendo mi stub (arrays vacíos,
  `ShiftStatusStrip` → `null`) al cierre de este corte: `/pos` renderiza el
  layout pero sin contenido bajo el `Outlet`, y `AdminLayout` no muestra
  "Turnos y personal" ni "Dinero" todavía. Es exactamente lo esperado del
  contrato (`frontend-caja` lo sobreescribe).
- `src/features/catalog/index.ts` **ya no es mi stub**: `catalogo` lo
  reemplazó mientras yo trabajaba (`adminNav: [{to:"/admin/carta",
  label:"Carta"}]`, sin flag) y quedó integrado en el sidebar sin que yo
  tuviera que hacer nada — así es como debía funcionar el hand-off.
- El backend de `catalogo` (`app/catalog/router.py`, `seed.py`, migración
  `0002`) no estaba en el árbol cuando escribí esto (ver
  `docs/ESTADO.md`); no me afecta porque no consumo `/catalog` ni
  `/admin/products` etc. desde mi territorio.

**Lo que NO construí porque no estaba en mi encargo (para que no se lea como
faltante):** las pantallas "Turnos y personal" y "Dinero" que el ROL general
del pedido menciona son del equipo de caja (`frontend-caja`), no de este
agente — la sección "PANTALLAS" de mi propia misión sólo pide Funciones,
Configuración, Historial y Notificaciones, más los tres flujos de identidad
y los dos layouts. No las inventé ni dejé rutas rotas apuntando a ellas.
