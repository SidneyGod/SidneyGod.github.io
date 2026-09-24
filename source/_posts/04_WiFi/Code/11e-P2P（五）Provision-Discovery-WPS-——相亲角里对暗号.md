---
title: P2P（五）Provision Discovery + WPS ——相亲角里对暗号
top: 1
related_posts: true
abbrlink: 3b52a93c
date: 2026-09-24 22:37:32
tags:
  - Android WiFi
  - P2P
categories:
  - WiFi
  - Code
---

> 老大定了，地点定了——但你怎么证明你不是骗子？本文追踪从 Framework ProvisionDiscoveryState 到 WPS 注册成功的完整链路：Provision Discovery 亮出身份验证方式、WPS PIN/PBC 方法协商、EAP-WSC 八轮消息交换、15 秒超时兜底，以及驱动侧 WPS 帧收发。

---

# 本章导读

GO Negotiation 结束的那一刻，`p2p_go_complete()` 做了两件事：打包结果（GO 角色、信道、SSID、passphrase），然后把状态机切到 `P2P_PROVISIONING`。上一篇的结尾写道："谈判结束了，但建组还没开始——中间隔着 Provision Discovery + WPS。"

<!--more-->

这就像相亲角里，老大定了，地点也定了——但你怎么证明你不是骗子？你说你是来相亲的，但万一你是来骗资料的怎么办？所以 P2P 协议在这两个阶段之间插了一个"验证身份"的环节：先亮出你准备用什么方式证明自己（Provision Discovery），然后实际执行验证（WPS）。

具体来说，Provision Discovery 阶段双方确认用 PIN 码还是按按钮（PBC）来验证。如果大家都同意用 PIN，发起方显示一个 8 位 PIN，对方输入——对上了，暗号就对上了。如果大家同意按按钮，两边同时按下——就像击掌确认：击掌需要两人同时伸手，PBC 需要两台设备在 Walk Time 窗口内同时按下；击掌不需要先对暗号，PBC 也不需要输入任何 PIN——击掌的信任全在"此刻对方真的在面前"这个物理事实上，PBC 的信任也全押在物理在场假设上。确认之后，WPS 协议启动：GO 当验证官（Registrar），Client 当被验证方（Enrollee），通过 EAP-WSC 协议的八轮消息安全地交换配网凭据——不是简单把 PIN 发过去，而是通过 DH 密钥交换 + 加密传输。

整个过程只有 15 秒的暗号窗口期。过了 15 秒没对上，门就关了——`p2p_group_formation_failed()` 清理一切，回到空闲状态。

本文从 Framework `ProvisionDiscoveryState.enterImpl()` 到 `p2p_wps_success_cb()` / `p2p_group_formation_failed()`。不涉及 Group Formation 中的 Auth/Assoc/四次握手/DHCP（下一篇）。

PS：本文不涉及 WPS 的 NFC 和 P2PS 方法（留给后续应用协议篇）。WPS Registrar 内部的 PIN 校验算法也不展开——只追踪调用链。

先看一张全链路分层架构图，把本文要追踪的调用链放进整体里：从 App 的 `connect()` 一路经 Binder / AIDL / nl80211 三个跨进程边界，落到 wpa_supplicant 里的 Provision Discovery 帧交换（①），再进入 WPS 配网阶段（②，Registrar-Enrollee 的 EAP-WSC 八轮消息交换）。橙色是 PD 阶段的调用方向，紫色是 WPS 阶段的路径，WPS 的 M1-M8 走 EAPOL 数据帧、与 PD 的管理帧链分属两条不同的下行通道。

![P2P Provision Discovery 与 WPS 全链路分层架构](assets/11e-P2P%EF%BC%88%E4%BA%94%EF%BC%89Provision-Discovery-WPS-%E2%80%94%E2%80%94%E7%9B%B8%E4%BA%B2%E8%A7%92%E9%87%8C%E5%AF%B9%E6%9A%97%E5%8F%B7/11e-overview.svg)

---

# 1 Provision Discovery 怎么亮出身份证明方式？

先说清场景。上一篇（P2P（四）GO Negotiation）的结尾，GO Negotiation 三轮握手完成，`p2p_go_complete()` 调了回调 `go_neg_completed`。这个回调在 wpa_supplicant 层触发 `P2P_GO_NEGOTIATION_SUCCESS_EVENT`，传到 Framework 的 `GroupNegotiationState`。Framework 收到这个事件后干什么？答案是——直接忽略了它。

往回看上一篇 1.3 节的代码，`GroupNegotiationState.processMessageImpl()` 里对 `P2P_GO_NEGOTIATION_SUCCESS_EVENT` 的处理是直接忽略——源码注释写得很直白："We ignore these right now, since we get a GROUP_STARTED notification afterwards"。Framework 真正等的是 `P2P_GROUP_STARTED_EVENT`。

在这两个事件之间，P2P 协议还要走 Provision Discovery 和 WPS——Framework 并不是在 GroupNegotiationState 里干等，而是**在转入 GroupNegotiationState 之前就已经走了 ProvisionDiscoveryState**。

这里的关键是上一篇 1.2 节埋下的伏笔：InactiveState 收到 CONNECT 后，经过权限、config、Persistent Group 三层检查，**先转入 ProvisionDiscoveryState 做 PD 交换**，PD 成功后才调 `p2pConnectWithPinDisplay()` 再转入 GroupNegotiationState 发起 GO Negotiation。所以真实的时间线是：

```
InactiveState
  → ProvisionDiscoveryState（PD 交换，确认 WPS 方法）
    → p2pConnectWithPinDisplay()
  → GroupNegotiationState（GO 谈判）
    → GO 谈判完成，进入 P2P_PROVISIONING
  → WPS 配网（supplicant 内部）
    → WPS 成功 / 15s 超时失败
  → Group Formation → GroupCreatedState
```

Provision Discovery 虽然在 Framework 层的状态机中先于 GO Negotiation 执行，但它确认的 WPS 方法（PIN/PBC）要等到 GO Negotiation 完成后才被 WPS 阶段实际使用——所以从协议视角看，Provision Discovery + WPS 是 GO Negotiation 之后的连续验证环节。这就是为什么本文把它们放在一起讲：PD 是"亮出验证方式"，WPS 是"执行验证"。

## 1.1 Framework 入口：ProvisionDiscoveryState.enterImpl()

从 InactiveState 收到 CONNECT 到转入 ProvisionDiscoveryState 的路径上一章 1.2 节已经详细展开。这里直接看 ProvisionDiscoveryState 的 `enterImpl()`：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:5154
@Override
public void enterImpl() {
    logSmStateName(this.getName(),
            getCurrentState() != null ? getCurrentState().getName() : "");
    mWifiNative.p2pProvisionDiscovery(mSavedPeerConfig);
}
```

就一行有效代码——调 `mWifiNative.p2pProvisionDiscovery(mSavedPeerConfig)`。`mSavedPeerConfig` 是用户点连接时传入的 `WifiP2pConfig`，里面包含 WPS 配置方式、设备地址、GO Intent 等信息。`enterImpl()` 不等待 PD 结果——它只是把请求发出去，然后状态机等待 supplicant 回调。

## 1.2 委托链：WifiP2pNative → AIDL → supplicant

`WifiP2pNative` 是一个薄委托层——不做业务逻辑，直接把 Java 对象转发给 HAL 层。看它的实现：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pNative.java:690
public boolean p2pProvisionDiscovery(WifiP2pConfig config) {
    return mSupplicantP2pIfaceHal.provisionDiscovery(config);
}
```

`mSupplicantP2pIfaceHal.provisionDiscovery(config)` 内部先把 `config.wps.setup` 翻译成 AIDL 的 `WpsProvisionMethod` 枚举（`LABEL` 归入 `KEYPAD`），再做一次 DISPLAY↔KEYPAD 互换——本机显示 PIN 就请求对端用键盘输入，反之亦然——然后以枚举 int 通过 `ISupplicantP2pIface.provisionDiscovery()` 跨过 AIDL 边界。

枚举→字符串的翻译并不发生在 Java 侧，而是在原生服务端的 C++ stub 里：`P2pIface::provisionDiscovery()`（`wpa_supplicant/aidl/vendor/p2p_iface.cpp:413`）经 `validateAndCall` 派发到 `provisionDiscoveryInternal()`（`p2p_iface.cpp:1168`）。

在那里用 `kConfigMethodStrPbc` / `kConfigMethodStrDisplay` / `kConfigMethodStrKeypad` 把枚举映射成 supplicant 能理解的字符串参数（`"pbc"` / `"display"` / `"keypad"`），最后以 `WPAS_P2P_PD_FOR_GO_NEG` 的 use 参数调 `wpas_p2p_prov_disc()`，进入 supplicant 的 P2P 逻辑。

`WifiP2pConfig.wps.setup` 是 Android 定义的 WPS 配置方式枚举，值与 WSC 规范对齐：

| `WpsInfo.setup` 值 | 含义                      | 对应动作                             |
| ------------------ | ------------------------- | ------------------------------------ |
| `PBC (0)`          | Push Button Configuration | 双方按按钮，无需输入                 |
| `DISPLAY (1)`      | PIN Display               | 本机显示 PIN，对方输入（打印机模式） |
| `KEYPAD (2)`       | PIN Keypad                | 本机输入对方的 PIN（手机连接打印机） |
| `LABEL (3)`        | PIN from Label            | PIN 从设备标签读取                   |

`DISPLAY` 和 `KEYPAD` 是最常见的 PIN 方式：谁显示 PIN、谁输入 PIN 取决于谁当 GO。通常 GO 显示 PIN（`DISPLAY`），Client 输入 PIN（`KEYPAD`），但这取决于 WPS 的角色分配。

为什么 `WpsInfo.setup` 用 int 常量而不是独立子类（如 `PbcWpsInfo` / `KeypadWpsInfo`）？因为 `WpsInfo` 是 Android Framework 里一个需要跨进程传递的 Parcelable 值对象——它在 `writeToParcel()` 里用一行 `writeInt(setup)` 序列化，`CREATOR.createFromParcel()` 里用 `readInt()` 还原；而 `WifiP2pConfig` 持有的是 `WpsInfo` 字段（组合），不是继承。

