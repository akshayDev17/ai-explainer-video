from fastapi import APIRouter, FastAPI

from library.service import LoanService, remove_book, search_books
from library.util import log_event

router = APIRouter(prefix="/v1")


@router.post("/loans")
def borrow(body: dict):
    return LoanService().borrow(body["member"], body["book"], body["days"])


@router.post("/loans/{loan_id}/return")
def give_back(loan_id: str):
    return LoanService().give_back(loan_id)


@router.get("/books/search")
def search(q: str):
    return search_books(q)


@router.delete("/books/{book_id}")
def remove(book_id: str):
    return remove_book(book_id)


@router.get("/health")
def health():
    log_event("health")
    return {"ok": True}


app = FastAPI()
app.include_router(router)
