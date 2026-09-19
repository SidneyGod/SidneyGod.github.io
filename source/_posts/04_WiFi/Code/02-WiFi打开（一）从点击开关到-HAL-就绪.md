---
title: WiFi打开（一）从点击开关到 HAL 就绪
top: 1
related_posts: true
abbrlink: 53218af3
date: 2026-09-19 19:23:00
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 你点了一下"WiFi"开关，屏幕上的图标转了两圈，WiFi 列表就出现了。这半秒钟里，Android 系统做了多少事？从 Java 框架的权限检查，到状态机的层层调度，到 HAL 进程的拉取、再到内核 netlink 通道的建立——本文从点击开关开始，一路追踪到 HAL 就绪那一刻，把整条链路的代码打开来看。

# 本章导读

**WiFi 打开的过程，就像给一栋大楼供电**。 你按下墙上的开关（`WifiManager`），电流不会直接到电器——它要先经过配电箱的断路器检查线路是否安全（`WifiServiceImpl` 权限校验），再由总调度室决定启用哪条供电线路（`ActiveModeWarden` + `WifiController` 状态机），然后逐级合上楼层配电柜的闸（`ConcreteClientModeManager` → `ClientModeImpl`），最后接通大楼与电网之间的变压器（HAL → nl80211 → kernel）。每一层都有自己的"保险丝"和"合闸顺序"，跳过一个环节整栋楼都不会有电。

<!--more-->

**你将学到**：

- Android WiFi 从 App 层到 HAL 就绪的完整调用链
- `WifiServiceImpl` 的 6 道权限/场景闸门
- `ActiveModeWarden` + `WifiController` 的状态机驱动机制
- `ConcreteClientModeManager` 与 `ClientModeImpl` 的初始化流程
- `HalDeviceManager` → AIDL/HIDL → 厂商 .so 的加载链路
- QCOM 与 MTK 厂商 HAL 的实现差异
- nl80211 netlink 通道的建立方式

**代码说明**：本文所有代码块均来自真实源码，有部分精简（去除 log 行、注释行），核心逻辑完整保留。文件路径标注在代码块首行注释。

---

# 1 点击 WiFi 开关后，第一行代码在哪里执行？

> App 层的 `WifiManager.setWifiEnabled()` 只是一个薄壳，真正的逻辑在系统进程 `system_server` 中的 `WifiServiceImpl`。

## 1.1 架构全景图

这张图覆盖了从 App 层到内核的完整调用链，建议先花 30 秒建立整体印象，再逐层深入。

![WiFi STA 打开调用链全景图](assets/02-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%B8%80%EF%BC%89%E4%BB%8E%E7%82%B9%E5%87%BB%E5%BC%80%E5%85%B3%E5%88%B0-HAL-%E5%B0%B1%E7%BB%AA/02-STA-Framework-HAL-architecture.svg)

图中最关键的几条线：

- **蓝色箭头** = 主调用流（跨层传递，跟随它就能走完整个链路）
- **灰色箭头** = 内部委托（同层组件间的方法调用）
- **绿色箭头** = Vendor HAL 到内核的 nl80211 通道

## 1.2 WifiManager.setWifiEnabled() — 它真的什么都没做

你在 Settings 里点击 WiFi 开关，最终会调用到 `WifiManager.setWifiEnabled()`：

```java
// packages_modules_Wifi/framework/java/android/net/wifi/WifiManager.java
@Deprecated
public boolean setWifiEnabled(boolean enabled) {
    try {
        return mService.setWifiEnabled(mContext.getOpPackageName(), enabled);
    } catch (RemoteException e) {
        throw e.rethrowFromSystemServer();
    }
}
```

主要功能：

- 方法体只有 5 行，全部逻辑就是委托给 `mService`（一个 `IWifiManager` 的 Binder 代理对象）
- `mContext.getOpPackageName()` 传出调用方的包名，这是为了后面权限检查时能区分"谁在请求"
- `RemoteException` 被 `rethrowFromSystemServer()` 包装成 RuntimeException 抛出，对 App 来说它是透明的
- **这不是一个异步方法**——调用方会阻塞等待 system_server 的 Binder 响应

那 `mService` 这个对象是怎么来的？`WifiManager` 的构造函数接收一个 `IWifiManager` 参数，它是由 `Context.getSystemService(WIFI_SERVICE)` 通过 `ServiceManager` 查找到的 Binder 代理。`IWifiManager` 是一个 AIDL 接口，定义如下：

```java
// packages_modules_Wifi/framework/java/android/net/wifi/IWifiManager.aidl
boolean setWifiEnabled(String packageName, boolean enable);
```

从 App 进程到 system_server 的 Binder 调用，走的是 Android 标准的跨进程通信机制。本文不展开 Binder，你只需要知道：**调用 `mService.setWifiEnabled()` 之后，执行权已经跳转到了 system_server 进程中的 `WifiServiceImpl`**。

---

# 2 WifiServiceImpl 拿到请求后，做了什么检查？

> `WifiServiceImpl.setWifiEnabled()` 的本质是配电箱里的断路器面板——它在启动 WiFi 之前逐项检查权限和场景约束，不满足条件的断路器会跳闸，直接切断后续供电链路。

把这套**大楼供电比喻**套回到当前这段调用链上——如果说 `WifiManager.setWifiEnabled()` 是墙上的开关，那么 `WifiServiceImpl.setWifiEnabled()` 就是配电箱里的断路器面板。只有所有断路器都处于"允许"状态，电流才能往下游走。

## 2.1 权限检查：谁有资格打开 WiFi？

```java
// service/java/com/android/server/wifi/WifiServiceImpl.java
@CheckResult
private int enforceChangePermission(String callingPackage) {
    mAppOps.checkPackage(Binder.getCallingUid(), callingPackage);
    if (checkNetworkSettingsPermission(Binder.getCallingPid(), Binder.getCallingUid())) {
        return MODE_ALLOWED;
    }
    mContext.enforceCallingOrSelfPermission(
        android.Manifest.permission.CHANGE_WIFI_STATE, "WifiService");
    return mAppOps.noteOp(
        AppOpsManager.OPSTR_CHANGE_WIFI_STATE,
        Binder.getCallingUid(), callingPackage);
}
```

主要功能：

- 先检查签名级权限 `NETWORK_SETTINGS`——持有此权限的系统 App（如 Settings）直接放行，无需后续检查
- 否则强制执行 `CHANGE_WIFI_STATE` 危险权限——没有的话直接抛 `SecurityException`
- 最后通过 `AppOpsManager.noteOp()` 记录本次权限使用，供审计追踪
- 注意这里的双路径设计：系统 App 走快捷通道（`NETWORK_SETTINGS`），普通 App 走完整通道（`CHANGE_WIFI_STATE` + AppOps）

`checkNetworkSettingsPermission()` 的实现也值得一看——它直接检查调用者的 PID/UID 是否持有 `NETWORK_SETTINGS`：

```java
// service/java/com/android/server/wifi/WifiServiceImpl.java
private boolean checkNetworkSettingsPermission(int pid, int uid) {
    return mContext.checkPermission(
        android.Manifest.permission.NETWORK_SETTINGS, pid, uid)
        == PERMISSION_GRANTED;
}
```

这是签名级（signature）权限，只有用平台签名签过的 App 才能持有——也就是说只有系统应用能拿到这个"绿色通道"。

## 2.2 场景闸门：什么情况下不能打开 WiFi？

权限过了之后，还有一连串场景检查。这就像断路器面板上不只有"权限"这一个开关，还有"飞行模式"、"卫星模式"、"热点正在用"等一系列互锁装置。看 `setWifiEnabled()` 的完整实现：

```java
// service/java/com/android/server/wifi/WifiServiceImpl.java
@Override
public synchronized boolean setWifiEnabled(String packageName, boolean enable) {
    if (enforceChangePermission(packageName) != MODE_ALLOWED) {
        return false;
    }
    enforceValidCallingUser();

    int callingUid = Binder.getCallingUid();
    int callingPid = Binder.getCallingPid();
    boolean isPrivileged = isPrivileged(callingPid, callingUid);
    boolean isThirdParty = !isPrivileged
            && !isDeviceOrProfileOwner(callingUid, packageName)
            && !mWifiPermissionsUtil.isSystem(packageName, callingUid);
    boolean isTargetSdkLessThanQ = mWifiPermissionsUtil.isTargetSdkLessThan(
            packageName, Build.VERSION_CODES.Q, callingUid) && !isGuestUser();

    mWifiPermissionsUtil.checkPackage(callingUid, packageName);

    // 闸门1：第三方App SDK版本检查
    if (isThirdParty && !isTargetSdkLessThanQ) {
        mLog.info("setWifiEnabled not allowed for uid=%").c(callingUid).flush();
        return false;
    }

    // 闸门2：卫星模式
    if (mSettingsStore.isSatelliteModeOn()) {
        mLog.info("setWifiEnabled not allowed as satellite mode is on.").flush();
        return false;
    }

    // 闸门3：飞行模式
    if (mSettingsStore.isAirplaneModeOn() && !isPrivileged) {
        mLog.err("setWifiEnabled in Airplane mode: only Settings can toggle wifi").flush();
        return false;
    }
    // ... 后续闸门见下段
```

前三个闸门关注的是"**调用者有没有资格、设备状态允不允许**"：

- **闸门 1** 是 Android Q 引入的安全边界——第三方 App 在 Q+ 设备上不允许直接开关 WiFi，必须走系统提供的 `Settings Panel API`。这个设计的原因是：Q 之前第三方 App 可以静默关闭 WiFi 来干扰用户的网络连接，所以 Q 开始收紧了这一权限
- **闸门 2** 是硬件资源共享冲突——卫星通信和 WiFi 共用射频前端，两者不能同时使用。这不是"不让你用"，而是物理上只能二选一
- **闸门 3** 是系统级快捷开关的保护——飞行模式下只有 Settings 能打开 WiFi（比如用户手动在飞行模式里单独打开 WiFi），第三方 App 不能绕过飞行模式的意图

> **（接上文 `setWifiEnabled()` 后半段——同一个方法，处理闸门 4-6）**

```java
    // ... 接上文 setWifiEnabled() 后半段

    // 闸门4：热点运行中（pre-S 设备）
    if (!SdkLevel.isAtLeastS() && !isPrivileged
            && mTetheredSoftApTracker.getState().getState() == WIFI_AP_STATE_ENABLED) {
        mLog.err("setWifiEnabled with SoftAp enabled: only Settings can toggle wifi").flush();
        return false;
    }

    // 闸门5：用户限制（T+ 设备）
    long ident = Binder.clearCallingIdentity();
    try {
        if (SdkLevel.isAtLeastT() && mUserManager.hasUserRestrictionForUser(
                UserManager.DISALLOW_CHANGE_WIFI_STATE,
                UserHandle.getUserHandleForUid(callingUid))
                && !isDeviceOrProfileOwner(callingUid, packageName)) {
            mLog.err("setWifiEnabled with user restriction: only DO/PO can toggle wifi").flush();
            return false;
        }
    } finally {
        Binder.restoreCallingIdentity(ident);
    }

    // 闸门6：旧版App确认对话框
    if (enable && isTargetSdkLessThanQ && isThirdParty
            && showDialogWhenThirdPartyAppsEnableWifi()) {
        mLog.info("setWifiEnabled must show user confirmation dialog for uid=%")
                .c(callingUid).flush();
        mWifiThreadRunner.post(() -> {
            // 异步投递到 WiFi 线程——投递与执行之间可能有时差
            if (mActiveModeWarden.getWifiState() == WIFI_STATE_ENABLED) {
                return;  // WiFi 已被其他方式启用，跳过弹框
            }
            showWifiEnableRequestDialog(callingUid, callingPid, packageName);
        }, TAG + "#setWifiEnabled");
        return true;
    }

    setWifiEnabledInternal(packageName, enable, callingUid, callingPid, isPrivileged);
    return true;
}
```

后三个闸门关注的是"**当前系统场景下开 WiFi 会不会引起冲突**"：

