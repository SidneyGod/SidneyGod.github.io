---
title: WiFi打开（三）Supplicant 启动
top: 1
related_posts: true
abbrlink: b25c8fca
date: 2026-09-19 20:04:48
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 驱动加载完成、芯片就绪后，wpa_supplicant 是怎么启动的？eloop 事件循环是怎么工作的？它的核心数据结构、状态机、AIDL 接口层又是怎么设计的？

> **上篇回顾**：在 Framework 与 HAL 篇中，我们追踪了从用户点击开关到 HAL 就绪的完整链路——ActiveModeWarden 调度、WifiController 状态机、HalDeviceManager 启动、厂商私有 HAL 加载。本篇继续往下走：HAL 就绪后，Supplicant 怎么启动？

# 本章导读

Supplicant 是餐厅的**前台接待**——就位后通过**对讲机**（eloop 事件循环）随时响应厨房（内核）和客人（Java Framework）的消息。接待台上的**工作手册**记录了所有接口、网络、密钥的状态。

<!--more-->

**你将学到**

- wpa_supplicant 的五大核心数据结构：`wpa_global`、`wpa_supplicant`、`wpa_radio`、`wpa_radio_work`、`wpa_ssid`
- 状态机：10 个状态的枚举定义、`wpa_supplicant_set_state()` 的 5 阶段执行
- 事件驱动架构：`wpa_supplicant_event()` 的分发逻辑（switch 30+ 事件类型）
- AIDL 三层接口：ISupplicant / ISupplicantStaIface / ISupplicantStaNetwork
- 四大设计模式：虚函数表、观察者、Work Queue、状态保存恢复
- Supplicant 启动的完整时间线（每一步的典型耗时和变量分析）

**代码说明**：本文代码来自真实源码，有精简（去掉 log 语句和非核心错误处理），关键路径保留完整调用链。精简处标注 `// ...省略...`。

**系列导航**：本篇聚焦 Supplicant 启动与内部架构。上篇聚焦驱动加载与 SSR 崩溃恢复。

![wpa_supplicant 软件分层架构](assets/04-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%B8%89%EF%BC%89Supplicant-%E5%90%AF%E5%8A%A8/04-architecture.svg)

> **全篇架构图：wpa_supplicant 软件分层（从 Java Framework 到内核驱动）** —— 自上而下五层：Java Framework（SupplicantStaIfaceHalAidlImpl / WifiMonitor）→ binder/AIDL → wpa_supplicant（eloop + `wpa_supplicant_event()` 分发）→ nl80211 netlink → 内核 cfg80211 与驱动。本章逐层展开时，随时可以回到这张图定位当前所处的那一层。

---

# 1 核心数据结构：Supplicant 的「五脏六腑」

在看启动流程之前，必须先认识 Supplicant 的核心数据结构。不理解这些结构体就直接看启动代码，就像不看地图就走进一座大楼——你会迷路。

## 1.1 `struct wpa_global` —— 全局单例，所有接口共享

`wpa_global` 是整个 Supplicant 进程的根对象。全局只有一个——`wpa_supplicant_init()` 分配它，`wpa_supplicant_deinit()` 释放它。所有接口（wlan0 / p2p0 等）共享同一个 `wpa_global`。

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant_i.h:283-324
// （行号基于 Android 16 / API 36 版本，其他版本可能偏移）
struct wpa_global {
    struct wpa_supplicant *ifaces;        // 接口链表头（单链表）
    struct wpa_params params;             // 命令行参数（debug level 等）
    struct ctrl_iface_global_priv *ctrl_iface;  // 全局 ctrl socket
    struct wpas_dbus_priv *dbus;          // D-Bus 连接
    struct wpas_aidl_priv *aidl;          // AIDL binder 连接
    void **drv_priv;                      // 各驱动的私有数据
    size_t drv_count;                     // 已加载的驱动 wrapper 数量
    struct os_time suspend_time;          // 挂起时间
    struct p2p_data *p2p;                 // P2P 全局状态
    struct wpa_supplicant *p2p_init_wpa_s;      // P2P 发起者
    struct wpa_supplicant *p2p_group_formation; // P2P 建组中
    struct wpa_supplicant *p2p_invite_group;    // P2P 邀请中
    u8 p2p_dev_addr[ETH_ALEN];            // P2P 设备地址
    struct dl_list p2p_srv_bonjour;       // Bonjour 服务列表
    struct dl_list p2p_srv_upnp;          // UPnP 服务列表
    int p2p_disabled;                     // P2P 是否禁用
    int cross_connection;                 // 跨连接标志
    struct wpa_freq_range_list p2p_disallow_freq; // P2P 禁用频率
    struct wpa_freq_range_list p2p_go_avoid_freq; // GO 避开频率
    enum wpa_conc_pref conc_pref;         // 并发优先级（STA vs P2P）
    // ...省略 WiFi Display 和 PSK 列表字段...
};
```

- **ifaces 是单链表**：通过 `wpa_supplicant.next` 链接。遍历所有接口只需 `for (wpa_s = global->ifaces; wpa_s; wpa_s = wpa_s->next)`。
- **P2P 字段占了近一半**：P2P 的复杂状态（正在建组、邀请中、GO 等待客户端等）全部存储在 `wpa_global` 级别，因为 P2P 操作跨越多个接口。
- **drv_priv 是数组**：`drv_count` 是已初始化的驱动 wrapper 数量（如 nl80211、wext）。每个驱动的私有数据通过 `global->drv_priv[i]` 访问。

## 1.2 `struct wpa_supplicant` —— 每接口状态，Supplicant 的灵魂

这是整个代码库中最大的结构体——约 600 个字段，分布在 15 个功能分组中。以下从源码中提取核心字段并按功能分组展示：

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant_i.h:697-1150+
// 精简：只展示核心字段，按功能分组，省略 P2P/MESH 等高级特性
struct wpa_supplicant {
    // ===== 身份与层级 =====
    struct wpa_global *global;            // 所属全局对象
    struct wpa_radio *radio;              // 共享的射频上下文
    struct dl_list radio_list;            // radio::ifaces 的链表节点
    struct wpa_supplicant *parent;        // 父接口（P2P group → P2P dev）
    struct wpa_supplicant *p2pdev;        // 对应的 P2P device 接口
    struct wpa_supplicant *next;          // global->ifaces 链表的下一个
    unsigned char own_addr[ETH_ALEN];     // 自己的 MAC 地址
    unsigned char perm_addr[ETH_ALEN];    // 永久 MAC 地址
    char ifname[100];                     // 接口名（"wlan0"）

    // ===== 当前连接信息 =====
    u8 bssid[ETH_ALEN];                   // 当前连接的 AP 的 BSSID
    u8 pending_bssid[ETH_ALEN];           // 正在关联的目标 BSSID
    struct wpa_ssid *current_ssid;        // 当前网络配置
    struct wpa_ssid *last_ssid;           // 上次连接的网络
    struct wpa_bss *current_bss;          // 当前 AP 的扫描信息
    unsigned int assoc_freq;              // 当前关联频率（MHz）
    int disconnected;                     // 是否主动断开连接
    int reassociate;                      // 是否正在重关联
    bool roam_in_progress;                // 是否正在漫游

    // ===== MLO（WiFi 7 多链路）=====
    u8 ap_mld_addr[ETH_ALEN];             // AP MLD 地址
    u8 mlo_assoc_link_id;                 // 关联的 link ID
    u16 valid_links;                      // 有效的 link bitmap
    struct {                              // 每个 link 的状态
        u8 addr[ETH_ALEN];
        u8 bssid[ETH_ALEN];
        unsigned int freq;
        struct wpa_bss *bss;
        bool disabled;
    } links[MAX_NUM_MLD_LINKS];

    // ===== 安全参数（根据 Beacon/ProbeResp 的 WPA IE 选定）=====
    int pairwise_cipher;                  // 成对密钥密码套件
    int group_cipher;                     // 组密钥密码套件
    int key_mgmt;                         // 密钥管理方式
    int wpa_proto;                        // WPA 协议版本
    int mgmt_group_cipher;                // 管理帧保护组密钥密码套件

    // ===== 配置与网络列表 =====
    struct wpa_config *conf;              // 配置对象（包含 network blocks 链表）
    struct wpa_ssid *next_ssid;           // 下一个优先连接的网络

    // ===== 驱动接口 =====
    const struct wpa_driver_ops *driver;  // 驱动虚函数表
    void *drv_priv;                       // 驱动的私有数据
    u64 drv_flags;                        // 驱动能力标志位
    u64 drv_flags2;                       // 驱动能力标志位（扩展）
    int max_scan_ssids;                   // 驱动支持的扫描 SSID 数
    unsigned int max_remain_on_chan;       // 驱动支持的 offchannel 时长

    // ===== 密钥与 EAPOL 状态机 =====
    struct wpa_sm *wpa;                   // WPA 状态机（四次握手/组密钥握手）
    struct eapol_sm *eapol;               // EAPOL 状态机
    unsigned int keys_cleared;            // 已清除的 key index bitmap
    struct ptksa_cache *ptksa;            // PTKSA 缓存

    // ===== 扫描相关 =====
    enum wpa_states scan_prev_wpa_state;  // 扫描前的状态（扫描完成后恢复）
    struct wpa_radio_work *scan_work;     // 当前扫描的 radio work
    int scanning;                         // 是否正在扫描
    int sched_scanning;                   // 是否正在 scheduled scan
    struct os_reltime scan_trigger_time;  // 扫描触发时间
    struct os_reltime scan_start_time;    // 扫描开始时间
    struct os_reltime scan_min_time;      // 扫描结果最小新鲜度
    struct os_reltime last_scan;          // 上次扫描完成时间
    struct dl_list bss;                   // BSS 缓存链表
    size_t num_bss;                       // BSS 缓存数量
    int scan_interval;                    // 扫描间隔（秒）
    int normal_scans;                     // 调度扫描前执行的常规扫描次数
    struct wpa_bss **last_scan_res;       // 上次扫描结果数组
    size_t last_scan_res_used;            // 已使用的扫描结果数

    // ===== 状态与连接追踪 =====
    enum wpa_states wpa_state;            // 当前 WPA 状态
    int new_connection;                   // 是否是新连接
    unsigned int consecutive_conn_failures; // 连续连接失败次数
    struct os_reltime roam_start;         // 漫游开始时间
    struct os_reltime roam_time;          // 漫游耗时
    struct os_reltime session_start;      // 会话开始时间
    struct os_reltime session_length;     // 会话时长

    // ===== L2 与 EAPOL =====
    struct l2_packet_data *l2;            // L2 层 packet socket（EAPOL 收发）
    unsigned char last_eapol_src[ETH_ALEN]; // 上次收到 EAPOL 的源 MAC
    int eapol_received;                   // 关联后收到的 EAPOL 包数

    // ===== ctrl interface =====
    struct ctrl_iface_priv *ctrl_iface;   // per-interface ctrl socket

    // ... 省略 P2P（约 100 字段）、SME（约 40 字段）、
    //        WPS、DPP、HS20、Mesh、TDLS 等功能模块字段 ...
};
```

这 170 行字段不必逐行背诵——扫读时抓住三条主线即可：身份与层级（`global` / `radio` / `parent` 挂在哪个链表上）、当前连接（`bssid` / `current_ssid` / `assoc_freq` 连到了哪个 AP）、安全与扫描状态（`wpa` / `eapol` / `scan_*` 走到了哪一步）。下面三条 bullet 挑出其中最值得记住的设计点。

- **字段数惊人，但有规律**：所有 `struct wpa_supplicant` 字段都围绕一个核心问题——「这个 WiFi 接口现在处于什么状态？」。状态信息是最密集的：当前连接的 BSSID、SSID、频率、密钥、加密套件、扫描结果缓存……
- **按功能域分群**：`bssid` / `current_ssid` / `assoc_freq` 是一组（当前连接）; `pairwise_cipher` / `group_cipher` / `key_mgmt` / `wpa_proto` 是一组（安全协商结果）; `scan_*` 字段是一组（扫描状态）; `driver` / `drv_priv` / `drv_flags` 是一组（驱动接口）。
- **为什么不是子结构体？** 源码中除了 SME（`wpa_s->sme`）和 MLO links 外，其他字段都平铺在 `wpa_supplicant` 中。这是一种历史遗留的设计选择——Supplicant 从 2003 年起持续演进，字段随时间累积。重构为子结构体需要改动数百处引用，风险远大于收益。

## 1.3 `struct wpa_radio` + `struct wpa_radio_work` —— 射频的「任务队列」

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant_i.h:334-370

struct wpa_radio {
    char name[16];                        // radio 名称（驱动提供）
    struct wpa_supplicant *external_scan_req_interface; // 外部扫描请求者
    unsigned int num_active_works;        // 当前活跃的 work 数量
    struct dl_list ifaces;                // 共享此 radio 的接口链表
    struct dl_list work;                  // work 队列（按时间排序）
};

