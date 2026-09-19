---
title: 第 16 章：Miracast（Wi-Fi Display）— 把屏幕“借”到大电视上
top: 1
related_posts: true
tags:
  - 802.11
categories:
  - WiFi
  - Protocol
abbrlink: 1011b20c
date: 2026-09-18 23:38:46
---

> "你不需要一根 HDMI 线。你需要的，是让两块屏幕'说同一种语言'。"

---

# 本章导读

手机上的视频，想丢到客厅大电视上看；笔记本的 PPT，想甩到会议室投影仪上放。最朴素的办法是插一根 HDMI 线——但线总是不够长、接口总是不匹配。**Miracast** 干的就是"把 HDMI 线变成无线"这件事。

Miracast 是 Wi-Fi 联盟的认证品牌，对应的技术规范叫 **WFD（Wi-Fi Display）**。它的定位非常清晰：**在两台设备之间建立一条"无线 HDMI"**，把音视频从一台设备（Source，发送端）实时串流到另一台（Sink，显示端）。

<!--more-->

但 Miracast 自己**不发明底层连接**——它站在前面"设备直连"两章的肩膀上。第 14 章（Wi-Fi Direct）、第 15 章（TDLS）讲了两台设备如何直连；这一章讲的是：**连上之后，画面和声音怎么协商、怎么传、怎么控。**

> **本章比喻：把屏幕"借"到大电视上（无线 HDMI）**
> 你（手机 = **WFD Source**）想把自己手上的内容投到朋友家的大电视（**WFD Sink**）上。但电视不知道你的视频是什么分辨率、什么编码、声音几个声道。于是你们先"对暗号"——我问你支持啥（M1/M2），你告诉我你的本事（M3），我挑一个咱俩都支持的格式定下来（M4），然后正式开播（M5→播放）。播放期间，电视的遥控器还能反过来控制你的手机（UIBC）。

**本章你将学到：**

- WFD 架构：Source / Primary Sink / Secondary Sink / WFD Session
- 三种连接拓扑：Wi-Fi Direct / TDLS / Infrastructure（R1 vs R2）
- 完整建立流程的 11 个步骤
- 控制面核心：RTSP M1–M16 消息序列在协商和控制什么
- 数据面：H.264 + MPEG2-TS over RTP/UDP；HDCP 内容保护
- 投屏体验的命根子：时间同步（防音画不同步）与码率自适应
- UIBC：在大屏上反控手机
- 进阶：Coupled Sink（画面/声音分流）、持久组与并发
- 帧格式：WFD IE 与设备能力位图
- 超时规则与会话保活

> **数据来源**：本章所有技术结论基于 `Miracast_Specification_v2.3.pdf`（Wi-Fi Alliance, 2024）并标注章节。底层直连机制见本系列 [第 14 章 Wi-Fi Direct](/posts/eddc3161/)。

---

# 1 WFD 架构 — 谁投屏，谁显示

## 1.1 三个角色 + 一个会话

Miracast 把参与方分成几个角色（§3.1）：

| 角色                   | 比喻                      | 职责                                                      |
| ---------------------- | ------------------------- | --------------------------------------------------------- |
| **WFD Source**         | 投屏方（你的手机/笔记本） | 编码音视频，封装成 MPEG2-TS，发送给 Sink                  |
| **WFD Primary Sink**   | 主显示端（大电视）        | 接收并渲染视频（可含音频），或输出到外接显示设备          |
| **WFD Secondary Sink** | 副显示端（音箱）          | 只接收音频（Coupled Sink 场景下，电视放画面、音箱放声音） |
| **WFD Session**        | 这一次投屏                | Source 与 Sink（们）之间的一次完整音视频会话              |

> **关键约束**：一个 WFD Source 在一次 Session 中只服务**一个** Sink（Coupled Sink 例外，可同时接 Primary + Secondary）。一个 Session 里传的是**单路音频 + 单路视频**复用的 MPEG2-TS（§3.1.1）。

> Source 是"内容供货商"，Primary Sink 是"大卖场"（既卖画面又卖声音），Secondary Sink 是"专门的音响店"（只要声音那部分货）。一次 Session 就是一笔供货合同。

## 1.2 数据面与控制面：两条独立的线

Miracast 把通信拆成两条逻辑通道（§3，Figure 1）——这是理解整个协议的关键：

| 平面                        | 跑什么                                                   | 承载                         |
| --------------------------- | -------------------------------------------------------- | ---------------------------- |
| **控制面（Control Plane）** | RTSP 协商与控制、UIBC、HDCP 密钥协商、Remote I2C         | **TCP/IP**                   |
| **数据面（Data Plane）**    | 视频编码（H.264/H.265）+ 音频编码 + PES 封装 + HDCP 加密 | **MPEG2-TS over RTP/UDP/IP** |

