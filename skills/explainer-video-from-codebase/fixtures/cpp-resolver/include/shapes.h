#pragma once
#include <memory>
#include <string>

namespace geo {

class Shape {
 public:
  virtual ~Shape() = default;
  virtual double area() const = 0;
};

class Circle : public Shape {
 public:
  explicit Circle(double r);
  double area() const override;

 private:
  double r_;
};

class Square : public Shape {
 public:
  explicit Square(double side) : side_(side) {}
  double area() const override { return side_ * side_; }

 private:
  double side_;
};

std::unique_ptr<Shape> make_shape(const std::string& kind);

}  // namespace geo
