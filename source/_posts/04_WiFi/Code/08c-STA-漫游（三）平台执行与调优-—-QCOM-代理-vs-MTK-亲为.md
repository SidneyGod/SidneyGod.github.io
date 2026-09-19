---
title: STA 漫游（三）平台执行与调优 — QCOM 代理 vs MTK 亲为
top: 1
related_posts: true
abbrlink: c9987fc4
date: 2026-09-19 21:25:17
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 连接不是终点。当你拿着手机从一个房间走到另一个房间，信号掉到 -78dBm，STA 面临选择：撑住旧 AP，还是切到新 AP？本文追踪漫游的最后一步——**谁来执行搬家、搬错了怎么办**。漫游比作搬家：QCOM 的 RSO 是全包搬家公司，MTK 的 Host Roaming 是自己动手。本文聚焦 ESS 内漫游，分析 wpa_supplicant、QCOM qcacld-3.0、MTK gen4m 驱动及 AOSP WiFi Framework 源码（精简处标注 `// ...省略...`，文件路径标注在代码块首行）。漫游前的扫描机制见《扫描》系列，连接信令见《连接》系列，本文复用不重复。

# 1 谁来执行搬家？——QCOM 固件代理 vs MTK 驱动亲为

《STA 漫游（一）触发与决策》《STA 漫游（二）802.11k/v/r 三协议》讨论的漫游决策和协议机制，在不同平台上的实现路径截然不同。QCOM 把整个闭环卸载到固件（RSO），MTK 让驱动亲自下场（Host Roaming）。本节回答：两种架构各自的状态机长什么样？扫描调度怎么管？漫游完成后 host 怎么知道结果？

<!--more-->

## 1.1 QCOM：固件全权代理（RSO 模式）

如果说漫游是搬家，QCOM 的 RSO 就是请了一家全包搬家公司——你只管告诉它"信号低于多少就搬、搬去哪里的优先级怎么排"（配置参数），剩下的找房、打包、搬运、入住全由它完成，你只需要在搬完后收一条"已搬至新家"的短信（WMI 事件）。RSO（Roam Scan Offload）将漫游的整个闭环——扫描调度、候选评分、切换执行——全部卸载到固件。

核心数据结构 `rso_config` 包含了固件漫游所需的全部配置：

```c
// components/umac/mlme/connection_mgr/dispatcher/inc/wlan_cm_roam_public_struct.h:543（字段按逻辑分组，顺序有调整）
struct rso_config {
    struct rso_cfg_params cfg_param; // 漫游参数配置
    struct element_info assoc_ie;    // 关联 IE（重关联时复用）
    struct rso_chan_info roam_scan_freq_lst; // 漫游扫描频率列表
    bool is_11r_assoc;               // 是否 802.11r 连接
    struct mobility_domain_info mdid; // 移动域信息（FT 用）
    uint32_t mbo_oce_enabled_ap;     // MBO/OCE 使能状态
    bool is_single_pmk;              // 单 PMK 模式
    // ... 更多配置字段（cm_rso_lock、orig_sec_info、country_code 等）...
};
```

其中 `is_11r_assoc` 标记 802.11r 连接——此时 supplicant 依 `KEY_MGMT_OFFLOAD` 能力位把 FT 密钥管理整体卸载给固件，漫游时固件直接完成 FT Auth 帧交换，host 全程不可见。

漫游状态由 `enum roam_offload_state` 跟踪：

```c
// wlan_cm_roam_public_struct.h
enum roam_offload_state {
    WLAN_ROAM_DEINIT,            // 未初始化
    WLAN_ROAM_INIT,              // 已初始化
    WLAN_ROAM_RSO_ENABLED,       // RSO 已启用，固件在后台工作
    WLAN_ROAM_RSO_STOPPED,       // RSO 已停止
    WLAN_ROAMING_IN_PROG,        // 正在漫游中
    WLAN_ROAM_SYNCH_IN_PROG,     // 漫游同步中（host 与固件状态同步）
    WLAN_MLO_ROAM_SYNCH_IN_PROG, // MLO 漫游同步中
};
```

典型流程：host 连接成功后调用 `cm_roam_send_rso_cmd()`，通过 WMI 命令将 `wlan_roam_start_config`（包含扫描参数、RSSI 阈值、黑名单、候选评分权重等）下发固件。固件收到后持续监控链路质量——RSSI 掉到阈值以下时自主启动定向扫描，从候选 AP 中按评分算法选出最佳目标，执行 Auth+Reassoc+EAPOL，完成后再通过 `WMI_ROAM_EVENTID` 通知 host 结果。

候选评分的具体公式在固件内部执行，host 侧看不到——但 host 可以通过 `wlan_mlme_roam_scoring_cfg`（`wlan_mlme_public_struct.h:2283`）配置 `roam_score_delta`（候选 AP 相对当前 AP 的最低评分差值，百分比）和 `min_roam_score_delta`（候选的最低绝对评分），通过 `scoring_param`（`wlan_cm_roam_public_struct.h:880`）配置 `vendor_roam_score_algorithm`（`wlan_cm_roam_public_struct.h:901`，评分算法偏好）。`scoring_param` 里还列着各评分维度的权重：`rssi_weightage`（RSSI 占总分权重，`wlan_cm_roam_public_struct.h:882`）决定信号话语权，`band_index_score`（频段加分，:897）给高频段天然加权，`esp_qbss_scoring`、`oce_wan_scoring`（:904、:905）分别给 ESP/QBSS 负荷与 OCE WAN 指标打分，`rssi_scoring`（`wlan_cm_roam_public_struct.h:903`，`struct rssi_config_score`）按 best/good/bad 三档 RSSI 阈值做分段评分——MTK rssiFactor 的 QCOM 对应物。这些参数由 `cm_update_score_params()`（`wlan_cm_roam_offload.c:1435`）拷贝进 `scoring_param` 结构，后续由 target_if 层序列化进 WMI 命令下发固件。

