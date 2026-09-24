---
title: WiFi RTT 测距 — 从 startRanging 到距离计算
top: 1
related_posts: true
abbrlink: 67a12300
date: 2026-09-24 23:42:36
tags:
  - Android WiFi
  - RTT
categories:
  - WiFi
  - Code
---

> 手机里没有激光雷达，却能告诉你「离那个 AP 还有 3.2 米」——这句话背后，是整个 WiFi 协议栈里最「头重脚轻」的一条链：Framework 写了上千行代码，却没算过一毫米距离。

> 前情提要：《NAN（二）数据通路与安全》追完了 NAN 的数据通路，结尾留了个悬念——Aware 的测距只回答了「对方离我几米」，那 Android 里那套更精确、能到厘米级、还带 AP 坐标的室内测距是什么？这篇就从 `WifiRttManager.startRanging` 追起，看 802.11mc 的 RTT/FTM 怎么从 App 一路测到 AP。

---

# 本章导读

你打开一个商场导航 App，它标出「你在 3 楼 A 区星巴克门口」。GPS 在室内基本失灵，这里靠的是 **Wi-Fi RTT**——802.11mc 引入的 **FTM（Fine Timing Measurement，精细时间测量）**。原理一句话：**发一帧、收一帧、各自掐表，用往返时间乘以光速再除以二，就是距离**。

<!--more-->

姊妹系列 RTT-FTM-室内测距 已经把协议讲透了——t1/t2/t3/t4 四个时间戳怎么交换、ISTA/RSTA 谁发起谁响应、Burst 怎么取平均、误差从哪来、802.11az 怎么把它推更准。那一篇回答的是「**协议怎么设计的**」。

这一篇换一个问题：**协议在 Android 源码里怎么落地的？** 从 App 调 `startRanging` 开始，一路追到固件里那根「纳秒级秒表」，再逆着把距离送回 App。追完你会发现一个反直觉的事实——

> 整条链像一家高档餐厅：App 是住客，点了一道叫「测个距离」的菜；`RttServiceImpl` 是前台，登记、查证件（权限）、限流（防刷单）、催菜（超时）；`WifiRttController` 是传菜口；vendor HAL 是服务员，把「住客的话」翻译成「后厨的行话」；驱动是配菜间，参数照抄；真正「炒菜」的只有后厨大厨——**固件**。前台绝不会进后厨拿锅铲，因为前台的动作以「秒」计，而这道菜要掐准到「十亿分之一秒」。

**本章你将学到：**

- `WifiRttManager → RttServiceImpl → RttServiceSynchronized → WifiRttController` 这条 Framework 链每一步做什么
- 为什么 Framework 用一个**单线程队列状态机**，而不是「来一个测一个」
- 跨进程之后，vendor HAL 怎么把 Java 对象「翻译」成 C 结构体
- QCOM 与 MTK 两家驱动在测距上的两种截然不同的分工
- **距离到底在哪一层算出来的**——这个答案可能和你想的不一样
- 为什么整条链「主机这么薄、核心全在固件」

> 本文不重讲协议（t1-t4、Burst、误差来源、三边测量详见姊妹系列）；802.11az 的增强（NDP 测距、TB、安全测距、LMR）只在涉及代码时简略带过；三边测量定位算法不展开（应用层）。supplicant 在这条链里**没有 STA 侧发起端**，这一点会在第 7 节专门澄清。

---

# 1 为什么「测个距离」要把核心全塞进固件？

先看全貌。从 App 到固件，这条链跨越 **4 个代码世界**（Java Framework、C++ HAL、C 驱动、固件），但每一层的「含金量」完全不同：

![WiFi RTT 全局调用链](assets/16-WiFi-RTT-%E6%B5%8B%E8%B7%9D-%E2%80%94-%E4%BB%8E-startRanging-%E5%88%B0%E8%B7%9D%E7%A6%BB%E8%AE%A1%E7%AE%97/16-architecture-callchain.svg)

**读图要点**：蓝色是下发方向（App → 固件），绿色是回传方向（固件 → App）。注意两处跨进程边界——Framework 与 vendor HAL 之间隔一道 **AIDL Binder**，vendor HAL 与驱动之间隔一道 **nl80211 vendor command**。而整张图里最粗的工作量，集中在最下面那个「主机看不见」的固件方框里。

一句话概括五层分工：

| 层             | 组件                                                         | 干什么                             | 含金量                   |
| -------------- | ------------------------------------------------------------ | ---------------------------------- | ------------------------ |
| **Framework**  | `WifiRttManager` / `RttServiceImpl` / `RttServiceSynchronized` / `WifiRttController` | 校验、权限、排队、节流、超时、翻译 | 管理逻辑厚，**但不测距** |
| **Vendor HAL** | `wifi_rtt_controller.cpp` / `WifiLegacyHal` / 厂商 `rtt.cpp` | 结构体翻译 + 函数表转发            | 薄，纯桥接               |
| **驱动**       | QCOM `wifi_pos` / MTK `rtt.c`                                | 参数透传 + 结果聚合                | 薄，纯搬运               |
| **固件**       | （主机不可见）                                               | FTM 帧交换 + T1-T4 时间戳          | **核心全在这**           |

追完这条链，下面这个问题的答案就顺理成章了——为什么主机写得再多，也只是个「前台」。

这是本文的灵魂问题。先把它想透，后面每一层「薄」的原因就都顺了。

答案是物理逼的：**光在 1 纳秒里走 0.3 米**。想要米级甚至亚米级测距，就必须把「信号到达天线的那一刻」掐准到纳秒级。而普通软件做得到吗？

| 时间尺度 | 对应距离误差 | 谁在干                         |
| -------- | ------------ | ------------------------------ |
| 1 纳秒   | ≈ 0.3 米     | **PHY/固件**（硬件捕获前导码） |
| 10 纳秒  | ≈ 3 米       | 高速硬件                       |
| 1 微秒   | ≈ 300 米     | 内核软件上限                   |
| 1 毫秒   | ≈ 30 万米    | 用户态软件时延                 |

一个用户态函数调用的时延是微秒到毫秒量级——和纳秒差着**三个数量级**。所以「帧前导码出现在天线接口的精确时刻」，只有 PHY 层的硬件捕获电路（TOD/TOA 寄存器）能记下来，固件读寄存器、算 RTT，主机软件碰都碰不到。这就是「主机侧薄、核心在固件」的根。

**而这里藏着一个本文最重要的反直觉结论**：你翻遍整个 Android Framework 的 RTT 代码，找不到 `距离 = 光速 × RTT / 2` 这行算式——**Framework 根本没算过距离**。它收到的结果里，距离已经是算好的毫米数了。

这个结论在第 9 节会揭晓全貌。现在先回到地面，看 App 那一行 `startRanging` 到底触发了什么。

---

# 2 App 怎么发起一次测距？——`WifiRttManager` 这一层

