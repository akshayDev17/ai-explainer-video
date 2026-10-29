import stripe


def charge():
    return stripe.PaymentIntent.create(amount=1)
