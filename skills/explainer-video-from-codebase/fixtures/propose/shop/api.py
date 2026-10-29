from fastapi import APIRouter, FastAPI

from shop.service import OrderService, RushOrderService, cancel, refund
from shop.util import log_event

router = APIRouter(prefix="/v1")


@router.post("/orders")
def place_order(order: dict):
    log_event("route")
    if order.get("rush"):
        return RushOrderService().place(order)
    return OrderService().place(order)


@router.post("/orders/{order_id}/refund")
def refund_order(order_id: str):
    return refund(order_id)


@router.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str):
    return cancel(order_id)


@router.get("/health")
def health():
    return {"ok": True}


app = FastAPI()
app.include_router(router)
