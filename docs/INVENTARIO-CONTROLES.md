# Inventario de controles — `frontend/src`

**Para qué es este documento.** Se va a rediseñar la app. Esto es la red de
seguridad: la lista de **todo lo que cada pantalla deja hacer hoy**, con especial
atención a lo que está detrás de una condición y por lo tanto **no se ve en la
pantalla feliz**. Si un control no aparece en el diseño nuevo, tiene que ser
porque alguien decidió sacarlo, no porque nadie lo vio.

Levantado leyendo el código (`frontend/src/features/**`, `frontend/src/app/**`),
no la documentación de producto. Fecha: 2026-09-21.

## Cómo leerlo

- **36 pantallas** verificadas contra `src/app/router.tsx`. La lista del pedido
  coincide con el router; ver «Diferencias contra la lista de 36» al final.
- Para cada pantalla: ruta real, archivo, acciones, condiciones, estados y
  diálogos.
- Al final, tres listas transversales: **flags**, **autorizaciones** y
  **destructivas**.

## Reglas de producto que explican dónde está cada cosa

De `AGENTS.md` y `CLAUDE.md` del proyecto. Sirven para no "arreglar" en el
rediseño algo que está así a propósito:

1. **Toda función opcional vive detrás de su flag** (`hasFeature("clave")`). La
   entrada de navegación desaparece si la función está apagada, y la pantalla
   misma suele mostrar un vacío explicativo del tipo «Activá X en Admin →
   Funciones». Lo que es **ley o integridad** (consecutivo fiscal, notas,
   devoluciones, auditoría) **no lleva flag**: está siempre.
2. **El operador nunca ve costos ni márgenes.** Por eso Compras, Banco, Gastos,
   Nómina y Analítica no tienen ruta bajo `/pos`, y las pantallas de dispositivo
   (Producir, Merma) no pintan ni un peso de costo.
3. **El backend hace cumplir los gates; la interfaz los refleja.** Muchas
   acciones **no muestran el control de autorización hasta que el servidor lo
   pide**: se intenta la acción, el servidor responde `400`/`409` con un código
   (`PETTY_CASH_LIMIT`, `PHOTO_REQUIRED`, `AUTHORIZATION_REQUIRED`,
   `DISCOUNT_LIMIT_EXCEEDED`, `OPENING_DIFFERENCE_NEEDS_CAUSE`,
   `OPEN_ORDERS_EXIST`…) y **recién entonces aparece el PIN, la foto, la causa o
   la casilla**. Son controles que sólo existen en el camino de error: los más
   fáciles de perder de todos.
4. **Una sola matemática, en el backend.** La UI pinta lo que llega; `null` no
   es `0` (se muestra «—»).

---

# Parte 1 — Tablet del salón (`/pos`, layout `src/app/PosLayout.tsx`)

## Chrome común del salón — `src/app/PosLayout.tsx`

Presente en **las 10 pantallas que cuelgan de `/pos`** (no en Activar ni en
Identificar, que son de pantalla completa).

| Acción | Qué hace | Condición |
|---|---|---|
| Sondeo de sesión cada 5 s | Repregunta `GET /auth/me`; detecta el vencimiento de la persona | siempre |
| Aviso «Tu sesión de persona venció por inactividad» | `role="alert"` en la barra superior | sólo si `employee_expires_at` ya pasó |
| **Cambiar de persona** | Libera a la persona (`deviceRelease`) y va a `/pos/identify`; el dispositivo sigue activado | siempre |
| **Desactivar este dispositivo** | Desactiva la tablet entera; para volver hace falta el **PIN de sede** | siempre, **detrás de `AlertDialog` de confirmación** |
| Barra de estado del turno | `ShiftStatusStrip` (ver abajo) | siempre |
| Barra de navegación | Mesas / Comanda / Cocina / Turno / Producir / Merma / KDS | **cada entrada filtrada por su flag**; si no queda ninguna, la barra **no se dibuja** |

**Navegación del salón y sus flags** (`buildPosNav`): Mesas (`pos.tables`),
Comanda (sin flag, siempre), Cocina (`kitchen.view`), Turno (sin flag),
Producir (`catalog.preps`), Merma (`inventory.waste`), KDS (`kitchen.kds`).

**`ShiftStatusStrip`** (`features/shifts/ShiftStatusStrip.tsx`), sondea
`GET /shifts/current` cada 5 s:

- Cargando: «Consultando el turno…». Error: aviso «No se pudo consultar el turno».
- **Sin turno abierto** → texto rojo + **enlace «Abrir turno →»** a `/pos/turno`.
  *Este enlace es la única llamada a la acción cuando no se puede vender.*
- Con turno: día operativo, responsable, y dos avisos condicionales:
  **«Turno abandonado (pasó la hora de corte)»** (`is_stale`) y **«Efectivo por
  encima del umbral de retiro»** (`cash_over_threshold`).

**Ruta índice `/pos`** — `src/app/PosHome.tsx`: no dibuja nada, **redirige** a
`/pos/mesas` si `pos.tables` está encendida, si no a `/pos/comanda/nueva`.
En un rediseño esto es una decisión de arranque fácil de perder.

---

## 1. Activar dispositivo — `/pos/activate` — `features/auth/DeviceActivatePage.tsx`

Pantalla completa, sin layout. Se hace **una vez por tablet**.

| Acción | Qué hace |
|---|---|
| Campo «Número de sede» | Number, obligatorio. Con texto de ayuda que aclara que **no** es el PIN |
| **PinPad de 6 dígitos** «PIN de sede» | Al completar el sexto dígito **envía solo** (`deviceActivate`) y navega a `/pos/identify` |
| Borrar último dígito | Botón del PinPad |
| Teclado físico | Dígitos y Backspace operan el PinPad (salvo si el foco está en un input) |

- **Condición:** el PinPad está **deshabilitado** hasta que el número de sede es un entero > 0.
- **Estados:** error del servidor bajo el PinPad; `submitting` deshabilita todo.
- **Gap documentado en el código:** no hay ruta pública para listar sedes, por eso se pide el número a mano en vez de un selector.

## 2. Identificar persona — `/pos/identify` — `features/auth/DeviceIdentifyPage.tsx`

| Acción | Qué hace |
|---|---|
| **EmployeePicker** «Quién opera» | Elegir la persona en un toque (`GET /device/employees`) |
| **PinPad de 4 dígitos** «PIN personal» | Auto-envía al cuarto dígito (`deviceIdentify`) y navega a `/pos` |

- **Condición:** PinPad deshabilitado hasta elegir persona.
- **Estados:** el subtítulo cambia según haya persona elegida; errores del servidor (`PIN_LOCKED`) se muestran **tal cual llegan**.

## 3. Mesas — `/pos/mesas` — `features/orders/TablesPage.tsx`

| Acción | Qué hace | Condición |
|---|---|---|
| Tocar mesa **libre** | Abre diálogo «Abrir mesa N» | modo normal |
| Tocar mesa **ocupada / por cobrar** | Navega a `/pos/comanda/{order_id}` | modo normal |
| **Unir mesas** (toggle) | Entra en modo selección múltiple de mesas ocupadas | siempre |
| **Mover mesa** (toggle) | Modo: primero la mesa origen, después una o más libres de destino | siempre |
| **Continuar** (en modo unir) | Abre el diálogo de mesa destino | sólo con ≥ 2 mesas seleccionadas |
| **Confirmar traslado** (en modo mover) | `moveOrder` | sólo con ≥ 2 seleccionadas (origen + destino) |
| **Cancelar** | Sale del modo y limpia la selección | sólo en modo unir/mover |

**Diálogos**
- *Abrir mesa N*: campo «Comensales» (precargado con los puestos de la mesa) → **Abrir mesa** (`createOrder` canal `dine_in`) y navega a la comanda.
- *¿Cuál mesa queda como destino?*: select de mesa destino → **Unir mesas** (`mergeOrders` en cadena, una por mesa origen).
- **`AuthorizerDialog`** — PIN de supervisor/administrador: aparece **sólo si el servidor responde que la comanda ya tiene cuenta presentada** (`BILL_PRESENTED_NEEDS_AUTH`). Motivo mostrado: «La comanda ya tiene cuenta presentada: unir o mover mesas necesita autorización.»

- **Sin permiso / función apagada:** sin `pos.tables` la pantalla entera se reemplaza por «Las mesas no están habilitadas · Activá «Mesas» en Admin → Funciones».
- **Estados:** cargando («Cargando mesas…»), vacío («Esta sede todavía no tiene zonas ni mesas activas»), error de acción como texto `role="alert"`.
- Cada mesa muestra estado (Libre / Ocupada / Por cobrar), comensales, tiempo transcurrido y total.

## 4. Comanda nueva — `/pos/comanda/nueva` — `features/orders/NewOrderPage.tsx`

**Selector de canal** — un botón por canal, y **cada uno detrás de su flag**:

| Canal | Flag |
|---|---|
| Mostrador | `pos.counter` |
| Mesa | `pos.tables` (no crea nada: **navega a `/pos/mesas`**) |
| Para llevar | `pos.takeout` |
| Domicilio | `pos.delivery` |
| Plataforma | `pos.platforms` |
| Consumo de personal | `pos.staff_meal` |

**Campos que aparecen según el canal elegido** (todos condicionales):
- *Para llevar*: nombre del cliente (obligatorio), teléfono, **hora prometida** (`datetime-local`).
- *Domicilio*: dirección y teléfono (obligatorios), **EmployeePicker «Domiciliario»** (obligatorio); nota informativa de que el cargo de domicilio se agrega solo.
- *Plataforma*: select de plataforma (carga `GET /device/platforms`), número de pedido externo (obligatorio).
- *Consumo de personal*: **EmployeePicker «¿Quién consume?»** (obligatorio).
- Siempre: **Nota** (textarea) → **Crear comanda**, que navega a la comanda.

- **Vacío global:** si **ningún** canal está habilitado, toda la pantalla es un `EmptyState` que enumera los seis canales a activar.
- **Estados del select de plataformas:** cargando / error con **botón Reintentar** / «Esta sede no tiene plataformas activas».

## 5. Comanda — `/pos/comanda/:orderId` — `features/orders/OrderPage.tsx`

La pantalla con más controles del salón.

**Agregar a la comanda** — `CatalogPanel` (sólo si la comanda está `open` o `to_pay`):

| Acción | Condición |
|---|---|
| Buscar en la carta (campo) | siempre |
| Pestaña **Menú del día** | `pos.daily_menu` **y** al menos un combo activo ahora; si está, es la pestaña por defecto |
| Pestaña **Favoritos** | siempre (armados con lo más vendido de 7 días) |
| Una pestaña por categoría | siempre |
| Tocar producto / combo | Abre `ItemDialog`; **deshabilitado si el producto no está disponible o el combo está fuera de horario** |
| Badge «Quedan N» | `pos.daily_count` |

