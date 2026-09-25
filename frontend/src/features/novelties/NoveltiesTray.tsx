import { useQuery, useQueryClient } from "@tanstack/react-query"

import { listAdminNovelties, resolveNoveltyAsAdmin } from "@/api/novelties"
import { Cargando } from "@/components/Cargando"
import { errorMessage } from "@/lib/errors"

import { NoveltyItem } from "./NoveltyItem"
import { ResolveNovelty } from "./ResolveNovelty"
import { NOVELTIES_QUERY_KEYS } from "./lib"

/**
 * Bandeja de novedades para Hoy (admin): las abiertas de la sede —las que
 * requieren seguimiento y nadie resolvió—, urgentes primero (el orden lo
 * manda el servidor), cada una con «Resolver». Quien la monta decide si la
 * muestra con `pos.novelties` apagada; esta pieza no consulta el flag.
 */
export function NoveltiesTray({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: NOVELTIES_QUERY_KEYS.adminOpen(storeId),
    queryFn: () => listAdminNovelties({ storeId, status: "open" }),
  })
  const rows = query.data ?? []
  const urgentes = rows.filter((n) => n.level === "urgent").length

  return (
    <section aria-labelledby="bandeja-novedades" className="space-y-3">
      <h3 id="bandeja-novedades" className="text-base font-semibold">
        Novedades abiertas ({rows.length})
        {urgentes > 0 ? <span className="ml-2 text-sm text-destructive">· {urgentes} urgente{urgentes === 1 ? "" : "s"}</span> : null}
      </h3>
      {query.isLoading ? (
        <Cargando filas={2} />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin novedades abiertas: ningún turno dejó nada pendiente.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((n) => (
            <NoveltyItem
              key={n.id}
              novelty={n}
              action={
                <ResolveNovelty
                  novelty={n}
                  resolve={(note, key) => resolveNoveltyAsAdmin(storeId, n.id, note, key)}
                  onResolved={() => void queryClient.invalidateQueries({ queryKey: ["novelties"] })}
                />
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}
