#include "shapes.h"

namespace geo {

Circle::Circle(double r) : r_(r) {}

double Circle::area() const { return 3.14159 * r_ * r_; }

std::unique_ptr<Shape> make_shape(const std::string& kind) {
  if (kind == "circle") return std::make_unique<Circle>(1.0);
  return std::make_unique<Square>(1.0);
}

}  // namespace geo
