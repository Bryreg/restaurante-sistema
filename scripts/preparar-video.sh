#!/usr/bin/env bash
# Deja el entorno listo para renderizar video con Hyperframes (el motor que usa
# el skill `brag`). Es idempotente: correrlo dos veces no hace daño.
#
#   scripts/preparar-video.sh            # prepara y verifica
#   scripts/preparar-video.sh --verificar # sólo informa, no instala nada
#
# Por qué existe. Los skills viajan en el repo, pero el motor necesita tres
# cosas del sistema operativo que NO viajan y que en un contenedor nuevo no
# están. Las tres fallan de formas que no se parecen en nada a su causa:
#
#   1. ffmpeg de verdad. Un ffmpeg recortado (el que trae Playwright, por
#      ejemplo, compilado con --disable-everything) encodea webm/VP8 y nada
#      más: no tiene H.264 ni ffprobe, así que el render muere al final,
#      después de gastar todos los frames.
#   2. Un Chromium que el motor pueda arrancar. El que se baja puppeteer suele
#      no arrancar en estos contenedores; hay que apuntarle a uno que sí, con
#      HYPERFRAMES_BROWSER_PATH.
#   3. La CA del proxy en el almacén del navegador. Sin ella el navegador no
#      baja GSAP del CDN y `hyperframes check` falla con
#      ERR_CERT_AUTHORITY_INVALID — que parece un problema de la composición y
#      no lo es.
set -euo pipefail

SOLO_VERIFICAR=false
[[ "${1:-}" == "--verificar" ]] && SOLO_VERIFICAR=true

fallas=0
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
falla() { printf '  \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas + 1)); }
nota()  { printf '    %s\n' "$1"; }

echo "preparar-video: Hyperframes necesita node ≥ 22, ffmpeg con H.264, y un navegador"
echo

# ── 1. Node ───────────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]]; then
  ok "node $(node --version)"
else
  falla "node ≥ 22 (hay: $(command -v node >/dev/null 2>&1 && node --version || echo ninguno))"
  nota "El CLI de Hyperframes declara engines.node >= 22."
fi

# ── 2. ffmpeg con H.264 y ffprobe ─────────────────────────────────────────────
# No alcanza con que `ffmpeg` exista: se pregunta por libx264, que es lo que
# distingue un ffmpeg completo de uno recortado.
# Ojo: `ffmpeg ... | grep -q` acá no sirve. Bajo `set -o pipefail`, grep -q sale
# al primer match, ffmpeg muere con SIGPIPE y el pipeline reporta falla aunque el
# encoder esté. Por eso se captura primero y se busca sobre la variable.
encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
if command -v ffmpeg >/dev/null 2>&1 && [[ "$encoders" == *libx264* ]]; then
  ok "ffmpeg con H.264 ($(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3))"
else
  if $SOLO_VERIFICAR; then
    falla "ffmpeg con H.264"
  else
    echo "  · instalando ffmpeg…"
    if apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null 2>&1 \
       && [[ "$(ffmpeg -hide_banner -encoders 2>/dev/null || true)" == *libx264* ]]; then
      ok "ffmpeg con H.264 instalado"
    else
      falla "no se pudo instalar un ffmpeg con H.264"
      nota "A mano: apt-get install -y ffmpeg (o el equivalente del sistema)."
    fi
  fi
fi
command -v ffprobe >/dev/null 2>&1 && ok "ffprobe" || falla "ffprobe (viene con ffmpeg; sin él no se pueden sondear los assets)"

# ── 3. Un navegador que arranque ──────────────────────────────────────────────
# Se prueba arrancándolo, no viendo si el archivo existe: el binario que baja
# puppeteer existe y aun así no arranca.
arrancable() { [[ -x "$1" ]] && timeout 30 "$1" --version >/dev/null 2>&1; }

if [[ -n "${HYPERFRAMES_BROWSER_PATH:-}" ]] && arrancable "$HYPERFRAMES_BROWSER_PATH"; then
  ok "navegador: \$HYPERFRAMES_BROWSER_PATH"
else
  navegador=""
  for cand in /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell \
              /opt/pw-browsers/chromium-*/chrome-linux/chrome \
              /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
    if arrancable "$cand"; then navegador="$cand"; break; fi
  done
  if [[ -n "$navegador" ]]; then
    ok "navegador: $navegador"
    nota "Exportá esto antes de renderizar (el motor no lo adivina):"
    nota "  export HYPERFRAMES_BROWSER_PATH=$navegador"
  else
    falla "ningún navegador arrancable"
    nota "Probá: npx hyperframes browser ensure --force"
  fi
fi

# ── 4. La CA del proxy en el almacén del navegador ────────────────────────────
# Chrome no lee el almacén del sistema: lee su propia base NSS en ~/.pki/nssdb.
# Que la CA esté en /etc/ssl/certs no dice nada sobre si el navegador la tiene.
if compgen -G "/usr/local/share/ca-certificates/*.crt" >/dev/null; then
  if ! command -v certutil >/dev/null 2>&1; then
    if $SOLO_VERIFICAR; then
      falla "certutil (no se puede revisar el almacén del navegador)"
    else
      apt-get install -y -qq --no-install-recommends libnss3-tools >/dev/null 2>&1 || true
    fi
  fi
  if command -v certutil >/dev/null 2>&1; then
    mkdir -p "$HOME/.pki/nssdb"
    [[ -f "$HOME/.pki/nssdb/cert9.db" ]] || certutil -N --empty-password -d "sql:$HOME/.pki/nssdb" >/dev/null 2>&1 || true
    faltantes=0
    for f in /usr/local/share/ca-certificates/*.crt; do
      n="$(basename "$f" .crt)"
      if ! certutil -L -d "sql:$HOME/.pki/nssdb" -n "$n" >/dev/null 2>&1; then
        faltantes=$((faltantes + 1))
        $SOLO_VERIFICAR || certutil -A -n "$n" -t "C,," -i "$f" -d "sql:$HOME/.pki/nssdb" >/dev/null 2>&1 || true
      fi
    done
    if $SOLO_VERIFICAR && [[ $faltantes -gt 0 ]]; then
      falla "$faltantes CA del proxy fuera del almacén del navegador"
      nota "Sin esto, \`hyperframes check\` falla con ERR_CERT_AUTHORITY_INVALID."
    else
      ok "CA del proxy en el almacén del navegador (~/.pki/nssdb)"
    fi
  fi
else
  ok "sin CA de proxy que instalar"
fi

echo
if [[ $fallas -eq 0 ]]; then
  echo "preparar-video: listo. Verificá el motor con: npx hyperframes doctor"
  exit 0
fi
echo "preparar-video: $fallas sin resolver — mirá las notas de arriba."
exit 1
