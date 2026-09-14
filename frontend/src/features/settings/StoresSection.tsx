import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";

import {
  createStore,
  listStores,
  rotateStorePin,
  updateStore,
  type StoreCreateIn,
  type StoreOut,
  type StoreUpdateIn,
} from "@/api/stores";
import { EmptyState } from "@/components/EmptyState";
import { PinPad } from "@/components/PinPad";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/errors";

import { StoreFormDialog } from "./StoreFormDialog";

export function StoresSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-stores"], queryFn: listStores });
  const [editingStore, setEditingStore] = useState<StoreOut | "new" | null>(null);
  const [rotatingStore, setRotatingStore] = useState<StoreOut | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  async function refetch() {
    await queryClient.invalidateQueries({ queryKey: ["admin-stores"] });
  }

  async function handleSubmit(values: StoreCreateIn | StoreUpdateIn) {
    setFormError(null);
    try {
      if (editingStore && editingStore !== "new") {
        await updateStore(editingStore.id, values as StoreUpdateIn);
      } else {
        await createStore(values as StoreCreateIn);
      }
      await refetch();
      setEditingStore(null);
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  async function handleRotatePin(pin: string) {
    if (!rotatingStore) return;
    setRotateError(null);
    try {
      await rotateStorePin(rotatingStore.id, pin);
      setRotatingStore(null);
    } catch (err) {
      setRotateError(errorMessage(err));
    }
  }

  const stores = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Sedes de la organización.</p>
        <Button type="button" className="gap-2" onClick={() => setEditingStore("new")}>
          <Plus className="size-4" aria-hidden="true" />
          Nueva sede
        </Button>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las sedes"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : stores.length === 0 ? (
        <EmptyState title="Todavía no hay sedes" description="Creá la primera sede para empezar." />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>NIT</TableHead>
                <TableHead>Municipio</TableHead>
                <TableHead>Corte</TableHead>
                <TableHead>Canales</TableHead>
                <TableHead>Activa</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((store) => (
                <TableRow key={store.id}>
                  <TableCell>{store.name}</TableCell>
                  <TableCell>
                    {store.nit ? `${store.nit}-${store.dv ?? "—"}` : "—"}
                  </TableCell>
                  <TableCell>{store.municipality_dane ?? "—"}</TableCell>
                  <TableCell>{store.cutoff_hour}:00</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {store.active_channels.length > 0 ? store.active_channels.join(", ") : "—"}
                  </TableCell>
                  <TableCell>{store.active ? "Sí" : "No"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button type="button" variant="outline" size="sm" onClick={() => setEditingStore(store)}>
                        Editar
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        onClick={() => setRotatingStore(store)}
                      >
                        <KeyRound className="size-4" aria-hidden="true" />
                        Rotar PIN
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <StoreFormDialog
        open={editingStore !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingStore(null);
            setFormError(null);
          }
        }}
        store={editingStore && editingStore !== "new" ? editingStore : undefined}
        onSubmit={handleSubmit}
        error={formError}
      />

      <Dialog
        open={rotatingStore !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRotatingStore(null);
            setRotateError(null);
          }
        }}
      >
        <DialogContent className="flex flex-col items-center gap-4">
          <DialogHeader>
            <DialogTitle>Rotar PIN de {rotatingStore?.name}</DialogTitle>
            <DialogDescription>Los dispositivos activados con el PIN anterior seguirán funcionando.</DialogDescription>
          </DialogHeader>
          <PinPad length={6} label="Nuevo PIN de sede" onSubmit={handleRotatePin} errorMessage={rotateError} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
