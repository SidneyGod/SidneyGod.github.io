---
title: SAP（一）开民宿：从点击到 Beacon
top: 1
related_posts: true
abbrlink: 4f924787
date: 2026-09-19 21:30:55
tags:
  - Android WiFi
  - SAP
categories:
  - WiFi
  - Code
---

> 当你打开手机热点，朋友连上你的网络上网，手机在不到一秒内完成了角色转换——从住客变成开民宿的老板。这一章，我们从 Framework 层追踪这条完整的启动链路：从用户点击"开启热点"，一路追到 AIDL 调用 `HostapdHal.addAccessPoint()` 跨进程的那一刻。

# 本章导读

读完本章，你能自己追踪一次 SAP 启动的完整调用链，理解 `HalDeviceManager` 的接口兼容性检查、频段配置的决策逻辑、`SoftApManager` 状态机的 5 个状态，以及 `setupInterfaceForSoftApMode` 6 个步骤的每个细节。

<!--more-->

**注意**：本文停在 `addAccessPoint()` AIDL 调用。hostapd 守护进程启动、ACS 选频、BSS 初始化、Beacon 组装、nl80211、驱动固件——这些全部留给下一篇关于 hostapd 的章节。如果你对 STA 侧的 Framework 启动链路还不熟悉，先看架构总览一章会有帮助。

> 本章 WiFi 侧代码引用来自 AOSP `packages/modules/Wifi`。调用链中的 Tethering 路径涉及 `packages_modules_Connectivity/Tethering` 等模块，详见 §2.1。

![5 层栈 SAP 模式架构图](assets/10a-SAP%EF%BC%88%E4%B8%80%EF%BC%89%E5%BC%80%E6%B0%91%E5%AE%BF%EF%BC%9A%E4%BB%8E%E7%82%B9%E5%87%BB%E5%88%B0-Beacon/10a-architecture.svg)

---

# 1 从住客到老板：角色反转

在 STA 模式下，手机是一个 WiFi 客户端，去连接别人的 AP。打开热点之后，手机自己变成了 AP——不再被动扫描周围的热点，而是主动发射 Beacon，等待其他 STA 来连接。

这两个模式在 Android WiFi 架构中对应两套完全不同的代码路径。下表对比核心差异：

| 维度              | STA 模式                       | SAP 模式                    |
| ----------------- | ------------------------------ | --------------------------- |
| 配置入口          | `WifiManager.setWifiEnabled()` | `WifiManager.startSoftAp()` |
| Framework 管理器  | `ConcreteClientModeManager`    | `SoftApManager`             |
| HAL 接口类型      | `WifiStaIface`                 | `WifiApIface`               |
| 用户态守护进程    | wpa_supplicant                 | hostapd                     |
| 内核 nl80211 角色 | station                        | AP                          |
| 比喻角色          | 住客（找民宿、入住）           | 老板（开门迎客、发 Beacon） |

SAP 启动时，STA 连接通常保持不变——`ActiveModeWarden` 为 SAP 分配独立的 `SoftApManager`，不影响已有的 `ConcreteClientModeManager`。但如果硬件不支持 STA+AP 并发（无 DBS），`HalDeviceManager` 的 `createApIface()` 会遍历所有 `ChipMode`，发现没有任何一个模式能同时容纳 STA 和 AP——此时移除 STA 不是"选择"，而是硬件能力的必然结果。用户看到的是 WiFi 断连，但背后是单 radio 芯片的物理限制：一套射频硬件无法同时扮演两个角色。§4.2 的兼容性矩阵和穷举搜索逻辑详细分析了这个决策过程。

STA 用 wpa_supplicant，AP 用 hostapd——这是 WiFi 软件栈最根本的角色分岔。两者的代码世界完全不同：supplicant 关心"怎么找到并连接最好的 AP"，hostapd 关心"怎么配置一个 AP 并管理连接上来的 STA"。这个角色反转是本章的暗线——手机一夜之间从找民宿的住客变成了开民宿的老板。

但角色不同，框架却惊人地一致。`SoftApManager` 和 `ConcreteClientModeManager`（STA 模式的管理者）都使用 `StateMachine` 框架、都在构造函数最后一行发送 `CMD_START`、都通过 `ActiveModeWarden` 的 `WifiController` 状态机分配。在 `WifiNative` 中，SAP 的 `setupInterfaceForSoftApMode()` 和 STA 的 `setupInterfaceForClientInScanMode()` 共享同一个五步骨架：`startHal()` → `allocateIface()` → `createXxxIface()` → `wificond setup` → `registerNetworkObserver()`。

唯一的分叉点在 Step 2：SAP 多出 `startHostapd()`，因为 hostapd 在 `addAccessPoint()` 时就需要 HAL 通道来初始化 BSS，必须提前就绪；STA 侧的 wpa_supplicant 则不需要——它直到 `switchClientInterfaceToConnectivityMode()` 才通过 `startSupplicant()` 启动（`WifiNative.java:1768`），因为 STA 的接口搭建只创建扫描模式接口（`IFACE_TYPE_STA_FOR_SCAN`），连接模式的需求来得更晚。框架层的统一 + 实现层的分叉，是 Android WiFi 子系统"同一套调度逻辑，不同的执行引擎"设计哲学的体现。

# 2 一条消息的旅程：触发链路全追踪

收银台点一下按钮，后厨要跑多少步？从用户点击到 `SoftApManager` 创建，中间经过 6 层调用。每一层都有明确的职责。

## 2.1 完整调用链

```
Settings App (TetheringSettings)
  → TetheringManager.startTethering()           // Tethering 模块入口
    → TetheringService → Tethering.startTethering()   // AIDL 跨进程到 Tethering 服务
      → Tethering.setWifiTethering()             // 按类型分发，WiFi 走此路径
        → WifiManager.startTetheredHotspot()     // 跨进程 Binder 调用到 WiFi 服务
          → WifiServiceImpl.startTetheredHotspot()  // 权限检查 + 用户限制
            → startSoftApInternal()             // 内部汇聚点：两入口在此合一
              → ActiveModeWarden.startSoftAp()     // WiFi 子系统调度员
                → WifiController.sendMessage(CMD_SET_AP)   // 状态机消息
                  → startSoftApModeManager()       // 创建 SoftApManager
                    → new SoftApManager(...)       // 构造函数开工
```

## 2.2 步步拆解

**TetheringManager.startTethering()** —— Tethering 模块的入口。用户在 Settings 中点击"开启热点"后，Settings 调用 `TetheringManager.startTethering(TetheringRequest, Executor, StartTetheringCallback)`。这个方法通过 AIDL 跨进程调用到 `TetheringService`，后者委托给 `Tethering` 类处理。

为什么要绕 Tethering 这一圈？因为热点不只是 WiFi 的事——Android 的 Tethering 框架统一管理 USB、蓝牙、WiFi、以太网等多种共享网络方式，`TetheringManager` 是所有这些方式的公共入口，WiFi 热点只是其中 `TETHERING_WIFI` 这一个分支。

**Tethering.setWifiTethering()** —— 按类型分发到 WiFi 路径。`Tethering.startTethering()` 内部调用 `enableTetheringInternal()`，根据 `TetheringRequest` 中的类型走 `switch` 分发。WiFi 类型进入 `setWifiTethering()`，该方法获取 `WifiManager` 实例，然后调用 `mgr.startTetheredHotspot(request, executor, callback)`——这是从 Tethering 模块跨入 WiFi 子系统的边界。

为什么这里要单独封装一个 `startTetheredHotspot()`？它是面向 Tethering 的公开 API（不同于下面讲的 `startSoftAp()` 这个 `@hide` 方法），携带了 `TetheringRequest` 中的完整配置信息，把配置从 Tethering 侧无损带到 WiFi 侧。

**WifiManager.startSoftAp()** —— WiFi 子系统的入口。这是一个 `@hide` 方法，普通 App 不能直接调用。只有持有 `NETWORK_STACK` 签名权限的系统组件（如 Settings、Tethering）才能触发。注意：Tethering 路径实际调用的是 `startTetheredHotspot()`（见上文），`startSoftAp()` 是另一条更直接的入口——两条路径在 `WifiServiceImpl` 内部汇聚到同一个 `startSoftApInternal()` 方法。

```java
// WifiManager.java:5815
public boolean startSoftAp(@Nullable WifiConfiguration wifiConfig) {
    try {
        return mService.startSoftAp(wifiConfig, mContext.getOpPackageName());
    } catch (RemoteException e) {
        throw e.rethrowFromSystemServer();
    }
}
```

- 方法体只做一件事：通过 `mService`（`IWifiManager` 的 Binder 代理）跨进程调用到 `system_server`。热点启动涉及 HAL 资源分配和系统状态变更，必须由 `WifiServiceImpl` 统一管控——App 进程随时可能被杀，热点的生命周期不能绑定在 App 进程上。
- 参数用的是旧格式 `WifiConfiguration` 而非 `SoftApConfiguration`——API 兼容性包袱。内部通过 `ApConfigUtil.fromWifiConfiguration()` 转换，但公开接口不能改签名。

**WifiServiceImpl.startSoftAp()** —— system_server 中的实现。职责是权限检查和参数组装。

```java
// WifiServiceImpl.java:1865
public boolean startSoftAp(WifiConfiguration wifiConfig, String packageName) {
    enforceNetworkStackPermission();          // 权限检查
    int callingUid = Binder.getCallingUid();
    mWifiPermissionsUtil.checkPackage(callingUid, packageName);

    SoftApConfiguration softApConfig = ApConfigUtil.fromWifiConfiguration(wifiConfig);

    if (!mTetheredSoftApTracker.setEnablingIfAllowed()) {
        return false;                         // 已有热点在启动，拒绝重复请求
    }

    // ... 清除可能的 LOHS 热点
    if (!startSoftApInternal(new SoftApModeConfiguration(
            WifiManager.IFACE_IP_MODE_TETHERED, softApConfig, ...), ...)) {
        mTetheredSoftApTracker.setFailedWhileEnabling();
        return false;
    }
    return true;
}
```

