---
title: P2P（三）设备发现全链路——从发现路由到 Probes 满天飞
top: 1
related_posts: true
abbrlink: 60b4ab3d
date: 2026-09-24 22:16:53
tags:
  - Android WiFi
  - P2P
categories:
  - WiFi
  - Code
---

> 相亲角开门营业了，第一个相亲者走进来说"看看周围有谁"。本文追踪从用户点击到 peer 列表广播的全链路：Framework 把指令传下去，Supplicant 启动 Find 循环（Listen 和 Scan 交替），驱动在社交信道 1/6/11 上发 Probes、收 Probes，P2P IE 名片上写着设备能力和 Listen 信道，最终 peer 名单贴出来给用户看。

---

# 本章导读

相亲角开了。上两篇我们把管理处挂牌、印制名片雇跑腿全部准备好了，系统停在 InactiveState——场地有了、流程有了、人脉有了，就等第一个相亲者走进来。

这个人走进来，对管理处说了一句："看看周围还有谁。"

<!--more-->

这句话在 P2P 的世界里叫 `discoverPeers()`。它的旅程横跨四个代码世界：从 Framework 层的 Java 状态机，经 Binder 到 AIDL，落入 wpa_supplicant 的 C 代码，再由 nl80211 塞进内核，最后驱动在 2.4GHz 的三个社交信道上交替发射 Probe Request、接收 Probe Response。

这不是一次简单的"扫一扫"。P2P 的 Find 循环是一套精心编排的交替机制：Listen 阶段站在自己的摊位上等别人看到自己，Scan 阶段全场转一圈看看别人。两个阶段交替进行——因为物理上你不能同时"等"和"找"。每次 Listen 持续 100-300ms，每次 Scan 覆盖社交信道 + 全信道渐进。整个过程由 120 秒超时兜底，超时了就收工（或者有新发现就提前转去 GO Negotiation）。

本文从 Framework `discoverPeers` 到 peer 列表更新广播 `WIFI_P2P_PEERS_CHANGED_ACTION` 发出。不涉及 connect、GO Negotiation、Provision Discovery、WPS——那些是下一篇的故事。

先看这张全链路分层图，理解 discoverPeers 的指令要穿过哪几层、跨过哪些进程边界，以及 Listen/Scan 交替与 Probe 帧收发在整条链中的位置：

![P2P 设备发现全链路分层架构](assets/11c-P2P%EF%BC%88%E4%B8%89%EF%BC%89%E8%AE%BE%E5%A4%87%E5%8F%91%E7%8E%B0%E5%85%A8%E9%93%BE%E8%B7%AF%E2%80%94%E2%80%94%E4%BB%8E%E5%8F%91%E7%8E%B0%E8%B7%AF%E7%94%B1%E5%88%B0-Probes-%E6%BB%A1%E5%A4%A9%E9%A3%9E/11c-overview.svg)

---

# 1 discoverPeers：一句话怎么穿过四层代码？

相亲角的第一个相亲者走到管理处窗口，说"看看周围有谁"。管理处的人是怎么把这句话传下去、传到哪个跑腿手里、最后变成实际动作的？

这条路由从 App 层 `WifiP2pManager.discoverPeers()` 出发，经过 AsyncChannel 消息投递、P2pStateMachine 状态检查、WifiP2pNative 委托、AIDL 跨进程调用，最终到达 supplicant。每一层都是一个相亲角角色——窗口接待员、流程审核员、传话人、跑腿工。

## 1.1 App 层：WifiP2pManager.discoverPeers

App 开发者的视角很简单：拿一个 Channel，调 `discoverPeers`，等回调。

```java
// packages/modules/Wifi/framework/java/android/net/wifi/p2p/WifiP2pManager.java:2229
@RequiresPermission(allOf = {
        android.Manifest.permission.NEARBY_WIFI_DEVICES,
        android.Manifest.permission.ACCESS_FINE_LOCATION
        }, conditional = true)
public void discoverPeers(Channel channel, ActionListener listener) {
    checkChannel(channel);
    Bundle extras = prepareExtrasBundle(channel);
    channel.mAsyncChannel.sendMessage(prepareMessage(DISCOVER_PEERS, WIFI_P2P_SCAN_FULL,
            channel.putListener(listener), extras, channel.mContext));
}
```

这不只是一句"发个消息"。`prepareMessage(DISCOVER_PEERS, WIFI_P2P_SCAN_FULL, ...)` 构造的 Message 里装了三个东西：消息类型是 `DISCOVER_PEERS`（而不是抽象的"搜索"），扫描类型是 `WIFI_P2P_SCAN_FULL`（全扫描，不是只扫社交信道），以及一个 `ActionListener` 用于成功/失败回调。

这条消息通过 AsyncChannel 丢进 P2pStateMachine 的消息队列——AsyncChannel 是 Android StateMachine 框架的标准通信机制，App 端的 Binder 线程不直接触碰状态机的内部状态，而是把消息投递到 WifiHandlerThread——一条专属于 P2P 状态机的线程。和上篇 P2pEnabledState 那条 SUP_CONNECTION_EVENT 是同一套投递机制：消息从外面来，在状态机线程上串行消费。

这背后还有一个设计意图：App 调 `discoverPeers` 时可能正在 Binder 线程中，而状态机内部维护着共享状态（mPeers、mGroups 等）。如果把 Binder 线程直接接进状态机，要么加锁保护状态（增加死锁风险和性能开销），要么冒着竞态条件修改状态。AsyncChannel + Handler 消息队列的方案天然避免了这个问题——所有状态变更都发生在同一个线程。

## 1.2 状态机路由：InactiveState 收到 DISCOVER_PEERS

消息到达 P2pStateMachine 后，当前活性状态是 InactiveState——相亲角开张了但没人来办事。DISCOVER_PEERS 消息首先送到 `InactiveState.processMessageImpl()`。

在上一篇的结尾，我们停在 InactiveState。这个状态的名字暗示了它的职责：不做任何主动操作，只等待外部命令。而它收到的第一个命令，通常就是 DISCOVER_PEERS。

不过 InactiveState 的 `processMessageImpl` 里其实没有 DISCOVER_PEERS 的 case——它只处理 CONNECT、STOP_DISCOVERY 等少数消息，遇到不认识的 DISCOVER_PEERS 直接返回 NOT_HANDLED。消息顺着状态机层级冒泡到父状态 `P2pEnabledState.processMessageImpl()`（`WifiP2pServiceImpl.java:3310`），由父状态完成业务检查后再真正把指令发下去。

这段"消息先落到子状态、再冒泡给父状态"的机制，是 StateMachine 框架处理未识别消息的默认行为——子状态选择不接单，父状态才会接手。

父状态 `P2pEnabledState.processMessageImpl()` 里真正处理 DISCOVER_PEERS 的 case 长这样：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:3310
case WifiP2pManager.DISCOVER_PEERS: {
    String packageName = getCallingPkgName(message.sendingUid, message.replyTo);
    if (packageName == null) {
        replyToMessage(message, WifiP2pManager.DISCOVER_PEERS_FAILED,
                WifiP2pManager.ERROR);
        break;
    }
    // ... 权限判断（checkCanAccessWifiDirect / checkNearbyDevicesPermission）...
    if (!hasPermission) {
        replyToMessage(message, WifiP2pManager.DISCOVER_PEERS_FAILED,
                WifiP2pManager.ERROR);
        break;
    }
    if (mDiscoveryBlocked) {
        replyToMessage(message, WifiP2pManager.DISCOVER_PEERS_FAILED,
                WifiP2pManager.BUSY);
        break;
    }
    // do not send service discovery request while normal find operation.
    clearSupplicantServiceRequest();
    if (p2pFind(scanType, freq, DISCOVER_TIMEOUT_S, discoveryConfig)) {
        replyToMessage(message, WifiP2pManager.DISCOVER_PEERS_SUCCEEDED);
        sendP2pDiscoveryChangedBroadcast(true);
    } else {
        replyToMessage(message, WifiP2pManager.DISCOVER_PEERS_FAILED,
                WifiP2pManager.ERROR);
    }
    break;
}
```

注意这个 case 里的两个细节：其一，真正下发的调用是 `p2pFind(scanType, freq, DISCOVER_TIMEOUT_S, discoveryConfig)`，其中 `DISCOVER_TIMEOUT_S = 120`（`WifiP2pServiceImpl.java:293`）——这正是下文的 120 秒营业时间来源；其二，`mDiscoveryBlocked` 检查返回 `BUSY`，对应下文要讲的三个错误码之一。

父状态在处理 DISCOVER_PEERS 时做两层业务检查：

1. **P2P 已启用？** 如果设备根本不支持 P2P，状态机停在 P2pNotSupportedState，DISCOVER_PEERS 直接返回 P2P_UNSUPPORTED；如果 P2P 只是暂时被禁用（比如软 AP 占用），停在 P2pDisabledState，会先尝试重新启用 P2P 接口——相亲角没开门时，管理处先看看能不能开门再接客。这条检查是状态机层级隐式保证的：只有 P2P 启用后，P2pEnabledState 的子树才是活性状态。
2. **不在 Group 中？** 如果设备已经在 P2P Group 中（比如正在做 Group Owner），它处于 GroupCreatedState，同样不在 InactiveState 这条流程里——你已经在"约会"了，不会走进"等着接单"的窗口。这条也是状态结构保证的，不需要显式 if 判断。

这些检查失败的最终去向都是同一个：以 `DISCOVER_PEERS_FAILED` 消息带错误码回到 App 的 `ActionListener.onFailure()`。错误码有三个——设备不支持 P2P 时是 `P2P_UNSUPPORTED`（`WifiP2pManager.java:953`，值 1）；supplicant 的 AIDL 服务没连上（比如守护进程还没起来，`SupplicantP2pIfaceHal.find()` 走 `handleNullHal()`（`SupplicantP2pIfaceHal.java:1134`）返回 false）或其它内部错误是 `ERROR`（`:947`，值 0）；P2P 被临时占用（比如正在建组）是 `BUSY`（`:960`，值 2）。

三个错误码对应三种不同的"为什么逛不了"，App 可以在 `onFailure` 里据此区分提示。

这两层之外，Framework 层并不拦截重复的 `discoverPeers`：`mDiscoveryStarted` 标志（`:392`）只用于广播 Discovery 启动/停止状态，DISCOVER_PEERS 路径不读它。连续快速调用两次 `discoverPeers`，Framework 会把第二条指令照常发下去。

真正的去重在更下层：supplicant 的 `p2p_find` 发现 `p2p_scan_running` 就置 `find_pending_full` 合并请求（`p2p.c:1316`），驱动扫描再经序列化排队。这套"Framework 不拦、supplicant 合并、驱动排队"的三层防线，§5.2 的 scan_req_id 小节会展开细讲。

检查通过后，父状态调用 `WifiP2pServiceImpl.p2pFind(timeout=120)`——注意这里的 120 秒超时，不是 0（无限）。相亲市场不是 24 小时营业的，它有规定营业时间。120 秒后如果还没找到任何人，管理处就收工打烊。

## 1.3 传话人：WifiP2pNative.p2pFind

`WifiP2pServiceImpl.p2pFind()` 内部是一个多分支的委托函数，根据扫描类型选择不同的 Native 调用：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java:8576
private boolean p2pFind(int timeout) {
    return p2pFind(
            WifiP2pManager.WIFI_P2P_SCAN_FULL,
            WifiP2pManager.WIFI_P2P_SCAN_FREQ_UNSPECIFIED, timeout, null);
}

private boolean p2pFind(@WifiP2pManager.WifiP2pScanType int scanType, int freq,
                        int timeout, @Nullable WifiP2pDiscoveryConfig discoveryConfig) {
    // ... vendor elements setup omitted ...
    if (scanType == WifiP2pManager.WIFI_P2P_SCAN_FULL) {
        return mWifiNative.p2pFind(timeout);
    } else if (scanType == WifiP2pManager.WIFI_P2P_SCAN_SOCIAL
            && freq == WifiP2pManager.WIFI_P2P_SCAN_FREQ_UNSPECIFIED) {
        return mWifiNative.p2pFind(scanType, freq, timeout);
    } else if (scanType == WifiP2pManager.WIFI_P2P_SCAN_SINGLE_FREQ
            && freq != WifiP2pManager.WIFI_P2P_SCAN_FREQ_UNSPECIFIED) {
        return mWifiNative.p2pFind(scanType, freq, timeout);
    } else if (scanType == WifiP2pManager.WIFI_P2P_SCAN_WITH_CONFIG_PARAMS
            && discoveryConfig != null) {
        return mWifiNative.p2pFindWithParams(discoveryConfig, timeout);
    }
    return false;
}
```

四种扫描类型对应四种相亲策略：FULL 是"全场逛"（社交信道 + 其他信道），SOCIAL 是"只逛热门地段"（仅 1/6/11），SINGLE_FREQ 是"指定一个信道蹲守"，WITH_CONFIG_PARAMS 是"带着特别要求去逛"。`discoverPeers()` 默认走 FULL——最全面，但最费时间。

`WifiP2pNative.p2pFind(int timeout)` 做的是最后一步转发：

```java
// packages/modules/Wifi/service/java/com/android/server/wifi/p2p/WifiP2pNative.java:536
public boolean p2pFind(int timeout) {
    return mSupplicantP2pIfaceHal.find(timeout);
}
```

`mSupplicantP2pIfaceHal` 是什么？它是 `SupplicantP2pIfaceHal`——对 `ISupplicantP2pIface` AIDL 接口的 HAL 层封装。AIDL 调用 `find(int timeout)` 跨进程到达 wpa_supplicant 守护进程的 AIDL 服务实现——`P2pIface::find`（`p2p_iface.cpp:371`）先经 `validateAndCall` 校验接口有效性，再转调内部实现 `P2pIface::findInternal`（定义于 `:1058`），后者才真正调用 `wpas_p2p_find()` 并传入 `P2P_FIND_START_WITH_FULL`（§2.2 会展开）。

至此，Java 世界的工作结束，"逛市场"的指令已经送到了跑腿工（supplicant）手里。

