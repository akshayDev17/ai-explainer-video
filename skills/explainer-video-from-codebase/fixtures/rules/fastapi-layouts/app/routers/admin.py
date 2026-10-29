from fastapi import APIRouter


class AppRouter(APIRouter):
    pass


router = AppRouter(prefix="/admin")


@router.get("/stats")
def stats():
    return {}
