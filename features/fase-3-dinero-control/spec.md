# Fase 3 — Dinero y control

Cuarta fase. Construye sobre 1a, 1b, 2a y 2b. Depende de `docs/SPEC-NEGOCIO.md`
(v0.4) y de `AGENTS.md`. Si algo de acá contradice a la spec de negocio, manda la
spec de negocio y se corrige acá.

## Objetivo

Lo dice §14 en cinco palabras: **«se cierra el mes con números»**. Hasta hoy el
sistema sabe lo que entró por la puerta y lo que cuesta un plato. No sabe qué pasó
con esa plata después de salir del cajón, ni cuánto cuesta tener el restaurante
abierto, ni qué conviene vender.

## Por qué se parte en TRES pedidos, y no en dos

La fila «3. Dinero y control» de §14 lista once capacidades: consignaciones, banco
y mano, conciliación de datáfono y plataformas, obligaciones y gastos, punto de
equilibrio, propinas repartidas, nómina con recargos, reposición sugerida,
ingeniería de menú, varianza por plato y cobro por mesero. **Son tres dominios sin
territorio en común**, y meterlos en un pedido repetiría el error que 1b y 2
evitaron partiéndose.

| | Qué construye | Sobre qué se apoya |
|---|---|---|
| **3a — La plata después del cajón** | consignaciones y «por consignar», libro del banco, mano del dueño, conciliación del datáfono y de plataformas, reparto automático de propinas | lo que 1a y 1b **ya capturan**: cada turno cerrado sabe cuánto debe consignarse, y cada retiro sabe a qué turno pertenece (§6.1) |
| **3b — Lo que cuesta tener abierto** | gastos y obligaciones (arriendo, servicios, impuestos agendados), nómina con recargos y jornada, punto de equilibrio, utilidad | las ventas netas de 1b y el costo teórico de 2a; §7 dice que el MVP captura entradas, salidas y pausas **justamente para esto** |
| **3c — Qué conviene vender** | ingeniería de menú, varianza por plato prorrateada, reposición sugerida y mínimo propuesto por consumo × lead time, órdenes de compra | el costo congelado de 2a y la varianza de 2b, que **acaban de verificarse en navegador** (`docs/ESTADO.md` punto 21) |

**El corte no es por comodidad: es por fuente de verdad.** 3a lee el cajón y lo
confronta con el banco. 3b introduce plata que **nunca pasó por el cajón** (una
transferencia de arriendo, una nómina). 3c no toca plata en absoluto: lee lo que
2a y 2b ya escribieron y saca conclusiones. Tres dominios, tres territorios.

## Lo que NO es fase 3, aunque lo parezca: el pedido 2c

§14 pone en la fila de la **fase 2** tres cosas que 2a y 2b excluyeron a propósito
por no tener nada que ver con costo ni inventario, y que **siguen pendientes**:

- **Domicilio propio y plataformas** (`pos.delivery`, `pos.platforms`), con sus
  comisiones.
- **KDS** con «bump», expedición e impresión por estación (`kitchen.kds`), y
  «marchar» (`pos.courses`).
- **La conexión real con el proveedor tecnológico**: hoy
  `GET /admin/fiscal/export` devuelve un manifiesto JSON con hash por documento,
  no un ZIP con XML, porque todavía no hay XML que empaquetar.

Eso es un pedido propio —**2c**— y no debería colarse dentro de fase 3. Se anota
acá para que no se pierda, no para construirlo acá.

## Decisiones que fase 3 necesita y que no están tomadas

Ninguna de estas la puede tomar un constructor. Están abiertas en
`docs/ESTADO.md` y **bloquean partes concretas** de esta fase:

- **«Sostenido» del semáforo de varianza** (§5.4: «> 4–5 sostenido rojo»). Bloquea
  a **3c**: la ingeniería de menú clasifica platos y necesita el criterio.
- **El monto de la cuenta por pagar contra la factura** (O-5). Bloquea a **3b**:
  un gasto que difiere del papel se arrastra al resultado del mes.
- **Habeas data y `pending_refunds`** (A-1 de 1b-2). No bloquea, pero es deuda
  legal y fase 3 agrega más datos personales (nómina).
- **Reparto de propinas**: §6.2 dice «partes iguales, por horas, por área» sin
  elegir. **3a** necesita saber cuál, o construir las tres y dejarlo configurable.

## Convenciones de ingeniería

Las de 1a, 1b, 2a y 2b, más:

- **La plata sigue en enteros de pesos.** Las horas de nómina **no son pesos**:
  definí su escala entera y declarala, igual que `QTY_SCALE` hizo con las
  cantidades. Un recargo calculado con `float` es un error que nadie encuentra.
- **Las tablas de recargos van parametrizadas con vigencia, NUNCA quemadas en
  código** (§7): nocturno 19:00–06:00 desde dic-2025; dominical 80/90/100 % en
  2025/2026/2027 (Ley 2466 de 2025); jornada de 42 h desde jul-2026 (Ley 2101 de
  2021). Van con fecha de vigencia porque cambian por ley, y una nómina vieja
  tiene que poder recalcularse con las tablas que regían ese mes.
- **Toda la matemática nueva es del backend.** El punto de equilibrio, el reparto
  de propinas y la clasificación de la ingeniería de menú se calculan en el
  servidor; el cliente pinta.
- **«Sin datos» se dice.** Un punto de equilibrio sin costos fijos cargados es
  `null` con motivo, nunca `$0`. Una ingeniería de menú sin ventas del período
  también.
- Alembic arranca donde termine 2b (`0012`).

## Verificación mínima de la fase

Cada pedido llevará su propio checklist. Lo que vale para los tres:

- [ ] Ningún cálculo nuevo con `float`.
- [ ] Toda tabla legal con vigencia, y un test que recalcula un período viejo con
      las tablas de ese período.
- [ ] `null` con motivo en todo indicador sin datos suficientes.
- [ ] Toda capacidad detrás de su función, con `400 FEATURE_DISABLED`.
- [ ] El operador sigue sin ver costos ni márgenes.
- [ ] Recorrido en navegador real antes de cerrar: **es la única forma que
      encontró siete de los defectos de la fase 2** (`docs/ESTADO.md` punto 21).
