# Fase 3 — Dinero y control (pedido único)

Quinta fase. Construye sobre 1a, 1b, 2a, 2b y 2c. Depende de
`docs/SPEC-NEGOCIO.md` (v0.4), de `AGENTS.md` y de `docs/CONTEXTO-AGENTES.md`.
**Si algo de acá contradice a la spec de negocio, manda la spec de negocio y se
corrige acá.**

## Objetivo

§14 lo dice en cinco palabras: **«se cierra el mes con números»**. Hoy el sistema
sabe lo que entró por la puerta y lo que cuesta un plato. No sabe qué pasó con esa
plata después de salir del cajón, ni cuánto cuesta tener el restaurante abierto, ni
qué conviene vender.

Esta fase cubre **las once capacidades** de la fila «3. Dinero y control» de §14,
en **un solo pedido**: consignaciones, banco y mano, conciliación de datáfono y
plataformas, obligaciones y gastos, punto de equilibrio, propinas repartidas,
nómina con recargos, reposición sugerida, ingeniería de menú, varianza por plato y
cobro por mesero.

### Que sea un pedido único cambia cómo se trabaja

Son tres dominios de datos sin territorio en común y **cuatro backends en
paralelo**. El riesgo no es el tamaño: es que dos agentes escriban el mismo
archivo. Por eso:

- **El reparto de territorios de §2 no es una sugerencia.** Un archivo tiene
  exactamente un dueño. Escribir fuera de tu territorio es un conflicto
  bloqueante aunque el código esté bien.
- **Los archivos compartidos ya están resueltos** (`app/main.py`,
  `app/core/models_registry.py`, `app/core/features.py`, los paquetes nuevos y sus
  `__init__.py`): los dejó listos el orquestador humano **antes** de lanzar el
  equipo. **Ningún agente los toca.** Si creés que falta algo ahí, declaralo como
  gap; no lo edites.
- **La cadena de Alembic está repartida de antemano.** Cuatro agentes creando
  migraciones en paralelo, cada uno tomando «la siguiente», producen cuatro
  cabezas y `alembic upgrade head` deja de existir como comando. Por eso cada
  territorio tiene **su número y su padre asignados**, y los escribe tal cual:

  | Territorio | `revision` | `down_revision` |
  |---|---|---|
  | T1 `banking` | `"0017"` | `"0016"` |
  | T2 `expenses` | `"0018"` | `"0017"` |
  | T2 `expenses` (D-2) | `"0019"` | `"0018"` |
  | T3 `payroll` | `"0020"` | `"0019"` |
  | T4 `analytics` | `"0021"` | `"0020"` |

  **Escribí tu `down_revision` aunque el padre todavía no exista** cuando
  empezás: lo está escribiendo otro agente en la misma ronda y va a existir
  cuando el orquestador corra `alembic upgrade head` en la verificación. Si tu
  territorio **no necesita tablas**, no crees la migración y **decilo en tu
  entregable**: el orquestador humano reencadena el `down_revision` del
  siguiente. No la crees vacía «para no romper la cadena».

---

## 1. Decisiones que estaban abiertas, y cómo quedan

Las cuatro bloqueaban partes concretas de esta fase y **ninguna la puede tomar un
constructor**. Las tomó el orquestador humano, acá, por escrito, con el
razonamiento a la vista para que se puedan discutir después. **No se renegocian
durante la construcción**: si una te parece mal, construí lo que dice y dejá tu
objeción en `gaps`.

### D-1. Qué significa «sostenido» en el semáforo de varianza

§5.4: «food cost real − teórico < 2 puntos verde, 2–4 revisar, **> 4–5 sostenido
rojo**». «Sostenido» no estaba definido, y sin definirlo la ingeniería de menú no
puede clasificar nada.

**Decisión.** «Sostenido» es una propiedad **de la sede**, no de un insumo, y se
mide sobre la **brecha de food cost** (real − teórico, en puntos porcentuales),
que es de lo que habla la oración de §5.4. Concretamente:

> La brecha está **sostenida en rojo** cuando supera el umbral rojo en **al menos 2
> de las últimas 3 ventanas** de food cost real disponibles. Una ventana es el
> período entre dos conteos completos aplicados consecutivos (la misma definición
> que ya usa 2b para el food cost real). Con **menos de 2 ventanas** computables,
> el indicador es **`null` con motivo** («sin historial suficiente: hacen falta al
> menos dos conteos completos aplicados»), **nunca verde**.

