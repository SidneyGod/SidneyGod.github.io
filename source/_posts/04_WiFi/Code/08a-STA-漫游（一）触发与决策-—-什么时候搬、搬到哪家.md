---
title: STA 漫游（一）触发与决策 — 什么时候搬、搬到哪家
top: 1
related_posts: true
abbrlink: 7972c883
date: 2026-09-19 21:21:18
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 连接不是终点。当你拿着手机从一个房间走到另一个房间，信号掉到 -78dBm，STA 面临选择：撑住旧 AP，还是切到新 AP？本文追踪漫游的第一步——**什么时候该搬、值不值得搬**。漫游比作搬家：信号变差是墙裂，Beacon Loss 是房塌，BTM 是房东通知你搬。
>
> 本文聚焦 ESS 内漫游，分析 wpa_supplicant、QCOM qcacld-3.0、MTK gen4m 驱动源码（精简处标注 `// ...省略...`，文件路径标注在代码块首行）。漫游前的扫描机制见《扫描》系列，连接信令见《连接》系列，本文复用不重复。

# 1 什么时候该搬家？——漫游的三种触发器

老房子住久了你自然会注意到墙上的裂缝：信号变弱（RSSI 下降）、邻居的噪音变大（PER 升高）、甚至直接断水断电（Beacon 连续丢失）。现代 AP 还多了一个高级玩法——房东主动发通知：这栋楼要拆了，建议你搬到隔壁那栋（BTM Request）。这三种情况分别对应漫游的三个触发源头。

<!--more-->

## 1.1 RSSI 驱动漫游：信号弱了就找下家

这是最基础的漫游触发——驱动或固件持续监控接收信号强度（RSSI/RCPI），当低于预设阈值时，启动漫游扫描。

在 supplicant 层，这个判断由 `wpa_supplicant_need_to_roam()` 入口函数发起：

```c
// wpa_supplicant/events.c:2356
static int wpa_supplicant_need_to_roam(struct wpa_supplicant *wpa_s,
                                       struct wpa_bss *selected,
                                       struct wpa_ssid *ssid)
{
    // ... 前置检查：reassociate 标志、wpa_state、current_ssid ...

    if (wpas_driver_bss_selection(wpa_s))
        return 0; /* Driver-based roaming */

    current_bss = wpa_bss_get(wpa_s, bssid, ...);
    if (!current_bss)
        return 1; /* current BSS not seen in scan results */

    if (current_bss == selected)
        return 0;

    if (selected->last_update_idx > current_bss->last_update_idx)
        return 1; /* current BSS not seen in the last scan */

    return wpa_supplicant_need_to_roam_within_ess(wpa_s, current_bss, selected);
}
```

这个函数的前置检查有几个值得留意的地方。如果当前 BSS 都没在最近一次扫描结果中出现（`last_update_idx` 比较），说明连接状态可能已经不同步，直接允许漫游。如果驱动声明自己管 BSS 选择（`wpas_driver_bss_selection`），supplicant 不插手——这在 QCOM RSO 模式下很常见。只有上述检查全部通过，才进入核心决策函数 `wpa_supplicant_need_to_roam_within_ess()`。

## 1.2 Beacon Loss：连续失联触发紧急切换

Beacon 是 AP 定时广播的心跳帧（典型间隔 100TU = 102.4ms）。STA 收不到 Beacon 不代表链路一定断了，但如果连续丢失（典型阈值 7-10 个 Beacon），驱动会触发 Beacon Loss 事件。在 QCOM 平台，这映射为 `ROAM_TRIGGER_REASON_BMISS`；在 MTK 平台，AIS FSM 检测到连续 Beacon Miss 后向 Roaming FSM 发送 `ROAMING_EVENT_START`。

MTK 侧把计数做进了 AIS FSM：`ucBeaconTimeoutCount` 字段（`adapter.h:242`）初始化为 `AIS_BEACON_TIMEOUT_COUNT_INFRA`（=10，`ais_fsm.h:42`），连续丢满 10 个 Beacon 后由 `aisBssBeaconTimeout()`（`ais_fsm.c:6825`）上报，经 `aisHandleBeaconTimeout()`（`ais_fsm.c:6901`）转入 `aisFsmStateAbort()` 触发紧急切换。

