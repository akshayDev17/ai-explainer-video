from library.members import Processor, check_member


class FakeChecker(Processor):
    # a test double: production CHA from Processor.handle reaches it
    def check(self, member):
        return True


def test_inactive_member_is_refused():
    assert check_member({"active": False}) is False
