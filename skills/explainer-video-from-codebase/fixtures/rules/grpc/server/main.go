package main

import (
	"context"
	"net"

	"example.com/greet/greetpb"
	"google.golang.org/grpc"
)

type server struct {
	greetpb.UnimplementedGreeterServer
}

func (s *server) SayHello(ctx context.Context, in *greetpb.HelloRequest) (*greetpb.HelloReply, error) {
	return &greetpb.HelloReply{Message: greeting(in.Name)}, nil
}

func greeting(name string) string { return "hello " + name }

func main() {
	lis, _ := net.Listen("tcp", ":50051")
	s := grpc.NewServer()
	greetpb.RegisterGreeterServer(s, &server{})
	s.Serve(lis)
}
