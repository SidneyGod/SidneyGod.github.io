---
title: 共存机制——WiFi与蓝牙
top: 1
related_posts: true
abbrlink: e58ee710
date: 2026-09-24 23:56:24
tags:
  - Android WiFi
  - BTC
categories:
  - WiFi
  - Code
---

> 手机同时连着 WiFi 和蓝牙耳机，你在打游戏、刷视频、听歌。两个无线电都挤在 2.4GHz 这条窄窄的信道里——WiFi 想发数据帧，蓝牙想传音频，谁先说话？这一章的答案，和本系列反复出现的那个结论惊人地一致：**真正管"谁先说话"的那个仲裁器，藏在固件里，主机连它的影子都摸不到**。但这一次有个不同——这一次，主机虽然插不上手，手上却攥着一大把旋钮：51 种配置类型，从 TDM 占空比到天线隔离度，全是主机定、固件执行的"策略"。

---

# 本章导读

共存（coex）是本系列的最后一个横切主题。全系列一直在讲一件事：一次 WiFi 操作，代码从 Framework 一路沉到 QCOM / MTK 的固件，每层各管什么。一路追下来，有一个结论越来越清晰——**管理面在主机、执行面在固件，根源是时间尺度**；追到速率自适应时，这个结论被推到更极端——RA 不只执行在固件，**决策都在固件**，主机只剩"菜谱、规矩、账本"三样。

<!--more-->

这一篇要验的，是"共存"（Coexistence，简称 coex）——确切说是 **WiFi 与蓝牙（BT）的跨协议共存**，业界叫 BTC（Bluetooth Coexistence）。它会给出一个比前两章更立体的答案：**主机既不是旁观者，也不是决策者，而是"搬运工 + 配置者"**——它把一堆策略参数原样搬进固件，再偶尔动一下天线、切一下链；真正决定"这一微秒 WiFi 发还是 BT 发"的逐包仲裁，在固件里，主机源码追不到。

先划清边界，避免一上来就走错门。源码里藏着三个都叫"coex"的东西，只有第一个是本文主角：

- **BTC（WLAN-BT）**：WiFi 和蓝牙共享 2.4GHz，这是本文讲的。
- **MWS（WLAN-LTE）**：WiFi 和蜂窝网络（LTE）的共存，主机侧只剩一个只读 debugfs 状态查询（`/sys/kernel/debug/wlan/mws_coex_state`），本文第 4 节顺手提一句，不展开。
- **OBSS 20/40 coex**：邻 BSS 之间的 20/40MHz 共存（`rlm.c` 里 `rlmProcessPublicAction2040Coexist` 那一类），那是 WiFi 和 WiFi 之间的事，跟蓝牙没有半毛钱关系，本文不碰。

还有个容易混的概念：第 10d 篇《SAP（四）当老板》里讲的 DBDC/MCC/SCC，是 **WiFi 内部共存**（多个 WiFi 接口/频段共享一颗 WiFi 芯片），本文讲的 BTC 是 **跨协议共存**（WiFi 和蓝牙抢同一段频谱）。两个"共存"不是一回事。

本文回答四个问题：

- 为什么 WiFi 和蓝牙会打架？PTA（逐包仲裁）这个机制到底是啥？
- 主机在共存里到底扮演什么角色？为什么说它是"搬运工 + 配置者"而不是决策者？
- QCOM 的 51 种配置类型、MTK 的一个 Set/Query 通道，具体是哪些代码？
- 为什么逐包仲裁必须在固件？主机能不能硬把它抢回来？

协议边界如实说明：共存机制是 **IEEE 802.15.2**（WLAN/WPAN 共存的推荐实践，分协作式 PTA/AFH 与非协作式），**不是 802.11 主规范的内容**。本文只对照了 802.11 系列与 Wi-Fi Alliance 规范，没有 802.15.2 原文，所以不写"§X.Y.Z"这种章节号，只讲机制本身。

先看一张全局图：共存这件事，主机能碰到什么、碰不到什么。颜色语义：橙 = 主机下发（策略/配置），绿 = 主机查询/动作（读状态、切链、切天线电源），虚线框 = 主机不可见的固件边界。注意最下面那层——两家平台的"逐包仲裁"都落在虚线框里，主机只在左右两端伸了手。

![共存三层分工全景图：主机配置下发（橙，直通无状态机）+ 主机查询动作（绿，切链/切天线电源），逐包 PTA 仲裁在固件（虚线框，主机不可见）](assets/20-%E5%85%B1%E5%AD%98%E6%9C%BA%E5%88%B6%E2%80%94%E2%80%94WiFi%E4%B8%8E%E8%93%9D%E7%89%99/20-architecture-callchain.svg)

理解"主机在哪一层插手"，接下来从最扎眼的问题开始——为什么 WiFi 和蓝牙会打起来，PTA 又是个什么鬼。

---

# 1 为什么 WiFi 和蓝牙会打架？

一句话：**两个无线电都住在 2.4GHz 这一条街，频谱直接重叠，而它们谁也听不见谁在说**。

2.4GHz 是 ISM 免费频段（约 2.400–2.483 GHz），WiFi 的 802.11b/g/n/ax 在这里划了 14 个 20MHz 宽的信道（每个信道 22MHz 宽，相邻信道互相压着），蓝牙（经典 BR/EDR + LE）在这段频谱里划了 79 个 1MHz 窄信道（2.402–2.480 GHz），并且以每秒 1600 次的频率在 79 个信道上跳（跳频 FHSS）。

问题就出在"重叠"上：WiFi 发数据帧时，一个 20MHz 宽的信道会同时盖住蓝牙正跳到的那个 1MHz 信道；反过来，蓝牙在跳频时也会一脚踩进 WiFi 正在收发的那 20MHz 里。更糟的是，**WiFi 和蓝牙的 MAC 层互不认识**——WiFi 的 CSMA/CA 听的是"WiFi 信道忙不忙"，它听不见蓝牙的信号；蓝牙的跳频也不在乎 WiFi 在不在。于是两个无线电各自为政，同频碰撞，结果就是：WiFi 丢包率飙升、吞吐腰斩，蓝牙耳机卡顿、音频断续。

解决这个"谁也听不见谁"的办法，业界有两类，这就是 IEEE 802.15.2 推荐实践的分类：

1. **非协作式（non-collaborative）**：一方单方面躲着另一方，不商量。典型是蓝牙的 **AFH（Adaptive Frequency Hopping，自适应跳频）**——蓝牙检测到某些 1MHz 信道被 WiFi 持续占用，就把这些信道从自己的跳频表里剔掉，只在"干净"的信道里跳。这样蓝牙躲开了 WiFi，代价是可用信道变少。
2. **协作式（collaborative）**：WiFi 和蓝牙之间拉一根线，**在发包之前互相知会一声**。这就是 **PTA（Packet Traffic Arbitration，逐包流量仲裁）**——本文的主角。

PTA 是本文的"灵魂机制"，先把它讲透。PTA 靠的是 WiFi 芯片和蓝牙芯片之间的几根硬件信号线（通常 2 根或 3 根），在**每个包发射之前**做一次握手：

- **2-wire**：一根 `BT_ACTIVE`（蓝牙要发/收了）、一根 `WLAN_ACTIVE`（WiFi 要发/收了），或者一根管"谁在活动"、一根管"优先级"。
- **3-wire**：在 2-wire 基础上加一根 `BT_PRIORITY`（蓝牙高优先级业务，比如 A2DP 音频、LE 连接事件），再加 `WLAN_DENY`/`GRANT` 之类的授权线。

握手逻辑大致是：WiFi 要发一帧，先看 `BT_ACTIVE` 拉没拉高——如果蓝牙正在传 A2DP 音频这类高优先级业务，WiFi 就得等这几十微秒；如果蓝牙只是低优先级扫描，WiFi 可以优先。反过来蓝牙同理。**这个"看一眼线、决定发不发"的动作，发生在微秒级，逐包进行**——这就是 PTA 逐包仲裁。