**`ItemDialog`** (agregar ítem):
- Cantidad − / + (mínimo 1).
- **Grupos de modificadores** con mín/máx y obligatoriedad — sólo con `pos.modifiers`; opciones agotadas deshabilitadas, delta de precio por opción.
- **Grupos de combo** (una opción por grupo, radio) — sólo con `pos.combos`.
- **Asiento** — sólo con `pos.seats`.
- **Curso** (select) — sólo con `pos.courses`; precargado con el curso por defecto del producto.
- Nota (textarea) → **Agregar a la comanda**.

**Lista de ítems** — `OrderItemsList`, por ítem:

| Acción | Condición |
|---|---|
| **− / + cantidad** | **sólo si el ítem está `pending`** (no enviado). Enviado, la cantidad es texto |
| **Anular** (ítem) | sólo si no está ya anulado |
| **Cortesía** | `pos.courtesies` **y** no anulado **y** no ya cortesía |
| **Descuento** (ítem) | `pos.discounts` **y** no anulado |

**Marchar cursos** — sección entera sólo con `pos.courses` y si hay cursos en la comanda. Un botón **«Marchar {curso}»** por curso no marchado; el marchado se vuelve un badge con la hora.

**Totales** — y **«Descuento de la comanda»**, sólo con `pos.discounts` y comanda abierta.

**Barra fija inferior** (sólo si la comanda está `open`/`to_pay`):

| Botón | Qué hace | Condición |
|---|---|---|
| **Anular comanda** | Abre `VoidDialog` de comanda completa | siempre (comanda abierta) |
| **Enviar (N)** | Manda a cocina los N ítems pendientes | `kitchen.view`; deshabilitado si N = 0 |
| **Presentar cuenta** | `presentBill` y abre la precuenta | `pos.pre_bill` |
| **Cobrar / Cuenta · Cobrar** | Navega a `/pos/cobro/:orderId`. El rótulo cambia: «Cobrar» en mostrador, «Cuenta / Cobrar» en el resto | siempre |

**Diálogos de esta pantalla**
- **`VoidDialog`** (anular ítem o comanda): select de **motivo tipado**, nota **obligatoria si el motivo es «otro»**, botón destructivo **Anular**.
- **`CourtesyDialog`** (`pos.courtesies`): motivo tipado + nota + **PinPad de autorizador obligatorio** (el PIN no es opcional acá: lo exige el backend).
- **`DiscountDialog`** (`pos.discounts`): tipo Porcentaje / Monto fijo, valor (**entero**, rechaza decimales con un mensaje explícito), motivo tipado, nota → **Aplicar descuento**.
- **`PreBillDialog`** (`pos.pre_bill`): la precuenta con su leyenda del servidor, líneas, totales, propina sugerida, contador de impresiones, y **«Volver a imprimir»**.
- **`AuthorizerDialog`**: PIN de supervisor/admin, **aparece sólo cuando el servidor responde `AUTHORIZATION_REQUIRED`, `DISCOUNT_LIMIT_EXCEEDED` o `BILL_PRESENTED_NEEDS_AUTH`** y reintenta la misma acción.

- **Estados:** comanda inválida, cargando, «No se pudo cargar la comanda», lista de ítems vacía («Todavía no hay ítems en esta comanda»), conflicto de versión (`STALE_VERSION`) que recarga la comanda y avisa.
- **Badges informativos:** estado de la comanda y **«Cuenta presentada · {hora}»**.

## 6. Cocina — `/pos/cocina` — `features/orders/KitchenPage.tsx`

Vista de cocina mínima (`kitchen.view`).

| Acción | Qué hace | Condición |
|---|---|---|
| **Todas** / botón por estación | Filtra las rondas por estación | las estaciones se descubren de los datos |
| **Listo** (por ítem) | `markReady` | sólo si el ítem no está ya `ready`; si lo está, se ve «Listo» sin botón |

- **Sin función:** `EmptyState` «La vista de cocina no está habilitada · Activá «Cocina» (kitchen.view)».
- **Estados:** cargando, vacío («No hay rondas pendientes»), error por ítem debajo del botón.
- Semáforo por ítem (A tiempo / Por vencer / Demorado) con el tiempo transcurrido — **el texto acompaña al color siempre**.

## 7. KDS — `/pos/kds` — `features/kitchen/KdsPage.tsx`

KDS completo (`kitchen.kds`). **Dos pestañas.**

**Filtro de estación** (igual que Cocina): «Todas» + una por estación.

**Pestaña «Cocina»** — tarjetas agrupadas **por comanda** (no por ronda):

| Acción | Qué hace | Condición |
|---|---|---|
| **Bump** (por ítem) | Marca el ítem listo | si el ítem no está `ready` |
| **Deshacer** (por ítem) | Revierte el bump | **sólo si el ítem está `ready`** — el botón cambia de rótulo |
| **Expedir comanda** | Bumpea de un golpe **todos** los ítems enviados de la comanda entera, en todas sus rondas | deshabilitado si no hay ítems `sent` |

**Pestaña «Impresión por estación»**:

| Acción | Qué hace | Condición |
|---|---|---|
| **Confirmar impresión** / **Reimprimir** | **Registra** que la estación imprimió (no manda nada a una impresora física) | el rótulo cambia a «Reimprimir» si ya estaba registrada |

- **Sin función:** `EmptyState` que nombra el flag `kitchen.kds`.
- **Estados por pestaña:** cargando, **error con botón «Reintentar»**, vacío («No hay rondas pendientes» / «Nada para imprimir»).
- Badge **«Marchado»** por ítem si su curso fue marchado; «Bumpeado por {persona}» en los ya listos.

## 8. Cobro — `/pos/cobro/:orderId` — `features/payments/CheckoutPage.tsx`

| Acción | Qué hace | Condición |
|---|---|---|
| Presentación automática de la cuenta | Al entrar, presenta la cuenta **una sola vez** y muestra líneas + leyenda del servidor | `pos.pre_bill` |
| **Cobrar todo junto / Partes iguales / Por ítems** | Modo de división | `pos.split_bill` |
| **Calcular partes** | Pide N partes (mín. 2) y pinta el monto por parte | modo «Partes iguales» |
| Campos «Cuenta 1..N» + **Agregar cuenta** | Rotula las sub-cuentas | modo «Por ítems» |
| Select de cuenta por ítem | Asigna cada ítem a una sub-cuenta | modo «Por ítems» |
| **Dividir cuenta** | Crea las sub-cuentas | deshabilitado mientras queden ítems sin asignar |
| **Cobrar** (por sub-cuenta) | Elige esa sub-cuenta como blanco del cobro | sólo en sub-cuentas no cobradas |
| **Ver comprobante** | Va al documento | sólo si la comanda ya estaba pagada |
| **Ver el último comprobante** | `getLastDocument` y navega | sólo tras el error `ORDER_ALREADY_PAID` |

**Pregunta de propina** — `TipQuestion`, sólo con `pos.tips` y si el blanco trae
información de propina. **Bloquea el cobro hasta responderla.**

| Acción | Qué hace |
|---|---|
| **Sí, {monto}** | Acepta el sugerido |
| **Modificar monto** | Abre un campo de monto → **Confirmar** / **Cancelar** |
| **No** | Propina 0, registrada como preguntada |

**Tabla de pagos** — `PaymentSplitsForm`:

| Acción | Qué hace | Condición |
|---|---|---|
| **Agregar pago** | Fila nueva precargada con lo que falta | siempre |
| Select «Medio» | **Sólo los medios habilitados en la sede** (`GET /device/payment-methods`) | |
| Campo «Monto» | La primera fila viene precargada con el total; deja de seguirlo al editarla | |
| **Quitar** (por fila) | Borra esa fila de pago | |
| Campo «Recibido» | | **sólo en filas de efectivo** |
| **Botones +$1.000 … +$100.000** | Suman denominaciones al recibido | sólo en efectivo |
| **Limpiar** | Vacía el recibido | sólo en efectivo |
| Campo «Referencia» | | **sólo si el medio lo exige (`requires_reference`)** |
| **PinPad «PIN propio para cobrar»** | Cobra al cuarto dígito | **deshabilitado hasta que los pagos sumen exacto** |

- Guía en vivo: «Faltan $X» / «Sobran $X» / «Completo».
- **Estados especiales de la pantalla:** comanda inválida, cargando, error con Reintentar, **«Esta comanda ya fue cobrada»**, **«Esta comanda no está disponible para cobro»** (anulada o fusionada), y el aviso rojo de ya-cobrada.
- **Estados de la tabla de pagos:** cargando medios, error con Reintentar, **«Esta sede no tiene medios de pago habilitados»** (y entonces no se puede cobrar).
- Si el total no llegó del servidor: **no se ofrece cobrar**, se muestra un error explícito.

## 9. Documento — `/pos/documento/:documentId` — `features/payments/DocumentPage.tsx`

| Acción | Qué hace | Condición |
|---|---|---|
| **Volver** | A Mesas o a Comanda nueva **según `pos.tables`** | siempre |
| **Reimprimir** | Cuenta la reimpresión en el servidor (`reprint_count`) | siempre |
| **Imprimir** | `window.print()` con la hoja de 80 mm | siempre |
| Enlace del **QR DIAN** | Abre la URL del QR en otra pestaña | sólo si el documento trae `qr_url` |

- **Badges condicionales:** estado DIAN (validado / rechazado / otro) y **«Contingencia»**.
- Bloque fiscal (estado DIAN, CUDE, QR) sólo si alguno de los tres llegó.
- **Estados:** comprobante inválido, cargando, error con Reintentar, error de reimpresión.
- Todo el chrome de botones es `print:hidden`.

## 10. Turno — `/pos/turno` — `features/shifts/ShiftPage.tsx`

**Dos pantallas en una.** Sin turno abierto, es un formulario; con turno abierto,
un panel de pestañas.

### 10.a Sin turno abierto — `OpenShiftForm`

| Acción | Condición |
|---|---|
| **Base contada por denominaciones** (una fila por billete/moneda) | siempre |
| Campo **«Reserva de caja»** | **`cash.reserve`** |
| **EmployeePicker «Responsable de caja»** | siempre; por defecto quien opera |
| **Abrir turno** | siempre |
| Select **«Causa»** + nota | **aparece sólo si el servidor responde `OPENING_DIFFERENCE_NEEDS_CAUSE`** (la base contada no coincide con la fija) |

### 10.b Con turno abierto — pestañas

| Pestaña | Condición |
|---|---|
| Resumen | siempre |
| Movimientos | siempre |
| Cambio | `cash.swaps` |
| Retiros | `cash.pickups` |
| Domicilios | `pos.delivery` |
| Relevo | `cash.handovers` |
| Cierre | siempre (pero **cambia de formulario** según `cash.blind_close`) |

**Resumen** (`ShiftSummaryPanel`): día operativo, apertura, responsable, esperado,
base fija, **reserva aparte**, y **«Efectivo de domicilios pendiente de liquidar»**
sólo con `pos.delivery`. Incluye el **roster**:

- `RosterPanel`: EmployeePicker «Persona» + select de **acción** (Entrada / Salida / Inicio de pausa / Fin de pausa) + **PinPad de la propia persona** (deshabilitado hasta elegir persona). Tabla del roster; vacío: «Todavía no entró nadie a este turno».

