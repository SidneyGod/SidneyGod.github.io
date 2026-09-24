---
title: P2P（二）初始化（下）——Supplicant 与驱动初始化
top: 1
related_posts: true
abbrlink: 1cdf4504
date: 2026-09-23 08:07:25
tags:
  - Android WiFi
  - P2P
categories:
  - WiFi
  - Code
---

> 相亲角的电话线接通了，现在是时候印制名片、摆好档案柜、雇跑腿了。本文追踪从 Framework 层的 SUP_CONNECTION_EVENT 到达，到 wpa_supplicant 的 P2P 模块完整初始化（p2p_data 就绪、35 个回调注册、P2P Device Address 生成），再到 QCOM 和 MTK 驱动各自拉起 P2P 组件的全过程。

---

# 本章导读

上一篇我们看着相亲角的管理处（`P2pStateMachine`）挂牌了，场地（p2p0 接口）辟好了，电话线（`ISupplicantP2pIface `的 AIDL 通道）也接通了。但这个相亲角目前只是一间空屋子——没有名片、没有档案柜、没有跑腿的人。真正干活的东西，都在 supplicant 和驱动里面。

<!--more-->

本文从这里开始：`WifiP2pMonitor` 通过 AIDL 回调收到 supplicant 连接就绪的信号，向 `P2pStateMachine `发送 `SUP_CONNECTION_EVENT`。状态机从 `P2pDisabledState `跳转到 `P2pEnabledState`，在 `enterImpl()` 中触发一系列 AIDL 调用下发到 supplicant。而 supplicant 端，P2P 模块的初始化早在 p2p0 接口被 `addP2pInterface()` 注册时就已经完成——`wpas_p2p_init()` 印制了"名片"（35 个回调注册），`p2p_init()` 搭好了"档案柜"（`p2p_data `结构体），P2P Device Address 就是名片上的联系方式。

驱动层也不闲着。在 QCOM 平台上，`cds_enable()` 阶段就通过 `p2p_psoc_enable()` 拉起了 P2P component，向 lmac 注册 RX ops、向 WMI 注册 NOA 事件处理器、向 obj_mgr 注册 psoc/vdev/peer 生命周期回调——相当于雇好了一个专职跑腿。MTK 平台则通过 `p2pLaunch()` 创建 net_device、初始化 P2P Role FSM，用状态机来管理 P2P 角色切换——是另一个风格的跑腿工。

本文停在这样一个位置：supplicant 的 p2p_data 就绪，驱动的 P2P component 启用完毕，相亲角开门了，但还没有人开始逛。设备发现、GO 协商、组创建这些真正热闹的场景，留给下一篇。

本文聚焦 supplicant 的 wpas_p2p_init / p2p_init 和驱动（QCOM + MTK）的 P2P component 初始化。不涉及设备发现（Find 循环）、GO 协商、Provision Discovery 或组创建——这些留到后续章节。Framework 层的状态机和 HAL 接口创建已在上一篇完整覆盖。

在逐层展开之前，先用一张全景分层架构图把本次追踪涉及的软件层、调用链方向与跨进程边界（Binder / AIDL / nl80211）一次摆清楚：

![P2P 初始化（下）supplicant 驱动全链路分层架构](assets/11b-P2P%EF%BC%88%E4%BA%8C%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8B%EF%BC%89%E2%80%94%E2%80%94Supplicant-%E4%B8%8E%E9%A9%B1%E5%8A%A8%E5%88%9D%E5%A7%8B%E5%8C%96/11b-overview.svg)

---

# 1 SUP_CONNECTION_EVENT 到达后，谁先响应？

答案藏在状态转移的时序里：Android StateMachine 框架在转移时会先执行父状态 P2pEnabledState 的 `enterImpl()`，而 SUP_CONNECTION_EVENT 早在它执行之前就已进入消息队列。上一篇的结尾，`setupInterface()` 成功返回后，P2pDisabledState 通过 smTransition 跳转到了 InactiveState——正是这次转移触发了父状态的 `enterImpl()`。

这条消息的来源是 `WifiP2pMonitor.startMonitoring()`。上一篇 §4.9 已经给出并逐行分析过它的完整实现——注册完 23 个事件类型的 handler 后，立即同步发送一条 SUP_CONNECTION_EVENT，代码不再重复。这里只需记住结果：这条事件进入 P2pStateMachine 的消息队列后，在初始化阶段到达 DefaultState 被静默消费（break）——因为 supplicant 的连接状态在 `setupInterface()` 中已经确认过了，不需要再做额外处理。

这个事件的语义要分两侧看："supplicant 连接已建立"意味着从这一刻起，Framework 和 supplicant 之间的双向 AIDL 通道正式贯通。之前 `setupInterface()` 里的 `waitForSupplicantConnection()` 只是从 Framework 侧确认了 supplicant daemon 已启动并注册了 AIDL 服务。而 SUP_CONNECTION_EVENT 是从 WifiP2pMonitor 侧宣告"回调通道已就绪"——supplicant 现在可以通过 AIDL callback 反向通知 Framework 了。

如果说上一篇的 `setupInterface()` 是把电话机装好了，那 SUP_CONNECTION_EVENT 就是第一声拨号音——话机到交换机的线路通了。

这个事件在后续运行中还有一个重要作用：当 supplicant 进程崩溃后重启重连时，SUP_CONNECTION_EVENT 会再次被发送，触发 P2pEnabledState 重新评估是否需要恢复到启用状态。但在初始化阶段，它的主要意义就是宣告通信双工。

现在，`P2pEnabledState.enterImpl()` 开始执行——相亲角的管理处正式上班了。

---

# 2 wpas_p2p_init 是怎么"印制名片"的？

在 Framework 层，我们看到的是一系列 AIDL 调用：setDeviceName、setP2pSsidPostfix、setP2pDeviceType、setConfigMethods……这些调用跨进程到达 wpa_supplicant daemon 后，supplicant 内部的 ISupplicantP2pIface AIDL 服务实现（p2p_iface.cpp）负责将它们写入 wpa_s->conf 配置结构体。但真正的 P2P 模块初始化，发生在更早的时刻——当 Framework 调用 `ISupplicant.addP2pInterface("p2p0")` 时。

这个 AIDL 调用在 supplicant 内部并不是一步直达的，中间隔着三层：`ISupplicant.addP2pInterface()` 的实现 `addP2pInterfaceInternal()`（supplicant.cpp:349）校验参数后调用 `wpa_supplicant_add_iface()`（wpa_supplicant.c:7885），后者为该接口分配 wpa_supplicant 结构体后进入 `wpa_supplicant_init_iface()`（wpa_supplicant.c:7310）做接口的基础初始化——`wpas_p2p_init()` 正是在这个函数末尾（wpa_supplicant.c:7637）被调用的。可以说，wpas_p2p_init 是 P2P 模块在 supplicant 内部的"出生证明"——它不是 Framework 配置下发的一部分，而是 supplicant 在拿到 p2p0 接口、完成接口基础初始化之后自发触发的一次 P2P 专属初始化。

入口在 p2p_supplicant.c：

```c
// wpa_supplicant/p2p_supplicant.c:4994
int wpas_p2p_init(struct wpa_global *global, struct wpa_supplicant *wpa_s)
{
    struct p2p_config p2p;
    int i;

    if (wpa_s->conf->p2p_disabled)
        return 0;

    if (!(wpa_s->drv_flags & WPA_DRIVER_FLAGS_P2P_CAPABLE))
        return 0;

    if (global->p2p)
        return 0;

    if (wpas_p2p_mac_setup(wpa_s) < 0) {
        wpa_msg(wpa_s, MSG_ERROR,
            "Failed to initialize P2P random MAC address.");
        return -1;
    }
    // ... 继续初始化 ...
}
```

第一段代码就先展示了三层守卫：

1. **p2p_disabled**：用户可以显式在 wpa_supplicant.conf 中设置 `p2p_disabled=1` 来禁用 P2P。这个开关独立于 WiFi 开关——即使 STA 模式正常使用，P2P 也可以被禁用。
2. **P2P_CAPABLE 驱动标志**：并不是所有 WiFi 芯片都支持 P2P。wpa_supplicant 在初始化接口时查询驱动的 capability flags，如果 `WPA_DRIVER_FLAGS_P2P_CAPABLE` 没有被置位，P2P 模块根本不会启动。
3. **单例检查**：`global->p2p` 在整个 wpa_supplicant 进程中只能有一个——如果已经初始化过（比如另一个接口先触发了），直接返回。这保证了一台设备只有一个 P2P 模块实例。

三层守卫都通过后，才会进入真正的初始化：先调 `wpas_p2p_mac_setup()` 搞定 P2P Device Address（第 5 节详述），然后——也是 wpas_p2p_init 最核心的工作——填充 struct p2p_config 并调用 `p2p_init()`。

这是 struct p2p_config 的填充过程。它在栈上声明了一个局部变量 `struct p2p_config p2p`，清零后逐一赋值：

```c
// wpa_supplicant/p2p_supplicant.c:5014
os_memset(&p2p, 0, sizeof(p2p));
p2p.cb_ctx = wpa_s;

// 注册下层驱动操作的回调
p2p.p2p_scan = wpas_p2p_scan;
p2p.send_action = wpas_send_action;
p2p.send_action_done = wpas_send_action_done;
p2p.start_listen = wpas_start_listen;
p2p.stop_listen = wpas_stop_listen;
p2p.send_probe_resp = wpas_send_probe_resp;
p2p.get_noa = wpas_get_noa;

// 注册向上通知事件回调
p2p.go_neg_completed = wpas_go_neg_completed;
p2p.go_neg_req_rx = wpas_go_neg_req_rx;
p2p.dev_found = wpas_dev_found;
p2p.dev_lost = wpas_dev_lost;
p2p.find_stopped = wpas_find_stopped;
p2p.sd_request = wpas_sd_request;
p2p.sd_response = wpas_sd_response;
p2p.prov_disc_req = wpas_prov_disc_req;
p2p.prov_disc_resp = wpas_prov_disc_resp;
p2p.prov_disc_fail = wpas_prov_disc_fail;
p2p.invitation_process = wpas_invitation_process;
p2p.invitation_received = wpas_invitation_received;
p2p.invitation_result = wpas_invitation_result;
p2p.go_connected = wpas_go_connected;
p2p.presence_resp = wpas_presence_resp;
// ... 共 35 个回调 ...
```

这些回调构成了 P2P 模块与外部世界交互的完整接口。p2p_data 模块是纯协议的——它只管 P2P 协议状态机、帧的构建与解析。它不知道"怎么发一个 Action 帧到空气中"，也不知道"发现了一个设备后要通知谁"。所有需要与驱动或上层交互的操作，全部通过这些回调函数指针来完成。

