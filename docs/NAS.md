# NAS 网页串流：第一阶段

目标：NAS 保存微软授权并提供网页/信令服务，Windows 浏览器接收 Xbox 原始 WebRTC 串流。
NAS 不运行浏览器，不做桌面采集或视频二次编码。本阶段先验证内网登录、手柄和串流。

## 启动

在 NAS 上运行（需要 Docker Compose）：

```bash
cp .env.example .env
# 编辑 .env，填写强随机 XWR_ACCESS_PASSWORD 和实际 HTTPS origin。
# 例如用 python3 -c 'import secrets; print(secrets.token_hex(24))' 生成密码。
docker compose up -d --build
```

默认只发布到 NAS 本机 `127.0.0.1:8977`。反向代理在另一台内网机器时，
将 `XWR_BIND_ADDRESS` 设置为 NAS 的具体内网 IP；用防火墙限制来源为代理机器。
`XWR_PUBLIC_ORIGIN` 填实际的 `https://域名`，不要附带路径。网页需要部署在域名根路径。

HTTP Basic 用户名默认 `xbox`，密码来自 `.env`。非本机监听时没有密码会拒绝启动。
所有网页和 API 都需要该密码；它与微软账号密码无关。远程使用必须经过 HTTPS。
本服务是单用户设计：知道访问密码的人可以操作该 Xbox，并使用 NAS 上保存的授权。

Docker 命名卷 `xbox-auth` 保存 `/data/tokens.json`，容器重建和普通重启不会丢失授权。
不要执行 `docker compose down -v`，除非确实要删除授权数据；不要把卷或 `.env` 提交到 Git。
数据写入使用权限 600 的临时文件原子替换。文件损坏会使服务启动失败，请保留备份后排查。
NAS/容器自身访问微软认证和 Xbox 网关的流量仍需使用家中合适的出口。

## HTTPS 反向代理

已有 Nginx 的配置片段（证书在现有 HTTPS 虚拟主机上配置）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8977;
    # 如果代理不在 NAS 上，改为 NAS 在隧道或内网中的地址。
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 120s;
}
```

第一阶段先在家中网络通过 HTTPS 访问，确认网页和 Xbox 媒体连接正常。
浏览器的 Gamepad API 需要安全上下文；普通 `http://NAS内网IP` 不能作为正式入口。
`http://localhost` 可用于运行客户端本机服务的开发测试。
反向代理只承载网页及信令，不会自动转发 WebRTC 媒体。

## 首次微软授权（Windows）

可以在个人 Windows 电脑完成一次授权，后续公司电脑只需访问 NAS 网页，
无需安装 Python、登录助手或 Tailscale。微软撤销授权或刷新失效时再授权。

微软 XAL 固定回调为 `ms-xal-000000004c20a908://auth`，不能直接改成 NAS 的 HTTPS URL。
NAS 模式需要一个仅用于首次/重新授权的剪贴板助手：

1. 从登录页下载 `login-helper.ps1`，阅读脚本后在 **Windows PowerShell** 中执行：

   ```powershell
   Unblock-File .\login-helper.ps1
   .\login-helper.ps1
   ```

   遵循电脑现有脚本执行策略；若被组织策略禁止，请在允许的个人电脑完成授权。
   助手复制到 `%LOCALAPPDATA%\XboxWebRemote\`，只注册当前用户的 URL 协议。
   若已有其他 Xbox 登录助手，会先询问是否替换。

2. 在 NAS 网页点“登录微软账号”，打开生成的微软链接并完成登录。
3. 浏览器询问打开助手时允许打开。助手只将完整回调地址复制到剪贴板，
   不向外发送内容，也不在 Windows 保存微软令牌。
4. 回到 NAS 网页，粘贴到回调输入框，点击“完成授权”。
   回调必须匹配本次登录的 `state`。不要同时在多个页面发起登录，最新一次会替换前次流程。
5. NAS 保存令牌并自动续签。不要分享回调地址、剪贴板内容或 `tokens.json`。
   完成后可清空剪贴板（包括 Windows 剪贴板历史）。

卸载助手：删除当前用户的
`HKCU\Software\Classes\ms-xal-000000004c20a908` 注册表项和
`%LOCALAPPDATA%\XboxWebRemote` 目录。若原来使用本机版客户端，重新运行其启动器恢复注册。

## 指定主机直达入口

授权后，主机卡片上点“复制直达链接”，收藏得到的地址：

```text
https://xbox.example.com/?console=你的主机ID
```

访问该链接会在检查现有授权、获取主机列表后，直接发起指定主机串流。
授权过期时先显示登录页，完成授权后继续连接原来指定的主机。
找不到指定主机会停留在列表，不会改连另一台；断开返回或刷新列表也不会再次自动开机。
不带 `console` 参数的首页保留手动选择主机的方式。
浏览器可能要求点击页面后才允许播放声音，手柄也可能需要按键后才会被浏览器识别。

## 本轮验收与下一阶段

内网实际验收：

1. 网页访问密码生效，未登录不能访问页面、信令或授权 API。
2. 首次微软授权成功，主机列表可见。
3. 指定主机链接可出画面、有声音，实体手柄可控制游戏。
4. 连续串流超过 10 分钟，确认没有缺少 lpt 导致的约 5 分钟断线。
5. 重启容器，确认不需要重新授权。
6. 主动断开后不自动重连，回到普通首页仍可手动选主机。

下一阶段再接上海与 NAS 的隧道，并验证公司浏览器的媒体路径。
仅发布公网 HTTPS 不足以保证视频连接；跨网需要直连可达地址或 TURN 等媒体通道。
当前未实现自定义 TURN 配置或强制上海中继，不宣称公司网络已能串流。
统计面板的“私网地址通道”不证明物理上处于同一局域网，TURN 也不一定由微软提供。
必须结合实际候选对地址、RTT、丢包及中转机流量验收。

默认关闭直播源/HLS，因为它与交互串流无关，旧 HLS 服务也没有访问鉴权。
仅本机使用的旧直播源功能可通过 `XWR_ENABLE_LIVE=1` 开启；远程监听时拒绝开启。
本镜像不包含 ffmpeg，该功能需要另行准备。

## 本地检查

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.test.js
python3 -m py_compile server.py
```

这些检查不调用微软、不发起真实串流，也不能替代上面的 Xbox 实机验收。
