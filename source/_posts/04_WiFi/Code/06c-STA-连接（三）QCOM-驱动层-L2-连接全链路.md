---
title: STA 连接（三）QCOM 驱动层 L2 连接全链路
top: 1
related_posts: true
abbrlink: 545e3fea
date: 2026-09-19 20:38:01
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 上篇讲到 Supplicant 的 SME 通过 NL80211 把 `NL80211_CMD_CONNECT` 下发到了内核——命令到达了，但真正的 802.11 帧交换还没开始。Probe Request 探路、Authentication（认证）、Association（关联）三轮帧交换，谁来执行？怎么执行？本篇聚焦 **QCOM 平台**驱动层 L2 连接的完整过程——从内核收到连接命令开始，到 EAPOL 完成、密钥安装到位、数据帧可以加密传输为止。QCOM 的核心设计哲学是"交给固件"——Host 侧做监工，固件全权代理 Auth/Assoc 帧交换。MTK 平台（驱动亲自下场、两层状态机控场）见后续 MTK 驱动层连接执行篇。

# 本章导读

WiFi 连接的四步曲中，Authentication 和 Association 就像**入住酒店的前两步**——安保人员验证你的身份证（Auth），前台分配房间并登记（Assoc）。在 QCOM 的世界里，酒店的安保全部外包给专业安保公司（固件），前台只需要说一句"帮这位客人办入住"，安保公司自己搞定验证和分配。本篇聚焦 QCOM 这半边的完整流程。

<!--more-->

本篇要回答的问题很具体：从 `NL80211_CMD_CONNECT` 落地到固件返回连接结果，中间发生了哪些事？沿着这条线，你会看到 QCOM CM 状态机的 5 个主状态和 9 个子状态如何串起完整调用链、固件全权代理模式下 host 侧如何只做「选候选 AP + 建 BSS peer + 等结果」、连接前的单播 Probe Request 探路机制（固件自动执行，host 无感知）、10 候选 x 15 秒超时的重试机制、EAPOL 四次握手经 Control Port 接口的透传与密钥安装（PTK/GTK 写入硬件），以及 Auth/Assoc 日志究竟藏在固件侧还是 host 侧 dmesg。

