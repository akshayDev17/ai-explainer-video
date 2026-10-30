// A trimmed copy of what protoc-gen-go-grpc writes for `service Greeter` in package greet.
package greetpb

import (
	"context"

	"google.golang.org/grpc"
)

const (
	Greeter_SayHello_FullMethodName = "/greet.Greeter/SayHello"
	Greeter_Farewell_FullMethodName = "/greet.Greeter/Farewell"
)

type GreeterClient interface {
	SayHello(ctx context.Context, in *HelloRequest, opts ...grpc.CallOption) (*HelloReply, error)
	Farewell(ctx context.Context, in *HelloRequest, opts ...grpc.CallOption) (*HelloReply, error)
}

type greeterClient struct {
	cc grpc.ClientConnInterface
}

func NewGreeterClient(cc grpc.ClientConnInterface) GreeterClient {
	return &greeterClient{cc}
}

func (c *greeterClient) SayHello(ctx context.Context, in *HelloRequest, opts ...grpc.CallOption) (*HelloReply, error) {
	out := new(HelloReply)
	err := c.cc.Invoke(ctx, Greeter_SayHello_FullMethodName, in, out, opts...)
	return out, err
}

func (c *greeterClient) Farewell(ctx context.Context, in *HelloRequest, opts ...grpc.CallOption) (*HelloReply, error) {
	out := new(HelloReply)
	err := c.cc.Invoke(ctx, Greeter_Farewell_FullMethodName, in, out, opts...)
	return out, err
}

type GreeterServer interface {
	SayHello(context.Context, *HelloRequest) (*HelloReply, error)
	Farewell(context.Context, *HelloRequest) (*HelloReply, error)
	mustEmbedUnimplementedGreeterServer()
}

type UnimplementedGreeterServer struct{}

func (UnimplementedGreeterServer) SayHello(context.Context, *HelloRequest) (*HelloReply, error) { return nil, nil }
func (UnimplementedGreeterServer) Farewell(context.Context, *HelloRequest) (*HelloReply, error) { return nil, nil }
func (UnimplementedGreeterServer) mustEmbedUnimplementedGreeterServer()                         {}

func RegisterGreeterServer(s grpc.ServiceRegistrar, srv GreeterServer) {
	s.RegisterService(&Greeter_ServiceDesc, srv)
}

var Greeter_ServiceDesc = grpc.ServiceDesc{
	ServiceName: "greet.Greeter",
	HandlerType: (*GreeterServer)(nil),
}

type HelloRequest struct{ Name string }
type HelloReply struct{ Message string }
