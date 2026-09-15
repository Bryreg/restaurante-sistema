# ENTREGA — pedido 1b-2 (documento fiscal, clientes, devoluciones y reportes)

Maestro orquestador. Commit base del pedido: `d1aceb1`.
Verificación corrida por mí, en serie, con el árbol quieto y sin ningún otro
agente trabajando.

**Veredicto en una línea:** el pedido está construido y es coherente —los tres
bloqueantes de la ronda 1 están cerrados **en el código, no en el reporte**—,
pero la suite completa **no cierra en verde**: quedan **2 rojos en backend** y
**1 en frontend**, y encontré **una cuarta cosa que el equipo no vio**: una base
recién sembrada con `python -m app.seed` **no puede vender**. Nada de esto se
oculta abajo.

---

## 1. Qué equipo armé y por qué

El pedido tenía seis dimensiones que casi no comparten archivos, y ese —no el
organigrama— fue el criterio de reparto. Un territorio disjunto es lo que
permite que cinco constructores escriban en paralelo sin pisarse; donde el
territorio se solapa, aparecen los bugs que nadie firma.

| Agente | Modelo | Por qué existe | Territorio |
|---|---|---|---|
| `backend-fiscal` | sonnet | El documento fiscal como **objeto legal**: rangos DIAN, consecutivo, estados ante la DIAN, contingencia 48 h, adaptador de proveedor, notas, factura. Es la única dimensión con un invariante que no perdona: *un rechazo no libera el número* | `app/fiscal/**`, `app/payments/**`, `app/stores/**` (acotado), migración `0007` |
| `backend-clientes-dinero` | sonnet | Las **personas y la plata que vuelve**: habeas data, consentimientos, devoluciones pendientes, propinas. Tensión propia: borrado vs. consecutivo inmutable | `app/customers/**`, `app/refunds/**`, `app/shifts/**`, `app/notifications/**`, migración `0006` |
| `backend-reportes` | sonnet | **Lectura pura** sobre los snapshots de todos los demás. Dueño único de `app/main.py` y `models_registry.py` —el archivo que, sin dueño, no lo toca nadie | `app/reports/**`, `app/orders/**`, `app/kitchen/**`, `app/core/tax.py`, `app/main.py` |
| `frontend-fiscal` | sonnet | La pantalla fiscal y de clientes + el POS de cobro donde se saldan A-10 y A-11 | `src/features/{fiscal,customers,payments}/**` |
| `frontend-admin` | sonnet | La pantalla analítica + la carcasa de rutas y navegación | `src/features/{reports,orders}/**`, `src/app/**`, `src/components/**` |
| `auditor-fiscal` | **opus** | Razonamiento contable y legal convertido en tests sobre territorio ajeno que **no arregla**. El único opus del equipo, porque es el único rol donde el costo de un falso verde es una multa de la DIAN o una sanción de habeas data | `backend/tests/audit/**`, `frontend/src/audit/**` |

**Dos decisiones de armado que pagaron.**

1. **La cadena de migraciones se invirtió a propósito**: `0006` (clientes) es de
   `backend-clientes-dinero`, `0007` (rangos) es de `backend-fiscal`, porque
   `fiscal_documents.customer_id` necesitaba una tabla `customers` que existiera
   antes. Verificado: `0005 → 0006 → 0007` corre limpio sobre una base nueva.
2. **`app/main.py` y `models_registry.py` con dueño único explícito.** En la
   ronda 1, *tres* entregables declararon como «bloqueante sin dueño» que
   `customers`/`refunds` no estaban montados. `backend-reportes` ya lo había
   hecho. Sin un dueño nominado, ese archivo se queda sin tocar y todos lo
   reportan; con dueño, se resuelve una vez. La lección se repite abajo, en
   §6: **lo que no tiene dueño, no se hace** —y las tres cosas que quedaron
   rojas son exactamente archivos sin dueño.