这就是"名片"的含义：wpas_p2p_init 把 supplicant 中的所有 P2P 相关能力打包成一张名片（p2p_config），递给 `p2p_init()`——"这是我能提供的所有服务，你用这些联系方式来找我。"

填充完回调后，wpas_p2p_init 继续填充设备信息：

```c
// wpa_supplicant/p2p_supplicant.c:5054
os_memcpy(wpa_s->global->p2p_dev_addr, wpa_s->own_addr, ETH_ALEN);
os_memcpy(p2p.dev_addr, wpa_s->global->p2p_dev_addr, ETH_ALEN);
p2p.dev_name = wpa_s->conf->device_name;
p2p.manufacturer = wpa_s->conf->manufacturer;
p2p.model_name = wpa_s->conf->model_name;
p2p.model_number = wpa_s->conf->model_number;
p2p.serial_number = wpa_s->conf->serial_number;
```

device_name、manufacturer、model_name 这些字符串在 Probe Request/Response 的 P2P IE 中出现，是对方设备能在扫描结果中看到的"相亲者简介"。

同时，设备类型（pri_dev_type）也从 `wpa_s->conf->device_type` 复制过来——这个字段正是 Framework 通过 `setP2pDeviceType` 下发、WPS 使用的设备类型（p2p_supplicant.c:5137）。它是一个 8 字节的 WPS 设备类型编码，格式是「category(2B)-OUI(4B)-subcategory(2B)」，比如手机通常是 `10-0050F204-5`。

主设备类型旁边还有**辅助设备类型**：`p2p.num_sec_dev_types` 取 `wpa_s->conf->num_sec_device_types`，`p2p.sec_dev_type` 数组从 `wpa_s->conf->sec_device_type` 整体复制（p2p_supplicant.c:5140-5141）。

辅助类型最多 5 个（p2p.h 的 `P2P_SEC_DEVICE_TYPES`），会写进 Probe Request 里 P2P 属性（P2P Device Info）的 Secondary Device Type List——告诉对方"我除了主要类型，还能充当这些角色"，比如手机主类型是 `10-0050F204-5`，辅助类型可以声明 `1-0050F204-1`（Computer）。

最后，p2p_init() 被调用：

```c
// wpa_supplicant/p2p_supplicant.c:5196
global->p2p = p2p_init(&p2p);
if (global->p2p == NULL)
    return -1;
global->p2p_init_wpa_s = wpa_s;
```

返回值是一个 `struct p2p_data *`，存入 `global->p2p`。同时 `global->p2p_init_wpa_s` 记录了"是哪个 wpa_s 发起的初始化"——后续 P2P 操作（如设备发现、GO 协商）通过这个指针找到对应的 wpa_supplicant 实例。

如果 p2p_init() 返回 NULL，wpas_p2p_init 返回 -1。这条错误会一路向上传：调用方 `wpa_supplicant_init_iface` 在 wpa_supplicant.c:7637 检查到负值直接 return -1；AIDL 层 `addP2pInterface()`（supplicant.cpp:349 的 addP2pInterfaceInternal）包装失败返回 `SupplicantStatusCode::FAILURE_UNKNOWN`；Framework 侧 `WifiP2pNative.setupInterface()` 拿到 null 后 P2P 使能流程终止——名片没印成，相亲角不开门。

如果到这里一切顺利，wpas_p2p_init 还会做两件收尾的事：添加 WPS 厂商扩展（Vendor Extension）、设置 P2P 禁止作为 GO 的频率列表。然后返回 0——名片印制完成，档案柜该上场了。

---

# 3 p2p_init() 内部搭了个什么样的"档案柜"？

如果说 wpas_p2p_init 是"印名片"，那 `p2p_init()` 就是"购置和布置档案柜"——把所有相亲者的信息收纳在 struct p2p_data 这个核心数据结构里。

`p2p_init()` 位于 src/p2p/p2p.c，是 P2P 协议模块的真正入口。它与调用方（wpa_supplicant）之间唯一的耦合就是 struct p2p_config——config 进去，p2p_data 出来。

```c
// src/p2p/p2p.c:3047
struct p2p_data * p2p_init(const struct p2p_config *cfg)
{
    struct p2p_data *p2p;

    if (cfg->max_peers < 1 ||
        cfg->passphrase_len < 8 || cfg->passphrase_len > 63)
        return NULL;

    p2p = os_zalloc(sizeof(*p2p) + sizeof(*cfg));
    if (p2p == NULL)
        return NULL;
    p2p->cfg = (struct p2p_config *) (p2p + 1);
    os_memcpy(p2p->cfg, cfg, sizeof(*cfg));
```

第一眼看到的是内存布局的设计选择：`os_zalloc(sizeof(*p2p) + sizeof(*cfg))`——单次内存分配容纳 p2p_data 和 p2p_config 两个结构体，p2p_config 紧跟在 p2p_data 后面。p2p->cfg 指向 p2p_data 后面的内存空间，然后用 memcpy 把调用方传来的整个 config（含 35 个回调函数指针）拷贝进去。整块内存的布局长这样：

![p2p_init() 内存布局：单次 os_zalloc + strdup 游离](assets/11b-P2P%EF%BC%88%E4%BA%8C%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8B%EF%BC%89%E2%80%94%E2%80%94Supplicant-%E4%B8%8E%E9%A9%B1%E5%8A%A8%E5%88%9D%E5%A7%8B%E5%8C%96/11b-p2p-init-memory-1790122314082-4.svg)

左栏是栈上的源配置 `struct p2p_config p2p`（wpas_p2p_init 的局部变量），中间绿色大块是单次 os_zalloc 得到的整块内存——上半是 p2p_data，下半尾部紧邻的是拷贝进来的 cfg；紫色和橙色两块是独立的堆分配：字符串字段通过 os_strdup 游离出去，devices 链表则单独维护一个空 head。

为什么这样设计？三个理由叠加：

- **生命周期绑定**：p2p_data 和它的配置同生共死。`p2p_deinit()` 只需一次 `free(p2p)`，配置自然跟着释放——不会出现"p2p_data 还在但配置已被释放"的悬空指针问题。
- **缓存局部性**：P2P 协议状态机频繁读写 p2p->cfg 中的字段（如 channels、dev_capab），把它们放在同一块内存上减少 cache miss。
- **分配器友好**：一次 os_zalloc 比两次小分配更高效，也避免了"分配 p2p_data 成功但分配 cfg 失败"的半初始化状态。

但随后，config 中的字符串字段（dev_name、manufacturer 等）被单独 strdup——因为传入的 config 是栈上变量，wpas_p2p_init 返回后栈就释放了。而字符串内容需要长期存活。

接下来是一系列默认值的设定：

```c
// src/p2p/p2p.c:3083
p2p->min_disc_int = 1;
p2p->max_disc_int = 3;
p2p->max_disc_tu = -1;

if (os_get_random(&p2p->next_tie_breaker, 1) < 0)
    p2p->next_tie_breaker = 0;
p2p->next_tie_breaker &= 0x01;

if (cfg->sd_request)
    p2p->dev_capab |= P2P_DEV_CAPAB_SERVICE_DISCOVERY;
p2p->dev_capab |= P2P_DEV_CAPAB_INVITATION_PROCEDURE;
if (cfg->concurrent_operations)
    p2p->dev_capab |= P2P_DEV_CAPAB_CONCURRENT_OPER;
p2p->dev_capab |= P2P_DEV_CAPAB_CLIENT_DISCOVERABILITY;

dl_list_init(&p2p->devices);

p2p->go_timeout = 100;
p2p->client_timeout = 20;
p2p->num_p2p_sd_queries = 0;
if (!p2p->cfg->comeback_after)
    p2p->cfg->comeback_after = 977; /* TUs */
```

逐项拆解这些默认值的设计意图：

**发现间隔参数（min_disc_int / max_disc_int）**：P2P 规范定义了两个"发现间隔"——设备在两次 Listen 之间的最小和最大间隔（以 100 TU 为单位）。min_disc_int=1 表示至少要等 100 TU（约 102ms），max_disc_int=3 表示最多等 300 TU（约 307ms）。设备在这个范围内随机选一个值，避免多个设备在完全相同的时间点进入 Listen 状态造成互相听不见。max_disc_tu=-1 表示不强制上限。

**Tie Breaker（next_tie_breaker）**：一个随机比特。在 GO Negotiation 中，当双方的 GO Intent 打成平手时（比如双方都设为 7），这个比特决定谁当 GO。它的熵源是 os_get_random()——在 Linux 上打开 /dev/urandom 读入一个字节（src/utils/os_unix.c:259），p2p_init 只取其中最低 1 位（`& 0x01`）。但这个比特不是每次协商都重新随机：P2P 规范要求第一次 GO Negotiation Request 随机取 0 或 1、之后的 Request（除重传外）逐次翻转、Response 中的 Tie breaker 位从对应 Request 翻转而来。wpa_supplicant 的实现逐条对应：p2p_connect() 发起协商时把当前 next_tie_breaker 赋给对端设备、然后立刻翻转（p2p.c:1680-1681），作为 GO Intent 属性字节的最低 1 位发出（p2p_go_neg.c:352 的 `(go_intent << 1) | tie_breaker`）；对端解析请求时读出该位（p2p_go_neg.c:847 的 `*msg.go_intent & 0x01`），回 Response 时用 `!tie_breaker` 翻转回去（p2p_go_neg.c:1122）。

这套"请求随机、后续翻转、响应必反"的规则就是协议层的防碰撞设计。正常的 GO Negotiation 是单向发起：发起方带一个位，响应方把它翻转回去，于是双方看到的 Tie breaker 位必然互补（一个 0 一个 1）。Intent 相同时规范规定"发送 Tie breaker=1 的一方成为 GO"——wpa_supplicant 的 `p2p_go_det()` 正是这样判定（对端带 1 就自己让出，p2p_go_neg.c:21-32），双方对"谁当 GO"的判断天然一致，永远不会出现都以为自己是 GO 的冲突。

真正的碰撞只剩一种场景：双方几乎同时发起 Request，两个 Request 里的位各自独立，可能恰好相同——两个 0 让双方都算出自己该当 GO，两个 1 让双方都算出对方当 GO，协商以失败告终。随机初始位把"首次相遇"的碰撞概率压到 50%，重试时双方又各自使用已翻转的位再比一次。另外还有一个不使用随机决胜的兜底：当双方 GO Intent 都到 15（"我必须是 GO"）时，`p2p_go_det()` 直接返回 -1，协商以 P2P_SC_FAIL_BOTH_GO_INTENT_15 失败——强制 GO 意图的冲突不该交给随机数裁决。

**设备能力（dev_capab）**：一个位掩码，告诉对方"我能干什么"：

