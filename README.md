# 风声 · 联机版

民国谍战身份推理桌游《风声》的线上联机版。

服务器权威架构：洗牌、发牌、判定全部在服务端完成，每个玩家只收到自己有权看到的信息（别人的手牌、身份、阵营不会下发到你的浏览器，防作弊）。

## 快速开始

**双击 `启动服务器.cmd`** —— 浏览器自动打开，创建房间后把 4 位房间号告诉朋友即可。

| 场景 | 朋友怎么进 |
| --- | --- |
| 同一个 WiFi（局域网） | 打开窗口里显示的 `http://192.168.x.x:8787` |
| 不在同一网络（公网） | 双击 `公网分享.cmd`，把显示的 `https://xxxx.trycloudflare.com` 发给朋友 |

人数不足时电脑会自动补位，开局至少需要你自己一人。

## 公网临时分享（免账号）

双击 **`公网分享.cmd`**：自动启动服务器并建立 Cloudflare 免费隧道，窗口显示形如
`https://xxxx.trycloudflare.com` 的地址，发给任何人即可从公网加入（支持手机流量网络）。

- 依赖 `tools/cloudflared.exe`（Cloudflare 官方工具，免费、无需注册）。
  若缺失，按提示到 https://github.com/cloudflare/cloudflared/releases/latest
  下载 `cloudflared-windows-amd64.exe` 放入 `tools/` 并改名为 `cloudflared.exe`。
- 地址是临时的：窗口关闭或电脑关机后失效，重开会得到新地址。
- 想要固定地址随时可玩 → 用下面的「永久部署」。

## 永久部署（Render 免费层）

一次部署，得到一个固定网址，任何人随时可玩（服务器 15 分钟无人访问会休眠，再次打开等约 30 秒自动唤醒）。

1. 把本目录推送到 GitHub：

   ```bash
   git remote add origin https://github.com/<你的用户名>/fengsheng-online.git
   git push -u origin main
   ```

2. 打开 https://render.com 用 GitHub 账号注册登录；
3. `New +` → `Blueprint` → 选择该仓库 → `Apply`（自动读取 `render.yaml`，free 计划无需信用卡）；
4. 部署完成后得到固定地址 `https://fengsheng-online.onrender.com`，发给大家即可。

之后每次 `git push` 会自动重新部署。也可以用 `Dockerfile` 部署到任何支持容器的平台。

## 开发

```bash
npm install
npm start        # 启动服务器（默认 8787，PORT 环境变量可改）
npm run smoke    # 服务器冒烟测试
node test-join.mjs   # 双客户端模拟完整联机流程
```

## 结构

| 路径 | 作用 |
| --- | --- |
| `engine.js` | 游戏引擎（无 DOM 纯逻辑，服务器权威） |
| `server.js` | WebSocket 服务器：房间、大厅、消息分发、断线重连 |
| `public/` | 前端页面（沿用单机版界面，改为消息驱动） |
| `launcher.cjs` `*.cmd` | Windows 双击启动器（.cmd 为纯英文壳，中文界面由 Node 输出） |
| `Dockerfile` `render.yaml` | 公网部署配置 |

## Windows 启动器为什么是「.cmd + launcher.cjs」两个文件

部分 Windows（实测 Win11 26200）上 cmd 批处理在 `chcp 65001` 后按字节偏移重读文件，
含中文或制表符的行会导致解析错位。因此 `.cmd` 只保留纯 ASCII 壳，所有中文界面由
`launcher.cjs` 输出，彻底规避该问题。
