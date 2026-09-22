import { cn } from "@/lib/utils";
import { formatCOP } from "@/lib/money";

/**
 * **Las cintas del salón** (`m2b`, pantalla 1). Cuatro datos que contestan lo
 * que un mesero se pregunta al levantar la vista: cuánto queda por rotar,
 * cuánto vale una mesa, cuál lleva demasiado y a quién hay que ir a cobrar.
 *
 * Las cifras vienen enteras del servidor (`summary` de `GET /tables/status`).
 * `average_open` puede ser `null` y eso NO es `$ 0`: el promedio de cero mesas
 * ocupadas es «no hay promedio», y escribir cero ahí sería inventar un dato.
 */
export interface SalonResumenProps {
  tablesTotal: number;
  tablesOccupied: number;
  openTotal: number;
  averageOpen: number | null;
  oldestTable: string | null;
  oldestLabel: string | null;
  askedForBill: number;
  className?: string;
}

function Cinta({ rotulo, children }: { rotulo: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3.5 py-2.5">
      <span className="block text-xs text-muted-foreground">{rotulo}</span>
      <b className="block text-lg leading-tight tabular-nums">{children}</b>
    </div>
  );
}

export function SalonResumen({
  tablesTotal,
  tablesOccupied,
  openTotal,
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
      <Cinta rotulo="Abierto en mesas">{formatCOP(openTotal)}</Cinta>
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