**Gaps de 1b-1 que decidí NO meter** (declarados, no escondidos): `PinPad`
escuchando el teclado a nivel de `window` sin filtrar por foco, y el ancho de
impresión 58/72/80 mm sin configuración de sede. Ninguna pantalla de 1b-2 era
del POS con PIN ni de Configuración; abrirlas habría creado territorio
compartido sin dueño. Siguen abiertos con nombre.

---

## 2. Qué construyó cada agente

### `backend-fiscal` — el documento fiscal de verdad
- `app/fiscal/models.py`: `FiscalRange` nueva; `FiscalDocument` gana
  `fiscal_range_id` (FK real), `customer_*`, `reverses_document_id`, `reason`.
- `app/fiscal/provider.py` (nuevo): `FiscalProvider` (Protocol),
  `PendingTransmissionProvider`, `FakeProvider`, `get_provider`.
- `app/fiscal/service.py` reescrito: `reserve_next_number` por rango con
  `SELECT … FOR UPDATE`, `issue_note`, `emit_and_apply`, `retry_document`,
  `sweep_contingency_overdue`, `document_evidence`, `export_bundle`.
- `app/fiscal/router.py`, `schemas.py` (nuevos): rangos, documentos, evidencia,
  export, notas, reintento.
- `app/payments/service.py`: `pay_order` valida **antes de escribir**
  (`assert_range_available`, `assert_feature("customers")`), `PaymentOut.amount_due`.
- `GET /device/payment-methods` — cierra el gap de «el POS ofrece seis códigos
  fijos» que habría dejado emitir con un medio que la sede deshabilitó.
- Migración `0007`, probada `upgrade → downgrade → upgrade`.

**Invariante que quedó probado**: el consecutivo se reserva **antes** de que el
proveedor conteste; un rechazo conserva el número. 100 ventas + 3 notas + 2
rechazos dejan las dos series completas, sin huecos ni repetidos.

### `backend-clientes-dinero` — personas y plata que vuelve
- `app/customers/**` (nuevo): `Customer`, `CustomerConsent`,
  `CustomerDataRequest`; `upsert_customer_with_consent` como única puerta de
  escritura del dispositivo; `erase_customer` idempotente.
- `app/refunds/**` (nuevo): `PendingRefund`, `settle_or_queue_refund` como
  única puerta por la que una nota mueve caja.
- `app/shifts/tips.py`, `activity_metrics.py` (nuevos): propinas por medio y
  por empleado, actividad por persona con `team_average`.
- `app/notifications/service.py`: cuatro tipos nuevos (`fiscal_rejected`,
  `fiscal_contingency_overdue`, `fiscal_range_low`, `pending_refund`).
- Migración `0006` con las seis tablas.

### `backend-reportes` — los cinco reportes del administrador
- `app/reports/**` (nuevo): `GET /admin/today`, `/admin/sales` (siete
  `group_by`), `/admin/accountant-report`, `/admin/unavailable-log`.
- `app/orders/service.py`: `admin_list_orders` ampliado a
  `{rows, kitchen_times_by_station, sent_at_payment_ratio}`; p50/p90 por
  estación **que sobreviven a un `merge`** (se leen de `OrderItem.sent_at`, no
  de `OrderRound`), con test dedicado — era una obligación explícita del pedido.
- `app/core/tax.py` (nuevo): `TAX_RATE_BY_CODE` centralizada; `app/orders/service.py`
  la importa. **Verificado: no queda ninguna copia local.**
- `app/orders/money.py`: **A-12 corregido** (`prorate` topea cada línea a su
  propio peso cuando `amount <= sum(weights)`), con test de propiedad de 2.000 casos.
- `app/main.py` + `models_registry.py`: montó `customers`, `refunds`, `reports`.
  **Verificado: 116 rutas en el OpenAPI, las 12 superficies nuevas alcanzables.**
