#ifndef COMMANDS_H
#define COMMANDS_H
struct command {
  const char *name;
  int (*run)(int argc, char **argv);
};
int dispatch(const char *name, int argc, char **argv);
#endif
