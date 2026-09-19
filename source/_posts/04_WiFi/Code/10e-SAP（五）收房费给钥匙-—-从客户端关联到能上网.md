---
title: SAP（五）收房费给钥匙 — 从客户端关联到能上网
top: 1
related_posts: true
abbrlink: ddeb9e90
date: 2026-09-19 21:39:41
tags:
  - Android WiFi
  - SAP
categories:
  - WiFi
  - Code
---

> 你打开手机热点，朋友连上来，屏幕几乎同时亮起"已连接"，然后他的手机上弹出一条通知：网络已连接，可以上网了。从按下开关到朋友能刷视频，中间只隔了几百毫秒——但就在这瞬间，Android 在手机内部走完了一条从 `Tethering` 到 `IpServer` 再到 `DhcpServer` 的完整分房流程：热点接口被创建、一个私有网段被划出来、DHCP 服务在接口上监听、朋友的客户端拿到地址和网关，然后数据才被允许转发到上游。

---

# 本章导读

上回讲到《SAP（四）》：SAP 作为"老板"要处理共存（DBDC/MCC/SCC）、要管理驱动层状态机、还要在客户端离开时打扫房间。但有个环节被跳过了——客户端关联成功后，它连的只是一个加密的无线链路，它还没有 IP 地址，也就谈不上上网。民宿挂牌了（《SAP（一）》）、装修好了（《SAP（二）》）、客人入住办完手续（《SAP（三）》）、老板在管理前台和客房部（《SAP（四）》）——可客人到现在还没拿到房间钥匙。

<!--more-->

本篇就是那把钥匙。民宿的钥匙交给谁、怎么发、发多久、房间不够了怎么办，以及民宿的水电（上游网络）从一路切到另一路时由谁调度。沿用"开民宿"的比喻：`Tethering` 是总管家，`IpServer` 是前台主管，`DhcpServer` 是具体发钥匙的接待员。

读完本篇，你就能回答这些问题：

- 热点开起来之后，`Tethering` 是通过哪条回调链得知"可以开始分 IP 了"的？
- `IpServer` 的状态机只有 5 个顶层状态，但它如何决定给热点接口配哪个网段、谁来启动 DHCP？
- 发钥匙的接待员 `DhcpServer` 住在另一个进程（NetworkStack）里，`IpServer` 怎么跨进程把它叫醒？
- DHCP 四步曲（DISCOVER/OFFER/REQUEST/ACK）在服务端是怎么实现的——`DhcpLeaseRepository` 的地址池如何保证不冲突、租约过期怎么清理？
- 手机开热点时自己的 WiFi 客户端必然下线，上游切到蜂窝——`Tethering` 怎么选上游、怎么把 DNS 和转发规则下发给 netd？

源码基准：AOSP main（`packages/modules/Connectivity` 的 `Tethering` 模块 + `packages/modules/NetworkStack` 模块）

---

# 1 热点起来了，谁负责给客户端发 IP？

先看全景。数据包路径上，SAP 接口的 IP 服务是一条自上而下的链条：`Tethering`（总管家）→ `IpServer`（前台主管，每接口一个）→ `DhcpServer`（发钥匙的接待员，在 NetworkStack 进程）。启动方向如下：

![SAP IP 分配全链路](assets/10e-SAP%EF%BC%88%E4%BA%94%EF%BC%89%E6%94%B6%E6%88%BF%E8%B4%B9%E7%BB%99%E9%92%A5%E5%8C%99-%E2%80%94-%E4%BB%8E%E5%AE%A2%E6%88%B7%E7%AB%AF%E5%85%B3%E8%81%94%E5%88%B0%E8%83%BD%E4%B8%8A%E7%BD%91/10e-ip-allocation-flow.svg)

客户端关联上来后，它会主动广播 DHCPDISCOVER；AP 侧的 `DhcpServer` 响应。注意这里的方向：不是 AP 主动塞 IP 给客户端，而是客户端连上无线后自己发起 DHCP，AP 侧接待员应答。这条链路的触发源头，是"接口 ready"这个事实——在 Android 里由 `Tethering` 感知，而不是由 hostapd 直接驱动。

## 1.1 上篇终点：SoftAP 已启动，接口已 up

《SAP（一）》追踪到 `SoftApManager` 调用了 `startSoftAp()`，《SAP（二）》追踪到 hostapd 把 Beacon 推上空口。这些完成后，`WifiManager` 会向注册的 `SoftApCallback` 回调 `WIFI_AP_STATE_ENABLED`，并带上实际使用的接口名（如 `wlan1`）。`Tethering` 在启动时就注册了自己的回调，专门接收这个事件：

```java
// Tethering.java:1576
class StartTetheringSoftApCallback implements SoftApCallback {
    @Override
    public void onStateChanged(SoftApState softApState) {
        final int state = softApState.getState();
        final String iface = softApState.getIface();
        final TetheringRequest request = softApState.getTetheringRequest();
        switch (softApState.getState()) {
            case WifiManager.WIFI_AP_STATE_ENABLED:
                enableIpServing(request, iface);
                sendTetherResultAndRemoveOnError(request, mPendingListener,
                        TETHER_ERROR_NO_ERROR);
                mPendingListener = null;
                break;
            case WifiManager.WIFI_AP_STATE_FAILED:
                sendTetherResultAndRemoveOnError(request, mPendingListener,
                        TETHER_ERROR_INTERNAL_ERROR);
                mPendingListener = null;
                break;
            case WifiManager.WIFI_AP_STATE_DISABLED:
                disableWifiIpServing(iface, state);
                break;
            default:
                break;
        }
    }
}
```

- 收到 `WIFI_AP_STATE_ENABLED` 表示 hostapd 已经把接口切成 AP 模式、Beacon 在发射——此时才适合在这个接口上起 IP 服务。回调里拿到的 `iface`（接口名）和 `request`（当时启动热点的请求）是后续一切动作的输入
- 关键动作是 `enableIpServing(request, iface)`：进入 Tethering 自己的 IP 服务启动流程
- 若 SAP 启动失败（`WIFI_AP_STATE_FAILED`），则把错误码回传给调用者；若 SAP 中途被关（`WIFI_AP_STATE_DISABLED`），则 `disableWifiIpServing()` 收尾

挂牌开张（Beacon 发射）后，总管家收到"分店已开业"的通知，安排前台主管布置房间号（IP 网段）、让接待员上岗（启动 DHCP）。

## 1.2 enableIpServing：创建 IpServer + 激活服务

`enableIpServing()` 干两件事：先确保有一个 `IpServer` 存在，再向它发"开始服务"的请求：

```java
// Tethering.java:1690
private void enableIpServing(@NonNull TetheringRequest request, String ifname) {
    enableIpServing(request, ifname, false /* isNcm */);
}

private void enableIpServing(@NonNull TetheringRequest request, String ifname, boolean isNcm) {
    ensureIpServerStartedForType(ifname, request.getTetheringType(), isNcm);
    if (tetherInternal(request, ifname) != TETHER_ERROR_NO_ERROR) {
        Log.e(TAG, "unable start tethering on iface " + ifname);
    }
}
```

第一行 `ensureIpServerStartedForType()` 是"造前台"：如果这个接口还没有对应的 `IpServer`，就 new 一个并启动它的状态机。第二行 `tetherInternal()` 是"发工单"：让这个前台主管进入服务状态。先看造前台：

```java
// Tethering.java:3098
private void ensureIpServerStartedForType(final String iface, int interfaceType,
        boolean isNcm) {
    // If we have already started a TISM for this interface, skip.
    if (mTetherStates.containsKey(iface)) {
        mLog.log("active iface (" + iface + ") reported as added, ignoring");
        return;
    }

    mLog.i("adding IpServer for: " + iface);
    final TetherState tetherState = new TetherState(
            new IpServer(iface, mContext, mHandler, interfaceType, mLog, mNetd, mBpfCoordinator,
                    mRoutingCoordinator, new ControlCallback(), mConfig, mTetheringMetrics,
                    mDeps.makeIpServerDependencies()), isNcm);
    mTetherStates.put(iface, tetherState);
    tetherState.ipServer.start();
}
```

