---
title: P2P（六）Group Formation ——暗号对上了，正式建群
top: 1
related_posts: true
abbrlink: a4f20e75
date: 2026-09-24 22:44:01
tags:
  - Android WiFi
  - P2P
categories:
  - WiFi
  - Code
---

> WPS 暗号对上了——现在不是谈判"谁当老大"，而是真正"成立群组"。本文追踪从 WPS 成功到 GROUP_STARTED 广播的完整链路：GO 侧启动 Beacon 开张挂牌、接受 Client Auth/Assoc 报到、执行四次握手发群聊密钥、DHCP 分配群内编号；Client 侧关联 GO 领钥匙拿编号；驱动侧模式切换与 NOA 调度。

---

# 本章导读

上一篇（P2P（五）Provision Discovery + WPS）的结尾，暗号对上了——`p2p_wps_success_cb()` 清除了 GO Negotiation 的临时状态。但这只是 WPS 层面的"验证通过"，真正的"群组"还没成立。现在 GO 要挂牌营业（Beacon 发射）、接客登记（Auth/Assoc）、发群聊密钥（四次握手）、分配群内编号（DHCP IP）。Client 要像连普通 WiFi 一样连上 GO、领钥匙、拿编号。双方都完成这一切后，管理处（Framework）收到"群正式成立"的通知——`GROUP_STARTED` event。

<!--more-->

在相亲角的比喻里：暗号对上了说明你不是骗子，但你还站在门口。GO 要搬一张桌子坐下、挂上"我是老大，信道 X"的牌子（Beacon），Client 敲门报到（Auth/Assoc），GO 给来人一把群聊钥匙——这把钥匙不含"单聊密钥"，因为 GO 直接管理所有人，不需要上层 AP 中转（四次握手），然后给每个人分配一个群内编号（DHCP IP）。一切就绪后，管理处登记在册：谁是老大、老大坐哪（IP 地址）、这个群叫什么（WifiP2pGroup）——这就是 `WIFI_P2P_CONNECTION_CHANGED_ACTION` 广播里的内容。

本文从 WPS 成功（`wpas_p2p_wps_success()`）到 DHCP 完成、`GROUP_STARTED` 广播发送。不涉及后续的 Group 运维——Autonomous GO 跳过谈判直接建群、Persistent Group 秒重连、Service Discovery 群内发广告留给下一篇 P2P 文章。

在进入代码之前，先用一张全链路分层架构图建立整体方位感：本文的核心调用链从 GO Negotiation 完成（`wpas_go_neg_completed`）一路走到 IP 分配，Group Formation 的五个阶段——角色确定、组接口、WPS、四次握手、IP 分配——分布在 wpa_supplicant / 内核 / 驱动 / Framework 各层，跨层边界依次用 Binder、AIDL、nl80211 连接：

![P2P Group Formation 全链路分层架构](assets/11f-P2P%EF%BC%88%E5%85%AD%EF%BC%89Group-Formation-%E2%80%94%E2%80%94%E6%9A%97%E5%8F%B7%E5%AF%B9%E4%B8%8A%E4%BA%86%EF%BC%8C%E6%AD%A3%E5%BC%8F%E5%BB%BA%E7%BE%A4/11f-overview.svg)

# 1 WPS 成功了，然后呢？

WPS 八轮 EAP-WSC 消息交换完成，`wpas_p2p_wps_success()` 被调用（在 wpa_supplicant 的 WPS callback 中触发，与上一篇第 7 节的链条衔接）。这个函数做两件事：告诉 P2P 核心层"WPS 成功了"（`p2p_wps_success_cb()`），然后告诉 supplicant"Group Formation 可以收尾了"（`wpas_group_formation_completed()`）。

```c
// wpa_supplicant/p2p_supplicant.c:7444
void wpas_p2p_wps_success(struct wpa_supplicant *wpa_s, const u8 *peer_addr,
                           int registrar)
{
    struct wpa_ssid *ssid = wpa_s->current_ssid;

    if (!wpa_s->p2p_in_provisioning) {
        wpa_printf(MSG_DEBUG, "P2P: Ignore WPS success event - P2P "
                   "provisioning not in progress");
        return;
    }

    // ... Infrastructure mode 持久组处理 ...

    eloop_cancel_timeout(wpas_p2p_group_formation_timeout, wpa_s->p2pdev, NULL);

    if (ssid && ssid->mode == WPAS_MODE_INFRA) {
        // Client 侧：重启超时等待 (P2P_MAX_INITIAL_CONN_WAIT 秒)
        wpa_s->p2p_go_group_formation_completed = 0;
        // ... 注册超时 ...
    } else if (ssid) {
        // GO 侧：重启超时等待 (P2P_MAX_INITIAL_CONN_WAIT_GO 秒)
        wpa_s->p2p_go_group_formation_completed = 0;
        // ... 注册超时 ...
    }
    if (wpa_s->global->p2p)
        p2p_wps_success_cb(wpa_s->global->p2p, peer_addr);   // ① 通知 P2P 核心
    wpas_group_formation_completed(wpa_s, 1, 0);              // ② 完成 Group Formation
}
```

`p2p_wps_success_cb()`（`src/p2p/p2p.c:2949`）做的事很轻——验证一下 MAC 地址对得上，然后 `p2p_clear_go_neg(p2p)` 清掉 GO Negotiation 临时状态。真正的重头戏在 `wpas_group_formation_completed()`。

```c
// wpa_supplicant/p2p_supplicant.c:1395
static void wpas_group_formation_completed(struct wpa_supplicant *wpa_s,
                                           int success, int already_deleted)
{
    // ... 失败路径省略 ...

    wpa_msg_global(wpa_s->p2pdev, MSG_INFO,
                   P2P_EVENT_GROUP_FORMATION_SUCCESS);

    ssid = wpa_s->current_ssid;
    if (ssid && ssid->mode == WPAS_MODE_P2P_GROUP_FORMATION) {
        ssid->mode = WPAS_MODE_P2P_GO;                      // GO: 模式切换
        p2p_group_notif_formation_done(wpa_s->p2p_group);   // 更新 Beacon IE
        wpa_supplicant_ap_mac_addr_filter(wpa_s, NULL);
    }

    // ... persistent 判断省略 ...

    wpa_s->show_group_started = 0;
    if (client) {
        // Client: 不急着发 GROUP_STARTED，等四次握手完成
        wpa_s->show_group_started = 1;
    } else {
        // GO: 立即发 GROUP_STARTED event
        wpas_p2p_group_started(wpa_s, 1, ssid,
                               ssid ? ssid->frequency : 0,
                               // ... psk/passphrase/go_dev_addr ...
                               persistent, "");
        wpas_p2p_cross_connect_setup(wpa_s);
        wpas_p2p_set_group_idle_timeout(wpa_s);
    }
    // ...
}
```

这里有一个值得停下来看的分叉。GO 在 WPS 成功的瞬间就发送 `GROUP_STARTED` 通知——"我的群准备好了，谁来都行"。Client 却设置为 `show_group_started = 1`，要等到四次握手完成——"我得等钥匙拿到手才算真正进来了"——才真正发出通知。这解释了为什么 Framework 层收到 `GROUP_STARTED` 的时机在 GO 和 Client 两侧是不同的。

这个分叉不是凭空出现的——追到根上，它由 GO Negotiation 里确定的那个 `res->role_go` 比特位决定（上一篇文章《P2P（四）》讲的 `p2p_go_det()` 意愿值对比）。

这个比特位从谈判完成的那一刻起就开始级联：它决定接口类型——`wpa_supplicant` 按 `res->role_go` 建 `WPA_IF_P2P_GO` 还是 `WPA_IF_P2P_CLIENT` 类型的组接口（`src/drivers/driver.h:2074`）；决定 WPS 里谁是 Registrar 谁是 Enrollee——`wpas_go_neg_completed()` 里 `if (res->role_go) wpas_start_wps_go(...) else wpas_start_wps_enrollee(...)`（`p2p_supplicant.c:2538`）；决定 ssid 的 mode 是 `WPAS_MODE_P2P_GO` 还是 `WPAS_MODE_INFRA`；最终决定本节看到的分叉——GO 立即广播、Client 等握手。后面 §4、§5、§6 里所有"GO 侧 / Client 侧"的不同，追到底都是这一个比特位。

# 2 GO 侧：挂牌营业——Beacon 怎么开始发声？

上一节的代码里，`ssid->mode = WPAS_MODE_P2P_GO` 是一个分水岭。这个模式切换不是简单的状态标记——它告诉 wpa_supplicant 的内嵌 hostapd："现在你是 AP 了，开始干 AP 该干的事"。

P2P GO 的 AP 模式不是独立进程，而是 wpa_supplicant 内嵌的 hostapd 功能。整个 GO 的 Beacon 发射、Auth/Assoc 处理、EAPOL 四次握手都由同一个 wpa_supplicant 进程完成——没有第二个 hostapd 守护进程。

## 2.1 Beacon 从哪来——GO 接口创建的时间线

在这篇文章之前，GO 的虚拟接口（P2P-GO 类型）已经创建好了。回顾一下时间线：上一篇 P2P（四）GO Negotiation 完成后，`p2p_go_complete()` 触发 `go_neg_completed` 回调（即 `wpas_go_neg_completed()`，`p2p_supplicant.c:2453`），wpa_supplicant 在回调里经 `wpas_p2p_init_group_interface()` 创建了 P2P GO 接口，再由 `wpas_start_wps_go()` 启动内嵌 hostapd。

Beacon 真正开始发射的代码触发点是 `wpa_supplicant_create_ap()`（`wpa_supplicant/ap.c:969`）内部的 `hostapd_setup_interface()`（`src/ap/hostapd.c:2891`）。

这条链从 `wpas_start_wps_go()` 把 GO 参数写进 ssid 开始：supplicant 跳过扫描直接走 `wpa_supplicant_associate()` 的 AP 分支，`wpa_supplicant_create_ap()` 建好 hostapd 接口、下发 Beacon 模板，硬件就在目标信道上周期发射了。

所以时间线的关键对比是：**Beacon 先开播，WPS 后配网**。WPS 的 EAP-WSC 八轮交换是在这个 Beacon 已经发射的接口上跑的——Client 在 WPS 开始之前就能扫到 GO 的 Beacon，靠的是 Beacon 里 P2P IE 的 Group ID + WSC IE 的 Config Methods（PIN/PBC），凭这两个字段识别出"这是一个正在配网中的 GO"。配网完成后 `p2p_group_notif_formation_done()` 才把临时 WSC IE 摘掉。

所以在本章的时间点上，GO 的 Beacon 不是"现在才发射"，而是"一直就在发射"。WPS 成功后 `p2p_group_notif_formation_done()` 做的事是更新 Beacon 里的 IE 内容——把临时配网阶段的 WPS IE 摘掉，换上正式的 P2P Group 相关 IE。

## 2.2 Beacon IE 更新：从配网模式到正式模式

把「换上正式 IE」落到代码里，这个函数用两个状态位加一次重建，就把 Beacon 从配网模式切到了正式模式：

```c
// src/p2p/p2p_group.c:801
void p2p_group_notif_formation_done(struct p2p_group *group)
{
    if (group == NULL)
        return;
    group->group_formation = 0;      // 标记：不再是 "正在建群"
    group->beacon_update = 1;        // 标记：需要更新 Beacon
    p2p_group_update_ies(group);     // 重建 P2P IE + WSC IE
}
```

`p2p_group_update_ies()` 根据 `group_formation` 标志（现在是 0）重新构建 Beacon 和 Probe Response 携带的 P2P IE 与 WSC IE，经 `cfg->ie_update()` 回调把新的 IE 模板交给 hostapd（`p2p_group.c:506`）。hostapd 在下一个 Beacon 周期自动把更新后的 IE 模板写入 Beacon 帧——不需要重新调用 `NL80211_CMD_START_AP`。

在 Formation 阶段（`group_formation=1`），Beacon 携带的 WSC IE 包含 `Config Methods`（PIN/PBC 可用方法）、`Device Password ID`（用的是 PIN 还是 PBC），这是为了告诉扫描到的设备"我正在等 WPS 配网"。Formation 完成后（`group_formation=0`），这些临时信息被摘掉，Beacon 只保留 P2P Group ID、Device Info 等持久 IE。

Beacon IE 的结构大致如下：

