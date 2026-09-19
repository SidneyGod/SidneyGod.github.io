---
title: SAP（二）hostapd 启动：ACS、BSS、Beacon 到空口
top: 1
related_posts: true
abbrlink: 7959d7f4
date: 2026-09-19 21:33:29
tags:
  - Android WiFi
  - SAP
categories:
  - WiFi
  - Code
---

> 上一篇停在 `HostapdHal.addAccessPoint()` 的 AIDL 跨进程调用那一刻。民宿老板拿到了营业执照，装修队进场——这一篇，我们跨过那行代码，进入 hostapd 的纯 C 世界，看装修队怎么选铺位（ACS）、检测环境（DFS CAC）、硬装（BSS 初始化）、做招牌灯（Beacon 组装）、挂灯牌（nl80211 + 驱动下发）。

# 1 本章导读

**本文覆盖约 10,000 字，核心问题**：

1. ACS 的干扰因子公式到底怎么算？QCOM 和 MTK 怎么把 ACS 卸载给固件？
2. 为什么 BSS 初始化的 8 个步骤必须是这个顺序？
3. Beacon 帧的 head 和 tail 分别装了什么？为什么拆成两部分？
4. nl80211 收到 `NL80211_CMD_START_AP` 后经历了哪三个阶段的处理？
5. 驱动和固件拿到 Beacon 模板后怎么把它变成空口信号？

<!--more-->

源码来自 AOSP `external/wpa_supplicant_8`（hostapd 核心）、QCOM `qcacld-3.0`（驱动与固件接口）、MTK `kernel_modules-connectivity-wlan-core-gen4m`（驱动与 FSM）。

本文的路线是：先跨过 AIDL 进入 hostapd 的 C 世界，看请求怎么从 Java 层落地到配置文件（§2-3）；然后深入选频的核心——ACS 干扰因子公式和三种平台的选频策略（§4）；如果选到了雷达信道，还要等 60 秒的 CAC 检测（§5）；信道确定后是 BSS 初始化的八道硬装工序（§6），接着组装 Beacon 帧的 head 和 tail（§7）；最后穿过 nl80211 的三道审批，到达驱动和固件，看 Beacon 模板怎么变成空口信号（§8-9）。

# 2 addAccessPoint：AIDL 的 C 端入口

> 从这里开始，我们离开 Java/Kotlin 的 Framework 世界，进入 hostapd 的纯 C 代码库。AIDL 是两个世界的分界线——上一篇的 `SoftApManager` 到此为止，接下来的每一行代码都是 C。

## 2.1 AIDL 接口层：Hostapd::addAccessPoint

Framework 通过 AIDL 调用 `Hostapd::addAccessPoint()`，这个方法的实现在 `hostapd/aidl/hostapd.cpp`。它是一个薄薄的适配层——检查 `channelParams` 数量，把请求分派到三种路径之一：

```cpp
// hostapd/aidl/hostapd.cpp:1145-1163
::ndk::ScopedAStatus Hostapd::addAccessPointInternal(
    const IfaceParams& iface_params,
    const NetworkParams& nw_params)
{
    int channelParamsSize = iface_params.channelParams.size();
    if (channelParamsSize == 1) {
        // Single AP
        return addSingleAccessPoint(iface_params, iface_params.channelParams[0],
            nw_params, "", "");
    } else if (channelParamsSize == 2) {
        // Concurrent APs
        return addConcurrentAccessPoints(iface_params, nw_params);
    }
    return createStatus(HostapdStatusCode::FAILURE_ARGS_INVALID);
}
```

- `channelParams.size() == 1`：单频 AP，走 `addSingleAccessPoint()`
- `channelParams.size() == 2`：双频并发 AP（如 2.4G + 5G），走 `addConcurrentAccessPoints()`
- 其他值：返回参数无效错误

这个分派逻辑直接对应 Framework 层的 `SoftApManager` 在 `setupInterfaceForSoftApMode()` 中构建的 channelParams 列表。一个单频 SAP 只有一个 channelParams，包含从 Capabilities 和 CoexManager 综合决策出的频段（band）和信道（如果是指定信道模式）。

## 2.2 addSingleAccessPoint：参数落地到文件

`addSingleAccessPoint()` 做了四件事：

1. 调用 `CreateHostapdConfig()` 把 AIDL 参数（`IfaceParams` + `ChannelParams` + `NetworkParams`）转成 hostapd 的原生配置结构
2. 调用 `WriteHostapdConfig()` 把配置写入临时文件（路径类似 `/data/vendor/wifi/hostapd/hostapd_<iface>.conf`）
3. 调用 `hostapd_add_iface()` 把接口名和配置文件路径传给 hostapd 核心
4. 注册回调（setup complete、STA authorized、wpa event），然后调用 `hostapd_enable_iface()` 启动

第一步的 `CreateHostapdConfig()` 是参数转换的核心。其中 channel 参数的转换路径最为关键：`ChannelParams` 携带了 Framework 层 `SoftApConfiguration` 决策出的频段（`bandMask`）和信道号，但 hostapd 的配置文件需要的是 `hw_mode` 和 `op_class` 这两个不同语义的字段。`bandMask` 通过位运算映射为 `hw_mode`：纯 2.4G → `hw_mode=g`，纯 5G → `hw_mode=a`，混合频段 → `hw_mode=any`。信道号则交给 `getOpClassForChannel()` 计算 `op_class`——同一个信道号在不同频段和带宽下对应不同的操作类（比如 5GHz ch36 在 20MHz 下是 op_class 115，在 80MHz 下是 op_class 128）。如果是 ACS 模式（`channelParams.enableAcs` 为 true），则写入 `channel=0` 加上 `freqlist`（候选频率范围列表），让 hostapd 自己选频。

```cpp
// hostapd/aidl/hostapd.cpp:1294-1496
std::string add_iface_param_str = StringPrintf(
    "%s config=%s", iface_params.name.c_str(),
    conf_file_path.c_str());
// ...
if (hostapd_add_iface(interfaces_, add_iface_param_vec.data()) < 0) {
    return createStatus(HostapdStatusCode::FAILURE_UNKNOWN);
}
// ...
if (!iface_params.usesMlo && hostapd_enable_iface(iface_hapd->iface) < 0) {
    return createStatus(HostapdStatusCode::FAILURE_UNKNOWN);
}
```

配置写入文件这个设计看似迂回，实则是 hostapd 的传统架构遗产——hostapd 最初是一个独立的守护进程，通过命令行 `hostapd /etc/hostapd.conf` 启动，配置文件是它的原生输入。AIDL 适配层把 Java 对象转回配置文件字符串，再走传统的 `hostapd_add_iface()` 路径，最大限度地复用了已有代码。

这就像施工队虽然接的是现代管理系统（AIDL）下的单，但进场后还是按传统工序：先填施工单（配置文件），再交给工头（hostapd_add_iface）。

# 3 hostapd_setup_interface：施工队的三道工序

## 3.1 调用链总览

![hostapd 内部模块关系](assets/10b-SAP%EF%BC%88%E4%BA%8C%EF%BC%89hostapd-%E5%90%AF%E5%8A%A8%EF%BC%9AACS%E3%80%81BSS%E3%80%81Beacon-%E5%88%B0%E7%A9%BA%E5%8F%A3/10b-hostapd-modules.svg)

```
hostapd_enable_iface() → hostapd_setup_interface() → setup_interface() → setup_interface2()
```

`hostapd_enable_iface()` 是外部触发入口。它先校验配置（`hostapd_config_check()`）、初始化驱动（`driver_init()`），然后直接同步调用 `hostapd_setup_interface()`。整个 setup 流程的前半段（§3.2-3.3）是同步执行的——从 AIDL 线程一路调下来，直到 ACS 或 DFS 阶段才进入异步模式。ACS 的异步性来自 `acs_request_scan()` 注册的 scan 回调链（§4.1），DFS 的异步性来自 CAC 定时器——两者都通过 eloop 事件驱动完成，但触发点不在 `hostapd_enable_iface()` 这里。

hostapd 和 wpa_supplicant 共享同一套 eloop 事件循环库（`src/utils/eloop.c`），但两者在 eloop 中的角色截然相反：wpa_supplicant 是**事件生产者**——它主动发起 scan、发起认证、发起关联，然后通过 eloop 等待内核的异步回复；hostapd 在 setup 阶段是**事件消费者**——它被动等待 ACS 扫描结果、等待 CAC 完成、等待 STA 来敲门。同一个 eloop，一个用来"等回复"，一个用来"等信号"。代价是 hostapd 的 setup 流程被切成了多段同步片段 + 多段异步等待，代码的控制流不再是一条直线，而是散落在多个回调函数中——理解 hostapd 的启动流程必须跟着回调链跳转，不能像读线性代码那样从上往下看。

单线程还意味着任何耗时操作都会阻塞整个事件循环：当 hostapd 在做 ACS 被动扫描时（§4.1，多次扫描可能持续数秒），eloop 被 scan 回调链占据，同一时刻如果另一个 BSS 上有 STA 发来 Auth 帧，这个帧会在 netlink socket 的接收缓冲区里排队，直到 ACS 扫描完成、eloop 回到主循环后才被处理。好在 STA 侧的 scan/auth/assoc 也有自己的超时机制，几秒的延迟通常不会导致连接失败——共享同一个 eloop 也保证了 hostapd 和 wpa_supplicant（STA+SAP 并发时）在同一个线程上调度，事件处理的时序是确定的，不会出现两套事件循环各自为政的时序分歧。

这是 20 年前嵌入式 WiFi 守护进程的设计遗产：选择 eloop 而非多线程，用确定性换取了简单性。打个比方：整个队只有一个人，贴地砖的时候不能同时装电线——来敲门的客人都得排队，等地砖贴完才能接待。一个人干活不会左右手打架（无锁竞争），但只要有一件事卡住了，所有事都得等着。这个决策的长期影响是：20 年后的今天，所有新功能（MLO 多链路、EHT 320MHz）仍然必须在同一个 eloop 线程上以回调链方式实现——任何需要并行处理的设计都必须绕过 hostapd，在驱动或固件层完成，这直接塑造了 §4.4 和 §5.2 中 ACS offload 和 DFS offload 的架构动机。

![SAP 全链路时序：AIDL → Beacon 发射](assets/10b-SAP%EF%BC%88%E4%BA%8C%EF%BC%89hostapd-%E5%90%AF%E5%8A%A8%EF%BC%9AACS%E3%80%81BSS%E3%80%81Beacon-%E5%88%B0%E7%A9%BA%E5%8F%A3/10b-full-sequence.svg)

## 3.2 setup_interface：施工前准备

`setup_interface()` 做了五项准备工作：

