---
title: DPP 扫码配网——从 App 扫二维码到凭据落库
top: 1
related_posts: true
abbrlink: 835c39ec
date: 2026-09-24 23:17:59
tags:
  - Android WiFi
  - DPP
categories:
  - WiFi
  - Code
---

> 新搬来的住户没有钥匙，物业也不用上门。住户把自家门上贴的"门禁凭证"（二维码）给物业扫一下，物业核验身份后发给他一张"门禁卡"（Connector）和一把"房门钥匙"（Wi-Fi 密码）——全程没有输过一次密码。本文追踪这场"无密码配网"在代码里怎么跑通：从 App 扫码到 wpa_supplicant 把凭据写进网络配置库，跨过 Java Framework 与 supplicant C 两个代码世界。

---

# 本章导读

DPP（Device Provisioning Protocol，设备配网协议）是 Wi-Fi Alliance 推出的"扫码配网"协议，商标名 Wi-Fi Easy Connect。它要解决的是智能家居最痛的问题：无屏设备（灯泡、插座、摄像头）怎么连上家里的 Wi-Fi。传统 WPS 靠 PIN 码或按按钮，安全性饱受诟病（PIN 可被暴力破解）；DPP 换成了一套基于公钥密码学的四阶段流程——扫码拿到对方公钥，用 ECDH（Elliptic Curve Diffie-Hellman，椭圆曲线 Diffie-Hellman）交换出会话密钥，在加密隧道里下发 Wi-Fi 凭据。

<!--more-->

本文把这条链完整走一遍，分两条路：

- **正向下发**：App 扫二维码 → `WifiManager` → `DppManager` → `WifiNative` → AIDL → `wpa_supplicant` → 解析 URI → `dpp_auth_init` → 三帧认证握手 → GAS 配置交换 → `wpas_dpp_add_network` 把凭据写进 supplicant 网络库。
- **反向回报**：supplicant 发 `DPP-NETWORK-ID` 事件 → AIDL 回调 → `SupplicantStaIfaceCallbackAidlImpl` → `DppManager` 的 `onSuccessConfigReceived` → `WifiConfigManager` 落库 → `EasyConnectCallbackProxy` → App 的 `EasyConnectStatusCallback`。

**本文只讲扫码配网的主干。** DPP-over-TCP（规范 §2.3）、Enterprise provisioning 802.1X（§4.5）、Network Access 的二次握手（§6.6.6）、以及驱动侧帧收发都不展开——DPP 走的是 802.11 通用 Action / GAS 帧，驱动没有 DPP 特化逻辑，到 `offchannel_send_action` 就离开本文视线了。

> 手机上的扫一扫可不一定是这玩意儿，那就是单纯解析二维码，你用微信扫一扫都能看出来密码是啥

先看这张全链路分层图，理解扫码配网要跨越的每一层：

![DPP 扫码配网全链路分层架构](assets/12-DPP-%E6%89%AB%E7%A0%81%E9%85%8D%E7%BD%91%E2%80%94%E2%80%94%E4%BB%8E-App-%E6%89%AB%E4%BA%8C%E7%BB%B4%E7%A0%81%E5%88%B0%E5%87%AD%E6%8D%AE%E8%90%BD%E5%BA%93/12-dpp-architecture.svg)

---

# 1 一张二维码里到底装了什么？

> 二维码不是"密码"，而是一张"门禁凭证"——里面是公钥、信道列表和 MAC 地址，扫它的人拿到的是"这位住户的身份信息"，不是开门的钥匙。

DPP 的配网哲学和 WPS 完全不同。WPS 是"我知道 PIN/按了按钮，所以我们能配"——安全建立在共享秘密上，PIN 只有 8 位数字，暴力破解只需 ~11000 次尝试（Reaver 攻击）。DPP 是"我扫码拿到了你的公钥，我们用公钥密码学建立信任"——安全建立在椭圆曲线密码学上，扫描二维码只是拿到对方的**身份**，真正的信任要通过后面的认证握手建立。

## 1.1 DPP URI：一串自描述的公钥凭证

扫码得到的字符串叫 **DPP URI**，格式在规范 §5.2.1（Bootstrapping Information Format）定义。一个典型的 DPP URI 长这样：

```
DPP:K:MDwwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeyU...;C:81/1,2,3,4,5,6,7,8,9,10,11;M:8cf9420df54c;;
```

分号分隔的字段每个以「单字母:值」出现，规范 §5.2.1 的 ABNF 规则里列出了保留字段：

| 字段 | 含义                                                         | 规范 §5.2.1                        |
| ---- | ------------------------------------------------------------ | ---------------------------------- |
| `K:` | **Bootstrapping Public Key**，公钥（DER 编码的 ASN.1 SubjectPublicKeyInfo 做 base64） | `public-key = "K:" *PKCHAR`        |
| `C:` | **Channel List**，全局 operating class / channel 列表，如 `81/1,2,3,4,5,6,7,8,9,10,11` | `channel-list = "C:" ...`          |
| `M:` | **MAC 地址**，6 字节十六进制，如 `8cf9420df54c`              | `mac = "M:" 12HEXDIG`              |
| `I:` | **Info**，设备描述信息（可选，Android 的 `deviceInfo` 参数） | `information = "I:" *VCHAR`        |
| `V:` | **Version**，DPP 版本（R2+ 要求带）                          | `version = "V:" ...`               |
| `B:` | **Supported Curves**，支持的椭圆曲线位图                     | `supported-curves = "B:" 1*HEXDIG` |

末尾的 `;;` 是 ABNF 里的终止符。这段字符串的本质是：**设备把自己的公钥 + 一张"我大概会在哪些信道出现"的小地图 + 自己的 MAC 地址，打印成二维码贴在身上**。谁扫到它，谁就拿到了发起配网的入口信息。

![DPP URI 字段结构拆解](assets/12-DPP-%E6%89%AB%E7%A0%81%E9%85%8D%E7%BD%91%E2%80%94%E2%80%94%E4%BB%8E-App-%E6%89%AB%E4%BA%8C%E7%BB%B4%E7%A0%81%E5%88%B0%E5%87%AD%E6%8D%AE%E8%90%BD%E5%BA%93/12-dpp-qr-uri.svg)

## 1.2 wpa_supplicant 怎么解析这串 URI

URI 的解析入口在 `dpp_parse_uri()`（`src/common/dpp.c:432`）。它按分号循环切字段，识别出 `C:`、`M:`、`K:`、`I:`、`V:`、`B:`、`H:` 后分别交给各自的解析函数：

```c
// src/common/dpp.c:432
static struct dpp_bootstrap_info * dpp_parse_uri(const char *uri)
{
    if (os_strncmp(pos, "DPP:", 4) != 0) {
        wpa_printf(MSG_INFO, "DPP: Not a DPP URI");
        return NULL;
    }
    pos += 4;

    for (;;) {
        end = os_strchr(pos, ';');
        if (!end)
            break;
        if (pos[0] == 'C' && pos[1] == ':' && !chan_list)
            chan_list = pos + 2;
        else if (pos[0] == 'M' && pos[1] == ':' && !mac)
            mac = pos + 2;
        else if (pos[0] == 'K' && pos[1] == ':' && !pk)
            pk = pos + 2;
        else if (pos[0] == 'V' && pos[1] == ':' && !version)
            version = pos + 2;
        // ... B: H: I: ...
        pos = end + 1;
    }

    if (!pk) {
        wpa_printf(MSG_INFO, "DPP: URI missing public-key");
        return NULL;
    }
    // dpp_parse_uri_chan_list / dpp_parse_uri_mac / dpp_parse_uri_pk ...
}
```

**关键设计点**：

1. **`K:` 是强制字段**，其他都可选。URI 没有公钥直接拒绝——没有身份信息，后续 ECDH 无从谈起。
2. **未识别字段静默跳过**。规范 §5.2.1 明确要求"解析时忽略未知的分号分隔组件"，这是前向兼容设计——未来加新字段，老设备扫到新二维码不会崩，只是用不上新字段。
3. 解析结果装进 `struct dpp_bootstrap_info`，存进 supplicant 的 **bootstrapping table**，返回一个整数 ID。这个 ID 就是后面所有命令引用"这个二维码"的句柄。

解析出来的 `struct dpp_bootstrap_info` 是关键数据结构，它的 `pubkey`（对方的公钥）和 `chan_list`（对方出现的信道）在后面认证握手时会反复用到。

---

# 2 App 扫码后 Framework 做了什么？

> 物业前台收到住户的门禁凭证，先登记在案（加 URI），再通知保安部开始核验（发起认证）。Framework 的 `DppManager` 就是那个"前台"——它是整个 DPP 会话的单一收口点。

上一节二维码的内容解析发生在 supplicant 侧。但用户扫码的动作发生在 App 侧，App 怎么把 URI 送到 supplicant？中间隔了 Java Framework 和 AIDL（Android Interface Definition Language，Android 接口定义语言）两层。

## 2.1 App 入口：WifiManager.startEasyConnectAsConfiguratorInitiator

