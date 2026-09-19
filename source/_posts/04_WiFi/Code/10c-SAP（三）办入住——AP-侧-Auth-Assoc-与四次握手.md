---
title: SAP（三）办入住——AP 侧 Auth/Assoc 与四次握手
top: 1
related_posts: true
abbrlink: 3638f50d
date: 2026-09-19 21:35:35
tags:
  - Android WiFi
  - SAP
categories:
  - WiFi
  - Code
---

> 本文是 SAP 热点系列第三篇。第一篇讲了 Framework 层从点击到 hostapd AIDL，第二篇讲了 hostapd 启动、ACS 选频、Beacon 上线。本篇讲 Beacon 上线后发生的事：客户端来敲门了，hostapd 怎么在前台登记（Auth）、怎么分配房间号和房卡（Assoc+AID）、怎么加密发钥匙（四次握手）？
>
> 核心看点：角色反转。STA 模式下四次握手是收到 1/4 生成 SNonce 回复 2/4——你是敲门的人。AP 模式下是发送 1/4 等待对方回复 2/4 再验证 MIC——你是发钥匙的人。同样是四个 EAPOL 帧，两边的状态机推进方向完全对称但方向相反。

---

# 1 开篇：民宿开门后，客户来了

第一篇讲了怎么"开民宿"——选信道（选地）、挂 SSID（挂牌子）、发射 Beacon（点亮招牌灯）。现在民宿门开了，灯亮了，有人来敲门了。

如果把 WiFi 连接比作住民宿，STA 模式就是你带着行李走进大堂——看别人家招牌（扫描 Beacon）、选一家顺眼的（选网）、前台登记（Auth/Assoc）、拿房卡进门（四次握手）。整个流程里，客户端是被动的：AP 不来找你，是你去找 AP。

<!--more-->

打开热点这件事，角色完全反转。你不再是住客，你成了那个在沙漠里开民宿的老板。Beacon 上线意味着招牌亮起来了，接下来就是前台接待环节：

- **Auth（认证）**：登记身份证。"你是谁？"——客户端报上名来（发送 Auth 帧），hostapd 验证这个 MAC 地址在不在黑名单里、认证算法支不支持（Open/SAE/FT/FILS），然后点头放行（回复 Auth Response）。
- **Assoc（关联）**：分配房间号和房卡。"你能住哪？"——客户端提交能力清单（HT/VHT/HE Capabilities、RSN IE），hostapd 核对 SSID 是否匹配、能力是否兼容，然后用 bitmap 从 1-2007 的 AID 池里挑一间空房，把房卡号（AID）塞进 Assoc Response 还给客户端。
- **四次握手**：加密的钥匙交接。"这是你房间的钥匙，只有你能打开。"——hostapd 生成 ANonce，发送 EAPOL 1/4；客户端回 SNonce + MIC。hostapd 用 PMK + ANonce + SNonce + 双方 MAC 推导 PTK，验证 MIC 通过后，把 GTK 加密装进 EAPOL 3/4。客户端回 4/4 确认，门锁安装完毕，数据可以流通了。

角色反转不只发生在比喻层面，也直接反映在代码架构上。STA 模式的连接决策方是 wpa_supplicant——supplicant 本意就是"恳求者"，语义上就是被动方。AP 模式下负责这一切的是 hostapd，全称 Host AP Daemon——"宿主接入点守护进程"，它才是发号施令的一方。

一个关键差异贯穿全文：wpa_supplicant 的四次握手中，Supplicant 是**收到** EAPOL 1/4、**生成** SNonce 和 MIC、**发送** EAPOL 2/4——它是一个响应者。而 hostapd 作为 AP，四次握手中是**发送** EAPOL 1/4、**验证**对方 MIC、**安装** PTK/GTK——它是一个发起者。同样四次握手，角色完全相反。

当然，地址也是一个标志性差异：STA 模式的 MAC 地址可以随机化（MAC Randomization），而 AP 的 BSSID 必须稳定——否则客户端找不到你。民宿可以隐姓埋名，但门牌号不能天天换。

> **补充说明**：hostapd 的核心数据结构在系列第一篇中已详细介绍——`hostapd_data (hapd)` 是单个 BSS 的上下文，`hostapd_iface` 是物理接口抽象，`hostapd_bss_config` 是 BSS 级别配置，`sta_info` 是每个关联客户端的记录。本文直接使用这些结构体，不再重复定义。

---

# 2 管理帧入口：ieee802_11_mgmt 帧分发

管理帧到达 hostapd 后，第一步是分发——这个帧是 Auth、Assoc 还是 Deauth？hostapd 在 `ieee802_11_mgmt()`（`ieee802_11.c:6255`）中按 Frame Control 字段的 subtype 做 switch 分发：

```c
// src/ap/ieee802_11.c:6255
int ieee802_11_mgmt(struct hostapd_data *hapd, const u8 *buf, size_t len,
                    struct hostapd_frame_info *fi)
{
    struct ieee80211_mgmt *mgmt;
    u16 fc, stype;

    mgmt = (struct ieee80211_mgmt *) buf;
    fc = le_to_host16(mgmt->frame_control);
    stype = WLAN_FC_GET_STYPE(fc);

    // 防御：拒绝组播/零地址/自己的 SA
    if (is_multicast_ether_addr(mgmt->sa) || ...) return 0;

    // 按 subtype 分发
    switch (stype) {
    case WLAN_FC_STYPE_AUTH:
        wpa_printf(MSG_DEBUG, "mgmt::auth");
        handle_auth(hapd, mgmt, len, ssi_signal, 0);
        ret = 1; break;
    case WLAN_FC_STYPE_ASSOC_REQ:
        wpa_printf(MSG_DEBUG, "mgmt::assoc_req");
        handle_assoc(hapd, mgmt, len, 0, ssi_signal);
        ret = 1; break;
    case WLAN_FC_STYPE_REASSOC_REQ:
        wpa_printf(MSG_DEBUG, "mgmt::reassoc_req");
        handle_assoc(hapd, mgmt, len, 1, ssi_signal);
        ret = 1; break;
    case WLAN_FC_STYPE_DISASSOC:
        wpa_printf(MSG_DEBUG, "mgmt::disassoc");
        handle_disassoc(hapd, mgmt, len); ret = 1; break;
    case WLAN_FC_STYPE_DEAUTH:
        wpa_msg(hapd->msg_ctx, MSG_DEBUG, "mgmt::deauth");
        handle_deauth(hapd, mgmt, len); ret = 1; break;
    case WLAN_FC_STYPE_ACTION:
        wpa_printf(MSG_DEBUG, "mgmt::action");
        ret = handle_action(hapd, mgmt, len, freq); break;
    // ...
    }
    return ret;
}
```

对比 STA 模式：驱动通过 NL80211 事件将管理帧上报给 wpa_supplicant，在 `wpa_supplicant_event()` 中做事件分发。AP 模式路径更直接——hostapd 在 `ieee802_11_mgmt()` 中按 Frame Control 字段的 subtype 做 switch 分发，所有发给这个 BSSID 的帧都是它的事，不需要"选择目标"。

---

# 3 handle_auth：验证认证算法

AP 收到 Auth 帧，第一个校验点：客户端要求的认证算法，我支持吗？

```c
// src/ap/ieee802_11.c:2892
static void handle_auth(struct hostapd_data *hapd,
                        const struct ieee80211_mgmt *mgmt, size_t len,
                        int rssi, int from_queue)
{
    u16 auth_alg, auth_transaction, status_code;
    u16 resp = WLAN_STATUS_SUCCESS;
    struct sta_info *sta = NULL;

    auth_alg = le_to_host16(mgmt->u.auth.auth_alg);
    auth_transaction = le_to_host16(mgmt->u.auth.auth_transaction);

    // 1. 验证 AP 支持的认证算法
    if (!(((hapd->conf->auth_algs & WPA_AUTH_ALG_OPEN) &&
           auth_alg == WLAN_AUTH_OPEN) ||
          (hapd->conf->wpa && wpa_key_mgmt_ft(...) && auth_alg == WLAN_AUTH_FT) ||
          (hapd->conf->wpa && wpa_key_mgmt_sae(...) && auth_alg == WLAN_AUTH_SAE) ||
          // ...FILS、PASN 等...
          )) {
        resp = WLAN_STATUS_NOT_SUPPORTED_AUTH_ALG;
        goto fail;
    }

    // 2. ACL 检查
    res = ieee802_11_allowed_address(hapd, sa, (const u8 *) mgmt, len, &rad_info);
    if (res == HOSTAPD_ACL_REJECT) { resp = WLAN_STATUS_UNSPECIFIED_FAILURE; goto fail; }
    if (res == HOSTAPD_ACL_PENDING) return;

    // 3. 查 STA 是否已存在，不存在则 ap_sta_add()
    sta = ap_get_sta(hapd, sa);
    if (!sta) {
        sta = ap_sta_add(hapd, sa);
        if (!sta) { resp = WLAN_STATUS_AP_UNABLE_TO_HANDLE_NEW_STA; goto fail; }
    }

    // 4. 若驱动支持 full AP client state，刷新驱动侧 STA entry
    //    条件：FULL_AP_CLIENT_STATE_SUPP && !added_unassoc && !PASN
    //    added_unassoc=1 说明驱动已预注册（如外部控制接口触发），跳过

    // 5. 根据 auth_alg 分派具体处理
    // WLAN_AUTH_OPEN: 直接构造 Auth Response（status=0 表示成功）
    // WLAN_AUTH_FT: 调用 wpa_ft_process_auth() → handle_auth_ft_finish() 回调
    // WLAN_AUTH_SAE: 调用 handle_auth_sae() 处理 Commit/Confirm 帧
    // WLAN_AUTH_FILS_SK: 调用 handle_auth_fils() 处理快速初始链路建立
    // WLAN_AUTH_SHARED_KEY: 3 步握手（challenge-response）
    // ...省略详细分支...
}
```

