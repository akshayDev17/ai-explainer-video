import app.services as services
from app.services import send


def handle():
    send("x")
    return services.send("y")