如果每种方法做一个子类，Parcelable 反序列化就必须先读一个类型标记再按类分派，AIDL 边界的 `wpsInfoToConfigMethod()` 也要为每个子类多一层 `instanceof` 分支——对只有四种取值（外加 INVALID）的枚举来说，int + 常量是最省事的扁平表示。这个设计思路和 `WifiP2pConfig` 一脉相承：能用一个 int 字段表达的就不引入类层级，让值对象在 AIDL/Parcel 边界保持扁平。

## 1.3 processMessageImpl：等回音

`ProvisionDiscoveryState.processMessageImpl()` 处理五种事件：

- `P2P_PROV_DISC_PBC_RSP_EVENT`：对方响应了 PBC——检查自己是不是也选了 PBC（`mSavedPeerConfig.wps.setup == WpsInfo.PBC`），是的话直接调 `p2pConnectWithPinDisplay()` 发起 GO Negotiation，状态转入 `GroupNegotiationState`。
- `P2P_PROV_DISC_ENTER_PIN_EVENT`：对方要求输入 PIN——检查自己是不是 `KEYPAD` 模式。如果 config 里已经带了 PIN（某些实现通过 OOB 提前获取），直接用；否则转入 `UserAuthorizingNegotiationRequestState` 弹窗让用户输入。
- `P2P_PROV_DISC_SHOW_PIN_EVENT`：对方显示了 PIN——检查自己是不是 `DISPLAY` 模式。匹配后把 PIN 存入 config，调 `p2pConnectWithPinDisplay()` 发起 GO Negotiation，并通知 UI 层显示 PIN。
- `P2P_PROV_DISC_FAILURE_EVENT`：Provision Discovery 失败——先调 `handleProvDiscFailure()`（`WifiP2pServiceImpl.java:8005`）校验失败事件是否属于当前连接的设备（事件里的设备地址必须等于 `mSavedPeerConfig.deviceAddress`，不匹配直接 `break` 静默忽略）；校验通过才调 `handleGroupCreationFailure()` 退出建组流程，统计埋点 `CLF_PROV_DISC_FAIL`。
- 其他消息：`NOT_HANDLED` 冒泡给父状态 `GroupCreatingState` 处理（超时兜底、设备丢失等）。

这些事件不是"收到就处理"——每个都要过两道闸门（`WifiP2pServiceImpl.java:5166` 的 `processMessageImpl()`）。

第一道是**设备地址匹配**：事件里的 `WifiP2pProvDiscEvent.device.deviceAddress` 必须等于 `mSavedPeerConfig.deviceAddress`，否则直接 `break` 丢弃——防止别的设备的 PD 响应干扰当前连接。

第二道是**本地 WPS 方法匹配**：事件类型必须和自己点的连接方式对得上。PBC 事件要求 `mSavedPeerConfig.wps.setup == WpsInfo.PBC`；ENTER_PIN 要求 `KEYPAD`；SHOW_PIN 要求 `DISPLAY`。方法不匹配（比如我是 KEYPAD 却收到 PBC 响应）同样是静默忽略。

用户交互在 `UserAuthorizingNegotiationRequestState`（`WifiP2pServiceImpl.java:4916`）里。`ProvisionDiscoveryState` 收到 ENTER_PIN 且 config 里没有 PIN 时，转入这个状态弹窗。它的 `enterImpl()` 里如果本地是 PBC 或 PIN 为空，就发 `notifyInvitationReceived(REQUEST_TYPE_NEGOTIATION)` 通知 UI 弹"XX 想和你连接"的对话框。用户在 UI 上的操作以三个私有消息回来：

- `PEER_CONNECTION_USER_ACCEPT`：用户同意 → 调 `p2pConnectWithPinDisplay()` 发起 GO Neg，状态转 `GroupNegotiationState`。
- `PEER_CONNECTION_USER_REJECT`：用户拒绝 → 走拒绝清理链，转 `P2pRejectWaitState`。
- `PEER_CONNECTION_USER_CONFIRM`：用户确认 PIN → 把 `wps.setup` 改成 `DISPLAY`、重选 GO Intent，再 `p2pConnect()` 转 `GroupNegotiationState`。

所以"弹窗/按钮"不是旁路——它就是决定 PIN/PBC 方法能不能走通的那一步：PD 只负责确认对端支持什么方法，用户最终确认后才真正进入 GO Negotiation。

PD 成功后的收口：`p2pConnectWithPinDisplay()` 内部调 `mWifiNative.p2pConnect(config, FORM_GROUP)`，这又回到上一篇的 1.4 节——`WifiP2pNative.p2pConnect()` → `SupplicantP2pIfaceHal.connect()` → AIDL → supplicant，启动 GO Negotiation。

但 PD 阶段在 supplicant 侧实际做了什么？AIDL 调用怎么落到 P2P 帧交换？这是下一节的内容。

---

# 2 Supplicant 怎么交换 Provision Discovery 帧？

上一节追完了 Framework 到 supplicant 的委托链，这一节进入 supplicant 内部看 PD 帧的构建与交换。

## 2.1 入口：wpas_p2p_prov_disc()

上一节 Framework 通过 AIDL 调下来，最终落在 supplicant 的 `wpas_p2p_prov_disc()`。这是 P2P Provision Discovery 的入口，负责把 Framework 传来的 WPS 方法字符串翻译成 supplicant 内部的 `config_methods` 位掩码：

```c
// wpa_supplicant/p2p_supplicant.c:7549
int wpas_p2p_prov_disc(struct wpa_supplicant *wpa_s, const u8 *peer_addr,
                       const char *config_method,
                       enum wpas_p2p_prov_disc_use use,
                       struct p2ps_provision *p2ps_prov)
{
    u16 config_methods;

    // ...省略 P2PS ASP 分支...

    if (os_strncmp(config_method, "display", 7) == 0)
        config_methods = WPS_CONFIG_DISPLAY;
    else if (os_strncmp(config_method, "keypad", 6) == 0)
        config_methods = WPS_CONFIG_KEYPAD;
    else if (os_strncmp(config_method, "pbc", 3) == 0 ||
         os_strncmp(config_method, "pushbutton", 10) == 0)
        config_methods = WPS_CONFIG_PUSHBUTTON;
    else {
        wpa_printf(MSG_DEBUG, "P2P: Unknown config method");
        return -1;
    }

    if (use == WPAS_P2P_PD_AUTO) {
        // ...省略 PD_AUTO 分支（自动 PD + join scan）...
    }

    return p2p_prov_disc_req(wpa_s->global->p2p, peer_addr, p2ps_prov,
                             config_methods, use == WPAS_P2P_PD_FOR_JOIN,
                             0, 1);
}
```

三层逻辑：

**字符串翻译**。Framework 传来的 `"display"` / `"keypad"` / `"pbc"` / `"pushbutton"` 被映射为 `WPS_CONFIG_DISPLAY`（0x0008）、`WPS_CONFIG_KEYPAD`（0x0100）、`WPS_CONFIG_PUSHBUTTON`（0x0080）。这些是 WPS Config Methods 位掩码——表示"我支持哪些验证方式"，用于 WPS IE 中告知对端。

**use 参数路由**。`WPAS_P2P_PD_FOR_GO_NEG`（值 0）：GO Negotiation 前的 PD——这是最常见的路径。`WPAS_P2P_PD_FOR_JOIN`（值 1）：加入已有组的 PD——如果之前协商了 Persistent Group，PD 确认后直接加入。`WPAS_P2P_PD_AUTO`（值 2）：自动 PD——supplicant 自动发起 Find + Join Scan 后自己调 PD，不需要 Framework 再触发。

**委托 p2p_prov_disc_req()**。`use == WPAS_P2P_PD_FOR_JOIN` 决定了 `join` 参数——在 P2P 核心层标记 `P2P_DEV_PD_FOR_JOIN` 标志，影响后续 PD 响应的处理路径。

## 2.2 p2p_prov_disc_req()：构建并发送 PD Request 帧

`wpas_p2p_prov_disc()` 末尾调 `p2p_prov_disc_req()`，进入 P2P 核心层的帧构建与发送：

```c
// src/p2p/p2p_pd.c:2115
int p2p_prov_disc_req(struct p2p_data *p2p, const u8 *peer_addr,
                      struct p2ps_provision *p2ps_prov,
                      u16 config_methods, int join, int force_freq,
                      int user_initiated_pd)
{
    struct p2p_device *dev;

    dev = p2p_get_device(p2p, peer_addr);
    if (dev == NULL)
        dev = p2p_get_device_interface(p2p, peer_addr);
    if (dev == NULL || (dev->flags & P2P_DEV_PROBE_REQ_ONLY)) {
        // ...对端设备未发现，返回 -1...
    }

    dev->req_config_methods = config_methods;

    // 状态检查：只有 IDLE/SEARCH/LISTEN_ONLY 状态才能发 PD
    if (p2p->state != P2P_IDLE && p2p->state != P2P_SEARCH &&
        p2p->state != P2P_LISTEN_ONLY) {
        p2p_dbg(p2p, "Busy with other operations; postpone Provision Discovery Request");
        return 0;
    }

    // 设置重试次数（用户主动发起时最多 120 次）
    p2p->user_initiated_pd = user_initiated_pd;
    if (p2p->user_initiated_pd)
        p2p->pd_retries = MAX_PROV_DISC_REQ_RETRIES;

    dev->dialog_token++;  // 每次 PD 交换递增，用于匹配 Request/Response
    if (dev->dialog_token == 0)
        dev->dialog_token = 1;

    return p2p_send_prov_disc_req(p2p, dev, join, force_freq);
}
```

关键设计点：

**设备查找的双重尝试**。先按 MAC 地址精确找（`p2p_get_device`），找不到再按接口地址找（`p2p_get_device_interface`）——因为有些设备被发现时用的是 P2P Device Address，但 PD 阶段可能用 P2P Interface Address。如果设备只在 Probe Request 中发现过（`P2P_DEV_PROBE_REQ_ONLY`），说明还没有完整的设备信息，PD 请求无法发送。

**状态机门控**。只有 IDLE、SEARCH、LISTEN_ONLY 三个状态下才能发送 PD 请求。如果 P2P 核心正忙于 GO Negotiation 或其他操作，PD 请求被"延期"——不是缓存后重试，而是直接返回成功（返回 0 不是错误），等后续流程再次触发。

注意这里返回值语义是"postpone"而非"success"：`p2p_prov_disc_req()` 回答的是"这次交换现在是否发起"，不是"PD 是否成功"——真正的成败要等对端 PD Response 帧回来才知道（`p2p_process_prov_disc_resp()`，见 2.3 节）。busy 时返回 0（稍后再试，不报错），设备未发现时返回 -1（这次 PD 做不了，真错误），两者性质不同。