核心校验链：算法是否支持 → MAC 地址是否在黑名单 → ACL 是否允许 → STA entry 是否可创建 → 具体算法处理。

用民宿视角看，这就是前台的逐级审核：先看住客出示的是哪种会员卡（Open System 是普通散客，SAE 是 VIP 专属通道，FT 是连锁酒店通用卡），再查黑名单（`ieee802_11_allowed_address` 做 MAC/ACL 过滤），最后在系统里建一条住客档案（`ap_sta_add` 创建 `sta_info`）。

这段代码的第 4 步（第 3244 行）藏着一个跨层连接点：`FULL_AP_CLIENT_STATE_SUPP(hapd->iface->drv_flags)` 检查驱动是否支持完整的 AP 客户端状态管理。支持该标志的驱动（如 QCOM qcacld）在 handle_auth 阶段就会通过 `ap_sta_add()` 同步向固件预注册 STA entry——固件提前知道这个客户端的 MAC 地址和能力参数，后续 Assoc 和四次握手时无需再做一次通知。不支持该标志的驱动（如 MTK gen4m 的部分配置）则只在 hostapd 用户态维护 `sta_info`，直到 PTKINITDONE 阶段安装密钥时才通过 nl80211 首次通知驱动"这个 STA 存在"。

这个差异直接影响 Auth 帧处理的延迟：QCOM 的固件在收到 Assoc Req 时已经预分配了 WTBL（WLAN Table）条目，而 MTK 需要在关联成功后才分配——对于高并发场景（如会议室多人同时连接），预注册能显著减少固件初始化开销。`added_unassoc` 标志位（`sta_info` 中的布尔字段）记录了驱动是否已通过外部控制接口（如 `hostapd_cli new_sta`）预注册过该 STA，为 1 时跳过重复注册。

Open System 认证最简单：Auth Transaction 1 收到 → 回复 Auth Transaction 2（含 status_code=0 表示成功）——相当于散客直接报身份证号，前台核对无误就放行。SAE（WPA3 Personal）复杂得多，由 `handle_auth_sae()`（`ieee802_11.c:1319`）处理 Commit 和 Confirm 两个阶段的多帧交互。收到 Auth Transaction 1（Commit 帧）时，hostapd 调用 `sae_parse_commit()`（`sae.c:2167`）逐字段解析：Finite Cyclic Group（椭圆曲线或有限域的选择）、commit-scalar 和 commit-element（客户端的密码学承诺值）。

解析完成后，`use_anti_clogging()`（`ieee802_11.c:771`）检查当前处于 SAE_COMMITTED 或 SAE_CONFIRMED 状态的并发会话数是否超过 `anti_clogging_threshold`。超过则回复 `WLAN_STATUS_ANTI_CLOGGING_TOKEN_REQ` 要求客户端先提交 token 再重发 Commit——这是 SAE 防 DoS 攻击的核心机制。

收到 Auth Transaction 2（Confirm 帧）时，`sae_check_confirm()`（`sae.c:2394`）用 KCK 重新计算 verifier 并与帧中的值比对。ECC 曲线走 `sae_cn_confirm_ecc()`（`sae.c:2308`），有限域走 `sae_cn_confirm_ffc()`（`sae.c:2331`）。比对通过才进入 SAE_ACCEPTED 状态。整个 SAE 握手就像 VIP 通道的双重身份核验：Commit 阶段交换密码学承诺（scalar + element），Confirm 阶段用 KCK 验证对方确实知道共享密码。

无论哪种认证算法，校验链上任何一步失败都会走 `goto fail` 分支。fail 分支做的事比"回复一个错误码"复杂得多——它要同时清理客户端和通知驱动。`send_deauth()`（`ieee802_11.c:4723`）构造一个 Deauth 帧（reason_code 由失败原因决定），通过 `hostapd_drv_send_mlme()` 发送给客户端。与此同时，`hostapd_drv_sta_deauth()`（`ap_drv_ops.c:865`）通过 nl80211 的 `NL80211_CMD_DEL_STATION` 命令通知内核驱动删除该 STA 的 entry。

驱动层的清理路径，QCOM 和 MTK 各不相同。QCOM 侧，`__wlan_hdd_cfg80211_del_station()`（`wlan_hdd_cfg80211.c:23665`）先检查 `is_deauth_in_progress` 防止重复 deauth，然后调用 `hdd_softap_deauth_current_sta()`（`wlan_hdd_cfg80211.c:23534`）。后者通过 `sme_send_disassoc_req_frame()` 发送 Disassoc 帧给固件，再调用 `wlansap_deauth_sta()` 触发 WMI peer delete。固件收到后释放 WTBL 中该 STA 的条目——后续帧到达时因无 WTBL 匹配而被直接丢弃。MTK 侧，`mtk_cfg80211_del_station()`（`gl_cfg80211.c:4659`）通过 `cnmGetStaRecByAddress()` 查找 STA Record，找到后调用 `cnmStaRecFree()` 释放。`cnmStaRecFree()` 内部会停止该 STA 的所有定时器、清除其 TX/RX 队列中的待发帧、并从 BSS 的 STA 列表中摘除。整条清理链：hostapd 发 Deauth 帧给客户端 → nl80211 通知驱动删除 STA entry → 固件释放 WTBL/STA Record → 该 MAC 地址的后续帧被固件静默丢弃。

---

# 4 handle_assoc：解析 IE、分配 AID

Auth 通过后，客户端提交能力清单。hostapd 要回答两个问题：能力兼容吗？房间还有空位吗？

```
handle_assoc()
  → 验证 STA 已认证（flags & WLAN_STA_AUTH）
  → 解析 Assoc Req 中的 IE：SSID、Supported Rates、HT/VHT/HE Capabilities、RSN
  → check_assoc_ies()：解析所有 IE（内部调用 check_ssid 验证 SSID 匹配）
  → hostapd_get_aid()：分配唯一 AID
  → 发送 Assoc Response（含 status code、AID、支持的速率）
```

真实代码（`ieee802_11.c:5353`）走的路径比伪代码复杂得多——光是"验证 STA 已认证"这一步就分了三个分支：

```c
// src/ap/ieee802_11.c:5353
static void handle_assoc(struct hostapd_data *hapd,
                         const struct ieee80211_mgmt *mgmt, size_t len,
                         int reassoc, int rssi)
{
    u16 capab_info, listen_interval, seq_ctrl, fc;
    int resp = WLAN_STATUS_SUCCESS;
    u16 reply_res = WLAN_STATUS_UNSPECIFIED_FAILURE;
    const u8 *pos;
    int left;
    struct sta_info *sta;

    // 帧长度校验：太短直接丢弃
    if (len < IEEE80211_HDRLEN + (reassoc ? sizeof(mgmt->u.reassoc_req) :
                                      sizeof(mgmt->u.assoc_req)))
        return;

    fc = le_to_host16(mgmt->frame_control);
    seq_ctrl = le_to_host16(mgmt->seq_ctrl);
    // 解析 Capability Info 和 Listen Interval
    capab_info = le_to_host16(mgmt->u.assoc_req.capab_info);
    listen_interval = le_to_host16(mgmt->u.assoc_req.listen_interval);
    pos = mgmt->u.assoc_req.variable;  // IE 起始位置
    left = len - (IEEE80211_HDRLEN + sizeof(mgmt->u.assoc_req));

    sta = ap_get_sta(hapd, mgmt->sa);

    // 认证检查：三个分支
    // (1) 802.11r FT over-the-DS：STA 已通过 FT Action 帧完成密钥派生，
    //     直接发送 Reassoc Req（可指向不同 BSSID），跳过 Auth
    //     后续 check_assoc_ies() 中 wpa_ft_validate_reassoc() 会验证
    //     RSN IE 中的 PMKID 是否匹配 PMKR1Name，确认 FT 密钥链有效
    if (sta && sta->auth_alg == WLAN_AUTH_FT &&
        (sta->flags & WLAN_STA_AUTH) == 0) {
        sta->flags |= WLAN_STA_AUTH;  // 标记为已认证
    // (2) 802.11ad DMG：不使用 Auth，Assoc 时直接创建 STA
    } else if (sta == NULL || (sta->flags & WLAN_STA_AUTH) == 0) {
        send_deauth(hapd, mgmt->sa,
                    WLAN_REASON_CLASS2_FRAME_FROM_NONAUTH_STA);
        return;
    }

    // 重复帧检测：同一 seq_ctrl 的 Assoc Req 不处理两次
    if ((fc & WLAN_FC_RETRY) && sta->last_seq_ctrl == seq_ctrl) return;
    sta->last_seq_ctrl = seq_ctrl;

    // TKIP 计数器措施期间拒绝新关联
    if (hapd->tkip_countermeasures) {
        resp = WLAN_STATUS_UNSPECIFIED_FAILURE; goto fail;
    }
    // Listen Interval 过大则拒绝
    if (listen_interval > hapd->conf->max_listen_interval) {
        resp = WLAN_STATUS_ASSOC_DENIED_LISTEN_INT_TOO_LARGE; goto fail;
    }

    // 解析所有 IE（SSID、Supported Rates、HT/VHT/HE Cap、RSN 等）
    resp = check_assoc_ies(hapd, sta, pos, left, reassoc);
    if (resp != WLAN_STATUS_SUCCESS) goto fail;

    // 分配 AID（bitmap 从 1-2007 池中取空位）
    if (hostapd_get_aid(hapd, sta) < 0) {
        resp = WLAN_STATUS_AP_UNABLE_TO_HANDLE_NEW_STA; goto fail;
    }

    sta->flags |= WLAN_STA_ASSOC_REQ_OK;

fail:
    // 构造并发送 Assoc Response
    if (resp >= 0)
        reply_res = send_assoc_resp(hapd, sta, mgmt->sa, resp, reassoc,
                                    pos, left, rssi, omit_rsnxe, true);
}
```

