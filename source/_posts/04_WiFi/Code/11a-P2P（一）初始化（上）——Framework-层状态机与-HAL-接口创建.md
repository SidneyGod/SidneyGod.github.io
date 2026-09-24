---
title: P2P（一）初始化（上）——Framework 层状态机与 HAL 接口创建
top: 1
related_posts: true
abbrlink: 83b0992f
date: 2026-09-23 07:54:06
tags:
  - Android WiFi
  - P2P
categories:
  - WiFi
  - Code
---

> 相亲角开张了，但还没有"相亲者"到场。本文追踪从 SystemServer 启动 P2P 服务到相亲角挂牌营业的全过程。等你读完，P2P 系统已经把场地、流程、通信渠道全部准备好了，正在等第一个用户操作。

---

# 本章导读

P2P 是一套完整的"设备直连协议"——两台手机不经过路由器就能互传文件、投屏、共享网络。这套协议运行在 WiFi 硬件上，但它有自己的角色分配（Group Owner / Client）、自己的发现流程、自己的安全配对。要理解这套系统怎么跑起来的，第一件事就是看它的"骨架"——状态机和初始化流程。

<!--more-->

本文沿着 `SystemServer `的启动链，完整追踪一次 P2P 初始化：`WifiP2pService `怎么被创建、`P2pStateMachine `的 20 个状态各代表什么、HAL 层 p2p0 接口怎么出现、AIDL `ISupplicantP2pIface `怎么就绪、`WifiP2pMonitor `怎么开始监听，以及 `initializeP2pSettings()` 往 supplicant 下发哪些配置。

本文停在 `InactiveState`——此时相亲角的场地和流程已就绪，系统已经发送 `WIFI_P2P_STATE_CHANGED_ACTION `广播告知所有 App "P2P 可用"，但还没有任何用户操作进来。supplicant 侧的初始化细节——`wpas_p2p_init`、`p2p_data` 数据结构——留给下一篇；驱动侧 QCOM 的 `p2p_psoc_enable`、MTK 的 P2P component 入口，本文 §4.6 先点明。

先看这张全链路分层图，理解初始化要跨越的每一层和跳转边界：

![P2P 初始化全链路分层架构](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-overview.svg)

---

# 1 相亲角开张：SystemServer 启动 WifiP2pService？

> 相亲角的"管理处"是 WifiP2pService，它在 SystemServer 启动阶段被拉起。

Android 的系统服务不是凭空出现的，都有固定的启动流程。WifiP2pService 作为系统级 Service，在 `SystemServer.startOtherServices()` 中被拉起，走的是标准 SystemService 生命周期。

## 1.1 SystemServer 中的启动入口

SystemServer 在 `startOtherServices()` 方法中，通过 SystemServiceManager 拉起 WifiP2pService——一个独立的 SystemService，与 WifiService 平级。它持有 WifiP2pServiceImpl 的实例，并在 `onStart()` 中将其以 Binder 服务的形式发布到 `Context.WIFI_P2P_SERVICE`。

P2P 子系统有自己的生命周期——它不是 WifiService 的子模块，而是一个对等组件。两者都通过 WifiInjector 共享依赖（WifiNative、HalDeviceManager、WifiHandlerThread），但各自跑独立的 StateMachine：WifiService 管理 STA（客户端模式）的 ActiveModeManager 和 ClientModeImpl，WifiP2pServiceImpl 管理 P2P 的 P2pStateMachine。

两者的协调通过 AsyncChannel 消息和 InterfaceConflictManager 来完成——比如开启 P2P 需要关闭 STA 时，ICM 负责管理这个决策流程。

（了解即可）WifiP2pServiceImpl 不是 SystemService，而是被 WifiP2pService 持有的普通类（继承自 Binder 桩 `IWifiP2pManager.Stub`）。`handleBootCompleted()` 在系统启动完成后被调用，此时 mTetheringManager 才可用——说明 P2P Group Owner 模式依赖 Tethering 基础设施。

## 1.2 WifiP2pServiceImpl 构造函数

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:728
public WifiP2pServiceImpl(Context context, WifiInjector wifiInjector) {
    mContext = context;
    mWifiInjector = wifiInjector;
    // ... 权限管理、配置存储等依赖注入 ...

    mDetailedState = NetworkInfo.DetailedState.IDLE;

    mP2pSupported = mContext.getPackageManager().hasSystemFeature(
            PackageManager.FEATURE_WIFI_DIRECT);
    HandlerThread wifiP2pThread = mWifiInjector.getWifiHandlerThread();
    mClientHandler = new ClientHandler(TAG, wifiP2pThread.getLooper());
    mWifiNative = mWifiInjector.getWifiP2pNative();
    // ...
    mP2pStateMachine = new P2pStateMachine(TAG, wifiP2pThread.getLooper(), mP2pSupported);
    mP2pStateMachine.setDbg(false);
    mP2pStateMachine.start();
}
```

**关键动作拆解**：

1. **依赖注入**：通过 WifiInjector（一套统一的 DI 容器）获取 WifiPermissionsUtil、WifiNative、HalDeviceManager、FeatureFlags 等几十个依赖
2. **P2P 支持检测**：调用 `PackageManager.hasSystemFeature(FEATURE_WIFI_DIRECT)` 判断设备硬件是否支持 Wi-Fi Direct——这个返回值决定了状态机的初始状态
3. **独立线程**：P2P 状态机运行在 WifiHandlerThread 上，与 STA 的 ClientModeImpl 状态机共享同一个线程但各自独立
4. **ClientHandler**：处理来自外部 App（通过 WifiP2pManager API）的消息，将消息从 Binder 线程转投到 P2P 状态机的 Handler 线程
5. **状态机构造并启动**：`new P2pStateMachine(...)` → `start()`——Android StateMachine 框架的 `start()` 会触发初始状态的 enter()

从架构角度看，WifiP2pServiceImpl 本身不是状态机，它是一个"包工头"——持有 P2pStateMachine、WifiNative、ClientHandler，负责将外部 API 调用转译为内部消息，同时持有 mThisDevice、mGroups 等全局数据。而所有的流程编排，全部在 P2pStateMachine 内部完成。

WifiP2pServiceImpl 还承担了几个重要的桥梁角色：

- **权限校验**：在消息到达状态机之前，检查调用方是否有 CHANGE_WIFI_STATE 权限
- **WorkSource 管理**：通过 mActiveClients 记录哪些 UID 的 App 正在使用 P2P，用于电池统计和资源归因
- **DeathRecipient 管理**：当 App 进程死亡时，通过 Binder DeathRecipient 自动清理该 App 注册的 P2P 监听器和请求

如果你在想"为什么不让 WifiP2pServiceImpl 直接处理流程"——因为 P2P 的操作本质上是异步的：发一个命令给 supplicant，然后等回调（可能几秒后才回来）。在等待期间，可能有其他命令进来（比如另一个 App 也调了 connect）。用 StateMachine 来管理，每条消息在哪个状态下怎么处理是显式写死的，不会出现"忘了处理边界情况"的 bug。

举个例子：用户在 P2P 组创建过程中（GroupCreatingState）又点了"搜索设备"（DISCOVER_PEERS）。如果没有状态机，你需要写很多 if-else 来判断"组创建到哪一步了？能搜索吗？"。有了状态机，GroupCreatingState 里的 UserAuthorizingNegotiationRequestState 可以直接返回 NOT_HANDLED，消息冒泡到 GroupCreatingState，GroupCreatingState 判断当前阶段是否允许搜索。这种"逐层决策、逐层兜底"的模式，比平铺的 if-else 可靠得多。

更深一层，StateMachine 还顺手解决了并发问题。P2P 的命令来源天然多线程：App 通过 Binder 线程发起调用，supplicant 通过 AIDL 回调线程上报事件。StateMachine 把所有这些输入汇聚到同一个 Handler 消息队列，在 WifiHandlerThread 上串行消费——同一时刻只有一条消息在 processMessage 里执行，状态和共享数据天然无需加锁。如果退化成 if-else + 全局状态变量，光是"怎么让多个线程安全地读写当前状态"这一件事就够写一版同步代码，而任何遗漏锁的地方都可能把状态机推进错误的分支。

---

# 2 挂牌子：P2pStateMachine 的 20 个状态？

> 相亲角的管理处"开张"了，但管理处内部有一套完整的办事流程——这 20 个状态就是流程的每个办事窗口。每个状态像窗口上的牌子，告诉你"现在能办什么、不能办什么"。

这 20 个办事窗口在状态机里怎么排布，先看全景图——父子层级与分组一眼可辨：

![P2pStateMachine 状态机层级树](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-p2p-state-machine.svg)

P2pStateMachine 继承自 Android 的 `StateMachine` 框架，它不是一个简单的 Flat 状态列表，而是**层级状态机（Hierarchical State Machine，HSM）**——子状态的共性处理提取到父状态，子状态只处理差异化的逻辑。

在深入每个状态之前，先理解 HSM 的工作机制：当一个消息（Message）到达状态机时，首先由当前叶子状态处理。如果叶子状态返回 `NOT_HANDLED`，消息会沿层级树上溯到父状态再试一次，直到被处理或到达根状态 DefaultState。这就是为什么 DefaultState 里有大量的 `case` 分支——它作为"终极兜底"，处理所有子状态都未覆盖的消息类型。

一个关键细节：状态机中处理消息的类型分为三类。`CMD_*` 前缀的是外部 App 通过 WifiP2pManager API 发来的命令（如 DISCOVER_PEERS、CONNECT）；WifiP2pMonitor 事件（如 P2P_DEVICE_FOUND_EVENT）来自 supplicant 回调；内部消息（如 ENABLE_P2P、DISABLE_P2P）是状态机内部自己发给自己的。

## 2.1 状态层级树

以下是完整的状态层级。缩进表示父子关系：

```none
DefaultState (根状态，处理所有状态的兜底逻辑)
├── P2pNotSupportedState (设备不支持 P2P)
├── P2pDisablingState (P2P 正在关闭中)
├── P2pDisabledContainerState (P2P 关闭状态的容器)
│   ├── P2pDisabledState (P2P 已关闭，初始状态)
│   └── WaitingState (等待用户确认是否关闭 STA)
└── P2pEnabledState (P2P 已启用的父状态)
    ├── InactiveState (P2P 已启用但无活动连接)
    ├── IdleState (P2P 已启用且无进行中的连接尝试)
    ├── GroupCreatingState (正在创建 P2P 组的父状态)
    │   ├── UserAuthorizingInviteRequestState (等待用户确认接受邀请)
    │   ├── UserAuthorizingNegotiationRequestState (等待用户确认协商)
    │   ├── ProvisionDiscoveryState (Provision Discovery 进行中)
    │   ├── GroupNegotiationState (GO Negotiation 进行中)
    │   ├── FrequencyConflictState (频率冲突处理中)
    │   ├── P2pRejectWaitState (等待对端响应拒绝)
    │   └── L3ConnectingState (L3 连接建立中)
    └── GroupCreatedState (P2P 组已创建的父状态)
        ├── UserAuthorizingJoinState (等待用户确认加入)
        └── OngoingGroupRemovalState (正在移除 P2P 组)
