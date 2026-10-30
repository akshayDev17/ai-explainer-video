package api

import (
	"errors"
	"net/http/httptest"
	"testing"
)

type fakeStock struct{ left int }

func (f *fakeStock) Level(isbn string) int { return f.left }

func (f *fakeStock) Reserve(isbn string, n int) error {
	if f.left < n {
		return errors.New("out")
	}
	f.left -= n
	return nil
}

func TestGetStock(t *testing.T) {
	s := NewServer(&fakeStock{left: 3})
	w := httptest.NewRecorder()
	s.getStock(w, httptest.NewRequest("GET", "/api/v1/stock/123", nil))
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
}

func TestReserve(t *testing.T) {
	cases := []struct {
		name string
		left int
		code int
	}{
		{"in stock", 1, 200},
		{"sold out", 0, 409},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := NewServer(&fakeStock{left: tc.left})
			w := httptest.NewRecorder()
			s.reserve(w, httptest.NewRequest("POST", "/api/v1/stock/123/reserve", nil))
			if w.Code != tc.code {
				t.Errorf("got %d, want %d", w.Code, tc.code)
			}
		})
	}
}
