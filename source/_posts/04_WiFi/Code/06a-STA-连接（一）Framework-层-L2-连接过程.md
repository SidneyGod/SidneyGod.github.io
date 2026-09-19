---
title: STA 连接（一）Framework 层 L2 连接过程
top: 1
related_posts: true
abbrlink: 513df0ea
date: 2026-09-19 20:27:16
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 你在 WiFi 列表中点了一下「连接」，几十毫秒之内，Android Framework 完成了权限检查、MAC 地址随机化、配置校验、状态机跳转、AIDL 跨进程调用——最终一条 `ISupplicantStaNetwork.select()` 命令跨过进程边界抵达 wpa_supplicant。本文追踪从用户点击到 AIDL 调用完成的**完整 Framework 层调用链**，不涉及 supplicant 内部。

> **上篇回顾**：在扫描三部曲中，我们讲完了从 Framework 通过 wificond 下发扫描、到 supplicant 内部扫描引擎、到驱动执行的完整链路。扫描找到了目标 AP——接下来就是连接。本篇跳到另一个主线：Framework 怎么把连接请求发给 supplicant？中间的每一步做了什么？

# 本章导读

STA 连接就像**酒店入住**。`WifiServiceImpl.connect()` 是前台——它接待你、检查你的身份（权限检查）、查房态（网络配置是否存在）。`ConnectHelper` 是前台经理——它确认你不是重复入住（防 MCC，Multi-Channel Concurrency 多信道并发）、通知客房部做好准备。`ClientModeImpl` 是客房系统——它办完登记后通知门锁系统（`WifiNative.connectToNetwork()`），门锁系统把你的房卡信息（`WifiConfiguration`）通过内部对讲机（AIDL）发给制卡机（`SupplicantStaIfaceHalAidlImpl`），制卡机负责把卡上的芯片信息（SSID、PSK、KeyMgmt）写入卡片，交给制卡工厂（wpa_supplicant）激活。

<!--more-->

制卡工厂激活后，制卡工厂通知客房系统「卡已激活」（`SUPPLICANT_STATE_CHANGE_EVENT`），客房系统更新房态（`WifiInfo`）并广播「此房已入住」。

**你将学到**：

- `WifiServiceImpl.connect()` 的完整入口处理：权限检查、AttributionSource 校验、配置保存、SIM 卡认证准备
- `WifiConfiguration` 中 MAC 随机化相关字段（`macRandomizationSetting`、`mRandomizedMacAddress`）的连接前处理
- `ConnectHelper` `ConcreteClientModeManager` `ClientModeImpl` 的连接分发链路
- `ClientModeImpl` 状态机收到 `CMD_START_CONNECT` 和 `CMD_CONNECT_NETWORK` 后的完整代码级处理
- `WifiNative.connectToNetwork()` `SupplicantStaIfaceHal` `SupplicantStaIfaceHalAidlImpl` 的 AIDL 调用链路
- `SupplicantStaIfaceHalAidlImpl.connectToNetwork()` 的完整实现：removeAllNetworks addNetworkAndSaveConfig network.select()
- `handleSupplicantStateChange()` 如何将 supplicant 状态（AUTHENTICATING / ASSOCIATING / FOUR_WAY_HANDSHAKE）映射到 WifiInfo 和广播
- 手动连接 vs 自动连接的竞态处理：`WifiConnectivityManager` 与用户手动的互斥逻辑

**代码说明**：本文所有代码块来自 AOSP 真实源码（`packages_modules_Wifi`），有精简（去掉 log 语句和 license 头），关键路径保留完整。精简处标注 `// ...省略...`。文件路径标注在代码块首行。

**系列导航**：本篇是连接六部曲的第一篇，聚焦 Android Framework 层的 L2 连接下发路径——从用户点击到调用 supplicant AIDL 接口。后续篇章依次覆盖：supplicant 连接决策与 nl80211、驱动层连接执行、四次握手与密钥管理、安全协议与 MLO、连接后管理。

---

# 1 连接是怎么被触发的？—— 从用户点击到 Framework 入口

用户点击连接后，Settings App 通过 Binder 调用 `WifiServiceImpl.connect()`，Framework 先做权限和配置校验，再通过 `ConnectHelper` 分发到 `ClientModeImpl` 状态机。

## 1.1 全景架构：连接相关的四大模块

在深入代码之前，我们先看一张全景图——连接请求流经的 Framework 层四大模块及其职责。

![Framework 层连接模块架构图](assets/06a-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%B8%80%EF%BC%89Framework-%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E8%BF%87%E7%A8%8B/06a-architecture.svg)

四大模块的职责划分：

| 模块                        | 职责                                                         | 所在文件                         |
| --------------------------- | ------------------------------------------------------------ | -------------------------------- |
| `WifiServiceImpl`           | Binder 入口，权限检查，配置校验，防 MCC 清理                 | `WifiServiceImpl.java`           |
| `ConnectHelper`             | 连接分发：定位主 CMM（ClientModeManager），委托实际连接      | `ConnectHelper.java`             |
| `ConcreteClientModeManager` | WiFi 模式状态机（Idle Started ConnectMode），接口生命周期管理 | `ConcreteClientModeManager.java` |
| `ClientModeImpl`            | 连接状态机核心：`ConnectableState` `L2ConnectingState` `L2ConnectedState`，所有连接逻辑在此 | `ClientModeImpl.java`            |

`WifiServiceImpl` 不是直接调用 `ClientModeImpl` 的——中间经过了两层路由：`ConnectHelper`（找到正确的 CMM）+ `ConcreteClientModeManager`（CMM 内部状态机）。这个分层让 WiFi 系统支持**多 STA 接口并发**（主 STA + 副 STA 同时连接不同网络），每个 STA 有自己的 CMM 和 ClientModeImpl。

## 1.2 WifiServiceImpl.connect()：前台的第一道关卡

当 App 调用 `WifiManager.connect(config, listener)` 时，通过 Binder IPC 进入 `WifiServiceImpl.connect()`。这个 140+ 行的方法做了七层校验：

```java
// WifiServiceImpl.java — connect()（行 ~6957）
@Override
public void connect(WifiConfiguration config, int netId, @Nullable IActionListener callback,
        @NonNull String packageName, Bundle extras) {
    int uid = getMockableCallingUid();
    // 第一关：权限检查——仅系统 UID 或 NFC 进程允许
    if (!isPrivileged(Binder.getCallingPid(), uid)
            && UserHandle.getAppId(uid) != Process.NFC_UID) {
        throw new SecurityException(TAG + ": Permission denied");
    }
    // ...省略...
    // 第二关：AttributionSource 校验（Android 12+）
    if (SdkLevel.isAtLeastS() && UserHandle.getAppId(uid) == Process.SYSTEM_UID) {
        AttributionSource as = extras.getParcelable(
                WifiManager.EXTRA_PARAM_KEY_ATTRIBUTION_SOURCE);
        if (as == null) {
            throw new SecurityException("connect attributionSource is null");
        }
        if (!as.checkCallingUid()) {
            throw new SecurityException("connect invalid attribution source=" + as);
        }
        // 追踪 AttributionSource 链：每个节点都必须是 trusted（AOSP 源码逻辑）
        AttributionSource asIt = as;
        AttributionSource asLast = as;
        do {
            if (!asIt.isTrusted(mContext)) {
                throw new SecurityException("connect invalid (isTrusted fails)");
            }
            asIt = asIt.getNext();
            if (asIt != null) asLast = asIt;
        } while (asIt != null);
        // ...省略... 使用最后的 AttributionSource
    }
    // ── 以上为 Binder 线程内的权限与归因校验，以下切换到 WiFi 线程执行业务逻辑 ──

    // 第三关：切到 WiFi 线程执行
    mWifiThreadRunner.post(() -> {
        ActionListenerWrapper wrapper = new ActionListenerWrapper(callback);
        final NetworkUpdateResult result;
        if (config != null) {
            // 如果传入了 config，先保存/更新网络配置
            result = mWifiConfigManager.addOrUpdateNetwork(config, uid);
            if (!result.isSuccess()) {
                wrapper.sendFailure(WifiManager.ActionListener.FAILURE_INTERNAL_ERROR);
                return;
            }
        } else {
            // 否则用已有的 netId
            result = new NetworkUpdateResult(netId);
        }
        // ── 配置保存/获取完成，开始多关校验 ──

        WifiConfiguration configuration =
                mWifiConfigManager.getConfiguredNetwork(result.getNetworkId());
        // 第四关：配置有效性检查
        if (configuration == null) {
            wrapper.sendFailure(WifiManager.ActionListener.FAILURE_INTERNAL_ERROR);
            return;
        }
        if (mWifiPermissionsUtil.isAdminRestrictedNetwork(configuration)) {
            wrapper.sendFailure(WifiManager.ActionListener.FAILURE_INTERNAL_ERROR);
            return;
        }
        if (mWifiGlobals.isDeprecatedSecurityTypeNetwork(configuration)) {
            wrapper.sendFailure(WifiManager.ActionListener.FAILURE_INTERNAL_ERROR);
            return;
        }
        // 第五关：SIM 卡认证网络的特殊检查
        if (configuration.enterpriseConfig != null
                && configuration.enterpriseConfig.isAuthenticationSimBased()) {
            int subId = mWifiCarrierInfoManager.getBestMatchSubscriptionId(configuration);
            if (!mWifiCarrierInfoManager.isSimReady(subId)) {
                wrapper.sendFailure(WifiManager.ActionListener.FAILURE_INTERNAL_ERROR);
                return;
            }
            // IMSI 加密、Pseudonym 检查...省略...
        }
        // ── 多关校验通过，开始清理冲突接口并下发连接 ──
```

前半段的重点是**权限和配置**——调用者的身份是否合法、网络配置是否有效、SIM 卡是否就绪。每一个检查点都是 `SecurityException` 或 `FAILURE_INTERNAL_ERROR` 的早期退出，不浪费后续步骤的时间。