关键点先埋下：这个微秒级的逐包握手，主机软件根本来不及参与。原因在第 7 节展开，这里先记住结论——**PTA 逐包仲裁是硬件/固件的事，主机插不上手**。

那么主机在共存里到底干了什么？如果仲裁它碰不到，它那一大堆 coex 代码又在忙啥？下一节回答这个问题。

---

# 2 主机在共存里扮演什么角色？

主机在共存里的全部工作，可以概括成一句话：**主机是"搬运工 + 配置者"，不是"交警"**。

想象一个十字路口：WiFi 和蓝牙是两条车流，都要过 2.4GHz 这个路口。路口站着一个红绿灯控制器（PTA 固件/硬件），它每秒钟切换无数次，决定"这一辆车（这个包）过不过"。而主机（驱动）是几百米外的交通局——它**改得了红绿灯的配时方案**（哪个方向绿灯多久 = TDM 占空比），**看得了车流量报表**（状态查询），甚至偶尔能**调整一条车道的宽度**（切链、切天线），但它**永远不可能跑到路口去亲手挥旗**，因为等它的指令传到路口，车早就撞了。

把这个比喻落到源码里，主机侧的 coex 代码恰好分三层：

| 层                  | 主机干什么                                                   | 时间尺度                    | 主机代码在哪                                                 |
| ------------------- | ------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------ |
| 配置下发            | 把 TDM 占空比、优先级权重、天线模式、切换阈值等策略塞给固件  | 秒级（启动时 / 场景切换时） | `hdd_send_coex_config_params`（QCOM）、`CMD_ID_COEX_CTRL`（MTK） |
| 状态查询 + 少量动作 | 读固件汇报的共存模式 / BT 状态；切链（NSS 2→1）、切天线电源轨 | 百毫秒级                    | `wlan_hdd_btc_chain_mode_handler`（QCOM）、`wlanCoAntWiFi`（MTK） |
| 逐包仲裁            | **主机不参与**                                               | **微秒级**                  | 固件（`coex_tx_req` 等 fw-api 结构）                         |

这张表就是本文的全部骨架。看第三行——两家平台的"逐包仲裁"那一格都是空的，因为它在固件里。而前两行，正是主机"搬运工 + 配置者"的具体体现：

- **配置下发**是"搬运工"：主机把一堆参数从 INI（配置文件）读出来，打包成 WMI 命令，原样搬进固件。它不判断、不仲裁，只搬运。
- **状态查询 + 少量动作**是"配置者"：主机读固件回报的状态，偶尔做一点实质性动作（切链、切天线），但这些都是"策略级"的调整，不是"逐包级"的仲裁。

一个贯穿全篇的判断，先立在这里：

> **共存这件事，策略在主机，执行在固件。** 主机定"谁更重要"（优先级权重、占空比、切换阈值），固件执行"这一微秒谁发"。二者之间没有主机状态机——主机下发完配置就撒手，剩下的逐包决策全在固件闭环。

为什么主机不留一个状态机去管共存？因为共存决策的输入（BT 是否正在传 A2DP、BLE 连接事件何时到）是**逐包、微秒级**的，主机经 WMI 命令往返一次要百微秒级，等主机反应过来，这包早发完、那个 BLE 事件早错过了。所以主机只能"定策略"，不能"管执行"。

接下来三节，分别看 QCOM 怎么下发（第 3 节）、QCOM 怎么动手（第 4 节）、MTK 怎么下发和动手（第 5 节），最后回来看固件里的仲裁长什么样（第 6 节）。

---

# 3 QCOM 主机怎么把 51 种策略塞给固件？

QCOM 主机的配置下发，核心是一条命令：`WMI_COEX_CONFIG_CMD`。它没有任何主机侧状态机，就是"一个 config_type + 六个 config_arg，原样发给固件"。config_type 是一个枚举，从 1 排到 51——**51 种配置类型**，这就是主机手里那一大把旋钮的全貌。

先看这个枚举（摘录，值 1~51，全部在 `fw-api/fw/wmi_unified.h`）：

> 枚举注释里"arg1 BT / arg2 WLAN"那类字样，就是主机递给固件的"配时方案"本身。

```c
// fw-api/fw/wmi_unified.h:37056  共 51 个 config_type（值 1~51），摘录
typedef enum wmi_coex_config_type {
    WMI_COEX_CONFIG_PAGE_P2P_TDM        =  1, /* TDM 间隔 (arg1 BT, arg2 WLAN) P2P+PAGE */
    // ...省略 2~11（各种 TDM 占空比、BTC enable、debug、TX power 等）...
    WMI_COEX_CONFIG_TX_POWER            = 12, /* BT 共存时 WLAN 总 TX 功率 (arg1, 0.5 dBm) */
    WMI_COEX_CONFIG_PTA_CONFIG          = 13, /* 使能 PTA + GPIO (arg1 pta_enable, arg2 GPIO) */
    WMI_COEX_CONFIG_AP_TDM              = 14, /* AP 场景 TDM (arg1 占空比, arg2 WLAN 时长 ms) */
    WMI_COEX_CONFIG_WLAN_SCAN_PRIORITY  = 15, /* off-channel 扫描时 WLAN 优先级 */
    WMI_COEX_CONFIG_WLAN_PKT_PRIORITY   = 16, /* BE/BK/VO/VI/Beacon/管理帧 的 WLAN 优先级 */
    WMI_COEX_CONFIG_PTA_INTERFACE       = 17, /* PTA 接口：arg2 模式(2-wire/3-wire/PTA),
                                                 arg3 首槽时间(us), arg4 BT priority 时间(us),
                                                 arg5 算法(WMI_COEX_ALGO_TYPE), arg6 PTA 优先级 */
    // ...省略 18（BTC 占空比）...
    WMI_COEX_CONFIG_HANDOVER_RSSI       = 19, /* WLAN RSSI(dBm) 阈值：Hybrid→TDD 切换 */
    // ...省略 20~23（BT info、sink TDM、MCC TDM、低 RSSI TDM）...
    WMI_COEX_CONFIG_BTC_MODE            = 24, /* BTC 模式，arg1: 0 TDD / 1 FDD / 2 Hybrid */
    WMI_COEX_CONFIG_ANTENNA_ISOLATION   = 25, /* BT 与 WLAN 链路的隔离度 (dB) */
    // ...省略 26~28（BT 低 RSSI 阈值、干扰电平、WLAN over ZB）...
    WMI_COEX_CONFIG_WLAN_MGMT_OVER_BT_A2DP = 29, /* SAP+BT 场景：WLAN 优先级抬到 BT 之上 */
    WMI_COEX_CONFIG_WLAN_CONN_OVER_LE      = 30, /* WLAN 关联期间抬高 WiFi 优先级压 BLE */
    WMI_COEX_CONFIG_LE_OVER_WLAN_TRAFFIC   = 31, /* BLE 流量抬高到 WiFi 之上 */
    WMI_COEX_CONFIG_THREE_WAY_COEX_RESET   = 32, /* 三无线(ZigBee)权重复位 */
    // ...省略 33~43（三无线 delay 参数、MPTA helper、BT 二次谐波 WAR 等）...
    WMI_COEX_CONFIG_BTCOEX_SEPARATE_CHAIN_MODE = 44, /* BTC 独立链 / 共享链模式 */
    WMI_COEX_CONFIG_ENABLE_TPUT_SHAPING = 45, /* BT 扫描时 WLAN 吞吐 shaping */
    WMI_COEX_CONFIG_ENABLE_TXBF         = 46, /* 共存场景使能 WLAN TX beamforming */
    WMI_COEX_CONFIG_FORCED_ALGO         = 47, /* 强制选定共存算法 (arg1) */
    WMI_COEX_CONFIG_LE_SCAN_POLICY      = 48, /* BLE 扫描策略提示：0 偏 BLE 结果 / 1 偏 WLAN 性能 */
    WMI_COEX_CONFIG_BT_RX_PER_THRESHOLD = 49, /* BT RX PER 阈值 */
    WMI_COEX_SET_TRAFFIC_SHAPING_MODE   = 50, /* 关闭/开启全部共存策略 */
    WMI_COEX_CONFIG_ENABLE_CONT_INFO    = 51, /* 使能 contention info log */
} WMI_COEX_CONFIG_TYPE;
```

