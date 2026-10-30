package stock

import (
	"errors"
	"os"
)

// Store holds the copies of each book on hand.
type Store interface {
	Level(isbn string) int
	Reserve(isbn string, n int) error
}

type MemStore struct{ levels map[string]int }

func (m *MemStore) Level(isbn string) int { return m.levels[isbn] }

func (m *MemStore) Reserve(isbn string, n int) error {
	if m.levels[isbn] < n {
		return errors.New("out of stock")
	}
	m.levels[isbn] -= n
	return nil
}

type WarehouseStore struct{ url string }

func (w *WarehouseStore) Level(isbn string) int            { return 0 }
func (w *WarehouseStore) Reserve(isbn string, n int) error { return nil }

// Open picks the store the deployment configures.
func Open() Store {
	if os.Getenv("INVENTORY_BACKEND") == "warehouse" {
		return &WarehouseStore{url: os.Getenv("WAREHOUSE_URL")}
	}
	return &MemStore{levels: map[string]int{}}
}
