---
title: P2P（四）GO Negotiation ——相亲角里谈条件，谁当老大
top: 1
related_posts: true
abbrlink: 8ef6a16b
date: 2026-09-24 22:29:27
tags:
  - Android WiFi
  - P2P
categories:
  - WiFi
  - Code
---

> 看中了一个人，现在要约出来谈谁当老大。本文追踪从 Framework connect 到 GO 角色确定的完整链路：GroupCreatingState 挂起等待牌、`p2p_go_det()` 的意愿值对比算法、三次握手帧的 8 个 P2P Attribute 构建、十级信道选择的优先级链，以及 Autonomous GO 怎么绕过谈判直接建组。

---

# 本章导读

相亲角里逛了一圈，名单上的人看中了（上一篇的结尾，peer 列表已广播）。现在的问题是：怎么约出来谈？

这就是 GO Negotiation——P2P 协议里最有"人味"的环节。不是冷冰冰的扫描和关联，而是两个设备坐下来谈判：谁当老大？在哪见面？规矩怎么定？

<!--more-->

谈判有三轮。第一轮你出价（GO Neg Request），第二轮对方应价（GO Neg Response），第三轮你确认成交（GO Neg Confirm）。八张"条件清单"（P2P Attributes）在每轮中交换——你能当什么角色（Capability）、你多想当老大（GO Intent）、你能接受在哪些频道见面（Channel List）、你准备用哪个接口地址（Intended P2P Interface Address）。核心决策在两个函数里完成：`p2p_go_det()` 比谁意愿值高，`p2p_reselect_channel()` 比谁的频道方案更好——一个十级的优先级链条从"我的首选频率"一路兜底到"随便哪个都行"。

还有一个特殊情况：有的人根本不谈判。一挥手说"我建个群，谁来都行"——这就是 Autonomous GO，`p2p_group_add()` 直接跳过了谈判，自己宣布当老大。

本文从 Framework 的 `connect()`（用户点"连接"）到 GO 角色确定、信道选好，收口在 `p2p_go_complete()` 触发 `P2P_GO_NEGOTIATION_SUCCESS_EVENT`。不涉及 Provision Discovery + WPS（下一篇）、Group Formation 里的 Auth/Assoc/四次握手/DHCP（下下篇）。

先看这张全链路分层图，理解 connect 的指令要从 App 一路穿过几层、跨过哪些进程边界（Binder / AIDL / nl80211），进入 supplicant 完成三次握手、用 `p2p_go_det()` 定下 GO/Client 角色，Action 帧最终经内核落到驱动。图中蓝色箭头是主调用链下行方向，橙色虚线框是三次握手，金色节点是角色确定：

![P2P GO Negotiation 全链路分层架构](assets/11d-P2P%EF%BC%88%E5%9B%9B%EF%BC%89GO-Negotiation-%E2%80%94%E2%80%94%E7%9B%B8%E4%BA%B2%E8%A7%92%E9%87%8C%E8%B0%88%E6%9D%A1%E4%BB%B6%EF%BC%8C%E8%B0%81%E5%BD%93%E8%80%81%E5%A4%A7/11d-overview.svg)

---

# 1 Framework：点"连接"后，管理处怎么接单？

相亲角的管理处（P2pStateMachine）平时停在 InactiveState——没人来办事就闲着。用户点"连接"某个设备，消息怎么从 App 层一路到达管理处的谈判窗口？

这条链路和我们上一篇 discoverPeers 用的是同一套通信机制，但走的是不同的消息类型和不同的状态分支。discoverPeers 发给 InactiveState 不处理、冒泡给父状态处理——而 connect 恰好在 InactiveState 里有自己的 case。

## 1.1 App 层：WifiP2pManager.connect

App 开发者调 `connect`，传入三个参数：Channel（通信管道）、WifiP2pConfig（对方信息和你的条件）、ActionListener（成功/失败回调）。

```java
// packages/modules/Wifi/framework/java/android/net/wifi/p2p/WifiP2pManager.java:2432
public void connect(Channel channel, WifiP2pConfig config, ActionListener listener) {
    checkChannel(channel);
    checkP2pConfig(config);
    Bundle extras = prepareExtrasBundle(channel);
    extras.putParcelable(EXTRA_PARAM_KEY_CONFIG, config);
    channel.mAsyncChannel.sendMessage(prepareMessage(CONNECT, 0,
            channel.putListener(listener), extras, channel.mContext));
}
```

`WifiP2pConfig` 是这张"谈判邀约"的内容载体。我们拆开看看里面装了什么：

```java
// packages/modules/Wifi/framework/java/android/net/wifi/p2p/WifiP2pConfig.java
public String deviceAddress = "";          // L64:  对方的 P2P MAC 地址——约谁谈
public WpsInfo wps;                        // L69:  WPS 配置方式（PBC/Display/Keypad）
public int groupOwnerIntent =              // L174: 你多想当老大？0=不想，15=非要当
        GROUP_OWNER_INTENT_AUTO;           //       AUTO = -1，Framework 自动解析为 6
public String networkName = "";            // L78:  @hide，给 Persistent Group 用的网络名
public String passphrase = "";             // L87:  @hide，给 Persistent Group 用的密码
public int groupOwnerBand =                // L104: @hide，你偏好哪个频段建组
        GROUP_OWNER_BAND_AUTO;             //       0=AUTO, 1=2.4G, 2=5G, 3=6G
```

`groupOwnerIntent` 的 `AUTO(-1)` 不会直接下发——Framework 在下发前调 `selectGroupOwnerIntentIfNecessary()` 解析为默认值 6（`WifiP2pServiceImpl.java:8660`，`DEFAULT_GROUP_OWNER_INTENT = 6` at L217）。app 也可以显式设 0-15 的值，AIDL 接口会做范围校验——超出 0-15 直接拒绝。

为什么 API 暴露的是 0-15 的整数刻度而不是一个 `boolean isGO`？因为 P2P 的谈判不是"要不要当老大"的二值问题，而是"有多想当老大"的比较问题——两个设备都声明"我要当 GO"（二值）时没有任何协议能裁决，只有把意愿量化成梯度，`p2p_go_det()` 才能做"谁高谁当、相等靠 Tie Breaker"的比较（§4）。Android 选择把协议原生的 4-bit 字段原样透出，既不完全交给 supplicant 决定（那会隐藏意愿粒度），也不强行替用户拍板（那只需一个布尔）。`AUTO(-1)` 默认解析为 6——一个偏中间的值："我不特别想当，但也不排斥"，这样两台 AUTO 设备同时连接时 Tie Breaker 能公平决胜。

WpsInfo 指定了 Provisioning 的方式：PBC（按按钮，`setup=0`）、Display（显示 PIN，`setup=1`）、Keypad（输入 PIN，`setup=2`）。这决定了后续 Provision Discovery 和 WPS 阶段的具体交互方式——下一篇会展开。从 GO Negotiation 的角度，WPS 方法主要影响 GO Neg Request 中的 WPS IE 里携带的 Device Password ID。

## 1.2 状态机路由：InactiveState 收到 CONNECT

`CONNECT` 消息到达 P2pStateMachine 的 InactiveState。和 discoverPeers 不一样——discoverPeers 在 InactiveState 里没有 case，冒泡给父状态；CONNECT 在这里有自己的处理逻辑。

InactiveState 收到 CONNECT 后做三层检查：

- 权限检查：`NEARBY_WIFI_DEVICES` + `ACCESS_FINE_LOCATION` 权限（App 侧已检查，但状态机再确认一次）
- config 合法性：如果 config 可被解析为"直接加入已有组"的格式（有 networkName + passphrase），走 `p2pGroupAdd(config, true)` 进入快速连接通道
- Persistent Group 检查：如果 config 的 deviceAddress 对应一个已保存的 Persistent Group，尝试 `reinvokePersistentGroup`

大部分首次连接场景走第三条分支失败（没有 Persistent Group），接下来也不是直接进 GroupNegotiationState——而是先进 **ProvisionDiscoveryState**。这是 P2P 协议的要求：谈判之前先确认 Provisioning 方式双方都认可。ProvisionDiscoveryState 是 GroupCreatingState 的另一个子状态，下一篇会详细展开。

所以 InactiveState 的 CONNECT 处理并不直接触发谈判——三层检查通过后，先把状态机转入 **ProvisionDiscoveryState** 确认 Provisioning 方式。PD 交换成功（对方响应了 PBC/PIN）后才在 ProvisionDiscoveryState 里调 `p2pConnectWithPinDisplay()` → `mWifiNative.p2pConnect(config, FORM_GROUP)`，随后状态机转入 GroupNegotiationState。`FORM_GROUP=false` 表示"我要建组，不是加入已有组"——这个 AIDL 调用之所以落在 PD 之后，是因为 P2P 协议要求谈判前先确认双方都认可对方的 Provisioning 方式。

## 1.3 GroupCreatingState 与 GroupNegotiationState

GroupCreatingState 是 GroupNegotiationState 的父状态——两者不是同一个状态，而是父子关系。GroupCreatingState 的 `enterImpl()` 做通用初始化：设 CONNECTING 标志、启 `GROUP_CREATING_TIMED_OUT` 超时定时器。GroupNegotiationState 是它的子状态，专门处理"正在谈判"阶段的事件。

为什么 connect 不直接从 GroupNegotiationState 调 AIDL？因为 GroupNegotiationState 是个**被动等待**的子状态——谈判请求在转入它之前已经发出去了，它只负责等结果。真正调 `mWifiNative.p2pConnect()` 的时机在**转入它的那条边**上：PD 完成后（ProvisionDiscoveryState）或收到对方 GO Neg Request 且用户授权后（UserAuthorizingNegotiationRequestState）。这背后是 GroupCreatingState 的设计意图：**把"建组生命周期"和"具体协议阶段"分开**——GroupCreatingState 下挂了 7 个子状态，分别对应建组的不同阶段：

- ProvisionDiscoveryState —— 确认 Provisioning 方式
- GroupNegotiationState —— 谈判
- FrequencyConflictState —— 频率冲突协调
- UserAuthorizingNegotiationRequestState —— 用户授权
- UserAuthorizingInviteRequestState —— 邀请授权
- P2pRejectWaitState —— 等待拒绝
- L3ConnectingState —— L3 连接

子状态只处理自己阶段的消息，处理不了的消息**冒泡到父状态**统一处理：`GROUP_CREATING_TIMED_OUT` 超时兜底、`P2P_DEVICE_LOST_EVENT` 记录连接期间丢失的 peer、谈判期间拒绝新的 Discover/Listen（`DISCOVER_PEERS`/`START_LISTEN` 在 GroupCreatingState 一律回 `BUSY`）。这些是任何建组子阶段都通用的规则——提升到父状态，7 个子状态就不用各自重复实现。消息路由因此形成"子状态只认自己的协议事件、父状态包揽通用规则"的分工。