- Defecto ajeno encontrado y corregido: `POST /items/{id}/ready` exigía persona
  identificada y vigente aunque el endpoint usa `current_device`.

### `frontend-fiscal` — pantalla fiscal, clientes y POS de cobro
- `src/features/fiscal/**` (nuevo): Documentos (estado, reintento, evidencia),
  Rangos, Notas, Devoluciones pendientes.
- `src/features/customers/**` (nuevo): Clientes con consentimientos, bitácora y
  supresión.
- **A-10 saldado donde el backend llega**: «Total a cobrar» ya no se pinta como
  `venta + propina` derivado; venta y propina van en dos líneas separadas, cada
  una tal como llega, y dice explícitamente cuando `totals.total` no llegó.
- **A-11 cerrado**: la leyenda legal ya no está hardcodeada en el cliente; viene
  del servidor y sigue el estado DIAN.

### `frontend-admin` — Hoy, Ventas, Pedidos y la carcasa
- `src/components/{DateRangeFilter,CsvExportButton,StatTile}.tsx` (nuevos),
  publicados **antes** de tocar pantallas, como orden de arranque.
- `src/features/reports/**` (nuevo): Hoy (pulso + «Requiere tu atención»),
  Ventas (tres pestañas: Ventas, Informe del contador, Agotados), gráficos en
  SVG propio sin librería nueva, siempre con la tabla exacta al lado.
- `OrdersAdminPage.tsx` a la forma nueva; corrigió de paso un `<tr onClick>` sin
  equivalente de teclado heredado de 1b-1.
- **O-1 cerrado**: `DiscountDialog` ya no redondea en silencio.
- Router y navegación: el índice de `/admin` pasa de «Funciones» a «Hoy».

### `auditor-fiscal` — 182 invariantes ejecutables
146 en backend + 36 en frontend, de los cuales 50 + 16 son nuevos de 1b-2:
`test_fiscal_invariants.py` (18), `test_notes_refunds_invariants.py` (9, nuevo),
`test_privacy_invariants.py` (13, nuevo), `test_reports_invariants.py` (12,
nuevo), `test_security_invariants.py` (+3), `test_migration_invariants.py` (+2),
`frontend/src/audit/fiscal.test.ts` (15, nuevo).

**Halló tres bloqueantes reales en la ronda 1**, los tres escritos como tests
rojos a propósito, los tres cerrados en la ronda 2 **sin que se tocara una sola
de sus aserciones** —que es la única forma de que un verde signifique algo:

| | Qué | Verificado por mí en el código |
|---|---|---|
| **B-1** | `erase_customer` copiaba al `before` de `audit_logs` exactamente el nombre, correo, dirección, municipio, documento y dv que el titular pidió suprimir: el dato sobrevivía años en una bitácora que se exporta | `app/customers/service.py` — `_customer_audit_view()` guarda **sólo los nombres de los campos**, nunca los valores. `after` queda con los placeholders |
| **B-2** | Cobrar con `customer` en el body y la flag `customers` apagada dejaba la comanda `paid` **sin documento y sin pago**: la venta se perdía entera, indetectable | `app/payments/service.py:450` — `features.assert_feature(…, "customers")` **antes** de `claim_payment` (línea 467) |
| **B-3** | El documento en contingencia vencido a 48 h no llegaba a «Requiere tu atención»: el barrido sólo corría si el admin entraba a la pantalla fiscal | `app/reports/service.py:520` — `fiscal_service.sweep_contingency_overdue()` dentro de `today_report()` |

El auditor además corrigió al Conciliador en dos puntos donde dos entregables
declaraban como bloqueante algo ya resuelto. Tenía razón: lo verifiqué.

---

## 3. Coherencia

**Sí, el trabajo es coherente**, y lo verifiqué contra el código, no contra los
reportes:

- **Territorios disjuntos respetados.** 51 archivos modificados + 44 nuevos, sin
  un solo conflicto de escritura entre agentes.
