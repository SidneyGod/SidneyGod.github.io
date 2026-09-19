---
title: SAP（四）当老板——共存、驱动与运维
top: 1
related_posts: true
abbrlink: 8eed37c1
date: 2026-09-19 21:37:37
tags:
  - Android WiFi
  - SAP
categories:
  - WiFi
  - Code
---

> 本文是 SAP 热点系列第四篇。前三篇讲了 Framework 层启动（第一篇）、hostapd 启动与 Beacon 上线（第二篇）、AP 侧 Auth/Assoc/四次握手（第三篇）。本篇讲运营：手机既是热点又是 WiFi 客户端时怎么共存？QCOM 和 MTK 两家驱动怎么管理 AP 状态机？客人走了怎么办？以及出问题时怎么从四层日志定位根因。
>
> 核心看点：DBDC 双频并发下的信道冲突、QCOM SAP FSM 四状态分派 vs MTK 复用 P2P Role FSM、异步回调转同步等待的 qdf_wait_single_event 模式、客户端离开的三种路径（自己走/被踢/空闲关）。

---

# 1 当老板的烦恼

沙漠民宿开起来了，Beacon 已经挂上，客户端也陆续入住。但这只是开始——真正的挑战在你运营起来之后才会浮现。

第一个烦恼：你想当老板接待客人，但你自己也是个"客人"——手机还连着家里 WiFi 呢。同一部手机，既要接收 STA 端的下行数据，又要发送 AP 端的 Beacon，只有一套射频硬件，怎么办？这是共存管理的世界。

<!--more-->

第二个烦恼：民宿规模大了，要管两套班子。不同的"物业公司"（芯片厂商）管民宿的方式完全不同——QCOM 有自己专门的 SAP 状态机，MTK 则把 AP 状态机嫁接在 P2P 上。你了解它们的套路，才知道出问题时从哪入手。

第三个烦恼：客人不会永远住下去。有人自己走了（客户端主动 Deauth），有人你不得不赶（不活跃踢掉），还有人走了你得考虑是不是打烊算了（空闲超时关闭）。三种离开，三种处理。

第四个烦恼：东西坏了怎么修。Beacon 发不出去？客户端连不上？四次握手卡住了？你需要知道每一层的日志长什么样，才能快速定位到哪一层的哪个函数出了问题。

本篇就从这四个烦恼出发，讲 SAP 的运营、驱动和运维。

---

# 2 共存管理：STA + AP 的双重生活

打开热点时，如果手机还连着 WiFi（STA 模式），两个角色同时运行。用民宿的话说：你既是住客（STA 连着家里的 WiFi），又是老板（AP 给别人开热点）——但酒店只有一间前台，两个身份要轮流用。这时出现了一个现实问题：手机只有一套射频硬件，要同时做"客人"和"老板"，怎么办？

## 2.1 DBDC 和 MCC/SCC

DBDC 的本质是让一套硬件同时演两个角色——好比一个人既要当前台接待（AP），又要当快递员收发包裹（STA），关键在于有没有两条独立的腿（射频链路）可以同时跑。

Android 官方架构支持 DBDC（Dual Band Dual Concurrent）：wlan0（STA）+ wlan1（AP）两个独立接口，wiphy 支持 2 个并发 channel contexts。高通叫 DBS（Dual Band Simultaneous），MTK 叫 DBDC，是同一回事。

但硬件不是总支持真正双频并发。很多中低端芯片只有一个射频链路，只能在两个信道上分时切换，这叫 MCC（Multi-Channel Concurrency）。

MCC 意味着 STA 和 AP 各丢失大约一半的 airtime，性能退化严重。Framework 层有两个缓解策略：

1. **SCC（Same Channel Concurrency）**：如果 STA 连在信道 6 上，AP 也切到信道 6。两者在同一信道，不存在切换开销。`CoexManager` 负责监控不安全信道列表，触发 AP 信道切换。

2. **DBS（Dual Band Simultaneous）**：AP 自动切到另一个频段。比如 STA 占 2.4GHz 信道 6，AP 就上 5GHz 信道 36。两者在不同频段，各自占用独立射频链路，互不干扰。

在 QCOM 的 `sap_goto_starting()` 中可以看到相关逻辑：

```c
// QCOM core/sap/src/sap_fsm.c:3199
if (policy_mgr_concurrent_beaconing_sessions_running(mac_ctx->psoc)) {
    // 如果已有 AP 在做 ACS 且选了 DFS 信道，覆盖新 AP 的信道选择
    con_ch_freq = sme_get_beaconing_concurrent_operation_channel(
            mac_handle, sap_ctx->sessionId);
    if ((!policy_mgr_is_hw_dbs_capable(mac_ctx->psoc) || ...) && con_ch && ...) {
        sap_ctx->chan_freq = con_ch_freq;
    }
}
```

不支持 DBS 时，第二个 AP 强制跟第一个 AP 同信道——这就是 SCC 强制逻辑在驱动层的体现。

但信道切换不是瞬间完成的——AP 切走之前，已关联的客户端怎么办？802.11 定义了 CSA（Channel Switch Announcement）机制：AP 在 Beacon 帧中携带 Channel Switch Announcement IE（802.11-2024 Section 9.4.2.19），客户端收到后在倒计时归零时自动跟随 AP 切换到新信道。

这个搬迁通知在 802.11 中有个正式名字：CSA IE，包含三个标准字段：Channel Switch Mode（1 字节，值为 1 表示客户端应停止发送）、New Channel Number（1 字节，目标信道号）、Channel Switch Count（1 字节，倒计时 Beacon 数）。AP 在连续若干个 Beacon 中重复携带这个 IE，客户端每收到一个就更新倒计时——归零那一刻就是切换时刻。

QCOM 驱动中，CSA 有两条触发路径。第一条是共存安全信道检查：`sap_fsm_handle_check_safe_channel()`（`sap_fsm.c:3616`）在 CAC 期间检测到当前信道不安全时，调用 `wlansap_set_channel_change_with_csa()`（`sap_module.c:1589`）切换到安全信道。

```c
// QCOM core/sap/src/sap_fsm.c:3616
static void sap_fsm_handle_check_safe_channel(struct mac_context *mac_ctx,
                                              struct sap_context *sap_ctx)
{
    qdf_freq_t target_chan_freq;
    enum phy_ch_width target_bw = sap_ctx->ch_params.ch_width;

    // 如果信道已被标记为不安全（policy_mgr 黑名单），才触发切换
    if (policy_mgr_is_sap_freq_allowed(mac_ctx->psoc, sap_ctx->chan_freq))
        return;  // 信道安全，无需处理

    // 从安全信道列表中选取目标信道
    target_chan_freq = sap_get_safe_channel_freq(sap_ctx);
    sap_debug("sap vdev %d change to safe ch freq %d from unsafe %d",
              sap_ctx->sessionId, target_chan_freq, sap_ctx->chan_freq);
    // 通过 CSA 机制切换——在 Beacon 中携带 Channel Switch Announcement IE
    wlansap_set_channel_change_with_csa(
            sap_ctx, target_chan_freq, target_bw, false);
}
```

逻辑很直白：先查 `policy_mgr_is_sap_freq_allowed()` 判断当前信道是否在共存黑名单中，命中则调 `sap_get_safe_channel_freq()` 选一个安全信道，最后走 CSA 切换。回到民宿现场——前台发现你选的房间有安全隐患（信道被标记不安全），立刻帮你换一间，同时在告示栏贴个搬迁通知（CSA IE）让其他客人知道。

第二条是 DFS 雷达检测后的被动切换，由雷达 handler `wlansap_roam_process_dfs_radar_found()`（`sap_api_link_cntl.c:725`）在 SAP_STARTED 态投递 `eSAP_DFS_CHNL_SWITCH_ANNOUNCEMENT_START` 事件触发。调用链更长：`sap_fsm_send_csa_restart_req()`（`sap_fsm.c:3575`）先通过 `policy_mgr_check_and_set_hw_mode_for_channel_switch()` 检查是否需要切换 DBS/MCC 硬件模式，确认无需切换或切换完成后，调用 `sme_csa_restart()`（`sme_api.c:8279`）→ `csr_csa_restart()`（`csr_api_roam.c:7173`）→ 投递 `eWNI_SME_CSA_RESTART_REQ` 到 PE 层，PE 最终将 CSA IE 注入 Beacon 并开始倒计时。

```c
// QCOM core/sap/src/sap_fsm.c:3575
sap_fsm_send_csa_restart_req(struct mac_context *mac_ctx,
                             struct sap_context *sap_ctx)
{
    QDF_STATUS status;

    // 第一步：检查是否需要切换硬件模式（DBS/MCC）
    status = policy_mgr_check_and_set_hw_mode_for_channel_switch(
                    mac_ctx->psoc, sap_ctx->sessionId,
                    mac_ctx->sap.SapDfsInfo.target_chan_freq,
                    POLICY_MGR_UPDATE_REASON_CHANNEL_SWITCH_SAP);

    if (status == QDF_STATUS_E_FAILURE) {
        sap_err("HW change required but failed to set hw mode");
        return status;  // 硬件模式切换失败，中止 CSA
    }

    if (QDF_IS_STATUS_SUCCESS(status)) {
        sap_info("Channel change will continue after HW mode change");
        return QDF_STATUS_SUCCESS;  // 硬件模式切换已请求，等回调继续
    }

    // 第二步：硬件模式无需切换（或已是目标模式），直接发起 CSA
    return sme_csa_restart(mac_ctx, sap_ctx->sessionId);
}
```

这段代码体现了 QCOM CSA 的两阶段设计：先确认硬件射频配置（DBS 是否需要切换、MCC 分时是否需要调整），再发起 CSA。如果硬件模式切换本身就失败了（`QDF_STATUS_E_FAILURE`），CSA 直接中止——因为切信道的前提是射频链路能支持目标频段。如果硬件模式切换成功（`QDF_STATUS_SUCCESS`），则等硬件模式切换完成的回调后再继续 CSA 流程——回调会重新调用 `sap_fsm_send_csa_restart_req()`，此时 `policy_mgr_check_and_set_hw_mode_for_channel_switch()` 返回 `QDF_STATUS_E_NOSUPPORT`（无需切换），走到最后的 `sme_csa_restart()` 分支。

搬迁通知贴几张、客人什么时候停手——这两个细节由 INI 配置决定：`g_sap_chanswitch_beacon_cnt` 默认 10（范围 1-10，定义在 `cfg_mlme_sap.h:343`），表示在多少个 Beacon 内携带 CSA IE；`g_sap_chanswitch_mode` 默认 1，表示切换前客户端应停止发送数据。

MCC 场景下还有个"排班"问题：STA 和 AP 各占多少时间？QCOM 通过 `QCA_NL80211_VENDOR_SUBCMD_MCC_QUOTA` vendor command（subcmd 205）暴露了这个接口，允许用户态设置分时比例。下发路径是一条四层调用链：

```c
// 用户态 → HDD → SME → WMA → 固件
wlan_hdd_cfg80211_set_mcc_quota()       // wlan_hdd_mcc_quota.c:85
  // 解析 NL 属性，存入 user_mcc_quota 结构体
  // （wlan_mlme_public_struct.h:1305，含 vdev_id、op_mode、quota）
  → wlan_hdd_send_mcc_vdev_quota()      // wlan_hdd_main.c:19605
    → sme_cli_set_command(vdev_id,
         WMA_VDEV_MCC_SET_TIME_QUOTA,
         duty_cycle, VDEV_CMD)
      → wma_set_mcc_channel_time_quota() // wma_data.c:1218
        // 将信道号和 quota 比例打包成 WMI 命令发给固件
```

需要注意的是，`wlan_hdd_cfg80211_set_mcc_quota()` 目前仅支持 `P2P_GO_MODE`（`op_mode` 不匹配时返回 `-EOPNOTSUPP`）。SAP 模式的 MCC quota 走另一条路径：`wlan_hdd_apply_user_mcc_quota()`（`wlan_hdd_mcc_quota.c:222`）在 MCC 场景建立时自动应用——它读取已存储的 `user_mcc_quota`，关闭 MCC 自适应调度（`wlan_hdd_set_mcc_adaptive_sched(false)`），再走同一条 `wlan_hdd_send_mcc_vdev_quota()` 路径下发固件。

