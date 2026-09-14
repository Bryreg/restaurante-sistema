# Restaurante Sistema

POS y control interno para un restaurante de servicio a la mesa: la pantalla del
que toma el pedido y cobra, y el panel del administrador (ventas, inventario,
turnos, dinero, preparaciones, recetas, pedidos).

Construido con el framework de agentes
[`sistemas-maestros`](https://github.com/Bryreg/sistemas-maestros) — la versión
adoptada está en [`.claude/FRAMEWORK`](.claude/FRAMEWORK).

## Orden de lectura

1. [`docs/SPEC-NEGOCIO.md`](docs/SPEC-NEGOCIO.md) — qué hace el sistema y qué reglas no se negocian.
2. [`docs/ESTADO.md`](docs/ESTADO.md) — documento vivo: cómo corre, qué está hecho, dónde retomar.
3. [`AGENTS.md`](AGENTS.md) — lo que este proyecto hace distinto de las reglas globales del framework.
4. `features/<fase>/spec.md` — la spec de cada pedido que se le pasa al orquestador.

## Cómo se construye

Cada fase es un pedido al orquestador del framework:

```js
Workflow({
  scriptPath: '.claude/workflows/orquestador-general.js',
  args: {
    pedido: '...',
    spec: 'features/<fase>/spec.md',
    outputs: 'features/<fase>/outputs',
    contexto: ['docs/ESTADO.md', 'AGENTS.md', 'docs/SPEC-NEGOCIO.md'],
  },
})
```

El Maestro arma el equipo según el pedido; el Conciliador decide si está coherente.
