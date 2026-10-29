from celery import Celery
from taskiq.kicker import AsyncKicker

from worker.broker import broker
from worker.tasks import build_report

app = Celery("demo")


def request_report(report_id):
    app.send_task("reports.build", args=[report_id])


async def kick_by_name(report_id):
    await AsyncKicker(task_name="reports.build", broker=broker, labels={}).kiq(report_id)


def delay_it():
    build_report.delay("x")


def unknown_key():
    app.send_task("reports.missing")
