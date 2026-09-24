---
title: NAN（一）服务发现 — 从 attach 到服务匹配
top: 1
related_posts: true
abbrlink: a60da329
date: 2026-09-24 23:36:21
tags:
  - Android WiFi
  - NAN
categories:
  - WiFi
  - Code
---

> 前情提要：姊妹系列《Wi-Fi Aware（NAN）— 广场上的兴趣广播》已经把 NAN 的协议层讲透了——簇怎么自发"对表"、Discovery Window 为什么钉死信道 6、Anchor Master 怎么选举、SDF/USD/NDP 各是什么。本篇不再重讲协议，只回答一个问题：**这些协议概念，落到 Android 源码里分别由哪一层、哪个函数来实现？**

---

# 本章导读

你走进一个没有管理员的大广场，想找"附近哪台打印机能用"。协议告诉你：大家约定每隔 524 ms 聚到广场中央 16 ms，在信道 6 上互相喊话（Discovery Window）；供需对上的两个人再单独走到一边交换联系方式（NDP）。

<!--more-->

但一个学源码的人会追问：**广场上到底是谁在举牌、谁在对表、谁在传话？** 这套机制在 Android 里不是一块代码，而是横跨了三个截然不同的代码世界——Java Framework、wpa_supplicant 的 C、驱动/固件的 C。而且这三层的"胖瘦"分配，藏着两个反直觉的设计决策：

- 为什么一台手机明明有十几个 App 同时用 Aware，底层却**只有一个 NAN 引擎**？
- 为什么 wpa_supplicant 只肯做"不用对表的 USD"、把"要对表的同步发现"甩给驱动/固件？

**本章你将学到**：一次 `attach` 从应用一路穿透到驱动固件的完整调用链；`mergeConfigRequests()` 怎么把多个 App 的诉求合并成一个簇；supplicant 的 `nan_de.c` 怎么用纯 `eloop` 定时器在用户态实现 USD 匹配；QCOM 和 MTK 对"发现到底放主机还是固件"给出的相反答案；以及一个 `match` 事件怎么逐层回调回 App。

> **边界声明（PS）**：本文只讲**服务发现**（attach → publish/subscribe → match）。NAN Data Path（NDP/NDL）、4-way handshake 安全、测距（ranging）属 15b，不展开；同步（cluster 形成 / Master 选举）的协议细节姊妹篇已讲，本文只做"源码在哪一层"的映射。

---

# 1 一次「感知附近」，代码走了几层？——三层分工与跨进程边界

先看全景。下图是本文一整条主线的骨架：左到右是调用方向，虚线是跨进程/跨模块边界。

![NAN 服务发现全局调用链](assets/15a-NAN%EF%BC%88%E4%B8%80%EF%BC%89%E6%9C%8D%E5%8A%A1%E5%8F%91%E7%8E%B0-%E2%80%94-%E4%BB%8E-attach-%E5%88%B0%E6%9C%8D%E5%8A%A1%E5%8C%B9%E9%85%8D/15a-architecture-callchain.svg)

三层分工一句话总结：

| 层             | 文件                                                         | 干什么                                                  | 胖瘦         |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ------------ |
| **Framework**  | `WifiAwareStateManager.java`（5878 行）                      | 串行状态机、多 client 簇共享、配置合并                  | **厚**       |
| **supplicant** | `src/common/nan_de.c`（1458 行）+ `wpa_supplicant/nan_usd.c`（534 行） | USD 引擎：publish/subscribe/follow-up 的 SDF 收发与匹配 | **只做 USD** |
| **驱动/固件**  | QCOM `nan_main.c` / MTK `nanScheduler.c`（10165 行）         | 同步发现（DW 16 ms 时序）+ 发现执行                     | 双平台分歧   |

三条关键边界，也是本文每次跨层都会踩的点：

1. **Binder 边界**：App → SystemServer（`WifiAwareServiceImpl`）。
2. **HIDL/AIDL 边界**：SystemServer → HAL 进程（`IWifiNanIface`）。
3. **控制接口 / nl80211 边界**：supplicant 的 USD 引擎 ↔ 驱动。

> 一个重要的事实铺垫：从 Framework 往下走，HAL 的 `IWifiNanIface` 实际有**两个实现**。一条是厂商 HAL（QCOM/MTK 的 `nan.cpp`）直接对着驱动/固件——这是经典 NAN 的路；另一条是 wpa_supplicant 新加的 USD 引擎（R4 引入），通过控制接口 `NAN_PUBLISH`/`NAN_SUBSCRIBE` 驱动。二者在驱动处汇合。本文以"Framework 主链 + supplicant USD 引擎"为主线展开，厂商 HAL 那条路放到第 11 节对比 QCOM/MTK 时讲清楚。

下面开始追主线。

---

# 2 attach 到 clientId：Framework 的门卫干了什么？

App 侧的第一声是 `WifiAwareManager.attach()`。它自己不做事，把参数打包后走 Binder 交给 SystemServer 里的 `WifiAwareServiceImpl`。

```java
// packages_modules_Wifi/framework/java/android/net/wifi/aware/WifiAwareManager.java:561
public void attach(Handler handler, ConfigRequest configRequest,
        AttachCallback attachCallback,
        IdentityChangedListener identityChangedListener, boolean forOffloading,
        Executor executor) {
    // ...日志与参数校验省略...
    synchronized (mLock) {
        Executor localExecutor = executor;
        // ...省略 executor 兜底...
        try {
            Binder binder = new Binder();
            Bundle extras = new Bundle();
            // ...省略 attribution source...
            mService.connect(binder, mContext.getOpPackageName(), mContext.getAttributionTag(),
                    new WifiAwareEventCallbackProxy(this, localExecutor, binder,
                            attachCallback, identityChangedListener), configRequest,
                    identityChangedListener != null, extras, forOffloading);
        } catch (RemoteException e) {
            throw e.rethrowFromSystemServer();
        }
    }
}
```

- `mService` 是 `IWifiAwareManager` 的 Binder 代理，`connect()` 跨进程打进 SystemServer。
- 注意 `new Binder()`：这个 token 会被服务端 `linkToDeath`，App 进程死了要能自动清理。
- `WifiAwareEventCallbackProxy` 是回调代理——App 传进去的 `AttachCallback` 被包了一层，将来 match 事件会经它弹回 App 进程。