> 控制面是"打电话谈合同"（必须可靠送达，用 TCP），数据面是"卡车拉货"（要快、丢一两箱可以容忍，用 UDP）。两条线分开走，互不干扰。

---

## 2 三种连接拓扑 — 无线 HDMI 铺在哪条路上

Miracast 本身不建立 L2 连接，它复用三种底层连接方式之一（§3.2）：

![WFD 三种连接拓扑](assets/%E7%AC%AC-16-%E7%AB%A0%EF%BC%9AMiracast%EF%BC%88Wi-Fi-Display%EF%BC%89%E2%80%94-%E6%8A%8A%E5%B1%8F%E5%B9%95%E5%80%9F%E5%88%B0%E5%A4%A7%E7%94%B5%E8%A7%86%E4%B8%8A/16-wfd-topology.svg)

| 拓扑                     | 比喻                       | 适用                | 说明                                                     |
| ------------------------ | -------------------------- | ------------------- | -------------------------------------------------------- |
| **Wi-Fi Direct**         | 两台设备直接结伴           | R1 / R2（**必选**） | 复用第 14 章的 P2P 直连，Source 或 Sink 之一当 GO        |
| **TDLS**                 | 同一个 AP 下的两人"抄近路" | 仅 R1               | 双方都连同一个 AP/GO，建立 TDLS 直连旁路（详见第 15 章） |
| **Wi-Fi Infrastructure** | 都走公司内网               | 仅 R2               | 双方都连基础网络，用 mDNS/DNS-SD 发现，走 IP             |

> **R1 与 R2**：Miracast 规范有两代设备。**R1** 是初代，连接靠 Wi-Fi Direct 或 TDLS；**R2** 增加了走基础设施网络（Infrastructure）的能力，用 mDNS 服务发现，并支持 TCP 传输、Direct Streaming（免转码）等新特性。

## 2.1 连接方案的"裁决"

当 Source 和 Sink 连在同一个 AP 下时，到底用 TDLS 还是 Infrastructure？这由双方的 **PC（Preferred Connectivity，首选连接）位** 和 Associated BSSID 子元素共同裁决（§4.5.1，Table 11）。简单说：双方都偏好 TDLS 且 AP 允许 TDLS，才走 TDLS；否则回退。

## 2.2 R2 的服务发现：用 mDNS"报家门"

R2 设备走基础网络时，用 **mDNS + DNS-SD** 发现彼此（§4.4.1），定义了两个服务名：

| 角色                | Service Type       | 实例名示例            |
| ------------------- | ------------------ | --------------------- |
| WFD R2 Source       | `_displaysrc._tcp` | —                     |
| WFD R2 Primary Sink | `_display._tcp`    | "John Living Room TV" |

> R1 像两个人在空地上直接喊话碰头（Wi-Fi Direct 发现）；R2 则像在公司通讯录里搜"客厅电视"这个名字（mDNS），找到后直接拨分机号（TCP 端口）。

---

# 3 完整建立流程 — 从发现到开播的 11 步

Miracast 把一次投屏的生命周期定义为 11 个步骤（§4.2）。把它们串起来：

![WFD 会话建立流程](assets/%E7%AC%AC-16-%E7%AB%A0%EF%BC%9AMiracast%EF%BC%88Wi-Fi-Display%EF%BC%89%E2%80%94-%E6%8A%8A%E5%B1%8F%E5%B9%95%E5%80%9F%E5%88%B0%E5%A4%A7%E7%94%B5%E8%A7%86%E4%B8%8A/16-wfd-session-flow.svg)

| 步骤 | 阶段                                | 做什么                                                       |
| ---- | ----------------------------------- | ------------------------------------------------------------ |
| 1    | **Device Discovery**                | Source 和 Sink 互相发现（R1 用 Probe Req/Resp，R2 可用 mDNS） |
| 2    | **Service Discovery**（可选）       | 连接前先了解对方的服务能力                                   |
| 3    | **Device Selection**                | 用户从发现列表里选定要投屏的对端                             |
| 4    | **Connection Setup**                | 建立 L2 连接（Wi-Fi Direct/TDLS/Infra）+ 建 TCP 连接         |
| 5    | **Capability Negotiation**          | **RTSP M1–M4**：协商共同支持的音视频格式                     |
| 6    | **Session Establishment**           | **RTSP M5→M6→M7**：Source 选定格式、SETUP、PLAY 开播         |
| 7    | **UIBC Setup**（可选）              | 建立反向输入通道（M14）                                      |
| 8    | **Link Content Protection**（可选） | HDCP 2.x 会话密钥协商（独立 TCP 连接）                       |
| 9    | **Payload Control**                 | 播放期间的控制（暂停、IDR 刷新、码率调整等）                 |
| 10   | **Standby/Resume**（可选）          | 待机与唤醒（M12）                                            |
| 11   | **Session Teardown**                | RTSP TEARDOWN（M8 或 M5）结束会话                            |

