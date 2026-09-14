# Contrato interno del pedido 1a (Maestro → equipo)

Este documento es el acuerdo de construcción entre los agentes del pedido 1a. Lo
escribió el Maestro para que seis agentes trabajen **en paralelo sobre un repo vacío**
sin pisarse. Manda sobre las preferencias de cada agente; no manda sobre
`docs/SPEC-NEGOCIO.md`, `AGENTS.md` ni `features/fase-1a-cimientos/spec.md` (si algo
de acá los contradice, mandan ellos y se reporta el gap).

Todo lo de código (nombres, firmas, rutas) va en inglés; las explicaciones en español.

---

## 0. Territorios

| Agente | Escribe SOLO en | No toca |
|---|---|---|
| `backend-core` | `backend/` (todo lo que no sea de otro: `pyproject.toml`, `requirements*.txt`, `alembic.ini`, `alembic/env.py`, `alembic/versions/0001_core.py`, `app/__init__.py`, `app/main.py`, `app/seed.py`, `app/core/**`, `app/auth/**`, `app/stores/**`, `app/audit/**`, `app/notifications/**`, `tests/conftest.py`, `tests/core/**`, `tests/auth/**`, `tests/stores/**`, `tests/audit_log/**`, `tests/notifications/**`), `.github/workflows/ci.yml`, `.claude/launch.json`, `docs/ESTADO.md`, sección «Verificación mínima» de `AGENTS.md` | `app/catalog`, `app/shifts`, `tests/catalog`, `tests/shifts`, `tests/audit`, `frontend/` |
| `backend-caja` | `backend/app/shifts/**`, `backend/tests/shifts/**`, `backend/alembic/versions/0003_shifts.py` | todo lo demás |
| `catalogo` (full-stack) | `backend/app/catalog/**`, `backend/tests/catalog/**`, `backend/alembic/versions/0002_catalog.py`, `frontend/src/features/catalog/**`, `frontend/src/api/catalog.ts` | todo lo demás |
| `frontend-core` | `frontend/` (todo lo que no sea de otro: `package.json`, configs, `index.html`, `src/main.tsx`, `src/app/**`, `src/api/{client,auth,features,stores,employees,audit,notifications}.ts`, `src/lib/**`, `src/components/**`, `src/features/{auth,features,settings,people,audit,notifications}/**`, `src/pages/**`, `src/test/**`) | `src/features/shifts`, `src/features/catalog`, `src/api/shifts.ts`, `src/api/catalog.ts`, `backend/` |
| `frontend-caja` | `frontend/src/features/shifts/**`, `frontend/src/api/shifts.ts` | todo lo demás |
| `auditor-control` | `backend/tests/audit/**`, `frontend/src/audit/**` | todo lo demás (no arregla código ajeno: reporta) |

Archivos compartidos con **dueño único**: `.gitignore` (ya existe y cubre Python y
Node: nadie lo toca), `docs/ESTADO.md` (solo `backend-core`, al final), `.claude/launch.json`
(solo `backend-core`). Cada agente escribe su entregable en
`features/fase-1a-cimientos/outputs/<id>.md`.

## 1. Orden de arranque y reglas de espera

- **Instalaciones**: solo `backend-core` corre `pip install` (global, sin venv:
  `pip install -r backend/requirements.txt -r backend/requirements-dev.txt`), y solo
  `frontend-core` corre `npm install` (deja `package-lock.json`). Nadie más instala
  nada ni edita `package.json` / `requirements*.txt`; si te falta una dependencia,
  la declarás en `gaps`.
- `backend-core` escribe **primero, en este orden y antes de cualquier router**:
  `requirements*.txt` + `pip install` → `app/core/*` → `app/auth/deps.py` y
  `app/auth/models.py` → `app/stores/models.py` → `app/audit/service.py` y
  `app/notifications/service.py` → `app/main.py` → `tests/conftest.py`. Es lo que
  destraba a `backend-caja`, `catalogo` y `auditor-control`.
- `frontend-core` escribe primero: scaffold + `npm install` → `src/api/client.ts` →
  `src/lib/*` → `src/app/{session,nav,router}.tsx` y layouts → **stubs** de
  `src/features/shifts/index.ts` y `src/features/catalog/index.ts` (solo si no existen).
