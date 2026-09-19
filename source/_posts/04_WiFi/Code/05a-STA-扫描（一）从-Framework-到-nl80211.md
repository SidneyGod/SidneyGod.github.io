---
title: STA 扫描（一）从 Framework 到 nl80211
top: 1
related_posts: true
abbrlink: 78044f3d
date: 2026-09-19 20:11:19
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 你打开 WiFi 列表，下拉刷新——`startScan()` 几乎立即被调用，数十个 Java 函数和 C++ 函数被依次执行，最终一条 `NL80211_CMD_TRIGGER_SCAN` 命令被发往内核。这不是一个简单的「扫一下」——这是一次**四层精心编排的协作**：Framework 的 `WifiScanningServiceImpl` 是战术指挥中心，接收各方扫描请求、合并同类项、排队分派；`ScanRequestProxy` 是节流阀，防止操作员无限制地按发射按钮烧坏设备；wificond 是翻译官，把指挥中心的 Java 指令翻译成天线能执行的 nl80211 属性；内核 cfg80211 是天线控制器，验证频率可用性后把真正的 Probe Request 发射任务交给驱动和固件。

在 Supplicant 启动篇 中，我们讲完了 `wpa_supplicant` 的 eloop 事件循环、AIDL 接口层、核心数据结构。本篇跳到另一个主线——WiFi 打开后，系统怎么执行一次扫描？我们聚焦扫描怎么被触发、参数怎么构建、怎么从 Java 世界一路下发到内核。Supplicant 内部的扫描引擎（radio work、BSS 缓存、PNO）留给中篇，驱动执行和 WiFi 6E/7 留给下篇。

<!--more-->

# 本章导读

沿这条四层链路，你会看到 802.11 协议定义的主动/被动两种扫描模式和 Probe Request 帧结构，`WifiScanningServiceImpl` 单次扫描状态机的 Idle → Scanning → Idle 三拍循环，`ScanRequestProxy` 的前后台节流机制（前台 4 次/120s，后台 1 次/30min），以及 `ScannerImpl::scanRequest()` 和 `ScanUtils::Scan()` 如何把 Java 参数一步步翻译成 `NL80211_CMD_TRIGGER_SCAN` 的 netlink 属性。扫描参数的跨层变换——频率列表聚合、隐藏网络 SSID 探测、MAC 随机化、6GHz RNR——也会逐一展开。

本文代码来自 AOSP `packages/modules/Wifi` 和 `system/connectivity/wificond` 仓库，802.11 规范引用基于 2024 版（§6.5.3 MLME-SCAN 原语、§11.1.4 扫描过程、§9.3.3.9 Probe Request 帧格式）。所有代码块均来自真实源码，精简处标注 `// ...省略...`，文件路径标注在代码块首行。本篇是扫描三部曲的上篇，聚焦 Framework → wificond → nl80211 的下发路径（不经过 supplicant）；中篇聚焦 supplicant 内部的 bgscan/P2P/漫游扫描引擎，下篇聚焦驱动执行、PNO 和 WiFi 6E/7。

![WiFi 扫描调用链全景图](assets/05a-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%80%EF%BC%89%E4%BB%8E-Framework-%E5%88%B0-nl80211/05a-architecture-callchain.svg)

---

# 1 扫描有哪几种？—— 先看清全貌

>Android 系统中有四种扫描触发场景，但底层只有一种机制——wificond 通过 nl80211 下发 `NL80211_CMD_TRIGGER_SCAN` 到内核。不同场景的区别在于**谁触发、多频繁、什么参数**。

## 1.1 wificond 是 Android Framework 扫描的唯一通道

在深入代码之前，必须先澄清一个重要事实：

```
❌ 错误理解：Framework → wificond → wpa_supplicant → 驱动（supplicant 不是中间环节）
✅ 正确理解：Framework → wificond → nl80211 → 内核 → 驱动
             （supplicant 的内部扫描是另一条独立的路径，用于 bgscan/P2P）
```

**Android Framework 的所有常规扫描都通过 wificond 直接发 nl80211 命令到内核**，不经过 wpa_supplicant。wpa_supplicant 的扫描引擎（`wpa_supplicant_scan()`、radio work、BSS 缓存）用于它**自己内部触发的扫描**——比如已连接状态下的 bgscan（后台扫描更优 AP 以供漫游）、P2P Device Discovery、WPS 配网扫描。这两条路径不重叠，本文聚焦 Framework 路径。

## 1.2 wificond 是什么？—— 为什么 Android 需要一个独立的扫描守护进程？

在 Android 早期，WiFi 扫描走 wpa_supplicant——Framework 发 `SCAN` 命令，supplicant 在 `eloop_run()` 驱动的单线程事件循环中排队执行（详见 04 章）。这带来两个问题：**eloop 队列延迟**（加密握手时扫描排队数百毫秒，用户感知为"点了刷新没反应"）和 **radio work 耦合**（漫游扫描占用 radio work 时用户扫描被阻塞，Framework 无法区分"没结果"和"没开始扫"）。

Android 8.0 引入 wificond 解决上述问题——一个独立的 C++ 守护进程，只通过 netlink 与内核通信执行扫描，不参与协议状态机和密钥管理：

```
旧架构（Android 7.x）：Framework → wpa_supplicant（eloop 排队）→ wpa_drv_scan() → nl80211
新架构（Android 8.0+）：Framework → wificond（IWifiScannerImpl AIDL）→ NL80211_CMD_TRIGGER_SCAN → 内核
```

wificond 带来三个核心改进：绕过 eloop 队列（低延迟，AIDL 请求直达 netlink）；扫描与连接解耦（supplicant 崩溃不影响扫描功能）；并行结果上报（`IScanEvent.OnScanResultReady()` 在扫描进行中就推送部分结果）。

> wificond 是 Android 扫描架构的分水岭。Android 8.0 之前，所有扫描（包括 Framework 的）都走 supplicant；8.0 之后，Framework 扫描切到 wificond，supplicant 只保留自己内部的 bgscan/P2P 扫描。理解这个历史变迁，你就理解了为什么有些文档（尤其是旧文档）会说"扫描走 supplicant"，而新文档说的是另一套。
>
> **⚠️ 未来变化**：Android 17（Cinnamon Bun）开始，wificond 本身也在被废弃——Google 引入了 `Nl80211Native` 直接通过 `Nl80211Proxy` 调用 nl80211，绕过 wificond 守护进程（由 feature flag `wificondToNl80211Migration()` 控制）。核心改动在 `WifiNative` 层（`WifiNative.java` 中的 `useWificond()` 方法控制路径选择）——`startScan()` 内部判断 `useWificond()` 后决定走 wificond 还是直通 nl80211。（相关变更见 AOSP `packages/modules/Wifi` 仓库中 `WifiNative.java` 的 `Nl80211Native` 引入 commit。）本文讲解的 **AIDL 参数构建 → wificond 翻译 → nl80211 属性** 这条路径在新架构中被 `Nl80211Utils` + `Nl80211Proxy` 替代，但底层的 `NL80211_CMD_TRIGGER_SCAN` 命令和扫描参数语义完全不变——理解了本文的路径，新架构只是换了个入口。注意：以上 `Nl80211Native`、`useWificond()`、`Nl80211Utils`、`wificondToNl80211Migration()` 四个实体在本仓库当前 checkout（AOSP main 分支）中尚未出现，应为 Android 17（Cinnamon Bun）引入的新增 API，后续版本更新后会补充精确引用。一句话收束：wificond 这个「翻译官」终将被替换，但被翻译的那套 nl80211 语义——也正是本文要追踪的主角——保持不变。

## 1.3 四种扫描触发场景

| 扫描场景                                  | 触发条件                                | 间隔                          | 触发模块                       | 本章覆盖     |
| ----------------------------------------- | --------------------------------------- | ----------------------------- | ------------------------------ | ------------ |
| **WiFi Settings 页面扫描**                | 用户打开 WiFi 设置页面（Settings 可见） | 固定 **10s**                  | `BaseWifiTracker.scanLoop()`   | ✅ 本章       |
| **WifiConnectivityManager 周期性扫描**    | 亮屏但非 Settings 界面                  | 见下表（按连接状态区分）      | WifiConnectivityManager 定时器 | 参数共享本章 |
| **PNO 扫描**（Preferred Network Offload） | 息屏（已连接/未连接均有对应 PNO 策略）  | 见下表（按连接+移动状态区分） | 固件代劳，CPU 休眠             | 下篇细讲     |
| **用户/App 主动调用 `startScan()`**       | 任何 App 调用 WifiManager.startScan()   | 受节流限制                    | App 触发                       | ✅ 本章       |

**WifiConnectivityManager 的扫描间隔比上表复杂得多**——它根据屏幕状态、连接状态、设备移动状态动态调整（源码：`WifiConnectivityManager.java` + `config.xml`）：

| 屏幕状态     | WiFi 状态       | 扫描类型           | 间隔策略                                                     |
| ------------ | --------------- | ------------------ | ------------------------------------------------------------ |
| **亮屏**     | 已连接          | 周期性 Single Scan | 指数退避数组 `{20s, 40s, 80s, 160s}`（`config_wifiConnectedScanIntervalScheduleSec`） |
| **亮屏**     | 未连接          | 周期性 Single Scan | 指数退避数组 `{20s, 40s, 80s, 160s}`（`config_wifiDisconnectedScanIntervalScheduleSec`） |
| **息屏**     | 已连接          | Connected PNO      | 固定 **160s**（`CONNECTED_PNO_SCAN_INTERVAL_MS`）            |
| **息屏**     | 未连接 + 移动中 | Disconnected PNO   | 20s ×3 → 60s → 180s → 540s…（`config_wifiMovingPnoScanIntervalMillis`，乘数 3） |
| **息屏**     | 未连接 + 静止   | Disconnected PNO   | 60s ×3 → 180s → 540s…（`config_wifiStationaryPnoScanIntervalMillis`，乘数 3） |
| **省电模式** | 任意            | Single Scan        | 上述间隔 ×2（`POWER_SAVE_SCAN_INTERVAL_MULTIPLIER`）         |

亮屏时的"指数退避"并非乘法退避，而是**数组索引递增**——`mCurrentSingleScanScheduleIndex++` 逐步推进到数组末尾后固定使用最后一个值。`startConnectivityScan()` 被调用时 index 重置为 0（即用户解锁、网络状态变化等会重新从 20s 开始）。屏幕亮起时启动周期性 Single Scan，屏幕关闭时切换到 PNO——两者互斥，不会同时运行。