MTK 的 CSA 路径不同——它不依赖 Beacon 中的 CSA IE，而是直接向每个已关联客户端发送 Action 帧（Category=SPEC_MGT（Category 0, 802.11-2024 Table 9-81）, Action=CHNL_SWITCH（Action 4, Section 9.6.2））。`rlmSendChannelSwitchFrame()`（`rlm.c:11327`）遍历 BSS 的客户端列表，对每个支持 ECSA 的客户端调用 `__rlmSendChannelSwitchFrame()` 构造并发送 Channel Switch Action 帧。

发送完成后，`p2pRoleFsmRunEventCsaDone()`（`p2p_role_fsm.c:2501`）执行实际的信道切换——通过 `p2pCsaControlFlow()` 停止当前 BSS、重新请求 CNM 信道分配、再激活 BSS。整个 CSA 过程有 7 秒超时保护（`DEFAULT_P2P_CSA_TIMEOUT_MS`，`p2p.h:92`），超时则由 `rlmCsaTimeout()`（`rlm.c:6858`）兜底——和正常 CSA 流程不同，超时路径不停止 BSS 也不重新请求 CNM 信道，而是直接更新 BSS 信道参数（primary channel、band、VHT BW）并调用 `rlmSyncOperationParams()` 同步到固件。

CSA 解决的是"主动切信道"的问题，但还有一种更被动的场景：DFS 信道上检测到雷达信号。802.11-2024 Section 10.9.4 要求，DFS 信道上检测到雷达后，AP 必须在规定时间内停止在该信道发射，并将该信道加入 NOL（Non-Occupancy List，雷达禁用列表）——被标记的信道在接下来 30 分钟内不允许再次使用（`DFS_NOL_TIMEOUT_S = 30*60`，定义在 `dfs.h:769`）。把这套流程搬进民宿就是——某个房间发现了安全隐患（雷达信号），不仅要立刻疏散（信道切换），还要贴封条 30 分钟（NOL 禁用期），期间不能安排新客人入住。

QCOM 的雷达处理链路是：固件检测到雷达脉冲后，向 host 发送 DFS radar event，SAP 向 HDD 上报 `eSAP_DFS_RADAR_DETECT` 事件，同时向 FSM 投递 `eSAP_DFS_CHANNEL_CAC_RADAR_FOUND` 事件。在 CAC 期间检测到雷达时，`sap_fsm_handle_radar_during_cac()`（`sap_fsm.c:3393`）遍历所有正在运行的 SAP/P2P GO 实例，对每个工作在 DFS 信道上调用 `wlansap_channel_change_request()` 触发信道切换——切换目标已由 `sap_indicate_radar()`（`sap_fsm.c:4506`）提前选定。同时 `sap_radar_found_status` 标志置 true，表示当前信道已有雷达记录。

NOL 的管理由 UMAC DFS 模块负责：`dfs_nol_addchan()`（`dfs_nol.c:400`）将被标记的信道频率和检测时间写入 NOL 链表，每个条目带 30 分钟定时器，到期自动移除。SAP 重新启动时，`sap_validate_dfs_nol()` 通过 `utils_dfs_is_freq_in_nol()` 检查目标信道是否在 NOL 中——命中则直接拒绝，避免在刚检测到雷达的信道上重新开 AP。

MTK 的路径不同。固件检测到雷达后，CNM 模块的 `cnmRadarDetectEvent()`（`cnm.c:1035`）构造 `MSG_P2P_RADAR_DETECT` 消息、以 `MID_CNM_P2P_RADAR_DETECT` 消息 ID 投递到 MBOX，`p2pRoleFsmRunEventRadarDet()`（`p2p_role_fsm.c:2251`）处理。如果当前状态是 `P2P_ROLE_STATE_DFS_CAC`（CAC 等待中），先转回 `P2P_ROLE_STATE_IDLE`，然后调用 `kalP2PRddDetectUpdate()` 更新 NOL 记录，启动 5 秒关闭定时器（`rDfsShutDownTimer`）。

信道选择在驱动层完成：`rlmDomainGetChnlList()` 获取 5GHz 可用信道列表，`p2pFuncChannelListFiltering()` 过滤掉当前信道和不兼容带宽的信道，然后随机选取一个新信道。如果 AP 已经在发射（`IS_NET_PWR_STATE_ACTIVE`），调用 `cnmSapChannelSwitchReq()` 执行 CSA 切换；如果 AP 尚未启动（还在 CAC 阶段），则调用 `p2pRoleFsmRunEventStartAP()` 在新信道上重新启动 AP。和 QCOM 相比，MTK 的信道选择在驱动层完成（QCOM 由固件/UMAC DFS 模块处理），NOL 的 30 分钟禁用机制由固件侧的 domain info 管理而非 host 驱动。

![DBDC、MCC、SCC 三种共存模式对比：DBDC 双频独立射频链路并发，MCC 单射频分时切换，SCC 同信道无切换开销](assets/10d-SAP%EF%BC%88%E5%9B%9B%EF%BC%89%E5%BD%93%E8%80%81%E6%9D%BF%E2%80%94%E2%80%94%E5%85%B1%E5%AD%98%E3%80%81%E9%A9%B1%E5%8A%A8%E4%B8%8E%E8%BF%90%E7%BB%B4/10d-DBDC-MCC-SCC%E5%85%B1%E5%AD%98%E6%A8%A1%E5%BC%8F.svg)

共存管理的本质，是让一套射频硬件在"当客人"和"当老板"之间找到平衡——DBDC 是两头都顾上，SCC 是搬到同一层楼省得两头跑，MCC 是轮流值班但两边都得等。信道切换（CSA）和雷达避让（DFS/NOL）则是运营中不可避免的应急处理——出了事得有能力迅速搬迁，还得有封条机制防止同一间房反复出问题。

## 2.2 Band Steering 和 BTM

这两种技术是 AP 侧的"客户导流"手段：

- **Band Steering**（频段引导）：AP 在 2.4GHz 侧抑制 Probe Response（不回复或延迟回复），引导客户端优先选 5GHz。hostapd 标准实现不包含独立的 band steering 模块——通常由驱动层或 vendor 扩展实现（如 QCOM 的 `policy_mgr` 模块在 `sap_fsm` 启动时检查双频并发能力，间接影响信道选择策略）。
- **BTM（BSS Transition Management，802.11v）**：AP 发 BTM Request 帧，建议客户端切换到另一个 BSS（比如信号更好的 AP）。hostapd 中 `wnm_send_bss_tm_req()`（`wnm_ap.c:959`）构造 BTM Request 帧，`req_mode` 参数的 `WNM_BSS_TM_REQ_DISASSOC_IMMINENT` 位决定是"建议"（客户端可以忽略）还是"强制"（带 disassoc 倒计时）；`nei_rep` 携带 Candidate List 告诉客户端该漫游到哪个 AP。`hostapd_ctrl_iface_bss_tm_req()`（`ctrl_iface_ap.c`）是控制接口入口，允许通过 `hostapd_cli bss_tm_req` 手动触发。

BTM 的完整交互流程在 STA 漫游章节有详细分析，此处只关注 AP 侧的发起逻辑。Band Steering 和 BTM 一个是"暗中引导"（抑制 2.4G 回复），一个是"明文建议"（发 BTM Request），本质上都是 AP 侧的客户导流——就像民宿老板根据楼层入住率，悄悄把新客人往空房多的楼层引。

---

# 3 驱动层：QCOM vs MTK AP 模式

民宿要运营，得有人管。QCOM 和 MTK 就像两套完全不同的物业班子：QCOM 是大型连锁酒店集团，有一套标准化的 SAP 状态机，从 INIT 到 STARTING 到 STARTED，每一步都有明确的 SOP；MTK 则像灵活的精品民宿管理——没有专门的 AP 状态机，而是把 AP 事务交给 P2P 团队兼管，通过 `OP_MODE_ACCESS_POINT` 标志区分"正式住客"和"民宿客人"。两套班子都能把民宿管好，但出问题时排查思路完全不同。

## 3.1 QCOM SAP FSM

### 3.1.1 入口：wlansap_start_bss 与状态机

QCOM 的 SAP 启动从 `wlansap_start_bss()` 开始：

```c
// QCOM core/sap/src/sap_module.c:787
QDF_STATUS wlansap_start_bss(struct sap_context *sap_ctx,
                             sap_event_cb sap_event_cb,
                             struct sap_config *config, void *user_context)
{
    struct sap_sm_event sap_event;
    // 设置初始状态
    sap_ctx->fsm_state = SAP_INIT;
    // 解析加密 IE → 设置 vdev crypto params
    wlan_set_vdev_crypto_params_from_ie(sap_ctx->vdev, ...);
    // 信道 / DFS / ACS 配置
    sap_ctx->chan_freq = config->chan_freq;
    sap_ctx->dfs_mode = config->acs_dfs_mode;
    // ACL 配置
    sap_ctx->eSapMacAddrAclMode = config->SapMacaddr_acl;
    // 构建事件，触发 FSM
    sap_event.event = eSAP_HDD_START_INFRA_BSS;
    qdf_status = sap_fsm(sap_ctx, &sap_event);
}
```

SAP FSM 有四个状态——`SAP_INIT`（预约登记）、`SAP_STARTING`（办理入住）、`SAP_STARTED`（入住完成）、`SAP_STOPPING`（退房）——这就是连锁酒店的标准入住 SOP，由 `sap_fsm()` 函数做统一分派：

```c
// QCOM core/sap/src/sap_fsm.c:4001
switch (state_var) {
case SAP_INIT:
    qdf_status = sap_fsm_state_init(sap_ctx, sap_event, mac_ctx, mac_handle);
    break;
case SAP_STARTING:
    qdf_status = sap_fsm_state_starting(sap_ctx, sap_event, mac_ctx, mac_handle);
    break;
case SAP_STARTED:
    qdf_status = sap_fsm_state_started(sap_ctx, sap_event, mac_ctx);
    break;
case SAP_STOPPING:
    qdf_status = sap_fsm_state_stopping(sap_ctx, sap_event, mac_ctx, mac_handle);
    break;
}
```

### 3.1.2 sap_goto_starting：信道校验与并发

`wlansap_start_bss()` 把 `fsm_state` 设为 `SAP_INIT`，然后投递 `eSAP_HDD_START_INFRA_BSS` 事件。`sap_fsm_state_init()` 收到这个事件后，先调用 `sap_init_dfs_channel_nol_list()` 初始化 DFS 雷达禁用列表（NOL），再调用 `sap_validate_chan()` 校验信道合法性——如果目标信道在 NOL 中（之前检测到过雷达），直接拒绝。校验通过后进入 `sap_goto_starting()`。

`sap_goto_starting()` 是从 `SAP_INIT` 到 `SAP_STARTING` 的核心过渡函数，约 150 行，逻辑分三层。第一层是 NOL 和 6GHz 校验：非 6GHz 信道调用 `sap_validate_dfs_nol()` 检查是否在雷达禁用期内；6GHz 信道则检查驱动是否支持 6GHz AP 能力。第二层是并发信道覆盖——这段逻辑在第 2 章共存管理中已经见过：

```c
// QCOM core/sap/src/sap_fsm.c:3199
if (policy_mgr_concurrent_beaconing_sessions_running(mac_ctx->psoc)) {
    con_ch_freq = sme_get_beaconing_concurrent_operation_channel(
            mac_handle, sap_ctx->sessionId);
    // 不支持 DBS 且第二 AP 在 5G → 强制跟第一 AP 同信道
    if ((!policy_mgr_is_hw_dbs_capable(mac_ctx->psoc) || ...) && con_ch && ...) {
        sap_ctx->chan_freq = con_ch_freq;
    }
}
```

