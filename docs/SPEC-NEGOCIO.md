# Restaurante Sistema — Spec de negocio

Versión 0.2 (borrador para aprobación). Fecha: 2026-09-14.

Este documento dice **qué** hace el sistema y **qué reglas no se negocian**. No dice
cómo se implementa: eso lo deciden los agentes del framework en cada fase y queda
registrado en `docs/ESTADO.md`. Cuando una regla de acá cambie, cambia este
documento en el mismo PR.

Está escrito sobre dos fuentes:

1. El proyecto de referencia **`cafe-sistema`**: una cafetería real con dos sedes en
   Colombia, en producción desde mediados de 2026, con ~100 modelos, 37 routers y
   una auditoría pre-go-live de 55 defectos. Cinco lectores lo recorrieron por
   subsistema (caja y turnos, inventario y recetas, POS, plata y admin, lecciones
   del go-live). Lo que se toma de ahí se toma **con el motivo** que el código o
   los commits dan; lo que es de cafetería y no de restaurante, se deja.
2. El dominio propio de un **restaurante de servicio a la mesa en Colombia**: mesas,
   comandas, cocina, preparaciones, propina, impuesto al consumo.

Cuando una regla viene de un bug real de la referencia, se cita entre paréntesis
(«Palmetto, 15-ago»): es la forma de que dentro de un año alguien sepa por qué está.

---

## 1. Qué es y para quién

Un sistema de **punto de venta y control interno** para un restaurante de servicio a
la mesa, con dos pantallas:

| Pantalla | Quién la usa | Dónde corre | Para qué |
|---|---|---|---|
| **POS** | quien toma el pedido y quien cobra (mesero / cajero) | tablet o PC compartida en el salón, en modo dispositivo | abrir mesas, tomar comandas, enviarlas a cocina, cobrar, abrir y cerrar turno de caja |
| **Admin** | dueño / administrador | PC | ver ventas, pedidos, inventario, recetas, preparaciones, turnos, dinero; configurar la carta y el sistema |

Una tercera vista, **Cocina** (qué hay que preparar, en orden, por estación), sale
casi gratis del modelo de comanda y va en la fase 2. El modelo la contempla desde
el día uno para no rediseñar después.

### Supuestos declarados

Los deja explícitos para que se puedan corregir antes de construir:

| Supuesto | Valor asumido | Por qué |
|---|---|---|
| País y moneda | Colombia, COP, **enteros de pesos** (sin centavos) | mismo contexto que la referencia; la igualdad estricta de flotantes trabó el botón «Cobrar» en la referencia (auditoría M11) |
| Impuesto sobre la venta | restaurante **no franquicia** → impuesto nacional al consumo (INC) 8 % | es el caso general; una franquicia tributa IVA 19 % y se cambia por configuración de sede |
| Precios de carta | **incluyen** el impuesto: neto = total ÷ 1,08 | práctica del sector; la referencia contó el impuesto como utilidad durante siete meses por no separarlo |
| Sedes | una, pero **`store_id` en todo** desde el inicio | la referencia terminó con dos sedes; agregar la columna después costó migraciones y bugs de alcance |
| Dispositivos | una o más tablets compartidas por sede + PC del administrador | patrón de la referencia (dispositivo ≠ persona) |
| Stack | el default del framework: FastAPI + SQLAlchemy + Pydantic; React + TypeScript + shadcn/ui + Tailwind. PostgreSQL en producción y CI; SQLite sólo para desarrollo local y tests unitarios | no hay razón para apartarse; las trampas SQLite↔Postgres conocidas se listan en §12 |
| Idioma | UI en español; código, tests y specs técnicas en inglés | regla global del framework |
| Zona horaria de negocio | `America/Bogota`, sin horario de verano; la **fecha operativa** es un dato propio, nunca derivado de UTC | «el bug que este repo ya sufrió cuatro veces» en la referencia: días corridos, meses enteros corridos un día |
| Horario | el restaurante puede cerrar después de medianoche | la **hora de corte** que separa «cruce de medianoche» de «turno abandonado» es un parámetro de sede (default 06:00) |

---

## 2. Actores, identidad y permisos

### 2.1 Dos identidades: el dispositivo y la persona

- El **dispositivo** (tablet del salón) se activa una sola vez con el **PIN de sede**
  y queda con una sesión larga. Prueba *dónde* se opera, no *quién*.
- La **persona** se identifica en el dispositivo con su **PIN personal de 4
  dígitos** cada vez que va a hacer algo que se le atribuye (abrir una comanda,
  cobrar, registrar una merma). El dispositivo recuerda a la persona activa hasta
  que otra teclea su PIN o hasta que el turno cierra; cambiar de persona es un
  toque más un PIN.
- El **administrador** entra con correo y contraseña, en PC, y puede además teclear
  su PIN en el POS para autorizar acciones puntuales sin cerrar la sesión del
  dispositivo.

Reglas:

- Toda escritura que hace una persona guarda **`employee_id` (FK real) y
  `employee_name` (copia congelada)**. La FK garantiza integridad; la copia
  garantiza que la historia no cambie si la persona se renombra o se va. La
  referencia usó columnas planas sin FK como parche en doce tablas; acá se decide
  desde el inicio.
- Los empleados nunca se borran: se **desactivan**. Por eso la FK es segura.
- Ninguna sesión ni token vive en `localStorage`: la sesión del dispositivo y la
  del administrador van en **cookies `httpOnly`**. Para que eso funcione, el
  frontend y la API se sirven bajo el **mismo origen** (o el mismo sitio con
  `SameSite`); la referencia no pudo por desplegar en dos dominios distintos.
- Al cerrar el turno o desactivar el dispositivo se borra **toda** la atribución
  residual: la referencia tuvo ventas a nombre de la persona equivocada porque una
  clave por sede sobrevivía al logout (auditoría H9).

### 2.2 Roles

| Rol | Cómo entra | Qué puede hacer |
|---|---|---|
| **Operador** (mesero o cajero) | PIN personal en el dispositivo activado | abrir mesas, tomar y enviar comandas, cobrar, registrar mermas y gastos menores, abrir turno, relevo y cierre de caja, marcar agotados |
| **Administrador** | correo y contraseña en PC; PIN en el POS para autorizar | todo lo del operador más: carta, recetas, preparaciones, inventario, compras, dinero, reportes, usuarios, configuración, rescates de turno |
| **Contador** (fase 2) | correo y contraseña | sólo lectura de reportes y exportes |

Permisos finos del operador, configurables por sede: `puede_cobrar`,
`limite_descuento_pct` (default 10 %). Todo lo demás que salga de lo normal pide
**PIN de administrador**: anular un ítem ya enviado a cocina, anular una venta
cobrada, cortesía, descuento por encima del límite, retiro de efectivo, reabrir un
cierre.

