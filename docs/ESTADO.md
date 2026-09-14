# Restaurante Sistema — estado del proyecto

Documento de referencia para retomar el trabajo sin reconstruir el contexto.
Última actualización: 2026-09-14 (pedido 1a en construcción: cimientos del backend
—organización, funciones, identidad, sedes, auditoría y notificaciones— entregados
por `backend-core`; turno de caja por `backend-caja`; carta y frontend en curso por
el resto del equipo).

**Este documento es VIVO.** Si un cambio altera una regla o un flujo descrito acá,
se actualiza en el MISMO PR que el cambio. Un estado desactualizado miente con más
autoridad que no tener estado.

---

## Cómo corre

El backend ya existe y corre. El frontend todavía no (lo construyen `frontend-core`,
`frontend-caja` y `catalogo` en este mismo pedido); cuando exista, se arranca con
`.claude/launch.json` (ya ajustado a estos comandos reales).

```bash
# instalación (una sola vez; sin venv, tal como pide CONTRATO-INTERNO §1)
cd backend
pip install -r requirements.txt -r requirements-dev.txt

# esquema (Alembic desde el primer commit — nunca create_all en producción)
alembic upgrade head

# datos de ejemplo — un comando aparte, nunca al arrancar; corre dos veces sin duplicar nada
python -m app.seed

# arranque
PYTHONPATH=. DATABASE_URL=sqlite:///./dev.db uvicorn app.main:app --reload --port 8000
# /docs sirve el OpenAPI; si existe ../frontend/dist, main.py lo sirve con fallback SPA

# frontend (cuando exista)
cd frontend
npm install
npm run dev -- --port 5173   # proxea /api -> :8000 (mismo origen; ver vite.config.ts)
```

| Servicio | Directorio | Comando | Puerto |
|---|---|---|---|
| backend | `backend/` | `uvicorn app.main:app --reload --port 8000` | 8000 |
| frontend | `frontend/` | `npm run dev -- --port 5173` | 5173 |

Variables de entorno (ver `backend/app/core/config.py`): `DATABASE_URL` (default
`sqlite:///./dev.db`), `JWT_SECRET`, `ENV` (`dev`\|`test`\|`production`),
`EMPLOYEE_SESSION_MINUTES` (default 3), `PIN_LOCK_ATTEMPTS` (5), `PIN_LOCK_MINUTES`
(15), `DEVICE_SESSION_DAYS` (180), `ADMIN_SESSION_HOURS` (12). El PIN de sede y el
PIN/contraseña de cada persona se configuran desde la app (seed o Admin), no por
variable de entorno. Ninguna credencial va al repo. `TZ` no aplica: la hora de
Bogotá se calcula siempre con `app/core/tz.py`, nunca con la zona del sistema.

**Seed de desarrollo** (`python -m app.seed`, idempotente): una organización perfil
`standard`, una sede con fiscal vigente (natural, ordinario, INC 8 %, precios con
impuesto), PIN de sede `1234`, UVT 2026 = 52.374, admin `admin@demo.local` /
`cambiar` (PIN POS `9000`), supervisor (PIN `5001`), cuatro operadores (PIN `6001`
a `6004`; `6001` puede cobrar), dos zonas ("Salón", "Terraza") con cuatro mesas
cada una. Si existe `app.catalog.seed.seed_catalog`, también carga la carta (lo
hace `catalogo`; ver su output). Imprime todos los PIN por consola al correr.

## Reglas duras

Las decisiones que no se renegocian están en `docs/SPEC-NEGOCIO.md § 11`. Las que
más fácil se rompen sin que se vea en pantalla:

- **Gates en el backend, no en la UI**: sin turno abierto no hay venta; sin
  justificación no cierra un turno con diferencia; anular un ítem enviado o una
  venta cobrada exige motivo y PIN de administrador.
- **Snapshot en el ítem**: precio, impuesto, costo teórico y receta usada se
  congelan al vender. Los reportes nunca revaloran ventas pasadas con la carta
  actual.
- **Un solo descuento de insumo**: al producir la preparación o al enviar el plato,
  nunca ambos.
- **Fecha operativa de negocio** (`America/Bogota`) en columna propia; nunca
  derivada de un timestamp UTC.
