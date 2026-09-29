/**
 * Imprime etiquetas desde el navegador de la tablet: arma una página del
 * tamaño exacto del rollo (`@page`, en milímetros, lo que dice Ajustes ›
 * Inventario › Etiquetas) y la manda a la impresora con el diálogo del
 * sistema. Sirve con cualquier impresora de etiquetas que el sistema
 * operativo de la tablet vea (Wi‑Fi con AirPrint o Mopria, o su driver en
 * Windows): no hay controlador propio que instalar.
 *
 * El QR lleva `ET-<código>`: el lector de la pantalla y cualquier pistola
 * lectora lo entienden igual (el servidor acepta el código con o sin `ET`).
 */
import qrcode from "qrcode-generator"

import type { FoodLabel, LabelKind } from "@/api/labels"
import { formatClockTime } from "@/lib/businessDate"
import { formatFechaCorta } from "@/lib/format"

export interface LabelSize {
  width_mm: number
  height_mm: number
}

export const KIND_LABEL: Record<LabelKind, string> = {
  received: "Recibido",
  opened: "Abierto",
  produced: "Producido",
}

/** Lo que va dentro del QR. */
export function qrPayload(code: string): string {
  return `ET-${code}`
}

/** El QR como `<svg>` que escala a su contenedor. */
export function qrSvg(code: string): string {
  const qr = qrcode(0, "M")
  qr.addData(qrPayload(code), "Alphanumeric")
  qr.make()
  return qr.createSvgTag({ cellSize: 1, margin: 0, scalable: true })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** «Luz Marina Gómez» → «Luz M.»: la etiqueta es chica. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return name.trim()
  return `${parts[0]} ${parts[1].charAt(0)}.`
}

/** El «usar antes de» como se imprime: «vie 3 oct» o «Sin vencimiento». */
export function formatUseBy(label: Pick<FoodLabel, "use_by">): string {
  return label.use_by ? formatFechaCorta(label.use_by) : "Sin vencimiento"
}

/** «2026-09-29» → «29 sep» (sin el día de la semana: la etiqueta es chica). */
export function shortDate(iso: string): string {
  return formatFechaCorta(iso).replace(/^\S+\s/, "")
}

/** «2:20 p. m.» → «2:20 pm». */
export function shortTime(iso: string): string {
  return formatClockTime(iso).replace(" a. m.", " am").replace(" p. m.", " pm")
}

/** El código legible, en dos grupos de cuatro: «K7Q2 M9XH». */
export function codeText(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

/** El HTML de UNA etiqueta. Exportado para probarlo. */
export function labelHtml(label: FoodLabel): string {
  const made = `${KIND_LABEL[label.kind]} ${shortDate(label.business_date)} ${shortTime(label.made_at)}`
  const extra = [label.lot_code ? `Lote ${label.lot_code}` : null, label.qty_text].filter(Boolean).join(" · ")
  return `<section class="label">
  <div class="qr">${qrSvg(label.code)}</div>
  <div class="text">
    <div class="name">${escapeHtml(label.item_name)}</div>
    <div class="useby"><span>Usar antes de</span><strong>${escapeHtml(formatUseBy(label))}</strong></div>
    <div class="meta">${escapeHtml(made)}</div>
    ${extra ? `<div class="meta">${escapeHtml(extra)}</div>` : ""}
    <div class="meta">${escapeHtml(shortName(label.employee_name))} · ${escapeHtml(codeText(label.code))}</div>
  </div>
</section>`
}

/** El documento completo, una etiqueta por página del tamaño del rollo. */
export function labelsDocument(labels: readonly FoodLabel[], size: LabelSize): string {
  const w = size.width_mm
  const h = size.height_mm
  // Las letras escalan con el alto del rollo (30 mm es la referencia).
  const k = Math.max(0.7, Math.min(2, h / 30))
  const pt = (n: number) => `${(n * k).toFixed(1)}pt`
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas</title><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label { width: ${w}mm; height: ${h}mm; padding: 1.2mm; display: flex; gap: 1.5mm; overflow: hidden; page-break-after: always; break-after: page; }
.label:last-child { page-break-after: auto; break-after: auto; }
.qr { flex: 0 0 auto; width: ${Math.min(h - 2.4, w * 0.42).toFixed(1)}mm; height: ${Math.min(h - 2.4, w * 0.42).toFixed(1)}mm; align-self: center; }
.qr svg { width: 100%; height: 100%; display: block; }
.text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; }
.name { font-weight: 700; font-size: ${pt(8.5)}; line-height: 1.1; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.useby { line-height: 1.05; }
.useby span { display: block; font-size: ${pt(5.5)}; text-transform: uppercase; letter-spacing: .02em; }
.useby strong { display: block; font-size: ${pt(11)}; }
.meta { font-size: ${pt(5.8)}; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head><body>${labels.map(labelHtml).join("\n")}</body></html>`
}

/**
 * Manda las etiquetas a la impresora. Devuelve `false` si el navegador no
 * puede imprimir (una prueba, un navegador sin `print`): la pantalla avisa
 * y la etiqueta sigue guardada para reimprimirla.
 */
export function printLabels(labels: readonly FoodLabel[], size: LabelSize): boolean {
  if (labels.length === 0 || typeof document === "undefined") return false
  const frame = document.createElement("iframe")
  frame.setAttribute("aria-hidden", "true")
  frame.style.position = "fixed"
  frame.style.right = "0"
  frame.style.bottom = "0"
  frame.style.width = "0"
  frame.style.height = "0"
  frame.style.border = "0"
  document.body.appendChild(frame)
  const win = frame.contentWindow
  const doc = win?.document
  if (!win || !doc || typeof win.print !== "function") {
    frame.remove()
    return false
  }
  doc.open()
  doc.write(labelsDocument(labels, size))
  doc.close()
  const cleanup = () => window.setTimeout(() => frame.remove(), 1000)
  win.addEventListener("afterprint", cleanup, { once: true })
  window.setTimeout(() => {
    try {
      win.focus()
      win.print()
    } catch {
      frame.remove()
    }
  }, 150)
  // Por si `afterprint` nunca llega (algunos navegadores de tablet).
  window.setTimeout(() => frame.remove(), 60_000)
  return true
}
