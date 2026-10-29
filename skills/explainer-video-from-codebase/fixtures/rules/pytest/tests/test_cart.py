import unittest
from unittest.mock import patch

import pytest

from shop import pricing
from shop.cart import Cart, total
from shop.mail import send
from shop.settings import get_settings


def _sum_two():
    return total([1, 2])


def test_add(cart):
    cart.add(3)
    assert cart.items == [3]


@patch("shop.cart.discount")
def test_total_ignores_mocked_discount(mock_discount):
    mock_discount.return_value = 0
    assert total([1, 2]) == 3


def test_through_a_helper():
    assert _sum_two() == 3


def test_patch_object():
    with patch.object(Cart, "add"):
        c = Cart()
        c.add(1)
        c.checkout()


def test_mail_is_mocked_for_everyone():
    send("hello")


def test_settings_are_mocked_for_the_session():
    assert get_settings() == {}


class TestPricing:
    @pytest.fixture
    def rate(self):
        return 2

    def test_price(self, rate):
        assert pricing.price(1, rate) == 2


class CartCase(unittest.TestCase):
    def test_starts_empty(self):
        self.assertEqual(Cart().items, [])