```

**初始状态**：如果 `p2pSupported == true`，初始状态为 `P2pDisabledState`；否则为 `P2pNotSupportedState`。

## 2.2 状态汇总表

| 状态                                   | 所在的父状态              | 含义                                     | 典型进入条件                          |
| -------------------------------------- | ------------------------- | ---------------------------------------- | ------------------------------------- |
| DefaultState                           | —（根）                   | 兜底：处理所有子状态未覆盖的消息         | 状态机启动即进入                      |
| P2pNotSupportedState                   | DefaultState              | 设备不具备 P2P 硬件能力                  | FEATURE_WIFI_DIRECT = false           |
| P2pDisablingState                      | DefaultState              | P2P 正在关闭，等待 teardown 完成         | 收到 DISABLE_P2P                      |
| P2pDisabledContainerState              | DefaultState              | 关闭态的容器，统一处理关闭态共性逻辑     | 从 P2pEnabledState 退出时进入         |
| P2pDisabledState                       | P2pDisabledContainerState | P2P 已完全关闭                           | 初始化默认状态；关闭流程完成后        |
| WaitingState                           | P2pDisabledContainerState | 等待用户确认（如关闭 STA 以开启 P2P）    | 开启 P2P 但需要用户决策               |
| P2pEnabledState                        | DefaultState              | P2P 就绪的父状态，统一处理启用态共性逻辑 | setupInterface() 成功后               |
| InactiveState                          | P2pEnabledState           | P2P 已启用，无活动连接                   | 初始化完成；组创建失败回退            |
| IdleState                              | P2pEnabledState           | P2P 已启用，无进行中的连接尝试           | p2pOwnership feature 启用时初始化完成 |
| GroupCreatingState                     | P2pEnabledState           | 正在创建 P2P 组                          | 用户发起 connect / createGroup        |
| UserAuthorizingInviteRequestState      | GroupCreatingState        | 收到邀请，弹窗等用户确认                 | 收到 INVITATION_RECEIVED 事件         |
| UserAuthorizingNegotiationRequestState | GroupCreatingState        | 收到协商请求，弹窗等用户确认             | 收到 GO_NEGOTIATION_REQUEST 事件      |
| ProvisionDiscoveryState                | GroupCreatingState        | WPS 配网协商中                           | connect 触发 Provision Discovery      |
| GroupNegotiationState                  | GroupCreatingState        | GO 角色协商三次握手                      | 用户确认协商请求                      |
| FrequencyConflictState                 | GroupCreatingState        | 多组并发产生信道冲突                     | 检测到频率冲突                        |
| P2pRejectWaitState                     | GroupCreatingState        | 发送拒绝后等待对端响应                   | 用户拒绝协商或邀请                    |
| L3ConnectingState                      | GroupCreatingState        | 组创建成功，等待 DHCP/路由配置           | 组创建完成，等待 IP                   |
| GroupCreatedState                      | P2pEnabledState           | P2P 组已成功创建                         | 组创建完成且 L3 就绪                  |
| UserAuthorizingJoinState               | GroupCreatedState         | 弹窗等用户确认加入已有组                 | 收到组创建事件但需要确认              |
| OngoingGroupRemovalState               | GroupCreatedState         | 正在拆除 P2P 组                          | 用户触发 removeGroup 或异常退出       |

**状态命名规律**：注意命名中的"正在进行"和"等待确认"两类状态的区别。以 `-ing` 或 `Creating`/`Negotiation` 结尾的（GroupCreatingState、ProvisionDiscoveryState、GroupNegotiationState、L3ConnectingState、OngoingGroupRemovalState）表示系统正在执行一个主动操作——向 supplicant 发命令然后等回调。而以 `UserAuthorizing` 开头的（UserAuthorizingInviteRequestState、UserAuthorizingNegotiationRequestState、UserAuthorizingJoinState）表示系统在等待用户交互——弹窗需要用户点"同意"或"拒绝"。这两类状态的核心区别是：前者依赖 supplicant 异步回调来推动状态转移，后者依赖用户操作（通过 WifiP2pManager API 回调）来推动。

## 2.3 构造函数：状态的注册与层级关系的建立

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:1554
P2pStateMachine(String name, Looper looper, boolean p2pSupported) {
    super(name, looper);

    addState(mDefaultState);
        addState(mP2pNotSupportedState, mDefaultState);
        addState(mP2pDisablingState, mDefaultState);
        addState(mP2pDisabledContainerState, mDefaultState);
            addState(mP2pDisabledState, mP2pDisabledContainerState);
            addState(mWaitingState, mP2pDisabledContainerState);
        addState(mP2pEnabledState, mDefaultState);
            addState(mInactiveState, mP2pEnabledState);
            addState(mIdleState, mP2pEnabledState);
            addState(mGroupCreatingState, mP2pEnabledState);
                addState(mUserAuthorizingInviteRequestState, mGroupCreatingState);
                addState(mUserAuthorizingNegotiationRequestState, mGroupCreatingState);
                addState(mProvisionDiscoveryState, mGroupCreatingState);
                addState(mGroupNegotiationState, mGroupCreatingState);
                addState(mFrequencyConflictState, mGroupCreatingState);
                addState(mP2pRejectWaitState, mGroupCreatingState);
                addState(mL3ConnectingState, mGroupCreatingState);
            addState(mGroupCreatedState, mP2pEnabledState);
                addState(mUserAuthorizingJoinState, mGroupCreatedState);
                addState(mOngoingGroupRemovalState, mGroupCreatedState);

    if (p2pSupported) {
        setInitialState(mP2pDisabledState);
    } else {
        setInitialState(mP2pNotSupportedState);
    }
    // ...
    // 注册 WIFI_STATE_CHANGED_ACTION 广播接收器
    // 注册 Location Mode 变化广播接收器
    // 注册 Tethering 状态广播接收器
    // 注册 UserRestrictions 变化监听
}
```

构造函数里除了注册状态层级，还做了几件重要的事：

- **WiFi 状态监听**：注册 `WIFI_STATE_CHANGED_ACTION` 广播，WiFi 关闭时可能需要连带关闭 P2P（除非设备支持 D2D——不需要 STA 也能跑 P2P）
- **位置模式监听**：Android T 以下版本，位置模式关闭时需要停止 P2P 发现（因为 WiFi 扫描结果可推断位置）
- **Tethering 状态监听**：P2P Group Owner 模式本质上是热点 + Tethering 的组合，需要感知 Tethering 状态变化
- **Coex Manager 注册**：监听共存不安全信道列表变化（某些信道 LTE 和 WiFi 不能同时用）
- **Idle Shutdown 定时器**：创建 `WakeupMessage`，P2P 长时间无活动后自动关闭

（了解即可）如果 `p2pSupported == false`，上述所有广播监听都不会注册——直接停在 P2pNotSupportedState，后续任何 P2P 操作都会被拒绝。

## 2.4 状态机的设计：为什么是三层树而非线性流水线

回头看一下状态层级树，你会发现一个规律：关闭态有 P2pDisabledContainerState 作为父状态，启用态有 P2pEnabledState 作为父状态，组创建态有 GroupCreatingState 作为父状态。

这不是为了"看起来整齐"。父状态的存在解决了三个实际问题：

**第一，共享退出逻辑**。P2pEnabledState 是所有启用态子状态的公共父状态。当 supplicant 突然断开连接（SUP_DISCONNECTION_EVENT），不管当前正处于 InactiveState、GroupNegotiationState 还是 GroupCreatedState，P2pEnabledState 统一捕获这个消息并执行相同的退出流程：`smTransition(this, mP2pDisabledState)` 直接退回到 P2pDisabledState。如果不提取到父状态，同样的退出逻辑要在 10+ 个子状态中各写一遍。而"停止监控 → teardown 接口 → 转移到 P2pDisablingState"这条更完整的拆除流程，则由 DISABLE_P2P 命令在 P2pEnabledState 中触发。

**第二，共享进入逻辑**。无论从哪个路径进入 P2pEnabledState 的子状态（初始化进入 InactiveState、创建组进入 GroupCreatingState、组已创建进入 GroupCreatedState），`enterImpl()` 只执行一次：初始化 P2P 设置、注册 Tethering 回调。这些是一次性的配置操作，不需要每个子状态重复。

**第三，消息共享处理**。P2pEnabledState 处理 SET_WFD_INFO、BLOCK_DISCOVERY 等"与具体子状态无关"的操作——不管在 InactiveState 还是 GroupCreatedState，设置 WFD 信息的逻辑都一样。子状态不需要关心这些消息，它们只处理自己特有的操作。

如果你设计一个平铺的状态机（Flat State Machine），每个状态都要处理 SET_WFD_INFO，重复 10 次——一旦逻辑要改，就要改 10 个地方。HSM 通过层级继承消除了这种重复。

---

# 3 拉电线：谁触发了 P2P 的启用？

> 相亲角开张了，但还没拉电线——需要有人来"申请营业"。在代码里，这个"申请"是一个 ENABLE_P2P 消息。

P2P 的启用不是自动的。在 Android 中，它是一个"懒初始化"——只有当有 App 通过 WifiP2pManager API 触发了 P2P 相关操作（或系统有需求）时，才会走向启用流程。

## 3.1 触发路径

P2P 的启用走的是 Android Binder IPC 通道：

1. App 调用 `WifiP2pManager` 的某个方法（如 `discoverPeers()`）
2. `WifiP2pManager` 内部通过 Messenger（封装的 Binder）跨进程通信到 System Server
3. `WifiP2pServiceImpl.ClientHandler.handleMessage()` 收到消息，转发给 `mP2pStateMachine.sendMessage()`
4. 消息进入状态机后先经过 `onPreHandleMessage()`——它只做 WorkSource 记账（把发起方 UID 计入 `mActiveClients`），随后消息被投递到当前状态 `P2pDisabledState.processMessageImpl()`。default 分支检测到该命令需要 P2P 激活（`needsActiveP2p`），在 WiFi 可用且有客户端在册的前提下，直接进入启用流程（InterfaceConflictManager 决策 → `setupInterface()` → 状态转移），详见 3.2

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:2170
@Override
protected void onPreHandleMessage(Message msg) {
    if (needsActiveP2p(msg.what)) {
        updateWorkSourceByUid(msg.sendingUid, true);
    }
}
```

这套机制的好处是：App 不需要显式调用 "`enableP2p()`"——任何需要 P2P 的命令到达 P2pDisabledState 后都会被 default 分支拦截并触发初始化。如果 P2P 已经启用，命令直接进入 P2pEnabledState 的正常处理，`onPreHandleMessage` 只负责合并 WorkSource，不会重复初始化。

## 3.2 P2pDisabledState 处理启用：ENABLE_P2P 与 default 分支

上一节说的"直接进入启用流程"，具体落到 `P2pDisabledState.processMessageImpl()` 里。实际上有两条消息路径汇聚到同一段启用逻辑：一条是显式的 `ENABLE_P2P` 消息（`case ENABLE_P2P`）；另一条是客户端命令的 default 分支——`DISCOVER_PEERS`、`CONNECT` 这类需要 P2P 激活的命令到达时，会落入 `default` 分支，而 default 分支检测 `needsActiveP2p()` 后执行**完全相同的** InterfaceConflictManager + setupInterface 流程。下面以 `ENABLE_P2P` 为例展示这段核心逻辑：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:3074
@Override
public boolean processMessageImpl(Message message) {
    switch (message.what) {
        case ENABLE_P2P: {
            if (mActiveClients.isEmpty()) {
                Log.i(TAG, "No active client, ignore ENABLE_P2P.");
                break;
            }
            // ... 处理 Interface Conflict ...
            int proceedWithOperation =
                    mInterfaceConflictManager.manageInterfaceConflictForStateMachine(
                            TAG, message, mP2pStateMachine, mWaitingState,
                            mP2pDisabledState, HalDeviceManager.HDM_CREATE_IFACE_P2P,
                            createRequestorWs(message.sendingUid, packageName),
                            false);
            if (proceedWithOperation == ICM_EXECUTE_COMMAND) {
                if (setupInterface()) {
                    if (mFeatureFlags.p2pOwnership()) {
                        smTransition(this, mIdleState);
                    } else {
                        smTransition(this, mInactiveState);
                    }
                }
            }
            break;
        }
    }
}
```

