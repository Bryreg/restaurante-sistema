import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import { useStoreSelection } from "@/app/storeContext";
import { MasPestanas, PageHeader, ScopeDestinations, type ScopeDestination } from "@/components/admin";
import { PeopleSection } from "@/features/people/PeopleSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CashSection } from "./CashSection";
import { ChannelsSection } from "./ChannelsSection";
import { FiscalSection } from "./FiscalSection";
import { InventorySection } from "./InventorySection";
import { OrganizationSection } from "./OrganizationSection";
import { SalesSection } from "./SalesSection";
import { StoresSection } from "./StoresSection";
import { UvtSection } from "./UvtSection";
import { ZonesTablesSection } from "./ZonesTablesSection";

/**
 * Una pestaña de Ajustes: su rótulo, **la pregunta que contesta** (patrón 2)
 * y si lo que se toca ahí **sale de esta pantalla** (patrón 10: el punto
 * ámbar sobre las secciones que se salen).
 */
interface SettingsTab {
  value: string;
  /** El rótulo de la pestaña. No se renombra: hay marcadores y enlaces. */
  label: string;
  question: string;
  /**
   * Cambia pantallas del salón: la fila de pestañas lo marca con un punto, y
   * debajo de la sección activa se listan sus destinos.
   */
  leaks?: boolean;
  /** A dónde llega esta pestaña (patrón 10, el reverso de las marcas). */
  destinations?: readonly [ScopeDestination, ...ScopeDestination[]];
}

/**
 * **Las diez secciones, por tema.** Antes se dibujaban como un índice
 * vertical de cuatro grupos (`docs/PATRONES-ADMIN.md` § 1 y el desvío 1);
 * con «Orden y aire» quedan tres pestañas a la vista y las demás en «Más»
 * (ver `PRINCIPALES`). El agrupamiento sigue decidiendo el orden de «Más».
 */
