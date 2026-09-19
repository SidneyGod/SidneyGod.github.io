---
title: STA 连接（五）安全协议分支与 WiFi 7 MLO
top: 1
related_posts: true
abbrlink: 9e6b28f1
date: 2026-09-19 20:52:14
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> WPA2-PSK 的正常连接流程（Open Auth + Assoc + 四次握手）在前面的 Auth/Assoc 流程分析中已经详细拆解。但 WiFi 安全远不止这一条路——open 网络没有加密直接连、OWE 在 Assoc 阶段偷偷交换 DH 密钥、SAE 把密钥协商搬到了 Auth 阶段（4 帧 Dragonfly 握手）、EAP-TLS 引入 RADIUS 服务器做三方证书认证、WiFi 7 的 MLO 更是把「一条连接」变成了「多条链路协同」。本篇的角色是：**将前面没走的安全协议分支逐一捋清楚**——每种协议在代码的哪个位置分叉、为什么分、分叉后走了什么完全不同的路径。

> **上篇回顾**：前面在 Framework 状态机追踪中我们跟踪了 `ClientModeImpl` 如何从用户点击一直走到调用 Supplicant AIDL，拆解了 Supplicant 的 `sme_send_authentication()` 如何根据 `key_mgmt` 设置 `params.auth_alg`——这个函数就是本篇所有协议的分叉原点，也深入到 QCOM/MTK 驱动的 Auth/Assoc 状态机和四次握手。本篇回到 `sme_send_authentication()` 的决策枢纽，逐一追踪 open/OWE/SAE/EAP-TLS/MLO 的完整代码路径。

<!--more-->

# 本章导读

**你将学到**：

- 六种认证方式的代码级分叉点：`sme_send_authentication()` 的 `auth_alg` 完整决策树
- Open 网络的三层调用链：`ClientModeImpl`（FWK）→ `wpa_supplicant_set_state()`（Supplicant）→ 驱动无需 EAPOL
- OWE 的 DH 密钥交换在代码中的具体实现：`owe_build_assoc_req()` 和 `owe_process_assoc_resp()`
- SAE 4 帧 Dragonfly 握手的完整代码路径：`sme_auth_build_sae_commit()` → `sae_prepare_commit()` / `sae_prepare_commit_pt()` → `sae_write_commit()` → `sme_auth_build_sae_confirm()` → `sae_write_confirm()`
- SAE H2E vs HnP 两种 PWE 计算模式的代码级差异和选择逻辑
- EAP-TLS 的 EAPOL 四子状态机：`eapol_sm_step()` 如何驱动 SUPP_PAE / KEY_RX / SUPP_BE / EAP Peer 完成证书认证
- WiFi 7 MLO 的多链路建立：`mlo_connect()` 入口 → 逐条链路 Auth/Assoc → 密钥共享机制
- QCOM 驱动层 SAE Auth 帧的特殊处理：驱动不处理 SAE 帧内容，全部转发到 Supplicant 用户空间
- EAP-SIM（RFC 4186）的 Identity → Challenge → Success 完整认证流程：GSM triplet（RAND/SRES/Kc）、密钥派生（MK → K_encr/K_aut/MSK）、RADIUS 协议封装（EAP-Message 属性 + MS-MPPE 密钥下发）
- MTK 驱动 SAE 帧的 `SAA_STATE_EXTERNAL_AUTH` 外部认证流程——与 QCOM 的 `lim_process_sae_auth_frame()` 对比
- MTK 驱动 WiFi 7 MLO 的多链路管理实现：`CFG_SUPPORT_802_11BE_MLO`、`mldSanityCheck()`、`mldSetupMlInfo()`
- 六种认证方式的完整对比表（新加入 EAP-SIM）：Auth 帧数、PMK 协商时机、代码入口、驱动交互模式

**平台覆盖说明**：本章安全协议（SAE Dragonfly、EAPOL 状态机、OWE DH）的核心代码在 wpa_supplicant 通用层，**平台无关**——无论是 QCOM 还是 MTK 驱动，最终都使用同一份 `sae.c`、`eapol_supp_sm.c`、`wpa.c`。驱动层**双平台覆盖**：QCOM 用独立的 `lim_process_sae_auth_frame()` 做 SAE 识别转发，MTK 将 SAE 集成到 SAA FSM 的 `SAA_STATE_EXTERNAL_AUTH` 状态。MLO 方面，QCOM 用 `mlo_connect()` 集中式入口，MTK 通过 `CFG_SUPPORT_802_11BE_MLO` 将 MLO 能力渗透到 AIS/SAA/AAA FSM 和 `mlo.c`（4868 行）中。两个驱动对照呈现，方便对比理解不同厂商的设计哲学；EAP-TLS 的证书体系与 EAP-SIM 的 GSM 密钥认证，则代表两种完全不同的「企业级认证」范式。

**代码说明**：本文所有代码块来自真实源码，有精简（去掉 log 语句、license 头、条件编译分支），关键路径保留完整。精简处标注 `// ...省略...`。文件路径标注在代码块首行。**行号标注说明**：文中的源码行号引用基于分析时的代码版本，随着代码演进可能有 ±10 行的偏移，但函数位置和调用逻辑不受影响。

---

# 1 所有协议的分叉点——`sme_send_authentication()` 是怎么做决策的？

> `sme_send_authentication()` 是所有 802.11 认证方式的代码级分叉点——它根据 `ssid->key_mgmt` 设置 `params.auth_alg`，不同的 `auth_alg` 决定了后续完全不同的代码路径。WPA2-PSK 走 `WPA_AUTH_ALG_OPEN`，SAE 走 `WPA_AUTH_ALG_SAE`，open/OWE/EAP 也都是 `WPA_AUTH_ALG_OPEN`（但后续逻辑完全不同）。

前面我们第一次见到了这个函数，但当时关注的是它如何下发 Auth 帧。现在我们把镜头对准它内部的决策逻辑——这超过 400 行代码（含注释）里的每一个 `if` 分支都是一条不同的协议路径。

## 1.1 auth_alg 决策的完整代码

**块 1：MLO 标记**——在函数开头，如果驱动支持 MLO 且 AP 广播了 Basic ML Element，设置 `params.mld = true`。注意 MLO 标记在所有 `auth_alg` 决策之前完成，意味着它是叠加在任意安全协议之上的能力（SAE + MLO、WPA2 + MLO 都可行）：

```c
// wpa_supplicant/sme.c（源码有部分精简）
static void sme_send_authentication(struct wpa_supplicant *wpa_s,
                                    struct wpa_bss *bss, struct wpa_ssid *ssid,
                                    int start)
{
    struct wpa_driver_auth_params params;
    os_memset(&params, 0, sizeof(params));

    // ==================== MLO 分支 ====================
    if ((wpa_s->drv_flags2 & WPA_DRIVER_FLAGS2_MLO) &&
        !wpa_bss_parse_basic_ml_element(wpa_s, bss, wpa_s->ap_mld_addr,
                                        NULL, ssid, NULL) &&
        bss->valid_links) {
        params.mld = true;
        params.mld_link_id = wpa_s->mlo_assoc_link_id;
        params.ap_mld_addr = wpa_s->ap_mld_addr;
    }
```

**块 2：`auth_alg` 决策链**——默认值是 `WPA_AUTH_ALG_OPEN`，然后依次检查 LEAP（Cisco 私有协议）、用户显式覆盖、SAE、FT。每个分支都在「覆盖」或「保持」`auth_alg`。核心控制流是：先设默认值，再让高优先级分支覆盖：

```c
    // ==================== 默认值：Open Auth ====================
    params.auth_alg = WPA_AUTH_ALG_OPEN;

    // ==================== 802.1X LEAP 覆盖 ====================
#ifdef IEEE8021X_EAPOL
    if (ssid->key_mgmt & WPA_KEY_MGMT_IEEE8021X_NO_WPA) {
        if (ssid->leap) {
            if (ssid->non_leap == 0)
                params.auth_alg = WPA_AUTH_ALG_LEAP;
            else
                params.auth_alg |= WPA_AUTH_ALG_LEAP;
        }
    }
#endif

    // ==================== 用户显式覆盖 ====================
    if (ssid->auth_alg) {
        params.auth_alg = ssid->auth_alg;
    }

    // ==================== SAE 分支 (WPA3-Personal) ====================
#ifdef CONFIG_SAE
    wpa_s->sme.sae_pmksa_caching = 0;
    if (wpa_key_mgmt_sae(ssid->key_mgmt)) {
        const u8 *rsn;
        struct wpa_ie_data ied;
        rsn = wpa_bss_get_rsne(wpa_s, bss, ssid, false);
        if (rsn && wpa_parse_wpa_ie(rsn, 2 + rsn[1], &ied) == 0 &&
            wpa_key_mgmt_sae(ied.key_mgmt)) {
            if (!wpas_is_sae_avoided(wpa_s, ssid, &ied)) {
                params.auth_alg = WPA_AUTH_ALG_SAE;  // ← SAE 分叉
            }
        }
    }
#endif

    // ==================== FT 分支 (快速漫游) ====================
#ifdef CONFIG_IEEE80211R
    if (md && wpa_s->sme.prev_bssid_set && wpa_s->sme.ft_used &&
        os_memcmp(md, wpa_s->sme.mobility_domain, 2) == 0 &&
        wpa_sm_has_ft_keys(wpa_s->wpa, md)) {
        params.auth_alg = WPA_AUTH_ALG_FT;  // ← FT 分叉
    }
#endif
```

**块 3：SAE Commit/Confirm 帧构建**——确定了 `auth_alg == SAE` 之后，`start` 参数决定是构建 Commit 帧（start=1）还是 Confirm 帧（start=0）。这是 SAE 独有的路径——其他协议不需要在 Auth 帧的 payload 中携带自定义数据：

```c
    // ==================== SAE PMKSA 缓存降级 ====================
#ifdef CONFIG_SAE
    if (!skip_auth && params.auth_alg == WPA_AUTH_ALG_SAE &&
        pmksa_cache_set_current(wpa_s->wpa, NULL, bss->bssid, ssid, 0,
                                NULL, wpa_s->key_mgmt, false) == 0) {
        params.auth_alg = WPA_AUTH_ALG_OPEN;  // SAE 降级为 Open
        wpa_s->sme.sae_pmksa_caching = 1;
    }

    // ==================== 构建 SAE 帧数据 ====================
    if (!skip_auth && params.auth_alg == WPA_AUTH_ALG_SAE) {
        if (start)
            resp = sme_auth_build_sae_commit(wpa_s, ssid, bss->bssid,
                                             params.mld ? params.ap_mld_addr : NULL,
                                             0, start == 2, NULL, NULL);
        else
            resp = sme_auth_build_sae_confirm(wpa_s, 0);
        params.auth_data = wpabuf_head(resp);
        params.auth_data_len = wpabuf_len(resp);
        wpa_s->sme.sae.state = start ? SAE_COMMITTED : SAE_CONFIRMED;
    }
#endif
```

**块 4：FILS 分支与下发**——最后检查 FILS（快速初始链路建立），然后调用 `wpa_drv_authenticate()` 将最终的 `auth_alg` 和帧数据下发到驱动：

```c
    // ==================== FILS 分支 ====================
#ifdef CONFIG_FILS
    if (params.auth_alg == WPA_AUTH_ALG_OPEN &&
        wpa_key_mgmt_fils(ssid->key_mgmt)) {
        params.auth_alg = ssid->fils_dh_group ?
            WPA_AUTH_ALG_FILS_SK_PFS : WPA_AUTH_ALG_FILS;
    }
#endif

    // ==================== 下发 Auth 到驱动 ====================
    wpa_s->sme.auth_alg = params.auth_alg;
    wpa_drv_authenticate(wpa_s, &params);
}
```

主要功能：

- **默认值是 `WPA_AUTH_ALG_OPEN`**——WPA2-PSK、open、OWE、EAP-TLS 都从这里出发，Auth 帧本身都是 Open System Authentication（Algorithm Number = 0），区别在于 Auth 帧附带的 IE 和 Auth 完成后的下一步
- **SAE 分支需要双重验证**：不仅检查 `ssid->key_mgmt` 是否包含 SAE，还必须确认 AP 的 Beacon/Probe Response 中 RSNE 广播了 SAE AKM suite selector——否则即使 STA 配置了 WPA3，AP 不支持也只能降级
- **PMKSA 缓存可以让 SAE 降级为 Open**：如果此前连接过同一个 AP 且 PMK 还在缓存有效期内，直接走 Open Auth + 快速四次握手，跳过 4 帧 Dragonfly 开销
- **OWE、open、EAP 的 `auth_alg` 都保持 `WPA_AUTH_ALG_OPEN`**——它们的分叉不在 `sme_send_authentication()` 内部，而在 Auth 完成后的 Association 阶段（OWE 在 Assoc 帧中加 DH IE）或 EAPOL 阶段（EAP 在四次握手前先做证书认证）

## 1.2 六种协议的分叉点总览

下表是从 `sme_send_authentication()` 出发的六种协议的决策一览：

| 协议         | `auth_alg`          | `key_mgmt`               | 分叉位置                                                     | Auth 帧特征                                                  |
| ------------ | ------------------- | ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Open**     | `WPA_AUTH_ALG_OPEN` | `WPA_KEY_MGMT_NONE`      | 走 `wpa_supplicant_set_non_wpa_policy()` 分支（line 770）    | 标准 Open System Auth，无安全 IE                             |
| **OWE**      | `WPA_AUTH_ALG_OPEN` | `WPA_KEY_MGMT_OWE`       | Auth 走默认 OPEN，分叉在 Assoc（`owe_build_assoc_req()` 添加 DH IE） | Open Auth + Assoc 中带 OWE DH Parameter IE                   |
| **WPA2-PSK** | `WPA_AUTH_ALG_OPEN` | `WPA_KEY_MGMT_PSK`       | Auth 走默认 OPEN，分叉在四次握手的 PMK 派生方式（PBKDF2 本地派生） | Open Auth + RSN IE 含 PSK AKM suite                          |
| **SAE**      | `WPA_AUTH_ALG_SAE`  | `WPA_KEY_MGMT_SAE`       | `sme_send_authentication()` line 666：显式设 `params.auth_alg = WPA_AUTH_ALG_SAE` | Auth 帧 Algorithm=3(SAE)，带 Scalar + Element，4 帧 Dragonfly |
| **EAP-TLS**  | `WPA_AUTH_ALG_OPEN` | `WPA_KEY_MGMT_IEEE8021X` | Auth 走默认 OPEN，分叉在 Assoc 后的 EAPOL 阶段——不直接四次握手，先走 EAP 认证 | Open Auth + RSN IE 含 802.1X AKM suite                       |
| **EAP-SIM**  | `WPA_AUTH_ALG_OPEN` | `WPA_KEY_MGMT_IEEE8021X` | Auth 走默认 OPEN，分叉在 Assoc 后的 EAPOL 阶段——走 SIM/Start + SIM/Challenge | Open Auth + RSN IE 含 802.1X AKM suite（与 EAP-TLS 无法从 Auth 帧区分） |

> `WPA_AUTH_ALG_OPEN` 是「默认路径」，六种协议中有五种（open/OWE/WPA2-PSK/EAP-TLS/EAP-SIM）都从这里出发。但 **Auth 帧相同不代表后续路径相同**——open 直接 L2 就绪、OWE 在 Assoc 中做 DH 交换、WPA2-PSK 走四次握手、EAP-TLS/EAP-SIM 先走 EAPOL 认证再四次握手。唯一在 Auth 阶段就改变 `auth_alg` 的是 SAE——这也是因为 SAE 的 Auth 帧格式与 Open Auth 完全不同（Algorithm Number = 3，帧体是 Dragonfly 的 Scalar + Element）。

## 1.3 决策树全景

下图展示了从 `sme_send_authentication()` 出发的完整分叉路径。每个叶节点代表一种认证方式，节点的标注是代码中的具体分叉条件和文件行号。

![安全协议分叉决策树](assets/06e-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%94%EF%BC%89%E5%AE%89%E5%85%A8%E5%8D%8F%E8%AE%AE%E5%88%86%E6%94%AF%E4%B8%8E-WiFi-7-MLO/06e-fork-decision-tree.svg)

---

# 2 Open 网络怎么直连？——跳过四次握手的完整代码路径

> Open 网络（无加密）的 Auth 和 Assoc 与 WPA2-PSK 完全一样（`WPA_AUTH_ALG_OPEN`），但分叉点在 **Assoc 完成后的 `wpa_supplicant_event_assoc()` 函数中**（`events.c:4559`）——当检测到 `key_mgmt == WPA_KEY_MGMT_NONE` 时，直接调用 `wpa_supplicant_set_state(WPA_COMPLETED)`，跳过 `WPA_4WAY_HANDSHAKE` 和 `WPA_GROUP_HANDSHAKE` 两个中间状态。FWK 层的 `SupplicantStateTracker` 收到 `COMPLETED` 状态后直接进入 `mCompletedState`，不触发 EAPOL 相关逻辑。

Open 网络虽然是六种协议中最简单的，但它恰好是最清晰展示「状态机分叉」的案例——同一条 Auth/Assoc 路径，只是因为 `key_mgmt = NONE`，后续的状态跳转就完全不一样了。

## 2.1 三层调用链全景

```
FWK 层：
  SupplicantStateTracker.transitionOnSupplicantStateChange()
    └── COMPLETED → mCompletedState（不经过 FOUR_WAY_HANDSHAKE）

Supplicant 层：
  sme_send_authentication() → auth_alg = WPA_AUTH_ALG_OPEN
    └── wpa_drv_authenticate() → NL80211_CMD_AUTHENTICATE
  sme_event_auth() → sme_associate() → NL80211_CMD_ASSOCIATE
  wpa_supplicant_event_assoc()                         [events.c:4353]
    └── if (key_mgmt == WPA_KEY_MGMT_NONE)              [events.c:4559]
          └── wpa_supplicant_set_state(WPA_COMPLETED)    [events.c:4575]
    └── else → 启动 10 秒 EAPOL 超时（WPA2-PSK/EAP 路径）

驱动层 (QCOM)：
  lim_set_privacy() 设置 rsn_enabled=false, privacy=false  [lim_process_sme_req_messages.c:510]
  → Auth/Assoc 帧与 WPA2-PSK 相同（Open System Auth）
  → 不处理 EAPOL key 帧（因为没有四次握手）
```

## 2.2 Supplicant 层：wpa_supplicant_event_assoc() 中的关键分叉

`wpa_supplicant_event_assoc()` 是 Assoc 完成后的收敛点。它对所有协议的分叉就在这里——`key_mgmt` 的值决定了下一步是直接 COMPLETED 还是进入 EAPOL 阶段：

```c
// wpa_supplicant/events.c（源码有部分精简）
static void wpa_supplicant_event_assoc(struct wpa_supplicant *wpa_s,
                                       union wpa_event_data *data)
{
    // ...省略 Assoc 响应解析和 IE 验证（约 200 行）...

    wpa_supplicant_set_state(wpa_s, WPA_ASSOCIATED);  // line 4459

    // ==================== 分叉点 ====================
    if (wpa_s->key_mgmt == WPA_KEY_MGMT_NONE ||
        wpa_s->key_mgmt == WPA_KEY_MGMT_WPA_NONE ||
        (wpa_s->current_ssid &&
         wpa_s->current_ssid->mode == WPAS_MODE_IBSS)) {
        // Open 网络 / WPA-None / IBSS 模式
        wpa_supplicant_cancel_auth_timeout(wpa_s);
        wpa_supplicant_set_state(wpa_s, WPA_COMPLETED);  // 直接完成！
    } else if (!ft_completed) {
        // WPA2-PSK / SAE / EAP 等需要 EAPOL 的路径
        wpa_supplicant_req_auth_timeout(wpa_s, 10, 0);  // 10 秒 EAPOL 超时
    }
}
```

主要功能：

- **分叉条件在 `events.c:4559`**：`wpa_s->key_mgmt == WPA_KEY_MGMT_NONE`——这是 Open 网络与所有加密网络的唯一代码级分叉点
- **Open 网络直接 `WPA_COMPLETED`**（line 4575）：取消 Auth 超时定时器，直接设置状态为完成——不启动 EAPOL 超时，不等待四次握手
- **加密网络启动 10 秒 EAPOL 超时**（line 4578）：`wpa_supplicant_req_auth_timeout(wpa_s, 10, 0)`——如果 10 秒内没有收到 EAPOL-Key 帧，连接失败

`enum wpa_states` 在 `src/common/defs.h`（line 248）中定义，共 10 个状态：

