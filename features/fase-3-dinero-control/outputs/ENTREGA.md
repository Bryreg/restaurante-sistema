# Entrega final — Fase 3 «Dinero y control»

Cierre del ciclo del Maestro Orquestador. Un solo pedido, once capacidades,
seis agentes, dos rondas. Este documento dice qué equipo armé y por qué, qué
construyó y halló cada uno, qué verifiqué **yo contra el código** (no contra los
reportes), qué quedó abierto —sin esconder nada— y en qué orden conviene seguir.

---

## Veredicto

**El backend de la fase está construido y es coherente. El producto todavía no se
puede usar de punta a punta en tres de las once capacidades —ni en la utilidad del
período, que es el objetivo textual de la fase—**, y no porque falte matemática:
faltan **tres pantallas de carga** (costos fijos, tarifa por hora, liquidaciones
del datáfono). Los cuatro backends responden `null` con motivo, correctamente,
porque el dato que necesitan **no tiene por dónde entrar**. El detalle está en
`§5 A-1`, y es el trabajo que yo pondría primero.

Los siete hallazgos del auditor (§3) están **cerrados en el código**, verificados
uno por uno abriendo el archivo. La cadena de Alembic llega a una sola cabeza y
corre desde cero **en Postgres real**, ida y vuelta. Ningún agente escribió fuera
de su territorio. `mypy` y `tsc` limpios, el build pasa.

**Pero la suite no cierra en verde: 4 rojos en backend y 1 en frontend** sobre
2.070 tests (1.520 de backend, 550 de frontend). Ninguno es una cifra de plata
equivocada: uno venía rojo **desde antes de esta fase**, uno es el poste de
Alembic que había que mover y que yo no
le asigné a nadie, y tres son invariantes que quedaron mal medidos o
desactualizados **por los arreglos de la ronda 2 que ellos mismos pidieron**,
porque el auditor no volvió a correr después. Están todos en `§4`, clasificados,
con su remedio. **La fase no se da por cerrada así**, y la parte del error que es
mía la digo en `§4` y en `§6`.

---

## 1. El equipo que armé, y por qué ése

El pedido tiene once capacidades, pero su dificultad no es el tamaño: son **tres
dominios de datos sin territorio en común** —la plata después del cajón, lo que
cuesta tener abierto, y las personas— más una capa analítica derivada, y **cuatro
backends escribiendo a la vez sobre el mismo árbol**. El riesgo real era que dos
agentes escribieran el mismo archivo, no que alguno no supiera sumar.

| Agente | Modelo | Territorio | Por qué existe como rol separado |
|---|---|---|---|
| `backend-banco` (T1) | sonnet | `app/banking/**`, `0017`, D-4 | La trazabilidad del efectivo es un dominio propio: su riesgo central es el doble conteo entre «en la mano» y «en el banco». D-4 va acá porque toca `pending_refunds`, que es **registro financiero vivo**: pertenece a quien razona sobre plata, no a quien razona sobre reportes. |
| `backend-obligaciones` (T2) | sonnet | `app/expenses/**`, `0018`, `0019`, D-2 | Aritmética de resultado del período sobre una agregación que **ya existe** (`app/reports/`). Se lleva D-2 porque es quien arrastra las cuentas por pagar al resultado del mes. |
| `backend-nomina-propinas` (T3) | sonnet | `app/payroll/**`, `app/core/hours.py`, `0020` | Único territorio **con ley encima** (Ley 2466/2025, 2101/2021, 1935/2018, CST art. 149) y con una línea que nadie puede cruzar: el sistema nunca calcula una deuda del empleado. |
| `backend-analitica` (T4) | sonnet | `app/analytics/**` | Analítica derivada sobre snapshots congelados. Su trampa es revalorar una venta pasada con la carta de hoy, o construir un segundo «cobro por mesero» que ya existía. |
| `frontend-fase3` (T5) | sonnet | las cuatro pantallas + `api/*.ts` | Cuello de botella declarado. Arranca **a la vez** que los cuatro backends gracias al contrato de API mínimo. |
| `auditor-fase3` (T6) | **opus** | sólo tests de auditoría | Su trabajo no es confirmar que el equipo hizo lo que dijo: es **encontrar dónde mintieron los números**. |

**Los modelos, y por qué.** Los cinco constructores en `sonnet` porque construyen
sobre un contrato ya cerrado: las decisiones difíciles (D-1 a D-4, la cadena de
Alembic, las rutas) estaban tomadas y escritas, y lo que quedaba era ejecución
disciplinada. El auditor en `opus` porque su tarea es la contraria: cruzar cuatro
dominios que nadie leyó juntos, sostener ocho invariantes a la vez y distinguir
«todavía no lo construyeron» de «lo construyeron mal» **mientras el árbol se
mueve debajo**. Ninguno en `haiku`: no había trabajo mecánico en este pedido.
El resultado avala el reparto — los siete hallazgos salieron del auditor, ninguno
de los cinco constructores encontró el defecto del otro.

**A quién dejé afuera, a propósito.** `agente-contador` y `agente-legal` como
roles separados: su materia (resultado del período, Ley 1935, CST art. 149,
habeas data) está repartida **dentro** de T1, T2 y T3, y sacarla afuera creaba un
quinto escritor sobre archivos que ya tenían dueño. `agente-datos`: la fase no
pedía refinamiento de presentación sino **cobertura** — una capacidad sin pantalla
vale menos que cuatro pantallas lindas. (En `§6` está la única parte de esa
decisión que hoy revisaría.)

**La costura que tuve que resolver yo, antes de lanzar.** §3 manda declarar la
escala entera de toda magnitud nueva «en `app/core/`», y `app/core/` **no tenía
dueño** en §2. La única magnitud nueva real es la hora (los porcentajes ya tenían
`_bp`). Le di a T3 la propiedad exclusiva de **un** archivo nuevo,
`backend/app/core/hours.py`, sin tocar ningún archivo existente de `app/core/`, y
les prohibí a los otros cuatro crear archivos ahí. Sin eso, dos agentes podían
crear el mismo archivo en la misma ronda. Quedó así: `HOURS_SCALE = 60`, minutos
enteros, `Decimal` sólo para publicar, y ningún otro archivo nuevo en `app/core/`
(verificado: `git status` no muestra otro).

---

## 2. Qué construyó cada agente