struct wpa_radio_work {
    struct dl_list list;                  // radio->work 链表的节点
    unsigned int freq;                    // 目标频率（0 = 所有频率）
    const char *type;                     // work 类型（"scan"/"connect"/"p2p-scan"...）
    struct wpa_supplicant *wpa_s;         // 所属接口
    void (*cb)(struct wpa_radio_work *work, int deinit); // 回调函数
    void *ctx;                            // 回调上下文
    unsigned int started:1;               // 是否已开始执行
    struct os_reltime time;               // 创建时间
    unsigned int bands;                   // 涉及的频段 bitmap
};
```

- **radio 和 interface 是 1:N 关系**：一个物理 WiFi 芯片对应一个 `wpa_radio`，多个虚拟接口（wlan0 → STA、p2p0 → P2P）共享同一个 radio。这保证了射频操作的互斥——你不会同时在两个接口上做 offchannel 操作。
- **work 队列是「任务调度器」**：当一个接口需要独占射频（如扫描、连接），它通过 `radio_add_work()` 向队列提交一个 work item。如果有并发能力（`WPA_DRIVER_FLAGS_OFFCHANNEL_SIMULTANEOUS`），最多允许 `MAX_ACTIVE_WORKS`（2）个 work 同时运行。

## 1.4 `struct wpa_ssid` —— 网络配置，Supplicant 的「常客档案」

`wpa_ssid` 存储一个已保存网络的完整配置。每个 `wpa_supplicant` 接口通过 `wpa_s->conf->ssid` 链表管理多个 `wpa_ssid`（每个对应一个用户保存过的 WiFi 网络）。核心字段包括：

```c
// external_wpa_supplicant_8/wpa_supplicant/config_ssid.h（精简）
struct wpa_ssid {
    struct wpa_ssid *next;            // 链表下一个节点
    int id;                           // 网络 ID（Supplicant 内部分配）
    int priority;                     // 连接优先级（数值越大越优先）
    u8 *ssid;                         // SSID 指针（ssid_len 决定有效长度，可能含非 nul 字符）
    size_t ssid_len;                  // SSID 长度
    u8 bssid[ETH_ALEN];              // 限定 BSSID（非空时只连指定 AP）
    int key_mgmt;                     // 密钥管理方式（WPA-PSK / WPA-EAP / SAE / ...）
    int proto;                        // 协议版本（WPA / RSN）
    int pairwise_cipher;              // 成对密钥密码套件
    int group_cipher;                 // 组密钥密码套件
    u8 psk[PMK_LEN];                 // 原始 PSK（32 字节，已派生）
    char *passphrase;                 // PSK 密码短语（8-63 字符，未派生）
    char *sae_password;               // SAE 密码（WPA3）
    // ... EAP 配置（eap_method / identity / password / ca_cert 等约 20 个字段）...
    int disabled;                     // 是否禁用（用户在 Settings 中关闭了此网络）
    int disabled_for_connect;         // WPS 连接期间被临时禁用
    // ... 扫描过滤、漫游策略、BSS transition 等高级字段 ...
};
```

- **一对多关系**：一个接口可以保存多个网络（如家里 WiFi + 公司 WiFi + 咖啡店 WiFi），每个对应一个 `wpa_ssid` 节点。`wpa_ssid.next` 形成单链表。
- **密码存储**：Android 上 `passphrase` 由 WiFiService 通过 AIDL 传入（Keystore 解密后），Supplicant 内部通过 PBKDF2 派生 PMK 存入 `psk` 字段。
- **`disabled` 标志**：用户在 Settings 中关闭某个已保存网络时，对应的 `wpa_ssid.disabled` 被置为 1，Supplicant 跳过该网络。`disabled_for_connect` 是 WPS 连接期间被临时禁用的网络，WPS 连接成功或失败后自动恢复。

## 1.5 数据结构关系速查

| 结构体           | 数量          | 拥有者                   | 核心职责                                       |
| ---------------- | ------------- | ------------------------ | ---------------------------------------------- |
| `wpa_global`     | 1 个/进程     | 进程唯一                 | 全局参数、EAP 方法注册、P2P 全局状态、接口链表 |
| `wpa_supplicant` | 1 个/接口     | `global->ifaces` 链表    | 接口的状态机、连接信息、扫描缓存、密钥、EAPOL  |
| `wpa_radio`      | 1 个/物理芯片 | `wpa_s->radio` 指向      | 射频互斥、work 队列、并发控制                  |
| `wpa_radio_work` | N 个/radio    | `radio->work` 链表       | 射频操作的序列化（扫描/连接/P2P 发现）         |
| `wpa_ssid`       | N 个/接口     | `wpa_s->conf->ssid` 链表 | 已保存网络的配置（SSID/密码/安全模式等）       |

用餐厅的比喻来总结这五层结构：`wpa_global` 是营业执照，整个餐厅只有一张；`wpa_radio` 是厨房，一个物理空间所有服务员共用；`wpa_supplicant` 是每个服务员的工作站，每个接口一个；`wpa_radio_work` 是厨房任务单——扫描是「出去看看外面有什么客人」，连接是「招待这位客人就座」；`wpa_ssid` 是常客档案，记录每个回头客的口味偏好。

---

# 二、wpa_supplicant 怎么启动的？eloop + AIDL 的细节

> **启动机制**：`main()` 是怎么被调起来的？（rc 文件 + HIDL lazy HAL + init 服务启动）已在上一篇《Framework 与 HAL》第九章详细说明。本章聚焦 `main()` 之后的内部初始化。

## 2.1 `main()` —— 四步启动

```c
// external_wpa_supplicant_8/wpa_supplicant/main.c
int main(int argc, char *argv[])
{
    struct wpa_interface *ifaces;
    struct wpa_params params;
    struct wpa_global *global;
    int i, exitcode;

    // ===== 第一步：OS 级初始化 =====
    // 在 Android 上：降权到 wifi 用户（setuid/setgid/setgroups）、
    // 保留 CAP_NET_ADMIN/CAP_NET_RAW 能力（capset）、初始化随机数种子
    if (os_program_init())
        return -1;

    // 解析命令行参数
    // Android 启动命令示例：
    //   wpa_supplicant -O /data/vendor/wifi/wpa/sockets
    //                  -g @android:wpa_wlan0
    //                  -i wlan0 -D nl80211
    os_memset(&params, 0, sizeof(params));
    params.wpa_debug_level = MSG_INFO;
    // ...解析 argc/argv...

    // ===== 第二步：全局初始化 =====
    // 创建 struct wpa_global，初始化 eloop，注册 EAP 方法
    global = wpa_supplicant_init(&params);
    if (global == NULL)
        return -1;
```

前两步是基础设施搭建。`os_program_init()` 是平台相关的——在 Android 上它执行权限降级（切换到 `wifi` 用户，保留 `CAP_NET_ADMIN` 和 `CAP_NET_RAW` 两个能力用于操作 netlink socket），然后初始化随机数种子供后续 EAP 密钥协商使用。`wpa_supplicant_init()` 创建全局根对象 `wpa_global`，内部调用 `eloop_init()` 创建 epoll fd 并注册所有 EAP 方法（PEAP、TLS、TTLS、SIM、AKA 等数十种）。

```c
    // ===== 第三步：为每个接口调用 add_iface =====
    // 在 Android 上通常只有一个接口：wlan0
    for (i = 0; i < params.iface_count; i++) {
        wpa_s = wpa_supplicant_add_iface(global, &ifaces[i], NULL);
        if (wpa_s == NULL)
            return -1;
    }

    // ===== 第四步：进入事件循环 =====
    // 从此刻起，进程进入事件驱动的无限循环
    // 所有后续操作（扫描、关联、EAPOL 握手）都是 eloop 中的事件回调
    exitcode = wpa_supplicant_run(global);

    // 清理（只在进程终止时才执行到这里）
    wpa_supplicant_deinit(global);
    os_program_deinit();

    return exitcode;
}
```

后两步启动接口并进入事件循环。`wpa_supplicant_add_iface()` 是每个 WiFi 接口的完整初始化入口（详见 2.3 节）。`wpa_supplicant_run()` 调用 `eloop_run()` 进入无限循环——进程从此不再主动返回，所有操作都是被动响应事件（内核 netlink 消息、binder 请求、timer 超时）。清理代码只有在进程终止时才执行到。

异常路径则是一刀切：三步任一步失败（`os_program_init()` 非 0、`wpa_supplicant_init()` 返回 NULL、`wpa_supplicant_add_iface()` 返回 NULL）都 `return -1` 退出，由 init 按 restart 策略重新拉起进程。

**主要功能：**

- `os_program_init()` 是平台相关的初始化。在 Android 上，它执行权限降级和安全设置：通过 `setgroups()` 设置附属组（wifi/inet/keystore/log），通过 `setgid()`/`setuid()` 将进程切换到 `wifi` 用户身份，通过 `prctl(PR_SET_KEEPCAPS)` + `capset()` 保留 `CAP_NET_ADMIN` 和 `CAP_NET_RAW` 两项能力（操作 netlink socket 和管理网络接口所必需），最后通过 `srandom()` 初始化随机数种子供后续 EAP 密钥协商使用。
- `wpa_supplicant_init()` 创建 `struct wpa_global`——这是整个 Supplicant 进程的全局根对象。内部调用 `eloop_init()` 创建 epoll fd，调用 `eap_register_methods()` 注册所有 EAP 方法（PEAP、TLS、TTLS、SIM、AKA 等数十种），注册全局 ctrl interface（wpa_cli 的全局级控制通道）。
- `wpa_supplicant_add_iface()` 是每个 WiFi 接口的初始化入口。后面详细展开。
- `wpa_supplicant_run()` 调用 `eloop_run()` 进入无限循环。进程从此不再主动返回——所有操作都是被动响应事件（内核 netlink 消息、binder 请求、timer 超时）。

把这四步串起来，Supplicant 的启动是一条「逐级递进」的链路：OS 层先降权、全局层再搭底座、接口层做最重的初始化、最后进入事件循环。下表给出每一步的典型耗时与影响变量——耗时是量级估计（无逐设备实测），变量是决定这一步快慢的关键因素。

| 步骤                         | 典型耗时     | 影响变量                                                     | 关键动作                                                     |
| ---------------------------- | ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `os_program_init()`          | <1 ms        | 无（固定 syscall 序列）                                      | 降权到 `wifi` 用户、保留 `CAP_NET_ADMIN`/`CAP_NET_RAW`、初始化随机种子 |
| `wpa_supplicant_init()`      | 1~5 ms       | EAP 方法注册数（数十种，基本固定）、`/dev/urandom` 读取延迟  | 分配 `wpa_global`、`eloop_init()` 建 epoll fd、`eap_register_methods()` 注册 EAP 方法 |
| `wpa_supplicant_add_iface()` | 10~50 ms     | 驱动能力探测的 netlink 往返次数、已保存网络数                | 开 nl80211 socket、查硬件特性/能力、初始化 WPA/EAPOL 状态机、WPS/DPP/P2P |
| `wpa_supplicant_run()`       | 无限（阻塞） | `daemonize`（决定 AIDL 注册走同步还是 lazy HAL 路径，见 2.5 节） | 进入 `eloop_run()`，此后只被动响应事件                       |

时间线的关键洞察是：**启动耗时由第三步 `add_iface` 主导**。前三步加起来通常只有几十毫秒，而 `wpa_supplicant_add_iface()` 独占其中大头——它要打开 nl80211 socket，再通过 `wpa_drv_get_hw_feature_data()`、`wpa_drv_get_capa()` 向内核/驱动发起多次能力探测，每一次都是用户态↔内核态的 netlink 往返。相比之下，`os_program_init()` 和 `wpa_supplicant_init()` 只是本地 syscall 和内存分配，几乎可以忽略。`daemonize` 则决定 AIDL 注册落在启动链路的哪个位置：`daemonize=true` 时 `wpas_aidl_init()` 在进入 `eloop_run()` 前同步完成；Android 默认 `daemonize=false` 走 lazy HAL 路径，`wpas_aidl_init()` 反而更早——在 `wpa_supplicant_init()` 内同步完成，真正被推迟到 `ServiceManager` 首次触发的是进程启动本身（详见 2.5 节）。

## 2.2 `wpa_supplicant_init()` 内部：初始化了什么？

```c
// wpa_supplicant/wpa_supplicant.c
struct wpa_global * wpa_supplicant_init(struct wpa_params *params)
{
    struct wpa_global *global;

    // 1. 注册 wpa_msg 的 ifname 回调
    wpa_msg_register_ifname_cb(wpa_supplicant_msg_ifname_cb);

    // 2. 配置 debug 输出（文件 / syslog / stdout / Android logcat / tracing）
    wpa_debug_open_file(params->wpa_debug_file_path);
    wpa_debug_setup_stdout();

    // 3. 【重要】注册所有 EAP 方法
    //    包括：EAP-PEAP、EAP-TLS、EAP-TTLS、EAP-SIM、EAP-AKA、
    //          EAP-AKA'、EAP-PWD、EAP-FAST、EAP-GTC 等数十种
    //    每种 EAP 方法注册自己的 init/deinit/process/getKey 等回调
    eap_register_methods();

    // 4. 分配 global 结构体，逐字段拷贝参数
    //    字符串字段（pid_file / ctrl_interface 等）通过 os_strdup 深拷贝
    global = os_zalloc(sizeof(*global));
    global->params.daemonize = params->daemonize;
    global->params.wait_for_monitor = params->wait_for_monitor;
    global->params.pid_file = os_strdup(params->pid_file);
    global->params.ctrl_interface = os_strdup(params->ctrl_interface);
    // ... 其他字段逐个拷贝 ...

