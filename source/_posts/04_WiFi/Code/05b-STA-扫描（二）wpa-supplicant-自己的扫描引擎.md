---
title: STA 扫描（二）wpa_supplicant 自己的扫描引擎
top: 1
related_posts: true
abbrlink: 7331fdf8
date: 2026-09-19 20:18:43
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 如果 Framework 的 wificond 扫描是雷达指挥中心发起的**例行探测任务**（定时扫、用户要求扫），那么 wpa_supplicant 的扫描引擎就是雷达的**自动维护程序**——它在后台悄悄扫描周围环境，自己决定何时扫、扫什么，目的是保持连接质量和发现 P2P 设备。最精妙的设计是 **radio work 队列**——同一台雷达不能同时做两件事，所有射频操作（扫描、连接、P2P）必须排队。

# 本章导读

这里有一个关键认知需要先明确：Android Framework 的常规扫描（Settings 10s 扫描、App 调用 startScan、WifiConnectivityManager 周期性扫描）**不经过 wpa_supplicant**——它们走的是 wificond → nl80211 → 驱动的直通路径（详见上篇《STA 扫描 — Framework 与 wificond》）。Supplicant 的扫描引擎服务于另一条独立路径：Supplicant 自己内部触发的扫描（bgscan 漫游、P2P Discovery、WPS 配网、连接前扫描）。两条路径互不感知，本篇聚焦 Supplicant 这条。

<!--more-->

**你将学到**：Supplicant 内部扫描的四种触发场景 → `wpa_supplicant_scan()` 的参数构建（SSID/频率/IE 三列表 + MAC 随机化）→ radio work 队列机制（单信道 vs 多信道互斥）→ `EVENT_SCAN_RESULTS` 分发链 → BSS 缓存生命周期管理。本篇是扫描三部曲的中篇，上篇讲 Framework → wificond → nl80211 直通路径，下篇讲驱动执行 + PNO + WiFi 6E/7。

**代码说明**：本文代码来自 AOSP [external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/) 真实源码（eloop / scan / bss / events），有精简（去掉 `wpa_dbg` log 语句），关键路径完整保留。

---

# 1 Supplicant 什么时候会自己扫描？

Android Framework 的常规扫描走 wificond，不经过 Supplicant。Supplicant 的扫描引擎在**四种场景**下触发——bgscan（漫游）、P2P Discovery、WPS 配网、以及**连接前扫描**（没有缓存 BSS 时先扫再连）。

## 1.1 Framework 扫描 vs Supplicant 扫描 — 两条独立路径

```
路径 A：Framework 扫描（上篇）        路径 B：Supplicant 内部扫描（本篇）
  App.startScan()                        Supplicant 内部事件触发
    → WifiScanningServiceImpl              → wpa_supplicant_req_scan()
      → WifiNl80211Manager                   → wpa_supplicant_scan()
        → wificond ScannerImpl::scanRequest()  → wpa_supplicant_trigger_scan()
          → ScanUtils::Scan()                    → radio_add_work("scan", wpas_trigger_scan_cb)
            → NL80211_CMD_TRIGGER_SCAN             → wpa_drv_scan()
              → 内核 → 驱动 → 固件                   → wpa_driver_nl80211_scan()
                                                       → NL80211_CMD_TRIGGER_SCAN
                                                         → 内核 → 驱动 → 固件
```

**两条路径互不感知**——Framework 不知道 Supplicant 在扫什么，Supplicant 不知道 Framework 什么时候扫。

## 1.2 Supplicant 内部扫描的四种场景

| 触发场景                 | 触发条件                                                    | 目的                                            | 典型配置                                                     |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| **连接前扫描**           | `wpa_supplicant_select_network()` 发现无缓存 BSS 或缓存过期 | 先扫描找到目标 AP，再发起连接                   | `scan_res_valid_for_connect`（缓存有效期）                   |
| **bgscan**               | 已连接状态下，按 bgscan 模块的间隔定时触发                  | 寻找同 ESS 的更优 AP（信号更好/负载更低）供漫游 | `bgscan="simple:30:-45:300"`（30s short interval, -45dB threshold, 300s long interval） |
| **P2P Device Discovery** | P2P 操作中（Find 阶段）                                     | 发现附近的 P2P 设备                             | `p2p_find` 命令，Listen + Search 状态交替                    |
| **WPS 配网扫描**         | WPS 按钮按下的 2 分钟内                                     | 发现正在进行 WPS 配网的 AP                      | 只在 WPS 频段（2.4GHz ch1/6/11）扫描                         |

**连接前扫描的完整流程**——这是最容易被忽略的场景：

```
wpa_supplicant_select_network()              // wpa_supplicant.c:5152
  ├── wpa_supplicant_fast_associate()        // 检查缓存是否可用
  │     ├── last_scan_res_used == 0?         → 无缓存，return -1
  │     ├── scan_res_valid_for_connect 超时?  → 缓存过期，return -1
  │     ├── crossed_6ghz_dom?               → 跨越 6GHz 域，return -1（需重新扫描）
  │     └── wpas_select_network_from_last_scan()  // 有缓存 → 直接选网连接
  │
  └── fast_associate 失败（无缓存/过期/跨 6GHz 域）：
        （注：connect_without_scan 仅在 MESH/AP 模式下设置，普通 STA 连接不会跳过扫描）
        → wpa_supplicant_req_scan()          // 调度扫描（eloop 去抖动）
          → wpa_supplicant_scan()            // 构建 SSID/频率/IE 三列表
            → wpa_supplicant_trigger_scan()（scan.c:293）  // 防重复检查 + 补齐 default IE + 克隆参数后调用 radio_add_work()（wpa_supplicant.c）
            → 驱动层扫描
              → EVENT_SCAN_RESULTS
                → wpas_select_network_from_last_scan()
                  → wpa_supplicant_connect()
                    → wpa_supplicant_associate()
```

也就是说，当用户在 Settings 中点击连接一个 WiFi 时，如果 Supplicant 的 BSS 缓存中没有这个 AP 的信息（或缓存已过期），它会**先扫描再连接**——这也是 Supplicant 扫描引擎的典型使用场景。`connect_without_scan` 标志可跳过此步骤：在 MESH/AP 模式下由 `wpa_supplicant.c` 设置；P2P GO 场景下由 `p2p_supplicant.c` 单独设置。普通 STA 连接不会跳过扫描。

> **Tips**：bgscan 是否还在用？Android 11+ 默认配置下，connected mode 的后台扫描由 WifiConnectivityManager 通过 wificond 触发（Framework 路径）。bgscan 模块主要用于遗留配置和某些 OEM 定制。**本篇学的是引擎，不是特定触发模块**——无论触发源是 bgscan 模块还是 WifiConnectivityManager，eloop 调度 / radio work / BSS 缓存的底层机制完全相同。

