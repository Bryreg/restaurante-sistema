import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { IngredientOut } from "@/api/inventory"
import {
  listReceptionDrafts,
  rejectReceptionDraft,
  type ReceptionDraftAdminOut,
  type SupplierOut,
} from "@/api/purchases"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCantidad, formatDuracion } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { ReceptionForm } from "./ReceptionForm"

const RECEPTION_DRAFTS_QUERY_KEY = ["purchases", "reception-drafts"] as const

/**
 * Admin → Compras → Recepciones: las recepciones registradas en el POS que
 * esperan precios («Desde el POS · por completar»), arriba de la lista de
 * recepciones confirmadas. Cada una con la foto a la vista, lo que contó el
 * cajero y cuánto hace que espera (lo calcula el servidor).
 *
 * «Completar» abre el formulario de recepción de siempre, precargado; el
 * stock entra recién ahí, con su costo. «Rechazar» pide motivo y no borra
 * nada.
 */
export function ReceptionDraftsSection({
  storeId,
  suppliers,
  ingredients,
  onCompleted,
}: {
  storeId: number
  suppliers: SupplierOut[]
  ingredients: IngredientOut[]
  onCompleted: () => void
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const [completing, setCompleting] = useState<ReceptionDraftAdminOut | null>(null)
  const [rejecting, setRejecting] = useState<ReceptionDraftAdminOut | null>(null)

  const query = useQuery({
    queryKey: [...RECEPTION_DRAFTS_QUERY_KEY, storeId, "pending"],
    queryFn: () => listReceptionDrafts(storeId, "pending"),
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: RECEPTION_DRAFTS_QUERY_KEY })
  }

  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        No se pudieron cargar las recepciones del POS por completar: {errorMessage(query.error)}{" "}
        <Button type="button" variant="link" size="sm" onClick={() => void query.refetch()}>
          Reintentar
        </Button>
      </p>
    )
  }

  const drafts = query.data ?? []
  if (drafts.length === 0) return null

  return (
    <section aria-labelledby="reception-drafts-title" className="space-y-2">
      <h2 id="reception-drafts-title" className="text-sm font-semibold">
        Desde el POS · por completar ({drafts.length})
      </h2>
      <p className="text-xs text-muted-foreground">
        Las registró quien estaba en el turno, sin precios. El stock no sube hasta que las completes: así entra con
        su costo real.
      </p>
      <ul className="space-y-2">
        {drafts.map((draft) => (
          <li key={draft.id}>
            <DraftCard draft={draft} onComplete={() => setCompleting(draft)} onReject={() => setRejecting(draft)} />
          </li>
        ))}
      </ul>

      <Dialog open={completing !== null} onOpenChange={(open) => (open ? null : setCompleting(null))}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Completar recepción #{completing?.id}</DialogTitle>
          </DialogHeader>
          {completing ? (
            <ReceptionForm
              key={completing.id}
              storeId={storeId}
              suppliers={suppliers}
              ingredients={ingredients}
              draft={completing}
              onSuccess={() => {
                setCompleting(null)
                invalidate()
                onCompleted()
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <RejectDraftDialog
        draft={rejecting}
        onClose={() => setRejecting(null)}
        onRejected={() => {
          setRejecting(null)
          invalidate()
        }}
      />
    </section>
  )
}

function DraftCard({
  draft,
  onComplete,
  onReject,
}: {
  draft: ReceptionDraftAdminOut
  onComplete: () => void
  onReject: () => void
}): React.JSX.Element {
  return (
    <article
      aria-label={`Recepción del POS #${draft.id}, ${draft.supplier_name}`}
      className="flex flex-col gap-3 rounded-md border border-warning/50 bg-warning/5 p-3 sm:flex-row"
    >
      <a
        href={draft.photo}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 self-start rounded-md border focus-visible:ring-2"
        aria-label={`Ver la foto de la factura de ${draft.supplier_name} en grande`}
      >
        <img src={draft.photo} alt="" className="size-24 rounded-md object-cover" />
      </a>
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="rounded-sm bg-warning/20 px-1.5 py-0.5 text-xs font-medium">Desde el POS · por completar</span>
          <b>{draft.supplier_name}</b>
          <span>{draft.no_invoice ? <i className="text-muted-foreground">Sin factura</i> : `Factura ${draft.invoice_number ?? "—"}`}</span>
        </p>
        <p className="text-muted-foreground">
          {draft.created_by_employee_name} · {formatBusinessDate(draft.business_date)} · espera hace{" "}
          <b className="text-foreground">{formatDuracion(draft.waiting_minutes)}</b>
        </p>
        <ul className="list-disc pl-5">
          {draft.lines.map((line) => (
            <li key={line.id}>
              {formatCantidad(line.quantity, line.purchase_unit)} de {line.ingredient_name}
              {line.lot_code ? ` · lote ${line.lot_code}` : ""}
              {line.expires_at ? ` · vence ${formatBusinessDate(line.expires_at)}` : ""}
            </li>
          ))}
        </ul>
        {draft.cash_paid_amount !== null ? (
          <p>
            Pagado de contado desde el cajón: <b className="tabular-nums">{formatCOP(draft.cash_paid_amount)}</b>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-2 sm:flex-col">
        <Button type="button" size="sm" onClick={onComplete}>
          Completar
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReject}>
          Rechazar
        </Button>
      </div>
    </article>
  )
}

function RejectDraftDialog({
  draft,
  onClose,
  onRejected,
}: {
  draft: ReceptionDraftAdminOut | null
  onClose: () => void
  onRejected: () => void
}): React.JSX.Element {
  const [reason, setReason] = useState("")
  const mutation = useMutation({
    mutationFn: () => rejectReceptionDraft((draft as ReceptionDraftAdminOut).id, reason.trim()),
    onSuccess: () => {
      setReason("")
      onRejected()
    },
  })

  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("")
          mutation.reset()
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rechazar recepción #{draft?.id}</DialogTitle>
          <DialogDescription>
            No se borra: queda con el motivo y quién la rechazó, y el POS lo ve en «Recibido hoy».
          </DialogDescription>
        </DialogHeader>
        {draft?.cash_paid_amount !== null && draft?.cash_paid_amount !== undefined ? (
          <p role="note" className="rounded-md border border-warning/50 bg-warning/5 p-2 text-sm">
            Al recibir se pagaron <b className="tabular-nums">{formatCOP(draft.cash_paid_amount)}</b> de contado desde el
            cajón. Rechazar <b>no devuelve esa plata al cajón</b>: el egreso del turno queda como está.
          </p>
        ) : null}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (reason.trim() === "") return
            mutation.mutate()
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="reject-draft-reason">Motivo</Label>
            <Textarea
              id="reject-draft-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={mutation.isPending}
              required
            />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button type="submit" variant="destructive" disabled={mutation.isPending || reason.trim() === ""}>
            {mutation.isPending ? "Rechazando…" : "Rechazar recepción"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default ReceptionDraftsSection