- **Cadena de migraciones íntegra**: `alembic upgrade head` sobre una base nueva
  llega a `0007` sin error.
- **Superficie montada**: 116 rutas en el OpenAPI; las 12 superficies nuevas de
  1b-2 (clientes, devoluciones, rangos, documentos fiscales, evidencia, export,
  notas, hoy, ventas, informe del contador, agotados, propinas) responden.
- **Ningún campo `cost`/`margin` en ningún esquema del OpenAPI** (checklist).
- **Una sola tabla de tarifas**: `app/core/tax.py` es la única definición.
- `mypy app`: **limpio, 89 archivos**. `tsc --noEmit`: **limpio**.

**Lo que cambió respecto de los entregables** (los reportes se escribieron
mientras el árbol se movía, así que algunos párrafos ya nacieron viejos):
`backend-fiscal.md §7` puntos 1, 2, 3 y 7 y `frontend-fiscal.md §6` puntos 1, 3
y 4 declaran gaps que **ya están resueltos** en el árbol final. Los dejé
declarados acá como cerrados para que nadie los persiga.

---

## 4. Verificación

Corrida por mí, una vez, en serie, sin procesos huérfanos (`ps` confirmado
antes), sin builds del frontend mientras la suite corría.

| Comando | Resultado |
|---|---|
| `cd backend && python -m pytest -q` | **2 failed, 536 passed** en 26:12 |
| `cd backend && python -m mypy app` | ✅ `Success: no issues found in 89 source files` |
| `cd backend && alembic upgrade head` (base nueva) | ✅ `0005 → 0006 → 0007` limpio |
| `cd frontend && npm run typecheck` | ✅ limpio |
| `cd frontend && npm run test` | **1 failed, 183 passed** (48 archivos) |
| `cd frontend && npm run build` | ✅ 2.515 módulos, `dist/` generado |

Checklist del pedido (`features/fase-1b-venta/spec.md §119`): **verificado con
test que existe y pasa** en 17 de 19 ítems. Los dos que no:

- **«Typecheck, suite completa y build, una vez, en serie»** — la suite **no
  está en verde** (§5).
- **«POS en 375 px y 1024 px sin scroll horizontal; foco visible; contraste
  AA»** — se auditó por inspección de fuente, no con un render real ni un
  medidor de contraste. **Sigue pendiente** y es del recorrido en navegador.

---

## 5. Conflictos NO resueltos

Ninguno de estos está escondido. Tres son rojos de la suite; uno lo encontré yo
y no lo vio nadie del equipo.

### R-1 (bloqueante para el recorrido) — Una base recién sembrada no puede vender

**Esto no lo declaró ningún agente.** `fiscal.dee_pos` está **encendida por
defecto en los tres perfiles** (`app/core/features.py:222`), y
`app/seed.py` crea `StoreFiscalConfig` y `UvtValue` pero **no crea ningún
`FiscalRange`**. Consecuencia concreta: después de
`alembic upgrade head && python -m app.seed`, el primer intento de cobrar
devuelve `400 NO_FISCAL_RANGE`. El sistema está bien —no se puede emitir un
documento equivalente sin rango autorizado—, pero **el camino de demostración
y de desarrollo quedó cortado en seco**, y el próximo paso del pedido es
justamente recorrerlo en navegador.

- **Dónde**: `backend/app/seed.py` (sin `FiscalRange`), `backend/app/core/features.py:222`.
- **Corrección**: que el seed cargue un rango de desarrollo vigente y evidente
  (prefijo de prueba, vigencia amplia, `resolution_number` ficticio y rotulado
  como tal), o que apague `fiscal.dee_pos` en el seed y lo diga al imprimir.
  Lo primero es mejor: deja el camino real ejercitado.
- **Dueño**: quien tome `app/seed.py`.

### R-2 (rojo de la suite) — `PUT /admin/stores/{id}/sales-settings` cambió su contrato de entrada

