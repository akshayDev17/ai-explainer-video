from library.service import LoanService


def seed():
    return LoanService().borrow({"id": "seed", "active": True}, "b0", 1)


if __name__ == "__main__":
    seed()
