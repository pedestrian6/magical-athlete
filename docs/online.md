# 好友房联机使用与部署

支持 2–6 位真人各自在浏览器加入同一房间。服务器执行骰子、技能、计分和保存；浏览器仅提交操作与展示本人可见状态。同机模式与原有本地存档继续可用。

## 玩家操作

1. 选择好友联机，房主设置人数并创建房间，其他人通过邀请链接或房间码加入。
2. 保存各自的个人恢复码，勿放入邀请链接或群聊。原浏览器可自动恢复；换设备用恢复码找回座位，旧设备和旧码随即失效。
3. 全员在线并准备后由房主开始。依次招募，每场各自私密锁定角色，全部锁定后揭示。双角色的选择顺序为行动顺序。
4. 掷骰和技能决定由对应玩家操作；遇到离线玩家需要决定时等待，不自动代打。房主连续离线 30 秒后由最早加入的在线玩家接任。
5. 四场完成后查看排名。下一届新建房间；开始后不支持替补、改分或强行跳过。房主可结束整个房间。

同一座位只允许一个当前操作页面。房间从最后一次有效活动起保留 7 天；加入、恢复、准备和合法操作续期，心跳与状态刷新不续期。界面显示到期时间。到期清理对局及座位凭证。联网房间不能通过本地 JSON 导入导出覆盖。

## 本机运行联机服务

需要 Node.js 24 和 pnpm 11.19.0。所有图片为随项目保存的原创 SVG，无外部运行素材。

```sh
pnpm install --frozen-lockfile && pnpm build:online && pnpm serve:online
```

打开 `http://127.0.0.1:3000`。多玩家使用不同浏览器配置文件或独立上下文；同一配置文件的标签页共享身份。前台运行按 Ctrl+C 停止。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| HOST | 127.0.0.1 | 默认只监听回环地址 |
| PORT | 3000 | HTTP 与 Socket.IO 共用端口 |
| PUBLIC_ORIGIN | http://127.0.0.1:3000 | 同源校验与外部访问地址 |
| DATA_DIR | ./var/online | SQLite 持久化目录 |
| STATIC_DIR | ./dist | 网页构建产物 |
| SERVER_STATUS_FILE | DATA_DIR/status.json | 进程、内存及连接状态 |
| TRUSTED_PROXY_IPS | 空 | 可信反向代理 IP，逗号分隔 |

客户端请求使用当前网页的同源地址，没有预设远程游戏服务器。独立服务端不提供 SSH 自动部署。

## 在自己的服务器部署

当前 Compose 配置适用于已有 **Caddy Docker Proxy** 与外部 `caddy` 网络的服务器。普通 Caddy 不会自动读取这些标签，需要自行配置反向代理。游戏不发布宿主机端口，容器以 UID/GID `1000:1000` 运行，上限 1 CPU、512 MiB。

先将源码放到自己服务器的独立目录，并检查磁盘、内存、Docker Compose 和代理网络。以下命令都在该目录执行；需要 Docker 管理权限的机器，在 Docker 运维命令前自行加 `sudo`。

```sh
cp deploy/.env.example deploy/.env && mkdir -p data backups logs && chmod 700 data backups
```

编辑 `deploy/.env`：

- `GAME_DOMAIN` 必须填写你控制的域名，并将其 DNS 指向你自己的服务器；`game.example.com` 只是占位示例。未填写时 Compose 拒绝解析。
- `IMAGE_TAG` 每次发布使用新值，不覆盖已有镜像标签。
- `TRUSTED_PROXY_IPS` 默认留空；如需代理后的按 IP 限流，核对自己 Caddy 容器的网络 IP 后再填写。仅这些来源的转发头参与限流；代理换 IP 后更新。
- `data/`、`backups/` 所有者必须为 UID 1000。若服务器账户 UID 不同，仅调整这两个项目目录的所有者。

项目仅允许锁定的 `esbuild@0.28.2` 执行依赖构建脚本，配置位于 `pnpm-workspace.yaml`；Docker 在安装前复制该文件。

```sh
bash scripts/online-build.sh && bash scripts/online-ops.sh start && bash scripts/online-ops.sh status
```

也可用 `bash scripts/online-release.sh` 串行完成构建、启动、限时 HTTPS 检查和首次一致性备份。构建预计超过两分钟时，在项目目录启动具名 tmux：

```sh
tmux new-session -d -s magical-athlete-release 'bash -o pipefail -c "bash scripts/online-release.sh 2>&1 | tee logs/online-release.log"'
```

脚本会写入 PID、状态、日志和真实退出码：`logs/online-release.pid`、`logs/online-release.status.json`、`logs/online-release.log`、`logs/online-release.exit`。读取状态即可查看阶段，不必持续轮询。只有状态 `finished/deployed` 且退出码 `0` 表示 HTTPS 和备份完成，浏览器对战另行验证。进入会话用 `tmux attach -t magical-athlete-release`，取消用 `tmux send-keys -t magical-athlete-release C-c`。

日志是相对于项目目录的路径；SSH 登录后先进入自己的项目目录。tmux 没有会话只表示脚本结束，成功或失败都须查退出码。证书签发失败保留诊断，不使用忽略 TLS 错误作为验收。

## 备份与运维

| 操作 | 命令 |
| --- | --- |
| 状态 | bash scripts/online-ops.sh status |
| 最后 100 行日志 | bash scripts/online-ops.sh logs |
| 停止并保留数据 | bash scripts/online-ops.sh stop |
| 启动已有镜像 | bash scripts/online-ops.sh start |
| 一致性备份 | bash scripts/online-ops.sh backup before-update.sqlite |
| 校验、停止、恢复并启动 | bash scripts/online-ops.sh restore before-update.sqlite |
| 切换已有镜像 | bash scripts/online-ops.sh rollback YOUR_PREVIOUS_TAG |

SQLite 运行期间可能使用 WAL，不要只复制主数据库文件。备份通过独立、无网络、无代理标签的维护容器执行 Node SQLite backup，并写入 SHA-256 元数据。产物位于 `backups/`，拒绝覆盖同名文件。备份含完整私有对局和身份哈希，应只让管理员访问，不能提交到 Git。

恢复先检查完整性，停止游戏后自动保存原库，再恢复指定文件；失败保持游戏停止并保留诊断。恢复旧备份会撤销后续游戏操作和凭证更新，应先告知正在玩的朋友。回滚先备份数据库再切换已有镜像，不自动改写数据库；不兼容版本应拒绝启动，不能通过清空存档规避。

容器自动重启，日志上限 3 个 10 MiB 文件。脚本只操作本项目 game 服务；遗留运维锁 `logs/.online-ops.lock/` 应先核实 PID 已退出再清理。

## 验证自己的部署

```sh
PUBLIC_SMOKE=1 BASE_URL=https://YOUR_GAME_DOMAIN pnpm exec playwright test tests/browser/public-smoke.spec.ts
```

需先安装 Chrome 或 `pnpm exec playwright install chromium`。公网冒烟测试必须显式提供 `BASE_URL`；它创建自用房间并在结束后关闭。不要对未授权的服务运行。完整本机测试与历史验证范围见 [verification.md](verification.md)。