## 1.3 各种扫描最终都汇聚到 eloop 定时器

下图展示了 Supplicant 扫描引擎的完整流程——从 eloop 定时器触发到 BSS 缓存更新：

![Supplicant 扫描引擎时序图](assets/05b-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%BA%8C%EF%BC%89wpa-supplicant-%E8%87%AA%E5%B7%B1%E7%9A%84%E6%89%AB%E6%8F%8F%E5%BC%95%E6%93%8E/05b-supplicant-scan-sequence.svg)

> 注：本图为突出主干流程，省略了以下中间步骤——① 步骤 10 到 11 之间：`wpa_supplicant_event()` 事件回调入口；② 步骤 11 到 12 之间：`wpa_drv_get_scan_results()` 获取原始 BSS 列表；③ 步骤 12 到 13 之间：`wpa_bss_update_end()` 遍历 BSS 链表递增 miss_count 并淘汰过期条目（详见 §6.3）；④ 步骤 13 之前：`radio_work_done()` 释放射频队列槽位。以上步骤均在正文中详述，图中省略以保持阅读节奏。

```c
// external_wpa_supplicant_8/wpa_supplicant/scan.c
void wpa_supplicant_req_scan(struct wpa_supplicant *wpa_s, int sec, int usec)
{
    int res;

    if (wpa_s->p2p_mgmt) {           // P2P management 接口不执行 STA 扫描
        return;
    }

    res = eloop_deplete_timeout(sec, usec, wpa_supplicant_scan, wpa_s,
                                NULL);
    if (res == 1) {
        wpa_dbg(wpa_s, MSG_DEBUG, "Rescheduling scan request: %d.%06d sec",
                sec, usec);
    } else if (res == 0) {
        wpa_dbg(wpa_s, MSG_DEBUG, "Ignore new scan request for %d.%06d sec "
                "since an earlier request is scheduled to trigger sooner",
                sec, usec);
    } else {
        wpa_dbg(wpa_s, MSG_DEBUG, "Setting scan request: %d.%06d sec",
                sec, usec);
        eloop_register_timeout(sec, usec, wpa_supplicant_scan, wpa_s, NULL);
    }
}
```

去抖动逻辑：

- `eloop_deplete_timeout()` 检查是否已有 `wpa_supplicant_scan` 的定时器在排队——如果有且触发时间更早，则忽略新请求（`res == 0`）；如果新请求更早，则替换（`res == 1`）
- **这是一种去抖动机制**——短时间内多次调用 `wpa_supplicant_req_scan()` 不会导致多次扫描，只有最早触发的那个会生效
- `eloop_register_timeout()` 注册的到期回调就是 `wpa_supplicant_scan()`——eloop 事件循环在 `select()` 超时到期后自动调用它

## 1.4 eloop 定时器机制——Supplicant 的「心跳」

`eloop_register_timeout()` 是 Supplicant 中最核心的调度原语。它把一个超时事件插入 eloop 的**有序双向链表**（按到期时间升序排列）：

```c
// external_wpa_supplicant_8/src/utils/eloop.c
int eloop_register_timeout(unsigned int secs, unsigned int usecs,
                           eloop_timeout_handler handler,
                           void *eloop_data, void *user_data)
{
    struct eloop_timeout *timeout, *tmp;

    timeout = os_zalloc(sizeof(*timeout));
    if (timeout == NULL)
        return -1;
    // ...os_get_reltime() 获取当前时间 + 计算绝对到期时间...
    // 注：源码有两个 goto overflow 检查点（sec 加法溢出和 usec 进位后溢出），
    // overflow 标签会 os_free(timeout) 并返回 0（该超时被视为永不触发、静默忽略，不崩溃），此处省略
    timeout->time.sec += secs;
    timeout->time.usec += usecs;
    while (timeout->time.usec >= 1000000) {
        timeout->time.sec++;
        timeout->time.usec -= 1000000;
    }
    timeout->handler = handler;
    timeout->eloop_data = eloop_data;
    timeout->user_data = user_data;     // eloop_deplete_timeout 按 handler+eloop_data+user_data 三元组匹配

    /* 按到期时间升序插入双向链表 */
    dl_list_for_each(tmp, &eloop.timeout, struct eloop_timeout, list) {
        if (os_reltime_before(&timeout->time, &tmp->time)) {
            dl_list_add(tmp->list.prev, &timeout->list);
            return 0;
        }
    }
    dl_list_add_tail(&eloop.timeout, &timeout->list);
    return 0;
}
```

设计要点：

- 链表按到期时间升序排列——`eloop_run()` 中的 `select()` 只取链表头的时间作为超时值
- 这意味着 eloop 的 `select()` 调用总是自动选择**最近到期的超时**——不需要手动管理多个定时器
- 扫描的回调 `wpa_supplicant_scan` 就是通过这个机制被调度的——eloop 不关心下一个超时来自扫描、EAPOL 还是 P2P，它只按时间顺序调度，这种「时间优先」的设计让所有异步操作在同一个事件循环中自然排队

---

# 2 wpa_supplicant_scan() — 参数构建的三个列表

确定了"何时扫"（eloop 调度 + radio work 排队），接下来要决定"扫什么"——就像雷达需要设定扫描扇区、频段和信号模式。`wpa_supplicant_scan()` 是 Supplicant 扫描的**主入口**，它不直接执行扫描，而是构建好所有参数后通过 radio work 排队。核心是三个列表的构建：SSID 列表（找谁）、频率列表（在哪找）、IE 列表（带什么附加信息）。

## 2.1 前置检查——这些情况下不扫描

`wpa_supplicant_scan()` 在构建参数之前先走一遍**提前退出检查**。以下是源码中实际存在的退出路径（按逻辑分组，非严格代码顺序）：

| 条件                                                         | 行为                                                         | 设计意图                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------- |
| `wpa_s->wpa_state == WPA_INTERFACE_DISABLED`                 | 直接返回                                                     | 接口未启用                                  |
| `wpa_s->disconnected && scan_req == NORMAL_SCAN_REQ`         | 设置 `WPA_DISCONNECTED` 后直接返回                           | 断连态的普通扫描不需要——手动/初始扫描仍放行 |
| `wpa_s->scanning`                                            | `wpa_supplicant_req_scan(wpa_s, 1, 0)` 重新调度              | 已有扫描进行中——推迟 1 秒                   |
| `connect_without_scan` 已设置（非手动请求时）                | 跳过扫描参数构建，直接跳转到 `wpa_supplicant_associate()`    | 已有缓存 BSS 信息，不扫直接连               |
| 无 enabled 网络 且 `scan_req == NORMAL_SCAN_REQ`             | 调用 `wpa_supplicant_set_state(wpa_s, WPA_INACTIVE)` 后返回  | 非手动扫描 + 无网络 = 不扫                  |
| wired 驱动强制 `ap_scan = 0`                                 | 覆写 `ap_scan` 为 0，后续通过 `ap_scan == 0` 检查退出（跳过参数构建和扫描下发） | 有线网卡不执行 STA 扫描                     |
| `ap_scan == 0`（无线网卡）                                   | 直接返回                                                     | 驱动负责扫描                                |
| `wpas_p2p_in_progress(wpa_s)` 且非 P2P GO 且当前 SSID mode 非 AP/P2P_GO | `wpa_supplicant_req_scan(wpa_s, 5, 0)` 推迟 5 秒             | P2P 操作中 STA 扫描让路                     |
| PNO 进行中 (`wpa_s->pno \|\| wpa_s->pno_sched_pending`)      | `wpa_supplicant_req_scan(wpa_s, 0, 100000)` 推迟 100ms       | PNO 优先                                    |

