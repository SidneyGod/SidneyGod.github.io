---
title: 第 13 章：Passpoint（Hotspot 2.0）— 手机网络式的自动漫游
top: 1
related_posts: true
tags:
  - 802.11
categories:
  - WiFi
  - Protocol
abbrlink: 4100380a
date: 2026-09-18 23:34:08
---

> "用手机蜂窝网时，你从没'选基站、输密码'——走到哪自动连到哪。Passpoint 想让公共 WiFi 也这样。"

---

# 本章导读

上一章的 DPP 解决"**一台设备怎么安全地配进某个网络**"。这一章换个接入难题：**你在机场、酒店、咖啡馆、商场之间走动，怎么让 WiFi 像手机蜂窝网一样——自动认网、自动认证、无缝切换，全程不用每次选 SSID、点"同意条款"、输密码？**

这就是 **Passpoint**（Wi-Fi 联盟的认证品牌，技术规范叫 **Hotspot 2.0，简称 HS2.0**） 要解决的。它建立在 **IEEE 802.11u（Interworking，与外部网络互通）** 之上，让设备在"**关联之前**"就能隔空问清楚：这个 AP 背后是哪家运营商、支持哪些漫游伙伴、我的账号能不能用——能用，就自动连上，体验和蜂窝网漫游一模一样。

<!--more-->

> **本章比喻：手机网络式的自动漫游**
> 想想你的手机 SIM 卡：出国落地，手机自动搜到当地运营商，发现它和你的运营商有**漫游协议**，于是自动接入——你什么都不用做。Passpoint 就是把这套搬到 WiFi 上：你的设备里存着一份"**签约凭证**"（相当于 SIM 卡），走进任何一个 Passpoint 热点，设备先**隔空打听**（ANQP 查询）"你家和我的运营商有合作吗？"，有合作就**自动刷卡进门**（EAP 认证），无需任何手动操作。

**本章你将学到：**

- Passpoint 解决什么：公共 WiFi 的"选网难、认证烦、漫游断"
- STA 关联前怎么认出 Passpoint AP：Beacon/Probe 里的 Interworking 位、Interworking element、HS2.0 Indication
- 底层基石：802.11u 的 GAS/ANQP——关联前的"隔空问询"
- 两个状态：Discovery（发现）→ Secure Access（安全接入，内部再分关联认证 / 接入中 / 已连接三阶段）
- 怎么找到"我能用的网"：NAI Realm、Roaming Consortium
- 凭证从哪来：签约与凭证下发由订阅服务器在规范之外完成（OSU 在线签约已废弃）
- 认证靠什么：基于 EAP 的凭证（类 SIM / 证书 / 用户名密码）
- 抓包实战：各阶段帧的 type/subtype 与 Wireshark 过滤器

> **数据来源**：本章所有技术结论基于 `Passpoint Specification v3.4.pdf`（Wi-Fi Alliance）并标注章节——AP/设备能力见 §2，元素与帧定义（HS2.0 Indication / Roaming Consortium Selection）见 §3，HS2.0 专用 ANQP 元素见 §4，移动设备两状态（Discovery / Secure Access）见 §6；底层 GAS/ANQP、Interworking element、Public Action 帧机制引用 `802.11-2024.pdf`（IEEE 802.11-2024，802.11u）。Wireshark 过滤器字段名以其 802.11 dissector 为准。

---

# 1 公共 WiFi 的老大难 — 为什么连个咖啡馆 WiFi 这么烦

回想在公共场所连 WiFi 的体验：

- 一堆 SSID 不知道选哪个（`CMCC`？`Starbucks`？`Airport-Free`？）
- 连上后还要打开浏览器，点"同意条款"、注册、收验证码（Captive Portal，强制门户）
- 换个航站楼、出了咖啡馆，连接就断，到新地点又得重来一遍
- 安全性差：很多公共 WiFi 不加密，或者那个"门户页"本身就可能是钓鱼

