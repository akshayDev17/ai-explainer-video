#include <vector>
#include "shapes.h"

using namespace geo;

class Report {
 public:
  void add(std::unique_ptr<Shape> s);
  double total() const;

 private:
  void log() const {}
  std::vector<std::unique_ptr<Shape>> shapes_;
};

void Report::add(std::unique_ptr<Shape> s) {
  log();
  this->log();
  shapes_.push_back(std::move(s));
}

double area_of(const Shape& s) { return s.area(); }

double Report::total() const { return 0; }

int run() {
  Circle c(2.0);
  c.area();
  auto s = make_shape("circle");
  s->area();
  Report r;
  r.add(std::move(s));
  auto* sq = new Square(3.0);
  return static_cast<int>(r.total() + area_of(*sq));
}