- **闸门 4** 阻止了 Pre-S 设备上热点和 STA 同时存在的冲突——大部分旧芯片不支持 STA+AP 并发，如果热点开着，打开 STA 会导致其中一个接口被迫关闭。Android S+ 的设备通常支持并发，所以这个限制被移除了
- **闸门 5** 是 Android T 引入的企业设备策略（Device Policy）支持——IT 管理员可以通过 `DISALLOW_CHANGE_WIFI_STATE` 限制工作设备上的 WiFi 操作。注意这里调用了 `Binder.clearCallingIdentity()`：用户限制检查需要以 system 身份读取 `UserManager` 数据，不是所有调用者都有这个权限
- **闸门 6** 是一个特殊的兼容路径——targetSdk < Q 的旧版 App 仍然可以请求打开 WiFi，但必须先弹出确认对话框让用户知情。注意它返回的是 `true` 而非 `false`：这里**不是直接调用** `showWifiEnableRequestDialog()`，而是通过 `mWifiThreadRunner.post()` 将弹框逻辑异步投递到 WiFi 线程——投递与执行之间可能有时差，lambda 内会先检查 `getWifiState() == WIFI_STATE_ENABLED`，如果 WiFi 已被其他方式启用则跳过弹框。用户点击"允许"后，对话框回调会再次调用 `setWifiEnabled()`，此时 `showDialogWhenThirdPartyAppsEnableWifi()` 返回 `false`（不再弹框），流程才会到达 `setWifiEnabledInternal()`

前三个闸门把的是"谁有资格开"，后三个闸门把的是"开了会不会冲突"——确认对话框看似温和，本质上也是在替用户拦住一次未经许可的网络状态变更。

这 6 道闸门对应的调用者身份组合，用一张表总结会更清晰：

| 调用者类型                     | 普通状态 | 飞行模式 | 热点运行中(pre-S) | 用户限制(T+) |
| ------------------------------ | -------- | -------- | ----------------- | ------------ |
| Settings（`NETWORK_SETTINGS`） | ✅        | ✅        | ✅                 | ❌            |
| Device Owner / Profile Owner   | ✅        | ❌        | ❌                 | ✅            |
| 系统 App（`isSystem`）         | ✅        | ❌        | ❌                 | ❌            |
| 第三方 App（targetSdk < Q）    | 弹对话框 | ❌        | ❌                 | ❌            |
| 第三方 App（targetSdk >= Q）   | ❌        | ❌        | ❌                 | ❌            |

> **异常路径提示**：以上任何一道闸门不通过，`setWifiEnabled()` 都直接返回 `false`，App 端只能拿到一个布尔返回值，**看不到具体的拒绝原因**。这正是 Android 权限模型的设计意图——不向第三方 App 泄露系统状态（如是否处于飞行模式）。系统 App（Settings）可以通过 `NETWORK_SETTINGS` 权限绕过大部分闸门，唯独受限于 `UserManager` 的用户限制（如企业设备策略），此时 WifiService 也不会抛出异常，而是静默返回 false。
>
> 下面逐闸门列出不通过时的返回值和日志——如果你在调试 WiFi 打不开的问题，这些日志关键字可以直接用于 logcat 过滤：

| 闸门                | 条件                                                    | 不通过时的日志                                               | 返回                           |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| ① 第三方 SDK 等级   | `isThirdParty && !isTargetSdkLessThanQ`                 | `"setWifiEnabled not allowed for uid=%"` (info)              | `false`                        |
| ② 卫星模式          | `mSettingsStore.isSatelliteModeOn()`                    | `"setWifiEnabled not allowed as satellite mode is on."` (info) | `false`                        |
| ③ 飞行模式          | `isAirplaneModeOn && !isPrivileged`                     | `"setWifiEnabled in Airplane mode: only Settings can toggle wifi"` (err) | `false`                        |
| ④ 热点运行中(pre-S) | `!SdkLevel.isAtLeastS() && !isPrivileged && AP enabled` | `"setWifiEnabled with SoftAp enabled: only Settings can toggle wifi"` (err) | `false`                        |
| ⑤ 用户限制(T+)      | `DISALLOW_CHANGE_WIFI_STATE && !isDeviceOrProfileOwner` | `"setWifiEnabled with user restriction: only DO/PO can toggle wifi"` (err) | `false`                        |
| ⑥ 旧版App确认框     | `enable && isTargetSdkLessThanQ && isThirdParty`        | `"setWifiEnabled must show user confirmation dialog for uid=%"` (info) | `true`（异步弹框而非直接拒绝） |

## 2.3 setWifiEnabledInternal() — 通过检查后的真正入口

所有闸门都通过后，调用进入 `setWifiEnabledInternal()`：

```java
// service/java/com/android/server/wifi/WifiServiceImpl.java
private void setWifiEnabledInternal(String packageName, boolean enable,
        int callingUid, int callingPid, boolean isPrivileged) {
    long ident = Binder.clearCallingIdentity();
    try {
        if (!mSettingsStore.handleWifiToggled(enable)) {
            return;  // 无法切换状态，直接返回
        }
    } finally {
        Binder.restoreCallingIdentity(ident);
    }
    // ... 省略：清理旧对话框（mWifiEnableRequestDialogHandles）、权限分级指标
    //       （autoJoin 重启用/关闭日志）、InterfaceConflictManager 重置、
    //       toggle 计数器递增、WiFi 状态变更广播 ...
    mActiveModeWarden.wifiToggled(new WorkSource(callingUid, packageName));
    mLastCallerInfoManager.put(WifiManager.API_WIFI_ENABLED, Process.myTid(),
            callingUid, callingPid, packageName, enable);
}
```

主要功能：

- `mSettingsStore.handleWifiToggled(enable)` 将用户的开关状态持久化到 Settings 数据库——如果当前状态已经等于目标状态（如 WiFi 已经开着又点了"开"），方法返回 `false`，后续流程全部跳过，这是一个幂等优化
- 核心动作只有一行：`mActiveModeWarden.wifiToggled(...)`——把控制权交给 WiFi 子系统的"总调度员"
- `WorkSource` 对象携带了本次操作的调用者信息（UID + 包名），用于后续的 blame 链追踪
- `Binder.clearCallingIdentity()` 再次出现——持久化设置需要以 system 身份写 Settings，不能以 App 身份

到这里，权限检查和场景约束都完成了。"电流"已经通过了配电箱的断路器面板，接下来该**总调度室**决定启用哪条供电线路。

---

# 3 ActiveModeWarden 是怎么调度 WiFi 子系统的？

> `ActiveModeWarden` 是 WiFi 子系统的"总调度员"，它不亲自执行 WiFi 的开关逻辑，而是通过内部的 `WifiController` 状态机来管理 STA / SoftAp / ScanOnly 三种模式之间的切换。

## 3.1 为什么需要一个"总调度员"？

WiFi 子系统不是只有 STA（连 AP）这一种模式。同一个物理芯片上，可能同时需要支持：

- **STA 模式**（连接 AP，就是本文讲的场景）
- **SoftAp 模式**（开启热点，让别人连你）
- **ScanOnly 模式**（只扫描、不连接，Android 的位置服务需要这个）
- **STA+STA 双连接**（同时连两个 AP，Android 12+ 支持）
- **STA+AP 并发**（自己连着 WiFi 的同时开热点，部分芯片支持）

这些模式之间有冲突——比如你不能在同一个接口上既做 STA 又做 SoftAp。谁来仲裁这些冲突？谁来保证模式切换时不会留下"半死不活"的中间状态？

这就是 `ActiveModeWarden` 存在的意义。放进**大楼供电比喻**里看，它就像大楼的配电总控室，看着整栋楼的用电需求（"3 楼要开灯"、"5 楼要用空调"、"地下室要充电"），然后决定启用哪几条供电干线，同时确保不会因为同时开太多线路而导致跳闸。

## 3.2 wifiToggled() — 一句话，把活交给状态机

从 `WifiServiceImpl` 过来的请求，在 `ActiveModeWarden` 里只做了一件事：

```java
// service/java/com/android/server/wifi/ActiveModeWarden.java
public void wifiToggled(WorkSource requestorWs) {
    mWifiController.sendMessage(WifiController.CMD_WIFI_TOGGLED, requestorWs);
}
```

主要功能：

- 函数体只有一行——发送 `CMD_WIFI_TOGGLED` 消息给内部状态机
- `WifiController` 是 `ActiveModeWarden` 的内部类，不是独立文件（两者定义在同一个 `.java` 文件中）
- 这是典型的 StateMachine 消息驱动模式——外部只发送"发生了什么"（Event），内部状态机根据当前状态决定"该做什么"（Action）

但 `ActiveModeWarden` 不只是个消息转发器。它还持有 WiFi 子系统的核心资源引用：

```java
// service/java/com/android/server/wifi/ActiveModeWarden.java
public class ActiveModeWarden {
    // Holder for active mode managers
    private final Set<ConcreteClientModeManager> mClientModeManagers = new ArraySet<>();
    private final Set<SoftApManager> mSoftApManagers = new ArraySet<>();
    private final DefaultClientModeManager mDefaultClientModeManager;
    private final WifiInjector mWifiInjector;
    private final WifiNative mWifiNative;
    private final WifiController mWifiController;  // 内部类状态机
    private final AtomicInteger mWifiState = new AtomicInteger(WIFI_STATE_DISABLED);
    // ...其他字段省略（mWifiMetrics、mSettingsStore、mScanRequestProxy 等约 30 个字段）...
}
```

主要功能：

- 两组 `Set` 分别管理 STA 模式管理器（`ConcreteClientModeManager`）和 AP 模式管理器（`SoftApManager`）
- `mWifiState` 是一个 `AtomicInteger`，对外暴露 WiFi 开关状态（DISABLED / DISABLING / ENABLED / ENABLING / UNKNOWN）
- `mWifiNative` 直接持有原生层的引用——它在 `ActiveModeWarden` 构造函数里注册了一个 daemon 崩溃监听，一旦 `wpa_supplicant` 挂了，自动触发 `SelfRecovery`

`ActiveModeWarden` 的构造函数（约 60 行）只做两件事：存储依赖注入（接收 14 个外部依赖参数）+ 创建内部的 `WifiController` 状态机。没有任何实际的 WiFi 操作——**一切工作都推迟到状态机启动后才发生**。

---

# 4 WifiController 状态机是怎么工作的？

> `WifiController` 是一个只有两个子状态的状态机——`DisabledState` 和 `EnabledState`。它不关心 WiFi 连接的具体细节，只决定"WiFi 该不该开"这个最高层级的决策。

## 4.1 为什么需要状态机？

如果 WiFi 的开启/关闭只是简单的 `if (on) { startWifi() } else { stopWifi() }`，那确实不需要状态机。但现实场景比这复杂得多：

- WiFi 正在关闭时，用户又点了开启——怎么办？
- 紧急呼叫模式下，运营商要求 WiFi 关闭——怎么覆盖用户的设置？
- 飞行模式切换时，WiFi 的状态要不要恢复？
- SelfRecovery 触发重启时，WiFi 应该回到什么状态？

搞状态机的本质是：**把"在什么状态下收到什么消息该做什么"这个决策逻辑显式化**，而不是散落在几十个 if-else 里。Android 框架提供了一个基础的 `StateMachine` 类，`WifiController` 就是基于它构建的。

用**供电比喻**来讲，`WifiController` 就像一个带有互锁装置的变压器总开关。它只有两个位置："合闸"和"分闸"，但它能保证无论什么时候有人去扳它（哪怕你刚把它拉到一半又推回去），结果都是确定的。

## 4.2 三层状态层级

`WifiController` 的状态层次很简洁：

```text
StateMachine
  └── WifiController
        ├── DefaultState (顶层——处理所有子状态未覆盖的消息)
        │     ├── DisabledState (WiFi 关闭)
        │     └── EnabledState  (WiFi 打开)
```

状态转移全景（`→` 标注触发消息）：

![WifiController 状态机](assets/02-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%B8%80%EF%BC%89%E4%BB%8E%E7%82%B9%E5%87%BB%E5%BC%80%E5%85%B3%E5%88%B0-HAL-%E5%B0%B1%E7%BB%AA/02-WifiController%E7%8A%B6%E6%80%81%E6%9C%BA.svg)

构造代码：

```java
// service/java/com/android/server/wifi/ActiveModeWarden.java
// WifiController 内部类（约 L1930）
WifiController() {
    super(TAG, mLooper);
    final int threshold = mResourceCache.getInteger(
            R.integer.config_wifiConfigurationWifiRunnerThresholdInMs);
    DefaultState defaultState = new DefaultState(threshold);
    mEnabledState = new EnabledState(threshold);
    mDisabledState = new DisabledState(threshold);
    addState(defaultState); {
        addState(mDisabledState, defaultState);
        addState(mEnabledState, defaultState);
    }
}
```

主要功能：

- `DefaultState` 是父状态——`DisabledState` 和 `EnabledState` 都是它的子状态
- 子状态中未处理的消息会自动"冒泡"到父状态——这就是为什么 `DefaultState` 里集中处理了飞行模式、卫星模式等跨状态通用消息
- 只有两个子状态，因为 WiFi 的顶层决策确实只有两个答案："开"或"关"

`DefaultState` 作为顶层，处理的消息包括：