- `P2P_DEV_CAPAB_SERVICE_DISCOVERY`：支持服务发现（能在连接前就知道对方提供什么服务，如 Miracast、打印）
- `P2P_DEV_CAPAB_INVITATION_PROCEDURE`：支持邀请流程（能把对方拉入已存在的 P2P 组）
- `P2P_DEV_CAPAB_CONCURRENT_OPER`：支持并发操作（P2P 和 STA 同时在线）
- `P2P_DEV_CAPAB_CLIENT_DISCOVERABILITY`：作为 Client 时仍能被其他设备发现

这些标志位最终会被写入 P2P IE 的 Capability 字段，在 Probe Response 和 Beacon 中宣告。

**devices 链表**：`dl_list_init(&p2p->devices)` 初始化一个空的双向循环链表——这就是"档案柜的抽屉"。之后每发现一个 P2P 设备（通过扫描收到对方的 Probe Response 或 Beacon），就会创建一个 struct p2p_device 节点插入这个链表。每个节点记录对方的 P2P Device Address、Device Name、支持的 WPS Config Methods、最后一次被看到的时间戳等信息。

初始化时链表是空的——意味着相亲角虽然开门了，但还没人登记。

devices 链表是**数据**，而 p2p_config 是**配置**——两者的生命周期完全不同。p2p_config 描述的是"这个 P2P 实例怎么和外部世界打交道"：回调函数指针、dev_addr、device_name、信道列表，这些在 `p2p_init()` 时一次性拷贝进 p2p_data 尾部的内存块，之后基本不再变化（唯一例外是上面刚提到的 comeback_after 默认值填充）。而 devices 链表是运行时**状态**：每发现一个对端就插入一个节点、每超时一个对端就摘掉一个节点，它随设备发现过程持续增长和收缩。把这两种不同生命周期的东西分开，正是"配置与数据分离"的架构原则——配置只描述"静态契约"（这个模块能干什么、回调是谁），数据承载"动态事实"（当前认识了哪些对端、它们各自的状态）。

如果硬要把 devices 塞进 p2p_config，config 就失去了"初始化时定型、之后只读"的语义，p2p_init 里 `os_memcpy(p2p->cfg, cfg, sizeof(*cfg))` 的整块拷贝也失去了意义——链表头可以拷，但链表节点是运行时才有的。所以 p2p_data 里 `struct p2p_config *cfg` 指针与 `struct dl_list devices` 各占一席，前者指向静态配置、后者指向动态状态，互不干扰。

**超时参数（go_timeout / client_timeout）**：100 和 20 不是"超时秒数"，而是 P2P 帧中 Configuration Timeout 属性的两个八位组值。P2P 规范 §4.1.7 定义了这个属性：GO Configuration Timeout 八位组表示"发送方成为 GO 并完成配置需要的时间"，Client Configuration Timeout 八位组表示"发送方成为 Client 需要的时间"，单位都是 10 毫秒。所以 go_timeout=100 意味着本机成为 GO 需要约 1000ms（1 秒），client_timeout=20 意味着本机成为 Client 需要约 200ms——不是 100 TU 和 20 TU，单位差着一个量级。

这两个值是 wpa_supplicant 的默认值，不是 P2P 规范强制要求的取值（规范只定义属性格式，允许设备按自身能力上报）。5 倍的落差本身就有协议层面的理由：成为 GO 的一方要完成一整套组创建动作——拉起 AP 接口、开始 Beacon 定时发送、初始化 WPS Registrar——这是"重活"；成为 Client 的一方只需要扫描到 GO 的 Beacon、关联、以 WPS Enrollee 身份完成握手——这是"轻活"。所以设备自我评估时，给 GO 预留的时间远大于给 Client 的。

交换时这对值不是给自己看的，而是给对方做等待预算的：协商完成后，成为 GO 的一方要等对端以 Client 身份加入，等待上限取对端的 client_timeout（对端说 200ms 就到）；成为 Client 的一方要等对端把 GO 拉起来，等待上限取对端的 go_timeout（对端说需要最多 1 秒）。wpa_supplicant 在协商结果里正是这样取值的：`res.peer_config_timeout = go ? peer->client_timeout : peer->go_timeout`（p2p.c:1907）——自己是 GO 就等对端的 client_timeout，自己是 Client 就等对端的 go_timeout。如果 go_timeout 设得太长，Client 慢悠悠地连，整个发现过程中的其他设备都要跟着等；设得太短，Client 可能在 Group Formation 阶段超时失败。

**comeback_after**：977 TU 约等于 1 秒。这个默认值在 Bootstrap（DIRA 配对的初始握手）中使用——如果对方暂时不想响应 Bootstrap 请求（比如正忙），就在响应中带上这个"请 X TU 后再来"的值。

最后，`p2p_pairing_info_init()` 初始化与 DPP/DIRA 配对的内部数据结构，`p2p_channels_dump()` 往日志中打印支持的信道列表——全是调试日志，不改变功能。p2p_init 的返回值就是已填充的 p2p_data 指针，存入 global->p2p。

此时 p2p_data 的状态字段是 P2P_IDLE（因为 os_zalloc 清空了内存，而 enum 的第一个值就是 0，即 P2P_IDLE）。这个状态意味着：P2P 模块就绪，等待第一个命令。

---

# 4 那 35 个回调各自管什么事？

上一节说 p2p_config 是"名片"，记录了 P2P 模块能调用的所有外部函数。这 35 个回调（wpa_supplicant 8 的当前版本已扩展到 35 个，早期版本约 26 个）可以分为两组：一组是 **下层驱动操作**——P2P 模块需要把帧发出去、需要扫描、需要进入 Listen 状态；另一组是 **向上通知事件**——P2P 模块需要告诉上层"发现了一个设备""GO 协商完成了""有人发了 Provision Discovery 请求"。

用相亲角的比喻：第一组是"前台操作"——去全场转一圈（扫描）、站在摊位前等（Listen）、传纸条（发 Action 帧）。第二组是"后台电话通知"——发现新相亲者了、有人来谈条件了、身份验证请求到了。两组的分工和各自去向，先看一张图：

![p2p_data 的 35 个回调两组分工](assets/11b-P2P%EF%BC%88%E4%BA%8C%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8B%EF%BC%89%E2%80%94%E2%80%94Supplicant-%E4%B8%8E%E9%A9%B1%E5%8A%A8%E5%88%9D%E5%A7%8B%E5%8C%96/11b-callbacks.svg)

先说第一组——下层驱动操作回调：

| 回调               | 类型签名                                                     | 职责                                                         |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `p2p_scan`         | `int (*)(void *ctx, enum p2p_scan_type, int freq, ...)`      | 触发全信道/社交信道扫描，相当于派人去全场转一圈收集信息      |
| `start_listen`     | `int (*)(void *ctx, unsigned int freq, unsigned int duration, ...)` | 进入 Listen 状态，在指定信道上停留一段时间等待 Probe Request |
| `stop_listen`      | `void (*)(void *ctx)`                                        | 退出 Listen 状态                                             |
| `send_action`      | `int (*)(void *ctx, unsigned int freq, const u8 *dst, ...)`  | 发送 Action 帧——GO Negotiation、Provision Discovery、Invitation 都走这条通道 |
| `send_action_done` | `void (*)(void *ctx)`                                        | Action 帧序列完成通知                                        |
| `send_probe_resp`  | `int (*)(void *ctx, const struct wpabuf *buf, unsigned int freq)` | 在 Listen 状态下回复 Probe Response 帧                       |
| `get_noa`          | `int (*)(void *ctx, const u8 *interface_addr, u8 *buf, size_t buf_len)` | 获取 GO 当前的 Notice of Absence（离开通知），用于告诉对方"我暂时不在" |

这几个回调覆盖了 P2P 协议交互的全套物理层操作。它们的调用方都在 p2p.c 的协议状态机里：

- `p2p_scan` 由 `p2p_search()`（p2p.c:1028）在 Find 循环的 Search 阶段触发，也由 `p2p_find()`（p2p.c:1181）入口调用
- `start_listen`/`stop_listen` 由 `p2p_listen_in_find()`（p2p.c:258）和 `p2p_stop_find_for_freq()`（p2p.c:1328）成对驱动——进入 Listen 蹲守、退出 Listen 收工
- `send_action` 由 `p2p_send_action()`（p2p.c:5082）触发，`send_action_done` 也在它的收尾路径上回调
- `send_probe_resp` 由收到 Probe Request 时的 `p2p_reply_probe()`（p2p.c:2395）调用
- `get_noa` 则在组协商/Beacon 构建时由需要 NOA 属性的路径调用（p2p.c:4672 附近）

其中 `send_action` 是最忙碌的一个——GO Negotiation Request/Response/Confirmation、Provision Discovery Request/Response、Invitation Request/Response 全部走 Action 帧，通过这一个回调下发到驱动。驱动不知道帧的内容是什么，只知道"这是一帧需要发送的管理帧，目标地址是 XX，在信道 X 上发送"。

相比之下，`send_probe_resp` 的使用场景狭窄得多——只在 Listen 阶段、收到 Probe Request 时，构建并回复 Probe Response。而且它不是必需的：如果驱动自己能在固件侧生成 Probe Response（很多 QCOM/MTK 芯片支持），这个回调可以为 NULL。

再说第二组——向上通知事件回调：