服务端入口 `WifiAwareServiceImpl.connect()`，干三件事：**权限校验 → 分配 clientId → 挂 DeathRecipient**。

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareServiceImpl.java:311
@Override
public void connect(final IBinder binder, String callingPackage, String callingFeatureId,
        IWifiAwareEventCallback callback, ConfigRequest configRequest,
        boolean notifyOnIdentityChanged, Bundle extras, boolean forOffloading) {
    enforceAccessPermission();
    enforceChangePermission();

    final int uid = getMockableCallingUid();
    mWifiPermissionsUtil.checkPackage(uid, callingPackage);
    // ...省略 callback/binder/extras 空值校验、notifyOnIdentityChanged 与 offload 权限校验...
    // ...省略 configRequest 的权限裁剪与 validate()...
    final int clientId;
    synchronized (mLock) {
        clientId = mNextClientId++;
    }

    IBinder.DeathRecipient dr = new IBinder.DeathRecipient() {
        @Override
        public void binderDied() {
            binder.unlinkToDeath(this, 0);
            synchronized (mLock) {
                mDeathRecipientsByClientId.delete(clientId);
                mUidByClientId.delete(clientId);
            }
            mStateManager.disconnect(clientId);
        }
    };
    try {
        binder.linkToDeath(dr, 0);
    } catch (RemoteException e) {
        // ...省略 onConnectFail 回调...
        return;
    }
    // ...省略 mDeathRecipientsByClientId / mUidByClientId 记账...
    mStateManager.connect(clientId, uid, pid, callingPackage, callingFeatureId, callback,
            configRequest, notifyOnIdentityChanged, extras, forOffloading);
}
```

- **clientId 是全局自增的整数**（`mNextClientId++`），不是每个 App 一个命名空间——这就是"多 client 共享一个引擎"的伏笔：所有 App 的会话都登记在同一个 `mStateManager` 里。
- **`binderDied()` 是兜底清理**：App 没走正常 `disconnect()` 就死了，Binder 死亡通知会替它把 clientId 的会话全部拆掉。否则一个 crash 的 App 会把它的 publish 会话永远留在空中广播。
- 最后 `mStateManager.connect(...)` —— `mStateManager` 就是 `WifiAwareStateManager`，整个 Aware 的"大脑"。

到这里，你手里已经有一个 clientId 了。但注意：**到现在为止，还没碰过 HAL、没碰过 supplicant、没碰过驱动**。clientId 只是 SystemServer 内存里的一个编号。真正的引擎在哪？下一节。

---

# 3 为什么一台手机只有一个 NAN 引擎？——mergeConfigRequests 簇共享

这是本文第一个灵魂问题。答案藏在 `WifiAwareStateManager.connectLocal()` 里，而它的核心是 `mergeConfigRequests()`。

`connectLocal()` 先做一个关键判断：**新的这个 client 的 ConfigRequest，跟现有所有 client 合并之后，如果和当前已经下发给 HAL 的配置一样，就根本不用再动 HAL**——只是给新 client 发一张"你已加入"的门票。

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareStateManager.java:3788
private boolean connectLocal(short transactionId, int clientId, int uid, int pid,
        String callingPackage, @Nullable String callingFeatureId,
        IWifiAwareEventCallback callback, ConfigRequest configRequest,
        boolean notifyIdentityChange, Object attributionSource, boolean awareOffload,
        boolean reEnableAware, int callerType) {
    // ...省略 mUsageEnabled 检查、日志...
    ConfigRequest merged = mergeConfigRequests(configRequest);
    if (merged == null) {
        // ...省略 onConnectFail：配置不兼容...
        return false;
    }

    if (mCurrentAwareConfiguration != null && mCurrentAwareConfiguration.equals(merged)
            && (mCurrentIdentityNotification || !notifyIdentityChange)
            && !reEnableAware) {
        // 已下发过同样的配置：不再打扰 HAL，直接给新 client 发门票
        WifiAwareClientState client = new WifiAwareClientState(mContext, clientId, uid, pid,
                callingPackage, callingFeatureId, callback, configRequest, notifyIdentityChange,
                SystemClock.elapsedRealtime(), mWifiPermissionsUtil, attributionSource,
                awareOffload, callerType);
        client.enableVerboseLogging(mVerboseLoggingEnabled, mVdbg);
        client.onClusterChange(mClusterEventType, mClusterId, mCurrentDiscoveryInterfaceMac);
        mClients.append(clientId, client);
        // ...省略 recordAttachSession、onConnectSuccess、replaceRequestorWs...
        return false;
    }
    // ...省略：需要重新 enableAndConfigure 的分支，见下文...
    boolean success = mWifiAwareNativeApi.enableAndConfigure(transactionId, merged,
            notificationRequired, initialConfiguration,
            mPowerManager.isInteractive(), mPowerManager.isDeviceIdleMode(),
            rangingRequired, enableInstantMode, instantModeChannel, mClusterIdInt);
    // ...省略失败清理...
    return success;
}
```

为什么能这样"偷懒"？因为**设备上只有一个 NAN 引擎、一个簇、一个 Discovery Window**。协议里，一台设备加入某个簇之后，它的 DW 时序、信道、Master Preference 都是簇级的——不可能为 App A 开一个簇、为 App B 再开一个簇同时广播。所以 Framework 必须把"所有 App 想怎么感知"合并成**一份**设备级配置，只对 HAL 下发一次。

合并逻辑就是 `mergeConfigRequests()`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareStateManager.java:5542
private ConfigRequest mergeConfigRequests(ConfigRequest configRequest) {
    // ...省略日志、mClients 空校验...
    boolean support5gBand = false;
    boolean support6gBand = false;
    int masterPreference = 0;
    boolean clusterIdValid = false;
    int clusterLow = 0;
    int clusterHigh = ConfigRequest.CLUSTER_ID_MAX;
    int[] discoveryWindowInterval =
            {ConfigRequest.DW_INTERVAL_NOT_INIT, ConfigRequest.DW_INTERVAL_NOT_INIT};
    List<OuiKeyedData> vendorData = null;
    if (configRequest != null) {
        // ...省略：从入参 configRequest 初始化...
    }
    for (int i = 0; i < mClients.size(); ++i) {
        ConfigRequest cr = mClients.valueAt(i).getConfigRequest();

        // any request turns on 5G / 6G
        if (cr.mSupport5gBand) {
            support5gBand = true;
        }
        if (cr.mSupport6gBand) {
            support6gBand = true;
        }
        // maximal master preference
        masterPreference = Math.max(masterPreference, cr.mMasterPreference);
        // cluster range must be the same across all config requests
        if (!clusterIdValid) {
            clusterIdValid = true;
            clusterLow = cr.mClusterLow;
            clusterHigh = cr.mClusterHigh;
        } else {
            if (clusterLow != cr.mClusterLow) return null;
            if (clusterHigh != cr.mClusterHigh) return null;
        }
        for (int band = ConfigRequest.NAN_BAND_24GHZ; band <= ConfigRequest.NAN_BAND_5GHZ;
                ++band) {
            // ...省略 DW_INTERVAL_NOT_INIT / DW_DISABLE 的合并，其余取最小值...
            discoveryWindowInterval[band] = Math.min(discoveryWindowInterval[band],
                    cr.mDiscoveryWindowInterval[band]);
        }
        // ...省略 vendorData...
    }
    ConfigRequest.Builder builder = new ConfigRequest.Builder().setSupport5gBand(support5gBand)
            .setMasterPreference(masterPreference).setClusterLow(clusterLow)
            .setClusterHigh(clusterHigh);
    // ...省略 discoveryWindowInterval / vendorData 回填...
    return builder.build();
}
```

合并规则，翻译成广场黑话就是：

| 配置项                              | 合并规则                                | 广场比喻                                   |
| ----------------------------------- | --------------------------------------- | ------------------------------------------ |
| `mSupport5gBand` / `mSupport6gBand` | **任一开启即开启**（逻辑或）            | 只要有一个人想用 5G 频道，广场就开 5G 场次 |
| `mMasterPreference`                 | **取最大值**                            | 谁的喇叭最响（最想当 Master），听谁的      |
| `mClusterLow` / `mClusterHigh`      | **必须一致，否则返回 null**             | 大家必须在同一个簇号里，谈不拢就拒绝       |
| `mDiscoveryWindowInterval`          | **取最小值**（`DW_DISABLE` 视为无穷大） | 谁要最频繁地碰头，就按最勤的那个来         |

- **`clusterLow/clusterHigh` 不一致 → 返回 `null` → `onConnectFail`**：这是唯一会让 attach 直接失败的配置冲突——两个 App 要求加入不同的簇，一个引擎没法同时满足。注意这里 `return null` 后面是 `INTERNAL_FAILURE`，并没有一个更细的"配置冲突"错误码。
- **Master Preference 取最大**：协议 §3.3.3 里 Master Rank = Master Preference + Random Factor + NAN Interface Address，Preference 越大越倾向当 Master。多 App 共享时，取最大 Preference 意味着"设备作为一个整体，用最激进的那个 App 的意愿去竞选 Master"。
- **DW 间隔取最小**：谁要更频繁地醒着，就迁就谁。省电的那方只能跟着更勤快的邻居一起醒。

> 如果你在想"那 App 会不会因为别人的配置被强制改了簇号而感知不到"——答案是：App 传进来的 `ConfigRequest` 在 `WifiAwareServiceImpl.connect()` 里先被 `validate()` 校验过范围，而真正生效的是合并后的结果。App 侧的 `ConfigRequest` 本质是"意愿"，不是"合同"。

这就是设计决策一：**簇只有一个、DW 只有一个，所以多 App 必须共享一个 NAN 引擎，Framework 负责把 N 份意愿合并成 1 份**。

---

# 4 30+ 命令怎么串行排队？——WifiAwareStateMachine

合并只是"算"。算完之后谁来"执行"？`WifiAwareStateManager` 内部跑着一个 `StateMachine`，所有命令（attach、publish、subscribe、datapath……）都丢进同一个消息队列**串行处理**。

`WifiAwareStateMachine` 的定义：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareStateManager.java:2209
class WifiAwareStateMachine extends StateMachine {
    private static final int TRANSACTION_ID_IGNORE = 0;
    private final DefaultState mDefaultState;
    private final WaitState mWaitState;
    private final WaitForResponseState mWaitForResponseState;
    private final WaitingState mWaitingState = new WaitingState(this);

    private short mNextTransactionId = 1;
    public int mNextSessionId = 1;

    private Message mCurrentCommand;
    private short mCurrentTransactionId = TRANSACTION_ID_IGNORE;

    // ...省略 send-message 队列、data path / pairing / bootstrapping 超时消息...

    WifiAwareStateMachine(String name, Looper looper) {
        super(name, looper);
        // ...省略 threshold...
        addState(mDefaultState);
        addState(mWaitState, mDefaultState);
        addState(mWaitingState, mWaitState);
        addState(mWaitForResponseState, mDefaultState);
        setInitialState(mWaitState);
        setLogRecSize(NUM_LOG_RECS);
    }
    // ...省略 getWhatToString 巨长 switch：把每个 COMMAND_TYPE/RESPONSE_TYPE/NOTIFICATION_TYPE 映射成名字...
}
```

