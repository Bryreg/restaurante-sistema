# T5 `frontend-fase3` — entregable

Todas las pantallas de la Fase 3 («dinero y control»). Prioridad seguida al pie
de la letra: **(1)** toda capacidad de backend con una pantalla que la
alcance, **(2)** ninguna pantalla deriva plata, **(3)** pulido.

**Actualizado en iteración 2** con dos cambios acotados del Conciliador —
ver [§10](#10-iteración-2--c5-bloqueante-y-c7-advertencia)—: C5/H-6
(bloqueante, `CreateDepositDialog.tsx`) y C7/H-7 (advertencia, `TipsTab.tsx`
y una pasada por los cuatro dominios). El resto de este documento (§1-§9) es
el trabajo de la ronda 1, sin rehacer.

---

## 1. Mapa capacidad → pantalla

Una fila por cada una de las once capacidades de §14, más cobro por mesero.
**Ninguna quedó sin pantalla.**

| # | Capacidad (§14) | Pantalla (ruta española) | Componente |
|---|---|---|---|
| 1 | Consignaciones | `/admin/banco` → pestaña «Consignaciones» | `banking/DepositsTab.tsx` (+ `CreateDepositDialog.tsx`) |
| 2 | Banco y mano del dueño | `/admin/banco` → pestañas «Por consignar», «Libro del banco», «Mano del dueño» | `banking/PendingDepositsTab.tsx`, `banking/LedgerTab.tsx`, `banking/OwnerHandTab.tsx` |
| 3 | Conciliación de datáfono y plataformas | `/admin/banco` → pestañas «Conciliación datáfono», «Conciliación plataformas» | `banking/ReconciliationTab.tsx` (parametrizada por `kind`) |
| 4 | Obligaciones y gastos | `/admin/gastos` → pestañas «Gastos», «Obligaciones» | `expenses/ExpensesTab.tsx`, `expenses/ObligationsTab.tsx` |
| 5 | Punto de equilibrio | `/admin/gastos` → pestaña «Punto de equilibrio» | `expenses/BreakEvenTab.tsx` |
| 6 | Propinas repartidas (D-3) | `/admin/nomina` → pestaña «Propinas» | `payroll/TipsTab.tsx` |
| 7 | Nómina con recargos | `/admin/nomina` → pestañas «Horas», «Tablas de recargos», «Liquidaciones» | `payroll/HoursTab.tsx`, `payroll/SurchargeTablesTab.tsx`, `payroll/RunsTab.tsx` |
| 8 | Reposición sugerida | `/admin/analitica` → pestaña «Reposición sugerida» | `analytics/ReplenishmentTab.tsx` |
| 9 | Ingeniería de menú | `/admin/analitica` → pestaña «Ingeniería de menú» | `analytics/MenuEngineeringTab.tsx` |
| 10 | Varianza por plato | `/admin/analitica` → pestaña «Varianza por plato» | `analytics/VarianceByDishTab.tsx` |
| 11 | «Sostenido» (D-1) | `/admin/analitica` → pestaña «Salud sostenida» | `analytics/SustainedHealthTab.tsx` |
| — | Cobro por mesero | **Ya existía**: `/admin/ventas` con `group_by=employee` (`features/reports/SalesTab.tsx`) | No se construyó pantalla nueva, per mandato explícito |
| — | Utilidad del período | `/admin/gastos` → pestaña «Utilidad» (no es de las once pero está en el contrato de T2) | `expenses/ProfitTab.tsx` |
| — | D-2 (factura vs. cálculo) | `/admin/gastos` → pestaña «Cuentas por pagar» | `expenses/PayablesApprovalTab.tsx` |

Once de once alcanzadas, más las dos capacidades adicionales del contrato
(`profit`, D-2) que no son parte de la fila de §14 pero sí de "T2 — expenses"
en el contrato de API mínimo.

---

## 2. Rutas de UI en español y dónde se cuelgan

Cuatro dominios nuevos, cada uno con su `index.ts` exportando
`{ adminRoutes, posRoutes: [], adminNav, posNav: [] }` — sólo Admin, ningún
operador ve estas pantallas.

| Dominio | Ruta | Colgada en |
|---|---|---|
| `banking` | `/admin/banco` | `router.tsx` (`...bankingFeature.adminRoutes`), nav "Banco" en `AdminLayout.tsx` |
| `expenses` | `/admin/gastos` | `router.tsx`, nav "Gastos" |
| `payroll` | `/admin/nomina` | `router.tsx`, nav **dos entradas**: "Nómina" (`payroll`) y "Propinas" (`pos.tips`) |
| `analytics` | `/admin/analitica` | `router.tsx`, nav **tres entradas**: "Ingeniería de menú" (`analytics.menu_engineering`), "Varianza y salud" (`inventory.variance`), "Reposición" (`inventory.replenishment`) |

Las entradas dobles/triples de nómina y analítica existen porque
`NavItem.feature` sólo admite **una** clave, y las sub-capacidades de esas dos
pantallas están gateadas por funciones distintas (ver §9 «Reglas de plata» y
gaps). Es la única forma de que "la entrada de navegación se esconde si su
función está apagada" (CONTEXTO-AGENTES §10) siga valiendo con dos o tres
flags sobre la misma pantalla — dos entradas nunca es peor que una entrada que
esconde una capacidad encendida.

`src/app/router.tsx` y `src/app/AdminLayout.tsx`: **únicos archivos fuera de
mi territorio que toqué**, y sólo para importar los cuatro `*Feature` nuevos y
colgarlos en `...xFeature.adminRoutes` / `...xFeature.adminNav`, exactamente
como manda la convención (`docs/CONTEXTO-AGENTES.md §3`: "una pantalla nueva
no se cuelga a mano del router").

---

## 3. Endpoints consumidos (lista literal, para cruzar contra los cuatro backends)

**T1 banking** (`src/api/banking.ts`):
- `GET /admin/deposits`
- `POST /admin/deposits`
- `GET /admin/deposits/pending`
- `GET /admin/bank/ledger`
- `GET /admin/bank/owner-hand`
- `GET /admin/reconciliation/card`
- `GET /admin/reconciliation/platform`
- `POST /admin/reconciliation/card/{id}/settle`

**T2 expenses** (`src/api/expenses.ts`):
- `GET /admin/expenses`
- `POST /admin/expenses`
- `GET /admin/obligations`
- `POST /admin/obligations`
- `POST /admin/obligations/{id}/settle`
- `GET /admin/break-even`
- `GET /admin/profit`
- `GET /admin/payables/{id}` (extensión D-2)
- `POST /admin/payables/{id}/approve` (extensión D-2)

**T3 payroll** (`src/api/payroll.ts`):
- `GET /admin/payroll/hours`
- `GET /admin/payroll/surcharge-tables`
- `POST /admin/payroll/surcharge-tables`
- `GET /admin/payroll/runs`
- `POST /admin/payroll/runs`
- `GET /admin/tips/distribution/proposal`
- `POST /admin/tips/payouts` (ya existente desde 1b-2, `app/shifts/`)
- `GET /admin/tips/settings`
- `PATCH /admin/tips/settings`

**T4 analytics** (`src/api/analytics.ts`):
- `GET /admin/menu-engineering`
- `GET /admin/variance/by-dish`
- `GET /admin/control-health/sustained`
- `GET /admin/replenishment`

**Reusado, no nuevo:**
- `GET /admin/sales?group_by=employee` (`src/api/reports.ts::getSales`, ya existente) para "cobro por mesero" — sin cliente nuevo, sin pantalla nueva.

Ninguna ruta fuera de esta lista y fuera del contrato de spec.md § 2.

---

## 4. Cómo se pinta `null` con motivo (un ejemplo de cada caso, no derivado nunca)

Regla: **`null` nunca es `$0`, nunca una tabla vacía muda.** Cada caso de
abajo se probó con un test (ver §8).

1. **`to_deposit` de un turno cerrado sin conteo** (`PendingDepositsTab.tsx`):
   `row.to_deposit === null` → `"Sin datos"` + el `reason` del servidor debajo,
   nunca `formatCOP(0)`. Test: `banking/__tests__/PendingDepositsTab.test.tsx`.
2. **Punto de equilibrio sin costos fijos** (`BreakEvenTab.tsx`):
   `!data.available` → `EmptyState` con `data.reason` ("Cargá los costos fijos
   del período…"), nunca las tres cifras en `$0`. Test:
   `expenses/__tests__/BreakEvenTab.test.tsx`.
3. **«Sostenido» con menos de dos ventanas (D-1)** (`SustainedHealthTab.tsx`):
   `sustained_red === null` → `EmptyState` "Sin historial suficiente" +
   `reason`, nunca "No" (que sería un verde disfrazado). Test:
   `analytics/__tests__/SustainedHealthTab.test.tsx`.
4. **Varianza por plato sin conteos completos** (`VarianceByDishTab.tsx`):
   `!data.available` → motivo del servidor, nunca una tabla vacía sin
   explicación. Test: `analytics/__tests__/VarianceByDishTab.test.tsx`.
5. **Propuesta de propinas sin turnos con propina** (`TipsTab.tsx`):
   `!proposal.available` → `EmptyState` con el `reason`, nunca "$0 para
   repartir". Test: `payroll/__tests__/TipsTab.test.tsx`.
6. Además, sin test dedicado pero con el mismo patrón: `ProfitTab.tsx`
   (`!available` → motivo), `HoursTab.tsx` (`!available` → motivo),
   `RunsTab.tsx` (por liquidación, `!run.available` → "Sin datos: …" en vez
   del total), `ReplenishmentTab.tsx` (`!available` a nivel de pantalla, y
   `suggested_min === null` con `row.reason` a nivel de fila), y cada línea de
   una liquidación (`PayrollRunLineOut.total === null` → "Sin datos: …" con
   `pay_reason`).

---

## 5. Manejo del `409 INVOICE_DISCREPANCY` (D-2)

`expenses/PayablesApprovalTab.tsx`, copiado del patrón de `confirm_price` en
`features/purchases/ReceptionForm.tsx` (territorio ajeno, sólo copiado, nunca
importado):

1. Se busca una cuenta por pagar por id (`GET /admin/payables/{id}`), que
   ahora trae `invoice_total`/`invoice_discrepancy`.
2. Aprobar (`POST .../approve`) manda `confirm_discrepancy: false` la primera
   vez. Si el servidor corta con `409 INVOICE_DISCREPANCY` (decidido por
   `code`, **nunca por `message`** — AGENTS.md), la pantalla muestra un
   cuadro `role="alert"` con **las dos cifras** lado a lado ("Lo que dice el
   papel" / "Lo calculado línea por línea") y la diferencia, y pide el PIN de
   administrador otra vez.
3. Reenviar con el mismo PIN manda `confirm_discrepancy: true`, y el servidor
   aprueba dejando registrado quién confirmó.
4. Ningún camino "corrige" ni promedia las dos cifras: las dos se muestran
   preservadas, siempre.

Test completo (dos veces: 409 sin confirmar y reenvío confirmado):
`expenses/__tests__/PayablesApprovalTab.test.tsx`.

**Nota de territorio**: este flujo vive en `features/expenses/` (mi
territorio) y no en `features/purchases/` (ajeno), aunque D-2 extiende un
endpoint que conceptualmente pertenece a "compras". La pantalla es una
búsqueda por id, no un listado — ver gap correspondiente.

---

## 6. Componentes reusados y cuáles quedaron cortos

**Reusados tal cual, sin copiar:**
- `DateRangeFilter` (todas las pantallas con período).
- `MoneyInput` (todo campo de plata tecleada).
- `CsvExportButton` — **no se usó**: ver gap.
- `EmployeePicker` — **no se usó**: ver gap.
- `PhotoCaptureField` (comprobante de consignación).
- `PinPad` (aprobar cuenta por pagar con diferencia).
- `StatTile`, `EmptyState`, `Badge`, `Table`, `Tabs`, `Select`,
  `Dialog`/`AlertDialog`, `Checkbox` — de `src/components/ui/` y
  `src/components/`, sin copiar ninguno.
- `formatBasisPoints` de `features/inventory/lib.ts` — reexportado/importado
  en `expenses/lib.ts`, `payroll/SurchargeTablesTab.tsx`,
  `payroll/RunsTab.tsx`, `analytics/MenuEngineeringTab.tsx` y
  `analytics/VarianceByDishTab.tsx`, en vez de reimplementarlo: mismo patrón
  que `features/settings/ChannelsSection.tsx`/`InventorySection.tsx` ya usan
  cruzando territorio para esta única función.
- `todayInBogota`/`daysAgoInBogota` de `features/reports/lib.ts`,
  reexportados como `todayLocal`/`daysAgoLocal` en el `lib.ts` de cada
  dominio nuevo (mismo patrón que `features/inventory/lib.ts`).

**Quedaron cortos (gaps, no se copiaron):**
- **`EmployeePicker`** está diseñado para elegir "quién opera" en el
  dispositivo (`GET /device/employees`, sin costos ni límites) — no sirve
  para elegir un empleado en un formulario admin (tablas de recargos,
  reparto de propinas). No existe un selector de empleados admin en
  `src/components/`. Se usó texto/ids crudos donde hacía falta (ninguna
  pantalla de esta fase necesitó elegir UN empleado admin directamente: la
  jornada y la propuesta de propinas ya vienen agrupadas por persona desde
  el servidor).
- **No existe un selector de turnos** (`Shift`) reusable. `CreateDepositDialog`
  pide el id de turno como texto — funcional, pero un selector real (buscar
  turnos cerrados de la sede por fecha) sería mucho mejor UX. Gap declarado.
- **`CsvExportButton`** no se usó en ningún listado nuevo: el contrato de esta
  fase no confirma soporte `?format=csv` en las rutas nuevas, y agregarlo sin
  esa confirmación sería inventar un parámetro. Gap declarado.

---

## 7. Qué NO toqué

- `src/components/ui/**` — ninguno.
- `src/components/*.tsx` (compartidos) — ninguno, sólo consumidos.
- Ningún `src/features/` ajeno (`purchases`, `inventory`, `shifts`, `reports`,
  `fiscal`, etc.).
- `src/audit/**` — territorio del auditor.
- `src/app/router.tsx` y `src/app/AdminLayout.tsx` — tocados **sólo** para
  colgar los cuatro `*Feature` nuevos (import + spread en la lista/array
  existente), como autoriza explícitamente mi mandato.
- Ningún archivo de backend (`backend/**`).
- `app/purchases/**` no se tocó ni para D-2: la extensión física del
  endpoint es de T2 (backend), no de T5.

---

## 8. Comandos de verificación corridos y su resultado literal

**Ronda 1** (sin cambios, se conserva como referencia histórica):

```
$ cd frontend && npm run typecheck
> frontend@0.0.0 typecheck
> tsc --noEmit -p tsconfig.app.json

(sin salida — 0 errores)
```

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-fase3 npx vitest run \
    src/features/banking src/features/expenses src/features/payroll src/features/analytics

 Test Files  10 passed (10)
      Tests  20 passed (20)
```

Más, como verificación adicional (no exigida, pero corrida porque son
invariantes que mi código nuevo tiene que cumplir sobre TODO el repo):

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-fase3 npx vitest run \
    src/audit/portal-queries.test.ts src/audit/security.test.ts

 Test Files  2 passed (2)
      Tests  10 passed (10)
```

**Ronda 2 — iteración 2 (C5/H-6, C7/H-7), corrida literal después de los
cambios de §10:**

```
$ cd frontend && npm run typecheck
> frontend@0.0.0 typecheck
> tsc --noEmit -p tsconfig.app.json

(sin salida — 0 errores)
```

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-fase3 npx vitest run \
    src/features/banking src/features/expenses src/features/payroll src/features/analytics

 Test Files  11 passed (11)
      Tests  23 passed (23)
```

(10 → 11 archivos, 20 → 23 tests: el archivo nuevo es
`banking/__tests__/CreateDepositDialog.test.tsx`, con los tres tests exigidos
por C5 — ver §10.)

```
$ cd frontend && TMPDIR=/tmp/pt-frontend-fase3 npx vitest run \
    src/audit/portal-queries.test.ts src/audit/cost-display.test.tsx

 Test Files  2 passed (2)
      Tests  7 passed (7)
```

Total combinado ronda 2 (territorio + los dos invariantes transversales que
mi código nuevo activa): **13 archivos de test, 30 tests, 30 en verde.**

No corrí `npm run test` (suite completa) ni `npm run build`, según mandato.
Verifiqué con `ps aux` que no quedó ningún proceso de `vitest`/`tsc`
huérfano después de cada corrida (ronda 1 y ronda 2).

---

## 9. Gaps

**Coordinación con los backends (T1-T4) — el hallazgo más importante de este
entregable.**

El contrato mínimo de spec.md § 2 fija RUTAS, pero para varias de ellas sólo
describe el contenido en prosa ("lo esperado, lo liquidado, la diferencia").
Arranqué las cuatro pantallas contra esa prosa, con TODO campo `Out` opcional/
`| null` (mismo patrón que `api/reports.ts`) para no romper si el backend
manda otra cosa. **Antes de cerrar el entregable, leí los cuatro
`schemas.py` ya escritos** (T1-T4 avanzaron mucho durante esta misma ronda) y
corregí lo que encontré, dejando declarado acá lo que no alcancé a resolver
con certeza total o lo que decidí no perseguir:

- **`banking`**:
  - `DepositIn` reparte el monto en `allocations: [{shift_id, amount}]`, no
    en un `shift_ids: number[]` plano — **corregido**, `CreateDepositDialog`
    ahora pide un monto por cada turno.
  - `receipt_photo` es **obligatorio** (el servidor rechaza sin foto) —
    **corregido**, el botón "Registrar consignación" queda deshabilitado sin
    foto.
  - `GET /admin/bank/ledger` publica `entries` (no `rows`) más un objeto
    `totals` — **corregido**, `LedgerTab` ahora muestra los cuatro totales
    del servidor además de la lista.
  - `CardReconciliationRowOut`/`PlatformReconciliationRowOut` **no tienen
    `id`** (agrupan por `business_date`, y traen `settlement_ids: number[]`
    en su lugar) — **corregido defensivamente**: `id` quedó opcional en el
    tipo, y el botón "Conciliar" se oculta cuando no llega, en vez de apuntar
    a un id inexistente. Esto significa que, contra el backend actual, **el
    botón "Conciliar" nunca se muestra** — la pantalla sigue mostrando
    esperado/liquidado/diferencia/estado (capacidad de LECTURA alcanzada),
    pero la escritura (`POST .../settle`) queda inalcanzable desde acá hasta
    que se resuelva de dónde sale ese id. Sospecho que el diseño real es:
    `POST /admin/reconciliation/card` registra una liquidación de datáfono
    (fuera del contrato mínimo), y **ésa** es la que se concilia por
    `settlement_id` — dos pasos, no uno. Reconstruir ese flujo de dos pasos
    consumiendo `GET /admin/reconciliation/card/settlements` (ruta fuera del
    contrato mínimo) queda fuera de este entregable: **decisión del
    Conciliador**, no mía.
  - `SettleIn` (el cuerpo real de `.../settle`) sólo tiene `note`, no un
    monto — **corregido**, `SettleDialog` ya no pide (ni manda) un
    `settled_amount` inventado.

- **`expenses`**:
  - `ExpenseIn.category` y `ObligationIn.category` son **enums cerrados**
    (`ExpenseCategoryLiteral`, `ObligationCategoryLiteral`), no texto libre
    — **corregido**, ambos formularios ahora usan `Select` con las opciones
    exactas leídas del schema.
  - `ObligationIn` **no tiene** `recurring` — **corregido**, se quitó el
    checkbox "se repite cada período" (no hacía nada contra el backend real).
  - `ObligationStatusLiteral = "pending" | "paid"` (no `"settled"`/
    `"cancelled"` como asumí al principio) — **corregido**: el filtro, el
    badge y la condición de "Saldar" usan `"paid"`; una obligación cancelada
    sigue `"pending"` y trae `cancelled_at`/`cancelled_reason` propios, que
    ahora se muestran aparte.
  - `ObligationSettleIn` real es `{ source?, cash_movement_id?, note? }`, no
    `{ settled_amount }` — **corregido**. `source` queda siempre `"other"`
    desde esta pantalla: `"cash_drawer"` exigiría elegir un
    `cash_movement_id` de un movimiento de caja ya existente, y no hay un
    selector de movimientos de caja en `src/components/` — **gap sin
    resolver**: un gasto/obligación pagado literalmente desde el cajón no se
    puede registrar como tal desde esta pantalla todavía.
  - `GET /admin/payables` (listado) **no está** en el contrato de esta fase
    — sólo el detalle por id. Por eso `PayablesApprovalTab` busca por id en
    vez de listar. Sería mucho mejor UX si `features/purchases/PayablesTab.tsx`
    (territorio ajeno) enlazara acá cuando detecta una diferencia — **gap de
    coordinación entre features, no de contrato**.

- **`payroll`**:
  - `SurchargeTableIn`/`Out` reales son `night_start_hour`, `night_end_hour`,
    `night_surcharge_bp`, `sunday_holiday_surcharge_bp` (un solo recargo para
    dominical Y festivo), `overtime_surcharge_bp`, `weekly_ordinary_hours` —
    **completamente distintos** de los cuatro `*_pct_bp` que asumí al
    principio. **Corregido**: `SurchargeTablesTab` se reescribió con los
    campos reales.
  - `HoursRowOut.overtime_hours` (no `extra_hours`) — **corregido**.
  - `PayrollRunOut` publica `tables_used: SurchargeTableUsedOut[]` (lista,
    con los valores completos de cada tabla) y `lines` (no
    `surcharge_table_used: string` y `rows` como asumí) — **corregido**,
    `RunsTab`/`RunDetail` reescritos.
  - `HoursOut`, `PayrollRunOut` y `TipDistributionProposalOut` tienen
    `available`/`reason` que mi primera versión no tenía — **agregados y
    consumidos** (ver §4).
  - `TipDistributionProposalOut.shift_ids` — lo había declarado como
    "asumido, no fijado por el contrato" en la primera versión; **confirmado
    que SÍ existe** en `app/payroll/schemas.py::TipProposalOut`. Ya no es un
    gap.

- **`analytics`**:
  - `MenuEngineeringRowOut` real usa `qty_sold` (no `units_sold`),
    `contribution_margin`/`margin_pct_bp` (no `margin`),
    `popularity_share_bp` (no `popularity_rank`), y agrega
    `classification_reason` — **corregido**.
  - `VarianceByDishRowOut` real usa `theoretical_consumption_share_bp` e
    `ingredients_involved` (no `variance_qty`/`variance_pct_bp` por fila) —
    **corregido**. Además, la ventana real de `GET /admin/variance/by-dish`
    es la del **último conteo aplicado** (`count_id`), no un rango `from`/`to`
    de fecha de negocio — **corregido**: se quitó el `DateRangeFilter`, que
    hubiera sido un filtro que no hace nada.
  - `ReplenishmentOut` trae `available`/`reason` a nivel de pantalla, y cada
    fila trae su propio `reason` cuando `suggested_min` es `null` —
    **agregados y consumidos**.
  - **El más importante**: `GET /admin/variance/by-dish` y `GET
    /admin/control-health/sustained` están detrás de
    `require_feature("inventory.variance")`, **no** de
    `analytics.menu_engineering` como spec.md § 2 da a entender ("Varianza
    por plato" y "Salud sostenida" comparten la MISMA función que ya gatea
    "Varianza"/"Salud del control" en `features/inventory/`, no una flag
    nueva del dominio analítica). **Corregido**: `AnalyticsAdminPage.tsx`
    gatea esas dos pestañas contra `inventory.variance`, y
    `features/analytics/index.ts` gana una TERCERA entrada de navegación
    ("Varianza y salud") detrás de esa función, para que sigan siendo
    alcanzables aunque `analytics.menu_engineering` esté apagada. Esto es una
    decisión de reachability tomada por mí, sobre un backend ya escrito —
    **el Conciliador debería confirmar si esto es el diseño querido o si
    T4 debería mover esas dos rutas a `analytics.menu_engineering`** para
    calzar con la letra de spec.md § 2.

**Otros gaps, no de coordinación:**

- **No hay selector de turnos ni de movimientos de caja** en
  `src/components/`: tres pantallas (`CreateDepositDialog`,
  `ObligationsTab`'s "saldar desde el cajón", y la confirmación de propinas)
  piden ids o quedan limitadas a `"other"` por esta ausencia. Candidato claro
  para un componente compartido futuro.
- **`CsvExportButton` no se usó** en ningún listado nuevo — ver §6.
- La pestaña "Cuentas por pagar" (D-2) es una búsqueda por id, no un listado
  — ver §5/§6, es deliberado dado que el contrato no publica
  `GET /admin/payables` para esta fase.
- No hice un recorrido en navegador real (Playwright/manual): los cuatro
  backends todavía estaban terminando de escribirse cuando cerré este
  entregable, así que no hay servidor completo contra el cual navegar. El
  checklist de la fase (spec.md § 4) exige ese recorrido **antes de cerrar la
  fase**, no antes de cada entregable individual — queda para la verificación
  final del orquestador humano, con los cuatro backends ya en pie.
- No verifiqué exhaustivamente cada campo menor (p. ej. `PayrollRunLineOut.
  ordinary_minutes` vs mostrar sólo horas) — prioricé los campos que la
  pantalla efectivamente consume. Un campo adicional que el backend mande y
  esta pantalla no pinte no rompe nada (todo tipo es defensivo), pero tampoco
  se aprovecha.

---

## 10. Iteración 2 — C5 (bloqueante) y C7 (advertencia)

Dos hallazgos del Conciliador, verificados por el Maestro antes de asignarlos.
Cambios **acotados**: no se rehizo nada de §1-§9.

### C5 / H-6 — no se podía registrar la consignación de la mano del dueño (BLOQUEANTE)

**Defecto**: `CreateDepositDialog.tsx` sacaba el monto de
`const total = validAllocations.reduce(...)` y lo mandaba como `amount:
total`, y `canSubmit` exigía `validAllocations.length > 0`. Consecuencia
doble: `unallocated_amount` nunca podía ser distinto de `0`, y el flujo que
`owner-hand` existe para medir —la mano del dueño retira plata, la guarda, y
la consigna días después, sin turno al que imputarla todavía— no se podía
registrar en el sistema. Era el mismo defecto de fondo que el AGENTS.md
prohíbe («una sola matemática, en el backend»), pero al revés: el frontend no
estaba calculando una cifra de negocio, estaba **impidiendo** capturar la
que la persona tenía en la mano.

**Arreglo** (100% de frontend, verificado contra `backend/app/banking/
schemas.py`/`service.py`/`router.py` ya escritos — el backend ya soportaba
`amount` como campo propio y `allocations: list = []` por defecto):

1. `MoneyInput` propio y obligatorio para el monto consignado (el del
   comprobante del banco). Ese valor —y sólo ése— va en `amount`. Se borró
   el `reduce` como fuente del monto.
2. Las imputaciones son OPCIONALES: `canSubmit` exige monto > 0, foto y
   fecha de negocio; ya no exige ninguna imputación. `allocations: []` (mano
   del dueño) se guarda.
3. Remanente sin imputar (monto − Σ imputaciones) en vivo, rotulado
   explícitamente **"ayuda de captura, no es una cifra del sistema"** — no
   se manda en el POST. Mientras es ≥ 0 no es error. El número de sistema
   real (`DepositOut.unallocated_amount`) lo calcula y lo publica el
   servidor; esta pantalla nunca lo reproduce con su propia resta.
4. Si Σ imputaciones > monto: bloqueo del envío con mensaje propio
   (`role="alert"`, "Las imputaciones suman más que el monto consignado…"),
   Y se sigue manejando `errorMessage` para los códigos del servidor
   (`ALLOCATION_EXCEEDS_DEPOSIT`, `DEPOSIT_EXCEEDS_PENDING`) — la
   validación del cliente es sólo para no hacer perder el viaje, la
   autoridad sigue siendo el servidor.
5. Una fila con id de turno vacío se descarta sin bloquear el guardado
   (el filtro de `validAllocations` ya la sacaba; lo único que la volvía
   bloqueante era el `canSubmit` viejo, ya corregido en el punto 2).
6. Docstring del archivo reescrito: ya no dice "el monto se reparte en
   allocations" (la lectura que produjo el defecto), ahora documenta que
   `amount` es un campo propio y `allocations` es opcional.
7. **Nota de coordinación cumplida**: no se pre-filtraron turnos ni se
   replicó en el cliente el rechazo de imputar a un turno cerrado sin
   conteo que `backend-banco` agrega esta misma ronda — eso lo maneja
   `errorMessage` sobre el código que devuelva el servidor, como con
   cualquier otro rechazo del backend.

**Tests nuevos** (`banking/__tests__/CreateDepositDialog.test.tsx`, 3 casos):
1. Registrar SIN ninguna imputación (mano del dueño): el body del POST lleva
   `amount` tipeado y `allocations: []`. Era el caso que antes no se podía
   ni intentar.
2. Con una imputación y monto mayor que ella: el body lleva el monto
   TIPEADO, nunca la suma — y el remanente en pantalla se lee "$ 300.000"
   con su rótulo de ayuda de captura.
3. Σ imputaciones > monto: bloquea el envío con el mensaje propio, y
   `createDeposit` nunca se llama (la guarda del cliente, aislada del
   `mutationFn`, mismo espíritu que
   `purchases/__tests__/PayableDetailDialog.paymentAmountGuard.test.tsx`
   —territorio ajeno, sólo el patrón de aislar la guarda se tomó prestado).

### C7 / H-7 — default de negocio adivinado en el cliente (ADVERTENCIA)

**Defecto**: `TipsTab.tsx:51` → `value={query.data?.method ?? 'by_hours'}`.
D-3 dice que el método de reparto es configuración de SEDE que resuelve el
backend; una sede en "Por área" mostraba "Por horas" mientras cargaba (o si
la consulta fallaba).

**Arreglo**: se sacó el `?? 'by_hours'`. El `Select` ahora sólo se renderiza
cuando `query.data` está definido (rama nueva, explícita, entre `isLoading`
e `isError`); si la consulta falla, se muestra el error con `errorMessage`,
nunca un método. (Nota técnica: `query.isLoading`/`query.isError` por sí
solos no narrowean `query.data` en la versión de TanStack Query de este
proyecto — el `tsc --noEmit` lo marcó al sacar el `??`; se resolvió con un
`query.data ? (...) : null` explícito, mismo mecanismo de narrowing por
optional-chaining que ya usa `expenses/BreakEvenTab.tsx` con
`!query.data?.available`.)

**Pasada por los cuatro dominios** (`grep` sobre `banking`, `expenses`,
`payroll`, `analytics`, excluyendo `__tests__`) buscando el mismo patrón
`?? <valor de negocio>` sobre datos que el servidor resuelve: el único
hallazgo real fue el de `TipsTab.tsx`. El otro resultado que aparece con una
búsqueda ingenua (`analytics/lib.ts::menuEngineeringTone`,
`?? "default"`) **no** es un default de negocio — es el tono visual (badge
"default"/"warning"/"critical") para una clasificación desconocida, nunca
una cifra ni un valor que el servidor "resuelve" y el cliente adivina; se
dejó tal cual.

### Cumplimiento del "NO TOCAR"

- **`src/api/payroll.ts::getTipsDistributionProposal`** (líneas 200-204 al
  momento del mandato) — **no tocado**. Sigue mandando
  `{store_id, from, to}` tal cual.
- **`src/api/analytics.ts::getVarianceByDish`** — la FUNCIÓN (firma, cuerpo,
  parámetros que manda) **no se tocó**. Lo único que cambió en ese archivo
  es el comentario JSDoc de las líneas 101-107, y sólo porque el mandato lo
  autorizó explícitamente *una vez que T4 entregara*: verifiqué
  `backend/app/analytics/router.py::get_variance_by_dish` y
  `backend/app/analytics/service.py::variance_by_dish` — **T4 ya entregó**
  (`count_id: int | None = Query(default=None)`, con `available`/`reason`
  cuando no hay conteo aplicado, exactamente lo que describe H-3). El
  comentario que llamaba "gap declarado" a no mandar `from`/`to` ahora dice
  que es el contrato — es prosa, no código; no cambia una sola línea de
  comportamiento.
- **`src/audit/**`, `src/components/ui/**`, ningún otro `src/features/`,
  `backend/**`** — no tocados, cero archivos.
- El gap del `id` de conciliación de datáfono (§9, "banking") y el del
  selector de turnos (§6/§9) **se dejaron abiertos** a propósito, como
  mandó esta ronda — no se intentó resolverlos.

### Verificación de esta iteración

Ver §8, subsección "Ronda 2": `tsc --noEmit` limpio, y
`src/features/banking src/features/expenses src/features/payroll
src/features/analytics` en 11 archivos / 23 tests, todos en verde (20 → 23:
+3 de `CreateDepositDialog.test.tsx`). Corrí además, como en ronda 1,
`src/audit/portal-queries.test.ts` y `src/audit/cost-display.test.tsx`
(nombrados explícitamente en el mandato de esta ronda) — 2 archivos / 7
tests, en verde. Sin procesos `vitest`/`tsc` huérfanos después (`ps aux`).
No corrí `npm run test` ni `npm run build`.

### Archivos tocados en esta iteración (lista completa, por `mtime`)

- `frontend/src/features/banking/CreateDepositDialog.tsx` (C5)
- `frontend/src/features/banking/__tests__/CreateDepositDialog.test.tsx`
  (nuevo, C5)
- `frontend/src/features/payroll/TipsTab.tsx` (C7)
- `frontend/src/api/analytics.ts` (sólo comentario, autorizado — ver arriba)
- `features/fase-3-dinero-control/outputs/frontend-fase3.md` (este archivo)

Ningún otro archivo del repo cambió en esta iteración.
