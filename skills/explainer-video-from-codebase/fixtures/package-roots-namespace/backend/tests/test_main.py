from app.main import handle


def test_handle():
    assert handle() == "x"