    // 5. 【核心】初始化 eloop 事件循环
    //    在 Linux/Android 上使用 epoll_create1(0)
    if (eloop_init()) {
        wpa_supplicant_deinit(global);
        return NULL;
    }
```

步骤 1-5 搭建了 Supplicant 的两个核心支柱：EAP 方法表和对讲机底座（eloop）。`eap_register_methods()` 注册所有 EAP 方法——每种方法提供 `struct eap_method`（包含 init/process/getKey 等函数指针），`eap_register_methods()` 将它们组织成方法查找表。`eloop_init()` 创建 epoll fd——这是 Supplicant 整个事件驱动架构的基石。

> **IO 多路复用**：Supplicant 需要同时监听多个 I/O 源（binder fd、nl80211 fd、EAPOL fd、ctrl_iface fd、timer fd），但它是单线程的。如果用阻塞 read() 逐一等待，一个 fd 没数据时整个线程就会卡住，其他 fd 的事件也处理不了。IO 多路复用（Linux 上是 epoll）解决了这个问题——它让一个线程同时"盯着"所有 fd，任何一个有数据就绪时 epoll_wait() 立即返回，告诉你是哪些 fd 触发了事件。这就是为什么 Supplicant 能用单线程处理所有 I/O：epoll 帮它实现了"多路监听、单线程处理"。epoll 之前的 select/poll 也能做同样的事，但 epoll 在 fd 数量多时性能更好（O(1) 事件通知 vs O(n) 扫描）。

```c
    // 6. 初始化随机数生成器
    //    从 /dev/urandom 读取种子 + 可选 entropy file
    random_init(params->entropy_file);

    // 7. 创建全局 ctrl interface（Unix domain socket）
    //    路径如：@android:wpa_wlan0（Android abstract socket namespace）
    wpa_supplicant_global_ctrl_iface_init(global);

    // 8. 通知 D-Bus 等外部系统
    wpas_notify_supplicant_initialized(global);

    // 9. 统计可用的驱动数量
    //    遍历 wpa_drivers[] 数组（包含 nl80211、wext 等驱动 wrapper）
    //    为每个驱动分配 priv 指针数组

    // 10. WiFi Display 初始化（如果编译了 CONFIG_WIFI_DISPLAY）
    wifi_display_init(global);

    // 11. 注册周期性清理 timer
    //    每 WPA_SUPPLICANT_CLEANUP_INTERVAL 秒清理过期的 BSS 条目、
    //    重新加载配置文件
    eloop_register_timeout(WPA_SUPPLICANT_CLEANUP_INTERVAL, 0,
                           wpas_periodic, global, NULL);

    return global;
}
```

步骤 6-11 激活外围功能。`random_init()` 从 `/dev/urandom` 获取高质量随机数——这对 EAP 密钥协商至关重要。`wpa_supplicant_global_ctrl_iface_init()` 创建全局级 Unix domain socket，它接受 `wpa_cli` 的连接，支持 `INTERFACE_ADD`、`INTERFACE_REMOVE`、`SAVE_CONFIG` 等全局级命令。步骤 11 的 `eloop_register_timeout()` 注册了 Supplicant 的第一个 timer——一个周期性清理任务，定期释放过期的 BSS 缓存、检查配置文件更新、清理过期 PMKSA 缓存。

## 2.3 `wpa_supplicant_init_iface()` —— 一个接口的完整初始化

这是 Supplicant 中最长、最复杂的函数之一（约 700 行），它把一个 WiFi 接口从「空白状态」初始化为「可工作状态」：

```c
// wpa_supplicant/wpa_supplicant.c

static int wpa_supplicant_init_iface(struct wpa_supplicant *wpa_s,
                                     const struct wpa_interface *iface)
{
    // ===== 第一阶段：基础准备（步骤 1-4） =====

    // 1. 读取配置（从 wpa_supplicant.conf）
    //    在 Android 上，这个文件由 WiFiService 通过 AIDL 动态写入
    //    （因为包含加密后的密码，不能明文存储）
    wpa_s->conf = wpa_config_read(wpa_s->confname, NULL, false);
    if (wpa_s->conf == NULL)
        return -1;

    // 2. 复制接口名（通常是 "wlan0"）
    os_strlcpy(wpa_s->ifname, iface->ifname, sizeof(wpa_s->ifname));

    // 3. 设置 EAPOL 端口状态为 disabled
    //    在 802.1X 中，端口开始是 disabled 的，
    //    只有 EAPOL 认证成功后才会变为 authorized
    eapol_sm_notify_portEnabled(wpa_s->eapol, false);
    eapol_sm_notify_portValid(wpa_s->eapol, false);

    // 4. 【核心】选择和初始化驱动
    if (wpas_init_driver(wpa_s, iface))
        return -1;
    //   内部调用链：
    //     wpa_supplicant_set_driver(wpa_s, "nl80211")
    //     └── wpa_drv_init(wpa_s, "wlan0")
    //         └── wpa_driver_nl80211_init() → 打开 netlink socket
    //             └── wpa_driver_nl80211_capa() → 获取驱动能力
    //     └── radio_add_interface() → 加入 radio 管理
```

**第一阶段小结**：步骤 1-4 完成的是「地基」工作。`wpa_config_read()` 读取网络配置——在 Android 上这不是静态文件，而是由 WiFiService 通过 AIDL 动态写入（密码由 Keystore 解密后传入）。步骤 4 的 `wpas_init_driver()` 是整个初始化的关键转折点：它选择 nl80211 驱动 wrapper，打开与内核 cfg80211 的 netlink socket，就像前台接待插上了对讲机的电源线——从此刻起，Supplicant 可以向内核发送 `NL80211_CMD_*` 命令并接收事件。

```c
    // ===== 第二阶段：能力探测与 WPA 初始化（步骤 5-8） =====

    // 5. 初始化 WPA 状态机（WPA/WPA2/WPA3 协商的核心）
    wpa_supplicant_init_wpa(wpa_s);

    // 6. 获取硬件特性数据（如 ACS channel list）
    wpa_drv_get_hw_feature_data(wpa_s, ...);

    // 7. 获取驱动能力（max_scan_ssids、max_remain_on_chan 等）
    wpa_drv_get_capa(wpa_s);

    // 8. 驱动最终配置
    if (wpa_supplicant_driver_init(wpa_s))
        return -1;
    //   内部步骤：
    //     a. wpa_supplicant_update_mac_addr() → 获取 MAC 地址
    //        （内部调用 l2_packet_init() 初始化 EAPOL L2 packet socket）
    //     c. wpa_clear_keys() → 清除所有 key material
    //     d. wpa_drv_flush_pmkid() → 清空 PMKID 缓存
    //     e. wpa_supplicant_enabled_networks() → 启用已配置的网络
```

**第二阶段小结**：驱动连通后，步骤 5-8 探测硬件能力并初始化安全核心。`wpa_supplicant_init_wpa()` 建立 WPA/WPA2/WPA3 的状态机框架——这是后续四次握手和组密钥握手的执行引擎。两个 `get_*` 调用向驱动查询硬件能力：最多同时扫描几个 SSID、offchannel 最长能待多久——这些值直接影响后续扫描策略。`wpa_supplicant_driver_init()` 完成最后的驱动配置：获取 MAC 地址、初始化 L2 packet socket（用于收发 EAPOL 帧）、清除所有密钥残留、启用已保存的网络配置。

```c
    // ===== 第三阶段：高级功能与对外接口（步骤 9-12） =====

    // 9. 初始化各种高级功能
    wpas_wps_init(wpa_s);           // WPS (WiFi Protected Setup)
    wpas_dpp_init(wpa_s);           // DPP (Device Provisioning Protocol / WiFi Easy Connect)
    wpas_nan_usd_init(wpa_s);       // NAN USD (Neighbor Awareness Networking)
    wpa_supplicant_init_eapol(wpa_s); // EAPOL 状态机

    // 10. 创建 per-interface ctrl socket
    //     路径如：/data/vendor/wifi/wpa/sockets/wlan0
    if (wpa_supplicant_ctrl_iface_init(wpa_s))
        return -1;

    // 11. 初始化 GAS query（用于 ANQP/Hotspot 2.0）
    wpa_s->gas = gas_query_init(wpa_s);

    // 12. 初始化 P2P（如果支持）
    wpas_p2p_init(wpa_s->global, wpa_s);

    return 0;
}
```

**第三阶段小结**：地基和能力都确认后，步骤 9-12 激活高级功能并建立对外接口——接待台的工作手册填写完毕，对讲机频道全部开通。WPS 和 DPP 提供零配置配网能力（WPS 用 PIN/PBC，DPP 用 QR 码），EAPOL 状态机进入就绪状态。`wpa_supplicant_ctrl_iface_init()` 创建 per-interface 的 Unix domain socket（路径如 `/data/vendor/wifi/wpa/sockets/wlan0`），`wpa_cli` 通过它发送 `SCAN`、`LIST_NETWORKS`、`STATUS` 等命令。GAS query 为 Hotspot 2.0 的 ANQP 查询做准备，最后 P2P 初始化使接口具备 Wi-Fi Direct 能力。

## 2.4 eloop 事件循环 —— 为什么 wpa_supplicant 不需要多线程？

wpa_supplicant 的核心架构设计哲学是：**单进程、单线程、事件驱动**。所有 I/O 操作都通过 eloop 统一调度：

```c
// src/utils/eloop.c:163-192
// 精简说明：实际源码通过 CONFIG_ELOOP_EPOLL/POLL/SELECT/KQUEUE
// 条件编译支持 4 种后端，以下展示 Android 平台的 epoll 路径。
// 源码有精简（去除了 select/poll/kqueue 分支、trace 代码）。
int eloop_init(void)
{
    os_memset(&eloop, 0, sizeof(eloop));
    dl_list_init(&eloop.timeout);

    // Android/Linux 走 epoll 路径
    eloop.epollfd = epoll_create1(0);
    if (eloop.epollfd < 0) {
        wpa_printf(MSG_ERROR, "%s: epoll_create1 failed. %s",
                   __func__, strerror(errno));
        return -1;
    }

    // 三个 socket table 的 type 标签——在 eloop_sock_table_dispatch() 中
    // 用于将 epoll 返回的 EPOLLIN/EPOLLOUT/EPOLLERR 映射到对应的 handler 数组
    // EVENT_TYPE_* 是 eloop 内部定义的私有枚举，与 epoll 事件位掩码一一对应
    eloop.readers.type = EVENT_TYPE_READ;
    eloop.writers.type = EVENT_TYPE_WRITE;
    eloop.exceptions.type = EVENT_TYPE_EXCEPTION;

    return 0;
}
```

`eloop_init()` 的核心操作只有两步：创建 epoll fd（`epoll_create1(0)`），初始化三个 socket table（readers / writers / exceptions）。它不做任何 fd 注册——那由各个模块在初始化时调用 `eloop_register_read_sock()` 完成。可以这样理解：eloop 是一个对讲机底座，`eloop_init()` 给底座通了电，但各个频道（fd）要由使用方自己插上去。

```c
// src/utils/eloop.c:1071-1253（行号对应原始含条件编译的源码，精简为 epoll 路径后仅作参考）
void eloop_run(void)
{
    int timeout_ms = -1;
    int res;
    struct os_reltime tv, now;

    while (!eloop.terminate &&
           (!dl_list_empty(&eloop.timeout) ||
            eloop.readers.count > 0 ||
            eloop.writers.count > 0 ||
            eloop.exceptions.count > 0)) {

        struct eloop_timeout *timeout;

        // 1. 处理待决的终止信号
        if (eloop.pending_terminate) {
            eloop_process_pending_signals();
            if (eloop.terminate)
                break;
        }

        // 2. 计算下一个 timeout 的到期时间
        //    取 timer 链表头（按到期时间排序），
        //    计算距离 now 的时间差（秒+微秒 → 毫秒）
        timeout = dl_list_first(&eloop.timeout, struct eloop_timeout, list);
        if (timeout) {
            os_get_reltime(&now);
            if (os_reltime_before(&now, &timeout->time))
                os_reltime_sub(&timeout->time, &now, &tv);
            else
                tv.sec = tv.usec = 0;
            timeout_ms = tv.sec * 1000 + tv.usec / 1000;
        }

        // 3. 调用 epoll_wait 阻塞等待
        //    可能被三类事件唤醒：
        //    a. 已注册的 fd 变为可读/可写/异常
        //    b. timeout 到期（返回 0）
        //    c. 信号到达（返回 -1，errno == EINTR）
        if (eloop.count == 0) {
            res = 0;
        } else {
            res = epoll_wait(eloop.epollfd, eloop.epoll_events,
                             eloop.count, timeout_ms);
        }

        // 4. 错误处理
        if (res < 0 && errno != EINTR && errno != 0) {
            wpa_printf(MSG_ERROR, "eloop: epoll: %s", strerror(errno));
            goto out;
        }
```

等待阶段的精髓在于 `epoll_wait` 的 `timeout_ms` 参数。eloop 不是死循环空转——它通过计算最近一个 timer 的到期时间，让 `epoll_wait` 精确阻塞到那个时刻。如果没有任何 fd 注册也没有 timer，while 循环条件不满足，循环自然退出。这个设计意味着进程在空闲时几乎不消耗 CPU：`epoll_wait` 会让进程进入内核的 `TASK_INTERRUPTIBLE` 睡眠状态，直到有事件到来才被唤醒。

```c
        // 5. 清除 changed 标志 + 处理待决信号
        eloop.readers.changed = 0;
        eloop.writers.changed = 0;
        eloop.exceptions.changed = 0;
        eloop_process_pending_signals();

        // 6. 处理到期的 timer
        //    每次循环只处理链表头的第一个 timer（timer 按到期时间排序）。
        //    处理完一个 timer 后，while 循环重新进入，epoll_wait 重新计算
        //    最近一个 timer 的超时——如果还有到期的 timer，下一轮会继续处理，
        //    直到所有到期 timer 都被消费。
        timeout = dl_list_first(&eloop.timeout, struct eloop_timeout, list);
        if (timeout) {
            os_get_reltime(&now);
            if (!os_reltime_before(&now, &timeout->time)) {
                void *eloop_data = timeout->eloop_data;
                void *user_data = timeout->user_data;
                eloop_timeout_handler handler = timeout->handler;
                eloop_remove_timeout(timeout);
                handler(eloop_data, user_data);
            }
        }

        // 7. res == 0 表示纯 timeout 唤醒，无 I/O 事件，跳过 dispatch
        if (res <= 0)
            continue;

        // 8. 如果 socket 表在 signal/timeout handler 中被修改，重试
        if (eloop.readers.changed ||
            eloop.writers.changed ||
            eloop.exceptions.changed) {
            continue;
        }

        // 9. 分发 I/O 事件到注册的 callback
        //    epoll 路径通过 event.data.fd 查找对应 socket 的 callback
        eloop_sock_table_dispatch(eloop.epoll_events, res);
    }

    eloop.terminate = 0;
out:
    return;
}
```

分发阶段处理两类唤醒源：timer 到期（步骤 6）和 I/O 事件就绪（步骤 9）。值得注意的细节是步骤 8——如果在 timer callback 中修改了 socket 表（比如注册了一个新的 fd），eloop 会 `continue` 重试整个循环，而不是继续分发旧的事件列表，避免了在已被修改的数据结构上操作。步骤 7 的 `continue` 则跳过了 I/O 分发：如果 `epoll_wait` 只是因 timeout 返回（没有任何 fd 就绪），处理完 timer 就重新进入等待，无需遍历 socket table。

![eloop 架构](assets/04-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%B8%89%EF%BC%89Supplicant-%E5%90%AF%E5%8A%A8/04-eloop-architecture.svg)

> **图 2.1：eloop 事件循环架构** —— epoll fd 居中调度，四周连接的 fd（nl80211 / ctrl / EAPOL / binder）各自注册对应的 callback，右侧 timer 链表按到期时间排序。

**主要功能：**

- eloop 的本质是一个「事件分发器」：注册 fd + callback，当 fd 可读/可写/异常时调用 callback。加上 timer 机制（到期后调用 callback）。所有异步操作都转换为「注册一个 callback 等待某个 fd 变为可读」。
- 注册到 eloop 的 fd 包括：
  - **nl80211 netlink socket**：来自内核 cfg80211 的事件（扫描结果到达、关联状态变更、断开通知等）。对应的 callback 是 `wpa_driver_nl80211_event_receive()`。
  - **per-interface ctrl socket**：来自 `wpa_cli` 的命令。对应的 callback 是 `wpa_supplicant_ctrl_iface_receive()`。
  - **EAPOL L2 packet socket**：来自 AP 的 EAPOL 帧（四次握手的关键帧）。对应的 callback 是 `wpa_supplicant_rx_eapol()`。
  - **AIDL binder fd**：来自 Java Framework 的 binder 请求。对应的 callback 是 `wpas_aidl_sock_handler()`。
  - **DHCP packet socket**：DHCP 响应包（如果 Supplicant 负责 DHCP）。
- 单线程模型避免了锁竞争，代码简单可靠。代价是每个 callback 必须快速返回、不能执行阻塞 I/O。如果有耗时操作（如完整的 TLS 握手涉及多次往返），需要将其拆分为多个异步状态并通过 eloop 的 timeout 机制驱动状态机。

## 2.5 AIDL 注册：Supplicant 怎么和 Java Framework 对接？

在 `wpa_supplicant_run()` 中（实际在进入 eloop 循环之前），如果编译了 `CONFIG_AIDL`，会检查 `params.daemonize` 标志。当 `daemonize=true` 时（后台守护进程模式），同步调用 `wpas_aidl_init()` 完成 AIDL 注册。在 Android 上，wpa_supplicant 由 init 启动时 `daemonize` 通常为 false，AIDL 注册走的是 lazy HAL 路径——由 `ServiceManager.waitForDeclaredService()` 在 Supplicant 外部触发。无论哪条路径，最终都会调用 `wpas_aidl_init()`：

```c
// wpa_supplicant/aidl/vendor/aidl.cpp
struct wpas_aidl_priv *wpas_aidl_init(struct wpa_global *global)
{
    struct wpas_aidl_priv *priv;