> 各种周期性扫描（Settings 10s、指数退避 20s→160s、PNO）的**下发参数逻辑完全相同**——区别只在触发源和间隔。理解了单次扫描的完整链路，就理解了所有场景。

## 1.4 全链路概览

```
App (WifiManager.startScan / BaseWifiTracker.scanLoop)
  → WifiServiceImpl
    → ScanRequestProxy.startScan()          // 🔴 节流检查：前台 4次/120s，后台 1次/30min
      → WifiScanningServiceImpl.startScan() // 🟡 状态机：IdleState → tryToStartNewScan()
        → WifiNative.scan()
          → WifiNl80211Manager.startScan2() // 🟢 AIDL 跨进程：IWifiScannerImpl.scanRequest()
            → wificond ScannerImpl::scanRequest()  // 🔵 参数转换：SSID / 频率 / 扫描类型
              → ScanUtils::Scan()                  // 🟣 nl80211 属性构建
                → NL80211_CMD_TRIGGER_SCAN         // 🟤 下发到内核 → 驱动 → 固件
```

![Framework 扫描下发时序图](assets/05a-STA-%E6%89%AB%E6%8F%8F%EF%BC%88%E4%B8%80%EF%BC%89%E4%BB%8E-Framework-%E5%88%B0-nl80211/05a-scan-dispatch-sequence.svg)

> 从 App 调用到内核收到命令，经过 3 次进程边界（App → system_server → wificond → kernel），**没有** wpa_supplicant。每次跨越都伴随着参数格式的变换。

---

# 2 802.11 协议怎么说？—— 扫描的标准定义

>802.11-2024 定义了两种扫描模式——被动扫描（纯监听）和主动扫描（发 Probe Request 等响应）。如果把代码比作雷达操作手册，协议就是雷达的物理原理——它规定了探测脉冲的频率、时长、调制方式和响应规则。所有实现（Android Framework / wificond / Supplicant / 驱动）都是对这套标准的具体化。

在进入代码之前，必须理解协议层定义了什么。Android 的任何一行扫描代码，最终都是在实现 IEEE 802.11 §11.1.4 定义的扫描过程。

## 2.1 MLME-SCAN.request — 扫描的「标准参数单」

802.11-2024 §6.5.3.2 定义了一个原语 `MLME-SCAN.request`，它携带了扫描所需的所有参数。以下是核心字段：

| 参数             | 类型          | 说明                                                    |
| ---------------- | ------------- | ------------------------------------------------------- |
| `BSSType`        | 枚举          | INFRASTRUCTURE / INDEPENDENT（IBSS）/ MESH / ANY_BSS    |
| `BSSID`          | MAC 地址      | 具体 BSSID 或广播地址（wildcard）                       |
| `SSID`           | 0–32 字节     | 具体 SSID 或 wildcard SSID                              |
| `ScanType`       | 枚举          | **ACTIVE**（发 Probe Request）/ **PASSIVE**（只听不发） |
| `ProbeDelay`     | 微秒          | 切到新信道后、发 Probe Request 前的等待时间             |
| `ChannelList`    | 整数集合      | 要扫描的信道列表                                        |
| `MinChannelTime` | TU            | 每个信道的最短停留时间                                  |
| `MaxChannelTime` | TU            | 每个信道的最长停留时间                                  |
| `SSID List`      | SSID 元素集合 | 批量指定多个 SSID（可选）                               |

> **协议与代码的对应**：`ScanType` 对应 `IWifiScannerImpl.SCAN_TYPE_*`，`SSID List` 对应 `SingleScanSettings.hiddenNetworks`，`ChannelList` 对应 `SingleScanSettings.channelSettings`。你会在后面的代码中看到一一对应的影子。

这张参数单里最关键的一个字段是 `ScanType`——它把下面的实现劈成两条完全不同的路径：`ACTIVE` 要主动发 Probe Request、等响应，`PASSIVE` 只静静监听 Beacon、不发一帧。§2.2 就沿着这个分岔展开。

## 2.2 主动扫描 vs 被动扫描：两条完全不同的路径

802.11-2024 §11.1.4.2 和 §11.1.4.3 分别定义了被动扫描和主动扫描。

**被动扫描**（§11.1.4.2）—— 极其简单：

> "If the ScanType parameter indicates a passive scan, the STA shall listen to each channel scanned for no longer than a maximum duration defined by the MaxChannelTime parameter."

就是调谐到每个信道、静默监听 Beacon 帧、最多挂 `MaxChannelTime` 时间、然后换下一个信道。**不发送任何帧**。

**主动扫描**（§11.1.4.3）—— 复杂得多。核心算法如下（以非 DMG STA 为例）：

1. **ProbeDelay 等待**：切到新信道后先等 `ProbeDelay` 微秒（让 PHY 稳定下来），或者直到收到 `PHY-RXSTART.indication`（说明信道上已经有活动）
2. **发送 Probe Request**：通过 DCF/EDCA 竞争接入信道，发送目的地址为广播地址的 Probe Request 帧（驱动通常发送 1-2 个，由 `n_probes` 参数控制），携带 SSID 和 BSSID
3. **MinChannelTime 早退优化**：如果 `ActiveScanningTimer` 到达 `MinChannelTime` 时仍未检测到 `PHY-CCA.indication(BUSY)`（信道空闲），则直接跳到下一个信道——说明这个信道上没有 AP
4. **MaxChannelTime 截止**：接收 Probe Response 和 Beacon 帧直到 `ActiveScanningTimer` 到达 `MaxChannelTime`
5. **切信道**：NAV 清零，扫描下一个信道

**图示**（802.11-2024 Figure 11-8 —— 主动扫描，wildcard BSSID）：

```
时间 →

扫描 STA:      |-- PROBE REQ --|             |-- ACK --|
               |               | MinChTime   |         |  MaxChTime
                         G2                        G1
应答 AP 1:     |---------------|-- PROBE RESP(DA=单播) ---|
应答 AP 2:     |---------------|-- PROBE RESP(DA=单播) ---|

G1 = SIFS, G2 = DIFS/AIFS

```

用 wildcard BSSID 时，多个 AP 都可能回复 Probe Response——扫描 STA 需要逐个接收并 ACK。

## 2.3 Probe Request 帧结构 —— 扫描探头的「身份证」

802.11-2024 §9.3.3.9 Table 9-68 定义了 Probe Request 帧体。以下是 WiFi 6/7 场景下最关键的 IE：

| Element ID | IE 名称                                    | 出现条件                                                     |
| ---------- | ------------------------------------------ | ------------------------------------------------------------ |
| 1          | **SSID**                                   | 必选（可以是 wildcard 或具体 SSID）                          |
| 2          | **Supported Rates**                        | 必选                                                         |
| 4          | **Extended Supported Rates**               | 支持的速率超过 8 个时                                        |
| 45         | **HT Capabilities**                        | 支持 802.11n 时                                              |
| 191        | **VHT Capabilities**                       | 5GHz 频段 + 支持 802.11ac 时                                 |
| 255/35     | **HE Capabilities**（Extended）            | 支持 802.11ax 时（Element ID = 255，Extension = 35）         |
| 255/59     | **HE 6 GHz Band Capabilities**（Extended） | 6GHz 频段 + 支持 802.11ax 时（Element ID = 255，Extension = 59） |
| 37         | **Short SSID List**                        | 支持短 SSID 列表时（6GHz 场景常用）                          |
| 39         | **EDMG Capabilities**                      | 支持 802.11ay（60GHz）时                                     |

> 从这张表可以看出一条清晰的演进线索：每个新的 PHY 代际都会在 Probe Request 中附加自己的能力声明——802.11n 加 HT Capabilities，802.11ac 加 VHT Capabilities，802.11ax 加 HE Capabilities。**AP 根据这些 IE 判断 STA 能支持的最高速率和特性**，这是后面连接参数协商的基础。

## 2.4 信道停留时间 —— 为什么主动扫描比被动扫描快？

停留时间（dwell time）是扫描性能的核心参数：

| 参数                           | 主动扫描典型值     | 被动扫描典型值      | 依据                  |
| ------------------------------ | ------------------ | ------------------- | --------------------- |
| 探询延迟（ProbeDelay）         | ~0–5 ms            | N/A                 | §6.5.3.2              |
| 信道最短停留（MinChannelTime） | ~20–40 TU          | N/A                 | 早退优化的阈值        |
| 信道最长停留（MaxChannelTime） | ~40–110 TU         | ~100–200 TU         | 被动扫描必须等 Beacon |
| 典型每信道耗时                 | ~50 ms（有 AP 时） | ~110 ms（必须等完） | —                     |

**计算一下**：2.4GHz 有 13 个信道（实际重叠，用 1/6/11），5GHz 有 ~25 个非 DFS 信道。主动扫描全频段：~38 个信道，有 AP 的信道约 50ms（MinChannelTime 早退），空信道约 110ms（等到 MaxChannelTime），实际全频段扫描通常在 **2-3 秒**。被动扫描：~38 个信道 × 110ms ≈ **4.2 秒**。

---

# 3 谁来调度扫描？—— Framework 的节流阀和状态机

>`WifiScanningServiceImpl` 是扫描请求的「总调度台」——它有三个状态机各司其职，其中单次扫描状态机用 Idle → Scanning → Idle 的三拍循环来串行化所有扫描请求。`ScanRequestProxy` 是节流阀——后台 App 30 分钟才能扫一次，防止扫描风暴。

## 3.1 为什么需要状态机？

想象一下：操作员 A 说「扫 2.4GHz 全段」，操作员 B 紧接着说「只扫我保存的 10 个 AP」，操作员 C 说「我要高精度模式」。如果没有状态机协调，三套指令同时发出去，雷达会混乱。`WifiScanningServiceImpl` 的核心职责就是**合并同类请求、串行化执行、结果分发给正确的调用方**。

它管理三种扫描模式，对应三个独立的状态机：

| 状态机                           | 处理的扫描类型 | 核心状态                                          |
| -------------------------------- | -------------- | ------------------------------------------------- |
| `WifiSingleScanStateMachine`     | 单次全频段扫描 | Default → DriverStarted → **Idle** / **Scanning** |
| `WifiBackgroundScanStateMachine` | 后台批量扫描   | Default → Started / Paused                        |
| `WifiPnoScanStateMachine`        | PNO 离线扫描   | Default → Started → HwPno / SwPno / SingleScan    |

