# 依赖与构建

- Go 1.26.10 linux/amd64，下载校验 SHA-256：ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5；官方发行地址 https://go.dev/dl/。
- Wails v2.17.0，稳定 v2，官方安装说明 https://wails.io/docs/gettingstarted/installation/；版本经 Go module proxy 核实。
- Go 依赖准确版本见 go.mod/go.sum；前端准确版本见 package.json/package-lock.json。
- 所有构建从锁文件恢复；不在发布步骤升级依赖。