**Movimientos** (`MovementsPanel`): tipo Ingreso/Egreso, **causa tipada** (el
desplegable **excluye las causas que sólo genera el sistema**, como «Liquidación
de domicilios»), monto, nota, **foto del comprobante (opcional)** → **Registrar
movimiento**. Tabla con hora, tipo, causa, monto, persona y **quién autorizó**.
- **Condicional clave:** si el egreso supera el límite de caja menor el servidor responde `PETTY_CASH_LIMIT` y **aparece un PinPad de administrador** que reemplaza al botón de enviar.

**Cambio** (`cash.swaps`): dos rejillas de denominaciones, «Sale (se entrega)» y
«Entra (se recibe)» → **Registrar cambio**. Canje neto cero, no mueve el esperado.

**Retiros** (`cash.pickups`): monto, número de sobre, nota, **foto**.
- **PinPad de administrador** que aparece **sólo cuando el monto es > 0**.
- Si el servidor responde `PHOTO_REQUIRED`, la foto **pasa a obligatoria**.
- Tabla de retiros con «Esperado al retirar» (puede venir oculto si quien mira no es el responsable ni admin → «—», nunca «$0»).
- **Reversar** (por retiro, sólo si no está ya reversado): `AlertDialog` con **motivo obligatorio + PIN de administrador**.

**Domicilios** (`pos.delivery`): tabla por domiciliario con cobros, efectivo,
propina y total.
- **Liquidar** (por domiciliario): `AlertDialog` con nota opcional. **Sin PIN** — se atribuye a la persona identificada.
- **Deshacer** (por liquidación): `AlertDialog` con **motivo obligatorio**. **Sólo disponible sobre las liquidaciones hechas en esta misma sesión del navegador** (gap declarado: no hay histórico consultable desde el POS).
- Estados: cargando, error con Reintentar, «No hay efectivo de domicilios pendiente de liquidar».

**Relevo** (`cash.handovers`): sub-pestañas **Relevo** y **Arqueo sorpresa**.
- Comunes: efectivo contado por denominaciones, datáfono contado, transferencias contadas, **foto opcional**.
- *Relevo*: **EmployeePicker «Nuevo responsable»** (excluye al responsable actual), campo **«PIN de autorización (opcional)»** y botón **Registrar relevo**.
- *Arqueo sorpresa*: **PinPad de administrador obligatorio**; no cambia al responsable.
- Muestra el **desglose congelado** del último movimiento y la lista histórica; el desglose puede venir `null` (no autorizado) y entonces **no se dibuja**.

**Cierre** — **dos formularios distintos según el flag `cash.blind_close`**:

*Con `cash.blind_close`* → **`CloseWizard`, tres pasos**:
1. Efectivo contado por denominaciones, datáfono, transferencias, **propinas en efectivo retiradas** (con una referencia de sólo lectura de lo que el sistema calcula), **foto** (obligatoria si el servidor lo exige) → **Continuar**. *El esperado no se muestra ni se pide en este paso.*
2. Revela **esperado y diferencia**, la ecuación (base, ventas efectivo, ingresos, egresos, retiros), datáfono y transferencias contados vs. registrados, y el aviso **«Diferencia crítica: se va a notificar al administrador»** → **Continuar**.
3. Select de **causa** + nota — **sólo si el servidor marca `requires_cause`**; si además marca `requires_identified_cause`, **la opción «Sin identificar» desaparece del desplegable**. Casilla **«Trasladar al turno siguiente las N comandas abiertas»** — **sólo si hay comandas abiertas**. Casilla **«Este cierre también cierra el día operativo»** (precargada con lo que sugiere el servidor) → **Confirmar cierre** (deshabilitado si falta la causa exigida).
- Si la diferencia cambió entre el paso 2 y el 3 (`DIFFERENCE_CHANGED`), **vuelve al paso 2** con la revisión nueva.
- Pantalla final: «Turno cerrado», **a consignar**, y si cerró o no el día operativo.

*Sin `cash.blind_close`* → **`SingleStepCloseForm`**: todo en un formulario
(conteo, datáfono, transferencias, propinas, foto, causa, nota, «cierra el día»)
→ **Cerrar turno**. La casilla **«Trasladar comandas abiertas» aparece sólo
después** de que el servidor responde `OPEN_ORDERS_EXIST`. Si la sede encendió
el cierre a ciegas mientras la tablet tenía flags viejos, el servidor responde
`BLIND_CLOSE_REQUIRED` y la pantalla **refresca la sesión y cambia sola al
asistente de tres pasos**.

## 11. Producir — `/pos/produccion` — `features/recipes/QuickProductionPage.tsx`

Producción en **dos toques**. Ruta de dispositivo: **no pinta costo ni margen**.

| Acción | Qué hace | Condición |
|---|---|---|
| Tocar una preparación | Toque 1: la selecciona y precarga la cantidad con el rendimiento estándar | **sólo se listan las preparaciones en modo «lote»**; las «explotadas» no aparecen |
| **← Elegir otra** | Vuelve a la grilla | con una preparación elegida |
| Campo «Cantidad real obtenida» | Editable; precargado | |
| **PinPad** «Tu PIN para confirmar la producción» | Toque 2: produce al cuarto dígito | **deshabilitado mientras el campo de cantidad tiene el foco** o está vacío |

- Aviso de varianza: si el real se aparta más de 15 % del esperado, se produce igual pero con un **toast de advertencia**.
- **Sin función:** `EmptyState` que nombra «Preparaciones en dos modos» (`catalog.preps`).
- **Estados:** esqueletos de carga, **error con Reintentar**, vacío («No hay preparaciones en modo lote», con la explicación de por qué).

## 12. Merma — `/pos/merma` — `features/inventory/WastePage.tsx`

Ruta de dispositivo: **sin costo ni margen**.

| Acción | Qué hace |
|---|---|
| Select «Qué se perdió» | Un insumo / Una preparación (cambia la lista de abajo) |
| Select del insumo o preparación | |
| Campo «Cantidad» | |
| Select «Tipo» | Motivo tipado de merma |
| Nota (textarea) | |
| **Foto (opcional)** | `PhotoCaptureField` |
| **PinPad** «Tu PIN para confirmar la merma» | Registra al cuarto dígito |

- **Condición:** el PinPad está **deshabilitado hasta que hay objetivo, cantidad y tipo**.
- **Sin función:** `EmptyState` que nombra «Registro de mermas» (`inventory.waste`).
- **Estados:** esqueletos, error con Reintentar, aviso «No hay insumos activos» / «No hay preparaciones activas» bajo el select.
- La pantalla aclara explícitamente que **el consumo de personal no es una merma** (va por comanda `staff_meal`).

---

# Parte 2 — Escritorio del dueño (`/admin`, layout `src/app/AdminLayout.tsx`)

## Chrome común del admin — `src/app/AdminLayout.tsx`

| Acción | Qué hace | Condición |
|---|---|---|
| Barra lateral de navegación | Una entrada por sección | **cada entrada filtrada por su flag** (ver la lista transversal) |
| **Botón de menú (hamburguesa)** | Abre la navegación en un **`Sheet` lateral** | **sólo en ancho de teléfono/tablet (`md:hidden`)** — en escritorio la barra está fija |
| **Selector de sede** (`StoreSwitcher`) | Cambia la sede activa de todo el admin | **sólo con `multi_store` encendida Y más de una sede**; si no, no se dibuja |
| **Campana de notificaciones** | Ver abajo, pantalla 34 | siempre |
| **Cambiar tema** (`ThemeToggle`) | Claro / oscuro | siempre |
| **Salir** | Cierra sesión (`logout`) y vuelve a `/login` | siempre |

**Ruta índice `/admin`** → redirige a **`/admin/hoy`**.

**La sede activa es una precondición de casi toda pantalla del admin**: mientras
carga se ve «Cargando sedes…», y si no hay ninguna, «Todavía no hay sedes
creadas» — **un estado sin permiso/sin datos que se repite en Hoy, Ventas,
Pedidos, Carta, Dinero e Inventario** y que un rediseño tiene que contemplar.

---

## 13. Entrar — `/login` — `features/auth/LoginPage.tsx`

| Acción | Qué hace |
|---|---|
| Campo Correo, campo Contraseña | Validados con zod: mensajes por campo (`role="alert"`) |
| **Ingresar** | `adminLogin` y navega a `/admin` (no a una pantalla fija) |
| **Enlace «Activá este dispositivo»** | Lleva a `/pos/activate` |

- Ese enlace es **la única puerta visible hacia el POS desde la raíz**: sin él, quien monta una tablet sólo ve un formulario de administrador. Fácil de perder en un rediseño y caro.
- **Estados:** errores por campo, error del servidor, botón «Ingresando…» deshabilitado.

## 14. Hoy — `/admin/hoy` — `features/reports/TodayPage.tsx`

Pantalla de entrada del admin. Refresca sola cada 30 s.

**Contenido fijo:** ventas netas del día en grande; tarjetas de Comandas pagadas,
Ticket promedio, Ticket por comensal, Comensales, **Mesas ocupadas**, **Comandas
abiertas** (con tono de aviso si hay atascadas), **Efectivo esperado** (tono
crítico y «Sin turno abierto» si no hay turno) y Propinas de hoy; gráfico de
ventas por hora; propinas por medio (**sólo si hay**); tabla de comandas abiertas.

**«Requiere tu atención» — tarjetas condicionales, y cada una es un enlace a la
pantalla que la resuelve.** Ésta es la lista completa; **ninguna se dibuja si no
aplica**, por lo que en un diseño «lleno» no se ven casi nunca:

| Tarjeta | Se dibuja cuando | Lleva a |
|---|---|---|
| Sin turno abierto | `expected_cash` es `null` | `/admin/dinero` |
| Comandas atascadas | hay sin enviar o sin cobrar de más | `/admin/pedidos` |
| N productos agotados | hay agotados | `/admin/carta` |
| N devoluciones pendientes | hay notas sin saldar | `/admin/fiscal/devoluciones-pendientes` |
| N cierres sin revisar | el paso 2 del cierre quedó sin completar | `/admin/dinero` |
| N insumos bajo el mínimo | | `/admin/inventario?tab=stock&below_min=1` |
| N insumos **en negativo** | (deuda de registro, tono crítico, distinto de «bajo mínimo») | `/admin/inventario?tab=stock&negative=1` |
| N preparaciones por lote sin producir | | `/admin/preparaciones` |
| N platos vendidos sin descontar nada | | `/admin/carta` |
| N lotes por vencer o vencidos | | `/admin/inventario?tab=lotes` |
| N cuentas por pagar vencidas | | `/admin/compras?tab=cuentas-por-pagar` |
| N cuentas por pagar pendientes de revisión | | `/admin/compras?tab=cuentas-por-pagar` |
| **Inventario no confiable** | el servidor afirma `inventory_unreliable === true` | `/admin/inventario?tab=salud` |
| Alertas genéricas del servidor | las que no dupliquen una tarjeta directa | según el tipo de alerta |

