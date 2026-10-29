class Config:
    debug = False


class User:
    class Config:
        orm_mode = True

    def save(self):
        return 1


class Item:
    class Config:
        extra = "forbid"

        def describe(self):
            return "item"


def build():
    class Impl:
        def run(self):
            return 1

    impl = Impl()
    return impl.run()


def default_config():
    return Config()