- Los demás **empiezan escribiendo código sin correr nada** (modelos, servicios,
  componentes, tests). Antes de ejecutar tests comprobá con `ls` que existen los
  módulos compartidos que importás (`backend/tests/conftest.py`,
  `frontend/node_modules/.bin/tsc`, etc.). Si no existen, seguí con tu código y
  volvé a comprobar más tarde. **Nunca crees vos un archivo del territorio de otro.**
  Si al terminar todo tu código siguen faltando, corré tus tests con `timeout 600`,
  y lo que falle solo por módulos ausentes lo declarás en `gaps` (hay ronda 2).
- Tests: cada agente usa su propio `TMPDIR=/tmp/pt-<id>` y corre **solo** sus
  archivos: `cd backend && TMPDIR=/tmp/pt-<id> python -m pytest tests/<dominio> -q`;
  `cd frontend && npx vitest run src/features/<dominio>`; typecheck completo sí
  (`python -m mypy app`, `npm run typecheck`) pero tolerando errores de archivos ajenos
  a medio escribir (reportalos, no los arregles). Nunca la suite completa; nunca
  `npm run build`.

## 2. Backend: módulos compartidos (los escribe `backend-core`; los demás los importan)

Stack: Python 3.11, FastAPI, SQLAlchemy 2.x (estilo `Mapped[]`/`mapped_column`),
Pydantic v2, Alembic, pytest, httpx (TestClient), mypy (config estricta razonable:
`disallow_untyped_defs = true` en `app/`, `ignore_missing_imports = true`), PyJWT,
bcrypt. `backend/pyproject.toml` con `[tool.pytest.ini_options] testpaths=["tests"]`
y `[tool.mypy]`. `requirements.txt` (runtime, con versiones fijadas) y
`requirements-dev.txt`.