状态层级：

```
DefaultState（兜底，处理 NOTIFICATION）
├── WaitState（空闲，吃 COMMAND）────────── 初始态
│   └── WaitingState（瞬时态，等上层回填）
└── WaitForResponseState（已发命令，等 HAL 回 RESPONSE / 超时）
```

- **`WaitState` 吃 COMMAND**：`processCommand(msg)` 分派，返回 true 就 `transitionTo(mWaitForResponseState)`。
- **`WaitForResponseState` 等 RESPONSE**：用 `mCurrentTransactionId` 匹配 HAL 的回包；`AWARE_COMMAND_TIMEOUT = 5_000` ms 超时。这期间再有新 COMMAND 会被 `deferMessage` 推迟。
- **`DefaultState` 吃 NOTIFICATION**：HAL 主动上报的 match / cluster change / aware down 等，任何状态下都能进来。

`processCommand()` 是一个巨长的 `switch(msg.arg1)`，`arg1` 就是 `COMMAND_TYPE_*`。节选几个：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareStateManager.java:2854
private boolean processCommand(Message msg) {
    switch (msg.arg1) {
        case COMMAND_TYPE_CONNECT:
            waitForResponse = connectLocal(mCurrentTransactionId, clientId, uid, pid, ...);
            break;
        case COMMAND_TYPE_DISCONNECT:
            waitForResponse = disconnectLocal(mCurrentTransactionId, clientId);
            break;
        // ...省略 PUBLISH/SUBSCRIBE/UPDATE/TERMINATE_SESSION 等其余 30 多个 case...
    }
    // ...省略：waitForResponse 决定是否进入 WaitForResponseState...
}
```

命令全集（`MESSAGE_TYPE_COMMAND = 1`，`COMMAND_TYPE_*` 从 100 递增到 131）：

| 命令                                    | 值   | 含义                              |
| --------------------------------------- | ---- | --------------------------------- |
| `COMMAND_TYPE_CONNECT`                  | 100  | 新 client 加入（attach）          |
| `COMMAND_TYPE_DISCONNECT`               | 101  | client 离开                       |
| `COMMAND_TYPE_PUBLISH`                  | 103  | 发布服务                          |
| `COMMAND_TYPE_SUBSCRIBE`                | 105  | 订阅服务                          |
| `COMMAND_TYPE_GET_AWARE`                | 122  | 请求占用 Aware 资源（power 记账） |
| `COMMAND_TYPE_RELEASE_AWARE`            | 123  | 释放 Aware                        |
| `COMMAND_TYPE_INITIATE_DATA_PATH_SETUP` | 116  | 建 NDP（15b 展开）                |

> 上表只挑了主干命令，30+ 命令全集由 `getWhatToString()`（`WifiAwareStateManager.java:2258`）的 `switch` 统一映射成名字——日志里打出的 `COMMAND_TYPE_PUBLISH` 这类字符串就出自它。

> 为什么必须串行？因为 HAL 一次只处理一个事务，而"合并后的设备级配置"是全机唯一的——如果两个 publish 并发下发，`mCurrentAwareConfiguration` 会被打成中间态。用一条队列 + transaction ID 配对，是 Android 里"单例资源 + 异步 HAL"的标准姿势。

到这里，一条命令从 `WifiAwareServiceImpl` 进来，被 `WifiAwareStateManager.publish()` 打包成 `MESSAGE_TYPE_COMMAND`，在状态机里串行执行 `publishLocal()`。下面追 publish 这一条。

---

# 5 PublishConfig 怎么变成一次 HAL 调用？——publishLocal 的旅程

App 调 `WifiAwareSession.publish(PublishConfig)` 后，`WifiAwareStateManager.publish()` 只是把 `PublishConfig` 塞进 Message 入队，真正执行的是 `publishLocal()`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareStateManager.java:4029
private boolean publishLocal(short transactionId, int clientId, PublishConfig publishConfig,
        IWifiAwareDiscoverySessionCallback callback) {
    // ...省略日志...
    WifiAwareClientState client = mClients.get(clientId);
    if (client == null) {
        // ...省略 onSessionConfigFail...
        return false;
    }
    AwarePairingConfig pairingConfig = publishConfig.getPairingConfig();
    byte[] nik = null;
    if (pairingConfig != null && pairingConfig.isPairingVerificationEnabled()) {
        nik = mPairingConfigManager.getNikForCallingPackage(client.getCallingPackage());
    }
    boolean success = mWifiAwareNativeApi.publish(transactionId, (byte) 0, publishConfig, nik);
    if (!success) {
        // ...省略 onSessionConfigFail、recordDiscoveryStatus...
    }
    return success;
}
```

- `(byte) 0` 是 **publishId 初值**：0 表示"请 HAL 新开一个 publish 会话"，HAL 回包时会经 `WifiAwareNativeCallback.onSessionConfigSuccessResponse()` 带回真实的 `publishId`。
- `nik` 是 NAN pairing 的 Network Identity Key，只在开启 pairing verification 时才取，普通发现传 null——配对相关是 15b 的内容，这里只看到它在主链上"被捎带"。
- 注意：`publishLocal` **不做任何协议逻辑**。Publish 的 SDF 时序、匹配、TTL，全在下面 HAL/supplicant/驱动里。Framework 这一层对 Publish 的"翻译"到此为止。

