package cart_test

import (
	"testing"

	"example.com/cart/cart"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
)

type mockStore struct{ mock.Mock }

func (m *mockStore) Price(sku string) int { return m.Called(sku).Int(0) }

func TestDBStorePrice(t *testing.T) {
	assert.Equal(t, 3, (&cart.DBStore{}).Price("abc"))
}

func TestWithMock(t *testing.T) {
	m := new(mockStore)
	m.On("Price", "a").Return(7)
	c := cart.New(m)
	c.Add("a")
	a := assert.New(t)
	a.Equal(7, c.Total())
	m.AssertExpectations(t)
}
