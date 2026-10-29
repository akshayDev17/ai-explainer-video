from unittest import mock

from app.routers.users import get_user


@mock.patch("app.routers.users.load")
def test_get_user(load):
    assert get_user("1")


def test_over_http(client):
    assert client.get("/api/v1/users/7").status_code == 200
