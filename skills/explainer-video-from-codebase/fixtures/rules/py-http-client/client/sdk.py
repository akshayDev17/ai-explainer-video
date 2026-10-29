import httpx
import requests


class Client:
    def __init__(self, base_url):
        self.base_url = base_url
        self.http = httpx.Client()

    def user(self, uid):
        return self.http.get(f"{self.base_url}/v1/users/{uid}")

    def create(self):
        url = "/v1/users"
        return self.http.post(url, json={})

    def no_such_route(self):
        return self.http.get("/v1/nope")


def delete_user(uid):
    return requests.delete(f"https://svc.example.com/v1/users/{uid}")
