---
title: STA 连接（二）Supplicant 层 L2 连接全链路
top: 1
related_posts: true
abbrlink: d714aa13
date: 2026-09-19 20:33:16
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 在上一篇中，我们站在前台视角，看了 Framework 的 `ClientModeImpl` 状态机如何收到 `CMD_START_CONNECT`，然后调用 `WifiNative.connectToNetwork()` 发起连接。现在命令已经到了后场——本文从 Supplicant 进程的 AIDL 入口开始，追踪添加网络配置、推送参数、选择网络、SME 认证/关联决策、驱动命令下发，一直到 `NL80211_CMD_AUTHENTICATE` 和 `NL80211_CMD_ASSOCIATE` 下发，并贯穿 EAPOL 四次握手到 `WPA_COMPLETED` 全过程。这是 Supplicant 层 L2 连接的完整全链路。

> 前台（Framework）把客人的入住申请表递给了后场的制卡机（Supplicant）。制卡机需要做几件事：把客人的信息录入系统（`addNetwork` + 逐个 setter 推送配置），在系统里选中这条记录触发制卡流程（`select`），通过安保系统验证客人身份（Auth），签入住单（Assoc），最后用对讲机（nl80211）把指令编码成门禁系统能理解的格式下发到客房控制器（驱动）。本篇就跟着这张房卡，走完从录入到下发对讲机指令的完整旅程。

> 本文聚焦 Supplicant 内部逻辑和 nl80211 命令下发——驱动收到命令后的固件交互和帧交换在后续驱动层连接执行篇展开，EAPOL 四次握手中 PTK 派生的密码学细节在后续安全协议篇中深入。

> 全文约 25 分钟读完。如果只关心整体流程，可以跳过代码块，只看每节末尾的「主要功能」小结和 §7 的调用链全景图。

<!--more-->

# 本章导读

整个 Supplicant 就像酒店后场的制卡机——前台递来入住申请表，制卡机录入客人信息、验证身份、签入住单、发房卡，全程自动化。

本文沿链路逐段展开：

- `ISupplicantStaIface.addNetwork()` 如何创建网络配置，以及 `wpa_supplicant_add_network()` 内部做了什么
- `WifiConfiguration` 的 SSID、BSSID、key_mgmt、PSK、EAP 等字段如何通过 AIDL setter 逐个推送到 supplicant 的 `wpa_ssid` 结构体
- `networkHandle.select()` 如何触发 `wpa_supplicant_select_network()`，进而启动扫描或快速关联
- SME（Station Management Entity）的完整概念：supplicant 构造 auth/assoc 帧 vs 驱动固件自己处理
- `sme_send_authentication()` 的 auth_alg 决策枢纽——OPEN / SAE / FT / FILS 四条分叉的完整逻辑
- SME 认证流程：从 `sme_auth_start_cb()` 构造认证帧，到 `driver_nl80211` 下发 `NL80211_CMD_AUTHENTICATE`
- Auth 响应处理：驱动回调 → `wpa_supplicant_event()` → `sme_event_auth()` → `sme_associate()` → 下发 `NL80211_CMD_ASSOCIATE`
- Assoc 完成后 EAPOL 四次握手的 supplicant 侧处理：`eapol_sm_step()` 驱动 EAPOL 状态机，`wpa_sm_rx_eapol()` 分发 msg 1/4 → msg 2/4 → msg 3/4 → msg 4/4
- SME 模式（两步走 `CMD_AUTHENTICATE`+`CMD_ASSOCIATE`）vs 非 SME 模式（一步走 `CMD_CONNECT`）的本质区别

本文所有代码块取自 wpa_supplicant 真实源码，为可读性做了精简（去掉 log 语句、license 头、条件编译分支），关键路径保留完整；精简处标注 `// ...省略...`，文件路径标注在代码块首行。

---

# 1 制卡机收到指令——AIDL addNetwork 和参数翻译

Framework 通过 AIDL 跨进程调用 `ISupplicantStaIface.addNetwork()`，wpa_supplicant 创建一个空的 `wpa_ssid` 网络配置块，然后 Framework 逐个调用 AIDL setter（`setSsid`、`setPskPassphrase`、`setKeyMgmt` 等）把 `WifiConfiguration` 的字段推入这个配置块，最后 `select()` 激活连接。

在前一篇中我们看到 Framework 的 `SupplicantStaIfaceHal.connectToNetwork()` 分三步走：`removeAllNetworks`（清旧）→ `addNetworkAndSaveConfig`（建新）→ `networkHandle.select()`（激活）。其中 `addNetworkAndSaveConfig` 是整个命令传递中最复杂的环节——需要把 Java 的 `WifiConfiguration` 对象翻译成 wpa_supplicant 的 C 结构体。

## 1.1 addNetwork 的 AIDL 路径——从 Java 到 C 结构体

Framework 侧的 `addNetwork(ifaceName)` 通过 AIDL 调用 `ISupplicantStaIface.addNetwork()`。这条调用跨越进程边界，到达 wpa_supplicant 进程中的 C++ AIDL 服务端：

```cpp
// wpa_supplicant/aidl/vendor/sta_iface.cpp（源码有部分精简）
ndk::ScopedAStatus StaIface::addNetwork(
    std::shared_ptr<ISupplicantStaNetwork>* _aidl_return)
{
    return validateAndCall(
        [this, _aidl_return]() -> ndk::ScopedAStatus {
            return addNetworkInternal(_aidl_return);
        });
}

ndk::ScopedAStatus StaIface::addNetworkInternal(
    std::shared_ptr<ISupplicantStaNetwork>* _aidl_return)
{
    struct wpa_supplicant *wpa_s = retrieveIfacePtr();
    struct wpa_ssid *ssid = wpa_supplicant_add_network(wpa_s);
    if (!ssid)
        return ndk::ScopedAStatus::fromServiceSpecificError(
            ERROR_UNKNOWN, "Failed to add network");

    // 把新建的 wpa_ssid 包装成 AIDL ISupplicantStaNetwork 对象返回
    *_aidl_return = aidl_manager->getStaNetworkAidlObjectByIfnameAndNetworkId(
        wpa_s->ifname, ssid->id, &network);
    return ndk::ScopedAStatus::ok();
}
```

主要功能：

- `addNetwork()` 是 AIDL binder 方法的入口，调用 `validateAndCall()` 转到 `addNetworkInternal()` 执行实际逻辑——这是 AIDL 层的标准模式
- `wpa_supplicant_add_network(wpa_s)` 是核心调用——它创建一个新的 `struct wpa_ssid` 并挂到配置链表中
- `getStaNetworkAidlObjectByIfnameAndNetworkId()` 把 C 结构体包装成 AIDL binder 对象，后续 Framework 通过这个对象调用 setter 配置网络参数
- `aidl_manager` 是 AIDL 服务端的全局管理器单例，负责维护 `ifname + network_id → ISupplicantStaNetwork` binder 对象的映射，避免重复创建

在 wpa_supplicant 核心层，`wpa_supplicant_add_network()` 的实现非常简洁：

```c
// wpa_supplicant/wpa_supplicant.c（源码有部分精简）
struct wpa_ssid * wpa_supplicant_add_network(struct wpa_supplicant *wpa_s)
{
    struct wpa_ssid *ssid;

    ssid = wpa_config_add_network(wpa_s->conf);
    if (!ssid)
        return NULL;
    wpas_notify_network_added(wpa_s, ssid);
    ssid->disabled = 1;           // 新建网络默认 disabled
    wpa_config_set_network_defaults(ssid);
    return ssid;
}
```

主要功能：

- `wpa_config_add_network()` 在 `wpa_s->conf->ssid` 链表末尾分配并追加一个新的 `wpa_ssid` 节点
- **关键设计**：新建网络 `disabled = 1` ——制卡机先录入信息但不激活，等所有字段填完再 `select()` 启用
- `wpa_config_set_network_defaults()` 填充默认参数（proto=RSN、pairwise=CCMP、group=CCMP 等）

addNetwork 就像制卡机拿出一张空白房卡——卡上什么都没有，disabled=1 意味着这张卡还不能用。接下来要通过 AIDL setter 把客人的信息一项一项写进去。

## 1.2 参数逐个推送——WifiConfiguration 到 wpa_ssid 的翻译引擎

Framework 拿到 `addNetwork` 返回的 `SupplicantStaNetworkHalAidlImpl` 对象后，调用 `network.saveWifiConfiguration(config)`——这个函数把 `WifiConfiguration` 的每一个字段通过 AIDL setter 逐个推送到 wpa_supplicant。

在 wpa_supplicant 侧，每个 setter 由 `sta_network.cpp` 中的 handler 接收。以下是关键字段的翻译逻辑：

**SSID 推送**：

```cpp
// wpa_supplicant/aidl/vendor/sta_network.cpp（源码有部分精简）
ndk::ScopedAStatus StaNetwork::setSsidInternal(const std::vector<uint8_t>& ssid)
{
    struct wpa_ssid *wpa_ssid = retrieveNetworkPtr();
    if (ssid.size() > SSID_MAX_LEN)  // 32 bytes max
        return errorStatus(ERROR_INVALID_ARGS, "SSID too long");

    os_memcpy(wpa_ssid->ssid, ssid.data(), ssid.size());
    wpa_ssid->ssid_len = ssid.size();

    // 如果 passphrase 已设置，SSID 改变后需要重新计算 PSK
    if (wpa_ssid->passphrase)
        wpa_config_update_psk(wpa_ssid);

    resetInternalStateAfterParamsUpdate();
    return ndk::ScopedAStatus::ok();
}
```

主要功能：

- SSID 以原始字节数组传递——不做引号包裹或十六进制转换
- 长度上限：802.11 规定 SSID 最长 32 字节（`SSID_MAX_LEN`）
- **关键联动**：如果 passphrase 已经先设置了，SSID 变更后必须重新调用 `wpa_config_update_psk()` 计算 PSK——因为 PSK = PBKDF2(passphrase, SSID, 4096, 256)

**PSK / 密码推送**：

```cpp
// wpa_supplicant/aidl/vendor/sta_network.cpp（源码有部分精简）
ndk::ScopedAStatus StaNetwork::setPskPassphraseInternal(
    const std::string& passphrase)
{
    struct wpa_ssid *wpa_ssid = retrieveNetworkPtr();
    // 验证 passphrase 长度 8-63，不包含控制字符
    if (passphrase.size() < 8 || passphrase.size() > 63)
        return errorStatus(ERROR_INVALID_ARGS, "Invalid passphrase length");
    for (char c : passphrase) {
        if (c < 32 || c > 126)
            return errorStatus(ERROR_INVALID_ARGS,
                               "Invalid character in passphrase");
    }

    os_strlcpy(wpa_ssid->passphrase, passphrase.c_str(),
               sizeof(wpa_ssid->passphrase));
    if (wpa_ssid->ssid_len > 0)
        wpa_config_update_psk(wpa_ssid);  // 如果 SSID 已设，立即计算 PSK

    resetInternalStateAfterParamsUpdate();
    return ndk::ScopedAStatus::ok();
}

ndk::ScopedAStatus StaNetwork::setPskInternal(const std::vector<uint8_t>& psk)
{
    struct wpa_ssid *wpa_ssid = retrieveNetworkPtr();
    os_memcpy(wpa_ssid->psk, psk.data(), PMK_LEN);  // 32 bytes
    wpa_ssid->psk_set = 1;                           // 标记 PSK 已直接设置
    wpa_ssid->passphrase[0] = '\0';                  // 清除 passphrase
    resetInternalStateAfterParamsUpdate();
    return ndk::ScopedAStatus::ok();
}
```

主要功能：

- `setPskPassphrase()` 接收 ASCII 密码短语（8-63 字符），存入 `wpa_ssid->passphrase`；如果 SSID 已经设置，立即调用 `wpa_config_update_psk()` 计算 32 字节 PSK
- `setPsk()` 接收原始 256 位 PSK（64 字符 hex → 32 字节二进制），直接存入 `wpa_ssid->psk[]`，并清除 passphrase（二者互斥）
- `psk_set = 1` 标记表示 PSK 已直接设置，supplicant 后续不会尝试从 passphrase 重新派生

**key_mgmt 映射——安全协议选择**：

```cpp
// wpa_supplicant/aidl/vendor/sta_network.cpp（源码有部分精简）
ndk::ScopedAStatus StaNetwork::setKeyMgmtInternal(int32_t key_mgmt_mask)
{
    struct wpa_ssid *wpa_ssid = retrieveNetworkPtr();
    wpa_ssid->key_mgmt = 0;

    if (key_mgmt_mask & KeyMgmtMask::NONE)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_NONE;
    if (key_mgmt_mask & KeyMgmtMask::WPA_PSK)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_PSK;
    if (key_mgmt_mask & KeyMgmtMask::WPA_EAP)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_IEEE8021X;
    if (key_mgmt_mask & KeyMgmtMask::SAE)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_SAE;
    if (key_mgmt_mask & KeyMgmtMask::OWE)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_OWE;
    if (key_mgmt_mask & KeyMgmtMask::SUITE_B_192)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_IEEE8021X_SUITE_B_192;

    // 自动启用对应 FT 变体（如果 key_mgmt 包含 PSK/SAE/EAP）
    if (wpa_ssid->key_mgmt & WPA_KEY_MGMT_PSK)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_FT_PSK;
    if (wpa_ssid->key_mgmt & WPA_KEY_MGMT_SAE)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_FT_SAE;
    if (wpa_ssid->key_mgmt & WPA_KEY_MGMT_IEEE8021X)
        wpa_ssid->key_mgmt |= WPA_KEY_MGMT_FT_IEEE8021X;

    resetInternalStateAfterParamsUpdate();
    return ndk::ScopedAStatus::ok();
}
```

主要功能：

- AIDL 的 `KeyMgmtMask` 是位掩码——对应 Framework 的 `WifiConfiguration.KeyMgmt`
- **自动启用 FT 变体**：如果勾选了 WPA_PSK，自动添加 FT_PSK；如果勾选了 SAE，自动添加 FT_SAE——这是 supplicant 对 802.11r 快速漫游的默认行为
- `key_mgmt` 会被后续 `sme_send_authentication()` 中的 auth_alg 决策枢纽使用——它决定了走 OPEN 认证还是 SAE 认证

**BSSID / EAP 等其他字段**：

| AIDL Setter            | 实际写入的 `wpa_ssid` 字段       | 说明                                    |
| ---------------------- | -------------------------------- | --------------------------------------- |
| `setBssid()`           | `wpa_ssid->bssid[]`, `bssid_set` | 零 BSSID 表示"匹配任意 AP"              |
| `setProto()`           | `wpa_ssid->proto`                | WPA/RSN/WAPI/OSEN 协议版本              |
| `setGroupCipher()`     | `wpa_ssid->group_cipher`         | 组播加密套件（CCMP/TKIP/GCMP）          |
| `setPairwiseCipher()`  | `wpa_ssid->pairwise_cipher`      | 单播加密套件                            |
| `setRequirePmf()`      | `wpa_ssid->ieee80211w`           | 管理帧保护（PMF）开关                   |
| `setEapMethod()`       | `wpa_ssid->eap.eap_methods[]`    | EAP 方法（TLS/TTLS/PEAP/SIM/AKA）       |
| `setEapIdentity()`     | `wpa_ssid->eap.identity`         | EAP 身份标识                            |
| `setEapPhase2Method()` | `wpa_ssid->eap.phase2`           | 第二阶段 EAP 方法（如 `auth=MSCHAPV2`） |

每个 setter 最后都调用 `resetInternalStateAfterParamsUpdate()`。这个函数做了什么？

