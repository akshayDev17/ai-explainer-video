#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "cart.h"

class MockPrices : public shop::PriceSource {
 public:
  MOCK_METHOD(int, price, (const std::string& sku), (const, override));
};

class CartTest : public ::testing::Test {
 protected:
  void SetUp() override { cart_ = std::make_unique<shop::Cart>(prices_); }
  MockPrices prices_;
  std::unique_ptr<shop::Cart> cart_;
};

TEST_F(CartTest, TotalsPrices) {
  EXPECT_CALL(prices_, price("a")).WillOnce(::testing::Return(3));
  cart_->add("a");
  EXPECT_EQ(cart_->total(), 3);
}

TEST(Discount, Large) {
  EXPECT_EQ(shop::discount(150), 140);
  EXPECT_EQ(shop::discount(50), 50);
}
