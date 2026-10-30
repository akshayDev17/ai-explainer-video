#pragma once
#include <memory>
#include <string>
#include <vector>

namespace shop {

class PriceSource {
 public:
  virtual ~PriceSource() = default;
  virtual int price(const std::string& sku) const = 0;
};

class DbPrices : public PriceSource {
 public:
  int price(const std::string& sku) const override;
};

class Cart {
 public:
  explicit Cart(PriceSource& prices);
  void add(const std::string& sku);
  int total() const;

 private:
  PriceSource& prices_;
  std::vector<std::string> items_;
};

int discount(int total);

}  // namespace shop
