import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from "react-router-dom";

import DeviceActivatePage from "@/features/auth/DeviceActivatePage";
import DeviceIdentifyPage from "@/features/auth/DeviceIdentifyPage";
import LoginPage from "@/features/auth/LoginPage";
import { catalogFeature } from "@/features/catalog";
import AuditPage from "@/features/audit/AuditPage";
import FeaturesPage from "@/features/features/FeaturesPage";
import NotificationsPage from "@/features/notifications/NotificationsPage";
import SettingsPage from "@/features/settings/SettingsPage";
import { shiftsFeature } from "@/features/shifts";

import AdminLayout from "./AdminLayout";
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
 * declaran `shiftsFeature` y `catalogFeature` (contrato interno § 5).
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
    children: [
      { index: true, element: <Navigate to="features" replace /> },
      { path: "features", element: <FeaturesPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "audit", element: <AuditPage /> },
      { path: "notifications", element: <NotificationsPage /> },
      ...shiftsFeature.adminRoutes,
      ...catalogFeature.adminRoutes,
    ],
  },
  {
    path: "/pos",
    element: (
      <RequireDevice>
        <PosLayout />
      </RequireDevice>
    ),
    children: [...shiftsFeature.posRoutes],
  },
  { path: "*", element: <Navigate to="/login" replace /> },
];

export const router = createBrowserRouter(routes);

export function AppRouter(): React.JSX.Element {
  return <RouterProvider router={router} />;
}