```c
// src/ap/hostapd.c:2049-2119
static int setup_interface(struct hostapd_iface *iface)
{
    // 1. 获取 radio phy 名称
    if (!iface->phy[0]) {
        const char *phy = hostapd_drv_get_radio_name(hapd);
        // ...
    }

    // 2. 让所有 BSS 共享同一个 driver 接口
    for (i = 1; i < iface->num_bss; i++) {
        iface->bss[i]->driver = hapd->driver;
        iface->bss[i]->drv_priv = hapd->drv_priv;
    }

    // 3. 验证 BSSID 配置（不冲突、格式合法）
    if (hostapd_validate_bssid_configuration(iface))
        return -1;

    // 4. 提前初始化控制接口（方便外部监控后续耗时操作）
    if (start_ctrl_iface(iface))
        return -1;

    // 5. 设置国家码 → 如果有变化则等待 channel list 更新
    if (hapd->iconf->country[0] && ...) {
        hostapd_set_country(hapd, country);
        // 如果国家码变了，注册 5 秒超时等待 channel list 更新
    }

    return setup_interface2(iface);
}
```

- 第 1 步：通过 nl80211 获取 phy 名称（`phy0`、`phy1` 等），后续所有信道查询和 ACS 都需要它
- 第 2 步：一个 iface 下可以有多个 BSS（Multi-BSSID），但它们共享同一个物理 radio 驱动接口
- 第 3 步：防止配了重复的或全零的 BSSID
- 第 4 步：控制接口先于 setup 主逻辑完成——因为后续 ACS 和 DFS CAC 可能很耗时，需要让 `hostapd_cli` 能在 setup 进行中就查询状态
- 第 5 步：如果国家码变了，需要等待内核 regulatory 子系统更新可用信道列表，给 5 秒时间

这就像进场后先确认施工区域（phy），领通用工具（driver），校验设计图（BSSID），立施工现场告示牌（ctrl iface），确认施工许可（国家码）——不过这只是常规检查，如果选到的信道在雷达频段，还得等消防检查员来验收（§5 DFS CAC）。

## 3.3 setup_interface2：核心决策流程

`setup_interface2()` 是这个环节的核心。它的逻辑树枝繁叶茂，但主线清晰：

```c
// src/ap/hostapd.c:2186-2259
static int setup_interface2(struct hostapd_iface *iface)
{
    // 1. 获取硬件能力（支持的频段、信道、速率、DFS 域）
    if (hostapd_get_hw_features(iface)) {
        // 不支持的驱动（如 none driver）也能继续，只是没有 hw feature 数据
    } else {
        // 2. ACS 模式下清空信道/频率
        if (iface->conf->acs && !iface->is_ch_switch_dfs) {
            iface->freq = 0;
            iface->conf->channel = 0;
        }

        // 3. 选择 hw_mode + 信道 → 此函数内部触发 ACS 或 直接选频
        ret = hostapd_select_hw_mode(iface);
        if (ret == 1) {
            // ACS 或 HT scan 进行中，setup 在回调中完成
            return 0;
        }

        // 4. 能力检查（EDMG/HE 6GHz/HT）
        ret = hostapd_check_ht_capab(iface);
        // ...
    }
    return hostapd_setup_interface_complete(iface, 0);
}
```

关键决策在 `hostapd_select_hw_mode()` 中：

```
hostapd_select_hw_mode() → hostapd_determine_mode() → 
  ┌─ 指定信道？→ 直接使用
  ├─ 启用 ACS？→ acs_init() → 异步流程
  └─ 未指定？→ 选第一个可用信道
```

如果 ACS 启用，`hostapd_select_hw_mode()` 返回 1，setup 流程暂停，等待 ACS 完成后通过 callback `hostapd_acs_completed()` 继续流程。这就是为什么 ACS 看起来像是 setup 中的一个"异步插曲"——它不是同步阻塞等结果，而是注册回调后返回，后续通过 eloop 事件驱动完成。

决策树中还有一个容易忽略的分支：如果配置的 `hw_mode` 在硬件能力列表中找不到匹配（比如 Framework 指定了纯 5G 频段，但驱动上报的 `hw_features` 中只有 2.4G 模式），`hostapd_select_hw_mode()` 不会自动降级到其他频段，而是直接返回 -2（`hw_features.c:1311-1329`）。`setup_interface2()` 收到负返回值后走 fail 路径，将接口设为 `DISABLED` 状态（`hostapd.c:2218 goto fail` → `2254 HAPD_IFACE_DISABLED`）。这个设计是故意的——自动降级有两个风险：一是用户以为自己在用 5G SAP 实际却跑在 2.4G 上，二是安全策略跟着出错（比如 5G 的 DFS 信道要求和 2.4G 完全不同）。Framework 层的 `SoftApManager` 在调用 `addAccessPoint()` 之前已经通过 `SoftApCapability` 查询过硬件支持的频段，理论上不会下发硬件不支持的配置——`hostapd_select_hw_mode()` 的 -2 返回是兜底防线，不是常规路径。

# 4 ACS：怎么在十几条信道中选出最优的那一条

⭐⭐⭐ 这是本篇最核心的章节。如果只想知道 ACS 选了哪条信道，看 4.6 的三向对比表就够了。想理解干扰因子公式怎么推导出来的，从 4.1 开始。

## 4.1 hostapd 自主 ACS 的全流程

hostapd 的 ACS 模块在 `src/ap/acs.c`，核心入口是 `acs_init()`。它支持两条路径：

- **hostapd 自主 ACS**：hostapd 自己扫描、采集 survey 数据、计算干扰因子、选最优信道
- **驱动 offload ACS**：驱动声明 `WPA_DRIVER_FLAGS_ACS_OFFLOAD`，hostapd 把选频任务完全交给驱动

```c
// src/ap/acs.c:1486-1518
enum hostapd_chan_status acs_init(struct hostapd_iface *iface)
{
    // 如果驱动支持 ACS offload，直接卸载给驱动
    if (iface->drv_flags & WPA_DRIVER_FLAGS_ACS_OFFLOAD) {
        err = hostapd_drv_do_acs(iface->bss[0]);
        // ...
        return HOSTAPD_CHAN_ACS;
    }

    // hostapd 自主 ACS：先清理旧数据，再发起被动扫描
    acs_cleanup(iface);
    if (acs_request_scan(iface) < 0)
        return HOSTAPD_CHAN_INVALID;

    hostapd_set_state(iface, HAPD_IFACE_ACS);
    return HOSTAPD_CHAN_ACS;
}
```

hostapd 自主 ACS 的完整流程是一个**异步回调链**：

```
acs_init()
  → acs_request_scan()       // 发起被动扫描，注册 scan_cb = acs_scan_complete
    → hostapd_driver_scan()  // NL80211_CMD_TRIGGER_SCAN 下发内核
      → [扫描完成，event 回调]
  → acs_scan_complete()
    → hostapd_drv_get_survey()  // 获取每个信道的 survey 统计数据
    → acs_request_scan()        // 如果 scan 次数不够，再来一轮
    → acs_study()               // 扫描次数达到 acs_num_scans，开始分析
      → acs_study_options()
        → acs_study_survey_based()           // 给每个信道算干扰因子
          → acs_survey_all_chans_interference_factor()
        → acs_find_ideal_chan()              // 找干扰最小的信道
  → hostapd_acs_completed()    // acs_study() 内部直接调用，通知 setup 流程继续
```

有几个关键设计点：

**为什么是多次扫描**：`acs_num_scans` 默认值通常是 1-5。一次扫描可能因为当时的瞬时干扰而误判——比如正好有个微波炉在 2.4GHz ch6 上工作。多次扫描取干扰因子的平均值可以平滑这种瞬时波动。

**为什么是被动扫描而非主动**：ACS 扫描不发 Probe Request，只监听空口。主动扫描会额外引入 Probe Response 流量，反而污染干扰测量。

**重试机制**：如果 `hostapd_driver_scan()` 返回 `-EBUSY`（芯片正忙），ACS 不会立即放弃，而是等 `ACS_SCAN_RETRY_INTERVAL`（5 秒）后重试，最多 `ACS_SCAN_RETRY_MAX_COUNT`（15 次）。

## 4.2 干扰因子公式：逐变量拆解

当 `acs_scan_complete()` 通过 `hostapd_drv_get_survey()` 拿到了每个信道的 survey 数据后，`acs_survey_interference_factor()` 开始计算：

```c
// src/ap/acs.c:370-398
static long double
acs_survey_interference_factor(struct freq_survey *survey, s8 min_nf)
{
    long double factor, busy, total;

    // 优先用 channel_time_busy，退而求其次用 channel_time_rx
    if (survey->filled & SURVEY_HAS_CHAN_TIME_BUSY)
        busy = survey->channel_time_busy;
    else if (survey->filled & SURVEY_HAS_CHAN_TIME_RX)
        busy = survey->channel_time_rx;
    else {
        return 0;  // 没有数据，返回 0（不确定，假设无干扰）
    }

    total = survey->channel_time;

    // 剔除自己发送的时间（自己发的不是干扰）
    if (survey->filled & SURVEY_HAS_CHAN_TIME_TX) {
        busy -= survey->channel_time_tx;
        total -= survey->channel_time_tx;
    }

    // 干扰因子公式
    factor = pow(10, survey->nf / 5.0L) +
        (total ? (busy / total) : 0) *
        pow(2, pow(10, (long double) survey->nf / 10.0L) -
            pow(10, (long double) min_nf / 10.0L));

    return factor;
}
```

这个公式分为两个加数，分别反映不同的干扰来源：

**第一项：底噪惩罚 —— `pow(10, nf / 5.0)`**

`nf`（Noise Floor，噪声基底）是信道在没有信号时的环境噪声水平，单位 dBm，通常 -95 到 -85 dBm。-85 dBm 的信道比 -95 dBm 的信道噪声高 10 dB，这一项用指数函数放大底噪差异（因为每 5 dB 的底噪增加意味着 10 倍的线性噪声功率增加）。

例如：`nf = -85` → `10^(-85/5)` = `10^(-17)`，`nf = -95` → `10^(-95/5)` = `10^(-19)`，两者差 100 倍。

**第二项：信道占用率惩罚 —— `(busy/total) * 2^(线性噪声比差)`**

- `busy / total`：信道占用率。0.3 表示 30% 的时间信道处于占用状态
- `2^(10^(nf/10) - 10^(min_nf/10))`：以 2 为底的指数放大系数，分子和分母分别是当前信道和所有信道中最优信道的**线性噪声功率**（从 dBm 转回 mW）
  - 线性噪声功率 = `10^(nf/10)`，例如 `nf = -90` → `10^(-9)` mW
  - 如果当前信道的线性噪声是最优信道的 10 倍，放大系数就是 `2^10 = 1024`

两项对应两种不同的干扰：第一项是铺位所在街区的『背景噪音』——整条街本身有多吵；第二项是铺位门前的『客流密度』——门口越挤越难进店。开民宿要挑一个本身安静、门前又不堵的铺位，公式就是把这两股干扰分别量化后相加。