- **Las tarjetas vienen ordenadas por gravedad** (crítico → aviso → normal).
- **Vacío:** «Todo al día».
- **Estados:** cargando sedes, sin sedes, cargando, error con Reintentar, «Sin datos».
- **Varias tarjetas llevan un filtro ya puesto en la URL** (`?tab=stock&below_min=1`): si el rediseño cambia las pestañas o los nombres de parámetros, estos enlaces se rompen en silencio.

## 15. Ventas — `/admin/ventas` — `features/reports/SalesPage.tsx`

**Enlaces de cabecera:** «Documentos con detalle» → `/admin/fiscal/documentos`, «Notas» → `/admin/fiscal/notas`.

**Tres pestañas:**

**Ventas** (`SalesTab`): filtro de rango de fechas, select **«Agrupar por»**, **Exportar CSV**. Tarjetas de totales, más **Cobertura de receta / Costo teórico / Margen bruto teórico** (la cobertura cambia de tono si es baja). Gráfico de línea o de barras **según el tipo de agrupación y la cantidad de filas** (línea si es secuencial; barras si son ≤ 12 categorías; **ninguno** si son más). Tabla con fila de total. Vacío: «Sin ventas en este período».

**Informe del contador** (`AccountantReportTab`): año, **Mensual / Bimestral**, selector de mes o bimestre (cambia de opciones al cambiar el tipo), **Exportar CSV**. Totales de documentos y notas, totales por medio (**sólo si hay**), tabla por día operativo con el desglose por tarifa. Vacío: «Sin documentos en este período».

**Agotados** (`UnavailableLogTab`): rango de fechas, **Exportar CSV**, tabla con ventas perdidas **estimadas** («—» cuando no hay base para estimar). Vacío: «Sin agotados en este período». Incluye una nota que aclara que sólo lista lo que **sigue** agotado.

- **Estados en las tres pestañas:** cargando, error con **Reintentar**, vacío.

## 16. Pedidos — `/admin/pedidos` — `features/orders/OrdersAdminPage.tsx`

| Acción | Qué hace |
|---|---|
| **Exportar CSV** | Con los filtros puestos |
| Rango de fechas | |
| Select **Estado** / Select **Canal** | Con opción «Todos» |
| **Seis chips de marca** (toggles) | Anuladas · Con cortesía · Con descuento · Consumo de personal · **Trasladadas** · **Cambios después de la cuenta** — combinables |
| Clic en una fila | Abre el detalle de la comanda |
| **«Ver detalle #N →»** | El mismo detalle, **operable con teclado** (la fila sola no lo sería) |

- **Diálogo de detalle:** canal, estado, horas de apertura/cuenta/pago, total y la lista de ítems con marca de anulado y de cortesía. Estados propios: cargando, error.
- Tarjetas: comandas del período, **% de ítems enviados al cobrar** (los que debieron mandarse antes) y **anulaciones después de la cuenta**.
- **Tiempo de cocina por estación** (p50 / p90 / muestras) con gráfico; vacío propio: «Sin ítems enviados a cocina en este período».
- Por fila: detalle de cada anulación con **motivo, si fue después de la cuenta, minutos tras enviar y quién autorizó** — esto es la pista de auditoría visible y es fácil de aplanar en un rediseño.
- **Estados:** cargando sedes / sin sedes / cargando / error / «Ningún pedido coincide con estos filtros».

## 17. Carta — `/admin/carta` — `features/catalog/CatalogAdminPage.tsx`

**Pestañas, cada una detrás de su flag** (Categorías y Productos siempre):

| Pestaña | Flag |
|---|---|
| Categorías | — |
| Productos | — |
| Modificadores | `pos.modifiers` |
| Combos | `pos.combos` |
| Menú del día | `pos.daily_menu` |
| Recetas | `catalog.recipes` |

**Categorías:** campo «Nueva categoría» + **Agregar**; tabla con **switch Activa** por fila (activa/desactiva). Vacío: «Todavía no hay categorías».

**Productos:** buscador; **Nuevo producto** (*deshabilitado si no hay categorías*, con un aviso que manda a crearlas); por fila, **Editar**. El formulario (`ProductForm`, en diálogo) tiene: nombre, categoría, descripción, **precio por canal** (mesa obligatorio; los otros tres con placeholder «Igual que mesa» — un vacío **no** es precio cero), casilla **«Es el cargo de domicilio de esta sede»**, estación, curso, **tasa de impuesto** (INC 8 % / IVA 19 % / Excluido / por defecto de la sede), **contador de porciones**, y **Cancelar** / **Crear**–**Guardar**. Vacíos: «Todavía no hay productos» / «No hay productos que coincidan».

**Modificadores** (`pos.modifiers`): select de producto → por grupo: **casilla de disponibilidad por opción** (marca agotada al instante), nombre y ajuste de precio editables, **Agregar opción**, **Guardar grupo**; y un formulario **Agregar grupo**. Por opción, botón **«Efecto en receta»** — **sólo con `catalog.recipes` encendida**.
- **`RecipeEffectDialog`**: tipo de efecto (**Agrega / Quita / Reemplaza**), líneas con componente (insumo o preparación), cantidad y unidad; con «Reemplaza», un select extra **«Reemplaza, en la ficha base»**; **Quitar línea**, **Agregar línea**, **Guardar efecto** (deshabilitado si no hay línea completa o si falta el objetivo del reemplazo). Aviso propio si el plato no tiene ficha base.
- Vacíos: «Elegí un producto…», «Este producto todavía no tiene grupos».

**Combos** (`pos.combos`): **Nuevo combo** (diálogo con nombre, precio, **franja horaria: casillas de días + desde/hasta**, y opciones elegidas de la lista de productos) y, por combo, **casilla Activo**. Badge **«En franja ahora»**. Vacío: «Todavía no hay combos».

**Menú del día** (`pos.daily_menu`): select de combo; por opción, casilla de disponibilidad y un botón **«Marcar agotado» / «Agotado — reactivar»** (el rótulo cambia con el estado); **Guardar menú de hoy**. Vacíos: «Todavía no hay combos. Creá uno en la pestaña Combos», «Este combo todavía no tiene grupos».

**Recetas** (`catalog.recipes`) — **tres sub-pestañas**:
- *Fichas técnicas* (`RecipeEditor`): select de plato; cabecera con versión vigente, **costo teórico con su origen**, precio neto y **food cost %**; editor de líneas de insumos y preparaciones; **Guardar ficha** (deshabilitado si no hay ninguna línea completa). Vacíos y errores propios.
- *Cobertura*: rango de fechas + **CSV**; tabla de platos vendidos que no descontaron nada. Vacío: «Todo lo que se vendió en el período descontó algo».
- *Unidades sospechosas*: **CSV**; tabla de líneas con cantidad fuera de rango y el motivo que da el servidor. Vacío: «No hay líneas sospechosas de unidad».

## 18. Clientes — `/admin/clientes` — `features/customers/CustomersPage.tsx`

Sección completa detrás del flag **`customers`** (la entrada de navegación desaparece sin él).

| Acción | Qué hace | Condición |
|---|---|---|
| **Exportar CSV** | Clientes con el filtro puesto | siempre |
| Campo «Número de documento» + **Buscar** | También con Enter | |
| **Limpiar** | Quita el filtro | **sólo si hay un filtro aplicado** |
| Clic en una fila | Abre el detalle del cliente | |

**Diálogo de detalle**, con tres bloques:
- **Corregir datos** (nombre, DV, correo, municipio DANE, dirección) + **Guardar** — **desaparece si el cliente está anonimizado**, y en su lugar sale un aviso que explica que los documentos ya emitidos conservan su copia exacta.
- **Registrar consentimiento** (finalidad Facturación/Mercadeo, casilla «Autoriza», canal, versión del texto) + **Registrar** (deshabilitado sin canal y versión) — también **desaparece si está anonimizado**. Aclara que nunca edita uno anterior.
- **Bitácora de habeas data** con **CSV** propio. Vacío: «Sin solicitudes registradas».
- **Anonimizar (habeas data)** — botón destructivo dentro de un `AlertDialog` con **motivo obligatorio**. El texto advierte que **no se puede deshacer** y que el documento fiscal queda intacto. Si ya está anonimizado, el botón se reemplaza por un badge con la fecha.

- **Estados:** cargando, error, «Ningún cliente coincide con esta búsqueda».

## 19. Dinero — `/admin/dinero` — `features/shifts/admin/MoneyAdminPage.tsx`

**Dos pestañas: Operacional (turnos de hoy) e Historial (con rango de fechas y CSV).** Las dos abren el mismo **diálogo de detalle del turno**, que es donde vive el poder real de esta pantalla:

**`ShiftDetailDialog` — acciones de rescate, todas condicionales:**

| Acción | Qué hace | Condición |
|---|---|---|
| **Revisar** | Marca el cierre como revisado | siempre; **deshabilitado y rotulado «Ya revisado»** si ya lo está |
| **Cierre administrativo** | Cierra con el esperado, diferencia cero, sin conteo, y cierra el día. **`AlertDialog` con motivo obligatorio** | **sólo si el turno está abierto Y marcado como abandonado (`is_stale`)** |
| **Reabrir** | Reabre un cierre; el conteo anterior queda como histórico. **`AlertDialog` con motivo obligatorio** | **sólo si el turno está cerrado** |
| **Cancelar** | Elimina lógicamente un turno abierto por error. **`AlertDialog` de confirmación** | **sólo si el turno está abierto**, y **deshabilitado si el turno ya tiene actividad** (movimientos, cambios, retiros, relevos o más de una persona en el roster) |
| **Ajustar apertura** | Reescribe base y reserva contadas al abrir, con **motivo obligatorio** | siempre |

- **Cronología** del turno: cada evento con hora, persona y **la foto adjunta si la hay**. Vacío: «Sin eventos todavía».
- Badges por fila: Abierto/Cerrado y **«Abandonado»**.
- **Estados:** cargando, error con Reintentar, «Sin turnos hoy en esta sede» / «Sin turnos para estos filtros».

## 20. Turnos y personal — `/admin/personal` — `features/shifts/admin/PeopleAdminPage.tsx`

**Dos pestañas.**

**Por persona** (`PersonActivityTab`): select de persona + rango de fechas. Muestra **racha de cierres con diferencia**, tabla de turnos (con «fue responsable de caja» y la diferencia) y **autorizaciones dadas**. Vacíos: «Elegí una persona para ver su actividad», «Sin turnos en este rango», «No dio autorizaciones en este rango».

**Autorizaciones por autorizador** (`AuthorizationsTab`): select de autorizador, rango de fechas y **Exportar CSV**; tabla de hora, autorizador, acción y referencia. Vacío: «Sin autorizaciones para estos filtros».
*Es el reporte de control que justifica que el supervisor tenga PIN propio; perderlo vacía de sentido todo el mecanismo de autorización.*

## 21. Inventario — `/admin/inventario` — `features/inventory/InventoryAdminPage.tsx`

Pantalla entera detrás de **`inventory.perpetual`**. Sin él: «Inventario no está habilitado · Activá «Movimientos de inventario y stock teórico»…».

**La pestaña activa se guarda en la URL (`?tab=…`)** y si se pide una pestaña cuyo flag está apagado, cae en «Insumos» en silencio.