- **`CMD_AIRPLANE_TOGGLED`**：飞行模式开 → 关掉一切（STA + AP）；飞行模式关 → 根据 toggle 状态决定是否开 STA
- **`CMD_SATELLITE_MODE_CHANGED`**：卫星模式开 → 关掉一切（卫星通信与 WiFi 共享天线资源，不能同时用）
- **`CMD_RECOVERY_DISABLE_WIFI`**：SelfRecovery 限流后，放弃重启，直接关闭 WiFi

## 4.3 DisabledState → EnabledState：一次完整的转移

WiFi 从关闭到打开的核心状态转移发生在 `DisabledState` 中。当 `CMD_WIFI_TOGGLED` 消息到达时：

```java
// ActiveModeWarden.java (WifiController 内部类, DisabledState)
case CMD_WIFI_TOGGLED:
case CMD_SCAN_ALWAYS_MODE_CHANGED:
    handleStaToggleChangeInDisabledState((WorkSource) msg.obj);
    break;
```

`handleStaToggleChangeInDisabledState()` 的判断逻辑：

```java
// ActiveModeWarden.java
private void handleStaToggleChangeInDisabledState(WorkSource requestorWs) {
    if (shouldEnableSta()) {
        startPrimaryOrScanOnlyClientModeManager(requestorWs);
        transitionTo(mEnabledState);
    }
}
```

主要功能：

- 先调用 `shouldEnableSta()` 判断是否可以开 STA——检查 toggle 开关 AND 卫星模式
- 如果可以，调用 `startPrimaryOrScanOnlyClientModeManager()` 创建一个 `ConcreteClientModeManager`
- 然后 `transitionTo(mEnabledState)` 完成状态转移
- **注意顺序**：先创建 Manager，再转移到 EnabledState——这是因为 EnabledState 的 `enterImpl()` 会断言至少有一个 Manager 存在

`shouldEnableSta()` 的实现：

```java
// ActiveModeWarden.java
private boolean shouldEnableSta() {
    return (mSettingsStore.isWifiToggleEnabled() || shouldEnableScanOnlyMode())
            && !mSettingsStore.isSatelliteModeOn();
}
```

如果只是普通的"WiFi 开关打开"场景（不是 ScanOnly），`startPrimaryOrScanOnlyClientModeManager()` 会调用到 `startPrimaryClientModeManager()`：

```java
// ActiveModeWarden.java
private boolean startPrimaryClientModeManager(WorkSource requestorWs) {
    if (hasPrimaryOrScanOnlyModeManager()) {
        Log.e(TAG, "Unexpected state - primary CMM should not be started when a primary "
                + "or scan only CMM is already present.");
        if (!mIsMultiplePrimaryBugreportTaken) {
            mIsMultiplePrimaryBugreportTaken = true;
            mWifiDiagnostics.takeBugReport("Wi-Fi ActiveModeWarden bugreport",
                    "Trying to start primary mode manager when one already exists.");
        }
        return false;
    }
    Log.d(TAG, "Starting primary ClientModeManager in connect mode");
    ConcreteClientModeManager manager = mWifiInjector.makeClientModeManager(
            new ClientListener(), requestorWs, ROLE_CLIENT_PRIMARY, mVerboseLoggingEnabled);
    mClientModeManagers.add(manager);
    mLastPrimaryClientModeManagerRequestorWs = requestorWs;
    return true;
}
```

主要功能：

- 防重复：如果已经有一个 primary/scanOnly Manager 存在，直接返回 false
- 通过 `mWifiInjector.makeClientModeManager()` 工厂方法创建 `ConcreteClientModeManager`——这是依赖注入的标准模式，便于测试时 mock
- `ClientListener` 是一个回调对象，它会在 Manager 启动成功（`onStarted()`）、失败（`onStartFailure()`）、停止（`onStopped()`）时被通知
- Manager 加入 `mClientModeManagers` 集合后，其自身的 StateMachine 就会开始运转

`WifiController` 在启动时还有一个特殊路径——如果设备在上次关机时 WiFi 是开着的，`start()` 方法会直接初始化在 `EnabledState`：

```java
// ActiveModeWarden.java:1975 (WifiController.start())
public void start() {
    boolean isAirplaneModeOn = mSettingsStore.isAirplaneModeOn();
    boolean isWifiEnabled = mSettingsStore.isWifiToggleEnabled();
    boolean isScanningAlwaysAvailable = mSettingsStore.isScanAlwaysAvailable();
    boolean isLocationModeActive = mWifiPermissionsUtil.isLocationModeEnabled();
    boolean isSatelliteModeOn = mSettingsStore.isSatelliteModeOn();

    // 用 Settings 的初始值填充 Requestor 来源
    mLastPrimaryClientModeManagerRequestorWs = mFacade.getSettingsWorkSource(mContext);
    mLastScanOnlyClientModeManagerRequestorWs = INTERNAL_REQUESTOR_WS;
    ActiveModeManager.ClientRole role = getRoleForPrimaryOrScanOnlyClientModeManager();
    if (role == ROLE_CLIENT_PRIMARY) {
        startPrimaryClientModeManager(mLastPrimaryClientModeManagerRequestorWs);
        setInitialState(mEnabledState);
    } else if (role == ROLE_CLIENT_SCAN_ONLY) {
        startScanOnlyClientModeManager(mLastScanOnlyClientModeManagerRequestorWs);
        setInitialState(mEnabledState);
    } else {
        setInitialState(mDisabledState);
    }
    mWifiNative.initialize();   // 注册 Vendor HAL/wificond 死亡通知框架
    super.start();              // 启动 StateMachine 消息循环
}
```

主要功能：

- 从 5 个 Settings 开关读取初始状态（飞行模式、WiFi toggle、ScanAlways、位置模式、卫星模式）
- `getRoleForPrimaryOrScanOnlyClientModeManager()` 综合这些开关决定初始角色——是 PRIMARY（可连接）还是 SCAN_ONLY（只扫描）还是都不启动
- `mWifiNative.initialize()` 在状态机启动前注册底层基础设施（Vendor HAL 和 wificond 的死亡通知框架）——注意这个调用在条件分支之外，无论 WiFi 初始状态是开还是关都会执行。wpa_supplicant 不在此处启动（见第 9.2 节的 lazy HAL 机制）
- `super.start()` 启动 Android StateMachine 的消息泵——之后所有 `sendMessage()` 才会被处理

**WifiNative.initialize() 的职责**：这个方法和第六章的 `startHal()` 是不同的入口，它们有明确的职责边界：

```java
// service/java/com/android/server/wifi/WifiNative.java:1451
public boolean initialize() {
    synchronized (mLock) {
        if (!mWifiVendorHal.initialize(new VendorHalDeathHandlerInternal())) {
            Log.e(TAG, "Failed to initialize vendor HAL");
            return false;
        }
        mWifiCondManager.setOnServiceDeadCallback(new WificondDeathHandlerInternal());
        mWifiCondManager.tearDownInterfaces();
        mWifiVendorHal.registerRadioModeChangeHandler(
                new VendorHalRadioModeChangeHandlerInternal());
        mNetdWrapper = mWifiInjector.makeNetdWrapper();
        return true;
    }
}
```

主要功能：

- **注册死亡通知**：为 Vendor HAL 和 wificond 分别注册死亡回调（`DeathHandlerInternal`），一旦底层进程崩溃，Framework 能立即感知并触发 SelfRecovery。wpa_supplicant 的死亡回调在 `SupplicantStaIfaceHal.initialize()` 中单独注册
- **清理残留接口**：`tearDownInterfaces()` 清除上次运行可能遗留的 wificond 接口，确保干净的初始状态
- **注册 Radio Mode 变更回调**：监听底层芯片的模式切换（如 WiFi 和蓝牙共享天线时的模式变更）

`initialize()` vs `startHal()` 的职责边界：

- `initialize()`：**一次性准备工作**——注册死亡通知、清理残留、建立回调框架。只在系统启动时执行一次
- `startHal()`：**按需拉活**——当有接口请求时才真正启动 HAL 进程。每次 WiFi 从关闭到打开都可能执行

## 4.4 EnabledState：WiFi 开着时，状态机在做什么？

上一节展示了如何『进入』`EnabledState`，但进入之后呢？`EnabledState` 不是空的——它在等待两类消息：

**消息一：用户再次点击开关（CMD_WIFI_TOGGLED）**

```java
// ActiveModeWarden.java (WifiController 内部类, EnabledState)
case CMD_WIFI_TOGGLED:
    // 用户点了"关闭 WiFi"
    transitionTo(mDisabledState);
    break;
```

WiFi 打开后，用户再次点击开关，`EnabledState` 直接转移到 `DisabledState`——这会触发 `DisabledState.enterImpl()` 中调用 `stopPrimaryClientModeManager()`，进而停止 `ConcreteClientModeManager`、关闭 HAL、卸载驱动。

**消息二：飞行模式/卫星模式/Recovery 等全局事件**

这些消息在 `DefaultState` 中处理（第 4.2 节已列出），无论当前是 `DisabledState` 还是 `EnabledState`，都会触发。飞行模式开启时，`DefaultState` 处理 `CMD_AIRPLANE_TOGGLED`——关掉 STA 和 AP，并从 `EnabledState` 转移到 `DisabledState`。

**消息三：STA 接口就绪后的模式切换**

当 `ConcreteClientModeManager` 成功初始化 STA 接口后，`ActiveModeWarden` 中的 `ClientListener.onStarted()` 被回调，它将 `mWifiState` 更新为 `ENABLED`，Framework 上层通过 `WifiManager.getWifiState()` 就能看到 WiFi 已完全就绪。如果 CMM 启动失败，`ClientListener.onStartFailure()` 被回调，`WifiController` 收到 `CMD_STA_START_FAILURE` 消息并转移到 `DisabledState`。

**状态转移一图总结**：

```text
                    CMD_WIFI_TOGGLED
DisabledState ──────────────────────────→ EnabledState
       ↑                                        │
       │          CMD_WIFI_TOGGLED               │
       └────────────────────────────────────────┘
       
       ↑                                        │
       │   CMD_AIRPLANE_TOGGLED / SATELLITE     │
       └────────────────────────────────────────┘
              (DefaultState 统一处理)

```

> **为什么 EnabledState 这么简单？** 因为 `WifiController` 只管"WiFi 该不该开"这个最高决策。一旦决定"该开"，具体的执行（创建设备接口、启动 HAL、初始化 Supplicant）全部委托给 `ConcreteClientModeManager`。`EnabledState` 的核心工作是两件事：① 监听关闭指令（用户关开关、飞行模式），② 监听子 Manager 的状态报告（用于更新 WiFi 状态指示）。

至此，WiFi 的顶层决策已经完成。`WifiController` 由 `DisabledState` 转移到了 `EnabledState`，`ConcreteClientModeManager` 也已经创建。接下来该看这个"楼层配电柜"是怎么启动的了。

---

# 5 ConcreteClientModeManager 和 ClientModeImpl 是怎么初始化的？

> `ConcreteClientModeManager` 是 STA 模式的"大管家"，它内部自带一个 `ClientModeStateMachine` 子状态机来管理接口生命周期，在 `ConnectModeState` 下会创建更底层的 `ClientModeImpl`（一个拥有 9 个状态的连接管理状态机）。

顺着**大楼供电**这条线索往下——前面几章已经把变压器总闸合上了（`WifiController` 转移到 `EnabledState`），现在该逐层合上楼层配电柜的闸。`ConcreteClientModeManager` 就是 3 楼的配电柜：它的工作是把总闸送来的电（"已启用"状态）分配到具体的电器线路（接口模式：是连接还是只扫描），并且安装一个"漏电保护器"（`ClientModeImpl` 的 9 状态 FSM 负责监控连接全生命周期的异常）。

## 5.1 ConcreteClientModeManager 的创建与启动

`ConcreteClientModeManager` 有三个角色（对应 `ClientRole` 枚举）：

| 角色                               | 说明                  | 场景               |
| ---------------------------------- | --------------------- | ------------------ |
| `ROLE_CLIENT_PRIMARY`              | 主 STA 连接模式       | 用户打开 WiFi 开关 |
| `ROLE_CLIENT_SECONDARY_LONG_LIVED` | 第二路 STA（STA+STA） | 双 WiFi 加速       |
| `ROLE_CLIENT_SCAN_ONLY`            | 仅扫描、不连接        | 位置服务           |

本文关注的是 `ROLE_CLIENT_PRIMARY`（普通 WiFi 连接）的初始化路径。

`ConcreteClientModeManager` 的构造函数：

```java
// service/java/com/android/server/wifi/ConcreteClientModeManager.java
ConcreteClientModeManager(WifiContext context, ..., ClientRole role,
        WifiNative wifiNative, ...) {
    // 存储依赖注入的各种对象
    mStateMachine = new ClientModeStateMachine(looper);
    // ... 发送 CMD_START 给内部状态机
    sendMessage(CMD_START, new RoleChangeInfo(role, requestorWs, listener));
}
```

