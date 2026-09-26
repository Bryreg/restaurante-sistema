# Restaurante Sistema — Spec de negocio

Versión 0.4 (aprobada con los defaults el 2026-09-14; incorpora el requisito de producto
comercializable con funciones habilitables). Fecha: 2026-09-14.

Este documento dice **qué** hace el sistema y **qué reglas no se negocian**. No dice
cómo se implementa: eso lo deciden los agentes del framework en cada fase y queda
registrado en `docs/ESTADO.md`. Cuando una regla de acá cambie, cambia este
documento en el mismo PR.

Está escrito sobre tres fuentes:

1. El proyecto de referencia **`cafe-sistema`**: una cafetería real con dos sedes en
   Colombia, en producción desde mediados de 2026 (81 modelos, 35 routers, 55
   servicios, 97 archivos de test, una auditoría pre-go-live de 55 defectos). Cinco
   lectores lo recorrieron por subsistema. Lo que se toma de ahí se toma **con el
   motivo** que el código o los commits dan; lo que es de cafetería, se deja.
2. Tres investigaciones de dominio: **fiscal y legal** (DIAN, propina, datos
   personales, laboral), **operación de piso y cocina** (mesas, comandas, cursos,
   canales, división de cuenta) y **control interno** (cómo se pierde plata y producto
   en un restaurante y qué lo evita).
3. Un **crítico de completitud** que cruzó todo lo anterior contra el borrador previo
   y verificó las afirmaciones dudosas contra el código de la referencia.

Cuando una regla viene de un bug real de la referencia, se cita entre paréntesis
(«Palmetto, 15-ago»). Cuando viene de una norma, se cita la norma. Lo que no se pudo
verificar en línea queda marcado «(verificar con el contador / con Legal)».

---

## 1. Qué es y para quién

Un sistema de **punto de venta y control interno** para un restaurante de servicio a
la mesa, con dos pantallas y una vista auxiliar:

| Pantalla | Quién la usa | Dónde corre | Para qué |
|---|---|---|---|
| **POS** | quien toma el pedido y quien cobra (mesero / cajero) | tablet o PC compartida en el salón | abrir mesas, tomar comandas, enviarlas a cocina, presentar la cuenta, cobrar, abrir y cerrar turno de caja |
| **Admin** | dueño / administrador | PC | ventas, pedidos, inventario, recetas, preparaciones, turnos, dinero, control; configurar carta y sistema |
| **Cocina** (vista mínima, fase 1b) | cocina y bar | pantalla o tablet en cocina | ver lo enviado por estación, en orden, con tiempo transcurrido; marcar listo |

### 1.1 Producto comercializable: organizaciones, perfiles y funciones habilitables

El sistema **se va a vender a varios restaurantes**, y no todos son igual de
complejos: uno de mostrador no tiene mesas ni cocina que vea comandas; uno de mantel
tiene cursos, división de cuenta y recetas con preparaciones. Por eso:

- **Organización** (el cliente: la empresa que opera uno o más restaurantes) es la
  raíz de todo. Cada **sede** pertenece a una organización; cada administrador
  pertenece a una organización; **toda consulta se acota por organización y por
  sede**. Un mismo despliegue puede servir a varias organizaciones (modo servicio) o
  a una sola (modo dedicado) sin cambiar el modelo. Agregar esto después es la
  migración más cara que existe; agregarlo ahora es una columna y una regla.
- **Catálogo de funciones** (`feature`): cada capacidad opcional del sistema tiene una
  **clave estable**, una descripción en lenguaje del dueño, **dependencias** (la
  varianza de inventario requiere conteos, que requieren recetas) y un estado
  `enabled` / `disabled` por organización, con **override por sede**. La lista
  completa está en §1.2.
- **Perfiles** como punto de partida, no como jaula: `basic` (mostrador y comida
  rápida: venta directa, sin mesas, sin cocina, sin inventario), `standard` (mesas,
  cocina mínima, recetas simples, conteos) y `full` (todo). Elegir un perfil fija
  los valores iniciales; después se ajusta función por función.
- **El backend hace cumplir los flags.** Un endpoint de una función deshabilitada
  responde `400 FEATURE_DISABLED` nombrando la función; la interfaz oculta lo
  deshabilitado y sus menús, pero nunca es la única barrera. Los flags vigentes
  viajan con la sesión (`GET /auth/me`) para que la interfaz se arme sola.
- **Deshabilitar no borra datos** ni rompe la historia: lo registrado con la función
  activa sigue siendo consultable en reportes. Cambiar un flag queda en auditoría.
- **Lo que es ley o integridad no es un flag.** Auditoría, snapshots, idempotencia,
  fecha operativa, propina separada, consecutivo sin huecos, causa tipada y el
  documento fiscal cuando el establecimiento está obligado a facturar son núcleo:
  no se apagan. Lo que sí es configurable ahí es el régimen y el proveedor, no la
  existencia del control.
- **Todo módulo se construye detrás de su flag desde su primer commit**, y sus tests
  corren con el flag encendido y apagado (al menos: apagado, el endpoint rechaza y la
  interfaz no lo muestra). Los parámetros de sede que ya existían (canales activos,
  cursos, estaciones, PIN de supervisor) se expresan como funciones cuando son una
  capacidad, y como parámetros cuando son un valor.

### 1.2 Funciones (catálogo inicial)

| Clave | Qué habilita | `basic` | `standard` | `full` | Requiere |
|---|---|---|---|---|---|
| `pos.tables` | mapa de mesas, unir y mover, comensales | no | sí | sí | |
| `pos.counter` | venta de mostrador: comanda que se cobra en el acto, sin mesa | sí | sí | sí | |
| `pos.takeout` | para llevar con nombre, teléfono y hora prometida | sí | sí | sí | |
| `pos.delivery` | domicilio propio (fase 2) | no | no | sí | `pos.takeout` |
| `pos.platforms` | pedidos de plataformas (fase 2) | no | no | sí | |
| `pos.seats` | asiento por ítem y división por asiento | no | no | sí | `pos.tables` |
| `pos.courses` | curso por ítem; «marchar» (fase 2) | no | sí | sí | `kitchen.view` |
| `pos.modifiers` | grupos de modificadores | sí | sí | sí | |
| `pos.combos` | combos de precio fijo | sí | sí | sí | |
| `pos.daily_menu` | menú del día con opciones por día y franja | no | sí | sí | `pos.combos` |
| `pos.pre_bill` | precuenta y marca `after_bill` | no | sí | sí | |
| `pos.split_bill` | división de cuenta | no | sí | sí | |
| `pos.tips` | pregunta de propina y reporte | sí | sí | sí | |
| `pos.tips_counter` | preguntar la propina también en mostrador (en mesa, para llevar y domicilio se pregunta siempre con `pos.tips`); sin efecto con `pos.tips` apagada | no | no | sí | |
| `pos.discounts` | descuentos con motivos y límites | sí | sí | sí | |
| `pos.courtesies` | cortesías | no | sí | sí | |
| `pos.staff_meal` | comanda de consumo de personal | no | sí | sí | |
| `pos.daily_count` | contador de porciones del día | no | sí | sí | |
| `kitchen.view` | vista de cocina mínima por estación | no | sí | sí | |
| `kitchen.kds` | KDS con «bump», expedición e impresión (fase 2) | no | no | sí | `kitchen.view` |
| `cash.blind_close` | cierre a ciegas en tres pasos (apagado: cierre en un paso, igual con causa) | no | sí | sí | |
| `cash.reserve` | reserva de caja declarada aparte | sí | sí | sí | |
| `cash.pickups` | retiros de efectivo con snapshot | sí | sí | sí | |
| `cash.handovers` | relevo del responsable y arqueo sorpresa | no | sí | sí | |
| `cash.photo_required` | foto obligatoria en cierre y retiro | no | sí | sí | |
| `cash.swaps` | cambio de denominaciones | sí | sí | sí | |
| `roles.supervisor` | rol supervisor con PIN propio | no | sí | sí | |
| `fiscal.dee_pos` | documento equivalente electrónico vía proveedor | sí* | sí* | sí* | |
| `fiscal.invoice` | factura electrónica a cliente identificado | sí* | sí* | sí* | `fiscal.dee_pos` |
| `customers` | maestro de clientes y consentimientos | sí | sí | sí | |
| `catalog.recipes` | fichas técnicas y costo teórico (fase 2) | no | sí | sí | |
| `catalog.preps` | preparaciones en dos modos (fase 2) | no | no | sí | `catalog.recipes` |
| `inventory.perpetual` | movimientos y stock teórico (fase 2) | no | sí | sí | `catalog.recipes` |
| `inventory.counts` | conteos de críticos y completos (fase 2) | no | sí | sí | `inventory.perpetual` |
| `inventory.variance` | varianza, food cost real, salud del control (fase 2) | no | no | sí | `inventory.counts` |
| `inventory.waste` | mermas (fase 2) | no | sí | sí | `inventory.perpetual` |
| `inventory.lots` | lotes y vencimientos (fase 2) | no | no | sí | `inventory.perpetual` |
| `purchases` | proveedores, recepciones, cuentas por pagar (fase 2) | no | sí | sí | `inventory.perpetual` |
| `money.deposits` | consignaciones y por consignar (fase 3) | no | sí | sí | |
| `money.bank` | libro del banco y mano del dueño (fase 3) | no | no | sí | `money.deposits` |
| `money.obligations` | gastos, obligaciones, punto de equilibrio (fase 3) | no | no | sí | |
| `payroll` | horas, recargos y nómina (fase 3) | no | no | sí | |
| `multi_store` | selector de sede y comparativo | no | no | sí | |
| `notifications.push` | push al administrador (fase 2) | no | sí | sí | |

\* `fiscal.dee_pos` se apaga sólo si la organización declara **no estar obligada a
facturar** (persona natural, un local, ingresos bajo el umbral); la declaración
queda registrada con fecha y quién la hizo.

### Supuestos declarados