> 本章聚焦第一个（单次扫描），后台扫描和 PNO 留给中篇和下篇。

## 3.2 WifiSingleScanStateMachine —— 三拍循环

状态机结构（构造函数）：

```java
// service/java/com/android/server/wifi/scanner/WifiScanningServiceImpl.java
WifiSingleScanStateMachine(Looper looper) {
    super("WifiSingleScanStateMachine", looper);

    mScannerImplsTracker = new ScannerImplsTracker();

    setLogRecSize(128);
    setLogOnlyTransitions(false);

    addState(mDefaultState);
        addState(mDriverStartedState, mDefaultState);   // 驱动就绪后才能扫描
            addState(mIdleState, mDriverStartedState);  // 空闲——等待新请求
            addState(mScanningState, mDriverStartedState);  // 扫描中
    setInitialState(mDefaultState);
}
```

状态层次结构：

```
mDefaultState（顶层，处理公共消息）
  └── mDriverStartedState（驱动已加载——扫描的前提条件）
        ├── mIdleState（空闲——等待请求）
        └── mScanningState（正在扫描——等待结果）
```

**关键转换：**

```
IdleState.enter()
  → tryToStartNewScan()           // 合并所有 pending 请求，发出一轮扫描
    → mScannerImplsTracker.startSingleScan(settings)
      → transitionTo(mScanningState)

ScanningState 收到 CMD_SCAN_RESULTS_AVAILABLE：
  → handleScanResults(latestScanResults)
    → reportScanResults()         // 遍历 mActiveScans，逐个回调 listener
    → transitionTo(mIdleState)    // 回到空闲，触发新一轮

ScanningState 收到 CMD_SCAN_FAILED：
  → sendOpFailedToAllAndClear()   // 通知所有调用方失败
    → transitionTo(mIdleState)
```

`IdleState` 的 enter 方法——**仅一行**，但这是整个状态机的心脏：

```java
// service/java/com/android/server/wifi/scanner/WifiScanningServiceImpl.java
class IdleState extends State {
    @Override
    public void enter() {
        tryToStartNewScan();  // 进入空闲态时立即尝试启动新扫描
    }

    @Override
    public boolean processMessage(Message msg) {
        return NOT_HANDLED;  // 非 Scan 相关的消息交给上层处理
    }
}
```

主要功能：

- `IdleState` 是一个「空闲标记」状态——每次进入空闲态时，`enter()` 中自动调用 `tryToStartNewScan()` 尝试发起新一轮扫描，这是整个状态机的核心驱动力。注意：状态机初始停在 `DefaultState`，直到 `WifiNative` 通知驱动就绪后发送 `CMD_ENABLE` 消息，才进入 `IdleState` 开始工作
- `enter()` 中调用 `tryToStartNewScan()` 是唯一逻辑——这意味着一旦前一轮扫描完成，如果还有 pending 请求，立即启动下一轮
- `processMessage` 返回 `NOT_HANDLED`，消息沿状态层次向上传递——经过 `DriverStartedState` 透传，最终由 `DefaultState` 的 `handleScanStartMessage()` 加入 pending 队列。这是 Android `StateMachine` 框架的默认行为——子状态返回 `NOT_HANDLED` 时消息自动向父状态传递

## 3.3 tryToStartNewScan() —— 合并请求、发出一轮扫描

这是状态机中最重要的方法——它把多个 App 的扫描请求合并为一轮扫描参数，然后下发：

```java
// service/java/com/android/server/wifi/scanner/WifiScanningServiceImpl.java
void tryToStartNewScan() {
    if (mPendingScans.size() == 0) { // 没有等待中的请求
        return;
    }
    mChannelHelper.updateChannels();
    WifiNative.ScanSettings settings = new WifiNative.ScanSettings();
    settings.num_buckets = 1;
    WifiNative.BucketSettings bucketSettings = new WifiNative.BucketSettings();
    bucketSettings.bucket = 0;
    bucketSettings.period_ms = 0;
    bucketSettings.report_events = WifiScanner.REPORT_EVENT_AFTER_EACH_SCAN;

    ChannelCollection channels = mChannelHelper.createChannelCollection();
    // 检查 6GHz 信道是否可用（通过 ChannelHelper 查询，非 WifiNative 直接方法）
    WifiScanner.ChannelSpec[][] available6GhzChannels =
            mChannelHelper.getAvailableScanChannels(WifiScanner.WIFI_BAND_6_GHZ);
    boolean are6GhzChannelsAvailable = available6GhzChannels.length > 0
            && available6GhzChannels[0].length > 0;
    List<WifiNative.HiddenNetwork> hiddenNetworkList = new ArrayList<>();
    List<ScanResult.InformationElement> vendorIesList = new ArrayList<>();
    for (RequestInfo<ScanSettings> entry : mPendingScans) {
        // 合并扫描类型：取最高精度
        settings.scanType = mergeScanTypes(settings.scanType, entry.settings.type);
        // 合并 6GHz RNR 设置——但如果当前 radio 不支持 6GHz，直接关掉
        if (are6GhzChannelsAvailable) {
            settings.enable6GhzRnr = mergeRnrSetting(
                    settings.enable6GhzRnr, entry.settings);
        } else {
            settings.enable6GhzRnr = false;  // 不支持 6GHz 时强制重置
        }
        // 合并信道列表
        channels.addChannels(entry.settings);
        // 合并隐藏网络 SSID
        for (ScanSettings.HiddenNetwork srcNetwork : entry.settings.hiddenNetworks) {
            WifiNative.HiddenNetwork hiddenNetwork = new WifiNative.HiddenNetwork();
            hiddenNetwork.ssid = srcNetwork.ssid;
            hiddenNetworkList.add(hiddenNetwork);
        }
        // 合并 Vendor IE
        mergeVendorIes(vendorIesList, entry.settings);
        // 合并 report_events——只合并 FULL_SCAN_RESULT 标志，不是无条件 OR
        if ((entry.settings.reportEvents & WifiScanner.REPORT_EVENT_FULL_SCAN_RESULT) != 0) {
            bucketSettings.report_events |= WifiScanner.REPORT_EVENT_FULL_SCAN_RESULT;
        }
    }
    // ...构建 settings.hiddenNetworks 数组...
    // ...构建 settings.vendorIes 字节数组...

    channels.fillBucketSettings(bucketSettings, Integer.MAX_VALUE);
    settings.buckets = new WifiNative.BucketSettings[] {bucketSettings};

    if (mScannerImplsTracker.startSingleScan(settings)) {
        // 记录扫描开始
        mActiveScanSettings = settings;
        // 交换 active 和 pending 列表
        RequestList<ScanSettings> tmp = mActiveScans;
        mActiveScans = mPendingScans;
        mPendingScans = tmp;
        mPendingScans.clear();
        transitionTo(mScanningState);
    } else {
        // 扫描启动失败——通知所有 pending 请求
        sendOpFailedToAllAndClear(mPendingScans, WifiScanner.REASON_UNSPECIFIED,
                "Failed to start single scan");
    }
}
```

主要功能：

- 遍历 `mPendingScans` 中的所有请求，**合并同类型参数**——多个 App 的 SSID、信道、Vendor IE 聚合成一份扫描参数
- 合并扫描类型用的是 `mergeScanTypes()`——遍历 `mPendingScans` 时，当 `existingScanType` 是 `LOW_LATENCY` 或 `LOW_POWER` 时，`newScanType` **无条件覆盖**（这两种类型不具备粘性）；当 `existingScanType` 是 `HIGH_ACCURACY` 时**保留不变**（一旦被设置就不会被后续的非 `HIGH_ACCURACY` 请求覆盖）。由于 `settings.scanType` 初始值为 0（`LOW_LATENCY`）且 `HIGH_ACCURACY` 具有粘性，只要 `mPendingScans` 中出现任意一个 `HIGH_ACCURACY` 请求，合并结果就一定是 `HIGH_ACCURACY`——与它在队列中的位置无关；只有当所有请求都是 `LOW_LATENCY`/`LOW_POWER` 时，最终结果才是最后一位请求的类型（后写覆盖先写）。
- AIDL 层命名为 `SCAN_TYPE_LOW_SPAN`，Java Framework 层对应命名为 `SCAN_TYPE_LOW_LATENCY`（值同为 0）——两层用了不同名字表达同一个概念
- 此外 `tryToStartNewScan()` 还合并了 `reportEvents`（决定逐条上报还是一次性批量返回）、6GHz RNR 开关、vendor IEs，并对隐藏网络 SSID 数量做了上限检查。这些合并确保了多个调用方共享一轮扫描结果，而不是各自排队
- 合并完成后调用 `mScannerImplsTracker.startSingleScan()` 下发——这是把 Java 层参数转换成真正扫描的入口
- 成功后**交换 `mActiveScans` 和 `mPendingScans`**——扫完这批后再处理下一批（如果 IdleState 重新 enter 有新请求的话）
- **设计要点**：这个合并机制意味着多个 App 同时请求扫描时，不会重复扫——一次扫描的结果分发给所有调用方

## 3.4 ScanningState —— 等待结果、分发给调用方

扫描中收到的结果有三种上报方式：**逐条上报**（`CMD_FULL_SCAN_SINGLE_RESULT`）、**批量全量上报**（`CMD_FULL_SCAN_ALL_RESULTS`）和**扫描完成**（`CMD_SCAN_RESULTS_AVAILABLE`）。三种都来自 wificond 的回调。

`ScanningState` 的 `processMessage()`（`WifiScanningServiceImpl.java`）处理四种消息，每种都标志着扫描生命周期的一个转折点：

