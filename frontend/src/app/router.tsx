import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from "react-router-dom";

import { RouteError } from "@/app/RouteError";
import DeviceActivatePage from "@/features/auth/DeviceActivatePage";
import DeviceIdentifyPage from "@/features/auth/DeviceIdentifyPage";
import LoginPage from "@/features/auth/LoginPage";
import { analyticsFeature } from "@/features/analytics";
import { bankingFeature } from "@/features/banking";
import { catalogFeature } from "@/features/catalog";
import AuditPage from "@/features/audit/AuditPage";
import { customersFeature } from "@/features/customers";
import { expensesFeature } from "@/features/expenses";
import { fiscalFeature } from "@/features/fiscal";
import FeaturesPage from "@/features/features/FeaturesPage";
import { inventoryFeature } from "@/features/inventory";
import { kitchenFeature } from "@/features/kitchen";
import NotificationsPage from "@/features/notifications/NotificationsPage";
import { ordersFeature } from "@/features/orders";
import { payrollFeature } from "@/features/payroll";
import { paymentsFeature } from "@/features/payments";
import { purchasesFeature } from "@/features/purchases";
import { recipesFeature } from "@/features/recipes";
import { reportsFeature } from "@/features/reports";
import SettingsPage from "@/features/settings/SettingsPage";
import { shiftsFeature } from "@/features/shifts";

import AdminLayout from "./AdminLayout";
import PosHome from "./PosHome";
import PosLayout from "./PosLayout";
import { useSession } from "./session";

function FullScreenSpinner(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Cargando…
    </div>
  );
}

function RequireAdmin({ children }: { children: React.ReactElement }): React.ReactElement {
  const { me, loading } = useSession();
  if (loading) return <FullScreenSpinner />;
  if (!me || me.kind !== "admin") return <Navigate to="/login" replace />;
  return children;
}

function RequireDevice({ children }: { children: React.ReactElement }): React.ReactElement {
  const { me, loading } = useSession();
  if (loading) return <FullScreenSpinner />;
  if (!me || me.kind !== "device") return <Navigate to="/pos/activate" replace />;
  return children;
}

/**
 * `createBrowserRouter`: "/admin/*" exige `kind === "admin"`, "/pos/*"
 * exige `kind === "device"`. Concatena las rutas y la navegación que
 * declaran `shiftsFeature`, `catalogFeature`, `ordersFeature`,
 * `paymentsFeature`, `reportsFeature`, `fiscalFeature` y `customersFeature`
 * (CONTRATO-INTERNO-1b-1.md §6.2, pedido 1b-2), más `inventoryFeature` y
 * `recipesFeature` (pedido 2a) y `purchasesFeature` (pedido 2b — sólo
 * `adminRoutes`: la recepción lleva precios, nunca una ruta bajo `/pos`).
 * `PosHome` es la ruta índice de `/pos`:
 * decide entre Mesas y Comanda nueva según `pos.tables`. La ruta índice de
 * `/admin` es "Hoy" (`reportsFeature`): es la pantalla por la que el dueño
 * abre el admin (SPEC-NEGOCIO §9.3, "pulso de hoy" primero).
 * `kitchenFeature` (pedido 2c, CONTRATO C8): sólo `posRoutes` — el KDS es
 * puramente de dispositivo (§9.2), sin pantalla de admin propia.
 * `bankingFeature`, `expensesFeature`, `payrollFeature` y `analyticsFeature`
 * (fase 3, `features/fase-3-dinero-control/spec.md` § T5): sólo
 * `adminRoutes` — dinero, costos y nómina son pantallas de administrador,
 * nunca del operador (AGENTS.md § "el operador no recibe costos ni
 * márgenes").
 */
const routes: RouteObject[] = [
  { path: "/", element: <Navigate to="/login" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/pos/activate", element: <DeviceActivatePage /> },
  {
    path: "/pos/identify",
    element: (
      <RequireDevice>
        <DeviceIdentifyPage />
      </RequireDevice>
    ),
  },
  {
    path: "/admin",
    element: (
      <RequireAdmin>
        <AdminLayout />
      </RequireAdmin>
    ),
    errorElement: <RouteError home="/admin/hoy" />,
    children: [
      { index: true, element: <Navigate to="hoy" replace /> },
      { path: "features", element: <FeaturesPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "audit", element: <AuditPage /> },
      { path: "notifications", element: <NotificationsPage /> },
      ...reportsFeature.adminRoutes,
      ...shiftsFeature.adminRoutes,
      ...catalogFeature.adminRoutes,
      ...ordersFeature.adminRoutes,
      ...fiscalFeature.adminRoutes,
      ...customersFeature.adminRoutes,
      ...inventoryFeature.adminRoutes,
      ...recipesFeature.adminRoutes,
      ...purchasesFeature.adminRoutes,
      ...bankingFeature.adminRoutes,
      ...expensesFeature.adminRoutes,
      ...payrollFeature.adminRoutes,
      ...analyticsFeature.adminRoutes,
    ],
  },
  {
    path: "/pos",
    element: (
      <RequireDevice>
        <PosLayout />
      </RequireDevice>
    ),
    errorElement: <RouteError home="/pos" />,
    children: [
      { index: true, element: <PosHome /> },
      ...shiftsFeature.posRoutes,
      ...ordersFeature.posRoutes,
      ...paymentsFeature.posRoutes,
      ...inventoryFeature.posRoutes,
      ...recipesFeature.posRoutes,
      ...kitchenFeature.posRoutes,
    ],
  },
  { path: "*", element: <Navigate to="/login" replace /> },
];

export const router = createBrowserRouter(routes);

export function AppRouter(): React.JSX.Element {
  return <RouterProvider router={router} />;
}