在相亲角的比喻中：窗口接待员（WifiP2pManager）接了单，流程审核员（InactiveState）确认可以接单，传话人（WifiP2pNative）把指令通过电话（AIDL）传给下面的跑腿工（supplicant）。

## 1.4 监听线：WifiP2pMonitor 同时启动

指令下发的同时，管理处还要把"监听线"拉起来——WifiP2pMonitor 开始监听 supplicant 回调的 P2P 事件。在 P2P 发现过程中，最关键的两个事件是：

- **P2P-DEVICE-FOUND**：跑腿工说"发现一个人"，带着设备信息（MAC 地址、设备名、能力）。
- **P2P-FIND-STOPPED**：跑腿工说"逛完了/时间到了"，Find 循环结束。

这些事件通过 AIDL callback 反向传回 Framework：supplicant → `ISupplicantP2pIfaceCallback` → `SupplicantP2pIfaceHal` → `WifiP2pMonitor` → `P2pStateMachine`。WifiP2pMonitor 的 23 个事件类型 handler 注册表在《P2P（一）初始化（上）》§4.9 已完整列出，这里不再重复——只需记住 P2P-DEVICE-FOUND 和 P2P-FIND-STOPPED 是其中两个。

这条反向通道的机制和正向调用是对称的，但方向相反——正向是 Framework "喊" supplicant 做事情，反向是 supplicant "报" Framework 出结果。相亲角管理处不只单向派活，还开着电话听跑腿工随时汇报。

AIDL `find()` 调用已下发，supplicant 开始工作。

---

# 2 wpas_p2p_find 接到任务后，先检查什么？

AIDL `ISupplicantP2pIface.find(timeout)` 到达 wpa_supplicant 后，调用链串起来：AIDL stub → `p2p_iface.cpp` 服务实现 → `wpas_p2p_find()`。这个函数是 P2P Find 在 supplicant 侧的入口——跑腿工打开笔记本，核对任务清单。

从 §1 的正向调用链看，`WifiP2pNative.p2pFind` → `SupplicantP2pIfaceHal.find` → AIDL `ISupplicantP2pIface.find` 这条线已经把 timeout=120 的参数精准送到了 supplicant 门口。现在关键是：supplicant 拿到这个参数后，接不接这单活？

## 2.1 入口与前置检查

`wpas_p2p_find()` 的入口不急着派单，它先清掉可能残留的 action TX 等待、确认三道前置条件都满足，再取消定时后台扫描：

```c
// wpa_supplicant/p2p_supplicant.c:7641
int wpas_p2p_find(struct wpa_supplicant *wpa_s, unsigned int timeout,
                  enum p2p_discovery_type type,
                  unsigned int num_req_dev_types, const u8 *req_dev_types,
                  const u8 *dev_id, unsigned int search_delay,
                  u8 seek_cnt, const char **seek_string, int freq,
                  bool include_6ghz)
{
    wpas_p2p_clear_pending_action_tx(wpa_s, false);
    wpa_s->global->p2p_long_listen = 0;

    if (wpa_s->global->p2p_disabled || wpa_s->global->p2p == NULL ||
        wpa_s->p2p_in_provisioning) {
        wpa_dbg(wpa_s, MSG_DEBUG, "P2P: Reject p2p_find operation%s%s",
                (wpa_s->global->p2p_disabled || !wpa_s->global->p2p) ?
                " (P2P disabled)" : "",
                wpa_s->p2p_in_provisioning ?
                " (p2p_in_provisioning)" : "");
        return -1;
    }

    wpa_supplicant_cancel_sched_scan(wpa_s);

    return p2p_find(wpa_s->global->p2p, timeout, type,
                    num_req_dev_types, req_dev_types, dev_id,
                    search_delay, seek_cnt, seek_string, freq,
                    include_6ghz);
}
```

跑腿工的第一件事不是立刻出门逛，而是先确认三件事：

1. **P2P 模块没被禁用**（`p2p_disabled`）：配置文件中可以显式禁用 P2P，即使 STA 模式正常使用。
2. **P2P 模块已初始化**（`p2p == NULL`）：如果 wpas_p2p_init() 没成功，就没有 p2p_data 结构体，逛不了。
3. **不在 Provisioning 中**（`p2p_in_provisioning`）：如果正在进行 WPS 配网——相当于另一个相亲者正在填表格办手续——不能同时开始新的 Find。

这三道检查和在 Framework 层的 InactiveState 检查形成了双重防护：Framework 做了业务层面的前置判断（"现在是合适的时机吗"），supplicant 做了技术层面的守卫（"底层状态允许吗"）。两边任何一边拒绝，Find 都不会启动。

确认一切正常后，`wpa_supplicant_cancel_sched_scan(wpa_s)` 取消了正在进行的定时后台扫描（如果有的话）。P2P Find 和 STA 扫描共享硬件——二者不能同时进行，必须先取消掉 STA 的扫描再开始 P2P Find。这个取消动作很快，但很关键：如果后台扫描正在执行，驱动已经在某个信道上停留，P2P 的 Listen 就发不了 Probe Response，等于别人到了你的摊位前却看不到你。

最后，`return p2p_find(wpa_s->global->p2p, timeout, type, ...)`——所有参数透传，进入 P2P 核心模块。

## 2.2 p2p_find：相亲市场正式开市

`p2p_find()` 是 src/p2p/p2p.c 的核心函数，P2P Find 循环的调度中心。它的工作分为三步：清场、设参、开市。

```c
// src/p2p/p2p.c:1181-1259 (清场 + 设参段)
int p2p_find(struct p2p_data *p2p, unsigned int timeout,
             enum p2p_discovery_type type, ...)
{
    p2p_dbg(p2p, "Starting find (type=%d)", type);
    // ... 复制 req_dev_types、dev_id 到 p2p_data ...

    p2p->start_after_scan = P2P_AFTER_SCAN_NOTHING;
    p2p_clear_timeout(p2p);
    if (p2p->pending_listen_freq) {
        p2p->pending_listen_freq = 0;
    }
    p2p->cfg->stop_listen(p2p->cfg->cb_ctx);
    p2p->pending_listen_wait_drv = false;
    p2p->find_pending_full = 0;
    p2p->find_type = type;
    p2p_device_clear_reported(p2p);
    p2p_set_state(p2p, P2P_SEARCH);
    p2p->search_delay = search_delay;
    p2p->in_search_delay = 0;
    eloop_cancel_timeout(p2p_find_timeout, p2p, NULL);
    p2p->last_p2p_find_timeout = timeout;
    if (timeout)
        eloop_register_timeout(timeout, 0, p2p_find_timeout, p2p, NULL);
    // ... 下文继续首次扫描 ...
```

清场和设参完成后，根据 `type` 启动首次扫描：

```c
// src/p2p/p2p.c:1276-1306 (首次扫描段)
    os_get_reltime(&start);
    switch (type) {
    case P2P_FIND_START_WITH_FULL:
        if (freq > 0) {
            res = p2p->cfg->p2p_scan(p2p->cfg->cb_ctx,
                         P2P_SCAN_SPECIFIC, freq, ...);
            break;
        }
        // fall through
    case P2P_FIND_PROGRESSIVE:
        res = p2p->cfg->p2p_scan(p2p->cfg->cb_ctx,
                     P2P_SCAN_FULL, 0, ...);
        break;
    case P2P_FIND_ONLY_SOCIAL:
        res = p2p->cfg->p2p_scan(p2p->cfg->cb_ctx,
                     P2P_SCAN_SOCIAL, 0, ...);
        break;
    default:
        return -1;
    }

    if (!res)
        p2p->find_start = start;

    if (res != 0 && p2p->p2p_scan_running) {
        // 已有扫描在运行，等它完成后再补全扫描
        if (type == P2P_FIND_PROGRESSIVE || ...)
            p2p->find_pending_full = 1;
        res = 0;
    } else if (res != 0) {
        p2p_set_state(p2p, P2P_IDLE);
        eloop_cancel_timeout(p2p_find_timeout, p2p, NULL);
    }
    return res;
}
```

我们逐段拆解。

**清场**：`p2p->start_after_scan = P2P_AFTER_SCAN_NOTHING`——这个赋值告诉状态机：当前没有任何"扫描结束后要做什么"的计划。如果有上一次 Find 操作残留的 pending listen，全部清掉。`p2p->cfg->stop_listen()` 通知驱动停止当前的 Listen 状态（NL80211_CMD_CANCEL_REMAIN_ON_CHANNEL）。`p2p_device_clear_reported(p2p)` 把上一轮发现过的设备标记清掉——新的一轮 Find，所有设备都有可能重新被发现。

**设参**：`p2p->find_type = type` 决定了 Find 的模式——`P2P_FIND_PROGRESSIVE`（渐进式，首轮全信道扫描，后续在社交信道之外逐次加一个渐进信道），`P2P_FIND_START_WITH_FULL`（先全扫一轮，后续只扫社交信道，除非指定了 `find_specified_freq`），或 `P2P_FIND_ONLY_SOCIAL`（只扫社交信道）。

Android 的 AIDL `find()` 默认走 `P2P_FIND_START_WITH_FULL`（`p2p_iface.cpp` 的 `findInternal` 传入）。

**开市**：`p2p_set_state(p2p, P2P_SEARCH)`——状态从 IDLE 变为 SEARCH，标志着 Find 循环正式开始。`eloop_register_timeout(timeout, 0, p2p_find_timeout, p2p, NULL)` 注册了总超时定时器——120 秒后，如果没人喊停，`p2p_find_timeout()` 自动调用 `p2p_stop_find()`。

有个容易漏掉的细节：`p2p_find()` 本身发起的是**Scan**（不是 Listen）。函数末尾的 switch 语句根据 `type` 调用 `p2p->cfg->p2p_scan()`——这意味着 Find 循环的**第一个阶段总是 Scan**。为什么不是先 Listen？**因为 Android 默认的 `P2P_FIND_START_WITH_FULL` 先把全信道扫一遍，看看周围有没有人，扫完再回到 Listen 阶段等别人来看我**。如果扫完没发现，Listen 结束后继续扫——循环交替。

`p2p->find_specified_freq` 有个值得注意的判断：如果是 2412、2437、2462（社交信道的中心频率）或 60480（6GHz PSC），就清成 0——因为这些已经是社交信道的默认覆盖范围，不需要额外指定。这个判断在后面的 Search 阶段决定了扫描范围是从频段头扫到尾（全信道），还是额外加一个非社交信道。

---

# 3 Find 循环：为什么不能同时 Listen 和 Scan？

`p2p_find()` 的状态机启动了 P2P_SEARCH，但这只是开了一个总循环。真正的发现工作由两个阶段交替完成——Listen 和 Scan。

这两个阶段交替的频率、时长、内容都有讲究。

## 3.1 为什么是 Listen ⇄ Scan 交替，不能同时做？

P2P 设备在一个信道上 Listen 时，意味着它把射频调到了这个信道的频率，只能在这个频率上接收和发送。如果要 Scan 其他信道，必须切换频率——而切换频率需要时间（通常在几 ms 到几十 ms 之间）。如果你在 Listen 的间歇去其他信道扫一瞥，就可能错过别人发给你的 Probe Request。

因此，标准的 Wi-Fi Alliance P2P 规范定义了 Find Phase 的交替模型：一段时间用于 Listen（等别人发现你），一段时间用于 Search（你去发现别人）。这两个阶段永远不重叠——单工操作，和 Walkie-Talkie 对讲机的原理一样：你不能同时按下"发"和"收"。

相亲角比喻里：一个人不能同时站在自己摊位前等别人上门，又在全场转悠找别人。他只能做一件：站一会儿，逛一会儿，再站一会儿，再逛一会儿。

有个值得追问的问题：如果硬件支持 DBS（Dual Band Simultaneous，双频同时），能不能两个阶段一起做——一个射频蹲在 2.4GHz 社交信道 Listen，另一个射频同时去 Scan？答案是 P2P 协议层没有为 DBS 开这个口子。`p2p_find()` 的代码里没有任何 DBS 感知的分支——它不检查硬件有没有第二个射频，而是无条件按 Listen⇄Scan 交替推进。

原因在协议本身：Wi-Fi Direct 的 Find Phase 把「我什么时候出现在社交信道上」定义为可预期的——设备 A 在信道 6 上等 200ms，设备 B 知道在这个窗口里发 Probe Request 能找到 A。如果 A 用 DBS 同时去 Scan 别处，它的 Listen 窗口就不会那么纯粹，别的设备就失去了「你一定会在这段时间、这个信道上等我」的确定性。所以交替模型是协议层的设计约束，不是单纯受制于单射频硬件。

DBS 的价值体现在另一个维度：它让 STA 和 P2P 并发（比如 2.4GHz 跑 P2P Find、5GHz 同时连着家里的路由器），而不是让一个 P2P Find 内部的两个阶段同时做。这对应 P2P Capability 里的 Concurrent Operation bit——`cfg->concurrent_operations` 置位时 `p2p->dev_capab |= P2P_DEV_CAPAB_CONCURRENT_OPER`（`p2p.c:3093`）。

驱动侧 QCOM 也确实感知 DBS：`p2p_scan_start()` 里用 `policy_mgr_is_hw_dbs_capable()` 判断硬件能力（`wlan_p2p_roc.c:141`），据此放宽 ROC 最大时长——因为 DBS 下 2.4GHz P2P 和 5GHz STA 可以同时工作，不需要互相让路。但那是共存调优，不改变 Listen⇄Scan 的交替结构本身。

这种交替机制在代码里的核心驱动力是一个回调链：Listen 结束 → 驱动通知 supplicant → supplicant 调 `p2p_search()` → Scan 结束 → 驱动通知 supplicant → supplicant 调 `p2p_listen_in_find()` → 循环。

如果你把这个回调链画成时序图，就是两个相互触发的函数在两两接力。`p2p_listen_in_find` 注册了一个回调"等我完事了开始 scan"，`p2p_search` 提交扫描后又等驱动回调"扫描完了继续 find"。两边的终点互相指向对方的起点，链条就是靠这两个"钩子"扣起来的。

## 3.2 Listen 阶段：站在摊位前，让别人看到自己