- El operador **no ve costos ni márgenes**. El backend no se los manda: los
  esquemas de respuesta para operador no tienen esos campos. Menor privilegio en la
  API, no ocultamiento en la interfaz.
- El **alcance por sede** se verifica en cada escritura que recibe un id, no sólo en
  las lecturas: en la referencia, «cerrar el mes» de la sede vecina estaba a un
  número consecutivo de distancia (commit 305e335).

---

## 3. El eje operativo: día → turno de caja → comanda → cobro

Todo cuelga de tres entidades con estados explícitos. Es el patrón *spine* del
framework y es lo que después permite auditar «qué pasó ese día». Los estados los
cambia **sólo el backend**; la interfaz los refleja.

### 3.1 Día operativo

- Uno por sede y **fecha de negocio** (constraint único). Se crea al abrir el
  primer turno del día (get-or-create bajo savepoint: en la referencia, sin eso, la
  carrera entre dos tablets tumbaba la venta) y se cierra con el último turno.
- Una venta a las 00:30 pertenece al día del turno que la contiene. Un turno que
  sigue abierto **pasada la hora de corte** (default 06:00) es un turno abandonado:
  el POS avisa, las ventas nuevas se sellan con el día de hoy, y el administrador
  tiene un cierre administrativo para resolverlo (§3.6). La distinción es **por
  hora, no por diferencia de fechas** (la referencia permitía cerrar sin conteo un
  turno que seguía vendiendo a las 00:30).

### 3.2 Turno de caja

Es la **unidad de responsabilidad sobre el dinero**. Estados: `abierto → cerrado`.
Un solo turno abierto por sede, garantizado con **índice único parcial** en la base y
traducido a `409` si dos tablets abren a la vez.

**Apertura** (un solo paso, rápido: el gate se paga una vez por turno, no por venta):

- Quién abre (PIN) y quiénes están en el turno (roster; se puede entrar y salir
  después, ver §7).
- **Base de caja contada por denominaciones** (monedas 50 a 1.000; billetes 2.000 a
  100.000). El desglose se **guarda**, no sólo el total.
- El sistema propone la base esperada (lo que dejó el cierre anterior). Si la
  contada difiere, **justificación obligatoria**.
- **Reserva de caja** (la plata de emergencia que vive en el cajón y no se usa):
  se declara **en un campo aparte** y **no entra** en el efectivo esperado ni en
  el cuadre. Motivo: en la referencia, una reserva contada dentro de la base
  fabricó un sobrante fantasma de $500.000 que el sistema mandó consignar
  (Palmetto, 15-ago).
- El conteo de inventario **no es gate** de la venta. En un restaurante con cocina
  sería un bloqueo; el conteo de críticos es una tarea aparte (§5.4).

**Durante el turno**:

- Ventas (§3.3–3.4).
- **Movimientos de caja**: ingreso o egreso con motivo obligatorio, monto > 0,
  persona, foto opcional del comprobante. Egresos típicos: compra de emergencia,
  taxi, cambio. Un egreso de compra puede convertirse después en recepción de
  inventario (§5.6).
- **Retiro de efectivo** (el dueño pasa y se lleva plata): monto, quién, PIN de
  administrador, fecha. Es un movimiento propio, no un egreso disfrazado, porque
  después hay que saber si esa plata fue al banco o se usó para pagar proveedores
  (§6).
- **Relevo** (cambio de personas sin cerrar el turno): quien entra o sale cuenta el
  efectivo; el sistema calcula el esperado y **congela el desglose** (base,
  ventas en efectivo, ingresos, egresos, retiros) en ese instante. Sin ese
  snapshot no se puede explicar después de dónde salió el número.

**Cierre** (un solo POST atómico: conteo + datáfono + justificación + foto):

- Efectivo esperado = base + ventas en efectivo + ingresos − egresos − retiros.
  **Una sola fórmula, escrita una vez en el backend**, que la pantalla muestra como
  ecuación para que quien cuenta entienda contra qué cuadra.
- Conteo físico por denominaciones → diferencia → **justificación obligatoria si es
  distinta de cero**.
- Total del datáfono contado contra lo registrado en tarjeta; **obligatorio si hubo
  ventas con tarjeta**. Igual para transferencias.
- **Propinas**: el sistema informa cuánto se recaudó en propina por medio de pago;
  el efectivo de propinas **sale del cajón** en el cierre (o se retira aparte) y no
  forma parte del esperado de ventas.
- El cierre recibe la diferencia que la interfaz mostró; si un movimiento
  concurrente la cambió, el backend responde con la nueva y la interfaz vuelve a
  preguntar (carrera documentada y no resuelta en la referencia, auditoría M15).
- Gates: **no se vende sin turno abierto**; **no se cierra con comandas abiertas**
  salvo traslado explícito al turno siguiente (queda registrado); cerrar el último
  turno cierra el día.
- Tolerancia configurable: la diferencia dispara una alerta al administrador sólo
  si supera el umbral de la sede; nivel crítico por encima de un segundo umbral.

### 3.3 Comanda (el pedido del cliente)

Es la unidad de venta. Pertenece a un turno, a la persona que la abrió, a un
**canal** (`mesa`, `para_llevar`, `domicilio`) y, si es de mesa, a una mesa.

Estados de la comanda:

```
abierta ──► por_cobrar ──► pagada ──► cerrada
   │
   ├──► fusionada   (sus ítems pasaron a otra comanda; queda la traza)
   └──► anulada     (motivo; PIN admin si tenía ítems enviados)
```

Estados de cada **ítem**:

```
pendiente ──► enviado ──► listo ──► entregado
    │            │
    │            └──► anulado (motivo + PIN admin; el insumo ya se gastó → merma)
    └──► anulado (sin autorización: todavía no se envió)
```

Reglas:

- La comanda **vive en el servidor** desde el primer ítem: una mesa abierta dura
  horas y no puede depender de la memoria de una tablet (en la referencia el
  carrito era estado de React y moría al recargar).
- Una mesa tiene **a lo sumo una comanda abierta**. Unir mesas mueve los ítems a una
  sola comanda y marca la otra como fusionada; separar cuentas se resuelve **al
  cobrar** (§3.4), no con varias comandas por mesa. Mover una comanda a otra mesa
  queda registrado.
- Cada ítem **congela**: nombre, precio unitario, tasa de impuesto, costo teórico
  (nulo hasta que exista la receta), receta usada, texto de modificadores. Cambiar
  la carta mañana no cambia la venta de hoy ni la revaloriza.
