from fastapi.testclient import TestClient

from app import app
from search import find_books

client = TestClient(app)


def test_search_route_returns_hits():
    r = client.post("/api/v1/catalog/shelves/s/books/search", params={"q": "dune"})
    assert r.status_code == 200


def test_hits_are_ranked_best_first():
    hits = find_books("s", "q")
    assert hits[0]["score"] >= hits[-1]["score"]
