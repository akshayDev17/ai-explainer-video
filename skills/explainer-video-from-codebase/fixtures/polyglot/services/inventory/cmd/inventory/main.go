package main

import (
	"net/http"

	"example.com/inventory/api"
	"example.com/inventory/stock"
)

func main() {
	srv := api.NewServer(stock.Open())
	http.ListenAndServe(":8081", srv.Routes())
}
