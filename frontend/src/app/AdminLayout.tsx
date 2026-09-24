import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Banknote,
  BookOpen,
  CalendarDays,
  CircleAlert,
  Ellipsis,
  LogOut,
  type LucideIcon,
  Menu,
  Package,
  Receipt,
  Settings,
  Store,
  Users,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { toast } from "sonner";

import { logout } from "@/api/auth";
import { getToday } from "@/api/reports";

import { NotificationBell } from "@/features/notifications/NotificationBell";
import { analyticsFeature } from "@/features/analytics";
import { bankingFeature } from "@/features/banking";
import { catalogFeature } from "@/features/catalog";
import { customersFeature } from "@/features/customers";
import { expensesFeature } from "@/features/expenses";
import { fiscalFeature } from "@/features/fiscal";
import { inventoryFeature } from "@/features/inventory";
import { ordersFeature } from "@/features/orders";
import { payrollFeature } from "@/features/payroll";
import { purchasesFeature } from "@/features/purchases";
import { recipesFeature } from "@/features/recipes";
import { reportsFeature } from "@/features/reports";
import { shiftsFeature } from "@/features/shifts";
import { RailItemContent, railItemClass } from "@/components/admin/RailItem";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

import type { NavItem } from "./nav";
import { useDensity } from "./density";
import { useSession } from "./session";
import { StoreSelectionProvider, useStoreSelection } from "./storeContext";
import { ThemeToggle } from "./theme";

const OWN_NAV: NavItem[] = [
  { to: "/admin/features", label: "Funciones", feature: undefined },
  { to: "/admin/settings", label: "Configuración", feature: undefined },
  { to: "/admin/audit", label: "Historial", feature: undefined },
  { to: "/admin/notifications", label: "Notificaciones", feature: undefined },
];

/**
 * Orden de SPEC-NEGOCIO §9.3: Hoy, Ventas, Pedidos, Carta, Preparaciones e
 * Inventario (pedido 2a) se intercalan junto a Carta, (Dinero, Turnos y
 * personal ya estaban), Documentos fiscales/Rangos/Notas/Devoluciones
 * pendientes y Clientes (pedido 1b-2), **Compras** justo después de
 * Inventario (pedido 2b: "Carta y recetas, Preparaciones, Inventario,
 * Compras, Dinero..." — la fila de la tabla §9.3) — y `OWN_NAV` cierra
 * igual que antes.
 *
 * Fase 3 (`features/fase-3-dinero-control/spec.md` § T5): `bankingFeature`,
 * `expensesFeature` y `payrollFeature`/`analyticsFeature` se agregan justo
 * después de Compras y antes de fiscal/turnos — "Banco", "Gastos", "Nómina"/
 * "Propinas" e "Ingeniería de menú"/"Reposición" completan la fila "Dinero y
 * control" de §14 que `shiftsFeature` (turnos, caja) ya empezaba.
 *
 * **Esta función no cambió con el rediseño del armazón, y es a propósito.**
 * Qué entradas se muestran lo sigue decidiendo `hasFeature` exactamente como
 * antes; lo que el rail agrega —grupo, ícono, recuento, nombre corto— es
 * apariencia, y vive en `RAIL`. El orden de acá deja de mandar en el dibujo
 * (manda `GRUPOS`) pero sigue siendo el orden dentro de cada grupo.
 */
export function buildNav(hasFeature: (key: string) => boolean): NavItem[] {
  const all = [
    ...reportsFeature.adminNav,
    ...ordersFeature.adminNav,
    ...catalogFeature.adminNav,
    ...recipesFeature.adminNav,
    ...inventoryFeature.adminNav,
    ...purchasesFeature.adminNav,
    ...bankingFeature.adminNav,
    ...expensesFeature.adminNav,
    ...payrollFeature.adminNav,
    ...analyticsFeature.adminNav,
    ...fiscalFeature.adminNav,
    ...shiftsFeature.adminNav,
    ...customersFeature.adminNav,
    ...OWN_NAV,
  ];
  return all.filter((item) => !item.feature || hasFeature(item.feature));
}

// ---------------------------------------------------------------------------
// El rail: ocho secciones, cada una con sus pantallas en pestañas
// (mapa de pantallas del restaurante, «De 25 entradas a 8»).
// ---------------------------------------------------------------------------

