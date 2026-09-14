# Restaurante Sistema — Spec de negocio

Versión 0.1 (borrador para aprobación). Fecha: 2026-09-14.

Este documento dice **qué** hace el sistema y **qué reglas no se negocian**. No dice
cómo se implementa: eso lo deciden los agentes del framework en cada fase, y queda
registrado en `docs/ESTADO.md`. Cuando una regla de acá cambie, cambia este documento
en el mismo PR.

Está escrito sobre dos fuentes: el proyecto de referencia `cafe-sistema` (una
cafetería real en producción, de donde salen los patrones del framework) y el dominio
propio de un restaurante de servicio a la mesa en Colombia. Lo que se toma de la
referencia se toma con su motivo; lo que es de cafetería y no de restaurante, se deja.

---

## 1. Qué es y para quién

Un sistema de **punto de venta y control interno** para un restaurante de servicio a
la mesa, con dos pantallas:

| Pantalla | Quién la usa | Dónde corre | Para qué |
|---|---|---|---|
| **POS** | quien toma el pedido y quien cobra (mesero / cajero) | tablet o PC compartida en el salón, modo kiosko | abrir mesas, tomar comandas, enviarlas a cocina, cobrar, abrir y cerrar turno de caja |
| **Admin** | dueño / administrador | PC | ver ventas, pedidos, inventario, recetas, preparaciones, turnos, dinero; configurar la carta y el sistema |

Una tercera vista, **Cocina** (lo que hay que preparar, en orden), sale casi gratis
del modelo de comanda y se deja para la fase 2 — el modelo la contempla desde el
día uno para no rediseñar después.

### Supuestos declarados

Los deja explícitos para que se puedan corregir antes de construir:

| Supuesto | Valor asumido | Por qué |
|---|---|---|
| País y moneda | Colombia, COP | mismo contexto que el proyecto de referencia |
| Régimen del impuesto al consumo | restaurante **no franquicia** → INC 8 % | es el caso general; una franquicia tributa IVA 19 % y se cambia por configuración |
| Precios de carta | **incluyen** el impuesto | es la práctica del sector: el cliente ve un precio final |
| Sedes | una, pero el modelo es multi-sede desde el inicio | la referencia terminó necesitándolo; agregarlo después cuesta mucho más |
| Stack | el default del framework: FastAPI + SQLAlchemy + Pydantic; React + TypeScript + shadcn/ui + Tailwind; SQLite en desarrollo, PostgreSQL en producción | no hay razón para apartarse |
| Idioma | UI en español; código, tests y specs técnicas en inglés | regla global del framework |
| Zona horaria de negocio | `America/Bogota`; la fecha operativa es la del negocio, nunca UTC | bug real de la referencia: un día que "cambiaba" a las 7 pm |

---

## 2. Actores y permisos

| Actor | Cómo entra | Qué puede hacer |
|---|---|---|
| **Operador** (mesero o cajero) | el dispositivo del salón se activa una vez con un PIN de sede; cada persona se identifica con su **PIN personal de 4 dígitos** al operar | abrir mesas, tomar y enviar comandas, cobrar, registrar mermas y gastos menores, abrir/cerrar turno de caja |
| **Administrador** | correo y contraseña, en PC | todo lo del operador más: carta, recetas, preparaciones, inventario, compras, dinero, reportes, usuarios, configuración |
| **Autorización puntual** | PIN de administrador tecleado en el POS | anular un ítem ya enviado a cocina, anular una venta cobrada, descuentos por encima del límite, retiros de efectivo |

Reglas:

- Toda acción en el POS queda **atribuida a la persona** que tecleó su PIN, aunque
  el dispositivo sea compartido. Se guarda el `id` y el **nombre como estaba en ese
  momento** (atribución sin FK dura, patrón del framework): si el empleado se va o se
  renombra, la historia no cambia.
- El operador **no ve costos ni márgenes** en ninguna pantalla. Costo de insumos,
  food cost y utilidad son sólo del administrador.
- Menor privilegio: lo que un rol no necesita, el backend no lo devuelve — no alcanza
  con ocultarlo en la interfaz.
- Un rol de **contador** (sólo lectura de reportes y exportes) queda previsto para la
  fase 2.

---

## 3. El eje operativo: día → turno de caja → comanda

