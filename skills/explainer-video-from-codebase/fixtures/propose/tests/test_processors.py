from unittest.mock import patch

from shop.processors import BaseProcessor, OrderProcessor
from shop.service import run_processor


class FakeProcessor(BaseProcessor):
    # a test double: it overrides the production hook, so CHA from production reaches it
    def _run(self, order):
        return {"fake": True}


def test_run_processor_uses_the_hook():
    assert run_processor(FakeProcessor(), {"id": "a"}) == {"fake": True}


@patch("shop.processors.log_event")
def test_order_processor_runs(log):
    assert OrderProcessor()._run({"id": "a"}) == {"id": "a"}
