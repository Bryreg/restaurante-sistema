import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CircleCheck,
  Clock,
  DoorOpen,
  Ellipsis,
  LogOut,
  Moon,
  ShieldCheck,
  Sun,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { useDensity } from "@/app/density";
import { destinoSeguro, inicioParaPuesto, puedeManejarCaja, PUESTO_LABEL } from "@/app/puesto";
import { useSalonTheme } from "@/app/theme";
import { useSession } from "@/app/session";
import { getAttendanceToday, markAttendanceExit, type AttendanceEntryOut } from "@/api/attendance";
import { deviceDeactivate, deviceIdentify, deviceRelease, type EmployeeBrief } from "@/api/auth";
import { listDeviceEmployees, type DeviceEmployee, type EmployeeRole } from "@/api/employees";
import { EmptyState } from "@/components/EmptyState";
import { PinPad } from "@/components/PinPad";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentShift } from "@/features/shifts/hooks";
import { formatClockTime } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<EmployeeRole, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
  accountant: "Contador (sólo lectura)",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

/** «Sáb 27 sep», en hora de Bogotá (UTC-5 todo el año, como `formatClockTime`). */
function fechaCorta(now: Date): string {
  const bogota = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  return `${DIAS_CORTOS[bogota.getUTCDay()]} ${bogota.getUTCDate()} ${MESES_CORTOS[bogota.getUTCMonth()]}`;
}

