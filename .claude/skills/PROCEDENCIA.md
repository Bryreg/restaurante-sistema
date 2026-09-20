# De dónde salieron estos skills

Los 7 skills de diseño vienen de **`nextlevelbuilder/ui-ux-pro-max-skill`**
(MIT, © Next Level Builder). Llegaron acá indirectamente, vía
`retail-espacios`, y en el camino se perdió casi todo: ver el renglón del
CHANGELOG de `sistemas-maestros` 2.3.0.

## Cómo actualizarlos

```bash
npm install -g ui-ux-pro-max-cli
cd /ruta/al/proyecto
uipro init --ai claude --force
```

El instalador escribe **sólo** `.claude/skills/` y no toca nada más del
proyecto — verificado corriéndolo en un directorio vacío antes de usarlo acá.

## Contra qué se verificó (2026-09-20, CLI 2.15.0)

Se comparó archivo por archivo lo que hay acá contra lo que genera
`uipro init --ai claude` recién instalado:

- `data/`, `scripts/`, `references/` y `templates/` de las 7 skills:
  **idénticos**.
- Los 7 `SKILL.md` difieren, y sólo en esto:
  - la metadata `author`/`version`/`origin` que agregó el framework;
  - relleno de espacios en dos tablas markdown (`banner-design`,
    `design-system`);
  - en `design`, una tabla de ruteo reflowada;
  - en `ui-ux-pro-max`, la sección «When to Apply», que acá está **traducida
    al inglés** y upstream sigue en chino.

O sea: lo instalado es funcionalmente la versión canónica. La traducción es
una divergencia local deliberada; un `uipro init --force` la pisa.

## Lo que NO trae el CLI

El repositorio upstream tiene además `ui-styling/canvas-fonts/` — 82 archivos,
5,6 MB de TTF para el render por canvas. El CLI no los instala y acá no se
usan. Si alguna vez hace falta esa capacidad, salen de
`https://github.com/nextlevelbuilder/ui-ux-pro-max-skill`.

## Verificación de que funciona

No alcanza con que los archivos estén. El chequeo real es que la skill
produzca:

```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<producto>" --design-system
```

Tiene que devolver patrón, estilo, el set completo de tokens de color, el par
tipográfico con su URL de Google Fonts, efectos, lista de «avoid» y checklist
de pre-entrega. Si devuelve `Found: 0 results`, la consulta no pegó en la base
— **eso no es un resultado vacío, es una consulta equivocada**, y la propia
skill lo dice.