`tests/core/test_errors.py::test_business_error_never_500` falla:
espera `TIP_PCT_OVER_LIMIT` y recibe `VALIDATION_ERROR`.

La causa no es el test. `backend-fiscal`, en su mandato acotado sobre
`app/stores`, agregó `invoice_threshold_uvt: int = Field(ge=1)` a
`SalesSettingsIn` **sin default**: es un campo **obligatorio** nuevo. Cualquier
cuerpo que no lo traiga ahora muere en la validación de Pydantic **antes** de
llegar a la regla de negocio, y devuelve un código genérico en vez del que
nombra la acción correctiva —justo lo que `AGENTS.md` prohíbe («reglas de
negocio en `400` con código y mensaje que nombra la acción correctiva»).

Dos matices que verifiqué:

- **El admin no se rompe en el navegador**, por casualidad: `SalesSection.tsx`
  hace `setValues(query.data)` con el objeto entero del `GET`, y como
  `SalesSettingsOut` hereda de `SalesSettingsIn`, el campo viaja de vuelta en el
  `PUT` aunque el tipo de TypeScript no lo declare. Un cliente que arme el
  cuerpo a mano —como hace ese test— sí se rompe.
- **`invoice_threshold_uvt` no es editable desde ninguna pantalla.**
  `frontend/src/api/stores.ts::SalesSettings` no lo declara y
  `SalesSection.tsx` no lo pinta. Queda fijo en el default de la columna (`5`),
  invisible para el administrador, aunque la spec lo define como configuración
  de sede.

- **Dónde**: `backend/app/stores/schemas.py:152`, `backend/tests/core/test_errors.py:59`,
  `frontend/src/api/stores.ts:150`, `frontend/src/features/settings/SalesSection.tsx`.
- **Corrección**: darle default (`= Field(default=5, ge=1)`) para no romper
  cuerpos existentes, actualizar el test, y exponer el campo en Configuración →
  Ventas.
- **Por qué nadie lo vio**: `tests/core/**` y `frontend/src/features/settings/**`
  no estaban en el territorio de ningún agente. Es un error mío de reparto.

### R-3 (rojo de la suite) — El gate de rango DIAN rompió un E2E de 1b-1

`tests/shifts/test_sales_totals_e2e.py::test_sales_totals_flow_into_shift` falla
con `400 NO_FISCAL_RANGE`. Es la misma causa raíz que R-1: el test paga con
`fiscal.dee_pos` encendida sin cargar rango.

`backend-clientes-dinero` lo **encontró y lo declaró explícitamente** en su §6
(«Regresión encontrada, no mía») y con razón no lo arregló: el archivo no era
suyo y la decisión de fondo —¿el test apaga la flag, o el sistema deja un rango
de seguridad?— no le correspondía. **Esa decisión es la de R-1.** Si el seed
carga un rango de desarrollo, la fixture de `tests/shifts` debería hacer lo
mismo; el test entonces vuelve a verde probando el camino real.

- **Dónde**: `backend/tests/shifts/test_sales_totals_e2e.py`, `backend/tests/shifts/conftest.py`.
- **Dueño**: quien tome R-1 (es la misma decisión).

### R-4 (rojo de la suite, frontend) — Test que gana en aislamiento y pierde bajo carga

`src/features/payments/__tests__/PaymentSplitsForm.test.tsx:43` falla en la
suite completa y **pasa solo** (`4 passed`) cuando corre aislado. No es
casualidad ni infraestructura: la línea 41 abre un popup que se renderiza en un
portal y la 43 lo consulta con `screen.getByRole` **síncrono**. Con 48 entornos
jsdom compitiendo, el popup todavía no está montado.

- **Corrección**: `await screen.findByRole("option", { name: "Efectivo" })`.
  Una línea.
- **Dueño**: `frontend-fiscal`.
- **Importa más de lo que parece**: un test que pasa aislado y falla en conjunto
  enseña a ignorar el rojo de la suite. Es la puerta de entrada de los verdes
  falsos.