| 回调                           | 类型签名                                                     | 职责                                                         |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `dev_found`                    | `void (*)(void *ctx, const u8 *addr, const struct p2p_peer_info *info, int new_device)` | 发现了一个 P2P 设备——可能是扫描到的，也可能是收到对方的 Probe Request |
| `dev_lost`                     | `void (*)(void *ctx, const u8 *dev_addr)`                    | 一个之前发现的设备从列表中移除（太久没出现）                 |
| `find_stopped`                 | `void (*)(void *ctx)`                                        | P2P Find 操作已停止                                          |
| `go_neg_req_rx`                | `void (*)(void *ctx, const u8 *src, u16 dev_passwd_id, u8 go_intent)` | 收到 GO Negotiation Request——对方想谈判谁来当 GO             |
| `go_neg_completed`             | `void (*)(void *ctx, struct p2p_go_neg_results *res)`        | GO Negotiation 完成——下一步是创建组接口                      |
| `sd_request`                   | `void (*)(void *ctx, int freq, const u8 *sa, u8 dialog_token, ...)` | 收到 Service Discovery 请求——"你提供什么服务？"              |
| `sd_response`                  | `void (*)(void *ctx, const u8 *sa, u16 update_indic, ...)`   | 收到 Service Discovery 响应——"我提供 Miracast 投屏"          |
| `prov_disc_req`                | `void (*)(void *ctx, const u8 *peer, u16 config_methods, ...)` | 收到 Provision Discovery 请求——对方想确认配网方式（PIN 还是 Push Button） |
| `prov_disc_resp`               | `void (*)(void *ctx, const u8 *peer, u16 config_methods)`    | Provision Discovery 响应到达                                 |
| `prov_disc_fail`               | `void (*)(void *ctx, const u8 *peer, enum p2p_prov_disc_status, ...)` | Provision Discovery 失败                                     |
| `invitation_process`           | `u8 (*)(void *ctx, const u8 *sa, const u8 *bssid, ...)`      | 处理邀请请求——自动恢复持久组的核心                           |
| `invitation_received`          | `void (*)(void *ctx, const u8 *sa, const u8 *bssid, ...)`    | 收到邀请请求并已回复                                         |
| `invitation_result`            | `void (*)(void *ctx, int status, const u8 *bssid, ...)`      | 邀请流程（我方发起的）结果通知                               |
| `go_connected`                 | `int (*)(void *ctx, const u8 *dev_addr)`                     | 检查是否已作为 Client 连接到一个 GO                          |
| `is_concurrent_session_active` | `int (*)(void *ctx)`                                         | 检查是否有并发会话（STA 或其他 P2P 组）正在活动              |
| `is_p2p_in_progress`           | `int (*)(void *ctx)`                                         | 检查是否有 P2P 操作正在进行中                                |
| `get_persistent_group`         | `int (*)(void *ctx, const u8 *addr, ...)`                    | 查找与指定对端共享的持久组配置                               |
| `get_go_info`                  | `int (*)(void *ctx, u8 *intended_addr, ...)`                 | 获取本地可能作为 GO 的信息                                   |
| `get_pref_freq_list`           | `int (*)(void *ctx, int go, unsigned int *len, ...)`         | 从驱动获取信道偏好列表，影响 GO Negotiation 的信道选择       |

第二组回调的触发点在协议栈的各个帧处理函数里：

- `dev_found` 由 `p2p_add_device()`（p2p.c:733，处理扫描结果和 Probe Request）和 `p2p_add_dev_info()`（p2p.c:1768，收到含 P2P IE 的管理帧）触发——"发现新相亲者"
- `dev_lost` 由 `p2p_device_free()`（p2p.c:937）在设备超时清理时触发
- `find_stopped` 由 `p2p_stop_find_for_freq()`/`p2p_stop_find()` 在 Find 循环结束时触发
- `go_neg_req_rx` 由 `p2p_process_go_neg_req()`（p2p_go_neg.c:823）在收到 GO Negotiation Request 时触发
- `go_neg_completed` 由 `p2p_go_complete()`（p2p.c:1857）在协商成功落定时触发
- `sd_request`/`sd_response` 由 `p2p_rx_gas_initial_req()`/`p2p_rx_gas_initial_resp()`（p2p_sd.c:326/480）触发
- `prov_disc_req`/`prov_disc_resp` 由 `p2p_process_prov_disc_req()`/`p2p_process_prov_disc_resp()`（p2p_pd.c:882/1723）触发
- `invitation_process` 由 `p2p_process_invitation_req()`（p2p_invitation.c:184）触发

每个回调触发后，wpa_supplicant 侧的 `wpas_*` 实现通过 `wpas_notify_*` 通知链把事件上抛给 Framework（如 wpas_dev_found 内部调 wpas_notify_p2p_device_found，p2p_supplicant.c:2668，最终在 Framework 侧变成 WifiP2pMonitor 的 P2P_DEVICE_FOUND_EVENT）。

如果只看代码，这无非是一堆函数指针的赋值。但如果你退一步想"这些回调如果少了某一个会怎样"，它们的职责就立体了。

比如，如果没有 `dev_found`，P2P 模块在扫描结果中发现了一个 P2P 设备，但它无法通知上层——上层永远不会知道"有人出现了"。没有 `go_neg_req_rx`，当对端发起 GO Negotiation 时，P2P 模块可以处理帧，但上层不知道该弹窗让用户确认——用户完全被蒙在鼓里。没有 `invitation_process`，持久组自动恢复机制就废了——每次重新连接都要走完整的 GO Negotiation + Provision Discovery + WPS，而不是一条 Invitation Request/Response 搞定。

从设计模式的角度，这 35 个回调构成了一个标准的**依赖反转**：P2P 协议模块（p2p.c）不依赖具体的 wpa_supplicant 实现，它只依赖 p2p_config 这个接口。换一个宿主程序（比如 hostapd 也可以用 P2P），只需要提供另一套回调实现即可。这就是为什么 p2p.c 的代码可以从 wpa_supplicant 和 hostapd 共享——它在 `src/p2p/` 目录下，不属于任何一个守护进程。

那为什么不干脆直接调用 wpa_supplicant 的函数，或者只留一个 dispatch 回调让上层自己 switch 呢？直接函数调用的问题在于耦合方向反了——如果 p2p.c 里直接调用 `wpas_p2p_scan()`，那么 p2p.c 就必须知道 wpa_supplicant 的具体实现，hostapd 就再也复用不了它了；这正是为什么接口要反过来：p2p.c 声明"我需要这些能力"，supplicant 把实现塞进 p2p_config。至于单一 dispatch 回调 + switch 的方案，它把 35 个签名各异的操作压成一个 `void (*dispatch)(void *ctx, int event, void *data)`——省了结构体体积，却把所有参数类型信息压进 `void *`，上层必须自己 cast，编译器再也无法帮你检查参数拼错；而且每加一个事件都要同步改事件枚举和两端的 switch 分支。

35 个独立回调看似笨重，实则是用"结构体体积"换"编译期类型安全 + 宿主无关性"：`p2p.dev_found = wpas_dev_found` 这一行赋值，编译器就能验证 wpas_dev_found 的签名和 dev_found 声明完全一致。代价也不是没有——新加一个协议特性（P2PS、Bootstrap 就是例证）要在 p2p_config 里补回调、在 supplicant 和 hostapd 两端各实现一遍，35 个回调因此从早期的约 26 个一路涨上来。

上面两张表覆盖了最核心的 26 个，剩下的 9 个大多是扩展功能的旁路：

- `debug_print`：P2P 模块内部的日志输出口，不参与协议交互
- `presence_resp`：在 GO 收到对方的 Presence Response（NOA 协商的结果）时通知上层
- `remove_stale_groups`：负责在 P2PS 场景下清理过期的持久组，避免不可用的组越积越多
- `p2ps_prov_complete` 和 `prov_disc_resp_cb`：P2PS（P2P Service）Provisioning 流程的完成通知——前者把 Provision 结果上报，后者在 PD 响应发送完成后触发，主要用于 P2PS 待创建的组
- `p2ps_group_capability`：查询 P2PS 组的当前 capability，结合驱动能力决定组的属性
- `register_bootstrap_comeback` / `bootstrap_req_rx` / `bootstrap_completed`：属于 Bootstrap（DIRA 配对的初始握手）——前一个注册一个超时回调来启动 Bootstrap，后两个分别报告收到对端的 Bootstrap 请求、以及握手完成

至此，p2p_config 上的 35 个回调全部有了着落。名片上印了哪些服务已经清楚，但还有一个更基础的问题没回答：别人到底怎么找到这张名片？这就轮到名片上最重要的信息——联系方式，也就是 P2P Device Address 上场了。

---

# 5 名片上的联系方式——P2P Device Address 是怎么定的？

相亲角的名片上最重要的信息是联系方式——别人怎么找到你。在 P2P 的世界里，这个联系方式是 P2P Device Address，一个 48 位的 MAC 地址。

但 P2P Device Address 不等于 p2p0 接口的 MAC 地址。区别在于：

- **p2p0 接口的 MAC**：是网络接口的硬件地址，用于实际收发以太网帧。每个网络接口都有一个。
- **P2P Device Address**：是 P2P 协议层面的设备标识符，写在 P2P IE 的 P2P Device Info 属性中。它不是接口 MAC——Probe Request 帧的 SA（源地址）是发送接口的 MAC，而 P2P Device Address 是帧体内 P2P IE 中的一个字段。

回到 wpas_p2p_init 的入口，第一件实质性的事就是 `wpas_p2p_mac_setup()`：

```c
// wpa_supplicant/p2p_supplicant.c:4926
int wpas_p2p_mac_setup(struct wpa_supplicant *wpa_s)
{
    int ret = 0;
    u8 addr[ETH_ALEN] = {0};

    if (wpa_s->conf->p2p_device_random_mac_addr == 0)
        return 0;

    if (wpa_s->conf->p2p_device_random_mac_addr == 2) {
        // 持久模式：每次都使用同一个随机 MAC
        if (is_zero_ether_addr(
                wpa_s->conf->p2p_device_persistent_mac_addr) &&
            !is_zero_ether_addr(wpa_s->own_addr)) {
            os_memcpy(wpa_s->conf->p2p_device_persistent_mac_addr,
                      wpa_s->own_addr, ETH_ALEN);
        }
        return 0;
    }
    // ... mode 1: 随机 MAC  ...
}
```

三种策略，由配置项 `p2p_device_random_mac_addr` 控制：

| 值   | 策略                 | 行为                                                       |
| ---- | -------------------- | ---------------------------------------------------------- |
| 0    | 不使用随机 MAC       | 直接返回，P2P Device Address = 接口原生 MAC                |
| 1    | 随机 MAC（每次生成） | 无已保存网络 → 生成随机 MAC；有已保存网络 → 恢复上次的 MAC |
| 2    | 持久随机 MAC         | 首次使用时从 own_addr 复制，之后永久复用                   |

mode 1 的完整逻辑：

```c
// wpa_supplicant/p2p_supplicant.c:4944
if (!wpa_s->conf->ssid) {
    // 无已保存网络 → 全新生成
    if (random_mac_addr(addr) < 0) {
        wpa_msg(wpa_s, MSG_INFO,
            "Failed to generate random MAC address");
        return -EINVAL;
    }
    os_memcpy(wpa_s->conf->p2p_device_persistent_mac_addr, addr,
              ETH_ALEN);
} else {
    // 有已保存网络 → 恢复上次的 MAC
    if (is_zero_ether_addr(
            wpa_s->conf->p2p_device_persistent_mac_addr))
        return 0;
    os_memcpy(addr, wpa_s->conf->p2p_device_persistent_mac_addr,
              ETH_ALEN);
}

ret = wpa_drv_set_mac_addr(wpa_s, addr);
// ... 错误处理 ...
ret = wpa_supplicant_update_mac_addr(wpa_s);
```

关键在于"是否有已保存网络"这个分支。如果用户之前创建过持久组（Persistent Group），对端设备记住了你的 P2P Device Address。如果你这次用了一个不同的随机 MAC，对端的持久组查找会失败——"这个 MAC 我没见过"——持久组自动恢复就废了。所以 mode 1 在检测到有已保存网络时，不是生成新 MAC，而是把上一次存入 `p2p_device_persistent_mac_addr` 的地址恢复出来。

random_mac_addr() 本身很简单：