`WifiAwareNativeApi.publish()` 再转发一层：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareNativeApi.java:409
public boolean publish(short transactionId, byte publishId, PublishConfig publishConfig,
        byte[] nik) {
    // ...省略日志、recordTransactionId(transactionId)...
    WifiNanIface iface = mHal.getWifiNanIface();
    if (iface == null) {
        Log.e(TAG, "publish: null interface");
        return false;
    }
    return iface.publish(transactionId, publishId, publishConfig, nik);
}
```

`mHal.getWifiNanIface()` 返回的 `WifiNanIface`，就是跨 HAL 边界的桥。到这里，Framework 的戏份演完了——它把一个 Java 的 `PublishConfig` 对象，交给了下一层的 `WifiNanIface`。

**subscribe 是 publish 的镜像**：`WifiAwareSession.subscribe(SubscribeConfig)` 入队后由 `subscribeLocal()`（`WifiAwareStateManager.java:4101`）执行，结构几乎与 `publishLocal()` 逐行对应——取 client、可选取 pairing NIK、用 `(byte) 0` 作 subscribeId 初值、最后调 `mWifiAwareNativeApi.subscribe()`（`WifiAwareNativeApi.java:434`）。跨 HAL 之后同样走 `WifiNanIface` 桥，到 supplicant 侧则落到 `nan_de_subscribe()`（`nan_de.c:1363`），与 publish 的 `nan_de_publish()` 对称。唯一的不对称在语义：publish 是"我有 X"，subscribe 是"我要 X"——这是 §10 三种邂逅能对上的前提。

---

# 6 跨 HAL 边界发生了什么？——WifiNanIface 的 AIDL/HIDL 桥

`WifiNanIface` 是 `WifiAwareNativeApi` 与厂商之间的接口，`mHal.getWifiNanIface()` 会根据 HAL 服务形态返回 `WifiNanIfaceHidlImpl`（HIDL 1.0–1.6）或 `WifiNanIfaceAidlImpl`（AIDL）。

HIDL 侧实现 `WifiNanIfaceHidlImpl` 持有的是最老的 1.0 接口，按需向上转型：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/hal/WifiNanIfaceHidlImpl.java:59
public class WifiNanIfaceHidlImpl implements IWifiNanIface {
    private android.hardware.wifi.V1_0.IWifiNanIface mWifiNanIface;
    // ...省略构造器、registerFrameworkCallback、getCapabilities...
    public boolean publish(short transactionId, byte publishId, PublishConfig publishConfig,
            byte[] nik) {
        final String methodStr = "publish";
        return executeAndValidate(
                () -> publishInternal(methodStr, transactionId, publishId, publishConfig));
    }
    // ...省略 enableAndConfigureInternal / publishInternal 内部实现，见下方转型逻辑...
}
```

跨 HAL 之后，落在 HAL 进程里的 AIDL 默认实现 `wifi_nan_iface.cpp`。它把 AIDL 的 `NanPublishRequest` 转成 legacy HAL 结构，再调 `nanPublishRequest`：

```cpp
// hardware_interfaces/wifi/aidl/default/wifi_nan_iface.cpp:897
ndk::ScopedAStatus WifiNanIface::startPublishRequestInternal(char16_t cmd_id,
                                                             const NanPublishRequest& msg) {
    legacy_hal::NanPublishRequest legacy_msg;
    if (!aidl_struct_util::convertAidlNanPublishRequestToLegacy(msg, &legacy_msg)) {
        return createWifiStatus(WifiStatusCode::ERROR_INVALID_ARGS);
    }
    legacy_hal::wifi_error legacy_status =
            legacy_hal_.lock()->nanPublishRequest(ifname_, cmd_id, legacy_msg);
    return createWifiStatusFromLegacyError(legacy_status);
}
```

到这里，调用链已经跨越了 **Binder（App→SystemServer）和 HIDL/AIDL（SystemServer→HAL 进程）** 两道进程边界。`nanPublishRequest` 是 legacy HAL 的函数指针，由厂商填实现。

> 这正是第 1 节埋的那条"两条路"的分叉点。`nanPublishRequest` 在 QCOM/MTK 的厂商 HAL（`wifi_hal/nan.cpp`）里，是直接组 vendor command 发给驱动/固件的（第 11 节）。而 wpa_supplicant 的 USD 引擎（第 7 节）是**另一条并列的路**，由控制接口命令驱动。二者不构成"Framework → HAL → supplicant"的严格串行调用，而是在驱动/固件处汇合。下面先看 supplicant 这条新路，再看驱动。

---

# 7 supplicant 为什么只做 USD？——nan_de.c 的用户态 Discovery Engine

这是本文第二个灵魂问题，也是最核心的架构洞察。

回到广场：广场上其实有两种活动——一种是要大家掐着表、同一秒聚到广场中央的「正式会议」（同步 NAN），另一种是摊主全天摆摊、顾客随时来逛的「自由集市」（USD）。wpa_supplicant 只肯摆摊，不肯当会议的司仪。

wpa_supplicant 的 NAN 实现只有 `nan_de.c`（NAN Discovery Engine）+ `nan_usd.c`（胶水），两者加起来 1992 行。它做的**只有 USD（Unsynchronized Service Discovery，非同步服务发现）**——没有 Master/Non-Master Sync、没有 DW、没有簇形成/合并。

为什么？答案在协议的硬约束里：

- **同步 NAN 的 DW 是 16 TU（≈16.384 ms）**（§3.3.1），Master/Non-Master 角色切换、Beacon 发送都卡在这个毫秒级窗口上。
- wpa_supplicant 的 `eloop` 定时器是**用户态、毫秒精度、可被调度延迟**的，做不到 16 ms 级"精确到窗口边界"的实时调度。硬要做，要么错过 DW 窗口，要么把 CPU 钉在高频唤醒上烧电。
- 而 **USD 没有同步约束**（§4.5 原文："without requiring synchronization between the devices described in section 3"）。它只需要"publisher 周期性在频道上广播、subscriber 蹲守"——这是 100 ms 粒度（§4.5.1 的 dwell period 是 N×100 TU），`eloop` 绰绰有余。

所以 supplicant 把 USD 留在用户态自己实现，把"要对表的同步发现"整个下沉到驱动/固件。这就是 `nan_de.c` 注释里那句：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:271
	/* Wi-Fi Aware specification v4.0 uses NAN Cluster ID as A3 for USD,
	 * but there is no synchronization in USD as as such, no NAN Cluster
	 * either. Use Wildcard BSSID instead. */
	nan_de_tx(de, srv->freq, wait_time, dst, de->nmi, wildcard_bssid, buf);
```

- **没有同步 → 没有簇 → A3 地址字段用 `wildcard_bssid`（全 `0xff`）**，而不是簇 ID。这一行代码是"USD 无同步"最直接的物证。
- `de->nmi` 是 NMI（NAN Management Interface）地址，用作 A2（源地址）。

引擎本体 `struct nan_de` 长这样：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:64
struct nan_de {
	u8 nmi[ETH_ALEN];
	bool offload;
	bool ap;
	struct nan_callbacks cb;

	struct nan_de_service *service[NAN_DE_MAX_SERVICE];
	unsigned int num_service;

	int next_handle;

	unsigned int ext_listen_freq;
	unsigned int listen_freq;
	unsigned int tx_wait_status_freq;
	unsigned int tx_wait_end_freq;
};
```

- **`offload`** 是灵魂字段：`wpas_nan_usd_init()` 里 `offload = wpa_s->drv_flags2 & WPA_DRIVER_FLAGS2_NAN_OFFLOAD`。固件支持 USD offload 时，supplicant 会**同时**把 publish/subscribe 用 vendor command 转发给固件（下文第 11 节的 `QCA_NL80211_VENDOR_SUBCMD_USD`），自己只留一份本地状态。
- **`cb`** 是 `struct nan_callbacks` 回调表——这是 Discovery Engine 与外界（发送、监听、上报事件）的全部接口，由 `nan_usd.c` 填充。
- **`service[NAN_DE_MAX_SERVICE]`** 是 publish/subscribe 实例池，`NAN_DE_MAX_SERVICE = 20`。

胶水层 `wpas_nan_usd_init()` 把回调表填好：

```c
// external_wpa_supplicant_8/wpa_supplicant/nan_usd.c:306
int wpas_nan_usd_init(struct wpa_supplicant *wpa_s)
{
	struct nan_callbacks cb;
	bool offload = wpa_s->drv_flags2 & WPA_DRIVER_FLAGS2_NAN_OFFLOAD;

	os_memset(&cb, 0, sizeof(cb));
	cb.ctx = wpa_s;
	cb.tx = wpas_nan_de_tx;
	cb.listen = wpas_nan_de_listen;
	cb.discovery_result = wpas_nan_de_discovery_result;
	cb.replied = wpas_nan_de_replied;
	cb.publish_terminated = wpas_nan_de_publish_terminated;
	cb.subscribe_terminated = wpas_nan_de_subscribe_terminated;
	cb.receive = wpas_nan_de_receive;

	wpa_s->nan_de = nan_de_init(wpa_s->own_addr, offload, false, &cb);
	if (!wpa_s->nan_de)
		return -1;
	return 0;
}
```