扫完这 51 个旋钮先记住：注释里的 arg1/arg2，就是主机递给固件的配时参数本身。

- **51 个旋钮，全是"策略"不是"执行"**：从 TDM 占空比（arg1 BT / arg2 WLAN，单位 ms）、PTA 接口配置（2-wire/3-wire、首槽时间、BT priority 时间）、BTC 模式（TDD/FDD/Hybrid）、天线隔离度、到各种"谁压谁"的优先级权重（`WLAN_MGMT_OVER_BT_A2DP`、`LE_OVER_WLAN_TRAFFIC`）。每一项都是"主机定规则，固件照规则跑"。
- **`PTA_INTERFACE`（17）是硬件握手的配置**：arg2 选 2-wire 还是 3-wire，arg3/arg4 定首槽时间和 BT priority 时间（微秒级），arg5 选算法，arg6 定优先级——注意，主机配的是"握手协议的参数"，不是"握手的动作"。
- **`BTC_MODE`（24）的三个值对应三种共存拓扑**：TDD（时分，共享链）、FDD（频分，独立链）、Hybrid（混合，低负载时分 + 高负载频分）。这是理解第 4 节"切链"的钥匙。

这些旋钮的值从哪来？从 INI 配置文件来。QCOM 的 coex INI 集中在 `components/fw_offload/dispatcher/inc/cfg_coex.h`：

```c
// components/fw_offload/dispatcher/inc/cfg_coex.h:42 / :61  （摘录）
#define CFG_BTC_MODE CFG_INI_UINT( \
			"gSetBTCMode",      /* 0 TDD / 1 FDD / 2 Hybrid */ \
			0, 2, 0, CFG_VALUE_OR_DEFAULT, "BTC mode")

#define CFG_ANTENNA_ISOLATION CFG_INI_UINT( \
			"gSetAntennaIsolation",  /* 默认 25 dB */ \
			0, 255, 25, CFG_VALUE_OR_DEFAULT, "Antenna Isolation")
```

- **`gSetBTCMode`**：默认 0（TDD），范围 0~2，对应上面枚举的 `WMI_COEX_CONFIG_BTC_MODE`。
- **`gSetAntennaIsolation`**：默认 25，单位 dB，对应 `WMI_COEX_CONFIG_ANTENNA_ISOLATION`——这个值是"BT 和 WLAN 两条链路之间天线隔离了多少 dB"，隔离度越高，两路信号串扰越小，固件据此决定能不能让 BT 和 WLAN 同时发（FDD 的前提）。

现在看这些 INI 值是怎么被"搬"进固件的。启动时，HDD 层把 INI 聚合进一个结构体，然后逐项发 WMI 命令：

```c
// core/hdd/src/wlan_hdd_main.c:7385  （摘录）
static int hdd_send_coex_config_params(struct hdd_context *hdd_ctx,
				       struct hdd_adapter *adapter)
{
	struct coex_config_params coex_cfg_params = {0};
	struct wlan_fwol_coex_config config = {0};
	// ...省略 psoc / adapter 校验...

	status = ucfg_fwol_get_coex_config_params(psoc, &config);  // 读 INI 聚合出的配置
	// ...省略错误处理...

	coex_cfg_params.config_type = WMI_COEX_CONFIG_TX_POWER;
	coex_cfg_params.config_arg1 = config.max_tx_power_for_btc;
	status = sme_send_coex_config_cmd(&coex_cfg_params);

	coex_cfg_params.config_type = WMI_COEX_CONFIG_HANDOVER_RSSI;
	coex_cfg_params.config_arg1 = config.wlan_low_rssi_threshold;
	status = sme_send_coex_config_cmd(&coex_cfg_params);

	coex_cfg_params.config_type = WMI_COEX_CONFIG_BTC_MODE;
	// ...省略 chain mode 覆盖 btc_mode 的逻辑...
	status = sme_send_coex_config_cmd(&coex_cfg_params);

	coex_cfg_params.config_type = WMI_COEX_CONFIG_ANTENNA_ISOLATION;
	coex_cfg_params.config_arg1 = config.antenna_isolation;
	status = sme_send_coex_config_cmd(&coex_cfg_params);
	// ...省略 BT_LOW_RSSI_THRESHOLD / BT_INTERFERENCE_LEVEL / SCO / LE_SCAN_POLICY...
	return 0;
}
```

- **`ucfg_fwol_get_coex_config_params` 是"读 INI"这一步**：它把 `cfg_coex.h` 里那堆 `CFG_*` 宏的值读出来，填进 `struct wlan_fwol_coex_config`（字段 `btc_mode`、`antenna_isolation`、`max_tx_power_for_btc`、`wlan_low_rssi_threshold` 等，定义在 `wlan_fw_offload_main.h:88`）。
- **后面就是"搬运"**：同一个 `coex_cfg_params` 反复复用，只改 `config_type` 和 `config_arg1`，一条条发给固件。注意这里没有任何状态机、没有任何仲裁逻辑——纯粹是"把 INI 里的策略逐条翻译成 WMI 命令"。
- **`HANDOVER_RSSI` 值得单独看**：它的 `config_arg1` 是 `wlan_low_rssi_threshold`（INI `gSetWlanLowRssiThreshold`，默认 -80 dBm）。这就是"Hybrid 模式在 WLAN 信号弱到多少时切回 TDD"的切换阈值——**一个典型的"策略"**：主机定"什么时候切换"，固件执行"切换"。

再看这条命令最终怎么"搬运"到底。整条链是四层直通，每一层都只是转发：

```c
// core/sme/src/common/sme_api.c:12861
QDF_STATUS sme_send_coex_config_cmd(struct coex_config_params *coex_cfg_params)
{
	void *wma_handle = cds_get_context(QDF_MODULE_ID_WMA);
	if (!wma_handle)
		return QDF_STATUS_E_FAILURE;
	return wma_send_coex_config_cmd(wma_handle, coex_cfg_params);
}

// core/wma/src/wma_features.c:4980  （摘录）
QDF_STATUS wma_send_coex_config_cmd(WMA_HANDLE wma_handle,
				    struct coex_config_params *coex_cfg_params)
{
	// ...省略 wma_validate_handle / NULL 校验...
	return wmi_unified_send_coex_config_cmd(wma->wmi_handle, coex_cfg_params);
}

// qca-wifi-host-cmn/wmi/src/wmi_unified_tlv.c:9915  （摘录，最终组装 WMI 命令）
static QDF_STATUS send_coex_config_cmd_tlv(wmi_unified_t wmi_handle,
					   struct coex_config_params *param)
{
	WMI_COEX_CONFIG_CMD_fixed_param *cmd;
	// ...省略 buf 分配、TLV header 设置...
	cmd->vdev_id = param->vdev_id;
	cmd->config_type = param->config_type;
	cmd->config_arg1 = param->config_arg1;
	// ...省略 config_arg2 ~ config_arg6...
	wmi_mtrace(WMI_COEX_CONFIG_CMDID, cmd->vdev_id, 0);
	return wmi_unified_cmd_send(wmi_handle, buf, len, WMI_COEX_CONFIG_CMDID);
}
```