- **扫描完成**（`CMD_SCAN_RESULTS_AVAILABLE`）——状态机的「心跳」信号：调用 `mScannerImplsTracker.getLatestSingleScanResults()` 获取最新结果，然后通过 `handleScanResults()` 遍历 `mActiveScans` 中的每个请求、回调对应 listener 的 `onResults()`，最后 `transitionTo(mIdleState)` 回到空闲态，可能立即触发下一轮扫描。
- **逐条结果**（`CMD_FULL_SCAN_SINGLE_RESULT`）——通过 `reportFullScanSingleResult()` 将单个 `ScanResult` 实时回调给上层（`onFullResult()`），适用于需要低延迟看到首个结果的场景。
- **批量全量结果**（`CMD_FULL_SCAN_ALL_RESULTS`）——通过 `reportFullScanAllResults()` 将整批 `ScanResult` 一次性回调（`onFullResults()`），是逐条上报的批量版本，一次回调携带全部结果。
- **扫描失败**（`CMD_SCAN_FAILED`）——调用 `sendOpFailedToAllAndClear()` 通知所有调用方失败（错误码通过 `scanErrorCodeToDescriptionString()` 转为可读字符串），然后 `transitionTo(mIdleState)`。

除了消息处理，`ScanningState` 的生命周期还嵌入了电量统计：进入时通过 `BatteryStatsManager.reportWifiScanStartedFromSource()` 上报扫描开始，退出时上报 `reportWifiScanStoppedFromSource()`——即使扫描异常中断，`exit()` 也会执行清理逻辑（调用 `sendOpFailedToAllAndClear()` 处理残余的 `mActiveScans`），确保调用方始终能收到回调。

## 3.5 ScanRequestProxy —— 节流是第一道防线

`WifiScanningServiceImpl` 的状态机负责扫描一旦开始后的调度——合并请求、串行执行、分发结果。但扫描请求在到达状态机之前，还要过另一道关：**节流检查**。这正是 `ScanRequestProxy` 的职责。

> 如果 `WifiScanningServiceImpl` 是雷达的战术指挥中心，`ScanRequestProxy` 就是指挥中心门口的**节流阀**——不是谁来请求都放行，后台 App 每 30 分钟才让扫一次，防止雷达被无意义的探测请求烧坏。

先看三个决定节流行为的常量：

```java
// service/java/com/android/server/wifi/ScanRequestProxy.java
@VisibleForTesting
public static final int SCAN_REQUEST_THROTTLE_TIME_WINDOW_FG_APPS_MS = 120 * 1000;
@VisibleForTesting
public static final int SCAN_REQUEST_THROTTLE_MAX_IN_TIME_WINDOW_FG_APPS = 4;
@VisibleForTesting
public static final int SCAN_REQUEST_THROTTLE_INTERVAL_BG_APPS_MS = 30 * 60 * 1000;
```

| 常量         | 值      | 含义                            |
| ------------ | ------- | ------------------------------- |
| 前台时间窗口 | 120 秒  | 统计 App 在这个窗口内的扫描次数 |
| 前台窗口上限 | 4 次    | 超过则拒绝                      |
| 后台全局间隔 | 30 分钟 | 所有后台 App 共享一个全局时间戳 |

节流决策的核心逻辑——按 App 是前台还是后台分岔：

```java
// service/java/com/android/server/wifi/ScanRequestProxy.java
private boolean shouldScanRequestBeThrottledForApp(int callingUid, String packageName,
        int packageImportance) {
    boolean isThrottled;
    if (packageImportance
            > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE) {
        isThrottled = shouldScanRequestBeThrottledForBackgroundApp(packageName);
        if (isThrottled) {
            mWifiMetrics.incrementExternalBackgroundAppOneshotScanRequestsThrottledCount();
        }
    } else {
        isThrottled = shouldScanRequestBeThrottledForForegroundApp(callingUid, packageName);
        if (isThrottled) {
            mWifiMetrics.incrementExternalForegroundAppOneshotScanRequestsThrottledCount();
        }
    }
    mWifiMetrics.incrementExternalAppOneshotScanRequestsCount();
    return isThrottled;
}
```

**后台 App 的节流逻辑**——所有后台 App 共享一个全局时间戳。`shouldScanRequestBeThrottledForBackgroundApp()` 首先调用 `isPackageNameInExceptionList(packageName, false)` 检查白名单——白名单中的包名直接放行，不做任何节流。非白名单 App 则进入 `synchronized (mThrottleEnabledLock)` 同步块，取 `mLastScanTimestampForBgApps` 与当前启动时间（`mClock.getElapsedSinceBootMillis()`）比较：如果距离上次后台扫描不到 `SCAN_REQUEST_THROTTLE_INTERVAL_BG_APPS_MS`（30 分钟），返回 `true` 拒绝本次扫描；否则更新 `mLastScanTimestampForBgApps` 为当前时间并放行。关键设计：`mLastScanTimestampForBgApps` 是一个全局字段，任何后台 App 扫过一次后，所有后台 App 都要等 30 分钟。

**前台 App 的节流逻辑**——每个 App 独立维护扫描时间戳窗口：

```java
// service/java/com/android/server/wifi/ScanRequestProxy.java
private boolean shouldScanRequestBeThrottledForForegroundApp(
        int callingUid, String packageName) {
    if (isPackageNameInExceptionList(packageName, true)) {
        return false;  // 白名单放行
    }
    LinkedList<Long> scanRequestTimestamps =
            getOrCreateScanRequestTimestampsForForegroundApp(callingUid, packageName);
    long currentTimeMillis = mClock.getElapsedSinceBootMillis();
    trimPastScanRequestTimesForForegroundApp(scanRequestTimestamps, currentTimeMillis);
    if (scanRequestTimestamps.size() >= SCAN_REQUEST_THROTTLE_MAX_IN_TIME_WINDOW_FG_APPS) {
        return true;  // 120 秒内已有 4 次，拒绝
    }
    scanRequestTimestamps.addLast(currentTimeMillis);  // 记录本次扫描
    return false;
}
```

这段节流逻辑做了三件事：

- 后台 App 共享全局 `mLastScanTimestampForBgApps`——如上述，通过 `synchronized` 同步块保证线程安全
- 前台 App 各自维护独立的 `LinkedList<Long>`——`trimPastScanRequestTimesForForegroundApp()` 先清理 120 秒窗口外的旧记录，然后判数
- **白名单豁免**：持有 `NETWORK_SETTINGS` 或 `NETWORK_SETUP_WIZARD` 权限的 App（如 Settings）完全跳过节流。系统管理员可通过 `WifiSettingsConfigStore.WIFI_SCAN_THROTTLE_ENABLED` 关闭节流（默认开启，需 adb 或 root 权限修改）

最后看一下 `startScan()` 的全貌：

```java
// service/java/com/android/server/wifi/ScanRequestProxy.java
public boolean startScan(int callingUid, String packageName) {
    if (!mScanningEnabled || !retrieveWifiScannerIfNecessary()) {
        sendScanResultFailureBroadcastToPackage(packageName);
        return false;
    }
    boolean fromSettingsOrSetupWizard =
            mWifiPermissionsUtil.checkNetworkSettingsPermission(callingUid)
                    || mWifiPermissionsUtil.checkNetworkSetupWizardPermission(callingUid);
    int packageImportance = getPackageImportance(callingUid, packageName);
    if (!fromSettingsOrSetupWizard && isScanThrottleEnabled()
            && shouldScanRequestBeThrottledForApp(callingUid, packageName,
            packageImportance)) {
        Log.i(TAG, "Scan request from " + packageName + " throttled");
        sendScanResultFailureBroadcastToPackage(packageName);
        return false;
    }
    // 创建扫描设置
    WifiScanner.ScanSettings settings = new WifiScanner.ScanSettings();
    if (fromSettingsOrSetupWizard) {
        settings.type = WifiScanner.SCAN_TYPE_HIGH_ACCURACY;  // 持有 NETWORK_SETTINGS/SETUP_WIZARD 权限的 App 用高精度
    } else {
        if (SdkLevel.isAtLeastS()) {
            settings.set6GhzPscOnlyEnabled(true);  // 普通 App 只扫 PSC，不扫全部 59 个 6GHz 信道
        }
    }
    settings.band = WifiScanner.WIFI_BAND_ALL;
    settings.reportEvents = WifiScanner.REPORT_EVENT_AFTER_EACH_SCAN
            | WifiScanner.REPORT_EVENT_FULL_SCAN_RESULT;
    if (mScanningForHiddenNetworksEnabled) {
        // 从已保存网络和 Network Suggestion 中提取隐藏网络 SSID 加入扫描
        settings.hiddenNetworks.addAll(mWifiConfigManager.retrieveHiddenNetworkList(false));
        settings.hiddenNetworks.addAll(
                mWifiInjector.getWifiNetworkSuggestionsManager()
                        .retrieveHiddenNetworkList(false));
    }
    // 实际代码用 WifiScannerInternal.ScanListener 包装（含 mWifiThreadRunner），此处简化
    mWifiScanner.startScan(settings,
            new ScanRequestProxyScanListener(), workSource);
    return true;
}
```

startScan() 的核心流程：

- **第一道检查**：扫描开关是否打开（`mScanningEnabled`）
- **第二道检查**：持有 `NETWORK_SETTINGS` / `NETWORK_SETUP_WIZARD` 权限 → 直接放行（不节流）
- **第三道检查**：调用 `shouldScanRequestBeThrottledForApp()` 做节流判断
- **通过所有检查后**：构建 `ScanSettings`——持有 `NETWORK_SETTINGS`/`NETWORK_SETUP_WIZARD` 权限的 App（如 Settings）用 `HIGH_ACCURACY`，普通 App 全频段 + 逐条结果上报
- **被节流的请求直接发失败广播**（`sendScanResultFailureBroadcastToPackage()`），不做排队

---

# 4 wificond 怎么把 Java 参数翻译成 nl80211 命令？

> wificond 是翻译官——它把指挥中心的口语指令（Java 对象"扫 2.4G 全段、带上我的 3 个隐藏 SSID"）翻译成天线控制器能执行的精确参数（nl80211 属性列表）。下面每一行 C++ 代码都是在做这个翻译工作。

>`ScannerImpl::scanRequest()` 是 Java 世界到 C++ netlink 世界的翻译官——它把 `SingleScanSettings`（Java Parcelable）拆解成 SSID 列表、频率列表、扫描类型标志，然后交给 `ScanUtils::Scan()` 构建 `NL80211_CMD_TRIGGER_SCAN` 消息。

## 4.1 跨进程序列：AIDL 是桥梁

从 `WifiNl80211Manager.startScan2()` 到 wificond 进程，走的是 AIDL 调用：

