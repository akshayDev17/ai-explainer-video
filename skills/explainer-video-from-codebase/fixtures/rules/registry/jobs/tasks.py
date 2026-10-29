from taskiq import InMemoryBroker

broker = InMemoryBroker()


@broker.task(task_name="jobs.export")
async def export_task(job):
    return job


@broker.task(task_name="jobs.cleanup")
async def cleanup_task(job):
    return job