**直观理解**：假设两个信道占用率都是 30%，但 A 信道底噪 -90 dBm，B 信道底噪 -85 dBm。将所有信道中 min_nf = -95 dBm。A 的指数差 = `10^(-9) - 10^(-9.5)` ≈ `6.84e-10`，`2^6.84e-10 ≈ 1`。B 的指数差 = `10^(-8.5) - 10^(-9.5)` ≈ `3.16e-9`，放大系数远大于 A。结果：B 的干扰因子远高于 A，即使占用率相同，B 也不会被选中。

这个公式的设计哲学：宁可选噪声低但稍忙的信道，也不选噪声高但稍闲的信道。因为高底噪意味着在这条信道上接收任何信号都需要更高的 SNR，直接限制了可用的 MCS 速率。

**为什么用 busy/tx 时间比而非 RSSI？** 这是公式最容易被误解的地方。RSSI（接收信号强度指示）只能告诉你"这条信道上有没有别的 AP 在发信号"，但 busy/tx 时间比能告诉你"这条信道到底有多堵"。打个交通的比方：RSSI 像路边的指示牌——只能看到其他车辆的目的地标牌，看不到路上到底有多少车；busy/tx 时间比像实际车流量——不管是 WiFi 车、微波炉卡车还是蓝牙自行车，只要占了车道就算堵。选信道不看指示牌亮不亮，看路上堵不堵。

两者的关键区别在于非 WiFi 干扰源——微波炉、蓝牙耳机、无线摄像头、婴儿监视器，这些设备在 2.4GHz 频段发射能量但不遵循 802.11 协议，它们不会出现在 scan 结果的 RSSI 中，却实实在在地占用了信道时间。`channel_time_busy` 是内核通过硬件 MAC 层计数器采集的物理层占用率，它不区分干扰来源——只要信道被占用了，busy 时间就增加。这就是为什么公式选择 busy/tx 比作为干扰度量：它捕获了 RSSI 看不到的非 WiFi 干扰。`channel_time_tx` 被减掉是因为自己发的帧不算干扰——AP 只关心"别人用了多少信道时间"。

这个公式有一个隐含的前提——survey 数据存在。如果驱动没有实现 `get_survey` 回调（或者返回的 survey 数据中既没有 `SURVEY_HAS_CHAN_TIME_BUSY` 也没有 `SURVEY_HAS_CHAN_TIME_RX`），`acs_survey_is_sufficient()`（`acs.c:471`）会判定该信道数据不足并跳过它的干扰因子计算。当所有信道都被跳过时，`acs_find_ideal_chan()` 无法基于干扰因子做出选择，退化为 `rand_chan`——在所有可用信道中随机挑一条。这至少比完全不启动好，但选频质量退化为掷骰子。rand_chan 选出的信道如果有拥塞，AP 仍能正常工作——Beacon 照发、STA 能关联——但信道拥塞会直接表现为吞吐量下降和延迟抖动。hostapd 不会在运行中自动重选信道；如果需要切换，必须通过 CSA（Channel Switch Announcement，IEEE 802.11-2024 §9.4.2.22）机制由 hostapd 主动发起信道切换，或者重新触发 ACS（比如通过 `hostapd_cli` 的 `RELOAD_CONFIG` 命令重载配置）。这也是 QCOM 和 MTK 选择 ACS offload 的另一个现实原因：固件不依赖内核的 survey 采集机制，它直接从硬件寄存器读取信道状态，不存在"驱动没实现 get_survey 所以数据为空"的问题。

## 4.3 理想的信道长什么样

给每条候选信道算完干扰因子后，下一步就是在这堆分数里挑出真正要用的信道——而且不能只看单条信道，还要兼顾带宽占用下连续子信道的组合。这个挑选工作交给 `acs_find_ideal_chan()`：它遍历所有硬件模式（2.4G、5G、6G），在每个 mode 内调用 `acs_find_ideal_chan_mode()`：

```c
// src/ap/acs.c:1092-1160
static struct hostapd_channel_data *
acs_find_ideal_chan(struct hostapd_iface *iface)
{
    // 根据带宽确定需要连续多少条 sub-channel
    // HT40 → 2 条，VHT80 → 4 条，160MHz → 8 条，320MHz → 16 条
    int n_chans = 1;
    if (iface->conf->ieee80211n && iface->conf->secondary_channel)
        n_chans = 2;
    if (iface->conf->ieee80211ac || iface->conf->ieee80211ax ||
        iface->conf->ieee80211be)
        switch (hostapd_get_oper_chwidth(iface->conf)) {
        case CONF_OPER_CHWIDTH_80MHZ: n_chans = 4; break;
        case CONF_OPER_CHWIDTH_160MHZ: n_chans = 8; break;
        case CONF_OPER_CHWIDTH_320MHZ: n_chans = 16; break;
        // ...
        }

    for (i = 0; i < iface->num_hw_features; i++) {
        mode = &iface->hw_features[i];
        acs_find_ideal_chan_mode(iface, mode, n_chans, bw,
                                 &rand_chan, &ideal_chan, &ideal_factor);
    }

    // 如果找到了理想信道（干扰因子最低），用它；否则随机选一条
    if (ideal_chan)
        return ideal_chan;
    return rand_chan;
}
```

`acs_find_ideal_chan_mode()` 的核心逻辑是**滑动窗口**：以 `n_chans` 为窗口大小，在主信道的每一组连续子信道上滑动，把每条子信道的干扰因子累加，找总和最小的窗口。这保证了选出的信道不仅单信道干净，还在整个带宽范围内都相对干净。选频段就像选连续的商铺——不能只看一间铺位门前的客流量（单信道干扰因子），要看整排连续铺位的综合人流。80MHz 需要四间铺位都相对安静，滑动窗口扫一遍，找到人流最低的那一排。

`rand_chan` 是 fallback——如果所有信道的 survey 数据都不够（没有 `SURVEY_HAS_CHAN_TIME_BUSY`），ACS 会随机选一条可用信道。这至少比完全不启动要好。

## 4.4 QCOM ACS offload：把选频交给固件

QCOM 驱动通过设置 `WPA_DRIVER_FLAGS_ACS_OFFLOAD` 告诉 hostapd："信道选择你不用管，我家固件有更丰富的数据。"

当 hostapd 检测到这个 flag，`acs_init()` 不发起自己的扫描，而是调用 `hostapd_drv_do_acs()`：

```c
// src/ap/ap_drv_ops.c:1121-1207
int hostapd_drv_do_acs(struct hostapd_data *hapd)
{
    struct drv_acs_params params;
    // 构建 ACS 参数：hw_mode, ht/vht/eht 能力, ch_width, freq_list
    params.hw_mode = hapd->iface->conf->hw_mode;
    params.ht_enabled = !!(hapd->iface->conf->ieee80211n);
    params.ht40_enabled = !!(hapd->iface->conf->ht_capab &
                             HT_CAP_INFO_SUPP_CHANNEL_WIDTH_SET);
    params.vht_enabled = !!(hapd->iface->conf->ieee80211ac);
    params.eht_enabled = !!(hapd->iface->conf->ieee80211be);
    params.ch_width = 20;
    // 带宽扩展：根据 HT40/VHT/HE/EHT 能力逐级提升
    if (hapd->iface->conf->ieee80211n && params.ht40_enabled)
        params.ch_width = 40;
    if ((hapd->iface->conf->ieee80211be ||
         hapd->iface->conf->ieee80211ax ||
         hapd->iface->conf->ieee80211ac) && params.ht40_enabled) {
        enum oper_chan_width oper_chwidth =
            hostapd_get_oper_chwidth(hapd->iface->conf);
        if (oper_chwidth == CONF_OPER_CHWIDTH_80MHZ)
            params.ch_width = 80;
        else if (oper_chwidth == CONF_OPER_CHWIDTH_160MHZ)
            params.ch_width = 160;  // 含 80+80MHz 模式
        else if (oper_chwidth == CONF_OPER_CHWIDTH_320MHZ)
            params.ch_width = 320;
    }

    ret = hapd->driver->do_acs(hapd->drv_priv, &params);
    return ret;
}
```

QCOM 驱动的 `do_acs` 回调最终触发 `sap_channel_sel()`（`sap_fsm.c:1314`），进入 SAP FSM 的 STARTING 状态。但 `sap_channel_sel()` 并不像 hostapd 的 `hostapd_drv_do_acs()` 那样把选频任务完全卸载给固件——它发起的是一次 host 侧主导的扫描+评分流程：

```
sap_channel_sel()                           // sap_fsm.c:1314
  → sap_get_freq_list()                     // 构建候选频率列表
  → wlan_scan_start()                       // 发起主动扫描（非被动）
    → [扫描完成]
  → wlansap_pre_start_bss_acs_scan_callback() // sap_api_link_cntl.c:355
    → wlansap_calculate_chan_from_scan_result()
      → sap_select_channel()                // sap_ch_select.c:2770
        → sap_compute_spect_weight()        // sap_ch_select.c:1483 — 核心评分
        → sap_sort_chl_weight_all()         // 按 weight 升序排序
        → 取 weight 最小的信道
```

`sap_compute_spect_weight()` 遍历扫描结果中的每个 BSS，为每个信道计算一个三因子加权评分：

- **rssi_bss_weight**：由 `sapweight_rssi_count(rssi, bssCount)` 算出，基于信道上最强 BSS 的 RSSI 和 BSS 数量。RSSI 越高、BSS 越多，权重越大（信道越拥挤）
- **chan_status_weight**：基于信道的 regulatory 状态（DFS/NO_IR 等），受限制的信道权重更高
- **power_weight**：基于 regulatory 允许的最大发射功率，功率越低权重越大（发射功率低意味着覆盖范围小）

三者相加后乘以 1000 归一化，得到每个信道的最终权重。`sap_sort_chl_weight_all()` 按权重升序排列——权重最小的信道就是最优信道。

QCOM 的这个设计与 hostapd 自主 ACS（§4.2）的核心区别不在评分公式本身，而在**扫描能力**：`sap_channel_sel()` 发起的是主动扫描（`scan_f_passive = false`），能收到 Probe Response，获取更丰富的 BSS 信息（包括 HT/VHT/EHT 能力、信道宽度、中心频率），这些信息直接喂给 `sap_compute_spect_weight()` 做更精确的带宽感知评分。此外，QCOM 驱动还支持 ACS 优化（`FEATURE_WLAN_AP_AP_ACS_OPTIMIZE`）：如果同一 radio 上已有另一个 AP 在运行，可以跳过扫描直接复用已知信道。

扫描和评分完成后，SAP FSM 继续进入 CAC（如果是 DFS 信道）或直接进入 STARTED 状态。

## 4.5 MTK ACS：驱动侧有独立选频，但走的是另一条路