构造完成后，内部的 `ClientModeStateMachine` 开始运转。它有自己的 4 个状态：

```text
IdleState (初始状态)
  └── StartedState (接口已就绪)
        ├── ScanOnlyModeState (仅扫描，不创建 ClientModeImpl)
        └── ConnectModeState (连接模式，创建 ClientModeImpl)
```

状态转移：

![ClientModeManager 状态机](assets/02-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%B8%80%EF%BC%89%E4%BB%8E%E7%82%B9%E5%87%BB%E5%BC%80%E5%85%B3%E5%88%B0-HAL-%E5%B0%B1%E7%BB%AA/02-ClientModeManager%E7%8A%B6%E6%80%81%E6%9C%BA.svg)

对于 `ROLE_CLIENT_PRIMARY`，`CMD_START` 处理后进入 `IdleState`，然后立即切换到 `StartedState`，再根据角色切换到 `ConnectModeState`。

## 5.2 ClientModeImpl 的创建——ConnectModeState 的 enterImpl

当 `ConnectModeState` 被进入时，关键的初始化发生：

```java
// service/java/com/android/server/wifi/ConcreteClientModeManager.java:1231
// ConnectModeState.enterImpl()
mClientModeImpl = mWifiInjector.makeClientModeImpl(
    mClientInterfaceName, ConcreteClientModeManager.this, mVerboseLoggingEnabled);
```

这一行触发了 `WifiInjector.makeClientModeImpl()`，它内部创建了一个 `new ClientModeImpl(...)`，传入约 58 个依赖参数（Context、WifiMetrics、Clock、WifiNative、WifiConfigManager、PasspointManager、WifiMonitor 等等）。`ClientModeImpl` 构造完成后，会立即构建自己的 9 状态层级并调用 `start()` 开始运转。

## 5.3 ClientModeImpl 的 9 个状态（速览）

`ClientModeImpl` 是 WiFi 连接的"心脏"，它管理从断开到完全连接的全生命周期。本文只做速览，详细的状态转移留给连接章节。

```text
ConnectableState（根状态）—— 过滤无效连接请求，分发到子状态
│
├── DisconnectedState —— 空闲，无连接
│     (父: ConnectableState，与 ConnectingOrConnectedState 平级)
│
└── ConnectingOrConnectedState —— 所有"非空闲"状态的父容器
      (父: ConnectableState，与 DisconnectedState 平级)
      │
      ├── L2ConnectingState —— 802.11 关联/认证进行中
      │     (父: ConnectingOrConnectedState，与 L2ConnectedState 平级)
      │
      └── L2ConnectedState —— L2 链路已建立，承载 L3 子状态
            (父: ConnectingOrConnectedState，与 L2ConnectingState 平级)
            │
            ├── WaitBeforeL3ProvisioningState —— 等待 DHCP 前操作
            │     (父: L2ConnectedState，四个子状态互斥)
            ├── L3ProvisioningState —— 获取 IP 地址
            │     (父: L2ConnectedState)
            ├── L3ConnectedState —— 完全连接，IP 就绪
            │     (父: L2ConnectedState)
            └── RoamingState —— 正在漫游到另一个 AP
                  (父: L2ConnectedState)
```

9 个状态的职责简述：

| #    | 状态                            | 父状态                       | 职责                                                       |
| ---- | ------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| 1    | `ConnectableState`              | (根)                         | 过滤无效连接请求，分发到子状态                             |
| 2    | `DisconnectedState`             | `ConnectableState`           | 空闲状态，等待 `CMD_START_CONNECT`                         |
| 3    | `ConnectingOrConnectedState`    | `ConnectableState`           | 连接中/已连接阶段共同的逻辑（屏幕状态、省电优化）          |
| 4    | `L2ConnectingState`             | `ConnectingOrConnectedState` | 处理 wpa_supplicant 状态变更事件，关联超时看门狗           |
| 5    | `L2ConnectedState`              | `ConnectingOrConnectedState` | L2 链路建立，启动 DHCP 客户端                              |
| 6    | `WaitBeforeL3ProvisioningState` | `L2ConnectedState`           | 等待网络验证（如 Portal 检测）完成                         |
| 7    | `L3ProvisioningState`           | `L2ConnectedState`           | DHCP/IPv6 地址获取，处理成功/失败                          |
| 8    | `L3ConnectedState`              | `L2ConnectedState`           | 完全连接，注册 NetworkAgent，发送 CONNECTIVITY_ACTION 广播 |
| 9    | `RoamingState`                  | `L2ConnectedState`           | 同 SSID 下漫游到另一个 AP，漫游看门狗                      |

这些状态我们会在后续的连接章节中展开分析。本文到达 HAL 就绪即止——此时 `ClientModeImpl` 还停留在 `DisconnectedState`，等待后续的连接指令。

---

# 6 HalDeviceManager 是怎么启动 HAL 进程的？

> `HalDeviceManager` 是 Java 框架与 Native HAL 之间的"门卫"——它通过 AIDL/HIDL Binder 调用拉起 `vendor.wifi_hal` 服务进程，并管理重试逻辑。

**供电比喻**走到这一步——前面几章已经把楼层配电柜的闸逐一合上（`ConcreteClientModeManager` → `ClientModeImpl`），现在要接通大楼与电网之间的变压器（HAL 层）。变压器的"合闸"不是打开开关就完事——需要先确认型号（HIDL vs AIDL）、等待预热（retry 逻辑）、然后才能送出电流。

## 6.1 先澄清一个易混淆点：HAL 何时被启动？

在深入源码之前，必须回答一个关键问题：**HAL 是系统启动时就启动的，还是用户点击开关时才启动的？**

- **系统启动时**：`WifiController.start()` 调用 `mWifiNative.initialize()`，注册 Vendor HAL 和 wificond 的死亡通知框架、清理残留接口。此时 HAL 进程本身**尚未启动**——它只搭建了"当 HAL 崩溃时通知我"的回调基础设施（详见第四章 4.3 节末尾的 `initialize()` vs `startHal()` 职责边界）。
- **用户点击开关时**：走到本章的路径——`ConnectModeState.enterImpl()` → `WifiNative.startHal()` → `HalDeviceManager.startWifi()`，**显式拉起** `vendor.wifi_hal` 进程。

本章聚焦第二种场景。下面的调用链展示了从 Framework 到 HAL 进程拉起的完整路径：

```text
ConnectModeState.enterImpl()
  → WifiNative.setupInterfaceForClientInScanMode()
    → WifiNative.startHal()                    ← HAL 在这里显式启动
      → WifiVendorHal.startVendorHal()
        → HalDeviceManager.start()
          → HalDeviceManager.startWifi()
    → createStaIface()
    → mWifiCondManager.setupInterfaceForClientMode()
      → mWificond.createClientInterface()      ← wificond 接口在这里创建
```


## 6.2 Framework 到 HAL 的真正桥接点：setupInterfaceForClientMode()

在 `ConnectModeState.enterImpl()` 创建了 `ClientModeImpl` 之后，Framework 需要向 wificond 守护进程注册一个 STA 接口。这个桥接点就是 `WifiNl80211Manager.setupInterfaceForClientMode()`——它通过 Binder 调用 wificond，创建 `IClientInterface` 并注册扫描回调：

```java
// base/wifi/java/src/android/net/wifi/nl80211/WifiNl80211Manager.java
public boolean setupInterfaceForClientMode(@NonNull String ifaceName,
        @NonNull @CallbackExecutor Executor executor,
        @NonNull ScanEventCallback scanCallback,
        @NonNull ScanEventCallback pnoScanCallback) {
    Log.d(TAG, "Setting up interface for client mode: " + ifaceName);
    if (!retrieveWificondAndRegisterForDeath()) {
        return false;  // wificond 服务未就绪
    }

    if (scanCallback == null || pnoScanCallback == null || executor == null) {
        Log.e(TAG, "setupInterfaceForClientMode invoked with null callbacks");
        return false;
    }

    IClientInterface clientInterface = null;
    try {
        clientInterface = mWificond.createClientInterface(ifaceName);
    } catch (RemoteException e1) {
        Log.e(TAG, "Failed to get IClientInterface due to remote exception");
        return false;
    } catch (NullPointerException e2) {
        Log.e(TAG, "setupInterfaceForClientMode NullPointerException");
        return false;
    }

    if (clientInterface == null) {
        Log.e(TAG, "Could not get IClientInterface instance from wificond");
        return false;
    }
    Binder.allowBlocking(clientInterface.asBinder());
    // ... 注册扫描回调见下段
```

这一段做的是**接口创建**：三步验证（wificond 就绪 + 参数非空 + 创建成功），任一环节失败都直接 `return false`，把这个失败沿调用链向上传播。外加一个 `Binder.allowBlocking()` 允许后续操作阻塞当前线程。但接口创建只是拿到了一个句柄——框架还没有办法从 wificond 收到任何扫描结果。要让这个接口"活起来"，必须注册扫描事件回调：

```java
    // ... 接上文，IClientInterface 已创建，继续注册扫描回调

    mClientInterfaces.put(ifaceName, clientInterface);
    try {
        IWifiScannerImpl wificondScanner = clientInterface.getWifiScannerImpl();
        if (wificondScanner == null) {
            Log.e(TAG, "Failed to get WificondScannerImpl");
            return false;
        }
        mWificondScanners.put(ifaceName, wificondScanner);
        Binder.allowBlocking(wificondScanner.asBinder());
        ScanEventHandler scanEventHandler = new ScanEventHandler(executor, scanCallback);
        mScanEventHandlers.put(ifaceName, scanEventHandler);
        wificondScanner.subscribeScanEvents(scanEventHandler);
        PnoScanEventHandler pnoScanEventHandler = new PnoScanEventHandler(executor,
                pnoScanCallback);
        mPnoScanEventHandlers.put(ifaceName, pnoScanEventHandler);
        wificondScanner.subscribePnoScanEvents(pnoScanEventHandler);
    } catch (RemoteException e) {
        Log.e(TAG, "Failed to refresh wificond scanner due to remote exception");
    }

    return true;
}
```

主要功能：

- `retrieveWificondAndRegisterForDeath()` 获取 wificond 的 Binder 代理并注册死亡通知——这是 HAL 层与 Framework 之间的"心跳线"
- `mWificond.createClientInterface(ifaceName)` 通过 Binder 调用 wificond，创建 STA 模式的 `IClientInterface`——这一行是真正的跨进程桥接点
- 创建接口后立即注册两个扫描回调：`ScanEventHandler`（普通扫描）和 `PnoScanEventHandler`（离线扫描/Preferred Network Offload）——设计上把它们放在同一个 try-catch 里，说明这是一个原子操作：要么两个回调都注册成功，要么都失败
- `Binder.allowBlocking()` 允许 Binder 调用阻塞当前线程——因为某些 wificond 操作（尤其是 scanner 操作）可能耗时较长，不允许阻塞会导致 `RemoteException`。

`setupInterfaceForClientMode()` 是在 `WifiNl80211Manager` 中定义的，但 Framework 上层通过 `WifiNative` 来间接调用它（`WifiNative` 持有 `mWifiCondManager`，即 `WifiNl80211Manager` 的实例）。需要注意的是，HAL 启动不是由 `createClientInterface()` 间接触发的——在 `setupInterfaceForClientInScanMode()` 中，`startHal()` 在 `createClientInterface()` 之前就被显式调用了（详见下方调用链）。

`WifiNative.startHal()` 的实现：

```java
// service/java/com/android/server/wifi/WifiNative.java
private boolean startHal() {
    synchronized (mLock) {
        if (!mIfaceMgr.hasAnyIface()) {
            if (mWifiVendorHal.isVendorHalSupported()) {
                if (!mWifiVendorHal.startVendorHal()) {
                    Log.e(TAG, "Failed to start vendor HAL");
                    return false;
                }
                if (SdkLevel.isAtLeastS()) {
                    mWifiVendorHal.setCoexUnsafeChannels(
                            mCachedCoexUnsafeChannels, mCachedCoexRestrictions);
                }
            } else {
                Log.i(TAG, "Vendor Hal not supported, ignoring start.");
            }
        }
        registerWificondListenerIfNecessary();
        return true;
    }
}
```

`WifiVendorHal.startVendorHal()` 直接把锅甩给 `HalDeviceManager`：

```java
// service/java/com/android/server/wifi/WifiVendorHal.java
public boolean startVendorHal() {
    synchronized (sLock) {
        if (!mHalDeviceManager.start()) {
            mLog.err("Failed to start vendor HAL").flush();
            return false;
        }
        mLog.info("Vendor Hal started successfully").flush();
        return true;
    }
}

```

