def train(model, data):
    loss = model(data)
    loss.backward()