App 拿到的入口是 `WifiRttManager`（系统服务 `Context.WIFI_RTT_RANGING_SERVICE`）。它不测距，只做三件事：构造 `RangingRequest`、跨 Binder 把请求丢给 system_server、把结果回调回 App 线程。

```java
// packages_modules_Wifi/framework/java/android/net/wifi/rtt/WifiRttManager.java:225
@SystemApi
public void startRanging(@Nullable WorkSource workSource, @NonNull RangingRequest request,
        @NonNull @CallbackExecutor Executor executor, @NonNull RangingResultCallback callback) {
    // ...校验 executor / callback 非空...
    Binder binder = new Binder();                       // 每次请求一个独立 Binder，用于 linkToDeath
    Bundle extras = new Bundle();
    mService.startRanging(binder, mContext.getOpPackageName(),
            mContext.getAttributionTag(), workSource, request, new IRttCallback.Stub() {
                @Override
                public void onRangingFailure(int status) throws RemoteException {
                    clearCallingIdentity();
                    executor.execute(() -> callback.onRangingFailure(status));
                }
                @Override
                public void onRangingResults(List<RangingResult> results) throws RemoteException {
                    clearCallingIdentity();
                    executor.execute(() -> callback.onRangingResults(results));
                }
            }, extras);
}
```

- **`new Binder()`**：每次请求生成一个独立 Binder 对象，作为这次请求的「命」。它后面要 `linkToDeath`——App 死了，system_server 才能靠这个 Binder 的死亡回调清理队列里的残留请求。
- **`IRttCallback.Stub`**：App 传给服务端的回调，是一个 AIDL 双向对象。注意它被包了一层 `executor.execute(...)`——无论服务端在哪个 Binder 线程回调，最终都切回 App 指定的执行器。
- **`clearCallingIdentity()`**：清掉 Binder 携带的调用者身份，否则 `executor.execute` 的线程会继承错误 UID。

请求的内容在 `RangingRequest` 里，核心是两个字段（`RangingRequest.java:145`）：

```java
public final List<ResponderConfig> mRttPeers;   // 要测距的「目标」列表
public final int mRttBurstSize;                 // 每个 Burst 发几帧 FTM
```

`mRttPeers` 里每个 `ResponderConfig` 描述一个目标：`macAddress`、`responderType`（`RESPONDER_AP`/`RESPONDER_STA`/`RESPONDER_P2P_GO`/`RESPONDER_P2P_CLIENT`/`RESPONDER_AWARE`）、`frequency`（信道频率）、`channelWidth`、`preamble`、`supports80211mc`（是否支持 802.11mc）等。

> 一个容易被忽略的点：**测距不需要先连上 AP**。`ResponderConfig` 只需要知道对端的 MAC + 信道（通常来自扫描结果，也可带外获知），这叫 pre-association 测距。这是 FTM 和「连接后测延迟」的本质区别——它测的是空口往返，不经过任何上层网络栈。第 7 节会展开这层含义。

---

# 3 请求进了 system_server，先过哪几道关？——`RttServiceImpl` 校验

`WifiRttManager` 跨 Binder 调用的，是 system_server 里 `RttServiceImpl.startRanging`（它实现 `IWifiRttManager.Stub`）。这一层是「前台」，先干一件最重要的事：**把不合法、没权限、会耍赖的请求挡在队列外面**。

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/rtt/RttServiceImpl.java:524
@Override
public void startRanging(IBinder binder, String callingPackage, String callingFeatureId,
        WorkSource workSource, RangingRequest request, IRttCallback callback, Bundle extras)
        throws RemoteException {
    // ① 参数校验：binder / request / 每个 responder / callback 都不能为空
    if (binder == null) throw new IllegalArgumentException("Binder must not be null");
    if (request == null || request.mRttPeers == null || request.mRttPeers.size() == 0) {
        throw new IllegalArgumentException("Request must not be null or empty");
    }
    // ...逐个 responder 判空...
    request.enforceValidity(mAwareManager != null);

    // ② 可用性：RTT HAL 在不在、是否 doze、定位开关是否打开
    if (!isAvailable()) {
        callback.onRangingFailure(RangingResultCallback.STATUS_CODE_FAIL_RTT_NOT_AVAILABLE);
        return;
    }

    // ③ 权限：ACCESS_WIFI_STATE + CHANGE_WIFI_STATE + 精确定位(或 Aware 场景的 nearby)
    enforceAccessPermission();
    enforceChangePermission();
    mWifiPermissionsUtil.checkPackage(uid, callingPackage);
    // ...Aware-only 请求走 nearby 权限，其余走 enforceFineLocationPermission...

    // ④ linkToDeath：App 死了，靠 DeathRecipient 清掉它的请求
    IBinder.DeathRecipient dr = new IBinder.DeathRecipient() {
        @Override public void binderDied() {
            binder.unlinkToDeath(this, 0);
            mRttServiceSynchronized.mHandler.post(() ->
                    mRttServiceSynchronized.cleanUpClientRequests(uid, null));
        }
    };
    binder.linkToDeath(dr, 0);

    // ⑤ 全部通过，投递到单线程队列
    mRttServiceSynchronized.mHandler.post(() ->
            mRttServiceSynchronized.queueRangingRequest(uid, sourceToUse, binder, dr, ...));
}
```

- **`isAvailable()`**（`:460`）三条件取与：`mWifiRttController != null`（HAL 就绪）`&& !mPowerManager.isDeviceIdleMode()`（不在 doze）`&& mWifiPermissionsUtil.isLocationModeEnabled()`（定位开关开）。三者任一不满足，立刻回 `STATUS_CODE_FAIL_RTT_NOT_AVAILABLE`。
- **权限**分两路：普通 AP 测距要 `ACCESS_FINE_LOCATION`（精确定位，因为距离可以反推位置）；「只测 Aware 对端」这种特例，在 T 版本后允许用 `NEARBY_WIFI_DEVICES` 权限替代。这个分支就是 `onlyAwareApRanged` 那段判断。
- **`linkToDeath`** 是这套 API 的「防僵尸」设计：App 在排队中途被杀，system_server 若不清理，它的请求会永远占着队列头。靠 Binder 死亡通知 `binderDied()` 触发 `cleanUpClientRequests(uid, null)`。

> **为什么要在 Binder 线程外再做一遍可用性检查？** 因为 App 从 `isAvailable()` 到真正调 `startRanging` 之间有时间差，WiFi 可能刚好被关掉。所以这里重新判一次，宁可当场失败，也不放进一个注定失败的队列。

注意到没有——校验完，它没直接去测，而是把请求 `post` 给了一个 `mHandler`。这就是下一节的主角：单线程队列状态机。

---

# 4 为什么用一个单线程队列状态机？——`RttServiceSynchronized`

先回答标题的问题：**为什么测距要排队，不能「来一个测一个」？** 三个理由：

1. **射频是串行资源**：FTM 要占用信道做帧交换，同一时刻两个测距请求会互相踩。
2. **要防刷**：测距能反推位置，是敏感能力。一个 App 疯狂提交，会把射频资源打满、还能把定位「刷」出来。
3. **要兜底**：HAL/固件可能永远不返回结果，必须有人盯着超时、催单、清理。

于是 `RttServiceImpl` 内部嵌套了一个 `RttServiceSynchronized`——所有状态都只在一个 `Handler` 线程上读写，天然线程安全。先看它的家当（`:702`）：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/rtt/RttServiceImpl.java:702
private class RttServiceSynchronized {
    public Handler mHandler;
    private int mNextCommandId = 1000;                    // cmdId 自增，从 1000 起
    private Map<Integer, RttRequesterInfo> mRttRequesterInfo = new HashMap<>();
    private List<RttRequestInfo> mRttRequestQueue = new LinkedList<>();
    private WakeupMessage mRangingTimeoutMessage = null;  // 超时定时器

    RttServiceSynchronized(Looper looper) {
        mHandler = new Handler(looper);
        mRangingTimeoutMessage = new WakeupMessage(mContext, mHandler,
                HAL_RANGING_TIMEOUT_TAG, () -> { timeoutRangingRequest(); });
    }
}
```

