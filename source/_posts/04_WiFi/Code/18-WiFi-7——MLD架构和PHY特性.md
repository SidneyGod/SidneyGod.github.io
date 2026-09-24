---
title: WiFi 7——MLD架构和PHY特性
top: 1
related_posts: true
abbrlink: 1d318194
date: 2026-09-24 23:49:16
tags:
  - Android WiFi
  - MLD
categories:
  - WiFi
  - Code
---

> 你的手机同时连着 2.4G、5G、6G 三条链路。突然 6GHz 链路干扰变大、丢包率飙升，手机要在不中断视频通话的前提下，把这条链路的流量无损搬到 5GHz——这件事，谁来做？数据面的答案是「固件」；但链路本身被搬来搬去、增了又删，谁在管理？本文把答案从数据面翻到管理面——答案是：主机驱动在管，固件在跑。

---

# 本章导读

WiFi 源码分析系列走到最后，我们一直沿着一条主线：一次 WiFi 操作，从 Android Framework 一路下沉到 QCOM / MTK 的固件，代码在每一层各自扮演什么角色。MLO 数据面的核心问题——一个帧走哪条链路——答案是「决策权在固件」。但那条主线只覆盖了「帧发出去之后」的世界。

<!--more-->

本文补上另一半：**MLD 架构的管理面**。链路不是凭空存在的——它要被建立（ML IE 解析、多链路关联）、被切换（link switch）、被重配（link reconfiguration，AP 增删链路）、被管理（peer 跨链路同步），最后还要协商操作模式（MLSR / eMLSR / STR）。这些「链路本身的生老病死」发生在主机驱动里，QCOM 和 MTK 各有一套独立模块，是主机侧代码最厚的一层。

穿插在这条管理面主线里的，是 WiFi 7 的另一组新特性——320 MHz、4K QAM（4096-QAM）、preamble puncturing、Multi-RU。它们的代码可见性与管理面正好相反：主机只做「能力位的宣告与协商」，真正的调制解调、打孔决策、组合调度全在固件或硬件里。这条「能力位协商 vs 固件实现」的边界，是理解 WiFi 7 主机侧为何「看起来代码很多、实际干的活很薄」的关键。

读完本文，你能回答三个问题：

- 为什么 MLO 的链路管理（link switch / reconfig / T2LM）留在主机驱动，而数据面调度丢给固件？这条分界线是怎么划出来的？
- 320 MHz 和 4K QAM 在主机代码里到底长什么样？为什么主机只负责「宣告支持」而不碰「实现」？
- preamble puncturing 和 Multi-RU 的代码边界在哪里？为什么打孔决策和组合调度是主机「看都看不到」的？

**PS**：本文不展开数据面 MLO TX 的链路选择（见《数据帧发送进阶：MLO TX》）；MLO 连接的建立入口（`mlo_connect()`、多链路 Auth/Assoc、密钥共享）已在《连接（五）安全协议与 MLO》详述；WiFi 6E/7 的扫描发现机制（PSC、RNR）见扫描篇（下）。本文聚焦连接建立之后的**链路生命周期管理**，以及 PHY 特性的**能力位协商边界**。320 MHz 射频、4096-QAM 调制解调、puncturing 打孔决策、Multi-RU 组合调度——这些主机不可见的部分，本文只标边界、不硬写实现。

---

# 1 为什么链路管理在主机、数据面在固件？

在进入任何一行代码之前，先回答那个决定全文走向的设计追问：MLD 的「管理」和「执行」为什么分家？

回想一下 MLO 的一分钟定义（前文已展开，这里只取结论）：MLO 让一个设备（MLD，Multi-Link Device）同时关联 2.4G / 5G / 6G 三条链路，三条链路共享同一个 MLD 地址，对上层表现成一个逻辑接口。数据面要回答「这个帧走哪条链路」，管理面要回答「这三条链路怎么建立、怎么切换、怎么拆掉、怎么和 AP 保持一致」。

管理面留在主机、数据面交给固件，根源在**时间尺度的差异**。

数据面的链路选择要在微秒级完成——固件每个帧出发前查 T2LM 表、读 PHY 信道的实时 SNR / CCA，host 经 WMI / UniCmd 命令通道的往返延迟在百微秒到毫秒级，来不及（这一层算过账：固件决策 288 μs，host 决策 788 μs）。管理面的链路切换（link switch / reconfig）发生在**毫秒到秒级**——一条链路从被判定「质量恶化」到完成切换，中间隔的是扫描、认证、关联这一整套流程，几百毫秒打底，host 的调度延迟在这个尺度下完全可接受。

更重要的是，管理面的逻辑本质是 **MAC 层的状态机**——「当前链路是什么状态、下一步该往哪个状态走、收到哪个事件触发哪个转换」。状态机是纯粹的软件逻辑，主机 CPU 跑起来毫无压力；而数据面的逐包调度需要访问 PHY 寄存器、DMA 描述符、硬件队列，这些资源只有固件摸得到。所以分工不是谁拍脑袋定的，而是「逻辑放主机、触达硬件的执行放固件」的自然结果。

用机场的比喻收束这一节：**管理面是运控中心（塔台），数据面是跑道上的地勤**。运控中心决定「这条航线今天飞不飞、航班改不改登机口、要不要加开一班」——这些是分钟级的决策，需要全局视野（关联了哪几家、会员有多少、机场吞吐多少），但不碰飞机。跑道地勤决定「这架飞机停哪个机位、行李从哪条传送带上机」——这些是秒级甚至更快的执行，必须站在跑道上。塔台不该去抢传送带的操作杆，地勤也不该去决定航线规划。MLD 架构的分工，就是这条线的映射。

> 本章导读之后、正文第 1 节之前，先看一张全局图：MLD 管理面的软件分层、调用链方向和跨模块边界。左侧 QCOM 是「三层循环」——target_if 收固件事件 → umac mlo_mgr 跑状态机 → connection_mgr 发起连接，连完又回到 mlo_mgr 建 peer；右侧 MTK 是「AIS FSM 渗透」——MLO 能力打散进 AIS/SAA FSM，mlo.c 提供解析和下发，UniCmd 直达固件。

![MLD 管理面全局图](assets/18-WiFi-7%E2%80%94%E2%80%94MLD%E6%9E%B6%E6%9E%84%E5%92%8CPHY%E7%89%B9%E6%80%A7/18-mld-mgmt-plane-overview.svg)

理解了「为什么分家」，接下来逐层看管理面的每一件事是怎么落进代码的。先从最基础的开始——三条链路怎么被「捆」成一个 MLD。

---

# 2 ML IE 是怎么把三条链路捆成一个 MLD 的？

MLD 管理的起点，是**多链路信息（ML 信息）的解析**。AP 在 Beacon / Probe Response / Assoc 帧里带一个 Multi-Link element（ML IE，`IEEE 802.11be-2024 §9.4.2.322`），把「我这个 AP MLD 还有哪些伙伴链路、各自在哪个信道、MAC 地址是什么」一并发给 STA。STA 解析完，才知道「哦，这个 2.4GHz 的 AP 背后还有一个 5GHz 和一个 6GHz 的兄弟」。

MTK 把这个解析封装在 `mgmt/mlo.c`（4868 行）里。核心数据结构是 `struct MULTI_LINK_INFO`：

```c
// MTK gen4m: include/mgmt/mlo.h:227 — struct MULTI_LINK_INFO, 解析 ML IE 的载体
struct MULTI_LINK_INFO {
	uint8_t ucValid;
	uint8_t	ucMlCtrlType;        // ML 控制字段的变体类型（Basic/Probe/Reconfig）
	uint8_t	ucMlCtrlPreBmp;      // ML 控制字段的 presence bitmap
	uint8_t ucCommonInfoLength;
	uint8_t aucMldAddr[MAC_ADDR_LEN];   // MLD 地址（三条链路共用的"总部地址"）
	uint8_t ucLinkId;
	uint8_t ucBssParaChangeCount;
	uint16_t u2MediumSynDelayInfo;
	uint16_t u2EmlCap;                 // EML Capabilities（eMLSR/EMLMR 能力）
	uint16_t u2MldCap;                 // MLD Capabilities
	uint8_t ucMldId;
	uint16_t u2ExtMldCap;
	uint16_t u2ValidLinks;             // 有效链路位图（哪些 link_id 存在）
	uint8_t ucProfNum;
	struct STA_PROFILE rStaProfiles[MLD_LINK_MAX];  // 每条伙伴链路的 profile
};
```

