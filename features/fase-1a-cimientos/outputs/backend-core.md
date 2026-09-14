# backend-core — cimientos, identidad, organización y sede

Agente: `backend-core`. Territorio: `backend/` salvo `app/catalog`, `app/shifts`,
`tests/catalog`, `tests/shifts`, `tests/audit` y `alembic/versions/0002_*`/`0003_*`;
además `.github/workflows/ci.yml`, `.claude/launch.json`, `docs/ESTADO.md` y la
sección «Verificación mínima» de `AGENTS.md`. No toqué `frontend/` ni `.gitignore`
ni ningún archivo de otro agente.

---

## 1. Qué quedó, por módulo

### 1.1 Instalación (orden real seguido)

`backend/requirements.txt` y `backend/requirements-dev.txt` con versiones
fijadas (fastapi 0.141.1, sqlalchemy 2.0.52, pydantic 2.13.5, alembic 1.20.0,
PyJWT 2.14.0 + `cryptography` 46.0.7 fijado explícito — ver gap §5.1 —, bcrypt
5.0.0, psycopg[binary] 3.3.5 para Postgres en CI, pytest 9.1.1, httpx 0.28.1,
mypy 1.20.2). `backend/pyproject.toml` con `[tool.pytest.ini_options]` y
`[tool.mypy]` (`disallow_untyped_defs = true`). Corrí
`pip install -r requirements.txt -r requirements-dev.txt` (global, sin venv,
como pide el contrato) — soy el único agente que instala.

### 1.2 `app/core/` (fundacional, lo usan los seis)

| Archivo | Contenido |
|---|---|
| `config.py` | `Settings` (pydantic-settings): `DATABASE_URL`, `JWT_SECRET`, `ENV`, `EMPLOYEE_SESSION_MINUTES=3`, `PIN_LOCK_ATTEMPTS=5`, `PIN_LOCK_MINUTES=15`, `DEVICE_SESSION_DAYS=180`, `ADMIN_SESSION_HOURS=12`. |
| `db.py` | `Base`, `make_engine`/`engine` (PRAGMA `busy_timeout=5000`, `foreign_keys=ON`, `journal_mode=WAL` en SQLite), `SessionLocal`, `get_db()`. **`UTCDateTime`** — tipo nuevo, no estaba en el contrato interno (ver §4). |
| `clock.py` | `now_utc()`, `set_clock(fn\|None)`. |
| `tz.py` | `BOGOTA`, `to_bogota(dt)`, `business_date_for(instant_utc, cutoff_hour)`, `today_business_date(cutoff_hour)`. |
| `money.py` | `DENOMINATIONS`, `Denomination(value,count)`, `sum_denominations`, `validate_denominations` (`DENOMINATION_INVALID` / `DENOMINATIONS_MISMATCH`). |
| `errors.py` | `AppError`, `NotFoundError`, `ConflictError`, `UnauthorizedError`, `ForbiddenError`, `register_error_handlers(app)` (`AppError`, `RequestValidationError` → `VALIDATION_ERROR`, `StarletteHTTPException`, `Exception` → 500 `INTERNAL_ERROR` sin detalle). |
| `security.py` | `hash_secret`/`verify_secret` (bcrypt), `make_token`/`read_token` (PyJWT HS256), `COOKIE_ADMIN`/`COOKIE_DEVICE`, `set_session_cookie`/`clear_session_cookie` (httponly, samesite=lax, secure en producción). |
| `idempotency.py` | `idempotency_key(request)`, `hash_request_body(body)`, `run_idempotent(db, *, organization_id, scope, key, request_hash, fn)`. Ver §4 por el cambio sobre el contrato (errores de negocio también quedan resueltos, no "en curso" para siempre). |
| `csv.py` | `wants_csv(request)`, `csv_response(rows, filename)`. |
| `features.py` | `FeatureDef`, `FEATURE_CATALOG` (41 claves, la tabla completa de SPEC-NEGOCIO §1.2), `FEATURE_BY_KEY`, `profile_defaults`, `enabled_map`, `is_enabled`, `assert_feature`, `require_feature`. |
| `models_registry.py` | `MODEL_MODULES = ["core","auth","stores","catalog","shifts","audit","notifications"]`, `import_all_models()`. |
| `models.py` | `IdempotencyKey` (única tabla de infraestructura pura; no es de ningún dominio de negocio). |

### 1.3 `app/auth/`

- `models.py`: `Employee` (el admin es un `Employee` con `role="admin"`,
  `store_id=None`), `DeviceSession`, `Authorization`.
