import { cn } from "@/lib/utils";
import { formatCOP } from "@/lib/money";

/**
 * **La barra** (`m2b`, pantalla 1). Una tira con un punto por puesto en vez
 * de una tarjeta: la barra no se mira como una mesa, se mira como una fila
 * de banquitos, y el plano lo dice con la forma.
 *
 * Sigue siendo una mesa para el sistema —se abre, se cobra y se cierra
 * igual—; lo único distinto es cómo se ve. Por eso el componente recibe los
 * mismos datos que una `MesaCard` y el servidor sólo agrega una bandera
 * (`is_counter`).
 *
 * **Los puestos ocupados salen de los comensales que alguien contó**
 * (`covers`), no de una adivinanza: si nadie los contó, la tira muestra los
 * puestos vacíos y el total al lado. Pintar «6 de 6» porque hay una comanda
 * abierta sería inventar cuánta gente hay sentada.
 */
export interface BarraSitioProps {
  nombre: string;
  puestos: number;
  ocupados: number;
  total?: number | null;
  onClick?: () => void;
}

export function BarraSitio({ nombre, puestos, ocupados, total, onClick }: BarraSitioProps): React.JSX.Element {
  const tomados = Math.max(0, Math.min(ocupados, puestos));
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${nombre}: ${tomados} de ${puestos} puestos ocupados`}
      className={cn(
        "mt-3 flex w-full flex-wrap items-center gap-3 border-t border-dashed border-input pt-3 text-left text-sm",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      )}
    >
      <b className="text-[0.94rem]">{nombre}</b>

      {/* Los puntos son decorativos: lo que dice cuántos hay ocupados es el
          texto de al lado y el `aria-label` del botón — nunca sólo el color
          (WCAG 1.4.1). */}
      <span className="flex gap-1.5" aria-hidden="true">
        {Array.from({ length: puestos }, (_, i) => (
          <span
            key={i}
            className={cn(
              "size-[22px] rounded-full border",
              i < tomados ? "border-primary bg-primary" : "border-input bg-muted",
            )}
          />
        ))}
      </span>

      <span className="text-muted-foreground">
        {tomados} de {puestos} {puestos === 1 ? "puesto" : "puestos"}
      </span>

      {total != null ? <b className="ml-auto tabular-nums">{formatCOP(total)}</b> : null}
    </button>
  );
}

export default BarraSitio;
