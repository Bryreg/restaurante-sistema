import { ChevronDown, ChevronUp, type LucideIcon } from "lucide-react"
import { useId, useState } from "react"
import { Link } from "react-router-dom"

import { DenseTable, DenseTableBar, GroupLabel, type DenseColumn } from "@/components/admin"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

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
  ancha,
}: {
  titulo: string
  dice: string
  sustantivo: string
  vacio: string
  columns: readonly DenseColumn<R>[]
  rows: readonly R[]
  rowKey: (row: R) => string
  /** En la grilla de dos columnas del detalle, ocupa las dos (tablas anchas). */
  ancha?: boolean
}): React.JSX.Element {
  return (
    <GroupLabel label={titulo} says={dice} className={cn(ancha && "lg:col-span-2")}>
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

/**
 * El «Ver…» plegable de las fichas (handoff: «Ver el detalle del turno»,
 * «Ver conteos y libro de movimientos»): un botón de 36 px que abre, debajo,
 * la grilla de dos columnas con las tablas. Plegado de entrada: la ficha
 * cuenta primero lo que pasó y las tablas quedan para quien las pide.
 */
export function DetallePlegable({
  texto,
  children,
}: {
  texto: string
  children: React.ReactNode
}): React.JSX.Element {
  const [abierto, setAbierto] = useState(false)
  const id = useId()
  const Icono = abierto ? ChevronUp : ChevronDown
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={abierto}
        aria-controls={id}
        onClick={() => setAbierto((v) => !v)}
        className="inline-flex h-9 items-center gap-2 self-start rounded-md border bg-card px-3 text-sm font-semibold text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Icono className="size-4 shrink-0" aria-hidden="true" />
        {abierto ? "Ocultar el detalle" : texto}
      </button>
      <div id={id} hidden={!abierto} className="grid items-start gap-[18px] lg:grid-cols-2">
        {children}
      </div>
    </section>
  )
}

/**
 * La cabecera de las fichas de persona e insumo (handoff, pantalla 10): el
 * avatar de 56 px —redondo con iniciales para una persona, cuadrado con
 * ícono para un insumo— al lado del `PageHeader` de siempre.
 */
export function AvatarFicha({
  texto,
  icono: Icono,
  forma,
}: {
  texto?: string
  icono?: LucideIcon
  forma: "persona" | "cosa"
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-14 shrink-0 place-items-center bg-secondary text-xl font-extrabold text-secondary-foreground",
        forma === "persona" ? "rounded-full" : "rounded-lg",
      )}
    >
      {Icono ? <Icono className="size-6" /> : texto}
    </span>
  )
}

/** El renglón de las tarjetas de estado de una ficha: cuatro por fila. */
export function FilaDeTarjetas({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">{children}</div>
}

/** Una sección de ficha con su pregunta como título (h2 de 18 px). */
export function PreguntaFicha({
  titulo,
  children,
}: {
  titulo: string
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <h2 id={id} className="text-lg leading-snug font-bold">
        {titulo}
      </h2>
      {children}
    </section>
  )
}
