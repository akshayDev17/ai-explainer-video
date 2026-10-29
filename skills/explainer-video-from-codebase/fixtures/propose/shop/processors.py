from shop.util import log_event


class BaseProcessor:
    def process(self, order):
        log_event("process")
        return self._run(order)

    def _run(self, order):
        raise NotImplementedError


class OrderProcessor(BaseProcessor):
    def _run(self, order):
        log_event("order")
        return order
