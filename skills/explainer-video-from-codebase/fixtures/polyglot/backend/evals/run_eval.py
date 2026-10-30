import httpx


def score(hits):
    return sum(1 for h in hits if h["score"] > 0.6)


def run_search_eval(shelf):
    r = httpx.post(f"http://localhost:8000/api/v1/catalog/shelves/{shelf}/books/search", params={"q": "dune"})
    return score(r.json())


def run_stock_eval(isbn):
    r = httpx.get(f"http://localhost:8081/api/v1/stock/{isbn}")
    return r.json() >= 0


if __name__ == "__main__":
    print(run_search_eval("demo"), run_stock_eval("123"))
