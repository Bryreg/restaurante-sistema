import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleCheck, Flag } from "lucide-react"
import { useId, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { confirmDeposit, getDeposits, reverseDeposit, unconfirmDeposit, type DepositOut } from "@/api/banking"
import { newIdempotencyKey } from "@/api/client"
import { fixAttendanceExit } from "@/api/attendance"
import { listAdminNovelties, reopenNoveltyAsAdmin, resolveNoveltyAsAdmin, type Novelty } from "@/api/novelties"
import type { PanelPendingExitOut } from "@/api/panel"
import type { TodayOut } from "@/api/reports"
import { approveRequest, listAdminRequests, rejectRequest, reopenRequest, type StaffRequest } from "@/api/requests"
import type { Notice, NoticeSeverity } from "@/components/admin"
import { Button, buttonVariants } from "@/components/ui/button"
import { formatClockTime } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { NOVELTIES_QUERY_KEYS } from "@/features/novelties/lib"
import { REQUESTS_QUERY_KEYS } from "@/features/requests/lib"

import { fichaPersonaHref, fichaTurnoHref } from "../fichas/rutas"
import { daysAgoInBogota } from "../lib"

/**
 * **«Requiere tu atención» con las acciones en el mismo lugar** (handoff,
 * `AdminHoy` variante A): confirmar una consignación mirando la foto,
 * aprobar o rechazar un sencillo, revisar una novedad, marcar una salida
 * olvidada. Cada acción es una mutación **optimista**: el aviso pasa a
 * «✓ Confirmada por ti · 12:55 p. m.» en el acto y, si el servidor la
 * rechaza, vuelve a como estaba con el mensaje del servidor. Nada se borra:
 * lo resuelto queda a la vista con «Reversar con motivo», que usa el
 * endpoint de reversa de cada cosa (y queda en el historial).
 *
 * Donde no hay forma de resolver en el lugar —cerrar un turno abandonado
 * pide el cierre administrativo completo; la base de respaldo no tiene
 * todavía cómo avisarle a la tablet— el aviso lleva a la ficha que lo
 * resuelve.
 *
 * Los recuentos del servidor (`GET /admin/today`) siguen mandando: si la
 * lista de una clase todavía no llegó —o no se pudo leer—, queda el aviso
 * agregado de siempre («2 consignaciones por confirmar»), que no pierde
 * nada.
 */

/** Cuántos días atrás se buscan consignaciones por confirmar. */
const DIAS_CONSIGNACIONES = 60

type Tipo = "ok" | "no"

/** Qué pide una acción antes de mandarse. */
interface Pide {
  /** El rótulo del campo: «¿Qué no coincide?». */
  etiqueta: string
  /** Una hora (salida olvidada) además del motivo. */
  hora?: { etiqueta: string; defecto: string }
  confirmar: string
}

interface Accion {
  id: string
  label: string
  primaria: boolean
  pide?: Pide
  /** Lo manda al servidor. Devuelve el instante que el servidor anotó, si lo dice. */
  run: (motivo: string, hora: string) => Promise<string | null | undefined>
  tipo: Tipo
  /** «Confirmada por ti»: el rastro, sin la hora (la pone el riel). */
  hecho: string
  /** La reversa de ESTA resolución, con motivo. Sin ella, `sinReversa` dice por qué. */
  reversa?: (motivo: string) => Promise<unknown>
  sinReversa?: string
}

export interface Accionable {
  key: string
  /** Qué aviso agregado de Hoy reemplaza («deposits-to-confirm»). */
  reemplaza: string
  severity: NoticeSeverity
  title: string
  consequence: string
  amount?: string
  foto?: { src: string; rotulo: string }
  /** El destino secundario, a la derecha de los botones: «Ficha del turno». */
  destino?: { to: string; label: string }
  acciones: Accion[]
}

interface Resuelto {
  item: Accionable
  accion: Accion
  en: string
  estado: "resuelto" | "reversando" | "reabierto"
}

function horaDe(iso: string | null | undefined): string {
  return iso ? formatClockTime(iso) : ""
}

/** «ayer» o «el mar 16 sep», dicho contra el día operativo de hoy. */
function cuando(fecha: string, hoy: string): string {
  const ayer = daysBeforeIso(hoy, 1)
  return fecha === ayer ? "ayer" : `el ${formatFechaCorta(fecha)}`
}

/** Un día de calendario antes (sólo fechas, `Date.UTC`: no hay zona de por medio). */
function daysBeforeIso(iso: string, dias: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return ""
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - dias))
  const dos = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())}`
}

function depositoAccionable(d: DepositOut, invalidar: () => void): Accionable {
  const fecha = d.business_date ? formatFechaCorta(d.business_date) : "otro día"
  return {
    key: `deposito-${d.id}`,
    reemplaza: "deposits-to-confirm",
    severity: "warning",
    title: `Consignación del ${fecha} por confirmar`,
    consequence: [
      d.employee_name ? `La hizo ${d.employee_name}` : "La hizo quien tenía la caja",
      d.deposited_at ? `a las ${horaDe(d.deposited_at)}` : null,
      d.bank_name ? `en ${d.bank_name}` : null,
    ]
      .filter(Boolean)
      .join(" ")
      .concat(". Falta confirmar que el banco la recibió."),
    amount: d.amount !== undefined ? formatCOP(d.amount) : undefined,
    foto: d.receipt_photo ? { src: d.receipt_photo, rotulo: `foto del comprobante${d.bank_name ? ` · ${d.bank_name}` : ""}` } : undefined,
    destino: d.from_shift_id ? { to: fichaTurnoHref(d.from_shift_id), label: "Ficha del turno" } : undefined,
    acciones: [
      {
        id: "confirmar",
        label: "Confirmar consignación",
        primaria: true,
        tipo: "ok",
        hecho: "Confirmada por ti",
        run: async () => {
          const out = await confirmDeposit(d.id)
          invalidar()
          return out.confirmed_at
        },
        reversa: async (motivo) => {
          await unconfirmDeposit(d.id, { reason: motivo }, newIdempotencyKey())
          invalidar()
        },
      },
      {
        id: "no-coincide",
        label: "No coincide",
        primaria: false,
        pide: { etiqueta: "¿Qué no coincide? (lo ve quien consignó)", confirmar: "Rechazar la consignación" },
        tipo: "no",
        hecho: "Rechazada: la plata vuelve a figurar por consignar",
        run: async (motivo) => {
          const out = await reverseDeposit(d.id, { reason: motivo }, newIdempotencyKey())
          invalidar()
          return out.reversed_at
        },
        sinReversa: "Una consignación rechazada no se reabre: si sí llegó, se registra de nuevo en Caja › Banco.",
      },
    ],
  }
}

function denominaciones(r: StaffRequest): string {
  const filas = r.requested_denominations ?? []
  return filas
    .filter((f) => f.count > 0)
    .map((f) => `${f.count} de ${formatCOP(f.value)}`)
    .join(", ")
}

function solicitudAccionable(r: StaffRequest, invalidar: () => void): Accionable {
  const sencillo = r.kind === "change"
  const lineas = r.lines.map((l) => `${l.qty_requested_entry} ${l.entry_unit} de ${l.ingredient_name}`).join(", ")
  return {
    key: `solicitud-${r.id}`,
    reemplaza: "requests-pending",
    severity: "warning",
    title: `${r.requested_by.name} pide ${sencillo ? "sencillo" : "insumos"}`,
    consequence: [
      sencillo ? denominaciones(r) : lineas,
      `pedido a las ${horaDe(r.requested_at)}${sencillo ? " desde la cinta de caja" : ""}`,
      r.reason ? `«${r.reason}»` : r.note ? `«${r.note}»` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    amount: sencillo && r.requested_total != null ? formatCOP(r.requested_total) : undefined,
    acciones: [
      {
        id: "aprobar",
        label: "Aprobar",
        primaria: true,
        tipo: "ok",
        hecho: `Aprobada · ${r.requested_by.name} la ve en la tablet`,
        run: async () => {
          const out = await approveRequest(r.id, {})
          invalidar()
          return out.resolved_at
        },
        reversa: async (motivo) => {
          await reopenRequest(r.id, motivo)
          invalidar()
        },
      },
      {
        id: "rechazar",
        label: "Rechazar",
        primaria: false,
        pide: { etiqueta: "Motivo del rechazo (lo ve quien pidió)", confirmar: "Rechazar" },
        tipo: "no",
        hecho: "Rechazada con motivo",
        run: async (motivo) => {
          const out = await rejectRequest(r.id, motivo)
          invalidar()
          return out.resolved_at
        },
        reversa: async (motivo) => {
          await reopenRequest(r.id, motivo)
          invalidar()
        },
      },
    ],
  }
}

function novedadAccionable(n: Novelty, storeId: number, invalidar: () => void): Accionable {
  return {
    key: `novedad-${n.id}`,
    reemplaza: "novelties-open",
    severity: n.level === "urgent" ? "critical" : "warning",
    title: `Novedad: ${n.title}`,
    consequence: [n.detail, `La registró ${n.employee_name} a las ${horaDe(n.created_at)}.`].filter(Boolean).join(" "),
    foto: n.photo ? { src: n.photo, rotulo: "foto de la novedad" } : undefined,
    destino: { to: fichaPersonaHref(n.employee_id), label: `Ficha de ${n.employee_name.split(" ")[0]}` },
    acciones: [
      {
        id: "revisar",
        label: "Revisar novedad",
        primaria: true,
        pide: { etiqueta: "¿Cómo se resolvió? (queda en la novedad)", confirmar: "Marcar revisada" },
        tipo: "ok",
        hecho: `Revisada · queda en la ficha de ${n.employee_name.split(" ")[0]}`,
        run: async (nota) => {
          const out = await resolveNoveltyAsAdmin(storeId, n.id, nota, newIdempotencyKey())
          invalidar()
          return out.resolved_at
        },
        reversa: async (motivo) => {
          await reopenNoveltyAsAdmin(storeId, n.id, motivo, newIdempotencyKey())
          invalidar()
        },
      },
    ],
  }
}

function salidaAccionable(e: PanelPendingExitOut, storeId: number, hoy: string, invalidar: () => void): Accionable {
  // La hora que se ofrece es la de cierre del día que quedó abierto; el
  // dueño la cambia si no fue esa. La zona la pone el servidor.
  const defecto = `${e.business_date}T23:00`
  return {
    key: `salida-${e.entry_id}`,
    reemplaza: "attendance-review",
    // «Aviso» y no «para cuando puedas»: la cola sin urgencia se pliega, y
    // la salida olvidada deja horas de nómina sin contar (el mismo nivel que
    // el aviso agregado de siempre).
    severity: "warning",
    title: `${e.name} no marcó salida ${cuando(e.business_date, hoy)}`,
    // «a. m.» ya termina en punto: no se le suma otro («9:28 a. m..»).
    consequence: `Entró a las ${horaDe(e.in_at).replace(/\.$/, "")}. Esas horas no cuentan para la nómina hasta corregir la salida.`,
    destino: { to: fichaPersonaHref(e.employee_id), label: `Ficha de ${e.name.split(" ")[0]}` },
    acciones: [
      {
        id: "salida",
        label: "Marcar salida",
        primaria: true,
        pide: {
          etiqueta: "Motivo de la corrección",
          hora: { etiqueta: "Hora de salida", defecto },
          confirmar: "Marcar salida",
        },
        tipo: "ok",
        hecho: "Salida marcada por ti con motivo",
        run: async (motivo, hora) => {
          const out = await fixAttendanceExit(e.entry_id, { store_id: storeId, out_at: hora, reason: motivo })
          invalidar()
          return out.out_at
        },
        sinReversa: "Una salida corregida no se reversa desde acá: queda en Nómina › Horas con su motivo.",
      },
    ],
  }
}

/**
 * Los avisos accionables de la sede activa y el estado de lo resuelto en
 * esta visita. Devuelve las claves de los avisos agregados que reemplazan
 * (sólo cuando su lista llegó y no está vacía) y los avisos listos para el
 * riel.
 */
export function useAccionables({
  storeId,
  today,
  salidas,
}: {
  storeId: number
  today: TodayOut
  salidas: PanelPendingExitOut[] | undefined
}): { reemplaza: Set<string>; notices: Notice[] } {
  const queryClient = useQueryClient()
  const [resueltos, setResueltos] = useState<Record<string, Resuelto>>({})
  const hoy = today.business_date

  const invalidar = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-today"] })
    void queryClient.invalidateQueries({ queryKey: ["admin-panel"] })
    void queryClient.invalidateQueries({ queryKey: ["hoy-consignaciones"] })
    void queryClient.invalidateQueries({ queryKey: ["requests"] })
    void queryClient.invalidateQueries({ queryKey: ["novelties"] })
  }

  const consignaciones = useQuery({
    queryKey: ["hoy-consignaciones", storeId, hoy],
    queryFn: () => getDeposits({ storeId, from: daysAgoInBogota(DIAS_CONSIGNACIONES), to: hoy }),
    enabled: (today.deposits_to_confirm_count ?? 0) > 0,
    retry: false,
  })
  const solicitudes = useQuery({
    queryKey: REQUESTS_QUERY_KEYS.adminPending(storeId),
    queryFn: () => listAdminRequests(storeId, { status: "pending" }),
    enabled: (today.requests_pending_count ?? 0) > 0,
    retry: false,
  })
  const novedades = useQuery({
    queryKey: NOVELTIES_QUERY_KEYS.adminOpen(storeId),
    queryFn: () => listAdminNovelties({ storeId, status: "open" }),
    enabled: (today.novelties_open_count ?? 0) > 0,
    retry: false,
  })

  const vivos: Accionable[] = []
  const reemplaza = new Set<string>()
  const porConfirmar = (consignaciones.data ?? []).filter((d) => d.needs_confirmation)
  if ((today.deposits_to_confirm_count ?? 0) > 0 && porConfirmar.length > 0) {
    reemplaza.add("deposits-to-confirm")
    for (const d of porConfirmar) vivos.push(depositoAccionable(d, invalidar))
  }
  const pendientes = solicitudes.data ?? []
  if ((today.requests_pending_count ?? 0) > 0 && pendientes.length > 0) {
    reemplaza.add("requests-pending")
    for (const r of pendientes) vivos.push(solicitudAccionable(r, invalidar))
  }
  const abiertas = novedades.data ?? []
  if ((today.novelties_open_count ?? 0) > 0 && abiertas.length > 0) {
    reemplaza.add("novelties-open")
    for (const n of abiertas) vivos.push(novedadAccionable(n, storeId, invalidar))
  }
  if ((today.attendance_pending_review_count ?? 0) > 0 && salidas && salidas.length > 0) {
    reemplaza.add("attendance-review")
    for (const e of salidas) vivos.push(salidaAccionable(e, storeId, hoy, invalidar))
  }

  // Lo resuelto en esta visita reemplaza también a su agregado: si la
  // lista ya volvió vacía, el aviso sigue ahí con su rastro.
  for (const r of Object.values(resueltos)) reemplaza.add(r.item.reemplaza)

  const claves = new Set(vivos.map((v) => v.key))
  const items: { item: Accionable; resuelto?: Resuelto }[] = vivos.map((item) => {
    const r = resueltos[item.key]
    return { item, resuelto: r && r.estado !== "reabierto" ? r : undefined }
  })
  for (const r of Object.values(resueltos)) {
    if (claves.has(r.item.key)) continue
    // Ya no está en la lista del servidor: resuelto (con su rastro), o
    // recién reabierto y todavía sin volver a llegar.
    items.push({ item: r.item, resuelto: r.estado === "reabierto" ? undefined : r })
  }

  const resolver = async (item: Accionable, accion: Accion, motivo: string, hora: string) => {
    const ahora = new Date().toISOString()
    setResueltos((prev) => ({ ...prev, [item.key]: { item, accion, en: ahora, estado: "resuelto" } }))
    try {
      const en = await accion.run(motivo, hora)
      if (en) setResueltos((prev) => (prev[item.key] ? { ...prev, [item.key]: { ...prev[item.key]!, en } } : prev))
    } catch (err) {
      // Rollback: el aviso vuelve a estar pendiente, con el mensaje del servidor.
      setResueltos((prev) => {
        const next = { ...prev }
        delete next[item.key]
        return next
      })
      toast.error(errorMessage(err))
    }
  }

  const reversar = async (r: Resuelto, motivo: string) => {
    if (!r.accion.reversa) return
    setResueltos((prev) => ({ ...prev, [r.item.key]: { ...r, estado: "reversando" } }))
    try {
      await r.accion.reversa(motivo)
      setResueltos((prev) => ({ ...prev, [r.item.key]: { ...r, estado: "reabierto" } }))
    } catch (err) {
      setResueltos((prev) => ({ ...prev, [r.item.key]: { ...r, estado: "resuelto" } }))
      toast.error(errorMessage(err))
    }
  }

  const notices: Notice[] = items.map(({ item, resuelto }) => ({
    id: item.key,
    severity: item.severity,
    title: item.title,
    consequence: item.consequence,
    amount: item.amount,
    actions: <AccionesAviso item={item} resuelto={resuelto} onResolver={resolver} onReversar={reversar} />,
  })) as Notice[]

  return { reemplaza, notices }
}

/** Avisos que se resuelven en otra pantalla pero van con su botón (turno abandonado, base). */
export function avisoConEnlace(
  base: Omit<Notice, "actions" | "link">,
  ir: { to: string; label: string },
): Notice {
  return {
    ...base,
    actions: (
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Un enlace con forma de botón: lleva a otra pantalla, no manda nada. */}
        <Link to={ir.to} className={cn(buttonVariants({ size: "sm" }), "h-8 px-3 text-[13px] font-semibold no-underline")}>
          {ir.label}
        </Link>
      </div>
    ),
  } as Notice
}

function Foto({ src, rotulo }: { src: string; rotulo: string }): React.JSX.Element {
  const [grande, setGrande] = useState(false)
  return (
    <button
      type="button"
      onClick={() => setGrande((g) => !g)}
      aria-expanded={grande}
      aria-label={grande ? `Achicar la ${rotulo}` : `Ampliar la ${rotulo}`}
      title={grande ? "Achicar" : "Ampliar"}
      className={cn(
        "relative block w-full overflow-hidden rounded-md border bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        grande ? "h-[220px] cursor-zoom-out" : "h-[84px] cursor-zoom-in",
      )}
    >
      <img src={src} alt={rotulo} className={cn("size-full", grande ? "object-contain" : "object-cover")} />
      {!grande ? (
        <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded bg-card px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
          {rotulo}
        </span>
      ) : null}
    </button>
  )
}

/** Un campo de motivo (y hora, si la pide) antes de mandar o reversar. */
function FormMotivo({
  pide,
  ocupado,
  onEnviar,
  onCancelar,
}: {
  pide: Pide
  ocupado: boolean
  onEnviar: (motivo: string, hora: string) => void
  onCancelar: () => void
}): React.JSX.Element {
  const [motivo, setMotivo] = useState("")
  const [hora, setHora] = useState(pide.hora?.defecto ?? "")
  const id = useId()
  const listo = motivo.trim().length > 0 && (!pide.hora || hora.length > 0)
  return (
    <form
      className="flex flex-col gap-1.5 rounded-md border bg-muted/40 p-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (listo) onEnviar(motivo.trim(), hora)
      }}
    >
      {pide.hora ? (
        <label htmlFor={`${id}-hora`} className="flex flex-col gap-0.5 text-xs font-medium">
          {pide.hora.etiqueta}
          <input
            id={`${id}-hora`}
            type="datetime-local"
            value={hora}
            onChange={(e) => setHora(e.target.value)}
            className="h-8 rounded-md border border-input bg-card px-2 text-sm"
          />
        </label>
      ) : null}
      <label htmlFor={`${id}-motivo`} className="flex flex-col gap-0.5 text-xs font-medium">
        {pide.etiqueta}
        <textarea
          id={`${id}-motivo`}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={2}
          className="rounded-md border border-input bg-card px-2 py-1 text-sm"
        />
      </label>
      <div className="flex flex-wrap gap-1.5">
        <Button type="submit" size="sm" disabled={!listo || ocupado} className="h-8 px-3 text-[13px] font-semibold">
          {pide.confirmar}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancelar} className="h-8 px-3 text-[13px]">
          Cancelar
        </Button>
      </div>
    </form>
  )
}

function AccionesAviso({
  item,
  resuelto,
  onResolver,
  onReversar,
}: {
  item: Accionable
  resuelto: Resuelto | undefined
  onResolver: (item: Accionable, accion: Accion, motivo: string, hora: string) => Promise<void>
  onReversar: (r: Resuelto, motivo: string) => Promise<void>
}): React.JSX.Element {
  const [pidiendo, setPidiendo] = useState<Accion | null>(null)
  const [reversando, setReversando] = useState(false)

  const foto = item.foto ? <Foto src={item.foto.src} rotulo={item.foto.rotulo} /> : null

  if (resuelto) {
    const ok = resuelto.accion.tipo === "ok"
    const Icono = ok ? CircleCheck : Flag
    return (
      <>
        {foto}
        <div
          role="status"
          className={cn("flex flex-wrap items-center gap-1.5 text-xs font-semibold", ok ? "text-success" : "text-warning")}
        >
          <Icono className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {ok ? "✓ " : ""}
            {resuelto.accion.hecho} · {horaDe(resuelto.en)}
          </span>
          {resuelto.accion.reversa && !reversando ? (
            <button
              type="button"
              disabled={resuelto.estado === "reversando"}
              onClick={() => setReversando(true)}
              className="ml-auto rounded-sm text-xs font-normal text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
            >
              {resuelto.estado === "reversando" ? "Reversando…" : "Reversar con motivo"}
            </button>
          ) : null}
        </div>
        {!resuelto.accion.reversa && resuelto.accion.sinReversa ? (
          <p className="text-[11px] leading-snug text-muted-foreground">{resuelto.accion.sinReversa}</p>
        ) : null}
        {reversando ? (
          <FormMotivo
            pide={{ etiqueta: "Motivo de la reversa (queda en el historial)", confirmar: "Reversar" }}
            ocupado={resuelto.estado === "reversando"}
            onCancelar={() => setReversando(false)}
            onEnviar={(motivo) => {
              setReversando(false)
              void onReversar(resuelto, motivo)
            }}
          />
        ) : null}
      </>
    )
  }

  return (
    <>
      {foto}
      {pidiendo?.pide ? (
        <FormMotivo
          pide={pidiendo.pide}
          ocupado={false}
          onCancelar={() => setPidiendo(null)}
          onEnviar={(motivo, hora) => {
            const accion = pidiendo
            setPidiendo(null)
            void onResolver(item, accion, motivo, hora)
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {item.acciones.map((a) => (
            <Button
              key={a.id}
              type="button"
              size="sm"
              variant={a.primaria ? "default" : "outline"}
              className="h-8 px-3 text-[13px] font-semibold"
              onClick={() => (a.pide ? setPidiendo(a) : void onResolver(item, a, "", ""))}
            >
              {a.label}
            </Button>
          ))}
          {item.destino ? (
            <Link
              to={item.destino.to}
              className="ml-auto rounded-sm text-xs text-primary no-underline hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {item.destino.label}
            </Link>
          ) : null}
        </div>
      )}
    </>
  )
}