```java
        // 第六关：拆掉冲突的副 STA 接口（防 MCC —— Multi-Channel Concurrency）
        ScanResultMatchInfo targetMatchInfo =
                ScanResultMatchInfo.fromWifiConfiguration(configuration);
        for (ClientModeManager cmm : mActiveModeWarden.getClientModeManagers()) {
            if (!cmm.isConnected()) continue;
            ActiveModeManager.ClientRole role = cmm.getRole();
            if (role == ROLE_CLIENT_LOCAL_ONLY
                    || role == ROLE_CLIENT_SECONDARY_LONG_LIVED) {
                // 匹配逻辑：比较副 STA 当前连接与目标网络的 ScanResultMatchInfo
                // （SSID + security type），如果匹配（同一网络）或副 STA
                // 是 secondary internet，则停止该 CMM
                // ...省略匹配逻辑...
                cmm.stop();
            }
        }
        // ── 冲突清理完成，Make-Before-Break 收尾 → 正式发起连接 ──

        // 第七关：Make-Before-Break 的 transient CMM 清理
        mMakeBeforeBreakManager.stopAllSecondaryTransientClientModeManagers(
                () -> mConnectHelper.connectToNetwork(
                        result, wrapper, uidToUse, packageNameToUse,
                        attributionTagToUse));
    }, TAG + "#connect");
}
```

> **Make-Before-Break（MBB）**：WiFi 切换网络时，Android 先在新 CMM 上建立连接（Make），验证通过后才拆掉旧连接（Break）。切换期间存在两个临时 CMM——旧的主 CMM 和新创建的 `ROLE_CLIENT_SECONDARY_TRANSIENT` CMM。用户手动连接时调用 `stopAllSecondaryTransientClientModeManagers()` 清理这些过渡期残留的 transient CMM——如果上次 MBB 切换未正常完成（如新网络验证失败），transient CMM 没被清理，不先清掉会阻塞本次连接。

**做完七关校验，到了最后一步**：`mMakeBeforeBreakManager.stopAllSecondaryTransientClientModeManagers()` 接收一个回调 `onStoppedListener`——当所有 transient CMM 停止后，回调触发 `ConnectHelper.connectToNetwork()`，将连接请求正式送入分发链路。

主要功能：

- **权限校验链条**：`isPrivileged()` 检查调用者是否为系统级进程，Android 12+ 还要走 AttributionSource 信任链——Android 的隐私归因机制要求调用链上的每个节点都必须是 trusted 系统组件，防止中间人伪造调用者身份。代码中的 `do...while` 循环遍历整条链，任一节点 `isTrusted()` 返回 false 就抛 `SecurityException`
- **配置多关检查**：Admin 限制、安全类型废弃、SIM 卡就绪、IMSI 加密可用、Pseudonym 有效性——任一不过就立即失败
- **防 MCC**：用户手动连接前，拆掉已连接的副 STA 和 secondary internet CMM，确保用户的连接优先于多路复用场景
- **入口统一切线程**：`mWifiThreadRunner.post()` 将所有后续操作切换到 WiFi 专用线程，避免多线程竞争

WifiServiceImpl.connect() 是酒店前台——先看身份证（权限）、查房态（配置存在且有效）、确认是协议签约房还是临时房（SIM 认证检查）、再清掉重复预订（拆副 STA），最后交给前台经理（ConnectHelper）安排入住。

**`ConnectHelper` 收到请求后，做了两件事**：先通过 `WifiConfigManager.updateBeforeConnect()` 启用网络并设置「最后选择网络」标记（详见第6节），然后找到主 CMM（`ConcreteClientModeManager`），调用 `cmm.connectNetwork()`。`ConcreteClientModeManager` 向 `ClientModeImpl` 发送 `CMD_CONNECT_NETWORK` 消息。状态机在处理这个消息时，走 `connectToUserSelectNetwork()` → `startConnectToNetwork()` → `sendMessage(CMD_START_CONNECT)`。**`CMD_START_CONNECT` 是所有连接的统一入口**——它的处理链路中，第一步就是调用 `updateWifiConfigOnStartConnection()` 准备 MAC 地址（MAC 地址决策的完整逻辑稍后在 2.2 节中展开分析），然后是一系列前置检查，最后调用 `connectToNetwork()` 跨越 Java/Native 边界。

`ConnectHelper` 的连接分发逻辑非常精简，核心只有两个重载方法：

```java
// ConnectHelper.java — connectToNetwork()（两个重载）
// 重载 1：入口——从 WifiServiceImpl 调用，自动获取主 CMM
public void connectToNetwork(@NonNull NetworkUpdateResult result,
        @NonNull ActionListenerWrapper wrapper,
        int callingUid, @NonNull String packageName, @Nullable String attributionTag) {
    connectToNetwork(mActiveModeWarden.getPrimaryClientModeManager(),
            result, wrapper, callingUid, packageName, attributionTag);
}

// 重载 2：实际执行——接收指定的 ClientModeManager
public void connectToNetwork(@NonNull ClientModeManager clientModeManager,
        @NonNull NetworkUpdateResult result,
        @NonNull ActionListenerWrapper wrapper,
        int callingUid, @NonNull String packageName, @Nullable String attributionTag) {
    int netId = result.getNetworkId();
    // null check：网络配置不存在则立即失败
    if (mWifiConfigManager.getConfiguredNetwork(netId) == null) {
        wrapper.sendFailure(WifiManager.ActionListener.FAILURE_INTERNAL_ERROR);
        return;
    }
    // 启用网络并设置最后选择标记（标记用户显式选择）
    mWifiConfigManager.updateBeforeConnect(netId, callingUid, packageName,
            !ClientModeImpl.ATTRIBUTION_TAG_DISALLOW_CONNECT_CHOICE.equals(attributionTag));
    // 委托给 CMM 执行实际连接
    clientModeManager.connectNetwork(result, wrapper, callingUid, packageName, attributionTag);
}
```

要点：

- **双重载设计**：重载 1 是给 `WifiServiceImpl` 的简洁入口（自动拿主 CMM），重载 2 是给 `WifiNetworkFactory` 等需要指定特定 CMM 的调用方使用——这正是多 STA 接口并发架构的体现
- **null check**：在 `updateBeforeConnect` 之前先检查网络配置是否存在，不存在则立即失败回调，不浪费后续操作
- **delegate 模式**：`ConnectHelper` 本身不执行连接逻辑——它只做路由（找 CMM）和前置准备（启用网络 + 最后选择标记），实际连接委托给 `ClientModeManager`

---

# 2 CMD_START_CONNECT 消息到达后，状态机做了什么？

`ClientModeImpl` 是一个分层状态机，连接请求在 `ConnectableState` 中被处理，成功启动后转移到 `L2ConnectingState`，等待 supplicant 的 L2 完成回调。

## 2.1 状态机全景

`ClientModeImpl` 的连接相关状态层次（注意缩进表示父子关系）：

```
ConnectableState（顶层）
  ├── ConnectingOrConnectedState
  │     ├── L2ConnectingState          ← CMD_START_CONNECT 成功后进入
  │     └── L2ConnectedState
  │           ├── WaitBeforeL3ProvisioningState
  │           ├── L3ProvisioningState
  │           ├── L3ConnectedState
  │           └── RoamingState
  └── DisconnectedState                ← 空闲/连接失败后进入
```

![ClientModeImpl 连接状态机图](assets/06a-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%B8%80%EF%BC%89Framework-%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E8%BF%87%E7%A8%8B/06a-state-machine.svg)

`ConnectableState` 是**父状态**——所有连接命令（`CMD_START_CONNECT`、`CMD_CONNECT_NETWORK`、`CMD_RECONNECT`）都在这里被处理，没被子状态处理的消息会冒泡到父状态。`DisconnectedState` 不处理 `CMD_START_CONNECT`（返回 `NOT_HANDLED`），让 `ConnectableState` 来处理。

## 2.2 ConnectableState 处理 CMD_START_CONNECT

这是连接启动的**真正核心**——包含 80+ 行代码的完整处理逻辑：

