# Restaurante Sistema — estado del proyecto

Documento de referencia para retomar el trabajo sin reconstruir el contexto.
Última actualización: 2026-09-14 (pedido 1a entregado y verificado; framework 2.1.0).

**Este documento es VIVO.** Si un cambio altera una regla o un flujo descrito acá,
se actualiza en el MISMO PR que el cambio. Un estado desactualizado miente con más
autoridad que no tener estado.

---

## Cómo corre

Backend y frontend existen y corren; `.claude/launch.json` está ajustado a estos
comandos reales. En desarrollo el backend usa SQLite y el frontend proxea `/api`
al backend (mismo origen, cookies `httpOnly`); en producción el backend sirve
`frontend/dist` con fallback SPA.

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

# frontend
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

- **Adopción del framework** (2026-09-14): sistemas-maestros 2.0.0 con
  `scripts/adoptar.sh`; actualizado a **2.1.0** el mismo día (`args.base` del
  orquestador, promovido desde este proyecto). Versión en `.claude/FRAMEWORK`.
- **Spec de negocio** `docs/SPEC-NEGOCIO.md` v0.4, **aprobada** con los defaults de la
  sección 15 y el requisito de producto comercializable (organización → sede,
  funciones habilitables por flag, perfiles `basic`/`standard`/`full`).
- **Specs de los pedidos** `features/fase-1a-cimientos/spec.md` (entregado) y
  `features/fase-1b-venta/spec.md` (siguiente), con contrato de API.
- **Pedido 1a entregado** (orquestador, dos rondas, veredicto del Conciliador
  **coherente**; entrega del Maestro en `features/fase-1a-cimientos/outputs/ENTREGA.md`,
  outputs por agente en el mismo directorio, contrato interno del equipo en
  `features/fase-1a-cimientos/CONTRATO-INTERNO.md`). Equipo: `backend-core`,
  `backend-caja`, `catalogo` (rol nuevo, full-stack), `frontend-core`,
  `frontend-caja`, `auditor-control` (opus, 58 invariantes ejecutables en
  `backend/tests/audit/` y `frontend/src/audit/`).
  - **Backend** (`backend/app/`): `core` (config, `UTCDateTime`, reloj, tz, dinero,
    errores de una sola forma, seguridad con cookies `httpOnly`, idempotencia,
    catálogo de 41 funciones con perfiles y `require_feature`), `auth` (empleados,
    sesión de dispositivo, PIN con bloqueo, autorizaciones supervisor/admin),
    `stores` (organización, sedes, fiscal con vigencia, ajustes de caja y ventas,
    UVT, zonas, mesas, flags con override por sede), `audit`, `notifications`,
    `catalog` (carta plana: categorías, productos con precio por canal y tasa,
    modificadores, combos y menú del día con franjas, agotados y contador; sin
    campos de costo), `shifts` (día operativo con hora de corte y `closes_day`,
    turno con base fija y reserva aparte, roster, movimientos con causa, cambio
    neto cero, retiros con snapshot, relevo y arqueo sorpresa, cierre a ciegas en
    tres pasos, cierre en un paso cuando `cash.blind_close` está apagada, rescates
    de admin, actividad por persona). Alembic `0001 → 0002 → 0003` (31 tablas),
    `python -m app.seed` aparte e idempotente, CI en `.github/workflows/ci.yml`
    (Postgres 16; backend y frontend en serie).
  - **Frontend** (`frontend/src/`): Vite + React 19 + TypeScript 6 + Tailwind v4 +
    shadcn sobre `@base-ui/react`; `api/client.ts` con `credentials: "include"`;
    login admin, activar dispositivo, identificarse, Admin → Funciones,
    Configuración (8 pestañas), Carta, Dinero (operacional, historial, cronología,
    rescates), Turnos y personal (actividad y autorizaciones), Historial,
    Notificaciones; POS → Turno (abrir, roster, movimientos, cambio, retiros,
    relevo, cierre a ciegas o en un paso según flag, foto).
  - **Verificación final** (orquestador humano, árbol quieto, en serie): mypy
    limpio; `tsc` limpio; Alembic desde cero y `downgrade base`; seed dos veces sin
    duplicar; vitest 61/61; `vite build` OK; suite de backend completa (ver «Dónde
    retomar» para el resultado posterior a las correcciones).
  - **Correcciones posteriores a la entrega** (commit `31db8cb`): D-1 (el hook que
    agrega al roster al identificarse se buscaba en `app.shifts.service` y vive en
    `app.shifts.hooks`; test de punta a punta), D-2 (`race_app`, una sesión por
    request, promovida a `tests/conftest.py`; el test de carrera de `tests/shifts`
    corre sobre ella y acepta `409 SHIFT_OPEN_RACE` o `400 SHIFT_ALREADY_OPEN`),
    A-3 (`app/shifts/models.py` usa `UTCDateTime`).
