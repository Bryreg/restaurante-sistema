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
import {
  ConsequenceZone,
  DenseTable,
  DenseTableBar,
  type DenseColumn,
} from "@/components/admin";
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
import { errorMessage } from "@/lib/errors";

import { CHANNELS, StoreFormDialog } from "./StoreFormDialog";

/**
 * **La celda escribe la palabra del negocio, no el enum** (patrón 8c): la
 * columna decía `counter, dine_in, takeout`. El catálogo es el mismo que usa
 * el formulario de la sede — una sola fuente, para que no haya dos listas de
 * canales que se puedan desincronizar.
 */
const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(
  CHANNELS.map((channel) => [channel.value, channel.label]),
);

export function StoresSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-stores"], queryFn: listStores });
  const [editingStore, setEditingStore] = useState<StoreOut | "new" | null>(null);
  /** La sede elegida para rotar: **todavía no abre el teclado**, abre la zona. */
  const [rotatingStore, setRotatingStore] = useState<StoreOut | null>(null);
  /** Y recién con la zona confirmada se pide el PIN nuevo. */
  const [pinPadFor, setPinPadFor] = useState<StoreOut | null>(null);
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
    if (!pinPadFor) return;
    setRotateError(null);
    try {
      await rotateStorePin(pinPadFor.id, pin);
      setPinPadFor(null);
      setRotatingStore(null);
    } catch (err) {
      setRotateError(errorMessage(err));
    }
  }

  const stores = query.data ?? [];
  const activas = stores.filter((store) => store.active).length;

  const columns: readonly DenseColumn<StoreOut>[] = [
    { key: "name", header: "Sede", kind: "name", cell: (store) => store.name },
    {
      key: "nit",
      header: "NIT",
      kind: "id",
      cell: (store) => (store.nit ? `${store.nit}-${store.dv ?? "—"}` : "—"),
    },
    { key: "municipality", header: "Municipio", kind: "secondary", cell: (store) => store.municipality_dane ?? "—" },
    { key: "cutoff", header: "Corte", kind: "number", widthPx: 70, cell: (store) => `${store.cutoff_hour}:00` },
    {
      key: "channels",
      header: "Canales",
      kind: "secondary",
      cell: (store) =>
        store.active_channels.length > 0
          ? store.active_channels.map((channel) => CHANNEL_LABEL[channel] ?? channel).join(" · ")
          : "—",
    },
    { key: "active", header: "Activa", widthPx: 70, cell: (store) => (store.active ? "Sí" : "No") },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (store) => (
        <span className="flex justify-end gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditingStore(store)}>
            Editar
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => {
              setRotateError(null);
              setRotatingStore(store);
            }}
          >
            <KeyRound className="size-4" aria-hidden="true" />
            Rotar PIN
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {/* Patrón 11 · zona ROJA: el PIN nuevo no se vuelve a mostrar. El marco
          avisa; el botón es azul y secundario. Aparece cuando se elige una
          sede, con su nombre adentro: una zona de riesgo genérica no dice a
          qué sede le va a cambiar el PIN. */}
      {rotatingStore ? (
        <ConsequenceZone
          level="irreversible"
          scope={rotatingStore.name}
          explanation="Cambia el PIN de 6 dígitos con el que se activan dispositivos nuevos. El PIN nuevo se muestra una sola vez, cuando lo tecleás: no se vuelve a mostrar ni se puede recuperar."
          action={{
            label: "Rotar el PIN…",
            confirmTitle: `Rotar el PIN de ${rotatingStore.name}`,
            consequences: [
              "Los dispositivos ya activados siguen vendiendo: esto no desconecta el salón.",
              "Para activar una tablet nueva va a hacer falta el PIN nuevo, y el viejo deja de servir en ese momento.",
              "El PIN nuevo no se vuelve a mostrar: si se pierde, hay que rotarlo otra vez.",
              "Queda registrado en Historial con quién lo hizo y cuándo.",
            ],
            onClick: () => setPinPadFor(rotatingStore),
          }}
        >
          <Button type="button" variant="ghost" onClick={() => setRotatingStore(null)}>
            Dejar el PIN como está
          </Button>
        </ConsequenceZone>
      ) : null}

      {query.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : query.isError ? (
        <EmptyState
          role="alert"
          reason="error"
          title="No se pudieron cargar las sedes"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <DenseTable
          caption="Sedes de la organización"
          columns={columns}
          rows={stores}
          rowKey={(store) => String(store.id)}
          rowStatus={(store) => (store.active ? "ok" : "none")}
          rowInactive={(store) => !store.active}
          bar={
            <DenseTableBar
              shown={stores.length}
              total={stores.length}
              noun="sedes"
              hidden={stores.length > activas ? `${stores.length - activas} inactivas` : undefined}
            >
              <Button type="button" className="gap-2" onClick={() => setEditingStore("new")}>
                <Plus className="size-4" aria-hidden="true" />
                Nueva sede
              </Button>
            </DenseTableBar>
          }
          legend={[
            {
              term: "La hora de corte",
              meaning:
                "decide a qué día operativo pertenece una venta. Un corte a las 7 de la mañana es lo que evita que la madrugada del sábado caiga en el domingo.",
            },
            {
              term: "Los canales activos",
              meaning:
                "son los que el salón puede usar en esta sede. Se eligen acá, no en Canales: allá se configuran las plataformas.",
            },
            {
              term: "El PIN de sede no es el PIN de nadie",
              meaning:
                "activa dispositivos; el PIN personal de 4 dígitos identifica a una persona y vive en Empleados.",
            },
          ]}
          empty={
            <EmptyState
              title="Todavía no hay sedes"
              description="Creá la primera sede para empezar: casi toda pantalla del admin necesita una sede activa para poder preguntar algo."
              action={{ label: "Nueva sede", onClick: () => setEditingStore("new") }}
            />
          }
        />
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
        open={pinPadFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPinPadFor(null);
            setRotateError(null);
          }
        }}
      >
        <DialogContent className="flex flex-col items-center gap-4">
          <DialogHeader>
            <DialogTitle>Rotar PIN de {pinPadFor?.name}</DialogTitle>
            <DialogDescription>Los dispositivos activados con el PIN anterior seguirán funcionando.</DialogDescription>
          </DialogHeader>
          <PinPad length={6} label="Nuevo PIN de sede" onSubmit={handleRotatePin} errorMessage={rotateError} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