Todo cuelga de tres entidades con estados explícitos. Es el patrón *spine* del
framework, y es lo que después permite auditar "qué pasó ese día".

### 3.1 Día operativo

- Uno por sede por **fecha de negocio** (hora Bogotá). Se abre con la primera
  apertura de turno del día y se cierra cuando cierra el último turno.
- Estados: `abierto → cerrado`. No se reabre: si hubo un error, se corrige con un
  movimiento fechado en el día siguiente, con nota.

### 3.2 Turno de caja

Es la **unidad de responsabilidad sobre el dinero**. Lo abre una persona con PIN,
declara quiénes están en el turno (responsabilidad colectiva: todos los que
operaron responden por la caja), y cuenta la base.

- Estados: `abierto → cerrado`.
- **Apertura**: base contada por denominaciones; el sistema propone la base que
  dejó el turno anterior; si difiere, la justificación es obligatoria.
- **Durante**: ventas, ingresos y egresos de caja con motivo, **retiros de efectivo**
  (cuando se acumula mucho, el administrador lo retira: monto, quién, PIN admin,
  queda como movimiento), gastos menores con comprobante (foto).
- **Cierre**: conteo físico por denominaciones → el sistema calcula el efectivo
  esperado (base + ventas en efectivo + ingresos − egresos − retiros) → diferencia
  → justificación obligatoria si es distinta de cero. También se declara el total de
  datáfono y de transferencias contra lo registrado.
- Gates que el **backend** hace cumplir (no la interfaz):
  - No se vende sin turno abierto en la sede.
  - No se cierra un turno con comandas abiertas: o se cobran, o se **trasladan**
    explícitamente al turno siguiente y queda registrado.
  - Sólo un turno abierto por sede a la vez (constraint, no validación).

### 3.3 Comanda (el pedido del cliente)

Es la unidad de venta. Una comanda pertenece a un turno, a una persona que la abrió,
y a un **canal**: `mesa`, `para_llevar`, `domicilio`.

Estados de la comanda:

```
abierta ──► por_cobrar ──► pagada ──► cerrada
   │
   └──► anulada   (con motivo y autorización)
```

Estados de cada **ítem** de la comanda:

```
pendiente ──► enviado ──► listo ──► entregado
    │            │
    │            └──► anulado (motivo + PIN admin; ya se gastó el insumo)
    └──► anulado (sin autorización: todavía no se envió)
```

Reglas:

- Una mesa tiene **a lo sumo una comanda abierta**. Unir mesas mueve los ítems a una
  sola comanda y lo registra; separar cuentas se resuelve **al cobrar** (ver 3.4), no
  con varias comandas por mesa.
- Cada ítem guarda **precio, impuesto y costo teórico congelados** en el momento en
  que se agrega. Cambiar la carta mañana no cambia la venta de hoy.
- Los **modificadores** (término de la carne, sin cebolla, cambio de acompañamiento)
  se guardan como texto congelado en el ítem y, si el modificador tiene efecto en la
  receta (cambiar papas por ensalada), el consumo teórico usa la receta ajustada.
- **Enviar a cocina** es el evento que gasta el insumo: en ese momento se registra el
  consumo teórico de inventario (ver 5.3). Anular un ítem ya enviado no devuelve el
  insumo: genera una **merma** con motivo, porque cocina ya lo hizo.
- **Cortesía**: un ítem se puede marcar cortesía (precio 0 con motivo y PIN admin).
  Gasta insumo, no suma venta, y aparece en el reporte de cortesías.
- Tiempos: la comanda registra `abierta_en`, cada ítem `enviado_en` y `listo_en`. De
  ahí salen tiempo de mesa y tiempo de cocina sin capturar nada extra.

### 3.4 Cobro

- Una comanda se cobra con **uno o más pagos** (pago mixto): efectivo, datáfono
  (tarjeta), transferencia o QR (Nequi, Daviplata, Bre-B), plataforma de domicilios,
  y `otro` con nota. Cada medio es configurable por sede.
- **División de cuenta**: partes iguales o por ítems; cada parte es un pago con su
  propio medio. La comanda queda `pagada` cuando la suma de pagos cubre el total.