**关键设计**：拒绝不丢弃——多数情况通过 `wpa_supplicant_req_scan()` 重新调度。另外 `wpa_supplicant_trigger_scan()` 中还有一个独立检查——如果已有 `scan_work` 在排队则拒绝（radio work 串行化保证同时间只有一个扫描 work）。

## 2.2 SSID 列表构建——找谁？

扫描参数的 SSID 列表决定了 Probe Request 中携带的 SSID。构建优先级如下：

```
手动扫描: 用 scan_req 中的 SSID 列表
    ↓ (如果没有手动请求)
P2P 场景: 特定 SSID + BSSID（如 WPS provisioning）
    ↓ (如果不是 P2P)
通用场景: 遍历 wpa_s->conf->ssid 链表
    └── 加入 scan_ssid=1 且未禁用的网络 SSID
    └── max_ssids==1 时交替 wildcard 和具体 SSID
```

源码中 SSID 链表遍历的简化版（`wpa_supplicant_scan()` 内，第 1213-1302 行区域，省去 OWE 追加与 log）：

```c
// scan.c: wpa_supplicant_scan() — SSID 列表构建的核心逻辑
/* 找到上次扫描的断点，从这里继续往下遍历 */
ssid = wpa_s->conf->ssid;
if (wpa_s->prev_scan_ssid != WILDCARD_SSID_SCAN) {
    while (ssid) {
        if (ssid == wpa_s->prev_scan_ssid) {
            ssid = ssid->next;  // 从上次断点的下一个开始
            break;
        }
        ssid = ssid->next;
    }
}

while (ssid) {
    if (!wpas_network_disabled(wpa_s, ssid) && ssid->scan_ssid) {
        // 只有 scan_ssid=1 且未禁用的网络才加入扫描列表
        params.ssids[params.num_ssids].ssid = ssid->ssid;  // 直接引用，不复制
        params.ssids[params.num_ssids].ssid_len = ssid->ssid_len;
        params.num_ssids++;
        if (params.num_ssids + 1 >= max_ssids)
            break;  // 预留一个 wildcard 槽位
    }
    ssid = ssid->next;
}
```

核心机制：

- **断点续扫**：`prev_scan_ssid` 记录上次扫描到哪个 SSID，本次从下一个开始——这样不会每次都从链表头扫，节省时间；扫完链表末尾或驱动重初始化时重置为 `WILDCARD_SSID_SCAN`，下一轮从头再扫
- **只扫需要主动探测的网络**：`scan_ssid=1` 的才加入（隐藏网络），普通广播 SSID 的网络用 wildcard 一次扫出
- **`max_ssids` 限制**：受 `wpa_s->max_scan_ssids`（驱动能力上限）和 `WPAS_MAX_SCAN_SSIDS`（Supplicant 硬上限 16）双重约束

**为什么 `max_ssids`==1 时要交替？** 如果驱动只支持一次扫描携带一个 SSID（如某些老驱动），Supplicant 会交错发送 wildcard SSID（探测所有 AP）和具体 SSID（探测隐藏网络）——这样既不会错过一般 AP，也能发现隐藏网络。

## 2.3 频率列表构建——在哪扫？

频率（信道）的构建是 `wpa_supplicant_scan()` 中最精细的部分。以下 7 级是通用场景的优先级；P2P/WPS 场景下 `wpa_supplicant_optimize_freqs()`（`scan.c:434`，`#ifdef CONFIG_P2P`）会在所有级别之前预设频率——P2P provisioning 时限制扫描到 GO 首选频点或共同信道，减少无效扫描。优先级从高到低：

| 优先级    | 来源                              | 代码中的判断顺序（`scan.c:1377-1409`）                       |
| --------- | --------------------------------- | ------------------------------------------------------------ |
| 1（最高） | `manual_scan_freqs`               | `wpa_s->last_scan_req == MANUAL_SCAN_REQ && wpa_s->manual_scan_freqs` |
| 2         | `select_network_scan_freqs`       | `wpa_s->select_network_scan_freqs`（当前 SSID 配置的扫描频率） |
| 3         | `next_scan_freqs`                 | BTM 漫游候选频率列表                                         |
| 4         | `setband_scan_freqs`              | `wpa_setband_scan_freqs()`——用户设置的频段（2.4G/5G）        |
| 5         | `initial_freq_list` / `freq_list` | `INITIAL_SCAN_REQ` 时用 `initial_freq_list`，否则用 `freq_list` |
| 6         | `scan_cur_freq`                   | `wpa_s->conf->scan_cur_freq` 启用时，将当前连接频率加入列表  |
| 7（最低） | 默认全频段                        | 以上全部为空时，不设置 `params.freqs`，驱动扫全部支持的信道  |

```c
// scan.c: wpa_supplicant_scan() — 频率来源的实际代码
if (wpa_s->last_scan_req == MANUAL_SCAN_REQ && params.freqs == NULL &&
    wpa_s->manual_scan_freqs) {
    params.freqs = wpa_s->manual_scan_freqs;     // ① 手动指定的频率
    wpa_s->manual_scan_freqs = NULL;              // 用完即清，防止下次复用
}

if (params.freqs == NULL && wpa_s->select_network_scan_freqs) {
    params.freqs = wpa_s->select_network_scan_freqs; // ② 当前网络配置的频率
    wpa_s->select_network_scan_freqs = NULL;
}

if (params.freqs == NULL && wpa_s->next_scan_freqs) {
    params.freqs = wpa_s->next_scan_freqs;           // ③ BTM 漫游候选频率
}
wpa_s->next_scan_freqs = NULL;
wpa_setband_scan_freqs(wpa_s, &params);              // ④ 频段限制

// ⑤ 启动扫描时用 initial_freq_list，后续用 freq_list
if (wpa_s->last_scan_req == INITIAL_SCAN_REQ &&
    wpa_s->conf->initial_freq_list && !params.freqs) {
    int_array_concat(&params.freqs, wpa_s->conf->initial_freq_list);
} else if (wpa_s->conf->freq_list && !params.freqs) {
    int_array_concat(&params.freqs, wpa_s->conf->freq_list);
}
// 如果以上全部为空 → params.freqs = NULL → 驱动扫描全部支持的信道
```

