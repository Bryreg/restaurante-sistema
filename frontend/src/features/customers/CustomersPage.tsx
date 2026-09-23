import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  addCustomerConsent,
  customerRequestsCsvUrl,
  customersCsvUrl,
  eraseCustomer,
  listCustomerRequests,
  listCustomers,
  patchCustomer,
  type ConsentIn,
  type ConsentPurpose,
  type CustomerOut,
  type CustomerPatchIn,
  type DataRequestOut,
} from "@/api/customers";
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  PageHeader,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

import { LocalCsvExportButton } from "./components";

/** La leyenda del pie: lo que habeas data separa a propósito. */
const CUSTOMERS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Anonimizado",
    meaning: (
      <>
        se ejerció el derecho de supresión: el cliente queda sin datos personales y <b>no se deshace</b>. El
        documento fiscal ya emitido conserva su copia exacta, porque es ley.
      </>
    ),
  },
  {
    term: "Autorización",
    meaning:
      "cada finalidad —facturación, mercadeo— se autoriza por separado y queda con su canal, su fecha y la versión del texto. Registrar una nueva nunca edita la anterior.",
  },
];

const REQUEST_KIND_LABEL: Record<string, string> = {
  access: "Consulta",
  rectify: "Rectificación",
  revoke: "Revocación",
  erase: "Supresión",
};

/**
 * anonimiza el maestro y deja intacto el documento fiscal — con estas
 * palabras exactas, en el diálogo de confirmación (mandato del Maestro).
 */
const ERASE_EXPLANATION =
  "Esto anonimiza el maestro y deja intacto el documento fiscal: los datos de este cliente en el sistema se reemplazan por un marcador genérico, pero cada comprobante ya emitido conserva su copia exacta del nombre y el documento — un documento fiscal expedido es inmutable y no se puede tocar. Esta acción no se puede deshacer.";