- **四层直通，层层是"搬运"**：`sme_send_coex_config_cmd` → `wma_send_coex_config_cmd` → `wmi_unified_send_coex_config_cmd` → `send_coex_config_cmd_tlv`。每一层都只做"拿句柄 → 校验 → 转交"，没有一层掺进业务判断。这就是"直通，无主机状态机"的字面证据。
- **`struct coex_config_params` 和 `WMI_COEX_CONFIG_CMD_fixed_param` 字段一一对应**：`vdev_id + config_type + config_arg1..6`（前者定义在 `qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:9220`，后者在 `fw-api/fw/wmi_unified.h:37231`）。主机侧的参数结构体，就是固件侧命令结构体的镜像——主机连字段名都不用动脑，照着填就行。
- **最终以 `WMI_COEX_CONFIG_CMDID` 这个命令 ID 发出去**，剩下的事（解析 config_type、应用到逐包仲裁），全在固件。

这条"四层直通"里，同一份信息（比如"BTC 模式是 TDD 还是 FDD"）被登记了四次，每层换一个字段名。把"BTC 模式"这个例子拉出来做一张跨层映射表，最能看清"搬运工"是怎么搬运的：

| 层        | 登记它的符号                                                 | 值（以 BTC 模式为例）    | 文件                                                 |
| --------- | ------------------------------------------------------------ | ------------------------ | ---------------------------------------------------- |
| INI 配置  | `gSetBTCMode`                                                | 0 TDD / 1 FDD / 2 Hybrid | `cfg_coex.h:42`                                      |
| fwol 聚合 | `struct wlan_fwol_coex_config.btc_mode`                      | 同上                     | `wlan_fw_offload_main.h:88`                          |
| 主机参数  | `coex_config_params.config_type = WMI_COEX_CONFIG_BTC_MODE`、`config_arg1` | 24、0/1/2                | `qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:9220` |
| 固件命令  | `WMI_COEX_CONFIG_CMD_fixed_param.config_type` / `config_arg1` | 24、0/1/2                | `wmi_unified.h:37231`                                |

- **四层字段一一对应，值从头到尾不加工**：`gSetBTCMode` 的值 0/1/2，一路搬到 `config_arg1` 里，中间没有任何一层去"解释"它是什么意思——因为解释（TDD 该切哪些时隙、FDD 该用哪条链）是固件的事，主机只负责"装上货、运过去"。
- **`config_type = 24` 是"运单号"**：主机告诉固件"这一箱装的是 BTC 模式"，固件按运单号拆箱。主机连"箱子里的东西干嘛用"都不用懂，这正是"直通、无主机状态机"的直观体现。

到这里，QCOM 的"配置下发"已经讲完。但主机真的一点"动作"都没有吗？不是——第 4 节看它唯一能实质动手的地方。

---

# 4 QCOM 主机唯一能「动手」的地方是什么？

QCOM 主机在共存里唯一算得上"动作"的，是 **BTC chain mode 切换**——当 BTC 模式切成 FDD 或 Hybrid（BT 和 WLAN 各用各的天线链）时，2.4GHz 的空间流数要从 2 降到 1，并且要断开重连让它生效。

这个"动作"的入口是一条 vendor 命令 `QCA_NL80211_VENDOR_SUBCMD_BTC_CHAIN_MODE`，落点在 `wlan_hdd_btc_chain_mode.c`：

```c
// core/hdd/src/wlan_hdd_btc_chain_mode.c:32  （摘录）
static QDF_STATUS wlan_hdd_btc_chain_mode_handler(struct wlan_objmgr_vdev *vdev)
{
	// ...省略 vdev / adapter / mac_handle 获取...

	nss = ((mode == WLAN_COEX_BTC_CHAIN_MODE_FDD ||
		mode == WLAN_COEX_BTC_CHAIN_MODE_HYBRID) ? 1 : 2);

	band = NSS_CHAINS_BAND_2GHZ;
	sme_update_nss_in_mlme_cfg(mac_handle, nss, nss,
				   adapter->device_mode, band);
	sme_update_vdev_type_nss(mac_handle, nss, band);
	sme_update_he_cap_nss(mac_handle, adapter->vdev_id, nss);

	freq = hdd_get_adapter_home_channel(adapter);
	if (!WLAN_REG_IS_24GHZ_CH_FREQ(freq))
		return QDF_STATUS_SUCCESS;   // 不在 2.4G，切回来时再生效

	switch (adapter->device_mode) {
	case QDF_STA_MODE:
	case QDF_P2P_CLIENT_MODE:
		wlan_hdd_cm_issue_disconnect(adapter,
					     REASON_PREV_AUTH_NOT_VALID, false);
		break;
	case QDF_SAP_MODE:
	case QDF_P2P_GO_MODE:
		hdd_restart_sap(adapter);
		break;
	}
	return QDF_STATUS_SUCCESS;
}
```

- **NSS 2→1 是这里最关键的"动作"**：`mode` 是 FDD 或 Hybrid（`WLAN_COEX_BTC_CHAIN_MODE_FDD`/`HYBRID`，枚举在 `wlan_coex_ucfg_api.h:39`，另有 `SHARED=0`）时，`nss` 算成 1，否则是 2。为什么？因为 FDD/Hybrid 意味着 BT 和 WLAN **各占一条天线链**，2.4GHz 只剩一条链可用，空间流自然从 2 降到 1。
- **改完 NSS 必须"重连"才生效**：STA/P2P Client 走 `wlan_hdd_cm_issue_disconnect`（断开重连），SAP/P2P GO 走 `hdd_restart_sap`（重启热点）。因为 NSS 是能力协商（HE Cap 里的 MCS/NSS 集合）的一部分，改能力就得重新关联。
- **"不在 2.4G 就跳过"这个判断很关键**：如果当前连的是 5GHz，2.4G 的 NSS 改动可以"记账"不重连，等切回 2.4G 才生效。这再次印证了 BTC 是"BT 与 **2.4G** 的共存"——5G 根本不需要和 BT 抢。

但注意，这个"切链"动作，依然是**策略级**的：主机只是根据"现在 FDD 还是 Hybrid"去改 NSS 并触发重连，它没有参与任何逐包决策。而且这个动作的**触发前提**——BTC 模式到底是不是 FDD/Hybrid——本身也是主机通过第 3 节那条 `WMI_COEX_CONFIG_BTC_MODE` 命令**下发**的。主机"动手"的每一处，都绕不开"先下发、再执行"的模式。

回到那个十字路口的比喻——主机在这里能做的，是**把其中一条车道从双车道改成单车道**（NSS 2→1），但它依然不能跑到路口去指挥"这一秒哪辆车先过"。改车道宽度，和挥旗放行，是两种量级完全不同的"动作"，主机只拿到了前者。

最后补一句 MWS（WLAN-LTE 共存）。它是三个"coex"里主机参与度最低的：QCOM 只在 debugfs 里暴露了一个**只读**节点 `/sys/kernel/debug/wlan/mws_coex_state`（`wlan_hdd_debugfs_coex.c`），读回来的是 `struct mws_coex_state`、`mws_coex_dpwb_state`、`mws_coex_tdm_state` 等一组 LTE 共存状态结构，查询超时 `WLAN_WAIT_TIME_MWS_COEX_INFO` 800ms。**只有查询，没有配置、没有动作**——跟 BTC 的"51 种配置 + 切链"形成鲜明对比。这也是为什么本文只把它当背景：MWS 在主机侧就一个状态查询，真正的仲裁同样在固件。

QCOM 的配置下发和切链讲完了。第 5 节换到 MTK，看它的配置下发、状态汇报、以及一个 QCOM 没有的"动作"——天线电源控制。

---

# 5 MTK 怎么下发、怎么听汇报、怎么切天线？

MTK 的 coex 架构和 QCOM 有一个关键的"形似神不似"：MTK 没有 51 种 config_type 的枚举，它把共存控制收敛到**一条命令** `CMD_ID_COEX_CTRL = 0x7C`，注释里写着 `(Set/Query)`——既是 Set 通道又是 Query 通道，靠子命令区分：