但断连并非唯一出路——`aisBeaconTimeoutFilterPolicy()`（`ais_fsm.c:6949`）在决策态且 RSSI > -83 时把 Beacon 超时当 PER 先搜更好 AP；只有 RSSI 跌破 -83 或搜不到候选，才走 `aisHandleBeaconTimeout()`→`aisFsmStateAbort()` 断连，最终经 `aisFsmDisconnect()`（`ais_fsm.c:6114`）→ `aisIndicationOfMediaStateToHost()` 内的 `nicMediaStateChange()`（`ais_fsm.c:5379`）上报 host。

从 QCOM 的触发原因枚举可以看到完整的触发分类：

```c
// components/umac/mlme/connection_mgr/dispatcher/inc/wlan_cm_roam_public_struct.h
enum roam_trigger_reason {
    ROAM_TRIGGER_REASON_NONE = 0,
    ROAM_TRIGGER_REASON_PER,          // 误包率高
    ROAM_TRIGGER_REASON_BMISS,        // Beacon 丢失
    ROAM_TRIGGER_REASON_LOW_RSSI,     // 低信号
    ROAM_TRIGGER_REASON_HIGH_RSSI,    // 高信号（找更好的）
    ROAM_TRIGGER_REASON_PERIODIC,     // 周期性扫描
    // ... MAWC（运动辅助）、DENSE（密集环境）...
    ROAM_TRIGGER_REASON_BACKGROUND,   // 后台扫描
    ROAM_TRIGGER_REASON_FORCED,       // 强制漫游
    ROAM_TRIGGER_REASON_BTM,          // 802.11v BTM
    // ... UNIT_TEST、BSS_LOAD、DEAUTH、IDLE ...
    ROAM_TRIGGER_REASON_STA_KICKOUT,  // 被 AP 踢出
    // ... ESS_RSSI、WTC_BTM、PMK_TIMEOUT、BTC ...
};
```

Beacon Loss 不是一刀切——驱动分两级处理。QCOM 的 `gRoamBmissFirstBcnt`（默认 10，`cfg_mlme_lfr.h:1821`）控制第一级：连续丢失 10 个 Beacon 触发 first bmiss 事件，固件启动漫游扫描，给 STA 一个"赶紧找下家"的窗口。

`gRoamBmissFinalBcnt`（默认 20，`cfg_mlme_lfr.h:1846`）控制第二级：连续丢失 20 个 Beacon 触发 final bmiss 事件，固件执行漫游切换或向 host 上报 final bmiss indication——此时链路已接近断开。两级之间有明确的先后：first bmiss 触发的漫游扫描就是"找下家"的窗口，只有扫描超时或找不到合格候选，才累进到 final bmiss 上报断连——避免一丢 Beacon 就粗暴断线。

这个"找下家"窗口的长度由 `RoamScan_FirstTimer`（空扫描刷新周期，默认 10 秒，`cfg_mlme_lfr.h:1796`）控制——first bmiss 扫描空手而归后，固件按此周期刷新重扫；扫描结果的有效期 `scan_age` 设为该周期的 3 倍（30 秒，`wlan_cm_roam_offload.c:1269`），窗口内始终找不到合格候选，才叠加到 final bmiss。该周期在驱动侧存为 `empty_scan_refresh_period`（`wlan_cm_roam_public_struct.h:301`），由 `cm_roam_scan_offload_scan_period()` 打包进 `wlan_roam_scan_period_params`（`wlan_cm_roam_public_struct.h:1713`）下发固件。

这两个值通过 `roam_bmiss_first_bcn_cnt` 和 `roam_bmiss_final_cnt` 字段（`wlan_cm_roam_public_struct.h:304-305`）打包进 `wlan_roam_start_config` 下发固件。

固件还可通过 `WLAN_ROAM_BMISS_FINAL_SCAN_ENABLE`（BIT2）标志在 final bmiss 后做定向局部扫描（只扫已知候选信道而非全频段），由 `WLAN_ROAM_BMISS_FINAL_SCAN_TYPE`（BIT4）控制扫描类型。

## 1.3 BTM Request：AP 主动建议你搬家

802.11v BSS Transition Management（BTM）让 AP 从"被动接受 STA 的决定"变成"主动引导 STA 迁移"。这是企业级 WiFi 网络负载均衡的核心工具——AP 检测到负载过高或 STA 信号差时，主动发送 BTM Request Action 帧，携带推荐的目标 AP 列表。