根源在于：**传统 WiFi 的"选网"完全靠 SSID 这个名字**，设备在关联前对这个网络**一无所知**——不知道背后是谁、支持谁、要怎么认证。

Passpoint 的破局点：**让设备在关联前就能查询网络的"身份信息"，并用预存的凭证自动完成企业级认证。** 选网从"猜 SSID"变成"按运营商/漫游关系精确匹配"。

---

# 2 STA 怎么在关联前就认出这是 Passpoint AP

在讲"隔空问询"之前，先回答一个更靠前的问题：**设备扫到一堆 AP，凭什么知道"这一个是 Passpoint、值得去细问"？** 答案是：信息就明明白白写在 **Beacon 和 Probe Response** 里——AP 是主动"招手"的。这靠三层由粗到细的标志（① 属 802.11 主标准，② 属 802.11u，③ 见 HS2.0 §3.1.1）。

| 层                             | 标志（在 Beacon/Probe Response 里）                          | 告诉 STA 什么                                                |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **① Interworking 位**          | **Extended Capabilities element** 里的 Interworking 位 = 1   | "我支持 802.11u 互通，**可以对我发 GAS/ANQP 查询**" —— 最底层的开关 |
| **② Interworking element**     | 含 **Access Network Type**（免费/收费公网…）、**HESSID**、Venue Info | "我是什么类型的网、归属哪张大网" —— HESSID 是同一张 Passpoint 网的统一标识，**漫游不掉线靠它** |
| **③ HS2.0 Indication element** | 一个 **vendor-specific element**（Element ID 221，Wi-Fi 联盟 OUI `50:6F:9A`），带 **Version Number**（4 bit，0/1/2 = 1.x/2.x/3.x）、ANQP Domain ID 等 | "我确实是 **Passpoint**，且是第几版" —— 这才是把"普通 802.11u AP"和"Passpoint AP"真正区分开的标志 |

还有个**可选但常见的第四层**：**Roaming Consortium element** 也能直接进 Beacon/Probe Response，把"我属于哪些漫游联盟（OI）"提前亮出来——STA 甚至不必发 ANQP，光看 Beacon 就能**初筛**"这家大概收不收我的卡"。

所以认网逻辑是一条"**招手 → 细问**"的因果链：

```none
STA 扫到 Beacon / Probe Response
   │
   ├─ Ext Capabilities 的 Interworking 位 = 1 ?      → 支持 802.11u 查询
   ├─ 有 HS2.0 Indication element (vendor 221) ?    → 确认是 Passpoint(+版本)
   ├─ Interworking element 的 HESSID / 网络类型      → 网络归属、类型
   └─（可选）Roaming Consortium 的 OI                → 先粗筛漫游关系
        │  觉得"可能能用"
        ▼
   才发 GAS/ANQP 详细问询（NAI Realm / EAP 方法 / 运营商名…，见 §2.3）
        │
        ▼
   精确匹配凭证 → 自动 EAP 认证 → 关联
```

> **关键分工**：被动监听的 **Beacon/Probe** 负责"亮明身份、招手"（粗筛 + 触发器），主动的 **ANQP** 负责关联前的"详细问答"。前者让 STA 知道"该问谁"，后者才问出"到底能不能用"。

> 你远远看见店门口挂着招牌——先看有没有"可咨询"的灯牌（Interworking 位），再看是不是你认得的连锁品牌（HS2.0 Indication）、门楣上的集团标识（HESSID）、贴的银联/Visa 标（Roaming Consortium OI）。觉得对路了，才走到问询窗口细问（ANQP）。

认出了 Passpoint AP、也初筛过漫游关系，下面正式推开那扇问询窗口——看 GAS/ANQP 怎么隔空问答。

---

# 3 基石：802.11u 的 GAS / ANQP — 关联前的"隔空问询"

上一节 STA 已经从 Beacon 认出"这是个 Passpoint AP"。接下来它要细问，靠的就是 802.11u 提供的核心能力：**在关联（association）之前，STA 就能向 AP 查询网络信息。**