App 侧（通常是系统设置或厂商配网 App）调用 `WifiManager` 的 Easy Connect 系列方法。Android 上 Easy Connect 是 `@SystemApi`，需要 `NETWORK_SETTINGS` 或 `NETWORK_SETUP_WIZARD` 权限，普通第三方 App 调不了。

以"Configurator 扫码给 Enrollee 配网"为例：

```java
// framework/java/android/net/wifi/WifiManager.java:9474
@SystemApi
@RequiresPermission(anyOf = {
        android.Manifest.permission.NETWORK_SETTINGS,
        android.Manifest.permission.NETWORK_SETUP_WIZARD})
public void startEasyConnectAsConfiguratorInitiator(@NonNull String enrolleeUri,
        int selectedNetworkId, @EasyConnectNetworkRole int enrolleeNetworkRole,
        @NonNull @CallbackExecutor Executor executor,
        @NonNull EasyConnectStatusCallback callback) {
    Binder binder = new Binder();
    try {
        mService.startDppAsConfiguratorInitiator(binder, mContext.getOpPackageName(),
                enrolleeUri, selectedNetworkId, enrolleeNetworkRole,
                new EasyConnectCallbackProxy(executor, callback));
    } catch (RemoteException e) {
        throw e.rethrowFromSystemServer();
    }
}
```

**要点**：

1. 参数 `enrolleeUri` 是扫码得到的 DPP URI，`selectedNetworkId` 是 Configurator 要"发给对方"的本地网络（即配网的目标 Wi-Fi），`enrolleeNetworkRole` 告诉对方你配好网后是当 STA 还是当 AP。
2. `new EasyConnectCallbackProxy(executor, callback)` 把 App 的回调包了一层 Binder 代理，跨进程传给系统服务。App 侧的回调接口是 `EasyConnectStatusCallback`。
3. 还有一个 `startEasyConnectAsEnrolleeInitiator`（WifiManager.java:9502）：反过来，本机是 Enrollee，扫码拿到的是 Configurator 的 URI，请求对方给自己发配置。它走同一套 Framework 链——`WifiServiceImpl.startDppAsEnrolleeInitiator`（WifiServiceImpl.java:6697）→ `DppManager.startDppAsEnrolleeInitiator`（DppManager.java:408）→ `WifiNative.startDppEnrolleeInitiator`（WifiNative.java:3269），到 supplicant 侧的 AIDL 实现里，命令字符串拼的是 `role=enrollee` 而非 `role=configurator`。后面的认证握手、GAS 收配置、`onSuccessConfigReceived` 落库整条链都复用，只有"谁发配置、谁收配置"的方向相反。

## 2.2 系统服务：WifiServiceImpl 转发到 DppManager

`mService` 是 `IWifiManager` 的 Binder 服务端，即 `WifiServiceImpl`。它在 `startDppAsConfiguratorInitiator` 里做权限检查后，把调用投递到 WiFi 线程，转给 `DppManager`：

```java
// service/java/com/android/server/wifi/WifiServiceImpl.java:6653
public void startDppAsConfiguratorInitiator(IBinder binder, @NonNull String packageName,
        String enrolleeUri, int selectedNetworkId,
        @WifiManager.EasyConnectNetworkRole int enrolleeNetworkRole,
        IDppCallback callback) {
    ...
    mWifiThreadRunner.post(() -> {
        mDppManager.startDppAsConfiguratorInitiator(uid, packageName,
                clientIfaceName, binder, enrolleeUri, selectedNetworkId,
                enrolleeNetworkRole, callback);
    }, TAG + "#startDppAsConfiguratorInitiator");
}
```

`DppManager` 是 `com.android.server.wifi` 包下的**单个类**（不是子包），整个 DPP 会话的状态都收在它内部——这是本仓库源码与老博客的一个关键差异：Framework 没有 `wifi/dpp/` 子包，`DppConfigurator`、`DppEnrollee` 那些"多类拆分"的写法是旧版/其他分支的，当前代码是单类 `DppManager` 集中管理。

## 2.3 DppManager：单会话的"配网前台"

`DppManager` 的核心设计是**同一时刻只允许一个 DPP 会话**。它内部用一个 `DppRequestInfo` 对象记录当前会话的所有状态，`isSessionInProgress()` 就是检查这个对象是否为 null：

```java
// service/java/com/android/server/wifi/DppManager.java:225
public void startDppAsConfiguratorInitiator(int uid, @Nullable String packageName,
        @Nullable String clientIfaceName, IBinder binder, String enrolleeUri,
        int selectedNetworkId, @WifiManager.EasyConnectNetworkRole int enrolleeNetworkRole,
        IDppCallback callback) {
    mDppMetrics.updateDppConfiguratorInitiatorRequests();
    if (isSessionInProgress()) {
        Log.e(TAG, "DPP request already in progress");
        // On going DPP. Call the failure callback directly
        callback.onFailure(EasyConnectStatusCallback.EASY_CONNECT_EVENT_FAILURE_BUSY, null,
                null, new int[0]);
        return;
    }
    ...
    mDppRequestInfo = new DppRequestInfo();
    mDppRequestInfo.uid = uid;
    mDppRequestInfo.packageName = packageName;
    mDppRequestInfo.binder = binder;
    mDppRequestInfo.callback = callback;
    mDppRequestInfo.authRole = DPP_AUTH_ROLE_INITIATOR;
    mDppRequestInfo.networkId = selectedNetworkId;

    if (!linkToDeath(mDppRequestInfo)) {
        onFailure(EasyConnectStatusCallback.EASY_CONNECT_EVENT_FAILURE_GENERIC);
        return;
    }

    mDppRequestInfo.startTime = mClock.getElapsedSinceBootMillis();
    mDppTimeoutMessage.schedule(mDppRequestInfo.startTime + DPP_TIMEOUT_MS);

    // Send Enrollee URI and get a peer ID
    int peerId = mWifiNative.addDppPeerUri(mClientIfaceName, enrolleeUri);
    ...
```

会话登记完成、超时计时器启动后，函数把要下发的 Wi-Fi 凭据编码进命令参数，然后发起认证：

```java
    // Auth init
    logd("Authenticating");
    ...
    if (!mWifiNative.startDppConfiguratorInitiator(mClientIfaceName,
            mDppRequestInfo.peerId, 0, ssidEncoded, passwordEncoded, psk,
            enrolleeNetworkRole == EASY_CONNECT_NETWORK_ROLE_AP ? DppNetRole.AP
                    : DppNetRole.STA,
            securityAkm, privEcKey)) {
        Log.e(TAG, "DPP Start Configurator Initiator failure");
        onFailure(DppFailureCode.FAILURE);
        return;
    }
    logd("Success: Started DPP Initiator with peer ID " + mDppRequestInfo.peerId);
}
```

**这段代码是 Framework 侧下发的核心，拆开看**：

1. **单会话锁**：`isSessionInProgress()` 为真就立刻回 `FAILURE_BUSY`。配网是重操作，同一时刻只有一个 App 能发起，避免两个会话在 supplicant 侧互相踩踏。
2. **`linkToDeath`**：注册 Binder 死亡回调。如果发起配网的 App 进程挂了，`binderDied()` 里会主动 `stopDppInitiator` 并清理会话——防止 App 崩溃后 supplicant 里留一个永远超时的认证。
3. **超时计时器**：`DPP_TIMEOUT_MS = 40_000`（40 秒，`DppManager.java:75`）。Initiator 的认证必须在 40 秒内完成，超时触发 `timeoutDppRequest()` → `onFailure(TIMEOUT)`。注意 Enrollee-Responder 用的是 `DPP_RESPONDER_TIMEOUT_MS = 300_000`（5 分钟）——Responder 是"被动等待对方来找我"，等的时间理应更长（`DppManager.java:76`）。
4. **两步下发**：先 `addDppPeerUri` 把 URI 交给 supplicant 解析、拿到 peer ID；再 `startDppConfiguratorInitiator` 用这个 peer ID 发起认证。两步之间把要下发的 Wi-Fi 凭据（SSID、passphrase/PSK、AKM、网络角色）一起传给 supplicant。

`DppRequestInfo` 是 `DppManager` 的私有静态内部类（`DppManager.java:635`），字段如下：

```java
// service/java/com/android/server/wifi/DppManager.java:635
private static class DppRequestInfo {
    public int uid;
    public String packageName;
    public IBinder binder;
    public IBinder.DeathRecipient dr;
    public int peerId;
    public IDppCallback callback;
    public long startTime;
    public int authRole = DPP_AUTH_ROLE_INACTIVE;
    public int bootstrapId;
    public int networkId;
    public boolean isGeneratingSelfConfiguration = false;
    public boolean connStatusRequested = false;
}
```

`authRole` 三值（`DppManager.java:77-79`）：`DPP_AUTH_ROLE_INACTIVE = -1`、`DPP_AUTH_ROLE_INITIATOR = 0`、`DPP_AUTH_ROLE_RESPONDER = 1`。它决定了会话结束时清理 supplicant 资源的方式——Initiator 用 `removeDppUri` 删 URI，Responder 用 `stopDppResponder` 停监听。

