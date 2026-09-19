# Fase 2c — Canales y cocina

Quinto pedido al orquestador. Construye sobre 1a, 1b, 2a y 2b. Depende de
`docs/SPEC-NEGOCIO.md` (v0.4) y de `AGENTS.md`. Si algo de acá contradice a la spec
de negocio, manda la spec de negocio y se corrige acá.

## Por qué existe este pedido

§14 pone tres cosas en la fila de la **fase 2** que 2a y 2b excluyeron a
propósito, porque no tienen nada que ver con costo ni inventario y meterlas
habría roto el territorio disjunto: **domicilio propio, plataformas y KDS**. Son
las últimas capacidades de la fase 2 sin construir, y son las que separan a un
restaurante que sólo atiende en el salón de uno que vende por todos lados.

## Alcance

**Entra**

- **Precio por canal** (§4.3): obligatorio en mesa; para llevar, domicilio y
  plataforma son opcionales y **caen al precio de mesa** cuando no se fijan. Hoy
  no existe: el catálogo tiene un solo precio.
- **Domicilio propio** (`pos.delivery`, requiere `pos.takeout`), §3.3: dirección,
  teléfono, domiciliario, **el cargo de domicilio como LÍNEA de la comanda** (y
  por lo tanto con impuesto), cobro `pending` hasta que el domiciliario liquida, y
  **el efectivo de domicilios se arquea aparte**.
- **Plataformas** (`pos.platforms`), §3.3: `source`, `external_id`, precio del
  canal plataforma, medio de pago `platform` que **NO entra al cajón** (es una
  cuenta por cobrar), porcentaje de comisión por plataforma, y **la cancelación
  después de preparar es una venta compensada, no una merma**.
- **Curso y «marchar»** (`pos.courses`, requiere `kitchen.view`), §3.3: `fired_at`
  por curso, para servicio por tiempos.
- **KDS** (`kitchen.kds`, requiere `kitchen.view`), §9.2: «bump» por ítem,
  expedición de la comanda completa e impresión por estación.
- La configuración que todo esto necesita en **Configuración** (§9.3): canales
  activos, **plataformas y comisiones**, estaciones, cursos y tiempos objetivo.

**No entra**

- **La conexión real con el proveedor tecnológico.** §14 la pone en esta fila
  («si no se hizo en 1b»), pero **no es un problema técnico y no se puede cerrar
  acá**: `app/fiscal/provider.py` ya deja el adaptador listo —agregar un proveedor
  real es escribir una tercera clase y cambiar `get_provider`— y su propio
  docstring nombra el bloqueo: *el dueño todavía no eligió un proveedor
  tecnológico*. Hace falta elegirlo (Siigo, Alegra, Dataico…), contratarlo, y
  tener certificado digital y habilitación ante la DIAN. Construir el XML UBL a
  ciegas produciría algo que **parece** correcto y la DIAN rechaza, y nadie podría
  verificarlo acá: es exactamente el error de la migración que «pasaba» en SQLite
  y no corría contra Postgres. **Queda como decisión comercial, no como deuda
  técnica.**
- Integración por API con plataformas (§13: fase 3). Acá los pedidos de
  plataforma **se cargan a mano** en el POS, con su `external_id`.
- Impresora térmica real y cajón monedero (§13).
- Varias comandas por mesa (§13).

## Convenciones de ingeniería

Las de 1a, 1b, 2a y 2b, más:

- **El cargo de domicilio es una línea de la comanda, no un campo.** Va al
  documento fiscal como línea, **lleva impuesto** (§4.3: bajo INC todo el consumo
  es INC 8 %, incluidas bebidas y domicilio, art. 512-1 y 512-9 ET), y entra en
  los totales por el mismo camino que cualquier otro ítem. Si se modelara como un
  campo aparte, habría que sumarlo a mano en cada total: dos matemáticas.
- **El pago por plataforma no toca el cajón.** `compute_breakdown`
  (`app/shifts/service.py`) calcula el efectivo esperado del turno; una venta
  cobrada por plataforma **no puede moverlo**. Es una cuenta por cobrar contra la
  plataforma, y su conciliación es fase 3. Hay que probarlo con un test que abra
  un turno, venda por plataforma y verifique que el esperado **no cambió**.
- **El efectivo de domicilios se arquea aparte** (§3.3). No es el mismo bolsillo
  que el cajón del salón hasta que el domiciliario liquida.
- **Cancelar una venta de plataforma después de preparar NO es una merma.** El
  insumo ya se descontó y se queda descontado; lo que se compensa es la VENTA.
  Confundirlo metería en el reporte de mermas algo que no lo es y falsearía el
  KPI de mermas ÷ compras que 2b acaba de construir.
