---
title: Android WiFi 源码分析：全景架构——从点击开关到数据包
top: 1
related_posts: true
abbrlink: b73ef544
date: 2026-09-19 19:13:54
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 当你点击手机上的 WiFi 热点名称，一个连接请求从 Java 层的 `WifiManager.connect()` 出发（注：connect() 已从公开 API 移除、现为 @SystemApi @hide，本文用其展示调用链完整性），经过 Framework 状态机、AIDL HAL、C 守护进程、Netlink 内核接口，最终变成一帧 802.11 Auth 空中帧。
>
> 这条路径跨越百万行级代码、5 层架构、2 大芯片平台。本文为你画出这张全景地图——告诉你每一层"是什么"、"为什么这么设计"、以及该按什么顺序读代码。

# 本章导读

如果把 WiFi 系统比作一家大型医院——App 是患者（提出需求），Framework 是门诊部（分诊、调度），Supplicant 是主治医师（做出诊断和治疗决策），HAL 是医疗器械标准（不管哪个品牌的 CT 机，接口都一样），Driver 是具体的医疗设备（高通的 CT 机和联发科的 CT 机内部构造不同，但都遵循 HAL 标准），Firmware 是设备内部的嵌入式控制系统（你看不到源码，但设备靠它运转）。患者不需要知道 CT 机是哪个品牌的——这正是分层架构的意义。

<!--more-->

**你将学到**：

- Android WiFi 全栈的 5 层架构及每层职责
- **为什么**这样分层——每一层设计决策背后的技术理由
- 一次完整 WiFi 操作的跨层调用链
- 数据包从 App 到网卡的完整旅程
- 百万行级代码的阅读路线图

> **代码说明**：本文代码片段为便于阅读经过精简和注释化处理，非逐字复制。完整实现请参考文末源码仓库。

---

# 1 五层架构：为什么这样分？

Android WiFi 系统采用经典的分层架构，从上到下分为 5 层。Supplicant 和 HAL 虽然都是 native 层组件，但职责完全不同——Supplicant 是协议引擎（认证、密钥、漫游），HAL 是硬件抽象层（厂商适配），所以各自独立成层。

> 图中 HAL 位于 Supplicant 之上，是按**调用路径**排列（Framework 通过 AIDL 分别调用两者，它们是同层级的并行组件）。下方表格按**职责分组**排列（协议逻辑 → 硬件抽象），本文采用这种分组方式。

![Android WiFi 全栈分层：5 层蛋糕](assets/01_Android-WiFi-%E6%BA%90%E7%A0%81%E5%88%86%E6%9E%90%EF%BC%9A%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E2%80%94%E2%80%94%E4%BB%8E%E7%82%B9%E5%87%BB%E5%BC%80%E5%85%B3%E5%88%B0%E6%95%B0%E6%8D%AE%E5%8C%85/01-five-layer-stack.svg)

看图要点：HAL 与 Supplicant 同级并行——Framework 经 AIDL 分别调用两者，图中按调用路径而非层级高低排列；下方表格按职责分组（协议逻辑→硬件抽象），与左图顺序不同。

| 层级                | 语言        | 核心组件                        | 一句话职责                   | 代码量                |
| ------------------- | ----------- | ------------------------------- | ---------------------------- | --------------------- |
| **App / Framework** | Java/Kotlin | WifiServiceImpl, ClientModeImpl | 用户交互、状态管理、网络选择 | ~293K 行              |
| **Supplicant**      | C           | wpa_supplicant, hostapd         | 认证、密钥管理、漫游决策     | ~669K 行              |
| **HAL**             | C++/AIDL    | IWifi, WifiLegacyHal            | 硬件抽象、厂商适配           | ~140K 行              |
| **Driver**          | C           | qcacld-3.0 / gen4m              | 硬件控制、帧收发、中断处理   | QCOM ~323K / MTK ~87K |
| **Firmware**        | 闭源        | WMI/HIF 接口                    | 射频控制、帧过滤、功耗管理   | N/A                   |

