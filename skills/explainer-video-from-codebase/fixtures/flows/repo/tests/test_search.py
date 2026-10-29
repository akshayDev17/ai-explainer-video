from library.service import rank_results, search_books


def test_rank_results_puts_the_best_hit_first():
    hits = [{"score": 0.2}, {"score": 0.9}]
    assert rank_results(hits)[0]["score"] == 0.9


def test_search_returns_hits():
    assert search_books("dune")
