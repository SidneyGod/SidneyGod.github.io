---
title: NAN（二）数据通路与安全 — 从 NDP 建立到 4-way handshake 与测距
top: 1
related_posts: true
abbrlink: 7fd7a219
date: 2026-09-24 23:39:27
tags:
  - Android WiFi
  - NAN
categories:
  - WiFi
  - Code
---

> 前情提要：上一章追完了「发现」这条线——App 的 `attach` 怎么合并成一个共享引擎、supplicant 怎么在用户态用 USD 收发 SDF、驱动怎么在固件/主机里落地发现。但发现只是「对上眼」，供需对上的两个人还要「单独走到一边交换联系方式、真正传数据」。这篇就从上一章状态机里那个没展开的 `COMMAND_TYPE_INITIATE_DATA_PATH_SETUP` 追起，看 Aware 怎么在发现之后建起一条真正的数据通道。

---

# 本章导读

两个人逛同一个集市（发现），举牌对上眼之后，生意才刚开始：得先**开一间包厢**（建 NDP），**互报门牌号**（NDPE 换 IPv6 地址），如果谈的是机密生意还得**签保密合同**（4-way handshake 建 ND-TKSA），有时还想知道**对方离自己到底几米**（测距）。

<!--more-->

但一个学源码的人会追问三件事：

- 为什么 App 建数据通道**不直接调一个 Aware API**，反而要绕道 Android 的 ConnectivityService？
- 为什么 wpa_supplicant 明明管着 wpa_supplicant 的 4-way handshake 代码，**NAN 的握手却不交给它做**，而是整个 offload 给驱动/固件？
- QCOM 和 MTK 对「数据通路状态机放主机还是固件」又给出相反的答案——MTK 甚至在驱动里塞进了一整套 wpa 状态机？

**本章你将学到**：一条 NDP 请求从 `ConnectivityManager.requestNetwork` 一路穿透到驱动固件的完整调用链。Framework 里 `WifiAwareDataPathStateManager` 怎么用「两个状态机 + 一个 NetworkFactory」把每条 NDP 落地成一个虚拟网卡，`NetworkInformationData` 的 TLV 怎么把 port/传输协议塞进 NDP 握手帧。驱动层双平台分叉：QCOM 怎么只发一条 WMI 命令就把 NDP 状态机整个甩给固件，MTK 怎么在 `nan_data_engine.c` 里写 NDP/NDL 两套 FSM、在 `nan_sec.c` 里把 hostapd/wpa_supplicant 的 4-way handshake 搬进驱动、在 `nan_ranging.c` 里做 FTM 测距 + geofencing。

> NDP/NDL/NDC 的概念区分、NDPE 怎么让上层用 socket、4-way handshake 的协议细节，姊妹系列《Wi-Fi Aware（NAN）— 广场上的兴趣广播》已讲透，本文不重讲协议，只做「协议概念 → 源码实现」的映射。服务发现（attach/publish/subscribe/match）见上一章。NDP 的 TSF 同步、信道协商底层细节若只在固件，本文如实标注「在固件，主机不可见」。

---

# 1 为什么建一条 NDP 要绕道 ConnectivityService？

先看全景。左到右是调用方向，虚线是跨进程/跨模块边界。

![NAN 数据通路全局调用链](assets/15b-NAN%EF%BC%88%E4%BA%8C%EF%BC%89%E6%95%B0%E6%8D%AE%E9%80%9A%E8%B7%AF%E4%B8%8E%E5%AE%89%E5%85%A8-%E2%80%94-%E4%BB%8E-NDP-%E5%BB%BA%E7%AB%8B%E5%88%B0-4-way-handshake-%E4%B8%8E%E6%B5%8B%E8%B7%9D/15b-architecture-callchain.svg)

回到包厢比喻：两个人进了集市，要开包厢做生意，**没人会去现盖一间铺子**——直接租商场物业（ConnectivityService）的包厢，门牌（路由）、内线电话（DNS）、保安（权限）全都现成。这就是本文第一个灵魂问题的答案：**Aware 的数据通路不走独立 API，而是伪装成一条「标准 Android 网络」，复用整条联网栈**。

App 侧的入口很普通——拿到 `DiscoverySession` 之后，用 `createNetworkSpecifierOpen` / `createNetworkSpecifierPassphrase` 生成一个 `NetworkSpecifier`，塞进 `ConnectivityManager.requestNetwork()`：

```java
// packages_modules_Wifi/framework/java/android/net/wifi/aware/DiscoverySession.java:500
@Deprecated
public NetworkSpecifier createNetworkSpecifierOpen(@NonNull PeerHandle peerHandle) {
    if (mTerminated) {
        Log.w(TAG, "createNetworkSpecifierOpen: called on terminated session");
        return null;
    }
    // ...省略 mMgr 空值检查...
    int role = this instanceof SubscribeDiscoverySession
            ? WifiAwareManager.WIFI_AWARE_DATA_PATH_ROLE_INITIATOR
            : WifiAwareManager.WIFI_AWARE_DATA_PATH_ROLE_RESPONDER;

    return mgr.createNetworkSpecifier(mClientId, role, mSessionId, peerHandle, null, null);
}
```

- **角色在这里定死**：`SubscribeDiscoverySession`（订阅者）→ `INITIATOR`，`PublishDiscoverySession`（发布者）→ `RESPONDER`。这正是规范 §6.2 的规定——「A service subscriber initiates a NDP setup... and serves as an NDP Initiator... The intended service publisher serves as the NDP Responder」。为什么订阅者发起？因为订阅者知道「我要什么」，主动去敲发布者的门最自然。
- `createNetworkSpecifier` 最终返回一个 `WifiAwareNetworkSpecifier`——它继承了 `NetworkSpecifier`，是「包厢的门牌」：里面写死了 `clientId`、`sessionId`、`peerId`、角色、可选的 PMK/passphrase。

`WifiAwareNetworkSpecifier` 的 `type` 字段有四种（`WifiAwareNetworkSpecifier.java:49`）：

| 常量                                  | 值   | 含义                                           |
| ------------------------------------- | ---- | ---------------------------------------------- |
| `NETWORK_SPECIFIER_TYPE_IB`           | 0    | in-band、指定 peer（经发现会话）               |
| `NETWORK_SPECIFIER_TYPE_IB_ANY_PEER`  | 1    | in-band、任意 peer（仅 responder，Android S+） |
| `NETWORK_SPECIFIER_TYPE_OOB`          | 2    | out-of-band、指定 MAC（不经发现）              |
| `NETWORK_SPECIFIER_TYPE_OOB_ANY_PEER` | 3    | out-of-band、任意 MAC（仅 responder）          |

App 把 `WifiAwareNetworkSpecifier` 放进 `NetworkRequest`（`addTransportType(TRANSPORT_WIFI_AWARE)`）交给 ConnectivityService 后，ConnectivityService 就会拿着这份「开厢申请」去找所有已注册的 `NetworkFactory`，问一句「这单你们谁能接」。

SystemServer 里，`WifiAwareDataPathStateManager.start()` 已经提前注册好了一个专门接这种单的工厂：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:134
private static NetworkCapabilities makeNetworkCapabilitiesFilter() {
    NetworkCapabilities.Builder builder = new NetworkCapabilities.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            // ...省略其余 NOT_* capability、带宽/信号强度占位、MatchAllNetworkSpecifier...
    return builder.build();
}

// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:158
public void start(Context context, Looper looper, ...) {
    // ...省略赋值...
    mNetworkFactory = new WifiAwareNetworkFactory(looper, context, sNetworkCapabilitiesFilter);
    mNetworkFactory.setScoreFilter(NETWORK_FACTORY_SCORE_AVAIL);
    mNetworkFactory.register();
}
```

- **`TRANSPORT_WIFI_AWARE`** 是这张「门牌」的身份证：只有带着这个 transport 的 `NetworkRequest` 才会被路由到这个工厂。`NET_CAPABILITY_INTERNET` 被显式移除——一条 NDP 是点到点的直连，**不提供互联网访问**，这也是它和 WiFi STA（能上网）最本质的区别。
- **`mNetworkFactory.register()`** 是复用联网栈的关键一步：它把工厂登记进 ConnectivityService，从此 App 的 `requestNetwork` 会回调进这个工厂的 `acceptRequest` / `needNetworkFor`。
- `NETWORK_FACTORY_SCORE_AVAIL = 1`（`WifiAwareDataPathStateManager.java:98`）：分数恒为 1，说明 Aware 网络**从不参与和其他网络的「择优竞争」**——它只响应显式点名它的请求，不会去抢默认网络的位置。

> 如果你在想「为什么不搞一个 `WifiAwareDataPathManager.openDataPath()` 的独立 API」——答案是：那样 App 拿到的就只是一个自定义句柄，**拿不到 DNS、路由、`Network` 对象、`bindProcessToNetwork` 这套现成的东西**。而走 ConnectivityService，App 最终拿到的是一个标准的 `Network`，之后 `Socket` 直接 bind 上去、`DnsResolver` 自动生效，和连 WiFi、走蜂窝**写起来一模一样**。这是 Android 里「新网络类型」的标准姿势——P2P（Wi-Fi Direct）、低功耗网（LE 的数据通路）也都是这么干的。

到这里，一条 NDP 请求已经「挂号」进了 ConnectivityService。但它还只是躺在工厂门口的一纸申请，没有生成任何 NDP、任何虚拟网卡。真正的状态机在下一节。

---

# 2 Framework 怎么给「一条 NDP」记账？——两个状态机

申请进了工厂，工厂得有个「账本」记录每条 NDP 的一生。`WifiAwareDataPathStateManager` 内部有两本账，分别用两个内部类记账，各带一套状态常量。

**账本 A：`NdpInfo`——单条 NDP 的状态。** 一条 NDP 就是「两人之间的一笔交易」，它从「等确认」走到「已确认」，也可能中途夭折：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:1300
private static class NdpInfo {
    static final int STATE_WAIT_FOR_CONFIRM = 107;
    static final int STATE_CONFIRMED = 108;
    static final int STATE_RESPONDER_WAIT_FOR_RESPOND_RESPONSE = 109;

    public int state;
    public byte[] peerDiscoveryMac = null;   // 对端「发现面」地址（NMI）
    public int ndpId = 0;                     // 0 永远不是有效 ID
    public byte[] peerDataMac;                // 对端「数据面」地址（NDI）
    public Inet6Address peerIpv6;             // 对端 IPv6（NDPE 推导）
    public int peerPort = 0;
    public int peerTransportProtocol = -1;
    // ...省略 peerIpv6Override / channelInfos / startTimestamp...
}
```