- `mTetherStates` 是 `ArrayMap<iface, TetherState>`，以接口名为 key 保证每个接口只有一个 `IpServer`——重复回调会被忽略
- `new IpServer(...)` 传入了一长串依赖：`mNetd`（netd 的 binder）、`mBpfCoordinator`（BPF 卸载转发）、`mRoutingCoordinator`（路由/前缀分配）、`mConfig`（Tethering 配置，含上游选择策略）
- `ipServer.start()` 启动状态机，初始停在 `InitialState`（对应"前台主管就位但还没开始服务"）

再发工单：

```java
// Tethering.java:1191
private int tetherInternal(@NonNull TetheringRequest request, String iface) {
    if (DBG) Log.d(TAG, "Tethering " + iface);
    TetherState tetherState = mTetherStates.get(iface);
    if (tetherState == null) {
        Log.e(TAG, "Tried to Tether an unknown iface: " + iface + ", ignoring");
        return TETHER_ERROR_UNKNOWN_IFACE;
    }
    // Ignore the error status of the interface.  If the interface is available,
    // the errors are referring to past tethering attempts anyway.
    if (tetherState.lastState != IpServer.STATE_AVAILABLE) {
        Log.e(TAG, "Tried to Tether an unavailable iface: " + iface + ", ignoring");
        return TETHER_ERROR_UNAVAIL_IFACE;
    }
    mRequestTracker.promoteRequestToServing(tetherState.ipServer, request);
    tetherState.ipServer.enable(request);
    ...
    return TETHER_ERROR_NO_ERROR;
}
```

- 前置校验：接口必须是"可用"（`STATE_AVAILABLE`），否则拒绝——防止在接口还没 ready 时强行服务
- `promoteRequestToServing()` 把启动请求从"待处理"提升为"正在服务"，这是 `RequestTracker` 的记账逻辑
- 最关键的一行：`ipServer.enable(request)`——向 `IpServer` 状态机发送 `CMD_TETHER_REQUESTED` 消息

`IpServer.enable()` 本身只是投递消息，状态转移发生在其内部线程：

```java
// IpServer.java:473
public void enable(@NonNull final TetheringRequest request) {
    sendMessage(CMD_TETHER_REQUESTED, 0, 0, request);
}
```

到这里，链条从 `Tethering`（总管家）交接到了 `IpServer`（前台主管）。`IpServer` 收到 `CMD_TETHER_REQUESTED` 后如何决定进入哪个服务状态、如何把 IP 服务和 DHCP 拉起来，是下一节的内容。

---

# 2 IpServer 状态机是怎么把 DHCP 拉起来的？

`IpServer` 是 Android 中 tethering 每个下游接口的"服务主管"。它管理一个接口的完整 IP 生命周期：IPv4 前缀选择、接口地址配置、DHCP 启动/停止、IPv6 RA、以及向 Tethering 上报状态。它本身是一个状态机，顶层有 5 个状态。

为什么这里要"每接口一个状态机"，而不是做一个单例统一管所有下游？看类注释就明白了——`IpServer` 的 javadoc 开宗明义写的是 "Provides the interface to IP-layer serving functionality for a **given network interface**"（`IpServer.java:117-118`），设计意图就是"一个接口配一个管家"。背后是 Tethering 能同时服务多个异构下游：WiFi 热点、USB、蓝牙、P2P 可以并行开着，`Tethering` 里 `mTetherStates` 以接口名为 key（`Tethering.java:253`），每加一个接口就 put 一项。各接口的 up/down、scope、DHCP 服务完全独立——WiFi 接口被拔掉（`CMD_INTERFACE_DOWN`）不该拖垮正在给蓝牙设备分 IP 的那个前台；若用单例，所有下游的 IP 生命周期就耦合在一个对象里，一个接口的状态转移会牵连其他接口。

所以状态机按接口粒度拆，每个 `IpServer` 自带独立的 `Handler` 线程和 DHCP 服务，互不阻塞。`Tethering` 还额外维护了一个 `mNotifyList`（`Tethering.java:1979`），专门保存"还挂着待清理状态"的 `IpServer`，保证接口从 `mTetherStates` 移除后、状态机被回收前有地方记录它——这从反面印证了"多个状态机并存"是常态，单例设计根本不需要这张清单。

## 2.1 状态机全景

构造函数里 `addAllStates` 注册了 5 个顶层状态，并用 `mServingMode` 对外暴露当前服务模式：

```java
// IpServer.java:386
mInitialState = new InitialState();
mLocalHotspotState = new LocalHotspotState();
mTetheredState = new TetheredState();
mUnavailableState = new UnavailableState();
mWaitingForRestartState = new WaitingForRestartState();
final ArrayList allStates = new ArrayList<StateInfo>();
allStates.add(new StateInfo(mInitialState, null));
allStates.add(new StateInfo(mLocalHotspotState, null));
allStates.add(new StateInfo(mTetheredState, null));
allStates.add(new StateInfo(mWaitingForRestartState, mTetheredState));
allStates.add(new StateInfo(mUnavailableState, null));
addAllStates(allStates);
```

对应关系（`getStateString()`，`IpServer.java:129`）：

| 服务模式常量        | 含义                                         | 触发                                                   |
| ------------------- | -------------------------------------------- | ------------------------------------------------------ |
| `STATE_AVAILABLE`   | 待命，可接受服务请求                         | 进入 `InitialState`                                    |
| `STATE_TETHERED`    | 全功能共享（有上游，客户端可上网）           | `TetheringRequest` 为全局 scope 时进入 `TetheredState` |
| `STATE_LOCAL_ONLY`  | 仅本机热点（无上游，客户端仅能访问热点自身） | scope 为 local 时进入 `LocalHotspotState`              |
| `STATE_UNAVAILABLE` | 接口已 down，不可用                          | 收到 `CMD_INTERFACE_DOWN`                              |

注意 `mWaitingForRestartState` 的父状态是 `mTetheredState`——它是 Tethered 的一个子状态，用于 DHCP 前缀冲突后等待重启的场景。

状态转移的入口在 `InitialState.processMessage()`。收到 `CMD_TETHER_REQUESTED` 时，根据请求的"连接范围"分叉：

```java
// IpServer.java:1096
case CMD_TETHER_REQUESTED:
    mLastError = TETHER_ERROR_NO_ERROR;
    mTetheringRequest = (TetheringRequest) message.obj;
    switch (mTetheringRequest.getConnectivityScope()) {
        case CONNECTIVITY_SCOPE_LOCAL:
            maybeConfigureStaticIp(mTetheringRequest);
            transitionTo(mLocalHotspotState);
            break;
        case CONNECTIVITY_SCOPE_GLOBAL:
            maybeConfigureStaticIp(mTetheringRequest);
            transitionTo(mTetheredState);
            break;
        default:
            mLog.e("Invalid tethering interface serving state specified.");
    }
    break;
case CMD_INTERFACE_DOWN:
    transitionTo(mUnavailableState);
    break;
```

- 普通用户开热点时，`Tethering` 构造的请求是全局 scope（`CONNECTIVITY_SCOPE_GLOBAL`）——即客户端不仅能访问热点，还能通过热点上网。所以走 `transitionTo(mTetheredState)`
- 本地热点（Local Only Hotspot）不带上游，scope 是 local，走 `LocalHotspotState`——它和 Tethered 共享同一个 `BaseServingState` 父类，只是 scope 不同
- `maybeConfigureStaticIp()` 先处理静态 IP 配置（如果用户配置了静态网段），覆盖默认网段

总管家发来"开始接待客人（全局模式）"的工单，前台主管就从"待命"切换到"营业中"。

## 2.2 BaseServingState.enter()：营业中要做的事

`TetheredState` 和 `LocalHotspotState` 都继承自 `BaseServingState`，真正的重活都在这两个状态的公共父类 `enter()` 里：

