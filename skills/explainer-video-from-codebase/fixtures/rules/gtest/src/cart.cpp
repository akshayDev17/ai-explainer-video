#include "cart.h"

namespace shop {

static int query(const std::string& sku) { return static_cast<int>(sku.size()); }

int DbPrices::price(const std::string& sku) const { return query(sku); }

Cart::Cart(PriceSource& prices) : prices_(prices) {}

void Cart::add(const std::string& sku) { items_.push_back(sku); }

int Cart::total() const {
  int t = 0;
  for (const auto& sku : items_) t += prices_.price(sku);
  return discount(t);
}

int discount(int total) { return total > 100 ? total - 10 : total; }

}  // namespace shop