- `enforceNetworkStackPermission()` 放在第一行——权限检查必须在任何资源分配之前。如果先分配资源再检查权限，恶意调用者可以通过高频请求耗尽资源，即使权限检查最终拒绝了请求。
- `setEnablingIfAllowed()` 是一个状态锁：热点启动是异步多阶段过程，如果允许两个启动请求同时进入，两个 `SoftApManager` 会争抢同一个 HAL 接口，结果是两个都失败。
- `fromWifiConfiguration()` 转换旧格式——这里不转换不行，因为后续所有内部逻辑（`SoftApConfiguration.Builder`、频段配置、安全类型）都基于新格式，如果直接透传旧格式，每个下游函数都要写兼容代码。
- `startSoftApInternal()` 构建 `SoftApModeConfiguration`（封装 IP 模式 + 配置 + 请求者身份），然后交给 `ActiveModeWarden`——这是 Framework 的调度枢纽，所有 WiFi 模式（STA/SAP/P2P/NAN）都通过它分配 `ModeManager`。

**ActiveModeWarden.startSoftAp()** —— WiFi 子系统的"总调度员"。不执行任何具体操作，只负责发送状态机消息。

```java
// ActiveModeWarden.java:862
public void startSoftAp(SoftApModeConfiguration softApConfig, WorkSource requestorWs) {
    mWifiController.sendMessage(WifiController.CMD_SET_AP, 1, 0,
            Pair.create(softApConfig, requestorWs));
}
```

- `arg1 = 1` 表示"开启"，`arg2 = 0` 表示不指定 IP 模式（留给 `SoftApModeConfiguration` 内部决定）。
- 消息体是一个 `Pair<SoftApModeConfiguration, WorkSource>`，携带完整配置和请求者身份。

# 3 总调度员的职责：WifiController 状态机

`WifiController` 是 `ActiveModeWarden` 内部的状态机，管理整个 WiFi 子系统的开关状态。在民宿的比喻里，它相当于行业协会——老板（`SoftApManager`）提交开店申请（`CMD_SET_AP`），协会审批通过后才能正式开业。它只有两个核心状态：`DisabledState` 和 `EnabledState`（外加一个 `DefaultState` 作为父状态处理全局消息）。

```
         ┌──────────────┐
         │ DefaultState │  (处理飞行模式、紧急模式、Satellite 模式等全局消息)
         └──────┬───────┘
        ┌───────┴───────┐
   ┌────┴───┐     ┌─────┴──────┐
   │Disabled│     │  Enabled    │
   │ State  │     │   State     │
   └───┬────┘     └─────┬───────┘
       │                │
  CMD_SET_AP(1)    CMD_SET_AP(1)
       │                │
       ▼                ▼
  startSoftAp       startSoftAp
  ModeManager       ModeManager
       │                │
  → Enabled         (保持 Enabled)
```

CMD_SET_AP 在两个状态中都会被处理：

**DisabledState 收到 CMD_SET_AP**（WiFi 完全关闭时开启热点）：

```java
// ActiveModeWarden.java:2351-2360
case CMD_SET_AP:
    if (msg.arg1 == 1) {
        Pair<SoftApModeConfiguration, WorkSource> softApConfigAndWs =
                (Pair) msg.obj;
        startSoftApModeManager(
                softApConfigAndWs.first, softApConfigAndWs.second);
        transitionTo(mEnabledState);
    }
    break;
```

- 创建 `SoftApManager`，然后状态机迁移到 `EnabledState`。
- WiFi 从 Disabled 变成 Enabled——但不是为了 STA 连接，而是因为 SAP 需要底层硬件处于工作状态。

**EnabledState 收到 CMD_SET_AP**（WiFi 已经开启时再开热点）：

```java
// ActiveModeWarden.java:2598-2607
case CMD_SET_AP:
    if (msg.arg1 == 1) {
        startSoftApModeManager(...);   // 创建新的 SoftApManager
    } else {
        stopSoftApModeManagers(msg.arg2);  // 关闭指定模式的热点
    }
    break;
```

- 已经在 EnabledState，不需要再次迁移，直接创建 `SoftApManager`。

`startSoftApModeManager()` 最终调用 `new SoftApManager(...)` 构造 `SoftApManager` 实例。构造函数的最后一行发送 `CMD_START` 启动状态机——下一节我们深入 `SoftApManager` 内部。

# 4 民宿开张前的资质审查：HalDeviceManager 接口兼容性

热点不是想开就能开的。WiFi 芯片的硬件能力决定了它能同时跑多少个接口、每个接口能在什么频段上工作。`HalDeviceManager` 负责在创建 AP 接口前做一系列兼容性检查——就像一场严格的资质审查。

## 4.1 芯片能干什么：Capabilities 与 ChipMode

驱动通过 HAL 向 Framework 上报两个层次的芯片能力信息：

**Chip Capabilities（芯片级能力）**：通过 `WifiChip.getCapabilitiesBeforeIfacesExist()` 获取，返回一个 `BitSet`。这是一个位图，每个比特位代表一种硬件能力。关键能力类型包括：

- 双 STA 支持：是否支持同时运行两个 STA 接口
- DBS（Dual Band Simultaneous）：两个 radio 是否能在不同频段同时工作
- MLO 支持：是否支持 Multi-Link Operation

**ChipMode（芯片工作模式）**：通过 `WifiChip.getAvailableModes()` 获取，返回一个 `List<ChipMode>`。每个 `ChipMode` 包含：

- `id`：模式编号
- `availableCombinations`：该模式下允许的并发接口组合列表（`List<ChipConcurrencyCombination>`）

每个 `ChipConcurrencyCombination` 描述了一组可以同时存在的接口组合，例如：

```
[{STA, 2.4GHz}, {AP, 5GHz}]  →  STA 在 2.4G + AP 在 5G 可以共存（DBS）
[{STA, 2.4GHz}]               →  只允许一个 STA 接口（无并发）
```

这些能力信息并非静态配置——它们从驱动层一路流到 Framework 的决策函数。流转路径的第一段：驱动通过 HAL 上报每个频段的可用信道列表，`WifiChip.getAvailableModes()` 提供并发组合，`ApConfigUtil.getAvailableChannelFreqsForBand()` 查询 HAL 获取具体信道编号。

第二段：`ApConfigUtil.updateSoftApCapabilityWithAvailableChannelList()` 将结果写入 `SoftApCapability.setSupportedChannelList()`（按 2.4G/5G/6G/60G 四个频段分别存储），`chooseApChannel()` 读取该列表做信道决策。

当国家码变更时，`TetheredSoftApTracker.updateAvailChannelListInSoftApCapability()` 触发重新查询，先清空旧列表再从 HAL 重新获取——这保证了信道列表始终与当前监管域一致。

## 4.2 createApIface 的决策流程

`HalDeviceManager.createApIface()` 调用内部方法 `createIface()`，后者执行完整的决策树：

![HalDeviceManager createApIface 决策流程](assets/10a-SAP%EF%BC%88%E4%B8%80%EF%BC%89%E5%BC%80%E6%B0%91%E5%AE%BF%EF%BC%9A%E4%BB%8E%E7%82%B9%E5%87%BB%E5%88%B0-Beacon/10a-hdm-decision.svg)

```
createIface(mode=AP)
  │
  ├── 1. getCapabilitiesBeforeIfacesExist()
  │     └── 获取芯片静态能力
  │
  ├── 2. getAvailableModes()
  │     └── 获取所有可用 ChipMode 及其并发组合
  │
  ├── 3. getBestIfaceCreationProposal()          ← 核心搜索
  │     ├── 遍历每个芯片 → 每个 ChipMode → 每个并发组合
  │     ├── 对每个组合调用 canCreateTypeComboSupportRequest()
  │     │     ├── 超出容量？先降级桥接 AP，再删除低优先级接口
  │     │     └── 通过？生成 IfaceCreationData 提案
  │     └── 用 compareIfaceCreationData() 比较所有提案
  │           ├── 优先选择：需要移除的高优先级接口最少
  │           ├── 其次选择：需要降级的接口最少
  │           └── 平局：任意（flip a coin）
  │
  ├── 4. executeChipReconfiguration()            ← 执行
  │     ├── 需要模式切换？先移除该芯片上所有接口
  │     │     └── configureChip(modeId) → 失败则 invalidate + teardownInternal
  │     └── 不需要？只移除/降级提案中标记的接口
  │
  ├── 5. chip.createApIface(vendorData)
  │     └── HAL 层真正创建 AP 接口
  │
  └── 失败路径：
        ├── 无可用 ChipMode → SUPPRESSED (接口冲突)
        ├── configureChip 失败 → invalidate + teardownInternal (全局清理)
        └── createApIface 返回 null → 返回 null 给调用者
```

步骤 3 是整个决策树的算法核心。`getBestIfaceCreationProposal()` 并不是"找到第一个可行方案就用"——它穷举所有芯片、所有模式、所有并发组合，对每个组合生成一个提案，然后在所有可行提案中选最优。

为什么要穷举而不是贪心（找到第一个可行方案就停）？因为同一块芯片的多种 ChipMode 之间存在互斥依赖——选定一个 ChipMode 意味着排除该芯片上的其他模式，而不同模式下需要移除的已有接口数量差异可能很大。贪心策略会在第一个"看起来可行"的方案上停下来，但这个方案可能需要断开正在使用的 STA 连接，而换一个 ChipMode 可能零代价就能满足需求。

穷举的计算代价真的能接受吗？代价是 O(chips x modes x combinations)，但实际硬件上每块芯片通常只有 3-5 种 ChipMode、每种模式最多十几个并发组合——总量不过百，穷举完全可行。选错模式可能导致正在使用的 STA 连接被断开——穷举保证了找到"代价最小"的方案。

