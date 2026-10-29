from contextlib import asynccontextmanager

from fastapi import FastAPI


@asynccontextmanager
async def lifespan(app):
    yield


app = FastAPI(lifespan=lifespan)