(Los conteos de tests por territorio son los de la corrida de cada agente; el
número que medí yo es el de la suite completa, en `§4`.)

### T1 · `backend-banco` — la plata después del cajón

Cuatro tablas (`bank_deposits`, `bank_deposit_allocations`, `card_settlements`,
`platform_settlements`) y **nada más almacenado**: el «por consignar», la mano
del dueño y las transferencias del libro son derivados en cada lectura.

- **La llave anti doble conteo**: `Σ imputaciones vivas del turno + la nueva ≤
  Shift.to_deposit`, validada **antes** de escribir una fila, con `SELECT … FOR
  UPDATE` sobre el turno (`app/banking/service.py`). `Shift.to_deposit` se **lee**;
  nunca se recalcula (invariante del auditor: ningún dominio nuevo nombra siquiera
  `counted_cash_total`, `opening_cash_fixed` ni `tips_cash_out`).
- Consignaciones con comprobante obligatorio, reversa lógica (nada se borra),
  libro del banco, mano del dueño (`retirado − consignado − gastado = saldo`),
  conciliación de datáfono y de plataformas contra lo que `channels` ya registró.
- **D-4**: `app/refunds/service.py::anonymize_pending_refunds_for_customer`
  anonimiza `customer_name` y **conserva** monto, documento, estado y autorizador;
  la auditoría guarda `before={"cleared_fields": ["customer_name"]}` — sólo el
  nombre del campo, nunca el dato (la lección del bloqueante B-1 de 1b-2).

Archivos: `backend/app/banking/{models,schemas,service,router,hooks}.py`,
`backend/alembic/versions/0017_banking.py`, `backend/tests/banking/**` (40 tests),
`backend/tests/audit/test_banking_invariants.py`, y la excepción D-4 en
`backend/app/refunds/service.py` + `backend/app/customers/service.py:238-260`.

### T2 · `backend-obligaciones` — lo que cuesta tener abierto

- **La llave**: `Expense`/`Obligation` **nunca** leen `Payable`/`Payment` y
  **nunca** crean un `CashMovement`. El gasto que sí sale del cajón entra primero
  por `shifts.hooks` con causa tipada y acá sólo se **referencia**
  (`cash_movement_id` validado). No es una promesa: no existe la línea que
  escribiría un movimiento.
- Punto de equilibrio y utilidad **leen** `app/reports/service.py::aggregate_sales`
  una sola vez; no vuelven a sumar documentos de venta.
- **D-2**: `Reception.invoice_total` (lo que dice el papel) convive con
  `Payable.amount` (lo calculado, que no cambia de significado), y la diferencia
  se publica. `POST /admin/payables/{id}/approve` corta con **409
  `INVOICE_DISCREPANCY`** nombrando **las dos cifras**
  (`app/purchases/service.py:672-682`), salvo `confirm_discrepancy: true`, que
  queda registrado con quién. Es el patrón de `confirm_price`, no un dialecto nuevo.

Archivos: `backend/app/expenses/**`, `backend/alembic/versions/0018_expenses.py`
y `0019_invoice_total.py`, `backend/tests/expenses/**` (53 tests),
`backend/tests/audit/test_expenses_invariants.py`, y la excepción D-2 acotada en
`backend/app/purchases/{models,schemas,router,service}.py`.

### T3 · `backend-nomina-propinas` — las personas

- **Jornada** a partir del `ShiftRoster` que el MVP ya captura, partida en piezas
  que no cruzan ni el corte de negocio, ni la medianoche, ni el borde de la
  ventana nocturna vigente.
- **Tablas legales con vigencia** (`payroll_surcharge_tables`), sembradas por sede
  con seis vigencias (2020, 2025, dic-2025, 2026, jul-2026, 2027) y **editables
  por API**: nada quemado en código. La liquidación nombra **qué tabla usó**.
- **D-3**: los tres métodos (`equal_shares`, `by_hours`, `by_area`), default por
  horas como configuración de sede, y la propuesta es **sólo lectura** — no hay un
  `db.add` en todo el camino. El «confirmar» sigue siendo
  `app/shifts/tips.py::register_tip_payout`, sin tabla nueva ni segunda puerta.
- **La línea que no se cruza**: ninguna respuesta ni columna de nómina nombra una
  deuda del empleado ni un descuento por faltante (CST art. 149), barrido por
  invariante.
- `app/payroll/hooks.py::period_payroll_cost` es la costura que T2 había declarado
  **antes** de que este dominio existiera, con la firma exacta. Verificado: los
  dos lados coinciden, y el hook llama a la misma función que `POST
  /admin/payroll/runs` — nunca una segunda nómina.

Archivos: `backend/app/payroll/**`, `backend/app/core/hours.py`,
`backend/alembic/versions/0020_payroll.py`, `backend/tests/payroll/**` (34 tests),
`backend/tests/audit/test_payroll_invariants.py`.

### T4 · `backend-analitica` — qué conviene vender

- **Sin `models.py` y sin migración `0021`**: todo derivado, nada almacenado. Como
  `0021` era la última de la cadena, no hubo nada que reencadenar.
- **Ingeniería de menú** sobre `unit_cost_micros`/`theoretical_cost_micros`
  (el costo **congelado en el ítem**), redondeando una sola vez.
- **Varianza por plato** con `method: "prorated"` **fijado en el esquema** — no se
  puede apagar con un parámetro — y con el valor que no se puede atribuir a ningún
  plato declarado aparte (`unattributed_variance_value`) en vez de repartido a la
  fuerza.
- **D-1 «sostenido»** exactamente como se decidió: rojo en **2 de las últimas 3
  ventanas computables**; con menos de dos, `null` **con motivo**, nunca verde.
  `_variance_level` no se tocó (huella AST idéntica).
- Caminó «cobro por mesero» y **no construyó un segundo reporte**: confirmó que
  `GET /admin/sales?group_by=employee` ya trae la propina al lado de la venta.

Archivos: `backend/app/analytics/{schemas,service,router,hooks}.py`,
`backend/tests/analytics/**` (33 tests),
`backend/tests/audit/test_analytics_invariants.py`.

### T5 · `frontend-fase3` — las pantallas