`compareIfaceCreationData()` 的比较策略体现了"最小破坏"原则：先按 `CREATE_TYPES_BY_PRIORITY`（AP > AP_BRIDGE > STA > P2P > NAN）的顺序比较每种类型需要移除的数量——AP 接口的优先级最高，因为移除一个正在服务客户端的 AP 比移除一个 STA 的后果更严重（STA 可以自动重连，AP 断开意味着所有客户端同时掉线）。如果移除数量相同，再比较需要降级的数量。这个排序逻辑直接决定了"先降级再删除"的工程原则能否落地——降级编码为比删除更轻量的操作，所以 compareIfaceCreationData 自然倾向于选择降级方案。

假设优先级反转——STA 排在 AP 前面——会发生什么？用户正在用热点给三台设备共享网络（AP 接口活跃），此时某个后台 App 请求创建 STA 连接。按照反转后的优先级，系统会保留 STA 而移除 AP——三台设备同时掉线，用户却不知道为什么。AP 接口的"扇出"特性决定了它的保护优先级：一个 AP 服务 N 个客户端，移除的代价是 O(N)；一个 STA 只服务自己，移除的代价是 O(1)。这个扇出因子正是优先级排序的数学基础——在资源竞争时，保护影响面更大的资源。

类比 Linux 内核的读写锁设计：AP 相当于 writer（持有锁时所有 reader 都被阻塞），STA 相当于 reader（一个 reader 的操作不影响其他 reader）。当 writer 和 reader 竞争时，writer 优先——因为 writer 的阻塞会导致所有 reader 排队，而一个 reader 的延迟只影响自己。

步骤 4 的 `executeChipReconfiguration()` 在模式切换时必须先移除芯片上所有接口——这看起来很激进，但 HAL 的 `configureChip()` 不支持增量切换，必须在干净状态下重新配置。如果 `configureChip()` 失败，代码调用 `mWifiHal.invalidate()` + `teardownInternal()` 做全局清理——此时芯片状态已经不可信，只能重建整个 HAL 连接。这就像装修时发现承重墙有问题，不能只修一面墙，必须把整个工程推倒重来。

`canCreateTypeComboSupportRequest()` 内部的"先降级再删除"逻辑是另一个工程亮点：当新增接口导致超出并发容量时，它先检查是否有足够的单 AP 容量（`availableSingleApCapacity`）来容纳降级后的接口——如果有，调用 `selectBridgedApInterfacesToDowngrade()` 将桥接 AP 降级为单 AP（释放一个接口槽位），而不是直接删除。降级桥接 AP 只是让用户从双频热点变成单频热点，而删除接口可能导致正在使用的连接断开。

只有降级不够时，才 fall through 到 `selectInterfacesToDelete()` 删除低优先级接口。如果系统不做降级，直接报错"接口冲突，请关闭现有连接后重试"，用户体验会急剧恶化——用户想开个热点分享网络，却被要求先断开自己的 WiFi 连接。降级策略把选择权留在系统手里：用户看到的是热点正常启动（只是少了 5GHz），而不是一个令人困惑的错误弹窗。这正是 Android WiFi 子系统"尽力而为"设计哲学的体现——能跑就跑，跑不全也要跑。

**兼容性矩阵——什么条件下可以创建 AP 接口**：

| 当前状态           | DBS 支持 | 能否创建 AP      | 策略                                                |
| ------------------ | -------- | ---------------- | --------------------------------------------------- |
| 无任何接口         | 无关     | 总是可以         | 直接创建                                            |
| STA 2.4GHz         | 支持     | 可以，AP 在 5GHz | DBS 两个 radio 独立工作                             |
| STA 2.4GHz         | 不支持   | 取决于 ChipMode  | 如果 ChipMode 允许 STA+AP 同频共存（SCC），则可创建 |
| STA 5GHz + AP 5GHz | 不支持   | 可能可以（SCC）  | 两个虚拟接口共享同一 radio                          |
| AP 已存在          | 无关     | 取决于 ChipMode  | 检查是否有 ChipMode 允许双 AP                       |
| STA + P2P          | 不支持   | 通常不可以       | 三接口并发需要 DBS                                  |

如果没有 DBS 支持（单 radio 芯片），STA 和 AP 只能通过 SCC（Single Channel Concurrency）模式共存——两个虚拟接口共享同一个物理 radio，必须工作在同一信道。这意味着开热点后如果 STA 连接的 WiFi 在 2.4GHz 信道 6，热点也只能在信道 6。两个角色共享同一套硬件，好比一个老板在同一个房间里既当前台又当厨师——CPU 层面没有冲突，射频层面必须协调。

整个 `HalDeviceManager` 的决策流程，从查芯片能力（你有没有房产证）、遍历并发组合（消防验收能不能过）、到模式切换和接口创建（工商变更登记），就是民宿开张前的资质审查——审查通过，才有资格进入下一步选铺位。

## 4.3 桥接模式的特殊处理

如果配置了桥接模式（`isBridged = true`）且不支持 MLO，`createApIface` 走 `HDM_CREATE_IFACE_AP_BRIDGE` 路径：

```java
// HalDeviceManager.java:381-383
WifiApIface apIface = (WifiApIface) createIface(isBridged ? HDM_CREATE_IFACE_AP_BRIDGE
        : HDM_CREATE_IFACE_AP, requiredChipCapabilities, ...);
```

桥接模式需要多个 AP 实例（`createBridgedApIface`），用于不同频段各自独立的一个 AP 接口。本节只简述，详细内容留给后续 hostapd 章节。

# 5 选个好铺位：频段配置与信道选择

硬件审查通过之后，老板要选铺位——开在哪个频段、用哪个信道。`ApConfigUtil.updateApChannelConfig()` 是这个决策过程的核心。

## 5.1 updateApChannelConfig 的逻辑

```java
// ApConfigUtil.java:987-1036
public static @SoftApManager.StartResult int updateApChannelConfig(
        WifiNative wifiNative, CoexManager coexManager,
        WifiResourceCache resources, String countryCode,
        SoftApConfiguration.Builder configBuilder,
        SoftApConfiguration config, SoftApCapability capability) {

    // 1. HAL 未启动 → 用默认信道
    if (!wifiNative.isHalStarted()) {
        configBuilder.setChannel(DEFAULT_AP_CHANNEL, DEFAULT_AP_BAND);
        return START_RESULT_SUCCESS;
    }

    // 2. 5GHz 必须有国家码
    if (config.getBand() == BAND_5GHZ && countryCode == null) {
        return START_RESULT_FAILURE_GENERAL;
    }

    // 3. ACS 未启用 → Framework 自己选信道
    if (!capability.areFeaturesSupported(SOFTAP_FEATURE_ACS_OFFLOAD)) {
        if (config.getChannel() == 0) {
            int freq = chooseApChannel(config.getBand(), coexManager, resources, capability);
            if (freq == -1) {
                return START_RESULT_FAILURE_NO_CHANNEL;
            }
            configBuilder.setChannel(ScanResult.convertFrequencyMhzToChannelIfSupported(freq), convertFrequencyToBand(freq));
        }
    }

    return START_RESULT_SUCCESS;
}
```

资质审查过了，老板要选铺位——频段和信道就是民宿的地段和门牌号。代码中有三个前置条件按优先级排列：HAL 是底层依赖（没有它后面的芯片查询全部失效）、国家码是监管前提（5GHz/6GHz 信道合法性取决于它）、ACS 是能力决策（芯片能自动选频就不需要 Framework 介入）。缺一个都开不了张：

1. **HAL 没启动？** 回退到默认信道（2.4GHz 信道 6），这个分支仅在异常恢复场景触发。相当于产权证还没办下来，只能先租个临时铺面。
2. **选了 5GHz 但没有国家码？** 直接失败。5GHz 信道的合法性取决于国家/地区的无线电管制，没有国家码 = 不知道哪些信道合法。好比选了个黄金地段，但没拿到经营许可——地段再好也不能开。
3. **ACS offload 不支持？** Framework 自己选信道。如果用户没有指定信道（`channel == 0`），调用 `chooseApChannel()` 自动选择。如果 ACS offload 支持（芯片自己能做自动信道选择），Framework 不参与选择——把决策权交给驱动和 hostapd。这就像请了专业选址顾问（芯片 ACS），老板就不需要自己跑市场了。

## 5.2 chooseApChannel 的优先级链

```java
// ApConfigUtil.java:543-613
public static int chooseApChannel(int apBand, CoexManager coexManager, ...) {
    // 优先级：60GHz > 6GHz > 5GHz > 2.4GHz
    final int[] bandPreferences = {BAND_60GHZ, BAND_6GHZ, BAND_5GHZ, BAND_2GHZ};

    for (int band : bandPreferences) {
        if ((apBand & band) == 0) continue;            // 用户没选这个频段，跳过
        int[] availableChannels = capability.getSupportedChannelList(band);
        // 分离安全信道和不安全信道
        List<Integer> safeFreqs = ...;
        List<Integer> unsafeFreqs = ...;
        if (!safeFreqs.isEmpty()) {
            return safeFreqs.get(random.nextInt(safeFreqs.size()));  // 随机选一个安全的
        }
        // 记录 unsafe 作为备选
    }
    // 所有信道都不安全？
    if (!isHardUnsafe) return selectedUnsafeFreq;  // 软限制可以接受
    return DEFAULT_CHANNEL_FREQ;                   // 硬限制只能用默认
}
```

优先级链：60GHz > 6GHz > 5GHz > 2.4GHz。高频优先，因为干扰少、速率高。对每个频段，优先选择不在 `CoexManager` 不安全列表中的信道（"安全信道"）。如果该频段全是不安全信道，记录一个备选，继续尝试下一个频段。如果所有频段都是硬限制（硬件共存冲突导致），回退到默认信道。

这里有一个有趣的工程取舍：**6GHz 排在 5GHz 前面，但如果芯片不支持 6GHz，`getSupportedChannelList(BAND_6GHZ)` 返回空，自然跳过，不会报错**。这是一种优雅降级——用能力查询的结果驱动决策，而不是一堆 `if-else`。