> **代码量计算方式**：以 QCOM 平台为例，Framework ~293K + Supplicant ~669K + HAL ~140K + Driver ~323K ≈ 142 万行。加上 wpa_supplicant 工具/测试代码、以及 MTK 平台的独立驱动代码，总量超过 150 万行。

## 1.1 为什么这样分层？

这不是随意的设计，而是 Android 生态的必然选择：

| 设计决策            | 解决什么问题                                                 | 代价                                                         |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| App 与驱动解耦      | `WifiManager.startScan()` 不需要知道底层是 WMI 还是 HIF，100+ 芯片平台 App 零修改 | 多层调用链增加延迟                                           |
| Supplicant 独立进程 | WPA3-SAE、EAP-TLS 等复杂协议放在用户空间，可用 gdb 调试，崩溃不影响内核 | EAPOL 帧处理延迟（MTK 用 In-Driver Bridge 弥补：将 EAPOL 帧在内核态直接处理，避免用户空间往返，满足 50ms 重传 deadline） |
| HAL 接口标准化      | AIDL 定义 `IWifi`/`IWifiStaIface` 等标准接口，芯片厂商只实现接口即可，类似 USB 标准 | 版本兼容性维护成本                                           |
| Driver 统一回调     | 高通（PCIe/WMI）和联发科（AXI/HIF）硬件架构完全不同，但都实现相同的 `cfg80211_ops` | 厂商驱动内部复杂度高                                         |

> 就像医院的分诊系统——患者（App）不需要知道哪台 CT 机是高通还是联发科的，门诊部（Framework）会根据病情分配到合适的科室，主治医师（Supplicant）做诊断，医疗器械（Driver+Firmware）执行检查。分层让每一层都可以独立替换和升级。

---

# 2 每一层长什么样？

## 2.1 App 与 Framework：用户看到的一切

用户与 WiFi 的所有交互都在这一层——打开开关、选择热点、查看连接状态。

```java
// WifiManager.java — 用户的入口
// 注：API 29+ 已 @Deprecated，现代 Android 使用 WifiNetworkFactory
public boolean setWifiEnabled(boolean enabled) {
    return mService.setWifiEnabled(mContext.getOpPackageName(), enabled);
}
```

`WifiManager` 是一个轻量级代理，通过 AIDL Binder 调用 `system_server` 中的 `WifiServiceImpl`。这是 Android 系统服务的标准模式。

Framework 层的核心组件：

| 组件                      | 职责                                       |
| ------------------------- | ------------------------------------------ |
| `ActiveModeWarden`        | 模式总管，管理 STA/AP/P2P 模式的创建和销毁 |
| `ClientModeImpl`          | STA 核心状态机（连接/断开/漫游）           |
| `WifiConnectivityManager` | 扫描调度、网络选择、连接决策               |
| `WifiScanningServiceImpl` | 扫描服务（3 个状态机）                     |
| `WifiNative`              | AIDL/HIDL 桥接，调用 Supplicant/HAL        |

> **深入阅读**：ClientModeImpl 的 9 个状态（Disconnected → L2Connecting → L3Connected）和状态转移逻辑，详见 STA 连接专题（规划中）。

## 2.2 Supplicant：WiFi 的"大脑"

> Supplicant 就是前文比喻中的**主治医师**——决定用什么认证方式、怎么握手、密钥怎么生成。

`wpa_supplicant` 是一个独立的 C 进程，负责 WiFi 的核心"医疗决策"：

- **扫描**：决定扫哪些信道、用什么 SSID、主动还是被动
- **认证**：执行 WPA/WPA2/WPA3/SAE/EAP 等认证协议
- **密钥管理**：4-Way Handshake 生成 PTK/GTK，安装到驱动
- **漫游**：BSS 选择、FT 快速漫游、BTM 响应

入口函数链：

