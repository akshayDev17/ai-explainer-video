#include <signal.h>
#include "commands.h"

static void on_sigint(int sig) {}

int main(int argc, char **argv) {
  signal(SIGINT, on_sigint);
  return dispatch(argv[1], argc, argv);
}