- **GAS（Generic Advertisement Service，通用广告服务）**：一个**传输容器**。它用 Public Action 帧承载查询/响应，让 STA 在关联前就能和 AP 交换信息（§3.2、802.11u）。
- **ANQP（Access Network Query Protocol，接入网络查询协议）**：跑在 GAS 之上的**问答语言**。STA 发 ANQP Query 问"你支持哪些运营商/漫游伙伴/网络类型？"，AP 回 ANQP Response 如实回答。

![GAS/ANQP 关联前隔空问询](assets/%E7%AC%AC-13-%E7%AB%A0%EF%BC%9APasspoint%EF%BC%88Hotspot-2-0%EF%BC%89%E2%80%94-%E6%89%8B%E6%9C%BA%E7%BD%91%E7%BB%9C%E5%BC%8F%E7%9A%84%E8%87%AA%E5%8A%A8%E6%BC%AB%E6%B8%B8/13-passpoint-anqp.svg)

Passpoint 在标准 ANQP 之上又定义了一组 **HS2.0 专用 ANQP-element**（§4）。真正干"匹配"活的其实是 802.11u 自带的那几个元素，HS2.0 元素负责补充运营商标识等信息。下面把两类分开列：

| ANQP 元素                      | 归属       | 回答什么                                                   |
| ------------------------------ | ---------- | ---------------------------------------------------------- |
| **NAI Realm**                  | 802.11u    | 支持哪些**realm**（域），以及各自要用什么 **EAP** 认证方法 |
| **Roaming Consortium**         | 802.11u    | 属于哪些**漫游联盟（OI）**                                 |
| **3GPP Cellular Network**      | 802.11u    | 蜂窝网 PLMN 信息，供 SIM 类凭证匹配                        |
| **Operator Friendly Name**     | HS2.0 §4.3 | 运营商的可读名字（如"中国移动"）                           |
| **Operating Class Indication** | HS2.0 §4.6 | 该 AP 支持的频率/信道类别                                  |
| **NAI Home Realm Query**       | HS2.0 §4.5 | 反向查询"我的 realm 能不能被这个网络识别"                  |

> 注意：旧版的 **WAN Metrics**、**Connection Capability** 已在 v3.4 从 Passpoint 程序中移除（WAN Metrics 定义保留仅作历史参考），**OSU Providers List** 也随 OSU 在线签约一并废弃（见 §13.6）。

关联前的 ANQP 问答发生在密钥建立之前，内容理论上可被中间人篡改。§6.6 因此要求设备支持 **Protected Dual of Public Action**（受保护双公共 Action 帧）：RSNA 建立后，设备用受保护帧重问同一 ANQP 元素，若与关联前应答内容不一致，即视为遭中间人攻击，可解除关联（deauthenticate）。

> 以前你站在一排没标牌的门前，只能挨个推门试（猜 SSID、连上才知道行不行）。GAS/ANQP 相当于每扇门口都装了个**问询窗口**——你进门前先隔着窗口问清楚"这是哪家、收不收我这张卡、网速如何"，问明白了再决定推哪扇门。

---

# 4 两个状态 — 从"发现"到"安全接入"

Passpoint 把一台设备的接入生命周期建模成**两个状态**（§6）。这是本章的主干：

![Passpoint 状态流程](assets/%E7%AC%AC-13-%E7%AB%A0%EF%BC%9APasspoint%EF%BC%88Hotspot-2-0%EF%BC%89%E2%80%94-%E6%89%8B%E6%9C%BA%E7%BD%91%E7%BB%9C%E5%BC%8F%E7%9A%84%E8%87%AA%E5%8A%A8%E6%BC%AB%E6%B8%B8/13-passpoint-states.svg)

| 状态         | 英文              | 设备在干什么                                                 |
| ------------ | ----------------- | ------------------------------------------------------------ |
| **发现**     | **Discovery**     | 扫描 AP，用 **ANQP** 查询各网络的身份/能力，比对预存凭证做网络选择（§6.1） |
| **安全接入** | **Secure Access** | 选好网后关联 + 认证 + 接入，内部再分**关联认证 → 接入中 → 已连接**三阶段（§6.2） |

