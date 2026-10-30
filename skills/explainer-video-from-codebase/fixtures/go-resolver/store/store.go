package store

type Store interface {
	Get(key string) string
}

type memStore struct{ data map[string]string }

func (m *memStore) Get(key string) string { return m.data[key] }

type sqlStore struct{ dsn string }

func (s *sqlStore) Get(key string) string { return s.dsn + key }

// New picks a store: the call sites that use its result are narrowed to these two.
func New(kind string) Store {
	if kind == "sql" {
		return &sqlStore{dsn: "db"}
	}
	return &memStore{}
}
