from unittest.mock import patch

from shop.cart import Cart


def test_total_applies_discount(cart):
    assert cart.total() == 100


@patch("shop.cart.discount_for", return_value=0)
def test_discount_can_be_mocked(discount, cart):
    assert cart.total() == 110
    assert Cart().total() == 0
