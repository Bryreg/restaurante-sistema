# Contexto para agentes — Restaurante Sistema

**Qué es este documento y qué NO es.** Es el briefing que lee un agente antes de
construir: el sistema **como está hoy**, con las costuras que tiene que reusar y
las convenciones que no puede romper. No es la historia del proyecto (esa vive en
`docs/ESTADO.md`) ni la spec de negocio (`docs/SPEC-NEGOCIO.md`) ni las reglas
duras (`AGENTS.md`). Existe porque un agente que necesita saber «¿dónde se
descuenta un insumo?» no debería leer 78 KB de bitácora para averiguarlo.

**Si algo de acá contradice a `docs/SPEC-NEGOCIO.md` o a `AGENTS.md`, mandan
ellos** y esto se corrige. Si contradice al código, manda el código y esto se
corrige: un contexto desactualizado miente con más autoridad que no tener
contexto.

---

## 1. El producto en un párrafo

POS + control interno para restaurantes colombianos, **multi-restaurante**:
organización → sede. Una organización tiene un perfil (`basic`, `standard`,
`full`) que fija los defaults de ~45 **funciones habilitables**; cada función se
puede prender o apagar por organización o por sede. El sistema cubre la venta
(mesa, mostrador, para llevar, domicilio, plataformas), el cajón (turnos, arqueo,
retiros, relevos), la carta con fichas técnicas y costo teórico, el inventario
perpetuo con conteos y varianza, las compras con lotes y cuentas por pagar, y el
documento fiscal electrónico ante la DIAN.

Dos identidades distintas conviven: **el dispositivo** (sesión larga, PIN de
sede) y **la persona** (PIN corto, sesión de minutos). El operador nunca ve
costos ni márgenes.

---

## 2. Cómo corre y cómo se verifica

```bash
# backend (sin venv)
cd backend && pip install -r requirements.txt -r requirements-dev.txt
cd backend && alembic upgrade head          # NUNCA create_all en producción
cd backend && python -m app.seed            # aparte del arranque; idempotente
cd backend && PYTHONPATH=. DATABASE_URL=sqlite:///./dev.db uvicorn app.main:app --reload --port 8000

# frontend
cd frontend && npm install && npm run dev -- --port 5173   # proxea /api -> :8000
```

| | Comando | Cuándo |
|---|---|---|
| typecheck backend | `python -m mypy app` | **siempre**, cada agente |
| tests de tu territorio | `python -m pytest tests/<dominio>` | **siempre**, cada agente |
| typecheck frontend | `npm run typecheck` | **siempre**, cada agente |
| tests de tu territorio | `npx vitest run src/features/<dominio>` | **siempre**, cada agente |
| **suite completa** (`pytest -q`, `npm run test`) | — | **SÓLO** el paso de verificación del orquestador, en serie |
| **build** (`npm run build`) | — | **SÓLO** el paso final; reescribe `dist/`, que el backend sirve |

**Por qué la suite completa es del orquestador y no tuya**: N suites en paralelo
sobre el mismo árbol y 4 cores no terminan nunca, y los teardowns se borran
archivos entre sí. Si tus tests necesitan temporales, usá `TMPDIR=/tmp/pt-<tu-id>`.

En producción es **un solo servicio**: el build arma el frontend y `main.py` sirve
`frontend/dist` con fallback SPA — mismo origen, que es lo que exige la cookie
`httpOnly`. `render.yaml` corre `alembic upgrade head` antes de uvicorn.

---

## 3. Stack y mapa del repo

FastAPI · SQLAlchemy 2.0 (tipado, `Mapped[...]`) · Alembic · psycopg 3
(`postgresql+psycopg`) · Pydantic v2. Tests: pytest, SQLite por test (base propia
en `tmp_path`, sin colisiones); CI y producción: Postgres 16.

Vite · React 19 · TypeScript · Tailwind v4 · shadcn sobre `@base-ui/react` ·
React Router · TanStack Query. Tests: vitest + Testing Library.

```
backend/app/<dominio>/{models,schemas,service,router,hooks}.py
backend/app/core/{db,errors,config,security,money,quantity,tax,tz,clock,features,models_registry}.py
backend/alembic/versions/NNNN_*.py
backend/tests/<dominio>/            # tests del dominio
backend/tests/audit/                # invariantes ejecutables (auditores)
frontend/src/features/<dominio>/    # pantallas + index.ts que exporta <dominio>Feature
frontend/src/api/<dominio>.ts       # cliente tipado del dominio
frontend/src/components/ui/         # shadcn adaptado
frontend/src/audit/                 # invariantes de frontend
```