| Supuesto | Valor asumido | Por qué |
|---|---|---|
| Despliegue | un despliegue puede servir varias organizaciones; la primera versión corre con una | el modelo es el mismo; el aislamiento por organización se prueba desde el primer test |
| País y moneda | Colombia, COP, **enteros de pesos** | igualdad estricta de flotantes trabó el botón «Cobrar» en la referencia (auditoría M11) |
| Obligación de facturar | el establecimiento **está obligado a facturar** y hoy no emite documento electrónico | es el caso general de un restaurante; el tiquete POS de papel sin transmisión a la DIAN dejó de ser válido en 2024 (Res. DIAN 000165/2023 y 000008/2024). Si resulta no obligado (persona natural, un solo local, ingresos < 3.500 UVT), la emisión se apaga por configuración sin cambiar el modelo |
| Régimen | persona natural, régimen ordinario, responsable de INC 8 %, no responsable de IVA, **no franquicia** | franquicia → IVA 19 %; régimen SIMPLE cambia periodicidad y retenciones. Todo es configuración de sede **con vigencia** |
| Precios de carta | **incluyen** el impuesto (Ley 1480/2011 art. 26): base = total ÷ 1,08 | la referencia contó el impuesto como utilidad siete meses por no separarlo |
| Sedes | una, pero **`store_id` en todo** y municipio obligatorio en la sede | la referencia terminó con dos; ICA y numeración DIAN son por sede |
| Dispositivos | una o más tablets compartidas por sede + PC del administrador | dispositivo ≠ persona |
| Caja | **una caja por turno con un responsable** (cajero fijo o quien abre); cobro por mesero con fondo propio en fase 3 | con seis meseros, un arqueo por salida de cada uno reproduce el flujo de la cafetería y no el de un restaurante |
| Stack | default del framework: FastAPI + SQLAlchemy + Pydantic; React + TypeScript + shadcn/ui + Tailwind. PostgreSQL en producción y CI; SQLite sólo en desarrollo local y tests | trampas SQLite↔Postgres en §12 |
| Idioma | UI en español; código, tests y specs técnicas en inglés | regla global del framework |
| Zona horaria | `America/Bogota`, sin horario de verano; la **fecha operativa** es un dato propio, nunca derivado de UTC | «el bug que este repo ya sufrió cuatro veces» en la referencia |
| Horario | puede cerrar después de medianoche; **hora de corte** por sede (default 06:00) separa «cruce de medianoche» de «turno abandonado» | la referencia lo distingue por hora, no por fecha (`HORA_CORTE_MADRUGADA = 6`) |

---

## 2. Actores, identidad y permisos

### 2.1 Dos identidades: el dispositivo y la persona

- El **dispositivo** se activa una sola vez con el **PIN de sede** y queda con una
  sesión larga. Prueba *dónde* se opera, no *quién*. El PIN de sede se rota desde
  admin.
- La **persona** se identifica en el dispositivo con su **PIN personal de 4 dígitos**.
  Queda como persona activa hasta que otra teclea el suyo, hasta que pasan **N
  minutos sin uso** (parámetro, default 3) o hasta que cierra el turno. Identificarse
  la agrega automáticamente al roster del turno con hora de entrada.
- Las **acciones sensibles** vuelven a pedir PIN aunque haya persona activa: cobrar,
  anular un ítem enviado, cortesía, descuento sobre el límite, retiro de efectivo,
  merma. Así una tablet abandonada no vende a nombre de quien la dejó (atribución
  cruzada, auditoría H9 de la referencia).
- El **administrador** entra con correo y contraseña en PC, pertenece a **una
  organización** y ve sólo sus sedes; tiene además un PIN propio (no compartido) para
  autorizar en el POS.
- Seguridad del PIN: hasheado; **cinco intentos fallidos bloquean** la identificación
  de esa persona por 15 minutos y avisan al administrador.

Reglas:

- Toda escritura que hace una persona guarda **`employee_id` (FK real) y
  `employee_name` (copia congelada)**. Los empleados nunca se borran: se
  desactivan. Cuando una acción fue autorizada por otra persona, guarda además
  **`authorized_by`**.
- Ninguna sesión ni token vive en `localStorage`: cookies **`httpOnly`**, frontend y
  API bajo el **mismo origen**.
- Al cerrar el turno o desactivar el dispositivo se borra toda atribución residual.

### 2.2 Roles

| Rol | Cómo entra | Qué puede hacer |
|---|---|---|
| **Operador** (mesero o cajero) | PIN personal en el dispositivo | abrir mesas, tomar y enviar comandas, presentar la cuenta, cobrar (si `can_charge`), marcar agotados, mermas rápidas, entrar y salir del turno |
| **Responsable de caja** | operador designado al abrir el turno o en un relevo | además: movimientos de caja, relevo, cierre |
| **Supervisor** (encargado de turno) | PIN propio | autoriza anulaciones, cortesías y descuentos sobre el límite; **no** autoriza retiros ni rescates de turno |
| **Administrador** | correo y contraseña; PIN propio en el POS | todo, incluidos retiros, rescates, carta, recetas, inventario, compras, dinero, reportes, usuarios, configuración |
| **Contador** (fase 2) | correo y contraseña | sólo lectura de reportes y exportes |

- Cada autorización queda a nombre de quien la dio: existe un reporte de
  **autorizaciones por autorizador**. Más de la mitad de los fraudes por anulación
  son colusivos (mesero anula, encargado aprueba); con un PIN compartido la
  autorización es teatro.
- El operador **no ve costos ni márgenes**: los esquemas de respuesta para
  dispositivo no tienen esos campos.
- El **alcance por organización y por sede** se verifica en cada lectura y escritura
  que recibe un id (commit 305e335 de la referencia: «cerrar el mes» de la sede
  vecina estaba a un número de distancia). Un id de otra organización responde `404`.

---

## 3. El eje operativo: día → turno de caja → comanda → cobro

Tres entidades con estados explícitos que **sólo el backend** cambia; la interfaz
los refleja. Es el patrón *spine* del framework.

### 3.1 Día operativo

- Uno por sede y **fecha de negocio** (constraint único). Se crea al abrir el primer
  turno (get-or-create bajo savepoint: sin eso, la carrera entre dos tablets tumbaba
  la venta en la referencia).
- Puede tener **varios turnos de caja** (almuerzo, cena). El cierre de un turno lleva
  `closes_day` (marcado por defecto en el turno cuya hora de cierre es la última del
  horario de la sede); al cerrar el turno que cierra el día, el día queda cerrado.
  Un día también se cierra por rescate administrativo.
- Una venta a las 00:30 pertenece al día del turno que la contiene. Un turno que
  sigue abierto **pasada la hora de corte** es un turno abandonado: el POS avisa,
  las ventas nuevas se sellan con la fecha de hoy y el administrador tiene un
  cierre administrativo (§3.7). **Todo tiquete se sella con su fecha operativa**,
  siempre (la referencia sólo lo hacía en el caso abandonado, por compatibilidad
  con un informe viejo; acá no hay legado que cuidar).

### 3.2 Turno de caja

Es la **unidad de responsabilidad sobre el dinero**. Estados: `abierto → cerrado`.
Un solo turno abierto por sede, con **índice único parcial** en la base y `409` en
la carrera (la referencia lo tiene: `caja.py:296-303`).

> **Regla vigente desde el 2026-09-26 (decisión del dueño): el cajón abre sólo con
> los sobres por consignar, y «base» significa UNA sola cosa: la base de respaldo.**
> Lo que sigue en esta sección sobre la «base fija» describe la regla anterior; queda
> para los turnos abiertos antes del cambio (cada turno congela su regla al abrir:
> `shifts.opening_mode` y `shifts.opening_fixed_base`, así que ningún número
> histórico se reescribe) y para una sede con `opening_mode = fixed_base`. Toda sede
> existente pasó a la regla nueva con la migración `0029`, y toda sede nueva nace
> con ella.
>
> 1. **Apertura = cuadre de los sobres** (como café-sistema). Para quien puede
>    manejar la caja, lo primero después del PIN —si no hay turno abierto— es el
>    cuadre: elige los sobres de días por consignar (`shift_carry_ins`, los «días
>    por consignar») que va a trabajar en el turno —ve sólo la **fecha** de cada
>    sobre, nunca su monto— y cuenta **cada sobre aparte** por denominaciones, a
>    ciegas. Al sellar (`POST /shifts/opening-counts`) el servidor revela, por
>    sobre, lo esperado (su saldo por consignar), lo contado y la diferencia,
>    **atribuidos a quien contó**; con diferencia, abrir exige causa tipada.
>    **Esperado de apertura = suma de los sobres elegidos. No hay base fija.** Sin
>    sobres, el cajón abre vacío. Si el cajero no llegó, el supervisor abre y
>    después le entrega la caja con un relevo.
> 2. **Base de respaldo** (`cash_reserve`): plata **aparte** del cajón, con monto
>    fijo por sede (`store_cash_settings.cash_reserve_default`, Ajustes › Caja), por
>    si la plata de los sobres no alcanza para dar vueltas. **No entra al cuadre**:
>    el cuadre sólo cuenta lo que va a estar en el cajón. Tiene su propio libro
>    (`cash_reserve_movements`): **tomar de la base** exige el PIN de un supervisor
>    o administrador y entra al cajón como préstamo (suma al esperado:
>    `reserve_loan`); **devolver a la base** lo hace quien tiene la caja y sale del
>    cajón. El préstamo vuelve **el mismo día, antes del conteo de cierre**: con
>    préstamo abierto el conteo de cierre no entra (`RESERVE_LOAN_OPEN`, y el paso
>    0 del cierre lo lista). Lo prestado vuelve a la base, nunca al banco: resta de
>    `to_deposit`. Un préstamo sin devolver aparece en la bandeja de Hoy.
> 3. **El custodio verifica la base** (supervisor o administrador), a ciegas y
>    **aparte del cuadre del cajero** («Verificar base»): cuenta, y el servidor
>    revela lo esperado (monto fijo − prestado sin devolver) y la diferencia.
> 4. **Una caja por sede.** El supervisor autoriza en el piso (retiros, base,
>    apertura); el dueño guarda la configuración y los rescates.
>
> El incidente que esto evita, del café: la base de emergencia se mezcló con la
> plata consignable y el sistema pidió consignar $697.900 en vez de $197.900. Por
> eso la palabra «base» ya no nombra la apertura del cajón: en pantalla la
> apertura se llama «Apertura» (en código sigue siendo `breakdown.base` /
> `opening_cash_total`), y «base» es sólo la base de respaldo. Fórmulas vigentes
> (una sola vez, en `app/shifts/service.py`):
>
> - `esperado = apertura + ventas en efectivo + ingresos − egresos − retiros −
>   consignado desde el cajón + prestado por la base sin devolver`
> - `a consignar = contado − base fija del turno (0 con sobres) − propinas en
>   efectivo − lo de días anteriores que sigue en el cajón − prestado por la base
>   sin devolver`

**Base fija (regla anterior).** La sede define `opening_cash_fixed` (por ejemplo $200.000). Todo turno
abre con la base fija y al cerrar deja la base fija en el cajón. Es la práctica
colombiana habitual y elimina de un golpe tres mecanismos que la referencia
necesitó (cuadre inicial por saldos de días anteriores, «sobrante consignable»,
cascada entre días) y sus bugs (Palmetto, 18-jul: la misma plata pedida dos veces).

> **Cambio decidido por el dueño (2026-09-24): la venta sin consignar se queda en
> el cajón.** La base fija sigue siendo la base, pero la plata de días anteriores
> que todavía no se consignó ya no sale en sobre: queda en el mismo cajón. Para no
> repetir el bug de la referencia, tres reglas:
>
> 1. **Al abrir se marca, uno por uno, qué días están en el cajón** — ninguno viene
>    marcado (marcarlos todos por defecto es lo que pidió la misma plata dos
>    veces). El conteo de apertura se compara contra base fija + el saldo de lo
>    marcado, que calcula el servidor (`shift_carry_ins`).
> 2. **Lo que un turno debe consignar es sólo su venta**: `to_deposit = contado −
>    base fija − propinas retiradas − lo de días anteriores que sigue en el cajón`.
>    El saldo de esos días sigue siendo de su turno de origen.
> 3. **Consignar desde el POS** saca la plata del cajón (resta del esperado),
>    descuenta del saldo del día desde que se registra y queda por confirmar; el
>    administrador la confirma o la rechaza (reversa: vuelve al saldo y al cajón).
>
> No hay cascada entre días ni «sobrante consignable»: cada peso tiene un solo
> turno de origen. Ver `docs/ESTADO.md` §39.