**Secure Access 内部又分三个阶段**（§6.2.1~§6.2.3）：

- **Association and Authentication（关联与认证）**：关联热点，并用 EAP 方法与 SP 的 AAA 服务器互相认证；
- **Access in Progress（接入中）**：按热点要求交换附加信息，最常见的是**接受服务条款（Terms and Conditions）**，不接受就退出；
- **Connected（已连接）**：拿到完整网络访问权，正常上网。

其中"接受条款"是商用热点常见的一步，规范在 §10 单独展开：AAA 服务器在认证通过后给 AP 下发一个 HTTPS 的条款 URL，设备取回展示，用户接受前网络被限制在条款服务器范围（受控门户），接受后 AP 才放行完整上网流量；基础设施侧会记住"这台设备已接受这版条款"，下次重连不再重弹。

而回到 Discovery 阶段，另有一路信息同样值得留意：**Venue URL**（§6.1.2）——场馆信息的入口，设备据它获取场馆服务、广告或求助内容。规范要求该 URL 必须走 HTTPS，设备不得在关联前擅自打开或提示不安全的 Venue URL，防止被钓鱼页面利用；更进一步，设备须用**系统级 TLS 根 CA** 校验该 URL 指向的 Web 服务器证书（§6.1.2.1），即走完整的证书链验证，确认服务端身份可信后才展示；拉取失败或证书校验不过时，设备便不展示该场馆信息，照常走完 Discovery 选网再进入安全接入。

所以整条生命周期就是：**Discovery 选好网 → Secure Access 自动认证接入**，全程无需手动选网、输密码。若中途认证失败或关联被拒，规范也留了退路——同一凭证在同一 ESS 内 10 分钟内最多连试 10 次（§6.2.4），且单点失败不代表凭证作废，换个热点它可能照样好用（§6.2.5）。凭证的签约与下发不在状态机内——那是订阅服务器在规范之外完成的（见 §13.6）。

> ① 发现 = 站在问询窗口前打听各家、核对"我这卡能不能刷"，挑一家；② 安全接入 = 走到闸机前刷卡 → 闸机找发卡行核验（认证）→ 弹出"使用须知"点个同意 → 门开、畅通无阻。以后换分店重复"打听 → 刷卡"，全程无感，就像手机蜂窝漫游。

# 5 怎么找到"我能用的网" — NAI Realm 与漫游联盟

Discovery 阶段的核心是**匹配**：设备手里的凭证，和哪个 AP 背后的运营商对得上？两条主要线索（§2.3、§4）：

| 线索                                  | 含义                                                         | 类比                                             |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| **NAI Realm**                         | 设备凭证属于某个**realm**（域，形如 `@example.com`）。AP 通过 NAI Realm 元素声明"我支持哪些 realm，各用什么 EAP 方法认证" | 你卡片的"开户行"，和这家店"收哪些行的卡"         |
| **Roaming Consortium（漫游联盟 OI）** | 一组运营商组成漫游联盟，用一个 **OI（Organization Identifier，组织标识）** 标识。AP 声明它属于哪些联盟 | 银联/Visa 这类"卡组织"——只要同属一个联盟就能互刷 |

设备拿 ANQP 查到的 realm/OI 列表，与自己凭证比对：**对得上 → 这网我能用 → 自动用对应的 EAP 方法认证。** 而 OI 匹配也非"中一条即过"：订阅里 `HomeOIList` 每条 HomeOI 带 `HomeOIRequired` 布尔——false 的按"或"、true 的按"且"，一旦有 true 就忽略所有 false；`RoamingConsortiumOI` 再按订阅服务器排好的偏好序取最靠前命中者（§9.1.2）。