- **El precio por canal cae al de mesa.** Nunca a `0`, nunca a `null`: un producto
  sin precio de domicilio se vende al precio de mesa, y eso se decide en el
  servidor.
- Alembic arranca en `0013`.

## Invariantes heredados que 2c toca por diseño

La lección de 2a y 2b, aplicada de entrada:

1. **El esperado de caja** (`compute_breakdown`, `app/shifts/**`). Este pedido
   agrega dos medios que NO son efectivo del cajón (plataforma) y uno que llega
   tarde (domicilio pendiente de liquidar). Es el tercer pedido seguido en que
   `app/shifts/**` es territorio cruzado, y las dos veces anteriores ahí cayó un
   hallazgo. **Dueño nombrado, y el ida y vuelta escrito.**
2. **La matemática del impuesto** (`app/core/tax.py`, centralizada en 1b-2). El
   cargo de domicilio lleva impuesto; nadie puede calcularlo por su cuenta.
3. **«El operador no ve costos»**: el KDS es superficie de dispositivo. Ninguna
   respuesta del KDS puede traer costo ni margen, y los barridos del OpenAPI
   acotados en 2a tienen que seguir pasando **y cubrir las rutas nuevas**.
4. **El consumo de inventario de 2a**: un pedido de plataforma o de domicilio
   descuenta igual que una venta de mesa. Vender, regalar, comer y despachar
   dejan el inventario **idéntico**.

## Archivos huérfanos: con dueño asignado desde el arranque

- `backend/app/shifts/**` — el esperado de caja y el arqueo aparte del efectivo de
  domicilios. **Tercera vez que es territorio cruzado.**
- `backend/app/core/tax.py` — el impuesto del cargo de domicilio.
- `backend/app/seed.py` y `app/catalog/seed.py` — una plataforma con comisión, un
  pedido de domicilio y uno de plataforma; sin eso nadie puede ver el camino nuevo
  en una base sembrada.
- `backend/app/catalog/**` — el precio por canal es del catálogo, pero lo consume
  `orders`.
- `frontend/src/features/settings/**` — plataformas y comisiones, estaciones,
  cursos y tiempos objetivo son configuración de sede (§9.3).
- `frontend/src/app/router.tsx` y la navegación — el KDS es una pantalla nueva.
- `backend/tests/audit/**` — los barridos heredados.

## Verificación del pedido (checklist de entrega)

Además de la sección 16 de la spec de negocio:

- [ ] Con `pos.delivery`, `pos.platforms`, `pos.courses` y `kitchen.kds` apagadas,
      todo lo de 1b y 2 sigue **idéntico**, y las rutas nuevas responden
      `400 FEATURE_DISABLED` (test con cada flag en los dos estados, respetando
      las dependencias declaradas en el catálogo).
- [ ] **Una venta cobrada por plataforma NO mueve el efectivo esperado del
      turno** (test: abrir turno, vender por plataforma, comparar el esperado
      antes y después). Es la regla que más fácil se rompe de este pedido.
- [ ] El cargo de domicilio es una **línea** con impuesto: aparece en el
      documento fiscal como línea y entra en la base gravable (test numérico).
- [ ] El efectivo de domicilios se arquea **aparte** del cajón hasta que el
      domiciliario liquida (test sobre el desglose del turno).
- [ ] **Cancelar una venta de plataforma después de preparar compensa la VENTA y
      no genera merma** (test: el reporte de mermas no la incluye y el inventario
      NO se repone).
- [ ] Un producto sin precio de domicilio se vende al **precio de mesa**, nunca a
      `0` ni a `null` (test de los tres canales opcionales).
- [ ] La comisión de la plataforma se registra por pedido y por plataforma, y
      **no se resta de la venta**: la venta es la venta, la comisión es un costo
      (test).
- [ ] Vender por mesa, por domicilio y por plataforma deja el inventario
      **idéntico** (test que compara los tres caminos, hermano del de 2a que
      compara venta, cortesía y `staff_meal`).
- [ ] «Marchar» sella `fired_at` por curso y el KDS lo respeta en el orden (test).
- [ ] «Bump» por ítem es **idempotente** (test).
- [ ] Sesión de dispositivo: ninguna respuesta del KDS contiene `cost` ni
      `margin`, con los dominios nuevos montados.
- [ ] Zona horaria: un pedido de plataforma cargado a las 00:30 queda sellado con
      el día del turno.
- [ ] Sin `float` en comisiones ni en precios por canal.
- [ ] POS y KDS en 375 px y 1024 px sin scroll horizontal; foco visible.
- [ ] **Recorrido en navegador real antes de cerrar**: es la única forma que
      encontró siete de los defectos de la fase 2 (`docs/ESTADO.md` punto 21).
- [ ] Typecheck, suite completa y build, una vez, en serie, con el árbol quieto.