**Por qué 2 de 3 y no «3 seguidas» ni «2 seguidas».** «Sostenido» tiene que
significar «no fue una vez», y tiene que sobrevivir a un error de medición sin
volverse ciego. Tres seguidas exige tres meses de evidencia en un restaurante que
cuenta mensualmente: para cuando avisa, el problema ya costó un trimestre. Dos
seguidas se apaga con un solo conteo bueno, que es exactamente lo que hace un
faltante intermitente. 2 de 3 tolera una medición mala sin perdonar un patrón.

**Lo que esta decisión NO cambia:** `app/inventory/service.py::_variance_level` —
el semáforo **por renglón de un conteo**, que es por umbral y sin historia — se
queda **exactamente como está**. «Sostenido» es un indicador **nuevo y aparte**.
Tocar `_variance_level` es romper el contrato publicado de `VarianceRowOut.level`
y sus tests, y **es un conflicto bloqueante**.

### D-2. De dónde sale el monto de la cuenta por pagar (O-5)

Hoy `Payable.amount` es **calculado**: `Σ (pesos(costo pretax de la línea) +
tax_amount)`, línea por línea, en `app/purchases/service.py`. La recepción captura
`invoice_number` y `invoice_date` pero **no captura el total del papel**. Si la
factura del proveedor dice otra cosa, nadie se entera, y esa diferencia se arrastra
al resultado del mes que esta fase construye.

**Decisión.** Las dos cifras existen, se guardan **las dos**, y la diferencia se
publica:

- La recepción gana `invoice_total: int | None` — **lo que dice el papel**,
  opcional (una recepción `no_invoice=True` no tiene papel que copiar).
- `Payable.amount` **no cambia de significado**: sigue siendo la cifra calculada, y
  es la que alimenta el costo del inventario.
- Cuando hay `invoice_total` y difiere, la cuenta publica
  `invoice_discrepancy: int | None` (= `invoice_total − amount`), y **aprobarla
  exige reconocer la diferencia explícitamente**: `POST
  /admin/payables/{id}/approve` corta con `409 INVOICE_DISCREPANCY` y un mensaje
  que nombra las dos cifras, salvo que venga `confirm_discrepancy: true`, que
  queda registrado con quién lo confirmó.

  **Esto no es un patrón nuevo**: es exactamente el de `confirm_price` que
  `create_reception` ya usa para un precio que se sale del promedio ponderado
  (`409` + repetir con la confirmación, y `price_confirmed_by_employee_*`
  guardado). Copialo, no inventes otro: dos formas distintas de decir «sí, ya
  sé, seguí» son dos formas de que alguien no entienda ninguna.
- **Se le paga al proveedor contra el papel** (`invoice_total` cuando existe); el
  inventario **se costea contra el cálculo**. Son dos preguntas distintas y tienen
  dos respuestas distintas.

**Por qué no elegir una sola.** El papel es la obligación legal y es lo que el
proveedor va a cobrar; el cálculo es lo que de verdad entró al inventario. Elegir
el papel falsea el costo del plato; elegir el cálculo hace que la cuenta no cuadre
con lo que el proveedor reclama. Guardar las dos y **nombrar la diferencia** es lo
único que no miente, y es la aplicación directa de «el error tolerable es el que
muestra menos plata» más «nada financiero se borra».

**Territorio:** esta es la **única** excepción autorizada a «no toques
`app/purchases/`», y es de **T2** (`backend-obligaciones`), porque es T2 quien
arrastra las cuentas por pagar al resultado del mes. Se limita a: la columna nueva
en `receptions`, el campo nuevo en el esquema de recepción, el `invoice_discrepancy`
derivado en la salida de la cuenta, y su migración. **Nada más de `purchases`.**

### D-3. Cómo se reparten las propinas

§6.2 ofrece tres criterios —«partes iguales, por horas, por área»— y no elige.

**Decisión.** Se construyen **los tres**, configurables por sede
(`tip_distribution_method`), con **«por horas» de default**, y el reparto es
**una propuesta que alguien confirma**, nunca una transferencia automática.

El «confirmar» **ya está construido** desde 1b-2 (`app/shifts/tips.py::
register_tip_payout` y `POST /admin/tips/payouts`, con sus tablas `tip_payouts` y
`tip_payout_distributions`). Lo que falta, y lo que esta fase agrega, es **el
cálculo de la propuesta** — que es exactamente lo que el docstring de `TipPayout`
dejó anotado como pendiente de fase 3.

**Por qué «por horas» de default.** Es el único de los tres que es proporcional al
trabajo realmente hecho en el turno, es el único que se le puede explicar a quien
pregunte por qué le tocó menos, y se calcula con datos que el sistema **captura
desde el MVP** (entradas, salidas y pausas por persona, §7). «Partes iguales»
castiga a quien cubrió el turno entero; «por área» necesita un mapa de áreas que no
todo restaurante tiene.

