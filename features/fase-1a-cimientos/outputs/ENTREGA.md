# Entrega final — Pedido 1a: cimientos y caja

Maestro Orchestrator (Fable). 2026-09-14. Commit base del pedido: `dbfc4c0`.
Snapshots del orquestador: `9f3c4fd`, `2eecf38`, `1e0e164`. **La ronda 2 (correcciones
B-1 a B-4 y B-2b) NO está commiteada**: 18 archivos modificados y 4 nuevos en el
árbol de trabajo (ver §5.3). Todo lo que sigue se verificó contra ese árbol.

## 0. Resumen en seis líneas

- Se entregó lo que pedía el alcance: backend FastAPI con siete dominios, 31 tablas
  por Alembic (`0001 → 0002 → 0003`), seed aparte e idempotente, frontend Vite +
  React con POS de turno y panel de administración, CI en serie, 213 tests de
  backend y 17 archivos de test de frontend.
- Dos rondas: la primera dejó 6 conflictos (4 bugs reales, 1 de interpretación, 1 de
  orden de integración); la segunda los cerró con tests que los prueban.
- Verificación del Maestro: mypy y tsc limpios; cadena Alembic desde cero y
  `downgrade base` correctos; seed idempotente; reglas duras confirmadas por grep.
  Suites completas, una sola vez y en serie: backend **212/213** (1 fallo, D-2), frontend **61/61**, build **OK**.
- **Dos defectos nuevos hallados en esta verificación final**, ninguno de plata:
  (D-1) identificarse en la tablet **no agrega al roster** del turno abierto —el
  hook cruzado se busca en el módulo equivocado—; (D-2) la suite completa del backend queda en **rojo** por un test de carrera de `tests/shifts` que corre sobre la fixture `db` compartida (no segura entre hilos); el invariante real ya lo prueba el auditor con sesión por request. Con ese test así, el CI no puede ponerse en verde.
- Nueve advertencias del auditor y una observación de control siguen abiertas, por
  decisión: son del dueño de la spec, no defectos contra una regla declarada.
- Recomendación: commitear la ronda 2 ya; corregir D-1 y D-2 (dos cambios de una
  línea más un test cada uno) antes de lanzar 1b.

## 1. El equipo que armé y por qué

| id | Rol | Modelo | Tipo | Base del catálogo | Territorio |
|---|---|---|---|---|---|
| `backend-core` | Cimientos, identidad, organización y sede | sonnet | builder | `agente-backend.md` | `backend/` menos `catalog`/`shifts`/`tests/audit`; CI; `launch.json`; `ESTADO.md` |
| `backend-caja` | Día operativo y turno de caja | sonnet | builder | `agente-backend.md` | `backend/app/shifts/**`, `tests/shifts/**`, `0003_shifts.py` |
| `catalogo` | Carta plana, API y pantalla Admin → Carta (full-stack) | sonnet | builder | rol nuevo | `backend/app/catalog/**`, `tests/catalog/**`, `0002_catalog.py`, `frontend/src/features/catalog/**`, `api/catalog.ts` |
| `frontend-core` | Carcasa, sesión y pantallas de administración | sonnet | builder | `agente-frontend.md` | `frontend/` menos `features/shifts`, `features/catalog`, `api/shifts.ts`, `api/catalog.ts` |
| `frontend-caja` | POS de turno y Admin Dinero / Turnos y personal | sonnet | builder | `agente-frontend.md` | `frontend/src/features/shifts/**`, `api/shifts.ts` |
| `auditor-control` | Control interno, plata y seguridad como invariantes ejecutables | **opus** | auditor | `agente-contador.md` + `agente-legal.md` | `backend/tests/audit/**`, `frontend/src/audit/**` (no arregla: reporta) |

**Por qué así.** La complejidad del pedido no estaba repartida por igual:

1. Los **cimientos** (sesión en cookie `httpOnly` para admin y dispositivo, PIN con
   bloqueo, catálogo de funciones con perfiles y `require_feature`, aislamiento por
   organización, idempotencia, errores de una sola forma, auditoría, notificaciones,
   configuración de sede con fiscal versionada, zonas, mesas, empleados, seed, CI)
   son la base de la que dependen los otros cinco. Un solo dueño, y arranca primero.
2. El **turno de caja** concentra las reglas de plata y la concurrencia (una sola
   fórmula, reserva y cambio fuera del esperado, retiro con snapshot, cierre a ciegas
   en tres pasos con tolerancias, rescates). Es el dominio que más vale aislar en un
   dueño único.
3. La **carta plana** es cohesiva y autocontenida: conviene que un solo agente la
   construya de API a pantalla, en vez de partirla entre dos que se esperan.
4. El **frontend** tiene dos mitades de naturaleza distinta: la carcasa y las
   pantallas de administración (formularios de configuración) y el POS de caja, que
   consume el contrato del turno y tiene reglas de UX propias (44 px, PIN, foto).
5. El **riesgo mayor** del pedido es la matemática de caja y la seguridad. Eso pide
   un auditor con razonamiento pesado (único opus del equipo) que escriba las
   invariantes como **tests ejecutables en territorio propio**, no un revisor que
   opine. Absorbió los controles de Legal de esta fase (PII, PIN, cookies, costos
   hacia el operador).

