"""Arma la composición del recorrido leyendo la duración real de cada plano.

Escribir los `data-start` a mano es pedir un error de aritmética: un plano que
dura 2,9 s y no 2,2 corre todo lo que viene después, y el rótulo termina
hablando del plano siguiente. Eso ya pasó una vez. Acá las duraciones se leen
con `ffprobe` y los inicios se acumulan solos.
"""
import shutil
import subprocess
from pathlib import Path

CLIPS = Path("/tmp/clips")
#: La composición se arma relativa al repo, no a una ruta absoluta de una
#: máquina: este guion tiene que correr en cualquier clon.
RAIZ = Path(__file__).resolve().parents[2]
DESTINO = RAIZ / "brag-output-recorrido" / "composition"

#: Fuentes y música NO se versionan con la composición —el video entero está en
#: `.gitignore`— así que el guion las trae de donde viven de verdad: los assets
#: de la skill. Antes estaban sueltas adentro de la carpeta de salida y bastaba
#: con borrar esa carpeta para dejar la tubería escribiendo un `index.html` que
#: apunta a archivos que no existen, sin que nada fallara hasta el render.
SKILL = RAIZ / ".claude" / "skills" / "brag" / "assets"
#: Tipografía del producto: la misma que usa la app, por legibilidad.
FUENTES = {
    "atkinson-400.woff2": RAIZ / "frontend" / "node_modules" / "@fontsource"
    / "atkinson-hyperlegible" / "files" / "atkinson-hyperlegible-latin-400-normal.woff2",
    "atkinson-700.woff2": RAIZ / "frontend" / "node_modules" / "@fontsource"
    / "atkinson-hyperlegible" / "files" / "atkinson-hyperlegible-latin-700-normal.woff2",
}
MUSICA = "happy-beats-business-moves-vol-12-by-ende-dot-app.mp3"

#: (archivo, cinta, título, subtítulo). El orden es el del video.
PLANOS = [
    ("p1-entrar", "Salón · tablet", "Cada quien entra con su nombre",
     "El PIN personal atribuye toda acción a una persona"),
    ("p2-salon", "Salón · tablet", "El salón, de un vistazo",
     "Libres, ocupadas y por cuánto va cada una"),
    ("p2b-reserva", "Salón · tablet", "Suena el teléfono",
     "Apartar una mesa a una hora, a nombre de alguien"),
    ("p2c-salon-reservada", "Salón · tablet", "La mesa queda apartada",
     "Punteada en el plano, pero sigue libre: el cliente puede llegar antes, o no llegar"),
    ("p3-abrir-mesa", "Salón · tablet", "Abrir mesa: dos toques",
     "Comensales, y la comanda ya existe"),
    ("p4-comanda", "Salón · tablet", "La carta, a un toque",
     "Por categoría, con favoritos y buscador"),
    ("p5-pedido", "Salón · tablet", "Tomar el pedido",
     "Con término de la carne, curso y nota: el plato está modelado, no es un precio suelto"),
    ("p6-cocina", "Salón · tablet", "Marchar a cocina",
     "Cocina lo ve al instante, plato por plato"),
    ("p7-cuenta", "Salón · tablet", "Presentar la cuenta",
     "Se puede dividir por partes iguales o por ítems"),
    ("p8-propina", "Salón · tablet", "La propina se pregunta",
     "Voluntaria y separada de la venta — Ley 1935 de 2018"),
    ("p9-cobro", "Salón · tablet", "Cobrar",
     "Efectivo, tarjeta o transferencia. El PIN es la firma"),
    ("p10-documento", "Salón · tablet", "Documento equivalente POS",
     "Consecutivo sin huecos e impuesto discriminado, no sumado"),
    ("__cartela2__", "", "", ""),
    ("a1-hoy", "Administración · PC", "El día, en curso",
     "Ventas netas, ticket promedio y venta por hora"),
    # El rótulo NO dice cuántos meses: la base de la demo puede tener seis
    # semanas o seis meses según con qué se generó, y un rótulo que dice
    # «seis meses» sobre una gráfica de seis semanas es una mentira que
    # cualquiera verifica mirando el eje.
    ("a2-ventas", "Administración · PC", "La venta, día por día",
     "Por canal y por medio de pago, con el período que elijas"),
    ("a3-dinero", "Administración · PC", "La caja, turno por turno",
     "Esperado, contado, diferencia y su causa"),
    # El rótulo NO promete margen para todo: la pantalla clasifica con el
    # costo CONGELADO en cada venta, y un plato sin receta cargada sale «sin
    # clasificar» con el motivo escrito. Prometer «con qué margen» sobre una
    # tabla donde trece de diecisiete dicen que no se puede calcular es
    # exactamente la clase de rótulo que se desmiente mirando el plano.
    ("a4-analitica", "Administración · PC", "Ingeniería de menú",
     "Estrella, caballo de batalla o perro: qué conviene vender y qué falta costear"),
    ("a5-inventario", "Administración · PC", "Inventario real",
     "Insumos, conteos y consumo teórico contra el real"),
    ("a6-gastos", "Administración · PC", "Obligaciones y gastos",
     "Lo que vence, lo que ya salió y lo que falta"),
    ("a7-atencion", "Administración · PC", "Requiere tu atención",
     "No espera a que preguntes: te dice qué revisar hoy"),
]

