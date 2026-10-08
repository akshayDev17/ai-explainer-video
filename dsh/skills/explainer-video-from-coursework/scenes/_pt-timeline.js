window.SCENE_CONFIG = { renderAt: function (t, svg) {
  SceneCore.primitives.timeline(svg, { x: 420, y: 330, w: 1180, laneH: 150, at: 0,
    axisLabel: 'real time',
    tracks: [ { label: 'R1', color: 'client' }, { label: 'R2', color: 'ok' } ],
    events: [ { track: 0, at: 0.10, label: 'write(1)', color: 'client' },
              { track: 1, at: 0.35, label: 'read()', color: 'bad' },
              { track: 0, at: 0.60, label: 'write(2)', color: 'client' },
              { track: 1, at: 0.85, label: 'read()', color: 'ok' } ],
    arrows: [ { from: 0, to: 1, label: 'happens-before' },
              { from: 2, to: 3 } ] }, t);
} };