Descarté Analytics y Datos (no hay dashboards de ventas en 1a: Hoy/Ventas/Pedidos son
1b) y no lancé Legal aparte. Sonnet para todo lo que construye código; opus sólo
donde el costo de un error es más alto.

**La herramienta que hizo posible seis agentes en paralelo sobre un repo vacío** es
`features/fase-1a-cimientos/CONTRATO-INTERNO.md` (256 líneas): territorios disjuntos
con dueño único para cada archivo compartido; firmas de los módulos comunes
(`AppError`, `run_idempotent`, `require_feature`, `Actor`, `record_audit`, `notify`,
fixtures de `conftest.py`) escritas antes de que existieran; cadena de Alembic con
ids fijos (`0001`/`0002`/`0003`) para que tres agentes migren sin coordinarse; stubs
de `features/shifts/index.ts` y `features/catalog/index.ts` que `frontend-core` crea
y los otros sobreescriben; hooks cruzados protegidos con `find_spec` porque el módulo
del otro puede no existir todavía; y reglas de instalación (sólo `backend-core` hace
`pip install`, sólo `frontend-core` hace `npm install`).

**Qué demostró esta corrida sobre el diseño del equipo** (esto es parte del valor del
framework, no relleno):

- El contrato aguantó: ningún agente reportó ni se detectó una escritura fuera de
  territorio; el hand-off por stub funcionó solo (`catalogo` reemplazó su `index.ts`
  y apareció en el sidebar sin que `frontend-core` tocara nada); la cadena de Alembic
  con ids fijos resolvió apenas existió `0002`.
- El auditor con invariantes ejecutables pagó: de los seis conflictos de la ronda 1,
  tres eran bugs que ningún builder vio en su propio territorio (`500` en todos los
  relevos, esperado filtrándose por `pickups[]` y `handovers[]`, `expected_cash`
  nulo para el responsable). Un revisor que sólo lee no los habría encontrado; un
  test sí.
- Lo que el contrato **no** cubrió y por eso quedó roto: las **costuras entre dos
  territorios** (identify → roster; fixture `db` compartida vs. tests con hilos).
  Cada hook cruzado tenía dueño en cada extremo pero **nadie era dueño del test de
  punta a punta**. Es la corrección más concreta al contrato para 1b: cada hook
  cruzado lleva nombre de quién escribe su test E2E.

## 2. Qué construyó o halló cada agente

Cifras reales contra `dbfc4c0` (`git diff --numstat` + archivos nuevos).

### 2.1 `backend-core` — 71 archivos, 6.542 líneas — output: `outputs/backend-core.md`

- `app/core/`: `config`, `db` (con **`UTCDateTime`**, un `TypeDecorator` que evita
  que SQLite devuelva datetimes *naive*), `clock`, `tz`, `money`, `errors` +
  handlers, `security` (bcrypt, PyJWT, cookies `httpOnly`/`SameSite`/`secure`),
  `idempotency` (reserva en la transacción, replay, `IDEMPOTENCY_MISMATCH`/
  `IN_PROGRESS`), `csv`, `features` (**41 claves** de SPEC-NEGOCIO §1.2 con defaults
  por perfil, `require_feature`), `models_registry`, `models` (`IdempotencyKey`).
- `app/auth/`: `Employee`, `DeviceSession`, `Authorization`; `deps.py` (`Actor`,
  `current_admin`, `current_device`, `current_operator`, `current_actor`,
  `admin_store`); `service.py` (`verify_pin` con bloqueo 5/15 min y notificación,
  `verify_authorizer` con matriz supervisor/admin); router: 12 endpoints.
- `app/stores/`: `Organization`, `Store`, `StoreFiscalConfig` (versionada por
  `valid_from`), `StoreCashSettings`, `StoreSalesSettings`, `UvtValue`, `Zone`,
  `Table`, `FeatureState`; router: 26 endpoints.
- `app/audit/` (`record_audit` en `SAVEPOINT` propio), `app/notifications/`
  (`notify` con reglas y dedupe diario), `app/main.py` (descubre routers por
  `find_spec`, sirve `frontend/dist` con fallback SPA), `app/seed.py`, Alembic
  (`env.py`, `0001_core.py`, 16 tablas), `tests/conftest.py` con todas las fixtures
  del contrato, 78 tests en `tests/{core,auth,stores,audit_log,notifications}`.
- `.github/workflows/ci.yml` (Postgres 16 como servicio, dos jobs en serie),
  `.claude/launch.json`, `AGENTS.md § Verificación mínima`, `docs/ESTADO.md`.
- Decisiones declaradas, no silenciosas: `get_db` **commitea** ante `AppError`
  (si no, el contador de PIN nunca se guarda; consecuencia: todo servicio valida
  antes de escribir); `run_idempotent` guarda un error de negocio como respuesta
  resuelta; `UvtValue` por organización; `multi_store` no gatea `GET /admin/stores`.
- Ronda 2 (B-2b): `_bound_employee()` en `deps.py`; `current_device` expone la
  persona identificada **sin** renovar su ventana; 4 tests nuevos en
  `tests/auth/test_identity.py`.

### 2.2 `backend-caja` — 15 archivos, 4.267 líneas — output: `outputs/backend-caja.md`

- `app/shifts/models.py`: `BusinessDay`, `Shift` (36 columnas), `ShiftRoster`,
  `CashMovement`, `CashSwap`, `CashPickup`, `ShiftHandover`, `ShiftCloseCount`;
  índice único parcial `uq_shifts_one_open_per_store` (`postgresql_where` +
  `sqlite_where`), `CHECK`s, nada se borra. `0003_shifts.py` a mano.