**Apertura** (un solo paso, rápido: el gate se paga una vez por turno, no por venta):

- Quién abre (PIN) y quién es el **responsable de caja** (por defecto quien abre).
- Base contada **por denominaciones** (monedas 50 a 1.000; billetes 2.000 a 100.000);
  el desglose se guarda. Si la contada difiere de la base fija: **justificación con
  causa tipada** obligatoria.
- **Reserva de caja** (plata de emergencia que vive en el cajón y no se usa) en un
  campo aparte que **no entra** al esperado ni al cuadre (Palmetto, 15-ago: una
  reserva contada dentro de la base fabricó un sobrante de $500.000 que el sistema
  mandó consignar). *Desde el 2026-09-26 la reserva es la **base de respaldo**:
  vive aparte del cajón, con monto fijo y libro propio (ver el recuadro de arriba);
  con la regla de sobres ya no se declara al abrir.*
- El conteo de inventario **no es gate** de la venta.

**Durante el turno**:

- **Movimientos de caja**: ingreso o egreso con **causa tipada** (`petty_expense`,
  `emergency_purchase`, `refund`, `tip_payout`, `other_income`, `other_expense`),
  motivo, monto > 0, persona, foto. Gastos menores hasta `petty_cash_limit` (default
  $50.000) sin autorización; por encima, PIN de administrador. Un egreso de compra
  puede convertirse después en recepción de inventario (§5.6).
- **Cambio (sencilla)**: es un canje de denominaciones con **neto cero**
  (`cash_swap`), nunca un egreso: un egreso por cambio baja el esperado y fabrica un
  sobrante.
- **Retiro de efectivo** (`cash_pickup`): PIN de administrador, monto, desglose
  opcional, número de sobre opcional, y **snapshot del esperado en ese instante**
  para poder acotar una diferencia a «antes o después del retiro». No se edita ni
  se borra: se reversa con motivo y ambos quedan. Alerta cuando el efectivo en el
  cajón supera `cash_pickup_threshold` (default $500.000).
- **Relevo del responsable de caja**: quien entrega y quien recibe cuentan; el
  sistema congela el desglose (base, ventas en efectivo, ingresos, egresos,
  retiros, esperado, contado, diferencia). Las entradas y salidas de los demás del
  roster son PIN + hora, sin arqueo.
- **Arqueo sorpresa** (`spot_check`): el administrador, con su PIN, cuenta en
  cualquier momento sin cambiar de responsable; queda como un relevo sin cambio de
  persona. Es el control que más acorta la duración de un fraude.

**Cierre** (un solo POST atómico; en **tres pasos, a ciegas**):

1. El responsable teclea el conteo por denominaciones, el total del datáfono, el
   total de transferencias (saldo de Nequi/Daviplata recibido) y la foto **sin ver el
   esperado**. Mostrar el esperado antes de contar invita a «cuadrar» el conteo.
2. El backend revela esperado, diferencia y la **ecuación** (base fija + ventas en
   efectivo + ingresos − egresos − retiros = esperado; contado − esperado =
   diferencia), congela el conteo aunque se cancele, y hace lo mismo con datáfono y
   transferencias contra lo registrado.
3. Si la diferencia no es cero: **causa tipada** (`change_error`,
   `expense_without_voucher`, `tips_mixed`, `unrecorded_sale`, `counting_error`,
   `unknown`) más texto libre, y confirmación.

Reglas del cierre:

- **Una sola fórmula, escrita una vez en el backend.** El frontend no la recalcula.
- Datáfono obligatorio si hubo ventas con tarjeta; transferencias obligatorias si
  hubo.
- **Propinas en efectivo**: salen del cajón al cierre (`tips_cash_out`); las
  electrónicas quedan como pasivo con el personal (§6.2).
- **Tolerancias** (parámetros de sede; defaults de una plantilla comercial
  colombiana, no de norma): hasta $20.000 se cierra con causa `unknown`; de $20.001
  a $100.000 la causa debe ser identificada; sobre $100.000 alerta crítica al
  administrador. **Nunca bloquea el cierre**: bloquear deja el turno abierto y
  vendiendo, que es el bug del turno abandonado. Tres turnos seguidos con
  diferencia distinta de cero cerrados por la misma persona → alerta aunque los
  montos sean chicos.
- El cierre recibe la diferencia que la interfaz mostró; si un movimiento
  concurrente la cambió, el backend responde con la nueva y se vuelve a preguntar
  (carrera documentada y no resuelta en la referencia, auditoría M15).
- **Foto** del conteo obligatoria en cierre y retiro, validada **en el backend** (en la
  referencia la obligatoriedad vivía sólo en la interfaz y la foto se perdía cuando
  el POST fallaba). Configurable por sede.
- Gates: no se vende sin turno abierto; no se cierra con comandas abiertas salvo
  **traslado explícito** al turno siguiente (queda en ambos turnos: abierta en uno,
  cobrada en el otro; el efectivo cuenta donde se cobra).
- El administrador puede marcar un cierre como **revisado** (`reviewed_by`,
  `reviewed_at`); los no revisados aparecen en «Requiere tu atención».
- **El sistema nunca calcula una «deuda del empleado»** por faltantes ni genera
  descuentos de nómina: el Código Sustantivo del Trabajo (art. 149) prohíbe
  deducir del salario sin orden escrita del trabajador para cada caso o mandamiento
  judicial. El sistema reporta diferencias por persona; lo demás es decisión y
  riesgo del dueño, y conviene decírselo antes (verificar con abogado laboral).

### 3.3 Comanda (el pedido del cliente)

Unidad de venta. Pertenece a un turno, a quien la abrió (`opened_by`), a un
**canal** y, si es de mesa, a una o más mesas. Guarda **comensales** (`covers`,
default = sillas de la mesa).

Canales y sus datos:

| Canal | Datos propios | Fase |
|---|---|---|
| `counter` | venta de mostrador: sin mesa, se cobra en el acto (la comanda nace y se paga en un solo flujo); es el modo del perfil `basic` | 1b |
| `dine_in` | mesa(s), comensales, asiento opcional por ítem | 1b |
| `takeout` | nombre y teléfono del cliente, hora prometida, estado «listo para recoger» | 1b |
| `delivery` (propio) | dirección, teléfono, domiciliario, **cargo de domicilio como línea** (lleva INC), cobro `pending` hasta que el domiciliario liquida; el efectivo de domicilios se arquea aparte | 2 |
| `platform` (Rappi, Didi, iFood) | `source`, `external_id`, precio del canal plataforma, medio de pago `platform` que **no entra al cajón** (cuenta por cobrar), % de comisión por plataforma, cancelación tras preparar = venta compensada, no merma | 2 |
| `staff_meal` | quién consumió (`consumed_by`), precio 0, sin impuesto ni propina; gasta receta; se valoriza a costo teórico y se reporta por empleado y mes | 1b |

Cada canal es una función habilitable (§1.2); los que la sede no usa no aparecen.

Estados de la comanda:

```
abierta ──► por_cobrar (cuenta presentada) ──► pagada ──► cerrada
   │
   ├──► fusionada   (sus ítems pasaron a otra comanda; queda la traza)
   └──► anulada     (motivo tipado; PIN si tenía ítems enviados o cuenta presentada)
```

Estados de cada **ítem**:

```
pendiente ──► enviado ──► listo ──► entregado
    │            │
    │            └──► anulado (motivo tipado + PIN; el insumo ya se gastó → merma)
    └──► anulado (motivo tipado, sin autorización)
```

Reglas:

- La comanda **vive en el servidor** desde el primer ítem; cada cambio es un POST.
  Una mesa abierta dura horas y la toca más de un dispositivo.
- **Mesas**: una comanda puede referenciar **varias mesas** (unir mesas: todas quedan
  ocupadas apuntando a la misma comanda y se liberan juntas). Una mesa tiene **a lo
  sumo una comanda abierta** (constraint). Mover una comanda de mesa queda
  registrado. Varias comandas independientes en una misma mesa grande: fase 2.
- **No existe transferir ítems sueltos entre comandas.** Sólo unir comandas completas
  (la origen queda `fusionada`) y mover de mesa. Es lo que cierra el esquema «rueda
  de carreta» (una gaseosa cobrada diez veces en efectivo y presente en una sola
  comanda al cierre).
- Cada ítem **congela**: nombre, precio unitario del canal, tasa de impuesto, costo
  teórico (nulo hasta que exista la receta), versión de receta, texto de
  modificadores, curso, estación, asiento. Cambiar la carta mañana no cambia la
  venta de hoy; cambiar el precio durante una comanda abierta no toca los ítems ya
  agregados y los nuevos toman el precio nuevo.
- **El precio lo fija siempre el servidor**; el cliente manda ids y cantidades. **No
  existe producto de precio abierto** («varios $12.000»): si hace falta, es un
  producto real creado por el administrador.
- **Curso** por ítem (`beverage`, `starter`, `main`, `dessert`) con default por
  categoría. La acción «marchar» (`fired_at`) para servicio por tiempos entra en
  fase 2 si el restaurante sirve por tiempos.
- **Estación** por producto (cocina caliente, fría, bar, postres, ninguna). Un
  producto sin estación (una gaseosa) pasa de `enviado` a `entregado` sin pasar por
  cocina, para no ensuciar los tiempos.
- **Enviar a cocina** manda sólo los ítems `pendiente`, como una **ronda numerada**
  dentro de la comanda; cocina ve la ronda, no la comanda entera. Es el evento que
  gasta el insumo (§5.3), estampa `sent_at` y descuenta el contador de agotados.
- **Cobrar con ítems pendientes** los envía automáticamente marcados
  `sent_at_payment`; el reporte por persona muestra el porcentaje. Rechazar el cobro
  rompería la operación en hora pico; dejarlo sin rastro deja el consumo teórico en
  cero y el inventario acusando robo.
- **Cuenta presentada** (`bill_presented_at`): la precuenta es un documento **no
  fiscal**, sin consecutivo, con la leyenda «NO ES FACTURA — documento informativo»
  (la SIC reprochó las «prefacturas» en 2022; verificar con Legal). Desde ese
  instante, toda anulación, descuento, cortesía, unión o movimiento lleva
  `after_bill = true` y sube al reporte con prioridad: el fraude más común de
  servicio a la mesa vive entre presentar la cuenta y cobrar. Anular una comanda con
  cuenta presentada exige PIN aunque no tenga ítems enviados. Se cuentan las
  impresiones de precuenta por persona.
- **Anulaciones** con **motivo tipado** (`customer_changed_mind`, `server_error`,
  `kitchen_error`, `long_wait`, `walkout`, `duplicate`, `other` + texto). Anular un
  ítem ya enviado **no devuelve el insumo**: genera merma (`customer_return` o el
  motivo que aplique). Es lo contrario de la referencia, que reponía siempre.