**账本 B：`AwareNetworkRequestInformation`——一张网络申请的完整状态。** 一个 App 的 `NetworkRequest` 对应一个 `nnri`（下文简称），它可能承载**多条** NDP（同一个 `accept any peer` 的请求可以被多个 peer 同时满足）：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:1349
public static class AwareNetworkRequestInformation {
    static final int STATE_IDLE = 100;
    static final int STATE_CONFIRMED = 101;
    static final int STATE_INITIATOR_WAIT_FOR_REQUEST_RESPONSE = 102;
    static final int STATE_RESPONDER_WAIT_FOR_REQUEST = 103;
    static final int STATE_TERMINATING = 104;
    static final int STATE_IN_SETUP = 105;

    public int state;
    public int uid;
    public String packageName;
    public String interfaceName;                  // 绑定的 NDI 虚拟网卡名
    public int pubSubId = 0;
    public int specifiedPeerInstanceId = 0;
    public byte[] specifiedPeerDiscoveryMac = null;
    public WifiAwareNetworkSpecifier networkSpecifier;
    public SparseArray<NdpInfo> ndpInfos = new SparseArray();  // 一条申请可挂多条 NDP
    public WifiAwareNetworkAgent networkAgent;     // 落地后的 NetworkAgent
    // ...省略 equivalentRequests / startValidationTimestamp...
}
```

- **两本账的关系**：`nnri.ndpInfos` 里存着这条申请名下的所有 `NdpInfo`。状态推进时，`nnri.state` 描述「整张申请走到哪一步」，`ndpInfo.state` 描述「某条具体 NDP 走到哪一步」。这俩必须协同，`onDataPathConfirm` 里就有「`ndpInfo.state` 不对或 `nnri` 已 TERMINATING 就拒绝」的校验。
- **状态值是自编码的整数**（100~109），不是 enum——因为这套状态要经 `StateMachine` 的消息队列（`msg.arg1`/`arg2`）在 `WifiAwareStateManager` 与 `WifiAwareDataPathStateManager` 之间来回传递，用 int 最省事。100 段是「申请态」，107 段是「NDP 态」，两段数字故意错开，避免在一个 switch 里打架。
- 这套状态机的「外部驱动」是 ConnectivityService 的 `acceptRequest` / `needNetworkFor` / `releaseNetworkFor` 三个回调，加上 HAL 回灌的 `onDataPathRequest` / `onDataPathConfirm` / `onDataPathEnd` 三个通知——**六路输入，一个状态机**，下一节逐路追。

> 如果你担心「状态多了会不会记乱」——答案是不会，因为 Framework 这一层**只做状态记账和资源编排，不做任何 NDP 协议逻辑**。真正的 NDP 状态机在驱动/固件（第 6、7 节）。Framework 的账本和驱动的状态机是**两个世界的两套状态**，靠 ndpId 对齐：Framework 记「这条 NDP 对 App 是否可用」，驱动记「这条 NDP 在空口上走到哪一帧」。

---

# 3 Initiator 怎么把请求一路送进 HAL？

现在追 Initiator 这条主线。App 的 `requestNetwork` 进来后，ConnectivityService 先调 `acceptRequest` 问「接不接」，再调 `needNetworkFor` 说「接，开工」。

`acceptRequest` 干三件事：**确认是 `WifiAwareNetworkSpecifier` → 确认 Aware 开着、有可用接口 → 解析成 `nnri` 存入 `mNetworkRequestsCache`**。其中解析那步 `processNetworkSpecifier` 是一个大闸门，校验了 type/role/clientId/sessionId/peerId/port/PMK 一整套字段（`WifiAwareDataPathStateManager.java:1429`），任何一个不对就 `releaseRequestAsUnfulfillableByAnyFactory` 拒绝。

真正触发下发的是 `needNetworkFor`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:1005
@Override
protected void needNetworkFor(NetworkRequest networkRequest) {
    // ...省略 networkSpecifier / nnri 查找与空值检查...
    if (nnri.state != AwareNetworkRequestInformation.STATE_IDLE) {
        // ...省略「已在处理中」日志...
        return;
    }
    if (nnri.networkSpecifier.role
            == WifiAwareManager.WIFI_AWARE_DATA_PATH_ROLE_INITIATOR) {
        nnri.interfaceName = selectInterfaceForRequest(nnri);
        if (nnri.interfaceName == null) {
            // ...省略「无接口可用」拒绝...
            return;
        }
        int channel = selectChannelForRequest(nnri);       // 返回 2437（信道 6）
        int channelRequestType = NanDataPathChannelCfg.CHANNEL_NOT_REQUESTED;
        // ...省略：资源开启且指定了 channel 时，改成 REQUEST/FORCE_CHANNEL_SETUP...
        mMgr.initiateDataPathSetup(networkSpecifier, nnri.specifiedPeerInstanceId,
                channelRequestType, channel, nnri.specifiedPeerDiscoveryMac,
                nnri.interfaceName, nnri.networkSpecifier.isOutOfBand(), null);
        nnri.state =
                AwareNetworkRequestInformation.STATE_INITIATOR_WAIT_FOR_REQUEST_RESPONSE;
    } else {
        nnri.state = AwareNetworkRequestInformation.STATE_RESPONDER_WAIT_FOR_REQUEST;
    }
}
```

- **Initiator 立刻下单**：选好 NDI 接口（`selectInterfaceForRequest`）、选好信道（`selectChannelForRequest` 现在硬编码返回 2437 = 信道 6，注释里说信道选择已委托给 HAL，这个函数是遗留空壳），然后调 `mMgr.initiateDataPathSetup(...)` 下发，状态翻到 `STATE_INITIATOR_WAIT_FOR_REQUEST_RESPONSE`。
- **Responder 什么都不做，只等**：翻到 `STATE_RESPONDER_WAIT_FOR_REQUEST`，等对端的 `onDataPathRequest` 通知进来（第 4 节）。这对应规范 §6.2 的不对称：Initiator 主动发 Data Path Request NAF，Responder 被动等。

`selectInterfaceForRequest`（`WifiAwareDataPathStateManager.java:1232`）是「怎么分包厢」的决策：优先挑一个**空闲**的 NDI 接口；如果都满了，看设备 overlay `config_wifiAllowMultipleNetworksOnSameAwareNdi` 是否允许「多个网络挤一个 NDI」；还处理了「同一个 peer 要求安全升级时复用同一个 NDI」的特殊情况。**一个 NDI 接口默认只服务一个网络**，因为网络栈不支持一张网卡上挂多个 `Network`。

`initiateDataPathSetup` 只是打包消息（`msg.arg1 = COMMAND_TYPE_INITIATE_DATA_PATH_SETUP`），丢进 `WifiAwareStateManager` 的串行队列（15a 讲的 `WifiAwareStateMachine`）。队列里执行的是 `initiateDataPathSetupLocal`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareStateManager.java:4308
private boolean initiateDataPathSetupLocal(short transactionId,
        WifiAwareNetworkSpecifier networkSpecifier, int peerId, int channelRequestType,
        int channel, byte[] peer, String interfaceName, boolean isOutOfBand, byte[] appInfo) {
    WifiAwareDataPathSecurityConfig securityConfig = networkSpecifier
            .getWifiAwareDataPathSecurityConfig();
    // ...省略日志...
    byte pubSubId = 0;
    if (!isOutOfBand) {
        WifiAwareClientState client = mClients.get(networkSpecifier.clientId);
        // ...省略 client/session 空值检查...
        pubSubId = (byte) session.getPubSubId();
    }
    boolean success = mWifiAwareNativeApi.initiateDataPath(transactionId, peerId,
            channelRequestType, channel, peer, interfaceName, isOutOfBand,
            appInfo, mCapabilities, networkSpecifier.getWifiAwareDataPathSecurityConfig(),
            pubSubId);
    if (!success) {
        mDataPathMgr.onDataPathInitiateFail(networkSpecifier, NanStatusCode.INTERNAL_FAILURE);
    }
    return success;
}
```

- **`pubSubId` 是「包厢挂靠的集市摊位」**：in-band 的 NDP 必须知道自己是哪场发现（publish/subscribe 会话）配对出来的，`pubSubId` 就是那个发现会话的 id。out-of-band 的 NDP 没有发现会话，`pubSubId` 保持 0。
- **`securityConfig` 从 `networkSpecifier` 一路透传**：App 在 `WifiAwareNetworkSpecifier.Builder` 里设置的 PMK/passphrase，原封不动穿过 Framework、HAL，最终变成驱动/固件里 4-way handshake 的输入（第 8 节）。Framework 不碰密钥本身，只做搬运。

最后一跳是 `WifiAwareNativeApi.initiateDataPath`，它把 Java 对象翻译成 HAL 接口调用：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareNativeApi.java:599
public boolean initiateDataPath(short transactionId, int peerId, int channelRequestType,
        int channel, byte[] peer, String interfaceName,
        boolean isOutOfBand, byte[] appInfo, Capabilities capabilities,
        WifiAwareDataPathSecurityConfig securityConfig, byte pubSubId) {
    // ...省略日志、recordTransactionId...
    WifiNanIface iface = mHal.getWifiNanIface();
    if (iface == null) {
        Log.e(TAG, "initiateDataPath: null interface");
        return false;
    }
    try {
        MacAddress peerMac = MacAddress.fromBytes(peer);
        return iface.initiateDataPath(transactionId, peerId, channelRequestType, channel,
                peerMac, interfaceName, isOutOfBand, appInfo, capabilities, securityConfig,
                pubSubId);
    } catch (IllegalArgumentException e) {
        Log.e(TAG, "Invalid peer mac received: " + Arrays.toString(peer));
        return false;
    }
}
```