Listen 阶段的核心函数是 `p2p_listen_in_find()`：

```c
// src/p2p/p2p.c:258
static void p2p_listen_in_find(struct p2p_data *p2p, int dev_disc)
{
    unsigned int r, tu;
    int freq;
    struct wpabuf *ies;

    freq = p2p_channel_to_freq(p2p->cfg->reg_class, p2p->cfg->channel);
    if (freq < 0) {
        p2p_dbg(p2p, "Unknown regulatory class/channel");
        return;
    }

    if (os_get_random((u8 *) &r, sizeof(r)) < 0)
        r = 0;
    tu = (r % ((p2p->max_disc_int - p2p->min_disc_int) + 1) +
          p2p->min_disc_int) * 100;
    // ... tu 上限限制 ...
    if (!dev_disc && tu < 100)
        tu = 100;

    ies = p2p_build_probe_resp_ies(p2p, NULL, 0);
    if (ies == NULL)
        return;

    p2p->pending_listen_freq = freq;
    p2p->pending_listen_sec = 0;
    p2p->pending_listen_usec = 1024 * tu;

    if (p2p->cfg->start_listen(p2p->cfg->cb_ctx, freq, 1024 * tu / 1000,
            ies) < 0) {
        p2p_dbg(p2p, "Failed to start listen mode");
        p2p->pending_listen_freq = 0;
    } else {
        p2p->pending_listen_wait_drv = true;
    }
    wpabuf_free(ies);
}
```

这个函数做了五件事：

1. **算频率**：`p2p_channel_to_freq(reg_class, channel)` 把 supplicant 的 regulatory class + channel number 转成实际频率 MHz。对于 2.4GHz 社交信道 1/6/11，频率分别是 2412/2437/2462 MHz。Listen 的具体信道是之前 P2P 初始化时选择好的——通常是社交信道之一。

2. **随机 Listen 时长**：`tu = (r % ((p2p->max_disc_int - p2p->min_disc_int) + 1) + p2p->min_disc_int) * 100`——在 min_disc_int 和 max_disc_int 之间随机取一个值，乘以 100（TU 单位，1 TU = 1024μs）。Android 的默认值 min_disc_int=1, max_disc_int=3，所以每次 Listen 持续 100-300ms（换算成物理时间约 102-307ms）。

   这个随机化避免了两个同时启动 Find 的设备永远撞车——如果两台手机都在整 300ms 时切换 Scan，它们永远碰不到对方。

   「随机整数 × 100 TU」这个模型不是 supplicant 自创，而是 Wi-Fi Direct 规范 Find Phase 的原样规定（v2.0 §3.1.2.1.3）：Listen 时长必须是 100 TU 的随机整数倍，且落在 [minDiscoverableInterval, maxDiscoverableInterval] 区间内，规范默认值正是 3 和 1——supplicant 的 `min_disc_int=1, max_disc_int=3` 就是照抄这两个规范参数。

   随机化的设计意图也在规范里点明：避免两台设备进入「锁步」（lock-step）——如果两边都以固定节奏交替，它们在相同的时间点切换、永远碰不到面。至于上下限为什么取 1 和 3（即 100-300ms），规范没有给推导，一个合理的工程直觉是：下限 100 TU 保证一轮 Listen 至少能覆盖对端一次 Scan 在同一信道的停留时间，上限 300 TU 则避免单轮 Listen 拖太长、挤压本机自己的 Scan 频率。

3. **构建 Probe Response IE**：`p2p_build_probe_resp_ies(p2p, NULL, 0)` 构建了 Listen 阶段在回应别人 Probe Request 时要携带的 P2P IE + WSC IE——名片的详细内容，第 4 节展开。

4. **下发到驱动**：`p2p->cfg->start_listen(cb_ctx, freq, duration, ies)`——这个回调最终在 driver_nl80211 中变成 `NL80211_CMD_REMAIN_ON_CHANNEL`，告诉内核和驱动："在这个频率停一段时间"。Listen 的持续时间在 100-300ms 之间（由第 2 步随机算出）。

5. **标记状态**：`p2p->pending_listen_wait_drv = true`——告诉状态机"驱动正在执行 Listen，等着它完成的通知"。

Listen 不等于"什么都不做，开着收音机等人在这个信道发 Probe Request"。实际上，当别人在这个信道上 Scan 并发出 Probe Request 时，Listen 中的设备会构造 Probe Response 帧回过去。这个 Probe Response 里带上了 P2P IE，告诉对方"我是 P2P 设备，我支持这些能力，我的 Listen 信道是 X"。

Listen 结束后，驱动通过 `NL80211_CMD_REMAIN_ON_CHANNEL` 的完成事件通知 supplicant：`wpas_p2p_cancel_remain_on_channel_cb`（`p2p_supplicant.c:6348`）收到过期事件后调 `p2p_listen_end()`（`p2p.c:3981`）——它发现当前状态仍是 P2P_SEARCH，就直接调 `p2p_search()`（`p2p.c:4041`）提交下一轮扫描。Listen 到 Search 的切换由这两个函数直接接力，并不经过 `p2p_continue_find`。

那 `start_after_scan` 是干什么的？它的用途是「扫描进行中，新来的动作先挂起」。`p2p_find` 清场时把它置为 `P2P_AFTER_SCAN_NOTHING`（`p2p.c:1251`）；当扫描正在跑、此时来了一个 `p2p_listen()` 或 `p2p_connect()` 请求，它们无法立刻执行（射频被扫描占用），就先把 `start_after_scan` 置成 `P2P_AFTER_SCAN_LISTEN`（`p2p.c:343`）或 `P2P_AFTER_SCAN_CONNECT`（`p2p.c:1703`），等当前扫描结束、`p2p_run_after_scan()`（`p2p.c:1093`）被调起时再补执行。

它处理的是「扫描期间来了新请求」的延迟，不是 Find 循环自身的 Listen/Search 交替节奏——交替由 `p2p_listen_end`/`p2p_scan_res_handled` 这两个结果回调直接驱动。

## 3.3 Scan 阶段：全场转一圈，递名片

Scan 阶段的入口是 `p2p_search()`：

```c
// src/p2p/p2p.c:1028
static void p2p_search(struct p2p_data *p2p)
{
    int freq = 0;
    enum p2p_scan_type type;
    u16 pw_id = DEV_PW_DEFAULT;
    int res;

    if (p2p->drv_in_listen) {
        p2p_dbg(p2p, "Driver is still in Listen state - "
                "wait for it to end before continuing");
        return;
    }
    p2p->cfg->stop_listen(p2p->cfg->cb_ctx);
    p2p->pending_listen_wait_drv = false;

    if (p2p->find_pending_full &&
        (p2p->find_type == P2P_FIND_PROGRESSIVE ||
         p2p->find_type == P2P_FIND_START_WITH_FULL)) {
        type = P2P_SCAN_FULL;
        p2p->find_pending_full = 0;
    } else if ((p2p->find_type == P2P_FIND_PROGRESSIVE &&
        (freq = p2p_get_next_prog_freq(p2p)) > 0) ||
        (p2p->find_type == P2P_FIND_START_WITH_FULL &&
         (freq = p2p->find_specified_freq) > 0)) {
        type = P2P_SCAN_SOCIAL_PLUS_ONE;
    } else {
        type = P2P_SCAN_SOCIAL;
    }

    res = p2p->cfg->p2p_scan(p2p->cfg->cb_ctx, type, freq,
                             p2p->num_req_dev_types, p2p->req_dev_types,
                             p2p->find_dev_id, pw_id, p2p->include_6ghz);
}
```

这段代码的核心逻辑是决定"扫哪些信道"——有三种策略：

- **P2P_SCAN_SOCIAL**：只扫社交信道 1/6/11。最快，但可能漏掉不在社交信道上 Listen 的设备。
- **P2P_SCAN_SOCIAL_PLUS_ONE**：扫社交信道 + 一个非社交信道（`p2p_get_next_prog_freq()` 返回）。渐进式 Find 的第二轮开始用这个——不遗漏在非社交信道上 Listen 的设备。
- **P2P_SCAN_FULL**：全频段扫描（2.4GHz 全部信道 + 5GHz 可选）。最全面，但最慢。只在第一次或用户显式要求 FULL 扫描时使用。

渐进式 Find（`P2P_FIND_PROGRESSIVE`）的策略是：第一轮全信道扫描（发现社交信道和非社交信道的所有设备），后续轮次只扫社交信道 + 渐进频段。这样做得了一个平衡：首轮全面覆盖，后续快速轮询，不浪费时间去扫大概率没人的信道。

`p2p->cfg->p2p_scan(cb_ctx, type, freq, ...)` 回调在 driver_nl80211 中实现——最终通过 `NL80211_CMD_TRIGGER_SCAN` 下发扫描参数到内核，包含频率列表、SSID 列表、IE 等。和 STA 扫描用的是同一个 nl80211 命令，只是参数不同——P2P 扫描的 Probe Request 里嵌入了 P2P IE + WSC IE，让收到 Probe Request 的 P2P 设备知道"这是 P2P 发现请求，不是普通 WiFi 扫描"。

那这些 Probe Request 发出去时用的源 MAC 是谁？答案是 P2P Device 接口自身的 MAC，不是每轮扫描现换的。

`wpas_p2p_scan()`（`p2p_supplicant.c:424`）只设置 SSID 和 P2P IE，不碰任何随机化参数；nl80211 驱动下发 `NL80211_CMD_TRIGGER_SCAN` 时（`wpa_driver_nl80211_scan()`，`driver_nl80211_scan.c:357`），`nl80211_scan_common()` 只有在 `mac_addr_rand` 置位时才带上 `NL80211_SCAN_FLAG_RANDOM_ADDR`（`:281`），P2P Find 路径没置这个标志，内核就用接口自身的 MAC 发帧——也就是 `p2p->dev_addr`（初始化时等于 `wpa_s->own_addr`，`p2p_supplicant.c:5054`）。

所以 P2P 的 MAC 随机化是"接口级"而非"逐帧级"：`wpas_p2p_mac_setup()`（`p2p_supplicant.c:4926`）在 P2P 初始化时按配置项 `p2p_device_random_mac_addr` / `p2p_interface_random_mac_addr`（`config.c:5495/5497`，默认 0）决定是否把整个 Device/Group 接口换成随机 MAC；Android 厂商要开启 P2P 地址随机化，是通过 overlay 注入这两个参数，而不是让每次 Find 换一个地址。

Scan 结束后，驱动通过 `NL80211_CMD_SCAN_RESULTS` 或类似事件通知 supplicant。结果处理在 `wpas_p2p_scan_res_handler()` 中完成——解析收到的 Probe Response 中的 P2P IE，提取设备信息。

## 3.4 社交信道 1/6/11：相亲角的"三大热门地段"

社交信道（Social Channels）是 2.4GHz 频段的信道 1（2412MHz）、信道 6（2437MHz）、信道 11（2462MHz）。为什么只在这三个信道上 Listen？为什么不把全部 11/13/14 个信道都用上？

这是一个协议层面的设计决策，而不是硬件限制：

1. **互不重叠**：在 20MHz 信道宽度的 2.4GHz 频段中，信道 1、6、11 是唯一三组互不重叠的信道——相邻信道（如 1 和 2）的频谱有重叠，会导致互干扰。选这三个信道确保了各设备 Listen 时不会互相干扰。

2. **集中发现**：如果每个设备可以在任意信道上 Listen，Scan 阶段就要扫遍 2.4GHz 全部 11+ 个信道——假设每个信道停留 30ms，一轮就要 330ms+。限制在三个信道，Scan 时间大大缩短，设备发现效率大幅提高。你想象一下相亲角的场景：如果有 11 条街每条街上都可能有摊位，你要逛 11 条街才能确定有没有人。如果规定摊位只能摆在第 1、6、11 条街上，你只需要逛 3 条街就能覆盖所有人。

3. **全球通用**：信道 1、6、11 在全球几乎所有 regulatory domain 都可用（不像信道 12/13/14 在某些国家受限）。这个全球可用性对 P2P 的跨设备发现至关重要——两个不同国家的设备在同一个社交信道上相遇，不需要关心对方国家的频谱管制。

这三条理由的背后还有一个几何事实：信道 1/6/11 的中心频率分别是 2412/2437/2462 MHz，彼此间隔正好 25 MHz——而 20 MHz 信道宽度意味着频谱上相邻的信道（如 1 和 2）必然重叠。1、6、11 是 2.4GHz 频段上**仅有的**三组互不重叠的 20 MHz 信道，且分布在这段频谱的两端和正中：信道 1 贴着 2.4GHz 的下边缘，信道 11 靠近上边缘，信道 6 居中。选择它们不是随机挑三个数字，而是把「能同时容下最多互不干扰设备的信道集合」恰好就是这三个。

这个几何约束也解释了为什么社交信道不用 5GHz 的信道：2.4GHz 频段窄（约 83 MHz），信道 1/6/11 能以 25 MHz 间距排布；5GHz 频段宽（UNII 各段几百 MHz），如果也在 5GHz 定义社交信道，频段内设备会散落得更开，发现效率反而不如三个「约定俗成的摊位」。

如果设备支持 5GHz Listen，信道选择算法确实会变。supplicant 的默认 Listen 信道是随机从社交信道里挑一个：`channel = 1 + (r % 3) * 5`（`p2p_supplicant.c:8368`），只会落在 1/6/11 上。

但完整的多频段信道选择优先级定义在 `p2p_prepare_channel_best()`（`p2p.c:1446`）：best_freq_overall（历史最优频点）→ best_freq_5（5GHz 最优）→ best_freq_24（2.4GHz 最优）→ pref_chan（配置偏好）→ EDMG → 6GHz → VHT → HT40 → 5GHz 操作类 → 预配置信道 → 最后才兜底到随机社交信道（`p2p_channel_random_social()`，`p2p_utils.c:415`，只在 1/6/11 和 60GHz 信道 2 里随机）。这个优先级链的含义是：能选 5GHz 就优先 5GHz，社交信道是发现阶段的默认兜底，而不是唯一选择。