另一个设计选择是 `random.nextInt(safeFreqs.size())`——从安全信道中随机选一个，而不是选信号最好的或编号最小的。随机化的目的是避免多台设备在同一信道上碰撞：如果所有手机热点都固定选信道 6（2.4GHz 默认），反而会造成同频干扰。随机化将负载分散到所有可用信道上，类似于 DHCP 地址池的随机分配策略。代价是首次连接的 STA 需要扫描更多信道才能找到热点，但这个开销在热点场景下可以接受——STA 通常会做全信道扫描。

## 5.3 频段限制的条件

| 频段   | 前提条件                 | 为什么                                                       |
| ------ | ------------------------ | ------------------------------------------------------------ |
| 2.4GHz | 无特殊要求               | 全球开放，但信道少（只有 1-11/13/14），干扰大                |
| 5GHz   | 必须有国家码             | 各国对 5GHz 信道的管制不同（DFS 信道需要雷达检测）           |
| 6GHz   | 国家码 + AFC（部分信道） | AFC（Automated Frequency Coordination）需要向 AFC 服务器查询可用信道和功率限制；标准功率 AP 需要 AFC，低功率室内 AP 不需要 |
| 60GHz  | 芯片支持                 | 802.11ad/ay，传播距离极短，基本无共存问题                    |

## 5.4 CoexManager：不安全的信道不能用

`CoexManager`（共存管理器）管理 WiFi 与蜂窝网络（LTE/5G）之间的射频共存。它不只是简单地"列出不安全信道"——内部维护了一套基于物理干扰模型的计算引擎，针对每个活跃的蜂窝信道，逐一计算三类射频干扰：

1. **邻信道干扰（Neighboring）**：蜂窝下行/上行频率与 WiFi 信道频率在频域上过于接近，接收机滤波器无法完全分离。由 `neighborThresholds.cellVictimMhz`（蜂窝信号干扰 WiFi 的阈值）和 `wifiVictimMhz`（WiFi 信号干扰蜂窝的阈值）控制安全距离——超过这个距离的信道不标记。
2. **谐波干扰（Harmonic）**：蜂窝上行发射机的 n 次谐波（2 次、3 次……）恰好落在 WiFi 频段内。`CoexManager` 分别用 `harmonicParams2g` 和 `harmonicParams5g` 计算 2.4GHz 和 5GHz 频段的谐波受害信道——参数 `n` 是谐波阶数，`overlap` 是频域重叠容限。
3. **互调干扰（Intermodulation）**：两个不同蜂窝信道的信号在非线性器件中混合，产生的互调产物落在 WiFi 频段。`intermodParams2g/5g` 中的 `n` 和 `m` 分别是两个信号的阶数——三阶互调（2f1-f2）是最常见的干扰源。

每个 `CoexUnsafeChannel` 还携带 `powerCapDbm`——表示该信道上的 WiFi 最大发射功率限制。如果配置表中定义了功率上限，WiFi 在该信道上必须降功率运行，而非完全禁止。

```java
// CoexManager.updateCoexUnsafeChannels() 核心逻辑
for (CoexCellChannel cellChannel : cellChannels) {
    Entry entry = mLteTableEntriesByBand.get(cellChannel.getBand());  // 查 LTE 表
    // 或 mNrTableEntriesByBand.get(...) 查 5G NR 表
    if (entry.getParams() != null) {
        // 1. 邻信道：getNeighboringCoexUnsafeChannels(downlink/uplink freq, threshold)
        // 2. 谐波：get2gHarmonicCoexUnsafeChannels(uplink, n, overlap)
        //         get5gHarmonicCoexUnsafeChannels(uplink, n, overlap)
        // 3. 互调：getIntermodCoexUnsafeChannels(uplink, victim downlink, n, m, overlap, band)
    } else if (entry.getOverride() != null) {
        // Override 模式：直接指定不安全信道列表（按 20/40/80/160MHz 带宽分类）
    }
}
```

`CoexManager` 维护以下限制级别：

- **一般限制**：建议避免某些信道，但如果所有信道都不安全，仍然可以在其中选择一个。这对应 `chooseApChannel()` 中 `isHardUnsafe = false` 的分支——从最高优先级的频段中随机选一个不安全但可接受的信道。
- **SAP 硬限制**（`COEX_RESTRICTION_SOFTAP`）：共存限制位图设置此标志后，SAP 模式下存在硬性信道限制。此时如果某个信道标记为不安全，绝对禁止使用——`chooseApChannel()` 会跳过不安全信道，如果连默认信道也在不安全列表中，会记录错误日志但仍返回默认频率作为兜底。

当蜂窝网络的频段发生变化（比如从 LTE Band 7 切换到 Band 3），`CoexManager` 通知所有已注册的 `CoexListener`（包括 `SoftApManager`），触发 `CMD_SAFE_CHANNEL_FREQUENCY_CHANGED`，让 `SoftApManager` 重新评估是否需要切换信道。

回看整个选铺位流程，频段和信道的选择要过三道关卡。

第一道是国家码——相当于土地使用证，没有它，5GHz/6GHz 的频段根本不在合法范围内。第二道是芯片能力——相当于建筑限高审批，6GHz 频段再好，芯片不支持也白搭，`getSupportedChannelList()` 返回空直接跳过。第三道是 `CoexManager` 的共存过滤——相当于环保评估，蜂窝信号的邻信道干扰、谐波、互调三类射频污染逐一排查，不达标的信道要么降功率要么禁用。

三道关卡全通过，`chooseApChannel()` 才从安全信道中随机挑一个——这个随机化本身就是避免"所有民宿都挤在同一条街上"的负载均衡策略。

# 6 SoftApManager 状态机：民宿的全生命周期

`SoftApManager` 使用 Android 经典的 `StateMachine` 框架管理状态。构造函数完成 20+ 个字段的注入后，最后一行发送 `CMD_START` 启动状态机——"创建即启动"的单阶段模式，避免了两阶段模式在构造和启动之间引入的半初始化窗口。这不是 SAP 的特例——STA 侧的 `ConcreteClientModeManager` 做完全相同的事（`ConcreteClientModeManager.java:173-182`），所有 `ModeManager`（STA、SAP、P2P、NAN）都必须在构造函数内完成状态机启动，由 `ActiveModeWarden` 统一触发。违反这个约定会在消息队列中引入竞态：`ModeManager` 已注册但未启动的消息可能在 `WifiController` 状态机转换期间丢失。

```java
// SoftApManager.java:528
mStateMachine.sendMessage(SoftApStateMachine.CMD_START, requestorWs);
```

## 6.1 五状态层级

![SoftApManager 状态机](assets/10a-SAP%EF%BC%88%E4%B8%80%EF%BC%89%E5%BC%80%E6%B0%91%E5%AE%BF%EF%BC%9A%E4%BB%8E%E7%82%B9%E5%87%BB%E5%88%B0-Beacon/10a-state-machine.svg)

```
            ┌──────────────────────────────────┐
            │         ActiveState              │  (父状态，处理全局消息:
            │  - CMD_INTERFACE_DOWN            │   接口 down/频道变化/
            │  - CMD_SAFE_CHANNEL_FREQUENCY    │   关联断开等)
            │  - CMD_DISASSOCIATE              │
            └────────────┬─────────────────────┘
        ┌────────────────┼────────────────────────────┐
        │                │                │            │
   ┌────┴─────┐  ┌───────┴──────┐  ┌──────┴──────┐ ┌──┴──────────┐
   │  Idle    │  │WaitingFor   │  │WaitingFor   │ │  Started    │
   │  State   │  │DriverCountry│  │IcmDialog    │ │   State     │
   │          │  │CodeChanged  │  │   State     │ │             │
   └────┬─────┘  └──────┬──────┘  └──────┬──────┘ └──────┬──────┘
        │               │               │               │
   CMD_START       国家码驱动         ICM 对话框      热点运行中
   初始化接口       更新完成         用户确认
```

**IdleState**：民宿还在装修阶段——初始状态。`enterImpl()` 清空接口名称（`mApInterfaceName = null`），将接口状态标记为 down。接收到 `CMD_START`（老板递交开业申请）后，执行一系列前置检查和配置调整（详见 §6.2），最终调用 `setupInterfaceForSoftApMode()` 搭建接口基础设施。`exitImpl()` 为空——离开 IdleState 时不需要清理。

**WaitingForDriverCountryCodeChangedState**：门牌号还在等物业确认——接口创建完成后，如果国家码还未被驱动确认，进入此状态等待。`enterImpl()` 注册国家码变更监听器（`WifiCountryCode.ChangeListener`）并启动 5 秒超时定时器——超时后仍会调用 `startSoftAp()` 继续启动流程，不会直接失败。`exitImpl()` 注销监听器并移除超时消息。收到驱动上报的国家码后，更新 `SoftApCapability` 中的信道列表，检查桥接模式是否仍然可用（如果不可用则回退到单 AP），然后调用 `startSoftAp()` 迁移到 `StartedState`。这里有一个容易被忽略的重量级分支：国家码更新可能导致桥接模式下的可用频段发生变化。当 `mCurrentSoftApConfiguration.getBands().length != oldBands.length` 时，状态机会 `teardownInterface()` 拆除现有接口，然后重新调用 `setupInterfaceForSoftApMode()`——相当于拆了重建，确保接口能力与新国家码一致（`SoftApManager.java:1520-1540`）。在等待期间，其他消息（如 `CMD_STOP`）被 defer，状态机离开此状态后再处理。

**WaitingForIcmDialogState**：跟邻居协商噪音问题——由 `InterfaceConflictManager` 的通用 `WaitingState` 实现，而非 `SoftApManager` 自定义的状态类。当创建 AP 接口与已有接口（如 STA）冲突时，`manageInterfaceConflictForStateMachine()` 决定是弹对话框、跳过还是中止。tethering 模式（`IFACE_IP_MODE_TETHERED`）下自动绕过对话框（`bypassDialog = true`），因为热点 tethering 是系统行为，不需要用户确认。用户拒绝则返回 `START_RESULT_FAILURE_INTERFACE_CONFLICT_USER_REJECTED`。