- `deps.py`: `Actor` (dataclass), `current_admin`, `current_device`,
  `current_device_session` (**agregado**, no estaba nombrado en el contrato —
  ver §4), `current_operator`, `current_actor`, `admin_store`. Desde la
  iteración 2 (§8), `current_device` también expone la persona identificada
  cuando está vigente — ver §8 por la semántica exacta y por qué
  `current_operator` sigue siendo el único que exige persona y renueva su
  ventana.
- `service.py`: `SUPERVISOR_ACTIONS`, `verify_pin`, `verify_authorizer`.
- `schemas.py` + `router.py`: ver endpoints en §2.

### 1.4 `app/stores/`

- `models.py`: `Organization`, `Store`, `StoreFiscalConfig`,
  `StoreCashSettings`, `StoreSalesSettings`, `UvtValue`, `Zone`, `Table`,
  `FeatureState`.
- `service.py`: `get_cash_settings`, `get_sales_settings`, `current_fiscal`, más
  los defaults exportados (`DEFAULT_PAYMENT_METHODS`, etc.) que reutiliza el seed
  y los tests.
- `schemas.py` + `router.py`: ver endpoints en §2.

### 1.5 `app/audit/`

- `models.py`: `AuditLog`.
- `service.py`: `record_audit` — corre en un `SAVEPOINT` propio (no estaba en la
  firma del contrato, ver §4): si falla, se loguea con `logger.exception` y la
  escritura de negocio que la llamó sigue su curso.
- `router.py`: `GET /admin/audit`.

### 1.6 `app/notifications/`

- `models.py`: `Notification`, `NotificationRule`.
- `service.py`: `NOTIFICATION_TYPES`, `notify` (respeta la regla apagada,
  deduplica por día en hora de Bogotá).
- `router.py`: notificaciones y reglas.

### 1.7 Arranque, seed y migraciones

- `app/main.py`: `create_app()` registra handlers de error y descubre routers de
  `DOMAINS = ["auth","stores","catalog","shifts","audit","notifications"]` por
  `find_spec`; si existe `../frontend/dist`, sirve estático con fallback SPA
  (con guardia contra path traversal).
- `app/seed.py`: `python -m app.seed`, idempotente (chequea por el email del
  admin de demo), nunca se llama desde `main.py`. Crea organización perfil
  `standard`, sede con fiscal/cash/sales settings y UVT 2026, admin + supervisor
  + 4 operadores, 2 zonas × 4 mesas, y llama a
  `app.catalog.seed.seed_catalog(db, store)` por `find_spec` si existe.
- Alembic: `alembic.ini`, `alembic/env.py` (lee `DATABASE_URL`,
  `import_all_models()`, `render_as_batch` en SQLite, `compare_type=True`),
  `alembic/versions/0001_core.py` (`revision="0001"`, `down_revision=None`),
  16 tablas de los cinco dominios de este agente, DDL Postgres-first a mano con
  índice en cada FK y en cada columna de filtro, `UniqueConstraint`s explícitos.

### 1.8 `backend/tests/conftest.py`

Todas las fixtures del contrato: `client`, `db`, `org`, `store`, `store_b`/`org_b`,
`employees` (con los PIN conocidos: admin `9999`, supervisor `5555`, cashier
`1111`, operator `2222`/`3333`/`4444`), `admin_client`, `device_client`,
`identify`, `set_feature`, `clock`, `idem`. La decisión no trivial está en §4.2
(el mecanismo de aislamiento por request usa `SAVEPOINT`, no
commit/rollback de la sesión entera).

### 1.9 Tests propios

`tests/core` (errors, idempotency, money, tz, features, seed — 26 casos),
`tests/auth` (identity, authorize, employees — 21 casos), `tests/stores`
(isolation, fiscal, features_admin, settings, zones_tables — 22 casos),
`tests/audit_log` (3 casos), `tests/notifications` (5 casos). **74 tests, 0
fallas**; `python -m mypy app` limpio sobre los 46 archivos que hoy tiene
`app/` (incluye lo que ya escribieron `backend-caja` y `catalogo`).

### 1.10 CI, launch.json, AGENTS.md

- `.github/workflows/ci.yml`: dos jobs en serie — `backend` (servicio
  `postgres:16`, `pip install`, `mypy app`, `alembic upgrade head` contra
  Postgres, `pytest -q` suite completa) y `frontend` (`needs: backend`; `npm ci`,
  `npm run typecheck`, `npm run test -- --run`, `npm run build`).
