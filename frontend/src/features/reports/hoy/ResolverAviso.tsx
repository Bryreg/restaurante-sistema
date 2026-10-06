import { useMutation, useQueryClient } from "@tanstack/react-query"

import { newIdempotencyKey } from "@/api/client"
import { resolveNotifications } from "@/api/notifications"
import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/errors"

/**
 * «Resolver» de un aviso del riel (0042). **Leído no es resuelto**: abrir la
 * campana marca los avisos vistos y dejan de contar como nuevos, pero siguen
 * en «Requiere tu atención» hasta que alguien los resuelve acá —o hasta que
 * la condición que los disparó se apaga sola, que lo decide el servidor—.
 * Lo resuelto queda a nombre de quien lo tocó, con la hora, en Ajustes ›
 * Notificaciones; no se borra nada.
 */
export function ResolverAviso({ notificationIds }: { notificationIds: number[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const resolver = useMutation({
    mutationFn: () => resolveNotifications(notificationIds, newIdempotencyKey()),
    onSuccess: () => {
      // El riel sale de `GET /admin/today`; la campana, de la lista de avisos.
      void queryClient.invalidateQueries({ queryKey: ["admin-today"] })
      void queryClient.invalidateQueries({ queryKey: ["admin-notifications"] })
    },
  })
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={resolver.isPending || resolver.isSuccess}
        onClick={() => resolver.mutate()}
      >
        {resolver.isPending ? "Resolviendo…" : resolver.isSuccess ? "Resuelto" : "Resolver"}
      </Button>
      {resolver.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(resolver.error)}
        </p>
      ) : null}
    </>
  )
}