固件的扫描调度由三层定时器控制。最外层是周期扫描：`gNeighborScanTimerPeriod`（默认 100s，`cfg_mlme_lfr.h:1524`）每 100 秒扫描一轮附近有没有更好的 AP。

如果上一轮没有结果，`RoamScan_FirstTimer`（默认 10s，`cfg_mlme_lfr.h:1797`）会缩短间隔快速重试；但扫描结果有保鲜期，超过 `gNeighborScanRefreshPeriod`（默认 20s，`cfg_mlme_lfr.h:1716`）就标记过期，下轮需要重新扫描。

逐信道驻留时间由 `RoamScan_ActiveCH_DwellTime`（默认 40ms，`cfg_mlme_lfr.h:80`）控制。固件在当前信道和扫描信道之间交替：当前信道至少待 `RoamScan_HomeTime`（45-50ms）保证数据不断流；离开当前信道的时间上限 `RoamScan_AwayTime`（默认 0 或 100ms，范围 0-300ms 因平台而异，`cfg_mlme_lfr.h:40-92`）控制扫描窗口——离开太久当前信道的数据会堆积丢包，太短则扫不到足够多的候选信道。

设备空闲时（数据包低于 `roam_inactive_data_count` 阈值，`cfg_mlme_lfr.h:3210`），扫描自动降频到 120 秒一轮（`roam_scan_period_after_inactivity`，`cfg_mlme_lfr.h:3241`）。所有这些参数通过一条 `WMI_ROAM_SCAN_PERIOD` 命令（`wmi_unified_roam_tlv.c:341`）打包发给固件。

漫游完成后，固件通过 `WMI_ROAM_EVENTID` 通知 host——事件携带触发原因（`roam_trigger_reason`）、漫游时的 RSSI、以及失败码（`roam_fail_reason`）。`cm_roam_event_handler()`（`wlan_cm_roam_api.c:2589`）按 `roam_event->reason` 分发——BTM、BMISS、BETTER_AP、SUITABLE_AP、INVOKE_ROAM_FAIL、DEAUTH 各有独立处理路径。此外，`roam_stats_event`（`wlan_cm_roam_api.c:3319`）单独上报扫描统计——`roam_scan_state`（started/stopped 标记扫描生命周期）和 `roam_invoke_fail_reason`（host 主动触发漫游时的失败原因）。QCOM host 驱动处理完 roam 事件后，把新关联结果上报内核 cfg80211 子系统，内核经 nl80211 下发 `NL80211_CMD_ROAM`，supplicant 的 `mlme_event_connect()` 处理该通知：

```c
// src/drivers/driver_nl80211_event.c:904（源码有精简）
static void mlme_event_connect(struct wpa_driver_nl80211_data *drv,
                               enum nl80211_commands cmd, ...)
{
    if (drv->capa.flags & WPA_DRIVER_FLAGS_SME) {
        // 驱动自己管 SME，host 不重复处理关联事件
        return;
    }

    if (cmd == NL80211_CMD_CONNECT)
        wpa_printf(MSG_DEBUG, "nl80211: Connect event");
    else if (cmd == NL80211_CMD_ROAM)
        wpa_printf(MSG_DEBUG, "nl80211: Roam event");

    // ... 构建 assoc_info 事件数据 ...

    wpa_supplicant_event(drv->ctx, EVENT_ASSOC, &event);
}
```

固件完成漫游切换后，还需要与 host 同步状态——这就是 roam_synch 机制。固件通过 WMI 事件携带 `roam_synch_data`，其中 `roam_synch_frame_ind`（`wlan_cm_roam_public_struct.h:449`）包含新 AP 的 Beacon/Probe Response 帧副本和 Reassoc Request/Response 帧副本，host 在 `WLAN_ROAM_SYNCH_IN_PROG` 状态下解析这些数据并重建 supplicant 的关联状态——更新 `wpa_s->bssid`、重新配置密钥、刷新 BSS 缓存。这个过程对 supplicant 透明：它只看到一个 `NL80211_CMD_ROAM` 事件，不知道切换已在固件中完成。如果 host 唤醒延迟导致同步失败（`REASON_ROAM_SYNCH_FAILED`，`wlan_cm_roam_public_struct.h:76`），驱动触发断连，上层走完整重连流程。这解释了为什么 RSO 模式下漫游看起来"无感"——固件完成了切换，host 只需更新状态，不参与实际的帧交换。

RSO 将决策下沉到固件，同时获得延迟、功耗、实时性三方面的改善——固件直控射频无需经过 host 内核栈，低功耗逐信道驻留无需唤醒 AP 处理器，专用处理器不受 host CPU 负载波动影响。

代价是黑盒：host 看不到固件的决策过程，出问题时定位困难。这也是 QCOM 在 `rso_config` 中保留 `roam_fail_reason` 和 `roam_trigger_reason` 字段的原因——至少漫游失败后 host 能知道"为什么失败"。调试时，host 可通过 `WMI_ROAM_EVENTID` 携带的 `roam_trigger_reason`、`roam_fail_reason` 和 `rssi` 字段回溯漫游触发和结果，配合 QXDM 抓取固件侧 roam scan log 可还原完整决策链路。

## 1.2 MTK：驱动亲自下场（Host Roaming）