---

# 3 参数怎么跨过 AIDL 边界从 Java 到 C？

> 前台把"门禁凭证"和"配网指令"写在一张工单上，交给物业内部的安检部门——工单穿越 Java 世界和 C 世界的边界靠的是 AIDL。

`DppManager` 调用的 `mWifiNative` 是 Framework 与 supplicant 之间的门面。它本身不干活，只是把调用委托给 `SupplicantStaIfaceHal`——真正的 Binder 客户端。

## 3.1 WifiNative：纯转发层

`WifiNative` 这两个 DPP 方法是一行 `return` 的纯转发——参数原样交给 `mSupplicantStaIfaceHal`，真正的跨进程 Binder 调用在下一层才发生：

```java
// service/java/com/android/server/wifi/WifiNative.java:3216
public int addDppPeerUri(@NonNull String ifaceName, @NonNull String uri) {
    return mSupplicantStaIfaceHal.addDppPeerUri(ifaceName, uri);
}

// service/java/com/android/server/wifi/WifiNative.java:3254
public boolean startDppConfiguratorInitiator(@NonNull String ifaceName, int peerBootstrapId,
        int ownBootstrapId, @NonNull String ssid, String password, String psk,
        int netRole, int securityAkm, byte[] privEcKey)  {
    return mSupplicantStaIfaceHal.startDppConfiguratorInitiator(ifaceName, peerBootstrapId,
            ownBootstrapId, ssid, password, psk, netRole, securityAkm, privEcKey);
}
```

## 3.2 SupplicantStaIfaceHal：HAL 门面

`SupplicantStaIfaceHal` 是 Framework 侧对 supplicant HAL 的封装。它有 `SupplicantStaIfaceHalHidlImpl`（HIDL）和 `SupplicantStaIfaceHalAidlImpl`（AIDL）两个实现，当前 Android 版本默认走 AIDL。`addDppPeerUri` 在这层做了空检查后转给 AIDL 实现：

```java
// service/java/com/android/server/wifi/SupplicantStaIfaceHal.java:2028
public int addDppPeerUri(@NonNull String ifaceName, @NonNull String uri) {
    synchronized (mLock) {
        String methodStr = "addDppPeerUri";
        if (mStaIfaceHal == null) {
            handleNullHal(methodStr);
            return -1;
        }
        return mStaIfaceHal.addDppPeerUri(ifaceName, uri);
    }
}
```

AIDL 实现里才是真正跨进程的 Binder 调用——`iface` 是 `ISupplicantStaIface` 的 Binder 代理，`iface.addDppPeerUri(uri)` 把参数序列化后跨进程送到 wpa_supplicant 进程：

```java
// service/java/com/android/server/wifi/SupplicantStaIfaceHalAidlImpl.java:3328
public int addDppPeerUri(@NonNull String ifaceName, @NonNull String uri) {
    synchronized (mLock) {
        final String methodStr = "addDppPeerUri";
        ISupplicantStaIface iface = checkStaIfaceAndLogFailure(ifaceName, methodStr);
        if (iface == null) {
            return -1;
        }
        try {
            return iface.addDppPeerUri(uri);
        } catch (RemoteException e) {
            handleRemoteException(e, methodStr);
        } catch (ServiceSpecificException e) {
            handleServiceSpecificException(e, methodStr);
        }
        return -1;
    }
}
```

## 3.3 AIDL 边界：ISupplicantStaIface → sta_iface.cpp

AIDL 的 `ISupplicantStaIface.addDppPeerUri(uri)` 在 supplicant 侧的实现在 `wpa_supplicant/aidl/vendor/sta_iface.cpp`。这里是 **Java 世界和 C 世界的分界线**——参数通过 Binder 传入，进入 `StaIface::addDppPeerUri`，然后调用 supplicant 核心的 `wpas_dpp_qr_code`：

```cpp
// wpa_supplicant/aidl/vendor/sta_iface.cpp:1505
StaIface::addDppPeerUriInternal(const std::string& uri)
{
#ifdef CONFIG_DPP
    struct wpa_supplicant *wpa_s = retrieveIfacePtr();
    int32_t id;

    id = wpas_dpp_qr_code(wpa_s, uri.c_str());

    if (id > 0) {
        return {id, ndk::ScopedAStatus::ok()};
    }
#endif
    return {-1, createStatus(SupplicantStatusCode::FAILURE_UNKNOWN)};
}
```

**这个函数揭示了"加 URI"的真实含义**：它不是把字符串存起来，而是直接调用 `wpas_dpp_qr_code()` 解析 URI 并登记到 bootstrapping table，返回的 `id` 就是 `struct dpp_bootstrap_info` 在表里的索引。Framework 拿到的 peer ID，本质就是这份 URI 解析结果在 supplicant 里的编号。

再看认证发起的 AIDL 实现——`startDppConfiguratorInitiatorInternal` 把 Framework 传来的结构化参数**拼装成一条控制接口命令字符串**，再喂给 `wpas_dpp_auth_init`：

```cpp
// wpa_supplicant/aidl/vendor/sta_iface.cpp:1541
std::pair<std::vector<uint8_t>, ndk::ScopedAStatus>
StaIface::startDppConfiguratorInitiatorInternal(
        uint32_t peer_bootstrap_id, uint32_t own_bootstrap_id,
        const std::string& ssid, const std::string& password,
        const std::string& psk, DppNetRole net_role, DppAkm security_akm,
        const std::vector<uint8_t> &privEcKey)
{
    struct wpa_supplicant *wpa_s = retrieveIfacePtr();
    std::string cmd = "";

    cmd += " peer=" + std::to_string(peer_bootstrap_id);
    cmd += (own_bootstrap_id > 0) ?
            " own=" + std::to_string(own_bootstrap_id) : "";
    ...
    cmd += " role=configurator";
    cmd += (ssid.empty()) ? "" : " ssid=" + ssid;
    if (!psk.empty()) {
        cmd += " psk=" + psk;
    } else {
        cmd += (password.empty()) ? "" : " pass=" + password;
    }
    ...
    cmd += " conf=";
    cmd += role;   // "ap-psk" / "sta-sae" / "sta-dpp" ...
    if (net_role == DppNetRole::STA) {
        cmd += " conn_status=1";   // DPP R2 connection status request
    }
    ...
    wpa_printf(MSG_DEBUG, "DPP initiator command: %s", cmd.c_str());

    if (wpas_dpp_auth_init(wpa_s, cmd.c_str()) == 0) {
        // Return key if input privEcKey was null/empty.
        ...
        return {std::vector<uint8_t>(), ndk::ScopedAStatus::ok()};
    }
    return {std::vector<uint8_t>(), createStatus(SupplicantStatusCode::FAILURE_UNKNOWN)};
}
```

**设计意图**：

1. **AIDL 层故意复用 supplicant 的"命令字符串"接口**，而不是新建结构化接口。这让 AIDL 层保持很薄——它只是把参数序列化成 `cmd` 字符串，真正的解析逻辑全在 supplicant 已有的 `wpas_dpp_auth_init` 里。Android 的 `SupplicantStaIfaceHal` 每个新特性都可以用这个模式接入，不需要改 supplicant 核心 API。
2. **`conf=` 参数编码了完整的配网目标**：`sta-psk`、`sta-sae`、`sta-dpp`、`ap-psk` 等，对应 `DppNetRole`（STA/AP）× `DppAkm`（PSK/SAE/DPP）的组合。`conn_status=1` 是 DPP R2 的特性——Configurator 要求 Enrollee 配网后回报连接状态（规范 §6.4.5 Connection Status Result）。
3. **DPP-AKM 的特殊处理**：如果 `security_akm == DppAkm::DPP`，说明 Configurator 要下发的是"DPP Connector"（门禁卡）而不是密码，此时会先 `dpp_configurator_add` 创建/加载 configurator 私钥，再把这个 configurator 的 ID 拼进命令。

至此，参数跨过了 Java/C 边界，进入了 supplicant 的核心世界。下一节看 `wpas_dpp_qr_code` 和 `wpas_dpp_auth_init` 在 C 世界里怎么落地。

---

# 4 supplicant 怎么把二维码变成身份信息？

> 安检部门收到工单，先翻开"登记簿"——把门禁凭证上的公钥、信道、MAC 逐项登记，发一个登记号。后面所有对话都用登记号指代这位住户。

## 4.1 wpas_dpp_qr_code：登记门禁凭证

`wpas_dpp_qr_code` 是二维码 URI 进入 supplicant 的入口（`wpa_supplicant/dpp_supplicant.c:76`）。它调用 `dpp_add_qr_code` 完成解析和登记：

