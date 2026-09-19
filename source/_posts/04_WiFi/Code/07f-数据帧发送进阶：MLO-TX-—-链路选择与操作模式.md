---
title: 数据帧发送进阶：MLO TX — 链路选择与操作模式
top: 1
related_posts: true
abbrlink: 4572100e
date: 2026-09-19 21:18:48
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> "WiFi 7 的路由器有 2.4G+5G+6G 三条链路，你的手机也同时连着三条——但一个 TCP ACK 走哪条？这不是简单的'随便选一条'——语音帧需要低延迟走 5GHz，后台下载不介意延迟走 2.4GHz 还能省电。谁来做这个选择？host 还是固件？QCOM 和 MTK 给出了同一个答案，但背后的架构逻辑完全不同。"

---

# 本章导读

数据帧发送篇追踪了从 `ndo_start_xmit` 到固件的完整发送路径——QCOM 的 10 道关卡、MTK 的 18 道工序、WMM AC 分类、Block ACK 协议。但那篇文章聚焦的是**单链路**场景：一个 WiFi 网卡，一条信道，数据包从协议栈一路走到空口。

WiFi 7 改变了游戏规则。MLO（Multi-Link Operation）让 STA 可以**同时**关联 2.4GHz、5GHz 和 6GHz 三条链路——数据包在进入驱动后不再是"一条路走到黑"，而是面临一个岔路口：走哪条链路？用仓库来比喻：单链路是一间只有一条传送带的仓库，MLO 把它扩成了多航线分拨中心——每个数据帧进仓后，第一件事就是决定装进哪架货机。

<!--more-->

这个选择并非简单。语音通话（TID 6）需要低延迟，应该走干扰少的 5GHz；后台同步（TID 1）不介意延迟，用 2.4GHz 还能省电。IEEE 802.11be 为此定义了 TID-to-Link Mapping（T2LM）——一套让 AP 和 STA 协商"哪个 TID 走哪条链路"的协议。但协议只是蓝图——执行链路选择的代码在固件里，host 侧的角色是下发策略、接收反馈。

在这条路径上，操作模式（STR、eMLSR、EMLMR）是前置约束——它决定了固件"能同时在几条链路上发"。STR 模式下可以两条链路同时发送，eMLSR 模式下只能一条链路活跃且切换需要 padding delay——这些模式差异直接影响了固件的调度自由度和 TX 路径的延迟特征。

本章要回答三个问题：

- WiFi 7 路由器有 2.4G+5G+6G 三条链路，一个 TCP ACK 走哪条？T2LM 是怎么让 host 和固件对这个决策达成一致的？
- SLO、MLSR、eMLSR、MLMR（含 STR/NSTR）四种操作模式有什么区别？eMLSR 的 padding delay 对 TX 路径意味着什么？QCOM 和 MTK 分别怎么管理操作模式切换？
- QCOM 和 MTK 都把链路选择交给固件——为什么？如果让 host 做决策会怎样？

MLO 连接的建立过程（`mlo_connect()`、多链路 Auth/Assoc、密钥共享）已在连接篇（五）详述，本章只聚焦连接建立后的 TX 路径；DSCP→UP 映射（QoS Map）是另一个独立主题，见上一篇；组播（Multicast）帧的 MLO 链路选择同样不在本章范围——本章只讨论单播数据帧的 T2LM 链路选择。

---

# 1 6GHz TX 有特殊路径吗？

在进入 MLO TX 之前，先澄清一个可能的误解：6GHz 频段的 TX 路径**没有额外的特殊处理**。

6GHz 相关的特殊性主要体现在**扫描和发现阶段**——PSC（Preferred Scanning Channel，15 个优选信道）、RNR（Reduced Neighbor Report，跨频段发现）和 FILS 发现帧——这些已在扫描篇（上/中/下）中详述。从 TX 路径的角度，6GHz 只是一个新的频段，对应一个新的 vdev（QCOM）或一个新的 BSS Index / netdev（MTK）。数据帧从 `ndo_start_xmit` 进入后，走的是和 2.4GHz/5GHz 完全相同的 `dp_start_xmit` / `wlanHardStartXmit` 路径——只是最终经过的 vdev/BSS 不同而已。

6GHz 的 TX 能力注册发生在初始化阶段。QCOM 在 `hdd_update_wiphy_he_6ghz_capa`（`wlan_hdd_main.c:2248`）中设置 `iftype_data_6g->he_6ghz_capa` 字段——包括最小 MPDU 起始间距、最大 AMPDU 长度指数、最大 MPDU 长度、SM Power Save 和天线模式一致性标志。这些能力通过 `wiphy_register` 向 cfg80211 注册，供关联时协商使用，不直接影响 TX 数据路径。

真正的 TX 路径变化来自 MLO——当 STA 同时连接 2.4GHz 和 5GHz（或 6GHz）时，多了一条链路，问题就从"怎么走"变成了"走哪条"。6GHz 就像快递公司新开的一条航空专线——航线本身是新的，但包裹进入仓库后的分拣流程完全一样，区别只在于最终装上了哪条航线的货机。

不过，6GHz 链路在 MLO TX 的链路选择中确实有天然优势。6GHz 频段没有 legacy 设备（802.11a/n/ac）争用信道，CCA 空闲比例显著高于 2.4GHz 和 5GHz；信道带宽可达 160MHz 甚至 320MHz（WiFi 7），单链路吞吐量上限远超其他频段。这些优势会体现在固件的实时信道质量指标中——6GHz 链路的 SNR 通常更高（干扰少）、CCA 占用比更低（无 legacy 竞争）、TX 成功率更高（信道条件好）。当 T2LM 允许 TID 同时走多条链路时，固件的实时决策算法会自然偏向 6GHz——但这种偏向不是硬编码的权重，而是信道质量指标的自然结果。如果 6GHz 链路因距离远或遮挡导致信号衰减，固件会毫不犹豫地选择信号更好的 5GHz 或 2.4GHz。6GHz 的"偏好"本质上是"好用的链路自然被多用"——这和快递公司新开一条航空专线后，只要航线准时率高、运力充足，包裹自然会往这条线上涌是一个道理。

当 STA 同时握有多条链路时，每包的发送链路由谁决定、怎么决定——这是本章要回答的核心问题。

操作模式是链路选择的前提。

---

# 2 MLO 操作模式：STR、eMLSR、EMLMR 与 TX 路径

上一节说"TX 路径变化来自 MLO"，但这个变化不仅仅是"多了一条链路可以选"——在回答"一个帧走哪条链路"之前，需要先理解一个更基础的问题：这些链路各自处于什么状态？IEEE 802.11be 定义了四种多链路操作模式：SLO（Single-Link Operation，单链路）、MLSR（Multi-Link Single-Radio，多链路单射频）、eMLSR（Enhanced Multi-Link Single-Radio，增强型多链路单射频）和 MLMR（Multi-Link Multi-Radio，多链路多射频）。MLMR 又分两个子模式——STR（Simultaneous TX/RX，同时收发）和 NSTR（Non-Simultaneous TX/RX，非同时收发），区别在于多条链路能否同时工作。每种模式对 TX 路径的约束完全不同。操作模式决定了固件"能同时在几条链路上发"，是后续链路选择（T2LM，§3 详述）的前置条件——不理解操作模式，就无法理解固件为什么要做链路选择、怎么做链路选择。

## 2.1 四种模式的协议定义

IEEE 802.11be 在 Multi-Link element 的 Common Info 中定义了 EML Capabilities 子字段（EML Capabilities bit），其中包含 eMLSR Support、eMLSR Padding Delay、eMLSR Transition Delay、eMLMR Support、eMLMR Delay 和 Transition Timeout 六个子域。这六个子域组合起来，决定了 MLO STA 能工作在哪种操作模式下：

```
四种 MLO 操作模式：

  SLO (Single-Link Operation)
    只有一条链路活跃，等价于传统 WiFi。
    无 MLO 链路选择问题。

  MLSR (Multi-Link Single-Radio)
    多条链路关联，但只有一个射频模块。
    同一时刻只能在一条链路上收发——需要切换射频到另一条链路时，
    必须先在当前链路完成正在进行的 TX/RX，再切换。
    切换时间由 Transition Delay 决定（典型值 ~0ms，即无额外延迟）。

  eMLSR (Enhanced Multi-Link Single-Radio)
    MLSR 的增强版。核心区别：链路切换前需要 Padding Delay
    （在当前链路发送 padding PPDU 填充空闲时间），
    让对端有时间准备接收切换后的链路。
    Padding Delay 由 EML Capabilities 中的 emlsr_pad_delay 字段编码
    （3 bit，指数编码：0=0μs, 1=32μs, 2=64μs, 3=128μs, 4=256μs）。
    TX 路径影响：切换链路时，固件必须在当前链路发送 padding PPDU，
    这段时间当前链路不能发送有效数据——相当于在传送带切换前
    先放几个空箱子占位，等对端调整好接收天线。

  MLMR (Multi-Link Multi-Radio)
    多条链路，多个射频模块。
    又分两个子模式：
      - STR (Simultaneous TX/RX)：多条链路可以同时收发。
        TX 路径影响：固件可以同时在两条链路上发送数据帧，
        不存在切换延迟。这是性能最高的模式。
      - NSTR (Non-Simultaneous TX/RX)：多条链路不能同时收发
        （通常因为射频前端共享天线或 LNA）。
        TX 路径影响：同一时刻只能在一条链路上发送，
        但切换速度比 eMLSR 快（无需 padding delay）。
        硬件约束根因：两条链路的射频前端共享低噪声放大器（LNA）
        或天线开关——当一条链路的功率放大器（PA）处于发射状态时，
        另一条链路的 LNA 输入端会因 PA 泄漏而饱和，
        导致接收灵敏度下降甚至接收机阻塞。
        固件通过 WTBL 的 str_bitmap 字段（MTK）
        或 Multi-Link Capabilities 中的 NSTR Indication（QCOM）
        获取 NSTR 链路对信息，在 TX 调度器中将互斥链路对标记为
        "同一时刻只能激活一条"。
```

STR 链路对为什么不存在这个约束？当两条链路使用独立的天线链路（各自配备独立天线、独立 LNA、独立 PA）时，发射链路的 PA 泄漏到接收链路 LNA 输入端的路径被天线隔离度阻断——典型的 T/R 隔离度在 20-30dB 之间，意味着 PA 泄漏功率到达 LNA 时已衰减 100-1000 倍，远低于 LNA 的饱和阈值（典型 -30dBm）。NSTR 的出现恰恰是因为两条链路共享了部分射频前端组件（天线开关、LNA 或 PA），导致隔离度不足——PA 泄漏功率足以将共享 LNA 推入饱和区，接收灵敏度骤降甚至接收机完全阻塞。这也是为什么 NSTR 链路对的互斥约束是硬件层面的物理限制，不能通过软件调度优化绕过。

STR 和 eMLSR 的区别对 TX 路径的影响最为显著：STR 模式下，两条链路的 TX 队列完全独立，固件可以同时向两条链路提交 TX 描述符，吞吐量接近两条链路之和；eMLSR 模式下，同一时刻只有一条链路活跃，固件需要在链路间切换时插入 padding delay，有效吞吐量受限于单链路加上切换开销。用仓库的场景来说——STR 相当于两个分拣员各自守着一条传送带，同时往两条线上装货，效率接近翻倍；eMLSR 相当于一个分拣员管两条传送带，换线之前得先在当前线上放几个空箱子占住节奏（padding PPDU），等对端的接收窗口调整好了再正式切过去。空箱子不产生配送价值，但没有它对端就会漏接——这就是 padding delay 的本质。

padding delay 不是一个随意的协议参数——它对应 PHY 层信道切换的真实物理过程。当射频模块从当前信道切换到目标信道时，频率合成器需要重新锁定（PLL settling，典型 5-10μs），自动增益控制（AGC）需要重新采样校准以适应新信道的信号电平，如果两条链路使用不同天线链路还需要切换天线开关——所有这些必须在 256 微秒内完成（kernel 定义的最大有效 padding delay 值 4 对应 256μs，`include/linux/ieee80211.h:4762`）。在这段时间内，对端的接收机处于失锁状态——它还在监听旧信道，无法解码新信道上的任何帧。

STA 在当前链路发送 padding PPDU 填充这段切换窗口，让对端保持帧同步和定时对齐；padding 结束后，STA 已经在新链路上完成 PHY 初始化，对端可以无缝接收第一个有效帧。`emlsr_pad_delay` 的 3-bit 编码采用指数递增方案（kernel 定义于 `include/linux/ieee80211.h:4758-4762`：值 0=0μs, 1=32μs, 2=64μs, 3=128μs, 4=256μs，值 5-7 reserved）——这是 STA 向对端承诺的切换窗口时长。硬件切换越快，padding delay 越短，浪费在填充上的空口时间越少，有效吞吐量越高——正因如此，芯片厂商将 padding delay 视为 eMLSR 竞争力的核心指标。

用一个具体数值走一遍切换时序。假设 STA 在 Association Request 中宣告 `emlsr_pad_delay=4`（对应 256μs）、`emlsr_trans_delay=2`（对应 32μs），当前活跃在 Link 0（2.4GHz），需要切换到 Link 1（5GHz）发送一个语音帧：