把这段代码里"拉电线"的决策路径画成一张图——从 ENABLE_P2P 到达开始，每到一个岔路口往哪个方向走，一目了然：

![ENABLE_P2P 决策树：启用守卫链](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-enable-p2p-decision.svg)

**关键决策点分析**：

1. **No active client → 直接忽略**：没有 App 注册 P2P 监听器时，ENABLE_P2P 不会被处理——这是一种防御，避免系统无故拉起 supplicant

2. **Interface Conflict Manager**：P2P 和 STA 共用物理 WiFi 芯片。当用户正在用 STA 连 WiFi 时开启 P2P，ICM 会弹窗询问用户"断开 WiFi 以开启 P2P？"这是并发管理的核心机制
   - `ICM_ABORT_COMMAND`：用户拒绝，设置本设备状态为 UNAVAILABLE
   - `ICM_EXECUTE_COMMAND`：可以继续，走 setupInterface() 流程
   - `ICM_SKIP_COMMAND_WAIT_FOR_USER`：需要等待用户选择，先切到 WaitingState

3. **p2pOwnership Feature Flag**：如果启用，跳到 `IdleState`；否则跳到 `InactiveState`。两者的区别是 IdleState 是更"现代化"的等待状态，支持 p2pOwnership（不同 App 可以"拥有"不同的 P2P 连接），而 InactiveState 是传统路径

4. **直接转换，无 P2pEnablingState**：从代码中可以清楚看到，`setupInterface()` 成功后直接 `smTransition` 到目标状态——没有中间的 "P2pEnablingState"。这意味着初始化是一个同步阻塞过程：`setupInterface()` 内部会等到 HAL 接口创建完成、supplicant 连接建立后才返回

这个设计选择值得注意：如果 HAL 创建接口需要 500ms（比如需要先关闭 STA 接口），状态机在这 500ms 内一直停在 P2pDisabledState——对外界来说，P2P 还是"关闭"状态。只有 `setupInterface()` 返回 true 的那一瞬间，状态才切换到 P2pEnabledState 的子状态。

那么反过来：`setupInterface()` 返回 false 时，状态机怎么恢复？答案是"不主动恢复"——这条 ENABLE_P2P 消息已经被 break 消费掉，状态机停留在 P2pDisabledState，不会自动重试。恢复完全由下一次客户端命令驱动：任何 `needsActiveP2p` 的命令再次到达 P2pDisabledState 时，会重新走一遍完整的 guard 链。

这个 guard 链是层层的，每一层都是一道独立的防线：

1. **`isWifiP2pAvailable()` 不满足**（WiFi 关、管理员禁用）→ 在 `setupInterface()` 入口直接返回 false，连接口创建都不尝试
2. **`mDeathDataByBinder` 为空** → 直接忽略消息。default 分支用 mDeathDataByBinder 判断是否有调用过 `initialize()` 的客户端在册，而 `ENABLE_P2P` 这个显式 case 才用 `mActiveClients` 判空——两种判空的对象不同，防止误放行
3. **ICM 返回 `ICM_ABORT_COMMAND`**（用户拒绝断开 STA）→ 调用 `updateThisDevice(WifiP2pDevice.UNAVAILABLE)`（`WifiP2pServiceImpl.java:3104`），把本设备标记为不可用

而 setupInterface() 内部 `mInterfaceName == null` 时还会进一步归因：调 `mHalDeviceManager.isItPossibleToCreateIface()`（行 3044）区分"接口资源不够"（仅打一条 WARN）与"HAL 层异常"（走 `takeBugReportInterfaceFailureIfNeeded()` 抓 bugreport，行 3048）——两种失败性质不同，处理方式也刻意区分。

唯一"自动"的恢复路径是 WaitingState 重入：用户在 ICM 弹窗里点了"确定"后 ICM 重发 ENABLE_P2P，P2pDisabledState 检测到 `WaitingState.wasMessageInWaitingState()` 为 true，先调 `mInterfaceConflictManager.reset()`（行 3085）复位 ICM 状态，再重新执行启用流程（详见 3.3）。

## 3.3 InterfaceConflictManager：P2P 启用前的最后一道安检

在 `P2pDisabledState.processMessageImpl(ENABLE_P2P)` 中，有一个容易被忽略但作用关键的组件——`InterfaceConflictManager`（ICM）。它的全称揭示了职责：管理系统接口资源的冲突。

WiFi 芯片同一时间能支持的接口数量是有限的。大部分手机 WiFi 芯片能同时支持 STA（客户端模式）和 P2P，但这也意味着资源会互相竞争。ICM 要回答三个问题：

1. **当前有没有足够的接口资源创建 p2p0？** 如果 STA 已经占了一个接口、SAP（热点）又占了一个，可能就没有空余接口给 P2P 了
2. **如果需要关闭 STA 来腾出位置，用户同意吗？** ICM 会弹出一个系统对话框："开启 Wi-Fi Direct 需要断开当前 Wi-Fi 连接，是否继续？"
3. **操作完成后怎么通知状态机？** ICM 有三种返回值：`ICM_ABORT_COMMAND`（用户拒绝，放弃操作）、`ICM_EXECUTE_COMMAND`（资源够用，直接执行）、`ICM_SKIP_COMMAND_WAIT_FOR_USER`（需要等用户选择，状态机先切到 WaitingState）

WaitingState 就是为第三种情况准备的。当 ICM 弹出对话框等待用户确认时，P2pStateMachine 进入 WaitingState，暂停处理当前消息。用户点击"确定"后，ICM 重新发送 `ENABLE_P2P` 消息，消息中带有标记 `wasMessageInWaitingState = true`，表示这是"被等待后重新执行的命令"。状态机回到 P2pDisabledState 重新处理，但这次 `proceedWithOperation` 会返回 `ICM_EXECUTE_COMMAND`。

如果不使用 WaitingState 而是让状态机"停在原地等"——问题在于，用户可能在弹窗期间按了 Home 键、切到其他 App、甚至锁屏。Android 的 Dialog 是基于 WindowManager 的异步 UI 组件，不能用阻塞方式等结果。WaitingState + 消息重发的模式是 Android 框架中处理"需要用户交互的异步操作"的标准模式。

把这条"弹窗 → 等待 → 重入"的完整交互画成图，两条岔路（用户拒绝 / 用户确认）的去向一目了然：

![ICM 弹窗与 WaitingState 重入交互](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-icm-waiting.svg)

---

# 4 HAL 接口与 supplicant 通道的完整链路？

> 相亲角的"专用场地"是 p2p0 接口，它是怎么开辟出来的？

上一节我们看到 `P2pDisabledState.setupInterface()` 是启动的核心入口。这一节我们钻进这个方法的内部，追踪一个 p2p0 网络接口从"不存在"到"可以被 supplicant 操作"的完整过程。

## 4.1 setupInterface() 全景

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:3030
private boolean setupInterface() {
    if (!isWifiP2pAvailable()) {
        Log.e(TAG, "Ignore P2P enable since wifi is " + mIsWifiEnabled
                + ", P2P disallowed by admin=" + mIsP2pDisallowedByAdmin);
        return false;
    }
    WorkSource requestorWs = createMergedRequestorWs();
    mInterfaceName = mWifiNative.setupInterface((String ifaceName) -> {
        sendMessage(DISABLE_P2P);
        checkAndSendP2pStateChangedBroadcast();
    }, getHandler(), requestorWs);
    if (mInterfaceName == null) {
        // ... 错误处理：判断是资源不够还是 HAL 失败 ...
        return false;
    }
    setupInterfaceFeatures();
    try {
        mNetdWrapper.setInterfaceUp(mInterfaceName);
    } catch (IllegalStateException ie) {
        loge("Unable to change interface settings: " + ie);
    }
    registerForWifiMonitorEvents();
    return true;
}
```

这个方法做了四件事：

1. **mWifiNative.setupInterface()**：创建 P2P 接口、连接 supplicant、设置 P2P iface。注意传入的第一个参数是「接口销毁回调」——若 HAL 层因为芯片复位或共存切换等原因异步销毁了 p2p0 接口，这个回调会被触发：向状态机发送 `DISABLE_P2P` 并重新检查 P2P 状态广播，让系统自动回到关闭流程
2. **setupInterfaceFeatures()**：配置 MAC 随机化等接口特性
3. **mNetdWrapper.setInterfaceUp()**：将 p2p0 网卡设为 UP 状态（相当于 `ifconfig p2p0 up`）
4. **registerForWifiMonitorEvents()**：注册 WifiP2pMonitor 监听，开始接收 supplicant 事件

**异常路径**：如果 `mWifiNative.setupInterface()` 返回 null（创建失败），方法会判断失败原因——是资源不够（isItPossibleToCreateIface 返回 false），还是 HAL 层面的 bug（触发 bugreport）。

## 4.2 WifiP2pNative.setupInterface()：接口创建的五步走

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pNative.java:238
public String setupInterface(
        @Nullable HalDeviceManager.InterfaceDestroyedListener destroyedListener,
        @NonNull Handler handler, @NonNull WorkSource requestorWs) {
    synchronized (mLock) {
        if (mP2pIfaceName == null) {
            // 第一步：通过 HalDeviceManager 创建 p2p0 接口
            mP2pIface = mWifiNative.createP2pIface(mInterfaceDestroyedListener, handler,
                requestorWs);
            if (mP2pIface != null) {
                mP2pIfaceName = mP2pIface.name;
            }
            if (mP2pIfaceName == null) {
                // ...错误处理...
                return null;
            }
            // 第二步：等待 supplicant daemon 连接就绪
            if (!waitForSupplicantConnection()) {
                Log.e(TAG, "Failed to connect to supplicant");
                teardownInterface();
                return null;
            }
            // 第三步：在 supplicant 中注册 P2P iface
            if (!mSupplicantP2pIfaceHal.setupIface(mP2pIfaceName)) {
                Log.e(TAG, "Failed to setup P2p iface in supplicant");
                teardownInterface();
                return null;
            }
            // 第四步：注册 supplicant 死亡回调
            if (!mSupplicantP2pIfaceHal.registerDeathHandler(
                            new SupplicantDeathHandlerInternal())) {
                Log.e(TAG, "Failed to register supplicant death handler");
                teardownInterface();
                return null;
            }
            // 第五步：获取 supplicant 支持的特性
            long featureSet = mSupplicantP2pIfaceHal.getSupportedFeatures();
            mWifiInjector.getSettingsConfigStore()
                    .put(WIFI_P2P_SUPPORTED_FEATURES, featureSet);
            return mP2pIfaceName;
        }
    }
}
```