| IE 类型         | Formation 阶段                                | Formation 完成后                  |
| --------------- | --------------------------------------------- | --------------------------------- |
| SSID IE         | DIRECT-xx-&lt;GO_NAME&gt;                     | 不变                              |
| Supported Rates | 基本速率集                                    | 不变                              |
| RSN IE          | WPA2-PSK (AES)                                | 不变                              |
| P2P IE          | Group ID、Device Info、Capability             | Group ID、Device Info、Capability |
| WSC IE          | Config Methods、Device Password ID、WPS State | 移除或最小化                      |

对比普通 AP 的 Beacon，P2P GO 的 Beacon 多了两样东西：P2P IE 和 WSC IE。普通 AP（SAP 或家庭路由器）的 Beacon 只携带 SSID、Supported Rates、RSN 这类常规 IE，不会带 P2P 专属的 OUI（`50:6F:9A`）IE，也只在开启 WPS 时才带 WSC IE。这两类 IE 是 Client 在扫描阶段把"这是一个 P2P GO"从一堆普通 AP 里认出来的身份标记——`p2p_group_update_ies()` 重建的就是这两块。而后续 §7.3 里 GO 要宣布 NOA 时，NOA 属性也是作为 P2P IE 内部的一个 P2P attribute（`P2P_ATTR_NOTICE_OF_ABSENCE`）挂进 Beacon 的——普通 AP 的 Beacon 永远不会有这个 attribute。

## 2.3 驱动下发：START_AP 的完整路径

Beacon 发射的前提是 NL80211_CMD_START_AP。虽然这件事在 GO 接口创建时就已经完成了（WPS 之前），但站在全链路视角，还是值得把这条路径拆开看一遍——因为 Client 关联 GO 时，GO 侧的 Auth/Assoc 帧处理也依赖同一个 `start_ap` 建立的状态。

顺着接口说开一个设计决策：**为什么 P2P 要单独建一个组接口（`p2p-wlan0-0`），而不是复用 P2P 设备接口（`p2p-wlan0`）？** 答案是并发。组接口要承担 GO 的 AP 职责（Beacon 周期发射、Auth/Assoc 处理、数据面收发），而设备接口要继续跑发现（Device Discovery）、监听（Listen）、扫描（Scan）。如果把 AP 职责也压在设备接口上，GO 在 Beacon 周期里就没法同时监听其他 P2P 设备的发现帧——整群会变成"瞎子"。

所以 wpa_supplicant 在 `wpas_p2p_init_group_interface()` 里用 `wpa_supplicant_add_iface()` 新建一个独立 `wpa_supplicant` 实例（`p2p_supplicant.c:2324`），挂独立 netdev（QCOM/MTK 驱动分别创建 `p2p-wlan0-0` 这类虚拟接口）。两个 netdev 共用同一套物理射频，但各是独立接口——设备接口 `p2p-wlan0` 继续管发现/监听/扫描，组接口 `p2p-wlan0-0` 专职 AP 数据面。这个"一设备两接口"的结构，是 §6.3 里 `WifiP2pGroup.mInterface` 出现 `p2p-wlan0-0` 的根源。

但"必须新建接口"不是绝对的——`wpas_p2p_create_iface()`（`p2p_supplicant.c:5309`）有一道能力探测：驱动若声明 `WPA_DRIVER_FLAGS_P2P_DEDICATED_INTERFACE` 或 `WPA_DRIVER_FLAGS_P2P_MGMT_AND_NON_P2P`（`src/drivers/driver.h:2199/2209`），P2P 组在任何情况下都要新接口；若只有 `WPA_DRIVER_FLAGS_P2P_CONCURRENT`（`driver.h:2194`）则允许在现有接口空闲时复用。QCOM/MTK 都声明了 dedicated 标志，所以 Android 上组接口永远是独立 netdev——这也是为什么 `wpas_p2p_create_iface()` 在大多数 Android 设备上返回 1。

接口从哪来定下来了，现在看 START_AP 命令本身。它从 supplicant 经 netlink 进入内核，第一站是 nl80211 层的 `nl80211_start_ap()`：

```c
// net/wireless/nl80211.c:5976 (内核 nl80211 层)
static int nl80211_start_ap(struct sk_buff *skb, struct genl_info *info)
{
    // 1. 检查接口类型：必须是 AP 或 P2P_GO
    if (dev->ieee80211_ptr->iftype != NL80211_IFTYPE_AP &&
        dev->ieee80211_ptr->iftype != NL80211_IFTYPE_P2P_GO)
        return -EOPNOTSUPP;

    // 2. 解析 Beacon 模板 (head + tail)、SSID、信道、加密参数
    err = nl80211_parse_beacon(rdev, info->attrs, &params->beacon);
    params->beacon_interval = nla_get_u32(...);
    params->dtim_period = nla_get_u32(...);

    // 3. 解析 P2P 特有参数
    if (info->attrs[NL80211_ATTR_P2P_CTWINDOW]) {
        // P2P GO CTWindow（Client Traffic Window）
        params->p2p_ctwindow = nla_get_u8(...);
    }
    if (info->attrs[NL80211_ATTR_P2P_OPPPS]) {
        // P2P GO Opportunistic Power Save
        params->p2p_opp_ps = nla_get_u8(...);
    }

    // 4. 调用驱动的 start_ap 回调
    err = rdev_start_ap(rdev, dev, params);
    // ...
}
```

`P2P_CTWINDOW` 和 `P2P_OPPPS` 是 P2P GO 特有的两个 nl80211 属性，分别对应两种省电/调度机制。

`CTWindow`（Client Traffic Window）是 GO 在每个 Beacon 间隔中预留的"仅 Client 可用"的时间窗口——毫秒级——GO 在这段时间内不发送自己的数据，确保 Client 有机会发包。

`OPPPS`（Opportunistic Power Save）则允许 Client 在 CTWindow 之外进入省电状态，GO 用 Beacon 里的通告告诉 Client 什么时候可以醒过来。这两个参数直接对应 P2P 规范里的 Opportunistic Power Save 机制。

## 2.4 QCOM 驱动：sap_fsm → WMI START_BSS

QCOM 驱动侧，`rdev_start_ap` 最终落到 `wlan_hdd_cfg80211_start_ap()`：

```c
// core/hdd/src/wlan_hdd_hostapd.c:7978
int wlan_hdd_cfg80211_start_ap(struct wiphy *wiphy,
                                struct net_device *dev,
                                struct cfg80211_ap_settings *params)
{
    struct osif_vdev_sync *vdev_sync;
    errno = osif_vdev_sync_op_start(dev, &vdev_sync);  // 获取 vdev 同步锁
    errno = __wlan_hdd_cfg80211_start_ap(wiphy, dev, params);
    osif_vdev_sync_op_stop(vdev_sync);                  // 释放同步锁
    return errno;
}
```

`__wlan_hdd_cfg80211_start_ap()` 内部经过 SAP FSM（Soft AP Finite State Machine）的状态校验——SAP 状态机与《SAP（四）》文章中分析的相同——然后构建 `struct sap_config`（包含 SSID、信道、加密方式、Beacon interval、DTIM period），最终通过 WMI 向固件发送 `WMI_VDEV_START_REQUEST_CMDID`。

固件收到后，开始按 Beacon interval 周期性地在指定信道上发送 Beacon 帧。

## 2.5 MTK 驱动：mtk_cfg_start_ap → 固件

MTK 侧对应的是 `mtk_cfg_start_ap()`（`gl_cfg80211.c:8230`），对 P2P 设备最终落到 `mtk_p2p_cfg80211_start_ap()`（`gl_p2p_cfg80211.c:1612`），通过 mbox 消息队列向固件发送 `MSG_P2P_START_AP` 指令。与 QCOM 的 WMI 机制类似，固件拿到 Beacon 模板（SSID、信道、支持的速率和 IE 集合）后在硬件上周期发射；但固件侧生效确认是异步的——命令进 mbox 队列即返回，要等固件完成信道探测、Beacon 模板配置并回报后，Beacon 才真正按 interval 周期开播（时序差异见 §7.2）。

---

# 3 Client 侧：报到——怎么关联 GO？

客户端的行动从 WPS 成功开始。`wpas_p2p_wps_success()` 中 Client 路径的处理和 GO 不同——不是发 GROUP_STARTED，而是重新启动超时定时器（`P2P_MAX_INITIAL_CONN_WAIT`，默认 10 秒），然后等待数据连接建立。这个"数据连接"指的是什么？

WPS 成功后，Client 已经把 GO 的 SSID 和 WPA2-PSK 凭证拿到了（WPS M8 消息中的 `Network Key` + `SSID` 属性）。现在 Client 要像连接一个普通的 WPA2-PSK AP 一样去连接 GO——Auth、Assoc、四次握手、DHCP。整个过程和《连接》系列中 STA 连接的标准流程完全相同，只是目标从"大楼的 WiFi 路由器"变成了"相亲角里刚组建的 GO"。

## 3.1 Supplicant 层的连接触发

WPS 成功回调中，Client 的 `ssid->mode == WPAS_MODE_INFRA`——这意味着 Client 把 GO 当作一个 infrastructure AP 来连接。wpa_supplicant 的 SME（`sme.c`）在后台启动 Auth 流程：

```
wpas_p2p_wps_success()                     // WPS 成功
  → p2p_wps_success_cb()                   // 清理 GO Neg 状态
  → [eloop 超时等待]                       // 等待数据连接完成
    → SME: sme_send_authentication()        // 发起 Auth
      → wpa_drv_authenticate()              // 驱动：发送 Auth 帧
        → driver_nl80211_authenticate()     // NL80211_CMD_AUTHENTICATE
```

Client 的 Auth/Assoc 流程和《连接（二）》中 STA 连接 Supplicant 层完全一致，区别在于这次连接的目标 SSID 是 `DIRECT-xx-<GO_NAME>`，而不是常规的 WiFi 网络名。

这里要澄清一个容易误会的点：**Client 的自动连接是 supplicant 层的机制，不是 Framework 层自动发起的**。App 早在 Provision Discovery 阶段（WPS 之前）就通过 `WifiP2pManager.connect()`（`WifiP2pManager.java:2432`）下了单，Framework 的 `InactiveState` 收下这个 connect 请求（`WifiP2pServiceImpl.java:3776`）后转入 Provision Discovery + WPS。

WPS 配网拿到 GO 的 credential 后，`wpa_supplicant_wps_cred()` 保存网络配置时设下 `wpa_s->after_wps = 5`（`wpa_supplicant/wps_supplicant.c:607`）——这个标志告诉 supplicant「WPS 刚结束，立即在 saved network 上发起扫描与连接」，于是 SME 才自动启动 Auth。

所以整条链是：App 在 WPS 前手动 connect → Framework 收单 → WPS 配网 → supplicant 凭 `after_wps` 自动连 GO。Framework 层没有"发现 GROUP_STARTED 后自动 connect"的逻辑——它只负责把 App 的 connect 请求翻译成 supplicant 命令。

不过目标选择上还有一个 STA 模式没有的细节——**P2P Client 不是按 SSID 匹配 AP，而是按 BSSID 精确锁定唯一目标**。P2P 发现阶段（Device Discovery）已经把 GO 的信息存进了 peer 对象：`struct p2p_device`（`src/p2p/p2p_i.h:63`）里除了 P2P Device Address，还记录了 GO 的接口地址 `interface_addr`（`p2p_i.h:82`，也就是 GO 的 BSSID）、群 SSID `oper_ssid`（`p2p_i.h:105`）和工作信道 `oper_freq`（`p2p_i.h:104`）。

WPS 配网完成后，Client 侧生成连接用的 ssid 时，`wpas_wps_add_network()`（`wpa_supplicant/wps_supplicant.c:1021`）在收到 bssid 参数后直接把 GO 的 BSSID 写死进 ssid——`ssid->bssid_set = 1; os_memcpy(ssid->bssid, bssid, ETH_ALEN)`（`wps_supplicant.c:1054-1055`）。

于是 Client 在扫描结果里挑选目标时，`wpa_supplicant_ssid_bss_match()`（`wpa_supplicant/events.c:650`）多了一道精确校验：`if (ssid->bssid_set && !ether_addr_equal(bss->bssid, ssid->bssid)) return false;`（`events.c:1346`）——BSSID 对不上就直接跳过，即使 SSID 完全匹配也不行。