MTK 的 ACS 策略比"依赖 hostapd"这个简单描述要复杂。表面上看，MTK 驱动不设置 `WPA_DRIVER_FLAGS_ACS_OFFLOAD`，hostapd 的标准 ACS 流程（§4.1）不知道 MTK 有 ACS 能力——hostapd 会自己走 scan → survey → 干扰因子计算的完整流程。但 MTK 驱动内部有一套**独立的 vendor ACS 实现**，通过 `NL80211_VENDOR_SUBCMD_ACS`（vendor subcmd 54）触发。

这条 vendor ACS 路径的完整链路是：hostapd（或上层框架）发送 `NL80211_CMD_VENDOR` + `NL80211_VENDOR_SUBCMD_ACS` → `mtk_cfg80211_vendor_acs()`（`gl_vendor.c:3633`）解析 `WIFI_VENDOR_ATTR_ACS_*` 属性（hw_mode、HT/VHT/EHT 能力、信道列表、带宽）→ 构建 `MSG_P2P_ACS_REQUEST` 消息通过 mbox 发送给 P2P Role FSM（`MID_MNY_P2P_ACS`）→ `p2pRoleFsmRunEventAcs()`（`p2p_role_fsm.c:5136`）初始化 ACS 参数，先检查是否有 SCC（Same Channel Concurrency）捷径——如果 STA 已经在某个频段连接，直接复用该信道；没有捷径则触发驱动扫描（`SCAN_REASON_ACS`）。扫描完成后，`p2pFunCalAcsChnScores()`（`p2p_func.c:8834`）遍历扫描结果中的 BSS 描述符，统计每个信道的 AP 数量（`u2APNum`），调用 `wlanCalculateAllChannelDirtiness()` 计算信道"脏度"评分，再按策略排序选出最优信道。最后 `p2pFunProcessAcsReport()`（`p2p_func.c:8581`）处理结果，`p2pFunIndicateAcsResult()`（`p2p_func.c:8702`）通过 vendor event 将选频结果回报给 hostapd。值得注意的是，这条 vendor ACS 路径使用驱动自己的硬件扫描（`SCAN_REASON_ACS`），与 hostapd 自主 ACS 的 `hostapd_driver_scan()` 完全独立——hostapd 不知道驱动在内部做了选频，驱动也不共享 hostapd 的 scan 结果。两套 ACS 机制各自为政，互不感知。

MTK 的评分算法与 hostapd 的干扰因子公式（§4.2）完全不同。`wlanCalculateAllChannelDirtiness()`（`wlan_lib.c:11622`）遍历扫描结果中的 BSS 描述符，先根据 RSSI 将每个 BSS 分为三档脏度：RSSI >= -50 dBm → 52（重干扰），>= -80 dBm → 40（中干扰），< -80 dBm → 32（轻干扰）。然后每个 BSS 贡献**两层**脏度：index1 用 BSS 的主信道号，覆盖范围 ±2 信道（满值脏度）；index2 用 BSS 的中心频率，覆盖范围随带宽扩展——20MHz ±2、40MHz ±4、80MHz ±8、160MHz ±16（半值脏度）。最后 `wlanSortChannel()`（`wlan_lib.c:11731`）用堆排序按脏度升序排列所有信道，取脏度最低的那条。

打个比方：一个吵闹的邻居（BSS）不仅影响自己门前的铺位（主信道，满值脏度），噪音还会按门窗开度（带宽）扩散到隔壁几间铺位，但隔壁听到的噪音只有门前的一半（半值脏度）。RSSI 越高的邻居噪音越大——50 dBm 以内的近距离邻居是装修级别的重噪音（52），80 dBm 以外的远距离邻居只是隐约可闻（32）。hostapd 的公式用 `channel_time_busy` 和 `nf` 计算连续的干扰因子，MTK 用 RSSI 阈值做离散分级。MTK 的方法更粗糙（不考虑底噪、不区分 WiFi 和非 WiFi 干扰），但胜在不需要内核的 survey 数据采集机制——它直接从扫描结果的 BSS 描述符中提取信息，避免了 hostapd ACS 中"驱动没实现 `get_survey` 所以数据为空"的退化问题（§4.2 末段）。

三种 ACS 实现恰好呈现了一个**信息不对称**的递进关系：hostapd 自主 ACS 只能拿到内核 `channel_time_busy` 和 `nf` 这两个标量——它知道信道"忙不忙"和"底噪多高"，但不知道干扰源是什么；MTK 驱动的 vendor ACS 能拿到扫描结果中的 AP 数量和 RSSI——它知道"有多少邻居 AP"和"每个邻居有多吵"，但不区分干扰类型；QCOM 的 host 驱动通过主动扫描（`sap_channel_sel()`）获取最丰富的 BSS 信息——不仅有 RSSI 和数量，还有 HT/VHT/EHT 能力、信道宽度、中心频率，这些信息被 `sap_compute_spect_weight()` 综合为带宽感知的加权评分。三者的共性是：**选频决策权都下放在信息最丰富的一层**——hostapd 在用户态能拿到 survey 数据就自己算，MTK 在驱动层能拿到 BSS 描述符就自己评，QCOM 在 host 驱动层能拿到完整扫描结果就自己评分。这个趋势是不可逆的：随着 IoT 设备密度增加和 6GHz 频段引入更多非 WiFi 干扰源，选频算法只会越来越依赖底层数据的丰富程度，而这些数据天然产生在驱动或固件层——hostapd 开源 ACS 的 survey 数据劣势只会扩大。

一个具体的例子能说明这种信息差异有多大：假设 2.4GHz 频段上同时存在一个持续发射的微波炉（ch6）和一个跳频的蓝牙耳机（也在 ch6 附近）。hostapd 的 survey 数据看到的是两条信道都很忙——`channel_time_busy` 都很高，干扰因子算出来差不多，选哪条都一样。MTK 的扫描结果看不到微波炉（它不发 Beacon），脏度评分也捕获不到非 WiFi 干扰。固件的频谱分析则能看到时域特征：微波炉是持续的宽带脉冲，蓝牙是间歇的窄频跳动——固件据此给微波炉所在信道更高的惩罚权重，最终选出的信道质量显著优于前两者的盲选。

## 4.6 三向对比

| 维度                 | hostapd 自主 ACS                                             | QCOM ACS offload                                             | MTK vendor ACS                                               |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **选频主体**         | hostapd（用户空间）                                          | QCOM host 驱动（sap_ch_select.c）                            | MTK 驱动（P2P Role FSM）                                     |
| **数据源**           | nl80211 survey dump（内核采集）                              | 驱动主动扫描结果（BSS RSSI + 数量 + 信道状态 + 监管功率）    | 驱动扫描结果（BSS 描述符）                                   |
| **干扰因子**         | `pow(10,nf/5) + (busy-tx)/(total-tx) × 2^(10^(nf/10)-10^(min_nf/10))`（详见 §4.2） | host 侧加权评分：rssi_bss_weight + chan_status_weight + power_weight（详见 §4.4） | AP 数量 + RSSI 三档脏度（52/40/32）+ 带宽扩展覆盖（详见 §4.5） |
| **非 WiFi 干扰感知** | 间接（通过底噪升高间接反映）                                 | 间接（通过 scan 结果中间接反映）                             | 无（只看 AP 数量和 RSSI）                                    |
| **触发方式**         | hostapd 主动 scan + survey                                   | `sap_channel_sel()` 发起 host 侧扫描                         | `NL80211_VENDOR_SUBCMD_ACS` → mbox                           |
| **异步模型**         | eloop callback 链                                            | scan callback → `sap_select_channel()`                       | vendor event callback                                        |
| **与 hostapd 关系**  | hostapd 自主完成                                             | hostapd 发起，host 驱动完成（固件只执行扫描）                | 标准流程走 hostapd ACS；vendor 路径走驱动 ACS                |
| **优点**             | 全开源，可调试；不依赖厂商                                   | 主动扫描获取更丰富 BSS 信息；带宽感知评分                    | 不依赖内核 survey；有 SCC 捷径                               |
| **缺点**             | survey 数据有限（内核刷新频率 ~Hz 级）                       | 评分基于 BSS 信息，不区分非 WiFi 干扰类型                    | 评分粗糙（不区分干扰类型）；vendor 路径非标准                |

![ACS 三向对比：hostapd 自主 / QCOM offload / MTK vendor](assets/10b-SAP%EF%BC%88%E4%BA%8C%EF%BC%89hostapd-%E5%90%AF%E5%8A%A8%EF%BC%9AACS%E3%80%81BSS%E3%80%81Beacon-%E5%88%B0%E7%A9%BA%E5%8F%A3/10b-acs-comparison.svg)

三种 ACS 都翻完牌了——hostapd 靠 survey 标量、MTK 靠扫描描述符、QCOM 靠主动扫描的完整 BSS 信息，各有各的数据优势。但选好信道只是拿到了铺位，能不能开张，还要看这个铺位有没有落在雷达的地盘上。

# 5 DFS CAC：如果选到了 DFS 信道

如果 ACS 选出的信道落在 DFS（Dynamic Frequency Selection）频段（5GHz 的 52-64、100-140 信道），事情还没完。雷达是第一优先级用户，WiFi 是次要用户——AP 必须先监听 60 秒（CAC，Channel Availability Check），确认没有雷达信号才能发射。

## 5.1 DFS 检查流程

`hostapd_setup_interface_complete()` → `hostapd_setup_interface_complete_sync()` 中，选好信道后会调用 `hostapd_handle_dfs()`：

```c
// src/ap/dfs.c:836-951
int hostapd_handle_dfs(struct hostapd_iface *iface)
{
    // 6GHz 频段不需要传统 DFS
    if (is_6ghz_freq(iface->freq))
        return 1;

    do {
        // 获取当前配置的起始信道索引和使用的信道数
        start_chan_idx = dfs_get_start_chan_idx(iface, &start_chan_idx1);
        n_chans = dfs_get_used_n_chans(iface, &n_chans1);

        // 查询 regulatory 数据库，确定当前信道组合的 CAC 时长
        iface->dfs_cac_ms = dfs_get_cac_time(iface, start_chan_idx, n_chans);

        // 检查配置信道中是否有雷达信道
        res = dfs_check_chans_radar(iface, start_chan_idx, n_chans);
        if (!res) return 1;  // 都不是雷达信道，跳过

        // 检查信道是否已经 DFS 可用（之前做过 CAC）
        res = dfs_check_chans_available(iface, start_chan_idx, n_chans);
        if (res) return 1;   // 已经可用，跳过 CAC

        // 检查信道是否不可用（如 NOL 列表中）
        res = dfs_check_chans_unavailable(iface, start_chan_idx, n_chans);
        if (res) {
            // 信道不可用 → 换一条可用信道
            if (dfs_set_valid_channel(iface, skip_radar) < 0)
                break;  // 无可用信道，退出循环
        }
    } while (res);  // 一直换到找到可用信道

    // 启动 CAC
    hostapd_set_state(iface, HAPD_IFACE_DFS);
    res = hostapd_start_dfs_cac(iface, ...);
    return 0;  // CAC 异步进行，完成后回调 hostapd_dfs_complete_cac()
}
```

