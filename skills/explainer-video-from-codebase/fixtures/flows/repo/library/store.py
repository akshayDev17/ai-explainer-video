from library.settings import settings


class SqlStore:
    def save(self, loan):
        return {"saved": loan["id"], "via": "sql"}


class MemoryStore:
    def save(self, loan):
        return {"saved": loan["id"], "via": "memory"}


def make_store():
    # the backend is chosen by config: both classes are named alternatives
    if settings.store_backend == "sql":
        return SqlStore()
    return MemoryStore()