- **T0**：STA 在 Link 0 上发完最后一个有效帧（或 BA session 中的最后一个 A-MPDU）
- **T0 ~ T0+256us**：STA 在 Link 0 上发送 padding PPDU——这是一段空口填充，不携带有效数据，目的是让 AP 的接收机保持帧同步。在这 256us 窗口内，STA 的射频模块开始执行信道切换：频率合成器从 2.4GHz 重新锁定到 5GHz（PLL settling，Fractional-N 合成器典型 5-8us），AGC 重新校准增益（典型 10-20us），天线开关切换链路（典型 1-2us）
- **T0+256us**：padding PPDU 结束，STA 的射频模块已在 Link 1 上完成 PHY 初始化。STA 进入 Transition Delay 窗口——这是 STA 给自己的额外缓冲，确保基带处理器完成新信道的时钟同步和 OFDM symbol 对齐
- **T0+288us**（256+32）：Transition Delay 结束，STA 在 Link 1 上发送第一个有效数据帧。AP 在 Link 1 上成功接收

整个切换过程浪费 288us 的空口时间。如果 STA 每 10ms 切换一次（典型语音流量场景），开销为 288us/10ms = 2.88%；切换频率更高（每 5ms 一次）时上升到 (256+32)/5000 = 5.76%。288us 换 2.88%，这是 eMLSR 的硬成本。

指数编码的设计逻辑是分档权衡：低延迟场景用小值（0-64μs）换取低开销，高干扰场景用大值（128-256μs）换取可靠性。为什么选指数而非线性？3-bit 编码空间只有 8 个值（0-7），线性方案（如每步 32μs）只能覆盖 0-224μs——丢失了 256μs 这个关键档位；指数方案用 5 个编码点（0/32/64/128/256μs）覆盖了 4μs 到 256μs 的范围，动态范围达到 64 倍。如果 IEEE 当年允许 5-bit padding delay（编码 0-31，覆盖 0 到 992μs），额外的 bit 空间能让企业 AP 在高密度多径环境下用更长的 padding 窗口换取可靠性，但对 IoT STA 而言，更宽的编码范围意味着对端可能宣告极端延迟值，eMLSR 的功耗优势将被更大的切换开销抵消——3-bit 的约束实际上保护了 eMLSR 作为省电方案的定位。

PHY 切换时间的分布特性决定了这种非线性编码的必要性：PLL settling（5-8μs）、AGC 校准（10-20μs）和天线开关（1-2μs）三者跨越近一个数量级，正常工况下总计不超过 30μs，但温度漂移和多径环境下的 AGC 收敛延迟可能将其推高到百微秒级。指数编码在低值区提供三个精细档位（0/32/64μs）覆盖正常工况，在高值区用两个档位（128/256μs）覆盖极端工况——在有限 bit 空间下实现最优的动态范围覆盖。值 5-7 保留为 reserved——超过 256μs 的 padding delay 会让 eMLSR 的性能优势被切换开销吞噬。QCOM host 驱动用 `WLAN_ML_BV_CINFO_EMLCAP_EMLSRDELAY_INVALIDSTART`（值 5，`wlan_cmn_ieee80211.h:2438`）作为哨兵，任何 >=5 的值直接判定无效。

256μs 作为截止点并非随意选择：当前商用 WiFi 芯片（Qualcomm WCN7850、MediaTek MT6653）的 PLL settling 时间典型值 5-8μs，AGC 重校准 10-20μs，天线开关 1-2μs——总计不超过 30μs。256μs 的 padding 窗口提供了接近 10 倍的裕量覆盖极端工况（温度漂移、多径引起的 AGC 收敛延迟），同时不超过 1ms 的心理阈值——超过这个阈值，eMLSR 的"伪同时"优势将被切换开销完全抵消。

256μs 是功耗与可靠性的平衡点。eMLSR 的切换时序（padding→transition→有效帧）与 PCIe 链路训练的 TS1/TS2 握手序列异曲同工：都是通过在链路上发送非数据填充来同步两端状态机，确保接收端在数据到达前已完成 PHY 层锁定。

`emlsr_pad_delay` 的角色就像交叉路口的黄灯时间：黄灯太短，对向车道的车（AP 接收机）来不及刹车就冲进路口（接收机失锁）；黄灯太长，路口通行效率下降（空口时间浪费在填充上）。3-bit 指数编码让 STA 在低延迟和高可靠性之间选择合适的档位。

## 2.2 QCOM 实现：`enum wlan_eht_mode` 与 eMLSR ENTER/EXIT

QCOM 在 host 侧用两个枚举管理 MLO 操作模式。`enum wlan_eht_mode`（`cfg_mlme_generic.h:72`）定义了操作模式本身：

```c
// QCOM: components/mlme/dispatcher/inc/cfg_mlme_generic.h:72 — enum wlan_eht_mode
enum wlan_eht_mode {
    WLAN_EHT_MODE_DISABLED  = 0,
    WLAN_EHT_MODE_SLO       = 1,   // Single-Link Operation
    WLAN_EHT_MODE_MLSR      = 2,   // Multi-Link Single-Radio
    WLAN_EHT_MODE_MLMR      = 3,   // Multi-Link Multi-Radio (STR+NSTR)
    WLAN_EHT_MODE_EMLSR     = 4,   // Enhanced Multi-Link Single-Radio
    WLAN_EHT_MODE_LAST,
    WLAN_EHT_MODE_MAX = WLAN_EHT_MODE_LAST - 1,
};

```

`enum wlan_emlsr_action_mode`（`cfg_mlme_generic.h:93`）定义了 eMLSR 的状态切换动作：

```c
// QCOM: components/mlme/dispatcher/inc/cfg_mlme_generic.h:93 — enum wlan_emlsr_action_mode
enum wlan_emlsr_action_mode {
    WLAN_EMLSR_MODE_DISABLED = 0,
    WLAN_EMLSR_MODE_ENTER    = 1,   // 进入 eMLSR 模式
    WLAN_EMLSR_MODE_EXIT     = 2,   // 退出 eMLSR 模式
    WLAN_EMLSR_MODE_LAST,
    WLAN_EMLSR_MODE_MAX = WLAN_EMLSR_MODE_LAST - 1,
};

```

注意 `wlan_eht_mode` 中 MLMR 不区分 STR 和 NSTR——这个区分由固件在协商 Multi-Link Capabilities 时内部处理，host 侧不感知。但用户空间（wpa_supplicant）的 vendor 命令需要区分：`enum qca_wlan_eht_mlo_mode`（`qca_vendor.h:10424`）将 MLMR 拆分为 `QCA_WLAN_EHT_NON_STR_MLMR` 和 `QCA_WLAN_EHT_STR_MLMR` 两个值，由 `hdd_get_cfg_eht_mode`（`wlan_hdd_cfg80211.c:10911`）在映射到内部枚举时合并为 `WLAN_EHT_MODE_MLMR`。

模式设置的入口是 `hdd_set_eht_mlo_mode`（`wlan_hdd_cfg80211.c:10934`），通过 vendor NL80211 命令调用：

```c
// QCOM: core/hdd/src/wlan_hdd_cfg80211.c:10934 — hdd_set_eht_mlo_mode
static int hdd_set_eht_mlo_mode(struct hdd_adapter *adapter,
                    const struct nlattr *attr)
{
    uint8_t cfg_val;
    struct hdd_context *hdd_ctx = WLAN_HDD_GET_CTX(adapter);
    enum wlan_eht_mode eht_mode;

    cfg_val = nla_get_u8(attr);
    eht_mode = hdd_get_cfg_eht_mode(cfg_val);

    if (eht_mode == WLAN_EHT_MODE_EMLSR &&
        adapter->device_mode == QDF_STA_MODE) {
        // 进入 eMLSR 前：启用 eMLSR 模式 + 关闭 BSS Color 碰撞检测
        hdd_test_config_emlsr_mode(hdd_ctx, true);
        ucfg_mlme_set_bss_color_collision_det_sta(hdd_ctx->psoc, false);
    }

    ucfg_mlme_set_eht_mode(hdd_ctx->psoc, eht_mode);
    return 0;
}

```

进入 eMLSR 模式时，除了设置模式标志，还需要关闭 BSS Color 碰撞检测——因为 eMLSR 模式下 STA 在多条链路间切换射频，可能错过其他 BSS 的 BSS Color 碰撞通知帧。`hdd_test_config_emlsr_mode`（`wlan_hdd_cfg80211.c:10793`）检查硬件是否支持 eMLSR（通过 `policy_mgr_is_hw_emlsr_capable`），只有硬件支持时才设置 `enable_emlsr_mode` 标志。

eMLSR 的 ENTER/EXIT 则通过 `hdd_test_config_emlsr_action_mode`（`wlan_hdd_cfg80211.c:10809`）控制。EXIT 时只激活一条链路（`num_links` 设为 1），ENTER 时激活所有 MLO 链路——这通过 `sme_activate_mlo_links`（`sme_api.c:15205`）下发到固件，固件据此决定射频模块在哪些链路间切换。这个切换过程可以用机场登机口变更来类比：STA 的射频模块在频率间切换，就像旅客在航站楼的登机口之间转移——登机口变更通知必须提前足够时间发出，因为旅客需要步行过去（信道切换的 PLL settling 和 AGC 校准），新登机口的地勤需要准备廊桥和安检设备（对端接收机调整天线和增益）。`emlsr_pad_delay` 字段编码的就是这个"提前通知时间"——STA 告诉 AP"我需要 N×32μs 来完成切换，请在这段时间内保持目标链路的接收就绪"。`emlsr_trans_delay` 则是 STA 自身的切换耗时，就像旅客从旧登机口走到新登机口的步行时间。

EML Capabilities 的 host 侧表示是 `struct wlan_mlme_eml_cap`（`wlan_mlme_public_struct.h:1587`）：

```c
// QCOM: components/mlme/dispatcher/inc/wlan_mlme_public_struct.h:1587 — struct wlan_mlme_eml_cap
struct wlan_mlme_eml_cap {
    uint16_t emlsr_supp:1,        // 支持 eMLSR（1 bit）
             emlsr_pad_delay:3,   // eMLSR Padding Delay（3 bit，指数编码：0/32/64/128/256μs）
             emlsr_trans_delay:3, // eMLSR Transition Delay（3 bit，指数编码：0/16/32/64/128/256μs）
             emlmr_supp:1,        // 支持 eMLMR（1 bit）
             emlmr_delay:3,       // eMLMR Delay（3 bit）
             trans_timeout:4,     // Transition Timeout（4 bit）
             reserved:1;
};

```

这 16 bit 与 IEEE 802.11be 的 EML Capabilities 子字段完全对齐。`emlsr_pad_delay` 是 eMLSR TX 路径的关键参数——它告诉对端"我切换链路时会发送这么长时间的 padding PPDU"。对端收到后，会在这段时间内保持接收状态，等待 padding 结束后的有效数据帧。

`emlmr_delay` 使用与 `emlsr_pad_delay` 完全相同的指数编码（QCOM host driver 定义于 `wlan_cmn_ieee80211.h:2483`：值 0=0μs, 1=32μs, 2=64μs, 3=128μs, 4=256μs，值 5+ reserved），但物理含义不同。eMLSR 的 padding delay 是**单射频模块**在链路间切换时填充空口时间——STA 只有一个射频，切换时必须暂停当前链路的收发，padding PPDU 是给对端的"占位符"。EMLMR 的 delay 是**多射频模块之间的协调时间窗口**——STA 有多个射频模块同时工作在不同链路上，但某些操作（如天线波束切换、功率放大器校准、或跨链路的时钟同步）需要所有射频模块协调完成。`emlmr_delay` 告诉对端"我需要 N×32μs 来完成多射频模块间的协调，请在这段时间内暂停向相关链路发送"。与 eMLSR 不同，EMLMR 的 delay 不一定伴随 padding PPDU——因为其他链路的射频模块仍在工作，STA 可以在非协调链路上继续收发，只在需要协调的链路上暂停。EML Capabilities 将 `emlmr_delay` 和 `emlsr_pad_delay` 设为两个独立字段而非复用同一个，原因也在于此——它们约束的物理过程不同，时序特征也不同。

固件侧把这三类协调拆成独立流程：波束切换重载天线权值、PA 校准跨射频模块同步增益表、跨链路时钟同步对齐各模块 TSF 计数器——`emlmr_delay` 的指数编码（`wlan_cmn_ieee80211.h:2483`）留出的正是这些流程的协调窗口。

## 2.3 MTK 实现：WTBL 硬件字段与 eMLSR 能力

MTK gen4m 的 eMLSR 支持主要体现在硬件层面。MT6653 芯片的 WTBL（Wireless Translation Lookaside Buffer）DW29 中定义了 6 个 1-bit 字段，分别为 3 条链路的 eMLSR 和 eMLMR 标志：

```c
// MTK gen4m: include/chips/coda/mt6653/wf_ds_lwtbl.h:474 — WTBL DW29 MLO Info
FIELD dispatch_policy0          :  2; //  1- 0 — TID 0 调度策略
FIELD dispatch_policy1          :  2; //  3- 2 — TID 1 调度策略
...
FIELD dispatch_policy7          :  2; // 15-14 — TID 7 调度策略
FIELD own_mld_id                :  6; // 21-16 — 所属 MLD ID
FIELD emlsr0                    :  1; // 22-22 — Link 0 的 eMLSR 标志
FIELD emlmr0                    :  1; // 23-23 — Link 0 的 eMLMR 标志
FIELD emlsr1                    :  1; // 24-24 — Link 1 的 eMLSR 标志
FIELD emlmr1                    :  1; // 25-25 — Link 1 的 eMLMR 标志
FIELD emlsr2                    :  1; // 26-26 — Link 2 的 eMLSR 标志
FIELD emlmr2                    :  1; // 27-27 — Link 2 的 eMLMR 标志
FIELD rsvd_28_28                :  1; // 28-28 — 保留
FIELD str_bitmap                :  3; // 31-29 — STR 位图（3 条链路各 1 bit）

```

