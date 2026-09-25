import type { Novelty } from "@/api/novelties"
import { Badge } from "@/components/ui/badge"
import { formatInstant } from "@/lib/businessDate"

import { CATEGORY_LABEL, LEVEL_LABEL, levelVariant } from "./lib"

/** Una novedad: nivel, categoría, qué pasó, quién y cuándo; y si está
 * resuelta, quién la resolvió y cómo. `action` es el botón de resolver. */
export function NoveltyItem({
  novelty,
  action,
}: {
  novelty: Novelty
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={levelVariant(novelty.level)}>{LEVEL_LABEL[novelty.level]}</Badge>
        <span className="text-xs text-muted-foreground">{CATEGORY_LABEL[novelty.category]}</span>
        {novelty.requires_follow_up && novelty.resolved_at === null ? (
          <span className="text-xs text-muted-foreground">· pasa al siguiente turno</span>
        ) : null}
      </div>
      <p className="font-medium">{novelty.title}</p>
      {novelty.detail ? <p className="text-sm">{novelty.detail}</p> : null}
      <p className="text-xs text-muted-foreground">
        {novelty.employee_name} · {formatInstant(novelty.created_at)}
        {novelty.photo ? (
          <>
            {" · "}
            <a href={novelty.photo} target="_blank" rel="noreferrer" className="font-bold text-primary underline">
              Ver foto
            </a>
          </>
        ) : null}
      </p>
      {novelty.resolved_at ? (
        <p className="text-sm text-muted-foreground">
          Resuelta por {novelty.resolved_by_employee_name ?? "—"} · {formatInstant(novelty.resolved_at)}: {novelty.resolution_note}
        </p>
      ) : null}
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </li>
  )
}
