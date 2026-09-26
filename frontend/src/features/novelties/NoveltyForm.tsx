import { useMutation } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { ApiError, newIdempotencyKey } from "@/api/client"
import { createNovelty, type NoveltyCategory, type NoveltyLevel } from "@/api/novelties"
import { PhotoCaptureField } from "@/components/PhotoCaptureField"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { CATEGORY_LABEL, LEVEL_LABEL } from "./lib"

/** Un botón de opción grande, para elegir con un toque de pie en la tablet. */
function Opcion({
  elegida,
  onClick,
  children,
  peligro = false,
}: {
  elegida: boolean
  onClick: () => void
  children: React.ReactNode
  peligro?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={elegida}
      onClick={onClick}
      className={cn(
        "min-h-12 rounded-lg px-4 text-base font-semibold ring-1 transition-colors",
        peligro
          ? elegida
            ? "bg-destructive text-white ring-destructive"
            : "bg-destructive/10 text-destructive ring-destructive/60 hover:bg-destructive/20"
          : elegida
            ? "bg-foreground text-background ring-foreground"
            : "bg-card text-foreground ring-border hover:bg-muted",
      )}
    >
      {children}
    </button>
  )
}

/**
 * «Registrar novedad»: qué pasó, detalle opcional, categoría, nivel, si pasa
 * al siguiente turno y una foto opcional. La registra la persona
 * identificada en la tablet (el servidor la atribuye). Una urgente siempre
 * pasa al siguiente turno: lo fuerza el servidor, y la casilla lo refleja.
 *
 * Auditoría de tablet: la categoría y el nivel son **botones**, no listas
 * desplegables; «Urgente» es un botón rojo aparte, a la vista, en vez de la
 * tercera opción escondida de un desplegable.
 */
export function NoveltyForm({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const [title, setTitle] = useState("")
  const [detail, setDetail] = useState("")
  const [category, setCategory] = useState<NoveltyCategory | "">("")
  const [level, setLevel] = useState<NoveltyLevel>("info")
  const [followUp, setFollowUp] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  // Mientras la foto se achica no se envía: saldría sin la foto que ya se ve elegida.
  const [photoProcessing, setPhotoProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef(newIdempotencyKey())

  const urgent = level === "urgent"

  const mutation = useMutation({
    mutationFn: () =>
      createNovelty(
        {
          title: title.trim(),
          detail: detail.trim() === "" ? null : detail.trim(),
          category: category as NoveltyCategory,
          level,
          requires_follow_up: followUp || urgent,
          photo: photo ?? undefined,
        },
        keyRef.current,
      ),
    onSuccess: () => {
      toast.success("Novedad registrada.")
      keyRef.current = newIdempotencyKey()
      setTitle("")
      setDetail("")
      setCategory("")
      setLevel("info")
      setFollowUp(false)
      setPhoto(null)
      setError(null)
      onCreated()
    },
    onError: (err) => {
      // 409 = la misma clave sigue en vuelo: no se cambia, para no duplicar.
      if (!(err instanceof ApiError) || err.status !== 409) keyRef.current = newIdempotencyKey()
      setError(errorMessage(err))
    },
  })

  const canSubmit = title.trim() !== "" && category !== "" && !mutation.isPending && !photoProcessing

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) mutation.mutate()
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="novelty-title">¿Qué pasó?</Label>
        <Input
          id="novelty-title"
          className="h-11"
          maxLength={200}
          placeholder="Se dañó la nevera, faltó un mesero…"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="novelty-detail">Detalle (opcional)</Label>
        <Textarea id="novelty-detail" value={detail} onChange={(event) => setDetail(event.target.value)} />
      </div>
      <div className="space-y-2">
        <p id="novelty-category-label" className="text-sm font-medium">
          Categoría
        </p>
        <div role="radiogroup" aria-labelledby="novelty-category-label" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(Object.entries(CATEGORY_LABEL) as [NoveltyCategory, string][]).map(([value, label]) => (
            <Opcion key={value} elegida={category === value} onClick={() => setCategory(value)}>
              {label}
            </Opcion>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <p id="novelty-level-label" className="text-sm font-medium">
          Nivel
        </p>
        <div role="radiogroup" aria-labelledby="novelty-level-label" className="grid grid-cols-3 gap-2">
          {(["info", "important"] as const).map((value) => (
            <Opcion key={value} elegida={level === value} onClick={() => setLevel(value)}>
              {LEVEL_LABEL[value]}
            </Opcion>
          ))}
          <Opcion peligro elegida={level === "urgent"} onClick={() => setLevel("urgent")}>
            {LEVEL_LABEL.urgent}
          </Opcion>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="novelty-follow-up"
          checked={followUp || urgent}
          disabled={urgent}
          onCheckedChange={(checked) => setFollowUp(checked === true)}
        />
        <div>
          <Label htmlFor="novelty-follow-up">Requiere seguimiento (pasa al siguiente turno)</Label>
          {urgent ? (
            <p className="text-xs text-muted-foreground">Una urgente siempre pasa al siguiente turno.</p>
          ) : null}
        </div>
      </div>
      <PhotoCaptureField
        value={photo}
        onChange={setPhoto}
        label="Foto (opcional)"
        disabled={mutation.isPending}
        onProcessingChange={setPhotoProcessing}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="h-11 w-full" disabled={!canSubmit}>
        Registrar novedad
      </Button>
    </form>
  )
}
