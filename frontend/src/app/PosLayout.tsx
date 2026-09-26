import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, LayoutGrid, LogOut, Moon, MoreHorizontal, ShieldCheck, Sun, UserMinus, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { getAttendanceToday, markAttendanceExit } from "@/api/attendance";
import { deviceDeactivate, deviceRelease } from "@/api/auth";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { inventoryFeature } from "@/features/inventory";
import { kitchenFeature } from "@/features/kitchen";
import { ordersFeature } from "@/features/orders";
import { recipesFeature } from "@/features/recipes";
import { shiftsFeature } from "@/features/shifts";
import { formatClockTime } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

import type { NavItem } from "./nav";
import { useDensity } from "./density";
import { barraDelSalon, cuantasCaben, RUTA_AUTORIZAR, rutaIdentificarse, soloAutoriza } from "./puesto";
import { type SalonTheme, useSalonTheme } from "./theme";
import { useSession } from "./session";

/**
 * La barra del salón la decide **quién se identificó**, no la tablet
 * (`docs/diseno/propuesta.html` § navegación: «cinco destinos como máximo,
 * según el rol»). Las reglas viven en `barraDelSalon` (`./puesto`, funciones
 * puras con sus tests):
 *
 * - Sin persona identificada no hay entradas de operación (`[]`).
 * - Una función apagada (`feature`) no deja hueco: la entrada no está.
 * - **Inicio por rol**: con `puesto` (caja, salón, cocina, bar) la persona ve
 *   sólo los destinos de su puesto; sin puesto, o supervisor / admin, todo.
 *   Turno lo ve todo el que se identifica: ahí marca su entrada y salida.
 *
 * Orden sin puesto: venta (Mesas, Mostrador) → caja (Turno) → cocina
 * (Cocina, Tiquetes de cocina, Producción, Merma). No hay entrada «Cobrar»:
 * el cobro vive en `/pos/cobro/:orderId` y se llega desde la comanda.
 *
 * **Lo que no cabe va a «Más»** (tablet vertical): antes la barra se
 * desplazaba de costado sin ninguna pista y las últimas entradas quedaban
 * escondidas. Se miden los botones en una fila invisible y se muestran los
 * que caben; el resto, en el menú «Más», que nombra la pantalla activa si
 * está adentro.
 */
const NAV_ITEM_CLASS =
  // `min-h-14`: objetivo táctil de 56 px o más en el salón
  // (propuesta § Sistema de diseño), no los 44 px del libro.
  "flex min-h-14 shrink-0 items-center gap-2 rounded-md px-4 text-base font-medium whitespace-nowrap transition-colors";

