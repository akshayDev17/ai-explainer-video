// Package hello is the dependency the trace-go-dep fixture builds against, from a module cache.
package hello

// Hello returns the greeting for name.
func Hello(name string) string { return "hello, " + name }