- `nan_de_init()` 用 `wpa_s->own_addr` 当 NMI，`offload` 标志传进去。
- 回调表把 Discovery Engine 的 6 个出口接到 `nan_usd.c` 的胶水函数上。这些胶水函数再转成两样东西：**发送/监听 → `offchannel_send_action` / `remain_on_channel`**（借 P2P 现成的 offchannel 机制）；**事件 → `wpa_msg` 广播**（`NAN-DISCOVERY-RESULT` 等）。

> 如果你担心"用户态做发现会不会太慢"——USD 的设计恰恰是为了兼容这种慢：publisher 会在频道上停留 N×100 TU（默认 N∈[5,10]），subscriber 蹲守在固定频道。双方在 100 ms 量级的时间窗口里慢慢碰，不需要 16 ms 的精确对表。这就是为什么**慢腾腾的用户态 `eloop` 能胜任 USD**，却**碰不了同步 NAN**。

---

# 8 SDF 帧是怎么拼出来、怎么收下来的？——tx_sdf 与 rx_sda

supplicant 里 publish/subscribe 的本质，就是**收发 SDF（Service Discovery Frame）**。SDF 是 Public Action 帧里套一个 WFA 的 vendor-specific 载荷。

> 如果你只想了解"匹配怎么发生"，可以跳过本节的逐字段拼帧/拆帧，直接看第 10 节的三种邂逅——那里只有逻辑没有帧格式。

发帧：`nan_de_publish()` 建好实例后，由定时器驱动的 `nan_de_tx_sdf()` 拼帧：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:206
static void nan_de_tx_sdf(struct nan_de *de, struct nan_de_service *srv,
			  unsigned int wait_time,
			  enum nan_service_control_type type,
			  const u8 *dst, u8 req_instance_id,
			  const struct wpabuf *ssi)
{
	struct wpabuf *buf;
	size_t len = 0, sda_len, sdea_len;
	u8 ctrl = type;
	u16 sdea_ctrl = 0;

	/* Service Descriptor attribute */
	sda_len = NAN_SERVICE_ID_LEN + 1 + 1 + 1;
	len += NAN_ATTR_HDR_LEN + sda_len;
	/* Service Descriptor Extension attribute */
	sdea_len = 1 + 2;
	if (ssi)
		sdea_len += 2 + 4 + wpabuf_len(ssi);
	len += NAN_ATTR_HDR_LEN + sdea_len;

	buf = nan_de_alloc_sdf(len);
	// ...省略：写入 SDA（service_id + instance_id + req_instance_id + ctrl）、
	//      SDEA（FSD 标志 + OUI_WFA + srv_proto_type + ssi）、Element Container...
	nan_de_tx(de, srv->freq, wait_time, dst, de->nmi, wildcard_bssid, buf);
	wpabuf_free(buf);
}
```

而 `nan_de_alloc_sdf()` 拼出帧头——这正是 SDF 的"身份证"：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:170
static struct wpabuf * nan_de_alloc_sdf(size_t len)
{
	struct wpabuf *buf;

	buf = wpabuf_alloc(2 + 4 + len);
	if (buf) {
		wpabuf_put_u8(buf, WLAN_ACTION_PUBLIC);
		wpabuf_put_u8(buf, WLAN_PA_VENDOR_SPECIFIC);
		wpabuf_put_be32(buf, NAN_SDF_VENDOR_TYPE);
	}
	return buf;
}
```

- **帧头三段**：`WLAN_ACTION_PUBLIC`（帧类别 = Public Action）+ `WLAN_PA_VENDOR_SPECIFIC`（Action 类型 = 厂商私有）+ `NAN_SDF_VENDOR_TYPE`（4 字节 WFA OUI/类型），正是 `wpabuf_alloc(2 + 4 + len)` 里的 `2 + 4` 头——任何设备看到这三段就知道"这是 NAN SDF"。
- `NAN_SDF_VENDOR_TYPE = 0x506f9a13`（`ieee802_11_defs.h:1443`）——收到帧时就是靠这 4 字节识别"这是 NAN SDF"。
- 载荷三段：**SDA**（Service Descriptor attribute，含 6 字节 Service ID + Instance ID + Requestor Instance ID + Service Control）、**SDEA**（Service Descriptor Extension，含 FSD 标志 + Service Info）、**Element Container**（可选的 vendor 元素）。

`nan_de_tx()` 通过回调 `cb.tx` 走出引擎，落到 `nan_usd.c` 的 `wpas_nan_de_tx()`：

```c
// external_wpa_supplicant_8/wpa_supplicant/nan_usd.c:88
static int wpas_nan_de_tx_send(struct wpa_supplicant *wpa_s, unsigned int freq,
			       unsigned int wait_time, const u8 *dst,
			       const u8 *src, const u8 *bssid,
			       const struct wpabuf *buf)
{
	// ...省略日志...
	return offchannel_send_action(wpa_s, freq, dst, src, bssid,
				      wpabuf_head(buf), wpabuf_len(buf),
				      wait_time, wpas_nan_de_tx_status, 1);
}
```

- **`offchannel_send_action()`**：这就是 P2P 那套 offchannel 发送机制（本系列第 11 章 P2P 讲过），USD 直接复用——切到目标信道发一个 Public Action 帧，`wait_time` 等 ACK。
- 发送前还要过 `radio_add_work()` 排队（`wpas_nan_de_tx()` 里），避免和扫描、P2P 抢 radio。

收帧是镜像：`events.c` 在 Action 帧分发里识别出 SDF，交回引擎：

```c
// external_wpa_supplicant_8/wpa_supplicant/events.c:5695
#ifdef CONFIG_NAN_USD
	if (category == WLAN_ACTION_PUBLIC && plen >= 5 &&
	    payload[0] == WLAN_PA_VENDOR_SPECIFIC &&
	    WPA_GET_BE32(&payload[1]) == NAN_SDF_VENDOR_TYPE) {
		payload += 5;
		plen -= 5;
		wpas_nan_usd_rx_sdf(wpa_s, mgmt->sa, freq, payload, plen);
		return;
	}
#endif /* CONFIG_NAN_USD */
```