```c
// src/utils/common.c:1025
int random_mac_addr(u8 *addr)
{
    if (os_get_random(addr, ETH_ALEN) < 0)
        return -1;
    addr[0] &= 0xfe; /* unicast */
    addr[0] |= 0x02; /* locally administered */
    return 0;
}
```

MAC 地址的第一个字节承载了两个特殊比特：

- bit 0：0 = unicast（单播），1 = multicast（多播）。P2P 设备地址必须是单播，所以 `&= 0xfe` 清零。
- bit 1：0 = globally unique（全球唯一，由 IEEE 分配 OUI），1 = locally administered（本地管理）。随机生成的 MAC 必须置位，以区分于厂商烧录的永久 MAC。

如果不用随机 MAC，P2P Device Address 就是 p2p0 接口的硬件 MAC，而这个 MAC 通常与 STA 接口（wlan0）的 MAC 相同或相近（很多芯片给不同接口分配连续 MAC）。这意味着：当你的手机连着一个商场 WiFi 并开启 P2P 搜索时，周围的人收到的 Probe Request 中同时暴露了你的 STA MAC 和 P2P 设备名。用一个公式就能关联起来——隐私泄漏的入口就在这里。Android 从 8.0 开始推动 P2P MAC 随机化，2019 年的 Android Q 正式要求新设备必须支持。

另外，这里设置的 MAC 是 P2P Device Address（会在 P2P IE 中出现），不是后续 P2P 组接口的 MAC。组接口（p2p0 在组创建后变成 GO 接口，或驱动新建 p2p-p2p0-X）的 MAC 是由 `wpas_p2p_add_group_interface()` 在组创建时通过 `random_mac_addr()` 单独生成的——存入 `wpa_s->pending_interface_addr`，由驱动在创建接口时使用。

也就是说，P2P 有两层 MAC：一个是设备层的身份 MAC，一个是组通信的数据面 MAC。两层各自独立随机化，牺牲一点管理复杂度换更好的隐私保护。

为什么这两层 MAC 的生成都落在 supplicant（host），而不是驱动？这背后是 WiFi 协议栈里一条反复出现的职责分界线：**协议逻辑在 host，硬件操作在 firmware**。P2P Device Address 是协议层面的身份标识——它要写进 P2P IE、要和持久组绑定（mode 1 里"有已保存网络就恢复上次 MAC"的决策依赖 supplicant 的配置数据库）、还要跟 WPS 设备名/设备类型保持一致。这些决策都要读写 supplicant 的 p2p_data 和 wpa_s->conf，驱动根本不持有这些信息；驱动在整条链里的角色是"执行者"——`wpa_drv_set_mac_addr()` 把 supplicant 定好的地址交给驱动，驱动负责写进固件让接口真的用它收发。谁决定身份，谁就得持有上下文；身份决策依赖的上下文全在 host，所以身份生成也在 host。

---

# 6 P2pEnabledState.enterImpl() 做了哪些收尾工作？

现在回到 Framework 层。P2pEnabledState 的 `enterImpl()` 在状态转移时执行，它做了五件事——上一篇 §5.1 已经列过表格，这里聚焦在下发给 supplicant 的配置上，因为这部分操作和上文 supplicant 的 P2P 模块初始化直接关联。

`initializeP2pSettings()` 的核心下发链路在上一篇 §5.2 已给出完整代码——四行调用依次是 setDeviceName、setP2pSsidPostfix、setP2pDeviceType、setConfigMethods，本文不再重复。直接看它们落到 supplicant AIDL 层 ISupplicantP2pIface 上的四个方法——`setWpsDeviceName`、`setSsidPostfix`、`setWpsDeviceType`、`setWpsConfigMethods`（p2p_iface.cpp:631/346/639/679）。它们的写入目标并不完全相同，分两条路径：

- **写 conf + 立即同步到 p2p_data**：`setWpsDeviceName`、`setWpsDeviceType`、`setWpsConfigMethods` 三个 AIDL 方法落进 `wpa_s->conf` 的对应字段（device_name、device_type、config_methods），然后调用 `processConfigUpdate()` → `wpa_supplicant_update_config()` → `wpas_p2p_update_config()` 把新值同步进 p2p_data（p2p_supplicant.c:8283 里逐一调用 p2p_set_dev_name / p2p_set_pri_dev_type / p2p_set_config_methods）。也就是说，这三个配置不是"等 P2P 命令来了再从 conf 取"，而是 AIDL 调用返回前就完成了 conf → p2p_data 的传播。
- **直达 p2p_data**：`setSsidPostfix` 是例外——它不走 conf，`P2pIface::setSsidPostfixInternal` 直接调用 `p2p_set_ssid_postfix(wpa_s->global->p2p, ...)`，把 postfix 写进 `p2p->cfg->ssid_postfix`（p2p.c:4921），一步到位。

所以 Framework 的 `initializeP2pSettings()` 不是纯粹的"库存管理"——三条走 conf 的链是"到货即上架"，只有 ssid_postfix 这一条是"直达档案柜"。

同样地，`p2pGetDeviceAddress()` 从 supplicant 取回 P2P Device Address（即 wpas_p2p_mac_setup 设置的那个 MAC），填入 mThisDevice.deviceAddress。`p2pFlush()` 和 `p2pServiceFlush()` 清空上一轮会话的残留数据——不把旧相亲者的登记信息带到新的一天。

最后，enterImpl 收尾时发出的广播是 `sendP2pConnectionChangedBroadcast()`——WIFI_P2P_CONNECTION_CHANGED_ACTION，告知 App P2P 连接状态变化；而"P2P 功能已可用"的 WIFI_P2P_STATE_CHANGED_ACTION 并不在 enterImpl 里直接发送——上一篇 §6 已说明它走 `checkAndSendP2pStateChangedBroadcast()` 的延迟判断机制，由 WiFi 开关状态和管理员策略变化触发。同时 InactiveState 的空闲关闭定时器启动——150 秒无人问津则自动关闭 P2P。

相亲角的门开了。但此时大家只是在管理处各就各位——那封"已开门"的广播也发出去了。接下来驱动层要完成这间屋子的最后配置——给相亲角配跑腿的人。

---

# 7 QCOM 驱动怎么"雇跑腿"——P2P Component 初始化？

在 QCOM 的 qcacld-3.0 驱动中，P2P 不是一个动态加载的模块，而是一个静态注册的"Component"——驱动初始化时就存在，但直到 `cds_enable()` 阶段才被激活。所谓"component"，在 QCOM 的架构中是一组有独立生命周期（create / start / stop / destroy）的模块，通过 obj_mgr（对象管理器）挂在 psoc（Physical SoC——代表整个 WiFi 芯片）下面。

整个调用链的源头是驱动加载本身，而不是 WiFi 开关或 P2P 命令：QCOM 的 `cds_enable()` 不是被某个上层命令触发的，而是跟随驱动 probe 的启动流程，一路从 module_init 走进 CDS。P2P 组件的启用只是这条启动链上的一条支线，顺着驱动加载入口往下追：

```
hdd_module_init()（module_init，驱动加载入口）
  → hdd_wlan_start_modules()                 // core/hdd/src/wlan_hdd_main.c:4511
    → cds_open()                             // core/cds/src/cds_api.c:654
    → hdd_configure_cds()                    // core/hdd/src/wlan_hdd_main.c:14958
      → cds_enable()                         // core/hdd/src/wlan_hdd_main.c:15084
        → hdd_component_psoc_enable(psoc)    // core/hdd/src/wlan_hdd_main.c:17803
          → p2p_psoc_enable(psoc)            // os_if/p2p/src/wlan_cfg80211_p2p.c:321
            → ucfg_p2p_psoc_start(psoc, &start_param) // dispatcher 封装
              → p2p_psoc_start(soc, req)     // components/p2p/core/src/wlan_p2p_main.c:813
```

也就是说，只要驱动加载成功，P2P component 就会被批量启用——即使从未打开过 WiFi Direct。这层「开机即就绪」的属性是 QCOM 与 MTK 在初始化时机上的根本差别，§8 的对比表会再回到这一点。

p2p_psoc_enable 用三个回调打包了 p2p_start_param 的收发通路：

```c
// os_if/p2p/src/wlan_cfg80211_p2p.c:321
QDF_STATUS p2p_psoc_enable(struct wlan_objmgr_psoc *psoc)
{
    struct p2p_start_param start_param;

    start_param.rx_cb = wlan_p2p_rx_callback;
    start_param.rx_cb_data = psoc;
    start_param.event_cb = wlan_p2p_event_callback;
    start_param.event_cb_data = psoc;
    start_param.tx_cnf_cb = wlan_p2p_action_tx_cnf_callback;
    start_param.tx_cnf_cb_data = psoc;

    return ucfg_p2p_psoc_start(psoc, &start_param);
}
```

这三个回调中，`rx_cb` 处理从空中收到的 P2P Action 帧（GO Negotiation、Provision Discovery 等），`event_cb` 处理 P2P 相关事件（如 ROC——Remain on Channel 完成），`tx_cnf_cb` 处理 P2P Action 帧的发送确认。三个回调构成了"发-收-通知"的完整闭环。另有一个 `lo_event_cb` 由 `wlan_p2p_init_lo_event()` 单独设置（Listen Offload 停止事件），不在代码块中展示。

`ucfg_p2p_psoc_start()` 只做了一行转发，直接调用 `p2p_psoc_start()`。这种 dispatcher → core 的分层是 QCOM 的惯用模式——dispatcher 层处理 API 暴露和参数校验，core 层实现核心逻辑。

p2p_psoc_start 做了五件事，是 QCOM P2P 初始化的真正重心：

```c
// components/p2p/core/src/wlan_p2p_main.c:813
QDF_STATUS p2p_psoc_start(struct wlan_objmgr_psoc *soc,
    struct p2p_start_param *req)
{
    struct p2p_soc_priv_obj *p2p_soc_obj;

    p2p_soc_obj = wlan_objmgr_psoc_get_comp_private_obj(soc,
            WLAN_UMAC_COMP_P2P);
    // ... 分配和拷贝 start_param ...

    wlan_p2p_init_connection_status(p2p_soc_obj);

    /* 注册 LO 停用事件和 NOA 事件 */
    tgt_p2p_register_lo_ev_handler(soc);
    tgt_p2p_register_noa_ev_handler(soc);
    tgt_p2p_register_macaddr_rx_filter_evt_handler(soc, true);
    tgt_p2p_register_mcc_quota_ev_handler(soc, true);

    /* 注册 scan request id */
    p2p_soc_obj->scan_req_id = wlan_scan_register_requester(
        soc, P2P_MODULE_NAME, tgt_p2p_scan_event_cb, p2p_soc_obj);

    /* 注册 rx action frame */
    p2p_mgmt_rx_action_ops(soc, true);

    return QDF_STATUS_SUCCESS;
}
```