但 AP 不会凭空发 BTM——在发送 Request 之前，AP 通常会让 STA 先做 802.11k Beacon Report 测量（见《STA 漫游（二）：802.11k/v/r》§1）。AP 通过 Measurement Request 帧指定目标信道和测量模式（PASSIVE/ACTIVE/TABLE——PASSIVE 监听 Beacon、ACTIVE 发 Probe，TABLE 读本地 Beacon 表不上信道），STA 完成测量后回报每个候选 AP 的物理层指标：RCPI（接收信道功率指示，IEEE 定义的信号强度度量，0-220 线性映射自 RSSI，每步 0.5dBm）和 RSNI（接收信噪指示，映射自 SNR，每步 0.5dB）。

AP 收集这些测量报告后评估链路质量——如果 STA 在当前位置能找到信号足够好的候选 AP，AP 一般不需要介入；只有 STA 自身扫描结果不理想（比如信号差的 AP 被 STA 偏好选中，或者 STA 根本没发现更好的候选），AP 才会基于测量数据构建候选列表并发 BTM Request。

这意味着 BTM Request 中的候选列表通常不是 AP 拍脑袋给的，而是经过 802.11k 测量验证的实地结果。

BTM Request 帧的核心字段包括：

- **Dialog Token**：请求-响应对应标识
- **Request Mode**：含多个标志位——Preferred Candidate List Included（bit 0，给了推荐列表）、Abridged（bit 1，精简列表）、Disassociation Imminent（bit 2，即将踢你下线）、BSS Termination Included（bit 3，AP 要关闭了）、ESS Disassociation Imminent（bit 4，即将从整个 ESS 断开）、Link Removal Imminent（bit 5，MLO 场景下即将移除某条链路）
- **Disassociation Timer**：以 TBTT（Target Beacon Transmission Time，即一个 Beacon 间隔，典型值 100TU = 102.4ms）为单位的倒计时，AP 告诉你"最多再给你 X 个 Beacon 间隔，之后我就要踢你了"
- **Candidate List**：按 Preference 排序的候选 AP 列表（BSSID + Channel + Preference）

BTM Request 帧格式由 802.11-2024 §9.6.13.9 定义。这些标志位组合起来决定了 STA 的处理策略。Preferred Candidate List Included 为 1 时，STA 直接解析帧中的候选列表做定向扫描——不需要盲扫全频段，省了最耗时的一步；为 0 时，AP 没给推荐，STA 只能自己做全频段扫描找候选。

Abridged 为 1 时，STA 只考虑候选列表中已知的邻居 AP——不在列表中的 BSS 直接排除（`wnm_is_bss_excluded()`，`wnm_sta.c:2106`），相当于 AP 说"只看我推荐的，别的不用管"。

另一组标志位决定了紧迫程度。Disassociation Imminent 为 1 时，Disassociation Timer 开始倒计时，STA 必须在到期前完成切换，否则 AP 会强制断开连接。BSS Termination Included 为 1 时更严重：AP 不只是要踢你，而是整个 BSS 要关闭了，帧中会携带 BSS Termination Duration（12 字节，包含 TSF 计时器和 Duration）。

ESS Disassociation Imminent 为 1 时，STA 即将从整个 ESS 断开——不只是离开当前 AP，而是所有同 SSID 的 AP 都不再接受你。Link Removal Imminent（bit 5）用于 MLO 场景：AP 告诉 STA 某条链路即将被移除，STA 需要在剩余链路上保持连接。

在 wpa_supplicant 中，这些标志位的处理散布在 `ieee802_11_rx_bss_trans_mgmt_req()` 的后续逻辑中。Disassociation Imminent 触发 `wpa_msg()` 上报 `WNM_BSS_TM_REQ_DISASSOC_IMMINENT` 事件通知上层。

BSS Termination Included 触发 12 字节 BSS Termination Duration 的解析（`wnm_sta.c:1494`）。

ESS Disassociation Imminent 触发 URL 解析和 `ESS_DISASSOC_IMMINENT` 事件上报（`wnm_sta.c:1503`）。

MTK 驱动在 `roamingFsmRunEventNewCandidate()` 中对 Disassociation Imminent 和 BSS Termination Included 做了分级紧急处理——维护四级紧急状态（`AIS_BTM_DIS_IMMI_STATE_0/1/2/3`，`ais_fsm.h:93-96`），STATE_0 为基态，随着重复 BTM 请求到达逐步升级（见《STA 漫游（三）：平台执行与调优》§1.2）。

