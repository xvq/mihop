package main

import (
	"context"
	"embed"
	"flag"
	"io/fs"
	"log"
	"mihop/internal/api"
	"mihop/internal/process"
	"mihop/internal/store"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

//go:embed web/dist
var webFS embed.FS

func main() {
	var dataDir string
	flag.StringVar(&dataDir, "c", "", "数据目录路径（默认 ~/.config/mihop）")
	flag.Parse()
	if dataDir == "" {
		dataDir = defaultDataDir()
	}

	s, err := store.New(dataDir)
	if err != nil {
		log.Fatalf("failed to init store: %v", err)
	}

	settings := s.GetSettings()
	mgr := process.NewManager(settings.MihomoPath)

	handler := api.New(s, mgr)

	// 启动时自动拉起 mihomo
	if err := mgr.Start(s.GetConfigPath()); err != nil {
		log.Printf("auto-start mihomo failed: %v", err)
	}

	// 根据 log_level 决定 gin 模式和中间件
	logLevel := s.GetLogLevel()
	if logLevel != "debug" {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.Use(gin.Recovery()) // 始终捕获 panic，避免进程崩溃
	if logLevel == "debug" {
		r.Use(gin.Logger()) // debug 模式才记录每条 HTTP 请求
	}
	// CORS：仅开发模式（Vite dev server 跨域）需要；生产环境前端同源，无影响
	r.Use(cors.New(cors.Config{
		AllowOrigins: []string{"http://localhost:5173"},
		AllowMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Content-Type", "Authorization"},
	}))

	handler.RegisterRoutes(r)

	// 静态文件 + SPA fallback
	sub, err := fs.Sub(webFS, "web/dist")
	if err != nil {
		log.Fatalf("failed to embed web: %v", err)
	}
	fileServer := http.FileServer(http.FS(sub))
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api") {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		_, statErr := fs.Stat(sub, c.Request.URL.Path[1:])
		if os.IsNotExist(statErr) {
			c.Request.URL.Path = "/"
		}
		fileServer.ServeHTTP(c.Writer, c.Request)
	})

	addr := s.GetAddr()
	srv := &http.Server{Addr: addr, Handler: r}

	go func() {
		log.Printf("Mihop listening on %s  data=%s", addr, dataDir)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down...")
	mgr.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("server forced shutdown: %v", err)
	}
	log.Println("Bye.")
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".config", "mihop")
}
