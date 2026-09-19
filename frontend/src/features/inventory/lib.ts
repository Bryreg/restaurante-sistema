/**
 * Utilidades puras y compartidas de "Inventario": etiquetas, fechas de
 * filtro por defecto, el parser numérico de conteos y el formateador de
 * puntos básicos — nunca plata ni cantidades DERIVADAS de otra cosa
 * (AGENTS.md § "una sola matemática, en el backend": lo de acá formatea o
 * interpreta texto, no calcula un saldo, una varianza ni un food cost).
 * `todayLocal`/`daysAgoLocal` reexportan `todayInBogota`/`daysAgoInBogota` de
 * `features/reports/lib.ts` (mismo territorio de este agente) en vez de
 * duplicarlas — el hallazgo O-4 de 1b-2 fue justo esto: cada dominio
 * copiando su propio filtro de fechas.
 */
import type { LotStatus, MovementCause, WasteType } from "@/api/inventory"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

export const todayLocal = todayInBogota
export const daysAgoLocal = daysAgoInBogota

/** `app.inventory.models.MovementCause` en español. Enum cerrado — el
 * filtro de causa es SIEMPRE una lista, nunca un campo de texto libre
 * (AGENTS.md § "la causa no se infiere de un texto"). */
export const CAUSE_LABEL: Record<MovementCause, string> = {
  sale: "Venta",
  production_in: "Entrada por producción",
  production_out: "Salida por producción",
  void_after_send: "Anulación tras envío",
  waste: "Merma",
  note_return: "Nota — vuelve",
  manual_adjustment: "Ajuste manual",
  purchase: "Compra",
  count_adjustment: "Ajuste por conteo",
  reception_reversal: "Reversa de recepción",
  transfer_in: "Traslado — entrada (fase 3)",
  transfer_out: "Traslado — salida (fase 3)",
}

/** `app.inventory.models.WasteType`. No incluye "consumo de personal": eso
 * es un canal de comanda (`staff_meal`), nunca un tipo de merma. */
export const WASTE_TYPE_LABEL: Record<WasteType, string> = {
  expired: "Vencido",
  overproduction: "Sobreproducción",
  kitchen_error: "Error de cocina",
  breakage: "Rotura",
  customer_return: "Devolución de cliente",
  tasting: "Degustación",
  courtesy_no_dish: "Cortesía sin plato",
  unidentified: "Sin identificar",
}

/** `LotOut.status` (SPEC-NEGOCIO §5.7). Lista cerrada, los cuatro estados
 * que declara el backend — nunca se deriva `"expiring"`/`"expired"` a mano
 * comparando fechas acá (eso sería matemática de negocio en el cliente). */
export const LOT_STATUS_LABEL: Record<LotStatus, string> = {
  active: "Activo",
  expiring: "Por vencer",
  expired: "Vencido",
  depleted: "Agotado",
}

// ---------------------------------------------------------------------------
// Puntos básicos (formateo, nunca cálculo).
// ---------------------------------------------------------------------------

/**
 * Formatea un entero en puntos básicos REALES (100 = 1 %: `VarianceRowOut.
 * variance_pct_bp`, `WasteKpiOut.ratio`, `FoodCostOut.pct_bp`,
 * `ControlHealthOut.*_ratio_bp`, `InventorySettingsOut.*_threshold_bp` — la
 * MISMA escala en los cinco, `app/core/features` de este pedido) como
 * porcentaje con coma decimal, sin pasar por `Number()` para decidir la
 * precisión y sin ninguna otra escala (`/100`, `*100`) suelta en ningún otro
 * archivo de este territorio: éste es el ÚNICO lugar que sabe que 100 = 1 %.
 * `null` → `"—"` (nunca `0 %`, que en 2a fue justo el error que esta función
 * cierra en `WasteAdminTab`: `Math.round(kpi.ratio * 100)` asumía una
 * fracción 0..1, no puntos básicos).
 */
export function formatBasisPoints(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || Number.isNaN(bp)) return "—"
  const sign = bp < 0 ? "-" : ""
  const abs = Math.abs(bp)
  const whole = Math.floor(abs / 100)
  const frac = abs % 100
  const fracStr = frac === 0 ? "" : String(frac).padStart(2, "0").replace(/0+$/, "")
  return `${sign}${whole}${fracStr ? `,${fracStr}` : ""} %`
}

