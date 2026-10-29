import httpx

from shop.util import fmt_money


def check_orders(base):
    client = httpx.Client()
    resp = client.post(f"{base}/v1/orders", json={"cents": 100, "id": "a"})
    return fmt_money(resp.json()["cents"])


def score(results):
    return len(results)


if __name__ == "__main__":
    print(score([check_orders("http://localhost:8000")]))
