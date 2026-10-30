package shop

import "net"

// Ping opens a TCP connection: the sandbox denies it.
func Ping(addr string) error {
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return err
	}
	return conn.Close()
}
