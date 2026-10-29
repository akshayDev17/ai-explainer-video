from taskiq import InMemoryBroker

broker = InMemoryBroker()


@broker.task(task_name="work.do")
async def do_work():
    return 1


@broker.task(task_name="work.tick", schedule=[{"cron": "* * * * *"}])
async def tick():
    return 2
