/**
 * Componentes locales de esta feature, con la MISMA forma de props que el
 * Maestro pidió para los compartidos que todavía no existen
 * (`src/components/DateRangeFilter.tsx` con `{from, to, onChange}` y
 * `src/components/CsvExportButton.tsx` con `{href, label?}`): comprobado con
 * `ls` al escribir esto y otra vez al cerrar el entregable, siguen sin
 * existir (declarado en `gaps`, "nunca crees un archivo del territorio de
 * otro"). El día que el dueño de `src/components/**` los publique, cambiar
 * el import de estos dos componentes por los compartidos es un cambio de
 * una línea en cada pantalla — la forma ya coincide a propósito.
 */
import { Download } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface DateRange {
  from: string;
  to: string;
}

export interface DateRangeFilterProps {
  from: string;
  to: string;
  onChange: (range: DateRange) => void;
}

export function LocalDateRangeFilter({ from, to, onChange }: DateRangeFilterProps): React.JSX.Element {
  const fromId = useId();
  const toId = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor={fromId}>Desde</Label>
        <Input
          id={fromId}
          type="date"
          className="h-10"
          value={from}
          onChange={(event) => onChange({ from: event.target.value, to })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={toId}>Hasta</Label>
        <Input
          id={toId}
          type="date"
          className="h-10"
          value={to}
          onChange={(event) => onChange({ from, to: event.target.value })}
        />
      </div>
    </div>
  );
}

export interface CsvExportButtonProps {
  href: string;
  label?: string;
}

export function LocalCsvExportButton({ href, label = "Exportar CSV" }: CsvExportButtonProps): React.JSX.Element {
  return (
    <Button
      render={<a href={href} target="_blank" rel="noreferrer" />}
      variant="outline"
      className="h-11 gap-2"
    >
      <Download className="size-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