**CAC 时长**不是固定的 60 秒。`dfs_get_cac_time()` 遍历配置中的所有子信道，取每个信道 `dfs_cac_ms` 字段的最大值——这个值由 regulatory 数据库设定，而非 hostapd 自行计算。典型默认值：

- 20MHz 单信道：60 秒
- 40MHz（2 条 20MHz 子信道）：60 秒
- 80MHz（4 条）：60 秒
- 160MHz（8 条）：120 秒
- 320MHz（16 条）：120 秒

打个比方：雷达频段像军用机场周边的空域，雷达是随时起降的军机，WiFi 只是借用空域的次要用户。AP 要在这里设点，得先静默监听满整个 CAC 检查期——竖起耳朵听满 60 秒（160/320MHz 还要听满 120 秒），确认没有军机起飞，才敢通电挂牌开张。

如果 CAC 期间检测到雷达信号，`hostapd_dfs_radar_detected()` 触发以下流程：

1. 调用 `set_dfs_state()` 将当前信道标记为 `HOSTAPD_CHAN_DFS_UNAVAILABLE`
2. 如果启用了 ACS，重新发起 ACS 选一条新信道
3. 如果没有 ACS，直接 disable 接口，返回失败

NOL 的生命周期跨越 hostapd 和内核两层：hostapd 只负责"标记信道状态"（UNAVAILABLE/USABLE），真正的 30 分钟计时器由内核的 cfg80211 regulatory 子系统管理——这是 IEEE 802.11 规范的要求，NOL 计时不能依赖用户态进程的可靠性（hostapd 可能被 kill、可能崩溃）。30 分钟到期后，内核通过 `NL80211_RADAR_NOP_FINISHED` 事件通知 hostapd，`hostapd_dfs_nop_finished()` 收到后调用 `set_dfs_state()` 将信道重新标记为 `HOSTAPD_CHAN_DFS_USABLE`，该信道才重新进入 ACS 的候选池。打个比方：铺位被标记为"雷达保护区"后，计时的不是租户（hostapd），而是市政管理部门（内核 regulatory 子系统）——30 分钟到期后由管理部门发出正式解禁通知（`NL80211_RADAR_NOP_FINISHED`），租户只管接通知、更新自己的施工图纸。这个分层是故意的：计时器的可靠性不能依赖用户态进程（hostapd 可能被 kill、可能崩溃），必须由内核保证——就像市政审批的有效期不能由商户自己记录，必须由政府系统统一管理。

## 5.2 DFS offload

部分驱动支持 DFS offload（`WPA_DRIVER_FLAGS_DFS_OFFLOAD`），此时 CAC 完全由固件负责。hostapd 的 `hostapd_handle_dfs_offload()`（`dfs.c:1588`）只做最简单的检查：如果 `cac_started` 标志已置位，说明这是 CAC 完成后的回调，重置标志并返回 1（继续 setup）；否则调用 `hostapd_is_dfs_required()` 检查当前频率是否需要 DFS——需要则返回 0（等待驱动通知），不需要则返回 2（跳过 DFS 继续 setup）。QCOM 驱动支持 DFS offload——固件独立执行 CAC 和雷达检测，检测到雷达后通过 `WMI_DFS_RADAR_EVENTID` 通知 host 端，经 SAP FSM 的 `eSAP_DFS_RADAR_DETECT` 事件触发信道切换或 ACS 重选。与 hostapd 自主 DFS 相比，offload 模式下 hostapd 不参与 CAC 计时和雷达检测——它只关心"信道能不能用"这个最终结论，不关心"怎么监听雷达"的过程。

# 6 hostapd_setup_bss：八道硬装工序

信道确定后（或 CAC 完成后），`hostapd_setup_interface_complete_sync()` 调用 `hostapd_setup_bss()`。这是接入点初始化的最后一棒，8 个步骤的顺序不是随意的——每一步都依赖前一步的结果。

```c
// src/ap/hostapd.c:1393-1741
static int hostapd_setup_bss(struct hostapd_data *hapd, int first,
                             bool start_beacon)
{
```

## 6.1 BSSID 分配

```c
if (!first || first == -1) {
    if (!is_zero_ether_addr(conf->bssid)) {
        // 配置指定了 BSSID，直接用
        os_memcpy(hapd->own_addr, conf->bssid, ETH_ALEN);
    } else {
        // 自动分配：在 radio MAC 上递增最后一个字节
        do {
            inc_byte_array(hapd->own_addr, ETH_ALEN);
        } while (mac_in_conf(hapd->iconf, hapd->own_addr));
    }
    // 创建 BSS 网络接口
    hostapd_if_add(hapd->iface->bss[0], WPA_IF_AP_BSS,
                   conf->iface, addr, hapd, &hapd->drv_priv, ...);
}
```

**为什么第一步**：BSSID 是所有后续操作的标识符。`hostapd_if_add()` 向内核注册网络接口（`wlan1` 等），接口名和 MAC 地址必须在 SSID、加密等配置之前确立——因为后续的 `hostapd_set_ssid()` 和加密设置都要通过这个接口下发。注意代码中的 `&hapd->drv_priv` 是输出参数——驱动内部的 `hapd_init()` 在创建接口时分配驱动私有数据结构，并通过这个指针回写给 hostapd。这个 `drv_priv` 随后在 `setup_interface()` 第 2 步被共享给同 iface 下的所有 BSS（Multi-BSSID 场景），在接口销毁时由 `hostapd_cleanup_driver()` 调用 `hapd_deinit()` 释放。

## 6.2 flush 旧 STA

```c
if (flush_old_stations)
    hostapd_flush(hapd);
```

**为什么第二步**：如果这个 BSS 之前运行过（比如重启 SAP），内核中可能残留旧 STA 的关联信息。flush 把它们清干净，防止旧 STA 在新 BSS 启动后立即恢复关联。

如果跳过这一步会怎样？内核的 `struct sta_info` 链表中会残留旧 STA 的记录——包括它们的 MAC 地址、关联状态、AID（Association ID）分配、以及可能的 PMK 缓存。当新 BSS 启动后，这些旧 STA 如果还在范围内，可能会尝试用旧的 association 恢复通信。更隐蔽的问题是 AID 冲突：旧 STA 占用的 AID 不会被释放，新 STA 关联时可能被分配到已被占用的 AID，导致 TIM（Traffic Indication Map）位图错乱——AP 以为某个 AID 有缓存数据要发，实际上那个 STA 早就不存在了。这就像新店开业前必须清场——昨天的客人不走，拿着旧房卡试图恢复入住，前台分配了冲突的房间号，整个系统就乱了。`hostapd_flush()` 调用内核的 `NL80211_CMD_DEL_STATION` 把这些残留记录一次性清除——开业前把旧客人的房卡全部注销。

## 6.3 PSK 推导（PBKDF2）

```c
if (hostapd_setup_wpa_psk(conf)) {
    return -1;
}
```

**为什么第三步**：PSK 是后续 WPA 模块初始化的输入。`hostapd_setup_wpa_psk()` 内部：如果配置提供了 `wpa_passphrase`，就用 PBKDF2（`pbkdf2_sha1(passphrase, ssid, 4096 iterations)`）推导出 PMK——其中 `ssid` 参数取自已由 `hostapd_get_ssid()` 读入的 `conf->ssid.ssid`（PBKDF2 的盐），推导出的 PMK 又是 §6.6 `hostapd_setup_wpa()` 的输入，所以 PSK 推导必须排在 SSID 下发（第 4 步）之前。4096 次迭代的 SHA-1 保证了即使有人抓到了 WPA 四次握手的帧，也很难暴力破解出密码。

## 6.4 SSID 设置

```c
ssid_len = hostapd_get_ssid(hapd, ssid, sizeof(ssid));
// 和配置文件比对，不一致则用配置文件的值覆盖
if (set_ssid && hostapd_set_ssid(hapd, conf->ssid.ssid,
                                 conf->ssid.ssid_len)) {
    return -1;
}
```

**为什么第四步**：SSID 是 Beacon 的核心字段，而 Beacon 下发前必须确认 SSID 已同步到驱动。`hostapd_set_ssid()` 通过 nl80211 把 SSID 传给内核。（`hostapd_get_ssid()` 的读取在第三步 PSK 之前已经完成，这里把读与设合并展示。）

## 6.5 RADIUS / ACL / WPS 等模块初始化

```c
hostapd_bss_radius_init(hapd);   // RADIUS 认证服务器连接
hostapd_acl_init(hapd);          // MAC ACL
hostapd_init_wps(hapd, conf);    // WPS（WiFi Protected Setup）
authsrv_init(hapd);              // 内置认证服务器
ieee802_1x_init(hapd);           // IEEE 802.1X
```

**为什么第五步**：这些模块是 STA 连接时的认证基础设施，必须在 Beacon 发射之前就位。否则 Beacon 发出去了，STA 来认证，结果 RADIUS 还没连上——直接认证失败。

## 6.6 WPA 初始化

```c
if ((conf->wpa || conf->osen) && hostapd_setup_wpa(hapd))
    return -1;
```

**为什么第六步**：WPA 状态机（`wpa_auth`）是四次握手的管理者，依赖 PSK（第 4 步）和 RADIUS（第 5 步）。必须在 Beacon 中广播 WPA/RSN IE 之前初始化好——因为这些 IE 的内容来自 WPA 配置。

## 6.7 Beacon 组装与下发

```c
if (start_beacon && hostapd_start_beacon(hapd, flush_old_stations) < 0)
    return -1;
```

**为什么第七步**：Beacon 的 IE 内容依赖 SSID（第 3 步）、加密参数（第 4+6 步）、WPS IE（第 5 步）。所有信息就位后才能组装。

## 6.8 WPA 密钥初始化

```c
if (hapd->wpa_auth && wpa_init_keys(hapd->wpa_auth) < 0)
    return -1;
```

**为什么第八步**：组密钥（GTK）的初始化必须在 WPA 状态机就位后进行。它在 Beacon 发射之后——因为这个操作不阻塞 Beacon，但如果 WPA 状态机没有 GTK，第一个 STA 关联时四次握手会失败。

这个顺序设计暴露了 hostapd 的一个已知时间窗口：第 7 步 Beacon 已经在空口上发射，SSID、RSN IE 等信息完整，STA 看到 Beacon 后可能立即发起 Auth 和 Assoc——但此时第 8 步的 WPA key 尚未初始化，GTK 不存在。如果 STA 在这个几毫秒的窗口内完成了四次握手的前两条消息，AP 侧会因为找不到 GTK 而无法完成 Group Key 插入步骤。这个窗口在实践中极短（`hostapd_setup_bss()` 的第 7 步到第 8 步之间只有几行代码），而且大多数 STA 在收到 Beacon 后还需要经过扫描、信道切换、Auth 交换等步骤，到达 Assoc 阶段时 GTK 通常已经就绪——但在极端压力测试或 STA 预缓存了 BSSID 信息的场景下，这个窗口可能被命中。这是单线程顺序初始化的固有约束：没有"所有模块同时就绪"的原子操作，只有"按依赖顺序逐个就绪"的串行过程。回到民宿的比喻：招牌灯已经亮了（Beacon 在空口发射），但前台的保险柜还没装好（GTK 未初始化）——如果恰好有客人在这个瞬间推门进来（STA 收到 Beacon 立即发 Auth），前台能确认身份（Auth 通过），但到了发房卡的环节（四次握手的 Group Key 步骤）就会卡壳，因为保险柜里还没有钥匙可发。