    priv = os_zalloc(sizeof(*priv));
    if (!priv)
        return NULL;

    priv->global = global;

    // 1. 设置 binder 轮询
    //    返回一个 fd，当有 binder 请求到达时该 fd 变为可读
    ABinderProcess_setupPolling(&priv->aidl_fd);

    // 2. 把 binder fd 注册到 eloop
    //    从此刻起，Java 端的 binder 请求会触发 eloop 中的
    //    wpas_aidl_sock_handler() 回调
    if (eloop_register_read_sock(priv->aidl_fd,
                                 wpas_aidl_sock_handler,
                                 global, priv) < 0) {
        wpas_aidl_deinit(priv);
        return NULL;
    }

    // 3. 创建 Supplicant 对象（继承自 BnSupplicant）
    //    这个对象持有 struct wpa_global* 指针，
    //    当 Java 调用 addStaInterface 时，内部调用 wpa_supplicant_add_iface()
    aidl_manager = AidlManager::getInstance();

    // 4. 向 ServiceManager 注册 AIDL 服务
    //    服务名：android.hardware.wifi.supplicant.ISupplicant/default
    if (aidl_manager->registerAidlService(global) != 0) {
        wpas_aidl_deinit(priv);
        return NULL;
    }

    return priv;
}
```

两条路径的时序差异值得展开：`daemonize=true`（经典守护进程）时，`wpa_supplicant_run()` 先调 `wpa_supplicant_daemon()` fork 出后台子进程，再同步调用 `wpas_aidl_init()`（binder fd 须在 fork 后的子进程内创建，避免父子共享同一 fd 的所有权，见 `notify.c:95` 注释）——binder fd 注册进 eloop、AIDL 服务写入 ServiceManager 全部落定后才进入 `eloop_run()`，此时接口已 add_iface 完成，Java 一连上即可用。`daemonize=false`（Android 默认）则相反：`wpas_aidl_init()` 反而执行得更早——在 `wpa_supplicant_init()` 第 8 步 `wpas_notify_supplicant_initialized()` 内同步完成，早于任何接口的 add_iface。真正被「推迟」的是进程启动本身：lazy HAL 下 init 不主动拉起 wpa_supplicant，等 Framework 端 `ServiceManager.waitForDeclaredService()` 首次触发才启动进程，进程一起来 AIDL 注册随即落定。这条初始化链的错误传播是闭环的：`wpas_aidl_init()` 返回 NULL → `wpas_notify_supplicant_initialized()` 返回 -1 → `wpa_supplicant_init()` 返回 NULL → `main()` `return -1`，进程退出后由 init 按 restart 策略重新拉起。

**Java 端如何连接**：

```java
// packages_modules_Wifi/service/java/com/android/server/wifi/SupplicantStaIfaceHalAidlImpl.java
public class SupplicantStaIfaceHalAidlImpl {
    private ISupplicant mISupplicant;
    private Map<String, ISupplicantStaIface> mISupplicantStaIfaces;

    // 1. 等待服务注册（阻塞直到超时或服务出现）
    boolean initialize() {
        if (!ServiceManager.isDeclared(
                "android.hardware.wifi.supplicant.ISupplicant/default")) {
            return false;
        }
        return true;
    }

    // 2. 连接到 AIDL 服务
    boolean startDaemon() {
        mISupplicant = ISupplicant.Stub.asInterface(
            ServiceManager.waitForDeclaredService(
                "android.hardware.wifi.supplicant.ISupplicant/default"));
        // 3. 注册 DeathRecipient（当 Supplicant 进程崩溃时收到通知）
        mISupplicant.asBinder().linkToDeath(mSupplicantDeathRecipient, 0);
        return true;
    }

    // 4. 设置 STA 接口
    boolean setupIface(String ifaceName) {
        // 调用 AIDL 方法 addStaInterface
        // 在 native 侧：Supplicant::addStaInterface()
        //     └── wpa_supplicant_add_iface(wpa_global_, "wlan0", ...)
        ISupplicantStaIface iface = mISupplicant.addStaInterface(ifaceName);
        mISupplicantStaIfaces.put(ifaceName, iface);
        return true;
    }

    // 5. 注册回调（接收 Supplicant 事件通知）
    void registerCallback(String ifaceName, ISupplicantStaIfaceCallback callback) {
        mISupplicantStaIfaces.get(ifaceName).registerCallback(callback);
    }
}
```

**主要功能：**

- binder fd 注册到 eloop 是关键设计决策。这意味着 AIDL 请求和其他 I/O 事件共享同一个事件循环。好处是无需额外线程处理 binder，坏处是如果某个 AIDL 处理函数执行时间过长，会阻塞其他所有 I/O（包括 nl80211 事件和 EAPOL 包）。
- `addStaInterface("wlan0")` 的调用链穿过了整个 binder 栈：Java → Binder driver（ioctl）→ native libbinder → `ABinderProcess_handlePolledCommands()` → `Supplicant::addStaInterface()` → `wpa_supplicant_add_iface()`。它执行的是和 `main()` 中对 `-i wlan0` 完全相同的初始化逻辑。
- 除了 vendor AIDL 服务外，还有一个 mainline AIDL 服务（`wifi_mainline_supplicant`），通过 `mainline_aidl_init()` 注册。Mainline 服务提供 NAN USD（WiFi Aware 服务发现）接口的动态管理能力。mainline 服务以 `/apex/com.android.wifi/bin/wpa_supplicant_mainline` 独立进程运行，与 vendor 服务并存、各自向 ServiceManager 注册。

---

# 3 状态机详解：前台的「状态指示牌」

如果说 eloop 是前台的**对讲机总机**——负责把厨房（内核）和客人（Java Framework）的每条消息转接进来，那么状态机就是前台墙上的**状态指示牌**：Supplicant 的 10 个状态决定了它能做什么、不能做什么，以及下一步应该做什么。

## 3.1 `enum wpa_states` —— 10 个状态，一个完整的连接生命周期

枚举按连接自然流程从 0 递增到 9，扫读时抓顺序即懂进展。

```c
// external_wpa_supplicant_8/src/common/defs.h:248-353
enum wpa_states {
    /**
     * WPA_DISCONNECTED - 断开连接状态
     *
     * 客户端未关联，但可能随时开始搜索 AP。
     * 连接丢失时进入此状态。
     */
    WPA_DISCONNECTED,           // 0

    /**
     * WPA_INTERFACE_DISABLED - 接口已禁用
     *
     * 网络接口被禁用时进入（如 rfkill 关闭 WiFi）。
     * Supplicant 拒绝任何使用射频的新操作，直到接口重新启用。
     */
    WPA_INTERFACE_DISABLED,     // 1

    /**
     * WPA_INACTIVE - 非活跃状态
     *
     * 配置中没有启用的网络时进入。Supplicant 不会主动关联，
     * 需要外部交互（ctrl_iface 调用添加或启用网络）来启动关联。
     */
    WPA_INACTIVE,               // 2

    /**
     * WPA_SCANNING - 正在扫描网络
     *
     * Supplicant 开始扫描时进入。
     */
    WPA_SCANNING,               // 3

    /**
     * WPA_AUTHENTICATING - 正在与 BSS 认证
     *
     * 找到合适的 BSS 后，驱动配置为尝试与该 BSS 认证。
     * 仅在使用 wpa_supplicant 作为 SME 的驱动中使用。
     */
    WPA_AUTHENTICATING,         // 4

    /**
     * WPA_ASSOCIATING - 正在与 BSS 关联
     *
     * ap_scan=1 模式下驱动配置为尝试关联。
     * ap_scan=2 模式下驱动配置为使用已配置的 SSID 和安全策略关联。
     */
    WPA_ASSOCIATING,            // 5

    /**
     * WPA_ASSOCIATED - 关联已完成
     *
     * 驱动报告关联成功。如果使用 IEEE 802.1X，
     * Supplicant 保持在此状态直到 EAPOL 认证完成。
     */
    WPA_ASSOCIATED,             // 6

    /**
     * WPA_4WAY_HANDSHAKE - WPA 四次握手进行中
     *
     * WPA-PSK: 关联后收到第一个 EAPOL-Key 帧时进入。
     * WPA-EAP: IEEE 802.1X/EAPOL 认证完成后进入。
     */
    WPA_4WAY_HANDSHAKE,         // 7

    /**
     * WPA_GROUP_HANDSHAKE - WPA 组密钥握手进行中
     *
     * 四次握手完成后（Supplicant 发出 msg 4/4），
     * 或 AP 发起组密钥更新时（收到 msg 1/2）。
     */
    WPA_GROUP_HANDSHAKE,        // 8