```c
// wpa_supplicant/dpp_supplicant.c:76
int wpas_dpp_qr_code(struct wpa_supplicant *wpa_s, const char *cmd)
{
    struct dpp_bootstrap_info *bi;
    struct dpp_authentication *auth = wpa_s->dpp_auth;

    bi = dpp_add_qr_code(wpa_s->dpp, cmd);
    if (!bi)
        return -1;

    if (auth && auth->response_pending &&
        dpp_notify_new_qr_code(auth, bi) == 1) {
        wpa_printf(MSG_DEBUG,
                   "DPP: Sending out pending authentication response");
        // ... offchannel_send_action 补发 pending 的 Auth Response ...
    }

#ifdef CONFIG_DPP2
    dpp_controller_new_qr_code(wpa_s->dpp, bi);
#endif /* CONFIG_DPP2 */

    return bi->id;
}
```

**两个非显而易见的点**：

1. **`response_pending` 分支**：如果本机正在等一个"需要额外信息的响应"（DPP R2 的 RESPONSE_PENDING 机制，规范 §6.3.3），这时扫到新二维码可能正好补上缺的公钥，于是直接补发 pending 的认证响应。这是 DPP 为"Enrollee 不带公钥、需要 Configurator 先扫码补信息"的场景准备的特殊路径。
2. **返回 `bi->id`**：这个整数 ID 贯穿整个会话——Framework 的 `mDppRequestInfo.peerId`、后续 `wpas_dpp_auth_init` 的 `peer=` 参数、以及清理时的 `removeDppUri`，全都用这个 ID。

`dpp_add_qr_code` 内部就是我们在 §1.2 看到的 `dpp_parse_uri` 加上登记表操作：

```c
// src/common/dpp.c:4437
struct dpp_bootstrap_info * dpp_add_qr_code(struct dpp_global *dpp,
                                            const char *uri)
{
    struct dpp_bootstrap_info *bi;

    bi = dpp_parse_uri(uri);
    if (!bi)
        return NULL;

    bi->type = DPP_BOOTSTRAP_QR_CODE;
    bi->id = dpp_next_id(dpp);
    dl_list_add(&dpp->bootstrap, &bi->list);
    return bi;
}
```

`dpp_add_qr_code` 直接调用 `dpp_parse_uri` 完成 URI 解析，然后做登记：标记类型为 `DPP_BOOTSTRAP_QR_CODE`、分配 ID（`dpp_next_id`）、挂进 `dpp->bootstrap` 列表。这里没有显式的公钥合法性校验步骤——它发生在 `dpp_parse_uri_pk`（§1.2 里 `K:` 字段的解析函数）内部，也就是规范 §3.3.1 要求的公钥验证在解析时就已经完成。

## 4.2 认证准备：dpp_auth_init

登记号拿到后，认证发起进入 `wpas_dpp_auth_init`（`dpp_supplicant.c:846`）。它解析命令字符串里的 `peer=`、`own=`、`role=`、`netrole=`、`neg_freq=` 等参数，然后调用核心的 `dpp_auth_init`：

```c
// wpa_supplicant/dpp_supplicant.c:846
int wpas_dpp_auth_init(struct wpa_supplicant *wpa_s, const char *cmd)
{
    ...
    pos = os_strstr(cmd, " peer=");
    if (!pos)
        return -1;
    peer_bi = dpp_bootstrap_get_id(wpa_s->dpp, atoi(pos + 6));
    if (!peer_bi) {
        wpa_printf(MSG_INFO,
                   "DPP: Could not find bootstrapping info for the identified peer");
        return -1;
    }
    ...
    pos = os_strstr(cmd, " role=");
    if (pos) {
        pos += 6;
        if (os_strncmp(pos, "configurator", 12) == 0)
            allowed_roles = DPP_CAPAB_CONFIGURATOR;
        else if (os_strncmp(pos, "enrollee", 8) == 0)
            allowed_roles = DPP_CAPAB_ENROLLEE;
        else if (os_strncmp(pos, "either", 6) == 0)
            allowed_roles = DPP_CAPAB_CONFIGURATOR | DPP_CAPAB_ENROLLEE;
    }
    ...
    auth = dpp_auth_init(wpa_s->dpp, wpa_s, peer_bi, own_bi, allowed_roles,
                         neg_freq, wpa_s->hw.modes, wpa_s->hw.num_modes);
    if (!auth)
        goto fail;
    wpas_dpp_set_testing_options(wpa_s, auth);
    if (dpp_set_configurator(auth, cmd) < 0) {
        dpp_auth_deinit(auth);
        goto fail;
    }
    ...
    wpa_s->dpp_auth = auth;
    return wpas_dpp_auth_init_next(wpa_s);
}
```

**注意状态机的存储方式**：这里没有 `enum dpp_state`。当前版本的 supplicant 里，DPP 认证的状态不是一个大枚举，而是 `struct dpp_authentication` 里的**一组布尔标志位**。这是本仓库与老博客的第二个关键差异——老代码有个 `enum dpp_state` 列举 `DPP_STATE_AUTH_REQ` 等状态，当前源码已经重构掉了。

## 4.3 struct dpp_authentication：布尔标志位状态机

`struct dpp_authentication` 定义在 `src/common/dpp.h:286`。它同时承担"认证状态"和"密钥材料"两个角色：

```c
// src/common/dpp.h:286
struct dpp_authentication {
    struct dpp_global *global;
    void *msg_ctx;
    u8 peer_version;
    const struct dpp_curve_params *curve;
    ...
    struct dpp_bootstrap_info *peer_bi;
    struct dpp_bootstrap_info *own_bi;
    u8 waiting_pubkey_hash[SHA256_MAC_LEN];
    int response_pending;
    int reconfig;
    enum dpp_status_error auth_resp_status;
    enum dpp_status_error conf_resp_status;
    ...
    u8 i_nonce[DPP_MAX_NONCE_LEN];   // Initiator nonce
    u8 r_nonce[DPP_MAX_NONCE_LEN];   // Responder nonce
    u8 e_nonce[DPP_MAX_NONCE_LEN];   // Enrollee nonce
    u8 c_nonce[DPP_MAX_NONCE_LEN];   // Configurator nonce
    ...
    struct crypto_ec_key *own_protocol_key;
    struct crypto_ec_key *peer_protocol_key;
    struct wpabuf *req_msg;   // Auth Request 帧
    struct wpabuf *resp_msg;  // Auth Response 帧
    ...
    /* 认证流程状态位 */
    int initiator;
    int waiting_auth_resp;
    int waiting_auth_conf;
    int auth_req_ack;
    unsigned int auth_resp_tries;
    u8 allowed_roles;
    int configurator;
    int waiting_conf_result;
    int waiting_conn_status_result;
    int tx_conn_status_result_started;
    int auth_success;
    ...
};
```

**为什么用布尔标志位而不是枚举状态机？** 因为 DPP 的认证流程不是一条简单的线性状态链——Initiator 和 Responder 各有自己的等待点，且可能交织：`waiting_auth_resp`（等 Auth Response）、`waiting_auth_conf`（等 Auth Confirm）、`waiting_conf_result`（等 Config Result）、`waiting_conn_status_result`（等 Connection Status Result）这些是**可以同时为真**的（比如等 Config Result 的同时记录 auth 已成功）。用一个枚举只能表达"当前在哪个状态"，布尔位可以表达"我在等哪几件事"。这是 DPP 认证相比 WPS 的复杂性——多轮帧交换 + 多个可重试/可中断的等待点，用状态位组合比线性状态机更灵活。

---

# 5 三帧握手：Auth Request → Response → Confirm 怎么交换？

> 物业和住户开始对暗号。暗号分三轮：第一轮物业说"我是物业，我要给某位住户发门禁卡"；第二轮住户说"我是该住户，这是我的身份证明"；第三轮双方确认"对上了，建立安全通道"。

![DPP 认证三帧握手时序](assets/12-DPP-%E6%89%AB%E7%A0%81%E9%85%8D%E7%BD%91%E2%80%94%E2%80%94%E4%BB%8E-App-%E6%89%AB%E4%BA%8C%E7%BB%B4%E7%A0%81%E5%88%B0%E5%87%AD%E6%8D%AE%E8%90%BD%E5%BA%93/12-dpp-auth-handshake.svg)

## 5.1 Auth Request：Initiator 的第一句话

`dpp_auth_init`（`src/common/dpp_auth.c:1161`）是认证的真正起点。它完成三件关键的事：生成临时协议密钥对、计算 ECDH 共享密钥、构造 Auth Request 帧：

```c
// src/common/dpp_auth.c:1161
struct dpp_authentication * dpp_auth_init(struct dpp_global *dpp, void *msg_ctx,
                                          struct dpp_bootstrap_info *peer_bi,
                                          struct dpp_bootstrap_info *own_bi,
                                          u8 dpp_allowed_roles,
                                          unsigned int neg_freq,
                                          struct hostapd_hw_modes *own_modes,
                                          u16 num_modes)
{
    struct dpp_authentication *auth;
    ...
    auth = dpp_alloc_auth(dpp, msg_ctx);
    if (!auth)
        return NULL;
    ...
    auth->initiator = 1;
    auth->waiting_auth_resp = 1;
    auth->allowed_roles = dpp_allowed_roles;
    auth->configurator = !!(dpp_allowed_roles & DPP_CAPAB_CONFIGURATOR);
    auth->peer_bi = peer_bi;
    auth->own_bi = own_bi;
    auth->curve = peer_bi->curve;

    // 生成 I-nonce 和临时协议密钥对
    nonce_len = auth->curve->nonce_len;
    if (random_get_bytes(auth->i_nonce, nonce_len)) {
        wpa_printf(MSG_ERROR, "DPP: Failed to generate I-nonce");
        goto fail;
    }
    auth->own_protocol_key = dpp_gen_keypair(auth->curve);
    if (!auth->own_protocol_key)
        goto fail;
    ...
```

