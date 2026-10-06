import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileDown } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { getRecipeSheet, putRecipeSheet, type RecipeSheetOut, type SheetOwner, type Station } from "@/api/recipes"
import { Cargando } from "@/components/Cargando"
import { PhotoCaptureField } from "@/components/PhotoCaptureField"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { ALLERGEN_LABEL, STATION_LABEL, fichaImprimibleHref } from "./fichaChef"

/**
 * **La ficha de chef** de un plato o de una preparación: lo que la cocina
 * necesita para hacerlo igual cada vez —método paso a paso, porción servida,
 * estación, tiempo, montaje, notas y foto—, y los dos botones para
 * descargarla: la de **cocina** (sin costos) y la del **dueño** (con costo y
 * food cost). Los alérgenos no se escriben acá: se heredan de los insumos.
 */
export function FichaChefEditor({ owner }: { owner: SheetOwner }): React.JSX.Element {
  const key = ["recipes", "sheet", owner.kind, owner.id]
  const query = useQuery({ queryKey: key, queryFn: () => getRecipeSheet(owner) })
  if (query.isLoading) return <Cargando texto="Cargando la ficha de chef…" />
  if (query.isError || !query.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(query.error)}
      </p>
    )
  }
  // La forma arranca con lo guardado; al guardar, la respuesta trae otra
  // `updated_at` y la forma se rearma con lo que quedó.
  return <FormaFicha key={query.data.updated_at ?? "nueva"} owner={owner} queryKey={key} inicial={query.data} />
}

function FormaFicha({
  owner,
  queryKey,
  inicial,
}: {
  owner: SheetOwner
  queryKey: readonly unknown[]
  inicial: RecipeSheetOut
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [steps, setSteps] = useState(inicial.method_steps.join("\n"))
  const [portion, setPortion] = useState(inicial.portion ?? "")
  const [station, setStation] = useState<Station | "">(inicial.station ?? "")
  const [minutes, setMinutes] = useState(inicial.prep_minutes === null ? "" : String(inicial.prep_minutes))
  const [plating, setPlating] = useState(inicial.plating_notes ?? "")
  const [notes, setNotes] = useState(inicial.chef_notes ?? "")
  const [photo, setPhoto] = useState<string | null>(inicial.photo_url)
  const [photoChanged, setPhotoChanged] = useState(false)
  const query = { data: inicial, isLoading: false }

  const save = useMutation({
    mutationFn: () =>
      putRecipeSheet(owner, {
        method_steps: steps.split("\n").map((l) => l.trim()).filter(Boolean),
        portion: portion.trim() || null,
        station: station || null,
        prep_minutes: minutes.trim() === "" ? null : Math.max(0, Math.round(Number(minutes))),
        plating_notes: plating.trim() || null,
        chef_notes: notes.trim() || null,
        ...(photoChanged ? (photo ? { photo } : { clear_photo: true }) : {}),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data)
      toast.success("Ficha de chef guardada.")
    },
  })

  const ids = `ficha-${owner.kind}-${owner.id}`
  return (
    <fieldset className="space-y-4 rounded-[20px] bg-muted px-4 py-4">
      <legend className="sr-only">Ficha de chef</legend>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold">Ficha de chef</h3>
        <span className="text-xs text-muted-foreground">método, porción, montaje y foto para la cocina</span>
        <span className="ml-auto flex flex-wrap gap-2">
          <a
            href={fichaImprimibleHref(owner.kind, owner.id, false)}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            <FileDown className="size-3.5" aria-hidden="true" />
            Descargar para cocina
          </a>
          <a
            href={fichaImprimibleHref(owner.kind, owner.id, true)}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            <FileDown className="size-3.5" aria-hidden="true" />
            Con costos
          </a>
        </span>
      </div>

      {query.data && query.data.allergens.length > 0 ? (
        <p className="text-sm">
          <b>Alérgenos</b> (de los insumos):{" "}
          {query.data.allergens.map((a) => ALLERGEN_LABEL[a] ?? a).join(", ")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Sin alérgenos declarados en sus insumos. Se marcan en la ficha de cada insumo y aparecen acá solos.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-portion`}>{owner.kind === "product" ? "Porción servida" : "Presentación"}</Label>
          <Input id={`${ids}-portion`} value={portion} placeholder="350 g · plato hondo" onChange={(e) => setPortion(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-station`}>Estación</Label>
          <select
            id={`${ids}-station`}
            value={station}
            onChange={(e) => setStation(e.target.value as Station | "")}
            className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
          >
            <option value="">Sin estación</option>
            {(Object.keys(STATION_LABEL) as Station[]).map((s) => (
              <option key={s} value={s}>
                {STATION_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-minutes`}>Tiempo (minutos)</Label>
          <Input id={`${ids}-minutes`} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${ids}-steps`}>Método (un paso por renglón)</Label>
        <Textarea
          id={`${ids}-steps`}
          rows={6}
          value={steps}
          placeholder={"Sellar la carne 2 min por lado\nDesglasar con vino\nHornear 12 min a 180 °C"}
          onChange={(e) => setSteps(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-plating`}>Montaje / emplatado</Label>
          <Textarea id={`${ids}-plating`} rows={3} value={plating} onChange={(e) => setPlating(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-notes`}>Notas del chef (punto, temperatura, conservación)</Label>
          <Textarea id={`${ids}-notes`} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_200px] sm:items-start">
        <PhotoCaptureField
          label="Foto del plato terminado"
          value={photo}
          onChange={(v) => {
            setPhoto(v)
            setPhotoChanged(true)
          }}
        />
        {photo ? <img src={photo} alt="Foto actual de la ficha" className="max-h-40 rounded-xl object-cover" /> : null}
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || query.isLoading}>
          Guardar ficha de chef
        </Button>
        {query.data?.updated_at ? (
          <span className="text-xs text-muted-foreground">
            Última edición: {query.data.updated_by_employee_name ?? "—"}
          </span>
        ) : null}
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(save.error)}
          </p>
        ) : null}
      </div>
    </fieldset>
  )
}

export default FichaChefEditor
