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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"

import { CATEGORY_LABEL, LEVEL_LABEL } from "./lib"

/**
 * «Registrar novedad»: qué pasó, detalle opcional, categoría, nivel, si pasa
 * al siguiente turno y una foto opcional. La registra la persona
 * identificada en la tablet (el servidor la atribuye). Una urgente siempre
 * pasa al siguiente turno: lo fuerza el servidor, y la casilla lo refleja.
 */
export function NoveltyForm({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const [title, setTitle] = useState("")
  const [detail, setDetail] = useState("")
  const [category, setCategory] = useState<NoveltyCategory | "">("")
  const [level, setLevel] = useState<NoveltyLevel>("info")
  const [followUp, setFollowUp] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
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

  const canSubmit = title.trim() !== "" && category !== "" && !mutation.isPending

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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="novelty-category">Categoría</Label>
          <Select value={category === "" ? undefined : category} onValueChange={(v) => setCategory(v as NoveltyCategory)}>
            <SelectTrigger id="novelty-category" className="h-11 w-full">
              <SelectValue placeholder="Elegí una categoría" />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(CATEGORY_LABEL) as [NoveltyCategory, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="novelty-level">Nivel</Label>
          <Select value={level} onValueChange={(v) => setLevel(v as NoveltyLevel)}>
            <SelectTrigger id="novelty-level" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(LEVEL_LABEL) as [NoveltyLevel, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto (opcional)" disabled={mutation.isPending} />
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
