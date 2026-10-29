class Processor:
    def handle(self, member):
        return self.check(member)

    def check(self, member):
        return True


class MemberChecker(Processor):
    def check(self, member):
        return member.get("active", False)


def check_member(member):
    return MemberChecker().handle(member)
