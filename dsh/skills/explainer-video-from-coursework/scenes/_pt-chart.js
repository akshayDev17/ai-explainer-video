window.SCENE_CONFIG = { renderAt: function (t, svg) {
  SceneCore.primitives.chart(svg, { type: 'pie', x: 520, y: 560, radius: 210, at: 0, dur: 1.2,
    title: 'Read share',
    data: [ { label: 'Linearizable', value: 3, color: 'ok' },
            { label: 'Causal', value: 3, color: 'client' },
            { label: 'Eventual', value: 2, color: 'hub' } ] }, t);
  SceneCore.primitives.chart(svg, { type: 'bar', x: 1080, y: 400, w: 700, h: 340, at: 0, dur: 1.0,
    title: 'Write latency (ms)',
    data: [ { label: 'LWW', value: 5, color: 'client' },
            { label: 'Vector', value: 22, color: 'hub' },
            { label: 'CRDT', value: 9, color: 'ok' } ] }, t);
} };