`str_bitmap` 是 3-bit 位图，每个 bit 对应一条链路——置位表示该链路支持 STR（Simultaneous TX/RX）。固件在 TX 调度时检查这个位图：如果目标链路的 STR bit 为 1，固件可以同时在该链路和其他 STR 链路上发送；如果为 0，固件需要等待当前链路的 TX 完成后才能切换。

DW29 的 `dispatch_policy` 字段（8 个 2-bit 域，每个对应一个 TID）进一步细化了 per-TID 的调度策略——固件根据 TID 的 dispatch policy 决定该 TID 的帧走哪条链路、是否允许跨链路调度。DW30 的 `dispatch_order`（7 bit）和 `dispatch_ratio`（7 bit）定义了多条链路之间的调度顺序和比例，`link_mgf`（16 bit）是链路位图标记。

这些 WTBL 字段是固件侧 MLO 调度的"硬件语言"——`emlsr0/1/2`、`str_bitmap`、`dispatch_policy` 这些 bit 域不是给 host 看的状态报告，而是固件内部调度器直接读取的执行参数：固件每发一个帧，先查 dispatch_policy 决定 TID 走哪条链路，再查 str_bitmap 确认该链路是否允许并行发送，最后查 emlsr 标志决定是否需要等待 padding delay。仓库里每个包裹上贴着分拣条码——条码不是给发货方看的物流跟踪号，而是传送带上的光电传感器直接扫描执行的路由指令，传感器不需要理解条码的含义，只需要按条码信号把包裹拨到对应的通道。

MTK 的 host 侧 eMLSR 支持相对简单：`gl_qa_agent.h` 中的 `support_emlsr` 字段是一个 QA 测试标志，`gl_hook_api.c:4623` 在能力上报时检查这个标志，设置 `ext_cap.feature1` 的 bit 5。与 QCOM 的 `hdd_set_eht_mlo_mode` 相比，MTK 的模式管理更多由固件内部完成——host 侧只负责能力协商，不主动切换操作模式。

两家平台的差异反映了架构选择：QCOM 在 host 侧维护完整的操作模式状态机（`wlan_eht_mode` + `wlan_emlsr_action_mode`），host 可以主动控制 eMLSR 的 ENTER/EXIT；MTK 将模式管理下沉到固件，host 侧通过 WTBL 字段被动感知当前模式——固件根据硬件能力和对端能力自主决策何时进入/退出 eMLSR。这种分工差异用仓库场景来类比：QCOM 的模式管理就像总部办公室里的调度员，面前摆着多块监控屏幕（`wlan_eht_mode` 状态机），看到流量变化就拿起对讲机通知仓库切换航线（`sme_activate_mlo_links`）；MTK 的模式管理则把调度终端直接装在了仓库里（固件），仓库根据现场的货量和传送带状况自己决定什么时候换线，总部只需要在开张时告诉仓库"你有这几条航线可以用"。

QCOM host 侧操作模式状态机的另一个职责是管理 eMLSR 与并发连接的冲突。当 eMLSR STA 同时存在 SAP、P2P 或 NAN 等并发连接时，eMLSR 的射频共享特性会导致问题——STA 只有一个射频模块在多条链路间切换，但并发连接需要独占射频资源。`policy_mgr_handle_emlsr_sta_concurrency`（`wlan_policy_mgr_get_set_utils.c:5746`）处理这个冲突：

```c
// QCOM: components/cmn_services/policy_mgr/src/wlan_policy_mgr_get_set_utils.c:5746
// policy_mgr_handle_emlsr_sta_concurrency, eMLSR 并发管理
void policy_mgr_handle_emlsr_sta_concurrency(struct wlan_objmgr_psoc *psoc,
                         bool conc_con_coming_up,
                         bool emlsr_sta_coming_up)
{
    uint8_t num_mlo = 0;
    uint8_t mlo_vdev_lst[MAX_NUMBER_OF_CONC_CONNECTIONS] = {0};
    bool is_mlo_emlsr = false;

    is_mlo_emlsr = policy_mgr_is_mlo_in_mode_emlsr(psoc, mlo_vdev_lst,
                               &num_mlo);

    if (num_mlo < 2) return;  // 不足 2 条链路，无需处理

    if (!is_mlo_emlsr) return;  // 非 eMLSR 模式，无需处理

    if (conc_con_coming_up ||
        (emlsr_sta_coming_up &&
         policy_mgr_get_connection_count(psoc) > 2)) {
        // 场景 1：eMLSR STA 已存在，新连接（SAP/STA/NAN）即将建立
        // 场景 2：新 STA 以 eMLSR 模式连接，但已有其他并发连接
        // 操作：强制禁用一条 MLO 链路（固件决定禁用哪条）
        policy_mgr_mlo_sta_set_link(psoc, MLO_LINK_FORCE_REASON_CONNECT,
                        MLO_LINK_FORCE_MODE_INACTIVE_NUM,
                        num_mlo, mlo_vdev_lst);
        return;
    }

    if (!conc_con_coming_up && emlsr_sta_coming_up)
        // 并发连接断开 → 重新启用被禁链路
        policy_mgr_mlo_sta_set_link(psoc,
                        MLO_LINK_FORCE_REASON_DISCONNECT,
                        MLO_LINK_FORCE_MODE_NO_FORCE,
                        num_mlo, mlo_vdev_lst);
}
```

决策逻辑分三个分支：(1) 如果 eMLSR STA 已存在且有新并发连接即将建立（`conc_con_coming_up=true`），强制将 MLO 链路数减 1——`MLO_LINK_FORCE_MODE_INACTIVE_NUM` 告诉固件"从 N 条活跃链路中选择 N-1 条保留，禁用 1 条"，具体禁用哪条由固件根据链路质量和并发连接的频率需求决定；(2) 如果新 STA 以 eMLSR 模式连接但已有超过 2 个并发连接，同样强制减链路——因为 3 个以上的连接加上 eMLSR 的射频切换会让时序调度变得不可行；(3) 并发连接断开后，`MLO_LINK_FORCE_MODE_NO_FORCE` 释放强制约束，固件重新启用所有 MLO 链路，STA 恢复完整的 eMLSR 操作。这个机制确保 eMLSR 不会与并发连接争抢射频资源——相当于仓库在高峰期关闭一条航线，把射频模块（货车）集中给剩余航线和并发业务使用。

### 2.3.1 EML Capabilities 协商：AP 和 STA 如何达成一致

上面的代码展示了 host 侧如何管理 EML Capabilities 的数据结构，但这些能力参数不是 STA 单方面设定的——它们需要在 MLO 关联阶段通过 Multi-Link element 与 AP 协商。

协商过程发生在 Association Request/Response 交换中。STA 在 Association Request 的 Multi-Link element（Common Info）中携带自己的 EML Capabilities：`emlsr_supp=1` 表示支持 eMLSR，`emlsr_pad_delay=N` 表示 PHY 切换需要 N×32μs 的 padding 窗口，`trans_timeout=M` 表示模式切换必须在 M 个单位时间内完成。AP 在 Association Response 的 ML IE 中携带自己的 EML Capabilities——如果 AP 也声明 `emlsr_supp=1`，则 eMLSR 模式生效；如果 AP 的 EML Capabilities 中 `emlsr_supp=0`，STA 只能回退到 MLSR 或 MLMR。

协商结果的取值规则由 IEEE 802.11be 规定：`emlsr_pad_delay` 取双方中的较大值——因为 padding PPDU 是由 STA 发送给 AP 的，AP 需要足够的时间在目标链路上完成接收机准备，所以必须覆盖 AP 侧的切换延迟；如果 AP 的 PHY 切换比 STA 慢，STA 必须发送更长的 padding。`trans_timeout` 取双方中的较小值——因为 timeout 约束的是"切换必须多快完成"，较短的 timeout 意味着更严格的时序要求，双方都必须满足。

这两个参数的取值直接影响 TX 路径：padding delay 越长，每次链路切换浪费的空口时间越多；transition timeout 越短，固件切换链路时的调度窗口越紧——如果固件来不及在 timeout 内完成切换，对端可能认为链路异常并发起重连。

## 2.4 EML Operating Mode Notification：运行时模式切换

EML 操作模式不是只在连接建立时协商一次——IEEE 802.11be 定义了 EML Operating Mode Notification 帧（Action Frame，Category: Protected EHT，定义于 IEEE 802.11be D3.0 §9.6.35），允许 STA 或 AP 在运行时通知对端"我要切换操作模式了"。

这个帧的核心是 EML Operating Mode Information 字段（1 byte），各位的语义如下：

```
EML Operating Mode Information (1 byte):
  Bit[0]  EMLMR Mode         — 0=退出 EMLMR, 1=进入 EMLMR
  Bit[1]  EMLSR Mode         — 0=退出 eMLSR, 1=进入 eMLSR
  Bit[2]  EML Mode Change    — 0=无变化, 1=模式切换进行中
  Bit[3]  NSTR Link Pair Present — 1=后续有 NSTR 链路对信息
  Bit[4:6] Reserved
  Bit[7]  Link Bitmap Present — 1=后续有参与切换的链路位图
```

Bit[0] 和 Bit[1] 的组合决定了目标操作模式：`01`（Bit[0]=1, Bit[1]=0）表示切换到 EMLMR，`10`（Bit[0]=0, Bit[1]=1）表示切换到 eMLSR，`00` 表示退出所有 EML 模式回到 SLO/MLSR。Bit[2] 是切换状态指示——Bit[2]=1 相当于仓库门口亮起黄灯"正在换线，暂停发货"，Bit[2]=0 相当于绿灯"换线完成，恢复正常"。这个双帧确认模式（Bit[2]=1 通知"正在切换"→ 切换完成 → Bit[2]=0 通知"切换完成"）与 TCP 的三次握手在状态同步上遵循同一模式：发送方先通知意图，接收方确认收到，双方在显式的状态转换点上达成一致。区别在于 TCP 三次握手发生在连接建立阶段，EML 通知发生在运行时模式切换——后者对实时性要求更高，所以只有两帧而非三帧。接收方看到 Bit[2]=1 后，暂停向 Link Bitmap 中标记的链路发送数据帧，直到收到 Bit[2]=0 的后续通知或 Transition Timeout 到期。

如果 Bit[3]=1，后续跟一个变长的 NSTR Link Pair 字段——每对 NSTR 链路用 2 byte 编码（Link ID A + Link ID B），表示这两条链路不能同时收发。固件看到 NSTR Link Pair 后，会在 TX 调度器中将这两条链路标记为互斥——同一时刻只能在其中一条上发送。如果 Bit[7]=1，后续跟一个 2-byte Link Bitmap，每个 bit 对应一条链路（bit 0=Link 0，bit 1=Link 1，...），置位表示该链路参与本次模式切换。

切换过程的时序要求由 EML Capabilities 中的 Transition Timeout 决定——通知方发送 EML Operating Mode Notification 后，必须在 Transition Timeout 时间内完成模式切换；接收方在此期间不向正在切换的链路发送数据帧，避免帧丢失。

Transition Timeout 的 4-bit 编码（0-15）对应的时序约束是：如果通知方在 timeout 内未完成切换，接收方可以恢复向原链路发送，但通知方可能因此丢帧——这就像快递公司发了"路线切换通知"但没在约定时间完成搬迁，对方的包裹就可能发到已经搬空的旧仓库。固件侧的处理：timeout 到期后，TX 调度器解除对正在切换链路的暂停，恢复向原链路提交 TX 描述符；如果切换期间有帧因链路不可用而发送失败，对端的 Block ACK 机制会检测到缺失，STA 在恢复后的链路上通过常规 BA 重传流程补发——不需要额外的跨链路迁移协议。

STA 和 AP 都可以发起 EML Operating Mode Notification。STA 发起的典型场景：检测到低流量时段时退出 eMLSR 进入 SLO 以节省功耗（不需要在多条链路间切换射频），或者检测到高流量突发时从 SLO 进入 eMLSR 以利用多链路带宽。AP 发起的典型场景：网络拥塞时将某些 STA 从 eMLSR 切换到 SLO 以释放信道资源，或者检测到 STA 的链路质量恶化时切换到另一条链路。QCOM 的 `hdd_test_config_emlsr_action_mode` 是 STA 侧主动发起切换的入口——wpa_supplicant 通过 vendor NL80211 命令调用它，host 侧设置模式标志后通过 `sme_activate_mlo_links`（`sme_api.c:15205`）通知固件激活/去激活链路。固件收到链路激活/去激活指令后，在实际射频切换前构造 EML Operating Mode Notification 帧（Bit[2]=1，EML Mode Change=1）发送给 AP，通知 AP"正在切换，暂停向相关链路发送"；射频切换完成后，固件发送 Bit[2]=0 的后续通知，AP 恢复向新链路发送。这个通知帧的发送由固件而非 host 负责——因为射频切换的时序精度要求在微秒级，host 的上下文切换延迟无法满足。