| Pestaña | Flag |
|---|---|
| Insumos | — |
| Stock | — |
| Movimientos y mermas | — (la sección de mermas de adentro exige `inventory.waste`) |
| Conteos | `inventory.counts` |
| Varianza | `inventory.variance` |
| Lotes | `inventory.lots` |
| Salud del control | `inventory.variance` |

**Insumos:** **Exportar CSV**, **Nuevo insumo**, casilla **«Mostrar inactivos»**; por fila **Editar** y **Desactivar** (*el botón Desactivar sólo aparece si el insumo está activo*).
- **Formulario del insumo:** nombre, categoría, **unidad de uso** (g/ml/unidad), **unidad de compra** y **factor de compra**, **rendimiento %**, **costo oficial** y **costo estimado** (separados a propósito), **lead time del proveedor**, **umbral de stock mínimo (obligatorio)**, **sustituto**, y cuatro casillas: **Perecedero**, **Crítico (entra al conteo rápido)**, **Consumo no predecible**, **Activo** (esta última sólo al editar). **Cancelar / Crear–Guardar**.
- El costo se pinta con su **origen**; sin oficial ni estimado dice **«Sin costo»**, nunca «$0».
- Badges: **Crítico**, **Perecedero**, **No predecible**, Activo/Inactivo.

**Stock:** tres casillas de filtro — **Sólo críticos**, **Bajo mínimo**, **Negativos** (**precargadas desde la URL** cuando se llega desde una tarjeta de «Hoy»); **Exportar CSV**. Cada fila muestra el estado como **Negativo** (con «deuda de registro… no bloquea la venta» y desde cuándo), **Bajo mínimo** o **Al día**. Vacío: «Sin insumos para estos filtros».

**Movimientos y mermas:** dos secciones.
- *Libro de movimientos*: select de insumo, rango de fechas, select de causa, **CSV**, tabla con costo y su origen. Más el botón **«Ajuste manual»**.
  - **`AdjustmentDialog`**: insumo, **cantidad con signo** («-500 sale, 500 entra»), motivo obligatorio y **PinPad de administrador** (deshabilitado hasta tener insumo, cantidad y motivo). Queda como movimiento con causa «Ajuste manual» y el autorizador registrado.
  - Vacíos: «Todavía no hay insumos», «Sin movimientos en este período».
- *Mermas*: **sólo con `inventory.waste`**; si no, un vacío que nombra el flag. Tarjeta de **mermas ÷ compras semanal** (que dice explícitamente «no es 0 %, es que todavía no hay con qué compararlo»), filtros de fecha/tipo/responsable, **CSV**, tabla con costo, nota y **enlace «Ver» a la foto** cuando existe.

**Conteos** (`inventory.counts`): rango, select de alcance, **CSV** y **«Abrir conteo»**.
- **`OpenCountDialog`**: alcance **Críticos / Completo** (con una explicación distinta por alcance) → **Abrir conteo**, que navega a la captura.
- Tabla con enlace a cada conteo, estado Aplicado/Abierto y **«N / M renglones (parcial)»**.

**Varianza** (`inventory.variance`): select de **conteo aplicado** (sólo lista los aplicados) y **CSV**. Tabla con uso real vs. teórico, varianza en cantidad y en pesos (o **«Sin costo · origen: ninguno»**) y semáforo Verde/Revisar/Rojo. Vacíos escalonados: «Elegí un conteo aplicado», «Sin varianza para este conteo» (con el motivo que da el servidor), «Sin insumos en común entre los dos conteos», y un aviso si no hay ningún conteo aplicado en la sede.

**Lotes** (`inventory.lots`): filtros de insumo, estado y **«Días para vencer (máximo)»**. Por fila vencida, un **enlace «Registrar merma (vencido)» que salta a `/pos/merma`** — un cruce admin → POS fácil de perder. **No hay CSV acá, a propósito** (el backend no lo soporta).

**Salud del control** (`inventory.variance`): cuatro tarjetas (días desde el último conteo completo, % de recepciones con factura, % de preparaciones por lote producidas, mermas de la semana), el aviso **«Inventario no confiable»** cuando corresponde, y el **Food cost real** con rango de fechas, que muestra la fórmula y los cuatro componentes — o un vacío que explica que hacen falta dos conteos completos consecutivos.

## 22. Conteo — `/admin/inventario/conteos/:countId` — `features/inventory/CountCapturePage.tsx`

Ruta propia (no una pestaña) justamente porque **aplicar un conteo es irreversible y hay que poder recargar sin perder lo capturado**.

| Acción | Qué hace | Condición |
|---|---|---|
| **Volver a conteos** | Enlace a `/admin/inventario?tab=conteos` | siempre |
| Campo de cantidad por renglón | Acepta **sumas y decimales con coma** («6+8», «3,5»); marca inválido sin enviar | **deshabilitado si el conteo ya se aplicó** |
| **Confirmar** (por renglón) | Guarda ese renglón como contado | deshabilitado sin valor válido o si el conteo no está abierto |
| **Guardar avance (sin confirmar)** | Guarda todos los borradores como no confirmados | **sólo si el conteo está abierto** |
| **Aplicar conteo** (botón destructivo) | Abre el diálogo de aplicación | **sólo si el conteo está abierto** |

- **Diálogo «Aplicar el conteo»**: advierte que es **irreversible y se hace una sola vez**, y pide **PinPad de administrador**. Si el servidor responde `COUNT_ALREADY_APPLIED`, el PinPad **se reemplaza** por un aviso de que no hay nada que reintentar y un botón **Cerrar**.
- Avisos de estado: **«Conteo a ciegas: esta pantalla no muestra el stock del sistema»**, **«Guardado parcial: N de M renglones confirmados»** o «Todos los renglones están confirmados», y el aviso de ya-aplicado.
- Tras aplicar, aparece una **tabla de ajuste aplicado** (contado, stock antes, ajuste, stock después) con los ajustes negativos destacados.
- **Estados:** cargando sedes, sin sedes, cargando, error con Reintentar, «Sin datos».

## 23. Preparaciones — `/admin/preparaciones` — `features/recipes/PreparationsAdminPage.tsx`

Pantalla entera detrás de **`catalog.preps`** (que a su vez depende de «Fichas técnicas»).

| Acción | Condición |
|---|---|
| **Exportar CSV** | siempre |
| **Nueva preparación** | siempre |
| Casilla **«Mostrar inactivas»** | siempre |
| **Editar** (por fila) | siempre |
| **Cambiar modo** (por fila) | siempre |
| **Ver lotes** (por fila) | **sólo si la preparación está en modo «por lote»** |

- **`PrepModeSwitchDialog`** — **PIN de administrador obligatorio**, y **el texto de la advertencia cambia según la dirección del cambio**:
  - *De «por lote» a «explotada»*: alerta destructiva — **cierra los lotes abiertos con un ajuste de conteo y no se puede deshacer solo**.
  - *De «explotada» a «por lote»*: alerta informativa — **a partir de ahí alguien tiene que producirla o queda en negativo**.
- **`PrepBatchesPanel`** (Ver lotes): diálogo con **CSV** propio y tabla de lotes (esperado vs. real, **badge de varianza con alerta**, costo del lote y por unidad, vencimiento, quién produjo, abierto/cerrado con motivo). Vacío: «Todavía no se produjo ningún lote… Producí desde el POS».
- **Estados:** cargando sedes, sin función, sin sedes, cargando, error, «Todavía no hay preparaciones».

## 24. Compras — `/admin/compras` — `features/purchases/PurchasesAdminPage.tsx`

Pantalla entera detrás de **`purchases`**. **Pestaña en la URL (`?tab=…`)**: `proveedores`, `recepciones`, `cuentas-por-pagar` — *los enlaces de «Hoy» apuntan a `?tab=cuentas-por-pagar`*.

**Proveedores:** **Exportar CSV** (generado en el cliente, deshabilitado sin filas), **Nuevo proveedor**, casilla «Mostrar inactivos»; por fila **Confiabilidad**, **Editar** y **Desactivar** (*sólo si está activo*).
- *Formulario*: nombre, NIT, **plazo de pago (días)**, contacto, teléfono, casilla **«Obligado a facturar»** (con la advertencia de que una recepción sin factura de ese proveedor se rechaza) y casilla **Activo** (sólo al editar).
- **`SupplierReliabilityDialog`**: rango de fechas y cuatro indicadores (recepciones, recibido ÷ facturado, % con factura, **deriva promedio de precio**).

**Recepciones:** rango, select de proveedor, select de estado (Confirmada / Revertida), **CSV**, **Nueva recepción** (*deshabilitado si no hay proveedores activos*, con un aviso que manda a crearlos); por fila **Ver**.
- **`ReceptionForm`** (diálogo): proveedor, número de factura, fecha, casilla **«Sin factura (plaza de mercado)»** (*que cambia los rótulos de los dos campos anteriores*), **foto de la factura**, y el **editor de líneas** (insumo, cantidad recibida, **cantidad facturada** por separado, precio por unidad de compra, base gravable, tarifa IVA/INC, valor del impuesto, **lote** y **vencimiento**), con **Quitar línea** y **Agregar línea**.
- **Flujo en dos pasos a propósito:** botón **«Continuar»** → recién entonces aparece el **PinPad «PIN de quien recibe»** (más **«Volver a editar»**). El PinPad no se monta antes para que los dígitos del precio no se cuelen como PIN.
- **Guarda de precio** — bloque condicional que aparece **sólo si el servidor responde `PRICE_LOOKS_LIKE_PACKAGE` o `PRICE_JUMP`**: muestra lo tecleado, aclara que el sistema **no corrige el precio solo**, y ofrece **«Volver a revisar el precio»** o **«Confirmar que el precio es correcto»** (que queda registrado con el nombre de quien confirma). *Este par de botones es de los controles más fáciles de perder: sólo existen en el camino de error.*
- **`ReceptionDetailDialog`** (Ver): cabecera con estado, factura, día operativo, quién recibió, cuenta por pagar, **«precio confirmado tras una guarda» y por quién**, y datos de reversión si la hay; tabla de líneas (recibido, facturado, precio, costo final, lote, vence). Y **«Eliminar recepción»** — botón **destructivo** en `AlertDialog` que **enumera qué se va a revertir** y pide **PIN de administrador**.

**Cuentas por pagar:** rango, proveedor, estado (Pendiente de revisión / Aprobada / Cancelada), casilla **«Sólo vencidas»**, **CSV**; por fila **Ver**. Badge **Vencida**.
- **`PayableDetailDialog`** — el contenido cambia por completo según el estado:
  - **Pendiente de revisión** → bloque **Aprobar** con **PinPad de administrador**, y el texto que explica que es el control entre quien recibe y quien paga. *Sin aprobar no se puede pagar.*
  - **Aprobada con saldo > 0** → **Registrar pago**: monto, medio, **fecha real de salida**, comprobante, **switch «Desde el cajón»** (que avisa que va a crear un egreso en el turno abierto y que **sin turno abierto el pago no se registra**) y **PinPad de administrador** (deshabilitado sin monto válido).
  - **Aprobada con saldo 0** → «Cuenta saldada».
  - **Cancelada** → aviso de que la recepción que la originó se revirtió.
  - Tabla de pagos con **Anular** por pago (`AlertDialog` con **motivo + PIN de administrador**); un pago ya anulado muestra el motivo y no ofrece el botón.

