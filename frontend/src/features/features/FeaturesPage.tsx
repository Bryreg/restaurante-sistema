import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useStoreSelection } from "@/app/storeContext";
import { listFeatures, setFeature, setProfile, type Feature, type Profile } from "@/api/features";
import { getOrganization } from "@/api/stores";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ConsequenceZone,
  DenseTable,
  DenseTableBar,
  PageHeader,
  type DenseColumn,
} from "@/components/admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/errors";

const PROFILE_LABEL: Record<Profile, string> = {
  basic: "Básico",
  standard: "Estándar",
  full: "Full",
};

const SOURCE_LABEL: Record<Feature["source"], string> = {
  org: "Organización",
  store_override: "Override de sede",
  profile_default: "Default del perfil",
};

/**
 * **Qué se lleva puesto apagar una función.** El inventario de controles lo
 * dice en una línea: la entrada de navegación desaparece con el flag, el
 * backend contesta `400 FEATURE_DISABLED` a lo que llegue igual, y **la URL
 * sobrevive** —el marcador del dueño y los avisos de Hoy siguen apuntando
 * ahí—. Eso es lo que la confirmación tiene que enumerar, y no «¿estás
 * seguro?» (`docs/PATRONES-ADMIN.md` § 11).
 */
function consecuenciasDeApagar(
  feature: Feature,
  alcance: string,
  dependientes: readonly string[],
): readonly [string, ...string[]] {
  const lista: string[] = [
    `La entrada de navegación desaparece para todos los que usen ${alcance}, en el salón y en el escritorio.`,
    `Lo que ya esté abierto deja de funcionar: el servidor contesta 400 FEATURE_DISABLED a lo que llegue igual.`,
    `La URL sigue existiendo: quien tenga la pantalla en un marcador va a ver el vacío que explica que «${feature.description}» está apagada, con el camino para volver a encenderla.`,
  ];
  if (dependientes.length > 0) {
    lista.push(
      `Se apaga también lo que depende de esta: ${dependientes.join(", ")}.`,
    );
  }
  lista.push("Nada de lo ya registrado se borra: lo que se apagó se vuelve a encender acá mismo.");
  return lista as unknown as readonly [string, ...string[]];
}

