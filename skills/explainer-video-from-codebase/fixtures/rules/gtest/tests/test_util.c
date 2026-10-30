#include "unity.h"
#include "util.h"

void setUp(void) {}
void tearDown(void) {}

void test_clamp_low(void) { TEST_ASSERT_EQUAL(0, clamp(-1)); }
void test_clamp_high(void) { TEST_ASSERT_EQUAL(5, clamp(5)); }

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_clamp_low);
  RUN_TEST(test_clamp_high);
  return UNITY_END();
}
