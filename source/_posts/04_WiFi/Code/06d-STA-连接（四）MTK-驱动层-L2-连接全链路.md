---
title: STA 连接（四）MTK 驱动层 L2 连接全链路
top: 1
related_posts: true
abbrlink: eb727377
date: 2026-09-19 20:44:35
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> QCOM 驱动层连接执行中，我们拆解了 QCOM 平台的驱动层连接——Host 做监工，固件全权代理 Auth/Assoc 帧交换。本篇聚焦 **MTK 平台**：驱动亲自下场，两层状态机控场，每一步 Auth/Assoc 帧交换都在 Host 侧可见。与 QCOM 的"外包安保"不同，MTK 选择的是"自营安保"——驱动自己构建 802.11 帧、自己解析回复、自己管理状态转移。本篇将完整拆解 AIS FSM（17 状态）和 SAA FSM（8 状态）两层状态机如何协作完成 L2 连接。

> 在 QCOM 驱动层连接执行中，我们追踪了 QCOM 的 CM 状态机如何通过序列化模块排队→事件投递→`cm_connect_active()` 激活连接→固件全权代理 Auth/Assoc 帧交换。QCOM 的 Host 侧全程不碰 802.11 帧——它的角色是"监工"，不是"执行者"。但 MTK 走了完全不同的路。

# 本章导读

如果说 QCOM 是把安保全部外包给专业公司的酒店，那 MTK 就是自己员工亲自办理每一道手续的精品酒店。大堂经理（AIS FSM）统筹全局——从搜索目标、扫描、申请频道到最终入住，全程 17 个状态不遗漏。安保执行员（SAA FSM）接到指令后一步一个脚印：先验证身份证（Auth Request → 等 Response），验证通过后再分配房间（Assoc Request → 等 Response），每一步都有记录、每一步都可追溯。这种"亲力亲为"的模式虽然代码量更大，但出了问题你能在 dmesg 里直接看到是哪一步卡住了——不需要任何固件日志工具。

<!--more-->

本文先拆 MTK 的两层状态机架构——AIS FSM（17 状态，管理连接生命周期）与 SAA FSM（STA 侧 8 状态，执行 Auth/Assoc 帧交换）；再追踪 Auth/Assoc 帧从填充 MAC Header 到 `nicTxEnqueueMsdu()` 发送的构建过程，以及重试、超时、失败恢复流程；接着讲连接前的单播 Probe Request 探路（AIS FSM 显式控制、Host-Firmware 分离模式）；后半部分覆盖 EAPOL 四次握手的驱动透传（mac80211 标准 Control Port）、Auth/Assoc 日志（dmesg 与固件侧各有什么），最后做 QCOM vs MTK 双平台设计哲学对比。