```c
// main() 顺序调用 init → add_iface → run — wpa_supplicant/main.c
main()
  → wpa_supplicant_init()       // 初始化全局结构、加载驱动配置
  → wpa_supplicant_add_iface() // 添加网络接口（wlan0）
  → wpa_supplicant_run()       // 注册信号处理、进入主循环
      → eloop_run()            // 在 wpa_supplicant_run() 内部调用（wpa_supplicant.c:8338，永不返回）
```

> **为什么是独立进程？** `wpa_supplicant` 处理的协议非常复杂（WPA3-SAE 的 Dragonfly 密钥交换、EAP-TLS 的证书验证），放在用户空间可以用 gdb 调试、崩溃后重启不影响内核。代价是 EAPOL 帧的处理延迟——这也是 MTK 做 In-Driver Bridge 的原因（内核态处理 EAPOL，满足 50ms 重传 deadline）。

Supplicant 通过 `wpa_driver_ops` 函数表与驱动通信——这是一个经典的 C 语言"多态"设计：

```c
// src/drivers/driver.h:3097 — 摘要，实际定义 100+ 个函数指针（视编译配置而定）
struct wpa_driver_ops {
    int (*scan2)(...);          // 触发扫描（802.11 MLME-SCAN）
    int (*associate)(...);      // 发起关联（802.11 MLME-ASSOCIATE）
    int (*deauthenticate)(...); // 断开认证（802.11 MLME-DEAUTHENTICATE）
    int (*set_key)(...);        // 设置加密密钥
    int (*get_scan_results)(...); // 获取扫描结果
    // ... 实际定义 100+ 个操作函数（视编译配置而定）
};
```

> **为什么用函数表？** 因为 `wpa_supplicant` 需要支持多种驱动后端（NL80211、wext、test），每种后端实现不同的 `wpa_driver_ops`。运行时根据配置选择具体实现，这就是 C 语言版的"接口抽象"。

## 2.3 HAL：Java 到内核的桥梁

> HAL 是**医疗器械标准**——不管底层芯片是 QCOM 还是 MTK，Framework 只调用标准的 `IWifi` 接口。

HAL（Hardware Abstraction Layer）是 Framework 和驱动之间的翻译层：

![AIDL HAL 接口层](assets/01_Android-WiFi-%E6%BA%90%E7%A0%81%E5%88%86%E6%9E%90%EF%BC%9A%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E2%80%94%E2%80%94%E4%BB%8E%E7%82%B9%E5%87%BB%E5%BC%80%E5%85%B3%E5%88%B0%E6%95%B0%E6%8D%AE%E5%8C%85/01-aidl-hal-tree.svg)

看图要点：AIDL 接口呈树状层级——`IWifi` 创建 `IWifiChip`、`IWifiChip` 再产出 `IWifiStaIface`，上层接口负责创建/查询下层；标准接口层之下是厂商私有实现，两者靠 `wifi_hal_fn` 函数表衔接。

| 接口            | 职责                           |
| --------------- | ------------------------------ |
| `IWifi`         | 启动/停止 WiFi 子系统          |
| `IWifiChip`     | 创建 STA/AP 接口、查询芯片能力 |
| `IWifiStaIface` | 扫描、连接、断开、密钥管理     |

Android 12+ 使用 AIDL 替代 HIDL。AIDL 框架支持 in-process 模式（虽然当前 WiFi HAL 仍是独立进程），为未来的性能优化留出空间；此外 AIDL 的编译时类型检查更强，减少了接口版本不匹配的问题。

HAL 有两层：标准接口 + 厂商实现。

**标准接口层**（AOSP 提供）：`wifi_legacy_hal.cpp` 定义了 `wifi_hal_fn` 函数表，包含 100+ 个标准操作（`scan`、`connect`、`set_key` 等）。这一层是"翻译官"，把 AIDL 调用转成 C 函数调用。