const GROUPS: readonly { group: string; tabs: readonly SettingsTab[] }[] = [
  {
    group: "La organización",
    tabs: [
      {
        value: "organization",
        label: "Organización",
        question: "¿Cómo se llama el negocio en todo lo que el sistema imprime y exporta?",
      },
      {
        value: "stores",
        label: "Sedes",
        question:
          "¿Qué locales tiene el negocio, con qué datos fiscales facturan y con qué PIN se activan sus dispositivos?",
        leaks: true,
        destinations: [
          {
            screen: "Salón › Activar dispositivo",
            what: "El PIN de sede es el que se teclea para activar una tablet nueva.",
          },
          {
            screen: "Salón › Mesas y Comanda",
            what: "Los canales activos de la sede deciden qué formas de vender aparecen.",
          },
          {
            screen: "Documentos fiscales",
            what: "NIT, razón social y municipio salen impresos en el documento equivalente.",
            to: "/admin/fiscal/documentos",
          },
          {
            screen: "Dinero › Turnos",
            what: "La hora de corte decide a qué día operativo pertenece cada venta.",
          },
        ],
      },
      {
        value: "fiscal",
        label: "Fiscal",
        question: "¿Con qué régimen y qué impuesto se cobra acá, y desde cuándo rige cada cambio?",
        leaks: true,
        destinations: [
          {
            screen: "Salón › Cobro",
            what: "La tasa por defecto y el régimen deciden el impuesto de cada venta nueva.",
          },
          {
            screen: "Documentos fiscales",
            what: "Persona, régimen y códigos RUT viajan en el documento electrónico.",
            to: "/admin/fiscal/documentos",
          },
          {
            screen: "Ventas y Analítica",
            what: "Las ventas viejas conservan la versión fiscal vigente cuando se cobraron: acá nunca se edita, se crea una versión nueva.",
          },
        ],
      },
    ],
  },
  {
    group: "La plata",
    tabs: [
      {
        value: "cash",
        label: "Caja",
        question:
          "¿Con cuánto abre el cajón, cuánto puede desajustar un cierre y qué le exige el salón a quien cuenta?",
        leaks: true,
        destinations: [
          { screen: "Dinero › Abrir turno", what: "Base fija y reserva por defecto." },
          {
            screen: "Salón › Cierre de turno",
            what: "Los dos umbrales, la causa identificada obligatoria y el campo de foto del paso 3.",
          },
          {
            screen: "Hoy › Requiere tu atención",
            what: "El aviso «Diferencia crítica de caja» usa el umbral crítico de acá.",
            to: "/admin/hoy",
          },
          { screen: "Dinero › Cierres", what: "Qué diferencias se marcan y cuáles quedan para revisar." },
          {
            screen: "Salón › Turno › Movimiento de caja",
            what: "El límite de gasto menor dispara el PIN de administrador.",
          },
        ],
      },
      {
        value: "sales",
        label: "Ventas",
        question: "¿Qué puede hacer el salón con el precio —propina, descuento, cortesía— y con qué motivo?",
        leaks: true,
        destinations: [
          {
            screen: "Salón › Comanda › Anular, Descontar, Cortesía",
            what: "Los motivos tipados de acá son los que llenan esos tres desplegables. Sin motivos, el desplegable queda vacío.",
          },
          { screen: "Salón › Cobro", what: "La propina sugerida y los medios de pago habilitados." },
          { screen: "Cocina y KDS", what: "Las estaciones y los cursos, con su tiempo objetivo." },
          {
            screen: "Salón › Cierre de turno, paso 2",
            what: "Los motivos de anulación son las causas tipadas que reemplazan a «Sin identificar».",
          },
        ],
      },
      {
        value: "uvt",
        label: "UVT",
        question: "¿Cuánto vale la UVT de cada año, que es con lo que se miden los topes de ley?",
      },
    ],
  },
  {
    group: "El salón",
    tabs: [
      {
        value: "channels",
        label: "Canales y plataformas",
        question: "¿Por dónde entra un pedido y cuánta comisión se lleva cada plataforma?",
        leaks: true,
        destinations: [
          { screen: "Salón › Comanda nueva", what: "Qué canales aparecen para elegir al abrir una comanda." },
          { screen: "Ventas y Analítica", what: "La comisión de cada plataforma se descuenta en los reportes." },
        ],
      },
      {
        value: "zones",
        label: "Zonas y mesas",
        question: "¿Qué mesas hay, en qué zona, y cuáles están habilitadas para sentar gente hoy?",
        leaks: true,
        destinations: [
          { screen: "Salón › Mesas", what: "El mapa del salón es exactamente esta lista: zona, número y sillas." },
        ],
      },
    ],
  },
  {
    group: "La cocina y el equipo",
    tabs: [
      {
        value: "inventory",
        label: "Inventario",
        question: "¿Desde qué desvío se revisa una varianza y qué insumos se cuentan todos los días?",
      },
      {
        value: "people",
        label: "Empleados",
        question: "¿Quién trabaja acá, con qué rol, con qué PIN y hasta qué descuento puede dar sin pedir permiso?",
        leaks: true,
        destinations: [
          { screen: "Salón › Identificar persona", what: "El PIN de 4 dígitos con el que cada uno se identifica." },
          {
            screen: "Salón › Comanda › Descuento",
            what: "El límite por persona es lo que dispara el pedido de autorización de un supervisor.",
          },
          { screen: "Historial", what: "Toda acción queda firmada con el empleado que la hizo.", to: "/admin/audit" },
        ],
      },
    ],
  },
];

const ALL_TABS: readonly SettingsTab[] = GROUPS.flatMap((g) => g.tabs);
const LEAKING = ALL_TABS.filter((t) => t.leaks).length;

/**
 * **Las tres que se tocan seguido** (mapa de pantallas, regla 4: tres
 * pestañas como máximo a la vista). Un restaurante que vende a domicilio y
 * por plataformas y que piensa abrir más sedes vuelve a Sedes (una sede
 * nueva, el PIN de un dispositivo), a Empleados (gente que entra y sale, su
 * PIN y su límite de descuento) y a Canales y plataformas (comisiones). Las
 * otras siete se configuran una vez y viven en «Más»; ninguna cambia su
 * `value`.
 */
const PRINCIPALES: readonly string[] = ["stores", "people", "channels"];
const VISIBLES = PRINCIPALES.map((value) => ALL_TABS.find((t) => t.value === value)).filter(
  (t): t is SettingsTab => t !== undefined,
);
const EN_MAS = ALL_TABS.filter((t) => !PRINCIPALES.includes(t.value)).map(({ value, label }) => ({ value, label }));