## 25. Banco — `/admin/banco` — `features/banking/BankingAdminPage.tsx`

Pantalla detrás de **`money.deposits`**. **Cuatro de sus seis pestañas exigen además `money.bank`** — con «Consignaciones» encendida pero «Banco» apagada, la pantalla existe pero se queda en dos pestañas. Pestaña en la URL (`?tab=…`).

| Pestaña | Flag |
|---|---|
| Consignaciones | `money.deposits` |
| Por consignar | `money.deposits` |
| Libro del banco | `money.bank` |
| Mano del dueño | `money.bank` |
| Conciliación datáfono | `money.bank` |
| Conciliación plataformas | `money.bank` |

**Consignaciones:** rango de fechas + **Registrar consignación**. Tabla con turnos imputados, banco/referencia, badge **Con foto / Sin foto**, y badge **Reversada** (con la fila atenuada).

**`CreateDepositDialog`** — el formulario más cargado de condiciones del módulo:
- Fecha de negocio, banco, referencia, **monto** («el que dice el comprobante del banco»).
- **Imputación por turno**: pares de *id de turno* + *monto*, con **Agregar otro turno** y **Quitar turno** (*el botón de quitar aparece sólo si hay más de una fila*).
- Texto que explica que **dejarlo vacío registra «la mano del dueño»**, y que **un turno consignado no puede volver a aparecer en la mano** (la llave anti doble conteo).
- **Foto del comprobante obligatoria** — el botón de guardar está deshabilitado sin ella.

**Por consignar:** rango; tabla por turno cerrado con «Por consignar» (o **«Sin datos»** con el motivo del servidor), consignado y saldo. Botón **Consignar** por fila, **sólo si el saldo pendiente es > 0**, y precargado con ese turno.

**Libro del banco** (`money.bank`): rango, cuatro totales (consignaciones, liquidaciones de datáfono netas, transferencias, total) y el libro de movimientos.

**Mano del dueño** (`money.bank`): rango; tarjetas Retirado / Consignado / Gastado / **Saldo en mano**, y un segundo bloque de desglose (**retirado por relevo**, **retirado al cerrar turno**, **gastado en propinas**, **gastado en devoluciones**) que **sólo se dibuja si el servidor mandó esos campos**. Vacío propio: «Mano del dueño no disponible» con el motivo.

**Conciliación datáfono / plataformas** (`money.bank`): rango; tabla con esperado, liquidado, diferencia y badge **Conciliado / Sin conciliar**.
- Botón **Conciliar** por fila — **sólo en la de datáfono, y sólo si la fila no está conciliada**; abre un diálogo con el resumen de la diferencia y una nota opcional.
- Debajo, **«Liquidaciones del datáfono / de plataformas»** con **Registrar liquidación** (fecha de venta y de abono o período, bruto, comisión, **retenciones sólo en datáfono**, referencia; con la aclaración de que **el neto y el rezago los calcula el servidor**) y un botón **Conciliar** por liquidación **sólo si su estado es «registrada»**.
- Aviso importante: mientras no haya liquidaciones registradas **todo aparece como no conciliado, y eso no significa que falte plata sino que falta el dato**.

## 26. Gastos — `/admin/gastos` — `features/expenses/ExpensesAdminPage.tsx`

Pantalla detrás de **`money.obligations`**. Cinco pestañas (en la URL), todas con el mismo flag.

**Gastos:** rango + **Registrar gasto** (fecha, monto, **categoría tipada**, descripción). Tabla. Vacío: «No hay gastos registrados en este período».

**Obligaciones:** filtro de estado (Todas / Pendientes / Pagadas) + **Agendar obligación** (descripción, categoría, **vencimiento**, monto). Por fila, botón **Saldar** — **sólo si está pendiente y no cancelada**. Vacío: «No hay obligaciones agendadas».

**Punto de equilibrio:** rango + la tarjeta **Costos fijos del período**, que es a la vez lectura y edición (**Guardar costos fijos**, deshabilitado hasta tocar el campo). Resultado en tres tarjetas. Vacío: «Punto de equilibrio no disponible» con el motivo.
*La tarjeta de costos fijos vive acá a propósito y no en Configuración: es donde uno se entera de que faltan.*

**Utilidad:** rango; seis tarjetas (ventas netas, costo, gastos, obligaciones, nómina, **utilidad** en tono crítico si es negativa). Vacío con motivo.

**Cuentas por pagar:** campo **«Buscar cuenta por pagar por id»** + **Buscar**. Con la cuenta cargada muestra **calculado línea por línea vs. factura del proveedor** y, si está pendiente de revisión, el bloque de aprobación con **PinPad de administrador**.
- **Bloque condicional de discrepancia**: si el servidor responde `INVOICE_DISCREPANCY`, aparece un aviso que enfrenta **«lo que dice el papel»** contra **«lo calculado»**, la diferencia, y la aclaración de que **el sistema no ajusta ninguna de las dos cifras**; el rótulo del PinPad cambia a **«PIN de administrador para confirmar la diferencia»**.
- Vacíos: «Ingresá el id…», «Esta cuenta no está pendiente de revisión».

## 27. Nómina — `/admin/nomina` — `features/payroll/PayrollAdminPage.tsx`

Pantalla con **dos flags independientes**: `payroll` y `pos.tips`. Con uno solo encendido, la pantalla existe **con menos pestañas** y la pestaña inicial cambia (`horas` o `propinas`). Sin ninguno: «Nómina y propinas no está habilitado».

| Pestaña | Flag |
|---|---|
| Horas / Tarifas y calendario / Tablas de recargos / Liquidaciones | `payroll` |
| Propinas | `pos.tips` |

**Horas:** rango; tabla por persona (ordinarias, nocturnas, dominicales, festivas, extra). Vacíos: «Jornada no disponible» con motivo, «No hay jornada registrada».

**Tarifas y calendario:** tres bloques de alta —
- *Tarifa por hora*: persona, **pesos por hora**, **rige desde** → Guardar. Vacío: «Todavía no hay tarifas cargadas · **Sin tarifa no se puede liquidar la nómina**».
- *Festivos*: fecha + nombre → Agregar.
- *Áreas*: persona + área → Asignar (base del reparto de propinas «por área»).

**Tablas de recargos:** **Nueva tabla de recargos** (vigente desde, franja nocturna, tres porcentajes de recargo, jornada semanal ordinaria). Tabla con columna **«Revisada»**: badge con el nombre de quien confirmó, o **«Sin revisar»**, más un aviso general de que **las vigencias sin revisar las cargó la instalación y descansan sobre un supuesto**.

**Liquidaciones:** aviso fijo y destacado de que **la cifra es para control interno, no es la liquidación legal** (la fórmula del CST no está implementada). Rango + **«Liquidar este período»**. Por liquidación, **Ver detalle / Ocultar detalle** con el desglose por persona y los badges de qué tabla de recargos se usó; si esa tabla no estaba confirmada, un aviso extra. Errores: «No se pudo liquidar: …» con el motivo del servidor.

**Propinas** (`pos.tips`): bloque de **método de reparto de la sede** (Por horas trabajadas / Partes iguales / Por área). Rango + un aviso permanente de que **esto es una propuesta y no movió ni un peso**. Tabla de propuesta por persona.
- **Confirmar reparto** abre un formulario con fecha y hora de entrega, método (Efectivo / Datáfono / Transferencia / Otro) y **«¿De dónde salió la plata?»** (**De la plata que tenés en la mano** / **Del cajón**) — *esta última pregunta cambia la contabilidad de la mano del dueño y es fácil de perder por parecer un detalle*. El texto aclara que **el sistema no mueve la plata: sólo deja constancia**.
- Vacíos: «Propuesta no disponible» con motivo, «No hay propinas para repartir en este período».

## 28. Analítica — `/admin/analitica` — `features/analytics/AnalyticsAdminPage.tsx`

**Tres flags independientes** gobiernan sus cuatro pestañas; sin ninguno, la pantalla es un vacío que los nombra a los tres. **Tres entradas de navegación distintas llevan a la misma pantalla**, cada una con su flag y su `?tab=`.

| Pestaña | Flag |
|---|---|
| Ingeniería de menú | `analytics.menu_engineering` |
| Varianza por plato | `inventory.variance` |
| Salud sostenida | `inventory.variance` |
| Reposición sugerida | `inventory.replenishment` |

Todas son de sólo lectura: rango de fechas y tabla. Lo que cambia entre ellas son los vacíos, y **cada uno lleva el motivo que da el servidor** en vez de una tabla vacía: «No hay ventas con costo congelado», «Hacen falta conteos completos aplicados y consecutivos», «Sin historial suficiente», «Hace falta consumo e insumos con lead time del proveedor cargado».

## 29. Documentos fiscales — `/admin/fiscal/documentos` — `features/fiscal/DocumentsPage.tsx`

**Sin flag: es ley, está siempre.**

| Acción | Qué hace | Condición |
|---|---|---|
| Select **Estado** / Select **Tipo** | Filtran la tabla | siempre |
| **Exportar CSV** | Documentos con el filtro | siempre |
| **Evidencia** (por fila) | Abre el diálogo con estado DIAN, CUDE, **enlace al QR**, fecha de validación y **el rango que amparó el consecutivo** | siempre |
| **Reintentar** (por fila) | Reintenta la transmisión a la DIAN | **sólo si el documento tiene estado DIAN y no está «validado»** |
| **Emitir nota** (por fila) | Enlaza a `/admin/fiscal/notas?document={id}` con el documento ya cargado | siempre |
| **Exportar paquete de evidencia** | Manifiesto con hash por documento y hash del manifiesto entero (conservación 5 años) | **el botón aparece sólo con las dos fechas del rango puestas** |

- Badges: estado DIAN y **«Contingencia vencida (48 h)»**.
- **Estados:** cargando sedes, cargando, error, «Ningún documento coincide con estos filtros».

## 30. Rangos de numeración — `/admin/fiscal/rangos` — `features/fiscal/RangesPage.tsx`

**Sin flag: es ley.**

| Acción | Qué hace |
|---|---|
| **Exportar CSV** | |
| **Nuevo rango** | Diálogo: tipo de documento, prefijo, **clave técnica**, desde/hasta, número y fecha de resolución, vigente desde/hasta |

- Columna **Avisos** con dos badges condicionales: **«80 % consumido»** y **«Vence en 30 días o menos»**. *Son la alerta temprana de que el consecutivo se va a acabar; si desaparecen en el rediseño, el restaurante se entera cuando ya no puede cobrar.*
- Vacío que explica la consecuencia: **«Sin un rango vigente, un cobro que necesite documento equivalente o factura falla antes de cobrar»**.

## 31. Notas — `/admin/fiscal/notas` — `features/fiscal/NotesPage.tsx`

**Sin flag: es ley.** Toda corrección va por nota; el documento original **se reversa, nunca se edita**.

**Emitir una nota nueva** (se llega también desde Documentos con `?document=`):

