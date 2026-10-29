from worker.broker import broker


@broker.task(task_name="reports.build")
async def build_report(report_id: str):
    return report_id


@broker.task(task_name="reports.nightly", schedule=[{"cron": "0 2 * * *"}])
async def nightly():
    await build_report.kiq("all")