第三层是状态转换和下发：`fsm_state` 切到 `SAP_STARTING`，设置 CAC 时长和 DFS 区域参数，构建 `bss_dot11_config` 结构体（包含信道、PHY 模式、速率集、加密参数），最后调用 `sme_start_bss()` 下发到 SME 层。

### 3.1.3 命令序列化与固件下发

`sme_start_bss()` → `csr_bss_start()` 把命令打包成 `wlan_serialization_command`，通过 `wlan_vdev_mlme_ser_start_bss()` 投递到序列化队列——相当于连锁酒店的前台排队叫号，STA 连接和 SAP 启动的命令在这里排队串行化，确保同一个 vdev 上不会有多个 START_BSS 命令并发执行。序列化引擎调度命令到 PE（Protocol Engine）层，PE 最终通过 WMI 接口将 BSS 配置下发到固件。

### 3.1.4 BSS 启动成功与同步等待

固件完成 BSS 创建后，PE 向 SME 发送 `eWNI_SME_START_BSS_RSP`，CSR 层将其转换为 roam event 回传给 SAP FSM。此时 `sap_fsm_state_starting()` 收到 `eSAP_MAC_START_BSS_SUCCESS` 事件：

```c
// QCOM core/sap/src/sap_fsm.c:3674
if (msg == eSAP_MAC_START_BSS_SUCCESS) {
    sap_check_and_update_vdev_ch_params(sap_ctx);
    sap_ctx->fsm_state = SAP_STARTED;  // ← 状态转换
    sap_debug("sap_fsm: vdev %d: SAP_STARTING => SAP_STARTED, freq %d ch_width %d",
              sap_ctx->vdev_id, sap_ctx->chan_freq,
              sap_ctx->ch_params.ch_width);
    // 通知 HDD 层
    sap_signal_hdd_event(sap_ctx, roam_info,
                         eSAP_START_BSS_EVENT, (void *) eSAP_STATUS_SUCCESS);
    // 如果是 DFS 信道，启动 CAC 等待（状态回退到 SAP_STARTING）
    // 实际调用链：sap_fsm_cac_start() → sap_start_dfs_cac_timer(sap_ctx)
}
```

注意这段代码是简化呈现。实际的 DFS CAC 检查在 `sap_fsm_state_starting()` 的 `eSAP_MAC_START_BSS_SUCCESS` 分支内：BSS 创建成功后，状态先从 `SAP_STARTING` 转到 `SAP_STARTED`（标记 BSS 已就绪）；随后检查 DFS 信道条件，若需要 CAC 则将状态再回退到 `SAP_STARTING`，调用 `sap_fsm_cac_start()` 启动 60 秒雷达检测定时器（`sap_fsm.c:3325`）。CAC 完成后才再次进入 `SAP_STARTED`。

但启动过程不是只有"成功"和"超时"两种结局。`sap_fsm_state_starting()` 还要处理一个更现实的场景：用户在 AP 启动过程中快速关闭热点——固件还在创建 BSS，Framework 层已经发了 stop 请求。这时 `sap_fsm_handle_start_failure()`（`sap_fsm.c:3447`）接管：如果收到的是 `eSAP_HDD_STOP_INFRA_BSS`，先停 CAC 定时器（单 AP 场景直接停，多 AP 场景检查是否还有其他活跃会话），然后 SAP_STARTING → SAP_STOPPING，调用 `sap_goto_stopping()`（`sap_fsm.c:1739`）下发 `sme_roam_stop_bss()` 回滚已创建的 BSS 资源；如果是其他类型的失败（比如固件返回错误），则直接 SAP_STARTING → SAP_INIT，通过 `sap_signal_hdd_event()` 通知 HDD 启动失败（`eSAP_STATUS_FAILURE`）。回到民宿前台——正在办理入住但客人突然说不住了，先把已经铺好的床撤了（stop BSS），再把房间恢复到空闲状态（SAP_STOPPING → SAP_INIT）。

`sap_signal_hdd_event()` 将事件封装成 `sap_event` 结构体，通过 `sap_ctx->sap_event_cb()` 调用注册的回调——这就是 `hdd_hostapd_sap_event_cb()`。HDD 层收到 `eSAP_START_BSS_EVENT` 后，设置 `hostapd_state->bss_state = BSS_START`（标记 AP 已启动），注册广播 STA 和流控机制，设置 `SOFTAP_BSS_STARTED` 事件位，并发送 `"SOFTAP.enabled"` 自定义事件通知上层。

关键一步：回调末尾调用 `qdf_event_set(&hostapd_state->qdf_event)`——这唤醒了 `wlan_hdd_cfg80211_start_bss()` 中 `qdf_wait_single_event()` 的阻塞等待（`wlan_hdd_hostapd.c:6792`）。HDD 层用 `qdf_wait_single_event` 同步等待机制把异步的 FSM 回调"转同步"：就像前台把入住材料递给客房部后，必须等经理签字确认才能把房卡交给客人——`wlansap_start_bss()` 触发 FSM 后立即返回，但 `wlan_hdd_cfg80211_start_bss()` 会阻塞直到回调到来，确保 cfg80211 的 `.start_ap` 操作在 BSS 真正启动后才返回成功。

阻塞等待有明确的超时保护。`SME_CMD_START_BSS_TIMEOUT` 的计算链是：`START_RESPONSE_TIMER`（固件 vdev start 超时，默认 8000ms，定义在 `wlan_vdev_mgr_tgt_if_rx_defs.h:95`）+ 2000ms（`SME_CMD_VDEV_START_BSS_TIMEOUT`，留给序列化引擎调度）+ 1000ms（`SME_CMD_START_BSS_TIMEOUT`，留给 HDD 层回调），合计约 11 秒。

超时后的处理路径在 `wlan_hdd_hostapd.c:6797`：检查 `qdf_status` 和 `hostapd_state->qdf_status` 两个状态——前者是等待本身的超时（事件没回来），后者是 FSM 回调携带的业务错误码（事件回来了但带的是失败）。无论哪种失败，清理路径相同：先调 `wlansap_stop_bss()` 回滚已创建的 BSS，再返回 `-EINVAL` 给 cfg80211。但断言逻辑不同——`cds_is_driver_recovering()` 为 false（正常运行时）触发 `QDF_ASSERT(0)` 记录调用栈并上报 bug，因为正常运行中超时不应该发生；为 true（SSR 恢复期间）则跳过断言，因为驱动正在重启，固件无响应是预期行为。换成民宿的语境——正常营业时前台等不到经理签字，必须上报故障；但如果是酒店正在检修（SSR），等不到回复就不用大惊小怪——先把客人请出去（`wlansap_stop_bss` 回滚），等检修完再重新开业。

类似的同步等待模式也用于 `stop_bss`（超时 `SME_CMD_STOP_BSS_TIMEOUT` ≈ 12 秒，计算链：`SME_CMD_STOP_BSS_CMD_TIMEOUT`（`STOP_RESPONSE_TIMER` 6000ms + `SIR_DELETE_STA_TIMEOUT` 4000ms + 1000ms = 11 秒）+ 1000ms），超时后同样区分 recovery/non-recovery 路径。

至此，QCOM 驱动侧的 AP 启动链路完成——从用户态的 `wlan_hdd_cfg80211_start_ap()` 到固件的 BSS 创建，再通过事件回调链回到 HDD 层设置启动状态，整个过程是"异步执行、同步返回"。

```c
// QCOM core/hdd/src/wlan_hdd_hostapd.c:7978
int wlan_hdd_cfg80211_start_ap(struct wiphy *wiphy,
                               struct net_device *dev,
                               struct cfg80211_ap_settings *params)
{
    int errno;
    struct osif_vdev_sync *vdev_sync;
    errno = osif_vdev_sync_op_start(dev, &vdev_sync);
    if (errno) return errno;
    errno = __wlan_hdd_cfg80211_start_ap(wiphy, dev, params);
    osif_vdev_sync_op_stop(vdev_sync);
    return errno;
}
```

这段代码是 cfg80211 `.start_ap` ops 的最外层入口。`osif_vdev_sync` 机制确保同一个 net_device 上不会有两个 ops 并发执行——如果 STA 连接和 SAP 启动的 cfg80211 调用同时到达，后者会在这里排队等待。真正的业务逻辑在 `__wlan_hdd_cfg80211_start_ap()` 中，它最终调用前面分析的 `wlansap_start_bss()` 触发整个 FSM 链路。

在 QCOM 驱动调到 `wlansap_start_bss()` 之前，内核的 nl80211 层先完成了参数解析和分派。hostapd 通过 netlink 发送 `NL80211_CMD_START_AP` 命令，内核的 `nl80211_start_ap()`（`net/wireless/nl80211.c:5976`）负责从 netlink 消息中提取所有 AP 参数，填入 `cfg80211_ap_settings` 结构体：

```c
// kernel net/wireless/nl80211.c:5976
static int nl80211_start_ap(struct sk_buff *skb, struct genl_info *info)
{
    struct cfg80211_registered_device *rdev = info->user_ptr[0];
    struct cfg80211_ap_settings *params;
    // 必填参数校验：beacon_interval、dtim_period、beacon_head 缺一不可
    if (!info->attrs[NL80211_ATTR_BEACON_INTERVAL] ||
        !info->attrs[NL80211_ATTR_DTIM_PERIOD] ||
        !info->attrs[NL80211_ATTR_BEACON_HEAD])
        return -EINVAL;

    params = kzalloc(sizeof(*params), GFP_KERNEL);
    // 解析 Beacon 模板（head + tail + IEs）
    nl80211_parse_beacon(rdev, info->attrs, &params->beacon, ...);
    // 逐字段提取
    params->beacon_interval =
        nla_get_u32(info->attrs[NL80211_ATTR_BEACON_INTERVAL]);
    params->dtim_period =
        nla_get_u32(info->attrs[NL80211_ATTR_DTIM_PERIOD]);
    params->ssid = nla_data(info->attrs[NL80211_ATTR_SSID]);
    params->hidden_ssid =
        nla_get_u32(info->attrs[NL80211_ATTR_HIDDEN_SSID]);
    params->privacy = !!info->attrs[NL80211_ATTR_PRIVACY];
    // 信道定义（频率 + 带宽 + 中心频率）
    nl80211_parse_chandef(rdev, info, &params->chandef);
    // 所有参数就绪，分派到驱动的 .start_ap 回调
    err = rdev_start_ap(rdev, dev, params);  // → wlan_hdd_cfg80211_start_ap
}
```

QCOM 驱动在 `wlan_hdd_cfg80211.c:27293` 注册了 `.start_ap = wlan_hdd_cfg80211_start_ap`。内核通过 `rdev_start_ap()` 宏展开为 `rdev->ops->start_ap(rdev, dev, params)`，完成从内核到驱动的分派。驱动侧的 `__wlan_hdd_cfg80211_start_ap()`（`wlan_hdd_hostapd.c:7579`）从 `cfg80211_ap_settings` 中提取关键参数，写入内部的 `sap_config` 结构体：

```c
// QCOM core/hdd/src/wlan_hdd_hostapd.c:7579（简化）
static int __wlan_hdd_cfg80211_start_ap(struct wiphy *wiphy,
                                         struct net_device *dev,
                                         struct cfg80211_ap_settings *params)
{
    freq = (qdf_freq_t)params->chandef.chan->center_freq;       // 信道频率
    channel_width = wlan_hdd_get_channel_bw(params->chandef.width); // 带宽
    // 写入 sap_config 信道参数
    adapter->session.ap.sap_config.ch_params.center_freq_seg0 =
        cds_freq_to_chan(chandef->center_freq1);
    adapter->session.ap.sap_config.ch_width_orig =
        hdd_map_nl_chan_width(chandef->width);
    // 认证类型映射
    adapter->session.ap.sap_config.authType = eSAP_OPEN_SYSTEM; // 或 SHARED/AUTO
    // 最终调用 wlan_hdd_cfg80211_start_bss → wlansap_start_bss
    wlan_hdd_cfg80211_start_bss(adapter, &params->beacon,
        params->ssid, params->ssid_len, params->hidden_ssid, true);
}
```