> **注意**：有些 SP 允许用户用自己的用户名+域（比如社交账号的邮箱地址）当凭证，导致 AP 无法穷举配置所有 realm（§2.3）——所以匹配机制要兼顾这种灵活情况。

对上了开户行/卡组织，这张"卡"能刷了；可这卡当初是怎么办下来的？

---

# 6 凭证从哪来 — 签约与下发在状态机之外

那"卡"（凭证）一开始是怎么到手机里的？答案是：**签约与凭证下发不在 Passpoint 的两状态状态机之内**，而是由订阅服务器（subscription server）在规范之外完成（§8.1）。

- 设备出厂后，凭证（SIM / 证书 / 用户名密码）由**服务提供商或 AAA 提供商**通过带外方式灌进去——Passpoint 规范只规定"存进 `PerProviderSubscription` MO（§9）"，怎么灌不在其范围内。这棵 MO 是按订阅分组的管理对象树，各子树各司其职：`HomeSP` 定运营商身份（FriendlyName/FQDN）、`Policy` 定选网策略、`SubscriptionParameters` 定寿命参数、`Credential` 存凭证、`AAAServerTrustRoot` 存 AAA 证书信任根、`CredentialPriority` 标凭证优先级（值越小越优先）。其中 `Credential` 下 `UsernamePassword`/`DigitalCertificate`/`SIM` 三者精确三选一（§9.1），EAP 方法也钉在叶子上——用户名密码的 `EAPMethod` 带外层 EAPType 与内层 InnerMethod（PAP/CHAP/MS-CHAP/MS-CHAP-V2），SIM 的 `EAPType` 仅限 EAP-SIM/AKA/AKA'——这棵树才是"选网 + 选认证方法"的底层数据源。
- 订阅还带寿命：`SubscriptionParameters` 的 `UsageLimits` 挂 `DataLimit`（MB）与 `TimeLimit`（分钟），用量触顶或 `ExpirationDate`/`Credential/ExpirationDate` 到期即视为订阅失效；但设备此时不立即断连，而是等网络侧先动作、再另选网络（§6.3）。其余叶节点还有 `CreationDate`（签约灌入时刻）、`TypeOfSubscription`（订阅等级，home SP 自定，如 Gold/Silver/Bronze）、`UsageLimits/StartDate`（用量统计起点）与 `UsageLimits/UsageTimePeriod`（用量重置周期：1–31 表示每月该日归零，0 表示一次性 PAYG）。
- 早期版本（Release 2）定义过一套 **OSU（Online Sign-Up，在线签约）** 流程，让设备"现场办卡"；**这一流程在 Passpoint Specification v3.4 已废弃**（§7.1 明确标注 "The Online Sign Up (OSU) process is deprecated"），在线开户改由服务商自己的渠道完成。
- 凭证支持三类：SIM/USIM（EAP-SIM/AKA/AKA'）、用户名密码（EAP-TTLS）、证书（EAP-TLS），详见 §13.7。

> 办卡这件事本身（去营业厅开户）不在"进店刷卡"这套流程里——你只要手里已经有卡，走进任何一家分店都是"打听 → 刷卡"两步。至于卡怎么办来的，是营业厅（订阅服务器）的事，跟你在门口刷不刷得进去无关。

# 7 认证靠什么 — 基于 EAP 的企业级凭证

Passpoint 的认证**不是**传统的"输个 WiFi 密码（PSK）"，而是走 **802.1X / EAP** 的企业级认证。凭证可以是几类：

| 凭证类型          | 对应 EAP 方法            | 场景                                        |
| ----------------- | ------------------------ | ------------------------------------------- |
| **SIM / USIM**    | EAP-SIM / EAP-AKA / AKA' | 运营商用手机 SIM 卡直接认证（最像蜂窝漫游） |
| **用户名 + 密码** | EAP-TTLS 等              | 普通账号签约                                |
| **证书**          | EAP-TLS                  | 高安全场景，设备装客户端证书                |

