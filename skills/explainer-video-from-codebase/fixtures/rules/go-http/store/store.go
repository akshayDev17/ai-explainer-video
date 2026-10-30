package store

type Store struct{ items map[string]string }

func (s *Store) Delete(id string) { delete(s.items, id) }

func Find(id string) string { return id }
