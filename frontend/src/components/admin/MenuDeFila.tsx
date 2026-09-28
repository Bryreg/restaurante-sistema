import { Ellipsis } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/**
 * **Las acciones de una fila, en un menú «⋯»** (mapa de pantallas, regla 3:
 * «Editar y Desactivar van en un menú ⋯»). La tabla de proveedores mostraba
 * tres botones por fila —Confiabilidad, Editar, Desactivar—, 24 botones en
 * ocho filas, y la vista se iba a los botones antes que a los datos.
 *
 * Los ítems los escribe el sitio de llamada como `<DropdownMenuItem>` con el
 * rótulo literal adentro: así `src/audit/censo-controles.test.ts` los sigue
 * viendo (el censo lee el código, no el DOM). Un arreglo de rótulos acá
 * adentro los escondería.
 *
 * `nombre` es de qué fila son las acciones: el botón se llama «Acciones de
 * Fruver La Cosecha», no ocho veces «Acciones».
 *
 * `nota` es el pie del menú (handoff, pantalla 12): «Nada se borra: los
 * ajustes quedan en el libro con motivo». Con nota el menú mide 230 px, que
 * es lo que deja la frase en dos renglones y los ítems en uno.
 */
export function MenuDeFila({
  nombre,
  nota,
  children,
}: {
  nombre: string
  nota?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // 28 px dentro de la fila de 34: el botón no la hace crecer.
            className="size-7 min-h-0 min-w-0 text-muted-foreground data-[popup-open]:bg-muted"
            aria-label={`Acciones de ${nombre}`}
          />
        }
      >
        <Ellipsis className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={cn(nota ? "w-[230px]" : "w-auto min-w-40")}>
        {children}
        {nota ? (
          <p className="mx-2 mt-1 mb-1 text-[11px] leading-snug whitespace-normal text-muted-foreground">{nota}</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default MenuDeFila
