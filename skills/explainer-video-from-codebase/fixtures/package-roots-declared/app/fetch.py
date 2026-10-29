import httpx


def fetch():
    return httpx.get("https://example.org")