```java
// IpServer.java:1130
public void enter() {
    mBpfCoordinator.addIpServer(IpServer.this);
    startServingInterface();
    if (mLastError != TETHER_ERROR_NO_ERROR) {
        // 出错：发 CMD_SERVICE_FAILED_TO_START 回退
        ...
    }
    if (DBG) Log.d(TAG, getStateString(mDesiredInterfaceState) + " serve " + mIfaceName);
    sendInterfaceState(mDesiredInterfaceState);
}
```

`startServingInterface()` 是核心，它按顺序做四件事：

```java
// IpServer.java:1164
private void startServingInterface() {
    // (1) V+ 上可注册 TetheringNetworkAgent（把热点暴露给 ConnectivityService 作为本地网络）
    if (mSupportLocalAgent && getScope() == CONNECTIVITY_SCOPE_GLOBAL) {
        mTetheringAgent = mDeps.makeNetworkAgent(...);
        mTetheringAgent.register();
    }

    // (2) 配置 IPv4：选网段、配接口地址、启动 DHCP
    if (!startIPv4(getScope())) {
        mLastError = TETHER_ERROR_IFACE_CFG_ERROR;
        return;
    }

    // (3) 告诉 netd "这个接口要参与转发"
    try {
        mNetd.tetherInterfaceAdd(mIfaceName);
        ...
    } catch (RemoteException | ServiceSpecificException | IllegalStateException e) {
        mLastError = TETHER_ERROR_TETHER_IFACE_ERROR;
        return;
    }

    // (4) 启动 IPv6：RA 广播 + DAD Proxy
    if (!startIPv6()) {
        mLog.e("Failed to startIPv6");
        return;
    }
}
```

- 第 (2) 步 `startIPv4()` 是我们这篇的主线——它内部会触发 `DhcpServer` 的创建（见 2.3）
- 第 (3) 步 `mNetd.tetherInterfaceAdd(mIfaceName)` 是给内核下命令：把这个接口标记为 tethering 下游，允许转发。这一步之后，接口才具备"把客户端流量转给上游"的资格
- 第 (4) 步 `startIPv6()`（`IpServer.java:791`）负责 IPv6 侧：先经 `mDeps.getInterfaceParams()` 拿到接口参数，再创建 `RouterAdvertisementDaemon` 并 `start()`，周期性广播 RA（Router Advertisement）让客户端用 SLAAC 自动生成地址；Android S 起还会创建 `DadProxy`（`mDeps.getDadProxy()`），替下游客户端转发邻居发现报文（NS/NA），且必须等 IPv6 上游就绪、拿到确定的上游接口后才开始转发——因为它的作用是把下游客户端做重复地址检测的 NS 探测转发到上游、再把上游的 NA 应答带回，这样客户端用 SLAAC 生成地址时能"看到"上游已占用的地址，避免选到与上游撞车的地址；上游还没就绪就转发，这套跨链路探测就没了着落。任一步失败就 `stopIPv6()` 回滚。SAP 的 IPv4 走 DHCP、IPv6 走 RA，双栈并行

## 2.3 startIPv4：从选网段到启动 DHCP

`startIPv4()` 一行调 `configureIPv4(true, scope)`。`configureIPv4` 是 IPv4 配置的总入口：

```java
// IpServer.java:719
private boolean configureIPv4(boolean enabled, int scope) {
    if (VDBG) Log.d(TAG, "configureIPv4(" + enabled + ")");
    if (enabled) {
        mIpv4Address = requestIpv4Address(scope, true /* useLastAddress */);
    }
    if (mIpv4Address == null) {
        mLog.e("No available ipv4 address");
        return false;
    }
    if (shouldNotConfigureBluetoothInterface()) {
        return configureDhcp(enabled, mIpv4Address, null /* clientAddress */);
    }
    final IpPrefix ipv4Prefix = asIpPrefix(mIpv4Address);
    ... // 省略：计算 setIfaceUp（WiFi 接口由 WiFi 栈管理 up/down，此处传 null）
    if (!mInterfaceCtrl.setInterfaceConfiguration(mIpv4Address, setIfaceUp)) {
        mLog.e("Error configuring interface");
        if (!enabled) stopDhcp();
        return false;
    }
    if (enabled) {
        mLinkProperties.addLinkAddress(mIpv4Address);
        mLinkProperties.addRoute(getDirectConnectedRoute(mIpv4Address));
    } else {
        ... // 省略：移除地址与直连路由
    }
    return configureDhcp(enabled, mIpv4Address, mStaticIpv4ClientAddr);
}
```

流程分三步：选地址 → 配接口 → 起 DHCP。

**第一步：选地址。** `requestIpv4Address(scope, true)` 决定 SAP 用哪个网段：

```java
// IpServer.java:776
private LinkAddress requestIpv4Address(final int scope, final boolean useLastAddress) {
    if (mStaticIpv4ServerAddr != null) return mStaticIpv4ServerAddr;

    if (shouldNotConfigureBluetoothInterface()) return new LinkAddress(BLUETOOTH_IFACE_ADDR);

    if (shouldUseWifiP2pDedicatedIp()) return new LinkAddress(LEGACY_WIFI_P2P_IFACE_ADDRESS);

    if (useLastAddress) {
        return mRoutingCoordinator.requestStickyDownstreamAddress(mInterfaceType, scope,
                mIpv4PrefixRequest);
    }

    return mRoutingCoordinator.requestDownstreamAddress(mIpv4PrefixRequest);
}
```

- 优先级：用户静态配置 > 蓝牙特例 > P2P 专用网段 > 动态分配
- 动态分配走 `mRoutingCoordinator.requestStickyDownstreamAddress()`——"sticky"（粘性）是关键：它尽量复用上次用过的网段，避免每次开热点都换一个前缀。想想看，如果每次开热点客户端都要重新 DHCP，体验会很差；粘性地址让"同一台手机开热点"总是给出一致的网段，客户端再次连接时更可能命中缓存

那为什么不用纯随机，而是"粘性优先"？看 `PrivateAddressCoordinator` 的实现就清楚了，它的类注释第一句就是 "This class coordinate IP addresses conflict problem"（`PrivateAddressCoordinator.java:59`）——这个协调器存在的目的不是"随机分配"，而是**避免下游网段和上游网络撞车**。sticky 的"复用"是有条件的：它按 `(interfaceType, scope)` 做成 `AddressKey` 缓存（`PrivateAddressCoordinator.java:221`），每次请求先查缓存；只有 `!isConflictWithUpstream(cachedAddress)`——即这个上次用过的网段跟当前上游（比如蜂窝数据分配到的网段）不冲突——才会真的复用（`PrivateAddressCoordinator.java:226`）。一旦发现缓存的网段已经和上游重叠，就立刻放弃粘性、改走随机。

随机也不是拍脑袋：`getRandomPrefixIndex`（`PrivateAddressCoordinator.java:267`）在 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 三个候选块里按权重挑，/8 占了约 93.7% 的概率，因为现实中大多数私有网段都在 10.x 大块里；`chooseDownstreamAddress`（`PrivateAddressCoordinator.java:305`）再避开 `.0/.1/.255` 和常见的 `192.168.0/24`、`192.168.1/24` 等网段，防止跟用户家里路由器的默认网段撞上。所以"粘性"真正的意思是：**能复用就复用（客户端体验），一旦与上游冲突就退回随机（正确性兜底）**，两种策略都不是为了"显得随机"，而是服务"别撞车"这个总目标。

- 默认 WiFi SAP 用的是一个私有 /24 网段（`PrivateAddressCoordinator.PREFIX_LENGTH = 24`，`PrivateAddressCoordinator.java:70`）——前缀长度是 24，网段本身在 `requestStickyDownstreamAddress` 里动态选，不是 `TetheringConfiguration` 里写死的一个固定地址；`TetheringConfiguration` 里的 `LEGACY_DHCP_DEFAULT_RANGE`（`TetheringConfiguration.java:76`）是旧版 dnsmasq 的遗产，新路径不走它

**第二步：配接口。** `mInterfaceCtrl.setInterfaceConfiguration(mIpv4Address, null)` 通过 netd 把地址写到热点接口上。对 WiFi 接口，up/down 状态由 WiFi 栈自己管（`setIfaceUp = null`），这里只设地址。