**StartedState**：正式开门迎客——热点已成功启动。`enterImpl()` 中同步一次接口 up/down 状态（`onUpChanged`）、注册 `CoexListener` 监听蜂窝共存变化、注册电池充电状态广播接收器（用于桥接模式空闲实例关机定时器）、设置 SAR 状态为 `WIFI_AP_STATE_ENABLED`、清空已连接客户端列表和待断开列表、记录启动成功指标。

`exitImpl()` 中调用 `stopSoftAp()` 停止 hostapd、注销 `CoexListener` 和电池广播接收器、重置 SAR 状态为 `DISABLED`、清空所有客户端映射和超时定时器、通知状态变为 `WIFI_AP_STATE_DISABLED`。这是正常运行状态，处理客户端连接/断开、`SoftApInfo` 更新、空闲超时关机等运行时事件。

空闲超时关机的具体机制：`rescheduleTimeoutMessages()`（`SoftApManager.java:1607`）在每次客户端变化时被调用——有客户端连接时取消定时器，全部断开后重新调度。超时值由 `getShutdownTimeoutMillis()`（`SoftApManager.java:589`）取用户配置值或系统默认值（`config_wifiFrameworkSoftApShutDownTimeoutMilliseconds`），用户可通过 `SoftApConfiguration.isAutoShutdownEnabled()` 关闭此机制。定时器到期触发 `CMD_NO_ASSOCIATED_STATIONS_TIMEOUT`（`SoftApManager.java:1069`），先弹出关闭通知（`showSoftApShutdownTimeoutExpiredNotification()`——一个真实的 Android 通知栏消息，标题为"热点已关闭"，内容为"未连接到任何设备。点按即可修改。"），再 `quitNow()` 优雅退出。

这个"先通知再退出"的设计背后是 tethering 与普通热点的语义差异：tethering 是系统级服务（`IFACE_IP_MODE_TETHERED`），用户预期它持续运行；如果热点静默停止，用户会认为系统崩溃。通知提供了"审计痕迹"——让用户知道热点是正常关闭而非异常退出。对比 STA 侧的 WiFi 断连：WiFi 断开后会自动重连，用户无感，所以不需要通知；热点停止后不会自动重启，用户必须手动重新开启，通知因此不可或缺。相当于民宿老板打烊时在门口贴了告示"今日营业结束"——不是多此一举，而是让晚来的客人知道发生了什么。

正常退出是 `exitImpl()` 主动调用 `stopSoftAp()` 停止 hostapd，但如果 hostapd 进程自行崩溃（被 kill、段错误），走的是另一条路径：`HostapdHalAidlImp` 内部的 `HostapdDeathRecipient`（Binder 死亡通知）检测到 hostapd 进程死亡，调用 `hostapdServiceDiedHandler()` 清理内部状态（置空 `mIHostapd` 引用、触发 `mDeathEventHandler.onDeath()`）。同时，hostapd 崩溃后，内核销毁其创建的 AP 接口，Framework 侧的 `NetworkObserverInternal` 捕获接口销毁事件，通过 `InterfaceCallback.onDestroyed()` 发送 `CMD_INTERFACE_DESTROYED`。`SoftApManager` 在 `ActiveState` 收到此消息后，将 `mIfaceIsDestroyed` 标记为 true、更新状态为 `WIFI_AP_STATE_DISABLING`、写入停止事件（`STOP_EVENT_INTERFACE_DESTROYED`），然后 `quitNow()` 触发 `ActiveState.exitImpl()` 通知 `ActiveModeWarden`。这条"被动发现崩溃→清理→通知"的路径与正常 `stopSoftAp()` 的关键区别是：正常路径是 Framework 主动停止 hostapd（`HostapdHal.removeAccessPoint()` 或进程 kill），异常路径是 hostapd 已死，Framework 只能被动善后——清理已失效的接口引用、通知上层模块热点已停止。

**ActiveState**：行业协会监督下的营业状态——所有子状态的父状态。`exitImpl()` 中调用 `mModeListener.onStopped()` 通知 `ActiveModeWarden` 并注销 CMI 监听器。处理跨状态通用的消息，如接口 down（`CMD_INTERFACE_DOWN`）、安全信道变化（`CMD_SAFE_CHANNEL_FREQUENCY_CHANGED`）、客户端反关联（`CMD_DISASSOCIATE`）、接口销毁（`CMD_INTERFACE_DESTROYED`）。

## 6.2 IdleState 中的 CMD_START 处理

```java
// SoftApManager.java IdleState.processMessageImpl
case CMD_START:
    mRequestorWs = (WorkSource) message.obj;

    // ① SSID 校验：没有有效 SSID 直接失败
    if (wifiSsid == null || wifiSsid.getBytes().length == 0) {
        handleStartSoftApFailure(START_RESULT_FAILURE_GENERAL);
        break;
    }

    // ② 国家码预检：如果框架层没有国家码且驱动支持 reg changed 事件，
    //    标记为"等待驱动上报国家码"
    if (TextUtils.isEmpty(mCountryCode) && driverSupportedNl80211RegChangedEvent) {
        shouldwaitForDriverCountryCodeIfNoCountryToSet = true;
    }

    // ③ 桥接模式处理：检查桥接是否可用，不可用则回退到单 AP
    if (isBridgedMode()) {
        if (!isBridgedApAvailable() || bands.length == 1) {
            // 回退：合并所有频段为单 AP 配置（内联构建）
            int newSingleApBand = 0;
            for (int band : bands) newSingleApBand |= band;
            newSingleApBand = ApConfigUtil.append24GToBandIf24GSupported(
                    newSingleApBand, mContext);
            mCurrentSoftApConfiguration = new SoftApConfiguration.Builder()
                    .setBand(newSingleApBand).build();
        }
    } else if (tethered && isBridgedApAvailable()) {
        // 尝试升级到 2+5GHz 桥接（芯片支持时）
        mCurrentSoftApConfiguration =
                ApConfigUtil.upgradeTo2g5gBridgedIfAvailableBandsAreSubset(
                        mCurrentSoftApConfiguration,
                        mCurrentSoftApCapability, mContext);
    }

    // ④ 移除不支持安全类型的 6GHz 频段
    mCurrentSoftApConfiguration = remove6gBandForUnsupportedSecurity(...);

    // ⑤ ICM 冲突检测（tethering 模式自动绕过对话框）
    int icmResult = mInterfaceConflictManager.manageInterfaceConflictForStateMachine(
            ..., bypassDialog = (targetMode == IFACE_IP_MODE_TETHERED));
    if (icmResult == ICM_ABORT_COMMAND) {
        handleStartSoftApFailure(START_RESULT_FAILURE_INTERFACE_CONFLICT_USER_REJECTED);
        break;
    } else if (icmResult == ICM_SKIP_COMMAND_WAIT_FOR_USER) {
        break;  // 等待用户在 WaitingForIcmDialogState 中确认
    }

    // ⑥ 搭建接口基础设施（第 7 节详解）
    mApInterfaceName = mWifiNative.setupInterfaceForSoftApMode(...);
    if (TextUtils.isEmpty(mApInterfaceName)) {
        // 区分"接口冲突"和"创建失败"
        if (!isItPossibleToCreateApIface(mRequestorWs)) {
            handleStartSoftApFailure(START_RESULT_FAILURE_INTERFACE_CONFLICT);
        } else {
            handleStartSoftApFailure(START_RESULT_FAILURE_CREATE_INTERFACE);
        }
        break;
    }

    // ⑦ 11be 能力验证（如果芯片不支持，从配置中移除 11be）
    if (!isUsingMlo && config.isIeee80211beEnabled()) {
        if (!is11beAllowedForThisConfiguration(...)) {
            mCurrentSoftApConfiguration.setIeee80211beEnabled(false);
        }
    }

    // ⑧ 国家码设置与状态迁移
    if (!shouldwaitForDriverCountryCodeIfNoCountryToSet && !setCountryCode()) {
        handleStartSoftApFailure(START_RESULT_FAILURE_SET_COUNTRY_CODE);
        break;
    }
    if (isCountryCodeChanged || shouldwaitForDriverCountryCodeIfNoCountryToSet) {
        transitionTo(mWaitingForDriverCountryCodeChangedState);
        break;
    }

    // ⑨ 一切就绪，启动热点
    int startResult = startSoftAp();
    if (startResult != START_RESULT_SUCCESS) {
        handleStartSoftApFailure(startResult);
        break;
    }
    transitionTo(mStartedState);
    break;
```

CMD_START 的处理远比"创建接口然后启动"复杂——它在同一个状态处理函数中完成了 SSID 校验、桥接模式回退/升级、6GHz 安全限制过滤、ICM 冲突检测、接口创建、11be 能力验证、国家码设置共 9 个阶段。

这 9 个阶段里，桥接模式回退（③）是最容易被忽略的分支：如果芯片不支持桥接、或者当前 STA 连接的频段不在安全信道列表中、或者国家码是 world mode，桥接模式会静默回退到单 AP——用户看到的是热点正常启动，但少了 5GHz 频段。

任何阶段失败，都汇聚到 `handleStartSoftApFailure()`（`SoftApManager.java:945-968`）这个统一出口。它内部先将 `START_RESULT` 映射为 `WifiManager` 的 `SAP_START_FAILURE_*` 常量（`NO_CHANNEL` → `SAP_START_FAILURE_NO_CHANNEL`，`UNSUPPORTED_CONFIG` → `SAP_START_FAILURE_UNSUPPORTED_CONFIGURATION`，`USER_REJECTED` → `SAP_START_FAILURE_USER_REJECTED`，其余 → `SAP_START_FAILURE_GENERAL`），然后 `updateApState(WIFI_AP_STATE_FAILED)` 通知上层、`stopSoftAp()` 清理资源、`mModeListener.onStartFailure()` 通知 `ActiveModeWarden` 回收 `ModeManager`、最后写入指标。这个映射关系决定了 Settings UI 向用户展示什么错误提示——不同的 `SAP_START_FAILURE_*` 对应不同的弹窗文案。

# 7 六步搭好基础设施：setupInterfaceForSoftApMode 详解