function PosNavBar({ items }: { items: NavItem[] }): React.JSX.Element | null {
  const navRef = useRef<HTMLElement>(null);
  const medidasRef = useRef<HTMLDivElement>(null);
  const [caben, setCaben] = useState(items.length);
  const location = useLocation();
  const navigate = useNavigate();
  const firma = items.map((item) => `${item.to}|${item.label}`).join("\n");

  useLayoutEffect(() => {
    const nav = navRef.current;
    const medidas = medidasRef.current;
    if (!nav || !medidas) return;
    const total = medidas.children.length - 1;
    const medir = () => {
      const hijos = Array.from(medidas.children) as HTMLElement[];
      const anchos = hijos.slice(0, total).map((hijo) => hijo.offsetWidth);
      const mas = hijos[total]?.offsetWidth ?? 0;
      const estilo = window.getComputedStyle(nav);
      const disponible =
        nav.clientWidth - (parseFloat(estilo.paddingLeft) || 0) - (parseFloat(estilo.paddingRight) || 0);
      setCaben(cuantasCaben(anchos, disponible, mas));
    };
    medir();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(medir);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [firma]);

  if (items.length === 0) return null;

  const visibles = items.slice(0, caben);
  const enMas = items.slice(caben);
  const rutaActual = `${location.pathname}${location.search}`;
  const activaEnMas = enMas.find(
    (item) => rutaActual === item.to || location.pathname === item.to.split("?")[0],
  );

  return (
    <nav
      ref={navRef}
      aria-label="Secciones del salón"
      className="relative flex gap-2 overflow-x-auto border-b bg-background px-3 py-2"
    >
      {visibles.map((item) => {
        const Icon = item.icon ?? LayoutGrid;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                NAV_ITEM_CLASS,
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className="size-5" aria-hidden="true" />
            {item.label}
          </NavLink>
        );
      })}
      {enMas.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              NAV_ITEM_CLASS,
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activaEnMas
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <MoreHorizontal className="size-5" aria-hidden="true" />
            {activaEnMas ? `Más: ${activaEnMas.label}` : "Más"}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-52">
            {enMas.map((item) => {
              const Icon = item.icon ?? LayoutGrid;
              return (
                <DropdownMenuItem key={item.to} className="min-h-12 gap-2 text-base" onClick={() => navigate(item.to)}>
                  <Icon className="size-5" aria-hidden="true" />
                  {item.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* La fila invisible con la que se mide cuánto cabe: no es navegable
          ni la lee un lector de pantalla. */}
      <div
        ref={medidasRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 flex h-0 gap-2 overflow-hidden"
      >
        {items.map((item) => (
          <span key={item.to} className={NAV_ITEM_CLASS}>
            <span className="size-5" />
            {item.label}
          </span>
        ))}
        <span className={NAV_ITEM_CLASS}>
          <span className="size-5" />
          Más: Tiquetes de cocina
        </span>
      </div>
    </nav>
  );
}

/**
 * El menú «⋯» del salón: lo que no es de todos los días va acá y no en la
 * barra, para que la barra quede para operar.
 *
 * - **Marcar salida** (si la persona tiene entrada abierta hoy): un toque.
 *   Cierra la asistencia del día (y su lugar en el roster del turno), suelta
 *   a la persona y vuelve a «Quién opera».
 * - **Marcar salida de otra persona** (sólo supervisor): la de quien se fue
 *   sin marcar. El backend lo hace cumplir (`EXIT_REQUIRES_SUPERVISOR`).
 * - **Entrar como administrador**: abre el admin en esta tablet con una
 *   sesión corta (15 min) que, al salir, vuelve a «Quién opera».
 * - **Pantalla oscura / clara**: por tablet (no en la cocina, que es fija).
 * - **Desactivar este dispositivo**: detrás de una confirmación. En una
 *   tablet compartida, tocarlo por error deja al salón sin poder vender hasta
 *   que aparezca alguien con el PIN de sede. El backend no pide PIN para
 *   desactivar y la interfaz **no inventa un gate que el servidor no hace
 *   cumplir** (AGENTS.md): la confirmación explica la consecuencia, no
 *   autoriza.
 */
function PosMenu({
  storeName,
  enCocina,
  identificarse,
  pantalla,
  setPantalla,
}: {
  storeName: string;
  enCocina: boolean;
  identificarse: string;
  pantalla: SalonTheme;
  setPantalla: (tema: SalonTheme) => void;
}): React.JSX.Element {
  const { me, clear, refresh } = useSession();
  const navigate = useNavigate();
  const [confirmar, setConfirmar] = useState(false);
  const [otraSalida, setOtraSalida] = useState(false);
  const [saliendo, setSaliendo] = useState(false);

  const persona = me?.employee ?? null;
  const tieneEntrada = Boolean(persona && me?.employee_attendance);
  const esSupervisor = persona?.role === "supervisor";

  async function handleDeactivate() {
    setSaliendo(true);
    try {
      await deviceDeactivate();
      // El guard `RequireDevice` de `router.tsx` redirige a `/pos/activate`.
      clear();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaliendo(false);
      setConfirmar(false);
    }
  }

  async function handleMarcarSalida() {
    try {
      const entry = await markAttendanceExit();
      toast.success(`Salida ${formatClockTime(entry.out_at)}`);
      await deviceRelease();
      await refresh();
      navigate(identificarse);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Más opciones"
          className="inline-flex h-11 min-w-11 items-center justify-center rounded-md px-3 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <MoreHorizontal className="size-5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-64">
          {tieneEntrada ? (
            <DropdownMenuItem className="min-h-12 gap-2 text-base" onClick={() => void handleMarcarSalida()}>
              <DoorOpen className="size-5" aria-hidden="true" />
              Marcar salida
            </DropdownMenuItem>
          ) : null}
          {esSupervisor ? (
            <DropdownMenuItem className="min-h-12 gap-2 text-base" onClick={() => setOtraSalida(true)}>
              <UserMinus className="size-5" aria-hidden="true" />
              Marcar salida de otra persona
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className="min-h-12 gap-2 text-base" onClick={() => navigate("/login")}>
            <ShieldCheck className="size-5" aria-hidden="true" />
            Entrar como administrador
          </DropdownMenuItem>
          {enCocina ? null : (
            <DropdownMenuItem
              className="min-h-12 gap-2 text-base"
              onClick={() => setPantalla(pantalla === "oscuro" ? "claro" : "oscuro")}
            >
              {pantalla === "oscuro" ? (
                <Sun className="size-5" aria-hidden="true" />
              ) : (
                <Moon className="size-5" aria-hidden="true" />
              )}
              {pantalla === "oscuro" ? "Pantalla clara" : "Pantalla oscura"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="min-h-12 gap-2 text-base" onClick={() => setConfirmar(true)}>
            <LogOut className="size-5" aria-hidden="true" />
            Desactivar este dispositivo
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmar} onOpenChange={setConfirmar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desactivar este dispositivo?</AlertDialogTitle>
            <AlertDialogDescription>
              {storeName} deja de estar activada acá y no se puede vender hasta activarlo de nuevo
              con el PIN de sede. Si sólo querés que atienda otra persona, usá «Cambiar de persona».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* `h-11`: es una tablet, y el botón de confirmar no puede ser
                más chico que el dedo que lo toca. */}
            <AlertDialogCancel className="h-11" disabled={saliendo}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-11"
              disabled={saliendo}
              onClick={() => void handleDeactivate()}
            >
              Desactivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {esSupervisor ? <OtraSalidaDialog open={otraSalida} onOpenChange={setOtraSalida} /> : null}
    </>
  );
}

/**
 * El supervisor marca la salida de quien se fue sin marcarla: la lista es la
 * asistencia abierta de hoy (`GET /attendance/today`), sin plata ni costos.
 */
function OtraSalidaDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const hoy = useQuery({ queryKey: ["attendance", "today"], queryFn: getAttendanceToday, enabled: open });
  const salida = useMutation({
    mutationFn: (employeeId: number) => markAttendanceExit({ employee_id: employeeId }),
    onSuccess: (entry) => {
      toast.success(`Salida de ${entry.employee_name}: ${formatClockTime(entry.out_at)}`);
      void queryClient.invalidateQueries({ queryKey: ["attendance", "today"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const abiertas = (hoy.data ?? []).filter((e) => e.status === "open");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Marcar salida de otra persona</AlertDialogTitle>
          <AlertDialogDescription>
            Para quien se fue sin marcar. Queda a tu nombre, con la hora de ahora.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {hoy.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : abiertas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nadie tiene la entrada abierta hoy.</p>
        ) : (
          <ul className="space-y-2">
            {abiertas.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3">
                <span className="text-base">
                  {entry.employee_name}{" "}
                  <span className="text-sm text-muted-foreground">· entró {formatClockTime(entry.in_at)}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={salida.isPending}
                  onClick={() => salida.mutate(entry.employee_id)}
                >
                  Marcar salida
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11">Cerrar</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const POLL_MS = 5_000;

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
};

/**
 * Barra superior del salón: persona activa, "Cambiar de persona",
 * "Desactivar este dispositivo" y el aviso
 * de expiración por inactividad; sondea `GET /auth/me` cada 5 s
 * (SPEC-NEGOCIO § 9.1). El día operativo y el estado del turno los pinta
 * `<shiftsFeature.ShiftStatusStrip/>` — ese dato vive en `GET
 * /shifts/current`, fuera del contrato que este agente puede consumir.
 */
export default function PosLayout(): React.JSX.Element | null {
  // Tablet del salón: cuerpo 17 px y objetivo táctil de 52 px (m2b `.salon`).
  useDensity("salon");
  // El tema de la tablet se aplica acá; el botón para cambiarlo vive en «⋯».
  const [pantalla, setPantalla] = useSalonTheme();
  // En la cocina la pizarra es fija (`useCocinaPantalla`): ahí el botón no
  // cambiaría nada visible, así que no se ofrece.
  const location = useLocation();
  const { pathname } = location;
  const enCocina = /^\/pos\/(kds|cocina)\b/.test(pathname);
  // El KDS es una pantalla de ESTACIÓN: mirarlo no exige persona (manos
  // sucias, guantes). Se pide el PIN sólo al marcar algo (`KdsPage`).
  const enKds = /^\/pos\/kds\b/.test(pathname);
  // Para volver acá después del PIN (sesión vencida o «Cambiar de persona»).
  const identificarse = rutaIdentificarse(`${location.pathname}${location.search}`);
  const { me, refresh, hasFeature } = useSession();
  const navigate = useNavigate();
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!me || me.kind !== "device") {
    // El router ya exige `kind === "device"` para llegar acá; esto es sólo
    // una guarda defensiva mientras se resuelve la primera carga de sesión.
    return null;
  }

  if (!me.employee && !enKds) {
    return <Navigate to={identificarse} replace />;
  }

  // El administrador en la tablet sólo autoriza: no opera ninguna pantalla
  // del salón, llega (y vuelve) a «Modo autorización».
  if (soloAutoriza(me.employee) && pathname !== RUTA_AUTORIZAR) {
    return <Navigate to={RUTA_AUTORIZAR} replace />;
  }

  const expired = me.employee_expires_at
    ? new Date(me.employee_expires_at).getTime() <= Date.now()
    : false;

  async function handleChangePerson() {
    setReleasing(true);
    try {
      await deviceRelease();
      await refresh();
      navigate(identificarse);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setReleasing(false);
    }
  }

  return (
    <div className="salon flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{me.store?.name ?? "Sede"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {me.employee
                ? `${me.employee.name} · ${ROLE_LABEL[me.employee.role] ?? me.employee.role}`
                : "Pantalla de cocina · nadie identificado"}
            </p>
          </div>
          {expired ? (
            <span
              role="alert"
              className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
            >
              Tu sesión de persona venció por inactividad. Identificate de nuevo.
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-2"
            onClick={handleChangePerson}
            disabled={releasing}
          >
            <Users className="size-4" aria-hidden="true" />
            Cambiar de persona
          </Button>
          <PosMenu storeName={me.store?.name ?? "Esta sede"} enCocina={enCocina}
            identificarse={identificarse}
            pantalla={pantalla}
            setPantalla={setPantalla}
          />
        </div>
      </header>
      <div className="border-b bg-muted/30 px-3 py-2">
        <shiftsFeature.ShiftStatusStrip />
      </div>
      <PosNavBar
        items={barraDelSalon(
          [
            ...ordersFeature.posNav,
            ...shiftsFeature.posNav,
            ...kitchenFeature.posNav,
            ...recipesFeature.posNav,
            ...inventoryFeature.posNav,
          ],
          hasFeature,
          me.employee,
        )}
      />
      <main className="flex-1 p-3">
        <Outlet />
      </main>
    </div>
  );
}
