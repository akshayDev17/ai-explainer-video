package ginapp

import "github.com/gin-gonic/gin"

func Router() *gin.Engine {
	r := gin.Default()
	api := r.Group("/api")
	api.GET("/users/:id", auth, getUser)
	registerOrders(api.Group("/orders"))
	return r
}

func registerOrders(g *gin.RouterGroup) {
	g.POST("", createOrder)
	g.GET("/*path", orderFiles)
}

func auth(c *gin.Context)        {}
func getUser(c *gin.Context)     {}
func createOrder(c *gin.Context) {}
func orderFiles(c *gin.Context)  {}