优先级逻辑：

- **链式 fallthrough**：每个 `if` 都检查 `params.freqs == NULL`——一旦前面设置了频率就不再覆盖
- **用完即清**：`manual_scan_freqs`、`select_network_scan_freqs` 在赋值后置 NULL——防止下次扫描误复用
- **默认不设 = 全扫**：如果所有来源都为空，`params.freqs` 保持 NULL，驱动默认扫全部支持的信道

## 2.4 IE 构建——带什么附加信息？

`wpa_supplicant_extra_ies()` 函数构建 Probe Request 中携带的额外信息元素（Information Element）：

| IE 类别                   | 内容                     | 何时携带             |
| ------------------------- | ------------------------ | -------------------- |
| **MLD probe**             | 多链路探测信息（WiFi 7） | 支持 MLO 时          |
| **Extended Capabilities** | 扩展能力声明             | 始终                 |
| **Interworking**          | 运营商互通、ANQP         | 启用 Interworking 时 |
| **WPS**                   | Wi-Fi 保护设置           | WPS 配网中           |
| **P2P**                   | P2P 设备信息             | P2P 操作中           |
| **MBO/OCE**               | 运营商优化               | 运营商特性启用时     |
| **Vendor Specific**       | 厂商自定义 IE            | 上层传入时           |

> 上表列出主要 IE 类别，完整列表还包括 Hotspot 2.0（`wpas_hs20_add_indication`）、FST（`wpa_s->fst_ies`）、Mesh（`wpa_supplicant_mesh_add_scan_ie`）等按编译配置和运行状态条件添加的 IE。

源码入口：`wpa_supplicant_extra_ies()`（`scan.c:724`）——根据当前运行状态（ML 探测、P2P 接口类型、Interworking/HS20/FST 配置等）和编译配置（`CONFIG_P2P`、`CONFIG_WPS`、`CONFIG_HS20` 等）条件性追加各类 IE 到 `wpabuf` 中，再由 `wpa_supplicant_scan()` 赋值到 `wpa_driver_scan_params.extra_ies`。

这些 IE 决定了 AP 回复的 Probe Response 中会包含哪些能力信息——可以理解为 STA 在 Probe Request 中说的「我会这些，请告诉我你对应支持什么」。

## 2.5 MAC 地址随机化

扫描时的 MAC 随机化策略在 `wpas_trigger_scan_cb()` 中生效：

```c
if ((wpa_s->mac_addr_rand_enable & MAC_ADDR_RAND_SCAN) &&
    wpa_s->wpa_state <= WPA_SCANNING)
    wpa_setup_mac_addr_rand_params(params, wpa_s->mac_addr_scan);
```

**关键判断**：`wpa_state <= WPA_SCANNING`——已连接状态下扫描不使用随机 MAC。这是因为已连接时的扫描通常是漫游场景（寻找同 ESS 的其他 AP），使用随机 MAC 会让 AP 不认识你，漫游就无法加速（无法复用 PMKSA 缓存）。

---

# 3 radio work — 为什么扫描要排队？

同一台射频同一时间只能干一件事。radio work 队列是 Supplicant 内部所有射频操作（扫描、连接、P2P 发现、offchannel 操作）的**串行化机制**——它确保不会有两个操作同时抢占射频。

同一台雷达天线上，你不能同时执行两套扫描任务（两套的信道列表、dwell time、增益参数都不同）。radio work 队列就是这台雷达的任务调度器——参数构建决定「扫什么」，radio work 决定「何时扫」，两者正好接上 §二构建好的扫描参数。

![radio work 队列与互斥规则](assets/05b-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%BA%8C%EF%BC%89wpa-supplicant-%E8%87%AA%E5%B7%B1%E7%9A%84%E6%89%AB%E6%8F%8F%E5%BC%95%E6%93%8E/05b-radio-work-queue.svg)

## 3.1 数据结构

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant_i.h
struct wpa_radio {
    char name[16];              // 射频名称（驱动提供）
    struct wpa_supplicant *external_scan_req_interface;  // 外部扫描请求接口（协调 Framework 扫描，无外部扫描时为 NULL）
    unsigned int num_active_works;  // 当前激活的 work 数量
    struct dl_list ifaces;      // 共享此射频的接口链表
    struct dl_list work;        // work 队列（双向链表）
};

struct wpa_radio_work {
    struct dl_list list;        // 链表节点
    unsigned int freq;          // 操作频率（0 = 多信道，非 0 = 单信道）
    const char *type;           // 类型标签："scan"/"p2p-scan"/"connect"等
    struct wpa_supplicant *wpa_s;
    void (*cb)(struct wpa_radio_work *work, int deinit);  // 回调函数
    void *ctx;                  // 回调的上下文（如 wpa_driver_scan_params）
    unsigned int started:1;     // 是否已开始执行
    struct os_reltime time;     // 入队时间
    unsigned int bands;         // 涉及的频段
};
```

**关键字段**：

- `freq = 0` 表示多信道操作（如扫描），不锁定特定信道——只要驱动不支持 `OFFCHANNEL_SIMULTANEOUS`，它就和所有其他 work 互斥
- `freq != 0` 表示单信道操作（如 P2P listen 在某信道上），只阻塞同频段的其他 work
- `started` 标志区分「排队中」和「执行中」——`radio_work_done()` 只在 `started = 1` 时触发下一个 work

## 3.2 radio_add_work() — 加入队列

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant.c
int radio_add_work(struct wpa_supplicant *wpa_s, unsigned int freq,
                   const char *type, int next,
                   void (*cb)(struct wpa_radio_work *work, int deinit),
                   void *ctx)
{
    struct wpa_radio *radio = wpa_s->radio;
    struct wpa_radio_work *work;
    int was_empty;

    work = os_zalloc(sizeof(*work));
    work->freq = freq;
    work->type = type;
    work->wpa_s = wpa_s;
    work->cb = cb;
    work->ctx = ctx;
    if (freq)
        work->bands = wpas_freq_to_band(freq);
    else if (os_strcmp(type, "scan") == 0 || os_strcmp(type, "p2p-scan") == 0)
        work->bands = wpas_get_bands(wpa_s,
                         ((struct wpa_driver_scan_params *)ctx)->freqs);
    else
        work->bands = wpas_get_bands(wpa_s, NULL);

    was_empty = dl_list_empty(&wpa_s->radio->work);
    if (next)
        dl_list_add(&wpa_s->radio->work, &work->list);     // 插入队头
    else
        dl_list_add_tail(&wpa_s->radio->work, &work->list); // 插入队尾

    if (was_empty) {
        /* 队列之前是空的——立即调度 */
        radio_work_check_next(wpa_s);
    } else if ((wpa_s->drv_flags & WPA_DRIVER_FLAGS_OFFCHANNEL_SIMULTANEOUS)
               && radio->num_active_works < MAX_ACTIVE_WORKS) {
        /* 驱动支持并发 offchannel——尝试立即调度 */
        radio_work_check_next(wpa_s);
    }
    return 0;
}
```