和 handle_auth 相比，handle_assoc 的核心校验链更长：先验帧长度（防畸形帧），再验认证状态（已 Auth 才能 Assoc），再验 TKIP 和 Listen Interval 两个前置条件。然后 `check_assoc_ies()` 解析全部 IE——内部调用 `ieee802_11_parse_elems()` 拆解 TLV，逐项检查 SSID（`check_ssid()`）、Supported Rates、HT/VHT/HE Capabilities、RSN IE。最后 `hostapd_get_aid()` 分配 AID，`send_assoc_resp()` 构造并发送 Assoc Response 帧。

Assoc 失败时的处理和 Auth 失败有一个关键区别：Assoc 失败不删除 STA entry。`fail` 分支通过 `send_assoc_resp()` 发送一个携带错误 status code 的 Assoc Response（如 `WLAN_STATUS_ASSOC_DENIED_LISTEN_INT_TOO_LARGE` 表示 Listen Interval 过大，`WLAN_STATUS_AP_UNABLE_TO_HANDLE_NEW_STA` 表示 AID 耗尽），但 STA 仍然保持 `WLAN_STA_AUTH` 状态——客户端可以重新提交 Assoc Request 而无需从 Auth 重新开始。这个设计体现了 802.11 的状态机语义：Auth 和 Assoc 是两个独立的状态转换，Assoc 失败不回退 Auth 状态。

唯一需要彻底踢掉 STA 的场景是 TKIP countermeasures 期间（`hapd->tkip_countermeasures` 为 true），此时 handle_assoc 直接 `goto fail` 返回 `WLAN_STATUS_UNSPECIFIED_FAILURE`，后续由 `hostapd_new_assoc_sta()` 中的 TKIP 检查（§5）执行 `hostapd_drv_sta_deauth()` 发送 Deauth 并通知驱动清理 STA entry——驱动侧的清理路径与 Auth 失败相同（§3 已述）。

`hostapd_get_aid()` 的实现用 bitmap 记录已分配的 AID：

```c
// src/ap/ieee802_11.c:3417
int hostapd_get_aid(struct hostapd_data *hapd, struct sta_info *sta)
{
    int i, j = 32, aid;
    hapd = hostapd_mbssid_get_tx_bss(hapd);

    if (sta->aid > 0) {  // 已有 AID，直接返回
        wpa_printf(MSG_DEBUG, "  old AID %d", sta->aid);
        return 0;
    }

    for (i = 0; i < AID_WORDS; i++) {
        u32 aid_word = hostapd_get_aid_word(hapd, sta, i);
        if (aid_word == (u32) -1) continue;  // 这 32 个全占满
        for (j = 0; j < 32; j++) {
            if (!(aid_word & BIT(j))) break;  // 找到空位
        }
        if (j < 32) break;
    }
    if (j == 32) return -1;                  // AID 耗尽（最多 2007）
    aid = i * 32 + j + (1 << hostapd_max_bssid_indicator(hapd));
    if (aid > 2007) return -1;

    sta->aid = aid;
    hapd->sta_aid[i] |= BIT(j);              // 置位占用
    return 0;
}
```

AID（Association ID）范围是 1-2007（802.11 标准限制），用 bitmap 管理分配。`hostapd_mbssid_get_tx_bss()` 确保 Multi-BSSID 场景下所有 BSS 共享同一个 AID 池——发射 BSS 和非发射 BSS 的客户端不能冲突。AID 就是房间号，bitmap 是前台的房态表——哪间房空着、哪间已入住，一目了然。Multi-BSSID 共享 AID 池，相当于同一栋楼里多个楼层的前台共用一套房间编号系统，不能给不同楼层的客人分到同一个房间号。

---

# 5 关联后处理：hostapd_new_assoc_sta

关联成功了，但数据还不能流通——接下来走明文还是加密？

```c
// src/ap/hostapd.c:4055
void hostapd_new_assoc_sta(struct hostapd_data *hapd, struct sta_info *sta,
                           int reassoc)
{
    // 1. TKIP countermeasures 期间拒绝新 STA
    if (hapd->tkip_countermeasures) {
        hostapd_drv_sta_deauth(hapd, sta->addr, WLAN_REASON_MICHAEL_MIC_FAILURE);
        return;
    }

    // 2. 清除断开超时
    ap_sta_clear_disconnect_timeouts(hapd, sta);

    // 3. 无安全 = 直接授权
    if (!hapd->conf->ieee802_1x && !hapd->conf->wpa && !hapd->conf->osen) {
        ap_sta_set_authorized(hapd, sta, 1);
        os_get_reltime(&sta->connected_time);
        accounting_sta_start(hapd, sta);
    }

    // 4. IEEE 802.1X 认证
    ieee802_1x_new_station(hapd, sta);

    // 5. 启动 WPA 四次握手
    if (reassoc) {
        if (sta->auth_alg != WLAN_AUTH_FT && ...)
            wpa_auth_sm_event(sta->wpa_sm, WPA_REAUTH);
    } else if (!(hapd->iface->drv_flags2 &
                 WPA_DRIVER_FLAGS2_4WAY_HANDSHAKE_AP_PSK)) {
        // 未 offload 给驱动 → hostapd 自己处理
        wpa_auth_sta_associated(hapd->wpa_auth, sta->wpa_sm);
    }

    // 6. 启动 ap_max_inactivity 计时器
    if (!(hapd->iface->drv_flags & WPA_DRIVER_FLAGS_INACTIVITY_TIMER)) {
        eloop_register_timeout(hapd->conf->ap_max_inactivity, 0,
                               ap_handle_timer, hapd, sta);
    }
}
```

用民宿视角看，这一步是门卫放行、客人走进前台之后：前台确认住客已经登记入住，决定是直接发房卡（无加密）还是先走钥匙交接流程（WPA 加密）。

关键分支：

- 无加密（Open）：直接授权，不握手。`ap_sta_set_authorized()` 告诉驱动这个 STA 可以开始收发数据帧。
- WPA 加密且驱动 non-offload：调用 `wpa_auth_sta_associated()` 启动四次握手。
- `WPA_DRIVER_FLAGS2_4WAY_HANDSHAKE_AP_PSK` 标志位：一些驱动（如 QCOM 的 FullMAC 固件）在固件内完成了四次握手，hostapd 不用自己处理。
- TKIP countermeasures 期间：直接 `hostapd_drv_sta_deauth()` 踢掉 STA 并返回——这是最后一道防线，确保不会有 STA 在 countermeasures 窗口内完成握手。

TKIP countermeasures 的跨层传播链值得展开。触发源是 `michael_mic_failure()`（`tkip_countermeasures.c:69`）——当 60 秒内检测到两次 Michael MIC 失败（来自驱动的 `EVENT_MICHAEL_MIC_FAILURE` 通知）时，调用 `ieee80211_tkip_countermeasures_start()`（`tkip_countermeasures.c:34`）。该函数执行三层操作：第一层，`wpa_auth_countermeasures_start()` 通知 WPA 状态机进入对策模式，递增 `dot11RSNAStatsTKIPCounterMeasuresInvoked` 计数器。第二层，`hostapd_drv_set_countermeasures(hapd, 1)` 通过 nl80211 通知驱动启用对策——QCOM 侧驱动收到后对所有使用 TKIP 的 STA 静默（停止转发数据帧），MTK 侧类似。第三层，遍历 `hapd->sta_list`，对每个已认证 STA 发送 Deauth（reason=`WLAN_REASON_MICHAEL_MIC_FAILURE`）并通知驱动删除 STA entry，最后 `ap_free_sta()` 释放内存。

对策不是永久生效的——它有一个明确的关闭时机。60 秒后 `ieee80211_tkip_countermeasures_stop()`（`tkip_countermeasures.c:23`）清除标志并通知驱动恢复正常——这 60 秒是 802.11 规范规定的强制封锁期。

三层检查确保 countermeasures 期间不会有漏网之鱼：handle_auth 中的检查（`ieee802_11.c:2972`）在认证阶段拦截，handle_assoc 中的检查（`ieee802_11.c:5538`）在关联阶段拦截，hostapd_new_assoc_sta 中的检查（本节代码）在关联后处理阶段兜底。

这个标志位决定了四次握手的"执行地点"——是 hostapd 用户态还是驱动/固件内部。QCOM FullMAC 方案中，固件内置了完整的 WPA 状态机，hostapd 只需在 Assoc 完成后告诉固件"可以开始握手了"，四个 EAPOL 帧的收发、PTK 推导、MIC 验证全部在固件内完成，hostapd 通过 `wpa_auth_sm_event(sm, WPA_ASSOC)` 收到通知时握手已经结束。MTK SoftMAC 方案则没有这个标志——四次握手必须由 hostapd 驱动：hostapd 构造 EAPOL 1/4 → 通过 nl80211 发送到驱动 → 驱动透传到空口 → 客户端回复的 EAPOL 2/4 从驱动透传回 hostapd → hostapd 推导 PTK 验证 MIC → 构造 3/4 → 再透传到驱动。两种方案的性能差异在高并发场景下尤为明显：FullMAC 固件的握手延迟在微秒级（固件内部总线），而 SoftMAC 方案的 EAPOL 帧每次都要穿越内核态-用户态边界，延迟在毫秒级。