**Anatomía de un dominio backend** (respetala; el Conciliador la cruza):
`models.py` tablas · `schemas.py` Pydantic in/out · `service.py` **toda** la
lógica y la matemática · `router.py` sólo borde HTTP (validar, llamar, serializar)
· `hooks.py` lo que **otros dominios** consumen de éste, y es el único import
cruzado permitido.

**Alta de un dominio nuevo**: agregalo a `DOMAINS` en `app/main.py` y a
`MODEL_MODULES` en `app/core/models_registry.py`. Ambos archivos tienen **un solo
dueño por pedido** — si no sos vos, pedilo, no lo edites en paralelo.

**Anatomía de un dominio frontend**: `index.ts` exporta
`{ posRoutes?, adminRoutes?, posNav?, adminNav? }` como `<dominio>Feature`;
`src/app/router.tsx` y los layouts sólo conocen las pantallas por ahí. Una
pantalla nueva no se cuelga a mano del router.

**Estado actual** (endpoints / modelos por dominio): `orders` 24/16 ·
`shifts` 24/17 · `stores` 25/9 · `inventory` 21/13 · `catalog` 17/7 ·
`purchases` 15/8 · `auth` 13/3 · `channels` 13/7 · `recipes` 12/10 ·
`fiscal` 8/6 · `kitchen` 6/3 · `payments` 6/2 · `customers` 5/5 ·
`notifications` 4/2 · `reports` 4/0 · `refunds` 2/3 · `audit` 1/1.
Alembic va por `0016`. Todo bajo `/api/v1`.

---

## 4. Contratos numéricos (romper uno es un bug que nadie encuentra)

**Nada de `float` en ninguna capa, ni en Python ni en TypeScript.**

| Qué | Escala | Dónde |
|---|---|---|
| dinero | **entero de pesos** | `app/core/money.py` |
| cantidades de insumo | `QTY_SCALE = 1000` → milésimas de la unidad base (`g`, `ml`, `unit`) | `app/core/quantity.py` |
| costos | `COST_SCALE = 1_000_000` → millonésimas de peso **por unidad base entera** | `app/core/quantity.py` |

- Un costo **por unidad base** se publica **siempre** con `format_cost_micros`:
  texto decimal, precisión completa, y el esquema Pydantic lo anota `str | None`.
  Un `int` ahí es o un cero mudo redondeado (la sal a $0,003/g publicada como `0`)
  o micros crudos filtrándose a HTTP, seis órdenes de magnitud arriba.
- Se **acumula en micros a lo largo de toda la ficha** y se redondea a pesos una
  sola vez, en el borde (`micros_to_pesos`). Redondear por línea desvía el food
  cost hacia arriba de forma sistemática.
- Si tu pedido introduce una magnitud nueva que no es plata (horas, porcentajes,
  tasas), **definí su escala entera y declarala** en `app/core/`, como hizo
  `QTY_SCALE`. No la improvises por archivo.
- Porcentajes finos van en **puntos básicos** (`_bp`, 1 % = 100).

---

## 5. Fecha de negocio y hora

`app/core/tz.py` es la única puerta. **Nunca** `datetime.utcnow().date()` en
Python ni `toISOString().slice(0,10)` en TypeScript.

- `business_date_for(instant_utc, cutoff_hour)` — la fecha operativa según la hora
  de corte de la sede (corte 06:00, venta a la 01:00 del 15 → día operativo 14).
- `today_business_date(cutoff_hour)` — «hoy» de negocio; el reloj se mockea en
  tests con `app/core/clock.py`.
- `from_bogota_wall_clock(local_naive)` — una hora que escribió una **persona**
  (`<input type="datetime-local">` entrega `"2026-09-19T03:14"` sin zona) → UTC
  aware. **La zona la pone el servidor, nunca el navegador.** Usala en todo campo
  de fecha/hora que venga de un formulario; sin ella el usuario recibe un `500`.

`business_date` es **columna propia** en la tabla, nunca derivada de un timestamp
UTC al consultar. Un test que calcula «hoy» en UTC está roto 5 de cada 24 horas —
y esa es una regresión que ya pasó.

---