```
app/main.py            create_app(): registra handlers de error, CORS (mismo origen: no hace falta), y
                       DESCUBRE routers: for d in DOMAINS=["auth","stores","catalog","shifts","audit","notifications"]:
                         if importlib.util.find_spec(f"app.{d}.router"): app.include_router(mod.router, prefix="/api/v1")
                       Si existe ../frontend/dist, monta StaticFiles con fallback SPA en "/" (después de /api).
app/core/models_registry.py  import_all_models(): importa app.<d>.models con el mismo find_spec (lo usa alembic/env.py y conftest).
app/core/config.py     settings: DATABASE_URL (default "sqlite:///./dev.db"), JWT_SECRET, ENV ("dev"|"test"|"production"),
                       EMPLOYEE_SESSION_MINUTES=3, PIN_LOCK_ATTEMPTS=5, PIN_LOCK_MINUTES=15, DEVICE_SESSION_DAYS=180, ADMIN_SESSION_HOURS=12
app/core/db.py         Base(DeclarativeBase), engine, SessionLocal, get_db(); en SQLite: PRAGMA busy_timeout=5000, foreign_keys=ON, journal_mode=WAL
app/core/clock.py      now_utc() -> datetime (aware). set_clock(fn|None). TODO EL CÓDIGO usa clock.now_utc(); prohibido datetime.now()/utcnow().
app/core/tz.py         BOGOTA = ZoneInfo("America/Bogota"); to_bogota(dt); business_date_for(instant_utc, cutoff_hour:int) -> date
                       (si la hora local < cutoff_hour, es el día anterior); today_business_date(cutoff_hour)
app/core/money.py      DENOMINATIONS = [50,100,200,500,1000,2000,5000,10000,20000,50000,100000]; Denomination(value:int,count:int)
                       sum_denominations(list) -> int; validate_denominations(list, total) -> int  (400 DENOMINATIONS_MISMATCH / DENOMINATION_INVALID)
app/core/errors.py     AppError(code:str, message:str, status:int=400, extra:dict|None=None); NotFoundError (404 NOT_FOUND),
                       ConflictError (409), UnauthorizedError (401), ForbiddenError (403). Handlers → {"error":{"code","message",...extra}}.
                       RequestValidationError → 400 {"error":{"code":"VALIDATION_ERROR","message":"<campo>: <problema>"}}.
                       Excepción no controlada → 500 {"error":{"code":"INTERNAL_ERROR","message":"Error interno"}} sin detalles.
app/core/security.py   hash_secret(plain)->str, verify_secret(plain, hashed)->bool (bcrypt); make_token(payload, ttl)->str, read_token(token)->dict (PyJWT HS256);
                       COOKIE_ADMIN="admin_session", COOKIE_DEVICE="device_session"; set_session_cookie(response, name, token, max_age), clear_session_cookie(...)
                       cookies: httponly=True, samesite="lax", secure=(settings.ENV=="production"), path="/"
app/core/idempotency.py  run_idempotent(db, *, organization_id:int, scope:str, key:str|None, request_hash:str, fn:Callable[[], tuple[int, dict]]) -> tuple[int, dict]
                       - key None → 400 IDEMPOTENCY_KEY_REQUIRED ("Enviá el encabezado Idempotency-Key")
                       - inserta fila en idempotency_keys(organization_id, scope, key, request_hash, response_status, response_body JSON, created_at)
                         UNIQUE(organization_id, scope, key) DENTRO de la transacción; si ya existe con mismo hash → devuelve (status, body) original;
                         hash distinto → 400 IDEMPOTENCY_MISMATCH; existe sin respuesta (en curso) → 409 IDEMPOTENCY_IN_PROGRESS.
                       request_hash = sha256 del JSON canónico del body. idempotency_key(request) -> str|None lee el header.
app/core/csv.py        csv_response(rows: list[dict], filename:str) -> Response; helper wants_csv(request) (query format=csv)
app/core/features.py   FEATURE_CATALOG: list[FeatureDef(key, description, requires:list[str], defaults:{basic,standard,full}, available_from_phase:str)]
                       = la tabla completa de SPEC-NEGOCIO §1.2 (todas las claves, aunque su módulo llegue después)
                       enabled_map(db, organization_id, store_id|None) -> dict[str,bool]   (org + override de sede)
                       is_enabled(db, organization_id, store_id, key) -> bool
                       assert_feature(db, organization_id, store_id, key) -> None   → 400 FEATURE_DISABLED {"feature": key}
                       require_feature(key) -> dependencia FastAPI: resuelve org/sede desde la sesión (device: su sede; admin: store_id de
                       path/query si existe, si no valor de organización) y llama assert_feature.
app/auth/models.py     Employee(id, organization_id FK, store_id FK|None (admin: None = toda la org), name, role Enum("operator","supervisor","admin"),
                       pin_hash, email|None unique, password_hash|None, can_charge bool, discount_limit_pct Numeric(5,2)|None, document|None,
                       active bool, failed_pin_attempts int, pin_locked_until datetime|None, created_at, updated_at)
                       DeviceSession(id uuid str, organization_id, store_id, device_name|None, employee_id|None, employee_bound_at|None,
                       employee_expires_at|None, created_at, revoked_at|None)
                       Authorization(id, organization_id, store_id, authorizer_id FK employees, authorizer_name, action str,
                       requested_by_employee_id|None, at datetime, reference_type|None, reference_id|None)
app/auth/deps.py       @dataclass Actor(kind:"admin"|"device", organization_id:int, store_id:int|None, employee_id:int|None, employee_name:str|None, role:str|None)
                       current_admin() -> Actor (401 NOT_AUTHENTICATED "Iniciá sesión")
                       current_device() -> Actor (401 DEVICE_NOT_ACTIVATED "Activá el dispositivo con el PIN de sede")
                       current_operator() -> Actor con employee_id (401 IDENTIFY_REQUIRED "Identificate con tu PIN"); renueva employee_expires_at (sliding)
                       current_actor() -> Actor: admin o dispositivo con persona; los servicios reciben Actor para atribuir (employee_id + employee_name)
                       admin_store(db, actor, store_id) -> Store  (404 si la sede no es de su organización)
app/auth/service.py    verify_authorizer(db, *, organization_id, store_id, pin:str|None, action:str, requested_by:Actor|None, reference=None) -> Employee
                       - pin None → 400 AUTHORIZATION_REQUIRED ("Pedí el PIN de un administrador" o "...de un supervisor o administrador" según acción)
                       - PIN inválido → 400 AUTHORIZATION_INVALID; bloqueado → 400 PIN_LOCKED; rol sin permiso → 400 AUTHORIZATION_NOT_ALLOWED
                       - Registra Authorization. Matriz: SUPERVISOR_ACTIONS={"void_sent_item","courtesy","discount_over_limit"}; admin: cualquier acción
                         (incluye "pickup","pickup_reverse","spot_check","petty_over_limit","handover","close_administrative","reopen","adjust_opening").
                         roles.supervisor apagado → los supervisores no autorizan nada.
                       verify_pin(db, employee, pin) -> bool con contador de fallos y bloqueo 15 min tras 5 (notifica pin_locked)
app/stores/models.py   Organization(id, name, profile Enum("basic","standard","full"), declared_not_obliged_at|None, declared_not_obliged_by|None)
                       Store(id, organization_id, name, nit, dv, legal_name, address, municipality_dane, opening_hours JSON, cutoff_hour int=6,
                       active_channels JSON, store_pin_hash, active)
                       StoreFiscalConfig(id, store_id, valid_from date, person_type, regime, franchise, inc_responsible, iva_responsible, rut_codes JSON,
                       price_includes_tax, default_tax Enum("inc_8","iva_19","excluded"), created_at)   ← vigente = mayor valid_from ≤ hoy
                       StoreCashSettings(store_id PK, opening_cash_fixed=200000, cash_reserve_default=0, tolerance_unknown_cause=20000,
                       tolerance_identified_cause=100000, critical_difference=100000, cash_pickup_threshold=500000, petty_cash_limit=50000,
                       photo_required_on_close=True, photo_required_on_pickup=True, streak_alert_shifts=3)
                       StoreSalesSettings(store_id PK, tip_suggested_pct, discount_limit_pct, discount_daily_limit_pct, courtesy_shift_limit,
                       payment_methods JSON, void_reasons JSON, discount_reasons JSON, courtesy_reasons JSON, courses JSON, stations JSON, course_target_minutes JSON)
                       UvtValue(year PK, value int); Zone(id, store_id, name, sort_order, active); Table(id, zone_id, store_id, number, seats, active)
                       FeatureState(id, organization_id, store_id|None, key, enabled, updated_at, updated_by)  UNIQUE(organization_id, store_id, key)
app/stores/service.py  get_cash_settings(db, store_id) -> StoreCashSettings (crea defaults si no existe); get_sales_settings(...); current_fiscal(db, store_id, on:date|None)
app/audit/service.py   record_audit(db, *, actor:Actor|None, organization_id, store_id|None, entity:str, entity_id:int|str, action:str,
                       before:dict|None, after:dict|None, reason:str|None=None) -> None   (flush en la misma sesión; si falla, log.error, NUNCA levanta)
app/notifications/service.py  NOTIFICATION_TYPES = ["shift_stale","cash_difference","cash_difference_critical","difference_streak",
                       "cash_over_threshold","pin_locked","product_unavailable"]
                       notify(db, *, organization_id, store_id, type:str, level:"info"|"warning"|"critical", title:str, body:str,
                       payload:dict|None=None, dedupe_key:str|None=None) -> Notification|None   (respeta reglas por sede; dedupe diario por dedupe_key)
```