**第三步：起 DHCP。** 地址配好后，`configureDhcp(true, mIpv4Address, mStaticIpv4ClientAddr)` 走到 `startDhcp()`：

```java
// IpServer.java:654
private boolean startDhcp(final LinkAddress serverLinkAddr, final LinkAddress clientLinkAddr) {
    if (mUsingLegacyDhcp) {
        return true;
    }

    final Inet4Address addr = (Inet4Address) serverLinkAddr.getAddress();
    final Inet4Address clientAddr = clientLinkAddr == null ? null :
            (Inet4Address) clientLinkAddr.getAddress();

    final DhcpServingParamsParcel params = makeServingParams(addr /* defaultRouter */,
            addr /* dnsServer */, serverLinkAddr, clientAddr);
    mDhcpServerStartIndex++;
    mDeps.makeDhcpServer(
            mIfaceName, params, new DhcpServerCallbacksImpl(mDhcpServerStartIndex));
    return true;
}
```

- `makeServingParams()` 把"谁来当网关、谁当 DNS、租约多久"打包成 `DhcpServingParamsParcel`。注意网关和 DNS 都填的是热点接口自己的地址 `addr`——对客户端来说，默认网关就是热点手机，DNS 转发也由热点手机代理
- `DHCP_LEASE_TIME_SECS = 3600`（`IpServer.java:147`），租约 1 小时
- `mDhcpServerStartIndex` 是一个单调递增的序号，用于识别"过期的启动请求"（见 3.2 中 `onDhcpServerCreated` 里的比较）
- `mDeps.makeDhcpServer(ifName, params, cb)` 是依赖注入点——真正的实现在 `TetheringService` 里，这一步开始跨进程（下一节）

前台主管敲定楼层布局（网段）、钉好门牌（接口地址）后，通知接待员"上岗"——接待员在另一栋楼里上班（NetworkStack 进程），中间靠一条电话线（AIDL）联系。

---

# 3 DhcpServer 住在另一个进程，怎么叫醒它？

`mDeps.makeDhcpServer()` 看起来是本地方法调用，实际它跨了一个进程。`IpServer.Dependencies.makeDhcpServer` 的实现在 `TetheringService` 里（Tethering 进程），而 `DhcpServer` 本体在 NetworkStack 进程。

## 3.1 调用链

```
IpServer.startDhcp()
  → mDeps.makeDhcpServer(ifName, params, cb)         // IpServer.java:666，依赖注入
  → TetheringService.makeIpServerDependencies().makeDhcpServer()   // TetheringService.java:472
  → INetworkStackConnector.makeDhcpServer()          // AIDL 跨进程
  → NetworkStackService.NetworkStackConnector.makeDhcpServer()     // NetworkStackService.java:340
  → mDeps.makeDhcpServer(...) → new DhcpServer(...)  // NetworkStackService.java:170-172
```

`TetheringService` 里的实现——它并不真创建 DHCP 服务器，只是拿到 AIDL 连接器后把请求转发给 NetworkStack 进程：

```java
// TetheringService.java:469
public IpServer.Dependencies makeIpServerDependencies() {
    return new IpServer.Dependencies() {
        @Override
        public void makeDhcpServer(String ifName, DhcpServingParamsParcel params,
                DhcpServerCallbacks cb) {
            try {
                final INetworkStackConnector service = getNetworkStackConnector();
                if (service == null) return;

                service.makeDhcpServer(ifName, params, cb);
            } catch (RemoteException e) {
                Log.e(TAG, "Fail to make dhcp server");
                try {
                    cb.onDhcpServerCreated(STATUS_UNKNOWN_ERROR, null);
                } catch (RemoteException re) { }
            }
        }
    };
}
```

- `getNetworkStackConnector()` 会阻塞轮询等待 `NetworkStack.getService()` 返回 binder——最多等 60 秒。NetworkStack 是独立于 Tethering 的一个进程，专门承载 DHCP/网络监测等"协议实现"，通过 AIDL 接口 `INetworkStackConnector` 暴露能力

为什么 DHCP 协议实现要跨进程放进 NetworkStack，而不是直接写进 Tethering 进程？三个理由。其一，**mainline 模块边界**：NetworkStack 是独立的 mainline 应用模块（APK，`Android.bp` 里 `android_app { name: "NetworkStack" }`，`updatable: true`），进程名 `com.android.networkstack.process`（`AndroidManifest.xml:55`）——它作为 APK 可以脱离系统版本单独通过 Play 更新，DHCP 的 bug 修复不用等整机系统升级。

其二，**与 STA 侧共享同一套协议代码**：DHCP 客户端 `DhcpClient`（STA 用）和服务端 `DhcpServer`（AP 用）都在这个进程里，两者 import 的是同一个 `DhcpPacket` 解析器（`DhcpClient.java:19-23`）——同一台手机开热点时，一侧是"问问题的客人"、一侧是"查房本的接待员"，它们读同一份协议字典，解析行为天然一致，不会出现客户端和服务端对 RFC 2131 字段理解分歧。

其三，**进程隔离**：`DhcpServer` 要开 raw UDP socket（端口 67）接收任意来源的包，这是攻击面最大的地方（任何人都能往 67 端口发垃圾包，见 §4 开头的健壮性处理）。把它放进独立进程，崩溃或安全问题就被限制在 networkstack 进程里，不会拖垮负责转发规则下发的 Tethering 主进程。跨进程的代价就是这套 AIDL + 60 秒阻塞轮询 + binder 回调，但换来的是模块可独立升级、协议实现单一来源、风险面隔离。

- `service.makeDhcpServer(ifName, params, cb)` 是跨进程调用：把"接口名 + 服务参数 + 回调"传给 NetworkStack 进程
- 回调 `cb`（`DhcpServerCallbacks`）也是 binder 对象——NetworkStack 进程创建好 `DhcpServer` 后，通过它把 `IDhcpServer`（管理接口）传回 Tethering 进程

`NetworkStackService` 一侧的响应：

```java
// NetworkStackService.java:340
public void makeDhcpServer(@NonNull String ifName, @NonNull DhcpServingParamsParcel params,
        @NonNull IDhcpServerCallbacks cb) throws RemoteException {
    mPermChecker.enforceNetworkStackCallingPermission();
    updateNetworkStackAidlVersion(cb.getInterfaceVersion(), cb.getInterfaceHash());
    final DhcpServer server;
    try {
        server = mDeps.makeDhcpServer(
                mContext, ifName,
                DhcpServingParams.fromParcelableObject(params),
                mLog.forSubComponent(ifName + ".DHCP"));
    } catch (DhcpServingParams.InvalidParameterException e) {
        // 参数非法 → 回 INVALID_ARGUMENT
        cb.onDhcpServerCreated(STATUS_INVALID_ARGUMENT, null);
        return;
    } catch (Exception e) {
        // 其他异常 → 回 UNKNOWN_ERROR
        cb.onDhcpServerCreated(STATUS_UNKNOWN_ERROR, null);
        return;
    }
    cb.onDhcpServerCreated(STATUS_SUCCESS, server.makeConnector());
}

// NetworkStackService.java:170
public DhcpServer makeDhcpServer(@NonNull Context context, @NonNull String ifName,
        @NonNull DhcpServingParams params, @NonNull SharedLog log) {
    return new DhcpServer(context, ifName, params, log);
}
```

- `server.makeConnector()` 返回一个 `IDhcpServer.Stub`（`DhcpServerConnector`），作为 binder 对象传给回调
- `onDhcpServerCreated(STATUS_SUCCESS, connector)` 跨进程回到 Tethering 进程的 `DhcpServerCallbacksImpl`

## 3.2 IpServer 收到"接待员已上岗"后的处理

回到 Tethering 进程，`DhcpServerCallbacksImpl.onDhcpServerCreated()` 处理新拿到的 `IDhcpServer`：