这就是 HAL 接口创建的完整五步——像相亲角场地从毛坯到挂牌的施工清单：先辟场地（创建接口）、通电（等 supplicant）、接电话线（注册 P2P iface）、装警报器（死亡回调）、贴出服务价目表（查特性）。哪一步验收不过，已装的设施都得拆掉退回去：

| 步骤 | 方法                                  | 做什么                                           | 失败时     |
| ---- | ------------------------------------- | ------------------------------------------------ | ---------- |
| 1    | `mWifiNative.createP2pIface()`        | 通过 HalDeviceManager 创建 p2p0 网络接口         | 返回 null  |
| 2    | `waitForSupplicantConnection()`       | 轮询等待 supplicant daemon 启动完成（最多 5 秒） | teardown   |
| 3    | `mSupplicantP2pIfaceHal.setupIface()` | 在 supplicant 中注册 p2p0 并注册事件回调         | teardown   |
| 4    | `registerDeathHandler()`              | 注册 supplicant 进程死亡监听                     | teardown   |
| 5    | `getSupportedFeatures()`              | 查询 supplicant 支持哪些 P2P 特性并持久化        | （非致命） |

上面这张表格只写了"每步做什么、失败怎么办"，但没画出这五步是**跨了多少层**才走完的。下面这张泳道时序图把每一步落在哪一层（状态机 → WifiP2pNative → WifiNative/HalDeviceManager → HAL·IWifiChip → wpa_supplicant）、步骤 1 内部又跨了几层到内核，全部画出来：

![WifiP2pNative.setupInterface() 五步走跨层时序图](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-setup-interface-1790121678060-8.svg)

（了解即可）`createP2pIface()` 在无 HAL 支持的设备上有降级路径——直接通过系统属性 `wifi.direct.interface` 获取接口名（默认 "p2p0"），跳过 HalDeviceManager。

**registerDeathHandler 的 binder death 语义**。`registerDeathHandler()` 本身只是把 handler 存进 `mDeathEventHandler` 字段，真正的死亡检测发生在更早的 `initialize()`：它在拿到 `ISupplicant` 的 Binder 引用后，调用 `serviceBinder.linkToDeath(mSupplicantDeathRecipient, 0)` 把死亡回调挂到 Binder 上。

当 wpa_supplicant 进程崩溃时，Binder 驱动触发 `mSupplicantDeathRecipient`（一个 `DeathRecipient`）。它先 `countDown` 等待闩锁，再调用 `supplicantServiceDiedHandler()`：清空 `mISupplicant`/`mISupplicantP2pIface` 引用、把 `mInitializationStarted` 复位，然后调用 `mDeathEventHandler.onDeath()`。

这个回调在 `WifiP2pNative` 里是 `SupplicantDeathHandlerInternal.onDeath()`——它调用 `mInterfaceDestroyedListener.teardownAndInvalidate(mP2pIface.name)` 拆除接口、清空状态，并累加 `mWifiMetrics.incrementNumSupplicantCrashes()` 崩溃计数。

所以"注册死亡监听"实际是两段：`initialize()` 里 `linkToDeath` 挂 Binder 监听，`registerDeathHandler()` 挂业务回调，缺一不可。

## 4.3 waitForSupplicantConnection()：轮询等待连接建立

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pNative.java:172
private boolean waitForSupplicantConnection() {
    if (!mSupplicantP2pIfaceHal.isInitializationStarted()
            && !mSupplicantP2pIfaceHal.initialize()) {
        return false;
    }
    int connectTries = 0;
    while (connectTries++ < CONNECT_TO_SUPPLICANT_MAX_SAMPLES) {
        if (mSupplicantP2pIfaceHal.isInitializationComplete()) {
            return true;
        }
        try {
            Thread.sleep(CONNECT_TO_SUPPLICANT_SAMPLING_INTERVAL_MS);
        } catch (InterruptedException ignore) {
        }
    }
    return false;
}
```

这里有一个常被忽略的细节：`mSupplicantP2pIfaceHal.initialize()` 会触发 supplicant daemon 的懒启动。也就是说，如果 supplicant 还没跑起来（比如 STA 也没有在用），P2P 初始化会先启动 supplicant 进程，然后轮询等待它完成 AIDL 服务注册。

轮询参数：`CONNECT_TO_SUPPLICANT_MAX_SAMPLES = 50`，`CONNECT_TO_SUPPLICANT_SAMPLING_INTERVAL_MS = 100`，所以最多等待 5 秒。如果 5 秒后 supplicant 还没就绪，P2P 启用失败。

为什么用轮询而不是注册一个异步回调？因为 `setupInterface()` 的调用方（P2pDisabledState）期望一个同步结果——要么成功（返回接口名），要么失败（返回 null，teardown 已清理干净）。异步 callback 会让状态机需要多一个中间状态来处理"等待 supplicant 就绪"，增加复杂度。设计上选择了"短时间阻塞轮询"作为折中——只在初始化的这一次阻塞，后续所有操作都是异步的。

## 4.4 HIDL vs AIDL：两个 HAL 实现路径的并存

在 Android 的 WiFi HAL 层，有一段漫长的迁移：从 HIDL（HAL Interface Definition Language，Android 8.0 引入）到 AIDL（Android Interface Definition Language，Android 11+ 用于 HAL）。P2P 子系统需要同时支持两种路径。

`SupplicantP2pIfaceHal` 接口有两个实现：

- `SupplicantP2pIfaceHalHidlImpl`：使用 HIDL `android.hardware.wifi.supplicant@1.0::ISupplicantP2pIface`
- `SupplicantP2pIfaceHalAidlImpl`：使用 AIDL `android.hardware.wifi.supplicant.ISupplicantP2pIface`

在 `SupplicantP2pIfaceHalAidlImpl.setupIface()` 中，`addIface()` 的调用链是：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/SupplicantP2pIfaceHalAidlImpl.java:242
private ISupplicantP2pIface addIface(@NonNull String ifaceName) {
    synchronized (mLock) {
        if (!checkSupplicantAndLogFailure("addIface")) {
            return null;
        }
        try {
            return mISupplicant.addP2pInterface(ifaceName);
        } catch (RemoteException e) {
            handleRemoteException(e, "addIface");
        } catch (ServiceSpecificException e) {
            handleServiceSpecificException(e, "addIface");
        }
        return null;
    }
}
```

`mISupplicant` 是 `android.hardware.wifi.supplicant.ISupplicant` 的 AIDL 代理对象，通过 `ServiceManager.waitForDeclaredService(ISupplicant.DESCRIPTOR + "/default")` 获取并 `ISupplicant.Stub.asInterface()` 转成 Java 代理（Android T 以上路径）。`addP2pInterface(ifaceName)` 会跨进程调用到 wpa_supplicant daemon，后者在内部创建 `P2pInterface` 对象并返回 Binder 引用。

从架构角度看，HIDL 到 AIDL 的迁移不只是换了一套 IPC 语法。AIDL 的优势在于：

1. **与 Android App 开发统一的接口定义**：不需要再学一套 HIDL 语法
2. **支持 Stable AIDL**：编译时生成 C++/Java/Rust 绑定，接口稳固
3. **更好的版本兼容性**：AIDL 的版本管理比 HIDL 的 `@1.0`/`@1.2` 标记更灵活

如果把 `SupplicantP2pIfaceHalHidlImpl` 和 `SupplicantP2pIfaceHalAidlImpl` 并排看，实现差异远不止 binder 语法。三处关键差异——服务获取、接口创建、回调版本——可以放进一张对比表：

| 维度     | HIDL（HidlImpl）                                             | AIDL（AidlImpl）                                             |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 服务获取 | `initialize()` 里直接调 `ISupplicant.getService()`（`SupplicantP2pIfaceHalHidlImpl.java:532`），服务未注册时立刻抛 `NoSuchElementException` | `ServiceManager.waitForDeclaredService(ISupplicant.DESCRIPTOR + "/default")`（`SupplicantP2pIfaceHalAidlImpl.java:340`），阻塞等待 supplicant 把 AIDL 服务声明出来 |
| 接口创建 | 两条路径并存：V1_0 时代无 `addInterface`，只能先 `listInterfaces()` 再 `getInterface()` 取回 P2P iface（`getIfaceV1_0()`，`HidlImpl.java:348`）；V1_1 起才新增 `addInterface`（`addIfaceV1_1()`，行 397），且是异步回调，结果通过 `SupplicantStatus` 返回 | 两条路径合并为一条同步调用 `mISupplicant.addP2pInterface(ifaceName)`（`AidlImpl.java:249`），创建失败直接抛 `ServiceSpecificException` 被 catch 统一处理 |
| 回调版本 | 注册前先探测版本：能 cast 到 V1_4 就用 `SupplicantP2pIfaceCallbackV1_4` + `registerCallbackV1_4`，否则退回 V1_0 回调（`HidlImpl.java:315-331`） | 单一 `SupplicantP2pIfaceCallbackAidlImpl`，版本信息经 `getCachedServiceVersion()` 传入（`AidlImpl.java:230`） |

服务获取这一行解释了 §4.3 的轮询等待为何能成立：AIDL 的 waitForDeclaredService 会一直等到 supplicant 完成服务注册才返回，而 HIDL 的 getService 是"服务没起来就直接失败"。

把这两条路径放回相亲角的比喻里，区别更直观：HIDL 像"拉电线"时直接问前台"总机在吗"，总机没就位就吃个闭门羹（抛 `NoSuchElementException`）；AIDL 则像先给总机挂个号、占好一条专线，总机一上线就回拨通知你——所以 §4.3 的轮询等待只对 AIDL 路径成立，它等的正是"总机回拨"这声铃响。

回调版本那一行则暴露了 HIDL 版本管理的笨拙——每升一个版本就要在 Java 侧多写一套 cast + 分支，而 AIDL 只要一个实现加一个版本号。这个"版本号"不是运行时现查的：AIDL 侧 `getCachedServiceVersion()`（`SupplicantP2pIfaceHalAidlImpl.java:2642`）读的是 SettingsConfigStore 里缓存的 `SUPPLICANT_HAL_AIDL_SERVICE_VERSION`——该值在 supplicant HAL 初始化时经 `getInterfaceVersion()` 查询一次写入，之后所有回调构造与特性开关只读这份缓存，免去每次调用都跨进程探测版本的开销。