```java
// ClientModeImpl.java — ConnectableState.processMessageImpl()（行 ~4738）
case CMD_START_CONNECT: {
    if (mIpClient == null) {
        logd("IpClient is not ready, START_CONNECT dropped");
        break;
    }
    int netId = message.arg1;
    int uid = message.arg2;
    String bssid = (String) message.obj;
    // ═══ 第一阶段：退出 lingering 模式 ═══
    mSentHLPs = false;
    // 停止 lingering 模式：CMM 被复用，不再需要 linger
    mClientModeManager.setShouldReduceNetworkScore(false);

    // ═══ 第二阶段：权限与请求检查 ═══
    // 检查是否有活跃的网络请求
    if (!hasConnectionRequests()) {
        if (mNetworkAgent == null) {
            loge("CMD_START_CONNECT but no requests and not connected, bailing");
            break;
        } else if (!mWifiPermissionsUtil.checkNetworkSettingsPermission(uid)) {
            loge("CMD_START_CONNECT but no requests and connected, but app "
                    + "does not have sufficient permissions, bailing");
            break;
        }
    }
    // ═══ 第三阶段：获取并验证配置 ═══
    // 获取网络配置（不遮罩密码和 MAC——内部使用）
    WifiConfiguration config =
            mWifiConfigManager.getConfiguredNetworkWithoutMasking(netId);
    logd("CMD_START_CONNECT my state " + getCurrentState().getName()
            + " nid=" + netId + " roam=" + mIsAutoRoaming);
    if (config == null) {
        loge("CMD_START_CONNECT and no config, bail out...");
        break;
    }
    // ═══ 第四阶段：状态重置、打点、MAC 准备 ═══
    // 重置连接状态标记
    mCurrentConnectionDetectedCaptivePortal = false;
    mCurrentConnectionReportedCertificateExpired = false;
    mTargetNetworkId = netId;
    // 更新 ScoreCard
    mWifiScoreCard.noteConnectionAttempt(mWifiInfo, mLastScanRssi, config.SSID);
    // Blocklist 管理（主 CMM）
    if (isPrimary()) {
        mWifiBlocklistMonitor.setAllowlistSsids(config.SSID, Collections.emptyList());
        mWifiBlocklistMonitor.updateFirmwareRoamingConfiguration(Set.of(config.SSID));
    }
    // 更新配置到连接前状态
    updateWifiConfigOnStartConnection(config, bssid);
    reportConnectionAttemptStart(config, mTargetBssid,
            WifiMetricsProto.ConnectionEvent.ROAM_UNRELATED, uid);
    // 记录当前 MAC 地址
    String currentMacAddress = mWifiNative.getMacAddress(mInterfaceName);
    mWifiInfo.setMacAddress(currentMacAddress);
    // ═══ 第五阶段：特殊路径与最终执行 ═══
    // FILS 快速重连路径：提前启动 IpClient
    // FILS = Fast Initial Link Setup (802.11ai)，减少认证帧交换轮数，实现 <100ms 连接
    if (config.isFilsSha256Enabled() || config.isFilsSha384Enabled()) {
        boolean isIpClientStarted = startIpClient(config, true);
        if (isIpClientStarted) {
            mIpClientWithPreConnection = true;
            transitionTo(mL2ConnectingState);
            break;
        }
    }
    // Passpoint RCOI 设置
    setSelectedRcoiForPasspoint(config);
    // EAP 不安全网络处理（TOFU，Trust On First Use——首次使用信任）流程
    mInsecureEapNetworkHandler.prepareConnection(mTargetWifiConfiguration);
    mLeafCertSent = false;
    if (!isTrustOnFirstUseSupported()) {
        mInsecureEapNetworkHandler.startUserApprovalIfNecessary(mIsUserSelected);
    }
    mFrameworkDisconnectReasonOverride = 0;
    // 核心：调用 connectToNetwork() 发起实际连接
    connectToNetwork(config);
    break;
}
```

主要功能：

- **前条件检查**：IpClient 就绪、有 NetworkAgent 或有 NetworkSettings 权限、config 存在——三道前检查任一不过就静默丢弃
- **退出 lingering**：`setShouldReduceNetworkScore(false)` 停止「逗留模式」——CMM 在没有活跃用户时会进入 lingering 状态（保持连接但降低网络分数），是一个「随时准备断开」的过渡期。新连接请求复用该 CMM 时，退出 lingering，恢复完整功能
- **状态重置**：清除上次连接的临时状态（captive portal、certificate expired、HlpSent 等）
- **Metrics 和 ScoreCard**：在旧连接的上下文中记录尝试，便于统计切换质量
- **FILS 快速路径**：如果配置支持 FILS SHA256/384，提前启动 IpClient 做 Pre-Association（Hlp 帧交换），直接跳入 `L2ConnectingState`
- **实际执行**：最后调用 `connectToNetwork(config)` 进入 HAL/native 层

#### MAC 随机化与参数锁定

看到上面第 281 行的 `updateWifiConfigOnStartConnection(config, bssid)` 了吗？这是连接前最关键的一步——决定使用什么 MAC 地址连接这个网络。是工厂 MAC 还是随机 MAC？持久随机还是每次连接都换？

#### WifiConfiguration 的 MAC 随机化体系

`WifiConfiguration` 中与 MAC 地址相关的核心字段：

```java
// WifiConfiguration.java — MacRandomizationSetting
@IntDef(prefix = {"RANDOMIZATION_"}, value = {
        RANDOMIZATION_NONE,          // 使用工厂 MAC（出厂烧录的）
        RANDOMIZATION_PERSISTENT,    // 持久随机：每个 SSID 固定生成一个随机 MAC，重连复用
        RANDOMIZATION_NON_PERSISTENT,// 非持久随机：每次连接都重新随机（按 DHCP lease 刷新）
        RANDOMIZATION_AUTO})         // 自动：系统根据网络类型决定策略
public @interface MacRandomizationSetting {}

// 存储实际使用的随机 MAC 地址
private MacAddress mRandomizedMacAddress; // 初始值 = 02:00:00:00:00:00 (DEFAULT)
```

四种策略的含义：

| 策略                           | 行为                                                         | 适用场景                                      |
| ------------------------------ | ------------------------------------------------------------ | --------------------------------------------- |
| `RANDOMIZATION_NONE`           | 使用设备出厂 MAC 地址，不做任何随机化                        | 管理员配置的受信网络、需要 MAC 认证的企业网络 |
| `RANDOMIZATION_PERSISTENT`     | 用 HMAC-SHA256(wifi_config_key) 生成永久随机 MAC，**同一 SSID 永远用同一个 MAC** | 大多数家庭/办公网络（默认行为）               |
| `RANDOMIZATION_NON_PERSISTENT` | 每次连接重新生成随机 MAC，按 DHCP lease 时间刷新             | 公共热点、临时网络                            |
| `RANDOMIZATION_AUTO`           | 系统自动决定——优先 PERSISTENT，隐私敏感场景可能用 NON_PERSISTENT | 用户未手动设置时的默认                        |

#### 连接前的 MAC 地址决策

`updateWifiConfigOnStartConnection()` 内部通过 `WifiConfigManager.getRandomizedMacAndUpdateIfNeeded()` 决定本次连接使用的 MAC 地址：

```java
// WifiConfigManager.java — getRandomizedMacAndUpdateIfNeeded()
public MacAddress getRandomizedMacAndUpdateIfNeeded(WifiConfiguration config,
        boolean isForSecondaryDbs) {
    MacAddress mac = shouldUseNonPersistentRandomization(config)
            ? updateRandomizedMacIfNeeded(config)    // 非持久：每次都重新随机
            : setRandomizedMacToPersistentMac(config); // 持久：生成/取缓存的固定 MAC
    // 副 STA 用于 DBS (Dual Band Simultaneous)：在主 MAC 基础上 +1
    if (isForSecondaryDbs) {
        mac = MacAddressUtil.nextMacAddress(mac);
    }
    return mac;
}

// 持久随机 MAC 的生成
private MacAddress setRandomizedMacToPersistentMac(WifiConfiguration config) {
    MacAddress persistentMac = getPersistentMacAddress(config); // 从存储或 HMAC 计算
    if (persistentMac == null || persistentMac.equals(config.getRandomizedMacAddress())) {
        return persistentMac;
    }
    WifiConfiguration internalConfig = getInternalConfiguredNetwork(config.networkId);
    setRandomizedMacAddress(internalConfig, persistentMac); // 写入 config.mRandomizedMacAddress
    return persistentMac;
}

// 持久 MAC 来源：优先读存储，其次 HMAC-SHA256 计算，兜底随机生成
public MacAddress getPersistentMacAddress(WifiConfiguration config) {
    String persistentMacString = mRandomizedMacAddressMapping.get(config.getNetworkKey());
    if (persistentMacString != null) {
        return MacAddress.fromString(persistentMacString); // 已缓存
    }
    MacAddress result = mMacAddressUtil.calculatePersistentMacForSta(
            config.getNetworkKey(), Process.WIFI_UID);      // KeyStore + HMAC-SHA256
    if (result == null) {
        result = config.getRandomizedMacAddress();
        if (DEFAULT_MAC_ADDRESS.equals(result)) {
            result = MacAddressUtils.createRandomUnicastAddress(); // 兜底
        }
    }
    return result;
}
```

主要功能：

- **持久 MAC 算法**：`HMAC-SHA256(网络 key, WIFI_UID)` 通过 Android KeyStore 执行，保证同一设备上同一 SSID 始终得到相同 MAC
- **非持久 MAC**：按 DHCP lease 时长或最大刷新间隔（`NON_PERSISTENT_MAC_REFRESH_MS_MAX`）自动重新随机
- **DBS 特殊处理**：主/副 STA 连同一 SSID 时，副 STA 的 MAC = 主 MAC + 1，避免 MAC 冲突

MAC 地址选择就像**入住时的身份登记方式**。工厂 MAC = 用身份证原件登记（真实身份始终不变）；持久随机 MAC = 用会员卡号登记（每个酒店生成一个固定的会员号，重住不变）；非持久随机 MAC = 用一次性房卡号登记（每次入住都不同）。

以上是连接前的 MAC 准备。回到 `CMD_START_CONNECT` 的处理流程——MAC 地址准备好后，`CMD_START_CONNECT` 的处理链路继续往下，做完其余检查后最后调用 `connectToNetwork()` 发起实际连接。接下来看这个关键方法如何跨越 Java/Native 边界。

## 2.3 connectToNetwork()：状态机与 Native 层的分界线

```java
// ClientModeImpl.java — connectToNetwork()
private void connectToNetwork(WifiConfiguration config) {
    if ((config != null) && mWifiNative.connectToNetwork(mInterfaceName, config)) {
        // 连接请求被 supplicant 接受后，更新内部配置
        mWifiConfigManager.setNetworkLastUsedSecurityParams(config.networkId,
                config.getNetworkSelectionStatus().getCandidateSecurityParams());
        mWifiLastResortWatchdog.noteStartConnectTime(config.networkId);
        mWifiMetrics.logStaEvent(mInterfaceName, StaEvent.TYPE_CMD_START_CONNECT, config);
        mIsAutoRoaming = false;
        // 状态机跳转：进入 L2ConnectingState
        transitionTo(mL2ConnectingState);
    } else {
        loge("CMD_START_CONNECT Failed to start connection to network " + config);
        mTargetWifiConfiguration = null;
        stopIpClient();
        reportConnectionAttemptEnd(
                WifiMetrics.ConnectionEvent.FAILURE_CONNECT_NETWORK_FAILED,
                WifiMetricsProto.ConnectionEvent.HLF_NONE,
                WifiMetricsProto.ConnectionEvent.FAILURE_REASON_UNKNOWN, 0);
    }
}
```