```java
// IpServer.java:531
public void onDhcpServerCreated(int statusCode, IDhcpServer server) throws RemoteException {
    getHandler().post(() -> {
        // 过期的启动请求：主动停掉这个过时 server
        if (mStartIndex != mDhcpServerStartIndex) {
            try {
                server.stop(null);
            } catch (RemoteException e) { }
            return;
        }
        if (statusCode != STATUS_SUCCESS) {
            mLog.e("Error obtaining DHCP server: " + statusCode);
            handleError();
            return;
        }
        mDhcpServer = server;
        try {
            mDhcpServer.startWithCallbacks(new OnHandlerStatusCallback() {
                @Override
                public void callback(int startStatusCode) {
                    if (startStatusCode != STATUS_SUCCESS) {
                        mLog.e("Error starting DHCP server: " + startStatusCode);
                        handleError();
                    }
                }
            }, new DhcpEventCallback());
        } catch (RemoteException e) {
            throw new IllegalStateException(e);
        }
    });
}
```

- `getHandler().post(...)`：跨进程回调到达时不一定在 IpServer 自己的线程上，所以先投回 handler 线程再处理——避免竞态
- **序号防抖**：`mStartIndex != mDhcpServerStartIndex` 判断这次创建是否已被更新的请求取代。比如用户快速开关热点，前一次 `makeDhcpServer` 的回调晚到，此时序号已经变了，就停掉这个过时 server。这是处理异步竞态的一个典型手法
- 序号匹配后调用 `mDhcpServer.startWithCallbacks(statusCallback, dhcpEventCallback)`——正式让 DHCP 接待员开工，并注册租约变化回调 `DhcpEventCallback`
- `DhcpEventCallback.onLeasesChanged()` 把 NetworkStack 报上来的租约列表转成 `TetheredClient` 列表存到 `mDhcpLeases`
- 之后 `mCallback.dhcpLeasesChanged()` 把租约变化推给 Tethering——通知栏"已连接设备"的客户端列表就是从这里来的

## 3.3 DhcpServer 状态机：Stopped → Running

`DhcpServer` 本身也是一个状态机，2 个顶层状态 + 2 个子状态：

```
StoppedState（根）
StartedState（根）
  ├── RunningState              ← 正常工作，处理数据包
  └── WaitBeforeRetrievalState  ← 前缀冲突，等待新前缀
```

`startWithCallbacks` 最终发 `CMD_START_DHCP_SERVER`。`StoppedState` 处理它：

```java
// DhcpServer.java:410
class StoppedState extends State {
    @Override
    public boolean processMessage(Message msg) {
        switch (msg.what) {
            case CMD_START_DHCP_SERVER:
                final Pair<INetworkStackStatusCallback, IDhcpEventCallbacks> obj =
                        (Pair<INetworkStackStatusCallback, IDhcpEventCallbacks>) msg.obj;
                mStartedState.mOnStartCallback = obj.first;
                mEventCallbacks = obj.second;
                transitionTo(mRunningState);
                return HANDLED;
            case CMD_TERMINATE_AFTER_STOP:
                quit();
                return HANDLED;
            default:
                return NOT_HANDLED;
        }
    }
}
```

`transitionTo(mRunningState)` 会先进入 `RunningState` 的父状态 `StartedState`。`StartedState.enter()` 干重活：

```java
// DhcpServer.java:442
public void enter() {
    if (mPacketListener != null) {
        mLog.e("Starting DHCP server more than once is not supported.");
        maybeNotifyStatus(mOnStartCallback, STATUS_UNKNOWN_ERROR);
        mOnStartCallback = null;
        return;
    }
    mPacketListener = mDeps.makePacketListener(getHandler());

    if (!mPacketListener.start()) {
        mLog.e("Fail to start DHCP Packet Listener, rollback to StoppedState");
        deferMessage(obtainMessage(CMD_STOP_DHCP_SERVER, null));
        maybeNotifyStatus(mOnStartCallback, STATUS_UNKNOWN_ERROR);
        mOnStartCallback = null;
        return;
    }

    if (mEventCallbacks != null) {
        mLeaseRepo.addLeaseCallbacks(mEventCallbacks);
    }
    maybeNotifyStatus(mOnStartCallback, STATUS_SUCCESS);
    mOnStartCallback = null;
}
```

- `mPacketListener.start()` 创建 UDP socket 并开始监听——这是"接待员坐在前台开始等客人"的时刻
- 启动失败会 `deferMessage(CMD_STOP_DHCP_SERVER)` 回滚到 StoppedState
- 把 `mEventCallbacks` 注册到 `mLeaseRepo`（`DhcpLeaseRepository.addLeaseCallbacks`），这样每次租约变化都能通过 binder 推给 IpServer

socket 怎么建？看 `PacketListener.createFd()`：

```java
// DhcpServer.java:866
protected FileDescriptor createFd() {
    final int oldTag = TrafficStats.getAndSetThreadStatsTag(TAG_SYSTEM_DHCP_SERVER);
    try {
        mSocket = Os.socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, IPPROTO_UDP);
        SocketUtils.bindSocketToInterface(mSocket, mIfName);
        Os.setsockoptInt(mSocket, SOL_SOCKET, SO_REUSEADDR, 1);
        Os.setsockoptInt(mSocket, SOL_SOCKET, SO_BROADCAST, 1);
        Os.bind(mSocket, IPV4_ADDR_ANY, DHCP_SERVER);
        return mSocket;
    } catch (IOException | ErrnoException e) {
        mLog.e("Error creating UDP socket", e);
        return null;
    } finally {
        TrafficStats.setThreadStatsTag(oldTag);
    }
}
```

- UDP socket，`bind` 到 `DHCP_SERVER` 端口（67）——DHCP 服务端标准端口
- `bindSocketToInterface(mSocket, mIfName)` 把 socket 绑定到 SAP 接口，这样只收这个接口上的 DHCP 包，不会收到其他接口的广播
- `SO_BROADCAST` 允许发广播响应（客户端还没 IP 时，OFFER/ACK 可能要以广播形式发出）
- 收到包后 `onReceive()` 检查源端口：只处理来自 `DHCP_CLIENT`（68）的包，然后 `sendMessage(CMD_RECEIVE_PACKET, packet)` 交给状态机

接待员上岗后坐在前台（UDP:67），听到客人喊"有空房吗"就响应。客人喊话的窗口（端口 68）是固定的，接待员只听自己这栋楼（绑定接口）的喊声。

到这里，跨进程叫醒接待员的整条链路走完了：`DhcpServer` 在 NetworkStack 进程就位、监听打开、租约变化能推回 `IpServer`。接下来看客人真正上门时，接待员怎么查房态、发钥匙、处理房间不够和客人退房——DHCP 四步曲的服务端实现，是下一节的内容。

---

# 4 服务端怎么实现 DHCP 四步曲？

客户端连上无线后，会按 RFC 2131 的流程发起 DISCOVER → 收 OFFER → 发 REQUEST → 收 ACK。`DhcpServer` 的 `RunningState` 收到 `CMD_RECEIVE_PACKET` 后，先把包按类型分发：

```java
// DhcpServer.java:512
private void processPacket(@NonNull DhcpPacket packet) {
    mLog.log("Received packet of type " + packet.getClass().getSimpleName());

    final Inet4Address sid = packet.mServerIdentifier;
    if (sid != null && !sid.equals(mServingParams.serverAddr.getAddress())) {
        mLog.log("Packet ignored due to wrong server identifier: " + sid);
        return;
    }

    try {
        if (packet instanceof DhcpDiscoverPacket) {
            processDiscover((DhcpDiscoverPacket) packet);
        } else if (packet instanceof DhcpRequestPacket) {
            processRequest((DhcpRequestPacket) packet);
        } else if (packet instanceof DhcpReleasePacket) {
            processRelease((DhcpReleasePacket) packet);
        } else if (packet instanceof DhcpDeclinePacket) {
            processDecline((DhcpDeclinePacket) packet);
        } else {
            mLog.e("Unknown packet type: " + packet.getClass().getSimpleName());
        }
    } catch (MalformedPacketException e) {
        mLog.e("Ignored malformed packet: " + e.getMessage());
    }
}
```

- 第一道过滤是 Server Identifier：如果包里的 server id（option 54）存在且不是自己，直接丢弃——这是 DHCP 的"认领"机制，防止客户端在多个 DHCP 服务器间跳转时收到错误响应
- 四种包对应四个处理器：`processDiscover` / `processRequest` / `processRelease` / `processDecline`
- 解析异常（`MalformedPacketException`）只记日志不崩溃——攻击者可以向 UDP:67 发任意垃圾包，服务端必须健壮