/**
 * **Ocho entradas en vez de veinticinco.** El dueño comparó el admin con el de
 * café-sistema y dijo que el del restaurante «se ve agobiante»: el rail
 * mostraba seis grupos con veinticinco enlaces, y la mitad eran pantallas que
 * este restaurante abre una vez al mes. Ahora el rail tiene una fila por
 * sección y las pantallas de cada sección van como pestañas arriba del
 * contenido (`PestanasDeSeccion`). Ninguna pantalla se borró ni cambió de
 * dirección: `/admin/banco` sigue siendo `/admin/banco`, sólo que se llega
 * por Caja › Banco.
 *
 * Los flags siguen mandando igual que antes: una pantalla apagada no aparece
 * como pestaña, y una sección sin pantallas encendidas no aparece en el rail.
 */
export const SECCIONES = [
  "Hoy",
  "Informes",
  "Caja",
  "Inventario",
  "Carta",
  "Plata",
  "Equipo",
  "Ajustes",
] as const;
export type Seccion = (typeof SECCIONES)[number];

/** El ícono de cada sección. Ninguna comparte el suyo con otra. */
export const ICONO_SECCION: Record<Seccion, LucideIcon> = {
  Hoy: CalendarDays,
  Informes: BarChart3,
  Caja: Banknote,
  Inventario: Package,
  Carta: BookOpen,
  Plata: Receipt,
  Equipo: Users,
  Ajustes: Settings,
};

/** Las cuatro pantallas que llevan recuento. Todas salen de `GET /admin/today`. */
export type Recuento = "pedidos" | "inventario" | "compras" | "devoluciones";

export interface FilaDelRail {
  seccion: Seccion;
  /** El texto visible en la pestaña: corto. */
  label: string;
  /**
   * El nombre completo, que es el nombre accesible de la pestaña y su `title`.
   * **Tiene que ser idéntico al `label` del `NavItem` del dominio**, y
   * `__tests__/adminRail.test.tsx` lo verifica entrada por entrada: acá se
   * escribe a mano para que el censo de controles lo vea.
   */
  title: string;
  cuenta?: Recuento;
}

/**
 * De ruta a su sección. La clave es el `to` del `NavItem`, que es lo único
 * estable: el dominio decide **si** la pantalla existe (su flag) y **a dónde**
 * va; el armazón decide en qué sección se lee y en qué orden.
 *
 * El orden de las filas de una sección es el orden de sus pestañas, y la
 * primera encendida es a donde lleva la entrada del rail.
 *
 * - **Hoy** junta el pulso del día con las comandas abiertas: las dos dicen
 *   qué está pasando ahora.
 * - **Informes** junta lo que mira el período cerrado. Documentos y notas van
 *   acá porque son el registro de lo vendido: con comprobante interno (persona
 *   natural, sin factura electrónica) siguen existiendo y siguen siendo ley.
 * - **Caja** junta la plata física: turnos, banco y lo que se devuelve.
 * - **Ajustes** recibe los rangos de numeración: son configuración de la DIAN,
 *   no algo que se mira todos los días.
 */
export const RAIL: Record<string, FilaDelRail> = {
  "/admin/hoy": { seccion: "Hoy", label: "Hoy", title: "Hoy" },
  "/admin/pedidos": { seccion: "Hoy", label: "Pedidos", title: "Pedidos", cuenta: "pedidos" },

  "/admin/ventas": { seccion: "Informes", label: "Ventas", title: "Ventas" },
  "/admin/analitica": {
    seccion: "Informes",
    label: "Ingeniería de menú",
    title: "Ingeniería de menú",
  },
  "/admin/clientes": { seccion: "Informes", label: "Clientes", title: "Clientes" },
  "/admin/fiscal/documentos": {
    seccion: "Informes",
    label: "Documentos",
    title: "Documentos fiscales",
  },
  "/admin/fiscal/notas": { seccion: "Informes", label: "Notas", title: "Notas" },

  "/admin/dinero": { seccion: "Caja", label: "Dinero", title: "Dinero" },
  "/admin/banco": { seccion: "Caja", label: "Banco", title: "Banco" },
  "/admin/fiscal/devoluciones-pendientes": {
    seccion: "Caja",
    label: "Devoluciones",
    title: "Devoluciones pendientes",
    cuenta: "devoluciones",
  },

  "/admin/inventario": {
    seccion: "Inventario",
    label: "Inventario",
    title: "Inventario",
    cuenta: "inventario",
  },
  "/admin/compras": { seccion: "Inventario", label: "Compras", title: "Compras", cuenta: "compras" },
  "/admin/analitica?tab=varianza": {
    seccion: "Inventario",
    label: "Varianza y salud",
    title: "Varianza y salud",
  },
  "/admin/analitica?tab=reposicion": {
    seccion: "Inventario",
    label: "Reposición",
    title: "Reposición",
  },

  "/admin/carta": { seccion: "Carta", label: "Carta", title: "Carta" },
  "/admin/preparaciones": { seccion: "Carta", label: "Preparaciones", title: "Preparaciones" },

  "/admin/gastos": { seccion: "Plata", label: "Gastos", title: "Gastos" },

  "/admin/personal": { seccion: "Equipo", label: "Turnos", title: "Turnos y personal" },
  "/admin/nomina": { seccion: "Equipo", label: "Nómina", title: "Nómina" },
  "/admin/nomina?tab=propinas": { seccion: "Equipo", label: "Propinas", title: "Propinas" },

  "/admin/settings": { seccion: "Ajustes", label: "Configuración", title: "Configuración" },
  "/admin/features": { seccion: "Ajustes", label: "Funciones", title: "Funciones" },
  "/admin/notifications": { seccion: "Ajustes", label: "Notificaciones", title: "Notificaciones" },
  "/admin/fiscal/rangos": { seccion: "Ajustes", label: "Rangos", title: "Rangos de numeración" },
  "/admin/audit": { seccion: "Ajustes", label: "Historial", title: "Historial" },
};