主要功能：

- **关键分水岭**：这一行 `mWifiNative.connectToNetwork()` 是 **Java 世界到 Native/AIDL 世界的分界线**——返回 `true` 表示 supplicant 接受了配置，状态机开始等待 L2 完成
- **成功路径**：记录安全参数、启动 Watchdog 计时、打点 `TYPE_CMD_START_CONNECT`、进入 `L2ConnectingState`
- **失败路径**：清空 target config、停掉 IpClient、上报失败 metrics——不会进入任何等待状态

## 2.4 CMD_CONNECT_NETWORK：用户手动连接的独立路径

除了 `CMD_START_CONNECT`（自动连接和 Settings 触发），还有一个 `CMD_CONNECT_NETWORK` 专门处理**用户从 Quick Settings 或 Notification 手动触发**的连接：

```java
// ClientModeImpl.java — ConnectableState
case CMD_CONNECT_NETWORK: {
    ConnectNetworkMessage cnm = (ConnectNetworkMessage) message.obj;
    if (mIpClient == null) {
        cnm.listener.sendFailure(WifiManager.ActionListener.FAILURE_INTERNAL_ERROR);
        break;
    }
    NetworkUpdateResult result = cnm.result;
    int netId = result.getNetworkId();
    connectToUserSelectNetwork(
            netId, message.sendingUid, result.hasCredentialChanged(),
            cnm.packageName, cnm.attributionTag);
    mWifiMetrics.logStaEvent(mInterfaceName, StaEvent.TYPE_CONNECT_NETWORK,
            mWifiConfigManager.getConfiguredNetwork(netId));
    cnm.listener.sendSuccess();
    break;
}
```

`CMD_CONNECT_NETWORK` 和 `CMD_START_CONNECT` 的关键区别：

| 维度             | CMD_START_CONNECT                              | CMD_CONNECT_NETWORK                                          |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| 触发来源         | WifiConnectivityManager（自动）/ Settings 连接 | 用户 Quick Settings 点击 / Notification                      |
| 配置来源         | 已有的 `mTargetNetworkId`                      | 调用方传入的 `NetworkUpdateResult`                           |
| 回调方式         | 无直接 listener（通过广播通知）                | 带 `ActionListenerWrapper` 立即回调成功/失败                 |
| 最后选择网络标记 | 不设置                                         | `connectToUserSelectNetwork()` 会调用 `updateBeforeConnect()` 启用网络并设置「最后选择网络」标记，让这个网络在 30 秒内锁定不能切换 |
| 打点             | `StaEvent.TYPE_CMD_START_CONNECT`              | `StaEvent.TYPE_CONNECT_NETWORK`                              |

`CMD_START_CONNECT` 是酒店的**自动排房系统**——WifiConnectivityManager 根据扫描结果自动选择一个最优 AP 入住。`CMD_CONNECT_NETWORK` 是**客人指定房号**——这个客人点名要住某个特定房间，前台给他锁定这个房间（最后选择网络标记），30 秒内不给别人。

---

# 3 Java 到 AIDL 的跨越：WifiNative 怎么把请求递给 HAL？

`WifiNative.connectToNetwork()` 只做两件事——中止正在进行的扫描（避免阻塞连接），然后无条件委托给 `SupplicantStaIfaceHal`。

## 3.1 WifiNative.connectToNetwork()

上一节中，`ClientModeImpl.connectToNetwork()` 的最后一步是调用 `mWifiNative.connectToNetwork(mInterfaceName, config)`。这个方法是 Java 世界到 Native/AIDL 世界的分界线——但跨越之前，它先做了一个容易被忽略但关键的操作：

```java
// WifiNative.java — connectToNetwork()（行 ~3063）
public boolean connectToNetwork(@NonNull String ifaceName, WifiConfiguration configuration) {
    // 第一步：中止正在进行的扫描——扫描占用 radio，会阻塞连接
    mWifiCondManager.abortScan(ifaceName);
    // 第二步：委托给 SupplicantStaIfaceHal
    return mSupplicantStaIfaceHal.connectToNetwork(ifaceName, configuration);
}
```

这个方法的逻辑极其简洁——但它做了一个容易被忽略但非常关键的操作：**先 abort scan，再 connect**。WiFi radio 在同一时刻只能做扫描或连接中的一件事（单 radio 限制），如果不先停掉扫描，supplicant 的 radio work 队列会让连接请求排队等待扫描完成——用户感知到的就是"点了连接等了很久才开始"。

> `mWifiCondManager` 是 `WifiNl80211Manager` 类型的变量（`WifiNative.java` 中的字段名），Android 重构后保留了旧变量名。搜索源码时用类名 `WifiNl80211Manager` 而非 `mWifiCondManager`。

## 3.2 SupplicantStaIfaceHal：HAL 抽象层的转发

```java
// SupplicantStaIfaceHal.java — connectToNetwork()
public boolean connectToNetwork(@NonNull String ifaceName, @NonNull WifiConfiguration config) {
    synchronized (mLock) {
        String methodStr = "connectToNetwork";
        if (mStaIfaceHal == null) {
            return handleNullHal(methodStr); // HAL 未初始化时返回 false
        }
        return mStaIfaceHal.connectToNetwork(ifaceName, config);
    }
}
```

`SupplicantStaIfaceHal` 是一个**抽象层**——它不直接与 AIDL 交互，而是持有一个 `mStaIfaceHal` 引用（可以是 AIDL 或 HIDL 实现），在 Android T+ 上这个引用指向 `SupplicantStaIfaceHalAidlImpl`。这个设计让 WiFi Framework 可以在不修改上层代码的情况下切换 HAL 传输机制（AIDL vs HIDL）。

**AIDL vs HIDL 实现对比**：

| 特性     | AIDL 实现 (Android 13+)                 | HIDL 实现 (Android 12-)         |
| -------- | --------------------------------------- | ------------------------------- |
| 绑定方式 | `ServiceManager.waitForDeclaredService` | `hwservicemanager.getTransport` |
| 接口定义 | `.aidl` 文件                            | `.hal` 文件                     |
| 默认使用 | Android 13+ (T)                         | Android 12- (S 及之前)          |
| 实现类   | `SupplicantStaIfaceHalAidlImpl`         | `SupplicantStaIfaceHalHidlImpl` |
| 接口前缀 | `ISupplicantStaIface` (AIDL)            | `ISupplicantStaIface` (HIDL)    |

**调用层级统计**：

| 层级      | 组件                                               | 职责                                                         |
| --------- | -------------------------------------------------- | ------------------------------------------------------------ |
| 入口      | `WifiNative.connectToNetwork()`                    | 停扫描（`abortScan`）→ 委托 HAL                              |
| HAL 抽象  | `SupplicantStaIfaceHal.connectToNetwork()`         | 线程安全锁 + 空指针保护，转发到 AIDL 实现                    |
| AIDL 实现 | `SupplicantStaIfaceHalAidlImpl.connectToNetwork()` | 网络重建/增量更新 → `saveWifiConfiguration()` → `networkHandle.select()` |

**HIDL 路径**（Android 12-）：HIDL 实现（`SupplicantStaIfaceHalHidlImpl`）的入口结构完全相同——`connectToNetwork()` 同样是公共方法直接委托私有三分支重载（同一网络同 BSSID / 同一网络不同 BSSID / 不同网络全量重建），同样有 SSID fallback 和 PMK 缓存注入，最后同样调用 `select()`。上下层完全不感知 AIDL/HIDL 差异——这正是 `SupplicantStaIfaceHal` 抽象层的设计目的。因此以下只展示 AIDL 路径。

`WifiNative` 是门锁系统的控制面板——它先确认无线信道空闲（`abortScan`），再通过内部线路接通制卡部门。`SupplicantStaIfaceHal` 是制卡部门的调度台——同一时间只处理一位客人的制卡请求（`synchronized (mLock)`），通过 AIDL 把指令发给具体的制卡机。

---

# 4 SupplicantStaIfaceHalAidlImpl：网络配置怎么下发给 supplicant？

`SupplicantStaIfaceHalAidlImpl.connectToNetwork()` 是整个 Framework 层连接下发链路的**最后一站**——它判断是否需要重建 supplicant 网络、写入完整配置、选择网络、返回成功。代码到此为止，不进入 supplicant 内部。

## 4.1 connectToNetwork() 的完整实现

这是全篇最核心的代码——Framework 层连接下发的最终执行逻辑：

```java
// SupplicantStaIfaceHalAidlImpl.java — connectToNetwork()
private boolean connectToNetwork(@NonNull String ifaceName, @NonNull WifiConfiguration config,
        WifiSsid actualSsid) {
    synchronized (mLock) {
        WifiConfiguration currentConfig = getCurrentNetworkLocalConfig(ifaceName);
        // ═══ 分支判断：同一网络 vs 不同网络 ═══
        // 判断一：是否同一个网络？只需更新 BSSID 还是重建？
        if (actualSsid == null && WifiConfigurationUtil.isSameNetwork(config, currentConfig)) {
            String networkSelectionBSSID = config.getNetworkSelectionStatus()
                    .getNetworkSelectionBSSID();
            String networkSelectionBSSIDCurrent = currentConfig.getNetworkSelectionStatus()
                    .getNetworkSelectionBSSID();
            if (Objects.equals(networkSelectionBSSID, networkSelectionBSSIDCurrent)) {
                // ── 分支1/3：同一网络 + 相同 BSSID → 无需任何操作 ──
                Log.d(TAG, "Network is already saved, will not trigger remove and add.");
            } else {
                // ── 分支2/3：同一网络 + 不同 BSSID → 仅更新 BSSID ──
                if (!setCurrentNetworkBssid(ifaceName,
                        config.getNetworkSelectionStatus().getNetworkSelectionBSSID())) {
                    return false;
                }
                mCurrentNetworkLocalConfigs.put(ifaceName, new WifiConfiguration(config));
            }
        } else {
```