```c
// include/wsys_cmd_handler_fw.h:319  （摘录）
CMD_ID_GET_CNM = 0x79,
CMD_ID_COEX_CTRL = 0x7C, /* 0x7C (Set/Query) */

// include/nic_cmd_event.h:1599 / :1626  （摘录）
struct COEX_CMD_HANDLER {                 // 子命令包装：一个 u4SubCmd + 一段 buffer
	uint32_t u4SubCmd;
	uint8_t aucBuffer[COEX_CTRL_BUF_LEN];
};
enum ENUM_COEX_CMD_CTRL {
	COEX_CMD_SET_RX_DATA_INFO = 0x00,   /* Set */
	COEX_CMD_GET_ISO_DETECT = 0x80,     /* Get */
	COEX_CMD_GET_INFO = 0x81,           /* Get */
	COEX_CMD_NUM
};
```

- **一条命令 ID，三种子命令**：`COEX_CMD_SET_RX_DATA_INFO`（下发，0x00）、`COEX_CMD_GET_ISO_DETECT`（查隔离度，0x80）、`COEX_CMD_GET_INFO`（查共存信息，0x81）。`struct COEX_CMD_HANDLER` 是外层包装，`u4SubCmd` 选子命令，`aucBuffer` 装具体数据（比如查隔离度时填 `struct COEX_CMD_ISO_DETECT`：`u4IsoPath/u4Channel/u4Isolation`）。
- **Set 和 Query 共用一条命令**，跟 QCOM 的"Set 一条命令 + 状态从事件回来"不同，MTK 是"同一个 `CMD_ID_COEX_CTRL` 既能写又能读"。这更接近一个"邮箱"式的寄存器通道。

共存模式在 MTK 主机侧也是一个枚举 `ENUM_COEX_MODE`，且它和 QCOM 的三个 BTC 模式一一对应：

```c
// include/nic_cmd_event.h:3594
enum ENUM_COEX_MODE {
	COEX_NONE_BT,   /* 无 BT 共存 */
	COEX_TDD_MODE,  /* 时分（对应 QCOM 的 TDD） */
	COEX_HBD_MODE,  /* Hybrid（对应 QCOM 的 Hybrid） */
	COEX_FDD_MODE,  /* 频分（对应 QCOM 的 FDD） */
};

// include/nic_cmd_event.h:3601  固件主动上报的共存状态
struct EVENT_COEX_STATUS {
	uint8_t ucVersion;       /* default v1.0 = 0x01 */
	uint8_t ucCoexMode;      /* 0:non-bt 1:TDD 2:Hybrid 3:FDD */
	uint8_t ucBtOnOff;
	uint8_t ucBtRssi;
	uint16_t u2BtProfile;
	uint8_t fgIsBAND2G4Coex;
	// ...省略 fgIs5GsupportEPA 等...
};
```

- **`ENUM_COEX_MODE` 是"模式"的枚举，`EVENT_COEX_STATUS` 是"状态"的结构**：前者是主机下发/记录用的模式定义，后者是固件主动上报的当前共存状态（`ucCoexMode`、`ucBtOnOff`、`ucBtRssi`、`u2BtProfile` 等）。注意 `ucCoexMode` 的注释直接写着 `0:non-bt 1:TDD 2:Hybrid 3:FDD`，和 `ENUM_COEX_MODE` 的顺序一致。
- **上报走两个事件**：`EVENT_ID_UPDATE_COEX_STATUS = 0x91`（共存模式 / BT 状态变化）和 `EVENT_ID_UPDATE_COEX_PHYRATE = 0x90`（共存触发的 PHY 速率上限变化），都在 `wsys_cmd_handler_fw.h:578`。固件在共存状态变了、或速率被共存限制时，主动"喊"主机。

这里埋一个本系列反复出现的"追不到"点，先记下来：`struct EVENT_COEX_STATUS` 这个结构体在头文件里定义得清清楚楚，但**谁去解析 `EVENT_ID_UPDATE_COEX_STATUS` 事件、把 `ucCoexMode` 写进 BSS 的 `eCoexMode` 字段**，这个处理函数在开放源码里找不到——整个 Gen4M 树的 `.c` 文件里，`eCoexMode` 只被赋值过 `COEX_NONE_BT`（`ais_fsm.c:5629`），从没被赋值过 `COEX_TDD_MODE`/`COEX_HBD_MODE`/`COEX_FDD_MODE`。这个赋值动作在闭源的 `nic_cmd_event.c` 里（后文第 6 节展开）。

主机拿到共存状态后干嘛？一个用途是 CNM（连接与模式管理）根据"共存"这个 reason 去调整 opmode：

```c
// mgmt/cnm.c:4645  （摘录）  事件 reason → CNM opmode 请求
enum ENUM_CNM_OPMODE_REQ_T cnmOpModeMapEvtReason(enum ENUM_EVENT_OPMODE_CHANGE_REASON eEvt)
{
	switch (eEvt) {
	case EVENT_OPMODE_CHANGE_REASON_COANT:
		eReqIdx = CNM_OPMODE_REQ_COANT;       // = 8
		break;
	// ...省略 DBDC / SMARTGEAR 等 reason...
	case EVENT_OPMODE_CHANGE_REASON_COEX:
		eReqIdx = CNM_OPMODE_REQ_COEX;         // = 3
		break;
	// ...省略其余...
	}
	return eReqIdx;
}
```

- **"共存"是 CNM 的众多 opmode 变更 reason 之一**：`EVENT_OPMODE_CHANGE_REASON_COEX = 4` 映射到 `CNM_OPMODE_REQ_COEX = 3`（枚举在 `cnm.h:171`）。CNM 是 MTK 的"连接与模式管理器"，负责根据各种 reason（DBDC、CoAnt、共存、天线控制……）算出当前该跑什么 opmode（几条链、什么带宽）。共存状态变了 → 触发一次 opmode 重算。
- 这跟 QCOM 的"切链"是同一件事的两种说法：QCOM 直接改 NSS 并重连，MTK 把"共存变了"作为一个 reason 交给 CNM 统一重算 opmode。**殊途同归，都是策略级的调整**。

最后是 MTK 独有的"动作"——CoAnt 共享天线电源控制。某些 MTK 平台（如 soc3_0/soc5_0）上，WiFi 和蜂窝（MD，Modem）共享一根外置天线，主机要能把这根天线的供电切换到 WiFi 或 MD。这是 QCOM 那套"纯配置直通"里没有的：

```c
// chips/soc3_0/soc3_0.c:2631 / :2641  （摘录）
void wlanCoAntWiFi(void)      // 把共享天线切给 WiFi
{
	uint32_t u4GPIO10 = 0x0;
	wf_ioremap_read(0x100053a0, &u4GPIO10);
	u4GPIO10 |= 0x20000;               // 置 WiFi 位
	wf_ioremap_write(0x100053a0, u4GPIO10);
}

void wlanCoAntMD(void)        // 把共享天线切给 MD（蜂窝）
{
	uint32_t u4GPIO10 = 0x0;
	wf_ioremap_read(0x100053a0, &u4GPIO10);
	u4GPIO10 |= 0x10000;               // 置 MD 位
	wf_ioremap_write(0x100053a0, u4GPIO10);
}
```

- **这是主机真正"动手"的硬件级动作**：`wlanCoAntWiFi`/`wlanCoAntMD` 直接读写 GPIO 寄存器 `0x100053a0`，置 `0x20000`（WiFi）或 `0x10000`（MD）位，切的是**共享天线的供电轨**。配套的 `wlanCoAntVFE28En`（`soc3_0.c:2583`）还通过 PMIC 的 `KERNEL_pmic_ldo_vfe28_lp` 去使能天线的 VFE28 供电轨。三个函数注册在一个 `.coantSetWiFi/.coantSetMD/.coantVFE28En` 的操作表里（`soc3_0.c:1177`）。
- **但即便如此，这也不是逐包仲裁**：CoAnt 切的是"共享天线的电源给谁"，是场景级的切换（WiFi 用还是蜂窝用），不是"这一微秒 WiFi 发还是 BT 发"。它改变不了"仲裁在固件"的大局——它只是 MTK 比 QCOM 多出来的一个"主机动作"。

