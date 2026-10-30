import socket


def ping(host, port):
    with socket.create_connection((host, port), timeout=1):
        return True
