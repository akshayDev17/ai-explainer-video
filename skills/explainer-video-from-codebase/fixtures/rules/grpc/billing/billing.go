// A service whose generated code is a dependency (not in this repo): its server methods are found by their
// signature, and a client made by the dependency's constructor is matched by service and method name.
package billing

import (
	"context"

	billingpb "example.com/apis/billing/v1"
	"google.golang.org/grpc"
)

type Server struct{}

func (s *Server) Charge(ctx context.Context, req *billingpb.ChargeRequest) (*billingpb.ChargeReply, error) {
	return nil, nil
}

func (s *Server) helper() {}

func Register(g *grpc.Server) { billingpb.RegisterBillingServer(g, &Server{}) }

func Pay(conn *grpc.ClientConn) {
	cl := billingpb.NewBillingClient(conn)
	cl.Charge(context.Background(), nil)
}