GroupNegotiationState（`WifiP2pServiceImpl.java:5279`）的核心逻辑是等待结果。它不主动做任何事——谈判已经发出去了，现在就是等回音：

- `P2P_GO_NEGOTIATION_SUCCESS_EVENT` → 忽略（这不是最终事件，只是中间状态）
- `P2P_GROUP_STARTED_EVENT` → 这才是真正的"谈成了"。根据角色分两条路：
  - 自己是 GO：设置 group idle timeout，发 tethering 请求广播，等 `TETHER_INTERFACE_STATE_CHANGED` → GroupCreatedState
  - 自己是 Client：调 `startIpClient()` → GroupCreatedState
- `P2P_GO_NEGOTIATION_FAILURE_EVENT` / `P2P_GROUP_REMOVED_EVENT` → `handleGroupCreationFailure` → 退回 InactiveState

## 1.4 传话人：WifiP2pNative → SupplicantP2pIfaceHal

`WifiP2pNative.p2pConnect()` 是把 Framework 的 Java 对象翻译成 HAL 调用的委托层：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pNative.java:662
public String p2pConnect(WifiP2pConfig config, boolean joinExistingGroup) {
    return mSupplicantP2pIfaceHal.connect(config, joinExistingGroup);
}
```

`SupplicantP2pIfaceHalAidlImpl.connect()`（`SupplicantP2pIfaceHalAidlImpl.java:828`）做最后一层 Java 侧验证：MAC 地址格式、WPS 方法合法性、`groupOwnerIntent` 在 0-15 范围内。然后根据 supplicant 服务版本走两条 AIDL 路径：

- 服务版本 >= 3：调 `mISupplicantP2pIface.connectWithParams(P2pConnectInfo)` —— 新接口，传一个结构体
- 旧版本：调 `mISupplicantP2pIface.connect(peerAddress, provisionMethod, preSelectedPin, joinExistingGroup, persistent, goIntent)` —— 旧接口，参数平铺

`P2pConnectInfo` 结构体（定义在 `ISupplicantP2pIface.aidl` 的 `P2pConnectInfo.aidl`）打包了所有参数：`peerAddress`、`provisionMethod`、`preSelectedPin`、`joinExistingGroup`、`persistent`、`goIntent`（0-15）、`vendorData`、`pairingBootstrappingMethod`、`password`、`frequencyMHz`。

AIDL 调用跨进程进入 supplicant daemon 后，先落在 C++ 侧的 AIDL stub（`P2pIface`，`wpa_supplicant/aidl/vendor/p2p_iface.cpp`）上。`P2pIface::connect()`（`p2p_iface.cpp:393`）和 `P2pIface::connectWithParams()`（`:819`）本身只是 `validateAndCall` 的薄封装——校验 iface 有效后，把参数分派给内部的 `connectInternal()`（`:1103`）和 `connectWithParamsInternal()`（`:1975`）。

这两个 Internal 函数才是真正的转换层：`go_intent > 15` 直接回 `FAILURE_ARGS_INVALID`（Java 侧已拦过一次，C 侧再兜底）、`peer_address` 长度必须是 6 字节、把 AIDL 的 `WpsProvisionMethod` 枚举翻译成 supplicant 的 `p2p_wps_method`（PBC → `WPS_PBC`、DISPLAY → `WPS_PIN_DISPLAY`、KEYPAD → `WPS_PIN_KEYPAD`），最后才调 `wpas_p2p_connect()`。Framework 侧的传话工作到此结束——谈判的主动权交到了 supplicant 手里。

`createGroup`（Autonomous GO）在 Framework 侧的路径和 connect 不同。它发送的是 `CREATE_GROUP` 消息而非 `CONNECT`，InactiveState 处理时设 `mAutonomousGroup = true`，然后走 `p2pGroupAdd()` 而非 `p2pConnect()`。后续在 §6.3 会展开两者的完整对比。

---

# 2 Supplicant 接单后做了什么？wpas_p2p_connect 的参数存储与前期准备

Framework 把谈判邀约传过来了。supplicant 的 `wpas_p2p_connect()` 是 C 侧的入口——它在接单后要做一系列准备工作，才能正式开始谈判。

## 2.1 wpas_p2p_connect 入口

```c
// wpa_supplicant/p2p_supplicant.c:6136
int wpas_p2p_connect(struct wpa_supplicant *wpa_s, const u8 *peer_addr,
                     const char *pin, enum p2p_wps_method wps_method,
                     int persistent_group, int auto_join, int join, int auth,
                     int go_intent, int freq, unsigned int vht_center_freq2,
                     int persistent_id, int pd, int ht40, int vht,
                     unsigned int vht_chwidth, int he, int edmg,
                     const u8 *group_ssid, size_t group_ssid_len,
                     bool allow_6ghz, bool p2p2, u16 bootstrap,
                     const char *password)
```

参数列表很长，但核心的就几个：`peer_addr`（对方 MAC）、`wps_method`（PBC/PIN/Keypad）、`go_intent`（0-15，你的意愿值）、`freq`（你偏好的频率）。其余参数控制高级特性——HT40/VHT/HE/EDMG 带宽选项、6GHz 支持、Persistent Group 复用等。

函数内部做三件事：

**存储参数到 wpa_s 上下文中**。go_intent、wps_method、freq、persistent_group 等全部存到 `wpa_s->p2p_*` 字段，供后续异步流程读取——因为 AIDL 调用返回后，真正的谈判在 eloop 定时器回调中异步启动。

**处理 PIN**。如果 wps_method 是 `WPS_PIN_DISPLAY`（我方显示 PIN 给对方输入），supplicant 自动生成一个 8 位随机 PIN 存到 `wpa_s->p2p_pin`。如果用户传了 pin 参数（比如从 UI 输入），则直接用。PBC 方式则 PIN 为空。

**准备 P2P Group Interface**。如果 `create_p2p_iface` 配置为 true（Android 默认开启），调 `wpas_p2p_add_group_interface()` 预先创建一个 P2P Group 类型的虚拟接口——GO Intent=15 时创建 `WPA_IF_P2P_GO` 类型，否则创建 `WPA_IF_P2P_GROUP`。这个接口是后续建组时实际承载数据面的接口，管理面仍然用 p2p0。

最后，调 `wpas_p2p_start_go_neg()` 进入实际的谈判流程。

频率准备其实发生在 `wpas_p2p_connect()` 内部、调用 `wpas_p2p_start_go_neg()` 之前：`wpas_p2p_setup_freqs()` 接收 `wpas_p2p_connect()` 的 `freq` 参数（连接路径下 AIDL 不携带频率，值为 0 即自动选择），结合驱动上报的 best channel 与 PCL 解析出具体频率列表，再调 `p2p_set_own_pref_freq_list()` 设置首选频率列表。

注意 groupOwnerBand 这个 Framework 侧字段不会传到 supplicant——它只在 createGroup（Autonomous GO）路径经 `WifiP2pNative.p2pGroupAdd` 映射为频段码（2/5/6）传入。随后 `wpas_p2p_start_go_neg()` 调 `p2p_connect()`——真正的 P2P 核心模块入口。

## 2.2 p2p_connect：准备谈判桌

```c
// src/p2p/p2p.c:1605
int p2p_connect(struct p2p_data *p2p, const u8 *peer_addr,
                enum p2p_wps_method wps_method,
                int go_intent, const u8 *own_interface_addr,
                unsigned int force_freq, int persistent_group,
                const u8 *force_ssid, size_t force_ssid_len,
                int pd_before_go_neg, unsigned int pref_freq, u16 oob_pw_id,
                bool p2p2, u16 bootstrap, const char *password)