**厂商私有 HAL 层**（芯片厂商提供）：每个厂商实现 `init_wifi_vendor_hal_func_table(wifi_hal_fn *fn)` 函数，填充函数表。内部通过 **nl80211（Netlink）** + **ioctl**（`SIOCDEVPRIVATE+1` 发送 vendor 命令、`SIOCGIFFLAGS`/`SIOCGIFHWADDR` 管理接口属性）与内核驱动通信。

```text
AIDL HAL (标准接口)
  → wifi_legacy_hal.cpp (封装层, 调用 wifi_hal_fn)
    → 厂商私有 HAL (实现 wifi_hal_fn)
      → nl80211 Netlink → 内核驱动
```

**加载方式**：`wifi_legacy_hal_factory.cpp` 先尝试 `dlsym(RTLD_DEFAULT, "init_wifi_vendor_hal_func_table")` 找静态链接的符号；找不到则从 `/vendor/etc/wifi/vendor_hals/*.xml` 读取 `.so` 路径，通过 `dlopen` 动态加载。

```cpp
// wifi_legacy_hal_factory.cpp — 两种加载方式
// 方式 1: 静态链接（符号已在进程中）
initfn = (init_wifi_vendor_hal_func_table_t)dlsym(RTLD_DEFAULT, "init_wifi_vendor_hal_func_table");

// 方式 2: 动态加载 .so（path 来自 /vendor/etc/wifi/vendor_hals/*.xml 配置文件）
void* h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
initfn = (init_wifi_vendor_hal_func_table_t)dlsym(h, "init_wifi_vendor_hal_func_table");
```

**QCOM 和 MTK 的实现对比**：

| 维度       | QCOM                                    | MTK                                    |
| ---------- | --------------------------------------- | -------------------------------------- |
| 源码路径   | `hardware/qcom/wlan/qcwcn/wifi_hal/`    | `hardware/mediatek/wlan/wifi_hal/`     |
| 核心文件   | `wifi_hal.cpp` (~4450 行)               | `wifi_hal.cpp` (~3320 行)              |
| 与驱动通信 | nl80211 Netlink（通过 `cld80211_lib`）  | nl80211 Netlink（通过 `cpp_bindings`） |
| 特有功能   | gscan、RSSI 监控、NAN、firmware roaming | RTT、NAN、vendor command               |
| 编译方式   | 可静态链接或编译为 `.so`                | 可静态链接或编译为 `.so`               |

> **关键理解**：AIDL HAL 是"合同"（定义了接口），厂商私有 HAL 是"执行"（实现了接口）。两者都通过 nl80211 + ioctl 与内核驱动通信——nl80211 处理标准 WiFi 操作（扫描、连接），ioctl（`SIOCDEVPRIVATE+1`、WEXT `SIOCIWFIRSTPRIV+N`）处理厂商私有命令和接口管理。区别在于各自支持的 vendor 命令和扩展功能不同。Framework 层不知道也不关心底层是 QCOM 还是 MTK。

**wificond**：HAL 层还有一个容易被忽略的组件——`wificond`（WiFi C++ Daemon）。它是一个独立的 C++ 守护进程，位于 HAL 和内核 `nl80211` 之间，负责扫描调度和接口管理。Framework 通过 `WifiNl80211Manager` 与 wificond 通信（Binder IPC），wificond 再通过 nl80211 与内核 cfg80211 交互。与 vendor HAL 不同，wificond 是 AOSP 提供的标准组件，所有厂商共用。

> **深入阅读**：HAL 层的 HIDL → AIDL 演进、HalDeviceManager 接口管理、Nl80211Proxy 新路径，详见第二章《Framework 与 HAL》。

## 2.4 内核驱动：两大平台，两种哲学

前面三层（Framework、Supplicant、HAL）是 AOSP 统一的，所有厂商共享。从驱动开始，高通和联发科各走各路——**医疗设备**（驱动）内部构造完全不同，但都遵循 HAL 标准（同样的操作接口）。这是最复杂的一层。