这正是 P2P 与 STA 连接的核心区别之一：STA 模式通常不设 `bssid_set`，同一 SSID 下有多个候选 AP（信号强度、频段、加密方式不同），supplicant 会挑一个最优的；而 P2P Client 的目标是唯一确定的——1 个 SSID + 1 个 BSSID——因为 GO 是谈判、配网阶段认准的那一台设备，不存在"换个 GO 连"的选项。扫描到多个 `DIRECT-xx-<GO_NAME>` 时，只有 BSSID 对上的那一个才是要连接的 GO。

## 3.2 驱动侧的 Auth/Assoc 帧交换

与普通 STA 连接一样，Client 驱动侧通过 nl80211 收到 `NL80211_CMD_AUTHENTICATE` 和 `NL80211_CMD_ASSOCIATE` 命令后，向 GO 发送 Auth/Assoc 帧。

QCOM 路径走 `wlan_hdd_cfg80211_connect()` → `wlan_hdd_cm_connect()` → `osif_cm_connect()` → Connection Manager → `wmi_unified_peer_assoc_send()` 下发固件（`WMI_PEER_ASSOC_CMDID`）。

MTK 路径走 AIS FSM 的状态迁移，从 Idle → Auth → Assoc 依次推进。

GO 侧的处理路径与《SAP（三）》文章中分析的完全相同：`ieee802_11_mgmt()`（`src/ap/ieee802_11.c:6255`）按 subtype 分发——`WLAN_FC_STYPE_AUTH` 进 `handle_auth()`、`WLAN_FC_STYPE_ASSOC_REQ` 进 `handle_assoc()`。

```c
// src/ap/ieee802_11.c:6255
int ieee802_11_mgmt(struct hostapd_data *hapd, const u8 *buf, size_t len,
                    struct hostapd_frame_info *fi)
{
    // ... 帧校验 ...
    switch (stype) {
    case WLAN_FC_STYPE_AUTH:
        handle_auth(hapd, mgmt, len, ssi_signal, 0);
        ret = 1;
        break;
    case WLAN_FC_STYPE_ASSOC_REQ:
        handle_assoc(hapd, mgmt, len, 0, ssi_signal);
        ret = 1;
        break;
    // ...
    }
}
```

Auth 阶段是开放系统认证（Open System Authentication），基本是走个过场——Client 说"我是 XX"，GO 回"好的知道了"。真正的安全在后面的四次握手。Assoc 阶段，Client 提交自己的能力集（HT/VHT/HE/EHT Capabilities），GO 分配 AID（Association ID）并返回 Assoc Response。

不过 P2P 场景下，Assoc 阶段比普通 STA 多一层身份校验：GO 要从 Assoc Request 里解析出 P2P IE，确认对方确实带着 P2P 设备身份来报到。

`handle_assoc()`（`src/ap/ieee802_11.c:5353`）核心校验在助手函数 `__check_assoc_ies()`（`src/ap/ieee802_11.c:3944`）里：收到带 P2P IE 的 Assoc Request 后，用 `ieee802_11_vendor_ie_concat(ies, ies_len, P2P_IE_VENDOR_TYPE)` 把 P2P 专属 OUI（`50:6F:9A`，`src/common/ieee802_11_defs.h:1436`）的 IE 提取成 `sta->p2p_ie`，再调 `p2p_get_go_dev_addr()`（`src/p2p/p2p_parse.c:965`）从中解析出 P2P Device Address——这是 P2P 层面的设备标识，和 MAC 地址不是一回事。

这个 `p2p_dev_addr` 在 `src/ap/ieee802_11.c:4133` 被传进 `wpa_auth_sta_init(hapd->wpa_auth, sta->addr, p2p_dev_addr)`，成为后面四次握手按 P2P 设备匹配 PSK 的钥匙。

WPS 的 credential 就是这样和握手关联起来的：GO 作为 Registrar，在 WPS M8 里由 `wps_build_cred_network_key()`（`src/wps/wps_enrollee.c:301`）生成随机 32 字节 PSK，通过 `hostapd_wps_new_psk_cb()`（`src/ap/wps_hostapd.c:95`）挂进 `conf->ssid.wpa_psk` 链表（`wps=1` 标记 + 带 `p2p_dev_addr`），四次握手时 `wpa_auth_get_psk()`（`src/ap/wpa_auth.c:260`）→ `hostapd_get_psk()`（`src/ap/ap_config.c:1155`）遍历这条链表、按 `p2p_dev_addr` 匹配出属于这个 Client 的那把 PSK。

Client 侧对称：`wpa_supplicant_wps_cred()`（`wpa_supplicant/wps_supplicant.c:374`）把 WPS M8 收到的 Network Key 存成 `ssid->psk`（64 hex）或 `ssid->passphrase`（8-63 字符），两端用同一把钥匙进握手。

关联成功后，`p2p_group_notif_assoc()`（`src/ap/ieee802_11.c:4322` → `src/p2p/p2p_group.c:602`）把 Client 加入 GO 的成员链表，Assoc Response 里的 P2P IE 则用 `p2p_group_assoc_resp_ie()`（`src/p2p/p2p_group.c:646`）按状态码（`P2P_SC_SUCCESS=0` / `P2P_SC_FAIL_LIMIT_REACHED=3`，`src/common/ieee802_11_defs.h:1836/1839`）组装。

「把 Client 加入成员链表」这句值得拆开看——GO 侧对每个成员的登记是 `p2p_group_notif_assoc()` 里的几步：先 `p2p_add_device()` 把 Client 的 P2P 信息记进 P2P 核心的设备表，然后建一个 `struct p2p_group_member` 节点（`src/p2p/p2p_group.c:21`，链表节点，含 `addr`、解析出的 P2P IE 和 client info），挂进 `group->members` 链表头部、`num_members++`。满员时（`num_members == max_clients`）置 `beacon_update = 1`，让下一个 Beacon 周期把最新的 Group Info（成员列表）刷进去；第一个成员加入时调 `cfg->idle_update(ctx, 0)`（`p2p_group.c:640`）取消群的空闲回收计时。

有进就有出。Client 离开（主动 deauth、信号丢失、被踢）时，hostapd 的 STA 生命周期回调调 `p2p_group_notif_disassoc()`（`src/ap/sta_info.c:391` → `src/p2p/p2p_group.c:690`），内部走 `p2p_group_remove_member()`（`p2p_group.c:572`）按 MAC 地址在链表里遍历摘除节点、`num_members--`。从满员退回空位时同样 `beacon_update = 1` 刷新 Group Info；最后一个成员离开时 `cfg->idle_update(ctx, 1)`（`p2p_group.c:701`）通知 supplicant「群空了」，启动群空闲回收——这就是一个 P2P 群组在无人时最终被自动拆除的机制起点。

---

# 4 四次握手：钥匙交接——怎么和 STA 模式不一样？

Client 关联成功后，GO 作为 Authenticator（认证方）发起 WPA2 四次握手。这里的握手和《SAP（三）》中 SAP 模式的四次握手是**完全相同的代码路径**——同一个 `handle_auth()` 成功后触发 `WPA_PTK` 状态机。

但 P2P 场景下有一处关键差异：GO 直接管理所有 Client，没有上层 AP。

## 4.1 状态机：同一个 WPA_PTK，不同的上下文

四次握手的 WPA_PTK 状态机有 12 个状态（完整列表见《SAP（三）》文章），P2P GO 使用的是完整链路：

```
INITIALIZE → AUTHENTICATION → AUTHENTICATION2 → INITPSK
  → PTKSTART（GO 发 EAPOL 1/4 含 ANonce）
    → PTKCALCNEGOTIATING（Client 回 EAPOL 2/4 含 SNonce + MIC）
      → PTKCALCNEGOTIATING2（GO 验证 MIC，推导 PTK）
        → PTKINITNEGOTIATING（GO 发 EAPOL 3/4 含 GTK 加密 + MIC）
          → PTKINITDONE（Client 回 EAPOL 4/4 ACK）
            → group 状态机走 SETKEYS → SETKEYSDONE 完成 GTK 驱动侧安装
```

四个 EAPOL 帧的角色分配：

| 消息      | 方向        | 内容                           | 作用                    |
| --------- | ----------- | ------------------------------ | ----------------------- |
| EAPOL 1/4 | GO → Client | ANonce（GO 生成的随机数）      | 握手发起的信号          |
| EAPOL 2/4 | Client → GO | SNonce（Client 的随机数）+ MIC | Client 证明自己知道 PMK |
| EAPOL 3/4 | GO → Client | GTK（加密的群密钥）+ MIC       | GO 发群聊密钥           |
| EAPOL 4/4 | Client → GO | MIC（确认）                    | Client 说"收到，已装好" |

把 12 态拆开看，四次握手其实是**两条独立状态机**的协作：`wpa_ptk_state`（12 态，`src/ap/wpa_auth_i.h:27`）跑单播密钥 PTK 的协商，`wpa_ptk_group_state`（4 态：IDLE → REKEYNEGOTIATING → REKEYESTABLISHED → KEYERROR，`wpa_auth_i.h:35`）跑群密钥 GTK 的分发。

两者不是并行的——**PTK 必须先建好，GTK 才能发出去**。原因在加密依赖上：EAPOL 3/4 里的 GTK 不是明文，而是用 PTK 派生的 KEK 加密后放进 Key Data 的——`wpa_auth.c:2123` 的 `aes_wrap(sm->PTK.kek, ...)`（`sm->PTK.kek` 是 PTK 的子密钥）。PTK 没算出来，KEK 就不存在，GTK 根本无从加密。

这个依赖在状态机上的体现是：GO 在 `PTKCALCNEGOTIATING2`（验证 MIC、推导 PTK）之后才进入 `PTKINITNEGOTIATING` 发 EAPOL 3/4——GTK 就挂在 3/4 的 Key Data 里（`wpa_auth.c:4913` 的 `RSN_KEY_DATA_GROUPKEY` KDE）。Client 回 EAPOL 4/4 后，GO 走到 `PTKINITDONE`，安装 PTK 并调用 `wpa_auth_set_eapol(..., WPA_EAPOL_authorized, 1)`（`wpa_auth.c:5136-5137`）——**802.1X 端口在此刻才被授权**。

之后如果 GTK 需要更新（rekey），`wpa_group_update_sta()`（`wpa_auth.c:5638`）会检查该 STA 是否已经处于 `PTKINITDONE`（`wpa_auth.c:5670` 的守卫）——不是 PTKINITDONE 的 STA 直接跳过，再一次落实"先 PTK 后 GTK"。

Client 侧的端口授权同理：`wpa_supplicant_key_neg_complete()`（`src/rsn_supp/wpa.c:1165`）在收到 EAPOL 3/4、验证通过后把状态推到 `WPA_COMPLETED`，并调用 `eapol_sm_notify_portValid(sm->eapol, true)`（`wpa.c:1180`）打开 802.1X 端口，EAPOL 数据通道才真正可以走数据帧。

这就是第一节里 Client 侧 `show_group_started = 1` 的完整技术含义：不是"等四次握手发完 4 个包"，而是等"PTK 安装、GTK 到位、802.1X 端口授权"这三件事全部完成，`wpas_p2p_completed()`（`wpa_supplicant/p2p_supplicant.c:8051`）才被触发、GROUP_STARTED 才广播出去。

把整条 Group Formation 的时间线铺开看，每个阶段都有明确的超时或触发锚点：WPS 成功（`wpas_p2p_wps_success()`）是 `t=0`；GO 侧 Beacon 一直在发射（接口创建时就 START_AP，与 WPS 无关）；Client 侧从 WPS 成功到四次握手完成有一个 `P2P_MAX_INITIAL_CONN_WAIT=10` 秒的总等待（`wpa_supplicant/p2p_supplicant.c:77`，GO 侧对应 `P2P_MAX_INITIAL_CONN_WAIT_GO=10`，`:87`）；握手内部 EAPOL-Key 重传按 `eapol_key_timeout_first=100ms`、`eapol_key_timeout_subseq=1000ms` 递增（`src/ap/wpa_auth.c:78-79`）。

握手一完成，Client 侧的 GROUP_STARTED 发出、`show_group_started` 归零；再往下就是 §5 的 DHCP/IP 取号（DORA 四步，Framework 侧 `withProvisioningTimeoutMs(36 * 1000)` 兜底）——IP 到手后数据面才真正建立。

也就是说，**整个建群过程是一个受 10 秒超时约束的串联时序**：每一段（Auth/Assoc、四次握手、DHCP）都得在窗口内完成，任何一段卡住都会触发 §4.2 讲到的失败收敛。

## 4.2 和 STA 模式的关键差异