Cuatro dominios nuevos (`/admin/banco`, `/admin/gastos`, `/admin/nomina`,
`/admin/analitica`), colgados en `router.tsx` y `AdminLayout.tsx` —los dos únicos
archivos ajenos que tocó, y le correspondían—. **Las once capacidades tienen una
pantalla que las alcanza**, más utilidad del período y D-2. El `null` con motivo
llega del servidor y se pinta tal cual, nunca como `$0` ni como tabla vacía muda.
Queda **una sola resta hecha en el cliente** —el remanente sin imputar del diálogo
de consignación, rotulado en pantalla como «ayuda de captura, no es una cifra del
sistema»— y es justamente la que el invariante R-5 sigue marcando: ver `§4`.

Archivos: `frontend/src/features/{banking,expenses,payroll,analytics}/**`,
`frontend/src/api/{banking,expenses,payroll,analytics}.ts`, sus `__tests__/`.

### T6 · `auditor-fase3` — los invariantes

`backend/tests/audit/test_contract_fase3_invariants.py` (133 casos) más
`frontend/src/audit/{money-after-drawer,break-even,payroll}.test.ts` y
`menu-engineering.test.tsx`. **Ningún archivo de producción**, ni siquiera para
arreglar lo que encontró: cada hallazgo se escribió como **test rojo a propósito**,
con el defecto en el docstring, su dueño y su remedio.

Cubre los ocho cruces obligatorios, las cuatro decisiones y el contrato: las 31
rutas contra el OpenAPI real, las 19 rutas nuevas contra una sesión **real** de
dispositivo con un operador (todas 401/403), 16 combinaciones de
`FEATURE_DISABLED` encendida y apagada, la dependencia validada **antes** que el
gate de sede, un período viejo liquidado con la tabla de su época (reloj movido
con `app/core/clock.py`), y un barrido AST de `float` en las dos capas.

Y corrigió **dos invariantes mal medidos** en vez de ablandarlos: `expected` a
secas cazaba «lo esperado del datáfono» (se acotó a `expected_cash`), y la prueba
de pantalla de ingeniería de menú medía un campo que la pantalla no publica (se
reescribió sobre el que sí pinta). Un invariante mal medido no es un invariante:
es ruido que enseña a ignorar el rojo.

---

## 3. Coherencia: cómo cerró el ciclo

**Ronda 1** — cinco constructores y el auditor en paralelo. El auditor encontró
**siete defectos**, ninguno de ellos visible desde adentro de un solo territorio:
cada mitad pasaba sus propios tests.

| # | Qué estaba mal | Severidad | Dueño |
|---|---|---|---|
| C1/H-1 | D-4 escrita y **nadie la llamaba**: tras `erase_customer`, el nombre seguía en `pending_refunds` (Ley 1581) | bloqueante | T1 |
| C2/H-2 | `GET /admin/tips/distribution/proposal` exigía `shift_id`; la pantalla manda `from`/`to` → **422 siempre** | bloqueante | T3 (+T5) |
| C3/H-3 | `GET /admin/variance/by-dish` exigía `count_id`; la pantalla manda sólo `store_id` → **422 siempre** | bloqueante | T4 (+T5) |
| C4/H-4 | «Por consignar» publicaba **$0 sin motivo** para un turno cerrado sin conteo (la condición miraba `to_deposit is None`, que el cierre administrativo nunca deja) | bloqueante | T1 |
| C5/H-6 | El diálogo de consignación sacaba el monto de un `reduce` → **no se podía registrar la consignación de la mano del dueño** | bloqueante | T5 |
| C6/H-5 | `app/banking/` decidía por su cuenta qué medios son electrónicos, en vez de preguntarle a `payment_bucket` | advertencia | T1 |
| C7/H-7 | El default `by_hours` de D-3 vivía también en el cliente | advertencia | T5 |

Vale la pena mirar esa lista contra «Lo que más veces salió mal» de
`docs/CONTEXTO-AGENTES.md §14`: H-4 es el **error repetido nº7** (un cero mudo
donde correspondía `null` con motivo); H-2 y H-3 son el **nº8** (lo que sólo se ve
caminando la aplicación, cazado acá por cruce estático); y el bloqueo de
verificación que apareció entre rondas —la FK inline en un `add_column` de `0019`—
es el **nº4** (lo que pasa en SQLite y tumba el deploy en Postgres), que T2 cerró
con el guard por dialecto. **La lista del proyecto predijo tres de los siete.**
Eso no es mala suerte: es la evidencia de que vale la pena escribirla.

**Ronda 2** — cinco agentes, cambios quirúrgicos, el auditor no volvió a correr
(sus invariantes ya estaban escritos y son el criterio de aceptación). Verifiqué
los siete **en el árbol, abriendo el archivo**, no en los reportes:

| # | Dónde quedó cerrado (verificado por mí) |
|---|---|
| C1 | `backend/app/customers/service.py:238-259` — `erase_customer` llama a `anonymize_pending_refunds_for_customer` con `find_spec_safe` dentro de la función |
| C2 | `backend/app/payroll/router.py:400-412` — `from`/`to` obligatorios en fecha de negocio; `shift_id` queda como override opcional |
| C3 | `backend/app/analytics/router.py:108` — `count_id: int \| None = Query(default=None)`; sin él resuelve el último conteo aplicado, y sin ninguno devuelve `available: false` con motivo (no 404 ni 422) |
| C4 | `backend/app/banking/service.py:337` — `if shift.closed_without_count or shift.to_deposit is None:` → `null` con motivo |
| C5 | `frontend/src/features/banking/CreateDepositDialog.tsx:67,128,160-161` — el monto es un `MoneyInput` propio; las imputaciones son opcionales; `allocations: []` se puede guardar |
| C6 | `backend/app/banking/service.py:54,69-70` — los conjuntos `CARD_/TRANSFER_PAYMENT_METHODS` se **derivan** preguntándole a `payment_bucket` |
| C7 | `frontend/src/features/payroll/TipsTab.tsx:55` — `value={query.data.method}`, sin `?? "by_hours"` |

**Los siete están cerrados en el código; dos de ellos dejaron su invariante
rojo.** C6/H-5 y C5/H-6 se arreglaron de una forma que el test que los cobró
—escrito antes del arreglo— sigue marcando: en el primero la heurística no
distingue «preguntarle a la autoridad» de «decidir por mi cuenta»; en el segundo
el invariante prohíbe toda resta de plata en el cliente y el arreglo dejó una. Uno
es un invariante a re-medir y el otro es un arreglo al 90 % — los dos con su
remedio en `§4`, R-3 y R-5. **Verificar leyendo el archivo no reemplaza correr el
test**, y eso es exactamente lo que faltó en la ronda 2.