- El **precio lo fija siempre el servidor** a partir del producto y el canal; el
  cliente manda ids y cantidades. Nunca se confía en un precio enviado por la
  tablet.
- **Modificadores** (término de la carne, sin cebolla, cambio de acompañamiento):
  grupos con opciones, cada opción con ajuste de precio y, si aplica, ajuste de
  receta (suma o reemplaza ingredientes). El texto se congela en el ítem.
- **Enviar a cocina** es el evento que gasta el insumo: registra el consumo
  teórico (§5.3) y estampa `sent_at`. Anular un ítem ya enviado **no devuelve** el
  insumo: genera una merma con motivo, porque cocina ya lo hizo.
- **Cortesía**: precio 0 con motivo y PIN de administrador. Gasta insumo, no suma
  venta, aparece en el reporte de cortesías por persona.
- **Agotado del día** (el «86»): el operador marca un plato como no disponible
  desde el POS; se limpia al abrir el día siguiente. El admin ve quién lo marcó.
- Tiempos: `opened_at`, `sent_at`, `ready_at`, `served_at`, `paid_at`. De ahí salen
  tiempo de mesa y tiempo de cocina sin capturar nada extra.
- Toda escritura que mueve plata o inventario (enviar, cobrar, producir un lote,
  marcar listo) lleva **clave de idempotencia** reservada dentro de la misma
  transacción: un doble toque o un reintento por mala red devuelve el resultado
  anterior. «El guardián del front (botón deshabilitado) es cortesía, no
  garantía» (la referencia lo aplicó a preparaciones y no al cobro; un doble tap
  podía duplicar la venta).

### 3.4 Cobro

- **Pagos como tabla**, no como dos columnas: una comanda se cobra con uno o más
  pagos (pago mixto). Medios: efectivo, datáfono (tarjeta), transferencia o QR
  (Nequi, Daviplata, Bre-B), plataforma de domicilios, `otro` con nota. Cada medio
  es configurable por sede y puede llevar referencia (número de aprobación).
- **División de cuenta**: partes iguales o por ítems; cada parte es un pago con su
  medio. La comanda queda `pagada` cuando la suma de pagos cubre el total; el
  cambio se calcula en el servidor sólo sobre el efectivo.
- **Propina**: voluntaria. El POS **pregunta** («¿desea incluir servicio voluntario
  del 10 %?») y guarda la respuesta (preguntó sí/no, aceptó sí/no, monto). Se
  registra **separada** de la venta: no es ingreso del restaurante, no causa
  impuesto, no entra en ventas netas ni en margen, y se reporta por turno y por
  medio de pago para repartirla entre el personal. El porcentaje sugerido es
  configurable y no puede superar el 10 %.
- **Descuento**: por ítem o por comanda, siempre con motivo; nunca supera el bruto
  de la línea. Hasta el límite de la sede lo aplica el operador; por encima, PIN de
  administrador. Todo descuento aparece en el reporte por persona.
- **Impuesto**: se calcula por línea sobre el precio neto de descuento con la tasa
  del producto (INC 8 % por defecto; una gaseosa o un licor pueden llevar otra tasa
  o ninguna, y eso es un atributo del producto). Los totales por tasa se guardan
  en el tiquete.
- El **tiquete** tiene numeración consecutiva por sede sin huecos (prefijo +
  número, defendido con constraint), fecha y hora, sede, mesa y canal, quién
  atendió y quién cobró, ítems con modificadores, subtotal, descuentos, impuesto
  discriminado por tasa, propina discriminada, total, medios de pago, cambio, y los
  datos del establecimiento y de la resolución DIAN (§8). Se imprime desde el
  navegador (ancho 58/72/80 mm configurable) o se comparte; impresora térmica
  dedicada, fase 2.
- La venta es **todo o nada**: comanda, pagos, tiquete, consumo pendiente, totales
  del turno y auditoría se escriben en una sola transacción.
- **Concurrencia**: dos dispositivos que intenten cobrar la misma comanda: uno gana,
  el otro recibe `409`.
- Un cobro que falla **conserva la cuenta** y muestra el error legible; la cuenta
  del cliente nunca se pierde por un fallo del cobro.

### 3.5 Anulaciones y notas crédito

- Anular una comanda **antes** de cobrar: motivo obligatorio; si tiene ítems
  enviados, PIN de administrador y mermas por esos ítems.
- Anular una venta **ya cobrada** (tiquete emitido): sólo administrador, genera una
  **nota crédito** que referencia el tiquete original, con motivo, y **por línea**
  decide si el producto «se usó» (no vuelve al inventario: el plato ya salió) o
  «vuelve» (una gaseosa cerrada). La plata se devuelve siempre: si fue en
  efectivo, egreso de caja en el turno abierto; si no hay turno abierto, queda
  como devolución pendiente del administrador.
- El tiquete original no se toca: queda en estado `reversado`. Nada se borra.
- Toda anulación aparece en el reporte de anulaciones por persona y motivo: es el
  vector de fraude número uno en un restaurante.

### 3.6 Rescates del administrador

Todo estado atascado tiene una salida administrativa, con condiciones estrictas,
motivo obligatorio y marca visible en auditoría (la referencia aprendió que sin
esto «el turno viejo seguía abierto y era el único vendible»):

| Rescate | Cuándo | Qué hace |
|---|---|---|
| Cierre administrativo | turno abandonado (pasada la hora de corte) | cierra con el esperado, diferencia 0, marcado `closed_without_count`; resta lo ya retirado |
| Reabrir cierre | una venta de último momento después de cerrar | reabre el turno; el conteo previo queda como histórico, no como cierre |
| Cancelar turno | abierto por error, sin ninguna actividad | lo elimina lógicamente |
| Ajustar apertura | la base se contó mal | reescribe base, reserva y **todo lo derivado** con la misma función del flujo normal (una corrección parcial «parecía completa y no lo era») |
| Trasladar comandas | cierre con mesas abiertas | pasa las comandas abiertas al turno siguiente, con traza |

---

## 4. La carta: insumos, preparaciones y platos

Tres **tipos explícitos** de producto, no un catálogo único con banderas (en la
referencia el rol se deducía de combinaciones de flags y un campo con doble
significado rompió el costo por gramo: 1 g de mezcla valía $3.600 en vez de $1,28).

### 4.1 Insumos (lo que se compra)

- Unidad de **uso** (g, ml, unidad) y unidad de **compra** (bulto de 25 kg, caja de
  24) con el factor entre ambas. La conversión al recibir es determinística; lo
  dudoso se pregunta, nunca se adivina.