```cpp
// wpa_supplicant/aidl/vendor/sta_network.cpp（源码有部分精简）
void StaNetwork::resetInternalStateAfterParamsUpdate()
{
    struct wpa_ssid *wpa_ssid = retrieveNetworkPtr();
    struct wpa_supplicant *wpa_s = retrieveIfacePtr();

    // 如果修改的是当前正在使用的网络，刷掉 PMKSA 缓存和 EAP 会话
    if (wpa_s->current_ssid == wpa_ssid) {
        wpa_sm_pmksa_cache_flush(wpa_s->wpa, wpa_ssid);
        eapol_sm_invalidate_cached_session(wpa_s->eapol);
    }
}
```

主要功能：

- **参数变更触发状态重置**：如果修改的是当前连接的网络，之前建立的 PMKSA 缓存和 EAP 会话立即失效——因为证书/密码变了，旧的安全上下文不再有效
- 这就是为什么 Framework 修改 WifiConfiguration 后需要 save+reconnect——任何关键参数的修改都会触发安全上下文的清理

`saveWifiConfiguration()` 就像前台把申请表上的每栏信息（姓名、身份证号、房型）逐格念给制卡机录入。SSID 是姓名，PSK 是身份证号，key_mgmt 是验证方式。每个 AIDL setter 就是制卡机收到一条"姓名栏 = 张三"的指令并写入对应字段。

## 1.3 select()——按下制卡按钮

所有字段写完后，Framework 调用 `networkHandle.select()` 激活这张卡：

```java
// SupplicantStaNetworkHalAidlImpl.java（源码有部分精简）
public boolean select() {
    synchronized (mLock) {
        try {
            mISupplicantStaNetwork.select();
            return true;
        } catch (RemoteException e) {
            handleRemoteException(e, "select");
        } catch (ServiceSpecificException e) {
            handleServiceSpecificException(e, "select");
        }
        return false;
    }
}
```

在 wpa_supplicant 侧：

```cpp
// wpa_supplicant/aidl/vendor/sta_network.cpp（源码有部分精简）
ndk::ScopedAStatus StaNetwork::selectInternal()
{
    struct wpa_supplicant *wpa_s = retrieveIfacePtr();
    struct wpa_ssid *wpa_ssid = retrieveNetworkPtr();

    // P2P 永久禁用检查
    // disabled 有三种取值：0=启用，1=临时禁用（可重新启用），2=永久禁用
    // disabled==2 用于 P2P Persistent Group：当用户删除某个已配对的 P2P
    // 设备时，supplicant 将对应网络标记为 2，防止自动重连到已删除的设备
    if (wpa_ssid->disabled == 2)
        return errorStatus(ERROR_UNKNOWN, "Network permanently disabled");

    // 绕过最小扫描间隔限制——用户主动选择连接应即时响应
    wpa_s->scan_min_time.sec = 0;
    wpa_s->scan_min_time.usec = 0;

    wpa_supplicant_select_network(wpa_s, wpa_ssid);
    return ndk::ScopedAStatus::ok();
}
```

主要功能：

- `scan_min_time` 清零——用户主动点连接，不应受扫描间隔限制。这解释了为什么手动连接比自动重连响应更快
- `wpa_supplicant_select_network()` 是连接的总调度入口

进入 `wpa_supplicant_select_network()`：

```c
// wpa_supplicant/wpa_supplicant.c（源码有部分精简）
void wpa_supplicant_select_network(struct wpa_supplicant *wpa_s,
                                   struct wpa_ssid *ssid)
{
    struct wpa_ssid *other_ssid;
    int disconnected = 0;

    // 1. 如果选了不同的网络且当前已连接，先断开
    if (ssid && ssid != wpa_s->current_ssid && wpa_s->current_ssid) {
        if (wpa_s->wpa_state >= WPA_AUTHENTICATING)
            wpa_s->own_disconnect_req = 1;
        wpa_supplicant_deauthenticate(
            wpa_s, WLAN_REASON_DEAUTH_LEAVING);
        disconnected = 1;
    }

    // 2. 标记其他网络为 disabled，只启用选中的网络
    for (other_ssid = wpa_s->conf->ssid; other_ssid;
         other_ssid = other_ssid->next) {
        other_ssid->disabled = ssid ? (ssid->id != other_ssid->id) : 0;
    }

    // 3. 如果已关联到选中网络，直接返回
    if (ssid && ssid == wpa_s->current_ssid &&
        wpa_s->wpa_state >= WPA_AUTHENTICATING) {
        return;
    }

    // 4. 设置当前网络 + 如果需要则触发扫描
    wpa_s->current_ssid = ssid;
    wpa_s->disconnected = 0;
    wpa_s->reassociate = 1;

    // 5. 先尝试快速关联（BSS 缓存命中）
    if (wpa_s->connect_without_scan || request_new_scan ||
        wpa_supplicant_fast_associate(wpa_s) != 1) {
        // 缓存未命中 → 触发扫描 → 扫描完成后回调中调用 wpa_supplicant_associate()
        wpa_s->scan_req = NORMAL_SCAN_REQ;
        wpa_supplicant_req_scan(wpa_s, 0, disconnected ? 100000 : 0);
    }
}
```

主要功能：

- 这是 `select()` 之后 supplicant 侧的总调度函数——它决定"先扫描还是直接连"
- **`wpa_supplicant_fast_associate()`** 尝试在 BSS 缓存中找到匹配的目标 AP——如果命中（比如刚扫过，BSS 还没过期），直接走 `wpa_supplicant_associate()`，不命中则先发一次扫描
- 断开重连时会加 100ms 延迟（`disconnected ? 100000 : 0`），防止 deauth 帧还没发完就连回去
- `select()` 在 Framework 的 `WifiManager.enableNetwork()` 和 `WifiManager.reconnect()` 调用路径中都会触发，但区别在于：`enableNetwork()` 仅启用网络（`disableNetwork()` 的反操作），不强制触发连接；`reconnect()` 则在启用后立即调用 `reconnectCommand()` 主动发起连接。在 supplicant 内部，两者最终都走到 `wpa_supplicant_select_network()`——`select` 总是激活连接。

## 1.4 扫描结果如何选出目标网络——pick_network 与评分

`wpa_supplicant_select_network()` 触发扫描后，扫描完成事件（`EVENT_SCAN_RESULTS`）在 `events.c` 中被处理，最终调用 `wpa_supplicant_pick_network()` 从扫描结果中挑出要关联的 BSS。这个函数是"连哪个 AP"的决策中枢：

```c
// wpa_supplicant/events.c（源码有部分精简）
struct wpa_bss * wpa_supplicant_pick_network(struct wpa_supplicant *wpa_s,
                                             struct wpa_ssid **selected_ssid)
{
    struct wpa_bss *selected = NULL;
    size_t prio;

    // 1. 无扫描结果 → 直接返回
    if (wpa_s->last_scan_res == NULL || wpa_s->last_scan_res_used == 0)
        return NULL;

    // 2. 按优先级组从高到低遍历（conf->pssid[] 已按 priority 排序）
    while (selected == NULL) {
        for (prio = 0; prio < wpa_s->conf->num_prio; prio++) {
            selected = wpa_supplicant_select_bss(
                wpa_s, wpa_s->conf->pssid[prio], selected_ssid, 0);
            if (selected)
                break;
        }
        // 3. 没找到 → 清空 BSSID 黑名单 / BTM 状态再试一次（一次重试机会）
        if (!selected &&
            (wpa_s->bssid_ignore || wnm_active_bss_trans_mgmt(wpa_s)) &&
            !wpa_s->countermeasures) {
            wnm_btm_reset(wpa_s);
            wpa_bssid_ignore_clear(wpa_s);
            wpa_s->bssid_ignore_cleared = true;
        } else if (selected == NULL)
            break;
    }
    return selected;
}
```

主要功能：

- **优先级模型**：`wpa_s->conf->pssid[]` 是"按 priority 分组"的网络列表（`config.h` 的 `pssid`/`num_prio` 字段），`priority` 越高的网络越先被尝试。用户在 `WifiConfiguration` 里设置的 `priority` 字段最终体现在这个排序里
- **二次机会**：遍历完所有优先级都没找到可用 BSS 时，supplicant 清空 BSSID 黑名单（`wpa_bssid_ignore_clear()`）再试一次——这是为了从"之前连接失败的 AP"里恢复，而不是永久放弃
- 对每个优先级组，`wpa_supplicant_select_bss()`（`events.c:1741`）遍历该组内所有网络配置，逐个调用 `wpa_scan_res_match()`（`events.c:1634`）做 BSS 级匹配

`wpa_scan_res_match()` 负责"单个 BSS 是否匹配当前网络配置"——检查 SSID 是否一致、BSSID 是否被指定或被拉黑、频段是否被禁用、安全能力是否匹配。通过它的过滤后，多个候选 BSS 之间"谁更好"由 `wpa_scan_result_compar()`（`scan.c:2362`）决定。这是一个多级比较器，按优先级从高到低依次比较：

```c
// wpa_supplicant/scan.c（源码有部分精简，比较器核心判据）
static int wpa_scan_result_compar(const void *a, const void *b)
{
    // 1. WPA/WPA2 支持优先：有 RSN/WPA IE 的 BSS 排在无加密的 Open 前面
    wpa_a = wpa_scan_get_vendor_ie(wa, WPA_IE_VENDOR_TYPE) != NULL ||
        wpa_scan_get_ie(wa, WLAN_EID_RSN) != NULL;
    wpa_b = ...;  // 同上
    if (wpa_b && !wpa_a) return 1;   // b 更好
    if (!wpa_b && wpa_a) return -1;  // a 更好

    // 2. Privacy 支持优先（IEEE80211_CAP_PRIVACY 能力位）
    ...

    // 3. SNR 比较：按信道宽度校正（wpas_adjust_snr_by_chanwidth），
    //    且 SAE BSS 的 SNR 不低于 PSK BSS 时优先 SAE（WPA3 过渡模式）
    ...

    // 4. SNR 接近（<7dB）或任一在 6GHz → 比 est_throughput（预估吞吐）
    // 5. SNR 接近（<5dB）→ 频段优先：6GHz > 5GHz > 2.4GHz
    // 6. 兜底：先比 SNR，再比 qual（quality）
}
```

主要功能：

- **多级判据**：安全能力（WPA/RSN IE）→ Privacy → SNR（含信道宽度校正）→ 预估吞吐 → 频段 → 兜底 SNR/qual。逻辑是"先保证能连上安全网络，再从信号好的里挑最优"
- **SAE 优先**：WPA3 过渡模式下同一 AP 同时广播 PSK 与 SAE AKM，若 SAE BSS 信号不差于 PSK BSS，supplicant 优先选 SAE——因为 WPA3 更安全
- **信道宽度校正**：`wpas_adjust_snr_by_chanwidth()`（`scan.c:2343`）把 SNR 按信道宽度归一化——扫描探测帧通常只在 20MHz 上发，但数据帧用更宽信道，SNR 会不同
- **6GHz 特殊处理**：6GHz 频段受 LPI/VLP 功率限制，SNR 可能偏低但实际吞吐更高，所以 SNR 接近时直接比预估吞吐，而非继续比 SNR

选出 BSS 后，调用链回到 `wpa_supplicant_associate()`（§2.3 详述），进入认证/关联阶段。至此 `select` → 扫描 → `pick_network` → `associate` 的完整闭环补齐了。

---

# 2 制卡机运作机制——走进 SME

SME（Station Management Entity）是 802.11 协议中负责管理 STA 认证和关联状态机的逻辑实体。在 wpa_supplicant 中，SME 模式意味着 supplicant 自己构造 Auth/Assoc 帧并通过两步命令（`CMD_AUTHENTICATE` → `CMD_ASSOCIATE`）下发给驱动；非 SME 模式则将 Auth+Assoc 合并为一个 `CMD_CONNECT` 命令，让驱动/固件自动完成帧交换。

## 2.1 什么是 SME

SME 是 802.11 协议栈中的一个概念（IEEE 802.11-2024 第 3 章定义的术语），全称 Station Management Entity。它是 MAC 层的管理大脑，负责：

- **认证状态机**：管理 802.11 认证流程（Open System、Shared Key、SAE、FT、FILS）
- **关联状态机**：管理 Association/Reassociation 流程
- **安全策略决策**：根据配置选择认证算法和加密套件
- **漫游决策**：判断是否需要切换 AP

在 Android WiFi 架构中，SME 可以在两个地方实现：

| 实现位置            | 技术术语             | 特点                                                         |
| ------------------- | -------------------- | ------------------------------------------------------------ |
| wpa_supplicant 进程 | **supplicant SME**   | supplicant 构造认证帧、控制每步交互，通过 `CMD_AUTHENTICATE` + `CMD_ASSOCIATE` 两步下发 |
| 驱动/固件           | **driver-based SME** | 驱动内部处理认证和关联，supplicant 只发一个 `CMD_CONNECT`，驱动自动完成 Auth+Assoc+4-way handshake |

wpa_supplicant 通过一个标志位判断使用哪种模式。这个标志位在 `wpa_supplicant_associate()` 的分发点被检查：

```c
// wpa_supplicant/wpa_supplicant.c（源码有部分精简）
// wpa_supplicant_associate() 中的模式分叉点
if ((wpa_s->drv_flags & WPA_DRIVER_FLAGS_SME) &&
    ssid->mode == WPAS_MODE_INFRA) {
    // SME 模式：supplicant 管理认证状态机
    sme_authenticate(wpa_s, bss, ssid);
    return;
}

// 非 SME 模式：通过 radio work 调度连接
if (wpa_s->connect_work) return;
if (radio_work_pending(wpa_s, "connect")) return;

wpas_abort_ongoing_scan(wpa_s);
cwork = os_zalloc(sizeof(*cwork));
cwork->bss = bss;
cwork->ssid = ssid;
if (radio_add_work(wpa_s, bss ? bss->freq : 0, "connect", 1,
                   wpas_start_assoc_cb, cwork) < 0) {
    os_free(cwork);
}
```

主要功能：

- `WPA_DRIVER_FLAGS_SME`（值 `0x00000020`）定义在 `src/drivers/driver.h`，注释为"Driver provides separate commands for authentication and association (SME in wpa_supplicant)"
- 这个标志由 nl80211 能力探测阶段（`driver_nl80211_capa.c`）根据驱动是否在 `NL80211_ATTR_SUPPORTED_COMMANDS` 中注册了 `NL80211_CMD_AUTHENTICATE` 自动设置
- **注意标志位的语义是反直觉的**：`WPA_DRIVER_FLAGS_SME` 设了意味着"驱动提供分开的认证/关联命令"，等于告诉 supplicant "你可以用你自己的 SME 了"

![Supplicant 内部模块架构](assets/06b-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%8C%EF%BC%89Supplicant-%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06b-architecture-supplicant.svg)

## 2.2 两种模式的完整对比

| 维度                  | Supplicant SME 模式                                          | 非 SME 模式（Driver SME）              |
| --------------------- | ------------------------------------------------------------ | -------------------------------------- |
| **下发命令**          | `NL80211_CMD_AUTHENTICATE` → `NL80211_CMD_ASSOCIATE`（两步） | `NL80211_CMD_CONNECT`（一步）          |
| **Auth 帧构造**       | supplicant（`sme_send_authentication`）                      | 驱动/固件                              |
| **Assoc 帧构造**      | supplicant（`sme_associate`）                                | 驱动/固件                              |
| **认证帧交互**        | supplicant 控制每帧（SAE 4帧、FT 2帧）                       | 驱动自动（Open 2帧）                   |
| **适用认证**          | SAE、FT、FILS、OWE                                           | Open、WPA2-PSK、WPA2-EAP               |
| **失败重试**          | supplicant 决定重试策略                                      | 驱动决定                               |
| **PMKSA 缓存控制**    | supplicant 完全控制（降级、刷新）                            | 驱动控制                               |
| **Supplicant 状态机** | 完整 SME 状态机（`sme.c`）                                   | 仅 WPA/EAPOL 状态机，无 SME 认证状态机 |

