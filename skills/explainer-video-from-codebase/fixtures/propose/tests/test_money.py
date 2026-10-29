from shop.util import fmt_money


def test_whole():
    assert fmt_money(100) == "1.00"


def test_cents():
    assert fmt_money(5) == "0.05"


def test_zero():
    assert fmt_money(0) == "0.00"


def test_large():
    assert fmt_money(123456) == "1234.56"


def test_negative():
    assert fmt_money(-250) == "-2.50"


def test_odd():
    assert fmt_money(99) == "0.99"