拆帧入口 `nan_de_rx_sdf()` → `nan_de_rx_sda()`，把 SDA 逐字段剥开：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:1011
static void nan_de_rx_sda(struct nan_de *de, const u8 *peer_addr,
			  unsigned int freq, const u8 *buf, size_t len,
			  const u8 *sda, size_t sda_len)
{
	const u8 *service_id;
	u8 instance_id, req_instance_id, ctrl;
	// ...省略 sdea_control / ssi / matching_filter 等局部变量...
	service_id = sda;
	sda += NAN_SERVICE_ID_LEN;
	instance_id = *sda++;
	req_instance_id = *sda++;
	ctrl = *sda;
	type = ctrl & NAN_SRV_CTRL_TYPE_MASK;
	// ...省略：非法 type 丢弃、binding bitmap / matching filter / resp filter / srv info 解析...
	for (i = 0; i < NAN_DE_MAX_SERVICE; i++) {
		struct nan_de_service *srv = de->service[i];
		if (!srv)
			continue;
		if (os_memcmp(srv->service_id, service_id, NAN_SERVICE_ID_LEN) != 0)
			continue;
		// ...省略：按 publish/subscribe 类型过滤、按 req_instance_id 过滤...
		switch (type) {
		case NAN_SRV_CTRL_PUBLISH:
			nan_de_rx_publish(de, srv, peer_addr, instance_id, ...);
			break;
		case NAN_SRV_CTRL_SUBSCRIBE:
			nan_de_rx_subscribe(de, srv, peer_addr, instance_id, ...);
			break;
		case NAN_SRV_CTRL_FOLLOW_UP:
			nan_de_rx_follow_up(de, srv, peer_addr, instance_id, ...);
			break;
		}
	}
}
```

- **Service Control 的低 2 位（`NAN_SRV_CTRL_TYPE_MASK`）决定帧类型**：`PUBLISH = 0` / `SUBSCRIBE = 1` / `FOLLOW_UP = 2`（`nan.h` 里的 `enum nan_service_control_type`）。
- **按 Service ID 过滤**：先 `os_memcmp` 比对 6 字节 Service ID，对不上直接跳过——这是 O(20) 的线性扫描，20 个实例池在小设备上足够快。

---

# 9 一个服务名怎么变成 6 字节 Service ID？——SHA-256 截断

上面反复出现的"6 字节 Service ID"是哪来的？`nan_de_publish()` 里调 `nan_de_derive_service_id()`：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:1208
static int nan_de_derive_service_id(struct nan_de_service *srv)
{
	u8 hash[SHA256_MAC_LEN];
	char *name, *pos;
	int ret;
	const u8 *addr[1];
	size_t len[1];

	name = os_strdup(srv->service_name);
	if (!name)
		return -1;
	pos = name;
	while (*pos) {
		*pos = tolower(*pos);
		pos++;
	}
	addr[0] = (u8 *) name;
	len[0] = os_strlen(name);
	ret = sha256_vector(1, addr, len, hash);
	os_free(name);
	if (ret == 0)
		os_memcpy(srv->service_id, hash, NAN_SERVICE_ID_LEN);

	return ret;
}
```

- **服务名 → 小写 → SHA-256 → 取前 6 字节**（`NAN_SERVICE_ID_LEN = 6`）作为 Service ID。
- 6 字节 = 48 bit，对 "服务名指纹" 来说碰撞概率可接受；这也是协议规定的 Service ID 长度。
- **为什么小写**：让 `"MyPrinter"` 和 `"myprinter"` 产生相同的 Service ID，避免大小写差异导致供需错过——这个细节在协议里体现为 Service ID 基于 service name 的规范化哈希。
- **广场黑话**：这 6 字节就是服务名压出的 **48 bit 指纹**——广场上大家不喊全名，只对指纹认人，同名必然同指纹，异名几乎不会撞指纹。

> 这也是为什么两台设备哪怕没同步、没簇，只要 service name 一样，就能在 SDF 里用同一个 Service ID 对上号——USD 的匹配完全建立在"同名 → 同 ID"的确定性哈希上。

---

# 10 三种消息怎么对上号？——publish/subscribe/follow-up 匹配

SDF 按类型分发后，进入三个处理函数。它们精确对应 §4.5.1（publisher 行为）/§4.5.2（subscriber 行为）。

**订阅方收到 Publish**（`nan_de_rx_publish`）：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:808
static void nan_de_rx_publish(struct nan_de *de, struct nan_de_service *srv,
			      const u8 *peer_addr, u8 instance_id,
			      u8 req_instance_id, u16 sdea_control,
			      enum nan_service_protocol_type srv_proto_type,
			      const u8 *ssi, size_t ssi_len)
{
	/* Subscribe function processing of a receive Publish message */
	if (!os_reltime_initialized(&srv->first_discovered)) {
		os_get_reltime(&srv->first_discovered);
		srv->needs_fsd = sdea_control & NAN_SDEA_CTRL_FSD_REQ;
		nan_de_run_timer(de);
	}

	if (!de->offload && srv->subscribe.active && req_instance_id == 0) {
		/* Active subscriber replies with a Subscribe message */
		nan_de_tx_multicast(de, srv, instance_id);
	}
	if (!de->offload && !srv->subscribe.active && req_instance_id == 0) {
		/* Passive subscriber replies with a Follow-up message (no SSI) */
		nan_de_transmit(de, srv->id, NULL, NULL, peer_addr, instance_id);
	}

	if (de->cb.discovery_result)
		de->cb.discovery_result(
			de->cb.ctx, srv->id, srv_proto_type,
			ssi, ssi_len, instance_id,
			peer_addr,
			sdea_control & NAN_SDEA_CTRL_FSD_REQ,
			sdea_control & NAN_SDEA_CTRL_FSD_GAS);
}
```

- **active subscriber** 收到 unsolicited Publish → 回一个 Subscribe（§4.5.2）。
- **passive subscriber** 收到 unsolicited Publish → 回一个**不带 SSI 的 Follow-up**，把 publisher 暂时"按在"当前频道（pauseState，§4.5.2）。
- 最后 `cb.discovery_result(...)` 上报——这就是 **match 事件的起点**（第 12 节）。

**发布方收到 Subscribe**（`nan_de_rx_subscribe`）里有 matching filter 判定：

```c
// external_wpa_supplicant_8/src/common/nan_de.c:845
static bool nan_de_filter_match(struct nan_de_service *srv,
				const u8 *matching_filter,
				size_t matching_filter_len)
{
	// 本地 Publish 不支持 matching_filter_rx，任何非空 <length,value> 都视为不匹配
	if (!matching_filter)
		return true;
	pos = matching_filter;
	end = matching_filter + matching_filter_len;
	while (pos < end) {
		u8 len;
		len = *pos++;
		if (len > end - pos)
			break;
		if (len) {
			/* A non-empty Matching Filter entry: no match */
			return false;
		}
	}
	return true;
}
```

- **Matching Filter** 是一串 `<length,value>` 对，用于"订阅方对发布内容做二次筛选"（§4.1.9）。当前实现只支持"空 filter 即全匹配"，一旦对方带了非空 filter 就判不匹配——这是 R4 首版的保守取舍。
- 通过 filter 且 `publish.solicited` 才回 solicited Publish；回完调 `nan_de_pause_state()` 进入 60 秒 pauseState（§4.5.1 的 `pauseStateTimeout = 60`）。

**Follow-up**（`nan_de_rx_follow_up`）处理双向的"传话"：带 SSI 的 Follow-up 触发 `cb.receive`，把消息交给应用；不带 SSI 的 Follow-up 用于 pause publisher。

三种邂逅的完整图景：

![USD 三种邂逅：publish/subscribe/follow-up 的匹配](assets/15a-NAN%EF%BC%88%E4%B8%80%EF%BC%89%E6%9C%8D%E5%8A%A1%E5%8F%91%E7%8E%B0-%E2%80%94-%E4%BB%8E-attach-%E5%88%B0%E6%9C%8D%E5%8A%A1%E5%8C%B9%E9%85%8D/15a-usd-match.svg)

- **unsolicited Publish**（主动广播）→ 被 active subscriber 用 Subscribe 回应，或被 passive subscriber 用无 SSI Follow-up 暂停。
- **solicited Publish**（应 Subscribe 请求）→ 一对一回给请求方。
- **Follow-up**（带 SSI）→ 双向传服务信息，`cb.receive` 交给应用。
- **pauseState**：publisher 收到 Subscribe / 无 SSI Follow-up 后，60 秒内停在当前频道，只跟触发它的那个 subscriber 继续对话，忽略其他人的打扰——这是"供需对上了就私聊"的协议化实现。

---

# 11 驱动怎么发现？——QCOM 胖固件 vs MTK 胖主机

同一个 NAN 发现，QCOM 和 MTK 在"发现放主机还是固件"上给出了相反答案。这是本文双平台对比的核心。

**QCOM：瘦主机 + 胖固件。** 发现、DW 调度、NDP 全在固件（WMI），主机只做翻译 + 状态管理。厂商 HAL `nan_publish_request()` 组一个 vendor command 发出去：

```cpp
// QCOM/hardware-qcom-wlan/qcwcn/wifi_hal/nan.cpp:232
wifi_error nan_publish_request(transaction_id id,
                               wifi_interface_handle iface,
                               NanPublishRequest* msg)
{
    // ...省略 hal_info / secure_nan / pairing 预处理...
    nanCommand = new NanCommand(wifiHandle, 0, OUI_QCA,
                                info->support_nan_ext_cmd?
                                QCA_NL80211_VENDOR_SUBCMD_NAN_EXT :
                                QCA_NL80211_VENDOR_SUBCMD_NAN);
    // ...省略 create / set_iface_id...
    ret = nanCommand->putNanPublish(id, msg, grp_keys);
    // ...省略 requestEvent...
    return ret;
}
```

主机侧 qcacld-3.0 的 `nan_main.c`（1541 行）只做 NDP/NDL 的状态管理（`nan_discovery_event_handler` / `nan_datapath_event_handler` 等），真正下固件的是 `wmi_unified_nan_req_cmd` → `send_nan_req_cmd`（WMI）。发现引擎整个在固件里跑。

**MTK：胖主机 + 瘦固件。** 主机 `nanScheduler.c` 有 **10165 行**，实现簇同步、DW 窗口分类、可用性 bitmap 解析、信道 NDC 协商；固件只做 Discovery Engine 的 MAC 级收发。厂商 vendor command 入口在 `gl_vendor_nan.c`：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/os/linux/gl_vendor_nan.c:885
int mtk_cfg80211_vendor_nan(struct wiphy *wiphy,
                            struct wireless_dev *wdev,
                            const void *data, int data_len)
{
    // ...省略消息头解析...
    switch (msgId) {
    case NAN_MSG_ID_ENABLE_REQ: {
        // ...解析 NAN_TLV_TYPE_MASTER_PREFERENCE / CLUSTER_ID_LOW/HIGH / CONFIG_DISCOVERY_INDICATIONS...
    }
    case NAN_MSG_ID_PUBLISH_SERVICE_REQ: {
        // ...解析 NAN_TLV_TYPE_SERVICE_NAME / SERVICE_SPECIFIC_INFO / RX_MATCH_FILTER...
        nanPublishRequest(prAdapter, ...);
    }
    // ...省略 CONFIGURATION_REQ / SUBSCRIBE / CAPABILITIES / DISABLE...
    }
}
```