```java
// aidl/android/net/wifi/nl80211/IWifiScannerImpl.aidl
interface IWifiScannerImpl {
    // 扫描类型常量
    const int SCAN_TYPE_LOW_SPAN = 0;
    const int SCAN_TYPE_LOW_POWER = 1;
    const int SCAN_TYPE_HIGH_ACCURACY = 2;
    const int SCAN_TYPE_DEFAULT = -1;

    // 扫描状态码
    const int SCAN_STATUS_SUCCESS = 0;
    const int SCAN_STATUS_FAILED_GENERIC = 1;
    const int SCAN_STATUS_FAILED_BUSY = 2;
    const int SCAN_STATUS_FAILED_ABORT = 3;
    const int SCAN_STATUS_FAILED_NODEV = 4;
    const int SCAN_STATUS_FAILED_INVALID_ARGS = 5;

    int scanRequest(in SingleScanSettings scanSettings);  // Android 14 起替代 scan() 的推荐方法
    oneway void subscribeScanEvents(IScanEvent handler);
    void abortScan();
    NativeScanResult[] getScanResults();
    // ...省略 PNO 相关方法...
}
```

回调接口 `IScanEvent`（`aidl/android/net/wifi/nl80211/IScanEvent.aidl`）定义了三个方法：`OnScanResultReady()` 通知结果就绪（可随即调用 `getScanResults()` 拉取），`OnScanFailed()` 已被废弃（Android 14+ 改用带错误码的版本），`OnScanRequestFailed(int errorCode)` 携带 `SCAN_STATUS_*` 错误码。

跨进程传递的核心数据是 `SingleScanSettings`（Parcelable，定义于 `base/wifi/java/src/android/net/wifi/nl80211/SingleScanSettings.java`），包含五个字段：`scanType`（`SCAN_TYPE_*` 常量）、`enable6GhzRnr`（6GHz RNR 开关）、`channelSettings`（按频段指定的信道列表）、`hiddenNetworks`（隐藏网络的 SSID 列表）、`vendorIes`（厂商自定义 IE 字节数组）。

## 4.2 ScannerImpl::scanRequest() —— wificond 的扫描入口

当 AIDL 调用到达 wificond，`ScannerImpl::scanRequest()` 被调用。这是 Java → C++ → nl80211 的第一个转换点：

```cpp
// wificond/scanning/scanner_impl.cpp
Status ScannerImpl::scanRequest(const SingleScanSettings& scan_settings,
                         int* status) {
  if (!CheckIsValid()) {
    *status = IWifiScannerImpl::SCAN_STATUS_FAILED_GENERIC;
    return Status::ok();
  }

  if (scan_started_) {
    LOG(WARNING) << "Scan already started";
  }
  // 仅在 STA 未关联时请求 MAC 地址随机化
  bool request_random_mac =
      wiphy_features_.supports_random_mac_oneshot_scan &&
      !client_interface_->IsAssociated();
  int scan_type = scan_settings.scan_type_;
  if (!IsScanTypeSupported(scan_settings.scan_type_, wiphy_features_)) {
    LOG(DEBUG) << "Ignoring scan type because device does not support it";
    scan_type = SCAN_TYPE_DEFAULT;
  }

  // 首先加入一个空 SSID（wildcard scan——匹配所有 AP）
  vector<vector<uint8_t>> ssids = {{}};

  vector<vector<uint8_t>> skipped_scan_ssids;
  vector<vector<uint8_t>> skipped_long_ssids;
  for (auto& network : scan_settings.hidden_networks_) {
    if (ssids.size() + 1 > scan_capabilities_.max_num_scan_ssids) {
      skipped_scan_ssids.emplace_back(network.ssid_);  // 超出驱动限制，跳过
      continue;
    }
    if (network.ssid_.size() > 32) {
        skipped_long_ssids.emplace_back(network.ssid_);  // SSID 过长，跳过
        continue;
    }
    ssids.push_back(network.ssid_);
  }

  // 从 ChannelSettings 中提取频率列表
  vector<uint32_t> freqs;
  for (auto& channel : scan_settings.channel_settings_) {
    freqs.push_back(channel.frequency_);
  }

  int error_code = 0;
  if (!scan_utils_->Scan(interface_index_, request_random_mac, scan_type,
                         scan_settings.enable_6ghz_rnr_, ssids, freqs,
                         scan_settings.vendor_ies_, &error_code)) {
    // 失败处理
    if (error_code == ENODEV) {
        nodev_counter_ ++;
        LOG(WARNING) << "Scan failed with error=nodev. counter=" << nodev_counter_;
    }
    CHECK(error_code != ENODEV || nodev_counter_ <= 3)
        << "Driver is in a bad state, restarting wificond";
    *status = convertStdErrNumToScanStatus(error_code);
    return Status::ok();
  }
  nodev_counter_ = 0;
  scan_started_ = true;
  *status = IWifiScannerImpl::SCAN_STATUS_SUCCESS;
  return Status::ok();
}
```

下面逐条拆解这段代码：

- **SSID 列表构建**：先加入空 SSID（wildcard），再追加隐藏网络 SSID，超出 `max_num_scan_ssids` 的跳过
- **MAC 随机化判断**：仅在驱动支持 + STA 未关联时启用——已连接状态下不会随机化扫描 MAC
- **扫描类型回退**：如果设备不支持请求的扫描类型（如 `LOW_POWER`），回退到 `SCAN_TYPE_DEFAULT`
- **`scan_started_` 仅打 warning 不阻止**：如果已有扫描在进行中，只打日志不 return——允许重复请求，由底层序列化框架处理冲突
- **ENODEV 看门狗**：第 4 次连续 `ENODEV`（网卡消失）时 `CHECK` 触发 crash → Android init 重启 wificond

## 4.3 ScanUtils::Scan() —— NL80211_CMD_TRIGGER_SCAN 的精准构建

参数提取和校验完成后，下一步是把 SSID 列表、频率列表、扫描标志打包成内核能理解的 netlink 消息——这就是 `ScanUtils::Scan()` 的职责。

`ScanUtils::Scan()` 的职责边界很窄，就一件事：**把上游 `scanRequest()` 拆好的参数原样塞进 netlink 属性、发出去、等 ACK**。SSID 数量限制是上游 `scanRequest()` 检查的，频率合法性是下游内核验证的，`Scan()` 夹在中间只做「打包 + 发送 + 等 ACK」，不越界也不代劳。这是扫描参数的最后一步——从 C++ 数据结构变成 netlink 消息的属性：

```cpp
// wificond/scanning/scan_utils.cpp
bool ScanUtils::Scan(uint32_t interface_index,
                     bool request_random_mac,
                     int scan_type,
                     bool enable_6ghz_rnr,
                     const vector<vector<uint8_t>>& ssids,
                     const vector<uint32_t>& freqs,
                     const vector<uint8_t>& vendor_ies,
                     int* error_code) {
  NL80211Packet trigger_scan(
      netlink_manager_->GetFamilyId(),
      NL80211_CMD_TRIGGER_SCAN,          // 核心命令
      netlink_manager_->GetSequenceNumber(),
      getpid());
  trigger_scan.AddFlag(NLM_F_ACK);       // 要求内核 ACK

  // 属性 1：指定接口
  NL80211Attr<uint32_t> if_index_attr(NL80211_ATTR_IFINDEX, interface_index);

  // 属性 2：SSID 列表（嵌套属性，每个 SSID 独立编号）
  NL80211NestedAttr ssids_attr(NL80211_ATTR_SCAN_SSIDS);
  for (size_t i = 0; i < ssids.size(); i++) {
    ssids_attr.AddAttribute(NL80211Attr<vector<uint8_t>>(i, ssids[i]));
  }

  // 属性 3：频率列表（嵌套属性）
  NL80211NestedAttr freqs_attr(NL80211_ATTR_SCAN_FREQUENCIES);
  for (size_t i = 0; i < freqs.size(); i++) {
    freqs_attr.AddAttribute(NL80211Attr<uint32_t>(i, freqs[i]));
  }

  trigger_scan.AddAttribute(if_index_attr);
  trigger_scan.AddAttribute(ssids_attr);
  // 如果不指定频率列表 → 内核扫描所有支持的频率
  if (!freqs.empty()) {
    trigger_scan.AddAttribute(freqs_attr);
  }

  // 属性 4：扫描标志（位掩码）
  uint32_t scan_flags = 0;
  if (request_random_mac) {
    scan_flags |= NL80211_SCAN_FLAG_RANDOM_ADDR;
  }
  switch (scan_type) {
    case IWifiScannerImpl::SCAN_TYPE_LOW_SPAN:
      scan_flags |= NL80211_SCAN_FLAG_LOW_SPAN; break;
    case IWifiScannerImpl::SCAN_TYPE_LOW_POWER:
      scan_flags |= NL80211_SCAN_FLAG_LOW_POWER; break;
    case IWifiScannerImpl::SCAN_TYPE_HIGH_ACCURACY:
      scan_flags |= NL80211_SCAN_FLAG_HIGH_ACCURACY; break;
    case IWifiScannerImpl::SCAN_TYPE_DEFAULT: break;
    default:
      CHECK(0) << "Invalid scan type received: " << scan_type;
  }
  if (enable_6ghz_rnr) {
    scan_flags |= NL80211_SCAN_FLAG_COLOCATED_6GHZ;
  }
  if (scan_flags) {
    trigger_scan.AddAttribute(
        NL80211Attr<uint32_t>(NL80211_ATTR_SCAN_FLAGS, scan_flags));
  }

  // 属性 5：厂商自定义 IE
  if (!vendor_ies.empty()) {
    NL80211Attr<vector<uint8_t>> vendor_ie_attr(NL80211_ATTR_IE, vendor_ies);
    trigger_scan.AddAttribute(vendor_ie_attr);
  }

  // 发送并等待内核 ACK/ERROR
  if (!netlink_manager_->SendMessageAndGetAckOrError(trigger_scan,
                                                     error_code)) {
    return false;
  }
  if (*error_code != 0) {
    LOG(ERROR) << "NL80211_CMD_TRIGGER_SCAN failed: " << strerror(*error_code);
    return false;
  }
  return true;
}
```

关键逻辑拆解：