```

这是进入核心 P2P 模块的入口。相亲角的隐喻在这里对应得特别贴切：

1. **查登记簿**：`p2p_get_device(p2p, peer_addr)` 从上一篇 Device Discovery 阶段建立的设备链表里找出对方——你在名单上看中的人，必须在登记簿里有记录
2. **选场地**：`p2p_prepare_channel(p2p, dev, force_freq, pref_freq, go_intent == 15)` 初步选定工作信道——相当于"我们先定一个见面的频段"
3. **准备筹码**：分配 `dialog_token`（会话 ID，每次自增，从 1 开始循环）和 `tie_breaker`（决胜硬币——取自 `p2p->next_tie_breaker`，然后翻转以备下次使用）。这两样东西在整个谈判过程中不变——即使 GO Neg Request 重传也复用同一套值
4. **清标记**：清掉上次谈判遗留的 `WAIT_GO_NEG_RESPONSE`、`WAIT_GO_NEG_CONFIRM` 等等待标记，重置 `connect_reqs` 和 `go_neg_req_sent` 计数器
5. **设状态**：`dev->go_state = UNKNOWN_GO`——谈判开始前，谁当老大还不知道
6. **停 Find**：如果当前正在 Discover（Find 循环还在跑），调 `p2p_stop_find()` 停掉——不能一边找人一边跟人谈条件

那查不到怎么办？`p2p_connect()` 在 `p2p.c:1623` 对 `p2p_get_device()` 的返回值做了判空：`dev == NULL` 或对方只被 Probe Request 扫到过（`P2P_DEV_PROBE_REQ_ONLY` 标志，没有完整设备信息）时，直接打印 `"Cannot connect to unknown P2P Device"` 并 `return -1` 失败退出——名单上查无此人，谈判桌根本不摆。这和扫描阶段的"被动登记"是互补的：设备发现靠广播，而 connect 要求对方至少有一次完整的信息交换。

如果 scan 还在跑（`p2p->p2p_scan_running`），不能立刻发 GO Neg Request——记录 `p2p->start_after_scan = P2P_AFTER_SCAN_CONNECT`，等 scan 完成后在回调里自动发。否则直接调 `p2p_connect_send()` 发第一轮 Request。

---

# 3 三次握手怎么谈条件？GO Neg Request/Response/Confirm 的帧结构与状态流转

谈判桌摆好了。现在进入本章的核心——三次握手，每一轮对应一个 Action 帧的构建、发送和处理。从 `p2p_connect_send` 开始。

把三轮交锋画成一张时序图——Request 出价、Response 应价、Confirm 成交，每一轮谁在哪个函数里做什么、状态标记怎么流转，一眼看全：

![P2P GO Negotiation 三次握手时序图（GO Neg Request/Response/Confirm 泳道 + 8 Attributes + tie_breaker 翻转）](assets/11d-P2P%EF%BC%88%E5%9B%9B%EF%BC%89GO-Negotiation-%E2%80%94%E2%80%94%E7%9B%B8%E4%BA%B2%E8%A7%92%E9%87%8C%E8%B0%88%E6%9D%A1%E4%BB%B6%EF%BC%8C%E8%B0%81%E5%BD%93%E8%80%81%E5%A4%A7/11d-go-negotiation.svg)

## 3.1 第一次握手：GO Neg Request ——"这是我的条件"

### 3.1.1 p2p_connect_send：发出要约

从 discovery 阶段拿到的 peer device 记录中，`listen_freq` 告诉我们在哪个信道上对方在 Listen——那是我们发 Request 的目标频率。如果对方设置了 OOB GO Neg 频率（NFC 等带外方式协商好的），优先用那个。

```c
// src/p2p/p2p_go_neg.c:240
int p2p_connect_send(struct p2p_data *p2p, struct p2p_device *dev)
{
    // PD-before-GO-Neg 兼容性变通：某些老设备先走 Provision Discovery 再谈判
    if (dev->flags & P2P_DEV_PD_BEFORE_GO_NEG) {
        // ... 发 Provision Discovery Request 而非 GO Neg Request ...
        return p2p_prov_disc_req(p2p, dev->info.p2p_device_addr,
                                 NULL, config_method, 0, 0, 1);
    }

    freq = dev->listen_freq > 0 ? dev->listen_freq : dev->oper_freq;
    if (dev->oob_go_neg_freq > 0)
        freq = dev->oob_go_neg_freq;

    req = p2p_build_go_neg_req(p2p, dev);  // 组建 8 个 P2P Attributes
    p2p_set_state(p2p, P2P_CONNECT);
    p2p->pending_action_state = P2P_PENDING_GO_NEG_REQUEST;
    p2p->go_neg_peer = dev;
    dev->flags |= P2P_DEV_WAIT_GO_NEG_RESPONSE;  // 挂起：等对方回复
    dev->connect_reqs++;

    if (p2p_send_action(p2p, freq, dev->info.p2p_device_addr,
                        p2p->cfg->dev_addr, dev->info.p2p_device_addr,
                        wpabuf_head(req), wpabuf_len(req), 500) < 0) {
        // 发送失败 → 回退到 P2P Find 重试
        p2p_set_timeout(p2p, 0, 0);
    } else
        dev->go_neg_req_sent++;

    wpabuf_free(req);
    return 0;
}
```

关键细节：

- `P2P_DEV_WAIT_GO_NEG_RESPONSE` 标记——挂起等待对方回复。这个标记在 `p2p_process_go_neg_resp` 收到回复时会被检查并清除
- `p2p_send_action` 的最后一个参数 `500`——ACK 等待超时 500ms。Action 帧是单播管理帧，需要对方回 ACK 确认送达
- 发送失败不立即重试——`p2p_set_timeout(p2p, 0, 0)` 设置超时为 0，让 P2P 状态机回退到 Find 循环，通过重新发现 peer 来触发新的 connect 尝试

`P2P_DEV_PD_BEFORE_GO_NEG` 是一个兼容性标记——部分老设备的 P2P 实现要求先完成 Provision Discovery 再进入 GO Negotiation。如果这个标记被设置（由用户配置或自动检测），`p2p_connect_send` 不发 GO Neg Request，改发 Provision Discovery Request。这不是标准流程，但保证了互操作性。

### 3.1.2 p2p_build_go_neg_req：八张条件清单

这是谈判的核心——你把自己的条件打包成一张"名片"，发给对方。每张条件在协议中称为一个 P2P Attribute（P2P IE 的子元素），TLV 编码（Type-Length-Value）。GO Neg Request 携带 8 个 P2P Attributes：

```c
// src/p2p/p2p_go_neg.c:138
struct wpabuf * p2p_build_go_neg_req(struct p2p_data *p2p,
                                     struct p2p_device *peer)
{
    // ... 分配 buf 和 subelems ...

    p2p_buf_add_public_action_hdr(buf, P2P_GO_NEG_REQ, peer->dialog_token);

    // Attribute 1: Capability —— 我能当什么角色
    p2p_buf_add_capability(subelems, p2p->dev_capab &
                           ~P2P_DEV_CAPAB_CLIENT_DISCOVERABILITY, group_capab);

    // Attribute 2: GO Intent —— 我多想当老大（意愿值 + Tie Breaker）
    p2p_buf_add_go_intent(subelems,
                          (p2p->go_intent << 1) | peer->tie_breaker);

    // Attribute 3: Configuration Timeout —— 谈成后你有多久时间加入
    p2p_buf_add_config_timeout(subelems, p2p->go_timeout, p2p->client_timeout);

    // Attribute 4: Listen Channel —— 我现在在哪个信道等你
    p2p_buf_add_listen_channel(subelems, p2p->cfg->country,
                               p2p->cfg->reg_class, p2p->cfg->channel);

    // Attribute 5: Intended P2P Interface Address —— 建组后我用哪个接口地址
    p2p_buf_add_intended_addr(subelems, p2p->intended_addr);

    // Attribute 6: Channel List —— 我能在哪些信道见面
    p2p_buf_add_channel_list(subelems, p2p->cfg->country,
                             &p2p->channels, is_6ghz_capab);

    // Attribute 7: Device Info —— 我的身份信息
    p2p_buf_add_device_info(subelems, p2p, peer);

    // Attribute 8: Operating Channel —— 我建议在哪个信道建组
    p2p_buf_add_operating_channel(subelems, p2p->cfg->country,
                                  p2p->op_reg_class, p2p->op_channel);

    // 附加：WPS IE（Device Password ID）
    pw_id = p2p_wps_method_pw_id(peer->wps_method);
    p2p_build_wps_ie(p2p, buf, pw_id, 0);

    buf = wpabuf_concat(buf, p2p_encaps_ie(subelems, P2P_IE_VENDOR_TYPE));
    wpabuf_free(subelems);
    return buf;
}
```

现在逐张"条件清单"拆解。

**Attribute 1: Capability（能力声明）**。

Device Capability bitmap + Group Capability bitmap。Device Capability 告诉对方我是纯 P2P Device 还是也能做 WFD Source/Sink、是否支持 Client Discoverability、是否支持 Invitation Procedure 等。注意代码中刻意清掉了 `P2P_DEV_CAPAB_CLIENT_DISCOVERABILITY` 位——这是 P2P 规范的要求：在 GO Negotiation 中不应该声明 Client Discoverability，因为这个能力只在 Device Discovery 阶段有意义。

Group Capability 动态填充：如果 peer 标记了 `P2P_DEV_PREFER_PERSISTENT_GROUP`，设 `P2P_GROUP_CAPAB_PERSISTENT_GROUP`；如果配置了 `cross_connect`，设 `P2P_GROUP_CAPAB_CROSS_CONN`；如果配置了 `p2p_intra_bss`，设 `P2P_GROUP_CAPAB_INTRA_BSS_DIST`。这三项决定了建组后的行为——是否支持跨连接转发、是否允许组内设备互访。

**Attribute 2: GO Intent（意愿值）**。

这是一个 8-bit 字段，结构为：高 4 位是 GO Intent 值（0-15），最低 1 位是 Tie Breaker bit。封装时做 `(go_intent << 1) | tie_breaker`——把两个信息塞进一个字节。Tie Breaker 是 0 或 1 的随机值，在 `p2p_connect()` 中从 `p2p->next_tie_breaker` 分配并翻转。

这就是相亲角比喻中"我有多想当老大"的量化值。15 代表"我非要当 GO 不可"，0 代表"我不想当 GO，你去当"。§4 会详细展开 `p2p_go_det()` 的决策算法——Tie Breaker 是意愿相同时的决胜硬币。

**Attribute 3: Configuration Timeout（配置超时）**。

两个值：GO 侧的超时时间（单位 10ms）和 Client 侧的超时时间。如果我是 GO，给你多少时间来完成 WPS 配置和关联？这个值从 `p2p->go_timeout` 和 `p2p->client_timeout` 取——默认值在 `p2p_init()` 中设置：GO 侧 100（即 1000ms），Client 侧 20（即 200ms）。`wpas_p2p_start_go_neg()` 里还会根据 HT40 是否启用覆盖为 255 或 100。

为什么是两个值而不是一个？因为两种角色的"启动成本"不对称——拉起一个 GO 要准备 AP 模式（Beacon、DHCP server、参数下发），慢；而当一个 Client 只需扫描后关联，快。所以 GO 侧给 1s，Client 侧只给 200ms。

这份不对称信息在 `p2p_go_complete()` 里被精确消费：`res.peer_config_timeout = go ? peer->client_timeout : peer->go_timeout`——我是 GO 就取**对方**的 client_timeout，我是 Client 就取**对方**的 go_timeout，即每台设备用"对方角色的启动时间"来预估自己要等多长时间，而不是用自己的。随后 `wpas_go_neg_completed()` 把它折算进建组超时：`eloop_register_timeout(15 + peer_config_timeout/100, ...)`，15 秒底数留给 WPS 八轮交换，多出来的 `peer_config_timeout` 覆盖对方角色的启动。所以即便 GO 侧比 Client 侧慢，Client 侧也不会先超时——它等的正是 GO 侧那 1s 启动时间。

**Attribute 4: Listen Channel（守候信道）**。

告诉对方"我现在在哪个信道上 Listen"——国家码 + 操作类别（op_class）+ 信道号。从设备发现阶段保留下来的信息。这帮助对方知道在哪个频率上发 Response。

**Attribute 5: Intended P2P Interface Address（预期接口地址）**。

建组后我准备用哪个 MAC 地址作为 P2P Interface Address。这个地址通常和 P2P Device Address 不同——Device Address 是管理面的身份标识（p2p0），Intended Address 是数据面的接口地址（p2p-p2p0-0 这类 group interface）。代码中 `p2p->intended_addr` 在 `p2p_connect()` 里通过 `own_interface_addr` 参数设置——Android 场景下通常是预先创建的 group interface 的 MAC 地址。

**Attribute 6: Channel List（信道列表）**。

我支持的所有信道——以国家码 + 操作类别 + 信道列表的格式编码。如果配置了 `pref_freq_list`（首选频率列表），先用 `p2p_pref_channel_filter()` 过滤后再发；否则发完整的 `p2p->channels`。6GHz 能力 flag 控制是否包含 6GHz 信道。

这是条件清单中最"实在"的一项——"我能接受在哪些地方见面"。双方信道列表的交集决定了后续 Operating Channel 选择的上限。

**Attribute 7: Device Info（设备信息）**。

P2P Device Address（就是 MAC 地址）+ Config Methods（WPS 配置方法 bitmap：PBC/PIN Display/PIN Keypad/NFC 等）。Config Methods 是 Provisioning 阶段的方法能力声明——"我支持哪些方式来确认身份"。

这个 bitmap 里除了 PBC/PIN，还有一个 NFC 接口位（`WPS_CONFIG_NFC_INTERFACE = 0x0040`）：两台手机 NFC 碰一碰，就完成了带外（OOB）配对，后续 WPS 交换的 Device Password ID 走 `DEV_PW_NFC_CONNECTION_HANDOVER = 0x0007`，不再需要 Display/Keypad 互相对着输 PIN。NFC 位和 PIN 位本质是同一张能力表的两个选项，只是对应不同的触碰场景。

**Attribute 8: Operating Channel（建议工作信道）**。

我建议在这个信道上建组。`p2p->op_reg_class` + `p2p->op_channel` 在 `p2p_prepare_channel()` 中初步选定，后续在 `p2p_reselect_channel()` 中可能根据对端信息重新优化。

除了这 8 个 P2P Attributes，GO Neg Request 还携带一个 **WPS IE**。这个 IE 的核心字段是 Device Password ID——告诉对方我用哪种 WPS 方法：PBC（`DEV_PW_PUSHBUTTON = 0x0004`）、PIN from Display（`DEV_PW_REGISTRAR_SPECIFIED = 0x0005`）、PIN from Keypad（`DEV_PW_USER_SPECIFIED = 0x0001`）、NFC 触碰（`DEV_PW_NFC_CONNECTION_HANDOVER = 0x0007`）。这个 ID 在对方 `p2p_process_go_neg_req()` 中会被检查——双方的 WPS 方法必须配对（一个 Display 对应一个 Keypad，或双方都是 NFC），否则直接失败。

为什么 8 个 Attribute 一次性全部发送，而不是渐进式地先交换一两个再补充？这是 GO Negotiation 与 Provision Discovery 在协议设计哲学上的分水岭。渐进式协商（像 WPS 的 8 条消息那样）适合**信息未知、需要逐步探索**的场景——双方不确定对方支持什么，需要一轮一轮试。但 GO Negotiation 的两个核心决策——GO 角色判定和信道选择——都是**确定性算法**：`p2p_go_det()` 只需要对方的一个字节（GO Intent），`p2p_reselect_channel()` 只需要对方的信道列表。这些信息在 Device Discovery 阶段其实已经部分获取过，Request 里再带一次是为了"以本帧为准"。

既然决策函数所需的全部输入都可以在单帧内集齐，渐进式交换只会增加时延和丢帧风险——P2P 帧是单播管理帧，每多一轮交互就多一次"对方不在 Listen 信道"的失败窗口。所以协议选择了"一把梭"：把所有条件摊开，让双方都能在各自的回合内独立算出同一个结论。这是典型的**无状态决策**设计——双方不需要记住"上次谈到哪了"，每一帧都是自包含的完整状态快照。

## 3.2 第二次握手：GO Neg Response ——"这是我的还价"

### 3.2.1 p2p_process_go_neg_req：解析对方的条件

对方发来的 GO Neg Request 通过 Action 帧接收路径（§7.2）到达，最终调用 `p2p_process_go_neg_req()` 处理。

```c
// src/p2p/p2p_go_neg.c:823
struct wpabuf * p2p_process_go_neg_req(struct p2p_data *p2p, const u8 *sa,
                                       const u8 *data, size_t len, int rx_freq,
                                       bool p2p2)