I-nonce 和协议密钥对就绪后，认证的密码学核心是 ECDH——用 Initiator 临时私钥和对端 bootstrapping 公钥算出一个共享点，再派生后续密钥：

```c
    // ECDH: M = pI * BR（Initiator 私钥 × 对端 bootstrapping 公钥）
    if (dpp_ecdh(auth->own_protocol_key, auth->peer_bi->pubkey,
                 auth->Mx, &secret_len) < 0)
        goto fail;
    auth->secret_len = secret_len;
    auth->Mx_len = auth->secret_len;

    // 从共享密钥 M 派生 k1
    if (dpp_derive_k1(auth->Mx, auth->secret_len, auth->k1,
                      auth->curve->hash_len) < 0)
        goto fail;
    ...
    return auth;
}
```

**密码学要点**：

1. **ECDH 共享密钥**：`M = pI * BR`——Initiator 的临时私钥 `pI` 乘以对端 bootstrapping 公钥 `BR`。这个 M 是双方共有的秘密（Responder 侧用 `pR * BI` 会得到同一个点），后续所有密钥（k1、k2、ke）都由它派生。**注意这里没有输密码、没有共享秘密——只有"我知道你的公钥，你扫了我的二维码知道了我的公钥"**。
2. **I-nonce**：Initiator 随机生成 32 字节 nonce，放在 Auth Request 里发给对方，用于防止重放攻击（Replay Protection，规范 §6.3.2）。
3. **`auth->initiator = 1` 和 `auth->waiting_auth_resp = 1`**：这两个布尔位就是状态机——"我是发起方，正在等对方的 Auth Response"。

## 5.2 帧的发送与三帧全流程

Auth Request 帧构造完成后，`wpas_dpp_auth_init_next`（`dpp_supplicant.c:753`）负责把它发出去。它按信道列表逐信道尝试：从 `auth->freq[]` 里取出下一个频率，调用 `offchannel_send_action` 发送 Action 帧，同时注册一个 2 秒的等待超时：

```c
// wpa_supplicant/dpp_supplicant.c:753 (节选)
static int wpas_dpp_auth_init_next(struct wpa_supplicant *wpa_s)
{
    struct dpp_authentication *auth = wpa_s->dpp_auth;
    ...
    freq = auth->freq[auth->freq_idx++];
    auth->curr_freq = freq;
    ...
    wpa_msg(wpa_s, MSG_INFO, DPP_EVENT_TX "dst=" MACSTR " freq=%u type=%d",
            MAC2STR(dst), freq, DPP_PA_AUTHENTICATION_REQ);
    auth->auth_req_ack = 0;
    os_get_reltime(&wpa_s->dpp_last_init);
    return offchannel_send_action(wpa_s, freq, dst,
                                  wpa_s->own_addr, broadcast,
                                  wpabuf_head(auth->req_msg),
                                  wpabuf_len(auth->req_msg),
                                  wait_time, wpas_dpp_tx_status, 0);
}
```

`offchannel_send_action` 是 supplicant 发 802.11 Action 帧的通用入口——**DPP 帧复用 802.11 标准的 Public Action 帧机制，驱动没有任何 DPP 特化代码**。这正是文章开头边界声明里说的"DPP 走通用 Action/GAS 帧"。

DPP 认证的三帧（规范 §6.3）在源码中的对应：

| 帧                      | 规范   | 收/发函数                                                    |
| ----------------------- | ------ | ------------------------------------------------------------ |
| Authentication Request  | §6.3.2 | 发送：`wpas_dpp_auth_init_next`；接收：`wpas_dpp_rx_auth_req`（在 hostapd/AP 侧是另一条路） |
| Authentication Response | §6.3.3 | 发送：`dpp_auth_req_rx`（`dpp_auth.c:668`，Responder 构造并回）；接收：`wpas_dpp_rx_auth_resp`（`dpp_supplicant.c:2109`）→ `dpp_auth_resp_rx`（`dpp_auth.c:1403`） |
| Authentication Confirm  | §6.3.4 | 发送：`dpp_auth_build_conf`（`dpp_auth.c:956`，Initiator 构造并回）；接收：`dpp_auth_conf_rx`（`dpp.h:625`） |

三帧全部通过后，`dpp_notify_auth_success`（`dpp.c:5123`）发出 `DPP-AUTH-SUCCESS` 事件，同时 `wpas_dpp_auth_success`（`dpp_supplicant.c:2085`）决定下一步走 GAS 的哪一侧：

```c
// wpa_supplicant/dpp_supplicant.c:2085
static void wpas_dpp_auth_success(struct wpa_supplicant *wpa_s, int initiator)
{
    wpa_printf(MSG_DEBUG, "DPP: Authentication succeeded");
    dpp_notify_auth_success(wpa_s->dpp_auth, initiator);
    wpas_notify_dpp_auth_success(wpa_s);
    ...
    if (wpa_s->dpp_auth->configurator)
        wpas_dpp_start_gas_server(wpa_s);
    else
        wpas_dpp_start_gas_client(wpa_s);
}
```

**注意这里的角色分岔**：认证成功后，**Configurator 启动 GAS server**（等 Enrollee 来要配置），**Enrollee 启动 GAS client**（去 Configurator 要配置）。认证握手确定了双方的身份，但配网信息（Wi-Fi 凭据）还没下发——那要等 GAS 里的 Config Request/Response 交换。

---

# 6 配置怎么通过 GAS 里的 Config Request / Response 下发？

> 暗号对上了，接下来是"发钥匙"。住户通过安全通道向物业申请"房门钥匙"，物业在加密信封里把钥匙交给他。这个"加密信封"就是 GAS 帧。

![DPP 配置下发流程](assets/12-DPP-%E6%89%AB%E7%A0%81%E9%85%8D%E7%BD%91%E2%80%94%E2%80%94%E4%BB%8E-App-%E6%89%AB%E4%BA%8C%E7%BB%B4%E7%A0%81%E5%88%B0%E5%87%AD%E6%8D%AE%E8%90%BD%E5%BA%93/12-dpp-config-flow.svg)

## 6.1 安全通道里传什么

认证握手结束时，双方已经从共享秘密派生出了会话密钥 `ke`（Key Encryption key）。此后所有配置交换都用 `ke` 加密——这保证了**Wi-Fi 密码永远不会明文出现在空中**（对比 WPS 的 PIN 泄露风险）。

DPP Configuration 协议（规范 §6.4）在 GAS 里交换两条消息：

| 消息                       | 方向                    | 规范   | 源码                                                         |
| -------------------------- | ----------------------- | ------ | ------------------------------------------------------------ |
| DPP Configuration Request  | Enrollee → Configurator | §6.4.2 | `dpp_conf_req_rx`（`dpp.c:2325`，Configurator 侧接收）       |
| DPP Configuration Response | Configurator → Enrollee | §6.4.3 | `dpp_build_conf_resp`（`dpp.c:2081`，Configurator 侧构造）；`dpp_conf_resp_rx`（`dpp.c:3374`，Enrollee 侧接收） |

## 6.2 Enrollee 收到的配置对象：不只是密码

Config Response 里装的是 **Configuration Object**（规范 §4.5）——一个 JSON 结构，除了 SSID 和密码，还可能是门禁卡（Connector）。Enrollee 侧收到后，`dpp_conf_resp_rx` 用 `ke` 解密、解析出配置对象：

```c
// src/common/dpp.c:3374
int dpp_conf_resp_rx(struct dpp_authentication *auth,
                     const struct wpabuf *resp)
{
    ...
    wrapped_data = dpp_get_attr(wpabuf_head(resp), wpabuf_len(resp),
                                DPP_ATTR_WRAPPED_DATA,
                                &wrapped_data_len);
    if (!wrapped_data || wrapped_data_len < AES_BLOCK_SIZE) {
        dpp_auth_fail(auth,
                      "Missing or invalid required Wrapped Data attribute");
        return -1;
    }

    // AES-SIV 解密：用会话密钥 ke
    if (aes_siv_decrypt(auth->ke, auth->curve->hash_len,
                        wrapped_data, wrapped_data_len,
                        1, addr, len, unwrapped) < 0) {
        dpp_auth_fail(auth, "AES-SIV decryption failed");
        goto fail;
    }
    ...
}
```

**AES-SIV** 是一种"同时加密和认证"的模式（deterministic authenticated encryption）——它不只用密钥 `ke`，还绑定了"额外关联数据"（AD，即帧头的一部分），解密失败直接认定帧被篡改。这里能看到 DPP 对加密模式的选型：SIV 模式天然抗重放、抗错误误用，适合这种"每个帧独立加解密"的轻量协议，而不像 TLS 那样需要完整的 record 层状态。

