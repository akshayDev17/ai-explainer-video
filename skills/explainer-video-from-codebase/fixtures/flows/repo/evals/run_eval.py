import httpx


def check_borrow(base):
    client = httpx.Client()
    resp = client.post(f"{base}/v1/loans", json={"member": {"id": "m"}, "book": "b", "days": 3})
    return grade(resp.json())


def grade(loan):
    return 1.0 if loan else 0.0


if __name__ == "__main__":
    print(check_borrow("http://localhost:8000"))