**任何一步失败会怎样？** 八步中每一步失败都 `return -1`，但错误信息各不相同——这些日志是排查 SAP 启动失败的第一线索：SSID 设置失败报 `"Could not set SSID for kernel driver"`（`hostapd.c:1586`），PSK 推导失败报 `"WPA-PSK setup failed"`（`hostapd.c:1578`），RADIUS 初始化失败由 `hostapd_bss_radius_init()` 返回非零（`hostapd.c:1612`），802.1X 初始化失败报 `"IEEE 802.1X initialization failed"`（`hostapd.c:1662`），Beacon 下发失败由 `hostapd_start_beacon()` 返回 -1（`hostapd.c:1734`）。不管哪一步失败，-1 都向上传播到 `hostapd_setup_interface_complete_sync()`（`hostapd.c:2525-2526`），最终调用 `hostapd_disable_iface()` 将接口设为 `HAPD_IFACE_DISABLED` 状态。注意这里没有部分回滚——已初始化的模块（如 RADIUS client、ACL、WPS）由 `hostapd_free_hapd_data()` 统一释放，不做逐步反向清理。这就像灯牌安装——做到一半发现电路有问题，不是把已装好的灯逐个拆下来，而是整块招牌标记为"不合格"，统一拆掉重做。

这八步的顺序反映了**初始化依赖图**：每一步的输出是下一步的输入。反过来排会导致模块初始化时需要的配置还不存在——比如先初始化 WPA 再设置 SSID，WPA 的 RSN IE 里就没有正确的 SSID 信息。

# 7 ieee802_11_set_beacon：招牌灯的制作

`hostapd_start_beacon()` 的核心工作是调用 `ieee802_11_set_beacon()`，而它又委托给 `__ieee802_11_set_beacon()`：

```c
// src/ap/hostapd.c:1293-1319
static int hostapd_start_beacon(struct hostapd_data *hapd,
                                bool flush_old_stations)
{
    if (!conf->start_disabled && ieee802_11_set_beacon(hapd) < 0)
        return -1;

    // 发送广播 deauth，清除旧 STA
    if (flush_old_stations && !conf->start_disabled &&
        conf->broadcast_deauth) {
        os_memset(addr, 0xff, ETH_ALEN);
        hostapd_drv_sta_deauth(hapd, addr,
                               WLAN_REASON_PREV_AUTH_NOT_VALID);
    }
    return 0;
}
```

## 7.1 Beacon 帧的 head 和 tail 分工

`ieee802_11_build_ap_params()` 构建 `wpa_driver_ap_params`，这个结构体最关键的两个字段是 `head` 和 `tail`：

```c
// src/ap/beacon.c:2149-2606
int ieee802_11_build_ap_params(struct hostapd_data *hapd,
                               struct wpa_driver_ap_params *params)
{
    // head: IEEE 802.11 MAC header + 固定字段 + TIM 前 IE
    head = os_zalloc(BEACON_HEAD_BUF_SIZE);   // 256 字节
    tail = os_malloc(BEACON_TAIL_BUF_SIZE);    // 1500+ 字节

    // --- head 部分 ---
    head->frame_control = IEEE80211_FC(WLAN_FC_TYPE_MGMT,
                                       WLAN_FC_STYPE_BEACON);
    // ...
    *pos++ = WLAN_EID_SSID;       // SSID IE
    pos = hostapd_eid_supp_rates(hapd, pos);  // Supported Rates IE
    pos = hostapd_eid_ds_params(hapd, pos);   // DS Parameter Set IE
    // head_len 到此为止

    // --- tail 部分 ---
    tailpos = hostapd_eid_country(hapd, tailpos, ...);   // Country IE
    tailpos = hostapd_eid_ht_capabilities(hapd, tailpos); // HT Capabilities
    tailpos = hostapd_eid_ht_operation(hapd, tailpos);    // HT Operation
    tailpos = hostapd_eid_vht_capabilities(hapd, tailpos, 0); // VHT Cap
    tailpos = hostapd_eid_vht_operation(hapd, tailpos);   // VHT Operation
    tailpos = hostapd_eid_he_capab(hapd, tailpos, IEEE80211_MODE_AP);
    tailpos = hostapd_eid_he_operation(hapd, tailpos);
    tailpos = hostapd_eid_eht_capab(hapd, tailpos, IEEE80211_MODE_AP);
    tailpos = hostapd_eid_eht_operation(hapd, tailpos);
    tailpos = hostapd_get_wpa_ie(hapd, tailpos, ...);     // RSN IE
    tailpos = hostapd_eid_wmm(hapd, tailpos);             // WMM IE
    // ... 更多 IE
    tailpos = hostapd_eid_rnr(hapd, tailpos, ...);        // Reduced Neighbor Report

    params->head = (u8 *) head;
    params->head_len = head_len;
    params->tail = tail;
    params->tail_len = tail_len;
}
```

**为什么要拆成 head 和 tail？**

这源于 nl80211 的 Beacon 模板机制。内核的 `NL80211_ATTR_BEACON_HEAD` 和 `NL80211_ATTR_BEACON_TAIL` 不是随便拆的——它们之间夹着内核/驱动自己填充的 **TIM IE**（Traffic Indication Map）。TIM 是动态的（每个 Beacon 周期都可能变，因为 STA 的缓存数据状态在变），不能写死在模板里。

所以 head 包含 TIM 之前的所有固定 IE——只有三个，都是小而固定的：SSID（最长 32 字节）、Supported Rates（通常 8 字节）、DS Parameter Set（3 字节，标识当前信道号）。tail 包含 TIM 之后的所有 IE，按构建顺序依次是：Country（国家码 + 信道列表，可变长度）、Extended Supported Rates、MBSSID（Multi-BSSID 元素，如果启用）、HT Capabilities（26 字节）+ HT Operation、VHT Capabilities（12 字节）+ VHT Operation、Reduced Neighbor Report（RNR，邻居 AP 的信道信息）、HE Capabilities + HE Operation、EHT Capabilities + EHT Operation、RSN IE（加密套件列表，可超 100 字节）、WMM 参数。内核在发送每个 Beacon 时填充当前的 TIM 在 head 和 tail 之间。

**为什么 RSN IE 在 tail 里？**

因为 RSN IE 长度可能超过 100 字节（尤其是包含多个 AKM suite 和 cipher suite 时），放在 head（只有 256 字节预算）很容易溢出。head 里只放小而固定的 IE，大 IE 全部放 tail。

**head/tail 拆分对驱动实现的约束**：这个两段式模板不只是 hostapd 的内部设计——它直接决定了驱动和固件怎么处理 Beacon。固件收到模板后，必须知道 TIM IE 插入点在哪里。这就是为什么 `wma_unified_bcn_tmpl_send()` 中有一个 `tim_ie_offset` 参数——hostapd 在构建模板时记录了 TIM 的偏移位置，驱动把这个偏移传给固件，固件在每个 Beacon 周期只需要在这个偏移位置覆写当前的 TIM bitmap，而不需要重新解析整个 Beacon 帧。head 和 tail 在内存中通常是两块独立的缓冲区（head 256 字节，tail 1500+ 字节），固件的 DMA 引擎需要分别从两个地址搬运数据，中间插入 TIM。这种"三段拼接"的 DMA 模式比单块连续缓冲区更复杂，但换来了 TIM 更新的高效——固件只需要写入几十字节的 TIM，而不需要每次重写整个 1700+ 字节的 Beacon。

这就像招牌灯的制作：head 是招牌框架（固定位置、固定大小），tail 是招牌上的装饰灯带（可以很长、可以换），中间的 TIM 是实时更新的"今日有空房"指示灯——这部分由内核动态填充，不能预写在模板里。

## 7.2 下发到驱动

> 接下来 Beacon 模板要离开 hostapd 的用户态空间，穿过 netlink socket 进入内核的 cfg80211 子系统。这是 hostapd 和内核之间的信任边界——hostapd 以 root 权限发送命令，内核负责校验和转发给驱动。

Beacon 参数构建完成后，通过 `hostapd_drv_set_ap()` 下发：

```c
// src/ap/ap_drv_ops.h:244-249
static inline int hostapd_drv_set_ap(struct hostapd_data *hapd,
                                     struct wpa_driver_ap_params *params)
{
    if (hapd->driver == NULL || hapd->driver->set_ap == NULL)
        return 0;
    return hapd->driver->set_ap(hapd->drv_priv, params);
}
```

对于 nl80211 驱动，`set_ap` 回调指向 `wpa_driver_nl80211_set_ap()`（`driver_nl80211.c:5129`），它把 `wpa_driver_ap_params` 转成 netlink 属性包发送给内核。但 hostapd 实际发送的命令码不是 `NL80211_CMD_START_AP`，而是 `NL80211_CMD_NEW_BEACON`（`driver_nl80211.c:5136`）——后者是前者的旧别名（`nl80211.h:1357`，`NL80211_CMD_NEW_BEACON = NL80211_CMD_START_AP`，同枚举值）。为什么 hostapd 用旧名字？因为 hostapd 的 nl80211 驱动代码比 `NL80211_CMD_START_AP` 这个名字更早存在——最初 nl80211 只有 `NL80211_CMD_NEW_BEACON`（"新建 Beacon"语义），后来内核为了统一命名风格（AP 操作应该叫"启动 AP"而非"新建 Beacon"）添加了 `NL80211_CMD_START_AP`，但保留了旧名字作为别名以保证向后兼容。内核侧的 handler 是 `nl80211_start_ap()`——它同时注册为两个命令码的处理函数，收到任何一个都走同一段逻辑。

# 8 nl80211_start_ap：挂牌的三道审批

内核收到这个命令后（不管是 `NL80211_CMD_START_AP` 还是它的旧别名 `NL80211_CMD_NEW_BEACON`，§7.2 已解释），由 `nl80211_start_ap()` 处理。它做了三个阶段的工作：

## 8.1 第一阶段：接口类型校验