| 维度       | QCOM                              | MTK                                     |
| ---------- | --------------------------------- | --------------------------------------- |
| 代码组织   | 4 个独立仓库，职责分离            | 3 个仓库，`gen4m` 高度内聚              |
| 固件通信   | WMI 协议（wmi_unified.h）         | HIF + MCR 寄存器                        |
| 平台驱动   | cnss2/icnss2（PCIe 枚举）         | conninfra（统一连接管理）               |
| 驱动规模   | ~323K 行                          | ~87K 行                                 |
| 核心状态机 | CM + CSR                          | AIS FSM + SAA FSM                       |
| 对象模型   | wlan_objmgr (psoc/pdev/vdev/peer) | 单一 Adapter                            |
| EAPOL 处理 | 驱动直接处理                      | In-Driver Bridge (`FourWayHandShake.c`) |

表中缩写全称：CSR = Common Scan and Roaming（通用扫描与漫游模块，QCOM）；AIS = Ad-hoc, Infra STA（MTK 的站点连接状态机）；SAA = 站点侧认证/关联状态机（Station Auth/Assoc，与 AP 侧的 AAA 对应）——CSR、AIS 取自源码注释（`csr_api.h`、`ais_fsm.c`），SAA 源码未展开全称，按 `aa_fsm.h` 中 SAA/AAA 的认证+关联状态划分按功能命名。

对象模型的选择直接决定上层看到什么：QCOM 把芯片拆成四级引用计数对象（psoc→pdev→vdev→peer，`wlan_objmgr_psoc_obj_create()` 创建于 `wlan_objmgr_psoc_obj.c`），每建一个接口就对应一个新 vdev，STA/AP/P2P 并发只是多个 vdev 并行，代价是生命周期管理复杂；MTK 只有一个 `ADAPTER`，连接状态全压进 `AIS_FSM_INFO`，由 `aisFsmInit()`（`ais_fsm.c`）初始化、`ENUM_AIS_STATE` 从 `AIS_STATE_IDLE` 到 `AIS_STATE_ROAMING` 串起扫描→关联→漫游——状态集中但接口并发扩展性弱于 QCOM。`cfg80211_ops.connect()` 的落点同样清晰：QCOM 侧调用 `wlan_hdd_cfg80211_connect()`（`core/hdd/src/wlan_hdd_cfg80211.c:23199`），把请求送进连接管理器（CM）状态机推进关联；MTK 侧经 `gl_cfg80211.c` 的 connect 回调下发 `wlanoidSetConnect`，转入 `aisFsmSteps()` 驱动的 AIS 状态迁移，再交给 SAA FSM 完成 Auth/Assoc 握手。

字段流转的落点同样明确——把连接请求压成一张表，两平台的分工一目了然：

| 字段流转     | QCOM                          | MTK                                           |
| ------------ | ----------------------------- | --------------------------------------------- |
| 连接请求入口 | `wlan_hdd_cfg80211_connect()` | `wlanoidSetConnect`                           |
| 落点对象     | vdev 对象，由 CM 状态机推进   | `ais->eCurrentState`（`AIS_STATE_IDLE` 起步） |
| 推进状态机   | CM                            | AIS FSM（`aisFsmSteps()`）                    |

> **深入阅读**：QCOM 的 wlan_objmgr 对象模型、CM 状态机、WMI 握手，以及 MTK 的 AIS FSM、conninfra 电源域管理，详见第三章《驱动加载与崩溃恢复》。

## 2.5 Firmware：你看不到的黑盒

> 固件是**设备内部的嵌入式控制系统**——你看不到源码，但设备靠它运转。

固件运行在 WiFi 芯片内部的独立处理器上，源码不公开。但驱动通过标准接口与它通信：

| 厂商     | 通信机制                         | 模型                                                    |
| -------- | -------------------------------- | ------------------------------------------------------- |
| **QCOM** | WMI（WLAN Management Interface） | 命令/事件异步模型：驱动发 `WMI_CMD`，固件回 `WMI_EVENT` |
| **MTK**  | HIF + MCR 寄存器                 | 命令/响应同步模型：驱动写寄存器，轮询固件应答           |