四件家当对应四个职责：`mRttRequestQueue` 是**队列**，`mNextCommandId` 是**叫号机**，`mRttRequesterInfo` 是**节流账本**（每个 UID 上次执行时间），`mRangingTimeoutMessage` 是**催菜闹钟**。

整个状态机就三个方法在转：`queueRangingRequest`（入队）→ `executeNextRangingRequestIfPossible`（叫下一个）→ `startRanging`（真正下发）。中间穿插 `isRequestorSpamming`（限流）和 `preExecThrottleCheck`（节流）两道闸。它的状态流转如下图：

![16-queue-state-machine](assets/16-WiFi-RTT-%E6%B5%8B%E8%B7%9D-%E2%80%94-%E4%BB%8E-startRanging-%E5%88%B0%E8%B7%9D%E7%A6%BB%E8%AE%A1%E7%AE%97/16-queue-state-machine.svg)

**读图要点**：橙色的 `isRequestorSpamming` / `preExecThrottleCheck` 是两道闸，拦下就 `onRangingFailure`；绿色的是成功下发后的「等结果」状态，靠 `mRangingTimeoutMessage` 超时兜底，结果回来走 `onRangingResults` 收尾。

## 4.1 入队：`queueRangingRequest` 与每 UID 20 条的限流

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/rtt/RttServiceImpl.java:831
private void queueRangingRequest(int uid, WorkSource workSource, IBinder binder, ...) {
    mRttMetrics.recordRequest(workSource, request);

    if (isRequestorSpamming(workSource)) {          // 防刷闸
        binder.unlinkToDeath(dr, 0);
        callback.onRangingFailure(RangingResultCallback.STATUS_CODE_FAIL);
        return;
    }
    RttRequestInfo newRequest = new RttRequestInfo();
    // ...填 uid / workSource / binder / request / callback...
    mRttRequestQueue.add(newRequest);               // 入队
    executeNextRangingRequestIfPossible(false);     // 尝试执行队头
}
```

`isRequestorSpamming`（`:871`）的判定很简单：**数一数队列里每个 UID 已经占了多少条，全部 ≥ `MAX_QUEUED_PER_UID`（20）就算刷**。它遍历 `mRttRequestQueue`，对每个 `RttRequestInfo` 的 `workSource` 里每个 UID 累加计数，再检查新请求的 UID 是否也到了 20。到了就整个请求拒掉，绝不入队。

> `MAX_QUEUED_PER_UID = 20`（`:130`）是「硬限流」——不管你前台后台，排队都不许超过 20 条。它拦的是「**排队堆积**」。下一道闸拦的是「**执行频率**」，两者不是一回事。

## 4.2 叫号与下发：`executeNextRangingRequestIfPossible` → `startRanging`

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/rtt/RttServiceImpl.java:913
private void executeNextRangingRequestIfPossible(boolean popFirst) {
    if (popFirst) {                                  // 队头已处理完，弹出
        if (mRttRequestQueue.size() == 0) { /* ...忽略空队列的 pop... */ }
        else {
            RttRequestInfo topOfQueueRequest = mRttRequestQueue.remove(0);
            topOfQueueRequest.binder.unlinkToDeath(topOfQueueRequest.dr, 0);
        }
    }
    if (mRttRequestQueue.size() == 0) return;        // 队列空，无事可做

    RttRequestInfo nextRequest = mRttRequestQueue.get(0);
    if (nextRequest.peerHandlesTranslated || nextRequest.dispatchedToNative) {
        return;                                      // 队头正在执行/翻译中，别再派
    }
    startRanging(nextRequest);                       // 派发队头
}
```

