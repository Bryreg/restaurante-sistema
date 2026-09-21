# Patrones del escritorio del dueño

Las tres pantallas son la prueba; esto es lo que se aplica a las otras veintiuna
sin volver a diseñar.

**La regla que ordena a las demás: cada cosa dice de dónde sale y a dónde llega.**
Una cifra sin su derivación, un filtro sin su recuento y un ajuste sin su
consecuencia son el mismo error tres veces. Su corolario de color: **azul es lo
único que se toca; verde, ámbar y rojo sólo dicen cómo está algo.** Por eso ni el
botón que rota un PIN ni el que aplica un conteo son rojos: **el marco avisa, el
control sigue siendo azul.**

---

**1 · El armazón y el reparto del alcance.** Un control puesto en el lugar
equivocado miente sobre a cuánto alcanza. El alcance se lee por dónde vive el
control: la **sede** alcanza a toda la app y vive en la **barra superior**, con
la persona y su rol; el **período**, en la cabecera de pantalla; lo que **filtra
una tabla**, en la barra de esa tabla. Los tres controles de cuenta —campana,
tema, salida— viven en esa misma barra, a la derecha. Grupos: `EL DÍA · LA CARTA
Y EL COSTO · LA PLATA · LO FISCAL · LA GENTE · EL SISTEMA`. El ítem igual se
acorta —bajo `LO FISCAL`, «Documentos fiscales» es **Documentos** sin perder
nada— para que el rail de 222 px no trunque. *Aplica a las 24.*

> **Este patrón se dio vuelta a propósito.** Decía «no hay barra superior»,
> porque una barra le cobra 56 px de alto a un portátil, y repartía la sede a la
> cabeza de la lateral y los íconos de cuenta a su pie. El dueño miró la app
> desplegada contra la maqueta `a2` y pidió la de `a2`: una franja de un control
> de alto (34 px, no 56) que junta en un renglón las cuatro cosas que no son de
> ninguna pantalla. El reparto del alcance no cambió —sede, período, filtro de
> tabla siguen en tres lugares distintos—; cambió dónde vive lo que alcanza a
> todo. Lo verifica `src/app/__tests__/AdminLayout.test.tsx`.

**2 · Cabecera de pantalla.** Pantallas llamadas «Dinero», «Rangos» o «UVT» no se
explican solas, y un `h1` suelto no dice contra qué datos se mira. Nombre + **la
pregunta que la pantalla contesta**; acciones y período a la derecha; debajo, una
**franja de contexto** con lo que caduca: «se actualiza sola cada 30 s · hace
14 s» (Hoy), «47 activos · 6 inactivos · último conteo hace 43 días»
(Inventario), «aplica a Chapinero · último cambio: quién y cuándo» (Ajustes).
Con pestañas, la acción primaria baja a la barra de la tabla. *Aplica a las 24.*

**3 · Rótulo de grupo.** Una grilla uniforme aplana cosas de naturaleza distinta:
«ticket promedio» y «comandas abiertas» no son el mismo tipo de número. Un rótulo
con filete parte la grilla en **«Del día — cerrado, ya no cambia»** y **«Ahora
mismo — vivo, todavía puede cambiar o salir mal»**. *Aplica a Dinero, Turnos,
Banco, Nómina, Analítica: toda pantalla que mezcle cierre y curso.* **En Hoy no,
ya no:** `a2` dibuja las ocho tarjetas en una sola grilla de cuatro por fila, y
el rótulo de grupo dejaba la segunda fila en tres. Qué está cerrado y qué sigue
vivo lo dice el pie de cada tarjeta.

**4 · Banda de cifra.** La plata nunca es un número suelto: es una resta. Tres
partes: la **cifra rectora** (una por pantalla, nunca dos); el **libro** que la
deriva —cobrado en caja − impuesto al consumo = ventas netas—; y la
**comparación** contra el mismo día de la semana pasada a la misma hora. Las
**propinas nunca entran en la cifra rectora**, y se rotulan como que no son
venta. *Aplica a Ventas, Dinero, Cierre de caja, Nómina, Compras, Analítica.*
**En Hoy la propina es la octava tarjeta y no el renglón de abajo de la raya**:
es donde `a2` la pone. Lo que no se negocia es que no sume a la venta (Ley 1935
de 2018), no en qué caja se dibuja.

