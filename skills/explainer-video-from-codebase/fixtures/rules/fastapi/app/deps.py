class Store:
    def load(self, item_id):
        raise NotImplementedError


class MemoryStore(Store):
    def load(self, item_id):
        return {"id": item_id}


def get_store() -> Store:
    return MemoryStore()


class Clock:
    def now(self):
        return 0


def get_clock():
    return Clock()