**五步拆解**：

**第一步，获取私有对象**：`wlan_objmgr_psoc_get_comp_private_obj(soc, WLAN_UMAC_COMP_P2P)` 从 psoc 对象中取出 P2P component 的私有数据（struct p2p_soc_priv_obj）。这个对象是在更早的 component create 阶段（p2p_psoc_obj_create_notification）由 obj_mgr 框架调用创建的，p2p_psoc_start 只是把它取出来填充。它是一张"运行台账"，字段包括：

- `roc_q` / `tx_q_roc` / `tx_q_ack`：三个队列（Remain on Channel 请求、Action 帧发送请求、发送确认分别排队）
- `scan_req_id`：在 SCM 注册的扫描请求 ID
- `start_param`：刚拷贝的收发回调包
- `cur_roc_vdev_id`：当前在哪个 vdev 上做 ROC
- `p2p_idr`：P2P 对象的 ID 映射表
- `connection_status`：P2P 连接状态机（wlan_p2p_main.h:260）

这个函数开头还有三段守卫式错误返回：`soc` 为 NULL → `QDF_STATUS_E_INVAL`；取不到 `p2p_soc_obj` → `QDF_STATUS_E_FAILURE`；`start_param` 分配失败 → `QDF_STATUS_E_NOMEM`。但注意上层的 `hdd_component_psoc_enable()` 是 void 函数，`p2p_psoc_enable` 的返回值根本没被检查——这些错误只会打印日志，P2P 的失败被淹没在启动序列里，这就是 §8 里提到的"QCOM 批量 enable 的失败不可见"。

**第二步，初始化连接状态**：`wlan_p2p_init_connection_status()` 把 P2P 连接状态机置为初始值——还没有任何 P2P 连接。

**第三步，注册四个 WMI 事件处理器**（这四件事共享一个重要特征：都是向固件侧注册事件处理回调）：

- `tgt_p2p_register_lo_ev_handler(soc)`：注册 Listen Offload（LO）停用事件处理器。当固件的 P2P Listen Offload 功能停止时，通过 WMI 事件通知驱动。
- `tgt_p2p_register_noa_ev_handler(soc)`：注册 NOA（Notice of Absence）事件处理器。当固件检测到 GO 的 NOA 调度变化时通知驱动——相当于跑腿工过来报告："老板说他要离开一会儿"。
- `tgt_p2p_register_macaddr_rx_filter_evt_handler(soc, true)`：注册 MAC 地址接收过滤事件处理器。P2P 发现过程中需要过滤掉自己的帧——收到自己的 Probe Request 不要当新设备。
- `tgt_p2p_register_mcc_quota_ev_handler(soc, true)`：注册 MCC（Multi-Channel Concurrency）配额事件处理器。当 WiFi 芯片在多信道并发时，P2P 和 STA 共享时间片，固件上报配额分配结果。

这四个 handler 里，Listen Offload 是最能说明 host 与 firmware 分工边界的一个。为什么"蹲守监听"可以下放给固件，而 GO Negotiation 必须留在 host？因为 Listen Offload 是一个**无状态**的射频任务：supplicant 把"在哪个信道蹲多久、按什么条件过滤"编成命令交给固件（QCOM 走 WMI、由 FEATURE_P2P_LISTEN_OFFLOAD 门控，MTK 走 vendor command mtk_cfg80211_vendor_p2p_listen_offload_start），固件在射频侧守株待兔，匹配到 Probe Request 再唤醒 host——固件不需要理解 P2P 协议，它只是在执行"待在 X 信道、看到匹配帧就叫我"的循环。而 GO Negotiation 是**有状态**的协议协商：收到 Action 帧要解析、查设备数据库、评估 GO Intent、维护协商状态机，这些都要读写 host 侧的 p2p_data——固件手里没有这个"档案柜"。

这就是"协议逻辑在 host，硬件操作在 firmware"分界线的实质：凡是需要解释协议含义、维护会话状态的操作留在 host；凡是可编程的、重复性的射频收发动作，才有资格下放给固件换省电。QCOM 的 LO handler 用 FEATURE_P2P_LISTEN_OFFLOAD 门控，正是因为下放依赖固件侧的能力——不是每个芯片的固件都支持，驱动层必须把它做成可选的。

NOA（Notice of Absence）的设计意图直接回答了"P2P 凭什么能和 STA 共存"这个问题。一台手机同时连着路由器（STA 模式）又开着 P2P GO（组 Owner）时，WiFi 芯片只有一个射频链路，同一时刻只能在一个信道上收发。GO 必须周期性切回 STA 的信道去收 Beacon、处理数据——这段时间它对自己 P2P 组的成员是"离开"的。如果组里的 Client 不知道 GO 什么时候会离开，它们就会在 GO 不在时盲目发帧，帧全部丢失。NOA 就是 GO 向组内成员宣告"我将在哪些时间窗缺席"的协议机制：GO 把 NOA 描述（缺席周期 count、duration、interval、start_time）写进 Beacon 和 Probe Response 的 P2P IE 里，Client 读到后就知道 GO 何时会在、何时会走，从而主动避开发送窗口、在 GO 缺席期间进入省电。这就是"我先去处理 STA 的事了，这段时间别找我"——只是这句话是用一组 TU 时间窗编码后广播出去的，而不是一句人话。

上面注册的 `reg_noa_ev_handler` 就是固件侧 NOA 调度变化时反向通知驱动：当 STA 流量压力变大、GO 需要调整缺席窗口时，固件通过 WMI 事件把新的 NOA 描述推给驱动（tgt_p2p_noa_event_cb → scheduler_post_message → p2p_process_evt → p2p_process_noa → p2p_send_noa_to_pe），驱动再走 supplicant 的 `get_noa` 回调把最新 NOA 取走、编码进下一帧 Beacon。所以 NOA 不是一个静态配置，而是一条"GO 缺席计划"的实时协商通道——MCC 配额管的是固件侧时间片怎么分，NOA 管的是把这份时间片划分告诉 P2P 组内的所有人。

这四个 tgt_* 函数的内部逻辑都走同一个模式——通过 `wlan_psoc_get_p2p_tx_ops(psoc)` 拿到 P2P 的 lmac tx_ops 结构体，然后调用对应的函数指针。以 NOA 为例：

```c
// components/p2p/dispatcher/src/wlan_p2p_tgt_api.c:195
QDF_STATUS tgt_p2p_register_noa_ev_handler(
    struct wlan_objmgr_psoc *psoc)
{
    struct wlan_lmac_if_p2p_tx_ops *p2p_ops;
    QDF_STATUS status = QDF_STATUS_E_FAILURE;

    p2p_ops = wlan_psoc_get_p2p_tx_ops(psoc);
    if (p2p_ops && p2p_ops->reg_noa_ev_handler) {
        status = p2p_ops->reg_noa_ev_handler(psoc, NULL);
    }
    return status;
}
```

而这个 lmac tx_ops 中的函数指针，是在更早的 wlan_lmac_if_umac_rx_ops_register_p2p() 中注册的：

```c
// qca-wifi-host-cmn/umac/global_umac_dispatcher/lmac_if/src/wlan_lmac_if.c:654
static void wlan_lmac_if_umac_rx_ops_register_p2p(
                struct wlan_lmac_if_rx_ops *rx_ops)
{
    wlan_lmac_if_umac_rx_ops_register_p2p_listen_offload(rx_ops);
    rx_ops->p2p.noa_ev_handler = tgt_p2p_noa_event_cb;
    rx_ops->p2p.add_mac_addr_filter_evt_handler =
        tgt_p2p_add_mac_addr_status_event_cb;
    rx_ops->p2p.ap_assist_dfs_group_bmiss_ev_handler =
            tgt_p2p_ap_assist_dfs_group_bmiss_ev_handler;
    wlan_lmac_if_umac_rx_ops_register_p2p_mcc_quota(rx_ops);
}
```

这段代码位于 lmac_if 模块——它是 umac（Upper MAC，驱动上层）和 lmac（Lower MAC，固件接口层）之间的桥梁。rx_ops 是一个"反向操作表"：umac 通过它注册回调，当 lmac 从固件收到 WMI 事件时，通过这些回调通知 umac。

如果把 lmac 比作跑腿工，rx_ops 就是跑腿工的"联系簿"——"NOA 事件到了找谁？找 tgt_p2p_noa_event_cb。MAC 地址过滤事件到了找谁？找 tgt_p2p_add_mac_addr_status_event_cb。"

**第四步，注册 scan request ID**：P2P 模块需要扫描能力，但它不自己实现扫描——它向 QCOM 的 SCM（Scan Manager）注册一个 requester ID。之后 P2P 发起的扫描请求通过这个 ID 来管理：SCM 知道"这个扫描是 P2P 模块要的"，结果回来时通过 tgt_p2p_scan_event_cb 回调通知 P2P 模块。

注意 `wlan_scan_register_requester` 的返回值没有被检查——它失败时返回 0（psoc 为空、scan obj 不存在或 requester 槽位耗尽），`p2p_psoc_start` 照样返回 SUCCESS。这个 0 会原样存进 `scan_req_id`，而 SCM 的 requester 校验要求 ID 带 `WLAN_SCAN_REQUESTER_ID_PREFIX`（0x0000A000）前缀——后续 P2P 扫描事件的回传会在 scm_scan_get_requester_event_handler 处被"invalid requester id"拒绝、静默丢弃。也就是说，scan requester 注册失败不会让初始化报错，但会藏在运行时：P2P 扫描发出去、结果永远回不来。这正是前面"p2p_psoc_enable 的返回值根本没被检查"主题在单个注册点上的又一重体现——QCOM 的失败不可见不止发生在组件之间的调用处，也发生在组件内部每一个子注册上。

**第五步，注册 Action 帧接收**：`p2p_mgmt_rx_action_ops(soc, true)` 把 P2P 模块注册为 Action 帧的接收者。从空中收到的所有 P2P Action 帧（通过 WMI_MGMT_RX_EVENTID 上报）都会被路由到 wlan_p2p_rx_callback（即 start_param.rx_cb）。

除了这五步之外，P2P component 在更早的 create 阶段（p2p_component_init()，components/p2p/core/src/wlan_p2p_main.c:587）还通过 obj_mgr 注册了三个层级的生命周期回调：

- **psoc 对象**：create（p2p_psoc_obj_create_notification）时分配 P2P 的 psoc 级私有数据；destroy 时释放
- **vdev 对象**：create/destroy（p2p_vdev_obj_create_notification / p2p_vdev_obj_destroy_notification）时管理 P2P 的虚拟设备级数据
- **peer 对象**：create/destroy（p2p_peer_obj_create_notification / p2p_peer_obj_destroy_notification）时同步 P2P 对端信息