也就是说，从 hostapd 到固件的 AP 启动链路是：hostapd `NL80211_CMD_START_AP` → 内核 `nl80211_start_ap()` 解析参数 → `rdev_start_ap()` 分派 → QCOM `wlan_hdd_cfg80211_start_ap()` 提取到 `sap_config` → `wlansap_start_bss()` → SAP FSM → SME → WMI → 固件。nl80211 层是"翻译官"——把 netlink 二进制消息翻译成驱动能理解的 `cfg80211_ap_settings` 结构体，驱动再把这个结构体"翻译"成自己的内部配置。

![QCOM SAP FSM 四状态机：SAP_INIT → SAP_STARTING → SAP_STARTED，含 DFS CAC 回退路径和 SAP_STOPPING 退房状态](assets/10d-SAP%EF%BC%88%E5%9B%9B%EF%BC%89%E5%BD%93%E8%80%81%E6%9D%BF%E2%80%94%E2%80%94%E5%85%B1%E5%AD%98%E3%80%81%E9%A9%B1%E5%8A%A8%E4%B8%8E%E8%BF%90%E7%BB%B4/10d-QCOM-SAP-FSM%E7%8A%B6%E6%80%81%E6%9C%BA.svg)

## 3.2 MTK AP 代码路径：从 cfg80211 到固件

MTK 的 gen4m 驱动使用两层架构：**conninfra** 层管理硬件资源和总线通信，**wlan FSM** 层管理状态机。AP 启动的完整调用链是：`mtk_cfg_start_ap()` → `mtk_p2p_cfg80211_start_ap()` → 消息队列 → P2P Role FSM → BSS 激活 → Beacon 模板下发固件。和 QCOM 的 `sap_fsm` 不同，MTK 没有显式的 AP FSM 状态机——它复用了 P2P Role FSM，通过 `OP_MODE_ACCESS_POINT` 标志区分 AP 和 P2P GO。

### 3.2.1 入口：mtk_cfg_start_ap

cfg80211 的 `.start_ap` 回调指向 `mtk_cfg_start_ap()`（`gl_cfg80211.c:8230`），它只做两件事：验证驱动就绪状态，确认是 P2P/AP 网络设备，然后转发给 `mtk_p2p_cfg80211_start_ap()`。

### 3.2.2 核心：参数解析与消息打包

`mtk_p2p_cfg80211_start_ap()`（`gl_p2p_cfg80211.c:1612`）是 MTK AP 启动的核心函数，约 400 行。它的逻辑分三段：

第一段，参数解析和信道覆盖。从 `cfg80211_ap_settings` 中提取信道信息，如果 `wifi.cfg` 配置了 `ucApChannel` 或 `u2ApFreq`，会覆盖 hostapd 选择的信道——这是 MTK 的"开发者优先"策略，方便调试时锁定信道：

```c
// MTK os/linux/gl_p2p_cfg80211.c:1731
if (p2pFuncIsAPMode(...)) {
    if ((prWifiVar->ucApChannel != 0) &&
        (prWifiVar->ucApChnlDefFromCfg != 0) &&
        (prWifiVar->ucApChannel != rRfChnlInfo.ucChannelNum)) {
        rRfChnlInfo.ucChannelNum = prWifiVar->ucApChannel;
        rRfChnlInfo.eBand = (rRfChnlInfo.ucChannelNum <= 14)
                            ? BAND_2G4 : BAND_5G;
    }
}
p2pFuncSetChannel(prGlueInfo->prAdapter, ucRoleIdx, &rRfChnlInfo);
```

第二段，Beacon 模板打包。分配 `MSG_P2P_BEACON_UPDATE` 消息，把 hostapd 传下来的 Beacon head（固定 IE：SSID、Supported Rates、DS Parameter Set）和 Beacon tail（可变 IE：RSN、HT/VHT/HE Capabilities）逐段拷贝到消息缓冲区。Assoc Response IE 也一并打包——驱动需要用它来构造发给客户端的 Assoc Response 帧。然后通过 `mboxSendMsg()` 投递到 MBOX 消息队列：

```c
// MTK os/linux/gl_p2p_cfg80211.c:1781
prP2pBcnUpdateMsg = cnmMemAlloc(prGlueInfo->prAdapter,
                                 RAM_TYPE_MSG, u4MsgLen);
prP2pBcnUpdateMsg->rMsgHdr.eMsgId = MID_MNY_P2P_BEACON_UPDATE;
// 拷贝 Beacon head + tail + AssocResp IE 到 aucBuffer...
mboxSendMsg(prGlueInfo->prAdapter, MBOX_ID_0,
            (struct MSG_HDR *) prP2pBcnUpdateMsg, MSG_SEND_METHOD_BUF);
```

第三段，启动 AP 消息。分配 `MSG_P2P_START_AP` 消息，填入 Beacon interval、DTIM period、Hidden SSID 类型，同样通过 `mboxSendMsg()` 投递。MTK 直接从内核传下来的 `cfg80211_ap_settings` 中读取这些参数——hostapd 通过 netlink 设置的 Beacon interval 和 DTIM period，经过内核 `nl80211_start_ap()` 解析后存入 `settings` 结构体，驱动直接取用：

```c
// MTK os/linux/gl_p2p_cfg80211.c:1875
prP2pStartAPMsg = cnmMemAlloc(prGlueInfo->prAdapter,
                              RAM_TYPE_MSG, sizeof(struct MSG_P2P_START_AP));
prP2pStartAPMsg->rMsgHdr.eMsgId = MID_MNY_P2P_START_AP;
prP2pStartAPMsg->fgIsPrivacy = settings->privacy;
prP2pStartAPMsg->u4BcnInterval = settings->beacon_interval;  // hostapd 配置的 Beacon 间隔
prP2pStartAPMsg->u4DtimPeriod = settings->dtim_period;       // hostapd 配置的 DTIM 周期
prP2pStartAPMsg->ucHiddenSsidType = settings->hidden_ssid;
prP2pStartAPMsg->ucRoleIdx = ucRoleIdx;
mboxSendMsg(prGlueInfo->prAdapter, MBOX_ID_0,
            (struct MSG_HDR *) prP2pStartAPMsg, MSG_SEND_METHOD_BUF);
```

两个消息的发送顺序很重要：Beacon 内容先到，Start AP 后到——FSM 收到 Start AP 时，Beacon 模板已经就绪。

### 3.2.3 消息处理：P2P Role FSM

MBOX 消息队列在 `hem_mbox.c` 中注册了消息 ID 到处理函数的映射：`MID_MNY_P2P_BEACON_UPDATE` → `p2pRoleFsmRunEventBeaconUpdate()`，`MID_MNY_P2P_START_AP` → `p2pRoleFsmRunEventPreStartAP()`——精品民宿的全能管家收到什么类型的工单就调对应的处理流程，不需要专门的 AP 前台。

`p2pRoleFsmRunEventBeaconUpdate()`（`p2p_role_fsm.c:4202`）收到 Beacon 模板后，调用 `p2pFuncBeaconUpdate()` 解析 IE 并存入 `BSS_INFO` 结构体。如果 AP 已经在运行（`eCurrentOPMode == OP_MODE_ACCESS_POINT`）且 BSS 已完成初始化（`eIntendOPMode == OP_MODE_NUM`），直接调用 `bssUpdateBeaconContent()` 更新空口 Beacon——这就是热更新 Beacon 的路径，不需要重启 AP。

`p2pRoleFsmRunEventPreStartAP()`（`p2p_role_fsm.c:1434`）是 Start AP 的第一站，核心职责是判断是否需要 DFS CAC。5GHz DFS 信道（如 52-140）在发射前必须做 Channel Availability Check，等待 60 秒确认无雷达信号。但如果 STA 已经在同一频段连接（`p2pGetAisBssByBand(BAND_5G)` 非空），说明信道已经验证过，跳过 CAC。判断完成后，非 DFS 信道直接调用 `p2pRoleFsmRunEventStartAP()`，DFS 信道则走 `kalP2pPreStartRdd()` 启动雷达检测。

`p2pRoleFsmRunEventStartAP()`（`p2p_role_fsm.c:1548`）是 BSS 激活的核心。它依次完成：设置 Beacon interval 和 DTIM period（从消息中读取，或用默认值 100/1）、配置 SSID、调用 `p2pFuncSwitchOPMode()` 将 BSS 切换到 `OP_MODE_ACCESS_POINT` 模式、调用 `bssUpdateBeaconContent()` 组装 Beacon 帧体。

接下来是 DBDC 天线配置决策：单频模式下 TxNSS/RxNSS 取决于当前 band 的天线数量；DBDC 模式下每个 band 分配独立的天线子集——比如 2x2 天线的芯片在 DBDC 模式下，2.4GHz 和 5GHz 各分到 1x1。确定天线配置后，根据信道是否已知进入不同的 FSM 状态：信道已知则进入 `P2P_ROLE_STATE_REQING_CHANNEL` 向 CNM 请求信道资源，信道未知则进入 `P2P_ROLE_STATE_AP_CHNL_DETECTION` 先扫描。

### 3.2.4 P2P Role FSM 状态链

MTK 的 AP 启动走 P2P Role FSM 的状态链：`P2P_ROLE_STATE_IDLE → P2P_ROLE_STATE_REQING_CHANNEL`（向 CNM 请求信道资源）→ CNM 分配信道 → BSS 激活 → 固件开始发 Beacon。如果是 DFS 信道，中间插入 `P2P_ROLE_STATE_DFS_CAC`（CAC 等待 60 秒）。如果是未指定信道，先走 `P2P_ROLE_STATE_AP_CHNL_DETECTION`（扫描后选定信道）。和 QCOM 的 `SAP_INIT → SAP_STARTING → SAP_STARTED` 相比，MTK 的状态链更依赖 CNM（Channel Number Manager）的信道仲裁，而不是自成一体的 SAP FSM。QCOM 的 SAP 状态机像连锁酒店的标准化 SOP——前台接待、办理入住、入住完成，每一步都有专属流程；MTK 的 P2P Role FSM 则像精品民宿的灵活调度——管家（CNM）统一安排房间（信道），不管是接待散客（P2P GO）还是团队包场（AP），都走同一套排房流程，只靠 `OP_MODE_ACCESS_POINT` 标签区分"这是正式住客还是民宿客人"。

### 3.2.5 Beacon 模板下发固件

BSS 激活后，`bssUpdateBeaconContent()`（`bss.c:1171`）组装完整的 Beacon 帧体——包括 Frame Header、TIM IE、所有从 hostapd 传下来的 IE——然后调用 `nicUpdateBeaconIETemplate()` 通过 `CMD_ID_UPDATE_BEACON_CONTENT`（命令 ID 0x18）MCU 命令下发给固件。固件收到 Beacon 模板后，按照配置的 Beacon interval 周期性发射。

这里有一个容易忽略的细节：`bssUpdateBeaconContent()` 在组装 TIM IE 时（`bss.c:1042-1064`），`ucDTIMCount` 和 `ucBitmapControl` 都填 0，代码注释明确写着 "will be overwritten by FW"。驱动只搭好 TIM IE 的骨架（Element ID、Length、DTIM Period），固件在每次发射 Beacon 时根据内部的 per-STA 电源管理队列（`rStaPsQueue`，`adapter.h:2163`）覆写 DTIM Count 和 Bitmap Control：哪些 STA 正在休眠且有缓存帧，对应 bit 就置 1。

TIM IE 的长度固定为 `3 + MAX_LEN_TIM_PARTIAL_BMP`（`bss.h:43`），其中 `MAX_LEN_TIM_PARTIAL_BMP = (CFG_STA_REC_NUM + 7) / 8`，`CFG_STA_REC_NUM` 为 27（`wlan_def.h:166`），所以 Partial Virtual Bitmap 占 4 字节——足够覆盖 27 个 STA 的 AID。QCOM 也一样——hostapd 只把 `dtimPeriod` 传给驱动（`sap_bss_cfg->dtimPeriod`，`sap_fsm.c:4886`），TIM IE 的 Partial Virtual Bitmap 完全由固件构造和维护。这是 FullMAC 架构的共同特征：固件管理着每个 STA 的电源状态和帧缓存队列，host 侧根本没有这些信息，自然也无法构造 TIM bitmap。

