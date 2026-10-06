import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { listIngredients } from "@/api/inventory"
import { Cargando } from "@/components/Cargando"
import { FeatureOffEmptyState, GroupLabel, MasPestanas, PageHeader, type PestanaDeMas } from "@/components/admin"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SustainedHealthTab } from "@/features/analytics/SustainedHealthTab"
import { VarianceByDishTab } from "@/features/analytics/VarianceByDishTab"
import { LabelsAdminTab } from "@/features/labels/LabelsAdminTab"

import { AreaCountsTab } from "./AreaCountsTab"
import { ControlHealthTab } from "./ControlHealthTab"
import { CountsTab } from "./CountsTab"
import { IngredientsTab } from "./IngredientsTab"
import { LineaDeTiempoTab } from "./LineaDeTiempoTab"
import { LotsTab } from "./LotsTab"
import { MovementsWasteTab } from "./MovementsWasteTab"
import { StockTab } from "./StockTab"
import { VarianceTab } from "./VarianceTab"
import { WasteAnalysisTab } from "./WasteAnalysisTab"

const ALL_TABS = ["insumos", "stock", "linea", "movimientos", "conteos", "por-area", "varianza", "lotes", "etiquetas", "salud", "mermas"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

/**
 * El recuento al lado del nombre de la pestaña, como en la maqueta
 * («Insumos 47»). Va en un `<sup>` apagado y **nunca dentro del texto del
 * rótulo**: el valor de la pestaña —y con él el `?tab=` de la URL y los
 * enlaces de Hoy— no cambia porque cambie un número.
 */
function TabCount({ n }: { n: number | undefined }): React.JSX.Element | null {
  if (n === undefined) return null
  return <sup className="text-[0.7em] font-normal tabular-nums opacity-70">{n}</sup>
}

/**
 * Admin → Inventario (SPEC-NEGOCIO §9.3): Insumos, Stock, Movimientos y
 * mermas, y — pedido 2b — Conteos, Varianza, Lotes y Salud del control.
 * Detrás de `inventory.perpetual` en la navegación
 * (`inventoryFeature.adminNav`) — si alguien llega igual a la ruta con la
 * función apagada, esta pantalla explica qué la prende en vez de romperse
 * contra un `400 FEATURE_DISABLED`.
 *
 * Las cuatro pestañas de 2b se arman desde `hasFeature` de la sesión, cada
 * una detrás de SU flag (`app/core/features.py`): `inventory.counts` y
 * `inventory.lots` (`inventory.perpetual` ya lo exige el gate de toda la
 * página); `inventory.variance` requiere `inventory.counts`, y
 * "Salud del control" comparte esa misma flag porque
 * `GET /admin/control-health` está detrás de `inventory.variance` en el
 * backend (`app/inventory/router.py::get_control_health`). Si el `tab=` de
 * la URL apunta a una pestaña apagada, cae a "Insumos" en vez de mostrar un
 * panel roto.
 *
 * A la vista van las tres de todos los días —Insumos, Stock y Conteos—; el
 * resto se elige desde «Más» (mapa de pantallas, regla 4). Mover una
 * pestaña a «Más» no cambia su `?tab=`.
 *
 * `tab`/`below_min`/`negative` en la query string: así "Hoy" puede enlazar
 * directo a "Stock" filtrado por negativos o bajo mínimo (cada alerta de
 * "Requiere tu atención" lleva a la pantalla que la resuelve, ya con el
 * filtro puesto — SPEC-NEGOCIO §9.3).
 */
export function InventoryAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const enabled = hasFeature("inventory.perpetual")
  // Las pestañas se arman desde los flags de la sesión (AGENTS.md): cada
  // dependencia YA está declarada en `app/core/features.py` y acá sólo se
  // refleja — `inventory.counts`/`inventory.lots` requieren
  // `inventory.perpetual` (ya cubierto por el gate de toda la página);
  // `inventory.variance` requiere `inventory.counts`.
  const countsEnabled = hasFeature("inventory.counts")
  const varianceEnabled = hasFeature("inventory.variance")
  const lotsEnabled = hasFeature("inventory.lots")
  // Conteo corto por área (2026-09-25): requiere `inventory.perpetual`, que
  // ya es el gate de toda la página.
  const areaCountsEnabled = hasFeature("inventory.shift_counts")
  // Etiquetas de cocina (0036): requiere `inventory.lots`.
  const labelsEnabled = hasFeature("inventory.labels")
  // Análisis de mermas (tanda 5, i6): detrás de `inventory.waste`.
  const wasteEnabled = hasFeature("inventory.waste")

  const tabParam = searchParams.get("tab")
  const requestedTab: TabValue = isTabValue(tabParam) ? tabParam : "insumos"
  const tabAvailable: Record<TabValue, boolean> = {
    insumos: true,
    stock: true,
    linea: true,
    movimientos: true,
    conteos: countsEnabled,
    "por-area": areaCountsEnabled,
    varianza: varianceEnabled,
    lotes: lotsEnabled,
    etiquetas: labelsEnabled,
    salud: varianceEnabled,
    mermas: wasteEnabled,
  }
  const tab: TabValue = tabAvailable[requestedTab] ? requestedTab : "insumos"

  const ingredientsQuery = useQuery({
    queryKey: ["inventory", "ingredients", activeStoreId, false],
    queryFn: () => listIngredients(activeStoreId as number, { activeOnly: true }),
    enabled: enabled && activeStoreId !== null,
  })

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    // Patrón 13, motivo «función apagada»: la entrada de navegación
    // desaparece con el flag, pero **la URL sobrevive** en un marcador del
    // dueño y en los avisos de Hoy — por eso esta pantalla no puede
    // limitarse a no existir, y el vacío nombra la función y lleva a
    // encenderla.
    return (
      <FeatureOffEmptyState
        feature="Movimientos de inventario y stock teórico"
        flag="inventory.perpetual"
        description="Sin ella no hay stock teórico, ni movimientos, ni conteos: las compras entran y las recetas descuentan, pero nadie lleva el saldo."
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const ingredients = ingredientsQuery.data ?? []

  function cambiarPestana(value: string) {
    const next = new URLSearchParams(searchParams)
    next.set("tab", value)
    setSearchParams(next, { replace: true })
  }

  // Las que no son de todos los días: movimientos (cuando hay conteos),
  // varianza, lotes y salud del control, cada una detrás de su flag.
  const masPestanas: PestanaDeMas[] = [
    ...(countsEnabled ? [{ value: "movimientos", label: "Movimientos y mermas" }] : []),
    ...(areaCountsEnabled ? [{ value: "por-area", label: "Conteo por área" }] : []),
    ...(varianceEnabled ? [{ value: "varianza", label: "Varianza" }] : []),
    ...(lotsEnabled ? [{ value: "lotes", label: "Lotes" }] : []),
    ...(labelsEnabled ? [{ value: "etiquetas", label: "Etiquetas" }] : []),
    ...(varianceEnabled ? [{ value: "salud", label: "Salud del control" }] : []),
    ...(wasteEnabled ? [{ value: "mermas", label: "Análisis de mermas" }] : []),
  ]

  return (
    <div className="space-y-4">
      {/* Patrón 2 · Cabecera de pantalla: nombre + LA PREGUNTA que la
          pantalla contesta, y debajo la franja con lo que caduca. Las
          acciones primarias («Nuevo insumo», «Exportar CSV») no viven acá:
          con pestañas bajan a la barra de la tabla de cada una, porque cada
          pestaña crea una cosa distinta. */}
      <PageHeader
        name="Inventario"
        question="Qué tengo, qué me falta y qué me está mintiendo. El stock es teórico: sale de restarle a las compras lo que las recetas dicen que se gastó."
        context={[
          ...(ingredientsQuery.isSuccess
            ? [
                {
                  label: (
                    <>
                      <b className="font-bold text-foreground tabular-nums">{ingredients.length}</b> insumos
                      activos
                    </>
                  ),
                },
              ]
            : []),
          // Handoff, pantalla 12: la franja dice también quién ve los costos.
          { label: "Costos visibles solo para administración" },
        ]}
      />
      <Tabs value={tab} onValueChange={cambiarPestana}>
        <TabsList className="h-auto flex-wrap">
          {/* El recuento va como COMPONENTE y no como `{expresión}`: el
              censo de controles (`src/audit/censo.ts`) lee el rótulo con una
              expresión regular que se detiene en la primera llave, y un
              `{...}` acá haría desaparecer «Insumos» de la base sin que el
              botón se hubiera movido. */}
          <TabsTrigger value="insumos">
            Insumos <TabCount n={ingredientsQuery.isSuccess ? ingredients.length : undefined} />
          </TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          {/* Pedido del dueño (2026-10-05): la línea de tiempo va a la vista,
              al lado de Stock, aunque eso deje cuatro pestañas visibles. Stock
              dice CUÁNTO hay; esta, CUÁNDO entró y salió cada insumo. */}
          <TabsTrigger value="linea">Línea de tiempo</TabsTrigger>
          {countsEnabled ? <TabsTrigger value="conteos">Conteos</TabsTrigger> : null}
          {/* Sin conteos, el tercer lugar a la vista es del libro de
              movimientos: siempre hay tres a la vista si hay tres. */}
          {countsEnabled ? null : <TabsTrigger value="movimientos">Movimientos y mermas</TabsTrigger>}
          {/* Tres a la vista y el resto en «Más» (mapa de pantallas, regla 4).
              Los `value` —y con ellos el `?tab=` de los enlaces de Hoy— no
              cambian; «Más» respeta los mismos flags que las pestañas. */}
          <MasPestanas value={tab} onValueChange={cambiarPestana} items={masPestanas} />
        </TabsList>
        <TabsContent value="insumos" className="pt-4">
          <IngredientsTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="stock" className="pt-4">
          <StockTab
            storeId={activeStoreId}
            initialBelowMin={searchParams.get("below_min") === "1"}
            initialNegative={searchParams.get("negative") === "1"}
            initialCriticalOnly={searchParams.get("critical") === "1"}
            // Patrón 6: el enlace de Hoy y la barra de procedencia van en
            // par. Quien sale nombra el filtro; quien llega lo reconoce y
            // ofrece **la salida** — que también limpia la query, o el
            // filtro volvería al recargar y el dueño seguiría sin ver las
            // filas que le esconden.
            onDropArrival={() => {
              const next = new URLSearchParams(searchParams)
              for (const key of ["below_min", "negative", "critical"]) next.delete(key)
              setSearchParams(next, { replace: true })
            }}
          />
        </TabsContent>
        <TabsContent value="linea" className="pt-4">
          <LineaDeTiempoTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="movimientos" className="pt-4">
          <MovementsWasteTab
            storeId={activeStoreId}
            ingredients={ingredients}
            // «Ver libro de movimientos» desde el «⋯» de una fila de Stock.
            initialIngredientId={Number(searchParams.get("insumo")) || null}
          />
        </TabsContent>
        {countsEnabled ? (
          <TabsContent value="conteos" className="pt-4">
            <CountsTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {areaCountsEnabled ? (
          <TabsContent value="por-area" className="pt-4">
            {/* `?conteo=ID`: el aviso de Hoy abre directo el detalle del conteo. */}
            <AreaCountsTab
              storeId={activeStoreId}
              ingredients={ingredients}
              initialCountId={Number(searchParams.get("conteo")) || null}
            />
          </TabsContent>
        ) : null}
        {varianceEnabled ? (
          <TabsContent value="varianza" className="space-y-8 pt-4">
            {/* El único lugar de la varianza (limpieza 2026-10): por insumo
                entre dos conteos y, debajo, la misma varianza repartida por
                plato. Antes «Varianza por plato» era otra pestaña en
                Analítica, con su propia entrada del rail. */}
            <VarianceTab storeId={activeStoreId} />
            <GroupLabel label="Por plato" says="la varianza del último conteo completo, repartida entre los platos que usan cada insumo">
              <VarianceByDishTab storeId={activeStoreId} />
            </GroupLabel>
          </TabsContent>
        ) : null}
        {lotsEnabled ? (
          <TabsContent value="lotes" className="pt-4">
            <LotsTab storeId={activeStoreId} ingredients={ingredients} />
          </TabsContent>
        ) : null}
        {labelsEnabled ? (
          <TabsContent value="etiquetas" className="pt-4">
            <LabelsAdminTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {wasteEnabled ? (
          <TabsContent value="mermas" className="pt-4">
            <WasteAnalysisTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {varianceEnabled ? (
          <TabsContent value="salud" className="space-y-8 pt-4">
            <ControlHealthTab storeId={activeStoreId} />
            {/* La brecha de food cost a lo largo de varias ventanas: antes
                «Salud sostenida», pestaña aparte en Analítica. */}
            <GroupLabel label="¿Se sostiene la brecha?" says="las últimas ventanas entre conteos completos, no un conteo malo">
              <SustainedHealthTab storeId={activeStoreId} />
            </GroupLabel>
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

export default InventoryAdminPage
