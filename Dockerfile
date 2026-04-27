# ─── Stage 1: 构建前端 ────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ─── Stage 2: 构建 Go 二进制（内嵌前端静态文件）────────────────────────────────
FROM golang:1.25-alpine AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# 将第一阶段构建好的前端覆盖到源码树中，供 embed 打包
COPY --from=frontend /app/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -trimpath -o mihop .

# ─── Stage 3: 下载 mihomo ────────────────────────────────────────────────────
FROM alpine:3.20 AS mihomo-dl
ARG MIHOMO_VERSION=v1.19.24
# TARGETARCH 由 Docker BuildKit 自动注入（amd64 / arm64 等）
ARG TARGETARCH=amd64
RUN apk add --no-cache wget && \
    wget -qO- \
      "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-${TARGETARCH}-${MIHOMO_VERSION}.gz" \
      | gunzip > /usr/local/bin/mihomo && \
    chmod +x /usr/local/bin/mihomo

# ─── Stage 4: 最终运行镜像 ────────────────────────────────────────────────────
FROM alpine:3.20
# ca-certificates：mihomo 建立 TLS 连接需要；tzdata：时区支持
RUN apk add --no-cache ca-certificates tzdata

COPY --from=backend  /app/mihop              /usr/local/bin/mihop
COPY --from=mihomo-dl /usr/local/bin/mihomo  /usr/local/bin/mihomo

# 数据目录：mihomo-config.yaml、mihop-config.json 等持久化文件
VOLUME /data

EXPOSE 8080
CMD ["mihop", "-c", "/data"]
