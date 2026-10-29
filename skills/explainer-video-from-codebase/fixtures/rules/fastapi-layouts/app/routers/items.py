from fastapi import APIRouter

router = APIRouter(prefix="/items")


@router.post("")
def create_item():
    return {}