obj_mgr 的这套"create/destroy 钩子"机制设计上解决了组件间的生命周期依赖：QCOM 驱动的数十个 component（P2P、扫描、MLME、WMI……）各自只需要注册自己关心的对象事件，obj_mgr 在对象创建/销毁时自动回调——component 之间不需要显式地调用彼此的 init/deinit 函数。

为什么 QCOM 要把生命周期管理做成这么重的一个框架，而不是像 MTK 那样在 p2pLaunch 里直接初始化？两个原因叠在一起。第一是对象个数的量级：QCOM 驱动里一个 psoc 下面可以有多个 pdev（物理芯片），每个 pdev 下有多个 vdev（虚拟接口），每个 vdev 下有多个 peer（对端）——对象是**分层且嵌套**的，任何一层的 create/destroy 都可能触发多个组件各自的清理逻辑。如果没有 obj_mgr，P2P 组件就得自己跟踪"哪个 vdev 创建了、哪个 peer 需要我同步"，还得在别的组件 deinit 之前保证自己的顺序——这等于让每个组件重新实现一遍对象管理。

第二是组件的解耦：QCOM 的几十个组件彼此不知道对方的存在，它们唯一的共同点是都挂在同一个 obj_mgr 之下。P2P 只需要向 obj_mgr 声明"我关心 psoc/vdev/peer 三类对象"，至于 obj_mgr 何时创建这三类对象、其他组件怎么处理，P2P 一概不管。这套设计换来的收益是**横向扩展性**——新增一个组件只需注册自己的 create/destroy 钩子，不必改动任何既有组件的初始化顺序；代价是 obj_mgr 本身成了全局瓶颈，所有对象的生命周期都要经过它转发，debug 时一个对象创建会触发一长串回调。

所有这些完成后，QCOM 的 P2P 组件处于就绪状态：RX 路径已打通（Action 帧会路由到 P2P）、TX 路径可发送（通过 lmac 下发 WMI 命令）、扫描能力已注册、WMI 事件监听已就位。驱动层的 P2P 跑腿工开始上班。

---

# 8 MTK 驱动怎么"雇跑腿"——另一套架构？

MTK 平台的 P2P 初始化走的是另一套风格——没有 QCOM 那种 component + obj_mgr 的抽象层，而是围绕 net_device 和状态机来组织。

MTK 的 P2P 代码位于 `kernel_modules-connectivity-wlan-core-gen4m`，与 QCOM 的三层分离（os_if/dispatcher/core）不同，MTK 把 P2P 的 FSM 放在 mgmt（Management）目录下，而 glue 与 net_device 相关逻辑（glRegisterP2P/glSetupP2P）在 os/linux/gl_p2p.c。

初始化的入口是 `p2pLaunch()`，它唯一的 live 触发路径是 `wlanoidSetP2pMode()`（common/wlan_oid.c:13118）。源码里另有一条由 `p2pFsmRunEventNetDeviceRegister()`（mgmt/p2p_fsm.c:205）处理的 mailbox 路径——它在 hem_mbox.c:255 注册为 MID_MNY_P2P_NET_DEV_REGISTER 消息的 handler，收到消息后也会调 p2pLaunch——但这条 mailbox 路径已经废弃：该消息的唯一发送代码在 common/wlan_oid.c:13195，位于 `#if 0` 块（13183-13199）内，当前是死代码，p2pLaunch 实际只会从 wlanoidSetP2pMode 进来。

wlanoidSetP2pMode 对应「supplicant 下发 SET P2P MODE 命令启用 WiFi Direct」这条路径，它的上游还要再追一层：supplicant 的 SET P2P MODE 经 cfg80211/wext 进入内核的 set_p2p_mode_handler()（gl_init.c:5027，由 register_set_p2p_mode_handler 在 gl_init.c:6778 注册的是包装函数 set_p2p_mode_handler_wrapper，它再转调 set_p2p_mode_handler），handler 把参数封装后通过 `kalIoctl()`（gl_init.c:5091）下发到 `wlanoidSetP2pMode()`，这才走到 `p2pLaunch()`：

```c
// os/linux/gl_p2p_init.c:185
u_int8_t p2pLaunch(struct GLUE_INFO *prGlueInfo)
```

p2pLaunch 的初始化链：

```
p2pLaunch()
  → glRegisterP2P()
    → alloc_netdev_mq()         // 为每个 P2P 角色分配 net_device
    → glSetupP2P()
      → p2PAllocInfo()          // 分配 GL_P2P_INFO、P2P_INFO、P2P_DEV_FSM_INFO 等
      → p2pDevFsmInit()         // 初始化 P2P Device FSM（共享）
      → p2pRoleFsmInit()        // 初始化 P2P Role FSM（每个角色独立）
  （p2pLaunch 返回后，由 gl_init.c:5111 调用）
  → p2pNetRegister()            // 向内核注册 net_device
```

和 QCOM 的 p2p_psoc_enable 相比，MTK 的"跑腿工"有几个鲜明的特征：

**net_device 为中心**：每个 P2P 角色（GO、GC）在初始化时就分配了独立的 net_device，而不是等到组创建时才动态创建。这意味着 MTK 在 P2P 初始化的成本上比 QCOM 更高（预分配资源），但组创建时的延迟更小（不需要再创建 net_device）。

**嵌套状态机**：MTK 的 P2P 有两层状态机——P2P Device FSM（管理设备级的发现、Listen 流程）和 P2P Role FSM（管理每个角色的操作状态）。Role FSM 是重点，它有 9 个状态（加上 NUM 占位）：

```
P2P_ROLE_STATE_IDLE = 0           // 空闲，初始状态
P2P_ROLE_STATE_SCAN              // 主动/被动扫描中
P2P_ROLE_STATE_REQING_CHANNEL    // 向 CNM 请求 RF 信道
P2P_ROLE_STATE_AP_CHNL_DETECTION // AP 信道检测扫描
P2P_ROLE_STATE_GC_JOIN           // GC 关联加入中
P2P_ROLE_STATE_OFF_CHNL_TX       // 非工作信道管理帧发送
P2P_ROLE_STATE_DFS_CAC           // DFS 信道可用性检查
P2P_ROLE_STATE_SWITCH_CHANNEL    // 信道切换（CSA）
P2P_ROLE_STATE_WAIT_FOR_NEXT_REQ_CHNL // 等待下次信道请求
```

初始化后，Role FSM 停在 P2P_ROLE_STATE_IDLE——和 supplicant 的 P2P_IDLE 遥相呼应。

Role FSM 的事件处理函数（`p2pRoleFsmRunEvent*`）根据事件决定目标状态，然后调用核心转移函数 `p2pRoleFsmStateTransition()` 执行切换。函数内部按当前状态与目标状态，调用对应的进入初始化函数（entry_init）或退出清理函数（entry_abort），逻辑上等价于一张转移表：

```none
(当前状态, 目标状态) → {
    进入初始化函数（entry_init）,
    退出清理函数（entry_abort）
}
```

举个例子，从 IDLE 收到"起始 AP 请求（有信道）"时：

- 目标状态 = REQING_CHANNEL（先把信道申请下来）
- entry_init = p2pRoleStateInit_REQING_CHANNEL（开始向 CNM 申请信道）
- 等信道申请成功后再次转移：REQING_CHANNEL → IDLE（此时在 abort 中已经启动了 AP）

"在 abort 中启动 AP"听起来反直觉，看代码就清楚了。REQING_CHANNEL 的退出清理函数 `p2pRoleStateAbort_REQING_CHANNEL()` 并不只是释放资源——当目标状态是 IDLE 且该角色本来就是 AP 意图时，它直接调用 `p2pFuncStartGO()` 把 GO 拉起来：

```c
// mgmt/p2p_role_state.c:122
void p2pRoleStateAbort_REQING_CHANNEL(struct ADAPTER *prAdapter,
        struct BSS_INFO *prP2pRoleBssInfo,
        struct P2P_ROLE_FSM_INFO *prP2pRoleFsmInfo,
        enum ENUM_P2P_ROLE_STATE eNextState)
{
    if (eNextState == P2P_ROLE_STATE_IDLE &&
        prP2pRoleBssInfo->eIntendOPMode == OP_MODE_ACCESS_POINT) {
        if (IS_NET_PWR_STATE_ACTIVE(prAdapter,
                prP2pRoleFsmInfo->ucBssIndex)) {
            p2pFuncStartGO(prAdapter, prP2pRoleBssInfo,
                &(prP2pRoleFsmInfo->rConnReqInfo),
                &(prP2pRoleFsmInfo->rChnlReqInfo));
        }
    }
}
```

这个两段跳的设计折射出 MTK 的一个架构约束：P2P 的 RF 信道必须通过 CNM（Coexistence and Network Manager）统一分配，P2P Role 不能自己决定用哪个信道。所以"要开 AP"必须先进入 REQING_CHANNEL 状态，等 CNM 分配好信道后再切回 IDLE（或 GC_JOIN）——信道落地的一刻，恰好是退出 REQING_CHANNEL 状态的"abort"动作把 GO 点燃。在 QCOM 中，信道选择由 SCM（Scan Manager）和策略模块处理，P2P component 不需要为此维护一个中间状态。

QCOM 和 MTK 的 P2P 初始化差异，归根结底反映了两种不同的驱动哲学：

| 维度     | QCOM (qcacld-3.0)                                            | MTK (wlan-core-gen4m)                                        |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 组织结构 | Component 模式：P2P 是一个注册到 obj_mgr 的独立组件          | 功能目录模式：P2P 代码按功能放在 mgmt/ 下                    |
| 入口函数 | p2p_psoc_enable() → ucfg_p2p_psoc_start() → p2p_psoc_start() | p2pLaunch() → glRegisterP2P() → glSetupP2P()                 |
| 对象模型 | obj_mgr 三层对象（psoc/vdev/peer），每个都有 create/destroy 钩子 | GLUE_INFO → ADAPTER → P2P_ROLE_FSM_INFO，没有通用对象管理器  |
| 接口模型 | net_device 动态创建（组创建时才建），p2p0 是一个虚拟接口     | net_device 预分配（初始化时为每个角色建好）                  |
| 信道管理 | SCM + Scan Manager：P2P 注册 requester ID，通过 SCM 发起扫描和信道请求 | CNM（Coexistence and Network Manager）：P2P Role FSM 通过 REQING_CHANNEL 状态向 CNM 申请信道 |
| 事件处理 | WMI 事件 → lmac rx_ops 回调 → umac P2P component             | 事件 → P2P Role FSM 状态转移 → entry_init/abort 回调         |
| 硬件通信 | WMI（Wireless Module Interface）命令/事件                    | mbox（Mailbox）消息                                          |
| 状态机   | 分散管理：连接状态在 p2p_soc_priv_obj，扫描交给 SCM          | 集中式：P2P Role FSM + P2P Device FSM 两层嵌套               |