这是本章最核心的部分。`WifiNative.setupInterfaceForSoftApMode()` 是 SAP 基础设施搭建的入口，6 个步骤缺一不可。

![setupInterfaceForSoftApMode 六步时序图](assets/10a-SAP%EF%BC%88%E4%B8%80%EF%BC%89%E5%BC%80%E6%B0%91%E5%AE%BF%EF%BC%9A%E4%BB%8E%E7%82%B9%E5%87%BB%E5%88%B0-Beacon/10a-sequence.svg)

## 7.1 六步总览

```
WifiNative.setupInterfaceForSoftApMode()
  │
  ├── Step 1: startHal()                  ← 拉起 HAL 进程
  ├── Step 2: startHostapd()              ← 拉起 hostapd 守护进程
  ├── Step 3: mIfaceMgr.allocateIface()   ← 分配接口数据结构
  ├── Step 4: createApIface()             ← HAL 层创建 AP 接口
  ├── Step 5: mWifiCondManager.setup...   ← wificond 配置接口
  └── Step 6: registerNetworkObserver()   ← 注册网络状态监听
```

这六步就像民宿装修施工的全流程：通水电（startHal）、请施工队进场（startHostapd）、办门牌号（allocateIface）、拿到建筑许可证（createApIface 的资质审查）、室内硬装（wificond 配置接口）、最后装上监控摄像头（registerNetworkObserver）。任何一步出问题，后面的都不用做了。

顺序是硬约束，不是随便排的。如果 `startHal()` 不是第一步，后面的 `createApIface()` 会因为 HAL 服务不存在而直接返回 null——但此时 hostapd 已经在 Step 2 被拉起了，白白占用系统资源。更糟的是，hostapd 启动时会尝试连接 HAL 服务，连接失败后进入重试循环，日志里刷满错误信息，排查问题时会被这些噪音淹没。把 `startHal()` 放在最前面，确保 HAL 服务就绪后才启动 hostapd，避免了这种"半成品堆积"的问题。归结为一条原则：先启动被依赖方（HAL），再启动依赖方（hostapd）——这是系统服务启动顺序的通用规则，违反它的代价是资源浪费和日志污染。

六步之间的依赖关系构成一个 DAG（有向无环图）：`startHal()` 是所有后续步骤的根节点（没有 HAL，hostapd 无法连接、createApIface 无法执行）；`allocateIface()` 必须在 `createApIface()` 之前（HAL 创建接口需要一个 Iface 数据结构来填充）；`createApIface()` 必须在 wificond 配置之前（wificond 需要知道接口名称 `wlan1` 才能注册 AP 模式）；`registerNetworkObserver()` 必须在接口创建之后（它监听的接口必须已存在）。一个有趣的设计选择是 `startHostapd()` 的位置——它被放在 Step 2 而非更晚。从依赖关系看，hostapd 直到 §8.2 的 `addAccessPoint()` 才真正被使用，理论上可以推迟到 Step 6 之后。但放在 Step 2 的理由是"fail-fast"原则：hostapd 二进制缺失或 AIDL 服务未注册是最常见的配置错误之一。如果放到最后才发现，前面五步的 HAL 接口创建、wificond 配置全部白做——这些操作涉及芯片模式切换和接口分配，回滚代价远高于提前启动一个守护进程的内存开销（hostapd 空闲时约占 3-5MB）。

## 7.2 逐步展开

**Step 1：startHal()** —— 确保 WiFi HAL 进程已启动。

```java
// WifiNative.java:1623
if (!startHal()) {
    errorMsg = "Failed to start softAp Hal";
    mWifiMetrics.incrementNumSetupSoftApInterfaceFailureDueToHal();
    softApManager.writeSoftApStartedEvent(START_RESULT_FAILURE_START_HAL);
    return null;
}
```

- `startHal()` 内部检查 HAL 是否已注册为服务（AIDL/HIDL），如果没有则启动 `wifi@1.0-service` 或对应的 AIDL 服务。
- 如果 STA 模式已经在运行（WiFi 已开启），HAL 通常已经启动了，这一步直接返回 true。
- 失败意味着 HAL 服务不可用——可能是驱动没加载、vendor 分区损坏、或者 SELinux 策略阻止了 HAL 进程启动。

**Step 2：startHostapd()** —— 拉起 hostapd 守护进程。

```java
// WifiNative.java:1631
if (!startHostapd()) {
    errorMsg = "Failed to start softAp hostapd";
    mWifiMetrics.incrementNumSetupSoftApInterfaceFailureDueToHostapd();
    softApManager.writeSoftApStartedEvent(START_RESULT_FAILURE_START_HOSTAPD);
    return null;
}
```

- hostapd 是独立进程，通过 AIDL/HIDL 与 Framework 通信。`HostapdHal` 构造函数中的选择逻辑（`HostapdHal.java:108-114`）：先检查 `HostapdHalAidlImp.serviceDeclared()`，命中则用 AIDL 实现；否则检查 `HostapdHalHidlImp.serviceDeclared()`，命中则用 HIDL 实现。两者都未命中则 `mIHostapd` 为 null，后续所有操作直接失败。
- 失败原因通常是 hostapd 二进制不存在（ROM 裁剪掉了）或 AIDL/HIDL 服务均未注册。

**Step 3：allocateIface(Iface.IFACE_TYPE_AP)** —— 在 Framework 内部分配接口管理数据结构。

```java
// WifiNative.java:1640
Iface iface = mIfaceMgr.allocateIface(Iface.IFACE_TYPE_AP);
if (iface == null) {
    Log.e(TAG, "Failed to allocate new AP iface");
    return null;
}
iface.externalListener = interfaceCallback;
```

- 这不是硬件操作，只是在 Framework 内部的接口管理器中注册一个新接口槽位。
- `Iface` 对象包含 `id`、`name`、`type`、`featureSet`、`networkObserver` 等字段。
- 失败意味着接口管理器已满或存在同类型接口冲突——这在正常情况下几乎不可能发生。

**Step 4：createApIface()** —— 这是第 4 节详细讲过的"资质审查"。通过 HAL 创建真正的 AP 网络接口（如 `wlan1`）。

```java
// WifiNative.java:1646
iface.name = createApIface(iface, requestorWs, band, isBridged,
        softApManager, vendorData);
if (TextUtils.isEmpty(iface.name)) {
    mWifiMetrics.incrementNumSetupSoftApInterfaceFailureDueToHal();
    return null;  // 触发失败路径，记录 START_RESULT_FAILURE_CREATE_INTERFACE
}
```

- 调用链：`createApIface()` → `HalDeviceManager.createApIface()` → `createIface(HDM_CREATE_IFACE_AP, ...)` → `configureChip(modeId)` → `chip.createApIface(vendorData)`。
- 返回值是接口名称字符串（如 `"wlan1"`），为空表示创建失败。

接口创建之后，驱动侧还要为这个 `wlan1` 准备承载 Beacon 的 SAP 会话，QCOM 和 MTK 在此分叉：QCOM 在 `hdd_init_ap_mode()`（`wlan_hdd_hostapd.c:4137`）里调用 `hdd_hostapd_init_sap_session()`（`wlan_hdd_hostapd.c:282`），用 `sap_init_ctx()` 初始化一份专属 `sap_context`；MTK conninfra 则复用 P2P 角色，`mtk_init_ap_role()`（`gl_cfg80211.c:6081`）只占一个 `gprP2pRoleWdev[]` 槽位。一个是"开专属 SAP 会话"，一个是"借用 P2P 的壳"。

**Step 5：wificond setupInterfaceForSoftApMode()** —— 在 wificond 守护进程中为这个接口注册 AP 模式。

```java
// WifiNative.java:1671
if (!mWifiCondManager.setupInterfaceForSoftApMode(ifaceInstanceName)) {
    teardownInterface(iface.name);  // 失败则拆除已创建的资源
    return null;
}
```

wificond 内部的实现：

```java
// WifiNl80211Manager.java:813-838
public boolean setupInterfaceForSoftApMode(@NonNull String ifaceName) {
    if (!retrieveWificondAndRegisterForDeath()) {
        return false;
    }
    IApInterface apInterface = mWificond.createApInterface(ifaceName);
    if (apInterface == null) {
        return false;
    }
    Binder.allowBlocking(apInterface.asBinder());
    mApInterfaces.put(ifaceName, apInterface);
    return true;
}
```

- `mWificond.createApInterface(ifaceName)` 是跨进程 Binder 调用，wificond 守护进程收到后创建 `IApInterface` 对象。
- 这个 `IApInterface` 后续用于接收客户端连接/断开事件（`onConnectedClientsChanged`）、信道切换事件（`onSoftApChannelSwitched`）。
- 失败原因通常是 wificond 守护进程死亡、nl80211 socket 无法打开、或者接口名称在内核中不存在。

**Step 6：registerNetworkObserver()** —— 注册网络状态观察者，监听接口的 link up/down 事件。

```java
// WifiNative.java:1679
iface.networkObserver = new NetworkObserverInternal(iface.id);
if (!registerNetworkObserver(iface.networkObserver)) {
    teardownInterface(iface.name);
    return null;
}
```

- `NetworkObserverInternal` 监听网络接口的状态变化（通过 netlink socket），当接口 up/down 时通知 `InterfaceCallback`。
- 最后，`onInterfaceStateChanged()` 同步一次当前接口状态，避免错过在注册期间发生的状态变化（竞态窗口）。

六步的失败处理策略并不一致，按清理力度分成三档。Step 1（`startHal()`）和 Step 2（`startHostapd()`）失败时直接返回 null，不做任何清理——HAL 和 hostapd 是系统级共享服务，由 init 进程管理生命周期，Framework 不需要也无权停止它们。

中间两步只清 Framework 内部状态。Step 3（`allocateIface()`）和 Step 4（`createApIface()`）失败时只调用 `mIfaceMgr.removeIface()` 清理 Framework 内部的数据结构——Step 3 时硬件资源尚未占用，Step 4 时 HAL 接口尚未创建（`createApIface()` 返回 null 意味着 HAL 层没有分配接口）。