- **Cortesía**: ítem a precio 0 con motivo tipado (`complaint`, `promo_owner`,
  `guest_of_owner`, `other`) y PIN. Gasta receta, no suma venta, se reporta por
  persona **a costo teórico**. Límite por turno (`courtesy_shift_limit`) → alerta.
- **Agotado del día** («86»): por producto, por opción de modificador y por opción
  de combo; se propaga a todos los dispositivos en segundos y deshabilita el botón.
  **Contador de porciones** opcional («hoy hay 20 sancochos») que descuenta al
  enviar y pasa a agotado en cero. Se limpia al abrir el día siguiente; queda quién y
  a qué hora → reporte «agotados del día» (ventas perdidas).
- **Concurrencia**: la comanda tiene versión optimista; dos tablets editando la misma
  comanda reciben `409` si su versión es vieja. Agregar ítems lleva clave de
  idempotencia (un doble toque no duplica líneas). Tras `bill_presented_at` la
  comanda no admite ítems nuevos sin PIN.
- Toda escritura que mueve plata o estado (enviar, cobrar, marcar listo, producir)
  lleva **clave de idempotencia** reservada dentro de la misma transacción: «el
  guardián del front es cortesía, no garantía» (la referencia no la aplicó al cobro y
  un doble toque podía duplicar la venta).
- Tiempos: `opened_at`, `bill_presented_at`, `paid_at`, `closed_at`; por ítem
  `sent_at`, `ready_at`, `served_at`. Un ítem nunca marcado `served` tiene tiempo
  `null`, no cero.

### 3.4 Cobro

- **Propina**: se pregunta **al presentar la cuenta**, antes de emitir el documento
  («¿desea incluir servicio voluntario del 10 %?»). Base = subtotal neto de
  descuentos **sin impuesto**. Se guarda si se preguntó, si aceptó, si modificó y el
  monto; el porcentaje sugerido **no puede superar el 10 %** (Ley 1935 de 2018); el
  cliente puede dar más y queda marcado como decisión del cliente. Va **separada** de
  la venta: no es ingreso, no causa impuesto, no entra en ventas netas ni en margen,
  y se reporta por turno, por persona y por medio de pago.
- **Pagos como tabla**: uno o más por comanda. Medios: efectivo, datáfono,
  transferencia o QR (Nequi, Daviplata, Bre-B), plataforma, bono, otro con nota; cada
  uno con referencia opcional y con su **código DIAN de medio de pago** (§8).
- **División de cuenta**: «partes iguales» = un solo documento con N pagos; «por
  ítems» o «por asiento» = **N sub-cuentas, cada una con su propio documento**
  (impuesto por tasa, pregunta de propina y consecutivo propios), porque el cliente
  que paga lo suyo pide su comprobante y el tope de 5 UVT es por documento. Un ítem
  compartido se reparte en N porciones iguales. Fraccionar para quedar bajo el tope
  queda auditado (alerta cuando una mesa genera varios documentos justo bajo el
  tope).
- **Descuento**: por ítem o por comanda, siempre con motivo tipado (`promo`,
  `complaint`, `owner`, `employee`, `other`); nunca supera el bruto de la línea; el
  de comanda se **prorratea** entre líneas en proporción al bruto, redondeado a peso
  con el residuo en la línea mayor. Hasta `discount_limit_pct` (default 10 %) lo
  aplica el operador; por encima, PIN. Acumulado por persona y turno sobre
  `discount_daily_limit_pct` (default 5 % de sus ventas) → alerta. Los combos no
  aceptan descuento de línea.
- **Impuesto por línea**: base = round(total_línea ÷ (1 + tasa)); impuesto = total −
  base; totales = Σ líneas por tasa. Enteros de pesos, redondeo half-up, y la
  validación de la DIAN tolera el peso de diferencia.
- Cambio sólo sobre el efectivo. La venta es **todo o nada** (comanda, pagos,
  documento, consumo, totales del turno, auditoría en una transacción). Dos
  dispositivos cobrando la misma comanda: uno gana, el otro `409`. Un cobro que falla
  **conserva la cuenta**.
- El **documento** que se emite al cobrar es el documento fiscal de §8 (documento
  equivalente electrónico POS, o factura electrónica cuando el cliente la pide o el
  monto lo exige). Se imprime desde el navegador (58/72/80 mm) o se comparte; se
  cuentan las **reimpresiones** por persona. Impresora térmica dedicada: fase 2.

### 3.5 Anulaciones y notas

- Anular una comanda **antes** de emitir documento: motivo tipado; PIN si tiene ítems
  enviados o cuenta presentada; mermas por los ítems enviados.
- Anular una venta **ya documentada**: sólo administrador, mediante **nota de ajuste**
  (para documento equivalente) o **nota crédito** (para factura), con numeración
  propia sin huecos, motivo, y **por línea** «se usó» (no vuelve al inventario) o
  «vuelve». La plata se devuelve siempre: si fue en efectivo y hay turno abierto,
  egreso `refund`; si no hay turno abierto, queda una **devolución pendiente** que el
  administrador paga después desde un turno (egreso `refund` en ese turno) o desde su
  mano, y así entra al esperado del turno que la paga.
- **A diferencia de la referencia, una nota nunca reescribe los totales de un turno
  cerrado.** El documento original queda `reversed`; nada se borra.
- Reporte de anulaciones por persona con: cantidad, monto, **porcentaje sobre sus
  ventas**, `after_bill`, **minutos desde el envío o desde la cuenta presentada**,
  **medio de pago con que cerró la comanda** (anulaciones concentradas en efectivo
  son la firma) y quién autorizó. Alerta configurable: más de 5 anulaciones por día o
  más del 3 % de sus ventas.

### 3.6 Mesas y estaciones

- Mesa: zona, número, sillas. Estados derivados: libre, ocupada (con tiempo y total),
  por cobrar. Reservada y sucia: fase 2.
- Sede: **horario de apertura por día** (para rotación y ventas por hora abierta).
- Estación de bar: las bebidas de la ronda van a su propia cola. `listo` lo marca
  cocina o bar; `entregado` lo marca el mesero.

### 3.7 Rescates del administrador

Todo estado atascado tiene una salida administrativa, con condiciones estrictas,
motivo obligatorio y marca visible en auditoría:

| Rescate | Cuándo | Qué hace |
|---|---|---|
| Cierre administrativo | turno abandonado (pasada la hora de corte) | cierra con el esperado, diferencia 0, marcado `closed_without_count`; resta lo ya retirado; cierra el día |
| Reabrir cierre | una venta de último momento después de cerrar | reabre el turno; el conteo previo queda como histórico |
| Cancelar turno | abierto por error, sin ninguna actividad | lo elimina lógicamente |
| Ajustar apertura | la base o la reserva se contaron mal | reescribe base, reserva y **todo lo derivado** con la misma función del flujo normal |
| Trasladar comandas | cierre con mesas abiertas | pasa las comandas abiertas al turno siguiente, con traza |

---

## 4. La carta: insumos, preparaciones y platos

Tres **tipos explícitos** de producto, no un catálogo único con banderas (en la
referencia un campo con doble significado rompió el costo por gramo: 1 g de mezcla
valía $3.600 en vez de $1,28).

### 4.1 Insumos (lo que se compra)

- Unidad de **uso** (g, ml, unidad) y unidad de **compra** con el factor entre ambas.
  La conversión al recibir es determinística; lo dudoso se pregunta, nunca se adivina.
- **Rendimiento** (`yield_pct`, default 100): la pechuga con hueso rinde 85 % limpia.
  La receta expresa **cantidad limpia** (el cocinero pesa lo limpio) y el consumo
  teórico descuenta cantidad ÷ rendimiento. Sin esto todos los costos se subestiman
  y la varianza parece robo crónico.
- Costos: **oficial** (lo fija el dueño y manda) > **promedio ponderado** de las
  compras desde el último conteo completo > **última compra** > estimado > sin costo.
  Todo costo viaja con su **origen**; **nunca un cero mudo**. La última compra alimenta
  la alerta de precio (> 15 % contra el promedio, o 10–12 × la referencia = precio de
  empaque tecleado como unitario).
- Bajo INC, el **IVA pagado en compras no es descontable** y es mayor valor del costo:
  cada línea de compra guarda base, tarifa y valor de IVA, y el costo del insumo lo
  incluye. Bajo IVA (franquicia) es descontable y se reporta aparte. Ignorarlo
  subestima el costo cerca de un 19 % en insumos gravados.
- **Umbral de stock mínimo obligatorio**, nunca cero (en la referencia, 55 de 56
  productos quedaron con el motor de alertas apagado). Lead time del proveedor. En
  fase 3 el sistema propone el mínimo a partir de consumo × lead time.
- Perecedero, categoría, proveedor habitual (FK), activo, **crítico** (entra al conteo
  rápido).
- **Consumo no predecible** (`consumption_untracked`): servilletas, sal de mesa,
  aceite de fritura, aseo. Sin receta; se mide entre dos conteos.
- **Sustituto** opcional con un solo camino de consumo y cascada, usado igual por
  venta, cortesía, consumo de personal y producción (en la referencia dos caminos
  dejaron la leche entera en −4 y la deslactosada en +19).

### 4.2 Preparaciones (lo que cocina produce)

La salsa, el caldo, la masa, el arroz del día, el pollo desmechado.

- **Receta** propia (insumos y/u otras preparaciones, cantidad y unidad por línea),
  **rendimiento estándar** en su columna, merma de proceso esperada, **vida útil**.
- **Dos modos excluyentes**, elegidos por preparación:
  - **Por lote** (`stock_tracked`): producir descuenta los insumos y crea stock de la
    preparación con vencimiento y costo por lote; el plato consume preparación. Para
    las caras, perecederas o vendidas por porción (caldo base, proteína desmechada).
  - **Explotada** (`exploded`): sin stock ni lotes; enviar el plato descuenta los
    insumos de la preparación × (cantidad ÷ rendimiento estándar). Para las baratas
    y ubicuas (hogao, aderezos). Es el default: obligar al modo lote para todo mata el
    módulo (si nadie registra el caldo de cada mañana, la preparación queda negativa,
    los insumos sobrevalorados y «el dueño sale a buscar un ladrón»).
  - Cambiar de modo es acción del administrador que cierra los lotes abiertos con un
    ajuste de conteo.
- **Producción rápida** desde el POS o cocina en dos toques: preparación + confirmar,
  con cantidad precargada = rendimiento estándar; se guarda rendimiento esperado y
  real, alerta si difieren más de 15 %. Clave de idempotencia.
- Costo por unidad: **estándar** (Σ insumos ÷ rendimiento esperado, origen `recipe`)
  mientras no haya lote; **real por lote** (Σ insumos ÷ cantidad real) cuando lo hay.
  El costo **propaga** al plato (en la referencia no propagaba).
- Una preparación por lote con stock ≤ 0 al enviar un plato no bloquea la venta:
  alerta `prep_no_production`, distinta de «insumo negativo» porque la causa probable
  es otra. Las preparaciones por lote se **cuentan** en su unidad.
- Regla de coherencia: el insumo se descuenta **una sola vez** (al producir, en modo
  lote; al enviar, en modo explotado). Nunca ambos.