AP 在 **NAI Realm 元素**里就声明了每个 realm 该用哪种 EAP 方法，设备据此选择对应凭证认证。认证通过即进入 **Secure Access** 状态的 Connected 阶段，正常上网。

而这套 EAP 认证跑在 **WPA3-Enterprise** 之上，不是开放的 802.11 空口——§5.7 要求 AP 使能 PMF（管理帧保护）：**MFPC=1**，**MFPR** 按模式取 0 或 1。管理帧是空口上"控制闸机开关"的指令（关联、解除关联、切换都靠它），这些指令若可被伪造，攻击者就能用一条"解除关联"把已经进门的客人强行赶出去；PMF 就是给这些指令盖上**防伪章**。正因如此，若宣称支持 Passpoint Release 2+ 的 STA 关联时没请求 PMF，AP 用状态码 31（Robust management frame policy violation）拒绝——选 31 而不是笼统的"拒绝"（状态码 1 未指明原因、12 其他原因），正因为 31 精确对应"管理帧保护策略被违反"这一条，让 STA 一眼看出该补的是 PMF，从根上堵住降级攻击。

realm 的职责不止"匹配"，还负责 **AAA 路由**（§6.2.1），同一份 realm 在两个阶段各司其职：**关联前**，NAI Realm 元素里的 realm 是"选网匹配"——STA 拿凭证 realm 去对 AP 广播的 realm 列表，判断"这网收不收我这张卡"（§13.5）；**关联后**，EAP identity 应答里的 realm 才是"路由线索"——设备带上 realm（EAP-TTLS 用 `anonymous@realm` 或裸 `@realm`、EAP-TLS 用 `Credential/Realm`、SIM 卡自动拼成 `wlan.mnc<mnc>.mcc<mcc>.3gppnetwork.org`），接入网的 AAA 服务器靠它把认证请求路由到对应的服务商——同一张"卡"能漫游到不同热点，靠的就是后一条路由线索。而凡走证书类 EAP 方法（EAP-TLS / EAP-TTLS），设备收到 AAA 服务器证书后还须按 RFC 5280 校验其有效性，并把证书里 DNSName 类型的 SubjectAltName 与订阅信息 HomeSP/FQDN 做后缀匹配（无 DNSName 则退而匹配 CommonName），链中还须含 SP 的 AAA trust root（§6.7.2）。

> 刷卡进门时，闸机认的不是"一个全店通用的口令"，而是**你这张卡本身的有效性**（向发卡行核验）。卡可以是 SIM（运营商卡）、会员卡（用户名密码）、或带芯片的高端卡（证书）——闸机按卡的类型选对应的核验方式。

---

# 8 完整流程串讲

把全章串起来，手机走进一个机场 Passpoint 热点的完整过程：

```none
0. 前提     手机里已存某运营商的 Passpoint 凭证(SIM/证书/账号，见 §13.6)
                  |
1. Discovery  手机扫到 AP，用 GAS/ANQP 隔空查询：
            "你支持哪些 realm / 漫游联盟？用什么 EAP？"
            -> 发现该热点与我的运营商有漫游关系
                  |
2. Secure Access  手机用预存凭证、按 AP 指定的 EAP 方法自动认证
            802.1X/EAP 通过 -> 关联成功 ->（接受条款）-> 正常上网
                  |
3. 漫游切换   走到另一航站楼/另一个 Passpoint 热点
            重复 Discovery + Secure Access，全程无感，体验如蜂窝漫游
```

> 整段旅程从上帝视角看，就是「打听 → 刷卡 → 进门」三幕循环，接下来把监控录像逐帧调出来看。

---

# 9 抓包实战 — 帧 type/subtype 与 Wireshark 过滤

如果说前面讲的是"该怎么做"，抓包就是调出闸机的监控录像——把问询、刷卡、进门的每个动作逐帧回放。把上面这条流程落到**真实空口帧**，方便你用 Wireshark 抓包对照。Passpoint 全程用到的帧分四段：

