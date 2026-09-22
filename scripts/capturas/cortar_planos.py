"""Corta el video grabado en planos, usando las marcas que dejó la grabación.

**Por qué existe este archivo.** La primera vez los cortes se eligieron a ojo
mirando la consola, y un plano quedó 0,7 s corrido: el rótulo «El salón»
terminó encima de un cuadro que ya mostraba el diálogo de comensales. El
rótulo describía el plano equivocado y nadie lo nota hasta que alguien mira
el video con atención.

Acá el corte sale del MISMO número que produjo la grabación
(`marcas.json`, escrito por las dos grabaciones).

**El plano TERMINA en la marca; no empieza en ella.** La foto de cada hito se
tomó después de esperar `espera_ms`, así que la pantalla estuvo quieta en ese
estado desde `t - espera_ms` hasta `t`. Cortar hacia adelante desde `t` entra
en la acción siguiente — y así, en la primera versión de este mismo archivo,
«La mesa queda apartada» terminó mostrando el diálogo de abrir mesa. El
docstring ya decía `t - espera`; el código hacía otra cosa.

Cuando la espera fue corta, el plano se estira **hacia atrás** y sólo hasta la
marca anterior: hacia atrás está la misma pantalla llegando, hacia adelante
está la siguiente.
"""

import json
import subprocess
import sys
from pathlib import Path

#: Qué hito abre cada plano del recorrido, y con qué nombre sale. El orden es
#: el de la grabación; el fin de cada plano es el comienzo del siguiente.
PLANOS = [
    ("01-activar", "p1-entrar"),
    ("04-salon", "p2-salon"),
    ("04b-reservas", "p2b-reserva"),
    ("04d-salon-reservada", "p2c-salon-reservada"),
    ("05-abrir-mesa", "p3-abrir-mesa"),
    ("06-comanda-vacia", "p4-comanda"),
    ("08-pedido-tomado", "p5-pedido"),
    ("09-enviado-a-cocina", "p6-cocina"),
    ("10-cuenta", "p7-cuenta"),
    ("11-propina", "p8-propina"),
    ("12-efectivo-recibido", "p9-cobro"),
    ("13-documento", "p10-documento"),
]

#: Ningún plano más corto que esto: un plano de 1,2 s no se alcanza a leer.
MINIMO = 2.0
#: Ni más largo: después de unos segundos mirando una pantalla quieta, el
#: video se siente lento aunque la pantalla esté bien.
MAXIMO = 6.0


def main() -> None:
    origen = Path(sys.argv[1])  # el .webm que grabó Playwright
    marcas_json = Path(sys.argv[2])  # marcas.json de la misma corrida
    destino = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/clips")
    destino.mkdir(parents=True, exist_ok=True)

    datos = json.loads(marcas_json.read_text(encoding="utf-8"))
    por_nombre = {m["nombre"]: m for m in datos}
    tiempos = sorted(m["t"] for m in datos)

    for hito, salida in PLANOS:
        m = por_nombre.get(hito)
        if m is None:
            print(f"  · falta el hito {hito}: se salta {salida}")
            continue

        # **El plano termina EN la marca, no empieza en ella.** La foto se
        # tomó después de esperar `espera_ms`, así que la pantalla estuvo
        # quieta mostrando ese estado durante esa espera y hasta `t`. Cortar
        # hacia adelante desde `t` entra en la acción siguiente: así fue como
        # «La mesa queda apartada» terminó mostrando el diálogo de abrir mesa.
        fin = m["t"]
        espera = m.get("espera_ms", 1000) / 1000
        inicio = fin - espera

        # Si la espera fue corta, el plano se estira HACIA ATRÁS —nunca hacia
        # adelante— y sólo hasta la marca anterior: hacia atrás está la misma
        # pantalla llegando; hacia adelante está la siguiente.
        anteriores = [t for t in tiempos if t < fin]
        piso = max(anteriores) if anteriores else 0.0
        if fin - inicio < MINIMO:
            inicio = max(piso, fin - MINIMO)
        if fin - inicio > MAXIMO:
            inicio = fin - MAXIMO

        dur = round(fin - inicio, 2)
        if dur < 0.6:
            print(f"  · {salida}: sólo {dur}s de pantalla quieta, se salta")
            continue

        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", str(round(inicio, 2)), "-t", str(dur),
             "-i", str(origen), "-an", "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "20", "-pix_fmt", "yuv420p", str(destino / f"{salida}.mp4")],
            check=True,
        )
        print(f"  ✓ {salida:<22} {inicio:6.2f}s → {fin:6.2f}s  ({dur:4.2f}s)")

    print(f"\n  planos en {destino}")


if __name__ == "__main__":
    main()