- `.claude/launch.json`: comandos reales (`uvicorn app.main:app --reload --port
  8000` con `PYTHONPATH=.`, `DATABASE_URL`, `JWT_SECRET`, `ENV`; frontend
  `npm run dev -- --port 5173`), con notas sobre instalación/migración/seed
  previos.
- `AGENTS.md` § Verificación mínima: agregué los pasos de instalación,
  `alembic upgrade head` y `python -m app.seed` que faltaban antes de que
  existiera código; los comandos de pytest/mypy/uvicorn/npm que ya estaban
  seguían siendo correctos, no los cambié.
- `docs/ESTADO.md`: actualizado completo (Cómo corre / Qué está hecho / Dónde
  retomar), glosario intacto.

---

## 2. Endpoints expuestos (método y ruta, prefijo `/api/v1`)

### Auth & identidad (`app/auth/router.py`)
- `POST /auth/admin/login`
- `POST /auth/logout`
- `POST /auth/device/activate`
- `POST /auth/device/identify`
- `POST /auth/device/release`
- `POST /auth/device/deactivate`
- `GET /auth/me`
- `POST /auth/authorize`
- `GET /admin/employees`
- `POST /admin/employees`
- `PATCH /admin/employees/{employee_id}`
- `GET /admin/authorizations`

### Organización, funciones, sedes, zonas y mesas (`app/stores/router.py`)
- `GET /admin/organization`
- `PATCH /admin/organization`
- `GET /admin/features`
- `PUT /admin/features/{key}`
- `POST /admin/organization/profile`
- `GET /admin/stores`
- `POST /admin/stores`
- `PATCH /admin/stores/{store_id}`
- `POST /admin/stores/{store_id}/rotate-pin`
- `GET /admin/stores/{store_id}/fiscal`
- `PUT /admin/stores/{store_id}/fiscal`
- `GET /admin/stores/{store_id}/fiscal/history`
- `GET /admin/stores/{store_id}/cash-settings`
- `PUT /admin/stores/{store_id}/cash-settings`
- `GET /admin/stores/{store_id}/sales-settings`
- `PUT /admin/stores/{store_id}/sales-settings`
- `GET /admin/uvt`
- `PUT /admin/uvt`
- `GET /admin/zones` (query `store_id`)
- `POST /admin/zones` (query `store_id`)
- `PATCH /admin/zones/{zone_id}`
- `GET /admin/tables` (query `store_id`, admin)
- `POST /admin/tables`
- `PATCH /admin/tables/{table_id}`
- `GET /tables` (dispositivo; siempre `status: "free"` en 1a)

### Auditoría (`app/audit/router.py`)
- `GET /admin/audit` (query `from`, `to`, `entity`, `employee_id`)

### Notificaciones (`app/notifications/router.py`)
- `GET /admin/notifications` (query `store_id?`, `unread_only?`)
- `POST /admin/notifications/{notification_id}/read`
- `GET /admin/notification-rules` (query `store_id`)
- `PUT /admin/notification-rules` (query `store_id`)

Todo endpoint de lista acepta `?format=csv` (implementado con `wants_csv` +
`csv_response`).

---

## 3. Firmas compartidas: cómo quedaron

Transcribo tal como quedó en el código lo que el contrato interno §2 fijaba, para
que quien lo lea acá no tenga que abrir cada archivo. Donde me aparté, lo digo
en la lista y lo explico en §4.

- `app/core/config.py::settings` — igual al contrato.
- `app/core/db.py::Base, engine, SessionLocal, get_db()` — igual, **más**
  `UTCDateTime` (nuevo, no estaba pedido; ver §4.1).
- `app/core/clock.py::now_utc()/set_clock()` — igual.
- `app/core/tz.py::BOGOTA, to_bogota, business_date_for, today_business_date` — igual.
- `app/core/money.py::DENOMINATIONS, Denomination, sum_denominations, validate_denominations` — igual.
- `app/core/errors.py::AppError(code, message, status=400, extra=None)` y las
  cuatro subclases — igual (incluido el nombre de parámetro `status`, que
  sombrea el módulo `fastapi.status`: no lo usé dentro de la clase para evitar
  la confusión).
- `app/core/security.py` — igual, incluidas las constantes `COOKIE_ADMIN`/`COOKIE_DEVICE`.
- `app/core/idempotency.py::run_idempotent(db, *, organization_id, scope, key, request_hash, fn)` —
  misma firma; el **comportamiento interno** cambió (ver §4.2): un `AppError` de
  `fn()` se guarda como la respuesta resuelta (no queda "en curso").
