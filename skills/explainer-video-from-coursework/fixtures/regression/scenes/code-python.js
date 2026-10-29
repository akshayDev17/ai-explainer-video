// A coursework `code` scene in Python for the renderer regression guard (design §5.5); see code-walk.js.
window.SCENE_CONFIG = {
  total: 8,
  chrome: { header: 'Caching: eviction' },
  phases: [{ name: 'LRU', from: 0 }],
  panels: [
    { id: 'lru', file: 'lru.py', lang: 'python', lines: [
      'def get(self, key):',
      '    if key not in self.items:   # miss',
      '        return None',
      '    self.order.move_to_end(key)',
      '    return self.items[key]',
      '',
      'class LRU(dict):',
      '    """Least recently used first."""',
    ] },
  ],
  acts: [
    { op: 'show', panel: 'lru', from: 0, to: 0.6 },
    { op: 'reveal', panel: 'lru', from: 0.2, stagger: 0.25 },
    { op: 'focus', panel: 'lru', lines: [4], from: 4, to: 7 },
  ],
};