这个异步模型也解释了 1.1 节 `ProvisionDiscoveryState.enterImpl()` 为什么只发请求、不等待结果：`enterImpl()` 把 `p2pProvisionDiscovery()` 丢给 supplicant 就返回，`processMessageImpl()` 里等的是 `P2P_PROV_DISC_*_EVENT` 回调（见 1.3 节）。PD 的结果从来不在发送函数里，而在对端回应之后的回调链里——这是 P2P 协议栈一以贯之的"请求-回调"范式。

**dialog_token 递增**。每次与同一 peer 的 PD 交换分配一个递增的 token，用于匹配 PD Request 和 PD Response——防止重传导致的老帧被误认为新帧。

**120 次重试**。`MAX_PROV_DISC_REQ_RETRIES = 120`，仅在用户主动发起时启用。120 次不是因为丢包率高，而是因为对端可能在 Listen 和 Scan 之间切换——每 100ms 左右切一次，需要反复尝试直到双方同时处于可通信状态。

## 2.3 PD Response 的回调链

对端收到 PD Request 后，解析出 `config_methods`，匹配自己的能力——如果双方有共同支持的方法（比如都支持 PBC），对端回应 PD Response 帧。

发起方收到 PD Response 后，解析在 `p2p_process_prov_disc_resp()`（`src/p2p/p2p_pd.c:1723`）。这里的判定不是"选一个共同方法"，而是**精确回显**：对端必须把 `wps_config_methods` 原样返回——`msg->wps_config_methods != req_config_methods` 时直接判为 "Peer rejected our Provision Discovery Request"，走 `prov_disc_fail(P2P_PROV_DISC_REJECTED)` 上报失败。

也就是说 PD 层**不协商方法**：我请求 PIN 你只有 PBC，PD 不会自动降级到 PBC，而是当场失败。真正的方法冲突要等到 GO Negotiation 阶段，由 `p2p_go_neg.c:1024` 检查 Device Password ID 与本地 `wps_method` 是否一致，不一致才回 `P2P_SC_FAIL_INCOMPATIBLE_PROV_METHOD`（见 7.2 节）。

回显匹配后，`p2p_process_prov_disc_resp()` 才根据 `req_config_methods` 分派角色：

- `WPS_CONFIG_DISPLAY` → 置 `P2P_DEV_PD_PEER_DISPLAY`（对端显示 PIN，我输入）、`passwd_id = DEV_PW_REGISTRAR_SPECIFIED`。
- `WPS_CONFIG_KEYPAD` → 置 `P2P_DEV_PD_PEER_KEYPAD`（我显示 PIN，对端输入）、`passwd_id = DEV_PW_USER_SPECIFIED`。
- `WPS_CONFIG_P2PS` → 置 `P2P_DEV_PD_PEER_P2PS`。

这个 `passwd_id` 随后进入 WPS IE 的 Device Password ID 字段，决定 M1 里宣告的 PIN 方向。

这里有一个容易被忽略的因果：Device Password ID 不只出现在 WPS 阶段——GO Negotiation Request 帧在构建时就已经把它写进自己的 WPS IE（`p2p_build_go_neg_req()` 里 `pw_id = p2p_wps_method_pw_id(peer->wps_method)` 后调 `p2p_build_wps_ie()`，`src/p2p/p2p_go_neg.c:216`）。

这就是为什么 PD 必须先行于 GO Neg 的协议层原因：方法不先在 PD 阶段定下来，GO Neg 的第一帧就写不出正确的 Device Password ID，对端在 `p2p_go_neg.c:1024` 的再校验也就无从谈起。

响应状态非 `P2P_SC_SUCCESS` 时（如 `P2P_SC_FAIL_INFO_CURRENTLY_UNAVAILABLE`）也走 `prov_disc_fail` 对应分支。

最后把协商结果存进 `dev->wps_prov_info`，并调 `p2p->cfg->prov_disc_resp` 回调——对应 supplicant 的 `wpas_prov_disc_resp()`（`wpa_supplicant/p2p_supplicant.c:2935`），负责生成 `P2P_PROV_DISC_SHOW_PIN` / `ENTER_PIN` / `PBC_RESP` 事件回传 Framework，衔接 1.3 节的状态机。

对端发送 Response 后走回调 `p2p_prov_disc_resp_cb()`：

```c
// src/p2p/p2p.c:3584
static void p2p_prov_disc_resp_cb(struct p2p_data *p2p, int success)
{
    p2p_dbg(p2p, "Provision Discovery Response TX callback: success=%d",
            success);

    if (p2p->send_action_in_progress) {
        p2p->send_action_in_progress = 0;
        p2p->cfg->send_action_done(p2p->cfg->cb_ctx);
    }

    p2p->pending_action_state = P2P_NO_PENDING_ACTION;

    if (!success) {
        if (p2p->state == P2P_SEARCH)
            p2p_continue_find(p2p);
        return;
    }

    if (!p2p->cfg->prov_disc_resp_cb ||
        p2p->cfg->prov_disc_resp_cb(p2p->cfg->cb_ctx) < 1) {
        if (p2p->state == P2P_SEARCH)
            p2p_continue_find(p2p);
        return;
    }

    p2p_dbg(p2p,
            "Post-Provision Discovery operations started - do not try to continue other P2P operations");
}
```

这个回调连接了两个世界：P2P 核心层（`src/p2p/`）和 wpa_supplicant 层（`wpa_supplicant/`）。`p2p->cfg->prov_disc_resp_cb` 是一个函数指针，在 P2P 初始化时被设为 `wpas_prov_disc_resp_cb()`（`wpa_supplicant/p2p_supplicant.c:4819`）。

`wpas_prov_disc_resp_cb()` 根据 PD Request 中协商出的 WPS 方法和角色，决定 WPS 的启动方式。核心入口是 `wpas_start_wps_go()`（`wpa_supplicant/p2p_supplicant.c:2056`）和 `wpas_start_wps_enrollee()`（`wpa_supplicant/p2p_supplicant.c:1738`）：

- GO 侧：`wpas_start_wps_go()` 创建 AP 接口、配置 WPS 参数，hostapd 在 AP 接口上启动 WPS Registrar。PIN 模式下 hostapd 调 `wps_registrar_add_pin()`，PBC 模式下调 `wps_registrar_button_pushed()`。
- Client 侧：`wpas_start_wps_enrollee()` 内部根据 WPS 方法分叉——PBC 走 `wpas_wps_start_pbc()`（`wpa_supplicant/wps_supplicant.c:1164`），PIN 走 `wpas_wps_start_pin()`（`wpa_supplicant/wps_supplicant.c:1338`）。

这两个入口启动后，supplicant 内部的 WPS 状态机启动，进入下一节的 EAP-WSC 消息交换。

把 §2 的整条交换链收成一张时序图：Framework 发请求 → supplicant 翻译方法位掩码 → P2P 核心构建帧 → 对端原样回显后回 PD Response → 回调链把 `P2P_PROV_DISC_*_EVENT` 送回 Framework。对端必须原样回显 WPS 方法，`dialog_token` 把响应精确匹配回请求——你说 PIN 我说 PIN，暗号才成立。

![Provision Discovery 帧交换时序](assets/11e-P2P%EF%BC%88%E4%BA%94%EF%BC%89Provision-Discovery-WPS-%E2%80%94%E2%80%94%E7%9B%B8%E4%BA%B2%E8%A7%92%E9%87%8C%E5%AF%B9%E6%9A%97%E5%8F%B7/11e-pd-exchange.svg)

---

# 3 WPS 配网怎么做——验证官与被验证方？

Provision Discovery 确认了双方都同意用 PIN 或 PBC，下一步就是用 WPS 协议实际交换配网凭据。P2P 场景下的 WPS 跟在传统 AP-STA 场景下的 WPS 本质上是一回事——都是通过 EAP-WSC 协议安全传输 SSID 和密码——但角色分配不同。

在传统 AP-STA 场景中，AP 是 Registrar（验证官），STA 是 Enrollee（被验证方）。P2P 场景下，GO 就是 Registrar，Client 就是 Enrollee。GO Negotiation 已经决定了谁当 GO，所以 WPS 角色也就自然分配好了。

为什么 P2P 选 WPS 而不是直接给两台设备配同一个 WPA2-PSK？因为 WPA2-PSK 的安全性建立在"双方事先共享同一个 passphrase"上——可 P2P 的两台设备是临时相遇的陌生人，没有运营商预配置的共享口令。这个 passphrase 恰恰是 P2P 场景里最需要安全分发的东西：开篇导读讲过 GO Negotiation 结束时 `p2p_go_complete()` 打包的结果里就有 passphrase（GO 侧生成的），可 Client 怎么安全拿到它？WPS 就是这条通道。

M4/M8 的 Encrypted Settings 里加密传输的不只是 PSK，还有 SSID、安全类型、Auth/Encr Type 等整套配网凭据（`wps_build_cred()`，`src/wps/wps_registrar.c:1618`）。所以 P2P 的完整链路是：GO Negotiation 定 SSID/passphrase → WPS 把凭据从 GO 安全搬到 Client → 之后双方用这个 passphrase 做标准的 WPA2 四次握手。在这里 WPS 不是"配网便利"功能，而是 P2P 在无预共享秘密的前提下建立信任链的必要一环。

## 3.1 从 WPS 方法到 Device Password ID

WPS 协议不直接用 `WPS_CONFIG_DISPLAY` 这种位掩码来表示当前的验证方式。它用 `Device Password ID`——一个 16 位整数，告诉对方"我当前使用哪种凭证"：

```c
// src/p2p/p2p_go_neg.c:100
u16 p2p_wps_method_pw_id(enum p2p_wps_method wps_method)
{
    switch (wps_method) {
    case WPS_PIN_DISPLAY:
        return DEV_PW_REGISTRAR_SPECIFIED;   // 0x0005 — Registrar 指定 PIN
    case WPS_PIN_KEYPAD:
        return DEV_PW_USER_SPECIFIED;        // 0x0001 — 用户输入 PIN
    case WPS_PBC:
        return DEV_PW_PUSHBUTTON;            // 0x0004 — 按按钮
    case WPS_NFC:
        return DEV_PW_NFC_CONNECTION_HANDOVER; // NFC 连接切换
    case WPS_P2PS:
        return DEV_PW_P2PS_DEFAULT;          // P2PS 默认
    default:
        return DEV_PW_DEFAULT;               // 0x0000
    }
}
```