前面讲的都是 AP 主动发 BTM Request——但 BTM 协议其实支持双向交互。STA 也可以主动向 AP 发送 BTM Query Action 帧（Action Code 6），相当于你主动问房东"附近有没有更好的房子推荐给我？"。

帧结构比 BTM Request 精简得多：Category（WNM）、Action（`WNM_BSS_TRANS_MGMT_QUERY`）、Dialog Token、Query Reason，外加可选的候选列表——STA 可以把自己扫描到的候选 AP 附在 Query 里，让 AP 在回复时参考。在 supplicant 中，`wnm_send_bss_transition_mgmt_query()`（`wnm_sta.c:1726`）负责构造和发送这个帧。

BTM Query 的典型使用场景在后台扫描：`bgscan_simple.c` 中的 `bgscan_simple_btm_query()` 会在周期性扫描中穿插 BTM Query——STA 信号变差时，与其盲目扫全频段，不如先问 AP 要一份候选清单，AP 基于全局视角（负载、拓扑、策略）给出的推荐通常比 STA 自己扫出来的更靠谱。

这种"STA 主动问、AP 被动答"的模式与前面的"AP 主动推、STA 被动收"形成互补——前者适合 STA 感知到信号问题但不知道往哪走的场景，后者适合 AP 需要主动做负载均衡的场景。

严格来说，BTM 不是一种触发类型，而是一种触发来源——它产生的效果与 RSSI 触发一样，都是启动漫游扫描和候选评估。区别在于候选范围：RSSI 触发是全频段扫描，BTM 触发是定向到候选列表中的信道。

![漫游整体架构：三层触发（RSSI/Beacon Loss/BTM）→ 决策（min_diff + 吞吐量微调）→ 执行（802.11k 信息收集 + 切换执行）](assets/08a-STA-%E6%BC%AB%E6%B8%B8%EF%BC%88%E4%B8%80%EF%BC%89%E8%A7%A6%E5%8F%91%E4%B8%8E%E5%86%B3%E7%AD%96-%E2%80%94-%E4%BB%80%E4%B9%88%E6%97%B6%E5%80%99%E6%90%AC%E3%80%81%E6%90%AC%E5%88%B0%E5%93%AA%E5%AE%B6/08a-roaming-architecture.svg)

## 1.4 RCPI 与 RSNI：AP 如何判断该不该发 BTM

前面讲了 BTM 的帧格式和处理流程，但一个关键问题没回答：**AP 凭什么决定发 BTM？RCPI 和 RSNI 到什么值才算"该搬家了"？**

答案分两层：第一层是 802.11 协议对 RCPI/RSNI 的精确定义——这两个指标不是 RSSI 的马甲，而是标准化、可跨厂商比较的物理层测量值；第二层是厂商实现——协议定义了测量方法，但**没定义触发阈值**，每个 AP 厂商有自己的判断逻辑。

### 1.4.1 RCPI：信号有多强

RCPI（Received Channel Power Indicator）表示 STA 或 AP 在天线连接器处测得的接收帧总信道功率（信号 + 噪声 + 干扰），单位 dBm。IEEE 802.11-2024 §9.4.2.36 定义了它的编码规则：

```
实际功率 (dBm) = RCPI × 0.5 − 110
```

- 有效范围：0 ~ 220（对应 -110 dBm ~ 0 dBm，步长 0.5 dB）
- 220 ~ 254：保留
- **255（0xff）：测量不可用**——设备无法提供有效的信道功率值

换算成几个关键节点：

| RCPI 值 | 对应 dBm | 信号评价           |
| ------- | -------- | ------------------ |
| 0       | -110     | 几乎收不到         |
| 40      | -90      | 极弱，随时可能断连 |
| 60      | -80      | 弱信号，漫游触发区 |
| 80      | -70      | 一般，尚可使用     |
| 100     | -60      | 良好               |
| 140     | -40      | 很强               |
| 220     | 0        | 贴着 AP 测的       |

RSSI 的问题在于每个厂商的定义不一样——A 厂的 RSSI=50 可能对应 B 厂的 -60dBm。RCPI 是 IEEE 标准化的，理论上同一个 RCPI 值在不同厂商的设备上代表相同的物理功率。不过实际世界中，各厂商对 RCPI 的校准精度参差不齐（见下文案例），不能当绝对标尺用。

