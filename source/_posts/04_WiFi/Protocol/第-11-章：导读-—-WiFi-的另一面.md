---
title: 第 11 章：导读 — WiFi 的另一面
top: 1
related_posts: true
abbrlink: 63d6c453
date: 2026-09-14 07:35:57
tags:
  - 802.11
categories:
  - WiFi
  - Protocol
---

> "你以为 WiFi 就是'连上路由器上网'。但 WiFi 还有另一面：从'怎么把设备安全地接进网络'，到'设备之间不靠路由器也能直接发现、连接、协作、感知'。"

---

# 1 为什么要有这个系列？

如果你读过本系列第一部分 [802.11 演进史](/posts/b498d4cd/)，你已经熟悉了 WiFi 的"主线剧情"——从 1997 到 Wi-Fi 7，IEEE 802.11 标准如何让"设备连上 AP 上网"越来越快、越来越稳。那条主线讲的是**物理层和 MAC 层的“路怎么修得更宽更快”**。

<!--more-->

但 WiFi 还有"**另一面**"——一组主要由 **Wi-Fi 联盟（Wi-Fi Alliance）** 定义、架在 802.11 之上的**服务层协议**。它们不关心"路修得多快"，而关心**两类更贴近使用场景的问题**：

> **① 怎么把一台设备安全、省事地"接进"网络？**（尤其是没有屏幕键盘的 IoT 设备、跨运营商的漫游）
> **② 设备之间不依赖某个中心 AP，怎么直接发现彼此、建立连接、协同工作、甚至测出距离？**

这正是本系列要讲的**七个协议**，按"**接入 → 直连 → 应用**"分成三组：

| 组             | 协议                          | 一句话定位                                      |
| -------------- | ----------------------------- | ----------------------------------------------- |
| **A 接入配网** | **DPP（Wi-Fi Easy Connect）** | 扫个二维码，就把设备安全地配进网络              |
|                | **Passpoint（Hotspot 2.0）**  | 像手机蜂窝网一样，自动无缝漫游接入运营商 WiFi   |
| **B 设备直连** | **Wi-Fi Direct（P2P）**       | 不要路由器，两台设备临时组队直接通信            |
|                | **TDLS**                      | 都连着同一个 AP，却绕开它走一条桌对桌的直连捷径 |
| **C 上层应用** | **Miracast（Wi-Fi Display）** | 把一块屏幕的音视频实时甩到另一块屏幕上          |
|                | **Wi-Fi Aware（NAN）**        | 不联网，也能发现"附近谁提供了什么服务"          |
|                | **RTT / FTM**                 | 把 WiFi 当尺子用，测距离、做室内定位            |

---

# 2 它们和 802.11 主线是什么关系？

一句话：**这七个协议都站在 802.11 的肩膀上，但各自跳出了"连 AP 高速上网"这一单一范式。**

![WiFi 另一面 — 七协议全景](assets/%E7%AC%AC-11-%E7%AB%A0%EF%BC%9A%E5%AF%BC%E8%AF%BB-%E2%80%94-WiFi-%E7%9A%84%E5%8F%A6%E4%B8%80%E9%9D%A2/11-overview.svg)

- 它们复用 802.11 的**物理层、MAC 层、安全机制**（WPA2/WPA3、四次握手、管理帧、GAS/ANQP 等）。
- 但它们各有侧重：**接入组**解决"怎么连得安全省事"，**直连组**解决"不靠中心 AP 也能通"，**应用组**解决"连上之后能玩出什么花样"。
- 它们多由 **Wi-Fi 联盟**定义（认证品牌：Wi-Fi Easy Connect / Passpoint / Wi-Fi Direct / Miracast / Wi-Fi Aware），少数底层机制（TDLS、FTM）直接在 **IEEE 802.11** 标准内。

> **交通比喻（呼应第一部分）**：如果说 802.11 主线是"城市主干道怎么修得更宽更快"，那么这七个协议就是"主干道之外的另一面生活"——**办张通行证进城（DPP 配网）、跨城自动刷卡通行（Passpoint 漫游）、两人临时拼车结伴（P2P）、邻座同事不走前台直接递纸条（TDLS）、把内容投到邻居家电视上（Miracast）、邻里之间串门打听（Aware 发现）、用脚步声估摸对方多远（RTT 测距）**。