Dinero: columnas `Integer` (pesos enteros). Enums: `sa.Enum(..., native_enum=False, length=32)`
y comparar por valor. Fechas de negocio: `Date`. Instantes: `DateTime(timezone=True)`
en UTC; serializar con `Z`. Todo modelo con `organization_id` y `store_id` donde
aplique; toda consulta filtra por ambos y responde `404 NOT_FOUND` ante un id ajeno.

Hooks cruzados (cada uno protegido con `importlib.util.find_spec` en el llamador,
porque el módulo puede no existir durante la construcción):

- `backend-core` en `identify` llama `app.shifts.service.on_employee_identified(db, *, store_id:int, employee:Employee) -> None` (agrega al roster del turno abierto con `in_at` si no está).
- `backend-caja` al crear un `BusinessDay` llama `app.catalog.service.reset_daily_availability(db, *, store_id:int) -> None`.
- `backend-caja` obtiene ventas por medio con `app.shifts.hooks.get_sales_totals(db, shift_id) -> SalesTotals(cash=0, card=0, transfer=0, tips_cash=0)`: en 1a devuelve ceros con un comentario «1b lo reemplaza leyendo payments».
- `pin_locked` lo emite `backend-core`; `product_unavailable`, `catalogo`; los cinco de caja, `backend-caja`.

## 3. Fixtures de tests (`backend/tests/conftest.py`, los escribe `backend-core`; todos los usan)

Base SQLite en archivo bajo `tmp_path` (respeta `TMPDIR`), `create_all` por test,
`check_same_thread=False`, `StaticPool` NO (los tests de concurrencia usan hilos).
`app.dependency_overrides[get_db]` apunta a esa base.