- `mHal.getWifiNanIface()` 返回的 `WifiNanIface` 是跨 HAL 进程的桥（和上一章的 publish 是同一座桥）。到这一步，Framework 的戏份演完了——它把一个 Java 的 `WifiAwareNetworkSpecifier` + 安全配置，交给了 HAL 层。
- 之后 HAL 会**异步回包**：`notifyInitiateDataPathResponse` → `onInitiateDataPathResponseSuccess`（带回真实的 `ndpId`）→ `WifiAwareDataPathStateManager.onDataPathInitiateSuccess`，把 `ndpInfo.state` 翻到 `STATE_WAIT_FOR_CONFIRM`，同时**挂一个 20 秒的确认超时定时器**（`AWARE_WAIT_FOR_DP_CONFIRM_TIMEOUT = 20_000`，`WifiAwareStateManager.java:2232`）——20 秒内等不到对端的 `onDataPathConfirm` 就 `endDataPath` 收摊。

> 如果你在想「为什么要等 confirm，而不是 initiate 成功就认为建好了」——因为 `initiateDataPath` 的「成功」只是「请求已被 HAL 受理」，**离「对端接受了、数据面打通了」还差一个空口往返**。规范 §6.2.1 里 Initiator 发完 Data Path Request，还要等 Responder 回 Data Path Response、可能再补 Data Path Confirm，整套走完才算数。Framework 用 `STATE_WAIT_FOR_CONFIRM` + 20 秒超时把这个「等待」显式化了。

---

# 4 Responder 怎么接招，确认后怎么「通电上网」？

Initiator 的请求穿过 HAL、驱动、空口，飞到对端后，对端的 HAL 会回灌一个 `onDataPathRequest` 通知。Framework 侧入口是 `WifiAwareDataPathStateManager.onDataPathRequest`，它干一件关键的事：**把这封「对端的求约」匹配到自己已有的某张 `NetworkRequest` 上**。

匹配规则（`WifiAwareDataPathStateManager.java:430`）翻译成广场黑话就是：先看对方是不是冲着自己某场发现（`pubSubId`）来的；如果自己当初点名了具体 peer，必须 MAC 精确对上且还在「等约」状态（`STATE_RESPONDER_WAIT_FOR_REQUEST`）；如果自己当初是「谁来都行」（`accept any peer`），只要不是 IDLE/TERMINATING 状态就接。

匹配上之后，Responder 回填 `ndpInfo`，然后**真正决定接不接**：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:477
if (nnri.interfaceName == null) {
    nnri.interfaceName = selectInterfaceForRequest(nnri);
}
if (nnri.interfaceName == null) {
    // ...省略「无接口可用」→ respondToDataPathRequest(false, ...) 拒绝...
    return false;
}

NdpInfo ndpInfo = new NdpInfo(ndpId);
ndpInfo.state = NdpInfo.STATE_RESPONDER_WAIT_FOR_RESPOND_RESPONSE;
ndpInfo.peerDiscoveryMac = mac;
nnri.ndpInfos.put(ndpId, ndpInfo);

nnri.state = AwareNetworkRequestInformation.STATE_IN_SETUP;
mMgr.respondToDataPathRequest(true, ndpId, nnri.interfaceName,
        NetworkInformationData.buildTlv(nnri.networkSpecifier.port,
                nnri.networkSpecifier.transportProtocol),
        nnri.networkSpecifier.isOutOfBand(), nnri.networkSpecifier);
```

- **`NetworkInformationData.buildTlv(...)` 是 Responder 的「名片」**：把自己当服务端要监听哪个 port、用 TCP 还是 UDP，编成一个 TLV 塞进响应帧（对应规范 §6.2.7 里 NDPE 携带的 Generic Service Protocol 信息）。Initiator 收到后就能知道「该去连对端的哪个端口」。
- **port/传输协议只在 Responder 侧、只允许安全链路上指定**（`processNetworkSpecifier` 里校验过）：因为一条 NDP 是「一条二层链路上多个 App 共享」，port 信息只在第一个请求建立链路时传输一次，不加密就会泄露给别的 App。
- 决定接受后翻到 `STATE_RESPONDER_WAIT_FOR_RESPOND_RESPONSE`，等 HAL 回 `onRespondToDataPathSetupRequestResponse`。这个响应最终落到 `onRespondToDataPathRequest`（`WifiAwareDataPathStateManager.java:512`）：成功就把 `ndpInfo.state` 翻到 `STATE_WAIT_FOR_CONFIRM`，和 Initiator 汇合到同一个等 confirm 的状态；失败则 `endDataPath` 拆单、把这条 NDP 从 `nnri.ndpInfos` 里抹掉。

链路两端都走完各自的请求/响应后，最后一锤是 **`onDataPathConfirm`**——固件通知「空口上的 NDP 建立已经完成，现在可以配 L3 了」。这是 Framework 里最重的一段逻辑：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:620
if (accept) {
    ndpInfo.peerDataMac = mac;                          // 对端数据面地址（NDI）
    ndpInfo.state = NdpInfo.STATE_CONFIRMED;
    ndpInfo.channelInfos = channelInfo;
    nnri.state = AwareNetworkRequestInformation.STATE_CONFIRMED;
    if (nnri.networkAgent == null && !isInterfaceUpAndUsedByAnotherNdp(nnri)) {
        try {
            mNetdWrapper.setInterfaceUp(nnri.interfaceName);   // 把 NDI 网卡拉起来
            mNetdWrapper.enableIpv6(nnri.interfaceName);       // 开 IPv6
        } catch (Exception e) { /* ...省略失败→ endDataPath... */ }
    }
    // ...省略：initiator 侧解析对端 port/传输协议/IPv6 override 的 TLV...
    nnri.startValidationTimestamp = mClock.getElapsedSinceBootMillis();
    handleAddressValidation(nnri, ndpInfo, networkSpecifier.isOutOfBand(), mac);
}
```

- **`mNetdWrapper.setInterfaceUp` + `enableIpv6`**：这就是「包厢通电」——NDI 虚拟网卡在驱动侧建好后（第 6 节），Framework 通过 netd 把这张网卡拉起来、开 IPv6。**NDP 是纯 IPv6 链路**，`fe80::/64` 的 link-local 地址是唯一的地址来源。
- **`getInet6Address` 从对端 NDI MAC 推导对端 IPv6**（`WifiAwareDataPathStateManager.java:684`）：若对端没显式给 IPv6 override，就用 `MacAddress.getLinkLocalIpv6FromEui48Mac()` 把 48 位 MAC 按 EUI-64 规则展开成 `fe80::` 前缀的 link-local 地址——这正是 NDPE 协议里「从 NDI 推导 IPv6 接口标识」的落地。

`handleAddressValidation` 做最后一道质检：**地址没配好不能宣告网络就绪**。它先用自己的 link-local 地址构造 `LinkProperties`（加 `fe80::/64` 路由），再用一个 `DatagramSocket` 试着 bind 上去验证地址可用；不可用就 1 秒后重试（`ADDRESS_VALIDATION_RETRY_INTERVAL_MS = 1000`），超过 5 秒（`ADDRESS_VALIDATION_TIMEOUT_MS = 5000`）就放弃收摊。

质检通过后，才真正「挂牌营业」——创建 `WifiAwareNetworkAgent`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDataPathStateManager.java:739
if (nnri.networkAgent == null) {
    final WifiAwareNetworkInfo ni = new WifiAwareNetworkInfo(ndpInfo.peerIpv6,
            ndpInfo.peerPort, ndpInfo.peerTransportProtocol, ndpInfo.channelInfos);
    ncBuilder.setTransportInfo(ni);
    final NetworkAgentConfig naConfig = new NetworkAgentConfig.Builder()
            .setLegacyType(ConnectivityManager.TYPE_NONE)
            .setLegacyTypeName(NETWORK_TAG)
            .build();
    nnri.networkAgent = new WifiAwareNetworkAgent(mLooper, mContext,
            AGENT_TAG_PREFIX + ndpInfo.ndpId, ncBuilder.build(), linkProperties,
            NETWORK_FACTORY_SCORE_AVAIL, naConfig, mNetworkFactory.getProvider(), nnri);
    mNiWrapper.setConnected(nnri.networkAgent);   // → networkAgent.markConnected()
}
```

- **`WifiAwareNetworkAgent extends NetworkAgent`**（`WifiAwareDataPathStateManager.java:1135`）：这是「包厢挂牌」。构造里直接 `register()` 把自己登记进 ConnectivityService，`markConnected()` 宣告「网络已就绪」，App 侧的 `NetworkCallback.onAvailable(network)` 就在这一刻被触发。
- **`setTransportInfo(ni)`** 把对端 IPv6、port、传输协议、信道塞进 `NetworkCapabilities` 的 transport info——App 通过 `network.getNetworkCapabilities().getTransportInfo()` 能拿到一个 `WifiAwareNetworkInfo`，里面就是「对方在内线电话的哪个分机号（port）」。
- `WifiAwareNetworkAgent.onNetworkUnwanted()` 是拆除侧：ConnectivityService 不要这条网络了（App 注销了 callback），就 `endDataPath` 拆掉名下所有 NDP，翻到 `STATE_TERMINATING`，等 HAL 的 `onDataPathEnd` 通知回来做最终清理。

到这里，一条 NDP 在 Framework 走完了全程：**App 申请 → NetworkFactory 接单 → 下发 HAL → 对端接招 → confirm → 配 L3 → 挂牌营业**。但 NDP 协议本身（空口上那几帧 Data Path Request/Response/Confirm）在哪？——Framework 一行都没做，全在 HAL 之下的驱动/固件。下一节跨 HAL 边界，看这条线下到哪里。

---

# 5 跨 HAL 之后谁在干活？supplicant 为什么袖手旁观？

`WifiAwareNativeApi.initiateDataPath` 里的 `mHal.getWifiNanIface()` 返回的 `WifiNanIface`，和上一章的 publish 是同一座桥——根据 HAL 服务形态是 `WifiNanIfaceHidlImpl`（HIDL）还是 `WifiNanIfaceAidlImpl`（AIDL），最终打进 HAL 进程的 `wifi_nan_iface.cpp`，再经 legacy HAL 的函数指针 `nanDataRequestInitiator` 落到厂商实现。

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/hal/WifiNanIface.java:454
public boolean initiateDataPath(short transactionId, int peerId, int channelRequestType,
        int channel, MacAddress peer, String interfaceName,
        boolean isOutOfBand, byte[] appInfo, Capabilities capabilities,
        WifiAwareDataPathSecurityConfig securityConfig, byte pubSubId) {
    return validateAndCall("initiateDataPath", false,
            () -> mWifiNanIface.initiateDataPath(transactionId, peerId, channelRequestType,
                    channel, peer, interfaceName, isOutOfBand, appInfo, capabilities,
                    securityConfig, pubSubId));
}
```