代码中还有一个容易忽略的异常路径：`ap_max_inactivity` 计时器。这个计时器是前台给沉默房客设的清退闹钟——关联后注册，负责清理"住进来就再也不说话"的静默 STA。`ap_handle_timer()`（`sta_info.c:530`）是一个四阶段状态机，逐步升级断连力度。第一阶段，先发一个 NullFunc 数据帧探测 STA 是否还活着，同时通过 `hostapd_drv_get_inact_sec()` 查询驱动侧的不活跃时间——若驱动不支持此查询（返回 -1），则延长一个 `max_inactivity` 周期再试。

第二阶段 `STA_DISASSOC`，若 STA 未响应探测，发送 Disassoc 帧（reason=`WLAN_REASON_DISASSOC_DUE_TO_INACTIVITY`），清除 `WLAN_STA_ASSOC` 标志，停止 802.1X 计费，等 `AP_DISASSOC_DELAY` 秒给 STA 重连窗口。

第三阶段 `STA_DEAUTH`，调用 `hostapd_drv_sta_deauth()`（`ap_drv_ops.c:865`）发送 Deauth 帧并通过 nl80211 通知驱动删除 STA entry。QCOM 侧走 `__wlan_hdd_cfg80211_del_station()`（`wlan_hdd_cfg80211.c:23665`）→ `hdd_softap_deauth_current_sta()` → `wlansap_deauth_sta()` → WMI peer delete，固件释放 WTBL 条目。MTK 侧走 `mtk_cfg80211_del_station()`（`gl_cfg80211.c:4659`）→ `cnmStaRecFree()` 释放 STA Record 并清除其 TX/RX 队列。第四阶段 `STA_REMOVE`，`ap_free_sta()` 释放内存中的 `sta_info` 及其关联的 WPA 状态机、PMKSA 缓存等资源。整个过程从首次检测到不活跃到最终释放，总耗时约 `ap_max_inactivity + AP_DISASSOC_DELAY + AP_DEAUTH_DELAY` 秒——默认配置下约 310 秒（300+5+5）。驱动侧释放 WTBL/STA Record 后，该 STA 的后续帧到达时固件直接丢弃，直到重新走完整的 Auth→Assoc→四次握手流程。

---

# 6 AP 侧四次握手

钥匙交接的四个 EAPOL 帧，每一步 hostapd 在做什么计算？`wpa_auth_sta_associated()`（`wpa_auth.c:964`）启动 AP 侧 WPA 状态机：

```c
// src/ap/wpa_auth.c:964
int wpa_auth_sta_associated(struct wpa_authenticator *wpa_auth,
                            struct wpa_state_machine *sm)
{
    if (!wpa_auth || !wpa_auth->conf.wpa || !sm) return -1;

    // FT 已完成 → 直接跳到 PTKINITDONE
    if (sm->ft_completed) {
        sm->wpa_ptk_state = WPA_PTK_PTKINITDONE;
        sm->Pair = true;
        return 0;
    }
    // FILS 已完成 → 同上
    if (sm->fils_completed) {
        sm->wpa_ptk_state = WPA_PTK_PTKINITDONE;
        sm->Pair = true;
        return 0;
    }

    // 启动状态机
    if (sm->started) {
        os_memset(&sm->key_replay, 0, sizeof(sm->key_replay));
        sm->ReAuthenticationRequest = true;
        return wpa_sm_step(sm);
    }

    sm->started = 1;
    sm->Init = true;
    if (wpa_sm_step(sm) == 1) return 1;
    sm->Init = false;
    sm->AuthenticationRequest = true;
    return wpa_sm_step(sm);
}
```

`wpa_sm_step()`（`wpa_auth.c:6064`）驱动 AP 侧 WPA PTK 状态机——它在一个 `do-while` 循环中反复执行 `SM_STEP_RUN(WPA_PTK)` 和 `SM_STEP_RUN(WPA_PTK_GROUP)`，直到状态不再变化（`sm->changed == false`）。每次循环只做一个状态转换，但循环本身会持续推进直到稳态。

完整的 WPA_PTK 状态机有 12 个状态（`wpa_auth_i.h:27`），核心路径是：

```
// src/ap/wpa_auth.c — SM_STEP(WPA_PTK) 状态转换
INITPMK / INITPSK  ←── PMK 就绪（802.1X 取 EAP 密钥，PSK 直接用预共享密钥）
    │
    ▼
PTKSTART           ── 发送 EAPOL 1/4（ANonce + PMKID KDE）
    │                  等待 STA 回复 EAPOL 2/4
    │ 收到 2/4（SNonce + MIC）
    ▼
PTKCALCNEGOTIATING ── 从候选 PSK 中逐个推导 PTK（wpa_derive_ptk）
    │                  用推导出的 PTK 验证 M2 的 MIC（wpa_verify_key_mic）
    │ MIC 验证通过
    ▼
PTKCALCNEGOTIATING2── 桥接状态，无条件跳转
    │
    ▼
PTKINITNEGOTIATING ── 发送 EAPOL 3/4（RSN IE + GTK KDE + MIC）
    │                  等待 STA 回复 EAPOL 4/4
    │ 收到 4/4（ACK MIC 验证通过）
    ▼
PTKINITDONE        ── 安装 PTK/GTK → 驱动授权 → 数据帧可收发
```

上面只画了核心 6 状态的正常握手路径。完整的 12 状态还包括 6 个生命周期管理状态。`INITIALIZE` 是状态机的入口和复位态（`sm->Init` 为 true 时无条件进入）。`AUTHENTICATION` 和 `AUTHENTICATION2` 处理 PMK 来源的分派——`AUTHENTICATION2` 根据密钥管理类型选择 `INITPMK`（802.1X 从 EAP 取密钥）或 `INITPSK`（PSK/SAE/OWE 直接用预共享密钥），若两者都不满足则进 `DISCONNECT`。`INITPMK` 等待 EAP 层的 `keyAvailable` 信号，若超时未获得则进 `DISCONNECT` 并递增 `dot11RSNA4WayHandshakeFailures` 计数器。`INITPSK` 调用 `wpa_auth_get_psk()` 查找匹配的 PSK，SAE 场景下还会检查 `pmksa` 缓存。`DISCONNECT` 是断连中转态（无条件跳到 `DISCONNECTED`），`DISCONNECTED` 执行清理后回到 `INITIALIZE`。整个生命周期形成一个环：正常路径是 `INITIALIZE → AUTHENTICATION → AUTHENTICATION2 → INITPMK/INITPSK → PTKSTART → ... → PTKINITDONE`，异常路径是 `... → DISCONNECT → DISCONNECTED → INITIALIZE`。

`sm->Disconnect`、`sm->DeauthenticationRequest`、`sm->AuthenticationRequest`、`sm->ReAuthenticationRequest`、`sm->PTKRequest` 五个布尔标志位是状态机的"外部输入"。它们在 `SM_STEP` 函数的 if-else 链中按优先级检查（`sm->Disconnect` 在 `wpa_auth.c:5179` 检查、`sm->DeauthenticationRequest` 在 `wpa_auth.c:5185` 检查），优先于 switch-case 的状态内转换。这意味着即使状态机当前处于 `PTKINITDONE`（握手已完成），如果 hostapd 收到 Deauth 帧设置了 `sm->DeauthenticationRequest`，下一次 `SM_STEP` 就会立即跳出 PTKINITDONE 进入 `DISCONNECTED`。

每个状态的转换条件由 `SM_STEP(WPA_PTK)` 函数（`wpa_auth.c:5172`）中的 switch-case 定义。下面这张状态机图把上面的 ASCII 版本可视化了：

![WPA_PTK 状态机（AP 侧）](assets/10c-SAP%EF%BC%88%E4%B8%89%EF%BC%89%E5%8A%9E%E5%85%A5%E4%BD%8F%E2%80%94%E2%80%94AP-%E4%BE%A7-Auth-Assoc-%E4%B8%8E%E5%9B%9B%E6%AC%A1%E6%8F%A1%E6%89%8B/10c-wpa-ptk-state-machine.svg)

这个状态机可以理解为钥匙交接的流水线：M1 到 M4 是四道工序，每道工序由一个工位负责——PTKSTART 负责生成钥匙坯（ANonce），PTKCALCNEGOTIATING 负责配钥匙并验证齿纹（推导 PTK、验 MIC），PTKINITNEGOTIATING 负责把备用钥匙加密打包（封装 GTK），PTKINITDONE 负责交付并激活门锁。如果某一工序的工件在传输中丢失（EAPOL 帧未到达），`TimeoutCtr` 控制重传——同一工位最多重试 `wpa_pairwise_update_count` 次（默认 4 次），超过则整条产线停机（跳到 `DISCONNECT`）。

**PTKSTART：构建 M1**

进入 `PTKSTART`（`wpa_auth.c:2715`）后，第一件事是检查重传上限：`sm->TimeoutCtr` 自增后判断是否超过 `wpa_pairwise_update_count`（`wpa_auth.c:2733`，超过则直接返回，后续由超时逻辑触发断连）。通过检查后，hostapd 生成 ANonce（随机 32 字节），开始组装 EAPOL-Key M1 的 Key Data 字段。

M1 的 Key Data 里放什么，取决于认证方式。对于 WPA2-802.1X/SAE/OWE 场景，需要附加 PMKID KDE——PMKID 的来源有四条路径：(1) 若 `sm->pmksa` 非空（PMKSA 缓存命中），直接取缓存条目中的 `pmkid` 字段；(2) SAE 场景下，`sm->pmkid_set` 为 true 时使用 SAE Commit/Confirm 阶段派生的 `sm->pmkid`；(3) FT 握手完成时不附加 PMKID（FT 有自己的密钥标识机制 PMKR1Name）；(4) 以上都不满足时，调用 `rsn_pmkid()` 从 PMK + AA + SPA 实时推导。PSK 模式下不附加 PMKID——这是 802.11 规范的安全建议，避免暴露可用于离线字典攻击的标识符。MLO 场景则额外附加 MAC Address KDE（`RSN_KEY_DATA_MAC_ADDR`，携带 `mld_addr`）。