- **嵌套属性结构**：SSID 和频率使用 `NL80211NestedAttr`（嵌套属性），每个 SSID/频率在列表中独立编号
- **不指定频率 = 全扫**：如果 `freqs` 为空，不添加 `NL80211_ATTR_SCAN_FREQUENCIES`，内核默认扫描所有支持的频率
- **扫描标志是位掩码**：`RANDOM_ADDR` | `LOW_SPAN` | `HIGH_ACCURACY` | `COLOCATED_6GHZ` 通过 `|=` 组合
- **同步等待 ACK**：`NLM_F_ACK` 标志确保内核在开始扫描前回复 ACK——如果内核拒绝（如 `EBUSY`），在这里立即返回错误
- **扫描标志的实际效果**：`LOW_SPAN` 缩短 dwell time 降低延迟，`LOW_POWER` 减少扫描信道数省电，`HIGH_ACCURACY` 延长每信道停留时间并在 DFS 信道做额外探测——驱动根据这些标志调整 PHY 层行为

## 4.4 内核回复扫描完成后的回调路径

`NL80211_CMD_TRIGGER_SCAN` 发出后，内核开始在各信道上执行扫描。扫描完成后的结果如何回传？下面追踪反向路径。

扫描完成后，内核通过 netlink multicast 发送 `NL80211_CMD_NEW_SCAN_RESULTS`：

```
内核 multicast → NetlinkManager::ReceivePacketAndRunHandler
  → BroadcastHandler(packet)
    → GetCommand() == NL80211_CMD_NEW_SCAN_RESULTS
      → OnScanResultsReady(interface_index, aborted=false)
        → ScannerImpl::OnScanResultsReady()
          → IScanEvent::OnScanResultReady()  // AIDL 回调到 Framework
```

这条链路能成立的关键，在于「通用 netlink 基础设施」与「扫描业务类」之间的解耦。`ReceivePacketAndRunHandler(fd)` 是 nl80211 组播 socket 在建立时注册给 libevent 的 fd 回调——**任何** netlink 组播报文（连接事件、regulatory 变更、扫描结果……）都先经过这里，它读完报文后统一转交 `BroadcastHandler(packet)`。`BroadcastHandler` 是分拣器：先核对 `GetMessageType()` 是否等于 nl80211 家族 ID，再按 `GetCommand()` 分派——`NL80211_CMD_NEW_SCAN_RESULTS`（以及 `NL80211_CMD_SCAN_ABORTED`）被路由到 `NetlinkManager::OnScanResultsReady()`。这个方法从报文中取出 `NL80211_ATTR_IFINDEX` 确定是哪个接口、并据命令判断是否 `aborted`，然后查 `on_scan_result_ready_handler_` 这张「接口索引 → 回调」映射表。而这张表是在 `ScannerImpl` 构造时通过 `SubscribeScanResultNotification()` 注册、并用 `std::bind(&ScannerImpl::OnScanResultsReady, this, _1, _2, _3, _4)` 绑定的——这解释了为什么消息能跨类抵达：`NetlinkManager` 只认识回调签名，不认识 `ScannerImpl` 本体，扫描结果的路由因此不会把 netlink 层和扫描逻辑焊死在一起。

Framework 收到回调后调用 `getScanResults()`——`ScannerImpl` 再通过 `ScanUtils::GetScanResult()` 发送 `NL80211_CMD_GET_SCAN` 拉取完整 BSS 列表。

## 4.5 abortScan() —— 中止正在进行的扫描

`ScannerImpl::abortScan()`（`scanner_impl.cpp`）的逻辑很直接：先通过 `CheckIsValid()` 检查扫描器是否有效，再判断 `scan_started_` 是否有扫描在进行中，仅当两者都满足时才调用 `scan_utils_->AbortScan(interface_index_)` 下发中止命令。发送后**立即返回**，不重置 `scan_started_`——重置发生在后续的 `OnScanResultsReady(aborted=true)` 回调中，该回调同时通知 Framework `OnScanRequestFailed(SCAN_STATUS_FAILED_ABORT)`。这趟中止的完整通知路径是：`AbortScan()` 下发 `NL80211_CMD_ABORT_SCAN` 后，内核中止扫描并组播回发 `NL80211_CMD_SCAN_ABORTED`，`NetlinkManager::BroadcastHandler()` 把它与 `NL80211_CMD_NEW_SCAN_RESULTS` 一起路由到 `OnScanResultsReady()`，后者据命令类型判定 `aborted=true`，再查 `on_scan_result_ready_handler_` 表定位 `ScannerImpl::OnScanResultsReady()`；回调里 `ScannerImpl` 重置 `scan_started_`，再经 `IScanEvent::OnScanRequestFailed(SCAN_STATUS_FAILED_ABORT)` 把「扫描被中止」错误码送回 Framework。

---

# 5 扫描结果怎么分发回来？—— 反向路径与请求拆分

> 雷达探测脉冲（Probe Request）发出去了，回波（Probe Response）由天线控制器（内核）收集，经由翻译官（wificond）传回指挥中心。现在的问题是——指挥中心同时接到了三个操作员的扫描请求（Settings、WifiConnectivityManager、某个 App），一份回波数据怎么同时满足三个人？这正是本章要讲的分发逻辑。

>扫描结果从内核回到 Framework 后，`WifiScanningServiceImpl` 的 `reportScanResults()` 遍历 `mActiveScans` 中的每一个请求，逐个回调对应的 listener——一次扫描的结果分发给所有调用方，而不是每次请求独立扫一次。

## 5.1 结果回来的完整反向路径

上三节追踪了扫描命令的下发。现在反向追踪——扫描结果怎么回来：

```
内核 nl80211 multicast: NL80211_CMD_NEW_SCAN_RESULTS
  → wificond NetlinkManager::ReceivePacketAndRunHandler
    → BroadcastHandler → ScannerImpl::OnScanResultsReady()
      → IScanEvent::OnScanResultReady()          // AIDL 回调到 Framework
        → WifiNl80211Manager callback
          → WifiScanningServiceImpl.ScanningState
            → CMD_SCAN_RESULTS_AVAILABLE
              → handleScanResults()              // 📍 关键：结果分发点
                → reportScanResults()
```

## 5.2 reportScanResults() 与 handleScanResults() — 一鱼多吃

扫描只有一轮，但请求可以有 N 个（Settings 的、WifiConnectivityManager 的、App 的）。分发由两个方法协作完成——`reportScanResults()` 负责回调通知，`handleScanResults()` 负责缓存和清理：

```java
// WifiScanningServiceImpl.java
// 第一步：handleScanResults — 缓存 + 分发 + 清理
void handleScanResults(@NonNull ScanData results) {
    mWifiMetrics.getScanMetrics().logScanSucceeded(..., results.getResults().length);
    reportScanResults(results);                  // 回调通知所有调用方
    // 全频段扫描结果才缓存（非全频段扫描不污染缓存）
    if (WifiScanner.isFullBandScan(results.getScannedBandsInternal(), true)) {
        mCachedScanResults.clear();
        mCachedScanResults.addAll(Arrays.asList(results.getResults()));
    }
    // 缓存有效期: CACHED_SCAN_RESULTS_MAX_AGE_IN_MILLIS = 180 * 1000 (3分钟)
    // 过期机制是惰性过滤——读取时按 timestamp 过滤，不是定时清理
    // ...emergency scan alarm 处理省略...
    for (RequestInfo<ScanSettings> entry : mActiveScans) {
        entry.clientInfo.unregister();           // 注销监听
    }
    mActiveScans.clear();                        // 清空本轮活跃请求
}
```

```java
// 第二步：reportScanResults — 逐个回调 + 结果过滤
void reportScanResults(@NonNull ScanData results) {
    if (results != null && results.getResults() != null) {
        if (results.getResults().length > 0) {
            mWifiMetrics.incrementNonEmptyScanResultCount();
        } else {
            mWifiMetrics.incrementEmptyScanResultCount();
        }
    }
    ScanData[] allResults = new ScanData[] {results};
    // 第一圈：遍历 mActiveScans，按 settings 过滤后回调
    for (RequestInfo<ScanSettings> entry : mActiveScans) {
        ScanData[] resultsToDeliver = ScanScheduleUtil.filterResultsForSettings(
                mChannelHelper, allResults, entry.settings, -1);
        entry.clientInfo.reportEvent((listener) -> {
            listener.onResults(resultsToDeliver);
            listener.onSingleScanCompleted();    // 通知单次扫描完成
        });
    }
    // 第二圈：单次扫描监听者（如后台扫描），不过滤直接回调
    for (RequestInfo<Void> entry : mSingleScanListeners) {
        entry.clientInfo.reportEvent((listener) -> {
            listener.onResults(allResults);
        });
    }
}
```

整个分发机制的要点：

- **两圈分发，不是一圈**：`mActiveScans` 的调用方拿到的是 `filterResultsForSettings()` 过滤后的结果（通道/band 不同可能裁剪），`mSingleScanListeners` 拿到原始全量结果
- **缓存只在 `handleScanResults()` 中执行**，且仅在全频段扫描时更新——非全频段扫描不污染缓存
- **`transitionTo(mIdleState)` 在 `ScanningState.processMessage()` 中**——在调用 `handleScanResults()` 之后，这两个方法都不涉及状态切换

**Framework 的三层缓存架构**：扫描结果从驱动到 UI 经过三层独立缓存，每层服务不同消费者、有不同的过期策略：

---

**第一层：`WifiScanningServiceImpl.mCachedScanResults`（180s 惰性过滤）**

```java
// WifiScanningServiceImpl.java — WifiSingleScanStateMachine 内部类
private final List<ScanResult> mCachedScanResults = new ArrayList<>();
public static final int CACHED_SCAN_RESULTS_MAX_AGE_IN_MILLIS = 180 * 1000; // 3 分钟
```

这层缓存服务于 `WifiScanner.getSingleScanResults()` —— 内部组件（如 `WifiNetworkFactory`）和外部 App 通过 Binder 调用时都读这里。过期机制是**惰性过滤**——数据留在内存，查询时按 `ScanResult.timestamp` 过滤掉超过 180s 的条目：

```java
public List<ScanResult> filterCachedScanResultsByAge() {
    long currentTimeInMillis = mClock.getElapsedSinceBootMillis();
    return mCachedScanResults.stream()
        .filter(sr -> ((currentTimeInMillis - (sr.timestamp / 1000))
                < CACHED_SCAN_RESULTS_MAX_AGE_IN_MILLIS))
        .collect(Collectors.toList());
}
```

---

**第二层：`ScanRequestProxy` 双缓存（无时间过滤）**

