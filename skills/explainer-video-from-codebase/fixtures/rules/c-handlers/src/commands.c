#include <string.h>
#include "commands.h"
#include "store.h"

static int cmd_add(int argc, char **argv) { return store_put(argv[1]); }
static int cmd_list(int argc, char **argv) { return store_list(); }
static int cmd_remove(int argc, char **argv) { return 0; }

static const struct command commands[] = {
  {"add", cmd_add},
  { .name = "list", .run = cmd_list },
  {"remove", &cmd_remove},
  {NULL, NULL},
};

int dispatch(const char *name, int argc, char **argv) {
  for (const struct command *c = commands; c->name; c++)
    if (strcmp(c->name, name) == 0) return c->run(argc, argv);
  return -1;
}