小结一下双平台差异：QCOM 是"纯配置直通 + 切链动作"，MTK 是"一个 Set/Query 通道 + CNM opmode 重算 + CoAnt 天线电源动作"。**两家主机能做的都停留在"策略"和"场景级动作"这一层，谁也没碰到逐包仲裁**。那逐包仲裁到底长什么样？第 6 节把镜头推进固件边界。

---

# 6 固件里的 PTA 逐包握手长什么样？

主机源码追到边界，固件里的逐包仲裁是"主机看不见的黑盒"。但 QCOM 的 `fw-api` 目录里留了一扇窗户——它把固件和硬件之间、以及固件内部 PTA 模块之间交换的消息结构，以头文件的形式发布了出来。这些结构虽然是给固件用的，但它们的字段名完整暴露了 PTA 握手的全貌。

先看"WiFi 要发一帧，先向 PTA 申请授权"的请求结构 `coex_tx_req`。下面这张时序图先帮你建立直觉：WiFi 每发一帧，都要和 BT 在硬件信号线上走一遍"申请 → 授权/拒绝 → 发 → 回执"的微秒级握手，全程主机不在场（蓝色 = WiFi 侧，绿色 = BT 侧，虚线框 = 主机不可见的固件/硬件边界）：

![PTA 逐包握手时序图：WiFi 每帧发射前经 BT_ACTIVE/BT_PRIORITY 信号线做微秒级仲裁，申请→授权→发射→回执全程在固件硬件闭环，主机不下场](assets/20-%E5%85%B1%E5%AD%98%E6%9C%BA%E5%88%B6%E2%80%94%E2%80%94WiFi%E4%B8%8E%E8%93%9D%E7%89%99/20-pta-handshake.svg)

现在看请求结构 `coex_tx_req`：

```c
// fw-api/hw/qca5424/coex_tx_req.h  （摘录，固件侧 PTA 授权请求）
struct coex_tx_req {
	uint32_t tx_pwr:8, min_tx_pwr:8, nss:3, tx_chain_mask:8, bw:3, reserved_0:2;
	uint32_t alt_tx_pwr:8, alt_min_tx_pwr:8, alt_nss:3, alt_tx_chain_mask:8, alt_bw:3, reserved_1:2;
	uint32_t tx_pwr_1:8, alt_tx_pwr_1:8, wlan_request_duration:16;  /* 这次 TX 要占用多久 */
	uint32_t wlan_pkt_type:4, coex_tx_reason:2, response_frame_type:5,
		 wlan_low_priority_slicing_allowed:1,      /* 低优先级可切片 */
		 wlan_high_priority_slicing_allowed:1,     /* 高优先级可切片 */
		 sch_tx_burst_ongoing:1,                   /* TX burst 进行中 */
		 coex_tx_priority:4,                       /* 本次 TX 的仲裁优先级 */
		 reserved_3a:14;
};
```

- **`wlan_request_duration`（16 bit）是握手的第一要素**：WiFi 申请"我要占信道 N 个时间单位"。PTA 据此和 BT 的占用需求比对，决定让不让。
- **`coex_tx_priority`（4 bit）是握手的第二要素**：本次 TX 的优先级。配合固件侧"谁压谁"的权重表（第 3 节主机下发的那些 `WLAN_MGMT_OVER_BT_A2DP` 之类），决定 BT 高优先级业务（A2DP）能不能打断这次 WiFi TX。
- **`tx_chain_mask` / `alt_tx_chain_mask` 透露了"切链"的另一半**：主机在第 4 节把 NSS 2→1，固件这里就带上了"用哪条链发"的掩码，以及一套 `alt_*`（备选方案）——BT 占用共享链时，WiFi 退而用备选链/备选功率/备选带宽发。
- **两个 `slicing_allowed` 字段点出了 PTA 的"切片"技巧**：如果 BT 的高优先级业务只占一小段时间，WiFi 可以把一个长帧"切"成几段，在 BT 的空隙里插缝发——这就是 "high/low priority slicing"。这些"能不能切、怎么切"的决策，都在固件的微秒级循环里。

回到第 3 节 `WMI_COEX_CONFIG_PTA_INTERFACE` 的 arg5：主机挑的算法类型枚举 `WMI_COEX_ALGO_TYPE`（`fw-api/fw/wmi_unified.h:37050`）只有三值——`WMI_COEX_ALGO_UNCONS_FREERUN`（0，无约束自由运行）、`WMI_COEX_ALGO_FREERUN`（1，自由运行）、`WMI_COEX_ALGO_OCS`（2，离信道调度）。主机只能勾选"跑哪种算法"，三种算法各自怎么排时隙、怎么插缝切片，实现仍在闭源固件里。

再看"WiFi 正在收，PTA 要知道还剩多少时间"的 `coex_rx_status`：

```c
// fw-api/hw/qca5424/coex_rx_status.h  （摘录，固件侧 RX 状态上报）
struct coex_rx_status {
	uint32_t rx_mac_frame_status:2, rx_with_tx_response:1,
		 rx_rate:5, rx_bw:3, single_mpdu:1, filter_status:1,
		 ampdu:1, directed:1, reserved_0:1,
		 rx_nss:3, rx_rssi:8, rx_type:3,
		 retry_bit_setting:1, more_data_bit_setting:1;
	uint32_t remain_rx_packet_time:16,   /* 这个包还剩多久收完 */
		 rx_remaining_fes_time:16;       /* RX 剩余时间（FES 单位） */
};
```

- **`remain_rx_packet_time` / `rx_remaining_fes_time` 是"还剩多久"**：RX 也一样要做仲裁——如果 BT 此刻也要收，PTA 得知道 WiFi 这个接收还要持续多久，才能决定 BT 是等还是插。这就是为什么"逐包"不仅是 TX 的事，RX 也要参与握手。
- **`rx_rssi` / `rx_rate` / `rx_nss`**：把当前 RX 的信号质量和速率也报给 PTA，供它做"降功率/让位"这类更细的决策。

最后是"WiFi 发完了，PTA 回执"的 `coex_tx_status`：

```c
// fw-api/hw/qca5424/coex_tx_status.h  （摘录，固件侧 TX 状态回执）
struct coex_tx_status {
	uint32_t reserved_0a:7, tx_bw:3, tx_status_reason:3, tx_wait_ack:1,
		 fes_tx_is_gen_frame:1, sch_tx_burst_ongoing:1, current_tx_duration:16;
	uint32_t next_rx_active_time:16, remaining_fes_time:16;
	uint32_t tx_antenna_mask:8,   /* 实际用的天线掩码 */
		 shared_ant_tx_pwr:8,     /* 共享天线上的 TX 功率 */
		 other_ant_tx_pwr:8,      /* 其它天线上的 TX 功率 */
		 reserved_2:8;
};
```

- **`tx_antenna_mask` / `shared_ant_tx_pwr` 是"结果"**：回执里带上了"实际用哪根天线发、共享天线上发了多大功率"。这呼应了第 4 节的"切链"——固件按 host 下发的 chain mode 和 PTA 的实时仲裁结果，决定这一帧实际走哪条链、多大功率。
- **`next_rx_active_time` 是"预告"**：发完这一帧，紧接着的 RX 还要占多久。PTA 的握手是双向、连续的：TX 和 RX 交替申请，谁都不独占。

