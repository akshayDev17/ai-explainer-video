package shop

import "testing"

func TestTotal(t *testing.T) {
	c := NewCart(&Catalog{prices: map[string]int{"a": 30, "b": 20}})
	c.Add("a")
	c.Add("b")
	if got := c.Total(); got != 50 {
		t.Errorf("Total() = %d", got)
	}
}

func TestDiscount(t *testing.T) {
	cases := []struct{ in, out int }{{50, 50}, {200, 180}}
	for _, tc := range cases {
		t.Run("case", func(t *testing.T) {
			if got := Discount(tc.in); got != tc.out {
				t.Errorf("Discount(%d) = %d", tc.in, got)
			}
		})
	}
}

func TestPing(t *testing.T) {
	if err := Ping("127.0.0.1:9"); err != nil {
		t.Fatalf("ping: %v", err)
	}
}