关键在 `startRanging`（`:944`）——三道闸依次过，全过了才真正 `rangeRequest`：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/rtt/RttServiceImpl.java:944
private void startRanging(RttRequestInfo nextRequest) {
    if (!isAvailable()) { /* ...失败 + 弹出下一个... */ return; }

    if (processAwarePeerHandles(nextRequest)) {      // Aware 的 PeerHandle 要先把 ID 换成 MAC
        return;                                       // 翻译中，defer，等回调再重试
    }

    if (!preExecThrottleCheck(nextRequest.workSource, nextRequest.callingPackage)) {
        /* ...节流拦截，失败 + 弹出下一个... */ return;
    }

    nextRequest.cmdId = mNextCommandId++;            // ★ 分配 cmdId
    mLastRequestTimestamp = mClock.getWallClockMillis();
    if (mWifiRttController != null
            && mWifiRttController.rangeRequest(nextRequest.cmdId, nextRequest.request)) {
        long timeout = HAL_RANGING_TIMEOUT_MS;        // 默认 5 秒
        for (ResponderConfig responderConfig : nextRequest.request.mRttPeers) {
            if (responderConfig.responderType == ResponderConfig.RESPONDER_AWARE) {
                timeout = HAL_AWARE_RANGING_TIMEOUT_MS;  // Aware 放宽到 10 秒
                break;
            }
        }
        mRangingTimeoutMessage.schedule(mClock.getElapsedSinceBootMillis() + timeout);
    } else {
        /* ...rangeRequest 失败：HAL 故障，失败 + 弹出下一个... */
    }
    nextRequest.dispatchedToNative = true;
}
```

- **`mNextCommandId++`**：cmdId 从 1000 自增，是每次下发给 HAL 的唯一编号。结果回来时要靠它和队头对账（`onRangingResults` 里 `topOfQueueRequest.cmdId != cmdId` 直接丢弃）。为什么从 1000 而不是 0？避免和「未初始化」的 0 撞车——`RttRequestInfo` 里 `cmdId` 初值是 0。
- **`mRangingTimeoutMessage.schedule(...)`**：下发成功后立刻上闹钟。默认 `HAL_RANGING_TIMEOUT_MS = 5_000`，Aware 请求 `HAL_AWARE_RANGING_TIMEOUT_MS = 10_000`（因为 Aware 要先走服务发现、对端可能还在醒着测，更慢）。
- **`processAwarePeerHandles`**：Aware 场景 App 给的是 `PeerHandle`（一个不透明的 ID），不是 MAC。得先调 `mAwareManager.requestMacAddresses` 把 ID 换成 MAC 才能下发。这一步是异步的，所以先 `return`（defer），等回调 `processReceivedAwarePeerMacAddresses` 里重建请求再 `startRanging`。

## 4.3 后台节流：`preExecThrottleCheck`

这是「执行频率」那一道闸（`:1024`）。逻辑：如果请求里**所有 UID 都在后台**（`mActivityManager.getUidImportance(uid) > IMPORTANCE_FOREGROUND_SERVICE`），就查 `mRttRequesterInfo` 账本里每个 UID 的 `lastRangingExecuted`——距上次执行不到 `config_wifiRttBackgroundExecGapMs`，就拦截。后台包名在白名单 `config_wifiBackgroundRttThrottleExceptionList` 里的除外。放行了就更新 `lastRangingExecuted = 现在`。

> **三道闸的分工**：`isRequestorSpamming` 拦「排队堆积」（静态计数，20 条封顶）；`preExecThrottleCheck` 拦「后台刷频率」（时间间隔，动态节流）；`mRangingTimeoutMessage` 兜底「挂死」（超时催单）。三道闸共同保证：**一个 App 想滥用测距，要么被限流、要么被节流、要么被超时清理。**

## 4.4 超时与清理：`timeoutRangingRequest` / `cleanUpOnDisable`

超时了怎么办（`:806`）？取队头，若已下发（`dispatchedToNative`），调 `cancelRanging(rri)` 取消 HAL 侧请求，回 `onRangingFailure(STATUS_CODE_FAIL)`，然后 `executeNextRangingRequestIfPossible(true)` 弹掉队头、派下一个。

doze 模式进来时，`disable()` 会触发 `cleanUpOnDisable`（`:731`）：遍历整个队列，已下发的 `cancelRanging`，全部回 `STATUS_CODE_FAIL_RTT_NOT_AVAILABLE`，解绑 Binder 死亡监听，清空队列、取消闹钟。**一句话：doze 一进来，所有在途测距就地作废。**

到这里，Framework 的「管理逻辑」讲完了。它自始至终没碰过一毫米的距离。下一节看它怎么把请求「翻译」成 HAL 能懂的样子。

---

# 5 HAL 门面：Framework 怎么把请求「翻译」成 HAL 结构？——`WifiRttController`

从 `RttServiceSynchronized.startRanging` 那行 `mWifiRttController.rangeRequest(cmdId, request)` 开始，进入 `com.android.server.wifi.hal` 包。这里的 `WifiRttController` 是一个**门面（Facade）**：对上承接 Java 的 `RangingRequest`，对下同时兼容 HIDL 和 AIDL 两种 HAL。

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/hal/WifiRttController.java:268
public boolean rangeRequest(int cmdId, RangingRequest request) {
    return validateAndCall("rangeRequest", false,
            () -> mWifiRttController.rangeRequest(cmdId, request));
}
```

`mWifiRttController` 是 `IWifiRttController` 接口（`:26`），有两个实现：`WifiRttControllerHidlImpl`（老 HIDL）和 `WifiRttControllerAidlImpl`（新 AIDL）。**AIDL 是主线**。真正干活的翻译在 `WifiRttControllerAidlImpl.rangeRequest`（`:156`）：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/hal/WifiRttControllerAidlImpl.java:156
public boolean rangeRequest(int cmdId, RangingRequest request) {
    synchronized (mLock) {
        if (!checkIfaceAndLogFailure(methodStr)) return false;
        updateRttCapabilities();
        RttConfig[] rttConfigs =
                convertRangingRequestToRttConfigs(request, mRttCapabilities);   // ★ 翻译
        if (rttConfigs == null) return false;
        else if (rttConfigs.length == 0) {
            dispatchOnRangingResults(cmdId, new ArrayList<>());   // 全部无效 → 直接空结果
            return true;
        }
        mWifiRttController.rangeRequest(cmdId, rttConfigs);       // ★ 跨 AIDL Binder 给 HAL
        return true;
    }
}
```

`convertRangingRequestToRttConfigs`（`:447`）就是那个「服务员翻译菜单」的地方。它把每个 `ResponderConfig` 转成一个 AIDL `RttConfig`，其中最关键的是**测距类型的选择**（`:464`）：

```java
if (responder.supports80211azNtb && cap.ntbInitiatorSupported) {
    config.type = RttType.TWO_SIDED_11AZ_NTB;      // 802.11az 非触发式（优先）
} else if (responder.supports80211mc) {
    config.type = RttType.TWO_SIDED_11MC;          // 802.11mc 双侧
} else if (cap.oneSidedRttSupported) {
    config.type = RttType.ONE_SIDED;               // 单侧 RTT（对端不支持 mc 时）
} else { /* 都不支持，跳过这个 peer */ }
```

- 优先级 `11az NTB > 11mc > one-sided`：有 802.11az 就用 az（更准），退而求其次用 mc，都不行才用单侧。
- 剩下的字段照抄：`config.addr`（MAC）、`config.channel`（频率）、`config.bw`（带宽，经 `halRttChannelBandwidthCapabilityLimiter` 按设备能力降档）、`config.preamble`（经 `halRttPreambleCapabilityLimiter` 降档）、`numFramesPerBurst`（= `mRttBurstSize`）、`numRetriesPerFtmr = 3` 等。

还有一个值得看的细节——**Burst Duration 的换算**（`:441`）：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/hal/WifiRttControllerAidlImpl.java:441
// Burst duration = (N_FTMPB * (K + 1)) - 1) * T_MDFTM + T_FTM + aSIFSTime + T_Ack
// 因为 K、T_MDFTM 等取决于芯片，Framework 用实验值做简化换算：
private static int getOptimumBurstDuration(int burstSize) {
    if (burstSize <= 8) return 9;   // 32 ms
    if (burstSize <= 24) return 10;  // 64 ms
    return 11;                      // 128 ms
}
```

> 这段注释原文引用了 IEEE 802.11 的 **§11.21.6.3（FTM procedure negotiation）** 和 **§9.4.2.167（Fine Timing Measurement Parameters element）** 里的 Burst Duration 编码表（值 2→250us、3→500us … 11→128ms、15→无偏好）。Framework 懒得精确算，直接用「分三档」的粗略映射，把精算留给厂商软件去 override。这又是一个「主机薄」的注脚。

回传时，AIDL HAL 回调 `onResults(cmdId, RttResult[])`（`:229`），经 `halToFrameworkRangingResults`（`:257`）把 HAL 的 `RttResult` 转回 Framework 的 `RangingResult`。这个转换里藏着距离字段的「原样搬运」——`setDistanceMm(rttResult.distanceInMm)`，一毫米都没动过。