从 Step 5 开始才需要拆 HAL。失败时调用 `teardownInterface()` 拆除已创建的 HAL 接口——因为此时 `createApIface()` 已经成功，HAL 层已经分配了真实的网络接口（如 `wlan1`），必须通过 `teardownInterface()` 彻底释放。桥接模式下 `getBridgedApInstances()` 失败同样调用 `teardownInterface()` 回滚。

这种"前半段只清 Framework、后半段才拆 HAL"的设计有一个微妙的系统后果：如果 Step 4 成功但 Step 5（wificond 配置）失败，`teardownInterface()` 会拆除 HAL 接口，但 hostapd 进程已经在 Step 2 被拉起且仍在运行。hostapd 此时没有 AP 接口可管理，处于"空转"状态——它不会主动退出，因为 hostapd 设计上支持接口的动态添加和移除。下次再创建 AP 接口时需要重新走 `addAccessPoint()` 流程，hostapd 的内部状态不一定干净（可能残留上次的配置参数）。这个"半成品"状态是 hostapd 作为长生命周期守护进程的代价——它被设计为始终存活，由 Framework 负责接口的生命周期管理。

更深层的系统级联关系隐藏在 Step 4 的 `createApIface()` 内部：`HalDeviceManager` 选定的 ChipMode 决定了 hostapd 最终能看到什么。ChipMode 通过 HAL 的 `IWifiChip.configureChip(modeId)` 配置芯片工作模式后，芯片上报给 hostapd 的接口能力（支持的频段、最大带宽、可用信道列表）完全由这个 modeId 决定——如果选定的 ChipMode 不支持 5GHz AP，hostapd 无论怎么配置都无法在 5GHz 上启动 BSS。Framework 侧的 `SoftApCapability` 已经通过 `getAvailableChannelFreqsForBand()` 查询过 HAL 并缓存了可用信道，所以 `updateApChannelConfig()` 在 Step 4 之前就会排除不支持的频段。但如果 ChipMode 在 `configureChip()` 之后才暴露出额外限制（某些 vendor 实现中 ChipMode 的能力边界不完全可预测），hostapd 的 `addAccessPoint()` 可能会因为参数不合法而失败——这就是 `START_RESULT_FAILURE_ADD_AP_HOSTAPD`（错误码 14）的一个隐含触发路径。

六步全部通过后，`iface.name` 返回给 `SoftApManager`，基础设施搭建完成。

# 8 通电挂牌：最后的 AIDL 调用 startSoftAp()

到这里，本章前面所有代码都在 Java/Framework 层——从 `WifiManager` 的 Binder 代理，到 `ActiveModeWarden` 的状态机，到 `HalDeviceManager` 的芯片能力检查，到 `setupInterfaceForSoftApMode` 的六步基础设施搭建。接下来的 `startSoftAp()` 是最后一个 Java 方法，它的核心工作通过 AIDL 跨入 hostapd 的 C 代码世界——也是本章的终点。

接口就绪后，`SoftApManager` 调用 `startSoftAp()`。

## 8.1 startSoftAp() 内部逻辑

硬装完成、执照到手，接下来是通电挂牌的最后四步：挂上门牌号（设 MAC 地址）、确认经营时段（频段信道配置）、最后的合规检查（校验配置是否满足芯片能力）、然后按下开关（AIDL 调用 hostapd）。

```java
// SoftApManager.java:884
private @StartResult int startSoftAp() {
    updateApState(WIFI_AP_STATE_ENABLING, WIFI_AP_STATE_DISABLED, 0);

    // 1. 设置 MAC 地址
    int startResult = setMacAddress();

    // 2. 频段和信道配置（第 5 节详细分析过）
    startResult = ApConfigUtil.updateApChannelConfig(mWifiNative, mCoexManager,
            mResourceCache, mCountryCode, localConfigBuilder,
            mCurrentSoftApConfiguration, mCurrentSoftApCapability);

    // 3. 检查配置是否被芯片能力支持
    if (!ApConfigUtil.checkSupportAllConfiguration(
            mCurrentSoftApConfiguration, mCurrentSoftApCapability)) {
        return START_RESULT_FAILURE_UNSUPPORTED_CONFIG;
    }

    // 4. 调用 WifiNative.startSoftAp() —— 本章的终点
    startResult = mWifiNative.startSoftAp(mApInterfaceName,
            localConfigBuilder.build(),
            mSpecifiedModeConfiguration.getTargetMode() == IFACE_IP_MODE_TETHERED,
            mSoftApHalCallback, mIsUsingMlo);

    mWifiDiagnostics.startLogging(mApInterfaceName);
    return START_RESULT_SUCCESS;
}
```

Step 1 的 `setMacAddress()`（`SoftApManager.java:811-837`）有三条分支：如果没有显式配置 BSSID（`config.getBssid() == null`），调用 `resetApMacToFactoryMacAddress()` 重置为出厂 MAC——失败仅记录警告继续运行，因为某些驱动不支持 MAC 设置，这是软失败；如果有显式 BSSID 且硬件支持（`isApSetMacAddressSupported()`），调用 `setApMacAddress()`——失败返回 `START_RESULT_FAILURE_SET_MAC_ADDRESS`，这是硬失败；如果硬件不支持 MAC 设置且不是随机化场景（`!mIsUnsetBssid`），返回 `START_RESULT_FAILURE_UNSUPPORTED_CONFIG`。MAC 地址设置在频段配置之前——因为某些驱动在接口创建时就绑定了 MAC，后续修改需要重建接口。

## 8.2 WifiNative.startSoftAp() —— AIDL 跨进程

```java
// WifiNative.java:2401
public @SoftApManager.StartResult int startSoftAp(
        @NonNull String ifaceName, SoftApConfiguration config,
        boolean isMetered, SoftApHalCallback callback, boolean isUsingMlo) {

    // ① 注册回调：让 hostapd 能向 Framework 上报事件
    if (mHostapdHal.isApInfoCallbackSupported()) {
        // AIDL 实现 → 直接在 hostapd 侧注册
        if (!mHostapdHal.registerApCallback(ifaceName, callback)) {
            return START_RESULT_FAILURE_REGISTER_AP_CALLBACK_HOSTAPD;
        }
    } else {
        // HIDL 实现 → 通过 wificond 间接注册
        if (!mWifiCondManager.registerApCallback(ifaceName, ...)) {
            return START_RESULT_FAILURE_REGISTER_AP_CALLBACK_WIFICOND;
        }
    }

    // ② addAccessPoint：通过 AIDL 调用 hostapd
    if (!mHostapdHal.addAccessPoint(ifaceName, config, isMetered,
            isUsingMlo, getBridgedApInstances(ifaceName), callback::onFailure)) {
        return START_RESULT_FAILURE_ADD_AP_HOSTAPD;
    }

    return START_RESULT_SUCCESS;
}
```

注意 `registerApCallback` 在 `addAccessPoint` 之前——先装监控，再开门。`registerApCallback` 给 hostapd 装上事件上报通道，让它能向 Framework 报告"信道选好了""接口状态变了"。如果顺序反过来，hostapd 的 BSS 初始化会立即产生事件，但 Framework 还没有接收端——事件落入空隙，状态机卡在等待中。

两条路径分叉在 `isApInfoCallbackSupported()`——这个方法在 AIDL 实现中始终返回 true，在 HIDL 实现中检查 HAL 版本是否 >= 1.3（`isV1_3()`）：

- **AIDL 路径**：HAL 回调直接注册在 hostapd 进程侧，Framework 通过 AIDL callback 接收事件。
- **HIDL 路径**：回调通过 wificond 中转。wificond 的 `SoftApCallback` 接口已标记 `@Deprecated`（被 hostapd V1_3 的 `IHostapdCallback` 取代），只有 HAL 版本 < 1.3 的旧设备才走这条路径。wificond 用 `IApInterfaceEventCallback` 监听 hostapd 事件，然后通过 `SoftApCallback` 回调 Framework。

`addAccessPoint()` 的 AIDL 实现：

```java
// HostapdHalAidlImp.java:238
public boolean addAccessPoint(@NonNull String ifaceName,
        @NonNull SoftApConfiguration config, boolean isMetered,
        boolean isUsingMultiLinkOperation, List<String> instanceIdentities,
        Runnable onFailureListener) {
    if (!checkHostapdAndLogFailure(methodStr)) return false;

    // 准备参数：IfaceParams 和 NetworkParams
    IfaceParams ifaceParams = prepareIfaceParams(ifaceName, config, ...);
    NetworkParams nwParams = prepareNetworkParams(isMetered, config);

    // 跨进程 AIDL 调用
    mIHostapd.addAccessPoint(ifaceParams, nwParams);

    mSoftApFailureListeners.put(ifaceName, onFailureListener);
    return true;
}
```

两个关键参数：

- `IfaceParams`：接口级配置，包括接口名、信道、频段、国家码、是否隐藏 SSID。
- `NetworkParams`：网络级配置，包括 SSID、安全类型、密码、是否计量网络。

HIDL 的 `addAccessPoint` 实现比 AIDL 复杂得多——它内部有 4 级版本回退（`HostapdHalHidlImp.java:440-510`）：先检查 `isV1_1()`，不支持则调用最基础的 V1_0 `addAccessPoint`；支持则继续检查 `isV1_2()`，逐级升级到 `addAccessPoint_1_1`、`addAccessPoint_1_2`、`addAccessPoint_1_3`。每一级在 `IfaceParams` 和 `NetworkParams` 上叠加新字段——V1_1 增加频段参数，V1_2 增加 ACS 配置，V1_3 增加 `isMetered` 和 MLO 参数。这种嵌套回退是 HIDL 接口演进的典型模式：新版本不能破坏旧版本的 ABI 兼容性，只能通过新增方法（`_1_1`、`_1_2` 后缀）扩展功能，调用者必须逐级探测。AIDL 没有这个问题——接口版本管理由 Binder 框架自动处理。

