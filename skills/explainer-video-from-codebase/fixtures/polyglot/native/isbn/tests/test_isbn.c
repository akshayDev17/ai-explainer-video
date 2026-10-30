#include <assert.h>
#include <string.h>
#include "../src/isbn.h"

static void test_isbn10_valid(void) {
  assert(isbn10_valid("0306406152"));
  assert(!isbn10_valid("0306406153"));
}

static void test_isbn10_to13(void) {
  char out[14];
  assert(isbn10_to13("0306406152", out) == 0);
  assert(strcmp(out, "9780306406157") == 0);
  assert(isbn13_valid(out));
}

int main(void) {
  test_isbn10_valid();
  test_isbn10_to13();
  return 0;
}