### 1.4.2 RSNI：信号有多干净

RSNI（Received Signal-to-Noise Indication）表示接收信号功率与噪声加干扰功率之比。与传统的 SNR（只考虑热噪声）不同，RSNI 把干扰也纳入了分母——这在密集部署场景下比 SNR 更真实。IEEE 802.11-2024 §9.4.2.39 定义的换算：

```
SNR (dB) = RSNI × 0.5 − 10
```

- 有效范围：0 ~ 254（对应 -10 dB ~ +117 dB，步长 0.5 dB）
- **255（0xff）：测量不可用**
- **0（0x00）：SNR = -10 dB**——噪声淹没了信号，链路基本无法工作

WiFi 链路对 SNR 极其敏感，因为高阶调制需要足够的信号纯净度：

| RSNI 值     | SNR (dB)      | 链路能力                        |
| ----------- | ------------- | ------------------------------- |
| 0 ~ 19      | -10 ~ -0.5    | 基本无法通信                    |
| 20 ~ 39     | 0 ~ 9.5       | 仅支持低速率（1~6 Mbps）        |
| 40 ~ 59     | 10 ~ 19.5     | 勉强可用，容易丢包              |
| **60 ~ 79** | **20 ~ 29.5** | **正常使用门槛，支持 64-QAM**   |
| 80 ~ 109    | 30 ~ 44.5     | 良好，支持 256-QAM              |
| 110+        | 45+           | 优秀，支持 1024-QAM (Wi-Fi 6/7) |

一个经验法则：**RSNI < 40（SNR < 10 dB）链路基本不可用；RSNI ≥ 60（SNR ≥ 20 dB）才算正常**。这个阈值也解释了为什么很多 AP 在 SNR < 20 dB 时开始考虑触发漫游。

### 1.4.3 AP 的决策逻辑：没有统一标准

IEEE 802.11 定义了 RCPI/RSNI 的编码格式，但**没有规定 AP 在什么值下发 BTM**。这是留给厂商的差异化空间。从实测和开源实现中可以归纳出常见策略：

**1. RSSI/RCPI 阈值触发**

最基础的策略——AP 持续监控 STA 的上行信号强度，当低于阈值时启动漫游引导。常见阈值区间：

```
-65 ~ -70 dBm → RCPI ≈ 80 ~ 90：发起 802.11k 测量（先收集信息，不急踢）
-75 ~ -80 dBm → RCPI ≈ 60 ~ 70：发送 BTM Request（建议搬家，但不强制）
-80 dBm 以下  → RCPI < 60：发送带 Disassociation Imminent 的 BTM Request（再不走就踢）
```

注意回滞（hysteresis）：-65 dBm 以上通常不会触发任何动作，防止 STA 在两个 AP 之间反复横跳（ping-pong）。这个回滞区间设计（-65 到 -75）给 STA 留出了足够的决策窗口。

**2. 多指标综合判断**

仅看 RCPI 是不够的——信号强但 SNR 低（干扰大），链路照样不可用。企业级 AP 通常做多维度评分：

| 维度     | 指标                     | 好               | 差               |
| -------- | ------------------------ | ---------------- | ---------------- |
| 信号强度 | RCPI                     | > 80 (> -70 dBm) | < 60 (< -80 dBm) |
| 信号质量 | RSNI                     | > 60 (> 20 dB)   | < 40 (< 10 dB)   |
| 误包率   | PER                      | < 5%             | > 20%            |
| AP 负载  | 关联 STA 数 / 信道利用率 | < 50%            | > 70%            |

典型判定逻辑：RCPI < 60 **且** RSNI < 60 → 发 BTM；RCPI < 60 **但** RSNI > 80 → 暂不发（信号弱但信噪比还行，可能是 STA 发射功率低而非距离远）；AP 负载 > 70% **且** STA 的 RSNI < 60 → 优先引导这个 STA 迁移（负载均衡 + 信号质量双重考量）。

**3. hostapd / 开源实现**

hostapd 本身没有内置的 RSSI 阈值自动触发 BTM。`bss_transition=1` 只是打开了 BTM 能力宣告，真正发 BTM Request 需要通过 `hostapd_cli` 手动执行或用外部工具调用 ubus API：