从 supplicant HAL 回到 WifiNative 侧——接口创建的 Java 入口是 `createP2pIface()`，它先确保 HAL 启动，再分配接口槽位：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/WifiNative.java:1268
public Iface createP2pIface(
        HalDeviceManager.InterfaceDestroyedListener p2pInterfaceDestroyedListener,
        Handler handler, WorkSource requestorWs) {
    synchronized (mLock) {
        if (!startHal()) {
            Log.e(TAG, "Failed to start Hal");
            return null;
        }
        Iface iface = mIfaceMgr.allocateIface(Iface.IFACE_TYPE_P2P);
        if (iface == null) {
            Log.e(TAG, "Failed to allocate new P2P iface");
            stopHalAndWificondIfNecessary();
            return null;
        }
        iface.name = createP2pIfaceFromHalOrGetNameFromProperty(
                p2pInterfaceDestroyedListener, handler, requestorWs);
        if (TextUtils.isEmpty(iface.name)) {
            Log.e(TAG, "Failed to create P2p iface in HalDeviceManager");
            mIfaceMgr.removeIface(iface.id);
            return null;
        }
        return iface;
    }
}
```

这套流程可以理解为三步：

1. **startHal()**：确保 WiFi HAL 守护进程已启动（如果 STA 已经在运行，HAL 已经是启动状态，这一步直接返回 true）
2. **allocateIface(IFACE_TYPE_P2P)**：在 WifiNative 内部分配一个接口槽位——这只是 Java 侧的记账，HAL 还没有真正创建接口
3. **createP2pIfaceFromHalOrGetNameFromProperty()**：走到这一层，才真正接触 HAL——调用 `HalDeviceManager.createP2pIface()`，后者通过 HIDL/AIDL 调用到 HAL 实现层，最终让 WiFi 芯片创建一个新的虚拟接口 `p2p0`

如果不用这种方案——比如不先 allocateIface，而是直接调 HAL——会出现一个问题：接口创建成功后，WifiNative 不知道 id → name 的映射关系（HAL 只返回 name），后续要通知"接口销毁"时就找不到对应的槽位了。

## 4.5 AIDL ISupplicantP2pIface 的就绪

HAL 创建完 p2p0 后，下一步是在 wpa_supplicant daemon 中建立对应的 P2P iface 控制通道：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/SupplicantP2pIfaceHalAidlImpl.java:215
public boolean setupIface(@NonNull String ifaceName) {
    synchronized (mLock) {
        if (mISupplicantP2pIface != null) {
            return false;  // P2P iface 已存在
        }
        ISupplicantP2pIface iface = addIface(ifaceName);
        if (iface == null) {
            Log.e(TAG, "Unable to add iface " + ifaceName);
            return false;
        }
        mISupplicantP2pIface = iface;

        if (mMonitor != null) {
            ISupplicantP2pIfaceCallback callback =
                    new SupplicantP2pIfaceCallbackAidlImpl(ifaceName, mMonitor,
                            getCachedServiceVersion());
            if (!registerCallback(callback)) {
                Log.e(TAG, "Unable to register callback for iface " + ifaceName);
                return false;
            }
            mCallback = callback;
        }
        return true;
    }
}
```

`addIface()` 内部调用 `mISupplicant.addP2pInterface(ifaceName)`——这是从 Java 通过 AIDL 跨进程调用到 `wpa_supplicant` daemon 的 `ISupplicant` AIDL 服务。wpa_supplicant 内部会在 `p2p0` 接口上初始化 P2P 控制通道，返回一个 `ISupplicantP2pIface` 的 Binder 代理对象。

**callback 注册**：`registerCallback()` 在 supplicant 侧注册一个事件回调——后续 supplicant 上发生的 P2P 事件（设备发现、GO 协商、组创建等）都会通过这个 callback 反向通知到 Java 层。事件的传递路径是：

```
wpa_supplicant 事件 → ISupplicantP2pIfaceCallback (AIDL) → WifiP2pMonitor → P2pStateMachine Handler
```

## 4.6 内核侧 p2p0 网络设备的创建

Android Framework 层调用 `HalDeviceManager.createP2pIface()` 后，HAL 层通过 HIDL/AIDL 调用到 HAL 实现（`android.hardware.wifi@1.x` 或 AIDL），HAL 实现内部再通过 nl80211 netlink 协议向内核发送 `NL80211_CMD_NEW_INTERFACE` 命令。cfg80211 子系统收到后，调用驱动的 `add_virtual_intf` 回调，驱动在 WiFi 芯片上创建一个虚拟接口，内核注册对应的 netdev（`p2p0`），并向用户态上报 RTM_NEWLINK 事件。

整个链路可简化为：

```
WifiNative.createP2pIface()
  → HalDeviceManager.createP2pIface()
    → IWifiChip.createP2pIface()          // HIDL/AIDL
      → wifi_chip.cpp:createP2pIface()
        → nl80211 NL80211_CMD_NEW_INTERFACE
          → cfg80211 add_virtual_intf()
            → 驱动创建 p2p0 netdev
```

具体到 QCOM 的 qcacld-3.0，P2P 组件的总开关不在 cfg80211 的回调里，而在更早的 psoc 使能阶段。驱动加载时 `hdd_component_psoc_enable()`（`wlan_hdd_main.c:17803`）统一拉起各 UMAC 组件，其中 P2P 走 `p2p_psoc_enable()`（`wlan_cfg80211_p2p.c:321`）。

它把三个回调塞进 `p2p_start_param`：管理帧接收 `wlan_p2p_rx_callback`、P2P 事件 `wlan_p2p_event_callback`、Action 帧发送确认 `wlan_p2p_action_tx_cnf_callback`，再经 `ucfg_p2p_psoc_start()` 落到 `p2p_psoc_start()`（`wlan_p2p_main.c:813`）。后者把 LO/NOA 事件处理器、扫描请求方（`wlan_scan_register_requester`）和管理帧 RX action 处理器（`p2p_mgmt_rx_action_ops`）全部挂到 psoc 上。

这层注册完成后，P2P 组件才算在内核侧"通电"，后续的 `add_virtual_intf` 只是把这个已就绪的组件对应的 vdev 实体化。

MTK 的入口则藏在 P2P 设备 FSM 里：supplicant 触发 netdev 注册事件后，`p2pFsmRunEventNetDeviceRegister()`（`p2p_fsm.c:205`）调用 `p2pLaunch()`（`gl_p2p_init.c:185`），后者把 `rP2PRegState` 置为 `REGISTERING` 后进入 `glRegisterP2P()`（`gl_p2p.c:1112`）。

`glRegisterP2P()` 按运行模式决定注册几个 P2P 设备（`KAL_P2P_NUM`），逐个 `alloc_netdev_mq()` 分配 net_device，`glSetupP2P()` 拉设备 FSM（`p2pDevFsmInit`，`gl_p2p.c:1019`）。最后由 `p2pNetRegister()`（`gl_p2p.c:655`）经 `cfg80211_register_netdevice()`（`gl_p2p.c:718`）把 p2p0 挂进内核。

QCOM 在 psoc 使能时一次性点亮组件，MTK 则在 FSM 事件驱动下按需拉起——两条路径入口不同，但都落在 cfg80211 的 netdev 注册上。

## 4.7 setMacRandomization：两个 MAC 地址的不同角色

在 `setupInterfaceFeatures()` 中，如果设备支持 P2P MAC 随机化，会设置：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:3015
private void setupInterfaceFeatures() {
    if (mWifiGlobals.isP2pMacRandomizationSupported()) {
        mWifiNative.setMacRandomization(true);
    } else {
        mWifiNative.setMacRandomization(false);
    }
}
```

这里触发的是 P2P **接口** MAC 随机化——不要和 P2P **设备** MAC 地址混淆。

- **p2p_device_random_mac_addr**（P2P **设备**的 MAC）：
  - **作用**：P2P 设备的身份 MAC，在 Probe Request/Response 帧的 P2P IE 中宣告，用于设备识别
  - **生成机制**：初始化时由 `wpas_p2p_mac_setup()`（`p2p_supplicant.c:4926`）处理——mode 1 下 wpa_supplicant 调用 `random_mac_addr()` 生成随机地址覆盖驱动默认值，mode 2 下沿用驱动默认的随机 MAC（走 NL80211_ATTR_MAC 路径）
  - **持久化**：一旦存在持久组（Persistent Group），必须恢复上次记录的 `p2p_device_persistent_mac_addr`——否则 reinvoke 持久组时对端认不出这个设备
- **p2p_interface_random_mac_addr**（P2P **组接口**的 MAC）：
  - **作用**：组创建时建立的 GO/Client 数据面 netdev 的 MAC（在 Android 上可能复用 p2p0，也可能由驱动另建 p2p-wlanX-Y），用于实际的数据帧收发
  - **生成机制**：每次组创建由 wpa_supplicant 在用户态调用 `random_mac_addr()` 生成（`wpas_p2p_add_group_interface()`，`p2p_supplicant.c:2283`），再经 `wpa_drv_set_mac_addr()`（`driver_i.h:748`）下发给驱动
  - **与设备 MAC 的联动**：§4.1 里 `setupInterfaceFeatures()` 调用的 `mWifiNative.setMacRandomization(true)` 通过 AIDL `ISupplicantP2pIface.setMacRandomization(enable)`（`p2p_iface.cpp:1808`）设置的同时，把设备 MAC 与接口 MAC 两个开关一并置位（`p2p_device_random_mac_addr` 与 `p2p_interface_random_mac_addr` 同时置 1），并触发 `wpas_p2p_mac_setup()`

为什么不统一成一个开关？因为两者的稳定性需求正好相反。设备 MAC 是"相亲角里挂的牌子"——别人通过这个 MAC 认识你，它必须在一个会话、甚至跨会话的持久组里保持稳定，否则对端无法把 Probe 帧和已知设备关联起来，持久组也没法凭 MAC 恢复连接；所以它才有"生成一次、持久组期间锁定、必要时恢复上次地址"的复杂生命周期。

接口 MAC 的需求则正好反过来。它是"实际走路用的脚"——数据包通过这个 MAC 收发，它只在本组的数据链路上有意义，每次组创建都换一双新鞋反而更利于隐私。把两者统一成一个随机化策略，要么牺牲设备身份的稳定性（持久组无法 reinvoke），要么丧失每组独立随机带来的隐私收益。设备 MAC 不直接出现在以太网帧中，它是 P2P IE 里的一个属性字段。

## 4.8 P2pStateMachine 的 mWifiNative 是谁：WifiNative 与 WifiP2pNative 的分工

读者可能会注意到一个容易混淆的细节：P2pStateMachine 里调用的是 `mWifiNative.setupInterface()`，而前面分析的五步流程都在 `WifiP2pNative.setupInterface()` 中。这两个是不是两个方法？

答案是：**只有一个方法**。P2pStateMachine 里的 `mWifiNative` 字段类型其实是 `WifiP2pNative`，而不是 `WifiNative`：

```java
// WifiP2pServiceImpl.java:251
private final WifiP2pNative mWifiNative;
```

所以 `mWifiNative.setupInterface()` 调用的就是 `WifiP2pNative.setupInterface()`。WifiNative 本身并没有 `setupInterface()` 方法——它只有 `setupInterfaceForClientInScanMode()`（STA）、`setupInterfaceForSoftApMode()`（SAP）这样的模式专用方法。P2P 的接口创建走的是 WifiP2pNative 这条专用路径。

真实的分工是：

- **WifiP2pNative**（位于 `WifiP2pNative.java`）：P2P 专用的底层封装。它持有 `mSupplicantP2pIfaceHal`（Supplicant 通信通道）、`mWifiNative`（对 WifiNative 的引用），负责 P2P 特有的五步初始化
- **WifiNative**（位于 `WifiNative.java`）：所有 WiFi 模式（STA、P2P、SAP、Nan）的共享底层，管理 HAL 的生命周期（startHal/stopHal）、接口槽位分配（IfaceManager）。WifiP2pNative 需要创建接口时，调用它的 `createP2pIface()`

把这两个类各自持有的字段和暴露的方法摆在一起看，分工边界会更清晰：

![WifiP2pNative 与 WifiNative 的类职责分工](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-class-split.svg)

调用关系是：

```
P2pStateMachine.P2pDisabledState.setupInterface()
  → mWifiNative.setupInterface(callback, handler, requestorWs)   // mWifiNative 就是 WifiP2pNative
    → mWifiNative.createP2pIface(...)       // WifiP2pNative 内部持有 WifiNative 引用，创建接口
    → waitForSupplicantConnection()          // P2P 专用逻辑
    → mSupplicantP2pIfaceHal.setupIface()    // P2P 专用逻辑
