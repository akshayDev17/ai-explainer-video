from app import __version__, db


def save(row):
    return db, row, __version__
