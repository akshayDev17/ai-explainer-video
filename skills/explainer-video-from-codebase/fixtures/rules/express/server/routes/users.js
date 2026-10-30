const { Router } = require('express');
const store = require('../store');

const router = Router();

router.get('/:id', getUser);
router.route('/').get(listUsers).post(createUser);

function getUser(req, res) {
  res.json(store.find(req.params.id));
}

function listUsers(req, res) {
  res.json(store.all());
}

async function createUser(req, res) {
  res.json(store.add(req.body));
}

module.exports = router;
