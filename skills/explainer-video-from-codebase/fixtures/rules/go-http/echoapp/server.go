package echoapp

import "github.com/labstack/echo/v4"

func New() *echo.Echo {
	e := echo.New()
	g := e.Group("/v2")
	g.GET("/items/:id", getItem, auditMW)
	e.Add("DELETE", "/items/:id", deleteItem)
	return e
}

func auditMW(next echo.HandlerFunc) echo.HandlerFunc { return next }
func getItem(c echo.Context) error                  { return nil }
func deleteItem(c echo.Context) error               { return nil }