## 3.1 TCP 控制端口

L2 连上后，由 **Sink 向 Source 发起**一条 TCP 连接跑 RTSP——Source 当 TCP server、在默认控制端口 **7236** 上监听，Sink 当 TCP client 连上来（端口也可选 49152–65535 范围内的私有端口，§4.5.4）。这条 TCP 连接在 RTSP 会话存续期间一直活着，期间还并行着一个 RTP 媒体会话。

---

# 4 控制面核心 — RTSP M1–M16

这是 Miracast 最有特色的部分。它**借用 RTSP（Real Time Streaming Protocol，RFC 2326）** 作为控制语言，并定义了一套固定编号的消息 **M1 到 M16**（§6.4，Table 98）。

> **先纠正一个常见误解**：M1～M16 **不是 16 条单向消息顺序排成一串**。**每个 Mx 本身就是一对 Request/Response**——规范里就叫 "M1 Request" / "M1 Response"、"M6 Request" / "M6 Response"……发起方发出 `Mx Request`，对端回一个 `Mx Response`（带状态码，RTSP OK 表示成功）。所以下面每张表里都给出**谁发 Request、谁回 Response**两列；"发起方"指的是发 `Mx Request` 的那一方。

> **为什么是 RTSP？** RTSP 本来就是为"远程控制流媒体播放"设计的（想象网络摄像头的播放/暂停）。Miracast 直接拿来当投屏双方的"谈判语言"和"遥控指令集"。

![RTSP M1-M16 消息序列](assets/%E7%AC%AC-16-%E7%AB%A0%EF%BC%9AMiracast%EF%BC%88Wi-Fi-Display%EF%BC%89%E2%80%94-%E6%8A%8A%E5%B1%8F%E5%B9%95%E5%80%9F%E5%88%B0%E5%A4%A7%E7%94%B5%E8%A7%86%E4%B8%8A/16-rtsp-sequence.svg)

## 4.1 能力协商阶段（M1–M4）

| 消息   | 发 Request | 回 Response | RTSP 方法     | 作用                                                 | 比喻                 |
| ------ | ---------- | ----------- | ------------- | ---------------------------------------------------- | -------------------- |
| **M1** | Source     | Sink        | OPTIONS       | 问 Sink 支持哪些 RTSP 方法                           | "你会哪些指令？"     |
| **M2** | Sink       | Source      | OPTIONS       | 反问 Source 支持哪些方法                             | "你又会哪些？"       |
| **M3** | Source     | Sink        | GET_PARAMETER | **查询 Sink 的能力**（分辨率、编解码、UIBC、端口等） | "你这台电视啥本事？" |
| **M4** | Source     | Sink        | SET_PARAMETER | **下发选定的参数**（从共同能力中挑一个格式）         | "那就按 1080p60 来"  |

每行都是一次完整往返：例如 **M1 = Source 发 `M1 Request`（OPTIONS）→ Sink 回 `M1 Response`**；M2 方向正好反过来（Sink 发、Source 回）。M1/M2 合起来是对称的"互报家门"——双方各问一次对方支持哪些方法。

**M3 是关键**——Source 发 `M3 Request`（GET_PARAMETER）询问 Sink 的一系列参数（`wfd-video-formats`、`wfd-audio-codecs`、`wfd-client-rtp-ports`、`wfd-uibc-capability` 等），Sink 在 **`M3 Response`** 里如实回答。然后 Source 发 **`M4 Request`**（SET_PARAMETER）从双方共同支持的能力中**选定一组**音视频格式下发，并附上 `wfd-presentation-url`（后续 SETUP 要用的 URI），Sink 回 `M4 Response` 确认。

> **重要细节**：Source 在 M3 Request 里包含某个可选参数，本身就**隐含"我支持这个可选特性"**（§6.4.3）。这是一种巧妙的能力声明方式。

## 4.2 会话建立阶段（M5–M7）

| 消息   | 发 Request | 回 Response | RTSP 方法                             | 作用                                                    |
| ------ | ---------- | ----------- | ------------------------------------- | ------------------------------------------------------- |
| **M5** | Source     | Sink        | SET_PARAMETER（`wfd-trigger-method`） | **触发** Sink 去发起 SETUP/PLAY/TEARDOWN/PAUSE          |
| **M6** | Sink       | Source      | SETUP                                 | 建立 RTP 媒体会话，Source 在 Response 里返回 session id |
| **M7** | Sink       | Source      | PLAY                                  | **开始串流**，Source 回 OK 后开始发送音视频             |