这三个分支的设计意图是**增量更新 vs 全量重建的权衡**：分支 1/3 和 2/3 走「增量」路径——同一个网络只更新 BSSID，零开销、无中断。分支 3/3 走「全量重建」路径——不同网络先批量删除旧配置再写入新配置，避免 supplicant 内部网络 ID 耗尽，代价是无法做无缝切换。

```java
            // ── 分支3/3：不同网络 → 全量重建（删旧 + 建新 + SSID翻译 + Fallback）──
            mCurrentNetworkRemoteHandles.remove(ifaceName);
            mCurrentNetworkLocalConfigs.remove(ifaceName);
            mLinkedNetworkLocalAndRemoteConfigs.remove(ifaceName);
            if (!removeAllNetworks(ifaceName)) {
                Log.e(TAG, "Failed to remove existing networks");
                return false;
            }
            WifiConfiguration supplicantConfig = new WifiConfiguration(config);
            // SSID 翻译处理：多语言 SSID 需要尝试不同的编码
            if (actualSsid != null) {
                supplicantConfig.SSID = actualSsid.toString();
            } else {
                mCurrentNetworkFallbackSsids.remove(ifaceName);
                WifiSsid configSsid = WifiSsid.fromString(config.SSID);
                WifiSsid supplicantSsid = mSsidTranslator.getOriginalSsid(config);
                if (supplicantSsid != null) {
                    supplicantConfig.SSID = supplicantSsid.toString();
                    // 保存备选 SSID 列表（用于 NETWORK_NOT_FOUND 回退）
                    List<WifiSsid> fallbackSsids = mSsidTranslator
                            .getAllPossibleOriginalSsids(configSsid);
                    fallbackSsids.remove(supplicantSsid);
                    if (!fallbackSsids.isEmpty()) {
                        fallbackSsids.add(0, supplicantSsid);
                        mCurrentNetworkFallbackSsids.put(ifaceName, fallbackSsids);
                        mCurrentNetworkFallbackSsidIndex.put(ifaceName, 0);
                    }
                }
            }
            // 添加网络 + 保存配置
            Pair<SupplicantStaNetworkHalAidlImpl, WifiConfiguration> pair =
                    addNetworkAndSaveConfig(ifaceName, supplicantConfig);
            if (pair == null) {
                return false;
            }
            mCurrentNetworkRemoteHandles.put(ifaceName, pair.first);
            mCurrentNetworkLocalConfigs.put(ifaceName, pair.second);
        }
        // ═══ 分支处理完成，以下是统一后续：获取句柄 → PMK缓存注入 → select() ═══

        // 获取网络句柄
        SupplicantStaNetworkHalAidlImpl networkHandle =
                checkStaNetworkAndLogFailure(ifaceName, "connectToNetwork");
        if (networkHandle == null) {
            return false;
        }
        // PMK 缓存注入（非 PSK/DPP 网络，DPP 即 Device Provisioning Protocol——Wi-Fi Easy Connect）
        SecurityParams params = config.getNetworkSelectionStatus()
                .getCandidateSecurityParams();
        if (params != null && !(params.isSecurityType(WifiConfiguration.SECURITY_TYPE_PSK)
                || params.isSecurityType(WifiConfiguration.SECURITY_TYPE_DPP))) {
            List<ArrayList<Byte>> pmkDataList = mPmkCacheManager.get(config.networkId);
            if (pmkDataList != null) {
                pmkDataList.forEach(pmkData -> {
                    if (networkHandle.setPmkCache(NativeUtil.byteArrayFromArrayList(pmkData))) {
                        mWifiMetrics.setConnectionPmkCache(ifaceName, true);
                    }
                });
            }
        }
        // 选择网络：这条 AIDL 调用触发 supplicant 真正开始连接
        if (!networkHandle.select()) {
            Log.e(TAG, "Failed to select network configuration: " + config.getProfileKey());
            return false;
        }
        // 记录连接时间戳
        mCurrentNetworkConnectTimestamp.put(ifaceName, mClock.getElapsedSinceBootMillis());
        return true;
    }
}
```

主要功能：

- **增量更新 vs 全量重建**：如果连接的是同一个网络（按 profile key 和 security params 比较），只更新 BSSID；否则删除所有旧网络后重建——wpa_supplicant 内部网络 ID 有限，不删旧的可能耗尽
- **SSID 多编码回退**：`SsidTranslator` 处理同一 SSID 的多种字节编码（UTF-8/ISO-8859-1），选择一个发下去，备选作为 fallback——如果 supplicant 返回 `NETWORK_NOT_FOUND`，Framework 会切换到备选 SSID 重试
- **PMK 缓存注入**：对于 EAP 网络，Framework 维护一个 PMK（Pairwise Master Key）缓存。连接时把缓存的 PMK 注入 supplicant，如果 PMK 还没过期，可以跳过完整的 EAP 认证，直接进入四次握手——显著加快重连速度
- **`networkHandle.select()`**：这是整个 Framework 层连接链路的**终点**——它会通过 AIDL 调用 `ISupplicantStaNetwork.select()`，触发 wpa_supplicant 内部开始 Authentication -> Association -> 4-Way Handshake 的完整 L2 连接序列

## 4.2 saveWifiConfiguration()：150+ 行的参数写入

`addNetworkAndSaveConfig()` 内部的 `saveWifiConfiguration()`（定义在 `SupplicantStaNetworkHalAidlImpl`）负责把 `WifiConfiguration` 的每一个字段映射到 supplicant 的 AIDL 接口。这个过程有 150+ 行，涉及 20+ 个 AIDL 调用：

```java
// SupplicantStaNetworkHalAidlImpl.java — saveWifiConfiguration() （精简版）
public boolean saveWifiConfiguration(WifiConfiguration config) throws IllegalArgumentException {
    // EHT (WiFi 7) 开关
    if (!config.isWifi7Enabled() && isServiceVersionIsAtLeast(3)) {
        if (!disableEht()) return false;
    }
    // SSID
    if (config.SSID != null) {
        if (!setSsid(WifiSsid.fromString(config.SSID).getBytes())) return false;
    }
    // BSSID
    String bssidStr = config.getNetworkSelectionStatus().getNetworkSelectionBSSID();
    if (bssidStr != null) {
        if (!setBssid(NativeUtil.macAddressToByteArray(bssidStr))) return false;
    }
    // Hidden SSID + Require PMF
    if (!setScanSsid(config.hiddenSSID)) return false;
    if (!setRequirePmf(isRequirePmf)) return false;
    // Key Management (WPA-PSK, SAE, FT, SHA256...)
    BitSet allowedKeyManagement = securityParams.getAllowedKeyManagement();
    allowedKeyManagement = addPskSaeUpgradableTypeFlagsIfSupported(config, allowedKeyManagement);
    allowedKeyManagement = addFastTransitionFlags(allowedKeyManagement);
    allowedKeyManagement = addSha256KeyMgmtFlags(allowedKeyManagement);
    if (!setKeyMgmt(wifiConfigurationToSupplicantKeyMgmtMask(allowedKeyManagement))) return false;
    // Security Protocol + Auth Algorithm + Ciphers
    if (!setProto(...) || !setAuthAlg(...) || !setGroupCipher(...) || !setPairwiseCipher(...))
        return false;
    // Pre-Shared Key / SAE Password
    if (config.preSharedKey != null) {
        if (config.preSharedKey.startsWith("\"")) {
            // 带引号 -> ASCII passphrase
            if (allowedKeyManagement.get(KeyMgmt.SAE)) setSaePassword(removeQuotes(...));
            if (allowedKeyManagement.get(KeyMgmt.WPA_PSK)) setPskPassphrase(removeQuotes(...));
        } else {
            // 不带引号 -> 原始 hex PSK
            setPsk(NativeUtil.hexStringToByteArray(config.preSharedKey));
        }
    }
    // WEP Keys, metadata (FQDN, ConfigKey, CreatorUid), UpdateIdentifier
    // SAE H2E preference, Vendor data...省略...
    // EAP enterprise configuration
    if (config.enterpriseConfig != null
            && config.enterpriseConfig.getEapMethod() != Eap.NONE) {
        // EAP method, identity, password, CA cert, client cert, phase2...
        // ...省略约 60 行 ...
    }
    // 注册回调监听
    return registerNewCallback(config.networkId, config.SSID);
}
```

主要功能：

- **KeyMgmt 自动扩展**：如果网络同时配置了 PSK 和 SAE（Simultaneous Authentication of Equals，WPA3 的认证协议），Framework 会自动添加 upgradable type flag，让 supplicant 优先尝试 SAE，SAE 不可用时回退 PSK
- **Fast Transition (802.11r) 自动添加**：如果设备支持 FT，PSK 和 EAP 的 key management 会自动扩展出 FT-PSK 和 FT-EAP 变体
- **SAE H2E 模式控制**：SAE 使用 H2E（Hash-to-Element，哈希到椭圆曲线元素，抗侧信道攻击的 SAE 变体）机制。根据设备能力和用户配置，设置 `H2E_OPTIONAL`（默认：优先 H2E，不可用时降级）

如果你只想了解连接下发的大致过程，可以略过 `saveWifiConfiguration()` 的逐字段细节。核心要点是：Framework 在这里完成从 `WifiConfiguration` Java 对象到 wpa_supplicant 网络参数的**完整翻译**，每个字段都有对应的一条 AIDL setter。

`SupplicantStaIfaceHalAidlImpl` 就是制卡机本身——它判断客人是否已有旧卡（同一网络），如果有就只更新房号（BSSID），如果没有就删掉旧卡重新制作（`removeAllNetworks` + `addNetworkAndSaveConfig`）。PMK 缓存注入相当于「会员快速通道」——老客户的认证信息被提前写入，跳过前台排队直接进入四次握手。最后 `networkHandle.select()` 是制卡机按下「激活」键——卡已制作完毕，客人刷卡即可开门。