![Passpoint 完整帧交互时序](assets/%E7%AC%AC-13-%E7%AB%A0%EF%BC%9APasspoint%EF%BC%88Hotspot-2-0%EF%BC%89%E2%80%94-%E6%89%8B%E6%9C%BA%E7%BD%91%E7%BB%9C%E5%BC%8F%E7%9A%84%E8%87%AA%E5%8A%A8%E6%BC%AB%E6%B8%B8/13-passpoint-frames.svg)

## 9.1 第一段：Beacon / Probe Response 里的认网标志

这两个都是 **802.11 管理帧（type 0，Management）**：Beacon 是 **subtype 8**、Probe Response 是 **subtype 5**。认网标志就藏在它们携带的 element 里。下表左列是想找的标志、右列是对应的过滤器，抓包时逐行对号入座：

| 想找什么                                 | Wireshark 过滤器                                             |
| ---------------------------------------- | ------------------------------------------------------------ |
| 所有 Beacon                              | `wlan.fc.type_subtype == 0x08`                               |
| 所有 Probe Response                      | `wlan.fc.type_subtype == 0x05`                               |
| 支持 Interworking 的 AP（§13.2 ①层）     | `wlan.interworking.internet == 1` 或看 `wlan.ext_tag` / Extended Capabilities 里的 Interworking 位 |
| 带 **Interworking element**（含 HESSID） | `wlan.tag.number == 107`（Interworking，含 Access Network Type/HESSID） |
| 带 **Roaming Consortium element**        | `wlan.tag.number == 111`                                     |
| **HS2.0 Indication**（确认是 Passpoint） | `wlan.tag.number == 221 && wlan.tag.oui == 0x506f9a`（vendor-specific，Wi-Fi 联盟 OUI；Wireshark 也常解析为 `wlan.hs20.indication.*`） |

认网标志就这三样，抓包时按上表逐一对号入座。

> 实操技巧：先按 `wlan.tag.number == 221 && wlan.tag.oui == 0x506f9a` 过滤出 HS2.0 Indication，就能在一堆 AP 里**一眼挑出所有 Passpoint 热点**，再展开看 Version Number 判断是 1.x/2.x/3.x。

## 9.2 第二段：GAS / ANQP 隔空问询

GAS 用的是 **Public Action 帧**（管理帧家族里的 Action，**Category = 4 Public**），关联前就能收发：

| 帧                        | Action 字段值 | 作用                                |
| ------------------------- | ------------- | ----------------------------------- |
| **GAS Initial Request**   | 10（0x0A）    | STA 发起 ANQP 查询                  |
| **GAS Initial Response**  | 11（0x0B）    | AP 回 ANQP 应答（不分片时一次回完） |
| **GAS Comeback Request**  | 12（0x0C）    | 应答较大需分片时，STA 来取下一片    |
| **GAS Comeback Response** | 13（0x0D）    | AP 回分片数据                       |

四种 Action 值就是 GAS 帧的骨架，一眼分清发起、应答与续传。

> **ANQP 到底发几轮？通常就一轮。** 别被"要问 realm、漫游联盟、运营商名、3GPP 网络…好几样"误导成"问几样就发几轮"。ANQP 有个 **Query List（查询列表）**机制：STA 在**一个** GAS Initial Request 里，用 Query List **一次性列出想问的所有 ANQP 元素**，AP 在**一个** GAS Initial Response 里**一并答完**（HS2.0 §4.1，Annex B 官方示例就是"单个请求里同时问 3GPP Cellular Network + Operator Friendly Name"）。
>
> 唯一会出现"多帧"的情况是**分片**：应答太大（realm 列表很长等）一帧装不下时，才用 **Comeback Request/Response（0x0C/0x0D）**来回续传后续分片——但这是**同一轮应答的分片续传，不是新一轮问询**。所以：**问几样东西 ≠ 几轮；逻辑上 ANQP 就是"一问一答"。**