```

如果你在犹豫"为什么不直接在 P2pStateMachine 里持有 WifiNative"——因为 P2P 特有的逻辑（supplicant 连接、P2P iface 注册、死亡回调）不应该污染通用的 WifiNative。WifiP2pNative 是"P2P 专属的翻译层"：它把 P2P 状态机的意图转译成对通用 WifiNative 的调用，同时处理 supplicant 相关的 P2P 特有细节。如果这些逻辑全部塞进 WifiNative，WifiNative 会变成一个万能类——既要管 STA、又要管 P2P、还要管 SAP，违反单一职责。

这种分工在 STA 侧有一个鲜明的对照：WifiNative 自己就直接持有 `SupplicantStaIfaceHal`（`WifiNative.java:128`）——因为 STA 是 WifiNative 的主业，STA 的 supplicant 交互本就该归它管。

而 P2P 的 supplicant iface（`ISupplicantP2pIface`）是另一套独立的 HIDL/AIDL 接口类型，生命周期与 P2P 状态机绑定，所以单独由 WifiP2pNative 持有 `mSupplicantP2pIfaceHal`（`WifiP2pNative.java:63`），WifiNative 只在创建 HAL 接口时被引用（`mWifiNative` 字段，行 64）。把 P2P 的 supplicant 状态塞进 WifiNative，会让一个被 STA/SAP/P2P/NAN 共享的类背上 P2P 专用状态——任何模式切换都要过问 P2P 的私有数据，这正是分层要避免的耦合。

## 4.9 WifiP2pMonitor：消息分发中枢

相亲角的"接待员"到位了。WifiP2pMonitor 的职责是接收来自 wpa_supplicant 的事件回调，并将它们路由到正确的 Handler。

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pMonitor.java:155
public synchronized void startMonitoring(String iface) {
    setMonitoring(iface, true);
    broadcastSupplicantConnectionEvent(iface);
}

public void broadcastSupplicantConnectionEvent(String iface) {
    sendMessage(iface, SUP_CONNECTION_EVENT);
}
```

`startMonitoring()` 做了两件事：设置监控标志位（让后续事件可以被分发），然后立即广播一个 `SUP_CONNECTION_EVENT`。这个事件告诉状态机"supplicant 连接已建立"。

WifiP2pMonitor 内部维护了一个 `Map<String, SparseArray<Set<Handler>>>`——这是一个三层嵌套的数据结构：

- 第一层 Key：接口名（如 "p2p0"），因为一台设备可能有多个 WiFi 接口
- 第二层 Key：事件类型（如 SUP_CONNECTION_EVENT、P2P_DEVICE_FOUND_EVENT）
- 第三层 Value：注册了该事件的 Handler 集合

当 supplicant 回调（通过 AIDL callback）到达时，WifiP2pMonitor 查找对应的接口 → 事件类型 → 向所有注册的 Handler 发送 Message。在初始化阶段，唯一注册的 Handler 就是 P2pStateMachine 的 Handler。

从事件源到状态机的这条路由链，用一张图串起来看更直观——注意右侧 `stopMonitoring()` 之后事件被丢弃的边界：

![supplicant 事件到状态机的路由分发](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-event-routing.svg)

P2pStateMachine 在 `registerForWifiMonitorEvents()` 中注册了包括 P2P_DEVICE_FOUND、P2P_GO_NEGOTIATION_REQUEST、P2P_GROUP_STARTED 等几乎所有 P2P 事件——共 23 个事件类型。换句话说，初始化完成后，supplicant 上报的任何 P2P 事件都会被路由到 P2pStateMachine 处理。

注册代码的每个注册调用都使用同一个 Handler（`getHandler()`），这意味着所有 23 种事件都会投递到 P2pStateMachine 的消息队列中。在 Android StateMachine 框架中，消息被串行处理——同一时间只有一条消息在 `processMessage` 中执行。这种单线程模型消除了并发控制的需求，但也意味着如果一个消息的处理耗时过长（比如在初始化阶段同步等待 HAL），后续消息会被阻塞。

**SUP_CONNECTION_EVENT 的同步发送**。`startMonitoring()` 在注册完 handler 和启动监控之后，立即同步发送了一个 `SUP_CONNECTION_EVENT`。但这个事件到达 DefaultState 时，被当作已处理（break）——因为在更早的 `setupInterface()` 中，supplicant 的连接状态已经是确定的。这个事件的主要意义不在初始化阶段，而在后续运行中：当 supplicant 重启重连后，这个事件会触发状态机重新评估是否需要恢复到 P2pEnabledState。

**监控状态切换**。`stopMonitoring()` 被调用后，`mMonitoringMap` 中对应该接口的标记被设为 false，后续所有发送给该接口的消息都会被丢弃（Drop）。这意味着当 P2P 被关闭时（DISABLE_P2P → teardown → stopMonitoring），即使 supplicant 还在产生事件（比如 P2P_DEVICE_LOST），这些事件也不会被投递到状态机——避免了"状态机已经退出 P2pEnabledState 但还在收 P2P 事件"的混乱。

---

# 5 挂牌营业：P2pEnabledState 与 initializeP2pSettings()？

> 相亲角的场地（p2p0 接口）和电话线（ISupplicantP2pIface）都接好了，管理处开始贴告示、摆桌椅——这就是 initializeP2pSettings() 在做的事。

当 `setupInterface()` 返回 true，P2pDisabledState 通过 `smTransition` 跳转到 `InactiveState`（或 `IdleState`）。由于 InactiveState 的父状态是 P2pEnabledState，状态机框架会先执行父状态的 `enterImpl()`，再执行子状态的 `enterImpl()`。

## 5.1 P2pEnabledState.enterImpl()

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:3222
@Override
public void enterImpl() {
    logSmStateName(this.getName(),
            getCurrentState() != null ? getCurrentState().getName() : "");

    if (isPendingFactoryReset()) {
        factoryReset(Process.SYSTEM_UID);
    }

    checkCoexUnsafeChannels();

    sendP2pConnectionChangedBroadcast();
    initializeP2pSettings();
    if (mTetheringManager != null) {
        mTetheringManager.registerTetheringEventCallback(getHandler()::post,
                mTetheringEventCallback);
    }
}
```

**进入 P2pEnabledState 时做的五件事**：

| 操作                                  | 作用                                          | 为什么在这里做                             |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------ |
| `factoryReset()`                      | 如果有待处理的出厂重置，执行清除所有 P2P 配置 | 重置必须在状态机运行时做，不能在关闭状态做 |
| `checkCoexUnsafeChannels()`           | 向 CoexManager 查询 LTE/WiFi 共存不安全信道   | 一旦启用 P2P，就需要知道哪些信道不能用     |
| `sendP2pConnectionChangedBroadcast()` | 发送 P2P 连接状态变化广播                     | App 需要知道 P2P 状态变了                  |
| `initializeP2pSettings()`             | 向 supplicant 下发 P2P 核心配置               | supplicant 需要这些参数才能正常工作        |
| `registerTetheringEventCallback()`    | 注册 Tethering 事件回调                       | Group Owner 模式依赖 Tethering             |

## 5.2 initializeP2pSettings()：向 supplicant 下发配置

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:7962
private void initializeP2pSettings() {
    mThisDevice.deviceName = getPersistedDeviceName();
    mThisDevice.primaryDeviceType = mContext.getResources().getString(
            R.string.config_wifi_p2p_device_type);

    mWifiNative.setDeviceName(mThisDevice.deviceName);
    // DIRECT-XY-DEVICENAME (XY is randomly generated)
    mWifiNative.setP2pSsidPostfix(generateP2pSsidPostfix(mThisDevice.deviceName));
    mWifiNative.setP2pDeviceType(mThisDevice.primaryDeviceType);
    // Supplicant defaults to using virtual display with display
    // which refers to a remote display. Use physical_display
    mWifiNative.setConfigMethods("virtual_push_button physical_display keypad");

    mThisDevice.deviceAddress = mWifiNative.p2pGetDeviceAddress();
    if (!mWifiGlobals.isP2pMacRandomizationSupported()) {
        mSettingsConfigStore.put(WIFI_P2P_DEVICE_ADDRESS, mThisDevice.deviceAddress);
    }
    updateThisDevice(WifiP2pDevice.AVAILABLE);
    mWifiNative.p2pFlush();
    mWifiNative.p2pServiceFlush();
    mServiceTransactionId = 0;
    mServiceDiscReqId = null;

    if (null != mThisDevice.wfdInfo) {
        setWfdInfo(mThisDevice.wfdInfo);
    }

    updatePersistentNetworks(RELOAD);

    configureEapolIpAddressAllocationParamsIfEnabled();

    enableVerboseLogging(mSettingsConfigStore.get(WIFI_VERBOSE_LOGGING_ENABLED));
}
```

**逐条解读**：

