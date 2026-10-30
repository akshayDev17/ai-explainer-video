package cart

// Store prices an item.
type Store interface {
	Price(sku string) int
}

type Cart struct {
	store Store
	items []string
}

func New(s Store) *Cart { return &Cart{store: s} }

func (c *Cart) Add(sku string) { c.items = append(c.items, sku) }

func (c *Cart) Total() int {
	t := 0
	for _, sku := range c.items {
		t += c.store.Price(sku)
	}
	return Discount(t)
}

func Discount(total int) int {
	if total > 100 {
		return total - 10
	}
	return total
}
