import app.services as services
from app.services import send


def handle():
    send("x")
    return services.send("y")


def route():
    import app.api.routes
    from app.api.routes import h

    h()
    return app.api.routes.h()