- `service.py`: **una sola fórmula** `compute_breakdown` (`base + cash_sales +
  incomes − expenses − pickups`; la reserva y el swap no aparecen); `to_deposit =
  counted − opening_cash_fixed − tips_cash_out`; `is_shift_stale`;
  `_check_difference_streak`; `employee_activity`. `hooks.py`: `get_sales_totals`
  (ceros en 1a, comentario para 1b) y `on_employee_identified`.
- `router.py`: 21 endpoints (apertura, roster, movimientos, cambio, retiros y
  reversa, relevo/arqueo, cierre en 3 pasos, cierre en un paso, rescates de admin,
  días operativos, actividad por persona). Un solo predicado de visibilidad
  `_can_see_expected()` (`router.py:122`) para `GET /shifts/{id}` y `/shifts/current`.
- Ronda 2: `BLIND_CLOSE_REQUIRED` antes de `_idempotent` (B-1), `kind=HandoverKind(...)`
  + `_kind_str()` (B-2), `expected_at_pickup`/`breakdown` en `null` para quien no es
  admin ni responsable (B-3/B-4); `tests/shifts/test_expected_visibility.py` nuevo.
  34 tests en `tests/shifts/`.
- Decisión explícita que dejó al auditor: la respuesta directa de `POST /pickups` y
  `POST /handovers` sigue trayendo el snapshot completo a quien ejecuta (ya autorizó
  con PIN admin o es el responsable).

### 2.3 `catalogo` — 28 archivos, 5.025 líneas — output: `outputs/catalogo.md`

- Backend: `Category`, `Product` (precio por canal, `tax_code` con default de la
  fiscal vigente, contador de porciones, **sin campo de costo**), `ModifierGroup`,
  `ModifierOption` (`recipe_effect` siempre `NULL`), `Combo` (`schedule` con
  franjas que cruzan medianoche), `ComboGroup`, `ComboOption` (`active_today` y
  `available_today` independientes). `0002_catalog.py` a mano. 17 endpoints con
  gates `pos.modifiers`/`pos.combos`/`pos.daily_menu`/`pos.daily_count`; aislamiento
  con `_scoped_or_404`; auditoría en toda escritura; `reset_daily_availability` para
  el hook del día. Seed: 20 productos en 5 categorías, 3 grupos de modificadores,
  "Combo Ejecutivo" y "Corrientazo del día" con curaduría real. 43 tests
  (incluye recorrido del OpenAPI buscando `cost`/`margin`/`unit_cost`).
- Frontend: `features/catalog/{CatalogAdminPage,CategoriesTab,ProductsTab,
  ProductForm,ModifiersTab,CombosTab,DailyMenuTab}.tsx`, `api/catalog.ts`; ruta
  `/admin/carta`; 4 tests. Encontró y corrigió en su territorio el patrón `asChild`
  (Radix) que no existe en `@base-ui/react`, y lo reportó en los dos archivos ajenos
  (hoy ya no queda ningún `asChild` en `src/`).
- Gaps declarados: anidados upsert-only (no se borra una opción de un grupo);
  `default_course`/`default_station` como texto libre; la UI no agrega grupos a un
  combo existente.

### 2.4 `frontend-core` — 84 archivos, 14.733 líneas (7.281 son `package-lock.json`) — output: `outputs/frontend-core.md`

- Scaffold Vite + React 19 + TypeScript 6 + Tailwind v4 + shadcn (preset
  `base-nova` sobre `@base-ui/react`, no Radix — desviación del contrato declarada
  con causa: el CLI actual ya no ofrece `new-york`), 21 primitivos en
  `components/ui/`, vitest + jsdom + Testing Library. Scripts `typecheck`, `test`,
  `build` (`tsc -b && vite build`); proxy `/api` → `:8000`.
- `api/client.ts` (firma exacta del contrato, `credentials: "include"`, `ApiError`,
  evento `session:expired`), `api/{auth,features,stores,employees,audit,
  notifications}.ts`, `lib/{businessDate,money,errors}.ts`, `app/{session,nav,
  router,AdminLayout,PosLayout,storeContext,theme}.tsx`, `components/{PinPad,
  DenominationsInput,MoneyInput,EmptyState}.tsx`, `test/{setup,utils}.tsx`.
- Pantallas: `/login`, `/pos/activate`, `/pos/identify`, `/admin/features`,
  `/admin/settings` (8 pestañas: organización, sedes, fiscal, caja, ventas, UVT,
  zonas y mesas, empleados), `/admin/audit`, `/admin/notifications` + campana.
  33 tests en 7 archivos (incluye el guardián `noRawStorage.test.ts` que recorre
  `src/` buscando `setItem`).
- Gaps declarados: no existe ruta pública para listar sedes ni ruta de dispositivo
  para listar empleados → `DeviceActivatePage` y `DeviceIdentifyPage` piden un
  **número a mano**; sin tests de `settings`/`people`/`audit`/`notifications`;
  `shadcn` quedó en `dependencies`.

### 2.5 `frontend-caja` — 28 archivos, 4.084 líneas — output: `outputs/frontend-caja.md`

