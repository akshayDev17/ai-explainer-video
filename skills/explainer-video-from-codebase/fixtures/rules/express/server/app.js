const express = require('express');
const users = require('./routes/users');
const { requireAuth } = require('./middleware');

const app = express();
app.use(express.json());
app.use('/api/users', users);

app.get('/health', (req, res) => res.send('ok'));
app.post('/api/login', requireAuth, login);

function login(req, res) {
  res.json(issueToken(req.body));
}

function issueToken(body) {
  return { token: body.user };
}

if (require.main === module) {
  app.listen(3000);
}

module.exports = app;
