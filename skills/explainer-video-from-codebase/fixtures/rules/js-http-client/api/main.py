from fastapi import APIRouter, FastAPI

app = FastAPI()
r = APIRouter(prefix="/api/v1")


@r.get("/items")
def list_items():
    return []


@r.get("/items/search")
def search_items(q: str):
    return []


@r.get("/items/count")
def count_items():
    return 0


@r.get("/items/{item_id}")
def get_item(item_id: str):
    return {}


@r.put("/items/{item_id}")
def put_item(item_id: str):
    return {}


@r.delete("/items/{item_id}")
def delete_item(item_id: str):
    return {}


@r.post("/items/{item_id}/tags")
def tag_item(item_id: str):
    return {}


@r.get("/health")
def health():
    return "ok"


app.include_router(r)
