def rank(hits):
    return sorted(hits, key=lambda h: -h["score"])


def find_books(shelf, q):
    return rank([{"id": f"{shelf}/{q}", "score": 1.0}, {"id": "other", "score": 0.5}])


def find_reviews(shelf, q):
    return rank([{"id": f"review:{shelf}:{q}", "score": 0.7}])
