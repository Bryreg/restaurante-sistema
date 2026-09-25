import { useQuery, useQueryClient } from "@tanstack/react-query"

import { getNoveltyBoard, resolveNovelty } from "@/api/novelties"
import { useSession } from "@/app/session"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"

import { NoveltyForm } from "./NoveltyForm"
import { NoveltyItem } from "./NoveltyItem"
import { ResolveNovelty } from "./ResolveNovelty"
import { NOVELTIES_QUERY_KEYS } from "./lib"

/**
 * Novedades del turno en el POS (`pos.novelties`). Arriba, las «Novedades
 * sin resolver (n)» de cualquier turno —urgentes primero, en el orden que
 * manda el servidor— con «Resolver»; después, registrar una nueva; al final,
 * las del turno. Funciona con o sin turno abierto: una nevera se daña
 * también antes de abrir caja.
 */
export function NoveltiesPanel(): React.JSX.Element {
  const { hasFeature } = useSession()
  const enabled = hasFeature("pos.novelties")
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: NOVELTIES_QUERY_KEYS.board, queryFn: getNoveltyBoard, enabled })

  if (!enabled) {
    return (
      <EmptyState
        title="Las novedades del turno no están habilitadas"
        description="Activá «Novedades del turno» en Admin → Funciones."
      />
    )
  }

  const refrescar = () => void queryClient.invalidateQueries({ queryKey: ["novelties"] })
  const board = query.data
  // Las del turno que ya están en «sin resolver» no se repiten abajo.
  const openIds = new Set((board?.open ?? []).map((n) => n.id))
  const delTurno = (board?.this_shift ?? []).filter((n) => !openIds.has(n.id))

  return (
    <div className="space-y-8">
      <section aria-labelledby="novedades-abiertas" className="space-y-3">
        <h3 id="novedades-abiertas" className="text-lg font-semibold">
          Novedades sin resolver ({board?.open_count ?? 0})
        </h3>
        {query.isLoading ? (
          <Cargando />
        ) : query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(query.error)}
          </p>
        ) : board && board.open.length > 0 ? (
          <ul className="space-y-2">
            {board.open.map((n) => (
              <NoveltyItem
                key={n.id}
                novelty={n}
                action={
                  <ResolveNovelty
                    novelty={n}
                    resolve={(note, key) => resolveNovelty(n.id, note, key)}
                    onResolved={refrescar}
                  />
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No hay novedades pendientes de turnos anteriores ni de éste.</p>
        )}
      </section>

      <section aria-labelledby="registrar-novedad" className="space-y-3">
        <h3 id="registrar-novedad" className="text-lg font-semibold">
          Registrar novedad
        </h3>
        <NoveltyForm onCreated={refrescar} />
      </section>

      {delTurno.length > 0 ? (
        <section aria-labelledby="novedades-del-turno" className="space-y-3">
          <h3 id="novedades-del-turno" className="text-lg font-semibold">
            Del turno
          </h3>
          <ul className="space-y-2">
            {delTurno.map((n) => (
              <NoveltyItem key={n.id} novelty={n} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
