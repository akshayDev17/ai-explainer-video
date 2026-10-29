from fastapi import APIRouter

router = APIRouter(tags=["users"])


def load(user_id):
    return {"id": user_id}


@router.get("/{user_id}")
def get_user(user_id: str):
    return load(user_id)