Key Data 组装完成后就是发送。调用 `wpa_send_eapol()`（定义在 `wpa_auth.c:2199`，PTKSTART 中调用点在 line 2866），Key Info 标志位设为 `ACK | KEY_TYPE`（表示 AP 发出的 pairwise key 消息）；若 pairwise 已安装且非 WPA1 模式，还附加 `SECURE` 标志。

**PTKCALCNEGOTIATING：推导 PTK、验证 M2**

这是四次握手的核心计算环节。PTKCALCNEGOTIATING 阶段（`wpa_auth.c:3639`），hostapd 从 STA 的 M2 中提取 SNonce，然后进入一个循环：对每个候选 PMK（PSK 模式下可能有多个 PSK），调用 `wpa_derive_ptk()`（`wpa_auth.c:2872`）用 `PRF-X(PMK, "Pairwise key expansion", min(AA,SPA) || max(AA,SPA) || min(ANonce,SNonce) || max(ANonce,SNonce))` 推导出 PTK，再调用 `wpa_verify_key_mic()`（`wpa_auth.c:2263`）用 PTK 的 KCK 部分验证 M2 的 MIC（算法由 AKMP 决定：WPA2-PSK 用 HMAC-SHA1，SAE/FT 用 HMAC-SHA256）。验证通过则跳出循环，将 PMK 保存到 `sm->PMK`；所有候选都失败则记录 "invalid MIC in msg 2/4" 并丢弃。

验证通过后，hostapd 解密 M2 的 Key Data 字段（用 PTK 的 KEK 部分做 AES Key Unwrap），解析其中的 RSN IE 并与 STA 关联时提交的 RSN IE 做比对——如果不一致，说明中间人篡改了 IE，握手终止。

**PTKINITNEGOTIATING：构建 M3**

在 PTKINITNEGOTIATING 状态（`wpa_auth.c:4672`），hostapd 组装 EAPOL-Key M3。Key Data 字段包含：RSN IE（从 `wpa_auth->wpa_ie` 取）、GTK KDE（用 PTK 的 KEK 部分 AES Key Wrap 加密，GTK 来自 group state machine 的 `gsm->GTK[gsm->GN-1]`）、以及可选的 IGTK KDE（802.11w 管理帧保护）和 OCI KDE。

Key Info 标志位设为 `ACK | INSTALL | KEY_TYPE | SECURE | MIC`——`INSTALL` 告诉 STA "安装密钥"，`SECURE` 表示所有密钥材料已加密。最后调用 `wpa_send_eapol()` 发送。

**PTKINITDONE：安装密钥、授权 STA**

收到 M4 后，`SM_STEP` 的 switch-case 在 PTKINITNEGOTIATING 分支检查四个条件——`sm->EAPOLKeyReceived`（确实收到了 EAPOL 帧）、`!sm->EAPOLKeyRequest`（不是 Request 帧）、`sm->EAPOLKeyPairwise`（是 pairwise key 消息）、`sm->MICVerified`（MIC 验证通过）——全部满足才进入 `PTKINITDONE`（`wpa_auth.c:5081`）。在这个状态中，hostapd 调用 `wpa_auth_set_key()`（`wpa_auth.c:282`）将 PTK 的 TK（Temporal Key）部分安装到驱动。这个内联函数通过回调 `cb->set_key()` 调用 `hostapd_wpa_auth_set_key()`（`wpa_auth_glue.c:509`），后者再调用 `hostapd_drv_set_key()`，最终通过 nl80211 的 `NL80211_CMD_NEW_KEY` 命令将密钥材料发送到内核。

密钥从 nl80211 到固件的"最后一公里"，QCOM 和 MTK 走的是两条完全不同的路径。QCOM 侧，`NL80211_CMD_NEW_KEY` 触发 `wlan_hdd_cfg80211_add_key()`（`wlan_hdd_cfg80211.c:22410`），对于 SAP 模式调用 `wlan_hdd_add_key_sap()` → `wlan_cfg80211_crypto_add_key()`（UMAC crypto 框架）。密钥通过 UMAC 内部总线直接安装到固件的 WTBL 条目中，固件用 WTBL 中的 TK 对后续数据帧做 AES-CCMP 加解密。MTK 侧走的是"短路径"——hostapd 的 `hostapd_wpa_auth_set_key()`（`wpa_auth_glue.c:739`）直接构造 `CMD_802_11_KEY` 结构体（定义在 `wsys_cmd_handler_fw.h:783`），核心字段包括 `ucAlgorithmId`（算法 ID）、`ucKeyId`（密钥索引）、`ucKeyLen`（密钥长度）、`aucPeerAddr`（对端 MAC 地址）、`ucWlanIndex`（WTBL 索引）、`aucKeyMaterial[32]`（密钥材料本体）、`ucKeyType`（0=GTK，1=PTK）、`ucIsAuthenticator`（1=AP 侧）。结构体填充完成后通过 `wpas_evt_cfg80211_add_key()` 发送固件命令，固件在 WTBL 中更新对应条目。两条路径的共同终点都是固件的 WTBL，但 QCOM 走标准 nl80211 → cfg80211 → UMAC crypto 三层抽象，MTK 走 hostapd 直接构造固件命令的短路径——后者少了两次内核态上下文切换，但牺牲了标准接口的可移植性。

然后设置 `WPA_EAPOL_authorized = 1`——这触发一条三级回调链：`hostapd_wpa_auth_set_eapol()`（`wpa_auth_glue.c:337`）在 `WPA_EAPOL_authorized` case 中调用 `ieee802_1x_set_sta_authorized()`（`ieee802_1x.c:197`），后者内部直接调用 `ieee802_1x_set_authorized()`（`ieee802_1x.c:112`），由该函数调用 `ap_sta_set_authorized_flag()` + `ap_sta_set_authorized_event()`（`sta_info.c:1471/1500`）——驱动收到通知，在内部标记该 STA 的 `WLAN_STA_AUTHORIZED` 标志位。三级回调走完，相当于前台把房卡激活、门锁通电，驱动开始转发这个住客的数据帧。

把密钥层级串起来。四次握手的目的是从 PMK（Pairwise Master Key，由 PSK 直接提供或 SAE/802.1X 握手派生）推导出 PTK（Pairwise Transient Key）。PTK 被拆分为三部分——KCK（Key Confirmation Key，用于验证 EAPOL-Key 帧的 MIC）、KEK（Key Encryption Key，用于加密 EAPOL-Key 帧的 Key Data 字段）、TK（Temporal Key，安装到驱动用于加密实际数据帧）。`wpa_ptk` 结构体（`wpa_common.h:257`）用 `kck[]`、`kek[]`、`tk[]` 三个数组存储，长度由 `kck_len`、`kek_len`、`tk_len` 控制——WPA2-PSK+CCMP 下分别为 16、16、16 字节，SAE+CCMP 下为 32、32、16 字节（SHA-256 产出更长的密钥材料）。PTKINITDONE 中安装到驱动的只是 TK 部分，KCK 和 KEK 留在 hostapd 内部用于后续 EAPOL-Key 交互。

除 PTK 外，`wpa_group` 状态机（`wpa_auth_i.h:200`）维护三类组密钥：`GTK[2][WPA_GTK_MAX_LEN]`（Group Temporal Key，加密组播/广播帧，双缓冲用于密钥轮换——`GN` 指示当前使用的索引，`GM` 指示正在分发的索引）、`IGTK[2][WPA_IGTK_MAX_LEN]`（Integrity GTK，保护管理帧完整性，802.11w MFP）、`BIGTK[2][WPA_IGTK_MAX_LEN]`（Beacon IGTK，保护 Beacon 帧完整性）。GTK 在 EAPOL 3/4 中用 KEK 加密后分发给 STA——封装的是 `gsm->GTK[gsm->GN-1]`（当前索引的最新密钥），全部分发完成后 `wpa_group_update_gtk()`（`wpa_auth.c:5843`）交换 `GM`/`GN`，旧密钥让位给下一轮。组密钥 1/2 重传由 `GTimeoutCtr` 计数，超 `wpa_group_update_count` 即放弃重发（`wpa_auth.c:5341`）。IGTK/BIGTK 在 3/4 的 Key Data 字段中作为 KDE 附带。

四类密钥各司其职：PTK 保护单播数据帧，GTK 保护组播数据帧，IGTK 保护管理帧，BIGTK 保护 Beacon 帧——每一层都有独立的密钥生命周期和轮换机制。

和 STA 模式的核心差异总结：

| 步骤          | STA（wpa_supplicant）                       | AP（hostapd）                      |
| ------------- | ------------------------------------------- | ---------------------------------- |
| 握手指令      | 等 AP 发 1/4                                | 主动发 1/4                         |
| ANonce/SNonce | 收到 ANonce，生成 SNonce                    | 生成 ANonce，收到 SNonce           |
| MIC 生成      | 生成 MIC 用于 2/4，验证 AP 的 MIC           | 验证 STA 的 MIC，生成 MIC 用于 3/4 |
| GTK           | 收到 3/4 后安装                             | 生成 GTK，在 3/4 中分发给 STA      |
| 结束标志      | 收到 3/4 后发 4/4，安装 PTK，状态→COMPLETED | 收到 4/4，安装 PTK/GTK，标记已授权 |

把上面所有碎片串起来，从客户端敲门到数据帧可转发，完整事件序列是这样的：