厂商 HAL 里，QCOM 的对应入口是 `nan_data_request_initiator`（`QCOM/hardware-qcom-wlan/qcwcn/wifi_hal/nan.cpp:1591`），它组一个 vendor command（`QCA_NL80211_VENDOR_SUBCMD_NDP`）发给驱动。

**但这里要澄清一个容易踩的坑**：wpa_supplicant 在这条数据通路里**什么都没做**。它既没实现 NDP 的 Request/Response/Confirm 状态机，也没做 4-way handshake，只提供了两样「定义」：

- `src/common/nan.h` 里的 NDP/NDL/NDC **属性 ID 枚举**（`enum nan_attr_id`）——NDC 即 NAN Data Cluster（数据簇）；
- `src/common/qca-vendor.h` 里的 QCA **NDP vendor 命令定义**。

```c
// external_wpa_supplicant_8/src/common/nan.h:12
enum nan_attr_id {
    // ...省略 MASTER_INDICATION / CLUSTER / SDA 等发现属性...
    NAN_ATTR_NDP = 0x10,          /* NDP attribute */
    NAN_ATTR_NAN_AVAILABILITY = 0x12,
    NAN_ATTR_NDC = 0x13,          /* NDC attribute */
    NAN_ATTR_NDL = 0x14,          /* NDL attribute */
    NAN_ATTR_NDL_QOS = 0x15,      /* NDL QoS attribute */
    // ...省略 RANGING_INFO / RANGING_SETUP / FTM_RANGING_REPORT...
    NAN_ATTR_CSIA = 0x22,         /* Cipher Suite Info attribute */
    NAN_ATTR_SCIA = 0x23,         /* Security Context Info attribute */
    NAN_ATTR_SHARED_KEY_DESCR = 0x24,
};
```

```c
// external_wpa_supplicant_8/src/common/qca-vendor.h:8926
enum qca_wlan_vendor_attr_ndp_params {
    // ...省略 NDP_SUBCMD / TRANSACTION_ID / SERVICE_INSTANCE_ID / CHANNEL...
    QCA_WLAN_VENDOR_ATTR_NDP_INTERFACE_CREATE = 1,
    QCA_WLAN_VENDOR_ATTR_NDP_INTERFACE_DELETE = 2,
    QCA_WLAN_VENDOR_ATTR_NDP_INITIATOR_REQUEST = 3,
    QCA_WLAN_VENDOR_ATTR_NDP_INITIATOR_RESPONSE = 4,
    QCA_WLAN_VENDOR_ATTR_NDP_RESPONDER_REQUEST = 5,
    QCA_WLAN_VENDOR_ATTR_NDP_RESPONDER_RESPONSE = 6,
    QCA_WLAN_VENDOR_ATTR_NDP_END_REQUEST = 7,
    QCA_WLAN_VENDOR_ATTR_NDP_END_RESPONSE = 8,
    QCA_WLAN_VENDOR_ATTR_NDP_REQUEST_IND = 9,
    QCA_WLAN_VENDOR_ATTR_NDP_CONFIRM_IND = 10,
    QCA_WLAN_VENDOR_ATTR_NDP_END_IND = 11,
    QCA_WLAN_VENDOR_ATTR_NDP_SCHEDULE_UPDATE_IND = 12,
};
```

- **`NAN_ATTR_NDP = 0x10`、`NDC = 0x13`、`NDL = 0x14`**：这就是简报里说的「supplicant 只有属性 ID 定义」。这些 ID 是给「谁在拼 NAN Action 帧」用的——而拼帧的人不在 supplicant，在驱动/固件。supplicant 只是「替协议文档抄了一份编号」。
- **QCA 的 NDP vendor 命令 12 条子命令**（`INITIATOR_REQUEST` / `RESPONDER_REQUEST` / `END_REQUEST` / `REQUEST_IND` / `CONFIRM_IND` ...）完美对应规范 §6.1 的 Data Request/Response/End 原语 + §9.4.3 的 Data Path 帧（Request=5/Response=6/Confirm=7/Key Installment=8/Termination=9）。但这些只是「命令编号」，真正的实现全在 QCOM 驱动 + 固件里。

为什么 supplicant 不做 NDP？这是本文第二个灵魂问题。答案和 15a 第 7 节的「为什么只做 USD」一脉相承，但理由更直接：

- **NDP 是数据面**。数据面的转发在驱动/固件（硬件加速），如果让 supplicant 这个用户态进程来管 NDP 状态机，那**每建立一个数据通道都要在用户态和内核态之间来回搬运控制消息**，数据包还得从硬件剥出来交给用户态再塞回去——性能灾难。用户态转发一次，代价比内核直通高一个数量级。
- **NDP 需要毫秒级的调度配合**（NDL CRB 的分配、TSF 对齐、信道切换），这些和 15a 讲的 DW 同步一样，都压在驱动/固件的实时能力上。用户态的 `eloop` 定时器根本插不上手。
- 所以 supplicant 的角色被精确划定为「**只管发现（USD），不管数据**」——发现是无同步的、慢节奏的，用户态扛得住；数据是有时序的、快节奏的，必须下沉。

> 一句话：**supplicant 是「集市里举牌的」，不是「包厢里谈生意的」**。它管的是谁和谁对上了眼，至于对眼之后怎么开包厢、怎么签合同，它连门牌号（NDP 属性 ID）都只是抄了份定义，实际干活的全在驱动/固件。这也是为什么 15a 和本文的驱动部分分量远重于 supplicant。

到这里，NDP 在 Framework 层的落地已完整呈现。§6-§9 是驱动/固件内部实现（QCOM 记账 + MTK 两套 FSM + 握手 + 测距），如果想先拿到全局结论，可以直接跳到第 10 节总结，看完「三个设计权衡」再回来补细节。

---

# 6 QCOM 为什么只发一条 WMI 命令就撒手？

跨进驱动，双平台立刻分叉——这是本文的第三个灵魂问题：QCOM 和 MTK 对「数据通路状态机放主机还是固件」给出相反的答案。先看这张双平台路径对比图，再分别追 QCOM（本节）和 MTK（第 7 节）。

![QCOM 瘦主机 vs MTK 胖主机：NDP 数据通路对比](assets/15b-NAN%EF%BC%88%E4%BA%8C%EF%BC%89%E6%95%B0%E6%8D%AE%E9%80%9A%E8%B7%AF%E4%B8%8E%E5%AE%89%E5%85%A8-%E2%80%94-%E4%BB%8E-NDP-%E5%BB%BA%E7%AB%8B%E5%88%B0-4-way-handshake-%E4%B8%8E%E6%B5%8B%E8%B7%9D/15b-dual-platform.svg)

先看 QCOM 的「瘦主机 + 胖固件」——这是系列一贯的 QCOM 风格。

QCOM 主机的 NDP 相关代码集中在 `components/nan/core/src/nan_main.c`（1541 行），但读下来你会发现一个惊人的事实：**它没有一个「NDP 状态机」**。主机只做三件轻活：**请求下发、事件记账、NDI 接口生命周期管理**。真正的 NDP 协商（发哪一帧、等哪一帧、信道怎么选、schedule 怎么谈）全在固件。

主机发请求的入口是 `nan_scheduled_msg_handler`（`nan_main.c:261`），它把 `NDP_INITIATOR_REQ` / `NDP_RESPONDER_REQ` / `NDP_END_REQ` 映射成序列化命令，经 `wlan_serialization_request` 排队，最终在 `nan_req_activated` 里调 `tx_ops->nan_datapath_req_tx` 把请求发往固件。固件做完所有协商后，**用事件流回灌主机**，主机侧只有一个薄薄的分发器：

```c
// QCOM/qcacld-3.0/components/nan/core/src/nan_main.c:1045
static QDF_STATUS nan_datapath_event_handler(struct scheduler_msg *pe_msg)
{
    // ...省略 psoc / vdev 空值检查...
    switch (pe_msg->type) {
    case NDP_INITIATOR_RSP:
        status = nan_handle_initiator_rsp(vdev, &ndp_rsp);
        break;
    case NDP_RESPONDER_RSP:
        status = nan_handle_responder_rsp(vdev, &ndp_rsp);
        break;
    case NDP_INDICATION:
        status = nan_handle_ndp_ind(vdev, &ndp_ind);
        break;
    case NDP_CONFIRM:
        status = nan_handle_confirm(&ndp_confirm);
        break;
    case NDP_END_RSP:
        status = nan_handle_ndp_end_rsp(vdev, &ndp_rsp);
        break;
    case NDP_END_IND:
        status = nan_handle_end_ind(&ndp_end);
        break;
    // ...省略 default 返回 NOSUPPORT...
    }
    // ...省略 RSP 类事件额外调 wlan_serialization_remove_cmd...
}
```

- **`NDP_CONFIRM` / `NDP_INITIATOR_RSP` / `NDP_INDICATION` / `NDP_END_IND` 全是固件主动上报**。主机的 handler 不参与「该不该确认」的决策，只负责收下结果、更新本地记账、转交 userspace（HAL 再回报 Framework 的 `onDataPathConfirm` 等回调）。
- 这正是「胖固件」的物证：**一条 NDP 建立的完整协议交互，在主机上只有一次 WMI 下发 + 若干次事件回收**。

