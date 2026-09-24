import { ChevronDown } from "lucide-react"

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface PestanaDeMas {
  value: string
  label: string
}

/**
 * **«Más ▾» al final de una fila de pestañas** (mapa de pantallas, regla 4:
 * «tres pestañas como máximo por pantalla»). Va adentro del `TabsList`,
 * después de las tres pestañas que se usan todos los días; las demás se
 * eligen desde acá. No se pierde ninguna ni cambia su `?tab=`: los enlaces
 * con filtro de Hoy siguen llegando a la misma pestaña, y cuando la pestaña
 * activa es una de éstas el botón la nombra —«Más: Lotes»— para que se sepa
 * dónde se está parado.
 *
 * Los rótulos viajan como `label: "…"` en el sitio de llamada, que es una de
 * las formas que el censo de controles lee.
 */
export function MasPestanas({
  value,
  onValueChange,
  items,
}: {
  value: string
  onValueChange: (value: string) => void
  items: readonly PestanaDeMas[]
}): React.JSX.Element | null {
  if (items.length === 0) return null
  const activa = items.find((item) => item.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-[calc(100%-1px)] items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          activa ? "bg-background text-foreground shadow-sm" : "text-foreground/60",
        )}
      >
        {activa ? `Más: ${activa.label}` : "Más"}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        {items.map((item) => (
          <DropdownMenuItem key={item.value} onClick={() => onValueChange(item.value)}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default MasPestanas
