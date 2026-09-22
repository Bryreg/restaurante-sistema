import { Bike, ShoppingBag, Store, Truck } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCOP } from "@/lib/money";

/**
 * **El riel del salón** (`m2b`, pantalla 1, columna derecha de 296 px).
 *
 * Mostrador, para llevar, domicilios y plataformas conviven con el plano
 * porque el mesero los atiende desde la misma pantalla: si viven en otra
 * pestaña, el pedido para llevar que ya está listo no lo ve nadie hasta que
 * el cliente reclama.
 *
 * Sólo aparecen los canales que la sede tiene **activos y con comandas**. Un
 * grupo «Domicilios» vacío en una sede que no hace domicilios es ruido, y el
 * servidor ya no lo manda.
 */
export type CanalPos = "counter" | "takeout" | "delivery" | "platform";
export type EstadoCanal = "taking" | "in_kitchen" | "ready" | "on_the_way" | "to_pay";

export interface ComandaCanal {
  order_id: number;
  code: string;
  title: string;
  state: EstadoCanal;
  since: string;
  total: number;
}

export interface GrupoCanal {
  channel: CanalPos;
  orders: ComandaCanal[];
}

const TITULO: Record<CanalPos, string> = {
  counter: "Mostrador",
  takeout: "Para llevar",
  delivery: "Domicilios",
  platform: "Plataformas",
};

const ICONO: Record<CanalPos, typeof Store> = {
  counter: Store,
  takeout: ShoppingBag,
  delivery: Bike,
  platform: Truck,
};

/**
 * El rótulo del estado. **Lo arma la pantalla, no el servidor**: el servidor
 * publica el estado tipado y el instante, y la prosa —«En camino · salió 7:58
 * p. m.»— es presentación. Un servidor que escribe prosa no se puede traducir
 * ni reusar desde otro cliente.
 */
function rotuloEstado(estado: EstadoCanal, desde: string, tiempo: (iso: string) => string): string {
  switch (estado) {
    case "taking":
      return "Tomando pedido";
    case "in_kitchen":
      return `En cocina · ${tiempo(desde)}`;
    case "ready":
      return "Listo para entregar";
    case "on_the_way":
      return `En camino · hace ${tiempo(desde)}`;
    case "to_pay":
      return "Esperando cobro";
  }
}

export interface RielCanalesProps {
  grupos: GrupoCanal[];
  /** Formatea «hace cuánto» — se recibe para no duplicar el formateador. */
  tiempo: (iso: string) => string;
  onAbrir?: (orderId: number) => void;
  className?: string;
}

export function RielCanales({ grupos, tiempo, onAbrir, className }: RielCanalesProps): React.JSX.Element | null {
  if (grupos.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      {grupos.map((grupo) => {
        const Icono = ICONO[grupo.channel];
        return (
          <section key={grupo.channel} className="min-w-0 rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b bg-muted px-3.5 py-2.5">
              <Icono className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {/* Versalita, como las cintas y como `m2b`: el riel y el
                  resumen del salón rotulan igual porque son la misma clase
                  de encabezado. */}
              <h3 className="text-[0.76rem] font-bold tracking-[0.07em] uppercase">
                {TITULO[grupo.channel]}
              </h3>
              <span className="ml-auto text-xs text-muted-foreground">{grupo.orders.length}</span>
            </header>
            <div className="px-3.5">
              {grupo.orders.map((o) => (
                <button
                  key={o.order_id}
                  type="button"
                  onClick={() => onAbrir?.(o.order_id)}
                  aria-label={`${TITULO[grupo.channel]} ${o.code}, ${o.title}`}
                  className="flex w-full items-center gap-2.5 border-b py-2.5 text-left last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {o.code}
                  </span>
                  <span className="min-w-0 flex-1">
                    <b className="line-clamp-2 block text-sm leading-tight">{o.title}</b>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {rotuloEstado(o.state, o.since, tiempo)}
                    </span>
                  </span>
                  <b className="shrink-0 text-sm whitespace-nowrap tabular-nums">{formatCOP(o.total)}</b>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default RielCanales;