对 TX 路径的影响：当 STA 发送 EML Operating Mode Notification 退出 eMLSR（回到 MLMR 或 SLO）时，固件需要处理正在 eMLSR 链路上排队的 TX 描述符。切换期间固件的 TX 调度器会暂停向正在切换的链路提交新描述符——已经在 PHY 层排队的帧无法在当前链路上完成发送（因为射频即将切走），固件将这些描述符标记为"需要重传"，等切换完成后在目标链路上重新提交。切换完成前到达的新 MSDU 在 host 侧或固件队列中等待，直到目标链路的射频就绪后才提交——这段等待时间就是 eMLSR 切换的实际延迟代价。

目标链路就绪后，固件将标记为 need_retransmit 的描述符在新链路上重新提交。如果新链路的 Block ACK session 已建立（T2LM 预配置确保了这一点——映射在切换前已下发固件，BA session 在链路关联时就已建立），对端通过 BA bitmap 中的序列号缺失检测到重传帧并正常确认——恢复路径完全复用现有的 802.11 BA 重传机制，不需要额外的跨链路迁移协议。如果新链路的 BA session 尚未建立（极端场景：链路刚从 eMLSR 退出，BA 协商还在进行中），固件将这些帧暂存在 per-link 队列中等待 BA session 建立后再提交——这段时间内对端会通过 BA 窗口超时检测到缺失并触发 BAR（Block ACK Request）请求，STA 回复 BAR 后 BA session 重建，暂存帧随后发送。QCOM 的 `sme_activate_mlo_links` 在模式切换时直接告诉固件"哪些链路是活跃的"，固件据此重新分配 TX 描述符；MTK 的固件则通过 WTBL 的 emlsr/emlmr 字段自动感知模式变化。

## 2.5 各模式对 TX 路径的实际影响

把四种模式对 TX 路径的约束放在一起比较：

| 模式          | 同时发链路数    | 切换延迟                                    | TX 描述符分配                          | 固件复杂度                 |
| ------------- | --------------- | ------------------------------------------- | -------------------------------------- | -------------------------- |
| **SLO**       | 1               | 无切换                                      | 单链路独立池                           | 最低                       |
| **MLSR**      | 1               | Transition Delay（~0ms）                    | 单链路独立池                           | 低                         |
| **eMLSR**     | 1               | Padding Delay（32μs × N）+ Transition Delay | 单链路独立池                           | 中（需 padding PPDU 生成） |
| **NSTR MLMR** | 1（链路间交替） | 很低（无需 padding）                        | 可共享池                               | 中                         |
| **STR MLMR**  | 多条（全同时）  | 无切换                                      | 共享池（QCOM `dp_mlo_tx_pool_map_be`） | 高（多链路并发调度）       |

下图从射频模块和链路的角度可视化了四种模式的区别——SLO 只有一条链路，MLSR 和 eMLSR 共享一个射频模块在多条链路间切换（区别在于 eMLSR 需要 padding delay），STR MLMR 则为每条链路配备独立射频模块实现真正的并行发送：

![四种 MLO 操作模式对比：SLO、MLSR、eMLSR、STR MLMR 的射频配置与切换特性](assets/07f-%E6%95%B0%E6%8D%AE%E5%B8%A7%E5%8F%91%E9%80%81%E8%BF%9B%E9%98%B6%EF%BC%9AMLO-TX-%E2%80%94-%E9%93%BE%E8%B7%AF%E9%80%89%E6%8B%A9%E4%B8%8E%E6%93%8D%E4%BD%9C%E6%A8%A1%E5%BC%8F/07f-mlo-operation-modes.svg)

STR MLMR 让两条链路同时发送，吞吐量接近翻倍。但硬件要求最高：每条链路需要独立的射频模块和天线链路。eMLSR 用一个射频模块覆盖多条链路，通过快速切换模拟"伪同时"——就像一个分拣员管两条传送带，换线前得先放几个空箱子占住节奏。固件发送 EML Operating Mode Notification 就像发出调度窗口变更通知：告诉对端"我要换登机口了，请在目标链路上等我"。代价是 padding delay 吞掉了部分带宽。MLSR 最简单，切换时几乎无额外延迟，但同一时刻只有一条链路活跃。

功耗差异是这四种模式的另一个关键权衡维度。STR 模式下两条链路的射频模块同时工作——射频前端（PA、LNA、混频器）和基带处理器都在持续运行，功耗接近单链路的两倍。eMLSR 只有一个射频模块在链路间切换，射频前端功耗接近单链路，加上 padding PPDU 的发射功耗和切换时的 PLL/AGC 短暂能耗——综合估算比 STR 省电 30-50%（取决于切换频率和 padding delay 配置：切换频率低、padding delay 短时省电比例更高）。MLSR 的功耗与 eMLSR 相当（同样是单射频），但切换延迟更低意味着更少的 padding 开销。SLO 最省电——无 MLO 切换开销，射频模块只在单一信道上工作——但也失去了 MLO 的带宽增益。正因如此，Wi-Fi Aware、Miracast 等高吞吐场景需要 STR，普通网页浏览和后台同步场景 eMLSR 就够了：省下来的 30-50% 功耗对移动终端的续航影响显著。

这四种模式不是 STA 可以单方面选择的——它们需要在关联时通过 Multi-Link element 中的 EML Capabilities 和对端协商。STA 在 ML IE 中宣告自己支持 eMLSR（`emlsr_supp=1`）和对应的 padding delay，AP 据此决定是否允许 eMLSR 操作。如果 AP 不支持 eMLSR，STA 只能回退到 MLSR 或 MLMR。

回到 TX 路径：操作模式决定了固件的"调度自由度"。STR 模式下固件可以同时向多条链路提交描述符——这就是 QCOM `dp_mlo_tx_pool_map_be` 的共享池设计的意义：所有链路的描述符从同一个池分配，固件不需要为每条链路维护独立的内存管理。eMLSR 模式下固件只能向一条链路提交描述符，切换时需要等待 padding delay——这限制了突发流量的处理能力。MLSR 模式下固件的决策最简单：查 T2LM 表，找到目标链路，发送，不需要考虑并发。

EMLMR 与 STR 同属多射频模式，但并发调度语义不同：STR 下每条链路射频独立，固件按 WTBL 的 `dispatch_order`（链路优先级顺序）和 `dispatch_ratio`（流量分配比例）无中断地并行派发帧；EMLMR 的多射频虽同时工作，但波束切换、PA 校准、跨链路时钟同步需要协调窗口——`emlmr_delay` 编码的这段时间内，固件须暂停相关链路的派发，由 `dispatch_order` 决定先恢复哪条链路。

理解了操作模式，才能回答"一个帧走哪条链路"这个问题的完整答案：不仅取决于 T2LM 映射（下一节详述），还取决于当前的操作模式——在 STR 模式下，固件可以在 T2LM 允许的多条链路中选择信道质量最好的一条同时发送；在 eMLSR 模式下，固件只能在当前活跃链路上发送，如果 T2LM 要求走另一条链路，必须先完成切换。操作模式回答了"固件能在几条链路上发"，但"具体每个帧走哪条链路"还需要 host 和固件之间的一套协商协议——TID-to-Link Mapping（T2LM）。

T2LM 与操作模式的交互在 eMLSR 场景下尤其复杂。假设 T2LM 将 TID 6（语音）映射到 Link 1（5GHz），但 STA 当前活跃在 Link 0（2.4GHz）的 eMLSR 模式下——固件面临一个延迟 vs. 约束的权衡：等待切换到 Link 1 再发送遵守了 T2LM 约束但增加了语音帧的延迟；在 Link 0 上发送保证了延迟但违反了 T2LM 约束（语音帧走了 2.4GHz，可能遭遇更高干扰和延迟抖动）。

实际实现中，固件通常采用 TID 优先级分层策略：对延迟敏感的 TID（TID 6/7 语音/视频）优先保证延迟，在当前活跃链路上发送；对非延迟敏感的 TID（TID 0/1 后台）遵守 T2LM 约束，等待切换到目标链路。这种分层策略本质上是 eMLSR 的"单射频约束"与 T2LM 的"链路偏好"之间的妥协——固件在每包层面做实时权衡，而不是机械地执行某一张静态表。这正是 §3 中"固件根据实时信道质量做最终决策"在 eMLSR 场景下的具体体现。

一个更微妙的并发场景是：T2LM Request 到达时，STA 正处于 eMLSR ENTER 或 EXIT 的过渡期间（EML Operating Mode Notification 的 Bit[2] EML Mode Change=1）。此时链路集合本身正在变化——新增链路尚未就绪、被移除链路的 TX 队列正在排空——T2LM 映射的目标链路可能在过渡完成后不再有效。QCOM 的处理策略是将 T2LM 事件排队：TTLM 状态机在检测到 eMLSR 模式切换进行中时暂停状态推进（不处理新的 Request/Response），等模式切换完成（收到 Bit[2]=0 的通知或 Transition Timeout 到期）后再恢复处理排队的 T2LM 事件。这个设计避免了"映射刚生效就因链路集合变化而失效"的竞态。MTK 的处理方式不同：固件内部的 WTBL 更新是原子操作——模式切换和 T2LM 更新都通过 WTBL 写入执行，写入的串行化天然保证了两者不会冲突。如果 T2LM 更新到达时 WTBL 正在被模式切换占用，UniCmd 队列会将 T2LM 更新排队等待前一个 WTBL 写入完成后再执行。

模式已定，下一步是链路选择。

---

# 3 MLO TX 的核心问题：一个帧，多条链路，选哪条？

WiFi 7 的 MLO（Multi-Link Operation）在连接建立上是一次性同时建立多条链路（连接篇（五）已详述），但在数据面上引发了一个全新的问题：

**发一个帧时，走 2.4GHz 链路还是 5GHz 链路？**

这不是一个简单的"二选一"——你的手机上同时跑着语音通话（TID 6）、视频流（TID 5）和后台同步（TID 1），它们对延迟和带宽的需求完全不同。语音流量需要低延迟，适合走干扰少的 5GHz；后台下载不介意延迟，用 2.4GHz 还能省电。IEEE 802.11be 为此定义了 **TID-to-Link Mapping（T2LM）**——一个将 8 个 TID 分配到不同链路的映射表。

默认映射（Default Mapping Mode）下，所有 TID 走所有链路——相当于没有 MLO 链路选择。AP 和 STA 可以通过 T2LM Action 帧协商定制映射——例如 TID 6,7（语音、视频）只走 5GHz，TID 0,1,2（BE、BK）只走 2.4GHz。

T2LM 的协议载体是 TID-to-Link Mapping element（Element ID 255 + Extension Element ID 9，定义于 IEEE 802.11be D3.0 Figure 9-1002ao）。IE 结构如下：

```
TID-to-Link Mapping element:
  Element ID (1 byte): 255 (Extension)
  Length (1 byte)
  Extension ID (1 byte): 9
  Control (1 byte):
    Bit[0:1]  Direction        — 0=Downlink, 1=Uplink, 2=Both, 3=reserved
    Bit[2]    Default Link Mapping — 1=所有 TID 走所有链路（忽略后续字段）
    Bit[3]    Mapping Switch Time Present
    Bit[4]    Expected Duration Present
    Bit[5]    Link Mapping Size — 0=2 octets per TID, 1=1 octet per TID
    Bit[6:7]  Reserved
  Optional fields (depending on Control bits):
    Link Mapping Presence Indicator (1 byte, if Default=0):
      Bit[n]=1 表示 TID n 有独立的链路映射
    Mapping Switch Time (2 bytes, if Bit[3]=1):
      TSF 的 bit[10:25]，单位 TU（1.024ms）
    Expected Duration (3 bytes, if Bit[4]=1):
      映射有效时长，单位 TU
    Per TID Link Mapping (variable, for each TID where Presence bit=1):
      1 byte (if Link Mapping Size=1): bit 0-7 对应 link ID 0-7（8 条链路）
      2 bytes (if Link Mapping Size=0): bit 0-14 对应 link ID 0-14（15 条链路）
```

以上字段逐一对应 IEEE 802.11be D3.0 Figure 9-1002ao 的定义：Element ID、Length、Element ID Extension 三字段见 §9.4.2.1；Control 字段（1 或 2 octet）的位域依次为 Direction（B0-B1，2 bit：0=DL、1=UL、2=Both、3=reserved）、Default Link Mapping（B2）、Mapping Switch Time Present（B3）、Expected Duration Present（B4）、Link Mapping Size（B5，0=2 octet/1=1 octet）、Reserved（B6-B7）、Link Mapping Presence Bitmap（B8-B15，仅 Default=0 时出现）。后续字段中，Mapping Switch Time（2 octet）取 TSF bit[10:25]、Expected Duration（3 octet）单位 TU；Link Mapping Of TID n 的位宽由 Link Mapping Size 决定——1 octet 时 bit 0-7 对应 link ID 0-7（8 条链路），2 octet 时 bit 0-14 对应 link ID 0-14（15 条链路）。

Control 字段的 6 个 bit 域是整个 T2LM IE 的调度核心。Direction 决定映射是上行、下行还是双向；Default Link Mapping 置 1 时，后续所有可选字段省略，表示"所有 TID 走所有链路"——这是回退到无 MLO 链路选择的默认状态。Link Mapping Presence Indicator 是一个 8-bit 位图，每个 bit 对应一个 TID，只有置位的 TID 才有后续的 Per TID Link Mapping 字段——这意味着不需要为所有 8 个 TID 都指定映射，只修改需要调整的 TID 即可。MTK 的 `t2lmParseT2LMIE`（`t2lm.c:262`）逐字段解析这个 IE，将每个 TID 的链路位图翻译成 per-link 的 TID bitmap 存入 STA Record。

