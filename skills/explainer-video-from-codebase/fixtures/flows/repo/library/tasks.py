from library.broker import broker
from library.util import log_event


@broker.task(task_name="loans.notify")
def notify_member(member_id):
    log_event("notify")
    return format_notice(member_id)


def format_notice(member_id):
    return f"member {member_id}: your loan is ready"


@broker.task(task_name="loans.audit")
def write_audit(loan_id):
    log_event("audit")
    return loan_id