```java
// ScanRequestProxy.java
private final Map<String, ScanResult> mFullScanCache = new HashMap<>();
private final LruCache<String, ScanResult> mPartialScanCache
        = new LruCache<>(PARTIAL_SCAN_CACHE_SIZE); // 200 条
```

这层缓存服务于 `WifiManager.getScanResults()` —— App 最常用的 API。没有时间过期，全频段扫描到来时整体清空重填，部分频段扫描增量更新（LRU 淘汰）。

---

**第三层：`WifiPickerTracker` 15s 缓存（UI 层）**

这层在 §5.3 末尾的 UI 缓存说明中详细介绍——Settings 页面专用，15 秒过期窗口。

**三层缓存的关系**：

| 层   | 所属组件                     | 消费者                               | 过期策略                   | 数据来源                                |
| ---- | ---------------------------- | ------------------------------------ | -------------------------- | --------------------------------------- |
| ①    | `WifiSingleScanStateMachine` | `WifiScanner.getSingleScanResults()` | 180s 惰性过滤              | 全频段单次扫描完成时写入                |
| ②    | `ScanRequestProxy`           | `WifiManager.getScanResults()`       | 无时间过滤；全频段来时清空 | `GlobalScanListener` 回调写入           |
| ③    | `WifiPickerTracker`          | Settings UI                          | 15s 窗口                   | `WifiManager.getScanResults()` 二次缓存 |

三层缓存各有消费方，但真正驱动网络选择的是另一层——`WifiNetworkFactory`。它不在上述三层之中，而是在第一层之上又叠加了自己的过滤逻辑。

**关键区别**：`WifiNetworkFactory`（网络评分组件）做了**双重过滤**——先通过第一层的 180s 过滤，再用自己定义的 30s 常量二次过滤，只使用最近 30 秒内的扫描结果。这保证了网络选择决策基于最新的信号数据：

```java
// WifiNetworkFactory.java
private static final int CACHED_SCAN_RESULTS_MAX_AGE_IN_MILLIS = 30 * 1000; // 30 秒

private ScanResult[] getFilteredCachedScanResults() {
    // 第一层：从 WifiScanningServiceImpl 拿结果（已过滤 >180s 的）
    List<ScanResult> cachedScanResults = mWifiScanner.getSingleScanResults();
    // 第二层：再过滤掉 >30s 的
    long currentTimeInMillis = mClock.getElapsedSinceBootMillis();
    return cachedScanResults.stream()
        .filter(sr -> ((currentTimeInMillis - (sr.timestamp / 1000))
                < CACHED_SCAN_RESULTS_MAX_AGE_IN_MILLIS))
        .toArray(ScanResult[]::new);
}
```

所以 `WifiNetworkFactory` 实际只使用最近 **30 秒**内的扫描结果做网络选择——比 `WifiScanningServiceImpl` 的 180s 缓存窗口严格 6 倍。

## 5.3 完整的分发链

```
  → WificondScannerImpl.pollLatestScanData()
    ├── 过滤：去掉非本次扫描的结果（timestamp/age 校验，见下方过滤机制详解）
    └── 保留有效 BSS
        → Callback to WifiScanningServiceImpl (CMD_SCAN_RESULTS_AVAILABLE)
          → ScanningState.processMessage()
            → handleScanResults(ScanData)
              → reportScanResults()
                ├── Client 1 (Settings): ScanListener.onResults(results)
                │     → scanLoop() 继续每 10s 扫
                ├── Client 2 (WifiConnectivityManager): ScanListener.onResults(results)
                │     → 网络选择逻辑判断
                └── Client 3 (App): ScanListener.onResults(results)
                      → 广播 SCAN_RESULTS_AVAILABLE_ACTION
              → transitionTo(mIdleState)  // 回到空闲
```

**过滤机制详解**：wificond 返回的结果中可能混杂了之前扫描的缓存旧条目。`WificondScannerImpl.pollLatestScanData()` 做**两层过滤**：

1. **时间戳过滤**：Framework 记录了本次扫描的 `startTimeNanos`（`SystemClock.elapsedRealtimeNanos()`），遍历所有结果时比较每个 `ScanResult.timestamp`（微秒），**早于 `startTimeNanos / 1000` 的结果被丢弃**
2. **频率过滤**：结果的频率必须在 `mLastScanSettings.singleScanFreqs` 中——但 **6GHz 结果例外**（因 RNR 机制，6GHz AP 可能通过 2.4/5GHz Beacon 的 RNR IE 被发现，即使不在请求的频率列表中也保留）

过滤数量通过 `Log.d` 打印（格式：`"Filtering out N scan results."`），具体数字取决于扫描间隔和 AP 环境密度。

```java
// WificondScannerImpl.java — 过滤逻辑核心（两层过滤）
long startTimeMicros = mLastScanSettings.startTimeNanos / 1_000;
int filteredCount = 0;
for (NativeScanResult result : nativeResults) {
    // 第一层：时间戳过滤
    if (result.timestamp < startTimeMicros) {
        filteredCount++;  // 早于本次扫描，丢弃
        continue;
    }
    // 第二层：频率过滤（6GHz 结果因 RNR 机制放行）
    if (!ScanResult.is6GHz(result.frequency) &&
            !mLastScanSettings.singleScanFreqs.containsChannel(result.frequency)) {
        filteredCount++;  // 非 6GHz 且不在请求频率列表中，丢弃
        continue;
    }
    results.add(result);  // 有效结果
}
```

**关键细节**：Settings 收到结果后触发 `WifiPickerTracker.onWifiEntriesChanged()` 更新 UI。但 UI 刷新不是无条件的——`WifiPickerTracker` 内部有一个 **15 秒的缓存过期窗口**（由 `ScanResultUpdater` 管理，`mMaxScanAgeMillis` 默认 15 秒，实际值由 `BaseWifiTracker` 构造函数参数 `maxScanAgeMillis` 传入）。收到扫描广播后，`conditionallyUpdateScanResults()` 调用 `mScanResultUpdater.getScanResults(mMaxScanAgeMillis)`——只取最近 15 秒内的结果更新 UI；超过 15 秒的旧结果自动过期淘汰。

扫描失败时窗口扩大到 5 分钟（`MAX_SCAN_AGE_FOR_FAILED_SCAN_MS`），防止列表突然清空。WifiConnectivityManager 收到结果后触发网络选择——如果已经连接且信号良好，不做任何操作；如果未连接，可能触发自动连接逻辑。

> Android Framework 层的扫描（本文）和 wpa_supplicant 的扫描（中篇）各自有独立的缓存体系——Framework 缓存 `ScanResult` Java 对象（面向 UI），supplicant 缓存 `wpa_bss` C 结构体（面向连接决策），两者互不共享。

---

# 6 扫描参数详解

> 前面我们追踪了雷达的指挥链路——从指挥中心下达指令、翻译官转译参数、到天线控制器执行发射。现在来检查每项探测参数是怎么从指挥中心逐级传到天线的：频率列表、SSID 列表、MAC 地址——每个参数都有自己的聚合规则和变换路径。打个比方，这一章拧的是雷达面板上的几个旋钮：频率列表是「扫哪个波段」的选段旋钮，SSID 列表是「重点锁定哪个目标」的瞄准旋钮，MAC 随机化是「关掉自身雷达识别灯」的隐身开关——每个旋钮从指挥中心拧到天线，都要经过一层刻度换算。

>扫描参数在 Framework → wificond → nl80211 之间经历三次格式变换——Java `ScanSettings` → C++ `SingleScanSettings` → netlink 属性。理解每次变换，就理解了每个参数在哪个层起作用。

## 6.1 频率列表 —— 三层聚合

| 层级          | 数据格式                                                     | 聚合逻辑                                                     |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Framework** | `ScanSettings.band`（`WIFI_BAND_24_GHZ` / `WIFI_BAND_5_GHZ` / `WIFI_BAND_6_GHZ` ...） | `ChannelHelper.updateChannels()` 通过 `WifiNative.getChannelsForBand()` 逐 band 获取信道列表 → `setBandChannels()` 合并。底层 wificond 通过 `IWifiChip.GetBandInfo()`（AIDL 接口）+ `NL80211_CMD_GET_WIPHY` 获取真实的 phy 信道能力 |
| **wificond**  | `vector<uint32_t> freqs`（每个频率的具体 MHz 值）            | 从 `ChannelSettings.channel_settings_` 逐一提取，去重        |
| **nl80211**   | `NL80211_ATTR_SCAN_FREQUENCIES` 嵌套属性                     | 空列表 = 扫描全部；非空 = 只扫指定频率                       |

**为什么三层要用三种不同的格式？** 这是抽象粒度逐层收窄的结果。Framework 面向 App，App 的心智模型是「扫 2.4G 还是 5G」这种频段概念，所以用 `ScanSettings.band` 枚举；wificond 面向 nl80211，必须把 band 展开成内核认识的 MHz 数值——于是 `getChannelsForBand()` 逐 band 拉取的信道列表在这里落成 `vector<uint32_t> freqs`；nl80211 面向 netlink 报文，只能用 `NL80211_ATTR_SCAN_FREQUENCIES` 嵌套属性承载「频率列表」这个结构化数据。每层只保留自己那层需要的抽象，越往下越贴近硬件事实。

**关键行为**：Framework 侧的 band 展开不仅看频段——DFS 信道是否被包含取决于传入的 band 参数（`WIFI_BAND_5_GHZ` 不含 DFS，`WIFI_BAND_5_GHZ_WITH_DFS` 含）。受管制信道的可用性最终由底层 wificond 通过 `NL80211_CMD_GET_WIPHY` 返回的信道列表决定，不在 Framework 层做显式过滤。

**国家码如何影响扫描信道？** 扫描信道列表不是固定的——它受**当前国家码**（country code）约束。国家码决定了 regulatory domain（监管域），监管域规定了每个频段允许使用的信道、最大发射功率、是否需要 DFS。整条链路是：

- 用户/运营商设置国家码（如 "CN"/"US"/"JP"）
- cfg80211 regulatory hint（`NL80211_CMD_SET_REG` / CRDA）
- 内核 regulatory database 查询允许的信道列表
- `wiphy->bands[]` 中标记每个信道的 flags（`IEEE80211_CHAN_DISABLED` / `NO_IR` / `DFS`）
- `NL80211_CMD_GET_WIPHY` 返回实际可用信道
- wificond / Framework 据此构建扫描频率列表