- **Nada financiero ni de inventario se borra**: baja lógica + auditoría.
- **Propina separada** de la venta y del impuesto.
- **Sesión en cookie `httpOnly`**; nada sensible en `localStorage`.
- **Cobro, envío y producción idempotentes** (`Idempotency-Key` reservada dentro de
  la transacción) y `409` ante concurrencia.
- **La reserva de caja se declara aparte** y no entra al esperado (Palmetto, 15-ago
  en la referencia).
- **Una sola matemática en el backend**; el frontend no deriva plata; `null` ≠ 0.
- **Causa tipada** en movimientos de caja e inventario.
- **Atribución con FK real** (`employee_id`) más nombre congelado; empleados nunca
  se borran.
- **Producto para varios restaurantes**: organización → sede; toda función opcional
  detrás de su flag, exigido por el backend; lo legal y la integridad no se apagan.

## Glosario español ↔ código

La UI habla español y el código inglés. Para que nadie invente un tercer nombre:

| En la UI / en los docs | En el código |
|---|---|
| organización (el cliente) | `organization` |
| sede | `store` |
| función habilitable / perfil | `feature` / `profile` (`basic`, `standard`, `full`) |
| venta de mostrador | `counter` (canal) |
| día operativo | `business_day` |
| turno de caja | `shift` |
| empleado / operador | `employee` (rol `operator`), `admin` |
| mesa / zona | `table` / `zone` |
| comanda | `order` |
| ítem de comanda | `order_item` |
| canal (mesa, para llevar, domicilio) | `channel` (`dine_in`, `takeout`, `delivery`) |
| cobro / pago | `payment` |
| propina | `tip` |
| tiquete | `ticket` |
| nota crédito | `credit_note` |
| insumo | `ingredient` |
| preparación / lote | `prep` / `prep_batch` |
| plato / producto | `product` |
| ficha técnica (receta) | `recipe` |
| modificador | `modifier_group` / `modifier_option` |
| combo | `combo` |
| movimiento de inventario | `stock_movement` |
| merma | `waste` |
| conteo | `stock_count` |
| recepción de compra | `purchase_receipt` |
| cuenta por pagar | `payable` |
| movimiento de caja | `cash_movement` |
| retiro de efectivo | `cash_pickup` |
| relevo (cuadre sin cerrar) | `shift_handover` |
| reserva de caja | `cash_reserve` |
| hora de corte | `cutoff_hour` |
| rescate (cierre administrativo, reabrir, cancelar, ajustar apertura) | `admin_rescue` (`close_administrative`, `reopen`, `cancel`, `adjust_opening`) |
| estación de cocina | `station` |
| curso (bebida, entrada, fuerte, postre) | `course` |
| ronda (envío a cocina) | `round` |
| cuenta presentada / precuenta | `bill_presented_at` / `pre_bill` |
| sub-cuenta (división) | `sub_account` |
| documento fiscal (equivalente POS, factura, nota) | `fiscal_document` (`pos_equivalent`, `invoice`, `adjustment_note`, `credit_note`) |
| rango de numeración DIAN | `fiscal_range` |
| adquirente / cliente | `customer` |
| consumo de personal | `staff_meal` (canal de comanda) |
| cambio (sencilla) | `cash_swap` |
| arqueo sorpresa | `spot_check` (tipo de `shift_handover`) |
| responsable de caja | `cash_responsible` |
| supervisor / encargado | `supervisor` |
| devolución pendiente | `pending_refund` |
| base fija | `opening_cash_fixed` |
| causa de un movimiento | `cause` |
| proveedor | `supplier` |
| lote | `stock_batch` |
| consignación | `bank_deposit` |

## Qué está hecho

- **Adopción del framework** (2026-09-14): `.claude/` copiado desde
  sistemas-maestros 2.0.0 con `scripts/adoptar.sh`; versión estampada en
  `.claude/FRAMEWORK`.
- **Spec de negocio** en `docs/SPEC-NEGOCIO.md`, versión 0.4 (**aprobada** con los
  defaults de la sección 15 y el requisito de funciones habilitables), escrita sobre la
  lectura por subsistema del proyecto de referencia `cafe-sistema` (caja y turnos,
  inventario y recetas, POS, plata y admin, lecciones del go-live), tres
  investigaciones de dominio (fiscal y legal, operación de piso y cocina, control
  interno) y un crítico de completitud que verificó las afirmaciones dudosas contra
  el código de la referencia.
- **Specs de los pedidos 1a y 1b** en `features/fase-1a-cimientos/spec.md` y
  `features/fase-1b-venta/spec.md`, con el contrato de API para que backend y
  frontend construyan en paralelo contra lo mismo.
