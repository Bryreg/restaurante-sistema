/**
 * **El catálogo de la capa compartida.** Un componente por patrón de
 * `docs/PATRONES-ADMIN.md`, en sus variantes, y en cada uno la afirmación de
 * lo que el patrón promete —no que "renderiza sin romperse"—.
 *
 * Para qué sirve: la ola 2 rediseña veinticuatro pantallas componiendo esto.
 * Un componente sin su afirmación acá es un componente que la ola 2 va a usar
 * mal, y el error va a aparecer veinticuatro veces.
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { ConsequenceZone } from "@/components/admin/ConsequenceZone"
import { DenseTable, DenseTableBar } from "@/components/admin/DenseTable"
import {
  AllClearEmptyState,
  DependencyEmptyState,
  FeatureOffEmptyState,
} from "@/components/admin/EmptyStates"
import { FilterLink } from "@/components/admin/FilterLink"
import { FormField, FormSection } from "@/components/admin/FormSection"
import { GroupLabel } from "@/components/admin/GroupLabel"
import { HeadlineFigure } from "@/components/admin/HeadlineFigure"
import { NoticeRail, type Notice } from "@/components/admin/NoticeRail"
import { OriginBar } from "@/components/admin/OriginBar"
import { PageHeader } from "@/components/admin/PageHeader"
import { ScopeDestinations, ScopeMarks } from "@/components/admin/ScopeMarks"
import { SaveBar } from "@/components/admin/SaveBar"
import { TimeAgo, formatTimeAgo } from "@/components/admin/TimeAgo"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"

function dibujar(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

// ── 2 · Cabecera de pantalla ───────────────────────────────────────────────

describe("PageHeader · nombre + la pregunta que la pantalla contesta", () => {
  it("dice contra qué datos se mira, no sólo cómo se llama la pantalla", () => {
    dibujar(
      <PageHeader
        name="Hoy"
        question="Cómo va el día en curso: lo que ya entró, lo que todavía está abierto y lo que no puede esperar a mañana."
        context={[
          { label: "Se actualiza sola cada 30 s ·", value: "hace 14 s" },
          { label: "Son las", value: "11:24 p. m.", title: "21 sep 2026, 11:24 p. m." },
        ]}
        actions={<button type="button">Ver el día completo</button>}
      />,
    )
    expect(screen.getByRole("heading", { level: 1, name: "Hoy" })).toBeInTheDocument()
    expect(screen.getByText(/lo que no puede esperar a mañana/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Ver el día completo" })).toBeInTheDocument()
  })

  it("la franja de contexto dice lo que caduca, y la marca exacta vive en el `title`", () => {
    dibujar(
      <PageHeader
        name="Inventario"
        question="Qué tengo, qué me falta y qué me está mintiendo."
        context={[{ label: "Último conteo completo", value: "hace 43 días", title: "9 ago 2026, 08:12" }]}
      />,
    )
    expect(screen.getByText("hace 43 días")).toBeInTheDocument()
    expect(screen.getByTitle("9 ago 2026, 08:12")).toBeInTheDocument()
  })

  it("sin franja de contexto no dibuja una franja vacía", () => {
    const { container } = dibujar(<PageHeader name="Ajustes" question="Qué se configura acá." />)
    expect(container.querySelectorAll("p")).toHaveLength(1)
  })
})

// ── 3 · Rótulo de grupo ────────────────────────────────────────────────────

describe("GroupLabel · parte la grilla y dice de qué tipo es cada mitad", () => {
  it("el rótulo nombra el grupo y la frase dice qué quiere decir", () => {
    dibujar(
      <GroupLabel label="Del día" says="cerrado, ya no cambia">
        <p>tarjetas</p>
      </GroupLabel>,
    )
    const grupo = screen.getByRole("region", { name: "Del día" })
    expect(within(grupo).getByText("cerrado, ya no cambia")).toBeInTheDocument()
    expect(within(grupo).getByText("tarjetas")).toBeInTheDocument()
  })

  it("«Ahora mismo» es un grupo distinto, no la misma grilla con otro título", () => {
    dibujar(
      <>
        <GroupLabel label="Del día" says="cerrado, ya no cambia" />
        <GroupLabel label="Ahora mismo" says="vivo, todavía puede cambiar o salir mal" />
      </>,
    )
    expect(screen.getAllByRole("region")).toHaveLength(2)
    expect(screen.getByText("vivo, todavía puede cambiar o salir mal")).toBeInTheDocument()
  })
})

// ── 4 · Banda de cifra ─────────────────────────────────────────────────────

describe("HeadlineFigure · la plata es una resta, no un número suelto", () => {
  const banda = (
    <HeadlineFigure
      label="Ventas netas de hoy"
      value="$ 4.884.000"
      note="148 comandas pagadas · 12 horas de servicio · sigue abierto"
      ledger={{
        rows: [
          { label: "Cobrado en caja", value: "$ 5.274.720" },
          { label: "Impoconsumo 8 % — no es suyo", value: "$ 390.720", kind: "subtract" },
        ],
        total: { label: "Ventas netas", value: "$ 4.884.000" },
      }}
      belowTheLine={{ label: "Propinas — pasan de largo, no son venta", value: "$ 312.000" }}
      comparison={{
        label: "Contra el lunes pasado a esta hora",
        delta: "+12,0 %",
        detail: "$ 4.361.000 · +$ 523.000",
      }}
    />
  )

  it("la cifra rectora llega con el libro que la deriva", () => {
    dibujar(banda)
    expect(screen.getByText("$ 4.884.000", { selector: "p" })).toBeInTheDocument()
    expect(screen.getByText("Cobrado en caja")).toBeInTheDocument()
    expect(screen.getByText("−$ 390.720")).toBeInTheDocument()
    expect(screen.getByText("Ventas netas")).toBeInTheDocument()
  })

  it("las propinas van abajo de la raya y rotuladas como que no son venta", () => {
    // Es lo que mata la tarjeta «Propinas», que es un error de categoría: la
    // propina no es del restaurante (Ley 1935 de 2018).
    dibujar(banda)
    expect(screen.getByText("Propinas — pasan de largo, no son venta")).toBeInTheDocument()
  })

  it("la comparación es contra el mismo día de la semana pasada a la misma hora", () => {
    dibujar(banda)
    expect(screen.getByText("Contra el lunes pasado a esta hora")).toBeInTheDocument()
    expect(screen.getByText("+12,0 %")).toBeInTheDocument()
  })
})

// ── 5 · Tarjeta de indicador ───────────────────────────────────────────────

describe("StatTile · rótulo, cifra y de qué está hecha", () => {
  it("el pie dice de qué está hecha la cifra", () => {
    dibujar(
      <StatTile label="Comandas pagadas" value="148" hint="96 en mesa · 31 mostrador · 21 domicilio" />,
    )
    expect(screen.getByText("96 en mesa · 31 mostrador · 21 domicilio")).toBeInTheDocument()
  })

  it("«—» no es 0: dice por qué no se sabe, y no se pinta de rojo", () => {
    const { container } = dibujar(
      <StatTile
        label="Comensales"
        value={null}
        nullNote="222 contados. Sin registrar en 31 comandas de mostrador. No es cero: es que nadie lo contó."
        tone="critical"
      />,
    )
    const cifra = screen.getByText("—")
    expect(cifra.className).toContain("text-muted-foreground")
    // Ni siquiera con tono crítico: no saber no es estar mal.
    expect(cifra.className).not.toContain("text-destructive")
    expect(container.textContent).toContain("es que nadie lo contó")
  })

  it("una tarjeta con tono lleva a algún lado, y el enlace habla en palabras", () => {
    dibujar(
      <StatTile
        label="Comandas abiertas"
        value="9"
        tone="warning"
        hint="4 sin enviar a cocina · 2 con cuenta presentada sin cobrar."
        link={{ to: "/admin/pedidos?estado=atascadas", screen: "Pedidos", filter: "atascadas" }}
      />,
    )
    const enlace = screen.getByRole("link", { name: /Pedidos/ })
    expect(enlace.textContent).toContain("atascadas")
    expect(enlace.textContent).not.toContain("?estado=")
  })

  it("la franja de estado de 3 px va en el borde y sigue el tono", () => {
    const { container } = dibujar(<StatTile label="Utilidad" value="-$ 1.000" tone="critical" />)
    const tarjeta = container.firstElementChild as HTMLElement
    expect(tarjeta.className).toContain("border-l-[3px]")
    expect(tarjeta.className).toContain("border-l-destructive")
  })
})

// ── 6 · Enlace con filtro y barra de procedencia ───────────────────────────

describe("FilterLink · nombra pantalla, pestaña y filtro; nunca la consulta", () => {
  it("dice «Inventario › Stock» y la pastilla «negativos», no `?tab=stock&negative=1`", () => {
    dibujar(
      <FilterLink to="/admin/inventario?tab=stock&negative=1" screen="Inventario" tab="Stock" filter="negativos" />,
    )
    const enlace = screen.getByRole("link")
    expect(enlace.textContent).toContain("Inventario › Stock")
    expect(enlace.textContent).toContain("negativos")
    expect(enlace.textContent).not.toContain("tab=stock")
    expect(enlace.textContent).not.toContain("negative=1")
    expect(enlace).toHaveAttribute("href", "/admin/inventario?tab=stock&negative=1")
  })

  it("sin filtro no hay pastilla", () => {
    const { container } = dibujar(
      <FilterLink to="/admin/inventario/salud" screen="Inventario" tab="Salud del control" />,
    )
    expect(container.querySelectorAll("span.rounded-full")).toHaveLength(0)
  })
})

describe("OriginBar · el destino reconoce de dónde venís, y ofrece la salida", () => {
  it("nombra la procedencia, lo aplicado y da la salida", async () => {
    const quitar = vi.fn()
    const user = userEvent.setup()
    dibujar(
      <OriginBar
        from="Venís de Hoy › 5 insumos en negativo"
        applied={["negativos"]}
        exit={{ label: "Quitar el filtro y ver los 47", onClick: quitar }}
        back={{ label: "Volver a Hoy", to: "/admin/hoy" }}
      />,
    )
    expect(screen.getByText("Venís de Hoy › 5 insumos en negativo")).toBeInTheDocument()
    expect(screen.getByText("negativos")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Volver a Hoy" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Quitar el filtro y ver los 47" }))
    expect(quitar).toHaveBeenCalledTimes(1)
  })
})

// ── 7 · Aviso accionable ───────────────────────────────────────────────────

const AVISOS: Notice[] = [
  {
    id: "neg",
    severity: "critical",
    title: "5 insumos en negativo",
    consequence: "No bloquea la venta, pero el costo de cada plato que los usa está mintiendo.",
    link: { to: "/admin/inventario?tab=stock&negative=1", screen: "Inventario", tab: "Stock", filter: "negativos" },
  },
  {
    id: "caja",
    severity: "critical",
    title: "Diferencia crítica de caja",
    consequence: "El turno #12 cerró con $ 212.400 de diferencia. El cierre sigue en pie.",
  },
  { id: "min", severity: "warning", title: "9 insumos bajo el mínimo" },
  { id: "atasco", severity: "warning", title: "6 comandas atascadas" },
  { id: "lotes", severity: "whenever", title: "3 lotes por vencer" },
  { id: "cierres", severity: "whenever", title: "9 cierres sin revisar" },
]

describe("NoticeRail · una sola forma, y el recuento no puede mentir", () => {
  it("cada gravedad trae su recuento, derivado de los avisos", () => {
    dibujar(<NoticeRail notices={AVISOS} />)
    const riel = screen.getByRole("complementary", { name: "Requiere tu atención" })
    expect(within(riel).getByText("Crítico").textContent).toContain("2")
    expect(within(riel).getByText("Aviso").textContent).toContain("2")
    // La cola sin urgencia ya no lleva encabezado de grupo: `a2` la deja
    // como un solo renglón plegado al pie, y su recuento lo dice el botón
    // («2 avisos más, sin urgencia»), no un rótulo que repite el número.
    expect(within(riel).queryByText("Para cuando puedas")).toBeNull()
    expect(within(riel).getByRole("button", { name: /2 avisos más, sin urgencia/ })).toBeInTheDocument()
  })

  it("todos los avisos llevan la misma forma: la gravedad la dice el riel de color", () => {
    // Antes el crítico iba desplegado y el resto colapsaba a una línea. `a2`
    // los escribe todos igual (`.av`) y distingue con el borde izquierdo.
    const { container } = dibujar(<NoticeRail notices={AVISOS} />)
    expect(
      screen.getByText("No bloquea la venta, pero el costo de cada plato que los usa está mintiendo."),
    ).toBeInTheDocument()
    expect(screen.getByText("9 insumos bajo el mínimo")).toBeInTheDocument()
    expect(container.querySelectorAll("li.border-l-destructive")).toHaveLength(2)
    expect(container.querySelectorAll("li.border-l-warning")).toHaveLength(2)
  })

  it("la cola sin urgencia se pliega y se despliega: 0 a 14 sin cambiar de forma", async () => {
    const user = userEvent.setup()
    dibujar(<NoticeRail notices={AVISOS} />)
    expect(screen.queryByText("3 lotes por vencer")).toBeNull()
    await user.click(screen.getByRole("button", { name: /2 avisos más, sin urgencia/ }))
    expect(screen.getByText("3 lotes por vencer")).toBeInTheDocument()
  })

  it("sin avisos el riel no se vacía: dice la noticia buena", () => {
    dibujar(
      <NoticeRail
        notices={[]}
        empty={<AllClearEmptyState description="Ningún insumo en negativo, ninguna comanda atascada." />}
      />,
    )
    expect(screen.getByText("Todo al día")).toBeInTheDocument()
  })
})

// ── 8 · Tabla densa ────────────────────────────────────────────────────────

interface Insumo {
  nombre: string
  stock: string
  estado: string
  desde: string
}

const INSUMOS: Insumo[] = [
  { nombre: "Pollo en pechuga", stock: "−1.529 g", estado: "Negativo", desde: "2026-09-20T10:00:00Z" },
  { nombre: "Costilla de cerdo", stock: "1.800 g", estado: "Bajo mínimo", desde: "2026-09-21T09:00:00Z" },
]

describe("DenseTable · las cuatro piezas del patrón", () => {
  function tabla(filas: Insumo[] = INSUMOS, extra?: Partial<Parameters<typeof DenseTable<Insumo>>[0]>) {
    return dibujar(
      <DenseTable
        caption="Stock de insumos"
        rows={filas}
        rowKey={(i) => i.nombre}
        rowStatus={(i) => (i.estado === "Negativo" ? "critical" : "warning")}
        bar={
          <DenseTableBar shown={14} total={47} noun="activos" hidden="33 al día, ocultos por los filtros">
            <button type="button">Negativos</button>
          </DenseTableBar>
        }
        legend={[
          { term: "Negativo", meaning: "se descontó más de lo que se registró entrando. Es deuda de registro." },
          { term: "Bajo mínimo", meaning: "hay existencia, por debajo del umbral. Es de reposición." },
        ]}
        columns={[
          { key: "nombre", header: "Insumo", kind: "name", cell: (i) => i.nombre },
          { key: "stock", header: "Stock teórico", kind: "number", cell: (i) => i.stock },
          // (c) la celda escribe la palabra del negocio, no el enum.
          { key: "estado", header: "Estado", cell: (i) => i.estado },
        ]}
        {...extra}
      />,
    )
  }

  it("(a) la barra trae el recuento que convierte casillas mudas en un control con respuesta", () => {
    tabla()
    const barra = screen.getByText(/de/, { selector: "p" })
    expect(barra.textContent).toContain("14")
    expect(barra.textContent).toContain("47")
    expect(barra.textContent).toContain("activos")
    expect(barra.textContent).toContain("33 al día, ocultos por los filtros")
  })

  it("(b) la franja de estado deja ver la forma del problema sin leer", () => {
    tabla()
    expect(screen.getByRole("row", { name: /Pollo en pechuga/ })).toHaveAttribute("data-status", "critical")
    expect(screen.getByRole("row", { name: /Costilla de cerdo/ })).toHaveAttribute("data-status", "warning")
  })

  it("(c) la celda escribe la palabra del negocio, no el enum", () => {
    tabla()
    expect(screen.getByRole("cell", { name: "Negativo" })).toBeInTheDocument()
    expect(screen.queryByText("negative")).toBeNull()
  })

  it("(d) la leyenda va al pie y una sola vez, no repetida en cada fila", () => {
    tabla()
    expect(screen.getAllByText("Negativo", { selector: "dt" })).toHaveLength(1)
    expect(screen.getByText(/deuda de registro/)).toBeInTheDocument()
  })

  it("la tabla se nombra para quien no la ve", () => {
    tabla()
    expect(screen.getByRole("table", { name: "Stock de insumos" })).toBeInTheDocument()
  })

  it("sin filas el vacío reemplaza la tabla, pero la barra con el recuento se queda", () => {
    // Si la barra se fuera con la tabla, el dueño que llegó desde un enlace
    // perdería lo único que le dice qué filtro está puesto.
    tabla([], {
      empty: <EmptyState reason="filter" title="Sin insumos para estos filtros" />,
    })
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.getByText("Sin insumos para estos filtros")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Negativos" })).toBeInTheDocument()
  })

  it("la cabecera fija sólo se declara cuando hay un alto contra el que pegarse", () => {
    // `position: sticky` se pega al ancestro que scrollea. Sin alto máximo no
    // hay ninguno, y una clase `sticky` que no pega nada es peor que no
    // ponerla: parece cumplido el patrón y no lo está.
    const { container } = tabla(INSUMOS, { maxBodyHeightPx: 420 })
    const caja = container.querySelector(".overflow-auto") as HTMLElement
    expect(caja.style.maxHeight).toBe("420px")
    expect(screen.getAllByRole("columnheader")[0].className).toContain("sticky")

    const { container: sinTope } = tabla()
    expect((sinTope.querySelector(".overflow-auto") as HTMLElement).style.maxHeight).toBe("")
  })

  it("la columna de acciones tiene ancho fijo: el borde derecho no baila", () => {
    dibujar(
      <DenseTable
        caption="Stock"
        rows={INSUMOS}
        rowKey={(i) => i.nombre}
        columns={[
          { key: "nombre", header: "Insumo", cell: (i) => i.nombre },
          { key: "acc", header: "", kind: "actions", widthPx: 64, cell: () => <button type="button">Ajustar</button> },
        ]}
      />,
    )
    const celda = screen.getAllByRole("cell")[1]
    expect(celda.style.width).toBe("64px")
    expect(celda.style.textAlign).toBe("right")
  })
})

describe("TimeAgo · lo corto se ve, lo exacto vive en el `title`", () => {
  it("«hace 1 día» en vez de 130 px gastados en un minuto que a nadie le importa", () => {
    const ahora = new Date("2026-09-21T12:00:00Z")
    expect(formatTimeAgo("2026-09-20T11:30:00Z", ahora)).toBe("hace 1 día")
    expect(formatTimeAgo("2026-09-21T11:49:00Z", ahora)).toBe("hace 11 min")
    expect(formatTimeAgo(null, ahora)).toBe("—")
  })

  it("la marca de tiempo completa queda a un hover de distancia", () => {
    dibujar(<TimeAgo iso="2026-09-20T11:30:00Z" now={new Date("2026-09-21T12:00:00Z")} />)
    const texto = screen.getByText("hace 1 día")
    expect(texto.title).not.toBe("")
    expect(texto.title).toContain("2026")
  })
})

// ── 9 · Sección de formulario ──────────────────────────────────────────────

describe("FormSection · qué gobierna, la lectura y lo que NO pasa", () => {
  function seccion() {
    return dibujar(
      <FormSection
        title="Cuánto puede desajustar un cierre"
        governs="Dos montos, y de ellos salen las tres franjas del cierre."
        reading={
          <>
            Al cerrar el turno: de <b>$ 1</b> a <b>$ 20.000</b> el cajero elige una causa y «Sin
            identificar» sirve.
          </>
        }
        doesNotDo="Nada de esto bloquea el cierre. Bloquear dejaría el turno abierto y vendiendo, que es el bug del turno abandonado."
      >
        <FormField
          label="Tolerancia sin causa identificada"
          help="Hasta este monto el cajero elige una causa pero «Sin identificar» sigue sirviendo."
          scope={{ affects: [{ screen: "Salón › Cierre de turno, paso 2", verb: "Cambia" }] }}
        >
          {({ fieldId, describedBy }) => (
            <input id={fieldId} aria-describedby={describedBy} defaultValue="20000" />
          )}
        </FormField>
      </FormSection>,
    )
  }

  it("la sección dice en una línea qué gobierna", () => {
    seccion()
    expect(screen.getByText("Dos montos, y de ellos salen las tres franjas del cierre.")).toBeInTheDocument()
  })

  it("la lectura devuelve en palabras la regla que el formulario está escribiendo", () => {
    seccion()
    expect(screen.getByText(/el cajero elige una causa y «Sin/)).toBeInTheDocument()
  })

  it("dice también lo que NO pasa: un umbral suena a compuerta y no lo es", () => {
    seccion()
    expect(screen.getByText(/Nada de esto bloquea el cierre/)).toBeInTheDocument()
  })

  it("la ayuda del campo dice la consecuencia, no el formato, y el control la anuncia", () => {
    seccion()
    const campo = screen.getByLabelText("Tolerancia sin causa identificada")
    const ayuda = document.getElementById(campo.getAttribute("aria-describedby") ?? "")
    expect(ayuda?.textContent).toContain("«Sin identificar» sigue sirviendo")
  })

  it("con error, el campo muestra la acción correctiva en vez de la ayuda", () => {
    dibujar(
      <FormSection title="Cierre" governs="Dos montos." reading="La regla.">
        <FormField
          label="Diferencia crítica"
          help="Desde este monto sale la alerta crítica."
          error="La crítica tiene que quedar por encima de la tolerancia: subí la crítica o bajá la tolerancia."
        >
          {({ fieldId }) => <input id={fieldId} defaultValue="10000" />}
        </FormField>
      </FormSection>,
    )
    expect(screen.getByText(/subí la crítica o bajá la tolerancia/)).toBeInTheDocument()
    expect(screen.queryByText("Desde este monto sale la alerta crítica.")).toBeNull()
  })
})

// ── 10 · Marca de alcance ──────────────────────────────────────────────────

describe("ScopeMarks · el alcance se dibuja, no se recuerda", () => {
  it("los tres chips: qué lo enciende, a dónde llega, qué pide", () => {
    const { container } = dibujar(
      <ScopeMarks
        flag="cash.reserve"
        affects={[{ screen: "Dinero › Abrir turno", verb: "Enciende el campo en" }]}
        requires="PIN de administrador"
      />,
    )
    expect(screen.getByText("cash.reserve")).toBeInTheDocument()
    expect(screen.getByText("Dinero › Abrir turno")).toBeInTheDocument()
    expect(screen.getByText("PIN de administrador")).toBeInTheDocument()
    expect(container.firstElementChild?.children).toHaveLength(3)
  })

  it("corta en tres: una fila de ocho pastillas vuelve a ser ruido", () => {
    const { container } = dibujar(
      <ScopeMarks
        flag="cash.reserve"
        affects={[{ screen: "A" }, { screen: "B" }, { screen: "C" }, { screen: "D" }]}
        requires="PIN de administrador"
      />,
    )
    expect(container.firstElementChild?.children).toHaveLength(3)
  })

  it("sin nada que marcar no dibuja una fila vacía", () => {
    const { container } = dibujar(<ScopeMarks />)
    expect(container.firstElementChild).toBeNull()
  })
})

describe("ScopeDestinations · a dónde llega esta pestaña", () => {
  it("contesta lo que los chips no contestan, con su recuento", () => {
    dibujar(
      <ScopeDestinations
        destinations={[
          { screen: "Dinero › Abrir turno", what: "Base fija y reserva por defecto.", to: "/admin/dinero" },
          { screen: "Salón › Cierre de turno", what: "Los dos umbrales y el campo de foto del paso 3." },
        ]}
      />,
    )
    expect(screen.getByText("A dónde llega esta pestaña")).toBeInTheDocument()
    expect(screen.getByText("2 destinos")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Dinero › Abrir turno" })).toBeInTheDocument()
    expect(screen.getByText("Base fija y reserva por defecto.")).toBeInTheDocument()
  })
})

// ── 11 · Las dos zonas ─────────────────────────────────────────────────────

describe("ConsequenceZone · dos niveles, los dos en el marco", () => {
  it("ámbar dice que cambia otra pantalla y que no se pierde nada", () => {
    dibujar(
      <ConsequenceZone
        level="reversible"
        explanation="Apagarlas no borra las 46 fotos ya tomadas — la foto simplemente deja de pedirse."
        children={<p>Foto obligatoria al cerrar turno</p>}
      />,
    )
    expect(screen.getByText("Cambia otra pantalla")).toBeInTheDocument()
    expect(screen.getByText(/no borra las 46 fotos ya tomadas/)).toBeInTheDocument()
  })

  it("rojo dice que no se deshace, y nombra a qué alcanza", () => {
    dibujar(
      <ConsequenceZone
        level="irreversible"
        scope="Sede Chapinero"
        explanation="El PIN nuevo no se vuelve a mostrar."
      />,
    )
    expect(screen.getByText("Zona de riesgo · Sede Chapinero")).toBeInTheDocument()
  })
})

// ── 12 · Barra de guardado ─────────────────────────────────────────────────

describe("SaveBar · no desaparece, cuenta los cambios y nombra el que sale", () => {
  it("sin cambios se queda en su sitio con el botón apagado", () => {
    dibujar(<SaveBar changes={[]} sectionName="Caja" onSave={() => {}} onDiscard={() => {}} />)
    expect(screen.getByText("Sin cambios")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled()
  })

  it("cuenta los cambios y nombra el que sale de Ajustes", () => {
    dibujar(
      <SaveBar
        sectionName="Caja"
        changes={[
          { field: "Diferencia crítica", from: "$ 80.000", to: "$ 100.000" },
          {
            field: "Foto obligatoria al cerrar turno",
            from: "apagada",
            to: "encendida",
            leaks: "cambia Salón › Cierre de turno, paso 3",
          },
        ]}
        onSave={() => {}}
        onDiscard={() => {}}
      />,
    )
    const estado = screen.getByText(/cambios sin guardar/)
    expect(estado.textContent).toContain("2")
    expect(estado.textContent).toContain("Foto obligatoria al cerrar turno")
    expect(estado.textContent).toContain("cambia Salón › Cierre de turno, paso 3")
  })

  it("confirma enumerando cada cambio con el valor viejo tachado", async () => {
    const guardar = vi.fn()
    const user = userEvent.setup()
    dibujar(
      <SaveBar
        sectionName="Caja"
        changes={[{ field: "Diferencia crítica", from: "$ 80.000", to: "$ 100.000" }]}
        onSave={guardar}
        onDiscard={() => {}}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Guardar" }))
    const dialogo = await screen.findByRole("alertdialog")
    expect(within(dialogo).getByText("Diferencia crítica")).toBeInTheDocument()
    const viejo = within(dialogo).getByText("$ 80.000")
    expect(viejo.tagName).toBe("S")
    await user.click(within(dialogo).getByRole("button", { name: "Guardar" }))
    expect(guardar).toHaveBeenCalledTimes(1)
  })
})

// ── 13 · Estado vacío, en cuatro motivos ───────────────────────────────────

describe("Los cuatro motivos del estado vacío", () => {
  it("función apagada: nombra la función, su clave, y lleva a encenderla", () => {
    // La entrada de navegación desaparece con el flag, pero la URL sobrevive
    // en un marcador y en los avisos de Hoy: por eso la pantalla no puede
    // limitarse a no existir.
    dibujar(
      <FeatureOffEmptyState
        feature="Varianza"
        flag="inventory.variance"
        description="Compara lo que las recetas dicen que se gastó contra lo que salió del inventario."
      />,
    )
    expect(screen.getByText("«Varianza» no está encendida")).toBeInTheDocument()
    expect(screen.getByText("inventory.variance")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Encenderla en Funciones" })).toHaveAttribute(
      "href",
      "/admin/features",
    )
  })

  it("dependencia: lleva a la pantalla que crea lo que falta", () => {
    dibujar(
      <DependencyEmptyState
        title="Sin insumos activos que marcar"
        description="Acá se eligen los insumos que entran al conteo rápido. Primero tienen que existir."
        create={{ label: "Crear insumos", to: "/admin/inventario?tab=insumos&nuevo=1" }}
      />,
    )
    expect(screen.getByRole("link", { name: "Crear insumos" })).toBeInTheDocument()
    expect(screen.getByText(/Primero tienen que existir/)).toBeInTheDocument()
  })

  it("vacío bueno: es una noticia, no una ausencia, y no trae ningún botón", () => {
    dibujar(<AllClearEmptyState description="Ningún insumo en negativo, ninguna cuenta vencida." />)
    expect(screen.getByText("Todo al día")).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("error: se anuncia como alerta sin que nadie tenga que acordarse de pasar `role`", () => {
    dibujar(
      <EmptyState
        reason="error"
        title="No se pudo traer el stock"
        description="El servidor contestó 503 a las 11:38 p. m. Los filtros y la pestaña quedaron como estaban."
        action={{ label: "Reintentar", onClick: () => {} }}
      />,
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument()
  })
})
