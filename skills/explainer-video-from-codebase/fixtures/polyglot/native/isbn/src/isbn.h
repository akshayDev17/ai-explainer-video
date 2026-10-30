#ifndef ISBN_H
#define ISBN_H
int isbn10_valid(const char *s);
int isbn13_valid(const char *s);
int isbn10_to13(const char *in, char *out);
#endif