- `aucMldAddr` 是 MLD 地址——三条链路的「总部地址」，数据面和管理面都用它识别同一个 MLD，对应规范 §35.3.2 MLD addressing。
- `u2ValidLinks` 是有效链路位图——bit N 置位表示 link N 存在，这是管理面判断「MLD 有几条链路」的原始依据。
- `rStaProfiles[MLD_LINK_MAX]` 是每条伙伴链路的 Per-STA Profile（`struct STA_PROFILE`），里面有该链路的链路地址 `aucLinkAddr`、信道信息 `rChnlInfo`、能力字段。`MLD_LINK_MAX` 由 `CFG_MLD_LINK_MAX` 定义，通常 3（2.4G + 5G + 6G）。

解析入口 `mldParseBasicMlIE`（`mlo.c:1430`）和 `mldParseReconfigMlIE`（`mlo.c:2036`）分别处理两种 ML IE 变体——Basic（关联/发现用，§9.4.2.322.2）和 Reconfiguration（链路重配用，§9.4.2.322.4）。两个函数结构同构：先校验 IE 长度，再按 ML Control 字段的 type 和 presence bitmap 逐段解出 MLD 地址、EML Capabilities、MLD Capabilities：

```c
// MTK gen4m: mgmt/mlo.c:2036 — mldParseReconfigMlIE, 解析 Reconfiguration 变体
void mldParseReconfigMlIE(struct MULTI_LINK_INFO *prMlInfo,
	const uint8_t *pucIE, const uint8_t *paucBssId, const char *pucDesc)
{
	// ...省略 debug log 和 kalMemSet 清零...

	prMlInfoIe = (struct IE_MULTI_LINK_CONTROL *)pucIE;
	pos = prMlInfoIe->aucCommonInfo;

	/* ML control bits[4,15] is presence bitmap */
	ucMlCtrlPreBmp = ((prMlInfoIe->u2Ctrl & ML_CTRL_PRE_BMP_MASK)
				>> ML_CTRL_PRE_BMP_SHIFT);
	ucMlCtrlType = (prMlInfoIe->u2Ctrl & ML_CTRL_TYPE_MASK);

	/* It shall be Reconfiguration variant ML element */
	if (ucMlCtrlType != ML_CTRL_TYPE_RECONFIG) {
		prMlInfo->ucValid = FALSE;
		DBGLOG(ML, WARN, "invalid ML control type:%d\n", ucMlCtrlType);
		return;
	}

	prMlInfo->ucMlCtrlType = ucMlCtrlType;
	prMlInfo->ucMlCtrlPreBmp = ucMlCtrlPreBmp;
	prMlInfo->ucCommonInfoLength = *pos++;

	/* Check ML control that which common info exist */
	if (ucMlCtrlPreBmp & ML_RECFG_MLD_ADDR_PRESENT) {
		COPY_MAC_ADDR(prMlInfo->aucMldAddr, pos);
		pos += MAC_ADDR_LEN;
	}
	if (ucMlCtrlPreBmp & ML_RECFG_EML_CAP_PRESENT) {
		kalMemCopy(&prMlInfo->u2EmlCap, pos, 2);
		pos += 2;
	}
	if (ucMlCtrlPreBmp & ML_RECFG_MLD_CAP_OP_PRESENT) {
		kalMemCopy(&prMlInfo->u2MldCap, pos, 2);
		pos += 2;
	}
	// ...省略 common info 长度校验和 Per-STA Profile 解析...
}
```

- 解析是**按 presence bitmap 驱动的**：ML Control 字段的高位是 presence bitmap，`ML_RECFG_MLD_ADDR_PRESENT` / `ML_RECFG_EML_CAP_PRESENT` / `ML_RECFG_MLD_CAP_OP_PRESENT` 三个 bit 决定后面跟不跟 MLD 地址、EML Capabilities、MLD Capabilities。这种「bitmap 决定字段存在性」的编码，和 EHT 能力字段的布局一脉相承——都是为了省空口字节。
- **变体校验是第一道防线**：`ucMlCtrlType != ML_CTRL_TYPE_RECONFIG` 直接置 `ucValid = FALSE` 返回——Reconfig 解析器只认 Reconfig 变体，接错变体立即丢弃。对应管理面「收到的帧是不是我该处理的」这一层防御。

QCOM 侧没有独立的「ML IE 解析」文件——它的 ML 信息解析分散在关联流程里，落到管理面后，核心载体是 `struct wlan_mlo_dev_context`（`wlan_mlo_mgr_public_structs.h:1205`），这是 QCOM 侧 MLD 的「户口本」：

```c
// QCOM: qca-wifi-host-cmn/umac/mlo_mgr/inc/wlan_mlo_mgr_public_structs.h:1205
// struct wlan_mlo_dev_context — QCOM 侧一个 MLD 的核心上下文
struct wlan_mlo_dev_context {
	qdf_list_node_t node;
	uint8_t mld_id;                                    // 本 MLD 的 ID
	struct qdf_mac_addr mld_addr;                      // MLD 地址
	struct wlan_objmgr_vdev *wlan_vdev_list[WLAN_UMAC_MLO_MAX_VDEVS]; // 链路 vdev 列表
	uint16_t wlan_vdev_count;                          // 已关联的链路数
	struct wlan_mlo_peer_list mlo_peer_list;           // MLD 级 peer 列表
	qdf_atomic_t ref_cnt;
	struct wlan_mlo_sta *sta_ctx;                      // STA 侧上下文（copied_conn_req 等）
	struct wlan_mlo_ap *ap_ctx;                        // AP 侧上下文
	struct wlan_t2lm_context t2lm_ctx;                 // T2LM 协商上下文
	struct wlan_epcs_context epcs_ctx;                 // EPCS 上下文
	struct mlo_link_switch_context *link_ctx;          // link switch 状态机
	struct mlo_link_recfg_context *link_recfg_ctx;     // link reconfig 状态机
	uint8_t mlo_max_recom_simult_links;
	bool link_recfg_op_support;
};
```

- `wlan_vdev_list[WLAN_UMAC_MLO_MAX_VDEVS]` 是这个 MLD 的链路 vdev 数组，`wlan_vdev_count` 是已关联链路数——QCOM 用「vdev 数组 + 计数」表达「一个 MLD 有多条链路」，MTK 用 `u2ValidLinks` 位图 + `rStarecList` 链表表达同一件事，数据结构不同但语义等价。
- `link_ctx` 和 `link_recfg_ctx` 是两个独立的子状态机指针——这正是本文 §3、§4 的主角。它们挂在 `wlan_mlo_dev_context` 下，说明 link switch 和 link reconfig 是 MLD 级别的操作，不是单链路 vdev 的。
- `t2lm_ctx` 也挂在这里——T2LM 协商是 MLD 级别的（本文 §6 只谈它与模式协商的边界）。

两家的「捆链路」方式到此清晰：MTK 用 `struct MULTI_LINK_INFO` 做解析载体、`struct MLD_STA_RECORD` 做运行时关联（连接篇已展开 `mldStarecJoin` / `mldStarecRegister`）；QCOM 用 `struct wlan_mlo_dev_context` 做运行时户口本。解析只是一瞬间，捆好之后链路还要被「搬来搬去」——这就是 link switch。

---

# 3 一条链路坏了，怎么无损换到另一条？

MLO 最日常的管理面操作是 **link switch（链路切换）**：三条链路里有一条质量恶化（或 AP 出于负载均衡主动要求），MLD 要把这条链路上的「责任」——关联状态、MAC 地址、流量——无损地迁到另一条。

这里的「无损」是关键。链路切换不是断开重连——上层应用（正在进行的视频通话、TCP 连接）完全无感知。IEEE 802.11be 把这件事放在 §35.3.6 ML reconfiguration 的框架下（link switch 是 reconfiguration 的一种形态，§9.6.38.12-14 定义了 Link Reconfiguration Request / Response / Notify 帧）。

QCOM 把 link switch 做成一个七状态状态机，定义在 `wlan_mlo_mgr_link_switch.h:116`：

```c
// QCOM: qca-wifi-host-cmn/umac/mlo_mgr/inc/wlan_mlo_mgr_link_switch.h:116
// enum mlo_link_switch_req_state — link switch 请求的当前状态
enum mlo_link_switch_req_state {
	MLO_LINK_SWITCH_STATE_IDLE,               // 无请求，空闲
	MLO_LINK_SWITCH_STATE_INIT,               // 预启动
	MLO_LINK_SWITCH_STATE_DISCONNECT_CURR_LINK, // 断开当前链路中
	MLO_LINK_SWITCH_STATE_SET_MAC_ADDR,         // 更新 MAC 地址中
	MLO_LINK_SWITCH_STATE_CONNECT_NEW_LINK,     // 连接新链路中
	MLO_LINK_SWITCH_STATE_COMPLETE_SUCCESS,     // 切换成功
	MLO_LINK_SWITCH_STATE_ABORT_TRANS,          // 中止（只允许回到 IDLE）
};
```