T2LM 协商完成后，host 侧（或固件）就知道了"这批包裹该走哪条传送带"。但配送网点面对的问题不止于此——传送带的选择还取决于传送带本身的状态。T2LM 协商出来的静态映射相当于调度中心贴在墙上的路线表：语音件走 5 号传送带，普通件走 2 号传送带。但路线表不会告诉你 5 号传送带此刻是否堵了、2 号传送带是否正在检修。实际每个包的发送链路还需要综合考虑该链路的信道质量、拥塞程度和 TX ring 水位——而这些实时信息只有固件侧的"现场调度员"能看到。

这就引出了 MLO TX 最关键的架构决策：

**Link Selection 由谁做？Host 还是 Firmware？**

QCOM 的答案：**Firmware**。Host 只负责把 T2LM 发给固件，固件根据 TID 映射 + 实时链路状态决定每个包的发送链路。MTK 的答案也是 **Firmware**——但原因不同：MTK gen4m 是 Full-MAC 驱动，数据面的调度几乎完全由固件掌控，MLO 链路选择只是固件众多职责中的一个。两家殊途同归：实时链路信息（SNR、CCA、TX 队列深度）只有固件可见，host 做决策会因为信息延迟而做出次优选择（比如把一个语音帧发到了已经拥堵的链路）。

T2LM 的协商通过 Protected EHT Action Frame（Category: Protected EHT）完成，支持三种 Action：Request（0）、Response（1）和 Teardown（2）。STA 发起协商时，发送 TID2LINK_REQUEST 帧（携带期望的 T2LM IE），AP 收到后回复 TID2LINK_RESPONSE 帧（携带确认或修改后的 T2LM IE）。以 MTK 的实现为例，`t2lmProcessAction`（`t2lm.c:851`）收到 Request 后调用 `t2lmProcessReq` 解析 IE，然后立即调用 `t2lmSend(prAdapter, TID2LINK_RESPONSE, ...)` 回复 Response。STA 收到 Response 后，`t2lmProcessRsp` 解析确认的映射，FSM 从 REQ_PENDING 转入 REQ_SWITCH 状态——等待 Mapping Switch Time 到达后正式生效。整个交换就像快递公司之间的协议谈判：一方提出"从下周一开始，语音件走 5 号专线"，另一方确认后，双方约定一个切换时间点，在那个时间点同时执行新路线。

协商失败时没有重试机制。QCOM 的实现中，TTLM 状态机用一个 5 秒超时定时器（`TTLM_REQUEST_TIMEOUT = 5000ms`，`wlan_mlo_t2lm.c:40`）守护每 Request/Response 交换——如果 AP 在 5 秒内未回复 Response，`ttlm_req_timeout_cb`（`wlan_mlo_t2lm.c:93`）触发 `WLAN_TTLM_SM_EV_TTLM_REQ_TIMEOUT` 事件，`ttlm_handle_timer_timeout`（`wlan_mlo_t2lm.c:774`）清除正在进行的协商状态（`wlan_t2lm_clear_ongoing_negotiation`），FSM 回到 `WLAN_TTLM_S_NEGOTIATED` 空闲态。AP 回复 DENIED 响应时走同样的路径——清除协商状态、回到空闲态、通过 `wlan_mlo_send_ttlm_complete(vdev, ml_peer, false)` 通知上层协商失败。

整个代码库中不存在任何自动重试逻辑——grep "retry" 和 "retransmit" 在 `wlan_mlo_t2lm.c` 和 `wlan_t2lm_api.c` 中返回零结果。这意味着 T2LM 协商的恢复完全依赖上层（Framework 或 wpa_supplicant）重新发起，而非驱动内部自动重试。协商失败时，固件侧的 `established_t2lm` 保持不变——继续使用上一次生效的映射（如果存在）或默认映射（所有 TID 走所有链路），不会因为一次失败的协商而清除已有的映射状态。这个"协商归协商、生效归生效"的隔离设计确保了数据面不受控制面失败的影响。

这个设计是合理的——T2LM 映射变更影响整个 MLO 链路的流量分配，自动重试可能导致映射在"生效-回退-再生效"之间振荡，对实时流量（语音、视频）造成不可预测的延迟抖动。5 秒的固定超时而非指数退避，是因为这里不存在重试逻辑——超时只是"等多久就放弃"的阈值，不是"第 N 次重试等多久"。AP 处理 T2LM Request 的典型耗时在百毫秒量级（解析 IE + 内部链路评估 + 构造 Response），5 秒的裕量覆盖了 AP 负载高峰或信道繁忙的极端场景，同时不会让 STA 等待过久影响上层应用的超时逻辑。指数退避适用于有重试的场景（如 TCP SYN 重传），这里没有重试，退避无从谈起。

映射生效后的生命周期由两个定时器管理。`WLAN_MAP_SWITCH_TIMER_EXPIRED` 事件触发时，`wlan_mlo_t2lm_handle_mapping_switch_time_expiry`（`wlan_mlo_t2lm.c:2406`）将"待生效"映射（upcoming_t2lm）提升为"已生效"映射（established_t2lm），清空 upcoming 槽位。`WLAN_EXPECTED_DUR_EXPIRED` 事件触发时，`wlan_mlo_t2lm_handle_expected_duration_expiry`（`wlan_mlo_t2lm.c:2442`）执行回退：如果还有新的映射等待切换（upcoming_t2lm 的 `mapping_switch_time_present` 为真），则提升该映射；否则回退到默认映射——将 established_t2lm 重置为 `default_link_mapping=1`（所有 TID 走所有链路），调用 `wlan_clear_peer_level_tid_to_link_mapping` 清除 per-peer 的 TID-to-Link 映射。这个"有后续映射就切换，没有就回退"的设计确保了映射不会在 Expected Duration 到期后悬空——固件总有一个明确的 T2LM 状态可以参照。

竞态风险在于：AP 在 Expected Duration 到期前一瞬间下发新 T2LM Request 时，Expected Duration 事件和新 Request 的处理会不会交错执行，导致映射在"回退到默认"和"提升新映射"之间产生瞬态不一致？源码的处理是：`wlan_mlo_vdev_tid_to_link_map_event`（`wlan_mlo_t2lm.c:2475`）的整个事件处理被 `t2lm_dev_lock` 互斥锁保护——Expected Duration 到期事件、Mapping Switch Time 到期事件和新 T2LM Request 的处理都在同一把锁内串行执行。如果 Expected Duration 事件先拿到锁，它在锁内检查 `upcoming_t2lm.mapping_switch_time_present`：如果新 Request 已经在锁外写入了 upcoming_t2lm（但尚未获取锁），Expected Duration 处理会看到这个 upcoming 映射并直接提升它，而不是回退到默认映射——两次映射切换被压缩为一次原子操作，中间不存在"回退到默认映射"的瞬态。如果新 Request 先拿到锁，它将映射写入 upcoming_t2lm 并启动 Mapping Switch Time 定时器，Expected Duration 事件随后拿到锁时发现 upcoming 已存在，直接提升。无论哪种顺序，established_t2lm 的状态转换都是原子的——不会出现固件在两映射之间短暂使用默认映射的窗口。

这与 QCOM 在 eMLSR 模式切换时暂停 T2LM 处理的策略（§2.4 已述）一脉相承：任何可能改变链路集合或映射状态的操作，都必须在互斥保护下完成。

一句话：t2lm_dev_lock 把竞态压缩成了原子操作。T2LM 的 TID→链路映射与 LTE 载波聚合（Carrier Aggregation）中 MAC 层将逻辑信道映射到 Component Carrier 的调度决策本质相同——两者都是将上层流量分类映射到物理资源，区别在于 LTE 的资源分配由基站集中调度，WiFi 的 T2LM 是 AP-STA 双方协商后由固件分布式执行。

整个 T2LM 状态机的生命周期管理可以类比为会议室预订系统：Mapping Switch Time 是预约的开始时间——参会方在预订确认后，需要等到约定时刻才能正式使用会议室（映射生效），提前到达只能在门外等候；Expected Duration 是预约的有效时长——会议结束时间一到，会议室自动释放（映射回退默认），除非有人提前续订了下一场（upcoming_t2lm 存在）；5 秒超时定时器则是预订确认的截止期限——发出预约申请后如果 5 秒内没收到对方确认，预订自动取消，交由上层重新发起。

映射切换的瞬间，已在 TX ring 中排队的包怎么办？答案是"新旧并存、各自安好"——`wlan_mlo_dev_t2lm_notify_link_update`（`wlan_mlo_t2lm.c:2529`）只做通知，不做排空。已经在 TX 描述符队列中的包按旧映射的链路完成发送，不需要回退或迁移；切换后到达的新 MSDU 才由固件按新映射选择链路。如果旧映射的链路在切换后不再承载某个 TID，而该 TID 的帧恰好还在旧链路的 TX ring 中，这些帧仍然会发送——对端的 Block ACK 机制会正常确认。万一旧链路上有帧丢失（比如切换过程中信道条件变化导致发送失败），BA 的常规重传流程会在新映射允许的链路上补发——不需要额外的"跨链路迁移"协议，现有的 802.11 BA 重传机制天然支持帧恢复。

这个设计避免了"切换前等排空"带来的延迟——如果固件必须等当前 TX ring 全部排空才能切换，eMLSR 的 padding delay 和 transition delay 之上还要加上 TX ring drain time，切换延迟会从百微秒级膨胀到毫秒级。

但"BA 会正常确认"这句背后有一个隐含前提值得展开：在 802.11be MLO 中，每条链路是独立的 802.11 关联，拥有独立的 BA session 和独立的序列号空间——Link 0 上的 BA session A 和 Link 1 上的 BA session B 各自维护独立的 BA scoreboard（接收窗口的起始序列号、bitmap 和窗口大小）。这意味着 T2LM 将 TID 0 从 Link 0 重映射到 Link 1 后，帧到达 Link 1 时使用的是 Link 1 自己的 BA session——不需要跨链路同步 BA scoreboard，也不需要通知对端"这个 TID 换了一条链路"。对端在 Link 1 上收到帧后，按 Link 1 的 BA 窗口正常确认，缺失的序列号由 Link 1 的常规重传流程补发。QCOM 和 MTK 都选择 per-link BA 而非 shared BA——per-link BA 的序列号空间独立，避免了跨链路序列号协调的复杂性（如果两条链路共享一个 BA scoreboard，固件需要在帧从 Link 0 切到 Link 1 时同步 scoreboard 状态，任何同步延迟都可能导致对端误判丢帧触发不必要的 BAR 请求）。

per-link BA 的代价是：当 TID 从一条链路切到另一条时，旧链路 BA 窗口末尾的未确认帧需要通过旧链路的重传流程在旧链路上补发——不能直接在新链路上补，因为新链路的 BA session 的序列号空间与旧链路不连续。实际影响很小：T2LM 映射切换频率低（秒级），旧链路 BA 窗口通常在切换前已被清空。

下图展示了 T2LM 协商的完整时序——从 STA 发起 Request、AP 回复 Response，到 Mapping Switch Time 等待期、映射生效、以及 Expected Duration 到期回退的全过程：

![T2LM 协商时序：Request/Response 交换 → Switch Time 等待 → 映射生效下发固件 → Duration 到期回退](assets/07f-%E6%95%B0%E6%8D%AE%E5%B8%A7%E5%8F%91%E9%80%81%E8%BF%9B%E9%98%B6%EF%BC%9AMLO-TX-%E2%80%94-%E9%93%BE%E8%B7%AF%E9%80%89%E6%8B%A9%E4%B8%8E%E6%93%8D%E4%BD%9C%E6%A8%A1%E5%BC%8F/07f-t2lm-negotiation.svg)

T2LM 的协议骨架已经搭好：Request/Response 协商建立映射，Mapping Switch Time 定时切换，Expected Duration 到期回退——三层时序环环相扣。但协议只是蓝图，MTK 和 QCOM 各自怎么把这套协议翻译成 host 侧的 FSM 和 WMI/UniCmd 命令、固件又怎么在逐包层面执行映射结果，是下面两节要回答的问题。

协议讲完，来看 MTK 实现。

---

# 4 MTK 的 MLO TX：host 还是固件选链路？

MTK gen4m 是 Full-MAC 驱动：MAC 层功能（帧封装、ACK、重传、BA、速率控制）全部在固件中实现。MLO 链路选择也不例外——固件负责一切，host 的职责仅限于两项：T2LM 协商和映射下发。

## 4.1 T2LM 协商

MTK 的 T2LM 协商实现在 `mgmt/t2lm.c` 中，通过一个六状态双轨 FSM 管理——AP 发起的 ADV 轨道和 STA 发起的 REQ 轨道共享同一组状态机函数，但触发路径不同：

```
STA 发起（REQ 轨道）：
  IDLE → REQ_PENDING → REQ_SWITCH → REQ_DURATION → IDLE

AP 发起（ADV 轨道）：
  IDLE → ADV_SWITCH → ADV_DURATION → IDLE

```