调度策略：

- **`next` 参数控制优先级**：`next=1` 插入队头（更高优先级），`next=0` 插入队尾
- **频段自动计算**：扫描类型从 `wpa_driver_scan_params` 的 `freqs` 中推断频段，非扫描类型从全局配置推断
- **并发策略**：队列为空时立即调度；如果驱动支持 `OFFCHANNEL_SIMULTANEOUS` 且激活数未满，即使有正在执行的 work 也尝试并发

## 3.3 单信道 vs 多信道的互斥规则

radio work 的互斥逻辑在 `radio_work_check_next()` 中实现：

| 当前激活的 work          | 队列中等待的 work | 能否并发？                               |
| ------------------------ | ----------------- | ---------------------------------------- |
| 无                       | 任意              | ✅ 立即激活                               |
| freq=0（多信道，如扫描） | freq=0            | ❌ 互斥，排队                             |
| freq=0（多信道）         | freq!=0（单信道） | ❌ 互斥（除非 `OFFCHANNEL_SIMULTANEOUS`） |
| freq=2412                | freq=2412         | ❌ 同信道互斥                             |
| freq=2412                | freq=5180         | ✅ 可并发（不同频段）                     |

开启 `OFFCHANNEL_SIMULTANEOUS` 后，多信道 scan work 可与不同频段的单信道 work 并发；否则一律串行。

**设计要点**：扫描是 freq=0 的 work——它需要独占射频。这就是为什么扫描过程中不能同时做 P2P 发现或发起连接——它们的 work 都在队列里等着扫描完成。

## 3.4 radio_work_done() — 完成并触发下一个

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant.c
void radio_work_done(struct wpa_radio_work *work)
{
    struct wpa_supplicant *wpa_s = work->wpa_s;
    unsigned int started = work->started;

    radio_work_free(work);       // 从队列中移除并释放内存
    if (started)
        radio_work_check_next(wpa_s);  // 只有已启动的 work 完成时才触发下一个
}
```

**关键行为**：`radio_work_done()` 只在 `started=1` 时触发 `radio_work_check_next()`——如果一个 work 还在排队就被取消（如 `radio_remove_works()` 调用 `cb(work, 1)` → deinit），它不会触发下一个 work。这防止了「取消的 work 意外唤醒下一个」的问题。

## 3.5 radio_remove_works() — 取消扫描

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant.c
void radio_remove_works(struct wpa_supplicant *wpa_s,
                        const char *type, int remove_all)
{
    struct wpa_radio_work *work, *tmp;
    struct wpa_radio *radio = wpa_s->radio;

    dl_list_for_each_safe(work, tmp, &radio->work, struct wpa_radio_work, list) {
        if (type && os_strcmp(type, work->type) != 0)
            continue;
        if (!remove_all && work->wpa_s != wpa_s)
            continue;

        work->cb(work, 1);   // deinit=1 → 通知回调：这个 work 被取消了
        radio_work_free(work);
    }
    radio_work_check_next(wpa_s);  // 取消后可能释放了射频，检查是否有下一个可用
}
```

设计要点：

- 按 `type` 过滤（如 `"scan"` 只取消扫描类型的 work）
- `remove_all=1` 时跨接口取消（如禁用 radio 时清空所有排队操作）
- 回调传 `deinit=1` 让 work 的 callback 做清理（如释放 `wpa_driver_scan_params`）——被取消的 work 如果不释放它持有的扫描参数堆内存，Supplicant 作为长驻进程会持续累积泄漏

---

# 4 wpas_trigger_scan_cb() — 实际下发扫描到驱动

参数构建完成，就像雷达确定了扫描范围和模式。radio work 队列是任务调度器——现在轮到扫描任务执行了。`wpas_trigger_scan_cb()` 就是雷达操作员按下发射按钮的那一刻。当 radio work 被调度到执行时，它设置 MAC 随机化、调用 `wpa_drv_scan()` 下发扫描、处理失败重试。

```c
// external_wpa_supplicant_8/wpa_supplicant/scan.c. 教学简化版——省略 log/wpa_msg 语句
static void wpas_trigger_scan_cb(struct wpa_radio_work *work, int deinit)
{
    struct wpa_supplicant *wpa_s = work->wpa_s;
    struct wpa_driver_scan_params *params = work->ctx;
    int ret;

    if (deinit) {
        // 清理路径：radio work 被取消时走这里
        if (!work->started) {
            wpa_scan_free_params(params);
            return;
        }
        wpa_supplicant_notify_scanning(wpa_s, 0);
        wpas_notify_scan_done(wpa_s, 0);
        wpa_s->scan_work = NULL;
        return;
    }

    // MAC 随机化：仅在 wpa_state <= WPA_SCANNING 时启用
    if ((wpa_s->mac_addr_rand_enable & MAC_ADDR_RAND_SCAN) &&
        wpa_s->wpa_state <= WPA_SCANNING)
        wpa_setup_mac_addr_rand_params(params, wpa_s->mac_addr_scan);

    // 随机 MAC 分配失败 → 中止扫描（关键异常路径）
    if (wpas_update_random_addr_disassoc(wpa_s) < 0) {
        wpa_scan_free_params(params);
        radio_work_done(work);
        return;
    }

    if (wpa_s->clear_driver_scan_cache) {
        params->only_new_results = 1;
    }

    wpa_supplicant_notify_scanning(wpa_s, 1);
    ret = wpa_drv_scan(wpa_s, params);
    if (ret == 0)
        wpa_s->curr_scan_cookie = params->scan_cookie;  // vendor scan cookie（QCA 平台用）
    wpa_scan_free_params(params);
    work->ctx = NULL;

    if (ret) {
        // 失败路径：检查是否需要重试
        int retry = wpa_s->last_scan_req != MANUAL_SCAN_REQ &&
            !wpa_s->beacon_rep_data.token;
        if (wpa_s->disconnected)
            retry = 0;                  // 已断连不重试
        if (ret == -EOPNOTSUPP)
            retry = 0;                  // 驱动不支持不重试
        // ...省略 wpa_msg SCAN_FAILED、状态恢复...
        wpa_supplicant_notify_scanning(wpa_s, 0);
        wpas_notify_scan_done(wpa_s, 0);
        radio_work_done(work);
        if (retry) {
            wpa_s->scan_req = wpa_s->last_scan_req;
            wpa_supplicant_req_scan(wpa_s, 1, 0);  // 1 秒后重试
        } else if (wpa_s->scan_res_handler) {
            wpa_s->scan_res_handler = NULL;  // 清理回调处理器
        }
        return;
    }

    // 成功路径：记录扫描状态（注意 scan_work 在函数末尾，不在 if(ret==0) 内）
    os_get_reltime(&wpa_s->scan_trigger_time);
    wpa_s->scan_runs++;
    wpa_s->normal_scans++;
    wpa_s->own_scan_requested = 1;
    wpa_s->clear_driver_scan_cache = 0;
    wpa_s->scan_work = work;          // 追踪当前激活的扫描——再有请求来会被拒绝
}
```