- **AGENTS.md** con lo que este proyecto se aparta del framework: régimen fiscal
  colombiano, PIN personal sobre dispositivo compartido, fecha operativa en Bogotá.
- **Pedido 1a en construcción** (equipo de seis agentes en paralelo sobre
  `features/fase-1a-cimientos/CONTRATO-INTERNO.md`). Por agente, lo que este
  documento puede verificar hoy:
  - **`backend-core`** (este agente) — cimientos comunes y los dominios `core`,
    `auth`, `stores`, `audit`, `notifications` completos:
    - `app/core/`: `config`, `db` (con `UTCDateTime`, un `TypeDecorator` que evita
      la trampa de SQLite de devolver datetimes *naive* — ver Patrón nuevo más
      abajo), `clock`, `tz`, `money`, `errors` (+ handlers), `security`
      (bcrypt + PyJWT + cookies `httpOnly`), `idempotency` (reserva dentro de la
      transacción, replay, `IDEMPOTENCY_MISMATCH`/`IN_PROGRESS`), `csv`,
      `features` (`FEATURE_CATALOG` completo de SPEC-NEGOCIO §1.2, 41 claves con
      sus defaults por perfil, `requires` y `available_from_phase`;
      `enabled_map`/`is_enabled`/`assert_feature`/`require_feature`),
      `models_registry` (descubre `models.py` de cada dominio con `find_spec`).
    - `app/auth/`: `Employee` (incluye al admin), `DeviceSession`, `Authorization`;
      `deps.py` (`Actor`, `current_admin`, `current_device`, `current_operator`,
      `current_actor`, `admin_store`); `service.py` (`verify_pin` con bloqueo de 5
      intentos / 15 min y notificación `pin_locked`; `verify_authorizer` con la
      matriz supervisor/admin); router con login admin, activar/identificar/
      liberar/desactivar dispositivo, `/auth/me`, `/auth/authorize`, CRUD de
      empleados (PIN nunca devuelto, baja lógica) y `/admin/authorizations`.
      **Semántica de `current_device` vs. `current_operator` (fijada en la
      iteración 2, corrección B-2b)**: `current_device` = dispositivo
      activado, punto — la persona identificada es **opcional**: si la sesión
      tiene una vigente, el `Actor` trae `employee_id`/`employee_name`/`role`;
      si no, quedan en `None`, y nunca lanza por esa ausencia. `current_operator`
      = persona **obligatoria** y vigente (401 `IDENTIFY_REQUIRED` si no la
      hay) y es el **único** que renueva `employee_expires_at` (ventana
      deslizante) — `current_device` no renueva, porque se consulta por
      *polling* (`GET /shifts/current`) y renovar ahí extendería la sesión de
      la persona indefinidamente. Antes de esta corrección, `current_device`
      devolvía siempre `employee_id=None`, por lo que el responsable de caja
      nunca veía `expected_cash` en `GET /shifts/current`/`POST
      /shifts/{id}/roster` (territorio `backend-caja`); el helper privado
      `_bound_employee(db, session, now)` centraliza ahora la comprobación de
      vigencia para las dos dependencias. Detalle completo y tests en
      `features/fase-1a-cimientos/outputs/backend-core.md` §8.
    - `app/stores/`: `Organization`, `Store`, `StoreFiscalConfig` (versionado por
      `valid_from`), `StoreCashSettings`, `StoreSalesSettings`, `UvtValue` (por
      organización), `Zone`, `Table`, `FeatureState`; router con organización y
      funciones (`GET/PATCH /admin/organization`, `GET/PUT /admin/features`,
      `POST /admin/organization/profile`), CRUD de sedes + fiscal + cash/sales
      settings + UVT + rotar PIN, zonas y mesas, y `GET /tables` de dispositivo
      (siempre `free` en 1a).
    - `app/audit/`: `AuditLog` + `record_audit` (SAVEPOINT propio: si falla, se
      loguea y la escritura que la llamó sigue) + `GET /admin/audit`.
    - `app/notifications/`: `Notification` + `NotificationRule` + `notify`
      (respeta la regla apagada, deduplica por día) + endpoints de campana y
      reglas.
    - `app/main.py` (descubre routers por `find_spec`, sirve `../frontend/dist`
      con fallback SPA), `app/seed.py` (`python -m app.seed`, idempotente, nunca
      al arrancar), Alembic (`alembic.ini`, `env.py`, `0001_core.py` con las 16
      tablas de estos cinco dominios).
    - Tests propios (`tests/core`, `tests/auth`, `tests/stores`, `tests/audit_log`,
      `tests/notifications`, 74 casos) y `tests/conftest.py` con **todas** las
      fixtures del contrato.
    - Detalle completo, endpoints uno por uno y gaps en
      `features/fase-1a-cimientos/outputs/backend-core.md`.
  - **`backend-caja`** — `app/shifts/**` (día operativo y turno de caja completos:
    apertura, roster, movimientos, cambio, retiros, relevo/arqueo, cierre a ciegas
    en tres pasos, rescates) y `alembic/versions/0003_shifts.py`. Detalle en
    `features/fase-1a-cimientos/outputs/backend-caja.md` (no verificado por este
    agente más allá de que `app/shifts/**` importa y el typecheck combinado de
    `app/` sigue limpio).
  - **`catalogo`** — `app/catalog/models.py` y `app/catalog/schemas.py` existen
    (250 y 271 líneas); a la fecha de este corte todavía **no** existen
    `app/catalog/router.py`, `app/catalog/seed.py` ni
    `alembic/versions/0002_catalog.py` — ver su propio output cuando lo publique.
  - **`frontend-core`, `frontend-caja`, `auditor-control`** — `frontend/` todavía
    no existe en este corte; ver sus outputs cuando los publiquen.