表中缩写全称：`WFDMA` = WiFi DMA（主机-固件间的 DMA 收发机制）、`MCR` = MTK 命令寄存器（主机写寄存器、固件轮询应答的窗口）——两者源码均未展开英文全称，按驱动注释的功能约定命名。

固件的职责：

- **射频控制**：信道切换、功率调整、天线选择
- **帧过滤**：硬件层过滤不需要的帧（如非本 BSSID 的 Beacon），减少 CPU 负担
- **功耗管理**：DTIM 省电、TWT（Target Wake Time）
- **硬件扫描**：PNO 扫描由固件独立执行，CPU 可以休眠
- **密钥安装**：PTK/GTK 安装到硬件加密引擎，数据帧在芯片内完成加密/解密
- **漫游辅助**：802.11k 邻居报告、802.11r FT 快速漫游的部分帧交换

驱动与固件的通信通过 WMI（WLAN Management Interface）协议：驱动发送 WMI 命令（如 `WMI_START_SCAN_CMDID`），固件执行后通过 WMI 事件（如 `WMI_SCAN_EVENTID`）上报结果。所有 WMI 消息都通过 HIF（Host Interface）传输层封装——QCOM 通过 PCIe 上的复制引擎（Copy Engine）传输，MTK 通过 MCR 寄存器（`WFDMA` 机制）传输。

固件崩溃（assert）时的恢复流程：驱动检测到固件无响应 → 触发 SSR（SubSystem Restart）→ 重新下载固件 → 重建连接。详见 STA 打开专题。

---

# 3 一次完整的操作：从点击到数据包

## 3.1 连接的跨层调用链

以 STA 连接到一个 WPA2 热点为例——一次完整的跨层流程：

![Android WiFi 跨层调用链：从点击连接到空中帧](assets/01_Android-WiFi-%E6%BA%90%E7%A0%81%E5%88%86%E6%9E%90%EF%BC%9A%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E2%80%94%E2%80%94%E4%BB%8E%E7%82%B9%E5%87%BB%E5%BC%80%E5%85%B3%E5%88%B0%E6%95%B0%E6%8D%AE%E5%8C%85/01-architecture-callchain.svg)

看图要点：自上而下是调用方向——注意 `WifiNative` 处并行分叉到 Supplicant 与 HAL 两条 AIDL 路径，以及 `cfg80211_ops.connect()` 处 QCOM/MTK 的平台驱动分叉（两平台符号不同、接口一致）；右侧栏用医院诊疗流程映射每一层。

```text
App 层: WifiManager.connect()
  → Framework 层: ClientModeImpl.connectToNetwork()  // 状态机调度
    → Supplicant 层: SupplicantStaIfaceHalAidlImpl.connectToNetwork()  // AIDL 跨进程桥接
      → wpa_supplicant 选择认证方式、触发关联
        → Driver 层: NL80211_CMD_CONNECT → cfg80211 → cfg80211_ops.connect() 回调 → 厂商驱动
          → 空中: Auth → Assoc → EAPOL 4-Way Handshake → DHCP
```

> **深入阅读**：连接流程的每一步（ClientModeImpl 状态机、3 种认证方式、NL80211 双路径、四次握手、DHCP），详见 STA 连接专题。

连接失败时，错误沿调用链反向传播——驱动通过 nl80211 上报断连事件（`NL80211_CMD_DISCONNECT`）→ `cfg80211` → `wpa_supplicant` 收到 `EVENT_DISASSOC` 事件 → 通过 AIDL 回调通知 Framework → `ClientModeImpl` 状态机回退到 Disconnected 状态。四种失败的回退层级不同：Auth 超时、Assoc 被拒、4-Way Handshake 失败都卡在 L2，直接触发 L2 断连、回退 `DisconnectedState`；DHCP 超时则卡在 L3——链路已通却拿不到 IP，从 `L3ConnectedState` 先重试 DHCP，仍失败再退回。具体到 `ClientModeImpl` 状态机：失败事件到达后，中间态（`L2ConnectingState`、`L3ConnectedState`）会逐级回退到 `DisconnectedState`，清空本次连接的临时状态；随后 `WifiConnectivityManager` 依据失败原因决定换网络重试还是放弃，最终结果经 `WifiManager` 回调上抛给 App。