执行路径：

- **两条路径**：`deinit=1` 是清理路径（work 被取消），`deinit=0` 是正常执行路径
- **MAC 随机化在这里生效**：在调用 `wpa_drv_scan()` 之前设置随机 MAC 参数
- **失败重试策略**：非手动扫描 + 非 `EOPNOTSUPP` + 非断连状态时，1 秒后自动重试——重试间隔是**固定 1 秒**（`wpa_supplicant_req_scan(wpa_s, 1, 0)`），不做指数退避；不重试时清理 `scan_res_handler`
- **成功后记录 `scan_work`**：`scan_work = work` 在函数最末尾（不在 `if (ret == 0)` 内）——只有成功下发扫描时才执行到这里（失败路径已提前 return），确保 `scan_work` 一定被正确设置

`wpa_drv_scan()` 是驱动接口的虚函数调用，对于 Linux 平台最终落到 `wpa_driver_nl80211_scan()`——它构建 `NL80211_CMD_TRIGGER_SCAN` 并发送到内核。这是上篇第四章中 wificond 层也调用的同一个内核命令——wificond 和 Supplicant **都可以发扫描命令**，取决于 Android 版本和 HAL 层配置。注意：这套扫描引擎是厂商无关的——QCOM/MTK 双平台在 Supplicant 侧代码完全一致，双平台差异只在 `wpa_driver_nl80211_scan()` 之下的驱动层，下篇展开。

---

# 5 扫描结果怎么回来？—— EVENT_SCAN_RESULTS 的分发链

扫描命令已经发下去了——雷达波束已经发射，接下来的问题是：回波怎么接收和处理？

驱动完成扫描后通过 nl80211 multicast 通知 Supplicant，事件经过 `wpa_supplicant_event()` 分发到 `_wpa_supplicant_event_scan_results()`，然后走一条结果处理链：获取扫描结果 → 更新 BSS 缓存 → 判断是否做网络选择。

## 5.1 事件分发

驱动完成扫描后内核发送 `NL80211_CMD_NEW_SCAN_RESULTS`，Supplicant 的事件回调被触发：

```
内核 nl80211 multicast → do_process_drv_event()
  → send_scan_event()
    → wpa_supplicant_event(EVENT_SCAN_RESULTS, data)
      → _wpa_supplicant_event_scan_results(wpa_s, data, own_request, update_only)
```

`_wpa_supplicant_event_scan_results()` 的处理优先级链（18 个主要判断节点，按逻辑分 5 组）：

**组一：自定义消费层** — 如果上层注册了回调，结果被直接消费，跳过后续所有处理

1. 自定义 `scan_res_handler`（如果有注册）→ 最高优先级，直接消费结果并返回

**组二：模式与外部检查** — 非 STA 模式或外部触发的扫描结果提前返回

2. AP 模式检查 — AP/Mesh 模式下提前返回，不做 STA 网络选择
3. external_scan 检查 — 外部请求的扫描结果（如通过 ctrl_iface 触发）提前返回

**组三：802.11 特性处理** — 各代 WiFi 特性在扫描结果上的挂钩点

4. OBSS 扫描处理（802.11ax 重叠 BSS 扫描）
5. Beacon Report 处理（802.11k 无线测量）
6. ML link probe 处理（WiFi 7 多链路探测）
7. `ap_scan==2` + WPS 搜索中检查

**组四：扫描模块调度** — autoscan/bgscan/WPS/WNM 按需消费结果

8. autoscan（自动扫描模块）
9. 断连检查（已断连 → 跳过网络选择）
10. bgscan（后台扫描模块）
11. WPS AP 信息更新
12. WNM 处理（无线网络管理）

**组五：认证与频段收尾**

13. 认证中状态检查
14. 6GHz Short SSID match 检测
15. WPS PBC Partner Link 检查（PBC 激活且配网扫描未完成 → 直接返回）
16. 6GHz 触发扫描（Short SSID 匹配后补扫 6GHz）

**收口**：释放射频资源，进入网络选择

17. `radio_work_done()` — 释放射频工作队列槽位，触发下一个排队的 work
18. 最终落到 `wpas_select_network_from_last_scan()`

回波要经过这 18 道滤波，才进入最终的网络选择。

## 5.2 获取扫描结果

在更新 BSS 缓存之前，先要从驱动/内核拉取原始扫描结果：

```
wpa_supplicant_get_scan_results()
  → wpa_drv_get_scan_results()
    → driver_nl80211_get_scan_results()
      → NL80211_CMD_GET_SCAN（NLM_F_DUMP）
        → 内核返回 BSS 列表
```

内核返回的每个 BSS 都是一个 `wpa_scan_res` 结构——包含 BSSID、频率、信号强度、TSF 时间戳、IE 数据。Supplicant 逐一提取后进入 BSS 缓存更新流程——这些原始扫描结果是瞬态的，必须持久化到 BSS 缓存中，才能跨多次扫描追踪信号变化趋势和检测 AP 是否已离开覆盖范围。

## 5.3 扫描超时保护

超时由 §4 中 `wpa_drv_scan()` 下发扫描时同步注册——驱动完成扫描后 Supplicant 事件回调中取消它。扫描超时不是 Supplicant 设置的——是**驱动层**在 `wpa_driver_nl80211_scan()` 中注册的：

```c
// driver_nl80211_scan.c — wpa_driver_nl80211_scan() 中超时注册逻辑
timeout = drv->uses_6ghz ? 20 : 10;   // ① 先判 6GHz：是则 20s
if (drv->uses_s1g)
    timeout += 5;                        // ② S1G 额外加 5s
if (drv->scan_complete_events) {
    timeout = 30;                        // ③ completion events 最后无条件覆盖为 30s
}
eloop_cancel_timeout(wpa_driver_nl80211_scan_timeout, drv, bss->ctx);
eloop_register_timeout(timeout, 0, wpa_driver_nl80211_scan_timeout,
                       drv, bss->ctx);
```