- 这七个状态串起了 link switch 的完整生命周期：`DISCONNECT_CURR_LINK` → `SET_MAC_ADDR` → `CONNECT_NEW_LINK`。注意中间夹着一个 `SET_MAC_ADDR`——切换链路时，MLD 要把当前链路的 MAC 地址换到新链路上去（新链路用旧链路的地址或反过来），这是「无损」的一个隐藏环节：对端 AP 看到的 MAC 不能变。
- `ABORT_TRANS` 是「只出不进」的中止态——注释明确「Do not allow any further state transition, only allowed to move to IDLE」，任何异常都先落到这里再归零，防止状态机在异常路径上乱跳。

link switch 的触发源是固件——AP 通过空口发 Link Reconfiguration Request，固件收到后经 WMI 事件上报主机。入口在 `target_if_mlo_link_switch_request_event_handler`（`target_if/mlo_mgr/src/target_if_mlo_mgr.c:356`），它把 WMI 事件解包成 `struct wlan_mlo_link_switch_req`，再调 `mlo_rx_ops->mlo_link_switch_request_handler` 分发到 umac 的 `mlo_mgr_link_switch_request_params`（`wlan_mlo_mgr_link_switch.c:1931`）。这条 target_if → umac mlo_mgr 的边界，是 QCOM MLO 管理面「固件事件进主机」的第一跳。

状态机推进到 `CONNECT_NEW_LINK` 时，真正的连接动作交给 `mlo_mgr_link_switch_start_connect`（`wlan_mlo_mgr_link_switch.c:1363`）：

```c
// QCOM: qca-wifi-host-cmn/umac/mlo_mgr/src/wlan_mlo_mgr_link_switch.c:1363
// mlo_mgr_link_switch_start_connect — 在新链路上发起连接（link switch 的落地动作）
QDF_STATUS mlo_mgr_link_switch_start_connect(struct wlan_objmgr_vdev *vdev)
{
	QDF_STATUS status = QDF_STATUS_E_INVAL;
	struct wlan_cm_connect_req conn_req = {0};
	struct mlo_link_info *mlo_link_info;
	// ...省略局部变量...
	struct wlan_mlo_link_switch_req *req = &mlo_dev_ctx->link_ctx->last_req;
	struct wlan_objmgr_vdev *assoc_vdev = wlan_mlo_get_assoc_link_vdev(vdev);

	if (!assoc_vdev) {
		mlo_err("Assoc VDEV not found");
		goto out;
	}

	mlo_link_info = mlo_mgr_get_ap_link_by_link_id(mlo_dev_ctx,
						       req->new_ieee_link_id);
	// ...省略 link_info 空值和 MAC 地址校验...

	sta_ctx = mlo_dev_ctx->sta_ctx;
	copied_conn_req_lock_acquire(sta_ctx);
	if (sta_ctx->copied_conn_req) {
		qdf_mem_copy(&conn_req, sta_ctx->copied_conn_req,
			     sizeof(struct wlan_cm_connect_req));
	} else {
		copied_conn_req_lock_release(sta_ctx);
		goto out;
	}
	copied_conn_req_lock_release(sta_ctx);

	conn_req.vdev_id = wlan_vdev_get_id(vdev);
	conn_req.source = CM_MLO_LINK_SWITCH_CONNECT;
	wlan_vdev_set_link_id(vdev, req->new_ieee_link_id);

	conn_req.chan_freq = req->new_primary_freq;
	conn_req.link_id = req->new_ieee_link_id;
	qdf_copy_macaddr(&conn_req.bssid, &mlo_link_info->ap_link_addr);
	// ...省略 bssid_hint / ssid / mld_addr 填充...

	status = wlan_cm_start_connect(vdev, &conn_req);
	// ...省略收尾...
}
```

- **`copied_conn_req` 是 link switch 的「记忆」**：切换链路时，驱动把最初连接时的 `struct wlan_cm_connect_req` 副本（`sta_ctx->copied_conn_req`）拿出来改一改——`vdev_id`、`link_id`、`chan_freq`、`bssid` 换成新链路——其余参数（SSID、安全、能力）原样复用。这保证切换后的连接和原始连接「同一张脸」，上层感知不到变化。
- **`conn_req.source = CM_MLO_LINK_SWITCH_CONNECT`** 是这一跳的灵魂。`CM_MLO_LINK_SWITCH_CONNECT` 和它的兄弟 `CM_MLO_LINK_SWITCH_DISCONNECT`（`wlan_cm_public_struct.h:198-199`）是 connection_mgr 里标记「这次连接/断开是 link switch 发起的」的来源标签。后续 connection_mgr 的处理会据此分支——普通连接走完整流程，link switch 连接走「只建链路、不重复上报上层」的捷径。
- 真正的连接动作委托给 `wlan_cm_start_connect`——这又是跨模块一跳：mlo_mgr（管理面状态机）把「新链路的连接」委托给 connection_mgr（连接执行层）。到这里，管理面的状态机完成了它的职责，剩下的 Auth/Assoc 是连接层的活。

这条调用链可以缩成一行——每一步都跨了 QCOM 的一个模块：

```
固件(WMI link switch 事件)
  → target_if_mlo_link_switch_request_event_handler   [target_if/mlo_mgr]
    → mlo_mgr_link_switch_request_params              [umac/mlo_mgr，状态机入口]
      → mlo_mgr_link_switch_start_connect             [umac/mlo_mgr，落地连接]
        → wlan_cm_start_connect                       [connection_mgr，跨模块]
          → wlan_mlo_peer_create                      [umac/mlo_mgr，连接完回来建 peer]
```

注意最后一步：`wlan_cm_start_connect` 走完连接流程后，会回到 mlo_mgr 调 `wlan_mlo_peer_create`（调用点在 `wlan_cm_connect.c:3439`）。**mlo_mgr 和 connection_mgr 之间是一个循环**——mlo_mgr 发起连接、connection_mgr 执行、执行完回到 mlo_mgr 建 peer。这是 QCOM MLO 管理面最核心的架构特征：管理逻辑（mlo_mgr）和执行逻辑（connection_mgr）互相委托，通过 `source` 字段区分「这是不是 link switch 发起的」。

MTK 侧没有这样一个独立的 link switch 状态机——链路切换渗透在 AIS FSM 里，host 侧只剩「解析 + 下发」两件事。链路集合一旦变化，mlo.c 先解析（`mldParseReconfigMlIE`，§2 已展示），再逐链路把 MLD 信息经 UniCmd 下发给固件：`mldUpdatePerLinkMlo`（`mlo.c:4275`）调 `nicUniCmdSetBssMld` / `nicUniCmdSetStarecMld`，把「这个 MLD 由哪几条链路组成」写进固件的 MAT（MAC Address Table）和 WTBL（Wireless Table），固件据此完成实际切换。QCOM 是「host 跑七态状态机、固件执行」，MTK 是「host 解析 + 下发、固件决策执行」——同一件事，MTK 把 host 侧那一整层状态机省掉了。

用机场比喻收束这一节：link switch 就是**航班改签**。旅客（上层流量）不用下车，运控中心（mlo_mgr）拿到机长（固件）上报的「原登机口故障」后，把旅客的登机牌信息（copied_conn_req）从旧登机口（旧链路）改签到新登机口（新链路），通知地勤（connection_mgr）在新登机口摆好设备。旅客全程无感，只知道自己还是那张票（同一个 MLD 地址、同一个连接）。

但 link switch 只是「一对一换链路」。如果 AP 想的是「再加一条链路」或「砍掉一条链路」呢？那就是 link reconfig。

---

# 4 AP 要加一条链路、删一条链路，怎么办？

link switch 是「换」，link reconfiguration（链路重配）是「增删」。前者一对一替换，后者改变链路的数量。这是 MLD 管理面最复杂的一块——QCOM 的 `wlan_mlo_link_recfg.c` 有 7013 行，是整个 mlo_mgr 目录里最大的文件。

协议上，链路重配由 AP 主导：AP 发 Link Reconfiguration Request 帧（`IEEE 802.11be-2024 §9.6.38.13`）给非 AP MLD，要求它增删链路；非 AP MLD 回 Link Reconfiguration Response（§9.6.38.14）。整个过程在 §35.3.6 ML reconfiguration 定义。

QCOM 把这条链路重配的状态机定义在 `wlan_mlo_link_recfg.h:67`，**9 个主状态 + 11 个子状态**：