在 STA 连接基础设施 AP 的场景下（《连接（二）》文章），STA 是 Supplicant（恳求者）——被动等 AP 发 EAPOL 1/4，然后回复 2/4。AP 负责推导 PTK、分发 GTK。

P2P 里角色完全不变——GO 就是 AP，Client 就是 STA。那为什么说"不一样"？

差异不在加密机制，而在**群组拓扑**。在基础设施网络中，AP 上面还可能连着 RADIUS 服务器（802.1X）、DS（Distribution System）等。AP 的 Group Key 可能来自一个集中的密钥服务器。P2P GO 没有这些上层——它自己就是密钥的源头。WPS 提供的 PMK 直接进四次握手，没有 RADIUS、没有 DS、没有什么"上游"。

简单来说：**加密算法完全一样，但密钥来源和信任模型完全不同**。STA 模式中 PMK 可以来自 802.1X/EAP（通过 RADIUS 服务器），而 P2P 中 PMK 来自 WPS 配网（PIN/PBC 生成的 DH 共享密钥）。这就是为什么上一篇《P2P（五）》讲了那么长的 WPS——WPS 的 DH 密钥交换是在为这一刻的四次握手准备 PMK。

密钥来源的差异再往下看还有一层：WPS 下发的钥匙可以是整群共享的口令，也可以是每台设备一把独立的 per-device PSK——`wps_build_cred_network_key()`（`src/wps/wps_enrollee.c:301`）在没有群口令时会为每个 Client 生成随机 32 字节 PSK，经 `hostapd_wps_new_psk_cb()`（`src/ap/wps_hostapd.c:95`）挂进 GO 的 `wpa_psk` 链表、按 `p2p_dev_addr` 匹配（就是 §3.2 那条链）。

对比基础设施 802.1X 的 per-STA 密钥管理——RADIUS EAP 会话、PMKSA 缓存、rekey 记账——P2P 的 per-STA 钥匙没有后端服务器参与：WPS 一次配网就把钥匙落进一张扁平链表，四次握手照常各自派生自己的 PTK，组播/广播统一用 GTK。密钥管理链在 P2P 里被砍到最短——WPS 是唯一的密钥供应通道，之后的 PTK/GTK 机制与基础设施 AP 完全同源。

站在一台设备自己的视角，"上下文"的切换发生在实现路径上。一个平时连家庭路由器的手机，它的 wpa_supplicant 跑的是 STA 侧状态机（`src/rsn_supp/wpa.c` 的 Supplicant），被动收 EAPOL 1/4、回 2/4。

当这台手机变成 P2P GO，同一个进程却要在组接口上跑 AP 侧状态机：`wpa_supplicant_create_ap()`（`wpa_supplicant/ap.c:969`）拉起内嵌 hostapd，`hostapd_setup_interface()`（`src/ap/hostapd.c:2891`）在 `hostapd_setup_bss()`（`hostapd.c:1393`）里经 `hostapd_setup_wpa()` 调 `wpa_init()`（`src/ap/wpa_auth.c:732`）建出 Authenticator——现在主动发 1/4、验证 2/4 的 MIC 的是它。四个 EAPOL 帧的方向原样反转，处理它们的代码从 `rsn_supp/wpa.c` 换成了 `ap/wpa_auth.c`。

这个切换不是运行时的临时判断，而是 §1 里 `res->role_go` 比特位早就定死的：比特位决定接口类型（`WPA_IF_P2P_GO`），接口类型决定这个 netdev 挂哪一套状态机。所以"角色反转改变上下文"的实质是——同一份 wpa_supplicant 二进制、同一个进程，按接口角色在 Supplicant 与 Authenticator 两套状态机之间切换；支持并发 P2P 的驱动上，一台手机甚至可以同时是一个群的 GO、另一个群的 Client，两个组接口各挂各的状态机，互不干扰。这正是 wpa_supplicant 把 hostapd 内嵌进来的根本原因：一套守护进程、两种角色、按接口区分。

把这一幕放回相亲角的比喻里：这台手机平时去别人家（家庭路由器）串门，是"访客"——按主人定的规矩领钥匙、等主人先递 EAPOL 1/4；轮到它当 GO 摆桌，就反转为"老大"——钥匙由它发、先手 1/4 由它出。`res->role_go` 比特位就是那块决定身份的桌牌：写"GO"就按老大的流程走，写"Client"就按访客的流程走。更妙的是这块桌牌挂在接口上而不是人身上——一台手机可以同时在一个群当老大、在另一个群当访客，两块桌牌各挂各的接口、互不干扰。

但钥匙对不上怎么办？握手不是总能成功——Client 的 MIC 校验失败、EAPOL 帧丢失、或者单纯是配网给的 PSK 在两端不一致，都会让四次握手卡在半路。GO 侧，`wpa_auth_mic_failure_report()`（`src/ap/wpa_auth.c:225`）会把 MIC 校验失败上报给 supplicant，同时 EAPOL-Key 按 `eapol_key_timeout_first=100ms`、`eapol_key_timeout_subseq=1000ms` 的重传间隔（`wpa_auth.c:78-79`）反复补发。

如果一直过不去，就轮到建群超时兜底：Client 侧是 `P2P_MAX_INITIAL_CONN_WAIT=10` 秒，GO 侧是 `P2P_MAX_INITIAL_CONN_WAIT_GO=10` 秒（都在 `wpa_supplicant/p2p_supplicant.c:77-88` 定义）。

超时后 `wpas_p2p_group_formation_failed()`（`p2p_supplicant.c:2404`）调用 `p2p_group_formation_failed()`（`src/p2p/p2p.c:2971`）清掉 P2P 核心的建群状态，再走 `wpas_group_formation_completed(wpa_s, 0, ...)` 向 Framework 发 `P2P_EVENT_GROUP_FORMATION_FAILURE`（`p2p_supplicant.c:1424`）——这条失败事件和成功的 `GROUP_STARTED` 走同一条 wpa_msg 通道，只是方向相反。

不过 10 秒超时是"最后兜底"，supplicant 对两类"确定没救"的失败走的是 fail-fast 捷径，把超时直接塌缩到 0——因为继续等也不会成功，早塌缩早收场。

第一类在 GO 侧：AP 起不来。`wpa_supplicant_associate()` 走 AP 分支时 `wpa_supplicant_create_ap()` 返回失败（驱动不支持 AP 模式、信道占用等），`wpa_supplicant.c:2732` 调 `wpas_p2p_ap_setup_failed()`（`p2p_supplicant.c:2426`），它把建群超时从 15 秒注册改成 `eloop_register_timeout(0, 0, ...)` 立即触发——Beacon 都没发出去，握手自然无从谈起。

第二类在 WPS 层：配网失败。`wpas_p2p_wps_failed()`（`p2p_supplicant.c:7505`）发现 Group Formation 阶段 WPS 交换失败，置 `p2p_fail_on_wps_complete=1` 并用 `eloop_deplete_timeout(0, 50000, ...)`（`p2p_supplicant.c:7530`）把超时压到 50ms；等 `wpas_p2p_wps_eapol_cb()`（`p2p_supplicant.c:7537`）收到 EAPOL 回调后，`wpas_p2p_grpform_fail_after_wps()`（`p2p_supplicant.c:2415`）再注册 0 延迟超时收尾。

两条捷径终点都是同一个 `wpas_p2p_group_formation_failed()` 漏斗——这就是异常路径的跨层传播形态：无论失败源在驱动（AP 起不来）、WPS（配网失败）还是握手（MIC 校验不过），最终都收敛到 supplicant 这一个失败入口，再统一上抛 Framework。失败路径上每层都不各自广播，正是为了让 Framework 只需盯住 `GROUP_FORMATION_FAILURE` 这一个信号。

Framework 侧收到 `P2P_GROUP_FORMATION_FAILURE_EVENT` 后不会立刻处理，而是等随后的 `P2P_GROUP_REMOVED_EVENT`——代码注释写得很清楚：建群失败总是紧跟着群被移除，在 failure 时立刻清理会触发 supplicant 的竞态（`WifiP2pServiceImpl.java:5446` 注释）。真正的善后在 `P2P_GROUP_REMOVED_EVENT` 分支：`handleGroupCreationFailure()`（`WifiP2pServiceImpl.java:5437`）终止连接指标、通知 App `GROUP_CREATION_FAILED`，状态机退回 `InactiveState`。

这一套失败路径保证「群没建成」这件事在四层（固件/驱动/supplicant/Framework）都有对得上号的收尾——不像成功路径那样每层发自己的广播，失败时由 supplicant 统一发 failure 事件、Framework 统一做回滚。

GTK 分发后，Client 装上 PTK 和 GTK——从现在开始，GO 和 Client 之间的所有帧都经过 AES-CCMP 加密。

但群密钥不是装上就一劳永逸。GO 的 GTK rekey 默认周期是 24 小时——`wpa_group_rekey` 对 CCMP/GCMP 这类强加密取 86400 秒，TKIP 才是 600 秒（`src/ap/ap_config.c:1646`，wpa_supplicant 内嵌 hostapd 建 BSS 时还会再兜一道，见 `wpa_supplicant/ap.c:729`）。触发它的是 eloop 定时器 `wpa_rekey_gtk()`（`src/ap/wpa_auth.c:564`）：每过一个周期，GO 重新生成一把 GTK，再走 `wpa_group_update_sta()` 把新 GTK 用各 STA 已装好的 KEK 加密后随 EAPOL-Key 分发下去——3/4 里 Key Data 字段的又一次使用。

为什么非得周期性地换？因为 GTK 是整群共享的钥匙：中途离开的 Client 手里还握着旧 GTK，不换的话它照样能解密群里之后的组播/广播帧。对 P2P 群组来说，Client 的在线时长远够不到 24 小时，这个 rekey 大多数情况下等不到触发——但机制一直在 hostapd 里跑着，和 SAP 是同一套。

---

# 5 DHCP：发群内编号——谁分配什么 IP？

四次握手完成、加密层建立后，最后一件事是 IP 分配。类比相亲角：钥匙拿到了，但你还不知道自己的工位号（IP 地址）。GO 作为群主，给每个人发一个编号。

P2P Group 的 IP 分配和 SAP 模式（《SAP（五）》文章）共享同一套机制——GO 通过 Android 的 Tethering 框架启动 DHCP Server，Client 通过标准的 DHCP Client 获取 IP。

## 5.1 GO 侧：DhcpServer 启动

GO 侧在 `GroupNegotiationState`（`GroupCreatingState` 的子状态）收到 `P2P_GROUP_STARTED_EVENT` 后判断 `mGroup.isGroupOwner()`，触发 Tethering 框架接管 DHCP：

```
GroupNegotiationState.processMessageImpl()  // P2P_GROUP_STARTED_EVENT
  → 判断 mGroup.isGroupOwner()
    → sendP2pTetherRequestBroadcastPreU()   // WIFI_P2P_CONNECTION_CHANGED_ACTION 单播给 Tethering（PostU 分支在 :6951）
      → Tethering.handleWifiP2pAction()      // Tethering.java:1519
        → enableWifiP2pIpServing()           // Tethering.java:1735
          → enableIpServing() → tetherInternal() → tetherState.ipServer.enable()  // 进入 IpServer 状态机
            → IpServer.configureDhcp() → startDhcp() → DhcpServer 启动
```

一个容易误会的点：**DhcpServer 不是等 GO 进入 `GroupCreatedState` 之后才启动的**，而是在 `GroupNegotiationState` 阶段、由 Tethering 框架提前拉起来的。

GO 分支调 `sendP2pTetherRequestBroadcastPreU()`（`WifiP2pServiceImpl.java:6943`，PostU 分支在 `:6951`；实际发的是 `WIFI_P2P_CONNECTION_CHANGED_ACTION` 单播，定向给 Tethering 服务包）。

这个广播落进 Tethering 后一路向下：`Tethering.handleWifiP2pAction()`（`Tethering.java:1519`）→ `enableWifiP2pIpServing()`（`Tethering.java:1735`）→ `enableIpServing()` → `tetherInternal()`（`Tethering.java:1191`）→ `tetherState.ipServer.enable()` → `IpServer.configureDhcp()`（`IpServer.java:697`）→ `IpServer.startDhcp()`（`IpServer.java:654`）→ `makeDhcpServer()` 拉起 mainline NetworkStack 的 `DhcpServer`（`DhcpServer.java:90`，StateMachine）。