四种失败的回退路径速查：

| 失败场景             | 失败层 | 回退路径                      |
| -------------------- | ------ | ----------------------------- |
| Auth 超时            | L2     | L2 断连 → `DisconnectedState` |
| Assoc 被拒           | L2     | L2 断连 → `DisconnectedState` |
| 4-Way Handshake 失败 | L2     | L2 断连 → `DisconnectedState` |
| DHCP 超时            | L3     | 先重试 DHCP → 仍失败再退回    |

## 3.2 数据包的旅程：从 App 到网卡

连接建立后，数据包的路径：

![数据包从 App 到网卡的旅程](assets/01_Android-WiFi-%E6%BA%90%E7%A0%81%E5%88%86%E6%9E%90%EF%BC%9A%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E2%80%94%E2%80%94%E4%BB%8E%E7%82%B9%E5%87%BB%E5%BC%80%E5%85%B3%E5%88%B0%E6%95%B0%E6%8D%AE%E5%8C%85/01-data-packet-journey.svg)

看图要点：发送与接收沿同一内核栈对称往返——发送自上而下（socket→`dev_queue_xmit`→DMA→芯片），接收自下而上（芯片→DMA→`netif_receive_skb`→socket）；`ndo_start_xmit()` 与 `netif_receive_skb()` 是两方向共用的驱动关卡。

**发送路径**：App 调用 `socket.send()` → TCP → `ip_output()` → Netfilter POST_ROUTING → `ip_finish_output2()` → `dev_queue_xmit()` → `ndo_start_xmit()` → 厂商 `hard_start_xmit()` → tx descriptor 入队 → DMA → 芯片 → 802.11 帧封装 → 射频发送。

其中 `ip_finish_output2()` 完成路由和邻居解析（ARP），`ndo_start_xmit()` 是内核调用驱动注册的回调。厂商驱动入口各不相同：QCOM 的 `hard_start_xmit` 实现是 `hdd_hard_start_xmit()`（`core/hdd/src/wlan_hdd_tx_rx.c`），MTK 的实现是 `nicTxEnqueueMsdu()`（声明于 `include/nic/nic_tx.h`，实现在预编译库，`mgmt/bss.c` 等处调用）。

**接收路径**：WiFi 芯片 → DMA → 驱动 RX 中断 → `netif_receive_skb()` → 内核协议栈反向解封装（`ip_rcv()` → Netfilter PRE_ROUTING → `ip_local_deliver()` → TCP → Socket → App）。

> **关键理解**：WiFi 驱动在内核中注册为一个网络设备（`net_device`），和有线网卡一样使用标准的 `ndo_start_xmit()` 接口。上层协议栈（TCP/IP/Netfilter）完全不知道下面是有线还是无线——这正是 Linux 网络子系统的分层设计。

**WiFi 特有的内核路径**：

- **cfg80211**：管理无线配置（扫描、连接、密钥），通过 `nl80211_ops`（`net/wireless/nl80211.c`）与用户空间通信，再通过 `cfg80211_ops` 回调分发给厂商驱动——例如 `cfg80211_ops.connect()` 最终调用 QCOM 的 `wlan_hdd_cfg80211_connect()`（`core/hdd/src/wlan_hdd_cfg80211.c`）
- **mac80211**：SoftMAC 设备的 802.11 帧管理，通过 `ieee80211_ops` 定义 MLME 操作。Android WiFi 驱动多为 FullMAC（固件自行处理 MLME），不经过 mac80211——这是 QCOM/MTK 驱动代码中看不到 mac80211 相关调用的原因
- **Netfilter**：防火墙规则，Android 的 `ConnectivityService` 通过 `nf_hook_ops` 注册 hook 点（PRE_ROUTING / POST_ROUTING），实现流量统计和防火墙功能

