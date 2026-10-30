package api

import (
	"encoding/json"
	"net/http"

	"example.com/inventory/stock"
)

type Server struct {
	stock stock.Store
}

func NewServer(s stock.Store) *Server { return &Server{stock: s} }

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/stock/{isbn}", s.getStock)
	mux.HandleFunc("POST /api/v1/stock/{isbn}/reserve", s.reserve)
	return mux
}

func (s *Server) getStock(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(s.stock.Level(r.PathValue("isbn")))
}

func (s *Server) reserve(w http.ResponseWriter, r *http.Request) {
	if err := s.stock.Reserve(r.PathValue("isbn"), 1); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
	}
}
