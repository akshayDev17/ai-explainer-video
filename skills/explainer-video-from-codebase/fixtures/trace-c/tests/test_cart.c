#include <assert.h>
#include "../src/cart.h"

static void test_total(void) {
  int prices[] = {30, 20};
  assert(cart_total(prices, 2) == 50);
}

static void test_discount(void) { assert(discount(200) == 180); }

int main(void) {
  test_total();
  test_discount();
  return 0;
}