超时处理函数会先尝试 `NL80211_CMD_ABORT_SCAN` 中止扫描，若中止失败则**仍去获取已完成的那部分结果**——已经扫到的 AP 结果不会因超时而丢失。

---

# 6 BSS 缓存管理——Supplicant 的「雷达回波记忆」

Supplicant 维护了一个 BSS 缓存链表——每次扫描结果到达时，新 AP 被加入缓存，已知 AP 被更新信号和 IE，未再出现的 AP 按 `scan_miss_count` 计数淘汰。

![BSS 缓存生命周期](assets/05b-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%BA%8C%EF%BC%89wpa-supplicant-%E8%87%AA%E5%B7%B1%E7%9A%84%E6%89%AB%E6%8F%8F%E5%BC%95%E6%93%8E/05b-bss-lifecycle.svg)

> 注：`wpa_bss_update()` 节点在更新信号/IE 的同时将 `scan_miss_count` 重置为 0，并将条目移到链表末尾。图中为简洁省略此标注——完整逻辑见 §6.2 源码。

## 6.1 为什么需要 BSS 缓存？

设想你连着一个 AP，信号在 -55 dBm 到 -72 dBm 之间波动。如果没有 BSS 缓存，每次扫描结果到来时你只看当次的数据——你无法判断「这个 AP 的信号在变弱，可能需要漫游了」。BSS 缓存维护了**跨多次扫描的 BSS 状态**——信号变化趋势、IE 变更（比如 AP 升级了固件）、消失的 AP。

## 6.2 wpa_bss_update_scan_res() — 逐条更新

每一条扫描结果都会经过 `wpa_bss_update_scan_res()` 处理：

```c
// external_wpa_supplicant_8/wpa_supplicant/bss.c
void wpa_bss_update_scan_res(struct wpa_supplicant *wpa_s,
                             struct wpa_scan_res *res,
                             struct os_reltime *fetch_time)
{
    const u8 *ssid;
    struct wpa_bss *bss;

    // 陈旧结果过滤
    if (wpa_s->conf->ignore_old_scan_res) {
        // 如果 BSS 的时间戳早于 scan_trigger_time，跳过
        // ...
    }

    ssid = wpa_scan_get_ie(res, WLAN_EID_SSID);
    if (ssid == NULL || ssid[1] > SSID_MAX_LEN)
        return;  // 无有效 SSID，跳过

    // P2P 接口的特殊过滤（跳过无 P2P IE 的结果）
    // ...

    // 在缓存中查找已有 entry（按 BSSID + SSID）
    bss = wpa_bss_get(wpa_s, res->bssid, ssid + 2, ssid[1]);
    if (bss == NULL)
        bss = wpa_bss_add(wpa_s, ssid + 2, ssid[1], res, fetch_time);
    else
        bss = wpa_bss_update(wpa_s, bss, res, fetch_time);

    // 加入 last_scan_res 数组（动态扩容）
    if (wpa_s->last_scan_res_used >= wpa_s->last_scan_res_size) {
        // ...扩容（初始 32，翻倍增长）...
    }
    wpa_s->last_scan_res[wpa_s->last_scan_res_used++] = bss;
}

```

缓存逻辑：

- **BSSID + SSID 联合查重**：同一个 AP 的多个 SSID（Multi-BSSID 场景）会创建独立的缓存条目
- **`wpa_bss_add()` 做的事**：分配 `wpa_bss` 结构 → 复制 IE 数据 → 解析 RSN/HT/VHT/HE/EHT/MLO IE → 加入链表末尾
- **`wpa_bss_update()` 做的事**：比较 IE 变化 → 更新信号强度和频率 → 重置 `scan_miss_count = 0` → 移到链表末尾
- **链表按最后更新时间排序**——最新扫描到的 BSS 在链表尾部

## 6.3 BSS 过期淘汰机制

每次扫描结束后，`wpa_bss_update_end()` 遍历整个 BSS 链表，对未在本轮扫描中出现的 BSS 递增 `scan_miss_count`：

```c
// external_wpa_supplicant_8/wpa_supplicant/bss.c
void wpa_bss_update_end(struct wpa_supplicant *wpa_s, struct scan_info *info,
                        int new_scan)
{
    struct wpa_bss *bss, *n;

    if ((info && info->aborted) || !new_scan)
        return;  // 扫描被中止或不完整，不淘汰

    dl_list_for_each_safe(bss, n, &wpa_s->bss, struct wpa_bss, list) {
        if (wpa_bss_in_use(wpa_s, bss))
            continue;  // 正在使用的 BSS 不淘汰
        if (!wpa_bss_included_in_scan(bss, info))
            continue;  // 🔑 BSS 的频率或 SSID 不在本轮扫描范围内——不淘汰
        if (bss->last_update_idx < wpa_s->bss_update_idx)
            bss->scan_miss_count++;
        if (bss->scan_miss_count >=
            wpa_s->conf->bss_expiration_scan_count) {
            wpa_bss_remove(wpa_s, bss, "no match in scan");
        }
    }
}

```

**淘汰规则表**：

| 条件                                           | 行为             | 原因                                                         |
| ---------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| BSS 的频率或 SSID 不在本轮扫描范围内           | 跳过，不递增计数 | `wpa_bss_included_in_scan()` 同时检查频率和 SSID——两者之一不在就跳过淘汰（扫 2.4GHz 时不能因为 5GHz AP 没出现就淘汰它；扫特定 SSID 时也不能因为 wildcard 未匹配的 AP 没出现就淘汰它） |
| `scan_miss_count >= bss_expiration_scan_count` | 删除             | 多次扫描未出现，AP 已消失或已离开覆盖范围                    |
| `wpa_bss_in_use()` 返回 true                   | 不淘汰           | 保护顺序：`current_bss`（已连接）→ `ml_connect_probe_bss`（MLO 链路探测）→ `wnm_target_bss`（WNM 漫游目标，在 `#ifdef CONFIG_WNM` 下）→ SSID guard（不同 SSID 则跳过后续检查）→ `bssid`/`pending_bssid` 比较 → MLO link BSS。**注意**：SSID guard 是 early-return——若 BSS 的 SSID 与 `current_bss` 不同，直接返回 0（不在使用中），后续的 BSSID/MLO 检查不会执行。这防止不同网络中恰好 BSSID 相同的 BSS 被误保护 |
| 扫描被中止（`aborted`）                        | 不淘汰           | 不完整扫描不能作为「AP 消失」的可靠依据                      |

## 6.4 BSS 生命周期总结

```
新 AP 首次出现:
  → wpa_bss_add() → scan_miss_count = 0 → 加入链表末尾

已知 AP 再次出现:
  → wpa_bss_update() → 更新信号/IE → scan_miss_count = 0 → 移到链表末尾

已知 AP 本轮未出现:
  → scan_miss_count++

scan_miss_count 超过阈值:
  → wpa_bss_remove() → 从链表移除 → 释放内存

特殊保护:
  current_bss / wnm_target_bss → 不淘汰（即使 scan_miss_count 很高）

```