```

处理流程分五步：

**第一步：解析 P2P IE**。`p2p_parse()` 把收到的帧 payload 解析成 `struct p2p_message`——一个包含所有 P2P Attribute 指针的结构体。

**第二步：逐项验证 8 个必选 Attribute**。`Capability`、`GO Intent`、`Configuration Timeout`、`Listen Channel`、`Operating Channel`、`Channel List`、`Intended P2P Interface Address`、`P2P Device Info`——每个 Attribute 都有 `if (!msg.xxx) goto fail;` 的检查。

其中 Capability、GO Intent、Configuration Timeout 的失败被包在 `CONFIG_P2P_STRICT` 编译选项里——非 strict 编译下缺失只是打日志继续走；而 Listen Channel、Operating Channel、Channel List、Intended P2P Interface Address、P2P Device Info 缺失则是无条件 `goto fail`——这些是 P2P 规范的硬性要求，无论编译选项如何都必须携带。这是 P2P 规范合规性最严格的部分。

**第三步：SA 地址校验**。`msg.p2p_device_addr` 必须是 SA（源 MAC 地址）——防止中间人伪造。

**第四步：查找或创建设备记录**。`p2p_get_device(p2p, sa)` 从设备链表找——如果不在列表中（被动方可能还没主动 Discovery 过），通过 `p2p_add_dev_from_go_neg_req()` 从 Request 的内容创建一条新记录。

**第五步：GO 决策 + 信道选择 + WPS 方法配对**。如果对方没有被用户拒绝、wps_method 已经就绪、没有正在和其他 peer 谈判：

```c
go = p2p_go_det(p2p->go_intent, *msg.go_intent);    // GO 角色决策
if (go < 0) {
    status = P2P_SC_FAIL_BOTH_GO_INTENT_15;           // 两人都非要当老大
    goto fail;
}
// ... WPS 方法配对检查 ...
if (go && p2p_go_select_channel(p2p, dev, &status) < 0)  // 我是 GO → 我选信道
    goto fail;
dev->go_state = go ? LOCAL_GO : REMOTE_GO;            // 角色确定
```

注意信道选择的时机：只有当 `go == 1`（我方胜出，将成为 GO）时才调 `p2p_go_select_channel()`。如果我方被判定为 Client，信道由对方的 GO 决定——我只检查是否有共同信道即可（`p2p_peer_channels()` 在 WPS 方法配对前已执行）。

"没有正在和其他 peer 谈判"这个守卫保护的是 `p2p->go_neg_peer` 这个**单槽**指针（`p2p_connect_send()` 里赋值为当前谈判对象）。如果谈判进行中收到**另一个设备**的 GO Neg Request，`p2p_process_go_neg_req()` 走到 `p2p->go_neg_peer && p2p->go_neg_peer != dev` 分支，直接回 `P2P_SC_FAIL_UNABLE_TO_ACCOMMODATE`（"无法同时接待"）——谈判桌上只能坐两个人。收到**非当前对象**的 GO Neg Response 也一样：`dev != p2p->go_neg_peer` 直接丢弃。

还有一个更微妙的对称场景——两台设备**同时发起**谈判：双方都发出了 GO Neg Request。此时 `p2p_process_go_neg_req()` 检查 `dev->go_neg_req_sent && os_memcmp(sa, p2p->cfg->dev_addr, ETH_ALEN) > 0`——如果我已经发过 Request 且对方的 MAC 地址比我大，就不回 Response，让对方"赢"这一轮，避免两边同时回 Response 造成死锁。这和 Tie Breaker 是互补的两套机制：Tie Breaker 解决"同一轮谈判里谁当 GO"，MAC 比较解决"两轮同时发起的谈判让谁先走"。

如果 Request 中包含 Status attribute 且值为 `P2P_SC_FAIL_REJECTED_BY_USER`——这是一种非标准但常见的"对方拒绝"信号。代码对这种非合规行为做了兼容处理：不回复 Response，直接标记谈判失败。

### 3.2.2 p2p_build_go_neg_resp：构建应价

`p2p_process_go_neg_req()` 最后调用 `p2p_build_go_neg_resp()` 构建 Response。Response 的结构和 Request 基本对称——8 个 P2P Attributes，但有几个关键差异：

**新增 Status attribute**。Response 的第一个 attribute 是 Status——`P2P_SC_SUCCESS`（0）表示接受谈判继续，非 0 表示拒绝（`P2P_SC_FAIL_BOTH_GO_INTENT_15`、`P2P_SC_FAIL_INCOMPATIBLE_PROV_METHOD` 等各种失败码）。

**GO Intent 用的是我的值**。`p2p_buf_add_go_intent(subelems, (p2p->go_intent << 1) | tie_breaker)` —— `tie_breaker` 来自 Request 中对方的 GO Intent 的最低 1 位（`*msg.go_intent & 0x01`），取反后塞入 Response（`!tie_breaker`）。这是 Tie Breaker 机制的第二层保护——在 Request 和 Response 之间翻转，确保不会出现"两边都认为自己是 GO"的歧义。

**Operating Channel 的条件性省略**。如果我是 REMOTE_GO（对方当 GO）且没有首选频率列表，省略 Operating Channel attribute——让对方的 GO 决定信道。

**Group ID 的条件性携带**。如果我是 LOCAL_GO，在 Response 中携带 `p2p_buf_add_group_id()` ——把自己的 P2P Device Address + SSID 发给对方，供对方在 Group Formation 阶段使用。

**Channel List 的交集计算**。如果我是 LOCAL_GO，`p2p_build_go_neg_resp()` 把我的信道列表和对端的信道列表做交集（`p2p_channels_intersect()`），只发交集部分——"这是我俩都能用的频道"。如果我是 REMOTE_GO，发我的完整信道列表。

构建完成后，Response 通过 Action 帧发送出去。如果 `status == P2P_SC_SUCCESS`，设 `P2P_PENDING_GO_NEG_RESPONSE` 等待 Confirm；如果失败，设 `P2P_PENDING_GO_NEG_RESPONSE_FAILURE`。

## 3.3 第三次握手：GO Neg Confirm ——"成交，就这么定了"

### 3.3.1 p2p_process_go_neg_resp：收到还价，决定是否接受

对方发来的 GO Neg Response 通过 Action 帧接收路径到达，调用 `p2p_process_go_neg_resp()` 处理（`p2p_go_neg.c:1264`）。

处理流程和 `p2p_process_go_neg_req` 类似但更紧凑——因为这是"应价"，不是"开价"：

- 找到 `p2p->go_neg_peer`，确认 `WAIT_GO_NEG_RESPONSE` 标记已设置
- 匹配 `dialog_token`——保证 Request 和 Response 是同一轮谈判
- 解析 Status attribute——如果是失败码，调 `p2p_go_neg_failed()` 收摊。有一个特殊处理：`P2P_SC_FAIL_INFO_CURRENTLY_UNAVAILABLE` 不立即失败，而是设 120 秒超时等待对方就绪
- 调 `p2p_go_det(p2p->go_intent, *msg.go_intent)` 再次做 GO 决策——因为在 Request 中是我知道的（自己的 intent 和对方的 intent），但 Response 是对方确认的值。两次决策使用相同的算法，结果应该一致——如果不一致说明有 bug 或异常
- 如果 GO 决策失败（`go < 0`），状态设为 `P2P_SC_FAIL_INCOMPATIBLE_PARAMS` 并在 Confirm 中回给对方
- WPS 方法再次配对验证
- 如果我是 GO，调 `p2p_go_select_channel()` 最终确定信道

确认无误后，调 `p2p_build_go_neg_conf()` 构建确认帧。

### 3.3.2 p2p_build_go_neg_conf：最终的确认单

```c
// src/p2p/p2p_go_neg.c:1181
static struct wpabuf * p2p_build_go_neg_conf(struct p2p_data *p2p,
                                             struct p2p_device *peer,
                                             u8 dialog_token, u8 status,
                                             const u8 *resp_chan, int go)