![SME 模式对比：两步走 vs 一步走](assets/06b-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%8C%EF%BC%89Supplicant-%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06b-sme-compare.svg)

SME 模式就像 VIP 客人的分步验证——先去贵宾室确认身份（`CMD_AUTHENTICATE`），再回来签入住单（`CMD_ASSOCIATE`），每步都由制卡机亲自把关。非 SME 模式就像普通客人的一步入住——前台一次性核验身份和房型，制卡机只需要给一个"连接"指令，剩下的由门禁系统（驱动）自动完成。

## 2.3 wpa_supplicant_associate()——连接的总入口

在追踪 SME 和非 SME 两条路径之前，我们先看看它们共同的前置准备。`wpa_supplicant_associate()` 是所有连接的入口函数，它执行三轮准备工作后才进行模式分发：

```c
// wpa_supplicant/wpa_supplicant.c（源码有部分精简）
void wpa_supplicant_associate(struct wpa_supplicant *wpa_s,
                              struct wpa_bss *bss,
                              struct wpa_ssid *ssid)
{
    // Phase 1: 状态清理
    wpa_s->own_disconnect_req = 0;
    wpa_s->own_reconnect_req = 0;
    wpabuf_free(wpa_s->pending_eapol_rx);
    wpa_s->pending_eapol_rx = NULL;
    wpa_s->eapol_failed = 0;

    // Phase 2: 重关联检测
    if (wpa_s->last_ssid == ssid) {
        wpa_s->reassoc_same_ess = 1;      // 同一 ESS
        if (wpa_s->current_bss && wpa_s->current_bss == bss)
            wpa_s->reassoc_same_bss = 1;  // 同一 BSS
    }

    // Phase 3: MAC 地址随机化
    if (rand_style > WPAS_MAC_ADDR_STYLE_PERMANENT) {
        wpas_update_random_addr(wpa_s, rand_style, ssid);
    }

    // Phase 4: 模式分发（上面已展示）
}
```

这三轮准备的价值：

- **状态清理**：`own_disconnect_req = 0` 很重要——supplicant 用这个字段区分"自己主动断开"和"被 AP 踢掉"。如果不清零，后续收到 AP 的 deauth 时可能被误判为"是我们自己要断的"
- **重关联检测**：同一 ESS 走 Reassociation（更快），同一 BSS 保留 SAE 拒绝列表（避免重复尝试已拉黑的 AP）
- **MAC 随机化**：必须在 Auth 帧发出前完成——一旦发出，MAC 就固定了

这三轮准备完成后，supplicant 进入认证/关联流程。整个连接过程在 supplicant 顶层由一套 **`enum wpa_states` 状态机**（`src/common/defs.h:248`）驱动，`wpa_supplicant_set_state()` 负责迁移状态。本文追踪的链路恰好完整穿越它的主干：

| 状态                  | 进入时机        | 触发函数                            |
| --------------------- | --------------- | ----------------------------------- |
| `WPA_DISCONNECTED`    | 初始/断开       | `wpa_supplicant_disassociate()` 等  |
| `WPA_SCANNING`        | 触发扫描        | `wpa_supplicant_req_scan()`         |
| `WPA_AUTHENTICATING`  | 下发认证命令    | `wpa_drv_authenticate()`（§3.4）    |
| `WPA_ASSOCIATING`     | 下发关联命令    | `wpa_drv_associate()`（§4.2）       |
| `WPA_ASSOCIATED`      | 关联成功        | `wpas_notify_state_changed()`       |
| `WPA_4WAY_HANDSHAKE`  | 收到 msg 1/4    | `wpa_sm_set_state()`（§5.3）        |
| `WPA_GROUP_HANDSHAKE` | 收到 msg 3/4 后 | `wpa_sm_set_state()`                |
| `WPA_COMPLETED`       | 四次握手完成    | `wpa_supplicant_key_neg_complete()` |

理解这个状态机是读后续章节的钥匙：SME 认证/关联阶段（§3、§4）对应 `WPA_AUTHENTICATING` 与 `WPA_ASSOCIATING` 两态，四次握手（§5）对应 `WPA_4WAY_HANDSHAKE` → `WPA_GROUP_HANDSHAKE` → `WPA_COMPLETED` 三态。SME 侧还维护一份私有上下文 `struct wpa_supplicant` 的 `sme` 字段（`wpa_supplicant_i.h:1015`），记录 `auth_alg`、预构建的 `assoc_req_ie`、`prev_bssid`、`assoc_auth_type` 等——这些字段在认证阶段写入、关联阶段复读，是两步走（auth→assoc）能衔接起来的关键。

如果把 `enum wpa_states` 看作制卡机内部的工序流转单，`sme` 结构体就是贴在流转单背面的便签：身份验证这道工序写下的 `auth_alg` 和 `assoc_req_ie`，签入住单这道工序直接照着用，省得重新核算一遍客人的认证方式。

---

# 3 身份验证——SME 认证流程

SME 认证从 `sme_authenticate()` 开始，经过 radio work 调度进入 `sme_send_authentication()`，这里根据 `key_mgmt` 选择 auth_alg（OPEN/SAE/FT/FILS），构造认证帧后通过 `wpa_drv_authenticate()` 下发 `NL80211_CMD_AUTHENTICATE`。收到 Auth 响应后，`sme_event_auth()` 处理结果并触发 `sme_associate()`。

## 3.1 sme_authenticate()——SME 模式的启动器

```c
// wpa_supplicant/sme.c（源码有部分精简）
void sme_authenticate(struct wpa_supplicant *wpa_s,
                      struct wpa_bss *bss, struct wpa_ssid *ssid)
{
    struct wpa_connect_work *cwork;

    // 防重入：connect_work 已存在则跳过
    if (wpa_s->connect_work) return;

    // 移除旧的 sme-connect radio work（如果有），以最新决定为准
    radio_remove_works(wpa_s, "sme-connect", 0);

    // 取消进行中的扫描
    wpas_abort_ongoing_scan(wpa_s);

    // 设置 SAE 状态为"未开始"
    wpa_s->sme.sae.state = SAE_NOTHING;

    // 分配连接上下文，标记为 SME 模式
    cwork = os_zalloc(sizeof(*cwork));
    cwork->bss = bss;
    cwork->ssid = ssid;
    cwork->sme = 1;  // ← 标记 SME 模式

    // 创建 radio work：优先级插入队首（next=1）
    if (radio_add_work(wpa_s, bss->freq, "sme-connect", 1,
                       sme_auth_start_cb, cwork) < 0) {
        os_free(cwork);
    }
}
```

主要功能：

- `cwork->sme = 1` 标记让后续的 `wpas_connect_work_done()` 等知道这是 SME 路径的工作
- radio work type 使用 `"sme-connect"`（区别于非 SME 的 `"connect"`）——断开连接时 `radio_remove_works(wpa_s, "sme-connect", 0)` 精准清理
- SAE 状态重置为 `SAE_NOTHING`——每次连接都是全新的认证尝试

## 3.2 sme_auth_start_cb()——收到射频使用权后开始认证

当 radio work 被调度执行时（射频空闲了），回调 `sme_auth_start_cb()` 被调用：

```c
// wpa_supplicant/sme.c（源码有部分精简）
static void sme_auth_start_cb(struct wpa_radio_work *work, int deinit)
{
    struct wpa_connect_work *cwork = work->ctx;
    struct wpa_supplicant *wpa_s = work->wpa_s;

    if (deinit) {
        wpas_connect_work_free(cwork);
        return;
    }

    // 再次验证 BSS/SSID 在排队期间未被移除或禁用
    if (cwork->bss_removed || !wpas_valid_bss_ssid(wpa_s, cwork->bss, cwork->ssid) ||
        wpas_network_disabled(wpa_s, cwork->ssid)) {
        wpas_connect_work_done(wpa_s);
        return;
    }

    // 清理前一次关联的 WPA IE
    wpa_sm_set_assoc_wpa_ie(wpa_s->wpa, NULL, 0);

    // 启动认证——第三个参数 start=1 表示首次尝试
    sme_send_authentication(wpa_s, cwork->bss, cwork->ssid, 1);
}
```

主要功能：

- BSS 有效性二次验证很重要——排队期间（等待射频空闲），目标 BSS 可能已被移除或过期
- `start=1` 表示这是首次认证尝试（区别于 SAE 内部的重发、FT over-the-air 重试等）

## 3.3 sme_send_authentication()——auth_alg 决策枢纽

这是 SME 认证的核心函数（约 680 行），其中的 **auth_alg 决策链**是理解 WiFi 安全协议路由的关键：

```c
// wpa_supplicant/sme.c（源码有部分精简，auth_alg 决策核心路径）
static void sme_send_authentication(struct wpa_supplicant *wpa_s,
                                    struct wpa_bss *bss,
                                    struct wpa_ssid *ssid, int start)
{
    struct wpa_driver_auth_params params;
    os_memset(&params, 0, sizeof(params));

    // ═══════════════════════════════════════════
    // auth_alg 决策枢纽：按优先级逐层判定
    // ═══════════════════════════════════════════

    // 1. 默认：Open System
    params.auth_alg = WPA_AUTH_ALG_OPEN;

    // 2. LEAP 检测
    #ifdef IEEE8021X_EAPOL
    if (ssid->key_mgmt & WPA_KEY_MGMT_IEEE8021X_NO_WPA && ssid->leap)
        params.auth_alg = WPA_AUTH_ALG_LEAP;
    #endif

    // 3. 用户手动指定 auth_alg → 设置初始值，但后续 SAE/FT 检测仍可覆盖
    if (ssid->auth_alg != 0) {
        params.auth_alg = ssid->auth_alg;
    }

    // 4. SAE 检测（WPA3）
    #ifdef CONFIG_SAE
    if (wpa_key_mgmt_sae(ssid->key_mgmt)) {
        const u8 *rsn;
        struct wpa_ie_data ied;
        // 获取 AP 的 RSNE，解析后检查 SAE AKM
        rsn = wpa_bss_get_rsne(wpa_s, bss, ssid, false);
        if (rsn && wpa_parse_wpa_ie(rsn, 2 + rsn[1], &ied) == 0 &&
            wpa_key_mgmt_sae(ied.key_mgmt)) {
            if (!wpas_is_sae_avoided(wpa_s, ssid, &ied)) {
                params.auth_alg = WPA_AUTH_ALG_SAE;
            }
        }
    }
    #endif

    // ... 构造 assoc_req_ie（RSNE/WPS/FT/P2P 等）...

    // 5. FT（Fast BSS Transition）over-the-air 检测
    #ifdef CONFIG_IEEE80211R
    if (mobility_domain_present && wpa_key_mgmt_ft(ssid->key_mgmt) &&
        prev_bssid_set && sme->ft_used && same_mobility_domain) {
        params.auth_alg = WPA_AUTH_ALG_FT;
        params.ie = sme->ft_ies;        // 使用缓存的 FT IE
        params.ie_len = sme->ft_ies_len;
    }
    #endif

    // ... 构造更多 assoc_req_ie 内容 ...

    // 6. SAE PMKSA caching 降级
    #ifdef CONFIG_SAE
    if (params.auth_alg == WPA_AUTH_ALG_SAE && pmksa_cache_hit) {
        params.auth_alg = WPA_AUTH_ALG_OPEN;   // 降级为 Open
        sme->sae_pmksa_caching = 1;            // 标记 PMKSA 缓存模式
    }
    #endif

    // 7. FILS（Fast Initial Link Setup）检测
    // 实际流程（sme.c:1076-1151）：
    //   用 wpa_bss_get_ie() 读取 AP 的 FILS Indication IE
    //   → 解析 fils_info → 检查 ssid->fils_dh_group 与 AP 能力
    //   → fils_build_auth() 构建 FILS auth_data
    //   → 设置 params.auth_alg = FILS/FILS_SK_PFS + params.auth_data
    #ifdef CONFIG_FILS
    if (params.auth_alg == WPA_AUTH_ALG_OPEN &&
        wpa_key_mgmt_fils(ssid->key_mgmt)) {
        // 解析 FILS Indication IE → 检查 DH group → 构建 auth_data
        // 效果：auth_alg 设为 WPA_AUTH_ALG_FILS 或 WPA_AUTH_ALG_FILS_SK_PFS
        ...
    }
    #endif

    // 8. 保存最终 auth_alg 到 SME 状态
    wpa_s->sme.auth_alg = params.auth_alg;

    // 9. 如果 skip_auth=true（同 BSS 重关联优化），跳过 auth 直接 assoc
    if (skip_auth) {
        sme_associate(wpa_s, ssid->mode, bss->bssid, WLAN_AUTH_OPEN);
        return;
    }

    // 10. 下发认证命令到驱动
    wpa_drv_authenticate(wpa_s, &params);

    // 11. 启动 SME 认证超时定时器
    eloop_register_timeout(SME_AUTH_TIMEOUT, 0,
                           sme_auth_timer, wpa_s, NULL);
}
```

**auth_alg 决策流程图解**：

```none
key_mgmt 字段
    │
    ├── IEPv1 LEAP?  ──────────────────→ WPA_AUTH_ALG_LEAP
    │
    ├── ssid->auth_alg 手动指定?  ──────→ 设初始值（后续 SAE/FT 仍可覆盖）
    │
    ├── SAE(WPA3)? 且 AP 支持 SAE?  ───→ WPA_AUTH_ALG_SAE
    │     │
    │     ├── PMKSA 缓存命中?  ─────────→ 降级为 WPA_AUTH_ALG_OPEN
    │     │                                （走 SAE PMKSA caching 快速路径）
    │     └── 无缓存 ───────────────────→ 保持 WPA_AUTH_ALG_SAE
    │                                       （走完整 Dragonfly 握手）
    │
    ├── FT(802.11r) + 同 MD + 已有密钥? → WPA_AUTH_ALG_FT
    │                                       （使用缓存的 FT IE）
    │
    ├── FILS? + AP 支持?  ──────────────→ WPA_AUTH_ALG_FILS
    │ 或 FILS+PFS?                       WPA_AUTH_ALG_FILS_SK_PFS
    │
    └── 都不是 ──────────────────────────→ WPA_AUTH_ALG_OPEN
                                            （WPA2-PSK/EAP 的默认路径）
```

主要功能：

- 决策优先级：LEAP → 用户指定（初始值，后续 SAE/FT 检测可覆盖）→ SAE → FT → SAE PMKSA 降级 → FILS → Open
- **注意**：用户手动指定的 `auth_alg` 并不是最终决定——代码在此处只是一个普通 if 块，之后会 fall through 到 SAE 和 FT 检测，它们仍可能覆盖 `params.auth_alg`
- SAE PMKSA caching 是 WPA3 的重要优化：如果之前已经完整做过 SAE，PMK 还在缓存中，可以直接降级为 Open auth 跳过 Dragonfly 握手，节省约 200ms
- 每条分叉都受编译宏控制（`CONFIG_SAE`、`CONFIG_IEEE80211R`、`CONFIG_FILS`），确保没有无用代码

## 3.4 执行认证——下发 NL80211_CMD_AUTHENTICATE

`wpa_drv_authenticate()` 是一个薄包装：

```c
// wpa_supplicant/driver_i.h（源码有部分精简）
static inline int wpa_drv_authenticate(struct wpa_supplicant *wpa_s,
                                       struct wpa_driver_auth_params *params)
{
    if (wpa_s->driver->authenticate)
        return wpa_s->driver->authenticate(wpa_s->drv_priv, params);
    return -1;
}
```

通过函数指针调用到 nl80211 驱动的 `wpa_driver_nl80211_authenticate()`：