这里的映射值得展开。`DEV_PW_PUSHBUTTON` 的值是 0x0004，而 `DEV_PW_USER_SPECIFIED` 是 0x0001——两者是不同的 Device Password ID。PBC 模式下 WPS IE 中不携带 PIN 相关字段，而是在 Config Methods 中标记 `WPS_CONFIG_PUSHBUTTON`；PIN Keypad 场景则由用户输入的 PIN 参与后续密钥派生。

PIN 的两种情况映射不同：`WPS_PIN_DISPLAY`（本机显示 PIN）→ `DEV_PW_REGISTRAR_SPECIFIED`（0x0005），意味着 PIN 由 Registrar 生成并显示；`WPS_PIN_KEYPAD`（本机输入 PIN）→ `DEV_PW_USER_SPECIFIED`（0x0001），意味着 PIN 由用户输入。这对应 PIN 的两种模式——GO 显示 PIN、Client 输入 PIN（最常见），或者反过来。

## 3.2 GO = Registrar：启动验证

GO Negotiation 确定了谁当 GO。`p2p_go_complete()` 的末尾设置了 `p2p_set_state(p2p, P2P_PROVISIONING)`。在这个状态下，supplicant 根据 PD 阶段协商的 WPS 方法和 GO 角色启动 WPS：

如果是 PIN 模式，GO 通过 `wpas_start_wps_go()`（`wpa_supplicant/p2p_supplicant.c:2056`）启动 GO 模式——创建 AP 接口、配置 WPS 参数。hostapd 进程在 AP 接口上运行 WPS Registrar，内部调用 `wps_registrar_add_pin()`：

```
wpas_start_wps_go()
  → hostapd 在 AP 接口上启动 WPS Registrar
    → wps_registrar_add_pin()          // PIN 模式：注册 PIN 到 Registrar
    → wps_registrar_button_pushed()    // PBC 模式：启动 120s Walk Time
```

`wps_registrar_add_pin()`（`src/wps/wps_registrar.c:785`）把 PIN 注册到 Registrar 的内部状态中，关联到这个 Enrollee 的 MAC 地址。只有 MAC 匹配的 Enrollee 发来的 WPS 消息才被接受——防止隔壁的骗子偷听 PIN。

PIN 的显示方式本身就是安全设计。在 Android 上，GO 侧收到 `P2P_PROV_DISC_SHOW_PIN_EVENT` 后把 8 位 PIN 存进 `mSavedPeerConfig.wps.pin`，调 `p2pConnectWithPinDisplay()` 发起 GO Neg，同时 `notifyInvitationSent(pin, deviceAddress)` 把 PIN 交给 UI 层以大字显示在屏幕上（见 1.3 节）。PIN 在空口上从不出现——WPS IE 里只有 Device Password ID，没有 PIN 本身——它只在屏幕上短暂停留、靠人眼读给对端。

这个"大字、短暂"的呈现本身就是一种物理安全：大字让合法用户一眼读对、缩短 PIN 停留在空气中的时间；短暂意味着 PIN 的暴露窗口被压缩到一次人工交接，整个 provisioning 流程还有第 4 章的 15 秒窗口兜底。即便攻击者偷看到屏幕上的 PIN，上一段提到的 MAC 绑定（`wps_registrar_add_pin()` 只接受关联 Enrollee 的 M1）也让他没法用这个 PIN 完成配网——带外信道、时间窗口、设备绑定三重限制叠在一起，PIN 被看到不等于配网被攻破。

如果是 PBC 模式，同样走 `wpas_start_wps_go()` 建 AP 接口，hostapd 启动 WPS Registrar 后调 `wps_registrar_button_pushed()`：

`wps_registrar_button_pushed()`（`src/wps/wps_registrar.c:1045`）把 Registrar 置为"按钮已按下"状态，启动一个 120 秒的 Walk Time 窗口——WSC 规范中的正式名称就是 Walk Time，在这段时间内 Registrar 接受任何 Enrollee 的连接，不需要 PIN。

这个"接受任何 Enrollee"是有意为之的物理信任假设：PBC 假定"此刻按按钮的人就是站在设备旁边的那个人"。所以 PBC 的安全边界全压在"防止别人也按下按钮"上——代码在两层做了检查。

第一层在 `wps_registrar_button_pushed()` 入口（`src/wps/wps_registrar.c:1048`）：启动窗口前先调 `wps_registrar_pbc_overlap()`（`src/wps/wps_registrar.c:428`）数一遍 Walk Time 内活跃的 PBC session，若已有别的 Enrollee 在按，直接返回 -2、PBC 模式根本不开。

第二层在 Enrollee 的 M1 到达时（`wps_process_m1()`，`src/wps/wps_registrar.c:2644`）：如果检测到两个不同 UUID-E 的 Enrollee 都想用 PBC（`force_pbc_overlap` 或新 session 与已有 session 不匹配），Registrar 回 M2D 并置 `config_error = WPS_CFG_MULTIPLE_PBC_DETECTED`（=12，`src/wps/wps_defs.h:222`）。

Enrollee 侧 `wps_process_m2d()`（`src/wps/wps_enrollee.c:1040`）收到 M2D 后触发 `WPS_EV_M2D` 事件、把状态切到 `RECEIVED_M2D`，并不会直接回 NACK；当 M2D 携带 `config_error = WPS_CFG_MULTIPLE_PBC_DETECTED` 时，wpa_supplicant 的 M2D 事件处理（`wpa_supplicant_wps_event_m2d()`）注册 `wpas_p2p_pbc_overlap_cb()` 超时回调，最终整个流程落到 `wpas_p2p_group_formation_failed()`（见 4.2 节）。这对应相亲角里击掌确认的脆弱性：你正跟 A 击掌，B 突然也把手伸过来——你分辨不出哪个击掌是真的，只能统统不认。PBC 把"两个同时按按钮"当成错误拒绝，而不是当成"两个都要连"来逐个处理。

到这里 PIN 和 PBC 的架构权衡就清楚了：两者把"安全"押在完全不同的锚点上。**PIN 的安全锚是带外共享秘密**——8 位码从不在空口出现，E-Hash/R-Hash 让 Registrar 能密码学地验证"对方真的知道这个 PIN"；代价是用户体验（要读屏/输码）和它自身的弱熵（10^7，安全下限靠失败计数与临时锁定兜底，见 3.3 节的 Viehböck 攻击）。**PBC 的安全锚是物理在场**——按下按钮的瞬间默认"此刻站在设备旁的人就是要配对的人"，零输入、零记忆负担；代价是没有密码学身份可验，只能靠 overlap 检测（`WPS_CFG_MULTIPLE_PBC_DETECTED`）把"两个同时按"当错误拒绝。所以 Provision Discovery 阶段的方法协商不是二选一的偏好，而是安全模型的取舍：要可验证的身份就选 PIN，要极致便捷就选 PBC。

为什么 Walk Time 是 120 秒？因为用户可能需要从一个房间走到另一个房间去按按钮。PBC 的 120 秒不是超时——它是"窗口期"。过了 120 秒没人来，按钮状态自动取消。

注意这里的 120 秒和第 4 章的 15 秒是两把不同的尺子。Walk Time 是 WPS Registrar 层的"按钮按下后多久内接受 Enrollee"——它管的是**开始**；15 秒是 P2P 层的"WPS 配网整个流程多久必须完成"——它管的是**结束**。PBC 必须在 120 秒窗口内启动 WPS，但一旦启动，配网必须在 15 秒内跑完。所以一个 PBC 配网能被观察到的最长过程是"按下按钮 → 立即开始 WPS → 15 秒超时"；如果用户在第 100 秒才按下按钮，留给 WPS 的仍然只有 15 秒，而不是把两个窗口相加。

## 3.3 EAP-WSC：八轮消息交换

WPS Registrar 启动后，Enrollee 发起连接。WPS 的核心是 EAP-WSC（EAP over WSC），通过八轮消息完成配网凭据的安全交换。这不是把 PIN 或密码明文发送——而是通过 DH（Diffie-Hellman）密钥交换建立共享密钥，然后用这个密钥加密传输 SSID 和密码。

```
Enrollee (Client) → Registrar (GO)
  M1 →  Version / E-Nonce / MAC / UUID-E / DH 公钥 / 设备信息
  M2 ←  Version / R-Nonce / UUID-R / DH 公钥 / Authenticator
  M3 →  Version / R-Nonce / E-Hash（证明知道 PIN）/ Authenticator
  M4 ←  Version / R-Hash + R-SNonce1 / Encrypted Settings（AP 配置）
  M5 →  Version / E-SNonce1 / Encrypted Settings
  M6 ←  Version / R-SNonce2 / Encrypted Settings
  M7 →  Version / E-SNonce2 / Encrypted Settings（AP 配置）
  M8 ←  Version / Encrypted Settings（SSID + 密码凭据）
```

**M1（Enrollee 到 Registrar）**：Enrollee 报家门 + 亮公钥——WPS 版本、Enrollee Nonce（E-Nonce）、MAC 地址、UUID-E、DH 公钥、支持的加密算法（Auth/Encr Type Flags）、设备信息（制造商、型号、设备名）、Device Password ID。这一步是"自报身份 + 亮出公钥"，还没有密码学保护——公钥本身不是秘密，DH 私钥不发送。

**M2（Registrar 到 Enrollee）**：Registrar 回复自己的 DH 公钥和 Registrar Nonce（R-Nonce），并附上能力信息（UUID-R、Config Methods、设备属性）。到这一步双方都有了对方的公钥——各自的私钥乘以对方公钥得到相同的共享密钥，`wps_derive_keys()` 里：DHKey = SHA-256(g^AB mod p)，再由 KDK 派生 AuthKey / KeyWrapKey，供后续消息做完整性校验和加密。

**M3（Enrollee 到 Registrar）**：Enrollee 发送 E-Hash（E-Hash1/E-Hash2）来证明自己知道 PIN——E-Hash1 = HMAC_AuthKey(E-SNonce1 || PSK1 || PK_E || PK_R)，E-Hash2 用 E-SNonce2 || PSK2，其中 PSK1/PSK2 由 PIN 前半/后半经 `wps_derive_psk()` 派生。注意这一步**不再发公钥**——Enrollee 的公钥在 M1 已经交换过了。