- POS `/pos/turno`: `ShiftPage` (pestañas por flag), `OpenShiftForm`,
  `ShiftSummaryPanel` + `RosterPanel`, `MovementsPanel` (revela PIN admin ante
  `PETTY_CASH_LIMIT` y reintenta con clave nueva), `CashSwapPanel`, `PickupsPanel`,
  `HandoverPanel`, `CloseWizard` (nunca pide `review` sin `count_id`; ante
  `DIFFERENCE_CHANGED` vuelve al paso 2 con la review del error),
  `SingleStepCloseForm`, `PhotoCaptureField`, `ShiftStatusStrip` (sondeo 5 s).
- Admin: `/admin/dinero` (`OperationalTab`, `HistoryTab`, `ShiftDetailDialog` con
  cronología y los cuatro rescates) y `/admin/personal` (`PersonActivityTab`,
  `AuthorizationsTab`). `api/shifts.ts` con todo campo nuevo opcional.
- Ronda 2: tipos `| null` para `breakdown`/`expected_at_pickup`; columna "Esperado
  al retirar" con `formatCOP` (`null` → "—"); `BLIND_CLOSE_REQUIRED` sin reintento
  y con `refresh()` de sesión; test nuevo. 16 tests en 6 archivos.
- Gaps declarados: `DELETE /admin/shifts/{id}` sin motivo en el body;
  `AdminShiftListItem` sin `close_cause` ni base de apertura; sin ruta de
  dispositivo para personal (afecta `RosterPanel`, `OpenShiftForm`,
  `HandoverPanel`); sin token `--warning` en el design system.

### 2.6 `auditor-control` — 6 archivos, 2.151 líneas — output: `outputs/auditor-control.md`

- `backend/tests/audit/`: **58 invariantes ejecutables** — 32 de plata
  (`test_cash_invariants.py`), 23 de identidad/aislamiento/privacidad
  (`test_security_invariants.py`), 3 de migraciones contra los modelos
  (`test_migration_invariants.py`: `upgrade head` en SQLite nuevo, tablas y
  columnas exactas, `downgrade base` limpio). Fixture propia `race_app` (una sesión
  por request) para probar la carrera real de dos aperturas.
- `frontend/src/audit/security.test.ts`: 8 invariantes por inspección de fuente
  (sin `setItem` salvo tema, sin `new Date("YYYY-MM-DD")`, sin
  `toISOString().slice`, ninguna pantalla de turno deriva esperado/diferencia).
- Halló los 4 bloqueantes de la ronda 1 (B-1 a B-4) y con `backend-core` el B-2b;
  todos cerrados y verificados por test en la ronda 2.
- Dejó 9 advertencias (A-1 a A-9) y 1 observación de control (O-1) abiertas — ver
  §5.4 — y un inventario de datos sensibles y quién los ve, con veredicto por dato.

## 3. Iteraciones y coherencia

**Ronda 1** (6 agentes): 6 conflictos, todos bloqueantes.

| id | Qué | Raíz | Cierre |
|---|---|---|---|
| B-1 | `POST /shifts/{id}/close` sin gate de `cash.blind_close` | interpretación: "convivencia" en vez de "excluyente por flag" | `BLIND_CLOSE_REQUIRED` antes de la idempotencia; test endurecido |
| B-2 | `handover.kind.value` sobre `str` → `500` en todo relevo | bug | `HandoverKind(payload.kind)` + `_kind_str()` |
| B-2b | `current_device` siempre sin `employee_id` → el responsable nunca veía `expected_cash` | bug de `backend-core` visible sólo desde `shifts` | `_bound_employee()`; 4 tests |
| B-3 | `pickups[].expected_at_pickup` fuera del gate | bug | `null` para no autorizados |
| B-4 | `handovers[].breakdown` fuera del gate | bug | `null` para no autorizados |
| ALEMBIC-CHAIN | `0003` referenciaba un `0002` que no existía aún | orden de integración | `0002_catalog.py` entregado; cadena verificada |

**Ronda 2** (`backend-core`, `backend-caja`, `frontend-caja`, `auditor-control`):
cero conflictos. **Veredicto del Conciliador: coherente.**

Coherencia comprobada por mí contra el código, no contra los reportes:

- El contrato de API de `spec.md` se respeta en nombres y formas; los campos
  agregados (`pin` en roster, `photo` en pickups, `closes_day_suggested` en review,
  `BLIND_CLOSE_REQUIRED`) son agregados, no renombres, y están declarados.
- Los tres hooks cruzados existen en ambos extremos: `identify` →
  `on_employee_identified` (`auth/router.py:206`), `open_shift` →
  `reset_daily_availability` (`shifts/service.py:340`, `catalog/service.py:765`),
  `compute_breakdown` → `hooks.get_sales_totals`. **Pero el primero está roto en
  runtime** (D-1, §5.1).
- El frontend integra las dos features por el mecanismo del contrato
  (`router.tsx:69-80`, `AdminLayout.tsx:38`, `PosLayout.tsx:98`); ninguno de los dos
  `index.ts` es ya un stub.
- Los 12 flags del pedido: 11 tienen gate en el backend (`cash.*` en `shifts`,
  `pos.*` en `catalog`, `roles.supervisor` en `verify_authorizer`); `multi_store`
  no tiene gate por decisión declarada de `backend-core` (es un selector de
  interfaz; el frontend sí lo lee). El frontend lee 9 flags; `cash.photo_required`
  y `roles.supervisor` se reflejan sólo como respuesta del servidor, por diseño.