1. **Client → AP：Auth Request** — 客户端发送 Authentication 帧（Open System / SAE / FT）
2. **AP 内部：`ieee802_11_mgmt()` → `handle_auth()`（§3）** — 验证认证算法 → ACL 检查 → `ap_sta_add()` 创建 `sta_info` → 构造 Auth Response（status=0）
3. **AP → Client：Auth Response** — 认证通过
4. **Client → AP：Assoc Request** — 客户端提交 HT/VHT/HE Capabilities、RSN IE
5. **AP 内部：`handle_assoc()`（§4）** — 解析 IE → `check_assoc_ies()` 验证 SSID + 能力 → `hostapd_get_aid()` 分配 AID → 构造 Assoc Response
6. **AP → Client：Assoc Response** — 携带 AID、支持的速率
7. **AP 内部：`hostapd_new_assoc_sta()`（§5）** — 判断加密模式 → 无加密直接授权；WPA 加密且驱动 non-offload → `wpa_auth_sta_associated()` 启动四次握手
8. **AP → Client：EAPOL 1/4** — `PTKSTART`：生成 ANonce，附加 PMKID KDE
9. **Client → AP：EAPOL 2/4** — 客户端回 SNonce + MIC
10. **AP 内部：`PTKCALCNEGOTIATING`（§6）** — 逐候选 PMK 推导 PTK → 验证 M2 的 MIC → 解密并比对 RSN IE
11. **AP → Client：EAPOL 3/4** — `PTKINITNEGOTIATING`：封装 RSN IE + GTK KDE（AES Key Wrap 加密）+ 可选 IGTK
12. **Client → AP：EAPOL 4/4** — 客户端确认，安装 PTK
13. **AP 内部：`PTKINITDONE`（§6）** — `wpa_auth_set_key()` 安装 TK 到驱动 → `WPA_EAPOL_authorized=1` → 三级回调链 → 驱动标记 `WLAN_STA_AUTHORIZED` → **数据帧可收发**

13 步走完，从"招牌灯亮起"到"房卡激活、门锁通电"——民宿老板的前台接待流程到此结束，接下来就是住客在房间里自由活动（数据帧收发）了。下面这张序列图把 13 步可视化：

![Auth → Assoc → 四次握手：13 步事件序列](assets/10c-SAP%EF%BC%88%E4%B8%89%EF%BC%89%E5%8A%9E%E5%85%A5%E4%BD%8F%E2%80%94%E2%80%94AP-%E4%BE%A7-Auth-Assoc-%E4%B8%8E%E5%9B%9B%E6%AC%A1%E6%8F%A1%E6%89%8B/10c-13-step-sequence.svg)

---

# 7 驱动层：Auth/Assoc 帧的接收路径

前面六节讲的都是 hostapd 用户态的处理逻辑。但 Auth/Assoc 帧不是凭空出现在 hostapd 面前的——它们要经过驱动层的层层传递，从固件（Firmware）到内核驱动，再到 cfg80211/nl80211，最后才到达 hostapd。QCOM 和 MTK 的驱动架构差异很大，但最终都汇聚到同一个 nl80211 接口。

## 7.1 QCOM qcacld-3.0：WMI → WMA → mgmt_txrx → cfg80211

QCOM 的 AP 侧管理帧接收路径分四层：固件通过 WMI 事件上报、WMA 层提取参数、mgmt_txrx 框架分发、cfg80211 通知用户态。

固件（Firmware）收到客户端发来的 Auth/Assoc 帧后，通过 WMI 事件 `WMI_MGMT_RX_EVENTID` 上报给主机驱动。WMA 层注册了该事件的处理函数 `wma_mgmt_rx_process()`（`wma_mgmt.c:3863`），它从 WMI 数据中调用 `wmi_extract_mgmt_rx_params()` 提取 `mgmt_rx_event_params` 结构体（`wlan_mgmt_txrx_utils_api.h:1064`）。核心字段包括：`chan_freq`（接收频率）、`snr`（信噪比）、`buf_len`（帧长度）、`rate`（接收速率）、`phy_mode`（物理层模式）、`status`（帧状态码）、`rssi`（信号强度）、`tsf_delta`（TSF 时间戳差值，MLO 场景下用于多链路帧重排序）、`pdev_id`（物理设备 ID）。

提取完成后，`wma_mgmt_rx_process()` 调用 `qdf_nbuf_alloc()` 分配网络缓冲区——注意分配时额外预留 100 字节（`RESERVE_BYTES`），用于两个特殊场景：(1) 某些 AP 的 RSN IE 长度字段多填了 2 字节但没填 capability 数据，驱动需要通过 `sir_validate_and_rectify_ies()` 修补；(2) RMF 处理中 CCMP header 的内存重叠防护。缓冲区分配后通过 `wma_mem_endianness_based_copy()` 拷贝帧内容，设置协议类型为 `ETH_P_CONTROL`，最后调用 `mgmt_txrx_rx_handler()`（`wma_mgmt.c:3959`）将帧送入 mgmt_txrx 框架。

mgmt_txrx 框架根据注册的回调函数分发帧。对于 P2P/AP 模式，回调函数是 `tgt_p2p_mgmt_frame_rx_cb()`（`wlan_p2p_tgt_api.c:284`），它将帧封装为 `p2p_rx_mgmt_frame` 结构体，通过 scheduler 异步投递给上层。上层的 `wlan_cfg80211_p2p.c` 中调用 `cfg80211_rx_mgmt()`（`os_if/p2p/src/wlan_cfg80211_p2p.c:100`）将帧送入内核的 cfg80211 子系统。

cfg80211 通过 nl80211 通知用户态——wpa_supplicant/hostapd 通过 nl80211 socket 接收帧，最终在 `ieee802_11_mgmt()`（§2）中做帧分发。整条链路：

```
固件 → WMI_MGMT_RX_EVENTID → wma_mgmt_rx_process()（wma_mgmt.c:3863）
    → mgmt_txrx_rx_handler()（wma_mgmt.c:3959）
    → tgt_p2p_mgmt_frame_rx_cb()（wlan_p2p_tgt_api.c:284）
    → cfg80211_rx_mgmt()（wlan_cfg80211_p2p.c:100）
    → nl80211 → hostapd ieee802_11_mgmt()（§2）
```

QCOM 驱动的 AP 模式和 STA 模式共享同一套 WMA/mgmt_txrx 基础设施，区别在于 STA 模式下帧还会经过 PE/LIM（Protocol Engine / LIM）层的 `lim_process_auth_frame()`（`lim_process_auth_frame.c:1726`）做额外的协议处理，而 AP 模式下帧直接通过 cfg80211 上报给 hostapd——因为 AP 的协议处理在用户态完成。

不过"透传"并不意味着来者不拒。管理帧在送入 mgmt_txrx 框架之前要过三层前置校验：WMI 参数提取失败、帧长度异常（长度字段为零或超过实际数据长度）、PSOC 上下文为空——任一条件触发，帧在驱动层就直接被释放丢弃。进入 mgmt_txrx 框架后，`wlan_mgmt_txrx_rx_frame_handler()`（`wlan_mgmt_txrx_main.c:1747`）还有两道过滤：Frame Control 的 type 字段不是 Management 或 Control 类型时直接丢弃（固件误上报了数据帧）；源地址（addr2）和 BSSID（addr3）均无效时也丢弃（畸形帧或地址被篡改）。对于加密管理帧（Protected 位为 1），还会校验 IV/CCMP header 长度——不足则丢弃，防止后续解密时越界访问。这些过滤条件意味着：即使固件把帧送到了主机驱动，也不一定能到达 hostapd——驱动层是第一道安全闸门。

## 7.2 MTK gen4m：kalIndicateStatusAndComplete → cfg80211

MTK 驱动的 AP 侧管理帧接收路径更直接。固件将管理帧交给内核驱动后，驱动在 `kalIndicateStatusAndComplete()`（`gl_kal.c:2904`）中完成两件事：一是通过 `cfg80211_rx_mgmt()`（`gl_kal.c:7781`）将原始帧上报给 cfg80211，二是通过 `cfg80211_connect_result()` 或 `cfg80211_connect_bss()` 上报连接状态变更。

对于 AP 模式的 Auth/Assoc 帧，MTK 驱动在 `aaa_fsm.c`（AP 认证/关联状态机）中做部分协议预处理——这与 QCOM 的"透传到用户态"策略不同。`aaa_fsm` 的状态定义在 `aa_fsm.h` 的 `enum ENUM_AA_STATE` 中，共 13 个状态，AP 侧核心路径是 `AA_STATE_IDLE` → `AAA_STATE_SEND_AUTH2` → `AAA_STATE_SEND_ASSOC2` → `AA_STATE_IDLE`。

收到 Auth Request 时，`aaaFsmRunEventRxAuth()`（`aaa_fsm.c:140`）执行四步校验。先验帧长度（帧总长减去头部后，必须覆盖认证算法、事务序列号、状态码三个字段的最小长度），再调用 `authProcessRxAuthFrame()` 做协议层校验（认证算法和事务序列号是否合法），然后调用 `p2pFuncValidateAuth()` 做网络层校验（ACL、并发 STA 数量限制）。校验通过才分配 STA Record，并把 `eAuthAssocState` 推进到 `AAA_STATE_SEND_AUTH2`。对于 SAE/OWE 认证，驱动不自己构造 Auth Response，而是通过 `kalP2PIndicateRxMgmtFrame()` 将帧透传给 hostapd 处理。对于 Open System 认证，驱动调用 `authSendAuthFrame()`（`auth.c:373`）直接构造 Auth Response 帧发送。值得注意的是，802.11w PMF 场景下还有一个隐含的丢帧条件：若 BSS 已安装 BIP 密钥（`rsnCheckBipKeyInstalled` 为 true），驱动直接丢弃 Auth 帧——这是防 Deauth/Disassoc 攻击的机制，已建立 PMF 连接的 STA 必须通过加密的 Action 帧（而非明文 Auth 帧）来重新协商。

