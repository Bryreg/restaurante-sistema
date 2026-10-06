/**
 * Aviso de «plato listo» en Mesas (auditoría p4). El conteo de platos listos
 * sin servir es del servidor (`TableStatusOut.ready_count`, que Mesas ya
 * consulta cada pocos segundos); acá sólo se compara una lectura con la
 * anterior para saber a qué mesa le llegó algo NUEVO desde cocina. La
 * primera lectura es la base: abrir Mesas no avisa lo que ya estaba listo
 * (eso lo dice la insignia verde de cada mesa).
 */
import type { ZoneStatusOut } from "@/api/orders"

export interface ReadyAlert {
  tableId: number
  tableNumber: string
  orderId: number | null
  /** Cuántos platos listos tiene la mesa ahora (el número del servidor). */
  readyCount: number
}

export type ReadyCounts = Map<number, number>

export function readyCountsOf(zones: ZoneStatusOut[]): ReadyCounts {
  const out: ReadyCounts = new Map()
  for (const zone of zones) for (const table of zone.tables ?? []) out.set(table.id, table.ready_count ?? 0)
  return out
}

/**
 * Las mesas cuyo conteo de listos SUBIÓ entre `prev` y `zones`. Sin lectura
 * anterior (`prev === null`) no hay aviso: es la base.
 */
export function newlyReady(prev: ReadyCounts | null, zones: ZoneStatusOut[]): ReadyAlert[] {
  if (prev === null) return []
  const alerts: ReadyAlert[] = []
  for (const zone of zones) {
    for (const table of zone.tables ?? []) {
      const now = table.ready_count ?? 0
      const before = prev.get(table.id) ?? 0
      if (now > before) {
        alerts.push({
          tableId: table.id,
          tableNumber: table.number ?? String(table.id),
          orderId: table.order_id ?? null,
          readyCount: now,
        })
      }
    }
  }
  return alerts
}

/**
 * Junta los avisos nuevos con los que siguen en pantalla: una mesa tiene un
 * solo aviso (el más reciente), y un aviso cuya mesa ya no tiene nada listo
 * (lo sirvieron) se va solo.
 */
export function mergeAlerts(current: ReadyAlert[], incoming: ReadyAlert[], counts: ReadyCounts): ReadyAlert[] {
  const byTable = new Map<number, ReadyAlert>()
  for (const alert of current) if ((counts.get(alert.tableId) ?? 0) > 0) byTable.set(alert.tableId, alert)
  for (const alert of incoming) byTable.set(alert.tableId, alert)
  return [...byTable.values()]
}