## 6.3 凭据落库：wpas_dpp_add_network

`dpp_conf_resp_rx` 成功后，`wpas_dpp_gas_resp_cb`（`dpp_supplicant.c:1890`）遍历收到的每个配置对象，调用 `wpas_dpp_handle_config_obj` → `wpas_dpp_process_config` → `wpas_dpp_add_network`，把凭据写进 supplicant 的网络配置库：

```c
// wpa_supplicant/dpp_supplicant.c:1395
static struct wpa_ssid * wpas_dpp_add_network(struct wpa_supplicant *wpa_s,
                                              struct dpp_authentication *auth,
                                              struct dpp_config_obj *conf)
{
    struct wpa_ssid *ssid;
    ...
    ssid = wpa_config_add_network(wpa_s->conf);
    if (!ssid)
        return NULL;
    wpa_config_set_network_defaults(ssid);
    ssid->disabled = 1;

    ssid->ssid = os_malloc(conf->ssid_len);
    if (!ssid->ssid)
        goto fail;
    os_memcpy(ssid->ssid, conf->ssid, conf->ssid_len);
    ssid->ssid_len = conf->ssid_len;

    if (conf->connector) {
        if (dpp_akm_dpp(conf->akm)) {
            ssid->key_mgmt = WPA_KEY_MGMT_DPP;
            ssid->ieee80211w = MGMT_FRAME_PROTECTION_REQUIRED;
        }
        ssid->dpp_connector = os_strdup(conf->connector);
        ...
    }
    ...
    if (auth->net_access_key) {
        ssid->dpp_netaccesskey = os_malloc(wpabuf_len(auth->net_access_key));
        ...
    }
    ...
    return ssid;
fail:
    wpas_notify_network_removed(wpa_s, ssid);
    wpa_config_remove_network(wpa_s->conf, ssid->id);
    return NULL;
}
```

**这步是"凭据落库"的最底层**——它把配置对象翻译成 `struct wpa_ssid`（supplicant 的网络配置块），字段映射如下：

| 配置对象字段     | wpa_ssid 字段        | 含义                                                        |
| ---------------- | -------------------- | ----------------------------------------------------------- |
| SSID             | `ssid` / `ssid_len`  | 网络名                                                      |
| passphrase / psk | `passphrase` / `psk` | PSK/SAE 的密码                                              |
| connector        | `dpp_connector`      | DPP Connector（门禁卡），对应 `key_mgmt = WPA_KEY_MGMT_DPP` |
| c_sign_key       | `dpp_csign`          | Configurator 签名公钥，Connector 验签用                     |
| net_access_key   | `dpp_netaccesskey`   | 网络访问密钥，后续 Network Introduction 握手用              |

注意 `ssid->disabled = 1`——新落库的网络默认**不自动连接**。这是因为 DPP R2 有 Connection Status Result 机制（`conn_status=1`）：Configurator 要求 Enrollee 先回报"我能不能找到这个网络、连不连得上"，回报完才由 Framework 决定是否启用。`wpas_dpp_post_process_config`（`dpp_supplicant.c:1658`）里 `dpp_config_processing < 2` 时直接不连接，`== 2` 时才 `wpas_dpp_try_to_connect`。

落库完成后，`wpas_dpp_process_config`（`dpp_supplicant.c:1628`）发出关键事件：

```c
// wpa_supplicant/dpp_supplicant.c:1628
static int wpas_dpp_process_config(struct wpa_supplicant *wpa_s,
                                   struct dpp_authentication *auth,
                                   struct dpp_config_obj *conf)
{
    struct wpa_ssid *ssid;

    if (wpa_s->conf->dpp_config_processing < 1)
        return 0;

    ssid = wpas_dpp_add_network(wpa_s, auth, conf);
    if (!ssid)
        return -1;

    wpa_msg(wpa_s, MSG_INFO, DPP_EVENT_NETWORK_ID "%d", ssid->id);

    wpas_notify_dpp_config_received(wpa_s, ssid, auth->conn_status_requested ? 1 : 0);
    ...
    return 0;
}
```

`DPP_EVENT_NETWORK_ID "%d"` 就是 `DPP-NETWORK-ID` 事件（`wpa_ctrl.h:219` 定义 `#define DPP_EVENT_NETWORK_ID "DPP-NETWORK-ID "`），它携带刚创建的网络 ID。**这是 supplicant 侧"凭据已落库"的信号，也是反向回报链的起点**。

---

# 7 反向回报：DPP-NETWORK-ID 如何回到 App？

> 物业发完钥匙，前台要给住户打个电话确认"钥匙收到了吗"。这个确认电话从 C 世界的安保部门一路打到 Java 世界的前台，再打给 App。

![DPP 结果回报事件链](assets/12-DPP-%E6%89%AB%E7%A0%81%E9%85%8D%E7%BD%91%E2%80%94%E2%80%94%E4%BB%8E-App-%E6%89%AB%E4%BA%8C%E7%BB%B4%E7%A0%81%E5%88%B0%E5%87%AD%E6%8D%AE%E8%90%BD%E5%BA%93/12-dpp-event-chain.svg)

## 7.1 从 wpa_msg 事件到 AIDL 回调

`DPP-NETWORK-ID` 事件通过 supplicant 的事件机制（`wpa_msg`）发出，AIDL 层拦截后转成 AIDL 回调。关键链条：`wpas_dpp_process_config` → `wpas_notify_dpp_config_received` → `wpas_aidl_notify_dpp_config_received` → `AidlManager::notifyDppConfigReceived`：

```c
// wpa_supplicant/aidl/vendor/aidl.cpp:706
void wpas_aidl_notify_dpp_config_received(struct wpa_supplicant *wpa_s,
        struct wpa_ssid *ssid, bool conn_status_requested)
{
    if (!wpa_s || !ssid)
        return;
    AidlManager *aidl_manager = AidlManager::getInstance();
    if (!aidl_manager)
        return;
    aidl_manager->notifyDppConfigReceived(wpa_s, ssid, conn_status_requested);
}
```

`AidlManager::notifyDppConfigReceived`（`aidl_manager.cpp:1877`）把 `struct wpa_ssid` 翻译成 AIDL 的 `DppConfigurationData`，然后回调给注册在 `ISupplicantStaIfaceCallback` 上的 Java 端：

```cpp
// wpa_supplicant/aidl/vendor/aidl_manager.cpp:1877
void AidlManager::notifyDppConfigReceived(struct wpa_supplicant *wpa_s,
        struct wpa_ssid *config, bool conn_status_requested)
{
    std::string aidl_ifname = misc_utils::charBufToString(wpa_s->ifname);
    DppConfigurationData aidl_dpp_config_data = {};

    if ((config->key_mgmt & WPA_KEY_MGMT_SAE) &&
            (wpa_s->drv_flags & WPA_DRIVER_FLAGS_SAE)) {
        aidl_dpp_config_data.securityAkm = DppAkm::SAE;
    } else if (config->key_mgmt & WPA_KEY_MGMT_PSK) {
        aidl_dpp_config_data.securityAkm = DppAkm::PSK;
    } else if (config->key_mgmt & WPA_KEY_MGMT_DPP) {
        aidl_dpp_config_data.securityAkm = DppAkm::DPP;
    } else {
        notifyDppFailure(wpa_s, DppFailureCode::NOT_SUPPORTED);
        return;
    }

    aidl_dpp_config_data.password = misc_utils::charBufToString(config->passphrase);
    aidl_dpp_config_data.psk = byteArrToVec(config->psk, 32);
    std::vector<uint8_t> aidl_ssid(config->ssid, config->ssid + config->ssid_len);
    aidl_dpp_config_data.ssid = aidl_ssid;

    if (aidl_dpp_config_data.securityAkm == DppAkm::DPP) {
        std::string connector_str = misc_utils::charBufToString(config->dpp_connector);
        aidl_dpp_config_data.dppConnectionKeys.connector
            = std::vector<uint8_t>(connector_str.begin(), connector_str.end());
        aidl_dpp_config_data.dppConnectionKeys.cSign
            = byteArrToVec(config->dpp_csign, config->dpp_csign_len);
        aidl_dpp_config_data.dppConnectionKeys.netAccessKey
            = byteArrToVec(config->dpp_netaccesskey, config->dpp_netaccesskey_len);
    }
    aidl_dpp_config_data.connStatusRequested = conn_status_requested;

    callWithEachStaIfaceCallback(aidl_ifname,
            std::bind(&ISupplicantStaIfaceCallback::onDppConfigReceived,
                      std::placeholders::_1, aidl_dpp_config_data));
}
```

**这一步完成了 C → Java 的翻译**：`struct wpa_ssid`（C 结构体）→ `DppConfigurationData`（AIDL 可序列化对象）→ `ISupplicantStaIfaceCallback::onDppConfigReceived`（Binder 回调，跨进程送到 Framework）。