/**
 * La red de seguridad: una pantalla que el dominio agregue y que nadie haya
 * archivado acá **se sigue viendo**, como pestaña de Ajustes.
 * `adminRail.test.tsx` falla si eso pasa, pero fallar en CI no puede costar
 * una pantalla en producción.
 */
function filaDe(item: NavItem): FilaDelRail {
  return RAIL[item.to] ?? { seccion: "Ajustes", label: item.label, title: item.label };
}

const ORDEN = Object.keys(RAIL);
function porOrdenDelRail(a: NavItem, b: NavItem): number {
  const ia = ORDEN.indexOf(a.to);
  const ib = ORDEN.indexOf(b.to);
  // Una entrada que no esté en la tabla va al final, nunca se pierde.
  return (ia === -1 ? ORDEN.length : ia) - (ib === -1 ? ORDEN.length : ib);
}

/** Las pantallas encendidas de una sección, en el orden de sus pestañas. */
export function pantallasDe(items: NavItem[], seccion: Seccion): NavItem[] {
  return items.filter((item) => filaDe(item).seccion === seccion).sort(porOrdenDelRail);
}

/**
 * Los recuentos, y de dónde salen: **`GET /admin/today`, con la misma
 * `queryKey` que usa la pantalla Hoy** (`["admin-today", storeId]`). No hay
 * ni un pedido nuevo al servidor —parado en Hoy, react-query sirve la misma
 * entrada de caché a las dos y sale una sola petición—, y los números son los
 * que ya mira el dueño en los avisos de esa pantalla, así que el rail y los
 * avisos no pueden decir cosas distintas.
 *
 * El del inventario suma negativos **y** bajo mínimo: los avisos de Hoy
 * cuentan los dos por separado y una insignia que muestre sólo uno
 * sub-informa la pantalla (`docs/PATRONES-ADMIN.md`, desvío 3).
 *
 * Sin `refetchInterval` a propósito: la pantalla Hoy sondea cada 30 s y el
 * rail se cuelga de ese sondeo cuando estás ahí.
 */
function useRecuentos(storeId: number | null): Partial<Record<Recuento, number>> {
  const { data } = useQuery({
    queryKey: ["admin-today", storeId],
    queryFn: () => getToday(storeId as number),
    enabled: storeId !== null,
  });

  if (!data) return {};
  return {
    pedidos: (data.open_orders ?? []).length,
    inventario: (data.ingredients_negative ?? []).length + (data.ingredients_below_min ?? []).length,
    compras: (data.payables_overdue ?? []).length + (data.payables_pending_review_count ?? 0),
    devoluciones: data.pending_refunds_count ?? 0,
  };
}

/** Qué dice el recuento en voz alta. La insignia es un número; esto es el número con su unidad. */
const DICE: Record<Recuento, (n: number) => string> = {
  pedidos: (n) => `${n} comanda${n === 1 ? "" : "s"} abierta${n === 1 ? "" : "s"}`,
  inventario: (n) => `${n} insumo${n === 1 ? "" : "s"} en alerta`,
  compras: (n) => `${n} cuenta${n === 1 ? "" : "s"} por pagar sin resolver`,
  devoluciones: (n) => `${n} devolucion${n === 1 ? "" : "es"} pendiente${n === 1 ? "" : "s"}`,
};

