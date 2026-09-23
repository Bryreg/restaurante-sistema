import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import {
  createSupplier,
  deactivateSupplier,
  getSuppliersReliability,
  listSuppliers,
  updateSupplier,
  type SupplierOut,
} from "@/api/purchases"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  DenseTable,
  DenseTableBar,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"

/** La leyenda del pie: qué cambia que un proveedor exija factura. */
const SUPPLIERS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Obligado a facturar",
    meaning: (
      <>
        una recepción de este proveedor <b>sin factura se rechaza</b>. No es una preferencia: el servidor la
        hace cumplir.
      </>
    ),
  },
  {
    term: "Plazo",
    meaning: "los días desde la recepción hasta que la cuenta por pagar vence. De ahí sale el «Vencida».",
  },
  {
    term: "Recibido ÷ facturado",
    meaning: (
      <>
        de lo que el proveedor cobró, cuánto entró de verdad (mediana por insumo, pesada por plata). En ámbar
        debajo de 99 %; en rojo debajo de 95 %: <b>se está pagando lo que no llegó</b>.
      </>
    ),
  },
  {
    term: "Deriva de precio",
    meaning:
      "cuánto se movió el precio contra la compra anterior del mismo insumo (▲ subió, ▼ bajó). En ámbar si subió 5 % o más; en rojo, 10 % o más. Una bajada nunca es alerta.",
  },
  {
    term: "Muestra chica",
    meaning: "menos de 5 recepciones en el rango: un pedido raro mueve la cifra entera. Tomala como indicio.",
  },
  {
    term: "Desactivar",
    meaning: "no borra: el proveedor deja de ofrecerse en recepciones nuevas y sus compras viejas quedan enteras.",
  },
]
import { defaultDateRange, downloadSuppliersCsv } from "./lib"
import { formatDeriva, peorTono, tonoDeriva, tonoRecibido } from "./reliability"
import { Indicador, Recepciones } from "./ReliabilityMarks"
import { formValuesToSupplierIn, formValuesToSupplierUpdateIn, SupplierForm } from "./SupplierForm"
import { SupplierReliabilityDialog } from "./SupplierReliabilityDialog"

function SupplierActions({ supplier }: { supplier: SupplierOut }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToSupplierUpdateIn>[0]) =>
      updateSupplier(supplier.id, formValuesToSupplierUpdateIn(values)),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] })
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: () => deactivateSupplier(supplier.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] }),
  })

  return (
    <div className="flex flex-nowrap justify-end gap-1">
      <SupplierReliabilityDialog supplier={supplier} />
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>Editar</DialogTrigger>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Editar {supplier.name}</DialogTitle>
          </DialogHeader>
          <SupplierForm
            supplier={supplier}
            submitting={updateMutation.isPending}
            submitLabel="Guardar"
            serverError={updateMutation.isError ? errorMessage(updateMutation.error) : null}
            onSubmit={(values) => updateMutation.mutate(values)}
          />
        </DialogContent>
      </Dialog>
      {/* «Desactivar» sólo existe si el proveedor está activo. */}
      {supplier.active ? (
        <Button
          variant="outline"
          size="sm"
          disabled={deactivateMutation.isPending}
          onClick={() => deactivateMutation.mutate()}
        >
          Desactivar
        </Button>
      ) : null}
    </div>
  )
}

/** Sin recepciones en el rango no hay con qué medir: «—» con motivo, nunca «0 %». */
function SinReliability({ cargando }: { cargando: boolean }): React.JSX.Element {
  return (
    <span className="text-muted-foreground" title={cargando ? "Calculando…" : "Sin recepciones en los últimos 90 días: no hay con qué medirlo"}>
      —
    </span>
  )
}

/**
 * Admin → Compras → Proveedores (SPEC-NEGOCIO §5.6 / §9.3: «¿a quién le
 * debo?»). Entidad canónica: alta, edición y baja LÓGICA (nunca un
 * `DELETE` de fila). `400 SUPPLIER_DUPLICATE_NIT` se muestra tal cual el
 * servidor lo redactó — ya nombra la acción correctiva — nunca como un
 * toast genérico.
 */
