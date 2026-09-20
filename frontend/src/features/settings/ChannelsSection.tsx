import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { useSession } from "@/app/session"
import {
  createPlatform,
  deactivatePlatform,
  listPlatforms,
  updatePlatform,
  type PlatformOut,
} from "@/api/channels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

// La ÚNICA función que sabe que 100 = 1 % (`formatBasisPoints`,
// `features/inventory/lib.ts`, precedente de 2b: `WasteKpiOut.ratio` pasó de
// `float` a puntos básicos y el cliente ya tiene esta función). No se
// duplica la escala acá: `commission_bp` se muestra SIEMPRE con esta misma
// función, nunca con `bp / 100` o `bp * 100` sueltos en este archivo.
import { formatBasisPoints } from "@/features/inventory/lib"

/** Igual criterio que `features/settings/InventorySection.tsx` (también
 * puntos básicos): conversión de FORMATO de un campo de entrada, nunca de
 * negocio — el servidor valida `0 <= commission_bp <= 10_000` igual. */
function bpToPercentText(bp: number): string {
  return formatBasisPoints(bp).replace(" %", "").replace(",", ".")
}

function percentTextToBp(text: string): number | null {
  const trimmed = text.trim().replace(",", ".")
  if (trimmed === "") return null
  const value = Number(trimmed)
  if (Number.isNaN(value) || value < 0 || value > 100) return null
  return Math.round(value * 100)
}

interface PlatformFormValues {
  name: string
  code: string
  commissionText: string
}

function emptyFormValues(): PlatformFormValues {
  return { name: "", code: "", commissionText: "" }
}