值得注意的是，MTK 的 AP 启动模型和 QCOM 有一个根本差异。QCOM 的 `wlan_hdd_cfg80211_start_bss()` 通过 `qdf_wait_single_event` 阻塞等待，直到固件完成 BSS 创建并通过回调链唤醒等待——cfg80211 的 `.start_ap` 操作在 BSS 真正启动后才返回，超时约 11 秒。MTK 的 `mtk_p2p_cfg80211_start_ap()` 则是纯异步：它把 `MSG_P2P_BEACON_UPDATE` 和 `MSG_P2P_START_AP` 两个消息投递到 MBOX 队列后就返回了，不等待 P2P Role FSM 完成 BSS 激活。换句话说，QCOM 是"等经理签字才交房卡"，MTK 是"把工单递进去就认为办完了"——BSS 的实际激活由 FSM 异步完成，cfg80211 层不感知这个过程。

这意味着如果 FSM 处理消息时出错（比如 CNM 信道分配失败），cfg80211 层已经返回成功了，错误需要通过其他途径（如 STA 连接失败时的回调）反馈上来。

cfg80211 层虽然不等，但 FSM 自己会把活干完。`p2pRoleFsmRunEventStartAP()` 处理完 `MSG_P2P_START_AP` 后，将 `eIntendOPMode` 设为 `OP_MODE_ACCESS_POINT`，然后转入 `P2P_ROLE_STATE_REQING_CHANNEL` 向 CNM 请求信道：

```c
// MTK mgmt/p2p_role_fsm.c:1776
SET_NET_PWR_STATE_ACTIVE(prAdapter, prP2pBssInfo->ucBssIndex);
prP2pBssInfo->eIntendOPMode = OP_MODE_ACCESS_POINT;

if (prP2pRoleFsmInfo->rConnReqInfo.rChannelInfo.ucChannelNum != 0) {
    // 信道已知 → 准备 CNM 信道请求，转入 REQING_CHANNEL
    p2pRoleStatePrepare_To_REQING_CHANNEL_STATE(prAdapter, ...);
    p2pRoleFsmStateTransition(prAdapter, prP2pRoleFsmInfo,
                              P2P_ROLE_STATE_REQING_CHANNEL);
} else {
    // 信道未知 → 先扫描选信道
    p2pRoleFsmStateTransition(prAdapter, prP2pRoleFsmInfo,
                              P2P_ROLE_STATE_AP_CHNL_DETECTION);
}
```

CNM 分配信道后，`p2pRoleFsmRunEventChnlGrant()`（`p2p_role_fsm.c:3608`）收到 `CH_REQ_TYPE_GO_START_BSS` 类型的授权，将状态转回 `P2P_ROLE_STATE_IDLE`。此时 `p2pRoleStateAbort_REQING_CHANNEL()`（`p2p_role_state.c:122`）检测到 `eIntendOPMode == OP_MODE_ACCESS_POINT`，调用 `p2pFuncStartGO()`（`p2p_func.c:1722`）完成 BSS 激活——设置 SSID、配置信道和 PHY 参数、调用 `bssInitForAP()` 初始化 AP 模式的 BSS_INFO、最后通过 `p2pFuncStartGOBcn()` 向固件下发 Beacon 模板并开始发射。整个路径从 MBOX 消息投递到 Beacon 上线，全在 FSM 线程内异步完成，cfg80211 层全程无感知。

双平台对比：

| 维度         | QCOM qcacld-3.0                                              | MTK gen4m                                                    |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| SAP 入口     | `wlansap_start_bss()` → sap_fsm                              | `mtk_cfg_start_ap()` → P2P Role FSM                          |
| 状态机模型   | SAP_INIT → SAP_STARTING → SAP_STARTED，含 ACS/CAC 状态       | P2P_ROLE_STATE_IDLE → REQING_CHANNEL → BSS 激活，DFS 信道插入 DFS_CAC |
| Beacon 处理  | `sap_goto_starting()` → `sme_start_bss()` → `wlan_serialization` → PE → 固件 | `bssUpdateBeaconContent()` → `CMD_ID_UPDATE_BEACON_CONTENT`（0x18）→ 固件 |
| 并发管理     | `policy_mgr`（DBS/MCC/SCC 统一管理）                         | CNM 信道仲裁 + DBDC 决策                                     |
| 加密 offload | 支持四次握手 offload (`WPA_DRIVER_FLAGS2_4WAY_HANDSHAKE_AP_PSK`) | 类似，固件 offload                                           |
| 启动模型     | 异步执行+同步返回（`qdf_wait_single_event` ~11s 超时，超时后区分 recovery/non-recovery） | 纯异步（MBOX 消息→FSM 异步处理，cfg80211 不阻塞）            |
| 超时保护     | `SME_CMD_START_BSS_TIMEOUT` ~11s，超时后 recovery/non-recovery 分支处理 | `DEFAULT_P2P_CSA_TIMEOUT_MS` 7s（CSA 超时），`rlmCsaTimeout()` 直接更新信道参数同步固件 |

两者都是 FullMAC 架构（MLME 在固件中），Auth/Assoc 帧的处理和四次握手都可能 offload 到固件。hostapd 只是配置下发和事件中转的角色——给定参数，固件去执行。用酒店管理的话说：hostapd 是业主方，只管定规则（加密方式、SSID、信道）和验收结果（事件回调）；固件是实际运营团队，前台接待（Auth）、发房卡（Assoc）、收房费（四次握手）全包了。QCOM 和 MTK 的区别只在运营团队的组织架构不同，干活的都是固件。

一个典型的例子是 ACS（Auto Channel Selection）——当 hostapd 没有指定信道时，驱动怎么选"开哪间房"？QCOM 的方案是多因子加权评分：`sap_select_channel()`（`sap_ch_select.c:2770`）先通过 `sap_compute_spect_weight()`（`sap_ch_select.c:1483`）对每个候选信道计算综合权重，评分因子包括 RSSI（邻区信号强度）、BSS count（同信道 AP 数量）、noise floor（底噪）、channel free（空闲时隙占比）、TX power range/throughput（发射功率对覆盖和吞吐的影响），每个因子的权重由 INI 参数 `AutoChannelSelectWeight`（默认 `0x00fafafa`，`cfg_mlme_acs.h:75`）控制——高 4 位是 RSSI 权重，接下来 4 位是 BSS count，依此类推。评分完成后按权重排序，还额外考虑 MCC 规避（`FEATURE_AP_MCC_CH_AVOIDANCE`）和 2.4GHz 非重叠信道优先。放进民宿的场景——QCOM 像连锁酒店开业前做市场调研，考察每个楼层的人流量（RSSI）、竞品数量（BSS count）、噪音水平（noise floor），综合打分选出最优楼层。

MTK 的方案更务实：`p2pRoleFsmRunEventAcs()`（`p2p_role_fsm.c:5136`）先检查有没有预配置的信道覆盖（`ucApAcsChannel[]`），再检查 DBDC 关闭时 STA 是否已连接——如果 STA 在 5GHz 信道 36 上，AP 直接复用同一信道（`indicateAcsResultByAisCh()`（`p2p_role_fsm.c:4921`）读取 STA 的 `ucPrimaryChannel` 和带宽），省去扫描开销。只有 STA 未连接时才走扫描选信道。就像精品民宿老板的直觉——如果自己已经住在 3 楼（STA 已连接），就把民宿也开在 3 楼（SCC），省得两头跑。

![MTK P2P Role FSM 状态链：IDLE → REQING_CHANNEL → BSS 激活，DFS 信道插入 DFS_CAC，信道未知时先走 AP_CHNL_DETECTION](assets/10d-SAP%EF%BC%88%E5%9B%9B%EF%BC%89%E5%BD%93%E8%80%81%E6%9D%BF%E2%80%94%E2%80%94%E5%85%B1%E5%AD%98%E3%80%81%E9%A9%B1%E5%8A%A8%E4%B8%8E%E8%BF%90%E7%BB%B4/10d-MTK-P2P-FSM%E7%8A%B6%E6%80%81%E9%93%BE.svg)

---

# 4 客户端离开与热点关闭

客人退房有三种方式：自己checkout走人、因违规被酒店请出去、或者人走了房间一直空着直到酒店主动收回。WiFi 客户端离开 AP 也是这三条路径，每条路径的清理逻辑不同——但不管哪条路径，驱动和 hostapd 都要完成同样的善后：清密钥、释放资源、通知上层，就像酒店不管客人怎么走，都要查房、结账、更新房态。除此之外，老板也可能主动打烊——这就是 4.1 的热点关闭。

## 4.1 主动关闭

用户关闭热点时，Framework 发 `CMD_STOP` → `SoftApManager` 调用 `mWifiNative.stopSoftAp()` → `mHostapdHal.removeAccessPoint()` → `IHostapd.removeAccessPoint()` AIDL → hostapd 停止 Beacon → `NL80211_CMD_STOP_AP` → 内核停止 AP 模式 → 所有关联客户端收到 Deauth（reason 3: PREV_AUTH_NOT_VALID, 802.11-2024 Table 9-79）。这条链路和启动链路几乎完全对称——从 Framework 到 HAL 到 hostapd 到内核，只是方向相反。回到沙漠民宿的比喻：主动关闭就是老板打烊——先关灯（停 Beacon），再给所有客人发退房通知（Deauth），最后锁门走人（释放接口）。

## 4.2 客户端自己离开

客户端发送 Deauth 或 Disassoc 帧，hostapd 的 `ieee802_11_mgmt()` 收到后，触发 `handle_deauth()`（`ieee802_11.c:5950`）或 `handle_disassoc()`（`ieee802_11.c:5923`）。两个入口最终分别调用 `hostapd_deauth_sta()` 和 `hostapd_disassoc_sta()`——它们的清理逻辑有关键差异，值得展开看。

### 4.2.1 Deauth 路径：立即释放

`hostapd_deauth_sta()`（`ieee802_11.c:5792`）的清理是"一步到位"的：

```c
// hostapd/src/ap/ieee802_11.c:5792
static void hostapd_deauth_sta(struct hostapd_data *hapd,
                               struct sta_info *sta,
                               const struct ieee80211_mgmt *mgmt)
{
    ap_sta_set_authorized(hapd, sta, 0);       // 清 WLAN_STA_AUTHORIZED，发 AP_STA_DISCONNECTED
    sta->flags &= ~(WLAN_STA_AUTH | WLAN_STA_ASSOC | WLAN_STA_ASSOC_REQ_OK);  // 清全部状态
    hostapd_set_sta_flags(hapd, sta);           // 推送到驱动
    wpa_auth_sm_event(sta->wpa_sm, WPA_DEAUTH); // 通知 WPA 状态机
    ieee802_1x_notify_port_enabled(sta->eapol_sm, 0);  // 关闭 802.1X 端口
    ap_free_sta(hapd, sta);                     // 立即完整清理
}
```

三个关键点：第一，`WLAN_STA_AUTH` 和 `WLAN_STA_ASSOC` 同时清除——客户端和 AP 之间的认证关系彻底断开。第二，通知 WPA 状态机用的是 `WPA_DEAUTH`（而非 `WPA_DISASSOC`），语义更重。第三，直接调用 `ap_free_sta()`，不等待——STA entry 在函数返回前就被完全销毁。

### 4.2.2 Disassoc 路径：保留认证，延迟释放

`hostapd_disassoc_sta()`（`ieee802_11.c:5816`）的处理更温和：