Probe Request 的发送不限于这三个信道——Scan 阶段可以扫全信道（12+ 个信道），因为有些设备可能不在社交信道上 Listen（比如正在进行 STA 连接，被迫 stay on AP channel）。但 P2P 规范要求所有 P2P 设备在 Find 阶段的 Listen 部分至少出现在社交信道之一。

有一种特殊情况叫"concurrent operation"——设备在做 P2P GO 时，没有独立的 Listen 信道，它和客户端关联的操作信道就是它唯一露面的地方。这就是为什么渐进式扫描不永远只扫社交信道——如果有设备在非社交信道上开了一个 Group，你不在那个信道上扫就发现不了它。

## 3.5 交替驱动：p2p_continue_find 的循环引擎

Listen 结束 → Search 开始 → Search 结束 → 谁来决定下一步？答案是 `p2p_continue_find()`：

```c
// src/p2p/p2p.c:3369
void p2p_continue_find(struct p2p_data *p2p)
{
    struct p2p_device *dev;
    int found, res;

    p2p_set_state(p2p, P2P_SEARCH);

    /* Continue from the device following the last iteration */
    found = 0;
    dl_list_for_each(dev, &p2p->devices, struct p2p_device, list) {
        if (dev == p2p->last_p2p_find_oper) {
            found = 1;
            continue;
        }
        if (!found)
            continue;
        res = p2p_pre_find_operation(p2p, dev);
        if (res > 0) {
            p2p->last_p2p_find_oper = dev;
            return;
        }
        if (res == -2)
            goto skip_sd;
    }
    // ... wrap around to beginning ...

skip_sd:
    os_memset(p2p->sd_query_no_ack, 0, ETH_ALEN);
    p2p_listen_in_find(p2p, 1);
}
```

`p2p_continue_find` 被调用的时机是：Scan 结果处理完毕——supplicant 的 `wpas_p2p_scan_res_handler()`（`p2p_supplicant.c:278`）把收到的 Probe Response 逐条解析、加入 `p2p->devices` 后，再经 `wpas_p2p_scan_res_handled()` 转调核心层的 `p2p_scan_res_handled()`（`p2p.c:3641`），它发现状态还是 P2P_SEARCH，就调 `p2p_continue_find()`（`p2p.c:3657`）从 Search 转入下一个动作。

注意这里不是状态机超时事件在驱动——`p2p_state_timeout`（`p2p.c:4238`）在 P2P_SEARCH 状态下确实也会被注册，但它的作用是补扫：如果上一轮 Scan 因为 `search_delay` 被推迟，超时事件就调 `p2p_search()`（`p2p.c:4270`）把扫描补上，而不是调 continue_find。两者分工：扫描结果正常回来走 `p2p_scan_res_handled → continue_find`，扫描迟迟没启动才靠超时事件兜底。

它的核心逻辑分两层：

- **如果还有 Service Discovery 要做**：遍历 devices 链表，对每个尚未完成 SD 查询的设备发起新的 Service Discovery Request。Service Discovery 是相亲角里的"深度交流"——发现一个人后，你可以进一步问他"你会什么服务"（比如 Miracast、文件传输），而不是只交换名片的表面信息。如果 SD 查询成功发起，return——等 SD 完成后再次进入 continue_find。

- **如果 SD 全部完成**：跳到 `skip_sd`，调用 `p2p_listen_in_find(p2p, 1)`——回到 Listen 阶段，开始新一轮交替。第 2 个参数 `1` 表示这是 device discovery 场景（对应的 Probe Response 里带 P2P Capability），与非 discovery 场景的纯 Listen 区分。

循环就是这样接起来的：`p2p_listen_in_find → [Listen 结束] → p2p_search → [Scan 结束 + SD] → p2p_continue_find → p2p_listen_in_find → ...`

在相亲角里：站摊位（Listen）→ 逛一圈（Search）→ 对有眼缘的人聊聊（SD）→ 回到摊位（Listen）→ 再逛一圈……如此往复，直到 120 秒超时或者逛够了。

把这条交替链画成时序图，就是下面这张——supplicant 的 p2p_find 状态机是总调度，Listen 和 Scan 在社交信道上交替，右侧两道虚线框分别是 120 秒整场营业时间和 35 秒单轮扫描超时的兜底：

![Find 循环的 Listen⇄Scan 交替时序](assets/11c-P2P%EF%BC%88%E4%B8%89%EF%BC%89%E8%AE%BE%E5%A4%87%E5%8F%91%E7%8E%B0%E5%85%A8%E9%93%BE%E8%B7%AF%E2%80%94%E2%80%94%E4%BB%8E%E5%8F%91%E7%8E%B0%E8%B7%AF%E7%94%B1%E5%88%B0-Probes-%E6%BB%A1%E5%A4%A9%E9%A3%9E/11c-find-loop.svg)

## 3.6 Find 超时与收工

120 秒倒计时由 `eloop_register_timeout` 在 `p2p_find()` 中注册：

```c
// src/p2p/p2p.c:1069
static void p2p_find_timeout(void *eloop_ctx, void *timeout_ctx)
{
    struct p2p_data *p2p = eloop_ctx;
    p2p_dbg(p2p, "Find timeout -> stop");
    p2p_stop_find(p2p);
}
```

到了 120 秒，`p2p_find_timeout` 超时回调触发，调用 `p2p_stop_find()`。`p2p_stop_find` 内部做的是清场：取消超时定时器、清除所有 pending 状态、设置状态为 `P2P_IDLE`、通知 Framework 侧 `onFindStopped` 回调，最终触发 `P2P-FIND-STOPPED` 事件。

但超时不等于一无所获。超时前每一轮 Listen 中收到的 Probe Response 都已经被处理——每个发现的设备都被记入了 `p2p->devices` 链表。超时时只意味着"没有新的发现了"，但已发现的设备不会丢失。相亲角关门不等于名单上的名字消失了，只是不再接纳新的登记。

120 秒是整场营业时间，但每一轮单独的 Scan 也有自己的看门狗，防止一轮扫描把整个循环拖死。`p2p_notify_scan_trigger_status()`（`p2p.c:1077`）在驱动确认扫描启动（status==0）时，注册一个 `P2P_SCAN_TIMEOUT`（35 秒，`p2p.c:47`）定时器；如果 35 秒内驱动一直没上报扫描结果（比如回调在固件侧丢失），`p2p_scan_timeout()`（`p2p.c:1124`）触发，把 `p2p_scan_running` 清 0、调 `p2p_run_after_scan()` 继续推进——防止一次「石沉大海」的扫描把 Find 循环永久卡死在 Search 状态。

这是「单轮扫描超时」和「整场营业超时」两个不同粒度的兜底：前者保证循环不卡死，后者保证循环会收场。

但超时收工之后，Framework 不会自己再开一轮。supplicant 的 `find_stopped` 回调上抛的 `P2P-FIND-STOPPED` 事件，在 `P2pEnabledState.processMessageImpl()` 的对应 case 里（`WifiP2pServiceImpl.java:3376`）只做了两件事：清掉临时挂上的 vendor 元素、广播 `WIFI_P2P_DISCOVERY_CHANGED_ACTION=STOPPED`。120 秒是单轮营业时间，不是自动续费的会员制——想再发现一次，App 得再调一次 `discoverPeers()`。

此外，Find 可以手动提前停止——用户在 UI 上点"停止搜索"，或者应用调了 `WifiP2pManager.stopPeerDiscovery()`。这条调用的链路和 `discoverPeers` 对称，最终到达 `p2p_stop_find()`。手动停止和超时停止到达的是同一个函数。

还有一个连用户都不用按停止键的收工原因：Find 进行中用户发起了 connect。发现和连接互斥，因为同一条射频同一时刻只能干一件事。Framework 侧，`InactiveState`（`WifiP2pServiceImpl.java:3776`）和 `IdleState`（`:4253`）的 CONNECT 分支都会先调 `mWifiNative.p2pStopFind()` 把正在进行的 Find 停掉，再进入组协商；supplicant 侧 `p2p_connect()`（`p2p.c:1605`）也会自检——如果当前状态不是 `P2P_IDLE`，就先 `p2p_stop_find()`（`p2p.c:1691`）把自己清理干净。

两层保险，确保你走进谈判桌之前，先收了自己的摊位。

---

# 4 P2P IE + WSC IE：名片的正反面各写了什么？

Find 循环的每轮 Listen 和 Scan 都在交换帧，帧里嵌着 P2P IE 和 WSC IE。这两套 IE 是相亲角里递出去的名片——正面写着"你是谁、你能做什么"，背面写着"你用哪种方式做安全验证"。在展开驱动侧的实际帧收发之前，先拆开名片看看里面到底装了哪些字段。

## 4.1 P2P IE 的帧结构

一个 P2P IE 嵌在 Vendor Specific IE 中，结构如下：

```
+------------------+----------+----------+------------------+
| Element ID (221) | Length   | OUI      | P2P Attributes   |
| 1 byte           | 1 byte   | 4 bytes  | variable         |
+------------------+----------+----------+------------------+
```

- **Element ID = 221**（`WLAN_EID_VENDOR_SPECIFIC`）：告诉接收方这是一个"厂商自定义"信息元素。
- **Length**：后续所有字节的长度。
- **OUI = 0x50-6F-9A-09**（`P2P_IE_VENDOR_TYPE`）：前 3 字节 50-6F-9A 是 Wi-Fi Alliance 的 OUI（Organizationally Unique Identifier），第 4 字节 09 是 WFA 分配给 P2P 的子类型（`P2P_OUI_TYPE`）。这个四字节组合 OUI + type 告诉解析器：这不是普通的厂商 IE，这是 Wi-Fi Alliance P2P 协议的 IE。
- **P2P Attributes**：一个或多个 TLV（Type-Length-Value）属性的序列。

P2P IE 的构建入口在 `p2p_build.c`：

```c
// src/p2p/p2p_build.c:43
u8 * p2p_buf_add_ie_hdr(struct wpabuf *buf)
{
    /* P2P IE header */
    wpabuf_put_u8(buf, WLAN_EID_VENDOR_SPECIFIC);
    len = wpabuf_put(buf, 1); /* IE length to be filled */
    wpabuf_put_be32(buf, P2P_IE_VENDOR_TYPE);
    return len;
}
```

这个函数负责写入 IE 头部的三个字段。完成后，后面的各 `p2p_buf_add_*` 函数依次往 buf 里追加 P2P Attributes。

## 4.2 关键 P2P Attributes

P2P Attributes 是 P2P IE 的核心内容——每个 Attribute 都是一个 TLV：

```
+-----------------+----------+------------------+
| Attribute ID    | Length   | Attribute Body   |
| 1 byte          | 2 bytes  | variable         |
+-----------------+----------+------------------+
```

Attribute ID 的枚举定义在 `ieee802_11_defs.h` 中。下表是 P2P 帧中出现的主要 Attribute——注意并非全部都出现在发现阶段的 Probe 帧里：

| Attribute                      | ID   | 含义                                                         | 相亲角比喻                                                 |
| ------------------------------ | ---- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| P2P Capability                 | 2    | Device Capability + Group Capability 位图                    | 你能做什么（能不能做 GO、能不能做 Client、支持不支持 WFD） |
| Listen Channel                 | 6    | Country + Operating Class + Channel Number                   | 你的摊位在哪条街上（别人可以去哪找你）                     |
| Extended Listen Timing         | 8    | Availability Period + Interval                               | 摊位不是 24 小时开放的，只在特定时段有人                   |
| P2P Device Info                | 13   | P2P Device Address + Config Methods + Device Name            | 你的联系方式 + 偏好哪种验证方式（PIN/PBC）                 |
| Group ID                       | 15   | 当前 Group 的 SSID（如果设备正在 Group 中）                  | 你已经"有主了"——在某个 Group 里                            |
| Operating Channel              | 17   | Country + Operating Class + Channel Number（打算建组的信道） | 谈判桌上谈定的摆摊地点                                     |
| Intended P2P Interface Address | 9    | 为本次连接创建的 P2P 接口 MAC                                | 谈妥后我用哪个身份来见你                                   |

这里要区分两类 Attribute：只有 P2P Capability、Listen Channel、Extended Listen Timing、P2P Device Info 四样出现在发现阶段的 Probe Request/Response 里——它们构成"相亲角自我介绍"的名片（Probe Request 的 P2P IE 由 `p2p_scan_ie()`（`p2p.c:3661`）构造，Probe Response 的由 `p2p_build_probe_resp_ies()`（`p2p.c:2254`）构造）。

另外三样是更后面的"谈判桌上"才交换的信息：**Group ID**（attr 15）在设备已经在某个 Group 中时出现（GO Negotiation Response、Invitation、Provision Discovery、Device Discovery），告诉对方"我这个组叫这个 SSID"；**Operating Channel**（attr 17）出现在 GO Negotiation 和 Invitation 帧里，宣告"我打算在这个信道上建组"；**Intended P2P Interface Address**（attr 9）出现在 GO Negotiation 和 Provision Discovery 帧里，宣告"我打算为这次连接创建的接口 MAC 是这个"。

一个有意思的细节：Operating Channel 在 Probe Request 的构造函数 `p2p_scan_ie()` 里只留了一行 `/* TODO: p2p_buf_add_operating_channel() if GO */` 注释（`p2p.c:3702`），并未真正加上——因为发现阶段不需要它，它属于谈判而非亮相。构建这三个 Attribute 的函数分别是 `p2p_buf_add_operating_channel()`（`p2p_build.c:113`）、`p2p_buf_add_intended_addr()`（`:287`）、`p2p_buf_add_group_id()`（`:309`）。

**P2P Capability (attr 2)** 是两个字节的位图：

```c
// src/p2p/p2p_build.c:76
void p2p_buf_add_capability(struct wpabuf *buf, u8 dev_capab, u8 group_capab)
{
    /* P2P Capability */
    wpabuf_put_u8(buf, P2P_ATTR_CAPABILITY);
    wpabuf_put_le16(buf, 2);
    wpabuf_put_u8(buf, dev_capab);    /* Device Capabilities */
    wpabuf_put_u8(buf, group_capab);  /* Group Capabilities */
}
```