| 配置项         | 下发方法                    | 走到 supplicant 的路径                                       | 含义                                                         |
| -------------- | --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| device_name    | `setDeviceName(String)`     | AIDL → `ISupplicantP2pIface.setWpsDeviceName(String)`        | P2P 设备名称，显示给其他设备看，如 "Android_XY"              |
| ssid_postfix   | `setP2pSsidPostfix(String)` | AIDL → `ISupplicantP2pIface.setSsidPostfix(String)`          | P2P 组 SSID 后缀，如 `DIRECT-XY-DEVICENAME`                  |
| device_type    | `setP2pDeviceType(String)`  | AIDL → `ISupplicantP2pIface.setWpsDeviceType(byte[8])`       | WPS 设备类型，如 `10-0050F204-5`（手机）。字符串先按 `^(\d{1,2})-([0-9a-fA-F]{8})-(\d{1,2})$` 正则拆成 category+OUI+subcategory，编码为 8 字节大端数组再下发 |
| config_methods | `setConfigMethods(String)`  | AIDL → `ISupplicantP2pIface.setWpsConfigMethods(short)`      | 支持的 WPS 配置方法：virtual_push_button、physical_display、keypad。字符串按空格拆分后逐项映射为 16 位 bitmask（如 virtual_push_button→VIRT_PUSHBUTTON）累加为 short |
| device_address | `p2pGetDeviceAddress()`     | AIDL → `ISupplicantP2pIface.getDeviceAddress()` → `byte[6]` → `NativeUtil.macAddressFromByteArray` → String | P2P 设备的 MAC 地址（仅在未启用 MAC 随机化时持久化到 Settings 以便重启后复用） |

把表格里的每一行映射成一条"Framework 方法 → supplicant AIDL 接口"的下发链路，可以看到 write 类的蓝色箭头与 read 类的绿色箭头泾渭分明：

![P2P 配置下发 supplicant（initializeP2pSettings）](assets/11a-P2P%EF%BC%88%E4%B8%80%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8A%EF%BC%89%E2%80%94%E2%80%94Framework-%E5%B1%82%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E-HAL-%E6%8E%A5%E5%8F%A3%E5%88%9B%E5%BB%BA/11a-config-flush.svg)

**config_methods 为什么写 `physical_display` 而不是默认的 `virtual_display`**：代码注释说得清楚——supplicant 默认使用 virtual_display，它引用的是远程显示器。而 Android 设备通常自带屏幕，应该用 physical_display（物理显示器），表示 PIN 码显示在自己的屏幕上。

**config_methods 各选项的含义**（这些方法决定了两台 P2P 设备"互相对暗号"的方式）：

- `virtual_push_button`：虚拟按键——用户在双方设备上各点一个按钮，两分钟内完成配对。最常用
- `physical_display`：物理显示器——PIN 码显示在本机屏幕上，对方输入这个 PIN 码
- `keypad`：键盘输入——用户手动在对方设备上输入 PIN 码（本机充当 PIN 输入器）

这三个选项的组合意味着：这台 Android 设备既支持按钮配对（不需要输入 PIN），也支持 PIN 显示（把 PIN 码给别人看），还支持 PIN 输入（手动输入对方的 PIN）。这是一个非常"慷慨"的配置——几乎兼容所有对端设备的 WPS 配置方法。

**p2pFlush() 和 p2pServiceFlush()**：清空 supplicant 中残留的 P2P 对端列表和服务发现缓存。这是一个卫生操作——确保上次 P2P 会话的残留数据不会污染新会话。如果不做 flush，可能会出现"上次 Session 发现的设备还在列表里"的诡异现象。

**SSID 后缀的生成**：`generateP2pSsidPostfix()` 本身不产生任何随机字符——它返回一个以 "-" 开头的字符串：设备名本身（如 `-Android_XY`）。设备名按 UTF-8 编码超过 22 字节（`GROUP_NAME_POSTFIX_LENGTH_MAX`）时在字符边界截断，保证 SSID 总长不越界。

SSID 里那个随机前缀 `DIRECT-XX` 是 wpa_supplicant 侧生成的：`p2p_build_ssid()`（p2p.c）先拷贝通配 SSID 前缀 `"DIRECT-"`（`P2P_WILDCARD_SSID`），再用 `p2p_random()` 生成两个随机字符填入，最后才拼接这里下发的 postfix。所以最终组 SSID 的格式是 `DIRECT-XX-Android_XY`——XX 是 supplicant 每次组创建时新掷的随机字符，`-Android_XY` 是本函数生成的 postfix。

这个随机两字符前缀的设计是为了避免 SSID 冲突——当两台设备使用相同的设备名（比如都是默认的 "Android_XY"）时，supplicant 每次组创建都会重新掷一次随机前缀，降低了 SSID 碰撞的概率。在 P2P Group Formation 阶段，Group Owner 会广播这个 SSID，Client 通过 SSID 来发现和连接。如果 SSID 相同，多个设备可能误连到错误的 GO。

**p2pGetDeviceAddress()**：调用 `mWifiNative.p2pGetDeviceAddress()` 从 supplicant 获取 P2P 设备 MAC 地址（不是 p2p0 接口的 MAC）。这个 MAC 是 supplicant 在 P2P 初始化时从 p2p0 接口读取的，或者在启用 MAC 随机化时由 supplicant 自行生成。

**updatePersistentNetworks(RELOAD)**：重新加载持久化 P2P 组配置。`RELOAD` 表示强制从 supplicant 重新读取持久化网络列表，确保 Framework 和 supplicant 的数据一致。持久化组（Persistent Group）是 P2P 的一个重要特性——创建过一次的 P2P 组可以保存下来，下次两台设备靠近时自动重连，不需要重新协商 GO 角色和输入 PIN 码。

代码块末尾还有两个收尾操作。`configureEapolIpAddressAllocationParamsIfEnabled()` 是 Android 为 GO 模式准备的一个优化：如果系统资源中启用了 `config_wifiP2pGoIpAddressAllocationInEapolFrames`，它会把预配置的 IP 地址范围通过 `mWifiNative.configureEapolIpAddressAllocationParams()` 下发给 supplicant，让 Group Owner 直接在 EAPOL 帧里分配 IP 地址，省去 DHCP 往返——如果资源未启用则直接返回。`enableVerboseLogging()` 则把系统 Settings 中的 verbose 日志开关同步给 supplicant，方便排查时打开详细日志。

## 5.3 DefaultState：消息分发的"前台接待"

在 P2pStateMachine 中，DefaultState 有一个常被低估的角色——它是消息路由的"总入口"。任何子状态 `NOT_HANDLED` 的消息最终都会冒泡到 DefaultState。看看 DefaultState 的 processMessageImpl 中对消息做了什么：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:2490
case WifiP2pMonitor.SUP_CONNECTION_EVENT:
case WifiP2pMonitor.SUP_DISCONNECTION_EVENT:
case WifiP2pMonitor.P2P_GROUP_REMOVED_EVENT:
case WifiP2pMonitor.P2P_DEVICE_FOUND_EVENT:
case WifiP2pMonitor.P2P_DEVICE_LOST_EVENT:
case WifiP2pMonitor.P2P_FIND_STOPPED_EVENT:
// ... 共 20+ 个事件类型 ...
    break;
```

这些事件在 DefaultState 中被标记为"已处理但什么都不做"（break）。这不是 bug——这是对"不在合适状态时收到的事件"的静默忽略。比如，当 P2P 还在关闭状态时（P2pDisabledState），supplicant 不会上报 P2P_DEVICE_FOUND_EVENT。但如果因为某种边缘情况收到了（比如 supplicant 回调延迟），DefaultState 会吞掉它，而不是让消息向上冒泡后无人处理导致警告日志。

设计意图是：DefaultState 知道所有消息类型的存在，它为"不适用的消息"提供了安全的丢弃通道。子状态只需要处理自己关心的消息，不关心的自然会落到 DefaultState 被静默丢弃。

## 5.4 InactiveState.enterImpl()：进入等待

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:3752
@Override
public void enterImpl() {
    logSmStateName(this.getName(),
            getCurrentState() != null ? getCurrentState().getName() : "");
    mPeerAuthorizingTimestamp.clear();
    mSavedPeerConfig.invalidate();
    mDetailedState = NetworkInfo.DetailedState.IDLE;
    scheduleIdleShutdown();
}
```

InactiveState 的 enter 做了四件事：

1. **清理授权时间戳**：清空 mPeerAuthorizingTimestamp（用于跟踪对端设备正在授权的时间窗口）
2. **失效已保存的配置**：`mSavedPeerConfig.invalidate()` 清空上次连接的对端设备地址
3. **设置网络状态为 IDLE**：表示当前无 P2P 网络活动
4. **启动空闲关闭定时器**：`scheduleIdleShutdown()` 设置一个定时器——如果 P2P 在配置的超时时间内没有任何活动（没有 App 发起 discover、connect 等操作），自动关闭 P2P 释放资源

如果你在担心"刚初始化完就触发空闲关闭怎么办"——定时器启动后，只要有任何来自 App 的 P2P 命令进入 InactiveState，就会在 `processMessageImpl()` 中调用 `scheduleIdleShutdown()` 重置定时器。只有真正没有任何 App 关心的"僵尸 P2P"才会被自动关闭。

---

# 6 挂牌通知：广播 WIFI_P2P_STATE_CHANGED_ACTION？

> 相亲角的一切都准备好了，该发通知了——"街坊邻居们，相亲角正式营业！"

## 6.1 广播的发送时机

WIFI_P2P_STATE_CHANGED_ACTION 广播不是在 P2pEnabledState.enter() 中直接发送的，而是有一个延迟判断机制：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:6612
public void checkAndSendP2pStateChangedBroadcast() {
    boolean wifiP2pAvailable = isWifiP2pAvailable();
    if (mLastP2pState != wifiP2pAvailable) {
        mLastP2pState = wifiP2pAvailable;
        sendP2pStateChangedBroadcast(mLastP2pState);
    }
}
```

`isWifiP2pAvailable()` 不只检查状态机状态，还综合考虑 WiFi 开关状态和管理员策略：WiFi 必须开启、管理员不能禁用 P2P（DISALLOW_WIFI_DIRECT），或者设备支持 D2D（不需要 STA 也能跑 P2P）。

这个广播还在另外几个时机被触发：WiFi 开/关时（P2pStateMachine 构造函数中注册的 WIFI_STATE_CHANGED_ACTION 广播接收器）、管理员策略变化时（UserRestrictions 监听器）。

## 6.2 广播的内容

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:6623
private void sendP2pStateChangedBroadcast(boolean enabled) {
    onP2pStateChanged(enabled ? WifiP2pManager.WIFI_P2P_STATE_ENABLED
            : WifiP2pManager.WIFI_P2P_STATE_DISABLED);
    final Intent intent = new Intent(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION);
    intent.addFlags(Intent.FLAG_RECEIVER_REGISTERED_ONLY_BEFORE_BOOT);
    if (enabled) {
        intent.putExtra(WifiP2pManager.EXTRA_WIFI_STATE,
                WifiP2pManager.WIFI_P2P_STATE_ENABLED);
    } else {
        intent.putExtra(WifiP2pManager.EXTRA_WIFI_STATE,
                WifiP2pManager.WIFI_P2P_STATE_DISABLED);
    }
    mContext.sendStickyBroadcastAsUser(intent, UserHandle.ALL);
}
```