RSO 把决策权交给了固件，但不是所有平台都走这条路。MTK 走了完全相反的路线——如果 QCOM 的 RSO 是请全包搬家公司，MTK 的 Host Roaming 就是自己动手搬家：每个箱子什么时候打包、走哪条路线、先搬哪个房间，全由你亲自决定。好处是一目了然——哪一步出了问题立刻就知道；坏处是慢——每一步都要自己跑一趟。驱动层维护显式的 8 状态 FSM，每一步都由 host 驱动控制。

```c
// include/mgmt/roaming_fsm.h:102
enum ENUM_ROAMING_STATE {
    ROAMING_STATE_IDLE = 0,           // 空闲，无漫游活动
    ROAMING_STATE_DECISION,           // 决策中：是否触发漫游？
    ROAMING_STATE_DISCOVERY,          // 发现中：扫描候选 AP
    ROAMING_STATE_ROAM,               // 漫游中：正在执行切换
    ROAMING_STATE_HANDLE_NEW_CANDIDATE, // 处理新候选
    ROAMING_STATE_SEND_WNM_RESP,      // 发送 BTM Response
    ROAMING_STATE_SEND_FT_REQUEST,    // 发送 FT Auth Request
    ROAMING_STATE_WAIT_FT_RESPONSE,   // 等待 FT Auth Response
    ROAMING_STATE_NUM
};
```

状态转移由 `roamingFsmSteps()` 集中管理：IDLE/DECISION/DISCOVERY/ROAM 四个主状态覆盖从空闲到执行切换的完整流程，HANDLE_NEW_CANDIDATE 处理候选异常（如当前候选漫游失败需要重选），SEND_FT_REQUEST/WAIT_FT_RESPONSE 处理 FT 快速切换。

```c
// mgmt/roaming_fsm.c（MTK 驱动，概念说明）
// roamingFsmSteps 根据当前状态和下一个目标状态，执行状态转移的逻辑检查
// 例如：IDLE → DECISION：检查是否满足漫游触发条件（RSSI/PER/BTM）
//      DECISION → DISCOVERY：启动漫游扫描，下发扫描命令到固件
//      DISCOVERY → ROAM：候选 AP 确定，执行 Auth/Assoc 流程
```

事件驱动入口是 `roamingFsmProcessEvent()`，它分发 6 类事件：

```c
// include/mgmt/roaming_fsm.h:63
enum ENUM_ROAMING_EVENT {
    ROAMING_EVENT_START = 0,       // 触发漫游
    ROAMING_EVENT_DISCOVERY,       // 发现新候选
    ROAMING_EVENT_ROAM,            // 执行切换
    ROAMING_EVENT_FAIL,            // 漫游失败
    ROAMING_EVENT_ABORT,           // 中止漫游
    ROAMING_EVENT_THRESHOLD_UPDATE, // 阈值更新
};
```

MTK 的漫游扫描由一个独立的扫描节奏控制器（Scan Cadence）管理，支持 4 种扫描源：

```c
// include/mgmt/roaming_fsm.h:128
enum ENUM_ROAMING_SCAN_SORUCE {
    ROAMING_SCAN_INVALID = 0,
    ROAMING_SCAN_FORCE_FULL,       // 初始连接时的全量扫描
    ROAMING_SCAN_INACTIVE_TIMER,   // 非活跃定时器触发
    ROAMING_SCAN_SINGLE_TIMER,     // 单次定时扫描
    ROAMING_SCAN_PERIODIC_TIMER,   // 周期性扫描
    ROAMING_SCAN_NUM
};
```

候选 AP 的评分由 `scanCalculateScoreByCu()`（`ap_selection.c:874`）完成——它回答的核心问题是：这个候选 AP 值得搬过去吗？评分公式是 `score = rssiFactor * 65 + cuFactor * 35`，RSSI 权重 65%、信道利用率（CU）权重 35%——信号强度是搬家的第一考量，但拥挤程度也不能忽视：同一栋楼信号再好，挤满了人也不舒服。

rssiFactor 是 RSSI 的分段线性函数，6 个区间各用不同的斜率映射到 0-100 分：

```c
// ap_selection.c:897-908（MTK 驱动）
if (rssi >= -55)                // -55dBm 以上：满分
    rssiFactor = 100;
else if (rssi >= -60)           // -60~-56dBm：每 dB 扣 2 分
    rssiFactor = 90 + 2 * (60 + rssi);
else if (rssi >= -70)           // -70~-61dBm：每 dB 扣 3 分
    rssiFactor = 60 + 3 * (70 + rssi);
else if (rssi >= -80)           // -80~-71dBm：每 dB 扣 4 分
    rssiFactor = 20 + 4 * (80 + rssi);
else if (rssi >= -90)           // -90~-81dBm：每 dB 扣 2 分
    rssiFactor = 2 * (90 + rssi);
else
    rssiFactor = 0;             // -90dBm 以下：零分
```

信号越弱，每 dB 的惩罚越重——-70~-80dBm 区间每 dB 扣 4 分，而 -55~-60dBm 区间每 dB 只扣 2 分。这就像搬家时对房子质量的容忍度：房子还行的时候（-55dBm），差一点没关系；房子已经很差了（-75dBm），再差一点就完全不能住了。

cuFactor 取决于目标 AP 的信道利用率，来源有两种：如果 AP 的 Beacon 中携带了 BSS Load IE，直接用其中的 Channel Utilization 字段；否则驱动通过扫描时的信道空闲时间推算。cuFactor 按频段分两套映射——2.4GHz 信道少、干扰多，利用率阈值更严格（<10% 才满分，>=70% 只给 20 分）；5GHz/6GHz 信道多、干扰少，阈值更宽松（<30% 满分，>=80% 才降到 20 分）。

