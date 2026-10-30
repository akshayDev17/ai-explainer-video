package greet

import "example.com/hello"

// Welcome builds its greeting with the dependency, which the build reads from the module cache.
func Welcome(name string) string { return hello.Hello(name) + "!" }