Tethering 就绪后通过 `onLocalOnlyInterfacesChanged` 回调回报，WifiP2pServiceImpl 收到 `TETHER_INTERFACE_STATE_CHANGED`（`WifiP2pServiceImpl.java:5402`）确认接口出现在 localOnly 列表里，才 `smTransition` 进 `GroupCreatedState`。

所以 `GroupCreatedState.enterImpl()` 里那句注释写得很直白——"DHCP server has already been started if I am a group owner"（`WifiP2pServiceImpl.java:5894`）：GO 只读接口地址填 `WifiP2pInfo`，DHCP 早就被 Tethering 框架接管了。

DHCP Server 在 GO 侧监听 P2P 接口，GO 自己的 IP 固定为 `192.168.49.1`（Tethering 的 `IpServer` 用 `LEGACY_WIFI_P2P_IFACE_ADDRESS`，`IpServer.java:144`，接口地址 `192.168.49.1/24`；同值常量 `GO_EAPOL_IP_ADDRESS`，`WifiP2pServiceImpl.java:470`，是 EAPOL-Key 的 IP 分配基址），子网 `192.168.49.0/24`。这个 IP 是 Android P2P 实现的硬编码约定——所有 Android 设备的 P2P GO 都用这个地址，不是 DHCP 动态分配的。

为什么 P2P GO 敢用固定地址、而 SAP 不敢？两者的地址管理模式完全不同。SAP（SoftAP）的 DHCP Server 地址由 Tethering 的 `PrivateAddressCoordinator` 全局协调：它维护一张上游网络前缀表，`requestStickyDownstreamAddress()`（`PrivateAddressCoordinator.java:218`）每次给下游接口挑地址都随机避让，既不撞上游网段、也不和其他 tethering 接口冲突。

原因很直接——SAP 要向上游做 NAT、参与 TetheringOffload 统计，若 SAP 的子网恰好和上游同网段，Client 的包会被本地路由短路，永远到不了互联网。

P2P GO 没有这个顾虑。Tethering 给 P2P 走的是 `createImplicitLocalOnlyTetheringRequest()`（`TetheringUtils.java:203`）构造的 local-only 请求，压根没有上游网络，不存在"子网撞车"的问题；`IpServer.requestIpv4Address()` 里 `shouldUseWifiP2pDedicatedIp()` 一命中，就直接返回硬编码的 `LEGACY_WIFI_P2P_IFACE_ADDRESS`（`IpServer.java:781`），连 PrivateAddressCoordinator 的动态挑选都省了。

这个固定地址还以 `TETHERING_WIFI_P2P` 的 scope 预留在协调器的 sticky 缓存里（`PrivateAddressCoordinator.java:126`），其他 tethering 接口不会抢走它。

## 5.2 Client 侧：DhcpClient 获取 IP

Client 侧在关联成功、四次握手完成后，DHCP Client 在 P2P 接口上发送 `DHCPDISCOVER` 广播。DHCP 四步：

```
Client                          GO (DhcpServer)
  |                                |
  |--- DHCPDISCOVER (广播) ------->|  "谁是 DHCP Server？我需要一个 IP"
  |<-- DHCPOFFER (单播) ----------|  "我可以给你 192.168.49.X"
  |--- DHCPREQUEST (广播) ------->|  "好，我就要这个 192.168.49.X"
  |<-- DHCPACK (单播) ------------|  "确认，租期 X 秒"
```

Client 拿到 IP 后，数据连接正式建立。此时 GO 和 Client 可以通过 Socket 通信——这就是 P2P 群组的数据面。

Client 侧的 DHCP 客户端不是裸跑，而是挂在 Android 的 `IpClient` 框架上。

`P2P_GROUP_STARTED_EVENT` 的 Client 分支调 `startIpClient()`（`WifiP2pServiceImpl.java:841`）→ `IpClientUtil.makeIpClient()`（`IpClientUtil.java:79`）经 AIDL 绑定 NetworkStack 的 `IIpClient` → `IpClient.startProvisioning()`（`IpClient.java:1393`）→ `DhcpClient`（`DhcpClient.java:147`，StateMachine）。

`IpClientCallbacksImpl.onIpClientCreated()`（`WifiP2pServiceImpl.java:892`）按 provisioning mode 分两路：默认 `GROUP_CLIENT_IP_PROVISIONING_MODE_IPV4_DHCP`（`WifiP2pConfig.java:119`）走上面这套 DORA 四步，带 `withPreDhcpAction(30 * 1000)`（`WifiP2pServiceImpl.java:932`）和 `withProvisioningTimeoutMs(36 * 1000)`（`WifiP2pServiceImpl.java:933`）。

如果 App 在 `WifiP2pConfig` 里选了 `GROUP_CLIENT_IP_PROVISIONING_MODE_IPV6_LINK_LOCAL`（`WifiP2pConfig.java:124`），则跳过 IPv4，只配 IPv6 link-local 地址（`WifiP2pServiceImpl.java:904`）。

另外若四次握手时从 EAPOL-Key 帧拿到了静态 IP（`mGroup.p2pClientEapolIpInfo`），`makeStaticIpConfigurationFromEapolIpAddressInfo()`（`WifiP2pServiceImpl.java:851`）会直接用静态配置，不再走 DHCP。

这条"握手里就定死 IP"的路径值得拆开看，因为它是 P2P 数据面建立的捷径：**静态 IP 是通过 EAPOL-Key 帧里的一个 P2P 私有 KDE 协商的，根本不需要 DHCP 服务器**。Client 在 EAPOL 2/4 里附一个 `WFA_KEY_DATA_IP_ADDR_REQ` KDE（`src/rsn_supp/wpa.c:1101`，只有 `sm->p2p` 时才会加），向 GO 要 IP。

这个 `sm->p2p` 不是 Client 自己拍板的——它由 GO 的能力位把关：GO 侧 `cfg->ip_addr_alloc`（`p2p_supplicant.c:7431`，由配置项 `ip_addr_start` 决定）既驱动 `wpa_auth.c:812` 的 `ip_pool` 位图分配，也经 `p2p_group_add_common_ies()`（`p2p_group.c:158`）把 Group Capability Bitmap 的 `P2P_GROUP_CAPAB_IP_ADDR_ALLOCATION` 位（`src/common/ieee802_11_defs.h:1791`）置进 Beacon 的 P2P IE。

Client 在 `wpa_supplicant_rsn_supp_set_config()`（`wpa_supplicant/wpas_glue.c:1616-1626`）用 `p2p_get_group_capab()`（`src/p2p/p2p_parse.c:950`）解析这个能力位，命中才把 `conf.p2p` 置 1，`wpa_sm_set_config()` 再落进 `sm->p2p`（`src/rsn_supp/wpa.c:4651`）。P2P 规范 §4.2.8 写得直白：GO 未在 Group Capability Bitmap 里通告 IP 分配能力，Client 就不许发请求。

GO 在 `SM_STATE(WPA_PTK, PTKCALCNEGOTIATING)` 处理这条 2/4 时发现 `kde.ip_addr_req`，就从 `wpa_auth->ip_pool` 位图里取第一个空闲位分配（`src/ap/wpa_auth.c:3959-3981`），把 IP 写进 `sm->ip_addr`；Client 从 EAPOL 3/4 里解析回 `WFA_KEY_DATA_IP_ADDR_ALLOC` KDE（`src/common/wpa_common.c:3540`）存进 `sm->p2p_ip_addr`（`wpa.c:2856`）。这套 KDE 协商是 P2P 规范定义的扩展——它和 DHCP 完全无关，DHCP 只是默认的"通用"取号方式，静态 IP 是握手里顺带谈好的更快的取号方式。

为什么这条请求偏偏借道 EAPOL-Key 数据帧，而不是像 Auth/Assoc 一样挂在管理帧的 IE 里？首先是时机与认证绑定。IP 请求必须绑定到"已经证明自己知道 PMK"的那台设备——`wpa_supplicant_send_2_of_4()`（`src/rsn_supp/wpa.c:526`）把 KDE 和 SNonce、MIC 拼进同一个 2/4 帧，MIC 由 PMK 派生的 KCK 计算、覆盖整帧包括这段 Key Data。

换句话说，能把 IP 请求塞进 2/4 的，只有真正握有 WPS 下发钥匙的设备。反过来看 Auth/Assoc 这些管理帧，它们发生在握手之前，既没有 PTK 也没有 MIC，任何没有钥匙的设备都能伪造一个 IP 请求——GO 一旦照单分配，`ip_pool` 位图（`src/ap/wpa_auth.c:812` 由 `ip_addr_start`/`ip_addr_end` 建出）就会被耗尽，或地址被根本没资格入群的设备抢走。

其次是机制成本。2/4 本来就要从 Client 发到 GO、3/4 本来就要从 GO 发回 Client（`src/ap/wpa_auth.c:4966` 把分配结果拼进 3/4 的 Key Data），请求与分配搭上这两趟顺风车，一个额外往返都不增加，重传也复用 EAPOL-Key 自己的定时器（`eapol_key_timeout_first=100ms`、`eapol_key_timeout_subseq=1000ms`）；而管理帧路径得另起一套 vendor action frame + 两端驱动的识别分发 + 自己的重传机制——为一次握手里顺带完成的取号操作搭一整条新链路，不值得。

这条链也完全跑在 supplicant 里：驱动对 EAPOL-Key 帧只是数据面透传，QCOM/MTK 都不解析 KDE，双平台行为一致——平台差异只出现在握手之后的 add_key 安装环节（§7.1/§7.2）。

KDE 协商出来的地址最终怎么落到 Framework 手里？`wpas_p2p_completed()` 把 `go_ip_addr` 一起塞进 `P2P-GROUP-STARTED` 事件文本（`wpa_supplicant/p2p_supplicant.c:8099` 的 `ip_addr=... ip_mask=... go_ip_addr=...`），Framework 的 `SupplicantP2pIfaceCallbackAidlImpl` 用 `p2pClientIpInfo` 解析成 `P2pGroupClientEapolIpAddressData`（`SupplicantP2pIfaceCallbackAidlImpl.java:357`），最终 `makeStaticIpConfigurationFromEapolIpAddressInfo()` 组装出 `StaticIpConfiguration`。

也就是说：**只要 GO 侧启用了 EAPOL-Key IP 分配，Client 拿到 IP 的速度比 DHCP 快一个"发现-提供-请求-确认"的往返**——密钥和地址在握手里一起交付。

这套双轨设计不是偶然——DHCP 被刻意放在 IP 层，是为了保持通用：同一套 DHCP 客户端/服务器代码，无论底层是 Wi-Fi STA、P2P Client 还是 USB 网络共享都能跑，L2 只需要把 IP/UDP 帧送过去就行。通用性的代价是时延和部署：DHCP 得先等 802.1X 端口授权、数据通道建立，再走"发现-提供-请求-确认"四步，且 P2P 里还得由 GO 侧 Tethering 框架额外拉起一个 DhcpServer（§5.1）。

EAPOL-Key 分配则把地址协商折叠进握手里，零额外往返，但它的代价是专用：这是 P2P 独有的 vendor KDE 扩展，要 GO 能力位把关、两端都支持，地址池只是 `ip_addr_start`/`ip_addr_end` 之间的一张位图（first-free 分配，`bitfield_get_first_zero()`），没有租约、续约、重配置语义，地址一次定死。所以两条路径是互补的层级关系——KDE 是 P2P 场景的"快路径"，DHCP 是任何场景都成立的"通用兜底"；Android 默认走 IPv4-DHCP，只有 GO 在 Group Capability Bitmap 里亮出 `P2P_GROUP_CAPAB_IP_ADDR_ALLOCATION` 时才启用快路径。

这个 IP 不是永久的——GO 的 DhcpServer 给每个 Client 发的租约默认只有 `DHCP_LEASE_TIME_SECS = 3600` 秒（`IpServer.java:147`，一小时）。租期过半（T1，约 30 分钟）时 Client 的 `DhcpClient` 进入续约流程：发 `DHCPREQUEST`（单播给 GO）请求续租，GO 的 DhcpServer 收到后更新租约并回 `DHCPACK`。这个续约动作由 `DhcpClient` 状态机的 `CMD_RENEW_DHCP` 消息驱动（`DhcpClient.java:1846`），和刚拿到 IP 时的 DORA 四步共用 `DhcpClient` 这个 StateMachine——只是从「发现/请求」变成「续租」。如果续约一直失败直到 T2（约 52 分钟），`DhcpClient` 才放弃单播续租、退回广播 `DHCPDISCOVER` 重新走完整 DORA。