**M4（Registrar 到 Enrollee）**：Registrar 用 KeyWrapKey 加密配置数据（SSID、安全类型等）放进 Encrypted Settings，同时发送 R-Hash（R-Hash1/R-Hash2，证明 Registrar 也知道同一个 PIN）和 R-SNonce1。这些数据被加密后 Enrollee 才能读。

**M5-M8**：确认与最终化。M5 发 Enrollee 的 E-SNonce1 + 加密设置，M6 发 Registrar 的 R-SNonce2 + 加密设置，M7 发 Enrollee 的 E-SNonce2 + AP 配置，M8 发 Registrar 的最终凭据（SSID + 密码，`wps_build_cred()`）。

为什么是八轮而不是四轮？把八轮按功能切成四段就看清楚了：**M1/M2 建 DH 信道，M3/M4 双向 PIN 承诺，M5-M7 揭示与核对，M8 交付凭据**。

M1/M2 必须两轮，因为 DH 需要双方各贡献一份公钥：M1 发 Enrollee 的 PK_E，M2 发 Registrar 的 PK_R，只有两份公钥都到齐，双方才能在 M2 交换中各自调 `wps_derive_keys()`（`src/wps/wps_common.c:62`，Enrollee 在处理 M2 时、Registrar 在构建 M2 时）算出同一个 DHKey → AuthKey/KeyWrapKey——没有这两轮，后续所有哈希和加密都没有密钥可用。

M3/M4 是 PIN 承诺：双方各自把"我知道 PIN"编进一个带密钥的哈希（E-Hash/R-Hash），但此刻不把哈希里用的秘密随机数（SNonce）发出去。这是 commit-reveal（先承诺、后揭示）模式：M3 只发 E-Hash1/2，E-SNonce1/2 要等到 M5/M7 才在 Encrypted Settings 里揭示；Registrar 在 `wps_process_e_snonce1()`（`src/wps/wps_registrar.c:2285`）里拿到 SNonce 才能重算哈希、与 `wps_process_m3()` 暂存的 `peer_hash1` 比对。

为什么哈希和随机数要拆开？因为 PIN 是弱秘密——E-Hash 是一份只对本次 DH 会话有效的承诺（哈希里混入了 PK_E/PK_R 和 AuthKey），把 SNonce 押后到 KeyWrapKey 加密的 Encrypted Settings 里揭示，承诺就只能在握有 AuthKey 的合法对端手中被打开；被动监听者即使截获 M3 的 E-Hash，也没有 AuthKey 能重算哈希来离线穷举 PIN。

M5-M7 的揭示节奏也由 PIN 的两段式结构决定：8 位 PIN 拆成两半（PSK1/PSK2），每半一个哈希、一个 SNonce，所以 Enrollee 要分两次揭示 E-SNonce1（M5）和 E-SNonce2（M7），Registrar 也在 M4/M6 各揭示一半 R-SNonce——四条消息把四个 SNonce 交替送出。M8 必须是最后一轮：凭据是整场交换的奖品，只有前七轮全部验证通过，Registrar 才用 `wps_build_cred()`（`src/wps/wps_registrar.c:1618`）把 SSID + 密码加密交出。

PIN 模式和 PBC 模式在"凭证校验"上有差异。PIN 模式下，8 位 PIN 被分成两半：前半 4 位经 HMAC-AuthKey 派生 PSK1，后半 4 位派生 PSK2（`wps_derive_psk()`）。E-Hash（M3）和 R-Hash（M4）把 PSK1/PSK2 和双方的 Secret Nonce（E-SNonce1/2、R-SNonce1/2）混入 HMAC——攻击者不知道完整 PIN 就构造不出合法的 Hash，过不了 Authenticator 校验。

但要澄清一点：DH 共享密钥本身的派生只依赖双方公私钥对，与 PIN 无关——PIN 保护的是"对方真的知道这个 PIN"的身份校验，不是密钥交换本身。为什么 WPS 要在这个位置补一道 PIN 校验？因为 DH 只解决保密性、不解决身份——一个中间人可以分别和 Enrollee、Registrar 各完成一次 DH，把两端的加密信道都握在手里，但唯独拿不到 PIN。

PIN 是一条带外共享秘密：它不出现在空口上（WPS IE 里只有 Device Password ID 表明"用哪种密码"），靠屏幕显示/键盘输入在人的视线和手指间传递。E-Hash/R-Hash 把"是否知道 PIN"编进 HMAC（`wps_build_e_hash()`，`src/wps/wps_enrollee.c:35`）。

注意校验的时机：`wps_process_m3()`（`src/wps/wps_registrar.c:2778`）只是把 E-Hash1/E-Hash2 暂存进 `peer_hash1/2`，真正的重算比对要等 Enrollee 在 M5/M7 里把 E-SNonce1/2 送回来——`wps_process_e_snonce1/2()`（`src/wps/wps_registrar.c:2285/2325`）拿到 SNonce 后重算 HMAC、与暂存值比对，一致才继续，失败回 WSC_NACK。这个"先暂存哈希、后揭示随机数"的节奏正是 3.3 节前面 commit-reveal 设计的代码落点。

所以 DH + 派生密钥 + E-Hash 三者分工明确：DH 建加密信道，PIN 定身份——中间人把 M1-M8 全部嗅探下来也提取不出 PIN，更构造不出合法 E-Hash，在 M3 就被掐断。

8 位 PIN 的末位其实是校验位（`wps_pin_checksum()`，`src/wps/wps_common.c:212`），真正有效的空间是 10^7 而不是 10^8。

更糟的是，两个半段被拆开独立校验——`wps_process_e_hash1()` / `wps_process_e_hash2()`（`src/wps/wps_registrar.c:2257/2271`）把两半哈希分别暂存，真正的核对要等 M5/M7 的 E-SNonce 到达后才由 `wps_process_e_snonce1/2()`（`src/wps/wps_registrar.c:2285/2325`）重算比对，攻击者可以先猜前 4 位（10^4 次），从 Registrar 收到 M5 后是继续推进还是回 WSC_NACK 判断前半是否正确，再猜后 4 位（末位校验位再扣一个自由度，剩 10^3），总共约 1.1 万次在线尝试就能穷举完——这正是 2011 年公开的 WPS PIN 暴力破解（Viehböck 攻击）的原理。所以 PIN 模式的安全下限完全依赖 Registrar 侧的失败计数与临时锁定，而不是协议本身。

PBC 模式则不需要 PIN——双方都"按按钮"意味着信任对方，跳过 PIN 相关的 Hash 校验，DH 密钥直接用公钥派生，不混入 PIN。

八轮消息在代码里是交替的两个状态机。

**Enrollee 侧**（`src/wps/wps_enrollee.c`）只管"发奇数、收偶数"。发送方向由 `wps_enrollee_get_msg()`（:452）按当前状态切构建函数——`SEND_M1 → wps_build_m1()`（:104）、`SEND_M3 → wps_build_m3()`（:170）、`SEND_M5 → wps_build_m5()`（:208）、`SEND_M7 → wps_build_m7()`（:377），每构建完一个 M 发出去，状态就切到下一个 `SEND_M*`。

接收方向则由 `wps_enrollee_process_msg()`（:1486）按 `op_code` 分派，`WSC_MSG` 交给 `wps_process_wsc_msg()`（:1277）按 `Message Type` 分派到 `wps_process_m2()`（:959）、`wps_process_m4()`（:1095）、`wps_process_m6()`（:1150）、`wps_process_m8()`（:1207），处理完再切回下一个 `SEND_M*` 继续构建。

**Registrar 侧**（`src/wps/wps_registrar.c`）节奏正好相反——"收奇数、发偶数"：`wps_registrar_process_msg()`（:3386）→ `wps_process_wsc_msg()`（:3029）处理奇数 M：`wps_process_m1()`（:2644）、`wps_process_m3()`（:2778）、`wps_process_m5()`（:2813）、`wps_process_m7()`（:2964）。

偶数 M 由构建函数产出：`wps_build_m2()`（:1877）、`wps_build_m4()`（:1989）、`wps_build_m6()`（:2028）、`wps_build_m8()`（:2064）。

两条链咬合起来就是 3.3 节开头那张交替图：Enrollee 发 M1 → Registrar `RECV_M1` → 回 M2 → Enrollee `RECV_M2` → 发 M3 →……直到 M8 收完，Registrar 端 `wps_build_m8()` 里 `wps_build_cred()`（:1618）把 SSID + 密码放进 Encrypted Settings，Enrollee 解出凭据后发 `WSC_Done`。

---

# 4 暗号窗口什么时候关门？15 秒超时机制

八轮消息交换不是无限期的——从 GO Neg 结束、WPS 启动那一刻起，暗号窗口就进入了倒计时。这个关门时限是怎么定的？

## 4.1 超时时间如何设定

GO Negotiation 阶段就已经为 WPS 设好了倒计时。在 GO Neg 三次握手的 P2P Attributes 中，有一个 `Configuration Timeout` attribute——双方在谈判时交换各自能接受的超时值。这个值被写入 P2P 核心层 `struct p2p_data` 的 `go_timeout` / `client_timeout` 两个字段（默认值在 `p2p_init()` 中设定，之后每次 GO Neg 前会被 `p2p_set_config_timeout()` 重设）：

- `go_timeout`：GO 侧的配置超时，默认 100（单位：10ms，即 1 秒）。GO 需要做更多事——启动 WPS Registrar、分配 Group Key、准备 Beacon 中的 WPS IE——所以时间更长。
- `client_timeout`：Client 侧的配置超时，默认 20（单位：10ms，即 0.2 秒）。Client 只需要连接和 WPS 交互，所以时间短。

但实际观察到的 WPS 窗口往往不是 1 秒和 0.2 秒。`Configuration Timeout` attribute 在 GO Neg 阶段被协商并存入 peer 数据结构（`dev->go_timeout` / `dev->client_timeout`），而真正决定 WPS 窗口的是 `wpas_go_neg_completed()` 里注册的 eloop 定时器：`15 + res->peer_config_timeout / 100` 秒——基值 **15 秒** 硬编码在那里（`wpa_supplicant/p2p_supplicant.c:2549`）。

这个 15 秒由 `wpas_p2p_group_formation_timeout()` 控制——一个 eloop 定时器，在 WPS 流程启动时（GO Neg 完成后）注册。