主机侧调度器 `nanScheduler.c` 的职责一目了然：

| 函数                                                | 作用                  | 对应协议          |
| --------------------------------------------------- | --------------------- | ----------------- |
| `nanIsDiscWindow()`                                 | 判断某 slot 是否是 DW | §3.3.1 DW         |
| `nanWindowType()`                                   | 窗口分类              | §3.3.6 角色/状态  |
| `nanParserInterpretTimeBitmapField()`               | 解析可用性 bitmap     | §5.1 Availability |
| `nanSchedAcquireNdcCtrl()` / `nanSchedGetNdcCtrl()` | NDC 信道协商          | §5.2.1 调度       |
| `nanSchedConvergeChnlInfo()`                        | 信道信息收敛          | §5.2 调度管理     |

双平台对比：

| 维度            | QCOM（瘦主机）                        | MTK（胖主机）                          |
| --------------- | ------------------------------------- | -------------------------------------- |
| 发现引擎位置    | 固件（WMI）                           | 主机 `nanScheduler.c` + 固件 MAC 收发  |
| 主机 NAN 代码量 | `nan_main.c` 1541 行（多为 NDP 状态） | `nanScheduler.c` 10165 行              |
| DW 16 ms 时序   | 固件定时                              | 主机调度器 + 固件配合                  |
| vendor 下发     | `QCA_NL80211_VENDOR_SUBCMD_NAN`       | `mtk_cfg80211_vendor_nan` → TLV → mbox |

> 两条路殊途同归：无论发现引擎在固件（QCOM）还是主机（MTK），DW 16 ms 的精确时序都**不在用户态**。QCOM 是"全下沉固件"，MTK 是"下沉到内核驱动"——总之都下沉到 `eloop` 够不着的地方。这反过来印证了第 7 节的洞察：supplicant 只配做无同步的 USD。

supplicant 的 USD 还有一条"固件 offload"岔路：当驱动声明 `WPA_DRIVER_FLAGS2_NAN_OFFLOAD` 时，`nl80211_nan_publish()` 会把 publish 用 vendor subcmd 转给固件：

```c
// external_wpa_supplicant_8/src/drivers/driver_nl80211.c:13759
static int nl80211_nan_publish(void *priv, const u8 *src, int publish_id,
			       const char *service_name, const u8 *service_id,
			       enum nan_service_protocol_type srv_proto_type,
			       const struct wpabuf *ssi,
			       const struct wpabuf *elems,
			       struct nan_publish_params *params)
{
	// ...省略 i802_bss / drv / msg 声明...
	msg = nl80211_drv_msg(drv, 0, NL80211_CMD_VENDOR);
	if (!msg ||
	    nla_put_u32(msg, NL80211_ATTR_VENDOR_ID, OUI_QCA) ||
	    nla_put_u32(msg, NL80211_ATTR_VENDOR_SUBCMD,
			QCA_NL80211_VENDOR_SUBCMD_USD))
		goto fail;
	container = nla_nest_start(msg, NL80211_ATTR_VENDOR_DATA);
	// ...省略 QCA_WLAN_VENDOR_ATTR_USD_OP_TYPE=PUBLISH / SRC_ADDR / INSTANCE_ID / SERVICE_ID / SSI / CHAN_CONFIG...
	ret = send_and_recv_cmd(drv, msg);
	// ...省略失败处理...
}
```

- `QCA_NL80211_VENDOR_SUBCMD_USD = 249`（`qca_vendor.h:1439`）——这就是简报里说的"USD(249)"。
- 于是 USD 也有两档：**无 offload 时 supplicant 自己收发 SDF**（第 8 节）；**有 offload 时同时下发固件**，让固件代劳 Discovery Engine 的 MAC 收发。

---

# 12 match 怎么一路回调回应用？——从 NAN-DISCOVERY-RESULT 到 onMatch

最后一段路：匹配事件怎么从 C 一路回到 Java 应用。

supplicant 侧，`cb.discovery_result` 回调落到 `wpas_nan_de_discovery_result()` → `wpas_notify_nan_discovery_result()`，发出 `NAN-DISCOVERY-RESULT` 事件：

```c
// external_wpa_supplicant_8/wpa_supplicant/notify.c:1494
void wpas_notify_nan_discovery_result(struct wpa_supplicant *wpa_s,
				      enum nan_service_protocol_type srv_proto_type,
				      int subscribe_id, int peer_publish_id,
				      const u8 *peer_addr, bool fsd, bool fsd_gas,
				      const u8 *ssi, size_t ssi_len)
{
	char *ssi_hex;
	ssi_hex = os_zalloc(2 * ssi_len + 1);
	if (!ssi_hex)
		return;
	if (ssi)
		wpa_snprintf_hex(ssi_hex, 2 * ssi_len + 1, ssi, ssi_len);
	wpa_msg(wpa_s, MSG_INFO, NAN_DISCOVERY_RESULT
		"subscribe_id=%d publish_id=%d address=" MACSTR
		" fsd=%d fsd_gas=%d srv_proto_type=%u ssi=%s",
		subscribe_id, peer_publish_id, MAC2STR(peer_addr),
		fsd, fsd_gas, srv_proto_type, ssi_hex);
	os_free(ssi_hex);
}
```

- `NAN_DISCOVERY_RESULT = "NAN-DISCOVERY-RESULT "`（`wpa_ctrl.h:240`）。`subscribe_id` 是**自己的**，`publish_id` 是**对方的**——这正是 `nan_de_rx_publish` 里 `cb.discovery_result(ctx, srv->id, ..., instance_id, peer_addr, ...)` 传下来的（`srv->id` 是自己的 subscribe 句柄，`instance_id` 是对方的 publish 句柄）。