```c
// src/drivers/driver_nl80211.c（源码有部分精简）
static int wpa_driver_nl80211_authenticate(
    struct i802_bss *bss, struct wpa_driver_auth_params *params)
{
    struct wpa_driver_nl80211_data *drv = bss->drv;
    int ret = -1, i;
    struct nl_msg *msg;
    enum nl80211_auth_type type;

    // 设置接口模式为 Station
    if (drv->nlmode != NL80211_IFTYPE_STATION &&
        wpa_driver_nl80211_set_mode(bss, NL80211_IFTYPE_STATION) < 0)
        return -1;

    // 创建 NL80211_CMD_AUTHENTICATE netlink 消息
    msg = nl80211_drv_msg(drv, 0, NL80211_CMD_AUTHENTICATE);

    // 填充 BSSID
    if (params->bssid)
        nla_put(msg, NL80211_ATTR_MAC, ETH_ALEN, params->bssid);

    // 填充频率
    if (params->freq)
        nla_put_u32(msg, NL80211_ATTR_WIPHY_FREQ, params->freq);

    // 填充 SSID
    if (params->ssid)
        nla_put(msg, NL80211_ATTR_SSID, params->ssid_len, params->ssid);

    // 填充 IE（承载认证帧体，SAE 模式下这里放 Commit/Confirm）
    if (params->ie)
        nla_put(msg, NL80211_ATTR_IE, params->ie_len, params->ie);

    // 填充 SAE 认证数据（auth_data）
    if (params->auth_data)
        nla_put(msg, NL80211_ATTR_SAE_DATA,
                params->auth_data_len, params->auth_data);

    // 认证类型映射
    type = get_nl_auth_type(params->auth_alg);
    nla_put_u32(msg, NL80211_ATTR_AUTH_TYPE, type);

    // 发送到内核
    ret = send_and_recv_cmd(drv, msg);

    // 失败恢复逻辑：
    if (ret == -ENOENT && params->freq && !is_retry) {
        // cfg80211 的 BSS entry 过期了 → 发起单信道扫描 + 设置标志
        // ← 实际源码构造 scan_params（num_ssids=1, freqs={params->freq, 0}），
        //    调用 wpa_driver_nl80211_scan() 触发扫描，成功后
        //    nl80211_copy_auth_params(drv, params) 缓存参数 + 设置标志
        drv->scan_for_auth = 1;
    } else if ((ret == -EALREADY || ret == -EEXIST) && count == 1) {
        // 已认证状态冲突（EALREADY / EEXIST）→ 强制 deauth 后 goto retry
        wpa_driver_nl80211_deauthenticate(bss, params->bssid,
                                          WLAN_REASON_PREV_AUTH_NOT_VALID);
    }

    return ret;
}
```

主要功能：

- `NL80211_CMD_AUTHENTICATE` 的 netlink 消息携带 BSSID、频率、SSID、IE（认证帧体）、auth_type 五个核心属性
- SAE 模式下，`NL80211_ATTR_SAE_DATA` 承载 Commit/Confirm 的认证数据（不是 IE）
- **两个重要的恢复机制**：
  - `-ENOENT`：内核 cfg80211 的 BSS 缓存过期了。supplicant 先调用 `wpa_driver_nl80211_scan()` 发起单信道扫描（含 SSID 过滤）；扫描成功后调用 `nl80211_copy_auth_params()` 把认证参数缓存起来，并置 `drv->scan_for_auth = 1` 标志（`scan_for_auth` 是 driver struct 的 bitfield 标志位，不是函数）。等扫描完成事件回调到达后，再自动重新发起认证
  - `-EALREADY` / `-EEXIST`：mac80211 不允许已认证状态下再次认证 → 调用 `wpa_driver_nl80211_deauthenticate(bss, params->bssid, WLAN_REASON_PREV_AUTH_NOT_VALID)` 强制断开，然后 `goto retry` 重新发送认证命令

`wpa_driver_nl80211_authenticate()` 就像制卡机用对讲机（nl80211）对门禁系统说："客人编号 xxx（BSSID），在 5 号楼（freq），姓名是 xxx（SSID），用身份证（auth_type=OPEN）验证一下"。如果门禁回"我不认识这个客人"（ENOENT），制卡机立一个"需要扫描确认"的标记（`scan_for_auth = 1`），等扫描完成后通过事件回调自动重试。如果门禁回"这个人已经验证过了"（EALREADY / EEXIST），制卡机先发一条"请作废"命令（deauthenticate），再重新验证。

## 3.5 认证响应处理——sme_event_auth()

驱动完成认证帧交换后，通过 `EVENT_AUTH` 上报结果。在 `wpa_supplicant_event()` 事件分发器中（`events.c`）：

```c
case EVENT_AUTH:
    sme_event_auth(wpa_s, data);
    break;
```

`sme_event_auth()` 是认证响应的总处理入口：

```c
// wpa_supplicant/sme.c（源码有部分精简）
void sme_event_auth(struct wpa_supplicant *wpa_s,
                    union wpa_event_data *data)
{
    // 防御性检查 1：当前网络有效性 + 状态校验
    if (!wpa_s->current_ssid || wpa_s->wpa_state != WPA_AUTHENTICATING)
        return;

    // 防御性检查 2：peer MAC 与 pending_bssid 一致性校验
    // 防止响应来自非预期的 AP（安全防护）
    if (!ether_addr_equal(wpa_s->pending_bssid, data->auth.peer) &&
        !(wpa_s->valid_links &&
          ether_addr_equal(wpa_s->ap_mld_addr, data->auth.peer)))
        return;

    // 取消认证超时定时器
    eloop_cancel_timeout(sme_auth_timer, wpa_s, NULL);

    // SAE 分支：多帧交互处理
    #ifdef CONFIG_SAE
    if (data->auth.auth_type == WLAN_AUTH_SAE) {
        // sme_sae_auth() 参数（简化展示，实际 8 个参数）：
        //   auth_transaction, status_code, ies, ies_len,
        //   pmksa_hit, peer_mac, ie_offset
        int res = sme_sae_auth(wpa_s, data->auth.auth_transaction,
                               data->auth.status_code, data->auth.ies,
                               data->auth.ies_len, 0,
                               data->auth.peer, NULL);
        if (res < 0)  goto fail;        // SAE 失败
        if (res == 0) return;            // SAE 仍在进行中（Commit → Confirm）
        // res == 1: SAE 完成，调用 sme_sae_set_pmk() 将 PMK 传给 WPA 状态机
    }
    #endif

    // 认证失败处理
    if (data->auth.status_code != WLAN_STATUS_SUCCESS) {
        // auth_alg 降级回退机制
        // 实际源码（sme.c:2087-2118）：检查额外条件后，
        // 通过 switch(auth_type) 设置 wpa_s->current_ssid->auth_alg，
        // 然后调用 wpa_supplicant_associate() 重新进入分发路径
        if (data->auth.status_code == WLAN_STATUS_NOT_SUPPORTED_AUTH_ALG) {
            // 降级链：OPEN → SHARED_KEY → LEAP
            //   例如：case WLAN_AUTH_OPEN:
            //     wpa_s->current_ssid->auth_alg = WPA_AUTH_ALG_SHARED;
            //     wpa_supplicant_associate(wpa_s, wpa_s->current_bss,
            //                              wpa_s->current_ssid);
            //   注意：通过 wpa_supplicant_associate() 重新分发，
            //   而非直接调用 sme_send_authentication()
            ...
            return;
        }
        // 其他错误：标记失败，断开
        wpas_connection_failed(wpa_s, wpa_s->pending_bssid, NULL);
        return;
    }

    // FT 分支
    #ifdef CONFIG_IEEE80211R
    if (data->auth.auth_type == WLAN_AUTH_FT)
        wpa_ft_process_response(wpa_s, data);
    #endif

    // FILS 分支
    #ifdef CONFIG_FILS
    if (data->auth.auth_type == WLAN_AUTH_FILS_SK ||
        data->auth.auth_type == WLAN_AUTH_FILS_SK_PFS)
        fils_process_auth(wpa_s, data);
    #endif

    // 认证成功 → 发起关联
    sme_associate(wpa_s, ssid->mode, data->auth.peer,
                  data->auth.auth_type);
}
```

主要功能：

- **三层防御检查**：第一层检查当前网络有效性 + 认证状态；第二层检查 peer MAC 与 `pending_bssid` 一致性（防止响应来自非预期的 AP）；第三层通过 SAE/FT/FILS 分叉进行认证类型匹配
- SAE 的 `sme_sae_auth()` 返回 3 种值：`-1`（失败）、`0`（仍在交互中，如 Commit 发完等 Confirm）、`1`（完成）——这是 SAE 多帧交互的特殊处理
- **SAE 完成后（res==1），调用 `sme_sae_set_pmk(wpa_s, addr)` 把 SAE 协商出的 PMK 交给 WPA 状态机**。
- 这是 SAE 协议到四次握手的衔接点：没有这一步，后续 `process_1_of_4()` 中 `wpa_supplicant_get_pmk()` 找不到 PMK，四次握手会失败。
- **peer MAC 校验同时兼容 MLO**：MLO（Multi-Link Operation）场景下使用 `ap_mld_addr` 替代 `pending_bssid` 进行比对
- auth_alg 降级回退：如果 AP 回复"不支持的认证算法"（status code 13），supplicant 自动尝试下一个算法（Open → Shared Key → LEAP）
- 认证成功后调用 `sme_associate()` 进入关联阶段

---

# 4 签入住单——关联流程

认证成功后，`sme_associate()` 使用认证阶段预构建的 assoc_req_ie，填充 `wpa_driver_associate_params`，通过 `wpa_drv_associate()` 下发 `NL80211_CMD_ASSOCIATE`。

## 4.1 sme_associate()——构造关联请求

```c
// wpa_supplicant/sme.c（源码有部分精简）
static void sme_associate(struct wpa_supplicant *wpa_s,
                          enum wpas_mode mode, const u8 *bssid,
                          u16 auth_type)
{
    struct wpa_driver_associate_params params;
    os_memset(&params, 0, sizeof(params));

    // 保存 auth_type 供重试使用
    wpa_s->sme.assoc_auth_type = auth_type;

    // 设置基本参数（SSID/频率复用 sme_send_authentication 阶段保存到 wpa_s->sme 的值）
    params.bssid = bssid;
    params.ssid = wpa_s->sme.ssid;
    params.ssid_len = wpa_s->sme.ssid_len;
    params.freq.freq = wpa_s->sme.freq;

    // 使用 sme_send_authentication 中预构建的 assoc_req_ie
    if (wpa_s->sme.assoc_req_ie_len) {
        params.wpa_ie = wpa_s->sme.assoc_req_ie;
        params.wpa_ie_len = wpa_s->sme.assoc_req_ie_len;
    }

    // FILS 专用关联元素构建（如果需要）
    #ifdef CONFIG_FILS
    if (auth_type == WLAN_AUTH_FILS_SK ||
        auth_type == WLAN_AUTH_FILS_SK_PFS) {
        fils_build_assoc_req(wpa_s, &params);
    }
    #endif

    // OWE DH 参数
    #ifdef CONFIG_OWE
    if (auth_type == WLAN_AUTH_OPEN &&
        ssid->key_mgmt & WPA_KEY_MGMT_OWE) {
        owe_build_assoc_req(wpa_s, &params);
    }
    #endif

    // 下发关联命令到驱动
    ret = wpa_drv_associate(wpa_s, &params);
    if (ret < 0) {
        // 失败处理
        wpas_connection_failed(wpa_s, wpa_s->pending_bssid, NULL);
        return;
    }

    // 启动 SME 关联超时定时器
    eloop_register_timeout(SME_ASSOC_TIMEOUT, 0,
                           sme_assoc_timer, wpa_s, NULL);
}
```

主要功能：

- **参数复用**：`auth_alg` 已在前序 `sme_send_authentication()` 阶段确定并保存到 `wpa_s->sme.auth_alg`，此处不重复设置；`assoc_req_ie` 同样在认证阶段预构建（RSNE、HT/VHT/HE Capabilities 等），`sme_associate()` 直接复用——因为在同一认证周期内 AP 的能力不会改变
- 不同的 auth_type 有不同的 IE 构建逻辑：FILS 需要内嵌 FILS nonce、OWE 需要 DH 参数
- `wpa_drv_associate()` 下发关联命令

## 4.2 下发 NL80211_CMD_ASSOCIATE

`wpa_drv_associate()` 调用 `wpa_driver_nl80211_associate()`。在 SME 模式下，这个函数不是走 `CMD_CONNECT`，而是直接构建 `CMD_ASSOCIATE`：

```c
// src/drivers/driver_nl80211.c（源码有部分精简）
static int wpa_driver_nl80211_associate(
    void *priv, struct wpa_driver_associate_params *params)
{
    struct i802_bss *bss = priv;
    struct wpa_driver_nl80211_data *drv = bss->drv;

    // 关键分叉：驱动有没有 SME？
    if (!(drv->capa.flags & WPA_DRIVER_FLAGS_SME)) {
        // 非 SME 模式 → CMD_CONNECT（一步到位）
        return wpa_driver_nl80211_connect(drv, params, bss);
    }

    // SME 模式 → CMD_ASSOCIATE（认证已完成，只做关联）
    nl80211_mark_disconnected(drv);
    msg = nl80211_drv_msg(drv, 0, NL80211_CMD_ASSOCIATE);

    // 填充所有共享连接参数
    ret = nl80211_connect_common(drv, params, msg);

    // 额外填充 Assoc 专用参数（MFP、FILS KEK/nonces 等）...省略...
    // MLO（Multi-Link Operation）参数 ...省略...

    // 发送到内核
    return send_and_recv(drv->global, drv->first_bss->nl_connect,
                         msg, NULL, NULL, NULL, NULL, &err_info);
}
```

`nl80211_connect_common()` 是 `CMD_CONNECT` 和 `CMD_ASSOCIATE` **共享的参数填充函数**，它负责把以下参数编码为 Netlink 属性：

| NL80211 属性                          | 来源                     | 说明                                     |
| ------------------------------------- | ------------------------ | ---------------------------------------- |
| `NL80211_ATTR_MAC`                    | `params->bssid`          | 目标 AP 的 MAC 地址                      |
| `NL80211_ATTR_WIPHY_FREQ`             | `params->freq.freq`      | 目标信道频率（MHz）                      |
| `NL80211_ATTR_SSID`                   | `params->ssid`           | 目标网络 SSID                            |
| `NL80211_ATTR_IE`                     | `params->wpa_ie`         | WPA/RSN IE（整个 Assoc Req 的核心）      |
| `NL80211_ATTR_WPA_VERSIONS`           | `params->wpa_proto`      | WPA 协议版本                             |
| `NL80211_ATTR_CIPHER_SUITES_PAIRWISE` | `params->pairwise_suite` | 单播加密套件                             |
| `NL80211_ATTR_CIPHER_SUITE_GROUP`     | `params->group_suite`    | 组播加密套件                             |
| `NL80211_ATTR_AKM_SUITES`             | `params->key_mgmt_suite` | AKM 套件列表                             |
| `NL80211_ATTR_PREV_BSSID`             | `params->prev_bssid`     | 前一个 AP 的 BSSID（Reassociation 场景） |

表格里的每一行，在 `nl80211_connect_common()` 中都对应一段 `nla_put` 编码逻辑。核心三条（WPA 版本、加密套件、AKM）是这样落地的：

