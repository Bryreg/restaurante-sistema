import { useRouteError } from "react-router-dom";

import { Button } from "@/components/ui/button";

/**
 * Pantalla para un error de render dentro del admin o del POS. Sin esto,
 * React Router pinta su pantalla de desarrollador («Unexpected Application
 * Error!» con el stack en inglés): así la vio el dueño al abrir la campana de
 * notificaciones. La persona que lee esto está atendiendo un restaurante: le
 * decimos qué hacer, no qué falló por dentro (eso va a la consola).
 */
export function RouteError({ home }: { home: string }): React.JSX.Element {
  const error = useRouteError();
  console.error(error);
  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
      <h1 className="text-xl font-semibold">Algo falló en esta pantalla</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Lo que ya estaba guardado no se perdió. Volvé a cargar la pantalla; si vuelve a pasar, avisale a quien
        administra el sistema contando qué estabas haciendo.
      </p>
      <div className="flex gap-2">
        <Button type="button" onClick={() => window.location.reload()}>
          Volver a cargar
        </Button>
        <Button type="button" variant="outline" onClick={() => window.location.assign(home)}>
          Ir al inicio
        </Button>
      </div>
    </div>
  );
}
