import email.utils
import http.client
import logging
import logging.config
import logging.handlers

from app.logging import JsonHandler


def run():
    logging.getLogger("app")
    logging.basicConfig()
    logging.config.dictConfig({})
    logging.handlers.RotatingFileHandler("app.log")
    http.client.HTTPConnection("example.org")
    JsonHandler()
    return email.utils.formatdate()