```
WPA_DISCONNECTED → WPA_INTERFACE_DISABLED → WPA_INACTIVE → WPA_SCANNING
→ WPA_AUTHENTICATING → WPA_ASSOCIATING → WPA_ASSOCIATED
→ WPA_4WAY_HANDSHAKE → WPA_GROUP_HANDSHAKE → WPA_COMPLETED
```

对于 Open 网络，状态在 `WPA_ASSOCIATED` 后直接跳到 `WPA_COMPLETED`，跳过了 `WPA_4WAY_HANDSHAKE` 和 `WPA_GROUP_HANDSHAKE` 两个中间状态。

## 2.3 FWK 层：SupplicantStateTracker 的处理

在 Framework 层，`SupplicantStateTracker`（`SupplicantStateTracker.java`）接收 supplicant 状态变更广播：

```java
// SupplicantStateTracker.java（源码有部分精简）
private void transitionOnSupplicantStateChange(StateChangeResult stateChangeResult) {
    SupplicantState state = stateChangeResult.state;
    // ...
    if (state == SupplicantState.FOUR_WAY_HANDSHAKE) {
        transitionTo(mHandshakeState);   // WPA2-PSK/SAE/EAP 路径
    } else if (state == SupplicantState.COMPLETED) {
        transitionTo(mCompletedState);   // Open 网络直接到这里
    }
}
```

主要功能：

- **Open 网络从未进入 `FOUR_WAY_HANDSHAKE` 状态**：Supplicant 直接报告 `COMPLETED`，所以 `SupplicantStateTracker` 直接进入 `mCompletedState`
- **`ClientModeImpl` 跟着状态机走**：`L2ConnectedState` 不感知 EAPOL——它只看到 supplicant 报告了 `COMPLETED`

## 2.4 驱动层：lim_set_privacy()——关闭 RSN 和加密

在 QCOM 驱动层，连接请求下发给 SME 后，SME 调用 `lim_set_privacy()` 决定是否启用 RSN 和加密：

```c
// QCOM qcacld-3.0/core/mac/src/pe/lim/lim_process_sme_req_messages.c（源码有部分精简）
void lim_set_privacy(struct mac_context *mac_ctx, ...)
{
    mac_ctx->mlme_cfg->wep_params.auth_type = eSIR_OPEN_SYSTEM;  // 默认 Open Auth

    if (cipher == WEP) {
        privacy = true;
        rsn_enabled = false;     // WEP 不使用 RSN
    } else if (cipher == TKIP || cipher == AES || ...) {
        privacy = ap_privacy;
        rsn_enabled = true;      // WPA/WPA2/WPA3 启用 RSN
    } else {
        // Open 网络：无加密
        rsn_enabled = false;     // 不启用 RSN
        privacy = false;         // 不启用加密
    }
    mac_ctx->mlme_cfg->feature_flags.enable_rsn = rsn_enabled;
}
```

主要功能：

- **`rsn_enabled = false`**：关闭固件的 RSN 处理——没有四次握手，没有密钥安装
- **`privacy = false`**：数据帧不使用加密——802.11 帧头的 Protected Frame 位为 0
- **`auth_type = eSIR_OPEN_SYSTEM`**：Auth 帧 Algorithm Number = 0（Open System）

> 回到酒店比喻——Open 网络就像大厅根本没有门禁系统。你走进大厅（Auth）、在前台签个字（Assoc），系统就显示「已入住」（`WPA_COMPLETED`）。没有四次握手的「房卡核对」环节，因为根本没有房卡。

---

# 3 OWE 怎么在开放网络中加密？——Assoc 阶段的 DH 密钥交换

> OWE 的 Auth 与 Open 网络完全一样（`WPA_AUTH_ALG_OPEN`），但 **Assoc 帧中多了一个 OWE DH Parameter IE**——STA 和 AP 在 Assoc Req/Resp 中交换 DH 公钥，从共享密钥派生 PMK，然后走标准四次握手完成密钥安装。整个过程对用户完全透明（不需要输入密码），但数据面是加密的。

## 3.1 OWE 的分叉点：不在 Auth，在 Assoc

OWE 在 `sme_send_authentication()` 中没有特殊处理——`auth_alg` 保持默认的 `WPA_AUTH_ALG_OPEN`。它的分叉点在 **Association 阶段**——`owe_build_assoc_req()` 在构造 Assoc Request 时插入 OWE DH Parameter IE。

```
WPA2-PSK：Auth(Open, 2 帧) → Assoc(2 帧) → 四次握手(4 帧) → PMK=PBKDF2(PSK)
OWE：    Auth(Open, 2 帧) → Assoc(含 DH IE, 2 帧) → 四次握手(4 帧) → PMK=DH(shared_secret)
                           ────────────────
                           唯一差异：Assoc 帧多了 DH 参数
```

## 3.2 Supplicant 层：owe_build_assoc_req()——构建带 DH 公钥的 Assoc Request

```c
// src/rsn_supp/wpa.c（源码有部分精简）
struct wpabuf * owe_build_assoc_req(struct wpa_sm *sm, u16 group)
{
    struct wpabuf *ie = NULL, *pub = NULL;
    size_t prime_len;

    // 根据 DH group 确定素数域长度
    if (group == 19)      prime_len = 32;   // 256-bit ECC
    else if (group == 20) prime_len = 48;   // 384-bit ECC
    else if (group == 21) prime_len = 66;   // 521-bit ECC
    else return NULL;

    crypto_ecdh_deinit(sm->owe_ecdh);        // 1. 清理旧 ECDH 上下文
    sm->owe_ecdh = crypto_ecdh_init(group);   // 2. 初始化新 ECDH（生成 STA 私钥）
    if (!sm->owe_ecdh) goto fail;
    sm->owe_group = group;
    pub = crypto_ecdh_get_pubkey(sm->owe_ecdh, 0);  // 3. 导出公钥
    pub = wpabuf_zeropad(pub, prime_len);           // 4. 补零到 prime_len
    if (!pub) goto fail;

    ie = wpabuf_alloc(5 + wpabuf_len(pub));         // 5. 分配 IE 空间
    wpabuf_put_u8(ie, WLAN_EID_EXTENSION);
    wpabuf_put_u8(ie, 1 + 2 + wpabuf_len(pub));
    wpabuf_put_u8(ie, WLAN_EID_EXT_OWE_DH_PARAM);   // IE 类型：OWE DH Parameter
    wpabuf_put_le16(ie, group);                     // DH Group ID
    wpabuf_put_buf(ie, pub);                        // DH Public Key
    wpabuf_free(pub);
    return ie;
fail:
    wpabuf_free(pub);
    crypto_ecdh_deinit(sm->owe_ecdh);
    sm->owe_ecdh = NULL;
    return NULL;
}
```

主要功能：

- **每次构建都重新生成密钥对**：`crypto_ecdh_deinit()` 清理旧上下文 → `crypto_ecdh_init()` 生成新私钥 → `crypto_ecdh_get_pubkey()` 导出公钥——确保每次连接使用的 DH 密钥对都是新的（前向安全性）
- **Group 自适应**：根据 ECC group 选择不同的密钥长度——group 19（P-256）用 32 字节、group 20（P-384）用 48 字节、group 21（P-521）用 66 字节
- **公钥需要补零**：`wpabuf_zeropad()` 将公钥补齐到 prime_len——这是 IEEE 802.11 规范要求的固定长度编码，不足部分用前导零填充
- **IE 格式**：`WLAN_EID_EXTENSION`（255）→ Length → `WLAN_EID_EXT_OWE_DH_PARAM`（32）→ Group ID（2 字节 LE）→ Public Key

## 3.3 Supplicant 层：owe_process_assoc_resp()——从 AP 公钥推导 PMK

AP 收到 STA 的 OWE DH Parameter 后，在 Assoc Response 中也返回自己的 DH 公钥。`owe_process_assoc_resp()` 处理这个响应：

```c
// src/rsn_supp/wpa.c（源码有部分精简）
int owe_process_assoc_resp(struct wpa_sm *sm, const u8 *bssid,
                           const u8 *resp_ies, size_t resp_ies_len)
{
    struct ieee802_11_elems elems;
    u16 group;
    struct wpabuf *secret, *pub, *hkey;
    u8 prk[SHA512_MAC_LEN], pmkid[SHA512_MAC_LEN];

    // 1. 解析 Assoc Resp IEs
    if (ieee802_11_parse_elems(resp_ies, resp_ies_len, &elems, 1) == ParseFailed)
        return -1;

    // 2. PMKSA 缓存命中 → 直接复用 PMK，跳过 DH 计算
    if (sm->cur_pmksa && elems.rsn_ie && /* PMKID 匹配 */) {
        wpa_sm_set_pmk_from_pmksa(sm);
        return 0;
    }

    // 3. 验证 DH group 一致性
    group = WPA_GET_LE16(elems.owe_dh);
    if (group != sm->owe_group) return -1;

    // 4. 计算 DH 共享密钥：secret = DH(STA_priv, AP_pub)
    secret = crypto_ecdh_set_peerkey(sm->owe_ecdh, 0,
                elems.owe_dh + 2, elems.owe_dh_len - 2);
    secret = wpabuf_zeropad(secret, prime_len);

    // 5. PRK = HKDF-extract(C || A || group, DH-secret)
    //    C = STA 公钥, A = AP 公钥
    hkey = wpabuf_alloc(wpabuf_len(pub) + elems.owe_dh_len - 2 + 2);
    wpabuf_put_buf(hkey, pub);              // C（STA 公钥）
    wpabuf_put_data(hkey, elems.owe_dh + 2,
                    elems.owe_dh_len - 2);   // A（AP 公钥）
    wpabuf_put_le16(hkey, sm->owe_group);   // group
    hmac_sha256(wpabuf_head(hkey), wpabuf_len(hkey),
                wpabuf_head(secret), wpabuf_len(secret), prk);

    // 6. PMK = HKDF-expand(PRK, "OWE Key Generation", PMK_len)
    hmac_sha256_kdf(prk, hash_len, NULL, "OWE Key Generation",
                    os_strlen("OWE Key Generation"), sm->pmk, hash_len);
    sm->pmk_len = hash_len;

    // 7. 保存 PMKSA 缓存
    pmksa_cache_add(sm->pmksa, sm->pmk, sm->pmk_len, pmkid, NULL, 0,
                    bssid, sm->own_addr, sm->network_ctx, sm->key_mgmt, NULL);
    return 0;
}
```

主要功能：

- **两层密钥派生**：`HKDF-extract(C || A || group, DH-secret)` 提取 PRK（伪随机密钥），然后 `HKDF-expand(PRK, "OWE Key Generation", n)` 派生 PMK——这个结构与 TLS 1.3 的密钥派生一致，是 RFC 8110 定义的标准方式
- **DH 共享密钥的输入材料**：`C || A || group`（STA 公钥 || AP 公钥 || DH Group ID）—确保即使存在中间人攻击，PMK 也会不同（因为 AP 公钥改变了）
- **PMKID 用于缓存**：`Truncate-128(Hash(C || A))` 作为 PMKID——同一 STA 重新连接同一 AP 时，可以直接用缓存的 PMK 跳过 DH 交换
- **Group 自适应哈希算法**：group 19 用 SHA256，group 20 用 SHA384，group 21 用 SHA512

## 3.4 FWK 层：OWE 对用户透明

在 Framework 层，OWE 网络的 `WifiConfiguration` 设置如下：

```java
// WifiConfiguration 中的 OWE 配置
config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.OWE);  // key_mgmt = OWE
// 不需要设置 PSK、EAP 等字段——OWE 是无密码的
```

对应到 Supplicant 侧，`ssid->key_mgmt` 包含 `WPA_KEY_MGMT_OWE`。在 `sme_send_authentication()` 中，`wpa_key_mgmt_sae()` 返回 false（OWE 不是 SAE），`wpa_key_mgmt_fils()` 返回 false，`wpa_key_mgmt_ft()` 返回 false——所以 `auth_alg` 保持 `WPA_AUTH_ALG_OPEN`，所有 OWE 独有的逻辑都在 Assoc 和四次握手阶段。

OWE 在 Framework 层的连接流程与 WPA2-PSK **完全相同**——`ClientModeImpl.connectToNetwork()` → `SupplicantStaIfaceHal.connectToNetwork()` 直接适用于 OWE。唯一的区别在 `WifiConfiguration` 构造时：`allowedKeyManagement.set(KeyMgmt.OWE)` 代替 `WPA_PSK`，且不需要设置 `preSharedKey`。SupplicantStateTracker 中 OWE 的状态序列仍然是 `ASSOCIATING → ASSOCIATED → FOUR_WAY_HANDSHAKE → COMPLETED`——与 WPA2 完全相同，因为 OWE 在 DH 交换后仍然需要四次握手来安装 PTK/GTK。

FWK 层完全感知不到 OWE 与 WPA2-PSK 的差异——加密方式是 DH 还是 PBKDF2，对 Framework 状态机是透明的。

## 3.5 OWE 的安全边界

> OWE 提供了「无认证的加密」——攻击者可以建立中间人（因为 Auth 是 Open，没有身份验证），但无法被动监听。这就是 RFC 8110 的 Opportunistic Encryption 场景——「宁可没有身份验证的加密，也不能完全没有加密」。回到酒店比喻——OWE 就像大堂谁都能进，但坐下以后你说的每句话都是悄悄话，走廊上的窃听者只能看到你在说话，但听不到内容。

## 3.6 驱动层：OWE 对驱动的透明性

与 SAE 不同，OWE 对驱动是**完全透明**的——驱动不需要任何特殊处理。原因在于 OWE 的差异全部在 Assoc 帧的 IE 中（多了 OWE DH Parameter IE），而 Auth/Assoc 帧的发送和接收流程与 WPA2-PSK 完全相同：

- 驱动层的 `auth_type` 仍然是 `eSIR_OPEN_SYSTEM`（与 Open / WPA2-PSK 相同，值为 0），因为 Auth 帧本身就是标准的 Open System Authentication
- `lim_set_privacy()` 中 `rsn_enabled = true`——与 WPA2-PSK 完全一致，因为 OWE 仍然需要 RSN IE 和四次握手
- DH 密钥交换（`crypto_ecdh_init`、`crypto_ecdh_get_pubkey`、`crypto_ecdh_set_peerkey`）全部在 wpa_supplicant 用户空间的 `wpa.c` 中完成——驱动看到的只是「Assoc 帧中有一个 Vendor Specific IE」，不做解析
- OWE 的四次握手与 WPA2-PSK 完全相同——驱动收到 EAPOL-Key 帧后，通过 `cfg80211_rx_mgmt()` 上报给 supplicant，驱动不参与 PMK 的派生或 DH 共享密钥的计算

简言之，如果你从驱动层的视角看一次 OWE 连接，它与一次 WPA2-PSK 连接无法区分——所有差异仅在 supplicant 的用户空间代码中。

以下是 `lim_set_privacy()` 中 cipher 判断的关键路径（§2.4 已展示完整函数），说明 OWE 走与 WPA2-PSK 完全相同的 RSN 启用路径：

```c
// QCOM qcacld-3.0/core/mac/src/pe/lim/lim_process_sme_req_messages.c（源码有部分精简）
// OWE 的 cipher = AES → 走与 WPA2-PSK 完全相同的 rsn_enabled=true 分支
// 驱动不区分 DH 协商的 PMK 和 PBKDF2 派生的 PMK——两者在驱动层完全等价
if (cipher == TKIP || cipher == AES || ...) {
    privacy = ap_privacy;
    rsn_enabled = true;      // OWE 和 WPA2-PSK 走完全相同的路径
}
```

---

# 4 SAE 怎么在 Auth 阶段就完成认证？——4 帧 Dragonfly 握手的完整代码追踪

> SAE（WPA3-Personal）是唯一在 Auth 阶段就改变 `auth_alg` 的协议——`sme_send_authentication()` 将 `params.auth_alg` 设为 `WPA_AUTH_ALG_SAE`（line 666），然后调用 `sme_auth_build_sae_commit()` 构建 Commit 帧、`sme_auth_build_sae_confirm()` 构建 Confirm 帧，完成 4 帧 Dragonfly 握手。PMK 在 Auth 阶段在线协商，四次握手的角色退化为「用已协商的 PMK 派生 PTK 和分发 GTK」。

## 4.1 SAE 与 WPA2-PSK 的核心对比

| 维度                  | WPA2-PSK                     | SAE (WPA3-Personal)                                          |
| --------------------- | ---------------------------- | ------------------------------------------------------------ |
| **Auth 帧数**         | 2（Open）                    | 4（Dragonfly：Commit + Confirm）                             |
| **PMK 来源**          | PBKDF2(PSK, SSID) 本地派生   | Auth 阶段 ECC 在线协商                                       |
| **`auth_alg`**        | `WPA_AUTH_ALG_OPEN`（0）     | `WPA_AUTH_ALG_SAE`（3）                                      |
| **Auth 帧 Algorithm** | 0（Open System）             | 3（SAE）                                                     |
| **驱动处理**          | 驱动内部处理 2 帧交换        | 驱动识别 SAE → 转发给 wpa_supplicant                         |
| **密码破解**          | 离线字典攻击（抓四次握手包） | 不可离线破解（每次尝试需在线交互）                           |
| **PWE 计算**          | 不涉及                       | H2E（Hash-to-Element，WPA3 标准）或 HnP（Hunting-and-Pecking，旧版） |

## 4.2 SAE 在驱动层的特殊处理——为什么 SAE 帧不能由驱动自己处理

这是理解 SAE 在代码层面与 WPA2 差异的关键。在 QCOM 驱动中，Auth 帧的处理有明确分叉：

```c
// QCOM qcacld-3.0/core/mac/inc/ani_system_defs.h（源码）
typedef enum eAniAuthType {
    eSIR_OPEN_SYSTEM    = 0,  // 驱动内部处理，2 帧交换
    eSIR_SHARED_KEY     = 1,
    eSIR_FT_AUTH        = 2,
    eSIR_AUTH_TYPE_SAE  = 3,  // SAE：驱动不处理，转发给 wpa_supplicant
    // ...省略...
} tAniAuthType;
```

当 `lim_process_auth_frame()`（`lim_process_auth_frame.c:2024`）检测到 `auth_alg == eSIR_AUTH_TYPE_SAE` 时，调用 `lim_process_sae_auth_frame()`（定义于 line 674）：

```c
// QCOM qcacld-3.0/core/mac/src/pe/lim/lim_process_auth_frame.c（源码有部分精简）
// line 2024-2030：lim_process_auth_frame() 中的 SAE 分发
} else if (auth_alg == eSIR_AUTH_TYPE_SAE) {
    if (LIM_IS_STA_ROLE(pe_session) ||
        (LIM_IS_AP_ROLE(pe_session) &&
         mac_ctx->mlme_cfg->sap_cfg.sap_sae_enabled))
        lim_process_sae_auth_frame(mac_ctx, rx_pkt_info,
                                   pe_session);
    goto free;
}

// line 674：SAE 帧的实际处理函数
static void lim_process_sae_auth_frame(struct mac_context *mac_ctx,
                                       uint8_t *rx_pkt_info,
                                       struct pe_session *pe_session)
{
    tpSirMacMgmtHdr mac_hdr;
    // ...省略...

    mac_hdr = WMA_GET_RX_MAC_HEADER(rx_pkt_info);
    body_ptr = WMA_GET_RX_MPDU_DATA(rx_pkt_info);
    frame_len = WMA_GET_RX_PAYLOAD_LEN(rx_pkt_info);

    // SAE 帧 → 通过 lim_send_sme_mgmt_frame_ind() 转发给 wpa_supplicant
    // 因为 Dragonfly 握手需要椭圆曲线运算（PWE 推导、Commit/Confirm 计算）
    // 这些密码学操作在驱动层做不了——必须交给用户空间的 wpa_supplicant
    lim_send_sme_mgmt_frame_ind(mac_ctx, ...);
}
```

> **注意**：源码中还有一个 `lim_process_sae_preauth_frame()`（定义于 line 2142），它是一个独立的静态函数，专用于**漫游预认证场景**——收到无 session 的 SAE Auth 帧时（LFR3 offload），直接转发给 wpa_supplicant。它不是 `lim_process_auth_frame()` 调用的主 SAE 路径，两者不要混淆。

主要功能：

- **驱动不处理 SAE 帧的密码学内容**：Dragonfly 握手涉及 ECC 点运算、PWE 推导、HMAC 验证——这些操作在固件/驱动中无法完成（QCOM 固件没有完整的椭圆曲线库）
- **SAE 帧的完整处理在 wpa_supplicant 用户空间**：驱动只负责将 Auth 帧通过 `lim_send_sme_mgmt_frame_ind()` 转发给 wpa_supplicant，wpa_supplicant 的 `sae.c` 完成所有密码学运算后，通过 `wpa_drv_authenticate()` 下发下一帧
- **这就是为什么 SAE 必须走「CMD_AUTHENTICATE + CMD_ASSOCIATE」两步——驱动不知道 SAE 帧的内容，必须由 wpa_supplicant 亲自控制每一帧的发送和响应处理**