Device Capability 字节的各个 bit 含义：bit 0 = Service Discovery、bit 1 = P2P Client Discoverability、bit 2 = Concurrent Operation、bit 3 = P2P Infrastructure Managed、bit 4 = P2P Device Limit、bit 5 = P2P Invitation Procedure、bit 6 = 6GHz Band Capable（6GHz 频段能力，P2P 1.6+ 新增）。

p2p_init 设置了 `dev_capab = SD + Invitation + Concurrent + Client Disc`——四个能力全开。

Group Capability 字节的 bit 0 = P2P Group Owner、bit 1 = Persistent P2P Group、bit 2 = P2P Group Limit、bit 3 = Intra-BSS Distribution、bit 4 = Cross Connection、bit 5 = Persistent Reconnect、bit 6 = Group Formation、bit 7 = IP Address Allocation。

**P2P Device Info (attr 13)** 是最丰富的 Attribute：

```c
// src/p2p/p2p_build.c:205
void p2p_buf_add_device_info(struct wpabuf *buf, struct p2p_data *p2p,
                             struct p2p_device *peer)
{
    // ... P2P Device Info ...
    wpabuf_put_u8(buf, P2P_ATTR_DEVICE_INFO);
    len = wpabuf_put(buf, 2);

    /* P2P Device address */  // 6 bytes MAC
    wpabuf_put_data(buf, p2p->cfg->dev_addr, ETH_ALEN);

    /* Config Methods */  // 2 bytes bitmask
    methods = p2p->cfg->config_methods; /* 简化：实际按 peer->wps_method 分支推导，peer 未就绪才回退此路径 */
    wpabuf_put_be16(buf, methods);

    /* Primary Device Type */  // 8 bytes (Category + OUI + Subcategory)
    wpabuf_put_data(buf, p2p->cfg->pri_dev_type, sizeof(p2p->cfg->pri_dev_type));

    /* Secondary Device Type List */
    // ... num_sec_dev_types, sec_dev_type[i] ...

    /* Device Name */  // variable length
    nlen = p2p->cfg->dev_name ? os_strlen(p2p->cfg->dev_name) : 0;
    wpabuf_put_be16(buf, ATTR_DEV_NAME);
    wpabuf_put_be16(buf, nlen);
    wpabuf_put_data(buf, p2p->cfg->dev_name, nlen);

    WPA_PUT_LE16(len, (u8 *) wpabuf_put(buf, 0) - len - 2);
}
```

这个 Attribute 告诉别人：我是谁（Device Name）、我的联系方式（P2P Device Address）、我是做什么的（Primary/Secondary Device Type）、我喜欢哪种配网方式（Config Methods：PIN Display / Keypad / PBC）。

## 4.3 WSC IE：名片背面的安全信息

WSC IE（Wi-Fi Simple Configuration IE）在 P2P 场景中嵌在 Probe Request/Response 中，作为 P2P IE 的"安全附件"：

```c
// src/p2p/p2p_build.c:860
int p2p_build_wps_ie(struct p2p_data *p2p, struct wpabuf *buf, int pw_id,
                     int all_attr)
{
    u8 *len;
    wpabuf_put_u8(buf, WLAN_EID_VENDOR_SPECIFIC);
    len = wpabuf_put(buf, 1);
    wpabuf_put_be32(buf, WPS_DEV_OUI_WFA);

    if (wps_build_version(buf) < 0)
        return -1;

    if (all_attr) {
        // WPS State: Not Configured
        wpabuf_put_be16(buf, ATTR_WPS_STATE);
        wpabuf_put_be16(buf, 1);
        wpabuf_put_u8(buf, WPS_STATE_NOT_CONFIGURED);
    }

    if (pw_id >= 0) {
        // Device Password ID: PIN / PBC
        wpabuf_put_be16(buf, ATTR_DEV_PASSWORD_ID);
        wpabuf_put_be16(buf, 2);
        wpabuf_put_be16(buf, pw_id);
    }

    if (all_attr) {
        // Response Type, UUID-E, Manufacturer, Model, Serial, Device Type,
        // Device Name, Config Methods...
        // ... omitted for brevity, see full source ...
    }

    if (wps_build_wfa_ext(buf, 0, NULL, 0, 0) < 0)
        return -1;

    p2p_buf_update_ie_hdr(buf, len);
    return 0;
}
```

WSC IE 和 P2P IE 一样装在 Vendor Specific IE（Element ID 221）中，但 OUI 不同：P2P IE 用 `P2P_IE_VENDOR_TYPE`（OUI 50-6F-9A + type 0x09），WSC IE 用 `WPS_DEV_OUI_WFA`（OUI 00-50-F2 + type 0x04）。

P2P IE 说"我是谁、我会什么"，WSC IE 说"你可以怎么连我"——支持 PIN 还是 PBC、设备名称、型号等。两者合起来才是完整的"相亲名片"。收到 Probe Request 的设备同时解析两个 IE 来确定：这个人是不是 P2P 设备，我想不想连它，我连它的话该用什么方式验证。

两张名片的正面和背面合在一起才够用——正面（P2P IE）告诉人家你的 P2P 能力，背面（WSC IE）告诉人家你的连接参数。缺一面，连起来的成本就高了（缺少的那一面往往要在后续的 GO Negotiation 或 Provision Discovery 中额外交换）。

有个协议设计哲学值得展开：为什么不在 P2P IE 里直接定义 Config Methods、Device Name 这些字段，而要嵌套一整张 WSC IE？答案是 WSC IE 不是 P2P 发明的，它是 WPS 生态（Wi-Fi Simple Configuration）的既有格式——早在 P2P 协议诞生之前，WPS 就已经用这组属性描述「设备怎么被配网」。P2P 选择嵌套而非自造，是为了复用 WPS 的构建与解析代码，避免两套字段定义漂移。

证据就在构建函数里：`p2p_build_wps_ie()`（`p2p_build.c:860`）内部直接调用 `wps_build_version()`、`wps_build_wfa_ext()`（`wps_attr_build.c:191/208`）——这些是 WPS 模块的函数，P2P 只是把现成的 WPS IE 构建器借过来，塞进自己的 Probe 帧。

协议设计上，这等于让「发现阶段的名片」与「配网阶段的凭证交换」共用同一套 WSC IE 格式：P2P 的 GO Negotiation 之后紧跟着 WPS 配网，如果发现阶段和配网阶段用两套不兼容的设备描述格式，中间就要做一次字段映射，既增加实现复杂度又容易出错。P2P IE 因此保持精简，只承载 P2P 专属属性（Capability、Listen Channel、Device Info 里的 P2P 地址等），把设备身份与配网偏好这些跨协议通用的部分全部委托给 WSC IE。

---

# 5 驱动怎么把 Probes 发出去、收回来？

名片的格式清楚了（§4），交替的策略也定好了（§3）。但把名片的字节序列变成空中的无线电波，是驱动的事。这一节追踪从 nl80211 下发到硬件 TX/RX 的实际路径——QCOM 走 SCM + WMI，MTK 走 FSM + mbox。

## 5.1 Listen 的下发路径：NL80211_CMD_REMAIN_ON_CHANNEL

站到摊位前这件事，supplicant 自己站不进去——射频握在驱动手里，它只能把"我在这里站一会儿"的命令写下来递过去。Listen 阶段，supplicant 通过 `p2p->cfg->start_listen()` 回调到达 driver_nl80211，最终下发一条 `NL80211_CMD_REMAIN_ON_CHANNEL`——这是 nl80211 专门为"不建关联但要在某个信道上停留"设计的命令。

这条命令携带三个关键参数：

- **频率**：Listen 信道频率（通常是 2412/2437/2462 之一）。
- **持续时间**：100-300ms（由 `p2p_listen_in_find` 随机计算）。
- **Probe Response IE**：当其他设备在此信道上发 Probe Request 时，驱动/固件用这个 IE 自动回复 Probe Response——不需要再回 supplicant 询问。

第三个参数特别重要：驱动收到 `NL80211_CMD_REMAIN_ON_CHANNEL` 时同时拿到了设备配置好的 Probe Response IE。这意味着别人发 Probe Request 到这个信道上时，驱动/固件可以直接用预先配置好的 IE 构造 Probe Response 回复，延迟极低，不需要走"通知 supplicant → supplicant 构造响应 → 下发帧"的 round-trip。否则从收到帧到发出响应，中间至少要走一次用户态-内核态-用户态的切换，在 Listen 阶段那么短的窗口里可能根本来不及。

不过 `start_listen` 这个回调不是直接摸到驱动的——它先过一道 supplicant 自己的"排队闸门"。`p2p->cfg->start_listen` 实际对应 `wpas_start_listen()`（`p2p_supplicant.c:2780`），它不是立刻发命令，而是通过 `radio_add_work()`（`:2805`）往射频工作队列里排一个 `p2p-listen` 工作项，等射频空闲了才真正下发 `NL80211_CMD_REMAIN_ON_CHANNEL`。这套机制和扫描共用——P2P Listen 和 STA 扫描都挂在同一条射频上，谁先占用谁先用，后到的工作项排队等待。

这也解释了 §3.2 里那句"Failed to start listen mode"什么时候会发生：如果队列里已经有一个 `p2p-listen` 工作项在跑（`wpa_s->p2p_listen_work` 非空），`wpas_start_listen` 直接返回 -1（`:2787`），`p2p_listen_in_find` 就把 `pending_listen_freq` 清 0、跳过这一轮 Listen。跳过了也不会死循环——总超时定时器（120 秒）还挂着，循环最终会靠收工兜底。

Listen 结束时，驱动通过 `cfg80211_remain_on_channel_expired()` 通知内核，内核再通知 supplicant `EVENT_REMAIN_ON_CHANNEL` 超时事件。supplicant 收到后就知道"Listen 结束了，该 Scan 了"。

Scan 阶段，Probe Request 的下发走另一条路径：`NL80211_CMD_FRAME` 或 `NL80211_CMD_TRIGGER_SCAN`——取决于驱动是否支持 offloaded scan。如果驱动支持 offloaded P2P scan，supplicant 只需要告诉驱动频率列表和 IE 参数，驱动/固件自己完成信道上 Probe Request 的发送和 Probe Response 的接收。如果不支持 offloaded scan，supplicant 通过 `NL80211_CMD_FRAME` 逐帧下发，驱动逐帧发射。

## 5.2 QCOM：p2p_scan_start 与 RoC 机制

在 QCOM qcacld-3.0 中，P2P Listen 和 Scan 都通过 SCM（Scan Manager）统一管理。`p2p_scan_start()` 在 `wlan_p2p_roc.c` 中实现：

```c
// QCOM/qcacld-3.0/components/p2p/core/src/wlan_p2p_roc.c:79
static QDF_STATUS p2p_scan_start(struct p2p_roc_context *roc_ctx)
{
    QDF_STATUS status;
    struct scan_start_request *req;
    struct wlan_objmgr_vdev *vdev;
    struct p2p_soc_priv_obj *p2p_soc_obj = roc_ctx->p2p_soc_obj;

    vdev = wlan_objmgr_get_vdev_by_id_from_psoc(
            p2p_soc_obj->soc, roc_ctx->vdev_id, WLAN_P2P_ID);
    // ... vdev null check ...

    req = qdf_mem_malloc(sizeof(*req));
    wlan_scan_init_default_params(vdev, req);

    req->vdev = vdev;
    req->scan_req.scan_id = roc_ctx->scan_id;
    req->scan_req.scan_type = SCAN_TYPE_P2P_LISTEN;
    req->scan_req.scan_req_id = p2p_soc_obj->scan_req_id;
    req->scan_req.chan_list.num_chan = 1;
    req->scan_req.chan_list.chan[0].freq = roc_ctx->chan_freq;
    req->scan_req.dwell_time_passive = roc_ctx->duration;
    req->scan_req.dwell_time_active = 0;
    req->scan_req.scan_priority = SCAN_PRIORITY_HIGH;

    // ... GO presence dwell time compensation ...
    // ... DBS/NDP/NAN coexistence adjustment ...

    status = wlan_scan_start(req);
    // ...
    return status;
}
```

QCOM 的实现中有几个关键设计：

**P2P Listen 是一种特殊的 Scan**：`scan_type = SCAN_TYPE_P2P_LISTEN`、`dwell_time_passive = duration`、`dwell_time_active = 0`——意思是"在这个信道上停留 duration 毫秒，不做主动发送，只等被动接收"。这和通常的"主动扫描"不同——主动扫描会在信道上发 Probe Request 然后等响应，但 P2P Listen 是被动等别人发 Probe Request 再回 Probe Response。

**共存补偿机制**：代码中有一个值得关注的分支——如果当前有 P2P GO 在运行（`go_num > 0`），dwell_time 会被增加 300ms 固定值而非倍数。注释中解释了这个设计的理由：如果乘以一个倍数，200ms 的默认 dwell 可能变成 600ms 甚至 1.5 秒——GO 的 NOA（Notice of Absence）信息已经广播出去了，如果固件按 1.5 秒去执行 NOA，supplicant 在 200ms 后想取消 ROC 就来不及了。

固件不能中途打断已通告的 NOA，下一个 ROC 请求会被推迟到当前 NOA 结束后，导致 Find 循环节奏被打乱。所以这里用了固定加法（+300ms）而非乘法——限定了对 Find 节奏的影响上限。

**硬件能力感知**：`policy_mgr_is_hw_dbs_capable()` 判断是否支持 DBS（Dual Band Simultaneous）。这个返回值只影响 `dwell_time_passive` 的上限封顶，不改变 scan_type 和优先级——如果支持 DBS，NDP/NAN 共存场景的 ROC 最大时长上限放宽到 350ms（`P2P_MAX_ROC_DURATION_DBS_NDP_PRESENT` / `P2P_MAX_ROC_DURATION_DBS_NAN_PRESENT`，`wlan_p2p_roc.h:36/38`），而非 DBS 只有 250/300ms（`:37/39`）——因为 2.4GHz P2P 和 5GHz STA 可以同时工作，不需要互相让路。

