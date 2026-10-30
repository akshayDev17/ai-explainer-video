CC ?= cc
CFLAGS ?= -O0 -g

test: tests/test_cart tests/test_net
	./tests/test_cart
	./tests/test_net

tests/test_cart: tests/test_cart.c src/cart.c src/cart.h
	$(CC) $(CFLAGS) -o $@ tests/test_cart.c src/cart.c

tests/test_net: tests/test_net.c src/net.c src/net.h
	$(CC) $(CFLAGS) -o $@ tests/test_net.c src/net.c

.PHONY: test
