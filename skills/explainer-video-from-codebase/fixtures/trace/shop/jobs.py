def run_with_retry(fn, attempts=2):
    for _ in range(attempts):
        try:
            return fn()
        except ValueError:
            continue
    raise RuntimeError("gave up")


def nightly_total(cart):
    def _body():
        return cart.total()

    return run_with_retry(_body)