## 6.3 HalDeviceManager.startWifi() — 带重试的 start

```java
// service/java/com/android/server/wifi/HalDeviceManager.java
public static final int START_HAL_RETRY_TIMES = 3;   // 最多重试 3 次，即共 4 次尝试

// ...省略其他代码...

private boolean startWifi() {
    if (VDBG) Log.d(TAG, "startWifi");
    initializeInternal();  // 确保 HAL 已初始化（注册回调 + 死亡通知）
    synchronized (mLock) {
        int triedCount = 0;
        while (triedCount <= START_HAL_RETRY_TIMES) {
            int status = mWifiHal.start();
            if (status == WifiHal.WIFI_STATUS_SUCCESS) {
                managerStatusListenerDispatch();
                if (triedCount != 0) {
                    Log.d(TAG, "start IWifi succeeded after trying "
                             + triedCount + " times");
                }
                WifiChipInfo[] wifiChipInfos = getAllChipInfo(false);
                if (wifiChipInfos == null) {
                    Log.e(TAG, "Started wifi but could not get current chip info.");
                }
                return true;
            // ... 失败路径见下段
```

成功路径的核心逻辑是：拿到 `WIFI_STATUS_SUCCESS` → 通知监听者 → 查询芯片信息 → 返回。但现实并非总是这么顺利——下面的代码处理两种失败场景：

```java
            // ... 接上文 startWifi()，处理 HAL start 失败

            } else if (status == WifiHal.WIFI_STATUS_ERROR_NOT_AVAILABLE) {
                // HAL 进程正在停止中（上一次 stop 还没完成），重试
                Log.e(TAG, "Cannot start wifi because unavailable. Retrying...");
                try {
                    Thread.sleep(START_HAL_RETRY_INTERVAL_MS);
                } catch (InterruptedException ignore) {
                    // no-op
                }
                triedCount++;
            } else {
                // 其他错误，不重试
                Log.e(TAG, "Cannot start IWifi. Status: " + status);
                return false;
            }
        }
        Log.e(TAG, "Cannot start IWifi after trying " + triedCount + " times");
        return false;
    }
}
```

主要功能：

- `START_HAL_RETRY_TIMES = 3`，即最多重试 3 次，加上初始尝试共 4 次机会
- `initializeInternal()` 在每次 start 前都会调用——它内部只做一件事：`mWifiHal.initialize(mIWifiDeathRecipient)`，注册 HAL 死亡回调。它是幂等的，已经初始化过就直接返回
- 重试逻辑只针对 `ERROR_NOT_AVAILABLE` 这一个错误码——它表示 HAL 进程还在 `STOPPING` 状态（上一次 stop 的清理工作还没完成）。这是有意设计的窄白名单：其他错误码（如 `ERROR_UNKNOWN`）表示 HAL 内部出了不可恢复的问题，重试毫无意义
- 成功后调用 `getAllChipInfo(false)` 查询芯片信息。注意即使 `getAllChipInfo` 返回 null（拿不到芯片信息），`startWifi()` 依然返回 `true`——芯片信息查询失败不会回滚 HAL 的启动，因为这是一个"尽力而为"的查询，不影响 HAL 的基本功能

这个重试逻辑的设计很有意思——它说明了一个事实：**HAL 进程的 stop 不是瞬时的**。如果用户快速开关 WiFi，上一个 stop 的清理可能还没结束，下一个 start 就来了。这时候必须等它清理完再启动。更深一层的因果在 Native 侧 `Wifi::startInternal()`（`wifi.cpp`）的 `RunState` 状态机：`run_state_` 只有 `STOPPED`/`STOPPING`/`STARTED` 三态，关 WiFi 时 `stop()` 先置 `STOPPING`、清理完成后才落 `STOPPED`。此刻 start 撞上的 `STOPPING` 是会自行消失的中间态——等它过渡到 `STOPPED` 再重试即可成功，所以 Java 侧 sleep 后重试划算；而 `ERROR_UNKNOWN` 来自 `initializeModeControllerAndLegacyHal()` 的确定性失败（无 Legacy HAL、dlopen 失败），`run_state_` 停在 `STOPPED` 但失败条件不随重试改变，重试多少次结果都一样。

> **异常路径提示**：如果 retry 次数耗尽（`START_HAL_RETRY_TIMES = 3`，共 4 次尝试）仍然返回 `ERROR_NOT_AVAILABLE`，或 HAL 返回其他错误码，`startWifi()` 返回 `false`。这个 false 会沿调用链向上传播：`HalDeviceManager.start()` → `WifiVendorHal.startVendorHal()` → `WifiNative.startHal()`。`WifiNative.startHal()` 失败时只记录 `"Failed to start vendor HAL"` 日志，然后返回 false，**不会重试也不会触发 SelfRecovery**。这意味着如果 HAL 启动失败，WiFi 子系统会静默保持在 DisabledState，用户在 Settings 里看到的仍然是"WiFi 已关闭"—点击开关后图标转几圈就回到关闭状态。
>
> 在 logcat 中可以搜索以下关键字定位问题：
>
> - `"Cannot start IWifi after trying"` — 4 次尝试全部失败
> - `"Cannot start IWifi. Status:"` — 非重试类错误（HAL 返回 WIFI_STATUS_ERROR_UNKNOWN）
> - `"Cannot start wifi because unavailable. Retrying..."` — 单次重试（HAL 还在 STOPPING 状态）
> - `"Failed to start vendor HAL"` — 最终失败，在 WifiVendorHal.java 中打印

## 6.4 HIDL vs AIDL：两条 HAL 通信路径

Android 的 HAL 通信经历了从 HIDL 到 AIDL 的迁移。`WifiHal` 类封装了这两种路径的差异：

```java
// service/java/com/android/server/wifi/hal/WifiHal.java
protected IWifiHal createWifiHalMockable(...) {
    if (WifiHalHidlImpl.serviceDeclared()) {
        return new WifiHalHidlImpl(context, ssidTranslator);  // HIDL 路径
    } else if (WifiHalAidlImpl.serviceDeclared()) {
        return new WifiHalAidlImpl(context, ssidTranslator);  // AIDL 路径
    } else {
        Log.e(TAG, "No HIDL or AIDL service available for the Wifi Vendor HAL.");
        return null;
    }
}
```

主要功能：

- 优先尝试 HIDL，然后是 AIDL——这是为了向后兼容旧设备
- 两条路径实现同一个 `IWifiHal` 接口，对上层完全透明
- 如果两条路径都没有可用的服务，返回 null——这说明厂商没有提供 WiFi HAL 实现

**AIDL 路径**下，获取 HAL 服务的方式：

```java
// service/java/com/android/server/wifi/hal/WifiHalAidlImpl.java
protected android.hardware.wifi.IWifi getWifiServiceMockable() {
    if (SdkLevel.isAtLeastU()) {
        return android.hardware.wifi.IWifi.Stub.asInterface(
                ServiceManager.waitForDeclaredService(HAL_INSTANCE_NAME));
    }
    return null;
}
```

其中 `HAL_INSTANCE_NAME` 是 `"android.hardware.wifi.IWifi/default"`。`ServiceManager.waitForDeclaredService()` 会阻塞等待直到服务注册完成。而 `start()` 方法会捕获两种 Binder 异常：

```java
// service/java/com/android/server/wifi/hal/WifiHalAidlImpl.java
public @WifiHal.WifiStatusCode int start() {
    final String methodStr = "start";
    synchronized (mLock) {
        try {
            if (!checkWifiAndLogFailure(methodStr)) return WifiHal.WIFI_STATUS_ERROR_UNKNOWN;
            mWifi.start();  // Binder 调用 → 进入 Native HAL Service
            return WifiHal.WIFI_STATUS_SUCCESS;
        } catch (RemoteException e) {
            handleRemoteException(e, methodStr);
            return WifiHal.WIFI_STATUS_ERROR_REMOTE_EXCEPTION;
        } catch (ServiceSpecificException e) {
            handleServiceSpecificException(e, methodStr);
            return halToFrameworkWifiStatusCode(e.errorCode);
        }
    }
}
```

`mWifi.start()` 是一个 Binder 调用，它跨进程进入 `vendor.wifi_hal` 服务进程，执行 `wifi.cpp` 中的 `Wifi::start()` 方法。

---

# 7 厂商 HAL 是怎么被加载的？

> 厂商 HAL 以共享库（.so）的形式存在，由 `WifiLegacyHalFactory` 通过 `dlopen` + `dlsym` 加载，不同厂商（QCOM / MTK）在同一个 `init_wifi_vendor_hal_func_table()` 函数名下实现了完全不同的功能集合。

## 7.1 Native HAL 的 startInternal()

当 Binder 调用到达 `vendor.wifi_hal` 进程后，`Wifi::start()` 触发了 `startInternal()`：

```cpp
// hardware/interfaces/wifi/aidl/default/wifi.cpp
ndk::ScopedAStatus Wifi::startInternal() {
    if (run_state_ == RunState::STARTED) {
        return ndk::ScopedAStatus::ok();  // 幂等：已启动
    }
    if (run_state_ == RunState::STOPPING) {
        return createWifiStatus(WifiStatusCode::ERROR_NOT_AVAILABLE);  // 还在关，重试
    }
    // ... initializeModeControllerAndLegacyHal() 返回 ndk::ScopedAStatus
    if (auto wifi_status = initializeModeControllerAndLegacyHal(); !wifi_status.isOk()) {
        return wifi_status;
    }
    // 创建 WifiChip 对象...
    run_state_ = RunState::STARTED;
    // 通知 Java 侧：遍历所有注册的回调，逐一调用 onStart()
    for (const auto& callback : event_cb_handler_.getCallbacks()) {
        if (!callback->onStart().isOk()) {
            LOG(ERROR) << "Failed to invoke onStart callback";
        }
    }
    return ndk::ScopedAStatus::ok();
}
```

主要功能：

- `STARTED` 状态直接返回成功——支持幂等调用
- `STOPPING` 状态返回 `ERROR_NOT_AVAILABLE`——这就是 Java 侧重试逻辑触发的原因
- `initializeModeControllerAndLegacyHal()` 是真正的初始化入口——它返回 `ndk::ScopedAStatus`（而非 `bool`），内部调用 `WifiLegacyHalFactory` 来加载厂商 .so
- `event_cb_handler_.getCallbacks()` 返回所有已注册的 `IWifiEventCallback` 列表，代码遍历列表逐一调用 `onStart()`——这个回调会逐级向上传播，最终触发 `ClientListener.onStarted()`

`initializeModeControllerAndLegacyHal()` 的实现：

```cpp
// hardware/interfaces/wifi/aidl/default/wifi.cpp
// 精简说明：省略了 mode_controller_->initialize() 的返回值检查和日志
ndk::ScopedAStatus Wifi::initializeModeControllerAndLegacyHal() {
    mode_controller_->initialize();  // 固件模式控制器初始化
    // 获取所有 Legacy HAL 对象（每个物理芯片一个）
    const auto legacy_hals = legacy_hal_factory_->getHals();
    if (legacy_hals.empty()) {
        return createWifiStatus(WifiStatusCode::ERROR_UNKNOWN);
    }
    for (const auto& legacy_hal : legacy_hals) {
        legacy_hal::wifi_error legacy_status = legacy_hal->initialize();
        if (legacy_status != legacy_hal::WIFI_SUCCESS) {
            return createWifiStatus(WifiStatusCode::ERROR_UNKNOWN);
        }
    }
    return ndk::ScopedAStatus::ok();
}
```

`legacy_hal_factory_.getHals()` 返回的是 `WifiLegacyHal` 对象列表——每一个对象对应一个物理 WiFi 芯片的"遗留 HAL"封装。

## 7.2 两种加载方式：先"自家人"，再"找外援"

`WifiLegacyHalFactory` 加载厂商 .so 分两步走：

**第一步：静态链接（dlsym RTLD_DEFAULT）**

```cpp
// hardware/interfaces/wifi/aidl/default/wifi_legacy_hal_factory.cpp:96
// 精简说明：省略了 initHalFuncTableWithStubs() 和 initfn() 的返回值检查
bool WifiLegacyHalFactory::initLinkedHalFunctionTable(wifi_hal_fn* hal_fn) {
    init_wifi_vendor_hal_func_table_t initfn;
    initfn = (init_wifi_vendor_hal_func_table_t)dlsym(
        RTLD_DEFAULT, "init_wifi_vendor_hal_func_table");
    if (!initfn) {
        LOG(INFO) << "no vendor HAL library linked, will try dynamic load";
        return false;
    }
    initHalFuncTableWithStubs(hal_fn);  // 先用 stub 填满
    initfn(hal_fn);                      // 再让厂商覆盖
    return true;
}
```