这里有个**反直觉、也最容易看错方向**的设计：M5 的 Request 由 **Source** 发，但 **M6、M7 的 Request 却是 Sink 发的**（Source 来回 Response）。原因是一套"**触发-执行**"机制——Source 想开播，并不直接喊"开机"，而是先发 **`M5 Request`**（trigger=SETUP）告诉 Sink"你去发个 SETUP"；Sink 收到后才发 **`M6 Request`**（SETUP），Source 回 `M6 Response`（带 session id）；接着 Sink 再发 **`M7 Request`**（PLAY），Source 回 `M7 Response` OK。

> 导演（Source）不直接喊"开机"，而是给副导演（Sink）递个眼色（`M5 Request`，trigger），副导演这才喊出正式口令（`M6`/`M7` Request：SETUP / PLAY），导演应一声"好"（Response）。这套机制让 RTSP 的状态机保持清晰——**正式的 SETUP/PLAY 请求统一由 Sink 这一侧发出**。

M7（PLAY）成功后，Source 开始向 M6 里协商的 RTP 端口发送音视频流。**第一帧视频必须是带 SPS/PPS 的 IDR 帧**（§6.4.7），保证 Sink 能立即解码起播。

## 4.3 播放控制阶段（M8–M16）

这一阶段同样每个 Mx 都是 `Request`/`Response` 一对；这里大多是 Sink 发 Request、Source 回 Response（其中 M8/M9 既可由 Source 先用 M5 触发，也可由 Sink 主动发起）：

| 消息    | 发 Request | 回 Response | 作用                                                         |
| ------- | ---------- | ----------- | ------------------------------------------------------------ |
| **M8**  | Sink       | Source      | TEARDOWN — 结束会话（可由 M5 trigger=TEARDOWN 触发，或 Sink 主动发起） |
| **M9**  | Sink       | Source      | PAUSE — 暂停音视频（可由 M5 trigger=PAUSE 触发，或 Sink 主动发起） |
| **M10** | Sink       | Source      | `wfd-route` — Coupled Sink 下切换音频渲染到哪个 Sink         |
| **M11** | Sink       | Source      | `wfd-connector-type` — 切换活动连接器类型（内容保护相关）    |
| **M12** | 任一方     | 对端        | `wfd-standby` — 进入待机模式                                 |
| **M13** | Sink       | Source      | `wfd-idr-request` — **请求 IDR 刷新**（画面花屏时重新来个关键帧） |
| **M14** | 任一方     | 对端        | `wfd-uibc-capability` — **建立/更新 UIBC**（反向输入通道）   |
| **M15** | 任一方     | 对端        | `wfd-uibc-setting` — 启用/禁用 UIBC                          |
| **M16** | **Source** | Sink        | GET_PARAMETER（空 body）— **会话保活心跳**                   |

> M8–M16 就像电视遥控器上的那一排按钮——M9 暂停、M8 停止、M10/M11 切换声音给电视还是音箱、M12 待机、M13 是花屏时按一下"恢复清晰"（重发关键帧）、M14/M15 配好鼠标键盘，M16 则是那盏"我还活着"的呼吸灯。

**M16 保活**值得单独说：Source 周期性发 `M16 Request`（GET_PARAMETER，空 body），Sink 回 `M16 Response` 确认 RTSP 会话还活着（§6.4.16）。如果在超时时间内收不到 `M16 Response`，Source 就中止 RTSP 和 RTP 会话——相当于"心跳断了就挂断"。

## 4.4 超时规则

Miracast 对各阶段有严格超时（§6.5）：

| 规则                                                         | 超时                  |
| ------------------------------------------------------------ | --------------------- |
| TCP 建立后到发 M1                                            | 6 秒内                |
| 一般 RTSP 消息往返（M1–M15，M16 除外）                       | 5 秒                  |
| 会话建立前，连续 RTSP 请求的间隔（如 M2 Response 后发 M3 Request） | 6 秒内                |
| WPA2 四次握手第 4 帧（即 4-Way Handshake 的 M4，**非** RTSP M4）成功后到建 TCP（Wi-Fi Direct / TDLS） | 90 秒内               |
| M16 会话超时默认值（M6 Response 未指定时）                   | 60 秒（不小于 10 秒） |

> **别踩这个坑**：上表"90 秒"那行里的 **M4 指 WPA2 四次握手的第 4 个握手帧**（§6.5.2），和本节满屏的 RTSP M1–M16 **完全是两码事**——它说的是底层 Wi-Fi Direct 四次握手跑完后、必须在 90 秒内建好跑 RTSP 的 TCP 连接。

---

# 5 数据面 — 画面和声音怎么传

## 5.1 编解码