---

# 3 七个协议各自的比喻速查

本系列每个协议用**各自最贴切的比喻**（而非强行套用一个统一隐喻），这样每章都能找到最直观的入口：

| 协议                          | 本系列比喻                            | 比喻速记                                                     |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| **DPP（Wi-Fi Easy Connect）** | **扫码进门的访客登记**                | 扫一下二维码（交换公钥），门卫（Configurator）当场发你专属门禁卡（Connector） |
| **Passpoint（Hotspot 2.0）**  | **手机网络式的自动漫游**              | 像蜂窝网一样，走到哪自动认网、自动认证，不用每次输密码选 SSID |
| **Wi-Fi Direct（P2P）**       | **临时结伴的旅行团**                  | 当场推举领队（GO），团员（Client）跟着走；老搭子免协商秒重组 |
| **TDLS**                      | **同一公司里抄条内线**                | 仍是公司员工（仍连 AP），但两个工位间拉条直线，不再走前台中转 |
| **Miracast**                  | **把屏幕"借"到大电视上（无线 HDMI）** | 投屏双方"对暗号"协商格式（RTSP M1–M16），再串流音视频        |
| **Wi-Fi Aware（NAN）**        | **广场上的兴趣广播**                  | 约定时间窗聚会，举牌"我提供 / 谁提供"，对上眼再单独建通道    |
| **RTT / FTM**                 | **用"喊话 + 掐表"算距离（回声测距）** | 发一帧收一帧、量时间差，距离 = 光速 × RTT / 2                |

---

# 4 七个协议之间的依赖关系

它们不是孤立的，三组之间有清晰的层次与联动：

```
                 +---------------------------+
                 | IEEE 802.11 (PHY/MAC/SEC) |   <- 共同地基
                 +---------------------------+
                               |
   [A 接入]      DPP        Passpoint
                  |            | (GAS/ANQP 查询能力)
                  +-----+------+
                        |  把设备/用户接入网络
   [B 直连]      Wi-Fi Direct      TDLS
                  ^                  ^
                  |                  | (Miracast 可跑在其上)
   [C 应用]       +---- Miracast ----+
                Wi-Fi Aware  --ranging-->  RTT / FTM
```

> **图例**：DPP＝扫码配网 ｜ Passpoint＝运营商无缝漫游 ｜ Wi-Fi Direct＝设备直连 ｜ TDLS＝同一 AP 下的直连旁路 ｜ Wi-Fi Aware＝邻居感知 ｜ RTT/FTM＝精确测距 ｜ GAS/ANQP＝接入前查询网络能力的通用机制 ｜ ranging＝NAN Ranging flag（Aware 联动 FTM 测距）。
> 读图：最上是共同地基 **IEEE 802.11**；**接入组**把设备/用户安全接进网络，**直连组**让设备点对点通信，**应用组**在直连之上做投屏/发现/测距。**Miracast** 依赖 Wi-Fi Direct / TDLS 作底层承载；**Wi-Fi Aware** 经 ranging 联动 **RTT/FTM**。

- **DPP 与 Passpoint 同属"接入"**：DPP 解决"设备怎么安全配进网络"（尤其无屏 IoT），Passpoint 解决"用户怎么跨网络无缝漫游认证"。两者都重度依赖 802.11u 的 **GAS/ANQP** 查询机制。
- **TDLS 与 P2P 同属"直连"**：两者都让设备点对点直传，区别是 **TDLS 双方仍关联 AP**（只抄近路），而 P2P 彻底不要 AP。
- **Miracast 依赖底层连接**：它本身不建连接，而是跑在 **Wi-Fi Direct / TDLS / Infrastructure** 之上。
- **Wi-Fi Aware 联动 FTM**：NAN 的服务发现里有 **NAN Ranging flag**，可结合 FTM 测距，实现"只和近距离的服务交互"。
- **七者共享 802.11 地基**：物理层、MAC、WPA2/WPA3、GAS/ANQP 都是复用的。

---

# 5 每个协议你将带走的核心认知