如果只想弄清"四步曲怎么走通"，可以略过 4.1 的地址池实现直接看 4.2/4.3——地址池的分配细节不影响对 DISCOVER→OFFER→REQUEST→ACK 流程的理解。

## 4.1 地址池与租约仓库：DhcpLeaseRepository

四步曲的核心数据都落在 `DhcpLeaseRepository`（租约仓库）。它维护两张表：`mCommittedLeases`（已确认租约，`ArrayMap<IP, DhcpLease>`）和 `mDeclinedAddrs`（被 DECLINE 过的地址，带过期时间）。地址池的大小由前缀长度决定：

```java
// DhcpLeaseRepository.java:148
int subnetPrefixLength = mPrefixLength > leasesSubnetPrefixLength
        ? mPrefixLength : leasesSubnetPrefixLength;
mLeasesSubnetMask = prefixLengthToV4NetmaskIntHTH(subnetPrefixLength);
mLeasesSubnetAddr =
        inet4AddressToIntHTH((Inet4Address) prefix.getAddress()) & mLeasesSubnetMask;
mNumAddresses = clientAddr != null ? 1 : 1 << (IPV4_ADDR_BITS - subnetPrefixLength);
mLeaseTimeMs = leaseTimeMs;
```

- `mNumAddresses` 是可分配地址总数：/24 网段就是 256 个。若配了 `singleClientAddr`（固定客户端地址），则只分配 1 个
- 分配算法从 MAC 地址哈希出起点（`getFirstClientAddress`，模仿 dnsmasq 行为），然后线性探测下一个可用地址——这样同一台客户端多次 DISCOVER 大概率拿到同一地址，利于缓存命中
- `getValidAddress` 会跳过 `.0`、`.255` 和保留地址：`addrIndex == 0 || addrIndex == mNumAddresses - 1` 时强制跳到 1——一些老旧系统的网络栈处理不了广播地址和网络地址，DHCP 服务端主动避开

租约还有生命周期管理：`removeExpiredLeases()` 在每个分配操作前先清掉过期租约，把过期地址释放回池子。过期时间用 `mNextExpirationCheck` 做"最早到期时间"缓存，避免每次都要全表扫描。

## 4.2 DISCOVER → OFFER

客户端发 `DHCPDISCOVER`，`processDiscover` 决定给哪个地址：

```java
// DhcpServer.java:544
private void processDiscover(@NonNull DhcpDiscoverPacket packet)
        throws MalformedPacketException {
    final DhcpLease lease;
    final MacAddress clientMac = getMacAddr(packet);
    try {
        if (mDhcpRapidCommitEnabled && packet.mRapidCommit) {
            // 客户端要求 Rapid Commit（RFC 4039）：跳过 OFFER/REQUEST，直接 ACK
            lease = mLeaseRepo.getCommittedLease(packet.getExplicitClientIdOrNull(),
                    clientMac, packet.mRelayIp, packet.mHostName);
            transmitAck(packet, lease, clientMac);
        } else {
            // 标准流程：先给 OFFER
            lease = mLeaseRepo.getOffer(packet.getExplicitClientIdOrNull(), clientMac,
                    packet.mRelayIp, packet.mRequestedIp, packet.mHostName);
            transmitOffer(packet, lease, clientMac);
        }
    } catch (DhcpLeaseRepository.OutOfAddressesException e) {
        transmitNak(packet, "Out of addresses to offer");
    } catch (DhcpLeaseRepository.InvalidSubnetException e) {
        logIgnoredPacketInvalidSubnet(e);
    }
}
```

`getOffer` 的分配逻辑有三条优先级：

```java
// DhcpLeaseRepository.java:192
public DhcpLease getOffer(@Nullable byte[] clientId, @NonNull MacAddress hwAddr,
        @NonNull Inet4Address relayAddr, @Nullable Inet4Address reqAddr,
        @Nullable String hostname) throws OutOfAddressesException, InvalidSubnetException {
    final long currentTime = mClock.elapsedRealtime();
    final long expTime = currentTime + mLeaseTimeMs;

    removeExpiredLeases(currentTime);
    checkValidRelayAddr(relayAddr);

    final DhcpLease currentLease = findByClient(clientId, hwAddr);
    final DhcpLease newLease;
    if (currentLease != null) {
        // (1) 这客户端已有租约 → 续期，沿用原地址
        newLease = currentLease.renewedLease(expTime, hostname);
        mLog.log("Offering extended lease " + newLease);
    } else if (reqAddr != null && isValidAddress(reqAddr) && isAvailable(reqAddr)) {
        // (2) 客户端在 option 50 里指定了地址且可用 → 尊重它
        newLease = new DhcpLease(clientId, hwAddr, reqAddr, mPrefixLength, expTime, hostname);
        mLog.log("Offering requested lease " + newLease);
    } else {
        // (3) 否则从地址池哈希探测分配新地址
        newLease = makeNewOffer(clientId, hwAddr, expTime, hostname);
        mLog.log("Offering new generated lease " + newLease);
    }
    return newLease;
}
```

- 三条路：老客户续租 > 客户指定地址（且合法且空闲）> 池子里挑新地址
- 注意 OFFER 阶段**不提交**租约（注释明确说 "Do not update lease time in the map"）——接待员只是口头应下"这间房先给你留着"，但还没在房态表上落笔，地址仍可能被别人订走。真正的确认发生在 REQUEST 阶段
- `makeNewOffer` 内部从 MAC 哈希起点开始，逐个探测 `isAvailable(addr) && !mDeclinedAddrs.containsKey(addr)`，找到就返回；地址耗尽则抛出 `OutOfAddressesException`，`processDiscover` 捕获后回 NAK

## 4.3 REQUEST → ACK

客户端选定地址后发 `DHCPREQUEST`，`processRequest` 正式确认租约：

```java
// DhcpServer.java:565
private void processRequest(@NonNull DhcpRequestPacket packet)
        throws MalformedPacketException {
    // If set, packet SID matches with this server's ID as checked in processPacket().
    final boolean sidSet = packet.mServerIdentifier != null;
    final DhcpLease lease;
    final MacAddress clientMac = getMacAddr(packet);
    try {
        lease = mLeaseRepo.requestLease(packet.getExplicitClientIdOrNull(), clientMac,
                packet.mClientIp, packet.mRelayIp, packet.mRequestedIp, sidSet,
                packet.mHostName);
    } catch (DhcpLeaseRepository.InvalidAddressException e) {
        transmitNak(packet, "Invalid requested address");
        return;
    } catch (DhcpLeaseRepository.InvalidSubnetException e) {
        logIgnoredPacketInvalidSubnet(e);
        return;
    }

    transmitAck(packet, lease, clientMac);
}
```

`requestLease` 处理客户端所处的三种 DHCP 状态（SELECTING / INIT-REBOOT / RENEWING-REBINDING）：

```java
// DhcpLeaseRepository.java:281
public DhcpLease requestLease(@Nullable byte[] clientId, @NonNull MacAddress hwAddr,
        @NonNull Inet4Address clientAddr, @NonNull Inet4Address relayAddr,
        @Nullable Inet4Address reqAddr, boolean sidSet, @Nullable String hostname)
        throws InvalidAddressException, InvalidSubnetException {
    final long currentTime = mClock.elapsedRealtime();
    removeExpiredLeases(currentTime);
    checkValidRelayAddr(relayAddr);
    final DhcpLease assignedLease = findByClient(clientId, hwAddr);

    final Inet4Address leaseAddr = reqAddr != null ? reqAddr : clientAddr;
    if (assignedLease != null) {
        if (sidSet && reqAddr != null) {
            // SELECTING：客户端挑中了我们（带 server id），删掉旧租约换新地址
            removeLease(assignedLease.getNetAddr(), false /* notifyChange */);
        } else if (!assignedLease.getNetAddr().equals(leaseAddr)) {
            // RENEWING/REBINDING（无 server id）或 INIT-REBOOT（带 server id 的续租）：
            // 请求的地址必须和已有租约一致，否则报错
            throw new InvalidAddressException("Incorrect address for client in "
                    + (reqAddr != null ? "INIT-REBOOT" : "RENEWING/REBINDING"));
        }
    }
    final DhcpLease lease =
            checkClientAndMakeLease(clientId, hwAddr, leaseAddr, hostname, currentTime);
    mLog.logf("DHCPREQUEST assignedLease %s, reqAddr=%s, sidSet=%s: created/renewed lease %s",
            assignedLease, inet4AddrToString(reqAddr), sidSet, lease);
    return lease;
}
```

