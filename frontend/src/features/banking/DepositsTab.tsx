/**
 * Admin → Banco → Consignaciones (T1, `GET`/`POST /admin/deposits`). Lista
 * las consignaciones del período, con su comprobante, y ofrece registrar una
 * nueva sin turno preseleccionado (para cuando una consignación cubre varios
 * turnos a la vez).
 *
 * **Consignaciones desde el POS (2026-09-24).** Quien tiene la caja puede
 * consignar la plata de días anteriores que está en el cajón; esas llegan
 * `needs_confirmation` y van **primero**, marcadas «Por confirmar» (ámbar),
 * con un filtro «Por confirmar (n)». El «⋯» de la fila las confirma
 * (`POST /admin/deposits/{id}/confirm`) o las rechaza, que es reversarlas
 * con su motivo (`POST /admin/deposits/{id}/reverse`, el mismo diálogo que
 * reversa una consignación viva cargada desde acá).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { newIdempotencyKey } from "@/api/client"
import { confirmDeposit, getDeposits, reverseDeposit, type DepositOut } from "@/api/banking"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, MenuDeFila, TimeAgo, type DenseColumn } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

/** Las consultas que cambian cuando una consignación se confirma o se rechaza. */
function invalidateBanking(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["banking", "deposits"] })
  void queryClient.invalidateQueries({ queryKey: ["banking", "deposits-pending"] })
  void queryClient.invalidateQueries({ queryKey: ["banking", "owner-hand"] })
  void queryClient.invalidateQueries({ queryKey: ["admin-today"] })
}

/** Ámbar = estado, no acción (`docs/PATRONES-ADMIN.md`: azul es lo único que se toca). */
function PorConfirmar(): React.JSX.Element {
  return (
    <Badge variant="outline" className="border-warning/50 bg-warning/10 text-warning">
      Por confirmar
    </Badge>
  )
}

/**
 * «⋯» de una consignación: «Confirmar» sólo si espera confirmación;
 * «Rechazar» (la del POS por confirmar) o «Reversar» (cualquier otra viva)
 * abren el mismo diálogo, con el motivo obligatorio. Una reversada no tiene
 * acciones: queda apagada y a la vista.
 */