**Lo que no se negocia, porque es ley** (§6.2, Ley 1935 de 2018): **100 % va a los
trabajadores** de la cadena de servicio; el empleador no la reparte a su criterio
ni la usa para gastos, faltantes ni reposiciones; no es salario ni factor salarial;
se entrega en un mes como máximo. El sistema **propone** el reparto y **registra**
quién, cuánto y cuándo (ese registro existe desde 1b); no mueve plata solo.

### D-4. Si la supresión por habeas data alcanza a `pending_refunds`

Abierta desde 1b-2 (A-1). Una devolución pendiente guarda nombre y teléfono de una
persona real; y es, a la vez, un registro financiero vivo.

**Decisión.** **Sí la alcanza**, con el mismo criterio que `erase_customer` ya usa
para los documentos fiscales: **se anonimizan los campos personales, se conserva
intacto el registro financiero.** Es decir: el monto, el documento asociado, quién
la autorizó y su estado **no se tocan**; el nombre y el teléfono de la fila pasan a
su forma anonimizada. La devolución le sigue siendo pagadera a quien aparezca con
el documento: **no se borra la plata, se borra la identidad.**

**Por qué no hay contradicción.** Ley 1581 da el derecho de supresión sobre el dato
personal; «nada financiero se borra» protege el asiento. Anonimizar el dato y dejar
el asiento cumple las dos: es exactamente lo que ya se resolvió para el snapshot
del documento fiscal en 1b-2. Y la auditoría de esta supresión guarda en `before`
**sólo los nombres de los campos**, nunca los datos suprimidos — esa fue la lección
del bloqueante B-1 de 1b-2, y repetirla acá sería reintroducir el mismo defecto.

**Territorio:** **T1** (`backend-banco`), única excepción autorizada a «no toques
`app/refunds/` ni `app/customers/`», limitada a extender la supresión existente.

---

## 2. Territorios — el reparto (contrato duro)

Cinco territorios de construcción y uno de auditoría. **Un archivo, un dueño.**

### T1 — `backend-banco` · la plata después del cajón

**Escribe (y es el único que escribe):**
- `backend/app/banking/**` (dominio nuevo, ya registrado)
- `backend/alembic/versions/0017_banking.py`
- `backend/tests/banking/**`, `backend/tests/audit/test_banking_invariants.py`
- **Excepción D-4**: la supresión de datos personales en `app/refunds/service.py`
  y su test. Nada más de esos dominios.

**Construye:** consignaciones con comprobante; el **saldo por consignar**; libro
del banco (consignaciones, liquidaciones del datáfono con rezago/comisión/
retenciones, transferencias); **mano del dueño** (lo retirado y todavía no
consignado ni gastado); conciliación del datáfono y de **plataformas** contra lo
que `app/channels/` ya registró como cuenta por cobrar; D-4.

**LO QUE YA EXISTE Y NO SE RECALCULA (esto es lo más fácil de romper de todo el
pedido):**
- **`Shift.to_deposit` ya existe** y lo escribe `app/shifts/service.py` al cerrar
  el turno: `counted_cash_total − opening_cash_fixed − tips_cash_out`. Es la
  fórmula de §6.1, **ya implementada**, y es un **snapshot de cierre** (como el
  total de un documento): una vez cerrado el turno no vuelve a moverse.
- **Lo LEÉS, no lo recalculás.** Si escribís esa resta otra vez en
  `app/banking/`, acabás de crear la segunda matemática que las reglas duras del
  proyecto prohíben, y el día que alguien cambie la definición de `tips_cash_out`
  vas a tener dos respuestas distintas a la misma pregunta.
- Lo que **sí** derivás, y que **no** puede ser una columna almacenada, es el
  **saldo**: `Σ to_deposit de los turnos cerrados del período − Σ consignaciones
  vivas imputadas a esos turnos`. Ése es el «por consignar» que se mueve, y es
  exactamente el tipo de columna que §6.1 dice que fue la única que se
  desincronizó en la referencia.
- `CashPickup` (retiros con snapshot) y `CashMovementCause.TIP_PAYOUT` ya existen:
  la mano del dueño se arma con ellos, no con tablas nuevas de retiro.

**La llave anti doble conteo de este territorio** —la que §6.1 pide diseñar antes
que las pantallas— es **retiro vs consignación**: una consignación se imputa a
turnos concretos y un mismo peso no puede estar «en la mano» y «en el banco» a la
vez. Escribila en tu entregable antes de la primera pantalla.