**5 · Tarjeta de indicador.** Rótulo, cifra y un pie que dice **de qué está
hecha** («96 en mesa · 31 mostrador · 21 domicilio»). Franja de estado de 3 px a
la izquierda y teñido suave del cuerpo. Dos reglas duras: **una tarjeta con tono
es una tarjeta que lleva a algún lado** —si no, el color es decoración—; y
**`—` no es `0`**: «Comensales —, 222 contados, sin registrar en 31 comandas de
mostrador. No es cero: es que nadie lo contó». Se dibuja apagado, nunca en rojo:
no saber no es estar mal. Y arrastra a su vecina: el ticket por comensal se
declara **sobre las 117 comandas que sí contaron**, no sobre las 148. *Aplica a
Hoy, Salud del control, Dinero, Turnos, Banco, Compras.*

**6 · Enlace con filtro, y barra de procedencia.** Las tarjetas y los avisos de
Hoy no llevan a una pantalla: llevan a una pestaña con filtros puestos. Van en
par. **El enlace nombra las tres cosas en palabras** —`Inventario › Stock` +
pastilla `negativos`—, **nunca la consulta cruda** (`?tab=stock&negative=1`):
quien lee esto es el dueño de un restaurante, no un programador; sin filtro, no
hay pastilla. Y **el destino lo reconoce**: barra de procedencia con de dónde
venís, qué se aplicó y **la salida** («Quitar el filtro y ver los 47»). Sin eso,
el dueño aterriza en una tabla corta y no sabe que le esconden filas. *Aplica a
los 14 avisos de Hoy y a Inventario, Compras, Pedidos, Carta, Dinero,
Preparaciones como destinos.*

**7 · Aviso accionable.** El más caro. Lo urgente estaba último, bajo el pliegue,
en doce tarjetas iguales a dos columnas donde el orden por gravedad que manda el
servidor se pierde en el zigzag. Una columna pegada a la derecha, siempre
visible, con **encabezado de gravedad y recuento**: `CRÍTICO 3` · `AVISO 7`.
**Todos los avisos llevan la misma forma** —cifra adelante, consecuencia en el
cuerpo («no bloquea la venta, pero el costo del plato miente») y el destino
nombrado abajo— y **la gravedad la dice el riel de color de 3 px a la
izquierda**, no la forma: a tres columnas de texto, dos formas distintas hacían
que la mitad de los avisos pareciera el pie de página de la otra mitad. La cola
sin urgencia se pliega en un solo renglón al pie, sin encabezado propio: su
recuento ya lo dice el botón. *Aplica a Notificaciones, Salud del control,
Devoluciones pendientes y a cualquier lista de pendientes.*

**8 · Tabla densa.** Fila de **34 px** medida, cabecera fija, cifras a la derecha
con `tabular-nums`, acciones como ícono en columna de ancho fijo para que el
borde derecho no se mueva. Cuatro piezas: **(a)** barra de la tabla —el
**recuento** a la izquierda, «14 de 47 activos · 33 al día, ocultos por los
filtros», que es lo que convierte casillas mudas en un control con respuesta;
filtros y salidas a la derecha—; **(b)** **franja de estado** en la primera
celda, que deja ver la forma del problema sin leer; **(c)** la celda escribe **la
palabra del negocio, no el enum** (`Mesa`, no `dine_in`); **(d)** **leyenda al
pie, una sola vez**, que sostiene las distinciones que el sistema separa a
propósito —negativo ≠ bajo mínimo, sin costo ≠ $ 0, sin enviar ≠ sin cobrar—. Al
pie y no arriba: el dueño quiere las filas primero y la referencia cuando dude.
**Regla dura: ninguna celda de datos parte una palabra ni hace crecer la fila.**
Si no cabe, la tabla se desliza dentro de su contenedor. Un número de comanda es
una palabra sola: `#1418`, nunca `141` / `8`. *Aplica a Pedidos, Movimientos,
Lotes, Conteos, Carta, Compras, Gastos, Documentos, Historial, Empleados.*

**9 · Sección de formulario.** Tarjeta con título, **una línea de qué gobierna**,
campos en rejilla, y bajo cada uno la ayuda que dice **la consecuencia, no el
formato**. Cuatro reglas:

- **Un campo se dibuja si alguna lógica lo lee.** Antes de maquetar un editor hay
  que buscar el ajuste en el *servicio*, no en el esquema: uno que existe en el
  modelo, el router y el tipo de API pero tiene cero usos de negocio no es un
  campo, es un resto. Dibujarle un editor le enseña al dueño una regla que el
  producto no aplica.
- **La escala.** Cuando varios campos vecinos son fronteras de la misma recta, se
  dibuja la recta, a escala y teñida, con **las franjas leídas de los campos y
  nunca al revés**: las fronteras son lo editable, las franjas son su
  consecuencia. En Caja, dos montos y tres franjas.
