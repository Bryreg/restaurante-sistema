# Prompt para la skill de UI/UX

> Copiar desde «Contexto» hasta el final y pasárselo a la skill de diseño.
> Adrede no trae indicaciones visuales (colores, tipografía, estilo,
> referencias de otras marcas): la dirección visual la propone la skill.

---

## Contexto

Vas a diseñar la interfaz de **Restaurante Sistema**: un punto de venta y
control interno para restaurantes de Colombia, desde un corrientazo de
barrio hasta un restaurante con varias sedes. No es una app para el
comensal: la usan **el dueño y su equipo** para vender, cocinar, cuidar la
caja y saber si el negocio gana plata.

Diseñá con libertad, pero con una idea clara: **cada pantalla existe para
que una persona concreta, en un momento concreto del servicio, tome una
decisión o haga una tarea rápido y sin equivocarse con la plata.**

## Quién la usa, dónde y en qué condiciones

1. **La cajera o el cajero.** Abre el turno contando la base, cobra
   (efectivo con vuelto, datáfono, Nequi y transferencias, pagos divididos,
   propina aparte), hace retiros de efectivo, paga gastos menores del cajón
   y cierra el turno **a ciegas**: cuenta lo que hay sin ver cuánto debería
   haber. Es responsable del cajón. Tablet o PC en el mostrador, con filas
   de gente y ruido.
2. **Los meseros.** Toman el pedido en la mesa o en el salón, con
   modificadores (término de la carne, sin cebolla, acompañamiento extra),
   combos, cursos (entrada, fuerte, postre) y notas. Envían a cocina,
   presentan la cuenta y la dividen entre comensales. Unen o mueven mesas.
   Tablet compartida en la mano, a veces con una sola mano libre, de pie,
   apurados.
3. **La cocina.** Ve lo que tiene que preparar por estación (caliente,
   fría, bar, postres) y cuánto lleva esperando cada plato; lo marca listo.
   Registra lo que produce en lote (arroz, frijoles) y lo que se pierde
   (merma). Pantalla fija o tablet cerca del fogón, con las manos ocupadas o
   sucias, mirada desde lejos.
4. **El domiciliario.** Lleva pedidos y trae efectivo que después liquida
   con la caja.
5. **El supervisor.** Autoriza con su PIN lo que se sale de la regla:
   anular un plato ya enviado, descuentos por encima del tope, cortesías,
   retiros.
6. **El dueño o el administrador.** Casi nunca está en el salón. Entra desde
   el celular o el computador para saber cómo va el día, qué requiere
   atención, cuánto se vendió, si la caja cuadró, qué le debe a
   proveedores, cuánto le cuesta cada plato, si está perdiendo inventario,
   cuánto paga de nómina y si el mes da para el punto de equilibrio. No es
   contador ni programador.

**Dos identidades conviven en el mismo dispositivo.** La tablet del salón
se activa una sola vez con el PIN de la sede. Después cada persona se
identifica con un PIN corto de 4 dígitos, y su sesión dura minutos: el
dispositivo pasa de mano en mano muchas veces por turno.

## Lo que el sistema hace hoy

Todo esto funciona, con datos reales. El diseño lo reorganiza, no lo inventa.

**Punto de venta (tablet del salón)**

- Activar el dispositivo, elegir quién opera y teclear el PIN.
- Mapa de mesas por zona: libre u ocupada, comensales, tiempo y total.
- La comanda: carta por categorías, modificadores y combos del día,
  platos agotados, cursos, notas, enviar a cocina por rondas, anular con
  motivo, descuentos, cortesías.
- Canales de venta: mesa, mostrador, para llevar, domicilio propio y
  plataformas como Rappi. Cada canal puede tener precio propio.
- Cobro: propina sugerida que se pregunta siempre, pago mixto, cuenta
  dividida (partes iguales o por ítems), cliente que pide factura
  electrónica (captura cédula o NIT), impresión del documento.
- El turno: apertura contando billetes y monedas, entradas y salidas del
  personal, retiros, relevo de cajero, arqueo sorpresa, gastos menores y
  cierre en tres pasos (contar, revisar la diferencia, confirmar con causa).
- La cocina (KDS): rondas por estación, semáforo de tiempo, marcar listo,
  cola de impresión.
- Producción de preparaciones en lote, y registro de mermas.

**Administración (el dueño)**

- **Hoy:** ventas del día, comandas abiertas y una lista de lo que
  «requiere tu atención»: turno sin abrir, insumos en negativo, lotes
  vencidos, cuentas por pagar vencidas, diferencias de caja, rachas,
  mermas fuera de lo normal.
- **Ventas:** por día, turno, medio de pago, canal, empleado, hora o zona;
  el informe para el contador; los agotados.
- **Pedidos:** el historial de comandas.
- **Carta:** productos, categorías, modificadores, combos, menú del día y
  la **ficha técnica** de cada plato con su costo teórico.