    /**
     * WPA_COMPLETED - 所有认证已完成
     *
     * WPA2: 四次握手成功完成。
     * WPA: 组密钥握手完成后。
     * IEEE 802.1X: 收到动态密钥后（或 EAP 认证完成后）。
     * 静态 WEP/明文: 关联完成后。
     *
     * 此状态表示数据连接已完全配置好。
     */
    WPA_COMPLETED               // 9
};
```

**枚举值设计意图：**

注意：枚举值没有显式赋值，C 语言编译器自动给它们赋值 0, 1, 2, ..., 9。这个顺序不是随意的——它对应了 STA 从断开到完成连接的**自然流程**。这个顺序让代码中大量使用 `>` 和 `<` 比较来判断「进展」：

- `if (state > WPA_SCANNING)` → 「已经过了扫描阶段」→ 停止自动扫描
- `if (state < WPA_ASSOCIATED)` → 「还没有完成关联」→ 停止后台扫描
- `if (old_state >= WPA_ASSOCIATED && wpa_s->wpa_state < WPA_ASSOCIATED)` → 「从已关联掉到了未关联」→ 通知 WMM AC 断开

> **注意**：`WPA_AUTHENTICATING`（值 4）只在 SME 模式下使用（驱动设置了 `WPA_DRIVER_FLAGS_SME`）。非 SME 模式下，状态会直接从 `SCANNING`（3）跳到 `ASSOCIATING`（5），中间不会经过 `AUTHENTICATING`。因此 `> WPA_SCANNING` 在非 SME 模式下等价于「已经开始关联或更后面」。

## 3.2 `wpa_supplicant_set_state()` —— 状态切换的「仪式」

状态切换不是简单的赋值。`wpa_supplicant_set_state()` 是一个约 180 行的函数，它执行了 5 个阶段的操作：

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant.c:1032-1209
// 精简：去掉 CONFIG_P2P/CONFIG_SME/CONFIG_FILS 等条件编译分支
void wpa_supplicant_set_state(struct wpa_supplicant *wpa_s,
                              enum wpa_states state)
{
    enum wpa_states old_state = wpa_s->wpa_state;

    wpa_dbg(wpa_s, MSG_DEBUG, "State: %s -> %s",
            wpa_supplicant_state_txt(wpa_s->wpa_state),
            wpa_supplicant_state_txt(state));

    // ===== 阶段 1：准备阶段（新状态的副作用） =====

    // 到达 COMPLETED → 记录漫游时间
    if (state == WPA_COMPLETED &&
        os_reltime_initialized(&wpa_s->roam_start)) {
        os_reltime_age(&wpa_s->roam_start, &wpa_s->roam_time);
        wpa_s->roam_start.sec = 0;
        wpa_s->roam_start.usec = 0;
        wpas_notify_auth_changed(wpa_s);
        wpas_notify_roam_time(wpa_s);
        wpas_notify_roam_complete(wpa_s);
    }
    // 离开漫游状态（回到 DISCONNECTED）→ 清除漫游时间
    else if (state == WPA_DISCONNECTED &&
             os_reltime_initialized(&wpa_s->roam_start)) {
        wpa_s->roam_start.sec = 0;
        wpa_s->roam_start.usec = 0;
        wpa_s->roam_time.sec = 0;
        wpa_s->roam_time.usec = 0;
        wpas_notify_roam_complete(wpa_s);
    }

    // 接口被禁用 → 重置 normal_scans
    if (state == WPA_INTERFACE_DISABLED)
        wpa_s->normal_scans = 0;

    // 到达 COMPLETED → 清理 connect work、重置 normal_scans
    if (state == WPA_COMPLETED) {
        wpas_connect_work_done(wpa_s);
        wpa_s->normal_scans = 0;
    }

    // ===== 阶段 2：新连接副作用 =====

    // 离开 SCANNING → 通知扫描停止
    if (state != WPA_SCANNING)
        wpa_supplicant_notify_scanning(wpa_s, 0);

    // 到达 COMPLETED 且是新连接 → 发送 WPA_EVENT_CONNECTED 事件
    if (state == WPA_COMPLETED && wpa_s->new_connection) {
        struct wpa_ssid *ssid = wpa_s->current_ssid;
        char mld_addr[50];
        mld_addr[0] = '\0';
        if (wpa_s->valid_links)
            os_snprintf(mld_addr, sizeof(mld_addr),
                        " ap_mld_addr=" MACSTR,
                        MAC2STR(wpa_s->ap_mld_addr));

        wpa_msg(wpa_s, MSG_INFO, WPA_EVENT_CONNECTED "- Connection to "
                MACSTR " completed [id=%d id_str=%s%s]%s",
                MAC2STR(wpa_s->bssid),
                ssid ? ssid->id : -1,
                ssid && ssid->id_str ? ssid->id_str : "",
                fils_hlp_sent ? " FILS_HLP_SENT" : "", mld_addr);

        // 连接成功 → 清除临时禁用、重置连续失败计数
        wpas_clear_temp_disabled(wpa_s, ssid, 1);
        wpa_s->consecutive_conn_failures = 0;
        wpa_s->new_connection = 0;
        wpa_drv_set_operstate(wpa_s, 1);     // 通知内核接口 UP
        wpa_s->after_wps = 0;
        wpa_s->known_wps_freq = 0;
        sme_sched_obss_scan(wpa_s, 1);       // 调度 OBSS 扫描
    }
    // 回到 DISCONNECTED / ASSOCIATING / ASSOCIATED → 标记新连接
    else if (state == WPA_DISCONNECTED || state == WPA_ASSOCIATING ||
             state == WPA_ASSOCIATED) {
        wpa_s->new_connection = 1;
        wpa_drv_set_operstate(wpa_s, 0);     // 通知内核接口 DOWN
        sme_sched_obss_scan(wpa_s, 0);
    }
```

阶段 1 和阶段 2 都在状态赋值**之前**执行——它们根据「将要变成什么状态」做清理和记录工作，比如记录漫游耗时、清理 connect work、发送 `WPA_EVENT_CONNECTED` 事件通知上层。这些操作需要用到旧状态信息（如 `wpa_s->new_connection` 标志、`roam_start` 时间戳），一旦状态被覆盖就丢失了上下文。

```c
    // ===== 阶段 3：赋值 =====
    wpa_s->wpa_state = state;

    // ===== 阶段 4：赋值后副作用（依赖新状态值） =====

    // 到达 COMPLETED 但切换了 SSID → 重置后台扫描
    if (state == WPA_COMPLETED && wpa_s->current_ssid != wpa_s->bgscan_ssid)
        wpa_supplicant_reset_bgscan(wpa_s);
    else if (state < WPA_ASSOCIATED)
        wpa_supplicant_stop_bgscan(wpa_s);

    // 超过 SCANNING → 停止自动扫描
    if (state > WPA_SCANNING)
        wpa_supplicant_stop_autoscan(wpa_s);

    // DISCONNECTED 或 INACTIVE → 启动自动扫描
    if (state == WPA_DISCONNECTED || state == WPA_INACTIVE)
        wpa_supplicant_start_autoscan(wpa_s);

    // 完成态 / 禁用态 / 非活跃态 → 重置 BTM
    if (state == WPA_COMPLETED || state == WPA_INTERFACE_DISABLED ||
        state == WPA_INACTIVE)
        wnm_btm_reset(wpa_s);

    // 从已关联掉到未关联 → 通知 WMM AC 断开
    if (old_state >= WPA_ASSOCIATED && wpa_s->wpa_state < WPA_ASSOCIATED)
        wmm_ac_notify_disassoc(wpa_s);

    // ===== 阶段 5：状态变更通知（仅当状态确实变化时） =====
    if (wpa_s->wpa_state != old_state) {
        wpas_notify_state_changed(wpa_s, wpa_s->wpa_state, old_state);

        // 通知 P2P Device 接口
        wpas_p2p_indicate_state_change(wpa_s);

        // COMPLETED 进出 → 通知认证变更
        if (wpa_s->wpa_state == WPA_COMPLETED ||
            old_state == WPA_COMPLETED)
            wpas_notify_auth_changed(wpa_s);

        // 到达 COMPLETED 且 bigtk 已设置但未验证 → 验证 SSID beacon protection
        if (wpa_s->wpa_state == WPA_COMPLETED &&
            wpa_s->bigtk_set && !wpa_s->ssid_verified)
            wpas_verify_ssid_beacon_prot(wpa_s);
    }
}
```

阶段 3 到阶段 5 是赋值**之后**的逻辑。核心行只有一句 `wpa_s->wpa_state = state`，但它前后的 if-else 逻辑构成了完整的「状态切换仪式」。阶段 4 的决策全部依赖新状态值——比如 `state > WPA_SCANNING` 判断是否已经过了扫描阶段，这个比较只有在新值生效后才有意义。阶段 5 的多通道通知确保 Java Framework、P2P 模块、D-Bus 等所有观察者同步得知状态变化。bigtk 验证（`wpas_verify_ssid_beacon_prot`）紧跟在 `wpas_notify_auth_changed()` 之后，同样仅在状态确实变化时触发。

**五个阶段的总结：**

| 阶段            | 做什么                                                       | 为什么                                               |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| 1. 准备阶段     | 处理新状态立即需要的清理/记录（漫游时间、normal_scans）      | 这些操作需要旧状态信息，必须在赋值前完成             |
| 2. 新连接副作用 | 发 `WPA_EVENT_CONNECTED` 事件、设置 operstate、清除失败计数  | 连接成功/断开的副作用，影响上层 Framework            |
| 3. 赋值         | `wpa_s->wpa_state = state`                                   | 核心操作，最简单但也最危险——后面所有代码都依赖这个值 |
| 4. 赋值后副作用 | 启动/停止扫描、重置 BTM、WMM AC 通知                         | 这些决策需要知道**新状态是什么**                     |
| 5. 状态变更通知 | `wpas_notify_state_changed()` → AIDL callback → Java Framework | 只有状态真的变了才通知，避免无意义事件               |

用餐厅的比喻来说，`wpa_supplicant_set_state()` 就是更新「当前状态指示牌」——但更新不只是翻个牌子，前后还有五步「仪式」要走。

## 3.3 状态转换速查表

| 触发事件                          | 原状态                              | 新状态                                                    | 代码位置                                         |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| 禁用接口（rfkill/Airplane mode）  | 任意                                | WPA_INTERFACE_DISABLED                                    | `wpa_supplicant_disable_network()`               |
| 启用接口                          | WPA_INTERFACE_DISABLED              | WPA_DISCONNECTED                                          | `wpa_supplicant_enable_network()`                |
| 没有启用的网络                    | WPA_DISCONNECTED                    | WPA_INACTIVE                                              | `wpa_supplicant_set_state()`                     |
| 开始扫描                          | WPA_DISCONNECTED / INACTIVE         | WPA_SCANNING                                              | `wpa_supplicant_scan()`                          |
| 认证开始（SME 模式）              | WPA_SCANNING                        | WPA_AUTHENTICATING                                        | `sme_authenticate()`                             |
| 关联开始                          | WPA_AUTHENTICATING (SME) / SCANNING | WPA_ASSOCIATING                                           | `sme_associate()` / `wpa_supplicant_associate()` |
| 关联成功（EVENT_ASSOC）           | WPA_ASSOCIATING                     | WPA_ASSOCIATED                                            | `wpa_supplicant_event()`                         |
| 收到 EAPOL-Key msg 1/4            | WPA_ASSOCIATED                      | WPA_4WAY_HANDSHAKE                                        | `wpa_sm_notify_eapol_rx()`                       |
| 四次握手完成（msg 4/4 发出）      | WPA_4WAY_HANDSHAKE                  | WPA_GROUP_HANDSHAKE                                       | `wpa_supplicant_key_neg_complete()`              |
| 组密钥握手完成 / 直接完成         | WPA_GROUP_HANDSHAKE                 | WPA_COMPLETED                                             | `wpa_supplicant_key_neg_complete()`              |
| 断开连接（EVENT_DISASSOC/DEAUTH） | 任意                                | WPA_DISCONNECTED                                          | `wpa_supplicant_event()`                         |
| 扫描完成但无匹配网络              | WPA_SCANNING                        | WPA_DISCONNECTED / INACTIVE（恢复 `scan_prev_wpa_state`） | `scan_only_handler()`                            |

![wpa_supplicant 状态机层级图](assets/04-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%B8%89%EF%BC%89Supplicant-%E5%90%AF%E5%8A%A8/04-state-machine.svg)

> **图 3.1：wpa_supplicant 状态机层级（10 状态的连接生命周期）** —— 主链（绿）沿枚举值 0→9 推进：DISCONNECTED → SCANNING → AUTHENTICATING → ASSOCIATING → ASSOCIATED → 4WAY_HANDSHAKE → GROUP_HANDSHAKE → COMPLETED；旁路（橙虚线）是 WPA_INTERFACE_DISABLED（禁用）与 WPA_INACTIVE（无网络）两条分支。上面的速查表逐行对应这条主链上的每一次跃迁。

> **关键设计洞察**：状态是按数值递增的（DISCONNECTED=0, ..., COMPLETED=9）。这意味着 `>` 比较等价于「进展更多」。源码中大量使用 `if (state > WPA_SCANNING)` 来判断「是否已经过了扫描阶段」，这种设计让代码非常简洁。

---

# 4 事件驱动架构：对讲机的「总机」

Supplicant 设计了**分层事件处理架构**：

```text
内核 nl80211 事件
    │
    ▼
wpa_driver_nl80211_event_receive()   ← eloop callback（fd 可读）
    │  解析 netlink message，提取事件类型和 data
    ▼
wpa_supplicant_event()               ← 事件分发总入口（本章主题）
    │  switch (event) → 按类型分发
    ├── EVENT_AUTH     → sme_event_auth()
    ├── EVENT_ASSOC    → wpa_supplicant_event_assoc()
    ├── EVENT_DISASSOC → wpas_event_disassoc()
    ├── EVENT_DEAUTH   → wpas_event_deauth()
    ├── EVENT_SCAN_RESULTS → wpa_supplicant_event_scan_results()
    ├── EVENT_EAPOL_RX → wpa_supplicant_rx_eapol()
    └── ... (30+ 种事件)
```

