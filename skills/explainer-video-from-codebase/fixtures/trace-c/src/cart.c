#include "cart.h"

int discount(int total) { return total >= 100 ? total - total / 10 : total; }

int cart_total(const int *prices, int n) {
  int t = 0;
  for (int i = 0; i < n; i++) t += prices[i];
  return discount(t);
}

int unused(void) { return 42; }