```c
// QCOM: qca-wifi-host-cmn/umac/mlo_mgr/inc/wlan_mlo_link_recfg.h:67
// enum wlan_link_recfg_sm_state — 链路重配状态机（主状态）
enum wlan_link_recfg_sm_state {
	WLAN_LINK_RECFG_S_INIT,      // 默认态，IDLE
	WLAN_LINK_RECFG_S_START,     // 重配启动
	WLAN_LINK_RECFG_S_DEL_LINK,  // 删链路请求
	WLAN_LINK_RECFG_S_XMIT_REQ,  // 发送重配请求帧
	WLAN_LINK_RECFG_S_ADD_LINK,  // 加链路请求
	WLAN_LINK_RECFG_S_COMPLETED, // 重配完成
	WLAN_LINK_RECFG_S_ABORT,     // 重配中止
	WLAN_LINK_RECFG_S_TTLM,      // TTLM（TID-to-Link 映射）处理
	WLAN_LINK_RECFG_S_MAX,
	// ...子状态（WLAN_LINK_RECFG_SS_*）: IDLE / START_PENDING / START_ACTIVE
	//   / DEL_LINK_WAIT_SET_LINK / DEL_LINK_WAIT_LINK_SW / ...共 11 个...
};
```

- 主状态 `DEL_LINK` 和 `ADD_LINK` 分列，中间夹一个 `XMIT_REQ`（发送请求帧）——重配的完整流程是「收请求 → 删/加链路 → 发响应帧」。`TTLM` 状态（TTLM 即 T2LM，源码枚举沿用了 TTLM 拼写）单独拎出来，因为链路增删会牵动 TID-to-Link 映射，重配后要重新协商映射。
- 子状态 `DEL_LINK_WAIT_SET_LINK` / `DEL_LINK_WAIT_LINK_SW` 里的 `WAIT` 道出了重配的复杂本质：**删链路不是一步到位，而是要等「设链路」和「链切」两个子动作各自完成**。`ADD_LINK_ABORT_WAIT_*` 则说明加链路也可能半路中止，中止也要等——这就是 7013 行代码的由来：状态机不仅要管理正常路径，还要管理每一个异常分叉。

一个值得注意的细节：`mlo_link_recfg_notify`（`wlan_mlo_link_recfg.c:529`）是个**空壳**——函数体只有一行 `return QDF_STATUS_SUCCESS`。这说明 link reconfig 的入口不是这个 notify 函数，而是 `mlo_link_recfg_request_params`（`wlan_mlo_link_recfg.c:779`）和它的两个 scheduler 消息处理器 `mlo_link_recfg_add_link_req_cb` / `mlo_link_recfg_link_sw_req_cb`（`wlan_mlo_link_recfg.c:2201` / `2321`）。真正的重配请求进来时，通过 scheduler 投递一条消息，在 workqueue 上下文里串行推进状态机——这是 QCOM 状态机的标准套路：**事件投递进队列，状态机在专有上下文里单线程推进**，避免锁竞争。

MTK 侧同样没有独立的 reconfig 状态机——9 主态 + 11 子态是 QCOM 特有的，MTK 把重配藏进 AIS FSM 里一段 `CFG_SUPPORT_ML_RECONFIG` 编译段。删链路有专门入口 `mldCheckApRemoval`（`mlo.c:4842`）：它复用 §2 的 `mldParseReconfigMlIE` 解析 Reconfiguration ML IE，对每条匹配链路调 `aisCheckApRemoval`（`ais_fsm.c:1268`）启动 `rApRemovalTimer`；超时后 `aisFsmRunApRemovalTimeout`（`ais_fsm.c:6493`）按 T2LM 清空 TID bitmap（`mldUpdateTidBitmap`，`mlo.c:4198`）或触发重连。加链路则先过 `aisSecondLinkAvailable`（`ais_fsm.c:2402`）→ `mldBssAllowReconfig`（`mlo.c:3681`）的准入判断，当前只支持一个 multi-link MLO。MTK 用「定时器 + 决策函数」替代了 QCOM 的一整套状态机。

这一节的设计层追问：为什么 link switch 是「一个状态机」，link reconfig 要再叠「一个状态机 + 子状态」？

因为两者改变的维度不同。link switch 只改「链路 ID 的对应关系」——原来 link 0 的责任交给 link 1，链路总数不变，所以一个扁平状态机就够。link reconfig 改的是「链路集合的基数」——加一条、删一条，链路总数变了，牵一发而动全身：删链路要先把这条链路上的流量和 T2LM 映射搬走（所以有 `WAIT_SET_LINK` / `WAIT_LINK_SW`），加链路要先等新链路完成扫描和认证（所以有 `ADD_LINK_WAIT_ADD_CONN`）。**基数变化比对应关系变化难管，这是管理面复杂度的真正来源**——用机场的话说，改签（link switch）只是换个登机口，增删航线（link reconfig）要动整个航班的时刻表、机组排班和地面保障。

---

# 5 一个 peer 怎么在三条链路上保持一致？

链路被建立、切换、重配之后，还有一个贯穿始终的管理对象：**peer（对端设备）**。MLO 场景下，一个对端 MLD 在三条链路上各有一个「链路 peer」，但这三个链路 peer 共享同一个 MLD 身份——管理面的职责是让这三个 peer 的行为保持一致：关联状态、密钥、能力（STR / eMLSR）要同步。

QCOM 的 peer 管理在 `wlan_mlo_mgr_peer.c`（3044 行）。入口是 `wlan_mlo_peer_create`（`wlan_mlo_mgr_peer.c:1571`）——它在一台 AP MLD 上为一个 STA 建立 MLD 级 peer：

```c
// QCOM: qca-wifi-host-cmn/umac/mlo_mgr/src/wlan_mlo_mgr_peer.c:1571
// wlan_mlo_peer_create — 在 AP MLD 上为 STA 建立 MLD 级 peer
QDF_STATUS wlan_mlo_peer_create(struct wlan_objmgr_vdev *vdev,
				struct wlan_objmgr_peer *link_peer,
				struct mlo_partner_info *ml_info,
				qdf_nbuf_t frm_buf,
				uint16_t aid)
{
	struct wlan_mlo_dev_context *ml_dev;
	struct wlan_mlo_peer_context *ml_peer = NULL;
	// ...省略局部变量...

	ml_dev = vdev->mlo_dev_ctx;
	if (!ml_dev) {
		mlo_err("ML dev ctx is NULL");
		return QDF_STATUS_E_NULL_VALUE;
	}

	/* Check resources of Partner VDEV */
	if (wlan_vdev_mlme_get_opmode(vdev) == QDF_SAP_MODE) {
		if (wlan_mlo_is_mld_ctx_exist(
		    (struct qdf_mac_addr *)&link_peer->mldaddr[0])) {
			mlo_err("MLD ID %d ML Peer " QDF_MAC_ADDR_FMT " is matching with one of the MLD address in the system",
				ml_dev->mld_id,
				QDF_MAC_ADDR_REF(link_peer->mldaddr));
			return QDF_STATUS_E_FAILURE;
		}
		/* Limit max assoc links */
		if (ml_info->num_partner_links > WLAN_UMAC_MLO_ASSOC_MAX_SUPPORTED_LINKS) {
			mlo_err("MLD ID %d ML Peer ... exceeds MAX assoc limit of %d",
				ml_dev->mld_id, ...);
			// ...省略错误分支...
		}

		status = wlan_mlo_dev_get_link_vdevs(vdev, ml_dev,
						     ml_info, link_vdevs);
		// ...省略后续逐链路 vdev 的 peer 建立循环...
	}
	// ...省略后续 mlo_peer 分配和 attach...
}
```

- **MLD 地址去重是第一道检查**：`wlan_mlo_is_mld_ctx_exist` 检查这个对端 MLD 是否已经在系统里登记过——如果重复，直接拒绝。这保证「一个对端 MLD 只建一个 MLD 级 peer」，防止三条链路的 peer 各自为政。
- **关联链路数有上限**：`num_partner_links > WLAN_UMAC_MLO_ASSOC_MAX_SUPPORTED_LINKS` 时拒绝——AP 侧要限制一个 STA 最多关联几条链路，防止资源耗尽。
- `wlan_mlo_dev_get_link_vdevs` 取出这个 MLD 下的所有链路 vdev，然后逐个建立链路 peer 并挂到 MLD 级 peer 下——这就是 `mlo_peer_attach_link_peer` / `wlan_mlo_link_peer_attach` 做的事。