Framework 这一层的状态码也值得记一笔。`WifiRttController` 定义了 16 个 `FRAMEWORK_RTT_STATUS_*`（`:45`），从 `SUCCESS=0` 到 `FAIL_FTM_PARAM_OVERRIDE=15`，和 HAL 的 `RttStatus` 一一对应。这套状态码的「总源头」在 legacy 头文件里，第 6 节会看到它更完整的版本。

---

# 6 跨进程到 vendor HAL：AIDL 默认实现怎么落到底层？

`WifiRttControllerAidlImpl` 那行 `mWifiRttController.rangeRequest(cmdId, rttConfigs)` 里的 `mWifiRttController`，是 `android.hardware.wifi.IWifiRttController`——**这一调就跨了 Binder 进程边界**，从 system_server 进入 vendor HAL 进程（`wifi` 服务）。

vendor HAL 的默认实现（AOSP 提供的 reference）在 `hardware_interfaces/wifi/aidl/default/wifi_rtt_controller.cpp`。它自己不测距，是个**纯翻译+转发**的三明治：

```cpp
// hardware_interfaces/wifi/aidl/default/wifi_rtt_controller.cpp:137
ndk::ScopedAStatus WifiRttController::rangeRequestInternal(
        int32_t cmd_id, const std::vector<RttConfig>& rtt_configs) {
    // 先试 v3（11mc + 11az）
    std::vector<legacy_hal::wifi_rtt_config_v3> legacy_configs_v3;
    if (!aidl_struct_util::convertAidlVectorOfRttConfigToLegacyV3(rtt_configs,
                                                                  &legacy_configs_v3)) {
        return createWifiStatus(WifiStatusCode::ERROR_INVALID_ARGS);
    }
    const auto& on_results_callback_v3 = [weak_ptr_this](legacy_hal::wifi_request_id id, ...) {
        // 结果回来 → convertLegacyVectorOfRttResultV3ToAidl → 逐个回调 onResults
    };
    legacy_hal::wifi_error legacy_status = legacy_hal_.lock()->startRttRangeRequestV3(
            ifname_, cmd_id, legacy_configs_v3, on_results_callback_v3);
    if (legacy_status != legacy_hal::WIFI_ERROR_NOT_SUPPORTED) {
        return createWifiStatusFromLegacyError(legacy_status);
    }
    // 回退到 11mc（v1/v2）
    // ...startRttRangeRequest(ifname_, cmd_id, legacy_configs, on_results_callback, v2)...
}
```

三明治三层：**AIDL 结构 → legacy C 结构**（`convertAidlVectorOfRttConfigToLegacyV3`）→ **`WifiLegacyHal::startRttRangeRequestV3`** → **厂商函数表**。

`WifiLegacyHal` 是 AOSP 提供的「legacy HAL 封装层」，它拿着厂商 `libwifi-hal` 的函数表（`global_func_table_`）转发（`wifi_legacy_hal.cpp:1370`）：

```cpp
wifi_error WifiLegacyHal::startRttRangeRequestV3(...) {
    // ...把用户回调包成内部回调 on_rtt_results_internal_callback_v3...
    wifi_error status = global_func_table_.wifi_rtt_range_request_v3(
            ifname_, cmd_id, legacy_configs_v3, &event_handler_v3);
    return status;
}
```

而 `global_func_table_` 里这些函数指针，定义在 legacy 头文件 `wifi_hal.h:789`：

```c
wifi_error (* wifi_rtt_range_request)(wifi_request_id, wifi_interface_handle, unsigned,
        wifi_rtt_config[], wifi_rtt_event_handler);
wifi_error (* wifi_rtt_range_request_v3)(wifi_request_id, wifi_interface_handle, unsigned,
        wifi_rtt_config_v3[], wifi_rtt_event_handler_v3);
wifi_error (* wifi_rtt_range_cancel)(wifi_request_id,  wifi_interface_handle, unsigned,
        mac_addr addr[]);
```

**这就是 Framework 和真正测距之间的最后一道「人肉边界」**：从这往下，代码不再是 AOSP 的，而是 QCOM / MTK 各自实现的 `libwifi-hal` 库（`dlopen` 进来）。

同样值得看的，是 legacy 结果结构 `wifi_rtt_result`（`rtt.h:191`）——它是整条链的「通用货币」：

```c
// hardware_interfaces/wifi/legacy_headers/include/hardware_legacy/rtt.h:191
typedef struct {
    mac_addr addr;                // 对端 MAC
    unsigned measurement_number;  // 尝试的测量帧数
    unsigned success_number;      // 成功的测量帧数
    wifi_rtt_status status;       // 测距状态
    wifi_rtt_type type;           // 测距类型
    wifi_timespan rtt;            // 往返时间，单位：皮秒（10^-12 秒）
    wifi_timespan rtt_sd;         // RTT 标准差，皮秒
    int distance_mm;              // 距离，单位：毫米（可选）
    int distance_sd_mm;           // 距离标准差，毫米
    // ...rssi、速率、LCI/LCR 等...
} wifi_rtt_result;
```

**注意这个结构里 `rtt`（皮秒）和 `distance_mm`（毫米）是并列的两个字段**——固件/厂商既上报原始往返时间，也顺手上报算好的距离。`wifi_rtt_status` 枚举（`rtt.h:9`）比 Framework 那 16 个还全，一路排到 `RTT_STATUS_SECURE_RANGING_FAILURE_UNKNOWN = 22`，覆盖了 802.11az 安全测距的各种失败。

下一节先绕道澄清一个「陷阱」，再回来追 QCOM 和 MTK 的驱动薄层。

---

# 7 为什么 supplicant 在这条链里「缺席」？

读到这里你可能想问：前面几章（扫描、连接、P2P、NAN）都有 wpa_supplicant 的身影，怎么测距这条链它一声不吭？

答案是：**Android 的 RTT 发起端（ISTA）不走 supplicant，直接切到了 vendor HAL。** 在 `external_wpa_supplicant_8` 这棵树里，你**找不到** STA 侧的 RTT 发起实现——没有 `ranging.c`，也没有下发 `NL80211_CMD_START_RANGING` 的代码。

supplicant 里和 FTM 相关的，只有三个「配角」：

| 位置                                                         | 角色                         | 说明                                                         |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `src/ap/rrm.c`                                               | **AP 侧 RRM Range Request**  | 802.11k：AP 发 Range Request 让 STA 去测距，是「AP 触发 STA 测」，不是手机主动测 |
| `src/drivers/driver_nl80211.c`（`NL80211_ATTR_FTM_RESPONDER`） | **AP 侧 FTM responder 配置** | 在 `nl80211_set_ap` 里把「本机当 FTM 响应方」的能力透传给内核 |
| QCA vendor 命令                                              | **PASN 安全测距上下文**      | 802.11az 安全测距的关联前协商                                |

前两个都是 **AP/responder 侧**——即「别人来测我，我答应」的那一方。而手机当 **发起方（ISTA）** 去测 AP 距离，这套逻辑 Android 压根没放在 supplicant。