**Veredicto del Conciliador tras la ronda 2: coherente, sin conflictos.** Lo
confirmo con dos cruces propios:

1. **Territorios.** `git status --porcelain -uall` muestra que los únicos archivos
   ajenos tocados son los cuatro autorizados: `purchases/*` (D-2, acotado a la
   columna, el campo del esquema, el derivado y la aprobación), `refunds/service.py`
   y `customers/service.py` (D-4), y `frontend/src/app/{router,AdminLayout}.tsx`
   (T5, que era suyo). **`app/main.py`, `app/core/models_registry.py` y
   `app/core/features.py` no se tocaron.** Ningún archivo tiene dos dueños.
2. **Las dos mitades hablan.** Crucé **los 30 clientes** de `src/api/*.ts` contra
   las firmas de los cuatro routers: rutas, verbos, parámetros de consulta y
   cuerpos coinciden — incluido `POST /admin/tips/payouts`, que es de
   `app/shifts/` desde 1b-2 y no se duplicó. No quedó ningún H-2/H-3 más.

---

## 4. Verificación — lo que corrí yo, contra el código

Árbol quieto, en serie, sin ningún agente trabajando (confirmado con `ps`: ningún
proceso de test o build huérfano antes de arrancar). Ningún `npm run build`
mientras corría la suite.

### La cadena de migraciones, en Postgres real

No sólo en SQLite: el error repetido nº4 del proyecto sólo se ve ahí.

```
$ sudo -u postgres psql -c "CREATE DATABASE fase3_maestro;"
$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fase3_maestro" python -m alembic upgrade head
… 0016 -> 0017 (banking) · 0017 -> 0018 (expenses) · 0018 -> 0019 (D-2) · 0019 -> 0020 (payroll)
$ … alembic heads
0020 (head)                     ← una sola cabeza
$ … alembic downgrade 0016      → 4 migraciones revertidas, limpio
$ … alembic upgrade head        → 4 migraciones reaplicadas, limpio
```

- **94 tablas** en el esquema final (contra 80 al cierre de 2c): las **14 nuevas**
  de la fase, ni una más — `bank_deposits`, `bank_deposit_allocations`,
  `card_settlements`, `platform_settlements`, `expenses`, `obligations`,
  `store_expenses_settings`, `payroll_surcharge_tables`, `payroll_holidays`,
  `payroll_wage_rates`, `payroll_area_assignments`,
  `payroll_tip_distribution_settings`, `payroll_runs`, `payroll_run_lines`.
- La FK de D-2 **sí existe en Postgres**
  (`fk_payables_discrepancy_confirmed_by_employee_id` sobre `payables`), que es
  justamente lo que el guard por dialecto de `0019` tenía que preservar: la
  columna se agrega plana y la constraint se crea aparte, sin `batch_alter_table`.
- **`0021_analytics` no existe, y está bien**: T4 no necesitó tablas y era la
  última de la cadena, así que no hay nada que reencadenar.

### Las rutas del contrato existen, contra el OpenAPI de la app real

Levanté la aplicación y le pedí su OpenAPI (205 rutas en total). Crucé **las 24
rutas del contrato mínimo de §2**, incluidas las de plantilla
(`/admin/reconciliation/card/{id}/settle`, `/admin/obligations/{id}/settle`,
`/admin/payables/{id}`, `/admin/payables/{id}/approve`): **no falta ninguna**.

Y crucé, en la otra dirección, las **46 rutas** de los cuatro dominios nuevos
contra los **30 clientes** de `src/api/*.ts`: parámetros de consulta y cuerpos
coinciden en todas las que la interfaz consume (no quedó ningún H-2/H-3), pero
**18 rutas no las consume ninguna pantalla** → `§5 A-1`.

### Gates, territorios y reglas duras (lectura de código)

| Qué | Resultado |
|---|---|
| Toda ruta nueva detrás de su función | 46/46 (`expenses` gatea a nivel de router, los otros tres por ruta) |
| Dependencia validada **antes** del gate de sede | `_require_bank`, `_require_menu_engineering`, `_require_replenishment` encadenan la dependencia primero |
| Toda ruta acotada por organización y sede | 46/46 pasan por `admin_store` |
| `Idempotency-Key` en lo que escribe | 28 usos entre los tres dominios que escriben |
| Ningún `float` en el código nuevo | ninguno en los cuatro dominios ni en `app/core/hours.py` |
| Nada financiero se borra | ningún `db.delete(` en los cuatro dominios |
| Nadie tocó lo compartido | `app/main.py`, `app/core/models_registry.py` y `app/core/features.py` sin modificar |
| Ningún archivo con dos dueños | los 8 tracked modificados son las excepciones autorizadas (D-2, D-4, router/nav de T5) |
| **Ningún test existente se modificó** | los 8 archivos tracked modificados son todos de producción: nadie ablandó un invariante viejo para ponerse en verde |
| Sin `localStorage` en el código nuevo del cliente | ninguno |
| Regla de los portales | el único `getAllByRole("option")` nuevo viene precedido de su `findByRole` |
| Operador | los cuatro dominios exportan `posRoutes: []` y `posNav: []` |
| Ninguna pantalla deriva plata | quedan **dos** aritméticas en el cliente, las dos declaradas como ayuda de captura y revalidadas por el servidor: el `% → puntos básicos` al teclear una tabla de recargos (conversión de entrada, no una cifra de plata) y el remanente sin imputar del diálogo de consignación — **éste sí es una diferencia de plata y es el rojo R-5** |

### Suites, typecheck y build

Una sola corrida, en serie, con el árbol quieto. Resultado literal:

```
$ cd backend && TMPDIR=/tmp/pt-maestro python -m pytest -q
4 failed, 1515 passed, 1 skipped, 2421 warnings in 4056.58s (1:07:36)

$ cd backend && python -m mypy app
Success: no issues found in 147 source files

$ cd frontend && npm run typecheck
(sin salida — limpio)

$ cd frontend && npm run test
 Test Files  1 failed | 114 passed (115)
      Tests  1 failed | 549 passed (550)        65,10 s

$ cd frontend && npm run build
✓ 2606 modules transformed · built in 1,16 s
```

Comparado con el cierre de 2c (1.226 passed, 493 tests de vitest en 100 archivos,
2.571 módulos): **+293 tests de backend, +57 de frontend, +15 archivos de test.**