⚠️ **未验证调用关系**：supplicant 的 `NAN-DISCOVERY-RESULT` 事件，从 `wpa_ctrl` 控制接口到厂商 HAL、再经 `IWifiNanIface` 回调链回到 Framework 的具体转发函数，本仓库里没有一条直接连通的可追踪路径（厂商 HAL 与 supplicant USD 是并列的两条路，见第 1/6 节）。因此这里**只展示 Framework 侧的接收端**，中间那一段"谁把控制接口事件翻译成 HAL 回调"标为未验证。

Framework 侧接收端已经追得很清楚。HAL 回调进 `WifiAwareNativeCallback.eventMatch()`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareNativeCallback.java:345
public void eventMatch(byte discoverySessionId, int peerId, byte[] addr,
        byte[] serviceSpecificInfo, byte[] matchFilter, int rangingIndication, int rangeMm,
        byte[] scid, int peerCipherSuite, byte[] nonce, byte[] tag,
        AwarePairingConfig pairingConfig, List<OuiKeyedData> vendorData) {
    // ...省略日志...
    mWifiAwareStateManager.onMatchNotification(discoverySessionId, peerId,
            addr, serviceSpecificInfo, matchFilter, rangingIndication, rangeMm,
            scid, peerCipherSuite, nonce, tag, pairingConfig, vendorData);
}
```

`onMatchNotification()` 把事件打包成 `NOTIFICATION_TYPE_MATCH` 入队，`DefaultState.processNotification()` 分派到 `onMatchLocal()`，再由 `getClientSessionForPubSubId(pubSubId)` 按 pubSubId 找回"是哪个 client 的哪个 session"，最后落到 `WifiAwareDiscoverySessionState.onMatch()`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/aware/WifiAwareDiscoverySessionState.java:594
public int onMatch(int requestorInstanceId, byte[] peerMac, byte[] serviceSpecificInfo,
        byte[] matchFilter, int rangingIndication, int rangeMm,
        int cipherSuite, byte[] scid, String pairingAlias,
        AwarePairingConfig pairingConfig, List<OuiKeyedData> vendorData) {
    // ...省略 peerId 生成、peer 记账...
    if (rangeMm == 0) {
        mCallback.onMatch(peerId, serviceSpecificInfo, matchFilter, cipherSuite, scid,
                pairingAlias, pairingConfig, vendorData);
    } else {
        mCallback.onMatchWithDistance(peerId, serviceSpecificInfo, matchFilter, rangeMm,
                cipherSuite, scid, pairingAlias, pairingConfig, vendorData);
    }
    // ...省略返回 peerId...
}
```

- `mCallback` 是 `IWifiAwareDiscoverySessionCallback`，一路经 Binder 回到 App 的 `DiscoverySessionCallback.onServiceDiscovered()`。
- **`rangeMm == 0` 分叉**：普通匹配走 `onMatch`，带距离的匹配走 `onMatchWithDistance`（ranging 相关，15b 展开）。

到这里，一个 `match` 走完了全程：**固件/引擎收到 SDF → 匹配 → `NAN-DISCOVERY-RESULT` → HAL 回调 → `NOTIFICATION_TYPE_MATCH` → `onMatchLocal` → App `onServiceDiscovered`**。

---

# 13 总结——一条「簇共享 → USD 收发 → 驱动发现」的链

# 全链路回顾

```
App.attach()
  → [Binder] WifiAwareServiceImpl.connect()         分配 clientId、挂 DeathRecipient
  → WifiAwareStateManager.connect()                  打包 COMMAND_TYPE_CONNECT 入队
  → connectLocal() → mergeConfigRequests()           N 个 App 意愿合并成 1 份设备级配置
  → WifiAwareNativeApi.enableAndConfigure()
  → [HIDL/AIDL] WifiNanIface                          跨 HAL 进程
  → vendor HAL（QCOM/MTK nan.cpp）或 supplicant USD
      ├─ 同步 NAN：vendor command → 驱动/固件（DW 16ms）
      └─ USD：nan_de_publish/nan_de_subscribe
            → nan_de_tx_sdf → offchannel_send_action / remain_on_channel
            → 驱动 → 固件（QCOM 胖固件 / MTK 胖主机）
  ← match：nan_de_rx_publish → cb.discovery_result
  ← NAN-DISCOVERY-RESULT → HAL 回调 → NOTIFICATION_TYPE_MATCH
  ← WifiAwareDiscoverySessionState.onMatch → App.onServiceDiscovered
```

# 三个设计权衡

1. **Framework 单实例多 client 簇共享**：簇只有一个、DW 只有一个，所以全机一个 NAN 引擎；`mergeConfigRequests()` 把多 App 的 Master Preference 取最大、DW 间隔取最小、簇范围要求一致。
2. **supplicant 只做 USD**：用户态 `eloop` 定时器做不到 16 ms 级 DW 精确调度，必须下沉驱动/固件；USD 无同步（100 ms 粒度）才勉强配得上用户态。`nan_de.c` 里 `wildcard_bssid` 当 A3 是"无同步"的物证。
3. **驱动双平台分歧**：QCOM 瘦主机胖固件（发现/DW/NDP 全在固件 WMI），MTK 胖主机瘦固件（主机 `nanScheduler.c` 做 DW 调度 + 可用性解析，固件只做 MAC 收发）。但殊途同归——16 ms 精确时序都不在用户态。

# 常量 / 超时 / 事件速查

| 常量                            | 值         | 定义位置                          | 说明                            |
| ------------------------------- | ---------- | --------------------------------- | ------------------------------- |
| `AWARE_COMMAND_TIMEOUT`         | 5000 ms    | `WifiAwareStateManager.java:2513` | Framework 等 HAL 回包超时       |
| `NAN_DE_MAX_SERVICE`            | 20         | `nan_de.h`                        | USD 实例池上限                  |
| `NAN_USD_DEFAULT_FREQ`          | 2437       | `nan.h`                           | 默认 publish 频道 = 信道 6      |
| `NAN_SDF_VENDOR_TYPE`           | 0x506f9a13 | `ieee802_11_defs.h:1443`          | SDF 帧识别号                    |
| `NAN_SERVICE_ID_LEN`            | 6          | `nan.h`                           | Service ID 长度（SHA-256 截断） |
| `pauseStateTimeout`             | 60 s       | §4.5.1                            | publisher 被按住的时长          |
| `QCA_NL80211_VENDOR_SUBCMD_USD` | 249        | `qca_vendor.h:1439`               | USD 固件 offload 命令           |

# 跨层字段映射（同一份信息的四层登记）

| 概念            | Framework                           | supplicant                                     | 驱动/固件                |
| --------------- | ----------------------------------- | ---------------------------------------------- | ------------------------ |
| 服务名 → ID     | `PublishConfig` 里服务名            | `nan_de_derive_service_id()` SHA-256 前 6 字节 | 直接用 6 字节 Service ID |
| publish 会话 id | `publishId`（HAL 回包分配）         | `srv->id`（`nan_de_get_handle`）               | instance_id（SDA 字段）  |
| SSI             | `PublishConfig.serviceSpecificInfo` | `srv->ssi`（SDEA 的 Service Info）             | USD SSI attr             |
| 匹配事件        | `onServiceDiscovered`               | `NAN-DISCOVERY-RESULT`                         | match indication         |

---

**本章追完了"发现"这条线：App 的 attach 怎么合并成一个共享引擎，supplicant 怎么在用户态用 USD 收发 SDF，驱动怎么在固件/主机里落地发现。** 但有个问题悬在半空——**发现之后呢？** 供需对上了，两个人还要"单独走到一边交换联系方式、真正传数据"，这就是 NDP/NDL 数据通路，还要过一道 4-way handshake 安全关。

下一章，我们从 `COMMAND_TYPE_INITIATE_DATA_PATH_SETUP`（状态机里那个没展开的 case）追起，看 Aware 怎么在发现之后建起一条真正的数据通道。

**源码出处**：

- AOSP [packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)、[external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8)
- QCOM [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0)
- MTK [gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)

协议依据已对照 Wi-Fi Aware Specification v4.0
