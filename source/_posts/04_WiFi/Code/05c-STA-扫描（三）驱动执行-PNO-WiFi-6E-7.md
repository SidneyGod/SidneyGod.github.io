---
title: STA 扫描（三）驱动执行 + PNO + WiFi 6E/7
top: 1
related_posts: true
abbrlink: a79e3ca2
date: 2026-09-19 20:22:53
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 上两篇追踪了扫描请求从 Framework 经 wificond 到 Supplicant 的完整软件路径。现在来到最底层——驱动和固件。Probe Request 是怎么变成空口电磁波的？息屏时 PNO 怎么做到几乎不耗电？WiFi 6E 的 59 个信道怎么高效扫描？驱动层是扫描性能和安全性的最后一道关口。

> **上篇回顾**：在 扫描（一）我们追踪了 Framework 的节流和状态机、wificond 的参数翻译、nl80211 的命令构建。在 扫描（二）我们深入了 Supplicant 的扫描引擎——eloop 调度、350 行参数构建、radio work 排队、BSS 缓存管理。现在，Supplicant 已经把 `NL80211_CMD_TRIGGER_SCAN` 发给了内核……驱动收到后怎么做？

# 本章导读

把整个扫描链路想象成一套**指挥体系**：Framework 是指挥中心——决定何时搜索、搜索谁（§05 上篇的节流和状态机）；Supplicant 是参谋部——把搜索意图翻译成精确的作战参数（§05 二篇的 350 行参数构建）；驱动层是前线指挥部——参数在这里经过翻译官（§1.2 的参数转换）、后勤调度（§1.4 的序列化队列）两道工序，最终变成固件能执行的射频操作。

<!--more-->

QCOM 的 SCM 像一台精心调校的工业控制器，所有扫描操作必须通过序列化队列排队。MTK 的 Scan FSM 像一个紧凑的嵌入式状态机——只有两个状态，简单直接。PNO 是这套指挥体系的**低功耗值守模式**——不必一直开满功率全频段扫描，只在预设信道上周期性侦听已知目标（§3 的哨兵机制）。WiFi 6E/7 的新机制则是为新频段设计的更高效搜索策略——哨站信道（PSC）、友军情报（RNR）、一帧多信息（Multi-BSSID）、快速脉冲（FILS），四种战术压缩搜索时间。

本章将覆盖以下内容：

- QCOM 驱动扫描全链路：HDD → OSIF → SCM → 序列化 → WMI → 固件 → inform_bss → cfg80211_scan_done
- MTK 驱动扫描全链路：cfg80211 → ioctl → OID → AIS FSM → HEM mailbox → SCN FSM → 固件
- QCOM vs MTK 架构对比：通信机制、FSM 风格、恢复策略的差异
- PNO 的完整四层链路：Framework PnoScanStateMachine → wificond IWifiScannerImpl.startPnoScan → NL80211_CMD_START_SCHED_SCAN → 固件（Supplicant 的 wpas_start_pno 是独立路径）
- PNO 指数退避策略：Android 12+ 基于移动状态的动态间隔
- WiFi 6E/7 扫描新机制：PSC、RNR、Multi-BSSID、FILS 发现帧
- 四层日志对照方法和常见问题排查

本章引用的源码和规范：

