#include <stdio.h>
#include "../src/net.h"

/* fails without aborting, so the binary still writes its coverage counters (an abort writes none) */
static int test_ping(void) { return ping(9) == 0; }

int main(void) {
  if (!test_ping()) { fprintf(stderr, "test_ping failed\n"); return 1; }
  return 0;
}
