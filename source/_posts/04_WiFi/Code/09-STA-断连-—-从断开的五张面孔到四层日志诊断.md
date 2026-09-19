---
title: STA 断连 — 从断开的五张面孔到四层日志诊断
top: 1
related_posts: true
abbrlink: c4e8ffe9
date: 2026-09-19 21:27:53
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 连接建立后，STA 和 AP 之间维持着一条脆弱的链路。当这条链路断裂时，STA 可能是主动离开的那个人，也可能是被踢出局的受害者。断连不是一种病——它是五种完全不同的病因导致的同一种症状。要治好 WiFi 断连，第一步不是查日志，而是分清"谁先动的手"。

> 我们把 WiFi 断连比作一次急诊就诊。STA 是病人，断连是昏倒，AP 是医院，四层日志是 X 光片、血液检查、心电图和基因检测。不同科室的医生看同一张片子关注点不同——Framework 工程师看"心跳"（SupplicantState），驱动工程师看"血氧"（Beacon Miss Count），固件工程师看"脑电波"（FW Roam Event）。本文是一本断连急诊手册：先教你看懂五张面孔（五种断开类型），再教你区分 Deauth 和 Disassoc 两张化验单，然后讲自动重连的"急救流程"和省电模式的"体质调理"，最后给出 13 种常见病因和四层对照诊断法。

> **PS**：本文聚焦 STA 模式下的断连，不涉及 SAP（热点）断连和 P2P 断连。漫游导致的断开在 STA 漫游那篇已展开，本文只讨论"不回来了"的断连。

<!--more-->

# 本章导读

**30 秒速览**：**五种断连**——主动断开（§1.1）/ Framework 策略（§1.2）/ 驱动检测异常（§1.3）/ 芯片崩溃 SSR（§1.4）/ AP 踢出（§1.5）× `locally_generated` 标志区分方向。**Deauth vs Disassoc**——Deauth 清除认证（冷启动级恢复），Disassoc 仅取消关联（可原地恢复），Reason Code 同一偏移共用解析。**13 大原因**——链路层 4 种（Beacon Miss / ARP / CCA / DHCP）+ 安全层 3 种（握手超时 / EAP / MIC）+ AP/芯片/硬件 3 种 + 省电/MCC/RTS 3 种（§5 速查表）。**四层日志**——Framework（决策）→ Supplicant（reason + locally_generated）→ 驱动（QCOM qca_reason / MTK DiscReason）→ 固件（bmiss / RSSI / CCA），逐层穿透定位根因（§6 对照法）。

本文分析以下源码仓库：

