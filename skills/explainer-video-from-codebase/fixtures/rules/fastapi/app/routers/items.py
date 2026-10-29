from typing import Annotated

from fastapi import APIRouter, Depends

from app.deps import Store, get_clock, get_store

router = APIRouter(prefix="/items")
StoreDep = Annotated[Store, Depends(get_store)]


@router.get("/{item_id}")
async def read_item(item_id: str, store: StoreDep):
    return store.load(item_id)


@router.post("")
async def create_item(clock=Depends(get_clock)):
    return clock.now()
