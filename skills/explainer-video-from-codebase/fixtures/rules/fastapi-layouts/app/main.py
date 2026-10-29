from fastapi import FastAPI

from app.api import api_router
from app.routers.items import router as items_router


def create_app():
    app = FastAPI()
    app.include_router(api_router, prefix="/api/v1")
    app.include_router(items_router, prefix="/shop")

    @app.get("/health")
    def health():
        return {"ok": True}

    return app
