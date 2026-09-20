# Cómo se pide diseño acá

Esto no es una guía de estilo. Es lo que costó aprender pidiendo dirección
visual para este producto: **catorce intentos, de los cuales los nueve
primeros no sirvieron**, y por qué.

Se escribe para que la próxima ronda no vuelva a pagarlo.

---

## 1. Un `SKILL.md` sin sus datos es un documento que miente

Los 7 skills de diseño llegaron al framework con sólo su markdown: de 172
archivos quedaron 7. Y como Claude Code descubre un skill por
`skills/<nombre>/SKILL.md`, aplanarlos hizo que **ninguno se registrara**.

Durante nueve direcciones, cinco directores creyeron estar usando un catálogo
de 88 estilos y 192 perfiles de producto. No había nada detrás. Cinco
instancias del mismo modelo, sin datos, improvisan desde los mismos priores y
**convergen**: entregaron la misma tipografía, la misma paleta y la misma
metáfora, sin verse entre ellas.

Detalle en `.claude/skills/PROCEDENCIA.md`.

> **Antes de pedir diseño, comprobá que la herramienta produce:**
> ```
> python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<producto>" --design-system
> ```
> Tiene que devolver patrón, estilo, tokens de color, par tipográfico con su
> URL, efectos y checklist. Que los archivos estén no alcanza.

## 2. Consultá en inglés, siempre

La base está indexada en inglés. En español **detecta mal el dominio**, busca
en el CSV equivocado y devuelve cero — y quien no lo sabe cree que la
herramienta no tiene nada para este producto y vuelve a sus gustos.

## 3. La consulta es la palanca, no un detalle

El mismo producto devuelve sistemas completamente distintos según cómo se lo
describa, y **todas las descripciones son ciertas**. `restaurant food
ordering` da cálido y serif; `cash control blind reconciliation` da oscuro y
monoespaciado. Por eso el método que funcionó fue **correr de tres a seis
descripciones, comparar, y recién ahí elegir**, dejando anotado por qué.

## 4. Los tokens son el piso, no el diseño

La herramienta devuelve variables CSS. Construirlas fielmente da una interfaz
**correcta y anodina** — eso fue exactamente lo que pasó cuando el encargo
decía «construí lo que la herramienta te dé».

Se mide. La dirección elegida, antes de la pasada de oficio:

```
gradientes 0 · animaciones 0 · ::before/::after 0
box-shadow 1 · border-radius 2
14 tamaños de tipografía: 11 12 13 14 15 16 17 18 20 22 23 26 27 28
3 pesos: 400 500 600   (las familias llegan a 900)
tamaño máximo 28px, en la pantalla cuyo punto es el total a cobrar
```

Catorce valores empujados hasta que quedaron no son una escala.

## 5. Qué significa «trabajada» cuando no podés usar adornos

En una pantalla que un operador estresado mira ocho horas, la decoración se
paga en legibilidad. El oficio sale de otro lado, y conviene pedirlo por su
nombre:

1. **Escala tipográfica de verdad**: una razón, seis o siete escalones,
   declarada. (Dos directores independientes llegaron a la misma: razón 1,25
   → `12 · 15 · 19 · 23 · 29 · 37 · [46] · 57`, **saltando un escalón** para
   que el número más importante lea como otra categoría y no como el
   siguiente de la serie.)
2. **Rango de peso**: usar lo que la familia ofrece, no quedarse en 600.
3. **Material**: elevación como sistema. En oscuro se hace **con luz, no con
   sombra** — filetes superiores que capturan, fondos que se levantan.
4. **Detalle de 1 a 4 px**: costuras, junturas, hairlines que significan algo.
   Ahí vive la diferencia entre hecho y generado.
5. **Un elemento de firma** que no podría venir de otro producto.
6. **Peso en la interacción**, respetando `prefers-reduced-motion`.
7. **Marcas propias** en vez de formas genéricas.

Y la regla que impide que esto se vuelva ruido: **gastá el atrevimiento en un
solo lugar y dejá el resto callado.**

## 6. Explorar barato, construir después

Pedir cinco pantallas completas, dos temas, responsive y un inventario de 86
controles convierte el encargo en una tarea de completitud, **y la
completitud se come a la invención**. El presupuesto se va en verificar.

Partilo: una ronda de exploración de dos pantallas sin temas ni estados, y
recién con la dirección elegida, la construcción completa.

## 7. Lo que sí tiene que ir en el encargo de construcción

El inventario exhaustivo de controles, con esta regla: **ninguna dirección
puede quitar un control; si cree que uno sobra, lo escribe en un aparte y lo
deja en la pantalla.**

No es capricho. Este producto ya perdió capacidades porque una pantalla no las
tuvo en cuenta: durante meses no existió botón para cerrar sesión aunque el
servidor sabía hacerlo, y el cierre de caja pedía «marcá trasladarlas al
turno siguiente» sobre una casilla que ninguna pantalla dibujaba.

## 8. Prohibir produce evasión, no invención

Cuando las primeras tres convergieron, agregué una lista de prohibiciones.
Las siguientes salieron **distintas pero tímidas**: alguien esquivando, no
alguien inventando. Peor: yo había prohibido el casi-negro y la paleta
cálida, y eran justo lo que la herramienta recomienda para este producto.
**Las prohibiciones estaban peleando contra los datos.**

Lo que sí funciona en vez de prohibir: obligar a **escribir tres lecturas
distintas del producto antes de diseñar**, elegir la menos obvia y dejar las
tres anotadas.

## 9. Verificá vos lo que entregan

De catorce entregas, las medidas contra el archivo desmintieron el informe más
de una vez. Lo que conviene medir siempre: las fuentes y la paleta reales
(`grep`), el desborde horizontal a 1280 **y a 1024**, y los contrastes.

Y lo que en este entorno **no se puede** verificar: las fuentes de Google no
cargan (el proxy rechaza el certificado), así que toda captura muestra
tipografías de respaldo. La tipografía real hay que mirarla en el navegador
propio. Decilo cuando entregues; no lo escondas.