```
client            TestClient sin sesión
db                Session de la base del test
org               Organization(profile="full")   ← todo encendido por defecto
store             Store de org: name "Sede Centro", cutoff_hour 6, PIN de sede "123456", cash settings default, fiscal vigente (natural, ordinary, inc_8)
store_b, org_b    segunda organización con su sede (para tests de aislamiento)
employees         dict: admin (PIN "9999", email "admin@test.local", password "admin1234", store_id None),
                  supervisor ("5555"), cashier ("1111", can_charge=True), operator ("2222"), operator2 ("3333"), operator3 ("4444")
admin_client      TestClient con cookie de admin (POST /api/v1/auth/admin/login)
device_client     TestClient con cookie de dispositivo activado en `store`
identify(client, employee, pin=None)   helper: POST /auth/device/identify con el PIN conocido del empleado
set_feature(key, enabled, store_id=None)   escribe FeatureState de `org`
clock             objeto con .set(datetime_utc) y .advance(minutes=…, hours=…, days=…); resetea al final del test
idem()            -> {"Idempotency-Key": uuid4()}
```

Los tests de dominio pueden agregar `tests/<dominio>/conftest.py` con fixtures propias
(p. ej. `open_shift` en `tests/shifts/conftest.py`), nunca redefinir las de arriba.

## 4. Alembic

`alembic/env.py` lee `DATABASE_URL`, usa `Base.metadata` tras `import_all_models()`,
`render_as_batch=True` cuando es SQLite, `compare_type=True`. Revisiones con id fijo
y cadena lineal:

| Archivo | `revision` | `down_revision` | Dueño |
|---|---|---|---|
| `0001_core.py` | `"0001"` | `None` | backend-core |
| `0002_catalog.py` | `"0002"` | `"0001"` | catalogo |
| `0003_shifts.py` | `"0003"` | `"0002"` | backend-caja |

DDL Postgres-first escrito a mano (no autogenerado a ciegas): índices para cada FK y
para cada filtro de pantalla; índice único parcial `uq_shifts_one_open_per_store`
sobre `shifts(store_id)` con `postgresql_where=text("status='open'")` y
`sqlite_where=text("status='open'")`. Verificación: `cd backend && rm -f /tmp/pt-<id>/mig.db && DATABASE_URL=sqlite:////tmp/pt-<id>/mig.db alembic upgrade head`.
Los tests NO usan Alembic (usan `create_all`).

## 5. Frontend: módulos compartidos (los escribe `frontend-core`; los demás los importan)

Stack: Vite + React 18 + TypeScript strict, Tailwind + shadcn/ui (estilo `new-york`,
variables CSS, claro/oscuro con `class` en `<html>`), `react-router-dom`,
`@tanstack/react-query`, `react-hook-form` + `zod`, `lucide-react` (íconos SVG),
`sonner` (toasts), vitest + `@testing-library/react` + `jsdom`. Alias `@/` → `src/`.
Scripts: `dev`, `build` (`tsc -b && vite build`), `typecheck` (`tsc --noEmit -p tsconfig.app.json`),
`test` (`vitest run`). `vite.config.ts` con proxy `/api` → `http://localhost:8000`
(mismo origen; las cookies viajan solas).