---

# 5 状态回调：SupplicantState 怎么从 supplicant 回传到 Framework？

supplicant 的 `ISupplicantStaIfaceCallback.onStateChanged()` 通过 AIDL 回调通知 Framework 状态变化，Framework 的 `handleSupplicantStateChange()` 更新 `WifiInfo`、打点 ScoreCard、广播 UI 更新。

## 5.1 回调链路

supplicant 的 AIDL callback（`SupplicantStaIfaceCallbackAidlImpl`）→ `WifiMonitor.broadcastSupplicantStateChangeEvent()` → `ClientModeImpl` 收到 `SUPPLICANT_STATE_CHANGE_EVENT`

其中 `SUPPLICANT_STATE_CHANGE_EVENT` 被 `ClientModeImpl` 的多个状态处理。连接进行中时，`L2ConnectingState` 先处理部分逻辑（Passpoint 信息、广播），然后把控制交回父状态 `ConnectingOrConnectedState`：

```java
// ClientModeImpl.java — L2ConnectingState.processMessageImpl()
case WifiMonitor.SUPPLICANT_STATE_CHANGE_EVENT: {
    StateChangeResult stateChangeResult = (StateChangeResult) message.obj;
    if (SupplicantState.isConnecting(stateChangeResult.state)) {
        WifiConfiguration config = mWifiConfigManager.getConfiguredNetwork(
                stateChangeResult.networkId);
        // 更新 Passpoint 信息
        mWifiInfo.setFQDN(null);
        mWifiInfo.setPasspointUniqueId(null);
        mWifiInfo.setOsuAp(false);
        if (config != null && (config.isPasspoint() || config.osu)) {
            // ...设置 FQDN / Passpoint UniqueId / ProviderFriendlyName ...
        }
        updateCurrentConnectionInfo();
    }
    // 广播 NETWORK_STATE_CHANGED_ACTION（UI 更新）
    sendNetworkChangeBroadcast(
            WifiInfo.getDetailedStateOf(stateChangeResult.state));
    // 返回 NOT_HANDLED：让父状态继续处理
    handleStatus = NOT_HANDLED;
    break;
}
```

## 5.2 handleSupplicantStateChange()：状态变化的统一入口

```java
// ClientModeImpl.java — handleSupplicantStateChange()
private SupplicantState handleSupplicantStateChange(StateChangeResult stateChangeResult) {
    SupplicantState state = stateChangeResult.state;
    mWifiScoreCard.noteSupplicantStateChanging(mWifiInfo, state);
    mWifiInfo.setSupplicantState(state);
    // 连接中状态（AUTHENTICATING / ASSOCIATING / ASSOCIATED / FOUR_WAY_HANDSHAKE / GROUP_HANDSHAKE / COMPLETED）
    // SupplicantState.isConnecting() 覆盖了这个范围
    if (SupplicantState.isConnecting(state)) {
        mWifiInfo.setNetworkId(stateChangeResult.networkId);
        mWifiInfo.setBSSID(stateChangeResult.bssid);
        mWifiInfo.setSSID(stateChangeResult.wifiSsid);
        if (stateChangeResult.frequencyMhz > 0) {
            mWifiInfo.setFrequency(stateChangeResult.frequencyMhz);
        }
        // Multi-link 信息：关联前从 scan cache 读取，关联后从 supplicant 查询
        if (isMultiLinkInfoSettableFromScanCache(state)) {
            setMultiLinkInfoFromScanCache(stateChangeResult.bssid);
        }
        if (state == SupplicantState.ASSOCIATED) {
            updateWifiInfoLinkParamsAfterAssociation(); // 关联后查询真实 link 信息
        }
        mWifiInfo.setInformationElements(findMatchingInfoElements(stateChangeResult.bssid));
    } else {
        // 非连接状态：重置 WifiInfo
        mWifiInfo.setNetworkId(WifiConfiguration.INVALID_NETWORK_ID);
        mWifiInfo.setBSSID(null);
        mWifiInfo.setSSID(null);
        mWifiInfo.resetMultiLinkInfo();
    }
    updateCapabilities();
    // 更新 metered hint、频率等信息...省略...（还包括 removeAffiliatedBssids、setWifiStandard、clearCurrentSecurityType、setInformationElements(null) 等清理操作）
    mWifiScoreCard.noteSupplicantStateChanged(mWifiInfo);
    updateCurrentConnectionInfo();
    return state;
}
```

主要功能：

- **连接中路径**：`isConnecting()` 返回 true 时（AUTHENTICATING / ASSOCIATING / ASSOCIATED / FOUR_WAY_HANDSHAKE / GROUP_HANDSHAKE / COMPLETED），更新 WifiInfo 中的 networkId、BSSID、SSID、频率、MLO 链路信息和 Information Elements
- **非连接中路径**：`isConnecting()` 返回 false 时（DISCONNECTED、SCANNING、INACTIVE 等），重置 WifiInfo 的 networkId、BSSID、SSID 和 MLO 信息
- **SCANNING 特殊处理**：SCANNING 状态虽然 `isConnecting()` 返回 false（走 non-connecting 分支），但 `L2ConnectingState` 在处理 `SUPPLICANT_STATE_CHANGE_EVENT` 时，会单独设置 networkId 用于 UI 匹配——让设置界面在扫描阶段就能高亮显示目标网络

## 5.3 SupplicantState 的连接相关枚举

以下是连接过程中 Framework 会收到的 supplicant 状态，按时间顺序排列：

| SupplicantState      | 含义                                 | Framework 的反应                                             |
| -------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `DISCONNECTED`       | 初始状态 / 断连                      | 重置 WifiInfo，如果还在 L2ConnectingState 超时后跳 DisconnectedState |
| `SCANNING`           | Supplicant 正在扫描目标 SSID         | 设置 networkId 用于 UI 匹配（`isConnecting()` 返回 false）   |
| `AUTHENTICATING`     | 正在与 AP 进行 802.11 Authentication | `isConnecting()` 返回 true 更新 BSSID/SSID                   |
| `ASSOCIATING`        | 正在与 AP 进行 802.11 Association    | 同上                                                         |
| `ASSOCIATED`         | Association 成功                     | 更新 MLO link info，L2ConnectedState 开始收到此状态          |
| `FOUR_WAY_HANDSHAKE` | WPA/WPA2 四次握手进行中              | 同上                                                         |
| `GROUP_HANDSHAKE`    | 组密钥握手进行中                     | 同上                                                         |
| `COMPLETED`          | L2 层连接全部完成                    | L3 层开始（DHCP / IP 配置），见后续篇章                      |

制卡工厂做好房卡后，通过内部对讲机（AIDL callback）通知客房系统「卡已激活」（`SUPPLICANT_STATE_CHANGE_EVENT`）。客房系统收到通知后更新房态（`WifiInfo` 中的 BSSID、SSID、频率、MLO 链路信息），并广播「此房已入住」——整个过程从 `AUTHENTICATING` 到 `COMPLETED`，就像客人从刷卡到房门打开的那几秒。

---

# 6 手动连接 vs 自动连接：WifiConnectivityManager 的竞态怎么处理？

`WifiConnectivityManager` 的后台自动连接与用户手动连接使用同一套 `CMD_START_CONNECT` 消息，但通过「最后选择网络」标记和 User Connect Choice 两层机制保证用户意图不被自动连接覆盖。

## 6.1 两个连接触发源

Framework 中有两个途径可以触发连接：

| 触发源           | 途径                                                         | 代码路径                                                     |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **用户手动连接** | Settings / QuickSettings / Notification `CMD_CONNECT_NETWORK` | `connectToUserSelectNetwork()` `startConnectToNetwork()` `CMD_START_CONNECT` |
| **自动连接**     | WifiConnectivityManager 扫描回调 `CMD_START_CONNECT`         | `handleConnectionAttemptEnded()` 直接 `sendMessage(CMD_START_CONNECT)` |

注意：即使是用户手动连接（`CMD_CONNECT_NETWORK`），最终也会调用 `startConnectToNetwork()` 发出 `CMD_START_CONNECT`——**`CMD_START_CONNECT` 是连接启动的唯一统一入口**。

## 6.2 WifiConnectivityManager 的 ConnectHandler 接口

自动连接通过 `WifiConnectivityManager` 内部的 `ConnectHandler` 接口触发：

```java
// WifiConnectivityManager.java — ConnectHandler 接口
private interface ConnectHandler {
    // 断连状态下触发连接
    void triggerConnectWhenDisconnected(
            @NonNull WifiConfiguration targetNetwork, @NonNull String targetBssid);
    // 已连状态下触发切换到更好网络
    void triggerConnectWhenConnected(
            @NonNull WifiConfiguration currentNetwork, @NonNull WifiConfiguration targetNetwork,
            @NonNull String targetBssid);
    // 已连状态下触发 roam（同 SSID 切换 BSSID）
    void triggerRoamWhenConnected(
            @NonNull WifiConfiguration currentNetwork, @NonNull WifiConfiguration targetNetwork,
            @NonNull String targetBssid);
}
```

`ConnectHandler` 的实现最终会调用 `ClientModeImpl.sendMessage(CMD_START_CONNECT, netId, uid, bssid)`——和手动连接的终点完全一致。

## 6.3 User Connect Choice：防止自动连接覆盖用户意图

用户手动选择网络后，有两层机制防止自动连接覆盖用户意图，二者时间尺度不同、由不同入口设置：

**第一层是「最后选择网络」标记（30 秒窗口）**。`ConnectHelper.connectToNetwork()` 调用 `WifiConfigManager.updateBeforeConnect()`，它先 `userEnabledNetwork()` 启用目标网络，再 `enableNetwork(networkId, disableOthers, uid, null)`——当 `disableOthers` 为真（用户显式选择而非自动连接）时，`enableNetwork()` 内部调用 `setLastSelectedNetwork()` 设置「最后选择网络」标记。