- Costo de **última compra** y costo **promedio ponderado** por cantidad; el dueño
  puede fijar un **costo oficial** que manda sobre los dos (una lectura ruidosa de
  factura no ensucia un costo confirmado). Todo costo viaja con su **origen**
  (oficial / factura / receta / estimado / sin costo). **Nunca un cero mudo**: sin
  costo se dice «sin costo», no $0.
- **Umbral de stock mínimo obligatorio**, nunca cero: un umbral en cero deja el motor
  de alertas apagado sin que nadie lo note (en la referencia, 55 de 56 productos).
  Lead time del proveedor en días. En fase 3 el sistema **propone** el mínimo a
  partir de consumo × lead time; el dueño lo acepta explícitamente.
- Perecedero sí/no, categoría, proveedor habitual (FK a Proveedor, §5.6), activo o
  inactivo (baja lógica), **crítico** (entra al conteo rápido de cierre).
- **Consumo no predecible** (`consumption_untracked`): servilletas, sal de mesa,
  aceite de fritura, aseo. Ninguna receta lo descuenta; se mide entre dos conteos
  (antes + entradas − después). Tratarlo como «receta mal configurada» manda a
  buscar un ladrón donde hay clientes.
- **Sustituto** opcional (si se acaba el arroz marca A se descuenta el B): un solo
  camino de consumo con cascada, usado igual por venta, cortesía y producción.
  Vender y regalar el mismo plato dejan el inventario idéntico (en la referencia,
  dos caminos distintos dejaron la leche entera en −4 y la deslactosada en +19).

### 4.2 Preparaciones (lo que cocina produce por lote)

La salsa, el caldo, la masa, el arroz del día, el pollo desmechado: se producen en
tanda y después se usan en varios platos.

- **Receta** propia (insumos y/u otras preparaciones, con cantidad y unidad por
  línea), **rendimiento** en su propia columna (cuánto sale: 5 L, 40 porciones),
  **merma de proceso** esperada y **vida útil** en horas o días.
- Se **produce** registrando un lote: cantidad producida real, quién, cuándo, con
  clave de idempotencia. Esa producción **descuenta los insumos** y **crea stock de
  la preparación** con vencimiento y costo por lote.
- Costo por unidad de la preparación = costo de sus insumos ÷ rendimiento real del
  lote, y ese costo **sí propaga** al plato que la usa (en la referencia no
  propagaba y el plato aparecía «sin costo»).
- Un lote vencido se da de baja como merma por vencimiento.
- Regla de coherencia: un plato consume **preparación**, no los insumos de la
  preparación. El insumo se descuenta una sola vez: al producir.

### 4.3 Platos (lo que se vende)

- Nombre, categoría de carta (configurable, no un enum fijo), **estación de cocina**
  (cocina caliente, fría, bar, postres: es lo que la vista de cocina usa para
  rutear), descripción, foto opcional, activo, disponible hoy.
- **Ficha técnica** (receta): insumos y preparaciones con cantidad y unidad por
  línea. De ahí salen el **costo teórico** y el **food cost %** (costo ÷ precio neto
  de impuesto). El administrador los ve al editar.
- Validación de **recetas sospechosas de unidad**: 18 «kg» donde iban 18 g desploma
  el stock en horas y ningún conteo lo explica. Cantidad ≥ 5 sobre un insumo en
  kg/L o < 0,5 sobre uno en g/ml se marca para revisar.
- **Cobertura de recetas**: un plato vendido sin receta ni insumo directo no
  descuenta nada. La venta sigue, y el administrador recibe una alerta (una vez por
  día por plato) más un reporte de «platos que no descuentan».
- **Precio por canal** (mesa / para llevar / domicilio), opcional; sin precio por
  canal aplica el de mesa. **Tasa de impuesto** por producto.
- **Modificadores** (§3.3) definidos por grupo y reutilizables entre platos.
- **Combos** (menú del día, almuerzo ejecutivo): un **producto sombra** con precio
  fijo, grupos de elección (sopa, principio, jugo) con opciones que apuntan a
  productos reales. Entra al tiquete como una línea; el consumo y el mix de platos
  se calculan por componentes, nunca como líneas con precio. Un combo sin grupos no
  es vendible (la referencia cobró combos completos sin entregar nada). Se puede
  descontar un combo sólo a nivel de comanda.
- Productos **sin receta** (una gaseosa) consumen un insumo uno a uno.
- Baja lógica siempre: un plato con historial no se borra, se archiva.

---

## 5. Inventario

### 5.1 Un solo libro de movimientos, con causa tipada

Inventario **perpetuo teórico** de insumos y preparaciones por sede, corregido por
conteos. Todo cambio de stock es un **movimiento** con `cause` **enumerada**
(`purchase`, `production_in`, `production_out`, `sale`, `void_after_send`, `waste`,
`count_adjustment`, `transfer_in`, `transfer_out`, `credit_note_return`,
`manual_adjustment`), cantidad, costo unitario al momento, persona, instante, y
referencia a lo que lo originó. La causa **no** se infiere de un texto: en la
referencia un motivo escrito distinto se leyó como fuga de $1.126.398.

Toda escritura pasa por **una sola función** que mantiene stock, lotes y auditoría.

### 5.2 Stock negativo

Se **permite** vender aunque el sistema diga que no hay: se compra sobre la marcha
y el stock del sistema va atrás del físico. El negativo es una deuda de registro,
no un bloqueo, y la próxima recepción lo normaliza. **Negativo no es agotado**:
agotado es «se acabó, hay que pedir»; negativo es «este número es imposible: entró
algo sin registrar o una receta descuenta lo que no es». Alertas distintas (en la
referencia un helado estuvo tres meses en −400 g porque tres recetas descontaban un
insumo que nunca se compró, y nadie leyó la alerta como error de receta). Un
insumo con consumo por receta y **cero compras** en 60 días es un reporte propio.

### 5.3 Consumo teórico

Al enviar un ítem a cocina se registra el consumo según su ficha técnica (con
modificadores aplicados). Se guarda **qué versión de receta** se usó. Los consumos
del mismo insumo dentro de una comanda se fusionan en un movimiento; la reversión,
cuando aplica (nota crédito «vuelve»), es espejo exacto.

### 5.4 Conteos y varianza

- **Conteo rápido de críticos** al cierre (los insumos marcados: proteínas, licor)
  y **conteo completo** semanal o mensual.
- **Conteo a ciegas**: quien cuenta **no ve el stock del sistema**; la referencia en
  pantalla es el último conteo, no el teórico. Y **no existe el atajo «todo
  coincide»** (en la referencia borró faltantes reales: −10.065 g). Cada renglón
  lleva `was_counted` escrito sólo por quien cuenta; un renglón no contado es
  distinto de uno que dio exacto.