```
src/api/client.ts        api<T>(path, {method?, body?, idempotencyKey?, query?}): Promise<T>  base "/api/v1", credentials "include",
                         JSON; ante !ok lanza ApiError {status, code, message, extra}; 401 dispara evento "session:expired".
                         newIdempotencyKey(): string (crypto.randomUUID)
src/api/auth.ts          Me {kind:"admin"|"device", user?, store?, employee?, employee_expires_at?, organization, features: Record<string,boolean>}
                         getMe(), adminLogin(), logout(), deviceActivate(), deviceIdentify(), deviceRelease(), deviceDeactivate(), authorize({pin, action})
src/app/session.tsx      <SessionProvider>, useSession(): {me, loading, refresh(), hasFeature(key): boolean}
src/app/nav.ts           type NavItem = {to:string; label:string; feature?:string; icon?:LucideIcon}
src/app/router.tsx       createBrowserRouter: "/admin/*" (AdminLayout, requiere kind admin), "/pos/*" (PosLayout, requiere kind device),
                         "/login", "/pos/activate", "/pos/identify". Concatena rutas y nav de features/shifts e features/catalog.
src/app/AdminLayout.tsx  sidebar armado desde NavItem[] filtrando por hasFeature; modo claro/oscuro; <Outlet/>
src/app/PosLayout.tsx    barra superior: persona activa + «Cambiar de persona»; renderiza <ShiftStatusStrip/> de features/shifts; <Outlet/>; botones ≥ 44px
src/lib/businessDate.ts  formatBusinessDate("YYYY-MM-DD") → "lun 14 sep 2026"; parseBusinessDate(s) → {y,m,d} (NUNCA new Date("YYYY-MM-DD"));
                         formatInstant(isoZ) en America/Bogota (Intl). Prohibido toISOString().slice(0,10).
src/lib/money.ts         formatCOP(n: number|null|undefined) → "$ 1.234.567" | "—" (null nunca es 0); parseCOP(input) → number|null
src/lib/errors.ts        errorMessage(e): string  (siempre texto legible; nunca renderizar un objeto)
src/components/ui/*      shadcn: button input label card dialog alert-dialog table tabs badge select switch checkbox textarea
                         separator alert sheet scroll-area dropdown-menu tooltip sonner skeleton
src/components/PinPad.tsx    teclado numérico accesible (4 o 6 dígitos, onSubmit(pin)); src/components/DenominationsInput.tsx
                         (filas por denominación, total calculado SOLO para mostrar lo tecleado, no es «esperado»); src/components/MoneyInput.tsx; src/components/EmptyState.tsx
src/features/shifts/index.ts    export const shiftsFeature = { posRoutes: RouteObject[], adminRoutes: RouteObject[], adminNav: NavItem[], posNav: NavItem[], ShiftStatusStrip: ComponentType }
src/features/catalog/index.ts   export const catalogFeature = { adminRoutes: RouteObject[], adminNav: NavItem[] }
```

Los dos `index.ts` de features los crea `frontend-core` como **stub vacío solo si no
existen** (arrays vacíos y un componente que devuelve `null`); `frontend-caja` y
`catalogo` los sobreescriben con el contenido real. Ningún otro archivo se comparte.
Tests de frontend: `src/test/setup.ts` (jest-dom) y helper `renderWithProviders(ui, {me})`
en `src/test/utils.tsx` (QueryClient + SessionProvider con `me` inyectado + MemoryRouter).
Nada de sesión en `localStorage`/`sessionStorage` (solo se permite el tema claro/oscuro).

## 6. Códigos de error (todos con `message` que nombra la acción correctiva)

401 `NOT_AUTHENTICATED`, `DEVICE_NOT_ACTIVATED`, `IDENTIFY_REQUIRED`, `SESSION_EXPIRED` ·
403 `FORBIDDEN` · 404 `NOT_FOUND` · 409 `SHIFT_OPEN_RACE`, `IDEMPOTENCY_IN_PROGRESS`, `CONFLICT` ·
400 `VALIDATION_ERROR`, `FEATURE_DISABLED`, `FEATURE_DEPENDENCY`, `FEATURE_IS_CORE`, `PIN_LOCKED`,
`PIN_INVALID`, `INVALID_CREDENTIALS`, `STORE_PIN_INVALID`, `AUTHORIZATION_REQUIRED`, `AUTHORIZATION_INVALID`,
`AUTHORIZATION_NOT_ALLOWED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_MISMATCH`, `DENOMINATIONS_MISMATCH`,
`DENOMINATION_INVALID`, `SHIFT_ALREADY_OPEN`, `NO_OPEN_SHIFT`, `SHIFT_NOT_OPEN`, `SHIFT_NOT_STALE`, `SHIFT_HAS_ACTIVITY`,
`OPENING_DIFFERENCE_NEEDS_CAUSE`, `PETTY_CASH_LIMIT`, `SWAP_NOT_ZERO`, `PHOTO_REQUIRED`, `CARD_TOTAL_REQUIRED`,
`TRANSFER_TOTAL_REQUIRED`, `DIFFERENCE_CHANGED`, `CAUSE_REQUIRED`, `IDENTIFIED_CAUSE_REQUIRED`, `NOT_CASH_RESPONSIBLE`,
`EMPLOYEE_NOT_IN_ROSTER`, `PICKUP_ALREADY_REVERSED`, `COMBO_WITHOUT_GROUPS`, `PRODUCT_UNAVAILABLE`, `OPTION_UNAVAILABLE`,
`TIP_PCT_OVER_LIMIT`, `FISCAL_VALID_FROM_REQUIRED`.

## 7. Verificación por agente (recordatorio)

Solo tus tests y el typecheck. La suite completa, `alembic upgrade head` global y
`npm run build` los corre la verificación final del Maestro, una vez, en serie.