CARTELA_1 = 5.2
CARTELA_2 = 3.5
CARTELA_3 = 5.0


def duracion(nombre: str) -> float:
    salida = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(CLIPS / f"{nombre}.mp4")]
    )
    return round(float(salida), 2)


def main() -> None:
    # **Los planos se COPIAN acá, no a mano.** El `index.html` que se escribe
    # abajo apunta a `assets/clips/`, y si esa carpeta se queda con los
    # recortes de la corrida anterior el render sale con footage viejo y
    # rótulos nuevos —sin que nada falle y sin que se note hasta mirarlo—.
    # Las duraciones se leen de `/tmp/clips`, así que la carpeta de destino
    # tiene que ser exactamente esa.
    # Fuentes y música primero: sin ellas el `index.html` que se escribe abajo
    # apunta a archivos que no existen y el render sale sin tipografía ni audio.
    for nombre, origen in FUENTES.items():
        destino = DESTINO / "assets" / "fonts" / nombre
        destino.parent.mkdir(parents=True, exist_ok=True)
        if not destino.exists():
            if not origen.exists():
                raise SystemExit(
                    f"falta la fuente {origen}. Corré `npm install` en frontend/."
                )
            shutil.copy2(origen, destino)
    destino_musica = DESTINO / "assets" / "music" / MUSICA
    destino_musica.parent.mkdir(parents=True, exist_ok=True)
    if not destino_musica.exists():
        origen_musica = SKILL / "music" / MUSICA
        if not origen_musica.exists():
            raise SystemExit(f"falta la música {origen_musica}.")
        shutil.copy2(origen_musica, destino_musica)

    destino_clips = DESTINO / "assets" / "clips"
    destino_clips.mkdir(parents=True, exist_ok=True)
    for viejo in destino_clips.glob("*.mp4"):
        viejo.unlink()
    copiados = 0
    for nuevo in sorted(CLIPS.glob("*.mp4")):
        shutil.copy2(nuevo, destino_clips / nuevo.name)
        copiados += 1
    print(f"  {copiados} planos copiados a {destino_clips}")

    t = CARTELA_1
    videos, rotulos, inicio_cartela2 = [], [], None

    for archivo, cinta, titulo, sub in PLANOS:
        if archivo == "__cartela2__":
            inicio_cartela2 = round(t, 2)
            t = round(t + CARTELA_2, 2)
            continue
        d = duracion(archivo)
        vid_id = archivo.split("-")[0]
        videos.append(
            f'      <video id="{vid_id}" class="clip plano" src="assets/clips/{archivo}.mp4" '
            f'data-start="{round(t, 2)}" data-duration="{d}" data-track-index="0" muted playsinline></video>'
        )
        # El rótulo entra 0,3 s después del corte y se retira 0,35 s antes del
        # siguiente: así ningún rótulo pisa el plano que no le toca.
        r_ini, r_dur = round(t + 0.3, 2), round(d - 0.65, 2)
        clase = " admin" if cinta.startswith("Admin") else ""
        rotulos.append((f"r-{vid_id}", r_ini, r_dur, clase, cinta, titulo, sub))
        t = round(t + d, 2)

    total = round(t + CARTELA_3, 2)
    inicio_cartela3 = round(t, 2)

    html_rotulos = "\n".join(
        f'      <div id="{rid}" class="clip rotulo" data-start="{ini}" data-duration="{dur}" data-track-index="1">\n'
        f'        <span class="cinta{clase}">{cinta}</span>\n'
        f'        <div class="frase">{tit}<small>{sub}</small></div>\n'
        f"      </div>"
        for rid, ini, dur, clase, cinta, tit, sub in rotulos
    )
    js_rotulos = ",\n        ".join(
        f'["#{rid}", {ini}, {dur}]' for rid, ini, dur, *_ in rotulos
    )

    plantilla = Path(__file__).with_name("plantilla-recorrido.html").read_text(encoding="utf-8")
    html = (
        plantilla.replace("{{DURACION}}", str(total))
        .replace("{{CARTELA2_INICIO}}", str(inicio_cartela2))
        .replace("{{CARTELA3_INICIO}}", str(inicio_cartela3))
        .replace("{{CARTELA1_FIN}}", str(round(CARTELA_1 - 0.35, 2)))
        .replace("{{CARTELA2_FIN}}", str(round(inicio_cartela2 + CARTELA_2 - 0.32, 2)))
        .replace("{{VIDEOS}}", "\n".join(videos))
        .replace("{{ROTULOS}}", html_rotulos)
        .replace("{{JS_ROTULOS}}", js_rotulos)
        .replace("{{C2A}}", str(round(inicio_cartela2 + 0.15, 2)))
        .replace("{{C2B}}", str(round(inicio_cartela2 + 0.7, 2)))
        .replace("{{C3A}}", str(round(inicio_cartela3 + 0.25, 2)))
        .replace("{{C3B}}", str(round(inicio_cartela3 + 0.9, 2)))
    )
    DESTINO.mkdir(parents=True, exist_ok=True)
    (DESTINO / "index.html").write_text(html, encoding="utf-8")

    print(f"  duración total: {total}s")
    print(f"  cartela 2 en {inicio_cartela2}s · cartela 3 en {inicio_cartela3}s")
    print(f"  {len(videos)} planos, {len(rotulos)} rótulos")


if __name__ == "__main__":
    main()
