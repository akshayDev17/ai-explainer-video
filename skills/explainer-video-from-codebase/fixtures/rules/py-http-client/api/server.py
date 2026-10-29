from fastapi import APIRouter, FastAPI

router = APIRouter(prefix="/v1")


@router.get("/users/{uid}")
def get_user(uid: str):
    return {"id": uid}


@router.post("/users")
def create_user():
    return {}


app = FastAPI()
app.include_router(router)