对 P2P 场景来说，这个一小时租期已经够长——群组通常按分钟计的生命周期里，Client 很少真的等到续约那一步。

重连也一样顺滑。GO 的 DhcpServer 不会因为某个 Client 离开就重启——它在 IpServer 存活期间一直跑着，租约表也一直留在内存里。`DhcpServer` 内部用 `DhcpLeaseRepository`（`src/android/net/dhcp/DhcpLeaseRepository.java`）管地址池：`mCommittedLeases` 按 IP 记录已提交租约。Client 重连发 DHCPDISCOVER 时，`getOffer()`（`DhcpLeaseRepository.java:192`）先清过期租约，再 `findByClient()` 按 MAC 找旧租约——找到直接 `renewedLease()`，同一个 Client 拿回同一个工位号，不会撞车；`isAvailable()`（`:513`）又排除 reserved 和已提交地址，保证不把正在用的 IP 再发出去。

而前面提到的 EAPOL-Key 静态 IP 路径（`mGroup.p2pClientEapolIpInfo`）则干脆绕开 DHCP——IP 在握手里就定死了。

## 5.3 Framework 层：WifiP2pInfo 赋值

Framework 层的 `WifiP2pInfo` 对象在 Group Formation 期间被填充：

```java
// WifiP2pServiceImpl.java:7767
private void setWifiP2pInfoOnGroupFormationWithInetAddress(InetAddress serverAddress) {
    mWifiP2pInfo.groupFormed = true;
    mWifiP2pInfo.isGroupOwner = mGroup.isGroupOwner();
    mWifiP2pInfo.groupOwnerAddress = serverAddress;
}
```

三个字段：

- `groupFormed`：恒为 `true`（群已经成立）
- `isGroupOwner`：当前设备的角色。GO 为 `true`，Client 为 `false`
- `groupOwnerAddress`：GO 的 IP 地址（`192.168.49.1`）——Client 用这个地址主动连接 GO 建立 Socket

Client 侧需要通过这个 `groupOwnerAddress` 去连接 GO。如果 Client 自己试图 bind ServerSocket 监听——抱歉，你不是老大，只有 GO 才有 ServerSocket 的资格。这是 P2P SDK 层面的设计约定，不是技术限制。

---

# 6 Framework：管理处怎么收到"群已成立"通知？

WPS 成功、四次握手完成、DHCP 拿号完毕，现在 Framework 层的管理处（P2pStateMachine）要做登记——把群的信息存下来、通知 App 层"群可以用了"。

## 6.1 GROUP_STARTED event 的两条到达路径

在第一节中我们看到，GO 和 Client 对 `GROUP_STARTED` 的发送时机完全不同。GO 在 WPS 成功的瞬间就发，Client 等到四次握手完成后才发。这个差异直接影响了 Framework 状态机的演进节奏。

`wpas_p2p_group_started()` 向 wpa_supplicant 的控制接口写入一条事件消息：

```
P2P-GROUP-STARTED wlan0 GO ssid="DIRECT-xx-MyPhone" freq=2412 passphrase="abcd1234" go_dev_addr=aa:bb:cc:dd:ee:ff
```

Framework 的 `WifiP2pMonitor` 把这行文本解析成 `P2P_GROUP_STARTED_EVENT` 消息，附带一个 `WifiP2pGroup` 对象——这个对象就是通过正则表达式从事件文本中提取 SSID、频率、密码、GO 地址构建的。

`GroupNegotiationState.processMessageImpl()`（`GroupCreatingState` 的子状态）接收 `P2P_GROUP_STARTED_EVENT`，分两条路径：

**GO 路径**：

```java
// service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:5311
case WifiP2pMonitor.P2P_GROUP_STARTED_EVENT:
    mGroup = (WifiP2pGroup) message.obj;
    if (mGroup.isGroupOwner()) {
        // GO: 启动 Tethering，等待 TETHER_INTERFACE_STATE_CHANGED
        setWifiP2pInfoOnGroupFormation(null);
        sendP2pTetherRequestBroadcastPreU();  // 或 sendP2pTetherRequestBroadcastPostU()
        // ... 等待 tethering 回调 → transitionTo(mGroupCreatedState)
    }
```

**Client 路径**：

```java
    } else {
        // Client: 直接启动 IpClient，然后 transitionTo
        startIpClient(mGroup.getInterface(), getHandler(),
                mSavedPeerConfig.getGroupClientIpProvisioningMode(),
                mGroup.p2pClientEapolIpInfo);
        smTransition(this, mGroupCreatedState);  // line 5400
    }
```

GO 多了一步 Tethering——因为 GO 要启动 DHCP Server、做 NAT 转发——所以等 Tethering 就绪后通过 `TETHER_INTERFACE_STATE_CHANGED` 事件才跳转。Client 没有这些负担，直接进 `GroupCreatedState`。

## 6.2 GroupCreatedState.enterImpl()：登记在册

进入 `GroupCreatedState` 后，`enterImpl()` 按四步把「群已成立」这件事登记进 Framework 的各个角落：

```java
// service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:5885
public void enterImpl() {
    logSmStateName(this.getName(), ...);

    // 1. 设备状态：CONNECTED
    mDetailedState = NetworkInfo.DetailedState.CONNECTED;
    updateThisDevice(WifiP2pDevice.CONNECTED);

    // 2. 如果是 GO，获取接口 IPv4 地址写入 WifiP2pInfo
    if (mGroup.isGroupOwner()) {
        Inet4Address addr = getInterfaceAddress(mGroup.getInterface());
        if (addr != null) {
            setWifiP2pInfoOnGroupFormation(addr.getHostAddress());
        }
    }

    // 3. 如果是 Autonomous GO（非协商建群），立刻发广播
    if (mAutonomousGroup) {
        onGroupCreated(new WifiP2pInfo(mWifiP2pInfo), eraseOwnDeviceAddress(mGroup),
                generateCallbackList(mGroup));
        sendP2pConnectionChangedBroadcast();
    }

    // 4. 记录 Metrics
    mWifiP2pMetrics.endConnectionEvent(...);
    mWifiP2pMetrics.startGroupEvent(mGroup);
}
```

对于协商建群（GO Negotiation）的 `GroupCreatedState`，广播不在 `enterImpl()` 里直接发——而是等到后续 Client 关联成功后通过 `AP_STA_CONNECTED_EVENT` 触发。这个细节很重要：App 接收 `WIFI_P2P_CONNECTION_CHANGED_ACTION` 的时机取决于建群方式。

`GroupCreatedState` 也不是进了就不动的静态表——它下面还挂两个子状态，分管群的扩容与拆除。**UserAuthorizingJoinState**（`WifiP2pServiceImpl.java:6458`）：群建好后又来新设备想加入，P2P 规范里只有 GO 有权处理 join——GO 收到新的 Provision Discovery 请求且确认自己是 GO 时，就迁进这个状态（`:6345`），`enterImpl()` 里 `notifyInvitationReceived(REQUEST_TYPE_JOIN)`（`:6473`）弹窗问用户同不同意；同意就 `startWpsPbc`/`startWpsPinKeypad`（`:6500`）补一轮 WPS 配网，配完退回 `GroupCreatedState`。

**OngoingGroupRemovalState**（`WifiP2pServiceImpl.java:6548`）：App 调 `removeGroup()` 时，Framework 发 `mWifiNative.p2pGroupRemove()` 成功后就迁进这个状态（`:6144`），等父状态收到 `P2P_GROUP_REMOVED_EVENT`（`:5427`）才真正收尾。这两个子状态就是 §3.2 成员进出在 Framework 侧的对应物——supplicant 管 Client 的关联/去关联，Framework 管"要不要放人进来"和"整个群什么时候拆完"。

## 6.3 WifiP2pGroup：群的户口本

`WifiP2pGroup` 是 P2P 群组的 Framework 层"户口本"对象（`framework/java/android/net/wifi/p2p/WifiP2pGroup.java:57`），包含：

| 字段            | 类型                  | 来源                                   |
| --------------- | --------------------- | -------------------------------------- |
| `mNetworkName`  | String                | supplicant 事件中的 `ssid="..."`       |
| `mOwner`        | WifiP2pDevice         | supplicant 事件中的 `go_dev_addr=...`  |
| `mIsGroupOwner` | boolean               | supplicant 事件中的 `GO` / `client`    |
| `mClients`      | List\<WifiP2pDevice\> | 运行时维护，Client 关联时添加          |
| `mPassphrase`   | String                | supplicant 事件中的 `passphrase="..."` |
| `mInterface`    | String                | P2P 接口名（如 `p2p-wlan0-0`）         |
| `mFrequency`    | int                   | supplicant 事件中的 `freq=...`         |

## 6.4 广播发出：App 拿到什么？

广播 Intent 由 `getP2pConnectionChangedIntent()`（`WifiP2pServiceImpl.java:6792`）构建，`sendP2pConnectionChangedBroadcast()`（`WifiP2pServiceImpl.java:6843`）负责把 Intent 发出去：

```java
// WifiP2pServiceImpl.java:6792
private Intent getP2pConnectionChangedIntent() {
    Intent intent = new Intent(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
    intent.addFlags(Intent.FLAG_RECEIVER_REGISTERED_ONLY_BEFORE_BOOT);
    intent.putExtra(WifiP2pManager.EXTRA_WIFI_P2P_INFO, new WifiP2pInfo(mWifiP2pInfo));
    intent.putExtra(WifiP2pManager.EXTRA_NETWORK_INFO, makeNetworkInfo());
    intent.putExtra(WifiP2pManager.EXTRA_WIFI_P2P_GROUP, eraseOwnDeviceAddress(mGroup));
    return intent;
}
```

App 通过 `BroadcastReceiver` 拿到三个 Extra：

- `EXTRA_WIFI_P2P_INFO`：`WifiP2pInfo`，包含 `isGroupOwner`（我是老大吗）、`groupOwnerAddress`（老大坐哪——IP 地址）
- `EXTRA_NETWORK_INFO`：`NetworkInfo`，网络状态信息
- `EXTRA_WIFI_P2P_GROUP`：`WifiP2pGroup`，群的详细信息（群名、密码、成员列表）

App 拿到这些后，GO 开 `ServerSocket` 监听，Client 通过 `groupOwnerAddress` 连接——P2P 数据通信正式开始。

---

# 7 驱动侧：模式切换与 NOA——老大怎么"暂时离开"？

Group Formation 不仅在协议层完成了 Auth/Assoc/四次握手/DHCP，在驱动层也触发了一系列适配——P2P 接口的模式识别、GO 模式的 Beacon 调度、以及并发场景下必不可少的 NOA（Notice of Absence）。如果说协议层是相亲角「前台」的动作——对暗号、发钥匙、分工位——驱动层就是「后台」的保障：牌子要挂得稳、身份要认得出、老大离场要提前打招呼。

## 7.1 QCOM：wlan_hdd_p2p.c 中的 P2P 角色切换

QCOM 驱动在 `wlan_hdd_p2p.c` 中维护 P2P 设备的状态。当 GO 接口启动（`wlan_hdd_cfg80211_start_ap`），驱动的 P2P 组件记录 `adapter->device_mode` 为 `QDF_P2P_GO_MODE`。当 Client 连接 GO（`wlan_hdd_cfg80211_connect`），`adapter->device_mode` 切换为 `QDF_P2P_CLIENT_MODE`。

这个模式值影响驱动的多个行为路径：

- 省电策略（GO 不能主动休眠，Client 可以）——GO 要持续发射 Beacon、应答 Client，休眠一秒群就失联；Client 没有这个义务，随时可以睡
- 帧优先级（GO 的管理帧优先于数据帧）——管理帧关乎入退网与群状态，丢了影响全群；数据帧丢了还能重传
- NOA 调度（只有 GO 需要发送 NOA）——NOA 是"老大离场"的公告，只有 GO 需要向全群报告自己的缺席
- 信道管理（GO 的信道决定了整个群组的信道）——所有 Client 都要调到 GO 所在信道才能互通

从 `__wlan_hdd_cfg80211_start_ap()` 到固件的完整调用链：

```
__wlan_hdd_cfg80211_start_ap()
  → wlan_hdd_cfg80211_start_bss()    // HDD 层 SAP BSS 启动
    → wlansap_start_bss()             // SAP 状态机启动 BSS
      → sap_fsm 状态迁移               // SAP_INIT → SAP_STARTING
        → [MLME: vdev_mgr_start_send → tgt_vdev_mgr_start_send → target_if_vdev_mgr_start_send] // 中间层
          → wmi_unified_vdev_start_send() // target_if_vdev_mgr_tx_ops.c:533
            → WMI_VDEV_START_REQUEST_CMDID // 固件命令
```