65:35 的权重分配反映了两个因素对实际吞吐量的影响力差异。RSSI 直接决定了可用的 MCS 等级——从 -60dBm 掉到 -70dBm，同一个信道宽度下的 MCS 可能从 9 掉到 5，吞吐量直接腰斩；而信道利用率从 20% 升到 40%，对单个 STA 的实际影响远没有那么剧烈——你抢到的时隙可能只少了几个百分点。信号强度是房子本身的结构质量，信道利用率是邻居的噪音水平——前者决定了你能不能住，后者决定了你住得舒不舒服。两套阈值的差异也有物理原因：2.4GHz 只有 3 个非重叠信道（1/6/11），隔壁 AP 的 Beacon 帧和你的数据帧在同一个信道上碰撞，10% 的利用率已经意味着显著的同频干扰；5GHz 有 20+ 个非重叠信道，即使某个 AP 的利用率达到 30%，周边的干扰源通常分布在其他信道上，对你的实际影响有限。

这个基础评分还会根据漫游原因叠加调整（`ap_selection.c:1493-1522`）：信号差触发（`ROAMING_REASON_POOR_RCPI`）时 goal += base * 20 / 100，比基础分高 20%——信号已经很差了，对候选的要求可以适当放宽；空闲触发（`ROAMING_REASON_IDLE`）时 goal += base * 1 / 100，几乎不调整——空闲时漫游不急迫；BTM 触发时 goal = base * (1 + u4BtmDelta/100)，u4BtmDelta（字段定义 `adapter.h:1309`）默认为 0（`ROAMING_BTM_DELTA`，`roaming_fsm.h:40`），可通过 ini 文件 `BtmDelta` 配置——这给了运营商一个调节 BTM 漫游激进程度的旋钮。

`roamingFsmRunEventNewCandidate()` 处理新候选 AP 的到达——它的核心价值是对 BTM Disassociation Imminent 场景的分级处理。当 `ROAMING_REASON_BTM` 且 Request Mode 中 `DISASSOC_IMMINENT` 或 `BSS_TERMINATION_INCLUDED` 被置位时，MTK 驱动维护了一个四级紧急状态（`AIS_BTM_DIS_IMMI_STATE_0/1/2/3`，`ais_fsm.h:93-96`），随着重复 BTM 请求到达逐步升级紧急程度，影响候选选择策略。

初始化时（`ais_fsm.c:8771-8807`），Disassociation Imminent 场景下驱动比较 `u4ReauthDelay` 与 `u4BtmDisTimerThreshold`：重认证延迟超过阈值说明还有缓冲时间，设为 STATE_1；低于阈值说明即将被踢，直接跳到 STATE_2。BSS Termination Included 场景下 AP 要关闭整个 BSS，设为 STATE_1。每次新的 BTM 请求到达时（`roaming_fsm.c:1322-1325`），状态逐级升级：STATE_1→STATE_2→STATE_3——升级的触发条件是重复收到带 DISASSOC_IMMINENT 或 BSS_TERMINATION_INCLUDED 标志的 BTM Request，而非时间流逝。

这三级状态不只是数字变化——它直接改变了候选 AP 的筛选门槛。STATE_1 时候选评分沿用正常的 BTM 偏好加权（`u4BtmDelta`），ABRIDGED 过滤仍然生效——只考虑候选列表中的 AP，还可以挑挑拣拣。STATE_2 时评分门槛直接降到 6000（`ap_selection.c:1513`），大幅降低候选 AP 的信号质量要求；同时驱动在目标信道上发起一次定向扫描（`ais_fsm.c:2370`），扫描期间进入 `WAIT_FOR_NEXT_SCAN` 状态等待结果。STATE_3 时评分门槛降到 0（`ap_selection.c:1516`）——任何 AP 都比被踢强；ABRIDGED 过滤也被绕过（`ap_selection.c:852-856`），不在候选列表中的 AP 同样可以被选中，几乎"有得选就选"。如果 STATE_3 的目标信道扫描仍未找到候选，驱动回退到全频段扫描（`AIS_STATE_LOOKING_FOR`，`ais_fsm.c:2375`）做最后一搏。

MTK 方案的优势是可观测——host 能看到漫游的每一步。漫游完成或失败时，`roamingFsmNotifyEvent()`（`roaming_fsm.c:1155`）通过 uevent 上报完整快照：`roam=Status:SUCCESS/FAIL,BSSID:prev/curr,Reason:N,Chann:prev/curr,RCPI:prev/curr,BW:N,STBC:TRUE/FALSE`——这条一行日志包含了漫游前后的 BSSID、信道、RCPI 和带宽变化，排查时一条 log 就能还原场景。驱动侧每次 FSM 状态转移都打日志（`roamingFsmSteps()`，`roaming_fsm.c:771`：`TRANSITION: [OLD_STATE] -> [NEW_STATE]`），漫游失败时更新 `u4RoamFailCnt` 计数器和 `u8RoamFailTime` 时间戳（`ais_fsm.c:4442`）供上层查询。

代价是延迟大——每次决策都要经过 host→固件来回。MTK 选择 8 状态 FSM 而非纯事件驱动也有工程权衡：FSM 的每个状态都是显式的可检查点，`roamingFsmSteps()` 的集中式转移函数让"当前处于什么状态、下一步去哪"一目了然——排查漫游卡死时只需看最后一条 TRANSITION 日志就知道卡在哪个阶段；纯事件驱动的回调链（事件 A 触发回调 B，回调 B 触发事件 C...）在 8 种状态、6 类事件的组合下容易出现"回调嵌套地狱"，状态转移逻辑分散在各个回调函数中，调试时需要拼接多条日志才能还原完整路径。