peer 建立之后，能力同步是关键。`wlan_mlo_peer_get_str_capability`（`wlan_mlo_mgr_peer.c:2198`）和 `wlan_mlo_peer_get_eml_capability`（`wlan_mlo_mgr_peer.c:2232`）分别把对端的 STR 能力和 EML 能力取出来，供管理面判断「这个 peer 能不能和我并行收发、能不能进 eMLSR」。peer 的状态用一个三态枚举表达（`wlan_mlo_mgr_public_structs.h:1272`）：

```c
// QCOM: qca-wifi-host-cmn/umac/mlo_mgr/inc/wlan_mlo_mgr_public_structs.h:1272
enum mlo_peer_state {
	ML_PEER_CREATED,             // 初始态：peer 已建立
	ML_PEER_ASSOC_DONE,          // 关联完成：assoc 已在关联链路上发出
	ML_PEER_DISCONN_INITIATED,   // 断开已发起：某条链路发起断开
};
```

- 三个状态对应 peer 生命周期的三个阶段：建立 → 关联完成 → 断开发起。`ML_PEER_DISCONN_INITIATED` 是「某条链路发起断开」的状态——注意是「发起」而不是「完成」，因为 MLD 级 peer 的断开是逐链路的，一条链路发起断开后，其他链路可能还在跑。

MTK 侧把 peer 管理表达为 `struct MLD_STA_RECORD`（`cnm_mem.h:849`）——这是「一个 MLD 地址 → 多条 STA_RECORD」的树形根节点（连接篇已详述 `mldStarecJoin` / `mldStarecRegister`）：

```c
// MTK gen4m: include/mgmt/cnm_mem.h:849 — struct MLD_STA_RECORD
struct MLD_STA_RECORD {
	struct LINK_ENTRY rLinkEntry;
	uint8_t fgIsInUse;
	uint8_t ucIdx;
	uint8_t ucGroupMldId;                /* id from mld bss */
	uint8_t aucPeerMldAddr[MAC_ADDR_LEN]; // 对端 MLD 地址
	uint16_t u2PrimaryMldId;
	uint16_t u2SecondMldId;
	uint16_t u2SetupWlanId;
	uint8_t fgEPCS;
	uint8_t fgMldType;
	uint8_t aucStrBitmap[UNI_MLD_LINK_MAX]; // 各链路 STR 能力位图
	uint16_t u2EmlCap;                       // EML 能力
	uint16_t u2MldCap;                       // MLD 能力
	struct LINK rStarecList;                 // 各链路 STA_RECORD 链表
	uint64_t aucRxPktCnt[ENUM_BAND_NUM];
	uint32_t u4StaBitmap;
	uint16_t u2ValidLinks;                   // 有效链路位图
	// ...省略 EPCS/T2LM 定时器和参数...
};
```

- `rStarecList` 是各链路 `STA_RECORD` 的链表——MTK 的「一个 peer 多条链路」就靠这个链表表达，和 QCOM 的 `wlan_mlo_dev_context->wlan_vdev_list` 数组语义等价。
- `aucStrBitmap[UNI_MLD_LINK_MAX]` 是各链路的 STR 能力位图——和 QCOM 的 `wlan_mlo_peer_get_str_capability` 对应，都是「这个 peer 在哪些链路上能并行收发」的信息。
- `u2ValidLinks` 在这里又出现一次——MTK 用位图表达「MLD 里哪些链路有效」，和 `struct MULTI_LINK_INFO` 里的 `u2ValidLinks` 呼应：解析时填一次，运行时维护一次。

peer 的「客户端列表」管理是 MTK 的一个独特设计：`mldBssAddClient`（`mlo.c:3296`）把 `MLD_STA_RECORD` 挂到 `MLD_BSS_INFO` 的 `rMldStaRecOfClientList` 链表上：

```c
// MTK gen4m: mgmt/mlo.c:3296 — mldBssAddClient, 把 MLD STA 挂到 MLD BSS 的客户端列表
void mldBssAddClient(struct ADAPTER *prAdapter,
	struct MLD_BSS_INFO *prMldBssInfo, struct MLD_STA_RECORD *prMldStaRec)
{
	struct LINK *prClientList;
	struct MLD_STA_RECORD *prCurrMldStaRec;

	if (!prMldBssInfo)
		return;

	prClientList = &prMldBssInfo->rMldStaRecOfClientList;
	LINK_FOR_EACH_ENTRY(prCurrMldStaRec, prClientList, rLinkEntry,
			    struct MLD_STA_RECORD) {
		if (prCurrMldStaRec->ucIdx == prMldStaRec->ucIdx) {
			// ...已存在，直接返回（去重）...
			return;
		}
	}

	LINK_ENTRY_INITIALIZE(&prMldStaRec->rLinkEntry);
	LINK_INSERT_TAIL(prClientList, &prMldStaRec->rLinkEntry);
	// ...省略 log...
}
```

- 这个函数是 AP 侧的「住客登记」：一台 AP MLD 下的每个 MLD STA（客户端）都要登记到 `MLD_BSS_INFO` 的客户端链表，登记前先查重（`ucIdx` 相同则跳过）。配对的 `mldBssRemoveClient` 负责退房。这与 QCOM 的 `wlan_mlo_peer_create` 里的 `wlan_mlo_is_mld_ctx_exist` 去重是同一件事的两种表达——MTK 用「查重链表」的显式循环，QCOM 用「查全局 MLD 上下文」的函数调用。

peer 管理的设计层追问：为什么 peer 要跨链路同步能力，而不是各链路各管各的？因为 MLO 的**操作模式协商是 MLD 级**的——一个 peer 能不能和我进 eMLSR、能不能 STR 并行，取决于「所有链路的共同能力」，而不是某一条链路的能力。如果链路 0 支持 STR、链路 1 不支持，那这个 MLD peer 的整体 STR 能力就要按最弱的算。peer 管理把各链路的能力汇总到 MLD 级，正是为了让模式协商有据可依——这正好接到下一节。

---

# 6 模式协商：MLSR / eMLSR / STR 谁说了算？

四种操作模式（SLO / MLSR / eMLSR / MLMR（STR+NSTR））的协议定义和 TX 路径影响已经讲透。本文只补一件事：**模式的「协商」在代码里落在哪一层，和「执行」怎么分界**——这是本文「管理面 vs 执行面」主线在模式维度上的收口。

QCOM 侧，模式协商的静态结果是 `enum MLO_TYPE`（`wlan_cm_public_struct.h:724`）：

```c
// QCOM: qca-wifi-host-cmn/umac/mlme/connection_mgr/dispatcher/inc/wlan_cm_public_struct.h:724
// enum MLO_TYPE — 一个 BSS 的 ML 类型（连接管理层的分类）
enum MLO_TYPE {
	SLO,        // Non-ML 或单链路 ML
	MLSR,       // Multi link Single Radio：多条链路须在同一 MAC 上
	EMLSR,      // Enhanced multi link single radio
	MLMR,       // Multi link Multi Radio：多条链路可在不同 MAC 上
	MLO_TYPE_MAX
};
```

- 注意这个枚举的注释：`MLSR` 和 `EMLSR` 是「单射频」——多条链路共享一个射频模块；`MLMR` 是「多射频」——多条链路可用不同射频模块。**STR/NSTR 的区分在 `MLMR` 内部，这个枚举不细分**——STR/NSTR 由固件在 Multi-Link Capabilities 协商时内部处理，host 侧的 `enum MLO_TYPE` 只到 `MLMR` 粒度为止。这是「管理面只管粗粒度、执行面管细粒度」的又一例证。
- 用户空间的 vendor 命令需要区分 STR/NSTR（`QCA_WLAN_EHT_NON_STR_MLMR` / `QCA_WLAN_EHT_STR_MLMR`），映射到内部时合并为 `MLMR`。

模式的「协商」结果是 peer 能力的交集，主机把结果存下来、把「执行」交给固件：进入 eMLSR 时，QCOM 走 `sme_activate_mlo_links` 通知固件激活/去激活链路，MTK 则完全由固件内部通过 WTBL 字段自主决策，主机只被动感知。**协商是管理面的活（主机算交集、存结果），执行是数据面的活（固件切射频、发 EML Operating Mode Notification）**——这条边界，就是本文反复强调的那条线的又一个切面。

关于「谁说了算」的答案：**双方能力求交，主机定结论，固件执行**。对端宣告支持 eMLSR（ML IE 的 EML Capabilities `emlsr_supp=1`），本端也支持，主机侧的 `mlo_peer` 就把这个 MLD 归类为「可 eMLSR」，把结论存在 `struct wlan_mlo_dev_context` / `struct MLD_STA_RECORD` 的 `u2EmlCap` 里；真正进不进 eMLSR、什么时候进、padding delay 发多少，全在固件。主机不问「现在是不是 eMLSR」，只问「我们能不能 eMLSR」。