- El conteo **no pisa el stock**: registra teórico, contado y **varianza en cantidad
  y en pesos** (con el origen del costo). Aplicarlo es una acción explícita del
  administrador, **una sola vez**, con la fórmula `stock = contado + (entradas −
  salidas desde el instante del conteo)`: el conteo es la verdad de un instante,
  no de ahora (la referencia aplicó a las 15:42 un conteo de las 13:07 y «mandó a
  buscar un robo que no existe»). El ajuste queda como movimiento con causa
  `count_adjustment` y referencia al conteo.
- Entrada numérica de conteos: campo de texto con teclado decimal, acepta coma y
  sumas («6+8») con parser propio, pinta en rojo lo inválido y no lo envía; el
  servidor valida cada renglón. Un borrador local nunca pisa un valor ya confirmado.
- Un «guardado» que no guardó todo lo dice: si ningún renglón se persistió, error;
  si algunos sí, la respuesta lista los que no, y la pantalla lo muestra hasta
  reintentar.

### 5.5 Mermas

Tipos: vencimiento, error de cocina, rotura, cortesía, consumo de personal, sin
identificar. Responsable (quien la registra, con PIN), «quién consumió» cuando es
consumo de personal, cantidad, costo al momento, foto opcional. Reporte por tipo,
por persona y alerta si la merma de un insumo esta semana supera 1,5 × la anterior.

### 5.6 Compras

- **Proveedores** como entidad (nombre canónico, NIT, plazo en días, contacto). No
  texto libre: la referencia tuvo 41 grafías para 23 proveedores.
- **Recepción** contra la factura del proveedor: foto del documento, número, fecha,
  ítems con cantidad recibida (y cantidad facturada, para medir confiabilidad),
  precio unitario, lote y vencimiento. Al confirmar: entrada de inventario, **lote**
  con vencimiento y costo, actualización de costos, y una **cuenta por pagar** con
  vencimiento (programada > vencimiento > recibido + plazo).
- Guardas de tecleo al recibir: precio de empaque cargado como unitario (10-12 ×
  la referencia) se marca sospechoso; cantidad diminuta en un insumo por gramos
  pregunta «¿eran empaques?».
- **Pagos** contra la cuenta por pagar: fecha real de salida de la plata, medio,
  comprobante. El saldo **se deriva** de los pagos vivos: no existe una columna
  «pagado» que se pueda desincronizar. Un pago en efectivo desde el cajón crea el
  egreso de caja en el turno abierto en la misma transacción.
- Editar o eliminar una recepción **revierte todo** aguas abajo (inventario, lotes,
  egresos, pagos) de forma atómica, o falla explicando por qué no se puede.
- Orden de compra previa y sugerencia de reposición: fase 3. En el MVP la recepción
  es el documento.

### 5.7 Lotes y vencimientos

Toda entrada (compra, producción, traslado recibido) crea un lote con vencimiento y
costo; toda salida consume el lote más antiguo. Estados derivados: activo, por
vencer (≤ 7 días, configurable), vencido, agotado. En un restaurante con perecederos
esto importa más que en un café.

---

## 6. Dinero

### 6.1 Tres bolsas que nunca se mezclan

El patrón *DualModel* del framework, extendido con lo que la referencia aprendió:

1. **El cajón** de cada sede: lo que dice el POS (ventas por medio), lo que se contó
   (turnos), y sus movimientos y retiros.
2. **El banco**: lo que efectivamente llegó (consignaciones de efectivo con
   comprobante, liquidaciones del datáfono con rezago y comisión, transferencias).
3. **La mano del dueño**: lo que retiró del cajón y todavía no consignó ni gastó.

MVP (fases 1 y 2): el cajón completo y los retiros. **Consignaciones** con foto del
comprobante y la relación «este turno ya se consignó» en fase 3, junto con el libro
del banco. Lo que sí queda desde el día uno: cada turno cerrado sabe cuánto **debería
consignarse** (ventas en efectivo + ingresos − egresos + diferencia − retiros), con
una sola fórmula en el backend.

Principios que aplican a todo número de plata:

- **Una sola matemática, en el backend.** El frontend nunca deriva saldos,
  pendientes ni diferencias; los recibe calculados. Cuando dos pantallas
  recalcularon la misma plata con fórmulas propias, la referencia tuvo «$400.000 en
  la pantalla y $222.300 en la cuenta» sobre el mismo día.
- **Nada se almacena si se puede derivar**: estado de una cuenta por pagar, saldo
  por consignar, efectivo esperado. La única columna almacenada de ese tipo en la
  referencia fue justamente la que se desincronizó.
- **`null` no es 0.** «Nadie contó» y «se contó y no falta nada» son afirmaciones
  distintas; la API y los tipos las distinguen y la pantalla las dibuja distinto.
- **El error tolerable es el que muestra menos plata.** Todo sesgo se orienta al
  lado incómodo y se declara; un número cercano al correcto y tranquilizador es el
  modo de falla que más costó ($1.000.000 en pantalla donde había $600.000).
- **Nada financiero ni de inventario se borra**: baja lógica con quién, cuándo y por
  qué, y un registro de auditoría con el antes y el después de cada cambio. Si la
  auditoría no puede escribirse, se registra la falla; nunca se traga en silencio.

### 6.2 Propinas

Fondo aparte por turno: cuánto se recaudó en efectivo y cuánto por datáfono o
transferencia (que el banco liquida junto con la venta). El reporte por turno y por
persona sirve para el reparto. No entra en ventas, ni en impuesto, ni en utilidad.

### 6.3 Gastos, obligaciones y utilidad

Arriendo, servicios, nómina y demás obligaciones: **fase 3**. El MVP calcula
**margen bruto** (ventas netas − costo teórico de lo vendido), no utilidad, y lo
dice así en pantalla.

---

## 7. Turnos y personal

- **Empleados**: nombre, rol, PIN (hash), activo, sede. El PIN se cambia desde
  admin. Un empleado inactivo no puede identificarse.
- Cada **turno de caja** tiene un roster: quién entró y salió, con hora, marcado
  con PIN. Sirve para responsabilidad de caja, reparto de propinas y para saber
  quién vendió qué. Quien sale se marca explícitamente; no se infiere de la persona
  activa (la referencia tuvo un «Salida Esther» cuando salió Luisa).
- Horas, recargos nocturnos y dominicales, nómina: **fase 3**. El sistema registra
  desde el MVP lo que esa fase necesita (entradas y salidas por persona con fecha
  de negocio), sin calcular nada laboral todavía.