---

# 4 代码阅读路线图

面对百万行级代码，建议按以下顺序阅读：

## 4.1 第一阶段：建立全局观

1. 本文（架构总览）
2. 各仓库的 `README` / `Android.bp`

## 4.2 第二阶段：自顶向下

1. `WifiServiceImpl.java` - 理解 WiFi 服务入口
2. `ClientModeImpl.java` - 理解 STA 状态机
3. `WifiNative.java` - 理解 JNI 桥接
4. `SupplicantStaIfaceHalAidlImpl.java` - 理解 HAL 调用

## 4.3 第三阶段：深入 Supplicant

1. `wpa_supplicant/main.c` - 入口
2. `wpa_supplicant/wpa_supplicant.c` - 核心逻辑
3. `wpa_supplicant/scan.c` - 扫描调度
4. `wpa_supplicant/sme.c` - SAE/EAP 认证
5. `wpa_supplicant/ctrl_iface.c` - 控制接口

## 4.4 第四阶段：驱动层

**QCOM 路线**：

1. `wlan_hdd_main_module.c` - 模块入口
2. `wlan_hdd_main.c` - HDD 核心
3. `wlan_objmgr_psoc_obj.c` - 理解对象模型
4. `wlan_cm_sm.c` - CM 状态机
5. `qca-wifi-host-cmn/wmi/` - WMI 通信

**MTK 路线**：

1. `conninfra/connv2_drv.c` - conninfra 初始化入口（conninfra 仓库）
2. `wlan_drv_init.c` → `gl_init.c` - WLAN 模块入口（触发 `wlanProbe`）
3. `wlan_lib.c` - `wlanAdapterStart`
4. `ais_fsm.c` - AIS 状态机（最重要）
5. `saa_fsm.c` - SAA 状态机

---

# 6 总结

Android WiFi 的 5 层架构是 10 年演进的结果。就像患者不需要知道 CT 机是西门子还是 GE 的，App 也不需要知道底层是 QCOM 还是 MTK——这正是分层架构的价值。每一层的存在都有明确的技术理由：

- **Framework** 让 App 不关心硬件差异
- **Supplicant** 把复杂协议放在用户空间，方便调试和升级
- **HAL** 让芯片厂商只需实现标准接口
- **Driver** 把硬件差异封装在内核中
- **Firmware** 把实时性要求高的操作下沉到芯片

> 后续章节中，我们将深入底层——驱动是如何加载的？固件是如何下载的？从 `insmod wlan.ko` 到 WiFi 芯片就绪，中间经历了什么？

---

# 代码来源说明

本文分析的代码来自以下公开仓库，读者可自行下载查阅：

**AOSP**：

- [packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi/) - Android WiFi Mainline 模块
- [external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/) - WPA Supplicant
- [hardware/interfaces/wifi](https://android.googlesource.com/platform/hardware/interfaces/) - HAL 接口定义

**Qualcomm**：

- [vendor-qcom-opensource-wlan-qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0) - QCOM 主驱动
- [vendor-qcom-opensource-wlan-qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn) - 公共主机库
- [vendor-qcom-opensource-wlan-platform](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-platform) - 平台驱动（cnss2/icnss2）
- [hardware_qcom_wlan](https://git.codelinaro.org/clo/la/platform/hardware/qcom/wlan/) - QCOM WiFi HAL

**MediaTek**：

- [kernel_modules-connectivity-wlan-core-gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m) - MTK 主驱动
- [kernel_modules-connectivity-conninfra](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-conninfra) - 连接基础设施
- [hardware_mediatek/wlan](https://github.com/Evolution-X-Devices/hardware_mediatek/tree/bka/wlan) - MTK WiFi HAL

所有代码均为开源项目。本文中的代码分析基于 Android 16 (API 36) 版本。
