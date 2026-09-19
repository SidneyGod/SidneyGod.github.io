---
title: 数据帧的发送 — 双平台 TX 路径对比
top: 1
related_posts: true
abbrlink: 9d254f2c
date: 2026-09-19 21:04:33
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> "管理帧是调度指令；数据帧是跑道上真正的货物——每个包裹都要经过揽件、分拣、干线运输，一站都不能少。"

---

# 本章导读

上一章我们追踪了管理帧的控制面路径——supplicant 构建 Auth/Assoc/Action 帧，经 nl80211 下发驱动，再由驱动/固件发出。那是"塔台"的世界：指令轻量、路径分叉、部分帧硬件自主处理。

但数据帧是另一个世界。它们不需要 supplicant 构建，不需要双路径分流——**所有数据包只认一个入口**。然而，数据帧的量级远大于管理帧（一个 TCP 流就能产生成百上千个数据帧），所以数据面的核心挑战不是"路径分支多"而是"**吞吐量**"——如何在软中断不能睡眠、不能长时间占 CPU 的约束下，高效地搬运数以万计的 skb。

<!--more-->

TX 路径是出港分拣线：营业部收件、分拨中心分类、干线运输发往目的地。`ndo_start_xmit` 是快递员上门揽件的唯一柜台——所有包裹都从这里进入物流系统，没有旁门左道。WMM AC 分类是快递分拣（特急件/加急件/普快/经济件），四条传送带各走各的。Block ACK 则是收件人的签收单——"这批包裹我都收到了，继续发下一批"。

这一章回答三个问题：数据帧进入驱动的入口到底有几个？QCOM 和 MTK 从包头解析到 DMA 发出，中间经过了多少站？Block ACK 为什么是唯一由 host 构造的控制帧？这三个问题的答案——数据帧的唯一定点 `ndo_start_xmit`、QCOM 从 `hdd_hard_start_xmit` 到固件的 6 层调用链、MTK `wlanHardStartXmit` 出发的 18 道工序，以及 QoS 分类、AMPDU 聚合与 Block ACK 会话管理——构成了本章的骨架。

