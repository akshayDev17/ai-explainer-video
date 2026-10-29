from shop.broker import broker
from shop.util import log_event


@broker.task(task_name="orders.ship")
def ship_order(order_id):
    log_event("ship")
    return order_id