固件收到 `WMI_VDEV_START_REQUEST_CMDID` 后，开始以配置的 Beacon interval（通常 100 TU = 102.4ms）发射 Beacon，并激活 Auth/Assoc 帧的接收处理。

这里有一个值得点破的同步语义：SAP FSM 的 `SAP_STARTING → SAP_STARTED` 迁移是**异步**的——`wlansap_start_bss()`（`core/sap/src/sap_module.c:787`）只是把 `eSAP_HDD_START_INFRA_BSS` 事件塞进 FSM 队列就返回了。

SAP FSM 在 `SAP_INIT` 状态处理该事件后进入 `SAP_STARTING`（迁移点 `sap_fsm.c:3229`，状态处理器 `sap_fsm_state_starting` 在 `sap_fsm.c:3659`）；真正的 START_BSS WMI 命令由 MLME/VDEV manager 层下发——`vdev_mgr_start_send` → `tgt_vdev_mgr_start_send`（dispatcher）→ `target_if_vdev_mgr_start_send`（`target_if_vdev_mgr_tx_ops.c:486`，内部在 `:533` 调 `wmi_unified_vdev_start_send()`）。

FSM 不会原地等在 `SAP_STARTED`，而是要等固件的 WMI 响应回来触发 `eSAP_MAC_START_BSS_SUCCESS`（`sap_api_link_cntl.c:519`），才在 `sap_fsm.c:3685` 迁移到 `SAP_STARTED`。**在固件确认之前，Beacon 并没有真正发射。**

但 hostapd 侧没有这个时间差——因为 HDD 层把异步变成了同步：`wlan_hdd_cfg80211_start_bss()`（`core/hdd/src/wlan_hdd_hostapd.c:6119`）调用 `wlansap_start_bss()` 之后，用 `qdf_wait_single_event(&hostapd_state->qdf_event, SME_CMD_START_BSS_TIMEOUT)`（`wlan_hdd_hostapd.c:6792`）阻塞等待，直到 SAP 状态机走到 `SAP_STARTED` 并通过 `eSAP_START_BSS_EVENT` 回告 HDD（`hdd_hostapd_sap_event_cb`，`wlan_hdd_hostapd.c:1971`），`qdf_event_set()`（`wlan_hdd_hostapd.c:2249`）才解除阻塞、向 cfg80211 返回 START_AP 成功。

也就是说：**QCOM 的 START_AP 返回时，固件已经确认 Beacon 开始发射**——hostapd 认为的"AP 已就绪"和真实 Beacon 发射在 QCOM 路径上是同步的，代价是 HDD 线程阻塞在等待事件上。

START_AP 的同步等待只是 QCOM 驱动侧的一个缩影——**四次握手完成后的密钥安装，QCOM 也用同一套 `osif_vdev_sync` 锁保证同步**。握手本身（§4 的 WPA_PTK 状态机）完全跑在 hostapd/supplicant 里，驱动不参与 EAPOL 帧的解析；握手一完成，hostapd 就把 PTK/GTK 通过 cfg80211 的 `add_key` 交给驱动。

QCOM 的 `wlan_hdd_cfg80211_add_key()`（`core/hdd/src/wlan_hdd_cfg80211.c:22410`）和 START_AP 一样，先 `osif_vdev_sync_op_start()` 拿 vdev 同步锁，再进 `__wlan_hdd_cfg80211_add_key()`（`:22354`）→ `wlan_hdd_add_key_vdev()`（`:21907`），最后落到 SME 的 `sme_add_key_btk()`/`sme_add_key_krk()`（`core/sme/inc/sme_api.h:4047/4068`）走 WMI 下发固件——**`add_key` 返回时固件已经装好密钥**，hostapd 认为"密钥就绪"和固件真实就绪是同步的。

P2P Client 模式下的广播/组播密钥还有一道特别处理：`wlan_hdd_add_key_vdev()` 里对非 pairwise 且 `device_mode` 是 STA/P2P_CLIENT 的情况，要先去取 vdev 的 bsspeer（`wlan_objmgr_vdev_try_get_bsspeer`）拿到 GO 的 peer 记录，再装组密钥——因为组密钥挂在 GO 这个 peer 上，而不是本机的某个 AP。

## 7.2 MTK：P2P Role FSM 的状态迁移

MTK 平台用 P2P Role FSM（有限状态机）管理 P2P 设备的角色切换。三个核心状态：

![MTK P2P Role State Machine](assets/11f-P2P%EF%BC%88%E5%85%AD%EF%BC%89Group-Formation-%E2%80%94%E2%80%94%E6%9A%97%E5%8F%B7%E5%AF%B9%E4%B8%8A%E4%BA%86%EF%BC%8C%E6%AD%A3%E5%BC%8F%E5%BB%BA%E7%BE%A4/11f-P2P-Role-FSM.svg)

从 Idle 到 GO Mode 的迁移由 `mtk_p2p_cfg80211_start_ap()` 触发——MTK 的 P2P AP 启动函数（对应枚举状态 `P2P_ROLE_STATE_AP_CHNL_DETECTION`）。

从 Idle 到 Client Mode 的迁移由 `mtk_p2p_cfg80211_connect()`（`os/linux/gl_p2p_cfg80211.c:3293`）触发——MTK 的 P2P GC 连接入口（对应枚举状态 `P2P_ROLE_STATE_GC_JOIN`）。cfg80211 的 connect 命令在 `mtk_cfg_connect()` 里按 `mtk_IsP2PNetDevice()` 分流，P2P 接口才走这个函数。

这个 FSM 和《SAP（四）》文章中的 P2P Role FSM 是同一个状态机，只是这里从 P2P Group Formation 的视角来看它的行为。

与 QCOM 不同的是，MTK 的 P2P Role FSM 在设计上更"显式"——每个状态入口和出口都有明确的处理函数，状态迁移路径在代码中用枚举 + switch 明确写出。QCOM 的 `adapter->device_mode` 本质上也是一个状态变量，但它的切换散布在各个 HDD 函数中，没有集中在一个 FSM 里管理。

MTK 的 START_AP 在同步语义上也和 QCOM 形成对比。`mtk_p2p_cfg80211_start_ap()`（`os/linux/gl_p2p_cfg80211.c:1612`）构造 `MSG_P2P_START_AP` 消息后 `mboxSendMsg()`（`gl_p2p_cfg80211.c:1963`）塞进 mbox 队列就返回 0——**不等待固件确认**。

P2P Role FSM 在后台事件循环里处理这条消息，`p2pRoleFsmRunEventStartAP`（`mgmt/p2p_role_fsm.c:1548`）把状态从 `P2P_ROLE_STATE_IDLE` 迁到 `P2P_ROLE_STATE_AP_CHNL_DETECTION`（信道探测）或 `P2P_ROLE_STATE_REQING_CHANNEL`（申请信道），要等固件把信道、Beacon 模板都配置好并回报，才真正进入 AP 模式发射。

所以 MTK 的 START_AP 是**纯异步**——cfg80211 的 START_AP 命令返回时，固件侧可能还在探测信道，Beacon 尚未发射。这与 QCOM 用 `qdf_wait_single_event` 阻塞等待形成对比：QCOM 用 HDD 线程的等待换取"hostapd 认为就绪 = 固件确认就绪"的同步，MTK 则把这个时间差交给上层——hostapd 收到 START_AP 成功但固件还在配置信道，期间 Probe Request/Assoc 帧可能被固件丢弃或延迟处理。

四次握手完成后的密钥安装，MTK 同样是"命令进队列就返回"的异步风格。握手逻辑跑在 supplicant 里，完成后 supplicant 通过 cfg80211 `add_key` 把 PTK/GTK 交给驱动——MTK 的 `mtk_cfg_add_key()`（`os/linux/gl_cfg80211.c:6824`）按 `mtk_IsP2PNetDevice()` 分流，P2P 接口走 `mtk_p2p_cfg80211_add_key()`（`os/linux/gl_p2p_cfg80211.c:788`）。

`mtk_p2p_cfg80211_add_key()` 把密钥打包成 `struct P2P_PARAM_KEY` 后经 `kalIoctl(wlanoidSetAddKey, ...)`（`:904`）塞进 OID 命令通道——`wlanSetAddKey()`（`common/wlan_oid.c:2834`）→ `wlanSetAddKeyImpl()`（`:2297`）最终以 `wlanSendSetQueryCmd(CMD_ID_ADD_REMOVE_KEY)`（`:2816`）投递到固件命令队列。

与 QCOM 的 `add_key` 阻塞等到 SME 完成为同步确认不同，MTK 这条路径是"下发即返回"——固件后续通过命令完成事件异步回报。

这里还有一个驱动侧的身份细节：`mtk_p2p_cfg80211_add_key()` 里 `kalP2PGetRole(...) == 2`（当前接口是 GO）时会给密钥打上 `BIT(28)` 的 authenticator 位（`:893-894`），pairwise 密钥则打 `BIT(31)`(Tx)+`BIT(30)`(Pairwise)（`:885-886`）——这些位最终写进 `rKey.u4KeyIndex`，是固件区分"这把钥匙是 GO 侧认证方安装的"还是"Client 侧安装的"的依据。

## 7.3 NOA：老大的"暂时离开一会儿"公告

在相亲角里，老大并不总能守在桌子前——它可能还要赶去隔壁城区处理另一摊事（STA 模式连接的 AP）。如果手机同时是 P2P GO 又连着一个 STA 模式的 WiFi AP（并发场景），矛盾就来了：GO 要在信道 X 上发射 Beacon 和接收 Client 数据，STA 要在信道 Y 上向 AP 发数据。WiFi 芯片通常只有一套射频，同一个时刻只能在一个信道上。

NOA（Notice of Absence）就是解决这个矛盾的机制。GO 在 Beacon 里携带一个 NOA 属性，告诉所有 Client："我接下来 N 个 Beacon 周期里，每隔一段时间会离开 Duration 微秒——别在这段时间找我。我离开期间你们也别发数据，发了我也收不到。"

NOA 的四个核心参数：

| 参数         | 含义                             | P2P 规范用词 |
| ------------ | -------------------------------- | ------------ |
| `count`      | 公告覆盖多少个 Beacon 周期       | Count        |
| `duration`   | 每次离开多久（微秒）             | Duration     |
| `interval`   | 每隔多久离开一次（微秒）         | Interval     |
| `start_time` | 从什么时候开始第一次离开（微秒） | Start Time   |

把四个参数落到时间轴上，NOA 的调度节奏就一目了然了——GO 周期性地"缺席"，Client 跟着休眠（图里的橙色块就是 GO 的缺席窗口，蓝色块是 Client 对应的省电休眠）：

![NOA 时序：GO 的「暂时离开」公告](assets/11f-P2P%EF%BC%88%E5%85%AD%EF%BC%89Group-Formation-%E2%80%94%E2%80%94%E6%9A%97%E5%8F%B7%E5%AF%B9%E4%B8%8A%E4%BA%86%EF%BC%8C%E6%AD%A3%E5%BC%8F%E5%BB%BA%E7%BE%A4/11f-noa-timing.svg)

这里有一个值得展开的设计细节：`start_time` 为什么用绝对 TSF 时间，而不是"从现在起偏移 N 微秒"的相对时间？因为 TSF（Time Synchronization Function）是 P2P 群里所有设备共同维护的同一把时钟——每个设备都从收到的 Beacon/Probe Response 帧里同步自己的 TSF 计数，GO 和 Client 对"当前是什么时刻"的认知是一致的。

P2P 规范里 NOA 属性的 Start Time 字段就是用 TSF 的低 4 字节表达的：Client 收到 Beacon 里的 NOA 属性后，拿自己本地的 TSF 去匹配 Start Time，取"过去或未来最近的那个绝对 TSF 值"来定位第一次离开的时刻。TSF 低 4 字节大约 71 分钟回绕一次，规范为此要求 GO 在排程期间定期刷新 Start Time 字段，确保中途才加入群的 Client 也能算出正确的缺席窗口。如果用相对偏移，Client 收到帧的时机不同、各自 TSF 与 GO 的偏差不同，对"什么时候开始离开"的解读就会分叉；绝对 TSF 让所有设备指向同一个时刻——这正是 TSF 作为 P2P 协议全局时钟的意义。

