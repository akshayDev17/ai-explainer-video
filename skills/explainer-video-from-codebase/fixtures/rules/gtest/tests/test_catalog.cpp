#include <catch2/catch_test_macros.hpp>

#include "cart.h"

TEST_CASE("prices come from the database", "[prices]") {
  shop::DbPrices db;
  SECTION("a known sku") { REQUIRE(db.price("abc") == 3); }
  SECTION("an empty sku") { CHECK(db.price("") == 0); }
}
