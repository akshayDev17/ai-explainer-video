package main

import (
	"context"

	"example.com/greet/greetpb"
	"google.golang.org/grpc"
)

func main() {
	conn, _ := grpc.NewClient("localhost:50051")
	c := greetpb.NewGreeterClient(conn)
	c.SayHello(context.Background(), &greetpb.HelloRequest{Name: "ada"})
}