- QCOM qcacld-3.0（高通 WiFi 驱动，原 Code Aurora 源已停运，当前镜像见 CodeLinaro）
- [MTK gen4m](https://android.googlesource.com/kernel/common/+/refs/heads/android-mainline/)（联发科 WiFi 驱动）
- [external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/)
- 802.11-2024 §11.1.4（扫描过程）、§9.4.2.166（RNR）、§11.10.14（Multi-BSSID）

本文代码来自真实源码，关键路径保留，细节有精简（精简处已标注）。QCOM 和 MTK 路径各有标注。

---

# 1 QCOM 驱动：SCM → 序列化 → WMI → 固件

> QCOM 的扫描路径经过 5 层——cfg80211 回调（HDD）→ OSIF 转换 → Scan Manager（SCM）调度 → 序列化队列 → WMI 命令下发固件。每层有明确的职责边界。

![QCOM 驱动扫描时序图](assets/05c-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%89%EF%BC%89%E9%A9%B1%E5%8A%A8%E6%89%A7%E8%A1%8C-PNO-WiFi-6E-7/05c-qcom-scan-sequence.svg)

## 1.1 扫描请求怎么进入 SCM？

内核收到 `NL80211_CMD_TRIGGER_SCAN` 后调用注册在 `cfg80211_ops` 表中的 scan 回调。QCOM 驱动注册的是 `wlan_hdd_cfg80211_scan()`：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_scan.c
int wlan_hdd_cfg80211_scan(struct wiphy *wiphy,
                           struct cfg80211_scan_request *request)
{
    int errno;
    struct osif_vdev_sync *vdev_sync;

    errno = osif_vdev_sync_op_start(request->wdev->netdev, &vdev_sync);
    if (errno)
        return errno;

    errno = __wlan_hdd_cfg80211_scan(wiphy, request, NL_SCAN);

    osif_vdev_sync_op_stop(vdev_sync);
    return errno;
}
```

主要功能：

- `osif_vdev_sync_op_start/stop` 是 vdev（虚拟设备）级别的同步锁——防止并发操作同一个接口
- `__wlan_hdd_cfg80211_scan()` 构建 `scan_params` 桥接结构（包含 `source=NL_SCAN`、`default_ie`、`vendor_ie` 等），然后调用 OSIF 层的 `wlan_cfg80211_scan()`

## 1.2 wlan_cfg80211_scan() —— 参数转换中枢

![QCOM 扫描调用链](assets/05c-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%89%EF%BC%89%E9%A9%B1%E5%8A%A8%E6%89%A7%E8%A1%8C-PNO-WiFi-6E-7/05c-qcom-scan-callchain.svg)

`wlan_cfg80211_scan()` 是指挥体系中的**翻译官**——内核的标准格式在这里被逐字段翻译成 QCOM 驱动能理解的内部格式。这种翻译不是模糊的语义转述，而是一对一的精密映射——就像海关的申报窗口，每个字段的名称、类型、取值范围都必须严格对齐，不合规的输入（DSRC 信道、空 SSID 列表）在这一层被直接拦截：

| 内核参数                                | QCOM 内部字段                  | 转换逻辑                                                     |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `request->n_ssids` / `request->ssids[]` | `req->num_ssids / req->ssid[]` | 逐个复制，wildcard SSID 特殊处理，上限 `WLAN_SCAN_MAX_NUM_SSID` |
| `request->n_channels`                   | `req->chan_list.num_chan`      | 过滤 DSRC 信道、DNBS 黑名单                                  |
| `request->ie / ie_len`                  | `req->extra_ie / extra_ie_len` | 拼接 request IE + default IE + vendor IE                     |
| `request->flags`                        | `req->scan_policy_*`           | `NL80211_SCAN_FLAG_HIGH_ACCURACY` → `high_accuracy=true`     |

转换完成后调用 `wlan_schedule_scan_start_request()` → 通过 QDF（QCOM Driver Framework）的消息调度器投递到 `scm_scan_start_req()`。

## 1.3 scm_scan_start_req() —— Scan Manager 调度

```c
// qca-wifi-host-cmn/umac/scan/core/src/wlan_scan_manager.c
QDF_STATUS scm_scan_start_req(struct scheduler_msg *msg)
{
    struct wlan_serialization_command cmd = {0};
    struct scan_start_request *req = msg->bodyptr;
    struct wlan_scan_obj *scan_obj;
    QDF_STATUS status;  // 省略初始值 QDF_STATUS_SUCCESS

    if (!scm_is_scan_allowed(req->vdev)) {
        status = QDF_STATUS_E_NULL_VALUE;
        goto err;
    }
    scan_obj = wlan_vdev_get_scan_obj(req->vdev);
    // ...更新扫描参数...

    if (!req->scan_req.chan_list.num_chan) {
        scm_info("Reject 0 channel Scan");
        goto err;
    }

    cmd.cmd_type = WLAN_SER_CMD_SCAN;
    cmd.cmd_id   = req->scan_req.scan_id;
    cmd.cmd_cb   = scm_scan_serialize_callback;  // 激活时的回调
    cmd.umac_cmd = req;
    cmd.source   = WLAN_UMAC_COMP_SCAN;
    cmd.cmd_timeout_duration = req->scan_req.max_scan_time
                             + SCAN_TIMEOUT_GRACE_PERIOD;
    cmd.vdev = req->vdev;

    ser_cmd_status = wlan_serialization_request(&cmd);
    // ACTIVE → 直接执行 / PENDING → 等待 / 其他 → 失败
}
```

主要功能：

- **前置校验**：`scm_is_scan_allowed()` 做两层检查——psoc 级 `scan_disabled`（整个芯片禁扫，如 SSR 恢复期间）和 vdev 级 `scan_disabled`（单个接口禁扫），加上 vdev/scan_obj 的 NULL 检查（`wlan_scan_manager.c:369`）；信道列表不能为空
- **超时设置**：`max_scan_time + GRACE_PERIOD`——如果固件在此时限内没有回复扫描完成，序列化框架触发超时。注意如果 `scan_obj->disable_timeout` 为 true（如 P2P 扫描场景），超时被禁用（`cmd_timeout_duration = 0`）
- **提交到序列化队列**：`wlan_serialization_request()` 返回 `ACTIVE`（立即执行）、`PENDING`（排队等待）、或 `DENIED`（拒绝，含多种细分原因：规则失败、队列满等）。DENIED 时驱动调用 `scm_post_internal_scan_complete_event(req, SCAN_REASON_INTERNAL_FAILURE)` 通知所有注册的扫描事件 listener（触发上层的失败处理），然后释放 vdev 引用和请求内存——不是静默丢弃（`wlan_scan_manager.c:1524`）

## 1.4 序列化机制：为什么最多 8 个并发扫描命令？

> 所谓"8 个并发"，指的是序列化框架 Active Queue 的软件深度，**不是** 8 个 FEM 同时工作。物理上 DBS（Dual Band Simultaneous）只有 2 个 FEM，真正的并发射频操作只有 2 路。其他 6 个 active 命令是在等待 FEM 资源或与其他操作时分复用——序列化框架通过 `cmd_timeout_duration` 和 `wlan_serialization_timer` 管理超时和取消。

翻译官完成参数转换后，下一步是**后勤调度**——QCOM 的序列化框架（`wlan_serialization`）是一个通用的命令排队系统，不是扫描专用的。就像工厂流水线上的调度系统：每个工位（射频）同一时间只能处理一个工件，所有 RF 操作（扫描/连接/P2P）都必须排队。具体来说，每个操作拿到一个号码牌，Active Queue 是正在加工中的工件（最多 8 个），Pending Queue（最多 24 个）是候诊区——先到先服务，不插队。SCM 通过 `scm_scan_serialize_callback` 在四个时刻被通知：轮到你了、被取消了、超时了、释放资源。它维护两个队列：

```
Active Queue  (最多 WLAN_SER_MAX_ACTIVE_SCAN_CMDS = 8 个)    ← wlan_serialization_main_i.h
  ├── cmd[0]: SCAN scan_id=42 (运行中...)
  ├── cmd[1]: SCAN scan_id=43 (运行中...)
  └── cmd[2]: CONNECT net_id=5 (运行中...)

Pending Queue (最多 WLAN_SER_MAX_PENDING_SCAN_CMDS = 24 个)  ← wlan_serialization_main_i.h
  │ 注：24 是 SCAN 专用常量，与通用命令的 pending 队列（由 AP/STA config 控制）独立
  ├── cmd[0]: SCAN scan_id=44 (等待中...)
  ├── cmd[1]: P2P_LISTEN freq=2437 (等待中...)
  └── cmd[2]: ROC freq=5180 (等待中...)
```

**激活条件**（`wlan_serialization_is_active_scan_cmd_allowed()`）：

1. Active Queue 中同类型命令数 < `MAX_ACTIVE_SCAN_CMDS`（默认 8）
2. Pending Queue 为空（先到先服务，不插队）

**为什么是 8？** 这个数字来自固件的并发扫描能力——高通固件最多支持 8 个 vdev 同时执行扫描。驱动侧的上限与之匹配。

**状态机驱动**：`scm_scan_serialize_callback()` 是序列化框架通知 SCM 的回调——它根据 `cb_reason` 分发：

| cb_reason（省略 `WLAN_SER_CB_` 前缀） | 含义     | SCM 的操作                                                   |
| ------------------------------------- | -------- | ------------------------------------------------------------ |
| `ACTIVATE_CMD`                        | 轮到你了 | → `scm_activate_scan_request()` → `tgt_scan_start()` → WMI 下发固件 |
| `CANCEL_CMD`                          | 被取消了 | → 发送内部取消事件                                           |
| `ACTIVE_CMD_TIMEOUT`                  | 超时了   | → `scm_cancel_scan_request()` → 发送 WMI stop 到固件         |
| `RELEASE_MEM_CMD`                     | 释放内存 | → 释放 scan_start_request 和 vdev 引用                       |

## 1.5 WMI 命令下发了哪些参数给固件？

> 如果你只关心扫描流程，可以跳过下面的参数表，直接看 §1.6 扫描结果回来。参数表供需要调参或排查问题的读者参考。

当 scan work 被激活后，`tgt_scan_start()` → `send_scan_start_cmd_tlv()` 构建 WMI 命令。以下是 QCOM WMI 层 `wmi_unified_tlv.c:4563` 起传递给固件的参数：

**基础参数**：

| 参数              | 值       | 含义                  | 来源常量 |
| ----------------- | -------- | --------------------- | -------- |
| `scan_id`         | 41209    | 每次扫描递增的唯一 ID | 驱动分配 |
| `vdev_id`         | 0        | 虚拟设备 ID           |          |
| `scan_type`       | 0        | 0 = 主动扫描          |          |
| `scan_ctrl_flags` | 0xc3003e | 控制标志位集          |          |
| `scan_priority`   | 1        | 扫描优先级            |          |

**信道与定时参数**：

| 参数                    | 值        | 说明                                                   |
| ----------------------- | --------- | ------------------------------------------------------ |
| `dwell_time_active`     | 40 ms     | 2.4G/5G 主动信道停留（`CFG_ACTIVE_MAX_CHANNEL_TIME`）  |
| `dwell_time_passive`    | 110 ms    | 2.4G/5G 被动信道停留（`CFG_PASSIVE_MAX_CHANNEL_TIME`） |
| `dwell_time_active_6g`  | **60 ms** | 6GHz 主动信道停留（`CFG_ACTIVE_MAX_6G_CHANNEL_TIME`）  |
| `dwell_time_passive_6g` | **60 ms** | 6GHz 被动信道停留（`CFG_PASSIVE_MAX_6G_CHANNEL_TIME`） |
| `min_dwell_time_6g`     | 25 ms     | 6GHz 最短停留（`CFG_MIN_6G_CHANNEL_TIME`）             |

> 这些值来自 `cfg.ini` 参数经由 `scan_def` 结构体到 `scan_req` 再到 WMI 的完整链路——`cfg_get(CFG_ACTIVE_MAX_CHANNEL_TIME)` → `scan_def.active_dwell` → `scan_req.dwell_time_active` → `send_scan_start_cmd_tlv()`。**不存在** `WMI_DWELL_TIME_ACTIVE_DEFAULT` 这个编译期常量——WMI 层是纯透传。并发场景下 `conc_active_dwell` 这个独立参数（40ms）会覆盖主动 dwell；6GHz 的默认值（active/passive）都是 60ms，但并发值是独立的 40ms（`CFG_ACTIVE_MAX_6G_CHANNEL_TIME_CONC` / `CFG_PASSIVE_MAX_6G_CHANNEL_TIME_CONC` = `PLATFORM_VALUE(40, 110)`）。
> | `probe_time` | 20 ms | 每次 Probe Request 的探测时间 |
> | `n_probes` | **0**（移动）/ 2（非移动） | `CFG_SCAN_NUM_PROBES`（`cfg_scan.h`）——`PLATFORM_VALUE(0, 2)`。移动平台默认 0（固件自主决定 Probe 数量，有内置最小值，非不发 Probe）；非移动平台默认 2 |
> | `rest_time` | min 50ms / max 100ms | home 信道的恢复时间（扫描其他信道后回到工作信道） |
> | `probe_spacing` | 0 | Probe 之间的最小间隔 |
> | `idle_time` | 25 ms | 信道上的空闲等待时间 |
> | `probe_delay` | 0 | 信道调谐后的稳定等待时间 |
> | `adaptive_dwell_mode` | 4 | 自适应驻留模式 |
> | `burst_duration` | 0 | 突发扫描持续时间（0 = 禁用） |

**SSID 与 BSSID 限制**：

| 参数                      | Host 驱动值 | ath12k 内核值 | 说明                             |
| ------------------------- | ----------- | ------------- | -------------------------------- |
| `WLAN_SCAN_MAX_NUM_SSID`  | **16**      | **10**        | 一次扫描最多携带的 SSID 数       |
| `WLAN_SCAN_MAX_NUM_BSSID` | **4**       | **10**        | 一次扫描最多携带的 BSSID 数      |
| `MAX_RNR_BSS`             | **33**      | **5**         | Reduced Neighbor Report 最大条目 |
| `MAX_DEFAULT_SCAN_IE_LEN` | 2048        | —             | 默认 IE 缓冲大小                 |

**序列化队列容量**（`wlan_serialization_main_i.h`）：

| 参数                             | 值       | 说明                                                         |
| -------------------------------- | -------- | ------------------------------------------------------------ |
| `WLAN_SER_MAX_ACTIVE_SCAN_CMDS`  | **8**    | Active Queue 深度                                            |
| `WLAN_SER_MAX_PENDING_SCAN_CMDS` | **24**   | Pending Queue 深度（SCAN 专用，通用 pending 队列由 AP/STA config 另算） |
| `WLAN_MAX_ACTIVE_SCANS_ALLOWED`  | **8**    | Target-if 层的并发限制                                       |
| `WMA_HW_DEF_SCAN_MAX_DURATION`   | 30000 ms | 硬件扫描最大时长                                             |

**一个典型全频段扫描的耗时分解**（26 个信道，主动 40ms × 22 + 被动 110ms × 4，含 BSS dwell）：

```
2.4G active channels:  13 × 40ms = 520ms
5G active channels:     9 × 40ms = 360ms  
5G passive (DFS):       4 × 110ms = 440ms
─────────────────────────────────────────
纯信道 dwell total:                  1320ms
BSS dwell (有 AP 时额外停留): 11 × ~100ms ≈ 1100ms
（100ms 为典型环境实测经验值——BSS dwell 时间由固件根据 AP 密度和 Beacon 间隔动态决定，
非编译期常量。在 AP 稀疏或 Beacon 间隔长的环境中可能更短，在密集环境中可能更长）
固件处理开销:                         ~500ms
─────────────────────────────────────────
总扫描耗时（1320+1100+500=2920ms）:     ~2.9s → 最终被 `scan_max_duration`（30s）截断前自然完成
```

BSS dwell 在有 AP 的信道上额外消耗了大量时间——每发现一个 AP 就要额外停留 100ms 来收集完整的 Beacon/Probe Response 数据。这就是为什么信号密集环境中扫描更慢。

回头看这些参数，真正决定扫描耗时的是三个杠杆。

**dwell time 是最直接的调优旋钮**——主动 40ms、被动 110ms，乘以信道数就是纯信道停留的底线；上面的 26 信道场景理论下限 1320ms，如果把主动 dwell 从 40ms 调到 60ms，底线直接涨到 1560ms，18% 的额外延迟。**主动与被动的 2.75 倍差距来自 Beacon 间隔**——被动信道没有 AP 可探测时必须等至少一个 Beacon 周期（通常 100ms），而主动信道发完 Probe 就可以早退；DFS 信道强制被动扫描，所以 5G 的 4 个 DFS 信道就吃掉了 440ms，占总 dwell 的三分之一。6GHz 的设计则有意抹平了这个差距——主动和被动 dwell 统一为 60ms（`CFG_ACTIVE_MAX_6G_CHANNEL_TIME` / `CFG_PASSIVE_MAX_6G_CHANNEL_TIME` 都是 `PLATFORM_VALUE(60, 110)`），加上 PSC 将信道压缩到 15 个，6GHz 全扫的纯 dwell 只有 900ms。

**BSS dwell 是环境依赖的隐性成本**——每个被发现的 AP 额外消耗约 100ms，上面的计算中 11 个 AP 就贡献了 1100ms，几乎等于纯信道 dwell 本身；这也解释了为什么同一台设备在空旷环境（0 个 AP）中 1.8 秒扫完，在密集办公区（20+ AP）可能要 5 秒以上。其他参数如 `n_probes`（移动平台默认 0，由固件自主决定 Probe 数量）和 `rest_time`（回到工作信道的恢复时间 50-100ms）更多影响的是扫描对数据传输的干扰程度，而非扫描本身的绝对耗时。

参数配置完成，固件开始逐信道扫描。那么扫描结果是怎么回来的？

## 1.6 扫描结果回来——双管道上报

固件完成扫描后，结果通过**两条独立的管道**回传——用转播来类比，管道 A 是**实时直播**：扫描还在进行，AP 就逐个出现在屏幕上；管道 B 是**赛后集锦**：扫描全部完成后发一个完成通知。

**管道 A：逐 BSS 实时上报**

固件每扫到一个 AP，立即通过 WMI 发送 beacon/probe response 帧数据：

```
固件 → WMI 事件 → tgt_scan_bcn_probe_rx_callback()
  → 构建 scan_bcn_probe_event
    → SCM 调度 → scm_handle_bcn_probe()
      → scm_add_update_entry()
        → wlan_cfg80211_inform_bss_frame()
          → cfg80211_inform_bss_frame_data()  ← 内核 API
```

这条管道让内核的 BSS 数据库在扫描过程中就逐步被填充——不需要等扫描全部完成。

**管道 B：扫描完成事件**

固件的 `WMI_SCAN_EVENTID` 表示扫描生命周期事件（一次扫描完成、被取消、启动失败等）：

```
固件 WMI_SCAN_EVENTID → target_if_scan_event_handler()
  → tgt_scan_event_handler()
    → scm_scan_event_handler()
      → scm_scan_post_event() → 通知所有注册的 listener
        → wlan_cfg80211_scan_done_callback()
          → cfg80211_scan_done(request, &info)  ← 内核 API
```

`cfg80211_scan_done()` 是扫描的最终信号——内核收到后通过 nl80211 multicast 通知 Supplicant：扫描完成，可以来取结果了。

## 1.7 扫描结果返回全链路（连贯起来）

把下发和返回放在一起看，一次 QCOM 扫描的完整时序（对照 §1.1 的时序图）：

![QCOM 扫描完整时序图](assets/05c-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%89%EF%BC%89%E9%A9%B1%E5%8A%A8%E6%89%A7%E8%A1%8C-PNO-WiFi-6E-7/05c-qcom-full-sequence.svg)

## 1.8 扫描取消与超时

QCOM 提供两种取消方式：

| 方式         | 函数                                       | 行为                                                         |
| ------------ | ------------------------------------------ | ------------------------------------------------------------ |
| **异步取消** | `wlan_abort_scan()` → `ucfg_scan_cancel()` | 发 WMI stop，不等待                                          |
| **同步取消** | `ucfg_scan_cancel_sync()`                  | 发 WMI stop + 轮询等待扫描完成（最多 `SCM_CANCEL_SCAN_WAIT_ITERATION` 次） |

超时路径：序列化框架在 `cmd_timeout_duration` 到期后自动调用 `scm_scan_serialize_callback(ACTIVE_CMD_TIMEOUT)` → 发 WMI stop → 标记扫描失败。

---

# 2 MTK 驱动：Scan FSM → 7 层调用 → 固件

> MTK 的扫描路径比 QCOM 长（7 层调用），但 FSM 更简单——只有 IDLE 和 SCANNING 两个状态。MTK 更贴近硬件（直接操作 DMA 环），容错设计（§2.4 三级恢复）更精细。

![MTK 驱动扫描时序图](assets/05c-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%89%EF%BC%89%E9%A9%B1%E5%8A%A8%E6%89%A7%E8%A1%8C-PNO-WiFi-6E-7/05c-mtk-scan-sequence.svg)

## 2.1 7 层调用链

```
cfg80211_ops.scan = mtk_cfg_scan                       [gl_init.c]
  → mtk_cfg80211_scan()                                 [gl_cfg80211.c]
    → kalIoctl(wlanoidSetBssidListScanAdv)              [私有 ioctl]
      → wlanoidSetBssidListScanAdv()                    [wlan_oid.c]
        → aisFsmScanRequestAdv()                        [ais_fsm.c: AIS FSM]
          → mboxSendMsg(MID_AIS_SCN_SCAN_REQ_V2)        [hem_mbox.c: 邮箱]
            → scnFsmMsgStart()                           [scan_fsm.c: SCN FSM]
              → scnSendScanReqV2()                       [下发 CMD_SCAN_REQ_V2 → 固件]
```

每层职责一句话：

1. `gl_init.c` — 注册 cfg80211_ops
2. `gl_cfg80211.c` — cfg80211 回调 → MTK 内部格式
3. `wlan_oid.c` — OID（Object ID）接口，参数第一重转换
4. `ais_fsm.c` — AIS FSM（STA 模式状态机），协调扫描与连接的关系
5. `hem_mbox.c` — HEM（Hardware Event Mailbox），模块间消息传递
6. `scan_fsm.c` — SCN FSM（扫描状态机），管理扫描生命周期
7. 固件 — 执行射频操作

**参数的三重转换**：

| 阶段           | 数据结构                 | 转换内容                                         |
| -------------- | ------------------------ | ------------------------------------------------ |
| cfg80211 → OID | `PARAM_SCAN_REQUEST_ADV` | 提取 SSID/信道/IE/随机 MAC                       |
| OID → mailbox  | `MSG_SCN_SCAN_REQ_V2`    | 加入 MLO 分段 IE                                 |
| mailbox → 固件 | `CMD_SCAN_REQ_V2`        | 打包信道列表/驻留时间/超时/IE buffer（600 字节） |

## 2.2 Scan FSM — 只有两个状态

相比之下，MTK 的 Scan FSM 更像一个紧凑的嵌入式控制器，不像 QCOM 的工业流水线那样层层抽象。它只有两个状态，但通过 `do-while` 链式转换在一次调用中完成状态切换和命令下发——这是一种典型的嵌入式设计哲学：简单、直接、不浪费资源。

MTK 的扫描状态机出奇地简单：

```c
// scan_fsm.c: scnFsmSteps() — 真实源码使用命名的 enum ENUM_SCAN_STATE 类型，
// 且 SCAN_STATE_SCANNING 后有 SCAN_STATE_NUM 用于边界检查（此处省略）
enum {
    SCAN_STATE_IDLE = 0,     // 空闲——等待扫描请求
    SCAN_STATE_SCANNING      // 正在扫描——固件执行信道探测
};
```

没有独立的 Start/Done/Abort 状态。真实代码通过 do-while 顶部的**无条件赋值** `prScanInfo->eCurrentState = eNextState` + IDLE case 内**覆写 `eNextState` 参数**实现链式转换——不是 case 内的 if 条件分支：

```c
// scan_fsm.c: scnFsmSteps() — 教学简化版
// 省略：pending list 消息取出（LINK_REMOVE_HEAD）、V1/V2 消息分发、cnmMemFree 释放消息；
// 真实源码处理 8 种消息类型（MID_AIS_SCN_SCAN_REQ、MID_AIS_SCN_SCAN_REQ_V2、MID_BOW_*、
// MID_P2P_*、MID_RLM_*），此处直接展示 V2 路径；函数签名含 prAdapter 和 eNextState 参数
do {
    fgIsTransition = FALSE;
    prScanInfo->eCurrentState = eNextState;  // 顶部无条件赋值——这是链式转换的核心
    switch (prScanInfo->eCurrentState) {
    case SCAN_STATE_IDLE:
        scnFsmHandleScanMsgV2();             // 解析参数，填充 SCAN_PARAM 结构体
        // scnFsmSteps() IDLE case 在 scnFsmHandleScanMsgV2() 返回后，
        // 将 eNextState 设为 SCAN_STATE_SCANNING（由函数内部的 eNextState 赋值实现）
        if (eNextState != SCAN_STATE_IDLE) {
            fgIsTransition = TRUE;           // do-while 再次循环，进入 SCANNING 分支
        }
        break;
    case SCAN_STATE_SCANNING:
        scnSendScanReqV2();                  // 🟢 下发扫描到固件（第二次循环才到这里）
        break;
    }
} while (fgIsTransition);
```

同时，扫描完成和取消的处理在独立函数 `scnEventScanDone()` 和 `scnFsmMsgAbort()` 中——它们不在 FSM 的 switch-case 里。

**关键函数详解**：

| 函数                       | 文件         | 职责                                                         |
| -------------------------- | ------------ | ------------------------------------------------------------ |
| `scnFsmHandleScanMsgV2()`  | `scan_fsm.c` | 从邮箱取消息，解析扫描参数（SSID/信道/IE），填充内部 `SCAN_PARAM` 结构体。IDLE 状态下调用，仅解析参数——`eNextState` 是 `scnFsmSteps()` 的局部参数，该函数无法直接访问；状态转移由 `scnFsmSteps()` IDLE case 在调用返回后直接赋值 `eNextState = SCAN_STATE_SCANNING` 完成 |
| `scnSendScanReqV2()`       | `scan_fsm.c` | 将 `SCAN_PARAM` 打包为 `CMD_SCAN_REQ_V2`，通过 WFDMA DMA 环发送到固件。设置扫描超时定时器——如果固件在超时前没有回复完成事件，触发 §2.4 的恢复链 |
| `scnEventScanDone()`       | `scan_fsm.c` | 固件扫描完成后的回调入口。收集扫描结果，调用 `scanReportBss2Cfg80211()` 逐个 BSS 上报给 cfg80211，最终调用 `cfg80211_scan_done()` 通知内核 |
| `scnFsmSteps()`            | `scan_fsm.c` | FSM 驱动函数——`do-while` 循环执行状态转换。IDLE case 调用 `scnFsmHandleScanMsgV2()`，SCANNING case 调用 `scnSendScanReqV2()`。循环直到 `fgIsTransition == FALSE` |
| `scanReportBss2Cfg80211()` | `scan.c`     | 将固件返回的 BSS 数据逐个经 `kalIndicateBssInfo()`（`gl_kal.c:7470`，含 TSF 修正、信号强度 ×100 转换、日志记录）上报，最终调用 `cfg80211_inform_bss_frame()` 通知内核 |

**MTK 扫描的完整生命周期**：

```
请求到达:
  mtk_cfg80211_scan()
    → aisFsmScanRequestAdv()        // AIS FSM 检查是否允许扫描
      → mboxSendMsg()               // 投递到 SCN FSM 邮箱

执行:
  scnFsmSteps() [IDLE]
    → scnFsmHandleScanMsgV2()       // 解析参数
    → eNextState = SCANNING         // 状态转换
  scnFsmSteps() [SCANNING]
    → scnSendScanReqV2()            // 下发固件 + 启动超时定时器

完成:
  固件中断 → scnEventScanDone()
    → scanReportBss2Cfg80211()      // 逐 BSS 上报
    → cfg80211_scan_done()          // 通知内核扫描完成

取消:
  scnFsmMsgAbort()
    → CMD_ID_SCAN_CANCEL → 固件
    → scnFsmGenerateScanDoneMsg(CANCELLED)  // 立即生成内部完成消息
```

## 2.3 QCOM vs MTK 架构对比

| 维度         | QCOM qcacld-3.0                                              | MTK gen4m                                                    |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **通信机制** | WMI 协议栈（统一命令/事件 + 多种传输方式）                   | WFDMA DMA 环 + HEM 软件邮箱 + 独立 conninfra 电源层          |
| **下发层数** | 5 层（HDD → OSIF → SCM → 序列化 → WMI）                      | 7 层（cfg80211 → ioctl → OID → AIS FSM → HEM mailbox → SCN FSM → 固件） |
| **FSM 风格** | 事件驱动 + 双队列（active/pending），基于序列化框架的 4 种回调原因（ACTIVATE_CMD/CANCEL_CMD/ACTIVE_CMD_TIMEOUT/RELEASE_MEM_CMD）分发 | 显式 2 状态（IDLE/SCANNING），switch-case + do-while         |
| **并发控制** | 序列化框架——active/pending 双队列（8/24）                    | 无显式双队限制——消息队列自然串行化，由固件内部处理并发       |
| **参数格式** | 统一 `scan_start_request` 结构体，一次转换                   | 三重转换（PARAM → MSG → CMD），每层裁剪                      |
| **错误恢复** | 基于阈值的 SSR（SubSystem Restart）                          | 双链恢复：超时链（L1 FW Dump → L2 L1 SER）+ 零信道链（L3 Chip Reset） |
| **扫描缓存** | 无                                                           | 有 `scan_cache.c`——缓存结果跳过固件扫描                      |
| **架构哲学** | 抽象分层，扩展性强                                           | 贴近硬件，简单直接                                           |

**核心差异**：

- QCOM 像一座**设计精良的工厂**——每层有明确职责，序列化框架是所有命令的统一调度器
- MTK 像一个**紧凑的嵌入式系统**——层次深但每层职责薄，FSM 极简

## 2.4 MTK 扫描容错：三级恢复机制

> MTK 的扫描容错是嵌入在扫描 FSM 中的双链恢复设计——超时链从轻到重（L1 dump → L2 SER），零信道链直接走最重的 L3 芯片复位。正常扫描后计数器清零，只有**连续异常**才会触发。

MTK 的扫描容错实际上是**两条独立的恢复链**，不是单一的三级升级链：

**恢复链 A：超时恢复**（`scnDoScanTimeoutRecoveryCheck()`）

当扫描超时（固件没有在预期时间内返回结果）时，计数器 `ucScnTimeoutTimes` 累加：

| 等级            | 触发条件                                                     | 操作                                                | 影响                                 |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------ |
| **L1: FW Dump** | `ucScnTimeoutTimes == 2`（连续 2 次超时）                    | `HIF_TRIGGER_FW_DUMP`——抓取固件内存快照用于离线分析 | 无功能影响，扫描继续                 |
| **L2: L1 SER**  | `ucScnTimeoutTimes >= ucScanNoApRecoverTh`（NVRAM 可配，默认 3）**且** `ucScnTimeoutSubsysResetCnt < 1`（只执行一次）**且** `eConnectionState == MEDIA_STATE_DISCONNECTED`（仅无连接时） | `HIF_DRV_SER`——触发 WiFi 子系统的 L1 级别恢复       | 不影响已有连接（触发条件要求无连接） |

> L1 和 L2 是**顺序触发的两个独立 if 判断**——L1 在 `count==2` 时触发 FW Dump，L2 在 `count>=3` 时才检查连接状态。不是同一个条件的 AND。

**恢复链 B：零信道恢复**（`scnDoZeroChRecoveryCheck()`）

当扫描完成但结果为空（固件报告 0 个信道被扫描）时，计数器 `ucScnZeroChannelCnt` 累加：

| 等级               | 触发条件                                                     | 操作                                    | 影响         |
| ------------------ | ------------------------------------------------------------ | --------------------------------------- | ------------ |
| **L3: Chip Reset** | `ucScnZeroChannelCnt > 3`（连续 4 次零信道）**且** `ucScnZeroChSubsysResetCnt < 1`（只执行一次） | `RST_FLAG_CHIP_RESET`——触发完整芯片复位 | **连接断开** |

**为什么分两条链？** 超时（固件卡死）和零信道（射频硬件异常）是两种完全不同的故障模式——超时可能是固件调度问题（L1 dump + L2 SER 通常能恢复），零信道则指向硬件层面的问题（只能芯片复位）。两条链独立计数，正常扫描后各自清零。

对比 QCOM 的 SSR（SubSystem Restart——基于阈值触发整个 WiFi 子系统的崩溃恢复），MTK 的分级设计更精细——在 L1/L2 阶段就能解决问题，不需要走到 L3。

## 2.5 MTK 扫描取消

MTK 的扫描取消通过 `scnFsmMsgAbort()` 实现——它在 SCN FSM 内部处理取消请求：

```
取消请求来源:
  ├── AIS FSM: 连接请求到来时需要取消正在进行的扫描
  ├── cfg80211: 用户/框架层主动取消（如切换网络）
  └── 超时: SCN FSM 内部扫描超时

scnFsmMsgAbort()                       [scan_fsm.c]
  → 向固件发送 CMD_ID_SCAN_CANCEL         // 通知固件停止当前扫描
  → 不等待固件回复（fire-and-forget）
  → scnFsmGenerateScanDoneMsg(CANCELLED)  // 立即生成内部完成消息
    → scanReportBss2Cfg80211()         // 上报已收集的部分结果
      → cfg80211_scan_done(aborted)    // 通知内核扫描被取消
```

**与 QCOM 的对比**：QCOM 提供异步取消（`wlan_abort_scan()`）和同步取消（`ucfg_scan_cancel_sync()`）两种模式，MTK 只有一种取消路径——通过邮箱消息触发，固件确认后回调。QCOM 的序列化框架还会在超时后自动取消（`ACTIVE_CMD_TIMEOUT`），MTK 的超时恢复则走 §2.4 的分级容错链。

---

# 3 PNO — 息屏时的低功耗值守

> PNO（Preferred Network Offload）是息屏时发现已保存网络的关键机制——扫描由固件代劳，CPU 休眠，只在发现匹配网络时才唤醒。

> **Android Framework 的 PNO 直接走 wificond**（IWifiScannerImpl.startPnoScan → NL80211_CMD_START_SCHED_SCAN），不经过 Supplicant。Supplicant 的 `wpas_start_pno()` 是另一条独立路径——用于 Supplicant 自己内部的网络发现（如 bgscan 场景的 scheduled scan）。

用雷达来类比，PNO 就是它的**低功耗值守模式**。不需要一直开满功率全频段扫描，只在预设的信道上、按预设间隔、周期性侦听已知目标信号。就像哨兵每隔几分钟用望远镜扫一眼已知的敌方据点——不费电，也不错过目标。

## 3.1 Framework 层 PNO：走 wificond，不经 Supplicant

在 扫描（一）中我们讲到 `WifiScanningServiceImpl` 有三个状态机。PNO 由 `WifiPnoScanStateMachine` 管理——这个状态机像一个值班调度中心，根据设备能力自动选择值班模式：

```
WifiPnoScanStateMachine:
  mDefaultState
    └── mStartedState（父状态，处理 PNO 启停）
          ├── mHwPnoScanState（硬件 PNO——固件执行）
          │     └── mSingleScanState（PNO 匹配后补做单次扫描获取完整 IE）
          └── mSwPnoScanState（软件 PNO——定时器驱动周期扫描 + 退避算法）
```

**决策树**（`StartedState.processMessage(CMD_START_PNO_SCAN)`）：

```
硬件支持 PNO？
├── 是 → mHwPnoScanState（固件执行，功耗最低）
└── 否 → 软件 PNO 开关打开？
          ├── 是 → mSwPnoScanState（AlarmManager 定时器 + 扫描 + 退避）
          └── 否 → 返回 "not supported"
```

**HwPno 匹配后的关键行为**：PNO 结果只包含 BSSID 和 SSID——没有完整的 IE（如 RSN、HT/VHT/HE 能力）。因此收到 `CMD_PNO_NETWORK_FOUND` 后，会补做一次**单次全频段扫描**来获取完整 IE——这就是 `mSingleScanState` 的作用。

## 3.2 Supplicant 的独立 PNO 路径

`wpas_start_pno()` 是 Supplicant **内部**的 PNO 实现——用于 Supplicant 触发的网络发现（如 bgscan 场景），与 Framework 的 wificond PNO 互不相关。但底层 scheduled scan 机制相同：

```c
// external_wpa_supplicant_8/wpa_supplicant/scan.c
int wpas_start_pno(struct wpa_supplicant *wpa_s)
{
    struct wpa_driver_scan_params params;
    struct sched_scan_plan scan_plan;

    if (!wpa_s->sched_scan_supported)
        return -1;                   // 驱动不支持 scheduled scan
    if (wpa_s->pno || wpa_s->pno_sched_pending)
        return 0;                    // 已经在 PNO 或等待中
    if ((wpa_s->wpa_state > WPA_SCANNING) &&
        (wpa_s->wpa_state < WPA_COMPLETED))
        return -EAGAIN;              // 正在关联中，推迟

    // 以下为教学简化版——合并了源码中两个独立循环（计数 + 填充）的遍历逻辑。
    // 源码第一个循环用 ssid->next（全局扁平链表）遍历计数（scan.c:3462），
    // 第二个循环用 pssid[]+pnext（按优先级链表）遍历填充（scan.c:3498）——
    // next 和 pnext 是不同的链表指针：next 是全局扁平链表，pnext 是同优先级内的链表。
    // 这里展示的是第二个循环的核心模式
    num_ssid = num_match_ssid = 0;
    prio = 0;
    ssid = wpa_s->conf->pssid[prio];
    while (ssid) {
        if (!wpas_network_disabled(wpa_s, ssid)) {
            num_match_ssid++;
            if (ssid->scan_ssid)
                num_ssid++;
        }
        if (ssid->pnext)
            ssid = ssid->pnext;          // 同优先级的下一个网络
        else if (prio + 1 == wpa_s->conf->num_prio)
            break;                        // 最后一个优先级，遍历结束
        else
            ssid = wpa_s->conf->pssid[++prio];  // 切到下一个优先级的头指针
    }
    // ...填充 params.ssids[] 和 params.filter_ssids[]...

    // 设置扫描计划
    if (wpa_s->sched_scan_plans_num) {
        params.sched_scan_plans = wpa_s->sched_scan_plans;
    } else {
        scan_plan.interval = wpa_s->conf->sched_scan_interval
                           ? wpa_s->conf->sched_scan_interval : 10;
        scan_plan.iterations = 0;  // 0 = 无限循环
        params.sched_scan_plans = &scan_plan;
        params.sched_scan_plans_num = 1;
    }

    // MAC 随机化（PNO专用，与扫描的随机化策略分离）
    if ((wpa_s->mac_addr_rand_enable & MAC_ADDR_RAND_PNO) &&
        wpa_s->wpa_state <= WPA_SCANNING)
        wpa_setup_mac_addr_rand_params(&params, wpa_s->mac_addr_pno);

    ret = wpa_supplicant_start_sched_scan(wpa_s, &params);
    if (ret == 0)
        wpa_s->pno = 1;
}
```

主要功能：

- **`filter_ssids` vs `ssids`**：`filter_ssids` 包含所有已保存 SSID（用于匹配），`ssids` 只包含需要主动扫描的 SSID（隐藏网络）
- **`scan_plan`** 支持多段计划——如前 3 次用 20s 间隔，之后用 60s
- **`iterations = 0`** 表示无限循环——PNO 会一直执行，直到被停止或用户打开屏幕
- **PNO 的 MAC 随机化是独立配置的**（`MAC_ADDR_RAND_PNO` vs `MAC_ADDR_RAND_SCAN`）
- **SSID 数量有两道裁剪**：`max_sched_scan_ssids = min(wpa_s->max_sched_scan_ssids, WPAS_MAX_SCAN_SSIDS)`（驱动能力上限，典型值 16）和 `num_match_ssid > wpa_s->max_match_sets`（Supplicant match set 上限）。超出部分被静默裁剪——这就是为什么排查表中会有「SSID 数量超出固件上限」的问题

## 3.3 MTK 驱动的 PNO：NLO 状态机

MTK gen4m 驱动的 PNO 实现基于 **NLO（Network List Offload）** 状态机——在指挥体系中，普通扫描是主动出击的侦察任务，而 NLO 是固件内部的**值守哨位**：不需要驱动每次都下发命令，固件自己按预设间隔在指定信道上周期性侦听，发现匹配网络才上报。这个哨位有三个状态，独立于普通扫描的 IDLE/SCANNING：

```c
// include/mgmt/scan.h — MTK 扫描 FSM 完整状态枚举
enum ENUM_FW_SCAN_STATE {
    FW_SCAN_STATE_IDLE = 0,
    FW_SCAN_STATE_SCAN_START,              // 普通扫描
    // ... 普通扫描状态省略 ...
    FW_SCAN_STATE_SCAN_DONE,               // 普通扫描完成
    FW_SCAN_STATE_NLO_START,               // ⑧ NLO 开始——固件启动周期性侦听
    FW_SCAN_STATE_NLO_HIT_CHECK,           // ⑨ NLO 匹配检查——发现匹配网络时触发
    FW_SCAN_STATE_NLO_STOP,                // ⑩ NLO 停止——用户亮屏或主动取消
    FW_SCAN_STATE_BATCH_START,             // 批量扫描（另有用途）
    // ...
};
```

**NLO 的三状态生命周期**——哨位上岗、发现目标、哨位撤岗：

```
固件收到 NLO 命令:
  → FW_SCAN_STATE_NLO_START                              // 哨位上岗——开始值守
    → 固件按预设间隔在指定信道上周期性侦听
      → 收到 Beacon/Probe Response → FW_SCAN_STATE_NLO_HIT_CHECK  // 发现目标——核对身份
        → 匹配 SSID → 上报匹配事件到驱动 → 继续侦听    // 确认是友军——上报并继续值守
      → 用户亮屏 / 驱动取消 → FW_SCAN_STATE_NLO_STOP    // 撤岗——停止值守
```

**驱动层入口**：MTK 的 cfg80211 回调注册了 `sched_scan_start` 和 `sched_scan_stop`：

```c
// os/linux/gl_cfg80211.c
int mtk_cfg80211_sched_scan_start(struct wiphy *wiphy,
                                   struct net_device *ndev,
                                   struct cfg80211_sched_scan_request *request)
{
    // 提取 SSID 列表、匹配集、信道、间隔等参数
    // 构建 PARAM_SCHED_SCAN_REQUEST → 通过 OID 下发到固件
    // 固件进入 FW_SCAN_STATE_NLO_START
}
```

**关键行为**：

- **LowLatency 拒绝**：已连接状态下如果启用了低延迟模式，MTK 会拒绝 PNO 请求（`return -EBUSY`）——保证前台连接质量优先
- **单实例限制**：`prGlueInfo->prSchedScanRequest != NULL` 时拒绝新请求——MTK 同一时间只允许一个 PNO 实例
- **固件侧匹配**：匹配逻辑在固件内部完成，驱动只负责下发 SSID 列表和接收匹配通知

**与 QCOM PNO 的对比**：

| 维度       | QCOM                              | MTK                       |
| ---------- | --------------------------------- | ------------------------- |
| 实现层     | Host 驱动调度 + WMI 命令          | 固件内部 NLO 状态机       |
| 匹配逻辑   | Host 侧 `scm_pno_event_handler()` | 固件侧 NLO_HIT_CHECK      |
| 并发限制   | 与普通扫描共享序列化队列          | 独立于普通扫描，单实例    |
| 低延迟处理 | 无特殊拒绝逻辑                    | 已连接+低延迟模式直接拒绝 |

## 3.4 指数退避策略

Android 12+ 引入基于移动状态的 PNO 间隔调整：

| 移动状态                           | PNO 扫描间隔      | 说明                            |
| ---------------------------------- | ----------------- | ------------------------------- |
| `DEVICE_MOBILITY_STATE_STATIONARY` | 60s ×3 → **180s** | 静止——不移动，降低到 3 分钟一次 |
| `DEVICE_MOBILITY_STATE_LOW_MVMT`   | 20s ×3 → **60s**  | 步行——默认策略                  |
| `DEVICE_MOBILITY_STATE_HIGH_MVMT`  | 20s ×3 → **60s**  | 车载——默认策略                  |
| `DEVICE_MOBILITY_STATE_UNKNOWN`    | 20s ×3 → **60s**  | 默认回退                        |

**设计原理**：静止设备周围的热点环境不会变化——180 秒扫一次也不会错过新 AP。但移动设备（走路/开车）可能在 1 分钟内穿越多个 AP 覆盖区——需要更频繁地扫描。

这个行为在不同的 Android 版本中通过配置 overlay 控制：

| 配置项                                       | 默认值    | 描述                   |
| -------------------------------------------- | --------- | ---------------------- |
| `config_wifiStationaryPnoScanIntervalMillis` | 60,000 ms | 静止时前 3 次扫描间隔  |
| `config_wifiMovingPnoScanIntervalMillis`     | 20,000 ms | 移动时前 3 次扫描间隔  |
| 后续乘数                                     | ×3        | 前 3 次后间隔放大 3 倍 |

> 以上配置项定义在 Android framework 的 WiFi overlay 中（`frameworks/base/core/res/res/values/config.xml`，OEM 通过 `vendor` overlay 覆盖默认值）。`×3` 乘数通过 `config_wifiPnoScanIntervalMultiplier` 资源配置（默认值 3），在 `WifiConnectivityManager.startDisconnectedPnoScan()`（`WifiConnectivityManager.java:2631`）中读取并设置到 `PnoSettings.scanIntervalMultiplier`——不是硬编码，OEM 可通过 overlay 调整。扫描间隔的移动状态映射由 `deviceMobilityStateToPnoScanIntervalMs()`（`:2506`）完成，`handleScreenStateChanged()` 调用它来决定初始 PNO 间隔。

## 3.5 PNO 全链路总结

![PNO 双路径架构](assets/05c-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%89%EF%BC%89%E9%A9%B1%E5%8A%A8%E6%89%A7%E8%A1%8C-PNO-WiFi-6E-7/05c-pno-full-chain.svg)

```
息屏 + 断连 + 有已保存网络
  → WifiConnectivityManager.handleScreenStateChanged()
    → startDisconnectedPnoScan()
      → retrievePnoNetworkList()                      // 获取已保存网络列表
      → WifiPnoScanStateMachine (CMD_START_PNO_SCAN)
        → HwPnoScanState: ScannerImplsTracker.setHwPnoList()
          → WificondScannerImpl.startPnoScan()
            → AIDL: IWifiScannerImpl.startPnoScan()
              → wificond ScannerImpl::startPnoScan()
                → ScanUtils::StartScheduledScan()
                  → NL80211_CMD_START_SCHED_SCAN       // 下发到内核
                    → 驱动 → 固件

固件发现匹配网络:
  → wificond: IPnoScanEvent.OnPnoNetworkFound()
    → WifiPnoScanStateMachine (CMD_PNO_NETWORK_FOUND)
      → mSingleScanState: addSingleScanRequest()       // 补做全频段扫描
        → onResults() → 通知 Framework
```

---

# 4 WiFi 6E/7 扫描新机制

> 6GHz 新增 59 个 20MHz 信道，传统的逐个信道主动扫描将耗时 ~3 秒。802.11ax 引入了 PSC（减少 75% 信道）、RNR（跨频段发现）、Multi-BSSID（一个 Beacon 多 SSID）、FILS 发现帧（20ms 被动发现）四种机制来应对这个挑战。

## 4.1 问题：59 个信道怎么高效扫描？

WiFi 6E 相当于给指挥体系新增了一个大频段。传统逐个信道扫描就像地毯式搜索——太慢。四种新机制对应四种前线战术：PSC 是只搜哨站信道，RNR 是利用友军情报预知目标位置，Multi-BSSID 是一帧多信息，FILS 是用更快的脉冲频率缩短搜索周期。

| 扫描方式           | 信道数 | 每信道耗时                                       | 总耗时       |
| ------------------ | ------ | ------------------------------------------------ | ------------ |
| 传统全信道主动扫描 | 59     | ~50 ms（平均，空信道 25ms 早退 + 有 AP 时 60ms） | **~3 秒**    |
| PSC 主动扫描       | 15     | ~50 ms                                           | **~0.75 秒** |
| FILS 被动发现      | 59     | ~20 ms                                           | **~1.2 秒**  |

另外，**RNR（Reduced Neighbor Report）不是一种扫描方式**——它是 AP 在 2.4/5GHz Beacon 中附带的 6GHz 邻居信息。STA 仍在 2.4/5GHz 上扫描，结果中顺带获得了 6GHz AP 的信息——不需要在 6GHz 上做任何主动扫描。

## 4.2 PSC（Preferred Scanning Channels）

PSC 的核心思想是：只在每 4 个 20MHz 信道中选 1 个作为「哨站信道」，STA 只需在这些哨站上发送 Probe Request——就像机场安检只在登机口设卡而非逐个座位检查，覆盖关键节点就能掌握全局：

```
6GHz 信道:  1  5  9 13 17 21 25 29 33 37 41 45 49 53 57 ...
             ^        ^         ^         ^         ^
            PSC       PSC       PSC       PSC       PSC

PSC 信道列表（以 FCC/CE 为例，因 regulatory domain 变化）: 5, 21, 37, 53, 69, 85, 101, 117,
                       133, 149, 165, 181, 197, 213, 229
```

**严格限制**：在非 PSC 信道上，STA **不能**发送广播 Probe Request（wildcard SSID + wildcard BSSID）。只有收听到该信道上 AP 的 Beacon 或 FILS 发现帧后，才能发送单播 Probe Request。这防止了 6GHz 频段的「probe storm」。

**源码级：内核如何实现 PSC 过滤？** 当 Framework 设置 `NL80211_SCAN_FLAG_COLOCATED_6GHZ` 标志时，内核 `cfg80211_scan_6ghz()` 函数（`net/wireless/scan.c`）执行以下逻辑。注：此为内核代码，来自 AOSP kernel common 分支，非本仓库可验证的驱动源码：

```c
// net/wireless/scan.c — cfg80211_scan_6ghz() 核心逻辑（简化）
// ① 遍历已知 BSS，从 RNR IE 中提取同位置 6GHz AP 列表
if (rdev_req->flags & NL80211_SCAN_FLAG_COLOCATED_6GHZ) {
    list_for_each_entry(intbss, &rdev->bss_list, list) {
        cfg80211_parse_colocated_ap(ies, &coloc_ap_list);  // 解析 RNR
    }
}

// ② 如果定向扫描（1 个 SSID）且已知同 ESS 的同位置 AP → 跳过 PSC
if (count && request->n_ssids == 1 && request->ssids[0].ssid_len) {
    list_for_each_entry(ap, &coloc_ap_list, list) {
        if (ap->colocated_ess && cfg80211_find_ssid_match(ap, request)) {
            need_scan_psc = false;  // 已知目标在同位置，不需要扫 PSC
            break;
        }
    }
}

// ③ 只添加 PSC 信道（或未设 COLOCATED_6GHZ 时添加全部 6GHz 信道）
for (i = 0; i < rdev_req->n_channels; i++) {
    if (rdev_req->channels[i]->band == NL80211_BAND_6GHZ &&
        ((need_scan_psc && cfg80211_channel_is_psc(rdev_req->channels[i])) ||
         !(rdev_req->flags & NL80211_SCAN_FLAG_COLOCATED_6GHZ))) {
        cfg80211_scan_req_add_chan(request, rdev_req->channels[i], false);
    }
}
```

QCOM 驱动侧在 WMI 扫描命令中通过 `chan_p->psc_channel = 1` 标记 PSC 信道（`wma_scan_roam.c`），固件据此决定在哪些 6GHz 信道上发送 Probe Request。

## 4.3 RNR（Reduced Neighbor Report）

RNR 是**跨频段发现**的核心——AP 在 2.4/5GHz 的 Beacon 和 Probe Response 中附带其 6GHz 同位置 AP 的信息：

```
2.4GHz Beacon:
  └── Reduced Neighbor Report element:
        ├── Operating Class + Channel Number（6GHz 信道）
        ├── TBTT Information（目标 Beacon 发送时间）
        ├── BSSID（6GHz AP 的 MAC 地址）
        ├── Short SSID（SSID 的 4 字节哈希）
        └── BSS Parameters（是否同位置、是否支持 Multiple BSSID 等）
```

**关键价值**：STA 在 2.4/5GHz 上扫描时，自动获取 6GHz AP 的信息——不需要在 6GHz 上做任何扫描就发现了 6GHz 网络。这就是 `enable_6ghz_rnr` 标志的作用（对应 `NL80211_SCAN_FLAG_COLOCATED_6GHZ`，在 扫描（一）中我们见过）。

**源码级：RNR 信息如何驱动扫描决策？** 内核 `cfg80211_parse_colocated_ap()` 从已知 BSS 的 Beacon/Probe Response 中解析 RNR IE，构建 `coloc_ap_list`。核心解析逻辑在 `cfg80211_parse_colocated_ap_iter()`（`net/wireless/scan.c:721`）中——遍历 RNR element 的每个 TBTT info，过滤出 6GHz 邻居 AP 并提取 BSSID/Short SSID：

```c
// net/wireless/scan.c — cfg80211_parse_colocated_ap_iter() 核心逻辑（简化）
// 遍历 RNR element 中的每个 TBTT info 条目
if (type != IEEE80211_TBTT_INFO_TYPE_TBTT)
    return RNR_ITER_CONTINUE;           // 只处理 TBTT 类型

if (band != NL80211_BAND_6GHZ || ...)   // 只关注 6GHz 邻居
    return RNR_ITER_CONTINUE;

entry->center_freq =
    ieee80211_channel_to_frequency(info->channel, band);  // 提取 6GHz 信道

cfg80211_parse_ap_info(entry, tbtt_info, ...);  // 解析 BSSID + Short SSID
list_add_tail(&entry->list, &data->ap_list);    // 加入同位置 AP 列表
```

这个列表有两个用途：

1. **决定扫哪些 6GHz 信道**：只扫列表中 AP 所在的信道 + PSC 信道（如上面 PSC 的源码所示）
2. **避免重复扫描**：如果已知目标 AP 在同位置（`colocated_ess = true`），连 PSC 都可以跳过

这意味着 RNR 不仅是"发现"机制——它还是一种**扫描优化**机制，通过已知信息减少需要扫描的 6GHz 信道数量。用情报工作来类比：RNR 就像前线侦察兵发回的敌方据点清单——你不需要自己派人去每个山头侦察，已经有人告诉你目标在哪里了，直接去确认就行。

## 4.4 Multi-BSSID

Multi-BSSID 允许一个 AP 在单个 Beacon 中携带多个虚拟 AP（SSID）的信息：

```
单个 Beacon 帧:
  └── transmitted BSSID（主 AP）
  └── Multiple BSSID element:
        ├── non-transmitted BSSID profile 1（SSID "Guest"）
        ├── non-transmitted BSSID profile 2（SSID "IoT"）
        └── non-transmitted BSSID profile 3（SSID "Enterprise"）
```

**对扫描的影响**：STA 收到一个 Beacon 就知道这个 AP 上有 4 个 SSID——不需要收到 4 个独立的 Beacon。这在大密度部署中节省了大量空口时间。

**源码级：Multi-BSSID 如何被解析？** 在 QCOM 驱动中，帧解析器 `dot11f_unpack_ie_multi_bssid()`（`dot11f.c:2163`）负责从 Beacon 帧中提取 Multiple BSSID element 的 non-transmitted BSSID profile。内核侧，`cfg80211` 的扫描结果处理路径通过 `WLAN_EID_MULTI_BSSID_IDX`（`scan.c:2486`）识别 Multi-BSSID IE，并将每个 non-transmitted BSSID 作为独立的 BSS 条目注入 BSS 数据库：

```c
// net/wireless/scan.c — Multi-BSSID IE 解析核心逻辑（简化）
// 在 Beacon 帧的 IE 列表中找到 Multiple BSSID element 后，
// 遍历其中每个 non-transmitted BSSID profile
mbssid_index_ie = cfg80211_find_ie(WLAN_EID_MULTI_BSSID_IDX,
                                    profile, profile_len);
if (!mbssid_index_ie || mbssid_index_ie[1] < 1 ||
    mbssid_index_ie[2] == 0 || mbssid_index_ie[2] > 46 ||
    mbssid_index_ie[2] >= (1 << elem->data[0])) {
    continue;  // 无有效的 Multiple BSSID-Index element，跳过
}

data.bssid_index = mbssid_index_ie[2];
data.max_bssid_indicator = elem->data[0];
cfg80211_gen_new_bssid(tx_data->bssid,          // transmitted BSSID
                       data.max_bssid_indicator,  // 最大 BSSID 指示器
                       data.bssid_index,          // 当前索引
                       data.bssid);               // 输出：推导出的 non-transmitted BSSID
```

STA 的上层（Supplicant/Framework）看到的是完整的 BSS 列表，Multi-BSSID 的拆解对它们完全透明。RNR 解析中也检查 `IEEE80211_RNR_TBTT_PARAMS_MULTI_BSSID` 标志位（`scan.c:543`），用于判断 6GHz 邻居 AP 是否支持 Multiple BSSID。

## 4.5 FILS 发现帧（802.11ai）

FILS（Fast Initial Link Setup，802.11ai）定义了一种**轻量 Beacon**——每 20ms 发送一次（比 Beacon 的 ~100ms 快 5 倍）。FILS 发现帧的处理逻辑嵌入在内核 `cfg80211` 的 Beacon 解析路径中（`cfg80211_inform_bss_frame_data()` 收到 FILS 帧后按相同流程更新 BSS 数据库），驱动侧无需独立的 FILS 入口函数——这也是它比 PSC（§4.2 有独立的信道过滤代码）更「透明」的原因。QCOM 驱动中 FILS 相关的配置集中在 SAP 侧（`CFG_6G_SAP_FILS_DISCOVERY_ENABLED` 控制 6GHz SAP 的 FILS 发现帧发送周期，`cfg_mlme_sap.h`），STA 侧的接收完全复用标准 Beacon 处理路径——不经过任何 FILS 专用的扫描代码。这意味着在源码中搜索 FILS 相关的扫描代码不会有结果——FILS 帧的处理入口与普通 Beacon 完全相同，区别仅在帧内容。对比两种发现方式的开销：

| 参数         | 完整 Beacon              | FILS 发现帧                                 |
| ------------ | ------------------------ | ------------------------------------------- |
| 发送间隔     | ~100 TU (102.4ms)        | 20 TU (20.48ms)                             |
| 内容         | 完整 IE 列表（70+ 元素） | 核心字段：Short SSID、BSSID、信道、能力信息 |
| 被动发现时间 | ~102ms                   | ~20ms                                       |

对于 59 个 6GHz 信道的被动扫描：传统方式 ~6 秒，FILS 方式 ~1.2 秒。

---

# 5 调试与日志

> 如果说前面几节是指挥体系的设计图纸，这一节就是它的**维护手册**——当扫描出问题时，你需要知道去哪里查日志、用什么关键字搜索、每个函数在哪个层。就像飞行事故调查需要黑匣子记录一样，WiFi 扫描的排查依赖四层日志的交叉对照：Framework 的状态机日志告诉你「指挥中心下了什么命令」，Supplicant 的 `wpa_dbg()` 告诉你「参谋部怎么翻译的」，驱动的 `scm_err()` 告诉你「前线指挥部执行到哪一步卡住了」，内核的 nl80211 trace 告诉你「通信链路收到了什么」。

## 5.1 代码锚点与日志关键字速查

> **使用说明**：下面两张表用途不同——**代码锚点**是函数名/常量名，用于在源码中定位（grep 源码），它们在 dmesg/logcat 中不会以这个形式出现；**日志关键字**是 `scm_err()`、`hdd_err()` 等宏的实际输出字符串片段，用于在运行时日志中搜索（grep dmesg/logcat）。

**表 A：代码锚点（grep 源码时用）**

| 层             | 锚点                              | 锚点类型    | 作用                                  |
| -------------- | --------------------------------- | ----------- | ------------------------------------- |
| **Framework**  | `WifiScanningServiceImpl`         | 类名        | 扫描状态机实现                        |
| **Framework**  | `ScanRequestProxy`                | 类名        | 节流逻辑实现                          |
| **Supplicant** | `wpa_supplicant_scan()`           | 函数入口    | 扫描参数构建主入口                    |
| **Supplicant** | `wpas_trigger_scan_cb()`          | 回调函数    | radio work 激活时的扫描下发           |
| **Supplicant** | `wpa_bss_update_scan_res()`       | 函数入口    | BSS 缓存逐条更新                      |
| **QCOM**       | `wlan_hdd_cfg80211_scan()`        | 函数入口    | 驱动扫描入口（cfg80211 回调）         |
| **QCOM**       | `scm_scan_start_req()`            | 函数入口    | SCM 调度开始                          |
| **QCOM**       | `wlan_serialization_request()`    | 函数入口    | 序列化入队                            |
| **QCOM**       | `WMI_START_SCAN_CMDID`            | WMI 命令 ID | 下发扫描到固件（出现在 WMI trace 中） |
| **QCOM**       | `WMI_SCAN_EVENTID`                | WMI 事件 ID | 固件扫描事件（出现在 WMI trace 中）   |
| **MTK**        | `scnFsmSteps()`                   | 函数入口    | Scan FSM 状态转换                     |
| **MTK**        | `scnEventScanDone()`              | 函数入口    | 扫描完成事件处理                      |
| **MTK**        | `scnDoScanTimeoutRecoveryCheck()` | 函数入口    | 扫描超时检测                          |
| **MTK**        | `HIF_DRV_SER`                     | 宏常量      | L2 恢复操作标识                       |
| **MTK**        | `RST_FLAG_CHIP_RESET`             | 宏常量      | L3 芯片复位标识                       |

**表 B：日志关键字（grep dmesg/logcat 时用）**

| 层             | 日志宏 / 格式                              | 搜索关键字示例                                     | 含义                   |
| -------------- | ------------------------------------------ | -------------------------------------------------- | ---------------------- |
| **Framework**  | `Log.d(TAG, ...)`                          | `WifiScanningServiceImpl`                          | 状态机状态变化         |
| **Framework**  | `Log.i(TAG, ...)`                          | `throttled`                                        | 节流拒绝               |
| **Supplicant** | `wpa_dbg()`                                | `nl80211: scan request`                            | 扫描下发到内核         |
| **Supplicant** | `wpa_msg()`                                | `CTRL-EVENT-SCAN-RESULTS`                          | 扫描结果到达           |
| **Supplicant** | `wpa_dbg()`                                | `Reject scan trigger since one is already pending` | 扫描被拒绝（已有排队） |
| **Supplicant** | `wpa_msg()`                                | `CTRL-EVENT-SCAN-FAILED ret=`                      | 扫描失败及错误码       |
| **Supplicant** | `wpa_dbg()`                                | `BSS: Add new id` / `BSS: Remove`                  | BSS 缓存增删           |
| **QCOM**       | `hdd_err()` / `hdd_info()`                 | `wlan_hdd_cfg80211_scan`                           | 驱动扫描入口日志       |
| **QCOM**       | `scm_err()` / `scm_info()` / `scm_debug()` | `scm_scan_start_req`                               | SCM 调度日志           |
| **QCOM**       | `scm_err()` / `scm_info()`                 | `wlan_serialization_request`                       | 序列化入队日志         |
| **MTK**        | `log_dbg(SCN, STATE, ...)`                 | `[SCAN]TRANSITION:`                                | Scan FSM 状态转换日志  |
| **MTK**        | `log_dbg(SCN, EVENT, ...)`                 | `scnEventScanDone`                                 | 扫描完成日志           |
| **MTK**        | `log_err(SCN, ...)`                        | `scnDoScanTimeoutRecoveryCheck`                    | 扫描超时日志           |
| **内核**       | `nl80211` trace events                     | `NL80211_CMD_TRIGGER_SCAN`                         | 内核收到扫描命令       |
| **内核**       | `nl80211` trace events                     | `NL80211_CMD_NEW_SCAN_RESULTS`                     | 内核报告扫描结果       |

## 5.2 常见问题排查

| 问题               | 可能原因              | 排查方法                                                  |
| ------------------ | --------------------- | --------------------------------------------------------- |
| **扫描不返回结果** | DFS 信道被跳过        | 检查 `ChannelHelper` 日志——DFS 信道静默过滤               |
|                    | dwell time 太短       | 检查驱动 dwell_time 配置——嘈杂环境可能需要加长到 80ms+    |
|                    | Probe Response 被过滤 | 检查 IE 匹配——RSN IE 不支持、PMF 要求不满足等             |
| **扫描太慢**       | 扫描间隔被节流        | 检查 `ScanRequestProxy` 日志——是否触发节流                |
|                    | 序列化队列排队        | QCOM: 检查 serialization active queue 是否满 (8 个)       |
|                    | 隐藏网络太多          | 每个隐藏 SSID 多一次轮询——减少不必要的隐藏网络配置        |
| **PNO 不工作**     | sched_scan 不支持     | 检查 `wpa_s->sched_scan_supported`                        |
|                    | SSID 列表为空         | 检查 `num_match_ssid == 0`——没有已保存网络                |
|                    | 固件限制              | 检查 `max_sched_scan_ssids`——SSID 数量超出固件上限        |
| **PNO 耗电高**     | 退避未生效            | 检查 `scan_plan`——是否正确配置了 interval/iterations      |
|                    | 不停触发全频段        | 检查 PNO 匹配后是否每次都补单次扫描（`mSingleScanState`） |

---

# 6 总结

## 6.1 扫描三部曲覆盖的完整调用链

```
App.startScan()
  → WifiServiceImpl
    → ScanRequestProxy.startScan()           [上篇: 节流检查]
      → WifiScanningServiceImpl              [上篇: 状态机]
        → WifiNl80211Manager.startScan2()    [上篇: AIDL]
          → wificond ScannerImpl::scanRequest()  [上篇: 参数转换]
            → ScanUtils::Scan()                  [上篇: NL80211_CMD_TRIGGER_SCAN]
              → 内核 cfg80211
                → wpa_supplicant_scan()       [中篇: Supplicant 参数构建]
                  → radio_add_work("scan")    [中篇: radio work 排队]
                    → wpas_trigger_scan_cb()   [中篇: 实际下发 + MAC 随机化]
                      → driver_nl80211_scan()  [中篇: nl80211 构建]
                        → QCOM: scm_scan_start_req()  [下篇: SCM 调度]
                          → wlan_serialization         [下篇: 序列化队列]
                            → WMI_START_SCAN_CMDID     [下篇: WMI → 固件]
                        → MTK: scnFsmSteps()           [下篇: Scan FSM]
                          → CMD_SCAN_REQ_V2             [下篇: 固件命令]
                            → 固件执行 Probe Request
                              → Probe Response / Beacon 回来
                                → QCOM: WMI_SCAN_EVENTID → cfg80211_scan_done
                                → MTK: scnEventScanDone → cfg80211_scan_done
                                  → 内核 NL80211_CMD_NEW_SCAN_RESULTS
                                    → Supplicant EVENT_SCAN_RESULTS   [中篇]
                                      → wpa_bss_update_scan_res()     [中篇: BSS 更新]
                                        → wpas_select_network()       [中篇: 网络选择 → 06 章]
                                  → wificond OnScanResultReady()      [上篇: 回调]
                                    → Framework onResults()           [上篇: 分发]
```

## 6.2 QCOM vs MTK：扫描结果上报的差异

§1.6 讲了 QCOM 的双管道上报，§2.1 讲了 MTK 的 7 层调用链。这里做一个收口对比——两家的结果上报机制差异显著。QCOM 选择边扫边报（实时直播），是为了降低首次结果的延迟——用户在 Settings 中点击刷新后 0.5 秒就能看到第一批 AP 出现，不必等 2-3 秒扫描全部完成。MTK 选择完成后批量上报（赛后集锦），是为了简化驱动层复杂度——完成回调中统一处理，不需要维护扫描进行中的增量状态。两种策略是延迟与复杂度的不同权衡：

| 维度                | QCOM qcacld-3.0                                              | MTK gen4m                                                    |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **逐 BSS 上报时机** | 扫描**进行中**实时上报（管道 A：WMI 管理帧事件 → `tgt_scan_bcn_probe_rx_callback()`） | 扫描**完成后**在回调链中批量上报（`scnEventScanDone()` → `scanReportBss2Cfg80211()`） |
| **完成信号**        | `WMI_SCAN_EVENTID`（管道 B）→ `cfg80211_scan_done()`         | `scnEventScanDone()` → `cfg80211_scan_done()`                |
| **上报函数**        | `cfg80211_inform_bss_frame_data()`（逐 BSS）¹                | `kalIndicateBssInfo()` → `cfg80211_inform_bss_frame()`（逐 BSS，但在完成回调中）¹ |
| **用户体验差异**    | 扫描过程中就能看到部分 AP 出现                               | 需要等 2-3 秒扫描全部完成后才一次性看到结果                  |

¹ 两个内核 API 功能相同，区别在于参数传递方式——`cfg80211_inform_bss_frame_data()` 接受预解析的 `struct cfg80211_inform_bss` 元数据（较新的 API），`cfg80211_inform_bss_frame()` 接受原始帧数据由内核解析（较旧的 API）。这不是 QCOM/MTK 的设计选择差异，更多是内核 API 版本适配的差异。

**QCOM 双管道的设计意图**：如果只有完成事件（管道 B），用户在 Settings 中点击刷新后要等 2-3 秒才能看到任何结果。管道 A 让内核的 BSS 数据库在扫描过程中就逐步被填充——Framework 甚至可以在扫描还在进行时就拿到部分结果。

## 6.3 完整的扫描请求 → 结果返回全链路

把三篇的内容串起来，一次完整的扫描从 App 到固件再回到 UI 的全链路：

![扫描全链路时序图](assets/05c-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%89%EF%BC%89%E9%A9%B1%E5%8A%A8%E6%89%A7%E8%A1%8C-PNO-WiFi-6E-7/05c-scan-full-flow.svg)

```
【扫描请求下发】
App.startScan()                           ← 用户操作 / Settings 10s 定时
  → WifiServiceImpl                       ← 权限检查
    → ScanRequestProxy.startScan()        ← [上篇] 节流：FG 4次/120s，BG 1次/30min
      → WifiScanningServiceImpl           ← [上篇] 状态机 Idle→Scanning
        → WifiNl80211Manager.startScan2() ← [上篇] AIDL 跨进程
          → wificond ScannerImpl          ← [上篇] 参数翻译 + MAC 随机化
            → NL80211_CMD_TRIGGER_SCAN    ← [上篇] netlink 到内核

【驱动执行（QCOM 路径）】
内核 cfg80211
  → wlan_hdd_cfg80211_scan()              ← [下篇] HDD 入口
    → scm_scan_start_req()                ← [下篇] SCM 调度
      → wlan_serialization_request()      ← [下篇] 序列化队列
        → WMI_START_SCAN_CMDID            ← [下篇] 下发固件

【驱动执行（MTK 路径）】
内核 cfg80211
  → mtk_cfg80211_scan()                   ← [下篇] cfg80211 回调
    → aisFsmScanRequestAdv()              ← [下篇] AIS FSM
      → scnFsmSteps() → scnSendScanReqV2()  ← [下篇] SCN FSM → 固件

【固件执行】
固件逐信道 dwell + Probe Request/Response
  → 26 信道 dwell + BSS 收集 → ~2.9s（详见 §1.5）

【扫描结果返回】
QCOM: WMI_SCAN_EVENTID / beacon/probe 帧
  → cfg80211_scan_done()                  ← 内核 API
MTK: scnEventScanDone()
  → scanReportBss2Cfg80211()              ← 逐 BSS 上报
    → cfg80211_scan_done()                ← 内核 API
      → NL80211_CMD_NEW_SCAN_RESULTS      ← netlink multicast

Supplicant: EVENT_SCAN_RESULTS            ← [中篇]
  → wpa_bss_update_scan_res()             ← BSS 缓存更新
    → wpas_select_network()               ← 网络选择 → 06 章

wificond: OnScanResultReady()             ← [上篇] AIDL 回调
  → Framework onResults()                 ← 分发给 Settings / WifiConnectivityManager / App
```

这就是一次扫描的完整旅程——从用户点击「刷新」到 AP 列表出现在屏幕上，信号穿过了 App、Framework、wificond、Supplicant、内核、驱动、固件七层，每层都在做自己的翻译和调度工作。回到开篇的指挥体系比喻，这条链路上每个环节都有明确的角色分工：

- **指挥中心**（Framework）：决定何时搜索、搜索谁——节流机制防止搜索指令过频，WifiPnoScanStateMachine 在息屏时切换到值守模式
- **参谋部**（Supplicant）：把搜索意图翻译成精确的作战参数——350 行参数构建、radio work 排队确保射频资源串行使用
- **翻译官**（§1.2 参数转换）：内核标准格式 → 驱动内部格式的精密映射，不合规输入在此拦截
- **后勤调度**（§1.4 序列化框架）：所有射频操作统一排队，active/pending 双队列管理并发
- **前线执行**（§3 PNO/NLO）：低功耗值守哨兵——息屏时固件代劳，周期性侦听已知目标
- **态势感知**（§4 WiFi 6E/7）：哨站信道（PSC）压缩搜索范围，友军情报（RNR）跨频段预知目标位置

三篇下来，这条从 App 到空口再回到 UI 的完整链路就闭合了——指挥体系的每一层各司其职，结果沿着反向路径一层层回传，最终在 UI 上呈现为用户看到的 WiFi 列表。

## 6.4 各层关键设计决策总结

| 层         | 决策                                        | 原因                                                         |
| ---------- | ------------------------------------------- | ------------------------------------------------------------ |
| Framework  | 节流：前台 4次/120s，后台 1次/30min         | 防止 App 扫描风暴                                            |
| Framework  | WifiPnoScanStateMachine 的 HwPno/SwPno 双轨 | 兼容不同硬件能力                                             |
| wificond   | ENODEV 看门狗（4 次 → crash）               | 网卡静默失败不如 crash 重启                                  |
| Supplicant | radio work 串行化                           | 射频物理单工——同时只能做一件事                               |
| Supplicant | BSS 缓存跨扫描持久化 + scan_miss_count 淘汰 | 追踪信号趋势，自动清理消失的 AP                              |
| QCOM       | 序列化框架（active/pending 双队列）         | 所有射频命令的统一调度器                                     |
| QCOM       | 双管道上报（逐 BSS 实时 + 扫描完成事件）    | 边扫边上结果，不等全部完成                                   |
| MTK        | 2 状态 FSM（IDLE/SCANNING）                 | 极简——嵌入式场景不需要复杂状态                               |
| MTK        | 双链恢复（超时链 L1→L2 + 零信道链 L3）      | 不同故障模式用不同策略，尽量减少对用户的影响                 |
| 802.11ax   | PSC（每 4 个信道 1 个哨站）                 | 减少 75% 的 6GHz 扫描信道——指挥体系的哨站搜索策略，覆盖关键节点掌握全局 |
| 802.11ax   | RNR（跨频段发现）                           | 2.4/5GHz 扫描结果中直接带 6GHz AP 信息——友军情报预知，不必自己派人侦察 |

---

*本文基于 AOSP + 驱动源码 + IEEE 802.11-2024 规范写作。QCOM 驱动源码来自 qcacld-3.0（原 Code Aurora 源，现见 CodeLinaro），MTK 驱动源码来自 gen4m，Supplicant 源码来自 [external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/)。代码以撰写时的 main 分支为准，行号可能随版本更新而变化。*