主机记账的核心是「每个 peer 活跃 NDP 数」。`nan_handle_confirm`（`nan_main.c:554`）里，confirm 成功就 `nan_increment_ndp_sessions`，reject 且 peer 名下已无活跃 NDP 就删掉这个 peer：

```c
// QCOM/qcacld-3.0/components/nan/core/src/nan_main.c:554
static QDF_STATUS nan_handle_confirm(struct nan_datapath_confirm_event *confirm)
{
    // ...省略 psoc/vdev/peer 空值检查...
    if (confirm->rsp_code != NAN_DATAPATH_RESPONSE_ACCEPT &&
        confirm->num_active_ndps_on_peer == 0) {
        /* 这个 peer 是在 ndp_indication 时建的，但 confirm 失败，需要删掉 */
        nan_err("NDP confirm with reject and no active ndp sessions. deleting peer...");
        // ...删除 peer...
    }
    // ...省略：accept 时 nan_increment_ndp_sessions、首个 NDP 时记录 primary_peer_mac...
}
```

- **peer 是「预建」的**：固件在 `NDP_INDICATION`（响应端收到对端请求）时就要求主机先建好这个 peer（见下面 `lim_add_ndi_peer`），confirm 失败再删。peer 的存活靠 `active_ndp_sessions` 计数维护——计数归零，peer 就没用了。
- 主机对每条 NDP 记的「账」就是 `struct nan_peer_priv_obj`（`nan_main_i.h:189`）：一个自旋锁 + `active_ndp_sessions` 计数 + `home_chan_info`，仅此而已。对比 MTK 那一整套 FSM（下一节），这里的「轻」一目了然。

主机还有一个真正要干的活：**建 NDI（NAN Data Interface）虚拟接口 + 建数据面 peer**。这是「包厢」在数据面落地的地方，分两步走。

第一步是 PE 层建 peer。固件上报 `NDP_INDICATION` 后，`nan_handle_ndp_ind`（`nan_main.c:661`）调 `cb_obj.add_ndi_peer`，这个回调就是 `lim_add_ndi_peer_converged`，最终落到：

```c
// QCOM/qcacld-3.0/core/mac/src/pe/nan/nan_datapath.c:45
static QDF_STATUS lim_add_ndi_peer(struct mac_context *mac_ctx,
	uint32_t vdev_id, struct qdf_mac_addr peer_mac_addr)
{
	struct pe_session *session;
	tpDphHashNode sta_ds;
	// ...省略 assoc_id / peer_idx / zero_mac_addr 声明...
	if (!wlan_is_vdev_id_up(mac_ctx->pdev, vdev_id)) {
		pe_err_rl("NDI vdev is not up");
		return QDF_STATUS_E_FAILURE;
	}
	// ...省略零 MAC 校验、pe_find_session_by_vdev_id 找 session...
	sta_ds = dph_lookup_hash_entry(mac_ctx, peer_mac_addr.bytes,
				&assoc_id, &session->dph.dphHashTable);
	if (sta_ds) {
		pe_err("NDI Peer already exists!!");
		return QDF_STATUS_SUCCESS;      // 已存在，幂等返回
	}
	ucfg_nan_set_peer_mc_list(session->vdev, peer_mac_addr);
	peer_idx = lim_assign_peer_idx(mac_ctx, session);
	// ...省略 dph_add_hash_entry 建 DPH 表项、置 staType=STA_ENTRY_NDI_PEER、lim_add_sta...
}
```

第二步是 WMA 层建数据面 peer。`lim_add_sta` 下发后，`wma_dev_if.c:5619` 在 `wma_add_sta_req` 处理里识别出这是 NDI 模式的 peer，改走 `wma_add_sta_ndi_mode`：

```c
// QCOM/qcacld-3.0/core/wma/src/wma_nan_datapath.c:38
void wma_add_sta_ndi_mode(tp_wma_handle wma, tpAddStaParams add_sta)
{
	enum ol_txrx_peer_state state = OL_TXRX_PEER_STATE_CONN;
	// ...省略 iface / soc 获取...
	if (cdp_find_peer_exist_on_vdev(soc, add_sta->smesessionId, add_sta->staMac)) {
		// ...省略「已存在」→ 回 WMA_ADD_STA_RSP...
	}
	// ...省略 cdp_find_peer_exist 跨 vdev 查重...
	status = wma_create_peer(wma, add_sta->staMac,
				 WMI_PEER_TYPE_NAN_DATA, add_sta->smesessionId, NULL, false);
	// ...省略失败处理、cdp_peer_state_update(soc, add_sta->staMac, state)...
}
```

- **`WMI_PEER_TYPE_NAN_DATA = 4`**（`fw-api/fw/wmi_unified.h:21410`）：这是数据面 peer 的「工种」标签。NAN 数据面 peer 和普通 STA peer 用同一套 `wma_create_peer` 基建，只是 peer type 不同——这又印证了「NDP 数据面是复用 WiFi 已有数据面，而不是另起炉灶」。
- 两步合起来，就是「包厢」在数据面落地的完整路径：**PE 建表项（`lim_add_ndi_peer`）→ WMA 建硬件 peer（`wma_add_sta_ndi_mode`）→ `wma_create_peer(WMI_PEER_TYPE_NAN_DATA)`**。建好之后，App 的 socket 数据才能在这条 peer 上收发。
- 而 NDI 虚拟接口本身（vdev）的创建/删除，由 `enum nan_datapath_state`（`nan_public_structs.h:228`）管理：`NAN_DATA_NDI_CREATING_STATE=0 → NAN_DATA_NDI_CREATED_STATE=1 → ...`，一套 11 态的接口生命周期状态机。这就是 Framework 里 `createDataPathInterface("aware_data0")` 在驱动侧对应的 vdev 生命周期。

> 如果你在犹豫「QCOM 主机真的没有 NDP 状态机吗」——是的，这就是瘦主机的定义。主机唯一「看起来像状态机」的是 `enum nan_datapath_state`（11 态），但它管的只是**接口和 peer 的增删**，不是 NDP 的协议交互。NDP 的 Request→Response→Confirm、安全握手、schedule 协商，全部在固件的 WMI 世界之外（主机不可见）。这也是本文开头边界声明里「NDP 的 TSF 同步、信道协商底层细节在固件，主机不可见」的出处。

---

# 7 MTK 为什么要在驱动里写两套状态机？

换到 MTK，答案完全反过来：**胖主机 + 瘦固件**。如果说 QCOM 是「把开包厢的活外包给物业总部（固件）」，MTK 就是「店员自己在店里跑完整个开厢流程」。主机 `nan/nan_data_engine.c`（6755 行）里躺着两套完整的状态机——一套管 NDP 协议，一套管 NDL 管理。固件只做 MAC 级收发。

先看命令入口。HAL 的 `nan_data_request_initiator` 组 vendor command 后，经 `mtk_cfg80211_vendor_ndp`（`gl_vendor_ndp.c:1349`）分发到 `nanNdpInitiatorReqHandler`，最终调 `nanCmdDataRequest`：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/nan/nan_data_engine.c:3442
nanCmdDataRequest(struct ADAPTER *prAdapter,
		  struct _NAN_CMD_DATA_REQUEST *prNanCmdDataRequest,
		  uint8_t *pu1NdpId, uint8_t *au1InitiatorDataAddr) {
	struct _NAN_NDP_INSTANCE_T *prNDP = NULL;
	struct _NAN_NDL_INSTANCE_T *prNDL = NULL;
	// ...省略 prAdapter / prNanCmdDataRequest 空值检查...

	/* check for existing NDL where peer address exists or not */
	prNDL = nanDataUtilSearchNdlByMac(
		prAdapter, prNanCmdDataRequest->aucResponderDataAddress);
	if (prNDL) {
		prNDP = nanDataAllocateNdp(prAdapter, prNDL, NAN_PROTOCOL_INITIATOR,
			prNanCmdDataRequest->aucResponderDataAddress, 0,
			prNanCmdDataRequest->ucSecurity == NAN_CIPHER_SUITE_ID_NONE
				? FALSE : TRUE);
	} else {
		prNDL = nanDataAllocateNdl(prAdapter,
			prNanCmdDataRequest->aucResponderDataAddress, NAN_PROTOCOL_INITIATOR);
		if (prNDL) {
			prNDP = nanDataAllocateNdp(prAdapter, prNDL, NAN_PROTOCOL_INITIATOR,
				prNanCmdDataRequest->aucResponderDataAddress, 0,
				prNanCmdDataRequest->ucSecurity == NAN_CIPHER_SUITE_ID_NONE
					? FALSE : TRUE);
		}
	}
	// ...省略 QoS/安全参数回填、nanSecNotify4wayBegin 启动握手、nanNdlMgmtFsmStep 拉起 NDL FSM...
}
```

- **「先找 NDL，再建 NDP」**：`nanDataUtilSearchNdlByMac` 先查和这个 peer 之间是否已有 NDL（NAN Device Link）。有就复用，没有就 `nanDataAllocateNdl` 新建。这精确对应规范 §6.2.3——「NDP 建立时会检查是否已有满足要求的 NDL Schedule，没有则同时建立」。**NDL 是「两人之间的长期关系」，NDP 是「关系上的一笔笔交易」**，代码里 NDL 对象挂在 `prNDP` 之上。
- **`NAN_CIPHER_SUITE_ID_NONE` 决定要不要安全**：`ucSecurity == NAN_CIPHER_SUITE_ID_NONE ? FALSE : TRUE` 这个三元表达式，把「开明文还是加密」翻译成 NDP 的 `fgSecurityRequired` 标志。要加密，后面 `nanSecNotify4wayBegin` 会启动 4-way handshake（第 8 节）。

两套状态机的「发动机」各是一个 step 函数。先看 NDP 协议状态机：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/nan/nan_data_engine.c:2755
static enum _ENUM_NAN_NDP_STATUS_T
nanDataPathProtocolFsmStep(struct ADAPTER *prAdapter,
			   enum _ENUM_NDP_PROTOCOL_STATE_T eNextState,
			   struct _NAN_NDP_INSTANCE_T *prNDP) {
	// ...省略空值检查、prNDL 获取...
	eNdpConnectionStatus = NAN_NDP_DISCONNECT;
	do {
		prNDP->eLastNDPProtocolState = prNDP->eCurrentNDPProtocolState;
		prNDP->eCurrentNDPProtocolState = eNextState;
		eLastState = eNextState;

		switch (eNextState) {
		case NDP_IDLE:
			/* stable state */
			break;
		case NDP_INITIATOR_TX_DP_REQUEST:
			prNDP->ucNDPSetupStatus = NAN_ATTR_NDP_STATUS_CONTINUED;
			nanNdpUpdateTypeStatus(prAdapter, prNDP);
			// ...省略 dialog token 生成...
			nanNdpSendDataPathRequest(prAdapter, prNDP);   // 发 Data Path Request NAF
			// ...省略 cnmTimerStartTimer 启动重试定时器...
		// ...省略其余 11 个状态的 case...
		}
	} while (eLastState != eNextState);
	// ...省略返回 NAN_NDP_CONNECTED / NAN_NDP_DISCONNECT...
}
```

