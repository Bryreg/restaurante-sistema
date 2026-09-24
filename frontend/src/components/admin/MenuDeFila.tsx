import { Ellipsis } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

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
 */
export function MenuDeFila({
  nombre,
  children,
}: {
  nombre: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Acciones de ${nombre}`} />
        }
      >
        <Ellipsis className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default MenuDeFila