- **La lectura.** Devuelve en palabras la regla que el formulario está
  escribiendo, y con ella la validación cruzada que ningún campo solo puede ver:
  acá, que la tolerancia sin causa quede **por debajo** de la crítica, porque al
  revés el administrador recibe la alerta de una diferencia que el cierre todavía
  deja cerrar con «Sin identificar». El mensaje nombra la acción correctiva en
  las dos direcciones.
- **Decir también lo que *no* pasa.** Un umbral suena a compuerta. La sección dice
  explícito que **nada de esto bloquea el cierre**, porque bloquear dejaría el
  turno abierto y vendiendo, que es el bug del turno abandonado. Cuando el nombre
  de un control sugiere un poder que no tiene, la ayuda lo desmiente.

*Aplica a las diez secciones de Ajustes y a Fiscal, Ventas, UVT, Empleados,
Zonas, Funciones.*

**10 · Marca de alcance.** 124 de los 275 controles están detrás de una
condición: el alcance no se recuerda, se dibuja. Chips bajo el campo, hasta tres:
**`flag`** (qué función lo enciende), **«Afecta: Salón › Cierre de turno, paso
3»** (qué otra pantalla cambia) y **«PIN de administrador»** (qué se le va a
pedir). En el índice, un punto sobre las secciones que se salen de la pantalla.
Y el reverso: la tarjeta **«A dónde llega esta pestaña»**, porque los chips
contestan «este campo a dónde va» y no «esta pantalla a dónde llega». *Aplica a
Ajustes, Funciones, Fiscal, Sedes, Empleados.*

**11 · Las dos zonas: ámbar cambia otra pantalla, rojo no se deshace.** Si todo
lo que sale de la pantalla se marca en rojo, el rojo deja de querer decir «esto
no se deshace». Dos niveles, los dos **en el marco y nunca en el botón**.
**Ámbar · «Cambia otra pantalla»**: reversible, no pierde nada —apagar la foto
obligatoria no borra las 46 ya tomadas; la foto simplemente deja de pedirse—.
**Rojo · «Zona de riesgo»**: no se deshace —el PIN nuevo no se vuelve a
mostrar—. En las dos, el botón es **azul y secundario**, para que no sea lo más
fácil de pulsar, y la confirmación **enumera qué cambia y dónde se va a notar**.
*Aplica a Funciones, Fiscal, Sedes (ámbar); Aplicar conteo, Anonimizar cliente,
Revertir recepción, Apagar función, Rotar PIN (rojo).*

**12 · Barra de guardado.** Pegada abajo, **no desaparece**: sin cambios dice
«Sin cambios» con el botón apagado, que es lo que le enseña al dueño que esta
pantalla se guarda, y que se guarda por sección y no por campo. Cuenta los
cambios, **nombra el que sale de Ajustes**, y confirma con un diálogo que los
enumera uno por uno con el valor viejo tachado. *Aplica a las diez secciones de
Ajustes, Fiscal, Funciones, Empleados, Zonas.*

**13 · Estado vacío, en cuatro motivos.** Once de las veinticuatro pantallas
dicen hoy «No hay datos» y se callan. Un molde —**ícono · qué no hay · por qué ·
la acción que lo arregla**— y **el motivo decide la acción**: **filtro** → nombra
cuál sacar, no «limpiar todo», porque el dueño llegó desde un enlace y no sabe
qué se aplicó; **función apagada** → nombra la función y lleva a encenderla (la
entrada de navegación desaparece con el flag, pero **la URL sobrevive** en un
marcador y en los avisos de Hoy); **dependencia** → lleva a la pantalla que crea
lo que falta; **error** → qué contestó el servidor y a qué hora, se reintenta sin
perder filtros ni pestaña, y un formulario **queda bloqueado** en vez de dejar
guardar sobre lo que no se leyó. Sus dos hermanos: **cargando** conserva el
armazón y esqueletea sólo los datos, con el ancho y el alto de lo que va a
llegar; **vacío bueno** («Todo al día») es una noticia, no una ausencia. *Aplica
a las 24; la hoja aparte tiene los ocho casos.*

---

## Qué salió de cada una, y dónde me aparté

**De a1**: el armazón sin barra superior y el reparto del alcance; el rótulo de
grupo; la cifra como ecuación con las propinas debajo de la raya; la lectura
escrita de la gráfica; el recuento de la tabla; el colapso de los avisos no
críticos a una línea; el enlace con filtro nombrado en palabras; la lectura de
vuelta del formulario; el vacío por función apagada, el único que entiende que la
URL sobrevive al flag; el reverso «A dónde llega esta pestaña».

