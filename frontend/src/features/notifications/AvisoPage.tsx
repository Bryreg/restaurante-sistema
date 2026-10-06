import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronRight, CircleCheck } from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { ApiError } from "@/api/client";
import { getNotification, markNotificationRead, type Notification } from "@/api/notifications";
import { useStoreSelection } from "@/app/storeContext";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { buttonVariants } from "@/components/ui/button";
import { formatClockTime, formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import {
  NIVEL,
  cifraDelAviso,
  destinoDelAviso,
  fichasDelAviso,
  fotoDelAviso,
  seccionDelAviso,
} from "./avisos";
import { TYPE_HELP, TYPE_LABEL } from "./types";

/**
 * **El aviso, abierto desde la notificación** (handoff, pantalla 13b:
 * `AdminMovil pantalla="aviso"`). Es a donde lleva tocar el aviso en el
 * celular: `sw.js` abre la URL que armó el servidor
 * (`/admin/avisos/{id}?desde=notificacion&destino=…`), y también a donde
 * lleva cada aviso de la campana.
 *
 * Arriba, la pastilla «Abierto desde una notificación» (sólo si se llegó por
 * ahí), la gravedad y la sección, el título, la cifra si el servidor la mandó
 * y la foto si el aviso la trae; debajo, el detalle y las fichas que el aviso
 * nombra. **Las acciones quedan fijas sobre la barra inferior**: en un
 * celular con el pulgar, lo que se hace no puede estar bajo el pliegue.
 *
 * **Qué resuelve y qué no.** Una notificación del servidor no es un
 * movimiento: no tiene «confirmar» ni «reversar» propios
 * (`app/notifications/router.py` sólo sabe leerla y marcarla leída). La
 * acción primaria lleva a la pantalla donde el hecho se resuelve —y donde
 * cada acción queda a nombre de quien la hizo y se reversa con motivo—; la
 * secundaria la marca vista, que **deja rastro** (`read_at`, con la hora) y
 * la saca de los avisos sin leer sin borrar nada.
 */
export default function AvisoPage(): React.JSX.Element {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const notificationId = Number(id);
  const valido = Number.isInteger(notificationId) && notificationId > 0;
  const desdeNotificacion = searchParams.get("desde") === "notificacion";
  const destinoDeLaUrl = searchParams.get("destino");

  const queryClient = useQueryClient();
  const { stores } = useStoreSelection();
  const [fotoGrande, setFotoGrande] = useState(false);

  const query = useQuery({
    queryKey: ["admin-notification", notificationId],
    queryFn: () => getNotification(notificationId),
    enabled: valido,
  });

  const marcar = useMutation({
    mutationFn: () => markNotificationRead(notificationId),
    onSuccess: (leida) => {
      queryClient.setQueryData<Notification>(["admin-notification", notificationId], leida);
      // La campana y el recuento de la barra inferior leen esta lista.
      void queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
    },
  });

  if (!valido || (query.isError && query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <EmptyState
        reason="dependency"
        title="Ese aviso no existe"
        description="Puede ser de otra organización o el enlace está mal copiado. Los avisos vigentes están en Hoy › Requiere tu atención."
        action={{ label: "Ver los avisos", to: "/admin/hoy#requiere-atencion" }}
      />
    );
  }
  if (query.isError) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo abrir el aviso"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }
  if (!query.data) {
    return <Cargando texto="Abriendo el aviso…" />;
  }

  const aviso = query.data;
  const nivel = NIVEL[aviso.level] ?? NIVEL.info;
  const destino = destinoDelAviso(aviso, destinoDeLaUrl);
  const cifra = cifraDelAviso(aviso.payload);
  const foto = fotoDelAviso(aviso.payload);
  const fichas = fichasDelAviso(aviso.payload);
  const sede = stores.find((s) => s.id === aviso.store_id)?.name;

  const detalle: { k: string; v: string }[] = [
    { k: "Qué pasó", v: aviso.body },
    { k: "Tipo", v: TYPE_LABEL[aviso.type] ?? aviso.type },
    ...(TYPE_HELP[aviso.type] ? [{ k: "Por qué avisa", v: TYPE_HELP[aviso.type] }] : []),
    ...(sede ? [{ k: "Sede", v: sede }] : []),
    { k: "Cuándo", v: formatInstant(aviso.created_at) },
  ];

  return (
    <article className="mx-auto flex max-w-xl flex-col gap-3">
      {desdeNotificacion ? (
        <p className="inline-flex items-center gap-1.5 self-start rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground">
          <Bell className="size-[13px] shrink-0" aria-hidden="true" />
          Abierto desde una notificación · {formatClockTime(aviso.created_at)}
        </p>
      ) : null}

      <header className={cn("flex flex-col gap-1 border-l-[3px] pl-2.5", nivel.franja)}>
        <p className={cn("text-xs font-bold", nivel.tinta)}>
          {nivel.palabra} · {seccionDelAviso(aviso.type)}
        </p>
        <h1 className="text-[1.375rem] leading-tight font-extrabold">{aviso.title}</h1>
      </header>

      {cifra ? (
        <p className="flex flex-col">
          <span className="text-xs text-muted-foreground">{cifra.rotulo}</span>
          <b className="text-4xl leading-tight font-bold tracking-[-0.02em] tabular-nums [font-stretch:110%]">
            {formatCOP(cifra.valor)}
          </b>
        </p>
      ) : null}

      {foto ? (
        <button
          type="button"
          onClick={() => setFotoGrande((v) => !v)}
          aria-pressed={fotoGrande}
          aria-label={fotoGrande ? "Achicar la foto" : "Ampliar la foto"}
          className={cn(
            "overflow-hidden rounded-[10px] border bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            fotoGrande ? "h-[360px] cursor-zoom-out" : "h-[180px] cursor-zoom-in",
          )}
        >
          <img src={foto} alt="Foto adjunta al aviso" className="size-full object-cover" />
        </button>
      ) : null}

      <dl className="flex flex-col rounded-lg border bg-card">
        {detalle.map((d) => (
          <div key={d.k} className="flex flex-col gap-0.5 border-b px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{d.k}</dt>
            <dd className="text-sm">{d.v}</dd>
          </div>
        ))}
        {fichas.map((ficha) => (
          <Link
            key={ficha.to}
            to={ficha.to}
            className="flex min-h-11 items-center justify-between border-b px-3 text-sm font-semibold text-primary last:border-b-0 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            {ficha.label}
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
        ))}
      </dl>

      {/* El rastro: marcado visto queda con su hora y no se borra. */}
      {aviso.read_at ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-success bg-success/10 p-3 text-sm font-semibold"
        >
          <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
          <span>
            Marcado como visto · {formatClockTime(aviso.read_at)}. Salió de los avisos sin leer y queda en el
            historial de Ajustes › Notificaciones.
          </span>
        </p>
      ) : null}

      {aviso.resolved_at ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-success bg-success/10 p-3 text-sm font-semibold"
        >
          <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
          <span>
            Resuelto{aviso.resolved_by_name ? ` por ${aviso.resolved_by_name}` : ""} ·{" "}
            {formatClockTime(aviso.resolved_at)}. Salió de Hoy › Requiere tu atención.
          </span>
        </p>
      ) : null}

      {marcar.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(marcar.error)}
        </p>
      ) : null}

      {/* En el celular las acciones van fijas sobre la barra inferior (56 px
          + la raya de inicio); este hueco es lo que miden, para que el
          detalle no quede tapado. En el escritorio van en el flujo. */}
      <div aria-hidden="true" className="h-32 md:hidden" />
      <div
        className={cn(
          "fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 flex flex-col gap-1.5 border-t bg-card px-3.5 py-2.5",
          "md:static md:rounded-lg md:border md:px-3",
        )}
      >
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => marcar.mutate()}
            disabled={aviso.read_at !== null || marcar.isPending}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-[52px] rounded-[10px] px-4 text-[0.9375rem] font-semibold",
            )}
          >
            {aviso.read_at ? "Visto" : "Marcar como visto"}
          </button>
          <Link
            to={destino.to}
            // El destino se nombra entero («Inventario › Conteo por área»): si
            // no entra en un renglón, parte en dos antes que recortarse.
            className={cn(
              buttonVariants(),
              "h-[52px] min-w-0 flex-1 rounded-[10px] px-3 text-center text-[0.9375rem] leading-tight font-bold whitespace-normal",
            )}
          >
            Resolver en {destino.donde}
          </Link>
        </div>
        <p className="text-center text-[11px] text-muted-foreground">
          Marcar como visto no resuelve el hecho. Allá cada acción queda a tu nombre con la hora y se reversa
          con motivo; nada se borra.
        </p>
      </div>
    </article>
  );
}
