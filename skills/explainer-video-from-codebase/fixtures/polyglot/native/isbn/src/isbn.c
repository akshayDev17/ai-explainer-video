#include <string.h>
#include "isbn.h"

static int digit(char c) { return c >= '0' && c <= '9' ? c - '0' : -1; }

int isbn10_valid(const char *s) {
  if (strlen(s) != 10) return 0;
  int sum = 0;
  for (int i = 0; i < 10; i++) {
    int d = (i == 9 && s[i] == 'X') ? 10 : digit(s[i]);
    if (d < 0) return 0;
    sum += (10 - i) * d;
  }
  return sum % 11 == 0;
}

int isbn13_valid(const char *s) {
  if (strlen(s) != 13) return 0;
  int sum = 0;
  for (int i = 0; i < 13; i++) {
    int d = digit(s[i]);
    if (d < 0) return 0;
    sum += (i % 2 ? 3 : 1) * d;
  }
  return sum % 10 == 0;
}

int isbn10_to13(const char *in, char *out) {
  if (!isbn10_valid(in)) return -1;
  memcpy(out, "978", 3);
  memcpy(out + 3, in, 9);
  int sum = 0;
  for (int i = 0; i < 12; i++) sum += (i % 2 ? 3 : 1) * digit(out[i]);
  out[12] = (char)('0' + (10 - sum % 10) % 10);
  out[13] = '\0';
  return 0;
}
