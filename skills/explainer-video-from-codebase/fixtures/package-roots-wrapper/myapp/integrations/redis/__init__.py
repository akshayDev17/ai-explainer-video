import redis


class Redis:
    def __init__(self):
        self.client = redis.Redis()


def connect():
    return redis.Redis()