---

# 7 扫描结果怎么变成连接决策？——网络选择收口

扫描的目的是连接。`wpas_select_network_from_last_scan()` 遍历所有已启用网络配置，用 BSS 缓存中的最佳匹配来决定是否发起连接。

这一节只做收口——**网络选择的完整逻辑（WifiNetworkSelector 评分算法、自动连接策略）是连接章节的核心内容**。这里只展示扫描结果怎么流向连接决策：

```text
// 概念示意图——以下是逻辑简化版，非真实源码行，真实实现在 wpa_supplicant_pick_network() 中
// 实际调用链: _wpa_supplicant_event_scan_results() → wpa_supplicant_pick_network()
//             → wpa_supplicant_select_bss() → wpa_supplicant_connect()
//
// 逻辑要点（本节仅做收口，连接章节展开）：
//   1. 遍历所有已启用网络配置（按 priority 分层，不是简单链表遍历）
//   2. wpa_supplicant_select_bss() 在 BSS 缓存中匹配多要素（SSID/key_mgmt/加密方式/频率，详见 06 章）
//   3. wpa_scan_result_compar() 排序：WPA/WPA2 支持 > Privacy > SAE 优先（有条件）> est_throughput > 频段偏好 > SNR
//   4. 找到最佳 BSS → wpa_supplicant_connect() → 进入连接流程
```

**关键点**：

- `wpa_supplicant_select_bss()` 匹配多要素：SSID、key_mgmt（WPA2/WPA3）、加密方式（pairwise_cipher 如 CCMP/GCMP）、频率在当前信道列表中——具体匹配逻辑委托给 `wpa_scan_res_match()`（详见 06 章连接篇）
- `wpa_scan_result_compar()` 的排序优先级（从高到低）：**①** WPA/WPA2 支持有 RSN IE 的 AP 优先于无 RSN IE 的；**②** Privacy（加密能力）优先于 Open；**③** SAE 认证的 AP 在 SNR 足够好时（≥ GREAT_SNR 或不低于对方）优先于 PSK——低 SNR 时不保证 WPA3 优先；**④** SNR 差异 < 7dB 时比 `est_throughput`（6GHz 网络**无条件**触发 est_throughput 比较，因为 LPI/VLP 功率规则导致 SNR 不可直接跨频段比较）；**⑤** 频段偏好（6GHz > 5GHz > 2.4GHz，SNR 差异 < 5dB 时生效）；**⑥** 最终 fallback 到 SNR 全值比较
- 找到最佳 BSS 后立即发起连接——**Supplicant 的 bgscan 会主动漫游**，不需要 Framework 的指令

至此，回波筛选完毕，雷达锁定目标并转向连接。

---

# 8 总结

## 8.1 Supplicant 内部扫描的完整时间线

```
1. 外部请求到达（Framework / eloop 定时器）
   → wpa_supplicant_req_scan(sec, usec)
     → eloop_register_timeout → 排队

2. eloop 超时到期
   → wpa_supplicant_scan()
     ├── 前置检查（10+ 种不扫描的情况）
     ├── 构建 SSID 列表
     ├── 构建频率列表（7 级优先级）
     ├── 构建额外 IE
     └── wpa_supplicant_trigger_scan()
       → radio_add_work("scan", wpas_trigger_scan_cb)

3. radio work 被调度执行
   → wpas_trigger_scan_cb()
     ├── MAC 随机化设置
     ├── wpa_drv_scan() → wpa_driver_nl80211_scan()
     │   → NL80211_CMD_TRIGGER_SCAN → 内核
     └── eloop_register_timeout(timeout, scan_timeout)  // 10s/20s/30s，见 §5.3

4. 内核报告 NL80211_CMD_NEW_SCAN_RESULTS
   → wpa_supplicant_event(EVENT_SCAN_RESULTS)
     ├── 取消 10 秒超时
     ├── wpa_drv_get_scan_results()
     ├── wpa_bss_update_scan_res() × N次
     │     └── wpa_bss_add() / wpa_bss_update()
     ├── wpa_bss_update_end()
     │     └── 清理过期 BSS
     ├── radio_work_done()
     └── wpas_select_network_from_last_scan()
           └── 如果找到匹配 → wpa_supplicant_associate()
```

## 8.2 关键模块职责

| 模块           | 核心函数                                             | 职责                                     |
| -------------- | ---------------------------------------------------- | ---------------------------------------- |
| **eloop 调度** | `wpa_supplicant_req_scan()`                          | 去抖动 + 异步调度扫描                    |
| **参数构建**   | `wpa_supplicant_scan()`                              | SSID/频率/IE 三列表构建                  |
| **射频排队**   | `radio_add_work()` / `radio_work_done()`             | 保证单信道操作互斥                       |
| **扫描下发**   | `wpas_trigger_scan_cb()`                             | MAC 随机化 + `wpa_drv_scan()` + 失败重试 |
| **事件分发**   | `_wpa_supplicant_event_scan_results()`               | 18 步处理优先级链                        |
| **缓存管理**   | `wpa_bss_update_scan_res()` / `wpa_bss_update_end()` | 添加→更新→过期淘汰                       |
| **网络选择**   | `wpas_select_network_from_last_scan()`               | 最佳 BSS 匹配（收口到连接）              |

## 8.3 关键设计决策

- **异步调度而非直接调用**：扫描通过 eloop 定时器触发，允许去抖动和优先级管理
- **radio work 串行化**：不是 Supplicant 故意慢，而是射频物理上的单工性质决定的——同一时间只能在一个信道上操作
- **BSS 缓存跨扫描持久化**：`scan_miss_count` 机制让缓存自动淘汰消失的 AP，同时保护正在使用的 BSS
- **扫描失败有重试**：非手动扫描失败后自动 1 秒重试——用户不需要感知底层的偶发失败

整个 Supplicant 扫描引擎就像雷达的**自动维护程序**——自己决定何时扫、扫什么、结果怎么处理，而 Framework 只负责告诉它"我需要看什么"。radio work 是任务调度器，BSS 缓存是雷达回波记忆，eloop 是心跳时钟。三者协作，让这台雷达在无人值守时也能保持对环境的感知。

> **下一篇**：QCOM SCM 和 MTK Scan FSM 怎么执行扫描、PNO 怎么实现低功耗后台值守、WiFi 6E 的 PSC/RNR 怎么减少 75% 的信道开销。

---

*本文基于 AOSP 源码（[external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/)）+ IEEE 802.11-2024 规范写作。代码以撰写时的 main 分支为准，行号可能随版本更新而变化。*