**Flags:** `money.deposits`, `money.bank` (con su dependencia `money.deposits`).

**Lee, no escribe:** `app/shifts/service.py` (`compute_breakdown` —la única
fórmula del esperado) y `app/shifts/hooks.py` (`get_sales_totals`,
`payment_bucket`, `register_*_expense/_income/_reversal`), `app/channels/`,
`app/payments/`.

### T2 — `backend-obligaciones` · lo que cuesta tener abierto

**Escribe:**
- `backend/app/expenses/**` (dominio nuevo, ya registrado)
- `backend/alembic/versions/0018_expenses.py` (ver la tabla de la cadena, arriba)
- `backend/tests/expenses/**`, `backend/tests/audit/test_expenses_invariants.py`
- **Excepción D-2**, acotada a lo que D-2 enumera, más
  `backend/alembic/versions/0019_invoice_total.py`.

**Construye:** gastos y **obligaciones agendadas** (arriendo, servicios, impuestos)
con su vencimiento y su estado; el arrastre de las **cuentas por pagar** de 2b al
resultado del período; **punto de equilibrio** y **utilidad** del período; D-2.

**LO QUE YA EXISTE Y NO SE RECALCULA:** las ventas netas y el costo teórico del
período los agrega `app/reports/service.py` (§6.4: el MVP ya calcula **margen
bruto** = ventas netas − costo teórico de lo vendido). **Leé esa agregación; no
vuelvas a sumar documentos de venta.** Lo que la utilidad agrega encima es lo de
abajo de esa línea: gastos, obligaciones, nómina. Y `CashMovementCause` ya tiene
`PETTY_EXPENSE`, `EMERGENCY_PURCHASE` y `OTHER_EXPENSE` para el gasto que **sí**
sale del cajón: no inventes una causa nueva para eso.

**Flags:** `money.obligations`.

**Ojo:** esta es plata que **nunca pasó por el cajón** (una transferencia de
arriendo). No la hagas entrar por `compute_breakdown`: el esperado del turno no se
toca. Si un gasto **sí** sale del cajón, entra por `shifts.hooks.register_*_expense`,
que ya existe, con causa tipada.

### T3 — `backend-nomina-propinas` · las personas

**Escribe:**
- `backend/app/payroll/**` (dominio nuevo, ya registrado)
- `backend/alembic/versions/0020_payroll.py`
- `backend/tests/payroll/**`, `backend/tests/audit/test_payroll_invariants.py`

**Construye:** jornada a partir del roster que el MVP ya captura (entradas, salidas,
pausas, turnos que cruzan medianoche partidos en dos días de negocio); **tablas de
recargos con vigencia**; liquidación de nómina del período; y **el reparto de
propinas** según D-3 (los tres métodos, default por horas, como propuesta que se
confirma).

**Flags:** `payroll`. El reparto de propinas va bajo `pos.tips` (ya existe).

**LO QUE YA EXISTE Y NO SE REESCRIBE (leelo antes de diseñar nada):**
- `app/shifts/models.py` ya tiene **`TipPayout` y `TipPayoutDistribution`**, y su
  docstring dice literalmente que «el cálculo del reparto es **manual** en esta
  fase: esta tabla sólo deja constancia de quién, cuánto y cuándo — nunca lo
  calcula». **Fase 3 es la fase en que llega el cálculo.** Así que D-3 **no crea
  tablas de reparto**: calcula la propuesta y la asienta en las que ya están.
- `app/shifts/tips.py` ya tiene **`get_shift_tips`** (propinas por medio, por
  persona y por comanda: de ahí sale el monto a repartir) y
  **`register_tip_payout(...)`**, que es la **única** puerta de escritura del
  reparto — con su endpoint `POST /admin/tips/payouts` ya publicado desde 1b-2.
- `app/shifts/models.py` ya tiene **`ShiftRoster`** con `in_at`, `out_at` y
  `pauses` (`[{"start": ..., "end": ...}]`): ésa es la jornada, no hay que
  capturarla de nuevo.
- `CashMovementCause.TIP_PAYOUT` ya existe desde 1b-1 para el egreso de caja
  cuando el dueño paga las propinas del cajón.

**Entonces tu trabajo es el cálculo, no la plomería**: `app/payroll/` computa la
**propuesta** (los tres métodos de D-3) leyendo `get_shift_tips` y `ShiftRoster`,
y el «confirmar» llama a `tips.register_tip_payout` tal cual. **`app/shifts/` no
es tu territorio y no lo tocás**: importás sus modelos y llamás a su función,
igual que `purchases` llama a `shifts.hooks.register_supplier_payment_expense`.

