import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Phone, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { newIdempotencyKey } from "@/api/client";
import {
  closeReservation,
  createReservation,
  listReservations,
  type ReservationOut,
  type ReservationStatus,
} from "@/api/reservations";
import { listTablesStatus, type TableStatusOut } from "@/api/orders";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

/**
 * `/pos/reservas` — apartar una mesa, ver las del día y cerrar las que no
 * llegaron.
 *
 * Vive en el **salón** y no en la oficina porque quien contesta el teléfono
 * está en el salón. El administrador ve la misma lista desde
 * `GET /admin/reservations` cuando quiere mirar a fin de mes cuántos no
 * llegaron.
 *
 * Ninguna regla de negocio está acá: el choque de dos reservas sobre la misma
 * mesa, el tope de puestos y la exigencia de motivo al cancelar los decide el
 * servidor, y esta pantalla muestra el mensaje que devuelve. Es a propósito —
 * una segunda copia de «90 minutos» en el cliente se desincroniza el día que
 * alguien cambie la del servidor.
 */

const RELOJ = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  hour: "numeric",
  minute: "2-digit",
});

function hora(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : RELOJ.format(d);
}

const ESTADO: Record<ReservationStatus, { texto: string; variante: "outline" | "secondary" | "default" | "destructive" }> = {
  booked: { texto: "Esperando", variante: "default" },
  seated: { texto: "Llegaron", variante: "secondary" },
  cancelled: { texto: "Cancelada", variante: "outline" },
  no_show: { texto: "No llegaron", variante: "destructive" },
};

/**
 * La hora que teclea una persona («20:30») es hora de pared de Bogotá. Se
 * convierte a instante UTC construyendo la fecha con el desfase fijo de
 * Colombia (−05:00, sin horario de verano) en vez de con `new Date(local)`,
 * que interpretaría la hora en la zona del navegador: una tablet con la zona
 * mal puesta apartaría la mesa cinco horas antes.
 */
function instanteDesdeHoraDeBogota(fecha: string, horaLocal: string): string {
  return new Date(`${fecha}T${horaLocal}:00-05:00`).toISOString();
}

/** La fecha de hoy en Bogotá, "YYYY-MM-DD", para el valor inicial del campo. */
function hoyEnBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}