NDP 状态机的 12 个状态（`include/nan/nan_data_engine.h:124`），注释直接写明了每个状态干什么：

| 状态                                   | 值   | 含义                               |
| -------------------------------------- | ---- | ---------------------------------- |
| `NDP_IDLE`                             | 0    | 稳定态（空闲）                     |
| `NDP_INITIATOR_TX_DP_REQUEST`          | 1    | Initiator 发 Data Path Request     |
| `NDP_INITIATOR_RX_DP_RESPONSE`         | 2    | Initiator 等 Data Path Response    |
| `NDP_INITIATOR_TX_DP_CONFIRM`          | 3    | Initiator 发 Confirm（可选）       |
| `NDP_INITIATOR_RX_DP_SECURITY_INSTALL` | 4    | Initiator 等安全安装（可选）       |
| `NDP_RESPONDER_WAIT_DATA_RSP`          | 5    | Responder 等上层 DataResponse 命令 |
| `NDP_RESPONDER_TX_DP_RESPONSE`         | 6    | Responder 发 Data Path Response    |
| `NDP_RESPONDER_RX_DP_CONFIRM`          | 7    | Responder 等 Confirm（可选）       |
| `NDP_RESPONDER_TX_DP_SECURITY_INSTALL` | 8    | Responder 发安全安装（可选）       |
| `NDP_NORMAL_TR`                        | 9    | 数据通路已建立（稳定态）           |
| `NDP_TX_DP_TERMINATION`                | 10   | 发 Data Path Termination           |
| `NDP_DISCONNECT`                       | 11   | 释放 NDP，通知 NDL 回收资源        |

- **这 12 态就是规范 §6.2 的 NDP 建立时序的状态机化**：`NDP_INITIATOR_TX_DP_REQUEST → RX_DP_RESPONSE → (TX_DP_CONFIRM / RX_DP_SECURITY_INSTALL) → NDP_NORMAL_TR`，每一步的「发帧 + 启定时器等响应」都在对应 case 里。
- **`do...while(eLastState != eNextState)`** 是关键技巧：一个状态的动作做完会「自推进」到下一个状态，循环直到进入一个稳定态（`NDP_IDLE` / `NDP_NORMAL_TR` / `NDP_DISCONNECT`）或需要等对端帧的状态。这样「一连串能一口气做完的状态迁移」不经过调度器，直接在一个函数里跑完。
- 状态名前缀 `NDP_INITIATOR_*` / `NDP_RESPONDER_*` 已经写明了角色：同一个状态机，Initiator 和 Responder 走不同的分支。这和规范 §6.2.1/6.2.2 里 Initiator/Responder 的不对称行为一一对应。

NDL 管理状态机（`nanNdlMgmtFsmStep`，`nan_data_engine.c:3150`）有 14 个状态（`nan_data_engine.h:99`），管的是 schedule 协商：`NDL_REQUEST_SCHEDULE_NDP/NDL → NDL_SCHEDULE_SETUP → NDL_INITIATOR_TX_SCHEDULE_REQUEST → ... → NDL_SCHEDULE_ESTABLISHED`。它通过 `nanSchedNegoStart` 向 NAN scheduler 组件申请协商许可，最终和 `nanScheduler.c`（15a 那个 10165 行的大家伙）配合，把「两人什么时候在哪个信道醒着传数据」的 NDL CRB 敲定。

> 如果你在想「两套状态机谁驱动谁」——答案是**互相交叉推进**：`nanCmdDataRequest` 先建 NDP、再调 `nanNdlMgmtFsmStep(NDL_REQUEST_SCHEDULE_NDP)` 拉起 NDL 状态机去谈 schedule；NDL 谈成后（`NDL_SCHEDULE_ESTABLISHED`）再回来推进 NDP 状态机去发 Data Path Request。这和规范 §6.2.3.3「NDP setup together with NDL Schedule setup」描述的「先谈 schedule、再发 Request」顺序一致。两个 FSM 的 `TX_*` 状态语义是「在这个状态发对应帧，发完推进到 `RX_*` 等对端帧」——这也是注释里明说的。

⚠️ **「收」侧分发点（主机不可见）**：`nanNdpProcessDataRequest` / `nanNdpProcessDataResponse` / `nanNdpProcessDataConfirm` / `nanNdpProcessDataKeyInstall` / `nanNdpProcessDataTermination` 这五个「收到对端 NAF 后解析」的处理函数，在 `nan_data_engine.h:556-568` 有声明、`nan_data_engine.c:1542/1754/1974/2141/2270` 有定义——它们都接收 `struct SW_RFB *` 收帧缓冲、把它强转成 `struct _NAN_ACTION_FRAME_T` 逐 TLV 解析。但开源树里没有任何代码调用它们：连 NIC 层的动作帧收包入口 `nicRxProcessActionFrame`（`include/nic/nic_rx.h:1804`）都只有声明、没有实现，收帧→按 subtype 分发到这几个 handler 的 glue 整段缺位（在闭源固件或未开源的 HAL）。所以本文只展示状态机的「发」侧（`nanCmd*` → `nanNdpSend*`），「收」侧的帧分发点如实标注「在固件，主机不可见」，不写具体调用链。

---

# 8 4-way handshake 在驱动里怎么落地？

这是第二个灵魂问题的深水区：MTK 为什么在驱动里内嵌完整的 4-way handshake？

回到包厢比喻：包厢开好了，谈的是机密生意，就得**签保密合同**——四步互验身份、交换密钥，合同签完才敢在包厢里递货。这「签合同」在源码里就是 4-way handshake。

答案藏在 `nan_sec.c`（3916 行）的架构里——**它没有从零写一套握手，而是把 hostapd / wpa_supplicant 的 4-way handshake 状态机整个搬进了驱动**（源码树里有 `include/wpa_supp/` 目录，装着 `wpa.c` / `wpa_auth.c` 的头和移植版实现）。`nan_sec.c` 扮演的是「胶水」：把 NAN 的 NDI 地址、PMK、SCID 喂给这套状态机，再把状态机要发的 EAPOL-Key 帧转发到 NAN 空口。

角色映射很反直觉，必须点破：**NAN Initiator 扮演 Authenticator（hostapd/AP 侧，发 M1/M3），NAN Responder 扮演 Supplicant（STA 侧，发 M2/M4）**。这恰好是规范 §7.1.3.5 的原文规定——「The initiator of NDP setup shall take on the RSNA Authenticator role and the responder shall take the role of a RSNA Supplicant」。注意这和「发起者通常当 STA」的直觉相反：**在 NAN 里，主动发起 NDP 的那一方反而当「AP 侧」**。

先看这张 4-way handshake 在 NAN 里的完整时序——它和普通 WiFi 连接的四次握手同构，但消息跑在 NAN Action Frame（NAF）上，地址用的是双方的 NDI：

![NAN NDP 的 4-way handshake（M1-M4）：ND-TKSA 建立](assets/15b-NAN%EF%BC%88%E4%BA%8C%EF%BC%89%E6%95%B0%E6%8D%AE%E9%80%9A%E8%B7%AF%E4%B8%8E%E5%AE%89%E5%85%A8-%E2%80%94-%E4%BB%8E-NDP-%E5%BB%BA%E7%AB%8B%E5%88%B0-4-way-handshake-%E4%B8%8E%E6%B5%8B%E8%B7%9D/15b-handshake.svg)

