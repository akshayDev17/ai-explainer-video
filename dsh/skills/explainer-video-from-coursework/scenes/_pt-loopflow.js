window.SCENE_CONFIG = { renderAt: function (t, svg) {
  SceneCore.primitives.loopFlow(svg, { at: 0, lap: 6, packetCount: 4, bow: 0.22,
    nodes: [ { x: 960, y: 300, label: 'Command' },
             { x: 1400, y: 540, label: 'Event Store' },
             { x: 960, y: 780, label: 'Projection' },
             { x: 520, y: 540, label: 'Query' } ] }, t);
} };