## 4.1 `wpa_supplicant_event()` —— 事件分发总入口

```c
// external_wpa_supplicant_8/wpa_supplicant/events.c:6274-6445
// 精简：去掉 CONFIG_FST/CONFIG_TDLS/CONFIG_WNM 等条件编译分支，
//       保留核心 STA 事件路径
void wpa_supplicant_event(void *ctx, enum wpa_event_type event,
                          union wpa_event_data *data)
{
    struct wpa_supplicant *wpa_s = ctx;

    // ===== 入口守卫：接口禁用时忽略大多数事件 =====
    if (wpa_s->wpa_state == WPA_INTERFACE_DISABLED &&
        event != EVENT_INTERFACE_ENABLED &&
        event != EVENT_INTERFACE_STATUS &&
        event != EVENT_SCAN_RESULTS &&
        event != EVENT_SCHED_SCAN_STOPPED) {
        wpa_dbg(wpa_s, MSG_DEBUG,
                "Ignore event %s (%d) while interface is disabled",
                event_to_string(event), event);
        return;
    }

    // ===== 事件分发（switch 30+ 种事件类型） =====
    switch (event) {
    case EVENT_AUTH:
        // 认证结果（仅 SME 模式使用）
        sme_event_auth(wpa_s, data);
        wpa_s->auth_status_code = data->auth.status_code;
        wpas_notify_auth_status_code(wpa_s);
        break;

    case EVENT_ASSOC:
        // 关联成功 —— 核心路径
        if (wpa_s->disconnected) {
            wpa_printf(MSG_INFO,
                       "Ignore unexpected EVENT_ASSOC in disconnected state");
            break;
        }
        wpa_supplicant_event_assoc(wpa_s, data);
        wpa_s->assoc_status_code = WLAN_STATUS_SUCCESS;
        // 如果驱动报告 authorized 或 FILS 已完成 → 立即推进到授权
        if (data &&
            (data->assoc_info.authorized ||
             (!(wpa_s->drv_flags & WPA_DRIVER_FLAGS_SME) &&
              wpa_fils_is_completed(wpa_s->wpa))))
            wpa_supplicant_event_assoc_auth(wpa_s, data);
        break;

    case EVENT_DISASSOC:
        // 收到 Disassociation 帧
        // 省略 CONFIG_TESTING_OPTIONS 守卫分支
        wpas_event_disassoc(wpa_s,
                            data ? &data->disassoc_info : NULL);
        break;

    case EVENT_DEAUTH:
        // 收到 Deauthentication 帧
        // 省略 CONFIG_TESTING_OPTIONS 守卫分支（ignore_auth_resp 等）
        wpas_event_deauth(wpa_s,
                          data ? &data->deauth_info : NULL);
        break;
```

前四个 case（AUTH / ASSOC / DISASSOC / DEAUTH）构成了连接状态变更的核心路径。`EVENT_ASSOC` 是其中最重要的——它不只是记录关联成功，还会检查驱动是否已在内部完成 SME（`authorized` 标志），如果是则直接跳过 EAPOL 阶段推进到授权完成。驱动内建 SME 的动机是把认证/关联状态机 offload 到固件，省掉 host↔driver 的往返，也降低 host 功耗。`EVENT_DISASSOC` 和 `EVENT_DEAUTH` 分别处理两种断开方式：Disassociation 通常由 AP 主动发起（如负载均衡），Deauthentication 则可能由 AP 或 STA 任一方发起。

```c
    case EVENT_SCAN_STARTED:
        // 扫描已开始（硬件确认）
        if (wpa_s->own_scan_requested ||
            (data && !data->scan_info.external_scan)) {
            os_get_reltime(&wpa_s->scan_start_time);
            wpa_s->own_scan_requested = 0;
            wpa_s->own_scan_running = 1;
            wpa_msg_ctrl(wpa_s, MSG_INFO, WPA_EVENT_SCAN_STARTED);
        } else {
            wpa_dbg(wpa_s, MSG_DEBUG, "External program started a scan");
            wpa_s->radio->external_scan_req_interface = wpa_s;
        }
        break;

    case EVENT_SCAN_RESULTS:
        // 扫描结果到达 —— 核心路径
        if (wpa_s->wpa_state == WPA_INTERFACE_DISABLED) {
            wpa_s->scan_res_handler = NULL;
            wpa_s->own_scan_running = 0;
            break;
        }
        // 记录扫描耗时
        if (!(data && data->scan_info.external_scan) &&
            os_reltime_initialized(&wpa_s->scan_start_time)) {
            struct os_reltime now, diff;
            os_get_reltime(&now);
            os_reltime_sub(&now, &wpa_s->scan_start_time, &diff);
            wpa_s->wps_scan_done = true;
        }
        // 处理扫描结果（解析、缓存、通知上层）
        if (wpa_supplicant_event_scan_results(wpa_s, data))
            break; /* interface may have been removed */
        wpa_s->own_scan_running = 0;
        // 检查是否有下一个 radio work 需要执行
        radio_work_check_next(wpa_s);
        break;

    case EVENT_ASSOC_REJECT:
        // 关联被 AP 拒绝
        wpas_event_assoc_reject(wpa_s, data);
        break;

    case EVENT_AUTH_TIMED_OUT:
        // 认证超时（SME 模式）
        if (wpa_s->drv_flags & WPA_DRIVER_FLAGS_SME)
            sme_event_auth_timed_out(wpa_s, data);
        break;

    case EVENT_ASSOC_TIMED_OUT:
        // 关联超时（SME 模式）
        if (wpa_s->drv_flags & WPA_DRIVER_FLAGS_SME)
            sme_event_assoc_timed_out(wpa_s, data);
        break;
```

扫描事件组是 Work Queue 模式的关键触发点。`EVENT_SCAN_STARTED` 区分「自己发起的扫描」和「外部程序触发的扫描」，内部扫描会记录 `scan_start_time` 用于后续计算扫描耗时。`EVENT_SCAN_RESULTS` 处理最重——解析扫描结果并更新 BSS 缓存，处理完毕后调用 `radio_work_check_next()` 自动启动队列中的下一个射频任务（如排队中的连接请求）。

```c
    case EVENT_EAPOL_RX:
        // 收到 EAPOL 帧 → 推入 EAPOL 状态机
        wpa_supplicant_rx_eapol(wpa_s, data->eapol_rx.src,
                                data->eapol_rx.data,
                                data->eapol_rx.data_len,
                                data->eapol_rx.encrypted);
        break;

    case EVENT_SIGNAL_CHANGE:
        // 信号强度变化 → 通知上层
        wpa_bss_update_level(wpa_s->current_bss,
                             data->signal_change.data.signal);
        bgscan_notify_signal_change(wpa_s, ...);
        wpas_notify_signal_change(wpa_s);
        break;

    case EVENT_INTERFACE_ENABLED:
        // 接口重新启用 → 从 WPA_INTERFACE_DISABLED 恢复
        if (wpa_s->wpa_state == WPA_INTERFACE_DISABLED) {
            wpa_supplicant_update_mac_addr(wpa_s);
            wpa_supplicant_set_default_scan_ies(wpa_s);
            wpa_supplicant_set_state(wpa_s, WPA_DISCONNECTED);
            wpa_s->scan_req = NORMAL_SCAN_REQ;
            wpa_supplicant_req_scan(wpa_s, 0, 0);
        }
        break;

    case EVENT_RX_MGMT:
        // 收到管理帧 → 按子类型分发给 P2P/IBSS/Mesh/PASN/SAE 等模块
        // （此处省略约 100 行的子类型分发逻辑）
        break;

    case EVENT_MICHAEL_MIC_FAILURE:
        // Michael MIC 失败 → 可能是 TKIP 攻击
        wpa_supplicant_event_michael_mic_failure(wpa_s, data);
        break;

    // ... 更多事件类型：EVENT_REMAIN_ON_CHANNEL、EVENT_CH_SWITCH、
    //     EVENT_DFS_*、EVENT_TX_STATUS、EVENT_INTERFACE_MAC_CHANGED ...
    }
}
```

**主要功能：**

- `wpa_supplicant_event()` 的门卫机制：接口禁用时（`WPA_INTERFACE_DISABLED`），只允许 4 种事件通过——`EVENT_INTERFACE_ENABLED`（恢复）、`EVENT_INTERFACE_STATUS`（状态查询）、`EVENT_SCAN_RESULTS`（清理扫描状态）、`EVENT_SCHED_SCAN_STOPPED`（停止调度扫描）。其他所有事件都被忽略。
- 关联成功后的 `authorized` 检查：如果驱动在关联完成时就报告了 authorized（这说明驱动内部完成了 SME），则 Supplicant 直接跳过 EAPOL 阶段，进入认证完成处理。
- 扫描结果的 `radio_work_check_next()`：扫描完成后，Supplicant 检查 radio 的 work 队列是否有下一个任务（如连接请求在扫描期间被提交）。这是 Work Queue 模式的核心——扫描只是队列中的一个任务，完成后自动启动下一个。

## 4.2 事件流全景

![Supplicant 事件流全景](assets/04-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%B8%89%EF%BC%89Supplicant-%E5%90%AF%E5%8A%A8/04-event-flow.svg)

eloop 就像前台的对讲机总机——binder fd、nl80211 fd、EAPOL fd 是三个频道，任何一个响起就转给对应部门（AIDL 处理 / 事件分发 / 安全模块）。关键是：总机一次只处理一条消息，处理完才接下一条——这正对应半双工对讲机的特性：按着说话时收不到其他频道，说完松开才轮到别人。

---

# 5 AIDL 接口层：三级服务

Supplicant 的 AIDL 接口分了**三个层级**，对应不同的抽象层次。这就像餐厅的三级服务：前台经理（ISupplicant）、服务员（ISupplicantStaIface）、菜单（ISupplicantStaNetwork）。

## 5.1 ISupplicant —— 进程级接口（前台经理）

```java
// hardware_interfaces/wifi/supplicant/aidl/android/hardware/wifi/supplicant/ISupplicant.aidl
@VintfStability
interface ISupplicant {
    // ===== 接口管理（核心方法） =====
    @PropagateAllowBlocking ISupplicantStaIface addStaInterface(in String ifName);     // 添加 STA 接口
    @PropagateAllowBlocking ISupplicantP2pIface addP2pInterface(in String ifName);     // 添加 P2P 接口
    void removeInterface(in IfaceInfo ifaceInfo);              // 移除接口
    @PropagateAllowBlocking ISupplicantStaIface getStaInterface(in String ifName);     // 获取已有 STA 接口
    @PropagateAllowBlocking ISupplicantP2pIface getP2pInterface(in String ifName);     // 获取已有 P2P 接口
    IfaceInfo[] listInterfaces();                           // 列出所有接口

    // ===== 回调注册 =====
    void registerCallback(in ISupplicantCallback callback);    // 注册全局回调
    void registerNonStandardCertCallback(in INonStandardCertCallback callback);

    // ===== 全局控制 =====
    void setDebugParams(in DebugLevel level, in boolean showTimestamp, in boolean showKeys);
    DebugLevel getDebugLevel();
    void setConcurrencyPriority(in IfaceType type);            // 设置 STA/P2P 并发优先级
    oneway void terminate();                                       // 终止服务
}
```

**关键方法详解：**

> **`@PropagateAllowBlocking` 注解**：标注了此注解的方法允许在 binder 线程中执行阻塞操作（如文件 I/O、驱动初始化）。默认情况下 binder 调用不允许阻塞，但 Supplicant 的接口初始化涉及内核交互，可能耗时较长，因此需要此注解。`addStaInterface`、`getStaInterface`、`addP2pInterface`、`getP2pInterface` 四个方法都标注了此注解。

- `addStaInterface(String ifName)`：这是 Framework 创建 WiFi 接口的入口。传入 "wlan0"，Supplicant 内部调用 `wpa_supplicant_add_iface()`——和 `main()` 中对 `-i wlan0` 执行完全相同的初始化逻辑。返回 `ISupplicantStaIface` 对象供后续操作。
- `removeInterface(IfaceInfo)`：移除接口时传入类型+名称。Supplicant 内部调用 `wpa_supplicant_remove_iface()`，释放对应的 `struct wpa_supplicant` 和所有关联资源（扫描缓存、网络配置、密钥材料等）。
- `terminate()`：**oneway** 方法（不需要等待返回）。Framework 调用它通知 Supplicant 准备退出。在 lazy HAL 协议下，这可以触发进程退出。

## 5.2 ISupplicantStaIface —— STA 接口级接口（服务员）