```
# 手动向指定 STA 发 BTM Request（带候选列表）
hostapd_cli BSS_TM_REQ 02:00:00:00:00:00 pref=1 abridged=1 \
  valid_int=255 neighbor=xx:xx:xx:xx:xx:xx,0x0000,115,36,7,0301ff

# 手动发 Disassociation Imminent（10 个 TBTT 后强制断开）
hostapd_cli DISASSOC_IMMINENT 02:00:00:00:00:00 10
```

OpenWrt 生态中，DAWN 和 usteer 这两个开源漫游守护进程填补了自动化的空白——它们收集各 AP 上报的 STA 信号数据（包括 802.11k Beacon Report 中的 RCPI/RSNI），进行集中评分后通过 hostapd 的 ubus 接口下发 BTM Request。评分逻辑大致是：候选 AP 的信号比当前 AP 好一个可配置的门槛（默认 15~20 dBm），且当前 AP 的信号低于绝对阈值（默认 -70 ~ -75 dBm），则触发漫游引导。部分配置示例：

```
# DAWN 中基于 RCPI/RSNI 的评分权重
config metric
    option rcpi '50'           # RCPI ≥ 150 加分
    option rcpi_val '150'
    option low_rcpi '-1000'    # RCPI < 50 严重扣分
    option low_rcpi_val '50'
    option rsni '50'           # RSNI ≥ 150 加分
    option rsni_val '150'
```

这些值（150 / 50）说明：RCPI ≥ 150（-35 dBm，信号极好）大幅加分，RCPI < 50（-85 dBm，信号极差）严重扣分——两端拉开差距，中间段平滑过渡。

### 1.4.4 真实案例：测不出来也照样踢

以下案例取自一次中兴 AP（光纤 Mesh 组网）的问题抓包分析。STA 刚完成网络连通性校验，AP 立刻发起 802.11k Measurement Request，要求 STA 测量信道 40（5200 MHz，目标 BSSID `ec:79:c0:75:71:07`），模式为 Active（主动发 Probe Request）。

STA 的测量报告直接"摆烂"：

| 字段 | 报告值   | 含义                                  |
| ---- | -------- | ------------------------------------- |
| RCPI | **0xff** | Measurement not available——"我测不到" |
| RSNI | **0x00** | SNR = -10 dB——"信号被噪声淹了"        |

语义翻译：STA 在说"目标信道上的 AP 我完全收不到，而且当前环境噪声大到测不出有效信号"。换个更直白的说法：**STA 说那里没信号，而且这里很吵**。

按理说，AP 收到这份报告应该判断"候选 AP 不可达，暂不触发漫游"。但实际行为是：AP 紧接着发了 BTM Request，且 `Disassociation Imminent = 1`，`Disassociation Timer = 30 TBTT`——"30 个 Beacon 后我就要踢你了，赶紧从我给的候选列表里选一个搬过去"。

STA 回了 BTM Response（Status = Accept，声称去 `ec:79:c0:75:71:07`），但 3 秒后实际上还挂在原 AP 上——嘴上说走，身体很诚实。而 AP 也没真的在 30 个 TBTT 后踢人。

**三个教训**：

1. **BTM 决策的实现是黑盒**——AP 可能在测量报告不合格时仍基于自己的全局策略（负载、历史数据、邻居配置）发 BTM，RCPI/RSNI 只是参考输入之一，不是硬判决条件。
2. **Disassociation Imminent 的语义被软化了**——很多消费级 AP 把 Disassociation Timer 当成"建议期限"而非"强制倒计时"，超时后不一定真踢。协议写的是"will be disassociated"，实际是"may be disassociated"。
3. **不同 STA 对 Measurement Request 的反应差异巨大**——同一次抓包中，部分对比机收到测量请求后正常回复了 RCPI/RSNI，有的设备直接不搭理（无响应）。这对 AP 的决策质量有直接影响：如果关键 STA 的测量数据缺失，AP 只能靠不完全信息做判断。

**结论**：RCPI/RSNI 是 AP 发 BTM 的**重要参考**，但不是**唯一条件**，更不是**硬阈值**。没有"RCPI 到了 -78 就一定发 BTM"这回事——阈值是厂商写的代码里定义的，每个 AP 都不一样。理解这两个指标的含义，能让你在抓包时看懂 AP 和 STA 在聊什么；但想精确预测 AP 什么时候踢人，还得看具体 AP 的实现和调优参数。