## 4. Verificación del Maestro

Corrida sobre el árbol quieto, sin procesos huérfanos (`ps` limpio antes de empezar),
suite completa una sola vez y en serie: backend → frontend → build.

| Qué | Comando | Resultado |
|---|---|---|
| Typecheck backend | `cd backend && python -m mypy app` | **Success: no issues found in 49 source files** |
| Typecheck frontend | `cd frontend && npm run typecheck` | **limpio** (TS 6.0, sin `baseUrl`) |
| Esquema desde cero | `DATABASE_URL=sqlite:///<nuevo> python -m alembic upgrade head` | **`0001 → 0002 → 0003`**, 31 tablas + `alembic_version` |
| Reversibilidad | `alembic downgrade base` y `upgrade head` de nuevo | deja sólo `alembic_version`; re-migra sin error |
| Seed aparte | `python -m app.seed` ×2 | 1 org, 1 sede, 6 empleados, 2 zonas, 8 mesas, 5 categorías, 20 productos, 3 grupos, 2 combos, 1 UVT; la 2.ª corrida: "ya aplicado, no se repite nada" |
| Suite backend | `cd backend && python -m pytest -q` (213 tests) | **212 passed, 1 failed** en 8:06. El fallo es `tests/shifts/test_open.py::test_two_concurrent_opens_one_wins_one_gets_409` (D-2). 331 warnings: deprecaciones de `starlette.testclient`/`anyio` y `InsecureKeyLengthWarning` de PyJWT por el `JWT_SECRET` corto (A-2) |
| Suite frontend | `cd frontend && npm run test` (17 archivos) | **17 archivos, 61 tests, todos pasan** en 9,9 s |
| Build de producción | `cd frontend && npm run build` (después de la suite, árbol quieto) | **OK** — `tsc -b && vite build`, 2.460 módulos, `dist/` 1,1 MB (JS 903 kB / 272 kB gzip). Aviso no bloqueante: un chunk > 500 kB (sin code-splitting). `dist/` se borró después para dejar el árbol como estaba |
| CI | `.github/workflows/ci.yml` (YAML válido) | job `backend` (Postgres 16, `mypy` → `alembic upgrade head` → `pytest`) y job `frontend` con `needs: backend` (`tsc` → `vitest` → `build`). **No se pudo ejecutar acá**: sin Postgres ni runner |
| Sesión en el navegador | grep `localStorage.setItem`/`sessionStorage.setItem` en `frontend/src` (sin tests) | **ninguno**; el único `localStorage` es el tema (`theme.tsx`, permitido) |
| Fechas | grep `new Date("YYYY-…")` / `toISOString().slice` | ninguno (sólo en comentarios que explican la prohibición) |
| Reloj | grep `datetime.now()`/`utcnow()` en `backend/app` fuera de `clock.py` | ninguno |
| Borrado físico | grep `db.delete(` en `backend/app` | ninguno |
| Costos hacia el dispositivo | grep `cost`/`margin` en `app/catalog` | sólo en docstrings que lo prohíben; el auditor lo verifica además en la respuesta y en el OpenAPI |
| Flags | grep de las 12 claves en routers/servicios | 11 con gate en backend; `multi_store` sin gate (declarado) |

### 4.1 Checklist de `features/fase-1a-cimientos/spec.md`