主要功能：

- `dlsym(RTLD_DEFAULT, ...)` 在当前进程的全局符号表中查找——如果厂商 .so 已经通过 `LD_PRELOAD` 或编译期链接进进程，这里就能找到
- 先调用 `initHalFuncTableWithStubs()` 把整个函数表填满"空实现"——防止函数指针为 NULL
- 再调用厂商的 `initfn()` 覆盖掉它实现了的那些函数
- 如果 `dlsym` 返回 NULL（没有厂商 .so 静态链接进来），返回 false 进入动态加载

**第二步：动态加载（dlopen + XML 描述文件）**

```cpp
// hardware/interfaces/wifi/aidl/default/wifi_legacy_hal_factory.cpp:211
// 精简说明：省略了 wifi_early_initialize() 的错误处理（实际允许 WIFI_ERROR_NOT_SUPPORTED）
bool WifiLegacyHalFactory::loadVendorHalLib(
        const std::string& path, wifi_hal_lib_desc& desc) {
    void* h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!h) {
        LOG(ERROR) << "failed to open vendor hal library: " << path;
        return false;
    }
    init_wifi_vendor_hal_func_table_t initfn;
    initfn = (init_wifi_vendor_hal_func_table_t)dlsym(
        h, "init_wifi_vendor_hal_func_table");
    if (!initfn) {
        LOG(ERROR) << "init_wifi_vendor_hal_func_table not found in: " << path;
        dlclose(h);
        return false;
    }
    initHalFuncTableWithStubs(&desc.fn);
    initfn(&desc.fn);
    desc.fn.wifi_early_initialize();  // 厂商的早期初始化 hook
    desc.handle = h;
    return true;
}
```

主要功能：

- `.so` 的路径来自 `/vendor/etc/wifi/vendor_hals/*.xml`——每个芯片的 HAL 描述文件指定了 .so 的位置
- `RTLD_NOW | RTLD_LOCAL` 表示立即解析所有符号，且符号不导出到全局（隔离不同厂商的 HAL）
- 加载成功后调用 `wifi_early_initialize()`——这是一个厂商早期的初始化 hook，可以在函数表注册之后、正式工作之前做一些准备工作
- `.so` 的句柄保存下来，后续 `dlclose` 时用于卸载

> **异常路径提示**：如果 `dlopen()` 失败（.so 文件不存在、权限不足、或缺少依赖库），`loadVendorHalLib()` 返回 `false`，整个 LEGACY HAL 对象被标记为 `INVALID`。`Wifi::startInternal()` 会检测到没有任何可用的 Legacy HAL，返回 `ERROR_UNKNOWN`。Java 侧的 `HalDeviceManager.startWifi()` 不再重试（`ERROR_UNKNOWN` 不在重试白名单中），直接返回 `false`。**但有一个例外**：如果厂商实现了 AIDL HAL 的完整接口（而不依赖 Legacy HAL 桥接），`Wifi::startInternal()` 可能不需要 Legacy HAL 也能成功——这种情况下 `legacy_hal_factory_.getHals()` 返回空列表，`initializeModeControllerAndLegacyHal()` 仍然返回 `true`。
>
> 在 logcat 中搜索以下关键字定位 dlopen 失败：
>
> - `"failed to open vendor hal library: "` + `.so 路径` — dlopen 本身失败（文件不存在、权限、依赖缺失）
> - `"init_wifi_vendor_hal_func_table not found in: "` + `.so 路径` — .so 加载成功但没导出 `init_wifi_vendor_hal_func_table` 符号（厂商 .so 不符合 AOSP 接口约定）
> - `"no vendor HAL library linked, will try dynamic load"` — 静态链接路径未找到，进入 dlopen 动态加载路径（这是正常流程，不是错误）

## 7.3 QCOM vs MTK：同一个接口，两个世界

两家厂商都导出同一个函数签名：

```c
wifi_error init_wifi_vendor_hal_func_table(wifi_hal_fn *fn);
```

这个函数由 AIDL HAL 的 `WifiLegacyHalFactory` 通过 `dlsym` 加载（见 7.2 节）。但两家厂商的实现策略差异巨大。

**QCOM（高通）的实现**：

QCOM 的 `wifi_hal.cpp` 中同样有完整的 `init_wifi_vendor_hal_func_table`（约 1072 行起），集中填充了约 125 个函数指针，覆盖 AOSP 定义的几乎所有 HAL 函数。与 MTK 的区别在于：QCOM 采用"全功能"策略——即使某些功能在特定芯片上不支持，也提供返回"不支持"的实现，而非用 dummy 填充。其 `wifi_initialize()` 中除了标准的 nl80211 通道外，还通过 cld80211 库建立了一个额外的诊断通道（见 8.4 节），用于固件日志、逐包统计和 OEM 消息的上报。QCOM 的 HAL 包含大量私有扩展：SAR（人体吸收率功率管理）、温控、DTIM 配置、TWT（Target Wake Time）、VoIP 模式等。

**MTK（联发科）的实现**：

```cpp
// MTK/hardware-mediatek-wlan/wifi_hal/wifi_hal.cpp
wifi_error init_wifi_vendor_hal_func_table(wifi_hal_fn* fn) {
    if (fn == NULL) return WIFI_ERROR_UNKNOWN;

    fn->wifi_initialize = wifi_initialize;
    fn->wifi_cleanup = wifi_cleanup;
    fn->wifi_event_loop = wifi_event_loop;
    // ... 约 60 个真实函数实现（核心功能 + NAN + RTT + 链路统计）...
    // 另有约 5 个函数指向 _dummy 后缀的空实现（如 wifi_get_ring_buffers_status_dummy）

    // 用模板"虚函数"替代不需要的功能：
    populateDummyFor(fn->wifi_wait_for_driver_ready);
    populateDummyFor(fn->wifi_set_nodfs_flag);
    populateDummyFor(fn->wifi_set_log_handler);
    populateDummyFor(fn->wifi_reset_log_handler);
    populateDummyFor(fn->wifi_configure_nd_offload);
    populateDummyFor(fn->wifi_start_pkt_fate_monitoring);
    populateDummyFor(fn->wifi_get_ring_data);
    populateDummyFor(fn->wifi_start_logging);

    return WIFI_SUCCESS;
}
```

主要功能：

- 函数表共 73 个函数指针（约 60 个真实实现 + 约 5 个直接赋值为 `_dummy` 的空函数 + 8 个 `populateDummyFor` 填充的空函数）
- 不需要的功能用 `populateDummyFor<T>()` 模板函数填充——返回值类型返回 `WIFI_SUCCESS`，void 类型啥也不做
- 这是典型的"最小实现"策略——降低维护成本，减少出 bug 的面
- **但**这 8 个 dummy 函数在上层框架看来是"调用成功"但不是"功能正常"——如果 Framework 依赖这些函数的返回结果做决策，可能产生非预期行为

`populateDummyFor` 的实现利用了 C++ 模板特化：

```cpp
// MTK/hardware-mediatek-wlan/wifi_hal/wifi_hal.cpp
template <typename T>
void populateDummyFor(T& val) {
    val = &DummyFunction<T>::invoke;
}
```

这个模板为每种函数签名自动生成一个返回"成功"的空函数——比手写 8 个 stub 优雅得多。

**QCOM vs MTK 对比总结**：

| 维度         | QCOM（高通）                                                 | MTK（联发科）                                                |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 实现策略     | 全功能——函数分散在多个文件，覆盖 AOSP 定义的几乎所有 HAL 函数 | 精简——集中在单个文件，73 个函数指针（~60 真实 + ~13 dummy/stub） |
| 未实现策略   | 每个函数都有实现（返回错误码或"不支持"）                     | `populateDummyFor` 模板返回 `WIFI_SUCCESS`                   |
| 特有功能     | SAR、温控、TWT、DTIM、CLD80211 诊断通道                      | 无                                                           |
| 初始化复杂度 | 高（标准 NL socket + CLD80211 库 + OEM 控制 socket）         | 低（2 个 NL socket）                                         |
| 函数表初始化 | `wifi_hal.cpp` 集中初始化，全部约 125 个函数均为真实实现     | `wifi_hal.cpp` 集中初始化，73 个函数指针（~60 真实 + ~13 dummy/stub） |

把两家 HAL 放回**大楼供电比喻**里比较——QCOM 的 HAL 像标准化的工业接口（USB-C：一口多用，但实现成本高），MTK 的 HAL 像定制化的专用接口（DC 圆头：功能单一，但够用且省事）。

进一步说，这就像两栋大楼装了不同品牌的变压器。QCOM 的变压器功能齐全，附带智能监控、远程诊断（CLD80211 的 6 个组播组）、自动调压；MTK 的变压器功能精简，只做最基本的电压转换，其他功能面板上装了"假开关"（dummy），按下去灯亮但什么都不会发生。这些假开关的"灯亮"就是返回 `WIFI_SUCCESS`，但电流并未真正接通——`wifi_get_ring_data` 这类 dummy 函数返回成功却不填充数据，上层诊断组件信以为真、照常走完采集流程，最终固件日志与 ring buffer 一片空白，固件崩溃时开发者也无从定位。Framework 作为"大楼管理员"，并不关心变压器的品牌——它只需要变压器把电送进来。

---

# 8 nl80211 + ioctl：用户空间到内核的两条通信通道

> HAL 层到 kernel 的通信有两条通道——**nl80211（Generic Netlink）** 负责标准 WiFi 操作（扫描、连接、密钥），**ioctl**（`SIOCDEVPRIVATE+1`、`SIOCGIFFLAGS`、WEXT `SIOCIWFIRSTPRIV+N`）负责接口管理和厂商私有命令。每个厂商的 `wifi_initialize()` 都会独立创建 netlink socket 并解析 nl80211 family ID，同时也通过 ioctl 操作网络接口。

**大楼供电比喻**的最后一环——到这里，大楼内部的配电线路已经全部就绪（`WifiController` 总闸合上 → `ConcreteClientModeManager` 楼层配电柜就绪 → `HalDeviceManager` 变压器通电），但还缺最后一根电缆：从变压器到电网的接线。nl80211 就是这根电缆——它把用户空间（HAL）和内核空间（cfg80211）连接起来，让上层的每一条命令都能送达 WiFi 芯片的驱动程序。

## 8.1 nl80211 是什么？

nl80211 是 Linux 内核中 cfg80211 子系统对外暴露的用户空间接口。它不是 TCP/UDP 这种传统 socket——它是 `AF_NETLINK` 协议族下的 `NETLINK_GENERIC` 子类型。简单理解：**nl80211 是内核 WiFi 栈给用户空间开的一扇"专用窗口"**，所有标准 WiFi 操作（扫描、关联、断开、设置信道……）都通过这扇窗口发送命令。

## 8.2 Netlink socket 创建的标准流程

无论是 QCOM 还是 MTK 的 HAL，创建 nl80211 socket 的流程都是相同三步：

```cpp
// 以 MTK 为例
// MTK/hardware-mediatek-wlan/wifi_hal/wifi_hal.cpp
static nl_sock* wifi_create_nl_socket(int port) {
    struct nl_sock* sock = nl_socket_alloc();  // 步骤 1：分配 socket
    if (!sock) return NULL;

    wifi_socket_set_local_port(sock, port);    // 步骤 1.5：设置本地端口号
    if (nl_connect(sock, NETLINK_GENERIC)) {   // 步骤 2：连接到 NETLINK_GENERIC
        nl_socket_free(sock);
        return NULL;
    }
    return sock;
}
```

然后在 `wifi_initialize()` 中：

```cpp
// 创建两个 socket：一个发命令，一个收事件
info->cmd_sock   = wifi_create_nl_socket(WIFI_HAL_CMD_SOCK_PORT);    // 命令通道
info->event_sock = wifi_create_nl_socket(WIFI_HAL_EVENT_SOCK_PORT);  // 事件通道

// 解析 nl80211 family ID
info->nl80211_family_id = genl_ctrl_resolve(cmd_sock, "nl80211");
if (info->nl80211_family_id < 0) {
    // 致命错误——内核不支持 nl80211，级联释放所有已分配资源
    nl_socket_free(cmd_sock);
    nl_socket_free(event_sock);
    free(info->event_cb);
    free(info->cmd);
    free(info);
    return WIFI_ERROR_UNKNOWN;
}

// 订阅组播事件
wifi_add_membership((wifi_handle)info, "scan");
wifi_add_membership((wifi_handle)info, "mlme");
wifi_add_membership((wifi_handle)info, "regulatory");
wifi_add_membership((wifi_handle)info, "vendor");
```