- **Preparaciones:** recetas intermedias, por lote o explotadas en insumos.
- **Inventario:** insumos con rendimiento, stock teórico, lotes con
  vencimiento, movimientos, mermas, conteos (rápido de críticos o
  completo), varianza y salud del control.
- **Compras:** proveedores, recepciones con factura, lote y vencimiento,
  cuentas por pagar con aprobación y pagos.
- **Dinero:** turnos, diferencias y retiros. **Banco:** lo que falta
  consignar, las consignaciones, la conciliación del datáfono y de las
  plataformas, el libro del banco y la «mano del dueño».
- **Gastos:** gastos y obligaciones (arriendo, servicios, impuestos), la
  utilidad y el punto de equilibrio.
- **Nómina y propinas:** horas ordinarias, nocturnas, dominicales y extra;
  tarifas, recargos, festivos y liquidaciones; reparto de propinas.
- **Lo fiscal:** documentos electrónicos ante la DIAN y su estado, rangos
  de numeración, notas crédito, débito y de ajuste, devoluciones pendientes.
- **Personal:** autorizaciones por autorizador y actividad por persona.
  **Clientes:** datos para la factura y consentimientos.
- **Analítica:** ingeniería de menú, varianza por plato, salud sostenida y
  reposición sugerida.
- **Configuración:** organización y sedes, caja, ventas, canales y
  plataformas, zonas y mesas, empleados y PIN, inventario, UVT, funciones
  habilitables por plan y por sede, auditoría y notificaciones.

## Reglas que el diseño no puede romper

Son del negocio, no de estilo:

- **El operador nunca ve costos ni márgenes.** Ni el mesero ni la cajera:
  sólo el administrador.
- **El cierre de caja es a ciegas.** La cajera no ve el esperado antes de
  contar; la diferencia aparece después, y si hay una, el sistema le pide
  la causa.
- **«Sin dato» no es cero.** Un indicador sin información suficiente se
  muestra como que no hay dato y dice por qué, nunca como $0.
- **Nada de plata ni de inventario se borra:** se anula con motivo, y queda
  auditado quién lo hizo y quién lo autorizó.
- **La propina va aparte** de la venta y del impuesto, siempre.
- **Lo que se sale de la regla pide el PIN de otra persona**, y el diseño
  tiene que hacer obvio a quién pedírselo.
- **Todo en español de Colombia,** en pesos sin decimales. Los mensajes le
  dicen a un dueño de restaurante qué hacer y en qué pantalla, nunca un
  código técnico.
- **Funciones opcionales:** unas 45 capacidades se prenden o apagan por plan
  y por sede. Una pantalla apagada no aparece; el diseño tiene que funcionar
  igual para un local chico con cinco funciones que para uno con todas.
- **Accesible:** objetivos táctiles grandes en el salón y en la cocina,
  navegable con teclado en el admin, y legible para quien no ve bien.

## Momentos críticos

Diseñá pensando primero en estos:

1. **Viernes 1:00 p. m., salón lleno:** diez mesas abiertas, dos meseros y
   una cajera. Tomar un pedido de cuatro platos con modificadores y enviarlo
   a cocina tiene que llevar segundos.
2. **Cobrar una mesa de seis que divide la cuenta:** dos pagan con
   datáfono, uno con Nequi, tres en efectivo, y uno pide factura a nombre de
   su empresa.
3. **La cocina con doce platos en espera:** saber de un vistazo cuál está
   atrasado y de qué mesa es.
4. **El cierre a las 10:30 p. m.:** una cajera cansada cuenta billetes y el
   sistema le dice que faltan $18.000.
5. **El dueño, un domingo en el celular:** en menos de un minuto quiere
   saber si la semana fue buena, si algo requiere su atención y si le están
   robando inventario.
6. **Lunes de compras:** recibir cinco proveedores, cada uno con factura,
   lotes y vencimientos, y aprobar lo que se debe.

## Qué te pido

1. Una **dirección de experiencia** para dos mundos que conviven: el salón
   y la cocina (operación rápida, táctil, en condiciones difíciles) y la
   administración (lectura, análisis y control). Tienen que sentirse del
   mismo sistema sin ser la misma pantalla.
2. La **arquitectura de navegación** de cada mundo, con criterio para
   agrupar las secciones del admin, que hoy son más de veinte.
3. **Propuestas de pantalla** para los seis momentos críticos, con sus
   estados: vacío, cargando, error, sin permiso, función apagada y dato
   faltante.
4. Un **sistema de diseño** propio: componentes, patrones para tablas
   densas de plata, formularios de conteo, teclados de PIN y confirmaciones
   que mueven dinero.
5. Tus **razones**: por qué cada decisión le sirve a la persona que está
   usando la pantalla en ese momento.
