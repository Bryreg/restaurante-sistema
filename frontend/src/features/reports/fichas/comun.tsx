import { Link } from "react-router-dom"

import { DenseTable, DenseTableBar, GroupLabel, type DenseColumn } from "@/components/admin"
import { Badge } from "@/components/ui/badge"

import { fichaPersonaHref } from "./rutas"

/** Una persona con su enlace a la ficha y, si ya no está activa, la marca. */
export function PersonaLink({
  id,
  name,
  active,
}: {
  id: number
  name: string
  active?: boolean | null
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Link to={fichaPersonaHref(id)} className="text-primary hover:underline">
        {name}
      </Link>
      {active === false ? <Badge variant="destructive">inactivo</Badge> : null}
    </span>
  )
}

/**
 * Una sección de ficha: rótulo de grupo + tabla densa con su recuento, y un
 * vacío que dice qué no hubo (una noticia, no un hueco).
 */
export function SeccionFicha<R>({
  titulo,
  dice,
  sustantivo,
  vacio,
  columns,
  rows,
  rowKey,
}: {
  titulo: string
  dice: string
  sustantivo: string
  vacio: string
  columns: readonly DenseColumn<R>[]
  rows: readonly R[]
  rowKey: (row: R) => string
}): React.JSX.Element {
  return (
    <GroupLabel label={titulo} says={dice}>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">{vacio}</p>
      ) : (
        <DenseTable
          caption={titulo}
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          maxBodyHeightPx={340}
          bar={<DenseTableBar shown={rows.length} total={rows.length} noun={sustantivo} />}
        />
      )}
    </GroupLabel>
  )
}