function EraseCustomerAction({ customer }: { customer: CustomerOut }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: () => eraseCustomer(customer.id, { reason: reason.trim() }),
    onSuccess: () => {
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
  });

  if (customer.erased_at) {
    return <Badge variant="outline">Anonimizado el {formatInstant(customer.erased_at)}</Badge>;
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button type="button" variant="destructive" size="sm" />}>
        Anonimizar (habeas data)
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Anonimizar a {customer.name ?? "este cliente"}</AlertDialogTitle>
          <AlertDialogDescription>{ERASE_EXPLANATION}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label htmlFor={`erase-reason-${customer.id}`}>Motivo de la solicitud</Label>
          <Textarea
            id={`erase-reason-${customer.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={reason.trim() === "" || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Anonimizando…" : "Anonimizar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConsentForm({ customer }: { customer: CustomerOut }) {
  const [purpose, setPurpose] = useState<ConsentPurpose>("invoice");
  const [granted, setGranted] = useState(true);
  const [channel, setChannel] = useState("");
  const [textVersion, setTextVersion] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      const body: ConsentIn = { purpose, granted, channel: channel.trim(), text_version: textVersion.trim() };
      return addCustomerConsent(customer.id, body);
    },
    onSuccess: () => {
      setChannel("");
      setTextVersion("");
    },
  });

  const canSubmit = channel.trim() !== "" && textVersion.trim() !== "";

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Registrar consentimiento</p>
      <p className="text-xs text-muted-foreground">
        Nunca edita uno anterior: cada registro (incluida una revocación) queda como evidencia nueva, con
        fecha y canal.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`consent-purpose-${customer.id}`}>Finalidad</Label>
          <Select value={purpose} onValueChange={(v) => setPurpose(v as ConsentPurpose)}>
            <SelectTrigger id={`consent-purpose-${customer.id}`} className="h-10 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="invoice">Facturación</SelectItem>
              <SelectItem value="marketing">Mercadeo</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`consent-granted-${customer.id}`}
            checked={granted}
            onCheckedChange={(checked) => setGranted(checked === true)}
          />
          <Label htmlFor={`consent-granted-${customer.id}`}>Autoriza</Label>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`consent-channel-${customer.id}`}>Canal</Label>
          <Input
            id={`consent-channel-${customer.id}`}
            className="h-10 w-32"
            placeholder="pos, whatsapp…"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`consent-text-${customer.id}`}>Versión del texto</Label>
          <Input
            id={`consent-text-${customer.id}`}
            className="h-10 w-32"
            placeholder="v1"
            value={textVersion}
            onChange={(e) => setTextVersion(e.target.value)}
          />
        </div>
        <Button
          type="button"
          className="h-10"
          disabled={!canSubmit || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Guardando…" : "Registrar"}
        </Button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {mutation.isSuccess ? (
        <p className="text-sm text-muted-foreground">Consentimiento registrado.</p>
      ) : null}
    </div>
  );
}

function RequestsLog({ customer }: { customer: CustomerOut }) {
  const query = useQuery({
    queryKey: ["customer-requests", customer.id],
    queryFn: () => listCustomerRequests(customer.id),
  });
  const rows: DataRequestOut[] = query.data ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Bitácora de habeas data</p>
        <LocalCsvExportButton href={customerRequestsCsvUrl(customer.id)} label="CSV" />
      </div>
      {query.isLoading ? (
        <Cargando texto="Cargando…" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin solicitudes registradas.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex justify-between gap-2">
              <span>
                {row.kind ? (REQUEST_KIND_LABEL[row.kind] ?? row.kind) : "—"}
                {row.note ? ` — ${row.note}` : ""}
              </span>
              <span className="text-xs text-muted-foreground">{formatInstant(row.requested_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CustomerDetailDialog({
  customer,
  onOpenChange,
}: {
  customer: CustomerOut | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomerPatchIn>({});

  const patchMutation = useMutation({
    mutationFn: (payload: CustomerPatchIn) => patchCustomer((customer as CustomerOut).id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
  });

  if (!customer) return null;

  const erased = customer.erased_at != null;
  const current = {
    name: form.name ?? customer.name ?? "",
    email: form.email ?? customer.email ?? "",
    address: form.address ?? customer.address ?? "",
    municipality_dane: form.municipality_dane ?? customer.municipality_dane ?? "",
    dv: form.dv ?? customer.dv ?? "",
  };

  return (
    <Dialog open={customer !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{customer.name ?? "Cliente"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {customer.doc_type ?? "Doc."} {customer.doc_number ?? "—"}
            {customer.dv ? `-${customer.dv}` : ""}
          </p>

          {erased ? (
            <p role="status" className="text-sm text-muted-foreground">
              Este cliente está anonimizado. Sus datos ya no se pueden corregir ni recibir consentimientos
              nuevos; los documentos fiscales que ya se emitieron a su nombre conservan su copia exacta, sin
              cambios.
            </p>
          ) : (
            <div className="space-y-2 rounded-md border p-3">
              <p className="font-medium">Corregir datos</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="customer-name">Nombre</Label>
                  <Input
                    id="customer-name"
                    className="h-10"
                    value={current.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="customer-dv">DV</Label>
                  <Input
                    id="customer-dv"
                    className="h-10"
                    value={current.dv}
                    onChange={(e) => setForm((f) => ({ ...f, dv: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="customer-email">Correo</Label>
                  <Input
                    id="customer-email"
                    type="email"
                    className="h-10"
                    value={current.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="customer-municipality">Municipio (DANE)</Label>
                  <Input
                    id="customer-municipality"
                    className="h-10"
                    value={current.municipality_dane}
                    onChange={(e) => setForm((f) => ({ ...f, municipality_dane: e.target.value }))}
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="customer-address">Dirección</Label>
                  <Input
                    id="customer-address"
                    className="h-10"
                    value={current.address}
                    onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  />
                </div>
              </div>
              {patchMutation.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(patchMutation.error)}
                </p>
              ) : null}
              <Button
                type="button"
                className="h-10"
                disabled={patchMutation.isPending}
                onClick={() => patchMutation.mutate(form)}
              >
                {patchMutation.isPending ? "Guardando…" : "Guardar"}
              </Button>
            </div>
          )}

          {!erased ? <ConsentForm customer={customer} /> : null}

          <RequestsLog customer={customer} />

          <div className="flex justify-end border-t pt-3">
            <EraseCustomerAction customer={customer} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin → Clientes (SPEC-NEGOCIO §8.4, Ley 1581 de 2012; `spec.md` "API
 * contract → Customers"): `GET /admin/customers?doc_number=`,
 * `PATCH /admin/customers/{id}`, `POST /admin/customers/{id}/consents`,
 * `GET /admin/customers/{id}/requests`, `POST /admin/customers/{id}/erase`.
 * Detrás de la flag `customers` (gate en el backend; acá gatea la entrada
 * de navegación — `customersFeature.adminNav`).
 */
export function CustomersPage(): React.JSX.Element {
  const [docNumber, setDocNumber] = useState("");
  const [appliedDocNumber, setAppliedDocNumber] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<CustomerOut | null>(null);

  const query = useQuery({
    queryKey: ["customers", appliedDocNumber],
    queryFn: () => listCustomers({ docNumber: appliedDocNumber }),
  });

  const rows = query.data ?? [];

  const search = (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="customers-doc-number">Número de documento</Label>
        <Input
          id="customers-doc-number"
          className="h-8 w-44"
          value={docNumber}
          onChange={(e) => setDocNumber(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setAppliedDocNumber(docNumber.trim() || undefined);
          }}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setAppliedDocNumber(docNumber.trim() || undefined)}
      >
        Buscar
      </Button>
      {/* «Limpiar» sólo existe si hay un filtro puesto: el control que
          aparece y desaparece con el estado es de los que un rediseño pierde
          más fácil (`docs/INVENTARIO-CONTROLES.md` § 18). */}
      {appliedDocNumber ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDocNumber("");
            setAppliedDocNumber(undefined);
          }}
        >
          Limpiar
        </Button>
      ) : null}
      <LocalCsvExportButton href={customersCsvUrl({ docNumber: appliedDocNumber })} />
    </>
  );

  const columns: readonly DenseColumn<CustomerOut>[] = [
    {
      key: "doc",
      header: "Documento",
      kind: "id",
      cell: (c) => `${c.doc_type ?? "—"} ${c.doc_number ?? "—"}`,
    },
    {
      key: "name",
      header: "Nombre",
      kind: "name",
      cell: (c) => (
        <button
          type="button"
          onClick={() => setSelected(c)}
          className="rounded text-left font-bold underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {c.name ?? "—"}
        </button>
      ),
    },
    { key: "email", header: "Correo", cell: (c) => c.email ?? "—" },
    { key: "municipality", header: "Municipio", cell: (c) => c.municipality_dane ?? "—" },
    {
      key: "state",
      header: "Estado",
      cell: (c) => (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={
              c.erased_at ? "size-1.5 rounded-full bg-muted-foreground" : "size-1.5 rounded-full bg-success"
            }
            aria-hidden="true"
          />
          {c.erased_at ? "Anonimizado" : "Activo"}
        </span>
      ),
    },
    {
      key: "detail",
      header: "",
      kind: "actions",
      cell: (c) => (
        <button
          type="button"
          onClick={() => setSelected(c)}
          className="rounded text-xs whitespace-nowrap text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Ver detalle →
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        name="Clientes"
        question="Quién nos dio sus datos, con qué finalidad los autorizó, y cómo se ejercen sus derechos."
        context={
          query.isSuccess
            ? [
                { label: "Clientes", value: rows.length },
                { label: "Anonimizados", value: rows.filter((c) => c.erased_at).length },
              ]
            : undefined
        }
      />

      <p className="max-w-[80ch] text-sm text-muted-foreground">
        El dispositivo sólo los crea al cobrar; acá se administran, se corrigen y se ejercen los derechos de
        habeas data.
      </p>

      {query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los clientes"
          description={errorMessage(query.error)}
        />
      ) : (
        <DenseTable
          caption="Clientes registrados"
          columns={columns}
          rows={rows}
          rowKey={(c) => String(c.id)}
          rowInactive={(c) => Boolean(c.erased_at)}
          legend={CUSTOMERS_LEGEND}
          bar={
            <DenseTableBar
              shown={rows.length}
              total={rows.length}
              noun="clientes"
              hidden={
                query.isLoading
                  ? "buscando…"
                  : appliedDocNumber
                    ? `filtrados por documento «${appliedDocNumber}»`
                    : undefined
              }
            >
              {search}
            </DenseTableBar>
          }
          note={
            <>
              Los datos de un cliente se guardan sólo con <b>finalidad declarada y prueba de autorización</b>{" "}
              (Ley 1581 de 2012). Anonimizar no borra el documento fiscal ya emitido: ése conserva su copia
              exacta.
            </>
          }
          empty={
            query.isLoading ? undefined : appliedDocNumber ? (
              <FilterEmptyState
                title="Ningún cliente coincide con esta búsqueda"
                filters={[`documento «${appliedDocNumber}»`]}
                onRemove={() => {
                  setDocNumber("");
                  setAppliedDocNumber(undefined);
                }}
              />
            ) : (
              <EmptyState
                title="Ningún cliente coincide con esta búsqueda"
                description="Los clientes se crean desde el dispositivo, al cobrar y pedir los datos para el documento."
              />
            )
          }
        />
      )}

      <CustomerDetailDialog
        key={selected?.id ?? "none"}
        customer={selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  );
}

export default CustomersPage;