**Las tablas legales van parametrizadas, con fecha de vigencia, NUNCA quemadas en
código** (§7): nocturno 19:00–06:00 desde dic-2025; dominical 80/90/100 % en
2025/2026/2027 (Ley 2466 de 2025); jornada de 42 h desde jul-2026 (Ley 2101 de
2021). Van con vigencia porque cambian por ley, y **una nómina vieja tiene que
poder recalcularse con las tablas que regían ese mes** — hay un ítem del checklist
que lo exige con un test.

**Las horas no son pesos.** Definí su escala entera y declarala en `app/core/`,
igual que `QTY_SCALE` hizo con las cantidades. Un recargo calculado con `float` es
un error que nadie encuentra.

**LA LÍNEA QUE NO SE CRUZA, y la nómina es donde alguien va a intentar cruzarla:**
**el sistema NUNCA calcula una deuda del empleado ni genera un descuento de
nómina** por un faltante de caja (SPEC-NEGOCIO §3.2 y §11.16; CST art. 149
prohíbe deducir del salario sin orden escrita para cada caso). Ya hay un
invariante que barre las respuestas de turno buscando `debt`, `deuda`, `owes` y
`payroll_deduction` (`tests/audit/test_cash_invariants.py`); tu liquidación
**tampoco** puede tener un renglón así, ni siquiera opcional, ni siquiera en cero.
Un faltante de caja se resuelve con la causa tipada y la conversación que
corresponda, no descontándoselo a alguien.

### T4 — `backend-analitica` · qué conviene vender

**Escribe:**
- `backend/app/analytics/**` (dominio nuevo, ya registrado)
- `backend/alembic/versions/0021_analytics.py` (si necesita tablas; puede que casi
  todo sea derivado — **derivar en vez de almacenar**, §6.1)
- `backend/tests/analytics/**`, `backend/tests/audit/test_analytics_invariants.py`

**Construye:** **ingeniería de menú** (clasificación de platos por popularidad y
margen, sobre el costo **congelado en el ítem**, nunca revalorando con la carta de
hoy); **varianza por plato**, que §5.4 define explícitamente como «sólo estimación
prorrateada» — decilo así en la respuesta y en pantalla, con el método a la vista;
**reposición sugerida** y mínimo propuesto por consumo × lead time del proveedor;
**«sostenido»** según D-1.

**LO QUE YA EXISTE Y NO SE DUPLICA:**
- **«Cobro por mesero» YA ESTÁ CONSTRUIDO.** `GET /admin/sales?group_by=employee`
  agrupa por `charged_by_employee_id` desde 1b-2, y el «cierre de mesero» de §7
  (sus comandas, ventas por medio, propinas, anulaciones y descuentos) está desde
  1b. **No construyas un segundo reporte.** Caminalo; si al período le falta algo
  —por ejemplo la propina por mesero al lado de la venta— **declaralo como gap**:
  `app/reports/` no es territorio de nadie en este pedido.
- El costo congelado que necesita la ingeniería de menú **ya está en el ítem**:
  `OrderItem.unit_cost` (pesos, redondeado) y `unit_cost_micros` /
  `theoretical_cost_micros` (millonésimas). **Usá los micros y redondeá una sola
  vez al final** — `app/reports/service.py` ya documenta por qué sumar `unit_cost`
  en pesos pierde plata real con platos de costo menor a $1.
- **`GroupBy` NO tiene `"product"`** (`business_date`, `shift`, `method`,
  `channel`, `employee`, `hour`, `zone`): la agregación por plato es tuya y la
  hacés en `app/analytics/` sobre los `OrderItem`, sin tocar `app/reports/`.

**Flags:** `analytics.menu_engineering` (requiere `catalog.recipes`) e
`inventory.replenishment` (requiere `inventory.perpetual` y `purchases`), **ya
registradas** en `app/core/features.py` por el orquestador humano: no toques ese
archivo.

**No escribas en `app/inventory/` ni en `app/recipes/` ni en `app/orders/`.** Todo
lo que necesitás está publicado en sus `hooks.py` y en sus esquemas. Si falta una
costura, **declarala como gap**; no la abras vos.

### Contrato de API mínimo (vinculante para los cinco)

T5 arranca **a la vez** que los cuatro backends: no puede leer un OpenAPI que
todavía no existe. Por eso las rutas y los campos que siguen **están fijados acá**
y son vinculantes en las dos direcciones — un backend que publica otra ruta rompe
la pantalla, y una pantalla que consume otra ruta rompe la conciliación. Todo bajo
`/api/v1`, todo de admin (`/admin/...`), todo con su `require_feature`.