### Los cinco rojos, uno por uno

**La suite no cierra en verde, y ninguno de los cinco rojos es una cifra de plata
equivocada.** Los cuatro de backend y el de frontend son, los cinco, **invariantes
que hay que mover o re-medir**, y los clasifico como el propio auditor enseñó a
clasificarlos — porque «ponerlos en verde» sin decir cuál es cuál es exactamente
la forma de perder un rojo de verdad el día que aparezca.

| # | Test | Qué es |
|---|---|---|
| R-1 | `tests/audit/test_contract_2c_invariants.py::test_the_migration_chain_pin_was_moved_to_the_head_of_2c` | **No es de esta fase.** Exige que `test_migration_invariants.py` diga `version == "0015"`; el cierre de H-3 (commit `e5eb5fe`) lo movió a `"0016"` y no actualizó esta contraparte. Los dos archivos están **sin modificar desde entonces** y el test corre en 0,04 s leyendo sólo fuentes: **venía rojo desde antes de que la fase 3 empezara**. |
| R-2 | `tests/audit/test_migration_invariants.py::test_the_chain_reaches_the_three_migrations_of_cost_and_inventory` | **Sí es de esta fase, y es el poste esperado.** Fija `version == "0016"` y `len(tablas) == 79`; la cadena ahora llega a `0020` con **93 tablas de dominio** (79 + las 14 de la fase). El propio mensaje del test dice qué hacer: «movele el poste acá y decí por qué, como hicieron 2b, 2c y H-3». **Mi error de armado**: §2 no le asignó dueño a los invariantes heredados, y cuatro agentes agregaron migraciones sin que nadie tuviera el mandato de mover el poste. |
| R-3 | `tests/audit/test_contract_fase3_invariants.py::test_no_new_domain_decides_by_itself_which_payment_methods_are_electronic` (H-5) | **Invariante que quedó mal medido por el propio arreglo.** Es un barrido AST que marca toda comparación contra los literales `card`/`transfer`/… dentro de los cuatro dominios. El arreglo de T1 **es** una comparación con esos literales — `payment_bucket(m, None) == "card"` (`app/banking/service.py:69-70`)—, pero compara la **salida de la autoridad**, no clasifica un medio por su cuenta. El defecto de fondo está cerrado (un medio nuevo lo clasifica `payment_bucket`); la heurística no sabe distinguir las dos cosas. |
| R-4 | `tests/audit/test_contract_fase3_invariants.py::test_d3_the_proposal_is_a_proposal_and_writes_absolutely_nothing` | **Invariante desactualizado por el arreglo que él mismo causó.** Llama `GET /admin/tips/distribution/proposal` con `shift_id` y nada más — el contrato de la ronda 1. El cierre de C2/H-2 hizo `from`/`to` obligatorios, así que hoy responde `400 VALIDATION_ERROR: from: Field required`. Lo que el test mide (que la propuesta no escriba nada) **no se llega a medir**. |
| R-5 | `frontend/src/audit/money-after-drawer.test.ts` → «ninguna pantalla de plata totaliza con `reduce`…» (H-6) | **Prohibición total contra un arreglo que quedó al 90 %.** El invariante prohíbe **cualquier** `.reduce(` en los cuatro dominios. T5 corrigió lo que importaba —el `amount` que se manda es el que la persona teclea, y `allocations: []` ya se puede guardar—, pero dejó un `reduce` (`CreateDepositDialog.tsx:85`) para el remanente en pantalla. Ese remanente **es una diferencia de plata calculada en el cliente**, rotulada o no, y `AGENTS.md` dice que la calcula el backend. Acá **el invariante tiene razón**. |

**Cómo se cierra cada uno** (ninguno es grande, y ninguno se cierra ablandando):

- **R-1**: corregir la contraparte de 2c para que exija `"0016"` — o, ya que R-2
  mueve el poste a `"0020"`, dejar las dos apuntando al mismo número. Es del
  orquestador humano: mover un poste es un acto deliberado y se escribe por qué.
- **R-2**: mover el poste a `version == "0020"` y `len(tablas) == 93`, enumerando
  las 14 tablas nuevas como 2a/2b/2c enumeraron las suyas. **Verificado por mí en
  Postgres real**: son exactamente 93 de dominio (94 con `alembic_version`).
- **R-3**: la vía que el propio auditor dejó escrita como preferida —publicar
  `METHODS_IN_BUCKET` en `app/shifts/hooks.py` e importarlo— elimina el literal y
  cierra el invariante sin tocar su heurística. Necesita autorización sobre
  `app/shifts/`, que no fue territorio de nadie en esta fase. La alternativa
  —acotar el barrido para que no marque una comparación cuyo otro lado es una
  llamada a `payment_bucket`— es legítima **sólo escrita como corrección del
  invariante**, con el porqué, igual que el auditor corrigió otros dos (§2, T6).
- **R-4**: que el invariante mande `from`/`to` (y, si quiere seguir probando el
  override, `shift_id` además). Y de paso queda a la vista una arista del cierre
  de C2: **el `shift_id` «override opcional» no se puede usar solo** — `from`/`to`
  siguen siendo obligatorios aunque se ignoren cuando viene el override. O se
  hacen opcionales con `shift_id` presente, o se deja de llamarlo override.
- **R-5**: sacar el remanente calculado en el cliente. El servidor ya publica
  `unallocated_amount`, y el rechazo por imputaciones que exceden el monto ya
  existe (`ALLOCATION_EXCEEDS_DEPOSIT`): la pantalla no necesita restar nada.

### El checklist de la spec (§4), punto por punto