| 想找什么             | Wireshark 过滤器                                             |
| -------------------- | ------------------------------------------------------------ |
| 所有 GAS 帧          | `wlan.fixed.category_code == 4 && wlan.fixed.publicact >= 10 && wlan.fixed.publicact <= 13` |
| 直接按 ANQP 协议看   | `wlan.anqp`（Wireshark 内置 ANQP 解析器）                    |
| HS2.0 专用 ANQP 元素 | `wlan.hs20.anqp`                                             |
| 只看 NAI Realm 应答  | `wlan.anqp.info_id == 263`（NAI Realm 的 ANQP Info ID）      |

隔空问询告一段落，接下来就轮到真正刷卡进门的关联与 EAP 认证。

## 9.3 第三段：关联与 EAP 认证

匹配上凭证后，STA 关联 + 跑 802.1X/EAP（这部分是标准 802.11/802.1X，不是 HS2.0 私有）：

| 帧                       | type/subtype 或过滤器          | 说明                                                         |
| ------------------------ | ------------------------------ | ------------------------------------------------------------ |
| **Association Request**  | `wlan.fc.type_subtype == 0x00` | STA 关联（其 HS2.0 Indication element 表明自己也支持 Passpoint） |
| **Association Response** | `wlan.fc.type_subtype == 0x01` | AP 回应                                                      |
| **EAP 认证报文**         | `eap`                          | EAP-SIM/AKA/TLS/TTLS 的来回（见 §13.7）                      |
| **EAPOL / 四次握手**     | `eapol`                        | EAP 成功后协商 PTK，和普通 WPA3-Enterprise 一样              |

三段帧各有各的过滤器，散着抓容易漏——下面把它们并成一条一网打尽。

## 9.4 一条龙过滤器

抓一次完整的 Passpoint 接入，想一眼看全所有相关帧——把问询、刷卡、进门的几盘监控录像并成一条——可以用：

```none
wlan.tag.number == 221 || wlan.anqp || wlan.hs20.anqp || eap || eapol
```

> **注意**：GAS/ANQP 是**关联前**的帧，普通网卡在"已连接某 AP"的监听模式下未必抓得到——要抓全，需用**监听模式（monitor mode）** 并锁定目标 AP 的信道。

---

# 10 本章总结

| 机制                                 | 作用                           | 漫游比喻                           |
| ------------------------------------ | ------------------------------ | ---------------------------------- |
| **GAS / ANQP**                       | 关联前隔空查询网络身份与能力   | 进门前的问询窗口                   |
| **两状态 Discovery / Secure Access** | 接入生命周期                   | 打听 → 刷卡进门（核验 + 同意条款） |
| **NAI Realm**                        | 凭证的"开户域"，决定用哪种 EAP | 卡的开户行                         |
| **Roaming Consortium（OI）**         | 漫游联盟标识，同盟即可互通     | 银联/Visa 卡组织                   |
| **签约与凭证下发**                   | 订阅服务器带外完成，OSU 已废弃 | 营业厅办卡（不在进店流程里）       |
| **EAP 凭证（SIM/证书/账号）**        | 企业级认证，非共享密码         | 刷卡核验，按卡型选核验方式         |

Passpoint 的精髓是：**借助 802.11u 的 GAS/ANQP，让设备在关联前就看清网络的"身份证"，再用预存的企业级凭证（最像手机 SIM 卡）自动完成认证与漫游——把公共 WiFi 的体验，做成蜂窝网那样"走到哪连到哪、全程无感"。** 它和上一章的 DPP 同属"接入"——DPP 管"设备怎么安全配进来"，Passpoint 管"用户怎么跨网络无缝漫游"。接入问题讲清楚了，下一章起我们转向"另一面"的第二大主题：**设备之间不靠中心 AP 的直接连接**，从 Wi-Fi Direct 开始。

---

> 下一章将讲述：前两章设备都还在"连 AP"，从这章起彻底抛开 AP——两台设备没有路由器怎么直接组网？谁来临时扮演 AP（GO）？两台素不相识的设备在茫茫信道里怎么"对上眼"？
