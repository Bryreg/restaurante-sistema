import type { ShiftCurrent } from "@/api/shifts";

/**
 * «Equipo en turno», al lado del estado en `ShiftPage`: quién está adentro
 * ahora y quién ya salió, leído del roster que manda `GET /shifts/current`.
 * Es sólo lectura; marcar entrada, salida o pausa se hace con el PIN propio
 * en `RosterPanel`, que la página abre desde «Entrada / Salida».
 */
export function ShiftTeamCard({ shift }: { shift: ShiftCurrent }): React.JSX.Element {
  const roster = shift.roster ?? [];
  const adentro = roster.filter((r) => !r.out_at);
  const salieron = roster.filter((r) => r.out_at);

  return (
    <section aria-labelledby="equipo-turno" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id="equipo-turno" className="text-lg font-semibold">
        Equipo en turno
      </h2>
      {adentro.length === 0 ? (
        <p className="text-muted-foreground">Todavía no hay nadie adentro.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {adentro.map((r, i) => (
            <li
              key={`${r.employee_id ?? "?"}-${i}`}
              className="rounded-full bg-accent px-3 py-1.5 font-medium text-accent-foreground"
            >
              {r.employee_name ?? "—"}
            </li>
          ))}
        </ul>
      )}
      {salieron.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Ya salieron: {salieron.map((r) => r.employee_name ?? "—").join(", ")}
        </p>
      ) : null}
    </section>
  );
}