握手入口 `nanSecNotify4wayBegin`，由 `nanCmdDataRequest`（Initiator）或 `nanCmdDataResponse`（Responder）在需要安全时调用：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/nan/nan_sec.c:2644
uint32_t
nanSecNotify4wayBegin(struct _NAN_NDP_INSTANCE_T *prNdp) {
	// ...省略日志...
	if (prNdp->eNDPRole == NAN_PROTOCOL_INITIATOR) {
		nanSecUpdatePmk(prNdp);                 // 把 PMK 搬进 wpa 状态机

		prNdp->prInitiatorSecSmInfo->u1MicCalState = NAN_SEC_MIC_CAL_IDLE;
		prNdp->prInitiatorSecSmInfo->wpa_auth = &g_rNanWpaAuth;
		prNdp->prInitiatorSecSmInfo->pvNdp = (void *)prNdp;
		// ...省略 wpa_auth->pvNdp 回填...
		wpa_auth_sta_init(prNdp->prInitiatorSecSmInfo->wpa_auth,
				  prNdp->prInitiatorSecSmInfo->addr, NULL);
		hostapd_wpa_auth_set_bssid(g_prNanHapdData,
			nanGetSpecificBssInfo(g_prAdapter, NAN_BSS_INDEX_BAND0)->aucClusterId);
		hostapd_wpa_auth_set_ownmac(g_prNanHapdData, prNdp->aucLocalNDIAddr);
		wpa_auth_sta_associated(&g_rNanWpaAuth, prNdp->prInitiatorSecSmInfo);
	} else {
		/* NAN_NDP_RESPONDER */
		prNdp->prResponderSecSmInfo->u1MicCalState = NAN_SEC_MIC_CAL_IDLE;
		prNdp->prResponderSecSmInfo->pvNdp = (void *)prNdp;
		g_prNanWpaSupp->wpa = prNdp->prResponderSecSmInfo;
		nanSecUpdatePeerNDI(prNdp, prNdp->aucPeerNDIAddr);
		wpa_supplicant_set_ownmac(g_prNanWpaSupp, prNdp->aucLocalNDIAddr);
		nan_sec_wpa_sm_init(&g_rNanWpaSmCtx, prNdp);   // 初始化 STA 侧 wpa_sm
		nanSecUpdatePmk(prNdp);
		wpa_supplicant_set_bssid(g_prNanWpaSupp, prNdp->aucPeerNDIAddr);
	}
	wpa_SYSrand_Gen_Rand_Seed(prNdp->aucLocalNDIAddr);
	return 0;
}
```

- **Initiator 走 hostapd 侧**：`wpa_auth_sta_init` → `wpa_auth_sta_associated` 初始化 AP 侧状态机，之后它会以「Authenticator」身份主动发 M1。**Responder 走 wpa_supplicant 侧**：`nan_sec_wpa_sm_init` 初始化 STA 侧 `wpa_sm`，之后以「Supplicant」身份等 M1、回 M2。
- **`hostapd_wpa_auth_set_ownmac` / `wpa_supplicant_set_ownmac` 把「自己的数据面地址」当作握手里的 MAC**：4-way handshake 的 PTK 推导要绑定 `IAddr || RAddr`（Initiator 和 Responder 的 MAC），在 NAN 里这俩就是**双方的 NDI 地址**（不是 NMI）。这就是规范 §7.1.3.5 里「IAddr and RAddr are NDP Initiator and NDP Responder MAC addresses」的落地。
- **`wpa_SYSrand_Gen_Rand_Seed`**：4-way handshake 需要的 Nonce 随机性，种子取自本地 NDI 地址。

PMK 怎么进来？`nanSecSetPmk`（`nan_sec.c:2617`）把上层传下来的 PMK 拷进状态机的 `au1Psk[]` 字段，`nanSecUpdatePmk`（`nan_sec.c:3015`）再搬进 wpa 状态机的 `pmk`。而真正的 PTK 派生**不在 nan_sec.c**，在移植过来的 `wpa_pmk_to_ptk`（`wpa_supp/src/common/wpa_common.c:153`）里：

```
PTK = PRF-Length(PMK, "Pairwise key expansion", AA || SA || ANonce || SNonce)
```

这正是规范 §7.1.3.5 的公式——NAN 里写作 `PRF-Length(ND-PMK, "NAN Pairwise key expansion", IAddr || RAddr || Inonce || Rnonce)`，只是 `AA||SA` 换成了 `IAddr||RAddr`。**MTK 复用了 802.11 的 `wpa_pmk_to_ptk`，把 NAN 的地址/Nonce 映射进去，就得到了 ND-TK（NAN 的 Temporal Key）**。

密码套件和 SCID 的定义都在 `nan_base.h`：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/nan/nan_base.h:278
#define NAN_CIPHER_SUITE_ID_NONE 0
#define NAN_CIPHER_SUITE_ID_NCS_SK_CCM_128 1
#define NAN_CIPHER_SUITE_ID_NCS_SK_GCM_256 2
#define NAN_SCID_DEFAULT_LEN 16
```

- **`NAN_CIPHER_SUITE_ID_NCS_SK_CCM_128` / `NCS_SK_GCM_256`** 对应规范 §7.1.2 的 `NCS-SK-128`（CCMP-128/SHA-256/HMAC-SHA-256）和 `NCS-SK-256`（GCMP-256/SHA-384/HMAC-SHA-384）。MTK 这一版只实现了共享密钥（NCS-SK）两档，公钥（NCS-PK-2WDH）没在开源树里。
- **SCID（Security Context Identifier）固定为类型 1 = PMKID**（`nan_sec.c:2388` 注释 `= 1 /* PMKID */`）。SCID 用来标识「这次安全上下文用的是哪把长期密钥」，长度 16 字节。它对应规范 §7.1.3 里「SCID used to identify the context of the security setup」。
- Framework 侧的密码套件常量（`Characteristics.java:295`）是另一套编号：`WIFI_AWARE_CIPHER_SUITE_NCS_SK_128 = 1<<0`、`NCS_SK_256 = 1<<1`、`NCS_PK_128 = 1<<2`、`NCS_PK_256 = 1<<3`——**Framework 用位图，MTK 驱动用整数编号，跨层要翻译**，这正是本文结尾「跨层字段映射表」要列的差异。

而 QCOM 呢？**它的 4-way handshake 也在固件**。主机 HAL 的 `nan_data_request_initiator`（`nan.cpp:1591`）会把 PMK/passphrase 直接塞进 `QCA_WLAN_VENDOR_ATTR_NDP_PMK` / `PASSPHRASE` 属性（`qca-vendor.h:8978/8984`），WMI 下发时这些密钥随 `nan_ndp_initiator_req_tlv` 一起进固件，**主机全程不碰握手的 M1-M4**。这和第 6 节的「NDP 状态机在固件」是一体的：协商在固件，握手自然也一起在固件。

> 一句话回答这个深水区问题：**MTK 把 4-way handshake 搬进驱动，是为了「数据通路全链路都在内核/驱动里闭环」**——既然 MTK 已经选了「胖主机」（NDP/NDL 状态机都在主机驱动里，第 7 节），那安全握手如果还丢给用户态 supplicant 做，就得多一次用户态↔内核的搬运，割裂了整套主机侧的 NAN 数据通路。所以它直接把 wpa 状态机「请」进驱动，用 nan_sec.c 当胶水。这与「MTK 主机重活 vs QCOM 固件卸载」的系列主线完全一致：**QCOM 把活甩给固件，MTK 把活揽进驱动，殊途同归，都不让用户态碰数据面**。

---

# 9 测距的距离是从哪个寄存器抠出来的？

最后一个特性：测距（ranging）。包厢签完了合同，还有个原始的好奇心——**对方到底离我几米**？规范 §8 把它定义成 NAN Ranging 组件，用 FTM（Fine Timing Measurement，802.11 的精确定时测量）算出两台设备的距离，还支持 geofencing（进出地理围栏时触发事件）。

在 Android Framework 侧，测距**不是一个独立 API**，而是挂在发现会话上的一个开关：`PublishConfig` / `SubscribeConfig` 里的 `mEnableRanging`（15a 提过一嘴）。开启后，match 事件可以带距离（`onMatchWithDistance`，`rangeMm` 字段），也可以持续上报（`notifyRangingResults` → `onRangingResultsReceived`）。真正算距离的活，在驱动/固件。

MTK 的 `nan_ranging.c`（2384 行）是主机侧实现。测距请求入口 `nanRangingRequest`（`nan_ranging.c:2012`），状态机有 9 态：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/nan/nan_ranging.h:53
enum _ENUM_RANGING_STATE_T {
	RANGING_STATE_IDLE = 0,
	RANGING_STATE_INIT,
	RANGING_STATE_SCHEDULE,
	RANGING_STATE_REQUEST,
	RANGING_STATE_REQUEST_IND,
	RANGING_STATE_RESPONSE,
	RANGING_STATE_ACTIVE,
	RANGING_STATE_REPORT,
	RANGING_STATE_TERMINATE,
	RANGING_STATE_NUM
};
```

- 这和 NDP 状态机一个风格：`SCHEDULE`（先谈好什么时候测）→ `REQUEST`/`REQUEST_IND`（发/收测距请求）→ `RESPONSE` → `ACTIVE`（FTM 测量进行中）→ `REPORT`（上报结果）→ `TERMINATE`。对应规范 §8.3.4 的 ranging session setup 流程。
- FTM 参数下发到固件由 `nanRangingFtmParamCmd`（`nan_ranging.c:1570`）组 TLV `NAN_CMD_FTM_PARAM`，把 `_NAN_FTM_PARAM_T`（带宽、burst 次数、ASAP 标志等）交给固件执行实际测量。

固件测完，把结果经 `nanRangingFtmDoneEvt` 事件回灌，主机解析出距离。距离的原始值是 FTM 的「1/4096 米」单位，要换算成厘米：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/nan/nan_ranging.h:204
#define FTM_FMT_TO_RANGE_CM(_ftm_fmt) (((_ftm_fmt & BITS(0, 23)) * 100) >> 12)

// MTK/kernel_modules-connectivity-wlan-core-gen4m/nan/nan_ranging.c:1636
nanRangingUpdateDistance(struct ADAPTER *prAdapter,
			 struct _NAN_RANGING_INSTANCE_T *prRanging) {
	struct _NAN_RANGING_CTRL_T *pCtrl;
	uint32_t u4IngressTh;
	uint32_t u4EgressTh;

	pCtrl = (struct _NAN_RANGING_CTRL_T *)&prRanging->ranging_ctrl;
	u4IngressTh = pCtrl->ranging_cfg.distance_ingress_cm;
	u4EgressTh = pCtrl->ranging_cfg.distance_egress_cm;

	if ((pCtrl->rNanFtmReport.ucRangeEntryCnt == 0) ||
	    (pCtrl->rNanFtmReport.arRangeEntry[0].u4Range == 0)) {
		DBGLOG(NAN, INFO, "No valid distance to update\n");
		return FALSE;
	}
	/* Support only one now, get it directly */
	pCtrl->range_measurement_cm = FTM_FMT_TO_RANGE_CM(
		pCtrl->rNanFtmReport.arRangeEntry[0].u4Range);
	// ...省略日志...
	/* Ingress geofence */
	pCtrl->bPreInside = pCtrl->bCurInside;
	pCtrl->bCurInside = (pCtrl->range_measurement_cm <= u4IngressTh);

	/* Egress geofence */
	pCtrl->bPreOutside = pCtrl->bCurOutside;
	pCtrl->bCurOutside = (pCtrl->range_measurement_cm >= u4EgressTh);

	return TRUE;
}
```