想直接看连接执行流程的读者，可以跳读 [第二节 QCOM 怎么执行连接](#2-QCOM-怎么执行连接？——固件全权代理，Host-只做-监工)。本文所有代码块来自 QCOM 真实驱动源码，为聚焦关键路径做了精简（去掉 log 语句、license 头和部分条件编译分支），精简处标注 `// ...省略...`，文件路径标注在代码块首行。

本篇是连接系列的第三篇，聚焦 QCOM 平台驱动层的 L2 连接执行（probe→auth→assoc→EAPOL）。后续篇章转到 MTK 平台的驱动层连接（两层状态机 + Auth/Assoc 帧构建），再往后是安全协议分支（open/OWE/SAE/EAP/MLO）。

---

# 1 NL80211 命令落地——驱动收到了什么？

Supplicant 通过 NL80211 发送连接命令后，内核的 cfg80211 框架通过 `.connect` 回调将请求转发给驱动。不同平台对这条命令的处理方式截然不同——QCOM 统一收到 `CMD_CONNECT` 后全权交给固件，MTK 则区分 WPA2-PSK（CMD_CONNECT）和 SAE（CMD_AUTHENTICATE + CMD_ASSOCIATE）两种模式。

## 1.1 两种 NL80211 命令模式的本质区别

在进入各个平台的源码之前，有必要先搞清楚 Supplicant 到底发了什么命令下来：

| 命令                                 | 含义     | 比喻                               | 适用场景                                  |
| ------------------------------------ | -------- | ---------------------------------- | ----------------------------------------- |
| `CMD_CONNECT`                        | 一步到位 | "帮我搞定入住，所有步骤你看着办"   | Open、WPA2-PSK、WPA-EAP                   |
| `CMD_AUTHENTICATE` + `CMD_ASSOCIATE` | 两步分控 | "先验证身份，确认无误后再分配房间" | SAE（WPA3）、FT、FILS、OWE、部分 EAP 方法 |

**为什么需要两步？** SAE（Simultaneous Authentication of Equals）的认证过程需要 Commit + Confirm 两帧交换（共 4 帧），比 Open Authentication 的 2 帧复杂。如果用 `CMD_CONNECT`，驱动必须理解 SAE 协议细节才能完成帧交换。所以 MTK 选择了分步模式——Supplicant 用 `CMD_AUTHENTICATE` 亲自控制 SAE 帧交换，驱动只管收发；而 QCOM 的固件能力足够强，连 SAE 的多帧认证都能自行处理，所以统一用 `CMD_CONNECT`。

## 1.2 两个平台的命令选择

| 平台     | WPA2-PSK (Open Auth) | SAE/WPA3                             | 命令风格                  |
| -------- | -------------------- | ------------------------------------ | ------------------------- |
| **QCOM** | `CMD_CONNECT`        | `CMD_CONNECT`                        | 统一命令，固件全权代理    |
| **MTK**  | `CMD_CONNECT`        | `CMD_AUTHENTICATE` + `CMD_ASSOCIATE` | Driver-managed + SME 分步 |

本文后续分析默认以 WPA2-PSK 的 Open Authentication（2 帧）+ 标准 Assoc Req/Resp 为上下文；SAE 的多帧认证和 FT 的快速切换只在其他认证方式的差异对比中提及，不展开。

---

# 2 QCOM 怎么执行连接？——固件全权代理，Host 只做"监工"

QCOM 驱动把 Auth + Assoc 合并成单个 `WMI_VDEV_START_REQUEST_CMDID` 发给固件，固件内部自行完成 802.11 帧交换后返回 `WMI_VDEV_START_RESP_EVENTID`。Host 侧全程不碰 802.11 帧——它的职责是选择候选 AP、创建 BSS peer、等待结果、处理失败重试。

## 2.1 QCOM 架构特点

回到酒店比喻——QCOM 的 Host 驱动就像酒店前台，固件就像外包的专业安保公司：

- **前台（Host）的职责**：从客人列表（扫描缓存）中选一个最合适的、填写入住登记表（BSS peer）、交给安保公司（固件）、等待安保公司回复
- **安保公司（固件）的职责**：验证身份（Auth）、分配房间（Assoc）、报告结果

这种设计的优势很明显：Host 侧代码简洁，不需要理解 802.11 帧的细节。但代价是 Auth/Assoc 的帧交换过程对 host 侧不透明——如果 Auth 失败，你只能看到固件返回的结果码，看不到具体是哪个帧出了问题。

> **关于固件的角色**：所有 802.11 帧都先经过固件——固件是网卡上的协处理器，是空口和 Host 驱动之间的**必经网关**。固件处理帧去重、ACK 回复（数据帧）、解密（已安装密钥时）、BA（Block Ack）重排序等工作。管理帧的内容解析（Auth/Assoc 的状态机逻辑）在 QCOM 平台上由固件自己完成——固件不只是一个"透传管道"，而是主动执行协议逻辑。不存在"直接绕过固件给驱动"的路径——所有帧都经过固件，区别只在于固件是"自处理"（QCOM 模式）还是"透传给 Host 驱动"（MTK 模式，见后续 MTK 驱动层连接执行篇）。

## 2.2 CM 状态机：5 个主状态 + 子状态

![QCOM CM 状态机 — Connecting 子状态流转](assets/06c-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%B8%89%EF%BC%89QCOM-%E9%A9%B1%E5%8A%A8%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06c-qcom-cm-state.svg)

QCOM 连接管理的核心是 CM（Connection Manager）状态机，定义在 `wlan_cm_main.h`：

```c
// qca-wifi-host-cmn/umac/mlme/connection_mgr/core/src/wlan_cm_main.h

enum wlan_cm_sm_state {
    WLAN_CM_S_INIT = 0,          // 空闲默认状态
    WLAN_CM_S_CONNECTING = 1,    // 连接进行中
    WLAN_CM_S_CONNECTED = 2,     // 已连接
    WLAN_CM_S_DISCONNECTING = 3, // 断开进行中
    WLAN_CM_S_ROAMING = 4,       // 漫游进行中
    WLAN_CM_S_MAX = 5,           // 主状态上限

    // 子状态
    WLAN_CM_SS_IDLE = 6,                     // 空闲
    WLAN_CM_SS_JOIN_PENDING = 7,             // 连接请求排队中
    WLAN_CM_SS_SCAN = 8,                     // 扫描 SSID
    WLAN_CM_SS_JOIN_ACTIVE = 9,              // 连接请求已激活
    WLAN_CM_SS_PREAUTH = 10,                 // 漫游：预认证阶段
    WLAN_CM_SS_REASSOC = 11,                 // 漫游：重关联
    WLAN_CM_SS_ROAM_STARTED = 12,            // 漫游进行中（LFR 3.0）
    WLAN_CM_SS_ROAM_SYNC = 13,              // FW 漫游同步指示
    WLAN_CM_SS_IDLE_DUE_TO_LINK_SWITCH = 14, // Link switch 回到 INIT
    WLAN_CM_SS_MAX = 15,
};

```

这个枚举设计有两个要点：

- 主状态和子状态在同一个枚举中，通过数值范围区分（0-5 主状态，6-15 子状态）
- 一次典型连接的主状态路径：`INIT → CONNECTING → CONNECTED`
- `CONNECTING` 状态下，子状态路径：`JOIN_PENDING → SCAN → JOIN_ACTIVE`
- `ROAMING` 状态下的子状态路径：`PREAUTH → REASSOC → ROAM_STARTED`

> **状态定义了 CM 的骨架，事件定义了状态机如何在这个骨架上流转。** 下面的事件枚举列出了驱动状态机转换的所有触发条件——连接相关的事件有 13 个：

```c
// qca-wifi-host-cmn/umac/mlme/connection_mgr/core/src/wlan_cm_sm.h

enum wlan_cm_sm_evt {
    WLAN_CM_SM_EV_CONNECT_REQ = 0,           // 连接请求
    WLAN_CM_SM_EV_SCAN = 1,                  // 触发扫描
    WLAN_CM_SM_EV_SCAN_SUCCESS = 2,          // 扫描成功
    WLAN_CM_SM_EV_SCAN_FAILURE = 3,          // 扫描失败
    WLAN_CM_SM_EV_HW_MODE_SUCCESS = 4,       // 硬件模式切换成功
    WLAN_CM_SM_EV_HW_MODE_FAILURE = 5,       // 硬件模式切换失败
    WLAN_CM_SM_EV_CONNECT_START = 6,         // 连接启动
    WLAN_CM_SM_EV_CONNECT_ACTIVE = 7,        // 连接激活
    WLAN_CM_SM_EV_CONNECT_SUCCESS = 8,       // 连接成功
    WLAN_CM_SM_EV_BSS_SELECT_IND_SUCCESS = 9,// BSS 选择指示成功
    WLAN_CM_SM_EV_BSS_CREATE_PEER_SUCCESS = 10, // BSS peer 创建成功
    WLAN_CM_SM_EV_CONNECT_GET_NEXT_CANDIDATE = 11, // 尝试下一候选
    WLAN_CM_SM_EV_CONNECT_FAILURE = 12,      // 连接最终失败
    // ...漫游、断开相关事件省略...
};

```

从事件定义中可以看出两个关键设计：

- 事件名清晰地表达了状态机的每一步转换
- `EV_CONNECT_GET_NEXT_CANDIDATE` 是重试机制的入口——这个事件不像名字听起来那么"温和"，它意味着当前候选失败了，要换下一个
- 事件 0-12 覆盖了连接从请求到最终成功/失败的完整路径

**状态机完整流转——一次连接的生命周期**：

下表将 CM 状态机的状态、事件和处理函数串联起来，展示一次典型连接（成功路径 + 失败重试路径）的完整时序：

| 步骤 | 当前主状态             | 当前子状态         | 触发事件                        | 处理函数                                                     | 做了什么                                                     |
| ---- | ---------------------- | ------------------ | ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | INIT                   | IDLE               | `EV_CONNECT_REQ`                | `cm_connect_start()`                                         | 校验模式 → 通知 if_mgr → `cm_connect_get_candidates()` 检查缓存 |
| 2    | CONNECTING             | JOIN_PENDING       | `EV_SCAN`                       | `cm_connect_scan_start()`                                    | 缓存未命中 → 调 `cm_fill_scan_req()` 填参数 → `wlan_scan_start()` 发起扫描 |
| 3    | CONNECTING             | JOIN_PENDING       | `EV_SCAN_SUCCESS`               | `cm_connect_scan_resp()`                                     | 扫描返回 → 缓存候选 BSS → 序列化排队                         |
| 4    | CONNECTING             | JOIN_PENDING       | `EV_CONNECT_ACTIVE`             | `cm_connect_active()`                                        | **选候选**：`cm_get_valid_candidate()` 按 RSSI 选最佳 AP → 通知 OSIF → `cm_create_bss_peer()` 给固件建 peer |
| 5    | CONNECTING             | JOIN_ACTIVE        | —（LIM 消息）                   | `lim_send_join_req()` → `lim_process_switch_channel_join_req()` | **探路**：进入 `eLIM_MLM_WT_JOIN_BEACON_STATE` → 发单播 Probe Req → 等 Beacon/ProbeRsp |
| 6    | CONNECTING             | JOIN_ACTIVE        | —（固件内部）                   | 固件 Auth/Assoc                                              | LIM join 成功后 → 固件自动执行 Auth + Assoc 帧交换           |
| 7a   | CONNECTING → CONNECTED | JOIN_ACTIVE → IDLE | `EV_CONNECT_SUCCESS`            | 固件返回 `WMI_VDEV_START_RESP_EVENTID`(success)              | 连接成功 → EAPOL 四次握手                                    |
| 7b   | CONNECTING             | JOIN_ACTIVE        | `EV_CONNECT_GET_NEXT_CANDIDATE` | `cm_try_next_candidate()`                                    | **重试**：固件返回失败 → `cm_connect_rsp()` 检查原因 → 如果还有候选则投递此事件 |
| 8b   | CONNECTING             | JOIN_ACTIVE        | —                               | `cm_get_valid_candidate()` + `cm_create_bss_peer()`          | `cm_try_next_candidate()` 内部获取新候选 → 建新 peer → 固件重试（回步骤 5） |
| 9b   | CONNECTING             | JOIN_ACTIVE        | `EV_CONNECT_FAILURE`            | `mlme_cm_connect_complete_ind()`                             | 候选全部耗尽 → 通知上层连接失败                              |

> 这张表是整个 QCOM 驱动连接流程的**地图**。后续 2.3-2.5 节的每个代码段都在为某个步骤提供源码级别的证据。当你迷失在某段代码中时，回来看这张表定位"我现在在哪一步"。

**失败重试的完整事件链**（步骤 7b→8b 展开）：

```
固件返回 WMI_VDEV_START_RESP_EVENTID(status=fail)
  → cm_connect_rsp()                      [wlan_cm_connect.c]
    → 检查 fail_reason（CM_AUTH_FAILED / CM_ASSOC_FAILED / CM_JOIN_TIMEOUT...）
    → cm_sm_deliver_event_sync(EV_CONNECT_GET_NEXT_CANDIDATE)  ← 事件投递
      → cm_try_next_candidate()            [wlan_cm_connect.c:2432]
        → cm_get_valid_candidate()         ← 从候选列表选下一个 AP
        → cm_create_bss_peer()             ← 重建 peer，固件重试 Auth/Assoc
        （候选全部用完时：→ EV_CONNECT_FAILURE → mlme_cm_connect_complete_ind()）

```

## 2.3 完整调用链——从 NL80211 到固件返回

当 `NL80211_CMD_CONNECT` 到达内核后，QCOM 驱动的完整处理路径如下：

![QCOM WiFi 源码分析 — 连接全流程](assets/06c-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%B8%89%EF%BC%89QCOM-%E9%A9%B1%E5%8A%A8%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06c-qcom-call-flow.svg)

下面这张表把 NL80211 命令落地后经过的每个关键节点串起来，展示各层各自的职责：

| 节点                                                         | 层    | 职责                                |
| ------------------------------------------------------------ | ----- | ----------------------------------- |
| `wlan_hdd_cfg80211_connect()`                                | HDD   | cfg80211 回调入口，获取 vdev 锁     |
| `osif_cm_connect()`                                          | OS IF | 翻译 Linux 参数为 QCOM 内部格式     |
| `cm_sm_deliver_event()`                                      | CM    | 状态机单线程入口，加锁投递事件      |
| `cm_connect_active()`                                        | CM    | JOIN_ACTIVE 子状态，选候选、建 peer |
| `WMI_VDEV_START_REQUEST_CMDID` / `WMI_VDEV_START_RESP_EVENTID` | 固件  | Auth/Assoc 帧交换，返回结果         |

下面是每个关键函数的源码和解读。

### 2.3.1 入口：`wlan_hdd_cfg80211_connect()` —— cfg80211 回调

这是内核 cfg80211 框架调用的 `.connect` 回调，位于 HDD 层，是一个薄封装：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_cfg80211.c

static int wlan_hdd_cfg80211_connect(struct wiphy *wiphy,
                     struct net_device *ndev,
                     struct cfg80211_connect_params *req)
{
    int errno;
    struct osif_vdev_sync *vdev_sync;

    errno = osif_vdev_sync_op_start(ndev, &vdev_sync);
    if (errno)
        return errno;

    errno = wlan_hdd_cm_connect(wiphy, ndev, req);

    osif_vdev_sync_op_stop(vdev_sync);

    return errno;
}

```


这个函数的职责很简单——获取 vdev 同步锁（`osif_vdev_sync_op_start`），保证同一 vdev 上的操作不会并发，然后将全部工作委托给 `wlan_hdd_cm_connect()`，释放锁后返回结果。

### 2.3.2 连接编排：`wlan_hdd_cm_connect()` —— 校验与编排

这是 `wlan_hdd_cfg80211_connect()` 委托的核心函数，位于 HDD 层的连接管理文件。相比入口函数的薄封装，`wlan_hdd_cm_connect()` 承担了大量前置校验和状态重置工作。这些工作分三个阶段——先做环境检查（确保设备和 regulatory domain 就绪），再获取 vdev 资源并清零旧连接的状态残留，最后组装参数、委托给下层：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_cm_connect.c

int wlan_hdd_cm_connect(struct wiphy *wiphy,
                        struct net_device *ndev,
                        struct cfg80211_connect_params *req)
{
    int status;
    struct wlan_objmgr_vdev *vdev;
    struct osif_connect_params params;
    struct hdd_adapter *adapter = WLAN_HDD_GET_PRIV_PTR(ndev);
    struct hdd_context *hdd_ctx;
    struct hdd_station_ctx *hdd_sta_ctx;

    // 校验设备模式——只有 STA 和 P2P-Client 允许连接
    if (adapter->device_mode != QDF_STA_MODE &&
        adapter->device_mode != QDF_P2P_CLIENT_MODE) {
        hdd_err("Device_mode %s(%d) is not supported",
                qdf_opmode_str(adapter->device_mode),
                adapter->device_mode);
        return -EINVAL;
    }

    hdd_ctx = WLAN_HDD_GET_CTX(adapter);
    status = wlan_hdd_validate_context(hdd_ctx);
    if (status)
        return status;

    // 等待国家码变更完成——Regulatory Domain 就绪后才能连接
    hdd_reg_wait_for_country_change(hdd_ctx);

```

第一阶段的检查全部通过后，驱动才确信"当前环境允许发起连接"。设备模式检查确保不会在 SAP（热点）模式下误发 STA 连接请求——那会导致状态混乱。`wlan_hdd_validate_context()` 验证驱动全局上下文未被卸载（如 rmmod 过程中），`hdd_reg_wait_for_country_change()` 则阻塞等待 Regulatory Domain 就绪——如果国家码尚未设定，WiFi 芯片不知道当前地区允许哪些信道和发射功率，此时发起的连接可能非法占用频道。这三项检查是"连接的前置条件"，缺一不可。

环境检查全部通过意味着驱动确信当前状态允许发出连接请求——但确信还不够，接下来要做的不是直接通知固件，而是先把连接请求本身的准备工作做完。

连接请求本身还差最后一道工序：vdev 资源的准备与旧状态的清理。这是连接流程中容易被忽视但不出问题则已、一出问题就是"幽灵状态"的环节——如果上一次连接的 PTK/GTK 密钥标记还残留在 vdev 上，新的四次握手会误判密钥已安装，导致 EAPOL-Key 3/4 帧被静默丢弃。

因此 `wlan_hdd_cm_connect()` 在委托执行之前必须完成三件事：获取 vdev 引用、清零连接状态标记、注册 wakelock 防止休眠。下面看具体实现：

```c
    // 获取 vdev 引用并清零上一个连接的状态标记
    vdev = hdd_objmgr_get_vdev_by_user(adapter, WLAN_OSIF_CM_ID);
    if (!vdev)
        return -EINVAL;

    hdd_sta_ctx = WLAN_HDD_GET_STATION_CTX_PTR(adapter);

    // 重置 PTK/GTK 安装状态——避免旧连接密钥残留
    hdd_sta_ctx->conn_info.gtk_installed = false;
    hdd_sta_ctx->conn_info.ptk_installed = false;
    adapter->last_disconnect_reason = 0;

    // 注册 wakelock 防止系统在连接过程中休眠
    qdf_runtime_pm_prevent_suspend(&hdd_ctx->runtime_context.connect);

    // 组装 OSIF 连接参数（RSNE override、dot11mode filter、scan IE 等）
    params.force_rsne_override = hdd_ctx->force_rsne_override;
    hdd_update_scan_ie_for_connect(adapter, &params);
    hdd_update_action_oui_for_connect(hdd_ctx, req);

    // 通知连接开始（打点统计）
    wlan_hdd_connectivity_event_connecting(hdd_ctx, req, adapter->vdev_id);

    // 进入 OSIF 层——开始参数翻译
    status = osif_cm_connect(ndev, vdev, req, &params);

    // 失败或触发漫游时释放 wakelock
    if (status || ucfg_cm_is_vdev_roaming(vdev)) {
        qdf_runtime_pm_allow_suspend(&hdd_ctx->runtime_context.connect);
    }

    hdd_objmgr_put_vdev_by_user(vdev, WLAN_OSIF_CM_ID);
    return status;
}

```

总结这段逻辑，`wlan_hdd_cm_connect()` 做了四件事——前置检查、状态清理、wakelock 管理和委托执行——每一项都不可省略：

- **前置校验**：设备模式检查（只允许 STA/P2P-Client）、上下文有效性、国家码就绪、DFS 并发冲突检测、6GHz 频段可用性等——这些前置检查缺一不可（代码块精简了部分检查，如 DFS 并发和 6GHz 可用性判断）
- **状态重置**：清零 PTK/GTK 安装标记和上一次断开原因，确保新连接不受旧状态污染
- **wakelock 管理**：获取 vdev 引用后注册连接期间的 wakelock，防止系统在 Auth/Assoc 过程中进入休眠——成功后由后续事件释放，失败时立即释放
- **参数组装**：填充 `osif_connect_params`（RSNE override、dot11mode 过滤、scan IE 等），供 `osif_cm_connect()` 使用。其中 `bssid_hint` 和 `channel` 两个关键字段控制候选 AP 的过滤范围（详见下文）
- **委托执行**：最终调用 `osif_cm_connect()` 进入 OS IF 层，开始参数翻译和 CM 状态机投递。`osif_cm_connect()` 结束后 vdev 引用立即释放——连接成功与否由后续状态机事件异步通知，调用者无法从返回值判断连接结果

`bssid_hint`（来自 `req->bssid`）和 `channel`（来自 `req->channel`）是 `osif_connect_params` 中两个关键的候选过滤维度，它们直接决定了 `cm_get_valid_candidate()` 的搜索范围：

| 字段         | 来源           | 指定时的行为                                                 | 不指定时的行为（默认） |
| ------------ | -------------- | ------------------------------------------------------------ | ---------------------- |
| `bssid_hint` | `req->bssid`   | `cm_get_valid_candidate()` 只匹配该特定 BSSID，跳过同 SSID 的其他 AP | 匹配同 SSID 的所有 AP  |
| `channel`    | `req->channel` | Connect Scan 仅扫描该信道（减少扫描时间，但缩小候选池）      | 扫描所有已配置信道     |

若两者均为 NULL/0，扫描所有已配置信道、匹配同 SSID 的所有 AP——这是最常见的默认行为。

HDD 层的职责到此为止——它做完了 Linux 内核上下文相关的所有校验和准备。接下来的 `osif_cm_connect()` 位于 OSIF（OS Interface）层，这是从内核 API 到 QCOM 内部世界的关键翻译点。

上面是 Linux 的 `struct cfg80211_connect_params`（包含 net_device、wiphy、IE blob 等内核结构），下面是 QCOM 的平台无关内部结构 `struct wlan_cm_connect_req`（包含 BSSID、SSID、信道、加密参数等纯 WiFi 字段）。OSIF 层存在的意义就是把"内核怎么描述这次连接请求"翻译成"CM 状态机怎么理解这次连接请求"——这个翻译一旦完成，后续所有模块（CM、序列化、SME、固件）都只跟 QCOM 内部结构对话，不再看到任何 Linux 内核数据结构。

`wlan_hdd_cfg80211_connect()` 是门房（收件），`wlan_hdd_cm_connect()` 是前台经理（校验一遍、填表、通知安保准备），`osif_cm_connect()` 才是真正开始翻译客人信息的接待员。

### 2.3.3 参数翻译：`osif_cm_connect()` —— Linux 参数到内部结构

OS 接口层负责将 Linux 的 `cfg80211_connect_params` 翻译为 QCOM 内部格式 `wlan_cm_connect_req`：

```c
// qca-wifi-host-cmn/os_if/linux/mlme/src/osif_cm_req.c

int osif_cm_connect(struct net_device *dev, struct wlan_objmgr_vdev *vdev,
            const struct cfg80211_connect_params *req,
            const struct osif_connect_params *params)
{
    struct wlan_cm_connect_req *connect_req;
    // ... 变量声明省略 ...

    // ... bssid_hint 回退逻辑和 ht/vht_caps_mask 拷贝省略 ...

    // 提取 BSSID
    if (req->bssid)
        qdf_mem_copy(bssid.bytes, req->bssid, QDF_MAC_ADDR_SIZE);

    // 分配连接请求结构
    connect_req = qdf_mem_malloc(sizeof(*connect_req));
    if (!connect_req)
        return -ENOMEM;

    connect_req->vdev_id = vdev_id;
    connect_req->source = CM_OSIF_CONNECT;

```

这段代码完成了两件事：分配内部数据结构，标记请求来源。`qdf_mem_malloc()` 申请 `wlan_cm_connect_req` 结构体——这是 QCOM 驱动内部连接请求的核心容器，从这一刻起，后续所有 CM 层模块都通过这个结构体读取连接参数，不再接触 Linux 内核数据结构。`vdev_id` 标识当前操作的虚拟接口（STA 模式下通常为 0），`source = CM_OSIF_CONNECT` 则标记本次连接由 OSIF 层发起——状态机后续会根据来源区分 OSIF 连接、漫游重连、MLO 链路切换三种场景，走不同的处理分支。

结构体已分配、身份已标记。接下来往容器里装具体参数——要连哪个 AP、哪个网络、哪个信道：

```c
    // 设置 BSSID
    if (req->bssid)
        qdf_mem_copy(connect_req->bssid.bytes, req->bssid, QDF_MAC_ADDR_SIZE);

    // 设置 SSID（校验长度）
    connect_req->ssid.length = req->ssid_len;
    if (connect_req->ssid.length > WLAN_SSID_MAX_LEN) {
        ucfg_cm_free_connect_req(connect_req);
        return -EINVAL;
    }
    qdf_mem_copy(connect_req->ssid.ssid, req->ssid, connect_req->ssid.length);

    // 设置信道频率
    if (req->channel)
        connect_req->chan_freq = req->channel->center_freq;

```

三个字段中，SSID 校验是唯一可能失败的步骤——超长 SSID 直接释放已分配的 `connect_req` 并返回 `-EINVAL`。BSSID 和信道频率是可选的：Supplicant 不指定 `bssid_hint` 时 `req->bssid` 为 NULL，驱动跳过 BSSID 填充，交由后续的 `cm_get_valid_candidate()` 从扫描缓存中按 RSSI 自动选择最佳 AP；不指定 `channel` 时驱动扫描所有已配置信道。至此，基础字段翻译完成——BSSID、SSID、信道、连接来源，这四项构成了连接请求的"身份标识"，告诉 CM "要连哪个 AP、在哪个频段"。

基础字段翻译完成后，接下来是安全参数和 IE——这是 `osif_cm_connect()` 中最"重"的一块搬运工作。Supplicant 在发起连接前就已完成安全协商（选定加密套件、生成 PMKID），并将协商结果以 IE 的形式打包下发给驱动。**IE（Information Element）** 是 802.11 管理帧中携带的 TLV（Type-Length-Value）格式参数块——每个 IE 由一个元素 ID（1 字节）、长度（1 字节）、值（变长）组成。

Supplicant 在用户态根据所选网络的安全配置预构建好了一组 IE（包括 RSN/WPA IE、HT Capabilities IE、VHT Capabilities IE、HE Capabilities IE 等），打包为一个不透明的二进制数据块（blob），通过 NL80211 下发给驱动。驱动不解析、不修改 IE 内容，只做原样搬运——这是在 Supplicant 和 AP 之间建立一个不受驱动干扰的安全协商通道。如果驱动尝试解析或修改 IE，轻则连接失败（AP 校验不通过），重则引入安全漏洞（密钥协商被中间人篡改）。下面的代码负责把这些加密参数和 IE 从 Linux 格式搬运到 QCOM 内部结构 `wlan_cm_connect_req`：

```c
    // 设置加密参数
    status = osif_cm_set_crypto_params(connect_req, req);

    // 复制 HT/VHT capabilities
    connect_req->ht_caps = req->ht_capa.cap_info;
    connect_req->vht_caps = req->vht_capa.vht_cap_info;

    // 复制完整的 IE blob（Supplicant 拼好的 RSN/WPA IE 等）
    if (req->ie_len) {
        connect_req->assoc_ie.len = req->ie_len;
        connect_req->assoc_ie.ptr = qdf_mem_malloc(req->ie_len);
        qdf_mem_copy(connect_req->assoc_ie.ptr, req->ie, connect_req->assoc_ie.len);
    }

    // ... FILS/MLO partner 信息设置省略 ...

    status = mlo_connect(vdev, connect_req);  // 进入 CM 核心

connect_start_fail:
    ucfg_cm_free_connect_req(connect_req);
    return qdf_status_to_os_return(status);
}

```

这段代码完成的工作可以归为几类字段翻译——将 `cfg80211_connect_params` 的所有字段逐个映射到 `wlan_cm_connect_req`：BSSID、SSID、信道频率、加密参数、HT/VHT cap、IE blob。SSID 长度校验（不能超过 `WLAN_SSID_MAX_LEN`，通常 32 字节，符合 802.11 规范）是唯一可能在这里提前失败的点。标记 `source = CM_OSIF_CONNECT` 表示请求来源，最终调用 `mlo_connect()` 进入 CM 核心路径。

> **从 OSIF 到 CM 状态机的过渡**：`osif_cm_connect()` 末尾调用 `mlo_connect()`——这是 MLO（Multi-Link Operation）层的薄封装（内联函数，定义在 `wlan_mlo_mgr_sta.h:1086`），本质上调用 `wlan_cm_start_connect(vdev, req)`（定义在 `wlan_cm_api.c:34`），后者再调用 `cm_connect_start_req()`。`cm_connect_start_req()` 调用 `cm_sm_deliver_event(WLAN_CM_SM_EV_CONNECT_REQ)`，将连接请求以事件的形式投递给 CM 状态机。状态机查表后调用 `cm_connect_start()`，先检查扫描缓存、必要时发起 Connect Scan，拿到候选后再由 `cm_ser_connect_req()` 提交到 QCOM 的**序列化模块（Serialization）**排队——序列化模块的存在是为了防止多个 vdev 同时操作冲突（例如一个 vdev 正在断开，另一个 vdev 请求连接）。这个过程不是直接的函数调用，而是**异步事件投递**——理解这一点对于理解后续的重试机制非常重要：重试也是通过事件投递触发的，不是 `goto` 或循环调用。

> **完整传递链——从 OSIF 到 CM 状态机的 9 个节点**：把上面逐段展开的调用链压平看，从翻译参数到状态机真正激活，依次是这 9 步：
>
> ```
> osif_cm_connect()                    ← OS 接口层翻译参数
> └→ mlo_connect()                  ← MLO 薄封装（内联函数，直接转发）
>     └→ wlan_cm_start_connect()   ← CM API 入口，校验状态
>          └→ cm_connect_start_req() ← 投递 EV_CONNECT_REQ 事件
>               └→ cm_connect_start()   ← 检查候选，必要时发起扫描
>                    └→ cm_ser_connect_req() ← 提交请求到序列化模块
>                         └→ Serialization 排队   ← 防止多 vdev 并发冲突
>                              └→ EV_CONNECT_ACTIVE ← 激活事件（cm_ser_connect_cb 投递）
>                                   └→ cm_connect_active()  ← 选候选、建 peer
> ```

### 2.3.4 状态机入口：`cm_sm_deliver_event()` —— 加锁投递

状态机是所有连接操作的单线程入口——所有事件必须通过这个函数投递：

```c
// qca-wifi-host-cmn/umac/mlme/connection_mgr/core/src/wlan_cm_sm.c

QDF_STATUS cm_sm_deliver_event(struct wlan_objmgr_vdev *vdev,
                   enum wlan_cm_sm_evt event,
                   uint16_t data_len, void *data)
{
    QDF_STATUS status;
    enum QDF_OPMODE op_mode = wlan_vdev_mlme_get_opmode(vdev);
    struct cnx_mgr *cm_ctx;

    // 只有 STA 和 P2P-Client 模式才走 CM
    if (op_mode != QDF_STA_MODE && op_mode != QDF_P2P_CLIENT_MODE) {
        return QDF_STATUS_E_NOSUPPORT;
    }

    cm_ctx = cm_get_cm_ctx(vdev);
    if (!cm_ctx)
        return QDF_STATUS_E_FAILURE;

    cm_lock_acquire(cm_ctx);
    status = cm_sm_deliver_event_sync(cm_ctx, event, data_len, data);
    cm_lock_release(cm_ctx);

    return status;
}

```

`cm_sm_deliver_event()` 做了三件事：

- 模式校验：只处理 STA 和 P2P-Client 模式的 vdev
- 获取 per-vdev 的 `cnx_mgr` 上下文
- 加锁后调用 `cm_sm_deliver_event_sync` 同步投递事件——这把锁保证了所有状态机操作串行化
- 这是 QCOM CM 状态机设计的核心：**单线程事件循环**，所有连接/断开/漫游操作都通过同一把锁串行化

**锁的底层实现**：`cm_lock_acquire()` 内部调用 `qdf_spin_lock_bh(&cm_ctx->sm.cm_sm_lock)`（`wlan_cm_sm.h:197`）——这是一个 **bottom-half spinlock**（基于 Linux 的 `spin_lock_bh`），持锁期间不仅禁用内核抢占，还禁用 softirq（包括 NAPI、timer 等下半部）。选择 bh spinlock 而非普通 spinlock 的原因在于 WiFi 驱动的 RX 数据路径运行在 softirq（NAPI）上下文中——如果 EAPOL 帧到达时正好 CM 状态机在更新 `cnx_mgr`，没有 bh 保护的普通 spinlock 会导致死锁。`cm_lock_release()` 对应调用 `qdf_spin_unlock_bh()` 释放锁并恢复 softirq。

**同步投递 = 无消息队列**：`cm_sm_deliver_event_sync()`（`wlan_cm_sm.h:327`）内部调用 `wlan_sm_dispatch()`——这是一次**同步函数调用**，不经过任何消息队列。状态机直接查转移表、调 handler、返回结果。这与常见的事件循环模型（event posted to queue → async dispatch）不同——QCOM 选择同步投递是因为状态机 handler 执行路径极短（O(1) 查表 + 函数调用，无阻塞 I/O），用消息队列反而增加延迟和内存开销。

**调用链速查表——从 NL80211 到状态机激活的 7 步传递**：

| 步骤 | 函数                                                    | 职责                                                        |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------- |
| 1    | `wlan_hdd_cfg80211_connect()`                           | cfg80211 回调入口，收下 `NL80211_CMD_CONNECT`               |
| 2    | `wlan_hdd_cm_connect()`                                 | 连接编排：校验参数、选择 CM ID                              |
| 3    | `osif_cm_connect()`                                     | 参数翻译：`cfg80211_connect_params` → `wlan_cm_connect_req` |
| 4    | `mlo_connect()` / `wlan_cm_start_connect()`             | MLO 薄封装 → CM API 入口                                    |
| 5    | `cm_connect_start_req()`                                | 投递 `EV_CONNECT_REQ` 事件，进入状态机                      |
| 6    | `cm_sm_deliver_event_sync()` → `cm_connect_start()`     | 检查候选 → 必要时扫描 SSID                                  |
| 7    | `cm_ser_connect_req()` → `wlan_serialization_request()` | 提交到序列化模块排队 → 激活后 `EV_CONNECT_ACTIVE`           |

> **从事件到激活的路径**：`cm_sm_deliver_event_sync()` 收到 `WLAN_CM_SM_EV_CONNECT_REQ` 后，查阅状态转移表——当前主状态为 `WLAN_CM_S_CONNECTING`、子状态为 `WLAN_CM_SS_JOIN_PENDING`（连接请求刚入队）。状态机触发 `cm_connect_start()`（定义在 `wlan_cm_connect.c:1913`）——这个函数负责在必要时发起连接专用扫描（Connect Scan），扫描完成后将请求提交序列化模块排队。当序列化模块判定可以激活时，投递 `WLAN_CM_SM_EV_CONNECT_ACTIVE` 事件，子状态从 `JOIN_PENDING` 切换到 `WLAN_CM_SS_JOIN_ACTIVE`，此时 `cm_connect_active()` 被调用。总结路径：**EV_CONNECT_REQ → cm_connect_start（扫描+排队）→ EV_CONNECT_ACTIVE → cm_connect_active（选候选+建 peer）**。

如果把前面的 `osif_cm_connect()` 比作前台填写入住登记表，那 `cm_sm_deliver_event()` 就是前台**把登记表塞进内部传讯管道**（序列化排队+事件投递）——管道保证了每次只有一张登记表在处理，不会出现两张表搞混房间号的情况。现在到了 `cm_connect_active()`，安保公司正式接管：前台已经核对了客人名单、选好了最佳人选，只差最后一步——告诉安保公司"就这位客人，开始办入住"。

### 2.3.5 连接激活：`cm_connect_active()` —— JOIN_ACTIVE 子状态

当连接请求经过序列化模块排队后最终被激活，状态机投递 `WLAN_CM_SM_EV_CONNECT_ACTIVE` 事件，子状态从 `JOIN_PENDING` 切换到 `JOIN_ACTIVE`，`cm_connect_active()` 被调用。这是 host 侧在连接流程中的"最后一棒"——它要完成三件事：通知接口管理器连接已激活、从扫描缓存中选出最佳候选 AP、为选中的候选创建 BSS peer 对象交给固件。peer 创建成功之后，host 侧的主动工作就结束了，剩下的 Auth/Assoc 帧交换由固件全权代理。进入 `cm_connect_active()` 的具体逻辑。函数首先通知接口管理器、查找本次连接请求的上下文、记录激活时间戳——这些是"起手势"，为后续的重量级操作铺路：

```c
// qca-wifi-host-cmn/umac/mlme/connection_mgr/core/src/wlan_cm_connect.c

QDF_STATUS cm_connect_active(struct cnx_mgr *cm_ctx, wlan_cm_id *cm_id)
{
    struct cm_req *cm_req;
    QDF_STATUS status;
    struct wlan_cm_connect_req *req;

    status = cm_if_mgr_inform_connect_active(cm_ctx->vdev);  // ← 通知 if_mgr 连接已激活，触发接口状态更新

    cm_ctx->active_cm_id = *cm_id;
    cm_req = cm_get_req_by_cm_id(cm_ctx, *cm_id);
    if (!cm_req) {
        cm_remove_cmd_from_serialization(cm_ctx, *cm_id);
        return QDF_STATUS_E_INVAL;
    }
    if (QDF_IS_STATUS_ERROR(status))
        goto connect_err;

    cm_req->connect_req.connect_active_time =
                qdf_mc_timer_get_system_time();
    req = &cm_req->connect_req.req;
    wlan_vdev_mlme_set_ssid(cm_ctx->vdev, req->ssid.ssid, req->ssid.length);

```

`cm_if_mgr_inform_connect_active()` 的通知是单向的——告诉接口管理器"连接已进入激活状态"，接口管理器据此更新内部状态标记，但不返回任何审批意见。`cm_get_req_by_cm_id()` 通过 cm_id 从全局请求表中查找本次连接的请求上下文，如果查找失败说明请求已被异常清除（例如上层在连接过程中直接 tear down 了 vdev），此时从序列化模块中移除该命令并返回错误。激活时间戳 `connect_active_time` 记录的是 host 侧认为"连接正式开始"的时刻——它是后续 25 秒总时限（`CM_CONNECT_MAX_ACTIVE_TIME`）计算的起点，`cm_is_time_allowed_for_connect_attempt()` 据此判断是否还允许尝试下一个候选（15 秒的单候选超时另由序列化模块的 `cmd_timeout_duration` 计时，与此无关）。

起手势完成、SSID 已挂载到 vdev。接下来连接前的安全准备——清空旧密钥残留、为新连接配置加密参数：

```c
    // 连接前释放 vdev 旧密钥
    if (!wlan_vdev_mlme_is_mlo_link_vdev(cm_ctx->vdev)) {
        mlme_cm_osif_connect_active_notify(wlan_vdev_get_id(cm_ctx->vdev));
        if (!wlan_cm_check_mlo_roam_auth_status(cm_ctx->vdev))
            wlan_crypto_free_vdev_key(cm_ctx->vdev);
    }
    // ... MLO bridge vdev check and bmap set omitted ...
    cm_fill_vdev_crypto_params(cm_ctx, req);
    cm_store_wep_key(cm_ctx, req, *cm_id);

```

旧密钥清理 (`wlan_crypto_free_vdev_key`) 是连接前的关键一步。如果一个 vdev 上次连接时安装了 PTK/GTK 密钥但未正常清除（比如上次断开时 Supplicant 崩溃），新连接的四次握手会失败——因为固件侧的硬件密钥表中残留的旧密钥会干扰新密钥的协商和安装。MLO link vdev 跳过此步骤是因为它的密钥由 MLO 主 vdev 统一管理，子 link 不需要独立清理。`cm_fill_vdev_crypto_params()` 将 `osif_cm_connect()` 阶段翻译好的加密参数（AKM suite、cipher suite、PMKID 等）写入 vdev 的 crypto 上下文，`cm_store_wep_key()` 仅对 WEP 网络生效——WPA/WPA2/WPA3 网络的密钥在后续的四次握手中动态协商，不需要此步骤。

环境准备完毕。现在进入 `cm_connect_active()` 最核心的决策——从扫描缓存中挑选最佳候选 AP，并为其创建 BSS peer：

```c
    // 获取有效候选 AP —— 从扫描缓存中按 RSSI 排序选出最佳候选，检查 SSID/安全参数匹配
    status = cm_get_valid_candidate(cm_ctx, cm_req, NULL, NULL);
    if (QDF_IS_STATUS_ERROR(status))
        goto connect_err;

    // 发送 BSS 选择指示
    status = cm_send_bss_select_ind(cm_ctx, &cm_req->connect_req);

    // 如果上层不支持 BSS select indication，直接创建 peer
    if (status == QDF_STATUS_E_NOSUPPORT) {
        status = cm_update_vdev_mlme_macaddr(cm_ctx, &cm_req->connect_req);
        if (QDF_IS_STATUS_ERROR(status))
            goto connect_err;
        cm_create_bss_peer(cm_ctx, &cm_req->connect_req);  // ← 创建 BSS peer 对象（固件侧连接上下文），内部构建 WMI_PEER_CREATE_CMDID 发给固件
    } else if (QDF_IS_STATUS_ERROR(status)) {
        goto connect_err;
    }

    return QDF_STATUS_SUCCESS;

connect_err:
    return cm_send_connect_start_fail(cm_ctx,
                      &cm_req->connect_req, CM_JOIN_FAILED);
}

```

这三个阶段按顺序完成之后，代码向我们清晰地展示了一条"只进不退"的路径：激活时间戳启动超时倒计时 → 旧密钥清理防止状态污染 → 加密参数配置就位 → 候选人选出 → peer 创建完成。任何一步失败都走 `connect_err` 路径，投递 `CM_JOIN_FAILED`。

> `cm_connect_active()` 的核心流程可以用三个关键调用概括——**通知接口管理器**（`cm_if_mgr_inform_connect_active`）让上层知道连接已激活、**挑选最佳候选**（`cm_get_valid_candidate`）从扫描缓存中按 RSSI 排序选出匹配的 AP、**创建 BSS peer**（`cm_create_bss_peer`）在固件侧建立连接上下文。peer 创建成功后，固件自动接管后续的 Auth/Assoc 帧交换，Host 侧进入"等待结果"状态。这三个步骤按顺序执行，任何一步失败都会触发 `connect_err` 错误路径。

`cm_connect_active()` 的三个关键调用——通知接口管理器、挑选候选、创建 peer——完成之后，host 侧的连接筹备工作正式结束。这是一个清晰的分水岭：在此之前，host 驱动在选路、建 peer、填参数；在此之后，Auth/Assoc 帧交换完全交给固件，host 进入"等待结果"的被动模式。用酒店比喻来说：办入住登记这一环已经收工——填好的登记单从收银台滑进了后场，接下来轮到门童去开房门、核对床位（正是固件的 Auth/Assoc）。在这之前，收银台已经确保旧的房卡记录（vdev key）清空，不会和新入住搞混。但客人到底能不能成功入住，现在要看门童的了。

不过，`cm_create_bss_peer()` 发出 `WMI_PEER_CREATE_CMDID` 后，peer 并没有立刻"活过来"——它还要经历一段从创建到激活的生命周期，而这段生命周期直接决定了后续 Auth/Assoc 能否启动。`cm_create_bss_peer()` 分配好 `struct peer_info`（BSSID、AID、频段等参数）后，固件收到命令，在硬件 peer 表中分配一个 slot——这个 slot 包含了 Tx/Rx 队列、BA session、密钥空间等硬件资源。分配完成后，固件通过 `WMI_PEER_CREATE_CONF_EVENTID` 事件回传确认。Host 侧的 `cm_bss_peer_create_rsp()`（`wlan_cm_connect.c:3459`）接收到这个确认事件——创建请求由固件确认，peer 正式激活。确认成功则投递 `WLAN_CM_SM_EV_BSS_CREATE_PEER_SUCCESS`，状态机调用 `cm_resume_connect_after_peer_create()`，Auth/Assoc 帧交换由此正式启动；确认失败则意味着硬件 peer 表可能已满，走 `WLAN_CM_SM_EV_CONNECT_GET_NEXT_CANDIDATE` 换候选。这就是 `cm_connect_active()` 成功返回和"连接已建立"之间那段"真空期"的真实面貌：`cm_connect_active()` 返回只意味着 peer 的创建请求已提交给固件，而固件确认 peer 创建成功（`cm_bss_peer_create_rsp`）和 Auth/Assoc 成功（`WMI_VDEV_START_RESP_EVENTID`）是两个独立的事件，host 需要逐一等待。

至于 peer 的删除回收，发生在两个场景——正常断开时 `cm_bss_peer_delete_req()`（`wlan_cm_disconnect.c:944`）下发 `WMI_PEER_DELETE_CMDID` 释放硬件资源；异常超时或失败时，`cm_remove_cmd_from_serialization()`（`wlan_cm_util.c:684`）清理序列化命令，最终也是下发 `WMI_PEER_DELETE_CMDID`。两条路径殊途同归——peer 的硬件资源必须由 host 明确发出 delete 命令才能释放，不会因为超时自动回收，这也是为什么如果 host 崩溃而固件继续运行，残留的 peer 条目会导致后续连接时报 `peer_id exhausted` 错误。

## 2.4 连接前探路——两阶段单播 Probe Request

`cm_connect_active()` 完成后，Host 侧已经选定了最佳候选 AP 并创建了 BSS peer。但在 Auth 帧发送之前，还有一个关键的"敲门"步骤——确认目标 AP 确实可达。QCOM 为此设计了两阶段单播 Probe Request 机制：第一阶段由 CM 层在连接开始时执行（Connect Scan），第二阶段由 LIM 层在 join 命令下发后执行（Join Probe）。这两个阶段分别回答"候选 AP 在哪个频段"和"候选 AP 是否还活着"——前者选路，后者敲门，比"固件自动发一个广播 Probe"要精细得多。

### 阶段一：CM 的 Connect Scan（候选搜索）

当 CM 进入 `cm_connect_start()` 后，如果扫描缓存中没有目标 AP 的候选记录，`cm_connect_get_candidates()` 会决定触发一次连接专用扫描（Connect Scan）。它通过状态机投递 `WLAN_CM_SM_EV_SCAN` 事件，状态机查表后调用 `cm_connect_scan_start()`启动扫描。`cm_connect_scan_start()` 内部调用 `cm_fill_scan_req()` 填充扫描请求参数，然后通过 `wlan_scan_start()` 发起到固件的 WMI 扫描命令：

**调用链**：`cm_connect_start()` → `cm_connect_get_candidates()`（判断需扫描）→ 状态机投递 `EV_SCAN` → `cm_connect_scan_start()` → `cm_fill_scan_req()` → `wlan_scan_start()`

```c
// qca-wifi-host-cmn/umac/mlme/connection_mgr/core/src/wlan_cm_connect_scan.c

static QDF_STATUS cm_fill_scan_req(struct cnx_mgr *cm_ctx,
                                   struct cm_connect_req *cm_req,
                                   struct scan_start_request *req)
{
    // ... 省略 SSID、信道等字段填充 ...

    // 关键：显式关闭广播 Probe——只对目标 SSID 发单播 Probe
    req->scan_req.scan_f_bcast_probe = false;

    // 使用专门为连接场景配置的 scan_ie（拷贝到 extraie，作为 Probe Request 附加 IE）
    if (cm_req->req.scan_ie.len) {
        req->scan_req.extraie.ptr = qdf_mem_malloc(cm_req->req.scan_ie.len);
        qdf_mem_copy(req->scan_req.extraie.ptr, cm_req->req.scan_ie.ptr,
                     cm_req->req.scan_ie.len);
        req->scan_req.extraie.len = cm_req->req.scan_ie.len;
    }
}

```

这个函数的核心逻辑浓缩在两个关键设置中：

- `scan_f_bcast_probe = false` 是关键：这意味着 WMI 层的 `WMI_SCAN_ADD_BCAST_PROBE_REQ` 标志不会被设置，固件只对目标 SSID 发送单播 Probe Request，不做全信道广播
- 扫描结果通过 `cm_connect_scan_resp()` 返回，如果找到候选 AP 则进入序列化排队
- **扫描缓存为空的降级路径**：若 Connect Scan 返回零结果（目标 SSID 在所有已扫描信道均无响应），`cm_connect_scan_resp()` 检测到候选列表为空后，向 CM 状态机投递 `WLAN_CM_SM_EV_SCAN_FAILURE` 事件（`wlan_cm_sm.c:633`）。状态机查表后调用 `cm_connect_start()` 中的失败处理分支——该分支检查是否还有备用候选来源（如 `bssid_hint` 指定的 AP 在扫描前已缓存），若无则最终投递 `WLAN_CM_SM_EV_CONNECT_FAILURE`，连接在扫描阶段即宣告失败。这也是为什么某些环境中连接失败极快（< 5 秒的 `CM_SCAN_MAX_TIME`）——扫描阶段就没发现任何候选 AP。

### 阶段二：LIM 的 Join Probe（应答确认）

CM 发出 join 命令后，更底层的一步由 LIM（Logical Link Manager）层执行——这不是固件行为，而是 **Host 侧驱动的管理帧 TX**。

**调用链**：`cm_connect_active()` 创建 BSS peer 后，通过 SME → LIM 的消息队列发送 `LIM_MLM_JOIN_REQ` 消息。LIM 层的消息分发器 `lim_process_sme_req_messages()` 在 `lim_process_sme_req_messages.c` 中处理该消息，调用 `lim_send_join_req()` 组装 join 请求，最终在 `lim_process_mlm_rsp_messages.c` 的消息处理流程中触发 `lim_process_switch_channel_join_req()`。这是一个 **static 函数**，不对外暴露——外部通过消息类型 `LIM_MLM_JOIN_REQ` 间接调用。下面看这个函数的核心实现——它把 LIM 状态机推进到等待应答状态、启动超时定时器，然后立即发出第一个单播 Probe：

```c
// qcacld-3.0/core/mac/src/pe/lim/lim_process_mlm_rsp_messages.c

static void lim_process_switch_channel_join_req(struct mac_context *mac_ctx,
                                          struct pe_session *session_entry,
                                          QDF_STATUS status)
{
    // ... 省略信道切换逻辑 ...

    // 进入 WT_JOIN_BEACON_STATE——等待 Beacon 或 Probe Response
    session_entry->limMlmState = eLIM_MLM_WT_JOIN_BEACON_STATE;

    // 启动周期重试定时器——每 200ms 重发一次
    lim_deactivate_and_change_timer(mac_ctx, eLIM_PERIODIC_JOIN_PROBE_REQ_TIMER);

    // 启动 Join Failure 超时定时器（直接调用原始 tx_timer_activate API）
    tx_timer_activate(&mac_ctx->lim.lim_timers.gLimJoinFailureTimer);

    // 立即发送第一个单播 Probe Request 到目标 BSSID
    lim_send_probe_req_mgmt_frame(mac_ctx, &ssId, bssid, chan_freq, ...);  // 省略部分参数
}

```

**`lim_send_probe_req_mgmt_frame()` 的关键细节**：此函数为 static，LIM 层外部不可见——外部通过消息类型 `LIM_MLM_JOIN_REQ` 间接调用，此处展示行为描述而非函数体。它不是通过 WMI 扫描命令发送，而是直接构建 802.11 Probe Request 管理帧，填充目标 BSSID 作为 DA（目的地址），然后通过 `wma_tx_frame()` 发送原始管理帧——这是 QCOM LIM 层管理帧 TX 的标准方式，完全绕过了 WMI 扫描基础设施。

**200ms 周期重试机制**：

> **伪代码示意**：每 200ms 触发一次 `lim_process_periodic_join_probe_req_timer()`，重发单播 Probe Request，直到收到 Probe Response 或 Join Failure 定时器超时。
>
> 实际源码中，timer 初始化在 `lim_timer_utils.c` 使用 `tx_timer_create()` 创建 `gLimPeriodicJoinProbeReqTimer`，超时值取自 `mac->mlme_cfg->timeouts.probe_req_retry_timeout`（默认 `JOIN_PROBE_REQ_TIMER_MS` = 200ms）。后续激活由 `lim_process_mlm_rsp_messages.c` 中的 `lim_deactivate_and_change_timer(mac, eLIM_PERIODIC_JOIN_PROBE_REQ_TIMER)` 完成——先停止旧 timer，再以新超时值启动（定义在 `lim_timer_utils.c:483-684`，已验证）。

**响应处理**：当 Beacon 或 Probe Response 到达时，LIM 状态机检查当前是否在 `eLIM_MLM_WT_JOIN_BEACON_STATE`：

```c
// qcacld-3.0/core/mac/src/pe/lim/lim_process_probe_rsp_frame.c
// 简化版：省略帧解析与 IBSS 分支，保留 Join 状态判断的核心路径

void lim_process_probe_rsp_frame(struct mac_context *mac_ctx,
                                  uint8_t *rx_Packet_info,
                                  struct pe_session *session_entry)
{
    // ... 省略帧解析 ...

    if (session_entry->limMlmState == eLIM_MLM_WT_JOIN_BEACON_STATE) {
        // 验证 SSID 匹配后：
        // 1. 停止 Join Failure 定时器
        // 2. 停止 Periodic Probe Req 定时器
        // 3. 存储 Beacon/ProbeRsp 到 session_entry->beacon
        // 4. 调用 lim_check_and_announce_join_success()
        //    → 发送 LIM_MLM_JOIN_CNF 消息给 SME
        //    → SME 启动 Auth 帧交换
    }
}

```

收到 Probe Response 的这一瞬间，是 LIM 层的关键决策点。状态检查 `eLIM_MLM_WT_JOIN_BEACON_STATE` 限定了只有"正在等门铃应答"的 vdev 才处理这个帧——其他状态下收到的 Probe Response 不会被误认为 Join 成功。SSID 匹配验证确保应答来自目标 AP 而非碰巧同信道的其他网络。所有检查通过后，两个定时器停止（Join Failure 和 Periodic Probe Req 同时取消，因为它们的目标已经达成），Beacon 帧被存储到 session entry 中供后续 SME 使用，`lim_check_and_announce_join_success()` 通过内部消息 `LIM_MLM_JOIN_CNF` 通知 SME 层"Join 阶段完成，可以进入 Auth 了"。这条消息是 LIM 阶段到 Auth 阶段的桥梁——在你看到的时序图中，它就是那条从"单播 Probe"指向"Auth 帧交换"的箭头。

**完整的两阶段 Probe 时序**——把上面分散讲的两段串成一条时间线，上半段是 CM 层选路，下半段是 LIM 层敲门：

```
CM 层:   cm_connect_start() → cm_connect_scan_start()
           → WMI scan (scan_f_bcast_probe=false, 只针对目标 SSID)
             固件: 发单播 Probe Req → 等 Probe Resp
           → cm_connect_scan_resp() 拿到候选

LIM 层:  cm_connect_active() → create BSS peer
           → lim_process_switch_channel_join_req()
              eLIM_MLM_WT_JOIN_BEACON_STATE
              立即发送 lim_send_probe_req_mgmt_frame() → BSSID
              启动 200ms 周期重试定时器
                ├── 收到 ProbeRsp/Beacon → lim_check_and_announce_join_success()
                │     → 停止所有定时器 → 发送 LIM_MLM_JOIN_CNF → 进入 Auth
                └── 超时未响应 → Join Failure Timer 触发
                      → 停止 Probe 定时器 → 通知 CM 连接失败 → 换候选

```

> QCOM 的两阶段 Probe 就像在你真正去酒店之前做了两件事——（阶段一）用地图搜索确认酒店存在（CM connect scan），（阶段二）到了酒店门口按门铃确认有人值班（LIM join probe）。而且这门铃每 200ms 按一次——如果没人应答，耐心耗尽就报告"这家酒店没开门"，前台换下一家候选。门铃不是外包公司（固件）按的，是前台自己的员工（LIM 层 raw management frame TX）亲自按的。

两阶段 Probe 全部通过，意味着目标 AP 真实存在、信道畅通、能够应答。此时 host 侧已完成候选选择（`cm_get_valid_candidate`）和 BSS peer 创建（`cm_create_bss_peer`），固件侧收到了启动指令。下一步是固件全权代理的 Auth/Assoc 帧交换——但固件不是万能的。Auth 可能因为 PMKID 失效而失败，Assoc 可能因为 AP 满载而拒绝。QCOM 应对这种不确定性的策略不是"一次失败就放弃"，而是"换一个候选再试"。下面展开这套重试机制的完整逻辑。

## 2.5 AUTH/ASSOC 失败与重试——失败 → 重试 → 换候选

Auth/Assoc 并不总是成功，QCOM 的应对不是一次失败就放弃，而是「重试配置 + `cm_try_next_candidate()` 换候选 + 统一失败路径」——三个主题放在本节合并讲解，读者可以看到完整的异常处理全貌。回到酒店比喻：Auth/Assoc 失败就像前台派去某家酒店办入住，结果要么被安保拒之门外（reject），要么按了半天门铃没人应答（timeout）——前台不会干等，而是翻开候选名单，换下一家酒店重试。

在展开重试之前先交代一个背景：连接请求在进入 `cm_connect_active()` 之前要经过序列化模块的全局串行化。真正的提交点不在 `cm_connect_start_req()`（`wlan_cm_connect.c:3650`，它只投递 `EV_CONNECT_REQ` 事件），而在 `cm_connect_start()` 拿到候选之后的 static 函数 `cm_ser_connect_req()`（`wlan_cm_connect.c:241`）——它组装 `wlan_serialization_command` 结构体：`cmd_type = WLAN_SER_CMD_VDEV_CONNECT`、`cmd_cb = cm_ser_connect_cb`、`is_high_priority = false`、`is_blocking = true`、`cmd_timeout_duration = cm_ctx->connect_timeout`（在 `wlan_cm_main.c:104` 初始化为 `CM_MAX_PER_CANDIDATE_CONNECT_TIMEOUT`，即 15 秒），随后调用 `wlan_serialization_request()`（`wlan_cm_connect.c:280`）。序列化模块经 `wlan_serialization_is_active_non_scan_cmd_allowed()`（`wlan_serialization_non_scan.c:60`）判断——对 blocking 命令，它调用 `wlan_serialization_any_vdev_cmd_active()` 检查任意 vdev（而非仅限同一 vdev）上是否有活跃的连接/断开/start_bss/stop_bss 命令：有则新请求进入 `WLAN_SER_CMD_PENDING` 队列，无则进入 `WLAN_SER_CMD_ACTIVE`。于是整个芯片上任何时候只有一条连接相关命令在运行，无需考虑两个 vdev 同时连接的状态机冲突；代价是用户断开重连时可能正排在 pending 队列里等待当前命令超时。

QCOM 的连接重试由 Host 侧管理，配置常量如下：

```c
// qca-wifi-host-cmn/umac/mlme/connection_mgr/core/src/wlan_cm_main.h

#define CM_MAX_CONNECT_ATTEMPTS              10   // 最大连接尝试次数
#define CM_MAX_PER_CANDIDATE_CONNECT_TIMEOUT 15000 // 每候选超时 (ms)
#define CM_MAX_CANDIDATE_RETRIES             1    // 每候选最大重试
#define CM_SCAN_MAX_TIME                     5000 // 扫描超时 (ms)

```

重试流程：

1. **每个候选 AP 最多重试 1 次**（即失败后额外尝试 1 次，每个候选 AP 最多尝试 2 次；SAE 场景可通过 INI 配置更多）
2. **单个候选超时 15 秒**（包含 3s join + 5s auth + 2s assoc + 5s vdev 缓冲——此为按固件 join/auth/assoc/vdev 阶段耗时近似拆分，非源码常量直接定义）
3. **总共最多尝试 10 个候选 AP**（`CM_MAX_CONNECT_ATTEMPTS`）
4. **总连接时间限制约 25 秒**（由 `cm_is_time_allowed_for_connect_attempt()` 检查 `CM_CONNECT_MAX_ACTIVE_TIME`——从第 2 次尝试起，超过 25 秒就不再尝试下一个候选）

失败原因本身也分两类，理解「被拒」还是「无响应」对诊断和重试决策意义重大。固件在 Auth/Assoc 帧交换结束后，把结果码经 `lim_cm_get_fail_reason_from_result_code()`（`lim_send_sme_rsp_messages.c:539`）映射成 `enum wlan_cm_connect_fail_reason` 的 15 个枚举值（定义于 `wlan_cm_public_struct.h:411`），下表逐码列出含义与回退路径：

| fail reason                     | 含义                                                 | 回退路径                       |
| ------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `CM_NO_CANDIDATE_FOUND`         | 无候选 AP（扫描零结果或缓存无匹配）                  | 最终失败                       |
| `CM_ABORT_DUE_TO_NEW_REQ_RECVD` | 新请求到达导致中止                                   | 直接完成（新命令接管）         |
| `CM_BSS_SELECT_IND_FAILED`      | BSS select indication 失败                           | 换候选重试                     |
| `CM_PEER_CREATE_FAILED`         | peer 创建失败                                        | 换候选重试                     |
| `CM_JOIN_FAILED`                | join 状态失败（`cm_connect_active()` 同步错误）      | 最终失败                       |
| `CM_JOIN_TIMEOUT`               | join probe 无应答（单播 Probe 后无 Beacon/ProbeRsp） | 换候选（唯一候选可同候选重试） |
| `CM_AUTH_FAILED`                | Auth 被 AP 拒绝                                      | 换候选重试                     |
| `CM_AUTH_TIMEOUT`               | Auth 无应答                                          | 换候选重试                     |
| `CM_ASSOC_FAILED`               | Assoc 被 AP 拒绝                                     | 换候选重试                     |
| `CM_ASSOC_TIMEOUT`              | Assoc 无应答                                         | 换候选（SAE 可同候选重试）     |
| `CM_HW_MODE_FAILURE`            | HW 模式切换失败                                      | 最终失败                       |
| `CM_SER_FAILURE`                | 序列化命令提交失败                                   | 最终失败                       |
| `CM_SER_TIMEOUT`                | 序列化命令超时                                       | 直接最终失败（超时不换候选）   |
| `CM_GENERIC_FAILURE`            | 兜底通用失败                                         | 最终失败                       |
| `CM_VALID_CANDIDATE_CHECK_FAIL` | 候选校验失败                                         | 跳过此候选，试下一个           |

这 15 个码归为两条路线——**换候选重试**（固件在超时前主动返回失败 → `cm_connect_rsp()` 投递 `EV_CONNECT_GET_NEXT_CANDIDATE` → `cm_try_next_candidate()`）和**最终失败**（`cm_send_connect_start_fail()` 直接投递 `EV_CONNECT_FAILURE`）。其中「被拒 vs 无响应」的区分最关键：**reject**（`CM_AUTH_FAILED`/`CM_ASSOC_FAILED`）说明 AP 可达且主动回绝——诊断看固件日志里 Assoc 拒绝帧携带的 802.11 Status Code（如 17 AP 满载、42 RSN IE 不匹配），此时换下一个 AP 是正确决策，同一个 AP 大概率还会拒绝；**timeout**（`CM_JOIN_TIMEOUT`/`CM_AUTH_TIMEOUT`/`CM_ASSOC_TIMEOUT`）说明 AP 根本没应答——问题在 RF 可达性（信号弱、信道拥塞、AP 已关机），诊断看信号环境而非 Status Code，而且 timeout 可能是瞬时的，`cm_is_retry_with_same_candidate()`（`wlan_cm_connect.c:1033`）会在唯一候选、SAE、assoc-timeout 重连 OUI 等场景下允许重试同一候选，而不是机械地跳到下一个。

> **超时触发机制**：15 秒的单候选超时由 host 侧序列化模块的 `active_cmd_timeout` 检测——超时到达后，序列化模块不再等待固件响应，触发命令回调 `cm_ser_connect_cb()`（`wlan_cm_connect.c:174`）的 `WLAN_SER_CB_ACTIVE_CMD_TIMEOUT` 分支，调用 `cm_connect_cmd_timeout()`（`wlan_cm_connect.c:67`）。该函数用 `cm_fill_failure_resp_from_cm_id()` 以 `CM_SER_TIMEOUT` 填充失败原因，然后直接投递 `WLAN_CM_SM_EV_CONNECT_FAILURE` 事件——**超时不走换候选重试**，直接判定本次连接失败。换候选只在固件于超时前主动返回失败时发生：`cm_connect_rsp()` 检查失败原因后投递 `WLAN_CM_SM_EV_CONNECT_GET_NEXT_CANDIDATE`，触发 `cm_try_next_candidate()`。固件侧残留的 peer 资源通过 `cm_remove_cmd_from_serialization()`（定义在 `wlan_cm_util.c:684`）在序列化命令清理时一并释放。因此 host 侧 dmesg 中看到的失败原因可能是 `CM_SER_TIMEOUT`（单候选超时被序列化模块检测到），也可能是 `CM_AUTH_FAILED` / `CM_ASSOC_FAILED`（固件在超时前主动返回了失败）——后者的超时时间通常小于 15 秒。

**调用触发链**：`cm_try_next_candidate()` 不是被直接函数调用的，而是通过 CM 状态机的事件投递机制触发的——当固件返回 `WMI_VDEV_START_RESP_EVENTID` 且 status 为失败时，host 侧的 `cm_connect_rsp()` 处理响应；如果还有候选 AP 且未超过重试上限（`CM_MAX_CONNECT_ATTEMPTS`），`cm_connect_rsp()` 投递 `WLAN_CM_SM_EV_CONNECT_GET_NEXT_CANDIDATE` 事件；状态机查表后调用 `cm_try_next_candidate()`。这个事件驱动的调用链在下文的 Auth/Assoc 失败流程图中已展示，此处聚焦 `cm_try_next_candidate()` 本身的实现。

`cm_connect_rsp()`（`wlan_cm_connect.c:3332`）是固件响应的第一个处理者——它只做三件事，不执行任何重试逻辑本身：

```
cm_connect_rsp(vdev, resp)
  1. 获取 cm_ctx → 校验 cm_id 匹配（防止过期响应干扰）
  2. 根据 resp->connect_status 决定投递哪个事件：
     ├── 成功 → 清除 SAE single PMK 缓存 → 投递 EV_CONNECT_SUCCESS
     └── 失败 → 检查 resp->status_code：
           ├── STATUS_INVALID_PMKID → 删除对应 PMKSA（避免下次还用失效 PMKID）
           └── 通用失败 → 投递 EV_CONNECT_GET_NEXT_CANDIDATE

```

重试的"编排"不在 `cm_connect_rsp()` 中——它只负责判断结果并投递事件。真正执行换候选的是下文的 `cm_try_next_candidate()`。这种"判断与执行分离"的设计让两个函数各司其职：`cm_connect_rsp()` 是裁判（判定成败 + 按失败原因做清理），`cm_try_next_candidate()` 是执行者（换人重试 + 通知上层）。

`cm_try_next_candidate()` 的源码（文件 `wlan_cm_connect.c:2432`）：

```c
// qca-wifi-host-cmn/umac/mlme/connection_mgr/core/src/wlan_cm_connect.c

QDF_STATUS cm_try_next_candidate(struct cnx_mgr *cm_ctx,
                                 struct wlan_cm_connect_resp *resp)
{
    QDF_STATUS status;
    struct cm_req *cm_req;
    bool same_candidate_used = false;

    // 1. 找回当前连接请求上下文
    cm_req = cm_get_req_by_cm_id(cm_ctx, resp->cm_id);
    if (!cm_req)
        return QDF_STATUS_E_FAILURE;

    // 2. 获取下一个有效候选——same_candidate_used 标志是否还是同一个 BSS
    status = cm_get_valid_candidate(cm_ctx, cm_req, resp, &same_candidate_used);
    if (QDF_IS_STATUS_ERROR(status))
        goto connect_err;  // 候选用完 → 投递 EV_CONNECT_FAILURE

    // 3. 如果是全新候选（不是同一个 BSS 重试），通知 OSIF 层上一个候选已失败
    if (!same_candidate_used) {
        cm_store_first_candidate_rsp(cm_ctx, resp->cm_id, resp);
        mlme_cm_osif_failed_candidate_ind(cm_ctx->vdev, resp);
    }

    // 4. 更新序列化 timer，适配新候选的超时窗口
    cm_update_ser_timer_for_new_candidate(cm_ctx, resp->cm_id);

    // 5. 为新候选创建 BSS peer → 固件重试 Auth/Assoc
    cm_create_bss_peer(cm_ctx, &cm_req->connect_req);

    return QDF_STATUS_SUCCESS;

connect_err:
    // 候选全部用完 → 投递连接最终失败事件
    return cm_sm_deliver_event_sync(cm_ctx, WLAN_CM_SM_EV_CONNECT_FAILURE,
                                    sizeof(*resp), resp);
}

```

`cm_try_next_candidate()` 的精妙之处在于两个判断：

- `cm_get_valid_candidate()` 返回错误 = 候选列表耗尽，直接投递 `EV_CONNECT_FAILURE` 停止重试
- `same_candidate_used`：如果前一个候选连接失败后 `cm_get_valid_candidate` 返回的还是同一个 BSS（比如 SAE 场景中只配了一个 AP 但允许多次尝试），则不通知 OSIF——避免误刷掉扫描缓存中的该 AP
- 代码块省略了 `cm_send_bss_select_ind()` 条件分支——成功时走 BSS select indication 路径（上层可干预候选选择），上层不支持时走 fallback 直接调用 `cm_create_bss_peer()` 创建 peer
- 候选成功后路径与 `cm_connect_active()` 尾段一致：`cm_create_bss_peer()` 创建 peer 对象 → 固件重新执行 Auth/Assoc

了解了重试配置和 `cm_try_next_candidate()` 的机制后，下面看具体的失败场景。

### 2.5.1 AUTH 失败——换下一个候选

当固件返回 Auth 失败时，状态机按以下路径处理：

```
固件: Auth 失败 (WMI_VDEV_START_RESP_EVENTID, status=fail)
  → cm_connect_rsp()  // 检查失败原因
    → 若 STATUS_INVALID_PMKID → 删除 PMKSA 缓存
    → 投递 WLAN_CM_SM_EV_CONNECT_GET_NEXT_CANDIDATE
      → cm_try_next_candidate()  // 尝试下一个候选 AP
        ├── 还有候选 → 重新 cm_create_bss_peer → 固件重试
        └── 候选用完 → WLAN_CM_SM_EV_CONNECT_FAILURE
          → mlme_cm_connect_complete_ind()  // 通知上层连接最终失败
            → hdd_cm_connect_failure() → cfg80211_connect_result()
              → Framework 收到 CONNECTION_FAILED 广播

```

> **最终失败后的清理路径**：当 `mlme_cm_connect_complete_ind()` 被调用时（`wlan_cmn_mlme_main.c:418`），驱动执行以下步骤回收资源——① 通过 `osif_cm_connect_comp_ind()`（`osif_cm_util.c:769`）通知 OSIF 层连接已完成（失败），② `hdd_cm_connect_complete()`（`wlan_hdd_cm_connect.c:1595`）释放 vdev 上的残留密钥（`wlan_crypto_free_vdev_key()`）、停止 join 相关定时器，③ `cm_remove_cmd_from_serialization()`（`wlan_cm_util.c:684`）从序列化模块中移除该连接命令，④ `qdf_runtime_pm_allow_suspend()` 释放连接 wakelock（对应 `wlan_hdd_cm_connect()` 中注册的 `qdf_runtime_pm_prevent_suspend`），⑤ 最终通过 `cfg80211_connect_result()`（`bss=NULL`）通知内核无线框架连接失败，Framework 收到 `CONNECTION_FAILED` 广播。这 5 步按顺序执行，确保 vdev 回到 `WLAN_CM_S_INIT` 状态，可以接受下一次连接请求。

### 2.5.2 ASSOC 失败——同样的重试机制

Assoc 失败的处理流程与 Auth 失败几乎完全一致。固件返回失败后，host 侧同样通过 `cm_connect_rsp()` 判断失败原因，投递 `EV_CONNECT_GET_NEXT_CANDIDATE` 重试。

不同的是 Assoc 被拒时，AP 会在 Assoc Response 帧中携带具体的 **Status Code**（802.11-2024 规范 §9.4.1.9），这些状态码比 Auth 的状态码更有诊断价值：

| Status Code | 含义                            | 常见场景           |
| ----------- | ------------------------------- | ------------------ |
| 17          | AP is full / Association denied | AP 连接数达到上限  |
| 42          | Invalid RSN IE                  | RSN 信息元素不匹配 |
| 11          | Unsupported capability          | 密码套件不支持     |
| 12          | Reassociation denied            | 重关联被拒绝       |

> 这些状态码并不会直接出现在 QCOM host 侧的 dmesg 中——它们藏在固件日志的 Assoc Response 帧里。host 侧能看到的只是 `cm_connect_rsp()` 中的 `fail_reason` 字段，具体的 Status Code 必须从固件日志中提取。

> 不论 Auth 失败还是 Assoc 失败，QCOM 都走同一条路径——`cm_connect_rsp()` 检查失败原因 → 投递 `EV_CONNECT_GET_NEXT_CANDIDATE` → `cm_try_next_candidate()` 换候选 → 最多 10 个候选。这条路径是事件驱动的，不是直接函数调用。理解这一点，排查 QCOM 连接失败问题时就知道：host 侧 dmesg 只能看到 `cm_connect_rsp()` 的失败原因码（`CM_AUTH_FAILED` / `CM_ASSOC_FAILED` 等），具体是哪个帧出了问题需要在固件日志中查找（下一节展开）。

> **断开请求在连接进行中的行为**（`wlan_cm_disconnect.c:657-777` + `wlan_cm_sm.c` 子状态 handler）：当 CM 状态机处于 `WLAN_CM_S_CONNECTING` 主状态时，只有来自 OSIF/CFG/MLO link vdev 的断开请求会被接受——south bound 或 peer 触发的断开被直接拒绝（返回 `E_INVAL`）。三个子状态的处理方式不同：
>
> - **JOIN_ACTIVE**（`wlan_cm_sm.c:917-928`）：`cm_handle_discon_req_in_non_connected_state()` 在 JOIN_ACTIVE 路径直接 break——Auth/Assoc 已交由固件执行，host 侧无需取消任何操作，只需登记断开请求然后转移状态到 `WLAN_CM_S_DISCONNECTING`，投递 `DISCONNECT_START`。
> - **SCAN**（`wlan_cm_sm.c:785-796`）：先 `cm_vdev_scan_cancel()` 取消扫描，然后 fallthrough 到 JOIN_PENDING 处理。
> - **JOIN_PENDING**（`wlan_cm_sm.c:679-690`）：`cm_handle_discon_req_in_non_connected_state()` 用 `CM_SOURCE_INVALID` 通知 OSIF 层（避免旧 flush 发送错误通知到内核），然后 `cm_flush_pending_request()` 清空所有未决的 connect/disconnect 请求，再转移状态并启动断开。
>
> 三种子状态下，**断开请求从不等待连接完成**——用户"点了断开就一定会断开"的预期被状态机优先保证。代价是 JOIN_ACTIVE 子状态下连接流程被静默放弃：固件侧可能仍有残留的 Auth/Assoc 帧在空中传输，但这些帧对应的 peer 资源在 host 侧通过后续的 `cm_remove_cmd_from_serialization()` 在序列化命令清理时一并回收。

## 2.6 QCOM Auth/Assoc 日志——固件侧看帧交换

前面的正常流程（Probe → Auth/Assoc）和异常流程（失败 → 重试）都讲完了，本节是诊断工具：当连接出问题时，去哪里看日志、能看到什么级别的信息。

QCOM 的 Auth/Assoc 帧交换日志不在 host 侧 dmesg 中，而在固件侧的日志系统中。因为 Auth/Assoc 帧由固件内部收发，host 侧只能看到 WMI 命令和事件的上下文。

这些固件日志的来源是 dbglog 机制：固件内部的 SME 模块把 Auth/Assoc 帧交换过程打成 `[SME]` 前缀的调试串，通过 `WMI_DEBUG_PRINT_EVENTID` 事件上报给 host；host 侧 WMA 层的 `wma_unified_debug_print_event_handler()`（`wma_utils.c:3339`）收到后统一用 `wma_debug("FIRMWARE:%s", ...)` 打印出来。这套 dbglog 通道与 host 侧 `mlme_err()`/`mlme_debug()` 的 `CM_PREFIX_FMT` 日志是两条独立的链路——帧级细节走前者，连接流程状态走后者。抓取入口有两处：`[SME]` 调试串经 `WMI_DEBUG_PRINT_EVENTID` 上报后由 host 打印进 dmesg（`FIRMWARE:` 前缀）是一处；更完整的结构化 dbglog 由 `dbglog_init()`（`dbglog_host.c:4538`）初始化的 debugfs 只读节点 `cld/dbglog_block` 导出原始数据，另有 `wmi_diag_event_id` 对应的 DIAG 通道供专用诊断工具采集。日常排查连接失败优先看 dmesg 里的 `FIRMWARE:` 行，要还原完整帧交换时序则需从 dbglog 节点或 DIAG 通道抓固件日志。

在固件日志中可以看到类似以下模式的帧交换记录：

**Auth 发送/接收**（固件日志）：

```
[SME] Auth frame sent to XX:XX:XX:XX:XX:XX, alg=0, seq=1
[SME] Auth frame received from XX:XX:XX:XX:XX:XX, alg=0, seq=2, status=0

```

**Assoc 发送/接收**（固件日志）：

```
[SME] Assoc request sent to XX:XX:XX:XX:XX:XX
[SME] Assoc response received from XX:XX:XX:XX:XX:XX, status=0, aid=1

```

**Auth 失败**（固件日志，`status` 非 0 即失败，本例为 802.11 状态码 1「未指定失败」）：

```
[SME] Auth frame received from XX:XX:XX:XX:XX:XX, alg=0, seq=2, status=1

```

在 host 侧 dmesg 中，QCOM 驱动通过 `mlme_err()`/`mlme_debug()` 等宏输出日志（格式前缀为 `CM_PREFIX_FMT`）。

下面的日志模式是依据 qcacld-3.0 中 `mlme_err()`/`mlme_debug()` 宏的输出格式重构的示意（非真实日志字符串，以 `CM_PREFIX_FMT` 为前缀，实际输出与示意有所不同）：

典型的日志模式（示意）：

**连接开始**：

```
msg at wlan_cm_connect.c:1913 (cm_connect_start): Connect start for vdev 0

```

**连接成功**：

```
msg at wlan_hdd_cfg80211.c (hdd_cm_connect_success): Connect success event received

```

**连接失败**：

```
msg at wlan_cm_connect.c (cm_connect_rsp): Connect failed, reason=CM_AUTH_FAILED

```

> 排查 QCOM 设备的 Auth/Assoc 问题时，host 侧 dmesg 只能告诉你连接失败了、失败原因是 `CM_AUTH_FAILED` / `CM_ASSOC_FAILED` / `CM_JOIN_TIMEOUT` 等。但具体是 Auth 还是 Assoc 阶段失败、AP 返回的 Status Code 是多少，这些关键信息藏在固件的 `WMI_VDEV_START_RESP_EVENTID` response 结构体中，host 侧不会打印到 dmesg——你必须从固件日志中提取。

## 2.7 Auth/Assoc 后的保密通道——EAPOL 帧透传

Auth/Assoc 完成后，连接在 802.11 层面已经建立——STA 和 AP 可以交换数据帧了。但在 WPA2/WPA3 的场景下，此时所有数据帧都还是明文：**还需要四次握手（4-Way Handshake）来协商加密密钥**。

四次握手的载体是 EAPOL 帧（EtherType `0x888E`），它们是**数据帧而非管理帧**——对驱动和固件来说，EAPOL 帧和普通的 IP 数据包走的是同一条数据通道（Data Path），只是 EtherType 不同。

值得注意的是，管理帧（Auth/Assoc）由 SM（Session Manager）/SME 模块专门处理，有独立的状态机和帧构建函数；而 EAPOL 帧走的是数据面——QCOM 驱动通过 cfg80211 的 Control Port 接口在 Supplicant 和固件之间透传。

### 2.7.1 EAPOL 发送路径（TX）

Supplicant 通过 nl80211 的控制端口接口发送 EAPOL 帧。Control Port 是 cfg80211 框架提供的专用旁路通道——与标准网络协议栈的 `netif_rx`/`dev_queue_xmit` 不同，Control Port 绕过了 TCP/IP 协议栈，直接将 EAPOL payload 从用户态 Supplicant 传递到驱动层的 TX 数据路径。这种设计确保 EAPOL 帧在 IP 路由表尚未建立（连接尚未完成、IP 地址尚未分配）的阶段就能发送——四次握手的前两帧（EAPOL-Key 1/2）正是在这个阶段发出的。驱动收到的是一段纯 payload（不含以太网头），需要自己构建以太网帧封装。下面先看 SKB 的分配和 payload 的写入——这是帧构建的第一步：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_cfg80211.c

static int __wlan_hdd_cfg80211_tx_control_port(struct wiphy *wiphy,
                        struct net_device *dev,
                        const u8 *buf, size_t len,
                        const u8 *src, const u8 *dest,
                        __be16 proto, bool unencrypted)
{
    qdf_nbuf_t nbuf;
    struct ethhdr *ehdr;
    struct hdd_adapter *adapter = WLAN_HDD_GET_PRIV_PTR(dev);

    // 分配 skb + 预留以太网头空间
    nbuf = dev_alloc_skb(len + sizeof(struct ethhdr));
    if (!nbuf)
        return -ENOMEM;

    // 填充 payload → 回推以太网头 → 填 MAC 地址
    skb_reserve(nbuf, sizeof(struct ethhdr));
    skb_put_data(nbuf, buf, len);

```

`dev_alloc_skb` 分配一个 Linux 网络缓冲区（SKB），容量是 payload 长度 + 以太网头大小（14 字节）。`skb_reserve` 在 buffer 头部预留 14 字节空间——这个技巧让后续的 `skb_push` 可以直接在 payload 前面插入以太网头，而不需要内存拷贝。`skb_put_data` 将 Supplicant 传来的 EAPOL payload 原样拷贝到 SKB 的数据区。至此，buffer 中只有 payload，以太网头位置是空的。

接下来构建以太网帧头——目的 MAC、源 MAC、协议类型，三步走：

```c
    // qcacld-3.0/core/hdd/src/wlan_hdd_cfg80211.c (continued)
    ehdr = skb_push(nbuf, sizeof(struct ethhdr));
    qdf_mem_copy(ehdr->h_dest, dest, ETH_ALEN);
    if (!src || qdf_is_macaddr_zero((struct qdf_mac_addr *)src))
        qdf_mem_copy(ehdr->h_source, adapter->mac_addr.bytes, ETH_ALEN);
    else
        qdf_mem_copy(ehdr->h_source, src, ETH_ALEN);
    ehdr->h_proto = proto;

```

`skb_push` 将数据指针向前移动 14 字节，在 payload 前面"推出"一段空间作为以太网头。`qdf_mem_copy` 是 QCOM 封装的 `memcpy`。目的 MAC 直接用 Supplicant 传来的目标地址（即 AP 的 BSSID），源 MAC 有一个回退逻辑：如果 Supplicant 未指定源地址（NULL 或全零），则回退为 adapter 自身的 MAC 地址。协议类型 `h_proto` 由调用者指定——对于 EAPOL 帧，这是 `ETH_P_PAE`（0x888E）。

帧已完整构建。最后一步：绕过内核 TCP/IP 协议栈，直接提交到 Wi-Fi 芯片的 TX 数据路径：

```c
    // 通过标准网络设备接口 ndo_start_xmit 提交到 TX 数据路径 → 固件 → 空口
    nbuf->dev = dev;
    nbuf->protocol = htons(ETH_P_PAE);
    skb_reset_network_header(nbuf);
    skb_reset_mac_header(nbuf);

    netif_tx_lock(dev);
    skb_set_queue_mapping(nbuf, hdd_wmm_select_queue(dev, nbuf));
    dev->netdev_ops->ndo_start_xmit(nbuf, dev);
    netif_tx_unlock(dev);

    return 0;
}

```

这段代码展示了 Control Port 与标准网络数据路径的分合关系。`nbuf->protocol = htons(ETH_P_PAE)` 标识这是 EAPOL 帧——下游的 DP（Data Path）层据此区分 EAPOL 和普通 IP 数据包，走不同的快速通道。`hdd_wmm_select_queue` 选择 WMM 队列（EAPOL 帧通常走 Voice 或 Best Effort 队列，取决于驱动配置），`ndo_start_xmit` 是 Linux 网络设备的标准发送入口——从这一步开始，EAPOL 帧汇入驱动的主 TX 数据路径，与普通 IP 数据包走同一条硬件发送通道，最终由固件通过空口发出。

这个函数展示了 EAPOL TX 路径的完整链路：Supplicant 提供 payload → 驱动构建以太网头 → 绕过 IP 协议栈 → 直接提交到 Wi-Fi TX 数据路径。`unencrypted` 参数控制固件侧的加密行为——四次握手的前两帧（EAPOL-Key 1/2）以明文发出（此时密钥尚未协商），后两帧和后续数据帧由固件按已安装的 PTK/GTK 加密。

### 2.7.2 EAPOL 接收路径（RX）

EAPOL 帧的接收路径与 TX 方向对称——帧从空口到达 AP 后，经过以下链路到达 Supplicant：

> **RX 数据路径——从空口到 Supplicant**：
>
> ```
> 空口 → 固件解密（如已安装密钥）
> → DMA 传输 → Host 内存
>  → NAPI poll（软中断调度，DP 层 RX 处理）
>    → 协议识别：`ETH_P_PAE`（0x888E）
>      → wlan_hdd_cfg80211_rx_control_port()
>        → cfg80211_rx_control_port()
>          → nl80211 → Supplicant（wpa_supplicant_rx_eapol()）
> ```

当 AP 发来的 EAPOL 帧到达网卡，固件解密后（如果已安装密钥）将其送入 Host 侧的数据 RX 路径。驱动识别出 `ETH_P_PAE` 协议类型后，通过 `cfg80211_rx_control_port()` 送给 Supplicant：

```c
// QCOM qcacld-3.0/core/hdd/src/wlan_hdd_cfg80211.c

bool wlan_hdd_cfg80211_rx_control_port(struct net_device *dev,
                       const u8 *ta_addr,
                       struct sk_buff *skb,
                       bool unencrypted)
{
    // 调用 cfg80211 API 将 EAPOL 帧上报给用户态 supplicant
    return cfg80211_rx_control_port(dev, ta_addr, skb, unencrypted);
}

```

这个薄封装的职责：驱动收到 EAPOL 帧后（通过 `ETH_P_PAE` 识别），不经过网络协议栈，直接通过 `cfg80211_rx_control_port()` 上报。Supplicant 收到后由 `wpa_supplicant_rx_eapol()` 处理（已在 Supplicant 连接决策篇中 EAPOL 帧处理部分详细展开）。

### 2.7.3 密钥安装——WPA_COMPLETED 的最后一步

四次握手在 Supplicant 中完成后，最后一步是将协商好的 PTK（Pairwise Transient Key）和 GTK（Group Temporal Key）安装到硬件中。Supplicant 通过 `NL80211_CMD_NEW_KEY` / `NL80211_CMD_SET_KEY` 下发密钥：

```c
// QCOM qcacld-3.0/core/hdd/src/wlan_hdd_cfg80211.c

static int __wlan_hdd_cfg80211_add_key(struct wiphy *wiphy,
                      struct net_device *ndev,
                      u8 key_index, bool pairwise,
                      const u8 *mac_addr,
                      struct key_params *params, int link_id)
{
    struct hdd_adapter *adapter = WLAN_HDD_GET_PRIV_PTR(ndev);
    struct hdd_context *hdd_ctx = WLAN_HDD_GET_CTX(adapter);
    struct wlan_objmgr_vdev *vdev;
    mac_handle_t mac_handle = hdd_ctx->mac_handle;
    int errno;

    vdev = hdd_objmgr_get_vdev_by_user(adapter, WLAN_OSIF_ID);
    if (!vdev)
        return -EINVAL;

    // 委托给 wlan_hdd_add_key_vdev() 执行实际密钥安装
    errno = wlan_hdd_add_key_vdev(mac_handle, vdev, key_index,
                                   pairwise, mac_addr, params,
                                   link_id, adapter);

    hdd_objmgr_put_vdev_by_user(vdev, WLAN_OSIF_ID);
    return errno;
}

```

这段代码做了两件核心的事：`__wlan_hdd_cfg80211_add_key()` 是薄封装——获取 vdev 引用后委托给 `wlan_hdd_add_key_vdev()`（定义于同一文件 `wlan_hdd_cfg80211.c:21907`）执行实际密钥安装。`wlan_hdd_add_key_vdev()` 内部通过 `wma_update_set_key()`（void 函数，4 参数）标记密钥就绪，触发 WMA 层密钥响应（`wma_send_set_key_rsp` → `WMA_SET_STAKEY_RSP`/`WMA_SET_BSSKEY_RSP`），最终由 WMI 层转换为 `WMI_VDEV_INSTALL_KEY_CMDID` 下发固件。密钥分为 pairwise key（PTK，单播加密）和 group key（GTK，广播/组播加密）。

> **两层安装，含义截然不同**：Supplicant 内部的 `wpa_supplicant_process_3_of_4()`（`wpa.c:2714`）是**软件层面**——确认密钥正确可用并记录到内部状态；`NL80211_CMD_NEW_KEY` 是**硬件层面**——将密钥编程到 WiFi 芯片的硬件密钥表中，此后固件才真正对数据帧启用加解密。

**完整的 EAPOL 透传与密钥安装时序**如下：

![EAPOL 四次握手 + 密钥安装时序](assets/06c-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%B8%89%EF%BC%89QCOM-%E9%A9%B1%E5%8A%A8%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06c-eapol-sequence.svg)

Auth/Assoc 结束相当于安保验证和前台登记都完成了，但这只是"可以进入酒店大堂"——还没有拿到房卡。EAPOL 四次握手就是"发房卡"的过程：酒店和客人互相确认对方是真实的（ANonce/SNonce 交换），然后客人拿到一张加密的房卡（PTK），酒店还给了一张公共区域的通行证（GTK）。驱动层的 Control Port 就是房卡传递的"投递管道"——驱动不参与制卡（那是 Supplicant 的事），但负责把卡片准确地送到对方手里。

---

# 3 总结

本篇拆解了 QCOM 平台在驱动层执行完整 L2 连接的流程——从单播 Probe Request 探路，到 Auth/Assoc 帧交换，到 EAPOL 四次握手的驱动透传，一直到密钥安装完成。

1. **QCOM 的"固件全权代理"模式**：Host 侧通过 CM 状态机管理连接生命周期（5 主状态 + 子状态），从 `osif_cm_connect()` 翻译参数、序列化模块排队、`cm_connect_active()` 激活连接、`cm_create_bss_peer()` 创建 peer 后，固件自行完成 Probe Req → Auth/Assoc 帧交换。Host 侧全程不碰 802.11 帧——它的角色是"监工"，不是"执行者"。

2. **调用链的核心是异步事件投递**：从 `wlan_hdd_cfg80211_connect()` 收到命令，到 `cm_connect_active()` 激活——中间经过了 7 步传递，其中序列化模块排队和 CM 状态机事件投递是关键环节。理解"事件投递而非直接调用"对读懂重试机制至关重要（重试也是通过事件触发，不是循环）。

3. **EAPOL 走数据面，不走管理面**：EAPOL 帧（EtherType `0x888E`）作为特殊的数据帧，通过 cfg80211 的 Control Port 接口在 Supplicant 和固件之间透传。TX 走 `__wlan_hdd_cfg80211_tx_control_port()` + `ndo_start_xmit`，RX 走 `wlan_hdd_cfg80211_rx_control_port()` + `cfg80211_rx_control_port()`。驱动不参与四次握手的协议逻辑（那是 Supplicant 的活），密钥安装通过 `WMI_VDEV_INSTALL_KEY_CMDID` 下发固件。

4. **重试机制由 Host 侧编排**：最多 10 个候选 AP，每个候选 15 秒超时。在 `connect_scan` → `cm_get_valid_candidate` → `cm_create_bss_peer` 循环中，任何一个候选失败（`CM_AUTH_FAILED` / `CM_ASSOC_FAILED` / `CM_JOIN_TIMEOUT`）后自动换下一个候选继续尝试，直到全部用完才上报最终失败。

在本篇中，我们完整走了一遍 QCOM 酒店的入住流程——前台（HDD 层）接到客人需求（`NL80211_CMD_CONNECT`），填好入住登记表（`osif_cm_connect` 翻译参数），通过内部传讯管道（序列化排队 + CM 状态机事件投递）把登记表送到外包安保公司（固件）。安保公司接单后，自己派侦察员确认酒店位置（单播 Probe），然后亲自验证客人身份证（Auth）、分配房间号（Assoc），最后把结果报告回前台。Auth/Assoc 结束后，客人和酒店通过加密对讲机（Control Port + EAPOL 四次握手）协商出一张加密房卡（PTK/GTK），房卡密码写入门锁系统（`WMI_VDEV_INSTALL_KEY_CMDID`）——此后所有进出（数据帧）都需要刷加密房卡。QCOM 的前台始终只是一个"监工"角色——管流程、不亲自动手，这正是 QCOM 固件全权代理模式的精髓。

> **MTK 平台见后续 MTK 驱动层连接执行篇**：MTK 走的是一条完全不同的路——驱动亲自下场，AIS FSM（17 状态）和 SAA FSM（8 状态）两层状态机控场，每一步 Auth/Assoc 帧交换都在 Host 侧可见。这种"外包安保 vs 自营安保"的对比，正是后续篇章的核心看点。

> **802.11 规范引用**：Authentication 帧格式参见 IEEE 802.11-2024 §9.3.3.11，Association Request 帧格式参见 §9.3.3.5，Association Response 帧格式参见 §9.3.3.6，Authentication/Association 过程概述参见 §11.3，Status Code 定义参见 §9.4.1.9。EAPOL 协议帧格式参见 IEEE 802.1X-2020 §11.3，四次握手流程参见 IEEE 802.11-2024 §12.7.6。

本文代码引用自 QCOM 开源驱动 [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0) 与 [qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn)。
