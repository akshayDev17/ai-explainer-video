def charge_fee(member, days):
    if days > 14:
        return late_fee(days - 14)
    return 0


def late_fee(days):
    return days * 25
