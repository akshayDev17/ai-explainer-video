package shop

type Pricer interface{ Price(sku string) int }

type Catalog struct{ prices map[string]int }

func (c *Catalog) Price(sku string) int { return c.prices[sku] }

type Cart struct {
	pricer Pricer
	items  []string
}

func NewCart(p Pricer) *Cart { return &Cart{pricer: p} }

func (c *Cart) Add(sku string) { c.items = append(c.items, sku) }

func (c *Cart) Total() int {
	t := 0
	for _, s := range c.items {
		t += c.pricer.Price(s)
	}
	return Discount(t)
}

func Discount(total int) int {
	if total >= 100 {
		return total - total/10
	}
	return total
}

func Unused() int { return 42 }