- **Propina**: voluntaria. El POS **pregunta** al cliente ("¿desea incluir servicio
  voluntario del 10 %?") y guarda la respuesta. Se registra **separada** de la venta:
  no es ingreso del restaurante, no lleva impuesto, y se reporta por turno para
  repartirla entre el personal (Ley 1935 de 2018). El porcentaje sugerido es
  configurable y no puede superar el 10 %.
- **Descuento**: por ítem o por comanda, siempre con motivo. Hasta un límite
  configurable lo aplica el operador; por encima, PIN de administrador. Todo
  descuento aparece en el reporte de descuentos por persona.
- **Impuesto**: se calcula sobre el precio neto de descuento, con la tasa de cada
  producto (INC 8 % por defecto; hay productos a otra tasa o exentos, p. ej. bebidas
  alcohólicas o productos empacados, y eso es un atributo del producto).
- El **tiquete** tiene numeración consecutiva por sede (prefijo + número, sin
  huecos), fecha y hora, sede, ítems, subtotal, descuentos, impuesto discriminado,
  propina discriminada, total, medios de pago, cambio, y quién atendió. Se puede
  imprimir desde el navegador o compartir; impresora térmica dedicada: fase 2.
- **Idempotencia**: el cobro lleva una clave única por dispositivo y comanda. Un
  doble toque o un reintento por mala red no cobra dos veces.
- **Concurrencia**: dos dispositivos que intenten cobrar la misma comanda reciben
  `409`; el primero gana.

### 3.5 Anulaciones y notas crédito

- Anular una comanda **antes** de cobrar: motivo obligatorio; si tiene ítems
  enviados, PIN admin y mermas por esos ítems.
- Anular una venta **ya cobrada**: sólo administrador, genera una **nota crédito**
  que referencia el tiquete original, con motivo, y registra si el dinero se
  devolvió (movimiento de caja de egreso) o no. El tiquete original no se toca.
- Nada se borra. Toda anulación queda en el reporte de anulaciones por persona,
  porque es el vector de fraude número uno en un restaurante.

---

## 4. La carta: platos, recetas y preparaciones

### 4.1 Insumos

Lo que se compra: proteínas, verduras, abarrotes, bebidas embotelladas, desechables.

- Unidad de **compra** (bulto de 25 kg, caja de 24) y unidad de **uso** (g, ml,
  unidad), con el factor entre ambas.
- Costo de **última compra** y costo **promedio ponderado**; el costo teórico de los
  platos usa el promedio ponderado (configurable a última compra).
- **Umbral de stock mínimo obligatorio**: no se puede dejar en cero. Un umbral en
  cero deja el motor de alertas apagado sin que nadie lo note (patrón del framework).
- Perecedero sí/no, proveedor habitual, categoría, activo/inactivo (baja lógica).

### 4.2 Preparaciones

Lo que cocina produce **por lote** y después usa en varios platos: la salsa, el
caldo, la masa, el arroz del día, el pollo desmechado.

- Tienen **receta** (insumos y/u otras preparaciones, con cantidades), un
  **rendimiento** (cuánto sale: 5 L, 40 porciones, 3 kg), una **merma de proceso**
  esperada y una **vida útil** en horas o días.
- Se **produce** registrando un lote: cantidad producida real, quién, cuándo. Esa
  producción **descuenta los insumos** y **crea stock de la preparación**.
- El costo de la preparación por unidad = costo de sus insumos ÷ rendimiento real
  del lote.
- Un lote vencido se da de baja como merma por vencimiento.
- Regla de coherencia: un plato consume **preparación**, no los insumos de la
  preparación. Así el insumo se descuenta una sola vez (al producir), nunca dos.

### 4.3 Platos (productos vendibles)

- Nombre, categoría de carta, foto opcional, descripción, activo, **disponible**
  (el "agotado" de hoy, que el operador marca desde el POS y se limpia al abrir el
  día siguiente).
- **Ficha técnica** (receta): insumos y preparaciones con cantidad en unidad de uso.
  De ahí sale el **costo teórico** y el **food cost %** (costo ÷ precio neto de
  impuesto). El administrador ve ambos al editar la carta.
- **Precio por canal** (mesa / para llevar / domicilio), opcional: si no hay precio
  por canal, aplica el de mesa.
- **Tasa de impuesto** del producto (INC 8 % por defecto).
- **Modificadores**: grupos (término, acompañamiento, sin X) con opciones; cada
  opción puede tener un ajuste de precio y un ajuste de receta (suma o reemplaza
  ingredientes).
- **Combos**: un producto sombra con precio fijo que referencia sus componentes
  (patrón del framework). La venta registra el combo como una línea y sus
  componentes como consumo; los reportes de mix cuentan el combo aparte, sin inflar
  ni desinflar unidades.
- Productos **sin receta** (una gaseosa) consumen directamente un insumo uno a uno.

---

## 5. Inventario

### 5.1 Qué se controla

Inventario **perpetuo teórico** de insumos y preparaciones por sede, corregido por
conteos físicos. Todo cambio de stock es un **movimiento** con tipo, cantidad,
costo, quién, cuándo, y referencia a lo que lo originó:

| Movimiento | Lo origina | Signo |
|---|---|---|
| compra / recepción | recepción de una compra (4.1) | + insumo |
| producción | lote de preparación | − insumos, + preparación |
| consumo por venta | ítem enviado a cocina | − insumo / − preparación |
| merma | registro de merma con tipo y responsable | − |
| ajuste por conteo | diferencia entre teórico y contado | ± |
| traslado entre sedes | fase 2 | −/+ |

### 5.2 Stock negativo

Se **permite** vender aunque el sistema diga que no hay: la realidad del negocio
es que se compra sobre la marcha y el stock del sistema va atrás del físico. El
negativo es una deuda de registro, no un bloqueo; se muestra como alerta y la
próxima recepción lo normaliza. (Lección directa de la referencia: bloquear la
venta por stock del sistema hace que la gente venda por fuera del sistema.)

### 5.3 Consumo teórico

Al enviar un ítem a cocina se registra el consumo según su ficha técnica (con los
modificadores aplicados). Se guarda **qué receta se usó**, para que cambiar la receta
después no reescriba el consumo pasado.

### 5.4 Conteos y varianza

- **Conteo rápido de críticos** al cierre (los insumos que el administrador marque:
  proteínas, licor) y **conteo completo** semanal o mensual.
- Cada conteo produce, por insumo: teórico, contado, **varianza en cantidad y en
  pesos**. El ajuste se registra como movimiento con causa `conteo`, referenciando
  el conteo.
- Un conteo lo hace una persona con PIN y lo **aprueba** el administrador antes de
  que ajuste el stock.

### 5.5 Mermas

Tipos: vencimiento, error de cocina, rotura, cortesía, consumo de personal, no
identificada. Cada merma tiene responsable (la persona en turno que la registra),
cantidad, costo al momento, y foto opcional. Se reportan por tipo y por persona.

### 5.6 Compras

- **Proveedores** con datos básicos y condición de pago.
- **Recepción** contra la factura del proveedor (foto del documento, número, fecha,
  ítems con cantidad y precio): actualiza stock y costos, y crea una **cuenta por
  pagar** con vencimiento.
- **Pagos** a proveedores: contra la cuenta por pagar, con fecha, medio y
  comprobante. El saldo **se deriva** de los pagos vivos; no existe una columna
  "pagado" que se pueda desincronizar (lección de la referencia).
- Orden de compra previa: fase 2. En el MVP la recepción es el documento.

---

## 6. Dinero

El sistema distingue **tres capas** que nunca se mezclan en una sola tabla (patrón
*DualModel* del framework):

1. **Lo registrado**: ventas por medio de pago, según el POS.
2. **La caja física**: lo que se contó al cerrar el turno, y sus diferencias.
3. **El banco**: lo que efectivamente llegó (consignaciones de efectivo,
   liquidaciones del datáfono, transferencias). MVP: sólo consignaciones de
   efectivo registradas con comprobante; conciliación bancaria completa: fase 2.

Además:

- **Movimientos de caja**: ingresos y egresos con motivo, comprobante y persona.
  Egresos típicos: compra de emergencia, taxi, cambio (sencilla). Un egreso de
  compra de emergencia puede convertirse en recepción de inventario.
- **Propinas**: fondo aparte por turno; el reporte dice cuánto se recaudó por medio
  (efectivo vs datáfono) para el reparto. No entra en ventas ni en utilidad.
- **Gastos fijos y otras obligaciones** (arriendo, servicios, nómina): fase 2. El
  MVP calcula margen bruto (ventas netas − costo teórico de lo vendido), no utilidad.
- **Nada financiero se borra**: baja lógica con quién, cuándo y por qué, y un
  registro de auditoría de cada cambio.

---

## 7. Turnos y personal

- **Empleados** con nombre, rol, PIN (hash), activo. El PIN se cambia desde admin.
- Cada **turno de caja** registra quiénes estuvieron, con hora de entrada y salida
  (marcadas con PIN). Sirve para responsabilidad de caja, reparto de propinas y para
  saber quién vendió qué.
- Horas, recargos nocturnos/dominicales y nómina: **fase 2**. El sistema registra
  desde el MVP lo que esa fase va a necesitar (entradas y salidas por persona con
  fecha de negocio), sin calcular nada laboral todavía.

---

## 8. Impuestos y facturación (Colombia)

Lo que el sistema **modela desde el día uno**, aunque la emisión legal se delegue:

- **Impuesto nacional al consumo (INC) 8 %** sobre el servicio de restaurante para
  establecimientos que no operan bajo franquicia; **IVA 19 %** si es franquicia. Es un
  parámetro de sede. Cada producto tiene su tasa (o exención). El tiquete lo
  discrimina.
- **Propina** discriminada y separada del impuesto (sección 3.4).
- **Tiquete POS** con consecutivo sin huecos por sede, y espacio para los datos que
  la DIAN exige en el documento equivalente (resolución de numeración, prefijo,
  rango, fechas de vigencia, NIT y razón social del establecimiento). Los ítems
  guardan base gravable e impuesto por línea.
- **Facturación electrónica y documento equivalente electrónico POS**: la emisión
  ante la DIAN se hace a través de un proveedor tecnológico en la **fase 2**. El
  modelo guarda lo necesario para no reconstruir ventas: consecutivo, totales por
  tasa, medio de pago, identificación del cliente cuando pide factura. Por encima
  del tope legal (5 UVT sin impuestos) el cliente tiene derecho a factura
  electrónica: en el MVP el POS avisa y registra el pedido de factura; la emisión es
  manual por el proveedor tecnológico hasta la fase 2.
- **Datos del cliente** (para factura): nombre, documento, correo. Se piden sólo
  cuando el cliente solicita factura, se guardan con la venta y con finalidad
  declarada (Ley 1581 de 2012). No se usan para otra cosa sin autorización.

Lo que el sistema **no hace**: declaraciones, retenciones, contabilidad de partida
doble. Exporta lo que el contador necesita (ventas por día y por tasa, notas
crédito, compras con factura, propinas).

---

## 9. Las pantallas

### 9.1 POS (salón)

| Vista | Qué muestra | Acciones |
|---|---|---|
| Activar dispositivo | una sola vez por tablet: PIN de sede | activar |
| Quién opera | avatares del personal activo; PIN personal | identificarse; cambiar de persona en un toque |
| Barra de estado | día y turno abierto, quién opera, mesas abiertas, alertas (sin turno, agotados) | abrir turno si no hay |
| Mesas | mapa por zona: libre / ocupada (con tiempo y total) / por cobrar; botones para llevar y domicilio | abrir mesa, unir mesas, mover comanda |
| Comanda | carta por categorías con búsqueda; ítems agotados deshabilitados; ítems de la comanda con estado; modificadores y notas | agregar, cantidad, modificar, enviar a cocina, anular (con reglas de 3.3), cortesía |
| Cobro | subtotal, descuentos, impuesto, pregunta de propina, total; pagos mixtos; división; cambio | cobrar, imprimir/compartir tiquete |
| Turno | base, ventas por medio, ingresos/egresos, retiros; cierre con conteo por denominaciones y diferencia | abrir, retiro, gasto menor, cerrar (con justificación si difiere) |
| Herramientas | mermas rápidas, marcar agotado, producción de una preparación (para la cocina que usa la misma tablet) | registrar |

Requisitos no funcionales del POS: cada acción frecuente en **tres toques o menos**;
tipografía y botones para dedo (mínimo 44 px); funciona en tablet de 10" y en PC;
tolera cortes de red breves sin perder la comanda en curso (la comanda se guarda en
el servidor a cada cambio, no al final); accesible WCAG 2.1 AA (regla global).

### 9.2 Admin (PC)

| Sección | Qué responde |
|---|---|
| **Hoy** | ¿Cómo va el día? ventas por hora, ticket promedio, mesas atendidas, comandas abiertas, efectivo esperado en caja, alertas (stock bajo, diferencias, anulaciones, agotados) |
| **Ventas** | ¿Qué vendí y cómo me pagaron? tiquetes con detalle, por día / turno / medio / canal / persona / hora; notas crédito; exportar para el contador |
| **Pedidos** | ¿Qué comandas están en curso y cuáles se anularon? estados, tiempos de mesa y cocina, anulaciones y descuentos por persona con motivo |
| **Carta y recetas** | ¿Qué me cuesta cada plato? platos, fichas técnicas, costo teórico, food cost %, modificadores, combos, disponibilidad |
| **Preparaciones** | ¿Qué se produjo y qué hay? definiciones con rendimiento, lotes producidos, stock y vencimientos |
| **Inventario** | ¿Qué tengo y qué se me pierde? stock por insumo con umbrales, movimientos, conteos y varianzas, mermas por tipo y persona |
| **Compras** | ¿A quién le debo? proveedores, recepciones con factura, cuentas por pagar con vencimiento, pagos |
| **Dinero** | ¿Cuadra la caja? turnos con base, esperado, contado, diferencia y justificación; movimientos de caja; retiros; consignaciones; propinas por turno |
| **Turnos y personal** | ¿Quién estuvo y qué hizo? empleados, PIN, entradas y salidas por turno, ventas y anulaciones por persona |
| **Configuración** | sede, impuesto (INC/IVA, incluido en precio), propina sugerida, medios de pago, numeración y datos del tiquete, límite de descuento, insumos críticos, usuarios |

Requisitos del admin: cada número responde una pregunta concreta (regla del
Analista de Datos del framework); sin datos se dice "sin datos", no cero; toda
tabla exporta a CSV/XLSX; todo se ve igual de bien en tema claro y oscuro.

---

## 10. Reportes y KPIs (definiciones)

| KPI | Fórmula | Granularidad |
|---|---|---|
| Ventas netas | Σ ítems (precio − descuento) − impuesto; sin propina | día, turno, hora, canal, persona |
| Ticket promedio | ventas netas ÷ comandas pagadas | día, persona |
| Mix de platos | unidades y ventas por plato; combos aparte | día, semana, mes |
| Margen bruto teórico | ventas netas − Σ costo teórico congelado de lo vendido | día, plato |
| Food cost teórico % | costo teórico ÷ ventas netas | plato, día |
| Food cost real % | (inventario inicial + compras − inventario final) ÷ ventas netas | entre dos conteos completos |
| Varianza de inventario | contado − teórico, en cantidad y pesos | por insumo, por conteo |
| Diferencia de caja | contado − esperado | turno |
| Anulaciones y descuentos | monto y cantidad, por persona y motivo | día, semana |
| Tiempo de mesa / de cocina | cerrada − abierta / listo − enviado | promedio y p90 por día |
| Mermas | costo por tipo y persona | semana, mes |

---

## 11. Reglas duras (no se negocian)

1. **No se vende sin turno abierto**, y no se cierra turno con comandas abiertas sin
   traslado explícito. Lo hace cumplir el backend.
2. **Precio, impuesto, costo y receta se congelan en el ítem** al momento de la venta.
3. **Nada financiero ni de inventario se borra**: baja lógica y registro de auditoría
   (quién, cuándo, por qué).
4. **Anular lo ya enviado o lo ya cobrado exige motivo y PIN de administrador**, y
   aparece en un reporte por persona.
5. **La propina es separada**: no es venta, no lleva impuesto, se reparte.
6. **El insumo se descuenta una sola vez**: al producir la preparación o al enviar el
   plato, nunca en los dos.
7. **Umbrales de stock nunca en cero** por defecto.
8. **Fecha de negocio en hora Bogotá**, guardada como fecha, no derivada de UTC.
9. **Cobro idempotente y con defensa de concurrencia** (clave única + `409`).
10. **El operador no ve costos ni márgenes**; el backend no se los manda.
11. **Sesión del dispositivo en cookie `httpOnly`**, nunca en `localStorage` (regla
    global del framework; la referencia lo hacía distinto y es una deuda conocida).
12. **Consecutivo del tiquete sin huecos** por sede.

---

## 12. Fuera del alcance del MVP (fase 2 en adelante)

- Vista de cocina (KDS) e impresión de comandas en cocina y bar.
- Emisión de factura electrónica / documento equivalente electrónico ante la DIAN.
- Impresora térmica y cajón monedero.
- Nómina, horas y recargos; contratos.
- Conciliación bancaria y gastos fijos (utilidad neta).
- Órdenes de compra y traslados entre sedes.
- Integración con plataformas de domicilio; reservas; fidelización.
- Modo sin conexión completo (el MVP tolera cortes breves, no opera sin servidor).

---

## 13. Fases de construcción

Cada fase es **un pedido** al orquestador (`args.pedido`), con su
`features/<fase>/spec.md` que apunta a este documento. El Maestro arma el equipo
de cada una según lo que la fase pide, no un roster fijo.

| Fase | Pedido | Qué queda funcionando |
|---|---|---|
| **1. Fundación y venta** | modelo de datos completo (secciones 3 a 7, aunque varias pantallas lleguen después), autenticación (admin, dispositivo, PIN), día y turno de caja con gates, mesas, comanda con estados, cobro con pagos mixtos, propina, impuesto y tiquete, anulaciones; POS completo; admin mínimo: Hoy, Ventas, Pedidos, Turnos, Configuración | se puede operar el restaurante: abrir turno, vender, cobrar, cerrar caja |
| **2. Carta, recetas e inventario** | insumos, preparaciones con lotes, fichas técnicas, consumo teórico al enviar, mermas, conteos con varianza, compras con recepción y cuentas por pagar; admin: Carta y recetas, Preparaciones, Inventario, Compras | se sabe qué cuesta cada plato y qué se pierde |
| **3. Dinero y control** | consignaciones, propinas por turno, reportes de control (anulaciones, diferencias, food cost real), exportes para el contador, vista de cocina | se cierra el mes con números |

La fase 1 es la que se lanza al aprobar esta spec.

---

## 14. Preguntas abiertas para el dueño

Cada una tiene el valor que se asume si no hay respuesta:

| Pregunta | Default asumido |
|---|---|
| ¿El restaurante opera bajo franquicia? | No → INC 8 % |
| ¿Los precios de carta incluyen el impuesto? | Sí |
| ¿Quién cobra: el mismo mesero, o un cajero aparte? | Cualquiera con PIN y permiso de cobrar, en el mismo dispositivo |
| ¿Hay domicilios propios o por plataforma hoy? | No en el MVP; el canal existe para no rediseñar |
| ¿Cuántas mesas y zonas? | Se configuran desde admin; el mapa es una grilla por zona, no un plano |
| ¿Se usa impresora térmica hoy? | No; tiquete desde el navegador |
| ¿Qué insumos son "críticos" para contar al cierre? | Los marca el administrador; sin marcar, el conteo de cierre es opcional |
| ¿Se descuenta inventario al enviar a cocina o al cobrar? | Al enviar |
| ¿Límite de descuento sin autorización? | 10 % por comanda |

---

## 15. Checklist de verificación de la spec

Lo que tiene que poder demostrarse, con el código corriendo, para dar por cumplida
cada fase. Es el checklist que el Maestro usa en la entrega.

**Fase 1**
- [ ] Sin turno abierto, `POST` de comanda responde error de negocio y el POS lo muestra.
- [ ] Dos cobros simultáneos de la misma comanda: uno `200`, otro `409`.
- [ ] Reenviar el mismo cobro con la misma clave de idempotencia no crea un segundo pago.
- [ ] Cambiar el precio de un plato no altera un tiquete anterior.
- [ ] Anular un ítem enviado sin PIN admin es rechazado por el backend.
- [ ] El tiquete discrimina impuesto y propina, y la propina no suma en ventas netas.
- [ ] Cierre de turno con diferencia distinta de cero sin justificación es rechazado.
- [ ] El consecutivo del tiquete no tiene huecos tras 100 ventas con 3 anulaciones.
- [ ] Un operador autenticado no recibe campos de costo en ninguna respuesta.
- [ ] La fecha operativa de una venta a las 11:30 pm hora Bogotá es la del mismo día.
- [ ] Typecheck, suite completa y build pasan, corridos una vez, en serie.