/**
 * Admin → Configuración. Cada pestaña pega contra un recurso distinto de
 * `/admin/stores/{id}/*`; la mayoría necesita la sede activa
 * (`useStoreSelection`), que ya resuelve `AdminLayout`.
 */
export default function SettingsPage(): React.JSX.Element {
  const { activeStoreId, stores } = useStoreSelection();
  // Abre en Sedes, la primera de las tres a la vista: es también a donde
  // llega «Crear la primera sede» desde las pantallas que la necesitan.
  const [tab, setTab] = useState("stores");

  const active = ALL_TABS.find((t) => t.value === tab) ?? ALL_TABS[0];
  const storeName = stores.find((s) => s.id === activeStoreId)?.name;

  return (
    <div className="space-y-4">
      <PageHeader
        name={`Ajustes · ${active.label}`}
        question={active.question}
        context={[
          {
            label: "Aplica a",
            value: storeName ?? "—",
            title: "Cada sede tiene sus propios ajustes: el selector de sede está en la lateral.",
          },
          {
            label: "Secciones",
            value: `${ALL_TABS.length}`,
            title: `Tres a la vista y ${EN_MAS.length} en «Más».`,
          },
          {
            label: (
              <span className="inline-flex items-center gap-1.5">
                <TriangleAlert className="size-3.5 text-warning" aria-hidden="true" />
                Cambian pantallas del salón
              </span>
            ),
            value: `${LEAKING}`,
            title:
              "No se quedan acá: cambian lo que el salón le exige a la gente. Las de la fila llevan un punto ámbar; debajo de cada una, plegado, dice a qué pantallas llega.",
          },
        ]}
      />

      <Tabs value={tab} onValueChange={(next) => setTab(String(next))}>
        {/* A 390 px las tres más «Más» no caben en una fila: se parten en dos
            en vez de esconder «Más» detrás del desplazamiento horizontal. */}
        <TabsList className="flex-wrap group-data-horizontal/tabs:h-auto">
          {VISIBLES.map((item) => (
            <TabsTrigger key={item.value} value={item.value} className="gap-1.5">
              {item.label}
              {item.leaks ? (
                <span
                  aria-hidden="true"
                  title="Cambia pantallas del salón"
                  className="size-1.5 shrink-0 rounded-full bg-warning"
                />
              ) : null}
            </TabsTrigger>
          ))}
          {/* Tres a la vista y el resto en «Más» (mapa de pantallas, regla 4). */}
          <MasPestanas value={tab} onValueChange={setTab} items={EN_MAS} />
        </TabsList>

        <div className="min-w-0 space-y-3 pt-4">
          <TabsContent value="organization">
            <OrganizationSection />
          </TabsContent>
          <TabsContent value="stores">
            <StoresSection />
          </TabsContent>
          <TabsContent value="fiscal">
            <FiscalSection storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="cash">
            <CashSection storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="sales">
            <SalesSection storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="channels">
            <ChannelsSection storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="uvt">
            <UvtSection />
          </TabsContent>
          <TabsContent value="zones">
            <ZonesTablesSection storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="inventory">
            <InventorySection storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="people">
            <PeopleSection storeId={activeStoreId} />
          </TabsContent>

          {/* El reverso de las pestañas (patrón 10). Vive acá y no dentro de cada
              sección a propósito: contesta «esta PESTAÑA a dónde llega», que
              es una pregunta de la pantalla, no de un campo. Plegado (mapa de
              pantallas, regla 2): se lee al decidir un cambio, no cada vez
              que se abre la pestaña. */}
          {active.destinations ? (
            <details className="text-sm">
              <summary className="cursor-pointer rounded-md py-1 text-xs font-medium text-muted-foreground select-none hover:text-foreground">
                ¿A qué otras pantallas llega? ({active.destinations.length})
              </summary>
              <ScopeDestinations destinations={active.destinations} className="mt-1" />
            </details>
          ) : null}
        </div>
      </Tabs>
    </div>
  );
}
