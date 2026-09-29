import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Printer } from "lucide-react"
import { useId, useRef, useState } from "react"
import { toast } from "sonner"

import { useSession } from "@/app/session"
import { newIdempotencyKey } from "@/api/client"
import { finishLabel, reprintLabel, type FoodLabel, type LabelWasteType } from "@/api/labels"
import { PinPad } from "@/components/PinPad"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"
import { cn } from "@/lib/utils"

import { LABEL_WASTE_TYPES, SOURCE_TEXT, stateText, stateTone } from "./lib"
import { codeText, KIND_LABEL, printLabels, type LabelSize } from "./printLabels"

type Step = "view" | "discard"

/**
 * La ficha de una etiqueta leída o tocada: qué es, hasta cuándo, de qué lote
 * y quién la hizo; y lo que se hace con ella: reimprimir, «se acabó» o
 * «botar». Botar es una merma: pide cuánto (en la unidad del insumo) y el
 * PIN de quien responde, como toda merma.
 */
export function LabelSheet({
  label,
  size,
  onClose,
}: {
  label: FoodLabel | null
  size: LabelSize
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={label !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {label ? <SheetBody key={label.code} label={label} size={size} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function SheetBody({ label, size, onClose }: { label: FoodLabel; size: LabelSize; onClose: () => void }) {
  const { hasFeature } = useSession()
  const wasteOn = hasFeature("inventory.waste")
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>("view")
  const [qty, setQty] = useState("")
  const [type, setType] = useState<LabelWasteType>("expired")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef(newIdempotencyKey())
  const qtyId = useId()
  const noteId = useId()
  const active = label.status === "active"
  const tone = stateTone(label.state)

  function done(message: string) {
    toast.success(message)
    void queryClient.invalidateQueries({ queryKey: ["device", "labels"] })
    onClose()
  }

  const reprint = useMutation({
    mutationFn: () => reprintLabel(label.code, newIdempotencyKey()),
    onSuccess: (out) => {
      if (!printLabels([out], size)) toast.warning("Este navegador no pudo abrir la impresión.")
      void queryClient.invalidateQueries({ queryKey: ["device", "labels"] })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  const finish = useMutation({
    mutationFn: (body: Parameters<typeof finishLabel>[1]) => finishLabel(label.code, body, keyRef.current),
    onSuccess: (out) => done(out.status === "used_up" ? `${out.item_name}: se acabó` : `${out.item_name}: se botó`),
    onError: (err) => {
      keyRef.current = newIdempotencyKey()
      setError(errorMessage(err))
    },
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>{label.item_name}</DialogTitle>
        <DialogDescription>
          {KIND_LABEL[label.kind]} {formatFechaCorta(label.business_date)} por {label.employee_name} · código{" "}
          <span className="font-mono">{codeText(label.code)}</span>
        </DialogDescription>
      </DialogHeader>

      <div
        className={cn(
          "rounded-lg border p-3",
          tone === "critical" && "border-destructive/50 bg-destructive/10",
          tone === "warning" && "border-warning/50 bg-warning/10",
        )}
      >
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Usar antes de</p>
        <p className="text-2xl font-bold">{label.use_by ? formatFechaCorta(label.use_by) : "Sin vencimiento"}</p>
        <p className={cn("text-sm font-semibold", tone === "critical" && "text-destructive")}>{stateText(label)}</p>
        {label.use_by_source ? (
          <p className="mt-1 text-xs text-muted-foreground">Sale de: {SOURCE_TEXT[label.use_by_source]}</p>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        {label.lot_code ? (
          <>
            <dt className="text-muted-foreground">Lote</dt>
            <dd className="font-medium">{label.lot_code}</dd>
          </>
        ) : null}
        {label.qty_text ? (
          <>
            <dt className="text-muted-foreground">Contenido</dt>
            <dd className="font-medium">{label.qty_text}</dd>
          </>
        ) : null}
        {label.note ? (
          <>
            <dt className="text-muted-foreground">Nota</dt>
            <dd className="font-medium">{label.note}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Impresa</dt>
        <dd className="font-medium">{label.print_count === 1 ? "1 vez" : `${label.print_count} veces`}</dd>
        {!active ? (
          <>
            <dt className="text-muted-foreground">{label.status === "used_up" ? "Se acabó" : "Se botó"}</dt>
            <dd className="font-medium">
              {formatInstant(label.closed_at)} · {label.closed_by_employee_name}
            </dd>
          </>
        ) : null}
      </dl>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">
          {error}
        </p>
      ) : null}

      {active && step === "view" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Button variant="outline" className="h-12" disabled={reprint.isPending} onClick={() => reprint.mutate()}>
            <Printer className="size-4" aria-hidden />
            Reimprimir
          </Button>
          <Button
            variant="outline"
            className="h-12"
            disabled={finish.isPending}
            onClick={() => finish.mutate({ outcome: "used_up" })}
          >
            Se acabó
          </Button>
          <Button
            variant="destructive"
            className="h-12"
            onClick={() => {
              setError(null)
              if (wasteOn) setStep("discard")
              else finish.mutate({ outcome: "discarded" })
            }}
          >
            Botar
          </Button>
        </div>
      ) : null}

      {active && step === "discard" ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-bold">Botar queda como merma</p>
          <div role="group" aria-label="Motivo" className="flex flex-wrap gap-2">
            {LABEL_WASTE_TYPES.map((t) => (
              <Button
                key={t.value}
                type="button"
                size="sm"
                variant={type === t.value ? "default" : "outline"}
                aria-pressed={type === t.value}
                onClick={() => setType(t.value)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <div>
            <Label htmlFor={qtyId}>¿Cuánto se botó? (en {label.waste_unit})</Label>
            <Input
              id={qtyId}
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder={`Ej. 0,5 ${label.waste_unit}`}
              className="h-12 text-lg"
            />
          </div>
          <div>
            <Label htmlFor={noteId}>Nota (opcional)</Label>
            <Input id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej. olía raro" />
          </div>
          <PinPad
            label="PIN de quien responde por la merma"
            disabled={finish.isPending || !qty.trim()}
            errorMessage={!qty.trim() ? "Escribí cuánto se botó antes del PIN" : null}
            onSubmit={(pin) =>
              finish.mutate({
                outcome: "discarded",
                qty: qty.trim().replace(",", "."),
                waste_type: type,
                employee_pin: pin,
                note: note.trim() || null,
              })
            }
          />
          <Button variant="ghost" onClick={() => setStep("view")}>
            Volver
          </Button>
        </div>
      ) : null}
    </>
  )
}
