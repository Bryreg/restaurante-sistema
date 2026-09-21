import { useSession } from "@/app/session"
import type { IngredientOut } from "@/api/inventory"
import { FeatureOffEmptyState, GroupLabel } from "@/components/admin"

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
 *
 * Las dos secciones llevan **rótulo de grupo** (`docs/PATRONES-ADMIN.md`
 * § 3): una grilla uniforme aplanaría dos cosas de naturaleza distinta —el
 * libro es **todo** lo que movió el saldo, la merma es **una** de sus
 * causas, la única que además se fotografía y se atribuye—.
 */
export function MovementsWasteTab({
  storeId,
  ingredients,
}: {
  storeId: number
  ingredients: IngredientOut[]
}): React.JSX.Element {
  const { hasFeature } = useSession()
  const wasteEnabled = hasFeature("inventory.waste")

  return (
    <div className="space-y-6">
      <GroupLabel
        label="Libro de movimientos"
        says="todo lo que movió el saldo de un insumo, con su causa tipada"
      >
        <div className="mb-2 flex justify-end">
          <AdjustmentDialog storeId={storeId} ingredients={ingredients} />
        </div>
        <MovementsPanel ingredients={ingredients} />
      </GroupLabel>

      <GroupLabel label="Mermas" says="una de esas causas: lo que se perdió, con responsable y foto">
        {wasteEnabled ? (
          <WasteAdminTab storeId={storeId} ingredients={ingredients} />
        ) : (
          <FeatureOffEmptyState
            feature="Registro de mermas"
            flag="inventory.waste"
            description="Sin ella lo que se pierde no se registra por separado: sale del stock, pero nadie sabe si fue vencimiento, rotura o error de cocina."
          />
        )}
      </GroupLabel>
    </div>
  )
}

export default MovementsWasteTab