| Punto | Estado |
|---|---|
| El esperado del turno no cambió por ninguna capacidad de la fase | **sí** — medido por HTTP antes y después de los cuatro flujos nuevos, en verde en la suite |
| «Por consignar» es derivado, no una columna | **sí** — no existe tal columna; se deriva en cada lectura |
| Un gasto fuera del cajón no toca `compute_breakdown`; el que sí, entra por `shifts.hooks` con causa tipada | **sí** — y `app/expenses/` no tiene ninguna línea que escriba un `CashMovement` |
| La mano del dueño cuadra: retirado − consignado − gastado | **sí** en la identidad publicada — con la salvedad **A-2** sobre qué entra en «retirado» |
| Conciliación contra lo que `channels` ya registró, sin duplicar la cuenta por cobrar | **sí** en el backend — **inalcanzable desde la pantalla** (A-1) |
| Punto de equilibrio y utilidad `null` **con motivo** sin costos fijos | **sí** — y hoy es *siempre* `null`, por A-1 |
| `invoice_total`/`invoice_discrepancy` y una cuenta con diferencia no se aprueba sola | **sí** — `409` que nombra las dos cifras, y queda registrado quién confirmó |
| Ingeniería de menú sobre el costo congelado; nadie revalora una venta pasada | **sí** por lectura y AST (hasta los nombres salen de `OrderItem`) — **falta el cruce dinámico** (A-6) |
| La varianza por plato se declara prorrateada en la respuesta **y en pantalla** | **sí** — literal fijado en el esquema, y la pantalla lo muestra tal cual llega |
| «Sostenido» implementa D-1 y `_variance_level` no se tocó | **sí** — 2 de 3 ventanas, `null` con motivo con menos de dos; huella AST de `_variance_level` idéntica. Falta auditar el caso positivo (A-6) |
| Ningún recargo con `float`; las horas con escala entera declarada | **sí** — `app/core/hours.py`, minutos enteros |
| Tabla legal con vigencia + test que recalcula un período viejo con las tablas de su época | **sí** — junio de 2025 liquidado con la vigencia de 2025, no con la de 2026 |
| Los tres métodos de D-3, default por horas, propuesta que se confirma | **sí** en el backend; el invariante que lo cobra quedó sin medir (**R-4**) |
| Un operador no ve la nómina de otro ni el reparto ajeno | **sí** — las 19 rutas nuevas contra una sesión real de dispositivo: ninguna `200` |
| Toda capacidad detrás de su función, con `400 FEATURE_DISABLED`, y la dependencia **antes** del gate de sede | **sí** — 16 combinaciones probadas encendida y apagada |
| El operador sigue sin ver costos ni márgenes | **sí** |
| Las rutas del contrato existen tal cual y las pantallas consumen ésas | **sí** las rutas (verificado contra el OpenAPI real); **con la salvedad grande de A-1**: 18 rutas publicadas no las consume ninguna pantalla |
| `alembic heads` una sola cabeza y `alembic upgrade head` desde cero **en Postgres** | **sí** — verificado por mí, ida y vuelta |
| `mypy app` limpio; `npm run typecheck` limpio | **sí** |
| Suite completa de backend y de frontend en verde | **NO** — 4 + 1 rojos, todos clasificados arriba |
| Recorrido en navegador real antes de cerrar | **NO** — nadie lo hizo (A-8) |

**Y la lección de armado, que es mía.** El auditor corrió **sólo en la ronda 1**.
Sus siete hallazgos produjeron siete arreglos en la ronda 2, y **nadie volvió a
correr los invariantes que los habían pedido**: dos de ellos (R-3 y R-5) quedaron
rojos contra el arreglo, y uno (R-4) quedó llamando a una ruta que él mismo hizo
cambiar. Verifiqué los siete cierres **abriendo el archivo**, que es lo que el
ciclo pedía, y así confirmé el código — pero el criterio de aceptación del
auditor es **su test**, y eso sólo se sabe corriéndolo. En la próxima fase, el
ajuste de la ronda 2 tiene que incluir, explícitamente, **«dejá verde el
invariante que te cobró, o explicá por escrito por qué el invariante estaba mal
medido»**, y el auditor tiene que tener una segunda pasada corta después de los
arreglos.

---

## 5. Conflictos NO resueltos

Ninguno está escondido en un reporte: van acá, con dueño y remedio, ordenados por
daño. **Los cinco rojos de la suite (R-1 a R-5) están en `§4`** y no se repiten
acá: son trabajo mecánico de media hora, mientras que lo que sigue es trabajo de
producto y de criterio.

### A-1 · Tres capacidades no se pueden completar desde la interfaz

Es el hallazgo más importante de este cierre, y no lo levantó nadie del equipo
porque **las dos mitades están bien cada una por su lado**. Crucé las 46 rutas de
los cuatro dominios contra los 30 clientes de `src/api/*.ts`: hay **18 rutas de
backend que ninguna pantalla consume**, y tres grupos son la puerta de entrada de
datos sin los cuales la capacidad no puede dar un número:

| Ruta sin pantalla | Qué queda inalcanzable |
|---|---|
| `GET`/`PATCH /admin/expenses/settings` | **Punto de equilibrio** (capacidad 5). Sin costos fijos cargados, `GET /admin/break-even` responde siempre `available: false` con un motivo que —literalmente— le nombra al dueño la ruta de API que le falta (`app/expenses/service.py:481`). No hay ninguna pantalla desde donde cargarlos. |
| `GET`/`POST /admin/payroll/wages` (y `/holidays`, `/areas`) | **Nómina** (capacidad 7), un tercio de D-3 **y la utilidad del período**. Sin tarifa por hora, `POST /admin/payroll/runs` devuelve la liquidación con `total_amount: null` y `reason: "Sin tarifa por hora para: …"` (`app/payroll/service.py:809`); sin festivos, la columna «festivas» es siempre cero; sin áreas, `by_area` no tiene con qué agrupar. **Y arrastra a `GET /admin/profit`**: con la función `payroll` encendida —lo está en el perfil `full`— `period_payroll_cost` devuelve `None` si a alguien le falta tarifa, y `compute_profit` corta con `available: false` (`app/expenses/service.py:604-615`). La costura está bien hecha en las dos puntas; lo que falta es la pantalla que carga el dato. |
| `POST /admin/reconciliation/card` · `/platform`, `GET …/settlements`, `POST …/{id}/settle` de plataforma | **Conciliación de datáfono y plataformas** (capacidad 3). No hay forma de registrar una liquidación, así que `settled` es siempre `0` y todo aparece como no conciliado. Y el botón «Conciliar» **nunca se renderiza**: la fila que publica el backend agrupa por día y trae `settlement_ids: list[int]`, no un `id` (`app/banking/schemas.py:191-197`), y la pantalla —bien— se niega a inventar uno. |