```c
// hostapd/src/ap/ieee802_11.c:5816
static void hostapd_disassoc_sta(struct hostapd_data *hapd,
                                 struct sta_info *sta,
                                 const struct ieee80211_mgmt *mgmt)
{
    ap_sta_set_authorized(hapd, sta, 0);
    sta->flags &= ~(WLAN_STA_ASSOC | WLAN_STA_ASSOC_REQ_OK);  // 注意：保留 WLAN_STA_AUTH
    hostapd_set_sta_flags(hapd, sta);
    wpa_auth_sm_event(sta->wpa_sm, WPA_DISASSOC);
    accounting_sta_stop(hapd, sta);             // 立即停止 RADIUS 计费
    ieee802_1x_free_station(hapd, sta);         // 释放 802.1X/EAPOL 状态
    hostapd_drv_sta_remove(hapd, sta->addr);    // 从驱动移除
    sta->timeout_next = STA_DEAUTH;             // 标记：下一步是 deauth
    eloop_register_timeout(AP_DEAUTH_DELAY, 0, ap_handle_timer, hapd, sta);  // 延迟释放
}

```

和 deauth 有两个关键差异。第一，`WLAN_STA_AUTH` 保留——客户端只是"离开了房间"（disassociated），但"入住登记"（authentication）还在。STA 在 hostapd 内存中继续存活，等待 `AP_DEAUTH_DELAY` 秒后由 `ap_handle_timer` 触发最终的 deauth 清理。第二，没有调用 `ap_free_sta()`——802.11 标准的语义是 disassoc 比 deauth 轻，客户端有机会重新关联而不需要重新认证。只有 802.11ad（DMG）是个例外：它同时清 AUTH 并立即调用 `ap_free_sta()`。

### 4.2.3 ap_free_sta：250 行的全面清理

不管是 deauth 立即释放还是 inactivity 超时的延迟释放，最终都汇聚到 `ap_free_sta()`（`sta_info.c:225`）。这个函数约 250 行，是 hostapd 中最全面的 STA 清理函数，按顺序完成以下步骤：

1. **停止计费**：`accounting_sta_stop()` 发送 RADIUS Accounting-Stop 报文
2. **驱动移除**：`__ap_free_sta()` → `hostapd_drv_sta_remove()` 从内核驱动中删除 STA entry
3. **哈希表和链表移除**：`ap_sta_hash_del()` + `ap_sta_list_del()` 从 hostapd 的 STA 查找表中删除
4. **AID 释放**：直接操作 bitmap，将对应位清零——AID 是 1-2007 的整数，用 32 位 bitmap 管理，每位对应一个 AID

```c
// hostapd/src/ap/sta_info.c:252
ap_sta_hash_del(hapd, sta);       // 从哈希表删除
ap_sta_list_del(hapd, sta);       // 从链表删除
if (sta->aid > 0)
    hapd->sta_aid[(sta->aid - 1) / 32] &=
        ~BIT((sta->aid - 1) % 32); // 释放 AID bitmap 位
hapd->num_sta--;                  // 站点计数递减
```

5. **能力计数器更新**：`hapd->num_sta--` 后检查该 STA 是否贡献了特殊能力计数器（non-ERP、no short slot time、no short preamble、HT no GF、no HT、HT 20MHz），递减后如果计数器归零则触发 Beacon 更新——因为这些能力标志位会影响 Beacon 中的 ERP IE 和 HT Operation IE

```c
// hostapd/src/ap/sta_info.c:259
hapd->num_sta--;
if (sta->nonerp_set) {
    sta->nonerp_set = 0;
    hapd->iface->num_sta_non_erp--;
    if (hapd->iface->num_sta_non_erp == 0)
        set_beacon++;  // 计数器归零 → 触发 Beacon 更新
}
if (sta->no_short_slot_time_set) {
    sta->no_short_slot_time_set = 0;
    hapd->iface->num_sta_no_short_slot_time--;
    if (hapd->iface->current_mode &&
        hapd->iface->current_mode->mode == HOSTAPD_MODE_IEEE80211G
        && hapd->iface->num_sta_no_short_slot_time == 0)
        set_beacon++;
}
// ... no_short_preamble、ht_no_gf、no_ht、ht_20mhz 同理 ...
if (set_beacon)
    ieee802_11_update_beacons(hapd->iface);  // 统一刷新 Beacon

```

退房时的民宿账本——检查这个客人是不是唯一一个需要特殊服务的（比如唯一一个不用短时隙的 802.11b 老设备）——如果是，退房后 Beacon 里的 ERP IE 就要更新，告诉其他客人"现在全部都是新设备了，可以用更快的接入方式"。

6. **定时器批量取消**：`eloop_cancel_timeout` 取消 7 个定时器——`ap_handle_timer`（inactivity）、`ap_handle_session_timer`（会话超时）、`ap_handle_session_warning_timer`（会话警告）、`sae_clear_retransmit_timer`（SAE 重传）、`ap_sa_query_timer`（SA Query）、`fils_hlp_timeout`（FILS HLP）、`ap_sta_reset_steer_flag_timer`（WNM 引导标志）

```c
// hostapd/src/ap/sta_info.c:333
eloop_cancel_timeout(ap_handle_timer, hapd, sta);
eloop_cancel_timeout(ap_handle_session_timer, hapd, sta);
eloop_cancel_timeout(ap_handle_session_warning_timer, hapd, sta);
ap_sta_clear_disconnect_timeouts(hapd, sta);
sae_clear_retransmit_timer(hapd, sta);
ieee802_1x_free_station(hapd, sta);  // 释放 802.1X/EAPOL 状态

```

7. **WPA 状态机销毁**：`wpa_auth_sta_deinit(sta->wpa_sm)` 触发 strict rekey 逻辑

```c
// hostapd/src/ap/wpa_auth.c:1066
void wpa_auth_sta_deinit(struct wpa_state_machine *sm)
{
    struct wpa_authenticator *wpa_auth = sm->wpa_auth;
    // strict rekey：持有 GTK 的 STA 离开时，0.5 秒后触发 GTK 重协商
    if (wpa_auth->conf.wpa_strict_rekey && sm->has_GTK) {
        wpa_auth_logger(wpa_auth, ..., LOGGER_DEBUG,
                "strict rekeying - force GTK rekey since STA is leaving");
        eloop_deplete_timeout(0, 500000, wpa_rekey_gtk, wpa_auth, NULL);
    }
    eloop_cancel_timeout(wpa_send_eapol_timeout, wpa_auth, sm);
    eloop_cancel_timeout(wpa_sm_call_step, sm, NULL);
    eloop_cancel_timeout(wpa_rekey_ptk, wpa_auth, sm);
    wpa_ft_sta_deinit(sm);  // 802.11r Fast Transition 状态清理
}

```

8. **资源释放**：释放 HT/VHT/HE/EHT capabilities、SAE data、FILS data、OWE data、PSK list、identity 等数十个字段，最后 `os_free(sta)` 释放整个 STA 结构体

### 4.2.4 wpa_auth_sta_deinit：strict rekey 与定时器清理

`wpa_auth_sta_deinit()`（`wpa_auth.c:1066`）是 WPA 状态机的善后函数。最有意思的逻辑在开头：如果配置了 `wpa_strict_rekey`（即"严格密钥更新"模式），且该 STA 持有 GTK（已参与组密钥分发），函数会立即触发 GTK 重新协商——`eloop_deplete_timeout(0, 500000, wpa_rekey_gtk)` 在 0.5 秒后启动 GTK rekey。这意味着当一个客户端离开时，AP 会在半秒内更新组密钥，确保离开的客户端无法继续解密组播/广播流量。对于企业级 WiFi 或公共热点场景，这是一个安全加固措施。

随后是定时器清理：取消 EAPOL 超时（`wpa_send_eapol_timeout`）、状态机步进（`wpa_sm_call_step`）、PTK 重协商（`wpa_rekey_ptk`），以及 802.11r Fast Transition 状态清理（`wpa_ft_sta_deinit`）。

### 4.2.5 Deauth vs Disassoc 清理差异总结

| 步骤        | Deauth         | Disassoc                         |
| ----------- | -------------- | -------------------------------- |
| AUTH 标志   | 清除           | 保留                             |
| ap_free_sta | 立即调用       | 不调用（延迟到 ap_handle_timer） |
| STA 存活    | 函数返回前销毁 | 继续存活 AP_DEAUTH_DELAY 秒      |
| WPA 通知    | `WPA_DEAUTH`   | `WPA_DISASSOC`                   |
| 语义        | "永远别回来了" | "先出去，还能再进来"             |

清理完成后，hostapd 发送 `onConnectedClientsChanged` 回调到 Framework。Framework 收到回调后更新客户端计数，如果变为 0 则启动空闲超时定时器。

## 4.3 AP 踢人

AP 可以主动踢掉不活跃的客户端。`ap_max_inactivity` 计时器在 `hostapd_new_assoc_sta()` 中注册（详见第三篇客户端关联流程中的定时器设置），到期后 `ap_handle_timer()` 回调触发 STA 断开流程。典型 reason code 是 4（DISASSOC_DUE_TO_INACTIVITY，802.11-2024 Table 9-79）——最常见的原因是 STA 信号太差，AP 收不到它的帧。

`ap_handle_timer()`（`sta_info.c:530`）是 inactivity 检测的核心，约 150 行，逻辑分三层：

```c
// hostapd/src/ap/sta_info.c:530
void ap_handle_timer(void *eloop_ctx, void *timeout_ctx)
{
    struct hostapd_data *hapd = eloop_ctx;
    struct sta_info *sta = timeout_ctx;
    int max_inactivity = hapd->conf->ap_max_inactivity;

    // 第一层：STA_REMOVE 直接清理（本地 deauth 请求触发）
    if (sta->timeout_next == STA_REMOVE) {
        ap_free_sta(hapd, sta);
        return;
    }

    // 第二层：检查 STA 不活跃时长
    if ((sta->flags & WLAN_STA_ASSOC) &&
        (sta->timeout_next == STA_NULLFUNC || sta->timeout_next == STA_DISASSOC)) {
        int inactive_sec = hostapd_drv_get_inact_sec(hapd, sta->addr);
        if (inactive_sec < max_inactivity) {
            // STA 还活跃——重置定时器，等待下次检查
            sta->timeout_next = STA_NULLFUNC;
            next_time = max_inactivity + fuzz - inactive_sec;
        } else {
            // STA 不活跃超时——标记为待踢
            if (hapd->conf->skip_inactivity_poll)
                sta->timeout_next = STA_DISASSOC;
        }
    }

    // 第三层：执行踢人或探测
    if (sta->timeout_next == STA_NULLFUNC) {
        // 先发 NullFunc 帧探测 STA 是否还活着
        hostapd_drv_poll_client(hapd, hapd->own_addr, sta->addr, ...);
    } else if (sta->timeout_next != STA_REMOVE) {
        // 确认不活跃，发送 Disassoc（reason 4: INACTIVITY）
        hostapd_drv_sta_disassoc(hapd, sta->addr,
                WLAN_REASON_DISASSOC_DUE_TO_INACTIVITY);
    }
}

```

核心逻辑是一个两阶段探测：第一次 `ap_handle_timer` 触发时，如果 STA 不活跃，先发一个 NullFunc 帧（`STA_NULLFUNC` 阶段）试探 STA 是否还能响应；如果 STA 回了 ACK（`hostapd_drv_poll_client` 成功），说明它还活着，重置定时器继续等；如果连 ACK 都没回来，下一次定时器触发时进入 `STA_DISASSOC` 阶段，正式发送 Disassoc 帧踢掉。回到民宿的楼道——发现客人好久没出门，先敲敲门（NullFunc 探测）——有人应就继续等，没人应就结账退房（Disassoc）。

除了 inactivity 超时，TKIP countermeasures（即第三篇中讲到的 `tkip_countermeasures` 标志）也会触发踢人：检测到 Michael MIC 攻击时，AP 会拒绝所有使用 TKIP 的 STA 60 秒（reason code 14, MIC_FAILURE，802.11-2024 Table 9-79；60 秒拒绝窗口见 Section 12.7.3.1 TKIP countermeasures procedure）。

## 4.4 空闲超时关闭