这一段初始化奠定了后续所有 nl80211 交互的分工格局：`cmd_sock` 走同步的请求-响应，`event_sock` 走异步的事件上报，两路分离让 HAL 永远不必把内核的突发消息误判为命令回执。

主要功能：

- 两个 socket 分工明确：`cmd_sock` 发命令并等待响应（同步），`event_sock` 接收内核主动推送的事件（异步）
- **为什么必须是两个 socket 而不是一个？** Netlink 协议用序列号匹配请求和响应——HAL 发出 `NL80211_CMD_TRIGGER_SCAN`（序列号=42），内核返回 `NL80211_CMD_SCAN_RESULTS`（序列号=42），HAL 凭序列号识别这是第 42 号命令的响应。如果内核的异步事件（如 `NL80211_CMD_DISASSOCIATED`，由 AP 断连触发）和 HAL 的命令响应混在同一个 socket 上，异步事件可能恰好落在 HAL 等待第 42 号响应的窗口内，被误当成命令响应来解析——序列号对不上，HAL 的逻辑就会出错。两路分拆消除了这个竞态。
- `nl_connect(sock, NETLINK_GENERIC)` 连接的不是传统网络地址，而是内核的 Generic Netlink 总线
- `genl_ctrl_resolve()` 发起一次 `CTRL_CMD_GETFAMILY` 查询，询问内核"nl80211 的 family ID 是多少"——后续所有 nl80211 消息都需要带上这个 ID。注意这里传入的是局部变量 `cmd_sock`（而非 `info->cmd_sock`，虽然两者此时指向同一个对象）
- `wifi_add_membership()` 的第一个参数是 `(wifi_handle)info`——将 `hal_info*` 指针转换为不透明的 `wifi_handle` 类型，函数内部通过 `getHalInfo()` 再转回来
- 四个组播组的含义：`scan`（扫描结果通知）、`mlme`（802.11 管理帧事件）、`regulatory`（频谱管制域变更）、`vendor`（厂商自定义事件）

> **异常路径提示**：如果 `genl_ctrl_resolve("nl80211")` 返回负数（内核未加载 cfg80211 模块、或不支持 nl80211 族），HAL 的 `wifi_initialize()` 会级联释放已分配的所有资源（`nl_socket_free` + `free`）并返回 `WIFI_ERROR_UNKNOWN`。这个错误沿 HAL 调用链返回 `Wifi::startInternal()` → `Wifi::start()` → Binder 错误码 → Java 侧 `HalDeviceManager.startWifi()` 返回 `false` → 最终 WiFi 子系统停留在 DisabledState。这是一个**不可恢复的硬件层错误**——此时即使重试也毫无意义，因为内核根本没有提供 nl80211 接口。

## 8.3 ioctl 通道：HAL 和 Supplicant 如何与内核交互

除了 nl80211，WiFi 子系统还大量使用 ioctl 系统调用进行通信：

| 调用方             | ioctl 类型                     | 用途                                 | 典型 SIOC 常量                                               |
| ------------------ | ------------------------------ | ------------------------------------ | ------------------------------------------------------------ |
| **wpa_supplicant** | `linux_ioctl.c`                | 网络接口管理                         | `SIOCGIFFLAGS`/`SIOCSIFFLAGS`（up/down 接口）、`SIOCGIFHWADDR`/`SIOCSIFHWADDR`（MAC 地址）、`SIOCBRADDBR`/`SIOCBRDELBR`（网桥） |
| **wpa_supplicant** | `driver_cmd_nl80211.c`         | 私有 DRIVER 命令                     | `SIOCDEVPRIVATE + 1` — 与内核驱动的 PRIMARY 通信通道         |
| **QCOM HAL**       | `wificonfig.cpp`               | 创建虚拟接口                         | `SIOCGIFFLAGS`/`SIOCSIFFLAGS`（设置 `IFF_UP`）               |
| **MTK HAL**        | `wifi_hal.cpp`                 | 固件参数                             | `SIOCDEVPRIVATE + 1`（设置 `set_fw_param`）                  |
| **QCOM 内核 HAL**  | `wlan_hdd_wext.c`              | vendor 私有命令（~30+ 命令）         | `SIOCIWFIRSTPRIV + N`（设置/获取参数、链路速度、PNO、keepalive……） |
| **MTK 内核 HAL**   | `gl_wext.c` + `gl_wext_priv.c` | 标准 WEXT（~20+）+ 私有（~20+ 命令） | `SIOCGIW*`/`SIOCSIW*`（ESSID、扫描、信道……）+ `SIOCIWFIRSTPRIV + N` |

以 MTK 为例，`wifi_set_scan_mode()` 把 `"set_fw_param alwaysscanen 1"` 填入 `android_wifi_priv_cmd` 结构体，再 `ioctl(fd, SIOCDEVPRIVATE + 1, &ifr)` 下发给内核驱动切换扫描模式。QCOM 侧同理——`wificonfig.cpp` 的 `wifi_virtual_interface_create()` 创建 STA 接口后，先 `ioctl(sock, SIOCGIFFLAGS, &ifr)` 读出 flags，再 `ifr.ifr_flags |= IFF_UP`，最后 `ioctl(sock, SIOCSIFFLAGS, &ifr)` 把接口置 up。

> **关键理解**：nl80211 和 ioctl 是两条互补的通道，不是竞争关系。nl80211 处理 cfg80211 框架定义的标准 WiFi 操作，ioctl 处理网络层操作（接口 up/down、MAC 地址）和厂商自定义扩展命令。HAL 和 Supplicant 同时使用两者。

## 8.4 QCOM 的额外通道：CLD80211

QCOM 的 HAL 比 MTK 多了一个特殊的通信通道——CLD80211：

```cpp
// QCOM/hardware-qcom-wlan/qcwcn/wifi_hal/wifi_hal.cpp (wifi_initialize 中)
// 创建 CLD80211 诊断通道
info->cldctx = cld80211_init();
if (info->cldctx != NULL) {
    // 成功：提取底层 nl_sock 并设置回调
    info->user_sock = cld80211_get_nl_socket_ctx(info->cldctx);
    if (info->user_sock == NULL) goto cld80211_cleanup;
    wifi_init_cld80211_sock_cb(info);  // 设置 NL 回调（error/finish/ack/valid）

    // 订阅 4 个无条件组播组
    cld80211_add_mcast_group(info->cldctx, "host_logs");
    cld80211_add_mcast_group(info->cldctx, "per_pkt_stats");
    cld80211_add_mcast_group(info->cldctx, "diag_events");
    cld80211_add_mcast_group(info->cldctx, "fatal_events");
    // oem_msgs 需要 OEM 控制 socket 就绪
    if (info->wifihal_ctrl_sock.s > 0) {
        cld80211_add_mcast_group(info->cldctx, "oem_msgs");
    }
} else {
    // CLD80211 不可用，回退到标准 NL socket
    ret = wifi_init_user_sock(info);
    if (ret != WIFI_SUCCESS) goto unload;
}
// fw_logs 在函数末尾单独订阅（gated on cldctx != NULL）
```

这段代码的分叉点在 `cldctx` 是否为 NULL——非空走 CLD80211 诊断通道订阅，为空则回退到标准 NL socket。

主要功能：

- CLD80211 是 QCOM 私有的 Generic Netlink 族，用于固件日志和诊断数据的上报
- 成功路径（`cldctx != NULL`）有 2 个中间步骤：先通过 `cld80211_get_nl_socket_ctx()` 提取底层 `nl_sock`，再通过 `wifi_init_cld80211_sock_cb()` 设置 NL 回调（error/finish/ack/valid handler）
- 4 个无条件组播组：`host_logs`、`per_pkt_stats`、`diag_events`、`fatal_events`
- `oem_msgs` 有条件包裹：仅当 OEM 控制 socket 已创建（`wifihal_ctrl_sock.s > 0`）时才订阅
- `fw_logs` 在函数末尾单独订阅（不在主 cld80211 块内），同样 gated on `cldctx != NULL`
- 失败路径（`cldctx == NULL`）回退到 `wifi_init_user_sock()`——一个不依赖 cld80211 库的标准 NL socket
- MTK 没有这个通道——它的日志和诊断信息通过标准 nl80211 vendor 事件上报

## 8.5 三条独立的 nl80211 通道

读到这里你可能已经注意到：系统的不同组件各自独立地创建 netlink socket。总结如下：

| 进程              | 谁创建的                | socket 数量                      | 用途                                 |
| ----------------- | ----------------------- | -------------------------------- | ------------------------------------ |
| `wpa_supplicant`  | `driver_nl80211.c`      | 2（cmd + event） + 每个 BSS 1 个 | 标准 802.11 操作（扫描、认证、关联） |
| `wificond`        | `netlink_manager.cpp`   | 2（sync + async）                | 接口管理 + 某些 offload 操作         |
| `vendor.wifi_hal` | QCOM/MTK `wifi_hal.cpp` | 2-3（cmd + event + 可选 user）   | 厂商私有命令（vendor commands）      |

**它们没有共享 socket**——每个进程独立 `nl_socket_alloc()` → `nl_connect()` → `genl_ctrl_resolve("nl80211")`。三个进程各自持有自己的 nl80211 family ID，各自独立向内核收发消息。

这种设计的好处是**进程隔离**：如果 `wpa_supplicant` 崩溃，`vendor.wifi_hal` 的 socket 不受影响；如果厂商 HAL 需要发 vendor 命令，它不需要经过 `wpa_supplicant` 中转。坏处是**内核中的重复开销**——三个进程各自维护 netlink 缓冲区，各自订阅组播组，内核需要向三个 socket 各自推送相同的事件。

---

# 9 HAL 就绪之后：驱动加载 & Supplicant 启动

前面八章追踪了从用户点击开关到 HAL 就绪的完整链路。到这里，`HalDeviceManager.startWifi()` 已经拉起了 `vendor.wifi_hal` 进程，HAL 已经初始化完毕。接下来有两件事要完成，而且有**先后顺序**：

1. **第一步：驱动加载**——HAL 进程内部通过 vendor .so 加载 WiFi 驱动，完成 PCIe 枚举、固件下载、WMI 握手
2. **第二步：Supplicant 启动**——驱动就绪后，Framework 才启动 wpa_supplicant，它通过 nl80211 与已注册的 cfg80211 通信

## 9.1 第一步：驱动是怎么被加载的？

`HalDeviceManager.startWifi()` 调用 `mWifi.start()` 通过 AIDL Binder 跨进程调用 HAL 进程的 `Wifi::startInternal()`。**Framework 的 Java 代码不会直接 insmod 驱动**——驱动加载是 HAL 进程内部的 C++ 代码完成的。

调用链从 Framework 到 insmod：

```text
HalDeviceManager.startWifi()                    // HalDeviceManager.java:1471
  → WifiHal.start()                             // WifiHal.java:209
    → WifiHalAidlImpl.start()                   // WifiHalAidlImpl.java:174
      ──── AIDL Binder IPC（跨进程） ────
      → Wifi::startInternal()                   // wifi.cpp:246
        → initializeModeControllerAndLegacyHal()  // wifi.cpp:360
          → mode_controller_->initialize()      // wifi_mode_controller.cpp
            → driver_tool_->LoadDriver()        // driver_tool.cpp:34
              → ::wifi_load_driver()            // wifi_hal_common.cpp:180
                → insmod()                      // syscall(__NR_finit_module)
```

`wifi_load_driver()` 通过 `insmod()` 系统调用将 WiFi 驱动模块（`.ko` 文件）加载到内核。`insmod()` 先 `open(filename, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)` 拿到 `.ko` 的文件描述符，再调用 `syscall(__NR_finit_module, fd, args, 0)`——这是 Linux 内核提供的模块加载接口，用户空间的 C 代码可以通过它向内核注入模块，Java 代码做不到这一点。

为什么 insmod 必须待在 HAL 进程里，而不是 Framework？其一，`finit_module` 是特权系统调用，Android 把这类系统级操作收敛到专职的 `vendor.wifi_hal` 硬件服务进程，跑在 `system_server` 里的 Java 代码既没有、也不该有这个能力。其二，驱动模块名和加载参数是厂商强相关的（`DRIVER_MODULE_PATH`/`DRIVER_MODULE_ARG` 由编译期宏注入），AOSP 的 Framework 不该硬编码任何厂商细节——把 `wifi_load_driver()` 放在 `libwifi_hal` 里由厂商 HAL 进程调用，厂商才能用配置注入自己的 `.ko` 路径。其三，加载必须与后续的固件下载、WMI 握手严格串行，`startInternal()` 同步执行、insmod 不返回就不会继续，这份时序保证只有放进同一条 C++ 调用链才成立。