读完本系列，你应该能清晰回答这些问题：

**DPP（Wi-Fi Easy Connect）**

- 一个没有屏幕和键盘的 IoT 设备，怎么安全地配进 WiFi？（扫码交换公钥）
- Configurator 和 Enrollee 是什么角色？四步流程（Bootstrapping→Authentication→Configuration→Network Introduction）各干什么？
- 为什么扫一下二维码就能防中间人攻击？（公钥引导信任）

**Passpoint（Hotspot 2.0）**

- 为什么有些 WiFi 不用选 SSID、不用输密码就自动连上？
- 手机在关联前，怎么"隔空"问到这个 AP 背后是哪些运营商？（GAS/ANQP）
- Discovery（发现）→ Secure Access（安全接入）两个状态在干什么？第一次没账号时 OSU 在线签约怎么走？

**Wi-Fi Direct（P2P）**

- 没有路由器，两台设备怎么组成网络？（GO 临时扮演 AP）
- 谁来当"领队"？（GO Intent + Tie-breaker 的三次握手）
- 发现机制为什么靠"社交信道 + 随机化"？老搭子怎么免协商重连？

**TDLS**

- 都连着同一个 AP 的两台设备，为什么数据还要绕 AP 中转？怎么抄近路？
- 为什么建立信令要"先借道 AP"，而它本身却叫"隧道直连"？
- 直连建好后，怎么切到比 AP 更空闲的信道获得更高速率？

**Miracast**

- 投屏的画面和声音怎么无线传？（H.264 + MPEG2-TS over RTP）
- RTSP 的 M1–M16 在协商和控制什么？
- 为什么能在大屏上反控手机？（UIBC）

**Wi-Fi Aware（NAN）**

- 不连 AP、不联网，设备怎么发现彼此的服务？
- 一群设备如何自发同步出"集合时间窗"（DW）？
- Publish/Subscribe 怎么匹配？发现后怎么直接建数据通道（NDP）？

**RTT / FTM**

- WiFi 怎么当尺子用？（距离 = 光速 × RTT / 2）
- t1/t2/t3/t4 四个时间戳怎么算出 RTT、还能免对表？
- 为什么三个 AP 就能给你室内定位？802.11az 带来了什么增强？

---

# 6 关于准确性

本系列的所有技术结论都基于以下规范原文：

| 协议                      | 规范来源                                                     |
| ------------------------- | ------------------------------------------------------------ |
| DPP（Wi-Fi Easy Connect） | `Wi-Fi Easy Connect Specification v3.0.pdf`（Wi-Fi Alliance, 2022） |
| Passpoint（Hotspot 2.0）  | `Passpoint Specification v3.4.pdf`（Wi-Fi Alliance, 2024）+ `80211-2024.pdf`（802.11u GAS/ANQP） |
| Wi-Fi Direct（P2P）       | `Wi-Fi Direct Specification v2.0_0.pdf`（Wi-Fi Alliance）    |
| TDLS                      | `80211-2024.pdf`（IEEE Std 802.11-2024，Clause 11.20 / Clause 9） |
| Miracast（Wi-Fi Display） | `Miracast Specification v2.3.pdf`（Wi-Fi Alliance, 2024）    |
| Wi-Fi Aware（NAN）        | `Wi-Fi Aware Specification v4.0.pdf`（Wi-Fi Alliance, 2022） |
| RTT / FTM                 | `80211-2024.pdf`（IEEE Std 802.11-2024，Clause 11.21 / Clause 9） |

每章正文会标注关键结论对应的规范章节。如果你发现任何与规范原文不符的内容，请以规范原文为准。

---

# 7 术语约定（沿用第一部分）

- **技术术语保留英文原文**，如 GO、NDP、FTM、RTSP、ANQP、Connector、Discovery Window 等。
- **首次出现时给出中文解释**，缩写首次出现给出全称。
- 这样便于你后续查阅芯片手册、协议标准等原始资料。

---

第一部分把「城市主干道」修得越来越宽，这一部带你拐进主干道之外的另一面生活——两条路拼在一起，才是完整的 WiFi 城市。

> **准备好了吗？让我们从"扫个码就进门"的 DPP 开始。**
