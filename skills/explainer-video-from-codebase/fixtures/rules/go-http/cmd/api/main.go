package main

import (
	"net/http"
	"sort"

	"example.com/shop/nethttp"
	"example.com/shop/store"
)

func main() {
	s := &store.Store{}
	ids := []string{"b", "a"}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	http.ListenAndServe(":8080", nethttp.NewMux(s))
}