```java
// hardware_interfaces/wifi/supplicant/aidl/android/hardware/wifi/supplicant/ISupplicantStaIface.aidl

@VintfStability
interface ISupplicantStaIface {
    // ===== 网络管理 =====
    @PropagateAllowBlocking ISupplicantStaNetwork addNetwork();         // 添加网络配置 → 返回 network 对象
    void removeNetwork(in int id);                  // 删除网络
    int[] listNetworks();                        // 列出所有网络 ID
    @PropagateAllowBlocking ISupplicantStaNetwork getNetwork(in int id);    // 获取指定网络

    // ===== 连接控制 =====
    void disconnect();                           // 断开当前连接
    void reassociate();                          // 强制重新关联
    void reconnect();                            // 重新连接（仅当已断开时）
    void enableAutoReconnect(in boolean enable);    // 启用/禁用自动重连

    // ===== 回调注册 =====
    void registerCallback(in ISupplicantStaIfaceCallback callback);

    // ===== 射频控制 =====
    int addExtRadioWork(in String name, in int freqInMhz, in int timeoutInSec); // 外部射频任务
    void removeExtRadioWork(in int id);             // 取消外部射频任务

    // ===== 高级功能入口 =====
    void setPowerSave(in boolean enable);           // 省电模式
    void setCountryCode(in byte[] code);            // 国家码
    void setBtCoexistenceMode(in BtCoexistenceMode mode);  // BT 共存
    void setBtCoexistenceScanModeEnabled(in boolean enable);
    // ... DPP, WPS, ANQP, TDLS, QoS, USD 等 30+ 个方法 ...
}
```

**关键方法详解：**

- `addNetwork()`：创建一个新的 `ISupplicantStaNetwork` 对象，对应 Supplicant 内部的 `struct wpa_ssid`。返回的 network 对象初始为空——Framework 需要后续调用 `setSsid()`、`setKeyMgmt()` 等方法填充配置。
- `disconnect()` vs `reassociate()` vs `reconnect()`：三个方法语义不同。`disconnect()` 是主动断开，进入 `WPA_DISCONNECTED`；`reassociate()` 是强制对当前 AP 重新执行关联（用于刷新密钥）；`reconnect()` 只在已断开时重新连接（如果已连接则返回错误）。
- `registerCallback(ISupplicantStaIfaceCallback)`：Framework 通过它注册回调对象，Supplicant 状态变化时通过 binder 反向调用 Java 端的 `onStateChanged()` 等方法。这是观察者模式的典型实现。

## 5.3 ISupplicantStaNetwork —— 网络配置接口（菜单）

这张菜单列出网络的全部配置项，读时抓 `setSsid` / `setKeyMgmt` / `select` 三行即可。

```java
// hardware_interfaces/wifi/supplicant/aidl/android/hardware/wifi/supplicant/ISupplicantStaNetwork.aidl

@VintfStability
interface ISupplicantStaNetwork {
    // ===== 核心配置 =====
    void setSsid(in byte[] ssid);                   // 设置 SSID（最长 32 字节）
    void setBssid(in byte[] bssid);                 // 设置目标 BSSID（限定 AP）
    void setKeyMgmt(in KeyMgmtMask keyMgmtMask);    // 设置密钥管理方式
    void setPskPassphrase(in String psk);           // 设置 PSK 密码短语（8-63 字符）
    void setPsk(in byte[] psk);                     // 设置原始 PSK（32 字节）
    void setSaePassword(in String saePassword);     // 设置 SAE 密码（WPA3）
    void setSaePasswordId(in String saePasswordId); // 设置 SAE 密码 ID

    // ===== 安全套件 =====
    void setProto(in ProtoMask protoMask);          // WPA/RSN 协议版本
    void setPairwiseCipher(in PairwiseCipherMask mask);   // 成对密钥密码
    void setGroupCipher(in GroupCipherMask mask);         // 组密钥密码
    void setGroupMgmtCipher(in GroupMgmtCipherMask mask); // 管理帧保护密码
    void setRequirePmf(in boolean enable);          // 要求 PMF

    // ===== EAP 配置 =====
    void setEapMethod(in EapMethod method);         // EAP 方法
    void setEapPhase2Method(in EapPhase2Method method); // Phase 2 方法
    void setEapIdentity(in byte[] identity);
    void setEapPassword(in byte[] password);
    void setEapCACert(in String path);              // CA 证书路径
    void setEapClientCert(in String path);          // 客户端证书路径
    void setEapPrivateKeyId(in String id);          // 私钥 ID（智能卡）

    // ===== 连接控制 =====
    @PropagateAllowBlocking void select();          // 发起连接
    void enable(in boolean noConnect);              // 启用网络
    void disable();                                 // 禁用网络

    // ===== 查询 =====
    int getId();                                 // 获取网络 ID
    byte[] getSsid();                            // 获取 SSID
    String getPskPassphrase();                   // 获取密码短语
    IfaceType getType();                         // 获取接口类型
    // ... 更多 getter/setter ...
}
```

**关键方法详解：**

- `select()`：触发 Supplicant 使用此网络配置发起连接。它内部调用 `wpa_supplicant_select_network()`，设置 `wpa_s->next_ssid` 并触发扫描或直接连接。
- `setPskPassphrase(String)` vs `setPsk(byte[])`：前者接受 8-63 字符的 ASCII 密码短语（Supplicant 内部通过 PBKDF2 派生 PMK），后者接受 32 字节的原始 PSK（跳过派生直接使用）。
- EAP 配置是网络配置中最复杂的部分：涉及证书路径、私钥、多种 EAP 方法的选择。

## 5.4 事件回调机制 —— 从 C 到 Java 的状态通知

```java
// hardware_interfaces/wifi/supplicant/aidl/android/hardware/wifi/supplicant/
// ISupplicantStaIfaceCallback.aidl

@VintfStability
oneway interface ISupplicantStaIfaceCallback {
    // 状态变化通知（核心）
    void onStateChanged(StaIfaceCallbackState newState, byte[] bssid,
                        int id, byte[] ssid, boolean filsHlpSent);
    void onSupplicantStateChanged(SupplicantStateChangeData stateChangeData); // v2

    // 连接事件
    void onDisconnected(byte[] bssid, boolean locallyGenerated,
                        StaIfaceReasonCode reasonCode);
    void onAssociationRejected(AssociationRejectionData assocRejectData);
    void onAuthenticationTimeout(byte[] bssid);

    // 网络事件
    void onNetworkAdded(int id);
    void onNetworkRemoved(int id);
    void onNetworkNotFound(byte[] ssid);

    // 安全事件
    void onEapFailure(byte[] bssid, int errorCode);
    void onPmkCacheAdded(long expirationTimeInSec, byte[] serializedEntry); // deprecated
    void onPmkSaCacheAdded(PmkSaCacheData pmkSaData); // v2 replacement

    // BSS 事件
    void onBssidChanged(BssidChangeReason reason, byte[] bssid);
    void onBssFrequencyChanged(int frequencyMhz);
    void onBssTmHandlingDone(BssTmData tmData);

    // ... WPS/DPP/QoS/MLO/USD 等 30+ 个回调方法 ...
}
```

**回调触发链路（以状态变化为例）**：

```text
wpa_s->wpa_state 变化
    │
    ▼
wpa_supplicant_set_state()  (阶段 5: wpas_notify_state_changed)
    │
    ├──→ wpa_msg_ctrl() → "WPA_EVENT_STATE_CHANGED" → ctrl socket
    │       （wpa_cli 可见，用于调试）
    │
    └──→ wpas_aidl_notify_state_changed()
            │  aidl/vendor/aidl.cpp
            ▼
          SupplicantStaIfaceCallback::onStateChanged()  [Binder 跨进程]
            │
            ▼
          SupplicantStaIfaceCallbackAidlImpl::onStateChanged()
            │  packages_modules_Wifi/.../SupplicantStaIfaceCallbackAidlImpl.java
            ▼
          WifiMonitor.broadcastSupplicantStateChangeEvent()
            │
            ▼
          ClientModeImpl (StateMachine) → 更新连接状态
```

- **双通道并行通知**：`wpas_notify_state_changed()` 同时走两条路径——ctrl socket（`wpa_cli` 可见，用于调试）和 AIDL callback（Framework 消费）。两条路径在 `wpas_notify_state_changed()` 内部是串行调用的，但从外部看它们是同一事件的两个通知目标。
- **oneway 修饰**：所有 AIDL 回调方法都声明为 `oneway`，Supplicant 发送回调后不等待 Java 端的处理结果，避免被慢速的 Framework 处理阻塞。

---

# 6 设计模式：前台的「SOP 流程」

Supplicant 代码库中反复出现四种设计模式。理解它们就等于掌握了代码的组织逻辑。

## 6.1 虚函数表模式 —— `wpa_driver_ops`

Supplicant 支持多种驱动后端（nl80211、wext、wired 等），通过虚函数表实现多态。读这段先抓 `name` 与 `init` 两行，其余是同构函数指针：

```c
// external_wpa_supplicant_8/src/drivers/driver.h:3097-5353
// 精简：只展示代表性函数指针（完整结构体约 2256 行，包含 60+ 函数指针）

struct wpa_driver_ops {
    const char *name;                            // 驱动名称（"nl80211"）
    const char *desc;                            // 描述

    // 虚函数表 —— 每个驱动实现自己的版本
    void * (*init)(void *ctx, const char *ifname);    // 初始化
    void (*deinit)(void *priv);                       // 反初始化
    int (*get_bssid)(void *priv, u8 *bssid);          // 获取 BSSID
    int (*get_ssid)(void *priv, u8 *ssid);            // 获取 SSID
    int (*set_key)(void *priv, struct wpa_driver_set_key_params *params); // 设置密钥
    int (*associate)(void *priv, struct wpa_driver_associate_params *params); // 关联
    int (*deauthenticate)(void *priv, const u8 *addr, u16 reason_code);  // 去认证
    int (*get_capa)(void *priv, struct wpa_driver_capa *capa);           // 获取能力
    int (*send_mlme)(void *priv, const u8 *data, size_t data_len, ...);  // 发送管理帧
    void (*poll)(void *priv);                        // 轮询关联信息
    int (*set_operstate)(void *priv, int state);     // 设置 operstate
    struct hostapd_hw_modes * (*get_hw_feature_data)(void *priv, ...); // 硬件特性
    // ... 共约 60 个函数指针 ...
};
```

**实际使用：**

```c
// Supplicant 核心代码通过 wpa_drv_* 宏调用，而不是直接调用 driver->*
// wpa_supplicant/driver_i.h
static inline int wpa_drv_associate(struct wpa_supplicant *wpa_s,
                                     struct wpa_driver_associate_params *params)
{
    if (wpa_s->driver->associate)
        return wpa_s->driver->associate(wpa_s->drv_priv, params);
    return -1;
}

// nl80211 驱动实现（wpa_driver_nl80211_ops）
// src/drivers/driver_nl80211.c
const struct wpa_driver_ops wpa_driver_nl80211_ops = {
    .name = "nl80211",
    .desc = "Linux nl80211/cfg80211",
    .init = wpa_driver_nl80211_init,
    .deinit = wpa_driver_nl80211_deinit,
    .get_bssid = wpa_driver_nl80211_get_bssid,
    .get_ssid = wpa_driver_nl80211_get_ssid,
    .set_key = wpa_driver_nl80211_set_key,
    .associate = wpa_driver_nl80211_associate,
    // ... 填充所有函数指针 ...
};
```

- **60 个函数指针不是都要实现**：`wpa_drv_*` 宏在调用前检查函数指针是否为 NULL。不支持的操作用 `return -1` 优雅降级。
- **驱动选择在初始化时确定**：`wpa_supplicant_set_driver(wpa_s, "nl80211")` 遍历 `wpa_drivers[]` 数组，找到 name 匹配的 `wpa_driver_ops`，赋值给 `wpa_s->driver`。
- **为什么不用 C++ 虚函数？** wpa_supplicant 是纯 C 项目（历史原因：2003 年开始开发时 C++ 在嵌入式系统上不普及）。手动虚函数表是 C 语言实现多态的标准做法。

## 6.2 观察者模式 —— 状态变化通知链

Supplicant 的状态变化通过**多通道**通知出去：

```text
wpa_supplicant_set_state()
    │
    ├──→ wpas_notify_state_changed(wpa_s, new_state, old_state)
    │       │
    │       ├──→ 全局 ctrl socket: wpa_msg_ctrl(global, "WPA_EVENT_STATE_CHANGED ...")
    │       ├──→ per-iface ctrl socket: wpa_msg_ctrl(wpa_s, "WPA_EVENT_STATE_CHANGED ...")
    │       └──→ AIDL callback: wpas_aidl_notify_state_changed()
    │                │
    │                └──→ SupplicantStaIfaceCallback::onStateChanged() [binder 跨进程]
    │                         │
    │                         └──→ SupplicantStaIfaceCallbackAidlImpl::onStateChanged()
    │                                  │
    │                                  └──→ WifiMonitor.broadcastSupplicantStateChangeEvent()
    │                                           │
    │                                           └──→ ClientModeImpl (StateMachine)
    │
    └──→ wpas_notify_auth_changed(wpa_s)  [COMPLETED 进出时额外触发]
    │       │
    │       └──→ AIDL callback (onAuthenticationTimeout / onEapFailure etc.)
    │
    └──→ wpas_p2p_indicate_state_change(wpa_s)  [通知 P2P Device 接口]
```

- **多观察者、多通道**：一个状态变化同时通知 ctrl_iface（调试）、AIDL callback（Framework）、P2P（内部模块）、D-Bus（如果启用）。
- **通知只在状态确实变化时发生**：`wpa_supplicant_set_state()` 阶段 5 有 `if (wpa_s->wpa_state != old_state)` 守卫，避免重复设置同一状态时产生垃圾通知。

## 6.3 Work Queue 模式 —— `radio_add_work()` 序列化射频操作

