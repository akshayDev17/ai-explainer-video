// A coursework `code` scene for the renderer regression guard (design §5.5): two Java panels, a weighted reveal, one
// focus window per panel, side by side, a note and a stage badge. Rendered to stills before and after a change to
// src/scene-code.js; the stills must be byte-identical.
window.SCENE_CONFIG = {
  total: 12,
  chrome: { header: 'Caching: write policies' },
  phases: [{ name: 'READ-THROUGH', from: 0, to: 6 }, { name: 'WRITE-BACK', from: 6 }],
  initLayout: { read: { cx: 560, cy: 560, scale: 0.9 }, write: { cx: 1420, cy: 520, scale: 0.9 } },
  panels: [
    { id: 'read', file: 'Cache.java', accent: 'ok', badge: 'READ', lines: [
      'public String get(String key) {',
      '    String v = cache.get(key);   // hit?',
      '    if (v == null) {',
      '        v = store.load(key);',
      '        cache.put(key, v);',
      '    }',
      '    return v;',
      '}',
    ] },
    { id: 'write', file: 'WriteBack.java', accent: 'bad', badge: 'LOSSY', lines: [
      'void put(String key, String v) {',
      '    cache.put(key, v);',
      '    dirty.add(key);          /* flushed later */',
      '}',
    ] },
  ],
  acts: [
    { op: 'show', panel: 'read', from: 0, to: 0.6 },
    { op: 'reveal', panel: 'read', from: 0.4 },
    { op: 'focus', panel: 'read', lines: [2, 3], from: 3.0, to: 5.5 },
    { op: 'show', panel: 'write', from: 6.5, to: 7.1 },
    { op: 'focus', panel: 'write', lines: [3], from: 8.5, to: 11 },
  ],
  notes: [{ id: 'n1', text: 'a crash before the flush loses this write', accent: 'bad', at: [1400, 820], from: 9, to: 11.5 }],
};