## 6. Funciones habilitables

`app/core/features.py`: `FEATURE_CATALOG` (lista de `FeatureDef`), `FEATURE_BY_KEY`,
`profile_defaults`, `enabled_map`, `is_enabled`, `assert_feature`, `require_feature`.

- **Toda capacidad opcional nace detrás de su flag**, desde el primer commit, y el
  **backend** la hace cumplir: `require_feature("clave")` como dependencia del
  router, o `assert_feature(...)` en el service. Apagada → `400 FEATURE_DISABLED`.
- Las claves de fases futuras **ya existen** en el catálogo (`money.deposits`,
  `money.bank`, `money.obligations`, `payroll`…): no hace falta tocar el archivo
  para usar una que ya estaba prevista, y `GET /admin/features` ya las describe.
- `requires` declara dependencias (`money.bank → money.deposits`). **Validá las
  dependencias ANTES del gate de sede**: «tu plan no incluye esto» tiene que ganarle
  a «esta sede no lo usa», o el mensaje manda al administrador a una pantalla que no
  puede arreglarlo.
- **Lo que es ley o integridad no es un flag**: auditoría, snapshots, idempotencia,
  fecha operativa, propina separada, consecutivo, causa tipada, documento fiscal.
- **«Canales activos» es un interruptor DISTINTO de la función.** La función dice
  si el plan incluye la capacidad; `stores.active_channels` dice si ESTA sede la
  usa. `create_order` hace cumplir los cinco canales de venta contra esa lista.
  `src/audit/active-channels.test.ts` exige que la lista gateada y la lista
  marcable en `StoreFormDialog.tsx` no se separen nunca.

---

## 7. Errores

Una sola forma en toda la API: `{ "error": { "code", "message", ...extra } }`.

- `AppError(code, message, status=400, extra=...)` en `app/core/errors.py` es la
  **única** manera de cortar por una regla de negocio. Subclases: `NotFoundError`,
  etc.
- **Ninguna regla de negocio responde `500`.**
- El frontend decide por `code` (estable), nunca por `message`.
- El `message` **nombra la acción correctiva**, en español, y apunta a una pantalla
  que exista y que pueda arreglarlo.
- Concurrencia → `409` (`STALE_VERSION`, `ORDER_ALREADY_PAID`, …). Toda escritura
  que mueve plata o estado acepta `Idempotency-Key`, reservada **dentro** de la
  transacción.

---

## 8. Las costuras que ya existen (reusalas, no las repitas)

**Inventario** — `app/inventory/hooks.py`:
- `record_movement(...)` — **el único** asiento del libro de movimientos. Toda
  entrada, salida, merma, ajuste o consumo pasa por acá, con `cause` tipada.
- `resolve_ingredient_cost(db, ingredient) -> (micros | None, CostSource)` —
  jerarquía de cinco escalones: `official → weighted_average → last_purchase →
  estimated → none`. Devolver `None` con `cost_source="none"` es correcto; un `0`
  con `cost_source="official"` es el cero mudo prohibido.
- `current_stock`, `low_stock_alerts`, `negative_stock_alerts`,
  `consume_lots_fefo` (FEFO: vencimiento primero, recepción para desempatar),
  `weighted_average_cost_micros`, `last_purchase_cost_micros`,
  `inventory_staleness`, `expiring_or_expired_lots`.
- **El insumo se descuenta UNA sola vez**: al producir la preparación **o** al
  enviar el plato a cocina, nunca ambos.

**Caja y turno** — `app/shifts/`:
- `service.compute_breakdown(db, shift)` — **la única** fórmula del esperado:
  `expected = base + cash_sales + incomes − expenses − pickups`. La reserva de caja
  **no** entra. Un `cash_swap` no la mueve. Si tu pedido agrega un flujo de plata,
  **no escribas una segunda fórmula**: hacelo llegar por `incomes`/`expenses`, o
  publicalo como renglón informativo propio que no se suma.
- `hooks.payment_bucket(method, courier_employee_id)` — **el único** clasificador
  de un pago en su bolsillo. Ningún módulo reclasifica un medio a mano.
- `hooks.get_sales_totals(db, shift_id) -> SalesTotals` — ventas y propinas por
  medio. `.other` (plataformas: cuenta por cobrar, no plata) nunca entra al esperado.
- `hooks.register_*_expense/_income/_reversal` — el patrón para que otro dominio
  mueva el cajón sin tocar la fórmula.