> **为什么这么切？** 两个原因：其一，测距的核心在固件，主机侧本来就只剩「透传」，没必要再绕 supplicant 多一跳；其二，测距要**不关联、跨信道**地直接和 AP 交换 FTM 帧，这需要设备层面对射频的精细控制（切信道、抢占空中时间），vendor HAL 离固件更近，厂商能直接用自己的引擎（QCOM 的 LOWI）驱动。supplicant 那套「SME 状态机 + nl80211」的抽象，对测距来说是负担，不是便利。

**这一段是本文最重要的「排雷」**：网上不少资料把 RTT 说成「supplicant 实现 FTM 发起」，那是把 802.11k RRM（AP 触发）和 802.11mc FTM（STA 主动）混为一谈了。Android 的 RTT 发起端，从 Framework 直接进 vendor HAL，supplicant 全程旁观。

绕完这个弯，回到主线：vendor HAL 的函数表入口 `wifi_rtt_range_request_v3`，QCOM 和 MTK 各实现了一份，风格南辕北辙。

---

# 8 驱动这层到底有多「薄」？——QCOM `wifi_pos` 与 MTK `rtt.c` 的双平台对比

进了 vendor HAL 这道门，就轮到后厨的**配菜间**——驱动——登场了。它离固件最近，却依然不碰锅铲，只做「参数透传 + 结果聚合」。两家配菜间的手艺南辕北辙，但殊途同归：都薄。

先看 QCOM 的 vendor HAL 这一跳。QCOM 的 `libwifi-hal` 里，`wifi_rtt_range_request` 的实现（`qcwcn/wifi_hal/rtt.cpp:161`）几乎是「一进一出」：

```cpp
// hardware-qcom-wlan/qcwcn/wifi_hal/rtt.cpp:161
wifi_error wifi_rtt_range_request(wifi_request_id id, wifi_interface_handle iface,
        unsigned num_rtt_config, wifi_rtt_config rtt_config[], wifi_rtt_event_handler handler) {
    // ...判空 + 检查 WIFI_FEATURE_D2AP_RTT 特性位...
    /* RTT commands are diverted through LOWI interface. */
    lowiWifiHalApi = getLowiCallbackTable(
                ONE_SIDED_RANGING_SUPPORTED|DUAL_SIDED_RANGING_SUPPORED);
    ret = (wifi_error)lowiWifiHalApi->rtt_range_request(id, iface,
                                                        num_rtt_config, rtt_config, handler);
    return ret;
}
```

它把请求整个「转交」给了 **LOWI**——Qualcomm 的室内定位引擎（Location Engine，闭源，不在这棵开源树里）。LOWI 作为用户态定位引擎，通过 nl80211 vendor command 驱动内核里的 `wifi_pos` 组件，再由 `wifi_pos` 下发 WMI 命令给固件。

QCOM 驱动侧的 `wifi_pos` 组件（`qca-wifi-host-cmn/umac/wifi_pos` + `target_if/wifi_pos` + `os_if/linux/wifi_pos`）干的事，比「发起 FTM」更高一层——它是**定位请求的经纪人**：

- `ucfg_wifi_pos_process_req`（`wifi_pos_ucfg.c:112`）：检查「请求的 App 是否已注册」，未注册直接拒绝（`OEM_ERR_APP_NOT_REGISTERED`），然后转给 `wifi_pos_req_handler`。
- `ucfg_wifi_pos_get_ftm_cap` / `set_ftm_cap`：FTM 能力开关。
- `ucfg_wifi_pos_measurement_request_notification`：**响应方（RSTA）** 收到别人的测距请求时的通知。
- `target_if_wifi_pos_tx_ops.c` 里注册的 `wmi_send_rtt_pasn_auth_status_cmd` / `wmi_send_rtt_pasn_deauth_cmd`：**802.11az PASN** 安全测距的认证状态上报。

也就是说，QCOM 的 `wifi_pos` 主要负责 **responder 模式 + OEM 定位 + PASN**，而真正的 FTM **发起端**（手机测 AP）在 LOWI + 固件里完成。这印证了第 1 节的判断：主机把「发起测距」的活都外包了出去。

再往下到 WMI 层，能找到固件回传时间戳的原型（`wmi_unified_param.h:8407`）：

```c
// qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:8407
typedef struct {
    uint32_t chain_mask:3, bw:2, rsvd:27;
    uint32_t txrxchain_mask;
    uint64_t tod;   // Time of Departure，分辨率 0.1 ns
    uint64_t toa;   // Time of Arrival，分辨率 0.1 ns
    uint64_t t3;    // ISTA 发 Ack 的时刻
    uint64_t t4;    // RSTA 收 Ack 的时刻
    uint32_t rssi0; uint32_t rssi1; uint32_t rssi2; uint32_t rssi3;
} wmi_host_rtt_meas_event;
```

**`tod/toa/t3/t4` 四个 64 位时间戳，分辨率 0.1 纳秒**——这就是固件测距的「原始输出」。有趣的是，`wmi_unified_rtt_meas_req_cmd_send` 和 `wmi_extract_rtt_ev` 这套经典 11mc 的 WMI 接口在当前驱动里**已没有调用者**（grep 全树仅见定义）——发起端逻辑被抽走去了 LOWI 和固件，主机只留下 PASN 这类「新能力」的接线。这本身就是「主机越写越薄」的活证据。

MTK 则是另一个极端：**把整套 RTT 收发包逻辑写在一个 564 行的单文件 `mgmt/rtt.c` 里**，主机亲自组命令、亲自收事件。入口（`rtt.c:338`）：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/mgmt/rtt.c:338
uint32_t rttHandleRttRequest(struct ADAPTER *prAdapter,
                             struct PARAM_RTT_REQUEST *prRequest, uint8_t ucBssIndex) {
    struct RTT_INFO *rttInfo = &(prAdapter->rWifiVar.rRttInfo);
    if (prRequest->ucConfigNum > CFG_RTT_MAX_CANDIDATES ||      // 上限 10 个目标
        prRequest->ucConfigNum <= 0 ||
        (prRequest->fgEnable && rttInfo->fgIsRunning) ||        // 已在跑，拒绝
        (!prRequest->fgEnable && !rttInfo->fgIsRunning))
        return WLAN_STATUS_NOT_ACCEPTED;

    if (prRequest->fgEnable) {
        status = rttStartRttRequest(prAdapter, prRequest, ucBssIndex);  // 组命令下发
    } else {
        rttFreeAllResults(rttInfo);
        status = rttCancelRttRequest(prAdapter, prRequest);             // 取消
    }
    return status;
}
```

`rttStartRttRequest`（`:246`）遍历目标、逐个拷贝到 `CMD_RTT_REQUEST`（`scanSearchBssDescByBssid` 确认 BSSID 在扫描结果里才收），最后 `rttSendCmd`（`:137`）：

```c
status = wlanSendSetQueryCmd(prAdapter,
        CMD_ID_RTT_RANGE_REQUEST, TRUE, FALSE, FALSE,
        nicCmdEventSetCommon, nicOidCmdTimeoutCommon,
        sizeof(struct CMD_RTT_REQUEST), (uint8_t *) cmd, NULL, 0);
