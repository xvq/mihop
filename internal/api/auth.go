package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

// sessionStore 保存当前唯一有效的 session token。
// 每次登录都会生成新 token，使旧 token 失效（单用户单设备）。
// 服务重启后内存清零，需重新登录。
type sessionStore struct {
	mu    sync.RWMutex
	token string
}

func (ss *sessionStore) create() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	tok := hex.EncodeToString(b)
	ss.mu.Lock()
	ss.token = tok
	ss.mu.Unlock()
	return tok
}

func (ss *sessionStore) valid(tok string) bool {
	if tok == "" {
		return false
	}
	ss.mu.RLock()
	defer ss.mu.RUnlock()
	return tok == ss.token
}

func (ss *sessionStore) revoke() {
	ss.mu.Lock()
	ss.token = ""
	ss.mu.Unlock()
}

// ─── handlers ────────────────────────────────────────────────────────────────

func (h *Handler) login(c *gin.Context) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Username != "admin" || body.Password != h.store.GetPassword() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误"})
		return
	}
	tok := h.session.create()
	c.JSON(http.StatusOK, gin.H{"token": tok})
}

func (h *Handler) logout(c *gin.Context) {
	h.session.revoke()
	c.Status(http.StatusNoContent)
}

// ─── middleware ───────────────────────────────────────────────────────────────

func (h *Handler) authRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 普通请求：Authorization: Bearer <token>
		tok := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
		// WebSocket 请求：浏览器原生 WS API 不支持自定义 header，token 通过 query 传递
		if tok == "" {
			tok = c.Query("token")
		}
		if !h.session.valid(tok) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}