收到 Assoc Request 时，`aaaFsmRunEventRxAssoc()`（`aaa_fsm.c:472`）走类似流程。先通过 `cnmGetStaRecByIndex()` 查找 STA Record——若首次查找失败（WTBL 索引未映射），驱动调用 `secHandleNoWtbl()`（`privacy.c:1489`）做回退：通过 `secLookupStaRecIndexFromTA()` 按源 MAC 地址反查 STA Record 索引，找到则恢复 `ucWlanIdx` 继续处理，找不到则 `prStaRec` 保持 NULL 后续 `break` 跳出——Assoc 帧被静默丢弃，驱动不回复 Assoc Response（客户端超时后会重试）。再调用 `assocProcessRxAssocReqFrame()` 解析 IE 并校验，然后调用 `p2pFuncValidateAssocReq()` 做网络层校验。通过后调用 `assocSendReAssocRespFrame()`（`assoc.c:2199`）构造 Assoc Response 发送。

整条链路：

```
固件 → aaaFsmRunEventRxAuth()（aaa_fsm.c:140）/ aaaFsmRunEventRxAssoc()（aaa_fsm.c:472）
    → 帧校验 + 协议预处理 + authSendAuthFrame() / assocSendReAssocRespFrame()
    → cfg80211_rx_mgmt()（gl_kal.c:7781）
    → nl80211 → hostapd ieee802_11_mgmt()（§2）
```

Auth/Assoc Response 帧发送完成后，驱动在 TX Done 回调 `aaaFsmRunEventTxDone()`（`aaa_fsm.c:845`）中推进状态机。核心路径如下——注意 P2P AP 模式和标准 AP 模式的 STA_STATE_3 转换时机不同：

```c
// MTK kernel_modules-connectivity-wlan-core-gen4m/mgmt/aaa_fsm.c:878
switch (prStaRec->eAuthAssocState) {
case AAA_STATE_SEND_AUTH2:
    // Auth Response TX 完成——先验帧匹配，停超时定时器
    if (authCheckTxAuthFrame(prAdapter, prMsduInfo,
        AUTH_TRANSACTION_SEQ_2) != WLAN_STATUS_SUCCESS)
        break;
    cnmTimerStopTimer(prAdapter, &prStaRec->rTxReqDoneOrRxRespTimer);
    if (prStaRec->u2StatusCode == STATUS_CODE_SUCCESSFUL) {
        if (rTxDoneStatus == TX_RESULT_SUCCESS) {
            cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_2);
            // STA_STATE_2 = 已认证未关联。启动关联超时定时器，
            // 等待 STA 发送 Assoc Request
            cnmTimerStartTimer(prAdapter,
                &prStaRec->rTxReqDoneOrRxRespTimer,
                TU_TO_MSEC(TX_ASSOCIATE_TIMEOUT_TU));
        } else {
            // Auth Response 发送失败——回退到初始状态
            prStaRec->eAuthAssocState = AA_STATE_IDLE;
            cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_1);
            // P2P/BOW 模式下触发错误回调通知上层
        }
    }
    break;
case AAA_STATE_SEND_ASSOC2:
    // Assoc Response TX 完成
    if (assocCheckTxReAssocRespFrame(prAdapter, prMsduInfo)
        != WLAN_STATUS_SUCCESS)
        break;
    if (prStaRec->u2StatusCode == STATUS_CODE_SUCCESSFUL) {
        if (rTxDoneStatus == TX_RESULT_SUCCESS) {
            prStaRec->eAuthAssocState = AA_STATE_IDLE;
            // P2P AP 模式：在 RX Assoc 阶段已通过
            // p2pRoleFsmRunEventAAACompleteImpl() 完成
            // cnmStaRecChangeState(STA_STATE_3)，
            // 此处只清理状态
        } else {
            // Assoc Response 发送失败——回退到已认证状态
            prStaRec->eAuthAssocState = AAA_STATE_SEND_AUTH2;
            cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_2);
            // 回退到 STA_STATE_2 而非 STA_STATE_1：
            // 认证仍然有效，STA 可以重新提交 Assoc Request
        }
    }
    break;
case AA_STATE_IDLE:
    // 防御：STA_STATE_3 已关联时忽略（可能是重复帧），
    // 否则释放 STA Record
    if (prStaRec->ucStaState != STA_STATE_3)
        cnmStaRecFree(prAdapter, prStaRec);
    break;
}
```

STA_STATE_3（已关联）的转换时机是 QCOM 和 MTK 的一个关键差异点。QCOM 的 `FULL_AP_CLIENT_STATE_SUPP` 在 handle_auth 阶段就向固件预注册 WTBL 条目（§3 已述），而 MTK 的 `cnmStaRecChangeState()`（`cnm_mem.c:956`）有一个过滤逻辑：从 STA_STATE_1 到 STA_STATE_2 的转换只更新本地 `ucStaState` 字段，不通知固件。只有进入 STA_STATE_3 时才通过 `cnmStaSendUpdateCmd()` 发送固件命令更新 WTBL——固件收到后分配条目，后续数据帧才能被正确加密和转发。

在 P2P AP 模式下，STA_STATE_3 的转换发生在 Assoc Request 接收阶段。`p2pRoleFsmRunEventAAACompleteImpl()`（`p2p_role_fsm.c:3967`）调用 `bssAddClient()` 将 STA 加入客户端列表，然后 `cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_3)` 通知固件，再调用 `p2pChangeMediaState(MEDIA_STATE_CONNECTED)` 更新 BSS 连接状态并通过 `nicUpdateBss()` 同步到固件。相当于前台在分配房间号的同时就把房卡权限同步到了门禁系统——固件在 Assoc Response 发出之前就已经知道这个 STA 的存在。

用民宿视角看整个 aaa_fsm 流程：`aaaFsmRunEventRxAuth` 是前台收到住客身份证后的第一道审核——验格式（帧长度校验）、验身份（`authProcessRxAuthFrame` 协议校验）、查黑名单（`p2pFuncValidateAuth` 网络条件校验），审核通过才建档案（分配 STA Record）并回复确认。`aaaFsmRunEventRxAssoc` 是住客提交住房申请后的第二道审核——核对申请表（`assocProcessRxAssocReqFrame` 解析 IE）、检查房间余量（`p2pFuncValidateAssocReq` 并发限制），通过后分配房间号并回复。TX Done 回调是"确认信已寄到"——寄到了就推进状态，没寄到就回退重来。Auth TX 失败退回 STA_STATE_1（住客退回门外，身份登记作废），Assoc TX 失败退回 STA_STATE_2（房间分配失败，但身份登记仍有效，可以重新申请）。

另一个容易混淆的概念：`joinComplete()`（`aaa_fsm.c:1673`）虽然定义在 aaa_fsm.c 中，但它是 STA 模式加入 BSS 的流程——更新 BSS 描述符的 PHY 类型、信道、速率集、WMM 参数等，设置 `eConnectionState = MEDIA_STATE_CONNECTED`，最后调用 `kalIndicateStatusAndComplete()` 通知上层。AP 模式的关联成功通知走的是上面描述的 `p2pRoleFsmRunEventAAACompleteImpl()` 路径，不经过 `joinComplete()`。

MTK 在驱动层做这些协议预处理是为了减少 hostapd 的处理延迟——QCOM 的做法是把原始帧直接透传给 hostapd，由用户态完成所有协议逻辑。但最终的 Auth Response 和 Assoc Response 的内容（status code、AID、IE）仍然由 hostapd 决定，驱动层只是辅助状态管理和帧发送。

## 7.3 驱动层 vs hostapd：谁做什么？

两个平台的共同点：**管理帧的协议处理（Auth 算法验证、Assoc IE 解析、AID 分配）都在 hostapd 用户态完成**。驱动层的职责是：(1) 从固件接收原始帧，(2) 提取元数据（频率、RSSI），(3) 通过 cfg80211/nl80211 上报给 hostapd，(4) 过滤异常帧——长度校验、地址校验、PMF 策略检查在驱动层完成，hostapd 永远看不到这些被丢弃的帧。差异在于 QCOM 在驱动层几乎不做协议预处理，而 MTK 的 aaa_fsm 会做部分关联状态管理。

用表格把三种模式的职责边界列清楚——QCOM 透传、MTK 预处理、QCOM FullMAC offload 代表了驱动介入程度的三个档位：

| 阶段        | QCOM 透传模式                                                | MTK 预处理模式                                               | QCOM FullMAC offload 模式 |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------- |
| Auth 帧接收 | 固件 → WMI → WMA → cfg80211 → hostapd（透传原始帧）          | 固件 → aaa_fsm 状态机（驱动做部分协议预处理） → cfg80211 → hostapd | 同透传模式                |
| Auth 处理   | hostapd 独立完成（算法验证 + ACL + ap_sta_add）              | hostapd 完成最终决策，驱动 aaa_fsm 辅助状态管理              | hostapd 独立完成          |
| Assoc 处理  | hostapd 独立完成（IE 解析 + AID 分配）                       | hostapd 完成，P2P AP 模式下驱动 `p2pRoleFsmRunEventAAACompleteImpl()` 完成 `cnmStaRecChangeState(STA_STATE_3)` 并通知固件分配 WTBL | hostapd 独立完成          |
| STA 预注册  | FULL_AP_CLIENT_STATE_SUPP：handle_auth 阶段就通过 ap_sta_add 向固件预注册 WTBL 条目 | 不支持预注册，STA_STATE_3 时通过 `cnmStaSendUpdateCmd()` 通知固件 | 同透传模式                |
| 四次握手    | hostapd 驱动状态机，EAPOL 帧通过 nl80211 透传                | hostapd 驱动状态机，EAPOL 帧透传                             | 固件内完成，hostapd 跳过  |
| 密钥安装    | NL80211_CMD_NEW_KEY → wlan_hdd_cfg80211_add_key → UMAC crypto → WTBL | hostapd 直接构造 CMD_802_11_KEY → kalIoctl → 固件 WTBL       | 固件自行安装              |
| STA 授权    | hostapd 回调链 → 驱动标记 WLAN_STA_AUTHORIZED                | 同左                                                         | 固件自行授权              |

