import stripe


def refund():
    return stripe.Refund.create()
