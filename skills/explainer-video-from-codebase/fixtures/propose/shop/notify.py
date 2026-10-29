class EmailNotifier:
    def send(self, msg):
        return msg


class SmsNotifier:
    def send(self, msg):
        return msg


def make_notifier(kind):
    # two concrete classes behind one factory: each is a named alternative, not expanded
    if kind == "sms":
        return SmsNotifier()
    return EmailNotifier()