两条初始化调用链、两种协作范式与初始化时机的差异，汇总成一张对比图：

![QCOM vs MTK P2P 初始化调用链对比](assets/11b-P2P%EF%BC%88%E4%BA%8C%EF%BC%89%E5%88%9D%E5%A7%8B%E5%8C%96%EF%BC%88%E4%B8%8B%EF%BC%89%E2%80%94%E2%80%94Supplicant-%E4%B8%8E%E9%A9%B1%E5%8A%A8%E5%88%9D%E5%A7%8B%E5%8C%96/11b-qcom-mtk-compare.svg)

如果说 QCOM 的 P2P 组件像一个外包公司的专业团队——各司其职（扫描找 SCM、信道找策略、帧收发走 lmac），那么 MTK 的 P2P 组件更像一个什么都自己干的个体户——一个 Role FSM 管了扫描、信道、连接、DFS 的全部状态转移。

两种设计各有利弊。QCOM 的模块化更强——如果 P2P 规范升级需要改扫描行为，只改 SCM 和 P2P 的交互即可，不影响 P2P 本身的协议逻辑。但代价是调用链更长——一个简单的"扫描社交信道"从 P2P 到 SCM 到 WMI 要穿过多层抽象。

MTK 的状态机更内聚——所有 P2P 行为在一个 Role FSM 中可见，排查问题时追踪状态转移曲线就行。但代价是 Role FSM 本身就变成了一个"神对象"——9 个状态 × 多种事件，状态转移矩阵的维护成本随功能增加而膨胀。

这两种跑腿工的差别，往深一层看其实是两种**协作范式**的差别——消息传递 vs 直接调用。QCOM 的组件之间不直接喊话，而是把话写成消息投进 scheduler 队列：前面 NOA 事件那条链（`tgt_p2p_noa_event_cb` → `scheduler_post_message` → `p2p_process_evt` → `p2p_process_noa`）就是一个缩影——target_if 层收到 WMI 事件后封装成 `scheduler_msg`，post 到队列，由 scheduler 线程在另一个上下文里取出来分发给 core 层处理。生产者和消费者**不在同一个调用栈里**，中间隔着一个异步队列。MTK 则完全相反：`wlanoidSetP2pMode` 直接调 `p2pLaunch()`，`p2pLaunch()` 直接调 `glRegisterP2P()`，所有代码在同一线程、同一调用栈里同步执行，一个函数返回另一个函数才开始。

消息传递的收益是**解耦**——QCOM 的 target_if 层根本不知道 core 层谁在处理 NOA，它只需要把消息投递出去，组件之间可以独立演进、独立测试；代价是每条消息都要经过"构造 → 入队 → 出队 → 分发"的周转，延迟比直接调用高，而且多了一个 scheduler 线程的并发问题要处理。直接调用的收益是**简单直接**——没有队列、没有线程切换，调用栈本身就是完整的执行轨迹，读代码就是读流程；代价是调用方必须知道被调用方的确切入口，组件之间形成编译期依赖，任何一个模块改了函数签名，所有调用点都要跟着改。外包团队靠工单系统（消息队列）协作，个体户靠当面交接（直接调用）——这是两种驱动哲学在协作机制上的落地。

第三种差别藏在**初始化时机**上。QCOM 的 P2P 组件在 `cds_enable()` 阶段被批量拉起——`hdd_component_psoc_enable()`（core/hdd/src/wlan_hdd_main.c:17803）一口气调用 ocb、disa、nan、p2p、tdls 等 9 个组件的 enable，p2p_psoc_enable 只是 cds 调度器的一条支线。这意味着只要驱动加载，P2P 组件就激活：即使从未打开 WiFi Direct，WMI 事件处理器、scan requester、obj_mgr 钩子也全部注册到位。MTK 则把 `p2pLaunch()` 推迟到真正需要 P2P 的时刻——supplicant 下发 SET P2P MODE 时（wlanoidSetP2pMode，common/wlan_oid.c:13118）才动手（源码里另有一条 P2P net_device 注册 mailbox 路径 p2pFsmRunEventNetDeviceRegister，但已废弃）。一个是"开机就雇好跑腿"，一个是"来客了才现招"。

两种时机在三个维度上各有取舍。

**启动时间**：QCOM 每次开机都付一笔固定的 P2P 启用开销（批量 enable 让边际成本很小，但 P2P 的 WMI 注册、对象分配确实发生），MTK 不启用 P2P 就零开销，对只做 STA 的设备更友好。

**内存占用**：QCOM 在驱动初始化阶段就占用了 psoc 私有对象和一批事件注册，MTK 把 net_device、GL_P2P_INFO、Role FSM 的分配全部推迟到首次启用，内存按需发生。

**错误恢复**：QCOM 的批量 enable 是 void 函数、不检查单个组件的返回值（hdd_component_psoc_enable 里 p2p_psoc_enable 的失败不影响其他组件），P2P 的故障被淹没在启动序列里；MTK 的 p2pLaunch 失败会把 WLAN_STATUS_FAILURE 通过 OID 返回给 supplicant——上层立刻知道"P2P 没起来"，可以重试，错误可见且可恢复。但"错误可见"要打个折扣：p2pLaunch 返回 FALSE 有两种含义——"P2P 已注册、本次跳过"和"glRegisterP2P 真失败了"，wlanoidSetP2pMode 把两种情况都统一上报为 WLAN_STATUS_FAILURE，上层分不清到底是没起来还是已经起来。

---

# 9 三层初始化完成后，系统处在什么状态？

三层初始化全部完成，回顾一下我们走过的路：

```none
Framework (P2pEnabledState.enterImpl)
  → SUP_CONNECTION_EVENT 到达（电话线通了）
  → initializeP2pSettings() 下发设备名、设备类型、配置方法等
  → sendP2pConnectionChangedBroadcast()（连接状态变化广播；STATE_CHANGED 走延迟机制）
  → 停在 InactiveState（等用户操作）

Supplicant (wpas_p2p_init → p2p_init)
  → wpas_p2p_mac_setup() 生成 P2P Device Address（名片上的联系方式）
  → 填充 struct p2p_config（35 个回调："有事打这些电话"）
  → p2p_init() 分配 p2p_data（档案柜）
    → devices 链表：空（还没人登记）
    → go_timeout=100, client_timeout=20
    → next_tie_breaker：随机 1 bit
    → dev_capab：SD + Invitation + Concurrent + Client Disc
    → 初始状态：P2P_IDLE

QCOM 驱动 (cds_enable → p2p_psoc_enable)
  → p2p_psoc_start() 填充 p2p_soc_priv_obj
  → 向 lmac 注册 RX ops（NOA/MAC filter/MCC quota 事件回调）
  → 向 WMI 注册 NOA 事件处理器（跑腿的"离开通知"系统就位）
  → 向 SCM 注册 scan requester ID（要扫描找 SCM）
  → Action 帧收发通路就绪
  → obj_mgr 三层生命周期钩子已注册

MTK 驱动 (p2pLaunch → glSetupP2P)
  → 为每个 P2P 角色分配 net_device
  → 分配 GL_P2P_INFO、P2P_INFO、P2P_DEV_FSM_INFO
  → p2pDevFsmInit()：Device FSM 就绪
  → p2pRoleFsmInit()：Role FSM 停在 P2P_ROLE_STATE_IDLE
  → p2pNetRegister()：向内核注册 net_device
```

有开始就有结束。`wpas_p2p_init` 印了名片，就有 `wpas_p2p_deinit` 负责把名片收回（p2p_supplicant.c:5220）——它取消 init 之后注册的一批 eloop 定时器（group formation、join scan、long listen、group idle 的超时回调）、释放 `go_params` 里暂存的 provisioning 信息、移除 pending 的组接口；真正清空档案柜的是 `wpas_p2p_deinit_global()`（p2p_supplicant.c:5270），它在 supplicant 进程退出时调用 `p2p_deinit()`（p2p.c:3115）——逐项释放 `p2p_init` 里 strdup 出来的 dev_name、manufacturer 等字符串，用 `p2p_flush()` 清空 devices 链表，当初登记了多少个相亲者，收摊时就得逐个摘牌。

QCOM 的关闭链和启用链逐项镜像：`p2p_psoc_disable()`（wlan_cfg80211_p2p.c:341）→ `ucfg_p2p_psoc_stop()` → `p2p_psoc_stop()`（wlan_p2p_main.c:865）把 `p2p_psoc_start` 登记的东西全部反注册——`p2p_mgmt_rx_action_ops(soc, false)` 注销 Action 帧接收、`p2p_cleanup_tx_sync()`/`p2p_cleanup_roc()` 清空三个队列、`wlan_scan_unregister_requester()` 注销 scan requester、`tgt_p2p_unregister_lo_ev_handler()`/`tgt_p2p_unregister_noa_ev_handler()` 反注册 WMI 事件处理器——注册了谁就注销谁，这正是把生命周期交给 obj_mgr 的回报：create/destroy 钩子天然成对。

MTK 侧是 `p2pRemove()`（gl_p2p_init.c:294），与 `p2pLaunch` 成对：先 `p2pNetUnregister()` 把 net_device 从内核撤下、等设备真正注销后才释放资源。这些收摊动作都备好了，只等一个关闭指令——不过此刻相亲角刚开门，还不到收摊的时候。

此时整个系统处于一个精确的状态：相亲角的场地（p2p0 接口）有了，名片（回调注册）印好了，档案柜（p2p_data）摆好了，跑腿工（QCOM/MTK P2P component）雇好了，开业通知（WIFI_P2P_STATE_CHANGED_ACTION）也发出去了。但还差最后一步——用户要点击"搜索设备"。

这个"搜索"操作，在 P2P 的协议层称为 Device Discovery，核心机制叫 Find 循环——设备在 Listen 阶段（蹲在自己的信道上等别人来发现）和 Search 阶段（主动扫描社交信道 1/6/11）之间交替切换。这个循环怎么运作？Probe Request 的 P2P IE 里装了什么？社交信道为什么是 1、6、11？驱动怎么实现 Listen 和 Scan 的切换？下一个相亲者怎么被发现？

下一篇，我们从 `discoverPeers()` 的 Framework 入口开始，追踪 P2P 设备发现的完整链路。

---

**源码仓库**：

- AOSP wpa_supplicant 8: [https://w1.fi/wpa_supplicant/](https://w1.fi/wpa_supplicant/)
- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- QCOM qcacld-3.0: [https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0](https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0)
- QCOM qca-wifi-host-cmn（lmac_if 所在仓库）: [https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qca-wifi-host-cmn](https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qca-wifi-host-cmn)

**相关规范**：Wi-Fi Alliance, "Wi-Fi Direct Specification v2.0"