El **detalle interno de cada respuesta lo diseña su backend**: acá sólo se fija lo
que T5 necesita para existir y lo que el checklist va a medir.

**T1 — banking**
| Ruta | Qué devuelve / recibe |
|---|---|
| `GET /admin/deposits` | consignaciones del período (`from`/`to`), con comprobante |
| `POST /admin/deposits` | registra una consignación (`Idempotency-Key`) |
| `GET /admin/deposits/pending` | saldo por consignar por turno cerrado: `shift_id`, `business_date`, `to_deposit` (**leído de `Shift.to_deposit`**), `deposited`, `outstanding`; `to_deposit: null` con `reason` cuando el turno cerró sin conteo |
| `GET /admin/bank/ledger` | libro del banco del período: consignaciones, liquidaciones de datáfono, transferencias |
| `GET /admin/bank/owner-hand` | mano del dueño: `withdrawn`, `deposited`, `spent`, `balance` |
| `GET /admin/reconciliation/card` · `.../platform` | conciliación: lo esperado, lo liquidado, la diferencia, y `matched`/`unmatched` |
| `POST /admin/reconciliation/card/{id}/settle` | concilia una liquidación (`Idempotency-Key`) |

**T2 — expenses**
| Ruta | Qué devuelve / recibe |
|---|---|
| `GET`/`POST /admin/expenses` | gastos del período |
| `GET`/`POST /admin/obligations` | obligaciones agendadas, con `due_date` y `status` |
| `POST /admin/obligations/{id}/settle` | la salda (`Idempotency-Key`) |
| `GET /admin/break-even` | `fixed_costs`, `contribution_margin_pct_bp`, `break_even_amount`, `available: bool`, `reason: str \| null`. **Sin costos fijos cargados: `break_even_amount: null` con `reason`, jamás `0`.** |
| `GET /admin/profit` | resultado del período: ventas netas, costo, gastos, obligaciones, nómina, `profit`, con los mismos `available`/`reason` |
| `GET /admin/payables/{id}` (extensión D-2) | gana `invoice_total: int \| null` e `invoice_discrepancy: int \| null` |
| `POST /admin/payables/{id}/approve` (extensión D-2) | acepta `confirm_discrepancy: bool`; sin él y con diferencia, `409 INVOICE_DISCREPANCY` |

**T3 — payroll**
| Ruta | Qué devuelve / recibe |
|---|---|
| `GET /admin/payroll/hours` | jornada por persona del período: ordinarias, nocturnas, dominicales, festivas, extras |
| `GET`/`POST /admin/payroll/surcharge-tables` | tablas de recargos **con `valid_from`** |
| `GET /admin/payroll/runs` · `POST /admin/payroll/runs` | liquidación del período; la respuesta nombra **qué tabla vigente** usó |
| `GET /admin/tips/distribution/proposal` | **propuesta** de reparto: `method`, `rows[{employee_id, employee_name, basis, amount}]`, `total`. Nunca mueve plata. |
| `POST /admin/tips/payouts` | **YA EXISTE** (1b-2, `app/shifts/`): es el «confirmar». No lo reescribas ni lo dupliques. |
| `GET`/`PATCH /admin/tips/settings` | `method` ∈ `equal_shares` \| `by_hours` \| `by_area`, default `by_hours` (D-3) |

**T4 — analytics**
| Ruta | Qué devuelve / recibe |
|---|---|
| `GET /admin/menu-engineering` | clasificación por plato del período, sobre el **costo congelado**; `available`/`reason` cuando no hay ventas |
| `GET /admin/variance/by-dish` | varianza por plato, con `method: "prorated"` **explícito** en la respuesta (§5.4) |
| `GET /admin/control-health/sustained` | D-1: `sustained_red: bool \| null`, `windows_evaluated`, `reason` cuando son menos de dos |
| `GET /admin/replenishment` | reposición sugerida: por insumo, `suggested_qty`, `suggested_min`, `lead_time_days`, `based_on` |

«Cobro por mesero» **no lleva ruta nueva**: es `GET /admin/sales?group_by=employee`,
que existe desde 1b-2. T5 lo alcanza desde la pantalla de Ventas que ya está.

**Reglas que valen para todas.** Rango de período con `from`/`to` en **fecha de
negocio** (nunca timestamps UTC). Plata en **enteros de pesos**. Porcentajes en
**puntos básicos** (`_bp`). Todo indicador sin datos suficientes: el valor es
`null` y viene acompañado de `reason` — **nunca `0`, nunca una lista vacía muda**.
Si tu backend necesita una ruta que no está en esta tabla, **agregala y declarala
en tu entregable**; si necesitás cambiar una que sí está, **no la cambies**:
declaralo como gap, porque del otro lado hay una pantalla que ya la consume.