```c
// src/drivers/driver_nl80211.c（nl80211_connect_common 核心 nla_put 序列，有精简）
// 1. WPA 协议版本：WPA_PROTO_WPA/RSN → NL80211_ATTR_WPA_VERSIONS
if (params->wpa_proto) {
    enum nl80211_wpa_versions ver = 0;
    if (params->wpa_proto & WPA_PROTO_WPA)
        ver |= NL80211_WPA_VERSION_1;
    if (params->wpa_proto & WPA_PROTO_RSN)
        ver |= NL80211_WPA_VERSION_2;   // SAE offload 时还会置 NL80211_WPA_VERSION_3
    if (nla_put_u32(msg, NL80211_ATTR_WPA_VERSIONS, ver))
        return -1;
}

// 2. 单播 / 组播加密套件
if (params->pairwise_suite != WPA_CIPHER_NONE) {
    u32 cipher = wpa_cipher_to_cipher_suite(params->pairwise_suite);
    if (nla_put_u32(msg, NL80211_ATTR_CIPHER_SUITES_PAIRWISE, cipher))
        return -1;
}
if (params->group_suite != WPA_CIPHER_NONE) {
    u32 cipher = wpa_cipher_to_cipher_suite(params->group_suite);
    if (nla_put_u32(msg, NL80211_ATTR_CIPHER_SUITE_GROUP, cipher))
        return -1;
}

// 3. AKM 套件列表：key_mgmt_suite 经 switch 映射为 RSN_AUTH_KEY_MGMT_* 套件值，
//    再按 allowed_key_mgmts 追加其余允许的 AKM，一次性写入 NL80211_ATTR_AKM_SUITES
if (nla_put(msg, NL80211_ATTR_AKM_SUITES, akm_count * sizeof(u32), mgmt)) {
    os_free(mgmt);
    return -1;
}
```

主要功能：

- 每个属性都用 `nla_put_u32()` / `nla_put()` 写入，返回值非 0 就 `return -1` 终止——netlink 消息一旦塞坏一个属性，整个命令直接作废，宁可失败也不下发半个残缺命令
- `wpa_cipher_to_cipher_suite()` 把 supplicant 内部的 `WPA_CIPHER_*` 枚举翻译成 IEEE 802.11 定义的 OUI 套件值（如 CCMP → `0x000FAC04`），内核按 OUI 匹配，不认 supplicant 的私有枚举
- AKM 套件不是单个值而是一张表：`key_mgmt_suite` 映射为主套件，`allowed_key_mgmts` 里其余的允许 AKM 依次追加——这对应 WPA3 过渡模式下同一个 AP 同时支持 SAE 和 PSK 的场景

`nl80211_connect_common()` 就像制卡机把签好的入住单翻译成对讲机通话：WPA 版本是「房型标准」、加密套件是「门锁型号」、AKM 套件是「验证方式」，每一条都按门禁系统约定的固定频道（Netlink 属性）报出去，缺一条门禁就拒收。

## 4.3 关联响应处理

关联结果同样通过事件机制上报：

**成功**——`EVENT_ASSOC` → `wpa_supplicant_event()` → `wpas_notify_state_changed()` → 设置 `wpa_state = WPA_ASSOCIATED` → 调用 `wpa_sm_notify_assoc()` 进入四次握手阶段。

**拒绝**——`EVENT_ASSOC_REJECT` → `sme_event_assoc_reject()`。这个函数处理三种特殊场景：

| Status Code                              | 处理方式                                                 | 场景                          |
| ---------------------------------------- | -------------------------------------------------------- | ----------------------------- |
| `WLAN_STATUS_ASSOC_REJECTED_TEMPORARILY` | 解析 Timeout Interval IE，设置 comeback 定时器到期后重试 | AP 忙，稍后再来（如 6GHz AP） |
| SAE PMKSA 缓存被拒                       | 丢弃 PMKSA 缓存条目，deauth 后用完整 SAE 重新认证        | PMK 过期/不匹配               |
| DPP PMKID 无效                           | 丢弃 PMKSA 缓存，用 network introduction 协议重新协商    | DPP 连接中继                  |

**超时**——`EVENT_ASSOC_TIMED_OUT` → `sme_event_assoc_timed_out()` → 调用 `wpas_connection_failed()`，标记断开。

`sme_event_assoc_reject` 的核心处理逻辑（AOSP 源码）：

```c
// wpa_supplicant/sme.c（源码有部分精简）
void sme_event_assoc_reject(struct wpa_supplicant *wpa_s,
                            union wpa_event_data *data,
                            const u8 **link_bssids)
{
    const u8 *bssid = wpa_s->valid_links ?
                      wpa_s->ap_mld_addr : wpa_s->pending_bssid;

    // 取消 Assoc 和 comeback 超时定时器
    eloop_cancel_timeout(sme_assoc_timer, wpa_s, NULL);
    eloop_cancel_timeout(sme_assoc_comeback_timer, wpa_s, NULL);

    // 分支 1：临时拒绝（AP 忙）
    if (data->assoc_reject.status_code ==
        WLAN_STATUS_ASSOC_REJECTED_TEMPORARILY) {
        // 解析 Timeout Interval IE → 设置 comeback 定时器
        if (sme_try_assoc_comeback(wpa_s, data))
            return;  // comeback 已排队，不算失败
    }

    // 分支 2：SAE PMKSA 缓存被拒 → 丢弃缓存，重新做完整 SAE
    if (wpa_s->sme.sae_pmksa_caching && wpa_s->current_ssid &&
        wpa_key_mgmt_sae(wpa_s->current_ssid->key_mgmt)) {
        wpa_sm_aborted_cached(wpa_s->wpa);
        wpa_sm_pmksa_cache_flush(wpa_s->wpa, wpa_s->current_ssid);
        // 清理旧状态 → 重新调用 wpa_supplicant_connect()
        wpa_drv_deauthenticate(wpa_s, bssid, WLAN_REASON_DEAUTH_LEAVING);
        wpa_supplicant_connect(wpa_s, wpa_s->current_bss, wpa_s->current_ssid);
        return;
    }

    // 分支 3：DPP PMKID 无效 → 丢弃缓存，重新 network introduction
    // （DPP 场景，类似 SAE 分支的模式）

    // 兜底：无条件断开认证，防止 mac80211 状态残留
    sme_deauth(wpa_s, link_bssids);
}
```

主要功能：

- **comeback 机制是 6GHz AP 的关键特性**：AP 忙时不是直接拒绝，而是给 STA 一个 comeback 时间窗口——定时器到期后自动重试，避免了无效的重连循环
- SAE PMKSA 缓存被拒的恢复路径：丢弃旧 PMK → deauth → 调用 `wpas_connect_work_done()` 清理 radio work → 调用 `wpa_supplicant_mark_disassoc()` 清理关联状态 → 用完整 SAE 重新连接——这与 §3.3 中 SAE PMKSA caching 的降级逻辑形成呼应（先尝试快速路径，失败则回退到完整 SAE）。代码块中省略了 `wpas_connect_work_done()` 和 `wpa_supplicant_mark_disassoc()` 两个清理调用（源码有但精简），它们确保重连时 supplicant 处于干净的初始状态
- 兜底的 `sme_deauth()` 确保 mac80211 不会残留未完成的认证状态，这是长期工程实践的产物（源码注释："In theory, this should not be needed, but mac80211 gets quite confused if the authentication is left pending"）

**超时的定时器机制**（与上面的 reject 路径互补）：认证和关联各自挂一个 5 秒定时器，到点仍未收到响应就主动清理。定时器在命令下发时注册（§3.3 的 `sme_send_authentication()` 和 §4.1 的 `sme_associate()` 里各有一句 `eloop_register_timeout(...)`），超时处理函数如下：

```c
// wpa_supplicant/sme.c（源码有部分精简）
#define SME_AUTH_TIMEOUT 5   // sme.c:36
#define SME_ASSOC_TIMEOUT 5  // sme.c:37

static void sme_auth_timer(void *eloop_ctx, void *timeout_ctx)
{
    struct wpa_supplicant *wpa_s = eloop_ctx;
    if (wpa_s->wpa_state == WPA_AUTHENTICATING) {
        wpa_msg(wpa_s, MSG_DEBUG, "SME: Authentication timeout");
        sme_deauth(wpa_s, NULL);   // 强制断开，避免状态悬挂
    }
}

static void sme_assoc_timer(void *eloop_ctx, void *timeout_ctx)
{
    struct wpa_supplicant *wpa_s = eloop_ctx;
    if (wpa_s->wpa_state == WPA_ASSOCIATING) {
        wpa_msg(wpa_s, MSG_DEBUG, "SME: Association timeout");
        sme_deauth(wpa_s, NULL);
    }
}
```

主要功能：

- **定时器是"状态守护"而非"全局兜底"**：`sme_auth_timer`/`sme_assoc_timer` 只在 `wpa_state` 仍停在 `WPA_AUTHENTICATING`/`WPA_ASSOCIATING` 时才动作——如果认证已经完成进入下一状态，定时器即使触发也什么都不做
- 驱动侧超时事件走另一条路：`EVENT_AUTH_TIMED_OUT` → `sme_event_auth_timed_out()`（`sme.c:2971`）、`EVENT_ASSOC_TIMED_OUT` → `sme_event_assoc_timed_out()`（`sme.c:2980`），两者都调用 `wpas_connection_failed()` 标记失败并 `wpa_supplicant_mark_disassoc()` 清理关联状态
- `sme_state_changed()`（`sme.c`）在每次状态迁移时被调用，负责在离开 `WPA_AUTHENTICATING`/`WPA_ASSOCIATING` 时取消对应定时器——保证定时器不会误杀已完成的连接

至此认证/关联阶段的失败处理闭环完整了：AP 拒绝（reject，含 comeback/PMKSA 回退）→ 驱动报错（§3.4 的 -ENOENT/-EALREADY）→ 超时（5s 定时器 + 驱动超时事件），三条路最终都收敛到 `wpas_connection_failed()` 或 `sme_deauth()`，把 supplicant 拉回干净状态等待重试。

---

# 5 发房卡——EAPOL 四次握手

关联成功后，supplicant 通过 `wpa_sm_notify_assoc()` 清理旧 PTK 并准备新握手，然后等待 AP 发送的 EAPOL-Key msg 1/4。收到后 `wpa_sm_rx_eapol()` 分发到对应处理函数：msg 1/4 → `process_1_of_4()` 计算 PTK 并回复 msg 2/4 → msg 3/4 → `process_3_of_4()` 验证 MIC、安装 PTK/GTK 并回复 msg 4/4 → 握手完成。

## 5.1 握手触发——wpa_sm_notify_assoc()

关联成功后，`events.c` 调用 `wpa_sm_notify_assoc()`：

```c
// src/rsn_supp/wpa.c（源码有部分精简）
void wpa_sm_notify_assoc(struct wpa_sm *sm, const u8 *bssid)
{
    if (sm == NULL) return;

    // 保存 BSSID，清零 replay counter
    os_memcpy(sm->bssid, bssid, ETH_ALEN);
    os_memset(sm->rx_replay_counter, 0, WPA_REPLAY_COUNTER_LEN);
    sm->rx_replay_counter_set = 0;
    sm->renew_snonce = 1;    // 强制刷新 SNonce

    // FT 分支：FT 已完成，清除 portValid 踢 EAPOL 重入 AUTHENTICATED
    #ifdef CONFIG_IEEE80211R
    if (wpa_ft_is_completed(sm)) {
        eapol_sm_notify_portValid(sm->eapol, false);
        wpa_supplicant_key_neg_complete(sm, sm->bssid, 1);

        // 准备下一次漫游的 FT Auth Request
        wpa_ft_prepare_auth_request(sm, NULL);

        clear_keys = 0;
        sm->ft_protocol = 1;
    }
    #endif

    // 普通模式：清除旧 PTK
    if (clear_keys) {
        wpa_dbg(sm->ctx->msg_ctx, MSG_DEBUG, "WPA: Clear old PTK");
        wpa_sm_clear_ptk(sm);  // 按 IEEE 802.11 §8.4.10 要求
    }
}
```

主要功能：

- `renew_snonce = 1` 强制下次握手使用全新的 SNonce（Supplicant Nonce）——保证每次连接的 PTK 都是全新的
- **清除旧 PTK** 是 802.11 规范要求（§8.4.10）：每次 (re)association 后必须删除 PTK SA，除非是 FT 场景
- FT 模式特殊处理：`eapol_sm_notify_portValid(false)` 踢 EAPOL 重新进入 AUTHENTICATED 状态；`wpa_ft_prepare_auth_request(sm, NULL)` 准备下一次漫游的 FT Auth Request（预构建 FT IE 以加速后续漫游）；`clear_keys = 0` 防止按 §8.4.10 要求删除 PTK——FT 场景允许保留 PTK SA

## 5.2 EAPOL 状态机是怎么驱动的？——eapol_sm_step()

EAPOL 状态机是 supplicant 侧管理认证和密钥的中央调度器。它由 `eapol_sm_step()` 驱动，每次被调用时以循环模式运行三个子状态机：

```c
// src/eapol_supp/eapol_supp_sm.c（源码有部分精简）
void eapol_sm_step(struct eapol_sm *sm)
{
    int i;

    // 最多迭代 100 次，避免忙循环
    for (i = 0; i < 100; i++) {
        sm->changed = false;

        SM_STEP_RUN(SUPP_PAE);   // Port Access Entity：认证端口控制
        SM_STEP_RUN(KEY_RX);     // 密钥接收状态机
        SM_STEP_RUN(SUPP_BE);    // Backend 状态机：EAP Request/Response

        if (eap_peer_sm_step(sm->eap))
            sm->changed = true;

        if (!sm->changed)
            break;  // 没有状态变化，退出循环
    }

    // 如果 100 次迭代还没完，延迟到下一轮 eloop 继续
    if (sm->changed) {
        eloop_cancel_timeout(eapol_sm_step_timeout, NULL, sm);
        eloop_register_timeout(0, 0, eapol_sm_step_timeout, NULL, sm);
    }

    // 通知上层认证结果
    if (sm->ctx->cb && sm->cb_status != EAPOL_CB_IN_PROGRESS) {
        // SUCCESS / FAILURE / EXPECTED_FAILURE
        sm->ctx->cb(sm, result, sm->ctx->cb_ctx);
    }
}
```

三大子状态机的职责：

| 子状态机     | 核心状态                                                     | 职责                     |
| ------------ | ------------------------------------------------------------ | ------------------------ |
| **SUPP_PAE** | LOGOFF → DISCONNECTED → CONNECTING → AUTHENTICATING → AUTHENTICATED | 管理 802.1X 端口授权状态 |
| **KEY_RX**   | NO_KEY_RECEIVE → KEY_RECEIVE                                 | 接收 EAPOL-Key 帧        |
| **SUPP_BE**  | IDLE → REQUEST → RESPONSE → SUCCESS / FAIL                   | 处理 EAP 消息交换        |

为什么 EAPOL 和 WPA 是两个独立的状态机？

这源自 802.1X 架构的分层设计：**EAPOL 状态机负责"端口授权"（能不能上网的开关），WPA 状态机负责"密钥协商"（用什么密钥加密）**。二者分工不同：

- **EAPOL 状态机**：管理 802.1X 端口授权状态（PAE = Port Access Entity）。它回答的是"这个端口现在能让数据通过吗？"——不管是 EAP 认证通过（企业网）还是 PSK 模式跳过（家庭网），最终都要它把 `portValid` 设为 true，数据面才真正打通。
- **WPA 状态机**：管理四次握手和组密钥更新（`wpa.c`）。它回答的是"当前用的加密密钥是什么？"——负责 PMK 获取、PTK 推导、GTK 安装。

对于 PSK 模式，EAPOL 的 SUPP_PAE 直接从 CONNECTING → AUTHENTICATED（跳过 EAP 认证），但 WPA 状态机仍然正常执行四次握手——因为即使不需要 802.1X 认证，密钥协商仍然必不可少。这就是为什么 `wpa_supplicant_rx_eapol()` 中 PSK 模式的 EAPOL-Key 帧直接交给 `wpa_sm_rx_eapol()` 处理，而不是走 EAPOL 状态机的 SUPP_BE。

与 EAPOL 的轮询式状态机（`eapol_sm_step()` 循环驱动）不同，WPA 侧的密钥协商状态机是**事件驱动**的：它没有自己的 `step()` 循环，而是由 `wpa_sm_rx_eapol()` 收到 EAPOL-Key 帧后直接分发到对应处理函数，处理函数内部用 `wpa_sm_set_state()` 推进状态。四次握手期间的状态链如下：