8 状态的规模也在可控范围内——状态数 × 事件数 = 48 种组合，每种组合在 `roamingFsmSteps()` 中有明确的转移表，不会出现状态爆炸；如果状态数膨胀到 20+，集中式转移函数就会变得难以维护，此时事件驱动的分布式模式反而更合适。

搬家失败了怎么办？MTK 的 FSM 有明确的回退路径。`roamingFsmRunEventFail()`（`roaming_fsm.c:1205`）将 FSM 从 ROAM 状态转移回 DECISION 状态，同时发送 `ROAMING_EVENT_FAIL` 事件携带失败原因——两种原因值：`ROAMING_FAIL_REASON_CONNLIMIT`（连接数限制，目标 AP 拒绝关联）和 `ROAMING_FAIL_REASON_NOCANDIDATE`（无候选 AP，扫描未找到合适目标）。关键在于：MTK Host Roaming 模式下，原连接在漫游过程中始终保持着——驱动只在 Reassoc 成功后才切换 BSS，漫游尝试对用户完全透明。漫游失败时 STA 回到原 AP 继续工作，AIS FSM 恢复 NORMAL 状态，用户感知不到刚才发生了一次失败的搬家尝试。这与 QCOM RSO 形成对比：RSO 模式下固件在射频层面执行切换，如果失败时原连接的 Beacon 已经丢失（Beacon Loss 触发的漫游），STA 可能陷入"回不去旧 AP、到不了新 AP"的窘境——此时只能走断线重连。

## 1.3 两种架构的对比

| 维度     | QCOM RSO                                         | MTK Host Roaming                                           |
| -------- | ------------------------------------------------ | ---------------------------------------------------------- |
| 决策位置 | 固件（Firmware）                                 | 驱动（Driver/Host）                                        |
| 状态管理 | roam_offload_state 枚举，状态转移在固件内部完成  | 8 状态枚举 + roamingFsmSteps() 转移函数                    |
| 触发源   | 固件检测 RSSI/PER/BMISS → WMI_ROAM 事件通知 host | 驱动检测 → roamingFsmProcessEvent 分发                     |
| 扫描执行 | 固件自主调度，host 只下发配置                    | 驱动调度 Scan Cadence，4 种扫描源                          |
| FT 处理  | 固件自动（KEY_MGMT_OFFLOAD），host 不可见        | 驱动显式 FSM 状态：SEND_FT_REQUEST → WAIT_FT_RESPONSE      |
| BTM 处理 | 固件处理 + WMI_ROAM_REASON_BTM 通知 host         | 驱动解析 BTM Request，roamingFsmBTMResponseTxDone 管理响应 |
| 延迟     | 低（固件直控射频）                               | 高（host↔固件来回）                                        |
| 可观测性 | 低（固件黑盒，关键字段回传 host）                | 高（host 掌控每一步，日志完整）                            |
| 适合场景 | 手机厂商（功耗敏感，信任自家固件）               | 企业 AP/路由器（调试和灵活性优先）                         |

![QCOM RSO（固件闭环）vs MTK Host Roaming（驱动 8 状态 FSM）对比](assets/08c-STA-%E6%BC%AB%E6%B8%B8%EF%BC%88%E4%B8%89%EF%BC%89%E5%B9%B3%E5%8F%B0%E6%89%A7%E8%A1%8C%E4%B8%8E%E8%B0%83%E4%BC%98-%E2%80%94-QCOM-%E4%BB%A3%E7%90%86-vs-MTK-%E4%BA%B2%E4%B8%BA/08c-rso-vs-host-roaming.svg)

这张表揭示了一个根本性的架构选择：把漫游决策放在固件里还是放在 host 驱动里？手机厂商几乎一致选 RSO，企业 AP/路由器厂商几乎一致选 Host Roaming——两种选择背后是对"效率"和"可控性"的不同权重。RSO 的核心收益是三件事。功耗：漫游扫描的主体工作——逐信道驻留、接收 Beacon、评分候选——全部在固件处理器上完成，host CPU 在整个扫描周期内可以保持深度休眠（suspend-to-RAM），不需要被射频中断唤醒；固件通过 DMA 直接访问射频前端寄存器，不经过 host 内核栈的中断处理和上下文切换，每次信道切换的额外功耗仅为固件内部的状态保存/恢复（微焦耳级），而 Host Roaming 模式下每次信道切换需要 host 内核唤醒（毫焦耳级）。实时性：固件是裸机或 RTOS 环境，没有 Linux 内核的调度延迟和中断抢占，`RoamScan_ActiveCH_DwellTime` 40ms 的窗口内固件可以完成扫描+评分+切换三步，host OS 调度延迟（典型 1-10ms）不会侵蚀这个窗口。量产一致性：固件算法统一烧录，不依赖 host OS 版本和内核补丁，所有出货设备行为一致。

代价是黑盒——漫游评分公式固化在固件内部，host 侧只能通过 `wlan_mlme_roam_scoring_cfg` 调参数旋钮（`roam_score_delta`、`min_roam_score_delta`），无法注入自定义候选过滤逻辑或替换评分算法。出了漫游问题（比如在特定 AP 部署下反复 ping-pong），host 侧只能看到 `roam_fail_reason` 和 `roam_trigger_reason` 两个字段，无法单步调试固件决策过程——必须用 QXDM 抓固件日志才能还原。