**第二层是持久的 User Connect Choice**。它由 `setLegacyUserConnectChoice()` 设置——主要调用方是连接成功后的 `updateNetworkAfterConnect()`（`WifiNetworkSelector` 选网遇 connect choice 环时也会调用），选网时由 `getConnectChoiceKey()` 消费。这个标记持久存在、无时间窗口。写入路径中间还隔着 `setUserConnectChoice()`（`WifiConfigManager.java:4070`）：它先 `updateNetworkSelectionStatus(selected, DISABLED_NONE)` 启用被禁用的网络，再委托 `setLegacyUserConnectChoice()` 完成写入——`updateNetworkAfterConnect()` 走的就是这条中间路径。

先看第一层的入口：

```java
// 在 ConnectHelper.connectToNetwork() 中调用
mWifiConfigManager.updateBeforeConnect(netId, callingUid, packageName,
        !ClientModeImpl.ATTRIBUTION_TAG_DISALLOW_CONNECT_CHOICE.equals(attributionTag));
```

**「最后选择网络」标记的 30 秒窗口是怎么实现的？** `setLastSelectedNetwork()`（`WifiConfigManager.java:2730`）只做两件事：把 `mLastSelectedNetworkId` 记为目标网络、把 `mLastSelectedTimeStamp` 记为当前 `elapsedSinceBoot` 时间戳。真正判断「30 秒是否过期」的是 `ClientModeImpl.isRecentlySelectedByTheUser()`（`ClientModeImpl.java:7164`）：当 `getLastSelectedNetwork()` 等于目标网络、且当前时间减去 `getLastSelectedTimeStamp()` 小于 `LAST_SELECTED_NETWORK_EXPIRATION_AGE_MILLIS`（常量定义在 `ClientModeImpl.java:625`，值为 `30 * 1000`）时返回 true。

这 30 秒窗口有两处关键作用：`registerConnected()` 用它判定 `shouldSetUserConnectChoice`——只有用户刚选且已连上时，才把这次选择固化为持久 connect choice；`CMD_UNWANTED_NETWORK` 处理用它避免低 RSSI 时禁用用户刚选的网络。窗口一过，这套「刚点完」的保护自动失效，长期意图交给第二层持久 User Connect Choice，其核心作用：

1. **持久标记**：`WifiConfigManager.setLegacyUserConnectChoice()`（`WifiConfigManager.java:4091`）遍历所有已配置网络——对**选中网络本身**，若它还记着旧的 connect choice，先 `clearConnectChoiceInternal()` 清掉；对其他 `getSeenInLastQualifiedNetworkSelection()` 为 true（最近一次合格选网中出现在扫描范围内）的网络，`setConnectChoiceInternal()` 把选中网络的 profile key 写入它们的 `connectChoice` 字段——于是每个「在范围内」的竞争网络都记着「用户点名选了 key」。这个标记持久存在（无时间窗口限制），直到用户选择另一个网络或被显式清除。

2. **网络选择优先**：自动连接的网络选择流程用 `WifiNetworkSelector.getConnectChoiceKey()` 消费这个标记——当当前连接已「足够好」、本不需要重新选网时，它仍读取主 CMM 当前网络的 connect choice，有值就把候选集收窄到只有这个用户选择网络，防止自动连接顺手切走用户网络。

3. **自动连接的守护**：即使用户选择的网络暂时消失了（没有扫描结果），自动连接也不会连接其他网络，因为它认为用户还在等这个网络恢复。

「网络选择优先」的读取逻辑核心是一段遍历——找到主 CMM，取它当前网络的 connect choice：

```java
// WifiNetworkSelector.java — getConnectChoiceKey()（行 1068）
private String getConnectChoiceKey(@NonNull List<ClientModeManagerState> cmmStates) {
    for (ClientModeManagerState cmmState : cmmStates) {
        if (cmmState.role != ROLE_CLIENT_PRIMARY) continue;      // 只看主 CMM
        WifiConfiguration currentNetwork =
                mWifiConfigManager.getConfiguredNetwork(cmmState.wifiInfo.getNetworkId());
        if (currentNetwork != null) {
            return currentNetwork.getNetworkSelectionStatus().getConnectChoice();
        }
    }
    return null;
}
```

于是自动选网拿到的 key 就是用户最后点名的网络——后续选网逻辑据此把候选集收窄到只有这一个网络。

不过 `getConnectChoiceKey()` 只负责「读」这个 key，真正跟随 connect choice 链、把候选覆盖成用户点名网络的是 `overrideCandidateWithUserConnectChoice()`（`WifiNetworkSelector.java:819`）。它从候选网络出发，用 `while` 循环沿 connect choice 链逐级跳转——每步读当前网络的 `getConnectChoice()` 拿到下一个 key，再 `getConfiguredNetwork(key)` 取出下一个网络：

```java
// WifiNetworkSelector.java — overrideCandidateWithUserConnectChoice()（行 819-869 节选）
WifiConfiguration tempConfig = Preconditions.checkNotNull(candidate);
Set<String> seenNetworks = new HashSet<>();
seenNetworks.add(candidate.getProfileKey());
while (tempConfig.getNetworkSelectionStatus().getConnectChoice() != null) {
    String key = tempConfig.getNetworkSelectionStatus().getConnectChoice();
    int userSelectedRssi = tempConfig.getNetworkSelectionStatus().getConnectChoiceRssi();
    tempConfig = mWifiConfigManager.getConfiguredNetwork(key);
    if (tempConfig != null) {
        if (seenNetworks.contains(tempConfig.getProfileKey())) {
            // 环检测命中：connect choice 链成环，用候选网络打断环
            mWifiConfigManager.setLegacyUserConnectChoice(candidate,
                    candidate.getNetworkSelectionStatus().getCandidate().level);
            break;
        }
        seenNetworks.add(tempConfig.getProfileKey());
        WifiConfiguration.NetworkSelectionStatus tempStatus =
                tempConfig.getNetworkSelectionStatus();
        boolean noInternetButInternetIsExpected = !tempConfig.isNoInternetAccessExpected()
                && tempConfig.hasNoInternetAccess();
        // 目标网络须「在范围内、已启用、无断网矛盾、RSSI 够格」才覆盖候选
        if (tempStatus.getCandidate() != null && tempStatus.isNetworkEnabled()
                && !noInternetButInternetIsExpected
                && isUserChoiceRssiCloseToOrGreaterThanExpectedValue(
                        tempStatus.getCandidate().level, userSelectedRssi)) {
            candidate = tempConfig;
        }
    } else {
        break; // key 对应的配置已不存在，终止跟随
    }
}
```

这里有两层防护：`seenNetworks` 是环检测——connect choice 链在极端情况下可能成环（A 记着 B、B 又记着 A），一旦回到已访问过的 profileKey 就调用 `setLegacyUserConnectChoice()` 用当前候选打断环并 `break`。RSSI 比较由 `isUserChoiceRssiCloseToOrGreaterThanExpectedValue()`（`WifiNetworkSelector.java:871`）完成——`observedRssi >= expectedRssi - getEstimateRssiErrorMargin()`，误差容限由 `ScoringParams` 配置，即目标网络当前信号只比用户选择时差一个误差范围才接受覆盖；`expectedRssi == 0`（老设备升级无此信息）时直接放行，避免误伤。`expectedRssi` 正是连接成功时 `updateNetworkAfterConnect()` 传入的 rssi，经 `setLegacyUserConnectChoice()` 写入竞争网络的 `connectChoiceRssi` 字段。

回到酒店的比喻：第一层「最后选择网络」= 前台临时锁房 30 秒，第二层 User Connect Choice = 把长期偏好登记进房客档案，下次自动排房优先分配。

## 6.4 连接失败的退出与重试

当 supplicant 回调了失败事件（`NETWORK_NOT_FOUND`、`AUTHENTICATION_FAILURE`、`ASSOCIATION_REJECTION`），`L2ConnectingState` 会：