---

## 8. Impuestos y facturación (Colombia)

Lo que el sistema **modela desde el día uno**, aunque la emisión legal se delegue:

- **Impuesto nacional al consumo (INC) 8 %** sobre el servicio de restaurante para
  establecimientos que no operan bajo franquicia; **IVA 19 %** si es franquicia. Es
  un parámetro de sede **con vigencia** (`valid_from`) y con `price_includes_tax`.
  Cada producto tiene su tasa o exención. El tiquete lo discrimina por tasa y guarda
  base e impuesto por línea.
- Venta neta = total cobrado ÷ (1 + tasa) cuando el precio incluye el impuesto. Los
  márgenes se calculan sobre la neta; «ventas» a secas sigue siendo lo cobrado,
  porque es lo que cuadra contra caja.
- **Propina** discriminada y separada del impuesto (§3.4): no lo causa.
- **Tiquete**: consecutivo sin huecos por sede y campos para lo que la DIAN exige
  en un documento equivalente (NIT y razón social, resolución de numeración, prefijo,
  rango, vigencia). Mientras no exista la emisión electrónica, el tiquete dice
  «comprobante de venta interno» y no pretende ser factura.
- **Factura electrónica y documento equivalente electrónico POS**: la emisión ante
  la DIAN se hace a través de un proveedor tecnológico en la **fase 2**. Por encima
  del tope legal para tiquete POS (5 UVT sin impuestos; el valor de la UVT es un
  parámetro con vigencia) el cliente tiene derecho a factura electrónica: el POS
  avisa, captura los datos del cliente y registra el pedido de factura; la emisión
  es manual hasta la fase 2.
- **Datos del cliente** (nombre, documento, correo): sólo cuando pide factura, con
  finalidad declarada (Ley 1581 de 2012), guardados con la venta y no usados para
  otra cosa sin autorización.
- El impuesto medido por bimestre y el 4 × 1000 del banco aparecen en fase 3 como
  obligaciones agendadas, para que el flujo de caja no los ignore (la referencia
  descubrió $3,4 millones de GMF y comisiones que ningún reporte veía).

Lo que el sistema **no hace**: declaraciones, retenciones, contabilidad de partida
doble. Exporta lo que el contador necesita (ventas por día y por tasa, notas
crédito, compras con factura, propinas), agrupado por **día operativo**, no por día
calendario.

---

## 9. Las pantallas

### 9.1 POS (salón)

| Vista | Qué muestra | Acciones |
|---|---|---|
| Activar dispositivo | una sola vez por tablet: sede + PIN de sede | activar; desactivar desde el cierre |
| Quién opera | avatares del personal en turno; teclado de PIN | identificarse; cambiar de persona en un toque |
| Barra de estado | día y turno abierto, quién opera, mesas abiertas, avisos (sin turno, turno abandonado, agotados) | abrir turno si no hay; todo 4xx operativo **nombra la acción correctiva** («Abrir turno →») |
| Mesas | mapa por zona: libre / ocupada (tiempo y total) / por cobrar; botones para llevar y domicilio | abrir mesa, unir, mover comanda |
| Comanda | carta por categorías con búsqueda y **favoritos** (lo más vendido en 7 días primero); agotados deshabilitados; ítems con estado; modificadores y notas | agregar, cantidad, modificar, **enviar a cocina**, anular (reglas de §3.3), cortesía |
| Cobro | subtotal, descuentos, impuesto, pregunta de propina, total; pagos mixtos; división; cambio en vivo con atajos de billetes | cobrar, imprimir o compartir tiquete, reimprimir el último |
| Turno | base, ventas por medio, ingresos, egresos, retiros; relevo; cierre con contador por denominaciones y diferencia | abrir, relevo, retiro (PIN admin), gasto menor, cerrar |
| Herramientas | paneles laterales **sin abandonar el POS**: merma rápida, marcar agotado, producir una preparación, historial de mis ventas | registrar |

Requisitos no funcionales del POS: cada acción frecuente en **tres toques o menos**;
botones para dedo (mínimo 44 px); tablet de 10" y PC; el estado de mesas y turno se
refresca por sondeo corto (5–8 s) sin infraestructura extra; un cobro que falla
conserva la cuenta; accesible WCAG 2.1 AA (regla global del framework); todo error
del servidor se muestra como texto legible, nunca crudo (un `detail` que era una
lista dejó la referencia en pantalla blanca).

### 9.2 Admin (PC)

Organizado en tres bandas, como el dashboard que la referencia terminó adoptando:
**pulso de hoy**, **requiere tu atención** (tarjetas accionables), **análisis** por
período.

| Sección | Qué responde |
|---|---|
| **Hoy** | ¿Cómo va el día? ventas por hora, ticket promedio, mesas atendidas, comandas abiertas, efectivo esperado en caja; alertas: sin turno o turno abandonado, diferencias de caja, anulaciones y descuentos inusuales, agotados, stock negativo o crítico |
| **Ventas** | ¿Qué vendí y cómo me pagaron? tiquetes con detalle, por día / turno / medio / canal / persona / hora; notas crédito; **informe para el contador** por día operativo y por tasa; exportar CSV/XLSX |
| **Pedidos** | ¿Qué comandas están en curso y cuáles se anularon? estados, tiempos de mesa y cocina, anulaciones, cortesías y descuentos por persona con motivo |
| **Carta y recetas** | ¿Qué me cuesta cada plato? platos, fichas técnicas, costo teórico con origen, food cost %, modificadores, combos, disponibilidad, cobertura de recetas |
| **Preparaciones** | ¿Qué se produjo y qué hay? definiciones con rendimiento, lotes producidos, stock y vencimientos |
| **Inventario** | ¿Qué tengo y qué se me pierde? stock con umbrales y semáforo, movimientos por causa, conteos y varianzas valorizadas, mermas por tipo y persona, negativos con causa probable |
| **Compras** | ¿A quién le debo? proveedores, recepciones con factura, cuentas por pagar con vencimiento, pagos |
| **Dinero** | ¿Cuadra la caja? turnos con base, esperado, contado, diferencia y justificación (modo operacional y modo historial); movimientos; retiros; por consignar; propinas por turno; rescates de turno |
| **Turnos y personal** | ¿Quién estuvo y qué hizo? empleados, PIN, entradas y salidas por turno, ventas, anulaciones y diferencias por persona |
| **Historial** | ¿Quién cambió qué? registro de auditoría con antes y después, filtrable |
| **Configuración** | sede, hora de corte, impuesto (INC/IVA, incluido en precio, vigencia), propina sugerida, medios de pago, numeración y datos del tiquete, límite de descuento, tolerancia de descuadre, insumos críticos, usuarios y PINs |

