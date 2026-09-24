/**
 * **La explicación, plegada** (mapa de pantallas, regla 2: «la explicación va
 * en ¿Qué es esto?, no en la pantalla»). Lo que antes era una pista bajo cada
 * tarjeta o un párrafo bajo el título se lee cuando alguien lo pide. Es un
 * `<details>` nativo: se abre con teclado y el texto sigue en el árbol.
 *
 * Copia local a propósito: la capa compartida (`@/components/admin`) es de
 * sólo lectura en esta ola. Si el patrón se queda, sube allá y ésta se borra.
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