```none
WPA_ASSOCIATED ──(收到 msg 1/4)──▶ WPA_4WAY_HANDSHAKE ──(收到 msg 3/4)──▶ WPA_GROUP_HANDSHAKE
      ▲                                                                        │
      └──────────────────────────(GTK 安装完成)──────────────── WPA_COMPLETED
```

- `WPA_ASSOCIATED → WPA_4WAY_HANDSHAKE`：`wpa_supplicant_process_1_of_4()` 里的 `wpa_sm_set_state(sm, WPA_4WAY_HANDSHAKE)`（`wpa.c:1019`）触发，标志 PTK 推导开始
- `WPA_4WAY_HANDSHAKE → WPA_GROUP_HANDSHAKE`：`wpa_supplicant_process_3_of_4()` 里 `wpa_sm_set_state(sm, WPA_GROUP_HANDSHAKE)`（`wpa.c:2928`）触发，PTK 已安装、GTK 待安装
- `WPA_GROUP_HANDSHAKE → WPA_COMPLETED`：`wpa_supplicant_key_neg_complete()` 里 `wpa_sm_set_state(sm, WPA_COMPLETED)` 触发，密钥协商收尾

这套状态命名（`WPA_4WAY_HANDSHAKE`/`WPA_GROUP_HANDSHAKE`/`WPA_COMPLETED`）来自 `enum wpa_states`（`defs.h:248`），与顶层 supplicant 状态机共用同一枚举——这也是 §2.3 那张状态表能一路连到 §5 的原因：SME 认证/关联（`WPA_AUTHENTICATING`/`WPA_ASSOCIATING`）和 WPA 密钥协商（`WPA_4WAY_HANDSHAKE` 起）是同一状态机的两段。

## 5.3 四次握手——从 msg 1/4 到 msg 4/4

AP 在关联完成后会立即发送 EAPOL-Key msg 1/4（携带 ANonce）。supplicant 的接收路径是：

```
Driver report EAPOL frame
  → wpa_supplicant_rx_eapol()          [wpa_supplicant.c]
    → wpa_sm_rx_eapol()                [wpa.c]
      → 根据 key_info 分发：
```

`wpa_supplicant_rx_eapol()` 是 EAPOL 帧的总入口：

```c
// wpa_supplicant/wpa_supplicant.c（源码有部分精简）
void wpa_supplicant_rx_eapol(void *ctx, const u8 *src_addr,
                             const u8 *buf, size_t len,
                             enum frame_encryption encrypted)
{
    struct wpa_supplicant *wpa_s = ctx;

    // 正在主动断开 → 丢弃
    if (wpa_s->own_disconnect_req) return;

    // 尚未关联完成 → 缓存帧，等关联事件到达后再处理
    if (wpa_s->wpa_state < WPA_ASSOCIATED) {
        wpa_s->pending_eapol_rx = wpabuf_alloc_copy(buf, len);
        // 记录了 src_addr 和时间戳
        return;
    }

    // WPA-PSK / OWE / DPP 模式 → 直接交给 WPA 状态机处理 EAPOL-Key
    if (!(wpa_s->drv_flags & WPA_DRIVER_FLAGS_4WAY_HANDSHAKE_PSK))
        wpa_sm_rx_eapol(wpa_s->wpa, src_addr, buf, len, encrypted);
    // 如果是 4-way handshake offload 模式 → 设置 portValid 跳过
    else if (wpa_key_mgmt_wpa_ieee8021x(wpa_s->key_mgmt))
        eapol_sm_notify_portValid(wpa_s->eapol, true);
}
```

主要功能：

- **竞态处理**：EAPOL 帧和关联事件可能以任意顺序到达（它们走不同的驱动回调路径）。如果 EAPOL 先到但关联事件还没到，帧会被缓存在 `pending_eapol_rx` 中，等 `EVENT_ASSOC` 到达后再处理
- `WPA_DRIVER_FLAGS_4WAY_HANDSHAKE_PSK` 标志表示驱动自己做完四次握手——这种情况下 supplicant 直接标记 portValid=true，跳过整个握手流程

**四次握手消息分发**（在 `wpa_sm_rx_eapol()` 内部）：

| 收到的帧              | 判定条件                    | 处理函数                          | 发生什么                                                     |
| --------------------- | --------------------------- | --------------------------------- | ------------------------------------------------------------ |
| **msg 1/4**           | Pairwise key, 无 MIC        | `wpa_supplicant_process_1_of_4()` | 收到 ANonce → 生成 SNonce → 计算 PTK → 构造并发送 msg 2/4（携带 SNonce + MIC） |
| **msg 3/4**           | Pairwise key, 有 MIC + ENCR | `wpa_supplicant_process_3_of_4()` | 验证 MIC → 安装 PTK → 安装 GTK → 构造并发送 msg 4/4（确认 ACK） |
| **Group Key msg 1/2** | Group key, 有 MIC, 无 ACK   | `wpa_supplicant_process_1_of_2()` | 验证 MIC → 安装新 GTK → 回复 Group Key msg 2/2（ACK）。**注意**：这是独立的两帧组密钥握手（Group Key Handshake），不是四次握手的第 5/6 帧。触发场景：四次握手完成后 AP 发起 GTK 更新（rekey） |

**msg 1/4 处理细节**（`wpa_supplicant_process_1_of_4()`）：

```c
// src/rsn_supp/wpa.c（源码有部分精简）
static void wpa_supplicant_process_1_of_4(struct wpa_sm *sm,
        const unsigned char *src_addr, const struct wpa_eapol_key *key,
        u16 ver, const u8 *key_data, size_t key_data_len)
{
    struct wpa_eapol_ie_parse ie;
    struct wpa_ptk *ptk;

    // 1. 解析 key_data 中的 IE/KDE（含 PMKID）
    os_memset(&ie, 0, sizeof(ie));
    if (wpa_supplicant_parse_ies(key_data, key_data_len, &ie) < 0)
        return;

    // 2. 通过 PMKID 获取 PMK
    //    - PSK 模式：使用 setPsk/setPskPassphrase 存入的 PSK/PMK
    //    - EAP 模式：从 EAPOL 状态机取 PMK
    if (wpa_supplicant_get_pmk(sm, src_addr, ie.pmkid))
        goto failed;

    wpa_sm_set_state(sm, WPA_4WAY_HANDSHAKE);

    // 3. 生成新的 SNonce（Supplicant Nonce）
    if (sm->renew_snonce) {
        if (random_get_bytes(sm->snonce, WPA_NONCE_LEN))
            goto failed;
        sm->renew_snonce = 0;
    }

    // 4. 计算 PTK（临时，等 msg 3/4 验证后才正式安装）
    //    PTK = PRF-512(PMK, "Pairwise key expansion",
    //                  min(AA, SPA) || max(AA, SPA) ||
    //                  min(ANonce, SNonce) || max(ANonce, SNonce))
    ptk = &sm->tptk;
    if (wpa_derive_ptk(sm, src_addr, key, ptk) < 0)
        goto failed;
    sm->tptk_set = 1;

    // 5. 构造并发送 msg 2/4（携带 SNonce + MIC）
    if (wpa_supplicant_send_2_of_4(sm, src_addr, key, ver,
                                   sm->snonce, sm->assoc_wpa_ie,
                                   sm->assoc_wpa_ie_len, ptk) < 0)
        goto failed;

    // 6. 保存 ANonce（供 msg 3/4 验证使用）
    os_memcpy(sm->anonce, key->key_nonce, WPA_NONCE_LEN);
    return;

failed:
    wpa_sm_deauthenticate(sm, WLAN_REASON_UNSPECIFIED);
}
```

主要功能：

- 解析 AP 发来的 key_data，提取 PMKID（用于找到对应的 PMK）
- `wpa_derive_ptk()` 是 PTK 计算的实现——使用 PRF-512 伪随机函数，输入 PMK + ANonce + SNonce + MAC 地址，输出 KCK/KEK/TK
- PTK 先存为临时 key（`tptk`），等 msg 3/4 MIC 验证通过后才正式安装——这是抵抗篡改攻击的关键设计
- **为什么 PTK 先存 `tptk` 不直接安装？**为了抵抗篡改攻击：如果攻击者在 msg 1/4 或 msg 2/4 中篡改了 ANonce/SNonce，PTK 就会算错。
- 所以先算出来暂存为 `tptk`，等 msg 3/4 的 MIC 验证通过（证明双方算出的 PTK 一致）后才正式安装，确保只有正确的密钥才会被用于加密数据。

**四次握手速查表**：

| 消息编号 | 发送方   | 关键内容                     | 这一步做了什么                                            | 为什么这样设计                                               |
| -------- | -------- | ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| msg 1/4  | AP → STA | ANonce                       | AP 发送随机数 ANonce，供 STA 计算 PTK                     | ANonce 是 PTK 推导的必要输入——没有它，STA 无法生成加密密钥   |
| msg 2/4  | STA → AP | SNonce + MIC                 | STA 生成 SNonce，计算 PTK（存为临时 tptk），回复 MIC      | SNonce 保证每次握手的 PTK 不同；MIC 用 KCK 签名，防止伪造    |
| msg 3/4  | AP → STA | GTK + MIC + INSTALL + SECURE | AP 验证 msg 2/4 的 MIC，下发 GTK，指示安装 PTK 和打开端口 | INSTALL 和 SECURE 分步处理：先确保密钥正确，再授权数据面——安全分层 |
| msg 4/4  | STA → AP | ACK（MIC）                   | STA 回复确认 ACK，正式安装 PTK                            | 先发 ACK 再安装 PTK：防止 AP 因未收到 ACK 而认为握手失败、触发重传 |

**msg 3/4 处理细节**（`wpa_supplicant_process_3_of_4()`）：

```c
// src/rsn_supp/wpa.c（源码有部分精简）
static void wpa_supplicant_process_3_of_4(struct wpa_sm *sm,
        const struct wpa_eapol_key *key, u16 ver,
        const u8 *key_data, size_t key_data_len)
{
    u16 key_info, keylen;
    struct wpa_eapol_ie_parse ie;

    wpa_sm_set_state(sm, WPA_4WAY_HANDSHAKE);
    key_info = WPA_GET_BE16(key->key_info);

    // 1. 解析 IE/KDE（RSNE、GTK、IGTK）
    if (wpa_supplicant_parse_ies(key_data, key_data_len, &ie) < 0)
        goto failed;

    // 2. 验证 ANonce 与 msg 1/4 一致（防止中间人篡改）
    if (os_memcmp(sm->anonce, key->key_nonce, WPA_NONCE_LEN) != 0)
        goto failed;

    // 3. 验证密钥长度
    keylen = WPA_GET_BE16(key->key_length);
    if (keylen != wpa_cipher_key_len(sm->pairwise_cipher))
        goto failed;

    // 4. 发送 msg 4/4（确认 ACK，用 KCK 做 MIC）
    if (wpa_supplicant_send_4_of_4(sm, sm->bssid, key, ver,
                                   key_info, &sm->ptk) < 0)
        goto failed;
    sm->renew_snonce = 1;

    // 5. INSTALL 标志置位 → 正式安装 PTK
    if (key_info & WPA_KEY_INFO_INSTALL) {
        if (wpa_supplicant_install_ptk(sm, key, KEY_FLAG_RX_TX))
            goto failed;
    }

    // 6. SECURE 标志置位 → 端口授权，数据面打通
    if (key_info & WPA_KEY_INFO_SECURE) {
        wpa_sm_mlme_setprotection(sm, sm->bssid,
                MLME_SETPROTECTION_PROTECT_TYPE_RX,
                MLME_SETPROTECTION_KEY_TYPE_PAIRWISE);
        eapol_sm_notify_portValid(sm->eapol, true);
    }
    wpa_sm_set_state(sm, WPA_GROUP_HANDSHAKE);

    // 7. 安装 GTK（组密钥），完成后调用 key_neg_complete
    if (ie.gtk &&
        wpa_supplicant_pairwise_gtk(sm, key, ie.gtk, ie.gtk_len,
                                    key_info) < 0)
        goto failed;
    wpa_supplicant_key_neg_complete(sm, sm->bssid,
                                    key_info & WPA_KEY_INFO_SECURE);
    return;

failed:
    wpa_sm_deauthenticate(sm, WLAN_REASON_UNSPECIFIED);
}
```

主要功能：

- ANonce 一致性校验是抵抗中间人攻击的关键——如果 msg 3/4 的 ANonce 与 msg 1/4 不同，说明有人在中间篡改
- `WPA_KEY_INFO_INSTALL` 标志是 PTK 安装的信号——在此之前 PTK 只是临时计算，不真正用于加密
- `WPA_KEY_INFO_SECURE` 置位后调用 `eapol_sm_notify_portValid(true)`——这是数据面打通的最后一道闸门
- **为什么 msg 4/4 先发 ACK 再安装 PTK？**代码中 `send_4_of_4`（wpa.c 第 2685 行）在 `INSTALL` 处理（第 2694 行）之前——顺序是精心设计的。
- 如果先安装 PTK 再发 ACK，万一 msg 4/4 丢包，AP 因未收到 ACK 而认为握手失败、重传 msg 3/4，但此时 STA 已经用新 PTK 了，两边密钥状态不一致。先发 ACK 确保 AP 知道握手成功，再安装 PTK 保证一致性。

PTK/GTK 安装到哪里？

- `wpa_supplicant_install_ptk()` 和 `wpa_supplicant_install_gtk()` 最终调用 `wpa_drv_set_key()`，通过 nl80211 下发 `NL80211_CMD_NEW_KEY` 到内核
- 内核 cfg80211/mac80211 将密钥写入 WiFi 芯片的**硬件密钥表（hardware key table）**——不是存在内存里，是写到芯片的寄存器/专用 SRAM 中
- **PTK** 写入 Pairwise Key 表项（key_idx 固定为 0），Key Type 为 Pairwise——硬件用它对单播数据帧做硬件级 AES-CCMP/GCMP 加解密，CPU 完全不参与加解密运算
- **GTK** 写入 Group Key 表项（key_idx 由 AP 指定，0-3），Key Type 为 Group——硬件用它对广播/组播帧做硬件级解密
- 密钥只存在于 WiFi 芯片内部，wpa_supplicant 进程甚至内核都无法再读出明文密钥——这是硬件安全隔离的底线

下次收到数据帧时，WiFi 芯片的硬件引擎根据帧的 MAC 地址自动选择 Pairwise Key 或 Group Key 表项，在 DMA 传输过程中完成加解密，CPU 看到的是已经解密后的明文数据。

> Group Key Handshake 发生在四次握手完成之后，因此移至 §5.5 独立展开。

## 5.4 握手完成——WPA_COMPLETED

四次握手完成后，`wpa_supplicant_key_neg_complete()` 被调用：

```c
// src/rsn_supp/wpa.c（关键步骤摘要）
// 1. wpa_sm_set_state(sm, WPA_COMPLETED)
// 2. eapol_sm_notify_portValid(sm->eapol, true)  // 端口授权
// 3. 如果驱动支持 rekey offload，下发 KEK/KCK/replay_counter
//    → wpa_drv_set_rekey_info() 让驱动硬件自己处理 GTK 更新
// 4. 启动预认证计时器（为未来漫游做准备）
```

此时连接正式建立。从这之后，数据帧可以使用协商好的 PTK 进行加密通信。

四次握手就像制卡机给客人发房卡——msg 1/4 是门禁系统发来门锁的随机数（ANonce），msg 2/4 是制卡机用自己的随机数（SNonce）混入门锁数算出密钥（PTK）并回复，msg 3/4 是门禁系统确认密钥正确并告知公共区密钥（GTK），msg 4/4 是制卡机回复"房卡已激活"。至此，客人可以用房卡进房间了。

## 5.5 补充：Group Key Handshake（组密钥更新）