Requisitos del admin: cada número responde una pregunta concreta (regla del Analista
de Datos del framework); «sin datos» se dice, no se dibuja como cero; toda tabla de
saldos muestra los términos que hacen cerrar la identidad («arrancó · entró · salió ·
queda») y viaja con un `cuadra` calculado en el backend; toda lista exporta; ambos
temas, claro y oscuro.

### 9.3 Cocina (fase 2)

Comandas enviadas por estación, en orden de llegada, con tiempo transcurrido; marcar
«listo» por ítem (con clave de idempotencia). Impresión de comanda por estación como
alternativa a la pantalla.

---

## 10. Reportes y KPIs (definiciones)

| KPI | Fórmula | Granularidad |
|---|---|---|
| Ventas cobradas | Σ tiquetes no anulados ni reversados | día operativo, turno, hora, canal, persona |
| Ventas netas | ventas cobradas − impuesto; sin propina | ídem |
| Ticket promedio | ventas netas ÷ comandas pagadas | día, persona |
| Mix de platos | unidades y ventas por plato; combos aparte, componentes en consumo | día, semana, mes |
| Margen bruto teórico | ventas netas − Σ costo teórico congelado de lo vendido, con % de venta costeada | día, plato |
| Food cost teórico % | costo teórico ÷ ventas netas | plato, día |
| Food cost real % | (inventario inicial + compras − inventario final) ÷ ventas netas | entre dos conteos completos; `null` si no hubo dos conteos |
| Varianza de inventario | contado − teórico, en cantidad y pesos, con origen del costo | por insumo, por conteo |
| Diferencia de caja | contado − esperado | turno; ranking de personas con diferencias repetidas |
| Anulaciones, cortesías y descuentos | monto y cantidad por persona y motivo | día, semana |
| Tiempo de mesa / de cocina | cerrada − abierta / listo − enviado | promedio y p90 por día |
| Mermas | costo por tipo y persona | semana, mes |
| Propinas | recaudado por medio y por turno | turno, semana |

Toda serie diaria agrupa por **día operativo**, no por fecha calendario.

---

## 11. Reglas duras (no se negocian)

1. **No se vende sin turno abierto**, y no se cierra un turno con comandas abiertas
   sin traslado explícito. Lo hace cumplir el backend; la interfaz sólo rutea.
2. **Precio, impuesto, costo y receta se congelan en el ítem** al momento de la
   venta. El precio lo fija el servidor.
3. **Nada financiero ni de inventario se borra**: baja lógica y auditoría con antes y
   después.
4. **Anular lo ya enviado o lo ya cobrado exige motivo y PIN de administrador**, y
   aparece en un reporte por persona.
5. **La propina es separada**: no es venta, no causa impuesto, se reparte.
6. **El insumo se descuenta una sola vez**: al producir la preparación o al enviar el
   plato, nunca en los dos. Un solo camino de consumo para venta, cortesía y
   producción.
7. **Umbrales de stock nunca en cero** por defecto.
8. **Fecha de negocio como fecha** (`Date`) en columna propia, en hora Bogotá;
   instantes en UTC con marca de zona; la fecha operativa se sella en el tiquete.
9. **Cobro, envío y producción idempotentes** (clave reservada dentro de la
   transacción) y **`409` ante concurrencia**; un turno abierto por sede con índice
   único parcial.
10. **El operador no ve costos ni márgenes**; el backend no se los manda.
11. **Sesión en cookie `httpOnly`**, nunca en `localStorage`; frontend y API bajo el
    mismo origen.
12. **Consecutivo del tiquete sin huecos** por sede, defendido con constraint.
13. **Una sola matemática en el backend**; el frontend no deriva plata. `null` no
    es 0. El error tolerable muestra menos plata.
14. **Causa tipada** en todo movimiento de inventario y de caja; nunca clasificar
    por texto libre.
15. **La reserva de caja no entra al cuadre**; el conteo no pisa el stock; aplicar un
    conteo suma el neto posterior al instante contado.
16. **Todo 4xx operativo nombra la acción correctiva**; un 200 que no guardó todo
    lo dice.

---

## 12. Lo que la referencia enseñó (convertido en convenciones)

No son reglas de negocio, pero cada una costó plata o días en `cafe-sistema` y el
equipo que construya cada fase las hereda:

- **Migraciones reales (Alembic) desde el primer commit.** Una columna declarada en
  el modelo sin su migración fue el bug más caro del go-live (500 en el login).
  DDL escrito para Postgres aunque se pruebe en SQLite; backfill obligatorio para
  toda columna nueva que participe en filtros; seeds idempotentes y **fuera** del
  arranque de producción; requirements mínimos generados desde un lock.
- **Trampas SQLite↔Postgres conocidas**: enums (comparar por valor), orden de
  `NULL` en `ORDER BY DESC`, funciones de fecha (agrupar en Python o con SQL
  portable), `MIN` sobre `Date` devuelve texto en SQLite, tope de variables en
  `IN (...)`. `busy_timeout` en SQLite para que una carrera caiga en el `UNIQUE` y
  no en «database is locked».
- **Errores**: una sola forma `{ error: { code, message } }`; reglas de negocio en
  `400` con código y texto para humanos, validación de esquema normalizada a la
  misma forma, `409` para concurrencia. El cliente parsea en un solo lugar; ningún
  `catch` vacío; un estado de carga y de error por recurso.
- **Despliegue desfasado**: frontend y backend no terminan de desplegar a la vez.
  Todo campo nuevo de respuesta es opcional en el cliente con fallback explícito, y
  «ausente» se dibuja distinto de «vacío» o «0».
- **Índices para cada consulta que corre en cada venta o en cada carga de pantalla**
  (tiquetes por sede y fecha, por día operativo; movimientos por fecha). Filtrar por
  rango precalculado, nunca con `date()` sobre la columna.
- **Tests como enunciados de regla** («el precio lo fija el servidor aunque el
  cliente mande otro», «vender y regalar dejan el inventario idéntico», «el mismo
  cobro con la misma clave no crea un segundo tiquete») más tests de invariantes
  (Σ desglose = total; anular no mueve los totales de otro turno) y de zona horaria.
  **CI que corre la suite y bloquea el deploy en rojo**; la referencia verificaba a
  mano y no tiene tests de frontend.
- **Un solo documento de estado con fecha** (`docs/ESTADO.md`); lo que no está en el
  código no se afirma. La referencia tiene tres documentos que se contradicen sobre
  dónde corre.
- **Hosting sin arranque en frío** para el POS: «el primer clic después de una pausa
  sigue pagando el despertar».