**Y un caso peor que una ruta sin pantalla: una pantalla que afirma algo falso.**
`GET /admin/payroll/runs` devuelve `PayrollRunSummaryOut` —**sin** `lines` ni
`tables_used`, y su docstring lo dice (`app/payroll/schemas.py:190-193`)—, pero
`RunsTab.tsx` pinta el detalle a partir de esa fila de listado y nunca llama a
`GET /admin/payroll/runs/{run_id}`, que es donde viven las dos cosas. Resultado:
toda liquidación vieja muestra «**Esta liquidación no informó qué tabla de
recargos usó**» y «Sin renglones por persona» (`RunsTab.tsx:42,45`) cuando el
backend **sí** las informa. El contrato de §2 pide explícitamente que la
respuesta nombre **qué tabla vigente usó**: el backend cumple, la pantalla dice lo
contrario. Dueño: **T5** (una llamada al detalle).

Menores de la misma familia: `POST /admin/deposits/{id}/reverse`,
`POST /admin/expenses/{id}/void`, `POST /admin/obligations/{id}/cancel` —«nada
financiero se borra» tiene su camino de corrección en el backend y ninguno en la
pantalla—, y el gasto u obligación pagado **literalmente desde el cajón**, que
desde la pantalla siempre se registra como `source: "other"` porque no hay
selector de movimientos de caja en `src/components/` (T5 lo declaró). No produce
doble conteo —el movimiento de caja y el renglón de gasto viven en bolsas
distintas— pero se pierde el vínculo entre los dos.

**Por qué pasó.** T5 construyó contra el **contrato de API mínimo**, que era la
única forma de arrancar a la vez que los cuatro backends. Los cuatro agregaron
rutas fuera del contrato y las declararon, como manda §2. Nadie tenía el mandato
de volver a cruzar las dos listas al final — y el contrato, por diseño, sólo fija
«lo que T5 necesita para existir». **Es el costo conocido del arranque simultáneo,
y es barato de cerrar**: una ronda corta de T5, con el flujo de conciliación en
dos pasos que el backend ya tiene diseñado. Dueño: **T5**, con T1 confirmando la
forma del `settlement_id`.

### A-2 · La mano del dueño cuenta como retirada plata que nadie contó

`owner_hand` suma `Shift.to_deposit` de **todo** turno cerrado con valor no nulo
(`app/banking/service.py:537-551`), incluidos los cerrados administrativamente
**sin conteo** — exactamente los mismos turnos para los que, después de cerrar
C4/H-4, `GET /admin/deposits/pending` publica `to_deposit: null` con motivo.
Misma pregunta, dos respuestas: una dice «nadie abrió ese cajón», la otra suma esa
cifra como plata en la mano. Y el sesgo va **para el lado que no se tolera**:
muestra más plata de la que se contó. El saldo no queda trabado —una consignación
sin imputar sigue restando—, pero el `withdrawn` publicado incluye una cifra
derivada del libro, no un arqueo; y el propio dominio ya sabe que esa cifra no es
confiable: `create_deposit` **rechaza** imputarle una consignación a ese turno con
`400 SHIFT_CLOSED_WITHOUT_COUNT` (`app/banking/service.py:139-147`). No es doble conteo y no rompe la identidad
publicada —por eso el invariante del auditor está verde—, pero es un número que
puede mentir. Dueño: **T1**. Remedio: la misma condición que ya usa
`pending_deposits` (`closed_without_count`), excluyendo esos turnos de `withdrawn`
o publicándolos aparte con su motivo. Lo encontré yo leyendo el código en este
cierre; no está en ningún entregable.

### A-3 · `spent_on_tips` resta de la mano propinas que pueden haber salido del cajón

Declarado por T1 y confirmado por el auditor: `TipPayout(method="cash")` no
distingue si el dueño pagó **del cajón** (donde ya redujo el `to_deposit` de ese
turno) o **de la mano**. Se cuenta todo como gastado de la mano: es una doble
resta, con el sesgo que muestra **menos** plata — el lado tolerado por la regla
del proyecto. El remedio correcto es un campo en `TipPayout` que diga de dónde
salió la plata, y `app/shifts/` **no es territorio de nadie en esta fase**. Queda
abierto a propósito, no por olvido.

### A-4 · Los valores de las tablas legales son un supuesto, y ya están en la base

La migración `0020` siembra seis vigencias por sede. La spec cita tres cambios con
su norma (ventana nocturna desde dic-2025; dominical 80/90/100 % en 2025/26/27,
Ley 2466 de 2025; jornada de 42 h desde jul-2026, Ley 2101 de 2021). El resto
—recargo nocturno 35 %, hora extra 25 %, y los valores anteriores a esos cambios—
los puso T3 como **supuesto declarado**. Son editables por API sin tocar código,
que es lo que había que garantizar; pero hoy son **datos en la base que nadie con
firma revisó**. Antes de producción los tiene que confirmar quien tenga la norma
adelante.

### A-5 · La nómina no implementa la fórmula CST completa

Cada minuto paga la base más recargos **aditivos e independientes** (nocturno,
dominical/festivo, extra). La fórmula legal exacta los combina (HED/HEN/HEDD/HEND,
ocho categorías). Es transparente y auditable recargo por recargo, pero **no es la
liquidación legal**. Declarado por T3 en el docstring de `SurchargeTable` y en su
entregable. No es un defecto de esta fase: es alcance que nunca estuvo escrito, y
no corresponde improvisarlo.

En la misma familia, y también declarado: **el sub-algoritmo de `by_area`**. D-3
nombra el método pero no dice cómo se reparte dentro de él; T3 eligió partes
iguales entre las áreas presentes y, dentro de cada área, partes iguales entre sus
personas (quien no tiene área cae en «sin área», para que nadie quede afuera del
reparto por falta de configuración). Es una elección razonable, no una cita: si el
negocio quiere otra, se cambia con la decisión escrita, no por intuición.

### A-6 · Tres invariantes que el auditor no alcanzó a armar

Los pide él mismo para la próxima ronda, y coincido: (a) el cruce **dinámico** del
costo congelado —vender, cambiar la ficha **después**, exigir que el resultado del
período no se mueva—, hoy probado por AST y no por comportamiento; (b) la
**aritmética** del prorrateo de varianza por plato (que Σ de las filas cuadre con
`total_variance_value − unattributed_variance_value`); (c) el caso **positivo** de
D-1 (con 3 ventanas y 2 en rojo → `true`; con 1 en rojo → `false`); hoy sólo está
auditado el caso «menos de 2 ventanas → `null` con motivo». Los tres necesitan el
andamiaje de dos conteos completos aplicados.

### A-7 · El catálogo de funciones y el gate no dicen lo mismo