模式协商之外，还有一组「主机只管宣告」的能力——320 MHz 和 4K QAM。它们比模式协商更极端：连「算交集」都省了，主机只是把能力位填进 IE，剩下全是 PHY 的事。

---

# 7 320 MHz 与 4K QAM 为什么主机只「宣告」不「实现」？

从这一节起，视角从「管理面状态机」转到「能力位协商」。320 MHz 信道和 4096-QAM 调制是 WiFi 7 吞吐量翻倍的两大引擎（320 MHz 把带宽从 160 MHz 翻倍，4096-QAM 每个符号从 1024-QAM 的 10 bit 提到 12 bit），但它们在主机代码里的身影薄得惊人——主机只负责**宣告支持**和**下发 MCS map**，调制解调的实现在 PHY 硬件里。

先看协议：320 MHz 和 4K QAM 的支持位都藏在 EHT Capabilities element 的 EHT PHY Capabilities Information 字段里（`IEEE 802.11be-2024 §9.4.2.323.3`，Figure 9-1074aq）。关键位：

- **B1「Support For 320 MHz In 6 GHz」**——320 MHz 只在 6 GHz 频段可用（2.4G/5G 没有连续的 320 MHz 频谱），所以叫「in 6 GHz」。
- **B41 / B42「Tx / Rx 1024-QAM And 4096-QAM < 242-tone RU Support」**——在小子载波 RU 上收发 4K QAM 的能力。
- **B64 / B65「Rx 1024-QAM / 4096-QAM In Wider Bandwidth DL OFDMA Support」**——在更宽带宽的下行 OFDMA 里收 4K QAM 的能力。

QCOM 用 `struct wlan_eht_cap_info`（`wlan_cmn_ieee80211.h:3602`）把这个字段逐位映射，这是主机侧 320 MHz / 4K QAM 能力的「登记簿」：

```c
// QCOM: qca-wifi-host-cmn/umac/cmn_services/cmn_defs/inc/wlan_cmn_ieee80211.h:3602
// struct wlan_eht_cap_info — EHT 能力信息（对应 EHT Capabilities element）
struct wlan_eht_cap_info {
	// ...省略前 13 个 uint16_t 位域（EPCS、TXS、TWT 等 MAC 能力）...

	uint32_t ru_242tone_wt_20mhz:1;
	uint32_t support_320mhz_6ghz:1;       // B1：6 GHz 支持 320 MHz
	uint32_t reserved2:1;
	// ...省略波束成形能力位域...

	uint32_t mcs_15:4;                    // B46 及保留位：EHT-MCS 15 支持
	// ...省略 LTF / padding 能力...
	uint32_t rx_1024_4096_qam_lt_242_tone_ru:1; // B42：Rx 4K QAM（小 RU）
	uint32_t tx_1024_4096_qam_lt_242_tone_ru:1; // B41：Tx 4K QAM（小 RU）
	// ...

	uint8_t mru_support_20mhz:1;          // B68：20 MHz-Only MRU 支持
	uint8_t rx_4k_qam_in_wider_bw_dl_ofdma:1;  // B65：Rx 4K QAM（宽带宽 DL OFDMA）
	uint8_t rx_1k_qam_in_wider_bw_dl_ofdma:1;  // B64：Rx 1K QAM（宽带宽 DL OFDMA）

	uint32_t bw_320_rx_max_nss_for_mcs_12_and_13:4; // 320MHz 上 MCS 12/13 的 Rx 流数
	uint32_t bw_320_tx_max_nss_for_mcs_12_and_13:4; // 320MHz 上 MCS 12/13 的 Tx 流数
	// ...省略各带宽 × 各 MCS 段的 NSS 位域...
};
```

- 这个结构体是主机侧对「EHT 能力」的**逐位镜像**——`support_320mhz_6ghz` 对应规范的 B1，`rx_4k_qam_in_wider_bw_dl_ofdma` 对应 B65。主机的工作就是：把结构体的这些位填好，序列化进 EHT Capabilities element 发出去（或从对端的 element 解析进来）。
- 4K QAM 的能力被拆成**三个正交维度**：小 RU 上的收发（`rx/tx_1024_4096_qam_lt_242_tone_ru`）、宽带宽 DL OFDMA 的接收（`rx_4k_qam_in_wider_bw_dl_ofdma`）、以及每个带宽下的最大空间流数（`bw_320_rx_max_nss_for_mcs_12_and_13`）。**MCS 12/13 就是 4096-QAM**（`IEEE 802.11be-2024 §36.5.1` Table 36-71：MCS 12 = 4096-QAM 3/4，MCS 13 = 4096-QAM 5/6），所以「MCS 12/13 的 NSS」就是「4K QAM 的流数上限」。
- `mru_support_20mhz` 混在这个结构体里（B68），预示了下一节 Multi-RU 的能力位也在这里——EHT 的能力位都挤在同一个 9 字节的字段里，主机一个结构体全包了。

320 MHz 的另一半是**信道宽度的枚举映射**。QCOM 在 `enum phy_ch_width` 里加了 `CH_WIDTH_320MHZ`（`wlan_cmn.h:614`），并在 `wlan_hdd_main.c` 里把它映射到内核的 `NL80211_CHAN_WIDTH_320`（`wlan_hdd_main.c:20051`，仅在 `WLAN_FEATURE_11BE && CFG80211_11BE_BASIC` 下编译）：

```c
// QCOM: qcacld-3.0/core/hdd/src/wlan_hdd_main.c:20051 — NL80211 到 QCOM 的带宽映射表
#if defined(WLAN_FEATURE_11BE) && defined(CFG80211_11BE_BASIC)
	[NL80211_CHAN_WIDTH_320] = {
		.sir_chwidth_valid = true,
		.sir_chwidth = eHT_CHANNEL_WIDTH_320MHZ,
		.ch_bw = HW_MODE_320_MHZ,
		.ch_bw_str = "320MHz",
		.phy_chwidth = CH_WIDTH_320MHZ,
		.bonding_mode = WNI_CFG_CHANNEL_BONDING_MODE_ENABLE,
	},
#endif
```

- 这行映射的职责是**把内核的「320 MHz 信道宽度」翻译成 QCOM 内部的 `CH_WIDTH_320MHZ`**，供上层的 vdev 配置使用。它和 `support_320mhz_6ghz` 能力位是两回事：能力位是「对端支不支持」，信道宽度映射是「本端怎么表达 320 MHz 这个宽度」。
- 还有一个「主机向固件问最大带宽」的环节：`hdd_get_eht_phy_ch_width_from_target`（`wlan_hdd_main.c:937`）读 `sme_get_eht_ch_width()`，如果固件报告 `WNI_CFG_EHT_CHANNEL_WIDTH_320MHZ`，主机才把内部最大带宽设为 `CH_WIDTH_320MHZ`。**320 MHz 的上限是固件报的**，主机不自己猜——这又是「主机宣告、固件实现」的分界：固件知道射频硬件到底支持多宽，主机只是转发。

4K QAM 在 MTK 侧的实现同样「只填 MCS map、不碰调制」。`ehtRlmFillBW80MCSMap`（`eht_rlm.c:124`）在能力上报时填 EHT-MCS map，其中 MCS 12/13 的字段由 `EHT_CAP_INFO_MCS_MAP_MCS13`（`eht_rlm.c:35`，值 3）这个阈值决定：

```c
// MTK gen4m: mgmt/eht_rlm.c:124 — ehtRlmFillBW80MCSMap, 填 BW80 的 EHT-MCS map
static void ehtRlmFillBW80MCSMap(
	struct ADAPTER *prAdapter,
	struct BSS_INFO *prBssInfo,
	uint8_t *prEhtSupportedMcsSet)
{
	uint8_t ucMcsMap, ucSupportedNss;
	struct EHT_SUPPORTED_MCS_BW80_160_320_FIELD *_prEhtSupportedMcsSet
			= (struct EHT_SUPPORTED_MCS_BW80_160_320_FIELD *)
				prEhtSupportedMcsSet;

	kalMemZero((void *) prEhtSupportedMcsSet,
		sizeof(struct EHT_SUPPORTED_MCS_BW80_160_320_FIELD));
	ucSupportedNss = wlanGetSupportNss(prAdapter,
		prBssInfo->ucBssIndex);
	ucMcsMap = ucSupportedNss + (ucSupportedNss << 4);

	if (prAdapter->fgMcsMapBeenSet & SET_EHT_BW80_MCS_MAP) {
		// ...Sigma 测试显式设置的 MCS map...
	} else if (prAdapter->fgMcsMapBeenSet & SET_HE_MCS_MAP) {
		uint8_t map = prAdapter->ucMcsMapSetFromSigma;

		if (map >= HE_CAP_INFO_MCS_MAP_MCS9)
			_prEhtSupportedMcsSet->eht_mcs_0_9 = ucMcsMap;
		if (map >= HE_CAP_INFO_MCS_MAP_MCS11)
			_prEhtSupportedMcsSet->eht_mcs_10_11 = ucMcsMap;
		if (map >= EHT_CAP_INFO_MCS_MAP_MCS13)
			_prEhtSupportedMcsSet->eht_mcs_12_13 = ucMcsMap;  // MCS 12/13 = 4K QAM
	} else {
		_prEhtSupportedMcsSet->eht_mcs_0_9 = ucMcsMap;
		_prEhtSupportedMcsSet->eht_mcs_10_11 = ucMcsMap;
		_prEhtSupportedMcsSet->eht_mcs_12_13 = ucMcsMap;
	}
}
```