---

# 2 留还是走？——漫游决策的核心算法

触发信号只是提醒你"该看看周围了"，但真正决定走不走的，是 `wpa_supplicant_need_to_roam_within_ess()`。这个 180 行的函数是 supplicant 漫游决策的核心——它回答一个问题：候选 AP 比当前 AP 好到值得切换吗？

## 2.1 信号分层的 min_diff 阈值

决策的第一步是根据当前 AP 的信号强度确定"最低改善门槛"（min_diff）：

```c
// wpa_supplicant/events.c:2294-2305（源码有精简）
if (cur_level < -85)       // -86dBm 以下：墙快塌了
    min_diff = 1;          // 有房就搬，不挑
else if (cur_level < -80)  // -85~-81dBm
    min_diff = 2;
else if (cur_level < -75)  // -80~-76dBm
    min_diff = 3;
else if (cur_level < -70)  // -75~-71dBm
    min_diff = 4;
else if (cur_level < 0)    // -70~-1dBm：房子还行
    min_diff = 5;          // 新房子得明显好才值得折腾
else
    min_diff = 2;          // 非 dBm 单位兜底
```

信号越差，搬家门槛越低。-86dBm 以下候选只要好 1dB 就切——这时候已经快断线了，有得换就换；-70dBm 以上信号还不错，候选得强 5dB 才值得折腾——搬家成本不小，不是好一点点就值得搬。

这 5 级阶梯把"漫游开销 vs 链路质量"的权衡直接编码成了阈值：信号差时哪怕改善 1dB 也是在争取生存空间，信号好时没有明显优势就不值得承受切换断流。注意阈值间距是均匀的 5dB，但 min_diff 从 5 到 1 递减而非递增——这不是线性映射，而是对"生存紧迫度"的指数级响应：信号每掉 5dB，链路的可用 MCS（调制编码方案）可能掉一到两个等级，吞吐量呈阶梯式下降而非线性。

![min_diff 五阶梯决策：左侧信号分层柱高对应 min_diff 1-5（-86/-80/-75/-70 dBm 阈值），右侧 est_throughput 吞吐量微调（±10/5/2），底部 diff vs min_diff 最终比较](assets/08a-STA-%E6%BC%AB%E6%B8%B8%EF%BC%88%E4%B8%80%EF%BC%89%E8%A7%A6%E5%8F%91%E4%B8%8E%E5%86%B3%E7%AD%96-%E2%80%94-%E4%BB%80%E4%B9%88%E6%97%B6%E5%80%99%E6%90%AC%E3%80%81%E6%90%AC%E5%88%B0%E5%93%AA%E5%AE%B6/08a-min-diff-ladder.svg)

阶梯式设计而非连续函数有双重考量。工程层面，固件在逐信道驻留的毫秒级窗口（典型 40ms）内完成扫描评分和切换决策，整数比较只需几条指令周期，而浮点对数函数调用可能消耗数百周期——在这个时间尺度上，计算开销直接影响逐信道驻留的有效利用率。

UX 层面，5dB 恰好跨越802.11 MCS 阶梯的一到两级——每个调制等级的 SNR 门限相差约 3-5dB（例如 64-QAM 3/4 需要约 22dB SNR，256-QAM 3/4 需要约 28dB），5dB 的 min_diff 变化意味着候选 AP 必须能让 STA 使用更高一档的调制方式，对应的实际吞吐量提升是阶梯式而非线性的。

同时用户对信号的感知也是离散的——手机信号格变化时才会注意到，连续 dBm 波动无感，5dB 的阶梯阈值恰好跨越一到两格信号变化，让漫游行为与用户直觉一致：信号"看起来没变"时不切换，"变了一格"时才考虑。

-86dBm 以下 min_diff=1 看似会导致 ping-pong（候选只需好 1dB 就切），但此时链路已接近断开——Beacon Loss 的 final 阈值（默认 20 个 Beacon，约 2 秒）随时会触发断连，ping-pong 的代价（几十毫秒断流）远小于断连重连的代价（完整 Auth/Assoc/EAPOL，数百毫秒到数秒）。

## 2.2 吞吐量微调：不只是看信号数字

但 min_diff 只看了信号强度这个表面数字——同一个 RSSI 值，在 20MHz 和 80MHz 信道宽度下的实际体验天差地别。`wpa_supplicant_need_to_roam_within_ess()` 还会通过估算吞吐量（`est_throughput`）来做进一步微调：

