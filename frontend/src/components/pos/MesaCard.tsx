import { CalendarClock, Clock, Receipt } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCOP } from "@/lib/money";

/**
 * **La tarjeta de mesa** de la maqueta `m2b`, pantalla 1 (Mesas).
 *
 * La forma no es decorativa: cada renglón está donde está por una razón.
 *
 * - **El número, solo y grande** (22 px). No «Mesa 7»: en el plano del salón
 *   la palabra «Mesa» se repite doce veces y no distingue nada. El número es
 *   lo que alguien busca de lejos y de pie.
 * - **La barra de color arriba** dice el estado sin leer. Es la única señal
 *   que sobrevive a mirar el plano desde tres metros, que es como se mira.
 * - **El total anclado abajo** (`mt-auto`). Todas las mesas tienen su plata a
 *   la misma altura, así que la columna se barre de un vistazo aunque las
 *   tarjetas tengan distinto contenido arriba.
 * - **Quién atiende**, al pie. Lo publica el servidor (`served_by`,
 *   congelado en la comanda), no lo deduce la pantalla.
 *
 * **`is_slow` viene del servidor.** «Lenta» es una regla de negocio —cuántos
 * minutos son demasiados— y ya existe una sola, la que alimenta las
 * notificaciones de comanda atascada. Calcularla acá crearía una segunda.
 *
 * **El sexto estado de la maqueta, «reservada»**, ya no es una promesa
 * vacía: la mesa libre con una reserva cerca se dibuja punteada, con la hora
 * y el nombre de quien viene. Quién está apartado y desde cuándo lo decide el
 * servidor (`pos.reservations`), no esta tarjeta — igual que `is_slow`.
 *
 * **Apartada no es ocupada.** La tarjeta sigue siendo un botón que abre la
 * mesa: el cliente puede llegar antes, o no llegar, y el mesero tiene que
 * poder sentar a alguien sin pelear con el sistema. Por eso el borde es
 * punteado y no un color sólido: es un aviso, no un candado.
 */
export type EstadoMesa = "free" | "occupied" | "to_pay";

export interface ReservaDeMesa {
  /** Hora de la reserva, **ya formateada** («9:00 p. m.»). */
  hora: string;
  nombre: string;
  personas: number;
}

export interface MesaCardProps {
  numero: string;
  puestos: number;
  estado: EstadoMesa;
  /**
   * Cuánto lleva abierta, **ya formateado** («18 min», «1 h 12»). Se recibe
   * hecho y no en minutos a propósito: el formateador ya existe en
   * `features/orders/lib.ts` (`elapsedLabel`), es el que usa el resto del POS,
   * y un segundo formateador acá diría «1 h 02» donde el otro dice «1h 2».
   */
  tiempo?: string | null;
  /** Total de la comanda, en pesos. `null` cuando la mesa está libre. */
  total?: number | null;
  /** Quién abrió la mesa. Lo publica el servidor. */
  atiende?: string | null;
  /** Pasó el umbral de demasiado tiempo. Lo decide el servidor. */
  lenta?: boolean;
  /**
   * La reserva que espera esta mesa, cuando hay una cerca. Sólo llega en
   * mesas libres y sólo dentro de la ventana que decide el servidor: una
   * reserva de las 9 p. m. no aparta la mesa desde el almuerzo.
   */
  reserva?: ReservaDeMesa | null;
  /** Seleccionada en un modo de unir o mover. */
  seleccionada?: boolean;
  onClick?: () => void;
}

const ROTULO: Record<EstadoMesa, string> = {
  free: "Libre",
  occupied: "Ocupada",
  to_pay: "Pidió cuenta",
};

export function MesaCard({
  numero,
  puestos,
  estado,
  tiempo,
  total,
  atiende,
  lenta = false,
  reserva = null,
  seleccionada = false,
  onClick,
}: MesaCardProps): React.JSX.Element {
  const libre = estado === "free";
  const porCobrar = estado === "to_pay";
  const apartada = libre && reserva != null;
  // «Lenta» pinta encima de «ocupada», pero nunca encima de «pidió cuenta»:
  // una mesa que ya pidió la cuenta necesita que la cobren, y ése es el aviso
  // útil. Dos alarmas sobre la misma tarjeta no dicen cuál atender primero.
  const alarmada = lenta && !porCobrar;

  const Icono = porCobrar ? Receipt : apartada ? CalendarClock : libre ? CalendarClock : Clock;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        apartada
          ? `Mesa ${numero}, reservada a las ${reserva.hora} para ${reserva.nombre}, ${reserva.personas} personas`
          : `Mesa ${numero}, ${ROTULO[estado]}${alarmada ? ", demorada" : ""}`
      }
      aria-pressed={seleccionada || undefined}
      className={cn(
        // `overflow-hidden` para que la barra de color se recorte contra el
        // radio de la tarjeta en vez de asomar por las esquinas.
        "relative flex min-h-[104px] min-w-0 flex-col gap-0.5 overflow-hidden rounded-xl border p-2.5 pt-3 text-left transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        libre ? "border-input bg-card" : "border-input bg-muted",
        // Punteado, no de color: es un aviso, no un candado. La mesa se
        // sigue pudiendo abrir.
        apartada && "border-dashed",
        porCobrar && "border-warning-line bg-warning-soft",
        alarmada && "border-destructive-line bg-destructive-soft",
        seleccionada && "border-primary bg-accent ring-2 ring-accent",
      )}
    >
      {/* La barra de estado. 4 px, ancho completo, pegada al borde superior. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-0 top-0 h-1",
          libre && "bg-border",
          apartada && "bg-input",
          estado === "occupied" && "bg-primary",
          porCobrar && "bg-warning",
          alarmada && "bg-destructive",
        )}
      />

      <span className="text-[1.375rem] leading-none font-bold">{numero}</span>
      <span className="text-xs text-muted-foreground">
        {puestos} {puestos === 1 ? "puesto" : "puestos"}
      </span>

      <span
        className={cn(
          "mt-1 flex items-center gap-1 text-[0.8rem]",
          libre && "text-muted-foreground",
          apartada && "text-foreground",
          estado === "occupied" && "text-primary",
          porCobrar && "font-bold text-warning",
          alarmada && "font-bold text-destructive",
        )}
      >
        {libre && !apartada ? null : <Icono className="size-3.5 shrink-0" aria-hidden="true" />}
        {apartada ? reserva.hora : libre ? ROTULO.free : porCobrar ? ROTULO.to_pay : (tiempo ?? ROTULO.occupied)}
      </span>

      {/* A nombre de quién. Va donde en una mesa ocupada va la plata: es el
          dato que hace que la tarjeta signifique algo. */}
      {apartada ? (
        <span className="mt-auto truncate text-[0.9rem]">{reserva.nombre}</span>
      ) : null}

      {/* El total, anclado abajo: todas las mesas lo tienen a la misma altura. */}
      {total != null ? (
        <span className="mt-auto text-[0.97rem] font-bold tabular-nums">{formatCOP(total)}</span>
      ) : null}
      {atiende ? (
        <span className={cn("truncate text-xs text-muted-foreground", total == null && "mt-auto")}>
          {atiende}
        </span>
      ) : null}
    </button>
  );
}

export default MesaCard;