- **Decisiones de implementación que todo servicio nuevo tiene que conocer**:
  - `app.core.db.UTCDateTime` en todo `Mapped[datetime]` (SQLite devuelve *naive*
    al leer `DateTime(timezone=True)`).
  - `get_db` hace **commit** también ante `AppError`: un contador de PIN fallido
    tiene que sobrevivir a su propio 400. Consecuencia: validar antes de escribir.
  - `current_device` = dispositivo activado, persona **opcional** y sin renovar su
    ventana; `current_operator` = persona **obligatoria** y vigente, única que
    renueva la ventana deslizante.
  - `run_idempotent` guarda un error de negocio como respuesta resuelta.
  - `multi_store` no gatea `GET /admin/stores` (selector de interfaz); `UvtValue`
    es por organización.

## Dónde retomar

1. **Verificación final del pedido 1a** (2026-09-14, árbol quieto, en serie):
   mypy limpio; suite de backend completa **214 passed, 0 failed** (SQLite,
   8 min); `tsc` limpio; vitest 61/61; `vite build` OK; Alembic desde cero
   `0001 → 0002 → 0003` y seed idempotente. El CI del repo debería estar en verde
   con esto; no se pudo ejecutar acá (sin runner ni Postgres local).
2. **Abierto por decisión del dueño de la spec** (advertencias del auditor, en
   `features/fase-1a-cimientos/outputs/ENTREGA.md § 5.4`): O-1 (el responsable ve
   el esperado en `/shifts/current` y después cierra «a ciegas»: ocultarlo desde
   que teclea el conteo, o aceptar el arqueo sorpresa como control); A-7 (qué PII
   de empleados entra a la auditoría exportable, con abogado); A-1 (tope de
   intentos en `/auth/authorize`); A-2 (validar `JWT_SECRET` en producción);
   A-4 (esperado calculado para turnos abiertos en `GET /admin/shifts`); A-6
   (idempotencia en `cash-swaps` y reversa de retiro); A-8 (`SAVEPOINT` en vez de
   `rollback()` ante `IntegrityError`); A-9 (**no hay ruta de dispositivo para
   listar el personal**: cuatro pantallas piden el número de empleado a mano; la
   pantalla «Quién opera» de la spec §9.1 no existe todavía).
3. **Gaps declarados por los constructores** (`ENTREGA.md § 5.5`): motivo en
   `DELETE /admin/shifts/{id}`; `close_cause` y base de apertura en el listado de
   turnos; quitar opciones de modificadores y grupos de combos (API y UI);
   agregar grupos a un combo existente desde la UI; tests de las pantallas de
   configuración, personal, auditoría y notificaciones; `shadcn` a
   `devDependencies`; token `--warning`.
4. **Corrección al contrato interno para 1b**: cada hook cruzado entre territorios
   lleva dueño del test de punta a punta, y la fixture `race_app` es la común para
   carreras (ya está en `tests/conftest.py`). Patrón registrado en
   `docs/PATRONES.md` del framework (2.1.0).
5. **Lanzar el pedido 1b** (mostrador, mesas, comandas, rondas y cocina mínima,
   precuenta y propina, cobro, documento fiscal con adaptador de proveedor, notas,
   Hoy/Ventas/Pedidos) sobre lo entregado. Conviene meter A-9 en el pedido 1b
   como primera tarea, porque «Quién opera» es la puerta del POS:
   ```js
   Workflow({
     scriptPath: '.claude/workflows/orquestador-general.js',
     args: {
       pedido: '<el pedido 1b, sección 14 de la spec>',
       spec: 'features/fase-1b-venta/spec.md',
       outputs: 'features/fase-1b-venta/outputs',
       contexto: ['docs/ESTADO.md', 'AGENTS.md', 'docs/SPEC-NEGOCIO.md'],
       base: '<commit desde el que arranca 1b>',
     },
   })
   ```
6. Lo que no se pudo verificar en este entorno: Postgres real (tipos, índices y el
   `409 SHIFT_OPEN_RACE` literal, que sólo el CI puede probar), el CI en sí, WCAG
   más allá de Testing Library, y el flujo completo en un navegador real.