这三个结构拼起来，就是固件里 PTA 逐包握手的完整闭环：**申请（`coex_tx_req`）→ 收尾/预告（`coex_rx_status`）→ 回执（`coex_tx_status`）**。但注意——**这三个结构是"数据结构"，不是"算法"**。`fw-api` 只发布消息格式，PTA 到底怎么根据 `coex_tx_priority` 和 BT 的 `BT_PRIORITY` 线算出"谁先发"、TDD 时隙怎么切、slicing 怎么插缝，这些**决策循环的实现，主机源码里没有**，它在闭源固件里。

MTK 侧的"追不到"更彻底。MTK 的 WiFi 固件和 BT 固件跑在同一个 connsys/conninfra MCU 上，TDD/FDD/HBD 调度和 PTA 优先级仲裁都在那个 MCU 的固件里。主机侧能看到的只有：

- `nic_cmd_event.h` 里 `nicCmdEventQueryNicCoexFeature` 这个**函数声明**（`:4360`），负责查固件支持哪些共存特性；
- 前面说的 `EVENT_COEX_STATUS` / `EVENT_ID_UPDATE_COEX_STATUS` 这些**事件结构**；
- 但对应的**实现文件 `nic_cmd_event.c` 根本没随源码发布**（Gen4M 树里 `find` 不到这个文件），共存核心事件的解析和调度逻辑是闭源预编译的。

这就是第 5 节埋的那个"追不到"的完整答案：**主机能读到 `eCoexMode` 这个字段（`gl_kal.c:10799` 用它判断是不是 TDD 模式来调 CPU 升频阈值），能收到 `EVENT_COEX_STATUS` 事件，但"谁把事件的 `ucCoexMode` 写进 `eCoexMode`"这段代码，主机源码里没有**。字段的读写两端，主机只摸得到读的那端。

一句话收束本节：**固件里的 PTA 逐包握手，主机只能通过 fw-api 的消息结构窥见其"形状"，摸不到其"算法"；MTK 甚至连"形状"都只给了头文件声明，实现整个闭源**。那这个"必须藏在固件"的必然性，到底在哪？第 7 节回答。

---

# 7 为什么逐包仲裁必须在固件？

这是全篇的灵魂问题。答案在第 1 节已经埋下，现在把它摊开。

**PTA 逐包仲裁的反馈回路，是微秒级的。** BT 的高优先级事件——A2DP 音频要发一个 eSCO 槽（一个槽 625µs，语音要连续占几槽）、BLE 连接事件要准时收发——这些事件"要来"的提前量只有微秒到几十微秒。WiFi 要发的每一帧，从"想发"到"发出"之间，也要在微秒级完成"看 BT 线 → 决定发不发 → 发"。整个握手是**硬件信号线 + 固件微秒循环**完成的。

**而主机经 WMI 命令往返一次，是百微秒级。** 第 3 节那条 `WMI_COEX_CONFIG_CMD`，从主机到固件再回，中间要过 PCIe、要进固件队列、要等固件处理完回 ACK——这一来一回，BT 的微秒级仲裁窗口（看线 → 决定 → 发的全过程）早就闭合了几十上百轮。让主机来做逐包仲裁，等于让一个只能收"几秒前的汇总报告"的经理，去现场指挥"微秒级的逐帧收发"——**信息维度和时间尺度双双不对等**。

这跟前几个主题是同一个根，但更极端。RA 的 MCS 升降级在固件（逐帧决策），这一篇的 PTA 仲裁比它更"硬"——因为它甚至不经过 WMI，是**硬件信号线之间的直接握手**。`coex_tx_req` 里那个 `coex_tx_priority` 和 `wlan_request_duration`，是在 WiFi MAC 和 BT MAC 之间的物理线路上、以微秒为周期互相招呼的，主机连"旁听"都听不全。

**反过来，为什么主机还留了"配置下发"这层？** 因为共存里有一半是"策略"，而策略天然是主机该定的。TDM 占空比（arg1 BT / arg2 WLAN 的 ms）、优先级权重（A2DP 压不压 WiFi 管理帧）、天线模式（TDD/FDD/Hybrid）、切换阈值（`HANDOVER_RSSI`）——这些是"谁更重要、何时切换"的**规则**，它们的来源是产品定义、运营商需求、用户体验权衡，属于主机的职权。所以主机和固件的分工，本质是**策略/执行分离**：

> **策略（占空比、优先级、阈值、模式）在主机，因为它是"产品决策"；执行（逐包看线、切时隙、插缝切片）在固件，因为它是"微秒动作"。** 主机定"规则"，固件跑"规则"，两者之间没有中间地带。

最后看双平台的微小差异，以及它为什么改变不了大局。QCOM 是"纯配置直通"——51 种 config_type 一条条下发，主机侧没有状态机；MTK 多了一个"动作"——CoAnt 天线电源控制（`wlanCoAntWiFi`/`wlanCoAntMD` 切 GPIO）。但这个差异只说明**两家对"共享天线"这个物理资源的处理粒度不同**（MTK 的 WiFi 和蜂窝要共享一根外置天线，所以主机必须能切电源轨；QCOM 的 BT 和 WLAN 共享链是固件内部协调，不需要主机切电源），**没有一家因此把逐包仲裁搬到主机**。共享的是"天线给谁"，逐包的还是"这一微秒谁发"——后者两家都留在固件。

所以全篇最核心的设计洞察，落成一句话：

> **PTA 逐包仲裁是微秒级硬件握手，主机软件插不上手，只能下发策略。** 主机是"搬运工 + 配置者"，不是"交警"。

---

# 总结

这一篇追的是"WiFi 和蓝牙抢 2.4GHz，谁来做仲裁"，答案是全系列最一致的那个——**仲裁在固件，主机只能定策略**。全篇主线一条：**共存这件事，策略在主机，执行在固件，二者之间没有主机状态机**。

- **QCOM**：主机是"纯配置直通"。`WMI_COEX_CONFIG_TYPE` 枚举 51 种 config_type（`fw-api/fw/wmi_unified.h:37056`），从 TDM 占空比、PTA 接口（2-wire/3-wire）、BTC 模式（TDD/FDD/Hybrid）、天线隔离度、到各种"谁压谁"的优先级权重，全是策略。下发链四层直通：`hdd_send_coex_config_params`（读 INI `gSetBTCMode`/`gSetAntennaIsolation`）→ `sme_send_coex_config_cmd` → `wma_send_coex_config_cmd` → `send_coex_config_cmd_tlv`（组 `WMI_COEX_CONFIG_CMD_fixed_param`）→ 固件。主机唯一"动作"是切链：`wlan_hdd_btc_chain_mode_handler` 把 FDD/Hybrid 时的 2.4G NSS 2→1 并触发重连。
- **MTK**：主机侧一个 Set/Query 通道 `CMD_ID_COEX_CTRL = 0x7C`（子命令 `COEX_CMD_SET_RX_DATA_INFO`/`GET_ISO_DETECT`/`GET_INFO`），共存模式枚举 `ENUM_COEX_MODE`（NONE_BT/TDD/HBD/FDD）。固件主动上报 `EVENT_ID_UPDATE_COEX_STATUS`（0x91）/`EVENT_ID_UPDATE_COEX_PHYRATE`（0x90），主机收到后经 `cnmOpModeMapEvtReason` 把 `EVENT_OPMODE_CHANGE_REASON_COEX` 映射成 `CNM_OPMODE_REQ_COEX` 触发 opmode 重算。比 QCOM 多一个"动作"：CoAnt 共享天线电源控制（`wlanCoAntWiFi`/`wlanCoAntMD` 写 GPIO `0x100053a0`）。
- **固件**：PTA 逐包握手，主机只能通过 fw-api 的消息结构窥见形状——`coex_tx_req`（申请：`wlan_request_duration`/`coex_tx_priority`/`tx_chain_mask`/slicing）、`coex_rx_status`（RX 剩余时间）、`coex_tx_status`（回执：`tx_antenna_mask`/`shared_ant_tx_pwr`）。MTK 更彻底：`nicCmdEventQueryNicCoexFeature` 只有声明，实现文件 `nic_cmd_event.c` 未随源码发布。
- **为什么必须固件**：PTA 是微秒级硬件握手（BT eSCO 槽 625µs、逐帧"看线发不发"），主机 WMI 往返百微秒级，插不上手。主机留"配置下发"是因为占空比、优先级、阈值、模式是"产品决策"（策略），而逐包看线、切时隙、切片是"微秒动作"（执行）。**策略/执行分离**。