- `sidSet` 是区分状态的钥匙：REQUEST 里带 server id 说明客户端处于 SELECTING（它挑了我们），不带则是 RENEWING/REBINDING（它在续租）
- `checkClientAndMakeLease` 最终把租约写入 `mCommittedLeases` 并触发 `notifyLeasesChanged()`（推给 IpServer），这是**唯一真正把地址"定下来"的地方**：

```java
// DhcpLeaseRepository.java:353
private void commitLease(@NonNull DhcpLease lease) {
    mCommittedLeases.put(lease.getNetAddr(), lease);
    maybeUpdateEarliestExpiration(lease.getExpTime());
    notifyLeasesChanged();
}
```

确认后 `transmitAck` 构造 DHCPACK 报文发回客户端。响应发到哪，有一套规则（`getAckOrOfferDst`）：中继（giaddr）优先 > 广播标志 > 客户端已有地址（ciaddr）单播 > 新租约地址单播。

因为客户端此刻可能还没有 IP，OFFER/ACK 常常必须用广播或发到待分配的地址，所以发送前 `addArpEntry` 会往 ARP 表塞一条"客户端 MAC ↔ 新 IP"的记录，确保内核能把发往新地址的 UDP 包正确地封装成以太网帧送到客户端——否则内核根本不知道这个 IP 该从哪个接口发、发给谁。

## 4.4 异常路径：RELEASE、DECLINE、地址耗尽

正常四步之外，还有三条退路：

- **RELEASE**：客户端主动释放地址（关机、切网），`processRelease` → `mLeaseRepo.releaseLease()` 把地址归还池子。注意 RELEASE 无响应（DHCP 协议里 RELEASE 没有 ACK/NAK）
- **DECLINE**：客户端发现地址冲突（比如 ARP 探测到已被占用）会发 `DHCPDECLINE`，`processDecline` → `markAndReleaseDeclinedLease()` 把地址从租约表移除并加入"拒绝名单"（带过期时间），短时间内不再分配它
- **地址耗尽**：`makeNewOffer` 探测一圈找不到空闲地址时，会尝试回收过期/被 DECLINE 的地址，实在没有就抛 `OutOfAddressesException`，回 NAK。注意 DHCP 的 NAK 只在 REQUEST 阶段有实际意义（告诉客户端"别用这个地址"），OFFER 阶段的"NAK"只是记日志

对比《连接（六）》里 STA 侧 `DhcpClient` 的 12 状态，先看客户端视角：客户端是"发起方"，每一步都靠重传超时 + 指数退避保证请求不丢——发 DISCOVER、等 OFFER、发 REQUEST、等 ACK，拿到地址后还要在租约到期前按 T1/T2 续期。那 12 个状态，就是这出"要钥匙"戏码的每一步：开口问、等回音、确认要哪间、拿到钥匙、到期续租。

再看服务端视角：`DhcpServer` 是"响应方"，它不主动发起任何事，只是坐在 UDP:67 端口等客人敲门，用地址池 + 租约表保证分配不冲突——来一个 DISCOVER 就查房态给一个 OFFER，来一个 REQUEST 就在房态表上落笔（`commitLease`）、正式交出钥匙。客户端看到的是 12 个状态，服务端看到的是 4 种包（DISCOVER/REQUEST/RELEASE/DECLINE）的应答逻辑；两者在一台手机开热点时同时存在，只是角色相反。同一个进程里，问问题的客人和翻查房本的接待员住在同一个屋檐下——一个递问题，一个对房态。现在客人已经拿到钥匙、住进房间（客户端拿到了 IP 配置），但钥匙只保证进得了民宿的门，要真正上得了网，还得看民宿的水电——上游网络——从哪一路接进来，这正是下一节要讲的市政管网切换。

---

# 5 上游切换时，谁在替客户端重新指路？

DHCP 分完地址，客户端能连上热点，但要"上网"还需要转发：客户端发出的包要经热点转发到某个上游网络。普通用户开热点时，手机自己的 WiFi 客户端模式必然被关掉（同一块射频要么 STA 要么 SAP，见《SAP（四）》的共存章节），此时手机的互联网连接只剩下蜂窝数据。谁来选上游？`Tethering` 的 `TetherMainSM`。

## 5.1 选上游：chooseUpstreamType

`TetherMainSM` 里维护上游状态，核心是 `chooseUpstreamType`：

```java
// Tethering.java:2103
protected void chooseUpstreamType(boolean tryCell) {
    maybeDunSettingChanged();
    final TetheringConfiguration config = mConfig;
    final UpstreamNetworkState ns = (config.chooseUpstreamAutomatically)
            ? mUpstreamNetworkMonitor.getCurrentPreferredUpstream()
            : mUpstreamNetworkMonitor.selectPreferredUpstreamType(
                    config.preferredUpstreamIfaceTypes);
    if (ns == null) {
        if (tryCell) {
            mUpstreamNetworkMonitor.setTryCell(true);
            // We think mobile should be coming up; don't set a retry.
        } else {
            sendMessageDelayed(CMD_RETRY_UPSTREAM, UPSTREAM_SETTLE_TIME_MS);
        }
    } else if (!isCellular(ns)) {
        mUpstreamNetworkMonitor.setTryCell(false);
    }
    setUpstreamNetwork(ns);
    final Network newUpstream = (ns != null) ? ns.network : null;
    if (!Objects.equals(mTetherUpstream, newUpstream)) {
        mTetherUpstream = newUpstream;
        reportUpstreamChanged(mTetherUpstream);
        mNotificationUpdater.onUpstreamCapabilitiesChanged(
                (ns != null) ? ns.networkCapabilities : null);
    }
    mTetheringMetrics.maybeUpdateUpstreamType(ns);
}
```

- 上游选择由 `UpstreamNetworkMonitor` 提供：`getCurrentPreferredUpstream()` 返回当前最优上游。它监听 ConnectivityService 的所有网络，按"当前默认网络优先、WiFi 优先于蜂窝"的规则排序
- 当手机开热点导致 WiFi 客户端掉线时，WiFi 网络从 `UpstreamNetworkMonitor` 的视野里消失，剩下的最优选择就是蜂窝数据。热点服务本身（SAP）不会出现在上游候选里——`UpstreamNetworkMonitor` 会排除 tethering 自己的下游接口
- `setTryCell(true)` 是"试探蜂窝"：有时蜂窝数据还没就绪（比如刚切卡），Tethering 会催一下再重试
- `ns == null`（没有上游）时，若不能试蜂窝，就发延迟消息 `CMD_RETRY_UPSTREAM` 稍后重试——上游出现是异步的，Tethering 要轮询等待
- 上游变化后 `reportUpstreamChanged` 通知系统（比如状态栏热点图标），`onUpstreamCapabilitiesChanged` 更新通知

## 5.2 应用上游：DNS 转发 + 通知下游

选好上游后，`setUpstreamNetwork` 把决定落实到 netd 和各个下游 `IpServer`：

```java
// Tethering.java:2139
protected void setUpstreamNetwork(UpstreamNetworkState ns) {
    InterfaceSet ifaces = null;
    if (ns != null) {
        mLog.i("Looking for default routes on: " + ns.linkProperties);
        ifaces = TetheringInterfaceUtils.getTetheringInterfaces(ns);
        mLog.i("Found upstream interface(s): " + ifaces);
    }

    if (ifaces != null) {
        setDnsForwarders(ns.network, ns.linkProperties);
    }
    notifyDownstreamsOfNewUpstreamIface(ifaces);
    if (ns != null && pertainsToCurrentUpstream(ns)) {
        handleNewUpstreamNetworkState(ns);
    } else if (mCurrentUpstreamIfaceSet == null) {
        handleNewUpstreamNetworkState(null);
    }
}
```

