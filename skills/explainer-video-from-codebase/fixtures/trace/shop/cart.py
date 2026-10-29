class Cart:
    def __init__(self):
        self.items = []

    def add(self, sku, price):
        self.items.append((sku, price))
        return self

    def total(self):
        return apply_discount(sum(price for _, price in self.items))


def apply_discount(amount):
    return amount - discount_for(amount)


def discount_for(amount):
    return 10 if amount >= 100 else 0
