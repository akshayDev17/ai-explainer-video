import pytest

from shop.cart import Cart


@pytest.fixture
def cart():
    return Cart().add("a", 60).add("b", 50)
