package nethttp

import (
	"net/http"

	"example.com/shop/store"
)

const v1 = "/v1"

type fileServer struct{ root string }

func (f *fileServer) ServeHTTP(w http.ResponseWriter, r *http.Request) { serveFile(f.root, r.URL.Path) }

func serveFile(root, path string) {}

func NewMux(s *store.Store) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", getItem)
	mux.Handle("/health", http.HandlerFunc(health))
	mux.Handle(v1+"/", http.StripPrefix(v1, v1Mux()))
	mux.Handle("POST /items", logged(http.HandlerFunc(createItem)))
	mux.Handle("/files/{path...}", &fileServer{root: "/srv"})
	mux.HandleFunc("DELETE /items/{id}", func(w http.ResponseWriter, r *http.Request) { s.Delete(r.PathValue("id")) })
	http.HandleFunc("/ping", ping)
	return mux
}

func v1Mux() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /stats", stats)
	return m
}

func logged(h http.Handler) http.Handler { return h }

func getItem(w http.ResponseWriter, r *http.Request)    { store.Find(r.PathValue("id")) }
func createItem(w http.ResponseWriter, r *http.Request) {}
func health(w http.ResponseWriter, r *http.Request)     {}
func stats(w http.ResponseWriter, r *http.Request)      {}
func ping(w http.ResponseWriter, r *http.Request)       {}