### R-5 (observación mía) — `format=csv` funciona pero no está en el contrato

Cinco de los diez listados nuevos sirven CSV leyendo `request.query_params`
directamente (`app/core/csv.py::wants_csv`) en vez de declarar `format` como
parámetro: `/admin/accountant-report`, `/admin/fiscal/ranges`,
`/admin/fiscal/documents`, `/admin/pending-refunds`, `/admin/customers`.
Funciona —el test del auditor lo prueba— pero el OpenAPI no lo declara, así que
un cliente generado desde el contrato no sabe que existe. Los otros cinco sí lo
declaran. Es una inconsistencia, no un defecto.

### R-6 (observación mía) — Dos `conftest.py` montan routers por segunda vez

`tests/customers/conftest.py:44` y `tests/refunds/conftest.py:30` hacen
`app.include_router(...)` sobre el `app` singleton de `app.main`. Era el
workaround correcto cuando `customers`/`refunds` no estaban en `DOMAINS`; ahora
que `create_app()` ya los monta, **los monta dos veces**, y de ahí salen las
siete advertencias `Duplicate Operation ID` de la corrida. Verificado que la app
real **no** tiene rutas duplicadas: es sólo en esos dos conftest. Código muerto
que muta un singleton compartido entre módulos de test.

### Deuda declarada que sigue viva (del auditor, reverificada por mí)

| # | Qué | Severidad | Dueño |
|---|---|---|---|
| **A-2 (A-10 parcial)** | `amount_due` lo manda el servidor **sólo después** de cobrar. Antes de cobrar, `PreBillOut`/`OrderOut.totals` no lo traen, así que `PaymentTargetPanel.tsx:105` sigue armando el objetivo con `saleTotal + tip`. Lo que se **muestra** ya no se deriva; lo que se **cobra**, sí. `app/orders/schemas.py` no tuvo dueño en 1b-2 | advertencia | quien tome `app/orders/schemas.py` + `frontend-fiscal` |
| **A-1** | La supresión de habeas data no alcanza `pending_refunds`: nombre y documento del titular sobreviven ahí, **también después de saldada**, y se exportan por CSV. Hay una tensión legítima (hay que saber a quién pagarle) pero no hay obligación de conservación que lo justifique una vez pagada | advertencia | `backend-clientes-dinero`, con decisión del dueño de la spec |
| **A-3** | `GET /admin/fiscal/documents` filtra por estado pero no por tipo, y la pantalla lo suple en el cliente sobre una lista sin paginación | advertencia | `backend-fiscal` + `frontend-fiscal` |
| **O-1** | `?? 0` sobre un campo de plata en el gráfico de Ventas (`SalesTab.tsx:101,106`): «sin datos» se dice, no se dibuja como cero | observación | quien tenga `features/reports` |
| **O-2** | Tres `<button>` crudos en `CheckoutPage.tsx:179,233,323` no heredan el `focus-visible:ring-*` tokenizado | observación | `frontend-fiscal` |
| **O-3** | `FiscalDocument.customer_id` sigue `Integer` sin FK dura. La razón que lo justificaba (`customers` fuera de `MODEL_MODULES`) **ya no existe**: hoy es una migración de una línea | observación | `backend-fiscal` |
| **O-4** | Fiscal y clientes siguen importando su copia local del filtro de fechas y del botón de CSV, aunque los compartidos ya existen. Tres implementaciones del mismo filtro | observación | `frontend-fiscal` |

### Gaps estructurales (ninguno resoluble en este entorno)

- **Postgres real.** Todo corrió en SQLite. El `SELECT … FOR UPDATE` de
  `reserve_next_number`, los índices únicos parciales con `postgresql_where` y
  el código exacto de una carrera real **no están probados**: el *invariante*
  del consecutivo sí, el *mecanismo* que lo protege en producción no. Es del CI.