- `_MOVEMENT_CAUSE_LABEL` en `service.py` necesita una etiqueta **por cada** miembro
  de `CashMovementCause`; hay un test que lo exige en las dos direcciones.

**Impuestos** — `app/core/tax.py`: `TAX_RATE_BY_CODE` centralizada (`inc_8`,
`iva_19`, `excluded`). La configuración fiscal de la sede está **versionada**: rige
la de mayor `valid_from` ≤ la fecha de negocio consultada.

**Fiscal** — `app/fiscal/provider.py`: adaptador `FiscalProvider` (Protocol) con
`PendingTransmissionProvider` y `FakeProvider`. Consecutivo por sede **sin huecos**,
reservado con `SELECT FOR UPDATE` dentro del rango vigente; un rechazo `400` no
consume número.

**Prorrateo** — `app/orders/money.py: prorate(...)` reparte exacto en enteros, sin
residuo perdido. Usalo; no escribas otro.

---

## 9. Reglas de plata que se rompen sin que se vea en pantalla

- **Una sola matemática, en el backend.** El frontend **nunca** deriva saldos,
  esperados, diferencias, márgenes ni porcentajes: los pinta como llegan.
- **`null` no es 0.** «Nadie contó» y «se contó y no falta nada» se distinguen en la
  API, en los tipos y en pantalla. Un indicador sin datos suficientes es `null`
  **con motivo**, nunca `$0` ni una tabla vacía muda.
- **Snapshot en el ítem**: precio, tasa de impuesto, costo teórico y receta usada se
  congelan al vender. Ningún reporte revalora una venta pasada con la carta actual.
- **La propina va separada** de la venta y del impuesto, y **fuera** del `net` de los
  reportes.
- **El operador no recibe costos ni márgenes** en ninguna respuesta.
- **Nada financiero ni de inventario se borra**: baja lógica + auditoría con antes y
  después. Si la auditoría no puede escribirse, se registra la falla; nunca se traga.
- **Causa tipada** (enum) en todo movimiento de caja e inventario. Nunca texto libre.
- **El error tolerable es el que muestra menos plata.** Todo sesgo se declara.
- **Las llaves anti doble conteo se diseñan antes que las pantallas**: retiro vs
  consignación, pago vs movimiento de banco, egreso vs recepción, propina vs venta.
- **Toda tabla legal va parametrizada con vigencia, nunca quemada en código**, y un
  período viejo tiene que poder recalcularse con las tablas que regían ese mes.

---

## 10. Convenciones de frontend

- **shadcn sobre `@base-ui/react`**, no sobre Radix. Los popups viven en un
  **portal**.
- `Select` deriva sus `items` de los `SelectItem` hijos, así que `Select.Value`
  muestra la etiqueta, no el código crudo. No lo esquives con un `value` pintado a
  mano.
- Diálogos con `max-h-[calc(100dvh-2rem)] overflow-y-auto` — una tablet en
  horizontal no puede quedar sin el botón de guardar.
- `MoneyInput` selecciona su contenido **después** del render (ref + effect): el
  foco cambia el valor mostrado y React borra una selección hecha en `onFocus`.
- Sesión en **cookie `httpOnly`**; nada sensible en `localStorage`.
- Pantallas nuevas se cuelgan por `<dominio>Feature`, y su entrada de navegación se
  esconde si su función está apagada.
- Rutas y etiquetas visibles **en español** (`/admin/ventas`, `/admin/inventario`).

**La regla de los portales, que ya se rompió cuatro veces**: `getAllByRole("option")`
**síncrono** sobre un popup en portal es una carrera — con decenas de entornos jsdom
compitiendo por CPU, el popup todavía no está montado. Siempre `await
screen.findByRole("option", ...)` primero. `src/audit/portal-queries.test.ts` lo
hace cumplir sobre todo el repo.

---

## 11. Convenciones de tests

- Todo entra **por HTTP, por la puerta real**, para que un invariante no se saltee
  la validación que existe para defender. Las excepciones son lecturas de libros y
  de tablas nuevas, y se declaran por escrito en el `conftest.py`.
- Cada test recibe su propia base SQLite en `tmp_path` — no hay estado compartido.
- Fixtures compartidas en `backend/tests/conftest.py`; lo propio de un dominio va en
  `tests/<dominio>/conftest.py`. **Ningún dominio redefine una fixture compartida.**
