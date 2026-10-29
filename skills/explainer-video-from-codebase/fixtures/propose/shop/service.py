from shop.notify import make_notifier
from shop.processors import BaseProcessor, OrderProcessor
from shop.retry import with_retry
from shop.tasks import ship_order
from shop.util import fmt_money, log_event


def run_processor(processor: BaseProcessor, order):
    log_event("run")
    return processor.process(order)


class OrderService:
    def place(self, order):
        log_event("place")
        total = fmt_money(order["cents"])
        run_processor(OrderProcessor(), order)
        ship_order.kiq(order["id"])
        notifier = make_notifier(order.get("via"))
        notifier.send("placed")
        return total


def refund(order_id):
    def _do():
        return log_event("refund " + order_id)

    return with_retry(_do)


def cancel(order_id):
    def _undo():
        return log_event("cancel " + order_id)

    return with_retry(_undo)