| 类型     | 强制格式                           | 说明                                                         |
| -------- | ---------------------------------- | ------------------------------------------------------------ |
| **视频** | H.264 CBP @ Level 3.1，640×480 p60 | 所有支持视频的 WFD 设备必须支持（§3.4.2）；R2 还可用 H.264 Level 3.1–5.2 / H.265 Level 3.1–5.1，支持 4K |
| **音频** | LPCM 48 ksps/16 bit/2ch            | 强制（§3.4.1）；可选 AAC-LC、AC-3 等                         |

## 5.2 封装与传输

视频/音频先经 **PES 封装**，复用进 **MPEG2-TS**，再走 **RTP/UDP/IP** 发送（§4.10.2）。R2 还支持 **TCP 传输**和 **TCP↔UDP 切换**（应对拥塞），以及 **Direct Streaming（免转码模式）**——当 Sink 原生支持内容格式时，Source 不必转码直接转发，省电省时延（§4.16）。

## 5.3 内容保护：HDCP 2.x

受保护内容（如付费视频）传输前，Source 和 Sink 要先完成 **HDCP 2.x 会话密钥协商**（§4.7）。关键点：HDCP 的 AKE、locality check、SKE 消息走**一条独立于 RTSP 的 TCP 连接**。如果 HDCP 协商失败，就只能传不需要保护的内容。

> HDCP 就像运钞车的押运协议——贵重货物（受版权保护的视频）必须先和接收方核验"保险柜钥匙"（会话密钥），核验走的还是另一条专用保密线路。核验不过，就只能拉普通货。

## 5.4 时间同步 — 投屏为什么不"音画不同步"

这是投屏体验的命根子，却最容易被忽略：Source 和 Sink 是**两台各自独立的设备，时钟不一样**；网络又会带来**抖动（jitter）**。如果不处理，画面和声音就会越漂越远，或者画面忽快忽卡。Miracast 用一套时钟同步机制来兜底（§4.10.1）：

![Miracast 时间同步](assets/%E7%AC%AC-16-%E7%AB%A0%EF%BC%9AMiracast%EF%BC%88Wi-Fi-Display%EF%BC%89%E2%80%94-%E6%8A%8A%E5%B1%8F%E5%B9%95%E5%80%9F%E5%88%B0%E5%A4%A7%E7%94%B5%E8%A7%86%E4%B8%8A/16-time-sync.svg)

- **PCR + RTP 时间戳打底**：音视频复用进 MPEG2-TS 时，流里嵌了 **PCR（Program Clock Reference，节目时钟参考）**；每个 RTP 包还带一个 **32-bit 时间戳**（90 kHz 单位，一个 tick = 11.11 µs），对应"这包第一个 TS 分组到达打包层的时刻"。关键在**同源**：RTP 时间戳与 PCR 都源自 WFD Source 的 MPEG-2 系统时钟（27 MHz），RTP 时间戳只是把这口钟按 90 kHz 分频，规范还要求它与 PCR 对齐（§4.10.2）。于是 Sink 无论从 PCR 还是 RTP 时间戳恢复，得到的都是同一根节拍，音画才对齐。
- **可选的 gPTP 精确同步**：设备可通过 **Time Synchronization Support 位**（在 WFD Device Info 里，见 §5.1.2）声明支持 **IEEE 802.1AS 的 gPTP**。此时 **Source 当"大师钟"（grandmaster clock）**，Sink 通过交换 **802.11v Timing Measurement** 帧把自己的时钟同步到 Source。
- **Sink 端去抖动（de-jittering）**：时钟对齐后，Sink 用一个缓冲机制吸收网络抖动，再平稳地解码渲染——代价是引入一点固定延迟，换来"不卡不飘"。

> 两个鼓手（Source/Sink）各打各的拍子，时间一长必然错乱。解决办法是让一个当**节拍器**（grandmaster clock），另一个时刻对表；再加一个"缓冲蓄水池"（去抖动）把忽快忽慢的水流抹平，放出来的水才匀速。这就是投屏不"音画不同步"的底层功夫。

## 5.5 码率自适应 — 网络变差时怎么扛

Wi-Fi 信道质量会波动；Source 也可能想省电。**Source 可以动态调整编码码率**（§4.10.3），两种办法：

| 方式             | 怎么做                                                       | 要不要重新协商                                  |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| **隐式调整**     | 在 H.264 内部做文章：改压缩比、宏块跳过、**丢帧（frame skipping）** | 不用，闷头调                                    |
| **显式格式变更** | 发 **RTSP M4 Request** 改分辨率/帧率等（叫 **WFD Capability Re-negotiation**） | 要，且变更视频格式后须立刻发一个 **IDR 帧**重置 |