- `create_app()` monta todos los dominios de `DOMAINS`: un `conftest` que vuelve a
  montar su router lo monta **dos veces** sobre el `app` singleton (de ahí los
  `Duplicate Operation ID`). Si tenés que hacerlo, guardate contra `"<dominio>" in
  DOMAINS`, no contra un flag de estado.
- **Una precondición se arma explícitamente en el test**, no se hereda del default de
  un fixture: un default que se mueve deja el test verde por la razón equivocada.
- `backend/tests/audit/` y `frontend/src/audit/` son **invariantes ejecutables**: no
  se ablandan, no se acotan y no se borran para poner algo verde. Si uno estorba, el
  código está mal o el invariante está mal, y eso se discute por escrito.
- Toda función habilitable se prueba **encendida y apagada**.

---

## 12. Alembic

- Migración por pedido, numerada en secuencia. `alembic upgrade head` desde cero
  tiene que funcionar **en Postgres**, no sólo en SQLite: los tests corren SQLite y
  **no** ven un `batch_alter_table` que en Postgres exige soltar la PK.
- `_enum(...)` construye `sa.Enum(..., native_enum=False, validate_strings=True)`
  **sin** `create_constraint`: la columna es un `VARCHAR(32)` plano en los dos
  motores y **no existe ningún CHECK que recrear**. Una migración que intenta
  recrearlo falla en Postgres y deja la fase **sin desplegar**. Ya pasó.
- Un cambio de comportamiento que apretaría un gate sobre datos que ya existen va
  **con su backfill en la misma migración** (`0016` es el ejemplo: agrega
  `delivery`/`platform` a `active_channels` de toda sede existente, para que el
  deploy no le cambie el comportamiento a nadie), y con `downgrade` simétrico.

---

## 13. Glosario español ↔ código

La UI habla español, el código inglés. Para que nadie invente un tercer nombre:

organización `organization` · sede `store` · función/perfil `feature`/`profile` ·
día operativo `business_day` · turno de caja `shift` · empleado `employee` ·
mesa/zona `table`/`zone` · comanda `order` · ítem `order_item` · canal `channel`
(`counter`, `dine_in`, `takeout`, `delivery`, `platform`, `staff_meal`) ·
cobro/pago `payment` · propina `tip` · tiquete `ticket` · nota crédito
`credit_note` · insumo `ingredient` · preparación/lote `prep`/`prep_batch` ·
plato `product` · ficha técnica `recipe` · modificador `modifier_group`/
`modifier_option` · combo `combo` · movimiento de inventario `stock_movement` ·
merma `waste` · conteo `stock_count` · lote `stock_batch` · recepción
`purchase_receipt` · cuenta por pagar `payable` · proveedor `supplier` ·
movimiento de caja `cash_movement` · retiro `cash_pickup` · relevo
`shift_handover` · arqueo sorpresa `spot_check` · reserva de caja `cash_reserve` ·
hora de corte `cutoff_hour` · rescate `admin_rescue` · estación `station` · curso
`course` · ronda `round` · precuenta `bill_presented_at`/`pre_bill` · sub-cuenta
`sub_account` · documento fiscal `fiscal_document` · rango DIAN `fiscal_range` ·
cliente `customer` · cambio/sencilla `cash_swap` · devolución pendiente
`pending_refund` · base fija `opening_cash_fixed` · causa `cause` · consignación
`bank_deposit`.

---

## 14. Lo que más veces salió mal (leelo, es barato)

1. **Un test que deriva «hoy» en UTC** mientras el servidor usa la fecha de negocio
   de Bogotá: rojo 11 horas de cada 24, y el código de producción estaba bien.
2. **Un `conftest` que remonta un router** que `create_app()` ya montó.
3. **Una consulta síncrona a un popup en portal** (cuatro veces).
4. **Un `batch_alter_table` que en SQLite pasa y en Postgres tumba el deploy.**
5. **Un default de fixture usado como precondición**: cuando el default se movió,
   nueve invariantes se cayeron a la vez.
6. **Una dependencia de función validada después del gate de sede**, produciendo el
   mensaje equivocado.
7. **Un cero mudo**: `0` publicado donde correspondía `null` con motivo.
8. **Un recorrido en navegador real encontró siete defectos que 1.395 tests
   automáticos no vieron.** No se cierra una fase sin caminarla.