### 4.3 Platos (lo que se vende)

- Nombre, categoría configurable, **estación**, **curso** por defecto, descripción,
  foto, activo, disponible hoy, contador de porciones opcional.
- **Ficha técnica** (receta): insumos y preparaciones con cantidad y unidad por
  línea. Costo teórico = Σ (insumo: cantidad ÷ rendimiento × costo) + Σ (preparación:
  cantidad × costo). **Food cost %** = costo ÷ precio neto de impuesto (referencia
  del sector: 28–35 %). Mientras no haya fichas, el costo es «estimado» con origen
  visible, y la varianza no se calcula.
- Validación de **recetas sospechosas de unidad** (18 «kg» donde iban 18 g).
- **Cobertura de recetas**: plato vendido sin receta ni insumo directo no descuenta
  nada; la venta sigue, alerta diaria por plato, reporte de «platos que no descuentan».
- **Precio por canal** (mesa obligatorio; para llevar, domicilio y plataforma
  opcionales, caen al de mesa). **Tasa de impuesto** por producto, con default la del
  establecimiento: bajo INC, **todo el consumo es INC 8 %** incluidas bebidas
  alcohólicas y gaseosas, para llevar y domicilio (art. 512-1 y 512-9 ET); sólo un
  bien excluido vendido sin transformación queda por fuera.
- **Modificadores**: grupos con `required`, `min`, `max`; opciones con ajuste de precio
  (positivo, cero o negativo) y `recipe_effect` (nulo en fase 1b; suma, quita o
  reemplaza insumos en fase 2). Se congelan como texto en el ítem y van resaltados a
  cocina. Nota libre por ítem aparte.
- **Combos y menú del día** («corrientazo»: sopa + principio + proteína + jugo):
  producto sombra de precio fijo con grupos de opción; las **opciones activas se fijan
  por día** («armar el menú de hoy» en menos de dos minutos), con **vigencia por
  franja horaria y días**, y cada opción puede agotarse por separado. Entra al
  documento como una línea; el consumo y el mix se calculan por componentes. Un combo
  sin grupos no es vendible (la referencia cobró combos completos sin entregar nada).
- Productos **sin receta** (una gaseosa) consumen un insumo uno a uno.
- Baja lógica siempre.

---

## 5. Inventario

### 5.1 Un solo libro de movimientos, con causa tipada

Inventario perpetuo teórico de insumos y preparaciones por sede, corregido por
conteos. Todo cambio es un **movimiento** con `cause` **enumerada** (`purchase`,
`production_in`, `production_out`, `sale`, `void_after_send`, `waste`,
`count_adjustment`, `transfer_in`, `transfer_out`, `note_return`,
`manual_adjustment`), cantidad, costo unitario al momento con origen, persona,
instante, referencia a lo que lo originó. La causa **no** se infiere de un texto (en
la referencia un motivo escrito distinto se leyó como fuga de $1.126.398). Toda
escritura pasa por **una sola función**.

### 5.2 Stock negativo

Se **permite** vender aunque el sistema diga que no hay. El negativo es deuda de
registro, no bloqueo. **Negativo no es agotado**: alertas distintas (un helado estuvo
tres meses en −400 g en la referencia porque tres recetas descontaban un insumo que
nunca se compró). Reporte propio de insumos con consumo por receta y **cero compras**
en 60 días.

### 5.3 Consumo teórico

Al enviar un ítem se registra el consumo según su ficha (con modificadores y
rendimientos aplicados), con la versión de receta congelada. Vender, regalar y comer
(`staff_meal`) dejan el inventario idéntico. Consumos del mismo insumo en una comanda
se fusionan; la reversión (nota «vuelve») es espejo exacto.

### 5.4 Conteos y varianza

- **Conteo de críticos** (`key_items`): 5 a 15 insumos que son el 60–70 % de las
  compras (proteínas, licor, preparaciones caras), por turno o diario, unos diez
  minutos. Por ítem: inicial + entradas − final = uso real, contra uso teórico =
  ventas × receta + producciones → varianza en cantidad y pesos por turno.
- **Conteo completo** (`full`): semanal en un restaurante chico, mensual como mínimo.
  **Food cost real** sólo se calcula entre dos conteos completos consecutivos; si no
  los hay, es `null`, no 0.
- **A ciegas**: quien cuenta no ve el stock del sistema; la referencia en pantalla es
  el último conteo. **No existe «todo coincide»** (borró faltantes reales de
  −10.065 g). `was_counted` por renglón, escrito sólo por quien cuenta.
- El conteo **no pisa el stock**; aplicarlo es acción explícita del administrador,
  una sola vez, con `stock = contado + (entradas − salidas desde el instante del
  conteo)` (la referencia aplicó a las 15:42 un conteo de las 13:07 y «mandó a
  buscar un robo que no existe»).
- Entrada numérica: texto con teclado decimal, coma y sumas («6+8») con parser
  propio; lo inválido en rojo y no se envía; el servidor valida cada renglón; un
  borrador local nunca pisa un valor confirmado; un guardado parcial lo dice.
- **Umbrales de varianza** (calibrables con 6–12 meses de datos propios; defaults de
  la industria): food cost real − teórico < 2 puntos verde, 2–4 revisar, > 4–5
  sostenido rojo. Varianza «por plato» sólo como estimación prorrateada, en fase 3.
- **Salud del control**: días desde el último conteo completo (> 14 → «inventario no
  confiable», sin food cost real), % de recepciones con factura, % de preparaciones
  por lote con producción en la semana, mermas registradas en la semana. Que el
  sistema diga cuándo sus números ya no valen.

### 5.5 Mermas

Tipos: `expired`, `overproduction`, `kitchen_error`, `breakage`, `customer_return`,
`tasting`, `courtesy_no_dish` (una botella regalada, sin plato), `unidentified`.
**No existe «consumo de personal» como merma**: es una comanda `staff_meal` (§3.3).
Responsable (PIN), insumo o preparación, cantidad, costo con origen, lote, foto
opcional. KPI semanal: mermas ÷ compras (referencia 4–10 %); alerta si la merma de
un insumo supera 1,5 × la semana anterior. Un lote vencido lo da de baja alguien
como `expired`; el sistema sólo alerta «por vencer» y «vencido con stock».

### 5.6 Compras

- **Proveedores** como entidad (nombre canónico, NIT, plazo, contacto, obligado a
  facturar sí/no). No texto libre (41 grafías para 23 proveedores en la referencia).
- **Recepción** con **PIN de quien recibe**: foto de la factura, número, fecha, ítems
  con cantidad recibida y facturada (confiabilidad del proveedor = recibido ÷
  facturado), precio unitario, base/tarifa/valor de IVA, lote, vencimiento. Guardas
  de tecleo (precio de empaque como unitario; «¿eran empaques?»).
- Al confirmar: entrada de inventario, lote con vencimiento y costo, costos
  actualizados, y una **cuenta por pagar en estado `pending_review`** hasta que el
  administrador la aprueba: es el control mínimo entre quien recibe y quien paga.
- **Pagos** contra la cuenta por pagar: fecha real de salida, medio, comprobante. El
  saldo **se deriva** de los pagos vivos. Un pago en efectivo desde el cajón crea el
  egreso en el turno abierto en la misma transacción.
- Compra **sin factura** (plaza de mercado): recepción marcada `no_invoice`; el
  documento soporte electrónico (Res. DIAN 167/2021) en fase 3.
- Editar o eliminar una recepción **revierte todo** aguas abajo de forma atómica o
  falla explicando por qué.
- Orden de compra y sugerencia de reposición: fase 3.

### 5.7 Lotes y vencimientos

Toda entrada crea un lote con vencimiento y costo; toda salida consume el más
antiguo. Estados: activo, por vencer (≤ 7 días), vencido, agotado.

---

## 6. Dinero

### 6.1 Tres bolsas que nunca se mezclan

1. **El cajón** de cada sede: ventas por medio según el POS, lo contado (turnos),
   movimientos y retiros.
2. **El banco**: consignaciones con comprobante, liquidaciones del datáfono (con
   rezago, comisión y retenciones), transferencias.
3. **La mano del dueño**: lo que retiró y todavía no consignó ni gastó.

Fases 1 y 2: el cajón completo y los retiros. Desde el día uno cada turno cerrado
sabe cuánto **debe consignarse** = contado − base fija − propinas en efectivo
retiradas, y cada retiro sabe a qué turno pertenece. Consignaciones, libro del banco y
mano del dueño: fase 3, con esos datos ya capturados.

Principios para todo número de plata:

- **Una sola matemática, en el backend.** El frontend nunca deriva saldos,
  esperados ni diferencias («$400.000 en la pantalla y $222.300 en la cuenta» sobre el
  mismo día, en la referencia).
- **Derivar en vez de almacenar**: estado de cuenta por pagar, por consignar,
  esperado. La única columna almacenada de ese tipo en la referencia fue la que se
  desincronizó.
- **`null` no es 0.** «Nadie contó» y «se contó y no falta nada» se distinguen en la
  API, en los tipos y en pantalla.
- **El error tolerable es el que muestra menos plata.** Todo sesgo se declara.
- **Nada financiero ni de inventario se borra**: baja lógica y auditoría con antes y
  después. Si la auditoría no puede escribirse, se registra la falla; nunca se traga.
- **Las llaves anti doble conteo se diseñan antes que las pantallas**: retiro vs
  consignación, pago vs movimiento de banco, egreso vs recepción, propina vs venta.

### 6.2 Propinas

- Fondo aparte por turno: recaudado por medio (efectivo / datáfono / transferencia),
  por persona que atendió, y por comanda.
- **100 % para los trabajadores** de la cadena de servicio (meseros, cocina,
  auxiliares), entregada como máximo en un mes; el empleador no la reparte a su
  criterio ni la usa para gastos, faltantes o reposiciones (Ley 1935 de 2018;
  verificar texto literal con Legal). No es salario ni factor salarial.
- Las propinas en efectivo salen del cajón al cierre. Las **electrónicas** quedan
  como **pasivo con el personal**; si el dueño las paga del cajón, es un egreso
  `tip_payout` que resta del esperado. El **registro del reparto** (quién, cuánto,
  cuándo) existe desde la fase 1b; el cálculo automático del reparto (partes
  iguales, por horas, por área) en fase 3.
- Propina en la precuenta y en el documento como línea aparte: «Propina voluntaria
  (sugerida X %)». Aviso en carta y menú de que es voluntaria y se destina al personal
  (Circular SIC; verificar número).

### 6.3 Devoluciones pendientes

Una nota emitida sin turno abierto deja una devolución pendiente: monto, cliente,
documento, quién la autorizó. Se salda desde un turno (egreso `refund`, entra al
esperado de ese turno) o desde la mano del dueño. Aparece en «Requiere tu atención».

### 6.4 Gastos, obligaciones y utilidad

Arriendo, servicios, nómina, impuestos agendados, punto de equilibrio: **fase 3**. El
MVP calcula **margen bruto** (ventas netas − costo teórico de lo vendido) y lo dice así.

---

## 7. Turnos y personal

- **Empleados**: nombre, rol, PIN (hash), activo, sede, documento (dato personal, sólo
  admin).