## 7.2 Framework 侧接收：SupplicantStaIfaceCallbackAidlImpl

Framework 侧的 Binder 回调实现在 `SupplicantStaIfaceCallbackAidlImpl.onDppConfigReceived`（`SupplicantStaIfaceCallbackAidlImpl.java:531`）。它把 AIDL 的配置数据组装回 `WifiConfiguration`，再转发给 `DppManager` 注册的回调：

```java
// service/java/com/android/server/wifi/SupplicantStaIfaceCallbackAidlImpl.java:531
@Override
public void onDppConfigReceived(DppConfigurationData configData) {
    processDppConfigReceivedEvent(configData.ssid, configData.password, configData.psk,
            configData.securityAkm, configData.dppConnectionKeys,
            configData.connStatusRequested);
}

private void processDppConfigReceivedEvent(byte[] ssid, String password,
        byte[] psk, int securityAkm, DppConnectionKeys keys, boolean connStatusRequested) {
    if (mStaIfaceHal.getDppCallback() == null) {
        Log.e(TAG, "onDppSuccessConfigReceived callback is null");
        return;
    }
    WifiConfiguration newWifiConfiguration = new WifiConfiguration();
    WifiSsid wifiSsid = mSsidTranslator.getTranslatedSsid(WifiSsid.fromBytes(ssid));
    newWifiConfiguration.SSID = wifiSsid.toString();

    if (password != null) {
        newWifiConfiguration.preSharedKey = "\"" + password + "\"";
    } else if (psk != null) {
        newWifiConfiguration.preSharedKey = Arrays.toString(psk);
    }
    // ... AKM 映射与 DPP Connection Keys 设置 ...
    mStaIfaceHal.getDppCallback().onSuccessConfigReceived(newWifiConfiguration,
            connStatusRequested);
}
```

注意这里把 supplicant 的 AKM 枚举映射回 Framework 的安全类型：`DppAkm.SAE → SECURITY_TYPE_SAE`、`DppAkm.PSK/PSK_SAE → SECURITY_TYPE_PSK`、`DppAkm.DPP → SECURITY_TYPE_DPP`。这个映射在反向链条的两端（supplicant 的 `notifyDppConfigReceived` 和 Framework 的 `processDppConfigReceivedEvent`）各做了一次，保证两边字段语义一致。

## 7.3 DppManager 收口：onSuccessConfigReceived

`mStaIfaceHal.getDppCallback()` 返回的是 `DppManager` 在构造时注册的 `mDppEventCallback`（`DppManager.java:84`），它把事件 post 到 WiFi 线程，最终落到 `DppManager.onSuccessConfigReceived`：

```java
// service/java/com/android/server/wifi/DppManager.java:671
private void onSuccessConfigReceived(WifiConfiguration newWifiConfiguration,
        boolean connStatusRequested) {
    try {
        if (mDppRequestInfo == null) {
            Log.e(TAG, "onSuccessConfigReceived event without a request information object");
            return;
        }
        logd("onSuccessConfigReceived: connection status requested: " + connStatusRequested);
        ...
        NetworkUpdateResult networkUpdateResult = mWifiConfigManager
                .addOrUpdateNetwork(newWifiConfiguration, mDppRequestInfo.uid);

        if (networkUpdateResult.isSuccess()) {
            mDppMetrics.updateDppEnrolleeSuccess();
            ...
            mDppRequestInfo.connStatusRequested = connStatusRequested;
            mDppRequestInfo.callback.onSuccessConfigReceived(
                    networkUpdateResult.getNetworkId());
        } else {
            Log.e(TAG, "DPP configuration received, but failed to update network");
            mDppMetrics.updateDppFailure(EasyConnectStatusCallback
                    .EASY_CONNECT_EVENT_FAILURE_CONFIGURATION);
            mDppRequestInfo.callback.onFailure(EasyConnectStatusCallback
                    .EASY_CONNECT_EVENT_FAILURE_CONFIGURATION, null, null, new int[0]);
        }
    } catch (RemoteException e) {
        Log.e(TAG, "Callback failure");
    }
    ...
    if (!mDppRequestInfo.connStatusRequested) {
        cleanupDppResources();
    } else {
        Log.d(TAG, "Wait for enrollee to send connection status");
    }
}
```

**这是"Framework 落库"**：`mWifiConfigManager.addOrUpdateNetwork` 把 `WifiConfiguration` 写进 Android 的 WiFi 配置数据库。至此，从二维码扫描到 WiFi 配置落库的完整链路走完——supplicant 的 `wpa_ssid` 和 Framework 的 `WifiConfiguration` 都有了这条网络。

## 7.4 成功回报：Configurator 的 CONFIGURATION_SENT

Enrollee 侧走的是"收到配置落库"（`onSuccessConfigReceived`）。Configurator 侧走的是另一条成功路径——`DPP-CONF-SENT` 事件，表示"我已经把配置发出去了"：

```
DPP-CONF-SENT 事件 (wpa_ctrl.h:202)
→ wpas_notify_dpp_config_sent (notify.c:1215)
→ wpas_aidl_notify_dpp_config_sent (aidl.cpp:723)
→ AidlManager::notifyDppConfigSent (aidl_manager.cpp:1930)
→ ISupplicantStaIfaceCallback::onDppSuccessConfigSent
→ SupplicantStaIfaceCallbackAidlImpl.onDppSuccessConfigSent (java:586)
→ getDppCallback().onSuccess(DppEventType.CONFIGURATION_SENT)
→ DppManager.onSuccess (java:747) → callback.onSuccess(EASY_CONNECT_EVENT_SUCCESS_CONFIGURATION_SENT)
→ EasyConnectCallbackProxy.onSuccess (WifiManager.java:9619)
→ EasyConnectStatusCallback.onConfiguratorSuccess(status)
```

`DppManager.onSuccess` 里做了 HAL 状态码到 App 状态码的转换：

```java
// service/java/com/android/server/wifi/DppManager.java:747
private void onSuccess(int dppStatusCode) {
    ...
    int dppSuccessCode;
    // Convert from HAL codes to WifiManager/user codes
    switch (dppStatusCode) {
        case DppEventType.CONFIGURATION_SENT:
            mDppMetrics.updateDppR1CapableEnrolleeResponderDevices();
            dppSuccessCode = EasyConnectStatusCallback
                    .EASY_CONNECT_EVENT_SUCCESS_CONFIGURATION_SENT;
            // For Configurator STA, generate self signed keys for network access.
            generateSelfDppConfiguration(mDppRequestInfo.networkId);
            break;
        case DppEventType.CONFIGURATION_APPLIED:
            dppSuccessCode = EasyConnectStatusCallback
                    .EASY_CONNECT_EVENT_SUCCESS_CONFIGURATION_APPLIED;
            break;
        default:
            ...
    }
    mDppMetrics.updateDppConfiguratorSuccess(dppSuccessCode);
    mDppRequestInfo.callback.onSuccess(dppSuccessCode);
    ...
    cleanupDppResources();
}
```

**这里有个隐藏的 R1/R2 能力探测**：`updateDppR1CapableEnrolleeResponderDevices()` 和 `updateDppR2CapableEnrolleeResponderDevices()`（在 `onProgress` 的 `CONFIGURATION_SENT_WAITING_RESPONSE` 分支）——Framework 通过对方是否触发 `conn_status` / 等待响应来推断 Enrollee 支持 DPP R1 还是 R2，用于统计和后续行为选择。如果对方收到配置就立刻 `CONFIGURATION_SENT`（不等连接状态回报），说明它是 R1 设备。

## 7.5 App 收到回调

链条最后一步：`mDppRequestInfo.callback` 是 `IDppCallback` 的 Binder 代理，它跨进程回调到 App 侧注册的 `EasyConnectCallbackProxy`（`WifiManager.java:9599`）：

```java
// framework/java/android/net/wifi/WifiManager.java:9599
private static class EasyConnectCallbackProxy extends IDppCallback.Stub {
    private final Executor mExecutor;
    private final EasyConnectStatusCallback mEasyConnectStatusCallback;

    @Override
    public void onSuccess(int status) {
        Log.d(TAG, "Easy Connect onSuccess callback");
        Binder.clearCallingIdentity();
        mExecutor.execute(() -> {
            mEasyConnectStatusCallback.onConfiguratorSuccess(status);
        });
    }

    @Override
    public void onSuccessConfigReceived(int newNetworkId) {
        Log.d(TAG, "Easy Connect onSuccessConfigReceived callback");
        Binder.clearCallingIdentity();
        mExecutor.execute(() -> {
            mEasyConnectStatusCallback.onEnrolleeSuccess(newNetworkId);
        });
    }

    @Override
    public void onFailure(int status, String ssid, String channelList,
            int[] operatingClassArray) {
        Log.d(TAG, "Easy Connect onFailure callback");
        Binder.clearCallingIdentity();
        mExecutor.execute(() -> {
            SparseArray<int[]> channelListArray = parseDppChannelList(channelList);
            mEasyConnectStatusCallback.onFailure(status, ssid, channelListArray,
                    operatingClassArray);
        });
    }
}
```

