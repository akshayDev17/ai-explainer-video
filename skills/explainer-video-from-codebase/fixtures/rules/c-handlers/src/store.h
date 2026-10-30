#ifndef STORE_H
#define STORE_H
struct storage_ops {
  int (*put)(const char *key);
};
int store_put(const char *key);
int store_list(void);
#endif
