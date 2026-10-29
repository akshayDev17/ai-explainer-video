from celery import shared_task


@shared_task
def job():
    return 1