- `ucMcsMap = ucSupportedNss + (ucSupportedNss << 4)` 把空间流数 NSS 编码成 EHT-MCS map 的格式（高 2 bit 是 Rx NSS，低 2 bit 是 Tx NSS）。**MCS map 填的都是「支持到哪个 MCS、几条流」，没有一个 bit 涉及「怎么调出 4096-QAM 的星座点」**——后者在 PHY 硬件的调制器里。
- `eht_mcs_12_13` 字段是 MCS 12/13（4K QAM）的 NSS 声明。MTK 还有个配套常量 `DOT11BE_PHY_CAP_TX_1024QAM_4096QAM_LE_242_TONE_RU` / `DOT11BE_PHY_CAP_RX_1024QAM_4096QAM_LE_242_TONE_RU`（`eht_ie.h:481-482`），对应规范的 B41/B42，在 `ehtRlmFillCapIE` 里置位。

320 MHz 和 4K QAM 的代码到此为止。主机侧能看到的全部工作，就是「填能力位 + 填 MCS map + 映射信道宽度」——**没有一个函数在做调制、做带宽扩展**。如果你在主机代码里找不到「4096-QAM 调制器」，不是没搜到，是它本来就不在主机里：调制解调在 PHY 硬件，主机只是替硬件「对外宣告」。用机场的话说：值机柜台（主机）只负责在票面上印「宽体机」「公务舱」（能力位），真正开飞机（调制 4096-QAM）、用满 320 MHz 跑道（带宽扩展）的是机长（PHY 硬件）。

这引出一个读者很可能已经在想的问题：既然 320 MHz / 4K QAM 主机只做宣告，那更复杂的 puncturing（打孔）和 Multi-RU（组合 RU）呢？答案更极端——主机连「宣告」都只做一半，剩下的一半和全部的执行都在固件。

---

# 8 Puncturing 与 Multi-RU 为什么主机看都看不到？

preamble puncturing（前导打孔）和 Multi-RU（多资源单元）是 WiFi 7 提升频谱利用率的两个 PHY 级特性，但它们与 320 MHz / 4K QAM 有一个本质区别：**打孔决策和组合调度需要微秒级的实时信息，主机既看不到、也来不及做**。这一节把「主机不可见」的边界画清楚。

## 8.1 Preamble puncturing：打孔决策在固件

preamble puncturing 解决的是「一个 80/160/320 MHz 信道里某一段 20 MHz 被雷达或干扰占用了怎么办」的问题。传统做法是整个信道降级（80 MHz 降到 40 MHz），puncturing 的做法是**只打掉被占用的那一段 20 MHz，其余照发**——「绕开障碍」而不是「整条路绕远」（协议定义见 §35.15.2 preamble puncturing operation，PHY 层的 PPDU 结构见 §36.3.12.11）。

QCOM 主机侧对 puncturing 的表达薄到只有两个地方：一个枚举 + 一个下发参数。

枚举 `enum cdp_punctured_modes`（`dp/inc/cdp_txrx_mon_struct.h:203`）只在 monitor（射频监控）层用，用于标识「当前 PPDU 打了多少孔」：

```c
// QCOM: qca-wifi-host-cmn/dp/inc/cdp_txrx_mon_struct.h:203
enum cdp_punctured_modes {
	NO_PUNCTURE,
#ifdef WLAN_FEATURE_11BE
	PUNCTURED_20MHZ,      // 打了 20 MHz 的孔
	PUNCTURED_40MHZ,      // 打了 40 MHz 的孔
	PUNCTURED_80MHZ,      // 打了 80 MHz 的孔
	PUNCTURED_120MHZ,     // 打了 120 MHz 的孔
#endif
	PUNCTURED_MODE_CNT,
};
```

- 这个枚举不是给调度用的，是给 monitor 解析用的——主机收到 PPDU 描述符后，用这个枚举标识「这个 PPDU 打了多宽的孔」，用于统计和诊断。**主机只「看见」打孔的结果，不「决定」打孔**。

真正的「打孔信息下发」是 `wlan_cm_sta_update_bw_puncture`（`wlan_cm_api.c:559`）——它把带宽和打孔位图打包成一个参数发给固件：

```c
// QCOM: qca-wifi-host-cmn/umac/mlme/connection_mgr/dispatcher/src/wlan_cm_api.c:559
// wlan_cm_sta_update_bw_puncture — 更新 STA 的带宽和打孔位图（下发给 peer）
QDF_STATUS wlan_cm_sta_update_bw_puncture(struct wlan_objmgr_vdev *vdev,
					  uint8_t *peer_mac,
					  uint16_t ori_punc,
					  enum phy_ch_width ori_bw,
					  uint8_t ccfs0, uint8_t ccfs1,
					  enum phy_ch_width new_bw)
{
	struct wlan_channel *des_chan;
	struct ch_params ch_param;
	uint32_t bw_puncture = 0;
	// ...省略空值检查和 ch_param 初始化...

	ch_param.ch_width = new_bw;
	status = wlan_cm_sta_set_chan_param(vdev, des_chan->ch_freq,
					    ori_bw, ori_punc, ccfs0,
					    ccfs1, &ch_param);
	// ...省略错误检查和 ch_width/puncture 比较...

	des_chan->puncture_bitmap = ch_param.reg_punc_bitmap;
	des_chan->ch_width = ch_param.ch_width;
	// ...省略 log...

	QDF_SET_BITS(bw_puncture, 0, 8, des_chan->ch_width);
	QDF_SET_BITS(bw_puncture, 8, 16, des_chan->puncture_bitmap);
	return wlan_util_vdev_peer_set_param_send(vdev, peer_mac,
						  WLAN_MLME_PEER_BW_PUNCTURE,
						  bw_puncture);
}
```

- **主机把「带宽 + 打孔位图」打包成一个 32 位参数**（低 8 bit 是 `ch_width`，高 16 bit 是 `puncture_bitmap`），通过 `wlan_util_vdev_peer_set_param_send` 以 `WLAN_MLME_PEER_BW_PUNCTURE` 标签下发。**下发的方向是主机 → 固件**，内容是「哪个 peer 用多宽带宽、打哪些孔」。
- 关键在「打孔决策谁做」：`puncture_bitmap` 是**从 AP 的 Beacon / Assoc 里解析出来的**（AP 宣告自己会打哪些孔），主机只是把这个静态信息转发给固件。**真正决定「此刻这一帧要不要打孔、打哪个孔」的是固件**——它实时感知雷达/干扰（DFS 检测、CCA），在微秒级做出打孔决策，主机既没有这个信息、也没有这个时间尺度。

MTK 侧连「下发参数」都没有——只剩下芯片 MIB 计数器 `TX_PREAMBLE_PUNCTURING_COUNT` / `RX_PREAMBLE_PUNCTURING_COUNT`（`include/chips/coda/mt6655/bn0_wf_mib_top.h`）。这俩是硬件寄存器，注释写得很直白：

```
TX_PREAMBLE_PUNCTURING_COUNT — This counter is increased when a PPDU is
  transmitted that BW strategy is preamble puncturing
RX_PREAMBLE_PUNCTURING_COUNT — This counter is increased when a MPDU is
  received that BW strategy is preamble puncturing
```

- 主机能做的，就是读这俩计数器，统计「发了/收了多少个打孔 PPDU」——**打孔的决策和执行完全在固件+硬件里，主机只剩一个事后统计的钩子**。这比 QCOM 的「下发静态位图」更彻底：MTK 连位图都不下发了，打孔完全交给固件自主决策。

## 8.2 Multi-RU：组合调度在固件

