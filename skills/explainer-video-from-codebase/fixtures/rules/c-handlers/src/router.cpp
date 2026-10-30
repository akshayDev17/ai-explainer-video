#include <functional>
#include <map>
#include <string>

struct Request { std::string body; };

int list_items(const Request& r) { return 0; }
int create_item(const Request& r) { return 1; }
int health(const Request& r) { return 2; }

class Router {
 public:
  int handle(const std::string& key, const Request& r);
  void add_defaults();
  int handle_extra(const std::string& key, const Request& r) { return extra_[key](r); }
 private:
  std::map<std::string, std::function<int(const Request&)>> extra_;
};

std::map<std::string, std::function<int(const Request&)>> routes = {
  {"GET /items", list_items},
  {"POST /items", [](const Request& r) { return create_item(r); }},
};

int Router::handle(const std::string& key, const Request& r) { return routes.at(key)(r); }

void Router::add_defaults() { extra_["health"] = health; }