协议依据 IEEE 802.11-2024 §9.3.2（数据帧格式）、§10.25（Block ACK）、Table 10-1 + §10.23.2（WMM AC 分类）、§9.7 + §10.12（AMPDU 聚合）。如果只想知道 QCOM 和 MTK 在设计哲学上的差异，可以跳过中间的源码细节，直接看 [第6节](#6-QCOM-vs-MTK-TX：到底差在哪里？) 的对比表格。如果你想理解数据帧的每一跳在做什么，请跟着调用链一步步往下走。

---

# 1 TX 起点：`ndo_start_xmit` —— 协议栈进驱动的唯一入口

在深入代码之前，先定一个锚点。

**TX 起点：`ndo_start_xmit`**。这是 Linux 协议栈调用网卡驱动的唯一入口。当 TCP/IP 协议栈决定发送一个数据包时，最终会调用 `__dev_queue_xmit()`（`net/core/dev.c`），它在持有 `rcu_read_lock_bh()` 的前提下，找到 net_device 的 `ndo_start_xmit` 回调并调用它。

数据帧进入驱动的门只有一个。没有旁路，没有"直接从 App 绕到驱动"的捷径，没有"固件自行从内存某个角落抓包"的魔法。**理解这个唯一定点，是你追踪数据面所有代码的第一前提。**

```c
// QCOM: core/hdd/src/wlan_hdd_main.c:6152
.ndo_start_xmit = hdd_hard_start_xmit,
// MTK: gl_init.c
.ndo_start_xmit = wlanHardStartXmit,
```

两个平台各自注册了不同的回调，但入口只有一个——`ndo_start_xmit`。

`ndo_start_xmit` 就是快递员上门揽件的唯一柜台。不管你是淘宝卖家发的普快，还是医院发的加急药品，所有包裹都必须经过这个柜台扫码入库。没有哪件包裹能绕开柜台直接跳上飞机——如果有，那就是系统漏洞。

RX 终点（`napi_gro_receive`，数据包从驱动进入协议栈的出口）将在数据帧接收文章中详细展开。

TX 和 RX 之间，整条链路**不经过 supplicant**。supplicant 是控制面的角色，数据面是纯粹的内核空间搬运——数据包从协议栈来，回协议栈去。

下图是 QCOM 和 MTK 的 TX 全景——你可以先看一眼，知道后面的代码在调用链的哪个位置：

![QCOM vs MTK: TX 全路径对比](assets/07c-%E6%95%B0%E6%8D%AE%E5%B8%A7%E7%9A%84%E5%8F%91%E9%80%81-%E2%80%94-%E5%8F%8C%E5%B9%B3%E5%8F%B0-TX-%E8%B7%AF%E5%BE%84%E5%AF%B9%E6%AF%94/07c-tx-full-path.svg)

---

# 2 QCOM 的数据帧如何发出？——出港分拣线追踪

现在我们追踪一个数据包在 QCOM 驱动中从入口到固件的完整路径。

## 2.1 协议栈 → 驱动入口：`hdd_hard_start_xmit`

QCOM 的 `ndo_start_xmit` 回调注册为 `hdd_hard_start_xmit`（`core/hdd/src/wlan_hdd_tx_rx.c`）。这是数据包进入 QCOM WiFi 驱动的第一站：

```c
// core/hdd/src/wlan_hdd_tx_rx.c — hdd_hard_start_xmit, ndo_start_xmit 回调
netdev_tx_t hdd_hard_start_xmit(struct sk_buff *skb, struct net_device *net_dev)
{
    hdd_dp_ssr_protect();                        // SSR 保护：递增保护计数
    __hdd_hard_start_xmit(skb, net_dev);         // 委托给内部函数
    hdd_dp_ssr_unprotect();                      // SSR 保护：递减保护计数
    return NETDEV_TX_OK;                         // 永远返回 OK
}
```

其中 `hdd_dp_ssr_protect` / `hdd_dp_ssr_unprotect` 定义在 `core/hdd/inc/wlan_hdd_main.h` 中，是一对极简的内联函数：

```c
// core/hdd/inc/wlan_hdd_main.h — SSR 保护配对
static inline void hdd_dp_ssr_protect(void)
{
    qdf_atomic_inc_return(&dp_protect_entry_count);
}
static inline void hdd_dp_ssr_unprotect(void)
{
    qdf_atomic_dec(&dp_protect_entry_count);
}
```

主要功能：

- **SSR 保护通过 protect/unprotect 配对实现**：两个内联函数操作全局原子计数器 `dp_protect_entry_count`。SSR（子系统重启）流程在关闭数据面之前等待该计数器归零，从而保证不会在 `__hdd_hard_start_xmit` 执行到一半时拆除数据结构
- `hdd_hard_start_xmit` 本身不做任何 adapter/context 提取——全部委托给 `__hdd_hard_start_xmit`
- 不管底层发生了什么，这个函数**永远返回 `NETDEV_TX_OK`**——丢包由 `__hdd_hard_start_xmit` 内部处理（free skb），SSR 保护通过计数器机制在更上层生效

## 2.2 WMM 分类与准入控制：`__hdd_hard_start_xmit`

`__hdd_hard_start_xmit`（`core/hdd/src/wlan_hdd_tx_rx.c`）是 QCOM TX 路径的第一个重函数。它的核心工作是 WMM AC 分类：

这个函数按执行顺序分为 6 个步骤：**FTM 保护** → **包类型标记** → **AC 查表分类** → **WMM 准入判断** → **降级 fallback** → **DP 层发送**。阅读下面的代码时关注控制流（`if`/`while` 分支），不纠结每个 QDF 宏的展开细节——步骤详解紧跟在代码块后面。

```c
// core/hdd/src/wlan_hdd_tx_rx.c — __hdd_hard_start_xmit, WMM AC 分类核心
static void __hdd_hard_start_xmit(struct sk_buff *skb, struct net_device *dev)
{
    struct hdd_adapter *adapter = WLAN_HDD_GET_PRIV_PTR(dev);
    struct hdd_station_ctx *sta_ctx = &adapter->session.station;
    sme_ac_enum_type ac;
    enum sme_qos_wmmuptype up;
    bool granted;
    QDF_STATUS status;

    // 步骤1：FTM 模式下丢包保护
    if (hdd_drop_tx_packet_on_ftm(skb))
        return;

    // 步骤2：标记包类型（供 DP 层使用）
    osif_dp_mark_pkt_type(skb);

    // 步骤3：AC 分类——通过查表将 qdisc 队列号映射到 TL AC
    ac = hdd_qdisc_ac_to_tl_ac[skb->queue_mapping];
    up = skb->priority;

    // 步骤4：WMM 准入控制——SME 状态机管理
    if (HDD_PSB_CHANGED == adapter->psb_changed)
        hdd_wmm_acquire_access_required(adapter, ac);

    // EAPOL/WAPI 在未认证状态下绕过准入控制
    if (((adapter->psb_changed & (1 << ac)) &&
         likely(adapter->hdd_wmm_status.ac_status[ac].is_access_allowed)) ||
        ((!sta_ctx->conn_info.is_authenticated) &&
         (QDF_NBUF_CB_PACKET_TYPE_EAPOL ==
          QDF_NBUF_CB_GET_PACKET_TYPE(skb) ||
          QDF_NBUF_CB_PACKET_TYPE_WAPI ==
          QDF_NBUF_CB_GET_PACKET_TYPE(skb)))) {
        granted = true;
    } else {
        status = hdd_wmm_acquire_access(adapter, ac, &granted);
        adapter->psb_changed |= (1 << ac);
    }

    // 步骤5：WMM 降级——准入失败时逐级 fallback
    if (!granted) {
        bool is_default_ac = false;
        while (!likely(adapter->hdd_wmm_status.ac_status[ac].is_access_allowed)) {
            switch (ac) {
            case SME_AC_VO:  ac = SME_AC_VI; up = SME_QOS_WMM_UP_VI; break;
            case SME_AC_VI:  ac = SME_AC_BE; up = SME_QOS_WMM_UP_BE; break;
            case SME_AC_BE:  ac = SME_AC_BK; up = SME_QOS_WMM_UP_BK; break;
            default:         ac = SME_AC_BK; up = SME_QOS_WMM_UP_BK;
                             is_default_ac = true; break;
            }
            if (is_default_ac) break;
        }
        skb->priority = up;
        skb->queue_mapping = hdd_linux_up_to_ac_map[up];
    }

    // 步骤6：通过 DP 层发送
    status = ucfg_dp_start_xmit((qdf_nbuf_t)skb, adapter->vdev);
    if (QDF_IS_STATUS_SUCCESS(status)) {
        netif_trans_update(dev);
        wlan_hdd_sar_unsolicited_timer_start(adapter->hdd_ctx);
    } else {
        ++adapter->hdd_stats.tx_rx_stats.per_cpu[cpu].tx_dropped_ac[ac];
    }
}
```

主要功能（逐个步骤详解）：

**步骤 1：`hdd_drop_tx_packet_on_ftm()` -- FTM 模式下的发包保护**

FTM（Factory Test Mode，工厂测试模式）是一种特殊的驱动运行模式，用于产线校准 WiFi 射频参数（如发射功率、频偏补偿）。在这种模式下，驱动处于校准状态而非正常工作状态，所有上层数据包（如 ARP、DNS 查询等）都是无意义的噪声，必须丢弃。

该函数有两种编译版本（通过 `#ifdef` 条件编译区分）：

- **FTM 模式开启时**：调用 `hdd_get_conparam()` 检查当前运行模式，如果是 `QDF_GLOBAL_FTM_MODE`，直接 `kfree_skb` 并返回 `true`（表示"需要丢包"）
- **FTM 模式未编译时**：该函数退化为一个只返回 `false` 的 stub，零开销

这是一个`static inline`函数，在设计上追求极致轻量——它位于`ndo_start_xmit`的**第一跳**，任何额外的函数调用或分支都会影响所有数据包的吞吐量。

**步骤 2：`osif_dp_mark_pkt_type()` -- 以太网帧头的解析与标记**

这是数据包进入 QCOM 驱动后第一次被"解读"。该函数的职责是解析以太网帧头，为后续 DP 层的统计和特殊处理打下基础：

1. **零出 CB**：`qdf_mem_zero(skb->cb, sizeof(skb->cb))`——将 skb 的控制块（Control Block，通常 48 字节）全部清零。QCOM 规定 CB 的第一次写入必须是 TX 路径的硬启动入口，清零保证不会残留上一次使用时写入的状态
2. **广播/多播检测**：通过 `is_broadcast_ether_addr()` 和 `is_multicast_ether_addr()` 检查目的 MAC 地址，在 CB 中设置标志位——后续 DP 层根据这些标志决定是否需要做多播过滤
3. **关键帧标记**：如果 skb 的 `queue_mapping` 属于 HI_PRIO 队列，调用 `osif_dp_mark_critical_pkt()` 标记为关键帧——关键帧在后续的发送路径中享有更高的优先级和更少的限制

这一步不改变 skb 数据本身，只在 CB 中做标记——但它是后续 DP 层所有统计（ARP 计数、DHCP 计数）和特殊处理（EAPOL 快速路径）的入口前提。

**步骤 3：`hdd_qdisc_ac_to_tl_ac` 查表 -- Linux qdisc 到 QCOM TL AC 的映射**

这行代码 `ac = hdd_qdisc_ac_to_tl_ac[skb->queue_mapping]` 是整个 WMM 分类的核心。`skb->queue_mapping` 是 Linux 内核 `netdev_pick_tx` 分配的 qdisc 队列号（通常 0-3 对应 4 个 AC），而 QCOM 内部使用自己的 TL（Transport Layer）AC 枚举。映射表的内容如下：

```
Linux qdisc 号 → QCOM TL AC 枚举
  0 (VO)      → SME_AC_VO   (语音，最高优先级)
  1 (VI)      → SME_AC_VI   (视频)
  2 (BE)      → SME_AC_BE   (尽力而为，默认)
  3 (BK)      → SME_AC_BK   (背景，最低优先级)
```

不过这个 4 条目的映射只是默认编译配置下的简化视图。开启 `TX_MULTIQ_PER_AC`（per-AC 多队列）后，数组膨胀为 16 个条目——每个 AC 各占 4 个 flow-controlled 队列，让流控能按更细的粒度生效；再叠加 QCA 的 LL TX Flow Control（`QCA_LL_TX_FLOW_CONTROL_V2` 或 `QCA_LL_PDEV_TX_FLOW_CONTROL`）时，数组还会额外追加一个非流控条目并映射到 `SME_AC_VO`（非 per-AC 配置下是第 5 个条目，per-AC 多队列下是第 17 个）。这个多出来的队列正是步骤 2 提到的 HI_PRIO 控制队列——EAPOL、DHCP 这类连接建立期关键帧走这条不受流控约束的专用通道，即使 16 个数据队列被 LL flow control 全部限流，认证握手包也照发不误。这也呼应了步骤 4b：EAPOL 帧之所以能绕过准入控制，是因为它从队列映射这一层起就被归入了最高优先级的 VO，而非普通数据队列。

同时 `up = skb->priority` 提取了用户优先级（User Priority，0-7），这是 IEEE 802.1D 定义的 8 级优先级，在 WMM 降级时会用到。

**步骤 4a：`hdd_wmm_acquire_access_required()` -- PSB 准入判断**

当 `adapter->psb_changed` 的值为 `HDD_PSB_CHANGED`（表示 PSB 状态已变更，需要重新评估准入）时，调用此函数。PSB（Power Save Block）是 QCOM 对每个 AC 的准入配置位掩码——每个 AC 对应一个 bit，1 表示该 AC 需要准入控制。

该函数的逻辑非常简洁：根据 AC 类型清除 `psb_changed` 中对应的 bit（`&= ~SME_QOS_UAPSD_CFG_BK_CHANGED_MASK` 等），表示"准入条件已检查完毕，不再需要评估"。它本质上是一个状态重置函数，为后续的 `hdd_wmm_acquire_access()` 做准备——不改变准入决策本身，只改变"是否需要评估"的状态位。

**步骤 4b：EAPOL/WAPI 快速路径**

在调用 `hdd_wmm_acquire_access()` 之前，代码先判断是否是 EAPOL/WAPI 帧且 STA 未认证。如果是，直接设置 `granted = true`，完全绕过 SME 准入状态机。

这是关键设计决策：EAPOL（4 次握手帧）和 WAPI（中国国标认证帧）是建立安全关联的必须帧。如果因为 WMM 准入限制导致这些帧被丢弃，连接永远无法建立——这是一个死锁场景。绕过的代价是临时打破 AC 的准入约束，但收益是避免了认证死锁。

**步骤 4c：`hdd_wmm_acquire_access()` -- SME 准入状态机**

这是准入判断的核心——SME（Session Management Entity）状态机对每个 AC 维护一个状态表 `ac_status[AC]`，包含以下字段：

| 字段                 | 含义                                           |
| -------------------- | ---------------------------------------------- |
| `is_access_allowed`  | 当前是否允许该 AC 发送                         |
| `is_access_required` | 该 AC 是否需要准入控制（取决于 BSS 的 WMM IE） |
| `is_access_needed`   | 是否已发起准入请求                             |
| `is_access_pending`  | 准入请求是否正在处理中                         |
| `has_access_failed`  | 之前的准入请求是否已失败                       |

SME 状态机的决策逻辑如下：

1. **QoS 未启用或 AC 不需要准入控制** → 直接允许（`*granted = is_access_allowed`）
2. **已发起准入请求或正在处理中** → 拒绝（`*granted = false`），调用者需等待工作队列异步完成
3. **之前准入失败** → 根据 `is_access_required` 决定：如果不需要准入则允许，否则拒绝
4. **需要发起准入请求** → 分配 `hdd_wmm_qos_context`、通过 `schedule_work()` 提交 `hdd_wmm_do_implicit_qos` 工作队列，立即返回 `*granted = false`——调用者需要等待异步结果

关键点：准入请求是**异步的**——`schedule_work()` 不阻塞，返回 `granted = false` 后，调用者进入降级逻辑。实际的 TSPEC 协商在 `hdd_wmm_do_implicit_qos` 工作函数中完成，完成后通过回调更新 `ac_status` 状态。

**步骤 5：WMM 降级 -- VO→VI→BE→BK fallback**

当 `granted = false` 时，代码进入降级循环。降级顺序为什么是 VO→VI→BE→BK？

这与 IEEE 802.11-2024 Table 10-1（UP-to-AC 映射，see §10.23.2）和 WMM 的 AC 优先级一致：

- **VO（Voice，AC 3）**：最高优先级，用于 VoIP 等实时语音——延迟要求最高，但带宽需求最小
- **VI（Video，AC 2）**：次高优先级，用于视频流——带宽需求大，对延迟中等敏感
- **BE（Best Effort，AC 0）**：默认优先级，用于普通 TCP/IP 流量——延迟和带宽均不敏感
- **BK（Background，AC 1）**：最低优先级，用于后台下载/文件同步——延迟完全不敏感

降级顺序是**从高到低逐级尝试**：VO 的准入没通过，说明当前 BSS 的 VO AC 资源已饱和，降级到 VI 重试。VI 没通过继续降 BE，BE 也没通过降到 BK。最后到达 BK 时设置 `is_default_ac = true` 作为终止条件——BK 是"兜底 AC"，理论上不应该有准入限制。

每次降级时，同时更新 `skb->priority`（设置为目标 AC 对应的 UP 值，如 `SME_QOS_WMM_UP_VI`）和 `skb->queue_mapping`（通过 `hdd_linux_up_to_ac_map[up]` 反向查表）。

`is_default_ac` 标志的作用：当 `ac` 已经是 BK 时，`is_access_allowed` 仍可能为 `false`（极端情况）。设置 `is_default_ac = true` 后 `break`，跳出降级循环，**不再继续尝试**——BK 是终点，没有更低优先级可选。此刻即使准入仍未通过，也会继续调用 `ucfg_dp_start_xmit` 发送。

**步骤 6：调 `ucfg_dp_start_xmit()` 委托 DP 层**

发送成功后，`netif_trans_update(dev)` 更新 net_device 的最后发送时间戳（用于 tx_timeout 监控），`wlan_hdd_sar_unsolicited_timer_start()` 启动 SAR 非请求定时器（用于 SAR 场景的周期性功率上报）。

该函数是 `void` 返回——丢包通过 free skb 实现，不通过返回值通知协议栈。

**WMM AC 分类速查**

上面展开的 QCOM WMM 分类逻辑，最终都归结到 IEEE 802.11-2024 Table 10-1（UP-to-AC 映射，§10.23.2）定义的四个 AC。下表汇总了 AC 与 UP、Linux qdisc 队列、典型流量的对应关系，方便追踪代码时快速查阅：

| AC                          | 优先级 | UP 映射 | Linux qdisc | 典型流量           | QCOM 策略         | MTK 策略     |
| --------------------------- | ------ | ------- | ----------- | ------------------ | ----------------- | ------------ |
| **VO**（Voice，AC 3）       | 最高   | 7, 6    | 0           | VoIP、SIP 信令     | 准入失败降 VI     | 超阈值停队列 |
| **VI**（Video，AC 2）       | 次高   | 5, 4    | 1           | 视频流、IPTV       | 准入失败降 BE     | 超阈值停队列 |
| **BE**（Best Effort，AC 0） | 默认   | 3, 0    | 2           | HTTP、TCP 普通流量 | 准入失败降 BK     | 超阈值停队列 |
| **BK**（Background，AC 1）  | 最低   | 2, 1    | 3           | 后台下载、文件同步 | 兜底 AC，不再降级 | 超阈值停队列 |

完整设计哲学对比见 [第 6 节](#6-QCOM-vs-MTK-TX：到底差在哪里？)。

## 2.3 DP 层到固件：`dp_start_xmit` 的十道关卡

`ucfg_dp_start_xmit`（`components/dp/dispatcher/src/wlan_dp_ucfg_api.c`）做常规的 adapter 有效性检查和 vdev 解析后，调用真正的发送函数 `dp_start_xmit`（`components/dp/core/src/wlan_dp_txrx.c`）。`dp_start_xmit` 是 DP（Data Path）层的 TX 调度入口，**在将 skb 交给芯片相关 `tx_fn` 之前，它先过 10 道关卡**：

```c
// components/dp/core/src/wlan_dp_txrx.c — dp_start_xmit, DP 层 TX 调度入口（goto 标签简化为 drop_pkt_and_release_nbuf；源码分 drop_pkt / drop_pkt_accounting / drop_pkt_and_release_nbuf 三标签以区分统计路径）
QDF_STATUS dp_start_xmit(struct wlan_dp_intf *dp_intf, qdf_nbuf_t nbuf)
{
    void *soc = cds_get_context(QDF_MODULE_ID_SOC);
    struct wlan_dp_psoc_context *dp_ctx;
    uint8_t pkt_type;

    // 关卡1：驱动状态转换检查（SSR/初始化过渡期丢包）
    if (cds_is_driver_transitioning())
        goto drop_pkt_and_release_nbuf;

    // 关卡2：系统休眠状态检查
    dp_ctx = dp_intf->dp_ctx;
    if (dp_ctx->is_suspend)
        goto drop_pkt_and_release_nbuf;

    // 关卡3：ARP/EAPOL/DHCP/ICMP 包类型分类与统计
    pkt_type = QDF_NBUF_CB_GET_PACKET_TYPE(nbuf);
    if (qdf_nbuf_data_is_arp_req(nbuf)) {          // ARP：跟踪 track_arp_ip
        // ...
    } else if (qdf_nbuf_get_eapol_subtype(nbuf) == M2 ||
               qdf_nbuf_get_eapol_subtype(nbuf) == M4) { // EAPOL：区分 M2/M4
        // ...
    } else if (qdf_nbuf_get_dhcp_subtype(nbuf) == DHCP_DISCOVER ||
               qdf_nbuf_get_dhcp_subtype(nbuf) == DHCP_REQUEST) { // DHCP
        // ...
    }
    dp_mark_icmp_req_to_fw(nbuf);                    // ICMP/ICMPv6 标记到固件

    // 关卡4：目标 MAC 地址有效性检查（输出参数模式）
    dp_get_transmit_mac_addr(dp_intf, nbuf, &mac_addr_tx_allowed);
    if (qdf_is_macaddr_zero(&mac_addr_tx_allowed))
        goto drop_pkt_and_release_nbuf;

    // 关卡5：TX ring 资源检查（预取/更新资源状态，非返回值判断）
    dp_get_tx_resource(dp_intf, &mac_addr_tx_allowed);

    // 关卡6：dp_nbuf_orphan() — skb 与 socket 解绑（QCOM 核心优化）
    if (!qdf_nbuf_ipa_owned_get(nbuf))
        nbuf = dp_nbuf_orphan(dp_intf, nbuf);

    // 关卡7：二次可发送性校验（tx_fn 注册前的最后一道检查）
    if (!dp_intf_is_tx_allowed(nbuf, dp_intf->intf_id, soc,
                               mac_addr_tx_allowed.bytes))
        goto drop_pkt_and_release_nbuf;

    // 关卡8：非 TSO 非线性 skb 线性化
    if (dp_nbuf_nontso_linearize(nbuf) != QDF_STATUS_SUCCESS) {
        dp_err("nbuf linearize failed. drop the pkt");
        goto drop_pkt_and_release_nbuf;
    }

    // 关卡9：tx_fn 校验与芯片平台解耦调用
    if (!dp_intf->tx_fn) {
        dp_err("TX function not registered by the data path");
        goto drop_pkt_and_release_nbuf;
    }

    // 关卡10：广播 EAPOL 帧的目的地址修复（在 tx_fn 调用之前，void 函数，就地修改）
    dp_fix_broadcast_eapol(dp_intf, nbuf);

    if (dp_intf->tx_fn(soc, dp_intf->intf_id, nbuf)) {
        dp_debug_rl("Failed to send packet");
        goto drop_pkt_and_release_nbuf;
    }
    return QDF_STATUS_SUCCESS;

drop_pkt_and_release_nbuf:
    qdf_net_buf_debug_release_skb(nbuf);
    qdf_net_stats_inc_tx_dropped(&dp_intf->stats);
    return QDF_STATUS_E_FAILURE;
}
```

**关卡 1：`cds_is_driver_transitioning()` -- 驱动状态转换检查**

这是 DP 层的第一道防线。驱动的生命周期中存在多个"过渡期"——SSR（子系统重启）、驱动初始化、驱动卸载——在这些状态下，DP 层的数据结构可能正在被重建或销毁，任何 TX 操作都是不安全的。

`cds_is_driver_transitioning()` 检查 CDS（Converged Device Service）层的全局状态标记，判断当前是否处于过渡状态。如果是，直接丢包——这些包不会重传，由上层协议栈（TCP 重传或 UDP 应用层重传）负责恢复。

**关卡 2：`dp_ctx->is_suspend` -- 系统休眠状态检查**

当系统进入休眠（suspend）状态时，PCIe 链路可能已断电，固件可能已停止运行。此时通过 `is_suspend` 标志位直接拒绝发送，避免 DMA 到已断电的硬件导致总线错误（Bus Error）。

**关卡 3：ARP/EAPOL/DHCP/ICMP 包类型分类 -- 四类特殊包的统计用途**

这是 `dp_start_xmit` 中最"长"的分类逻辑。QCOM 不改变这些包的发送路径，但对其做了分类统计用于 debug：

- **ARP**（`qdf_nbuf_data_is_arp_req()`）：跟踪 `track_arp_ip`，记录目标 IP 用于连接事件关联
- **EAPOL**（`qdf_nbuf_get_eapol_subtype()` 区分 M2/M4）：记录 4 次握手步骤是否已发送，辅助定位连接失败点
- **DHCP**（`qdf_nbuf_get_dhcp_subtype()` 区分 DISCOVER/REQUEST）：追踪 IP 获取流程，用于连接时延分析
- **ICMP/ICMPv6**（`dp_mark_icmp_req_to_fw()`）：标记 skb 标志位供固件按省电策略决定处理优先级

**关卡 4：`dp_get_transmit_mac_addr()` -- 目标 MAC 地址有效性检查**

该函数本身不返回布尔值——它通过第三个参数 `&mac_addr_tx_allowed` 输出当前允许发送的目标 MAC 地址。主调方随后通过 `qdf_is_macaddr_zero(&mac_addr_tx_allowed)` 判断：如果输出地址为零，说明当前没有允许发送的目标（如在 STA 未关联 AP 的状态下），直接丢包。

广播和多播帧不受此限制——DHCP DISCOVER 的广播帧即使在未关联状态也可能需要发送（虽然实际发送由底层决定）。

**关卡 5：`dp_get_tx_resource()` -- TX ring 资源预取**

这跟标准丢包决策不同——`dp_get_tx_resource()` 的返回值在源码中未被检查（无 `if` 判断）。它的作用是**更新内部资源状态**：预取 TX ring 的空闲 slot 信息、更新 per-peer 的发送配额。真正的丢包决策由后续的 `dp_intf->tx_fn()` 在尝试实际发送时做出（ring 满则返回失败，触发丢包路径）。

这种"预取状态、延迟决策"的设计避免了在 `dp_start_xmit` 中对资源的抢锁竞争——资源消费在 `tx_fn` 中（已持有硬件相关锁），预取在这里只是读状态。

以上 5 道关卡完成准入检查与资源预取，接下来 5 道关卡聚焦 skb 数据准备与平台解耦——这是数据包进入 `tx_fn` 之前的最后加工。

**关卡 6：`dp_nbuf_orphan()` -- skb 与 socket 解绑（QCOM 数据面优化的核心技巧）**

这是 QCOM 数据面最重要的优化之一（定义于 `components/dp/core/inc/wlan_dp_txrx.h:377`，调用于 `components/dp/core/src/wlan_dp_txrx.c:633`）。注意：`dp_nbuf_orphan()` 的前置条件是 `if (!qdf_nbuf_ipa_owned_get(nbuf))`——当 skb 已被 IPA（IP Accelerator，硬件加速卸载引擎）持有时，跳过 orphan。因为 IPA 有自己的 buffer 管理机制，由硬件 DMA 直接操作，host 侧解绑会破坏 IPA 的 buffer 生命周期管理。

`dp_nbuf_orphan()` 的内部逻辑如下：

1. **判断是否需要 orphan**：根据 `tx_flow_low_watermark`（发送流低水位线）和 `tx_orphan_enable` 配置决定。当水位线 > 0 或显式启用 orphan 时，触发解绑
2. **仅对 TCP 包进行 orphan**（早期实现）：`qdf_nbuf_is_ipv4_tcp_pkt()` / `qdf_nbuf_is_ipv6_tcp_pkt()` 判断——UDP 包不需要 orphan，因为 UDP 没有 congestion window 的限制
3. **调用 `qdf_nbuf_orphan()`**（封装了 Linux 内核的 `skb_orphan()`）：将 skb 与发送它的 socket 解绑，清除 skb 的 destructor 回调

为什么这是关键优化？

在标准 Linux 协议栈中，每个 skb 都属于一个 socket，socket 有一个发送缓冲区配额（`sk_wmem_alloc`）。当驱动队列积压了大量 skb 等待硬件发送时，这些 skb 仍然占用 socket 的缓冲区配额，协议栈会被迫停止发送更多数据。`skb_orphan()` 解除这个归属关系——**socket 层的 buffer 配额立即释放**，协议栈可以继续发送新数据，驱动队列深度由 TX ring 的资源检查（关卡 5）来控制。

假设快递员有一个"20 个包裹"的工作额度（socket buffer 配额）。每收一个包裹，额度减 1；直到分拨中心确认已发出（skb destructor 回调），额度才恢复。如果分拨中心积压严重，快递员的额度很快用完，无法继续揽收。`skb_orphan()` 相当于快递员一放下包裹就立即恢复额度——他不管分拨中心是否已发货，只管继续揽收。包裹会不会丢？不会，因为分拨中心有自己独立的容量管理（关卡 5 的 TX ring 资源检查）。

在不启用 orphan 的情况下（或对于不需要 orphan 的包），调用 `__qdf_nbuf_unshare()` 来确保 skb 不被其他代码路径共享（unshare 非 orphan 的替代路径）。

**关卡 7：`dp_intf_is_tx_allowed()` -- 二次可发送性校验**

这是 `tx_fn` 注册检查之前的最后一道安全门。`dp_intf_is_tx_allowed()` 携带 4 个参数 `(nbuf, intf_id, soc, mac_addr.bytes)` 做最终的综合判断：关联状态是否仍然有效、目标 MAC 是否允许发送、接口是否被管理员 down 掉。注意：这跟关卡 4 的 `dp_get_transmit_mac_addr` 是两个独立检查——关卡 4 侧重"有没有合法的目标地址"，关卡 7 侧重"当前状态是否允许向该地址发包"。它们是冗余设计：两个检查点都在 fail 时 `goto drop_pkt_and_release_nbuf`。

**关卡 8：`dp_nbuf_nontso_linearize()` -- 非 TSO 非线性 skb 线性化**

Linux 内核的 skb 数据结构支持两种非线性存储方式：

- **frag_list**：skb 的 head 描述符指向一个完整的 skb 链表
- **fragments（nr_frags）**：skb 的 data 指针指向连续的 headroom 区域，但页面碎片（page fragment）附加在后面

DMA 引擎需要连续的物理内存来进行数据传输。对于非 TSO（TCP Segmentation Offload）的 skb，如果它是非线性的（frag_list 或 nr_frags > 1），`dp_nbuf_nontso_linearize()` 内部对非线性 skb 调用 `qdf_nbuf_linearize()` 将 frag_list 合并到线性数据区——这涉及一次 memcpy 操作。

TSO 包是例外：TSO 本身的设计就允许非线性布局（硬件负责分段），不需要线性化。

**关卡 9：`dp_intf->tx_fn` -- 函数指针校验与发送**

这是 QCOM 数据面架构的精华之一。代码先检查 `tx_fn` 是否注册（未注册 → 丢包），然后调 `dp_fix_broadcast_eapol` 修复地址，最后通过 `tx_fn(soc, intf_id, nbuf)` 将 skb 交付给芯片平台实现。

**关卡 10：`dp_fix_broadcast_eapol()` -- 广播 EAPOL 帧的地址修复**

在某些 4 次握手的步骤中，EAPOL 帧可能以广播目的 MAC 地址（`ff:ff:ff:ff:ff:ff`）发送。但有些芯片平台不支持广播地址的 EAPOL 帧——它们要求 EAPOL 帧的目的地址必须是 BSSID（AP 的单播 MAC 地址）。

`dp_fix_broadcast_eapol()` 检测这种情况：如果 skb 是 EAPOL 帧且目的地址是广播地址，将目的 MAC 替换为当前关联 AP 的 BSSID。这是一个**兼容性修复（workaround）**，不是标准行为。

---

以上 10 道关卡涵盖了 `dp_start_xmit` 的所有检查路径。通过 `tx_fn` 函数指针交接后，数据帧进入传输层。QCOM 的 WiFi 驱动需要支持多种芯片平台（如 QCA8074、QCA6390、WCN6855），不同平台的硬件架构决定了传输层的具体实现——但都是从 HTT 消息封装开始，到固件接收为止。下面追踪每种传输方式的完整函数调用链。

## 2.4 传输层到固件：HTT → CE → PCIe 调用链

### 2.4.1 HTT 消息封装 —— wifi3.0 路径

在 wifi3.0（qca-wifi-host-cmn）平台中，`tx_fn` 的指向因帧类型而异：

- **快速路径（WiFi 3.0 BE）**：`dp_tx_fast_send_be()`（`dp/wifi3.0/be/dp_be_tx.c:2311`）——TCL（Target Copy List）硬件描述符直接写入 DMA 地址，无需 HTT 描述符，skb 数据通过 `dma_map_single` 零拷贝映射
- **常规路径**：`dp_tx_send()`（`dp/wifi3.0/dp_tx.c:5028`）——构造 HTT TCL 描述符，通过 `struct htt_tx_msdu_desc_ext2_t *` 指针（`dp_tx.c:756`）强制转换 `meta_data` 来访问扩展描述符字段（key flags、host opaque 等）。TCL 元数据通过 `DP_TX_TCL_METADATA_*_SET()` 系列宏（`dp_tx.c:84-98`）填充
- **Mesh 帧**：`dp_tx_send_mesh()`（`dp/wifi3.0/dp_tx.c:4817`）——内部委托 `dp_tx_send()`
- **带 vdev 校验**：`dp_tx_send_vdev_id_check()`（`dp/wifi3.0/dp_tx.c:5244`）——带额外 vdev 状态检查后委托 `dp_tx_send()`

发送链后续进入 HTC 层（HTT 运行在 HTC endpoint 之上）：

```
dp_tx_send() / dp_tx_fast_send_be()
  → __htc_send_pkt()                       // htc/htc_send.c:1896 — HTC 层发送入口，封装 HTC header
    → htc_try_send()                       // htc/htc_send.c:1461 — 流控检查（credits 余额）后从队列取包
      → htc_issue_packets()                // htc/htc_send.c:727 — 打包并提交到 HIF 层
        → HIF callback（HTCSendComplete）  // 通过 CE（Copy Engine）handle 将包写入 CE source ring
```

HTC 的 credit 流控：每个 endpoint 的 credit 数量由固件在服务连接阶段（HTC_CONNECT_SERVICE_CMDID）分配——固件根据自身的接收 buffer 容量为每个 endpoint 指定初始 credit 数量。host 每发 1 包消耗 1 credit，固件处理完成并通过空口发出后，通过 H2T credit report 消息归还 credit（含归还数量 + endpoint ID）。`htc_try_send()` 检查 credit 是否足够——不够则包留在 endpoint 发送队列中，等固件通过 H2T credit report 归还 credit 后再触发重试（`htc_try_send(target, pEndpoint, NULL)` 在 `htc_process_credit_rpt()`（htc/htc_send.c:2932）中回调）。HTT 数据通道使用 endpoint 2（Credit-Based Flow Control），提交后的完成回调注册为 `dp_htt_h2t_send_complete()`（`dp/wifi3.0/dp_htt.c:294`）。这条 credit 链路只管数据通道；WMI 控制通道的流控是另一套——`wmi_unified_cmd_send_fl()`（`wmi/src/wmi_unified.c:2122`）在把命令交给 HTC 之前，先用 `pending_cmds` 原子计数对 `wmi_max_cmds` 上限做预检，超限就通过 `wmi_get_host_credits()`（`wmi/src/wmi_unified.c:3811`）读出控制 endpoint（`WMI_CONTROL_SVC`）的剩余 TxCredits 打印诊断后返回 `QDF_STATUS_E_BUSY`，压根到不了 `htc_try_send()` 的 endpoint 闸门。

### 2.4.2 HTT 消息封装 —— CLD（qcacld-3.0）路径

CLD 平台不使用 HTC 层，HTT 描述符直接通过 HIF 层发送：

```
dp_intf->tx_fn = ol_tx_data()               // core/dp/txrx/ol_tx.c:52 — dp_start_xmit 通过 tx_fn 指针调用
  → ol_tx_send()                             // core/dp/txrx/ol_tx_send.c:200 — CLD TX 发送入口
    → htt_tx_desc_init()                     // core/dp/htt/htt_tx.c:1672 — 初始化 HTT TX 描述符
      → qdf_nbuf_map_single(msdu)            // dma_map_single — skb data → DMA 地址（零拷贝）
      → qdf_nbuf_frag_push_head(msdu, ...)   // HTT 描述符作为 frag 0 前置到 skb
         frag 0: HTT 描述符（独立 DMA 地址，包含 TX vector、peer ID、TID）
         frag 1: skb->data（原始数据帧，独立 DMA 映射）
    → htt_tx_send_std()                      // core/dp/htt/htt_tx.c:777 — 通过 HIF 层提交到硬件
```

两种路径（wifi3.0 + CLD）最终在 HIF 层汇合，HIF 层根据总线类型选择 PCIe 或 SDIO 物理通道。

### 2.4.3 CE（Copy Engine）—— DMA 搬运引擎

HIF 层将 HTT 消息提交到 CE ring buffer（wifi3.0 路径通过 HTC → HIF callback，CLD 路径直接 `htt_tx_send_std()` → HIF 提交）：

```
hif_send_single()                          // hif/src/hif_main.c:3078 — HIF 层统一入口
  → ce_send_single()                       // hif/src/ce/ce_service.c:750 — CE 发送核心
    → 填写 src ring entry：buffer 物理地址 + 长度 + flags
    → war_ce_src_ring_write_idx_set()      // ce_service.c:487 — 更新 write index
    → hif_write32_mb()                        // PCIe MMIO 写 — 写 doorbell 寄存器
```

CE 是 QCOM 的专用 DMA 引擎，每对 TX/RX ring 对应一个有方向的管道。host 侧写 source ring，硬件从 destination ring 读出——CE 负责将数据从 host 内存 DMA 搬运到固件的共享内存。整个过程 host CPU 只参与填写 ring entry 和 `hif_write32_mb()` 写 doorbell，不参与实际数据搬运。而 CE ring 之所以不会被填满，靠的是上游 HTC credit 流控兜底——`htc_try_send()` 在包进入 CE ring 之前就检查 credit 余额、把流量闸在软件层，否则包会一路走到 `ce_send_single()` 才发现 ring 满丢包，前面的 HTC 封包全部白做。

### 2.4.4 PCIe —— 物理总线

CE 操作最终落到 PCIe 总线事务上：

```
ce_send_single()
  → war_ce_src_ring_write_idx_set()        // ce_service.c:487
    → hif_write32_mb()                        // PCIe MMIO write — 写 src_ring->write_idx 寄存器
  → 硬件检测 write index ≠ read index → 发起 PCIe DMA read
  → 数据从 host 物理内存 → 固件共享内存
  → 固件 CE 中断处理函数收到 doorbell 中断 → 从共享内存取走数据帧
```

CE + PCIe 是 QCOM 高端芯片的标准运输线。但低端 IoT 芯片（如 QCA9377）没有 PCIe DMA 能力，走的是另一条路——SDIO。

### 2.4.5 SDIO —— 低速接口的特殊处理

对于 SDIO 接口的芯片（如 QCA9377），不使用 PCIe DMA 和 CE ring buffer——改用 SDIO 命令直接传输：

```
// SDIO HIF 层通过 HIF 通用发送入口（`hif_send_single()`，hif_main.c:3078）进入
// 经 HIF 层分发后调用：
  → sdio_memcpy_toio()                     // mailbox.c:1725 — CMD53 递增地址多字节写
                                           // 或 sdio_writesb()（mailbox.c:1719 — CMD53 固定地址写）
  → 硬件 SDIO controller 将数据串行传输到 WiFi 芯片
```

SDIO 每次传输都是一次 SDIO 命令（CMD53），没有 ring buffer 的批量能力，吞吐量远低于 PCIe。SDIO 主要用于低端 IoT 芯片——这些芯片不需要 Gbps 级别的吞吐量。

### 2.4.6 MTK 侧：HIF/WFDMA → NIC cmd → 固件

MTK 没有 HTT 层，也没有 CE。数据帧从 `kalHardStartXmit` 进入后，经过 `kalTxDirectStartXmit` → `nicTxDirectStartXmitMain`，最后的发送路径是：

```
nicTxDirectStartXmitMain()                 // include/nic/nic_tx.h:2092 — 固件前最后一站
  → nicTxEnqueueMsdu()                     // include/nic/nic_tx.h:1930, mgmt/bss.c:833
                                           // 将 MSDU_INFO 入队到固件可访问的 TX ring
  → mboxSendMsg(prAdapter, MBOX_ID_0, ...) // mgmt/bss.c:2141 — Mailbox 通知固件
```

Mailbox（MBOX）是 host 与固件之间的硬件门铃——host 通过 `mboxSendMsg()` 写 MBOX 寄存器（MBOX_ID_0 是通用门铃通道），硬件触发固件中断，固件从共享内存中的 TX ring 取出 MSDU_INFO 和数据帧。

底层的 DMA 操作由 WFDMA（WiFi DMA）引擎完成，WFDMA 配置在驱动初始化阶段（通过 `kalDevKickData()` 在 kal_pdma.c 中提交 DMA 描述符），TX 路径不直接操作 DMA——由硬件的 WFDMA 引擎自动从 TX ring 搬运数据到固件内存。写寄存器通知固件之后，host CPU 返回（软中断结束）；固件何时真正取走数据、何时通过空口发出，host 不再干预——它只通过 TX completion 中断知道"哪些包已发送完成"。

**SDIO 接口的 MTK 芯片**（如 connac、soc2_1x1 等低端平台）同样使用 SDIO HIF 层替代 PCIe WFDMA，通过 Linux MMC `sdio_memcpy_toio()` 逐包传输，吞吐量受限于 SDIO 总线速率。

总结——双平台传输层对比：

| 维度           | QCOM                                                         | MTK                                             |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| **消息协议层** | HTT（数据，wifi3.0 通过 HTC endpoint）+ WMI（控制）分离      | NIC cmd（TC4 统一通道）                         |
| **DMA 引擎**   | CE（Copy Engine，PCIe）/ SDIO CMD53                          | WFDMA（WiFi DMA，PCIe）/ SDIO CMD53             |
| **固件通知**   | `war_ce_src_ring_write_idx_set()` → `hif_write32_mb()` PCIe MMIO doorbell | `mboxSendMsg()` MBOX 寄存器写入                 |
| **物理总线**   | PCIe 或 SDIO                                                 | PCIe（主流）/ SDIO（低端芯片）                  |
| **SDIO 支持**  | 有，`hif_send_single()` → `sdio_memcpy_toio()` (CMD53)       | 有，SDIO HIF 层 → `sdio_memcpy_toio()` (CMD53)  |
| **流控**       | HTC credit-based endpoint 流控（`htc_try_send()` gating）    | per-BSS per-AC 队列深度 + `netif_stop_subqueue` |
| **HTT 封装**   | wifi3.0: `dp_tx_send()` → HTC；CLD: `ol_tx_send()` → `htt_tx_desc_init()` → HIF 直通 | 无 HTT——MSDU_INFO 直接入队 TX ring              |

把上面分散在各小节里的函数连成一条线，QCOM 从 `ndo_start_xmit` 到固件的完整调用链如下：

```
ndo_start_xmit
  → hdd_hard_start_xmit                    [core/hdd/src/wlan_hdd_tx_rx.c]
    → __hdd_hard_start_xmit                [core/hdd/src/wlan_hdd_tx_rx.c]
      ① hdd_drop_tx_packet_on_ftm()       FTM 模式丢包
      ② osif_dp_mark_pkt_type()           解析以太网帧头，标记广播/关键帧
      ③ hdd_qdisc_ac_to_tl_ac 查表        Linux qdisc → QCOM TL AC 映射
      ④ hdd_wmm_acquire_access_required()  PSB 准入判断
         EAPOL/WAPI 快速路径              未认证状态绕过准入
         hdd_wmm_acquire_access()          SME 状态机准入（异步 TSPEC 协商）
      ⑤ WMM 降级 VO→VI→BE→BK            准入失败逐级 fallback
      → ucfg_dp_start_xmit                 [components/dp/dispatcher/...]
        → dp_start_xmit                    [components/dp/core/src/wlan_dp_txrx.c]
          ① cds_is_driver_transitioning()   SSR/初始化过渡期丢包
          ② dp_ctx->is_suspend              系统休眠丢包
          ③ ARP/EAPOL/DHCP/ICMP 分类        四类特殊包统计
          ④ dp_get_transmit_mac_addr()      目标 MAC 可达性检查（输出参数模式）
          ⑤ dp_get_tx_resource()            TX ring 资源预取（更新内部状态）
          ⑥ dp_nbuf_orphan()                skb→socket 解绑（核心优化，IPA 条件下跳过）
          ⑦ dp_intf_is_tx_allowed()         二次可发送性综合校验
          ⑧ dp_nbuf_nontso_linearize()      非线性 skb 线性化
          ⑨ dp_intf->tx_fn() 校验            芯片平台回调注册检查
          ⑩ dp_fix_broadcast_eapol()        广播 EAPOL 地址修复
            dp_intf->tx_fn() 调用            → HTT → CE → PCIe → 固件
```

---

# 3 MTK 的数据帧如何发出？——菜鸟直通车

MTK 的 TX 路径比 QCOM 简洁得多——没有 DP 层的中间抽象，没有复杂的 WMM 准入控制状态机。代码路径短、分支少。

## 3.1 驱动入口：`wlanHardStartXmit`

MTK 驱动向协议栈注册的 `ndo_start_xmit` 回调是 `wlanHardStartXmit`（`gl_init.c`）：

```c
// MTK: gl_init.c — wlanHardStartXmit, ndo_start_xmit 回调（精简，省略 Passpoint DAD 检查和 ucBssIndex 提取）
netdev_tx_t wlanHardStartXmit(struct sk_buff *skb, struct net_device *dev)
{
    struct GLUE_INFO *prGlueInfo = *((struct GLUE_INFO **)netdev_priv(dev));

#if CFG_CHIP_RESET_SUPPORT
    if (!wlanIsDriverReady(prGlueInfo, ...)) {
        dev_kfree_skb(skb);
        return NETDEV_TX_OK;           // skb 已消费，返回 OK 通知协议栈
    }
#endif

    return kalHardStartXmit(skb, dev, prGlueInfo);
}
```

主要功能：

- 取出 `GLUE_INFO` 全局上下文——MTK 的对象模型比 QCOM 更扁平
- **Reset 标志检查**：比 QCOM 的 SSR 保护更直接——一个 flag 决定收不收包
- 直接调 `kalHardStartXmit`——没有中间 adapter 层

## 3.2 入队与发送：`kalHardStartXmit` 的十八道工序

`kalHardStartXmit`（`os/linux/gl_kal.c`，源码第 3692-3916 行）是 MTK TX 路径的核心，约 230 行，实际包含 18 个步骤。下面逐道工序展开：

### 3.2.1 入口状态验证（第 1-3 道）：HALT/BSS + AIS + LPDVT/DVT

以下 3 道工序都是前置丢包检查——它们的共同特征是不看帧内容，只看驱动/设备的外部状态。

**第 1 道：HALT 标志检查 + BSS 有效性验证**

```c
if (test_bit(GLUE_FLAG_HALT_BIT, &prGlueInfo->ulFlag)) {
    dev_kfree_skb(prOrgSkb);
    return WLAN_STATUS_ADAPTER_NOT_READY;
}
```

`GLUE_FLAG_HALT_BIT` 是固件挂死后的全局停止标志——当固件检测到异常后通过 NIC cmd 通道设置此标志，host 侧所有后续的 TX 调用直接 free skb 并返回错误。与 QCOM 的 SSR 保护机制不同，MTK 使用单一 bit 而非引用计数——更简单，但粒度更粗（无法支持"等待正在执行的 TX 完成后重启"）。

BSS 有效性验证则检查 `ucBssIndex` 是否在合法范围内（`< MAX_BSSID_NUM`）、对应 BSS 的 `BSS_INFO` 结构体是否存在、BSS 是否处于正常运行状态。

**第 2 道：AIS 状态检查**

对于 AIS（Android Internet Sharing，Android 网络共享）模式建立的网络接口，MTK 驱动施加了严格的状态检查：只有 `CONNECTED` 状态才允许发送数据包。非 CONNECTED 状态（如正在连接、已断开）的包直接 `dev_kfree_skb` 丢弃。

```c
// MTK: os/linux/gl_kal.c — kalHardStartXmit 中的 AIS 状态检查（源码行 3736-3741）
if (prBssInfo->eNetworkType == NETWORK_TYPE_AIS &&
    prBssInfo->eConnectionState != MEDIA_STATE_CONNECTED) {
    DBGLOG(INIT, INFO, "ais status is not connected, skip this frame\n");
    dev_kfree_skb(prOrgSkb);
    return WLAN_STATUS_NOT_ACCEPTED;
}
```

AIS 模式下，网络接口可能在完整的 WiFi 认证/关联流程完成之前就已经暴露给 Android 框架——此检查防止"尚未准备好"的接口被上层协议栈调用。

**第 3 道：LPDVT 与 DVT TX 测试模式检查**

两个性能验证测试模式下的发包检查：

**LPDVT（Low Power Design Validation Test，低功耗设计验证测试）**：实验室环境下验证 WiFi 在低功耗模式下的发包行为。LPDVT 模式下直接丢弃所有数据包——这不是 bug，而是测试需求：验证在极端低功耗场景下，驱动是否正确处理了"不应发包"的条件。

**DVT TX 测试**（`CFG_SUPPORT_WIFI_SYSDVT`）：系统级设计验证测试（Design Validation Test），用于产线批量验证。TX 测试模式下，驱动维护一个发包计数限制，超过限制数量后主动丢包——这是为了在自动化测试中精确控制发包数量，以测量 RF 性能指标。

### 3.2.2 skb 准备（第 4-5 道）：headroom 重分配与克隆拷贝

以下 2 道工序是 MTK 独有的 skb 准备开销——都是因为 TX 描述符必须内嵌在 skb headroom 中。

这是 MTK TX 路径与 QCOM 最根本的差异所在——**MTK 的每个数据包都需要一次 skb headroom 重分配，这意味着一次完整的数据拷贝**。

```c
u4TxHeadRoomSize = NIC_TX_DESC_AND_PADDING_LENGTH + txd_append_size;
if (skb_headroom(prOrgSkb) < u4TxHeadRoomSize) {
    prSkbNew = skb_realloc_headroom(prOrgSkb, u4TxHeadRoomSize);
    if (!prSkbNew) {
        dev_kfree_skb(prOrgSkb);
        return WLAN_STATUS_FAILURE;
    }
    prSkb = prSkbNew;
}
```

**为什么 MTK 需要这个拷贝？**

MTK 的芯片架构将 TX 描述符放在 skb 的 headroom 中。通过 `GLUE_GET_PKT_QUEUE_ENTRY` 宏，MTK 驱动从 skb headroom 的固定偏移处直接读写 TX 描述符（`struct QUE_ENTRY`）。这意味着 TX 描述符不是放在独立的 DMA 内存区域，而是**紧挨着 skb 数据头部**存放。

但协议栈下来的 skb headroom 通常只有 64 字节左右（`NET_SKB_PAD` + MAC 层预留空间 `LL_MAX_HEADER`），远不够 WiFi TX 描述符的存储需求（`NIC_TX_DESC_AND_PADDING_LENGTH` + `txd_append_size` 通常需要 100-200 字节）。

`skb_realloc_headroom()` 的内部流程：

1. **计算 delta** = 需要的 headroom - 当前的 headroom
2. **当 delta <= 0**（理论上已有足够 headroom）→ `pskb_copy(skb, GFP_ATOMIC)`：复制 skb 头 + 数据（共享页面碎片）
3. **当 delta > 0**（实际场景中总是触发，因为协议栈 headroom 不足）→ `skb_clone()` + `pskb_expand_head()`：先克隆 skb 结构体头（共享数据 buffer），再重新分配更大的 headroom，然后 `skb_copy_header()` + `memcpy` 拷贝数据

**无论哪种情况，都涉及至少一次 `memcpy`（拷贝 1500+ 字节的数据载荷）**。在高吞吐量场景下（如 802.11ax 5Gbps），每秒数百万个包，每个包 1500 字节的 memcpy 开销累积起来非常可观。QCOM 为何不需要这个拷贝？详见 §3.3 的架构对比。

headroom 重分配解决了描述符空间不足的问题——但多 BSS 场景下还有一个更隐蔽的坑：当多个虚拟 AP 共享同一个 skb 时，TX 描述符互相覆盖。

**第 5 道：`CFG_SUPPORT_SKB_CLONED_COPY` 下的第二次拷贝**

当同一个 skb 被 `skb_clone()` 克隆后发往不同的 BSSID 时，两个克隆的 skb 共享同一个 data buffer。MTK 的 TXD 指针（存储在 headroom 中的 `QUE_ENTRY`）指向 headroom 的固定偏移。由于 data buffer 是共享的，第二个 BSSID 写入的 TXD 会**覆盖**第一个 BSSID 写入的 TXD——导致发送到错误的目的地。

```c
#if CFG_SUPPORT_SKB_CLONED_COPY
if (unlikely(skb_cloned(prSkb))) {
    prSkbNew = skb_copy_expand(prSkb, u4TxHeadRoomSize, 0, GFP_ATOMIC);
    // ...
}
#endif
```

`skb_copy_expand()` 创建一个全新的 skb（独立 data buffer + 额外 headroom），彻底解决共享问题。这是**第二次拷贝**——第一次在 `skb_realloc_headroom` 中，第二次在这里。在高吞吐量多 BSS 场景下（如 AP 模式），这是不容忽视的 CPU 开销。

### 3.2.3 第 6 道：`wlanProcessTxFrame()` -- 帧信息解析

`wlanProcessTxFrame()`（`common/wlan_lib.c` 4038-4124 行）是 MTK 对每个数据包进行"开箱查验"的核心函数：

1. **调用 `kalQoSFrameClassifierAndPacketInfo()`**（`os/linux/gl_kal.c` 4382 行）：解析以太网帧头，提取以下信息：

   - 以太网类型（EtherType）：IPv4（0x0800）、IPv6（0x86DD）、ARP（0x0806）、VLAN（0x8100）
   - IP 协议类型：TCP/UDP/ICMP/ICMPv6
   - 传输层端口号：用于 QoS 分类

2. **提取优先级参数设置 TID**：从 `skb->priority` 和 DSCP（Differentiated Services Code Point，差异化服务代码点）字段映射到 WiFi TID（Traffic Identifier，0-7），决定该帧进入哪个 AC 队列

3. **识别帧类型标志位**：设置以下标志位用于后续处理：

   | 标志               | 含义                                 | 用途                     |
   | ------------------ | ------------------------------------ | ------------------------ |
   | `1X`               | EAPOL（802.1X 认证帧）               | 认证帧需要特殊优先级处理 |
   | `NON_PROTECTED_1X` | 未保护的 EAPOL（如首次连接）         | 允许在不安全链路上发送   |
   | `802_3`            | 标准以太网封装（非 LLC/SNAP）        | 决定 802.11 头格式       |
   | `VLAN`             | 802.1Q VLAN 标签帧                   | 多 SSID 场景的 VLAN 隔离 |
   | `DHCP`             | DHCP 请求/响应                       | 连接统计追踪             |
   | `ARP`              | ARP 请求/响应                        | 连接统计追踪             |
   | `ICMP` / `ICMPv6`  | ICMP/ICMPv6                          | 诊断帧标记               |
   | `TDLS`             | TDLS（Tunneled Direct Link Setup）帧 | 直连场景特殊处理         |
   | `DNS`              | DNS 查询/响应                        | 网络活动监控             |
   | `IP_FRAG`          | IP 分片帧                            | 分片重组相关             |

4. **提取 Header Length、Frame Length、Arrival Time**：Header Length（以太网帧头长度，14 字节）存进包私有数据（`ucHeaderLen`）供调试日志与包信息记录；Frame Length（数据包总长度）用于 TX 描述符的长度字段；Arrival Time 用于 TX 统计和延迟测量。

### 3.2.4 第 7-9 道：TX Profiling、吞吐量增强与 AC 分类

这三道工序体量都不大，合在一起讲。

**第 7 道：`wlanTxProfilingTagPacket()`** — TX 性能剖析标签。该函数在 skb 的 CB 中标记"OS→Driver"的时间戳——在 `gl_kal.c:3829` 被无条件调用，无明显 `#ifdef` 守卫。这个时间戳用于测量数据包从协议栈进入驱动到实际由硬件发出的端到端延迟，是性能调优的关键数据源。

**第 8 道：`skb_get_queue_mapping()`** — AC 分类。

```c
u2QueueIdx = skb_get_queue_mapping(prSkb);
```

MTK 的 AC 分类比 QCOM 简洁得多——直接使用 Linux 内核标准函数 `skb_get_queue_mapping()` 读取 `skb->queue_mapping` 字段，不经过任何映射表。这意味着 MTK 信任协议栈的 qdisc 分类结果，不在此层做额外的 AC 映射。

**第 9 道：`kalTpeProcess()`** — 吞吐量增强（Throughput Enhancement）。在 `CFG_SUPPORT_TPENHANCE_MODE` 宏开启时生效，对特定类型的小包做特殊优化：TCP ACK 小包（通常 54 字节）合并为一个较大的聚合帧发送，减少每帧的 MAC/PHY 头部开销；短数据帧（如 VoIP G.711 编码帧，约 80 字节 payload）批量提交给硬件，减少 Host→固件的通信开销。`kalTpeProcess()` 通过启发式规则（包大小、协议类型、发送频率）判断是否需要将当前包缓存在 TP 增强队列中。

### 3.2.5 Direct 模式发送（第 10-11 道）：CPU 亲和性调度与批量循环

以下 2 道工序构成 MTK 的 Direct 发送路径——CPU 亲和性绑大核避免跨核开销，批量取队列减少锁竞争。

Direct 模式下，`kalTxWorkSchedule()`（源码第 16393-16421 行）决定数据包应该在哪个 CPU 上处理：

```c
// MTK: os/linux/gl_kal.c — kalTxWorkSchedule, CPU 亲和性调度（源码行 16393-16421）
uint32_t kalTxWorkSchedule(struct sk_buff *prSkb, struct GLUE_INFO *pr)
{
    int32_t i4TxWorkCpu, i4Cpu;

    i4TxWorkCpu = kalWorkGetCpu(pr, TX_WORK);
    if (i4TxWorkCpu == -1) {
        /* 无 BoostCpu 绑定 → 直接走 Direct 路径 */
        return kalTxDirectStartXmit(prSkb, pr);
    }

    i4Cpu = get_cpu();                  // 获取当前 CPU 号 + 禁用抢占
    put_cpu();

    if ((0x1 << i4Cpu) & kalGetTxBigCpuMask()) {
        /* 当前 CPU 是 BigCpu → 直接在本地处理 */
        return kalTxDirectStartXmit(prSkb, pr);
    }

    /* 当前 CPU 不是 BigCpu → 入队到 rTxDirectSkbQueue + 唤醒 TX worker */
    if (prSkb)
        skb_queue_tail(&pr->rTxDirectSkbQueue, prSkb);

    if (kalWorkSchedule(pr, TX_WORK) == WLAN_STATUS_NOT_ACCEPTED)
        return kalTxDirectStartXmit(NULL, pr);    // TX worker 满 → 兜底自处理

    return WLAN_STATUS_SUCCESS;
}
```

MTK 驱动为 TX worker 绑定了特定的 Big CPU（大核），以利用大核的更高主频和更大缓存。调度逻辑两步判断：(1) `kalWorkGetCpu(pr, TX_WORK)` 返回绑定的目标 CPU，-1 表示未绑定（直接走 Direct 路径）；(2) 用位掩码 `(0x1 << i4Cpu) & kalGetTxBigCpuMask()` 判断当前 CPU 是否是 BigCpu。如果在 BigCpu 上 → 直接 `kalTxDirectStartXmit`；否则入队 `rTxDirectSkbQueue` + `kalWorkSchedule` 唤醒 TX worker。TX worker 处理不了时（`WLAN_STATUS_NOT_ACCEPTED`），调用 `kalTxDirectStartXmit(NULL, pr)` 兜底自处理——即使不在 BigCpu 上，也不能丢包。


**第 11 道：`kalTxDirectStartXmit()` -- Direct 模式的核心循环**

`kalTxDirectStartXmit()`（源码第 14375-14446 行）是在目标 CPU 上执行的批量发送循环：

```c
uint32_t kalTxDirectStartXmit(struct sk_buff *prSkb, struct GLUE_INFO *prGlueInfo)
{
    struct MSDU_INFO *prMsduInfo;
    struct sk_buff_head rLocalSkbQ, *prTxDirectSkbQ;
    
    __skb_queue_head_init(&rLocalSkbQ);
    prTxDirectSkbQ = &prGlueInfo->rTxDirectSkbQueue;
    
    // 1. 获取自旋锁 TX_DIRECT_TRY_LOCK
    if (!TX_DIRECT_TRY_LOCK(prGlueInfo)) {
        // 锁竞争 → 入队 + 启动定时器
        skb_queue_tail(prTxDirectSkbQ, prSkb);
        kalTxDirectStartCheckSkbQTimer(prGlueInfo, TX_DIRECT_CHECK_INTERVAL);
        return WLAN_STATUS_SUCCESS;
    }
```

`TX_DIRECT_TRY_LOCK` 是一个 trylock——拿不到锁不强等，入队后启动定时器等下一轮。设计原则是**不在软中断里自旋等待**——软中断不能睡眠、不能长时间占 CPU，拿不到锁就退回，让 TX worker 线程去竞争锁。

```c
    // 2. 批量取队列：splice rTxDirectSkbQueue + 当前 skb → rLocalSkbQ
    spin_lock_irqsave(&prTxDirectSkbQ->lock, flags);
    skb_queue_splice_init(prTxDirectSkbQ, &rLocalSkbQ);
    if (prSkb) __skb_queue_tail(&rLocalSkbQ, prSkb);
    spin_unlock_irqrestore(&prTxDirectSkbQ->lock, flags);
    
    // 3. 批量处理：每个 skb 分配 MSDU_INFO + 调 nicTxDirectStartXmitMain
    while (skb_queue_len(&rLocalSkbQ)) {
        prMsduInfo = cnmPktAlloc(prAdapter, 0);      // 分配 MSDU_INFO 结构体
        if (!prMsduInfo) break;                       // 内存不足，停下
        
        prSkb = __skb_dequeue(&rLocalSkbQ);
        nicTxDirectStartXmitMain(prSkb, prMsduInfo,   // 进入固件前的最后一站
                                 prAdapter, 0xff, 0xff, 0xff);
    }
```

把全局队列一次性 splice 到本地队列后释放锁——锁的持有时间只覆盖 splice 操作，while 循环中的 `cnmPktAlloc` 和 `nicTxDirectStartXmitMain` 完全不持锁。也就是说，上一轮批量处理还在跑的时候，新到的 skb 可以直接入队到全局队列（下一轮 splice 带走），不必等本轮处理完。

但这里还有一个关键问题：为什么批量取出后，处理不完的还要 splice 回去？

```c
    // 4. 处理不完的 skb splice 回 rTxDirectSkbQueue + 启动定时器
    if (skb_queue_len(&rLocalSkbQ)) {
        spin_lock_irqsave(&prTxDirectSkbQ->lock, flags);
        skb_queue_splice_tail_init(&rLocalSkbQ, prTxDirectSkbQ);
        spin_unlock_irqrestore(&prTxDirectSkbQ->lock, flags);
        kalTxDirectStartCheckSkbQTimer(prGlueInfo, TX_DIRECT_CHECK_INTERVAL);
    }
    return WLAN_STATUS_SUCCESS;
}
```

答案在于 `cnmPktAlloc` 可能返回 NULL。CNM 内存池是有限的——如果当前系统的 MSDU_INFO 结构体已经全部被正在处理或等待固件确认的 skb 占用，`cnmPktAlloc` 返回 NULL，while 循环 break。此时本地队列中剩余的 skb **不能丢弃**——它们没被处理过，必须还给全局队列，由下一轮的 `kalTxDirectStartXmit`（或 TX worker）继续尝试。定时器的存在保底：即使后续没有新 skb 触发 `kalTxWorkSchedule`，定时器到期也会唤醒处理。

关键设计细节补充：

- **批量处理**：`skb_queue_splice_init` 一次性取出全局队列中的所有 skb（原子操作），减少锁竞争
- **cnmPktAlloc**：为每个 skb 从 CNM（Connection Management）内存池分配一个 `MSDU_INFO` 结构体——这是固件接口所需的数据结构，包含 TX 向量、BSS 索引、STA 索引等元数据
- **nicTxDirectStartXmitMain**：这是进入固件前的最后一站——将 MSDU_INFO 提交给 NIC 层，NIC 层负责后续的 DMA 操作、HIF 发送、固件通知

### 3.2.6 第 12-18 道：非 Direct 模式、流控与触发发送

以下 7 道工序中，第 12-14 道和第 17-18 道是 Direct/非 Direct 的互斥分支——**同一个包在同一次调用中只走其中一条，不会顺序执行两边**。`HAL_IS_TX_DIRECT` 决定走哪条路：

```c
// MTK: os/linux/gl_kal.c — kalHardStartXmit 第 12-18 道（源码行 3853-3915，精简）

// ═══ 非 Direct 模式路径（HAL_IS_TX_DIRECT == false）═══
// 第 12-14 道：自旋锁保护下的入队
if (!HAL_IS_TX_DIRECT(prAdapter)) {
    GLUE_ACQUIRE_SPIN_LOCK(prGlueInfo, SPIN_LOCK_TX_QUE);
    QUEUE_INSERT_TAIL(prTxQueue, prQueueEntry);     // skb→QUE_ENTRY→prTxQueue
    GLUE_RELEASE_SPIN_LOCK(prGlueInfo, SPIN_LOCK_TX_QUE);
}

// 第 15 道：per-BSS per-AC 待发送帧计数（两条路径共用）
GLUE_INC_REF_CNT(prGlueInfo->i4TxPendingFrameNum);
GLUE_INC_REF_CNT(prGlueInfo->ai4TxPendingFrameNumPerQueue[ucBssIndex][u2QueueIdx]);

// 第 16 道：流控——超过阈值则停止该 AC 子队列
if (GLUE_GET_REF_CNT(prGlueInfo->ai4TxPendingFrameNumPerQueue[ucBssIndex][u2QueueIdx])
    >= prGlueInfo->u4TxStopTh[ucBssIndex])
    netif_stop_subqueue(prDev, u2QueueIdx);

// ═══ 第 17-18 道：触发发送（两条路径互斥）═══
if (HAL_IS_TX_DIRECT(prAdapter))
    return kalTxWorkSchedule(prSkb, prGlueInfo);  // Direct 模式：直接调度发送
kalSetEvent(prGlueInfo);                           // 非 Direct 模式：唤醒 TX worker
return WLAN_STATUS_SUCCESS;
```

各道说明：

- **第 12-14 道（仅非 Direct）**：`if (!HAL_IS_TX_DIRECT)` 守卫——只有非 Direct 模式才走自旋锁→入队→释放自旋锁这个流程。Direct 模式下 skb 不经过 `prTxQueue`，直接由 `kalTxWorkSchedule` 送入 `kalTxDirectStartXmit` 处理
- **第 15-16 道（共用）**：无论哪种模式，计数器都必须更新——per-BSS per-AC 的待发送帧数是流控决策的唯一依据。超过阈值时 `netif_stop_subqueue` 停止该子队列，TX worker 消费后通过 `netif_wake_subqueue` 恢复
- **第 17-18 道（互斥分支）**：`HAL_IS_TX_DIRECT` 为真 → `kalTxWorkSchedule`（第 10 道的 CPU 亲和性调度）；为假 → `kalSetEvent` 唤醒异步 TX worker。**入队和 Direct 发送是互斥的，不会在同一次调用中同时执行**

把 MTK 的十八道工序连成一条线，从入口到固件的完整调用链如下：

```
ndo_start_xmit
  → wlanHardStartXmit                    [MTK: gl_init.c]
    → kalHardStartXmit                   [MTK: os/linux/gl_kal.c]
      ① HALT + BSS 有效性验证            固件挂死/非法的 BSS 索引丢包
      ② AIS 网络类型检查                 非 CONNECTED 状态丢包
      ③ LPDVT/DVT 测试模式              测试模式下丢包或限流
      ④ skb_realloc_headroom()          ⚠️ MTK 关键拷贝（headroom 重分配）
      ⑤ skb_copy_expand()               ⚠️ 第二次拷贝（cloned skb 独立化）
      ⑥ wlanProcessTxFrame()            帧信息解析 + 类型标志位设置
	      ⑦-⑨                         TX Profiling + AC 分类 + 吞吐量增强
      ⑩ kalTxWorkSchedule()             CPU 亲和性调度（Direct 模式）
         kalTxDirectStartXmit()          Direct 模式核心批量循环
           cnmPktAlloc()                 分配 MSDU_INFO
           nicTxDirectStartXmitMain()    固件前最后一站
      ⑪ QUEUE_INSERT_TAIL               入队到 per-BSS per-AC 队列
      ⑫ netif_stop_subqueue()           流控：停止该 AC 子队列
      ⑬ kalSetEvent()                   唤醒 TX worker（非 Direct 模式）
```

## 3.3 MTK TX 比 QCOM 多一次拷贝：架构差异的根源

在上面的 18 道工序中，第 4 道（`skb_realloc_headroom`）和第 5 道（`skb_copy_expand`）是 MTK 独有的开销——QCOM 的 TX 路径没有这两步。这一节专门解释这个差异的根源和影响。

下图对比了两种架构的 skb 处理流程——MTK 每次需要 1~2 次 memcpy，QCOM 完全零拷贝：

![MTK skb 拷贝机制](assets/07c-%E6%95%B0%E6%8D%AE%E5%B8%A7%E7%9A%84%E5%8F%91%E9%80%81-%E2%80%94-%E5%8F%8C%E5%B9%B3%E5%8F%B0-TX-%E8%B7%AF%E5%BE%84%E5%AF%B9%E6%AF%94/07c-mtk-skb-copy.svg)

![QCOM 零拷贝 TX 路径](assets/07c-%E6%95%B0%E6%8D%AE%E5%B8%A7%E7%9A%84%E5%8F%91%E9%80%81-%E2%80%94-%E5%8F%8C%E5%B9%B3%E5%8F%B0-TX-%E8%B7%AF%E5%BE%84%E5%AF%B9%E6%AF%94/07c-qcom-zero-copy.svg)

### 3.3.1 MTK 为什么要做拷贝

根因在于 **TX 描述符的存放位置**：

| 维度                 | MTK                                                          | QCOM                                            |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| **TX 描述符存放**    | skb headroom 中（通过 `GLUE_GET_PKT_QUEUE_ENTRY` 宏访问）    | 独立的 DP 描述符池（`dp_tx_desc_alloc()` 分配） |
| **传递给固件的方式** | 描述符指针指向 skb headroom 内的固定偏移                     | HTT 消息的独立内存区域（不占用 skb 空间）       |
| **skb 数据的 DMA**   | skb data 直接 DMA 映射给硬件（不需要数据拷贝）               | skb data 直接 DMA 映射给硬件（不需要数据拷贝）  |
| **headroom 重分配**  | **必须做**：协议栈 skb headroom（~64 字节）< TX 描述符所需（100-200 字节） | **不需要**：TX 描述符不放在 skb 中              |
| **cloned skb 拷贝**  | **必须做**：`CFG_SUPPORT_SKB_CLONED_COPY` 下防止共享 data buffer 上的 TXD 被覆盖 | **不需要**：每个 HTT 消息有独立的描述符空间     |

**第一次拷贝：`skb_realloc_headroom()`**

协议栈下来的 skb headroom 只有约 64 字节（`NET_SKB_PAD` + `LL_MAX_HEADER`），而 MTK 需要在 headroom 中存放：

- `NIC_TX_DESC_AND_PADDING_LENGTH`：硬件 TX 描述符本体（包括发送速率、BSS 索引、TID、加密密钥索引等）
- `txd_append_size`：尾部填充（如 802.11 头的额外空间、安全头的 IV/Extended IV）
- `QUE_ENTRY` 结构体：链表指针和队列状态

总所需的 headroom 通常为 100-200 字节。`skb_realloc_headroom()` 内部总是触发 `pskb_expand_head()` 路径——分配新的 skb head buffer，`memcpy` 旧数据到新位置。**每个 1500 字节的包，第一次 memcpy 就复制了 1500+ 字节**。

**第二次拷贝：`skb_copy_expand()`（条件触发）**

当同一个 skb 被 clone 后发往不同 BSSID 时（多 BSS 共享场景，如 AP 模式下的多 SSID），clone 后的 skb 共享同一个 data buffer。MTK 的 TXD 指针指向 headroom 中的固定偏移——两个 BSS 的 TXD 共享同一块内存，第二个 BSS 写入 TXD 时会覆盖第一个 BSS 的 TXD。`skb_copy_expand()` 创建一个完全独立的 data buffer 副本，彻底解决共享问题。

**第二次 memcpy**：又是一次 1500+ 字节的拷贝。

### 3.3.2 QCOM 为什么不需要拷贝

QCOM 的架构从根源上避免了这个问题：

1. **TX 描述符独立分配**：`dp_tx_desc_alloc()` 从 DP 层的描述符池分配独立内存，不占用 skb 空间
2. **HTT 消息传递**：描述符通过 HTT（Host Target Transport）消息格式封装，放在独立的 DMA 缓冲区中，随 skb DMA 映射一起提交给固件
3. **`dp_nbuf_orphan()` 只解绑不拷贝**：QCOM 的 orphan 优化只是将 skb 与 socket 解绑（修改引用计数），完全不涉及数据拷贝

### 3.3.3 对吞吐量的影响

在高吞吐量场景下，每次拷贝的 CPU 开销累积起来不可忽视：

| 场景             | 包大小    | 包速率（~1 Gbps） | 每次拷贝开销      | 总 CPU 开销            |
| ---------------- | --------- | ----------------- | ----------------- | ---------------------- |
| 单 BSS           | 1500 字节 | ~83,000 pps       | 1 次 memcpy(1500) | ~125 MB/s 带宽用于拷贝 |
| 多 BSS（cloned） | 1500 字节 | ~83,000 pps       | 2 次 memcpy(1500) | ~250 MB/s 带宽用于拷贝 |
| 小包（VoIP）     | 80 字节   | ~1,500,000 pps    | 1 次 memcpy(80)   | ~120 MB/s 带宽用于拷贝 |

(*) 基于有效载荷吞吐量（goodput）的理想计算，未计 MAC/PHY 头部、IFS、ACK 等空口开销。1 Gbps PHY 速率下有效载荷吞吐量约 700-800 Mbps，memcpy 开销占比相应增大。

小包场景（VoIP、在线游戏）的拷贝开销尤其严重——因为包数量巨大，`skb_realloc_headroom` 的额外开销（分配新 buffer、释放旧 buffer）本身也是可观的 CPU 时间。

### 3.3.4 这是工程权衡，不是设计缺陷

MTK 选择将 TX 描述符放在 skb headroom 中，是一种**用 CPU 换硬件成本**的工程决策：

- **优点**：不需要独立的描述符内存池，不需要复杂的 HTT 协议层，硬件设计更简单，芯片面积更小
- **缺点**：每个包多一次（或两次）memcpy，CPU 利用率更高，吞吐量天花板更低

QCOM 选择独立的描述符池，是一种**用芯片复杂度换软件效率**的决策：

- **优点**：零拷贝 TX 路径，CPU 专注于 DMA 映射和协议处理，吞吐量上限更高
- **缺点**：需要独立的描述符内存管理、HTT 协议层、更复杂的固件接口——芯片硅面积更大，驱动代码更多

两种方案的选择最终取决于芯片的市场定位：MTK 芯片面向中低端市场，成本敏感，CPU 资源相对充裕（手机 SoC 通常有 8 核）；QCOM 芯片面向高端市场，吞吐量是关键卖点，额外的芯片面积成本可以接受。

QCOM 的每个包裹自带一个独立的"运单标签"（HTT 描述符），贴在包裹外面，不需要打开包裹重新包装。MTK 的运单标签要写在包裹的包装纸上（skb headroom）——但协议栈下来的包裹包装纸太小，写不下，快递员（驱动）必须先把包裹拆开、换一张大包装纸、再把包裹内容复制过去。这就是每一站都多花的那一步。

---

# 4 AMPDU 聚合与 Block ACK

数据面吞吐量的关键是聚合——把多个 MSDU/MPDU 打包成一个 PPDU 发送，减少每帧的 PHY 头部开销和信道竞争开销（IEEE 802.11-2024 §9.7 定义 A-MPDU 格式，§10.12 定义 A-MPDU 操作与重排序规则）。

两个平台对 AMPDU 的处理方式截然不同：QCOM 将重排交给硬件 REO（Reorder Engine，重排序引擎），MTK 用软件滑动窗口。但有一点是共通的——**host 侧负责 BA 会话的建立和拆除，固件/硬件负责聚合帧的实际收发**。接收端的重排细节（QCOM REO 硬件、MTK 软件滑动窗口）将在数据帧接收文章中展开。

## 4.1 AMPDU/AMSDU 聚合实现：双平台对比

聚合分两种层次——AMPDU（Aggregate MAC Protocol Data Unit，MAC 层聚合）和 AMSDU（Aggregate MAC Service Data Unit，LLC 层聚合）。两者的核心区别在于聚合发生的位置不同：AMSDU 在 LLC 层将多个 IP 包合并为一个 MAC 帧体（共享同一个 MAC 头），AMPDU 在 MAC 层将多个完整的 MPDU 封装为一个 PPDU（每个 MPDU 有独立的 MAC 头）。打个比方，AMSDU 是分箱——把几件小包裹（IP 包）塞进同一个纸箱，箱外只贴一张运单（MAC 头）；AMPDU 是装箱上车——把一个个已经各自贴好运单的纸箱（MPDU）码上同一辆货柜车（PPDU）。前者省的是纸箱和运单，后者省的是发车次数。

**QCOM 的 AMPDU 聚合——硬件 TCL 引擎**

QCOM 的 AMPDU 聚合完全由硬件 TCL（Target Copy List）引擎完成，host 侧代码不参与聚合逻辑。`dp_start_xmit` 将 skb 交给 `tx_fn` 后，HTT 层将每个 skb 的 DMA 地址和 TX 描述符提交给 CE → 固件共享内存。固件中的 TCL 引擎根据 per-TID 的 BA 会话状态、聚合窗口（reorder buffer size）和空口速率，动态决定将多少个 MPDU 打包为一个 PPDU——host 侧完全不知道"这个 skb 最终和哪几个 skb 一起发了一个 AMPDU"。

**MTK 的 AMPDU 聚合——硬件 WFDMA + 固件**

MTK 的 AMPDU 聚合同样不在 host 侧执行，host 只负责将帧入队到固件可见的 TX ring：

```
nicTxDirectStartXmitMain()                 // include/nic/nic_tx.h:2092 — 固件前最后一站
  → nicTxEnqueueMsdu()                     // include/nic/nic_tx.h:1930, mgmt/bss.c:833
                                           // 将 MSDU_INFO 入队到共享内存中的 TX ring
  → mboxSendMsg(prAdapter, MBOX_ID_0, ...) // mgmt/bss.c:2141 — 门铃通知固件
```

固件收到 MBOX 中断后，从 TX ring 取出 MSDU_INFO 和数据帧。TX 描述符级别有两个关键控制位决定该帧是否参与聚合：

| 描述符位                               | 位置                                | 含义                                                 |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `CONNAC2X_TX_DESC_BA_DISABLE` (BIT 28) | `include/nic/nic_connac2x_tx.h:129` | 0=允许固件聚合，1=单 MPDU 发送（如管理帧、EAPOL 帧） |
| `CONNAC2X_TX_DESC_ADD_BA` (BIT 14)     | `include/nic/nic_connac2x_tx.h:144` | 触发固件为该 TID 发起 ADDBA Request                  |

聚合窗口大小由 `apsGetEstimatedTput()`（`mgmt/aps.c:654`）在 host 侧计算：`ideal = baSize * amsduByte * 8 / ppduDuration`——综合考虑 BA 窗口大小、AMSDU 长度、PHY 速率和 PPDU 时长后得出的理想吞吐量模型。但实际的聚合决策（多少帧合并、何时发送）完全由固件 TX 调度器决定——host 侧不知道"这个 skb 最终和哪几个 skb 一起发了一个 AMPDU"。

**AMSDU——MTK 双路径，QCOM 固件侧**

- **QCOM**：AMSDU 聚合在固件侧（TQM 引擎），Host 仅在 ADDBA 协商时声明 AMSDU 支持标志。`amsdu_support` 标志在 `lim_send_addba_response_frame()`（`lim_send_management_frames.c:6053`）中作为参数传入，由 PE/LIM 层调用 `lim_is_sta_he_capable()` / `lim_is_sta_eht_capable()` 查询 STA 能力后，结合驱动配置（INI cfg）决定是否启用，最终通过 `frm.addba_param_set.amsdu_supp = amsdu_support`（`lim_send_management_frames.c:6168`）写入 ADDBA Response 帧体
- **MTK**：AMSDU 有硬件和软件两条路径，由芯片能力（`is_support_hw_amsdu` 标志）决定：
  - **硬件路径**（绝大多数芯片：mt7925、mt7915、mt7961、mt7990、soc3_0、soc7_0、mt6655 等，`is_support_hw_amsdu = TRUE`）：Host 仅通过函数指针 `nic_txd_set_hw_amsdu_template` → `nic_txd_v1/v2/v3_set_hw_amsdu_template()`（如 `nic_txd_v3.h:77`）设置 TX 描述符模板中的 WTBL（Wireless Table）AMSDU 配置字段（`hw_amsdu_cfg`、`key_loc` 等），实际的 MSDU 聚合由固件/WiFi MAC 硬件中的 PLE（Packet Loading Engine）AMSDU Merge Engine 完成
  - **软件路径**（低端芯片：connac、soc2_1x1 等，`is_support_hw_amsdu = FALSE`，`ucMaxSwAmsduNum = 4`）：Host 在 `kalDevKickData()`（`kal_pdma.c`）中执行软件聚合——排序、对齐、计算可聚合帧数、设置 `TXD_DW1_AMSDU_C`（BIT(20)，`hif_pdma.h:231`）标志位
  - AMSDU 长度由 `apsGetAmsduByte()`（`mgmt/aps.c:544`）动态计算，返回值常量定义在 `mgmt/aps.c`：HE/VHT 下 8K（`APS_AMSDU_VHT_HE_8K`）或 11K（`APS_AMSDU_VHT_HE_11K`），HT-only 下 8K（`APS_AMSDU_HT_8K`），不支持高速率时退化为 3K（`APS_AMSDU_VHT_HE_3K` 或 `APS_AMSDU_HT_3K`）

**AMSDU 与 AMPDU 的关系**：MTK 的 AMSDU 始终是 AMSDU-in-AMPDU（不存在独立的 AMSDU 模式），配置变量命名为 `ucAmsduInAmpduTx`/`ucAmsduInAmpduRx`，全局上限 `WLAN_TX_MAX_AMSDU_IN_AMPDU_LEN = 11454`。

## 4.2 Block ACK：唯一由 Host 构造的控制帧

在整个数据面中，有一个特殊的存在：**Block ACK 协议的协商帧 ADDBA/DELBA**。它们是管理帧中的 Action 帧（IEEE 802.11-2024 定义的 Category 3 - Block ACK），但它们是**唯一一组由 host 侧软件直接构造的管理帧**——其余所有的 Action 帧和管理帧主体都由固件/硬件处理，只有 ADDBA Request/Response 和 DELBA 的帧体由 host 侧 PE/LIM 层构建。Block ACK 协议定义在 IEEE 802.11-2024 §10.25.2（ADDBA 协商流程）、§10.25.6（Block ACK 帧生成与传输）、§10.25.3（数据与确认传输）。

当对端发来 ADDBA Request 时，QCOM 的处理路径是：

```
// PE/LIM: lim_process_action_frame.c — lim_process_addba_req, ADDBA Request 入口
lim_process_addba_req(mac_ctx, rx_pkt_info, session)      // PE/LIM 层：解析 ADDBA Request 帧
  dot11f_unpack_addba_req(mac_ctx, body, len, addba_req)  //   解包 TID、Buffer Size、Timeout
  lim_is_sta_he_capable(sta_ds)                            //   查询 STA HE 能力
  lim_is_sta_eht_capable(sta_ds)                           //   查询 STA EHT 能力
  cdp_addba_requestprocess(soc, peer, vdev,                //   DP 层：分配 REO queue 资源
                           dialogtoken, tid, timeout,      //   初始化 reorder buffer
                           buff_size, startseqnum)         //   设置 BA 状态为 IN_PROGRESS
  lim_send_addba_response_frame(mac_ctx, peer, tid,        //   构造 ADDBA Response 帧体
                                session, wep, buff_size);  //   携带协商后的参数（host 直接构造）
```

Buffer Size 协商遵循三重约束：

| 约束层 | 源                        | 效果                                                         |
| ------ | ------------------------- | ------------------------------------------------------------ |
| 第一重 | STA 能力（EHT/HE/Legacy） | 选择默认上限：EHT→`MAX_EHT_BA_BUFF_SIZE`，HE→`MAX_BA_BUFF_SIZE`，传统→`SIR_MAC_BA_DEFAULT_BUFF_SIZE`（如 64） |
| 第二重 | 用户显式配置              | `mac_ctx->usr_cfg_ba_buff_size` 非零时覆盖第一重             |
| 第三重 | 对端请求值                | `QDF_MIN(buff_size, addba_req->addba_param_set.buff_size)`——取较小值，符合 802.11 规范 |

关键点：

- `lim_process_addba_req()`（`lim_process_action_frame.c`）是 PE/LIM 层的入口——从管理帧分发路径进入，接收原始帧 buffer 而非已解析结构体
- `cdp_addba_requestprocess()` → `dp_addba_requestprocess_wifi3()`（`dp/wifi3.0/dp_rx_tid.c`）在 DP 层查找 peer、设置 RX TID reorder buffer（`dp_rx_tid_setup_wifi3()`）、将 BA 状态置为 `IN_PROGRESS`
- `lim_send_addba_response_frame()`（`lim_send_management_frames.c`）在 host 侧直接构造 ADDBA Response 帧体——这是**唯一由 host 侧构造的控制帧**。参数包括 AMSDU 支持标志、WEP 加密标志、协商后的 buffer size

ADDBA Response 不由固件自主生成，因为 Accept/Reject 决策依赖 host 侧的资源状态——REO engine 的队列是否已满、per-TID 的 buffer 是否够用——这些信息固件并不完全知晓。host 需要拿到固件的 REO 资源反馈后才能决定"能不能接受这个 BA 会话"。

Block ACK 就是收件人的签收单。普通的 ACK（每收到一个包裹就签一个单）效率太低——当一个货柜（AMPDU）里有 64 个包裹时，签 64 次单太浪费时间。Block ACK 是一次性签收——"货柜 1 到 64 号包裹全收到了，缺第 7 号和 23 号，请重发"。这个签收单（ADDBA Response）不是自动生成的——它需要 host 确认仓库（REO queue）还有空间放下一批包裹。

## 4.3 设备主动发起 ADDBA 的场景

上面讨论的是对端发起 ADDBA Request、本端被动响应。但在很多场景下，是本端设备**主动**发起 ADDBA 协商——作为 originator。

**QCOM 主动发起 ADDBA**

QCOM 的自动 ADDBA 触发**默认被禁用**——`ol_cfg_host_addba()`（`ol_cfg.h:555`）始终返回 0，因为 ADDBA 协商由固件全权处理。`ol_ctrl_addba_req` 宏被定义为 `ol_addba_req_reject`（直接拒绝所有 Host 侧触发的 ADDBA 请求），TX 队列中的 `OL_TX_QUEUE_ADDBA_CHECK` 是一个空操作。固件在检测到某 TID 有足够数据积压后，自主构造 ADDBA Request 帧并通过空口发送——Host 完全不知道这个过程的发生。

唯一的 Host 侧触发路径是通过 nl80211 vendor command（调试接口，非正常数据流路径）：

```
wlan_hdd_cfg80211.c:12328
  → sme_send_addba_req()                    // core/sme/src/common/sme_api.c:7667
    → wma_process_send_addba_req()           // core/wma/src/wma_main.c:1023
      → wmi_unified_addba_send_cmd_send()         // wmi_unified_api.c:1676 — WMI 封装
        → 固件收到 WMI_ADDBA_SEND_CMDID → 构造 ADDBA Request 帧 → 空口发送
```

WMI 命令仅含 4 个字段（vdev_id, peer_mac, tid, buffersize），不含 dialog token、BA policy、timeout、SSN（Start Sequence Number，起始序列号）等参数——这些由固件自行填充。

**MTK 主动发起 ADDBA**

MTK 使用 Linux 内核 mac80211 softMAC 框架，ADDBA 的发起由 mac80211 层控制（以下 `ieee80211_*` 函数均为 Linux 内核 `net/mac80211/` 中的标准实现，非 MTK 驱动专有）：

```
速率控制算法检测到某 TID 有足够数据量
  → ieee80211_start_tx_ba_session()           // Linux net/mac80211/agg-tx.c:580
    → drv_ampdu_action(IEEE80211_AMPDU_TX_START)  // 回调 MTK 驱动的低层实现
    → ieee80211_send_addba_request()           // agg-tx.c:61
      → 构造 802.11 ADDBA Request Action 帧 → 空口发送
```

对端回复 ADDBA Response 后，`ieee80211_process_addba_resp()`（`net/mac80211/agg-tx.c:955`）解析结果，成功后 `ieee80211_agg_tx_operational()` 设置 `HT_AGG_STATE_OPERATIONAL` 状态。MTK 驱动通过 `drv_ampdu_action()` 回调接收 mac80211 的 AMPDU 操作通知，在驱动内分配 TX ring 资源和 BA 会话上下文。

此外，MTK 固件也可通过 `EVENT_ID_TX_ADDBA` (0x2e) 事件通知 Host 为某 TID 设置 TX BA——这是一个固件触发的辅助路径，不需要 Host 侧的速率控制驱动。

TX 描述符级别有两个关键控制位：

- `CONNAC2X_TX_DESC_BA_DISABLE`（BIT(28)）：0 表示该帧可被固件聚合，1 表示单 MPDU 发送
- `CONNAC2X_TX_DESC_ADD_BA`（BIT(14)）：触发固件为该 TID 发起 ADDBA 请求（辅助路径的标志位）

**为什么设备要主动发起 ADDBA？**

不管哪个平台，当设备作为 TCP 发送端时（如上传大文件、视频流上行），上行数据量急剧增加。如果没有 BA 会话，每个数据帧都需要一个独立的 ACK，空口效率极低。设备主动发起 ADDBA 让发送方（originator）也成为聚合的受益者——上行数据也可以打包为 AMPDU 批量发送，吞吐量可以提升数倍。

## 4.4 ADDBA 建立后的数据聚合流程

ADDBA 协商成功后（收到 ADDBA Response 且 status=Accept），host 侧做三件事：

1. **记录 BA 会话状态**：per-peer per-TID 的 BA 会话表中记录 buffer size、超时时间、起始序列号。QCOM 在 `dp_rx_tid_setup_wifi3()`（`dp_rx_tid.c`，见 §4.2 调用链）中初始化 RX TID reorder buffer，固件独立管理 TX 侧的聚合状态。MTK 则由 mac80211 维护 `HT_AGG_STATE_OPERATIONAL` 标志（mac80211 在 `ieee80211_process_addba_resp()` 中设置，见 §4.3 MTK 路径）
2. **设置 TX 聚合窗口**：QCOM 通过 WMI 下发 BA 会话参数到固件（`wmi_unified_addba_send_cmd_send()`，见 §4.3 QCOM 主动发起路径）；MTK 的 mac80211 在 `ieee80211_agg_tx_operational()`（见 §4.3 MTK 路径）中释放此前排队在 `tid_tx->pending` 中的数据帧，启动 TX 队列，固件在 `apsGetEstimatedTput()`（`mgmt/aps.c:654`）的聚合窗口计算中读取 `baSize` 和 `amsduByte` 作为配置参考
3. **标记 TID 为"可聚合"**：后续该 TID 上的数据帧不再逐帧发送。MTK 侧，mac80211 的 `ieee80211_tx_prep_agg()` 检查 `OPERATIONAL` 标志后设置 `IEEE80211_TX_CTL_AMPDU`，对应的 TX 描述符中 `BA_DISABLE=0`（允许聚合，此时 `BA_DISABLE=1` 表示该帧必须单发）。固件将它们缓存在 TX ring 中，等待达到聚合条件

聚合条件由固件/硬件判断，host 不再参与：

- **数量条件**：累积的 MPDU 数量达到窗口大小（ADDBA 协商的 buffer size，通常 64）
- **时间条件**：如果一直凑不够数量，超过与对端协商的 ADDBA Timeout（单位 TU=1024us，常见值如 200 TU≈204ms，见 IEEE 802.11-2024 §10.25.2）后也强制发出
- **空口条件**：信道空闲时立即发送，避免因聚合等待而浪费传输机会（TXOP）

聚合帧发出后，接收方（对端）在收到整个 AMPDU 后发送 Block ACK 帧，逐 bit 反馈每个 MPDU 的接收状态。发送方固件在收到 Block ACK 后：

- 确认收到的 MPDU → 标记为 complete，释放 buffer
- 确认丢失的 MPDU → 重传（在下一个 AMPDU 中携带，或等窗口刷新）
- 释放的 buffer 通知 host 侧（通过 TX completion 中断），host 侧更新 TX ring write index，允许协议栈继续发包

整个聚合→发送→确认→重传的闭环在固件/硬件中完成，host CPU 完全不参与。这就像分拨中心的自动分拣机——快递员（host）把包裹放上进货传送带（TX ring）后撒手不管，合箱、装车、逐箱签收（Block ACK）全由分拣机（固件/硬件）自动完成。"host 只管把数据包放进 TX ring，固件负责所有空口调度"——这就是数据面吞吐量能做到 Gbps 级别的根本原因。

---

# 5 出了问题的物流网络：TX 异常路径

前面讲的都是"正常情况"——数据包从哪里进、经过哪些函数、最终到哪里。但数据面真正的挑战往往不在正常路径上，而在异常路径上。以下总结 TX 侧的关键错误场景。

**TX ring 满**：这是最常见的 TX 异常。当协议栈发包速度超过固件消费速度时，TX ring（或 TX 队列）会被填满。两个平台的处理策略不同：

- QCOM：ring 满的丢包决策不在 `dp_get_tx_resource()` 这一站——它是 void 回调，只预取 TX ring 资源状态、不做返回值判断（详见 §2.3 关卡 5）。真正的丢包在更下游的 `tx_fn` 尝试实际发送时触发（ring 满则返回失败），所有丢包分支最终汇聚到 `dp_start_xmit` 末尾的标签处释放 skb 并累加 `tx_dropped` 统计（`components/dp/core/src/wlan_dp_txrx.c:697-713`）：

```c
// dp_start_xmit 末尾 — 所有 goto 丢包标签的汇聚点（源码三级标签顺序落入）
drop_pkt_and_release_nbuf:
    qdf_net_buf_debug_release_skb(nbuf);  // 解除 skb 调试跟踪
drop_pkt:
    qdf_nbuf_kfree(nbuf);                 // free skb，释放内存
drop_pkt_accounting:
    qdf_net_stats_inc_tx_dropped(&dp_intf->stats);  // 丢包计数 +1
    return QDF_STATUS_E_FAILURE;
```

上层 TCP 根据丢包自动降速（拥塞控制），无需驱动主动干预。

- MTK：在 `kalHardStartXmit` 的 per-BSS per-AC 流控中，当 `ai4TxPendingFrameNumPerQueue[ucBssIndex][u2QueueIdx] >= u4TxStopTh` 时，调用 `netif_stop_subqueue(prDev, u2QueueIdx)` 停止该 AC 子队列——协议栈不会再往这个队列发包。TX worker 消费队列后，通过 `netif_wake_subqueue` 恢复（见 §3.2 第 16 道）

**DMA 映射失败**：skb 数据需要 DMA 映射到硬件可访问的物理地址。如果映射失败（极端内存碎片化，如系统长时间运行后物理页面碎片化导致无法分配连续的 DMA 物理地址），两个平台都选择丢包而非阻塞等待——但在**哪个阶段失败、谁负责兜底**上存在本质差异：

- **QCOM**：DMA 映射发生在 `htt_tx_desc_init()`（`core/dp/htt/htt_tx.c:1672`）中——`qdf_nbuf_map_single()` 在 HTT 描述符初始化时调用，失败时输出 WARN 日志并返回 `QDF_STATUS_E_NOMEM` 错误码（`htt_tx.c:1826-1831`），由上层 `ol_tx_desc_ll` 处理丢包。这意味着 skb 在 `dp_start_xmit` 的 10 道关卡中全部通过，但在 HTT 层构造描述符时才发现 DMA 映射失败——丢包发生得更晚，CPU 已经在前面的关卡中做了大量工作（ARP/DHCP 分类、mac 地址检查、orphan）但最终白费。
- **MTK**：DMA 映射发生在 `nicTxDirectStartXmitMain()` 调用链中的 HIF 层——此时 skb 已经过了 12 道前置工序（AIS 检查、headroom 重分配、帧解析、AC 分类等），包括那 1-2 次 memcpy。DMA 映射失败意味着之前的所有 headroom 重分配和 memcpy 全部白做——这些 CPU 开销在 QCOM 的路径上根本不存在（因为 QCOM 没有 headroom 重分配）。

**两者的根本差异**：QCOM 的 DMA 映射发生在独立描述符空间中——映射失败只浪费了 DP 层 10 道关卡的 CPU 时间，不涉及数据拷贝的浪费。MTK 的 DMA 映射晚于 headroom 重分配和 memcpy——映射失败意味着之前的数据拷贝全部付之东流。这是两种架构设计在异常路径上的复现：QCOM 的"先验证再修改"（关卡先过完，最后才 DMA 映射）vs MTK 的"边改边验证"（先做完所有数据准备，最后才 DMA 映射），前者在异常路径上浪费更少。

映射时机的早晚，还牵动着 TSO/GSO 分段策略的连带影响面。QCOM 走的是 TSO offload——`ol_tx_prepare_tso()`（`core/dp/txrx/ol_tx_ll.c:374`）在 HTT 描述符构造之前，把一个巨型 skb（TSO 场景下可聚合数十个 MSS）拆成一组 TSO 段描述符，随后 `htt_tx_desc_fill_tso_info()`（`core/dp/htt/htt_tx.c:1432`）把 TSO flags（`tcp_seq_num`、`l2_len`、`ip_len`）和每段物理地址写进 HTT 扩展描述符——真正的分段由固件完成，host 只映射不拷贝。因此 QCOM 的映射失败是粗粒度的：一个巨型 skb 相当于几十个 MSS 段，`qdf_nbuf_map_single()`（`htt_tx.c:1826`）一旦失败，整条巨型帧一次性丢弃，TCP 要重传这几十个段；但因为是零拷贝，失败时没有 memcpy 被浪费，丢的只是 TSO 段描述符的分配开销。

MTK 则完全不启用 TX offload——它的 netdev 只注册了 RX 侧的 `NETIF_F_GRO`（`os/linux/gl_kal.c:13341`），既没有 `NETIF_F_TSO` 也没有 `NETIF_F_SG`。于是协议栈在 `ndo_start_xmit` 之前，就在 `__dev_queue_xmit()`（`net/core/dev.c:4251`）里经 `validate_xmit_skb()` 的 GSO 检查，当 `netif_needs_gso()`（`dev.c:3753`）判定需要分段时调用 `skb_gso_segment()`（`dev.c:3756`）把 TCP 流切成一个个 MSS 大小的线性 skb——MTK 收到的永远是"已经分好段"的包。headroom 重分配和那 1-2 次 memcpy 因此是按段计费的：每个 1500 字节的段都单独拷一次，没有 TSO 那种"一次映射、固件批量分段"的摊薄；但映射失败也因此是细粒度的——只丢一个 1500 字节的段，也只浪费这一个段的 memcpy。

两种设计在异常路径上的代价结构正好相反：QCOM 用"映射早 + TSO offload"换零拷贝，代价是失败时整条巨型帧连坐重传；MTK 用"映射晚 + 无 offload"换细粒度失败隔离，代价是每个段都要付 memcpy 过路费。映射时机不是孤立的选择——它和分段策略、拷贝策略一起，决定了失败时"一次性丢多少、白做多少功"。

**固件挂死（Firmware Hang）**：这是最严重的 TX 异常——固件不再消费 TX ring，host 侧持续积压。两个平台的检测和恢复机制完全不同，反映了各自对"灾难性故障"的应对哲学：

- QCOM 有三层防护：(1) hdd 层 `hdd_dp_ssr_protect/unprotect` 的引用计数配对——保证 TX 执行期间 SSR 流程不会拆除数据结构，防止并发访问导致 use-after-free；(2) dp 层 `cds_is_driver_transitioning()` 在 SSR/初始化过渡期阻止新包进入正在重建的 DP 层；(3) 挂死检测通过 WMI 控制通道心跳超时（独立于 HTT 数据通道）——WMI 是双向的 request-response 协议，固件在超时窗口内未回复 WMI heartbeat 则认为挂死。**关键设计**：心跳走 WMI（控制通道）而非 HTT（数据通道），因为挂死时 HTT 通道的 TX ring 积压可能掩盖心跳超时——WMI 使用独立的 MBOX/Credit 机制，不依赖 HTT 的 ring buffer 状态。检测到挂死后触发 SSR（SubSystem Restart）——完整的固件重加载流程，期间所有 WiFi 连接断开。
- MTK 使用 `GLUE_FLAG_HALT_BIT` 单一标志位（`os/linux/include/gl_os.h:270`，值为 bit 0）。固件检测到内部异常后通过 NIC cmd 事件通道设置此标志，host 侧所有后续的 `kalHardStartXmit` 调用直接 free skb 并返回 `WLAN_STATUS_ADAPTER_NOT_READY`。与 QCOM 的引用计数机制不同，MTK 使用单 bit 而非计数——这意味着无法支持"等待正在执行的 TX 完成后重启"这种优雅降级。MTK 的选择是：挂死后立即停止一切 TX，不做任何等待。

**为什么 QCOM 如此复杂而 MTK 如此简单？** QCOM 的多芯片平台架构（QCA8074、QCA6390、WCN6855 等共用同一套 host 驱动框架）要求 SSR 机制能适应不同固件版本的恢复流程——引用计数的复杂性是通用性的代价。MTK 的每代芯片（mt7915、mt7925、mt7990 等）有独立的驱动代码库，固件挂死的处理可以硬编码为"清空所有队列+复位芯片"——简单但不可复用。

**HIF 层发送失败**：当 PCIe 链路异常或 CE ring 满时，两个平台都面临"数据已准备好但硬件不收"的困境——但它们的失败点处于调用链的不同深度：

- QCOM：`ce_send_single()`（`ce_service.c:750`）在 CE source ring 的 `write_index` 追上 `sw_index - 1`（ring 满）时返回 `QDF_STATUS_E_RESOURCES`。这个失败的调用方是 HTT/HTC 层（先经过 `htc_try_send()` 的 credit 流控检查，再过 `__htc_send_pkt()` 封包，最后在 `ce_send_single()` 才发现 ring 满——中间已经做了 HTC 封包的工作）。HTC 层根据返回值决定丢包或保留在 endpoint 发送队列中重试。`hif_prevent_link_low_power_states()`（`if_ipci.c:1013`）在 CE completion 路径中通过 `scn->wstats.prevent_l1_fails` 计数器追踪连续失败（`hif_main.c:1877`），超过阈值后阻止 PCIe 链路进入 L1 低功耗状态——因为频繁进出 L1 状态本身是链路异常的诱因之一。
- MTK：HIF 层 DMA 提交失败或 WFDMA ring 满时，通过 `nicTxReturnMsduInfo()`（`nic_tx.h:1908`）释放 `MSDU_INFO` 和 skb buffer 并增加 `tx_errors` 统计计数。与 QCOM 不同，MTK 没有 CE/HTC 中间层——HIF 失败直接回收资源，路径更短但信息更少（QCOM 的 HTC credit 机制可以提供"为什么失败"的上下文：credit 不够 vs ring 满 vs 链路异常）。

**两者的差异**：QCOM 的失败复用 `dp_start_xmit` 末尾的丢包统计路径（`qdf_net_stats_inc_tx_dropped`），MTK 使用独立的 `tx_errors` 计数器。这意味着在 QCOM 上，HIF 层丢包和 DP 层丢包混在同一个计数器里——排查问题时需要交叉对比 WMI 日志才能区分。MTK 的独立计数器可以直接定位到"是 HIF 层丢的"——简洁但不够细粒度。

**WFDMA 异常**：MTK 的 WFDMA（WiFi DMA）引擎在高吞吐量场景下可能出现 DMA 描述符超时——这是 QCOM 不存在的问题（QCOM 使用 CE 引擎，与 MTK 的 WFDMA 是完全不同的 DMA 架构）。

WFDMA 的工作机制：host 在 TX ring 中写入 DMA 描述符（buffer 物理地址 + 长度 + flags），通过 `mboxSendMsg()` 门铃通知固件。固件收到中断后，WFDMA 引擎硬件自动从 TX ring 读取描述符并执行 DMA 搬运。如果固件在超时窗口内未消费——host 通过轮询 `wfdma_ring_info`（`os/linux/hif/common/dbg_pdma.c:44`，跟踪 `base/cnt/cidx/didx` 四个寄存器值）检测到 cidx（consumer index）停止推进——意味着三种可能：(1) 固件调度器被高优先级任务阻塞，(2) MBOX 中断丢失或固件未及时响应，(3) WFDMA 引擎硬件错误。

恢复流程是破坏性的：驱动遍历 TX ring 回收所有未完成的 MSDU_INFO 和 skb buffer（free），调用 `kalDevKickData()` 重新初始化 WFDMA 通道——相当于把传送带停下来，把上面所有包裹捡回仓库，重新开机。恢复期间所有 TX 暂停，对上层表现为**短暂的断网**（通常在 100-500ms 量级）。

**为什么 QCOM 不需要类似的恢复？** CE 引擎是单向管道——host 写 source ring，硬件读 destination ring，没有"固件未消费"的概念。如果固件不读 destination ring，数据只是积压在 CE 管道中（不会触发 DMA 超时，因为没有超时机制——CE 是被动等待硬件读取的）。QCOM 的固件挂死由 WMI 心跳检测兜底，走 SSR 路径恢复——这是更粗粒度的恢复，但覆盖了所有异常场景。

**BA 会话拆除（DELBA）**：BA 会话的完整生命周期包括建立（ADDBA）和拆除（DELBA）两个闭环环节——只建不拆会导致对端重排序窗口溢出，后续 Block ACK 全部失效。DELBA 由对端发起或本端主动触发：

- QCOM：`lim_send_delba_action_frame()`（`core/mac/src/pe/lim/lim_send_management_frames.c:6598`）构造 DELBA Action 帧并通过空口发送，`lim_delba_tx_complete_cnf()` 在发送完成回调中释放 REO queue 资源和 reorder buffer（`dp_rx_tid_delete_wifi3()`）。消息分发路径为 `lim_req_send_delba_ind_process()`（`lim_link_monitoring_algo.c:577`）→ `lim_send_delba_action_frame()`
- MTK：固件通过 `EVENT_ID_RX_DELBA`（0x0b，`wsys_cmd_handler_fw.h:448`）事件通知 Host——当对端发送 DELBA 帧时，固件解析后将 DELBA 帧体（对应 `ACTION_DELBA_FRAME` 结构体格式，`mac.h:4002`，其中 `u2DelBaParameterSet` 字段通过 `ACTION_DELBA_INITIATOR_MASK`（`mac.h:2077`）和 `ACTION_DELBA_TID_MASK`（`mac.h:2078`）解析 Initiator 位和 TID）通过 wsys event 通道上报。Host 侧在通用事件分发路径中收到此事件后，调用 mac80211 标准接口 `ieee80211_stop_tx_ba_session()` 清理 per-TID 的 AMPDU 缓存帧和 TX ring 队列，释放 BA 会话上下文

BA 会话的另一个无声杀手是超时：ADDBA 协商的 Timeout 到期（常见 200 TU≈204ms，见 §4.4）后，如果一方持续未收到 Block ACK 或对端无数据，BA 会话自动失效。此时 host 侧需要清理挂起的聚合帧——QCOM 固件通过 HTT `HTT_T2H_MSG_TYPE_RX_DELBA` 事件通知 host，MTK 的 mac80211 在 `sta_rx_agg_session_timer_expired()` 中处理超时。这部分逻辑在固件/mac80211 内部闭环，host 驱动层不直接感知超时判断——直到 DELBA 事件到达才开始清理。

**为什么 DELBA 是破坏性操作——不拆的后果**：BA 会话的 reorder buffer 由接收方维护。如果发送方认为 BA 会话仍有效并继续发送 AMPDU（最大窗口通常 64 帧），而接收方已经超时释放了 reorder buffer，接收方收到的每个 AMPDU 帧都无法找到对应的 reorder 上下文——全部丢弃。更糟的是，发送方的 Block ACK 请求（BAR）不会被应答（因为接收方没有对应的 BA 会话），导致发送方误以为空口丢包并不断重传——形成"发送方持续重传、接收方持续丢弃"的死循环，直到上层 TCP 超时断开连接。BA 超时的真正危险不在于"少了一种发送方式"，而在于"旧的聚合仍在运行但接收方已退出"——这是一个需要两端同步清理的分布式状态问题。

总结：TX 异常就是物流事故。TX ring 满 = 传送带堵了——顺丰（QCOM）选择丢包让寄件人（TCP）自己重发，菜鸟（MTK）选择把传送带停下来（`netif_stop_subqueue`）。固件挂死 = 干线车坏了——顺丰通过心跳检测（WMI）发现并启动应急预案（SSR），菜鸟在门口挂个"暂停营业"的牌子（`GLUE_FLAG_HALT_BIT`）。DELBA 超时 = 收件人退租了但没有通知快递公司——寄出的包裹全部丢在空无一人的仓库门口，无人签收。


---

# 6 QCOM vs MTK TX：到底差在哪里？

将 TX 放在一起，QCOM 和 MTK 的完整差异如下：

| 维度            | QCOM                                                         | MTK                                                          |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **TX 入口**     | `hdd_hard_start_xmit`（SSR protect/unprotect）               | `wlanHardStartXmit`（Reset 检查）                            |
| **TX 层次**     | HDD → DP Dispatcher → DP Core → `tx_fn` → HTT → CE → PCIe    | GLUE → KAL → TX worker → HIF/WFDMA → MBOX                    |
| **TX 特点**     | EAPOL 快速路径、SME 准入控制、VO→VI→BE→BK 降级               | 入队即返回、Direct/非Direct 双模发送                         |
| **TX 拷贝策略** | 零拷贝（TX 描述符独立分配，HTT 消息传递）                    | 每包 1-2 次 memcpy（headroom 重分配 + cloned skb 独立化）    |
| **固件通信**    | HTT（数据）+ WMI（控制）分离                                 | NIC cmd（TC4 统一通道）+ MBOX 门铃                           |
| **物理总线**    | PCIe（CE DMA）/ SDIO（CMD53）                                | PCIe（WFDMA）/ SDIO                                          |
| **CPU 亲和性**  | **TX：per-CPU TX Ring 无锁替代显式绑核。RX：通过 INI 配置 NAPI 绑核 + DP RX refill 线程绑核，workqueue 均为 WQ_UNBOUND**。结论：QCOM 侧重 RX/NAPI 绑核；TX 靠 per-CPU ring 无锁替代绑核 | **TX：4 个 kthread + 5 个 worker 绑大核（仅新平台），`kalTxWorkSchedule()` 小核收包后通过 `kalWorkSchedule()` → `queue_work_on()` 跨 CPU 调度到大核执行 `kalTxDirectStartXmit()`**。结论：MTK 侧重 TX worker 绑大核 |
| **设计哲学**    | 复杂度换吞吐量弹性                                           | 简洁性换可靠性                                               |

QCOM 是一座顺丰枢纽级分拨中心——每个包裹自带独立运单（HTT 描述符），零拷贝过传送带，分拣线有 10 道关卡严防死守，SSR 机制保证干线车坏了也能快速恢复。MTK 是一家菜鸟社区驿站——运单要写在包裹包装纸上（skb headroom），包装纸不够大就要换纸重包（memcpy），一条传送带一个柜台，包裹从进门到发货都在一条线上做完，省空间省人手，但每站都多花一步。没有谁更好——你的单量（吞吐量需求）和预算（芯片成本）决定了你该开枢纽还是驿站。

---

# 7 写在最后

本章追踪了数据帧从 `ndo_start_xmit` 到固件的完整 TX 路径。QCOM 的 10 道关卡、MTK 的 18 道工序，走的是截然不同的两条路——一个用独立描述符池换零拷贝，一个用 memcpy 换硬件简洁；一个有 SME 准入状态机做精细的 AC 降级，一个用队列深度阈值做朴素的流控。

但它们解决的是同一个问题：**如何在软中断的约束下，高效地把数据包从协议栈搬进固件**。

不管你的包裹走顺丰枢纽还是菜鸟驿站，快递员（ndo_start_xmit）的柜台永远只有一个——数据面没有后门，只有正门。

顺丰枢纽和菜鸟驿站的差异，本质上是两套设计哲学。

**QCOM 的复杂是通用性的代价。** 一套 host 驱动框架要适配从旗舰手机芯片（QCA8074）到 IoT 模组（QCA9377）的多种芯片，从 PCIe 到 SDIO，从 wifi3.0 到 CLD。架构上的每一层抽象——HDD→DP→HTT→HTC→HIF→CE——都是在为"换一块芯片不改上层代码"买单。SSR 的引用计数、WMM 的状态机、HTT/WMI 的双通道分离，都是这种"解耦"哲学的产物。代价是代码量大、调用链深、单次 bug 的影响面广。

**MTK 的简洁是市场定位的映射。** MTK 芯片面向中低端手机和 IoT 设备，成本敏感、CPU 核心充裕（入门手机也有 4-8 核 A55），不需要 Gbps 级别的峰值吞吐量。牺牲一点 CPU（每个包多 1-2 次 memcpy）换更短的调用链、更少的抽象层、更直接的固件通信——这是在芯片面积和 CPU 利用之间做的工程权衡。Direct 模式的 CPU 亲和性绑大核、per-BSS per-AC 的朴素流控，都是"用软件补硬件"的思路——硬件 DMA 引擎不够智能，就让软件多做一点。

两个平台在异常路径上的差异尤其能说明问题。TX ring 满时 QCOM 丢包让 TCP 重传（相信上层协议的拥塞控制）、MTK 停队列让协议栈暂停（主动保护驱动内部状态）；固件挂死时 QCOM 走完整的 SSR 重启（恢复后状态干净但慢）、MTK 挂一个 HALT 标志直接拒绝一切（立即止损但无法恢复）。QCOM 的策略是"相信上层"——协议栈的拥塞控制比驱动内部的流控更成熟；MTK 的策略是"自己兜底"——驱动内部状态自己管理，不依赖上层行为。

本章没有覆盖但值得思考的问题：

- **DSCP→UP 映射**：WMM 的 AC 分类之前，还有一个 QoS Map 的协商过程（IEEE 802.11-2024 §9.4.2.94），决定 DSCP 值到 UP 的映射。QCOM 在 SME 层处理，MTK 在连接阶段通过 mac80211 处理——两者的映射表可能不同，导致同一 DSCP 值在两个平台上走了不同优先级的队列。
- **6GHz 和 MLO 的 TX 路径**：WiFi 7 的多链路操作（MLO）需要 host 侧在两个链路之间做负载均衡决策——这个决策是 host 做还是固件做？两个平台的选择可能截然不同。

但这些问题留给未来——MLO 的 TX 路径足够写一整章。

数据帧接收文章中，我们将追踪数据面的另一条主线——RX 路径。数据包从固件回到协议栈的路上，QCOM 把 GRO 拆成了两段（NAPI 做 merge，kthread 做 flush），MTK 在 softirq 中一口气做完——这是本系列的核心亮点之一。TX 是"把包裹交给快递员"，RX 是"从快递员手里接包裹"——分拣线跑通了两条，数据面的全貌才算完整。

---

协议依据：IEEE 802.11-2024 §9.3.2（数据帧格式）、§10.25（Block ACK 协议）、Table 10-1 + §10.23.2（WMM AC 分类）、§9.7 + §10.12（AMPDU 聚合）。源码路径见各代码块注释。

本文源码来自 QCOM 的 [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0) 与 [qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn) 仓库，以及 MTK 的 [gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m) 仓库。
