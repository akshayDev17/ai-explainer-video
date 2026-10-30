from shop.net import ping


def test_ping_reaches_the_cache():
    # the sandbox denies every connect, localhost included: this test fails and is listed as denied
    assert ping("127.0.0.1", 6379)
