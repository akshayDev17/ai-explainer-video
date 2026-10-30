package cart

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) { os.Exit(m.Run()) }

type fakeStore struct{ prices map[string]int }

func (f *fakeStore) Price(sku string) int { return f.prices[sku] }

func newCart(t *testing.T) *Cart {
	t.Helper()
	return New(&fakeStore{prices: map[string]int{"a": 1, "b": 2}})
}

func TestTotal(t *testing.T) {
	c := newCart(t)
	c.Add("a")
	c.Add("b")
	if got := c.Total(); got != 3 {
		t.Errorf("Total() = %d, want 3", got)
	}
}

func TestDiscount(t *testing.T) {
	cases := []struct {
		name    string
		in, out int
	}{
		{"small", 50, 50},
		{"edge", 100, 100},
		{"large", 150, 140},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Discount(tc.in); got != tc.out {
				t.Fatalf("Discount(%d) = %d", tc.in, got)
			}
		})
	}
	t.Run("zero", func(t *testing.T) {
		if Discount(0) != 0 {
			t.Error("zero")
		}
	})
}

func testHelperNotATest(t *testing.T) {}
