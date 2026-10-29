class Executor:
    def run(self):
        return 1


def create_executor():
    return Executor()


class Runner:
    def __init__(self, executor=None):
        # B18: the attribute is typed by its default
        self.executor = executor or create_executor()

    def go(self):
        return self.executor.run()


class FastStrategy:
    def ensure(self):
        return "fast"


class SlowStrategy:
    def ensure(self):
        return "slow"


class Manager:
    def __init__(self, name):
        # B19: the receiver is set by a self-method factory
        self.strategy = self._create_strategy(name)

    def _create_strategy(self, name):
        if name == "fast":
            return FastStrategy()
        return SlowStrategy()

    def ensure(self):
        return self.strategy.ensure()


class Base:
    def save(self):
        return "base"


class Child(Base):
    def save(self):
        return super().save()