| Ítem | Estado | Evidencia |
|---|---|---|
| `alembic upgrade head` desde cero; `python -m app.seed` aparte; CI verde con typecheck, suite y build en serie | **parcial** | migración y seed: verificados arriba. CI: YAML correcto y en serie; **hoy no puede estar verde**: el paso `pytest -q` del job `backend` falla por D-2 y el job `frontend` (`needs: backend`) ni corre. El workflow no se pudo ejecutar acá (sin Postgres ni runner) |
| `PUT /admin/features/cash.handovers {enabled:false}` → `POST /handovers` `400 FEATURE_DISABLED`; el POS no muestra «Relevo» | ✔ | `tests/shifts/test_close.py`, `tests/audit/test_security_invariants.py::test_a_disabled_feature_is_refused_by_the_backend_naming_the_feature`; `frontend/src/features/shifts/__tests__/ShiftPage.test.tsx` (pestaña ausente/presente por flag) |
| `pos.daily_menu` sin `pos.combos` → `FEATURE_DEPENDENCY`; `basic` deja los flags de §1.2 | ✔ | `tests/stores/test_features_admin.py::test_put_feature_dependency_missing`, `::test_profile_reset_leaves_exact_spec_defaults`; `tests/core/test_features.py::test_profile_basic_matches_spec_1_2` |
| Admin de la org A recibe `404` leyendo/escribiendo un turno de la B | ✔ | `tests/shifts/test_admin.py`; `tests/audit/test_security_invariants.py::test_admin_of_one_organization_gets_404_{reading,writing}_…`; además aislamiento **por sede** (`…_a_device_of_one_store_gets_404…`) |
| Dos `POST /shifts/open` concurrentes: uno `200`, otro `409` | ✔ con matiz | `tests/audit/test_cash_invariants.py::test_two_concurrent_opens_leave_exactly_one_winner` (sesión por request, hilos reales): un ganador, la perdedora rechazada limpiamente. En SQLite la perdedora llega como `400 SHIFT_ALREADY_OPEN`; la rama `409 SHIFT_OPEN_RACE` (`service.py:365-371`) sólo es alcanzable con Postgres (CI). Ver D-2 |
| `close/count` no devuelve el esperado; `review` sí; `confirm` con `difference_seen` vieja → `DIFFERENCE_CHANGED` | ✔ | `tests/shifts/test_close.py`; auditor `test_close_count_never_reveals_…`, `test_review_reveals_the_equation_…`, `test_confirm_with_stale_difference_seen_…`; frontend `CloseWizard.test.tsx` |
| `cash_reserve` no altera `expected`; `cash-swaps` no altera `expected`; un `pickup` lo baja y guarda `expected_at_pickup` | ✔ | `tests/shifts/test_cash_operations.py`; auditor `test_declared_reserve_never_enters_…`, `test_zero_net_swap_…`, `test_expected_follows_the_single_equation_and_pickup_freezes_its_snapshot` |
| Cierre con foto exigida y sin foto → `PHOTO_REQUIRED` | ✔ | `tests/shifts/test_close.py`; auditor `test_photo_required_on_close_is_enforced_by_the_backend` |
| Cinco `identify` fallidos → `PIN_LOCKED`; la persona activa expira (reloj simulado) | ✔ | auditor `test_five_failed_pins_lock_the_person_and_a_correct_pin_stays_locked`, `test_the_active_person_expires_and_a_cash_write_asks_to_identify_again`; `tests/auth/test_identity.py` |
| Un supervisor autoriza `discount_over_limit` y no `pickup` | ✔ | auditor `test_supervisor_authorizes_discounts_but_never_cash`; `tests/auth/test_authorize.py` |
| `GET /catalog` con dispositivo sin `cost`/`margin`/`unit_cost` (respuesta y OpenAPI) | ✔ | `tests/catalog/test_catalog_endpoint.py::test_catalog_response_has_no_cost_fields`, `::test_openapi_catalog_schema_has_no_cost_fields`; auditor los duplica sobre `catalog` y `shifts` |
| Menú del día `active_now` sólo en su franja y días (reloj simulado); opción agotada no viene `available_today` | ✔ con matiz | `tests/catalog/test_schedule.py` (9 casos puros sobre `combo_active_now(schedule, now)`, incluidas franjas que cruzan medianoche) y `test_combo_option_agotado_stays_listed_with_available_today_false`. El "reloj simulado" es un `now` inyectado a la función, no la fixture `clock` sobre `GET /catalog`; el endpoint usa `clock.now_utc()`, así que la cobertura es equivalente pero no de extremo a extremo |
| No hay `localStorage.setItem` de tokens ni de sesión | ✔ | grep del Maestro; `lib/__tests__/noRawStorage.test.ts`; `src/audit/security.test.ts` |
| Todo `400` de negocio trae `code` y `message` con la acción correctiva | ✔ | auditor `test_every_sampled_error_has_exactly_one_shape`; `tests/core/test_errors.py` |

### 4.2 Sección 16 de `docs/SPEC-NEGOCIO.md` (pedido 1a)

Cubierta por lo anterior salvo dos puntos que agrega: "el cambio de flag queda en
auditoría" (✔ `test_changing_a_feature_flag_leaves_an_audit_row_with_before_and_after`)
y "con diferencia sobre el umbral crítico cierra igual y notifica" (✔
`test_critical_difference_still_closes_and_raises_a_notification`).

## 5. Conflictos NO resueltos y hallazgos de la verificación final

### 5.1 D-1 — Identificarse en la tablet no agrega al roster del turno abierto (nuevo, hallado por el Maestro)

El contrato dice que `POST /auth/device/identify` "adds them to the open shift roster
with `in_at` if a shift is open". `backend/app/auth/router.py:206-210` busca el hook
así:

```python
if importlib.util.find_spec("app.shifts.service") is not None:
    shifts_service = importlib.import_module("app.shifts.service")
    on_identified = getattr(shifts_service, "on_employee_identified", None)
```

pero la función vive en `app/shifts/hooks.py:48` y `app/shifts/service.py` sólo hace
`from app.shifts import hooks` (nunca la re-exporta). Verificado en runtime:
`getattr(app.shifts.service, "on_employee_identified", None)` → `None`. El hook no
corre jamás desde HTTP; quien se identifica sólo entra al roster si es el responsable
al abrir, o por `POST /shifts/{id}/roster` a mano.

