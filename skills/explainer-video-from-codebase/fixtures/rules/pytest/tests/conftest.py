from unittest.mock import patch

import pytest

from shop.cart import Cart


def pytest_configure(config):
    # started once for the whole session: every test below runs with settings replaced
    patch("shop.settings.get_settings", return_value={}).start()


@pytest.fixture
def cart():
    return Cart()


@pytest.fixture(autouse=True)
def no_mail(monkeypatch):
    monkeypatch.setattr("shop.mail.send", lambda message: None)
    yield