`EasyConnectCallbackProxy` 通过 `Binder.clearCallingIdentity()` 清除 Binder 调用身份后，把回调投递到 App 指定的 `Executor` 线程，最终调用 App 实现的 `EasyConnectStatusCallback`。这里完成了**从 C 世界到 App 的完整反向链条**。

---

# 8 异常与失败：配网失败时发生了什么？

> 住户门禁凭证扫出来是坏码、暗号对不上、钥匙发出去住户说没收到——物业有一套失败话术，每种情况对应一个失败码。

DPP 的失败码分两层：supplicant/HAL 层（`DppFailureCode`，`SupplicantStaIfaceHal.java:92`）和 App 层（`EasyConnectStatusCallback` 的 `EASY_CONNECT_EVENT_FAILURE_*`）。`DppManager.onFailure`（`DppManager.java:977`）负责把前者翻译成后者。

| HAL 失败码 (`DppFailureCode`) | 值   | App 失败码 (`EasyConnectStatusCallback`)                     | 值   | 含义                                   |
| ----------------------------- | ---- | ------------------------------------------------------------ | ---- | -------------------------------------- |
| `INVALID_URI`                 | 0    | `EASY_CONNECT_EVENT_FAILURE_INVALID_URI`                     | -1   | 二维码/URI 解析失败                    |
| `AUTHENTICATION`              | 1    | `EASY_CONNECT_EVENT_FAILURE_AUTHENTICATION`                  | -2   | 认证握手失败                           |
| `NOT_COMPATIBLE`              | 2    | `EASY_CONNECT_EVENT_FAILURE_NOT_COMPATIBLE`                  | -3   | 双方能力不兼容                         |
| `CONFIGURATION`               | 3    | `EASY_CONNECT_EVENT_FAILURE_CONFIGURATION`                   | -4   | 配置交换失败                           |
| `BUSY`                        | 4    | `EASY_CONNECT_EVENT_FAILURE_BUSY`                            | -5   | 已有 DPP 会话在进行                    |
| `TIMEOUT`                     | 5    | `EASY_CONNECT_EVENT_FAILURE_TIMEOUT`                         | -6   | 超时（Initiator 40s / Responder 300s） |
| `FAILURE`                     | 6    | `EASY_CONNECT_EVENT_FAILURE_GENERIC`                         | -7   | 通用失败                               |
| `NOT_SUPPORTED`               | 7    | `EASY_CONNECT_EVENT_FAILURE_NOT_SUPPORTED`                   | -8   | 特性不支持                             |
| `CONFIGURATION_REJECTED`      | 8    | `EASY_CONNECT_EVENT_FAILURE_ENROLLEE_REJECTED_CONFIGURATION` | -12  | Enrollee 拒绝了配置                    |
| `CANNOT_FIND_NETWORK`         | 9    | `EASY_CONNECT_EVENT_FAILURE_CANNOT_FIND_NETWORK`             | -10  | Enrollee 找不到网络                    |
| `ENROLLEE_AUTHENTICATION`     | 10   | `EASY_CONNECT_EVENT_FAILURE_ENROLLEE_AUTHENTICATION`         | -11  | Enrollee 认证失败                      |
| `URI_GENERATION`              | 11   | `EASY_CONNECT_EVENT_FAILURE_URI_GENERATION`                  | -13  | Responder 生成 URI 失败                |

另有两个 App 侧失败码 `EASY_CONNECT_EVENT_FAILURE_INVALID_NETWORK`（-9）与 `EASY_CONNECT_EVENT_FAILURE_ENROLLEE_FAILED_TO_SCAN_NETWORK_CHANNEL`（-14）没有对应的 HAL `DppFailureCode`，由其它路径上报，故未列入本表。

**超时是配网最常见的失败路径**。Initiator 超时 40 秒（`DppManager.java:75`），超时后 `timeoutDppRequest()`（`DppManager.java:167`）先 `mWifiNative.stopDppInitiator` 清理 supplicant 侧的认证，再回 `onFailure(TIMEOUT)`。supplicant 侧也有自己的重试逻辑：`wpas_dpp_auth_init_next` 里每个信道发 Action 帧后等 2 秒（`wpa_s->dpp_resp_wait_time ? : 2000`），所有信道试完一轮（默认 5 轮 `max_tries`）没响应就发 `DPP-AUTH-INIT-FAILED`。

**BUSY 是第二个常见失败**：`DppManager` 单会话锁，前一个会话没结束（没超时、没成功、没失败），新请求直接回 `FAILURE_BUSY`。这要求 App 在发起前先确认没有进行中的会话，或者在收到 BUSY 后提示用户"上一个配网还没完成"。

---

# 9 总结：一条无密码的配网链

把整条链收拢成一张图：

```
[App] WifiManager.startEasyConnectAsConfiguratorInitiator(uri, networkId, role, callback)
  → [Framework] WifiServiceImpl → DppManager（单会话锁 + 40s 超时）
    → mWifiNative.addDppPeerUri / startDppConfiguratorInitiator
      → [HAL] SupplicantStaIfaceHal → SupplicantStaIfaceHalAidlImpl
        ── AIDL 边界 ──
        → [supplicant C] sta_iface.cpp → wpas_dpp_qr_code / wpas_dpp_auth_init
          → dpp_add_qr_code（解析 URI → bootstrap_info，返回 peer ID）
          → dpp_auth_init（ECDH → k1 → Auth Request）
            → offchannel_send_action 发 Auth Request
            → 收 Auth Response → dpp_auth_resp_rx → 回 Auth Confirm
            → wpas_dpp_auth_success → GAS server (Configurator) / GAS client (Enrollee)
          → GAS Config Request/Response（ke 加密）
            → dpp_conf_req_rx / dpp_build_conf_resp / dpp_conf_resp_rx
            → wpas_dpp_add_network（写 wpa_ssid）→ DPP-NETWORK-ID 事件
        ── AIDL 边界（反向）──
        → AidlManager::notifyDppConfigReceived → onDppConfigReceived
  → [Framework] SupplicantStaIfaceCallbackAidlImpl → DppManager.onSuccessConfigReceived
    → WifiConfigManager.addOrUpdateNetwork（Framework 落库）
    → IDppCallback → EasyConnectCallbackProxy → EasyConnectStatusCallback
```

**设计亮点回顾**：

1. **扫码 ≠ 输密码**：二维码里只有公钥、信道、MAC——没有密码。信任建立在 ECDH 共享密钥 + 三帧认证握手 + AES-SIV 加密隧道的组合上，Wi-Fi 密码只在 `ke` 加密的 GAS 响应里出现一次。
2. **两端落库、单向收口**：supplicant 把凭据写进 `wpa_ssid`（`wpas_dpp_add_network`），Framework 再翻译成 `WifiConfiguration` 写进 `WifiConfigManager`。`DppManager` 是所有会话状态的单一收口点——单会话锁、超时、Binder 死亡清理、失败码转换，全在它身上。
3. **布尔位状态机**：认证过程用 `struct dpp_authentication` 里的 `waiting_auth_resp`、`waiting_auth_conf`、`waiting_conf_result`、`waiting_conn_status_result` 等标志位组合表达"正在等哪几件事"，比线性枚举状态机更贴合多轮帧交换的异步本质。
4. **AIDL 层刻意做薄**：`sta_iface.cpp` 只是把结构化参数拼成命令字符串喂给 supplicant 既有接口，让 DPP 新特性可以薄接入，不必改 supplicant 核心 API。

别误以为 DPP 就这些，DPP-over-TCP（规范 §2.3，`dpp_tcp_init`）用于远程配网；Enterprise provisioning（§4.5，EAP-TLS 证书下发）；Network Access（§6.6.6）是配网成功后 Connector 驱动的二次握手，不在此列；驱动侧——DPP 帧走 802.11 通用 Action/GAS，`offchannel_send_action` 之后就是通用帧收发，驱动没有 DPP 专属代码。

这一章，我们用二维码把一场"无密码配网"从 App 追到了 supplicant 的网络库——扫一张"门禁凭证"，换来"门禁卡"和"房门钥匙"。但这里藏着前提：**住户得先贴得出那张"门禁凭证"**。那些没有屏幕、贴不了二维码贴纸的设备，连凭证都没有，钥匙怎么发？DPP 3.0（规范 §5.6）给出了答案：**PKEX（Public Key Exchange）**——双方各自输入同一个"分享码"（passphrase），在不扫码的情况下完成公钥交换。

---

**源码仓库**：

- AOSP wpa_supplicant 8: [https://w1.fi/wpa_supplicant/](https://w1.fi/wpa_supplicant/)
- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)

**相关规范**：

- Wi-Fi Alliance, "Wi-Fi Easy Connect Specification v3.0"
  - §4.5 Configuration Object；§5 Bootstrapping of Trust；§5.2.1 Bootstrapping Information Format；§5.6 PKEX
  - §6.3 DPP Authentication protocol；§6.4 DPP Configuration protocol；§6.4.5 Connection Status Result；§6.6.6 Network Access Protocols
