from jobs.models import CleanupJob, ExportJob
from jobs.queue import Queue


async def export(queue: Queue):
    job = ExportJob()
    await queue.enqueue(job)


def describe():
    # constructs a job but never hands it to the queue: not a producer
    return CleanupJob()
