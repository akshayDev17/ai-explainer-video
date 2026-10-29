from shop.jobs import nightly_total


def test_nightly_total_runs_the_body(cart):
    assert nightly_total(cart) == 100