- **`FTM_FMT_TO_RANGE_CM`** 是「距离从哪抠出来」的答案：FTM 报告里的 `u4Range` 字段是 24 位整数、单位 1/4096 米。宏先 `& BITS(0,23)` 取低 24 位、`* 100` 换算成「1/4096 米的百分之一」、再 `>> 12`（除以 4096），得到厘米。一句话：**距离不是芯片直接给的「米数」，而是时间测量换算出的一个 1/4096 米单位的定点数，主机用宏还原成厘米**。
- **geofencing 是「阈值比较」不是「坐标计算」**：`nanRangingUpdateDistance` 里用 `distance_ingress_cm` / `distance_egress_cm` 两个阈值，判断「进入（inside）」还是「离开（outside）」围栏。`nanRangingGeofencingCheck`（`nan_ranging.c:1684`）再比对 `bPreInside/bCurInside` 的跳变，产出 `NAN_RANGING_INDICATE_INGRESS_MET_MASK / EGRESS_MET_MASK` 指示位——**只有跨过阈值的那一刻才上报事件**，围栏内外持续待着不打扰。这正是规范 §8.1 里「egress and ingress geofences」的语义。换句话说，围栏就是「给这间包厢画了个半径圈，你跨出圈外才喊一嗓子」——不实时广播距离，只在进出那一下触发。
- 最终 `nanRangingResult`（`nan_ranging.c:2212`）把距离和事件类型打成 `NanRangeReportInd`，经 netlink 上抛用户态，一路回到 Framework 的 `notifyRangingResults` / `onMatchWithDistance`。

> 如果你在纠结「FTM 和 Aware ranging 是不是一回事」——FTM 是 802.11mc 定义的精确定时测量协议，Aware ranging 只是**借用 FTM 作为测距手段**（规范 §8.3.8「The fine timing measurement (FTM) procedure... is used」）。所以你会看到 `nan_ranging.c` 里全是 `FTM_*` 前缀的参数和宏。测距这件事，QCOM 也是甩给固件（WMI 下发 ranging 命令），主机不建 FTM 状态机——又是「QCOM 卸载 / MTK 主机」的同一分叉。

---

# 10 总结——一条「申请 → 状态机 → 空口」的链

# 全链路回顾

```
App.requestNetwork(WifiAwareNetworkSpecifier)      // 拿包厢门牌
  → [Binder] ConnectivityService
  → WifiAwareNetworkFactory.acceptRequest()        校验 specifier、解析成 nnri
  → WifiAwareNetworkFactory.needNetworkFor()        Initiator 下单 / Responder 待命
  → WifiAwareStateManager.initiateDataPathSetup()   打包 COMMAND_TYPE_INITIATE_DATA_PATH_SETUP
  → initiateDataPathSetupLocal() → WifiAwareNativeApi.initiateDataPath()
  → [HIDL/AIDL] WifiNanIface.initiateDataPath()     跨 HAL 进程
  → vendor command（QCA_NL80211_VENDOR_SUBCMD_NDP / MTK_SUBCMD_NDP）
      ├─ QCOM：wlan_hdd_cfg80211_process_ndp_cmd → os_if_nan → WMI_NDP_INITIATOR_REQ_CMDID
      │        → 固件（NDP 状态机 + 4-way handshake 全在固件）
      │        ← NDP_INDICATION → lim_add_ndi_peer → wma_add_sta_ndi_mode（建数据面 peer）
      └─ MTK：nanCmdDataRequest → nanNdlMgmtFsmStep + nanDataPathProtocolFsmStep（双层 FSM）
              → nanSecNotify4wayBegin（4-way handshake，复用 wpa 状态机）
  ← onDataPathConfirm（固件通知 NDP 建好）
  ← handleAddressValidation（配 IPv6 link-local → 建 WifiAwareNetworkAgent → markConnected）
  ← App.onAvailable(network) → socket bind → 收发数据
```

# 三个设计权衡

1. **Framework 复用 ConnectivityService 而非独立 API**：App 拿标准 `Network`，DNS/路由/权限/socket 全复用，一条 NDP 落地为一个 `NetworkAgent` 虚拟网卡。`WifiAwareDataPathStateManager` 只管「两本账」（`NdpInfo` + `AwareNetworkRequestInformation`）+ 一个 `NetworkFactory`，不碰任何 NDP 协议逻辑。
2. **supplicant 不做 NDP，全 offload 给驱动/固件**：数据面要性能、要毫秒级 schedule 配合，用户态转发不划算。supplicant 只留 `nan.h` 的 NDP/NDL/NDC 属性 ID + `qca-vendor.h` 的 vendor 命令定义，实际实现全在驱动/固件。
3. **驱动双平台分歧（系列主线的延续）**：QCOM 瘦主机胖固件（主机 `nan_main.c` 只记账 + 建 NDI，NDP 状态机和 4-way handshake 全在固件，WMI 下发）；MTK 胖主机瘦固件（主机 `nan_data_engine.c` 两套 FSM + `nan_sec.c` 内嵌 wpa 状态机 + `nan_ranging.c` FTM 测距）。殊途同归：数据面控制逻辑都不在用户态。

# 常量 / 超时 / 事件速查

| 常量                                    | 值                 | 定义位置                                 | 说明                                               |
| --------------------------------------- | ------------------ | ---------------------------------------- | -------------------------------------------------- |
| `COMMAND_TYPE_INITIATE_DATA_PATH_SETUP` | 116                | `WifiAwareStateManager.java:224`         | 下发 NDP 建立命令                                  |
| `AWARE_WAIT_FOR_DP_CONFIRM_TIMEOUT`     | 20 000 ms          | `WifiAwareStateManager.java:2232`        | 等 confirm 超时                                    |
| `ADDRESS_VALIDATION_RETRY_INTERVAL_MS`  | 1 000 ms           | `WifiAwareDataPathStateManager.java:103` | IPv6 地址验证重试间隔                              |
| `ADDRESS_VALIDATION_TIMEOUT_MS`         | 5 000 ms           | `WifiAwareDataPathStateManager.java:105` | IPv6 地址验证超时                                  |
| `AWARE_INTERFACE_PREFIX`                | `"aware_data"`     | `WifiAwareDataPathStateManager.java:95`  | NDI 虚拟网卡名前缀                                 |
| `NETWORK_FACTORY_SCORE_AVAIL`           | 1                  | `WifiAwareDataPathStateManager.java:98`  | 工厂分数（不参与择优）                             |
| `QCA_NL80211_VENDOR_SUBCMD_NDP`         | 81                 | `qca-vendor.h:1373`                      | QCOM NDP vendor 命令                               |
| `NAN_ATTR_NDP` / `NDC` / `NDL`          | 0x10 / 0x13 / 0x14 | `nan.h`                                  | NDP/NDC/NDL 属性 ID（NDC=数据簇 NAN Data Cluster） |
| `NAN_CIPHER_SUITE_ID_NCS_SK_CCM_128`    | 1                  | `nan_base.h:279`                         | MTK 密码套件（CCM-128）                            |
| `NAN_SCID_DEFAULT_LEN`                  | 16                 | `nan_base.h:283`                         | SCID 长度                                          |
| `WMI_VDEV_TYPE_NDI`                     | 0x7                | `wmi_unified.h:17656`                    | NDI vdev 类型                                      |
| `WMI_PEER_TYPE_NAN_DATA`                | 4                  | `wmi_unified.h:21410`                    | 数据面 peer 类型                                   |
| Data Path 帧 subtype                    | 5/6/7/8/9          | 规范 Table 35                            | Request/Response/Confirm/Key Install/Termination   |
| NDP setup 无/有安全                     | §6.2.1 / §6.2.2    | 规范                                     | 无安全 3 帧 / 有安全 4-way handshake               |

# 跨层字段映射（同一份信息的四层登记）

| 概念                | Framework                                         | HAL/vendor                            | 驱动/固件                                            |
| ------------------- | ------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| NDP ID              | `ndpId`（`NdpInfo`）                              | `NDP_INSTANCE_ID` / `ndp_instance_id` | `ucNDPID`（MTK）/ `ndp_instance_id`（QCOM）          |
| 对端发现地址（NMI） | `peerDiscoveryMac`                                | `NDP_PEER_DISCOVERY_MAC_ADDR`         | 用于匹配 peer 的 discovery MAC                       |
| 对端数据地址（NDI） | `peerDataMac`                                     | `NDP_NDI_MAC_ADDR`                    | `peer_ndi_mac_addr`（QCOM）/ `aucPeerNDIAddr`（MTK） |
| PMK                 | `WifiAwareDataPathSecurityConfig.mPmk`            | `NDP_PMK`（32 字节）                  | `aucPMK`（MTK）                                      |
| passphrase          | `mPassphrase`                                     | `NDP_PASSPHRASE`（63 字节）           | vendor HAL `ndp_passphrase_to_pmk` 转 PMK            |
| 密码套件            | `WIFI_AWARE_CIPHER_SUITE_NCS_SK_128=1<<0`（位图） | `NDP_CSID`                            | `NAN_CIPHER_SUITE_ID_NCS_SK_CCM_128=1`（整数）       |
| SCID                | `scid`（match 事件携带）                          | `NDP_SCID`（1024 字节缓冲）           | `au1Scid`（16 字节，MTK）                            |
| port/传输协议       | `peerPort` / `peerTransportProtocol`              | `NDP_TRANSPORT_PORT/PROTOCOL`         | NDPE 的 Generic Service Protocol TLV                 |

---

**本章追完了「数据通路」这条线：App 的 `requestNetwork` 怎么伪装成标准网络请求、Framework 怎么用两本账把每条 NDP 落地成虚拟网卡、supplicant 怎么被排除在数据面之外、QCOM 怎么一条 WMI 命令甩给固件、MTK 怎么在驱动里写两套 FSM 还搬进整套 wpa 握手、距离怎么从一个 1/4096 米的定点数里抠出来。**

但有个问题悬在半空——**Aware 的测距只回答了「对方离我几米」，而且精度受限于 FTM 的 1/4096 米量化**。那 Android 里另一套更精确、能到厘米级、还带 AP 坐标的室内测距是什么？它和 Aware ranging 共用同一个底层机制吗？

下一章，我们从 `WifiRttManager` 追起，看 802.11mc 的 RTT/FTM 在 Android 里怎么从 App 一路测到 AP。