export function SuppliersTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["purchases", "suppliers", storeId, showInactive],
    queryFn: () => listSuppliers(storeId, { active: showInactive ? undefined : true }),
  })

  const createMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToSupplierIn>[0]) =>
      createSupplier(storeId, formValuesToSupplierIn(values)),
    onSuccess: () => {
      setCreating(false)
      void queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] })
    },
  })

  // La confiabilidad de TODOS los proveedores de una vez, para compararlos
  // en la lista (informe #9). Los últimos 90 días, como el diálogo.
  const [range] = useState(() => defaultDateRange(90))
  const reliabilityQuery = useQuery({
    queryKey: ["purchases", "suppliers", "reliability", storeId, range.from, range.to],
    queryFn: () => getSuppliersReliability({ storeId, from: range.from, to: range.to }),
  })
  const reliabilityById = new Map((reliabilityQuery.data?.rows ?? []).map((r) => [r.supplier_id, r]))

  const suppliers = query.data ?? []
  const inactive = suppliers.filter((s) => !s.active).length

  const columns: readonly DenseColumn<SupplierOut>[] = [
    { key: "name", header: "Nombre", kind: "name", cell: (s) => s.name },
    { key: "nit", header: "NIT", kind: "id", cell: (s) => s.nit ?? "—" },
    { key: "term", header: "Plazo", kind: "number", cell: (s) => `${s.payment_term_days} días` },
    {
      key: "contact",
      header: "Contacto",
      cell: (s) => (
        // Sólo el nombre, con tope de ancho: con las tres columnas de
        // confiabilidad la tabla no cabía a 1440 px y «Desactivar» quedaba
        // detrás del scroll. Nombre y teléfono siguen en el `title` de la
        // celda y en el formulario de «Editar».
        <span className="block max-w-[86px] truncate">{s.contact_name ?? s.contact_phone ?? "—"}</span>
      ),
      cellTitle: (s) => [s.contact_name, s.contact_phone].filter(Boolean).join(" · ") || undefined,
    },
    {
      key: "invoice",
      header: "Factura",
      cell: (s) => (s.invoices_required ? "Obligado a facturar" : "Factura opcional"),
    },
    {
      key: "received",
      header: "Recibido ÷ facturado",
      kind: "number",
      cell: (s) => {
        const r = reliabilityById.get(s.id)
        const bp = r?.received_over_invoiced_bp ?? null
        return bp === null ? <SinReliability cargando={reliabilityQuery.isLoading} /> : <Indicador tono={tonoRecibido(bp)}>{formatPct(bp)}</Indicador>
      },
    },
    {
      key: "drift",
      header: "Deriva de precio",
      kind: "number",
      cell: (s) => {
        const r = reliabilityById.get(s.id)
        const bp = r?.price_drift_bp ?? null
        return bp === null ? <SinReliability cargando={reliabilityQuery.isLoading} /> : <Indicador tono={tonoDeriva(bp)}>{formatDeriva(bp)}</Indicador>
      },
    },
    {
      key: "receptions",
      header: "Recepciones",
      kind: "number",
      cell: (s) => {
        const r = reliabilityById.get(s.id)
        return r ? <Recepciones n={r.n_receptions ?? r.receptions} /> : <SinReliability cargando={reliabilityQuery.isLoading} />
      },
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (s) => <SupplierActions supplier={s} />,
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los proveedores"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <DenseTable
      caption="Proveedores de la sede"
      columns={columns}
      rows={suppliers}
      rowKey={(s) => String(s.id)}
      rowInactive={(s) => !s.active}
      rowStatus={(s) => {
        const r = reliabilityById.get(s.id)
        return r ? peorTono(tonoRecibido(r.received_over_invoiced_bp), tonoDeriva(r.price_drift_bp)) : "none"
      }}
      legend={SUPPLIERS_LEGEND}
      bar={
        <DenseTableBar
          shown={suppliers.length}
          total={suppliers.length}
          noun={showInactive ? "proveedores" : "proveedores activos"}
          hidden={
            query.isLoading
              ? "contando…"
              : showInactive
                ? inactive > 0
                  ? `${inactive} inactivos, a la vista`
                  : undefined
                : "los inactivos no se están mostrando"
          }
        >
          <div className="flex items-center gap-2">
            <Checkbox
              id="sup-show-inactive"
              checked={showInactive}
              onCheckedChange={(v) => setShowInactive(v === true)}
            />
            <Label htmlFor="sup-show-inactive">Mostrar inactivos</Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadSuppliersCsv(suppliers)}
            disabled={suppliers.length === 0}
          >
            Exportar CSV
          </Button>
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger render={<Button size="sm" />}>Nuevo proveedor</DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>Nuevo proveedor</DialogTitle>
              </DialogHeader>
              <SupplierForm
                submitting={createMutation.isPending}
                submitLabel="Crear"
                serverError={createMutation.isError ? errorMessage(createMutation.error) : null}
                onSubmit={(values) => createMutation.mutate(values)}
              />
            </DialogContent>
          </Dialog>
        </DenseTableBar>
      }
      note={
        <>
          Nombre canónico, NIT, plazo de pago y si el proveedor exige factura. Nunca texto libre: cada recepción elige
          uno de esta lista. La confiabilidad es de los últimos 90 días; el detalle por insumo está en «Confiabilidad».
          {reliabilityQuery.isError ? ` No se pudo cargar la confiabilidad: ${errorMessage(reliabilityQuery.error)}` : ""}
        </>
      }
      empty={
        query.isLoading ? undefined : (
          <EmptyState
            title="Todavía no hay proveedores"
            description="Creá el primero con «Nuevo proveedor». Sin proveedores no se puede registrar ninguna recepción."
          />
        )
      }
    />
  )
}

export default SuppliersTab