- `getTetheringInterfaces(ns)` 从上游的 `LinkProperties` 里找出带默认路由的接口（可能嵌套在底层接口上，比如 `rmnet_data0` 的 `pdp0`）
- `setDnsForwarders` 把上游 DNS 地址下发给 netd：

```java
// Tethering.java:2163
protected void setDnsForwarders(final Network network, final LinkProperties lp) {
    final Collection<InetAddress> dnses = lp.getDnsServers();
    final String[] dnsServers;
    if (dnses != null && !dnses.isEmpty()) {
        dnsServers = new String[dnses.size()];
        int i = 0;
        for (InetAddress dns : dnses) {
            dnsServers[i++] = dns.getHostAddress();
        }
    } else {
        dnsServers = mConfig.defaultIPv4DNS;
    }
    final int netId = (network != null) ? network.getNetId() : NETID_UNSET;
    try {
        mNetd.tetherDnsSet(netId, dnsServers);
        ...
    } catch (RemoteException | ServiceSpecificException e) {
        ...
        transitionTo(mSetDnsForwardersErrorState);
    }
}
```

- 热点客户端发的 DNS 查询会被热点截获，由 `tetherDnsSet` 配置的 DNS 服务器代为解析。上游有 DNS 就用自己的，否则退回默认 DNS（`DEFAULT_IPV4_DNS`）
- 这里只配置"谁来做 DNS 转发"，实际的转发动作（iptables/BPF 规则）由 netd 在 `tetherInterfaceAdd` 时建立的转发链完成——本文不展开内核细节

`notifyDownstreamsOfNewUpstreamIface` 把新的上游接口集广播给所有活跃的下游 `IpServer`：

```java
// Tethering.java:2191
protected void notifyDownstreamsOfNewUpstreamIface(InterfaceSet ifaces) {
    mCurrentUpstreamIfaceSet = ifaces;
    for (IpServer ipServer : mNotifyList) {
        ipServer.sendMessage(IpServer.CMD_TETHER_CONNECTION_CHANGED, ifaces);
    }
}
```

- `CMD_TETHER_CONNECTION_CHANGED` 是 `IpServer` 收到的"上游变了"通知——总管家换了一路市政管网，广播给各楼前台。下游 `IpServer` 拿到新的上游接口集后，会更新 IPv6 转发（`mLastIPv6UpstreamIfindex`/`mLastIPv6UpstreamPrefixes`）并调整路由——但 IPv4 侧对客户端基本透明，因为客户端把网关指向热点本身，转发规则在 netd 里
- 这解释了为什么用户无感：WiFi 客户端下线、蜂窝顶上，热点客户端已经拿到的 IPv4 配置（网关=热点、DNS=热点）完全不用变，只有热点的上游路径变了

楼里的水电气（上游）从一路切到另一路，接待员不用重新给客人发钥匙——客人手里的钥匙（IP 配置）没变，变的只是楼底下的总管道（netd 转发规则）接到了新的市政管网（蜂窝数据）。

---

# 6 总结

回到最开始的问题：客户端关联后怎么拿到 IP？

1. **感知**：hostapd 把 SAP 拉起来，`WifiManager` 回调 `WIFI_AP_STATE_ENABLED`，`Tethering.StartTetheringSoftApCallback.onStateChanged` 接到通知
2. **造前台**：`enableIpServing` → `ensureIpServerStartedForType` 创建并启动 `IpServer`（每接口一个状态机，5 个顶层状态），`tetherInternal` 发 `CMD_TETHER_REQUESTED` 让它进入 `TetheredState`
3. **定网段**：`BaseServingState.enter` → `startIPv4` → `requestIpv4Address` 用"粘性"策略选私有网段，`configureIPv4` 把地址写到接口
4. **叫接待员**：`configureDhcp` → `startDhcp` → `mDeps.makeDhcpServer` 跨进程（Tethering → NetworkStack）创建 `DhcpServer`，回调拿到 `IDhcpServer` 后 `startWithCallbacks`
5. **上岗收包**：`DhcpServer` 状态机 Stopped → Running，`PacketListener` 在 UDP:67 上监听，客户端广播 DISCOVER 后按"已有租约 > 指定地址 > 池子探测"三条路给 OFFER，REQUEST 后经 `DhcpLeaseRepository.commitLease` 定下租约并回 ACK
6. **接市政**：`TetherMainSM.chooseUpstreamType` 从 `UpstreamNetworkMonitor` 选出蜂窝数据作为上游，`setDnsForwarders` 下发 DNS，`notifyDownstreamsOfNewUpstreamIface` 通知各 `IpServer` 上游路径已切换

关键技术结论：

| 环节         | 关键点                                                       |
| ------------ | ------------------------------------------------------------ |
| 接口唯一性   | `mTetherStates` 以接口名为 key，每接口一个 `IpServer`        |
| 前缀粘性     | `requestStickyDownstreamAddress` 复用上次网段，客户端再连更可能命中缓存 |
| 租约 1 小时  | `DHCP_LEASE_TIME_SECS = 3600`，到期前由客户端 T1/T2 续期     |
| OFFER 不提交 | 地址在 `requestLease`/`commitLease` 时才真正锁定，避免"报而不占" |
| 跨进程       | `DhcpServer` 在 NetworkStack 进程，通过 `INetworkStackConnector` AIDL + 序号防抖回调 |
| 上游切换     | `UpstreamNetworkMonitor` 感知 WiFi 客户端下线，蜂窝顶上，客户端 DHCP 配置不变 |

有开张就有打烊。用户关掉热点，`WifiManager` 回调 `WIFI_AP_STATE_DISABLED`，`StartTetheringSoftApCallback` 走 `disableWifiIpServing`（`Tethering.java:1729`）收尾——`ipServer.unwanted()` 投递 `CMD_TETHER_UNREQUESTED`，`TetheredState` 退出时逆序拆除：`stopDhcp()` 让接待员下班、清空租约（`IpServer.java:671`），`tetherInterfaceRemove` 摘下接口的转发资格，`mBpfCoordinator.removeIpServer` 清掉 BPF 规则，`mTetheringAgent.unregister()` 注销网络代理，ConnectivityService 把"热点网络"移出列表。客人离开、房态清零、管网断开——民宿打烊，等下次 `WIFI_AP_STATE_ENABLED` 再开张。

现在，民宿的钥匙系统完整了：挂牌（《SAP（一）》）、装修（《SAP（二）》）、办入住（《SAP（三）》）、当老板管共存（《SAP（四）》）、分房发钥匙（本篇）。但还有一个问题悬着——如果同一台手机既想开热点，又想让另一台手机通过 Wi-Fi Direct 直连，P2P 的 Group Owner 也会给自己和成员分配 IP。SAP 的钥匙和 P2P 的钥匙是同一套系统在发吗？还是各发各的？这个问题的答案藏在一个独立的世界里——下一章，我们进入 Wi-Fi Direct，从 P2P 的初始化开始，看看另一种"民宿"怎么开张。

---

**相关协议和代码仓库**

- Android Framework（Tethering）：AOSP `packages/modules/Connectivity`，核心文件 `Tethering/src/android/net/ip/IpServer.java`、`Tethering/src/com/android/networkstack/tethering/Tethering.java`、`Tethering/src/com/android/networkstack/tethering/TetheringConfiguration.java`
- Android 网络地址协调（前缀分配）：AOSP `packages/modules/Connectivity` 的 staticlibs，`device/com/android/net/module/util/PrivateAddressCoordinator.java`
- Android NetworkStack（DHCP 服务端）：AOSP `packages/modules/NetworkStack`，核心文件 `src/android/net/dhcp/DhcpServer.java`、`src/android/net/dhcp/DhcpLeaseRepository.java`
- 协议参考：RFC 2131（DHCP）、RFC 4039（Rapid Commit）