四次握手完成后的通信使用 PTK 保护单播帧，但广播/组播帧需要 GTK（Group Transient Key）保护。GTK 的初始值在 msg 3/4 中由 AP 下发，之后 AP 会定期发起 **Group Key Handshake**（两帧交换，独立于四次握手）来更新 GTK，防止长期使用同一组密钥。

> 802.11 规范将这组两帧交换称为 Group Key Handshake（IEEE 802.11-2024 §12.7.7），而不是"四次握手的第 5/6 帧"。supplicant 的 `wpa_sm_rx_eapol()` 里通过 `key_info` 的 Key Type 位（bit 4）区分：置 1 为 Pairwise key（走四次握手），置 0 为 Group key（走组密钥握手）。

**触发时机**：AP 在四次握手完成后，通过 GTK KDE 的超时或事件触发 GTK rekey。驱动收到 EAPOL-Key 帧后上报 supplicant，在 `wpa_sm_rx_eapol()` 中检测到 Key Type=Group → 调用 `wpa_supplicant_process_1_of_2()`。

**Group Key Handshake 流程**：

```none
AP                                    STA
 │                                     │
 │ ─── EAPOL-Key Group msg 1/2 ────→  │  携带新 GTK（用 KEK 加密 + KCK 签名 MIC）
 │       [GTK KDE, keyidx, RSC]       │
 │                                     │  wpa_supplicant_process_1_of_2()
 │                                     │  ├─ 验证 msg_3_of_4_ok（四次握手必须已完成）
 │                                     │  ├─ wpa_supplicant_parse_ies() 提取 GTK KDE
 │                                     │  ├─ wpa_supplicant_install_gtk() 安装新 GTK
 │                                     │  └─ wpa_supplicant_send_2_of_2() 发送 ACK
 │                                     │
 │ ←── EAPOL-Key Group msg 2/2 ────   │  ACK（MIC），确认 GTK 已安装
 │                                     │
 │  AP 收到 ACK 后切换到新 GTK         │
```

核心处理函数（AOSP wpa_supplicant 源码）：

```c
// src/rsn_supp/wpa.c（源码有部分精简）
static void wpa_supplicant_process_1_of_2(struct wpa_sm *sm,
        const unsigned char *src_addr,
        const struct wpa_eapol_key *key,
        const u8 *key_data, size_t key_data_len, u16 ver)
{
    u16 key_info;
    struct wpa_gtk_data gd;
    struct wpa_eapol_ie_parse ie;

    // 防御：四次握手必须已完成
    if (!sm->msg_3_of_4_ok && !wpa_fils_is_completed(sm)) {
        wpa_msg(sm->ctx->msg_ctx, MSG_INFO,
                "RSN: Group Key Handshake started prior to "
                "completion of 4-way handshake");
        goto failed;
    }

    os_memset(&gd, 0, sizeof(gd));
    key_info = WPA_GET_BE16(key->key_info);

    // 解析 IE/KDE，提取 GTK
    if (wpa_supplicant_parse_ies(key_data, key_data_len, &ie) < 0)
        goto failed;

    wpa_sm_set_state(sm, WPA_GROUP_HANDSHAKE);

    // 安全检查：GTK 必须在加密的 key_data 中（KEK 加密）
    if (ie.gtk && !(key_info & WPA_KEY_INFO_ENCR_KEY_DATA)) {
        wpa_msg(sm->ctx->msg_ctx, MSG_WARNING,
                "RSN: GTK KDE in unencrypted key data");
        goto failed;
    }
    // GTK KDE 缺失 → 协议错误
    if (!ie.gtk) goto failed;

    // 提取 GTK 关键字段
    gd.keyidx = ie.gtk[0] & 0x3;          // Key ID（0-3）
    gd.tx = wpa_supplicant_gtk_tx_bit_workaround(sm,
                     !!(ie.gtk[0] & BIT(2)));  // Tx 标志
    os_memcpy(gd.gtk, ie.gtk + 2, gtk_len);   // GTK 密钥本体

    // 安装 GTK + IGTK（管理帧保护密钥）
    if (wpa_supplicant_install_gtk(sm, &gd, key_rsc, 0) ||
        wpa_supplicant_send_2_of_2(sm, key, ver, key_info) < 0)
        goto failed;

    // Rekey 完成 → 回到 COMPLETED 状态
    wpa_sm_cancel_auth_timeout(sm);
    wpa_sm_set_state(sm, WPA_COMPLETED);

    // 如果驱动支持 rekey offload，把新 GTK 下发到硬件
    wpa_sm_set_rekey_offload(sm);
    return;

failed:
    forced_memzero(&gd, sizeof(gd));
    wpa_sm_deauthenticate(sm, WLAN_REASON_UNSPECIFIED);
}
```

主要功能：

- **前置条件**：`msg_3_of_4_ok` 必须为 true——四次握手未完成时收到的 Group Key 帧直接丢弃
- **GTK 解析**：GTK 存储在 EAPOL-Key 帧的 key_data 字段中，以 KDE（Key Data Encapsulation）格式编码，用 KEK 加密
- **安全保证**：`ENCR_KEY_DATA` 标志位必须置位——GTK 绝不能明文传输，否则同一 BSS 内其他 STA 可窃听
- **Key ID 轮转**：`keyidx` 取 GTK KDE 首字节的低 2 位，AP 通过在不同的 keyidx（0/1/2/3）之间切换来实现无缝 GTK 更新
- **rekey offload**：如果驱动支持，`wpa_sm_set_rekey_offload()` 把新 GTK 下发到驱动硬件，后续 GTK 更新由驱动自己处理，不再经过 supplicant

Group Key Handshake 就像酒店更换公共区域的通用门禁码——不影响每个房间的独立密码（PTK），但所有人进健身房/泳池的门禁码要统一更换。AP 是酒店安保部，定期换码防止被破解；msg 1/2 是安保部用每个房间的专属加密通道（KEK）把新码传给制卡机，msg 2/2 是制卡机确认"新码已生效"。

---

# 6 两条路——SME vs 非 SME 模式全景对比

SME 模式两步走（`CMD_AUTHENTICATE` → `CMD_ASSOCIATE`），非 SME 模式一步走（`CMD_CONNECT`）。区别的本质是谁来控制认证帧的交换——supplicant 还是驱动。

## 6.1 完整时序对比

![Supplicant L2 连接时序 — SME 模式（两步走）](assets/06b-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%8C%EF%BC%89Supplicant-%E5%B1%82-L2-%E8%BF%9E%E6%8E%A5%E5%85%A8%E9%93%BE%E8%B7%AF/06b-sequence-l2-connect.svg)

> 此图仅展示 SME 模式路径（`CMD_AUTHENTICATE` + `CMD_ASSOCIATE` 两步走）；非 SME 模式（`CMD_CONNECT` 一步走）的时序见下方 ASCII 时序图。

**SME 模式（SAE / FT / FILS / OWE）**：

```
supplicant                         nl80211 / 驱动
    │                                    │
    ├─ sme_authenticate()                │
    ├─ radio work "sme-connect"          │
    ├─ sme_auth_start_cb()               │
    ├─ sme_send_authentication()         │
    │   ├─ auth_alg 决策                  │
    │   └─ wpa_drv_authenticate() ──────→│ NL80211_CMD_AUTHENTICATE
    │      [BSSID, Freq, SSID, IE, AuthType, SAE_Data]
    │                                    │ 驱动发出 Auth Req 帧
    │                                    │ 驱动收到 Auth Resp 帧
    │                                    │
    │ ←── EVENT_AUTH ────────────────────│
    ├─ sme_event_auth()                  │
    │   ├─ SAE: sme_sae_auth() 多帧处理   │
    │   ├─ FT: wpa_ft_process_response() │
    │   └─ sme_associate() ─────────────→│ NL80211_CMD_ASSOCIATE
    │      [BSSID, SSID, IE(WPA/RSN), Ciphers, AKM]
    │                                    │ 驱动发出 Assoc Req 帧
    │                                    │ 驱动收到 Assoc Resp 帧
    │                                    │
    │ ←── EVENT_ASSOC ───────────────────│
    ├─ wpa_sm_notify_assoc()             │
    │                                    │
    │ ←── EAPOL-Key msg 1/4 ────────────│ AP 发送 ANonce
    ├─ process_1_of_4() → msg 2/4       │
    │ ←── EAPOL-Key msg 3/4 ────────────│ AP 发送 GTK + MIC
    ├─ process_3_of_4() → msg 4/4       │
    ├─ WPA_COMPLETED                     │
```

**非 SME 模式（WPA2-PSK / Open）**：

```none
supplicant                         nl80211 / 驱动
    │                                    │
    ├─ wpa_supplicant_associate()        │
    ├─ radio_add_work("connect")         │
    ├─ wpas_start_assoc_cb()             │
    │   ├─ wpas_populate_assoc_ies()     │
    │   └─ wpa_drv_associate() ─────────→│ NL80211_CMD_CONNECT
    │      [BSSID, Freq, SSID, IE, Ciphers, AKM, PSK/PMK, AuthType]
    │                                    │ 驱动自己完成：
    │                                    │   1. Auth Req / Resp
    │                                    │   2. Assoc Req / Resp
    │                                    │   3. (可选) 4-way handshake
    │                                    │
    │ ←── EVENT_ASSOC ───────────────────│
    ├─ wpa_sm_notify_assoc()             │
    │   (后续四次握手同上，除非 offload)   │
```

## 6.2 为什么 WPA2-PSK 走非 SME

WPA2-PSK 的 802.11 认证阶段和 Open 网络完全相同——只交换两个 Authentication 帧（Algorithm=Open System 的 Req + Resp），不需要额外的帧交换。真正的安全发生在 Association 之后的四次握手。

因此 Auth+Assoc 可以合并成一个 `CMD_CONNECT` 命令交给驱动处理——驱动发出 Auth Req → 等待 Auth Resp → 发出 Assoc Req → 等待 Assoc Resp，四步自动完成。supplicant 不需要介入中间步骤，只需要等待最终结果。

普通客人的入住不需要在贵宾室验证——前台直接核验身份证（Auth=Open，只是形式），然后签入住单（Assoc），发房卡（4-way handshake）。整个过程一步到位。

**非 SME 路径的 IE 构建——wpas_populate_assoc_ies()**

非 SME 模式下，supplicant 虽然不控制 Auth/Assoc 帧交互，但仍然负责构建 Association Request 帧体中的 IE（Information Elements）。这个工作由 `wpas_populate_assoc_ies()` 完成——它是一个约 580 行的巨型函数（`wpa_supplicant.c:3469`），返回动态分配的 IE 缓冲区，供 `wpa_drv_associate()` 通过 `NL80211_ATTR_IE` 传给 `NL80211_CMD_CONNECT`。

```c
// wpa_supplicant/wpa_supplicant.c:3469（源码有部分精简）
static u8 * wpas_populate_assoc_ies(
    struct wpa_supplicant *wpa_s,
    struct wpa_bss *bss, struct wpa_ssid *ssid,
    struct wpa_driver_associate_params *params,
    enum wpa_drv_update_connect_params_mask *mask)
{
    u8 *wpa_ie;
    size_t max_wpa_ie_len = 500;
    size_t wpa_ie_len;
    int algs = WPA_AUTH_ALG_OPEN;

    wpa_ie = os_malloc(max_wpa_ie_len);
    if (!wpa_ie) return NULL;

    // === 第一组：安全 IE（RSNE / WPA IE） ===
    // 调用 wpa_supplicant_set_suites() 根据 key_mgmt / pairwise_cipher
    // 生成完整的 RSNE 字节流（Element ID=48），写入 wpa_ie 缓冲区
    if (bss && wpa_bss_get_rsne(wpa_s, bss, ssid, false) &&
        wpa_key_mgmt_wpa(ssid->key_mgmt)) {
        // 尝试 PMKSA 缓存（可能触发 SAE PMKSA caching 降级）
        int try_opportunistic = ...;
        pmksa_cache_set_current(wpa_s->wpa, NULL, bss->bssid, ssid, ...);
        wpa_ie_len = max_wpa_ie_len;
        wpa_supplicant_set_suites(wpa_s, bss, ssid,
                                  wpa_ie, &wpa_ie_len, false);
    }

    // === 第二组：auth_alg 自动选择 ===
    // LEAP / FILS / SAE / 用户覆盖 → algs 赋值
    // SAE PMKSA 缓存命中 → algs 降级为 WPA_AUTH_ALG_OPEN

    // === 第三组：扩展 IE 逐类填充 ===
    // Extended Capabilities（wpas_build_ext_capab）
    // BSS Max Idle Period
    // FT Mobility Domain IE（802.11r 快速漫游）
    // FILS HLP container / OWE DH Parameters / DPP PFS
    // HS 2.0 / MBO / MSCS / Multi-AP / WFA Capabilities
    // RSN Selection / Vendor Elements
    // ... 共约 14 类 IE ...

    // 将结果写入 params，供驱动下发
    params->wpa_ie = wpa_ie;
    params->wpa_ie_len = wpa_ie_len;
    params->auth_alg = algs;
    if (mask)
        *mask |= WPA_DRV_UPDATE_ASSOC_IES | WPA_DRV_UPDATE_AUTH_TYPE;
    return wpa_ie;
}
```

主要功能：

- 返回 `static u8 *`（分配的 IE 缓冲区），通过 `params->wpa_ie` 传出，最终作为 `NL80211_ATTR_IE` 随 `NL80211_CMD_CONNECT` 下发
- **RSNE 构建**由 `wpa_supplicant_set_suites()` 完成：根据 `ssid->key_mgmt`、`pairwise_cipher`、PMF 设置等生成 AP 期望的 RSNE 字节流
- **HT/VHT/HE Capabilities 不在此函数中构建**——这些能力由驱动通过 nl80211 能力探测阶段（`NL80211_ATTR_HT_CAPABILITY` 等）自动携带，不是 supplicant 的职责
- auth_alg 也在此函数中自动选择（SAE/LEAP/FILS 等），与 SME 模式的 `sme_send_authentication()` 形成平行决策

**非 SME 路径的失败收敛**：SME 路径靠 §4.3 的 `sme_auth_timer`/`sme_assoc_timer` 两个 5 秒定时器兜底，非 SME 路径则是另一套。`wpas_start_assoc_cb()`（`wpa_supplicant.c:4232`）末尾调用 `wpa_drv_associate()` 下发 `CMD_CONNECT`——若驱动立即返回错误（`ret < 0`）且声明了 `WPA_DRIVER_FLAGS_VALID_ERROR_CODES`，supplicant 直接调 `wpas_connection_failed()` 并迁回 `WPA_DISCONNECTED`；否则置 `assoc_failed = 1`，继续等驱动后续事件。下发成功后，`wpa_supplicant_req_auth_timeout()` 挂一个认证超时定时器（默认 60 秒，`ap_scan==1` 时 10 秒），超时后驱动上报的 `EVENT_AUTH_TIMED_OUT`/`EVENT_ASSOC_TIMED_OUT` 同样收敛到 `wpas_connection_failed()`。

`wpas_connection_failed()`（`wpa_supplicant.c:8519`）是两条路径共同的失败终点：把失败 BSSID 加入忽略列表（`wpa_bssid_ignore_add()`），`consecutive_conn_failures` 加一，并按失败次数做指数退避（100/500/1000/5000/10000 毫秒）后发起下一次扫描，避免在同一个坏 AP 上无限重试。

## 6.3 为什么 SAE 默认走 SME（以及 SAE offload 例外）

SAE（WPA3）的认证阶段使用 Dragonfly 协议，需要四帧 Commit+Confirm 交换：

1. STA → AP：SAE Commit（椭圆曲线元素 + 标量）
2. AP → STA：SAE Commit（对方元素 + 标量）
3. STA → AP：SAE Confirm（验证标签）
4. AP → STA：SAE Confirm（对方验证标签）