`app/core/features.py:327-331` describe `analytics.menu_engineering` como
«…y varianza por plato prorrateada», pero `GET /admin/variance/by-dish` y
`GET /admin/control-health/sustained` quedaron detrás de `inventory.variance`
—decisión que **yo ratifiqué** en la ronda 2, porque es la misma clave con la que
`app/inventory/` gatea sus rutas hermanas y porque así la varianza sigue
alcanzable con la ingeniería de menú apagada—. La descripción del catálogo quedó
vieja. `features.py` es del orquestador humano: es una línea.

### A-8 · El recorrido en navegador real no se hizo

El checklist de la fase lo exige como condición para cerrar, y con razón: es lo
que encontró siete de los defectos de la fase 2. Ningún agente podía hacerlo —los
cuatro backends se estaban escribiendo mientras T5 cerraba—. H-2 y H-3 son
exactamente de esa familia (dos pantallas que pasan sus tests y nunca cargan) y se
cazaron por cruce estático, no caminando. **La fase no está cerrada hasta
caminarla**, y A-1 es probablemente lo primero que ese recorrido habría encontrado.

---

## 6. Próximos pasos, priorizados

0. **Poner la suite en verde** (los cinco rojos de `§4`, con sus remedios ya
   escritos). Es lo más barato de la lista y es condición del checklist: R-1 y
   R-2 son mover dos postes y escribir por qué; R-3 y R-4, dos invariantes del
   auditor; R-5, sacar una resta del cliente. **Mientras haya rojos, el próximo
   rojo de verdad no se va a ver.**
1. **Cerrar A-1 con una ronda corta de T5.** Tres pantallas de carga (costos
   fijos; tarifa por hora, festivos y áreas; registro de liquidaciones del
   datáfono y de plataformas, con el flujo de dos pasos que el backend ya tiene),
   más los tres caminos de corrección (reversar consignación, anular gasto,
   cancelar obligación). Es **lo único** que separa «el backend está construido»
   de «el dueño cierra el mes con números», que es el objetivo textual de la fase.
2. **Caminar la aplicación en navegador real** (A-8), con los cuatro backends en
   pie y la sede de prueba, **después** del punto 1 —antes, tres de las once
   capacidades no tienen nada que mostrar— y recién ahí dar la fase por cerrada.
3. **Arreglar A-2** (T1, una condición). Es un número de plata que hoy puede
   mentir para el lado que la regla dura del proyecto no tolera.
4. **Confirmar A-4** con quien tenga la norma adelante. Es el único punto con
   consecuencia legal que sigue abierto: D-4 ya está cerrado y probado **por
   HTTP**, y la línea del CST art. 149 tiene invariante propio.
5. **Los tres invariantes de A-6**, en la siguiente iteración de auditoría, **más
   uno nuevo que esta fase pide a gritos**: un invariante que cruce, para cada
   pantalla, **los campos que pinta contra el esquema que publica el endpoint que
   llama**. H-2, H-3 y el detalle de liquidaciones de A-1 son el mismo defecto
   con tres caras, y ninguno lo caza el `tsc`: los tipos del cliente son
   defensivos (`| null`, opcionales) justamente para poder arrancar en paralelo,
   y esa misma defensa es la que convierte un campo que nunca llega en una
   pantalla vacía y muda. Del resto, el más valioso es el cruce dinámico del
   costo congelado: separa «no revalora» demostrado por AST de «no revalora»
   demostrado por comportamiento.
6. **A-3 y A-5 quedan para una fase futura**, con dueño explícito: el campo de
   origen en `TipPayout` (`app/shifts/`) y la fórmula CST completa con el contador
   involucrado. Anotarlos, no improvisarlos.
7. **A-7**: una línea en `app/core/features.py` (del orquestador humano).
8. **`docs/ESTADO.md` se actualiza en el mismo commit** que entre esta fase: es
   documento vivo, y un estado desactualizado miente con más autoridad que no
   tener estado.

### Lo que yo cambiaría del armado del equipo, para la próxima

**Dos cosas, las dos mías.**

**Una: el auditor tenía que tener una segunda pasada.** Corrió sólo en la ronda 1;
sus siete hallazgos produjeron siete arreglos y nadie volvió a correr los
invariantes que los pidieron. De ahí salen tres de los cinco rojos (`§4`). El
ajuste de la ronda 2 tiene que decir, con todas las letras, «dejá verde el
invariante que te cobró, o explicá por escrito por qué estaba mal medido», y el
auditor tiene que volver a correr al final. En la misma línea: **los invariantes
heredados de fases anteriores no tuvieron dueño en §2**, y por eso el poste de
Alembic quedó sin mover con cuatro migraciones nuevas encima.

**Dos: el cruce de rutas publicadas contra rutas consumidas.**
Dejé afuera a `agente-datos` con el argumento de que la fase pedía cobertura, no
pulido. Era correcto para el pulido y **se me pasó el costado que sí importaba**:
con cinco territorios escribiendo a la vez y un contrato que sólo fija el mínimo,
hacía falta alguien —o un paso explícito en la última ronda— que **volviera a
cruzar la lista de rutas publicadas contra la lista de rutas consumidas**. Ese
cruce es el que produjo A-1, y lo terminé haciendo yo en la verificación, cuando
ya no había ronda para arreglarlo. En un pedido con backends y frontend en
paralelo, ese cruce debería ser una tarea con nombre, no un subproducto del cierre.

---

## Estado del árbol

Nada de esto está commiteado: en este framework commitea el orquestador humano
después de revisar. Sobre el commit base `14256d6`:

- **8 archivos tracked modificados** — `app/customers/service.py`,
  `app/refunds/service.py` (D-4), los cuatro de `app/purchases/` (D-2), y
  `frontend/src/app/{router,AdminLayout}.tsx` (T5): 246 líneas agregadas, 3
  borradas.
- **Sin trackear**: los cuatro dominios nuevos de backend, `app/core/hours.py`,
  las cuatro migraciones, las cuatro carpetas de tests nuevas y los cinco
  invariantes de auditoría, las cuatro carpetas de `frontend/src/features/`, los
  cuatro clientes de API y los cuatro archivos de `frontend/src/audit/`.
- `git diff` a secas **no muestra** casi nada de esto (un directorio nuevo sin
  trackear no aparece): para verlo, `git status --porcelain --untracked-files=all`.