- **Todo maestro editable desde la app** (combos, carta, PINs, parámetros): la
  referencia esperó días por un combo que sólo se creaba con un script en el
  servidor.

---

## 13. Fuera del alcance del MVP (fase 2 en adelante)

- Vista de cocina e impresión de comandas por estación (fase 2).
- Emisión de factura electrónica / documento equivalente electrónico ante la DIAN
  (fase 2, vía proveedor tecnológico).
- Impresora térmica y cajón monedero.
- Consignaciones, libro del banco, mano del dueño, conciliación (fase 3).
- Nómina, horas y recargos; contratos (fase 3).
- Obligaciones y gastos fijos; utilidad neta; punto de equilibrio (fase 3).
- Órdenes de compra, sugerencia de reposición, traslados entre sedes (fase 3).
- Integración con plataformas de domicilio; reservas; fidelización; clientes.
- Modo sin conexión completo (el MVP tolera cortes breves; no opera sin servidor).

---

## 14. Fases de construcción

Cada fase es **un pedido** al orquestador (`args.pedido`), con su
`features/<fase>/spec.md` que apunta a este documento. El Maestro arma el equipo de
cada una según lo que la fase pide, no un roster fijo.

| Fase | Pedido | Qué queda funcionando |
|---|---|---|
| **1. Fundación y venta** | modelo de datos de las secciones 2, 3, 6.1, 7 y 8 (más los ganchos para 4 y 5: el ítem ya congela costo y receta), autenticación (admin, dispositivo, PIN), día y turno de caja con gates, relevo, retiros y rescates, mesas, comanda con estados, envío a cocina (sin consumo todavía), cobro con pagos mixtos, propina, impuesto y tiquete, anulaciones y notas crédito; POS completo; admin: Hoy, Ventas, Pedidos, Dinero, Turnos y personal, Historial, Configuración | se puede operar el restaurante: abrir turno, vender, cobrar, cerrar caja |
| **2. Carta, recetas e inventario** | insumos, preparaciones con lotes, fichas técnicas, consumo teórico al enviar, mermas, conteos a ciegas con varianza y aplicación, compras con recepción, proveedores y cuentas por pagar, lotes; admin: Carta y recetas, Preparaciones, Inventario, Compras; vista de cocina; facturación electrónica vía proveedor | se sabe qué cuesta cada plato y qué se pierde |
| **3. Dinero y control** | consignaciones, retiros conciliados, libro del banco, propinas repartidas, obligaciones y gastos, punto de equilibrio, food cost real, reposición sugerida, exportes completos para el contador, nómina | se cierra el mes con números |

La fase 1 es la que se lanza al aprobar esta spec; su spec de pedido está en
`features/fase-1-fundacion/spec.md`.

---

## 15. Preguntas abiertas para el dueño

Cada una tiene el valor que se asume si no hay respuesta:

| Pregunta | Default asumido |
|---|---|
| ¿El restaurante opera bajo franquicia? | No → INC 8 % |
| ¿Los precios de carta incluyen el impuesto? | Sí |
| ¿Emite hoy factura electrónica o documento equivalente con algún proveedor (Siigo, Alegra, otro)? | No; el tiquete es comprobante interno hasta la fase 2 |
| ¿Quién cobra: el mismo mesero o un cajero aparte? | Cualquiera con PIN y permiso de cobrar, en el mismo dispositivo |
| ¿Cuántas tablets en el salón? ¿Cada mesero con su celular? | Una o dos tablets compartidas por sede |
| ¿Hasta qué hora atienden? | Puede cerrar después de medianoche; hora de corte 06:00 |
| ¿Hay reserva fija de efectivo en el cajón? | Sí, se declara aparte al abrir |
| ¿Quién retira el efectivo y cada cuánto? ¿Consigna el local o recoge el dueño? | Retira el dueño con PIN; consignaciones en fase 3 |
| ¿Medios de pago hoy? (marca del datáfono, Nequi, Daviplata, Bre-B, plataformas) | Efectivo, datáfono, transferencia/QR |
| ¿Propina sugerida y cómo se reparte? | 10 % voluntaria; reporte por turno, reparto manual |
| ¿Hay domicilios propios o por plataforma? | No en el MVP; el canal existe |
| ¿Cuántas mesas y zonas? | Se configuran desde admin; grilla por zona, no plano |
| ¿Se usa impresora térmica hoy? | No; tiquete desde el navegador |
| ¿Qué insumos son «críticos» para contar al cierre? | Los marca el administrador; sin marcar, el conteo de cierre es opcional |
| ¿Se descuenta inventario al enviar a cocina o al cobrar? | Al enviar |
| ¿Límite de descuento sin autorización? | 10 % por comanda |
| ¿Tiene una hoja de Excel con la caja o las ventas de un mes real? | Si existe, se convierte en fixture de tests, como hizo la referencia |

---

## 16. Checklist de verificación de la spec

Lo que tiene que poder demostrarse, con el código corriendo, para dar por cumplida
cada fase. Es el checklist que el Maestro usa en la entrega.

**Fase 1**
- [ ] Sin turno abierto, crear una comanda responde error de negocio con la acción
      correctiva, y el POS lo muestra.
- [ ] Dos aperturas de turno simultáneas en la misma sede: una `200`, otra `409`.
- [ ] Dos cobros simultáneos de la misma comanda: uno `200`, otro `409`.
- [ ] Reenviar el mismo cobro con la misma clave de idempotencia no crea un segundo
      pago ni un segundo tiquete; devuelve la misma respuesta.
- [ ] Cambiar el precio de un plato no altera un tiquete anterior; el precio que
      manda el cliente se ignora.
- [ ] Anular un ítem enviado sin PIN de administrador es rechazado por el backend.
- [ ] El tiquete discrimina impuesto por tasa y propina; la propina no suma en
      ventas netas ni causa impuesto.
- [ ] Cierre de turno con diferencia distinta de cero sin justificación es rechazado;
      la reserva declarada no altera el esperado.
- [ ] El consecutivo del tiquete no tiene huecos tras 100 ventas con 3 anulaciones.
- [ ] Un operador autenticado no recibe campos de costo en ninguna respuesta (test
      sobre el OpenAPI).
- [ ] Una venta a las 00:30 hora Bogotá pertenece al día del turno; una a las 10:00
      sobre un turno abandonado se sella con el día de hoy.
- [ ] `alembic upgrade head` desde cero crea el esquema; el seed corre aparte.
- [ ] No hay `localStorage.setItem` de tokens ni de sesión en el frontend.
- [ ] Typecheck, suite completa y build pasan, corridos una vez, en serie.