这意味着同一个设备在不同国家扫到的信道可能不同——比如 5GHz DFS 信道（52-144）在美国可用但在某些国家被禁用，6GHz 信道在未开放 6GHz 的国家完全不可见。

**扫描失败时排查信道问题，第一步就是确认当前国家码和 regulatory domain 是否正确。**

## 6.2 隐藏网络 SSID —— wildcard + 逐个探测 + 数量限制

频率列表决定了扫描仪在哪些信道上监听，但还有一个关键问题——扫描仪在 Probe Request 里填什么 SSID？这决定了它能否发现隐藏网络。

普通网络扫描只需一个 wildcard SSID（空字节）——AP 看到 wildcard Probe Request 就会回复。但隐藏网络（不广播 SSID）必须**点名探测**。

**802.11-2024 支持 SSID List 元素**，一个 Probe Request 可以携带多个 SSID。但实际实现中，SSID 数量受到多重限制：

| 驱动/层                                       | 最大 SSID 数                                   | 说明                            |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| QCOM host (qcacld) `WLAN_SCAN_MAX_NUM_SSID`   | **16**                                         | `wlan_scan_public_structs.h:47` |
| QCOM kernel (ath12k) `WLAN_SCAN_MAX_NUM_SSID` | **10**                                         | `wmi.h:3124`                    |
| mtk gen4m                                     | 由 `scan_capabilities.max_num_scan_ssids` 上报 | 通过 wiphy 能力通告             |
| 老驱动 (max_scan_ssids = 1)                   | **1**                                          | 只能交替发 wildcard 和具体 SSID |

**为什么不做多？** 限制来自三个方面：

1. **Probe Request 帧空间**：802.11 管理帧最大 ~2346 字节（不含 A-MPDU），每个 SSID 占 2+N 字节（Element ID + Length + SSID），加上 HT/VHT/HE Capabilities 等必须 IE，实际可用空间有限
2. **驱动能力通告**：`max_num_scan_ssids` 是驱动通过 `wiphy` 向内核通告的能力上限，固件按此值分配扫描命令缓冲区——超出就溢出
3. **空口效率**：每个隐藏 SSID 需要 AP 独立匹配并回复 Probe Response，dwell time 不变但信道上竞争增加。16 个 SSID 意味着最多 16 个 AP 同时回复——在密集环境中碰撞概率急剧上升

**老驱动的折中**：当 `max_num_scan_ssids == 1` 时，wificond 会在多次扫描请求中交替携带 wildcard SSID 和具体 SSID。但由于 dwell time 有限（主动 ~40ms），隐藏网络数量必须受限——这就是为什么 `WificondScannerImpl` 会限制 `hiddenNetworkSSIDSet` 的大小。

实际扫描参数构建中，wificond 会先加入 wildcard SSID，再逐个追加隐藏网络 SSID：

```
ssids 列表：
  [0] = {}               // wildcard —— 探测所有非隐藏 AP
  [1] = "MyHiddenWiFi"   // 具体 SSID —— 单独探测这个隐藏网络
  [2] = "OfficeAP"       // 具体 SSID —— 单独探测这个隐藏网络
  ... 最多 16 个（QCOM host 限制）
```

超出 `max_num_scan_ssids` 的 SSID 会被跳过（wificond 日志：`Skip scan ssid for single scan`）。

## 6.3 MAC 地址随机化 —— 仅扫描态生效

随机化策略在两个层面控制：

| 层             | 判断条件                                                     | 作用                                 |
| -------------- | ------------------------------------------------------------ | ------------------------------------ |
| **wificond**   | `wiphy_features_.supports_random_mac_oneshot_scan && !IsAssociated()` | 设置 `NL80211_SCAN_FLAG_RANDOM_ADDR` |
| **Supplicant** | `wpa_state <= WPA_SCANNING`（见中篇）                        | 仅在扫描态生成随机 MAC               |

两层判断是一致的核心原则：**已连接状态下扫描不使用随机 MAC**——因为扫描同一个 ESS 的其他 BSS（漫游场景）时，使用随机 MAC 会让 AP 不认识你。

## 6.4 6GHz RNR —— 一个标志打开新世界

`enable_6ghz_rnr` 标志对应 `NL80211_SCAN_FLAG_COLOCATED_6GHZ`。设置后：

- 内核在扫描 2.4/5GHz 时，自动从 AP 的 Beacon/Probe Response 中提取 `Reduced Neighbor Report` IE
- RNR IE 包含了同位置 6GHz AP 的信息（信道号、BSSID、Short SSID）
- Framework 在结果中能看到 6GHz AP，即使没有单独扫描 6GHz 频段

> 这个机制在下篇（WiFi 6E/7）中会详细展开——它本质上是 **6GHz 的跨频段发现**，不需要 STA 在 59 个 6GHz 信道上逐一 Probe。

---

# 7 总结

## 7.1 各层职责

| 层级                   | 关键组件                          | 核心职责                                      | 数据格式                           |
| ---------------------- | --------------------------------- | --------------------------------------------- | ---------------------------------- |
| **App**                | `WifiManager.startScan()`         | 发起扫描请求                                  | 无参数                             |
| **Framework 节流**     | `ScanRequestProxy`                | 前后台限频（FG 4次/120s，BG 1次/30min）       | —                                  |
| **Framework 调度**     | `WifiScanningServiceImpl`         | 状态机（Idle→Scanning→Idle），请求合并        | `WifiScanner.ScanSettings`         |
| **Java→C++ 桥**        | `WifiNl80211Manager`              | AIDL 跨进程调用                               | `SingleScanSettings`（Parcelable） |
| **wificond**           | `ScannerImpl::scanRequest()`      | SSID/频率提取，MAC 随机化判断，错误处理       | `vector<SSID>`, `vector<freq>`     |
| **wificond→内核**      | `ScanUtils::Scan()`               | 构建 NL80211_CMD_TRIGGER_SCAN + 属性          | netlink 嵌套属性                   |
| **内核**               | cfg80211                          | 验证信道，分发给驱动                          | `cfg80211_scan_request`            |
| **内核→wificond**      | `NL80211_CMD_NEW_SCAN_RESULTS`    | 扫描完成通知（netlink multicast）             | —                                  |
| **wificond→Framework** | `IScanEvent::OnScanResultReady()` | AIDL 回调，触发结果拉取                       | `NativeScanResult[]`               |
| **Framework 分发**     | `reportScanResults()`             | 遍历 mActiveScans，按 settings 过滤后逐个回调 | `ScanData[]`                       |
| **UI 层**              | `WifiPickerTracker`               | 15s 缓存窗口过滤，更新 WiFi 列表              | `ScanResult`                       |

## 7.2 关键设计决策

- **请求合并不是排队**——多个同时到达的扫描请求合并为一轮，结果分发给所有调用方，而不是依次排队扫
- **ENODEV 看门狗**——第 4 次连续网卡消失（ENODEV）时直接 crash 重启 wificond，比静默失败更容易暴露问题
- **空频率列表的巧妙之处**：不指定 `NL80211_ATTR_SCAN_FREQUENCIES` 时内核默认扫所有支持的信道。这是有意为之——不是疏漏，而是把信道选择的决策权留给内核，由内核根据当前 regulatory domain 和 phy 能力自行决定
- **两圈分发让结果各取所需**：`mActiveScans` 拿到按 settings 过滤后的结果，`mSingleScanListeners` 拿到原始全量——同一份扫描数据，不同消费者看到不同的裁剪视图
- **三层缓存各司其职**：`WifiScanningServiceImpl` 用 180s 惰性过滤服务内部组件，`ScanRequestProxy` 无时间过滤服务 `WifiManager.getScanResults()`，`WifiPickerTracker` 用 15s 窗口更新 UI。在此之上，`WifiNetworkFactory` 再做 30s 二次过滤——确保网络选择始终基于最新信号

回看整条链路，一次扫描就像雷达站完成了一次探测周期：操作员（App）按下按钮，指挥中心（`WifiScanningServiceImpl`）合并各方的探测意图，节流阀（`ScanRequestProxy`）把关发射频率，翻译官（wificond）把指令编成脉冲参数，天线控制器（cfg80211）校准后把探测脉冲（Probe Request）发射出去，最后回收回波（Probe Response）分发给每一个等待结果的操作员——从按下按钮到看到列表刷新，中间每一步都在这条链路上留有痕迹。

## 7.3 下发 + 上报完整调用链

```none
【下发路径】
App.startScan()
  → WifiServiceImpl
    → ScanRequestProxy.startScan()
      [节流判断]
      → WifiScanningServiceImpl.startScan()
        [状态机: IdleState → tryToStartNewScan → ScanningState]
        → WifiNative.scan()
          → WifiNl80211Manager.startScan2()
            → IWifiScannerImpl.scanRequest()       // AIDL 跨进程
              → ScannerImpl::scanRequest()          // wificond C++
                → ScanUtils::Scan()
                  → NL80211_CMD_TRIGGER_SCAN         // netlink 到内核

【上报路径】
内核 cfg80211_scan_done()
  → NL80211_CMD_NEW_SCAN_RESULTS                    // netlink multicast
    → wificond ScannerImpl::OnScanResultsReady()
      → IScanEvent::OnScanResultReady()             // AIDL 回调到 Framework
        → WifiNl80211Manager callback
          → WifiScanningServiceImpl.ScanningState
            → CMD_SCAN_RESULTS_AVAILABLE
              → handleScanResults(ScanData)
                → reportScanResults()
                  ├── mActiveScans: filterResultsForSettings() → 逐个回调
                  └── mSingleScanListeners: 原始全量回调
              → transitionTo(mIdleState)             // 回到空闲，触发下一轮
                → Settings: WifiPickerTracker 15s 缓存过滤 → UI 刷新
                → WifiConnectivityManager: 网络选择逻辑
                → App: 广播 SCAN_RESULTS_AVAILABLE_ACTION
```

> **下一篇**：wpa_supplicant 内部的 `wpa_supplicant_scan()` 怎么做参数构建、radio work 为什么要排队、BSS 缓存怎么管理、网络选择怎么收口。

---

*本文基于 AOSP 源码（[packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi/) + [system/connectivity/wificond](https://android.googlesource.com/platform/system/connectivity/wificond/)）+ IEEE 802.11-2024 规范写作。代码以撰写时的 main 分支为准，行号可能随版本更新而变化。*
