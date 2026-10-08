window.SCENE_CONFIG = { renderAt: function (t, svg) {
  SceneCore.primitives.hubSpoke(svg, { x: 960, y: 540, radius: 330, at: 0, stagger: 0.3,
    label: 'Event Bus', sub: 'one broker, many consumers',
    spokes: [ { label: 'CQRS', color: 'client' }, { label: 'Event Sourcing', color: 'ok' },
              { label: 'CDC', color: 'hub' }, { label: 'Sagas', color: 'client' },
              { label: 'Streams', color: 'ok' } ] }, t);
} };