加载驱动之后，HAL 还需要初始化 vendor HAL .so：

```text
        → WifiLegacyHalFactory::getHals()       // wifi_legacy_hal_factory.cpp:72
          → dlopen("libwifi-hal-qcom.so")       // 加载厂商 HAL 实现
          → dlsym("init_wifi_vendor_hal_func_table")  // 填充函数指针表
        → WifiLegacyHal::start()                // wifi_legacy_hal.cpp:558
          → wifi_wait_for_driver_ready()        // 等待驱动就绪
          → wifi_initialize()                   // 获取全局句柄
```

> **insmod vs dlopen**：`insmod` 加载的是内核模块（`.ko`），运行在内核空间；`dlopen` 加载的是用户空间共享库（`.so`），运行在 HAL 进程中。WiFi 驱动加载涉及两者：先 insmod 内核驱动模块，再 dlopen vendor HAL .so 来与内核驱动通信。

## 9.2 第二步：Supplicant 是怎么被启动的？

驱动就绪后，`ConcreteClientModeManager` 的状态机收到 `CMD_SWITCH_TO_CONNECT_MODE`，开始启动 Supplicant。调用链：

```text
ConcreteClientModeManager.ClientModeStateMachine   // ConcreteClientModeManager.java:1077
  → CMD_SWITCH_TO_CONNECT_MODE 处理
    → WifiNative.switchClientInterfaceToConnectivityMode()  // WifiNative.java:1749
      → WifiNative.startSupplicant()             // WifiNative.java:725
        → WifiNative.startAndWaitForSupplicantConnection()  // WifiNative.java:698
          → SupplicantStaIfaceHal.initialize()   // 检查 ISupplicant 服务是否已声明
          → SupplicantStaIfaceHal.startDaemon()  // SupplicantStaIfaceHal.java:1012
            → SupplicantStaIfaceHalAidlImpl.startDaemon()  // :492
              → getSupplicantMockable()          // :576
                → ServiceManager.waitForDeclaredService(
                    "android.hardware.wifi.supplicant.ISupplicant/default")
```

`ServiceManager.waitForDeclaredService()` 是关键——它**不会主动启动服务**，而是等待服务出现。由于 `.rc` 文件中 `wpa_supplicant` 声明了 `disabled`（开机不自启动），Android 的 lazy HAL 机制会在客户端调用 `waitForDeclaredService()` 时通知 `init` 启动该服务：

```rc
# external_wpa_supplicant_8/wpa_supplicant/aidl/vendor/android.hardware.wifi.supplicant-service.rc
service wpa_supplicant /vendor/bin/hw/wpa_supplicant \
    -O/data/vendor/wifi/wpa/sockets -dd \
    -g@android:wpa_wlan0
    interface aidl android.hardware.wifi.supplicant.ISupplicant/default
    class main
    socket wpa_wlan0 dgram 660 wifi wifi
    disabled
    oneshot
```

`init` 收到启动请求后，`fork()` + `execve("/vendor/bin/hw/wpa_supplicant", ...)` 启动进程，`main()` 被调用。`main()` 执行后，AIDL 层将 `ISupplicant` 服务注册到 `ServiceManager`，Framework 的 `waitForDeclaredService()` 返回，连接建立。

> **rc 文件语法速览**：`service <名称> <可执行文件路径>` 定义一个 init 管理的服务。`interface aidl ...` 声明该服务提供的 AIDL 接口（init 用它来响应 lazy HAL 启动请求）。`disabled` 表示开机不自动启动，等被请求时才启动。`oneshot` 表示进程退出后不自动重启。`socket` 让 init 预创建一个 Unix domain socket 并传给服务进程。
>
> **lazy HAL 机制**：Android 的 lazy HAL 允许服务声明为"按需启动"。当客户端调用 `ServiceManager.waitForDeclaredService()` 时，ServiceManager 检查服务是否已注册——如果没有，它通过 `init` 的属性系统触发服务启动。客户端阻塞等待直到服务注册完成。这种机制的好处是：不使用 WiFi 时 Supplicant 进程不占用内存和 CPU。

驱动加载的详细分析（QCOM 6 阶段、MTK wlanProbe 12 步、SSR 崩溃恢复）见下一篇《驱动加载与崩溃恢复》。Supplicant 启动后的 eloop 事件循环、状态机、AIDL 接口层见后续《Supplicant 启动》。

---

# 10 常见错误速查表

WiFi 打不开是 Android 用户最常见的问题之一。下面这张表按调用链的顺序，列出了从点击开关到 HAL 就绪过程中所有可能的失败点、对应的日志关键字和排查思路。

| #    | 失败阶段              | 失败原因                                        | logcat 关键字                                                | 用户看到什么                      | 排查方向                                                     | 章节 |
| ---- | --------------------- | ----------------------------------------------- | ------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------ | ---- |
| 0    | App 层调用            | 没有 `CHANGE_WIFI_STATE` 权限                   | `SecurityException: WifiService`                             | App 崩溃                          | 检查 AndroidManifest.xml                                     | §1.2 |
| 1    | 闸门①                 | 第三方 App targetSdk >= Q                       | `"setWifiEnabled not allowed for uid="` (info)               | 返回 false，WiFi 不打开           | 非 bug，设计如此——Q+ 的第三方 App 不允许直接开关 WiFi，应使用 Settings Panel API | §2.2 |
| 2    | 闸门②                 | 卫星模式开启                                    | `"setWifiEnabled not allowed as satellite mode is on."` (info) | 返回 false                        | 等卫星通信结束再试，或检查卫星模式设置                       | §2.2 |
| 3    | 闸门③                 | 飞行模式 + 非特权调用者                         | `"setWifiEnabled in Airplane mode: only Settings can toggle wifi"` (err) | 返回 false                        | 关闭飞行模式，或用 Settings 界面操作                         | §2.2 |
| 4    | 闸门④                 | 热点运行中(pre-S)                               | `"setWifiEnabled with SoftAp enabled"` (err)                 | 返回 false                        | 先关闭热点再开 WiFi（S+ 设备无此限制）                       | §2.2 |
| 5    | 闸门⑤                 | IT 管理员限制(T+)                               | `"setWifiEnabled with user restriction: only DO/PO can toggle wifi"` (err) | 返回 false                        | 企业设备策略限制，联系 IT 管理员                             | §2.2 |
| 6    | 闸门⑥                 | 旧版 App 确认框                                 | `"setWifiEnabled must show user confirmation dialog for uid=%"` (info) | 异步弹出确认对话框                | 用户点击"允许"后重新进入 setWifiEnabled                      | §2.2 |
| 7    | SettingsStore         | 飞行模式下 WiFi 不可切换                        | `handleWifiToggled` 返回 false                               | WiFi 不打开                       | `AIRPLANE_MODE_TOGGLEABLE_RADIOS` 未包含 wifi                | §2.3 |
| 8    | HAL 启动              | HAL 返回 `ERROR_NOT_AVAILABLE`（STOPPING 状态） | `"Cannot start wifi because unavailable. Retrying..."`       | 点击后转圈，可能成功（重试中）    | 快速开关导致的上次 stop 未完成，等几秒再试                   | §6.3 |
| 9    | HAL 启动              | HAL 重试 3 次后全部失败                         | `"Cannot start IWifi after trying 3 times"`                  | WiFi 开关回弹到关闭               | `vendor.wifi_hal` 进程卡在 STOPPING 状态，需重启该进程或 reboot | §6.3 |
| 10   | HAL 启动              | HAL 返回非重试类错误                            | `"Cannot start IWifi. Status: <code>"`                       | WiFi 开关回弹                     | HAL 进程崩溃、内存不足、或芯片初始化失败                     | §6.3 |
| 11   | HAL 启动              | `vendor.wifi_hal` 服务未注册                    | `"No HIDL or AIDL service available for the Wifi Vendor HAL."` | WiFi 开关回弹                     | 厂商 HAL 服务未启动，检查 `init.rc` 和 HAL 进程状态          | §6.4 |
| 12   | Legacy HAL            | dlopen 厂商 .so 失败                            | `"failed to open vendor hal library: <path>"`                | WiFi 开关回弹                     | .so 文件缺失、权限错误、或 ELF 依赖缺失（`ldd` 检查）        | §7.2 |
| 13   | Legacy HAL            | .so 加载成功但缺少符号                          | `"init_wifi_vendor_hal_func_table not found in: <path>"`     | WiFi 开关回弹                     | 厂商 .so 不符合 AOSP 接口约定，检查 .so 的导出符号表         | §7.2 |
| 14   | nl80211               | 内核未加载 cfg80211 模块                        | `genl_ctrl_resolve("nl80211")` 返回负数（HAL log）           | WiFi 开关回弹                     | 内核配置问题：`CONFIG_CFG80211` 未开启或模块未加载（`lsmod \| grep cfg80211`） | §8.2 |
| 15   | wificond              | wificond 服务未就绪                             | `"Failed to get IClientInterface"`                           | WiFi 可能显示"已打开"但无实际功能 | wificond 守护进程崩溃或未启动，检查 `wificond` 进程状态      | §6.2 |
| 16   | WifiNative.initialize | Vendor HAL 初始化失败                           | `"Failed to initialize vendor HAL"`                          | 开机后 WiFi 始终关闭              | 系统启动时的底层基础设施未就绪，通常需要 reboot              | §4.3 |

> **日志级别说明**：`info` 级别的拒绝日志在默认 logcat 中可见；`err` 级别的日志会更显眼。调试时建议 `logcat -s WifiService:* WifiVendorHal:* HalDeviceManager:*`。

---

# 11 总结：从点击开关到 HAL 就绪，一条线串起来

这篇文章追踪了一条完整的调用链。让这张表帮你回顾整个过程：

| 阶段      | 组件                        | 关键操作                                             | 比喻                                                         |
| --------- | --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| 1. 入口   | `WifiManager`               | Binder IPC 到 system_server                          | 按下墙上的开关（WifiManager 只是一个薄壳，真正的逻辑在 system_server） |
| 2. 安检   | `WifiServiceImpl`           | 权限检查 + 6 道场景闸门                              | 配电箱断路器面板（6 个互锁开关逐一检查）                     |
| 3. 调度   | `ActiveModeWarden`          | `wifiToggled()` 发送 CMD 给状态机                    | 总调度室收到用电请求（不亲自执行，交给状态机）               |
| 4. 决策   | `WifiController`            | `DisabledState` → `EnabledState` 转移                | 合上变压器总闸（带互锁装置，防止反复扳动）                   |
| 5. 初始化 | `ConcreteClientModeManager` | 创建 `ClientModeImpl`（9 状态 FSM）                  | 合上楼层配电柜闸（分配具体线路：连接 or 仅扫描）             |
| 6. 拉活   | `HalDeviceManager`          | AIDL/HIDL → `IWifi.start()` 拉起 HAL 进程            | 接通大楼到电网之间的变压器（带重试机制）                     |
| 7. 加载   | `WifiLegacyHalFactory`      | `dlopen` / `dlsym` 加载厂商 .so                      | 确认变压器品牌型号（QCOM 全功能 vs MTK 精简版）              |
| 8. 接线   | 厂商 HAL + kernel           | `nl_socket_alloc()` → `genl_ctrl_resolve("nl80211")` | 把电缆接上电网（建立与内核 cfg80211 的通信通道）             |

此时 HAL 已就绪，nl80211 通道已建立，`ClientModeImpl` 正处于 `DisconnectedState` 等待连接指令。接下来的事情——`wpa_supplicant` 的初始化、扫描、关联、DHCP——这些属于"从 HAL 就绪到连接成功"的下半场。我们下一章继续。

---

# 下一章预告

**WiFi打开（二）QCOM 与 MTK 怎么把芯片叫醒？**

- QCOM 平台驱动加载的 6 个阶段：从 `module_init` 到 `wiphy_register`
- ICNSS2 集成 WiFi 路径（WCN6750/WCN7750）与 cnss2 PCIe 路径的差异
- MTK 平台驱动加载的完整流程：conninfra 共享框架 → wlanProbe → FW Ready 位轮询
- wlan_objmgr 三层对象模型的创建机制和组件回调模式
- WMI 握手的三个事件（Service Ready / EXT / EXT2）各自携带什么信息
- SSR 崩溃恢复的三级体系（QCOM）和两级体系（MTK）

**源码出处**：[packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi/)、[hardware/interfaces/wifi](https://android.googlesource.com/platform/hardware/interfaces/)；QCOM HAL [hardware_qcom_wlan](https://git.codelinaro.org/clo/la/platform/hardware/qcom/wlan/)、MTK HAL [hardware_mediatek](https://github.com/Evolution-X-Devices/hardware_mediatek/tree/bka/wlan)。
