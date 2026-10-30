package svc

import (
	"sort"

	"example.com/res/lib/v2"
	st "example.com/res/store"
)

type Base struct{}

func (b *Base) Log(msg string) {}

type Item struct{ price int }

func (i *Item) Price() int { return i.price }

type Service struct {
	Base
	store st.Store
	items []*Item
	byID  map[string]*Item
}

func (s *Service) less(i, j int) bool { return s.items[i].Price() < s.items[j].Price() }

func (s *Service) background() {}

func cleanup() {}

func (s *Service) Run(v any) string {
	s.Log("run")
	s.store.Get("a")
	x := st.New("mem")
	x.Get("b")
	for _, it := range s.items {
		it.Price()
	}
	s.byID["a"].Price()
	helper := func() { s.Log("helper") }
	helper()
	go s.background()
	defer cleanup()
	sort.Slice(s.items, s.less)
	z := v.(*Item)
	z.Price()
	n := len(s.items)
	_ = n
	return lib.Format("done")
}
