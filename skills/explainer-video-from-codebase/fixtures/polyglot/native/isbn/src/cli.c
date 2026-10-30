#include <stdio.h>
#include <string.h>
#include "isbn.h"

struct command {
  const char *name;
  int (*run)(const char *arg);
};

static int cmd_check(const char *arg) {
  int ok = strlen(arg) == 13 ? isbn13_valid(arg) : isbn10_valid(arg);
  puts(ok ? "valid" : "invalid");
  return ok ? 0 : 1;
}

static int cmd_convert(const char *arg) {
  char out[14];
  if (isbn10_to13(arg, out) != 0) return 1;
  puts(out);
  return 0;
}

static const struct command commands[] = {
  {"check", cmd_check},
  {"convert", cmd_convert},
};

static int run_command(const char *name, const char *arg) {
  for (size_t i = 0; i < sizeof commands / sizeof commands[0]; i++)
    if (strcmp(commands[i].name, name) == 0) return commands[i].run(arg);
  fprintf(stderr, "unknown command %s\n", name);
  return 2;
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  return run_command(argv[1], argv[2]);
}