DBS 放开的「并发」也直接决定了 scan_req_id 路由机制的必要性：当 2.4GHz P2P 扫描和 5GHz STA 扫描可以在同一个 SoC 上同时跑时，Scan Manager 里会同时存在来自多个模块（STA、P2P、NDP、NAN）的扫描请求，事件回来时必须精确识别该通知谁——这就是下面 scan_req_id 按槽位路由要解决的问题。

**scan_req_id 的语义**：`req->scan_req.scan_req_id = p2p_soc_obj->scan_req_id`（`wlan_p2p_roc.c:120`）里的 `scan_req_id` 不是一个去重 ID，而是 P2P 模块向 Scan Manager 注册的 requester 标识。`p2p_psoc_start()` 里调 `wlan_scan_register_requester()`（`wlan_p2p_main.c:852`，实现于 `qca-wifi-host-cmn/umac/scan/dispatcher/src/wlan_scan_api.c:584`）在 Scan Manager 的 `requesters[]` 槽位数组里占一个空位，返回 `WLAN_SCAN_REQUESTER_ID_PREFIX | 槽位号`（`wlan_scan_main.h:120-121`），同时把 P2P 的回调 `tgt_p2p_scan_event_cb` 存进该槽的 `ev_handler`。

之后每次 RoC/Scan 请求都带上这个 ID；扫描事件到达时，`scm_scan_post_event()`（`wlan_scan_manager.c:130`）调 `scm_scan_get_requester_event_handler()`（`:99`）用 `requester_id & WLAN_SCAN_REQUESTER_ID_MASK` 取出槽位，把该槽的 `ev_handler.func` 加进监听列表再逐个调用——所以路由是「按槽位直查回调」，O(1) 且天然隔离：P2P 的事件只会进 P2P 的回调，不会串到 STA 或 NAN 的回调里。

所以 `scan_req_id` 的作用是「事件路由」，不是「防重复」——防重复由序列化队列（下文三层防线）负责，scan_req_id 只回答「这个事件该通知谁」。

那如果 Framework 连续快速调用两次 `discoverPeers()`，驱动怎么防止重复扫描？答案是三层防线，每一层都挡掉一部分：

1. **Framework 不拦**：§1.2 说过，`mDiscoveryStarted` 标志只影响广播状态，DISCOVER_PEERS 路径不读它，第二次调用照常下发到 supplicant。
2. **supplicant 合并**：`p2p_find()` 里如果 `p2p->p2p_scan_running` 已置位（`p2p.c:1192`），并且 `res != 0`（新的扫描没真正启动），就把 `find_pending_full` 置 1（`p2p.c:1316`）——意思是"等当前这轮扫描跑完，接着补一次全扫描"，而不是立刻启动第二个 Find 循环。新请求被合并进旧循环的尾部，而不是并行跑。
3. **驱动排队**：即使请求穿透到 Scan Manager，每个扫描请求都要过 `wlan_serialization_request()`（`wlan_scan_manager.c:1505`）做序列化——同一 vdev 上如果已有 active scan，新请求进 pending 队列等待，返回 `WLAN_SER_CMD_PENDING`（`wlan_serialization_api.h:289`）。调用方对 PENDING 的处理是「Do nothing」（`wlan_scan_manager.c:1507-1509`）——不是失败，只是还没轮到。这一层是扫描框架对「并发扫描」的硬性闸门，不只服务 P2P，STA 扫描、NAN、NDP 全走它——绝不会两个扫描在同一 vdev 上并发执行，只会前一个完成、后一个被自动唤醒。

那「后一个」是怎么被自动唤醒的？唤醒是事件驱动的，不靠轮询：active 扫描完成时 `scm_scan_event_handler()`（`wlan_scan_manager.c:1800`）调 `scm_release_serialization_command()`（`:192`）→ `wlan_serialization_remove_cmd()`（`wlan_serialization_api.c:349`）→ `wlan_serialization_dequeue_cmd()`（`wlan_serialization_internal.c:426`）→ 若 pending 队列非空，`wlan_serialization_move_pending_to_active()`（`:402`）把队首扫描命令提升为 active，再经 `wlan_serialization_activate_cmd()`（`:286`）回调 `cmd.cmd_cb(WLAN_SER_CB_ACTIVATE_CMD)`。

对扫描命令，这个 `cmd_cb` 就是 `scm_scan_serialize_callback()`（`wlan_scan_manager.c:298`），它调 `scm_activate_scan_request()`（`:254`）→ `tgt_scan_start()` 真正把扫描下发固件。P2P 侧不需要自己做任何「重试」——它只等 `SCAN_EVENT_TYPE_STARTED` 事件到达（`p2p_scan_event_cb`），STARTED 到了就说明序列化已经把请求顶上来、固件开始执行了。

三层合起来的效果是：重复的 `discoverPeers` 不会产生两份并行的 Find 循环，只会被合并、排队、最后串行执行。

Scan 的结果通过 `p2p_scan_event_cb()` 回调：

```c
// QCOM/qcacld-3.0/components/p2p/core/src/wlan_p2p_roc.c:964
void p2p_scan_event_cb(struct wlan_objmgr_vdev *vdev,
    struct scan_event *event, void *arg)
{
    struct p2p_soc_priv_obj *p2p_soc_obj;
    struct p2p_roc_context *curr_roc_ctx;

    p2p_soc_obj = (struct p2p_soc_priv_obj *)arg;
    curr_roc_ctx = p2p_find_current_roc_ctx(p2p_soc_obj);

    switch (event->type) {
    case SCAN_EVENT_TYPE_STARTED:
        p2p_process_scan_start_evt(curr_roc_ctx);
        break;
    case SCAN_EVENT_TYPE_FOREIGN_CHANNEL:
        p2p_process_ready_on_channel_evt(curr_roc_ctx);
        break;
    case SCAN_EVENT_TYPE_COMPLETED:
    case SCAN_EVENT_TYPE_DEQUEUED:
    case SCAN_EVENT_TYPE_START_FAILED:
        p2p_process_scan_complete_evt(curr_roc_ctx);
        break;
    }
}
```

几个事件类型很有意思：

- **SCAN_EVENT_TYPE_STARTED**：扫描已启动（固件确认收到命令）。
- **SCAN_EVENT_TYPE_FOREIGN_CHANNEL**：这不是一个"有人在别的信道上"的事件，而是 QCOM 内部的"已就绪在信道上"通知——等价于 ROC_EVENT_READY_ON_CHAN。固件通知驱动：我已经调到目标信道上、已经就绪、可以开始发送/接收帧了。
- **SCAN_EVENT_TYPE_COMPLETED / DEQUEUED / START_FAILED**：扫描结束、被取消、启动失败——三种不同的终止原因，都走同一个完成处理函数。

"FOREIGN_CHANNEL" 这个命名有点误导——它字面上像是"外国信道"，但本意是"当前 STA 关联信道之外的某个信道"（foreign channel = 非主信道）。在 P2P 的语境下，设备 Listen 的信道通常不是 STA 关联的信道，所以对 STA 来说是"外国的"。事件名是 STA 中心的视角，不是 P2P 中心的视角——这是读 QCOM 代码时的一个常见的小陷阱。

## 5.3 MTK：P2P Role FSM 中的信道管理

如果说 QCOM 把摊位和逛街都收进一个总调度台（SCM），MTK 则是把每一步流程拆成一张张卡片，让跑腿工照卡片走——那张卡片就是 P2P Role FSM。MTK 平台不走 QCOM 的 SCM 集中调度路线，而是通过 P2P Role FSM（P2P Role 的 9 状态状态机）来管理信道切换。MTK 的信道管理由 CNM（Coexistence and Network Manager）统一分配，P2P Role 不能自己决定用哪个信道。

MTK P2P Role FSM 的几个 P2P 发现相关的状态：

- **P2P_ROLE_STATE_SCAN**：主动/被动扫描中。Role FSM 收到扫描触发事件后，进入此状态，通过 CNM 申请信道资源。`p2pRoleStateInit_SCAN()`（`MTK/kernel_modules-connectivity-wlan-core-gen4m/mgmt/p2p_role_state.c:40`）组装扫描请求并调用 `p2pFuncRequestScan()` 下发。
- **P2P_ROLE_STATE_REQING_CHANNEL**：向 CNM 请求 RF 信道。在 Listen 模式下，这个状态向 CNM 申请在社交信道上停留；在 Scan 模式下，申请在多个信道上依次切换。`p2pRoleStateInit_REQING_CHANNEL()`（`MTK/kernel_modules-connectivity-wlan-core-gen4m/mgmt/p2p_role_state.c:102`）按请求类型走 `p2pFuncAcquireCh()`（普通信道申请）或 `p2pLinkAcquireChJoin()`（JOIN 场景）。
- **P2P_ROLE_STATE_OFF_CHNL_TX**：在非工作信道上发送管理帧——对应 P2P 发现中的 Probe Request 发包。`p2pRoleStateInit_OFF_CHNL_TX()`（`MTK/kernel_modules-connectivity-wlan-core-gen4m/mgmt/p2p_role_state.c:645`）从 `prP2pMgmtTxInfo` 的 TX 请求链表中逐帧取出，校验目标信道是否与当前申请信道一致，不一致则重新申请信道。

supplicant 的 Listen 请求是怎么钻进这套 FSM 的？和 QCOM 在 SCM 里把 Listen 当成 `SCAN_TYPE_P2P_LISTEN` 特殊扫描不同，MTK 的入口在 cfg80211 命令分发处：supplicant 下发 `NL80211_CMD_REMAIN_ON_CHANNEL` 后，内核调 cfg80211 的 `.remain_on_channel` 钩子——注册为 `mtk_cfg_remain_on_channel`（`gl_cfg80211.c:7876`，注册于 `gl_init.c:1260`），它对 P2P 接口分派到 `mtk_p2p_cfg80211_remain_on_channel`（`os/linux/gl_p2p_cfg80211.c:2585`）。

后者分配一个 `MSG_P2P_CHNL_REQUEST` 消息，把 `eChnlReqType` 置成 `CH_REQ_TYPE_ROC`（显式标注"这是 remain-on-channel 请求"），塞进 mbox 发往固件侧的 P2P 模块。

mbox 消息 `MID_MNY_P2P_CHNL_REQ` 在 HEM 分发表里对应 `p2pDevFsmRunEventChannelRequest()`（`mgmt/hem_mbox.c:248` 注册，`mgmt/p2p_dev_fsm.c:709` 实现）——它把请求插进信道请求队列，若 Dev FSM 当前空闲则重入 IDLE 状态触发信道申请，进而把 Role FSM 推到 `P2P_ROLE_STATE_REQING_CHANNEL` → `p2pFuncAcquireCh()`。

所以 QCOM 的 Listen 是"SCM 总调度台下的一种特殊扫描类型"，MTK 的 Listen 是"一条 mbox 信道请求消息穿过 Dev FSM 和 Role FSM 两级状态机"——同一个 `NL80211_CMD_REMAIN_ON_CHANNEL`，两家落地的抽象完全不同。

MTK 的 Probe Request 发送走 P2P Action 帧路径——驱动通过 mbox（Mailbox）消息将帧描述符下发给固件，固件在指定信道上发射。Probe Response 的接收路径与之对称：固件收到帧后通过 mbox 中断通知驱动，驱动解析帧内容，提取 P2P IE 并回调 supplicant。

MTK 的核心理念和我们之前分析过的连接路径一脉相承——"驱动亲自下场"：不依赖固件代理决策，驱动自己跑状态机、管理帧的发送和接收都在 Host 侧控制。这个和 QCOM 的"固件全权代理"策略形成对比：QCOM 的固件拿到了完整的 Probe Response IE，可以自主回复不必每次上报 Host。

哪个更好？没有绝对答案。QCOM 的固件自主回复降低了 Host-固件交互延迟，但灵活性低——固件的 Probe Response 逻辑是烧死在固件里的，P2P 协议升级可能需要固件更新。MTK 的 Host 控制让驱动对每一帧都能精确干预，更新驱动即可适配新协议，但每帧都要 Host-固件往返的时延在高密度环境下可能累积。

如果把视野再拉高一格，两个平台对「RoC 这个抽象」的处理方式本身就是一对照。

QCOM 把 RoC 做成**独立模块**——`wlan_p2p_roc.c` 维护自己的 RoC 请求队列 `roc_q`（`p2p_process_roc_req()` 把新请求插入队尾，`p2p_find_current_roc_ctx()` 从队里取当前活动请求），以及独立的 RoC 状态机（`ROC_STATE_IDLE → ROC_STATE_REQUESTED → ROC_STATE_CANCEL_IN_PROG`，对应检查点 `wlan_p2p_roc.c:950/455/415`），并通过 `scan_req_id` 挂到 Scan Manager 下面，把 RoC 实现成一种特殊的扫描（`SCAN_TYPE_P2P_LISTEN`）。

这种模块化的好处是：RoC 与扫描框架统一，GO 共存补偿、DBS/NDP/NAN 共存策略全部集中在 `p2p_scan_start()` 一处，可复用、可单独测试。坏处是 RoC 的语义被 scan 抽象掩盖了——你从 `scan_type` 上很难一眼看出这是「停在信道上等人发 Probe Request」，要进到 `SCAN_TYPE_P2P_LISTEN` 的定义里才明白。

MTK 反其道而行，把 off-channel TX 直接**嵌进 P2P Role FSM 的状态迁移**里。`P2P_ROLE_STATE_OFF_CHNL_TX`（迁移分派在 `p2p_role_fsm.c` 的 `p2pRoleFsmStateTransition`，进入处理在 `p2pRoleStateInit_OFF_CHNL_TX()` 即 `p2p_role_state.c:645`，离开时的中止守卫在 `p2pRoleStateAbort_OFF_CHNL_TX()` 即 `:721`）不是独立模块，而是 Role FSM 的一个正式状态。

进入这个状态时，从 `prP2pMgmtTxInfo` 的 TX 请求链表逐帧取出，先调 `p2pFuncCheckOnRocChnl()` 校验目标信道是否与当前申请信道一致（`:678`），不一致就重新走 `REQING_CHANNEL` → `p2pFuncAcquireCh()` 申请新信道（`:699`），一致才 `p2pFuncTxMgmtFrame()` 逐帧下发（`:706`），发完释放信道回 IDLE。