贯穿全篇的三个"coex"要分清：**BTC**（WLAN-BT，本文主角）、**MWS**（WLAN-LTE，只有只读 debugfs 状态查询）、**OBSS 20/40 coex**（邻 BSS 共存，与 BT 无关）。第 10d 篇的 DBDC/MCC/SCC 是 WiFi 内部共存，和本文的跨协议共存不是一回事。

**本章干货速查**：

| 主题          | 核心机制                                | 关键代码锚点                                                 |
| ------------- | --------------------------------------- | ------------------------------------------------------------ |
| 51 种配置     | 一个 config_type + 6 个 config_arg 直通 | `WMI_COEX_CONFIG_TYPE`（wmi_unified.h:37056）、`WMI_COEX_CONFIG_CMD_fixed_param`（:37231） |
| QCOM 下发链   | 四层直通，无状态机                      | `hdd_send_coex_config_params`（wlan_hdd_main.c:7385）→ `sme_send_coex_config_cmd`（sme_api.c:12861）→ `wma_send_coex_config_cmd`（wma_features.c:4980）→ `send_coex_config_cmd_tlv`（wmi_unified_tlv.c:9915） |
| QCOM INI      | 策略的源头                              | `CFG_BTC_MODE`/`CFG_ANTENNA_ISOLATION`（cfg_coex.h:42/61）、`struct wlan_fwol_coex_config`（wlan_fw_offload_main.h:88） |
| QCOM 切链动作 | FDD/Hybrid 时 NSS 2→1 + 重连            | `wlan_hdd_btc_chain_mode_handler`（wlan_hdd_btc_chain_mode.c:32）、`enum coex_btc_chain_mode`（wlan_coex_ucfg_api.h:39） |
| QCOM MWS      | 只读 debugfs 状态查询                   | `/sys/kernel/debug/wlan/mws_coex_state`、`WLAN_WAIT_TIME_MWS_COEX_INFO` 800ms（wlan_hdd_debugfs_coex.c） |
| MTK 通道      | 一条 Set/Query 命令 + 子命令            | `CMD_ID_COEX_CTRL=0x7C`（wsys_cmd_handler_fw.h:319）、`struct COEX_CMD_HANDLER`/`ENUM_COEX_CMD_CTRL`（nic_cmd_event.h:1599/1626） |
| MTK 模式/状态 | 模式枚举 + 固件上报事件                 | `ENUM_COEX_MODE`（nic_cmd_event.h:3594）、`EVENT_COEX_STATUS`（:3601）、`EVENT_ID_UPDATE_COEX_STATUS=0x91`/`PHYRATE=0x90`（wsys_cmd_handler_fw.h:578） |
| MTK opmode    | 共存 reason 触发 opmode 重算            | `cnmOpModeMapEvtReason`（cnm.c:4645）、`CNM_OPMODE_REQ_COEX=3`（cnm.h:171） |
| MTK CoAnt     | 共享天线电源轨切换                      | `wlanCoAntWiFi`/`wlanCoAntMD`（soc3_0.c:2631/2641，GPIO `0x100053a0`）、`wlanCoAntVFE28En`（:2583） |
| 固件 PTA 握手 | 申请→收尾→回执三结构                    | `coex_tx_req`/`coex_rx_status`/`coex_tx_status`（fw-api/hw/qca5424/） |

**关键常量速查**（这些值都是驱动/固件私有定义，非 802.11 规范内容，故"规范章节"列记为 —）：

| 常量                                        | 值                                  | 定义位置                                             |
| ------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `WMI_COEX_CONFIG_TYPE` 枚举                 | 1 ~ 51（51 种）                     | `fw-api/fw/wmi_unified.h:37056`                      |
| `WMI_COEX_CONFIG_BTC_MODE`                  | 24（0 TDD/1 FDD/2 Hybrid）          | 同上（枚举成员）                                     |
| `WMI_COEX_CONFIG_PTA_INTERFACE`             | 17（2-wire/3-wire/首槽时间/优先级） | 同上（枚举成员）                                     |
| `CMD_ID_COEX_CTRL`                          | 0x7C（Set/Query）                   | `wsys_cmd_handler_fw.h:319`                          |
| `EVENT_ID_UPDATE_COEX_PHYRATE`              | 0x90（Unsolicited）                 | `wsys_cmd_handler_fw.h:578`                          |
| `EVENT_ID_UPDATE_COEX_STATUS`               | 0x91                                | `wsys_cmd_handler_fw.h:579`                          |
| `EVENT_OPMODE_CHANGE_REASON_COEX` / `COANT` | 4 / 1                               | `wsys_cmd_handler_fw.h:2299` / `:2296`               |
| `CNM_OPMODE_REQ_COEX`                       | 3                                   | `mgmt/cnm.h:171`                                     |
| `COEX_MULTI_CONFIG_MAX_CNT`                 | 32（批量配置上限）                  | `qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:9251` |
| `WLAN_WAIT_TIME_MWS_COEX_INFO`              | 800ms（MWS 查询超时）               | `wlan_hdd_debugfs_coex.c:47`                         |
| `gSetAntennaIsolation` 默认值               | 25 dB                               | `cfg_coex.h:61`                                      |

**协议依据**：共存机制是 IEEE 802.15.2（WLAN/WPAN 共存的推荐实践，协作式 PTA/AFH + 非协作式），**不是 802.11 主规范内容**。PTA（Packet Traffic Arbitration，逐包流量仲裁）是协作式的硬件握手；AFH（Adaptive Frequency Hopping，自适应跳频）是蓝牙单方面的非协作式规避。本文只对照 802.11 系列与 Wi-Fi Alliance 规范（无 802.15.2 原文），只讲机制不断言章节号。

---

# 结语：贯穿全系列的那条线

这是本系列最后一个横切主题。把它和速率自适应这类主题并排看，会发现一条贯穿整个系列的线，一条比任何单篇都更底层的分工原则：

> **触达硬件、且时间尺度在微秒级的决策，全部沉进固件；主机负责"定策略、传命令、看报表"。**

RA 的 MCS 升降级（逐帧决策）、PTA 的逐包仲裁（微秒级硬件握手）——两件事，两个主题，同一个落点：**主机源码里都只有一个"旋钮面板"（参数/命令/结构），真正的决策循环都藏在固件里**。这不是 QCOM 或 MTK 偷懒，是 full-mac 架构的必然：决策者在哪，由"谁在物理层发信号"决定。WiFi 芯片把物理层和一部分 MAC 都吞进了固件，主机就只能当那个"几百米外的交通局"——改得了红绿灯配时，看得了车流报表，唯独不能站到路口去挥旗。

系列写到这里，从全景架构一路追到共存仲裁，一张完整的地图已经铺开：从点击开关，到扫描、连接、漫游、断连，到 SAP、P2P、DPP、TDLS、NAN、RTT、WFD、MLO、速率自适应，最后到共存——每一篇都在同一个坐标系里回答同一个问题：**这段代码落在哪一层，这一层能不能碰到它。** 而"能不能碰到"，几乎总是由一件事决定——**时间尺度**。微秒级的，归固件；百微秒级往上的，才轮到主机。

**源码出处**：QCOM [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0)、[qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn)、[fw-api](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-fw-api)；MTK [kernel_modules-connectivity-wlan-core-gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)。