function PlatformFormDialog({
  open,
  onOpenChange,
  platform,
  onSubmit,
  submitting,
  serverError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `undefined` = alta; con plataforma = edición (el código no se edita, nace con la plataforma). */
  platform?: PlatformOut
  onSubmit: (values: PlatformFormValues) => void
  submitting: boolean
  serverError: string | null
}): React.JSX.Element {
  const [values, setValues] = useState<PlatformFormValues>(
    platform
      ? { name: platform.name, code: platform.code, commissionText: bpToPercentText(platform.commission_bp) }
      : emptyFormValues(),
  )

  const commissionBp = percentTextToBp(values.commissionText)
  const canSubmit = values.name.trim() !== "" && (platform || values.code.trim() !== "") && commissionBp !== null

  function handleOpenChange(next: boolean) {
    if (next) {
      setValues(
        platform
          ? { name: platform.name, code: platform.code, commissionText: bpToPercentText(platform.commission_bp) }
          : emptyFormValues(),
      )
    }
    onOpenChange(next)
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit(values)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{platform ? `Editar ${platform.name}` : "Nueva plataforma"}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="platform-name">Nombre</Label>
            <Input
              id="platform-name"
              required
              className="h-11"
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder="Rappi"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-code">Código</Label>
            <Input
              id="platform-code"
              required
              disabled={Boolean(platform)}
              className="h-11"
              value={values.code}
              onChange={(e) => setValues((v) => ({ ...v, code: e.target.value }))}
              placeholder="rappi"
            />
            {platform ? <p className="text-xs text-muted-foreground">El código no se puede cambiar después de crear la plataforma.</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-commission">Comisión (%)</Label>
            <Input
              id="platform-commission"
              inputMode="decimal"
              className="h-11"
              value={values.commissionText}
              aria-invalid={values.commissionText.trim() !== "" && commissionBp === null}
              onChange={(e) => setValues((v) => ({ ...v, commissionText: e.target.value }))}
              placeholder="18"
            />
            <p className="text-xs text-muted-foreground">
              Porcentaje sobre la venta (ej.: <strong>18</strong> = 18 % de comisión). Se guarda en puntos básicos
              enteros (100 = 1 %) — nunca decimal suelto.
            </p>
          </div>
          {serverError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {serverError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!canSubmit || submitting}>
              {submitting ? "Guardando…" : platform ? "Guardar" : "Crear"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PlatformRow({ platform, storeId }: { platform: PlatformOut; storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (values: PlatformFormValues) =>
      updatePlatform(storeId, platform.id, { name: values.name.trim(), commission_bp: percentTextToBp(values.commissionText) as number }),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ["settings", "platforms", storeId] })
    },
  })

  const toggleActiveMutation = useMutation({
    mutationFn: () =>
      platform.active ? deactivatePlatform(storeId, platform.id) : updatePlatform(storeId, platform.id, { active: true }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings", "platforms", storeId] }),
  })

  return (
    <TableRow>
      <TableCell className="font-medium">{platform.name}</TableCell>
      <TableCell className="font-mono text-xs">{platform.code}</TableCell>
      <TableCell className="tabular-nums">{formatBasisPoints(platform.commission_bp)}</TableCell>
      <TableCell>{platform.active ? <Badge variant="secondary">Activa</Badge> : <Badge variant="outline">Inactiva</Badge>}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Editar
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={toggleActiveMutation.isPending}
            onClick={() => toggleActiveMutation.mutate()}
          >
            {platform.active ? "Desactivar" : "Activar"}
          </Button>
        </div>
        {toggleActiveMutation.isError ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {errorMessage(toggleActiveMutation.error)}
          </p>
        ) : null}
        <PlatformFormDialog
          open={editing}
          onOpenChange={setEditing}
          platform={platform}
          submitting={updateMutation.isPending}
          serverError={updateMutation.isError ? errorMessage(updateMutation.error) : null}
          onSubmit={(values) => updateMutation.mutate(values)}
        />
      </TableCell>
    </TableRow>
  )
}

/**
 * Admin → Configuración → Canales (SPEC-NEGOCIO §9.3, pedido 2c). Tres
 * bloques, en el orden en que §9.3 los nombra:
 *
 * 1. **Canales activos**: mesa/para llevar/mostrador se activan en la
 *    pestaña Sedes (`StoreFormDialog.tsx`, ya existe desde 1a — este
 *    archivo no lo duplica). Domicilio y plataforma NO tienen casilla en
 *    `active_channels`: el backend las gatea EXCLUSIVAMENTE por su flag
 *    (`app/orders/service.py::create_order`, verificado leyendo el código —
 *    `active_channels` sólo se chequea para `counter`/`dine_in`/`takeout`),
 *    así que agregar una casilla acá sería un control que no controla nada
 *    y mentiría sobre qué apaga el canal.
 * 2. **Plataformas y comisiones**: CRUD real de este archivo. Alta, edición
 *    (nombre y comisión; el código es inmutable) y baja LÓGICA — nunca se
 *    borra una plataforma (sus comisiones y cuentas por cobrar tienen que
 *    seguir siendo legibles, `backend-dinero-canales.md § 5`).
 * 3. **Estaciones, cursos y tiempos objetivo**: YA se editan en la pestaña
 *    Ventas (`SalesSection.tsx`, campos `stations`/`courses`/
 *    `course_target_minutes` contra `StoreSalesSettings`, construido en 1b).
 *    Acá sólo un puntero — una segunda pantalla que escriba el mismo campo
 *    sería dos verdades.
 */
export function ChannelsSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const { hasFeature } = useSession()
  const platformsEnabled = hasFeature("pos.platforms")
  const queryClient = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const [creating, setCreating] = useState(false)

  const query = useQuery({
    queryKey: ["settings", "platforms", storeId, showInactive],
    queryFn: () => listPlatforms(storeId as number, { active: showInactive ? undefined : true }),
    enabled: storeId !== null && platformsEnabled,
  })

  const createMutation = useMutation({
    mutationFn: (values: PlatformFormValues) =>
      createPlatform(storeId as number, {
        name: values.name.trim(),
        code: values.code.trim(),
        commission_bp: percentTextToBp(values.commissionText) as number,
      }),
    onSuccess: () => {
      setCreating(false)
      void queryClient.invalidateQueries({ queryKey: ["settings", "platforms", storeId] })
    },
  })

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />
  }

  const platforms = query.data ?? []

  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Canales activos</h2>
          <p className="text-sm text-muted-foreground">
            Mesa, para llevar y mostrador se activan en la pestaña <strong>Sedes</strong> («Canales activos»).
            Domicilio y Plataforma no tienen casilla acá: se activan encendiendo <code>pos.delivery</code> y{" "}
            <code>pos.platforms</code> en Admin → Funciones — es lo único que el servidor revisa para esos dos
            canales.
          </p>
        </div>
      </section>

      <section className="space-y-3 border-t pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Plataformas y comisiones</h2>
            <p className="max-w-xl text-sm text-muted-foreground">
              La comisión se REGISTRA por pedido y por plataforma; nunca se resta de la venta (la venta es la venta,
              la comisión es un costo del negocio frente a la plataforma).
            </p>
          </div>
          {platformsEnabled ? (
            <>
              <Button type="button" onClick={() => setCreating(true)}>
                Nueva plataforma
              </Button>
              <PlatformFormDialog
                open={creating}
                onOpenChange={setCreating}
                submitting={createMutation.isPending}
                serverError={createMutation.isError ? errorMessage(createMutation.error) : null}
                onSubmit={(values) => createMutation.mutate(values)}
              />
            </>
          ) : null}
        </div>

        {!platformsEnabled ? (
          <EmptyState
            title="Plataformas no está habilitado"
            description='Activá «Pedidos de plataformas (Rappi, Didi, iFood)» (pos.platforms) en Admin → Funciones.'
          />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Checkbox id="platforms-show-inactive" checked={showInactive} onCheckedChange={(v) => setShowInactive(v === true)} />
              <Label htmlFor="platforms-show-inactive">Mostrar inactivas</Label>
            </div>

            {query.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando plataformas…</p>
            ) : query.isError ? (
              <EmptyState
                role="alert"
                title="No se pudieron cargar las plataformas"
                description={errorMessage(query.error)}
                action={{ label: "Reintentar", onClick: () => void query.refetch() }}
              />
            ) : platforms.length === 0 ? (
              <EmptyState title="Todavía no hay plataformas" description="Creá la primera con «Nueva plataforma»." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nombre</TableHead>
                      <TableHead>Código</TableHead>
                      <TableHead>Comisión</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {platforms.map((platform) => (
                      <PlatformRow key={platform.id} platform={platform} storeId={storeId} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-2 border-t pt-6">
        <div>
          <h2 className="text-sm font-semibold">Estaciones, cursos y tiempos objetivo</h2>
          <p className="text-sm text-muted-foreground">
            Ya se editan en la pestaña <strong>Ventas</strong> («Estaciones», «Cursos» y «Tiempo objetivo por
            curso») — el KDS y el semáforo de cocina leen esos mismos campos. No hay una segunda pantalla acá para
            no tener dos formularios escribiendo el mismo dato.
          </p>
        </div>
      </section>
    </div>
  )
}

export default ChannelsSection
