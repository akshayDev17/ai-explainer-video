from fastapi import APIRouter, FastAPI

from imports import job_state, queue_import
from search import find_books, find_reviews

app = FastAPI()
catalog = APIRouter(prefix="/catalog")
ingest = APIRouter(prefix="/ingest")


@catalog.post("/shelves/{shelf}/books/search")
def search_books(shelf: str, q: str):
    return find_books(shelf, q)


@catalog.post("/shelves/{shelf}/reviews/search")
def search_reviews(shelf: str, q: str):
    return find_reviews(shelf, q)


@ingest.post("/shelves/{shelf}/books/import")
def import_shelf_books(shelf: str):
    return queue_import(shelf)


@ingest.get("/jobs/{job_id}")
def get_import_job(job_id: str):
    return job_state(job_id)


app.include_router(catalog, prefix="/api/v1")
app.include_router(ingest, prefix="/api/v1")