- **Patrón nuevo (no estaba en el contrato interno, documentado para que lo usen
  todos)**: `app.core.db.UTCDateTime` — usar este tipo (no `DateTime(timezone=True)`
  a secas) en todo `Mapped[datetime]` de cualquier dominio; en SQLite,
  `DateTime(timezone=True)` devuelve *naive* al leer, y compararlo contra
  `clock.now_utc()` (aware) tira `TypeError`. `app/shifts/models.py` todavía usa
  `sa.DateTime(timezone=True)` sin este wrapper — funciona hoy porque sus tests no
  comparan esos campos contra un `datetime` aware directamente, pero conviene
  migrarlo antes de que sí lo hagan.
- **Decisión de `get_db` que todo servicio nuevo tiene que conocer**: un `AppError`
  (400/404/409 de negocio) hace **commit**, no rollback — si no, un contador de
  intentos fallidos (PIN) nunca se guarda porque cada intento se revierte a sí
  mismo. Consecuencia: **todo servicio valida antes de escribir**; para cuando se
  hace `db.add()`/`db.flush()`, la operación ya está decidida y lo que se
  escriba tiene que sobrevivir aunque el request termine en 4xx.

## Dónde retomar

1. Spec aprobada el 2026-09-14 con los defaults; repositorio `Bryreg/restaurante-sistema`.
2. El pedido 1a está en construcción (seis agentes en paralelo). Falta terminar
   `catalogo` (router, seed, migración `0002`) y todo el `frontend/`
   (`frontend-core`, `frontend-caja`); `auditor-control` corre al final sobre lo
   que quede. Cuando el Maestro corra la verificación final (suite completa,
   `alembic upgrade head` contra el árbol entero, `npm run build`), va a
   necesitar que `0002_catalog.py` exista para que la cadena `0001→0002→0003`
   resuelva (hoy `0003_shifts.py` referencia un `0002` que todavía no está).
3. **Lanzar el pedido 1b** sobre lo entregado por 1a cuando el equipo termine y
   se concilie:
   ```js
   Workflow({
     scriptPath: '.claude/workflows/orquestador-general.js',
     args: {
       pedido: '<el pedido 1b, sección 14 de la spec>',
       spec: 'features/fase-1b-venta/spec.md',
       outputs: 'features/fase-1b-venta/outputs',
       contexto: ['docs/ESTADO.md', 'AGENTS.md', 'docs/SPEC-NEGOCIO.md'],
     },
   })
   ```
4. Antes de lanzar 1b conviene mirar los gaps de
   `features/fase-1a-cimientos/outputs/backend-core.md` (ambigüedades de la spec
   resueltas con una interpretación propia: `multi_store` no gatea
   `GET /admin/stores` a propósito, `UvtValue` quedó por organización en vez de
   global, `employee_id` en `GET /admin/audit` filtra por autorizador no por
   entidad afectada, entre otras).