```

Confirm 帧的内容比 Request/Response 精简——它不需要重新谈判，只需要锁定结果：

- **Status**：最终状态码。`P2P_SC_SUCCESS` 表示一切 OK
- **Capability**：我方的最终能力声明（Device Capability + Group Capability）
- **Operating Channel**：确定的工作信道。如果我是 GO（`go == 1`），用我选的信道（`p2p->op_reg_class + p2p->op_channel`）；否则用对方 Response 中的信道（`resp_chan`）
- **Channel List**：双方信道交集（`p2p_channels_intersect(&p2p->channels, &peer->channels, &res)`），供对方确认我们没有在选信道时出错
- **Group ID**（仅我方为 GO 时携带）：P2P Device Address + SSID，给对方在 Group Formation 阶段关联和认证时使用

这 5 个字段（Status + Capability + Operating Channel + Channel List + 条件性的 Group ID）构成了 Confirm 的完整语义。不是"只确认 Status"，而是"确认 Status 外加锁定关键参数"。

### 3.3.3 p2p_handle_go_neg_conf：收到确认，谈判结束

注：supplicant 代码中没有名为 `p2p_process_go_neg_conf` 的函数——Confirm 的处理函数是 `p2p_handle_go_neg_conf`，由 `p2p_rx_p2p_action()` 分发调用。它直接做 parse + validate + 结果处理，没有拆成 process/respond 两步。

```c
// src/p2p/p2p_go_neg.c:1576
void p2p_handle_go_neg_conf(struct p2p_data *p2p, const u8 *sa,
                            const u8 *data, size_t len, bool p2p2)
```

收到 Confirm 后的处理直奔结果：

- 确认 `WAIT_GO_NEG_CONFIRM` 标记已设置，匹配 `dialog_token`
- 检查 Status——非 SUCCESS → `p2p_go_neg_failed()`
- 验证 `go_state != UNKNOWN_GO`——此时角色必须已经确定
- **等 20ms 再调用 `p2p_go_complete()`**：`os_sleep(0, 20000)` 的意图是在当前信道上多停留一小段时间——万一对方的 Confirm 需要重传（因为对方的 ctrl::ack 丢失），我方还在这里等着收重传帧。这是一种防御性设计

---

# 4 到底谁当老大？p2p_go_det() 的意愿对比算法与 Tie Breaker 决胜机制

三次握手看完了，但有一个核心问题还没回答：到底怎么决定谁当 GO？

这个问题在每一轮握手中都会被计算——Request 处理时算一次，Response 处理时再算一次。两次用相同的算法、相同的数据，结论一致。

## 4.1 算法本体

```c
// src/p2p/p2p_go_neg.c:21
static int p2p_go_det(u8 own_intent, u8 peer_value)
{
    u8 peer_intent = peer_value >> 1;
    if (own_intent == peer_intent) {
        if (own_intent == P2P_MAX_GO_INTENT)  // P2P_MAX_GO_INTENT = 15
            return -1;  // 双方都非要当老大 → 谈判破裂

        /* 意愿相同但不是 15 → Tie Breaker 决胜 */
        return (peer_value & 0x01) ? 0 : 1;
    }

    return own_intent > peer_intent;  // 谁意愿高谁当 GO
}
```

只有 12 行代码，但包含了分布式系统中"一致性决策"的全部智慧。逐行解读：

`peer_intent = peer_value >> 1`：对方传来的 GO Intent attribute 是一个字节，高 4 位是 intent（0-15），最低 1 位是 Tie Breaker bit。右移 1 位提取高 4 位。

`if (own_intent == peer_intent)`：双方意愿值相同。这是决策的分叉路口——如果双方意愿不同，答案很简单：谁高谁当。但如果相同呢？

`if (own_intent == 15) return -1`：双方都非要当 GO——这是死局。P2P 规范规定 INTENT=15 冲突时谈判强制失败（`P2P_SC_FAIL_BOTH_GO_INTENT_15`）。想想相亲角里两个人都说"我必须当老大，没商量"——那这条件谈不下去。

`return (peer_value & 0x01) ? 0 : 1`：Tie Breaker 决胜。对方的最低 1 位如果是 1，我方当 Client（返回 0）；如果是 0，我方当 GO（返回 1）。这个逻辑初看有点绕——为什么 peer_value 的最低位是 1 时我方反而不当 GO？因为 **Tie Breaker 在 Request 和 Response 之间会被取反**。发起方在 Request 中用原始值，响应方在 Response 中用 `!tie_breaker`。两边的 p2p_go_det 各自用自己的 own_intent 和对方的 peer_value 计算，最终会得出互斥的结果——一边 LOCAL_GO，另一边 REMOTE_GO。

`return own_intent > peer_intent`：常规情况——谁的意愿值高谁当老大。简单粗暴，符合直觉。

返回值含义：`1` = 我方当 GO（`LOCAL_GO`），`0` = 对方当 GO（`REMOTE_GO`），`-1` = 谈判失败。

## 4.2 Tie Breaker bit：协议级别的分布式一致性保护

Tie Breaker 不是随便生成的随机数。它的生命周期经过精心设计：

**初始化**：`p2p_init()` 中通过 `os_get_random()` 把 `p2p->next_tie_breaker` 直接随机化为 0 或 1——目的是让两个同时发起连接的设备不在相同的 Tie Breaker 上竞争。

**分配**：`p2p_connect()` 中，`dev->tie_breaker = p2p->next_tie_breaker; p2p->next_tie_breaker = !p2p->next_tie_breaker;`。每次连接取当前值并翻转——如果连续两次连接都失败了，重试时 Tie Breaker 交替使用 0 和 1，改变谈判结果。

**封装**：Request 中 `(go_intent << 1) | tie_breaker`。接收方用 `peer_value >> 1` 取 intent，用 `peer_value & 0x01` 取 Tie Breaker。

**响应方的反转**：`p2p_process_go_neg_req()` 中 `tie_breaker = *msg.go_intent & 0x01`（取对方的 Tie Breaker），然后在 `p2p_build_go_neg_resp()` 中用自己的 GO Intent 拼上 `!tie_breaker`——把自己的 Tie Breaker 设为对方的反值。

这一套机制保证：即使双方 GO Intent 完全相同（比如都是 6），Tie Breaker 也能干净利落地选出 GO——不存在双方同时判自己为 GO 的歧义。

## 4.3 双方 INTENT=15 的冲突：为什么不允许两个 15？

P2P 规范明确规定：双方 GO Intent 都是 15 → 谈判必须失败。这不是 bug，是设计。

INTENT=15 的语义是"我必须是 GO"。如果两台设备的用户都选择了"我必须当老大"——这在 UI 上可能表现为"强制 GO 模式"——那两台设备的核心意图冲突了，没有任何算法能公平解决。Tie Breaker 在这种场景下被刻意禁用——因为 Tie Breaker 假定双方都能接受"当 Client"，只在"谁更合适"上做裁决。而 INTENT=15 意味着"我不接受当 Client"。

代码处理这条路径的方式是返回 `-1`，然后在 `p2p_process_go_neg_req()` 中：

```c
go = p2p_go_det(p2p->go_intent, *msg.go_intent);
if (go < 0) {
    p2p_dbg(p2p, "Incompatible GO Intent");
    status = P2P_SC_FAIL_BOTH_GO_INTENT_15;
    goto fail;
}
```

`fail` 标签后仍然构建一个 Response——但 Status 是 `P2P_SC_FAIL_BOTH_GO_INTENT_15`。这个 Response 会发给对方，让对方也知道谈判破裂了。

在相亲角的比喻里：两个人都说"我必须当老大"，管理处的工作人员摊手——"你们自己解决吧，我帮不了"。

---

# 5 在哪见面最合适？p2p_go_select_channel() 的十级信道优先级链

谈判中确定了谁当 GO，接下来 GO 要选场地（Operating Channel）。这不是随手翻牌子——背后有一套十级的优先级链条，每一级都是对"最优信道"的不同侧面的考量。

## 5.1 p2p_go_select_channel：入口

```c
// src/p2p/p2p_go_neg.c:572
int p2p_go_select_channel(struct p2p_data *p2p, struct p2p_device *dev,
                          u8 *status)
```

入口做三件事：取双方信道交集 → 移除 no-GO 频率（DFS 雷达检测占用的信道、法规禁止的信道等）→ 再和本地配置的信道列表做交集。如果交集为空，返回 `P2P_SC_FAIL_NO_COMMON_CHANNELS`——"我们没有共同信道，没法见面"。

然后判断是否需要重新选信道：如果当前选的 `op_channel` 不在交集内（且对方没有强制频率）→ 调 `p2p_reselect_channel()`；如果对方没有强制频率且本地没有强制配置 → 也调 `p2p_reselect_channel()` 做优化——因为此时有了对端信道信息，可以比当初 `p2p_prepare_channel()` 做得更好。

最后如果 SSID 还没生成，调 `p2p_build_ssid()` 生成——用 `DIRECT-` 前缀加随机字符。

## 5.2 p2p_reselect_channel：十级优先级链

```c
// src/p2p/p2p_go_neg.c:441
void p2p_reselect_channel(struct p2p_data *p2p,
                          struct p2p_channels *intersection)