```

`CMD_ID_RTT_RANGE_REQUEST` 是下发固件的命令 ID；`rttUpdateStatus` 会置 `fgIsRunning=true` 并启动一个 `RTT_REQUEST_DONE_TIMEOUT_SEC = 4`（`rtt.h:29`）的看门狗——**4 秒没收到结果就超时**。

结果从固件回两条事件：`EVENT_RTT_RESULT`（每条结果）→ `rttEventResult`（`:486`）把结果挂进 `rResultList`；`EVENT_RTT_DONE`（全部完成）→ `rttEventDone`（`:460`）→ `rttReportDone`（`:371`）聚合后经 `kalCfg80211VendorEvent` 用 `RTT_ATTRIBUTE_RESULT` 属性回给用户态。MTK 固件上报的结果结构（`wlan_lib.h:1579`）里，距离是**现成的**：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/wlan_lib.h:1579
struct RTT_RESULT {
    uint8_t aucMacAddr[MAC_ADDR_LEN];
    uint32_t u4BurstNum, u4MeasurementNumber, u4SuccessNumber;
    uint32_t eStatus;
    // ...
    int64_t i8Rtt;               // RTT
    int64_t i8RttSd;
    int32_t i4DistanceMM;        // ★ 距离，毫米 —— 固件算好了
    int32_t i4DistanceSdMM;
    int32_t i4DistanceSpreadMM;
    // ...
};
```

两家对比，一张表看清「殊途同归」：

![16-dual-platform](assets/16-WiFi-RTT-%E6%B5%8B%E8%B7%9D-%E2%80%94-%E4%BB%8E-startRanging-%E5%88%B0%E8%B7%9D%E7%A6%BB%E8%AE%A1%E7%AE%97/16-dual-platform.svg)

| 维度           | QCOM                                              | MTK                                           |
| -------------- | ------------------------------------------------- | --------------------------------------------- |
| 发起端位置     | **LOWI（闭源引擎）+ 固件**                        | **主机 `rtt.c` + 固件**                       |
| 主机驱动组件   | `wifi_pos`（responder + OEM + PASN）              | 单文件 `mgmt/rtt.c`                           |
| 下发命令       | WMI（经 LOWI 的 vendor cmd 间接）                 | `CMD_ID_RTT_RANGE_REQUEST`                    |
| 结果事件       | `wmi_host_rtt_meas_event`（tod/toa/t3/t4 时间戳） | `EVENT_RTT_RESULT`（`i4DistanceMM` 距离现成） |
| 主机是否算距离 | 否（LOWI/固件算）                                 | 否（固件算）                                  |
| 超时           | —（LOWI 管）                                      | 4 秒（`RTT_REQUEST_DONE_TIMEOUT_SEC`）        |

共同点只有一句：**主机都是「参数透传 + 结果聚合」的薄层，距离计算都不在主机驱动里。** 差别只是「谁离固件更近」——QCOM 让闭源引擎 LOWI 去驱动固件，MTK 自己在内核里组命令但也不碰距离。

---

# 9 固件里的 FTM：T1-T4 时间戳从哪来？距离在哪算？

前面反复埋了一个伏笔：**距离 `c × RTT / 2` 到底在哪算？** 现在揭晓。

回顾姊妹系列的协议：FTM 一次测量要捕获四个时刻——t1（RSTA 发 FTM）、t2（ISTA 收 FTM）、t3（ISTA 发 Ack）、t4（RSTA 收 Ack），然后 `RTT = (t4−t1) − (t3−t2)`。这四个时刻，对应到 QCOM 固件回传的 `wmi_host_rtt_meas_event` 就是 `tod`（≈t1）、`toa`（≈t2）、`t3`、`t4`——**分辨率 0.1 纳秒**（比规范里 Timing Measurement 帧的 10ns 字段更细，因为固件内部用 0.1ns 定点数保精度）。

而 MTK 固件更干脆，直接回 `i8Rtt` 和 `i4DistanceMM`——**连 RTT 和距离都替你算好了**。

**所以距离计算的真实位置是：**

| 层                          | 算距离吗 | 证据                                                         |
| --------------------------- | -------- | ------------------------------------------------------------ |
| Framework                   | **不算** | 全代码无光速常数、无 `/2` 算式，只有 `setDistanceMm(rttResult.distanceInMm)` 原样搬运 |
| vendor HAL                  | **不算** | `wifi_rtt_result` 里 `distance_mm` 是「可选」字段，由下层填  |
| 驱动（QCOM/MTK）            | **不算** | QCOM `wifi_pos` 无光速常数；MTK `rtt.c` 只透传 `i4DistanceMM` |
| **固件（或 QCOM 的 LOWI）** | **算**   | MTK 固件直接回 `i4DistanceMM`；QCOM 固件回时间戳、LOWI 换算  |

**一句话：`距离 = 光速 × RTT / 2` 这行算式，写在固件里（MTK），或写在 QCOM 的闭源 LOWI 引擎里，唯独不在你能看到源码的主机软件里。**

这个事实把第 1 节的问题又往前推了一步：**不只是「时间戳必须在固件测」，连「距离换算」也没必要上主机。** 因为距离是 RTT 的纯函数，RTT 已经在固件手里，顺手乘个常数除个二，比把皮秒级时间戳一路浮点数搬回主机再算，更省事、也更不会在层层转换里丢精度。

> 这也是为什么「Framework 写了上千行却不算一毫米距离」——它的价值不在算，而在**调度与治理**：排队、限流、节流、超时、权限、结果对账。这是一台「治理型前台」，不是「测量仪器」。

---

# 10 结果怎么一路「逆流而上」回到 App？

下发方向追完了，回传方向是它的镜像。固件的结果（距离毫米数 + RTT + 状态）沿原路返回，每层只做「类型转换 + 过滤」，不加工数值：

```
固件 EVENT_RTT_DONE / wmi_host_rtt_meas_event
  → [WMI/事件] 驱动聚合（MTK rttReportDone → kalCfg80211VendorEvent）
  → [nl80211 vendor event] vendor HAL（QCOM LOWI 回调 / MTK gl_vendor 解析）
  → [函数表回调] WifiLegacyHal::on_rtt_results_internal_callback
  → [legacy→AIDL] wifi_rtt_controller.cpp convertLegacyVectorOfRttResultV3ToAidl
  → [AIDL Binder] WifiRttControllerAidlImpl.onResults(cmdId, RttResult[])
  → halToFrameworkRangingResults → dispatchOnRangingResults
  → RttServiceImpl.onRangingResults(cmdId, List<RangingResult>)
  → RttServiceSynchronized.onRangingResults(cmdId, results)
  → postProcessResults → callback.onRangingResults(finalResults)
  → App 线程 RangingResultCallback.onRangingResults
```

