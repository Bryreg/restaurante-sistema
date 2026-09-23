/** Las marcas de la confiabilidad (umbrales y formato en `./reliability`). */
import { CircleAlert, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

import { MUESTRA_CHICA_RECEPCIONES, type Tono } from "./reliability"

const EXPLICA: Record<Exclude<Tono, "none">, string> = {
  warning: "Fuera del umbral: pide mirarlo",
  critical: "Muy fuera del umbral: plata que se pierde",
}

/** Una cifra con su tono: color + ícono + `title` (el color nunca va solo). */
export function Indicador({ tono, children }: { tono: Tono; children: React.ReactNode }): React.JSX.Element {
  const Icono = tono === "critical" ? CircleAlert : TriangleAlert
  return (
    <span
      data-tono={tono}
      title={tono === "none" ? undefined : EXPLICA[tono]}
      className={cn(
        "inline-flex items-center justify-end gap-1 whitespace-nowrap",
        tono === "critical" && "font-semibold text-destructive",
        tono === "warning" && "font-semibold text-warning",
      )}
    >
      {tono === "none" ? null : <Icono className="size-3.5 shrink-0" aria-label={EXPLICA[tono]} />}
      {children}
    </span>
  )
}

/** Recepciones con la marca de muestra chica. */
export function Recepciones({ n }: { n: number }): React.JSX.Element {
  if (n >= MUESTRA_CHICA_RECEPCIONES) return <span>{n}</span>
  return (
    <span className="whitespace-nowrap" title={`Con menos de ${MUESTRA_CHICA_RECEPCIONES} recepciones un pedido raro mueve todo`}>
      {n} <span className="text-xs text-muted-foreground italic">muestra chica</span>
    </span>
  )
}