## 4.3 sme_auth_build_sae_commit()——构建 Dragonfly 第一帧

```c
// wpa_supplicant/sme.c（源码有部分精简）
static struct wpabuf * sme_auth_build_sae_commit(struct wpa_supplicant *wpa_s,
                         struct wpa_ssid *ssid, const u8 *bssid,
                         const u8 *mld_addr, int external,
                         int reuse, int *ret_use_pt, bool *ret_use_pk)
{
    struct wpabuf *buf;
    char *password = NULL;
    int use_pt = 0;
    bool use_pk = false;
    // 定义行省略：const u8 *addr = mld_addr ? mld_addr : bssid;

    // 1. 获取密码（三级优先级）
    if (ssid->sae_password) {
        password = os_strdup(ssid->sae_password);        // 最高优先级：SAE 专用密码
    }
    if (!password && ssid->passphrase) {
        password = os_strdup(ssid->passphrase);          // 第二优先级：普通 WPA 密码
    }
    if (!password && ssid->ext_psk) {
        // 第三优先级：外部存储密码（如 SIM 卡）
        struct wpabuf *pw = ext_password_get(wpa_s->ext_pw, ssid->ext_psk);
        password = os_malloc(wpabuf_len(pw) + 1);
        os_memcpy(password, wpabuf_head(pw), wpabuf_len(pw));
    }

    // 2. PWE 复用优化（同一 BSSID 重连时跳过 ~100ms 的 PWE 计算）
    if (reuse && wpa_s->sme.sae.tmp &&
        ether_addr_equal(addr, wpa_s->sme.sae.tmp->bssid)) {
        use_pt = wpa_s->sme.sae.h2e;
        use_pk = wpa_s->sme.sae.pk;
        goto reuse_data;  // ← 跳过 PWE 计算，直接复用上次结果
    }

    // 3. 模式选择：H2E vs HnP
    //    6GHz 频段强制 H2E
    //    sae_password_id 存在 → H2E
    //    SAE EXT KEY → H2E
    //    SAE-PK 可用 → H2E
    if (bss && is_6ghz_freq(bss->freq))
        use_pt = 1;

    // 4. 计算 PWE 并生成 Commit
    if (use_pt)
        sae_prepare_commit_pt(&wpa_s->sme.sae, ssid->pt,
                              wpa_s->own_addr, addr, NULL, NULL);  // H2E 模式
    else
        sae_prepare_commit(wpa_s->own_addr, addr,
                           (u8 *) password, os_strlen(password),
                           &wpa_s->sme.sae);                        // HnP 模式

    // 5. 序列化到 Authentication 帧 payload
reuse_data:
    buf = wpabuf_alloc(4 + SAE_COMMIT_MAX_LEN + len);
    wpabuf_put_le16(buf, 1); /* Transaction seq# = 1 */
    if (use_pk)
        wpabuf_put_le16(buf, WLAN_STATUS_SAE_PK);
    else if (use_pt)
        wpabuf_put_le16(buf, WLAN_STATUS_SAE_HASH_TO_ELEMENT);
    else
        wpabuf_put_le16(buf, WLAN_STATUS_SUCCESS);
    sae_write_commit(&wpa_s->sme.sae, buf, wpa_s->sme.sae_token,
                     ssid->sae_password_id);
    return buf;
}
```

主要功能：

- **密码优先级链**：`sae_password` > `passphrase` > `ext_psk`——SAE 支持独立的 SAE 密码（`sae_password`），可以与 WPA2 的 `passphrase` 不同，方便从 WPA2 过渡到 WPA3
- **PWE 复用**：同一 BSSID 短时间重连时，跳过 PWE 计算（椭圆曲线点运算 ~100ms）。这个优化在 roam 场景下非常关键——如果每次漫游都重新计算 PWE，切换延迟会增加 100ms
- **6GHz 强制 H2E**：WiFi 6E/7 的 6GHz 频段禁止使用 HnP（Hunting-and-Pecking）——HnP 的尝试次数不确定，可能泄露时序信息。H2E 是确定性的，没有时序侧信道
- **`sae_write_commit()`** 将 Scalar（椭圆曲线上的大整数）和 Element（椭圆曲线点的 x,y 坐标）序列化到 Auth 帧的 payload 中

## 4.4 sae_prepare_commit() vs sae_prepare_commit_pt()——HnP vs H2E

两种 PWE 计算模式的本质区别：

```c
// src/common/sae.c（源码有部分精简）

// HnP（Hunting-and-Pecking）——旧模式
int sae_prepare_commit(const u8 *addr1, const u8 *addr2,
                       const u8 *password, size_t password_len,
                       struct sae_data *sae)
{
    // ECC 群：反复尝试随机种子，直到找到一个在椭圆曲线上的点
    if (sae->tmp->ec && sae_derive_pwe_ecc(sae, addr1, addr2, password,
                                            password_len) < 0)
        return -1;
    // FFC 群：类似 NIST 素数群下的尝试
    if (sae->tmp->dh && sae_derive_pwe_ffc(sae, addr1, addr2, password,
                                            password_len) < 0)
        return -1;
    sae->h2e = 0;
    sae->pk = 0;
    return sae_derive_commit(sae);  // 从 PWE 生成 Scalar + Element
}

// H2E（Hash-to-Element）——WPA3 标准模式
int sae_prepare_commit_pt(struct sae_data *sae, const struct sae_pt *pt,
                          const u8 *addr1, const u8 *addr2,
                          int *rejected_groups, const struct sae_pk *pk)
{
    // 从预计算的 PT（Password Token）链表找到匹配 sae->group 的 PT
    // PT = 预先计算好的 PWE——一次性计算，连接时直接取用
    if (sae->tmp->ec)
        sae_derive_pwe_from_pt_ecc(sae, pt, addr1, addr2, ...);
    else
        sae_derive_pwe_from_pt_ffc(sae, pt, addr1, addr2, ...);
    sae->h2e = 1;
    return sae_derive_commit(sae);
}

```

主要功能：

- **HnP 是「试出来的」**：`sae_derive_pwe_ecc()` 循环尝试不同的随机种子 `counter++`，直到找到一个在曲线上的点——尝试次数不确定（通常 40-100 次），耗时约 100ms，且时序可能泄露部分信息
- **H2E 是「算出来的」**：`sae_prepare_commit_pt()` 直接从预计算的 PT（Password Token）中查表得到 PWE——确定性算法，没有重试，耗时固定且更短
- **PT 的预计算**：在 `sme_send_authentication()` 的早期阶段，`wpa_s_setup_sae_pt()` 会预先计算所有可能 DH group 的 PT（因为不知道 AP 会选择哪个 group），以内存换时间
- **群运算次数的差异**：`sae_derive_pwe_ecc()` 每轮尝试都是一次椭圆曲线标量乘法，40-100 次循环才命中，故约 100ms；`sae_derive_pwe_from_pt_ecc()` 只做一次哈希到曲线的确定性映射，单次点运算即得 PWE

**H2E vs HnP 核心差异对比**：

| 维度             | HnP (Hunting-and-Pecking)                       | H2E (Hash-to-Element)                                      |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| **PWE 计算方式** | 循环尝试随机种子，直到找到曲线上的点            | 确定性哈希映射，一次计算得到 PWE                           |
| **尝试次数**     | 不确定（通常 40-100 次）                        | 固定（1 次）                                               |
| **耗时**         | ~100ms（不稳定）                                | 固定且更短                                                 |
| **时序侧信道**   | 有风险（尝试次数可泄露信息）                    | 无（确定性算法）                                           |
| **6GHz 强制**    | 禁止                                            | 强制使用                                                   |
| **PT 预计算**    | 不涉及                                          | `wpa_s_setup_sae_pt()` 预计算所有 DH group                 |
| **源码入口**     | `sae_prepare_commit()` → `sae_derive_pwe_ecc()` | `sae_prepare_commit_pt()` → `sae_derive_pwe_from_pt_ecc()` |
| **适用场景**     | 旧版 WPA3 设备、非 6GHz 频段                    | WPA3 标准、6GHz、SAE-PK                                    |

## 4.5 sme_auth_build_sae_confirm()——构建 Dragonfly 第三帧

与 Commit 帧需要传输大块 ECC 数据（Scalar + Element）不同，Confirm 帧只需要一个 HMAC：

```c
// wpa_supplicant/sme.c（源码有部分精简）
static struct wpabuf * sme_auth_build_sae_confirm(struct wpa_supplicant *wpa_s,
                                                  int external)
{
    struct wpabuf *buf;
    buf = wpabuf_alloc(4 + SAE_CONFIRM_MAX_LEN);
    if (buf == NULL) return NULL;

    wpabuf_put_le16(buf, 2); /* Transaction seq# = 2 */
    wpabuf_put_le16(buf, WLAN_STATUS_SUCCESS);
    sae_write_confirm(&wpa_s->sme.sae, buf);  // 序列化 HMAC

    return buf;
}
```

`sae_write_confirm()`（`src/common/sae.c:2353`）的核心逻辑：

```c
// src/common/sae.c（源码有部分精简）
int sae_write_confirm(struct sae_data *sae, struct wpabuf *buf)
{
    const u8 *sc;
    size_t hash_len = sae->tmp->kck_len;

    // Send-Confirm 计数器递增
    if (sae->send_confirm < 0xffff)
        sae->send_confirm++;
    sc = wpabuf_put(buf, 0);
    wpabuf_put_le16(buf, sae->send_confirm);

    // Confirm = HMAC(KCK, Send-Confirm || own_commit_scalar || own_commit_element
    //                         || peer_commit_scalar || peer_commit_element)
    if (sae->tmp->ec)
        sae_cn_confirm_ecc(sae, sc, ...);
    else
        sae_cn_confirm_ffc(sae, sc, ...);
    return 0;
}
```

主要功能：

- **KCK 的来源**：SAE Commit 交换完成后，双方各自计算 `K = scalar_peer * Element_self + scalar_self * Element_peer`，然后从 K 派生 PMK 和 KCK——**KCK 在 Auth 阶段就已经协商好了**
- **Confirm 的验证作用**：Confirm = HMAC(KCK, 双方 Commit 数据)——任何一方修改了 Commit 帧都会导致 HMAC 不匹配，从而被对方拒绝
- **Send-Confirm 计数器**：防止重放攻击——每次发送 Confirm 时递增

## 4.6 SAE 完整调用链

下图展示了 SAE Dragonfly 握手从 Commit 到 Confirm 的 4 帧完整序列，以及后续的 Assoc + 四次握手。

![SAE Dragonfly 4 帧握手时序](assets/06e-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%94%EF%BC%89%E5%AE%89%E5%85%A8%E5%8D%8F%E8%AE%AE%E5%88%86%E6%94%AF%E4%B8%8E-WiFi-7-MLO/06e-sae-dragonfly.svg)

```
FWK 层：
  SupplicantStaIfaceHal.connectToNetwork()
    └── ISupplicantStaNetwork.select()  ← AIDL 跨进程调用
          └── wpa_supplicant_select_network()
                └── wpas_start_assoc_cb()  ← 作为 radio work 回调

Supplicant 层（SAE 路径）：
  sme_send_authentication()                  [sme.c:551]
    ├── params.auth_alg = WPA_AUTH_ALG_SAE   [sme.c:666]
    ├── sme_auth_build_sae_commit()           [sme.c:90]
    │     ├── sae_prepare_commit()             [sae.c:1347]  (HnP)
    │     │   └── sae_derive_commit()
    │     ├── sae_prepare_commit_pt()          [sae.c:1364]  (H2E)
    │     │   └── sae_derive_commit()
    │     └── sae_write_commit()               [sae.c:1673]
    └── wpa_drv_authenticate()  → NL80211_CMD_AUTHENTICATE

  [AP 回复 SAE Commit 后]
  sme_event_auth() → sme_sae_auth() → sme_send_authentication(start=0)
    └── sme_auth_build_sae_confirm() [sme.c:304]
          └── sae_write_confirm()                 [sae.c:2353]
  [AP 回复 SAE Confirm 后]
  sme_event_auth() → sme_sae_auth() → sme_associate() → NL80211_CMD_ASSOCIATE
  wpa_supplicant_event_assoc() → 四次握手（PMK 已通过 SAE 协商）

驱动层（QCOM）：
  lim_process_auth_frame()                   [lim_process_auth_frame.c:1726]
    ├── auth_alg == eSIR_OPEN_SYSTEM → 驱动内部 2 帧交换
    └── auth_alg == eSIR_AUTH_TYPE_SAE    [line 2024]
          └── lim_process_sae_auth_frame()  [line 674]
                └── lim_send_sme_mgmt_frame_ind() → 转发给 wpa_supplicant
```

> 回到酒店比喻——SAE 就像加密对讲机。你不直接说出密码（PSK 明文），而是和前台通过数学方法确认彼此都知道同一个秘密（Dragonfly 握手）。即使攻击者全程监听，也无法猜出密码——因为每次握手的 PWE 都不同，且必须在线交互。这一点与 WPA2-PSK 形成了鲜明对比：在 WPA2 中，攻击者只需抓一次四次握手包，就可以离线暴力破解密码；在 SAE 中，每次密码尝试都需要一次真实的网络交互，破解成本从「一台电脑跑几天」变成了「对着网络发几亿次请求」。
>
> SAE 不是「更慢的 WPA2」。虽然 SAE 多了 2 帧 Auth 交换（4 帧 vs 2 帧），但 SAE 的总体帧数（4 Auth + 4 HS = 8 帧）与 WPA2（2 Auth + 4 HS = 6 帧）相差不大。SAE 多花的时间换来的是「攻击者无法离线破解」的安全性——因为 PWE 的计算需要双方的 MAC 地址，攻击者必须每次在线尝试，每次尝试都意味着一次真实的网络交互。

**异常路径速览**：SAE 的 happy-path 已在上面完整覆盖。当握手失败时，以下是关键的出错处理入口：

- **Commit 帧验证失败**：AP 回复 SAE Commit 帧后，`sae_check_confirm()`（`sae.c:2394`）验证 AP 的 Confirm 是否匹配——HMAC 不匹配意味着 Commit 阶段的 PWE 计算不一致（密码错误或 ECC group 不匹配），STA 重新执行 `sme_auth_build_sae_commit()` 发起新一轮尝试
- **PWE 计算超时**：`sae_derive_pwe_ecc()`（`sae.c:283`）的 HnP 循环如果超过 100 次迭代仍未找到有效 PWE，返回 -1，上层 `sae_prepare_commit()` 报告失败
- **SAE Anti-Clogging Token**：AP 在 Commit 阶段可能返回 Status Code = 76（Anti-Clogging Token Required）——token 由 AP 在 SAE Reject 帧的 Anti-Clogging Token 字段下发；`sme_auth_build_sae_commit()`（`sme.c:90`）的 `start == 2` 参数表示「用 Token 重试 Commit」，STA 重试时经 `sae_write_commit()` 的 token 参数把它序列化进 Commit 帧

> QCOM 驱动对 SAE 帧的处理至此完整覆盖。换到 MTK 驱动视角——你会发现，虽然函数名和架构形式不同（独立的处理函数 vs 集成的 FSM 状态），但核心理念惊人地一致：**驱动不碰 SAE 帧的密码学内容**，全部转发给用户空间的 wpa_supplicant。这本质上是 Dragonfly 握手的 ECC 运算需要完整椭圆曲线库——驱动固件的计算资源和安全审计能力都不足以承载。

## 4.7 MTK 驱动层 SAE 帧处理——SAA_STATE_EXTERNAL_AUTH

> MTK 驱动与 QCOM 的核心共识一致——SAE 帧的密码学运算由 wpa_supplicant 用户空间完成，驱动只负责帧的识别和转发。但实现机制不同：QCOM 用独立的 `lim_process_sae_auth_frame()` 函数做帧识别转发，MTK 将 SAE 深度集成到 SAA FSM 状态机中——检测到 `AUTH_ALGORITHM_NUM_SAE` 后直接进入 `SAA_STATE_EXTERNAL_AUTH` 状态，通过 `kalIndicateRxMgmtFrame()` 将帧内容转发给用户空间。

MTK 驱动对 SAE 的支持从 Auth 算法号的定义开始。在 `include/nic/mac.h` 中，SAE 被明确定义为算法号 3：

```c
// MTK include/nic/mac.h:608,611
#define AUTH_ALGORITHM_NUM_OPEN_SYSTEM  0   /* Open System */
#define AUTH_ALGORITHM_NUM_SAE          3   /* WPA3 - SAE */

// MTK include/nic/wlan_def.h:368,371
#define AUTH_TYPE_OPEN_SYSTEM    BIT(AUTH_ALGORITHM_NUM_OPEN_SYSTEM)
#define AUTH_TYPE_SAE            BIT(AUTH_ALGORITHM_NUM_SAE)
```

`AUTH_TYPE_SAE` 作为 BIT(3) 被多处引用——rsn.c 用它判断 AKM suite 是否为 SAE 系列、privacy.c 注册 SAE AKM suite 到 RSN 配置表、saa_fsm.c 用它决定启动哪个 Auth 流程。

**AAA FSM 层的 Auth 帧验证**——`authCheckRxAuthFrameStatus()`（`auth.c:574`）对 SAE 帧做了专门的事务序列号（Transaction Sequence Number）检查：

```c
// MTK mgmt/auth.c:1271-1280（源码有部分精简）
if (prAuthFrame->u2AuthAlgNum != AUTH_ALGORITHM_NUM_OPEN_SYSTEM &&
    prAuthFrame->u2AuthAlgNum != AUTH_ALGORITHM_NUM_SAE)
    u2ReturnStatusCode = STATUS_CODE_AUTH_ALGORITHM_NOT_SUPPORTED;
else if (prAuthFrame->u2AuthAlgNum == AUTH_ALGORITHM_NUM_OPEN_SYSTEM &&
    prAuthFrame->u2AuthTransSeqNo != AUTH_TRANSACTION_SEQ_1)
    u2ReturnStatusCode = STATUS_CODE_AUTH_OUT_OF_SEQ;
else if (prAuthFrame->u2AuthAlgNum == AUTH_ALGORITHM_NUM_SAE &&
    prAuthFrame->u2AuthTransSeqNo != AUTH_TRANSACTION_SEQ_1 &&
    prAuthFrame->u2AuthTransSeqNo != AUTH_TRANSACTION_SEQ_2)
    u2ReturnStatusCode = STATUS_CODE_AUTH_OUT_OF_SEQ;
```

主要功能：

- **只接受两种 Auth 算法**：Open System（0）和 SAE（3）——其他算法直接返回 `STATUS_CODE_AUTH_ALGORITHM_NOT_SUPPORTED`
- **Open 只接受 Seq 1**：标准 802.11 Open Auth 只有一帧请求
- **SAE 接受 Seq 1 和 Seq 2**：分别对应 Dragonfly 的 Commit 和 Confirm 帧——SAE 的 4 帧握手（AP 的 Commit+Confirm、STA 的 Commit+Confirm）都通过这个验证

**SAA FSM 层——SAE 触发外部认证路径**。在 AAA FSM 完成 BSS 选择和 Assoc 处理后，SAA FSM 被触发。对于 SAE，它不走常规的 `SAA_STATE_SEND_AUTH1` 路径，而是进入特殊状态：

```c
// MTK mgmt/saa_fsm.c:537-548（源码有部分精简）
if (prStaRec->ucAuthAlgNum == AUTH_ALGORITHM_NUM_SAE)
    saaFsmSteps(prAdapter, prStaRec,
                SAA_STATE_EXTERNAL_AUTH,        // ← 外部认证：驱动不自己发包
                (struct SW_RFB *) NULL);
else if (prStaRec->ucAuthAlgNum == AUTH_ALGORITHM_NUM_FT &&
         prStaRec->ucAuthTranNum == AUTH_TRANSACTION_SEQ_2) {
    saaFsmSteps(prAdapter, prStaRec,
                AA_STATE_IDLE,
                (struct SW_RFB *) NULL);
} else
    saaFsmSteps(prAdapter, prStaRec,
                SAA_STATE_SEND_AUTH1,           // ← Open/WPA2：驱动自己发 Auth 帧
                (struct SW_RFB *) NULL);
```

主要功能：