- **丢帧**有规矩：被别的帧参考的帧不能丢（否则花屏），且两帧间隔不能超过 Sink 在 M3 里声明的 `Max Skip Interval`。
- **显式变更**要带 `wfd-av-format-change-timing` 参数指明何时生效；改分辨率/帧率后那一下可能需要更高的瞬时吞吐（因为要发 IDR）。

> 路况变堵（网络变差），司机有两招——要么**少拉点货、压一压**（隐式：降压缩、丢几帧，不用打电话报备）；要么**正式改运输方案**（显式：发 M4 重新定分辨率/帧率），但改完得先发一车"完整样品"（IDR 帧）让对方重新对齐。

## 5.6 R2 增强：Direct Streaming 免转码

R2 还有一个省电提速的招：**Direct Streaming（免转码模式）**（§4.16）。当 Sink **原生支持** Source 手里内容的编码格式时，Source 不必先解码再重编码，**直接把原始码流转发**过去，省了转码的算力、延迟和耗电。切换由 M4 里的 `wfd2-direct-streaming-mode` 参数控制。注意：免转码时 Sink **不应**再发 M13（IDR 请求），因为 Source 此刻没有转码器、给不出随时生成的 IDR。

---

# 6 UIBC — 在大屏上反控手机

**UIBC（User Input Back Channel，用户输入反向通道）** 是 Miracast 的点睛之笔（§4.11）：投屏时，**Sink 端的用户输入（鼠标、触摸、遥控器）可以反向传回 Source**，从而在大屏上操作手机。

![UIBC 反向输入通道](assets/%E7%AC%AC-16-%E7%AB%A0%EF%BC%9AMiracast%EF%BC%88Wi-Fi-Display%EF%BC%89%E2%80%94-%E6%8A%8A%E5%B1%8F%E5%B9%95%E5%80%9F%E5%88%B0%E5%A4%A7%E7%94%B5%E8%A7%86%E4%B8%8A/16-uibc.svg)

## 6.1 两类输入

UIBC 数据走 **TCP**，封装在一个公共包头里，包头的 **Input Category** 字段区分两类输入（§4.11.1，Table 13）：

| Category | 类型        | 说明                                                   |
| -------- | ----------- | ------------------------------------------------------ |
| 0        | **Generic** | 通用输入：鼠标、单点触摸等，用通用输入体格式           |
| 1        | **HIDC**    | HID 类输入：蓝牙鼠标、红外遥控器等，用 HIDC 输入体格式 |

包头还有 Version（3 bit，固定 0b000）、T 位（是否带时间戳）、Length（整个 TCP 载荷长度）等字段。可选的 **Timestamp** 字段记录"用户输入作用时画面对应的 RTP 时间戳"——用于把"点哪"和"当时屏上是什么"对齐。

## 6.2 建立方式

UIBC 用 RTSP 的 GET/SET_PARAMETER 建立和维护：Source 先在 **M3** 里查询 Sink 的 `wfd-uibc-capability`，再用 **M4 或 M14** 下发 UIBC 配置（含 Source 监听的 TCP 端口）。建立后，一条专用 TCP 连接服务整个 Session 的 UIBC 数据（§4.11.2）。

> **交通比喻**：投屏本来是"单向供货"（Source→Sink）。UIBC 开了一条"反向回执专线"——大卖场（电视）的顾客操作（遥控器/触摸），通过这条专线传回供货商（手机），让你能在大屏上反向操控小屏。

---

# 7 进阶场景 — Coupled Sink、持久组、并发

前面讲的是"一台手机投一台电视"的主线。规范还定义了几个进阶能力，前两章（P2P / TDLS）的功底在这里直接复用。

## 7.1 Coupled Sink — 画面给电视，声音给音箱

§5.1 的角色表提过 Secondary Sink，这里讲它怎么协同。**Coupled Sink Operation（耦合 Sink）**让 Source 把**视频投到 Primary Sink（电视）**，同时把**音频路由到 Primary 或 Secondary Sink（音箱）**——典型场景是电视放画面、家庭影院音箱放声音（§4.9）。

要点：

- 三方都必须支持此特性（Source / Primary Sink / Secondary Sink）才能启用；
- 用前两个 Sink 之间先建立一个 **"Coupled（耦合）"状态**（过程几乎等同一次 WFD 能力协商），再由 Source 分别与两个 Sink 建会话；
- 音频在 Primary 与 Secondary 之间切到哪边渲染，由 **M10（`wfd-route`）** 控制；
- 底层连接 Wi-Fi Direct / TDLS 都行（走 TDLS 时要求 GO 支持 intra-BSS 分发）。

> **交通比喻**：一笔订单拆给两家收货——画面这箱货送"大卖场"（电视），声音那箱送"音响店"（音箱），但两家得先"结对登记"（Coupling），供货商才好分别对账发货。

