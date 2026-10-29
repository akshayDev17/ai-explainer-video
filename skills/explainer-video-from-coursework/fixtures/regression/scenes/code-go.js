// A coursework `code` scene that sets lang "go": the one stated exception (design §5.5). Before the change it is
// coloured with the Java rules; after, with Go's. Its stills are expected to differ; every other still must not.
window.SCENE_CONFIG = {
  total: 6,
  chrome: { header: 'Caching in Go' },
  panels: [
    { id: 'get', file: 'cache.go', lang: 'go', lines: [
      'func (c *Cache) Get(key string) (string, bool) {',
      '	v, ok := c.items[key] // hit?',
      '	if !ok {',
      '		return "", false',
      '	}',
      '	return v, true',
      '}',
    ] },
  ],
  acts: [
    { op: 'show', panel: 'get', from: 0, to: 0.6 },
    { op: 'focus', panel: 'get', lines: [2], from: 2, to: 5 },
  ],
};