export function ReservationsPage(): React.JSX.Element {
  const { hasFeature } = useSession();
  const habilitada = hasFeature("pos.reservations");
  const queryClient = useQueryClient();

  const [fecha, setFecha] = useState(hoyEnBogota);
  const [tableId, setTableId] = useState<string>("");
  const [horaLocal, setHoraLocal] = useState("20:00");
  const [nombre, setNombre] = useState("");
  const [personas, setPersonas] = useState("2");
  const [telefono, setTelefono] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reservas = useQuery({
    queryKey: ["reservations", fecha],
    queryFn: () => listReservations(fecha),
    enabled: habilitada,
  });
  const mesas = useQuery({
    queryKey: ["tables", "status"],
    queryFn: listTablesStatus,
    enabled: habilitada,
  });

  const crear = useMutation({
    mutationFn: () =>
      createReservation(
        {
          table_id: Number(tableId),
          at: instanteDesdeHoraDeBogota(fecha, horaLocal),
          party_name: nombre.trim(),
          party_size: Number(personas) || 1,
          phone: telefono.trim() || null,
        },
        newIdempotencyKey(),
      ),
    onSuccess: (r) => {
      setError(null);
      setNombre("");
      setTelefono("");
      toast.success(`Mesa ${r.table?.number ?? ""} apartada para ${r.party_name}.`);
      void queryClient.invalidateQueries({ queryKey: ["reservations"] });
      void queryClient.invalidateQueries({ queryKey: ["tables", "status"] });
    },
    // El mensaje del servidor tal cual: nombra a quién le pertenece la mesa
    // y qué hacer. Reescribirlo acá perdería las dos cosas.
    onError: (err) => setError(errorMessage(err)),
  });

  const cerrar = useMutation({
    mutationFn: ({ id, status, reason }: { id: number; status: "cancelled" | "no_show"; reason?: string }) =>
      closeReservation(id, { status, reason: reason ?? null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reservations"] });
      void queryClient.invalidateQueries({ queryKey: ["tables", "status"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!habilitada) {
    return (
      <EmptyState
        title="Las reservas no están habilitadas"
        description="Un administrador puede encenderlas en Admin → Funciones (pos.reservations)."
      />
    );
  }

  const libres: TableStatusOut[] = (mesas.data?.zones ?? [])
    .flatMap((z) => z.tables ?? [])
    .filter((t) => t.status === "free");
  const filas = reservas.data ?? [];
  const puedeGuardar = tableId !== "" && nombre.trim() !== "" && horaLocal !== "";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <header className="flex flex-wrap items-start gap-4 rounded-xl border bg-muted px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-semibold">Reservas</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Apartar una mesa a una hora, a nombre de alguien. La mesa apartada sigue libre hasta que llegan.
          </p>
        </div>
        <div className="ml-auto">
          <Label htmlFor="reservas-fecha" className="text-xs text-muted-foreground">
            Día
          </Label>
          <Input
            id="reservas-fecha"
            type="date"
            className="h-11"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
          />
        </div>
      </header>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-bold">Apartar una mesa</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="reserva-mesa">Mesa</Label>
            <Select value={tableId || undefined} onValueChange={(v) => setTableId(v ?? "")}>
              <SelectTrigger id="reserva-mesa" className="h-11">
                <SelectValue placeholder="Elegí una mesa" />
              </SelectTrigger>
              <SelectContent>
                {libres.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    Mesa {t.number} · {t.seats} puestos
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="reserva-hora">Hora</Label>
            <Input
              id="reserva-hora"
              type="time"
              className="h-11"
              value={horaLocal}
              onChange={(e) => setHoraLocal(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reserva-personas">Personas</Label>
            <Input
              id="reserva-personas"
              type="number"
              min={1}
              className="h-11"
              value={personas}
              onChange={(e) => setPersonas(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="reserva-nombre">A nombre de</Label>
            <Input
              id="reserva-nombre"
              className="h-11"
              placeholder="Familia Rincón"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reserva-telefono">Teléfono (opcional)</Label>
            <Input
              id="reserva-telefono"
              className="h-11"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
            />
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button
          type="button"
          className="h-11"
          disabled={!puedeGuardar || crear.isPending}
          onClick={() => crear.mutate()}
        >
          <CalendarClock aria-hidden="true" />
          {crear.isPending ? "Apartando…" : "Apartar la mesa"}
        </Button>
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-bold">Reservas del día</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            {filas.length} {filas.length === 1 ? "reserva" : "reservas"}
          </span>
        </div>

        {reservas.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : filas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ninguna reserva para este día.</p>
        ) : (
          <ul className="divide-y">
            {filas.map((r) => (
              <Fila key={r.id} reserva={r} onCerrar={(status, reason) => cerrar.mutate({ id: r.id, status, reason })} />
            ))}
          </ul>
        )}
        {/* La lista muestra TODO, incluidas las canceladas y las que no
            llegaron: quién no llegó es lo que alguien mira a fin de mes, y
            esconderlas sería borrarlas de otra manera. */}
        <p className="border-t pt-2 text-xs text-muted-foreground">
          Las canceladas y las que no llegaron siguen en la lista, con su motivo y su hora. Nada se borra.
        </p>
      </section>
    </div>
  );
}

function Fila({
  reserva,
  onCerrar,
}: {
  reserva: ReservationOut;
  onCerrar: (status: "cancelled" | "no_show", reason?: string) => void;
}): React.JSX.Element {
  const [motivo, setMotivo] = useState("");
  const [cancelando, setCancelando] = useState(false);
  const estado = ESTADO[reserva.status ?? "booked"];
  const viva = reserva.status === "booked";

  return (
    <li className={cn("flex flex-wrap items-start gap-3 py-3", !viva && "opacity-70")}>
      <span className="w-20 shrink-0 text-lg font-bold tabular-nums">{hora(reserva.at)}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{reserva.party_name ?? "—"}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={estado.variante}>{estado.texto}</Badge>
          <span>
            Mesa {reserva.table?.number ?? "—"} · {reserva.party_size ?? 0}{" "}
            {reserva.party_size === 1 ? "persona" : "personas"}
          </span>
          {reserva.phone ? (
            <span className="flex items-center gap-1">
              <Phone className="size-3" aria-hidden="true" />
              {reserva.phone}
            </span>
          ) : null}
        </span>
        {reserva.closed_reason ? (
          <span className="mt-1 block text-xs text-muted-foreground">Motivo: {reserva.closed_reason}</span>
        ) : null}
        {reserva.seated_order_id ? (
          <span className="mt-1 block text-xs text-muted-foreground">
            Se sentaron · comanda #{reserva.seated_order_id}
          </span>
        ) : null}
      </span>

      {viva ? (
        cancelando ? (
          <span className="flex flex-wrap items-end gap-2">
            <span className="space-y-1">
              <Label htmlFor={`motivo-${reserva.id}`} className="text-xs">
                Por qué se cancela
              </Label>
              <Input
                id={`motivo-${reserva.id}`}
                className="h-11 w-56"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
              />
            </span>
            <Button
              type="button"
              className="h-11"
              disabled={motivo.trim() === ""}
              onClick={() => onCerrar("cancelled", motivo.trim())}
            >
              Confirmar
            </Button>
            <Button type="button" variant="ghost" className="h-11" onClick={() => setCancelando(false)}>
              Volver
            </Button>
          </span>
        ) : (
          <span className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => onCerrar("no_show")}
              aria-label={`Marcar que no llegaron: ${reserva.party_name ?? ""}`}
            >
              <X aria-hidden="true" />
              No llegaron
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setCancelando(true)}
              aria-label={`Cancelar la reserva de ${reserva.party_name ?? ""}`}
            >
              Cancelar
            </Button>
          </span>
        )
      ) : reserva.status === "seated" ? (
        <Check className="size-5 shrink-0 text-success" aria-hidden="true" />
      ) : null}
    </li>
  );
}

export default ReservationsPage;