Host Roaming 的核心收益是可调试性和策略灵活性：驱动的 `roamingFsmSteps()` 每次状态转移都打日志，漫游失败时 `roamingFsmNotifyEvent()` 上报完整快照（BSSID、信道、RCPI、带宽变化），一条 log 就能还原场景；运营商可以通过 ini 文件自定义漫游阈值（`BtmDelta`）、评分权重、黑名单策略，甚至替换整个候选评分算法。

代价是延迟和功耗——每步决策都要经过 host 内核栈往返，典型多 50-100ms；host CPU 需持续参与决策无法深度休眠，在电池供电设备上这是硬伤。

用搬家来类比：RSO 是把搬家整体托管出去——省心、高效，但路线和打包顺序全由对方定，出了问题你只能事后翻事故报告；Host Roaming 是自己当搬家队长——每一件家具怎么搬、走哪条路都亲自拍板，出了问题立刻知道哪一步出错，但累且慢，每步都要自己盯着。手机厂商选搬家公司是因为他们信任固件团队且追求功耗和一致性；企业 AP 选自己动手是因为他们的网络环境复杂多变，需要随时调整漫游策略且不差那点延迟。

上述对比基于单链路漫游场景。802.11be（WiFi 7）引入的 MLO（Multi-Link Operation）让 STA 同时在多个链路上通信，漫游时需要同步切换所有活跃链路——就像搬家不是一个房间而是同时搬三个房间，每个房间的家具得协调好先后顺序，否则新家会乱套。QCOM 的 `WLAN_MLO_ROAM_SYNCH_IN_PROG` 状态（见 §1.1 状态枚举）正是为 MLO 漫游同步预留的。

MLO 在代码层面改变了漫游帧的目标地址。单链路漫游时，FT Auth Request 和 BTM Response 的目标地址是目标 AP 的 BSSID；MLO 下，多个链路共享同一个 MLD（Multi-Link Device）身份，目标地址替换为 MLD 地址。MTK 代码中，`roamingFsmSendFtActionFrame()` 在 MLO 场景下通过 `mldIsSingleLinkEnabled()` 检查后将 Target AP Address 替换为 `prBssDesc->rMlInfo.aucMldAddr`（`roaming_fsm.c:181-183`）；BTM 响应的 `wnmSendBTMResponseFrame()` 同样在 MLO 分支中使用 MLD 地址（`roaming_fsm.c:908`）。完整的 MLO 漫游机制（多链路同步密钥推导、链路级切换顺序、MLD 地址与链路地址的映射）已超出本篇范围。

---

# 2 搬错了怎么办？——黑名单、防乒乓与漫游调优

搬家有风险：新房子可能比旧的还差，搬家公司可能半路把行李摔了。漫游也一样——切到新 AP 发现信号更差、FT 认证超时、或者新 AP 根本不认你的密钥。本节回答：漫游失败后怎么善后？怎么防止在两个 AP 间反复横跳？系统层面怎么控制漫游激进程度？

## 2.1 黑名单：被坑过一次的 AP 暂时不再考虑

漫游失败后立刻重试同一个候选 AP 通常不是好主意——它可能刚踢了你，或者 Auth 帧丢了，或者 PMK 不匹配。wpa_supplicant 的 `wpa_bss_tmp_disallow()`（`wpa_supplicant.c:9490`）机制实现了"暂时拉黑"：漫游失败后将目标 BSSID 临时加入黑名单（默认 60 秒），60 秒内不再考虑它。这个函数接受一个 `rssi_threshold` 参数——它不只是简单地计时解封，还支持"信号恢复即可重新考虑"的平滑恢复逻辑。

黑名单的检查发生在每个候选 BSS 被评估时（`wpa_is_bss_tmp_disallowed()`，`wpa_supplicant.c:9519`）。检查逻辑很精巧：遍历黑名单链表找到匹配的 BSSID 后，不是直接拒绝，而是先比较 `bss->level`（当前扫描到的 RSSI）与 `disallowed->rssi_threshold`——如果被拉黑的 AP 信号已经恢复到阈值以上（`wpa_supplicant.c:9534-9538`），直接调用 `remove_bss_tmp_disallowed_entry()` 提前解除黑名单，同时 `wpa_set_driver_tmp_disallow_list()` 同步更新驱动侧的过滤列表。这意味着黑名单不是铁板一块：被拉黑的 AP 如果信号改善（比如用户走回了离它更近的位置），不必等满 60 秒就能被重新考虑。超时兜底由 `wpa_bss_tmp_disallow_timeout()`（`wpa_supplicant.c:9473`）负责——eloop 定时器到期后从链表移除条目并同步驱动。

这就像搬错家后暂时不再考虑那个小区，但如果中介告诉你那小区的墙修好了、信号变强了，你也可以提前解禁重新评估。

MTK 驱动有类似机制——`ROAMING_ONE_AP_SKIP_TIMES`（默认值为 3）定义了一个 AP 可以被跳过的次数。如果某个候选 AP 连续 3 次出现在候选列表顶部但都漫游失败，驱动会跳过它选择次优候选。

