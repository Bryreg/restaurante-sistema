import { useQuery } from "@tanstack/react-query";

import { listNotifications } from "@/api/notifications";

/**
 * Las notificaciones de la sede, sondeadas cada 30 s. **Una sola consulta**
 * para la campana de la barra y el recuento de «Avisos» de la barra inferior
 * del celular: comparten `queryKey`, así que sale un solo pedido y los dos
 * números no pueden decir cosas distintas.
 */
export function useNotificaciones(storeId: number | null) {
  return useQuery({
    queryKey: ["admin-notifications", storeId],
    queryFn: () => listNotifications({ storeId }),
    refetchInterval: 30_000,
  });
}

/** Cuántas no se leyeron. `undefined` mientras no se sabe (nunca un 0 inventado). */
export function useAvisosSinLeer(storeId: number | null): number | undefined {
  const { data } = useNotificaciones(storeId);
  return data?.filter((n) => n.read_at === null).length;
}
