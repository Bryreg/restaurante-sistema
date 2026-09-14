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
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

export default function FeaturesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { stores } = useStoreSelection();
  const [scope, setScope] = useState<"org" | number>("org");
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
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

  async function handleToggle(feature: Feature, enabled: boolean) {
    setMutationError(null);
    try {
      await setFeature(feature.key, { enabled, store_id: storeIdForScope ?? undefined });
      await refetchAll();
    } catch (err) {
      setMutationError(errorMessage(err));
    }
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Funciones</h1>
          <p className="text-sm text-muted-foreground">
            Qué usa este restaurante. Perfil actual:{" "}
            {organization ? (
              <span className="font-medium text-foreground">{PROFILE_LABEL[organization.profile]}</span>
            ) : (
              "—"
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

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

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Editando:</span>
        <Select value={String(scope)} onValueChange={(next) => setScope(next === "org" ? "org" : Number(next))}>
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
      </div>

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
          title="No se pudieron cargar las funciones"
          description={errorMessage(featuresQuery.error)}
          action={{ label: "Reintentar", onClick: () => void featuresQuery.refetch() }}
        />
      ) : features.length === 0 ? (
        <EmptyState title="Todavía no hay funciones para mostrar" />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Clave</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Origen</TableHead>
                <TableHead>Dependencias</TableHead>
                <TableHead>Desde</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {features.map((feature) => (
                <TableRow key={feature.key}>
                  <TableCell className="font-mono text-xs">{feature.key}</TableCell>
                  <TableCell>{feature.description}</TableCell>
                  <TableCell>
                    <Switch
                      checked={feature.enabled}
                      aria-label={`${feature.enabled ? "Apagar" : "Encender"} ${feature.key}`}
                      onCheckedChange={(next) => void handleToggle(feature, next)}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{SOURCE_LABEL[feature.source]}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {feature.requires.length > 0 ? feature.requires.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{feature.available_from_phase}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
