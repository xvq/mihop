# Mihop

一个 [mihomo](https://github.com/MetaCubeX/mihomo) 的轻量管理面板。它和其他一些面板不太相同，它的主要目的是做代理中转。

Mihop 将 mihomo 作为子进程托管，提供简洁的可视化界面，无需手动编辑 YAML 即可管理代理、本地监听、流量隧道、路由规则和 DNS。

这个项目的代码由AI编写

![本地监听页面](docs/ListenerPage.png)


## 快速开始

### 前置条件

- Go 1.21+
- Node.js 18+
- [mihomo](https://github.com/MetaCubeX/mihomo/releases) 可执行文件

### 构建

```bash
# 1. 构建前端
cd web
npm install
npm run build
cd ..

# 2. 构建二进制（内嵌前端静态资源）
go build -o mihop .
```

### 运行

```bash
./mihop
```

默认监听 `:8080`，浏览器打开 `http://localhost:8080` 即可访问。默认密码：admin

首次启动后，需要在**设置**页面配置 mihomo 可执行文件路径后即可启动。
### 运行参数

| 参数 | 说明 |
|---|---|
| `-c <路径>` | 指定数据目录（默认 `~/.config/mihop`） |

```bash
./mihop -c /path/to/data
```

## 数据目录结构

```
~/.config/mihop/
├── mihomo-config.yaml   # mihomo 配置文件（唯一数据源）
└── mihop-config.json    # Mihop 自身配置（二进制路径、访问密码等）
```

> Mihop 对 YAML 文件做增量写入，手动编写的内容完整保留。
> 
> x-mihop 字段是用来存放在UI中禁用的端口和隧道的。

## License

[MIT](LICENSE.txt)