### T5 — `frontend-fase3` · todas las pantallas

**Escribe:**
- `frontend/src/features/{banking,expenses,payroll,analytics}/**`
- `frontend/src/api/{banking,expenses,payroll,analytics}.ts`
- sus `__tests__/`

**No escribe** `src/components/ui/**` ni `src/app/**` salvo colgar los cuatro
`<dominio>Feature` nuevos en el router y la navegación del admin — **eso sí es
suyo**, y es el único que los toca.

**Sos el cuello de botella de este pedido y lo sabés.** Prioridad explícita, en
este orden: **(1)** que **toda** capacidad de backend tenga **una** pantalla que la
alcance, aunque sea mínima; **(2)** que ninguna pantalla derive plata; **(3)**
pulido. Una capacidad sin pantalla es una capacidad que el dueño no puede usar, y
vale menos que cuatro pantallas lindas y cuatro capacidades inalcanzables.

Reusá lo que ya existe: `DateRangeFilter`, `CsvExportButton`, `StatTile`,
`MoneyInput`, `EmployeePicker`, y el `Select` que deriva sus `items` de los hijos.
**Y la regla de los portales** (`docs/CONTEXTO-AGENTES.md §10`): nunca un
`getAllByRole("option")` síncrono — ya se rompió cuatro veces y hay un invariante
que lo hace cumplir sobre todo el repo.

### T6 — `auditor-fase3` (opus) · invariantes ejecutables

**Escribe:** `backend/tests/audit/test_contract_fase3_invariants.py` (el mismo
patrón de nombre que `test_contract_2b_invariants.py` y
`test_contract_2c_invariants.py`, que ya están) y, en `frontend/src/audit/`,
archivos con nombre **por tema** como los que ya hay (`active-channels.test.ts`,
`cost-display.test.tsx`, `portal-queries.test.ts`): p. ej.
`money-after-drawer.test.ts`, `break-even.test.ts`, `payroll.test.ts`,
`menu-engineering.test.ts`. **Ningún archivo de producción, nunca**, y ningún
nombre que pise uno existente.

**Tu trabajo no es confirmar que el equipo hizo lo que dijo: es encontrar dónde
mintieron los números.** Un hallazgo se escribe como **un test rojo a propósito**,
con el defecto explicado en el docstring, su dueño y su remedio. No lo ablandes
para ponerlo verde.

Cruces obligatorios, por orden de daño:
1. **La plata cierra.** El esperado del turno **no se movió** por nada de esta
   fase (T1 y T2 agregan plata que no pasa por el cajón). Medilo: leé el esperado
   antes y después de cada flujo nuevo.
2. **Nadie escribió una segunda matemática.** `compute_breakdown` sigue siendo la
   única fórmula del esperado, `payment_bucket` el único clasificador,
   `resolve_ingredient_cost` la única jerarquía de costo.
3. **`null` con motivo** en todo indicador sin datos: punto de equilibrio sin
   costos fijos cargados, ingeniería de menú sin ventas del período, «sostenido»
   con menos de dos ventanas, food cost real sin dos conteos completos.
4. **Ningún `float`** en ningún cálculo nuevo, en ninguna de las dos capas.
5. **Una tabla legal vieja recalcula con las tablas de su época**, no con las de
   hoy.
6. **El operador sigue sin ver costos ni márgenes**, y ahora tampoco nómina ajena
   ni el reparto de propinas de otro.
7. **Toda capacidad nueva responde `400 FEATURE_DISABLED`** con su función apagada,
   y la dependencia se valida **antes** que el gate de sede.
8. **La supresión de D-4** anonimiza y **no** borra el asiento, y su auditoría
   guarda sólo **nombres** de campos.

---

## 3. Convenciones de ingeniería de esta fase

Las de 1a, 1b, 2a, 2b y 2c (están en `docs/CONTEXTO-AGENTES.md`), más:

- **La plata sigue en enteros de pesos.** Toda magnitud nueva que no sea plata
  (horas, tasas, puntos porcentuales) **declara su escala entera** en `app/core/`.
  Porcentajes en puntos básicos (`_bp`).
- **Toda tabla legal va con vigencia**, y rige la de mayor `valid_from ≤` la fecha
  consultada — el mismo patrón que `StoreFiscalConfig` ya usa. Nunca quemada.