Multi-RU 解决的是「小数据包挤在大 RU 里浪费」的问题：WiFi 6 里一个 20 MHz 信道就一个 242-tone RU，WiFi 7 允许把 RU 切成小块（small size MRU，如 106+26 tone）或组合大块（large size MRU，如 2×996+484 tone）分给多个用户（PHY 定义见 §36.3.2.2.2 small size MRUs / §36.3.2.2.3 large size MRUs）。但「哪些 RU 组合给哪个用户」的调度，和打孔一样，是固件在每帧里做的。

主机侧的 Multi-RU 能力位，QCOM 是 `struct wlan_eht_cap_info` 里的 `mru_support_20mhz:1`（上一节已引，对应规范 B68「20 MHz-Only MRU Support」），以及两个下发参数 `pdev_param_enable_small_mru` / `pdev_param_enable_large_mru`（`wmi/inc/wmi_unified_param.h:6085-6087`）——主机通过 WMI 把「允许固件用 small/large MRU」这个开关下发下去，具体怎么组合，固件说了算。MTK 侧的能力位是 `EHT_MCS15_MRU_106_or_52_w_26_tone`（`include/mgmt/eht_ie.h:321`，值 1）——只宣告「支持 MCS 15 在 106+26 或 52+26 tone 的 MRU 上」这种能力，不碰调度。

把这一节的边界收成一张表：

| 特性       | 主机做什么                                                   | 固件/硬件做什么               | 主机不可见的部分   |
| ---------- | ------------------------------------------------------------ | ----------------------------- | ------------------ |
| 320 MHz    | 填能力位 `support_320mhz_6ghz`、映射 `CH_WIDTH_320MHZ`、问固件最大带宽 | 射频实际工作带宽              | 320 MHz 射频链路   |
| 4K QAM     | 填 MCS 12/13 能力位 + NSS map                                | 调制解调 4096-QAM 星座        | 调制器/解调器      |
| Puncturing | 转发静态打孔位图（QCOM）/ 读 MIB 计数（MTK）                 | 实时感知雷达/干扰、做打孔决策 | 微秒级打孔决策     |
| Multi-RU   | 填 `mru_support_20mhz` 能力位、下发 small/large MRU 开关     | 组合 RU 调度给多个用户        | 每帧的 RU 组合调度 |

这张表就是本文「边界声明」的落点：WiFi 7 主机侧代码里，凡是涉及 PHY 物理过程的特性，主机都只做「宣告能力 + 下发开关 + 事后统计」，**真正的调制、带宽、打孔、组合调度全在固件/硬件**。读者如果带着「主机代码里应该有打孔算法」的预期去搜源码，会扑个空——那不是代码缺失，是架构上就不该在主机。

---

# 9 终篇：贯穿全系列的架构思想

走到这里，MLD 管理面的完整拼图已经合上了：ML IE 解析捆链路（§2）、link switch 换链路（§3）、link reconfig 增删链路（§4）、peer 跨链路同步（§5）、模式协商与能力位协商（§6-8）。管理面在主机、执行面在固件的边界，在每一节里反复出现——它不是某个模块的偶然选择，而是贯穿整个 WiFi 7 代码库的架构铁律。

这一路追下来，有几条设计思想不是某一篇的结论，而是贯穿全系列的「地基」。它们在不同的代码世界里反复出现，换了一身衣服，骨子里是同一件事：

**第一，分层哲学：Framework 重控制，supplicant 供能力，驱动固件执行。** Android WiFi 的三层（其实是五层）各司其职——Framework 管策略（要不要连、连哪个、什么时候省电），supplicant 管协议（认证、关联、漫游的标准逻辑），驱动固件管执行（帧怎么发、链路怎么切、射频怎么调）。这条分界线在扫描、连接、漫游、MLO 里一次次出现。本文的「管理面在主机、执行面在固件」只是它在一个新特性上的最新投影——不是新思想，是旧思想的新案例。

**第二，QCOM 固件卸载 vs MTK 主机重活：同一个答案，两种路径。** QCOM 是 Soft-MAC + offload，主机侧维护完整状态机（`wlan_eht_mode`、link switch/recfg SM、T2LM SM），固件执行；MTK 是 Full-MAC，能力打散渗透进 AIS/SAA FSM（`CFG_SUPPORT_802_11BE_MLO`），固件自主决策更多。但两家在「实时决策下沉固件」这个最终结论上完全一致——链路选择、打孔决策、组合调度，全在固件。**路径不同，落点相同**：因为时间尺度的物理约束对两家是同一条铁律。

**第三，能力位协商 vs 实现：主机是「宣告者」，不是「实现者」。** 从 320 MHz、4K QAM 到 puncturing、Multi-RU，主机代码里的角色永远是「把能力位填进 IE、把开关下发固件、把结果读回来统计」，从不碰调制、打孔、调度的实现。这不是主机偷懒，而是 PHY 物理过程的实现天然属于硬件。理解了这个，才能在源码里一眼分清「这段代码是真逻辑还是转发壳」（比如 `mlo_link_recfg_notify` 的空壳函数体——那不代表功能缺失，代表真正的逻辑在 scheduler 消息处理器里）。

这三条思想，合起来就是一句话：**WiFi 是分层的，每一层的代码厚度，由它离「微秒级物理世界」的距离决定**——离得越近（固件/PHY），代码越「执行」；离得越远（Framework），代码越「决策」。WiFi 7 的 MLD 架构，不过是这句话在「多链路」这个新维度上的一次完整演绎。

---

# 写在最后

这一篇补上了 MLO 的另一半——数据面（帧走哪条链路）讲完，管理面（链路本身怎么建立、切换、重配、拆解，本文）收口，WiFi 7 的 MLO 故事才算完整：**数据面是固件在微秒级选链路，管理面是主机在毫秒级管链路**，两个时间尺度，两种代码位置，同一个 MLD 架构。

而穿插的 320 MHz / 4K QAM / puncturing / Multi-RU，则补上了 WiFi 7 的另一条线索：**主机代码的「薄」不是缺功能，而是 PHY 物理过程本就不属于主机**。看懂这条边界，是读懂 WiFi 7 驱动代码的最后一块拼图。

从一个 WiFi 开关的点击，走到 MLD 架构的管理面。系列到此收官。

**本章干货速查**：

| 主题                  | 核心机制               | QCOM                                                         | MTK                                                          |
| --------------------- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| ML IE 解析            | 把三条链路捆成一个 MLD | `struct wlan_mlo_dev_context`（vdev 数组）                   | `mldParseBasicMlIE` / `mldParseReconfigMlIE` + `struct MULTI_LINK_INFO` |
| Link switch           | 无损换链路             | 七态状态机 + `mlo_mgr_link_switch_start_connect` → `wlan_cm_start_connect` | 渗透在 AIS FSM，`mldUpdatePerLinkMlo` 下发                   |
| Link reconfig         | 增删链路               | 9 主态 + 11 子态状态机（`wlan_mlo_link_recfg.c` 7013 行）    | `mldParseReconfigMlIE` 解析 + Reconfig 变体校验              |
| Peer 管理             | 跨链路同步             | `wlan_mlo_peer_create` + 三态 `mlo_peer_state`               | `struct MLD_STA_RECORD` + `mldBssAddClient`                  |
| 320 MHz / 4K QAM      | 只宣告不实现           | `struct wlan_eht_cap_info` + `CH_WIDTH_320MHZ`               | `ehtRlmFillBW80MCSMap` + `EHT_MAX_BW_320`                    |
| Puncturing / Multi-RU | 主机不可见             | 静态位图转发 + `cdp_punctured_modes`                         | MIB 计数器（决策在硬件）                                     |

---

**协议依据**：`IEEE 802.11be-2024`

- §9.4.2.322 Multi-Link element（§9.4.2.322.2 Basic、§9.4.2.322.4 Reconfiguration）
- §9.4.2.323 EHT Capabilities element（§9.4.2.323.3 EHT PHY Capabilities Information，Figure 9-1074aq）
- §9.4.2.323.4 Supported EHT-MCS And NSS Set
- §35.3 Multi-link operation（§35.3.2 MLD addressing
- §35.3.6 ML reconfiguration、§35.3.7.2 TTLM
- §35.3.17 EMLSR、§35.3.18 EMLMR）
- §35.15.2 Preamble puncturing operation
- §35.16 EPCS priority access
- §36.3.2.2.2-2.2.3 Small/Large size MRUs
- §36.3.12.11 EHT preamble of preamble punctured EHT MU PPDU
- §36.3.24.2 Channelization for 320 MHz channel
- §36.5 Parameters for EHT-MCSs

**源码出处**：

- QCOM [qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn)、[qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0)
- MTK [kernel_modules-connectivity-wlan-core-gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)
