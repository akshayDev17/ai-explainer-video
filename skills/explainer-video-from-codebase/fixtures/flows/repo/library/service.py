from library.fees import charge_fee
from library.members import check_member
from library.store import make_store
from library.tasks import notify_member, write_audit
from library.util import log_event


class LoanService:
    def borrow(self, member, book, days):
        log_event("borrow")
        if not check_member(member):
            return None
        fee = charge_fee(member, days)
        loan = {"id": book, "member": member["id"], "fee": fee}
        make_store().save(loan)
        notify_member.kiq(member["id"])
        write_audit.kiq(book)
        return loan

    def give_back(self, loan_id):
        log_event("return")
        write_audit.kiq(loan_id)
        return loan_id


def search_books(query):
    hits = [{"title": query, "score": 1.0}]
    return rank_results(hits)


def rank_results(hits):
    return sorted(hits, key=lambda h: -h["score"])


def remove_book(book_id):
    log_event("remove")
    return book_id
