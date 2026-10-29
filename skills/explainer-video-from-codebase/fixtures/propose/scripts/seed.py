from shop.service import OrderService


def seed():
    return OrderService().place({"cents": 1, "id": "seed"})


if __name__ == "__main__":
    seed()