- Roster del turno: quién entró y salió, con hora de servidor, marcado con PIN;
  pausas (inicio y fin). Quien sale se marca explícitamente. Sirve para
  responsabilidad, reparto de propinas y nómina futura.
- **Cierre de mesero** (fase 1b): reporte de sus comandas, ventas por medio,
  propinas, anulaciones y descuentos, sin contar plata.
- Horas, recargos y nómina: **fase 3**. Lo que se captura desde el MVP es lo que esa
  fase necesita: entradas, salidas y pausas por persona con fecha de negocio, turnos
  que cruzan medianoche partidos en dos días. Las tablas de recargos con vigencia
  (nocturno 19:00–06:00 desde dic-2025; dominical 80/90/100 % en 2025/2026/2027; Ley
  2466 de 2025) y la jornada de 42 h desde jul-2026 (Ley 2101 de 2021) se
  parametrizan en fase 3, nunca se queman en código.

---

## 8. Impuestos, facturación y datos personales (Colombia)

### 8.1 Configuración fiscal de la sede, con vigencia

NIT y dígito de verificación, razón social, dirección, municipio (código DANE),
persona natural o jurídica, régimen (`ordinario` | `simple`), franquicia sí/no,
responsable de INC, responsable de IVA, códigos de responsabilidad del RUT,
`price_includes_tax`, y **tabla de UVT por año** (2026: $52.374; verificar). Cada
cambio tiene `valid_from`, porque la condición se define por año gravable.

### 8.2 Impuesto sobre la venta

- **INC 8 %** sobre todo el consumo del restaurante no franquiciado; **IVA 19 %** si es
  franquicia (art. 426 ET). Régimen SIMPLE: el 8 % se integra a la tarifa SIMPLE, con
  anticipos bimestrales; el tiquete lo muestra igual.
- Venta neta = total ÷ (1 + tasa). Los márgenes se calculan sobre la neta; «ventas»
  sigue siendo lo cobrado, que es lo que cuadra contra caja.
- **Propina fuera de la base** (art. 512-9 ET). Cortesía y consumo de personal, sin
  precio, no generan base bajo INC (interpretación propia; verificar con el
  contador. Bajo IVA puede ser retiro de inventarios gravado, art. 421 ET).
- Reporte **bimestral** por tarifa: base, impuesto, cantidad de documentos, notas,
  propinas (informativo). Alimenta el formulario 310 (ordinario) o el anticipo 2593 y
  la declaración anual 260 (SIMPLE). El sistema no genera formularios.

### 8.3 Documento fiscal (fase 1b)

Desde 2024 todo obligado a facturar que use POS debe emitir **documento equivalente
electrónico POS** validado por la DIAN antes de entregarlo (Res. 000165/2023, mod.
000008/2024 y 000119/2024, compilada en Res. 000227/2025); el tiquete de papel sin
transmisión no es válido y la sanción es cierre del establecimiento (art. 657 ET).
Por eso el modelo del documento fiscal entra en la **fase 1b**, y la conexión con un
**proveedor tecnológico** (Siigo, Alegra, Dataico u otro; la firma, el CUDE y la
transmisión las hace él) se hace apenas el dueño elija uno. Hasta entonces el sistema
emite en modo **«pendiente de transmisión»** con leyenda visible, y el establecimiento
sigue cumpliendo como lo hace hoy: es un riesgo legal del dueño, no algo que el
software pueda resolver solo.

> **Nota 2026-09-23.** El proveedor tecnológico no es la única vía: la
> Resolución Única 000227/2025 (art. 1.5.1.5.1.1) admite «desarrollo propio»
> también para el documento equivalente POS. La alternativa, con fases y
> riesgos, está en `docs/PLAN-DIAN.md`; queda a decisión del dueño.

El modelo, desde el día uno:

- **Tipos de documento**: documento equivalente POS, factura electrónica de venta,
  nota de ajuste (corrige un documento equivalente), nota crédito y nota débito
  (corrigen una factura).
- **Rangos de numeración** autorizados por la DIAN, por tipo y por sede: prefijo,
  desde, hasta, número y fecha de resolución, vigencia, clave técnica. Consecutivo
  estrictamente creciente, **sin huecos ni reutilización**, asignado en la misma
  transacción de la emisión. Alertas al 80 % del rango y 30 días antes del
  vencimiento. Un documento rechazado no libera su consecutivo: se corrige y reenvía
  o se anula por nota.
- **Estado ante la DIAN**: `pending`, `sent`, `validated`, `rejected`, `contingency`.
  Un documento se entiende expedido cuando la DIAN lo valida y se entrega al
  cliente. Si el proveedor o la DIAN no responden, el documento queda en
  **contingencia** con su fecha de generación, el POS sigue vendiendo e imprimiendo
  con leyenda de contingencia, y un proceso reintenta la transmisión; el plazo legal
  es de **48 horas** (art. 616-1 ET); los vencidos aparecen en «Requiere tu atención».
- **Evidencia persistida** por documento: CUDE (o CUFE), XML firmado o referencia
  inmutable más hash, QR con URL de consulta, respuesta de la DIAN, proveedor y
  software, fechas de generación, expedición y validación. Inmutable después de
  validado. **Conservación mínima 5 años** y exportación periódica: no depender sólo
  del proveedor.
- **Representación gráfica** (lo que se imprime): denominación legal, NIT y razón
  social, prefijo y consecutivo con rango y vigencia, fechas, adquirente, por línea
  cantidad, unidad, descripción y código, impuesto discriminado por tarifa, total,
  forma y medio de pago con código DIAN, CUDE y QR, propina en línea separada, mesa,
  canal, comensales, quién atendió y quién cobró.
- **Adquirente**: por defecto «consumidor final» (tipo 13, número 222222222222, sin
  responsabilidades). Cuando el cliente pide factura o el neto supera el
  **umbral** (`invoice_threshold_uvt`, default 5 UVT ≈ $261.870 en 2026; hay dos
  lecturas legales del tope y el diseño cubre ambas, verificar con el contador): el
  POS ofrece factura electrónica y captura tipo y número de documento (con dígito de
  verificación si es NIT), nombre o razón social, correo para la entrega, dirección
  y municipio. Los clientes se reutilizan por número de documento. Nunca se obligan
  datos si la venta va como consumidor final.
- Toda corrección va **por nota**, nunca editando ni borrando un documento expedido.
  Una venta descartada antes de emitir queda en auditoría.
- Impuesto a **bolsas plásticas** ($73 por bolsa en 2026; sólo responsables de IVA):
  opcional, campo de bolsas en domicilio y para llevar.

### 8.4 Datos personales (Ley 1581 de 2012, Decreto 1377 de 2013)

- **Autorización previa, expresa e informada** con finalidad al crear un cliente,
  conservando la prueba (fecha, canal, texto, quién la registró). Los datos mínimos
  para facturar se amparan en la obligación legal; **cualquier uso adicional**
  (marketing, WhatsApp) requiere autorización separada (`marketing_consent`, con
  fecha y canal). La política de tratamiento es un documento del dueño, enlazado.
- **Derechos del titular**: consultar, rectificar, revocar autorización, suprimir.
  Suprimir **anonimiza el maestro** y conserva intacto el snapshot dentro de los
  documentos fiscales ya emitidos (no se puede borrar evidencia fiscal). Registro de
  solicitudes con fecha y respuesta.
- **Minimización**: nada de datos en ventas a consumidor final; el operador no exporta
  el maestro de clientes; datos de empleados (documento, PIN, turnos, propinas) bajo
  el mismo régimen; registro de accesos y exportaciones.
- Registro Nacional de Bases de Datos: no aplica salvo activos > 100.000 UVT.

Lo que el sistema **no hace**: declaraciones, retenciones (las que le practican los
adquirentes de tarjeta y los clientes jurídicos quedan como espacio en el modelo de
conciliación de fase 3), contabilidad de partida doble, ICA (sólo reporta ventas
netas por municipio). Exporta lo que el contador necesita, agrupado por **día
operativo**: ventas por tarifa (base, impuesto), por medio, notas, propinas; compras
con IVA (fase 2).

---

## 9. Las pantallas

### 9.1 POS (salón)

| Vista | Qué muestra | Acciones |
|---|---|---|
| Activar dispositivo | una vez por tablet: sede + PIN de sede | activar; desactivar desde el cierre |
| Quién opera | avatares del personal; teclado de PIN | identificarse (queda en el roster); cambiar de persona en un toque |
| Barra de estado | día y turno, quién opera, mesas abiertas, avisos (sin turno, turno abandonado, agotados, documentos en contingencia) | abrir turno; todo 4xx operativo **nombra la acción correctiva** («Abrir turno →») |
| Mesas | mapa por zona: libre / ocupada (tiempo, total, comensales) / por cobrar; cola de para llevar (y domicilios y plataformas cuando existan) | abrir mesa con comensales, unir, mover |
| Comanda | carta por categorías, búsqueda, **favoritos** (lo más vendido en 7 días), pestaña **menú del día** primero en su franja; agotados y contador visibles; ítems con estado y curso por color; modificadores y notas; asiento opcional | agregar, cantidad, modificar, **enviar** (ronda), anular, cortesía, **presentar cuenta** |
| Cuenta y cobro | precuenta con subtotal, descuentos, impuesto, **pregunta de propina**, total; pagos mixtos; división; cambio con atajos de billetes | cobrar, imprimir o compartir el documento, reimprimir (contado) |
| Turno | base fija, ventas por medio, ingresos, egresos, retiros; relevo; cierre a ciegas | abrir, relevo, retiro (PIN admin), gasto menor, cambio, cerrar |
| Herramientas | paneles laterales **sin abandonar el POS**: merma rápida, agotado, producir una preparación, mis ventas del turno | registrar |

Requisitos no funcionales: la interfaz se arma a partir de las funciones habilitadas
(sin `pos.tables` el POS abre directo en la comanda de mostrador; sin `kitchen.view`
no existe «enviar», la comanda se cobra y listo); cada acción frecuente en **tres
toques o menos** con default inteligente; botones ≥ 44 px; tablet de 10" y PC; estado de mesas, turno y agotados
refrescado por sondeo corto (3–8 s); un cobro que falla conserva la cuenta;
WCAG 2.1 AA; todo error del servidor como texto legible (un `detail` que era una
lista dejó la referencia en pantalla blanca).

### 9.2 Cocina (fase 1b, mínima)

Rondas enviadas, por estación, en orden de llegada, con mesa o canal, ítems con
modificadores resaltados, curso, y tiempo transcurrido con semáforo por curso
(defaults configurables: entrada 5–10 min, fuerte 15–20). Marcar «listo» por ítem
(idempotente). KDS completo con «bump», expedición, «marchar» e impresión por
estación: fase 2.

### 9.3 Admin (PC)

Tres bandas: **pulso de hoy**, **requiere tu atención** (tarjetas accionables),
**análisis** por período.

