window.SCENE_CONFIG = { renderAt: function (t, svg) {
  SceneCore.primitives.sequence(svg, { x: 220, y: 200, w: 1480, h: 720, at: 0, stagger: 0.5,
    participants: [ { id: 'client', label: 'POST /orders', sub: 'HTTP request' },
                    { id: 'api', label: 'api.orders' },
                    { id: 'queue', label: 'worker.tasks' },
                    { id: 'db', label: 'store.orders' } ],
    messages: [ { from: 'client', to: 'api', label: 'create_order', kind: 'http' },
                { from: 'api', to: 'api', label: 'validate' },
                { from: 'api', to: 'queue', label: 'charge_card', kind: 'queue' },
                { from: 'queue', to: 'db', label: 'save' },
                { from: 'api', to: 'client', label: '202 Accepted', kind: 'return' } ] }, t);
} };