## 4.2 超时触发的清理链

WPS 在 15 秒内没完成，timer 到期，走这条链路：

```c
// wpa_supplicant/p2p_supplicant.c:2395
static void wpas_p2p_group_formation_timeout(void *eloop_ctx,
                                             void *timeout_ctx)
{
    struct wpa_supplicant *wpa_s = eloop_ctx;
    wpa_printf(MSG_DEBUG, "P2P: Group Formation timed out");
    wpas_p2p_group_formation_failed(wpa_s, 0);
}
```

第一步，取消自己的超时定时器（防重入），调 `p2p_group_formation_failed()`。第二步，调 `wpas_group_formation_completed(wpa_s, 0, already_deleted)`，`success=0` 表示失败：

```c
// wpa_supplicant/p2p_supplicant.c:2404
static void wpas_p2p_group_formation_failed(struct wpa_supplicant *wpa_s,
                                            int already_deleted)
{
    eloop_cancel_timeout(wpas_p2p_group_formation_timeout,
                         wpa_s->p2pdev, NULL);
    if (wpa_s->global->p2p)
        p2p_group_formation_failed(wpa_s->global->p2p);
    wpas_group_formation_completed(wpa_s, 0, already_deleted);
}
```

`wpas_group_formation_completed()` 的失败路径做三件事：

- 清 `p2p_in_provisioning` 标记
- 上报 `P2P_EVENT_GROUP_FORMATION_FAILURE` 事件（通过 wpa_msg 机制传到 Framework）
- 调 `wpas_p2p_group_delete()` 删除为建组创建的 Group 接口

`p2p_group_formation_failed()` 在 P2P 核心层做最后的清理：

```c
// src/p2p/p2p.c:2971
void p2p_group_formation_failed(struct p2p_data *p2p)
{
    if (p2p->go_neg_peer == NULL) {
        return; // No pending Group Formation
    }

    p2p_dbg(p2p, "Group Formation failed with " MACSTR,
            MAC2STR(p2p->go_neg_peer->intended_addr));

    p2p_clear_go_neg(p2p);
}
```

`p2p_clear_go_neg()` 清掉 `go_neg_peer` 指针、清超时定时器、把状态机切回 `P2P_IDLE`。回到 Framework 侧，`P2P_EVENT_GROUP_FORMATION_FAILURE` 事件到达后，Framework 转入 `GroupRemovalState` 做 Group 接口的清理，最终回到 `InactiveState`。

## 4.3 成功路径

如果 WPS 在 15 秒内成功完成，`wpas_p2p_wps_success()` 被调用：

```c
// wpa_supplicant/p2p_supplicant.c:7444
void wpas_p2p_wps_success(struct wpa_supplicant *wpa_s, const u8 *peer_addr,
                          int registrar)
{
    struct wpa_ssid *ssid = wpa_s->current_ssid;

    if (!wpa_s->p2p_in_provisioning) {
        return; // 不是 provisioning 状态，忽略
    }

    // 取消超时定时器
    eloop_cancel_timeout(wpas_p2p_group_formation_timeout, wpa_s->p2pdev, NULL);

    // 标记 provisioning 完成
    wpa_s->p2p_go_group_formation_completed = 1;

    // Client 场景：重新注册初始连接超时
    if (ssid && ssid->mode == WPAS_MODE_INFRA) {
        eloop_register_timeout(P2P_MAX_INITIAL_CONN_WAIT, 0,
                               wpas_p2p_group_formation_timeout,
                               wpa_s->p2pdev, NULL);
        wpa_s->p2p_go_group_formation_completed = 0;
    }

    // 通知 P2P 核心层
    if (wpa_s->global->p2p)
        p2p_wps_success_cb(wpa_s->global->p2p, peer_addr);

    // 上报成功事件
    wpas_group_formation_completed(wpa_s, 1, 0);
}
```

关键在这里：WPS 成功后不是直接结束——还有 Group Formation。对于 Client 角色（`WPAS_MODE_INFRA`），WPS 成功只是拿到了 SSID 和密码，接下来还需要 Auth → Assoc → 四次握手 → DHCP 才能真正通数据。所以代码里重新注册了一个超时定时器（`P2P_MAX_INITIAL_CONN_WAIT`），把"Group Formation 完成"推迟到四次握手成功之后。

`p2p_wps_success_cb()` 在 P2P 核心层验证 MAC 地址匹配后调 `p2p_clear_go_neg()`，清理 GO Negotiation 状态。

---

# 5 WPS IE 这个"信封"里装了什么东西？

WPS 交换的不只是 PIN——配网凭据、设备身份、验证方式全都要装进一个信封里在空口上传递。这个信封就是 WPS IE。

## 5.1 什么是 WPS IE

WPS 的所有配置信息——版本、支持的加密方法、Device Password ID、Config Methods、UUID——都装在一个叫 WPS IE 的数据结构中。IE 的全称是 Information Element，是 802.11 管理帧里的标准数据容器。WPS IE 是一个 Vendor-Specific IE（元素 ID = 221），OUI 是 WFA（Wi-Fi Alliance，`00:50:F2:04`），子元素以 TLV（Type-Length-Value）格式嵌套。

WPS IE 被"嵌入"在 P2P IE 里——P2P Action 帧（Provision Discovery Request/Response）中同时包含 P2P IE 和 WPS IE，它们是同级的 vendor extension。Group Formation 阶段的 Beacon、Probe Response、Association Request/Response 中也携带 WPS IE——这是 WSC 规范的要求，确保配网信息在链路的每个阶段都可用。

## 5.2 p2p_build_wps_ie()：构建 WPS IE

P2P 核心层构建 WPS IE 的入口是 `p2p_build_wps_ie()`：

```c
// src/p2p/p2p_build.c:860
int p2p_build_wps_ie(struct p2p_data *p2p, struct wpabuf *buf, int pw_id,
                     int all_attr)
{
    u8 *len;
    int i;

    // Vendor-Specific IE 头
    wpabuf_put_u8(buf, WLAN_EID_VENDOR_SPECIFIC);  // Element ID = 221
    len = wpabuf_put(buf, 1);
    wpabuf_put_be32(buf, WPS_DEV_OUI_WFA);           // OUI = 00:50:F2:04

    // 必选：Version
    if (wps_build_version(buf) < 0)
        return -1;

    // all_attr = true：完整 IE（含 WPS State、UUID、设备信息等）
    if (all_attr) {
        // WPS State: Not Configured
        wpabuf_put_be16(buf, ATTR_WPS_STATE);
        wpabuf_put_be16(buf, 1);
        wpabuf_put_u8(buf, WPS_STATE_NOT_CONFIGURED);
    }

    // Device Password ID（PD 阶段的关键字段）
    if (pw_id >= 0) {
        wpabuf_put_be16(buf, ATTR_DEV_PASSWORD_ID);
        wpabuf_put_be16(buf, 2);
        wpabuf_put_be16(buf, pw_id);
    }

    // all_attr 含完整设备身份
    if (all_attr) {
        // Response Type: Enrollee Info
        // UUID-E, Manufacturer, Model Name, Model Number, Serial Number
        // Primary Device Type, Device Name, Config Methods
        // ...省略设备信息构建——完整属性清单见 5.3 节速查表...
    }

    // 厂商扩展（含真实 WPS 版本号）
    if (wps_build_wfa_ext(buf, 0, NULL, 0, 0) < 0)
        return -1;

    // 追加自定义 Vendor Extensions
    for (i = 0; i < P2P_MAX_WPS_VENDOR_EXT; i++) {
        // ...省略 vendor extension 追加...
    }

    p2p_buf_update_ie_hdr(buf, len);  // 回填 IE 长度
    return 0;
}
```

这个函数展示了 WPS IE 的分层结构。最外层是 802.11 Vendor-Specific IE 的标准格式（Element ID + Length + OUI）。内部是 WPS TLV 属性序列——每个属性由 2 字节 Type + 2 字节 Length + Variable Value 组成。

`all_attr` 参数控制是否填充完整设备描述。Probe Response 帧中 `all_attr = true`，带完整设备身份（UUID-E、制造商、型号、设备名、Config Methods 等）——Beacon/Probe Response 要让对端识别自己。

GO Negotiation 帧中 `all_attr = false`，只带 Version + Device Password ID——设备详细信息在 Device Discovery 阶段已经交换过了。至于 PD Request/Response 帧，走的是更精简的 `p2p_build_wps_ie_config_methods()`（见 5.4 节），只带 Config Methods。

## 5.3 WPS 关键属性速查

| WPS Attribute                    | 含义                              | 出现场景                 |
| -------------------------------- | --------------------------------- | ------------------------ |
| `ATTR_VERSION` (0x104A)          | WPS 版本（硬编码 0x10，向后兼容） | 所有 WPS IE              |
| `ATTR_WPS_STATE` (0x1044)        | WPS 配置状态（已配置/未配置）     | 完整 WPS IE (all_attr=1) |
| `ATTR_DEV_PASSWORD_ID` (0x1012)  | 设备密码类型（PIN/PBC/NFC）       | PD Request/Response      |
| `ATTR_CONFIG_METHODS` (0x1008)   | 支持的配置方法位掩码              | PD Request, GO Neg       |
| `ATTR_RESPONSE_TYPE` (0x103B)    | 响应类型（Enrollee/Registrar）    | 完整 WPS IE              |
| `ATTR_VENDOR_EXT` (0x1049)       | 厂商扩展（含 Version2）           | 所有 WPS IE              |
| `ATTR_UUID_E` (0x1047)           | Enrollee 的 UUID                  | 完整 WPS IE              |
| `ATTR_PRIMARY_DEV_TYPE` (0x1054) | 主设备类型                        | 完整 WPS IE              |
| `ATTR_DEV_NAME` (0x1011)         | 设备名称                          | 完整 WPS IE              |

`wps_build_version()` 中硬编码版本为 0x10——WSC 1.0 的版本号。注释明确说这是为了向后兼容，真实版本协商在 `wps_build_wfa_ext()` 的 `WFA_ELEM_VERSION2` 子元素中完成（当前 `WPS_VERSION = 0x20`，即 WSC 2.0）。

## 5.4 p2p_build_wps_ie_config_methods()：PD 帧中的精简版

PD Request 帧中不需要完整的设备信息——只需要告诉对端"我支持哪些 WPS 方法"。所以 PD 阶段用的是精简版：