| Acción | Condición |
|---|---|
| Campo **«Documento original (ID)»** + botón de cargar | siempre |
| Select **«Tipo de nota»** | tras cargar el documento |
| **Motivo** (textarea) | |
| **Casillas por línea del documento** — qué líneas corrige la nota, con una columna **«Inventario»** que dice si esa línea repone stock (o «No aplica (nota débito)») | por línea |
| Casilla **«Devolver plata al cliente»** | siempre |
| Select **Medio** (Efectivo / Tarjeta / Transferencia / Otro) y campo **Monto** | **sólo si la casilla de devolución está marcada** |

- Lista de notas con rango de fechas y **CSV**. Vacío: «Todavía no hay notas en este período».

## 32. Devoluciones pendientes — `/admin/fiscal/devoluciones-pendientes` — `features/fiscal/PendingRefundsPage.tsx`

**Sin flag: es ley.** Son las notas que se emitieron **sin turno abierto** y quedaron sin saldar.

| Acción | Condición |
|---|---|
| Select de estado + **Exportar CSV** | siempre |
| **Saldar** (por fila) | **sólo si la devolución sigue pendiente** |

- **Diálogo «Saldar devolución pendiente»**: select **«Desde el turno abierto (crea un egreso ahí)»** / **«De la mano del dueño (no toca la caja)»**. **La primera opción deshabilita el botón si no hay turno abierto**, con un aviso propio.
- Vacío: «Ninguna devolución pendiente con este filtro».

## 33. Historial — `/admin/audit` — `features/audit/AuditPage.tsx`

**Sin flag: es auditoría.**

| Acción | Qué hace |
|---|---|
| Filtros: desde, hasta, **Entidad** (texto: «store, employee, zone…»), **Empleado (ID)** | |
| **Exportar CSV** | Con los filtros puestos |
| **Expandir una fila** (`<details>`) | Muestra **la tabla campo · antes · después** del cambio, más hora, actor y motivo |

- Si no hubo cambios de campo dice **«Sin cambios de campo (creación o baja)»** en vez de una tabla vacía.
- **Estados:** esqueletos de carga, error con Reintentar, «Sin cambios para estos filtros».

## 34. Notificaciones — `/admin/notifications` — `features/notifications/NotificationsPage.tsx`

**Sin flag.** Dos secciones.

**Recientes:** lista con badge de nivel; **Marcar leída** por notificación — **sólo si no está leída** (si lo está, se reemplaza por un badge «Leída»). Vacío: «Sin notificaciones».

**Reglas por sede:** una fila por tipo de aviso, con **switch Activa**, campo **Umbral** y select **Nivel** (Informativo / Alerta / Crítico) → **Guardar reglas**. Vacíos: «Creá una sede primero», «Elegí una sede para ver sus reglas».

**Además: la campana del chrome del admin** (`NotificationBell`, visible en **todas** las pantallas de admin): sondea cada 30 s, muestra el **contador de no leídas** como badge, abre un menú con las 8 más recientes y **marca leída al seleccionar una**. Sus propios estados: cargando, error, «Sin notificaciones».

## 35. Funciones — `/admin/features` — `features/features/FeaturesPage.tsx`

**Sin flag** (es la pantalla que gobierna a todas las demás). **Aquí se enciende y apaga todo lo que este inventario marca como condicional.**

| Acción | Qué hace | Condición |
|---|---|---|
| Select **«Elegir perfil…»** (Básico / Estándar / Full) | Abre la confirmación de cambio de perfil | siempre |
| **Confirmar** el cambio de perfil | **Reinicia los flags de toda la organización** a los defaults del perfil. Queda en el historial | `AlertDialog` que explica que **los overrides por sede no se tocan** |
| Select **«Editando:»** | **Toda la organización** o **Override de {sede}** | las sedes salen del selector global |
| **Switch por función** | Enciende o apaga esa función en el alcance elegido | siempre |

- La tabla muestra, por función: **clave**, descripción, estado, **Origen** (Organización / Override de sede / Default del perfil) y **Dependencias** (`requires`).
- **Estados:** esqueletos, error con Reintentar, «Todavía no hay funciones para mostrar».

## 36. Ajustes — `/admin/settings` — `features/settings/SettingsPage.tsx`

**Sin flag.** **Diez pestañas**, ninguna gateada por flag a nivel de pestaña (aunque dos secciones de adentro sí consultan flags).

**Organización:** nombre de la organización → **Guardar** (deshabilitado si no se cambió nada).

**Sedes:** **Nueva sede**; por fila **Editar** y **Rotar PIN**.
- *`StoreFormDialog`*: nombre, NIT, DV, razón social, dirección, **municipio (código DANE)**, **hora de corte**, **PIN de sede**, **casillas de canales activos** (Mostrador, Mesas, Para llevar, Domicilio, Plataformas) y **horario por día de la semana** (casilla por día + hora de apertura y cierre).
- *Rotar PIN*: diálogo con **PinPad de 6 dígitos**, y la advertencia de que **los dispositivos ya activados siguen funcionando**.

**Fiscal:** muestra **la configuración vigente**, el **historial de versiones**, y un formulario **«Cargar un cambio»** con **vigente desde** (la configuración fiscal es versionada, nunca se edita: se crea una versión nueva), persona Natural/Jurídica, régimen Ordinario/Simple, tasa por defecto (INC 8 % / IVA 19 % / Excluido), **códigos de responsabilidad RUT** y cuatro casillas → **Guardar nueva versión**. Vacío: «Sin configuración fiscal vigente».

**Caja:** siete montos —**base fija de apertura, reserva por defecto, tolerancia sin causa identificada, tolerancia con causa identificada, diferencia crítica, umbral de retiro, límite de gasto menor**—, **turnos seguidos con diferencia para alertar**, y dos casillas: **Foto obligatoria al cerrar turno** y **Foto obligatoria en retiros**. *Estas dos casillas son las que hacen aparecer el campo de foto obligatoria en el POS: apagarlas o perderlas cambia el comportamiento de otra pantalla.*

**Ventas:** propina sugerida (máx. 10 %), **límite de descuento**, **límite diario de descuento**, **cortesías por turno**; **medios de pago** editables (código, etiqueta, **código DIAN**, con **Agregar** y **Quitar**); listas de **motivos de anulación / de descuento / de cortesía**, **estaciones** y **cursos** (uno por línea) y un **tiempo objetivo por curso**. *Acá se configuran los motivos tipados que después aparecen en los diálogos del POS: son datos de configuración que se ven como texto libre, y perderlos deja los desplegables vacíos.*

**Canales y plataformas:** aviso de que Mesa, para llevar y mostrador se activan en **Sedes**; **Nueva plataforma** (nombre, código, **comisión %**), por fila **Editar** y **Desactivar/Activar**, casilla «Mostrar inactivas» — **toda la sección de plataformas consulta `pos.platforms`**. Cierra con un puntero a que estaciones y cursos se editan en **Ventas**.

**UVT:** tabla año + valor con **Agregar fila** y **Quitar fila** → **Guardar**.

**Zonas y mesas:** tabla de zonas con **switch Activa** y alta de zona; tabla de mesas con **switch Activa** y alta de mesa (zona, número, sillas).

**Inventario:** **umbral amarillo** y **umbral rojo** de varianza (consulta `inventory.variance`) → Guardar; y **marcado de insumos críticos** con una casilla por insumo (consulta `inventory.perpetual`). Vacío: «Sin insumos activos · Creá insumos en Inventario → Insumos primero».

**Empleados:** **Nuevo empleado**; por fila **Editar** y **Desactivar** (*sólo si está activo* — los empleados **se desactivan, nunca se borran*). El formulario tiene nombre, **rol**, **PIN de 4 dígitos** (al editar: «Nuevo PIN (opcional)»), documento, correo, **contraseña** (al editar: «Nueva contraseña (opcional)»), una casilla de **puede cobrar** y **límite de descuento (%)** por persona. *Ese límite por persona es lo que dispara el `AuthorizerDialog` del POS.*

---

# Listas transversales

## A. Todo lo que está detrás de un *feature flag*

40 claves distintas. «Dónde» nombra la pantalla por su número de este documento.

| Flag | Qué habilita | Dónde |
|---|---|---|
| `multi_store` | El **selector de sede** del chrome del admin (además exige > 1 sede) | Chrome admin (13–36) |
| `pos.tables` | Entrada «Mesas»; **la pantalla 3 entera**; el canal «Mesa» en 4; **a dónde vuelve** Cobro y Documento | 3, 4, 8, 9, índice de `/pos` |
| `pos.counter` | Canal «Mostrador» | 4 |
| `pos.takeout` | Canal «Para llevar» y sus campos (nombre, teléfono, hora prometida) | 4 |
| `pos.delivery` | Canal «Domicilio» y sus campos; **pestaña «Domicilios» del turno**; el renglón de efectivo de domicilios en el resumen | 4, 10 |
| `pos.platforms` | Canal «Plataforma» y sus campos; la sección de plataformas de Ajustes | 4, 36 |
| `pos.staff_meal` | Canal «Consumo de personal» y «¿Quién consume?» | 4 |
| `pos.modifiers` | Grupos de modificadores al agregar un ítem; **pestaña Modificadores** | 5, 17 |
| `pos.combos` | Selección de opciones de combo; **pestaña Combos** | 5, 17 |
| `pos.seats` | Campo **Asiento** al agregar un ítem | 5 |
| `pos.courses` | Campo **Curso** y toda la sección **«Marchar»** | 5 |
| `pos.courtesies` | Botón **Cortesía** por ítem (y su diálogo con PIN) | 5 |
| `pos.discounts` | Botón **Descuento** por ítem **y** «Descuento de la comanda» | 5 |
| `pos.pre_bill` | Botón **Presentar cuenta** y el diálogo de precuenta; la presentación automática al entrar a Cobro | 5, 8 |
| `pos.split_bill` | Todo el panel de **división de cuenta** (partes iguales / por ítems) | 8 |
| `pos.tips` | La **pregunta de propina** antes de cobrar; **pestaña Propinas** y su entrada de navegación | 8, 27 |
| `pos.daily_menu` | Pestaña **Menú del día** de la carta del POS; **pestaña Menú del día** del admin | 5, 17 |
| `pos.daily_count` | Badge **«Quedan N»** por producto | 5 |
| `kitchen.view` | Entrada «Cocina»; **la pantalla 6 entera**; el botón **Enviar (N)** de la comanda | 5, 6 |
| `kitchen.kds` | Entrada «KDS»; **la pantalla 7 entera** (bump, expedir, impresión) | 7 |
| `catalog.preps` | Entradas «Producir» y «Preparaciones»; **pantallas 11 y 23 enteras** | 11, 23 |
| `catalog.recipes` | **Pestaña Recetas** de la carta; el botón **«Efecto en receta»** de cada opción de modificador | 17 |
| `catalog.preps` + `catalog.recipes` | (dependencia declarada: preparaciones depende de fichas técnicas) | 23 |
| `inventory.perpetual` | Entrada «Inventario»; **la pantalla 21 entera**; el marcado de críticos en Ajustes | 21, 36 |
| `inventory.waste` | Entrada «Merma»; **la pantalla 12 entera**; la **sección de mermas** dentro de Movimientos | 12, 21 |
| `inventory.counts` | **Pestaña Conteos** (y por lo tanto el acceso a la pantalla 22) | 21 |
| `inventory.variance` | Pestañas **Varianza** y **Salud del control**; pestañas **Varianza por plato** y **Salud sostenida** de Analítica; los umbrales en Ajustes; la entrada «Varianza y salud» | 21, 28, 36 |
| `inventory.lots` | **Pestaña Lotes** | 21 |
| `inventory.replenishment` | **Pestaña Reposición sugerida** y su entrada de navegación | 28 |
| `analytics.menu_engineering` | **Pestaña Ingeniería de menú** y su entrada de navegación | 28 |
| `purchases` | Entrada «Compras»; **la pantalla 24 entera** | 24 |
| `money.deposits` | Entrada «Banco»; **la pantalla 25**; pestañas Consignaciones y Por consignar | 25 |
| `money.bank` | **Cuatro pestañas** de Banco: Libro, Mano del dueño, Conciliación datáfono, Conciliación plataformas | 25 |
| `money.obligations` | Entrada «Gastos»; **la pantalla 26 entera** | 26 |
| `payroll` | Entrada «Nómina»; las **cuatro pestañas** de nómina | 27 |
| `customers` | Entrada «Clientes»; el acceso a la pantalla 18 | 18 |
| `cash.reserve` | Campo **«Reserva de caja»** al abrir turno | 10 |
| `cash.swaps` | **Pestaña «Cambio»** del turno | 10 |
| `cash.pickups` | **Pestaña «Retiros»** del turno (y con ella reversar un retiro) | 10 |
| `cash.handovers` | **Pestaña «Relevo»** del turno (relevo y arqueo sorpresa) | 10 |
| `cash.blind_close` | **Cambia el formulario de cierre entero**: asistente de tres pasos vs. formulario de un paso | 10 |