```c
// wpa_supplicant/events.c:2307-2322（源码有精简）
if (cur_est > sel_est * 1.5)
    min_diff += 10;       // 旧房子虽小但住得舒服，别搬
else if (cur_est > sel_est * 1.2)
    min_diff += 5;
else if (cur_est > sel_est * 1.1)
    min_diff += 2;
else if (cur_est > sel_est)
    min_diff++;           // 旧房子略优，搬家门槛提高一点
else if (sel_est > cur_est * 1.5)
    min_diff -= 10;       // 新房子大两倍还便宜，赶紧搬
else if (sel_est > cur_est * 1.2)
    min_diff -= 5;
// ...
```

这里的设计有点粗暴——吞吐量不是做比例缩放，而是直接对 min_diff 做加减。当前信号 -82dBm（min_diff=2），但当前 AP 吞吐量是候选的 1.5 倍？min_diff 直接加 10 变成 12，候选需要好 12dB 才切，基本否决了这次漫游。反过来，候选吞吐量是当前的 1.5 倍，min_diff 减 10 变成 -8，即使候选信号弱一些也会切——那个候选可能开着 160MHz 带宽，信号差两个格但实际速度快几倍。

## 2.3 频段偏好和兜底规则

```c
// wpa_supplicant/events.c（源码有精简，代码来自多处）
to_5ghz = selected->freq > 4000 && current_bss->freq < 4000;
to_6ghz = is_6ghz_freq(selected->freq) && !is_6ghz_freq(current_bss->freq);

// 频段评分差值 × 2 加入 min_diff——高频段得分更高，天然降低切换门槛
min_diff += (cur_band_score - sel_band_score) * 2;

if (cur_level < 0 && cur_level > sel_level + to_5ghz * 2 + to_6ghz * 2 &&
    sel_est < cur_est * 1.2)
    return 0; // Skip roam
```

5GHz 和 6GHz 频段通过 band score 机制自带偏好加权——高频段干扰少、可用带宽大，`wpas_evaluate_band_score()` 给高频段更高的分数，乘以 2 后加入 min_diff，天然降低切换门槛。这个设计反映了 WiFi 的物理现实：即使信号强度数字上差一点，高频段的实际体验通常更好。但如果当前信号已经在用高频段且吞吐量明显更好（1.2 倍以上），则拒绝切到低频段。

还有几条兜底规则值得一提。SNR 极好（`GREAT_SNR`）时不漫游——信号好到不需要换。候选吞吐量比当前高 5000kbps 以上时直接允许，不用走信号比较逻辑。候选 BSSID 匹配用户指定的 preferred BSSID 时也直接放行。最终 supplicant 计算 diff = sel_level - cur_level，diff < min_diff 拒绝，diff >= min_diff 允许，分别输出 `WPA_EVENT_DO_ROAM` 或 `WPA_EVENT_SKIP_ROAM`。

需要说明的是，这套判断只适用于 supplicant 接管漫游的场景——§1.1 提过 QCOM RSO 模式是驱动代劳，此时扫描周期等参数走另一条下发链：`cm_roam_start_req()`（`wlan_cm_roam_offload.c:3008`）在 3054 行调用 `cm_roam_scan_offload_scan_period()` 填好参数，再经 target_if 入口 `target_if_cm_roam_scan_offload_scan_period()`（`target_if_cm_roam_offload.c:971`）调用 `wmi_unified_roam_scan_offload_scan_period()`，把 `WMI_ROAM_SCAN_PERIOD` 下发固件。

前面两节解决了"什么时候该走"和"值不值得走"的问题，但还有一个关键前提没回答：往哪走？你不可能把附近所有信道扫一遍再挑——2.4GHz 11 个信道加 5GHz 20 多个信道，盲扫一轮几百毫秒，数据早就断了。得有人先告诉你"附近有哪些候选"。

>  **下一篇预告**：《STA 漫游（二）：802.11k/v/r 三协议 — 找房、通知、无缝切换》接着回答「搬去哪」——802.11k 邻居报告如何给出房源清单、802.11v BTM 如何处理房东推荐信、802.11r FT 如何用 VIP 通道做到不断线切换。但无论搬去哪，判断的起点仍是开篇那面墙——先看清裂缝多深，再决定值不值得折腾。