上面三种情况都是"还有人在"时的处理。还有一种场景：所有客户端都走了，但热点还开着——Framework 层有独立的超时机制 `CMD_NO_ASSOCIATED_STATIONS_TIMEOUT`。`StartedState` 中，当客户端数量变为 0 时启动定时器（默认由 `config_wifiFrameworkSoftApShutDownTimeoutMilliseconds` 配置），到期后回到 `IdleState`，关闭热点。空闲超时机制的目的是省电：热点开着但没有客户端，不如自动关了。

Framework 层的实现分两步。第一步是定时器注册——当客户端数量变为 0 时，`rescheduleTimeoutMessageIfNeeded()`（`SoftApManager.java:1646`）检查 `mTimeoutEnabled` 标志（由 `SoftApConfiguration.isAutoShutdownEnabled()` 控制），如果启用且客户端数为 0，调用 `scheduleTimeoutMessage()` 发送一个延迟的 `CMD_NO_ASSOCIATED_STATIONS_TIMEOUT` 消息：

```java
// SoftApManager.java:1646
private void rescheduleTimeoutMessageIfNeeded(String instance, long timeoutValue) {
    final boolean timeoutEnabled = isTetheringInterface ? mTimeoutEnabled
            : (mBridgedModeOpportunisticsShutdownTimeoutEnabled && !mIsPlugged);
    final int clientNumber = isTetheringInterface
            ? getConnectedClientList().size()
            : mConnectedClientWithApInfoMap.get(instance).size();
    if (!timeoutEnabled || clientNumber != 0) {
        cancelTimeoutMessage(instance);  // 有客户端连接，取消定时器
        return;
    }
    scheduleTimeoutMessage(instance, timeoutValue);  // 无客户端，启动倒计时
}

```

第二步是超时处理——`CMD_NO_ASSOCIATED_STATIONS_TIMEOUT` 消息到达 `StartedState` 后：

```java
// SoftApManager.java:2090
case CMD_NO_ASSOCIATED_STATIONS_TIMEOUT:
    if (!mTimeoutEnabled) break;                    // 超时已禁用，丢弃
    if (getConnectedClientList().size() != 0) break; // 又有客户端了，丢弃
    mSoftApNotifier.showSoftApShutdownTimeoutExpiredNotification();
    updateApState(WifiManager.WIFI_AP_STATE_DISABLING,
            WifiManager.WIFI_AP_STATE_ENABLED, 0);
    writeSoftApStoppedEvent(STOP_EVENT_NO_USAGE_TIMEOUT);
    quitNow();  // 退出状态机，触发热点关闭
    break;

```

两个防御性检查值得注意：`mTimeoutEnabled` 为 false 时直接丢弃（用户可能在超时窗口内手动禁用了自动关闭），客户端数不为 0 时也丢弃（超时窗口内有新客户端连上来了）。Bridge 模式下还有独立的单实例超时机制 `CMD_NO_ASSOCIATED_STATIONS_TIMEOUT_ON_ONE_INSTANCE`——当双频热点的某一侧（比如 2.4GHz）长时间无客户端时，只关闭那一侧的实例，而不是整个热点。

![客户端离开 AP 的三条路径：主动 Deauth/Disassoc、AP 踢人（inactivity 超时）、空闲超时关闭，以及各自的清理流程](assets/10d-SAP%EF%BC%88%E5%9B%9B%EF%BC%89%E5%BD%93%E8%80%81%E6%9D%BF%E2%80%94%E2%80%94%E5%85%B1%E5%AD%98%E3%80%81%E9%A9%B1%E5%8A%A8%E4%B8%8E%E8%BF%90%E7%BB%B4/10d-%E5%AE%A2%E6%88%B7%E7%AB%AF%E7%A6%BB%E5%BC%80%E4%B8%89%E6%9D%A1%E8%B7%AF%E5%BE%84.svg)

不管是哪种离开方式，`ap_free_sta()` 都是最后的"查房结账"——250 行代码把密钥、定时器、状态机、AID 一个个清干净，确保没有遗留。对民宿老板来说，客人走了不可怕，可怕的是走了之后房间没收拾干净、门卡没注销、账没结清——WiFi AP 也一样，STA 的善后直接决定了下一个客户端能不能顺利入住。

---

# 5 调试与关键日志

前面四章讲了 SAP 的"怎么做"——共存、驱动、客户端管理。但运营中最头疼的不是"怎么做"，而是"出了问题怎么查"。民宿出了故障，你得知道是水管（Framework）、电路（hostapd）、还是地基（驱动）的问题——不能每次都把整栋楼拆了重装。WiFi 调试也是同样的道理：四层架构，每层有自己的日志和状态，定位问题的关键是先锁定卡在哪一层。

## 5.1 各层关键日志

SAP 问题排查的第一步是定位卡在哪一层。下表列出了从 Framework 到驱动的四层关键日志——每条都是一个 grep 关键字，在 logcat 中搜索就能快速定位当前阶段：

| 层        | 日志关键字                                  | 含义                           |
| --------- | ------------------------------------------- | ------------------------------ |
| Framework | `SoftApManager: Soft AP started`            | 热点启动成功                   |
| Framework | `SoftApManager: Soft AP start failed`       | 启动失败（通常有 StartResult） |
| Framework | `CMD_NO_ASSOCIATED_STATIONS_TIMEOUT`        | 空闲超时关闭                   |
| HAL       | `HostapdHal: addAccessPoint`                | HAL 向 hostapd 下发配置        |
| hostapd   | `hostapd_setup_bss`                         | BSS 初始化                     |
| hostapd   | `mgmt::auth / mgmt::assoc_req`              | 收到客户端 Auth/Assoc 帧       |
| hostapd   | `WPA: 1/4 / 2/4 / 3/4 / 4/4`                | 四次握手各步                   |
| nl80211   | `NL80211_CMD_START_AP`                      | 内核注册 AP                    |
| QCOM      | `sap_fsm: vdev X: SAP_INIT => SAP_STARTING` | SAP FSM 状态切换               |
| QCOM      | `START AP: mode SAP`                        | 驱动层 AP 启动                 |

### 5.1.1 完整启动时间线

以下是一次典型热点启动到客户端连接完成的 logcat 时间序列。每行标注了对应的源码函数，方便定位问题卡在哪一步：

```
## 阶段一：Framework 调度（约 200ms）
07-25 10:00:00.100  WifiService: startSoftApInternal()          # WifiServiceImpl.java:2023
07-25 10:00:00.120  ActiveModeWarden: startSoftAp()             # ActiveModeWarden.java:862
07-25 10:00:00.150  SoftApManager: CMD_START received           # SoftApManager 构造函数末尾
07-25 10:00:00.200  SoftApManager: setupInterfaceForSoftApMode() # WifiNative.java:1615
07-25 10:00:00.250  WifiNative: startHal() → OK
07-25 10:00:00.280  WifiNative: startHostapd() → OK

## 阶段二：hostapd 初始化（约 500ms）
07-25 10:00:00.300  HostapdHal: addAccessPoint()                # AIDL 跨进程调用
07-25 10:00:00.350  hostapd: hostapd_setup_interface()          # hostapd.c:2891
07-25 10:00:00.400  hostapd: hostapd_setup_bss() start          # hostapd.c:1393
07-25 10:00:00.420  hostapd: Deriving WPA PSK based on passphrase  # ap_config.c:557
07-25 10:00:00.450  hostapd: hostapd_set_ssid() → OK
07-25 10:00:00.500  hostapd: hostapd_start_beacon()             # hostapd.c:1293

## 阶段三：驱动注册 AP（约 300ms）
07-25 10:00:00.550  hostapd: driver->set_ap() → NL80211_CMD_START_AP  # ap_drv_ops.h:243
07-25 10:00:00.600  kernel: nl80211_start_ap()                  # nl80211.c:5976
07-25 10:00:00.700  QCOM: sap_fsm: SAP_INIT => SAP_STARTING    # sap_fsm.c:3230
07-25 10:00:00.750  QCOM: sap_fsm: SAP_STARTING => SAP_STARTED # sap_fsm.c:3686
07-25 10:00:00.800  SoftApManager: Soft AP started              # 热点就绪，Beacon 已发射

## 阶段四：客户端连接（约 500ms）
07-25 10:01:30.100  hostapd: mgmt::auth                         # ieee802_11.c:6353 → handle_auth()
07-25 10:01:30.150  hostapd: mgmt::assoc_req                    # ieee802_11.c:6358 → handle_assoc()
07-25 10:01:30.200  hostapd: WPA: Key negotiation started       # wpa_auth.c:964 → wpa_auth_sta_associated()
07-25 10:01:30.250  hostapd: WPA: 1/4 of 4-Way Handshake sent   # wpa_auth.c:2715 (PTKSTART)
07-25 10:01:30.350  hostapd: WPA: 2/4 of 4-Way Handshake received  # wpa_auth.c:3639 (PTKCALCNEGOTIATING)
07-25 10:01:30.400  hostapd: WPA: 3/4 of 4-Way Handshake sent   # wpa_auth.c:4672 (PTKINITNEGOTIATING)
07-25 10:01:30.500  hostapd: WPA: 4/4 of 4-Way Handshake received  # wpa_auth.c:5081 (PTKINITDONE)
07-25 10:01:30.550  hostapd: AP-STA-CONNECTED aa:bb:cc:dd:ee:ff  # ap_sta_set_authorized()
```

排查思路：这四层日志就像追踪一个包裹的物流信息——Framework 是下单，hostapd 是仓库打包，驱动是快递运输，固件是签收确认。如果热点启动卡住，看 log 停在哪个阶段——Framework 层卡住多半是接口冲突或国家码问题，hostapd 层卡住看 BSS 初始化报错，驱动层卡住看 SAP FSM 是否到达 `SAP_STARTED`。如果客户端连接卡住，看四次握手停在 1/4 还是 3/4——1/4 没发出说明 hostapd 配置问题，3/4 没发出说明 MIC 验证失败（密码错误）。

但实际排查时，你拿到的往往不是"卡在哪一步"，而是"出了什么症状"。下表是从症状反推根因的决策树——拿到问题先看左列，按中间列逐层检查，定位到右列的根因和对应函数：

| 症状                       | 逐层排查路径                                                 | 根因                                                         |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 热点图标不出现             | Framework: `SoftApManager: Soft AP start failed`? → HAL: `HostapdHal: addAccessPoint` 返回值? → hostapd: `hostapd_setup_bss` 报错? → 驱动: `SAP_INIT` 是否转到 `SAP_STARTING`? | Framework 层：接口冲突（STA 占用 wlan0）或国家码未设置；hostapd 层：加密参数错误或信道不可用；驱动层：DFS 信道 CAC 失败或 NOL 命中 |
| 热点图标出现但客户端搜不到 | hostapd: `hostapd_start_beacon()` 是否成功? → `hostapd_cli status` 看 `state` 是否 `ENABLED`? → 驱动: Beacon 是否实际发射（QCOM: `SAP_STARTED`；MTK: `CMD_ID_UPDATE_BEACON_CONTENT` 下发成功）? | hostapd 层：`state=DFS_CAC` 时 Beacon 未发射（等 60 秒）；驱动层：固件 Beacon 模板配置错误；射频层：天线或功率限制 |
| 客户端关联失败             | hostapd: `mgmt::auth` 是否收到? → `mgmt::assoc_req` 是否收到? → 驱动: STA entry 是否创建? | hostapd 层：ACL 拒绝（`hostapd_deny_acl`）或加密不匹配；驱动层：STA 数量超限或资源不足 |
| 四次握手卡在 1/4           | hostapd: `WPA: 1/4 of 4-Way Handshake sent` 之后是否有 2/4 回来? | 密码错误（客户端 MIC 验证失败，不回 2/4）；或客户端不支持 AP 侧的加密套件（RSN IE 不匹配） |
| 四次握手卡在 3/4           | hostapd: `WPA: 3/4 of 4-Way Handshake sent` 之后是否有 4/4 回来? | AP 侧 MIC 验证失败（`wpa_auth.c:4672` PTKINITNEGOTIATING 阶段发送 3/4 后等 4/4 超时）；通常是密码错误或 PMK 不匹配 |
| 客户端频繁断开             | hostapd: `AP-STA-DISCONNECTED` + reason code? → `ap_handle_timer` inactivity 触发? | 信号差（reason 4, inactivity 超时）；或 TKIP countermeasures（reason 14）；或漫游触发（BTM Request） |
| 客户端连上但无法上网       | Framework: `SoftApInfo` 中 `connectedClients` 是否递增? → 驱动: NAT/转发规则是否设置? → `tether` 服务状态? | Framework 层：tether 接口未配置或 NAT 规则缺失；驱动层：数据通路未打通（vdev 未关联到正确的 net_device） |