想先看架构拆解，直接跳到 [§1 MTK 架构](#1-MTK：驱动亲自下场，两层状态机控场)；想看双平台对比，跳到 [§2 QCOM vs MTK](#2-QCOM-vs-MTK：两个世界的-L2-连接)。

本文所有代码块来自 MTK 真实驱动源码，有精简（去掉 log 语句、license 头和部分条件编译分支），关键路径保留完整。精简处标注 `// ...省略...`，文件路径标注在代码块首行。

本篇是连接系列第四篇，聚焦 **MTK 平台**的驱动层 L2 连接执行（probe→auth→assoc→EAPOL）；前一篇聚焦 QCOM 平台，后一篇聚焦安全协议分支（open/OWE/SAE/EAP/MLO）。

---

# 1 MTK：驱动亲自下场，两层状态机控场

MTK 驱动在驱动层亲自处理 802.11 Auth/Assoc 帧的构建和收发，使用两层状态机——AIS FSM（17 状态）管理连接的生命周期，SAA FSM 执行 Auth/Assoc 帧交换的每一步。与 QCOM 的"固件黑盒"不同，MTK 的状态转移日志（需开启 DBGLOG）在 dmesg 中可见。

## 1.1 MTK 架构有什么特点？驱动亲自下场的两层状态机

回到酒店比喻——MTK 的驱动就是酒店自己的安保团队，不像 QCOM 那样外包给安保公司：

- **AIS FSM（大堂经理）**：负责连接的整体流程——从搜索目标酒店、扫描、申请频道、到最终入住（NORMAL_TR），全程 17 个状态
- **SAA FSM（安保执行员）**：在大堂经理说"开始办理入住"之后，安保执行员一步一个脚印地完成 Auth 验证和 Assoc 房间分配——发请求、等回复、检查结果、下一步

这种设计的好处是 Auth/Assoc 全过程对 host 侧透明——发送和接收状态可在 dmesg 中查看（前提是开启了对应模块的 `DBGLOG` 级别）。代价是驱动代码量更大，SAA FSM 的 STA 侧 8 个状态需要精确处理每种可能的帧交换序列。

> **关于固件的角色（MTK 侧）**：与 QCOM 相同，所有 802.11 帧都必须经过固件——固件是空口和 Host 驱动之间的必经网关。但与 QCOM 固件"自处理"Auth/Assoc 协议逻辑不同，MTK 固件在此场景下只做**透传**——将管理帧原样上报给 Host 驱动，由 Host 驱动的 SAA FSM 处理帧内容。帧去重、ACK 回复、BA 重排序等底层操作仍由固件完成，但 Auth/Assoc 的状态机逻辑完全在 Host 侧。不存在"绕过固件"的路径——区别只在于固件是"自处理"（QCOM）还是"透传"（MTK）。

## 1.2 MTK 有哪两种连接模式？Driver-managed vs SME-managed

在进入状态机细节之前，先理解 MTK 的两种连接模式：

| 模式               | 命令                                      | 谁控制 Auth 帧？                   | 适用场景                           |
| ------------------ | ----------------------------------------- | ---------------------------------- | ---------------------------------- |
| **Driver-managed** | `CMD_CONNECT` 一条命令                    | 驱动自己构建和发送 Auth/Assoc 帧   | WPA2-PSK（Open Auth + 标准 Assoc） |
| **SME-managed**    | `CMD_AUTHENTICATE` + `CMD_ASSOCIATE` 分步 | Supplicant 控制 Auth，驱动只管收发 | SAE/WPA3、FT、FILS                 |

> **本文以 Driver-managed 模式（WPA2-PSK）为重点。** SME-managed 模式中，当认证方式为 SAE 时，SAA FSM 会进入 `SAA_STATE_EXTERNAL_AUTH` 状态，将 Auth 帧交给 Supplicant 处理——这是安全协议分支与 MLO 的内容，本篇不展开。

## 1.3 AIS FSM 的 17 个状态如何管理连接生命周期？

AIS（AI Station）FSM 是 MTK 驱动层连接的"总指挥"，所有 17 个状态定义在 `ais_fsm.h`：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/include/mgmt/ais_fsm.h
enum ENUM_AIS_STATE {
    AIS_STATE_IDLE = 0,              // 初始/空闲状态
    AIS_STATE_SEARCH,                // 搜索目标 BSS
    AIS_STATE_SCAN,                  // 正在扫描
    AIS_STATE_ONLINE_SCAN,           // 在线扫描（已连接时的扫描）
    AIS_STATE_LOOKING_FOR,           // 寻找目标 AP
    AIS_STATE_WAIT_FOR_NEXT_SCAN,    // 等待下一次扫描
    AIS_STATE_REQ_CHANNEL_JOIN,      // 请求频道用于 JOIN
    AIS_STATE_JOIN,                  // 正在 JOIN（Auth+Assoc 帧交换）
    AIS_STATE_JOIN_FAILURE,          // JOIN 失败处理
    AIS_STATE_IBSS_ALONE,            // IBSS 模式独自运行
    AIS_STATE_IBSS_MERGE,            // IBSS 模式合并
    AIS_STATE_NORMAL_TR,             // 正常传输状态（已连接）
    AIS_STATE_DISCONNECTING,         // 断开中
    AIS_STATE_REQ_REMAIN_ON_CHANNEL, // 请求保持频道
    AIS_STATE_REMAIN_ON_CHANNEL,     // 保持频道中
    AIS_STATE_OFF_CHNL_TX,           // 离频发送（Public Action Frame）
    AIS_STATE_ROAMING,               // 漫游中
    AIS_STATE_NUM                    // 状态总数
};
```

主要功能：

- 17 个状态覆盖了 WiFi STA 的所有可能场景——不仅是连接，还有扫描、漫游、断开、IBSS（Ad-Hoc）、离频操作
- 状态总数通过 `AIS_STATE_NUM` 标记，方便遍历和校验
- 注意：没有独立的 `AIS_STATE_AUTHENTICATION` 和 `AIS_STATE_ASSOCIATION` 状态——这两步在 `AIS_STATE_JOIN` 内部由 SAA FSM 完成

**典型连接路径**（WPA2-PSK）：

```
IDLE → SEARCH → SCAN → LOOKING_FOR → REQ_CHANNEL_JOIN → JOIN → NORMAL_TR（已连接）
```

![MTK AIS FSM — 连接相关状态流转](assets/06d-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E5%9B%9B%EF%BC%89MTK-%E9%A9%B1%E5%8A%A8%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06d-mtk-ais-state.svg)

MTK 的连接成功状态叫 `AIS_STATE_NORMAL_TR`（正常传输），不叫 `CONNECTED`。这意味着 Auth/Assoc 完成后，AIS 进入的是"可以正常收发数据"的状态，而不仅仅是"关联完成"——语义上更接近网络层的"已连接"而非链路层的"已关联"。

## 1.4 NL80211_CMD_CONNECT 到达 MTK 驱动后发生了什么？

整个连接流程的起点是 wpa_supplicant 通过 nl80211 下发 `NL80211_CMD_CONNECT`。内核 nl80211 层在 `nl80211_connect()`（`net/wireless/nl80211.c`）中接收该 netlink 命令，将 netlink 属性解析为 `cfg80211_connect_params` 结构体，然后通过 `rdev_connect()` 分发到驱动注册的 `.connect` 回调——MTK 驱动侧即为 `mtk_cfg80211_connect()`（定义在 `gl_cfg80211.c:1488`）。`nl80211_connect()` 和 `rdev_connect()` 是 cfg80211 框架的标准入口，与平台无关；真正开始平台差异化处理的，是下面这个 MTK 回调函数——它涵盖参数校验、安全配置、连接下发三个阶段。这里有一个值得追问的设计问题：`cfg80211_connect_params` 已经是 nl80211 层解析好的通用结构体，为什么 MTK 驱动还要把它二次解析成自己的内部表示（`IW_AUTH_*`、`AUTH_MODE_*`、`PARAM_CONNECT`）？答案在于两层 ABI 的寿命不对等——cfg80211 的参数枚举（`NL80211_WPA_VERSION_1`、`NL80211_AUTHTYPE_OPEN_SYSTEM` 等）是内核向上对用户态承诺的稳定接口，而 MTK 驱动的内部枚举是它向下对固件承诺的私有协议。固件只认识 `wlanoidSet*` 这族 ioctl 命令里约定好的数值，不认识 nl80211 的枚举字面量；驱动夹在中间，必须做一次"内核通用语言 → 厂商私有语言"的翻译。这也解释了为什么第二阶段会出现 `wlanParseAkmSuites()` 的二次修正——不是 MTK 设计冗余，而是两个 ABI 各自演进、驱动负责兜底对齐。

### 1.4.1 阶段一：参数校验与 WPA 信息重置

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/os/linux/gl_cfg80211.c:1488

int mtk_cfg80211_connect(struct wiphy *wiphy, struct net_device *ndev,
                         struct cfg80211_connect_params *sme)
{
    struct GLUE_INFO *prGlueInfo = NULL;
    struct PARAM_CONNECT rNewSsid;
    struct CONNECTION_SETTINGS *prConnSettings = NULL;
    uint8_t ucBssIndex = 0;

    WIPHY_PRIV(wiphy, prGlueInfo);
    ucBssIndex = wlanGetBssIdx(ndev);
    // 校验设备模式：必须是 AIS（Station）模式
    if (!IS_BSS_INDEX_AIS(prGlueInfo->prAdapter, ucBssIndex))
        return -EINVAL;

    // 获取连接设置结构体并初始化
    prConnSettings = aisGetConnSettings(prGlueInfo->prAdapter, ucBssIndex);
    prConnSettings->u2JoinStatus = WLAN_STATUS_AUTH_TIMEOUT;
    prConnSettings->u4ConnFlags = sme->flags;

    // 设置 OP 模式（Infrastructure）
    rOpMode.eOpMode = prConnSettings->eOPMode > NET_TYPE_AUTO_SWITCH ?
                      NET_TYPE_AUTO_SWITCH : prConnSettings->eOPMode;
    kalIoctl(prGlueInfo, wlanoidSetInfrastructureMode, ...);

    // <1> 重置 WPA 信息
    prWpaInfo = aisGetWpaInfo(prGlueInfo->prAdapter, ucBssIndex);
    prWpaInfo->u4WpaVersion = IW_AUTH_WPA_VERSION_DISABLED;
    prWpaInfo->u4KeyMgmt = 0;
    prWpaInfo->u4CipherGroup = IW_AUTH_CIPHER_NONE;
    prWpaInfo->u4CipherPairwise = IW_AUTH_CIPHER_NONE;
    prWpaInfo->u4AuthAlg = IW_AUTH_ALG_OPEN_SYSTEM;
    prWpaInfo->fgPrivacyInvoke = FALSE;
    // ...省略...
```

入口处做了两层校验：（1）BSS index 必须是 AIS（Station）模式，拒绝 AP/P2P 等其他模式；（2）设置 Infrastructure 模式（`wlanoidSetInfrastructureMode`），如果失败直接返回 `-EFAULT`。随后清空 WPA 信息结构体——这是每次连接前的标准操作，防止前一次连接的残留参数污染本次连接。

### 1.4.2 阶段二：安全参数配置

第二阶段是函数的主体，将 nl80211 传来的 `cfg80211_connect_params` 中的安全参数（WPA 版本、认证类型、密码套件、MFP 配置）逐个映射为 MTK 内部表示：

```c
    // WPA 版本映射
    if (sme->crypto.wpa_versions & NL80211_WPA_VERSION_1)
        prWpaInfo->u4WpaVersion = IW_AUTH_WPA_VERSION_WPA;
    else if (sme->crypto.wpa_versions & NL80211_WPA_VERSION_2)
        prWpaInfo->u4WpaVersion = IW_AUTH_WPA_VERSION_WPA2;

    // 认证类型映射
    switch (sme->auth_type) {
    case NL80211_AUTHTYPE_OPEN_SYSTEM:
        eAuthMode = AUTH_MODE_OPEN;
        break;
    case NL80211_AUTHTYPE_SAE:
        eAuthMode = AUTH_MODE_WPA3_SAE;
        u4AkmSuite = RSN_AKM_SUITE_SAE;
        break;
    case NL80211_AUTHTYPE_FT:
        eAuthMode = AUTH_MODE_OPEN;
        break;
    // ... 其他认证类型 ...
    }

    // AKM suite 解析（可能覆盖上面 auth_type 的默认映射）
    if (sme->crypto.n_akm_suites)
        wlanParseAkmSuites(sme->crypto.akm_suites, sme->crypto.n_akm_suites,
                          prWpaInfo->u4WpaVersion, &eAuthMode, &u4AkmSuite, prMib);

    // 密码套件映射：CCMP/TKIP/GCMP/GCMP-256 → IW_AUTH_CIPHER_*
    // ...省略（约 80 行 switch-case）...

    // RSN IE 解析：提取 RSN Capability（MFP 配置）和 RSNX（SAE-H2E）
    if (sme->ie && sme->ie_len > 0)
        wextSrchDesiredWPAIE(..., ELEM_ID_RSN, ...) → rsnParseRsnIE()
        wextSrchDesiredWPAIE(..., ELEM_ID_RSNX, ...) → rsnParseRsnxIE()

    // MFP 配置
    switch (sme->mfp) {
    case NL80211_MFP_NO:    prWpaInfo->u4Mfp = RSN_AUTH_MFP_DISABLED; break;
    case NL80211_MFP_REQUIRED: prWpaInfo->u4Mfp = RSN_AUTH_MFP_REQUIRED; break;
    }

    // 将认证模式和加密状态写入硬件
    kalIoctlByBssIdx(prGlueInfo, wlanoidSetAuthMode, &eAuthMode, ...);
    kalIoctlByBssIdx(prGlueInfo, wlanoidSetEncryptionStatus, &eEncStatus, ...);
```

这个阶段的本质是将 cfg80211 的通用安全参数"翻译"成 MTK 驱动的内部表示。注意认证类型的最终确定需要两步：先用 `auth_type` 做初步映射，再用 `wlanParseAkmSuites()` 按 AKM suite 做二次修正——因为同一个 `auth_type` 可能对应多种 AKM suite（如 WPA3-SAE Transition Mode 的 `NL80211_AUTHTYPE_SAE` 实际上同时支持 SAE 和 PSK）。

### 1.4.3 阶段三：连接参数打包——从 cfg80211 到 AIS FSM

安全参数配置完成后，连接目标参数（SSID、BSSID、信道频率、IE blob）被打包成 `PARAM_CONNECT` 结构体，通过 `kalIoctl(wlanoidSetConnect)` 下发：

```c
    // gl_cfg80211.c:1954-1978
    kalMemZero(&rNewSsid, sizeof(rNewSsid));
    rNewSsid.u4CenterFreq = sme->channel->center_freq;    // 信道频率
    rNewSsid.pucBssid = (uint8_t *)sme->bssid;            // 目标 BSSID
    rNewSsid.pucBssidHint = (uint8_t *)sme->bssid_hint;   // BSSID 提示（漫游用）
    rNewSsid.pucSsid = (uint8_t *)sme->ssid;              // SSID
    rNewSsid.u4SsidLen = sme->ssid_len;                   // SSID 长度
    rNewSsid.pucIEs = (uint8_t *)sme->ie;                 // IE blob（RSN IE 等）
    rNewSsid.u4IesLen = sme->ie_len;
    rNewSsid.ucBssIdx = ucBssIndex;

    rStatus = kalIoctl(prGlueInfo, wlanoidSetConnect,
                       (void *)&rNewSsid, sizeof(struct PARAM_CONNECT), &u4BufLen);
```

`kalIoctl(wlanoidSetConnect)` 调用到 `wlanoidSetConnect()`（定义在 `common/wlan_oid.c:1074`），这个函数是连接参数的"二次处理站"——它接收 `PARAM_CONNECT`，将 SSID/BSSID/信道频率写入 `CONNECTION_SETTINGS` 结构体，同时也做了关键校验：

```c
// MTK common/wlan_oid.c:1074
uint32_t wlanoidSetConnect(struct ADAPTER *prAdapter,
                           void *pvSetBuffer, uint32_t u4SetBufferLen, ...)
{
    // 参数校验：SSID 长度不能超过 32
    if (pParamConn->u4SsidLen > 32) {
        DBGLOG(OID, WARN, "SsidLen [%d] is invalid!\n", pParamConn->u4SsidLen);
        return WLAN_STATUS_INVALID_LENGTH;
    }
    // BSSID 和 SSID 至少提供一个
    if (!pParamConn->pucBssid && !pParamConn->pucSsid)
        return WLAN_STATUS_INVALID_LENGTH;

    // 填充 CONNECTION_SETTINGS
    prConnSettings = aisGetConnSettings(prAdapter, ucBssIndex);
    COPY_SSID(prConnSettings->aucSSID, prConnSettings->ucSSIDLen,
              pParamConn->pucSsid, pParamConn->u4SsidLen);
    COPY_MAC_ADDR(prConnSettings->aucBSSID, pParamConn->pucBssid);
    prConnSettings->u4FreqInMHz = pParamConn->u4CenterFreq;
    // 确定连接策略：CONNECT_BY_BSSID / CONNECT_BY_SSID_BEST_RSSI / CONNECT_BY_SSID_ANY

    // 同步 IE blob 到 pucAssocIEs（后面 Assoc 帧构造时使用）
    wlanoidUpdateConnect(prAdapter, ...);

    // 🔴 触发 AIS FSM：通过消息系统发送 MID_OID_AIS_FSM_JOIN_REQ
    prAisAbortMsg->rMsgHdr.eMsgId = MID_OID_AIS_FSM_JOIN_REQ;
    mboxSendMsg(prAdapter, MBOX_ID_0,
                (struct MSG_HDR *)prAisAbortMsg, MSG_SEND_METHOD_BUF);
    // ...省略...
}
```

这段代码的最后三行是整个连接流程的"点火开关"——它不再直接操作 802.11 帧，而是通过消息系统把控制权交给 AIS FSM。

`mboxSendMsg(MID_OID_AIS_FSM_JOIN_REQ)` 将消息投递到 MBOX_ID_0 消息队列，AIS FSM 的消息处理线程从队列中取出消息后，调用 `aisFsmRunEventAbort()` ——这是一个"断开-重连"模式的入口：先中止当前 AIS 活动（如果有的话），然后 `aisFsmInsertRequestToHead(AIS_REQUEST_RECONNECT)` 将重连请求插入到请求队列头部，最后调用 `aisFsmSteps(prAdapter, AIS_STATE_IDLE, ...)` 从 IDLE 状态开始执行状态机。

AIS FSM 发出通知后，wpa_supplicant 才会收到 `NL80211_CMD_CONNECT` 的 `WLAN_STATUS_SUCCESS` 返回（或失败时的 `-EINVAL`）——这也意味着从 netlink 命令落地到用户态拿到返回，中间隔着一次完整的消息投递与状态机启动。

### 1.4.4 连接参数传递链路总览

```
wpa_supplicant
  → NL80211_CMD_CONNECT (netlink)
    → cfg80211: nl80211_connect()
      → rdev_connect()
        → mtk_cfg80211_connect()         [gl_cfg80211.c:1488]
          │
          ├── 阶段1: 校验设备模式 + 重置 WPA 信息
          │   ├── IS_BSS_INDEX_AIS()         — 只允许 STA 模式
          │   └── wlanoidSetInfrastructureMode() — 设置为 Infrastructure
          │
          ├── 阶段2: 安全参数映射
          │   ├── sme→auth_type     → eAuthMode (AUTH_MODE_OPEN/WPA3_SAE/...)
          │   ├── sme→crypto.*      → WPA info (版本/密码套件/AKM)
          │   ├── sme→ie (RSN IE)   → rsnParseRsnIE() (MFP 能力)
          │   ├── kalIoctl(wlanoidSetAuthMode)        — 写入硬件
          │   └── kalIoctl(wlanoidSetEncryptionStatus) — 设置加密状态
          │
          └── 阶段3: 连接参数下发
              ├── 打包 PARAM_CONNECT {SSID, BSSID, freq, IEs, BssIdx}
              └── kalIoctl(wlanoidSetConnect)          — 进入 wlan_oid.c
                    │
                    └── wlanoidSetConnect()             [wlan_oid.c:1074]
                          ├── 校验: SSID≤32, BSSID|SSID 非空
                          ├── 写入 CONNECTION_SETTINGS (SSID/BSSID/freq/policy)
                          ├── wlanoidUpdateConnect()    — 同步 IE → pucAssocIEs
                          └── mboxSendMsg(MID_OID_AIS_FSM_JOIN_REQ)
                                → aisFsmRunEventAbort()
                                  → aisFsmSteps(AIS_STATE_IDLE)
                                    → AIS FSM: IDLE → SEARCH → SCAN → ...
```

AIS FSM 从 `IDLE` 开始，依次经过 `SEARCH`（搜索目标 BSS）→ `SCAN`（扫描）→ `LOOKING_FOR`（寻找匹配 AP）→ `REQ_CHANNEL_JOIN`（请求信道）→ `JOIN`（Auth/Assoc 帧交换）。

下面是 MTK 连接全流程的函数调用时序图，覆盖从 NL80211_CMD_CONNECT 下发到 EAPOL 四次握手完成、密钥安装的 33 个关键步骤——后续各小节将逐一拆解图中的每个阶段：

![MTK 连接全流程函数调用时序图](assets/06d-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E5%9B%9B%EF%BC%89MTK-%E9%A9%B1%E5%8A%A8%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06d-mtk-call-flow.svg)

本节接下来展开扫描阶段的关键操作——**单播 Probe Request 探路**（发生在 SEARCH→SCAN 阶段），后续章节再进入 JOIN 状态的 Auth/Assoc 执行。

## 1.5 单播 Probe Request——MTK 的"探路"方式

在 MTK 的连接流程中，Probe Request 发生在 AIS FSM 的 SEARCH→SCAN 阶段，早于 JOIN 状态的 Auth/Assoc 帧交换。先理解 Probe 探路机制，再进入 JOIN 的 Auth/Assoc 执行，符合实际的时间顺序。

与 QCOM 固件自动发送不同，MTK 的单播 Probe Request 由驱动侧显式控制。但与 QCOM LIM 直接构建原始管理帧不同，MTK 采用的是 **Host-Firmware 分离模式**：Host 侧不构建 802.11 帧体，而是将扫描参数（BSSID、SSID、信道、IE）打包为 `CMD_SCAN_REQ_V2` 命令，发送给固件；固件负责构建实际的 802.11 Probe Request 帧并发送到空口。

MTK 的"单播"关键就在于 **BSSID 字段**——当 `aucBSSID` 为具体的 AP MAC 地址时，固件发送的是单播 Probe Request；当为全零 `00:00:00:00:00:00` 时，固件不携带 BSSID 字段，发送广播 Probe Request。

下面是 `scnSendScanReqV2()` 中 BSSID 设置的核心逻辑（`scan_fsm.c:276`）：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/scan_fsm.c
/* send command packet for scan */
kalMemZero(prCmdScanReq, sizeof(struct CMD_SCAN_REQ_V2));

if (prScanParam->ucScnFuncMask & ENUM_SCN_USE_PADDING_AS_BSSID ||
    prScanParam->u4ScnFuncMaskExtend & ENUM_SCN_ML_PROBE) {
    // ML probe: 使用扩展 BSSID 数组（支持多 BSSID 场景）
    kalMemCopy(prCmdScanReq->aucExtBSSID,
        prScanParam->aucBSSID,
        CFG_SCAN_OOB_MAX_NUM * MAC_ADDR_LEN);
} else {
    COPY_MAC_ADDR(prCmdScanReq->aucBSSID,
    &prScanParam->aucBSSID[0][0]);
}
// 非零 BSSID = 单播 Probe Request
if (!EQUAL_MAC_ADDR(prCmdScanReq->aucBSSID, "\x00\x00\x00\x00\x00\x00"))
    DBGLOG(SCN, INFO, "Include BSSID "MACSTR" in probe request\n",
        MAC2STR(prCmdScanReq->aucBSSID));
```

最终通过 `wlanSendSetQueryCmd()` 将命令发给固件（`scan_fsm.c:476`）：

```c
wlanSendSetQueryCmd(prAdapter,
    CMD_ID_SCAN_REQ_V2,
    TRUE,
    FALSE,
    FALSE,
    NULL,
    NULL,
    sizeof(struct CMD_SCAN_REQ_V2),
    (uint8_t *)prCmdScanReq, NULL, 0);
```

> **Tips**：以下 MLO（Multi-Link Operation，WiFi 7 多链路）单播 Probe 是高级特性。如果你只关心标准 WPA2-PSK 连接流程，可以跳过本段，直接读 [§1.6 AIS FSM JOIN 初始化](#16-ais-fsm-进入-join-状态后-authassoc-如何启动)。

MTK 中有一个特殊的 MLO（Multi-Link Operation，WiFi 7 引入的多链路聚合技术，一个 MLD——Multi-Link Device——可同时在多个频段提供链路；后续安全协议与 MLO 章节将详细展开）单播 Probe 路径：当目标 AP 是 MLD（Multi-Link Device）但初始扫描只发现了单链路信息时，`aisSearchHandleBssDesc()` 会检测并触发 `aisScanGenMlScanReq()`（`ais_fsm.c:10056`），构建一个**单信道、单 BSSID** 的定向扫描请求：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/ais_fsm.c:10056
static uint32_t aisScanGenMlScanReq(struct ADAPTER *prAdapter,
    uint8_t ucBssIndex, struct MSG_SCN_SCAN_REQ_V2 *prScanReqMsg)
{
    struct AIS_FSM_INFO *prAisFsmInfo;
    struct BSS_DESC *prBssDesc;
    uint8_t aucIe[MAX_BAND_IE_LENGTH];
    uint32_t u4ScanIELen = 0;

    prAisFsmInfo = aisGetAisFsmInfo(prAdapter, ucBssIndex);
    prBssDesc = prAisFsmInfo->prMlProbeBssDesc;

    if (!prBssDesc) {
        DBGLOG(AIS, INFO, "no ml probe target\n");
        return WLAN_STATUS_INVALID_DATA;
    }

    // 生成 ML probe request IE
    u4ScanIELen = mldFillScanIE(prAdapter, prBssDesc,
        aucIe, sizeof(aucIe), FALSE, prBssDesc->rMlInfo.ucMldId);
    // ...省略: eScanType/ucSSIDType/fgOobRnrParseEn 赋值 ...

    // 指定单信道 + 单 BSSID
    prScanReqMsg->eScanChannel = SCAN_CHANNEL_SPECIFIED;
    prScanReqMsg->ucChannelListNum = 1;
    prScanReqMsg->arChnlInfoList[0].eBand = prBssDesc->eBand;
    prScanReqMsg->arChnlInfoList[0].ucChannelNum = prBssDesc->ucChannelNum;
    prScanReqMsg->ucBssidMatchCh[0] = prBssDesc->ucChannelNum;
    COPY_MAC_ADDR(prScanReqMsg->aucExtBssid[0], prBssDesc->aucBSSID);

    // 设置 ML Probe 标志以使用扩展 BSSID 路径
    prScanReqMsg->ucScnFuncMask |= ENUM_SCN_USE_PADDING_AS_BSSID;
    prScanReqMsg->u4ScnFuncMaskExtend |= ENUM_SCN_ML_PROBE;

    // 复制 ML probe IE 到扫描请求
    if (u4ScanIELen > 0) {
        kalMemCopy(prScanReqMsg->aucIEMl, aucIe, u4ScanIELen);
        prScanReqMsg->u2IELenMl = (uint16_t)u4ScanIELen;
    }

    return WLAN_STATUS_SUCCESS;
}
```

- `SCAN_CHANNEL_SPECIFIED` + `ucChannelListNum=1` 锁定单一信道——ML Probe 不扫全频段，只针对已知 BSS 的信道做定向探测
- `aucExtBssid[0]` 直接填入 MLD 的 MAC 地址——与普通扫描共用 BSSID 字段，但通过 `ENUM_SCN_ML_PROBE` 标志告知 scan_fsm 走扩展 BSSID 路径
- `mldFillScanIE()` 生成的 ML probe IE 存入 `aucIEMl`——让固件在 Probe Request 中附上 ML 信息元素，告知 AP 本 STA 支持 MLO

这个 ML Probe 扫描完成后，AIS FSM 从 `LOOKING_FOR` 回到 `SEARCH`，此时扫描结果中有了完整的 ML 链路信息，`aisSearchHandleBssDesc()` 直接进入 `REQ_CHANNEL_JOIN`。

MTK 的安保执行员（SAA FSM）不像 QCOM 的外包公司那样有自己的后台工具——在执行 Auth 之前，大堂经理（AIS FSM）必须亲自确认目标酒店确实在营业（SEARCH → SCAN → LOOKING_FOR），用对讲机喊一声（Probe Req），确认有回应了（Probe Resp），然后再把任务交给安保执行员（JOIN → SAA FSM）。不过与 QCOM 不同，MTK 大堂经理不是自己喊话——他把要喊的内容写在一张命令条上（`CMD_SCAN_REQ_V2`），通过内部传讯系统（`wlanSendSetQueryCmd`）交给喊话员（固件），喊话员照着条子上的 BSSID 喊出定向对讲（单播 Probe Request）。

当固件扫描完成后，通过 `EVENT_SCAN_DONE` 事件将结果回传给 Host 驱动，`scnEventScanDone()` 负责处理：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/scan_fsm.c:1125
void scnEventScanDone(struct ADAPTER *prAdapter,
    struct EVENT_SCAN_DONE *prScanDone, u_int8_t fgIsNewVersion)
{
    struct SCAN_INFO *prScanInfo = &(prAdapter->rWifiVar.rScanInfo);
    struct SCAN_PARAM *prScanParam = &prScanInfo->rScanParam;

    // 固件返回的扫描完成事件——检查是正常完成还是超时
    if (fgIsNewVersion) {
        if (prScanDone->ucCurrentState != FW_SCAN_STATE_SCAN_DONE) {
            log_dbg(SCN, INFO, "FW Scan timeout! generate ScanDone"
                " at State%d complete chan count%d\n",
                prScanDone->ucCurrentState,
                prScanDone->ucCompleteChanCount);
        }
    }

    // 只在 scan_fsm 处于 SCANNING 状态时处理（防止重复/过期事件）
    if (prScanInfo->eCurrentState == SCAN_STATE_SCANNING
        && prScanDone->ucSeqNum == prScanParam->ucSeqNum) {

        // 清理过期 BSS 描述符，只保留最新的扫描结果
        scanRemoveBssDescsByPolicy(prAdapter,
            SCN_RM_POLICY_EXCLUDE_CONNECTED | SCN_RM_POLICY_TIMEOUT);

        // 生成 scan-done 消息，通知 AIS FSM：扫描完成，可以进入 LOOKING_FOR
        scnFsmGenerateScanDoneMsg(prAdapter,
            prScanParam->eMsgId, prScanParam->ucSeqNum, ...);
    }
}
```

- 固件扫描可能超时而不自知——`ucCurrentState != FW_SCAN_STATE_SCAN_DONE` 时 driver 侧也生成 ScanDone 事件，防止 scan_fsm 永远卡在 SCANNING 状态
- `ucSeqNum` 校验确保只处理当前这次扫描的完成事件——防止前次扫描的迟到事件干扰当前流程
- `scanRemoveBssDescsByPolicy()` 按策略清理过期的 BSS 描述符：排除已连接的 AP（`EXCLUDE_CONNECTED`）和超时未更新的 AP（`TIMEOUT`），确保 `LOOKING_FOR` 阶段看到的扫描结果是最新的
- `scnFsmGenerateScanDoneMsg()` 将完成消息发回当初发起扫描的调用者（AIS FSM），AIS FSM 收到后从 SCAN 转移到 LOOKING_FOR——这就是 Probe 探路与 Auth/Assoc 之间的衔接点

扫描完成后 AIS FSM 进入 `REQ_CHANNEL_JOIN` → `AIS_STATE_JOIN`，此时 `aisFsmStateInit_JOIN()` 接管，开始 Auth/Assoc 的准备和执行（下一节）。

## 1.6 AIS FSM 进入 JOIN 状态后 Auth/Assoc 如何启动？

当 AIS FSM 进入 `AIS_STATE_JOIN` 状态时，初始化函数 `aisFsmStateInit_JOIN()` 负责做好 Auth/Assoc 之前的所有准备：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/ais_fsm.c
void aisFsmStateInit_JOIN(struct ADAPTER *prAdapter,
    struct AIS_FSM_INFO *prAisFsmInfo,
    struct STA_RECORD **prMainStaRec,
    uint8_t ucLinkIndex)
{
    struct BSS_INFO *prBssInfo;
    struct CONNECTION_SETTINGS *prConnSettings;
    struct STA_RECORD *prStaRec;
    struct MSG_SAA_FSM_START *prJoinReqMsg;

    // ... 变量声明省略 ...

    // 1. 标记 BSS 正在连接
    prBssDesc->fgIsConnecting |= BIT(ucBssIndex);

    // 2. 创建 STA_RECORD
    prStaRec = bssCreateStaRecFromBssDesc(prAdapter,
                          STA_TYPE_LEGACY_AP, ucBssIndex, prBssDesc);
    if (!prStaRec) {
        aisFsmStateAbort_JOIN(prAdapter, ucBssIndex);
        aisFsmSteps(prAdapter, AIS_STATE_JOIN_FAILURE, ucBssIndex);
        return;
    }

    // 3. 设置 STA 状态为 Class 1
    if (prStaRec->ucStaState == STA_STATE_1)
        cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_1);
    prStaRec->u2StatusCode = STATUS_CODE_AUTH_TIMEOUT;

    // 4. 根据认证模式选择 Auth Algorithm Number
    switch (prConnSettings->eAuthMode) {
    case AUTH_MODE_OPEN:
    case AUTH_MODE_WPA2_PSK:
        // ... 省略其他 case ...
        prAisFsmInfo->ucAvailableAuthTypes =
            (uint8_t) AUTH_TYPE_OPEN_SYSTEM;
        break;
    case AUTH_MODE_SHARED:
        prAisFsmInfo->ucAvailableAuthTypes =
            (uint8_t) AUTH_TYPE_SHARED_KEY;
        break;
    case AUTH_MODE_WPA3_SAE:
        // ... SAE 认证类型选择省略 ...
        break;
    // ... FILS, FT 等省略 ...
    }

    // 5. 选择具体认证算法（优先级: SHARED_KEY > FILS_SK > FT > OPEN > SAE）
    if (prAisFsmInfo->ucAvailableAuthTypes & (uint8_t) AUTH_TYPE_SHARED_KEY) {
        prStaRec->ucAuthAlgNum = (uint8_t) AUTH_ALGORITHM_NUM_SHARED_KEY;
    } else if (prAisFsmInfo->ucAvailableAuthTypes & (uint8_t) AUTH_TYPE_OPEN_SYSTEM) {
        prStaRec->ucAuthAlgNum = (uint8_t) AUTH_ALGORITHM_NUM_OPEN_SYSTEM;
    } else if (prAisFsmInfo->ucAvailableAuthTypes & (uint8_t) AUTH_TYPE_SAE) {
        prStaRec->ucAuthAlgNum = (uint8_t) AUTH_ALGORITHM_NUM_SAE;
    }
    // ... FT, FILS 省略 ...

    // 6. 发送消息给 SAA FSM：开始 JOIN
    prJoinReqMsg = (struct MSG_SAA_FSM_START *)cnmMemAlloc(prAdapter, RAM_TYPE_MSG,
                                sizeof(struct MSG_SAA_FSM_START));
    prJoinReqMsg->rMsgHdr.eMsgId = MID_AIS_SAA_FSM_START;
    prJoinReqMsg->ucSeqNum = ++prAisFsmInfo->ucSeqNumOfReqMsg;
    prJoinReqMsg->prStaRec = prStaRec;

    mboxSendMsg(prAdapter, MBOX_ID_0, (struct MSG_HDR *)prJoinReqMsg,
            MSG_SEND_METHOD_BUF);
}
```

主要功能：

- 从 BSS 描述符创建 `STA_RECORD` 对象——这是 SAA FSM 执行 Auth/Assoc 的核心数据结构，记录了 STA 状态、认证算法、状态码等
- 根据 `eAuthMode`（如 `AUTH_MODE_WPA2_PSK`）选择认证类型——对于 WPA2-PSK，选择 `AUTH_TYPE_OPEN_SYSTEM`（即 Open Authentication，认证算法号 0）
- 设置重试次数限制和初始状态码（`STATUS_CODE_AUTH_TIMEOUT` 作为默认值）
- 通过内部消息系统 `mboxSendMsg` 向 SAA FSM 发送 `MID_AIS_SAA_FSM_START` 消息，触发 Auth/Assoc 帧交换

`aisFsmStateInit_JOIN()` 就像大堂经理把客人的入住登记表（STA_RECORD）填好，写上客人姓名（MAC 地址）、房型要求（认证类型=OPEN_SYSTEM）、备注（超时状态码），然后按下对讲机："安保执行员，可以开始给这位客人办入住了"。

## 1.7 SAA FSM 的 8 个状态如何执行 Auth/Assoc 帧交换？

SAA（Station Authentication/Association）FSM 是 AIS FSM 的"下属"——当 AIS 进入 JOIN 状态后，SAA FSM 负责 Auth/Assoc 帧交换的每一步。状态定义在 `aa_fsm.h`：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/include/mgmt/aa_fsm.h
enum ENUM_AA_STATE {
    AA_STATE_IDLE = 0,           // 空闲
    SAA_STATE_SEND_AUTH1,        // STA 发送 AUTH Request (Transaction Seq 1)
    SAA_STATE_WAIT_AUTH2,        // STA 等待 AUTH Response (Transaction Seq 2)
    SAA_STATE_SEND_AUTH3,        // STA 发送 AUTH Request (Transaction Seq 3, Shared Key)
    SAA_STATE_WAIT_AUTH4,        // STA 等待 AUTH Response (Transaction Seq 4, Shared Key)
    SAA_STATE_EXTERNAL_AUTH,     // 外部认证（SAE，委托 Supplicant 控制）
    SAA_STATE_SEND_ASSOC1,       // STA 发送 Association Request
    SAA_STATE_WAIT_ASSOC2,       // STA 等待 Association Response
    AAA_STATE_SEND_AUTH2,        // AP 侧：发送 AUTH Response (Transaction Seq 2)
    AAA_STATE_SEND_AUTH4,        // AP 侧：发送 AUTH Response (Transaction Seq 4, Shared Key)
    AAA_STATE_SEND_ASSOC2,       // AP 侧：发送 Association Response
    AA_STATE_RESOURCE,           // 资源不足调试状态
    AA_STATE_NUM                 // 状态总数
};
```

对 WPA2-PSK 的 Open Authentication（2 帧），SAA FSM 的路径是：

```
AA_STATE_IDLE → SAA_STATE_SEND_AUTH1 → SAA_STATE_WAIT_AUTH2
  → SAA_STATE_SEND_ASSOC1 → SAA_STATE_WAIT_ASSOC2 → AA_STATE_IDLE（完成）
```

注意 AAA 前缀的状态（`AAA_STATE_SEND_AUTH2` 等）是 AP 模式使用的，SAA 前缀（`SAA_STATE_SEND_AUTH1` 等）是 STA 模式使用的。在 STA 连接场景中，这 8 个 AA 状态实际上只用到了序号 0-7 的 8 个，其中 3（`SAA_STATE_SEND_AUTH3`）和 4（`SAA_STATE_WAIT_AUTH4`）在 Open Auth 场景下不会经过——它们仅在 Shared Key Auth（4 帧握手）场景下使用，Open Auth 只需 2 帧 Auth 交换即进入 Assoc。

> **超时处理说明**：`saaFsmRunEventRxRespTimeOut()` 为 `SAA_STATE_WAIT_AUTH2` 和 `SAA_STATE_WAIT_AUTH4` 提供了独立的 timeout case——超时后分别回退到 `SEND_AUTH1` 和 `SEND_AUTH3` 进行重试。`SAA_STATE_EXTERNAL_AUTH` 无独立的驱动层超时处理（SAE 认证的超时由 Supplicant 侧控制），`SAA_STATE_SEND_AUTH3` 作为发送状态，帧入队后立即转移到 `WAIT_AUTH4`，不在 `SEND` 状态等待响应——因此不存在 `SEND_AUTH3` 独立的 timeout 路径。

Shared Key Auth 的 4 帧时序是：`SEND_AUTH1`（STA 发 AUTH Request，Transaction Seq 1）→ `WAIT_AUTH2`（等 AP 回 AUTH Response，Seq 2，内含 challenge text）→ `SEND_AUTH3`（STA 用 WEP 密钥加密 challenge 后回发 AUTH Request，Seq 3）→ `WAIT_AUTH4`（等 AP 确认 AUTH Response，Seq 4），四步全过才进入 `SEND_ASSOC1`。`saaFsmRunEventRxRespTimeOut()` 在这条路径上有两个独立超时点——`WAIT_AUTH2` 超时回退到 `SEND_AUTH1` 重发 Seq 1，`WAIT_AUTH4` 超时回退到 `SEND_AUTH3` 重发 Seq 3。

![MTK SAA FSM — STA侧 Auth/Assoc 状态机](assets/06d-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E5%9B%9B%EF%BC%89MTK-%E9%A9%B1%E5%8A%A8%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06d-saa-fsm.svg)

## 1.8 SAA FSM 的 5 个核心函数如何驱动 Auth/Assoc 帧交换？

### 1.8.1 `saaFsmRunEventStart()` —— SAA FSM 启动入口

当 AIS FSM 通过消息系统发送 `MID_AIS_SAA_FSM_START` 后，SAA FSM 的入口函数被调用：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/saa_fsm.c
void saaFsmRunEventStart(struct ADAPTER *prAdapter, struct MSG_HDR *prMsgHdr)
{
    struct MSG_SAA_FSM_START *prSaaFsmStartMsg;
    struct STA_RECORD *prStaRec;

    prSaaFsmStartMsg = (struct MSG_SAA_FSM_START *) prMsgHdr;
    prStaRec = prSaaFsmStartMsg->prStaRec;

    if ((!prStaRec) || (prStaRec->fgIsInUse == FALSE)) {
        cnmMemFree(prAdapter, prMsgHdr);
        return;
    }

    // 验证 STA 类型
    if (!IS_AP_STA(prStaRec)) {
        saaFsmSendEventJoinComplete(prAdapter, WLAN_STATUS_FAILURE,
                        prStaRec, NULL);
        return;
    }

    // 重置状态和计时
    prStaRec->eAuthAssocState = AA_STATE_IDLE;
    prStaRec->u2StatusCode = STATUS_CODE_UNSPECIFIED_FAILURE;
    GET_CURRENT_SYSTIME(&prStaRec->rLastJoinTime);
    prStaRec->ucTxAuthAssocRetryCount = 0;

    // 根据认证算法转移到相应的 SAA 状态
    if (prStaRec->ucStaState == STA_STATE_1) {
        if (prStaRec->ucAuthAlgNum == AUTH_ALGORITHM_NUM_SAE)
            saaFsmSteps(prAdapter, prStaRec,
                    SAA_STATE_EXTERNAL_AUTH, NULL);
        else if (prStaRec->ucAuthAlgNum == AUTH_ALGORITHM_NUM_FT &&
             prStaRec->ucAuthTranNum == AUTH_TRANSACTION_SEQ_2)
            saaFsmSteps(prAdapter, prStaRec,
                    AA_STATE_IDLE, NULL);
        else
            // WPA2-PSK: Open Authentication → 发送 AUTH1
            saaFsmSteps(prAdapter, prStaRec,
                    SAA_STATE_SEND_AUTH1, NULL);
    }
}
```

主要功能：

- 校验 `STA_RECORD` 的有效性和 STA 类型（必须是 AP-STA 类型，即连接 AP 的 STA 角色）
- 重置 `eAuthAssocState` 到 `AA_STATE_IDLE`、清空状态码、记录 JOIN 开始时间、清零重试计数
- 根据 `ucAuthAlgNum` 决定下一步：Open Authentication（WPA2-PSK 默认）→ `SAA_STATE_SEND_AUTH1`；SAE → `SAA_STATE_EXTERNAL_AUTH`（转交 Supplicant）；FT 且已有 Auth2 → `AA_STATE_IDLE`
- 这是 Auth/Assoc 帧交换的真正起点——从这个函数开始，802.11 帧将逐一发出

### 1.8.2 `authSendAuthFrame()` —— 构建并发送 AUTH Request

当 SAA FSM 进入 `SAA_STATE_SEND_AUTH1` 时，`authSendAuthFrame()` 构建并发送 Authentication 帧：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/auth.c
uint32_t authSendAuthFrame(struct ADAPTER *prAdapter,
              struct STA_RECORD *prStaRec,
              uint8_t ucBssIndex,
              struct SW_RFB *prFalseAuthSwRfb,
              uint16_t u2TransactionSeqNum, uint16_t u2StatusCode)
{
    struct WLAN_AUTH_FRAME *prAuthFrame;
    struct MSDU_INFO *prMsduInfo;

    // 构建 AUTH 帧（MAC Header + Frame Body）
    prMsduInfo = authComposeAuthFrame(prAdapter, prStaRec, ucBssIndex,
        prFalseAuthSwRfb,
        u2TransactionSeqNum, u2StatusCode);
    if (!prMsduInfo)
        return WLAN_STATUS_RESOURCES;

    prAuthFrame = (struct WLAN_AUTH_FRAME *)
        ((uintptr_t)(prMsduInfo->prPacket) + MAC_TX_RESERVED_FIELD);

    // 发送到 TX 模块
    nicTxEnqueueMsdu(prAdapter, prMsduInfo);

    return WLAN_STATUS_SUCCESS;
}
```

主要功能：

- `authComposeAuthFrame()` 由驱动自己构建帧体——因为 MTK 不依赖固件模板，需要 Host 侧填充完整的 MAC Header（Frame Control type=00 subtype=1011）和 Frame Body（Auth Algorithm Number、Transaction Sequence Number、Status Code）
- 将构建好的帧排队到 TX 模块（`nicTxEnqueueMsdu`）——从这里开始，帧进入网卡的硬件发送队列
- 对于 WPA2-PSK 的 Open Authentication，`u2TransactionSeqNum=1`，`u2StatusCode=0`

> ⚠️ 以下调用链基于 MTK 驱动公开头文件（`nic_tx.h`）和标准 WiFi 网卡 DMA 架构推断，`nicTxEnqueueMsdu()` 的实现在预编译的 NIC 层库中，非开源。
>
> **`nicTxEnqueueMsdu()` 的调用链——帧如何到达固件**：`nicTxEnqueueMsdu()`（声明在 `nic_tx.h:1930`）将 MSDU 放入 NIC 层的 TX 队列后，触发 DMA 传输——帧数据通过 PCIe 总线从 Host 内存传输到网卡。网卡固件收到发送指令后，将帧从队列中取出并通过空口发送。这是一个**异步操作**：`nicTxEnqueueMsdu()` 返回成功只表示帧已入队和 DMA 传输已启动，不代表帧已发送到空口。真正的发送完成确认来自后续的 TX done 回调（固件在帧发送完成后产生 TX 完成中断，Host 侧在中断处理中更新发送统计）。同一个 `nicTxEnqueueMsdu()` 调用链也用于 Assoc 帧发送（见 §1.8.4 `assocSendReAssocReqFrame()`），此处是 Auth 帧的首次详细追踪。
>
> 由于 MTK 的 `nicTxEnqueueMsdu()` 实现在预编译的 NIC 层库中（非开源），上述调用链基于 MTK 驱动的公开头文件（`nic_tx.h`）和标准的 WiFi 网卡 DMA 架构推断——核心路径推断为：**Host 构建帧 → nicTxEnqueueMsdu 入队 → DMA 传输 → 固件接收 → 空口发送**。

### 1.8.3 `saaFsmRunEventRxAuth()` —— 处理 AUTH Response

**RX 路径全景**：当网卡收到 802.11 帧时，帧数据经过以下路径到达 SAA FSM：

```
空口 → 网卡硬件 → 固件（去重、ACK 回复、解密检查）
  → PCIe 总线 → Host DMA 缓冲区
  → NAPI poll（`nicRxProcessRFBs()`）→ 帧分类 `nicRxProcessPacketType()`
  > 注：`nicRxProcessRFBs` 和 `nicRxProcessPacketType` 实现在预编译 NIC 层库中，非开源。上述 RX 路径基于 `nic_rx.h` 公开头文件推断。
  → 管理帧（type=00）→ `authProcessRxAuthFrame()` 解析 subtype
  → `authCheckRxAuthFrameTransSeq()` 验证 Transaction Sequence
  → `saaFsmRunEventRxAuth()` → SAA FSM 状态机处理
```

固件在 MTK 平台上只做透传——管理帧原样上报给 Host 驱动，帧内容的解析和状态机逻辑完全由 Host 侧 SAA FSM 执行。这与 QCOM 固件自处理 Auth/Assoc 完全不同：在 QCOM 平台上，固件内部完成 Auth/Assoc 的状态机逻辑，只将最终结果通过 `WMI_CONNECT_EVENTID` 上报；Host 侧根本看不到 Auth/Assoc 帧本身。

当网卡收到 AUTH Response 帧（Transaction Seq = 2）时，如上所述，RX 路径将帧分发到 SAA FSM 的 `saaFsmRunEventRxAuth()`：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/saa_fsm.c
void saaFsmRunEventRxAuth(struct ADAPTER *prAdapter, struct SW_RFB *prSwRfb)
{
    struct STA_RECORD *prStaRec;
    uint16_t u2StatusCode;
    enum ENUM_AA_STATE eNextState;

    // ... 查找 STA_RECORD 省略 ...

    switch (prStaRec->eAuthAssocState) {
    case SAA_STATE_SEND_AUTH1:
    case SAA_STATE_WAIT_AUTH2:
        // 验证收到的帧是否是我们要等的 AUTH Response (seq=2)
        if (authCheckRxAuthFrameStatus(prAdapter, prSwRfb,
                           AUTH_TRANSACTION_SEQ_2,
                           &u2StatusCode) == WLAN_STATUS_SUCCESS) {

            cnmTimerStopTimer(prAdapter, &prStaRec->rTxReqDoneOrRxRespTimer);
            prStaRec->u2StatusCode = u2StatusCode;

            if (u2StatusCode == STATUS_CODE_SUCCESSFUL &&
                authProcessRxAuth2_Auth4Frame(prAdapter, prSwRfb) ==
                    WLAN_STATUS_SUCCESS) {

                prStaRec->ucAuthTranNum = AUTH_TRANSACTION_SEQ_2;

                if (prStaRec->ucAuthAlgNum == AUTH_ALGORITHM_NUM_SHARED_KEY) {
                    eNextState = SAA_STATE_SEND_AUTH3;
                } else {
                    // Open Auth 成功 → 升级到 Class 2，进入 Assoc
                    cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_2);
                    eNextState = SAA_STATE_SEND_ASSOC1;
                }
            } else {
                // AUTH 被拒绝
                DBGLOG(SAA, INFO,
                       "Auth Req was %s by [" MACSTR "], Status Code = %d\n",
                       u2StatusCode != STATUS_CODE_SUCCESSFUL ?
                       "rejected" : "invalid",
                       MAC2STR(prStaRec->aucMacAddr), u2StatusCode);
                eNextState = AA_STATE_IDLE;
            }

            prStaRec->ucTxAuthAssocRetryCount = 0;
            saaFsmSteps(prAdapter, prStaRec, eNextState, NULL);
        }
        break;

    // ... 其他 case 省略 ...
    }
}
```

主要功能：

- 通过 `authCheckRxAuthFrameStatus()` 验证收到的帧是否是期望的 AUTH Response（Transaction Seq = 2）
- 停止 Auth 响应超时定时器（收到帧了，不需要再等）
- **成功路径**：`u2StatusCode == 0` → STA 状态从 Class 1 升级到 Class 2（`STA_STATE_2`），然后转移到 `SAA_STATE_SEND_ASSOC1` 准备发 Assoc
- **拒绝路径**：DBGLOG 输出 `"Auth Req was rejected by [BSSID], Status Code = X"`（需要开启 SAA 模块的 DBGLOG 级别），然后返回 `AA_STATE_IDLE`
- 重置重试计数——无论是成功还是失败，只要收到了回复，重试计数就归零

安保执行员递上身份证（Auth Req），前台看了一眼——如果是本人（Status=0），说"身份验证通过，现在给你分配房间（进入 Assoc 阶段）"；如果不对（Status != 0），说"抱歉，身份证有问题（Auth Req was rejected），请回"。安保执行员把结果填在签到表上，通过内部电话通知大堂经理状态更新。

### 1.8.4 `assocSendReAssocReqFrame()` —— 构建并发送 Association Request

Auth 通过后，SAA FSM 进入 `SAA_STATE_SEND_ASSOC1`，调用 `assocSendReAssocReqFrame()` 构建 Association Request 帧（注意：函数名包含了 ReAssoc——同一个函数同时处理初次关联和重关联，通过 `prStaRec->fgIsReAssoc` 标志区分）。

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/assoc.c:733
uint32_t assocSendReAssocReqFrame(struct ADAPTER *prAdapter,
                                  struct STA_RECORD *prStaRec)
{
    struct WLAN_ASSOC_REQ_FRAME *prAssocFrame;
    struct MSDU_INFO *prMsduInfo;

    // 1. 构建完整的 (Re)Association Request 帧体
    prMsduInfo = assocComposeReAssocReqFrame(prAdapter, prStaRec);
    if (!prMsduInfo)
        return WLAN_STATUS_RESOURCES;

    // 2. MLO 场景（802.11be）：附加 Multi-Link IE
    mldGenerateAssocIE(prAdapter, prStaRec, prMsduInfo,
                       assocComposeReAssocReqFrame);

    // 3. 获取 802.11 帧头（跳过硬件 TX 描述符区域 MAC_TX_RESERVED_FIELD）
    prAssocFrame = (struct WLAN_ASSOC_REQ_FRAME *)
        ((uintptr_t)(prMsduInfo->prPacket) + MAC_TX_RESERVED_FIELD);

    // 4. 通知内核 glue 层关联参数（CapInfo、RSN IE、SSID 等）
    if (IS_STA_IN_AIS(prStaRec)) {
        kalUpdateReAssocReqInfo(prAdapter->prGlueInfo,
            (uint8_t *) &prAssocFrame->u2CapInfo,
            prMsduInfo->u2FrameLength -
                offsetof(struct WLAN_ASSOC_REQ_FRAME, u2CapInfo),
            prStaRec->fgIsReAssoc, prStaRec->ucBssIndex);
    }

    // 5. 提交到硬件 TX 队列——帧从此进入网卡发送管线
    nicTxEnqueueMsdu(prAdapter, prMsduInfo);

    return WLAN_STATUS_SUCCESS;
}
```

主要功能：

- `assocComposeReAssocReqFrame()` 构建完整帧体——因为 Assoc 帧的 IE 负载远重于 Auth 帧（RSN IE、HT/VHT/HE Capabilities、Supported Rates 等），调用独立的 compose 函数避免 auth.c 和 assoc.c 的逻辑交叉污染
- 802.11 帧头位于 `prPacket + MAC_TX_RESERVED_FIELD`——保留区域留给硬件 TX 描述符，驱动只填充 802.11 帧内容，硬件负责添加 PHY 层的 TX 描述符
- `kalUpdateReAssocReqInfo()` 将 Assoc 参数同步给内核 glue 层，供 Supplicant 侧查询
- MLO/FILS 等可选扩展通过条件编译注入，核心路径不受影响
- 最终由 `nicTxEnqueueMsdu()` 提交到硬件 TX 队列，发送是异步的

Association Request 帧包含以下信息元素（IEEE 802.11-2024 规范 §9.3.3.6）：

- **Capability Information**：ESS、Privacy、Short Preamble 等能力位
- **Listen Interval**：STA 的监听间隔（单位 Beacon Interval）
- **SSID IE**：目标网络的 SSID
- **Supported Rates IE**：STA 支持的速率集
- **RSN IE**（WPA2）：认证和加密套件、PMKID 等信息
- **HT Capabilities IE**：802.11n 能力
- **VHT Capabilities IE**：802.11ac 能力
- **HE Capabilities IE**：802.11ax 能力

### 1.8.5 `saaFsmRunEventRxAssoc()` —— 处理 Association Response

这是 SAA FSM 中最关键的接收处理函数——它决定了连接是否成功：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/saa_fsm.c
uint32_t saaFsmRunEventRxAssoc(struct ADAPTER *prAdapter, struct SW_RFB *prSwRfb)
{
    struct STA_RECORD *prStaRec;
    uint16_t u2StatusCode;
    enum ENUM_AA_STATE eNextState;

    // ... 查找 STA_RECORD 省略 ...

    switch (prStaRec->eAuthAssocState) {
    case SAA_STATE_SEND_ASSOC1:
    case SAA_STATE_WAIT_ASSOC2:
        // 验证收到的帧是否是我们要等的 Assoc Response
        if (assocCheckRxReAssocRspFrameStatus(prAdapter,
            prSwRfb, &u2StatusCode) == WLAN_STATUS_SUCCESS) {

            cnmTimerStopTimer(prAdapter,
                      &prStaRec->rTxReqDoneOrRxRespTimer);
            prStaRec->u2StatusCode = u2StatusCode;

            if (u2StatusCode == STATUS_CODE_SUCCESSFUL) {
                // 连接成功！清零失败计数
                prStaRec->ucJoinFailureCount = 0;
            } else {
                // Assoc 被拒绝
                cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_1);
                DBGLOG(SAA, INFO,
                       "Assoc Req was rejected by [" MACSTR
                       "], Status Code = %d\n",
                       MAC2STR(prStaRec->aucMacAddr), u2StatusCode);
            }

            // 更新 RCPI（Received Channel Power Indicator）
            prStaRec->ucRCPI =
                nicRxGetRcpiValueFromRxv(prAdapter, RCPI_MODE_MAX, prSwRfb);

            eNextState = AA_STATE_IDLE;
            saaFsmSteps(prAdapter, prStaRec, eNextState, prRetainedSwRfb);
        }
        break;
    }

    return rStatus;
}
```

主要功能：

- 通过 `assocCheckRxReAssocRspFrameStatus()` 验证收到的帧有效性——不仅检查 Status Code，还做 AID 提取（低 14 位）和 Capability IE 校验，确保 Assoc Response 不是伪造的或损坏的帧
- **成功路径**：`u2StatusCode == 0` → 清零 `ucJoinFailureCount`，提取 RCPI（Received Channel Power Indicator）；AID（低 14 位）在 Assoc Response 帧处理流程的后续步骤中由 `assocCheckRxReAssocRspFrameStatus()` 提取，不在本函数。
- **失败路径**：打印 `"Assoc Req was rejected by [BSSID], Status Code = X"`，将 STA 回退到 `STA_STATE_1`（Class 1）
- SAA FSM 回到 `AA_STATE_IDLE`，通过消息系统通知 AIS FSM 进入 `AIS_STATE_NORMAL_TR`（连接成功）或 `AIS_STATE_JOIN_FAILURE`（失败）

## 1.9 MTK 的 Auth/Assoc 日志里有什么？成功静默，失败才说话

MTK 驱动的日志通过 `DBGLOG()` 宏输出，不同模块有独立的 log level 控制。以下是源码中的**真实**日志字符串（来自 `mgmt/auth.c`、`mgmt/assoc.c`、`mgmt/saa_fsm.c`）：

**发送 Auth 帧时**（`auth.c:390`）：

```
DBGLOG(SAA, INFO, "Send Auth, TranSeq: %d, Status: %d, Seq: %d, SA: ... DA: ...")
```

注：SA/DA 实际使用 MACSTR/MAC2STR 宏打印完整 MAC 地址，此处为简洁省略。

**发送 Assoc 帧时**（`assoc.c:779`）：

```
DBGLOG(SAA, INFO, "Send %sAssoc Req, SA: ... DA: ...")
```

// SA/DA 实际使用 MACSTR/MAC2STR 宏打印完整 MAC 地址，此处省略
（`%s` 为空字符串或 "Re"，同一个函数区分初次关联和重关联）

**Auth 被拒绝时**（`saa_fsm.c:1015`——只有在 Status Code 非 0 时才打印）：

```
DBGLOG(SAA, INFO, "Auth Req was rejected by [" MACSTR "], Status Code = %d")
```

**Assoc 被拒绝时**（`saa_fsm.c:1213`——同样只在 Status Code 非 0 时打印）：

```
DBGLOG(SAA, INFO, "Assoc Req was rejected by [" MACSTR "], Status Code = %d")
```

**AIS FSM 状态转移**（`ais_fsm.c:2891`——每个状态切换都会打印）：

```
DBGLOG(AIS, STATE, "[AIS%d][%d] TRANSITION: [%s] -> [%s]")
```

Auth/Assoc **成功时静默转移状态**——驱动源码中不存在 `"Auth Req was accepted"` 或 `"Assoc Req was accepted"` 的日志。成功的标志是 AIS FSM 的状态转移从 `JOIN` 进入 `NORMAL_TR`，而不是看到某行 accepted 日志。这是 MTK 驱动的一个常见调试陷阱：如果你在 dmesg 中搜不到 accepted 字符串，不代表连接失败了——源码本来就不打印成功日志。

**固件侧日志**（FW log）作为补充：

```
FW: AUTH_SEND auth_algo=0 trans_seq=1
FW: AUTH_RX status=0 trans_seq=2
FW: ASSOC_SEND
FW: ASSOC_RX status=0 aid=1
```

固件日志需要厂商工具才能抓取（非 dmesg），但帧级别的 TX/RX 只在固件日志中可见。dmesg 中的驱动日志只能看到"帧已发送"（TX done callback）和"收到响应帧"（RX handler 中的状态转移）。

> **Tips**：排查 MTK 设备连接问题时，开启 AIS+SAA 模块的 DBGLOG 后，通过 AIS FSM 的状态转移日志判断连接进度：`JOIN → JOIN_FAILURE`（Auth/Assoc 有错误）vs `JOIN → NORMAL_TR`（连接成功）。如果需要帧级日志，必须在固件侧抓取，dmesg 看不到。
>
> 安保执行员（SAA FSM）只在出问题时才说话（打印 rejected 日志），事情办好了就默默汇报给大堂经理（AIS FSM 状态转移），不会在签到表上多写一行"搞定了"——这就是为什么你在 dmesg 里搜不到 accepted 日志。

## 1.10 Auth 失败后 SAA FSM 如何回退？

当 Auth 被拒绝或超时时：

```
SAA FSM: 收到 AUTH Response, Status Code != 0
  → saaFsmRunEventRxAuth() 检测到拒绝
    → DBGLOG "Auth Req was rejected by [BSSID], Status Code = X"（saa_fsm.c:1015）
    → saaFsmSteps(AA_STATE_IDLE)  → SAA FSM 回到空闲
      → 通知 AIS FSM: JOIN 失败
        → AIS FSM: JOIN_FAILURE → DISCONNECTING
          → Framework 收到 Disconnected 事件
```

**Auth 超时**的情况类似——SAA FSM 的 `saaFsmRunEventRxRespTimeOut()` 触发，设置 `STATUS_CODE_AUTH_TIMEOUT`，然后走同样的 SAA→IDLE → AIS JOIN_FAILURE → DISCONNECTING 路径。AIS FSM 状态转移日志会显示 `JOIN → JOIN_FAILURE`。

**Auth Response 常见 Status Code**（802.11-2024 §9.4.1.9）：

| Status Code | 名称                        | 含义     | 典型原因                                |
| ----------- | --------------------------- | -------- | --------------------------------------- |
| 0           | `SUCCESSFUL`                | 认证成功 | 进入 Assoc 阶段                         |
| 16          | `REJECTED_SEQUENCE_TIMEOUT` | 认证超时 | AP 在指定时间内未收到 Auth 帧的后续序列 |

安保执行员被拒后立即通过内部电话通知大堂经理——不等、不猜、不错过。

## 1.11 Assoc 失败后驱动如何处理？同样的机制，不同的状态码

Assoc 失败的处理与 Auth 类似——SAA FSM 检测到 Assoc Response 中的 Status Code 非零后，打印日志并回退状态。但与 Auth 失败（AP 通常在 Auth Response 中只返回 0 或 15 两种状态码）不同，Assoc Response 可能出现更多种类的拒绝原因。这些状态码定义在 802.11-2024 §9.4.1.9 中，`assocCheckRxReAssocRspFrameStatus()` 从收到的帧中提取 `u2StatusCode` 后，不做进一步解析——直接将原始值存入 `prStaRec->u2StatusCode`，然后由 DBGLOG 打印。

**Assoc Response 常见 Status Code 表**（从 802.11-2024 §9.4.1.9 中提取，与连接失败最相关的部分）：

| Status Code | 名称                                 | 含义                       | 典型原因                                            |
| ----------- | ------------------------------------ | -------------------------- | --------------------------------------------------- |
| 0           | `SUCCESSFUL`                         | 关联成功                   | AID 分配正常，所有 IE 协商通过                      |
| 12          | `DENIED_OTHER_REASON`                | 关联拒绝（标准范围外原因） | AP 出于标准未定义的其他原因拒绝关联                 |
| 13          | `UNSUPPORTED_AUTH_ALGORITHM`         | 不支持指定的认证算法       | 响应方不支持 STA 请求的认证算法                     |
| 17          | `AP_UNABLE_TO_HANDLE_ADDITIONAL_STA` | AP 已达到关联上限          | AP 的 `Max Associations` 已满                       |
| 18          | `DENIED_NOT_SUPPORTING_ALL_RATES`    | 不支持所有基础速率         | STA 的 Supported Rates 不包含 AP 的 BSSBasicRateSet |
| 30          | `ASSOCIATION_DENIED_TEMPORARILY`     | 临时拒绝关联               | AP 在高负载下暂时不接受新关联（可能稍后重试成功）   |
| 31          | `ROBUST_MANAGEMENT_POLICY_VIOLATION` | 健壮管理帧策略违规         | STA 发送的管理帧违反 Robust Management 策略         |
| 33          | `DENIED_NOT_ENOUGH_BANDWIDTH`        | 带宽不足                   | AP 无法满足 STA 的 QoS 需求                         |
| 38          | `INVALID_PARAMETERS`                 | 参数含无效值               | 请求中的一个或多个参数含无效值                      |

**SAA FSM 的处理逻辑**：`saaFsmRunEventRxAssoc()` 调用 `assocCheckRxReAssocRspFrameStatus()` 提取 `u2StatusCode` 后：

- `u2StatusCode == 0`（`STATUS_CODE_SUCCESSFUL`）→ 清零 `ucJoinFailureCount`，SAA 回到 `IDLE`，AIS 进入 `NORMAL_TR`
- `u2StatusCode != 0` → DBGLOG 打印 `"Assoc Req was rejected by [BSSID], Status Code = X"`，STA 回退到 `STA_STATE_1`（Class 1），SAA 回到 `IDLE`，AIS 进入 `JOIN_FAILURE → DISCONNECTING`

**AIS FSM 的后续处理**：与 Auth 失败不同，Assoc 失败不会触发"尝试下一种认证方式"的逻辑——因为 Auth 已经通过了，问题出在关联参数（能力协商、IE 匹配、AP 容量等）。AIS FSM 在 `JOIN_FAILURE` 后直接进入 `DISCONNECTING`，然后由上层 Framework 的 `WifiBlocklistMonitor` 决定是否尝试下一个候选 AP。与 QCOM 不同的是，MTK 当前没有内置的多候选重试机制——AIS FSM 在 `JOIN_FAILURE` 后直接进入 `DISCONNECTING`（从 `ais_fsm.c` 中 `JOIN_FAILURE` 状态的 transfer 路径可见，无候选队列或自动重试逻辑），重试逻辑由上层驱动。

```
SAA FSM: 收到 Assoc Response, Status Code != 0
  → saaFsmRunEventRxAssoc() 检测到拒绝
    → DBGLOG "Assoc Req was rejected by [BSSID], Status Code = X"（saa_fsm.c:1213）
    → cnmStaRecChangeState(STA_STATE_1) // 回退到 Class 1
    → saaFsmSteps(AA_STATE_IDLE)  → SAA FSM 空闲
      → AIS FSM: JOIN_FAILURE → DISCONNECTING
```

## 1.12 JOIN 超时是固定值还是动态计算？

MTK 的 JOIN 超时不是固定值，而是**动态计算**的。AIS FSM 在进入 JOIN 状态时启动超时定时器：

```c
// ais_fsm.c — 超时时间 = 固件授予的信道持有时间 - 安全余量
cnmTimerStartTimer(prAdapter,
                   &prAisFsmInfo->rJoinTimeoutTimer,
                   prAisFsmInfo->u4ChGrantedInterval -
                   AIS_JOIN_CH_GRANT_THRESHOLD);
```

其中 `AIS_JOIN_CH_GRANT_THRESHOLD` = 10 ms（定义在 `ais_fsm.h`），是提前触发超时的安全余量——确保在信道被固件回收之前，host 侧先触发超时处理。信道请求间隔 `AIS_JOIN_CH_REQUEST_INTERVAL` = 4000 ms（定义在 `ais_fsm.h`）。回到酒店比喻——这个超时定时器就是大堂经理手里的催办闹钟：固件授予的信道持有时间好比客人允许占用的办理窗口，闹钟不是设在窗口尽头才响，而是提前 10 ms 就响一下，好让大堂经理（AIS FSM）在窗口被固件收回之前先回过神来处理超时。

> **平台差异**：AIS_JOIN_CH_REQUEST_INTERVAL 在 non-FPGA 平台为 4000 ms，在 CFG_MTK_FPGA_PLATFORM 平台为 40000 ms。

定时器到期后，`aisFsmRunEventJoinTimeout()` 被触发——这个回调注册在 AIS 模块初始化时，根据当前 AIS 状态做不同处理：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/ais_fsm.c:6414
void aisFsmRunEventJoinTimeout(struct ADAPTER *prAdapter, uintptr_t ulParamPtr)
{
    struct AIS_FSM_INFO *prAisFsmInfo;
    struct STA_RECORD *prStaRec;
    enum ENUM_AIS_STATE eNextState;
    uint8_t ucBssIndex = (uint8_t) ulParamPtr;

    prAisFsmInfo = aisGetAisFsmInfo(prAdapter, ucBssIndex);
    eNextState = prAisFsmInfo->eCurrentState;

    switch (prAisFsmInfo->eCurrentState) {
    case AIS_STATE_JOIN:
        // Auth/Assoc 超时——标记 STA 为超时，触发失败处理
        DBGLOG(AIS, WARN, "EVENT- JOIN TIMEOUT\n");
        prStaRec = aisGetTargetStaRec(prAdapter, ucBssIndex);
        prStaRec->u2StatusCode = STATUS_CODE_AUTH_TIMEOUT;
        eNextState = aisHandleJoinFailure(prAdapter,
                prStaRec, NULL, ucBssIndex);
        break;

    case AIS_STATE_NORMAL_TR:
        // 已连接状态下超时——释放信道，处理下一个待处理请求
        aisFsmReleaseCh(prAdapter, ucBssIndex);
        eNextState = aisFsmHandleNextReq_NORMAL_TR(
            prAdapter, prAisFsmInfo, ucBssIndex);
        break;

    default:
        // 其他状态超时——释放信道即可
        aisFsmReleaseCh(prAdapter, ucBssIndex);
        break;
    }

    // 状态变更时调用 AIS FSM 步进函数
    if (eNextState != prAisFsmInfo->eCurrentState)
        aisFsmSteps(prAdapter, eNextState, ucBssIndex);
}
```

- JOIN 状态超时时，`aisHandleJoinFailure()` 内部会检查是否还有其他认证方式可尝试——如果有则回 `SEARCH`，没有则进入 `JOIN_FAILURE → DISCONNECTING`
- NORMAL_TR 状态超时是正常的——每 4 秒释放一次信道，处理积压的扫描/漫游等排队请求，然后重新申请信道
- `eNextState != eCurrentState` 的检查确保只在状态确实变更时才调用 `aisFsmSteps()`——避免不必要的状态机推进触发日志刷屏

## 1.13 MTK 驱动如何透传 EAPOL 并安装密钥？

与 QCOM 类似，MTK 驱动也在 Auth/Assoc 完成后通过数据通路透传 EAPOL 帧。MTK 生态中有两条路径，取决于驱动架构——gen4m（fullmac）走传统 AF_PACKET 路径，mt76（softmac）走 mac80211 标准 Control Port 路径。

| 路径         | gen4m（fullmac）                                             | mt76（softmac/mac80211）                                     |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **TX**       | Supplicant → AF_PACKET → `ndo_start_xmit` → 固件 → AP        | Supplicant → nl80211 Control Port → `ieee80211_tx_control_port()` → `ndo_start_xmit` → 固件 → AP |
| **RX**       | 固件 → `nicRxProcessRFBs()` → `netif_rx()` → AF_PACKET → Supplicant | AP → 固件 → mac80211 RX → `cfg80211_rx_control_port()` → nl80211 → Supplicant |
| **关键差异** | 不使用 mac80211，EAPOL 帧当普通以太网帧交付                  | 标准 mac80211 框架，EAPOL 帧通过 nl80211 Control Port 精准投递 |

先看 TX 侧的两条路径：

### 1.13.1 EAPOL 发送：gen4m 和 mt76 两条路径

MTK 生态中有两条 EAPOL TX 路径，取决于驱动架构：

- **gen4m（fullmac）**：wpa_supplicant → AF_PACKET raw socket（`l2_packet` 接口）→ 内核协议栈 → MTK 驱动的 `wlan_netdev_ops.ndo_start_xmit` → 固件 → 空口 → AP。gen4m 是 fullmac 架构，不使用 mac80211，也未注册 `tx_control_port` 回调——EAPOL 帧被当作普通以太网帧交付，由驱动的 `ndo_start_xmit` 直接提交到固件 TX 队列。

- **mt76（softmac/mac80211）**：wpa_supplicant → nl80211（Control Port）→ 标准 cfg80211 Control Port 路径（`rdev_tx_control_port` → `ieee80211_tx_control_port`，定义在 `net/mac80211/tx.c:5884`）→ 驱动数据路径 → 固件 → 空口 → AP。与 gen4m 不同，mt76 依赖 mac80211 的标准实现，在 `ieee80211_tx_control_port()` 中为帧添加以太网头（`ethhdr`），然后通过 `__ieee80211_subif_start_xmit()` 提交到 TX 队列。

两条路径并存的根因是架构时序：gen4m fullmac 诞生早于 mac80211 成熟，且固件已内置 802.11→802.3 转换，Host 侧只需把 EAPOL 帧当普通以太网帧交给 `ndo_start_xmit`；mt76 是现代 softmac 驱动，把帧转换交给 mac80211 标准的 `ieee80211_tx_control_port()`。

下面是 mt76/mac80211 路径的代码实现（gen4m 的 `ndo_start_xmit` 实现为预编译库，非开源）：

```c
// MTK kernel-mtk/net/mac80211/tx.c:5884
int ieee80211_tx_control_port(struct wiphy *wiphy, struct net_device *dev,
                              const u8 *buf, size_t len,
                              const u8 *dest, __be16 proto, bool unencrypted,
                              int link_id, u64 *cookie)
{
    struct ieee80211_sub_if_data *sdata = IEEE80211_DEV_TO_SUB_IF(dev);
    struct ieee80211_local *local = sdata->local;
    struct sk_buff *skb;
    struct ethhdr *ehdr;
    u32 ctrl_flags = 0;

    // 协议校验：只接受 Control Port 或 Pre-Auth
    if (proto != sdata->control_port_protocol &&
        proto != cpu_to_be16(ETH_P_PREAUTH))
        return -EINVAL;

    // 分配 skb（含硬件 headroom + 以太网头）
    skb = dev_alloc_skb(local->hw.extra_tx_headroom +
                        sizeof(struct ethhdr) + len);
    if (!skb)
        return -ENOMEM;

    skb_reserve(skb, local->hw.extra_tx_headroom + sizeof(struct ethhdr));
    skb_put_data(skb, buf, len);

    // 构造以太网头：dest = AP MAC, src = STA MAC, proto = 0x888E
    ehdr = skb_push(skb, sizeof(struct ethhdr));
    memcpy(ehdr->h_dest, dest, ETH_ALEN);
    memcpy(ehdr->h_source, sdata->vif.addr, ETH_ALEN);
    ehdr->h_proto = proto;

    skb->dev = dev;
    skb->protocol = proto;  // ETH_P_PAE (0x888E)

    // ... 省略：QoS queue selection, MLO link selection ...

    // 提交到 mac80211 TX 路径 → 驱动 ndo_start_xmit → 固件 → 空口
    __ieee80211_subif_start_xmit(skb, skb->dev, flags, ctrl_flags, cookie);

    return 0;
}
```

主要功能：

- 与 QCOM 的 `__wlan_hdd_cfg80211_tx_control_port()` 功能完全对应，但这是 mac80211 层的标准实现——MTK 驱动不重复造轮子
- 关键差异：QCOM 驱动自己定义 `.tx_control_port` 回调，MTK 则依赖 mac80211 的标准路径，cfg80211 通过 `rdev_tx_control_port()` 调用到 `ieee80211_tx_control_port()`
- 帧从 `__ieee80211_subif_start_xmit()` 进入 MTK 驱动的 `wlan_netdev_ops.ndo_start_xmit`，然后走 MTK 自己的 TX 数据路径

> **Tips**：gen4m fullmac 和 mt76/mac80211 两条 EAPOL TX 路径并存是历史原因——gen4m 是较早的 fullmac 架构，走传统 AF_PACKET 路径；mt76 是现代 mac80211 标准路径。如果你用的是 MT7915/MT7921 等较新芯片，只需关心 mt76/mac80211 路径。

> EAPOL TX 走完，帧已到达 AP。接下来看对称的 RX 侧——AP 回复的 EAPOL 帧如何从空口回到 wpa_supplicant。MTK 生态中有两条 RX 路线，取决于驱动架构。

### 1.13.2 EAPOL 接收：从空口到 Supplicant 的完整反向路径

以下是 EAPOL 帧从空口到 wpa_supplicant 的完整反向路径：

**路径 A（gen4m fullmac，传统方式）**：AP → 空口 → 固件将 EAPOL 数据帧转换为以太网帧后上报（剥除 802.11 头，添加 EtherType=0x888E） → Host DMA 缓冲区 → NAPI poll → `nicRxProcessRFBs()`（预编译 NIC 层闭源）→ `kalRxIndicateOnePkt()`（`gl_kal.c:1934`）→ `eth_type_trans(skb, dev)` 识别 `skb->protocol = ETH_P_PAE`（0x888E）→ `netif_rx()` → 内核协议栈 → AF_PACKET raw socket → wpa_supplicant。

这一路与 TX 侧 gen4m 的 AF_PACKET 路径对称——EAPOL 帧被当作普通以太网帧交付给内核，wpa_supplicant 通过 `l2_packet` 接口或 AF_PACKET socket 接收，全程不经过 mac80211 的 Control Port。

**路径 B（mac80211 softmac，nl80211 Control Port 路径）**——这是现代 MTK 驱动（mt76：MT7915、MT7921 等）使用的标准路径。它也是与 TX 侧 `ieee80211_tx_control_port()` 对称的接收通道：

```
空口 → 固件（透传）→ DMA → NAPI poll
  → ieee80211_rx_list()                 [net/mac80211/rx.c:5176]
    → ieee80211_rx_h_data()             [rx.c:3041]
      → __ieee80211_data_to_8023()      [rx.c:2484]  ← 802.11→802.3 转换，识别 ETH_P_PAE
        → ieee80211_frame_allowed()      [rx.c:2555]  ← EAPOL 无条件放行（即使 STA 未 AUTHORIZED）
      → ieee80211_deliver_skb_to_local_stack() [rx.c:2577] ← 分叉点
        → cfg80211_rx_control_port()     [net/wireless/nl80211.c:18830]
          → __nl80211_rx_control_port()  [nl80211.c:18774] ← 构造 netlink 消息
            → genlmsg_unicast() → wpa_supplicant 的 nl80211 socket
              → nl80211_control_port_frame() → drv_event_eapol_rx2() → EAPOL 状态机
```

关键函数的源码分析如下。

**EAPOL 帧识别**在 `__ieee80211_data_to_8023()`（`rx.c:2515-2516`）中完成——802.11 数据帧被转换为 802.3 以太网帧后，检查以太网头的 `h_proto` 字段：

```c
// net/mac80211/rx.c:2515 — 802.11→802.3 转换中识别 EAPOL
ehdr = (struct ethhdr *) rx->skb->data;
if (ehdr->h_proto == rx->sdata->control_port_protocol)
    *port_control = true;   // control_port_protocol 默认 = ETH_P_PAE (0x888E)
```

**EAPOL 无条件放行**在 `ieee80211_frame_allowed()`（`rx.c:2566-2568`）——即使 STA 尚未通过 802.1X 认证（`STA_STATE_AUTHORIZED`），EAPOL 帧也必须放行，否则四次握手根本无法完成：

```c
// net/mac80211/rx.c:2566 — EAPOL 帧绕过所有安全检查
if (unlikely(ehdr->h_proto == rx->sdata->control_port_protocol))
    return ieee80211_is_our_addr(rx->sdata, ehdr->h_dest, NULL) ||
           ether_addr_equal(ehdr->h_dest, pae_group_addr);
```

**分叉逻辑**在 `ieee80211_deliver_skb_to_local_stack()`（`rx.c:2577`）：

```c
// net/mac80211/rx.c:2577 — EAPOL RX 分叉：nl80211 Control Port vs 传统 netif
static void ieee80211_deliver_skb_to_local_stack(struct sk_buff *skb,
                                                 struct ieee80211_rx_data *rx)
{
    if (unlikely((skb->protocol == sdata->control_port_protocol ||
                  skb->protocol == cpu_to_be16(ETH_P_PREAUTH)) &&
                 sdata->control_port_over_nl80211)) {
        // 路径 B: nl80211 Control Port
        bool noencrypt = !(status->flag & RX_FLAG_DECRYPTED);
        cfg80211_rx_control_port(dev, skb, noencrypt, rx->link_id);
        dev_kfree_skb(skb);  // nl80211 已接管，驱动释放 skb
    } else {
        // 路径 A: 传统内核网络栈
        // PAE group addr → 改写为本地 MAC（防止桥转发 EAPOL 到其他网络）
        if (unlikely(skb->protocol == sdata->control_port_protocol &&
                     !ether_addr_equal(ehdr->h_dest, sdata->vif.addr)))
            ether_addr_copy(ehdr->h_dest, sdata->vif.addr);
        netif_receive_skb(skb);  // 进入内核协议栈
    }
}
```

分叉条件 `sdata->control_port_over_nl80211` 默认启用（当驱动注册 `NL80211_EXT_FEATURE_CONTROL_PORT_OVER_NL80211` 时），这意味着现代 wpa_supplicant 配置下，EAPOL RX 走 nl80211 Control Port 路径。PAE group address 的改写——当 EAPOL 帧目的地址为 PAE group address（`01:80:C2:00:00:03`）时，mac80211 将其改写为本地 MAC 地址，防止该帧被桥转发到其他网络——802.1X 要求只有认证者（authenticator）能收到 EAPOL 帧。

以上两个分叉的实质是 EAPOL 交付机制的历史演进——传统路径将 EAPOL 当作普通以太网帧交给内核协议栈，wpa_supplicant 通过 AF_PACKET socket 捕获；nl80211 Control Port 路径则是内核直接将 EAPOL 帧打包成 netlink 消息，精准投递到 wpa_supplicant 注册的 socket。现代驱动默认使用 nl80211 Control Port，因为它避免了 AF_PACKET 的全局嗅探开销和权限问题。

> 至此 EAPOL 帧已经到达 mac80211 层的分叉点。接下来看路径 B 的最后一步——netlink 消息构造和投递。

**netlink 消息构造**由 `__nl80211_rx_control_port()`（`nl80211.c:18774`）完成：

```c
// net/wireless/nl80211.c:18774
static int __nl80211_rx_control_port(struct net_device *dev, struct sk_buff *skb,
                                     bool unencrypted, int link_id, gfp_t gfp)
{
    struct wireless_dev *wdev = dev->ieee80211_ptr;
    struct ethhdr *ehdr = eth_hdr(skb);
    u32 nlportid = READ_ONCE(wdev->conn_owner_nlportid);

    if (!nlportid)     // wpa_supplicant 未注册，无法投递
        return -ENOENT;

    msg = nlmsg_new(100 + skb->len, gfp);
    hdr = nl80211hdr_put(msg, ..., NL80211_CMD_CONTROL_PORT_FRAME);

    // 填充 netlink 属性
    nla_put_u32(msg, NL80211_ATTR_WIPHY, rdev->wiphy_idx);
    nla_put_u32(msg, NL80211_ATTR_IFINDEX, dev->ifindex);
    nla_put(msg, NL80211_ATTR_MAC, ETH_ALEN, ehdr->h_source);    // 源 MAC
    nla_put_u16(msg, NL80211_ATTR_CONTROL_PORT_ETHERTYPE, proto); // ETH_P_PAE
    // ... MLO link_id, NO_ENCRYPT flag ...

    frame = nla_reserve(msg, NL80211_ATTR_FRAME, skb->len);
    skb_copy_bits(skb, 0, nla_data(frame), skb->len);  // 复制 EAPOL payload
    genlmsg_end(msg, hdr);

    return genlmsg_unicast(wiphy_net(&rdev->wiphy), msg, nlportid);
    // ↑ 单播到 wpa_supplicant 的 netlink socket
}
```

`genlmsg_unicast()` 将消息投递到 `wdev->conn_owner_nlportid`（即 wpa_supplicant 通过 `NL80211_CMD_CONNECT` 注册的 netlink port ID）。wpa_supplicant 的事件处理循环收到 `NL80211_CMD_CONTROL_PORT_FRAME` 后，调用 `nl80211_control_port_frame()`（`driver_nl80211_event.c:3723`），检查 ethertype 为 `ETH_P_PAE` → 调用 `drv_event_eapol_rx2()`，进入 EAPOL 状态机处理。

**RX/TX 路径对称性分析**：

| 维度                  | TX                                                       | RX                                                           | 对称?                |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | -------------------- |
| **nl80211 命令/事件** | `NL80211_CMD_CONTROL_PORT_FRAME`（从用户态下发）         | `NL80211_CMD_CONTROL_PORT_FRAME`（从内核上报）               | 同一命令字，方向相反 |
| **cfg80211 接口**     | `rdev_tx_control_port()` → `ieee80211_tx_control_port()` | `cfg80211_rx_control_port()` → `__nl80211_rx_control_port()` | 对称                 |
| **mac80211 入口**     | `ieee80211_tx_control_port()`（tx.c:5884）               | `ieee80211_deliver_skb_to_local_stack()`（rx.c:2577）        | 对称                 |
| **EAPOL 识别**        | 直接指定 `proto = ETH_P_PAE`（调用者传入）               | 解析以太网头 `ehdr->h_proto == ETH_P_PAE`                    | 对称                 |
| **加密处理**          | 默认不加密（`unencrypted` 标志）                         | 硬件解密后透传（`noencrypt = !RX_FLAG_DECRYPTED`）           | 对称                 |
| **驱动差异**          | MTK gen4m 走传统路径或 mac80211 标准接口                 | gen4m 走 `nicRxProcessRFBs()` 传统路径；mt76 走 mac80211     | 驱动架构决定         |

核心结论：在 mac80211 架构下（mt76 驱动），EAPOL RX 与 TX 在 cfg80211/mac80211 层完全对称——同一个 `NL80211_CMD_CONTROL_PORT_FRAME` 命令字在 TX 方向是 netlink 命令（用户态→内核），在 RX 方向是 netlink 事件（内核→用户态）。到 wpa_supplicant 后的处理也对称：TX 走 `wpa_drv_send_eapol()`，RX 走 `drv_event_eapol_rx2()`。

## 1.14 密钥安装：从 NL80211_CMD_NEW_KEY 到固件

四次握手完成后，Supplicant 下发 `NL80211_CMD_NEW_KEY`，触发 MTK 驱动的 `mtk_cfg80211_add_key()` 回调：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/os/linux/gl_cfg80211.c
int mtk_cfg80211_add_key(struct wiphy *wiphy,
             struct net_device *ndev, int link_id,
             u8 key_index, bool pairwise, const u8 *mac_addr,
             struct key_params *params)
{
    struct PARAM_KEY rKey;
    struct GLUE_INFO *prGlueInfo = NULL;
    uint32_t u4BufLen = 0;
    uint32_t rStatus = 0;
    uint8_t ucBssIndex;

    WIPHY_PRIV(wiphy, prGlueInfo);
    ucBssIndex = wlanGetBssIdx(ndev);

    // 构建密钥参数
    kalMemZero(&rKey, sizeof(struct PARAM_KEY));
    rKey.u4KeyIndex = key_index;
    rKey.u4KeyLength = params->key_len;

    // pairwise 标志编码在 key_index 高位（BIT(31) | BIT(30)）
    // PARAM_KEY 结构体中没有独立的 isPairwise 字段
    if (pairwise) {
        rKey.u4KeyIndex |= BIT(31);
        rKey.u4KeyIndex |= BIT(30);
        COPY_MAC_ADDR(rKey.arBSSID, mac_addr);
    }
    // ... 省略：cipher suite 映射（switch 将 WLAN_CIPHER_SUITE_* 转为 MTK 内部 CIPHER_SUITE_* 枚举）...

    if (params->key_len)
        kalMemCopy(rKey.aucKeyMaterial, params->key, params->key_len);
    // ... 省略：ucBssIdx/i4LinkId 赋值、RSC 处理、cipher suite 匹配、日志打印 ...

    rKey.u4Length = OFFSET_OF(struct PARAM_KEY, aucKeyMaterial)
                    + rKey.u4KeyLength;

    // 下发密钥到固件——通过内部 ioctl dispatch，实际调用 wlanoidSetAddKey()
    rStatus = kalIoctl(prGlueInfo,
            wlanoidSetAddKey,
            &rKey,
            rKey.u4Length,
            &u4BufLen);

    if (rStatus == WLAN_STATUS_SUCCESS)
        return 0;
    return -EINVAL;
}
```

主要功能：

- `kalIoctl(wlanoidSetAddKey)` 将密钥通过内部 ioctl dispatch 下发给固件（实际调用 `wlanoidSetAddKey()` (`common/wlan_oid.c:2957`) → `wlanSetAddKey()` (`common/wlan_oid.c:2834`)）
- pairwise 标志通过 `u4KeyIndex` 高位（BIT(31) | BIT(30)）编码，而非独立字段——`PARAM_KEY` 结构体中不存在 `u4IsPairwise` 字段
- `ucCipher` 是 `uint8_t` 类型字段（不是 `u4Cipher`），通过 switch 将 Linux cipher suite 映射为 MTK 内部枚举值（如 `WLAN_CIPHER_SUITE_CCMP` → `CIPHER_SUITE_CCMP`）
- 密钥材料和序列号（RSC，Receive Sequence Counter）一并下发
- 密钥安装完成后，固件对数据帧启用加密

MTK 与 QCOM 在 EAPOL 处理上的差异：

| 维度              | QCOM                                    | MTK                                                          |
| ----------------- | --------------------------------------- | ------------------------------------------------------------ |
| **密钥下发命令**  | WMI `WMI_VDEV_INSTALL_KEY_CMDID`        | 内部 ioctl dispatch `wlanoidSetAddKey`                       |
| **EAPOL TX 接口** | `__wlan_hdd_cfg80211_tx_control_port()` | gen4m: AF_PACKET 传统路径；mt76: 标准 cfg80211 Control Port 机制 |
| **EAPOL RX 接口** | `wlan_hdd_cfg80211_rx_control_port()`   | gen4m: AF_PACKET 传统路径；mt76: 通过 `cfg80211_rx_control_port()` 上报 |
| **控制端口特性**  | 支持 `CONTROL_PORT_OVER_NL80211`        | 相同（标准 cfg80211 机制）                                   |

EAPOL 透传就像酒店内部的传讯系统——安保执行员（SAA FSM）完成了 Auth/Assoc 后，客人（STA）和酒店（AP）需要通过一套加密的对话（四次握手）来确认房卡（密钥）。驱动层不参与对话内容（那是 supplicant 的活），但它提供了对话用的"对讲机"（Control Port）。最后，当房卡制作完成，安保执行员收到指令（`add_key`），把房卡信息写入门锁系统（固件），此后所有进出房间（数据帧）都需要刷加密房卡。写入门锁时，每张房卡都刻着专属标记——pairwise 标志编码在 `u4KeyIndex` 的 BIT31|BIT30 两个高位，前台（固件）据此一眼分辨这是客人专属房卡（pairwise key）还是共享卡（group key）。

---

# 2 QCOM vs MTK：两个世界的 L2 连接

QCOM 把 Auth/Assoc/EAPOL 当成一个"结果"（固件返回成功或失败），MTK 把每一步当成一个"过程"（每一帧收发都在驱动中可见）。如果说 QCOM 是外包安保公司全权处理入住的酒店——前台只需说一句"帮这位客人办入住"，剩下的事不用管；那 MTK 就是自己员工亲自办理每一道手续的精品酒店——大堂经理统筹全局，安保执行员一步步执行，每一步都有记录，每一步都可追溯。两种模式各有优劣，下面具体对比。

> QCOM 侧的详细代码分析见 [连接（三）——QCOM 驱动层连接执行](/posts/545e3fea/)，本节聚焦架构级对比。MTK 侧代码细节见本篇 §1。

## 2.1 对比总表

| 维度                  | QCOM                                                         | MTK                                                          |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Auth/Assoc 执行者** | 固件（host 侧不接触 802.11 帧）                              | 驱动（SAA FSM 亲自构建和发送 802.11 帧）                     |
| **单播 Probe**        | 固件自动执行（host 无感知）                                  | AIS FSM SEARCH→SCAN 显式控制                                 |
| **帧经过固件？**      | 是——固件自处理 Auth/Assoc（协议逻辑在固件）                  | 是——固件透传管理帧给 Host（协议逻辑在驱动）                  |
| **连接命令**          | 统一 `CMD_CONNECT`（含 SAE）                                 | WPA2-PSK 用 `CMD_CONNECT`，SAE 用 `CMD_AUTHENTICATE` + `CMD_ASSOCIATE` |
| **状态机层级**        | CM（5 主状态）+ 子状态（9 个）                               | AIS（17 状态）+ SAA（8 状态）                                |
| **802.11 帧可见性**   | 固件侧日志（需特殊工具提取）                                 | dmesg 直接可见                                               |
| **重试机制**          | Host 侧管理：10 候选 x 15s 超时                              | 驱动侧管理：主要通过重试计数 + 上层 WifiBlocklistMonitor     |
| **EAPOL 透传方式**    | Control Port（`wlan_hdd_cfg80211_tx/rx_control_port`）       | Control Port（标准 cfg80211 机制 + `cfg80211_rx_control_port`） |
| **密钥安装接口**      | WMI `WMI_VDEV_INSTALL_KEY_CMDID`                             | ioctl dispatch `wlanoidSetAddKey`                            |
| **日志关键字**        | `WMI_CONNECT_CMDID`、`cm_connect_rsp`                        | `Auth Req was rejected by [BSSID]`、`Assoc Req was rejected by [BSSID]`（成功时无日志，仅 AIS STATE 转移） |
| **代码复杂度**        | host 侧代码较简洁（约 2000 行 CM 核心，`wlan_cm_*.c` 文件集，含 CM 状态机核心逻辑） | 驱动侧代码量大（ais_fsm.c ~10,600 行 + saa_fsm.c ~1,900 行 + auth.c ~1,450 行 + assoc.c ~2,350 行，含扫描/漫游/IBSS 等非连接路径代码） |

![双平台 L2 连接时序——Probe→Auth→Assoc→EAPOL](assets/06d-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E5%9B%9B%EF%BC%89MTK-%E9%A9%B1%E5%8A%A8%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06d-compare-sequence.svg)

## 2.2 外包 vs 自营：QCOM 和 MTK 的设计哲学差异在哪？

两个平台的设计选择反映了不同的工程哲学：

- **QCOM 的"固件优先"思路**：固件是一个强大的协处理器，能独立完成复杂的 802.11 协议操作。Host 驱动退居二线，只做编排和决策（选哪个 AP、重试几次），不亲自执行协议。这种设计的极端表现是——连 SAE 的 4 帧认证都由固件完成。

- **MTK 的"驱动可控"思路**：驱动对协议有完全的控制权，每一步帧交换都在 host CPU 上执行。SAE 等复杂认证由 Supplicant（用户态）控制，驱动只是帧的"搬运工"。这种设计让调试非常方便——dmesg 中可以看到每一帧的发送和接收结果，不需要固件日志工具。

对比表里的每一行，背后都是"外包 vs 自营"的酒店管理哲学在起作用。外包酒店（QCOM）的前台只关心结果——客人入住了没？拒绝原因是什么？不关心过程——安保公司怎么验证的身份证、怎么分配的房号，前台不参与也不可见。自营酒店（MTK）的前台（AIS FSM）统筹全局，安保执行员（SAA FSM）每完成一步都汇报："身份验证请求已发送→收到确认→现在分配房间→分配完成"。这种透明度的代价是前台代码量是外包的三倍——但出问题时你一眼就能看到是哪一步卡住了。

## 2.3 什么时候你该关心哪个平台？

| 场景                                  | 看 QCOM 还是 MTK？                      | 关键信息                                         |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| Auth 失败，想知道 AP 返回了什么状态码 | MTK（dmesg 直接有）                     | `Status Code = X`                                |
| QCOM 设备 Auth 失败                   | 需要固件日志                            | 找 `WMI_CONNECT_EVENTID` 的 status               |
| 想知道 Auth/Assoc 各用了多长时间      | MTK                                     | dmesg 中 `CONN_START` 和 `JOIN_SUCCESS` 的时间差 |
| SAE/WPA3 连接失败                     | 看 QCOM 固件日志 或 MTK Supplicant 日志 | QCOM 固件处理 SAE，MTK Supplicant 处理 SAE       |

---

# 3 总结

本篇拆解了 MTK 平台在驱动层执行完整 L2 连接的流程——从 AIS FSM 的 17 状态生命周期管理，到 SAA FSM 的 8 状态 Auth/Assoc 帧交换执行，到 EAPOL 四次握手的驱动透传，一直到密钥安装完成。同时也与 QCOM 平台做了系统对比。

1. **MTK 采用"驱动亲自下场"模式**——AIS FSM（17 状态）管理连接全生命周期（从 SEARCH→SCAN 探路，到 JOIN→NORMAL_TR 连接完成），SAA FSM（8 状态）执行 Auth/Assoc 帧的每一步交换。对于 WPA2-PSK，SAA FSM 的路径为 `IDLE → SEND_AUTH1 → WAIT_AUTH2 → SEND_ASSOC1 → WAIT_ASSOC2 → IDLE`。EAPOL 透传通过 mac80211 标准 Control Port 机制，密钥通过 `wlanoidSetAddKey` ioctl dispatch 下发固件。

2. **MTK 的单播 Probe** 采用 Host-Firmware 分离模式——Host 侧不构建 802.11 帧体，而是将扫描参数打包为 `CMD_SCAN_REQ_V2` 命令发给固件，固件负责构建实际的 802.11 Probe Request 帧并发送。关键在 BSSID 字段：非零 BSSID = 单播，全零 = 广播。

3. **MTK 的 Auth/Assoc 帧交换**完全在驱动侧可见——`authSendAuthFrame()` 构建 Auth 帧、`nicTxEnqueueMsdu()` 入队 TX、`saaFsmRunEventRxAuth()` 处理 Auth Response、`assocSendReAssocReqFrame()` 构建 Assoc 帧、`saaFsmRunEventRxAssoc()` 处理 Assoc Response。每一帧的发送和接收都在 dmesg 中可追踪（需开启相应 DBGLOG 级别）。

4. **两个平台的核心差异**在于执行者不同——QCOM 是固件执行、Host 看结果（外包安保）；MTK 是驱动执行、dmesg 可见全貌（自营安保）。这决定了调试时该去哪里看日志、该理解哪层状态机。

还记得一开始的类比吗？QCOM 是外包安保的连锁酒店——前台监工，安保公司全权处理，省心但不透明。MTK 是自营安保的精品酒店——大堂经理（AIS FSM）从搜索目标、扫描确认、申请频道到安排入住，全程 17 个状态不遗漏；安保执行员（SAA FSM）接到指令后亲自跑腿：递身份验证（Auth）、等确认、递房间分配（Assoc）、等确认，每一步都在对讲机里说一声（dmesg 日志）。两种模式都能让客人顺利入住——区别在于出问题时你该去哪里找人：QCOM 找安保公司后台（固件日志），MTK 直接听对讲机记录（dmesg）。到了发房卡环节（EAPOL + 密钥安装），两个酒店又回到同一条路——通过标准传讯系统（Control Port）协商加密房卡，最后把房卡密码写入门锁（固件密钥安装）——此后所有进出都需要刷加密房卡。这就是 WiFi 驱动层 L2 连接的全貌。

综合 QCOM 和 MTK 两个平台的源码分析，L2 连接的双平台完整图景已经展开——从 NL80211 命令落地，到 Auth/Assoc 帧交换，到 EAPOL 密钥协商，到密钥安装完成。不同认证方式（SAE、FT、FILS、OWE）在驱动层的处理各有分支，WiFi 7 的 MLO（Multi-Link Operation）又引入了多链路连接的新复杂度。下一篇文章聚焦这些安全协议分支与 MLO 的分叉处理。

> 本文引用的规范条目——Authentication 帧格式参见 IEEE 802.11-2024 §9.3.3.11，Association Request 帧格式参见 §9.3.3.6，Association Response 帧格式参见 §9.3.3.7，Authentication/Association 过程概述参见 §11.1，Status Code 定义参见 §9.4.1.9；EAPOL 协议帧格式参见 IEEE 802.1X-2020 §11.3，四次握手流程参见 IEEE 802.11-2024 §12.7.6。

MTK gen4m 驱动源码见 [gen4m 仓库](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)。