```java
// ClientModeImpl.java — L2ConnectingState 处理连接失败
case WifiMonitor.NETWORK_NOT_FOUND_EVENT:
    mNetworkNotFoundEventCount++;
    if (mNetworkNotFoundEventCount >= mWifiGlobals.getNetworkNotFoundEventThreshold()
            && mTargetWifiConfiguration != null) {
        stopIpClient();
        mWifiConfigManager.updateNetworkSelectionStatus(
                mTargetWifiConfiguration.networkId,
                WifiConfiguration.NetworkSelectionStatus.DISABLED_NETWORK_NOT_FOUND);
        reportConnectionAttemptEnd(
                WifiMetrics.ConnectionEvent.FAILURE_NETWORK_NOT_FOUND, ...);
        transitionTo(mDisconnectedState); // 结束本次连接尝试
    }
    break;

// ASSOCIATION_REJECTION — Association 被 AP 拒绝（如 AP 满载、临时拒绝）
case WifiMonitor.ASSOCIATION_REJECTION_EVENT: {
    AssocRejectEventInfo assocRejectEventInfo = (AssocRejectEventInfo) message.obj;
    stopIpClient();
    String bssid = assocRejectEventInfo.bssid;
    int statusCode = assocRejectEventInfo.statusCode;
    boolean timedOut = assocRejectEventInfo.timedOut;
    // 标记网络为 ASSOCIATION_REJECTION 禁用（非 SecondInternet 场景）
    if (!isSecondaryInternet()) {
        mWifiConfigManager.updateNetworkSelectionStatus(mTargetNetworkId,
                WifiConfiguration.NetworkSelectionStatus
                        .DISABLED_ASSOCIATION_REJECTION);
    }
    // 判断是否为 AP 超载类原因
    // (AP_UNABLE_TO_HANDLE_NEW_STA / ASSOC_REJECTED_TEMPORARILY / DENIED_INSUFFICIENT_BANDWIDTH)
    int level2FailureReason = WifiMetricsProto.ConnectionEvent.FAILURE_REASON_UNKNOWN;
    if (statusCode == StaIfaceStatusCode.AP_UNABLE_TO_HANDLE_NEW_STA
            || statusCode == StaIfaceStatusCode.ASSOC_REJECTED_TEMPORARILY
            || statusCode == StaIfaceStatusCode.DENIED_INSUFFICIENT_BANDWIDTH) {
        level2FailureReason = WifiMetricsProto.ConnectionEvent
                .ASSOCIATION_REJECTION_AP_UNABLE_TO_HANDLE_NEW_STA;
    }
    // AP 超载类原因不触发 Watchdog
    if (level2FailureReason != WifiMetricsProto.ConnectionEvent
            .ASSOCIATION_REJECTION_AP_UNABLE_TO_HANDLE_NEW_STA
            && !isSecondaryInternet()) {
        mWifiLastResortWatchdog.noteConnectionFailureAndTriggerIfNeeded(
                getConnectingSsidInternal(), bssid,
                WifiLastResortWatchdog.FAILURE_CODE_ASSOCIATION);
    }
    reportConnectionAttemptEnd(
            timedOut ? WifiMetrics.ConnectionEvent.FAILURE_ASSOCIATION_TIMED_OUT
                     : WifiMetrics.ConnectionEvent.FAILURE_ASSOCIATION_REJECTION,
            ...);
    transitionTo(mDisconnectedState);
    break;
}

// AUTHENTICATION_FAILURE — 认证失败（密码错误、EAP 失败、证书过期…）
case WifiMonitor.AUTHENTICATION_FAILURE_EVENT:
    AuthenticationFailureEventInfo authInfo =
            (AuthenticationFailureEventInfo) message.obj;
    stopIpClient();
    int disableReason = WifiConfiguration.NetworkSelectionStatus
            .DISABLED_AUTHENTICATION_FAILURE;
    // 细分失败类型
    if (isPermanentWrongPasswordFailure(mTargetNetworkId, authInfo.reasonCode)) {
        disableReason = DISABLED_BY_WRONG_PASSWORD;
        mWrongPasswordNotifier.onWrongPasswordError(targetedNetwork);
    } else if (authInfo.reasonCode == ERROR_AUTH_FAILURE_EAP_FAILURE) {
        // EAP 失败细分：SIM 认证错误、证书过期、运营商特定错误...
        handleEapAuthFailure(mTargetNetworkId, authInfo.errorCode);
        if (authInfo.errorCode == EAP_SIM_NOT_SUBSCRIBED) {
            disableReason = DISABLED_AUTHENTICATION_NO_SUBSCRIPTION;
        }
    }
    mWifiConfigManager.updateNetworkSelectionStatus(
            mTargetNetworkId, disableReason);
    // 密码错误和 EAP 失败不触发 Watchdog（用户需手动修复）
    if (authInfo.reasonCode != ERROR_AUTH_FAILURE_WRONG_PSWD
            && authInfo.reasonCode != ERROR_AUTH_FAILURE_EAP_FAILURE) {
        mWifiLastResortWatchdog.noteConnectionFailureAndTriggerIfNeeded(...);
    }
    reportConnectionAttemptEnd(
            WifiMetrics.ConnectionEvent.FAILURE_AUTHENTICATION_FAILURE, ...);
    transitionTo(mDisconnectedState);
    break;
```

除了这三种主动失败事件，`L2ConnectingState` 还有一套**被动超时机制**——防止 supplicant 收到连接请求后静默卡死导致状态机永远卡在 `L2ConnectingState`。进入 `L2ConnectingState` 时启动一个 30 秒的 watchdog（`CMD_CONNECTING_WATCHDOG_TIMER`，超时值 `CONNECTING_WATCHDOG_TIMEOUT_MS = 30_000`），正常退出该状态时取消。

如果 30 秒内 supplicant 没有回调任何状态变化事件，watchdog 超时，状态机上报 `FAILURE_NO_RESPONSE` 并跳回 `DisconnectedState`。这个计时器使用递增计数器 `mConnectingWatchdogCount` 防止误触发——超时处理中比对计数器值，不匹配则忽略。

三种失败事件的处理对比：

| 失败事件                 | 禁用原因                                                     | 特殊处理                                                     | 是否触发 Watchdog                                   |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------- |
| `NETWORK_NOT_FOUND`      | `DISABLED_NETWORK_NOT_FOUND`                                 | 有阈值保护（多次出现才标记）；支持 Fallback SSID 重试        | 通过 `noteConnectionFailureAndTriggerIfNeeded` 触发 |
| `ASSOCIATION_REJECTION`  | `DISABLED_ASSOCIATION_REJECTION`                             | AP 超载类原因（`AP_UNABLE_TO_HANDLE_NEW_STA`）不触发 Watchdog——不是本地问题 | 仅非 AP 超载原因时触发                              |
| `AUTHENTICATION_FAILURE` | `DISABLED_AUTHENTICATION_FAILURE` / `DISABLED_BY_WRONG_PASSWORD` / `DISABLED_AUTHENTICATION_NO_SUBSCRIPTION` | 密码错误 → 通知用户（`WrongPasswordNotifier`）；EAP 失败 → 细分 SIM/证书/运营商错误 | 密码错误和 EAP 失败不触发——用户需手动修复           |

共同流程：

- **停止 IpClient**：三种失败都先 `stopIpClient()`，释放 IP 层资源
- **标记网络禁用**：通过 `updateNetworkSelectionStatus()` 设置不同的 `disableReason`，避免自动连接重复尝试同一个失败网络
- **上报 Metrics**：通过 `reportConnectionAttemptEnd()` 记录失败类型和原因码，用于统计和诊断
- **状态机退出**：`transitionTo(mDisconnectedState)` 结束本次连接尝试，WifiConnectivityManager 收到通知后可以重新选择网络

酒店的自动排房系统（`WifiConnectivityManager`）会自己给客人安排房间——但客人如果点名要住某个房间（手动连接），前台必须尊重客人的选择（最后选择网络标记锁定 30 秒）。如果连接失败（认证失败、找不到网络），客房系统会通知前台「此房不可用」，自动排房系统重新选房，不会一直傻等。即便房客档案里登记过偏好网络，一旦它已从档案中消失，排房系统也不会无限傻等它回来。

---

# 总结：一次连接下发的完整调用链

![完整连接时序图](assets/06a-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%B8%80%EF%BC%89Framework-%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E8%BF%87%E7%A8%8B/06a-sequence.svg)

从用户点击到 supplicant 开始认证的完整调用链路（缩进表示调用层级）：

```
App (Settings/QuickSettings)
  WifiServiceImpl.connect(config, netId, callback)
    权限检查 (isPrivileged + AttributionSource)
    WifiConfigManager.addOrUpdateNetwork() / getConfiguredNetwork()
    配置校验 (admin restricted, deprecated security, SIM ready...)
    防 MCC: 拆掉冲突的副 CMM
    ConnectHelper.connectToNetwork(result, wrapper, uid, pkg, attrTag)
      ConcreteClientModeManager.connectNetwork()
        ClientModeImpl.sendMessage(CMD_CONNECT_NETWORK)
          connectToUserSelectNetwork(netId, uid, ...)
            WifiConfigManager.updateBeforeConnect()  [设置最后选择网络标记]
            startConnectToNetwork(netId, uid, bssid)
              sendMessage(CMD_START_CONNECT, netId, uid, bssid)
                ConnectableState.processMessageImpl(CMD_START_CONNECT)
                  updateWifiConfigOnStartConnection(config, bssid)
                  reportConnectionAttemptStart()
                  connectToNetwork(config)
                    WifiNative.connectToNetwork(ifaceName, config)
                      WifiNl80211Manager.abortScan()  [先停扫描]
                      SupplicantStaIfaceHal.connectToNetwork(ifaceName, config)
                        SupplicantStaIfaceHalAidlImpl.connectToNetwork()
                          removeAllNetworks()  [如果网络不同]
                          addNetworkAndSaveConfig()  [AIDL: ISupplicantStaNetwork setters]
                          networkHandle.select()  [AIDL: ISupplicantStaNetwork.select()]
                          到此为止，不进入 supplicant 内部
                    stateMachine.transitionTo(mL2ConnectingState)
```

**从入口到出口统计**：

- **进程边界**：1 次（App system_server Binder）
- **线程切换**：1 次（Binder 线程 WiFi handler 线程 `mWifiThreadRunner.post()`）
- **AIDL 跨进程调用**：20+ 次（`saveWifiConfiguration()` 中的 setter + `select()`）
- **状态机跳转**：`ConnectableState` `L2ConnectingState`
- **关键分水岭**：`SupplicantStaIfaceHalAidlImpl.connectToNetwork()` 的 `networkHandle.select()` 调用——这是 Framework 层控制的终点，wpa_supplicant 接管后续所有 L2 操作

一次完整的连接入住——前台接待（`WifiServiceImpl`）查身份、前台经理（`ConnectHelper` + `ClientModeImpl`）排房、经理通过对讲机（AIDL）呼叫制卡机（`SupplicantStaIfaceHalAidlImpl`）、制卡机写入房卡信息并激活（`networkHandle.select()`）——全程跨越 1 次进程边界、20+ 次对讲机呼叫、2 次状态机跳转。客人从走进大堂到房门打开，不过几十毫秒。

---

> **下一章预告**：Framework 把 `select()` 发给了 supplicant，那么 wpa_supplicant 内部是怎么处理这条指令的？它怎么决定连接哪个 BSSID？怎么处理认证失败和重试？怎么调用 nl80211 下发 `NL80211_CMD_AUTHENTICATE` 和 `NL80211_CMD_ASSOCIATE`？下一章「Supplicant 连接决策与 nl80211」将追踪从 AIDL 回调到内核命令的完整路径。

> **相关规范**：本文涉及的 802.11 Authentication/Association 流程对应 IEEE 802.11-2020 §11.3，详细分析见后续章节。

**源码出处**：[packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi/)。