## 5.2 dumpsys

日志看的是"发生了什么"，dumpsys 看的是"现在是什么状态"——一个是回放监控录像，一个是查看当前房间入住表。`dumpsys wifi` 是 Android 上最常用的 WiFi 状态诊断入口，SoftAp 相关的状态集中在 SoftAp 和 tether 关键字下：

```bash
## 查看 SoftAp 状态
dumpsys wifi | grep -i "SoftAp\|tether"

## 只看状态机
dumpsys wifi | grep -A5 "SoftApStateMachine"
```

关键字段：`SoftApState`（当前状态）、`SoftApInfo`（频率、BSSID、带宽、客户端数）、`StartResult`（最近一次启动的结果码）。

典型输出：

```
SoftApState: started
SoftApInfo: {frequency=5745, bssid=2a:bb:cc:dd:ee:ff, bandwidth=80MHZ, connectedClients=2}
StartResult: 1
IdleTimeout: 600000ms
BridgedMode: false
```

`StartResult` 的值对应 `SoftApManager.StartResult` 注解（`SoftApManager.java:121`）内的常量：`1` 表示 `START_RESULT_SUCCESS`（定义在 126 行），`5` 表示 `START_RESULT_FAILURE_START_HAL`，`6` 表示 `START_RESULT_FAILURE_START_HOSTAPD`，以此类推。`connectedClients=2` 表示当前有两个客户端连接，`IdleTimeout=600000ms` 是 10 分钟空闲超时（无客户端时自动关闭）。

## 5.3 hostapd_cli

dumpsys 看的是 Framework 层视角，hostapd_cli 则是直接拿起对讲机和 hostapd 前台通话——不需要经过酒店管理系统（Framework），直接问前台"现在住了几个人""把 301 房的客人请出去"。当你需要实时查看 AP 接口状态、列出当前关联的客户端、或者手动断开某个 STA 时，它是最直接的工具：

```bash
## 查看连接的客户端
hostapd_cli -i wlan1 list_sta

## 查看 AP 状态
hostapd_cli -i wlan1 status

## 断开特定客户端
hostapd_cli -i wlan1 disassociate <STA_MAC>
```

`list_sta` 的典型输出：

```
aa:bb:cc:dd:ee:ff
11:22:33:44:55:66
```

每行一个 MAC 地址，就是当前关联的客户端。如果启用了 WPA，这些客户端已经完成了四次握手。如果列表为空但热点开着，说明没有客户端连接——检查客户端侧是否能看到 SSID。

`status` 的典型输出：

```
state=ENABLED
phy=phy0
freq=5745
channel=149
ssid=MyHotspot
wpa=2
key_mgmt=WPA2-PSK
pairwise_cipher=CCMP
group_cipher=CCMP
beacon_int=100
dtim_period=1
num_sta=2
```

关键字段：`state=ENABLED` 表示 AP 正常运行（对应 `HAPD_IFACE_ENABLED`）；`freq=5745` 和 `channel=149` 是当前工作频率和信道；`wpa=2` 表示 WPA2；`num_sta=2` 是当前客户端数量。如果 `state` 不是 `ENABLED`，检查 hostapd 日志看卡在哪个阶段——可能是 ACS 扫描中、DFS CAC 等待中、或者信道配置错误。

一个典型排查场景：`hostapd_cli -i wlan1 status` 返回 `state=DISABLED`，但热点图标已显示。这通常意味着 hostapd 已启动但 BSS 尚未激活——检查 logcat 中 `hostapd_setup_bss` 是否完成、`NL80211_CMD_START_AP` 是否返回成功。如果 `state=DFS_CAC`，说明正在做 60 秒雷达检测，等 CAC 完成后自动切到 `ENABLED`。如果 `list_sta` 返回空但客户端侧能看到 SSID，检查客户端是否完成了四次握手——`hostapd_cli -i wlan1 all_sta` 可以看到更详细的 STA 状态（包括 EAPOL 进度）。

## 5.4 MTK 驱动调试工具

QCOM 侧的排查主要靠 `sap_fsm` 日志和 `hostapd_cli`，但 MTK 侧没有独立的 SAP FSM——它复用 P2P Role FSM，排查工具也不同。如果说 hostapd_cli 是对讲机 call 前台，MTK 的 `iwpriv` 私有命令就是直接进物业后台管理系统——绕过所有中间层，直接查看和操控驱动内部状态。MTK gen4m 驱动提供了 `iwpriv` 私有命令和内部 `dumpBss()` 函数，可以直接查看驱动层状态。

**ACL 调试**（AP 接入控制，对应 `iwpriv p2p0 driver` 系列命令）：

```bash
## 设置 ACL 策略（0=disabled, 1=accept, 2=reject）
iwpriv p2p0 driver "set_acl_policy 1"

## 添加白名单 MAC
iwpriv p2p0 driver "add_acl_entry 01:02:03:04:05:06"

## 查看当前 ACL 列表
iwpriv p2p0 driver "show_acl_entry"

## 清空 ACL 列表
iwpriv p2p0 driver "clear_acl_entry"
```

**DFS 调试**（5GHz 雷达检测相关）：

```bash
## 查看 DFS 状态（当前信道是否在 CAC/NOL 期）
iwpriv wlan0 driver "show_dfs_state"

## 查看 CAC 剩余时间
iwpriv wlan0 driver "show_dfs_cac_time"

## 跳过 CAC（调试用，生产环境禁用）
iwpriv wlan0 set ByPassCac=1
```

**DBDC 控制**：

```bash
## 强制启用/禁用 DBDC（wifi.cfg 或 iwpriv）
iwpriv wlan0 driver "DbdcSetting=1"   # 1=enable, 0=disable
```

**BSS 状态转储**：`dumpBss()`（`swcr.c:317`）是 MTK 内部的 BSS 诊断函数，输出 SSID、OWN MAC、BSS Index、当前工作模式（`eCurrentOPMode`）、连接状态、PHY 参数等。它通过 `RaDebug` 命令触发：`iwpriv wlan0 driver "RaDebug=[wlanIdx]:[debugType]"`。在排查 AP 状态异常时，`dumpBss` 可以看到驱动内部的 BSS_INFO 结构体实际值——相当于酒店管理系统里的"房间状态总览表"，比 hostapd_cli 的 Framework 视角更底层。

## 5.5 双平台日志特征对比

同一个故障在 QCOM 和 MTK 上的表现不同——因为两者的状态机模型不同，日志关键字也不同。下表列出了常见故障场景在两个平台上的日志特征，排查时可以对照定位：

| 故障场景       | QCOM qcacld-3.0 日志特征                                     | MTK gen4m 日志特征                                           |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| AP 启动成功    | `sap_fsm: vdev X: SAP_STARTING => SAP_STARTED`（`sap_fsm.c:3686`） | `p2pRoleFsmRunEventStartAP` + `CMD_ID_UPDATE_BEACON_CONTENT` 下发成功 |
| DFS CAC 等待中 | `eSAP_DFS_CAC_START` 事件 + 60 秒定时器启动                  | `P2P_ROLE_STATE_DFS_CAC` 状态 + `kalP2pPreStartRdd()` 雷达检测启动 |
| 雷达检测到     | `eSAP_DFS_RADAR_DETECT` + `sap_radar_found_status=1` + `sap_random_channel_sel()` 选新信道 | `p2pRoleFsmRunEventRadarDet` + `kalP2PRddDetectUpdate()` 更新 NOL + `rDfsShutDownTimer` 5 秒超时 |
| CSA 信道切换   | `sap_fsm_send_csa_restart_req()` → `sme_csa_restart()` → `csr_csa_restart()` → Beacon 中 CSA IE 倒计时 | `p2pCsaControlFlow()` → `cnmSapChannelSwitchReq()` → Action 帧逐客户端通知 |
| NOL 命中拒绝   | `sap_validate_dfs_nol()` → `utils_dfs_is_freq_in_nol()` 返回 true → 信道拒绝 | 固件侧 domain info 过滤，host 驱动不直接感知 NOL             |
| 客户端关联成功 | `eSAP_STA_ASSOC_EVENT` 事件 + `sap_signal_hdd_event()` 通知 HDD | `p2pRoleFsmRunEventAAACompleteImpl()`（`p2p_role_fsm.c:3967`）更新 STA 状态 |
| BSS 停止       | `SAP_STARTED => SAP_STOPPING` + `wlansap_stop_bss()` → `eWNI_SME_STOP_BSS_RSP` | `p2pRoleFsmRunEventStopAP()` → `p2pFuncStopGO()` → BSS 去激活 |
| 启动超时       | `SME_CMD_START_BSS_TIMEOUT` (~11s) → recovery/non-recovery 分支 | 无显式超时（纯异步），错误通过后续操作回调上报               |

排查思路：QCOM 的日志以 `sap_fsm` 状态切换为主线，每个状态转换都有明确的日志输出，顺着状态链就能定位卡在哪一步。MTK 的日志以 P2P Role FSM 事件为主线，关注 `p2pRoleFsmRunEvent*` 系列函数的调用——如果某个事件处理函数没被调用，说明消息投递或 MBOX 队列出问题。两个平台的 hostapd 日志是一样的（`mgmt::auth`、`WPA: 1/4` 等），差异只在驱动层。

---

# 6 总结

这是一次完整的角色反转之旅。

从 Framework 层的 `SoftApManager` 状态机（Idle → WaitingForDriverCountryCode → Started）到 `setupInterfaceForSoftApMode()` 的 6 步接口创建，再到 hostapd 守护进程启动和 `hostapd_setup_bss()` 的逐模块初始化——每一步都在为新身份做准备。当 `ieee802_11_set_beacon()` 把第一帧 Beacon 推上空口，民宿正式挂牌。

客户端来时，`ieee802_11_mgmt()` 像个前台——Auth 来了给登记（`handle_auth()`），Assoc 来了给房卡（`handle_assoc()` + `hostapd_get_aid()` 分配 AID），加密房卡是 `wpa_auth_sta_associated()` 发出的 EAPOL 1/4。整个过程和 STA 模式是镜像对称的——但角色相反，AP 是发起 Auth Response 的一方，是发送 1/4 的一方，是验证 MIC 的一方。

客户端走时，有自己走的（Deauth/Disassoc）、被踢的（`ap_max_inactivity` 超时）、关门歇业的（`CMD_NO_ASSOCIATED_STATIONS_TIMEOUT` 空闲关闭）。三种方式，对应三种清理路径。

但一个问题还没回答：如果两个人同时在沙漠里开民宿——手机既开热点又连 P2P，Wi-Fi Direct 的 Group Owner 和 SAP 有什么区别？P2P 是另一个角色的故事，下一章我们从 P2P Discovery 开始讲起。

---

- Android Framework: [AOSP packages/modules/Wifi](https://cs.android.com/android/platform/superproject/main/+/main:packages/modules/Wifi/)
- hostapd: [wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/) (Apache 2.0 / BSD)
- QCOM 驱动: CodeLinaro qcacld-3.0 (Qualcomm Atheros Composite Linux Driver)
- MTK 驱动: MTK gen4m kernel-modules-connectivity-wlan-core
- 协议参考: IEEE 802.11-2024, Section 11.3 (AP Operation), Section 12.6 (Authentication/Association)