- [external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/)（wpa_supplicant C 源码）
- [qcacld-3.0](https://source.codeaurora.org/quic/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0/)（QCOM WiFi 驱动）
- MTK kernel_modules-connectivity-wlan-core-gen4m（MTK WiFi 驱动，闭源，分析基于源码）
- [packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi/)（AOSP WiFi Framework）
- IEEE 802.11-2024

所有代码块来自真实源码，有精简（去掉 log 语句、条件编译分支），关键路径保留完整。精简处标注 `// ...省略...`。文件路径标注在代码块首行。

---

# 1 谁先动的手？——断开的五张面孔

病人昏倒了，急诊医生第一个问题不是"怎么治"，而是"怎么倒的"——自己滑倒（用户主动断开）、被人推倒（AP 踢出）、还是心脏骤停（芯片崩溃）？搞清断连的触发方和触发层，是诊断的第一步。

WiFi 断连的五种类型按触发方和触发层分布如下：

![五种断连类型](assets/09-STA-%E6%96%AD%E8%BF%9E-%E2%80%94-%E4%BB%8E%E6%96%AD%E5%BC%80%E7%9A%84%E4%BA%94%E5%BC%A0%E9%9D%A2%E5%AD%94%E5%88%B0%E5%9B%9B%E5%B1%82%E6%97%A5%E5%BF%97%E8%AF%8A%E6%96%AD/09-disconnect-five-types.svg)

## 1.1 用户主动断开：自己拔管

最简单的断连——病人自己要求出院。用户在 WiFi 设置界面点击"断开"，或者 App 调用 `WifiManager.disconnect()`，Framework 发送 `CMD_DISCONNECT` 消息到 `ClientModeImpl`，最终通过 Supplicant AIDL 向驱动下发 Deauth 帧。

下行链路到驱动只是故事的一半。断连是双向事件——Framework 向下发出断连指令，驱动执行后还需要向上回报结果。完整的断连路径是一个闭环：

```
① 主动断开（下行链）：
   用户点击 → WifiManager.disconnect()
   → ClientModeImpl 发 CMD_DISCONNECT
   → wpa_supplicant 通过 nl80211 向驱动发 Deauth 帧

② 断连事件回报（上行链）：
   驱动检测断连（主动执行完成 / 被动收到 AP 的 Deauth）
   → nl80211 事件 → wpa_supplicant（标记 locally_generated）
   → SupplicantStaIfaceHal AIDL 回调
   → ClientModeImpl.handleNetworkDisconnect()
   → WifiConnectivityManager 启动断连扫描
```

无论主动还是被动断开，上行链都会携带 `locally_generated` 标志——它是整条链路的"方向标"，告诉每一层"谁先动的手"。

## 1.2 Framework 策略断开：医院强制转科

不是用户自己想走，而是系统判定"你不该待在这里了"——飞行模式关闭 WiFi（`WifiManager.setWifiEnabled(false)`）、`WifiNetworkSelector` 判定蜂窝评分更高切走、息屏+低电量+未持 WifiLock 触发省电断开、或用户"忘记"网络。这类断开同样是 `locally_generated=1`，但区分点在于触发源头在 Framework 日志中——搜索 `CMD_DISCONNECT` 和 `ConcreteClientModeManager` 的状态变化。

为什么不把这些策略决策下沉到 Supplicant 或驱动？因为 Framework 是唯一能同时感知用户意图（飞行模式）、网络质量评分（`NetworkScoreManager`）和应用需求（WifiLock）的层——Supplicant 只看到 BSSID 和密钥，驱动只看到 RSSI 和 Beacon，它们都没有"这个网络该不该用"的全局视野。如果让 Supplicant 自己决定是否因省电断连，它无法知道用户是否正在播放音乐（需要 WifiLock 保持连接），只能按固定策略盲目执行——这就是为什么 Android 把断连决策权收归 Framework，而不是沿用 wpa_supplicant 原生的 `autoscan` 机制。

## 1.3 驱动/固件检测异常断开：体检指标异常

病人自己没感觉，但体检报告已经红灯了。驱动或固件持续监控链路质量，当指标跌破阈值时主动断连——Beacon Loss（QCOM: `QCA_DISCONNECT_REASON_BEACON_MISS_FAILURE` 值 14，MTK: `DISCONNECT_REASON_CODE_RADIO_LOST` 值 1）、TX 重试失败（QCOM: `QCA_DISCONNECT_REASON_PEER_XRETRY_FAIL` 值 11，MTK: `DISCONNECT_REASON_CODE_RADIO_LOST_TX_ERR` 值 9）、低 RSSI/高 PER、或漫游失败（QCOM: `QCA_DISCONNECT_REASON_INTERNAL_ROAM_FAILURE` 值 1）。关键判别：日志中 `locally_generated=1`（本地驱动触发），但 reason_code 不是用户主动断开的值，QCOM 平台额外通过 `qca_disconnect_reason_codes` 枚举上报细分原因。

驱动为什么要在链路质量恶化时主动断连，而不是等 Supplicant 或 Framework 来决定？因为驱动/固件是唯一能实时感知射频状态的层——Supplicant 只在收到帧时才知道链路状况，Framework 的网络验证间隔是秒级，但 Beacon Miss 的累积窗口只有百毫秒级。如果让 Supplicant 来检测 Beacon Loss，它只能通过超时（无事件到达）来推断，延迟会从 2 秒拉长到 5-10 秒；如果让 Framework 来检测，ARP 探测间隔更长（10-30 秒），用户会经历更长时间的"假连接"。驱动/固件主动断连的本质是"最早发现异常的人有权宣布急诊"——牺牲一点误判率（偶发的 Beacon 丢失可能触发不必要的断连），换取更快的故障响应。Beacon Loss 的完整检测链路、双平台阈值对比与排查步骤详见 §5.1。

## 1.4 芯片级断开（SSR）：心脏骤停

最严重的断连——不是链路断了，是整个芯片重启了。Qualcomm 平台叫 SSR（Subsystem Restart），MTK 平台叫 SER（System Error Recovery）。芯片固件崩溃后，内核触发子系统重启，WiFi 驱动重新初始化，所有连接状态丢失。

日志上最醒目的标志是 `QCA_DISCONNECT_REASON_DEVICE_RECOVERY`（值 7）——这个 vendor 细分代码才是真正的病因，比笼统的 802.11 reason_code 有用得多。崩溃后从内核 SSR/SER 通知、驱动重载到自动重连的完整链路详见 §5.7。

## 1.5 AP 侧触发断开：被医院赶走

病人好好的，但医院说"你不能待了"。AP 主动发送 Deauth 或 Disassoc 帧踢出 STA。常见原因包括：

- AP 过载，踢出低优先级 STA
- AP 安全策略变更（如要求 WPA3 但 STA 只支持 WPA2）
- AP 侧管理员手动踢出
- AP 检测到 STA 异常行为（如 MIC Failure 导致的 TKIP 检测）

关键判别：日志中 `locally_generated=0`（对端 AP 发起），reason_code 由 AP 指定。MTK 平台上，`ucReasonOfDisconnect` 为 `DISCONNECT_REASON_CODE_DEAUTHENTICATED`（值 2）或 `DISCONNECT_REASON_CODE_DISASSOCIATED`（值 3）。AP 主动踢出的 reason code 解析与排查方向详见 §5.6。

## 1.6 双平台对比：如何快速判断"谁先动的手"

| 判断依据     | QCOM 平台                                                    | MTK 平台                                                     |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 本地 vs 远端 | `locally_generated` 字段 + `qca_disconnect_reason_codes` 细分 | `Locally[]` 标记 + `DiscReason` 枚举                         |
| 用户主动     | `QCA_DISCONNECT_REASON_USER_TRIGGERED`（16）                 | `DISCONNECT_REASON_CODE_NEW_CONNECTION`（4）                 |
| Beacon Loss  | `QCA_DISCONNECT_REASON_BEACON_MISS_FAILURE`（14）            | `DISCONNECT_REASON_CODE_RADIO_LOST`（1）                     |
| 芯片崩溃     | `QCA_DISCONNECT_REASON_DEVICE_RECOVERY`（7）                 | `DISCONNECT_REASON_CODE_CHIPRESET`（7）                      |
| AP 踢出      | `locally_generated=0` + 802.11 reason_code                   | `DISCONNECT_REASON_CODE_DEAUTHENTICATED`（2）或 `DISCONNECT_REASON_CODE_DISASSOCIATED`（3） |
| 漫游失败     | `QCA_DISCONNECT_REASON_INTERNAL_ROAM_FAILURE`（1）           | `DISCONNECT_REASON_CODE_ROAMING`（6）                        |

QCOM 的 `qca_disconnect_reason_codes` 枚举在 `qca_vendor.h:13712` 定义，共 17 个值，覆盖从"未指定"到"用户触发"的全部细分场景。MTK 的断连原因定义在 `wlan_def.h:30-42`，共 13 个值，粒度较粗但覆盖了核心场景。

---

# 2 化验单上写的什么？——Deauth vs Disassoc

急诊医生拿到化验单，上面有两个容易混淆的指标：Deauth 和 Disassoc。它们看起来都是"断开"，但对应的状态机完全不同——搞混了会误诊。

## 2.1 认证状态 vs 关联状态：两道门槛

802.11 协议定义了 STA 与 AP 之间的两道门槛：

![Deauth vs Disassoc 状态机](assets/09-STA-%E6%96%AD%E8%BF%9E-%E2%80%94-%E4%BB%8E%E6%96%AD%E5%BC%80%E7%9A%84%E4%BA%94%E5%BC%A0%E9%9D%A2%E5%AD%94%E5%88%B0%E5%9B%9B%E5%B1%82%E6%97%A5%E5%BF%97%E8%AF%8A%E6%96%AD/09-deauth-disassoc-state-machine.svg)

- **Deauthentication（Deauth）帧**：取消认证。STA 从 Authenticated/Associated 状态直接退回到 Unauthenticated 状态。相当于医院取消了你的挂号资格——连门都进不来了。
- **Disassociation（Disassoc）帧**：取消关联。STA 从 Associated 退回到 Authenticated 状态。相当于被请出了病房，但挂号还在——理论上还可以重新关联。

| 维度         | Deauth                                          | Disassoc                                     |
| ------------ | ----------------------------------------------- | -------------------------------------------- |
| 状态跳转     | Associated → **Unauthenticated**（跳两步）      | Associated → **Authenticated**（退一步）     |
| 认证关系     | 彻底清除，需重新 Auth + Assoc + 四次握手        | 保留认证，只需重新 Assoc + 四次握手          |
| 恢复难度     | 高——等同于冷启动连接                            | 低——理论上可原地恢复                         |
| 典型触发方   | 用户断开、AP 安全策略拒绝、芯片崩溃             | AP 因不活跃断关联（reason 4）、漫游切换      |
| 802.11w 影响 | 受 PMF 保护的帧不可伪造，未保护帧可被攻击者注入 | 同左，但 Disassoc 的攻击窗口更窄（需先关联） |

为什么 802.11 要设计两个断开帧而不是一个统一的 Disconnect 帧？这不是规范委员会的随意决定——它体现了一种"软断开/硬断开"的协议设计哲学。想象一个只有 Deauth 的世界：每次断开都清除认证状态，恢复连接需要完整的 Auth + Assoc + 四次握手。对于 PSK 网络这已经够慢了（几百毫秒），但对于企业 WiFi 的 EAP 认证（涉及 RADIUS 服务器往返，耗时 1-3 秒），这个代价就太大了。Disassoc 的存在让"暂时断开"成为可能——AP 因 STA 短暂不活跃而发送 Disassoc（reason 4），STA 只需重新关联和四次握手就能恢复，省去了最耗时的认证阶段。这和 TCP 的 FIN vs RST 是同一设计模式：FIN 允许半关闭（优雅降级），RST 强制完全重置（紧急终止）。802.11 的 Disassoc 对应 TCP 的 FIN，Deauth 对应 RST——两种协议都在"渐进式降级优于突然终止"这个原则上达成了共识。

从帧格式看，Deauth 和 Disassoc 的 Reason Code 字段偏移量相同（`mgmt->u.deauth.reason_code` 和 `mgmt->u.disassoc.reason_code` 在同一偏移），nl80211 事件处理代码利用这一特性共用解析逻辑——只需一个函数就能处理两种帧：

```c
// wpa_supplicant/src/drivers/driver_nl80211_event.c:1543-1545
/* Note: Same offset for Reason Code in both frame subtypes */
if (len >= 24 + sizeof(mgmt->u.deauth))
    reason_code = le_to_host16(mgmt->u.deauth.reason_code);

```

这行代码注释直接说了——"Deauth 和 Disassoc 帧的 Reason Code 在同一偏移"。这就是为什么 `mlme_event_deauth_disassoc()` 函数可以同时处理两种帧，用 `type` 参数区分是 `EVENT_DEAUTH` 还是 `EVENT_DISASSOC`。

## 2.2 locally_generated 的判定：SA 还是别人？

断连事件到达 Supplicant 时，一个关键字段是 `locally_generated`——它表示"这个断开是 STA 自己发起的还是 AP 发起的"。`ether_addr_equal` 比较帧的源地址（SA）和本机地址，SA 匹配则 locally_generated=1：

```c
// wpa_supplicant/src/drivers/driver_nl80211_event.c:1547-1559
if (type == EVENT_DISASSOC) {
    event.disassoc_info.locally_generated =
        ether_addr_equal(mgmt->sa, drv->first_bss->addr);
    // ... 省略 IE 解析 ...
} else {
    event.deauth_info.locally_generated =
        ether_addr_equal(mgmt->sa, drv->first_bss->addr);
    // ... 省略 ignore_deauth_event 处理 ...
}

```

Deauth 和 Disassoc 两条路径共用同一个判定逻辑——如果 `mgmt->sa == drv->first_bss->addr`，说明帧是自己发的 → `locally_generated=1`。如果是 AP 的地址 → `locally_generated=0`。

但这里有个陷阱：漫游场景下，旧 AP 的 Deauth 事件可能在 STA 已经开始连接新 AP 之后才到达。`mlme_event_deauth_disassoc()` 对此做了特殊处理——如果 STA 已经不在旧 AP 上了（`!drv->associated`），且旧 AP 地址匹配 `drv->prev_bssid`，则直接忽略这个事件，避免漫游过程中的误判。

## 2.3 Supplicant 层的 Deauth/Disassoc 处理链路

事件从 nl80211 驱动层到达 Supplicant 后，经过 `wpa_supplicant_event()` 这个万能分发器——就像医院接诊台按病症把患者分到不同科室，Deauth 和 Disassoc 两种事件走不同路径，最终汇入同一个断连入口：

- **入口**：`wpa_supplicant_event()`（`events.c:6274`）——巨型 switch，覆盖 40+ 种事件类型
  - **EVENT_DEAUTH** → `wpas_event_deauth()`（`events.c:5414`）——提取 reason_code、locally_generated、IE，额外调用 `wpa_reset_ft_completed()` 重置 FT 状态
  - **EVENT_DISASSOC** → `wpas_event_disassoc()`（`events.c:5359`）——提取相同字段，不重置 FT
- **汇合点**：两条路径都调用 `wpas_event_disconnect()`（`events.c:5313`）
  - **输出日志**：`wpa_supplicant_event_disassoc()` — 输出 `CTRL-EVENT-DISCONNECTED`
  - **执行决策**：`wpa_supplicant_event_disassoc_finish()` — 决定自动重连还是停止

这个 switch 有 40 多个 case，但断连只走其中两个——EVENT_DISASSOC 和 EVENT_DEAUTH，其余都是连接建立、密钥协商、扫描完成等事件。断连相关的两个 case 如下：

```c
// wpa_supplicant/events.c:6362-6382
case EVENT_DISASSOC:
    wpas_event_disassoc(wpa_s,          // 路径最短：直接分发
                data ? &data->disassoc_info : NULL);
    break;
case EVENT_DEAUTH:
#ifdef CONFIG_TESTING_OPTIONS            // 以下两个守卫仅测试编译生效
    if (wpa_s->ignore_auth_resp) {       // 测试模式：忽略所有认证响应
        wpa_printf(MSG_INFO,
               "EVENT_DEAUTH - ignore_auth_resp active!");
        break;
    }
    if (wpa_s->testing_resend_assoc) {   // 测试模式：断连后自动重关联
        wpa_printf(MSG_INFO,
               "EVENT_DEAUTH - testing_resend_assoc");
        break;
    }
#endif /* CONFIG_TESTING_OPTIONS */
    wpas_event_deauth(wpa_s,             // 生产环境：直接分发
              data ? &data->deauth_info : NULL);
    break;
```

`EVENT_DISASSOC` 直接分发到 `wpas_event_disassoc()`，路径最短；`EVENT_DEAUTH` 多了两个 `CONFIG_TESTING_OPTIONS` 守卫（测试模式专用，生产环境不会触发），守卫通过后才进入 `wpas_event_deauth()`。两个 handler 的提取逻辑相同（reason_code、locally_generated、IE → `wpas_event_disconnect()`），唯一的实质区别是 Deauth 路径额外调用 `wpa_reset_ft_completed()` 重置 FT 状态——因为 Deauth 意味着认证关系彻底断开，而 Disassoc 只取消关联、保留认证。如果不重置 FT 状态，STA 在收到 Deauth 后尝试重连时会误认为 FT 密钥协商已完成（`ft_completed` 标志仍为 true），跳过 FT Auth 阶段直接发送 Reassoc Request——AP 收到后因找不到对应的 FT Session 会返回 reject，导致重连失败但日志中看不到明显的原因。

`wpas_event_disconnect()` 是真正的断连处理入口：

```c
// wpa_supplicant/events.c:5313-5356
static void wpas_event_disconnect(struct wpa_supplicant *wpa_s, const u8 *addr,
                                  u16 reason_code, int locally_generated,
                                  const u8 *ie, size_t ie_len, int deauth)
{
    // ... AP 模式检查省略 ...

    if (!locally_generated)
        wpa_s->own_disconnect_req = 0;

    wpa_supplicant_event_disassoc(wpa_s, reason_code, locally_generated);

    if (((reason_code == WLAN_REASON_IEEE_802_1X_AUTH_FAILED ||  // 路径 A：AP 发 reason 23
          ((wpa_key_mgmt_wpa_ieee8021x(wpa_s->key_mgmt) ||       // 路径 B：企业 802.1X 认证
            (wpa_s->key_mgmt & WPA_KEY_MGMT_IEEE8021X_NO_WPA)) &&
           eapol_sm_failed(wpa_s->eapol))) &&                     // EAP 状态机：eapFail && !eapSuccess
         !wpa_s->eap_expected_failure))                           // 排除预期失败（测试用）
        wpas_auth_failed(wpa_s, "AUTH_FAILED", addr);

    wpa_supplicant_event_disassoc_finish(wpa_s, reason_code,
                                         locally_generated);
}
```

从事件进入到决策输出，这条处理链路像一条内容平台的审核流水线——先发布快讯（输出日志让所有订阅者看到断连事件），再风控检查（EAP 认证是否触发安全告警），最后决定内容分发策略（重连还是停止）。这个函数做三件事：

- 调用 `wpa_supplicant_event_disassoc()` 输出 `CTRL-EVENT-DISCONNECTED` 日志（包含 reason 和 locally_generated 标志）
- 检查 EAP 认证是否失败，如果是则触发 `AUTH_FAILED` 通知
- 调用 `wpa_supplicant_event_disassoc_finish()` 执行断连后决策（自动重连 or 停止）

从 Supplicant 往下看，QCOM 驱动收到 Deauth 后的完整清理链路更值得剖析。`SIR_LIM_DELETE_STA_CONTEXT_IND` 这条消息由 WMA 层的 `wma_peer_sta_kickout_event_handler()`（`wma_mgmt.c:377`）发出，当 LIM 的对应 handler（`lim_link_monitoring_algo.c:213`）收到并决定执行 kickout 时，实际的清理分三步执行：`lim_send_deauth_mgmt_frame()`（`lim_link_monitoring_algo.c:227`）先向 AP 发送 Deauth 帧，`lim_tear_down_link_with_ap()`（`lim_link_monitoring_algo.c:238`）再执行内部状态清理，最后 `wlan_dlm_add_bssid_to_reject_list()` 将 AP 加入黑名单。

这三步对应的是 802.11-2024 §10.2 定义的 MLME-RESET 原语——规范要求 STA 收到 Deauth 后必须执行状态重置（清除认证状态、回到 Unauthenticated）并清除所有缓存的 MSDU。`lim_tear_down_link_with_ap()` 的实现覆盖了这些要求：设置 `disassocReason` 和 `cleanupTrigger`（状态记录），向 SME 发送 `LIM_MLM_DEAUTH_IND`（通知上层协议栈），清除 TDLS 对端（如果有），以及通过 `cds_flush_logs()` 记录致命事件日志。规范还要求在重置过程中丢弃所有待发送的帧——这由驱动的 reordering buffer 清理机制在 LIM 通知发出后自动完成。§5.1 会进一步展开 LIM vs PE 的架构分工以及不同 kickout 类型的路径差异。

## 2.4 Reason Code 完整速查表

802.11-2024 §9.4.1.7 定义了 0-68 共 69 个 Reason Code。以下是最常见的值：

| Code | 名称                           | 含义                     | 常见场景                                                |
| ---- | ------------------------------ | ------------------------ | ------------------------------------------------------- |
| 1    | UNSPECIFIED                    | 未指定原因               | AP 通用踢出，最模糊的码                                 |
| 2    | PREV_AUTH_NOT_VALID            | 前认证无效               | STA 尝试关联但认证已过期                                |
| 3    | DEAUTH_LEAVING                 | STA 离开                 | STA 主动发送 Deauth，QCOM SSR 断连也用此码              |
| 4    | DISASSOC_DUE_TO_INACTIVITY     | 因不活跃断关联           | AP 检测到 STA 长时间无帧交互，驱动 Beacon Loss 也用此码 |
| 6    | CLASS2_FRAME_FROM_NONAUTH_STA  | 来自未认证 STA 的 2 类帧 | STA 在未认证状态下发了需要认证的帧                      |
| 7    | CLASS3_FRAME_FROM_NONASSOC_STA | 来自未关联 STA 的 3 类帧 | STA 在未关联状态下发了需要关联的帧                      |
| 14   | MIC_FAILURE                    | MIC 校验失败             | TKIP MIC 连续失败，可能遭受攻击                         |
| 15   | INVALID_IE                     | 无效 IE                  | 四次握手 IE 不匹配，通常意味着密码错误                  |
| 16   | INVALID_GROUP_CIPHER           | 无效组密码               | AP 和 STA 的组密码不兼容                                |
| 17   | INVALID_PAIRWISE_CIPHER        | 无效成对密码             | AP 和 STA 的成对密码不兼容                              |
| 23   | IEEE_802_1X_AUTH_FAILED        | 802.1X 认证失败          | EAP 认证失败，企业 WiFi 常见                            |

reason 1 和 4 是最常出现但最"没用"的码——它们太泛了，只能说明"断了"，不能说明"为什么断了"。真正有价值的诊断信息在 QCOM 的 `qca_disconnect_reason_codes` 或 MTK 的 `DiscReason` 中。

这些 reason code 的编号并非随意分配——802.11-2024 §9.4.1.7 按照协议违规的严重程度对它们进行了隐式分层。回到 §2.1 的状态机：STA 经历 Unauthenticated → Authenticated → Associated 三态跃迁，每个跃迁对应一类"准入权限"——Class 1 帧在任何状态下都可以发送，Class 2 帧需要先完成认证，Class 3 帧需要先完成关联。reason code 6（CLASS2_FRAME_FROM_NONAUTH_STA）和 7（CLASS3_FRAME_FROM_NONASSOC_STA）就是这两种准入规则的"违规通知书"：收到 reason 6 说明 STA 在未认证状态下尝试了需要认证的操作（状态机已退回到 Unauthenticated），收到 reason 7 说明 STA 在未关联状态下尝试了需要关联的操作（状态机退回到 Authenticated）。

从诊断角度看，这两个码比 reason 1 有价值得多——reason 1 只能说明"断了"，reason 6/7 则精确指出"STA 的状态机与 AP 不同步"，通常意味着固件 bug 或内存损坏导致 STA 内部状态与 AP 侧记录不一致。reason 4（DISASSOC_DUE_TO_INACTIVITY）虽然也是"通用码"，但它的触发条件是确定的——AP 的 inactivity timer 到期——所以排查方向比 reason 1 明确：要么是省电过度（§4.4），要么是信道拥塞导致帧发送失败（§5.3），要么是 AP 的 inactivity timeout 配置过短。

## 2.5 安全机制触发的断开

两种安全相关的断连值得单独说明：

**SA Query 超时（802.11w MFP）**：如果 §1.5 的 AP 踢出是"被医院赶走"，SA Query 就是保安敲门验证你的身份——门开慢了就被请出去。当 AP 检测到可能的仿冒帧攻击时，会发起 SA Query 请求验证 STA 的真实性。如果 STA 在超时时间内未响应，AP 发送 Deauth（reason 6 或 7）。QCOM 平台将此映射为 `QCA_DISCONNECT_REASON_SA_QUERY_TIMEOUT`（值 13）。

Supplicant 层的处理链路比标准断连多了一个"验证"环节。nl80211 驱动层收到未保护的 Deauth 帧后，通过 `EVENT_UNPROT_DEAUTH`（`events.c:7038`）分发到 `wpa_supplicant_event_unprot_deauth()`（`events.c:5291`），该函数调用 `sme_event_unprot_disconnect()`（`sme.c:3490`）。但这个函数不会立即断连——它有六道守卫条件：STA 必须处于连接已建立状态（`wpa_state == WPA_COMPLETED`）、PMF 必须启用（`wpas_get_ssid_pmf() != NO_MGMT_FRAME_PROTECTION`）、帧源地址必须匹配当前 BSSID（`ether_addr_equal(sa, wpa_s->bssid)`）、reason_code 必须是 CLASS2 或 CLASS3、不能有正在进行的 SA Query、且距上次 unprot disconnect 超过 10 秒。六道门全过了，才调用 `sme_start_sa_query()` 发起 SA Query——向 AP 发送 SA Query Request，等待 AP 回复 SA Query Response 来证明自己还在。

如果 AP 在超时时间内回复了 SA Query Response，说明 AP 还在，之前那帧是伪造的——不触发断连，这是 802.11w 的核心保护逻辑。如果 AP 未回复（超时），`sme_check_sa_query_timeout()`（`sme.c:3362`）调用 `wpa_supplicant_deauthenticate()`（`sme.c:3372`，reason=`WLAN_REASON_PREV_AUTH_NOT_VALID`），由 STA 自己发送 Deauth 帧断开连接。这意味着 SA Query 超时断连的日志特征是 `locally_generated=1`（因为 Deauth 帧是 STA 发的），而不是 `locally_generated=0`——诊断时需要区分：看到 `locally_generated=1` + 前面有 SA Query 相关日志（`SME: Unprotected disconnect dropped`、`SME: SA Query timed out`），说明是 AP 发了未保护帧触发 SA Query 超时；看到 `locally_generated=1` + 无 SA Query 痕迹，才是用户主动断开。

**MIC Failure**：门禁卡连续刷错三次，系统直接锁卡——MIC Failure 就是这种机制。TKIP 协议下，连续两次 MIC 校验失败会触发断连（reason 14），这是 802.11-2024 §12.6.2 规定的保护机制——防止 MIC 篡改攻击。Supplicant 中的处理链路：`EVENT_MICHAEL_MIC_FAILURE`（`events.c:6385`）分发到 `wpa_supplicant_event_michael_mic_failure()`（`events.c:4952`），该函数检查连续失败次数，首次失败记录告警，第二次失败触发断连并通知 Framework 层显示"网络可能不安全"提示。

---

# 3 断了之后怎么办？——自动重连策略

化验结果出来了，医生给出诊断。但对 WiFi 来说，断连不是终点——系统会自动尝试"复诊"。自动重连是一个多层协作的系统：Supplicant 决定"要不要重连"，Framework 决定"重连到哪个 AP"，驱动/固件负责"怎么连"。

## 3.1 Supplicant 侧：快速重连 vs 全量扫描

断连事件到达 `wpa_supplicant_event_disassoc_finish()` 后，Supplicant 面临第一个决策：直接重连还是做全量扫描？这就像急诊分诊台的判断——病人跌倒后，护士先看跌倒原因：如果是自己绊了一下（可恢复的断连原因），直接扶起来回原床位（快速重连到同一个 BSS）；如果原因不明，就得重新挂号做全套检查（全量扫描找新 AP）。

```c
// wpa_supplicant/events.c:4847-4878
if (!wpa_s->disconnected &&
    (!wpa_s->auto_reconnect_disabled || ...)) {
    if (wpa_s->wpa_state == WPA_COMPLETED &&
        wpa_s->current_ssid &&
        wpa_s->current_ssid->mode == WPAS_MODE_INFRA &&
        (wpa_s->own_reconnect_req ||
         (!locally_generated &&
          disconnect_reason_recoverable(reason_code)))) {
        // 快速重连：直接尝试连接同一个 BSS，不做全量扫描
        fast_reconnect = wpa_s->current_bss;
        fast_reconnect_ssid = wpa_s->current_ssid;
    } else if (wpa_s->wpa_state >= WPA_ASSOCIATING) {
        // 全量扫描：10 秒后启动
        wpa_supplicant_req_scan(wpa_s, 0, 100000);
    }
}
```

快速重连的触发条件是：断连不是本地发起的（`!locally_generated`），且原因属于"可恢复"类型。那什么算"可恢复"？`disconnect_reason_recoverable()` 定义了三种：

```c
// wpa_supplicant/events.c:4741-4746
static int disconnect_reason_recoverable(u16 reason_code)
{
    // reason 4: AP 因 inactivity timer 超时断关联——AP 还在，只是等太久
    // reason 6/7: STA 状态机与 AP 不同步——AP 可能仍接受重连
    return reason_code == WLAN_REASON_DISASSOC_DUE_TO_INACTIVITY ||
        reason_code == WLAN_REASON_CLASS2_FRAME_FROM_NONAUTH_STA ||
        reason_code == WLAN_REASON_CLASS3_FRAME_FROM_NONASSOC_STA;
}
```

这三个码分别对应：AP 因不活跃断关联、未认证帧、未关联帧——都是"链路状态不同步但 AP 可能还接受重连"的情况。如果断连原因是这三个之一，且不是本地发起的，Supplicant 会尝试快速重连到同一个 BSS，省去全量扫描的耗时。

快速重连失败时（`wpa_supplicant_connect()` 返回 -1），退化为全量扫描：`wpa_supplicant_req_scan(wpa_s, 0, 100000)`，100000 微秒 = 100 毫秒后启动扫描。快速重连的价值在于时间——全量扫描需要逐信道搜索，耗时数秒；快速重连直接尝试已知 BSS，通常在 100 毫秒内完成。对用户来说，这几秒的差距就是"网络恢复了"和"怎么还连不上"的区别。

## 3.2 PSK 密码错误检测：别再白费力气

断连处理中有一个重要检查——密码是否错误：

```c
// wpa_supplicant/events.c:4778-4799
static int could_be_psk_mismatch(struct wpa_supplicant *wpa_s, u16 reason_code,
                                 int locally_generated)
{
    // 守卫：四个条件任一不满足则排除 PSK 错误可能
    if (wpa_s->wpa_state != WPA_4WAY_HANDSHAKE ||  // 不在握手阶段
        !wpa_s->new_connection ||                    // 重连而非首次连接
        !wpa_key_mgmt_wpa_psk(wpa_s->key_mgmt) ||  // 非 PSK 认证方式
        wpa_key_mgmt_sae(wpa_s->key_mgmt))          // SAE 有自己的错误码
        return 0; /* Not in initial 4-way handshake with PSK */

    // 本地触发 + IE 不匹配 = Supplicant 自己检测到握手 IE 异常
    // 不是密码错误，是协议协商问题，排除
    if (locally_generated) {
        if (reason_code == WLAN_REASON_IE_IN_4WAY_DIFFERS)
            return 0;
    }
    return 1;  // 通过所有守卫 → 大概率密码错误
}
```

命中这些条件时，Supplicant 输出 `WPA: 4-Way Handshake failed - pre-shared key may be incorrect` 日志——这就像急诊中的过敏史筛查——在给药（重连）之前先检查病历（密码），如果上次给药就过敏了（四次握手失败），这次就别再开同样的药，直接告诉主治医生（Framework）"密码可能不对"，避免患者反复注射同一种过敏原。

## 3.3 Framework 侧：WifiConnectivityManager 的自动扫描

Supplicant 的 `CTRL-EVENT-DISCONNECTED` 事件通过 `SupplicantStaIfaceHal` 的 AIDL 回调上报到 Framework，最终到达 `ClientModeImpl.handleNetworkDisconnect()`：

```java
// ClientModeImpl.java:3520
private void handleNetworkDisconnect(boolean newConnectionInProgress,
                                     int disconnectReason) {
    // ... 上报断连指标 ...
    mWifiMetrics.reportNetworkDisconnect(mInterfaceName, ...);
    // ... 清理状态 ...
    clearTargetBssid("handleNetworkDisconnect");
    stopDhcpSetup();
    // ... AP 过载处理 ...
    if (disconnectReason == StaIfaceReasonCode.DISASSOC_AP_BUSY) {
        mWifiConfigManager.setRecentFailureAssociationStatus(...);
    }
}
```

断连后，Framework 的 `WifiConnectivityManager` 收到状态变化通知，切换到断连扫描模式：

```java
// WifiConnectivityManager.java:3236
public void handleConnectionStateChanged(
        ConcreteClientModeManager clientModeManager, int state) {
    if (mWifiState == WIFI_STATE_DISCONNECTED) {
        // 切换到断连扫描调度
        setSingleScanningSchedule(mDisconnectedSingleScanScheduleSec);
        setSingleScanningType(mDisconnectedSingleScanType);
        startConnectivityScan(SCAN_IMMEDIATELY);
    } else if (mWifiState == WIFI_STATE_CONNECTED) {
        // ... 连接态扫描调度 ...
    }
}
```

断连后立即启动扫描（`SCAN_IMMEDIATELY`），尝试找到可连接的网络。扫描间隔采用指数退避策略：初始快速扫描，逐步拉长间隔直到最大周期。这和急诊科的"先抢救、再观察、最后定期复查"思路一致。

## 3.4 黑名单机制：别再去看那个庸医

重连时不能反复尝试同一个"不合格"的 AP——就像医院会把连续误诊的医生暂时列入"不再接诊"名单，等他通过考核再恢复坐诊。Framework 的 `WifiBlocklistMonitor` 负责维护这份"庸医名单"：

```java
// WifiBlocklistMonitor.java:549
public boolean handleBssidConnectionFailure(
        String bssid, WifiConfiguration config,
        @FailureReason int reasonCode, int rssi)
```

连续失败的 BSSID 会被加入黑名单，在一段时间内不再尝试连接。Supplicant 层也有类似的机制——`wpa_is_bss_tmp_disallowed()` 检查 BSS 是否被临时禁止，`disallowed_bssid()` 和 `disallowed_ssid()` 检查永久禁止列表。这些检查在 `wpa_supplicant_event_disassoc_finish()` 的快速重连路径中被执行，确保重连不会陷入死循环。

黑名单超时时间的选择是一个经典的工程权衡——太短会反复尝试同一个坏 AP（ping-pong 效应），太长会错失 AP 已经恢复的机会。Framework 侧的退避算法核心如下：

```java
// WifiBlocklistMonitor.java:285-295
private long getBlocklistDurationWithExponentialBackoff(
        int failureStreak, int baseBlocklistDurationMs) {
    long disableDurationMs = baseBlocklistDurationMs;           // 默认：5 分钟
    failureStreak = Math.min(failureStreak, mContext.getResources().getInteger(
            R.integer.config_wifiBssidBlocklistMonitorFailureStreakCap)); // 封顶：7 次
    if (failureStreak >= 1) {
        // 退避公式：2^N * 基础时长
        // N=1 → 10min, N=2 → 20min, ..., N=7 → 640min
        disableDurationMs = (long)(Math.pow(2.0, failureStreak)
                * baseBlocklistDurationMs);
    }
    return Math.min(disableDurationMs, mWifiGlobals.getWifiConfigMaxDisableDurationMs()); // 硬上限：18 小时
}
```

各层的超时值和策略如下：Framework 的 `WifiBlocklistMonitor` 基础超时为 5 分钟（`config_wifiBssidBlocklistMonitorBaseBlockDurationMs = 300000`，`config.xml:643`），连续失败时采用指数退避——第 N 次连续失败的超时为 `2^N * 5分钟`，由 `getBlocklistDurationWithExponentialBackoff()`（`WifiBlocklistMonitor.java:285`）计算，上限受 `getWifiConfigMaxDisableDurationMs()` 约束；QCOM 驱动层的 DLM（Dynamic Learning Module）硬上限为 `MAX_BL_TIME = 255000` 毫秒（约 4.25 分钟，`wlan_dlm_core.c:151`），超过此值的 AP 直接放行重试——固件侧通过 `reject_duration` 字段下发到漫游模块，漫游扫描时自动跳过黑名单内的 BSSID；MTK 驱动层通过 `aisFsmAddBlockList()`（`ais_fsm.c:3750`）将 AP 加入临时黑名单，时长由 `u2DeauthReason` 决定。

指数退避的设计意图是：偶发断连（如一次 Beacon Miss）只惩罚 5 分钟，但反复断连的 AP 会被逐步拉长禁试时间（10 分钟、20 分钟、40 分钟……），直到指数增长触及上限。这避免了两个极端：如果用固定 5 分钟，一个持续不稳定的 AP 会被反复尝试（每次 5 分钟后重试、失败、再等 5 分钟）；如果用固定 1 小时，一个只是偶尔抖动的 AP 会被冤枉地长时间屏蔽。

但为什么是 2^N 而不是线性增长（比如 N * 5 分钟）？这不是随意选择——指数退避在两个维度上优于线性增长。第一个维度是总重试次数的收敛性：在任意固定时间窗口 T 内，线性退避的重试次数约为 sqrt(2T/5)，随 T 线性增长（2 小时内约 10 次重试，4 小时内约 15 次）；指数退避的重试次数约为 log2(T/5)，随 T 对数增长（2 小时内约 6 次，4 小时内也才 7 次）。每次重试都消耗扫描+关联+握手的完整流程（数秒到数十秒），对一个持续故障的 AP 来说，线性退避意味着系统会把大量时间浪费在"尝试→失败→等待→再尝试"的循环中；指数退避则通过快速拉长等待时间，让总重试次数收敛到一个固定上界——无论等多久，重试次数都不会爆炸。

第二个维度是误惩罚的恢复速度：假设 AP 故障是间歇性的（比如因固件 bug 每 30 分钟崩溃一次，重启后恢复正常），线性退避在第 3 次断连后惩罚 15 分钟（15/30 = 50% 的恢复窗口被浪费），指数退避惩罚 20 分钟（20/30 = 67%）——指数退避在连续失败时惩罚更重，但这恰恰是设计意图：如果一个 AP 在 5 分钟、10 分钟的短窗口内都没恢复，那它在 20 分钟内恢复的概率也不会太高，此时拉长等待时间是合理的。QCOM 驱动层的 `MAX_BL_TIME = 255000` 毫秒（约 4.25 分钟）硬上限则体现了另一个工程现实——固件侧的漫游模块需要在合理时间内重新评估被拉黑的 AP，过长的黑名单会导致 STA 即使在 AP 恢复后也无法回连，对用户来说就是"明明 AP 好了但 WiFi 还是断的"。

## 3.5 特殊场景：重连失败的三种死法

重连失败不是手术（连接）失败，是术后恢复出了问题——伤口愈合了（L2 连接成功）但感染了（DHCP 超时）、或出现排斥反应（AP 拒绝重连）、或体质太弱（省电过度导致 AP 超时）。三种"术后并发症"的代码锚点如下：

| 场景            | 现象                     | 根因                                | 排查方向                              |
| --------------- | ------------------------ | ----------------------------------- | ------------------------------------- |
| 断连后无法重连  | 扫描能找到 AP 但连接失败 | AP 侧黑名单/密码变更/频段不兼容     | 检查 `CTRL-EVENT-ASSOC-REJECT` 日志   |
| 重连成功但无 IP | L2 连接正常但 DHCP 超时  | AP 侧 DHCP 服务器故障/VLAN 配置变更 | 抓包确认 DHCP Discover 是否发出       |
| 休眠唤醒后断连  | 息屏一段时间后 WiFi 断开 | 省电模式下 AP 因不活跃断关联        | 检查 DTIM 间隔和 Listen Interval 配置 |

**排斥反应（ASSOC-REJECT）**：Supplicant 在 `EVENT_ASSOC_REJECT`（`events.c:6474`）中解析 AP 返回的 `status_code`，输出 `WPA_EVENT_ASSOC_REJECT` 日志（`events.c:5960`），其中 `status_code` 字段直接对应 802.11 Status Code——值 1 表示未指定原因，值 17 表示 STA 不在 IBSS 中。如果 status_code 指向安全不兼容，说明密码或加密套件有变更；如果 AP 持续返回 reject 但其他设备正常连接，说明 STA 被 AP 侧黑名单。

**感染（DHCP 超时）**：`DhcpClient` 首次发送 Discover 的超时为 `FIRST_TIMEOUT_MS = 1秒`（`DhcpClient.java:164`），之后指数退避到 `DHCP_TIMEOUT_MS / 2 = 18秒`（`DhcpClient.java:1472`），总超时 `DHCP_TIMEOUT_MS = 36秒`（`DhcpClient.java:216`）后回退到 `DhcpInitState` 重新开始。36 秒是 Android 的硬上限——超过这个时间，Framework 会认为网络不可用并降分。

**体质太弱（DTIM/Listen Interval）**：休眠唤醒后断连的根因是 STA 的 Listen Interval 与 AP 的 DTIM Period 不匹配。QCOM 平台通过 `listen_interval`（`wlan_mlme_public_struct.h:746`）配置 STA 每隔多少个 Beacon 醒来一次；MTK 平台在 `BSS_INFO` 中维护 `ucDTIMPeriod`（`cnm_mem.h:429`），如果 STA 的 Listen Interval 大于 AP 的 inactivity timeout，AP 会在 STA 休眠期间判定其不活跃并发送 Disassoc（reason 4）。

---

# 4 休眠的艺术——省电模式深度剖析

WiFi 省电不是简单地"少用电"——它是一套精密的状态机，涉及 802.11 协议层的 PS-Poll 机制、Android Framework 层的 WifiLock 机制、以及驱动/固件层的 QPower 策略。如果说断连是急诊，省电就是慢性病管理——省电做得好，续航翻倍（体质调理到位）；做得差，要么费电（过度亢奋）要么断连（调理过度导致昏厥）。本节只沿"省电如何导致断连"这一条线索展开，完整的省电状态机（TWT 协商细节、QPower 全参数调优）不属于断连主题，不在本文展开。

## 4.1 802.11 省电基础：PS-Poll、TIM 与 TWT

802.11 协议定义了两种 STA 功耗模式（802.11-2024 §10.2）：Active Mode（始终监听）和 Power Save Mode（大部分时间休眠，只在特定时刻醒来检查缓存数据）。PS 模式的核心机制是 **TIM（Traffic Indication Map）**——AP 在每个 Beacon 帧中携带一个位图，标记哪些 STA 有缓存数据待取；STA 醒来读取 TIM，位=0 则继续休眠，位=1 则发送 PS-Poll 帧请求数据。

如果没有 TIM 机制，STA 要么始终监听（Active Mode，功耗最高），要么定期主动查询 AP（轮询模式，增加上行流量和唤醒次数）。TIM 的精妙之处在于"按需唤醒"——AP 负责在 Beacon 中公告"谁有数据"，STA 只需读一个位图就能决定是否醒来，零上行开销。**DTIM（Delivery TIM）** 是 TIM 的特殊版本——每 N 个 Beacon 出现一次（N 由 AP 的 DTIM Period 参数决定，典型值 2-3），包含组播/广播帧的缓存信息。STA 必须在每个 DTIM 时刻醒来，否则丢失广播帧。DTIM 周期越长省电越好但延迟越大——这是功耗-延迟权衡的又一个实例。

STA 进入省电模式时，发送 Null Data Frame 的 PM（Power Management）位设为 1 告诉 AP "开始缓存我的数据"，醒来后发 PM=0 告诉 AP "把缓存的都给我"。802.11ax（WiFi 6）引入的 **TWT（Target Wake Time）** 把省电从"被动等 Beacon"升级为"主动协商唤醒时间"——STA 和 AP 一对一协商唤醒时间点和间隔（Individual TWT），或 AP 广播时间表供多个 STA 共用（Broadcast TWT）。TWT 比 DTIM 的固定周期灵活得多，STA 可以精确告诉 AP "我每 500ms 醒一次，每次醒 10ms"。

这些机制逐代演进的设计意图是一致的：每一代都在压缩 STA 的"无效监听时间"——TIM 消除了盲目的持续监听，DTIM 让广播接收也能省电，TWT 连 Beacon 间隔都不再约束 STA 的唤醒节奏。但省电越激进，状态同步的代价越高——STA 和 AP 必须对"什么时候醒来"达成精确共识，任何偏差（时钟漂移、Beacon 丢失）都会导致 STA 在错误时间醒来或错过缓存数据，这正是 §4.4 中 Beacon 漂移断连的根源。

## 4.2 Android WifiLock：应用层的省电控制

如果说 802.11 的 PS-Poll/TIM 是身体的本能反应（协议层自动省电），那 WifiLock 就是病人的自主意识——应用通过 `WifiManager.WifiLock` 主动告诉系统"我需要 WiFi 保持活跃"，就像病人按铃呼叫护士。Framework 的 `WifiLockManager` 维护所有锁的状态，决定 WiFi 的省电策略：

```java
// WifiManager.java:1830-1914
public static final int WIFI_MODE_NO_LOCKS_HELD = 0;
public static final int WIFI_MODE_FULL = 1;        // 基本锁：保持连接
public static final int WIFI_MODE_FULL_HIGH_PERF = 3;  // 高性能锁（已废弃，自动映射到 LOW_LATENCY）
public static final int WIFI_MODE_FULL_LOW_LATENCY = 4; // 低延迟锁：抑制省电
```

| 锁模式                       | 效果                       | 适用场景           |
| ---------------------------- | -------------------------- | ------------------ |
| `WIFI_MODE_FULL`             | 保持 WiFi 连接，但允许省电 | 后台音乐、推送服务 |
| `WIFI_MODE_FULL_LOW_LATENCY` | 抑制省电，保持低延迟       | 游戏、视频通话     |
| `WIFI_MODE_NO_LOCKS_HELD`    | 无锁，系统自由省电         | 息屏待机           |

`WifiLockManager` 内部通过 `mCurrentOpMode` 跟踪当前最高优先级的锁模式，并通知驱动层调整省电策略。

锁的释放是一条完整的状态转移链——从应用调用 `release()` 到可能触发断连，中间经过多个决策节点：

![WifiLock 决策树](assets/09-STA-%E6%96%AD%E8%BF%9E-%E2%80%94-%E4%BB%8E%E6%96%AD%E5%BC%80%E7%9A%84%E4%BA%94%E5%BC%A0%E9%9D%A2%E5%AD%94%E5%88%B0%E5%9B%9B%E5%B1%82%E6%97%A5%E5%BF%97%E8%AF%8A%E6%96%AD/09-wifilock-decision-tree.svg)

位掩码的实际操作在 `ClientModeImpl.setPowerSave()` 中完成——每个客户端（DHCP 或 WifiLock）通过独立的位来请求禁用省电，只有所有位都清零时才真正开启省电：

```java
// ClientModeImpl.java:3709-3721
public boolean setPowerSave(@PowerSaveClientType int client, boolean ps) {
    if (ps) {
        mPowerSaveDisableRequests &= ~client;   // 清除该客户端的禁用位
    } else {
        mPowerSaveDisableRequests |= client;     // 设置该客户端的禁用位
    }
    // 判定：所有位清零（==0）才真正开启省电
    // 位定义在 ClientMode.java:63-64：
    //   POWER_SAVE_CLIENT_DHCP       = 0x1  ← DHCP 流程设置/清除
    //   POWER_SAVE_CLIENT_WIFI_LOCK  = 0x2  ← WifiLock 设置/清除
    boolean actualPs = mPowerSaveDisableRequests == 0;
    mWifiNative.setPowerSave(mInterfaceName, actualPs);
}
```

就像护士收到按铃后需要经过多道确认才能执行医嘱——决策树中"Framework 通知驱动进入深度省电"这一步，在代码层面是一条四跳的调用链：`WifiLockManager.updateOpMode()`（`WifiLockManager.java:823`）检测无锁持有 → `resetCurrentMode()` 合并 `mPowerSaveDisableRequests` 位掩码，确认所有客户端禁用请求清除后调用 `mWifiNative.setPowerSave()`（`ClientModeImpl.java:3727`）→ AIDL 跨进程到 `SupplicantStaIfaceHalAidlImpl.setPowerSave()`（`SupplicantStaIfaceHalAidlImpl.java:1554`），指令从 Java 层跨入 C 层 → `nl80211_set_power_save()`（`driver_nl80211.c:10620`）向内核发送 `NL80211_CMD_SET_POWER_SAVE`，驱动/固件将 STA 切换到 PS 模式。

这个位掩码设计是关键——如果没有它，每个客户端的锁释放都会独立触发一次省电模式切换，导致 N 个客户端释放锁时产生 N 次无意义的 `setPowerSave` 调用（实际场景中可能每秒触发数十次），驱动层会因频繁的 PS 模式切换而产生额外功耗，反而违背省电的初衷。

这条链路的每一跳都有日志锚点：Framework 层搜 `Setting power save to`（ClientModeImpl 的 verbose log），Supplicant 层搜 `nl80211: Setting PS state`，驱动层搜 `wow_reason`（QCOM）或 `PS_PROFILE`（MTK）。断连排查时沿着这条链路自上而下检查，就能确定省电指令是否真正到达了固件。

这就是为什么有些 App 释放 WifiLock 后用户会投诉"息屏断网"——不是 WiFi 坏了，而是省电策略正确地执行了"无人需要连接 → 进入深度省电"的逻辑。游戏和视频通话类 App 必须持有 `WIFI_MODE_FULL_LOW_LATENCY` 锁，否则息屏后延迟飙升甚至断连。

## 4.3 驱动层省电：QPower 与 MTK 策略

驱动和固件层的省电机制比应用层更激进：

**QCOM 平台**：QPower 是固件级省电 offload，核心策略包括：

- **Deep Sleep**：无数据传输时，WiFi 芯片进入深度休眠，只保留 Beacon 监听
- **Beacon Offload**：固件自主解析 Beacon/TIM，减少唤醒 Host 的次数
- **Scan Offload**：息屏时用 PNO（Preferred Network Offload）在固件层做低功耗扫描

**MTK 平台**：类似策略但实现路径不同——通过 `WLAN_CFG_TYPE_PS_PROFILE_*` 参数控制省电行为，AIS FSM 在 `AIS_STATE_NORMAL_TR` 状态下根据配置切换省电模式。MTK 的省电分三级：CAM（Continuous Access Mode，全速）、PS（Power Save，标准省电）、PS-Poll（深度省电），由驱动根据流量模式和 WifiLock 状态动态切换。两个平台的核心差异在于决策位置：QCOM 把省电策略下沉到固件（Host 只发配置，固件自主执行），MTK 则由驱动层的 AIS FSM 集中决策（固件更像执行者而非决策者）。这就像同一台手术的两种麻醉管理模式——QCOM 是"麻醉机自主运行"（固件根据内置策略自主调节麻醉深度，麻醉师只在术前设好参数），MTK 是"麻醉师全程手动调控"（驱动层的 AIS FSM 实时根据流量和锁状态调整省电深度，固件只负责执行指令）。把两种决策位置并排看，区别就清楚了。两种模式各有优劣：QCOM 的自主模式减少了 Host 唤醒次数（省电效果更好），但出了问题需要 QXDM 才能看到固件的决策过程；MTK 的手动模式在驱动日志中完全可追溯（排查更透明），但 Host 侧的频繁决策增加了唤醒开销。

具体到省电-唤醒的决策链路，QCOM 的固件在无数据传输时自主进入 Deep Sleep，唤醒延迟取决于 DTIM 周期（典型 200-300ms），Host 侧通过 `wow_reason` 日志只能看到"被什么唤醒"，看不到"睡了多久"。MTK 的驱动侧 `EVENT_PS_PROFILE_CHANGE` 事件会记录省电模式的每次切换（CAM→PS→PS-Poll），连同切换原因一起写入日志——这意味着 MTK 的省电状态变化在驱动日志中完全可追溯，而 QCOM 的同等信息需要 QXDM 固件日志。反过来，QCOM 的 Beacon Offload 能力更强——固件自主解析 TIM 位图，只有当 STA 真的有缓存数据时才唤醒 Host；MTK 的 Beacon 解析更多在驱动层完成，Host 唤醒频率相对更高，省电效果略逊但排查更透明。

这种架构差异在实际排查中影响巨大。当用户报告"息屏后 WiFi 断开"，MTK 平台的驱动日志会完整记录省电状态切换的全过程：CAM→PS（息屏触发）→ PS-Poll（无流量 30 秒后）→ Beacon Miss → 断连——每一步都有时间戳和切换原因，工程师只需看驱动日志就能还原事件链。QCOM 平台的 Host 日志则只看到最终结果：`QCA_DISCONNECT_REASON_BEACON_MISS_FAILURE`（值 14）和 `locally_generated=1`，中间的省电决策过程（固件何时进入 Deep Sleep、唤醒延迟是否异常、Beacon Offload 是否漏解析了 TIM）全部隐藏在固件内部，需要 QXDM 抓取固件日志才能看到——而 QXDM 通常只在实验室环境可用，用户设备上无法获取。这不是 QCOM 的设计缺陷，而是固件自主决策模式的必然代价：省电效果越好（Host 唤醒越少），调试信息就越稀缺。两种架构代表了"性能优先"和"可观测性优先"的工程取舍——选 QCOM 还是 MTK，本质上是在问：你的团队更擅长用 QXDM 分析固件日志，还是更依赖驱动日志的透明性？

排查省电相关断连时，QCOM 关注 `wow_reason`（唤醒原因）和 `suspend_mode`（休眠模式）日志，MTK 关注 `PS_PROFILE` 和 `EVENT_PS_PROFILE_CHANGE` 日志——这些关键字在 §6 的四层诊断中会反复出现。

## 4.4 省电与断连的关系

省电机制是断连的"隐形杀手"之一。三种常见问题症状相似但病因完全不同——对比才能区分：

| 场景            | 触发条件                                                     | 日志特征                                               | 区别标志                           | 排查方向                                              |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------- |
| Beacon 漂移     | STA 唤醒时钟与 AP Beacon 时钟存在微小偏差，长期累积后在错误时间醒来 | `bmiss` 计数在息屏后**缓慢增长**（非突然跳变）         | bmiss 渐进式增长，与 §5.1 交叉对照 | 检查 DTIM 间隔、Listen Interval 配置                  |
| AP 侧超时       | STA 休眠时间过长，AP 认为 STA 已离开                         | `CTRL-EVENT-DISCONNECTED reason=4 locally_generated=0` | 断连前**无 bmiss 增长**            | 检查 WifiLock 持有情况、AP 的 inactivity timeout 设置 |
| QPower 过度省电 | 固件省电过于激进，需要活跃时未能及时唤醒                     | `QCA_DISCONNECT_REASON_PEER_XRETRY_FAIL`（值 11）      | 仅在**息屏期间**出现               | 检查 QPower 策略配置、降低省电等级                    |

这三种症状就像急诊里三种病因完全不同的昏厥——低血糖（Beacon 漂移，能量供给不足）、癫痫发作（AP 侧超时，间歇性失控）、心梗（QPower 过度省电，关键时刻供血中断）：表面都是"人倒下了"，但常规化验指标各不相同，用药方向也截然相反。对照表格"区别标志"一列，就像给昏厥病人查血糖、做脑电图、拉心电图——先分清是哪种昏厥，再决定补糖、抗癫痫还是溶栓。

## 4.5 游戏模式的让步

当用户进入游戏模式或开启 WiFi 低延迟模式时，省电策略需要让步。Framework 通过 `WIFI_MODE_FULL_LOW_LATENCY` 锁通知驱动层：

- QCOM：降低 QPower 省电等级，增加固件唤醒频率
- MTK：调整 PS 参数，降低省电深度
- 共同效果：延迟降低，功耗上升

这就是为什么"开游戏模式费电"——不是游戏本身费电，而是 WiFi 从省电模式切换到了全速模式。

省电机制贯穿 802.11 协议层（PS-Poll/TIM/TWT）、Android Framework 层（WifiLock）和驱动/固件层（QPower/MTK PS），三层策略的协调决定了"省多少电"和"会不会断连"之间的平衡。当断连发生在息屏期间或省电模式切换时，优先排查 §4.4 中的三个常见问题——它们是断连的"隐形杀手"，单看日志容易误诊为信号问题。

---

# 5 13 种病因速查——无网络原因与日志特征

急诊手册的核心是"症状→病因→治疗"三联。如果说前四节是分诊流程，这一节就是急诊手册的 13 张典型 X 光片——每张片子对应一种病因，看多了就能一眼识别。以下按现象分类，列出 13 种常见断连原因，每种给出关键日志关键字和快速定位方法。

## 5.1 Beacon Miss → 断连

**现象**：WiFi 显示已连接但突然断开，用户感觉"信号突然没了"。

**病因**：STA 连续丢失 Beacon 帧（典型阈值 7-20 个），驱动判定链路丢失。这就像心电监护仪连续检测不到心跳——监护仪不会在第一次漏跳就报警，而是等连续多次（阈值）都检测不到才判定"心跳停止"。

**关键日志**：

- QCOM：`bmiss` 计数递增、`QCA_DISCONNECT_REASON_BEACON_MISS_FAILURE`（值 14）。bmiss 阈值由 `ucfg_mlme_get_roam_bmiss_final_bcnt()`（`wlan_mlme_ucfg_api.c:965`）读取，字段定义在 `wlan_mlme_public_struct.h:2024`，典型值 7-20
- MTK：`DISCONNECT_REASON_CODE_RADIO_LOST`（值 1）
- Supplicant：`CTRL-EVENT-DISCONNECTED reason=4 locally_generated=1`

**快速定位**：搜索 `bmiss` 和 `beacon` 关键字。如果 bmiss 计数持续增长后触发断连，说明 AP 信号覆盖不足或环境干扰。

**代码路径**：固件检测到 Beacon miss 后通过 `missed_beacon_ind` 事件通知 Host，`lim_ps_offload_handle_missed_beacon_ind()`（`lim_api.c:1755`）接收该事件并调用 `lim_send_heart_beat_timeout_ind()`（`lim_api.c:1735`）向 LIM 消息队列发送 `SIR_LIM_HEART_BEAT_TIMEOUT`，最终触发断连。理解这条链路的意义在于定位断点——如果固件日志显示 bmiss 在增长但 Host 没收到 `missed_beacon_ind`，问题在固件到 Host 的事件通道；如果 Host 收到了但没触发断连，问题在 LIM 消息处理。

**双平台检测机制对比**：QCOM 和 MTK 在 Beacon Miss 检测上的核心差异是"谁在数"和"数到多少算断"。QCOM 采用两阶段 firmware offload 检测——固件内部维护 bmiss 计数器，当计数达到 `gRoamBmissFirstBcnt`（默认 10，`cfg_mlme_lfr.h:1821`）时触发第一次 bmiss 事件，固件开始漫游扫描；计数继续增长到 `gRoamBmissFinalBcnt`（默认 20，`cfg_mlme_lfr.h:1846`）时触发最终断连。两个阈值都通过 `wlan_cm_roam_offload.c:89-93` 下发到固件，Host 侧只做配置和结果接收，计数过程完全在固件内完成。这意味着 QCOM 的 bmiss 中间状态（10-20 之间）在 Host 日志中不可见，需要 QXDM 固件日志才能观察到漫游扫描的触发时机。

MTK 采用单阶段 driver-side 检测——阈值直接硬编码在驱动中：Infrastructure 模式为 `AIS_BEACON_TIMEOUT_COUNT_INFRA = 10`（`ais_fsm.h:42`），Ad-hoc 模式为 `AIS_BEACON_TIMEOUT_COUNT_ADHOC = 30`（`ais_fsm.h:41`）。固件检测到 Beacon 丢失后通过事件通知驱动，驱动侧的 `aisBssBeaconTimeout()`（`ais_fsm.c:6825`）接收并调用 `aisBssBeaconTimeout_impl()`（`ais_fsm.c:6834`）处理。与 QCOM 不同的是，MTK 的 `ENUM_BEACON_TIMEOUT_REASON`（`wsys_cmd_handler_fw.h:1941`）枚举了 14 种 Beacon 超时原因——从 `HW_BEACON_LOST_NONADHOC`（硬件丢失）到 `TSF_DRIFT`（时钟漂移）到 `NULL_FRAME_THRESHOLD`（空帧阈值），这些细分原因在驱动日志中直接可见，不需要额外工具。MTK 的 `aisHandleBeaconTimeout()`（`ais_fsm.c:6901`）在执行断连前还会检查是否正在进行漫游——如果正在漫游中，Beacon Timeout 事件会被推迟处理，避免漫游过程中的误断连。

QCOM 的两阶段设计给了固件更大的自主权（可以在 first_bcnt 和 final_bcnt 之间尝试漫游恢复），但代价是 Host 侧可见性差；MTK 的单阶段设计阈值更小（10 vs 20），断连更早触发，但 Beacon Timeout Reason 的 14 种细分为排查提供了更丰富的信息。

**断开检测的端到端延迟**：用户感知到的"突然断网"其实是一个缓慢恶化的过程——从第一个 Beacon 丢失到 Framework 收到断连事件，端到端延迟的绝大部分消耗在 Beacon Miss 的累积阶段。以 QCOM 平台、Beacon Interval = 100 TU（102.4 ms）为例：固件侧 bmiss 计数从 0 累积到 `gRoamBmissFinalBcnt`（默认 20）需要约 20 * 102.4 ms = 2.05 秒，这是延迟链中唯一的"固定延迟"——取决于 Beacon Interval 和阈值配置，无法压缩。固件触发断连后，事件经过 WMI→WMA→LIM→消息队列→Supplicant→nl80211→AIDL→Framework 的八跳传递链，总耗时约 10-50ms（PCIe 总线传输 + 消息队列调度 + 跨进程调用）。

这段延迟可拆成两段看：真正的时间瓶颈在 bmiss 累积阶段——QCOM 平台累积到 20 需要 2 秒，MTK 平台阈值 10 需要约 1 秒，传递链的 10-50ms 只占端到端延迟的不到 3%。如果固件能在 bmiss=5（而非 20）时就触发断连，端到端延迟可从 2 秒压缩到 0.5 秒——但代价是误触发率飙升，因为短暂的 Beacon 丢失（如 STA 短暂遮挡、信道竞争导致的偶发丢帧）也会被判定为链路丢失。这意味着：当用户报告"突然断网"时，链路质量的恶化其实从 1-2 秒前就开始了，固件层的 RSSI 下降和 bmiss 增长是最早的预警信号。

**为什么 Peer Kickout 在 LIM 而非 PE？** QCOM 驱动的事件分发遵循 WMI→WMA→LIM→PE 四层架构，但不同 kickout 类型走的路径不同——这个差异决定了断连时"是否先探测"。WMA 层的 `wma_peer_sta_kickout_event_handler()`（`wma_mgmt.c:377`）通过 switch-case 将不同 kickout reason 分流到完全不同的处理路径：

```c
// qcacld-3.0/core/wma/src/wma_mgmt.c:377-472
switch (kickout_event->reason) {
    case WMI_PEER_STA_KICKOUT_REASON_IBSS_DISCONNECT:  // IBSS 断连 → 忽略
        goto exit_handler;

    case WMI_PEER_STA_KICKOUT_REASON_TDLS_DISCONNECT:  // TDLS 断连 → 专用处理
        del_sta_ctx->reasonCode = HAL_DEL_STA_REASON_CODE_KEEP_ALIVE;
        wma_send_msg(wma, SIR_LIM_DELETE_STA_CONTEXT_IND, ...);
        goto exit_handler;

    case WMI_PEER_STA_KICKOUT_REASON_UNSPECIFIED:      // 未指定 → 转 Beacon Miss 路径
        wma_beacon_miss_handler(wma, vdev_id, ...);     // 复用 Path A，先探测再断连
        goto exit_handler;

    case WMI_PEER_STA_KICKOUT_REASON_XRETRY:           // TX 重试超限
    case WMI_PEER_STA_KICKOUT_REASON_INACTIVITY:       // 对端不活跃
    case WMI_PEER_STA_KICKOUT_REASON_SA_QUERY_TIMEOUT: // SA Query 超时
    default:
        break;  // 汇入默认路径：直接发 SIR_LIM_DELETE_STA_CONTEXT_IND → LIM 踢出
}
// 默认路径：根据 reason 映射 HAL 码后发给 LIM
//   SA_QUERY_TIMEOUT → HAL_DEL_STA_REASON_CODE_SA_QUERY_TIMEOUT (0x6)
//   XRETRY           → HAL_DEL_STA_REASON_CODE_XRETRY (0x7)
//   其他             → HAL_DEL_STA_REASON_CODE_KEEP_ALIVE (0x1)
wma_send_msg(wma, SIR_LIM_DELETE_STA_CONTEXT_IND, del_sta_ctx, 0);

```

就像监护仪对不同心律异常分级响应——偶发早搏先观察确认、室颤直接电击——WMA 层的关键分流也遵循同样的逻辑：`UNSPECIFIED` 走 `wma_beacon_miss_handler()` 复用 Beacon Miss 路径（先探测再断连），而 `XRETRY`/`INACTIVITY`/`SA_QUERY_TIMEOUT` 三者汇入默认路径直接发 `SIR_LIM_DELETE_STA_CONTEXT_IND` 给 LIM。

两条路径进入 LIM 后的命运也不同：Beacon Miss 走 `WMA_MISSED_BEACON_IND` 消息到达 LIM 的 `lim_ps_offload_handle_missed_beacon_ind()`（`lim_api.c:1755`），触发 `SIR_LIM_HEART_BEAT_TIMEOUT` 心跳超时，LIM 的心跳处理逻辑会先尝试探测 AP 是否还在；XRETRY 和 SA Query Timeout 则走 `SIR_LIM_DELETE_STA_CONTEXT_IND` 消息直达 LIM 的 `lim_link_monitoring_algo.c:213`，跳过探测直接执行 `lim_send_deauth_mgmt_frame()` + `lim_tear_down_link_with_ap()` + `wlan_dlm_add_bssid_to_reject_list()`。

QCOM 把这条"踢出决策"放在 LIM（Link Integrity Module）而非 PE（Protocol Engine）是有意为之——PE 负责协议状态转换（Auth→Assoc→Connected），LIM 负责链路完整性监控（心跳、重试、SA Query）。踢出是链路完整性决策，不是协议状态决策，所以 WMA 把 `SIR_LIM_DELETE_STA_CONTEXT_IND` 发给 LIM 而非 PE。MTK 的架构对应关系不同——AIS FSM 同时承担了 LIM 和 PE 的职责，`aisFsmStateAbort()` 既做链路监控又做状态转换，没有 LIM/PE 的分层。

**排查步骤**：

1. 搜索 `bmiss` 确认计数趋势——渐进式增长（§4.4 中的 Beacon 漂移）和突然跳变（信号遮挡）病因不同
2. 检查断连前的 RSSI 变化——如果 RSSI 在断连前持续下降（如从 -65dBm 降到 -85dBm），确认是覆盖问题
3. 确认 AP 侧是否正常——如果 STA 丢失 Beacon 但其他设备正常，可能是 STA 天线或射频通路异常
4. QCOM 平台额外关注 `hwbmissswitch2swbmiss`——硬件 Beacon miss 切换到软件 Beacon miss 说明射频前端可能有问题

## 5.2 ARP 无响应 → 断连前兆

**现象**：WiFi 图标变感叹号，过一会儿断开。

**病因**：Framework 的 `NetworkMonitor` 定期发送 ARP 探测网关可达性，连续无响应则通过 `NetworkScoreManager` 降分，最终触发断连。关键日志：`NetworkMonitor/101`、`Validation probe`、`isCaptivePortal`。ARP 失败通常是 AP 侧问题（网关无响应），不一定是 WiFi 链路问题——先确认 L2 连接正常（`CTRL-EVENT-CONNECTED` 在 ARP 失败之前），再排查网关侧。这套 ARP 探测就像护士定期量体温——量到正常体温说明病人（网关）还健在，量不到（ARP 无回复）指向网关侧失联，而非 WiFi 链路（心跳）本身停摆。

为什么 Framework 用 ARP 而不是 ICMP ping 来验证网络可达性？ARP 工作在 L2，不需要 IP 地址分配——在 DHCP 完成之前就能探测网关是否响应；ICMP 需要已分配 IP 和路由表，在"已连接但无 IP"的灰色地带无法使用。ARP 还有一个隐蔽的诊断价值：如果 ARP Request 发出但没有 ARP Reply，问题在网关侧（AP 的 ARP 代理故障或 VLAN 配置变更）；如果 ARP Request 根本没发出，问题在 STA 的 ARP 栈或路由配置——这两种情况的日志表现不同，排查方向完全相反。

## 5.3 CCA Busy（环境干扰大）

**现象**：连接不稳定，频繁断连重连，速率波动大。

**病因**：信道被大量设备占用（微波炉、蓝牙、邻居 WiFi），CCA（Clear Channel Assessment）检测到信道繁忙，帧发送受阻。就像急诊室走廊挤满了人——救护车（数据帧）想进来但找不到空位停车（信道被占用），反复绕圈（重试）直到超时。

**关键日志**：QCOM 的 `CCA busy` 统计、`channel_utilization` 参数。

**快速定位**：搜索 `CCA` 和 `channel_utilization`。如果 busy 比例持续超过 50%，说明信道环境恶劣。

**代码路径**：固件通过 `WMI_CHAN_INFO_EVENTID` 上报 CCA 统计，Host 侧由 `wma_chan_info_event_handler()`（`wma_features.c:5306`）解析 `cca_busy_subband_info` 并填充 `scan_chan_info.cca_busy_time`。BSS 选择时，`cm_get_congestion_pct()`（`wlan_cm_bss_scoring.c:383`）将 CCA 数据转换为拥塞百分比，用于 AP 评分。

**双平台信道评估差异**：QCOM 的 CCA 数据来自固件的射频前端硬件计数器，通过 `WMI_CHAN_INFO_EVENTID` 周期性上报到 Host，粒度精确到每个子频段（subband）。MTK 的信道评估路径不同——驱动通过 `PARAM_CHN_LOAD_INFO`（`wlan_oid.h:3168`）结构体获取每个信道的负载信息，数据来源是 BSS Load Element（802.11-2024 §9.4.2.28）中的 Channel Utilization 字段，而非硬件 CCA 计数器。这意味着 QCOM 的 CCA 数据反映的是物理层的信道繁忙度（包含非 WiFi 干扰源如微波炉），而 MTK 的 Channel Load 更侧重于 802.11 帧层面的信道占用率——两者在纯 WiFi 环境下差异不大，但在有非 WiFi 干扰源的场景中，QCOM 的数据能更准确地反映真实信道质量。

**排查步骤**：

1. 搜索 `CCA busy` 确认信道占用率——持续 >50% 说明环境干扰严重，>70% 基本无法正常通信
2. 对比不同时间段——如果只在特定时段（如晚间）出现，可能是邻居 WiFi 或微波炉干扰
3. 检查是否为 2.4GHz 频段——2.4GHz 干扰源最多（蓝牙、微波炉、USB3.0），切换到 5GHz 可显著改善
4. 与 §5.1 交叉验证——如果同时出现 bmiss 增长，说明干扰已经影响到 Beacon 接收

## 5.4 DHCP 失败 → 连上但无 IP

**现象**：WiFi 显示已连接但无法上网，IP 地址为 169.254.x.x（自分配地址）。

**病因**：L2 连接成功但 DHCP Discover 未获响应。`DhcpClient` 状态机管理整个流程，首次超时 `FIRST_TIMEOUT_MS = 1秒`（`DhcpClient.java:164`），指数退避到 `DHCP_TIMEOUT_MS / 2 = 18秒`（`DhcpClient.java:1472`），总超时 `DHCP_TIMEOUT_MS = 36秒`（`DhcpClient.java:216`）后回退到 `DhcpInitState` 重新开始。关键日志：搜索 `DhcpClient` 和 `DHCP_TIMEOUT`。

36 秒这个总超时值的选择是一个工程权衡——太短会在高延迟企业网络（RADIUS + VLAN 中继，DHCP 服务器响应可能需要 5-10 秒）中误判为失败，太长会让用户在"已连接但无 IP"的假连接状态中等待过久。

为了压缩这个 36 秒窗口，Android 做了两层优化：DHCP Rapid Commit（两步握手替代四步）减少 RTT 次数；漫游时通过 `CMD_REFRESH_LINKADDRESS`（`IpClient.java:2772`）刷新已有 IP 租约、跳过 Discover/Offer 阶段直接复用旧 IP。排查时先确认 L2 连接正常（`CTRL-EVENT-CONNECTED` 在 DHCP 超时之前），再抓包确认 Discover 是否发出——未发出说明 `DhcpClient` 状态机卡住，发出但无响应说明 AP 侧 DHCP 代理故障或 VLAN 配置变更。

前四种是链路层或网络层的"物理性"断连——信号丢失、验证超时、信道拥塞、IP 获取失败，相当于急诊中的外伤和骨折，看得到摸得着。接下来三种则切换到安全认证维度——密码错误、EAP 失败、MIC 攻击检测，这类断连相当于免疫系统疾病，排查重点不在信号强度（体征），而在凭证和密钥协商（免疫应答）。

## 5.5 安全层断连（reason 14/15/23）

三种安全相关断连共享同一个排查思路——先确认 `locally_generated` 方向，再看 reason_code 定位具体机制：

| 原因         | reason | 日志关键字                   | 核心排查点                                                   |
| ------------ | ------ | ---------------------------- | ------------------------------------------------------------ |
| 四次握手超时 | 15     | `4-Way Handshake failed`     | `locally_generated=1` + `WPA_4WAY_HANDSHAKE` 状态 → 大概率密码错误；Supplicant 通过 `could_be_psk_mismatch()`（`events.c:4778`）检测并输出提示 |
| EAP 认证失败 | 23     | `EAP: Authentication failed` | Supplicant 通过 `eapol_sm_failed()`（`events.c:5337`）检测 EAP 状态机失败，触发 `wpas_auth_failed()`（`events.c:5339`）→ 需查 RADIUS 服务器日志 |
| MIC 校验失败 | 14     | `EVENT_MICHAEL_MIC_FAILURE`  | TKIP 连续两次 MIC 失败触发断连（`wpa_supplicant_event_michael_mic_failure()`，`events.c:4952`）→ 偶发是误码，连续是篡改攻击 |

这三个 reason code 的诊断价值差异显著：reason 15（握手超时）的指向性最强——在 PSK 网络中几乎等同于"密码错误"的判决书；reason 23（EAP 失败）需要下钻到 RADIUS 服务器才能定位根因，Host 侧信息不足；reason 14（MIC 失败）则存在误码和攻击的二义性，需要看频率——单次失败可能是射频干扰导致的偶发误码（尤其在 2.4GHz 高干扰环境），连续多次才指向真正的安全威胁。MIC 失败的完整 Supplicant 处理链路（连续两次计数、`EVENT_MICHAEL_MIC_FAILURE` 分发）已在 §2.5 展开。

## 5.6 AP 踢出（reason 1/2/7）

**现象**：正常使用中突然断开，用户无操作。AP 主动发送 Deauth/Disassoc——reason 1（未指定）、2（前认证无效）、7（3 类帧来自未关联 STA）是最常见的 AP 踢出码。日志中 `locally_generated=0` 确认方向，搜索 `CTRL-EVENT-DISCONNECTED` 定位。reason=1 是最模糊的码——它只说明"AP 发了 Deauth"，真正原因必须在 AP 侧日志中查找。

## 5.7 芯片 Crash（SSR → Kernel panic）

**现象**：设备整体掉线，连接状态全部清零，重启后自动重连——芯片崩溃是所有断连中最剧烈的（不是链路断了，而是整个"心脏"停跳后重启）。恢复流程是一条固定的链式反应：

```
固件崩溃 → 内核 SSR/SER 通知 → 驱动卸载重加载 → 连接状态全丢 → 自动重连
```

QCOM 平台上，这条链的日志痕迹是：`cnss: SSR notification` → `QCA_DISCONNECT_REASON_DEVICE_RECOVERY`（值 7）→ 驱动重新 `probe` → Supplicant 收到 `CTRL-EVENT-DISCONNECTED reason=3`。MTK 平台对应 `SER` 日志 → `DISCONNECT_REASON_CODE_CHIPRESET`（值 7）。搜索 `SSR` 或 `SER` 即可定位——芯片崩溃恢复后会自动重连，但所有连接状态（IP、密钥、BSSID）全部丢失，等同于一次冷启动。

## 5.8 RTS/CTS 异常（断流）

**现象**：WiFi 已连接但数据不通——这通常不是断连，而是"断流"。想象一个人想说话，每次开口前都先举手示意（RTS），但对方始终没有点头回应（CTS）——反复举手无人理会，旁观者会认为"这个人无法沟通"。WiFi 的 RTS/CTS 机制正是这种"发言前先确认信道可用"的握手协议：STA 发 RTS，AP 回 CTS，信道预留成功后发送数据帧。但如果 CTS 持续收不到（信道被其他设备占用或隐藏节点持续干扰），数据帧的 TX 重试计数就会不断攀升——和反复举手无人回应的结局一样：通信被判定为失败。

固件检测到 TX 重试超过阈值后，触发 peer kickout 事件。QCOM 平台的完整调用链：

![TX 重试调用链](assets/09-STA-%E6%96%AD%E8%BF%9E-%E2%80%94-%E4%BB%8E%E6%96%AD%E5%BC%80%E7%9A%84%E4%BA%94%E5%BC%A0%E9%9D%A2%E5%AD%94%E5%88%B0%E5%9B%9B%E5%B1%82%E6%97%A5%E5%BF%97%E8%AF%8A%E6%96%AD/09-tx-retry-callchain.svg)

这条链路与 Beacon Loss 断连（§5.1）的区别在于：Beacon Loss 走 `wma_beacon_miss_handler()` 路径（`wma_mgmt.c` 中 `WMI_PEER_STA_KICKOUT_REASON_UNSPECIFIED` case），且在断连前会先发 Probe Request 尝试探测 AP；TX 重试失败则走 `HAL_DEL_STA_REASON_CODE_XRETRY` 路径，直接发 Deauth 断开，不做探测——因为 AP 还能收到帧（只是 CTS 回不来），探测无意义。

排查时搜索 `retry` 和 `xretry`：如果 TX 重试率只在特定时段上升，说明信道竞争激烈；如果持续上升，可能存在隐藏节点或硬件异常。MTK 平台对应 `DISCONNECT_REASON_CODE_RADIO_LOST_TX_ERR`（值 9），调用链通过 AIS FSM 的 `MSG_AIS_ABORT` 消息传递。

## 5.9 硬件链路异常 vs 省电模式异常

息屏后 WiFi 断开，亮屏又恢复——是省电模式的问题？没那么简单。如果重启后 WiFi 功能完全丧失，连扫描都做不了，那问题就不在省电而在硬件。这两种断连症状相似，但病因完全不同——一个是硬件层面的链路故障，一个是协议层面的超时。急诊中也有类似的鉴别难题：同样是一侧肢体无力，可能是脑卒中（PCIe 链路断了，硬件通路受损），也可能是低血糖发作（省电过度，供给不足但器官完好）——前者需要立即影像检查确认血管状态，后者补糖就能恢复。WiFi 的 PCIe 链路异常和省电模式异常也遵循同样的鉴别逻辑：一个查硬件通路，一个查协议配置。省电模式异常的完整机制（reason=4、DTIM 间隔、WifiLock 持有）已在 §4.4 展开，这里聚焦它与 PCIe 硬件链路的鉴别——对比才能区分：

| 维度         | PCIe 链路异常                               | 省电模式异常                                                 |
| ------------ | ------------------------------------------- | ------------------------------------------------------------ |
| **现象**     | WiFi 功能完全丧失，无法扫描或连接           | 息屏后断连，亮屏后恢复                                       |
| **病因**     | WiFi 芯片与 Host 之间的 PCIe 链路故障       | STA 休眠过深，AP 因不活跃断关联（reason 4）                  |
| **关键日志** | `pcie link down`、`pci_device_suspend` 异常 | `reason=4` + `locally_generated=0`                           |
| **恢复方式** | 需要硬件层面排查，重启可能恢复              | 亮屏后自动重连                                               |
| **排查方向** | 搜索 `pcie` 和 `pci`                        | 搜索 `reason=4` 和 `DISASSOC_DUE_TO_INACTIVITY`，检查 WifiLock 持有和 DTIM 间隔 |

## 5.10 MCC 分时竞争（P2P+STA 双连接）

使用投屏或热点时 WiFi 频繁断连？大概率是 MCC（Multi-Channel Concurrency）分时竞争——一台射频硬件要在两个不同信道之间来回切换，就像两个病人共用一台呼吸机：STA 和 P2P/SoftAP 各占一个信道，驱动轮流将射频资源分配给两者，轮到 STA 时它才能"呼吸"（收发 Beacon 和数据），轮到 P2P 时 STA 就得憋着。呼吸机切换不够快，STA 就会憋过头——丢 Beacon、丢数据，最终断连。不同共存场景的冲突模式差异很大：

| 共存场景          | 信道关系                                      | 冲突模式                                           | 典型表现                                    |
| ----------------- | --------------------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| STA + P2P 投屏    | 不同信道（如 STA 2.4G Ch1 + P2P 5G Ch36）     | 频繁切换，STA 驻留时间被压缩                       | 投屏时 WiFi 断连，bmiss 只在 P2P 活跃时增长 |
| STA + SoftAP 热点 | 不同信道（如 STA 5G Ch149 + SoftAP 2.4G Ch6） | 切换频率较低，但 SoftAP 启动瞬间 STA 可能丢 Beacon | 开热点后 STA 短暂断连再恢复                 |
| STA + STA 双连接  | 不同信道                                      | 两个 STA 轮流驻留，延迟双向增大                    | 双 WiFi 场景下两个连接都不稳定              |

驱动层通过 MCC 调度机制管理信道切换。两个关键问题：谁来决定各信道分多少时间？谁来判断当前是否处于 MCC 模式？

QCOM 的答案是固件侧调度 + Host 侧配额控制。`wlan_hdd_set_mcc_adaptive_sched()`（`wlan_hdd_mcc_quota.c:68`）开启自适应调度后，固件根据各 vdev 的流量需求动态调整驻留时间比例。Framework 也可以通过 `wlan_hdd_cfg80211_set_mcc_quota()`（`wlan_hdd_mcc_quota.c:85`）显式设置某个 vdev 的信道时间配额——比如给投屏的 P2P vdev 分配更多时间以保证画质。

MTK 的答案是 CNM（Channel Number Manager）模块集中决策。`ENUM_CNM_MODE_MCC`（`cnm.c:210`）是判定入口：两个 vdev 使用不同信道且未启用 DBDC（Dual-Band Dual-Concurrent），就进入 MCC 分时模式。

排查时搜索 `mcc` 和 `concurrency`：如果 bmiss 计数只在 P2P 活跃时增长，就是 MCC 问题。QCOM 的 `MCC` 相关日志会显示信道切换频率和驻留时间，MTK 的 CNM 日志会显示当前模式（MCC/SCC/MBMC）。

13 种病因的 X 光片已经齐了。下面这张导航表把"看到什么现象"和"查哪些小节"直接对应起来——拿到日志后先定位现象，再按右列的关键字搜索，就能快速缩小排查范围。

| 现象                        | 查哪些小节       | 关键日志关键字                                         |
| --------------------------- | ---------------- | ------------------------------------------------------ |
| 信号突然没了，WiFi 断开     | §5.1, §5.3       | `bmiss`, `BEACON_MISS_FAILURE`, `CCA busy`             |
| WiFi 图标变感叹号，无法上网 | §5.2, §5.4       | `NetworkMonitor`, `ARP`, `DhcpClient`, `DHCP_TIMEOUT`  |
| 连接中突然断开，密码正确    | §5.5, §5.6       | `4-Way Handshake failed`, `EAP`, `AUTH_FAILED`, `MIC`  |
| 正常使用中突然断开，无操作  | §5.7, §5.8, §5.9 | `locally_generated=0`, `SSR`, `SER`, `xretry`          |
| 息屏后断连，亮屏恢复        | §5.9, §4.4       | `reason=4`, `DISASSOC_DUE_TO_INACTIVITY`, `PS_PROFILE` |
| 投屏/开热点时 WiFi 不稳定   | §5.10            | `mcc`, `concurrency`, `bmiss`（仅 P2P 活跃时增长）     |

但急诊医生不会只看一张片子就下结论——血常规、CT、心电图交叉验证才能确诊。WiFi 断连诊断同理：单独看任何一层日志都可能被表象迷惑，接下来的四层日志对照法，就是把 Framework、Supplicant、驱动、固件四层数据摆在一起逐层排除，直到锁定根因。

---

# 6 四层对照诊断法——日志分析方法论

急诊的最终确诊靠多项检查交叉验证。WiFi 断连诊断也是如此——单独看一层日志容易误诊，必须四层对照才能定位根因。四层日志恰好对应急诊的四项检查：Framework 层是问诊记录（病人主诉"我断了" + 医生决策"重连还是放弃"），Supplicant 层是化验单（`reason_code` 和 `locally_generated` 是核心指标，就像血常规里的白细胞计数），驱动层是 CT 扫描（QCOM 的 `qca_reason` 能精确定位病灶位置），固件层是基因检测（最早发现变异，但需要前三层对照才能确诊）。下面逐层展开。

## 6.1 Framework 层日志

Framework 日志告诉你"系统做了什么决策"——关键锚点：`CMD_DISCONNECT`（`ClientModeImpl.java:462`，Framework 发起断连）、`handleNetworkDisconnect`（`ClientModeImpl.java:3520`，断连处理入口）、`WIFI_STATE_DISCONNECTED` + `handleConnectionStateChanged`（`WifiConnectivityManager.java:3236`，连接状态变更）。但 Framework 不告诉你"为什么做这个决策"——如果 `CMD_DISCONNECT` 出现在日志中，说明断连是 Framework 主动发起的（§1.2 的四种策略之一），需要回溯 Framework 日志中的触发条件（飞行模式、网络评分、省电策略、SSID 删除）。

## 6.2 Supplicant 层日志

Supplicant 是协议栈的"中间人"，能同时看到上层命令和下层事件。核心字段是 `CTRL-EVENT-DISCONNECTED`（`events.c:4770`）中的 `reason` 和 `locally_generated`——`locally_generated=1` 表示本地驱动/固件主动断开，`=0` 表示 AP 发送 Deauth/Disassoc。其他关键锚点：`CTRL-EVENT-ASSOC-REJECT`（关联被拒）、`WPA: 4-Way Handshake failed`（`events.c:4836`，密码错误）、`AUTH_FAILED`（`events.c:5339`，EAP 认证失败）。

这层日志是四层诊断的"分叉点"——`locally_generated` 的值决定后续排查方向：`=1` 往下看驱动层的 `qca_reason` 或 MTK 的 `DiscReason`，`=0` 往 AP 侧查原因。如果 Supplicant 日志缺失（Supplicant 进程崩溃或日志被截断），排查只能从 Framework 的 `handleNetworkDisconnect` 和驱动层的断连事件反推——此时 `reason` 字段仍然可用，但 `locally_generated` 的判定需要从驱动日志中的 `qca_disconnect_reason_codes` 或 MTK 的 `Locally[]` 标记间接推断。

## 6.3 驱动层日志——QCOM

QCOM 驱动层通过 `qca_disconnect_reason_codes` 枚举提供最精细的断连原因。先看速查表定位断连类型，再看代码确认枚举定义：

| 值   | 枚举名                         | 含义                | 诊断方向                                           |
| ---- | ------------------------------ | ------------------- | -------------------------------------------------- |
| 0    | `UNSPECIFIED`                  | 未指定              | 需结合 vendor event 和固件日志进一步定位           |
| 1    | `INTERNAL_ROAM_FAILURE`        | 内部漫游失败        | 检查漫游目标 AP 是否可达、FT/OKC 密钥是否有效      |
| 2    | `EXTERNAL_ROAM_FAILURE`        | 外部漫游失败        | 检查漫游触发条件（RSSI 阈值）和目标 AP 配置        |
| 3    | `GATEWAY_REACHABILITY_FAILURE` | 网关不可达          | 检查 ARP 探测、网关侧路由配置                      |
| 4    | `UNSUPPORTED_CHANNEL_CSA`      | 不支持的 CSA 信道   | AP 发起信道切换，STA 不支持目标信道                |
| 5    | `OPER_CHANNEL_DISABLED_INDOOR` | 工作信道被室内限制  | DFS 信道被标记为 indoor-only                       |
| 6    | `OPER_CHANNEL_USER_DISABLED`   | 工作信道被用户禁用  | 检查 WiFi 设置中的信道配置                         |
| 7    | `DEVICE_RECOVERY`              | 芯片崩溃恢复（SSR） | 搜索 `cnss: SSR notification`，查看固件 crash dump |
| 8    | `KEY_TIMEOUT`                  | 密钥超时            | PMK/GTK 过期，检查密钥刷新机制                     |
| 9    | `OPER_CHANNEL_BAND_CHANGE`     | 工作频段切换        | 2.4G↔5G 切换触发断连                               |
| 10   | `IFACE_DOWN`                   | 接口关闭            | Framework 或驱动主动关闭接口                       |
| 11   | `PEER_XRETRY_FAIL`             | TX 重试超限         | 检查 CCA busy、隐藏节点、信号覆盖                  |
| 12   | `PEER_INACTIVITY`              | 对端不活跃          | AP 判定 STA 不活跃，检查 DTIM/Listen Interval      |
| 13   | `SA_QUERY_TIMEOUT`             | SA Query 超时       | 802.11w PMF 保护帧验证失败                         |
| 14   | `BEACON_MISS_FAILURE`          | Beacon 丢失         | 检查 bmiss 计数、RSSI 趋势、AP 覆盖                |
| 15   | `CHANNEL_SWITCH_FAILURE`       | 信道切换失败        | 驱动执行 CSA 失败                                  |
| 16   | `USER_TRIGGERED`               | 用户主动断开        | 正常操作，无需排查                                 |

值 14/11 → 查信号和信道环境（§5.1/§5.3）；值 7 → 查 SSR/SER 崩溃日志（§5.9）；值 1/2 → 查漫游配置和目标 AP；值 3 → 查网关可达性（§5.2）；值 0 → 需要 QXDM 固件日志才能进一步定位，Host 侧信息不足。802.11 reason code 只能告诉你"断了"，`qca_disconnect_reason_codes` 才能告诉你"为什么断了"——这个枚举是 QCOM 平台诊断的第一手细分依据。

如果说 Supplicant 层的 reason code 是 X 光片（只能看到骨头断了），那这 17 个枚举值就是 CT 扫描的切面——每个值精确定位一种病灶：值 14 是 Beacon 丢失（心律不齐），值 11 是 TX 重试超限（血管堵塞），值 7 是芯片崩溃（心脏骤停），值 13 是 SA Query 超时（免疫排斥）。单看 X 光片只能知道"有问题"，CT 切面才能告诉你"问题在哪里"。

```c
// qca-wifi-host-cmn/os_if/linux/qca_vendor.h:13712
enum qca_disconnect_reason_codes {
    QCA_DISCONNECT_REASON_UNSPECIFIED = 0,
    QCA_DISCONNECT_REASON_INTERNAL_ROAM_FAILURE = 1,
    QCA_DISCONNECT_REASON_EXTERNAL_ROAM_FAILURE = 2,
    QCA_DISCONNECT_REASON_GATEWAY_REACHABILITY_FAILURE = 3,
    QCA_DISCONNECT_REASON_UNSUPPORTED_CHANNEL_CSA = 4,
    QCA_DISCONNECT_REASON_OPER_CHANNEL_DISABLED_INDOOR = 5,
    QCA_DISCONNECT_REASON_OPER_CHANNEL_USER_DISABLED = 6,
    QCA_DISCONNECT_REASON_DEVICE_RECOVERY = 7,
    QCA_DISCONNECT_REASON_KEY_TIMEOUT = 8,
    QCA_DISCONNECT_REASON_OPER_CHANNEL_BAND_CHANGE = 9,
    QCA_DISCONNECT_REASON_IFACE_DOWN = 10,
    QCA_DISCONNECT_REASON_PEER_XRETRY_FAIL = 11,
    QCA_DISCONNECT_REASON_PEER_INACTIVITY = 12,
    QCA_DISCONNECT_REASON_SA_QUERY_TIMEOUT = 13,
    QCA_DISCONNECT_REASON_BEACON_MISS_FAILURE = 14,
    QCA_DISCONNECT_REASON_CHANNEL_SWITCH_FAILURE = 15,
    QCA_DISCONNECT_REASON_USER_TRIGGERED = 16,
};
```

QCOM 驱动的断连处理链路：`hdd_cm_disconnect_complete()` → `hdd_cm_disconnect_complete_pre_user_update()` / `hdd_cm_disconnect_complete_post_user_update()`。在 `pre_user_update` 阶段，驱动通过 `osif_cm_mac_to_qca_reason()` 将 802.11 reason code 转换为 QCOM 私有的 `qca_reason`，缓存在 `adapter->last_disconnect_reason` 中，后续通过 vendor event 上报给 Framework。

这个枚举中有两个值值得深入分析。值 0（`UNSPECIFIED`）表面上是"未指定"，但它存在的意义恰恰是承认断连原因分类系统有边界——当固件检测到断连但无法将其归入任何已知类别时（比如固件内部状态异常、或者新的断连场景尚未被枚举覆盖），它会回退到 `UNSPECIFIED`。从工程角度看，这是一个"诚实的兜底"——宁可上报一个模糊的"我不知道"，也不强行归入一个可能误导排查的类别。诊断时看到 `UNSPECIFIED`，正确的做法不是放弃，而是下钻到固件日志——`UNSPECIFIED` 意味着 Host 侧的分类能力到此为止，答案在更深的层。

值 3（`GATEWAY_REACHABILITY_FAILURE`）的诊断意义更具体：固件通过 ARP 探测确认网关是否可达——如果连续多次 ARP Request 无回复，固件判定网关不可达并触发断连。这个机制和 IPv6 的 NUD（Neighbor Unreachability Detection，RFC 4861）异曲同工，但实现位置不同：NUD 在内核协议栈中运行，而 QCOM 的网关可达性检测在固件中完成——这意味着即使内核的 NUD 还没来得及探测，固件已经先行一步触发了断连。从排查角度看，看到 `GATEWAY_REACHABILITY_FAILURE` 时不应只查 WiFi 链路，还应确认网关侧的 ARP 响应是否正常——这通常指向 AP 的 ARP 代理故障或 VLAN 配置变更，而非 STA 本身的问题。

其他关键日志关键字：`bmiss`（Beacon miss 计数）、`hwbmissswitch2swbmiss`（硬件 Beacon miss 切换到软件 Beacon miss）、`session->disconnect_stats.bmiss`（断连统计中的 bmiss 计数）。QCOM 的诊断链路比 MTK 多一步——同一个 `reason=4` 背后可能是 Beacon Loss 也可能是 TX 重试失败，必须从 vendor event 中提取 `qca_disconnect_reason_codes` 才能确诊。

## 6.4 驱动层日志——MTK

MTK 驱动的断连原因定义在 `wlan_def.h:30-42`。相比 QCOM 的 17 个值，MTK 的 13 个值粒度更粗但覆盖了核心场景：

| 值   | 宏名                | 含义                | 诊断方向                                        |
| ---- | ------------------- | ------------------- | ----------------------------------------------- |
| 0    | `RESERVED`          | 保留                | 不应出现在正常日志中                            |
| 1    | `RADIO_LOST`        | Beacon 丢失         | 检查 bmiss 计数、RSSI 趋势（§5.1）              |
| 2    | `DEAUTHENTICATED`   | 收到 AP 的 Deauth   | `locally_generated=0`，查 AP 侧原因             |
| 3    | `DISASSOCIATED`     | 收到 AP 的 Disassoc | `locally_generated=0`，常见 reason 4（不活跃）  |
| 4    | `NEW_CONNECTION`    | 用户主动断开        | 正常操作，无需排查                              |
| 5    | `REASSOCIATION`     | 重关联触发断开      | 切换 AP 时的正常行为                            |
| 6    | `ROAMING`           | 漫游触发断开        | 检查漫游策略和目标 AP                           |
| 7    | `CHIPRESET`         | 芯片重置（SER）     | 搜索 `SER` 日志，查看固件 crash dump            |
| 8    | `LOCALLY`           | 本地发起断开        | 通用标记，需结合 `u2DeauthReason` 进一步定位    |
| 9    | `RADIO_LOST_TX_ERR` | TX 重试失败         | 检查 CCA busy、信号覆盖（§5.8）                 |
| 10   | `DEL_IFACE`         | 接口删除            | Framework 或驱动主动删除接口                    |
| 11   | `TEST_MODE`         | 测试模式            | 测试环境触发，生产环境不应出现                  |
| 12   | `BTM`               | BTM 漫游请求        | AP 通过 BSS Transition Management 请求 STA 迁移 |

MTK 的诊断路径比 QCOM 直接——`DiscReason` 在驱动日志中一行就能看到，不需要像 QCOM 那样从 vendor event 中提取细分码。但粒度粗的代价是：值 1（`RADIO_LOST`）同时覆盖了 Beacon Loss 和信号丢失两种场景，需要结合 bmiss 计数和 RSSI 趋势才能区分；值 8（`LOCALLY`）是通用标记，必须看 `u2DeauthReason`（802.11 reason code）才能确认具体原因。这就是为什么 MTK 平台的断连排查经常需要"两行日志交叉确认"——`DiscReason` 给出大类，`u2DeauthReason` 给出细分。这就像急诊确诊要靠化验单和影像双重验证：`DiscReason` 是化验单，只告诉你"哪类异常"（感染还是创伤），`u2DeauthReason` 是影像片，精确指出"病灶在哪"（具体哪根血管）；单看化验单会漏掉细节，单看影像片会失去方向，两张对照才能确诊。

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/nic/wlan_def.h:30-42
#define DISCONNECT_REASON_CODE_RESERVED           0
#define DISCONNECT_REASON_CODE_RADIO_LOST         1
#define DISCONNECT_REASON_CODE_DEAUTHENTICATED    2
#define DISCONNECT_REASON_CODE_DISASSOCIATED      3
#define DISCONNECT_REASON_CODE_NEW_CONNECTION     4
#define DISCONNECT_REASON_CODE_REASSOCIATION      5
#define DISCONNECT_REASON_CODE_ROAMING            6
#define DISCONNECT_REASON_CODE_CHIPRESET          7
#define DISCONNECT_REASON_CODE_LOCALLY            8
#define DISCONNECT_REASON_CODE_RADIO_LOST_TX_ERR  9
#define DISCONNECT_REASON_CODE_DEL_IFACE          10
#define DISCONNECT_REASON_CODE_TEST_MODE          11
#define DISCONNECT_REASON_CODE_BTM                12
```

MTK 驱动通过 AIS FSM（AI Station Finite State Machine）管理 STA 连接状态。断连相关的关键状态是 `AIS_STATE_DISCONNECTING`（ais_fsm.h:118）。断连事件通过 `MSG_AIS_ABORT` 消息传递，携带 `ucReasonOfDisconnect`（断连原因）和 `u2DeauthReason`（802.11 reason code）。

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/mgmt/ais_fsm.c:3819-3822
if (ucReasonOfDisconnect == DISCONNECT_REASON_CODE_DEAUTHENTICATED ||
    ucReasonOfDisconnect == DISCONNECT_REASON_CODE_DISASSOCIATED)
    aisFsmAddBlockList(prAdapter, prAisFsmInfo,
        u2DeauthReason);
```

当收到 Deauth 或 Disassoc 时，MTK 驱动会调用 `aisFsmAddBlockList()` 将 AP 加入临时黑名单——这是驱动层的重连保护机制，与 Framework 层的 `WifiBlocklistMonitor` 形成双重保护。

MTK 日志关键字：`DiscReason`、`Locally[]`（本地发起标记）、`EVENT-ABORT`（AIS FSM 中断事件）、`ucReasonOfDisconnect`。

两个平台的诊断路径对比：QCOM 需要从 vendor event 中提取 `qca_reason`（802.11 reason code 太粗，无法区分 Beacon Loss 和 TX 重试失败），MTK 的 `DiscReason` 在驱动日志中直接可见，不需要额外解析 vendor event。这是 QCOM 平台诊断更复杂的原因之一——同一个 `reason=4` 背后可能是完全不同的病因，必须结合 `qca_disconnect_reason_codes` 才能确诊。

## 6.5 固件层日志

固件层日志是"底层真相"——在症状出现之前就捕捉到最早的信号变化（RSSI 下降、bmiss 开始累积），但通常需要 QXDM 等专用工具，普通 logcat 不可见。关键锚点：`FW_ROAM_EVT`（固件漫游事件，QCOM）、`FW bmiss count`（固件 Beacon miss 计数，QCOM）、`CCA busy`（信道繁忙度）、`RSSI`、`PER`（误包率）。

这些日志的诊断价值和局限性来自同一个特征——它在最底层运行，信息最早但也最难获取。QCOM 平台的固件日志需要 QXDM（通常只在实验室可用），MTK 平台的部分固件事件（如 `EVENT_PS_PROFILE_CHANGE`）会透传到驱动日志中。当固件日志不可见时（用户设备、远程排查），诊断只能依赖驱动层的 `bmiss` 计数、`qca_reason` 和 Supplicant 的 `reason` + `locally_generated`——此时 §6.6 的四层对照法中，固件层用驱动层的统计数据替代，精度略降但诊断逻辑不变。

## 6.6 综合案例：四层对照定位根因

以下是一个真实的断连案例，展示如何从四层日志逐层定位：

```
=== 四层日志对照 ===

【Framework 层】
07-20 14:32:15 WifiConnectivityManager: handleConnectionStateChanged: state=DISCONNECTED
07-20 14:32:15 ClientModeImpl: handleNetworkDisconnect: reason=3
  → Framework 看到断连，reason=3（DEAUTH_LEAVING）

【Supplicant 层】
07-20 14:32:15 wpa_supplicant: CTRL-EVENT-DISCONNECTED bssid=AA:BB:CC:DD:EE:FF reason=4 locally_generated=1
07-20 14:32:15 wpa_supplicant: Auto connect enabled: try to reconnect
  → Supplicant 看到 reason=4（因不活跃断关联），本地发起，触发自动重连

【驱动层 QCOM】
07-20 14:32:14 qcacld: session disconnect_stats.bmiss=20
07-20 14:32:14 qcacld: QCA_DISCONNECT_REASON_BEACON_MISS_FAILURE
  → 驱动层看到 Beacon miss 计数达到 20，触发断连

【固件层】
07-20 14:32:12 FW: bmiss count=15, RSSI=-82dBm
07-20 14:32:13 FW: bmiss count=20, RSSI=-85dBm
  → 固件层看到 RSSI 持续下降，Beacon miss 持续增加

=== 诊断结论 ===
根因：STA 所在位置 RSSI=-85dBm，AP 信号覆盖不足，连续丢失 20 个 Beacon
触发链路：固件检测 bmiss → 驱动断连 → Supplicant 上报 → Framework 处理
治疗方案：改善 AP 位置或增加 AP 密度
```

这个案例展示了四层日志的互补关系：**步骤 1**——固件层给出最早的信号（RSSI 从 -82 降到 -85，bmiss 从 15 涨到 20）；**步骤 2**——驱动层基于 bmiss=20 触发断连决策（`QCA_DISCONNECT_REASON_BEACON_MISS_FAILURE`）；**步骤 3**——Supplicant 层标记 `locally_generated=1` 和 reason=4，触发自动重连；**步骤 4**——Framework 层记录最终状态变化并启动断连扫描。如果只看 Supplicant 日志，只能知道"本地因不活跃断关联"；结合驱动层日志才知道是 Beacon Loss；结合固件层日志才知道根因是信号覆盖不足。四层日志就像急诊的四项检查——单独任何一项都可能误诊，只有交叉对照才能确诊。

上面的案例是"顺藤摸瓜"——从固件层的信号一路追到根因。但实际排查中更常见的是"排除法"——日志指向某个方向，但需要交叉验证才能确认或排除。来看一个反向案例：

```
=== 反向案例：排除 AP 侧问题 ===

【Supplicant 层】
07-21 09:15:33 wpa_supplicant: CTRL-EVENT-DISCONNECTED bssid=AA:BB:CC:DD:EE:FF reason=1 locally_generated=0
  → reason=1（UNSPECIFIED），对端发起。初步判断：AP 主动踢出

【Framework 层】
07-21 09:15:33 ClientModeImpl: handleNetworkDisconnect: reason=3
07-21 09:15:33 WifiConnectivityManager: handleConnectionStateChanged: state=DISCONNECTED
07-21 09:15:34 WifiConnectivityManager: startConnectivityScan: SCAN_IMMEDIATELY
  → Framework 自动重连，但问题在于：AP 为什么踢人？

【驱动层 QCOM】
07-21 09:15:32 qcacld: CCA busy=78%, channel_utilization=82
07-21 09:15:32 qcacld: RSSI=-55dBm
  → 信号很好（-55dBm），但信道极度拥挤（CCA busy 78%）！

【固件层】
07-21 09:15:30 FW: PER=35%, CCA busy=75%
07-21 09:15:31 FW: PER=40%, CCA busy=80%
  → 误包率飙升，信道持续拥塞

=== 排除过程 ===
步骤 1：看 Supplicant → reason=1 + locally_generated=0 → 疑似 AP 踢出
步骤 2：看驱动层 → RSSI=-55dBm，信号没问题 → 排除信号覆盖不足（§5.1）
步骤 3：看固件层 → CCA busy 78%、PER 35% → 确认信道环境恶劣（§5.3）
步骤 4：回看 AP 行为 → AP 因 STA 发帧成功率过低（信道拥塞导致），判定 STA 不活跃，发送 Disassoc（reason 4 被映射为 reason 1）
结论：不是 AP 主动踢人，而是环境干扰导致 AP 误判 STA 不活跃
```

这个反向案例的关键教训：`locally_generated=0` + `reason=1` 只说明"AP 发了 Deauth"，但不能说明"为什么"。真正的原因藏在驱动层的 CCA 统计和固件层的 PER 数据里。如果只看 Supplicant 层就下结论"AP 踢人，换 AP 吧"——方向完全错了。

## 6.7 常用排查命令

四层对照法的每一层都需要对应的"检查工具"——以下命令就是急诊医生打开工具箱后的第一排器械：

| 命令                                                     | 用途                                            | 平台 |
| -------------------------------------------------------- | ----------------------------------------------- | ---- |
| `adb shell dumpsys wifi`                                 | WiFi 全状态转储（含连接历史、扫描结果、锁状态） | 通用 |
| `adb shell wpa_cli status`                               | Supplicant 当前状态                             | 通用 |
| `adb shell wpa_cli bss 0`                                | 当前 BSS 详细信息                               | 通用 |
| `adb logcat -s WifiStateMachine WifiConnectivityManager` | Framework 层日志过滤                            | 通用 |
| `adb logcat -s wpa_supplicant`                           | Supplicant 层日志                               | 通用 |
| `adb logcat -s qcacld wlan`                              | QCOM 驱动层日志                                 | QCOM |
| `adb logcat -s wlan_gen4m`                               | MTK 驱动层日志                                  | MTK  |

---

断连诊断的本质是排除法——先确定"谁先动的手"（五种类型），再看"化验单"（Deauth vs Disassoc 的 reason code），然后检查"急救流程"是否正常执行（自动重连策略），最后排查"体质问题"（省电模式和环境干扰）。四层日志对照法让你从 Framework 到固件逐层穿透，直到找到真正的病因。

但断连只是 WiFi 问题的一个切面——当 STA 变成 AP（热点模式），问题又完全不同了。热点的客户端管理、负载均衡、频段引导……下一章，我们从 SoftApManager 的状态机出发，看看热点的完整生命周期。
