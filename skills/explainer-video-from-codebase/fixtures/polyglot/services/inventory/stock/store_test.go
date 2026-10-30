package stock

import "testing"

func TestMemStoreReserve(t *testing.T) {
	m := &MemStore{levels: map[string]int{"123": 1}}
	if err := m.Reserve("123", 1); err != nil {
		t.Fatal(err)
	}
	if m.Level("123") != 0 {
		t.Error("level not decremented")
	}
}