WiFi 芯片只有一个射频前端，但可能有多个操作竞争使用它（扫描、连接、P2P 发现……）。Work Queue 模式解决了这个问题：

```c
// external_wpa_supplicant_8/wpa_supplicant/wpa_supplicant.c:7131-7178
// 精简：去掉调试日志

int radio_add_work(struct wpa_supplicant *wpa_s, unsigned int freq,
                   const char *type, int next,
                   void (*cb)(struct wpa_radio_work *work, int deinit),
                   void *ctx)
{
    struct wpa_radio *radio = wpa_s->radio;
    struct wpa_radio_work *work;
    int was_empty;

    // 1. 分配 work item，填充参数
    work = os_zalloc(sizeof(*work));
    work->freq = freq;
    work->type = type;       // "scan" / "connect" / "p2p-scan" / ...
    work->wpa_s = wpa_s;
    work->cb = cb;           // 当 work 开始执行时调用
    work->ctx = ctx;

    // 2. 计算涉及的频段
    if (freq)
        work->bands = wpas_freq_to_band(freq);
    else if (os_strcmp(type, "scan") == 0 ||
             os_strcmp(type, "p2p-scan") == 0)
        work->bands = wpas_get_bands(wpa_s,
                         ((struct wpa_driver_scan_params *)ctx)->freqs);
    else
        work->bands = wpas_get_bands(wpa_s, NULL);

    // 3. 插入队列（next=1 插头部，next=0 插尾部）
    was_empty = dl_list_empty(&wpa_s->radio->work);
    if (next)
        dl_list_add(&wpa_s->radio->work, &work->list);      // 高优先级
    else
        dl_list_add_tail(&wpa_s->radio->work, &work->list); // 普通优先级

    // 4. 如果队列之前是空的，立即开始
    if (was_empty) {
        radio_work_check_next(wpa_s);
    }
    // 5. 驱动支持并发 offchannel 且未满 → 尝试并行
    else if ((wpa_s->drv_flags & WPA_DRIVER_FLAGS_OFFCHANNEL_SIMULTANEOUS)
             && radio->num_active_works < MAX_ACTIVE_WORKS) {
        radio_work_check_next(wpa_s);
    }

    return 0;
}
```

`radio_add_work()` 是 Work Queue 的「入队」操作——创建 work item，按优先级（`next=1` 插头部、`next=0` 插尾部）插入射频队列。入队后如果队列为空或驱动支持并发 offchannel 且未达到 `MAX_ACTIVE_WORKS` 上限，立即触发执行。`type` 字段（`"scan"` / `"connect"` / `"p2p-scan"`）不仅是日志标签，还影响频段计算逻辑——扫描类 work 需要从外部传入的扫描参数中解析频段列表。

```c
// wpa_supplicant.c:7188-7197
void radio_work_done(struct wpa_radio_work *work)
{
    struct wpa_supplicant *wpa_s = work->wpa_s;
    unsigned int started = work->started;

    // 记录耗时
    radio_work_free(work);
    // 如果确实开始执行过，检查下一个
    if (started)
        radio_work_check_next(wpa_s);
}
```

`radio_work_done()` 是 Work Queue 的「出队」操作——释放 work item，然后自动调用 `radio_work_check_next()` 启动队列中的下一个任务。`if (started)` 守卫很关键：如果 work 在开始执行前就被取消了（`radio_remove_works()`），`started` 为 0，此时不需要触发下一个任务。这保证了射频操作的串行链式推进——每个 work 完成后自动启动下一个。

**Work Queue 的关键特性：**

- **高优先级插队**：`next=1` 的 work 插入链表头部（如用户手动触发扫描），`next=0` 插入尾部（如自动扫描）。
- **并发度控制**：`MAX_ACTIVE_WORKS = 2`。支持 `OFFCHANNEL_SIMULTANEOUS` 的驱动可以同时执行最多 2 个 work。
- **自动链式推进**：`radio_work_done()` 调用 `radio_work_check_next()`，自动启动下一个 work。这保证了射频操作串行执行、不会冲突。

## 6.4 状态保存/恢复模式 —— `scan_prev_wpa_state`

扫描是一个特殊的操作——它需要临时改变接口的状态，但不能丢失扫描前的状态信息：

```c
// wpa_supplicant/scan.c:1157-1160
// 开始扫描时（无条件保存当前状态）：
wpa_s->scan_prev_wpa_state = wpa_s->wpa_state;  // 始终保存
if (wpa_s->wpa_state == WPA_DISCONNECTED ||
    wpa_s->wpa_state == WPA_INACTIVE)
    wpa_supplicant_set_state(wpa_s, WPA_SCANNING);  // 仅这两种状态才转换

// wpa_supplicant/scan.c:3282-3283（scan_only_handler 中）
// 扫描完成时（有守卫条件）：
if (wpa_s->wpa_state == WPA_SCANNING)
    wpa_supplicant_set_state(wpa_s, wpa_s->scan_prev_wpa_state);
```

- **为什么需要保存/恢复？** 扫描可能在多种状态下被触发——可能在 `WPA_DISCONNECTED` 时自动扫描寻找 AP，也可能在 `WPA_COMPLETED` 时后台扫描做 roaming 准备。扫描完成后必须恢复到原来的状态。
- **保存是无条件的，状态转换是有条件的**：`scan_prev_wpa_state` 始终保存当前状态（即使已经是 SCANNING 也会覆盖），但只有在 `WPA_DISCONNECTED` 或 `WPA_INACTIVE` 时才会真正转入 `WPA_SCANNING`。恢复时也有守卫——只有当前状态确实是 `WPA_SCANNING` 才恢复，避免在扫描期间发生了其他状态转换（如关联）时错误回退。
- **恢复不是简单赋值**：`wpa_supplicant_set_state()` 会再次执行 5 阶段操作，包括状态变更通知。这意味着 Framework 会看到 `COMPLETED → SCANNING → COMPLETED` 的状态序列，这是正确的行为。
- **主要恢复点在 `scan_only_handler()`**（scan.c:3262），而非 `wpa_supplicant_event_scan_results()`。`scan_only_handler()` 是扫描 radio work 的回调，扫描完成时由 `radio_work_done()` 触发。

用餐厅的比喻收个尾：`scan_prev_wpa_state` 就像前台接待去门口「看看外面有什么客人」（扫描）之前，先在状态指示牌上临时翻到「扫描中」；看完回来再照着记下的旧状态把牌子翻回原位——而不是永远停在「扫描中」忘了复位。

---

# 7 总结：Supplicant 架构全景

## 7.1 eloop 单线程模型：为什么不用多线程？

wpa_supplicant 的核心架构设计是单进程、单线程、事件驱动。这个设计贯穿了整个 Supplicant 的生命周期——从 `main()` 调用 `eloop_run()` 开始，进程就进入了一个无限循环，所有操作（接收内核 netlink 事件、处理 binder 请求、驱动 EAPOL 状态机）都是在这个循环中被动触发的回调。

单线程模型的核心优势是：**避免了所有锁竞争**。如果 Supplicant 使用多线程——比如一个线程处理 nl80211 事件、另一个线程处理 binder 请求、第三个线程处理 EAPOL 定时器——那么 `struct wpa_supplicant` 中的数百个字段（`wpa_state`、`key_mgmt`、`ptk`、`gtk` 等）都需要加锁保护。

以 Supplicant 的状态复杂度，锁的粒度和顺序将极难正确设计——死锁和竞态条件的风险远大于单线程模型的性能损失。

代价是每个 eloop callback 必须快速返回。如果有耗时操作（如完整的 EAP-TLS 握手涉及多次往返），需要将其拆分为多个异步状态，通过 eloop 的 timeout 机制驱动状态机推进。这增加了代码复杂度，但换来了确定性——你知道在任何一个时间点，只有一个 callback 在运行，没有任何字段被并发修改。

## 7.2 五大核心设计要素

| 设计要素     | 核心价值                                                     | 关键文件                                                     |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **数据结构** | `wpa_global`（全局根对象）→ `wpa_supplicant`（每接口状态）→ `wpa_radio`（射频互斥）→ `wpa_radio_work`（任务队列）→ `wpa_ssid`（网络配置） | `wpa_supplicant_i.h`                                         |
| **状态机**   | 10 个状态的数值递增设计，`wpa_supplicant_set_state()` 的 5 阶段执行 | `wpa_supplicant.c`, `defs.h`                                 |
| **eloop**    | 单线程事件驱动，epoll 统一调度所有 I/O + timer               | `eloop.c`                                                    |
| **AIDL**     | 三层接口：ISupplicant（进程级）→ ISupplicantStaIface（接口级）→ ISupplicantStaNetwork（网络级） | `ISupplicant.aidl`, `ISupplicantStaIface.aidl`, `ISupplicantStaNetwork.aidl` |
| **事件处理** | `wpa_supplicant_event()` 分发 30+ 事件到对应的 SME/EAPOL/Scan 处理器 | `events.c`                                                   |

把五件套放回餐厅视角：数据结构是接待台的工作手册（记录每个接口和网络的状态），状态机是墙上的状态指示牌（决定下一步能做什么），eloop 是前台的对讲机总机（转接所有消息），AIDL 三级服务是面对客人的窗口（前台经理/服务员/菜单），事件处理则是传菜通道（把每条消息送到对应的后厨部门）。

## 7.3 从这篇文章开始，后续将怎么展开？

Supplicant 启动是餐厅「前台接待就位」的一步——它确保芯片就绪后上层能正常使用 WiFi。前台就位之后，后续各章依次展开上层的建筑：

- **扫描**：芯片就绪后第一个动作，如何发现周围的 AP？QCOM 的 scan engine 如何调度主动扫描和被动扫描？MTK 如何在三个频段之间并行扫描？
- **关联**：怎么选择 AP、完成 802.11 的认证和关联？安全模式（Open/WPA2/WPA3）如何影响关联流程？
- **四次握手与 EAPOL**：WPA2 的 PSK 模式和 WPA3 的 SAE 模式的密钥协商细节。wpa_supplicant 的 EAPOL 状态机如何驱动四次握手？
- **IP 获取与数据通路**：DHCP 流程、ARP 表填充、路由表配置，数据包如何从芯片 → HIF → 网络栈 → socket。

每一章都会继续沿着 QCOM 和 MTK 两条路径对比走读。

## 7.4 Supplicant 端点速查表

全文各环节的入口函数散落在上面几节，下面把它们收进一张速查表——从启动到事件分发、从 AIDL 注册到射频任务队列，每个环节的入口函数、核心机制、关键文件一页扫完。

| 环节            | 入口函数                                      | 核心机制                                          | 关键文件                                                     |
| --------------- | --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Supplicant 启动 | `main()` → `eloop_run()`                      | epoll 事件循环（单线程）                          | `external_wpa_supplicant_8/wpa_supplicant/main.c`            |
| 全局初始化      | `wpa_supplicant_init()`                       | EAP 方法注册 + eloop_init + ctrl iface            | `wpa_supplicant/wpa_supplicant.c`                            |
| 接口初始化      | `wpa_supplicant_add_iface()`                  | nl80211 socket + WPA 状态机 + EAPOL socket        | `wpa_supplicant/wpa_supplicant.c`                            |
| 状态切换        | `wpa_supplicant_set_state()`                  | 5 阶段执行 + 多通道通知                           | `wpa_supplicant/wpa_supplicant.c:1032`                       |
| 事件分发        | `wpa_supplicant_event()`                      | switch 30+ 事件类型                               | `wpa_supplicant/events.c:6274`                               |
| AIDL 注册       | `wpas_aidl_init()`                            | binder fd → eloop + ServiceManager 注册           | `wpa_supplicant/aidl/vendor/aidl.cpp`                        |
| Java 端连接     | `SupplicantStaIfaceHalAidlImpl.startDaemon()` | `ISupplicant.Stub.asInterface()` + DeathRecipient | `packages_modules_Wifi/service/java/com/android/server/wifi/SupplicantStaIfaceHalAidlImpl.java` |
| 射频任务队列    | `radio_add_work()` + `radio_work_done()`      | 双向链表队列 + 并发度控制                         | `wpa_supplicant/wpa_supplicant.c:7131`                       |
| 回调通知        | `wpas_notify_state_changed()`                 | AIDL oneway 跨进程回调                            | `wpa_supplicant/notify.c`                                    |

---

> **下一章**：芯片就绪后，第一个动作永远是扫描。我们会看到 QCOM 的 `wlan_scan` engine 如何调度主动扫描（Probe Request）和被动扫描（Beacon 监听），MTK 的 `scan_module` 如何利用 offload 能力在 2.4G/5G/6G 三个频段并行扫描，以及 wpa_supplicant 的 `wpa_supplicant_scan()` 如何把一次 scan request 从 Java `WifiManager.startScan()` 一路传到芯片寄存器。

> 到这里，「STA 打开」系列完结。从用户点击 WiFi 开关，到 Framework 调度、HAL 桥接、驱动加载、固件握手、Supplicant 前台就位——整条链路已经完整走通，餐厅正式开张迎客。接下来，我们将进入 WiFi 最基础的操作：扫描。

*本文涉及的规范章节：IEEE 802.11-2020 §5.1 (STA architecture), §4.3 (WLAN components), §11.3 (STA authentication and association)；Wi-Fi Alliance WPA3 Specification v3.5 §2 (WPA3-Personal / SAE)。源码路径索引见文内各代码块首行注释。*

**源码出处**：[external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/)、AIDL 定义 `hardware_interfaces/wifi/supplicant/aidl/`。
