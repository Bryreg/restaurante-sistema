/**
 * **La explicación, plegada** (mapa de pantallas, regla 2: «la explicación va
 * en ¿Qué es esto?, no en la pantalla»). Lo que antes era una pista bajo cada
 * tarjeta o un párrafo bajo el título se lee cuando alguien lo pide. Es un
 * `<details>` nativo: se abre con teclado y el texto sigue en el árbol, así
 * que la pantalla no cambia de qué dice, sólo de qué muestra de entrada.
 *
 * El motivo de un «sin dato» NO va acá: ése queda a la vista.
 */
export function Explicacion({
  resumen = "¿Qué es esto?",
  children,
}: {
  resumen?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer rounded-md px-1.5 py-1 font-medium select-none hover:text-foreground">
        {resumen}
      </summary>
      <div className="max-w-[76ch] space-y-1 px-1.5 pt-1 pb-1.5">{children}</div>
    </details>
  )
}

export default Explicacion
