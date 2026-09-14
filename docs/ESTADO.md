# Restaurante Sistema — estado del proyecto

Documento de referencia para retomar el trabajo sin reconstruir el contexto.
Última actualización: 2026-09-14 (adopción del framework sistemas-maestros 2.0.0;
spec de negocio v0.3 en borrador, todavía sin código).

**Este documento es VIVO.** Si un cambio altera una regla o un flujo descrito acá,
se actualiza en el MISMO PR que el cambio. Un estado desactualizado miente con más
autoridad que no tener estado.

---

## Cómo corre

Todavía no hay código. Cuando la fase 1 lo cree, la forma esperada es la del
`.claude/launch.json` (que hoy es la plantilla del framework y hay que ajustar):

| Servicio | Directorio | Comando | Puerto |
|---|---|---|---|
| backend | `backend/` | `uvicorn app.main:app --reload --port 8000` | 8000 |
| frontend | `frontend/` | `npm run dev -- --port 5173` | 5173 |

Variables de entorno previstas: `DATABASE_URL` (SQLite por defecto en desarrollo),
`JWT_SECRET`, `DEVICE_PIN_<sede>` o equivalente para activar dispositivos,
`TZ=America/Bogota`. Ninguna credencial va al repo.

## Reglas duras

Las decisiones que no se renegocian están en `docs/SPEC-NEGOCIO.md § 11`. Las que
más fácil se rompen sin que se vea en pantalla:

- **Gates en el backend, no en la UI**: sin turno abierto no hay venta; sin
  justificación no cierra un turno con diferencia; anular un ítem enviado o una
  venta cobrada exige motivo y PIN de administrador.
- **Snapshot en el ítem**: precio, impuesto, costo teórico y receta usada se
  congelan al vender. Los reportes nunca revaloran ventas pasadas con la carta
  actual.
- **Un solo descuento de insumo**: al producir la preparación o al enviar el plato,
  nunca ambos.
- **Fecha operativa de negocio** (`America/Bogota`) en columna propia; nunca
  derivada de un timestamp UTC.
- **Nada financiero ni de inventario se borra**: baja lógica + auditoría.
- **Propina separada** de la venta y del impuesto.
- **Sesión en cookie `httpOnly`**; nada sensible en `localStorage`.
- **Cobro, envío y producción idempotentes** (`Idempotency-Key` reservada dentro de
  la transacción) y `409` ante concurrencia.
- **La reserva de caja se declara aparte** y no entra al esperado (Palmetto, 15-ago
  en la referencia).
- **Una sola matemática en el backend**; el frontend no deriva plata; `null` ≠ 0.
- **Causa tipada** en movimientos de caja e inventario.
- **Atribución con FK real** (`employee_id`) más nombre congelado; empleados nunca
  se borran.

## Glosario español ↔ código

La UI habla español y el código inglés. Para que nadie invente un tercer nombre:

| En la UI / en los docs | En el código |
|---|---|
| sede | `store` |
| día operativo | `business_day` |
| turno de caja | `shift` |
| empleado / operador | `employee` (rol `operator`), `admin` |
| mesa / zona | `table` / `zone` |
| comanda | `order` |
| ítem de comanda | `order_item` |
| canal (mesa, para llevar, domicilio) | `channel` (`dine_in`, `takeout`, `delivery`) |
| cobro / pago | `payment` |
| propina | `tip` |
| tiquete | `ticket` |
| nota crédito | `credit_note` |
| insumo | `ingredient` |
| preparación / lote | `prep` / `prep_batch` |
| plato / producto | `product` |
| ficha técnica (receta) | `recipe` |
| modificador | `modifier_group` / `modifier_option` |
| combo | `combo` |
| movimiento de inventario | `stock_movement` |
| merma | `waste` |
| conteo | `stock_count` |
| recepción de compra | `purchase_receipt` |
| cuenta por pagar | `payable` |
| movimiento de caja | `cash_movement` |
| retiro de efectivo | `cash_pickup` |
| relevo (cuadre sin cerrar) | `shift_handover` |
| reserva de caja | `cash_reserve` |
| hora de corte | `cutoff_hour` |
| rescate (cierre administrativo, reabrir, cancelar, ajustar apertura) | `admin_rescue` (`close_administrative`, `reopen`, `cancel`, `adjust_opening`) |
| estación de cocina | `station` |
| curso (bebida, entrada, fuerte, postre) | `course` |
| ronda (envío a cocina) | `round` |
| cuenta presentada / precuenta | `bill_presented_at` / `pre_bill` |
| sub-cuenta (división) | `sub_account` |
| documento fiscal (equivalente POS, factura, nota) | `fiscal_document` (`pos_equivalent`, `invoice`, `adjustment_note`, `credit_note`) |
| rango de numeración DIAN | `fiscal_range` |
| adquirente / cliente | `customer` |
| consumo de personal | `staff_meal` (canal de comanda) |
| cambio (sencilla) | `cash_swap` |
| arqueo sorpresa | `spot_check` (tipo de `shift_handover`) |
| responsable de caja | `cash_responsible` |
| supervisor / encargado | `supervisor` |
| devolución pendiente | `pending_refund` |
| base fija | `opening_cash_fixed` |
| causa de un movimiento | `cause` |
| proveedor | `supplier` |
| lote | `stock_batch` |
| consignación | `bank_deposit` |

## Qué está hecho

- **Adopción del framework** (2026-09-14): `.claude/` copiado desde
  sistemas-maestros 2.0.0 con `scripts/adoptar.sh`; versión estampada en
  `.claude/FRAMEWORK`.
- **Spec de negocio** en `docs/SPEC-NEGOCIO.md`, versión 0.3, escrita sobre la
  lectura por subsistema del proyecto de referencia `cafe-sistema` (caja y turnos,
  inventario y recetas, POS, plata y admin, lecciones del go-live), tres
  investigaciones de dominio (fiscal y legal, operación de piso y cocina, control
  interno) y un crítico de completitud que verificó las afirmaciones dudosas contra
  el código de la referencia. Pendiente de aprobación del dueño.
- **Specs de los pedidos 1a y 1b** en `features/fase-1a-cimientos/spec.md` y
  `features/fase-1b-venta/spec.md`, con el contrato de API para que backend y
  frontend construyan en paralelo contra lo mismo.
- **AGENTS.md** con lo que este proyecto se aparta del framework: régimen fiscal
  colombiano, PIN personal sobre dispositivo compartido, fecha operativa en Bogotá.

## Dónde retomar

1. **Aprobar la spec** (`docs/SPEC-NEGOCIO.md`), en particular las preguntas
   marcadas [MODELO] de la sección 15. Sin eso no se lanza nada.
2. **Crear el repositorio en GitHub** (`Bryreg/<nombre>`) y subir esta rama.
   Después, agregar la fila del proyecto en `docs/PROYECTOS.md` del framework.
3. **Lanzar el pedido 1a** con el orquestador (y después el 1b sobre lo entregado):
   ```js
   Workflow({
     scriptPath: '.claude/workflows/orquestador-general.js',
     args: {
       pedido: '<el pedido 1a, sección 14 de la spec>',
       spec: 'features/fase-1a-cimientos/spec.md',
       outputs: 'features/fase-1a-cimientos/outputs',
       contexto: ['docs/ESTADO.md', 'AGENTS.md', 'docs/SPEC-NEGOCIO.md'],
     },
   })
   ```
4. Cuando exista código: ajustar `.claude/launch.json` a los comandos reales y
   reemplazar la sección «Cómo corre» de este documento.
