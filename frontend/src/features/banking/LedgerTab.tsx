/**
 * Plata → Libro del banco (c2, «igual que la Plata del café»): **cuánto hay
 * en el banco hoy y de dónde salió**.
 *
 * - Arriba, la cifra rectora: lo que hay hoy, por cuenta, desde el saldo del
 *   extracto que tecleó el dueño (`GET /admin/bank/position`).
 * - El libro del período (`GET /admin/bank/ledger`): entradas Y salidas —
 *   consignaciones, datáfono, transferencias, plataformas, gastos y
 *   obligaciones pagados del banco, pagos a proveedores y lo tecleado—, con
 *   el 4×1000 de cada salida y el saldo de su cuenta después de cada renglón.
 * - Lo que viene (`GET /admin/bank/projection`).
 *
 * Ni una suma ni una resta acá: saldos, 4×1000, efectos y totales llegan del
 * servidor (AGENTS.md § "una sola matemática, en el backend"). Un saldo
 * desconocido se dice con su motivo, nunca como $ 0.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import {
  assignBankEntry,
  getBankAccounts,
  getBankLedger,
  getBankPosition,
  voidBankMovement,
  type BankAccountOut,
  type BankLedgerEntryOut,
} from "@/api/banking"
import { csvUrl, newIdempotencyKey } from "@/api/client"
import { Cargando } from "@/components/Cargando"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { DenseTable, DenseTableBar, MenuDeFila, type DenseColumn } from "@/components/admin"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { BankAccountsDialog } from "./BankAccountsDialog"
import { BankAnchorDialog } from "./BankAnchorDialog"
import { BankMovementDialog } from "./BankMovementDialog"
import { BankProjection } from "./BankProjection"
import { daysAgoLocal, ledgerEntryLabel, todayLocal } from "./lib"

function invalidateBank(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["banking"] })
}

function dias(n: number): string {
  return `${n} ${n === 1 ? "día" : "días"}`
}

/** Lo que hay hoy: total y una tarjeta por cuenta, todo del servidor. */
function PosicionDeHoy({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({ queryKey: ["banking", "position", storeId], queryFn: () => getBankPosition(storeId) })
  if (query.isLoading) return <Cargando texto="Calculando cuánto hay en el banco…" />
  if (query.isError || !query.data) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo calcular el saldo del banco"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }
  const data = query.data
  return (
    <section aria-labelledby="banco-hoy" className="space-y-3">
      <div>
        <h2 id="banco-hoy" className="text-sm font-medium text-muted-foreground">
          Hay en el banco hoy
        </h2>
        {data.total === null ? (
          <SinDato motivo={data.total_reason} forma="bloque" />
        ) : (
          <p className="text-3xl font-semibold tabular-nums">{formatCOP(data.total)}</p>
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.accounts.map((p) => (
          <li key={p.account.id ?? "principal"} className="rounded-xl border bg-card p-3 text-sm">
            <p className="font-medium">
              {p.account.name}
              {p.account.is_default ? <span className="ml-2 text-xs text-muted-foreground">principal</span> : null}
              {!p.account.active ? <span className="ml-2 text-xs text-muted-foreground">desactivada</span> : null}
            </p>
            {p.balance === null ? (
              <SinDato motivo={p.reason} forma="bloque" />
            ) : (
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
                <dt className="text-muted-foreground">
                  Extracto del {formatBusinessDate(p.anchor_date)}
                  {p.anchor_age_days !== null ? ` (hace ${dias(p.anchor_age_days)})` : ""}
                </dt>
                <dd className="text-right">{formatCOP(p.anchor_balance)}</dd>
                <dt className="text-muted-foreground">+ Entró desde entonces</dt>
                <dd className="text-right">{formatCOP(p.inflows)}</dd>
                <dt className="text-muted-foreground">− Salió</dt>
                <dd className="text-right">{formatCOP(p.outflows)}</dd>
                <dt className="text-muted-foreground">− 4×1000 {p.account.gmf_exempt ? "(exenta)" : ""}</dt>
                <dd className="text-right">{formatCOP(p.gmf)}</dd>
                <dt className="font-medium">= Hoy</dt>
                <dd className="text-right font-semibold">{formatCOP(p.balance)}</dd>
              </dl>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function AccionesDeRenglon({
  entry,
  accounts,
  storeId,
}: {
  entry: BankLedgerEntryOut
  accounts: BankAccountOut[]
  storeId: number
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const keyRef = useRef(newIdempotencyKey())
  const assign = useMutation({
    mutationFn: (accountId: number) =>
      assignBankEntry(
        storeId,
        { source_kind: entry.kind as string, source_id: entry.id as number, account_id: accountId },
        keyRef.current,
      ),
    onSuccess: () => {
      keyRef.current = newIdempotencyKey()
      invalidateBank(queryClient)
    },
  })
  const [anulando, setAnulando] = useState(false)
  const [motivo, setMotivo] = useState("")
  const voidMovement = useMutation({
    mutationFn: (reason: string) => voidBankMovement(storeId, entry.id as number, reason, keyRef.current),
    onSuccess: () => {
      keyRef.current = newIdempotencyKey()
      setAnulando(false)
      setMotivo("")
      invalidateBank(queryClient)
    },
  })
  const otras = accounts.filter((a) => a.id !== null && a.active && a.id !== entry.account_id)
  const puedeMover = entry.assignable === true && entry.id != null && otras.length > 0
  const esTecleado = entry.kind === "movement" && entry.id != null
  if (!puedeMover && !esTecleado) return null
  const nombre = `${ledgerEntryLabel(entry.kind, entry.cause)} del ${formatBusinessDate(entry.business_date)}`
  return (
    <>
      <MenuDeFila nombre={nombre} nota="Nada se borra: anular deja el movimiento en el historial con su motivo.">
        {puedeMover
          ? otras.map((a) => (
              <DropdownMenuItem key={a.id} onClick={() => assign.mutate(a.id as number)}>
                Mover a {a.name}
              </DropdownMenuItem>
            ))
          : null}
        {esTecleado ? <DropdownMenuItem onClick={() => setAnulando(true)}>Anular movimiento</DropdownMenuItem> : null}
      </MenuDeFila>
      {assign.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(assign.error)}
        </p>
      ) : null}
      <Dialog open={anulando} onOpenChange={setAnulando}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Anular {nombre.toLowerCase()}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`void-movement-${entry.id}`}>Motivo (obligatorio)</Label>
              <Textarea id={`void-movement-${entry.id}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            </div>
            {voidMovement.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(voidMovement.error)}
              </p>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              className="w-full"
              disabled={motivo.trim() === "" || voidMovement.isPending}
              onClick={() => voidMovement.mutate(motivo.trim())}
            >
              Anular {formatCOP(entry.amount ?? null)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function LedgerTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())
  const [accountId, setAccountId] = useState<number | null>(null)

  const accountsQuery = useQuery({ queryKey: ["banking", "accounts", storeId], queryFn: () => getBankAccounts(storeId) })
  const accounts = accountsQuery.data ?? []
  const query = useQuery({
    queryKey: ["banking", "ledger", storeId, from, to, accountId],
    queryFn: () => getBankLedger({ storeId, from, to, accountId }),
  })

  const entries = query.data?.entries ?? []
  const totals = query.data?.totals
  const varias = accounts.length > 1

  const columns: DenseColumn<BankLedgerEntryOut>[] = [
    { key: "date", header: "Fecha", kind: "name", cell: (e) => formatBusinessDate(e.business_date) },
    // La celda escribe la palabra del negocio, no el enum (§ 8c).
    { key: "kind", header: "Tipo", cell: (e) => ledgerEntryLabel(e.kind, e.cause) },
    {
      key: "effect",
      header: "Entra / sale",
      kind: "number",
      cell: (e) => formatCOP(e.net_effect ?? null),
      cellTitle: (e) => (e.gmf ? `Incluye ${formatCOP(e.gmf)} de 4×1000` : undefined),
    },
    {
      key: "balance",
      header: "Saldo",
      kind: "number",
      cell: (e) => (e.balance_after == null ? "—" : formatCOP(e.balance_after)),
      cellTitle: (e) => (e.balance_after == null ? "Antes del saldo del extracto: nadie sabe cuánto había" : undefined),
    },
    {
      key: "detail",
      header: "Detalle",
      kind: "secondary",
      cell: (e) => e.description ?? e.reference ?? e.note ?? "—",
      cellTitle: (e) => e.note ?? undefined,
    },
    { key: "account", header: "Cuenta", kind: "secondary", secondary: !varias, cell: (e) => e.account_name || "—" },
    { key: "gmf", header: "4×1000", kind: "number", secondary: true, cell: (e) => formatCOP(e.gmf ?? 0) },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (e) => <AccionesDeRenglon entry={e} accounts={accounts} storeId={storeId} />,
    },
  ]

  return (
    <div className="space-y-6">
      <PosicionDeHoy storeId={storeId} />

      <div className="flex flex-wrap gap-2">
        <BankAnchorDialog storeId={storeId} accounts={accounts} />
        <BankMovementDialog storeId={storeId} accounts={accounts} />
        <BankAccountsDialog storeId={storeId} accounts={accounts} />
      </div>

      <section aria-labelledby="banco-libro" className="space-y-3">
        <h2 id="banco-libro" className="text-base font-semibold">
          De dónde salió: el libro
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeFilter
            idPrefix="bank-ledger"
            from={from}
            to={to}
            onChange={(r) => {
              setFrom(r.from)
              setTo(r.to)
            }}
          />
          {varias ? (
            <label className="inline-flex flex-col gap-1 text-sm">
              Cuenta
              <select
                className="h-9 rounded-md border border-input bg-card px-2"
                value={accountId ?? ""}
                onChange={(e) => setAccountId(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Todas las cuentas</option>
                {accounts
                  .filter((a) => a.id !== null)
                  .map((a) => (
                    <option key={a.id} value={a.id as number}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          <CsvExportButton href={csvUrl("/admin/bank/ledger", { store_id: storeId, from, to, account_id: accountId ?? undefined })} />
        </div>

        {query.isLoading ? (
          <Cargando texto="Cargando el libro del banco…" />
        ) : query.isError ? (
          <EmptyState
            reason="error"
            title="No se pudo cargar el libro del banco"
            description={errorMessage(query.error)}
            action={{ label: "Reintentar", onClick: () => void query.refetch() }}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            reason="filter"
            title="No hay movimientos de banco en este período"
            description={`El filtro puesto es el período: ${from} a ${to}.`}
          />
        ) : (
          <div className="space-y-3">
            {totals ? (
              <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm tabular-nums">
                <dt className="text-muted-foreground">Entró en el período</dt>
                <dd className="text-right">{formatCOP(totals.inflows ?? totals.total)}</dd>
                <dt className="text-muted-foreground">Salió</dt>
                <dd className="text-right">{formatCOP(totals.outflows ?? null)}</dd>
                <dt className="text-muted-foreground">4×1000</dt>
                <dd className="text-right">{formatCOP(totals.gmf ?? null)}</dd>
                <dt className="font-medium">Neto del período</dt>
                <dd className="text-right font-semibold">{formatCOP(totals.net ?? null)}</dd>
              </dl>
            ) : null}
            <DenseTable
              caption="Movimientos de banco del período: lo que entró, lo que salió y el saldo de cada cuenta."
              columns={columns}
              rows={entries}
              // El `id` es de la tabla de origen: una consignación #3 y un gasto #3 conviven.
              rowKey={(entry) =>
                `${entry.kind}-${entry.direction}-${entry.id ?? `${entry.business_date}-${entry.amount}`}-${entry.account_id ?? "p"}`
              }
              maxBodyHeightPx={460}
              bar={<DenseTableBar shown={entries.length} total={entries.length} noun="movimientos de banco" hidden={`del ${from} al ${to}`} />}
              legend={[
                {
                  term: "Saldo del extracto",
                  meaning:
                    "es con cuánto cerró la cuenta el día que tecleaste. El libro suma desde el día siguiente; antes de ese día el saldo va en «—».",
                },
                {
                  term: "4×1000",
                  meaning: "cada salida de una cuenta no exenta paga 4 pesos por cada mil. Una cuenta marcada exenta no lo paga.",
                },
                {
                  term: "Este libro no es el extracto",
                  meaning:
                    "es lo que el sistema tiene registrado. Si el banco dice otra cosa, lo que falta es registrar el movimiento o teclear un saldo nuevo.",
                },
              ]}
            />
          </div>
        )}
      </section>

      <BankProjection storeId={storeId} />
    </div>
  )
}

export default LedgerTab