终点在 `RttServiceSynchronized.onRangingResults`（`:1235`）。它先做一件关键事——**用 cmdId 对账**：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/rtt/RttServiceImpl.java:1235
private void onRangingResults(int cmdId, List<RangingResult> results) {
    if (mRttRequestQueue.size() == 0) { /* 没人在等，丢弃 */ return; }
    mRangingTimeoutMessage.cancel();                 // ★ 撤销超时闹钟
    RttRequestInfo topOfQueueRequest = mRttRequestQueue.get(0);
    if (topOfQueueRequest.cmdId != cmdId) {
        Log.e(TAG, "cmdId=" + cmdId + " does not match pending RTT request cmdId="
                + topOfQueueRequest.cmdId);          // ★ 结果不是队头要的，丢弃
        return;
    }
    // ...检查定位权限是否还在，被吊销就不转发结果...
    List<RangingResult> finalResults = postProcessResults(topOfQueueRequest.request,
            results, topOfQueueRequest.isCalledFromPrivilegedContext);
    topOfQueueRequest.callback.onRangingResults(finalResults);   // 回 App
    executeNextRangingRequestIfPossible(true);      // 弹队头，派下一个
}
```

- **cmdId 对账**：结果回得晚、或取消后又回，`cmdId` 对不上队头就丢——防止「过期结果」污染下一个请求。
- **权限复查**：结果回来时再查一次定位权限（`checkCallersLocationPermission`），因为 App 可能在测距过程中被撤销定位授权，此时不转发结果。
- **`postProcessResults`**（`:1308`）补三种账：请求里有的 peer 但结果里没有的，补一个 `STATUS_FAIL`；LCI/LCR（AP 的位置信息）只有在特权上下文才保留，普通 App 拿不到；Aware 的 PeerHandle 要替换回原始 ID。

最后 `executeNextRangingRequestIfPossible(true)` 弹出队头，叫号下一位——**一个测距请求的生命周期到此闭环**。

![16-result-return](assets/16-WiFi-RTT-%E6%B5%8B%E8%B7%9D-%E2%80%94-%E4%BB%8E-startRanging-%E5%88%B0%E8%B7%9D%E7%A6%BB%E8%AE%A1%E7%AE%97/16-result-return.svg)

**读图要点**：绿色是回传方向，注意三处「不加工只过滤」——vendor HAL 的 legacy→AIDL 转换、Framework 的 `halToFrameworkRangingResults`、`postProcessResults` 的补账。距离毫米数从头到尾原封不动。

---

# 11 总结——一条「前台调度、固件测距」的链

# 全链路回顾

一条主线追完：`WifiRttManager.startRanging` → `RttServiceImpl`（校验 + 权限 + linkToDeath）→ `RttServiceSynchronized`（单线程队列：分配 cmdId + 限流 + 节流 + 超时）→ `WifiRttController`（HAL 门面）→ AIDL vendor HAL → `WifiLegacyHal` → 厂商函数表 → QCOM LOWI / MTK rtt.c 薄层 → **固件 FTM + T1-T4**，结果再原路逆流，距离毫米数一路搬运回 App。

# 三个设计权衡

1. **Framework 是「治理型前台」，不是「测量仪器」**：上千行代码全在排队、限流、节流、超时、权限、对账上，唯独没有距离公式。距离在固件/LOWI 算好，Framework 只搬运 `distanceInMm`。
2. **单线程队列状态机**：测距是串行射频操作 + 敏感能力，用 `RttServiceSynchronized` 一条 Handler 线程 + 三道闸（`isRequestorSpamming` 每 UID 20 条封顶 / `preExecThrottleCheck` 后台节流 / `mRangingTimeoutMessage` 5s·10s 超时）防刷、防挂、防堆积。
3. **发起端绕过 supplicant 直通 vendor HAL**：测距要「不关联、跨信道、纳秒级」，supplicant 的 SME/nl80211 抽象是负担。supplicant 只剩 AP 侧 responder（`NL80211_ATTR_FTM_RESPONDER`）+ RRM + PASN 三个配角。

# 常量 / 超时 / 事件速查

| 常量                           | 值     | 定义位置                    | 说明                          |
| ------------------------------ | ------ | --------------------------- | ----------------------------- |
| `HAL_RANGING_TIMEOUT_MS`       | 5 000  | `RttServiceImpl.java:125`   | HAL 测距超时（默认）          |
| `HAL_AWARE_RANGING_TIMEOUT_MS` | 10 000 | `RttServiceImpl.java:127`   | Aware 测距超时                |
| `MAX_QUEUED_PER_UID`           | 20     | `RttServiceImpl.java:130`   | 每 UID 排队上限               |
| `mNextCommandId` 初值          | 1000   | `RttServiceImpl.java:705`   | cmdId 自增起点                |
| `FRAMEWORK_RTT_STATUS_SUCCESS` | 0      | `WifiRttController.java:47` | 成功状态码（共 16 个，到 15） |
| `RTT_REQUEST_DONE_TIMEOUT_SEC` | 4      | MTK `rtt.h:29`              | MTK 测距看门狗超时            |
| `CFG_RTT_MAX_CANDIDATES`       | 10     | MTK `config.h:2659`         | MTK 单次最大目标数            |
| `CONVERSION_US_TO_MS`          | 1 000  | `WifiRttController.java:40` | 微秒→毫秒                     |

# 跨层字段映射（同一份信息的四层登记）

| 概念     | Framework (Java)               | AIDL HAL                             | legacy C 结构                 | 驱动/固件                          |
| -------- | ------------------------------ | ------------------------------------ | ----------------------------- | ---------------------------------- |
| 距离     | `RangingResult.mDistanceMm`    | `RttResult.distanceInMm`             | `wifi_rtt_result.distance_mm` | MTK `RTT_RESULT.i4DistanceMM`      |
| 往返时间 | （框架不暴露）                 | `RttResult.rtt`（皮秒）              | `wifi_rtt_result.rtt`         | MTK `i8Rtt` / QCOM `tod/toa/t3/t4` |
| 状态     | `RangingResult.mStatus`        | `RttStatus`                          | `wifi_rtt_status`（0-22）     | MTK `eStatus`                      |
| 类型     | （`ResponderConfig` 决定）     | `RttType`（11MC/11AZ_NTB/ONE_SIDED） | `wifi_rtt_type`               | MTK `eType`                        |
| 带宽     | `ResponderConfig.channelWidth` | `RttBw`                              | `wifi_rtt_bw`                 | MTK `eBw`                          |
| 前导码   | `ResponderConfig.preamble`     | `RttPreamble`                        | `wifi_rtt_preamble`           | MTK `ePreamble`                    |

---

追完 RTT 这条「头重脚轻」的链，你可能已经注意到一个反常的现象：**Framework 越写越厚，但它离「真正的测量」却越来越远。** 测距的核心——纳秒级时间戳、RTT、距离——全被压进了固件这个黑盒，主机只剩下一台调度前台。