**Sin flag, a propósito** (es ley o integridad, y el código lo dice explícitamente): Documentos fiscales, Rangos de numeración, Notas, Devoluciones pendientes, Historial, Notificaciones, Funciones, Configuración, Hoy, Ventas, Pedidos, Carta (Categorías y Productos), Dinero, Turnos y personal, Turno del POS, y la comanda misma.

## B. Todo lo que exige autorización

**PIN propio de la persona (identidad / atribución):**

| Acción | Dónde |
|---|---|
| Identificarse en el dispositivo | 2 |
| **Cobrar** una cuenta (PIN propio, tras completar los pagos) | 8 |
| Entrada / salida / pausa en el roster | 10 |
| Confirmar una **producción** de preparación | 11 |
| Confirmar una **merma** | 12 |
| Confirmar una **recepción de compra** (PIN de quien recibió físicamente) | 24 |

**PIN de sede (6 dígitos):**

| Acción | Dónde |
|---|---|
| **Activar un dispositivo** | 1 |
| **Rotar el PIN de la sede** | 36 |

**PIN de supervisor o administrador:**

| Acción | Cuándo se pide | Dónde |
|---|---|---|
| Unir o mover mesas | **sólo si la comanda ya tiene cuenta presentada** (`BILL_PRESENTED_NEEDS_AUTH`) | 3 |
| Agregar ítem, anular ítem o comanda, aplicar descuento | **sólo cuando el servidor lo exige** (`AUTHORIZATION_REQUIRED`, `DISCOUNT_LIMIT_EXCEEDED`, cambios después de la cuenta) | 5 |
| **Cortesía** de un ítem | **siempre** (el PIN es obligatorio en el propio diálogo) | 5 |

**PIN de administrador:**

| Acción | Cuándo se pide | Dónde |
|---|---|---|
| Movimiento de caja por encima del límite de gasto menor | **sólo tras `PETTY_CASH_LIMIT`** | 10 |
| **Registrar un retiro** de efectivo | siempre | 10 |
| **Reversar un retiro** | siempre (+ motivo obligatorio) | 10 |
| **Arqueo sorpresa** | siempre | 10 |
| Relevo de responsable | **PIN opcional** | 10 |
| **Ajuste manual de inventario** | siempre | 21 |
| **Aplicar un conteo** | siempre | 22 |
| **Cambiar el modo de una preparación** | siempre | 23 |
| **Revertir / eliminar una recepción** | siempre (+ motivo) | 24 |
| **Aprobar una cuenta por pagar** | siempre | 24, 26 |
| **Confirmar una discrepancia de factura** | sólo tras `INVOICE_DISCREPANCY` | 26 |
| **Registrar un pago a proveedor** | siempre | 24 |
| **Anular un pago a proveedor** | siempre (+ motivo) | 24 |

**Sin PIN, aunque parezca que debería tenerlo** (verificado en el código, no asumido): **liquidar** y **deshacer** el efectivo de domicilios (pantalla 10) van con la persona identificada en el dispositivo, sin PIN de administrador; y **desactivar el dispositivo** (chrome del POS) sólo pide confirmación, porque el backend no exige PIN y la interfaz no inventa gates que el servidor no hace cumplir.

## C. Todo lo destructivo o irreversible

Ordenado por lo que cuesta si se pierde o si se vuelve fácil de tocar por accidente.

| Acción | Dónde | Protección hoy |
|---|---|---|
| **Aplicar un conteo de inventario** | 22 | Botón `variant="destructive"` + diálogo que dice **«irreversible, se hace una sola vez»** + PIN de administrador. Reintentarlo responde «ya se aplicó, no hay nada que reintentar» |
| **Confirmar el cierre del turno** | 10 | Tres pasos a ciegas; causa tipada obligatoria si hay diferencia; **la opción «Sin identificar» desaparece** si la diferencia supera la tolerancia; si la diferencia cambió, vuelve al paso 2 |
| **Cierre administrativo** de un turno abandonado | 19 | `AlertDialog` + **motivo obligatorio**. Cierra con diferencia cero y sin conteo |
| **Cancelar un turno** | 19 | `AlertDialog` + **deshabilitado si el turno ya tiene actividad**. Elimina lógicamente |
| **Reabrir un cierre** | 19 | `AlertDialog` + motivo obligatorio |
| **Ajustar la apertura** de un turno | 19 | `AlertDialog` + motivo obligatorio. Reescribe la base y todo lo derivado |
| **Anular una comanda** | 5 | `VoidDialog` con motivo tipado (+ nota obligatoria en «otro») + botón destructivo + PIN si el servidor lo exige |
| **Anular un ítem** | 5 | Igual que arriba |
| **Cortesía** de un ítem | 5 | Motivo tipado + **PIN de autorizador obligatorio** |
| **Anonimizar un cliente (habeas data)** | 18 | Botón destructivo + `AlertDialog` + **motivo obligatorio** + texto que dice **«no se puede deshacer»** |
| **Revertir / eliminar una recepción de compra** | 24 | Botón destructivo + `AlertDialog` que **enumera línea por línea qué se va a revertir** + PIN de administrador |
| **Anular un pago a proveedor** | 24 | `AlertDialog` + motivo + PIN de administrador |
| **Registrar un pago a proveedor «desde el cajón»** | 24 | Switch + aviso de que crea un egreso en el turno abierto; PIN de administrador |
| **Cambiar el modo de una preparación a «explotada»** | 23 | Alerta destructiva: **cierra los lotes abiertos con un ajuste y no se puede deshacer solo** + PIN de administrador |
| **Ajuste manual de inventario** | 21 | Motivo obligatorio + PIN de administrador; queda como movimiento con autorizador |
| **Reversar un retiro de caja** | 10 | `AlertDialog` + motivo + PIN de administrador. **El retiro no se borra**: queda con su reversa |
| **Deshacer una liquidación de domicilios** | 10 | `AlertDialog` + motivo obligatorio. **Sólo disponible en la misma sesión del navegador** |
| **Cambiar el perfil de funciones** | 35 | `AlertDialog` que advierte que **reinicia los flags de toda la organización** |
| **Apagar una función** (switch) | 35 | **Sin confirmación** — un toque apaga una capacidad de todo el restaurante |
| **Desactivar este dispositivo** | chrome POS | `AlertDialog` que explica que **la sede deja de poder vender hasta reactivar con el PIN de sede** |
| **Emitir una nota** (crédito/débito) | 31 | Motivo obligatorio; el documento original queda **reversado, nunca editado** |
| **Saldar una devolución pendiente** | 32 | Diálogo con elección explícita de origen del dinero |
| **Confirmar el reparto de propinas** | 27 | Diálogo con fecha, método y **de dónde sale la plata**; el texto aclara que es sólo constancia |
| **Liquidar un período de nómina** | 27 | Aviso fijo de que **no es la liquidación legal** |
| **Confirmar que un precio de compra es correcto** tras una guarda | 24 | Par de botones «Volver a revisar» / «Confirmar»; queda registrado con el nombre de quien confirmó |
| **Confirmar una discrepancia de factura** | 26 | Comparación papel vs. calculado + PIN de administrador con rótulo distinto |
| **Desactivar** un empleado, insumo, proveedor, preparación, categoría, zona, mesa, plataforma | 17, 21, 23, 24, 36 | **Sin confirmación** — pero es reversible (se reactiva) y nunca se borra |

---

# Verificación contra el router

La lista de 36 pantallas del pedido **coincide exactamente** con las rutas que monta `src/app/router.tsx`. No falta ni sobra ninguna. Lo que sí conviene anotar para el rediseño:

1. **Hay una ruta 37 que no es una pantalla:** el índice de `/pos` (`src/app/PosHome.tsx`) **no dibuja nada**: redirige a Mesas o a Comanda nueva según `pos.tables`. Y el índice de `/admin` redirige a `/admin/hoy`. Son decisiones de arranque, no pantallas, pero se pierden fácil.
2. **Dos pantallas de admin son «una ruta, varias entradas de navegación»:** Nómina (`/admin/nomina` + `/admin/nomina?tab=propinas`) y Analítica (`/admin/analitica` + `?tab=varianza` + `?tab=reposicion`). En la barra lateral se ven como **cinco secciones distintas**; en el router son **dos**.
3. **Seis pantallas guardan su pestaña en la URL** (`?tab=`): Inventario, Compras, Banco, Gastos, Nómina, Analítica. Y **varias tarjetas de «Hoy» y varios enlaces internos apuntan a una pestaña concreta, a veces con filtros** (`?tab=stock&below_min=1`). Si el rediseño renombra pestañas o parámetros, esos enlaces se rompen sin que nada falle visiblemente.
4. **Dos pantallas cambian de forma según un flag, sin cambiar de ruta:** el cierre del Turno (asistente de tres pasos vs. formulario de un paso, según `cash.blind_close`) y Nómina (qué pestañas y cuál es la inicial, según `payroll` / `pos.tips`).
5. **Hay un cruce admin → POS:** en Inventario → Lotes, un lote vencido ofrece **«Registrar merma (vencido)»**, que salta a `/pos/merma` — una ruta que el administrador, en su PC, normalmente no puede abrir.