| Sección | Qué responde |
|---|---|
| **Hoy** | ¿Cómo va el día? ventas por hora, ticket por comanda y por comensal, comensales, mesas ocupadas, comandas abiertas con tiempo (> X min sin enviar o sin cobrar), efectivo esperado, propinas por medio; alertas: sin turno o abandonado, diferencias, anulaciones y descuentos inusuales, agotados, documentos en contingencia o rechazados, rango de numeración por agotarse, cierres sin revisar, devoluciones pendientes |
| **Ventas** | ¿Qué vendí y cómo me pagaron? documentos con detalle, por día operativo / turno / medio / canal / persona / hora / zona; notas; **informe para el contador** por día y tarifa, bimestral; exportar |
| **Pedidos** | ¿Qué comandas están en curso y cuáles se anularon? estados, tiempos de mesa, cocina y cobro (p50 y p90), anulaciones con `after_bill`, minutos y medio de pago, cortesías, descuentos, `staff_meal`, trasladadas |
| **Carta y recetas** (fase 2) | ¿Qué me cuesta cada plato? fichas, costo con origen, food cost %, modificadores, combos y menú del día, disponibilidad, cobertura de recetas, ingeniería de menú |
| **Preparaciones** (fase 2) | ¿Qué se produjo y qué hay? modos, lotes, rendimiento esperado vs real, stock y vencimientos |
| **Inventario** (fase 2) | ¿Qué tengo y qué se me pierde? stock con umbrales, movimientos por causa, conteos y varianzas valorizadas, mermas, negativos con causa probable, **salud del control** |
| **Compras** (fase 2) | ¿A quién le debo? proveedores y confiabilidad, recepciones, cuentas por pagar (pendientes de revisión, vencidas), pagos |
| **Dinero** | ¿Cuadra la caja? turnos con base, esperado, contado, diferencia y causa (modo operacional e historial), movimientos, retiros con sobre, por consignar, propinas y su reparto, devoluciones pendientes, cierres revisados; rescates |
| **Turnos y personal** | ¿Quién estuvo y qué hizo? tablero por persona: ventas, ticket, comandas, anulaciones (n, $, %, `after_bill`, sobre efectivo), descuentos, cortesías a costo, walkouts, reimpresiones, % ítems enviados al cobrar, diferencias y racha, propinas; comparado contra el promedio del equipo; **autorizaciones por autorizador** |
| **Historial** | ¿Quién cambió qué? auditoría con antes y después |
| **Notificaciones** | reglas por sede: tipo, umbral, canal (campana; push en fase 2), nivel; dedupe diario |
| **Funciones** | ¿Qué usa este restaurante? perfil elegido, cada función con su estado, dependencias y desde cuándo; cambios auditados |
| **Configuración** | organización y sedes, sede y fiscal (§8.1), hora de corte, horario, base fija, tolerancias, umbrales de retiro y gastos menores, propina sugerida, límites de descuento, motivos, medios de pago con código DIAN, rangos de numeración y datos del documento, canales activos, estaciones, cursos y tiempos objetivo, plataformas y comisiones, insumos críticos, usuarios y PINs, PIN de sede |

Requisitos: cada número responde una pregunta concreta; «sin datos» se dice, no se
dibuja como cero; toda tabla de saldos muestra los términos que hacen cerrar la
identidad y viaja con `cuadra` calculado en el backend; toda lista exporta; claro y
oscuro.

---

## 10. Reportes y KPIs (definiciones)

| KPI | Fórmula | Granularidad |
|---|---|---|
| Ventas cobradas | Σ documentos no anulados ni reversados | día operativo, turno, hora, canal, persona, zona |
| Ventas netas | ventas cobradas − impuesto; sin propina | ídem |
| Ticket promedio | ventas netas ÷ comandas pagadas; y ÷ comensales | día, persona |
| Comensales, rotación | comensales ÷ sillas por servicio (referencia 1,5–2,5); RevPASH = ventas netas ÷ (sillas × horas abiertas) | servicio, día |
| Mix de platos | unidades y ventas por plato; combos y menú del día aparte, componentes en consumo | día, semana, mes |
| Margen bruto teórico | ventas netas − Σ costo teórico congelado, con % de venta costeada | día, plato |
| Food cost teórico % | costo ÷ ventas netas | plato, día |
| Food cost real % | (inventario inicial + compras − final) ÷ ventas netas | entre dos conteos completos; `null` si no |
| Varianza de inventario | uso real − uso teórico, cantidad y pesos con origen del costo | insumo, conteo |
| Diferencia de caja | contado − esperado, con causa | turno; racha por persona |
| Anulaciones, cortesías, descuentos | n, $, % de ventas de la persona, `after_bill`, minutos, medio de pago, autorizador | día, semana |
| Tiempo de mesa / cocina / cobro | cerrada − abierta; listo − enviado; pagada − cuenta presentada | p50 y p90 por día y estación |
| Mermas | costo por tipo y persona; mermas ÷ compras | semana, mes |
| Propinas | recaudado por medio, persona y turno; entregado | turno, semana, mes |
| Agotados del día | producto, hora, quién; ventas perdidas estimadas | día |
| Salud del control | días desde último conteo completo; % recepciones con factura; % preparaciones con producción | semana |

Toda serie diaria agrupa por **día operativo**.

---

## 11. Reglas duras (no se negocian)

1. **No se vende sin turno abierto**; no se cierra con comandas abiertas sin traslado
   explícito. Lo hace cumplir el backend.
2. **Precio, impuesto, costo, receta, modificadores, curso y estación se congelan en
   el ítem.** El precio lo fija el servidor; no hay precio abierto.
3. **Nada financiero ni de inventario se borra ni se edita en silencio**: baja lógica,
   reversas con motivo, auditoría con antes y después.
4. **Anular lo enviado, lo cobrado o lo presentado exige motivo tipado y PIN**, y
   aparece en un reporte por persona y por autorizador.
5. **La propina es separada**: no es venta, no causa impuesto, es del personal.
6. **El insumo se descuenta una sola vez** y por **un solo camino** de consumo (venta,
   cortesía, consumo de personal, producción).
7. **Umbrales de stock nunca en cero** por defecto.
8. **Fecha de negocio como `Date`** en hora Bogotá, sellada en todo documento;
   instantes en UTC con marca de zona.
9. **Idempotencia** en toda escritura que mueve plata o estado; **`409`** ante
   concurrencia; constraints en la base (un turno abierto por sede, una comanda
   abierta por mesa, consecutivo único por tipo y sede).
10. **El operador no ve costos ni márgenes**; el backend no se los manda.
11. **Sesión en cookie `httpOnly`**; frontend y API bajo el mismo origen.
12. **Consecutivo sin huecos** por tipo de documento y sede; correcciones sólo por nota.
13. **Una sola matemática en el backend**; el frontend no deriva plata; `null` no es 0;
    el error tolerable muestra menos plata.
14. **Causa tipada** en movimientos de caja e inventario, en justificaciones de
    diferencia, en anulaciones, descuentos, cortesías y mermas.
15. **La reserva no entra al cuadre; el cambio no es egreso; el conteo se hace a ciegas
    y no pisa el stock; aplicar un conteo suma el neto posterior.**
16. **El sistema nunca calcula deuda de un empleado ni descuentos de nómina.**
17. **No existe transferencia de ítems entre comandas.**
18. **Todo 4xx operativo nombra la acción correctiva; un 200 que no guardó todo lo dice.**
19. **Toda función opcional vive detrás de su flag, que hace cumplir el backend**;
    lo que es ley o integridad no es un flag; toda consulta se acota por
    organización y sede.

---

## 12. Lo que la referencia enseñó (convertido en convenciones)

- **Migraciones reales (Alembic) desde el primer commit.** Una columna sin migración
  fue el bug más caro del go-live. DDL escrito para Postgres; backfill obligatorio
  para columnas nuevas que participen en filtros; seeds idempotentes y **fuera** del
  arranque de producción; requirements mínimos desde un lock.
- **Trampas SQLite↔Postgres**: enums (comparar por valor), orden de `NULL` en
  `ORDER BY DESC`, funciones de fecha (agrupar en Python o SQL portable), `MIN` sobre
  `Date` devuelve texto en SQLite, tope de variables en `IN (...)`; `busy_timeout`.
- **Errores**: una sola forma `{ error: { code, message } }`; reglas de negocio en `400`
  con código y texto para humanos; validación de esquema normalizada a la misma
  forma; `409` para concurrencia. Ningún `catch` vacío; un estado de carga y de error
  por recurso.
- **Despliegue desfasado**: todo campo nuevo de respuesta es opcional en el cliente;
  «ausente» se dibuja distinto de «vacío» o «0».
- **Índices para cada consulta que corre en cada venta o carga de pantalla**;
  filtrar por rango precalculado, nunca con `date()` sobre la columna.
- **Tests como enunciados de regla** más invariantes y zona horaria; **CI que corre la
  suite y bloquea el deploy en rojo**; si el dueño tiene una hoja de Excel de un mes
  real, se vuelve fixture al centavo.
- **Un solo documento de estado con fecha** (`docs/ESTADO.md`).
- **Hosting sin arranque en frío** para el POS.
- **Todo maestro editable desde la app**.
- **Módulos por dominio** desde el inicio (la referencia llegó a un servicio de 5.362
  líneas).

---

## 13. Fuera del alcance del MVP

- KDS completo, «marchar», impresión por estación (fase 2).
- Domicilio propio y plataformas (fase 2); integración por API con plataformas
  (fase 3).
- Impresora térmica y cajón monedero.
- Consignaciones, banco, mano del dueño, conciliación de datáfono y plataformas,
  obligaciones, gastos, punto de equilibrio, nómina, reparto automático de propinas,
  cobro por mesero con fondo propio (fase 3).
- Órdenes de compra, reposición sugerida, documento soporte electrónico, traslados
  entre sedes (fase 3).
- Reservas, fidelización, marketing; varias comandas por mesa (fase 2).
- Modo sin conexión completo.

---

## 14. Fases de construcción

Cada pedido va al orquestador (`args.pedido`) con su `features/<fase>/spec.md`. El
Maestro arma el equipo de cada uno. La fase 1 se parte en **dos pedidos** para que
cada uno quepa en un equipo de 2 a 6 agentes y tres rondas de conciliación.

| Pedido | Qué construye | Qué queda funcionando |
|---|---|---|
| **1a. Cimientos y caja** | repositorio con backend, frontend, CI y Alembic; **organización, catálogo de funciones, perfiles y override por sede, con el flag exigido en el backend**; las tres identidades y roles; configuración de sede y fiscal con vigencia; zonas, mesas, empleados; catálogo plano con modificadores, combos y menú del día, agotados; día operativo y turno de caja completos (base fija, reserva, responsable, roster, movimientos, cambio, retiros, relevo, arqueo sorpresa, cierre a ciegas, tolerancias, rescates, `closes_day`); notificaciones por campana; admin: Configuración, Turnos y personal, Dinero, Historial; POS: activar, identificarse, turno | se abre y se cierra caja con control; la carta está cargada |
| **1b. Comanda y venta** | mesas y comandas (mostrador, mesa, para llevar, `staff_meal`), cada capacidad detrás de su función; rondas y vista de cocina mínima, precuenta y propina, cobro con pagos mixtos y división, descuentos y cortesías con motivos, **documento fiscal** con rangos, estados, contingencia, adquirente y adaptador de proveedor (modo pendiente de transmisión), notas, devoluciones pendientes; admin: Hoy, Ventas e informe del contador, Pedidos; POS completo | se opera el restaurante de punta a punta |
| **2. Carta, recetas e inventario** | insumos con rendimiento e IVA de compras, preparaciones en dos modos, fichas técnicas, consumo teórico al enviar, mermas, conteos de críticos y completos, salud del control, compras con proveedores y cuentas por pagar, lotes; `recipe_effect` en modificadores; domicilio propio y plataformas; KDS; conexión real con el proveedor tecnológico si no se hizo en 1b | se sabe qué cuesta cada plato y qué se pierde; se factura electrónicamente |
| **3. Dinero y control** | consignaciones, banco y mano, conciliación de datáfono y plataformas, obligaciones y gastos, punto de equilibrio, propinas repartidas, nómina con recargos, reposición sugerida, ingeniería de menú, varianza por plato, cobro por mesero | se cierra el mes con números |

