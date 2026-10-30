package chiapp

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", index)
	r.Route("/accounts", func(r chi.Router) {
		r.Get("/{id:[0-9]+}", getAccount)
		r.With(audit).Post("/", createAccount)
	})
	r.Mount("/admin", adminRouter())
	return r
}

func adminRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/stats", adminStats)
	return r
}

func audit(next http.Handler) http.Handler                 { return next }
func index(w http.ResponseWriter, r *http.Request)         {}
func getAccount(w http.ResponseWriter, r *http.Request)    {}
func createAccount(w http.ResponseWriter, r *http.Request) {}
func adminStats(w http.ResponseWriter, r *http.Request)    {}
