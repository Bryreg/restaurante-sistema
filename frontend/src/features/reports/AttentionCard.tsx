import type { LucideIcon } from "lucide-react"
import { ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

export type AttentionTone = "default" | "warning" | "critical"

export interface AttentionCardProps {
  title: string
  body: string
  to: string
  ctaLabel: string
  tone?: AttentionTone
  icon?: LucideIcon
}

const TONE_CLASS: Record<AttentionTone, string> = {
  default: "border-border",
  warning: "border-l-4 border-l-foreground/40 border-border",
  critical: "border-l-4 border-l-destructive border-border bg-destructive/5",
}

const TONE_ICON_CLASS: Record<AttentionTone, string> = {
  default: "text-muted-foreground",
  warning: "text-foreground",
  critical: "text-destructive",
}

/**
 * Tarjeta accionable de "Requiere tu atención" (SPEC-NEGOCIO §9.3: "cada
 * tarjeta lleva a la pantalla donde se resuelve"). El tono nunca es la
 * única señal: el título y el cuerpo ya dicen qué pasa, `tone` sólo
 * refuerza con borde/fondo + el mismo ícono en un color distinto.
 */
export function AttentionCard({ title, body, to, ctaLabel, tone = "default", icon: Icon }: AttentionCardProps): React.JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        "flex min-h-11 flex-col gap-1 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        TONE_CLASS[tone],
      )}
    >
      <div className="flex items-start gap-2">
        {Icon ? <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_ICON_CLASS[tone])} aria-hidden="true" /> : null}
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground">{body}</p>
        </div>
      </div>
      <span className="ml-6 inline-flex items-center gap-1 text-xs font-medium text-primary">
        {ctaLabel}
        <ArrowRight className="size-3" aria-hidden="true" />
      </span>
    </Link>
  )
}

export default AttentionCard