export default function FeaturesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { stores } = useStoreSelection();
  const [scope, setScope] = useState<"org" | number>("org");
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
  const [pendingOff, setPendingOff] = useState<Feature | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const storeIdForScope = scope === "org" ? null : scope;

  const organizationQuery = useQuery({
    queryKey: ["admin-organization"],
    queryFn: getOrganization,
  });
  const featuresQuery = useQuery({
    queryKey: ["admin-features", storeIdForScope],
    queryFn: () => listFeatures(storeIdForScope),
  });

  async function refetchAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-organization"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-features"] }),
    ]);
  }

  async function applyToggle(feature: Feature, enabled: boolean) {
    setMutationError(null);
    try {
      await setFeature(feature.key, { enabled, store_id: storeIdForScope ?? undefined });
      await refetchAll();
    } catch (err) {
      setMutationError(errorMessage(err));
    }
  }

  /**
   * Encender es aditivo y se aplica de una. **Apagar no**: apaga una
   * capacidad de todo el restaurante con un toque, y hasta el rediseño no
   * confirmaba nada —el único diálogo de esta pantalla estaba atado al cambio
   * de perfil—. Así que apagar pasa por la zona de consecuencia: el
   * interruptor no miente, se queda como está hasta que la zona confirma.
   */
  function handleToggle(feature: Feature, enabled: boolean) {
    if (enabled) {
      void applyToggle(feature, true);
      return;
    }
    setMutationError(null);
    setPendingOff(feature);
  }

  async function confirmProfile() {
    if (!pendingProfile) return;
    setMutationError(null);
    try {
      await setProfile(pendingProfile);
      await refetchAll();
    } catch (err) {
      setMutationError(errorMessage(err));
    } finally {
      setPendingProfile(null);
    }
  }

  const organization = organizationQuery.data;
  const features = featuresQuery.data ?? [];
  const encendidas = features.filter((f) => f.enabled).length;
  const scopeLabel =
    scope === "org" ? "toda la organización" : `la sede ${stores.find((s) => s.id === scope)?.name ?? ""}`.trim();
  /**
   * El nombre corto de una función para el botón: la descripción entera
   * («Mapa de mesas: unir y mover mesas, comensales por mesa») convierte el
   * botón en un párrafo. La descripción completa sigue estando en el marco y
   * en la confirmación.
   */
  const nombreCorto = (feature: Feature): string => feature.description.split(/[:(—]/)[0].trim();

  const dependientes = pendingOff
    ? features.filter((f) => f.enabled && f.requires.includes(pendingOff.key)).map((f) => f.key)
    : [];

  const columns: readonly DenseColumn<Feature>[] = [
    {
      key: "state",
      header: "Estado",
      widthPx: 64,
      cell: (feature) => (
        <Switch
          checked={feature.enabled}
          aria-label={`${feature.enabled ? "Apagar" : "Encender"} ${feature.key}`}
          onCheckedChange={(next) => handleToggle(feature, next)}
        />
      ),
    },
    // La clave va como texto pelado de la celda, sin envoltorio: es lo que
    // deja identificar la fila de una función desde afuera (y lo que el test
    // de esta pantalla busca como `TD`).
    { key: "key", header: "Clave", kind: "name", cell: (feature) => feature.key },
    {
      key: "description",
      header: "Qué habilita",
      // La descripción larga se corta con puntos suspensivos y **el texto
      // entero vive en el `title`**: es la misma salida que el patrón le dio
      // a la columna «Desde» de Inventario. Sin esto la columna se lleva
      // 728 px de 1003 y empuja Origen, Dependencias y Desde fuera de la
      // pantalla a 1280 (medido).
      cell: (feature) => <span className="block max-w-[430px] truncate">{feature.description}</span>,
      cellTitle: (feature) => feature.description,
    },
    {
      key: "source",
      header: "Origen",
      cell: (feature) => (
        <Badge variant="secondary" className="font-normal">
          {SOURCE_LABEL[feature.source]}
        </Badge>
      ),
    },
    {
      key: "requires",
      header: "Dependencias",
      kind: "secondary",
      // Detrás de «Más columnas» (mapa de pantallas, regla 3), igual que
      // «Desde»: la zona de consecuencia ya nombra lo que se apaga en cadena.
      secondary: true,
      // En una sola línea y sin envolver: dos pastillas apiladas hacían
      // crecer la fila de 34 a 40 px, que es la regla dura del patrón 8.
      cell: (feature) =>
        feature.requires.length > 0 ? (
          <span className="block max-w-[140px] truncate font-mono text-[0.72rem]">
            {feature.requires.join(" · ")}
          </span>
        ) : (
          "—"
        ),
      cellTitle: (feature) => (feature.requires.length > 0 ? feature.requires.join(" · ") : undefined),
    },
    { key: "phase", header: "Desde", kind: "secondary", secondary: true, widthPx: 70, cell: (feature) => feature.available_from_phase },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        name="Funciones"
        question="¿Qué usa este restaurante de todo lo que el producto sabe hacer — y qué desaparece de las pantallas el día que se apaga?"
        context={[
          { label: "Perfil", value: organization ? PROFILE_LABEL[organization.profile] : "—" },
          {
            label: "Encendidas",
            value: features.length > 0 ? `${encendidas} de ${features.length}` : "—",
            title: "Contadas sobre el alcance que estás editando.",
          },
          { label: "Editando", value: scope === "org" ? "Toda la organización" : scopeLabel },
        ]}
        actions={
          <Select
            value={pendingProfile ?? undefined}
            onValueChange={(next) => setPendingProfile(next as Profile)}
          >
            <SelectTrigger className="h-10 w-44" aria-label="Elegir perfil">
              <SelectValue placeholder="Elegir perfil…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="basic">Básico</SelectItem>
              <SelectItem value="standard">Estándar</SelectItem>
              <SelectItem value="full">Full</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <AlertDialog open={pendingProfile !== null} onOpenChange={(open) => !open && setPendingProfile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cambiar el perfil a {pendingProfile ? PROFILE_LABEL[pendingProfile] : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              Esto reinicia los flags de toda la organización a los defaults de ese perfil. Los
              overrides por sede no se tocan. Queda registrado en el historial.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmProfile()}>Confirmar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Patrón 11 · zona ROJA. Apagar una función no se deshace solo: hasta
          que alguien vuelva acá, la capacidad no existe para nadie. El
          peligro va en el MARCO; el botón sigue siendo azul y secundario,
          para que no sea lo más fácil de pulsar. */}
      {pendingOff ? (
        <ConsequenceZone
          level="irreversible"
          title="Vas a apagar una función"
          scope={scope === "org" ? "Toda la organización" : scopeLabel}
          explanation={
            <>
              «{pendingOff.description}» ({pendingOff.key}) se apaga para {scopeLabel}. El interruptor no se
              movió todavía: se mueve cuando confirmes acá.
            </>
          }
          action={{
            label: `Apagar «${nombreCorto(pendingOff)}»`,
            confirmTitle: `Apagar «${nombreCorto(pendingOff)}» (${pendingOff.key})`,
            consequences: consecuenciasDeApagar(pendingOff, scopeLabel, dependientes),
            onClick: () => {
              const feature = pendingOff;
              setPendingOff(null);
              void applyToggle(feature, false);
            },
          }}
        >
          <Button type="button" variant="ghost" onClick={() => setPendingOff(null)}>
            Dejarla encendida
          </Button>
        </ConsequenceZone>
      ) : null}

      {mutationError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {mutationError}
        </p>
      ) : null}

      {featuresQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : featuresQuery.isError ? (
        <EmptyState
          role="alert"
          reason="error"
          title="No se pudieron cargar las funciones"
          description={errorMessage(featuresQuery.error)}
          action={{ label: "Reintentar", onClick: () => void featuresQuery.refetch() }}
        />
      ) : (
        <DenseTable
          caption="Funciones del restaurante, con su estado, su origen y sus dependencias"
          columns={columns}
          rows={features}
          rowKey={(feature) => feature.key}
          // 45 funciones: la cabecera se queda fija dentro de la tabla.
          maxBodyHeightPx={560}
          rowStatus={(feature) => (feature.enabled ? "ok" : "none")}
          rowInactive={(feature) => !feature.enabled}
          bar={
            <DenseTableBar
              shown={features.length}
              total={features.length}
              noun="funciones"
              hidden={features.length > 0 ? `${encendidas} encendidas · ${features.length - encendidas} apagadas` : undefined}
            >
              <span className="text-xs text-muted-foreground">Editando:</span>
              <Select
                value={String(scope)}
                onValueChange={(next) => setScope(next === "org" ? "org" : Number(next))}
              >
                <SelectTrigger className="h-9 w-56" aria-label="Alcance de la edición">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org">Toda la organización</SelectItem>
                  {stores.map((store) => (
                    <SelectItem key={store.id} value={String(store.id)}>
                      Override de {store.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DenseTableBar>
          }
          legend={[
            {
              term: "Origen",
              meaning:
                "quién decide el estado, y en ese orden: la sede se aparta de la organización, la organización se aparta del perfil, y «default» quiere decir que nadie la tocó —así que cambia sola si cambia el perfil—.",
            },
            {
              term: "Dependencias",
              meaning:
                "lo que esta función necesita encendido. No es una sugerencia: el servidor rechaza encenderla sin ellas.",
            },
            {
              term: "Apagada no es borrada",
              meaning:
                "una función apagada conserva todo lo registrado; lo que desaparece es la entrada de navegación y el permiso del servidor.",
            },
          ]}
          note={
            <>
              Encender se aplica de una. <b className="font-bold text-foreground">Apagar pide confirmación</b>: una
              función apagada desaparece de la navegación de todos y el servidor empieza a contestar{" "}
              <code className="font-mono">400 FEATURE_DISABLED</code>.
            </>
          }
          empty={<EmptyState title="Todavía no hay funciones para mostrar" />}
        />
      )}
    </div>
  );
}
