import { cn } from "@/lib/utils";
import { formatCOP } from "@/lib/money";

/**
 * **Las cintas del salón** (`m2b`, pantalla 1). Cuatro datos que contestan lo
 * que un mesero se pregunta al levantar la vista: cuánto queda por rotar,
 * cuánto vale una mesa, cuál lleva demasiado y a quién hay que ir a cobrar.
 *
 * **«Abierto en mesas» no está acá**: en la maqueta es la cifra grande de la
 * cabecera, no una cinta más. Metida entre las otras cuatro se pierde, y es
 * justamente el número que el dueño mira primero.
 *
 * Las cifras vienen enteras del servidor (`summary` de `GET /tables/status`).
 * `average_open` puede ser `null` y eso NO es `$ 0`: el promedio de cero mesas
 * ocupadas es «no hay promedio», y escribir cero ahí sería inventar un dato.
 */
export interface SalonResumenProps {
  tablesTotal: number;
  tablesOccupied: number;
  averageOpen: number | null;
  oldestTable: string | null;
  oldestLabel: string | null;
  askedForBill: number;
  className?: string;
}

function Cinta({ rotulo, children }: { rotulo: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3.5 py-2.5">
      {/* Versalita con interletrado, como `m2b`: el rótulo tiene que leerse
          como etiqueta y no competir con la cifra que está debajo. */}
      <span className="block text-[0.7rem] tracking-[0.07em] text-muted-foreground uppercase">
        {rotulo}
      </span>
      <b className="block text-lg leading-tight tabular-nums">{children}</b>
    </div>
  );
}

export function SalonResumen({
  tablesTotal,
  tablesOccupied,
  averageOpen,
  oldestTable,
  oldestLabel,
  askedForBill,
  className,
}: SalonResumenProps): React.JSX.Element {
  return (
    <div className={cn("flex flex-wrap gap-2.5", className)}>
      <Cinta rotulo="Ocupadas">
        {tablesOccupied} de {tablesTotal}
      </Cinta>
      <Cinta rotulo="Cuenta promedio">{averageOpen == null ? "—" : formatCOP(averageOpen)}</Cinta>
      <Cinta rotulo="Mesa más antigua">
        {oldestTable == null ? "—" : `${oldestTable} · ${oldestLabel ?? ""}`}
      </Cinta>
      <Cinta rotulo="Pidieron la cuenta">
        {askedForBill === 0 ? "Ninguna" : `${askedForBill} ${askedForBill === 1 ? "mesa" : "mesas"}`}
      </Cinta>
    </div>
  );
}

export default SalonResumen;