这个过程中需要椭圆曲线运算（PWE 生成）、验证对方 Commit 的合法性、计算 Confirm 标签——默认情况下，supplicant 必须逐帧控制这些密码学操作，因此 SAE 走 SME 模式，通过 `CMD_AUTHENTICATE` 下发每帧的认证数据（`NL80211_ATTR_SAE_DATA`）。

**但"必须"不是绝对的——SAE offload 是例外。**

一些驱动（如 QCOM 的 wlan、MTK 的 connac）在固件中内置了完整的 SAE 状态机，可以独立完成 Dragonfly 握手。这种情况下，supplicant 不再逐帧控制 SAE 交互，而是把 SAE 密码通过 `NL80211_ATTR_SAE_PASSWORD` 属性一次性下发给驱动，驱动内部完成 Commit/Confirm 交换后直接上报认证结果。

**代码中的判断链**：

```none
sme_send_authentication() 中 auth_alg 决策
  │
  ├── key_mgmt 含 SAE + AP 支持 SAE?
  │     └── 是 → params.auth_alg = WPA_AUTH_ALG_SAE
  │           │
  │           ├── [无 SAE offload] → CMD_AUTHENTICATE（NL80211_ATTR_SAE_DATA）
  │           │     └── sme_sae_auth() 逐帧控制 Commit/Confirm 交换
  │           │
  │           └── [驱动支持 SAE offload] → 绕过 SME
  │                 └── CMD_CONNECT + NL80211_ATTR_SAE_PASSWORD
  │                      驱动内部完成 Dragonfly，直接上报结果
```

> SAE 默认走 SME 模式的 `sme_send_authentication()` 进行逐帧控制；当驱动通过能力探测声明 SAE offload 时，supplicant 走非 SME 路径，通过 `CMD_CONNECT` 一次性下发 SAE 密码，由驱动固件内置的 SAE 状态机完成 Dragonfly 握手。具体平台的 offload 支持情况见下方 §6.4。

## 6.4 QCOM 与 MTK 的实际差异

MTK 驱动层代码（AIS FSM 状态定义、connector 回调等）将在后续驱动层连接执行篇展开，本节仅在 wpa_supplicant 层面对比两个平台的能力上报差异。

先看 supplicant 侧怎么判断走不走 SME。能力探测阶段，`wiphy_info_supp_cmds()`（`driver_nl80211_capa.c:220`）遍历驱动上报的 `NL80211_ATTR_SUPPORTED_COMMANDS`，遇到 `NL80211_CMD_AUTHENTICATE` 就置 `auth_supported = 1`；随后 `wpa_driver_nl80211_get_info()`（`driver_nl80211_capa.c:1220`）据此设置 `WPA_DRIVER_FLAGS_SME`。

而这份属性列表由内核 cfg80211 按驱动注册的 ops 生成——`nl80211_add_commands_unsplit()`（`net/wireless/nl80211.c`）里 `CMD(auth, AUTHENTICATE)` 这条宏只在驱动注册了 `.auth` 回调时，才会把 `NL80211_CMD_AUTHENTICATE` 加进列表；`NL80211_CMD_CONNECT` 则只要注册了 `.connect` 就会上报。

两个平台在这一环节的注册情况是：

| 注册项           | QCOM (qcacld-3.0)                                            | MTK (gen4m)                                      |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `.connect`       | `wlan_hdd_cfg80211_connect`（`wlan_hdd_cfg80211.c:27302`）   | `mtk_cfg_connect`（`gl_init.c:1240`）            |
| `.assoc`         | 未注册                                                       | `mtk_cfg_assoc`（`gl_init.c:1257`）              |
| `.auth`          | 未注册                                                       | 未注册                                           |
| `.external_auth` | `wlan_hdd_cfg80211_external_auth`（`wlan_hdd_cfg80211.c:27370`） | `mtk_cfg80211_external_auth`（`gl_init.c:1300`） |

关键结论：两边都注册了 `.connect`，但**都没有注册 `.auth`**。因此两者上报的 `NL80211_ATTR_SUPPORTED_COMMANDS` 里都没有 `NL80211_CMD_AUTHENTICATE`，supplicant 也就不会给这两个平台设置 `WPA_DRIVER_FLAGS_SME`——它们都是非 SME（driver-based SME）驱动，Auth/Assoc 帧交换一律走 `CMD_CONNECT`：

| 场景            | QCOM (wlan)                     | MTK (wlan)                      | 机制                                                         |
| --------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| WPA2-PSK        | `CMD_CONNECT`                   | `CMD_CONNECT`                   | 非 SME，驱动完成 Auth+Assoc                                  |
| SAE offload     | `CMD_CONNECT` + SAE password    | `CMD_CONNECT` + SAE password    | 驱动固件内置 SAE 状态机                                      |
| SAE non-offload | `CMD_CONNECT` + `external_auth` | `CMD_CONNECT` + `external_auth` | 两侧都注册 `.external_auth`，supplicant 做 SAE 密码学、驱动只交换帧 |
| FT 漫游         | `CMD_CONNECT`（驱动内置 FT）    | `CMD_CONNECT`（驱动内置 FT）    | 都非 SME，FT 由驱动处理                                      |
| WPA2-EAP        | `CMD_CONNECT`                   | `CMD_CONNECT`                   | EAP 在 supplicant 侧处理                                     |

唯一可见的差异是 MTK 额外注册了 `.assoc`（以及 WiFi Direct 配置下的 `.deauth`/`.disassoc`），因此它的 `NL80211_ATTR_SUPPORTED_COMMANDS` 会比 QCOM 多一个 `NL80211_CMD_ASSOCIATE`。

但因为缺少配套的 `.auth`，这个命令对 supplicant 的 SME 决策没有影响——`wiphy_info_supp_cmds()` 只检查 `NL80211_CMD_AUTHENTICATE` 和 `NL80211_CMD_CONNECT`，并不关心 `NL80211_CMD_ASSOCIATE`。

换句话说，SME 与非 SME 的分水岭从来不是"哪家更先进"，而是"驱动愿不愿意把认证帧的每一步交回给 supplicant"。

QCOM 和 MTK 都选择了由驱动兜底，把 supplicant 挡在认证帧交换之外。

---

# 7 完整调用链总结

从 Framework 的 `connectToNetwork()` 到 nl80211 命令下发，连接命令跨越了 **Java → AIDL → C → Netlink** 四个边界：

```none
══════════════════════ Framework (Java) ══════════════════════
SupplicantStaIfaceHalAidlImpl.connectToNetwork()
  ├── removeAllNetworks()           → AIDL ISupplicantStaIface.list/remove
  ├── addNetworkAndSaveConfig()
  │     ├── addNetwork()            → AIDL ISupplicantStaIface.addNetwork()
  │     │     └── wpa_supplicant_add_network()       // wpa_supplicant.c
  │     │           └── wpa_config_add_network()     // 分配 wpa_ssid
  │     └── saveWifiConfiguration()
  │           ├── setSsid()         → AIDL setter → wpa_ssid->ssid
  │           ├── setPskPassphrase()→ AIDL setter → wpa_ssid->passphrase
  │           ├── setKeyMgmt()      → AIDL setter → wpa_ssid->key_mgmt
  │           ├── setBssid()        → AIDL setter → wpa_ssid->bssid
  │           └── ...
  └── networkHandle.select()        → AIDL ISupplicantStaNetwork.select()
        └── wpa_supplicant_select_network()           // wpa_supplicant.c
              ├── wpa_supplicant_fast_associate()     // BSS 缓存命中
              └── wpa_supplicant_req_scan()           // 缓存未命中→先扫描
                    └── EVENT_SCAN_RESULTS → wpa_supplicant_pick_network()  // events.c
                          ├── wpa_supplicant_select_bss()   // 按 priority 组遍历
                          └── wpa_scan_result_compar()      // 六级评分（scan.c）

════════════════════ wpa_supplicant (C) ════════════════════
wpa_supplicant_associate()                             // wpa_supplicant.c
  ├─ Phase 1: 状态清理（own_disconnect_req=0, pending_eapol cleanup）
  ├─ Phase 2: 重关联检测（reassoc_same_ess/bss）
  ├─ Phase 3: MAC 随机化（wpas_update_random_addr）
  └─ Phase 4: 模式分发
        │
        ├── [WPA_DRIVER_FLAGS_SME + INFRA] ← SAE/FT/FILS 走这里
        │     └── sme_authenticate()                       // sme.c
        │           └── radio_add_work("sme-connect", sme_auth_start_cb)
        │                 └── sme_auth_start_cb()
        │                       └── sme_send_authentication(wpa_s,bss,ssid,1)
        │                             ├─ auth_alg 决策：OPEN→SAE→FT→FILS
        │                             ├─ 构造 assoc_req_ie（预构建）
        │                             └─ wpa_drv_authenticate(&params)
        │                                   └─ wpa_driver_nl80211_authenticate()
        │                                         ├─ NL80211_CMD_AUTHENTICATE
        │                                         ├─ NL80211_ATTR_MAC (BSSID)
        │                                         ├─ NL80211_ATTR_SSID
        │                                         ├─ NL80211_ATTR_IE (Auth 帧体)
        │                                         ├─ NL80211_ATTR_SAE_DATA
        │                                         └─ NL80211_ATTR_AUTH_TYPE
        │
        │         [EVENT_AUTH 从驱动回调]
        │           └── sme_event_auth()                  // sme.c
        │                 ├─ SAE: sme_sae_auth() 多帧处理
        │                 ├─ 失败: auth_alg 降级 (OPEN→SHARED→LEAP)
        │                 └─ 成功: sme_associate()
        │                       └─ wpa_drv_associate(&params)
        │                             └─ wpa_driver_nl80211_associate()
        │                                   ├─ NL80211_CMD_ASSOCIATE
        │                                   └─ nl80211_connect_common() 共享参数
        │
        │         [EVENT_ASSOC 从驱动回调]
        │           └── wpa_sm_notify_assoc()             // wpa.c
        │                 ├─ 清除旧 PTK
        │                 └─ 等待 EAPOL-Key msg 1/4
        │
        │         [EAPOL-Key 帧到达]
        │           └── wpa_supplicant_rx_eapol()
        │                 └── wpa_sm_rx_eapol()
        │                       ├─ msg 1/4 → process_1_of_4() → msg 2/4
        │                       ├─ msg 3/4 → process_3_of_4() → msg 4/4
        │                       └─ wpa_supplicant_key_neg_complete()
        │                             └─ WPA_COMPLETED
        │
        └── [!WPA_DRIVER_FLAGS_SME] ← WPA2-PSK 走这里
              └── radio_add_work("connect", wpas_start_assoc_cb)
                    └── wpas_start_assoc_cb()
                          ├─ wpas_populate_assoc_ies()    // 构建 RSNE/HT/VHT IE
                          └─ wpa_drv_associate(&params)
                                └─ wpa_driver_nl80211_associate()
                                      └─ wpa_driver_nl80211_connect()
                                            └─ NL80211_CMD_CONNECT
                                                  ├─ SSID/BSSID/Freq
                                                  ├─ WPA/RSN IE
                                                  ├─ Cipher Suites (pairwise/group)
                                                  ├─ AKM Suites
                                                  ├─ PMK (handshake offload)
                                                  └─ AUTH_TYPE = OPEN

══════════════════════ Netlink 边界 ═══════════════════════
内核 cfg80211 收到 NL80211_CMD_CONNECT / CMD_AUTHENTICATE / CMD_ASSOCIATE
  └── 调用驱动注册的 connect/authenticate/associate 回调
        └── 驱动 Auth/Assoc 帧交换（下一篇内容）
```

## 关键函数速查

| 函数                                     | 文件                              | 作用                                            |
| ---------------------------------------- | --------------------------------- | ----------------------------------------------- |
| `StaIface::addNetworkInternal()`         | `aidl/vendor/sta_iface.cpp`       | AIDL 服务端：创建 wpa_ssid                      |
| `wpa_supplicant_add_network()`           | `wpa_supplicant/wpa_supplicant.c` | 分配并初始化 wpa_ssid                           |
| `StaNetwork::setSsidInternal()`          | `aidl/vendor/sta_network.cpp`     | SSID AIDL setter                                |
| `StaNetwork::setPskPassphraseInternal()` | 同上                              | PSK passphrase setter                           |
| `StaNetwork::setKeyMgmtInternal()`       | 同上                              | key_mgmt setter（含 FT 自动启用）               |
| `StaNetwork::selectInternal()`           | 同上                              | AIDL select：调用 wpa_supplicant_select_network |
| `wpa_supplicant_select_network()`        | `wpa_supplicant/wpa_supplicant.c` | 连接总调度：启用网络 + 触发扫描                 |
| `wpa_supplicant_pick_network()`          | `wpa_supplicant/events.c`         | 从扫描结果选网络：按 priority 组遍历            |
| `wpa_scan_result_compar()`               | `wpa_supplicant/scan.c`           | 候选 BSS 多级评分比较器                         |
| `wpa_supplicant_associate()`             | `wpa_supplicant/wpa_supplicant.c` | 连接总入口：四阶段准备 + 模式分发               |
| `sme_authenticate()`                     | `wpa_supplicant/sme.c`            | SME 模式启动：创建 sme-connect radio work       |
| `sme_send_authentication()`              | 同上                              | auth_alg 决策枢纽 + 构造 Auth 帧                |
| `sme_event_auth()`                       | 同上                              | Auth 响应处理 + 触发 sme_associate              |
| `sme_associate()`                        | 同上                              | 构造 Assoc Req + 下发 CMD_ASSOCIATE             |
| `sme_event_assoc_reject()`               | 同上                              | Assoc 拒绝处理（comeback/PMKSA 回退）           |
| `sme_state_changed()`                    | 同上                              | 状态迁移时清理 auth/assoc 定时器                |
| `wpa_drv_authenticate()`                 | `wpa_supplicant/driver_i.h`       | 驱动认证包装（函数指针）                        |
| `wpa_drv_associate()`                    | 同上                              | 驱动关联包装（函数指针）                        |
| `wpa_driver_nl80211_authenticate()`      | `src/drivers/driver_nl80211.c`    | 构建 NL80211_CMD_AUTHENTICATE                   |
| `wpa_driver_nl80211_associate()`         | 同上                              | 入口分流：CMD_CONNECT vs CMD_ASSOCIATE          |
| `nl80211_connect_common()`               | 同上                              | 共享参数填充（SSID/BSSID/Freq/IE/Cipher/AKM）   |
| `wpa_sm_notify_assoc()`                  | `src/rsn_supp/wpa.c`              | 关联完成触发 WPA 状态机                         |
| `eapol_sm_step()`                        | `src/eapol_supp/eapol_supp_sm.c`  | EAPOL 状态机驱动                                |
| `wpa_supplicant_rx_eapol()`              | `wpa_supplicant/wpa_supplicant.c` | EAPOL 帧接收入口                                |
| `wpa_sm_rx_eapol()`                      | `src/rsn_supp/wpa.c`              | 四次握手消息分发                                |

---

> Auth 和 Assoc 命令下发到内核之后，驱动具体怎么执行帧交换？QCOM 的 CM 状态机（5+9 状态）如何管理连接？MTK 的 AIS + SAA 两层状态机（17+8 状态）如何协作？这是下一篇「驱动层连接执行」要追踪的内容。

本篇涉及的 IEEE 802.11-2024 章节：

- 第 3 章：Station Management Entity (SME) 定义
- §11.3.4：Authentication and deauthentication
- §11.3.5：Association, reassociation, and disassociation
- §12.4.1 / §12.4.5：Simultaneous Authentication of Equals (SAE) 概述与协议
- §12.7.7：Group key handshake
- §13.5：Fast BSS Transition (FT) protocol
- §8.4.10：PTK SA 生命周期管理（wpa_supplicant 源码注释引用的旧版章节号）

本文代码出自 [external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/) 与 [packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi/) 仓库。
