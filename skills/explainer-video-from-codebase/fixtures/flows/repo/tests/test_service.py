from unittest.mock import patch

from library.fees import charge_fee
from library.service import LoanService


@patch("library.service.charge_fee")
def test_borrow_records_the_fee(fee):
    fee.return_value = 50
    loan = LoanService().borrow({"id": "m1", "active": True}, "b1", 20)
    assert loan["fee"] == 50


def test_late_fee_after_two_weeks():
    assert charge_fee({"id": "m1"}, 20) == 150
