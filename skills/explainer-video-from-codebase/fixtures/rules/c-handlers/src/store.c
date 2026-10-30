#include <stdlib.h>
#include "store.h"

static int file_put(const char *key) { return 1; }
static int mem_put(const char *key) { return 2; }
static const struct storage_ops file_ops = { .put = file_put };
static const struct storage_ops mem_ops = { mem_put };

static void audit_log(const char *key) {}

int store_put(const char *key) {
  const struct storage_ops *ops = getenv("STORE_BACKEND") ? &file_ops : &mem_ops;
#ifdef WITH_AUDIT
  audit_log(key);
#endif
  return ops->put(key);
}

int store_list(void) { return 0; }