```c
// kernel/net/wireless/nl80211.c（QCOM:5976 / MTK:5836）
static int nl80211_start_ap(struct sk_buff *skb, struct genl_info *info)
{
    // 只有 AP 或 P2P GO 接口能 start_ap
    if (dev->ieee80211_ptr->iftype != NL80211_IFTYPE_AP &&
        dev->ieee80211_ptr->iftype != NL80211_IFTYPE_P2P_GO)
        return -EOPNOTSUPP;

    // 驱动必须实现 start_ap 回调
    if (!rdev->ops->start_ap)
        return -EOPNOTSUPP;

    // 不能重复 start
    if (wdev->links[link_id].ap.beacon_interval)
        return -EALREADY;

    // 必需属性缺一不可
    if (!info->attrs[NL80211_ATTR_BEACON_INTERVAL] ||
        !info->attrs[NL80211_ATTR_DTIM_PERIOD] ||
        !info->attrs[NL80211_ATTR_BEACON_HEAD])
        return -EINVAL;
```

**为什么这么多校验？** `NL80211_CMD_START_AP` 是内核中最复杂的 netlink 命令之一，支持的属性超过 30 个（从 Beacon head/tail 到 MBSSID 配置到 FILS discovery 到 SAE offload）。cfg80211 没有为每个属性做 schema 验证——它信任用户空间的 hostapd 发送正确格式的数据。但关键缺失（比如没有 Beacon head）必须立刻拒绝，否则驱动收到不完整的数据可能崩溃。

这里存在一个重要的**信任边界**：nl80211 是用户态和内核态之间的接口，hostapd 以 root 权限运行，通过 netlink socket 发送命令。接口类型校验（`NL80211_IFTYPE_AP` / `NL80211_IFTYPE_P2P_GO`）是内核对用户态的**最小信任验证**——它不验证 Beacon 内容是否合法（那是驱动的事），但必须确认"你这个接口确实有资格当 AP"。如果内核不做这个检查，一个恶意的用户态进程可以对 monitor 模式接口发送 `NL80211_CMD_START_AP`，驱动可能会在不该发 Beacon 的接口上尝试发射——轻则驱动崩溃，重则在 regulatory 不允许的信道上违规发射。`beacon_interval` 的重复检查则是防止同一个接口被 start 两次导致驱动内部状态混乱。就像商场管理员审批开店申请——不审查你的广告内容是否合规，但必须确认你有租赁合同和营业执照。任何人都能对任何位置挂牌的话，没有资质的商户可能在禁区开业，轻则商场管理混乱，重则违反法规。这些校验构成了"用户态说要做什么"和"内核允许做什么"之间的防线。

nl80211 的 AP 路径（`NL80211_CMD_START_AP`）和 STA 路径（`NL80211_CMD_CONNECT`）共享同一个 genl family（`nl80211`），但命令集完全不同——AP 侧关注的是 Beacon 模板、DTIM、MBSSID、SAE offload 这些"发射侧"参数，STA 侧关注的是 SSID、频段列表、BSSID 偏好这些"选择侧"参数。为什么不拆成两个 genl family？因为 AP 和 STA 共享同一个物理设备（`struct wiphy`）和同一套 regulatory 状态——拆开的话，信道查询、功率限制、国家码设置这些跨角色共享的逻辑就需要在两个 family 之间同步。合在一个 family 里，驱动只需要注册一套 ops，通过 `NL80211_CMD_*` 命令码区分"你现在要我做什么"——这是"一个接口，多种角色"的 Unix 哲学在无线子系统中的体现。如果 AP 和 STA 真的拆成两个 genl family，用户态的 wpa_supplicant 和 hostapd 就需要各自维护一套 netlink socket、一套消息序列化/反序列化代码、一套错误处理逻辑——信道查询这种跨角色操作还得在两个 family 之间做同步，任何一个 family 的 regulatory 状态更新漏同步到另一个，就会出现 AP 以为信道可用但 STA 那边已经收到 NO_IR 通知的不一致 bug。

## 8.2 第二阶段：netlink 属性解析

```c
    // 解析 Beacon head + tail
    err = nl80211_parse_beacon(rdev, info->attrs, &params->beacon);
    
    // 解析 Beacon interval / DTIM period
    params->beacon_interval = nla_get_u32(info->attrs[NL80211_ATTR_BEACON_INTERVAL]);
    params->dtim_period = nla_get_u32(info->attrs[NL80211_ATTR_DTIM_PERIOD]);

    // 校验 beacon_interval 范围（10-10000 TU）
    err = cfg80211_validate_beacon_int(rdev, dev->ieee80211_ptr->iftype,
                                       params->beacon_interval);
    // ... 后续解析 ...

    // 解析 SSID（可选但 MLO 必填）
    if (info->attrs[NL80211_ATTR_SSID]) {
        params->ssid = nla_data(info->attrs[NL80211_ATTR_SSID]);
        params->ssid_len = nla_len(info->attrs[NL80211_ATTR_SSID]);
    }
    
    // 解析隐藏 SSID、privacy、auth type
    params->hidden_ssid = nla_get_u32(info->attrs[NL80211_ATTR_HIDDEN_SSID]);
    params->privacy = !!info->attrs[NL80211_ATTR_PRIVACY];
    
    // 解析频率/信道
    nl80211_parse_chandef(rdev, info, &params->chandef);
    
    // 验证信道是否可以发射 Beacon（regulatory 检查）
    cfg80211_reg_can_beacon_relax(&rdev->wiphy, &params->chandef, wdev->iftype);
```

关键校验有两处。第一处是 `cfg80211_validate_beacon_int()`（`util.c:2192`），它在 `beacon_interval` 解析完成后立即调用——校验范围是 10-10000 TU。为什么放在 cfg80211 层而不是留给驱动回调？因为 beacon interval 的合法范围是 802.11 规范定义的通用约束，与具体硬件无关——如果把这个校验放在每个驱动的 `start_ap()` 回调里，每个驱动都要写一遍相同的范围检查，而且写法可能不一致（有的用 `< 10`，有的用 `<= 9`），边界值行为也会出现分歧。cfg80211 做一次统一校验，驱动只管收合法数据。

不过这个校验只是最基本的范围检查——如果存在接口组合约束（比如同一 phy 上多个 AP 的 beacon interval 必须满足 GCD 关系），驱动仍然需要在自己的 `start_ap()` 中做更复杂的验证，cfg80211 通过 `cfg80211_calculate_bi_data()` 辅助但不替代。这个"cfg80211 做通用校验、驱动做硬件特定校验"的分层模式是整个 nl80211 子系统的设计原则——随着 WiFi 7 MLO 引入多链路 beacon interval 同步、EHT 引入 320MHz 带宽约束等新参数，cfg80211 层的校验职责只会越来越重，驱动侧的定制校验则被挤压到越来越窄的硬件特定领域。

第二处是 `cfg80211_reg_can_beacon_relax()`，检查频率/信道在当前 regulatory domain 下是否允许发射。`_relax` 后缀意味着：如果信道标记为 `NO_IR`（No Initiate Radiation），但已有其他 BSS 在同一信道上工作，且不要求 DFS master，则允许——这是"别人做了 CAC，你可以搭便车"的规则。

## 8.3 第三阶段：调用驱动的 start_ap

```c
    // 计算 AP params：从 Beacon tail 中提取 HT/VHT/HE/EHT cap
    nl80211_calculate_ap_params(params);
    
    // 调用驱动的 start_ap 回调
    err = rdev_start_ap(rdev, dev, params);

```

`rdev_start_ap()` 是 cfg80211 对驱动 `start_ap` ops 的薄封装：

```c
// QCOM kernel/net/wireless/rdev-ops.h:163-172
static inline int rdev_start_ap(struct cfg80211_registered_device *rdev,
                                struct net_device *dev,
                                struct cfg80211_ap_settings *settings)
{
    trace_rdev_start_ap(&rdev->wiphy, dev, settings);
    ret = rdev->ops->start_ap(&rdev->wiphy, dev, settings);
    trace_rdev_return_int(&rdev->wiphy, ret);
    return ret;
}
```

`nl80211_calculate_ap_params()` 是从 Beacon tail 的 IE 中提取 HT/VHT/HE/EHT 能力信息的过程——遍历 tail 中的 IE，找到 `WLAN_EID_HT_CAPABILITY`、`WLAN_EID_VHT_CAPABILITY`、`WLAN_EID_EXT_HE_CAPABILITY` 等，然后把指针直接指向 tail 缓冲区中的对应位置。这样驱动的 `start_ap()` 可以直接访问这些能力信息，而不需要重新解析 Beacon。

`rdev_start_ap()` 是一个薄薄的 wrapper：trace + 调用驱动 ops + trace return。真正的逻辑在驱动自己的 `start_ap` 实现中。

# 9 驱动固件 Beacon 发射：灯牌通电

> 最后一站：从内核的 cfg80211 通用层进入 QCOM/MTK 的 vendor 驱动，再下沉到固件。这一层的代码不再是 AOSP 开源——QCOM 的 WMI 和 MTK 的 mbox 都是厂商私有协议，hostapd 的控制力到此为止。

## 9.1 QCOM：WMI Beacon 模板下发

QCOM 驱动的 `start_ap` ops 走到了 `wma_vdev_set_bss_params()` → `wma_unified_bcn_tmpl_send()`：

```c
// QCOM/core/wma/src/wma_mgmt.c:2256-2346
static QDF_STATUS wma_unified_bcn_tmpl_send(tp_wma_handle wma,
                     uint8_t vdev_id,
                     const tpSendbeaconParams bcn_info,
                     uint8_t bytes_to_strip)
{
    struct beacon_tmpl_params params = {0};
    uint32_t tmpl_len, tmpl_len_aligned;
    uint8_t *frm;

    // 计算模板长度
    tmpl_len = bcn_info->beaconLength;

    // 调整 TSF 时间戳
    adjusted_tsf_le = cpu_to_le64(0ULL - wma->interfaces[vdev_id].tsfadjust);
    wh = (struct ieee80211_frame *)frm;
    A_MEMCPY(&wh[1], &adjusted_tsf_le, sizeof(adjusted_tsf_le));

    // 填充 WMI 参数
    params.vdev_id = vdev_id;
    params.tim_ie_offset = bcn_info->timIeOffset - bytes_to_strip;
    params.tmpl_len = tmpl_len;
    params.frm = frm;
    // ... CSA offset, P2P IE ...

    // 通过 WMI 发送 Beacon 模板给固件
    ret = wmi_unified_beacon_tmpl_send_cmd(wma->wmi_handle, &params);
}
```

这个函数把 Beacon 模板通过 WMI（Wireless Module Interface）命令发送给固件。WMI 是 host 驱动和固件之间的私有通信协议——在 QCOM 平台上，WMI 命令通过在共享内存中的命令队列传递。`beacon_tmpl_params` 结构体携带的关键字段包括：`vdev_id`（虚拟设备 ID，标识哪个 AP 接口）、`tim_ie_offset`（TIM IE 在模板中的偏移位置，固件据此定位覆写点）、`tmpl_len`（模板总长度）、`frm`（指向 Beacon 帧内容的指针）。`wmi_unified_beacon_tmpl_send_cmd()` 把这个结构体序列化为 WMI TLV（Type-Length-Value）格式的命令帧，写入共享内存的命令队列，固件的 WMI handler 解析后存入 Beacon 缓冲区。

