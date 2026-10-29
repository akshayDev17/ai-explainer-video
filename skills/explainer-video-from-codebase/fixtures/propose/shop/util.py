def log_event(name):
    # eight production callers and no callees: folded as a helper
    return name


def fmt_money(cents):
    # one production caller and six test callers: test fan-in must not fold it
    return f"{cents / 100:.2f}"