---

# 8 Framework 层：SoftApManager 的状态监听与 AIDL 回调

hostapd 完成 Auth/Assoc/四次握手后，需要通知 Android Framework 层"有新客户端连接了"。这个通知链从 hostapd 的 `AP_STA_CONNECTED` 消息开始，经过 AIDL HAL 回调，最终到达应用层的 `WifiManager.SoftApCallback`。

## 8.1 hostapd → HAL：AP_STA_CONNECTED 消息

四次握手完成后，`ap_sta_set_authorized_event()`（`sta_info.c:1500`）通过 `wpa_msg()` 发送 `AP_STA_CONNECTED` 消息（定义在 `wpa_ctrl.h:366`）。消息格式为 `AP-STA-CONNECTED <MAC>[ p2p_dev_addr=<P2P_MAC>][ ip_addr=<IP>][ keyid=<ID>][ dpp_pkhash=<HASH>]`——MAC 地址用 `MACSTR` 格式化，P2P 设备地址在 P2P Group 模式下附加，IP 地址从 `wpa_auth_get_ip_addr()` 获取，keyid 从 `ap_sta_wpa_get_keyid()` 取得（标识当前使用的密钥索引），dpp_pkhash 是 DPP（Device Provisioning Protocol）场景下的公钥哈希。

HAL 层的 `HostapdCallback.onConnectedClientsChanged()`（`HostapdHalAidlImp.java:434`）收到消息后，从 `ClientInfo` parcelable（`ClientInfo.aidl`）中提取五个字段：`ifaceName`（接口名）、`apIfaceInstance`（AP 实例标识，双 AP 模式下区分主副实例）、`clientAddress`（`byte[]` 格式的 MAC 地址）、`isConnected`（连接/断开布尔标志）、`disconnectReasonCode`（断开原因码，仅 `isConnected=false` 时有效）。`clientAddress` 转换为 `MacAddress` 对象后，通过 `SoftApHalCallback.onConnectedClientsChanged()` 逐层上报。

## 8.2 HAL → Framework：IHostapdCallback.onConnectedClientsChanged

AIDL HAL 层的 `HostapdHalAidlImp` 中定义了 `HostapdCallback` 内部类（`HostapdHalAidlImp.java:387`），它继承 `IHostapdCallback.Stub`。收到 `AP_STA_CONNECTED` 消息后，`onConnectedClientsChanged()` 方法（`HostapdHalAidlImp.java:434`）被调用，它从 `ClientInfo` 中提取客户端 MAC 地址和连接状态，然后调用 `SoftApHalCallback.onConnectedClientsChanged()` 通知上层。

`SoftApHalCallback` 是 `WifiNative` 中定义的回调接口（`WifiNative.java:332`），它的实现在 `SoftApManager` 中。

## 8.3 SoftApManager → WifiManager.SoftApCallback

`SoftApManager` 中匿名实现的 `SoftApHalCallback`（`SoftApManager.java:350`）收到 `onConnectedClientsChanged` 事件后，构造 `WifiClient` 对象，通过 StateMachine 发送 `CMD_ASSOCIATED_STATIONS_CHANGED` 消息。StateMachine 处理该消息后，调用 `mSoftApCallback.onConnectedClientsOrInfoChanged()` 通知应用层。

完整的三层通知链：

```
hostapd ap_sta_set_authorized_event()（sta_info.c:1500）
    → wpa_msg(AP_STA_CONNECTED)（wpa_ctrl.h:366）
    → HAL HostapdCallback.onConnectedClientsChanged()（HostapdHalAidlImp.java:434）
    → WifiNative.SoftApHalCallback.onConnectedClientsChanged()（WifiNative.java:368）
    → SoftApManager SoftApHalCallback 匿名实现（SoftApManager.java:350）
    → SoftApStateMachine CMD_ASSOCIATED_STATIONS_CHANGED
    → WifiManager.SoftApCallback.onConnectedClientsOrInfoChanged()
```

这条链路把驱动层的一个 Auth 帧到达事件，逐层转化为 Framework 的连接状态变更通知——从内核的 WMI 事件到用户态的 AIDL 回调，再到应用层的 Java 回调。每一层都在做"翻译"：驱动层把固件事件翻译成 cfg80211 帧，hostapd 把帧翻译成 `AP_STA_CONNECTED` 消息，HAL 把消息翻译成 AIDL 回调，Framework 把回调翻译成 `WifiClient` 对象。

---

# 9 三层链路总览：从驱动到 Framework 的完整事件流

把前三节的内容串起来，一个客户端从敲门到入住的完整事件流横跨三个层次：

```
┌─────────────────────────────────────────────────────────────────┐
│ 驱动层（QCOM/MTK）                                               │
│                                                                 │
│ 固件收到 Auth 帧                                                 │
│   → QCOM: wma_mgmt_rx_process() → mgmt_txrx_rx_handler()       │
│          → cfg80211_rx_mgmt()                                   │
│   → MTK:  kalIndicateStatusAndComplete() → cfg80211_rx_mgmt()   │
│   → nl80211 上报给 hostapd                                       │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ hostapd 用户态                                                   │
│                                                                 │
│ ieee802_11_mgmt()（§2）→ handle_auth()（§3）→ Auth Response      │
│                      → handle_assoc()（§4）→ Assoc Response      │
│                      → hostapd_new_assoc_sta()（§5）             │
│                      → 四次握手（§6）                             │
│                      → ap_sta_set_authorized_event()             │
│                      → wpa_msg(AP_STA_CONNECTED)                │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Framework 层（Android）                                          │
│                                                                 │
│ HostapdCallback.onConnectedClientsChanged()                     │
│   → SoftApManager.SoftApCallbackInternal                        │
│   → SoftApStateMachine CMD_ASSOCIATED_STATIONS_CHANGED          │
│   → WifiManager.SoftApCallback.onConnectedClientsOrInfoChanged()│
└─────────────────────────────────────────────────────────────────┘
```

用表格把三层在各阶段的职责列出来，和上面的架构图是同一件事的两种视角——图看流向，表看分工：

| 阶段         | 驱动层（QCOM/MTK）                                           | hostapd 用户态                                               | Framework 层                                                 |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Auth 帧接收  | QCOM: `wma_mgmt_rx_process()` → `mgmt_txrx_rx_handler()` → `cfg80211_rx_mgmt()`；MTK: `kalIndicateStatusAndComplete()` → `cfg80211_rx_mgmt()` | `ieee802_11_mgmt()` → `handle_auth()`                        | —                                                            |
| Auth 处理    | MTK: `aaa_fsm` 状态机做部分协议预处理（`AAA_STATE_SEND_AUTH2`）；QCOM: 透传原始帧 | 验证认证算法 → ACL 检查 → `ap_sta_add()` 创建 `sta_info`     | —                                                            |
| Assoc 帧接收 | 同 Auth 帧接收路径                                           | `handle_assoc()` → `check_assoc_ies()` → `hostapd_get_aid()` | —                                                            |
| Assoc 处理   | MTK: `aaa_fsm` 转到 `AAA_STATE_SEND_ASSOC2`，P2P AP 模式下 `p2pRoleFsmRunEventAAACompleteImpl()` 完成 `cnmStaRecChangeState(STA_STATE_3)` 并通知固件 | 解析 IE → 分配 AID → `send_assoc_resp()`                     | —                                                            |
| 四次握手     | 驱动 non-offload 时透传 EAPOL 帧；offload 时固件内完成握手   | `wpa_auth_sta_associated()` → 状态机推进 M1→M4 → 安装 PTK/GTK | —                                                            |
| 连接通知     | 驱动标记 `WLAN_STA_AUTHORIZED`                               | `ap_sta_set_authorized_event()` → `wpa_msg(AP_STA_CONNECTED)` | `HostapdCallback.onConnectedClientsChanged()` → `SoftApManager` → `WifiManager.SoftApCallback` |

驱动层是民宿的门卫（接应来客、核对门牌号、通报前台），hostapd 是前台（验身份证、分房间、发钥匙），Framework 层是总店管理系统（更新入住记录、通知楼层管家、同步到 OTA 平台）。三个层次各司其职，通过 nl80211 和 AIDL 两个"对讲机"串联起来。下面这张架构图把三层的关系可视化：

![SAP 三层架构：驱动 → hostapd → Framework](assets/10c-SAP%EF%BC%88%E4%B8%89%EF%BC%89%E5%8A%9E%E5%85%A5%E4%BD%8F%E2%80%94%E2%80%94AP-%E4%BE%A7-Auth-Assoc-%E4%B8%8E%E5%9B%9B%E6%AC%A1%E6%8F%A1%E6%89%8B/10c-three-layer-architecture.svg)

---

# 10 总结

回到民宿比喻收尾。从客户端敲门到数据帧流通，hostapd 是前台：`handle_auth()`（§3）验身份证、`handle_assoc()`（§4）分房间和房卡、四次握手（§6）发钥匙并通电。QCOM 与 MTK 的分工差异贯穿全程——Auth/Assoc 帧接收上，QCOM 透传原始帧、MTK 的 aaa_fsm 先做协议预处理；密钥安装上，QCOM 走 nl80211 → UMAC crypto 三层抽象、MTK 走直接构造固件命令的短路径。驱动是门卫、hostapd 是前台、Framework 是总店管理系统，三层靠 nl80211 和 AIDL 两个对讲机串联。角色反转，但每层职责边界依旧清晰。