- **`t2lmParseT2LMIE`**（`t2lm.c:262`）：解析收到的 T2LM IE（来自 Beacon、Probe Response 或 T2LM Action 帧），提取每个 link 上的 TID bitmap，填充 `ucPendingULTidBitmap` / `ucPendingDLTidBitmap`
- **`t2lmFsmSteps`**（`t2lm.c:82`）：FSM 核心，根据当前状态推进。以 REQ 轨道为例：IDLE 时收到 STA 发起的 T2LM Request 进入 REQ_PENDING（调用 `t2lmMldStaRecUpdate` 更新 pending bitmap，`fgSendcmd=FALSE` 仅更新不下发）；对端响应后进入 REQ_SWITCH（启动 switch delay 定时器，等待 AP 指定的 TSF 切换时间）；定时器到期进入 REQ_DURATION（调用 `t2lmMldStaRecUpdate` 将 pending bitmap 写入生效 bitmap 并下发固件，启动 expected duration 定时器）；duration 到期回退 IDLE
  - ADV 轨道逻辑类似，由 AP 侧的 T2LM IE 中的 Mapping Switch Time 触发。超时通过 `t2lmTimeout`（`t2lm.c:481`）回退到 IDLE
- **`t2lmSend`**（`t2lm.c:638`）：构造 T2LM Action 帧（Request 和 Response），通过 `nicTxEnqueueMsdu` 发送。Teardown 分支当前返回失败未实现

`t2lmMldStaRecUpdate`（`t2lm.c:998`）是 FSM 与固件之间的桥梁——它遍历 MLD STA Record 下的所有 STA_RECORD，根据 `ucDirection`（DL/UL/Both）将 `ucPendingDLTidBitmap` / `ucPendingULTidBitmap` 复制到生效 bitmap，然后调用 `mldUpdateTidBitmap` 通过 UniCmd 下发固件。这个函数在三个时机被调用：REQ_PENDING 时 `fgSendcmd=FALSE`（仅更新 pending bitmap 不下发固件），REQ_DURATION 和 ADV_DURATION 时 `fgSendcmd=TRUE`（更新生效 bitmap + 下发固件）。

整个双轨 FSM 就像寄件方和收件方各自发起的物流调度单：STA 发起的 REQ 轨道相当于寄件人填写"加急配送申请"，等快递公司确认后按指定时间生效；AP 发起的 ADV 轨道相当于收件人所在的中转站主动通知"从明天起走新路线"，STA 只需在切换时间到达时执行。MTK T2LM 的双轨 FSM 设计——REQ 轨道（STA 发起）和 ADV 轨道（AP 发起）用同一组 `t2lmFsmSteps` 函数处理——与 USB 协议栈中 Host 和 Device 共享同一套枚举状态机是同一思路：双轨不双码，靠触发路径区分行为而非复制状态机代码。MTK 的 `fgSendcmd` 布尔标志（TRUE=下发固件、FALSE=仅更新 pending）相当于 USB 状态机的 side-effect guard——同一状态、同一转换函数、不同的外部操作。

## 4.2 映射下发固件

```c
// MTK gen4m: mgmt/mlo.c:4198 — mldUpdateTidBitmap, 向固件下发 TID→Link 映射
mldUpdateTidBitmap(...) {
    // 遍历 MLD STA Record 下的所有 STA_RECORD
    for each sta_rec in mld_sta_rec->rStarecList {
        // 打包 ucBssIndex, u2WlanIdx, ucULTidBitmap
        // 构造 UNI_CMD_STAREC_TAG_T2LM 标签
        wlanSendSetQueryUniCmd(UNI_CMD_ID_STAREC_INFO, ...);
    }
}
```

`ucULTidBitmap` 是一个 8-bit 位图，每个 bit 对应一个 TID——bit 置位表示该 TID 的数据帧**可以**走这条链路。这个位图就是 T2LM 协商的结果——T2LM IE 中的 "TID X → Link Y" 映射翻译为 "这条链路的 TID 位图中 bit X 为 1"。

固件收到后，每收到一个 host 发来的 MSDU，从帧头提取 TID，查该 peer 的各链路 TID bitmap，选择 bit 为 1 且当前信道质量最好的链路发送。这个查表过程就像仓库里每条传送带入口贴着一张准入清单——传送带传感器（固件）扫一眼包裹上的 TID 条码，对照清单上的 bit 位：bit 为 1 就放行，bit 为 0 就转到下一条传送带看能不能进。如果多条传送带都允许这个 TID 进入，传感器选当前运转最顺畅的那条——这就是固件结合实时信道质量做最终决策的微观过程。与 QCOM 的"集中仓"（所有链路共享描述符池，固件拿到件再选航线）不同，MTK 的 per-link TID bitmap 相当于"分拨仓"模式——每条航线有独立的准入清单，包裹进仓前已经按清单标好了目的地，传送带按标签执行。

但 per-link TID bitmap 只回答了"哪些链路可以走"，没回答"走的时候按什么规则选"。答案在 WTBL 的 DW29 和 DW30 中。DW29 定义了 8 个 2-bit 的 `dispatch_policy` 字段（每个 TID 一个），DW30 定义了 `dispatch_order`（7 bit）和 `dispatch_ratio`（7 bit），以及 `link_mgf`（16 bit 链路位图）。这三个字段共同构成了固件链路调度的执行骨架：`dispatch_policy` 告诉固件"这个 TID 的帧按什么规则选链路"——2 bit 可以编码四种策略（例如固定链路、最优链路、负载均衡、跟随默认），host 写入 T2LM 后固件将其翻译为对应的 policy 值；`dispatch_order` 用 7 bit 编码链路的优先级顺序，固件在多条链路都可用时按此顺序依次尝试；`dispatch_ratio` 用 7 bit 编码链路间的流量分配比例，固件按此比例在链路间轮转分发帧。`link_mgf` 是 16-bit 链路位图，标记该 peer 参与 MLO 的所有链路——配合 `dispatch_order` 中的链路优先级编码，固件知道在哪些链路中做选择。

这些字段是 host 通过 UniCmd 下发 T2LM 后固件自行填充的——host 不直接写 WTBL，只提供"哪些 TID 可以走哪些链路"的策略语言，固件将其翻译为硬件调度器可以直接读取的执行参数。这就解释了为什么 MTK 的链路选择延迟可以做到微秒级：决策参数已经预写在 WTBL 中，固件每发一个帧只需读寄存器、查表、执行——不需要任何 host 侧的运行时交互。

用一个具体场景走完整条路径。假设 STA 同时连接了 2.4GHz（Link 0）和 5GHz（Link 1），AP 和 STA 协商了默认 T2LM（所有 TID 走所有链路）。此时 host 发出一个 TCP ACK——IP 头 DSCP=0，TOS 字节为 0x00。

在 MTK 侧，`ndo_select_queue` 调用 `cfg80211_classify8021d`，QoS Map 的 Exception 表中没有 DSCP 0 的条目，Range 表 `up = {{0, 63}}` 将其映射到 UP 0（BE），`ieee8021d_to_queue[0]` = ACI_BK（此处 ACI_BK 是硬件队列索引值 1，非 TID 语义）。在 QCOM 侧，`hdd_wmm_classify_pkt` 查 `adapter->dscp_to_up_map[0]`，默认表 `0 >> 3 = 0` 得到 UP 0（BE），WMM AC 分类映射到 BE 队列（AC_BE，TID 0）。无论哪个平台，这个 TCP ACK 的 TID=0，固件查 T2LM 表发现 TID 0 在两条链路上的 bit 都为 1——固件从两条链路中选择当前信道质量更好（SNR 更高、CCA 空闲比例更大）的那一条发送。

如果 T2LM 将 TID 0 只映射到 Link 0（2.4GHz），固件就只能在 2.4GHz 上发——即使 5GHz 的信道质量更好，T2LM 的约束优先于实时信道状态。

## 4.3 Data TX 与 MLO 的关系

MTK 的 data TX 入口 `wlanHardStartXmit` → `kalHardStartXmit` 通过 `netdev` 关联的 `ucBssIndex` 确定当前链路。

关键函数 `mldUpdatePerLinkMlo`（`mlo.c:4275`）在连接建立阶段向固件下发 MLD 配置——包括每个链路的 BSS 信息（通过 `nicUniCmdSetBssMld`）和 STA 信息（通过 `nicUniCmdSetStarecMld`），固件据此建立 MLD 内部数据结构，为后续的 per-packet 链路选择做准备。

MTK 不需要 QCOM 那样的 TX 描述符池共享机制——两者的架构差异源于 host 侧对 TX 描述符的控制粒度不同。QCOM 的 Soft-MAC 架构下，host 侧的 `dp` 层直接管理 TX 描述符的分配和回收，多个 MLO vdev 共享同一个描述符池可以避免内存碎片和锁竞争；MTK 的 Full-MAC 架构下，host 侧只负责构造 MSDU（通过 `nicTxEnqueueMsdu` 入队），每个链路的 BSS Index 对应独立的 MSDU_INFO 队列，固件从对应链路的队列中取出 MSDU 发送——队列的管理权完全在固件侧，host 不参与描述符的分配和回收，自然不需要跨链路的池共享。

MTK 的路径已追踪完毕——host 只管协商和下发，固件全权执行。QCOM 的架构则不同。

---

# 5 QCOM 的 MLO TX：链路由谁选？

上一节（§4）追踪了 MTK 的 MLO TX 路径——T2LM 双轨 FSM、UniCmd 下发固件、per-link TID bitmap。本节转向 QCOM：同样的 T2LM 协商，但 QCOM 在 host 侧维护完整的 T2LM 状态机（含超时和回退），通过 WMI 下发固件，并引入了 TX 描述符池共享机制。两家的链路选择决策都在固件侧，但 host 侧的编排方式截然不同。

## 5.1 TX 描述符池共享

MLO 场景下，多个 vdev（每个链路一个 vdev）需要 TX 描述符——如果每条链路各自维护一个独立的描述符池，闲置链路的池浪费内存，繁忙链路的池可能耗尽。QCOM 的解决方案是让所有 MLO vdev 共享同一个池。`dp_mlo_tx_pool_map_be`（`dp_be_tx.c:2838`）就是这个共享的实现——它在 vdev 初始化时被调用，决定当前 vdev 是否加入伙伴链路的池。

```c
// QCOM: qca-wifi-host-cmn/dp/wifi3.0/be/dp_be_tx.c:2838 — dp_mlo_tx_pool_map_be
bool dp_mlo_tx_pool_map_be(struct dp_soc *soc,
                           uint8_t vdev_id,
                           enum dp_mod_id mod_id)
{
    struct dp_vdev *self_vdev = dp_vdev_get_ref_by_id(soc, vdev_id, mod_id);
    bool remap = false;

    if (!self_vdev || self_vdev->opmode != wlan_op_mode_ap)
        return remap;

    struct dp_vdev_be *be_vdev = dp_get_be_vdev_from_dp_vdev(self_vdev);
    if (!be_vdev || !be_vdev->mlo_dev_ctxt)
        return remap;  // 非 MLO，不需要池共享

    // 遍历 MLO vdev 列表，找到第一个伙伴链路
    for (j = 0; j < WLAN_MAX_MLO_LINKS_PER_SOC; j++) {
        struct dp_vdev *ptnr_vdev;

        ptnr_vdev = dp_vdev_get_ref_by_id(soc,
            be_vdev->mlo_dev_ctxt->vdev_list[i][j], mod_id);
        if (!ptnr_vdev) continue;

        if (ptnr_vdev == self_vdev) {
            // 自己已经分配了池 → 引用计数 +1
            dp_tx_init_inc_pool_ref_be(self_vdev->pool);
        } else if (ptnr_vdev->pool) {
            // 伙伴链路的池已经存在 → 指向它，引用计数 +1
            self_vdev->pool = ptnr_vdev->pool;
            dp_tx_inc_pool_ref_be(self_vdev->pool);
            remap = true;
            break;
        }
        // ...省略 vdev 引用释放...
    }
    return remap;
}

```

三个核心约束值得展开。

仅 AP 模式生效——STA 模式下每条链路只有一个 STA 连接，描述符消耗量可预测，不需要跨链路共享；AP 模式下同一个 MLD 上的多个 BSS（不同链路各自一个 BSS）共享描述符池可以避免每条链路按峰值单独分配内存造成的浪费。三个约束归结为一句话：共享池的精髓在解耦。

引用计数管理确保池的生命周期正确——每个 MLO vdev 指向第一个伙伴链路的池，该池通过 `ref_cnt` 原子计数器追踪使用者数量。并发保护用的是无锁方案：`ref_cnt` 字段是 `qdf_atomic_t` 原子类型（`dp_be_tx.c:2781`），`dp_tx_init_inc_pool_ref_be` 通过 `qdf_atomic_init` + `qdf_atomic_inc` 初始化，`dp_tx_inc_pool_ref_be` 通过 `qdf_atomic_inc` 递增，`dp_tx_dec_pool_ref_be` 通过 `qdf_atomic_dec` 递减——全部是无锁原子操作，不需要 spinlock。`dp_tx_inc_pool_ref_be` 的注释明确要求"always be called outside `pool->flow_pool_lock`"，说明原子计数和 spinlock 是两套独立的并发控制机制：原子计数保护引用计数本身，spinlock 保护池的分配/释放路径。清除时（`dp_mlo_tx_pool_unmap_be`）减少引用计数，最后一个使用者退出时才真正释放池。

