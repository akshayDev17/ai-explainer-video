package greet

import "testing"

func TestWelcome(t *testing.T) {
	if got := Welcome("ada"); got != "hello, ada!" {
		t.Fatalf("Welcome() = %q", got)
	}
}