```

每一级都是一个 `if` 条件——命中即返回，不往下走。这个结构本身就是优先级排序。把这十级链条从上到下摊开，就能看清"理想"到"现实"的逐级妥协：

![p2p_reselect_channel() 十级信道优先级链（命中即返回 · 从理想逐级妥协到现实）](assets/11d-P2P%EF%BC%88%E5%9B%9B%EF%BC%89GO-Negotiation-%E2%80%94%E2%80%94%E7%9B%B8%E4%BA%B2%E8%A7%92%E9%87%8C%E8%B0%88%E6%9D%A1%E4%BB%B6%EF%BC%8C%E8%B0%81%E5%BD%93%E8%80%81%E5%A4%A7/11d-channel-priority-1790260483519-3.svg)

**第一级：我方首选频率**。`p2p->own_freq_preference > 0`，由 `wpas_p2p_set_own_freq_preference()` 依据 `wpas_p2p_setup_freqs()` 选出的 force_freq/pref_freq 设置——这是 supplicant 侧自己选出的首选频率，而非 Framework 的 `WifiP2pConfig.groupOwnerBand`（该字段在连接路径不会传到 supplicant）。如果在交集中 → 直接用。这是最高优先。

**第二级：最佳综合频率**。`p2p->best_freq_overall > 0`，由驱动通过 `QCA_NL80211_VENDOR_SUBCMD_AVOID_FREQUENCY` 等 vendor command 上报——驱动综合考虑了当前环境干扰、DFS 状态、共存场景等因素后推荐的最佳频率。如果说第一级是"我想"，第二级是"专家建议"。

**第三级：跨频段优化——当前是 2.4GHz，试试 5GHz**。如果当前 `op_channel` 在 2.4GHz 范围内（`freq >= 2400 && freq < 2500`），且不在交集中（因为有了对端信道信息后分析发现 2.4GHz 不匹配），转到 `best_freq_5`——"既然 2.4GHz 咱俩不凑合，我换个 5GHz 试试"。`best_freq_5` 和 `best_freq_24` 是 `p2p_set_best_channels()` 设置的，来源同样是驱动推荐。

**第四级：跨频段优化——当前是 5GHz，试试 2.4GHz**。和第三级对称——当前是 5GHz（`freq >= 4900 && freq < 6000`）且不匹配，转到 `best_freq_24`。

**第五级：双方都喜欢的首选信道**。`p2p->cfg->pref_chan` 数组——配置文件中 `p2p_pref_chan` 参数指定的首选信道列表。按数组顺序遍历，第一个在交集中的就选它。如果双方都配置了 preferred channel，它们的交集理论上在这一级之前（`p2p_go_select_channel()` 的阶段一）已经被优先处理。

**第六级：EDMG 信道**（802.11ad/ay，60GHz）。`op_classes_edmg[] = { 181, 182, 183, 0 }`——如果支持 60GHz 频段，优先选 60GHz 信道。这是带宽的极致——60GHz 干扰最小、速率最高，但穿墙能力接近于零。

**第七级：VHT 信道**（802.11ac，80/160MHz）。`op_classes_vht[] = { 128, 129, 130, 0 }`——VHT 操作类别。选 VHT 信道意味着可以开 80MHz 甚至 160MHz 带宽。

**第八级：HT40 信道**（802.11n，40MHz）。`op_classes_ht40[] = { 126, 127, 116, 117, 0 }`——HT40 操作类别。可以在 2.4GHz 或 5GHz 上用 40MHz 带宽。

**第九级：任意 5GHz 信道**。`op_classes_5ghz[] = { 124, 125, 115, 0 }`——只要能工作在 5GHz，不限带宽。5GHz 比 2.4GHz 干扰少、信道多，是优先级高于"只要能通信就行"的选择。

**第十级：原始信道兜底**。如果当前 `op_channel` 在交集中——那就用它，不改了。当前信道是在 `p2p_prepare_channel()` 里选的，本身就包含一定的随机化（避免多个 GO 同时选同一信道）。

**最终兜底：随便哪个都行**。前十级全部没命中 → 取交集中的第一个信道（`intersection->reg_class[0].channel[0]`）。这不是"最优"，但至少"能用"。

这个十级链条体现了从"理想"到"现实"的逐级妥协——就像相亲角里谈见面地点，理想是订下"5GHz 150 信道、160MHz 带宽"的大宴会厅，最差是随便哪个"2.4GHz 小隔间"，能坐下谈就行。每一级都是 P2P 协议设计者对不同场景下"好信道"定义的编码。

这套十级链在 `p2p_go_select_channel()` 的阶段一就把 no-GO 频率剔除了——`p2p_channels_remove_freqs(&tmp, &p2p->no_go_freq)` 把 DFS 雷达占用的信道（以及法规/配置禁用的信道）从交集中移除，十级链只在剩下的交集里选。也就是说，P2P GO 在**谈判阶段**就默认避开 DFS 信道（`p2p_go_allow_dfs` 默认关闭，只有驱动支持 DFS offload 时才放开），从源头规避了"GO 建在雷达信道上"的风险。

那如果 GO 已经跑起来后，所在信道才被雷达检测到怎么办？那属于 Group Formation 之后的 AP 域处理——supplicant 走 hostapd 的 `hostapd_dfs_radar_detected()` 做 CSA（Channel Switch Announcement）切换，已经不在本文"GO Negotiation 选信道"的范畴内了。

---

# 6 不谈判行不行？Autonomous GO 怎么跳过三次握手直接建组

前面的全部内容围绕一个前提：有一个 peer 要和你谈判。但 P2P 还有一种完全不同的建组方式——Autonomous GO。不找对方，不谈判，直接宣布"我是 GO"。

## 6.1 Framework 侧：createGroup vs connect

在 §1.2 我们提到 Framework 侧有两条路进 GroupCreatingState：`CONNECT` 走 connect 路径，`CREATE_GROUP` 走 createGroup 路径。两者的区别在 InactiveState 的处理中已经体现：

- **CONNECT**：需要 peer device address，`mAutonomousGroup = false`，最终调 `p2pConnect()`
- **CREATE_GROUP**：不需要 peer，`mAutonomousGroup = true`，最终调 `p2pGroupAdd()`

`createGroup` 走了和 connect 相同的前半段路径——InactiveState → GroupCreatingState → GroupNegotiationState ——但中间跳过了所有与 peer 交互的步骤。因为 `mAutonomousGroup = true`，GroupNegotiationState 内的行为也有所不同：不需要等待 `P2P_GROUP_STARTED_EVENT` 来确认"对方已加入"，而是收到 GO 就绪信号后直接广播。

## 6.2 Supplicant 侧：p2p_group_add 跳过谈判

```c
// wpa_supplicant/p2p_supplicant.c:7095
int wpas_p2p_group_add(struct wpa_supplicant *wpa_s, int persistent_group,
                       int freq, int vht_center_freq2, int ht40, int vht,
                       int max_oper_chwidth, int he, int edmg,
                       bool allow_6ghz)
{
    // 6GHz 许可检查：请求的频率落在 6GHz 但未获 6GHz 能力时直接拒绝建组
    if (wpas_p2p_check_6ghz(wpa_s, NULL, allow_6ghz, freq))
        return -1;

    // 清掉上一次组形成阶段暂存、尚未消费的 PSK，避免新群继承旧凭据
    os_free(wpa_s->global->add_psk);
    wpa_s->global->add_psk = NULL;

    // 停掉正在跑的 Find
    wpas_p2p_stop_find_oper(wpa_s);

    // 选频率
    if (!wpa_s->p2p_go_do_acs) {
        selected_freq = wpas_p2p_select_go_freq(wpa_s, freq);
    }

    // 初始化 GO 参数（角色直接设 GO，不经过 p2p_go_det）
    wpas_p2p_init_go_params(wpa_s, &params, selected_freq, ...);
    p2p_go_params(wpa_s->global->p2p, &params);

    // 获取或创建 group interface，直接启 WPS GO
    wpa_s = wpas_p2p_get_group_iface(wpa_s, 0, 1);
    wpas_start_wps_go(wpa_s, &params, 0);
}
```

关键差异一目了然：不调 `p2p_connect()`——没有 `p2p_go_det()`，没有 `p2p_build_go_neg_req()`，没有三轮握手。`wpas_p2p_init_go_params()` 直接把角色设为 GO、生成 SSID 和 passphrase、选定频率，然后 `wpas_start_wps_go()` 直接启动 WPS Registrar 等待 Client 来连接。（Autonomous GO 在 supplicant 侧的完整五步流程、WPS Config Methods 的单方宣告细节，已在《P2P（七）高级特性与运维》§1.3 展开，这里只保留与 GO Negotiation 的对比视角。）

Autonomous GO 还有一个细分场景值得一提——PCC（P2P Client Coordination）模式：一台设备同时作为 GO 建群、又作为 Client 加入另一个群。为什么要 PCC？因为 P2P 的角色并不排他——同一台手机可以一边给朋友开热点当 GO，一边又加入另一个群拉文件当 Client，两个组并行不悖。但"一人分饰两角"带来一个设计问题：我这个 GO 建的组，允许什么安全级别的 Client 加入？PCC 用连接类型（connection type）来回答——`WifiP2pConfig` 定义了三种连接类型（`WifiP2pConfig.java:272/283/291`）：

- `PCC_MODE_CONNECTION_TYPE_LEGACY_ONLY`（0）——GO 只开 WPA2-Personal（`WPA_PSK`），兼容所有 R1 老设备；
- `PCC_MODE_CONNECTION_TYPE_LEGACY_OR_R2`（1）——WPA3-Personal 兼容模式：GO 同时宣告 WPA2 和 WPA3 两套凭据，新老设备都能进；
- `PCC_MODE_CONNECTION_TYPE_R2_ONLY`（2）——GO 只开 WPA3-Personal（`SAE`），只收 R2 设备。

连接类型最终要翻译成 supplicant 认识的密钥管理掩码。`SupplicantP2pIfaceHalAidlImpl.p2pConfigConnectionTypeToSupplicantKeyMgmtMask()`（`SupplicantP2pIfaceHalAidlImpl.java:1299`）做这个映射：LEGACY_ONLY → `KeyMgmtMask.WPA_PSK`、LEGACY_OR_R2 → `WPA_PSK | SAE`、R2_ONLY → `SAE`（`KeyMgmtMask.aidl`：`WPA_PSK = 1<<1`、`SAE = 1<<10`）。这个 mask 随 `addGroupWithConfigurationParams` 的 `keyMgmtMask` 字段下发给 supplicant，决定 GO 组宣告哪种加密套件。

为什么是 SAE vs WPA-PSK 二选一、或两者都要？这是**安全与兼容的取舍**。WPA-PSK（WPA2-Personal）是 R1 时代的标准——所有 P2P 设备都认识，但预共享密钥容易被离线字典攻击；SAE（WPA3-Personal）用 Dragonfly 握手 + 前向保密，抗离线爆破，但只有 R2 设备支持。LEGACY_OR_R2 走 WPA3 Compatibility Mode——GO 同时宣告两套 RSN，老设备用 WPA2 进来、新设备用 WPA3，兼顾两者。还有一个硬约束：6GHz 频段强制 WPA3（`wpas_start_wps_go()` 里 `is_6ghz_freq` 分支直接把 `key_mgmt` 设成 `WPA_KEY_MGMT_SAE`，见 `p2p_supplicant.c:2113`），所以想建 6GHz 组，连接类型必须是 R2_ONLY。

Framework 侧的能力探测链决定应用层能不能用这些连接类型：`SupplicantP2pIfaceHalAidlImpl.getSupportedFeatures()`（`:2655`）调 `mISupplicantP2pIface.getFeatureSet()`（`:2667`），检查 supplicant 上报的特性位 `P2P_FEATURE_PCC_MODE_WPA3_COMPATIBILITY`（`ISupplicantP2pIface.aidl:53`，`1 << 1`）是否置位，置位才向应用层上报 `FEATURE_PCC_MODE_ALLOW_LEGACY_AND_R2_CONNECTION`（`WifiP2pManager.java:183`）。

`WifiP2pNative.p2pGroupAdd()`（`:727`）在建组时据此做守卫：请求 LEGACY_OR_R2 但 `isPccModeAllowLegacyAndR2ConnectionSupported()`（`WifiP2pNative.java:799`）为 false 就拒绝，请求 R2_ONLY 或 6GHz 但 `isWiFiDirectR2Supported()` 为 false 也拒绝。

## 6.3 对比总结

| 维度            | GO Negotiation                                          | Autonomous GO                           |
| --------------- | ------------------------------------------------------- | --------------------------------------- |
| Framework 入口  | `WifiP2pManager.connect()`                              | `WifiP2pManager.createGroup()`          |
| 需要 peer       | 需要（已知 MAC 地址）                                   | 不需要                                  |
| Supplicant 入口 | `wpas_p2p_connect` → `p2p_connect` → `p2p_connect_send` | `wpas_p2p_group_add`                    |
| GO 决策         | `p2p_go_det()` 协商决定                                 | 直接设为 GO                             |
| 信道选择        | `p2p_go_select_channel()` 十级优先级                    | `wpas_p2p_select_go_freq()` 自己选      |
| 三次握手        | 有（Request/Response/Confirm）                          | 无                                      |
| WPS 仍需要      | 是（Provision Discovery + WPS）                         | 是（等待 Client WPS 连接）              |
| 典型场景        | 连接指定设备、Persistent Group 重连                     | 创建开放群组、Miracast Source、文件分享 |

Autonomous GO 不是"偷懒版的 GO Negotiation"，而是完全不同的使用场景。相亲角里你想建一个开放摊位等别人来——不需要和任何人谈条件，你决定一切。Miracast 的 Source 端就是典型的 Autonomous GO：手机屏幕投射到电视上，手机建组当 GO，电视作为 Client 通过 WPS 加入。不需要谈判，因为"谁是 GO"在应用场景中已经天然确定了——投屏设备必须当 GO（承载视频流），接收设备当 Client。完整的使用场景清单（Miracast、开放热点、Persistent Group 秒重连的边界）见《P2P（七）高级特性与运维》§1.5，这里只强调它和 GO Negotiation 的角色判定哲学差异。

---

# 7 驱动侧：Action 帧怎么收发的？

三层握手中的每一个帧——GO Neg Request、Response、Confirm——都是 P2P Public Action Frame，最终通过 Wi-Fi 驱动和固件在无线信道上发送和接收。前面几节里，谈判双方在桌面上把条件清单写好、摊开、对账——但这些清单自己不会飞。把"写好的条件"装进信封、送到对方手里、再把对方的回信带回来的，就是这一节的主角：驱动和固件。本节追踪这条送信路径的两个方向：发送（supplicant → nl80211 → 驱动 → 固件 → 空中）和接收（空中 → 固件 → 驱动 → supplicant）。

## 7.1 发送路径：从 p2p_send_action 到电波

supplicant 构建完 Action 帧 payload 后，调用 `p2p_send_action()`：

```c
// src/p2p/p2p.c:5082
int p2p_send_action(struct p2p_data *p2p, unsigned int freq, const u8 *dst,
                    const u8 *src, const u8 *bssid, const u8 *buf,
                    size_t len, unsigned int wait_time)
{
    int res, scheduled;
    res = p2p->cfg->send_action(p2p->cfg->cb_ctx, freq, dst, src, bssid,
                                buf, len, wait_time, &scheduled);
    // ... 如果帧被调度发送且当前在 Listen 且 Listen 信道和发送信道不同
    // 则停止 Listen 以允许立即发送 ...
    return res;
}
```

`cfg->send_action` 是回调函数指针，实际指向 `wpas_send_action()` → `wpa_driver_nl80211_send_action()`（`driver_nl80211.c:9327`），最终通过 `nl80211_send_frame_cmd()` 下发 `NL80211_CMD_FRAME`——把 Action 帧的完整 payload（包括 MAC header + frame body）连同发送参数（频率、等待 ACK 时间、不使用的信道列表）通过 netlink 消息发给内核的 cfg80211。

**QCOM 平台**：cfg80211 收到 `NL80211_CMD_FRAME` 后，调用驱动注册的 `mgmt_tx` 回调——在 qcacld-3.0 中是 `wlan_hdd_mgmt_tx()`（`core/hdd/src/wlan_hdd_p2p.c:403`），最终调用 `wlan_cfg80211_mgmt_tx()`。这条 QCOM 的 TX 路径有完整的多层调用链：

`wlan_cfg80211_mgmt_tx`（`os_if/p2p/src/wlan_cfg80211_p2p.c:421`）→ `ucfg_p2p_mgmt_tx`（P2P 调度层）→ `p2p_process_mgmt_tx`（core 层，分类 on/off-channel）→ `p2p_execute_tx_action_frame`（帧构建：NOA 插入、MAC header、HT caps）→ `p2p_mgmt_tx`（填 `wmi_mgmt_params`）→ `wlan_mgmt_txrx_mgmt_frame_tx`（mgmt_txrx 框架）→ `send_mgmt_cmd_tlv`（WMI TLV 层，`WMI_MGMT_TX_SEND_CMDID`）→ 固件。

这个链的每一步都在不同组件中——OSIF / Dispatcher / Core / mgmt_txrx / WMI——每层只做自己该做的事。这个拆分不是随意的：每一层恰好隔离一个变化源。

OSIF（`os_if/p2p`）屏蔽内核接口变化——`wlan_cfg80211_mgmt_tx()` 把 cfg80211 的 `mgmt_tx` 回调翻译成 P2P 组件认识的调用，内核回调签名一变只改这一层；Dispatcher（`components/p2p/dispatcher`）屏蔽组件间通信方式变化——`ucfg_p2p_mgmt_tx()` 在这里分配 cookie、把 `P2P_MGMT_TX` 调度消息投递给 core，组件之间怎么互相调用一变只改这一层。

Core（`components/p2p/core`）持有 P2P 核心状态——`p2p_soc_priv_obj`、TX/RX 上下文、on/off-channel 分类都在 `wlan_p2p_off_chan_tx.c`，P2P 逻辑一变只改这一层；WMI（`qca-wifi-host-cmn/wmi`）负责跨 CPU 的命令序列化——`send_mgmt_cmd_tlv()` 把 `wmi_mgmt_params` 封成 TLV 经 `WMI_MGMT_TX_SEND_CMDID` 发往固件，固件协议一变只改这一层。TX 上下文通过 `p2p_find_tx_ctx()` 查找对应的 vdev，cookie 通过 `qdf_idr_alloc` 分配用于匹配后续的 TX 完成通知。

固件在指定频率上发送帧并等待 ACK。TX 完成的回调路径是固件 → `tgt_p2p_mgmt_ota_comp_cb` → `p2p_process_mgmt_tx_ack_cnf` → `wlan_p2p_action_tx_cnf_callback`（`wlan_cfg80211_p2p.c:125`）→ `cfg80211_mgmt_tx_status()` → supplicant。

**MTK 平台**：MTK 驱动的 TX 走 mbox 消息总线，没有 WMI 层。cfg80211 的 `mgmt_tx` 回调是 `mtk_cfg_mgmt_tx()`（`os/linux/gl_cfg80211.c:7926`），P2P Action 帧经过 `mtk_p2p_cfg80211_mgmt_tx()`（`os/linux/gl_p2p_cfg80211.c:2853`）构建 `MSG_MGMT_TX_REQUEST`（消息 ID `MID_MNY_P2P_MGMT_TX`），通过 `mboxSendMsg()` 发给固件。

mbox 分发到 `p2pFsmRunEventMgmtFrameTx` → `p2pDevFsmRunEventMgmtTx`（P2P_DEV FSM 处理 on-channel / off-channel 两种路径）→ on-channel 路径调 `p2pFuncTxMgmtFrame`（`mgmt/p2p_func.c:1307`）设重试次数和生命周期后 `nicTxEnqueueMsdu()` 入队 → WMM TX 队列 → TX 描述符 ring → 固件。off-channel 路径走 `p2pDevHandleOffchnlTxReq`（`p2p_dev_fsm.c:1122`）的 FSM 状态机，先申请信道再发送。

TX 确认：固件 TX done → `p2pDevFsmRunEventMgmtFrameTxDone` → `kalP2PIndicateMgmtTxStatus`（`os/linux/gl_p2p_kal.c:1310`）→ `cfg80211_mgmt_tx_status()` → supplicant。

双平台的关键差异，就像同一封信走了两条不同的邮路：QCOM 走的是层层分拣的邮政干线——mgmt_txrx 框架 + WMI TLV 命令逐层下发，每层各司其职，还有独立的 `p2p_find_tx_ctx` 做上下文查找和 cookie 匹配；MTK 走的是点对点直投的信箱——mbox 消息直接塞进对方邮箱，由 P2P_DEV FSM 状态机管理发送、P2P 角色 FSM 负责信道切换和 off-channel 调度。这是两种完全不同的 IPC 和状态管理哲学。

## 7.2 接收路径：从空中到 supplicant

对方发来的 Action 帧经固件接收后，上报给驱动。

**QCOM 平台**：固件接收 Action Frame → WMI event `WMI_MGMT_RX_EVENTID`（管理帧通用接收事件，包含频率、RSSI、完整 frame payload）→ mgmt_txrx 框架按 component 分发 → P2P component 注册的 `tgt_p2p_mgmt_frame_rx_cb` → scheduler 消息 `P2P_EVENT_RX_MGMT` → `p2p_process_rx_mgmt`（`wlan_p2p_off_chan_tx.c:3425`）→ `wlan_p2p_rx_callback`（`wlan_cfg80211_p2p.c:51`）→ `cfg80211_rx_mgmt()` 上抛内核 → nl80211 通过 netlink 将帧交给 supplicant。

supplicant 收到帧后，`driver_nl80211.c` 的事件处理循环通过 `wpa_supplicant_event()` 分发 `EVENT_RX_MGMT` → P2P 管理帧处理函数 `p2p_rx_action_public()` → 根据 P2P Public Action subtype 分发到 `p2p_handle_go_neg_req()`、`p2p_handle_go_neg_resp()` 或 `p2p_handle_go_neg_conf()`。

**MTK 平台**：固件接收 Action Frame → RX 描述符 ring → HIF（硬件接口层）中断 → 软件 RX frame buffer（`SW_RFB`）→ FSM 按帧类型分发 → `p2pFuncGetP2pActionFrameType`（`mgmt/p2p_func.c:8243`）识别 P2P Public Action subtype → `kalP2PIndicateRxMgmtFrame`（`os/linux/gl_p2p_kal.c:1395`）→ `cfg80211_rx_mgmt()` 上抛内核 → 后续 nl80211 → supplicant 路径与 QCOM 完全相同。

双平台在接收侧的分殊在驱动层：QCOM 在 mgmt_txrx 框架内通过 `P2P_EVENT_RX_MGMT` scheduler 消息 → `p2p_process_rx_mgmt` 做了一层分发后上抛；MTK 在 FSM dispatch 和 `p2pFuncGetP2pActionFrameType` 识别后直接通过 `kalP2PIndicateRxMgmtFrame` 上抛。但到了 `cfg80211_rx_mgmt()` 以上，两条路径完全合流——supplicant 不需要知道下面是 QCOM 还是 MTK。

Action 帧的收发有一个常被忽略的细节：`p2p_send_action` 的 `wait_time` 参数（GO Neg Request 中是 500ms）。这不是帧的空中时间（微秒级），而是驱动等待 ACK 的超时。如果 500ms 内没收到 ACK，驱动上报 `P2P_SEND_ACTION_NO_ACK`——supplicant 可以选择重传或回退到 Find 循环。

---

# 8 谈判完成后怎么收口？p2p_go_complete() 打包结果与状态跃迁

三轮握手结束，Confirm 收到，GO 角色确定，信道选定。`p2p_go_complete()` 负责把所有谈判结果打包，触发下一步——Group Formation。

```c
// src/p2p/p2p.c:1857
void p2p_go_complete(struct p2p_data *p2p, struct p2p_device *peer)
{
    struct p2p_go_neg_results res;
    int go = peer->go_state == LOCAL_GO;

    os_memset(&res, 0, sizeof(res));
    res.role_go = go;
    os_memcpy(res.peer_device_addr, peer->info.p2p_device_addr, ETH_ALEN);
    os_memcpy(res.peer_interface_addr, peer->intended_addr, ETH_ALEN);
    res.wps_method = peer->wps_method;

    // Persistent Group 检查
    if (peer->flags & P2P_DEV_PREFER_PERSISTENT_GROUP) {
        if (peer->flags & P2P_DEV_PREFER_PERSISTENT_RECONN)
            res.persistent_group = 2;
        else
            res.persistent_group = 1;
    }

    if (go) {
        // 我是 GO → 准备 AP 模式用于 WPS Provisioning
        res.freq = p2p_channel_to_freq(p2p->op_reg_class, p2p->op_channel);
        os_memcpy(res.ssid, p2p->ssid, p2p->ssid_len);
        res.ssid_len = p2p->ssid_len;
        p2p_random(res.passphrase, p2p->cfg->passphrase_len);
    } else {
        // 我是 Client → 用对方的 Operating Channel
        res.freq = peer->oper_freq;
        if (p2p->ssid_len) {
            os_memcpy(res.ssid, p2p->ssid, p2p->ssid_len);
            res.ssid_len = p2p->ssid_len;
        }
    }

    // 频率列表构建
    p2p_channels_intersect(&p2p->channels, &peer->channels, &intersection);
    if (go)
        p2p_channels_remove_freqs(&intersection, &p2p->no_go_freq);
    p2p_channels_to_freqs(&intersection, res.freq_list, P2P_MAX_CHANNELS);

    // 清理状态
    p2p_clear_timeout(p2p);
    p2p->ssid_set = 0;
    peer->go_neg_req_sent = 0;
    peer->flags &= ~P2P_DEV_PEER_WAITING_RESPONSE;
    peer->wps_method = WPS_NOT_READY;
    peer->oob_pw_id = 0;
    wpabuf_free(peer->go_neg_conf);
    peer->go_neg_conf = NULL;

    p2p_set_state(p2p, P2P_PROVISIONING);  // 进入下一个阶段
    p2p->cfg->go_neg_completed(p2p->cfg->cb_ctx, &res);  // 上抛结果
}
```

`p2p_go_complete()` 做的事归纳为四项：

**打包结果**。`struct p2p_go_neg_results` 包含：GO 角色（`role_go`）、对方设备地址和接口地址、WPS 方法、Persistent Group 类型、工作频率、SSID、passphrase、信道频率列表。这些是 Group Formation 阶段的全部输入参数。

**频率和 SSID 的双向处理**。如果我是 GO——我选频率（`p2p->op_reg_class + op_channel` 在 §5 的十级优先级中选定），生成随机 SSID 和 passphrase。如果我是 Client——频率用对端的 `oper_freq`，SSID 如果已生成（从 Response 的 Group ID 中提取）则保留。

**清理谈判状态**。清 timeout、清等待标记、重置 wps_method、释放 go_neg_conf（Confirm 帧缓存，用于重传）。这些标记在谈判期间保证"同一时刻只能和一个 peer 谈判"，清理后状态机才能接受下一个连接。

**状态转换**。`p2p_set_state(p2p, P2P_PROVISIONING)`——从 P2P_CONNECT/P2P_GO_NEG 进入 P2P_PROVISIONING。这是 P2P 协议状态机的关键跃迁：谈判结束了，但建组还没开始——中间隔着 Provision Discovery + WPS，那是下一篇的故事。

`cfg->go_neg_completed` 回调最终触发 Framework 层的 `P2P_GO_NEGOTIATION_SUCCESS_EVENT`——管理处宣布"谈完了，老大定了，频道定了，现在开始正式建组"。

---

# 9 全链路调用链回顾：从 connect() 到 GO 角色确定

把这一路走完的调用链收拢成一张图。从 App 点"连接"到 supplicant 收口，消息沿两条方向穿过整个协议栈——下行是请求，上行是应答：

```
App: WifiP2pManager.connect()                        // WifiP2pManager.java:2432
  → Binder → P2pStateMachine.InactiveState (CONNECT) // WifiP2pServiceImpl
    → 三层检查通过 → 转入 ProvisionDiscoveryState
      → p2pConnectWithPinDisplay()                    // WifiP2pServiceImpl.java:7543
        → WifiP2pNative.p2pConnect()                  // WifiP2pNative.java:662
          → SupplicantP2pIfaceHalAidlImpl.connect()   // SupplicantP2pIfaceHalAidlImpl.java:828
            → AIDL 跨进程 → P2pIface::connectInternal()  // p2p_iface.cpp:1103
              → wpas_p2p_connect()                    // p2p_supplicant.c:6136
                → p2p_connect()                       // p2p.c:1605
                  → p2p_connect_send()                // p2p_go_neg.c:240
                    → p2p_build_go_neg_req()          // p2p_go_neg.c:138  (8 Attributes)
                      → p2p_send_action()             // p2p.c:5082
                        → nl80211 NL80211_CMD_FRAME → cfg80211 → 驱动 → 固件