## 7.2 持久组与并发 — 直接吃第 14 章的红利

这两条几乎是"零新增"，因为 Miracast 把底层完全甩给了 Wi-Fi Direct：

- **持久组（§4.13）**：WFD over Wi-Fi Direct 的持久组**就是第 14 章讲的 P2P Persistent Group，没有任何 Miracast 私有信息**。所以"投过一次的电视下次秒连"靠的就是 P2P 持久组那套（存 Group ID + Credentials，免重新配对）。（注：v1.0 里基于 TDLS 的持久组已被废弃。）
- **并发（§4.14）**：投屏的同时还能上网——Source/Sink **可以一边连着家里的 AP、一边跑 WFD Session**。走 Wi-Fi Direct 时遵循第 14 章的 **P2P Concurrent Device** 规则；走 TDLS 时更天然——双方本来就关联同一个 AP，并发是第 15 章 TDLS 的固有能力。

> 换句话说：**"秒重连"和"边投边上网"不是 Miracast 新发明的，而是它站在 P2P / TDLS 肩膀上白捡的。** 这也呼应了本章开头那句"Miracast 自己不发明底层连接"。

---

# 8 帧格式 — WFD IE 与关键子元素

和前两章一样，把承载 Miracast 信令的"信封"拆开看（§5.1）。Miracast 不发明新帧类型，而是复用 **Vendor Specific（厂商自定义）** 机制——和 P2P 同源。

## 8.1 WFD IE 结构

发现阶段的能力宣告，靠塞进管理帧（Beacon / Probe Req/Resp / Association）里的 **WFD Information Element（WFD IE）**（§5.1.1）：

| 字段            | 大小 | 值         | 说明                                     |
| --------------- | ---- | ---------- | ---------------------------------------- |
| Element ID      | 1    | `0xDD`     | 802.11 厂商自定义 IE                     |
| Length          | 1    | 可变       | 后续字段长度                             |
| **OUI**         | 3    | `50 6F 9A` | Wi-Fi Alliance 的 OUI（和 P2P 同一个！） |
| **OUI Type**    | 1    | `0x0A`     | 标识这是 WFD v1.0 的 IE                  |
| WFD subelements | 可变 | —          | 一个或多个 **WFD 子元素**                |

一个 WFD IE 里装一个或多个**子元素**，每个子元素 = `Subelement ID(1) + Length(2) + body`。子元素类型表（§5.1，Table 27）：

| ID   | 子元素                     | 作用                                  |
| ---- | -------------------------- | ------------------------------------- |
| 0    | **WFD Device Information** | 设备角色与一堆能力位（最核心）        |
| 1    | Associated BSSID           | 自己关联的 AP/GO 地址（裁决 TDLS 用） |
| 6    | Coupled Sink Information   | 耦合状态 + 配对 Sink 的 MAC           |
| 7    | WFD Extended Capability    | 扩展能力位                            |
| 8    | Local IP Address           | 本地 IP（R2 走基础网络用）            |
| 9    | WFD Session Information    | 会话信息                              |
| 10   | Alternative MAC Address    | 备用 MAC                              |
| 11   | WFD R2 Device Information  | R2 设备信息（区分 R1/R2 用）          |

## 8.2 WFD Device Information 子元素 — 一格 16 bit 说尽身份与能力

最核心的是 **ID=0 的 Device Information 子元素**：它含一个 2 字节的 **Session Management Control Port**（默认 7236，即跑 RTSP 的 TCP 端口）和一个 **2 字节位图**（§5.1.2，Table 29）。这个位图一帧就把"我是谁、我支持啥"说清楚了：

| 比特  | 字段                             | 含义                                                        |
| ----- | -------------------------------- | ----------------------------------------------------------- |
| 1:0   | **WFD Device Type**              | 00=Source / 01=Primary Sink / 10=Secondary Sink / 11=双角色 |
| 2     | Coupled Sink Support (Source)    | Source 是否支持 Coupled Sink                                |
| 3     | Coupled Sink Support (Sink)      | Sink 是否支持 Coupled Sink                                  |
| 5:4   | **WFD Session Availability**     | 当前是否可被建会话（00=不可 / 01=可用）                     |
| 6     | Service Discovery Support        | 是否支持 WFD 服务发现                                       |
| 7     | **PC（Preferred Connectivity）** | 首选连接：0=Wi-Fi Direct / 1=TDLS（§4.5.1 裁决就看它）      |
| 8     | **CP Support**                   | 是否支持 HDCP 2.x 内容保护                                  |
| 9     | **Time Synchronization**         | 是否支持 802.1AS 时钟同步（§5.1.2）                         |
| 10    | Audio unsupported at Primary     | 作 Primary Sink 时是否不支持音频渲染（耦合场景用）          |
| 11    | Audio only at Source             | 作 Source 时是否支持只发音频                                |
| 12–13 | TDLS Persistent Group 相关       | （历史字段）                                                |