FT 失败时的回退路径在 FSM 中有明确的代码路径。`roamingFsmRunEventRxFtAction()` 收到 FT Auth Response 状态码非 0 时（`roaming_fsm.c:449-459`），将 `eFtDsState` 设为 `FT_DS_STATE_FAIL`，然后 FSM 回到 `ROAMING_STATE_HANDLE_NEW_CANDIDATE`（`roaming_fsm.c:469`）。在 `HANDLE_NEW_CANDIDATE` 的处理逻辑中（`roaming_fsm.c:858-879`），FSM 检查是否需要走 FT Over-the-DS：条件是 `fgIsFtOverDS && eFtDsState == FT_DS_STATE_IDLE`——由于当前状态是 `FT_DS_STATE_FAIL`（不是 `IDLE`），条件不满足，直接进入 `ROAMING_STATE_ROAM` 走标准 Auth+Reassoc 流程。这条回退路径让 FT 失败的漫游从 20-50ms 的快速切换回退到 100-500ms 的标准流程——时延增加了，但至少不会卡死在 FT 等待中。

QCOM RSO 模式下，固件检测到 FT 失败后同样回退到标准流程，但 host 只能通过 `roam_fail_reason` 字段事后得知。如果漫游过程中链路彻底断开（Beacon Loss 达到 final 阈值），驱动会触发断连事件，上层通过 `wpa_supplicant_event(EVENT_DISASSOC)` 处理——此时不再是漫游，而是断线重连，走完整的 Auth/Assoc/EAPOL 流程。

FT 失败回退到标准 Auth 后，PMK 缓存的命运如何？答案是：PMKSA 缓存条目不会因为漫游失败而被清除。`wpa_ft_process_response()` 的 `fail` 标签（`wpa_ft.c:774`）只释放解析的 IEs 内存、返回 -1，不触碰 PMKSA 缓存——这意味着即使 FT 认证失败回退到标准 802.1X，PMKSA 缓存中该 AP 的条目仍然保留。这些条目的生命周期由 `dot11RSNAConfigPMKLifetime` 控制，默认 43200 秒（12 小时），在 `pmksa_cache_add_entry()` 中以当前时间加 lifetime 计算过期时间戳（`pmksa_cache.c:295`）。

换句话说，FT 失败不是"作废了密钥材料"，而是"密钥材料还在，只是这次没用上"——下次再尝试连接同一个 AP 时，如果 AP 支持 PMKSA 缓存，STA 可以直接用缓存的 PMKID 跳过 802.1X，省去数百毫秒的认证开销。只有在漫游成功时，`wpa_find_assoc_pmkid()`（`events.c:443`）才会从 AP 返回的 RSN IE 中提取新的 PMKID 并更新 PMKSA 缓存当前条目。

QCOM RSO 模式下，固件侧维护独立的 PMKSA 缓存——`fw_pmksa_cache` 标志位（`wlan_cm_roam_offload.c:614`）控制是否启用固件侧 PMKSA 缓存，由 `CFG_PMKID_MODES_PMKSA_CACHING` 配置项决定。这条"失败不清缓存"的设计意图很明确：PMKSA 缓存的价值是跨 AP 共享密钥材料以减少重认证开销，漫游失败只是说明"这次切换没成功"，不代表密钥材料本身有问题——真正需要清除缓存的场景是接口 MAC 地址变更（`events.c:6919`，`wpa_sm_pmksa_cache_flush` 传 NULL 清全部）、SAE 认证被拒（`sme.c:2917`）或显式断开连接。

## 2.2 MBO assoc_retry_delay：AP 说「别急，等 X 秒再来」

MBO 规范定义了一个精巧的防冲突机制：当 AP 在 BTM Response 中看到 STA 拒绝的原因是"暂时无法切换"，AP 可以在下一个 Beacon 中携带 `MBO_ATTR_ID_ASSOC_RETRY_DELAY` 属性，告诉 STA "我知道你需要时间，X 秒后再来尝试关联我"。在 supplicant 中，这由 `wpas_mbo_ie_trans_req()` 解析：

```
// 解析伪代码（源码见 mbo.c:481 wpas_mbo_ie_trans_req）
收到 MBO IE {
    如果 attr_id == MBO_ATTR_ID_ASSOC_RETRY_DELAY {
        wpa_s->wnm_mbo_assoc_retry_delay_present = 1;
        wpa_s->wnm_mbo_assoc_retry_delay_sec = WPA_GET_LE16(pos);
        // 在此期间，wpa_bss_tmp_disallow 该 BSSID
    }
}
```

## 2.3 Android RoamingMode：从系统层面控制漫游激进程度

Android V 引入了 `WifiManager.RoamingMode` 注解，给应用层（通过系统 API）一个控制漫游激进程度的入口：

```java
// framework/java/android/net/wifi/WifiManager.java
public static final int ROAMING_MODE_NONE = 0;       // 禁止漫游
public static final int ROAMING_MODE_NORMAL = 1;     // 芯片默认漫游策略
public static final int ROAMING_MODE_AGGRESSIVE = 2; // 激进漫游（高密度 AP 环境）
```

这三个模式最终映射到驱动的 RSSI 阈值调整——AGGRESSIVE 模式降低 min_diff，让 STA 更早切换；NONE 模式直接关闭漫游触发，STA 死撑当前 AP 直到断开。

## 2.4 防乒乓：不让 STA 在两个 AP 间反复横跳

ping-pong 是漫游的头号大敌——STA 从 A 切到 B，发现 B 也不咋地，又切回 A，再切回 B...每次切换都伴随几十到几百毫秒的断流。就像搬了家发现新房子墙也在裂，搬回去发现旧房子还没修好，来回折腾。防御策略有三层：

1. **min_diff 机制**（supplicant 层）：`wpa_supplicant_need_to_roam_within_ess()` 的 min_diff 不为 0，意味着候选必须明显优于当前才切换，避免因微小信号波动触发漫游
2. **黑名单机制**（supplicant + 驱动层）：漫游失败或 ping-pong 后的 AP 暂时列入黑名单
3. **频段偏好**（supplicant + 驱动层）：5GHz/6GHz 自带加分，天然减少了切回 2.4GHz 的概率