- **Sin scheduler.** `sweep_contingency_overdue` es un barrido perezoso que
  corre al entrar a Hoy o a la pantalla fiscal. Un cron real queda fuera.
- **Sin proveedor tecnológico real.** `GET /admin/fiscal/export` devuelve un
  manifiesto JSON con hash sha256 por documento, no un ZIP con XML: no hay XML
  que empaquetar todavía.
- **Recorrido en navegador real**: no corrido. Hoy está bloqueado por R-1.
- **Gaps de 1b-1 que decidí no meter**: `PinPad` sin filtrar por foco; ancho de
  impresión por sede. Siguen abiertos con nombre.
- **`GET /kitchen/rounds` tras un `merge`**: la ronda origen sigue apuntando a
  la comanda fusionada. Los reportes no se ven afectados (leen `OrderItem`), la
  vista de cocina en vivo sí. Declarado por `backend-reportes`.

---

## 6. Próximos pasos, priorizados

1. **Cargar un rango DIAN de desarrollo en `app/seed.py`** (R-1). Es lo único
   que hoy separa al proyecto de poder demostrarse. Arreglado esto, R-3 se
   arregla con la misma decisión.
2. **Darle default a `invoice_threshold_uvt`** y actualizar
   `tests/core/test_errors.py` (R-2). Después: exponer el campo en
   Configuración → Ventas, que hoy es invisible.
3. **`await screen.findByRole` en `PaymentSplitsForm.test.tsx:43`** (R-4). Una
   línea, y devuelve la suite completa a verde. Los tres primeros puntos son
   **el trabajo que falta para poder decir «el pedido cerró»**.
4. **Recorrer 1b-2 en navegador real** con el seed arreglado: cobrar, emitir,
   rechazar con el `FakeProvider`, reintentar, emitir una nota, tramitar una
   supresión, y medir el POS a 375 px y 1024 px con un medidor de contraste —
   el único ítem del checklist que ningún test puede cerrar.
5. **Decidir A-1** (supresión y `pending_refunds`). Es decisión del dueño de la
   spec, no de un agente: hay una tensión real entre el derecho de supresión y
   saber a quién se le debe plata. Mi recomendación: anonimizar las **saldadas**,
   conservar las pendientes mientras lo estén, y declarar por qué.
6. **Cerrar A-10 del todo**: `amount_due` en `PreBillOut`/`OrderOut.totals`/
   `SubAccountOut.totals`, y `PaymentTargetPanel` pasándolo tal cual. Una línea
   de cada lado, y `app/orders/schemas.py` **con dueño explícito** esta vez.
7. **Limpiar el andamiaje que sobró**: el doble montaje de routers en los dos
   conftest (R-6), `format` declarado en los cinco listados que no lo declaran
   (R-5), la FK real de `customer_id` (O-3), los filtros compartidos (O-4).
8. **Actualizar `docs/ESTADO.md`** con el estado real: qué quedó en verde, los
   tres rojos, y la lista de deuda de §5 —que es de donde sale el próximo pedido.

---

## 7. Una lección de reparto, para el próximo pedido

Las tres cosas que quedaron rojas caen en archivos que **no estaban en el
territorio de nadie**: `tests/core/**`, `frontend/src/features/settings/**` y
`app/seed.py`. No es casualidad ni descuido de los agentes: cada uno respetó su
frontera, y la frontera estaba mal dibujada.

Cuando un mandato acotado toca un modelo compartido —como `backend-fiscal`
agregando un campo a `StoreSalesSettings`— hay que asignarle **también** el
esquema de entrada, sus tests y la pantalla que lo edita, o el campo queda
escrito a medias en tres capas. El próximo reparto debería incluir, además del
territorio, una lista explícita de **archivos huérfanos con dueño asignado**:
`app/seed.py`, `tests/core/**` y `frontend/src/features/settings/**` para
empezar.