```

```
固件发送 Request → 对方处理 → 回 Response → 我方 RX 路径上行：
固件 → cfg80211_rx_mgmt() → nl80211 → wpa_supplicant_event()
  → p2p_rx_action_public() → p2p_rx_p2p_action()      // p2p.c:1923
    → p2p_handle_go_neg_req() / p2p_handle_go_neg_resp()  // p2p_go_neg.c:1148/1539
      → p2p_process_go_neg_req() / p2p_process_go_neg_resp()  // p2p_go_neg.c:823/1264
        → p2p_go_det()                                // p2p_go_neg.c:21  GO 角色决策
        → p2p_go_select_channel() / p2p_reselect_channel()   // p2p_go_neg.c:572/441
        → p2p_build_go_neg_resp() / p2p_build_go_neg_conf()   // p2p_go_neg.c:300/1181
          → p2p_send_action() → 驱动 → 固件
最后：p2p_handle_go_neg_conf() → p2p_go_complete()   // p2p.c:1857
  → cfg->go_neg_completed → P2P_GO_NEGOTIATION_SUCCESS_EVENT
```

两端各看一次这条链，就能看清整篇文章的主干：下行是"条件清单"从 App 一路翻译成 Action 帧的过程——Java 对象 → AIDL 结构体 → C 参数 → 8 个 P2P Attribute；上行是对方应答反向穿过同一管道，每一层把参数剥回自己认识的形态。两条方向在 `p2p_go_det()` 处交汇——它只依赖两个字节（我的意愿 + 对方的最低 1 位），就决定了整场谈判的胜负。角色确定后，`p2p_go_select_channel()` 用十级优先级链选好信道，`p2p_go_complete()` 把全部结果打包上抛。驱动侧（§7）的 QCOM/MTK 双平台差异不影响这条链的逻辑形状——无论走 WMI 还是 mbox，supplicant 看到的都是同一个 `p2p_send_action()` 入口和 `cfg80211_rx_mgmt()` 出口。

---

# 10 老大定了，但他是不是骗子？

本文从 Framework 的 `connect()` 一路追到 `p2p_go_complete()`：管理处接单、传话人委托、谈判桌摆好、三次握手交换条件、GO 决策算法比意愿、十级优先级选信道、驱动 Action 帧在空中完成收发。全程跨越 Java → C → 内核 → 固件四个世界，每层都在做自己最擅长的事。

但这里有个问题——GO Negotiation 只解决了"谁当老大"和"在哪见面"两个问题。它不验证对方的身份，不确认对方的 WPS 能力（只在 GO Neg Request/Response 中交换了 Device Password ID），更不实际建立加密链路。接下来一步，双方需要用 Provision Discovery 确认彼此的 Provisioning 方法，然后通过 WPS 交换凭据——PIN、PBC 按钮、或者 NFC 触碰。这才是真正建立信任的环节。

下一篇，我们从 ProvisionDiscoveryState 开始，追 Provision Discovery + WPS 的完整路径——PIN 怎么输入、EAP-WSC 八轮消息怎么交换、WPS Credential 怎么生成、15 秒超时怎么兜底。相亲角的"验证身份"环节，可比谈判复杂多了。

---

**源码仓库**：

- AOSP wpa_supplicant 8: [https://w1.fi/wpa_supplicant/](https://w1.fi/wpa_supplicant/)
- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- QCOM qcacld-3.0: [https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0](https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0)
- MTK kernel_modules-connectivity-wlan-core-gen4m (MTK 内核模块仓库)

**相关规范**：Wi-Fi Alliance, "Wi-Fi Direct Specification v2.0"
