import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CircleCheck,
  Clock,
  DoorOpen,
  Ellipsis,
  Info,
  LogOut,
  Moon,
  ShieldCheck,
  Sun,
  UserPlus,
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

const DIAS_LARGOS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;
const MESES_LARGOS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/** «Sábado 27 de septiembre», en hora de Bogotá (UTC-5 todo el año, como `formatClockTime`). */
function fechaLarga(now: Date): string {
  const bogota = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  return `${DIAS_LARGOS[bogota.getUTCDay()]} ${bogota.getUTCDate()} de ${MESES_LARGOS[bogota.getUTCMonth()]}`;
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
}: {
  employee: DeviceEmployee;
  entrada: AttendanceEntryOut | undefined;
  sabido: boolean;
}): React.JSX.Element | null {
  if (!sabido) return null;
  const clase = "inline-flex items-center gap-[5px] text-[14px] font-semibold";
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
 * a la izquierda la grilla del equipo en tarjetas de 112 px; a la derecha,
 * un panel de 440 px con el nombre elegido, los cuatro puntos y el teclado
 * de PIN grande. `POST /auth/device/identify {employee_id, pin}`; el error
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

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground tabular-nums md:landscape:h-dvh">
      <header className="flex items-center gap-4 border-b px-5 py-[14px]">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-[20px] font-extrabold [font-stretch:108%]">
            {me?.organization?.name ?? "Restaurante Sistema"}
          </p>
          <p className="truncate text-[15px] text-muted-foreground">
            {storeName ? `${storeName} · ` : ""}
            {fechaLarga(ahora)}
          </p>
        </div>
        <p className="text-[22px] font-bold" aria-label={`Son las ${formatClockTime(ahora.toISOString())}`}>
          {formatClockTime(ahora.toISOString())}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Más opciones"
            className="grid size-[56px] place-items-center rounded-[12px] border bg-card text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Ellipsis aria-hidden="true" className="size-6" />
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

      <div className="grid flex-1 md:landscape:min-h-0 md:landscape:grid-cols-[minmax(0,1fr)_440px]">
        <section
          aria-labelledby="quien-opera-titulo"
          className="flex min-h-0 flex-col gap-4 py-6 pr-6 pl-7 md:landscape:overflow-y-auto"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 id="quien-opera-titulo" className="text-[30px] font-extrabold tracking-[-0.01em] [font-stretch:108%]">
              {modoSalida ? "Marcar salida" : "¿Quién opera?"}
            </h1>
            <span className="text-[16px] text-muted-foreground">
              {modoSalida ? "Tocá tu nombre y tecleá tu PIN" : "Equipo en turno hoy · tocá tu nombre"}
            </span>
            {modoSalida ? (
              <Button
                type="button"
                variant="outline"
                className="ml-auto h-[56px] rounded-[12px] px-4 text-[16px]"
                onClick={() => {
                  setModoSalida(false);
                  setError(null);
                }}
              >
                Volver a «Quién opera»
              </Button>
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

          <p className="mt-auto flex items-center gap-2 pt-4 text-[15px] text-muted-foreground">
            <Info aria-hidden="true" className="size-[18px] shrink-0" />
            El primer PIN del día marca tu entrada. Cocina puede mirar tiquetes sin identificarse.
          </p>
        </section>

        <aside
          aria-label={modoSalida ? "PIN para marcar la salida" : "PIN personal"}
          className="flex flex-col items-center gap-4 border-t bg-card px-7 py-6 md:landscape:border-t-0 md:landscape:border-l"
        >
          {listo ? (
            <div role="status" className="flex flex-1 flex-col items-center justify-center gap-[14px] text-center">
              <span className="grid size-[80px] place-items-center rounded-full bg-success text-success-foreground">
                <Check aria-hidden="true" className="size-10" />
              </span>
              <p className="text-[28px] font-extrabold">Entrada {listo.hora}</p>
              <p className="max-w-[320px] text-[17px] text-muted-foreground">
                Hola, {listo.employee.name.split(" ")[0]}. Quedó marcada tu entrada. Seguís a {listo.destino}.
              </p>
              <Button
                type="button"
                className="mt-3 h-[64px] w-full rounded-[12px] text-[19px] font-bold"
                onClick={() => navigate(siguiente ?? "/pos", { replace: true })}
              >
                Ir a {listo.destino}
                <ArrowRight aria-hidden="true" className="size-[22px]" />
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-[56px] w-full rounded-[12px] bg-transparent text-[17px] font-semibold"
                onClick={() => void noSoyYo()}
              >
                No soy yo
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-1 text-center">
                <p className="text-[24px] font-extrabold">{employee ? employee.name : "Tocá tu nombre"}</p>
                <p className="text-[16px] text-muted-foreground">
                  {employee
                    ? `${subtitulo(employee, entradas.get(employee.id))} · ${modoSalida ? "PIN para marcar la salida" : "PIN de 4 dígitos"}`
                    : "Después tecleás tu PIN de 4 dígitos"}
                </p>
              </div>
              <PinPad
                length={4}
                size="grande"
                label="PIN personal"
                onSubmit={handlePin}
                disabled={submitting || !employee}
                errorMessage={error}
              />
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
  const grilla = "grid grid-cols-2 gap-3 sm:grid-cols-3";
  if (query.isLoading) {
    return (
      <div aria-label="Quién opera" aria-busy="true" className={grilla}>
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-[112px] w-full rounded-[14px]" />
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
              "flex min-h-[112px] items-center gap-[14px] rounded-[14px] px-4 py-[14px] text-left transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
              checked ? "border-[3px] border-primary bg-accent" : "border bg-card hover:bg-muted",
              disabled && !checked && "opacity-60",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-[60px] shrink-0 place-items-center rounded-full text-[22px] font-extrabold",
                checked ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
              )}
            >
              {initials(employee.name)}
            </span>
            <span className="flex min-w-0 flex-col gap-[3px]">
              {/* El nombre completo, en varias líneas si hace falta: dos «Ana M…»
                  iguales no se distinguen. */}
              <span className="text-[19px] leading-[1.15] font-bold break-words">{employee.name}</span>
              <span className="text-[15px] text-muted-foreground">{sub}</span>
              <EstadoDelDia employee={employee} entrada={entrada} sabido={asistenciaSabida} />
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
          className="flex min-h-[112px] items-center gap-[14px] rounded-[14px] border-2 border-dashed border-input bg-transparent px-4 py-[14px] text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className="grid size-[60px] shrink-0 place-items-center rounded-full border-2 border-dashed border-input"
          >
            <UserPlus className="size-6" />
          </span>
          <span className="flex flex-col gap-[3px]">
            <span className="text-[19px] font-bold">Otra persona</span>
            <span className="text-[15px] text-muted-foreground">
              {mostrarResto ? "Tocá para ver sólo el turno" : "No está en el turno de hoy"}
            </span>
          </span>
        </button>
      ) : null}
    </div>
  );
}