- `app/core/csv.py::csv_response, wants_csv` — igual.
- `app/core/features.py::FEATURE_CATALOG, enabled_map, is_enabled, assert_feature, require_feature` — igual.
- `app/auth/models.py::Employee, DeviceSession, Authorization` — igual.
- `app/auth/deps.py::Actor, current_admin, current_device, current_operator, current_actor, admin_store` —
  igual, **más** `current_device_session` (agregado, ver §4.3) y, desde la
  iteración 2, `current_device` con la persona identificada opcional en el
  `Actor` (ver §8; no es un apartamiento del contrato, es la corrección de un
  bug reportado por el Conciliador).
- `app/auth/service.py::verify_authorizer, verify_pin` — igual, incluida la
  matriz `SUPERVISOR_ACTIONS = {"void_sent_item","courtesy","discount_over_limit"}`.
- `app/stores/models.py` — igual, con un cambio de forma en `UvtValue` (ver
  §4.4: quedó por organización, no global) y con **`sa.Enum(..., native_enum=False)`**
  en los campos de vocabulario fijo (`profile`, `person_type`, `regime`,
  `default_tax`, `role` de `Employee`, `level` de `Notification`/`NotificationRule`)
  en vez de `String` liso — más cerca todavía de "enums no nativos comparados
  por valor" porque en Python son directamente `str`, sin clase `enum.Enum` de
  por medio (ver §4.5).
- `app/stores/service.py::get_cash_settings, get_sales_settings, current_fiscal` — igual.
- `app/audit/service.py::record_audit(db, *, actor, organization_id, store_id, entity, entity_id, action, before, after, reason=None)` —
  misma firma; adentro corre en un `SAVEPOINT` (ver §4.6).
- `app/notifications/service.py::NOTIFICATION_TYPES, notify` — igual.
- `app/main.py::create_app(), DOMAINS` — igual (agregué el guardia contra path
  traversal al servir `frontend/dist`, no cambia la interfaz).
- `app/core/models_registry.py::import_all_models()` — igual, con
  `MODEL_MODULES` incluyendo `"core"` (el contrato no lo decía explícito, pero
  hacía falta para que `IdempotencyKey` se registre).

---

## 4. Dónde me aparté del contrato interno, y por qué

### 4.1 `app.core.db.UTCDateTime`

No estaba pedido. Hizo falta: SQLite, con `DateTime(timezone=True)` liso, guarda
la hora como texto y **al leerla devuelve un `datetime` *naive*** aunque se haya
guardado uno *aware* — es una trampa de SPEC-NEGOCIO §12 que no estaba en la
lista pero es de la misma familia. Comparar ese valor contra `clock.now_utc()`
(aware) tira `TypeError: can't compare offset-naive and offset-aware datetimes`.
Lo encontré en `GET /auth/me` comparando `employee_expires_at`. Solución: un
`TypeDecorator` que envuelve `DateTime(timezone=True)` y en
`process_result_value` le pone `tzinfo=UTC` si vuelve sin ella (en Postgres es
un paso neutro, ya vuelve *aware*). Lo usé en todos mis modelos
(`app/{core,auth,stores,audit,notifications}/models.py`).
**`app/shifts/models.py` (de `backend-caja`) todavía usa
`sa.DateTime(timezone=True)` sin este wrapper** — hoy no rompe porque sus tests
no comparan esos campos contra un aware directamente, pero es la misma trampa
esperando a activarse; lo dejé anotado en `docs/ESTADO.md` para que se corrija
antes de que un test de shifts compare `opened_at`/`closed_at` contra el reloj.

### 4.2 `run_idempotent`: un error de negocio también "resuelve" la clave

El contrato decía "clave reservada pero sin respuesta todavía → 409
IDEMPOTENCY_IN_PROGRESS". Tal como estaba, si `fn()` levantaba un `AppError` (p.
ej. `SHIFT_ALREADY_OPEN`), la fila de `idempotency_keys` se guardaba con
`response_status=None` para siempre (porque el `except` original hacía
`session.rollback()` sobre TODA la transacción, deshaciendo también la reserva)
**y además** todo reintento con la misma clave quedaba atrapado en
`409 IDEMPOTENCY_IN_PROGRESS` sin salida. Encontré esto mientras diagnosticaba
por qué el contador de intentos de PIN nunca subía (ver §4.3): la causa real era
más general que el PIN — es la política de `get_db` (ver abajo) la que lo
resuelve, y `run_idempotent` necesitó un ajuste a juego: cuando `fn()` levanta
`AppError`, guarda `(exc.status, exc.body())` como la respuesta resuelta y
**vuelve a levantar la misma excepción**. Un replay con la misma clave y el
mismo body ahora levanta el mismo `AppError` (no lo re-ejecuta, no se traba en
"en curso"). Esto es responsabilidad de `backend-caja` de tener en cuenta: sus
llamadas a `run_idempotent` en `shifts/open`, `shifts/{id}/close`,
`cash-movements`, `pickups`, `handovers` van a ver este comportamiento.

