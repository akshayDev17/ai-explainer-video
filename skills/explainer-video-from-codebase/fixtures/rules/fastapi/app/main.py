from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.routers import items


@asynccontextmanager
async def lifespan(app):
    yield


app = FastAPI(lifespan=lifespan)
app.include_router(items.router, prefix="/api/v1")
