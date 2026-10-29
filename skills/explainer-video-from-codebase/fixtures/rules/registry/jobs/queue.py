from taskiq.kicker import AsyncKicker

_TASK_NAME_MAP = {"ExportJob": "jobs.export", "CleanupJob": "jobs.cleanup"}


class Queue:
    async def enqueue(self, job):
        name = _TASK_NAME_MAP[type(job).__name__]
        await AsyncKicker(task_name=name, broker=None, labels={}).kiq(job)