这种 FSM 嵌入的好处是状态迁移显式——「我在申请信道 → 我在发帧 → 我释放信道」每一步都在状态机上看得见，Host 对每一帧都有完全控制权，新协议要加新的 off-channel 动作只需往 FSM 里加一个状态。

坏处是逻辑随状态增长而分散，每个状态都要处理自己的进入/中止/超时，且 off-channel 场景（发现、GO Negotiation、Provision Discovery）越多，FSM 状态就越拥挤。一个是「把共性抽出来做成模块」，一个是「把动作铺开成状态」，各有取舍，不存在放之四海皆准的答案。

## 5.4 双平台 Probe 路径对比

| 维度           | QCOM (qcacld-3.0)                                            | MTK (wlan-core-gen4m)               |
| -------------- | ------------------------------------------------------------ | ----------------------------------- |
| Listen 实现    | SCAN_TYPE_P2P_LISTEN（SCM 的特殊扫描类型）                   | REQING_CHANNEL 状态 → CNM 分配信道  |
| 信道管理       | SCM + Policy Manager（DBS 感知、GO 共存补偿）                | CNM（集中信道仲裁）                 |
| Probe Response | 固件自主回复（IE 预配下发）                                  | Host 控制（每帧经 Host 决策后下发） |
| 事件通知       | p2p_scan_event_cb → SCM scan events（STARTED/FOREIGN_CHANNEL/COMPLETED） | P2P Role FSM 事件 → 状态转移        |
| Frame 下发     | WMI 命令（WMI_START_SCAN_CMDID 等）→ 固件执行                | mbox 消息 → 固件执行                |
| 并发感知       | DBS 判断、GO 数量检查、NDP/NAN 共存策略                      | CNM 全局协调                        |

把这张表换成一条路径图，两家平台的分野一眼就能看出来——同一个 nl80211 入口进来，QCOM 收进 SCM 总调度台、固件代理回复，MTK 摊开成 Role FSM 的卡片流程、Host 逐帧控制：

![QCOM vs MTK Probe 路径对比](assets/11c-P2P%EF%BC%88%E4%B8%89%EF%BC%89%E8%AE%BE%E5%A4%87%E5%8F%91%E7%8E%B0%E5%85%A8%E9%93%BE%E8%B7%AF%E2%80%94%E2%80%94%E4%BB%8E%E5%8F%91%E7%8E%B0%E8%B7%AF%E7%94%B1%E5%88%B0-Probes-%E6%BB%A1%E5%A4%A9%E9%A3%9E/11c-platform-compare.svg)

## 5.5 收回来：Probe Response 的驱动 RX 路径

前面几小节讲的全是"把 Probes 发出去"，这一小节补齐另一半——空中的 Probe Response 怎么从驱动回到 supplicant。两个平台的 RX 链都是完整闭环，但结构差异明显。

**QCOM**：固件收到 Probe Response 后经 WMI 把管理帧上送，mgmt_txrx 层按帧子类型分发——`tgt_scan_bcn_probe_rx_callback()`（`qca-wifi-host-cmn/umac/scan/dispatcher/src/wlan_scan_tgt_api.c:317`）就是 Probe Response 和 Beacon 的注册回调（注册点在 `scan_register_unregister_bcn_cb()`，`wlan_scan_ucfg_api.c:1188`）。

它把帧封装成 `scan_bcn_probe_event` 投进 Scan Manager 的调度队列，`scm_handle_bcn_probe()`（`wlan_scan_cache_db.c:1501`）解包后转调 `__scm_handle_bcn_probe()`（`:1243`）用 `util_scan_unpack_beacon_frame` 解析成 scan cache entry，再经 `scm_add_update_entry()`（`:1101`）去重并入缓存。

入缓存时触发 `scan_obj->cb.inform_beacon` 回调——这个回调在 os_if 层注册为 `wlan_cfg80211_inform_bss_frame()`（`os_if/linux/scan/src/wlan_cfg80211_scan.c:2595`），最终调用内核的 `cfg80211_inform_bss_frame()`（`:2575`）把 BSS 填进 cfg80211 表。

整轮扫描结束，`wlan_cfg80211_scan_done()`（`:873`）调 `cfg80211_scan_done()`，内核发出 `NL80211_CMD_NEW_SCAN_RESULTS`，supplicant 取结果。带 P2P IE 的 Probe Response 走的就是这条 scan 路径——QCOM 不区分 P2P BSS 和普通 BSS，只是 `__scm_handle_bcn_probe` 用 `scm_is_p2p_wildcard_ssid()`（`wlan_scan_cache_db.c:1365`）跳过对 P2P 通配 SSID 的 RSN 校验。

**MTK**：RX 链在 Host 侧按角色拆成两套并行函数。固件 RX 队列入口 `wlanProcessQueuedSwRfb()`（`common/wlan_lib.c:3651`）按目的地分发，Beacon/Probe Response 到达 `scanProcessBeaconAndProbeResp()`（`mgmt/scan.c:4173`），其中 P2P 的走 `scanP2pProcessBeaconAndProbeResp()`（`mgmt/p2p_scan.c:66`）。

解析入 BSS 描述符后，普通 BSS 用 `kalIndicateBssInfo()`（`os/linux/gl_kal.c:7470`）、P2P 用 `kalP2PIndicateBssInfo()`（`os/linux/gl_p2p_kal.c:1237`），内部都调 `cfg80211_inform_bss_frame()`（`gl_kal.c:7525`）把结果送进内核。非扫描场景的 P2P 管理帧（Probe Request、Action）走另一条直通路径：`kalP2PIndicateRxMgmtFrame()`（`gl_p2p_kal.c:1395`）调 `cfg80211_rx_mgmt()` 直接送 supplicant。

对比一下：QCOM 是"一条 scan 路径收所有 BSS，P2P 只豁免个别校验"，MTK 是"scan 与 P2P 两套解析/上报函数并行"。一个值得留意的源码树限制：MTK 固件 RX 分发到 mgmt 模块之间的芯片级函数（`nicRxProcessPktWithoutReorder`，声明在 `include/nic/nic_rx.h:1720`）实现不在本源码树内，所以 MTK 链的最后一环只能追溯到芯片层边界——但"固件收到 → Host 解析 → cfg80211 上报"这条主干是完整可定位的。

---

# 6 发现的设备怎么变成 UI 上的列表？

驱动把帧收回来（§5），supplicant 解析了 IE（§4）——现在跑腿工拿着名片回到管理处。每张名片触发一次登记，最终名单贴到公告板上。这一节追踪从 `P2P-DEVICE-FOUND` 事件到 `WIFI_P2P_PEERS_CHANGED_ACTION` 广播的收口路径。

## 6.1 supplicant 侧：设备发现回调

当 supplicant 在 Scan 结果中解析出一个 P2P 设备的 Probe Response 时，它调用 `p2p_add_dev_from_probe_req()` 或 `p2p_add_dev_info()` 将设备添加到 `p2p->devices` 链表中。如果这是新设备（MAC 地址首次出现），触发 `wpas_notify_p2p_device_found()`：

```c
// wpa_supplicant/notify.c:749
void wpas_notify_p2p_device_found(struct wpa_supplicant *wpa_s,
                                   const u8 *dev_addr,
                                   const struct p2p_peer_info *info, ...)
{
    // ... 构建 P2P-DEVICE-FOUND 事件数据 ...
    wpas_aidl_notify_p2p_device_found(wpa_s, dev_addr, info, ...);
}
```

这个函数通过 AIDL callback `ISupplicantP2pIfaceCallback.onDeviceFound()` 将设备发现通知送回 Framework。通知里包含了完整的 P2P 设备信息：MAC 地址、Device Name、Primary Device Type、Config Methods、Device Capability、Group Capability、WFD Info（如果支持 Miracast）等。

设备在 `p2p_data->devices` 链表中的存储不是只增不减——每次新的 Find 开始时，`p2p_device_clear_reported()` 清掉 `P2P_DEV_REPORTED` 标记，但这些设备不会被删除。`P2P_DEV_REPORTED` 的作用是：当前这轮 Find 中，已经通过 AIDL 通知过 Framework 这个设备了，不用再重复通知。新一轮 Find 开始时，所有设备的这个标记被重置，允许重新通知——因为设备的 Listen 信道可能变了，Group 状态可能变了。

回到开头那句「如果这是新设备（MAC 地址首次出现）」——这里的去重键不是帧的源 MAC，而是 P2P IE 里的 **P2P Device Address**。

Scan 结果到达 `wpas_p2p_scan_res_handler()`（`p2p_supplicant.c:278`）后逐条转给 `p2p_add_device()`（`p2p.c:733`）：它先 `p2p_parse_ies()` 解出 P2P IE，优先取 P2P Device Info 属性里的 Device Address（取不到才退回 P2P Device Id），再用 `p2p_get_device()`（`p2p.c:384`）在 `p2p->devices` 链表里按这个地址查——找到就更新，找不到才 `p2p_create_device()`（`p2p.c:422`）新建。

BSSID 和 Device Address 常常不是同一个：帧源地址可能是 P2P Interface Address，此时 BSSID 被存进 `interface_addr`（`p2p.c:809`），留作 `p2p_get_device_interface()`（`p2p.c:401`）按接口地址查找的备用索引。

那同一个设备在 2.4G 和 5G 都出现怎么办？不会占两个表项——P2P Device Address 是设备跨频段的唯一身份，双频段的 Probe Response 都带同一个地址，命中同一个 `p2p_device` 表项。

`listen_freq` 在 `struct p2p_device` 里只是单个 `int`（`p2p_i.h:66`），没有列表：scan 路径每次用收到 Probe Response 的频率覆盖（`p2p.c:846`），`p2p_add_dev_info()` 则用 P2P IE 的 Listen Channel 属性覆盖（`p2p.c:1792`）。所以「这个设备现在在哪个信道等我」永远取最后一次听到的位置——发现阶段只保证能找到它，不保证记住它出现过的所有信道。

## 6.2 Framework 侧：mPeers 列表与广播

Framework 的 WifiP2pMonitor 收到 P2P-DEVICE-FOUND 事件后，投递到 P2pStateMachine。状态机将设备信息转换为 `WifiP2pDevice` 对象，更新内部 `mPeers` 列表（以 MAC 地址为 key）。此后相关广播的触发时机分两类：

1. **WIFI_P2P_PEERS_CHANGED_ACTION**：每次设备信息更新（P2P-DEVICE-FOUND）时发出，通知所有注册了 P2P 监听的 App"peer 列表有变化"。App 拿到广播后可以调 `WifiP2pManager.requestPeers()` 获取最新的 peer 列表。

2. **WIFI_P2P_DISCOVERY_CHANGED_ACTION**：在 Discovery 启动/停止时发出（而非每次发现设备），通知 App "Discovery 已启动/已停止"。

`mPeers` 的类型是 `WifiP2pDeviceList`（`WifiP2pServiceImpl.java:1500`），内部包着一个 `HashMap<String, WifiP2pDevice>`（`WifiP2pDeviceList.java:38`）——key 是 MAC 地址的字符串形式。每次收到 P2P-DEVICE-FOUND，状态机调 `updateSupplicantDetails()` 更新或插入对应表项（同一个 MAC 的设备信息可能更新——比如 WPS 方法从未就绪变为已就绪）。这是一个在状态机线程上操作的普通容器，不需要加锁——状态机线程是唯一写者。

当 P2P-FIND-STOPPED 事件到达时（无论是手动停止还是超时），P2pStateMachine 发出 `WIFI_P2P_DISCOVERY_CHANGED_ACTION` 广播，extra `EXTRA_DISCOVERY_STATE` 携带 `WIFI_P2P_DISCOVERY_STOPPED` 值。此时 mPeers 列表不会清空——即使 Find 停止了，已发现的设备信息依然保留。用户可以基于这份名单决定"连接哪一个"。

名单也不是只进不出。supplicant 每 10 秒跑一次定时清理——`wpas_periodic()`（`wpa_supplicant.c:8094` 调 `p2p_expire_peers()`）把长期没消息的 peer 表项释放掉：只要某个设备超过 60 秒没再露面（`P2P_PEER_EXPIRATION_AGE`，`p2p.c:54`），且不在豁免名单里（GO Negotiation 进行中、正连着它的 Group、或它正连着我们当 GO 的 Group），`p2p_device_free()`（`p2p.c:937`）就释放它的表项并触发 `dev_lost` 回调（`p2p.c:956`）上抛 `P2P-DEVICE-LOST` 事件。

Framework 侧这条反向链和发现对称：AIDL 回调 `onDeviceLost`（`SupplicantP2pIfaceCallbackAidlImpl.java:128`）→ `broadcastP2pDeviceLost`（`WifiP2pMonitor.java:277`）→ `P2P_DEVICE_LOST_EVENT` → `P2pStateMachine` 对应 case（`WifiP2pServiceImpl.java:3463`）调 `mPeers.remove(deviceAddress)` 把设备从名单上划掉，再广播 `WIFI_P2P_PEERS_CHANGED_ACTION`。

除了定时过期，还有一条淘汰路径：`p2p_create_device()`（`p2p.c:422`）在设备表项数超过 `max_peers`（默认 100，`p2p_supplicant.c:5147`）时，会先释放最久没更新的表项腾位置。两种移除都会触发 `P2P-DEVICE-LOST`——用户屏幕上"刚刚还在的人"消失，往往不是对方真的走了，只是它太久没在社交信道上露面，被定时清理划掉了。

相亲角的逻辑到这里形成了一个闭环：用户说"看看周围有谁"→ 管理处派人逛市场 → 每发现一个人就记到名单上 → 名单实时展示给用户看 → 逛够了就停止（但不销毁名单）。

把这条回传链路画成图，就是下面这张——从驱动 RX 一路到 mPeers 广播，右侧橙色虚线是名单上"划掉人"的反向清理链：