- **SAE → `SAA_STATE_EXTERNAL_AUTH`**：驱动不会自己生成 Auth 帧。SAE Commit 帧的内容（Scalar + Element）来自 wpa_supplicant 的 `sae_write_commit()`，驱动无法自行构造——必须等 wpa_supplicant 生成后通过 NL80211 下发
- **Open/WPA2 → `SAA_STATE_SEND_AUTH1`**：驱动内部处理，直接发送 Open System Authentication 帧
- **FT → `AA_STATE_IDLE`**：快速漫游场景下 Auth 已完成（通过 FT Action 帧），直接进入空闲状态

**SAA_STATE_EXTERNAL_AUTH 状态的实际处理**。当驱动进入 `SAA_STATE_EXTERNAL_AUTH` 后，它不再主动生成 Auth 帧，而是等待 wpa_supplicant 的指示。收到 SAE Confirm 帧（AP 的第三帧）后：

```c
// MTK mgmt/saa_fsm.c:1100-1118（源码有部分精简）
case SAA_STATE_EXTERNAL_AUTH:
    if (authCheckRxAuthFrameStatus(prAdapter,
                       prSwRfb,
                       AUTH_TRANSACTION_SEQ_2,
                       &u2StatusCode) == WLAN_STATUS_SUCCESS) {
        if (u2StatusCode != STATUS_CODE_SUCCESSFUL) {
            prStaRec->u2StatusCode = u2StatusCode;
        }
    }
    kalIndicateRxMgmtFrame(prAdapter, prAdapter->prGlueInfo,
            prSwRfb, prStaRec->ucBssIndex);  // ← 转发给 wpa_supplicant
    break;
```

主要功能：

- **只验证 Seq 2（Confirm）帧**：Commit 帧（Seq 1）由 wpa_supplicant 自己通过 NL80211 下发后驱动发送，驱动不需要处理收到的 Commit 帧
- **`kalIndicateRxMgmtFrame()`** 将 SAE 帧转发给 wpa_supplicant 用户空间——这是 MTK 与 QCOM（`lim_send_sme_mgmt_frame_ind()`）功能等价但路径不同的转发机制
- **驱动不解析 SAE 帧体**：Scalar、Element、HMAC 完全由用户空间的 `sae.c` 处理

**External Auth 完成信号**——wpa_supplicant 在用户空间完成 Dragonfly 握手后，通过 mailbox 机制通知驱动：

```c
// MTK mgmt/hem_mbox.c:80,221
{MID_OID_SAA_FSM_EXTERNAL_AUTH, saaFsmRunEventExternalAuthDone}
```

wpa_supplicant 通过 NL80211 发送 `CMD_EXTERNAL_AUTH` 事件，驱动 HEM（Host Event Mailbox）层收到后，向 SAA FSM 投递 `MSG_SAA_EXTERNAL_AUTH_DONE` 消息。`saaFsmRunEventExternalAuthDone()`（`saa_fsm.c:1909`）验证当前 STA 确实处于 `SAA_STATE_EXTERNAL_AUTH` 状态后，推进状态机进入 Assoc 阶段。

> 以上是 STA 场景的完整外部认证流程——wpa_supplicant 在用户空间完成 Dragonfly 握手后，通过 mailbox 通知驱动进入 Assoc。在 P2P 场景中，这条路径有一个微妙的变体：hostapd 接管了 SAE 帧的 ML IE 处理，驱动侧只是跳过。

**P2P 场景的特别处理**。在 P2P 链接建立时（`p2p_link.c:194-197`），SAE Auth 帧的 ML IE（Multi-Link IE）由 hostapd 处理，驱动不做解析：

```c
// MTK mgmt/p2p_link.c:194-197（源码有部分精简）
/* sae auth frames are handled by hostapd, delay register until assoc */
if (prAuthFrame->u2AuthAlgNum == AUTH_ALGORITHM_NUM_SAE) {
    DBGLOG(AAA, INFO, "auth_alg=SAE, handle ml ie in hostapd\n");
    return WLAN_STATUS_SUCCESS;
}
```

**MTK vs QCOM SAE 实现对比**：

| 维度         | QCOM                                | MTK                                        |
| ------------ | ----------------------------------- | ------------------------------------------ |
| SAE 识别函数 | `lim_process_sae_auth_frame()`      | `authCheckRxAuthFrameStatus()` (AAA FSM)   |
| SAE 转发函数 | `lim_send_sme_mgmt_frame_ind()`     | `kalIndicateRxMgmtFrame()` (SAA FSM)       |
| 架构模式     | 独立预认证帧处理函数                | 集成到 SAA FSM `SAA_STATE_EXTERNAL_AUTH`   |
| 外部认证完成 | 驱动直接回调                        | Mailbox: `MID_OID_SAA_FSM_EXTERNAL_AUTH`   |
| 重传控制     | `lim_process_auth_frame.c` 内嵌逻辑 | AAA FSM `DOT11_RSNA_SAE_RETRANS_PERIOD_TU` |
| P2P SAE      | 驱动侧与 STA 侧统一逻辑             | hostapd 处理 ML IE，驱动跳过               |

两个驱动的 SAE 共识——**驱动不接触 SAE 帧的密码学内容**（PWE 推导、Scalar、Element、HMAC 验证），全部转发给 wpa_supplicant 用户空间。这本质上是因为 Dragonfly 的 ECC 运算需要完整的椭圆曲线库——驱动固件的计算资源不足以承载，也不应该承载（安全审计和更新更困难）。

> **阅读断点**：前半程完成——Open、OWE、SAE 三种认证方式的完整代码路径已覆盖（含双平台驱动对比）。EAP-TLS、EAP-SIM 和 MLO 将在后半程展开，建议在此分段阅读。

---

# 5 EAP-TLS 和 EAP-SIM 的代码路径在哪里分叉？——从 eapol_sm_step() 到两种认证后端

> EAP-TLS 的 Auth 与 WPA2-PSK 一样走 `WPA_AUTH_ALG_OPEN`，但 **Assoc 完成后不走四次握手，先启动 EAPOL 状态机**——`eapol_sm_step()` 驱动四个子状态机（SUPP_PAE / KEY_RX / SUPP_BE / EAP Peer）完成 TLS 证书认证、从 RADIUS 服务器获取 PMK，然后才开始四次握手。

## 5.1 EAP-TLS/EAP-SIM 与 WPA2-PSK 的流程对比

```
WPA2-PSK：
  Auth(Open, 2帧) → Assoc(2帧) → 四次握手(4帧)
                                  ↑ PMK=PBKDF2(PSK, SSID) 本地已有

EAP-TLS：
  Auth(Open, 2帧) → Assoc(2帧) → EAPOL认证(N帧EAP-Request/Response) → 四次握手(4帧)
                                  ↑ PMK 来自 RADIUS 服务器                ↑ 用 RADIUS 下发的 PMK

EAP-SIM：
  Auth(Open, 2帧) → Assoc(2帧) → EAPOL认证(Start + Challenge, N帧) → 四次握手(4帧)
                                  ↑ GSM triplet 来自 HLR/AuC            ↑ 用 MSK[0:32] 作为 PMK
```

三者的 Auth 和 Assoc 在代码层面完全一样——都走 `WPA_AUTH_ALG_OPEN`，都下发 `NL80211_CMD_AUTHENTICATE` + `NL80211_CMD_ASSOCIATE`。区别在 Assoc 之后：WPA2-PSK 直接进入四次握手（PMK 已通过 PBKDF2 本地计算好），EAP-TLS 启动 EAPOL 状态机做 TLS 证书认证，EAP-SIM 启动 EAPOL 状态机做 GSM SIM 卡挑战-响应认证。

## 5.2 eapol_sm_step()——EAPOL 状态机的核心驱动

`eapol_sm_step()` 是 EAPOL 认证的主循环——它驱动四个子状态机完成从「端口未授权」到「端口已授权」的完整过程：

```c
// src/eapol_supp/eapol_supp_sm.c（源码有部分精简）
void eapol_sm_step(struct eapol_sm *sm)
{
    int i;

    // 主循环：最多 100 次迭代，每轮运行 4 个子状态机
    for (i = 0; i < 100; i++) {
        sm->changed = false;
        SM_STEP_RUN(SUPP_PAE);    // 1. Supplicant PAE：端口认证实体
        SM_STEP_RUN(KEY_RX);      // 2. 密钥接收状态机
        SM_STEP_RUN(SUPP_BE);     // 3. Supplicant 后端（超时/重传管理）
        if (eap_peer_sm_step(sm->eap))  // 4. EAP Peer 状态机（执行具体 EAP 方法）
            sm->changed = true;
        if (!sm->changed)
            break;  // 所有子状态机都稳定了，退出循环
    }

    // 如果还有变化，延迟到下一个 eloop 周期继续
    if (sm->changed) {
        eloop_cancel_timeout(eapol_sm_step_timeout, NULL, sm);
        eloop_register_timeout(0, 0, eapol_sm_step_timeout, NULL, sm);
    }

    // 通知上层 SUCCESS / FAILURE
    if (sm->ctx->cb && sm->cb_status != EAPOL_CB_IN_PROGRESS) {
        enum eapol_supp_result result;
        if (sm->cb_status == EAPOL_CB_SUCCESS)
            result = EAPOL_SUPP_RESULT_SUCCESS;
        else
            result = EAPOL_SUPP_RESULT_FAILURE;
        sm->ctx->cb(sm, result, sm->ctx->cb_ctx);
    }
}
```

主要功能：

- **安全阀**：100 次迭代上限防止状态机死循环——正常场景下（如 EAP-TLS 完整握手）仅需 2-5 次迭代即收敛，100 是防御性上限，非性能瓶颈
- **四个子状态机顺序运行**：SUPP_PAE 先跑（决定是否发送 EAPOL-Start），KEY_RX 处理密钥帧（EAP-TLS 场景中 KEY_RX 在 EAP 完成后才活跃），SUPP_BE 管理超时和重传，EAP Peer 执行具体的 EAP 方法（TLS/MSCHAPv2/SIM 等）
- **变化驱动**：只要有子状态机触发了状态变化（`sm->changed = true`），就继续迭代——直到所有子状态机都稳定
- **延迟继续**：如果在 100 次迭代内还没稳定，注册 0ms 超时让出 CPU，下一个 eloop 周期继续——避免阻塞事件循环

> 如果把 EAPOL 状态机比作酒店前台的多窗口服务系统——SUPP_PAE 是接待窗口（决定要不要开始办入住），KEY_RX 是房卡制作窗口（制卡但不核实身份），SUPP_BE 是计时器（等太久就催一下），EAP Peer 是证件核实窗口（实际检查你的证书）——四个窗口各司其职但协同工作。`eapol_sm_step()` 就是总调度员，每轮巡视一圈四个窗口，有变化就继续，没变化就收工。

## 5.3 四个子状态机的职责划分与状态转换

下图展示了 `eapol_sm_step()` 驱动的四个子状态机的整体结构及其状态转换关系（SUPP_BE 负责超时和重传管理，其状态流不做展开）。

![EAPOL 四子状态机架构](assets/06e-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%94%EF%BC%89%E5%AE%89%E5%85%A8%E5%8D%8F%E8%AE%AE%E5%88%86%E6%94%AF%E4%B8%8E-WiFi-7-MLO/06e-eapol-statemachine.svg)

| 子状态机     | 职责                                       | 关键状态                                                     | EAP-TLS 中的典型流程                                         |
| ------------ | ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **SUPP_PAE** | 端口认证实体，管理 EAPOL-Start/Logoff      | LOGOFF → DISCONNECTED → CONNECTING → AUTHENTICATING → AUTHENTICATED | Assoc 完成后从 CONNECTING 开始，发送 EAPOL-Start 给 Authenticator |
| **KEY_RX**   | 密钥接收，处理 EAPOL-Key 帧（四次握手）    | NO_KEY_RECEIVE → KEY_RECEIVE                                 | EAP-TLS 中 KEY_RX 要等 SUPP_PAE 到达 AUTHENTICATED 后，RADIUS 下发 PMK 才开始活跃 |
| **SUPP_BE**  | 后端状态机，管理 EAP 请求/响应的超时和重传 | IDLE → REQUEST → RESPONSE → SUCCESS/FAIL                     | 每次发送 EAP-Response 后启动重传定时器，超时未收到 EAP-Request 则重传 |
| **EAP Peer** | EAP 协议对等端，执行具体 EAP 方法          | IDENTITY → NOTIFICATION → METHOD → SUCCESS/FAIL              | 身份请求 → TLS 握手（在 METHOD 状态中完成） → SUCCESS        |

> **关于 `SM_STEP_RUN` 宏**：`SM_STEP_RUN(SUPP_PAE)` 不是简单的函数调用，而是「查当前状态 → 执行对应的 action 函数 → 转换到 next_state」。每个子状态机内部是一个二维表：`(当前状态, 触发事件) → (action, next_state)`。例如，SUPP_PAE 在 CONNECTING 状态下收到 `EAPOL_start` 事件后，执行对应的 action 条目并转换到 AUTHENTICATING 状态——action 函数由 SM 状态表定义，没有独立命名。

## 5.4 EAP Peer 状态机——具体 EAP 方法的执行者

```c
// src/eap_peer/eap.c（源码有部分精简）
int eap_peer_sm_step(struct eap_sm *sm)
{
    int res = 0;
    do {
        sm->changed = false;
        SM_STEP_RUN(EAP);  // 运行 EAP 主状态机（IDENTITY → METHOD → SUCCESS）
        if (sm->changed)
            res = 1;
    } while (sm->changed);
    return res;
}
```

EAP Peer 状态机内部处理以下状态转换：

- **IDENTITY**：收到 EAP-Request/Identity → 发送 EAP-Response/Identity（通常是用户名或匿名标识）
- **NOTIFICATION**：AP 推送通知消息（如「密码将过期」）→ 显示给用户或自动确认
- **METHOD**：收到 EAP-Request/Method → 调用具体 EAP 方法的 `process()` 函数（如 `eap_tls_process()`） → 发送 EAP-Response
- **SUCCESS**：收到 EAP-Success → 标记 EAP 认证完成，通知上层

对于 EAP-TLS，在 METHOD 状态中的具体处理由 `src/eap_peer/eap_tls.c` 中的 `eap_tls_process()` 完成——该函数处理 TLS 握手消息的封装/解封，管理证书验证链（CA 证书 → 客户端证书），最终完成双向 TLS 认证。

## 5.5 EAP-TLS 的三方交互模型

回到酒店比喻——EAP-TLS 就像 VIP 通道的证件审核：

```
STA (客人)                  AP (前台)                    RADIUS (总部)
   │                          │                             │
   │ EAPOL-Start ────────────→│                             │
   │                          │ RADIUS Access-Request ─────→│
   │                          │  (封装 EAP-Response/Identity)│
   │                          │                             │
   │← EAP-Request/Identity ──│← RADIUS Access-Challenge ───│
   │ EAP-Response/Identity ──→│ RADIUS Access-Request ─────→│
   │                          │                             │
   │← EAP-Request/TLS-Start ─│← RADIUS Access-Challenge ───│
   │                          │  (TLS ServerHello + 证书)   │
   │  STA 验证 AP 证书        │                             │
   │                          │                             │
   │ EAP-Response/TLS ───────→│ RADIUS Access-Request ─────→│
   │  (TLS ClientHello + 客户端证书)                         │
   │                          │  RADIUS 验证客户端证书       │
   │                          │                             │
   │← EAP-Success ────────────│← RADIUS Access-Accept ─────│
   │                          │  (含 MS-MPPE-Send-Key: PMK) │
   │                          │                             │
   │ PMK 已安装，开始四次握手   │                             │
```

三个关键点：

1. **AP 不参与证书验证**：AP 只是 RADIUS 消息的转发器（EAPOL ↔ RADIUS），所有证书验证由 STA 和 RADIUS 服务器完成
2. **PMK 由 RADIUS 生成**：在 `RADIUS Access-Accept` 消息中通过 `MS-MPPE-Send-Key` 属性下发 PMK 给 AP，AP 再通过四次握手与 STA 协商 PTK
3. **PMK 是三方协商的结果**：虽然 PMK 由 RADIUS 生成，但四次握手的 ANonce 来自 AP、SNonce 来自 STA——PTK 的派生仍然是两方协商

## 5.6 FWK 层：WifiEnterpriseConfig 的证书配置

在 Framework 层，EAP-TLS 网络的配置通过 `WifiEnterpriseConfig` 完成：

```java
// WifiConfiguration 中的企业级配置
WifiEnterpriseConfig enterpriseConfig = config.enterpriseConfig;
enterpriseConfig.setEapMethod(WifiEnterpriseConfig.Eap.TLS);  // EAP 方法 = TLS
enterpriseConfig.setCaCertificate(caCert);                     // CA 证书（验证 AP 身份）
enterpriseConfig.setClientKeyEntry(clientKey, clientCert);     // 客户端私钥 + 证书
enterpriseConfig.setDomainSuffixMatch("example.com");          // 域名匹配（防钓鱼）
```

对应到 Supplicant 侧，这些配置被翻译为 `ssid->eap` 结构体中的字段（`ssid->eap.eap_methods`），在 `sme_send_authentication()` 中 `auth_alg` 保持 `WPA_AUTH_ALG_OPEN`，然后在 Assoc 完成后 `eapol_sm_step()` 启动 EAPOL 认证流程。

EAP-TLS 在 Framework 层的连接流程与 WPA2-PSK **完全相同**——`ClientModeImpl.connectToNetwork()` → `SupplicantStaIfaceHal.connectToNetwork()` 直接适用于 EAP-TLS。区别仅在 `WifiConfiguration` 构造时：(1) `allowedKeyManagement.set(KeyMgmt.IEEE8021X)` 代替 `WPA_PSK`；(2) 需要额外设置 `enterpriseConfig`（EAP 方法、CA 证书、客户端证书）。SupplicantStateTracker 中 EAP-TLS 的状态序列为 `ASSOCIATING → ASSOCIATED → FOUR_WAY_HANDSHAKE → COMPLETED`——与 WPA2 相同，因为 EAP 认证完成后仍然走标准四次握手。

FWK 层唯一能感知到的差异是 EAP-TLS 连接耗时更长（多了 100-500ms 的 RADIUS 往返），但这不属于代码路径差异——`SupplicantStateTracker` 不区分「为什么四次握手还没开始」。

## 5.7 EAP-TLS 完整调用链

```
FWK 层：
  WifiNative.connectToNetwork()
    └── SupplicantStaIfaceHal.connectToNetwork()
          └── ISupplicantStaNetwork.select()  ← AIDL

Supplicant 层：
  sme_send_authentication()  → auth_alg = WPA_AUTH_ALG_OPEN
    └── wpa_drv_authenticate()  → NL80211_CMD_AUTHENTICATE
  sme_event_auth()  → sme_associate()  → NL80211_CMD_ASSOCIATE
  wpa_supplicant_event_assoc()  → wpa_supplicant_set_state(WPA_ASSOCIATED)
    └── eapol_sm_notify_portValid(wpa_s->eapol, FALSE)
          └── eapol_sm_step() 启动  ← 分叉点：EAP-TLS 在这里进入 EAPOL 认证
                ├── SUPP_PAE: CONNECTING → 发送 EAPOL-Start
                ├── EAP Peer: IDENTITY → METHOD（TLS 握手）
                ├── SUPP_BE: 超时/重传管理
                └── KEY_RX: 等待 RADIUS 下发 PMK
    └── eapol_sm_step() 回调 → cb_status == EAPOL_CB_SUCCESS
          └── PMK 已安装  →  四次握手开始

驱动层（QCOM）：
  Auth/Assoc 与 WPA2-PSK 完全相同（Open System Auth）
  EAPOL 帧在 Assoc 后的数据通道上传输（不是管理帧）
  → 驱动透传，不解析 EAPOL 内容
```

> EAP-TLS 和 WPA2-PSK 的 Auth/Assoc 在代码层面完全一致（都是 `WPA_AUTH_ALG_OPEN`），连 NL80211 命令都一样。它们的唯一分叉点在于 Assoc 完成后——WPA2-PSK 直接进入四次握手（PMK 本地已有），EAP-TLS 先启动 EAPOL 状态机等待 RADIUS 下发 PMK。这就是为什么企业 WiFi 连接比家庭 WiFi 慢——多了一次与 RADIUS 服务器的网络往返（通常 100-500ms）。

**异常路径速览**：EAP-TLS 的失败比 SAE 更复杂——涉及证书链验证、RADIUS 通信、状态机超时三层错误：