- **Por qué nadie lo vio**: `tests/shifts/test_roster_and_hooks.py` prueba el hook
  llamándolo directo; `tests/auth/test_identity.py` nunca abre un turno. Es
  exactamente la costura sin dueño de §1. `backend-caja` lo anticipó por escrito en
  su output (§5, "si no lo llama, identificarse no agrega al roster y es un bug de
  integración a reportar en la ronda de verificación final").
- **Severidad**: bloqueante de contrato, no de plata (no toca el esperado ni la
  seguridad). Afecta la atribución de entradas del personal (spec §7).
- **Corrección** (una línea + un test): en `auth/router.py` importar
  `app.shifts.hooks` en vez de `app.shifts.service` (o re-exportar en `service.py`),
  y un test E2E en `tests/auth/` o `tests/shifts/` que abra turno, identifique a un
  operador y compruebe su fila en `GET /shifts/{id}.roster`. Dueño sugerido:
  `backend-core` (el que llama), con `backend-caja` revisando.
- No lo corregí: la verificación final no reescribe código de un builder sin volver
  a pasar por conciliación, y el cambio es de un agente, no del Maestro.

### 5.2 D-2 — La suite completa del backend está en rojo: `test_two_concurrent_opens_one_wins_one_gets_409`

`tests/shifts/test_open.py:79-95` lanza dos `POST /shifts/open` en hilos sobre el
`device_client` de `tests/conftest.py`, cuyo `get_db` entrega **la misma `Session`** a
todos los requests (`conftest.py:76-100`; A-5 del auditor). Una `Session` de SQLAlchemy
no es segura entre hilos: en la corrida los dos hilos murieron con
`sqlalchemy.exc.ResourceClosedError: This transaction is closed` e
`InvalidRequestError: Session…` (traza `app/auth/deps.py:140 current_operator` →
`app/shifts/router.py:277 post_open_shift` → `app/core/idempotency.py:117
run_idempotent`), ninguno llegó a responder y la aserción falla con `results: []`.

No es un bug del código de turno: el índice único parcial y la carrera real están
probados por `tests/audit/test_cash_invariants.py::test_two_concurrent_opens_leave_exactly_one_winner`
con la fixture `race_app` (una sesión por request), que pasa.

- **Consecuencia**: `python -m pytest -q` sale `1 failed, 212 passed`; el job `backend`
  del CI falla en su último paso y el `frontend` (`needs: backend`) ni corre. El ítem
  "CI verde" del checklist no se cumple.
- **Estado de conciliación**: `backend-caja` lo declaró en su output ("33 passed,
  1 failed… no es mi código") y lo dejó a propósito "porque documenta la limitación";
  el Conciliador dio coherente porque el invariante está cubierto en otro lado. Un
  test que se sabe en rojo y se deja en la suite no documenta nada: es un CI rojo
  permanente que tapa el próximo fallo real.
- **Corrección** (una de las dos, ambas de bajo costo): (a) `backend-core` promueve
  `race_app` (`tests/audit/conftest.py:199`) a fixture compartida en
  `tests/conftest.py` y `backend-caja` reescribe el test sobre ella aceptando
  `{400 SHIFT_ALREADY_OPEN, 409 SHIFT_OPEN_RACE}` como rechazo de la perdedora (el
  `409` literal sólo es alcanzable en Postgres); o (b) `backend-caja` borra el test y
  deja una referencia al invariante del auditor. Recomiendo (a): 1b va a necesitar
  esa fixture para las carreras de cobro.

### 5.3 La ronda 2 no está commiteada

`git status` muestra 18 archivos modificados y 4 nuevos (`backend/app/auth/deps.py`,
`backend/app/shifts/{router,schemas,service}.py`, tests de `audit`/`auth`/`shifts`,
`frontend/src/api/shifts.ts`, `frontend/src/features/shifts/{HandoverPanel,
PickupsPanel,SingleStepCloseForm}.tsx`, `docs/ESTADO.md`, tres outputs; nuevos:
`tests/audit/test_migration_invariants.py`, `tests/shifts/test_expected_visibility.py`,
`__tests__/SingleStepCloseForm.test.tsx`, `outputs/auditor-control.md`). El pedido al
Maestro afirmaba que todo estaba commiteado; no lo está. Toda la verificación de §4
corrió sobre el árbol de trabajo (con la ronda 2 incluida). **Primer paso de §6.**

### 5.4 Abierto por decisión del dueño de la spec (advertencias del auditor, re-verificadas por mí)

| id | Qué | Dónde | Dueño |
|---|---|---|---|
| A-1 | `POST /auth/authorize` sin tope de intentos: oráculo de 10.000 PIN desde el POS | `app/auth/service.py:114` | `backend-core` (spec §2.1 sólo fija el tope para identificarse) |
| A-2 | `JWT_SECRET` con default publicado y sin guardia de producción; PyJWT avisa clave < 32 bytes | `app/core/config.py:16` | `backend-core` |
| A-3 | `app/shifts/models.py` usa `sa.DateTime(timezone=True)` en 15 columnas, cero `UTCDateTime`: explota en SQLite (dev y tests), no en Postgres (CI) | `app/shifts/models.py` | `backend-caja` — **la más urgente antes de 1b** |
| A-4 | `GET /admin/shifts` devuelve `expected_cash` almacenado (`null` mientras el turno está abierto) en vez de calcularlo | `app/shifts/router.py:211` | `backend-caja` |
| A-5 | Fixture `db` compartida entrega una sola `Session` a todos los requests: no sirve para tests con hilos | `tests/conftest.py:76-100` | `backend-core` (ofrecer `race_app` como fixture común) |
| A-6 | `cash-swaps` y `pickups/{pid}/reverse` sin `Idempotency-Key` (dentro del contrato, fuera de §11.9) | `app/shifts/router.py:385,426` | `backend-caja` |
| A-7 | La auditoría de empleados guarda `document` y `email` en el JSON antes/después, exportable a CSV (Ley 1581) | `app/auth/router.py:399,415,449` | `backend-core` — **verificar con abogado** |
| A-8 | `run_idempotent` y `open_shift` hacen `rollback()` completo ante `IntegrityError` (pierden la reserva de la clave perdedora) | `app/core/idempotency.py:120`, `app/shifts/service.py:367` | `backend-core` / `backend-caja` |
| A-9 | No hay ruta de dispositivo para listar el personal de la sede: cuatro pantallas piden **número de empleado a mano** (`DeviceIdentifyPage`, `RosterPanel`, `OpenShiftForm`, `HandoverPanel`) | `app/auth/router.py` | `backend-core` + frontends — la UX de "Quién opera" de §9.1 no existe todavía |
| O-1 | El responsable ve el esperado en `/shifts/current` y después entra al cierre "a ciegas": tensión entre el contrato de 1a y §3.2 | diseño | dueño de la spec |

### 5.5 Gaps declarados por los builders que siguen abiertos

- `DELETE /admin/shifts/{id}` no acepta motivo en el body (motivo fijo en auditoría);
  la UI pide confirmación pero no puede mandar uno.
- `AdminShiftListItem` no trae `close_cause` ni `opening_cash_total`: Dinero →
  Operacional muestra "Revisado/Sin revisar" en vez de la causa.
- Anidados de la carta upsert-only: no hay forma (API ni UI) de quitar una opción de
  un grupo de modificadores ni un grupo de un combo; `CombosTab` no agrega grupos a
  un combo existente.
- Sin tests de las pantallas `settings`/`people`/`audit`/`notifications`
  (`frontend-core` lo declara como deuda propia).
- `shadcn` en `dependencies` (debería ser dev); sin token semántico `--warning`
  (`ShiftStatusStrip` usa `amber-500`).
- Interpretaciones que el dueño de la spec debe confirmar: `multi_store` sin gate en
  el backend; `UvtValue` por organización; `courtesy_shift_limit` como cantidad y no
  pesos; `GET /admin/audit?employee_id` filtra por autor, no por entidad;
  `closes_day_suggested` como "no hay otro turno abierto ese día";
  `declared_not_obliged_by` como texto sin FK.
- `docs/ESTADO.md` está **desactualizado**: dice que el frontend "todavía no existe"
  y que `catalogo` no entregó router ni migración. Contradice el árbol.

### 5.6 Lo que no se pudo verificar en este entorno

- Postgres (el CI lo declara; acá todo corrió en SQLite): tipos, índices y
  constraints de las migraciones a mano; el `409 SHIFT_OPEN_RACE` literal.
- El CI en sí (no hay runner acá): se validó el YAML y el orden de pasos.
- Accesibilidad (WCAG 2.1 AA) más allá de lo que los propios agentes verificaron
  con Testing Library (roles, `aria-label`, teclado en `PinPad`).
- La app corriendo con un navegador real (`launch.json` está ajustado y el backend
  sirve `frontend/dist` con fallback SPA, pero no se probó el flujo completo a mano).

## 6. Próximos pasos, en orden

1. **Commitear la ronda 2** tal como está (§5.3). Sin eso, nada de lo verificado
   existe en el historial.
2. **D-1**: importar el hook desde `app.shifts.hooks` en `auth/router.py` + test E2E
   identify → roster. `backend-core`.
3. **D-2**: `race_app` como fixture compartida y el test de carrera de `tests/shifts` reescrito sobre ella (o borrado). `backend-core` + `backend-caja`. Sin esto el CI no se pone en verde.
4. **A-3**: migrar `app/shifts/models.py` a `UTCDateTime` (sin cambio de esquema: es
   un `TypeDecorator` sobre el mismo tipo). `backend-caja`. Antes de 1b, porque 1b
   va a comparar `closed_at` contra el reloj.
5. **A-2**: validador en `Settings` que rechace el `JWT_SECRET` por defecto o corto
   cuando `ENV == "production"`. `backend-core`.
6. **A-9**: `GET /device/employees` (sólo `id`, `name`, `role` de activos de la sede
   del dispositivo; nunca `document`, `email` ni `discount_limit_pct` ajeno) y
   reemplazar los cuatro `<input type="number">` por un selector con nombres. Es lo
   que convierte "Quién opera" en la pantalla que pide §9.1.
7. **Actualizar `docs/ESTADO.md`** ("Cómo corre", "Qué está hecho", "Dónde
   retomar") con el estado real: frontend existente, catálogo completo, pedido 1a
   entregado con D-1/D-2 pendientes. `backend-core` (dueño del archivo) o el Maestro
   al lanzar 1b.
8. **Decisiones del dueño de la spec** antes de 1b: O-1 (ocultar el esperado desde
   que se teclea el conteo, o aceptar el arqueo sorpresa como control real); A-7 (qué
   PII entra a la auditoría — con abogado); `multi_store`, UVT, `courtesy_shift_limit`,
   semántica de `employee_id` en auditoría.
9. Deuda técnica de bajo costo: A-6 (idempotencia en swaps y reversa), A-4
   (esperado calculado para turnos abiertos en `GET /admin/shifts`), A-1 (tope de
   intentos en `authorize`), A-8 (`SAVEPOINT` en vez de `rollback()`), motivo en
   `DELETE /admin/shifts/{id}`, `close_cause` en `AdminShiftListItem`, `shadcn` a
   `devDependencies`, token `--warning`.
10. Cobertura frontend de `settings`/`people`/`audit`/`notifications`; ampliar el
    invariante de migraciones a tipos e índices corriendo contra Postgres en CI.
11. **Corregir el contrato interno para 1b**: cada hook cruzado con dueño del test
    E2E; fixture común de "una sesión por request" para tests de carrera.
12. Lanzar el pedido 1b sobre esto, con `docs/ESTADO.md` ya al día.
