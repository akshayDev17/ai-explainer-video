const rows = new Map();

exports.find = (id) => rows.get(id);
exports.all = function all() {
  return [...rows.values()];
};
exports.add = (user) => {
  rows.set(user.id, user);
  return user;
};