为什么用原子引用计数而非 RCU？RCU 适合读多写少的场景——读者无锁访问，写者延迟释放——但池的引用计数变更频率不低（每个 MLO vdev 创建/销毁都触发 inc/dec），且引用计数语义本身就是"最后一个使用者释放"，原子 dec + 零检查天然实现了这个语义，比 RCU 的 grace period 机制更直接。spinlock 已经在分配/释放路径中保护池的内部状态（水位、空闲链表），引用计数的原子操作避免了在 spinlock 内再嵌套锁——两层并发控制各司其职，没有多余的锁竞争。

`dp_mlo_tx_pool_map_be` 的原子引用计数 + 解除绑定的释放语义是 Linux 内核 kref 模式在 WiFi 驱动中的精确应用：`qdf_atomic_inc`/`qdf_atomic_dec` 保护引用计数，最后一个使用者通过 `qdf_atomic_dec` 触发释放——这一模式在 kernel 中经过 25 年验证，QCOM 没有发明新方案，而是选择了最可靠的方案。

这个设计的架构意义在于：所有 MLO 链路的 TX 描述符从同一个池中分配，固件不需要关心描述符来自哪个链路——描述符和链路完全解耦。航空公司改用共享机队后：以前每条航线各配各的飞机（per-link 描述符池），旺季闲置航线的飞机只能晒太阳；现在所有航线共用一个机队（共享池），调度员（固件）根据当天的客流量和天气状况临时安排哪架飞机飞哪条航线，飞机和航线不再绑定。host 只负责把乘客（MSDU）送上飞机（描述符），固件决定飞机最终飞往哪条航线。

## 5.2 T2LM 协商下发

QCOM 的 T2LM（TID-to-Link Mapping）协商由 host 侧 `umac/mlo_mgr/src/wlan_mlo_t2lm.c` 处理。协商完成后，通过 WMI 命令将映射下发到固件：

```c
// QCOM: qca-wifi-host-cmn/umac/mlo_mgr/src/wlan_mlo_t2lm.c:2611 — wlan_send_tid_to_link_mapping
QDF_STATUS wlan_send_tid_to_link_mapping(struct wlan_objmgr_vdev *vdev,
                                         struct wlan_t2lm_info *t2lm)
{
    struct wlan_lmac_if_mlo_tx_ops *mlo_tx_ops;
    struct wlan_objmgr_psoc *psoc;
    QDF_STATUS status = QDF_STATUS_E_FAILURE;

    psoc = wlan_vdev_get_psoc(vdev);
    // ...省略空值检查...

    mlo_tx_ops = &psoc->soc_cb.tx_ops->mlo_ops;
    status = wlan_send_t2lm_info(vdev, t2lm, mlo_tx_ops);

    return status;
}

```

`wlan_send_t2lm_info` 逐层下沉到 target_if 层，由 `target_if_mlo_send_tid_to_link_mapping`（`target_if/mlo_mgr/src/target_if_mlo_mgr.c:982`）构建 WMI 参数并发送：

```c
// QCOM: target_if/mlo_mgr/src/target_if_mlo_mgr.c:982 — target_if_mlo_send_tid_to_link_mapping
static QDF_STATUS
target_if_mlo_send_tid_to_link_mapping(struct wlan_objmgr_vdev *vdev,
                                       struct wlan_t2lm_info *t2lm)
{
    struct wmi_unified *wmi_handle = NULL;
    struct wmi_host_tid_to_link_map_params params = {0};

    // ...获取 wmi_handle, pdev...

    params.pdev_id = wlan_objmgr_pdev_get_pdev_id(pdev);
    qdf_mem_copy(params.peer_macaddr, vdev->vdev_objmgr.bss_peer->macaddr,
                 QDF_MAC_ADDR_SIZE);

    params.t2lm_info[params.num_dir].direction = t2lm->direction;
    params.t2lm_info[params.num_dir].default_link_mapping =
        t2lm->default_link_mapping;

    if (!params.t2lm_info[params.num_dir].default_link_mapping)
        target_if_fill_provisioned_links(&params, t2lm);

    target_if_fill_timer(&params, t2lm);

    // 遍历 8 个 TID 的链路映射
    for (tid = 0; tid < T2LM_MAX_NUM_TIDS; tid++) {
        // params.t2lm_info[...].t2lm_provisioned_links[tid]
        //   = t2lm->ieee_link_map_tid[tid]
    }

    params.num_dir++;
    status = wmi_send_mlo_peer_tid_to_link_map_cmd(wmi_handle, &params, true);

    return status;
}

```

WMI 命令携带的信息：

- **`default_link_mapping`**：是否使用默认映射（所有 TID 走所有链路）
- **`t2lm_provisioned_links[TID]`**：每个 TID 允许走的链路位图——例如 TID 6 的位图可能只包含 5GHz 链路的 bit
- **`mapping_switch_time`** 和 **`expected_duration`**：定时切换参数——AP 可以指定映射切换的 TSF 时间和有效时长

固件收到这条 WMI 命令后，更新 per-peer 的 T2LM 表。后续每个数据帧发送时，固件根据帧的 TID 查表，只从允许的链路中选择实际发送链路——同时参考实时信道质量做最终决策。host 下发 T2LM 映射，就像调度中心把路线表发给仓库：总部说"语音件走 5 号传送带"，仓库据此给每件货标上对应的航线编号。与 MTK 的"分拨仓"（每条传送带入口贴准入清单，§4.2）不同，QCOM 的仓库只收到一份总路线表——传送带上的传感器拿到货后再查表决定往哪边拨，不需要提前标好目的地。

## 5.3 固件反馈回路

固件不是被动接收 T2LM 的——它会主动推送 T2LM 变更事件到 host：

```c
// QCOM: umac/mlo_mgr/src/wlan_mlo_t2lm.c:2475 — wlan_mlo_vdev_tid_to_link_map_event
QDF_STATUS wlan_mlo_vdev_tid_to_link_map_event(
        struct wlan_objmgr_psoc *psoc,
        struct mlo_vdev_host_tid_to_link_map_resp *event)
{
    // ...获取 vdev, t2lm_ctx, vdev_mlme...

    switch (event->status) {
    case WLAN_MAP_SWITCH_TIMER_TSF:
        // 定时切换：更新 beacon TSF 基准的切换时间
        if (t2lm_ctx->upcoming_t2lm.t2lm.mapping_switch_time_present)
            vdev_mlme->proto.ap.mapping_switch_time =
                (event->mapping_switch_tsf &
                 WLAN_T2LM_MAPPING_SWITCH_TSF_BITS) >> 10;
        break;
    case WLAN_MAP_SWITCH_TIMER_EXPIRED:
        // 切换定时器到期：应用新的 T2LM 映射
        vdev_mlme->proto.ap.mapping_switch_time = 0;
        wlan_mlo_t2lm_handle_mapping_switch_time_expiry(t2lm_ctx, vdev);
        wlan_mlo_dev_t2lm_notify_link_update(vdev,
                    &t2lm_ctx->established_t2lm.t2lm);
        break;
    case WLAN_EXPECTED_DUR_EXPIRED:
        // 有效时长到期：回退到前一个映射
        wlan_mlo_t2lm_handle_expected_duration_expiry(t2lm_ctx, vdev);
        wlan_mlo_dev_t2lm_notify_link_update(vdev,
                    &t2lm_ctx->established_t2lm.t2lm);
        break;
    }
    return QDF_STATUS_SUCCESS;
}

```

host 通过这些事件跟踪 T2LM 映射的生命周期——上层应用（如 Wi-Fi Aware、Miracast）据此调整链路级流量调度。

固件侧的链路选择不仅依赖 T2LM 映射表，还依赖一个闭环反馈机制。host 通过 `dp_tx_report_tx_delay_to_fw`（`dp_tx.c:7036`）周期性地计算每条链路的上行延迟均值，经 `dp_h2t_tx_mlo_latency_stats_msg_send`（`dp_htt.c:6452`）以 HTT 消息（`HTT_H2T_MSG_TYPE_MLO_LATENCY_STATS_RESP`）上报固件——消息体包含 `vdev_id`、`avg_latency_ms`、`avg_jitter_ms`、`num_of_tx_pkt` 四个字段（`struct dp_mlo_latency_stats`，`dp_htt.h:846`）。固件收到后，结合自身的 PHY 层信道质量观测（SNR、CCA 占用比、TX 成功率），在 T2LM 允许的链路集合中选择当前状态最优的链路。`avg_latency_ms` 的计算方式是两个报告间隔之间的简单算术平均——`dp_tx_average_ul_delay`（`dp_tx.c:6982`）从单调递增的原子累加器 `vdev->ul_delay_accum` 和 `vdev->ul_pkts_accum` 中取当前快照，减去上一次报告时的快照值，相除得到均值。累加器在两次报告之间不会重置，只有快照指针更新——这意味着统计窗口的长度由固件通过 HTT 消息下发的 `report_interval` 字段动态控制，而非 host 侧硬编码。

延迟统计是调整权重基线的慢信号。

这个反馈回路的延迟在百毫秒量级——远高于 per-packet 决策的时间尺度——所以它不是用来做逐包调度的，而是用来调整固件内部的链路权重基线。就像仓库调度员每天看一次各航线的准时率报表（延迟统计），据此调整未来几天的航线分配比例（权重基线），但每件货的实时路由仍然由传送带上的传感器（PHY 层信道质量）当场决定。如果某条航线连续几天准时率低，调度员会减少对它的预订频次——就像会议室管理系统自动降低使用率低的房间的推荐权重。

固件根据 host 上报的 per-link 延迟统计调整当前链路的调度权重基线——这个"定期拉取→基线调整"模式与 Linux CFS 调度器的 load balancing 机制本质上做的是同一件事：周期性收集下游负载信号，在调度决策前调整权重表，让下一次决策更准确。区别是 CFS 每 4ms 检查一次 load，固件每百 ms 拉一次延迟统计——因为空口信道变化的时间尺度远慢于 CPU 线程切换。

共享描述符池也有失败模式。STR MLMR 高负载下，所有 MLO 链路的 TX 描述符从同一个池分配——如果突发流量导致池中描述符全部被固件占用（尚未通过 HTT completion 通知释放），host 侧 `dp_tx` 的描述符分配会返回 NULL。此时 host 进入 backpressure 路径：`netif_stop_queue` 暂停协议栈向该 vdev 入队，上层应用的 send() 系统调用阻塞在 socket 缓冲区。固件完成 TX 后通过 HTT completion 释放描述符回池，host 检测到池水位恢复到阈值以上后调用 `netif_wake_queue` 解除暂停，协议栈恢复入队。这个 backpressure 机制是共享池架构的安全阀——它确保了 STR 模式的高并发不会因描述符耗尽而丢包，代价是突发延迟（从描述符耗尽到恢复的时间窗口内，新帧被阻塞在协议栈）。MTK 的 per-link MSDU_INFO 队列不存在这个问题——每条链路的队列独立，一条链路的拥塞不影响另一条链路的入队，但代价是无法跨链路动态调配资源。

但 backpressure 只覆盖了"流量过载"这一种失败模式——共享池还有一个更隐蔽的风险：链路级硬件故障。假设 STR 模式下 Link 1 的射频模块突然故障（PA 损坏、PLL 失锁、或固件检测到 PHY 层 FCS 错误率异常升高触发链路降级），此时 Link 1 的 TX ring 中仍有已分配的描述符——这些描述符的帧已经提交到硬件队列，但射频模块无法完成发送，HTT completion 通知永远不会回来。这些描述符就"泄漏"了：它们占着池中的槽位，既不能被释放（无 completion），也不能被重用（硬件仍持有引用）。随着时间推移，泄漏的描述符越来越多，共享池的可用描述符逐渐耗尽——最终连 Link 0（正常链路）也分配不到描述符，触发 backpressure，整个 MLO STA 的发送能力被一条故障链路拖垮。MTK 的 per-link 队列天然隔离了这种风险——Link 1 的队列故障不影响 Link 0 的 MSDU_INFO 分配。

QCOM 的缓解机制是固件侧的 watchdog：固件在检测到链路故障后，对该链路上所有未完成的描述符强制生成 HTT completion（标记为失败），将描述符归还共享池。但 watchdog 的检测周期（通常百毫秒级）和 completion 批量生成之间存在一个短暂的描述符耗尽窗口——在这个窗口内，正常链路可能短暂触发 backpressure。这是共享池架构在故障场景下相比 per-link 队列的结构性劣势：正常工况下的资源利用优势，在故障工况下转化为故障传播风险。

TX 完成后，host 通过 PPDU ID 中的链路 ID 位域确认实际使用了哪条链路。`dp_tx_get_link_id_from_ppdu_id`（`dp_tx.c:6247`）用宏 `DP_GET_HW_LINK_ID_FRM_PPDU_ID`（`dp_tx.h:62`）从完成描述符的 PPDU ID 中提取 `hw_link_id`——位偏移和位宽由 `soc->link_id_offset` 和 `soc->link_id_bits` 配置。这个链路 ID 用于 per-link 统计更新（`dp_tx_update_peer_stats`、`dp_tx_latency_stats_update`）和 MLO 时间同步延迟计算（`dp_mlo_compute_hw_delay_us`，`dp_be_tx.c:2228`）。host 不用这个信息做链路选择决策——它只是确认固件实际选了哪条链路，用于统计和调试。真正的"选哪条"决策发生在固件内部，host 看到的只是结果。

两家实现已追踪完毕。回到最初的问题：一个帧走哪条链路？

---

# 6 MLO TX：QCOM 和 MTK 谁做链路选择？