- **证书验证失败**：`eapol_sm_step()`（`eapol_supp_sm.c:979`）将 `cb_status` 设为 `EAPOL_CB_FAILURE`，回调通知上层结果 `EAPOL_SUPP_RESULT_FAILURE`。FWK 层收到后展示证书错误对话框——具体错误原因由 `WifiEnterpriseConfig.getAltSubjectMatch()` 等字段的诊断逻辑提取
- **EAPOL 超时**：SUPP_BE 子状态机管理的重传定时器触发 `SUPP_BE_TIMEOUT` 事件 → `eapol_sm_step()` 的 100 次迭代耗尽后返回 FAILURE → supplicant 上报 `WPA_SUPPLICANT_ERROR`
- **RADIUS 不可达**：AP 侧 RADIUS Access-Request 无响应时，AP 发送 EAP-Failure → EAP Peer 状态机进入 FAILURE 状态 → `eap_peer_sm_step()`（`eap.c:2325`）通知 `EAP_FAILURE`，上层终止连接

---

# 6 SIM 卡怎么完成企业级认证？——EAP-SIM 的 GSM triplet 与 RADIUS 管道

> EAP-SIM（RFC 4186）与 EAP-TLS 共享同一个 EAPOL 框架入口（`eapol_sm_step()`），但走的是完全不同的认证范式——EAP-TLS 用 X.509 证书链，EAP-SIM 用手机 SIM 卡中的 GSM 密钥（Ki）。RADIUS 协议作为 EAP 消息的传输管道，不区分 TLS 还是 SIM——它只负责在 AP 和认证服务器之间转发 EAP-Message 属性。

## 6.1 EAP-SIM——SIM 卡认证的完整流程

> EAP-SIM（RFC 4186）是 EAP 体系的 GSM SIM 卡认证方法。与 EAP-TLS 的「三方证书认证」不同，EAP-SIM 用手机 SIM 卡中预置的 GSM 密钥（Ki）响应网络侧下发的随机挑战（RAND），通过运行在 SIM 卡内的 A3/A8 算法推导出会话密钥。核心流程是三层交互：STA ↔ AP ↔ RADIUS ↔ HLR/AuC，认证凭据是「SIM 卡与 HLR/AuC 共享的对称密钥 Ki」，而不是证书链。

**EAP-SIM 与 EAP-TLS 的核心差异**：

| 维度       | EAP-TLS                         | EAP-SIM                                         |
| ---------- | ------------------------------- | ----------------------------------------------- |
| 认证凭据   | X.509 客户端证书                | SIM 卡 GSM 密钥（Ki）                           |
| 身份标识   | 证书 Subject DN                 | IMSI、Pseudonym 或 Reauth ID                    |
| 挑战方式   | TLS 握手（RSA/ECC）             | RAND 随机挑战 → SRES 签名                       |
| 密钥材料   | TLS PRF 输出                    | GSM A3/A8 输出（Kc × 2-3）                      |
| 服务器后端 | RADIUS 直接转发 EAP-TLS         | RADIUS → HLR/AuC 查询 GSM triplets              |
| PMK 来源   | RADIUS 下发 MSK（取前 256 bit） | RADIUS 下发 MSK（从 MK 派生，同样取前 256 bit） |
| 使用场景   | 企业 WiFi（证书管理完善）       | 运营商 WiFi / Hotspot 2.0（SIM 卡已普及）       |

**GSM Triplet 结构**。EAP-SIM 的认证基础是 GSM triplet——HLR/AuC 用共享密钥 Ki 对随机挑战 RAND 执行 A3（认证）和 A8（密钥生成）算法：

```c
// src/eap_common/eap_sim_common.h:20-23
#define EAP_SIM_KC_LEN    8      // Kc：8 字节会话密钥（GSM A8 算法输出）
#define EAP_SIM_SRES_LEN  4      // SRES：4 字节签名响应（GSM A3 算法输出）
#define GSM_RAND_LEN      16     // RAND：16 字节随机挑战（由 HLR/AuC 生成）
```

一组 triplet = `(RAND, SRES, Kc)`，三个字段各司其职：

- **RAND**（16B）：HLR/AuC 生成的随机挑战 → STA 收到后送入 SIM 卡芯片运算
- **SRES**（4B）：SIM 卡用 `Ki + RAND` 执行 A3 算法生成的签名响应 → 服务器用它验证客户端身份（持有正确的 Ki）
- **Kc**（8B）：SIM 卡用 `Ki + RAND` 执行 A8 算法生成的会话密钥种子 → 2-3 组 Kc 拼接后派生出 MK

EAP-SIM 通常使用 2-3 组 triplet（由 `EAP_SIM_MAX_CHAL = 3` 限制），每组 triplet 的 RAND 互不相同——多组 triplet 提供更强的安全性（3 组 Kc 拼接后派生 MK，密钥强度 = 3 × 64 bit ≈ 192 bit，对抗 2G GSM 64-bit Kc 的弱点）。

**EAP-SIM 属性体系**（`eap_sim_common.h:136-162`）：