```c
// src/p2p/p2p_pd.c:26
static void p2p_build_wps_ie_config_methods(struct wpabuf *buf,
                                            u16 config_methods)
{
    u8 *len;
    wpabuf_put_u8(buf, WLAN_EID_VENDOR_SPECIFIC);
    len = wpabuf_put(buf, 1);
    wpabuf_put_be32(buf, WPS_DEV_OUI_WFA);

    /* Config Methods */
    wpabuf_put_be16(buf, ATTR_CONFIG_METHODS);
    wpabuf_put_be16(buf, 2);
    wpabuf_put_be16(buf, config_methods);

    p2p_buf_update_ie_hdr(buf, len);
}
```

只有 Vendor-Specific IE 头 + 一个 `ATTR_CONFIG_METHODS` 属性——告诉对端"我可以用 PIN（Display/Keypad）或 PBC"。不需要 Version、不需要 UUID、不需要设备名称——因为这些东西在 Device Discovery 阶段就已经交换过了。PD 帧的目的不是重新做自我介绍，而是确认验证方式。

---

# 6 驱动侧：帧怎么发出去

上一节拆了 WPS IE 这个"信封"本身，这一节看它怎么到达对端。P2P 的帧传输要分清两条路：**P2P Action 帧**（Provision Discovery、GO Negotiation）是管理帧，通过 nl80211 `NL80211_CMD_FRAME` 下发到驱动，驱动再通过 WMI（QCOM）或 mbox（MTK）发给固件；**WPS 的 M1-M8** 是 EAP-WSC 消息，封装在 EAPOL 数据帧里走数据路径——两者不是同一条路。

把两条路并排摆开看：左边是 PD/GO-Neg 走的管理帧链（WPS IE 这个"信封"从这里递给对端，亮出验证方式），右边是 M1-M8 走的 EAPOL 数据帧链（配网凭据从这里安全送达）——信封走小通道，凭据走大路。

![两条下行通道对比：管理帧 vs 数据帧（WPS M1-M8）](assets/11e-P2P%EF%BC%88%E4%BA%94%EF%BC%89Provision-Discovery-WPS-%E2%80%94%E2%80%94%E7%9B%B8%E4%BA%B2%E8%A7%92%E9%87%8C%E5%AF%B9%E6%9A%97%E5%8F%B7/11e-downlink-compare.svg)

## 6.1 为什么 WPS 帧会被担心太长

先说结论：M1-M8 是 EAPOL 数据帧，长度上限由 802.11 数据帧的 MSDU（2304 字节）决定，不受管理帧 / Action 帧路径的约束。

EAP-WSC 的 M1/M2 各携带一份 DH 公钥（各 192 字节，对应 1536-bit DH）。以 M1 为例（`wps_build_m1()`，`src/wps/wps_enrollee.c:104`），WPS 属性加起来约 550 字节：Version、Message Type、UUID-E、MAC、Enrollee Nonce、Public Key（含 TLV 头 196 字节）、Auth/Encr Type Flags、Config Methods、WPS State、设备属性（制造商/型号/序列号/设备名）、Device Password ID 等。

加上 EAP 头（4 字节）和 EAPOL 头（4 字节），M1 的 EAPOL 载荷约 560 字节——远低于 MSDU 上限，也没有"比 GO Neg 大几倍就危险"的问题。

如果某个 WPS 消息真的超过 1400 字节呢？EAP-WSC 在 EAP 层自带分片——`WSC_FRAGMENT_SIZE = 1400`（`src/eap_common/eap_wsc_common.h:22`），`eap_wsc_build_msg()`（`src/eap_peer/eap_wsc.c:310`）里 `2 + send_len > fragment_size` 就置 MF/LF 标志分段发送。所以 WPS 帧既不会撑爆 EAPOL 的 MSDU 上限，也不需要驱动侧为它做特殊的大帧处理——分片在 supplicant 的 EAP 层就完成了。

## 6.2 QCOM：__wlan_hdd_mgmt_tx 路径

QCOM 平台的 P2P Action 帧发送统一走 `__wlan_hdd_mgmt_tx()`（`core/hdd/src/wlan_hdd_p2p.c:272`）。这条路径承载的是 Provision Discovery Request/Response 和 GO Negotiation 帧——它们嵌着 WPS IE（Config Methods / Device Password ID），但帧本身不大：

```
__wlan_hdd_mgmt_tx()
  → wlan_cfg80211_mgmt_tx()          // os_if P2P 层（os_if/p2p/src/wlan_cfg80211_p2p.c:421）
    → ucfg_p2p_mgmt_tx()             // P2P dispatcher（components/p2p/dispatcher）
      → ...（scheduler → WMA → WMI）
        → WMI_MGMT_TX_SEND_CMDID     // 发给固件
```

QCOM 在 `ucfg_p2p_mgmt_tx()`（`components/p2p/dispatcher/src/wlan_p2p_ucfg_api.c:297`）里按 `mgmt_frm->len` 动态 `qdf_mem_malloc()` 拷贝帧体——这是为任意长度的管理帧准备的，PD/GO-Neg 这种 200-300 字节的帧绰绰有余。而 WPS M1-M8 的 EAPOL 数据帧走数据路径（`wpa_supplicant_eapol_send()`，`wpa_supplicant/wpas_glue.c:146` → control port / L2），根本不经过这条管理帧链。

## 6.3 MTK：P2P Action Frame 路径

MTK 平台的 Action 帧发送路径和 QCOM 不同——走的是 P2P 设备状态机（`p2p_dev_fsm.c`）内的帧发送接口：

```
P2P Action Frame TX
  → MSG_MGMT_TX_REQUEST              // 管理帧发送请求（消息入队）
    → p2pDevFsmRunEventMgmtTx()      // P2P 设备状态机处理（p2p_dev_fsm.c:1238）
      → p2pFuncTxMgmtFrame()         // P2P 功能层帧发送（p2p_func.c:1307）
        → mbox 消息队列              // 跨核通信
          → 固件 P2P 模块            // 固件侧帧发射
```

和 QCOM 一样，这条链只承载 P2P Action 帧（PD/GO-Neg）。`MSG_MGMT_TX_REQUEST` 携带的是 `MSDU_INFO *` 指针（`include/mgmt/hem_mbox.h:321`），帧数据不复制进固定大小的消息队列缓冲，经 mbox 传的是指针——所以 Action 帧长短都不影响。WPS M1-M8 的 EAPOL 数据帧则走数据路径，与这条管理帧链无关。两家驱动都不需要为 WPS 长帧选择不同的发送路径——因为 M1-M8 根本不走管理帧路径，而 EAP 层分片（`WSC_FRAGMENT_SIZE`，1400 字节，见 6.1 节）已经把最大帧长限制住了。

一句话记住两条路的分工：**PD/GO-Neg 走管理帧链**（Action 帧嵌 WPS IE，小、由驱动直接下发），**M1-M8 走 EAPOL 数据路径**（EAP-WSC 消息由 supplicant 的 EAP 层分片后经 control port / L2 发出，驱动侧管理帧链对它完全透明）——所以两家驱动都不需要为 WPS 长帧单独准备发送路径。

---

# 7 暗号对上（或没对上），结果怎么处理？

帧在两条通道上各走各的，最终都要回到同一个问题：这轮暗号到底对没对上。WPS 八轮消息交换完成后，结果分两条路处理：

## 7.1 暗号对上了

`wpas_p2p_wps_success()` → `p2p_wps_success_cb()` → `wpas_group_formation_completed(success=1)`。supplicant 通过 wpa_msg 上报 `P2P_EVENT_GROUP_FORMATION_SUCCESS`（`wpa_ctrl.h` 里的字符串宏），Framework 的 WifiP2pMonitor 把它转成 `P2P_GROUP_FORMATION_SUCCESS_EVENT`。

但状态机对这条事件**直接忽略**（源码注释 "We ignore these right now, since we get a GROUP_STARTED notification afterwards"）。

真正把状态机推到 `GroupCreatedState` 的是后续的 `P2P_GROUP_STARTED_EVENT`。

`wpas_group_formation_completed()` 的成功路径区分 GO 和 Client：

- **GO**：WPS 成功后还需要等 Client 完成 Auth/Assoc/四次握手/DHCP。但在 WPS success 的这一刻，ssid 的 mode 已经从 `WPAS_MODE_P2P_GROUP_FORMATION` 切到 `WPAS_MODE_P2P_GO`——"我是 GO，频道已准备好，等 Client 来连"。Framework 用 `GROUP_STARTED_EVENT` 通知上层，包含 SSID、密码、GO 的 MAC 地址。
- **Client**：标记 `show_group_started = 1`，表示等四次握手（EAPOL）完成后才通知 Framework。这是因为 Client 侧只有完成四次握手才算"真正连接上了"——拿到 IP 才能通数据。

## 7.2 暗号没对上

超时或 WPS 失败 → `wpas_p2p_group_formation_failed()` → `wpas_group_formation_completed(success=0)` → `wpas_p2p_group_delete()` 删除 Group 接口 → Framework 收到 `P2P_GROUP_FORMATION_FAILURE_EVENT` → `handleGroupCreationFailure()` → 回到 `InactiveState`。

Framework 层 `handleGroupCreationFailure()` 会根据失败原因码（`GROUP_CREATION_FAILURE_REASON_PROVISION_DISCOVERY_FAILED` 或其他）决定是否通知 UI 层显示错误提示。PD 阶段失败和 WPS 阶段失败走的是同一个 `handleGroupCreationFailure()`，但原因码不同——前者是 Provision Discovery 就失败了，后者是 WPS 配网失败了。

失败原因码的分层值得理清。**P2P 核心层的状态码**定义在 `src/common/ieee802_11_defs.h:1835` 的 `enum p2p_status_code`：

