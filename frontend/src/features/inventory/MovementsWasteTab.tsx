import { useSession } from "@/app/session"
import type { IngredientOut } from "@/api/inventory"
import { EmptyState } from "@/components/EmptyState"

import { AdjustmentDialog } from "./AdjustmentDialog"
import { MovementsPanel } from "./MovementsPanel"
import { WasteAdminTab } from "./WasteAdminTab"

/**
 * Admin → Inventario → Movimientos y mermas (SPEC-NEGOCIO §5.1 / §5.5 /
 * §9.3): el libro por insumo con su ajuste manual, y las mermas por tipo y
 * responsable — la merma vive detrás de `inventory.waste` (que a su vez
 * depende de `inventory.perpetual`, `backend/app/core/features.py`); si
 * está apagada se explica qué la prende, en vez de una tabla vacía sin
 * contexto.
 */
export function MovementsWasteTab({ storeId, ingredients }: { storeId: number; ingredients: IngredientOut[] }): React.JSX.Element {
  const { hasFeature } = useSession()
  const wasteEnabled = hasFeature("inventory.waste")

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Libro de movimientos</h2>
          <AdjustmentDialog storeId={storeId} ingredients={ingredients} />
        </div>
        <MovementsPanel ingredients={ingredients} />
      </section>

      <section className="space-y-3 border-t pt-6">
        <h2 className="text-sm font-semibold">Mermas</h2>
        {wasteEnabled ? (
          <WasteAdminTab storeId={storeId} ingredients={ingredients} />
        ) : (
          <EmptyState
            title="Registro de mermas no está habilitado"
            description="Activá «Registro de mermas» en Admin → Funciones para ver esta sección."
          />
        )}
      </section>
    </div>
  )
}

export default MovementsWasteTab