**几个细节**：

- **Sticky Broadcast**：使用 `sendStickyBroadcastAsUser`，意味着新注册的 BroadcastReceiver 可以立即收到最近的广播——App 不需要在"启动时手动查询 P2P 状态"，注册一个 receiver 就行
- **FLAG_RECEIVER_REGISTERED_ONLY_BEFORE_BOOT**：防止第三方 App 在 manifest 中静态注册 receiver 拦截此广播——只有动态注册的 receiver 才能收到
- **UserHandle.ALL**：发送给所有用户空间（Android 多用户支持）

广播发出后，Settings、SystemUI 的 QuickSettings Tile、以及所有注册了 WifiP2pManager ActionListener 的 App 都能感知到 P2P 状态变化，开始准备自己的 P2P UI（如显示 P2P 开关状态、启用 P2P 相关按钮）。

---

# 7 等待第一个相亲者

相亲角全部准备就绪了。最后的落脚点是 **InactiveState**——一个"P2P 已启用但无事可做"的状态。让我们从三个层次总结当前系统所处的精确位置。

## 7.1 Framework 层现状

P2pStateMachine 状态：**InactiveState**（P2pEnabledState 的子状态）。这意味着：

- P2P 功能已向系统宣告可用（WIFI_P2P_STATE_CHANGED_ACTION 已广播）
- 设备信息已就绪（deviceName、deviceAddress、primaryDeviceType 已填充）
- 无进行中的连接或组创建操作（mSavedPeerConfig 已 invalidate、mDetailedState = IDLE）
- 空闲关闭定时器已在倒计时

P2pEnabledState 作为父状态提供了统一保护层：

- 如果 supplicant 断开（SUP_DISCONNECTION_EVENT），直接退回 P2pDisabledState
- 如果收到 WFD 信息设置请求，统一由父状态处理
- 如果收到 DISABLE_P2P，停止监控、teardown 接口、进入 P2pDisablingState 关闭流程

## 7.2 HAL 层现状

- p2p0 虚拟网络接口已创建，状态为 UP（netd 已将接口设为 running）
- ISupplicant P2P iface 的 AIDL Binder 代理对象（mISupplicantP2pIface）已持有，随时可以发起 P2P 命令
- Supplicant death handler 已注册——如果 wpa_supplicant 进程崩溃，状态机会收到通知并清理内部状态
- 23 个 WifiP2pMonitor 事件类型已注册，事件回调链路：wpa_supplicant → AIDL Callback → WifiP2pMonitor → P2pStateMachine Handler

## 7.3 此时的系统能力

此时 P2P 系统拥有以下能力：

- p2p0 接口已创建，状态为 UP
- wpa_supplicant 中 P2P iface 已注册，callback 已设置
- WifiP2pMonitor 正在监听 23 个事件类型（SUP_CONNECTION、P2P_DEVICE_FOUND、P2P_GO_NEGOTIATION_REQUEST 等）
- 设备信息（device_name、device_type、config_methods）已下发
- 持久化 P2P 组配置已加载
- WIFI_P2P_STATE_CHANGED_ACTION 广播已发送
- 空闲关闭定时器已启动（150 秒无活动自动关闭）

InactiveState 能响应的操作包括：

- `CONNECT`：连接一个设备（下一篇会详细追踪）
- `CREATE_GROUP`：创建一个 P2P 组
- `DISCOVER_PEERS`：开始搜索周边设备（下一篇会详细追踪）
- `START_LISTEN`：开始监听（等待被其他设备发现）

最后一点值得注意：InactiveState 和 IdleState 都是 P2pEnabledState 的子状态，都代表"P2P 启用但无活动"，但它们的区别不仅仅是 p2pOwnership feature flag。IdleState 被设计为 p2pOwnership 路径下的"初始就绪状态"，支持多 App 各自"拥有"独立的 P2P 连接。而 InactiveState 是传统单 App 路径下的等待状态。如果你的设备运行 Android 14+，大概率走的是 IdleState 路径——这也是为什么代码中初始化后有两种可能的目标状态。

---

# 8 总结

## 8.1 初始化全链路回顾

```none
SystemServer.startOtherServices()
  → WifiP2pServiceImpl 构造函数
    → P2pStateMachine 构造 + addState(20个状态) + setInitialState(P2pDisabledState) + start()

App 调用 WifiP2pManager API (如 discoverPeers)
  → WifiP2pServiceImpl.ClientHandler.handleMessage()
    → mP2pStateMachine.sendMessage()
      → onPreHandleMessage() → 登记 WorkSource (updateWorkSourceByUid)
      → P2pDisabledState.processMessageImpl() default 分支 → 检测 needsActiveP2p

P2pDisabledState.processMessageImpl(needsActiveP2p 命令)
  → InterfaceConflictManager.manageInterfaceConflictForStateMachine()
  → setupInterface()
    ├── WifiP2pNative.setupInterface()        // P2pStateMachine 的 mWifiNative 即 WifiP2pNative
    │   ├── WifiNative.createP2pIface()        // WifiP2pNative 内部持有 WifiNative 引用
    │   │   ├── startHal()
    │   │   ├── mIfaceMgr.allocateIface(IFACE_TYPE_P2P)
    │   │   └── HalDeviceManager.createP2pIface()
    │   │       → HIDL/AIDL IWifiChip.createP2pIface()
    │   │         → nl80211 NL80211_CMD_NEW_INTERFACE
    │   │           → cfg80211 → 驱动 → p2p0 netdev
    │   ├── waitForSupplicantConnection()
    │   ├── mSupplicantP2pIfaceHal.setupIface("p2p0")
    │   │   → AIDL ISupplicant.addP2pInterface("p2p0")
    │   │   → registerCallback(ISupplicantP2pIfaceCallback)
    │   └── registerDeathHandler()
    ├── mNetdWrapper.setInterfaceUp("p2p0")
    └── registerForWifiMonitorEvents() → startMonitoring("p2p0")

  → smTransition → InactiveState
    → P2pEnabledState.enterImpl()
      ├── factoryReset()  (if pending)
      ├── checkCoexUnsafeChannels()
      ├── sendP2pConnectionChangedBroadcast()
      ├── initializeP2pSettings()
      │   ├── setDeviceName()       → AIDL ISupplicantP2pIface
      │   ├── setP2pSsidPostfix()   → AIDL ISupplicantP2pIface
      │   ├── setP2pDeviceType()    → AIDL ISupplicantP2pIface
      │   ├── setConfigMethods()    → AIDL ISupplicantP2pIface
      │   ├── p2pGetDeviceAddress() → AIDL ISupplicantP2pIface
      │   ├── p2pFlush() / p2pServiceFlush()
      │   └── updatePersistentNetworks(RELOAD)
      └── checkAndSendP2pStateChangedBroadcast()
          → WIFI_P2P_STATE_CHANGED_ACTION (EXTRA_WIFI_STATE=ENABLED)
    → InactiveState.enterImpl()
      └── scheduleIdleShutdown()
```

## 8.2 设计亮点：值得注意的三个决策

回看整个初始化链路，有三个设计选择在架构层面值得单独提出来：

**第一，懒初始化（Lazy Initialization）**。P2P 不会在系统启动时自动激活。只有 App 真正需要 P2P 功能时（通过 WifiP2pManager API），状态机才从 P2pDisabledState 走向 P2pEnabledState。这节省了资源——大部分用户不会频繁使用 P2P，不需要让 supplicant 一直持有一个 P2P iface。

**第二，同步阻塞的初始化 + 异步运行**。`setupInterface()` 是同步的：它阻塞 P2pDisabledState 的消息处理循环直到 HAL 接口创建完成。但这个阻塞只在初始化时发生一次。初始化完成后，状态机进入 P2pEnabledState，后续所有 P2P 操作（搜索、连接、协商）都走异步消息模式。这种"初始化同步、运行异步"的设计避免了引入一个中间状态来"等待 HAL 就绪"。

**第三，Teardown 的对称性**。每一步创建操作都有对应的销毁操作：`createP2pIface` ↔ `removeP2pIface`、`setupIface` ↔ `teardownIface`、`registerDeathHandler` ↔ `deregisterDeathHandler`、`startMonitoring` ↔ `stopMonitoring`。在 `WifiP2pNative.setupInterface()` 中，任何一步失败都会调用 `teardownInterface()` 回滚已完成的操作——这种"全有或全无"的清理策略避免了部分初始化导致的资源泄漏。同样地，P2pDisablingState 会按反序执行所有这些 teardown，确保关闭时"从哪里开始就从哪里回到哪里"。

## 8.3 关键异常路径

完整的初始化链路包含多个可能失败的节点，每个节点都有对应的处理策略：

| 失败节点                           | 失败原因示例                                    | 处理策略                                          |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| P2P 不可用检查                     | WiFi 关闭 + 不支持 D2D                          | 直接 return false，不尝试创建接口                 |
| InterfaceConflictManager           | 用户拒绝关闭 STA                                | 设置设备状态为 UNAVAILABLE                        |
| HalDeviceManager.createP2pIface()  | 芯片接口资源耗尽                                | 区分"资源不够"和"HAL bug"两类，后者触发 bugreport |
| waitForSupplicantConnection()      | supplicant daemon 5 秒未就绪                    | teardownInterface() 回滚已创建的接口              |
| SupplicantP2pIfaceHal.setupIface() | supplicant AIDL 调用失败                        | teardownInterface() 回滚                          |
| registerDeathHandler()             | HIDL supplicant 不支持死亡通知                  | 兼容性降级，teardownInterface()                   |
| mNetdWrapper.setInterfaceUp()      | 系统网络服务异常                                | 捕获 IllegalStateException，不阻塞初始化          |
| registerForWifiMonitorEvents()     | 事件监听注册失败（void 无失败返回值，不可检测） | 设计容忍：P2P 仍可用，但事件不回传                |

## 8.4 相亲角开门了，但还没有人开始逛

至此，P2P 系统完成了从"完全关闭"到"就绪等待"的完整初始化。p2p0 接口创建好了，supplicant 连接建立了，设备信息配置好了，广播发出去了——相亲角正式挂牌营业。

但一个问题摆在眼前：相亲角的门虽然开了，周围还没有"相亲者"出现——用户还没有点击"搜索设备"，probe 帧还没有飞出去。下一篇，我们将追踪 `discoverPeers()` 的完整链路：从 Framework 层的发现路由，到 supplicant 的 Find 循环（Listen Phase 和 Scan Phase 交替进行），到社交信道的 probe 帧收发，看看两台设备是怎么互相"看见"的。

---

**源码仓库**：

- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- wpa_supplicant: [https://w1.fi/wpa_supplicant/](https://w1.fi/wpa_supplicant/)

**相关规范**：Wi-Fi Alliance, "Wi-Fi Direct Specification v2.0"