HIDL 的4级回退不是代码洁癖问题，而是 Android 设备碎片化的直接产物。HIDL 在设计时就锁定了 ABI——一旦发布就不能修改已有方法的签名，只能新增方法。这意味着 HIDL 1.0 的 `addAccessPoint` 在设计时根本没有 6GHz 和 MLO 的概念（这些标准在 HIDL 冻结后才成熟），参数中没有频段字段、没有 MLO 开关。V1_1 到 V1_3 的每一级都是在 ABI 冻结后的"打补丁"——用新方法名绕开旧签名的限制。代价是：停留在 HIDL 1.0 的设备无法使用 6GHz 热点和 MLO，因为 `addAccessPoint` 的 V1_0 版本根本没有传递这些参数的通道。AIDL 从设计上解决了这个问题——Binder 框架支持接口版本协商，新旧版本的客户端和服务端可以自动适配，不需要逐级探测。这也是 Android 从 HIDL 全面转向 AIDL 的核心驱动力之一：HAL 接口的演进速度（WiFi 7、MLO、6GHz AFC）已经超过了 HIDL 的 ABI 冻结模型所能承载的范围。

这套 4 级回退的另一个现实维度是厂商碎片化：Framework 侧先探测 AIDL、再退回 HIDL（§7.2 的选择逻辑），但决定设备最终走哪条路径的，是厂商分区随驱动出货的 hostapd 服务二进制。QCOM 的开源部分是驱动层的 qcacld-3.0（连同 qca-wifi-host-cmn、fw-api），MTK 是 conninfra 内核驱动（kernel_modules-connectivity-wlan-core-gen4m）——两者都经 nl80211 接 hostapd，本身并不决定 HAL 版本。同一颗 SoC 配不同 Android 基线，hostapd 服务可能是 HIDL 1.3 也可能是 AIDL，这正是 Framework 必须同时携带两条路径、且每条都要逐级探测的根本原因。

这一行 `mIHostapd.addAccessPoint(ifaceParams, nwParams)` 就是本章的终点。消息跨过 Binder 进入 hostapd 的世界——下一篇从这一行继续追踪，进入 hostapd 的 C 代码世界。

# 9 桥接模式：不止一个铺位

如果芯片支持且用户配置了桥接模式（Bridged AP），`createApIface` 走的是 `HDM_CREATE_IFACE_AP_BRIDGE` 路径，创建的不是一个而是多个 AP 接口。

在 `setupInterfaceForSoftApMode` 中，桥接模式有以下特殊处理：

```java
// WifiNative.java:1657-1669
if (isBridged && !isUsingMlo) {
    List<String> instances = getBridgedApInstances(iface.name);
    // 取第一个实例作为 wificond 接口
    ifaceInstanceName = instances.get(0);
    mWifiCondIfacesForBridgedAp.put(iface.name, ifaceInstanceName);
}
```

桥接模式的核心思想：一个逻辑 AP 桥接到多个物理频段的 AP 实例。例如，一个桥接的 SAP 在 2.4GHz 和 5GHz 上各有一个物理 AP 接口（`wlan1`、`wlan2`），但对外表现为同一个 SSID。STA 可以从 2.4GHz 接入，然后通过 802.11v BSS Transition 平滑迁移到 5GHz。

桥接模式在运行时有三个独特的自适应机制，是它与单 AP 模式的核心区别。

第一，机会性关闭空闲实例：当桥接 AP 的某个实例（如 5GHz）长时间无客户端连接时，`CMD_NO_ASSOCIATED_STATIONS_TIMEOUT_ON_ONE_INSTANCE`（`SoftApManager.java:2108`）触发 `removeIfaceInstanceFromBridgedApIface()`（`SoftApManager.java:1624`）关闭该实例，另一个实例继续服务——相当于民宿的二楼没人住就关掉省电，一楼继续营业。

这个机制有一个精心设计的约束：它只在电池供电时生效（`rescheduleTimeoutMessageIfNeeded` 中检查 `!mIsPlugged`，`SoftApManager.java:1650`），充电时即使实例空闲也不会关闭。背后的工程权衡是：充电时电力无限，保持双频覆盖的收益（客户端可以随时迁移到更快的频段）远大于省电的收益；电池供电时，关闭一个空闲实例可以释放整个 radio 的功耗（约 100-200mW），这对续航有实质影响。

另一个重要细节是一旦关闭就不会自动恢复——源码中没有 `addIfaceInstanceToBridgedApIface` 的调用路径。这是因为重新添加实例需要通过 `HalDeviceManager` 创建新的 AP 接口，可能触发 `configureChip()` 模式切换，而模式切换会先移除芯片上所有接口（§4.2），反而导致正在服务的另一个实例也被中断。两害相权取其轻：宁可少一个频段，也不能让正在连接的客户端全部掉线。

第二，STA 频段冲突处理：当用户同时使用 WiFi 上网和开热点时，`CMD_HANDLE_WIFI_CONNECTED`（`SoftApManager.java:2285`）检查 STA 连接的频段是否与桥接 AP 的某个实例冲突（同频段且不在安全信道列表中），冲突则关闭该实例。例如 STA 连接到 5GHz 信道 36，而桥接 AP 的 5GHz 实例也在信道 36 附近且被 CoexManager 标记为不安全，系统会关闭 5GHz 实例，只保留 2.4GHz。第三，安全信道动态响应：蜂窝共存限制变化时，`CMD_SAFE_CHANNEL_FREQUENCY_CHANGED`（`SoftApManager.java:2264`）检查当前实例是否仍在安全信道上，不在则关闭频率最高的不安全实例。

这三个机制的共同点是：桥接模式不像单 AP 那样"开就开、关就关"，它能在运行中动态降级——从双频变单频、从高频变低频——代价是用户看到热点少了 5GHz，但收益是热点不会因为共存冲突而完全停止。

桥接模式的详细实现（包括 hostapd 侧的 BSS 初始化和 802.11v BSS Transition）留给后续 hostapd 和 MLO 桥接章节展开。

# 10 开不成怎么办：15 种失败码

资质审查、选铺位、装修、挂牌——每一步都可能卡住。`SoftApManager` 定义了 15 种 `@StartResult` 常量，覆盖了从 HAL 启动到 AIDL 调用的每一个环节的失败场景。理解这些失败码，就理解了整个启动链路上的每一个薄弱点——相当于民宿从申请到开业的每一道审批关卡。

| 常量                                                    | 值   | 失败原因                                 |
| ------------------------------------------------------- | ---- | ---------------------------------------- |
| `START_RESULT_UNKNOWN`                                  | 0    | 未知状态（初始值，不应出现在正常流程中） |
| `START_RESULT_SUCCESS`                                  | 1    | 成功                                     |
| `START_RESULT_FAILURE_GENERAL`                          | 2    | 一般性失败（如配置不合法）               |
| `START_RESULT_FAILURE_NO_CHANNEL`                       | 3    | `chooseApChannel()` 找不到可用信道       |
| `START_RESULT_FAILURE_UNSUPPORTED_CONFIG`               | 4    | 配置不被芯片能力支持                     |
| `START_RESULT_FAILURE_START_HAL`                        | 5    | `startHal()` 失败                        |
| `START_RESULT_FAILURE_START_HOSTAPD`                    | 6    | `startHostapd()` 失败                    |
| `START_RESULT_FAILURE_INTERFACE_CONFLICT_USER_REJECTED` | 7    | ICM 弹框后用户拒绝                       |
| `START_RESULT_FAILURE_INTERFACE_CONFLICT`               | 8    | 接口冲突，无法创建新接口                 |
| `START_RESULT_FAILURE_CREATE_INTERFACE`                 | 9    | `createApIface()` HAL 调用失败           |
| `START_RESULT_FAILURE_SET_COUNTRY_CODE`                 | 10   | 设置国家码失败                           |
| `START_RESULT_FAILURE_SET_MAC_ADDRESS`                  | 11   | 设置 MAC 地址失败                        |
| `START_RESULT_FAILURE_REGISTER_AP_CALLBACK_HOSTAPD`     | 12   | 在 hostapd 注册回调失败                  |
| `START_RESULT_FAILURE_REGISTER_AP_CALLBACK_WIFICOND`    | 13   | 在 wificond 注册回调失败                 |
| `START_RESULT_FAILURE_ADD_AP_HOSTAPD`                   | 14   | `addAccessPoint()` AIDL 调用失败         |

最常见的前三种失败：

1. **NO_CHANNEL (3)**：用户指定的频段没有可用信道，或所有信道都被 CoexManager 硬限制。
2. **CREATE_INTERFACE (9)**：芯片不支持当前并发组合（STA 2.4GHz + AP 5GHz 但芯片无 DBS）。
3. **ADD_AP_HOSTAPD (14)**：hostapd AIDL 调用失败，通常是 hostapd 守护进程异常退出或参数不合法。

这些失败码会被写入指标（`SoftApStopped.StartResult`），用于系统健康度监控。

# 11 本章总结

这一章从用户点击"开启热点"追到 `HostapdHal.addAccessPoint()` 的 AIDL 边界。核心链路：

```
点按钮 → WifiServiceImpl.startSoftAp() → ActiveModeWarden.startSoftAp()
  → WifiController.CMD_SET_AP → startSoftApModeManager() → new SoftApManager()
    → setupInterfaceForSoftApMode() [6步]
      → startSoftAp() → WifiNative.startSoftAp()
        → registerApCallback() + addAccessPoint() ← AIDL 跨进程
```

民宿老板拿到了营业执照，装修队（hostapd）开始进场。但有个问题——`addAccessPoint()` 那一行 AIDL 调用之后，hostapd 里面到底发生了什么？ACS 怎么在 2.4G 和 5G 之间选出最优信道？BSS 怎么初始化？Beacon 帧怎么组装？nl80211 怎么下发 `NL80211_CMD_START_AP`？驱动和固件又怎么把 Beacon 信号发射出去？

下一章，我们跨过这行 AIDL 调用，进入 hostapd 的 C 代码世界——从 hostapd 收到请求的那一刻继续追踪。