NOA 参数从哪来？不是驱动或固件自动生成的——**Host（wpa_supplicant）才是制定者**。`P2P_SET noa` 命令（`wpa_supplicant/ctrl_iface.c:7519`）解析 `count,start,duration` 三个参数（`count` 0-255、`start` 起始偏移 ms、`duration` 单次离开 ms），交给 `wpas_p2p_set_noa()`（`wpa_supplicant/p2p_supplicant.c:8423`）→ `hostapd_p2p_set_noa()`（`src/ap/p2p_hostapd.c:33`）。

`hostapd_p2p_set_noa` 的分支很明确：`count==0` 清空 NOA；`count==255` 表示周期 NOA，且仅在 `num_sta_no_p2p==0`（GO 上没有 legacy 非 P2P STA）时才真正下发——因为 legacy STA 不认识 NOA，GO 不能在它面前"消失"；`count` 为其他值时按单次 NOA 直接下发。随后 `hostapd_driver_set_noa()`（`src/ap/ap_drv_ops.c:801`）→ 驱动的 `set_noa` op 下到内核。

QCOM 侧，`hdd_set_p2p_noa()`（`core/hdd/src/wlan_hdd_p2p.c:500`）解析 `P2P_SET_NOA` 私有 ioctl 的参数（`count interval duration`），做一层决策：`count==1` 走单次 NOA（`P2P_POWER_SAVE_TYPE_SINGLE_NOA`，`duration` clamp 到不超过 `interval`），`count>1` 走周期 NOA（`P2P_POWER_SAVE_TYPE_PERIODIC_NOA`，要求 `duration < interval`），单位从 ms 转 TU（`MS_TO_TU_MUS`）。

之后经 `wlan_hdd_set_power_save()`（`wlan_hdd_p2p.c:1265`）→ `ucfg_p2p_set_ps()`（`components/p2p/dispatcher/src/wlan_p2p_ucfg_api.c:438`）——下发前还有一道门控 `is_p2p_ps_allowed()`（同文件 `:51`）：如果 GO 上挂着 legacy 非 P2P STA（`non_p2p_peer_count>0`），整套 NOA 会被丢弃，防止 legacy STA 被"带走"。

通过门控后 `target_if_p2p_set_ps()`（`components/target_if/p2p/src/target_if_p2p.c:315`）→ `wmi_unified_set_p2pgo_noa_req_cmd()`（`wmi_unified_p2p_api.c:36`）组 `WMI_FWTEST_P2P_SET_NOA_PARAM_CMDID` 发给固件。**start_time 由固件锚定**——host 只传 count/duration/interval，固件收到后自行决定第一次离开的起始时刻，并通过 `WMI_P2P_NOA_EVENTID` 回告（`wlan_p2p_main.c:1221` `p2p_process_noa()` → `p2p_send_noa_to_pe()`），host 拿固件回传的时序更新 Beacon 里的 NOA 属性。

MTK 平台走的是私有 wext 命令 `P2P_SET_NOA role_idx count interval duration`：`priv_driver_set_p2p_noa()`（`os/linux/gl_wext_priv.c:18172`）把参数写进 `P2P_SPECIFIC_BSS_INFO.rNoaParam`，`wlanoidSetNoaParam()`（`common/wlan_p2p.c:1100`）打包成 `CMD_ID_SET_NOA_PARAM`（`0x32`）发给固件。

MTK 固件同样会 unsolicited 上报 `EVENT_ID_UPDATE_NOA_PARAMS`（`wsys_cmd_handler_fw.h:457`），host 侧 `p2pProcessEvent_UpdateNOAParam()`（`mgmt/p2p_role_fsm.c:4333`）把固件算好的实际时序（含 start_time）写回 `P2P_SPECIFIC_BSS_INFO.arNoATiming[]` 并 `bssUpdateBeaconContent` 刷新 Beacon；Beacon 里的 NOA 属性由 `p2pFuncComposeNoaAttribute()`（`mgmt/p2p_func.c:7230`）组装。两条路径的终点相同——**count/duration/interval 由 Host 指定，start_time 由固件锚定并回告**，固件在指定时间窗口内暂停 GO 侧活动、切到 STA 信道处理 STA 的事务，完成后切回来。

上层应用看不到 NOA 细节，但能感受到：并发场景下 P2P 吞吐量下降是正常的——因为 GO 有"不在线"的时间窗口。

---

# 8 群建起来了，然后呢？

本文从 `wpas_p2p_wps_success()` 追到 `WIFI_P2P_CONNECTION_CHANGED_ACTION` 广播，横跨四个世界：

| 层级            | 关键角色                                                     | 核心工作                                                     |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Framework       | `GroupCreatingState` → `GroupCreatedState`                   | 接收 GROUP_STARTED、启动 Tethering/DHCP、构建 WifiP2pGroup/WifiP2pInfo、发广播 |
| wpa_supplicant  | `wpas_group_formation_completed()`                           | 区分 GO/Client 路径、更新 Beacon IE、上报 GROUP_STARTED      |
| hostapd（内嵌） | `ieee802_11_mgmt()` → `handle_auth/handle_assoc` + `WPA_PTK` | Auth/Assoc + 四次握手                                        |
| 驱动 (QCOM/MTK) | `wlan_hdd_cfg80211_start_ap/connect` + P2P Role FSM + NOA    | Beacon 发射/关联/模式切换/并发调度                           |

把上表按时间线串起来，每一层把控制权交给下一层都靠明确的传递机制——supplicant 内部用函数调用和 eloop 回调，跨进程用 netlink 和 wpa_msg event，驱动到固件用 WMI/mbox。全链路的关键连接点如下：

| 连接点                 | 入口函数                                                     | 出口函数                                                     | 传递机制                                               |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------ |
| §1→§2 GO 建群收尾      | `wpas_p2p_wps_success()`（p2p_supplicant.c:7444）            | `wpas_group_formation_completed()` → `p2p_group_notif_formation_done()`（p2p_group.c:801） | 同进程直接调用                                         |
| §2 Beacon 下发         | `wpa_supplicant_create_ap()`（ap.c:969）                     | `nl80211_start_ap()`（nl80211.c:5976）→ `rdev_start_ap()`（rdev-ops.h:163，调用点 nl80211.c:6264） | netlink（`NL80211_CMD_START_AP`）                      |
| §2 QCOM 驱动→固件      | `wlansap_start_bss()`（sap_module.c:787）→ SAP FSM           | `wmi_unified_vdev_start_send()`（wmi_unified_api.h:1000）    | WMI（`WMI_VDEV_START_REQUEST_CMDID`）                  |
| §2 MTK 驱动→固件       | `mtk_p2p_cfg80211_start_ap()`（gl_p2p_cfg80211.c:1612）      | `mboxSendMsg()`（gl_p2p_cfg80211.c:1963）                    | mbox（`MSG_P2P_START_AP`）                             |
| §1→§3 Client 连接触发  | `wpas_p2p_wps_success()` Client 分支                         | `sme_send_authentication()`（sme.c:551）→ `driver_nl80211_authenticate()`（driver_nl80211.c:10948） | eloop callback + netlink（`NL80211_CMD_AUTHENTICATE`） |
| §3→§4 GO Auth/Assoc    | `ieee802_11_mgmt()`（ieee802_11.c:6255）→ `handle_auth()/handle_assoc()` | `wpa_auth_sta_init()`（wpa_auth.c:938）                      | 802.11 管理帧 + 进程内调用                             |
| §4→§5 握手完成         | `wpa_supplicant_key_neg_complete()`（wpa.c:1165）            | `wpas_p2p_completed()`（p2p_supplicant.c:8051）              | wpa_msg event（`P2P-GROUP-STARTED`）                   |
| §5→§6 Framework 状态机 | `GroupNegotiationState.processMessageImpl()`（WifiP2pServiceImpl.java:5311） | `TETHER_INTERFACE_STATE_CHANGED`（:5402）→ `smTransition(mGroupCreatedState)`（:5400） | Intent 单播 + Framework 消息                           |
| §6→§7 驱动模式切换/NOA | `GroupCreatedState.enterImpl()`（WifiP2pServiceImpl.java:5885） | QCOM `device_mode` / MTK P2P Role FSM + NOA 链               | netlink + WMI/mbox                                     |

把这条链从一头走到另一头，全貌是这样的：App 的 `WifiP2pManager.connect()`（`WifiP2pManager.java:2432`）在 Provision Discovery 阶段就把建群请求交给了 Framework，`InactiveState` 收单后转入 Group Negotiation（`WifiP2pServiceImpl.java:3776`）。

WPS 配网成功，supplicant 的 `wpas_p2p_wps_success()`（`p2p_supplicant.c:7444`）开始分叉——GO 侧经 `wpas_group_formation_completed()`（`p2p_supplicant.c:1395`）把 ssid 切到 `WPAS_MODE_P2P_GO`、`p2p_group_notif_formation_done()`（`p2p_group.c:801`）更新 Beacon IE、`wpas_p2p_group_started()` 立即广播。

Client 侧设 `show_group_started = 1`，凭 `after_wps = 5` 触发 SME 的 `sme_send_authentication()`（`sme.c:551`）走 Auth/Assoc，GO 的 `ieee802_11_mgmt()`（`ieee802_11.c:6255`）把管理帧分发给 `handle_auth()` 和 `handle_assoc()`。

关联成功后 `wpa_auth_sta_init()`（`wpa_auth.c:938`）把 Client 挂进 WPA_PTK 状态机，四次握手在 GO 侧（`src/ap/wpa_auth.c`）和 Client 侧（`src/rsn_supp/wpa.c`）各跑一半，Client 的 `wpa_supplicant_key_neg_complete()`（`wpa.c:1165`）授权 802.1X 端口、`wpas_p2p_completed()`（`p2p_supplicant.c:8051`）补发 GROUP_STARTED。

Framework 的 `GroupNegotiationState` 收到事件后分路——GO 经 `sendP2pTetherRequestBroadcastPreU()`（`WifiP2pServiceImpl.java:6943`）拉起 Tethering 的 DhcpServer，Client 走 `startIpClient()`（`WifiP2pServiceImpl.java:841`）挂到 IpClient 的 DhcpClient；拿号完毕双方都进 `GroupCreatedState`，最终 `sendP2pConnectionChangedBroadcast()`（`WifiP2pServiceImpl.java:6843`）把 `WIFI_P2P_CONNECTION_CHANGED_ACTION` 广播给 App。

全程五层（Framework、supplicant、hostapd、驱动、固件）的边界由 Binder、AIDL、nl80211、wpa_msg、WMI/mbox 依次衔接，任何一层卡住都会沿 §4.2 的失败漏斗收敛回 `P2P_GROUP_FORMATION_FAILURE_EVENT`——这就是建群这条链的全貌。

群建好了，钥匙和工位号都齐了，数据通信可以开始了——Socket 连上 GO 的 `192.168.49.1`，TCP/UDP 自由传输。

但要分清边界：这个"自由传输"只在群内成立。P2P 群组是封闭的本地网段——Tethering 给 GO 建的 IpServer 走 `createImplicitLocalOnlyTetheringRequest()`（`TetheringUtils.java:203`）的 local-only scope，没有配置任何上游路由，GO 不会把 Client 的包 NAT 转发到互联网。

所以 P2P 建群后默认上不了网，这和 §5.1 的固定 IP 是同一枚硬币的两面：P2P 从设计上就没打算把群内流量送出去，而 SAP 要挂上游做 NAT、参与 TetheringOffload 统计，才需要 `PrivateAddressCoordinator` 动态避让子网。想让 P2P 群真正上网，得由应用自己再建一条 upstream + NAT 链路，Android 默认的建群流程并不包含这一步。

但群组的世界比"建群"大得多。不谈判直接建群（Autonomous GO）、老熟人秒重连（Persistent Group + Invitation）、群内发广告（Service Discovery）、Miracast 投屏、多连接并发——这些高级玩法，下一篇 P2P 文章揭晓。相亲角里的故事还没完。

---

**源码仓库**：

- AOSP wpa_supplicant 8: [https://w1.fi/wpa_supplicant/](https://w1.fi/wpa_supplicant/)
- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- QCOM qcacld-3.0: [https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0](https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0)
- MTK kernel_modules-connectivity-wlan-core-gen4m (MTK 内核模块仓库)

**相关规范**：

- Wi-Fi Alliance, "Wi-Fi Direct Specification v2.0"
- Wi-Fi Alliance, "Wi-Fi Simple Configuration Technical Specification v2.0.2"
