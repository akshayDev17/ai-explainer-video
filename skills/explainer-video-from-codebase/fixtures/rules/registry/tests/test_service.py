from jobs.models import ExportJob
from jobs.queue import Queue


async def test_export_enqueues():
    queue = Queue()
    await queue.enqueue(ExportJob())