- `P2P_SC_SUCCESS=0` / `SUCCESS_DEFERRED=12`：成功或延迟成功
- `P2P_SC_FAIL_INFO_CURRENTLY_UNAVAILABLE=1`：对端暂时不可用
- `P2P_SC_FAIL_INCOMPATIBLE_PARAMS=2` / `INVALID_PARAMS=4` / `PREV_PROTOCOL_ERROR=6`：协议参数问题
- `P2P_SC_FAIL_LIMIT_REACHED=3` / `UNABLE_TO_ACCOMMODATE=5`：设备/组数量上限
- `P2P_SC_FAIL_NO_COMMON_CHANNELS=7`：无共同信道（Framework 据此进 `FrequencyConflictState`）
- `P2P_SC_FAIL_UNKNOWN_GROUP=8`：持久组凭证已被对方删除
- `P2P_SC_FAIL_BOTH_GO_INTENT_15=9`：双方 GO Intent 都是 15
- `P2P_SC_FAIL_INCOMPATIBLE_PROV_METHOD=10`：**WPS 方法不匹配**——GO Neg 再校验一次 Device Password ID 与本地 `wps_method`（见 2.3 节）
- `P2P_SC_FAIL_REJECTED_BY_USER=11`：用户拒绝连接

其中与 WPS/Provision 阶段最相关的是 `INCOMPATIBLE_PROV_METHOD`（=10）和 `REJECTED_BY_USER`（=11）。Framework 用 `P2pStatus.valueOf()`（`WifiP2pServiceImpl.java:537`）把 0-11 映射成 `P2pStatus` 枚举，`P2P_GROUP_FORMATION_FAILURE_EVENT` 里据此判断是否进入 `FrequencyConflictState` 等特殊分支。

`REJECTED_BY_USER` 的传播链值得完整走一遍：用户在 Framework 的 `UserAuthorizingNegotiationRequestState` 弹窗点"拒绝"（对应 1.3 节的 `PEER_CONNECTION_USER_REJECT`）时，Framework 调 `sendP2pRejection()`（`WifiP2pServiceImpl.java:8890`）——先 `mWifiNative.p2pReject()`。

这条链一直沉到 supplicant：AIDL → `P2pIface::reject()` → `rejectInternal()`（`wpa_supplicant/aidl/vendor/p2p_iface.cpp:453/1214`）→ `wpas_p2p_reject()` → `p2p_reject()` 在 `src/p2p/p2p.c:4326/4327` 给 peer 置上 `P2P_DEV_USER_REJECTED` 标志和 `dev->status = P2P_SC_FAIL_REJECTED_BY_USER`。

标记落位后，Framework 再重新触发一次 `p2pProvisionDiscovery()` 通知对端。

之后对端再发 GO Neg Request 过来，`p2p_process_go_neg_req()` 在 `src/p2p/p2p_go_neg.c:942` 检查到 `dev->flags & P2P_DEV_USER_REJECTED`，直接回 `REJECTED_BY_USER` 状态。

所以这个码不是"本端拒绝对端"那么简单，而是用户拒绝在 Framework → AIDL → supplicant → P2P 核心层走了一整圈、落进对端设备条目里、再在下一次 GO Neg 请求时被读出来回给对方的完整跨层结果。

**WPS 自身的失败**用的是另一套码——WSC 规范里的 Configuration Error，定义在 `src/wps/wps_defs.h:209` 的 `enum wps_config_error`：`WPS_CFG_NO_ERROR=0`、`DECRYPTION_CRC_FAILURE=2`、`SETUP_LOCKED=15`、`MSG_TIMEOUT=16`、`REG_SESS_TIMEOUT=17`、`DEV_PASSWORD_AUTH_FAILURE=18` 等。

这些错误在 M2D/M8 里通过 `Config Error` 属性带回，或触发 `wps_fail_event()`（`src/wps/wps_common.c:272`）上报 `WPS-FAIL` 事件——它们不经过 `P2P_SC_FAIL_*`，而是直接结束 WPS 状态机，最终同样落到 `wpas_p2p_group_formation_failed()`。

所以看错误码要分两层：**P2P 层状态码**（`P2P_SC_FAIL_*`，PD/GO Neg 用）和 **WPS 层 Configuration Error**（`WPS_CFG_*`，M2D/M8 里带回来）——PD 失败、GO Neg 方法冲突、WPS 配网失败，分别对应这三段。三者的错误码来源、Framework 事件与处理终点并成一张表看得更清：

| 失败阶段        | 错误码/事件来源                                              | Framework 事件                                               | 处理终点                                                     |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| PD 失败         | supplicant `P2P_EVENT_PROV_DISC_FAILURE`（`wpa_ctrl.h:286`）携带 `p2p_prov_disc_status`：`P2P_PROV_DISC_REJECTED` / `TIMEOUT` / `INFO_UNAVAILABLE`（`p2p.h:485`） | `P2P_PROV_DISC_FAILURE_EVENT`                                | `handleProvDiscFailure()` 校验 → `handleGroupCreationFailure(GROUP_CREATION_FAILURE_REASON_PROVISION_DISCOVERY_FAILED)`，埋点 `CLF_PROV_DISC_FAIL` |
| GO Neg 方法冲突 | P2P 核心层状态码 `P2P_SC_FAIL_INCOMPATIBLE_PROV_METHOD=10`（`ieee802_11_defs.h:1835`） | `P2P_GROUP_FORMATION_FAILURE_EVENT`，`P2pStatus` 映射为 `INCOMPATIBLE_PROVISIONING_METHOD` | `handleGroupCreationFailure()` 通用失败清理                  |
| WPS 配网失败    | WPS 层 `WPS_EVENT_FAIL`（`wpa_ctrl.h:168`）携带 `wps_config_error`：`WPS_CFG_SETUP_LOCKED=15` / `MSG_TIMEOUT=16` / `REG_SESS_TIMEOUT=17` / `DEV_PASSWORD_AUTH_FAILURE=18`（`wps_defs.h:209`） | 不经过 `P2P_SC_FAIL_*`，直接 `wps_fail_event()` → `wpas_p2p_group_formation_failed()` | `P2P_GROUP_FORMATION_FAILURE_EVENT` → `handleGroupCreationFailure()` |

Framework 还会收到 `WIFI_P2P_CONNECTION_CHANGED_ACTION` 广播——App 层可以通过注册这个广播监听器来感知连接状态的变化。

---

# 8 暗号对上了，然后呢？

本文从 Framework `ProvisionDiscoveryState.enterImpl()` 追到 `p2p_wps_success_cb()` / `p2p_group_formation_failed()`，横跨四个世界：

| 层级            | 关键角色                                        | 核心工作                                                 |
| --------------- | ----------------------------------------------- | -------------------------------------------------------- |
| Framework       | `ProvisionDiscoveryState`                       | 发 PD 请求、等 WPS 方法匹配、转 GO Neg                   |
| wpa_supplicant  | `wpas_p2p_prov_disc()` → `p2p_prov_disc_req()`  | PD 帧构建与交换                                          |
| wpa_supplicant  | WPS Registrar/Enrollee                          | EAP-WSC 八轮消息交换，DH 密钥派生                        |
| 驱动 (QCOM/MTK) | `__wlan_hdd_mgmt_tx()` / `p2pFuncTxMgmtFrame()` | PD/GO-Neg Action 帧下发到固件；WPS M1-M8 走 EAPOL 数据帧 |

## 8.1 全链路调用链回顾

把本文追过的路从头到尾再走一遍——从用户点"连接"到 WPS 定成败：

```
Framework：InactiveState 收到 CONNECT
  → 三层检查（权限 / config / Persistent Group）
  → ProvisionDiscoveryState.enterImpl()
    → WifiP2pNative.p2pProvisionDiscovery()
      → SupplicantP2pIfaceHal.provisionDiscovery()   // wpsInfoToConfigMethod + DISPLAY↔KEYPAD 互换
        → AIDL：ISupplicantP2pIface.provisionDiscovery()
          → P2pIface::provisionDiscovery() → provisionDiscoveryInternal()
            → wpas_p2p_prov_disc()                    // config_method 字符串 → 位掩码
              → p2p_prov_disc_req() → p2p_send_prov_disc_req()
                → PD Request 管理帧 → nl80211 NL80211_CMD_FRAME → 驱动

对端回 PD Response
  → p2p_process_prov_disc_resp()                      // 精确回显校验 + 分派角色
    → prov_disc_resp 回调 → wpas_prov_disc_resp()
      → P2P_PROV_DISC_*_EVENT 回传 Framework
        → ProvisionDiscoveryState.processMessageImpl() // 设备地址 + WPS 方法双闸门
          → p2pConnectWithPinDisplay() → GroupNegotiationState（GO 谈判）

GO 谈判完成 → p2p_go_complete() → P2P_PROVISIONING
  → wpas_start_wps_go()（GO = Registrar）/ wpas_start_wps_enrollee()（Client = Enrollee）
    → WPS Registrar：wps_registrar_add_pin() / wps_registrar_button_pushed()
    → EAP-WSC 八轮交换：M1→M8（DH 建信道 + E-Hash/R-Hash 验 PIN）
      → 成功：wpas_p2p_wps_success() → p2p_wps_success_cb()
        → wpas_group_formation_completed(success=1)
      → 15s 超时：wpas_p2p_group_formation_timeout()
        → wpas_p2p_group_formation_failed() → p2p_group_formation_failed()
          → P2P_EVENT_GROUP_FORMATION_FAILURE → Framework 回 InactiveState
```

两条路在这里收口：PD 亮出验证方式、GO Neg 定下角色、WPS 执行验证——任何一环失败都落进 `wpas_p2p_group_formation_failed()` 这个公共清理点；成功则带着 GO 侧打包的 SSID/passphrase 走向 Group Formation 的 Auth/Assoc/四次握手/DHCP。

暗号对上了，群建好了——但只是"WPS 层面的群"。真正的 Group Formation 还没开始。下一篇，Client 要完成 Auth（认证）→ Assoc（关联）→ 四次握手（EAPOL 4-Way Handshake）→ DHCP 分配 IP。GO 要在自己创建好的 AP 模式下接受 Client 的连接请求、完成四次握手、分配 IP 地址——就像给新来的人发门禁卡。相亲角的比喻到这里：身份验证通过了，接下来是真正搬进去住。

下一篇：Group Formation——Auth/Assoc/四次握手/DHCP/IP。暗号对上了，门开了，现在要发钥匙。

---

**源码仓库**：

- AOSP wpa_supplicant 8: [https://w1.fi/wpa_supplicant/](https://w1.fi/wpa_supplicant/)
- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- QCOM qcacld-3.0: [https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0](https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0)
- MTK kernel_modules-connectivity-wlan-core-gen4m (MTK 内核模块仓库)

**相关规范**：

- Wi-Fi Alliance, "Wi-Fi Direct Specification v2.0"
- Wi-Fi Alliance, "Wi-Fi Simple Configuration Technical Specification v2.0.2"