Beacon 模板包含完整的 Beacon 帧内容（但不包括 TIM），固件收到后存入自己的内存。每个 Beacon Interval（通常是 100 TU = 102.4 ms），固件的硬件定时器触发，固件自动：取出模板 → 填充当前 TIM → 更新 TSF 时间戳 → 通过硬件队列发送到空口。

这里的 TSF 更新与 `tsfadjust` 字段是一对：同一 radio 上多个 BSS 的 TBTT（Target Beacon Transmission Time）是交错错开的，固件在每个 TBTT 中断触发时，把各 vdev 的 TSF 偏移经 TBTT offset 事件回报 host（`wma_tbttoffset_update_event_handler()`，`wma_mgmt.c:2423`），host 存进 `interfaces[vdev_id].tsfadjust`；下次 host 重新下发模板时，`wma_unified_bcn_tmpl_send()` 用 `0ULL - tsfadjust` 把 TSF 偏移取负写回帧头（`wma_mgmt.c:2315`），让同一交错批次里的多个 Beacon 拥有同一个 TSF 基准——TSF 是全 BSS 的时钟基准，STA 靠它对齐省电唤醒。

**host 只需要下发一次 Beacon 模板**。除非后续配置变了（比如改了 SSID、换了加密方式、启用了 WPS），否则 host 不需要再次下发。固件自主维持 Beacon 的周期性发射。

这就是为什么 hostapd 的 `hostapd_drv_set_ap()` 调用后，`ieee802_11_set_beacon()` 就算完成任务了——后续的 Beacon 发射完全由固件自治，host 不参与。

但"只下发一次"有个前提——配置不变。如果运行中配置变了（比如用户改了 SSID、启用了 WPS、HE BSS Color 冲突需要换颜色），hostapd 必须重新构建 Beacon 模板并再次下发。`ieee802_11_set_beacon()` 在整个 hostapd 生命周期中会被多次调用：`hostapd_reload_bss()`（配置重载，`hostapd.c:189`）、WPS IE 更新（`wps_hostapd.c:168`）、OWE transition 模式变化（`hostapd.c:2478`）、HE BSS Color 冲突重选（`hostapd.c:4762`）、FST（Fast Session Transfer）IE 变化（`hostapd.c:2298`）。关键区别在 `wpa_driver_nl80211_set_ap()` 中：它维护一个 `beacon_set` 标志——首次下发时为 false，用 `NL80211_CMD_NEW_BEACON`；后续更新时为 true，切换为 `NL80211_CMD_SET_BEACON`（`driver_nl80211.c:5161-5166`）。内核侧的处理函数也不同：`NL80211_CMD_NEW_BEACON` 走 `nl80211_start_ap()`（启动 AP，完整校验+初始化），`NL80211_CMD_SET_BEACON` 走 `nl80211_set_beacon()`（`nl80211.c:6292`）→ `rdev_change_beacon()`——后者只更新 Beacon 内容，不重新启动 AP，校验也更轻量（只检查接口类型和 beacon 是否已设置）。QCOM 驱动还支持增量更新：`wma_process_update_beacon_params()`（`wma_mgmt.c:1940`）通过 `paramChangeBitmap` 区分 beacon interval 变化、BSS Color 变化、protection mode 变化，只下发变化的部分而非整个模板。这就像招牌灯的维护——开业时一次性挂好整块招牌（`NL80211_CMD_NEW_BEACON`），之后换了菜单只需要更新招牌上的某一行（`NL80211_CMD_SET_BEACON`），不用把整块招牌拆下来重做。

## 9.2 MTK：mbox 消息到固件

MTK 驱动走的是另一条路。`mtk_p2p_cfg80211_start_ap()`：

```c
// MTK/os/linux/gl_p2p_cfg80211.c:1612-2000
int mtk_p2p_cfg80211_start_ap(struct wiphy *wiphy,
                              struct net_device *dev,
                              struct cfg80211_ap_settings *settings)
{
    struct MSG_P2P_START_AP *prP2pStartAPMsg;
    // ...
    prP2pStartAPMsg = (struct MSG_P2P_START_AP *)
        cnmMemAlloc(prGlueInfo->prAdapter, RAM_TYPE_MSG, sizeof(struct MSG_P2P_START_AP));
    prP2pStartAPMsg->rMsgHdr.eMsgId = MID_MNY_P2P_START_AP;
    // 填充 Beacon interval、信道、SSID、加密参数等
    // ...
    mboxSendMsg(prGlueInfo->prAdapter, MBOX_ID_0, (struct MSG_HDR *) prP2pStartAPMsg, MSG_SEND_METHOD_BUF);
}
```

MTK 使用 mbox（Mailbox）机制与固件通信。`MSG_P2P_START_AP` 是一个固定大小的消息结构体（通过 `cnmMemAlloc(prGlueInfo->prAdapter, RAM_TYPE_MSG, ...)` 从消息池分配），头部 `rMsgHdr.eMsgId` 设置为 `MID_MNY_P2P_START_AP` 标识消息类型，消息体携带 Beacon interval、信道号、SSID、加密参数以及 Beacon 模板。`mboxSendMsg()` 将消息插入 host 驱动的邮箱队列并唤醒主服务线程，主服务线程取出消息后分派给 `p2pRoleFsmRunEventPreStartAP()`，由 P2P Role FSM 处理——该函数设置 BSS 参数（信道、SSID、加密模式），并将消息体中的 Beacon 模板存入固件的 Beacon 缓冲区。之后固件的硬件定时器按 Beacon Interval 周期触发，自动取出模板、填充当前 TIM bitmap、通过硬件队列发送到空口。与 QCOM 的 WMI TLV 格式不同，MTK 的 mbox 消息是固定结构体——字段位置在编译时确定，解析更简单但扩展性较差（新增字段需要修改结构体定义并重新编译驱动和固件）。

QCOM 和 MTK 的 Beacon 发射模型殊途同归：**Beacon 模板一次性下发 → 固件自主周期发射**。只是通信机制不同——QCOM 走 WMI 命令，MTK 走 mbox 消息。

周期发射的细节两侧也一致：固件每个 Beacon Interval（通常 100 TU ≈ 102.4 ms）由硬件定时器触发，先按 `tim_ie_offset` 在 head 与 tail 之间覆写当前 TIM bitmap（有缓存帧的 STA 对应 AID 位置 1），再把最新 TSF 写回帧头时间戳字段——TSF 是全 BSS 的时钟基准，STA 靠它对齐省电唤醒，所以 TIM 覆写与 TSF 更新必须在同一拍完成，不能分两次下发。

举个例子：某拍 BSS 里三个 STA 各有缓存帧待收（AID 1、5、8），TIM bitmap 的第 1、5、8 位同时置 1，其余位清 0，固件把这段位图覆写到 `tim_ie_offset` 处；下一拍 AID 1 收完数据后它的位清 0，AID 5、8 仍保持 1——位图逐拍按缓存状态整体重算，而不是只对变化位打补丁。

## 9.3 双平台对比

| 维度                 | QCOM                                            | MTK                              |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| **Host-固件通信**    | WMI（共享内存命令队列）                         | mbox（Mailbox）                  |
| **Beacon 下发函数**  | `wma_unified_bcn_tmpl_send()`                   | `mtk_p2p_cfg80211_start_ap()`    |
| **Beacon 模板携带**  | WMI beacon template 命令                        | `MSG_P2P_START_AP` 消息的一部分  |
| **接收入口**         | WMI command handler                             | `p2pRoleFsmRunEventPreStartAP()` |
| **驱动状态机**       | SAP FSM（INIT → STARTING → STARTED → STOPPING） | P2P Role FSM                     |
| **后续 Beacon 更新** | WMI beacon update 命令（TBTT update）           | mbox beacon update 消息          |
| **共通点**           | Beacon 模板一次性下发，固件自主周期发射         | 同左                             |

![hostapd_iface 状态机](assets/10b-SAP%EF%BC%88%E4%BA%8C%EF%BC%89hostapd-%E5%90%AF%E5%8A%A8%EF%BC%9AACS%E3%80%81BSS%E3%80%81Beacon-%E5%88%B0%E7%A9%BA%E5%8F%A3/10b-state-machine.svg)

# 10 总结与下一站

这一章，从 AIDL 的那一行代码出发，我们完整追踪了 hostapd 从接收到请求到 Beacon 信号发射的整个链路：

```
Hostapd::addAccessPoint() AIDL
  → addAccessPointInternal() 分派
    → addSingleAccessPoint() 生成配置文件
      → hostapd_add_iface() + hostapd_enable_iface()
        → hostapd_setup_interface()  [入口]
          → setup_interface()  [准备：phy、BSSID、ctrl iface、国家码]
            → setup_interface2()  [核心决策]
              → hostapd_get_hw_features()  [硬件能力]
              → hostapd_select_hw_mode()  [ACS 或直接选频]
                → acs_init()  [ACS 异步回路]
                  → acs_request_scan() → acs_scan_complete()
                    → acs_study_options() → acs_find_ideal_chan()
              → hostapd_handle_dfs()  [DFS CAC 60秒]
          → hostapd_setup_interface_complete()
            → hostapd_setup_bss()  [8步：BSSID→flush→SSID→PSK→RADIUS→WPA→Beacon→Keys]
              → hostapd_start_beacon()
                → ieee802_11_set_beacon()
                  → ieee802_11_build_ap_params()  [head + tail]
                    → hostapd_drv_set_ap()  [nl80211]
                      → NL80211_CMD_NEW_BEACON (=NL80211_CMD_START_AP)  [内核]
                        → nl80211_start_ap()  [校验→解析→rdev_start_ap()]
                          → QCOM: wma_vdev_set_bss_params() → wma_unified_bcn_tmpl_send() → WMI → 固件
                          → MTK:  mtk_p2p_cfg80211_start_ap() → MID_MNY_P2P_START_AP → mbox → 固件
```

在这个过程中，`hostapd_iface` 的状态经历了完整的变迁：

```
UNINITIALIZED → COUNTRY_UPDATE → ACS → DFS → ENABLED
```

每一项状态变迁都是异步的：

- `ACS` 状态等待扫描和分析完成
- `DFS` 状态等待 60-120 秒的 CAC
- 只有两个异步阶段都通过后才进入 `ENABLED`

招牌灯亮了，Beacon 信号在 2.4GHz/5GHz 空口上有节奏地闪烁着。施工队忙完了，民宿正式挂牌营业。

但有个问题——招牌灯亮起的瞬间，已经有眼尖的客人（STA）看到了 SSID，Auth 帧已经在路上了。hostapd 的前台还来不及喘口气，就得开始接待：Auth 和 Association 怎么在 AP 侧处理？WPA 四次握手又怎么反向运转？

下一章，我们走进 hostapd 的前台大厅——看 STA 来到 SAP 的门口敲门，hostapd 怎么给它办入住。