El pedido **1a** es el que se lanza al aprobar esta spec; su spec está en
`features/fase-1a-cimientos/spec.md` y la de 1b en `features/fase-1b-venta/spec.md`.

---

## 15. Preguntas para el dueño

**[MODELO]** = cambia entidades o flujos y conviene responderla antes de construir.
**[CONFIG]** = parámetro de sede; se construye con el default y se ajusta después.

| # | Pregunta | Default asumido |
|---|---|---|
| 1 | [MODELO] ¿Está obligado a facturar? ¿Emite hoy documento electrónico con algún proveedor (Siigo, Alegra, Dataico, solución gratuita DIAN)? ¿Tiene rangos de numeración autorizados? | Obligado; sin proveedor todavía; el modelo entra en 1b y la conexión apenas elija proveedor |
| 2 | [MODELO] ¿Persona natural o jurídica? ¿Régimen ordinario o SIMPLE? ¿Responsable de IVA? ¿Franquicia? | Natural, ordinario, INC 8 %, no IVA, no franquicia |
| 3 | [MODELO] ¿Base de caja fija (siempre $X) o lo que quedó del cierre anterior? | Fija por sede |
| 4 | [MODELO] ¿Cuántos turnos de caja por día (almuerzo, cena)? ¿Hasta qué hora atienden? | N turnos, `closes_day` en el último; hora de corte 06:00 |
| 5 | [MODELO] ¿Quién cobra: cajero fijo o cada mesero en mesa con su fondo? | Caja única por turno con responsable; cobro por mesero en fase 3 |
| 6 | [MODELO] ¿Hay encargado de turno que autoriza cuando el dueño no está? ¿El PIN de administrador es uno solo? | Rol supervisor con PIN propio; PIN de administrador por persona |
| 7 | [MODELO] ¿Se presenta cuenta impresa antes de cobrar? | Sí; precuenta no fiscal con leyenda |
| 8 | [MODELO] ¿Cómo se entera cocina hoy: impresora, pantalla o el mesero canta el pedido? ¿Cuántas estaciones? | Vista de cocina mínima en 1b; estaciones caliente, fría, bar |
| 9 | [MODELO] ¿Servicio por tiempos (entrada, fuerte, postre) o en un solo tiempo? | Campo curso desde 1b; «marchar» en fase 2 |
| 10 | [MODELO] ¿Hay menú del día? ¿Estructura y franja? ¿Cambian las opciones a diario? | Sí: sopa + principio + proteína + jugo, 11:30–15:00, opciones por día |
| 11 | [MODELO] ¿Mesas grandes con grupos separados? ¿Se captura asiento al tomar el pedido? | Una comanda por mesa; asiento opcional |
| 12 | [MODELO] ¿Comida de empleados: gratis, con descuento, tope? ¿Pactada como salario en especie? | Comanda `staff_meal` a $0, reporte mensual por empleado a costo |
| 13 | [MODELO] ¿Hoy se descuentan faltantes de caja a los cajeros? | El sistema no lo calcula (CST art. 149) |
| 14 | [MODELO] ¿Domicilio propio? ¿Plataformas (Rappi, Didi, iFood) y comisión pactada? ¿Precio en app distinto? | Sin domicilio ni plataformas en el MVP; canales apagados |
| 15 | [MODELO] ¿La propina se pregunta en el POS o en el datáfono? ¿Cómo se reparte y con qué frecuencia? | En el POS al presentar la cuenta; reparto manual registrado; automático en fase 3 |
| 16 | [MODELO] ¿Qué preparaciones existen y cuáles vale la pena rastrear por lote? ¿Hay fichas técnicas con gramaje? ¿Se pesa en cocina? | Explotadas por defecto; lote para caldos, proteínas, arroz del día; costo «estimado» hasta que haya fichas |
| 17 | [MODELO] ¿Quién recibe mercancía y quién paga? ¿Compra en plaza sin factura? | PIN de quien recibe; cuenta por pagar aprobada por admin; recepción sin factura permitida |
| 18 | [CONFIG] Municipio de la sede; sillas por mesa; horario por día | Obligatorios en configuración |
| 19 | [CONFIG] Tolerancias de diferencia de caja; umbral de retiro; límite de gasto menor | $20.000 / $100.000; $500.000; $50.000 |
| 20 | [CONFIG] ¿Foto obligatoria en cierre y retiro? ¿Hay sobres o caja fuerte para retiros? | Sí; sobre opcional |
| 21 | [CONFIG] Medios de pago reales (marca del datáfono, Nequi, Daviplata, Bre-B) | Efectivo, datáfono, transferencia/QR |
| 22 | [CONFIG] Límite de descuento sin autorización; acumulado por persona y turno | 10 % por comanda; 5 % de sus ventas como alerta |
| 23 | [CONFIG] Motivos de anulación, descuento y cortesía que quiere ver; umbral de alerta | Los enums de §3.3 y §3.5; > 5 por día o > 3 % |
| 24 | [CONFIG] ¿Cuántos insumos críticos está dispuesto a contar por turno y quién? | 5–15, cocina al cierre; si nadie, sólo conteo completo semanal |
| 25 | [CONFIG] ¿Vende licor? | No |
| 26 | [CONFIG] ¿Quiere usar datos de clientes para marketing? | No |
| 27 | [CONFIG] ¿Tiene Excel de caja o ventas de un mes real? | Si existe, fixture de tests |
| 28 | [MODELO] ¿Cómo se va a vender: un despliegue por cliente, o un servicio con varias organizaciones? ¿Habrá planes comerciales atados a perfiles? | El modelo soporta ambos; la primera versión corre con una organización; los planes se mapean a perfiles después |

Lo que hay que **verificar con el contador o con Legal** antes de fijarlo en código:
texto literal de la Ley 1935 de 2018 y número de la Circular SIC sobre propinas y
prefacturas; la lectura vigente del tope de 5 UVT con documento equivalente
electrónico; UVT 2026; tratamiento de cortesías y consumo de personal bajo INC e
IVA; retenciones que practican los adquirentes de tarjeta; tarifa ICA del municipio;
Código Sustantivo del Trabajo art. 129 y 149.

---

## 16. Checklist de verificación de la spec

Lo que tiene que poder demostrarse con el código corriendo. Es el checklist que el
Maestro usa en la entrega.

**Pedido 1a**
- [ ] Una función deshabilitada responde `400 FEATURE_DISABLED` en su endpoint y no
      aparece en la interfaz; habilitarla requiere sus dependencias; el cambio queda
      en auditoría.
- [ ] Elegir un perfil deja exactamente los flags de la tabla §1.2.
- [ ] Un id de otra organización responde `404` en lectura y escritura.
- [ ] Dos aperturas de turno simultáneas en la misma sede: una `200`, otra `409`.
- [ ] Abrir con una base distinta de la fija sin causa tipada → `400` con la acción
      correctiva.
- [ ] La reserva declarada no cambia el esperado; un `cash_swap` no cambia el esperado;
      un retiro lo baja y guarda el snapshot.
- [ ] El cierre en tres pasos: el primer POST no devuelve el esperado; el segundo lo
      revela con la ecuación; con `difference_seen` desactualizada → `400
      DIFFERENCE_CHANGED`; con diferencia y sin causa → `400`; con diferencia sobre el
      umbral crítico cierra igual y notifica.
- [ ] Cierre sin foto cuando la sede la exige → `400` (validado en backend).
- [ ] Cinco PIN fallidos bloquean 15 minutos; la persona activa expira a los N minutos.
- [ ] Un supervisor puede autorizar un descuento sobre el límite y no puede autorizar un
      retiro.
- [ ] El menú del día con opciones activas por día y franja aparece sólo en su franja;
      una opción agotada no se puede elegir.
- [ ] `alembic upgrade head` desde cero crea el esquema; el seed corre aparte; CI corre
      typecheck, suite y build en serie.
- [ ] No hay `localStorage.setItem` de tokens ni de sesión.

**Pedido 1b**
- [ ] Sin turno abierto, crear una comanda → `400 NO_OPEN_SHIFT` con la acción
      correctiva.
- [ ] Dos tablets con la misma comanda: la versión vieja recibe `409`; agregar ítems
      con la misma clave de idempotencia no duplica líneas.
- [ ] Enviar manda sólo los pendientes como ronda numerada; un producto sin estación
      pasa a `entregado` sin pasar por cocina.
- [ ] Cobrar con ítems pendientes los envía con `sent_at_payment` y lo reporta.
- [ ] Presentar la cuenta marca `bill_presented_at`; anular después sin PIN → `400`;
      la anulación queda `after_bill`.
- [ ] Anular un ítem enviado sin PIN → `400`; con PIN genera merma, no repone.
- [ ] La propina se pregunta antes de emitir; base sin impuesto; sugerido > 10 % no se
      puede configurar; el documento y la precuenta la discriminan; no suma en ventas
      netas.
- [ ] Impuesto por línea con redondeo a peso y totales por tarifa; descuento de
      comanda prorrateado sin perder un peso.
- [ ] Dos cobros simultáneos: `200` y `409`; misma clave de idempotencia devuelve la
      misma respuesta sin segundo documento.
- [ ] División por ítems produce N documentos con consecutivos propios; partes iguales
      produce uno con N pagos.
- [ ] Consecutivo por tipo y sede sin huecos tras 100 ventas, 3 notas y 2 rechazos
      simulados del proveedor; un rechazo no libera el número.
- [ ] Un documento en contingencia se imprime con leyenda y aparece en «Requiere tu
      atención» al vencer 48 h.
- [ ] Un adquirente identificado se reutiliza por documento; suprimirlo anonimiza el
      maestro y deja intacto el snapshot del documento.
- [ ] Una nota sin turno abierto deja una devolución pendiente; pagarla desde un turno
      la convierte en egreso `refund` de ese turno y no toca el turno original.
- [ ] Un operador no recibe campos de costo en ninguna respuesta (test sobre OpenAPI).
- [ ] Una venta a las 00:30 cae en el día del turno; una a las 10:00 sobre un turno
      pasado de la hora de corte se sella con hoy.
- [ ] Typecheck, suite completa y build, una vez, en serie.