- **Toda la matemática nueva es del backend.** Punto de equilibrio, reparto de
  propinas, clasificación de la ingeniería de menú, recargos: se calculan en el
  servidor; el cliente pinta lo que llega.
- **«Sin datos» se dice**, con motivo. Nunca `$0`, nunca una tabla vacía muda.
- **Derivar en vez de almacenar** (§6.1): «por consignar», saldo, esperado, utilidad.
  La única columna almacenada de ese tipo en la referencia fue la que se
  desincronizó.
- **Las llaves anti doble conteo se diseñan antes que las pantallas** (§6.1): retiro
  vs consignación, pago vs movimiento de banco, egreso vs recepción, propina vs
  venta. Escribí cuál es la tuya en tu entregable, antes de la primera pantalla.
- **Nada financiero se borra**: baja lógica y auditoría con antes y después.
- **La configuración por sede de tu dominio vive en TU tabla**, no en
  `app/stores/models.py`. Es el precedente que ya sentaron 2a y 2b
  (`StoreInventorySettings` vive en `app/inventory/`), y acá además evita que
  cuatro agentes en paralelo se peleen el mismo archivo: `app/stores/` **no es
  territorio de nadie en este pedido**. Lo mismo vale para el método de reparto de
  propinas de D-3.
- Alembic: **el número que te asigna §2**, no «el siguiente».

---

## 4. Checklist de verificación de la fase

Lo corre el orquestador humano contra el **código**, no contra los reportes.

**Plata y cajón**
- [ ] El esperado del turno no cambió por ninguna capacidad de esta fase.
- [ ] «Por consignar» es derivado, no una columna.
- [ ] Un gasto que **no** pasa por el cajón no toca `compute_breakdown`; uno que sí
      entra por `shifts.hooks.register_*_expense` con causa tipada.
- [ ] La mano del dueño cuadra: retirado − consignado − gastado.
- [ ] Conciliación de datáfono y plataformas contra lo que `channels` ya registró,
      sin duplicar la cuenta por cobrar.

**Números del mes**
- [ ] Punto de equilibrio y utilidad son `null` **con motivo** sin costos fijos.
- [ ] `invoice_total` e `invoice_discrepancy` (D-2) existen, y una cuenta con
      diferencia **no se aprueba sola**.
- [ ] Ingeniería de menú sobre el costo **congelado en el ítem**; ninguna consulta
      revalora una venta pasada con la carta de hoy.
- [ ] La varianza por plato **se declara prorrateada** en la respuesta y en pantalla.
- [ ] «Sostenido» implementa D-1 exactamente, y `_variance_level` **no se tocó**.

**Personas**
- [ ] Ningún cálculo de recargo con `float`; las horas tienen escala entera declarada.
- [ ] Tabla legal con vigencia + un test que **recalcula un período viejo con las
      tablas de ese período**.
- [ ] El reparto de propinas ofrece los tres métodos de D-3, default por horas, y es
      una **propuesta que se confirma**, no una transferencia automática.
- [ ] Un operador no ve la nómina de otro ni el reparto ajeno.

**Transversal**
- [ ] Toda capacidad detrás de su función, con `400 FEATURE_DISABLED`, probada
      encendida y apagada; dependencia validada **antes** que el gate de sede.
- [ ] El operador sigue sin ver costos ni márgenes.
- [ ] Las rutas del **contrato de API mínimo** existen tal cual están escritas, y
      las pantallas consumen ésas y no otras.
- [ ] `alembic heads` devuelve **una sola cabeza**, y `alembic upgrade head` desde
      cero **en Postgres**, no sólo en SQLite.
- [ ] `python -m mypy app` limpio; `npm run typecheck` limpio.
- [ ] Suite completa de backend y de frontend en verde, en serie, con el árbol
      quieto.
- [ ] **Recorrido en navegador real antes de cerrar.** Es la única forma que
      encontró siete de los defectos de la fase 2, y el CI encontró tres más que
      1.395 tests no vieron. No se cierra la fase sin caminarla.

---

## 5. Lo que NO entra en esta fase

- **La conexión real con el proveedor tecnológico de facturación.** Sigue siendo un
  bloqueante comercial, no técnico: `GET /admin/fiscal/export` devuelve un
  manifiesto JSON con hash por documento porque todavía no hay XML que empaquetar.
  El adaptador `FiscalProvider` ya está listo para recibirlo.
- **Multi-sede comparativo** (`multi_store`): está en el catálogo desde 1a y no lo
  pide §14 para esta fase.
- **Cualquier cosa que no esté en la fila «3. Dinero y control» de §14.** Si
  encontrás algo que falta, va a `gaps`, no al código.