function DepositActions({ deposit }: { deposit: DepositOut }): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const [reversing, setReversing] = useState(false)
  const [reason, setReason] = useState("")
  const idempotencyKeyRef = useRef(newIdempotencyKey())

  const confirmMutation = useMutation({
    mutationFn: () => confirmDeposit(deposit.id),
    onSuccess: () => {
      toast.success("Consignación confirmada.")
      invalidateBanking(queryClient)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const reverseMutation = useMutation({
    mutationFn: () => reverseDeposit(deposit.id, { reason: reason.trim() }, idempotencyKeyRef.current),
    onSuccess: () => {
      toast.success(deposit.needs_confirmation ? "Consignación rechazada." : "Consignación reversada.")
      setReversing(false)
      setReason("")
      idempotencyKeyRef.current = newIdempotencyKey()
      invalidateBanking(queryClient)
    },
    onError: (err) => {
      idempotencyKeyRef.current = newIdempotencyKey()
      toast.error(errorMessage(err))
    },
  })

  if (deposit.status === "reversed") return null
  const rejecting = deposit.needs_confirmation === true

  return (
    <>
      <MenuDeFila nombre={`la consignación de ${formatCOP(deposit.amount ?? null)}`}>
        {rejecting ? (
          <DropdownMenuItem disabled={confirmMutation.isPending} onClick={() => confirmMutation.mutate()}>
            Confirmar
          </DropdownMenuItem>
        ) : null}
        {rejecting ? (
          <DropdownMenuItem onClick={() => setReversing(true)}>Rechazar</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => setReversing(true)}>Reversar</DropdownMenuItem>
        )}
      </MenuDeFila>
      <AlertDialog open={reversing} onOpenChange={setReversing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {rejecting ? "Rechazar" : "Reversar"} la consignación de {formatCOP(deposit.amount ?? null)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              No se borra: queda registrada, apagada, con el motivo. La plata vuelve a figurar por consignar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor={`deposit-reverse-reason-${deposit.id}`}>Motivo</Label>
            <Textarea
              id={`deposit-reverse-reason-${deposit.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={reason.trim() === "" || reverseMutation.isPending}
              onClick={() => reverseMutation.mutate()}
            >
              {rejecting ? "Rechazar" : "Reversar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * Cinco a la vista (mapa de pantallas, regla 3): cuándo, cuánto, contra qué
 * turnos, si tiene comprobante y si se reversó. Banco, referencia, quién la
 * registró y hace cuánto quedan detrás de «Más columnas».
 */
const DEPOSIT_COLUMNS: readonly DenseColumn<DepositOut>[] = [
  { key: "date", header: "Fecha", kind: "name", cell: (d) => formatBusinessDate(d.business_date) },
  { key: "amount", header: "Monto", kind: "number", cell: (d) => formatCOP(d.amount ?? null) },
  {
    // Lo largo va al `title`: la fila no crece (§ 8).
    key: "shifts",
    header: "Turnos imputados",
    kind: "secondary",
    cell: (d) =>
      d.allocations && d.allocations.length > 0
        ? d.allocations.map((a) => `#${a.shift_id} (${formatCOP(a.amount)})`).join(", ")
        : "Mano del dueño",
    cellTitle: (d) =>
      d.allocations && d.allocations.length > 0
        ? undefined
        : "Sin imputar a ningún turno: esta consignación entra como «la mano del dueño».",
  },
  { key: "bank", header: "Banco", secondary: true, cell: (d) => d.bank_name ?? "—" },
  { key: "reference", header: "Referencia", kind: "secondary", secondary: true, cell: (d) => d.bank_reference ?? "—" },
  {
    key: "receipt",
    header: "Comprobante",
    cell: (d) => (d.receipt_photo ? <Badge variant="secondary">Con foto</Badge> : <Badge variant="outline">Sin foto</Badge>),
  },
  { key: "who", header: "Registrada por", secondary: true, cell: (d) => d.employee_name ?? "—" },
  {
    key: "when",
    header: "Hace",
    kind: "secondary",
    secondary: true,
    cell: (d) => <TimeAgo iso={d.deposited_at} />,
    cellTitle: (d) => (d.deposited_at ? formatInstant(d.deposited_at) : undefined),
  },
  {
    // Estado y origen en una sola celda: la tabla sigue en cinco columnas.
    key: "status",
    header: "Estado",
    cell: (d) => (
      <span className="inline-flex items-center gap-1">
        {d.status === "reversed" ? (
          <Badge variant="destructive">{d.source === "pos" ? "Rechazada" : "Reversada"}</Badge>
        ) : d.needs_confirmation ? (
          <PorConfirmar />
        ) : d.confirmed_at ? (
          <Badge variant="secondary">Confirmada</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {d.source === "pos" ? <Badge variant="outline">Desde el POS</Badge> : null}
      </span>
    ),
    cellTitle: (d) =>
      d.status === "reversed" && d.reversed_reason
        ? `Motivo: ${d.reversed_reason}`
        : d.confirmed_by_employee_name
          ? `Confirmó ${d.confirmed_by_employee_name}`
          : undefined,
  },
  { key: "actions", header: "", kind: "actions", cell: (d) => <DepositActions deposit={d} /> },
]

/**
 * Las que esperan confirmación, primero; el resto en el orden del servidor.
 * Ordenar no es calcular: no se toca ninguna cifra.
 */
function pendingFirst(rows: DepositOut[]): DepositOut[] {
  return rows
    .map((d, i) => ({ d, i }))
    .sort((a, b) => Number(b.d.needs_confirmation === true) - Number(a.d.needs_confirmation === true) || a.i - b.i)
    .map(({ d }) => d)
}

import { CreateDepositDialog } from "./CreateDepositDialog"
import { daysAgoLocal, todayLocal } from "./lib"

export function DepositsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const [onlyToConfirm, setOnlyToConfirm] = useState(false)

  const query = useQuery({
    queryKey: ["banking", "deposits", storeId, from, to],
    queryFn: () => getDeposits({ storeId, from, to }),
  })

  const all = pendingFirst(query.data ?? [])
  const toConfirm = all.filter((d) => d.needs_confirmation === true).length
  const filtering = onlyToConfirm && toConfirm > 0
  const rows = filtering ? all.filter((d) => d.needs_confirmation === true) : all

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter idPrefix="deposits" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <CreateDepositDialog storeId={storeId} />
      </div>

      {query.isLoading ? (
        <Cargando texto="Cargando consignaciones…" />
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudieron cargar las consignaciones" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="filter"
          title="No hay consignaciones registradas en este período"
          description={`El filtro puesto es el período: ${from} a ${to}.`}
        />
      ) : (
        <DenseTable
          caption="Consignaciones del período, con los turnos que imputan, su comprobante y si esperan confirmación."
          columns={DEPOSIT_COLUMNS}
          rows={rows}
          rowKey={(d) => String(d.id)}
          rowStatus={(d) => (d.needs_confirmation ? "warning" : "none")}
          rowInactive={(d) => d.status === "reversed"}
          maxBodyHeightPx={460}
          bar={
            <DenseTableBar
              shown={rows.length}
              total={all.length}
              noun="consignaciones"
              hidden={filtering ? "sólo las que esperan confirmación" : `del ${from} al ${to}`}
            >
              {toConfirm > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant={filtering ? "default" : "outline"}
                  aria-pressed={filtering}
                  onClick={() => setOnlyToConfirm((v) => !v)}
                >
                  Por confirmar ({toConfirm})
                </Button>
              ) : null}
            </DenseTableBar>
          }
          legend={[
            {
              term: "Mano del dueño",
              meaning: "la consignación no se imputó a ningún turno: entra al saldo que el dueño tiene encima.",
            },
            {
              term: "Sin foto",
              meaning: "quedó registrada, pero sin comprobante del banco adjunto. No es que no exista: es que no se puede mostrar.",
            },
            {
              term: "Reversada",
              meaning: "se anuló. La fila se deja a la vista, apagada, porque la plata sí se movió alguna vez.",
            },
            {
              term: "Por confirmar",
              meaning:
                "la registró quien tenía la caja, desde el POS, con plata de un día anterior que estaba en el cajón. Ya descuenta del saldo por consignar; confirmala o rechazala desde «⋯».",
            },
            {
              term: "Rechazada",
              meaning: "una consignación del POS que el administrador no aceptó: se reversó con su motivo y la plata vuelve a figurar por consignar.",
            },
          ]}
        />
      )}
    </div>
  )
}

export default DepositsTab