/**
 * El recuento de una sección es la suma de los de sus pestañas, y su nombre
 * en voz alta los nombra uno por uno: «Inventario, 3 insumos en alerta, 2
 * cuentas por pagar sin resolver». `undefined` mientras ninguno se sabe.
 */
function recuentoDe(
  pantallas: NavItem[],
  counts: Partial<Record<Recuento, number>>,
): { total: number | undefined; dice: string[] } {
  let total: number | undefined;
  const dice: string[] = [];
  for (const item of pantallas) {
    const cuenta = filaDe(item).cuenta;
    const n = cuenta ? counts[cuenta] : undefined;
    if (cuenta === undefined || n == null) continue;
    total = (total ?? 0) + n;
    if (n > 0) dice.push(DICE[cuenta](n));
  }
  return { total, dice };
}

/**
 * `NavLink` decide «activo» sólo por la ruta e ignora el `?tab=`: con
 * «Nómina» (`/admin/nomina`) y «Propinas» (`/admin/nomina?tab=propinas`) en
 * la misma sección, las dos pestañas quedaban encendidas a la vez. Una entrada
 * con `?tab=` está activa sólo si la pestaña coincide; una sin él, sólo si
 * ninguna hermana de la misma ruta reclama la pestaña actual.
 */
export function entradaActiva(to: string, rutaActiva: boolean, search: string, todas: string[]): boolean {
  if (!rutaActiva) return false;
  const [ruta] = to.split("?");
  const tab = new URLSearchParams(search).get("tab");
  const propias = pestanasDe(to);
  if (propias.length > 0) return tab !== null && propias.includes(tab);
  return !todas.some((otra) => otra !== to && otra.split("?")[0] === ruta && tab !== null && pestanasDe(otra).includes(tab));
}

/**
 * Pestañas que una entrada reclama además de la de su `?tab=`: «Varianza y
 * salud» abre en Varianza por plato pero también es suya la pestaña Salud
 * sostenida. Sin esto, en Salud sostenida se encendía «Ingeniería de menú»
 * (la entrada sin pestaña de la misma ruta) y la sección saltaba a Informes.
 */
const PESTANAS_HERMANAS: Record<string, readonly string[]> = {
  "/admin/analitica?tab=varianza": ["salud-sostenida"],
};

function pestanasDe(to: string): string[] {
  const query = to.split("?")[1];
  if (query === undefined) return [];
  const tab = new URLSearchParams(query).get("tab");
  return [...(tab === null ? [] : [tab]), ...(PESTANAS_HERMANAS[to] ?? [])];
}

/** Si la ruta de `to` es la que se está mirando (la ruta o una hija suya). */
function rutaActivaDe(to: string, pathname: string): boolean {
  const [ruta] = to.split("?");
  return pathname === ruta || pathname.startsWith(`${ruta}/`);
}

/** La pantalla que se está mirando, entre las encendidas, o `undefined`. */
export function pantallaActiva(items: NavItem[], pathname: string, search: string): NavItem | undefined {
  const todas = items.map((item) => item.to);
  return items.find((item) => entradaActiva(item.to, rutaActivaDe(item.to, pathname), search, todas));
}

