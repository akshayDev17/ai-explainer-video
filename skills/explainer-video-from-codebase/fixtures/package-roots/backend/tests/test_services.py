from unittest.mock import patch

from app.main import handle
from app.services import send


@patch("app.services.send")
def test_handle(send_mock):
    assert handle() is not None


def test_send():
    assert send("z") == "z"