| 维度                   | QCOM                                                         | MTK                                                          |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **驱动类型**           | Soft-MAC + offload（混合架构）                               | Full-MAC（固件全权）                                         |
| **链路选择决策方**     | Firmware                                                     | Firmware                                                     |
| **Host 侧 T2LM 模块**  | `umac/mlo_mgr/src/wlan_mlo_t2lm.c`                           | `mgmt/t2lm.c`                                                |
| **T2LM 下发方式**      | WMI (`wmi_send_mlo_peer_tid_to_link_map_cmd`)                | UniCmd (`UNI_CMD_ID_STAREC_INFO` + `UNI_CMD_STAREC_TAG_T2LM`) |
| **TX 描述符池**        | MLO vdev 共享池（`dp_mlo_tx_pool_map_be`）                   | 无 pool 概念，per-link MSDU_INFO 队列                        |
| **T2LM 更新粒度**      | per-peer per-direction（DL/UL/Both）                         | per-STA per-link TID bitmap                                  |
| **定时切换**           | TSF 定时器 + 有效时长                                        | 超时回退 IDLE 状态                                           |
| **T2LM 请求超时**      | 5 秒固定超时（`TTLM_REQUEST_TIMEOUT=5000ms`），`ttlm_req_timeout_cb` 清除协商状态，无自动重试 | `t2lmTimeout` 超时回退 IDLE 状态                             |
| **T2LM Teardown 支持** | 协商清除已有映射，恢复默认映射（所有 TID 走所有链路）——协议定义三种 Action，实际实现中映射生命周期由 Expected Duration 定时器管理，到期自动回退默认映射 | `t2lmSend` Teardown 分支返回失败未实现（`t2lm.c:638`），映射清除依赖超时回退 IDLE 状态 |
| **Multicast 处理**     | （非本文范围）                                               | （非本文范围）                                               |
| **操作模式管理**       | Host 侧完整状态机（`enum wlan_eht_mode` + `wlan_emlsr_action_mode`），host 可主动 ENTER/EXIT eMLSR | 固件内部管理，host 通过 WTBL 字段（`emlsr0/1/2`、`str_bitmap`）被动感知 |
| **eMLSR 切换控制**     | `hdd_test_config_emlsr_action_mode` → `sme_activate_mlo_links` | 固件自主决策，WTBL `emlsr` 字段指示当前状态                  |
| **STR 支持**           | 由固件在 Multi-Link Capabilities 中协商，host 不感知 STR/NSTR 区分 | WTBL `str_bitmap`（3 bit）per-link 标记 STR 能力             |
| **BA Session 架构**    | Per-link 独立 BA session，独立序列号空间，T2LM 切换时旧链路 BA 窗口未确认帧走旧链路重传 | Per-link 独立 BA session，同 QCOM——无需跨链路同步 BA scoreboard |
| **链路故障隔离**       | 共享池无天然隔离，故障链路描述符泄漏可能拖垮正常链路（watchdog 百毫秒级恢复窗口） | Per-link 队列天然隔离，Link 1 故障不影响 Link 0 的 MSDU_INFO 分配 |

一行总结：QCOM 的 host 侧更重（完整状态机 + 主动控制），MTK 的 host 侧更轻（能力协商 + 被动感知），但链路选择的最终决策权都在固件。

两家虽然都是 firmware 决策，但架构上有本质区别。如果你把"host 决策"和"固件决策"放在一起比较，三个维度的差异一目了然：

| 维度         | Host 决策（假设）                                            | 固件决策（QCOM/MTK 实际选择）                                |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **决策延迟** | 高（host→固件的命令通道延迟 + host 侧信息过期）              | 低（固件直接访问 PHY/MAC 寄存器，μs 级）                     |
| **吞吐影响** | 中（每包需 host 介入，CPU 占用增加；突发流量时 host 调度成为瓶颈） | 低（固件硬件加速，host 只在 T2LM 变更时介入）                |
| **灵活性**   | 高（host 可接入应用层意图、策略引擎、跨层优化）              | 中（固件决策基于预设规则 + 实时信道信息，策略变更需重新下发 WMI/UniCmd） |

固件决策在延迟和吞吐上的优势是决定性的——MLO 链路选择需要毫秒级甚至微秒级响应，host 的上下文切换和命令通道延迟（WMI/UniCmd 往返通常在 ms 级）无法满足这个时间尺度。灵活性是 host 决策唯一的潜在优势，但在实际部署中，T2LM 协商本身就是 host 表达策略意图的方式——host 在 T2LM 层面设定"语音走 5GHz"的规则，固件在每包层面根据实时信道质量做微调。这种分层决策架构兼顾了策略灵活性和执行实时性。QCOM 的 TX 描述符池共享是 MLO 架构优化的核心——所有链路的描述符从同一个池分配，固件拿到描述符后再选链路，描述符和链路的解耦让固件可以在链路间动态调度。

把"固件决策"换成"host 决策"会怎样？代价分三层叠加。第一层是命令通道延迟：host 的链路选择决策需要通过 WMI（QCOM）或 UniCmd（MTK）下发固件，这条通道的典型往返延迟在 200-500μs——包含了 host 侧的上下文切换（从 TX 路径的 softirq 上下文切换到 host 驱动的 workqueue）、WMI/UniCmd 消息的序列化和 DMA 提交、以及固件侧的命令解析和执行。

第二层是信息过期：host 做决策时依赖的信道状态（SNR、CCA 占用比、TX 成功率）来自上一次固件上报的快照。5GHz 频段的无线信道相干时间通常在百微秒量级，host 拿到的信息在决策时刻可能已经过期了一个甚至多个相干时间窗——host 以为 Link 1 的 SNR 是 30dB，实际可能已经因为突发干扰跌到 15dB。更麻烦的是总线竞争：host 下发链路选择命令时，PCIe 总线上同时在进行 TX 描述符的 DMA 提交和 RX completion 的 DMA 回传。WMI 命令需要与这些正在进行的 DMA 传输竞争带宽，高负载场景下产生数十微秒的排队延迟。

三层叠加，host 决策的总延迟典型 ~400μs、高负载 ~700μs。微秒级决策，毫秒级代价——这就是 host 决策在 MLO TX 中不可接受的根因。

把这个延迟放进 eMLSR 切换场景算一笔账：固件决策下，STA 从 Link 0 切换到 Link 1 的总延迟 = padding delay（256μs）+ transition delay（32μs）= 288μs；host 决策下，额外的命令通道延迟（假设 500μs）必须在 padding delay 之前完成——host 先做决策、再下发命令、固件收到后才开始切换，总延迟 = host 决策（500μs）+ padding delay（256μs）+ transition delay（32μs）= 788μs。这是 2.7 倍的恶化。对于语音帧（每 20ms 一个，单向延迟预算 150ms），788μs 的切换开销本身不是致命的——但它意味着 eMLSR 的"伪同时"优势被大幅削弱：固件决策下 288μs 的切换开销对应 2.88% 的空口浪费（每 10ms 切一次），host 决策下 788μs 对应 7.88%——eMLSR 相对 STR 的功耗优势被吞掉了三分之一以上。两家平台不约而同地把链路选择下沉到固件，根源在此——不是 host 做不了，而是做的代价在延迟敏感场景下不可接受。

T2LM 是让 host 和固件在"哪个包走哪条链路"上达成一致的基础协议。T2LM 协商的结果转化为每个 STA 的 per-link TID bitmap，固件在发包时查这张表——不会把一个语音帧发到 2.4GHz 的拥挤信道，也不会把一个后台下载帧塞满低延迟的 5GHz 链路。QCOM 和 MTK 的差异就像两种仓库管理模式：QCOM 采用"集中仓"——所有航线的包裹汇入同一个大仓库（共享描述符池），调度员（固件）站在传送带交汇处，拿到一件货再看哪条航线当前最空闲就往哪边拨，灵活但调度员的工作量大；MTK 采用"分拨仓"——每条航线有独立的小仓库（per-link MSDU_INFO 队列），货进仓前已经按 TID bitmap 标好了目的地，小仓库按标签执行，确定性强但改路线需要总部提前更新标签规则。两种模式的调度权都在固件，区别在于描述符和链路的耦合程度——集中仓解耦了描述符与链路，固件可以像机队调度员拿到当天客流量后再分配飞机那样动态调度；分拨仓让每条链路有独立的队列，减少了跨链路锁竞争但牺牲了调度灵活性。

如果把 QCOM 的共享描述符池移植到 MTK 的 Full-MAC 架构呢？障碍不在软件——`dp_mlo_tx_pool_map_be` 的引用计数和池管理逻辑可以移植——而在硬件。MTK MT6653 的 HIF TX 硬件队列在芯片设计时就假设了队列与链路的固定绑定：`HIF_TX_AC0_INDEX`\~`HIF_TX_AC3_INDEX` 对应 Link 0 的四个 AC 队列，`HIF_TX_AC10_INDEX`\~`HIF_TX_AC13_INDEX` 对应 Link 1，`HIF_TX_AC20_INDEX`\~`HIF_TX_AC23_INDEX` 对应 Link 2——这些枚举值（`nic_tx.h:416`）直接映射到硬件中断寄存器和 DMA 描述符环的物理地址。共享池要求动态绑定——一个描述符可以从任意链路的队列提交到任意链路的 DMA 环——这需要改动硬件寄存器映射：将固定的"AC→DMA 环"映射改为可编程的"AC→link_id→DMA 环"二级查找。这个改动涉及 TX DMA 引擎的描述符解析逻辑、中断路由矩阵和流控信用管理，属于芯片 RTL 级别的修改——不是固件补丁能解决的，芯片级修改的工程周期和成本远超软件适配的代价。MTK 选择在现有硬件约束下用软件方案（per-link MSDU_INFO 队列 + WTBL dispatch_policy）做 MLO 调度，根源也在于此——不是不想用共享池，而是硬件不支持动态绑定。

QCOM 能用共享池，是因为 WCN7850 的 TX DMA 引擎从设计之初就支持 MLO 的描述符池共享——`dp_mlo_tx_pool_map_be` 是在已有硬件能力上的软件优化，不是硬件改造。

这两套架构的实际取舍可以归结为一句话：**STR 多链路高吞吐场景选 QCOM 架构**——共享描述符池让固件在链路间动态调度资源，配合 host 侧完整的操作模式状态机，适合需要同时在多条链路上满载发送的场景（如 Miracast + 下载并发）；**eMLSR 单射频省功耗场景选 MTK 架构**——per-link 独立队列避免了跨链路锁竞争，固件自主管理模式省去了 host 侧的状态同步开销，适合对功耗敏感、同一时刻只需一条链路满载的移动终端。当然，实际选型还要综合考虑驱动生态、固件成熟度和芯片成本——架构优势只是其中一个维度。


# 7 写在最后

本章追踪了 MLO 引入后数据帧发送路径上的核心变化——操作模式决定了固件的调度自由度，T2LM 协议让 host 和固件在链路选择上达成一致，而最终每包走哪条链路的决策权落在了固件手里。

QCOM 和 MTK 都把链路选择交给固件。这不是巧合——实时信道质量、TX 队列深度、CCA 状态这些信息只有固件能看到，host 侧的任何决策都基于过期信息。操作模式（STR/eMLSR/MLMR）决定了固件的调度自由度：STR 模式下可以同时在多条链路发送，eMLSR 模式下需要 padding delay 切换链路。TID-to-Link Mapping（T2LM）是 host 向固件传递意图的协议——"语音走 5GHz，下载走 2.4GHz"——但最终每包走哪条链路是固件根据实时信道状态和当前操作模式共同决定的。

回到开篇的比喻：单链路是一间只有一条传送带的仓库，MLO 把它扩成了多航线分拨中心——航线变多了、货机变多了，但"每个包裹装进哪架货机"的决策权，始终握在离传送带最近的那个分拣员（固件）手里。host 能做的，是在开张时告诉分拣员"你有这几条航线、语音件优先走 5 号专线"，然后退到幕后。

数据面到这里已经覆盖了发送（数据帧发送篇）、接收（数据帧接收篇）、DSCP→UP 映射（上一篇）和 MLO TX（本章）。整个系列的数据面部分到此告一段落。

下面这张表汇总了本章关键机制的 QCOM/MTK 对照：

| 主题           | 核心机制                           | QCOM                                                         | MTK                                                  |
| -------------- | ---------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| MLO 链路选择   | 固件决策，T2LM 约束 + 实时信道质量 | 集中仓：共享描述符池，固件拿到件再选链路                     | 分拨仓：per-link TID bitmap，进仓前已标好目的地      |
| 操作模式管理   | Host 侧主动 vs 固件自主            | Host 侧完整状态机（`wlan_eht_mode` + `wlan_emlsr_action_mode`） | 固件内部管理，host 通过 WTBL 被动感知                |
| T2LM 下发      | WMI vs UniCmd                      | `wmi_send_mlo_peer_tid_to_link_map_cmd`                      | `UNI_CMD_ID_STAREC_INFO` + `UNI_CMD_STAREC_TAG_T2LM` |
| eMLSR 切换控制 | padding delay + transition delay   | `hdd_test_config_emlsr_action_mode` → `sme_activate_mlo_links` | 固件自主决策，WTBL `emlsr` 字段指示状态              |

---

协议依据：IEEE 802.11-2024 §35.3（MLO 多链路操作）。IEEE 802.11be D3.0 TID-to-Link Mapping、EML Capabilities（§9.4.2.313）、EML Operating Mode Notification（§9.6.35）。源码路径见各代码块注释。
