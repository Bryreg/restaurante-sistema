import { CircleCheck, Coins, Lock } from "lucide-react";

import type { Breakdown } from "@/api/shifts";
import { Button } from "@/components/ui/button";
import { formatCOP } from "@/lib/money";
import { cn } from "cn";

/**
 * Piezas visuales compartidas por los **dos** formularios de cierre
 * (`CloseWizard` con `cash.blind_close` encendida, `SingleStepCloseForm` con
 * la función apagada). Viven acá y no adentro de uno de los dos porque el
 * riesgo declarado en `docs/INVENTARIO-CONTROLES.md` §10.b es justamente ese:
 * rediseñar uno y dejar al otro con la pantalla vieja.
 *
 * Nada de esto calcula: son rótulos, marcos y pastillas. Las cifras llegan
 * ya calculadas del servidor (`AGENTS.md` § «una sola matemática, en el
 * backend»).
 */

/** El número de paso, visible: dónde estoy y qué falta. */
export function PasoPastilla({
  children,
  tono = "quieto",
  className,
}: {
  children: React.ReactNode;
  tono?: "activo" | "quieto" | "tapado" | "listo";
  className?: string;
}): React.JSX.Element {
  const tonos = {
    activo: "bg-primary text-primary-foreground",
    quieto: "bg-muted text-muted-foreground ring-1 ring-border",
    tapado: "bg-background/10 text-background ring-1 ring-background/25",
    listo: "bg-success/10 text-success ring-1 ring-success/30",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap",
        tonos[tono],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** El papel: cabecera con ícono, título y pastilla de paso; cuerpo debajo. */
export function TarjetaCierre({
  icono,
  titulo,
  pastilla,
  acento,
  children,
  className,
}: {
  icono: React.ReactNode;
  titulo: string;
  pastilla?: React.ReactNode;
  /** Cabecera en verde de estado: el cuadre ya está abierto. */
  acento?: "ok";
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section className={cn("overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10", className)}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 border-b px-4 py-2.5",
          acento === "ok" ? "border-success/25 bg-success/10 text-success" : "bg-muted/60 text-muted-foreground",
        )}
      >
        <span aria-hidden="true" className="flex items-center [&_svg]:size-4">
          {icono}
        </span>
        <h3 className="text-xs font-bold tracking-wider uppercase">{titulo}</h3>
        {pastilla ? <span className="ml-auto">{pastilla}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Los renglones de los que sale el esperado — los mismos rótulos, en el
 * mismo orden, tapados en el paso 1 y con cifra en el paso 2: lo que se
 * destapa es el valor, no la forma.
 *
 * Son **exactamente** los términos que publica el servidor en
 * `review.equation` (`app/shifts/service.py::compute_breakdown`). La propina
 * en efectivo NO es uno de ellos: sale del cajón por `tips_cash_out` y
 * `to_deposit`, y meterla acá haría que todo turno con propina cerrara con
 * una diferencia igual, al peso, a esa propina
 * (`backend/tests/channels/test_expected_cash_parity.py`).
 */
export const RENGLONES_ESPERADO = [
  { clave: "base", rotulo: "Base del turno", detalle: "Con la que se abrió el cajón", signo: "" },
  { clave: "cash_sales", rotulo: "Ventas en efectivo", detalle: "Lo que se cobró en billetes", signo: "+" },
  { clave: "incomes", rotulo: "Ingresos de caja", detalle: "Lo que entró por fuera de la venta", signo: "+" },
  { clave: "expenses", rotulo: "Egresos de caja", detalle: "Lo que se pagó del cajón", signo: "−" },
  { clave: "pickups", rotulo: "Retiros a caja fuerte", detalle: "Los sobres que ya salieron", signo: "−" },
] as const satisfies readonly {
  clave: keyof Breakdown;
  rotulo: string;
  detalle: string;
  signo: string;
}[];

/**
 * El desglose **tapado**: renglón por renglón, con `•••••` en lugar de la
 * cifra. Se ve la forma de lo que está oculto sin ver un solo número.
 *
 * REGLA DURA: son **rótulos estáticos**. Este componente no recibe ninguna
 * cifra, no consulta nada y no se puede alimentar de una revisión — si
 * tuviera valores, el paso 1 dejaría de ser a ciegas. El único pedido que
 * revela el esperado vive en el `useQuery` con `enabled: step === 2` de
 * `CloseWizard`.
 */
export function DesgloseTapado(): React.JSX.Element {
  return (
    <div className="mt-5">
      {RENGLONES_ESPERADO.map(({ clave, rotulo }) => (
        <div
          key={clave}
          className="flex items-baseline gap-3 border-b border-background/10 py-2 text-sm text-background/85"
        >
          <span className="min-w-0">{rotulo}</span>
          <span
            aria-label="Tapado"
            className="ml-auto tracking-[0.2em] text-background/65 select-none"
          >
            •••••
          </span>
        </div>
      ))}
      <div className="mt-1 flex items-baseline gap-3 border-t border-background/30 pt-2.5 text-sm font-bold text-background">
        <span>Esperado en el cajón</span>
        <span aria-label="Tapado" className="ml-auto tracking-[0.2em] text-background/65 select-none">
          •••••
        </span>
      </div>
    </div>
  );
}

/**
 * El candado como protagonista: aro, titular y la razón en lenguaje llano.
 * Panel invertido (`bg-foreground`/`text-background`) — es el único bloque de
 * la pantalla que no se toca ni se llena: se lee.
 */
export function PanelSello({
  titulo,
  icono,
  pastilla,
  titular,
  razon,
  nota,
  children,
  promesa,
}: {
  titulo: string;
  /** El símbolo del panel. Por defecto el candado del conteo a ciegas. */
  icono?: React.ReactNode;
  pastilla: React.ReactNode;
  titular: string;
  razon: React.ReactNode;
  nota?: React.ReactNode;
  /** El botón que confirma: va adentro del panel, debajo de lo tapado. */
  children?: React.ReactNode;
  promesa?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl bg-foreground text-background ring-1 ring-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-background/15 px-4 py-2.5 text-background/70">
        <span aria-hidden="true" className="flex items-center [&_svg]:size-4">
          {icono ?? <Lock />}
        </span>
        <h3 className="text-xs font-bold tracking-wider uppercase">{titulo}</h3>
        <span className="ml-auto">{pastilla}</span>
      </div>
      <div className="px-4 pt-5 pb-4">
        <div className="text-center">
          <span
            aria-hidden="true"
            className="mx-auto mb-3 flex size-16 items-center justify-center rounded-full bg-background/10 ring-1 ring-background/25 [&_svg]:size-8"
          >
            {icono ?? <Lock />}
          </span>
          <h4 className="text-lg leading-snug font-bold">{titular}</h4>
          <p className="mx-auto mt-2 max-w-[42ch] text-sm leading-relaxed text-background/75">{razon}</p>
        </div>

        <DesgloseTapado />

        {nota ? (
          <p className="mt-4 border-l-2 border-background/30 pl-3 text-xs leading-relaxed text-background/65">
            {nota}
          </p>
        ) : null}

        {children ? <div className="mt-4">{children}</div> : null}

        {promesa ? (
          <p className="mt-3 text-center text-xs leading-relaxed text-background/70">{promesa}</p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Un renglón del cuadre ya revelado: rótulo, detalle chico, y la cifra tal
 * como llegó. El signo es el papel del término en la fórmula del servidor
 * (`+` entra al cajón, `−` sale), no una cuenta hecha acá: el valor se pinta
 * sin tocarlo.
 */
export function FilaCuadre({
  rotulo,
  detalle,
  signo,
  valor,
  remate,
  className,
}: {
  rotulo: string;
  detalle?: string;
  signo?: string;
  valor: number | null | undefined;
  remate?: boolean;
  className?: string;
}): React.JSX.Element {
  // El signo dice el papel del término en la fórmula del servidor. En un
  // renglón en cero no aporta nada y «−$ 0» se lee como un error de la
  // pantalla, así que sólo se pinta cuando hay algo que sumar o restar.
  const muestraSigno = valor !== null && valor !== undefined && valor !== 0;
  return (
    <div
      className={cn(
        "flex items-baseline gap-3 border-b py-2 last:border-b-0",
        remate ? "border-b-0 border-t-2 border-t-foreground pt-2.5 font-bold" : null,
        className,
      )}
    >
      <span className="min-w-0">
        <span className={remate ? "text-base" : "text-sm"}>{rotulo}</span>
        {detalle ? <span className="block text-xs text-muted-foreground">{detalle}</span> : null}
      </span>
      <span
        className={cn(
          "ml-auto font-bold whitespace-nowrap tabular-nums",
          remate ? "text-xl" : "text-sm",
        )}
      >
        {signo && muestraSigno ? signo : ""}
        {formatCOP(valor)}
      </span>
    </div>
  );
}

/**
 * Lo que el servidor devuelve cuando el turno queda cerrado, por cualquiera
 * de los dos caminos. `CloseConfirmResult` (asistente) y
 * `SingleStepCloseResult` (un paso) son ambos asignables a esto: el de un
 * paso trae además `expected` y `difference`, porque ahí el cuadre no se
 * reveló antes.
 */
export interface ResultadoCierre {
  to_deposit?: number;
  closes_day?: boolean;
  expected?: number;
  difference?: number;
}

/**
 * La pantalla de «Turno cerrado» — **la dibuja `ShiftPage`, no el
 * formulario**.
 *
 * Por qué vive acá arriba y no adentro de cada formulario: el resultado del
 * cierre sobrevive al turno que lo produjo. En cuanto el cierre entra, la
 * invalidación de `CURRENT_SHIFT_QUERY_KEY` hace que `GET /shifts/current`
 * devuelva `null`, y un formulario montado bajo la condición «hay turno» se
 * desmonta con ella: la cifra **a consignar** —la plata que sale del cajón
 * para el banco— se perdía en el parpadeo sin que nadie alcanzara a leerla.
 * El dueño del dato es la página, que no depende del turno para seguir
 * montada.
 *
 * No se va sola: sólo la borra el botón de continuar. Si la persona recarga
 * se pierde, y está bien — pero no se desvanece sin que nadie la toque.
 */
export function TarjetaTurnoCerrado({
  resultado,
  pastilla,
  etiquetaContinuar,
  onContinuar,
}: {
  resultado: ResultadoCierre;
  /** El texto del paso: el asistente cierra un «3 de 3», el de un paso no. */
  pastilla: React.ReactNode;
  etiquetaContinuar: string;
  onContinuar: () => void;
}): React.JSX.Element {
  // El cierre en un paso revela acá el cuadre (no hubo paso 2 que lo
  // mostrara); el asistente ya lo mostró y sólo remata con lo que se
  // consigna. La cifra a consignar es el remate cuando hay renglones arriba.
  const hayCuadre = resultado.expected !== undefined || resultado.difference !== undefined;
  return (
    <div className="mx-auto w-full max-w-6xl">
      <TarjetaCierre
        icono={<CircleCheck />}
        titulo="Turno cerrado"
        acento="ok"
        pastilla={pastilla}
        className="max-w-xl"
      >
        <div className="px-4 py-4">
          <p className="text-lg font-semibold">Turno cerrado.</p>
          {resultado.expected !== undefined ? (
            <FilaCuadre rotulo="Esperado" detalle="Lo que el sistema calculó para el cajón" valor={resultado.expected} />
          ) : null}
          {resultado.difference !== undefined ? (
            <FilaCuadre
              rotulo="Diferencia"
              detalle="Contado contra esperado, según el servidor"
              valor={resultado.difference}
            />
          ) : null}
          <FilaCuadre
            rotulo="A consignar"
            detalle="Lo que sale del cajón para el banco"
            valor={resultado.to_deposit}
            remate={hayCuadre}
          />
          <p className="pt-2 text-sm text-muted-foreground">
            {resultado.closes_day
              ? "Este cierre también cerró el día operativo."
              : "El día operativo sigue abierto (otro turno lo cierra)."}
          </p>
          <Button type="button" className="mt-4 h-11" onClick={onContinuar}>
            {etiquetaContinuar}
          </Button>
        </div>
      </TarjetaCierre>
    </div>
  );
}


/**
 * **La cabecera del cierre** (`m2b`, pantalla 5). Misma banda que la Comanda,
 * el Cobro y el Comprobante, para que las cuatro pantallas del salón se lean
 * igual: de qué se trata a la izquierda, la cifra que va corriendo a la
 * derecha.
 *
 * **La base del turno NO va acá**, aunque la maqueta la muestre en su panel
 * tapado. Este producto tapa la ecuación entera hasta el paso 2 —incluida la
 * base— y el panel lo dice con todas las letras. Repetirla en la cabecera
 * abriría por arriba justo lo que el sello cierra por abajo: alcanza con ver
 * la base para empezar a estimar el resto.
 */
export function CabeceraCierre({
  turnoId,
  abiertoEn,
  responsable,
  contado,
}: {
  turnoId: number;
  abiertoEn?: string | null;
  responsable?: string | null;
  contado: number;
}): React.JSX.Element {
  const sub = [abiertoEn ? `Abierto ${abiertoEn}` : null, responsable].filter(Boolean);
  return (
    <header className="flex flex-wrap items-start gap-4 rounded-xl border bg-muted px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-xl leading-tight font-semibold">Cerrar el turno {turnoId}</h2>
        {sub.length > 0 ? <p className="mt-0.5 text-sm text-muted-foreground">{sub.join(" · ")}</p> : null}
      </div>
      <div className="ml-auto text-right">
        {/* «Va contado», no «Total»: el conteo sigue abierto y el número va a
            seguir subiendo mientras la persona teclea denominaciones. */}
        <span className="block text-xs text-muted-foreground">Va contado</span>
        <span className="block text-[1.6rem] leading-tight font-bold tabular-nums">{formatCOP(contado)}</span>
      </div>
    </header>
  );
}

/**
 * **«Propinas del turno»** (`m2b`). Dos pasivos de naturaleza distinta: el de
 * efectivo sale del cajón hoy, el electrónico se reparte en nómina. Ninguno
 * es venta y ninguno entra al cuadre — por eso la nota, que es la Ley 1935 de
 * 2018 dicha en una línea.
 *
 * El total lo manda el servidor (`total_liability`). Sumar los dos acá sería
 * decidir, desde la pantalla, que dos pasivos distintos se suman.
 */
export function PropinasDelTurno({
  efectivo,
  electronicas,
  total,
}: {
  efectivo?: number | null;
  electronicas?: number | null;
  total?: number | null;
}): React.JSX.Element {
  return (
    <TarjetaCierre icono={<Coins />} titulo="Propinas del turno">
      <dl className="divide-y text-sm">
        <div className="flex items-start gap-3 px-4 py-2.5">
          <dt className="min-w-0">
            En efectivo
            <small className="block text-xs text-muted-foreground">Sale del cajón, no es venta a consignar</small>
          </dt>
          <dd className="ml-auto font-medium tabular-nums">{formatCOP(efectivo)}</dd>
        </div>
        <div className="flex items-start gap-3 px-4 py-2.5">
          <dt className="min-w-0">
            Electrónicas
            <small className="block text-xs text-muted-foreground">Ya cobradas: quedan por repartir</small>
          </dt>
          <dd className="ml-auto font-medium tabular-nums">{formatCOP(electronicas)}</dd>
        </div>
        <div className="flex items-start gap-3 border-t-2 border-foreground px-4 py-2.5">
          <dt className="font-bold">Total</dt>
          <dd className="ml-auto font-bold tabular-nums">{formatCOP(total)}</dd>
        </div>
      </dl>
      <p className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        La propina <b className="text-foreground">no es venta</b>. Se reparte en nómina y no se mezcla con el
        cuadre.
      </p>
    </TarjetaCierre>
  );
}