// ---------------------------------------------------------------------------
// Entrada numérica de conteos (SPEC-NEGOCIO §5.4, tal cual): campo de TEXTO
// con teclado decimal, coma como separador, y sumas del estilo "6+8"
// resueltas por un parser PROPIO — nunca `eval`/`Function`/una librería de
// expresiones genérica. Comodidad de captura, NUNCA autoridad: el servidor
// valida cada renglón otra vez con `app.core.quantity.parse_qty_base`, y
// esta función usa el MISMO límite de tres decimales (milésimas, `QTY_
// SCALE`) para que lo que el cliente acepta como válido sea justo lo que el
// servidor también acepta — nunca más permisivo.
// ---------------------------------------------------------------------------

export interface ParsedCountValue {
  valid: boolean
  /** Texto decimal normalizado con punto, listo para mandar al backend —
   * `null` cuando `valid` es `false`. */
  value: string | null
}

/** Un término: dígitos, opcionalmente coma o punto y hasta 3 decimales. Sin
 * signo — un conteo físico no es negativo. */
const COUNT_TERM_RE = /^\d+(?:[.,]\d{1,3})?$/

/**
 * Espejo declarado de `QTY_SCALE` en `backend/app/core/quantity.py`
 * (`QTY_SCALE = 1000`, milésimas de la unidad base) — NO una constante de
 * negocio inventada acá. Se declara con nombre propio, y no como un `1000`
 * desnudo en medio de la cuenta, para dejar dicho en un solo lugar, con su
 * comentario, las tres cosas que la Ronda 2 (H-7) pide que consten:
 *
 * 1. Es un ESPEJO: si el backend cambiara su escala, este archivo tendría
 *    que cambiar con él — hoy nada lo sincroniza automáticamente (mismo
 *    tipo de hueco que 2a dejó documentado para la escala de costo).
 * 2. La matemática AUTORITATIVA es siempre del servidor: esta pantalla
 *    manda SIEMPRE texto decimal a `PUT /admin/counts/{id}/lines` — nunca
 *    un número — y `app.core.quantity.parse_qty_base` vuelve a validar
 *    cada renglón del lado del servidor y **rechaza con 422** cualquier
 *    término que exceda esta misma precisión (más de 3 decimales).
 * 3. La suma local de `parseCountInput` (el parser "6+8" de SPEC-NEGOCIO
 *    §5.4) es sólo AYUDA DE TECLEO — le ahorra un viaje de red a quien
 *    cuenta — nunca una cifra de negocio: no se muestra en ningún reporte,
 *    no se guarda tal cual, y el peor caso de un desfasaje acá es un `422`
 *    de más, nunca un dato mal guardado (el servidor manda).
 *
 * DECISIÓN DEL ORQUESTADOR (H-7, Ronda 2): la calculadora de sumas se
 * QUEDA — contar "6+8 cajas" es ergonomía real de conteo físico — y esta
 * excepción al barrido de escala se declara acá, por escrito, en vez de
 * esquivarla. La excepción formal en el barrido del OpenAPI la declara
 * `auditor-costos-2b` (no este archivo, no `frontend/src/audit/**`, fuera
 * de mi territorio) contra este símbolo exacto: `features/inventory/
 * lib.ts :: COUNT_QTY_SCALE` / `parseCountInput`.
 */
export const COUNT_QTY_SCALE = 1000

export function parseCountInput(raw: string): ParsedCountValue {
  const text = raw.trim()
  if (text === "") return { valid: false, value: null }
  const terms = text.split("+").map((t) => t.trim())
  if (terms.some((t) => !COUNT_TERM_RE.test(t))) return { valid: false, value: null }

  // Se suma en milésimas ENTERAS (`COUNT_QTY_SCALE`, espejo de `QTY_SCALE`
  // del servidor), nunca en `float` de punto flotante acumulado:
  // "0.1+0.2" tiene que dar exactamente "0.3", no "0.30000000000000004"
  // (AGENTS.md, el bug que "nadie encuentra").
  const scaledSum = terms.reduce(
    (acc, term) => acc + Math.round(Number(term.replace(",", ".")) * COUNT_QTY_SCALE),
    0,
  )
  const whole = Math.floor(scaledSum / COUNT_QTY_SCALE)
  const frac = scaledSum % COUNT_QTY_SCALE
  const fracStr = frac === 0 ? "" : String(frac).padStart(3, "0").replace(/0+$/, "")
  return { valid: true, value: fracStr ? `${whole}.${fracStr}` : `${whole}` }
}