![设备发现结果回传链路](assets/11c-P2P%EF%BC%88%E4%B8%89%EF%BC%89%E8%AE%BE%E5%A4%87%E5%8F%91%E7%8E%B0%E5%85%A8%E9%93%BE%E8%B7%AF%E2%80%94%E2%80%94%E4%BB%8E%E5%8F%91%E7%8E%B0%E8%B7%AF%E7%94%B1%E5%88%B0-Probes-%E6%BB%A1%E5%A4%A9%E9%A3%9E/11c-peer-update.svg)

## 6.3 一张名片的三次登记：从 p2p_device 到 WifiP2pDevice

名片的同一份信息，在三层代码里被登记了三次：驱动把它当成一次普通 BSS 扫描结果，supplicant 把它整理成 `p2p_device` 表项，Framework 把它显示成 `WifiP2pDevice` 对象。三层各自用不同的数据结构装同一份信息，中间的字段映射值得单独拆开。

最下面一层其实最"省事"：驱动扫描到 Probe Response 后，并不认识 P2P IE——对它来说这只是一次 BSS 扫描结果：BSSID、频率、信号强度，加上一整段原始 IE 字节流。QCOM 的 `bss_description`、cfg80211 侧的 `struct wpa_scan_res`，装的都是这份"原始档案"，没有任何 P2P 专属字段的结构化提取。

真正把名片读成结构化信息的是 supplicant：`wpas_p2p_scan_res_handler()`（`p2p_supplicant.c:278`）从每个扫描结果里取出 IE 字节流，`p2p_parse_ies()` 解析出各属性，填入 `struct p2p_peer_info`（`p2p.h:380`）。此后字段的走向是固定的：

| P2P IE 里的字段     | supplicant `p2p_peer_info`                            | AIDL `onDeviceFound` 参数 | Framework `WifiP2pDevice`                                    |
| ------------------- | ----------------------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| P2P Device Address  | `info.p2p_device_addr[6]`（`p2p.h:384`）              | `p2pDeviceAddress`        | `deviceAddress`（String "aa:bb:..."，`WifiP2pDevice.java:66`） |
| Device Name         | `info.device_name[33]`（`p2p.h:394`）                 | `deviceName`              | `deviceName`（`:61`）                                        |
| Primary Device Type | `info.pri_dev_type[8]`（`p2p.h:389`）                 | `primaryDeviceType`       | `primaryDeviceType`（String 编码，`:83`）                    |
| Config Methods      | `info.config_methods`(u16)（`p2p.h:424`）             | `configMethods`           | `wpsConfigMethodsSupported`（`:129`）                        |
| Device Capability   | `info.dev_capab`(u8)（`p2p.h:429`）                   | `deviceCapabilities`      | `deviceCapability`（`:136`）                                 |
| Group Capability    | `info.group_capab`(u8)（`p2p.h:434`）                 | `groupCapabilities`       | `groupCapability`（`:143`）                                  |
| WFD 子元素          | `info.wfd_subelems`                                   | `wfdDeviceInfo`           | `wfdInfo`（`:156`）                                          |
| Listen Channel      | `listen_freq`(int)（存在 `p2p_device`，`p2p_i.h:66`） | —（不下发）               | —（`WifiP2pDevice` 无此字段）                                |

这张映射表由 Framework 侧 `SupplicantP2pIfaceCallbackAidlImpl.handleDeviceFound()`（`SupplicantP2pIfaceCallbackAidlImpl.java:954`）逐字段执行——AIDL 回调把 supplicant 的 `p2p_peer_info` 拆成平铺参数，Framework 再组装成 `WifiP2pDevice` 对象塞进 `mPeers`。

表里有三个值得驻足的落点：

1. **BSSID 不等于 P2P Device Address**——前者是这次帧从哪个接口发来的（可能是 P2P Interface Address），后者是设备跨频段的身份，来自 P2P IE 的 Device Info 属性。

2. **Listen Channel 止步于 supplicant**：`listen_freq` 存在 `struct p2p_device`，AIDL 回调不下发，`WifiP2pDevice` 也没有信道字段——Framework 只关心"有哪些设备"，不关心"设备在哪个信道等我"。等用户点 connect 时，Framework 只需把地址传回去，supplicant 拿地址查自己的 `p2p_device` 表——GO Negotiation 往哪个信道发，由 supplicant 自己攒的信道记忆决定（`p2p_prepare_channel_best()` 的 best_freq 优先级链，§3.4 讲过），Framework 全程不参与。

3. **两个能力位图是原样透传**：`dev_capab`/`group_capab` 逐字节搬进 `deviceCapability`/`groupCapability`，Framework 不解释，真正按 bit 解读发生在 App 层（比如判断对方支不支持 Concurrent Operation）。

## 6.4 发现中途关 WiFi：各层怎么收摊

上面讲的都是发现正常收尾。如果用户在看名单的当口把 Wi-Fi 关了，发现不会优雅地等到 120 秒超时——`DISABLE_P2P` 会触发一条和发现完全对称的收摊路径，三层按各自的方式清理。

Framework 层最先动手。`P2pEnabledState.processMessageImpl()` 收到 `DISABLE_P2P`（`WifiP2pServiceImpl.java:3253`）后按顺序做四件事：先 `mPeers.clear()` 清空 peer 列表并广播 `WIFI_P2P_PEERS_CHANGED_ACTION`——用户屏幕上的名单瞬间清空；再 `mGroups.clear()` 清持久化组；接着 `clearServicesForAllClients()` 清掉所有客户端的 service 记录；最后 `mWifiMonitor.stopMonitoring()` 停掉对 supplicant 事件回调的监听、`mWifiNative.teardownInterface()` 拆除 P2P 接口，状态机转入 `P2pDisablingState`。

注意这里没有 `p2pStopFind()`——接口直接拆掉，Find 随接口一起消失，不需要优雅地补一个 stop。`P2pDisablingState` 还挂了一个 5 秒的 `DISABLE_P2P_TIMED_OUT` 兜底定时器（`WifiP2pServiceImpl.java:2919`）：万一接口迟迟拆不掉，超时后强制进 `P2pDisabledState`，不让状态机卡在中间。

接口拆除经 HAL 落到 wpa_supplicant：管理接口被移除时 `wpas_p2p_deinit_iface()`（`p2p_supplicant.c:10351`）触发，因为移除的是 P2P 管理接口，走 `wpas_p2p_deinit_global()` → `p2p_deinit()`（`p2p.c:3115`）。`p2p_deinit` 里最关键的一步是 `p2p_flush()`（`p2p.c:3155`）：它**先调 `p2p_stop_find()` 把 Find 循环停掉，再遍历 `p2p->devices` 链表把每个 `p2p_device` 表项释放掉**。顺序不能反——先清登记簿再关循环会留下悬空引用。

整个过程中 supplicant 不会上抛 `P2P-FIND-STOPPED`——正常情况下这个事件由 `p2p_stop_find()` 的 `find_stopped` 回调产生，但接口拆除走的是 `p2p_deinit` 直接释放，而且 Framework 的 `mWifiMonitor` 已经停止监听，回调链根本走不到 P2pStateMachine。

两边的收摊顺序合起来看：Framework 先清 UI 名单再拆接口，supplicant 先停 Find 再释放设备表项——**都是从用户可见层向协议栈底层清理**。相亲角打烊时，先撤公告板上的名单，再收摊位，最后锁门。

---

# 7 全链路调用链回顾：discoverPeers 走完的每一段路

把前六节拆开的零件装回一整条链上，指令其实走了两趟：一趟正向把「看看周围有谁」从 App 一路传到驱动，一趟反向把发现结果从驱动一路报回名单。下面把两趟的每一站按代码调用链列出，函数名右侧是本文出现过的文件:行号。

## 7.1 正向链路：指令下发

```
Framework（Java）
  WifiP2pManager.discoverPeers()                       // WifiP2pManager.java:2229
    → AsyncChannel.sendMessage(DISCOVER_PEERS, ...)     // 投递到状态机线程
    → InactiveState.processMessageImpl()                // 不接单，冒泡给父状态
    → P2pEnabledState.processMessageImpl()              // WifiP2pServiceImpl.java:3310
        → p2pFind(120, WIFI_P2P_SCAN_FULL)              // :8576
        → WifiP2pNative.p2pFind()                       // WifiP2pNative.java:536
        → SupplicantP2pIfaceHal.find()                  // AIDL 跨进程
        → P2pIface::find → findInternal                 // p2p_iface.cpp:371 / :1058
          → wpas_p2p_find()                             // p2p_supplicant.c:7641
            → p2p_find()                                // p2p.c:1181（清场 + 设参）
              → 首次 Scan（P2P_FIND_START_WITH_FULL → P2P_SCAN_FULL）  // p2p.c:1276
              → Find 循环：Listen ⇄ Scan 交替
                → p2p_listen_in_find() → start_listen → NL80211_CMD_REMAIN_ON_CHANNEL
                → p2p_search() → p2p_scan → NL80211_CMD_TRIGGER_SCAN
                → p2p_continue_find() → 回 Listen
                → p2p_find_timeout() → p2p_stop_find()  // 120 秒收工
                  → P2P-FIND-STOPPED 事件上抛
QCOM 驱动（SCM 统一调度）
  → 扫描请求经 scan_req_id 路由回 P2P 模块
    → p2p_scan_start()                                  // wlan_p2p_roc.c:79（SCAN_TYPE_P2P_LISTEN）
    → p2p_scan_event_cb()                               // :964（STARTED / FOREIGN_CHANNEL / COMPLETED）
MTK 驱动（P2P Role FSM）
  → NL80211_CMD_REMAIN_ON_CHANNEL → mtk_cfg_remain_on_channel   // gl_cfg80211.c:7876
    → mtk_p2p_cfg80211_remain_on_channel               // gl_p2p_cfg80211.c:2585
    → MSG_P2P_CHNL_REQUEST → p2pDevFsmRunEventChannelRequest
    → P2P_ROLE_STATE_REQING_CHANNEL → p2pFuncAcquireCh()
    → P2P_ROLE_STATE_OFF_CHNL_TX → p2pFuncTxMgmtFrame()
```

## 7.2 反向链路：结果回报

```
Probe Response 驱动 RX
  → QCOM：tgt_scan_bcn_probe_rx_callback() → scm_handle_bcn_probe() → cfg80211_inform_bss_frame()
  → MTK：scanP2pProcessBeaconAndProbeResp() → kalP2PIndicateBssInfo() → cfg80211_inform_bss_frame()
  → NL80211_CMD_NEW_SCAN_RESULTS → wpas_p2p_scan_res_handler()    // p2p_supplicant.c:278
    → p2p_add_device() → p2p->devices 链表                        // p2p.c:733
    → wpas_notify_p2p_device_found()                              // notify.c:749
      → AIDL ISupplicantP2pIfaceCallback.onDeviceFound()
        → WifiP2pMonitor → P2pStateMachine
          → updateSupplicantDetails() → mPeers 更新
            → WIFI_P2P_PEERS_CHANGED_ACTION 广播
```

## 7.3 这条链上值得记住的三个节点

**每一层都在做防御。** Framework 做业务前置（InactiveState 冒泡到 P2pEnabledState 的权限/可用性检查），supplicant 做技术守卫（`p2p_disabled` / `p2p_in_provisioning` 三道检查），驱动做硬件仲裁（SCM 序列化排队）。任何一层放行，指令才继续往下走——这就是 §1.2 说的「Framework 不拦、supplicant 合并、驱动排队」三层防线。

**Listen ⇄ Scan 交替是协议约束，不是驱动实现细节。** Wi-Fi Direct 规范把「设备何时出现在社交信道上」定义为可预期的，p2p_find 的代码里没有 DBS 分支，QCOM/MTK 的驱动也只是照做。这解释了为什么 DBS 硬件也不能把一个 Find 的两个阶段同时做。

**信息在向上走时逐层丢失。** 驱动看到的只是一次 BSS 扫描结果（BSSID + 频率 + 原始 IE 字节流），supplicant 才解析出 P2P IE 结构并填进 `p2p_peer_info`，Framework 的 `WifiP2pDevice` 只保留 peer 列表需要的字段——Listen Channel 止步于 supplicant，Framework 全程不关心「设备在哪个信道等我」。

两条链合起来，就是相亲角完整的一轮营业：管理处（Framework）接单派活 → 跑腿工（supplicant）按 Find 循环交替逛摊位 → 驱动在信道上发收 Probes → 每张名片（P2P IE）被登记上名单（mPeers）→ 逛到 120 秒收工，名单保留。

---

# 8 名单拿到了，然后呢？

相亲角开门 → 接单 → 派人逛 → 收名片 → 贴名单——这篇文章追踪了一条横跨四层代码的完整消息路径。

我们从 Framework 的 `discoverPeers()` 出发，经过 InactiveState 状态检查、WifiP2pNative 委托、AIDL 跨进程调用，进入 supplicant 的 `wpas_p2p_find()`，追踪了 Find 循环的核心交替机制（Listen 阶段用 NL80211_CMD_REMAIN_ON_CHANNEL 蹲点，Scan 阶段通过 P2P Scan 递名片），拆解了 P2P IE 的 TLV 结构，最后在驱动侧看了 QCOM 的 RoC 机制和 MTK 的 FSM 信道管理，收口到 peer 列表更新和系统广播。

全程来看，每一层都在做自己最擅长的事：

- **Framework**：管理用户交互、状态机编排、广播通知——相亲角的管理处。
- **Supplicant**：P2P 协议栈的实现者——Find 循环的节奏掌控者。Listen/Scan 交替逻辑、超时管理、设备信息解析全在这里。
- **Driver**：无线电波的执行者——信道切换、帧收发、共存调度。

名单拿到了，看中了一个。下一篇，用户点击"连接"——GO Negotiation 三次握手怎么谈条件？Group Owner Intent 怎么决定谁当 GO？十级信道选择怎么比谁的方案更好？相亲角的"谈判桌"已经摆好了。

---

**源码仓库**：

- AOSP wpa_supplicant 8: [https://w1.fi/wpa_supplicant/](https://w1.fi/wpa_supplicant/)
- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- QCOM qcacld-3.0: [https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0](https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0)
- MTK kernel_modules-connectivity-wlan-core-gen4m (MTK 内核模块仓库)

**相关规范**：Wi-Fi Alliance, "Wi-Fi Direct Specification v2.0"