> **读法**：当年那张"用 TDLS 还是 Wi-Fi Direct"的裁决（§4.5.1）、"支不支持内容保护""支不支持时钟同步"，全在这一个 16 bit 位图里一次性广播出去——对端在**发现阶段**就能据此决定要不要、怎么和你建会话。

> **交通比喻**：WFD IE 就像设备进门时别在胸前的一张"资质胸牌"：OUI/OUI Type 表明"我是 Miracast 阵营的"，Device Information 位图则一行行写明"我是供货商还是卖场、走哪条路、收不收加密货、对不对表"。对方扫一眼胸牌，就知道该不该跟你谈、怎么谈。

---

# 9 完整流程串讲

把全章串起来，手机投屏到电视的完整过程（下面每个 Mx 仍是一次 Request/Response 往返，为简洁只写编号）：

```
1. 底层直连   手机(Source)与电视(Sink)用 Wi-Fi Direct 直连成组
            （第 14 章：GO 协商 + WPS + 四次握手 + 发 IP）
                  │
2. 建 TCP    Sink 向 Source 的控制端口(默认 7236)发起 TCP 连接（Source 是 server）
                  │
3. 能力协商   M1/M2 互报支持的方法 → M3 查电视能力
            → M4 选定 1080p60 + H.264 + 音频格式
                  │
4. 会话建立   M5(trigger SETUP) → M6(SETUP, 返回 session id)
            → M7(PLAY) 开播，首帧为 IDR
                  │
5. 数据串流   H.264 视频 + 音频 → PES → MPEG2-TS → RTP/UDP
            受保护内容先过 HDCP 2.x(独立 TCP 协商密钥)
                  │
6. 反向控制   M14 建立 UIBC，电视遥控/触摸反传回手机
                  │
7. 保活       Source 周期发 M16 心跳确认会话存活
                  │
8. 结束       M8(TEARDOWN) 或 M5(trigger TEARDOWN) 拆除会话
```

---

# 10 本章总结

| 机制                        | 作用                                   | 无线 HDMI 比喻             |
| --------------------------- | -------------------------------------- | -------------------------- |
| **Source / Sink / Session** | 投屏方 / 显示方 / 一次会话             | 供货商 / 卖场 / 供货合同   |
| **控制面 vs 数据面**        | RTSP/TCP 谈判 vs MPEG2-TS/RTP/UDP 拉货 | 打电话谈合同 vs 卡车拉货   |
| **三种拓扑**                | Wi-Fi Direct / TDLS / Infra            | 直接结伴 / 抄近路 / 走内网 |
| **M1–M4**                   | 能力协商                               | 对暗号、报本事、定格式     |
| **M5–M7**                   | 会话建立                               | 递眼色触发、SETUP、开播    |
| **M5 trigger 机制**         | Source 触发 Sink 发请求                | 导演递眼色，副导演喊口令   |
| **M8–M16**                  | 播放控制 + 保活                        | 暂停/拆除/IDR刷新/心跳     |
| **H.264 + MPEG2-TS/RTP**    | 音视频编码与传输                       | 货物打包装车               |
| **时间同步（PCR/gPTP）**    | 防音画不同步、抗抖动                   | 对节拍器 + 缓冲蓄水池      |
| **码率自适应**              | 网络变差时降码率/丢帧/改格式           | 路堵了少拉货或改运输方案   |
| **HDCP 2.x**                | 内容保护                               | 运钞车押运核验             |
| **UIBC**                    | 反向输入通道                           | 反向回执专线，大屏控小屏   |
| **Coupled Sink**            | 画面给电视、声音给音箱                 | 一单拆两家收货             |
| **持久组 / 并发**           | 秒重连 + 边投边上网（复用第 14 章）    | 老搭子直接约 + 脚踏两条船  |
| **WFD IE（OUI 50:6F:9A）**  | 发现期广播角色与能力位图               | 进门别的资质胸牌           |

Miracast 的精髓是：**用 Wi-Fi Direct 搭好"无线的路"，用 RTSP 的 M1–M16 当"投屏双方的谈判与遥控语言"，把音视频以 MPEG2-TS over RTP 实时串流——本质就是一根可协商、可反控、可加密的"无线 HDMI"。**

---

> 下一章将讲述：不连 AP、不联网，设备之间怎么发现"附近谁提供了什么服务"？Wi-Fi Aware 如何让一群设备自发同步出"集合时间窗"？Publish/Subscribe 如何像"举牌广播"和"按图索骥"那样匹配服务？发现之后又如何直接建数据通道（NDP）？