**De a2**: el teñido por estado; **«Comensales —»** con su frase intacta; la
gráfica con el lunes pasado de referencia y la hora en curso aparte; los
encabezados de gravedad con recuento; la leyenda al pie; la barra de procedencia;
las marcas de alcance; la escala dibujada; el pie de guardado que no desaparece;
el índice agrupado de Ajustes —diez pestañas no caben en una fila a 1280— y la
hoja de ocho estados.

**Cuatro desvíos que quedan en pie, y uno que revertí:**

1. **Nombres de grupo: no elegí un juego, mezclé.** Registro de a1 (sustantivos
   pelados: 6,2 caracteres de promedio contra 10,2 de a2) con la partición de a2
   (seis grupos). La partición de a2 es mejor porque a1 archivaba «Turnos y
   personal» bajo *Plata* y «Carta» bajo *Operación*, cuando la receta de la
   Carta es lo que convierte un plato en un costo y pertenece con Inventario y
   Compras. El registro de a1 es mejor porque un rótulo de 10,5 px en versalitas
   es una etiqueta, no una frase —y porque el grupo corto es lo que deja acortar
   el ítem (Documentos, Rangos, Devoluciones, Turnos) y sacar el truncado del
   rail.

2. **Las casillas de foto obligatoria van en ámbar, no en el rojo de a2.** El
   argumento es la copia de a2 misma: apagarlas «no avisa a nadie, y la foto
   simplemente deja de pedirse» —reversible, sin pérdida—, mientras rotar el PIN
   no se deshace. Con las dos en rojo, la pantalla tiene dos zonas rojas y
   ninguna quiere decir «esto no se deshace». Queda una roja contra una ámbar. La
   llamada se respeta donde importa: el peligro sigue en el marco y el botón
   sigue azul y secundario.

3. **La navegación lleva `Inventario 14`, no el `9` de a2.** Los recuentos que la
   llamada nombró —Pedidos 9, Compras 2— quedaron literales. El de Inventario no:
   los avisos de Hoy dicen 5 negativos **y** 9 bajo mínimo, y una insignia que
   cuenta sólo uno de los dos sub-informa la pantalla. 5 + 9 = 14, y la pestaña
   Stock dice lo mismo.

4. **Umbrales del cierre: me equivoqué, y está revertido.** Hice bien en no
   copiar la validación de a1 —«no queda ningún monto que pida causa sin ser
   además crítico» es falsa de su propio modelo—, pero la corrección que inventé
   (una cuarta franja sobre **tres** umbrales) era peor que el error: dibujaba el
   editor de un campo que el producto no tiene. `backend/app/shifts/service.py`
   evalúa el cierre con **dos** ajustes y sólo dos —`requires_identified_cause =
   |dif| > tolerance_unknown_cause`, `is_critical = |dif| >=
   critical_difference`—. El tercero, `tolerance_identified_cause`, tiene **cero
   usos de lógica de negocio**: sus únicas apariciones son la migración que lo
   creó, la migración `0022` que lo borra y dos tests que verifican que ya no
   está. Y quien hace desaparecer «Sin identificar» son los **$ 20.000**, no los
   $ 100.000: mi tarjeta se lo atribuía al umbral equivocado. Ahora la sección
   tiene dos campos, tres franjas leídas de ellos, la validación de **orden**
   —la única posible con dos fronteras— y la frase que la spec dice y ninguna
   pantalla decía: *nunca bloquea el cierre*. Lo que quedó del episodio es la
   primera regla del patrón 9: un campo se dibuja si alguna lógica lo lee.

5. **Apliqué `null` ≠ 0 un paso más lejos que a2.** a2 mostraba «Comensales —» y
   al lado un ticket por comensal calculado como si los comensales se supieran.
   Si el total es nulo, el promedio del día no existe: la tarjeta declara
   **$ 19.800 sobre las 117 comandas que sí los contaron**, y deja las 31 de
   mostrador afuera a la vista.

**Sobre el defecto de a1.** Medido: el número de comanda se partía en dos líneas
a 1440 y en **cuatro** a 1280, con la fila creciendo de 34 a 61 px. La corrección
no fue ensanchar esa columna —fue sacar `overflow-wrap:anywhere` de las celdas de
datos y volverlo regla del patrón 8—. Por el mismo criterio, la columna «Desde»
dejó de gastar 130 px en un minuto que a nadie le importa y dice «hace 1 día»,
con la marca de tiempo completa en el `title`.