---

# 3 总结：一条完整的漫游调用链

![漫游完整调用链](assets/08c-STA-%E6%BC%AB%E6%B8%B8%EF%BC%88%E4%B8%89%EF%BC%89%E5%B9%B3%E5%8F%B0%E6%89%A7%E8%A1%8C%E4%B8%8E%E8%B0%83%E4%BC%98-%E2%80%94-QCOM-%E4%BB%A3%E7%90%86-vs-MTK-%E4%BA%B2%E4%B8%BA/08c-roaming-callchain.svg)

在 QCOM RSO 模式下，上述调用链的大部分在固件中执行，host 只参与配置下发（`cm_roam_send_rso_cmd`）和结果通知（`mlme_event_connect` 处理 `NL80211_CMD_ROAM`）。在 MTK Host Roaming 模式下，驱动层的 `roamingFsmSteps` 走完整的状态转移链：IDLE → DECISION → DISCOVERY → ROAM → HANDLE_NEW_CANDIDATE → (SEND_FT_REQUEST → WAIT_FT_RESPONSE | SEND_WNM_RESP)。

漫游耗时的典型分解——每个阶段都有对应的代码锚点和平台参数：

- **扫描阶段**（100-300ms）：取决于信道数和是否使用 802.11k 邻居报告缩小范围。QCOM 固件按 `RoamScan_ActiveCH_DwellTime`（默认 40ms）逐信道驻留，在 `RoamScan_HomeTime`（45-50ms）和 `RoamScan_AwayTime`（0-300ms）之间交替扫描与主信道保持；MTK 驱动通过 `u4DiscoverTimeout`（`wlan_lib.c:8341`）控制缓存新鲜度——缓存过期才触发新扫描，未过期则复用旧结果
- **认证阶段**（FT: 20-50ms / 标准 802.1X: 100-500ms）：FT 路径由 `roamingFsmSendFtActionFrame()`（MTK，`roaming_fsm.c:151`）发起 FT Auth 帧交换；标准路径走完整的 Auth/Assoc/EAPOL 流程
- **重关联阶段**（10-30ms）：`wnm_bss_tm_connect()`（`wnm_sta.c:1105`）触发 `wpa_supplicant_connect()` 发起 Reassoc
- **四次握手阶段**：FT 已预推密钥可跳过；标准路径 20-50ms

RSO 模式下扫描和认证在固件中并行优化，扫描调度由 `gNeighborScanTimerPeriod`（100s 周期）和 `RoamScan_FirstTimer`（10s 快速重试）控制节奏，典型总时延在 50-100ms 范围。Host Roaming 模式下每步都经过 host 往返，MTK 的 `roamingFsmNotifyEvent()` 在漫游完成后上报 `roam=Status:...` uevent，日志中的时间戳差值可精确量化各阶段耗时，典型总时延在 100-300ms 范围。

漫游的本质是在不断链的前提下做一次"有准备的切换"——准备来自 802.11k 的邻居报告和信标测量、802.11v 的 BTM 引导、802.11r 的密钥预推，而"不断链"靠的是 min_diff 防乒乓、黑名单防重试、多级阈值分层触发。搬家不难，难的是搬到一半发现新家的墙也在裂——漫游也一样：切过去了信号还是差，才是真正难解的问题。

## 3.1 关键常量速查表

全文散落的漫游调优常量汇总如下，方便排查时快速对照（默认值取自对应文件的宏定义或赋值，文件位置为已验证行号）：

| 常量名                              | 默认值                | 作用                                 | 文件位置               |
| ----------------------------------- | --------------------- | ------------------------------------ | ---------------------- |
| `RoamScan_ActiveCH_DwellTime`       | 40ms                  | 逐信道驻留时间                       | `cfg_mlme_lfr.h:80`    |
| `RoamScan_HomeTime`                 | 45-50ms               | 当前信道最短保持时间，保证数据不断流 | `cfg_mlme_lfr.h:89`    |
| `RoamScan_AwayTime`                 | 0 或 100ms（0-300ms） | 离开当前信道的窗口上限               | `cfg_mlme_lfr.h:40-92` |
| `gNeighborScanTimerPeriod`          | 100s                  | 固件周期扫描间隔                     | `cfg_mlme_lfr.h:1524`  |
| `RoamScan_FirstTimer`               | 10s                   | 上轮无结果时的快速重试间隔           | `cfg_mlme_lfr.h:1797`  |
| `gNeighborScanRefreshPeriod`        | 20s                   | 扫描结果保鲜期                       | `cfg_mlme_lfr.h:1716`  |
| `roam_scan_period_after_inactivity` | 120s                  | 设备空闲后的降频扫描周期             | `cfg_mlme_lfr.h:3241`  |
| `roam_inactive_data_count`          | 10                    | 设备空闲判定数据包阈值               | `cfg_mlme_lfr.h:3210`  |
| `ROAMING_BTM_DELTA`                 | 0                     | BTM 触发时评分调整比例               | `roaming_fsm.h:40`     |
| `ROAMING_ONE_AP_SKIP_TIMES`         | 3                     | 候选 AP 连续失败后的跳过次数         | `roaming_fsm.h:38`     |
| `u4DiscoverTimeout`                 | 10s                   | MTK 漫游扫描缓存新鲜度阈值           | `wlan_lib.c:8341`      |
| `dot11RSNAConfigPMKLifetime`        | 43200s（12h）         | PMKSA 缓存条目生命周期               | `wpa.c:4322`           |
