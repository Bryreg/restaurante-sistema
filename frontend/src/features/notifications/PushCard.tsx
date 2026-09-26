import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  getPushPublicKey,
  listPushDevices,
  sendPushTest,
  subscribePush,
  unsubscribePush,
  type PushDevice,
} from "@/api/notifications";
import { FormSection, TimeAgo } from "@/components/admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

import {
  currentSubscription,
  disablePushInThisBrowser,
  enablePushInThisBrowser,
  notificationPermission,
  pushSupport,
  type PushSupport,
} from "./pushBrowser";

const DEVICES_KEY = ["admin-push-devices"] as const;

function estadoDeEsteCelular(support: PushSupport, permission: string, activeHere: boolean): string {
  if (support === "needs-install") {
    return "En este iPhone los avisos se activan desde el ícono de la pantalla de inicio (mirá los pasos de abajo).";
  }
  if (support === "insecure") return "Los avisos sólo funcionan con la dirección segura del sistema (https).";
  if (support === "unsupported") {
    return "Este navegador no puede recibir avisos. Usá Chrome o Firefox en Android, o Safari en iPhone agregado a inicio.";
  }
  if (permission === "denied") {
    return "Este navegador tiene los avisos bloqueados para el sistema: habilitalos en sus ajustes y volvé a activar.";
  }
  return activeHere ? "Este celular recibe los avisos graves." : "Este celular todavía no recibe avisos.";
}

/**
 * **Avisos al celular** (función `notifications.push`): lo grave —turno
 * abandonado, anulaciones fuera de lo habitual, plata de la base sin
 * devolver, faltante grande del conteo y diferencia crítica de caja— llega
 * al teléfono aunque el admin esté cerrado. Cada persona activa los suyos.
 */
export function PushCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: listPushDevices });
  const [support] = useState<PushSupport>(() => pushSupport());
  const [permission, setPermission] = useState<string>(() => notificationPermission());
  const [hereEndpoint, setHereEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"activate" | "test" | number | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    currentSubscription()
      .then((sub) => {
        if (alive) setHereEndpoint(sub?.endpoint ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const list = devices.data ?? [];
  const activeHere = hereEndpoint !== null && list.some((d) => d.endpoint === hereEndpoint);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
  }

  async function handleActivate() {
    setBusy("activate");
    setMessage(null);
    try {
      const { public_key } = await getPushPublicKey();
      const subscription = await enablePushInThisBrowser(public_key);
      await subscribePush(subscription);
      setHereEndpoint(subscription.endpoint);
      setMessage({ tone: "ok", text: "Listo: este celular va a recibir los avisos graves. Probalo con «Enviar aviso de prueba»." });
      await refresh();
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setPermission(notificationPermission());
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    setMessage(null);
    try {
      const r = await sendPushTest();
      const partes = [`${r.sent} ${r.sent === 1 ? "enviado" : "enviados"}`];
      if (r.failed > 0) partes.push(`${r.failed} con falla (se reintenta en el próximo aviso)`);
      if (r.removed > 0) partes.push(`${r.removed} ya no ${r.removed === 1 ? "existía y se quitó" : "existían y se quitaron"}`);
      setMessage({ tone: r.sent > 0 ? "ok" : "error", text: `Aviso de prueba: ${partes.join(", ")}.` });
      await refresh();
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(device: PushDevice) {
    setBusy(device.id);
    setMessage(null);
    try {
      await unsubscribePush({ subscription_id: device.id });
      if (device.endpoint === hereEndpoint) {
        await disablePushInThisBrowser().catch(() => undefined);
        setHereEndpoint(null);
      }
      await refresh();
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  const puedeActivar = support === "supported" && permission !== "denied" && !activeHere;

  return (
    <FormSection
      title="Avisos al celular"
      columns="one"
      governs="Lo grave llega a tu teléfono aunque no tengas el sistema abierto: turno abandonado, anulaciones fuera de lo habitual, plata de la base sin devolver, faltante grande en un conteo y diferencia crítica de caja."
      reading={<span role="status">{estadoDeEsteCelular(support, permission, activeHere)}</span>}
      doesNotDo={
        <>
          En <b className="font-bold text-foreground">iPhone</b> (iOS 16.4 o más nuevo): abrí el sistema en Safari, tocá{" "}
          <b className="font-bold text-foreground">Compartir → Agregar a inicio</b>, abrí el sistema desde ese ícono y
          tocá «Activar en este celular». Los avisos no reemplazan la campana: todo sigue quedando en Recientes.
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {puedeActivar ? (
          <Button type="button" onClick={() => void handleActivate()} disabled={busy !== null}>
            {busy === "activate" ? "Activando…" : "Activar en este celular"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleTest()}
          disabled={busy !== null || list.length === 0}
        >
          {busy === "test" ? "Enviando…" : "Enviar aviso de prueba"}
        </Button>
      </div>

      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={message.tone === "error" ? "text-sm font-medium text-destructive" : "text-sm font-medium text-foreground"}
        >
          {message.text}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <h4 className="text-xs font-bold tracking-wider uppercase">Mis celulares</h4>
        {devices.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : devices.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(devices.error)}
          </p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ningún celular recibe avisos todavía.</p>
        ) : (
          <ul className="divide-y rounded-md border" aria-label="Mis celulares con avisos">
            {list.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="text-sm font-medium">{device.label}</span>
                {device.endpoint === hereEndpoint ? <Badge variant="secondary">Este celular</Badge> : null}
                <span className="text-xs text-muted-foreground" title={formatInstant(device.created_at)}>
                  activado <TimeAgo iso={device.created_at} />
                </span>
                {device.last_error ? (
                  <span className="text-xs text-destructive">Último envío con falla ({device.last_error})</span>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  aria-label={`Quitar ${device.label}`}
                  onClick={() => void handleRemove(device)}
                  disabled={busy !== null}
                >
                  Quitar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </FormSection>
  );
}