### 4.3 `app.core.db.get_db`: un `AppError` también hace `commit`

Este es el cambio de fondo, y el más importante para que lo lean los otros
cinco agentes. Lo necesité para el checklist «cinco intentos fallidos bloquean
15 minutos»: cada intento fallido de PIN incrementa un contador y hace
`db.flush()`, pero el endpoint **responde 400 PIN_INVALID** — es decir, levanta
`AppError` a propósito. Con la política original ("cualquier excepción →
rollback"), ese incremento se revertía en cada intento fallido y el contador
nunca llegaba a 5. La solución no es local a `verify_pin`: es de `get_db`,
porque ahí se decide qué sobrevive.

**Regla nueva, documentada en el docstring de `get_db` y en `docs/ESTADO.md`**:
`AppError` (una regla de negocio que decide responder 4xx a propósito) hace
`commit`; solo una excepción **no controlada** (la que se convierte en 500) hace
`rollback`. La consecuencia para todo servicio, del mío y de los demás: **hay
que validar todo lo que se pueda antes de escribir**. Si una función de service
hace `db.add()`/`db.flush()` de un paso, y **después** decide que la operación
completa hay que rechazarla con un `AppError`, ese primer paso va a quedar
commiteado igual. No encontré ningún caso así en mi propio código (todos mis
routers validan antes de escribir), pero no pude revisar `app/shifts/**` ni
`app/catalog/**` a fondo — lo marco como gap en §5.2.

### 4.4 `UvtValue` por organización, no global

El contrato no fijaba si la tabla UVT es global o por organización. La spec de
negocio habla de "tabla de UVT por año" en el contexto de configuración fiscal
de sede, y el valor real es el mismo para todo el país — pero un despliegue
multi-organización (SPEC-NEGOCIO §1.1, "modo servicio") no debería dejar que el
admin de una organización cambie lo que ve otra. Decisión: `UvtValue(id,
organization_id, year, value)` con `UniqueConstraint(organization_id, year)`,
en vez de `UvtValue(year PK, value)` global. `GET/PUT /admin/uvt` quedan
acotados por organización como todo lo demás.

### 4.5 Enums como `sa.Enum(*valores, native_enum=False)`, sin clase Python

El contrato pide "Enums: `sa.Enum(..., native_enum=False, length=32)` y
comparar por valor". Lo interpreté al pie de la letra sin sumarle una clase
`enum.Enum` de Python: `Mapped[str] = mapped_column(sa.Enum("basic","standard",
"full", native_enum=False, length=16))`. El resultado en Python es un `str`
liso — no hay "identidad de enum" que comparar mal contra un valor venido de
CSV o de otro proceso: la guardia queda satisfecha por construcción, no por
disciplina. Lo usé en `Organization.profile`, `StoreFiscalConfig.{person_type,
regime,default_tax}`, `Employee.role`, `Notification.level`,
`NotificationRule.level`.

### 4.6 `record_audit` corre en un `SAVEPOINT` propio

El contrato dice "si falla, log.error, NUNCA levanta". Un `try/except` sin
`rollback` alrededor de un `db.flush()` que falla deja la sesión en estado
"transacción abortada": cualquier uso posterior de esa sesión en el mismo
request (por ejemplo, el `commit()` final de `get_db`) tira
`PendingRollbackError`. Envolví el cuerpo de `record_audit` en
`with db.begin_nested():` — si el `flush` de la auditoría falla, sólo se
revierte ese `SAVEPOINT` (la fila de auditoría), no la escritura de negocio que
la llamó, que sigue intacta y puede seguir su commit normal.

### 4.7 `current_device_session` (agregado en `app/auth/deps.py`)

No nombrado en el contrato. `current_device` devuelve un `Actor` (de solo
lectura); `identify`/`release`/`deactivate` necesitan mutar la fila real de
`DeviceSession` (bindear el empleado, revocar, limpiar). Agregué
`current_device_session(request, db) -> DeviceSession` con la misma lógica de
`current_device` pero devolviendo el modelo. No reemplaza nada del contrato,
solo lo completa.

---

## 5. Cómo se corre todo

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt   # ya lo corrí yo

# esquema (mi 0001 se verificó aislado — ver nota — ya que 0002/0003 de otros
# agentes todavía no formaban una cadena completa al momento de este corte)
DATABASE_URL=sqlite:////tmp/algún-dir/mig.db alembic upgrade head

python -m app.seed          # datos de ejemplo, aparte, idempotente
uvicorn app.main:app --reload --port 8000   # PYTHONPATH=. si no corrés desde backend/

# mi verificación (territorio, no la suite completa)
TMPDIR=/tmp/pt-backend-core python -m pytest tests/core tests/auth tests/stores tests/audit_log tests/notifications -q
python -m mypy app
```

**Nota sobre `alembic upgrade head`**: al momento de este corte,
`alembic/versions/0003_shifts.py` (de `backend-caja`) ya existía con
`down_revision="0002"`, pero `0002_catalog.py` (de `catalogo`) todavía no. Un
`alembic upgrade head` corrido sobre el árbol completo en ese estado falla con
`KeyError: '0002'` — **no es un bug de mi migración**: Alembic construye el mapa
de revisiones leyendo TODO `alembic/versions/`, así que una cadena incompleta
rompe la resolución aunque se pida un target puntual (`upgrade 0001`). Verifiqué
la mía copiando `alembic.ini` + `env.py` + solo `0001_core.py` a un directorio
aparte (`/tmp/pt-backend-core/alembic_check/`, `script_location` apuntando ahí)
y corriendo `alembic upgrade head` con `PYTHONPATH` a `backend/` real: las 16
tablas se crean, `alembic_version` queda en `"0001"`. La verificación de la
cadena completa (`0001→0002→0003`) le corresponde a la entrega final del
Maestro, cuando `catalogo` termine `0002_catalog.py`.

---

## 6. Lo que no llegué a hacer

- No escribí ningún router, modelo ni test de `catalog` ni de `shifts` — no es
  mi territorio.
- No corrí la suite completa (`pytest -q` sin filtrar) ni `npm run build`: eso
  es exclusivamente el paso final del Maestro, por instrucción explícita.
- No pude confirmar en runtime que `app.shifts.service.on_employee_identified`
  y `app.shifts.hooks.get_sales_totals` tengan exactamente la firma que
  `identify` (mi código) y el resto esperan, más allá de que hoy
  `find_spec("app.shifts.service")` encuentra el módulo y mi test de identify
  pasa sin invocar ese hook (porque los fixtures de mis tests no abren turno).
  Backend-caja reporta en su output que implementó
  `on_employee_identified(db, *, store_id, employee)` — coincide con lo que mi
  código llama, pero no tengo un test de integración cruzado que lo ejercite
  end-to-end (necesitaría un turno abierto, que es su territorio).
- No verifiqué `GET /admin/employees/{id}/activity` (es explícitamente de
  `backend-caja` por instrucción del Maestro) ni ninguna otra ruta de `/shifts`
  o `/catalog`.

## 7. Gaps (dependencias de otros agentes y ambigüedades de la spec)

1. **`alembic/versions/0002_catalog.py` no existe todavía** (§5): la cadena de
   migraciones completa no resuelve hasta que `catalogo` la publique. No
   requiere ninguna acción mía; lo deja anotado `docs/ESTADO.md`.
2. **`app/shifts/models.py` usa `sa.DateTime(timezone=True)` sin
   `UTCDateTime`** (§4.1): funciona hoy, pero es la misma trampa de SQLite
   esperando a que un test de `shifts` compare uno de esos campos contra
   `clock.now_utc()`. Se lo dejo anotado a `backend-caja` vía `docs/ESTADO.md`
   (no toqué su archivo).
3. **La política nueva de `get_db`/`run_idempotent` (§4.2, §4.3) afecta a
   `backend-caja` directamente**: sus servicios de turno (`shifts/open`,
   `close`, `cash-movements`, `pickups`, `handovers`) usan `Idempotency-Key` y
   deberían validar todo antes de escribir para no dejar writes parciales
   commiteados en un 4xx. Por lo que pude ver en su output, sus servicios
   arman el objeto completo y lo validan antes de `db.add()`, así que en
   principio no debería haber un caso afectado — pero no lo pude confirmar
   línea por línea porque `app/shifts/**` no es mi territorio para leer en
   detalle más allá de lo que su propio output describe.
4. **`multi_store` no gatea `GET /admin/stores`**, a propósito: la spec dice
   "GET /admin/stores lista todas las sedes de la org, pero con multi_store
   apagado el selector no aplica" — interpreté que "el selector" es un asunto
   de interfaz (el frontend no muestra el selector de sede), no del backend
   (que sigue devolviendo la lista completa siempre). Si el Maestro quería que
   el backend también la acotara a una sola sede con el flag apagado, es un
   cambio de una línea en `list_stores`.
5. **`declared_not_obliged_by`** en `Organization` quedó como `str | None` (un
   nombre, no un `employee_id` con FK): el contrato lo nombra sin tipo. Elegí
   texto simple porque es un campo de fase 1b/2 (SPEC-NEGOCIO §8.3) que en 1a
   no tiene endpoint que lo escriba; si en 1b se quiere atribución con FK real
   (como pide AGENTS.md para toda escritura de una persona), hay que migrarlo.
6. **`GET /admin/audit?employee_id=`** filtra por **quién hizo el cambio**
   (`actor_employee_id`), no por la entidad afectada — es la lectura que hace
   más sentido para un filtro reusable a través de todos los tipos de entidad
   (store, feature, employee, zone...). Si el Maestro esperaba filtrar por "los
   cambios que le pasaron a este empleado como entidad", hace falta un segundo
   parámetro (`entity_id`) — no estaba en el contrato ni en la spec de forma
   explícita.
7. **PIN de autorización sin límite de intentos propio**: `verify_authorizer`
   (usado por `POST /auth/authorize` y por "todo endpoint privilegiado que
   acepta `authorizer_pin`") no incrementa `failed_pin_attempts` cuando el PIN
   no matchea contra ningún supervisor/admin, porque no sabe a quién
   atribuirle el fallo hasta encontrar el match. Esto significa que
   `/auth/authorize` no tiene su propio freno de fuerza bruta más allá del que
   ya tiene `verify_pin` para `identify`. No está en el checklist del pedido
   1a; lo dejo anotado para que se evalúe si hace falta en una fase futura.
8. **`courtesy_shift_limit`** lo modelé como cantidad de cortesías por turno
   (`Integer`), no como monto en pesos — la spec dice "Límite por turno
   (`courtesy_shift_limit`) → alerta" sin aclarar la unidad. Si el Maestro
   quería un límite en pesos, es un cambio de tipo de columna (haría falta una
   migración nueva, no tocar `0001` una vez que otros agentes ya migraron
   sobre ella).
9. **`app/catalog/service.py` tiene 5 errores de mypy** al momento de este
   corte final (`ComboGroupIn` sin `.id`, una asignación `ComboOption`/
   `ModifierOption` incompatible, atributos `active_today`/`available_today`
   que no existen en `ModifierOption`) — no los toqué, es territorio de
   `catalogo` y todavía está en construcción; los reporto para que no se
   pierdan, no los arreglo. `python -m mypy app` sobre el árbol completo hoy
   sale en rojo por esto, aunque los 47 archivos de mi propio territorio
   (`core`, `auth`, `stores`, `audit`, `notifications`, `main.py`, `seed.py`)
   están limpios.
10. **Alcance de `require_feature`**: quedó implementado y probado (unitario),
   pero **ningún endpoint de mi territorio lo usa como dependencia** — de los
   doce flags que el pedido 1a lista como "todo lo demás detrás de su flag"
   (`cash.*`, `roles.supervisor`, `pos.modifiers`, `pos.combos`,
   `pos.daily_menu`, `pos.daily_count`, `multi_store`), los de `cash.*` son de
   `backend-caja` y los de `pos.*` de `catalogo`; `roles.supervisor` lo hice
   cumplir como regla de negocio dentro de `verify_authorizer` (más preciso que
   un gate de endpoint, porque depende de qué PIN matcheó) y `multi_store` es
   un asunto de interfaz (ver punto 4). Lo marco para que el Maestro confirme
   que la lectura es correcta.

---

## 8. Iteración 2 (ajuste del Maestro, derivado del Conciliador) — B-2b

**El bug**: `current_device` (`app/auth/deps.py`) devolvía siempre
`Actor(employee_id=None, employee_name=None, role=None)`, incluso cuando la
sesión del dispositivo tenía una persona ligada y vigente. `GET
/shifts/current` y `POST /shifts/{id}/roster` (territorio de `backend-caja`)
dependen de `current_device`, así que el responsable de caja nunca veía
`expected_cash` — el contrato de API 1a dice explícitamente "only for admin or
the cash responsible". El invariante del auditor
`test_expected_cash_is_visible_to_the_cash_responsible` (en
`tests/audit/test_cash_invariants.py`, territorio de `backend-audit`, no mío)
fallaba por esta causa.

### 8.1 La semántica nueva (queda fijada, no es una interpretación mía)

- **`current_device`** = dispositivo activado, punto. La persona identificada
  es **opcional**: si la sesión tiene una vigente, el `Actor` trae
  `employee_id`/`employee_name`/`role`; si no, quedan en `None`. Nunca lanza
  por falta de persona (sigue lanzando 401 `DEVICE_NOT_ACTIVATED` si falta la
  cookie de dispositivo, igual que antes).
- **`current_operator`** = persona **obligatoria** y vigente. 401
  `IDENTIFY_REQUIRED` si no la hay. Sigue siendo el único que renueva
  `employee_expires_at` (ventana deslizante).
- **Por qué `current_device` no renueva**: `GET /shifts/current` se consulta
  por *polling* desde el POS. Si `current_device` también renovara la ventana
  de inactividad de la persona, cada poll extendería la sesión de quien esté
  identificado indefinidamente — la expiración por inactividad dejaría de
  significar algo. La renovación queda exclusivamente en `current_operator`,
  que es lo que se usa para acciones activas de esa persona (abrir turno,
  mover caja, etc.).

### 8.2 Cómo quedó implementado

Extraje el helper privado `_bound_employee(db, session, now) -> Employee |
None` (nuevo en `app/auth/deps.py`, no estaba en el contrato interno — sigue
el mismo patrón que ya tenía `current_device_session` de §4.7: una pieza
compartida entre las dos dependencias que antes tenían la lógica duplicada).
Devuelve el empleado sólo si `session.employee_id` no es `None`,
`session.employee_expires_at` existe y es `> now`, y el empleado existe y está
`active`; en cualquier otro caso `None`. No lanza y no muta la fila (es una
lectura pura).

`current_device` ahora llama a `_bound_employee` con `clock.now_utc()` y
puebla el `Actor` con lo que devuelva (o `None` en los tres campos si
devuelve `None`). `current_operator` usa el mismo helper para decidir si hay
persona vigente, y si la hay, sigue con su comportamiento de siempre: renovar
`session.employee_expires_at = now + timedelta(minutes=EMPLOYEE_SESSION_MINUTES)`
y `db.flush()`.

Los otros dos consumidores de `current_device` que no son de mi territorio
(`app/catalog/router.py::_catalog_read_actor` y
`app/stores/router.py::device_tables`) no cambian de comportamiento: ninguno
de los dos leía `employee_id`/`employee_name`/`role` del `Actor`, así que sólo
ganan campos opcionales que antes tampoco existían con un valor útil.

### 8.3 Tests nuevos (`backend/tests/auth/test_identity.py`)

Agregué cuatro tests, contra `current_device` llamada directo (con un
`_FakeRequest` que sólo duck-tipea `.cookies`, ya que la dependencia sólo lee
`request.cookies.get(...)`) para poder inspeccionar el `Actor` en vez del JSON
de un endpoint:

1. `test_current_device_without_identified_person_has_no_employee` — (a) del
   enunciado: dispositivo activado sin persona → `Actor` con `employee_id`
   `None`, sin error.
2. `test_current_device_after_identify_carries_employee_fields` — (b):
   después de `POST /auth/device/identify` → `Actor` con `employee_id`,
   `employee_name` y `role` del empleado identificado.
3. `test_current_device_after_employee_session_expires_reverts_to_none` — (c):
   con `clock.advance(minutes=EMPLOYEE_SESSION_MINUTES + 1)` → vuelve a
   `None` en los tres campos, sin lanzar.
4. `test_current_device_does_not_renew_employee_expiration` — (d): una
   llamada a `current_device` no cambia `employee_expires_at` (lo leo de la
   fila `DeviceSession` real, vía `db.get` + `read_token` sobre la cookie del
   `TestClient`, antes y después de la llamada).

### 8.4 Verificación

```bash
cd backend
TMPDIR=/tmp/pt-backend-core python -m pytest tests/auth -q          # 78→ incluye los 4 nuevos, 12 en test_identity.py, todos verdes
TMPDIR=/tmp/pt-backend-core python -m pytest tests/auth tests/audit/test_cash_invariants.py \
  -q -k 'visible_to_the_cash_responsible or hidden_from_an_operator'  # 2 passed
python -m mypy app                                                   # Success: no issues found in 49 source files
```

No toqué `app/shifts/*` ni ningún otro archivo fuera de `app/auth/deps.py` y
`tests/auth/test_identity.py`. No hay gaps nuevos de esta corrección: el
comportamiento quedó exactamente como lo pidió el ajuste, verificado con los
tests propios y con el invariante del auditor que reportaba el fallo.
