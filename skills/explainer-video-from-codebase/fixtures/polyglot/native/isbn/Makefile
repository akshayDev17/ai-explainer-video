CC ?= cc
CFLAGS ?= -O0 -g

test: tests/test_isbn
	./tests/test_isbn

tests/test_isbn: tests/test_isbn.c src/isbn.c src/isbn.h
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ tests/test_isbn.c src/isbn.c

isbn: src/cli.c src/isbn.c src/isbn.h
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ src/cli.c src/isbn.c

.PHONY: test