| 属性                  | ID   | 方向 | 说明                                            |
| --------------------- | ---- | ---- | ----------------------------------------------- |
| `AT_RAND`             | 1    | S→P  | 服务器下发的 16 字节随机挑战（2-3 组）          |
| `AT_MAC`              | 11   | 双向 | HMAC-SHA1-128(K_aut, msg                        |
| `AT_IDENTITY`         | 14   | P→S  | 客户端身份（IMSI、Pseudonym 或 Reauth ID）      |
| `AT_NONCE_MT`         | 7    | P→S  | Mobile Terminal Nonce（客户端 16 字节随机数）   |
| `AT_SELECTED_VERSION` | 16   | P→S  | 选中的 EAP-SIM 协议版本                         |
| `AT_VERSION_LIST`     | 15   | S→P  | 服务器支持的版本列表                            |
| `AT_IV`               | 129  | 双向 | AES-128-CBC IV（加密属性块）                    |
| `AT_ENCR_DATA`        | 130  | 双向 | AES-128-CBC 加密负载（含 pseudonym、reauth_id） |
| `AT_NEXT_PSEUDONYM`   | 132  | S→P  | 新 pseudonym（加密块内，隐私保护）              |
| `AT_NEXT_REAUTH_ID`   | 133  | S→P  | 新重认证 ID（加密块内）                         |
| `AT_RESULT_IND`       | 135  | 双向 | 结果指示——成功后先通知再发 EAP-Success          |

属性的可跳过性由 ID 范围决定：0-127 为不可跳过（未知属性导致解析失败），128+ 为可跳过（未知属性静默忽略）。

**EAP-SIM Peer 状态机和分发入口**（`eap_sim.c:48-50`）：

```
CONTINUE → START_DONE → RESULT_SUCCESS → SUCCESS / FAILURE
```

五种处理函数构成完整的状态机（`eap_sim.c:1193`）：

| Subtype                            | 值   | 处理函数                             | 作用                                                     |
| ---------------------------------- | ---- | ------------------------------------ | -------------------------------------------------------- |
| `EAP_SIM_SUBTYPE_START`            | 10   | `eap_sim_process_start()`            | 版本协商 + 发送 NONCE_MT + 选择身份                      |
| `EAP_SIM_SUBTYPE_CHALLENGE`        | 11   | `eap_sim_process_challenge()`        | 处理 RAND 挑战 → 运行 GSM A3/A8 → 派生密钥 → 验证 AT_MAC |
| `EAP_SIM_SUBTYPE_NOTIFICATION`     | 12   | `eap_sim_process_notification()`     | 处理通知（成功确认 / 失败原因）                          |
| `EAP_SIM_SUBTYPE_REAUTHENTICATION` | 13   | `eap_sim_process_reauthentication()` | 快速重认证（用缓存的 MK 跳过 GSM 运算）                  |
| `EAP_SIM_SUBTYPE_CLIENT_ERROR`     | 14   | `eap_sim_client_error()`             | 客户端错误报告                                           |

下图展示了 EAP-SIM 完整的 18 步认证流程——从 EAPOL-Start 到 SIM 卡挑战-响应，再到 RADIUS 密钥下发和四次握手：

![EAP-SIM 完整认证流程时序图](assets/06e-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%94%EF%BC%89%E5%AE%89%E5%85%A8%E5%8D%8F%E8%AE%AE%E5%88%86%E6%94%AF%E4%B8%8E-WiFi-7-MLO/06e-eap-sim-sequence.svg)

核心步骤可概括为三个阶段（对应图中 5 个 Phase 的合并视图）：

- **阶段一：身份交换**（步骤 1-8，图中 Phase 1-2）——STA 通过 EAPOL-Start 启动认证，AP 将 EAP 消息封装到 RADIUS Access-Request 转发给认证服务器，RADIUS 从 HLR/AuC 获取 GSM triplets，完成 EAP-Response/Identity 交换
- **阶段二：SIM 卡挑战-响应**（步骤 9-16，图中 Phase 3）——服务器下发 SIM-Start 版本协商和 RAND 挑战，STA 的 SIM 卡在卡内用 Ki 执行 A3/A8 算法生成 SRES/Kc，派生 MK 和会话密钥，双方通过 AT_MAC 互相验证
- **阶段三：密钥下发与握手**（步骤 17-18，图中 Phase 4-5）——RADIUS Access-Accept 携带 MS-MPPE-Send-Key 下发 MSK，AP 取前 32 字节作为 PMK，启动四次握手

**密钥派生体系**——EAP-SIM 的密钥派生分两层。第一层 MK（Master Key），由 GSM triplet 的 Kc 和协议参数派生：

```
MK = SHA1(Identity || Kc1 || Kc2 [|| Kc3] || NONCE_MT || VersionList || SelectedVersion)
```

`eap_sim_derive_mk()`（`eap_sim_common.c`）将 Identity 和所有 Kc 拼接后做 SHA1，输出 20 字节。NONCE_MT 的作用是保证每次认证产生的 MK 唯一——即使 GSM triplet 被重用（HLR 可能缓存），MK 也不同。

第二层：FIPS 186-2 PRF（`eap_sim_derive_keys()`）将 20 字节 MK 扩展为完整的会话密钥集：

```
K_encr(16 bytes) || K_aut(16 bytes) || MSK(64 bytes) || EMSK(64 bytes) = FIPS186-2-PRF(MK)
```

- **K_encr**（16B）：AES-128-CBC 加密密钥——保护 pseudonym、reauth_id 等隐私属性
- **K_aut**（16B）：HMAC-SHA1-128 认证密钥——计算和验证 AT_MAC
- **MSK**（64B）：Master Session Key → PMK = MSK[0:32]，用于 WPA/WPA2 四次握手
- **EMSK**（64B）：Extended MSK——保留供未来扩展使用

**AT_MAC 的验证机制**。每次 EAP-SIM 消息交换都携带 AT_MAC 防止篡改。MAC 计算涵盖整个 EAP 消息（MAC 字段自身置零）加上上下文相关的 extra data：

- **Start 响应**：extra = 空（密钥尚未派生）
- **Challenge 请求验证**（客户端验证服务器）：extra = NONCE_MT——证明服务器也持有正确的 Kc（服务器从 Kc 派生了 K_aut）
- **Challenge 响应验证**（服务器验证客户端）：extra = SRES1 || SRES2 [|| SRES3]——证明客户端 SIM 卡持有正确的 Ki
- **Reauthentication**：extra = NONCE_S

`eap_sim_verify_mac()`（`eap_sim_common.c`）使用常数时间比较（`os_memcmp_const`）防止时序攻击。消息副本的 MAC 字段先置零再计算 HMAC——这是 EAP-SIM 的标准做法，确保 MAC 覆盖消息的其余所有属性。

**服务器端的 SIM DB 接口**。`eap_sim_db_get_gsm_triplets()`（`eap_sim_db.h:40-47`）负责从 HLR/AuC 获取 GSM triplet：

```c
// src/eap_server/eap_sim_db.h:40-47（接口定义）
int eap_sim_db_get_gsm_triplets(struct eap_sim_db_data *data,
                const char *username, int max_chal,
                u8 *_rand, u8 *kc, u8 *sres, void *cb_session_ctx);
// 返回值：EAP_SIM_DB_FAILURE (-1) / EAP_SIM_DB_PENDING (-2) / triplet 数量
```

支持两种模式：UNIX socket 模式（`unix:/path/to/socket` 连接外部 SS7 信令网关）和 SQLite 模式（存储 pseudonym/reauth 映射）。身份体系使用单字节前缀：`'1'` = SIM 永久身份（IMSI）、`'3'` = SIM pseudonym、`'5'` = SIM reauth ID。

> EAP-SIM 就像你拿手机里的电子身份证入住——前台不核实你的脸（TLS 证书），而是把你的 SIM 卡号（IMSI）传给电信运营商的总部（HLR/AuC）。总部给前台发来一串随机验证码（RAND），你的 SIM 芯片在卡内用出厂烧录的密钥（Ki）算出正确答案（SRES）并回传——全程真实密钥（Ki）从未离开 SIM 卡，也不在网络上传输。EAP-TLS 的 VIP 证件通道适合公司内部网络（IT 部门给你装了证书），EAP-SIM 的手机身份证通道适合运营商公共热点（你已经有 SIM 卡）。

## 6.2 RADIUS 协议——EAP 消息的传输管道

> **Tips**：如果你不需要理解 RADIUS 协议的具体封装细节，可以跳到 §7——RADIUS 的核心角色用一句话概括就是「EAP 消息的 UDP 传输管道 + PMK 的加密快递员」。下面的内容适合需要了解消息格式和密钥下发机制的读者。

> RADIUS 是 AP 与认证服务器之间的 UDP 协议，负责将 EAP 消息从 AP 转送到认证服务器再传回。它的核心数据单元是「属性—长度—值」（TLV），EAP 消息被封装在 `EAP-Message` 属性（type=79）中，会话密钥通过 Microsoft 厂商扩展属性 MS-MPPE-Send-Key（type=16）加密下发。RADIUS 本质上是一个承载管道，它不解析 EAP 消息的内容——不管是 TLS 证书还是 SIM 挑战。

**RADIUS 消息格式**（`radius.h:18-31`）：

```c
// src/radius/radius.h:18-31（RFC 2865）
struct radius_hdr {
    u8 code;              // 消息类型（1-45）
    u8 identifier;        // 请求-响应匹配序号（0-255）
    be16 length;          // 总长度（含头部，≤ 4096 字节）
    u8 authenticator[16]; // 认证器（请求=随机，响应=MD5(响应||请求Auth||共享密钥)）
};
// be16 = big-endian 16-bit（网络字节序 uint16_t，wpa_supplicant 内部类型别名）
// 头后跟随若干个 TLV 属性
```

六种核心消息类型：

| Code | 名称                | 方向      | 作用                                      |
| ---- | ------------------- | --------- | ----------------------------------------- |
| 1    | Access-Request      | AP→RADIUS | 请求认证（含 EAP-Response）               |
| 2    | Access-Accept       | RADIUS→AP | 认证通过（含 MS-MPPE 密钥 + EAP-Success） |
| 3    | Access-Reject       | RADIUS→AP | 认证拒绝（含 EAP-Failure）                |
| 11   | Access-Challenge    | RADIUS→AP | 挑战/继续认证（含 EAP-Request）           |
| 4    | Accounting-Request  | AP→RADIUS | 计费上报                                  |
| 5    | Accounting-Response | RADIUS→AP | 计费确认                                  |

**关键属性**（`radius.h:59-106`）：

| Type | 属性名                | 说明                                              |
| ---- | --------------------- | ------------------------------------------------- |
| 1    | User-Name             | 用户身份（IMSI 或 username@realm）                |
| 79   | EAP-Message           | EAP 消息封装（RFC 3579）——每个 EAP 包放入一个属性 |
| 80   | Message-Authenticator | HMAC-MD5(整条 RADIUS 消息, shared_secret)——防篡改 |
| 26   | Vendor-Specific       | 厂商扩展（MS-MPPE 密钥在此下发）                  |

**EAP-over-RADIUS 封装**——`radius_msg_add_eap()` 和 `radius_msg_get_eap()`（`radius.c`）将 EAP 消息放入/取出 `EAP-Message` 属性。如果 EAP 包大于 RADIUS 单属性最大长度（253 字节），会被分片到多个 `EAP-Message` 属性中（RFC 3579 §2.2）。下图展示了从 EAP 消息到 RADIUS UDP 包的逐层封装路径和密钥派生链：

![RADIUS 封装与密钥派生](assets/06e-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%94%EF%BC%89%E5%AE%89%E5%85%A8%E5%8D%8F%E8%AE%AE%E5%88%86%E6%94%AF%E4%B8%8E-WiFi-7-MLO/06e-radius-eap-sim.svg)

```
RADIUS Access-Request:
  RADIUS Header (code=1, id=47)
  ├── User-Name = "123450000000001@wlan.mnc000.mcc123.3gppnetwork.org"
  ├── EAP-Message = EAP-Response/Identity (decoded IMSI)
  ├── NAS-IP-Address = 192.168.1.1
  ├── Called-Station-Id = "00-11-22-33-44-55:MyWiFi"
  ├── Calling-Station-Id = "AA-BB-CC-DD-EE-FF"
  └── Message-Authenticator = HMAC-MD5(whole_msg, secret)

RADIUS Access-Challenge:
  RADIUS Header (code=11, id=47)
  ├── EAP-Message = EAP-Request/SIM-Start (含 AT_VERSION_LIST)
  ├── State = 0xA1B2C3... (opaque session state)
  └── Message-Authenticator = HMAC-MD5(whole_msg, secret)
```

`State` 属性的作用是维持会话状态——RADIUS 本身是无状态协议（UDP），每次 Access-Challenge 后 AP 必须在下一个 Access-Request 中回传服务器下发的 `State` 属性，让 RADIUS 服务器知道这个请求属于哪个会话。

**MS-MPPE 密钥下发**——RADIUS 通过 Microsoft 点对点加密扩展（RFC 2548）在 Access-Accept 中下发 PMK：

```c
// src/radius/radius.h:206-210
#define RADIUS_VENDOR_ID_MICROSOFT  311
enum {
    RADIUS_VENDOR_ATTR_MS_MPPE_SEND_KEY = 16,  // AP→STA 方向密钥（PMK）
    RADIUS_VENDOR_ATTR_MS_MPPE_RECV_KEY = 17,  // STA→AP 方向密钥（不使用）
};
```

加密方式：先用 RADIUS shared secret + Request Authenticator 做 MD5 派生一个 16 字节加密密钥，然后对 MSK 做 RC4 加密。解密后得到 MSK（64 字节），AP 取前 32 字节作为 PMK，用于后续的四次握手。

**关键函数**：

- `radius_msg_get_ms_keys()`（`radius.c`）——从 Access-Accept 解析 MS-MPPE-Send-Key 和 MS-MPPE-Recv-Key，解密后返回 `struct radius_ms_mppe_keys`
- `radius_msg_add_mppe_keys()`（`radius.c`）——在 Access-Accept 中添加加密后的 MS-MPPE 密钥
- `radius_msg_finish_srv()`（`radius.c`）——计算 Response Authenticator = MD5(响应码||请求ID||响应长度||请求Auth||响应体||secret)，然后计算 Message-Authenticator

> RADIUS 是 EAP 的传输管道——无论是 EAP-TLS 的证书、EAP-SIM 的 GSM triplet 还是 MS-MPPE 密钥，都通过同一种 RADIUS 消息格式（Access-Request/Challenge/Accept）在同一条 UDP 通道上传输。AP 作为中间节点不解析 EAP 内容（只做 EAPOL ↔ RADIUS 的格式转换），密钥（PMK）通过厂商扩展属性加密下发——从 AP 的角度看，EAP-TLS 和 EAP-SIM 的唯一区别是「RADIUS 消息多一个或少一个往返」。

## 6.3 EAP-SIM 核心代码路径

```
FWK 层：
  WifiNative.connectToNetwork()
    └── SupplicantStaIfaceHal.connectToNetwork()
          └── ISupplicantStaNetwork.select()  ← AIDL

Supplicant 层：
  sme_send_authentication()  → auth_alg = WPA_AUTH_ALG_OPEN
    └── wpa_drv_authenticate()  → NL80211_CMD_AUTHENTICATE
  sme_event_auth()  → sme_associate()  → NL80211_CMD_ASSOCIATE
  wpa_supplicant_event_assoc()  → wpa_supplicant_set_state(WPA_ASSOCIATED)
    └── eapol_sm_notify_portValid(wpa_s->eapol, FALSE)
          └── eapol_sm_step() 启动
                ├── EAP Peer: IDENTITY → eap_sim_process()
                │     ├── SUBTYPE_START → eap_sim_process_start()
                │     │     └── 选择版本、生成 NONCE_MT、发送 AT_IDENTITY
                │     ├── SUBTYPE_CHALLENGE → eap_sim_process_challenge()
                │     │     ├── 提取 AT_RAND × N
                │     │     ├── SIM 卡内运行 A3/A8 → (SRES, Kc)
                │     │     ├── eap_sim_derive_mk() → MK(20B)
                │     │     ├── eap_sim_derive_keys() → K_encr|K_aut|MSK|EMSK
                │     │     ├── eap_sim_verify_mac() → 验证服务器 AT_MAC
                │     │     └── 构造响应（客户端 AT_MAC）
                │     └── NOTIFICATION/SUCCESS → 状态推进
                └── eapol_sm_step() 回调 → cb_status == EAPOL_CB_SUCCESS
                      └── PMK = MSK[0:32]  →  四次握手开始

驱动层：
  Auth/Assoc 与 WPA2-PSK 完全相同（Open System Auth）
  EAPOL 帧在 Assoc 后的数据通道上传输（非管理帧）
  → 驱动透传，不解析 EAPOL 内容
  → SAE 场景：驱动走 SAA_STATE_EXTERNAL_AUTH 后由 wpa_supplicant 控制

RADIUS 层（AP 侧 hostapd）：
  eapol_auth → RADIUS Client:
    radius_msg_add_eap()   ← EAP-Response 封装到 RADIUS Access-Request
    radius_msg_get_eap()   ← 从 RADIUS Access-Challenge 提取 EAP-Request
    radius_msg_get_ms_keys() ← 从 Access-Accept 提取 PMK
```

> **阅读断点**：后半程中段——EAP 企业级认证（EAP-TLS + EAP-SIM + RADIUS）已覆盖。接下来是 WiFi 7 MLO 多链路连接，建议休息后继续。

---

# 7 WiFi 7 MLO 怎么同时管理多条链路？——QCOM 驱动的 mlo_connect() 完整追踪

> MLO（Multi-Link Operation）不是安全协议，但它的多链路同时建立方式和密钥管理机制是连接流程的重要分支。`mlo_connect()`（QCOM 驱动 `wlan_mlo_mgr_sta.c:770`）是 MLO 连接的入口——它验证 MLO 能力、保存连接请求副本、调用 `wlan_cm_start_connect()` 启动第一条链路，然后在第一条链路完成后逐条建立伙伴链路。所有链路共享同一个 MLD 地址，密钥可以在链路上共享或独立。

## 7.1 MLO 与普通连接的本质区别

| 维度           | 普通连接                  | MLO 连接                                         |
| -------------- | ------------------------- | ------------------------------------------------ |
| **链路数**     | 1                         | 2-3（2.4G + 5G + 6G）                            |
| **MAC 地址**   | 1 个                      | 多个（1 个 MLD MAC + 每条链路 1 个 Link MAC）    |
| **vdev 数**    | 1 个                      | 多个（每条链路 1 个 vdev）                       |
| **连接入口**   | `wlan_cm_start_connect()` | `mlo_connect()` → `wlan_cm_start_connect()`      |
| **Auth/Assoc** | 1 轮                      | 主链路 1 轮完整 Auth+Assoc，其余链路逐条建立     |
| **密钥**       | 1 套 PTK/GTK              | 可共享（MLD 级别 1 套）或独立（每条链路各 1 套） |
| **失败容忍**   | 单链路失败即失败          | 部分链路失败不阻断已建立链路                     |

## 7.2 Supplicant 层：sme_send_authentication() 中的 MLO 标记

在 `sme_send_authentication()` 中，MLO 的处理位于函数开头（line 584-603），早于所有 `auth_alg` 决策：

```c
// wpa_supplicant/sme.c:584-603（源码有部分精简）
if ((wpa_s->drv_flags2 & WPA_DRIVER_FLAGS2_MLO) &&
    !wpa_bss_parse_basic_ml_element(wpa_s, bss, wpa_s->ap_mld_addr,
                                    NULL, ssid, NULL) &&
    bss->valid_links) {
    wpa_printf(MSG_DEBUG, "MLD: In authentication");
    wpas_sme_set_mlo_links(wpa_s, bss, ssid);

    params.mld = true;                           // 标记本次连接是 MLO
    params.mld_link_id = wpa_s->mlo_assoc_link_id;  // 指定当前链路 ID
    params.ap_mld_addr = wpa_s->ap_mld_addr;     // MLD 地址（非链路 MAC）
    wpas_ml_handle_removed_links(wpa_s, bss);    // 处理已移除的链路
}
```

主要功能：

- **检查三个条件**：驱动支持 MLO（`WPA_DRIVER_FLAGS2_MLO`）+ AP 的 Beacon 中有 Basic ML Element + AP 至少有一条有效伙伴链路
- **`params.mld = true`**：这个标志传递给 `wpa_drv_authenticate()`，最终影响 nl80211 的 `NL80211_ATTR_MLD_ADDR` 属性——内核需要知道这是一个 MLO 连接
- **MLO 不改变 `auth_alg`**：无论底层是 WPA2、SAE 还是 EAP，`auth_alg` 的决策与普通连接完全一样——MLO 只是多了一个标记位

## 7.3 驱动层：mlo_connect()——MLO 连接的入口

当 QCOM 驱动设置 `WPA_DRIVER_FLAGS_SME` 时，wpa_supplicant 用一条 `NL80211_CMD_CONNECT` 下发，内核 cfg80211 分发到驱动的 `.connect` 回调，经 `osif_cm_connect()`（`osif_cm_req.c:757`）最终调用 `mlo_connect()`（`osif_cm_req.c:856`）。

```c
// QCOM qca-wifi-host-cmn/umac/mlo_mgr/src/wlan_mlo_mgr_sta.c（源码有部分精简）
QDF_STATUS mlo_connect(struct wlan_objmgr_vdev *vdev,
                       struct wlan_cm_connect_req *req)
{
    struct wlan_mlo_dev_context *mlo_dev_ctx;
    struct wlan_mlo_sta *sta_ctx = NULL;
    QDF_STATUS status = QDF_STATUS_SUCCESS;

    mlo_dev_ctx = vdev->mlo_dev_ctx;
    if (mlo_dev_ctx)
        sta_ctx = mlo_dev_ctx->sta_ctx;

    if (sta_ctx) {
        // 1. 验证 MLO 能力（驱动是否支持、vdev 是否为 MLO vdev）
        status = mlo_validate_mlo_cap(vdev);
        if (QDF_IS_STATUS_ERROR(status))
            return wlan_cm_start_connect(vdev, req);  // 降级为普通连接

        mlo_dev_lock_acquire(mlo_dev_ctx);

        // 2. 检查是否有链路正在连接/漫游/断开
        status = mlo_validate_connect_req(vdev, mlo_dev_ctx, req);

        // 3. 保存连接请求副本（用于后续伙伴链路建立时重放参数）
        copied_conn_req_lock_acquire(sta_ctx);
        if (!sta_ctx->copied_conn_req)
            sta_ctx->copied_conn_req = qdf_mem_malloc(
                    sizeof(struct wlan_cm_connect_req));
        qdf_mem_copy(sta_ctx->copied_conn_req, req,
                     sizeof(struct wlan_cm_connect_req));
        mlo_allocate_and_copy_ies(sta_ctx->copied_conn_req, req);
        copied_conn_req_lock_release(sta_ctx);

        // 4. 清空旧链路位图 + 启动第一条链路
        if (QDF_IS_STATUS_SUCCESS(status)) {
            mlo_clear_connected_links_bmap(vdev);   // 清零已连接链路位图
            mlo_clear_sta_key_mgmt(vdev);           // 清理旧密钥状态
            mlo_dev_lock_release(mlo_dev_ctx);

            status = wlan_cm_start_connect(vdev, req);  // 启动第一条链路
            if (QDF_IS_STATUS_ERROR(status))
                mlo_mld_clear_mlo_cap(vdev);  // 失败则清除 MLO 标记
            return status;
        }
        mlo_dev_lock_release(mlo_dev_ctx);
        return status;
    }

    // sta_ctx 为空 → 降级为普通连接
    return wlan_cm_start_connect(vdev, req);
}
```

主要功能：

- **MLO 能力验证**：`mlo_validate_mlo_cap()` 调用 `wlan_vdev_mlme_is_mlo_vdev()` 检查 vdev 是否注册为 MLO vdev——如果不是或驱动不支持 MLO，直接降级为 `wlan_cm_start_connect()`（普通单链路连接）
- **忙碌检查**：`mlo_validate_connect_req()` 遍历所有 MLO vdev，检查是否有链路正在连接/漫游/断开——避免同时启动多个连接请求导致的竞态
- **连接请求副本**：`copied_conn_req` 保存完整的 `wlan_cm_connect_req`（包括所有 IE），后续伙伴链路建立时从这份副本出发，覆盖 BSSID、channel、link_id 等链路特有参数——这样第二条链路可以使用与第一条链路相同的认证方式
- **链路位图**：`mlo_clear_connected_links_bmap()` 清零 `wlan_connected_links` bitmap——每个 bit 代表一条链路是否已建立，后续每条链路 Auth/Assoc 成功后对应的 bit 被置位

> `mlo_connect()` 的核心逻辑可以浓缩为一张决策表——入口是 `mlo_validate_mlo_cap()` 的检查结果，出口是 `wlan_cm_start_connect()` 或降级路径：
>
> | 检查条件                                 | 结果                      | 说明                               |
> | ---------------------------------------- | ------------------------- | ---------------------------------- |
> | `mlo_dev_ctx` 为 NULL                    | 降级为普通连接            | vdev 未注册为 MLO vdev             |
> | `mlo_validate_mlo_cap()` 失败            | 降级为普通连接            | 驱动不支持 MLO                     |
> | `mlo_validate_connect_req()` 返回 E_BUSY | 直接返回错误              | 有链路正在连接/漫游/断开           |
> | 全部通过                                 | `wlan_cm_start_connect()` | 启动第一条链路，进入多链路建立流程 |

## 7.4 多链路建立的完整序列

```
1. 第一条链路（锚点链路，通常 5GHz 或 6GHz）：
   mlo_connect() → wlan_cm_start_connect()
     → Auth (按 WPA2/SAE/EAP 正常流程)
     → Assoc
       → Assoc Resp 中包含 Basic ML Element IE
         → 解析出伙伴链路信息（link ID, BSSID, 信道等）
         → 保存到 sta_ctx->copied_conn_req

2. 主链路 Auth/Assoc 完成后：
   mlo_sta_link_connect_notify() 被回调：
     → 缓存 ml_partner_info（伙伴链路信息）
     → 调用 mlo_send_link_connect() 为每条伙伴链路发起连接
       → mlo_prepare_and_send_connect() 用 copied_conn_req 作为模板
         → 覆盖 BSSID、channel、link_id 等链路特有参数
         → 调用 wlan_cm_start_connect(partner_vdev, &req)
           → 每条链路独立完成 Auth + Assoc

3. 所有链路建立后：
   四次握手（在主链路上完成，或每条链路独立——取决于 AP 配置）
```

下图展示了 MLO 多链路建立的完整时序——从 `mlo_connect()` 入口到锚点链路 Auth/Assoc、伙伴链路逐条建立、EAPOL 四次握手和密钥同步：

![MLO 多链路建立时序](assets/06e-STA-%E8%BF%9E%E6%8E%A5%EF%BC%88%E4%BA%94%EF%BC%89%E5%AE%89%E5%85%A8%E5%8D%8F%E8%AE%AE%E5%88%86%E6%94%AF%E4%B8%8E-WiFi-7-MLO/06e-mlo-sequence.svg)

## 7.5 MLO 密钥管理——延迟安装机制

MLO 的密钥管理面临一个特殊问题：一条链路可能在其伙伴链路还在建立中就收到了四次握手的密钥材料（Message 3），但此时伙伴链路的 vdev 还没有完全准备好（BSS peer 未创建）。QCOM 驱动通过延迟安装机制解决这个问题：

```c
// QCOM qca-wifi-host-cmn/umac/mlo_mgr/inc/wlan_mlo_mgr_public_structs.h（精简）
struct wlan_mlo_key_mgmt {
    bool keys_saved;     // 密钥是否已延迟保存
    uint8_t link_id;     // 该密钥对应的链路 ID
};

struct wlan_mlo_sta {
    // ...省略...
    struct wlan_mlo_key_mgmt key_mgmt[WLAN_MAX_ML_BSS_LINKS];  // 每条链路一个 slot
};
```

三个关键函数：

- `mlo_defer_set_keys(vdev, link_id, true)`：在 `key_mgmt[]` 数组中找一个空 slot，标记 `keys_saved = true`，记录 `link_id`——表示该链路的密钥需要延迟安装
- `mlo_is_set_key_defered(vdev, link_id)`：检查指定 `link_id` 的密钥是否处于延迟状态——用于判断是否可以立即安装密钥
- `mlo_defer_set_keys(vdev, link_id, false)`：清除延迟标志，允许密钥安装——在伙伴链路的 BSS peer 创建完成后调用
- `mlo_set_keys_saved(vdev, mac_address, true)`：在 `wlan_cm_vdev_connect.c:1596` 中调用，连接建立时标记密钥为已保存状态——HDD 层通过 `wlan_hdd_mlo_set_keys_saved()`（`wlan_hdd_cfg80211.c:21725`）包装此调用

## 7.6 MLO 每条链路的加密实现——PTK/GTK 如何 per-link 安装

延迟安装机制解决了「何时安装」的问题，但「每条链路的密钥如何独立加密」是另一个关键问题。IEEE 802.11be 规范定义了两种 MLO 密钥模式：

| 模式             | PTK                                        | GTK                                                          | 适用场景                              |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------- |
| **共享密钥模式** | 所有链路共享同一 PTK，由 MLD 地址派生      | 所有链路共享同一 GTK                                         | AP 配置简单，但单密钥泄露影响所有链路 |
| **独立密钥模式** | 每条链路独立 PTK，由各自 Link MAC 地址派生 | 每条链路独立 GTK，通过 EAPOL-Key Message 3/4 中的 MLO GTK KDE 分发 | 安全性更高，密钥泄露仅影响单条链路    |

> 以下从 wpa_supplicant → NL80211 → QCOM 驱动逐层追踪 per-link 密钥的具体安装机制。全程涉及 `wpa_sm_set_key()`、`NL80211_ATTR_MLO_LINK_ID` 和驱动层 vdev 密钥表三个抽象层。如果只需要理解概念层面（共享 vs 独立密钥的区别），可直接跳到 §7.7 看完整调用链。

**wpa_supplicant 层的 per-link 密钥管理**。在 `wpa.c` 中，MLO 的密钥安装通过 `wpa_sm_set_key()` 函数的 `link_id` 参数区分链路。关键区别在于 PTK 和 GTK 的安装方式不同：

- **PTK（Pairwise Key）**：`wpa_supplicant_install_ptk()`（`wpa.c:1221`）调用 `wpa_sm_set_key(sm, -1, ...)`——`link_id = -1` 表示使用默认链路。PTK 的安装不指定 link_id，因为 PTK 的 peer 地址使用 MLD 地址（而非链路 MAC 地址），由驱动根据 MLD 地址自动关联到正确的链路
- **GTK（Group Key）**：`wpa_supplicant_install_mlo_gtk()`（`wpa.c:1432`）调用 `wpa_sm_set_key(sm, link_id, ...)`——显式指定 `link_id`。每条链路的 GTK 独立安装，因为 GTK 绑定到链路的广播地址

```c
// src/rsn_supp/wpa.c（源码有部分精简）
// MLO GTK 安装——每条链路独立
static int wpa_supplicant_install_mlo_gtk(struct wpa_sm *sm, u8 link_id,
                                          const struct wpa_gtk_data *gd,
                                          const u8 *key_rsc, int wnm_sleep)
{
    // 防重复安装检查
    if (sm->mlo.gtk.link_id == link_id && sm->mlo.gtk.keyidx == gd->keyidx) {
        wpa_printf(MSG_DEBUG,
                   "RSN: Not reinstalling already in-use GTK to the driver "
                   "(link_id=%d keyidx=%d)", link_id, gd->keyidx);
        return 0;
    }

    // 通过 link_id 安装到指定链路
    if (wpa_sm_set_key(sm, link_id, gd->alg, broadcast_ether_addr,
                       gd->keyidx, 0, gd->gtk, gd->gtk_len,
                       key_rsc, wnm_sleep) < 0) {
        wpa_printf(MSG_WARNING,
                   "RSN: Failed to set GTK to the driver "
                   "(link_id=%d alg=%d keylen=%d keyidx=%d)",
                   link_id, gd->alg, gd->gtk_len, gd->keyidx);
        return -1;
    }
    // ...省略...
}
```

> 上述 `link_id` 并非凭空出现——它来自四次握手 Message 3 中的 MLO GTK KDE（Key Descriptor Element）。`wpa_supplicant_process_3_of_4()` 遍历 Message 3 中的所有 KDE，提取每个 KDE 的 `link_id` 后调用 `wpa_supplicant_install_mlo_gtk()`，将 GTK 安装到对应链路。

**MLO GTK KDE 格式**。四次握手的 Message 3 中，GTK 通过 MLO GTK KDE（Key Descriptor Element）分发。每个 KDE 包含一个 `link_id` 字段，标识该 GTK 属于哪条链路：

```
MLO GTK KDE 格式（wpa.c:1548）：
  Link ID (1 byte)  |  Key ID (1 byte)  |  TX (1 byte)  |  GTK (variable)
```

`wpa.c` 中的 `wpa_supplicant_process_3_of_4()`（`wpa.c:2714`）函数遍历 Message 3 中的所有 MLO GTK KDE，对每个 KDE 提取 `link_id`，然后调用 `wpa_supplicant_install_mlo_gtk()` 将 GTK 安装到对应的链路。同样的机制也适用于 MLO IGTK（`wpa.c:1787`）和 MLO BIGTK（`wpa.c:1844`）。

**NL80211 层的 link_id 传递**。`wpa_sm_set_key()` 最终调用 `driver_nl80211.c` 中的 `wpa_driver_nl80211_set_key()`（`driver_nl80211.c:3500`），该函数在 nl80211 消息中添加 `NL80211_ATTR_MLO_LINK_ID` 属性：

```c
// src/drivers/driver_nl80211.c（精简）
// 在 NL80211_CMD_NEW_KEY / NL80211_CMD_SET_KEY 消息中添加 link_id
if (link_id >= 0) {
    if (nla_put_u8(msg, NL80211_ATTR_MLO_LINK_ID, link_id))
        goto fail;
}
```

内核 nl80211 的规范（`nl80211_copy.h:386-404`）明确了 MLO 密钥操作的语义：

- **Pairwise Key（PTK）**：`NL80211_ATTR_MAC` 使用 peer 的 **MLD 地址**（非链路 MAC），驱动根据 MLD 地址自动关联到正确的链路
- **Group Key（GTK）**：通过 `NL80211_ATTR_MLO_LINK_ID` 显式指定链路——因为 GTK 绑定到链路的广播地址，无法从 MLD 地址推断
- **Default Key 设置**：`NL80211_CMD_SET_KEY` 的 `NL80211_ATTR_KEY_DEFAULT` 也需要 `NL80211_ATTR_MLO_LINK_ID` 来指定在哪个链路上设置默认密钥

**驱动层 per-link 密钥安装**。QCOM 驱动收到带 `NL80211_ATTR_MLO_LINK_ID` 的密钥安装请求后，根据 link_id 找到对应的 vdev，将密钥安装到该 vdev 的硬件加密引擎。每条链路有独立的 vdev 和独立的密钥表——这是 MLO per-link 加密的硬件基础。

## 7.7 MLO 完整调用链

```
FWK 层（对 MLO 透明）：
  WifiNative.connectToNetwork()
    └── SupplicantStaIfaceHal.connectToNetwork()  ← 不感知 MLO

Supplicant 层：
  sme_send_authentication()                  [sme.c:584-603]
    ├── params.mld = true
    ├── params.mld_link_id = ...
    ├── params.ap_mld_addr = ...
    └── auth_alg 决策（与普通连接相同）

驱动层（QCOM）：
  mlo_connect()                               [wlan_mlo_mgr_sta.c:770]
    ├── mlo_validate_mlo_cap()                [wlan_mlo_mgr_sta.c]
    │     └── wlan_vdev_mlme_is_mlo_vdev()
    ├── mlo_validate_connect_req()            [wlan_mlo_mgr_sta.c]
    ├── 保存 copied_conn_req 副本
    ├── mlo_clear_connected_links_bmap()
    ├── mlo_clear_sta_key_mgmt()
    └── wlan_cm_start_connect()  ← 启动第一条链路
          └── Auth + Assoc（与普通连接完全相同）
                └── mlo_sta_link_connect_notify() 回调
                      └── mlo_send_link_connect()  ← 逐条建立伙伴链路
                            └── wlan_cm_start_connect(partner_vdev)

密钥管理：
  mlo_defer_set_keys(vdev, link_id, true)   ← 延迟安装（链路未就绪时）
  mlo_is_set_key_defered(vdev, link_id)     ← 检查延迟状态
  mlo_defer_set_keys(vdev, link_id, false)  ← 允许安装（链路就绪后）
```

> MLO 对 FWK 层是透明的——`ClientModeImpl` 不感知 MLO，只看到一条连接。所有的多链路管理（链路选择、逐条建立、密钥协调）都在 Supplicant 和驱动层完成。回到酒店比喻——你只在前台办了一次入住（一次 `connect()`），但酒店系统自动帮你开了三间连通房（2.4G + 5G + 6G 三条链路），你不需要知道哪间房在哪个楼层。

**异常路径速览**：MLO 的多链路特性意味着错误不再是「连接失败或成功」的二元问题，而是「部分链路成功、部分链路失败」的灰度场景：

- **MLO 能力验证失败**：`mlo_validate_connect_req()`（`wlan_mlo_mgr_sta.c`）检测到有链路正在连接/漫游/断开时返回 `QDF_STATUS_E_BUSY` → `mlo_connect()` 直接返回错误，不降级为普通连接
- **伙伴链路 Auth/Assoc 失败**：`mlo_send_link_connect()` 为伙伴链路发起连接后，如果某条伙伴链路的 Auth 帧超时或 Assoc Rejected，该链路被标记为失败——其他已建立的链路不受影响，驱动继续在已建立链路上通信
- **密钥延迟安装超时**：`mlo_defer_set_keys(vdev, link_id, true)` 保存密钥后，如果伙伴链路的 BSS peer 在一定时间内未创建，密钥材料被丢弃——主链路仍可正常通信，但该伙伴链路无加密保护

## 7.8 MTK 驱动 MLO 实现——CFG_SUPPORT_802_11BE_MLO

> MTK 驱动通过 `CFG_SUPPORT_802_11BE_MLO` 编译开关提供了完整的 WiFi 7 MLO 支持（`mlo.c` 4868 行）。与 QCOM 的 `mlo_connect()` 集中式入口不同，MTK 将 MLO 能力渗透到现有的 AIS FSM / SAA FSM / AAA FSM 中——MLO 不是独立模块，而是嵌入在 Auth/Assoc/漫游的每个阶段。两家的核心共识一致：MLO 不改变安全协议的认证方式，ML IE 依附在 Auth/Assoc 帧中传输。

**MLO 编译开关**。`CFG_SUPPORT_802_11BE_MLO` 散布在 MTK 驱动的多个文件中——`auth.c`、`saa_fsm.c`、`bss.c`、`roaming_fsm.c`、`aps.c`、`mlo.c`，共 20+ 处条件编译块。这种设计意味着 MLO 不是独立模块，而是渗透到现有连接流程的每个阶段——Auth 帧有 ML IE 验证，SAA FSM 有 MLO 链路建立，BSS 管理有 MLD 地址映射，漫游 FSM 有单链路 MLO 模式支持。

**AIS FSM 层的逐链路遍历——`AIS_STATE_JOIN`**。与 QCOM 的 `mlo_connect()` 集中式入口不同，MTK 将 MLO 多链路建立集成到 AIS FSM 的状态机跳转中。`AIS_STATE_JOIN` 是 Auth/Assoc 的触发点——它遍历所有可用链路，为每条链路独立初始化 STA_RECORD 并触发 SAA FSM 启动 Auth：

```c
// MTK mgmt/ais_fsm.c:3143-3160（源码有部分精简）
case AIS_STATE_JOIN: {
    struct STA_RECORD *prMainStaRec = NULL;

    for (i = 0; i < MLD_LINK_MAX; i++) {
        struct BSS_INFO *bss = aisGetLinkBssInfo(
            prAisFsmInfo, i);

        if (!bss || !aisGetLinkBssDesc(prAisFsmInfo, i))
            continue;
        /* Renew op trx nss */
        cnmOpModeGetTRxNss(prAdapter,
                   bss->ucBssIndex,
                   &bss->ucOpRxNss,
                   &bss->ucOpTxNss);
        aisFsmStateInit_JOIN(prAdapter,
                prAisFsmInfo,
                &prMainStaRec,
                i);  // ← 每条链路独立初始化
    }
    break;
}
```

主要功能：

- **`MLD_LINK_MAX` 遍历**：循环的上限由编译期常量定义（通常 3：2.4G + 5G + 6G），每条链路即使尚未扫描到也保留 slot——这与 QCOM 的 `mlo_connect()` 按需逐条建立的设计思路不同
- **`aisGetLinkBssInfo()`**：按 link index 获取对应链路的 `BSS_INFO`，如果该链路没有有效 BSS（扫描未发现或信道不可用），`continue` 跳过
- **`cnmOpModeGetTRxNss()`**：在启动 Auth 之前更新每条链路的收发空间流数（Nss）——这是 MLO 特有的需求，因为不同频段的天线配置和 MIMO 能力可能不同
- **`prMainStaRec`**：第一条成功初始化的链路 STA_RECORD 被标记为主 STA 记录——后续伙伴链路的 `mldStarecJoin()` 会以此为基础建立 MLD 管理结构

`aisFsmStateInit_JOIN()`（`ais_fsm.c:1315`）为每条链路执行具体的连接初始化——创建 STA_RECORD、同步到固件域、设置 Auth 类型：

```c
// MTK mgmt/ais_fsm.c:1315-1395（源码有部分精简）
void aisFsmStateInit_JOIN(struct ADAPTER *prAdapter,
    struct AIS_FSM_INFO *prAisFsmInfo,
    struct STA_RECORD **prMainStaRec,
    uint8_t ucLinkIndex)
{
    struct BSS_INFO *prBssInfo;
    struct STA_RECORD *prStaRec;
    struct BSS_DESC *prBssDesc;

    prBssDesc = aisGetLinkBssDesc(prAisFsmInfo, ucLinkIndex);
    prBssInfo = aisGetLinkBssInfo(prAisFsmInfo, ucLinkIndex);

    // 1. 标记 BSS 为「正在连接」——防止扫描/漫游干扰
    prBssDesc->fgIsConnecting |= BIT(ucBssIndex);

    // 2. 创建 STA_RECORD——从 BSS Desc 提取 AP 的 MAC、能力、信道
    prStaRec = bssCreateStaRecFromBssDesc(prAdapter,
                        STA_TYPE_LEGACY_AP,
                        ucBssIndex,
                        prBssDesc);

    if (*prMainStaRec == NULL)
        *prMainStaRec = prStaRec;  // 第一条链路 = 主 STA

    // 3. MLO：将新 STA_RECORD 注册到 MLD 管理结构
#if (CFG_SUPPORT_802_11BE_MLO == 1)
    if (mldSingleLink(prAdapter, prStaRec, ucBssIndex)) {
        prBssInfo->ucLinkIndex = prBssDesc->rMlInfo.ucLinkIndex;
        mldStarecJoin(prAdapter, prAisFsmInfo->prMldBssInfo,
            *prMainStaRec, prStaRec, prBssDesc);
    }
#endif

    // 4. 同步 STA 状态到固件域
    if (prStaRec->ucStaState == STA_STATE_1)
        cnmStaRecChangeState(prAdapter, prStaRec, STA_STATE_1);

    // 5. 初始化 Auth 超时状态码——后续 SAA FSM 会在 Auth 成功后覆盖
    prStaRec->u2StatusCode = STATUS_CODE_AUTH_TIMEOUT;
    // ...后续设置 Auth 类型、触发 SAA FSM...
}
```

主要功能：

- **STA_RECORD 逐链路创建**：`bssCreateStaRecFromBssDesc()` 从 BSS 描述符（扫描结果）中提取 AP 的链路 MAC、能力字段、信道号，填充到新的 `STA_RECORD`——每条链路的 `STA_RECORD` 独立管理，但通过 MLD 结构关联
- **mldStarecJoin() 注册**：将新创建的 `STA_RECORD` 链接到 MLD 管理结构中——这是 MTK MLO 架构的核心操作（详见下方代码分析）
- **fgIsConnecting 标记**：防止在连接进行中被扫描结果更新或漫游触发覆盖——相当于 QCOM `mlo_validate_connect_req()` 的忙碌检查

> 至此 `aisFsmStateInit_JOIN()` 完成了每条链路的 STA_RECORD 创建和 MLD 注册。接下来的三个函数构成 MTK MLO 管理的核心三步曲——`mldStarecJoin()` 将 STA 挂载到 MLD 树、`mldUpdatePerLinkMlo()` 将 MLD 参数推送到固件、`mldSanityCheck()` 在 Auth 帧层面验证 ML IE 的有效性。三步环环相扣：注册 → 推送 → 验证，任何一步失败都会阻断该链路的 MLO 激活。

**mldStarecJoin()——STA_RECORD 到 MLD 的链接注册**。这是 MTK MLO 架构中最核心的函数之一——它将每条链路的 `STA_RECORD` 链接到同一个 `MLD_STA_RECORD` 管理结构下，形成「一个 MLD 地址 → 多条链路」的树形关系：

```c
// MTK mgmt/mlo.c:3920-3955（源码有部分精简）
struct MLD_STA_RECORD *mldStarecJoin(struct ADAPTER *prAdapter,
    struct MLD_BSS_INFO *prMldBssInfo,
    struct STA_RECORD *prMainStarec,
    struct STA_RECORD *prStarec,
    struct BSS_DESC *prBssDesc)
{
    struct MLD_STA_RECORD *prMldStaRec = NULL;

    // 主链路：分配新的 MLD_STA_RECORD（MLD 管理结构）
    if (prMainStarec == prStarec)
        prMldStaRec = mldStarecAlloc(prAdapter, prMldBssInfo,
            prBssDesc->rMlInfo.aucMldAddr,
            prBssDesc->rMlInfo.fgMldType,
            prBssDesc->rMlInfo.u2EmlCap,
            prBssDesc->rMlInfo.u2MldCap);
    // 伙伴链路：复用已有的 MLD_STA_RECORD
    else
        prMldStaRec = mldStarecGetByStarec(prAdapter, prMainStarec);

    // 将 STA_RECORD 注册到 MLD_STA_RECORD 的链路链表中
    mldStarecRegister(prAdapter, prMldStaRec, prStarec,
        prBssDesc->rMlInfo.ucLinkIndex);

    return prMldStaRec;
}
```

主要功能：

- **主链路分配 vs 伙伴链路复用**：第一条链路（`prMainStarec == prStarec`）调用 `mldStarecAlloc()` 创建全新的 `MLD_STA_RECORD`，后续伙伴链路通过 `mldStarecGetByStarec()` 复用同一个 MLD 结构——这与 QCOM 的 `copied_conn_req` 副本机制设计思路不同：QCOM 用参数副本在连接发起时统一配置，MTK 用结构体引用在连接过程中动态关联
- **mldStarecRegister()**（`mlo.c:3973`）：核心操作是将 `STA_RECORD` 插入 `MLD_STA_RECORD` 的 `rStarecList` 双向链表，设置 `ucLinkIndex` 和 `aucMldAddr` 字段，更新 `u2ValidLinks` 位图——`BIT(ucLinkId)` 被置位表示该链路已注册
- **u4StaBitmap**：每个 bit 代表一个 `STA_RECORD` 的索引号——用于 O(1) 判断某个 STA 是否已属于该 MLD 结构（`u4StaBitmap & BIT(prStarec->ucIndex)`）

**mldUpdatePerLinkMlo()——逐链路 MLO 信息下发固件**。`mldSetupMlInfo()` 遍历所有已注册的伙伴链路，调用 `mldUpdatePerLinkMlo()` 将每条链路的 MLO 参数推送到固件：

```c
// MTK mgmt/mlo.c:4275-4320（源码有部分精简）
static uint32_t mldUpdatePerLinkMlo(struct ADAPTER *prAdapter,
        struct STA_RECORD *prStaRec)
{
    struct BSS_INFO *prBssInfo;

    prBssInfo = GET_BSS_INFO_BY_INDEX(prAdapter,
                    prStaRec->ucBssIndex);

    // 下发 BSS 级别 MLD 参数到固件（MLD MAC、Link ID、能力）
    if (nicUniCmdSetBssMld(prAdapter, prBssInfo) !=
            WLAN_STATUS_SUCCESS)
        return WLAN_STATUS_FAILURE;

    // 下发 STA 级别 MLD 参数到固件（Peer MLD Addr、Link ID）
    if (nicUniCmdSetStarecMld(prAdapter, prStaRec) !=
            WLAN_STATUS_SUCCESS)
        return WLAN_STATUS_FAILURE;

    return WLAN_STATUS_SUCCESS;
}
```

主要功能：

- **两级下发**：BSS 级参数（`nicUniCmdSetBssMld`）包含 MLD MAC 地址和链路能力——所有关联到此 AP 的 STA 共享；STA 级参数（`nicUniCmdSetStarecMld`）包含 Peer MLD Address 和当前 STA 的 Link ID——每条链路独立下发
- **Unified Command 通道**：`nicUniCmd*` 系列函数通过 MTK 的内部 mailbox 机制与固件通信——与 QCOM 的 WMI（Wireless Module Interface）功能等价，但协议格式不同
- **失败即中断**：任一链路的固件更新失败会导致 `mldSetupMlInfo()` 返回 `-EINVAL`——不同于 QCOM 的「部分链路失败不阻断已建立链路」策略，MTK 的做法更保守：要么全成功，要么全失败

> **MTK MLO 的设计哲学至此已经清晰**：通过 `MLD_STA_RECORD` 树形结构将多条链路的 `STA_RECORD` 关联到一个 MLD 地址下——每条链路独立管理（独立的 BSS_INFO、独立的 Auth/Assoc 流程），但通过 `u2ValidLinks` 位图和 `mldStarecRegister()` 统一协调。AIS FSM 在 `AIS_STATE_JOIN` 中按 `MLD_LINK_MAX` 循环触发各链路独立进入 SAA FSM 的 Auth 流程，这与 QCOM 的 `mlo_connect()` → `mlo_send_link_connect()` 逐条回调机制殊途同归。主要的架构差异在于：QCOM 将 MLO 逻辑集中到 `mlo_mgr` 模块（~2000 行），通过显式 API（`mlo_defer_set_keys`）管理密钥延迟安装；MTK 将 MLO 作为协议增强特性（feature flag）渗透到现有 FSM 中（`mlo.c` 4868 行 + AIS/SAA/AAA/Roaming FSM 各加 MLO 条件分支）。下文继续看 Auth 帧验证和 SAA 关联这两个具体环节。

**Auth 帧的 MLO IE 验证**。在 `auth.c` 的两处关键位置（SAA FSM 的 Auth 响应处理 line 623 和 AAA FSM 的 Auth 请求处理 line 1282），`mldSanityCheck()` 验证 Auth 帧中的 ML IE 是否有效：

```c
// MTK mgmt/auth.c:623-630（SAA FSM，源码有部分精简）
#if (CFG_SUPPORT_802_11BE_MLO == 1)
    if (!mldSanityCheck(prAdapter, prSwRfb->pvHeader,
        prSwRfb->u2PacketLen, prStaRec, prStaRec->ucBssIndex)) {
        DBGLOG(SAA, WARN, "Discard Auth frame with wrong ML IE\n");
        *pu2StatusCode = STATUS_CODE_DENIED_EHT_NOT_SUPPORTED;
        return WLAN_STATUS_FAILURE;
    }
#endif
```

主要功能：

- **SAA FSM 侧（line 623）**：处理已连接 STA 的重认证帧——防止攻击者发送伪造的 ML IE 破坏已有连接
- **AAA FSM 侧（line 1282）**：处理新 STA 的首次认证帧——如果 ML IE 格式错误或包含不支持的功能，直接返回 `STATUS_CODE_DENIED_EHT_NOT_SUPPORTED`
- **MLO 能力上报**：MTK 通过 vendor command 向 wpa_supplicant 报告芯片 MLO 硬件能力——最大 MLO 关联链路数（`WIFI_ATTRIBUTE_CHIP_CAPABILITIES_RESP_MAX_MLO_ASSOCIATION_LINK_COUNT`）和最大 STR 链路数（`WIFI_ATTRIBUTE_CHIP_CAPABILITIES_RESP_MAX_MLO_STR_LINK_COUNT`）（`mtk_vendor_cmd.h:204-205`）

**SAA FSM 层的 MLO 链路建立**——Assoc 帧接收后，在 SAA FSM 的状态转换中完成 MLO 信息解析和链路注册：

```c
// MTK mgmt/saa_fsm.c:474-478（SAA FSM，源码有部分精简）
#if (CFG_SUPPORT_802_11BE_MLO == 1)
    mldStarecSetSetupIdx(prAdapter, prStaRec);   // 为 STA 记录分配 MLO setup index
    // ... 其他 MLO 相关设置 ...
    mldSetupMlInfo(prAdapter, prStaRec);          // 解析 Assoc 帧中的 Basic ML Element
#endif
```

主要功能：

- **`mldStarecSetSetupIdx()`**（`mlo.c:4181`）：从 STA 记录的 MAC 地址和关联信息中提取 MLO setup index，用于后续的 partner link 索引
- **`mldSetupMlInfo()`**（`mlo.c:4333`）：解析 Assoc Response 帧中的 Basic ML Element——提取伙伴链路 ID、BSSID、信道等参数，建立 `MLD_BSS_INFO` 结构体——这是后续密钥分发和 Roaming 的基础

**MTK MLO 核心函数速查**：

| 函数                       | 位置         | 作用                                                   |
| -------------------------- | ------------ | ------------------------------------------------------ |
| `mldSanityCheck()`         | `mlo.c:19`   | 验证 Auth/Assoc 帧中 ML IE 的有效性                    |
| `mldFindMlIE()`            | `mlo.c:2365` | 从 IE 列表中定位 Multi-Link IE（按 Control Type 过滤） |
| `mldParseBasicMlIE()`      | `mlo.c:1430` | 解析 Basic ML Element（链路 ID、BSSID、信道、能力）    |
| `mldGenerateMlIE()`        | `mlo.c:293`  | 生成 Multi-Link IE（Beacon/Probe Response 用）         |
| `mldGenerateAssocIE()`     | `mlo.c:304`  | 生成 Assoc 帧中的 ML IE                                |
| `mldStarecSetSetupIdx()`   | `mlo.c:4181` | 分配 MLO setup index 给 STA 记录                       |
| `mldSetupMlInfo()`         | `mlo.c:4333` | 建立 MLD 伙伴链路信息（MLD_BSS_INFO）                  |
| `mldIsSingleLinkEnabled()` | `mlo.c`      | 检查是否为 MLO 单链路模式（用于漫游决策）              |
| `mldCalculateMlIELen()`    | `mlo.c:212`  | 计算 ML IE 的总长度（用于 Beacon 帧构建）              |
| `mldBssGetByBss()`         | `mlo.c`      | 通过 BSS 描述符查找对应的 MLD BSS 信息                 |
| `mldGetBssInfoByLinkID()`  | `mlo.c`      | 通过 Link ID 反向查找 BSS 信息（用于 TWT 和密钥分发）  |

**Roaming FSM 中的 MLO 支持**。漫游场景对 MLO 的处理比首次连接更复杂——需要在移动过程中更新 MLD 地址：

```c
// MTK mgmt/roaming_fsm.c:179-259（源码有部分精简）
#if (CFG_SUPPORT_802_11BE_MLO == 1)
    if (mldIsSingleLinkEnabled(prAdapter, NETWORK_TYPE_AIS,
                               ucBssIndex)) {
        struct MLD_BSS_INFO *mld_bssinfo;
        // ... 构造 ML IE ...
        BE_SET_ML_CTRL_TYPE(common->u2Ctrl, ML_CTRL_TYPE_BASIC);
        mld_bssinfo = mldBssGetByBss(prAdapter, prBssInfo);
        COPY_MAC_ADDR(pos, mld_bssinfo->aucOwnMldAddr);
    }
#endif
```

主要功能：

- **单链路 MLO 模式**：`mldIsSingleLinkEnabled()` 检查当前连接是否为「MLO 能力激活但只用一条链路」——这在漫游切换阶段很常见（新链路建立前暂用单链路）
- **MLD 地址更新**：漫游到新 AP 后，通过 `mldBssGetByBss()` 查找新 AP 的 MLD 地址，覆盖旧的 MLD 地址

**MTK WiFi7 连接的完整入口和流程**。与 QCOM 的 `mlo_connect()` 集中式入口不同，MTK 没有独立的 MLO 连接入口函数——MLO 能力通过 `CFG_SUPPORT_802_11BE_MLO` 编译开关渗透到现有的 AIS FSM / SAA FSM / AAA FSM 中。连接流程如下：

```
1. AIS FSM 初始化（aisAllocBssInfo）：
   每条链路分配独立的 BSS_INFO，MLO 场景下调用 mldBssRegister()
   注册到 MLD BSS 管理结构

2. AIS FSM 触发连接（aisFsmRunEventScanDone → AIS_STATE_SEARCH）：
   扫描完成后选择目标 BSS（含 ML IE 的 BSS 优先）
   → AIS_STATE_REQ_CHANNEL_JOIN：请求信道资源
   → AIS_STATE_JOIN：进入 Auth/Assoc 阶段

3. AIS_STATE_JOIN 中的 MLO 处理（ais_fsm.c:3143）：
   遍历 MLD_LINK_MAX 条链路，为每条链路调用 aisFsmStateInit_JOIN()
   → 初始化 STA_RECORD（含链路 MAC、信道、能力）
   → 触发 SAA FSM 启动 Auth

4. SAA FSM 启动（saaFsmRunEventStart，saa_fsm.c:458）：
   → mldStarecSetSetupIdx()：分配 MLO setup index
   → mldSetupMlInfo()：解析 ML IE，建立伙伴链路信息
   → SAA_STATE_SEND_AUTH1 / SAA_STATE_EXTERNAL_AUTH（SAE）

5. Auth/Assoc 完成后：
   → AAA FSM 处理 Assoc Response 中的 ML IE
   → mldSanityCheck() 验证 ML IE 有效性
   → 伙伴链路的 BSS_INFO 通过 mldBssRegister() 关联到 MLD
```

**MTK vs QCOM 连接流程对照**：

| 阶段           | QCOM                                                        | MTK                                                          |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| **入口**       | `mlo_connect()` → `wlan_cm_start_connect()`                 | `aisFsmSteps(AIS_STATE_JOIN)` → 遍历 MLD_LINK_MAX 链路       |
| **BSS 分配**   | `mlo_connect()` 内 `copied_conn_req` 副本                   | `aisAllocBssInfo()` per-link 分配 + `mldBssRegister()`       |
| **Auth 触发**  | `wlan_cm_start_connect()` → 驱动内部 SME                    | `aisFsmStateInit_JOIN()` → `saaFsmRunEventStart()`           |
| **ML IE 解析** | `wlan_mlo_mgr_sta.c` 独立模块                               | `mldSetupMlInfo()`（saa_fsm.c:478）+ `mldSanityCheck()`（auth.c） |
| **伙伴链路**   | `mlo_sta_link_connect_notify()` → `mlo_send_link_connect()` | AIS FSM 遍历 MLD_LINK_MAX，每条链路独立走 SAA FSM            |
| **密钥管理**   | `mlo_defer_set_keys()` 显式 API                             | FSM 状态同步（驱动内部协调）                                 |

**QCOM vs MTK MLO 架构对比**：

| 维度         | QCOM                                      | MTK                                         |
| ------------ | ----------------------------------------- | ------------------------------------------- |
| 入口函数     | `mlo_connect()` 集中式入口                | 无集中入口，集成到 AIS/SAA/AAA FSM          |
| 连接请求副本 | `copied_conn_req` 显式副本                | FSM 内直接覆盖参数                          |
| ML IE 处理   | `wlan_mlo_mgr_sta.c` 独立模块（2000+ 行） | `mlo.c` (4868 行) + auth/saa/roaming 分散   |
| 链路建立触发 | `mlo_sta_link_connect_notify()` 回调      | SAA FSM state transition（saa_fsm.c 内嵌）  |
| 密钥延迟安装 | `mlo_defer_set_keys()` 显式 API           | 通过 FSM 状态同步（驱动内部协调）           |
| 能力上报     | 驱动内部（不对外暴露）                    | Vendor cmd 上报 HAL：link count + STR count |
| 设计哲学     | 集中式 MLO Manager（`mlo_mgr`）           | 将 MLO 作为协议的增强特性（feature flag）   |

两种设计各有利弊：QCOM 的集中式入口适合快速理解和调试（所有 MLO 逻辑在一个模块），但需要在现有 FSM 的每个阶段都插入 `mlo_connect()` 的调用点。MTK 的分散式集成适合代码复用和渐进式演进（每个 FSM 只增加自己关心的 MLO 逻辑），但需要维护 `CFG_SUPPORT_802_11BE_MLO` 在 20+ 处的一致性。

> 无论 QCOM 还是 MTK，MLO 对安全协议是透明的——SAE/WPA2/EAP 的认证决策流程与普通连接**完全相同**。ML IE 依附在 Auth/Assoc 帧中传输，wpa_supplicant 通过 standard nl80211 attributes（`NL80211_ATTR_MLD_ADDR`、`NL80211_ATTR_MLO_LINK_ID`）传递 MLD 地址和 link ID。MLO 带来的复杂度在驱动层，不在安全协议层。

---

# 8 完整对比总结——六种认证方式的代码级差异一览

## 8.1 核心对比表

| 维度              | Open                             | OWE                                               | WPA2-PSK                  | SAE (WPA3)                  | EAP-TLS                                     | EAP-SIM                                                 |
| ----------------- | -------------------------------- | ------------------------------------------------- | ------------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| **Auth 帧数**     | 2                                | 2                                                 | 2                         | 4 (Dragonfly)               | 2                                           | 2                                                       |
| **`auth_alg`**    | `OPEN`                           | `OPEN`                                            | `OPEN`                    | `SAE`                       | `OPEN`                                      | `OPEN`                                                  |
| **PMK 协商时机**  | 无 PMK                           | Assoc 阶段 (DH)                                   | 本地派生 (PBKDF2)         | Auth 阶段 (Dragonfly)       | EAPOL 阶段 (RADIUS)                         | EAPOL 阶段 (HLR/AuC)                                    |
| **PMK 协商方式**  | —                                | ECDH                                              | PBKDF2(PSK, SSID)         | ECC Dragonfly               | TLS 证书 + RADIUS                           | GSM triplet + RADIUS                                    |
| **四次握手**      | 无                               | 标准 4 帧                                         | 标准 4 帧                 | 标准 4 帧                   | 标准 4 帧                                   | 标准 4 帧                                               |
| **NL80211 命令**  | `CMD_CONNECT`                    | `CMD_CONNECT`                                     | `CMD_CONNECT`             | `CMD_AUTH`+`CMD_ASSOC`      | `CMD_CONNECT`                               | `CMD_CONNECT`                                           |
| **驱动处理 Auth** | 驱动内部                         | 驱动内部                                          | 驱动内部                  | 驱动转发给 supplicant       | 驱动内部                                    | 驱动内部                                                |
| **代码入口**      | `sme_send_authentication` (默认) | `sme_send_authentication` + `owe_build_assoc_req` | `sme_send_authentication` | `sme_auth_build_sae_commit` | `sme_send_authentication` + `eapol_sm_step` | `sme_send_authentication` + `eap_sim_process_challenge` |
| **对用户可见**    | 无密码                           | 无密码（透明）                                    | 需密码                    | 需密码                      | 需证书/凭证                                 | 需 SIM 卡                                               |
| **离线破解**      | —                                | 有 PFS                                            | 可能                      | 不可能                      | 做不到                                      | 做不到（Ki 不出卡）                                     |

> **NL80211 命令脚注**：表格中 Open/OWE/WPA2-PSK/EAP-TLS 标记为 `CMD_CONNECT`，SAE 标记为 `CMD_AUTHENTICATE+CMD_ASSOCIATE`，但实际选择取决于 **`WPA_DRIVER_FLAGS_SME`** 标志而非协议类型本身。当驱动设置 `WPA_DRIVER_FLAGS_SME` 时（表示驱动内部有完整的 SME 实现，如 QCOM），wpa_supplicant 可以将认证/关联委托给驱动，用 `CMD_CONNECT` 一条命令完成；当驱动不设置此标志时（表示驱动只负责帧收发，认证决策由 supplicant 做），wpa_supplicant 必须亲自走 `CMD_AUTHENTICATE + CMD_ASSOCIATE` 两步。SAE 在表格中写 `CMD_AUTHENTICATE+CMD_ASSOCIATE`，是因为 SAE 的 Dragonfly 握手需要 ECC 密码学运算——驱动固件通常不包含完整的椭圆曲线库，必须由 wpa_supplicant 亲自控制每帧，所以必然走两步命令路径。其他协议如果驱动支持 SME，则可以用 `CMD_CONNECT` 一次性委托。

## 8.2 分叉点速查

从 `sme_send_authentication()` 出发，六种协议的代码级分叉一览：

| 协议         | 分叉条件（代码位置）                                         | 分叉后的唯一动作                                             |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Open**     | `key_mgmt = WPA_KEY_MGMT_NONE` → 走 `wpa_supplicant_set_non_wpa_policy()` 分支（line 770） | Auth/Assoc 后直接 `WPA_COMPLETED`，跳过四次握手              |
| **OWE**      | `key_mgmt` 含 `WPA_KEY_MGMT_OWE`，`auth_alg` 保持 `OPEN`     | Assoc 阶段 `owe_build_assoc_req()` 添加 DH IE，`owe_process_assoc_resp()` 派生 PMK |
| **WPA2-PSK** | `key_mgmt` 含 `WPA_KEY_MGMT_PSK`，`auth_alg` 保持 `OPEN`     | Assoc 后四次握手，PMK = PBKDF2(PSK, SSID) 本地计算           |
| **SAE**      | `wpa_key_mgmt_sae(ssid->key_mgmt)` 为真 + AP RSNE 广播 SAE AKM → `params.auth_alg = WPA_AUTH_ALG_SAE`（line 666） | 构建 SAE Commit/Confirm 帧（line 1041-1049），PMK 在线协商   |
| **EAP-TLS**  | `key_mgmt` 含 `WPA_KEY_MGMT_IEEE8021X` + EAP method = TLS，`auth_alg` 保持 `OPEN` | Assoc 后 `eapol_sm_step()` 启动 EAPOL，TLS 证书认证，PMK 从 RADIUS 下发 |
| **EAP-SIM**  | `key_mgmt` 含 `WPA_KEY_MGMT_IEEE8021X` + EAP method = SIM，`auth_alg` 保持 `OPEN` | Assoc 后 `eapol_sm_step()` 启动 EAPOL，GSM triplet 挑战，PMK 从 HLR/AuC 下发 |

## 8.3 关键函数速查

| 函数                              | 文件                              | 作用                                                         |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `sme_send_authentication()`       | `wpa_supplicant/sme.c`            | 认证方式选择枢纽——根据 key_mgmt 设置 auth_alg                |
| `sme_auth_build_sae_commit()`     | `wpa_supplicant/sme.c`            | 构建 SAE Commit 帧（Dragonfly 第一帧）                       |
| `sme_auth_build_sae_confirm()`    | `wpa_supplicant/sme.c`            | 构建 SAE Confirm 帧（Dragonfly 第三帧）                      |
| `sae_prepare_commit()`            | `src/common/sae.c`                | HnP 模式 PWE 计算                                            |
| `sae_prepare_commit_pt()`         | `src/common/sae.c`                | H2E 模式 PWE 计算（WPA3 标准）                               |
| `sae_write_commit()`              | `src/common/sae.c`                | 序列化 Commit（Scalar + Element）                            |
| `sae_write_confirm()`             | `src/common/sae.c`                | 序列化 Confirm（HMAC）                                       |
| `owe_build_assoc_req()`           | `src/rsn_supp/wpa.c`              | 构建 OWE DH Parameter IE（Assoc Request）                    |
| `owe_process_assoc_resp()`        | `src/rsn_supp/wpa.c`              | 处理 OWE Assoc Response → DH 共享密钥 → PMK                  |
| `eapol_sm_step()`                 | `src/eapol_supp/eapol_supp_sm.c`  | EAPOL 四子状态机主循环                                       |
| `eap_peer_sm_step()`              | `src/eap_peer/eap.c`              | EAP Peer 状态机                                              |
| `eap_sim_process()`               | `src/eap_peer/eap_sim.c`          | EAP-SIM 主分发——按 subtype 路由到 Start/Challenge/Notification |
| `eap_sim_process_challenge()`     | `src/eap_peer/eap_sim.c`          | EAP-SIM Challenge 处理——GSM A3/A8 运算 + 密钥派生            |
| `eap_sim_derive_mk()`             | `src/eap_common/eap_sim_common.c` | EAP-SIM MK 派生——SHA1(ID \|\| Kc×N \|\| NONCE_MT \|\| Ver)   |
| `eap_sim_derive_keys()`           | `src/eap_common/eap_sim_common.c` | 会话密钥派生——FIPS 186-2 PRF(MK) → K_encr/K_aut/MSK/EMSK     |
| `eap_sim_db_get_gsm_triplets()`   | `src/eap_server/eap_sim_db.c`     | 从 HLR/AuC 获取 GSM triplet（RAND/SRES/Kc）（[server 端] hostapd/RADIUS 侧，非 STA 侧） |
| `radius_msg_add_eap()`            | `src/radius/radius.c`             | EAP 消息封装到 RADIUS EAP-Message 属性                       |
| `radius_msg_get_eap()`            | `src/radius/radius.c`             | 从 RADIUS EAP-Message 属性提取 EAP 消息                      |
| `radius_msg_get_ms_keys()`        | `src/radius/radius.c`             | 从 Access-Accept 解析 MS-MPPE 密钥（PMK）                    |
| `wpa_supplicant_set_state()`      | `wpa_supplicant/wpa_supplicant.c` | 连接状态变更——Open 网络从此跳过四次握手                      |
| `mlo_connect()`                   | QCOM `wlan_mlo_mgr_sta.c`         | MLO 连接入口                                                 |
| `mlo_defer_set_keys()`            | QCOM `wlan_mlo_mgr_sta.c`         | 延迟密钥安装（链路未完全建立时）                             |
| `mldSanityCheck()`                | MTK `mgmt/mlo.c:19`               | MTK MLO Auth/Assoc 帧 ML IE 有效性验证                       |
| `mldSetupMlInfo()`                | MTK `mgmt/mlo.c:4333`             | MTK MLO 伙伴链路信息建立                                     |
| `mldStarecSetSetupIdx()`          | MTK `mgmt/mlo.c:4181`             | MTK MLO setup index 分配                                     |
| `authCheckRxAuthFrameStatus()`    | MTK `mgmt/auth.c:574`             | MTK Auth 帧验证——SAE 序列号特殊检查                          |
| `saaFsmSteps()`                   | MTK `mgmt/saa_fsm.c:85`           | MTK SAA FSM 状态推进——SAE 走 EXTERNAL_AUTH                   |
| `lim_process_auth_frame()`        | QCOM `lim_process_auth_frame.c`   | QCOM Auth 帧分发——SAE 帧在此转发给 wpa_supplicant            |
| `lim_process_sae_auth_frame()`    | QCOM `lim_process_auth_frame.c`   | QCOM SAE 帧检测与转发（主路径）                              |
| `lim_process_sae_preauth_frame()` | QCOM `lim_process_auth_frame.c`   | QCOM SAE 漫游预认证帧转发（line 2142，无 session 场景）      |

## 8.4 六个核心认知

- **`WPA_AUTH_ALG_OPEN` 是默认路径，但不是简单路径**：六种协议中的五种（open/OWE/WPA2-PSK/EAP-TLS/EAP-SIM）都从 `OPEN` 出发，但它们的分叉点在 Assoc 阶段和 EAPOL 阶段——不能因为 Auth 帧相同就认为后续路径相同。
- **SAE 是唯一在 Auth 阶段改变 `auth_alg` 的协议**：`params.auth_alg = WPA_AUTH_ALG_SAE`（line 666）意味着驱动收到的 Auth 帧 Algorithm Number = 3，驱动不会自己处理这个帧——它必须转发给 wpa_supplicant 完成 Dragonfly 握手的密码学运算。**MTK 和 QCOM 对 SAE 的实现共识验证了这一点**——两家的驱动都不接触 SAE 帧的密码学内容（PWE、Scalar、Element、HMAC），全部转发给用户空间。
- **OWE 的「加密但不认证」是设计选择，不是缺陷**：RFC 8110 明确将 OWE 定位为 Opportunistic Encryption——宁可没有身份验证的加密，也不能完全没有加密。
- **EAP-TLS 和 EAP-SIM 不是「更安全的 PSK」，而是完全不同的认证框架**：两者共享同一个 Auth/Assoc 路径（`WPA_AUTH_ALG_OPEN`），但 EAP-TLS 走证书信任链、EAP-SIM 走 GSM 对称密钥——同一个 `sme_send_authentication()` 出口，同一个 `eapol_sm_step()` 入口，但 `eap_peer_sm_step()` 内部的路由让它们走向完全不同的认证后端。
- **MLO 对 FWK 是透明的，但驱动层有完整的多链路管理**：QCOM 用集中式 `mlo_connect()`、MTK 用分散式 FSM 集成——两种架构设计殊途同归。
- **MTK 驱动拥有与 QCOM 对等的 SAE 和 MLO 能力**：SAE 通过 `SAA_STATE_EXTERNAL_AUTH` 集成到 SAA FSM，MLO 通过 `CFG_SUPPORT_802_11BE_MLO` 渗透到 Auth/Assoc/Roaming——不是「MTK 没有 WiFi 7 逻辑」，而是「MTK 的 WiFi 7 逻辑以不同的架构形态存在」。

---

回到酒店比喻，六种认证方式就是六种不同的入住流程：

- **Open** 是无人值守的大堂——你推门即入，不需要在前台办任何手续。系统知道有人进来了（Assoc 完成），但没有任何身份核对。RSN 关闭，加密关闭，数据在空中明文传输。
- **OWE** 像是大堂虽然开放，但你入座后说的每句话都是悄悄话。没有门禁的身份验证（Auth = Open），但你一坐下就开始用 DH 加密——窃听者只能看到有人在说话，听不到内容。选择性加密，有加密无认证。
- **WPA2-PSK** 是标准的「报密码入住」——你在前台报出密码（PSK），前台在本地系统里查一下（PBKDF2 → PMK），然后给你房卡（四次握手）。流程简单快捷，但密码一旦泄露，攻击者可以离线破解——只需要在附近抓一次四次握手包。
- **SAE** 是加密对讲机——你不直接说出密码，而是和前台通过数学方法确认彼此都知道同一个秘密。不需要实际传输密码就能完成验证（Dragonfly），攻击者即使全程监听也猜不出密码（因为每次交互的 PWE 都不同）。唯一的代价是多交换两帧 Auth。
- **EAP-TLS** 是 VIP 证件通道——前台不直接验证你，而是把你的证件传给总部（RADIUS）。总部的证件审核系统用证书链验证你的身份，确认后给前台下发一张临时通行证（PMK），前台再通过四次握手把房卡给你（PTK）。
- **EAP-SIM** 是手机身份证入住——前台不核实你的脸，而是读取你手机 SIM 卡里的电子身份证号（IMSI），把它传给电信运营商总部（HLR/AuC）。总部发来一串随机验证码（RAND），你的 SIM 卡芯片用出厂时烧录的密钥（Ki）在芯片内部算出正确答案（SRES）并回传。全程 Ki 从未离开 SIM 卡，也不在网络传输——就像你刷身份证进门，身份证里的芯片自己验证了真伪，但从不把里面的密钥告诉任何人。

选择哪种入住流程，取决于你对安全的需求。从无人值守的大堂到 VIP 证件通道，WiFi 的安全设计给你提供了完整的梯度——代码里那个 `auth_alg` 变量，就是这个梯度的开关。

---

本篇覆盖了 Auth 阶段的六种安全协议分叉和 MLO 多链路连接。连接完成后，STA 还需要获取 IP 地址、通过 Captive Portal 检测、切换默认路由——这些连接后管理逻辑在连接后管理中展开。

**规范参考**：

- IEEE 802.11-2024：§12.4.3（SAE）、§12.7.1.2（PTK 派生）、§12.7（EAP/四次握手/PMKSA）、§12.8（OWE）、§35.3（MLO）
- RFC 4186：EAP-SIM（GSM Subscriber Identity Module Authentication）
- RFC 3579：RADIUS Support for EAP（EAP-over-RADIUS 封装）
- RFC 2548：Microsoft Vendor-Specific RADIUS Attributes（MS-MPPE 密钥下发）

**源码出处**：[external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8/)、QCOM [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0)、[packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi/)。