/** La hora de la cabecera: se mueve sola, sin pedir nada al servidor. */
function useAhora(): Date {
  const [ahora, setAhora] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setAhora(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  return ahora;
}

/**
 * El nombre de la pantalla a la que se sigue, para «Ir a …». Sólo palabras:
 * la ruta la decide `inicioParaPuesto` (o `?next=`), nunca esta función.
 */
function nombreDestino(ruta: string, puesto: string | null | undefined, turnoAbierto: boolean | null): string {
  const path = ruta.split("?")[0] ?? ruta;
  if (path === "/pos/turno") return turnoAbierto === false ? "Apertura de caja" : "Turno";
  if (path === "/pos/mesas") return "Mesas";
  if (path.startsWith("/pos/comanda")) return "Comanda";
  if (path === "/pos/mostrador") return "Mostrador";
  if (path === "/pos/conteo") {
    if (puesto === "bar") return "Conteo de bar";
    if (puesto === "cocina") return "Conteo de cocina";
    return "Conteo";
  }
  if (path === "/pos/kds" || path === "/pos/cocina") return "Cocina";
  if (path === "/pos/autorizar") return "Modo autorización";
  return "tu pantalla";
}

/** «9:14 p. m.» sin que el renglón se corte entre «p.» y «m.». */
function horaSinCorte(iso: string | null | undefined): string {
  return formatClockTime(iso).replace(/ /g, " ");
}

/** El puesto o, si no tiene, el rol: lo que se lee bajo el nombre. */
function subtitulo(employee: DeviceEmployee, entrada: AttendanceEntryOut | undefined): string {
  const puesto = entrada?.puesto;
  if (puesto && puesto in PUESTO_LABEL) return PUESTO_LABEL[puesto as keyof typeof PUESTO_LABEL];
  return ROLE_LABEL[employee.role] ?? employee.role;
}

/**
 * El estado del día bajo el nombre: «Entrada 6:48 a. m.» (verde, con ícono)
 * o «Sin entrada hoy». Sale de `GET /attendance/today`; si esa consulta no
 * respondió no se dice nada — no saber no es «sin entrada».
 */
function EstadoDelDia({
  employee,
  entrada,
  sabido,
  enTinta = false,
}: {
  employee: DeviceEmployee;
  entrada: AttendanceEntryOut | undefined;
  sabido: boolean;
  /** La tarjeta elegida va en tinta: el gris pasa a la letra al 72 %. */
  enTinta?: boolean;
}): React.JSX.Element | null {
  if (!sabido) return null;
  const clase = cn(
    "inline-flex items-center gap-[5px] text-[13px] font-semibold",
    enTinta && "[&.text-muted-foreground]:text-current [&.text-muted-foreground]:opacity-[.72]",
  );
  if (employee.role === "admin") {
    return (
      <span className={cn(clase, "text-muted-foreground")}>
        <ShieldCheck aria-hidden="true" className="size-[15px]" />
        Sólo autoriza
      </span>
    );
  }
  if (entrada?.out_at) {
    return (
      <span className={cn(clase, "text-muted-foreground")}>
        <DoorOpen aria-hidden="true" className="size-[15px]" />
        Salida {horaSinCorte(entrada.out_at)}
      </span>
    );
  }
  if (entrada) {
    return (
      <span className={cn(clase, "text-success")}>
        <CircleCheck aria-hidden="true" className="size-[15px]" />
        Entrada {horaSinCorte(entrada.in_at)}
      </span>
    );
  }
  return (
    <span className={cn(clase, "text-muted-foreground")}>
      <Clock aria-hidden="true" className="size-[15px]" />
      Sin entrada hoy
    </span>
  );
}

interface Listo {
  employee: EmployeeBrief;
  hora: string;
  ruta: string;
  destino: string;
}

/**
 * "Quién opera" (SPEC-NEGOCIO §9.1; CONTRATO-INTERNO-1b-1.md §6, cierra A-9
 * de la entrega de 1a), según el handoff del POS (pantalla 1, 1280 × 800):
 * con la piel «Burbujas» (handoff `design_handoff_pos_burbujas`, vuelta 9a):
 * a la izquierda, la burbuja del equipo en pozos de 88 px (la persona
 * elegida en tinta); a la derecha, una burbuja de 400 px con el nombre
 * elegido, los cuatro puntos y el teclado de 72 px al pie. `POST /auth/device/identify {employee_id, pin}`; el error
 * del servidor («PIN incorrecto · te quedan N intentos», `PIN_LOCKED`) se
 * muestra tal cual llega.
 *
 * **Inicio por rol** (2026-09-25):
 *
 * - Primero la última persona que usó esta tablet (`me.last_employee_id`,
 *   lo guarda el servidor), quienes están adentro del turno (el roster de
 *   `GET /shifts/current`) y quienes marcaron entrada hoy (`GET
 *   /attendance/today`); el resto, detrás de la tarjeta «Otra persona».
 * - En horizontal el teclado va al lado de la grilla; en vertical, debajo.
 * - El primer PIN del día operativo marca la entrada (asistencia): en vez de
 *   saltar de una, el panel lo confirma —check, «Entrada 7:02 a. m.» e «Ir
 *   a {destino del rol}»—. Si la entrada ya estaba marcada, se sigue directo.
 * - «Marcar salida», en el menú «⋯», es elegir el nombre y teclear el PIN.
 * - Después del PIN se vuelve a la pantalla de la que se venía (`?next=`:
 *   la sesión venció o alguien tocó «Cambiar de persona»); si no se venía de
 *   ninguna, `/pos` decide por el puesto de la persona (`PosHome`).
 */
export default function DeviceIdentifyPage(): React.JSX.Element {
  // Ídem `DeviceActivatePage`: vive fuera de `PosLayout` y es el otro
  // teclado de PIN de la tablet.
  useDensity("salon");
  const [pantalla, setPantalla] = useSalonTheme();
  const { me, refresh, clear, hasFeature } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const siguiente = destinoSeguro(searchParams.get("next"));
  const turno = useCurrentShift();
  const personal = useQuery({ queryKey: ["device", "employees"] as const, queryFn: listDeviceEmployees });
  const asistencia = useQuery({ queryKey: ["attendance", "today"], queryFn: getAttendanceToday });
  const ahora = useAhora();

  const [employee, setEmployee] = useState<DeviceEmployee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verOtras, setVerOtras] = useState(false);
  const [listo, setListo] = useState<Listo | null>(null);
  const [confirmarBaja, setConfirmarBaja] = useState(false);
  // «Marcar salida» desde acá: la persona elige su nombre y teclea su PIN,
  // sin identificarse antes (`POST /attendance/out` con PIN).
  const [modoSalida, setModoSalida] = useState(false);

  const entradas = new Map<number, AttendanceEntryOut>();
  for (const entry of asistencia.data ?? []) entradas.set(entry.employee_id, entry);

  const destacados: number[] = [];
  const ultima = me?.last_employee_id;
  if (ultima != null) destacados.push(ultima);
  for (const entry of turno.data?.roster ?? []) {
    if (entry.out_at || entry.employee_id == null) continue;
    if (!destacados.includes(entry.employee_id)) destacados.push(entry.employee_id);
  }
  for (const entry of asistencia.data ?? []) {
    if (entry.out_at) continue;
    if (!destacados.includes(entry.employee_id)) destacados.push(entry.employee_id);
  }

  function elegir(next: DeviceEmployee) {
    setEmployee(next);
    setError(null);
  }

  async function handlePin(pin: string) {
    if (!employee) {
      setError("Elegí quién opera antes del PIN.");
      return;
    }
    setSubmitting(true);
    setError(null);
    if (modoSalida) {
      try {
        const entry = await markAttendanceExit({ employee_id: employee.id, pin });
        toast.success(`Salida ${formatClockTime(entry.out_at)} · ${entry.employee_name}`);
        void asistencia.refetch();
        setModoSalida(false);
        setEmployee(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      const out = await deviceIdentify({ employee_id: employee.id, pin });
      await refresh();
      // El primer PIN del día marca la entrada, haya o no caja abierta: el
      // panel lo confirma antes de seguir. Si ya estaba marcada, directo.
      if (out.attendance?.created) {
        void asistencia.refetch();
        const turnoAbierto = turno.isSuccess ? turno.data !== null : null;
        const conCaja = out.employee.role !== "admin" && puedeManejarCaja(out.employee, null);
        const ruta = siguiente ?? inicioParaPuesto(out.employee, hasFeature, { turnoAbierto: conCaja ? turnoAbierto : null });
        setListo({
          employee: out.employee,
          hora: formatClockTime(out.attendance.in_at),
          ruta,
          destino: nombreDestino(ruta, out.employee.puesto, conCaja ? turnoAbierto : null),
        });
        return;
      }
      navigate(siguiente ?? "/pos", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function noSoyYo() {
    try {
      await deviceRelease();
    } catch (err) {
      toast.error(errorMessage(err));
    }
    await refresh();
    setListo(null);
    setVerOtras(false);
    setEmployee(null);
  }

  async function desactivar() {
    try {
      await deviceDeactivate();
      // El guard `RequireDevice` de `router.tsx` redirige a `/pos/activate`.
      clear();
    } catch (err) {
      toast.error(errorMessage(err));
      setConfirmarBaja(false);
    }
  }

  const storeName = me?.store?.name ?? "";
  const orgName = me?.organization?.name ?? "Restaurante Sistema";
  const hora = formatClockTime(ahora.toISOString());
  // «● Caja abierta · Nombre»: sólo con turno abierto y un responsable real.
  const responsableCaja = turno.data?.cash_responsible?.name ?? null;

  return (
    <div className="flex min-h-dvh flex-col gap-2.5 bg-background p-2.5 text-foreground tabular-nums md:landscape:h-dvh">
      <header className="flex h-[72px] flex-none items-center gap-3 rounded-[22px] bg-card pr-2.5 pl-3">
        <span
          title={orgName}
          aria-hidden="true"
          className="grid size-12 flex-none place-items-center rounded-2xl bg-foreground text-[15px] font-bold text-card"
        >
          {initials(orgName)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-[17px] leading-tight font-semibold">{storeName || orgName}</p>
          <p className="truncate text-[13px] text-muted-foreground">
            {fechaCorta(ahora)} · <span aria-label={`Son las ${hora}`}>{hora}</span>
          </p>
        </div>
        {responsableCaja ? (
          <span className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[20px] bg-success-soft px-3.5 text-[14px] font-semibold whitespace-nowrap text-success">
            <span aria-hidden="true" className="size-[7px] rounded-full bg-success" />
            Caja abierta · {responsableCaja}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Más opciones"
            className="grid size-[52px] shrink-0 place-items-center rounded-2xl bg-muted text-foreground transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Ellipsis aria-hidden="true" className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[320px] rounded-[14px] p-1.5 shadow-[0_12px_32px_rgb(0_0_0/18%)]">
            <DropdownMenuItem className="min-h-[56px] gap-3 px-3.5 text-[17px]" onClick={() => navigate("/login")}>
              <ShieldCheck aria-hidden="true" className="size-[22px]" />
              Entrar como administrador
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-[56px] gap-3 px-3.5 text-[17px]"
              onClick={() => {
                setModoSalida(true);
                setListo(null);
                setError(null);
              }}
            >
              <DoorOpen aria-hidden="true" className="size-[22px]" />
              Marcar salida
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-[56px] gap-3 px-3.5 text-[17px]"
              onClick={() => setPantalla(pantalla === "oscuro" ? "claro" : "oscuro")}
            >
              {pantalla === "oscuro" ? (
                <Sun aria-hidden="true" className="size-[22px]" />
              ) : (
                <Moon aria-hidden="true" className="size-[22px]" />
              )}
              {pantalla === "oscuro" ? "Pantalla clara" : "Pantalla oscura"}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="mx-2 my-1" />
            <DropdownMenuItem
              className="min-h-[56px] gap-3 px-3.5 text-[16px] text-muted-foreground"
              onClick={() => setConfirmarBaja(true)}
            >
              <LogOut aria-hidden="true" className="size-5" />
              Desactivar este dispositivo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="grid flex-1 gap-2.5 md:landscape:min-h-0 md:landscape:grid-cols-[minmax(0,1fr)_400px]">
        <section
          aria-labelledby="quien-opera-titulo"
          className="flex min-h-0 flex-col gap-4 rounded-[26px] bg-card p-[26px] md:landscape:overflow-y-auto"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 id="quien-opera-titulo" className="text-[32px] font-semibold tracking-[-0.025em]">
              {modoSalida ? "Marcar salida" : "¿Quién opera?"}
            </h1>
            <span className="text-[15px] text-muted-foreground">
              {modoSalida ? "Tocá tu nombre y escribí tu PIN" : "Equipo en turno hoy · tocá tu nombre"}
            </span>
            {modoSalida ? (
              <button
                type="button"
                className="ml-auto h-[52px] rounded-2xl bg-muted px-[18px] text-[15px] font-medium transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                  setModoSalida(false);
                  setError(null);
                }}
              >
                Volver a «Quién opera»
              </button>
            ) : null}
          </div>

          <Equipo
            query={personal}
            destacados={destacados}
            verOtras={verOtras}
            setVerOtras={setVerOtras}
            value={employee?.id ?? null}
            onChange={elegir}
            disabled={submitting || listo !== null}
            entradas={entradas}
            asistenciaSabida={asistencia.isSuccess}
          />

          <div className="mt-auto flex flex-col gap-1 pt-2 text-[13px] text-muted-foreground">
            <p>¿No aparecés? Pedile a quien supervisa que te agregue al turno de hoy.</p>
            <p>El primer PIN del día marca tu entrada. Cocina puede mirar tiquetes sin identificarse.</p>
          </div>
        </section>

        <aside
          aria-label={modoSalida ? "PIN para marcar la salida" : "PIN personal"}
          className="flex flex-col gap-[18px] rounded-[26px] bg-card p-[26px]"
        >
          {listo ? (
            <div role="status" className="flex flex-1 flex-col items-center justify-center gap-[14px] text-center">
              <span className="grid size-[64px] place-items-center rounded-[20px] bg-success-soft text-success">
                <Check aria-hidden="true" className="size-8" />
              </span>
              <p className="text-[26px] font-semibold">Entrada {listo.hora}</p>
              <p className="max-w-[320px] text-[15px] text-muted-foreground">
                Hola, {listo.employee.name.split(" ")[0]}. Quedó marcada tu entrada. Seguís a {listo.destino}.
              </p>
              <Button
                type="button"
                className="mt-auto h-[64px] w-full rounded-[20px] text-[17px] font-semibold"
                onClick={() => navigate(siguiente ?? "/pos", { replace: true })}
              >
                Ir a {listo.destino}
                <ArrowRight aria-hidden="true" className="size-[20px]" />
              </Button>
              <button
                type="button"
                className="h-[56px] w-full rounded-[20px] bg-muted text-[15px] font-semibold transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => void noSoyYo()}
              >
                No soy yo
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-1 text-center">
                <span
                  aria-hidden="true"
                  className="grid size-16 place-items-center rounded-[20px] bg-muted text-[20px] font-semibold"
                >
                  {employee ? initials(employee.name) : <UserRound className="size-7 text-muted-foreground" />}
                </span>
                <p className="mt-2 text-[20px] font-semibold">{employee ? employee.name : "Tocá tu nombre"}</p>
                <p className="text-[14px] text-muted-foreground">
                  {employee
                    ? `${subtitulo(employee, entradas.get(employee.id))} · ${modoSalida ? "PIN para marcar la salida" : "Escribí tu PIN de 4 dígitos"}`
                    : "Después escribís tu PIN de 4 dígitos"}
                </p>
              </div>
              {error ? (
                // El mensaje del servidor tal cual llega («PIN incorrecto · te
                // quedan N intentos», `PIN_LOCKED`), en la pastilla del diseño.
                <p
                  role="alert"
                  className="inline-flex min-h-8 items-center gap-1.5 self-center rounded-2xl bg-destructive-soft px-3.5 py-1 text-center text-[13px] font-semibold text-destructive"
                >
                  <span aria-hidden="true" className="size-[7px] shrink-0 rounded-[1px] bg-current" />
                  {error}
                </p>
              ) : null}
              {/* El teclado queda al pie de la burbuja (margin-top auto). */}
              <div className="flex flex-1 flex-col [&>[role=group]]:flex-1 [&>[role=group]>.grid]:mt-auto">
                <PinPad
                  length={4}
                  burbuja="quien"
                  label="PIN personal"
                  onSubmit={handlePin}
                  disabled={submitting || !employee}
                />
              </div>
            </>
          )}
        </aside>
      </div>

      <AlertDialog open={confirmarBaja} onOpenChange={setConfirmarBaja}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desactivar este dispositivo?</AlertDialogTitle>
            <AlertDialogDescription>
              {storeName || "La sede"} deja de estar activada acá y no se puede vender hasta activarlo de nuevo con el
              PIN de sede.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="h-11" onClick={() => void desactivar()}>
              Desactivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * La grilla del equipo: tres columnas de tarjetas de 112 px (dos en una
 * pantalla angosta). Primero los destacados; «Otra persona» (punteada, al
 * final) muestra al resto del personal activo de la sede. Sin destacados se
 * ven todos. `GET /device/employees` nunca trae documento, correo ni
 * límites: el tipo `DeviceEmployee` no los tiene.
 */
function Equipo({
  query,
  destacados,
  verOtras,
  setVerOtras,
  value,
  onChange,
  disabled,
  entradas,
  asistenciaSabida,
}: {
  query: UseQueryResult<DeviceEmployee[]>;
  destacados: number[];
  verOtras: boolean;
  setVerOtras: (next: boolean) => void;
  value: number | null;
  onChange: (employee: DeviceEmployee) => void;
  disabled: boolean;
  entradas: Map<number, AttendanceEntryOut>;
  asistenciaSabida: boolean;
}): React.JSX.Element {
  const grilla = "grid grid-cols-2 content-start gap-2.5 sm:grid-cols-3";
  if (query.isLoading) {
    return (
      <div aria-label="Quién opera" aria-busy="true" className={grilla}>
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-[88px] w-full rounded-[20px]" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar el personal"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }
  const employees = query.data ?? [];
  if (employees.length === 0) return <EmptyState title="No hay nadie disponible para elegir" />;

  const primeros = destacados
    .map((id) => employees.find((employee) => employee.id === id))
    .filter((employee): employee is DeviceEmployee => employee !== undefined);
  const idsPrimeros = new Set(primeros.map((employee) => employee.id));
  const resto = employees.filter((employee) => !idsPrimeros.has(employee.id));
  const conDestacados = primeros.length > 0;
  // Si la persona elegida está en «el resto», el resto se ve: nunca se
  // esconde lo que está marcado.
  const mostrarResto = !conDestacados || verOtras || resto.some((employee) => employee.id === value);
  const visibles = conDestacados ? (mostrarResto ? [...primeros, ...resto] : primeros) : employees;

  return (
    <div role="radiogroup" aria-label="Quién opera" className={grilla}>
      {visibles.map((employee) => {
        const checked = value === employee.id;
        const entrada = entradas.get(employee.id);
        const sub = subtitulo(employee, entrada);
        return (
          <button
            key={employee.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={`${employee.name}, ${sub}`}
            disabled={disabled}
            onClick={() => onChange(employee)}
            className={cn(
              "flex min-h-[88px] items-center gap-[14px] rounded-[20px] px-4 py-[14px] text-left transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
              // La elegida va en tinta; las demás, en pozo.
              checked ? "bg-foreground text-card" : "bg-muted text-foreground hover:bg-fill-strong",
              disabled && !checked && "opacity-60",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-[52px] shrink-0 place-items-center rounded-2xl text-[16px] font-semibold",
                checked ? "bg-[color-mix(in_oklab,var(--card)_18%,transparent)]" : "bg-card",
              )}
            >
              {initials(employee.name)}
            </span>
            <span className="flex min-w-0 flex-col gap-[3px]">
              {/* El nombre completo, en varias líneas si hace falta: dos «Ana M…»
                  iguales no se distinguen. */}
              <span className="text-[17px] leading-[1.15] font-semibold break-words">{employee.name}</span>
              <span className="text-[13px] opacity-[.72]">{sub}</span>
              <EstadoDelDia employee={employee} entrada={entrada} sabido={asistenciaSabida} enTinta={checked} />
            </span>
          </button>
        );
      })}
      {conDestacados && resto.length > 0 ? (
        <button
          type="button"
          aria-label="Otra persona"
          aria-expanded={mostrarResto}
          disabled={disabled}
          onClick={() => setVerOtras(!verOtras)}
          className="flex min-h-[88px] items-center gap-[14px] rounded-[20px] border-2 border-dashed border-input bg-transparent px-4 py-[14px] text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className="grid size-[52px] shrink-0 place-items-center rounded-2xl border-2 border-dashed border-input"
          >
            <UserPlus className="size-6" />
          </span>
          <span className="flex flex-col gap-[3px]">
            <span className="text-[17px] font-semibold">Otra persona</span>
            <span className="text-[13px] text-muted-foreground">
              {mostrarResto ? "Tocá para ver sólo el turno" : "No está en el turno de hoy"}
            </span>
          </span>
        </button>
      ) : null}
    </div>
  );
}