function SidebarNav({
  items,
  counts,
  onNavigate,
  touch = false,
}: {
  items: NavItem[];
  counts: Partial<Record<Recuento, number>>;
  onNavigate?: () => void;
  touch?: boolean;
}) {
  const { pathname, search } = useLocation();
  const activa = pantallaActiva(items, pathname, search);
  const seccionActiva = activa ? filaDe(activa).seccion : undefined;
  return (
    <nav aria-label="Secciones de administración" className="flex flex-col gap-0.5">
      {SECCIONES.map((seccion) => {
        const pantallas = pantallasDe(items, seccion);
        const destino = pantallas[0];
        if (!destino) return null;
        const { total, dice } = recuentoDe(pantallas, counts);
        const nombre = dice.length > 0 ? `${seccion}, ${dice.join(", ")}` : seccion;
        const enEsta = seccion === seccionActiva;
        return (
          <Link
            key={seccion}
            to={destino.to}
            onClick={onNavigate}
            title={seccion}
            aria-label={nombre}
            aria-current={enEsta ? "page" : undefined}
            className={railItemClass({ active: enEsta, touch })}
          >
            <RailItemContent icon={ICONO_SECCION[seccion]} label={seccion} count={total} />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * **Las pantallas de la sección, en pestañas**, arriba del contenido. Sólo se
 * dibujan si la sección tiene más de una pantalla encendida: Plata, con sólo
 * Gastos, no lleva una fila de pestañas de una sola pestaña.
 */
function PestanasDeSeccion({
  items,
  counts,
}: {
  items: NavItem[];
  counts: Partial<Record<Recuento, number>>;
}): React.JSX.Element | null {
  const { pathname, search } = useLocation();
  const activa = pantallaActiva(items, pathname, search);
  if (!activa) return null;
  const seccion = filaDe(activa).seccion;
  const pantallas = pantallasDe(items, seccion);
  if (pantallas.length < 2) return null;
  return (
    <nav aria-label={`Pantallas de ${seccion}`} className="-mt-1 mb-5 overflow-x-auto border-b">
      <ul className="flex min-w-max gap-1">
        {pantallas.map((item) => {
          const fila = filaDe(item);
          const n = fila.cuenta ? counts[fila.cuenta] : undefined;
          const nombre =
            fila.cuenta && n != null && n > 0 ? `${fila.title}, ${DICE[fila.cuenta](n)}` : fila.title;
          const esta = item.to === activa.to;
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                title={fila.title}
                aria-label={nombre}
                aria-current={esta ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex min-h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  esta
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {fila.label}
                {n != null && n > 0 ? (
                  <span aria-hidden="true" className="text-xs font-normal tabular-nums text-muted-foreground">
                    {n}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * El rol en palabras. `me.user.role` viaja en inglés («admin»), como todo el
 * código (AGENTS.md § Nombres), y la barra superior de `a2` lo lee en
 * español: «Óscar Restrepo · administrador». El `?? role` del final es la
 * red: un rol nuevo se muestra crudo antes que desaparecer.
 */
const ROL_EN_PALABRAS: Record<string, string> = {
  admin: "administrador",
  owner: "administrador",
  supervisor: "supervisor",
  cashier: "responsable de caja",
  operator: "operador",
};

/**
 * La identidad, en la cabeza de la lateral: **de quién y de dónde** es este
 * escritorio. En `a2` (`.lateral .marca`) son dos renglones —la organización
 * en negrita y la sede debajo, apagada— separados del cuerpo del rail por un
 * filete. La persona ya no va acá: subió a la barra superior, junto al rol.
 */
function Identidad(): React.JSX.Element {
  const { me } = useSession();
  const { stores, activeStoreId } = useStoreSelection();
  const sede = stores.find((s) => s.id === activeStoreId)?.name ?? me?.store?.name;
  return (
    <div className="mb-1.5 flex items-center gap-2 border-b px-1.5 pb-2.5">
      <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-sm leading-tight font-bold">
          {me?.organization?.name ?? "Restaurante Sistema"}
        </p>
        {sede ? <p className="truncate text-xs text-muted-foreground">{sede}</p> : null}
      </div>
    </div>
  );
}

/**
 * **El selector de sede vuelve a la barra superior**, que es donde `a2` lo
 * pone (`.barra-cuenta > .selector`). El reparto del alcance no cambió —la
 * sede sigue alcanzando a toda la app, el período sigue en la cabecera de
 * pantalla y el filtro de una tabla en la barra de esa tabla—; lo que cambió
 * es dónde vive lo que alcanza a todo: en una barra de producto y no en la
 * cabeza de la navegación. El dueño miró las dos y eligió a2.
 *
 * Cuando hay una sola sede no hay nada que elegir, y `a2` igual muestra la
 * pastilla con el nombre: se dibuja el mismo chip, sin desplegable. Dejar el
 * hueco vacío hacía que la barra dijera de quién es el escritorio pero no de
 * dónde.
 */
function StoreSwitcher(): React.JSX.Element | null {
  const { hasFeature, me } = useSession();
  const { stores, activeStoreId, setActiveStoreId } = useStoreSelection();

  if (!hasFeature("multi_store") || stores.length <= 1) {
    const sola = stores.find((s) => s.id === activeStoreId)?.name ?? me?.store?.name;
    if (!sola) return null;
    return (
      <p className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-sm">
        <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Sede</span>
        <b className="truncate font-bold">{sola}</b>
      </p>
    );
  }

  return (
    <Select
      value={activeStoreId ? String(activeStoreId) : undefined}
      onValueChange={(next) => setActiveStoreId(Number(next))}
    >
      <SelectTrigger className="h-8 w-auto shrink-0 gap-1.5 bg-card" aria-label="Sede activa">
        <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Sede</span>
        <SelectValue placeholder="Elegí una sede" />
      </SelectTrigger>
      <SelectContent>
        {stores.map((store) => (
          <SelectItem key={store.id} value={String(store.id)}>
            {store.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * La salida del admin. Existía `logout()` en `src/api/auth.ts` desde la fase
 * 1a y **ninguna pantalla la llamaba**: se podía entrar al admin y no había
 * forma de salir salvo borrar la cookie a mano. Con las credenciales del
 * seed publicadas, además, «cerrar sesión» es lo primero que alguien
 * necesita en una PC compartida.
 *
 * Si el servidor falla, la sesión del cliente NO se limpia: la cookie sigue
 * viva, así que dar por cerrada una sesión que no se cerró es peor que
 * avisar del error — al recargar volvería a entrar sola.
 *
 * Dos formas: `"barra"` es el botón de la barra superior de `a2`
 * (`.ico-btn`, ícono + la palabra) y `"rail"` la fila del cajón del móvil,
 * donde no hay barra. El rótulo «Salir» se escribe literal en las dos: un
 * rótulo dentro de un atributo `render={…}` es invisible para
 * `src/audit/censo-controles.test.ts`.
 */
function LogoutButton({
  variant = "barra",
  touch = false,
}: {
  variant?: "barra" | "rail";
  touch?: boolean;
} = {}): React.JSX.Element {
  const { clear } = useSession();
  const [saliendo, setSaliendo] = useState(false);

  async function handleLogout() {
    setSaliendo(true);
    try {
      await logout();
      // `clear()` deja `me` en `null` y el guard `RequireAdmin` de
      // `router.tsx` redirige a `/login`; no hace falta navegar a mano.
      clear();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaliendo(false);
    }
  }

  if (variant === "rail") {
    return (
      <button
        type="button"
        className={railItemClass({ touch, className: "disabled:opacity-50" })}
        title="Cerrar sesión"
        onClick={() => void handleLogout()}
        disabled={saliendo}
      >
        <RailItemContent icon={LogOut} label="Salir" />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      title="Cerrar sesión"
      onClick={() => void handleLogout()}
      disabled={saliendo}
    >
      <LogOut className="size-4 shrink-0" aria-hidden="true" />
      Salir
    </button>
  );
}

/**
 * **La barra superior vuelve** (`admin/a2/direccion.html`, `.barra-cuenta`).
 *
 * El rediseño anterior la había disuelto —sede e identidad a la cabeza de la
 * lateral, campana/tema/salida al pie— con el argumento de que una barra le
 * cobra 56 px de alto a un portátil. La de `a2` cobra 34: es una franja de
 * un control de alto, no una cabecera de producto. Y a cambio junta en un
 * solo renglón las cuatro cosas que no son de ninguna pantalla: **de dónde**
 * (la sede), **quién** (persona y rol), y las tres salidas —avisos, tema,
 * cerrar sesión—. En la lateral quedaban mezcladas con la navegación del
 * negocio, que es lo contrario de lo que el patrón del alcance pide.
 *
 * En el móvil la misma barra lleva además el botón del cajón: es una sola
 * franja en las dos superficies, no una para cada una.
 */
function TopBar({
  storeId,
  menu,
}: {
  storeId: number | null;
  menu?: React.ReactNode;
}): React.JSX.Element {
  const { me } = useSession();
  const rol = me?.user?.role;
  const persona = me?.user?.name;
  return (
    <header className="sticky top-0 z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-3 py-1.5">
      {menu}
      <StoreSwitcher />
      {persona ? (
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {persona}
          {rol ? ` · ${ROL_EN_PALABRAS[rol] ?? rol}` : null}
        </p>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <NotificationBell storeId={storeId} />
        <ThemeToggle />
        <LogoutButton />
      </div>
    </header>
  );
}

/** El rail entero: identidad, navegación agrupada y —sólo en el móvil— la salida. */
function RailContenido({
  items,
  counts,
  onNavigate,
  touch = false,
}: {
  items: NavItem[];
  counts: Partial<Record<Recuento, number>>;
  onNavigate?: () => void;
  touch?: boolean;
}) {
  return (
    <>
      <div className="shrink-0">
        <Identidad />
      </div>
      {/* Sólo la lista rueda: la identidad queda fija. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav items={items} counts={counts} onNavigate={onNavigate} touch={touch} />
      </div>
      {/* El cajón del móvil se abre por encima de la barra superior y la
          tapa: la salida tiene que estar también acá adentro o queda sin
          alcance mientras el cajón está abierto. En el escritorio el cajón
          no existe y la salida vive una sola vez, en la barra. */}
      {touch ? (
        <div className="mt-auto flex shrink-0 flex-col border-t pt-1.5">
          <LogoutButton variant="rail" touch />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// El celular del dueño: la barra inferior (`docs/diseno/propuesta.html`,
// «Celular del dueño» y Momento 5).
// ---------------------------------------------------------------------------

/** El mismo corte que `md:` de Tailwind: por debajo de 768 px es el celular. */
const CONSULTA_CELULAR = "(max-width: 767.98px)";

function suscribirCelular(avisar: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const consulta = window.matchMedia(CONSULTA_CELULAR);
  consulta.addEventListener("change", avisar);
  return () => consulta.removeEventListener("change", avisar);
}

function esCelular(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(CONSULTA_CELULAR).matches;
}

/**
 * **La barra inferior se monta sólo en el celular**, no se esconde con CSS
 * nada más. Con `md:hidden` solo, el escritorio llevaría en el árbol una
 * segunda «Hoy» y una segunda «Ventas» invisibles, y cada `getByRole("link",
 * { name: "Hoy" })` de las pruebas —y cada lector de pantalla que no respete
 * `display` de algún ancestro— vería dos. Sin `matchMedia` (jsdom) es
 * escritorio: nada cambia.
 */
function useEsCelular(): boolean {
  return useSyncExternalStore(suscribirCelular, esCelular, () => false);
}

/**
 * «Avisos» no tiene pantalla propia, y es a propósito que no lleve a
 * `/admin/notifications`: esa pantalla es **el historial y las reglas** de
 * las notificaciones, y la campana es una lista que sólo marca leído. La
 * propuesta lo pide explícito —«los avisos llevan a la pantalla que resuelve,
 * nunca a una lista muerta»—, y la única lista de avisos donde cada renglón
 * lleva a donde se resuelve es «Requiere tu atención» de Hoy, que además
 * ya incluye las notificaciones del servidor (`today.alerts`). El ancla la
 * pone `features/reports/TodayPage.tsx` y la baja hasta ahí al llegar.
 */
const ANCLA_AVISOS = "requiere-atencion";

const CLASE_DESTINO =
  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function claseDestino(activo: boolean): string {
  return cn(
    CLASE_DESTINO,
    // La marca llena del rail (`railItemClass`) acá sería un bloque de 72 px
    // de color: la entrada activa se dice con el color del texto y una raya
    // arriba, y `aria-current` lo dice en voz alta.
    activo
      ? "text-primary shadow-[inset_0_2px_0_0_var(--primary)]"
      : "text-muted-foreground hover:text-foreground",
  );
}

/**
 * **Cuatro destinos y «Más»** (Hoy · Informes · Caja · Avisos): lo que el
 * dueño mira un domingo desde el celular, sin abrir el cajón. «Más» abre el
 * cajón de siempre, con las ocho secciones.
 *
 * Los flags siguen mandando: la barra se arma **desde `items`**, que ya pasó
 * por `buildNav(hasFeature)`. Informes y Caja llevan a la primera pantalla
 * encendida de su sección, igual que el rail; una sección sin ninguna
 * encendida no está acá —la barra tiene un destino menos, no un hueco—.
 */
function BarraInferior({
  items,
  onMas,
  masAbierto,
}: {
  items: NavItem[];
  onMas: () => void;
  masAbierto: boolean;
}): React.JSX.Element {
  const { pathname, search, hash } = useLocation();
  const hoy = items.find((item) => item.to === "/admin/hoy");
  const informes = pantallasDe(items, "Informes")[0];
  const caja = pantallasDe(items, "Caja")[0];
  const activa = pantallaActiva(items, pathname, search);
  const seccionActiva = activa ? filaDe(activa).seccion : undefined;
  const enAvisos = pathname === "/admin/hoy" && hash === `#${ANCLA_AVISOS}`;
  const enHoy = pathname === "/admin/hoy" && !enAvisos;

  return (
    <nav
      aria-label="Accesos del celular"
      // `pb-[env(…)]`: en un iPhone sin botón la barra no queda debajo de la
      // raya de inicio.
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-muted pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid auto-cols-fr grid-flow-col">
        {/* Los rótulos van escritos literal, uno por destino, y no desde un
            arreglo: el censo de controles lee el código, no el DOM. */}
        {hoy ? (
          <li>
            <Link to={hoy.to} aria-current={enHoy ? "page" : undefined} className={claseDestino(enHoy)}>
              <CalendarDays className="size-5" aria-hidden="true" />
              Hoy
            </Link>
          </li>
        ) : null}
        {informes ? (
          <li>
            <Link
              to={informes.to}
              title={filaDe(informes).title}
              aria-current={seccionActiva === "Informes" ? "page" : undefined}
              className={claseDestino(seccionActiva === "Informes")}
            >
              <BarChart3 className="size-5" aria-hidden="true" />
              Informes
            </Link>
          </li>
        ) : null}
        {caja ? (
          <li>
            <Link
              to={caja.to}
              title={filaDe(caja).title}
              aria-current={seccionActiva === "Caja" ? "page" : undefined}
              className={claseDestino(seccionActiva === "Caja")}
            >
              <Banknote className="size-5" aria-hidden="true" />
              Caja
            </Link>
          </li>
        ) : null}
        {hoy ? (
          <li>
            <Link
              to={`${hoy.to}#${ANCLA_AVISOS}`}
              title="Hoy › Requiere tu atención"
              aria-current={enAvisos ? "location" : undefined}
              className={claseDestino(enAvisos)}
            >
              <CircleAlert className="size-5" aria-hidden="true" />
              Avisos
            </Link>
          </li>
        ) : null}
        <li>
          <button
            type="button"
            onClick={onMas}
            aria-haspopup="dialog"
            aria-expanded={masAbierto}
            title="Todas las secciones"
            className={cn(claseDestino(false), "w-full")}
          >
            <Ellipsis className="size-5" aria-hidden="true" />
            Más
          </button>
        </li>
      </ul>
    </nav>
  );
}

function AdminChrome(): React.JSX.Element {
  // Escritorio del dueño: cuerpo 16 px y filas de 34 px (`.oficina`).
  useDensity("oficina");
  const { hasFeature, me } = useSession();
  const { activeStoreId } = useStoreSelection();
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = buildNav(hasFeature);
  const counts = useRecuentos(activeStoreId);
  const celular = useEsCelular();

  return (
    <div className="oficina flex min-h-screen bg-background text-foreground">
      {/* 222 px medidos: el ancho al que los cuatro nombres largos dejan de
          truncar una vez acortados (`docs/PATRONES-ADMIN.md` § 1).
          El fondo va en el `aside`, que se estira con la página, y el
          `sticky` adentro: con las dos cosas en el mismo elemento la
          columna gris terminaba a la altura de la ventana y dejaba una
          franja blanca bajo el pliegue en toda pantalla más alta que el
          monitor. En `a2` la lateral es una celda de la grilla y llega
          siempre hasta abajo. */}
      <aside className={cn("hidden w-[222px] shrink-0 border-r bg-muted md:block")}>
        <div className="sticky top-0 flex h-screen flex-col p-2">
          <RailContenido items={items} counts={counts} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          storeId={activeStoreId}
          menu={
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="md:hidden"
                    aria-label="Abrir menú"
                  />
                }
              >
                <Menu className="size-5" aria-hidden="true" />
              </SheetTrigger>
              <SheetContent side="left" className="flex w-[17rem] flex-col p-2">
                <SheetHeader className="p-0">
                  <SheetTitle className="sr-only">
                    {me?.organization?.name ?? "Restaurante Sistema"}
                  </SheetTitle>
                </SheetHeader>
                <RailContenido
                  items={items}
                  counts={counts}
                  onNavigate={() => setMobileOpen(false)}
                  touch
                />
              </SheetContent>
            </Sheet>
          }
        />
        {/* Con la barra inferior, el pie del contenido sube lo que ella mide
            (56 px + la raya de inicio del teléfono) y un poco de aire: el
            último renglón de la pantalla nunca queda tapado. */}
        <main
          className={cn(
            "min-w-0 flex-1 p-4 md:p-6",
            celular && "pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-6",
          )}
        >
          <PestanasDeSeccion items={items} counts={counts} />
          <Outlet />
        </main>
      </div>
      {celular ? (
        <BarraInferior items={items} onMas={() => setMobileOpen(true)} masAbierto={mobileOpen} />
      ) : null}
    </div>
  );
}

/** Sidebar armado desde `NavItem[]` propios + `shiftsFeature`/`catalogFeature`. */
export default function AdminLayout(): React.JSX.Element {
  return (
    <StoreSelectionProvider>
      <AdminChrome />
    </StoreSelectionProvider>
  );
}
