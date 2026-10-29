from shop.mail import send
from shop.pricing import discount


class Cart:
    def __init__(self):
        self.items = []

    def add(self, x):
        self.items.append(x)

    def checkout(self):
        self.add(0)
        send("done")


def total(xs):
    return sum(xs) - discount(xs)
