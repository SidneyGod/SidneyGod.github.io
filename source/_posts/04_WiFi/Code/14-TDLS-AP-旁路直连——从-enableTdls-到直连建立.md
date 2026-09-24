---
title: TDLS AP 旁路直连——从 enableTdls 到直连建立
top: 1
related_posts: true
abbrlink: 518171b2
date: 2026-09-24 23:31:35
tags:
  - Android WiFi
  - TDLS
categories:
  - WiFi
  - Code
---

> 你和同事工位就隔一面墙，传个文件却要先送到公司前台、再由前台转过去。手机上那条「TDLS」选项背后，一整套「登记工单 → 双方签合同 → 施工队拉线」的流程是怎么在代码里跑起来的？本文追踪一次 TDLS 直连建立：从 Framework 的 `enableTdls` 入口，到 supplicant 里 `src/rsn_supp/tdls.c` 那台 TPK 握手状态机，再到 QCOM 固件卸载与 MTK 主机组帧两条施工队，跨过 Java Framework、supplicant C、驱动 C 三个代码世界。

---

# 本章导读

另一个协议系列讲过了——为什么同一 AP 下的两台设备值得建直连（省一跳、提速、减 AP 负载）、「隧道」二字的由来（建立信令封装成普通数据帧借道 AP）、Discovery 与 Setup 三帧握手、TPK（TDLS PeerKey）密钥协商、信道切换与省电。**本篇不重讲协议，只做一件事：把每个协议概念映射到 Android 源码里的具体实现**，并回答那个协议篇回答不了的问题——**这套东西在代码里到底是谁在跑、怎么分工的**。

<!--more-->

一句话概括本文主线：一次 TDLS 直连建立 = **Framework `enableTdls` 薄透传 + 记账 → supplicant `tdls.c` 状态机跑 Discovery → Setup 三帧 TPK 握手（M1/M2/M3）→ 驱动两条路（QCOM 固件卸载 / MTK 主机组帧）→ `TDLS_ENABLE_LINK` 启用直连**。

在动手前，先记住一个贯穿全文的三层分工，它决定了后面每一段代码长什么样：

| 层                     | 角色                          | 代码事实                                                     |
| ---------------------- | ----------------------------- | ------------------------------------------------------------ |
| **Framework（薄）**    | 轻量透传 + 单点记账           | `WifiManager` → `WifiServiceImpl`（IP→MAC 读 `/proc/net/arp`）→ `ConcreteClientModeManager` → `ClientModeImpl`（`canEnableTdls` + `mEnabledTdlsPeers` + 并发上限）→ `WifiNative.startTdls` |
| **supplicant（主角）** | TPK 握手状态机 + 三帧握手     | ⚠️ 核心不在 `wpa_supplicant/tdls.c`（该文件不存在，旧版资料里常见的路径是错的），而在 `src/rsn_supp/tdls.c`（约 3300 行） |
| **驱动（两条施工队）** | QCOM 固件卸载 vs MTK 主机组帧 | QCOM 主机只做 cfg80211 桥接 + 状态镜像 + WMI 下发；MTK 主机手动组 TDLS action 帧、跑状态机、装 TPK 密钥 |

**本文只讲直连建立的主干**。① **TDLS 省电（TPU / peer PSM）不展开**，offchannel 信道切换只点到为止（见 §2.6）；② **EAP 不涉及**——TDLS 用的是 TPK 直连密钥，不是 EAP 认证，安全细节见本系列《STA 连接 — 安全协议分支与 WiFi 7 MLO》；③ **TDLS vs P2P 的取舍**（何时用哪个）协议篇已讲，本篇只落到代码上。

先看这张全链路分层图，理解一次 TDLS 直连要跨越的每一层和跨进程边界：

![TDLS 直连建立全链路分层架构](assets/14-TDLS-AP-%E6%97%81%E8%B7%AF%E7%9B%B4%E8%BF%9E%E2%80%94%E2%80%94%E4%BB%8E-enableTdls-%E5%88%B0%E7%9B%B4%E8%BF%9E%E5%BB%BA%E7%AB%8B/14-tdls-architecture.svg)

---

# 1 一条 TDLS 直连从哪点进来？——Framework 的薄透传与记账

> Framework 这层没有任何「TDLS 引擎」，它就是一个前台接待：登记工单、查一眼额度、然后派下去。真正干活的在下一层。

先回答最靠前的问题：**用户（或 App）在哪儿触发 TDLS？** 协议层没有「用户点一个按钮」这一步——TDLS 不是 WiFi 开关那样的大动作，它是**针对某一条「到某个对端」的链路**开/关。所以入口 API 带的是一个**对端地址**，而不是一个布尔开关。不过最近的项目里，有注意到 QCOM 在驱动里实现实现了局域网中数据交互比较频繁会自动拉起一个TDLS链接，实际上TDLS是能提升点吞吐的，有个BeToCQ的测试项的吞吐就依赖这个。

## 1.1 入口：`setTdlsEnabled` 与「IP 还是 MAC」的分岔

`WifiManager` 层给了两条入口，区别只在**传 IP 还是传 MAC**：

```java
// framework/java/android/net/wifi/WifiManager.java:6455
/**
 * Enable/Disable TDLS on a specific local route.
 * ...
 * @param remoteIPAddress IP address of the endpoint to setup TDLS with
 * @param enable true = setup and false = tear down TDLS
 */
public void setTdlsEnabled(InetAddress remoteIPAddress, boolean enable) {
    try {
        mService.enableTdls(remoteIPAddress.getHostAddress(), enable);
    } catch (RemoteException e) {
        throw e.rethrowFromSystemServer();
    }
}
```

- **`setTdlsEnabled(InetAddress, boolean)`**：老接口，传 IP，异步、无回执。内部走 `mService.enableTdls(ip, enable)`。
- **`setTdlsEnabledWithMacAddress(String, boolean)`**：传 MAC，跳过 IP 解析那一步。
- 能力探针 `isTdlsSupported()` / `isOffChannelTdlsSupported()` 分别对应 feature bit `WIFI_FEATURE_TDLS`（=12）和 `WIFI_FEATURE_TDLS_OFFCHANNEL`（=13）。

这里有个设计点值得先记住：**TDLS 的开/关是「逐对端」的**——不是「全局开一个 TDLS 开关」，而是「我和这台设备之间要不要建直连」。这决定了后面 Framework 的记账粒度是「一组对端 MAC」，也决定了 supplicant 的状态机是「每个对端一个 `wpa_tdls_peer`」。

## 1.2 IP 换 MAC：为什么必须读 `/proc/net/arp`

`WifiServiceImpl.enableTdls` 收到的是 IP，但整条链路往下——supplicant、驱动——只认 MAC。于是第一步翻译就发生在 Framework 层，手段是**读 ARP 表**：

```java
// service/java/com/android/server/wifi/WifiServiceImpl.java:5392
private class TdlsTask extends AsyncTask<TdlsTaskParams, Integer, Integer> {
    @Override
    protected Integer doInBackground(TdlsTaskParams... params) {
        TdlsTaskParams param = params[0];
        String remoteIpAddress = param.mRemoteIpAddress.trim();
        boolean enable = param.mEnable;
        String macAddress = null;

        try (BufferedReader reader = new BufferedReader(new FileReader("/proc/net/arp"))) {
            reader.readLine();               // 跳过表头
            String line;
            while ((line = reader.readLine()) != null) {
                String[] tokens = line.split("[ ]+");
                if (tokens.length < 6) continue;
                // ARP 列格式：Address HWType HWAddress Flags Mask IFace
                String ip = tokens[0];
                String mac = tokens[3];
                if (TextUtils.equals(remoteIpAddress, ip)) {
                    macAddress = mac;
                    break;
                }
            }
            if (macAddress == null) {
                Log.w(TAG, "Did not find remoteAddress {" + remoteIpAddress
                        + "} in /proc/net/arp");
            } else {
                enableTdlsWithMacAddress(macAddress, enable);
            }
        } catch (FileNotFoundException e) { ... }
        catch (IOException e) { ... }
        return 0;
    }
}
```

- **`TdlsTask` 是 `AsyncTask`**：读文件是 IO，不能在 Binder 线程上同步做，所以老接口干脆甩到一个后台任务里。这是「薄透传」的第一个证据——连 IP 换 MAC 都嫌重，要开线程。
- **数据源 `/proc/net/arp`**：内核的 ARP 邻居表，IP→MAC 的权威来源。对端 IP 必须已经出现在本机 ARP 表里（也就是最近刚通信过），否则查不到、静默失败（`Log.w` 之后什么都不做）。
- **翻译逻辑**：`tokens[0]` 是 IP、`tokens[3]` 是 MAC，逐行比对，命中即 `break`。

新接口 `enableTdlsWithRemoteIpAddress` 则换了个更现代的实现——把翻译挪到 `ClientModeImpl` 里，用注入的 `BufferedReader`（可测试），逻辑一模一样：

```java
// service/java/com/android/server/wifi/ClientModeImpl.java:4270
private String macAddressFromRoute(String ipAddress) {
    ...
    reader = mWifiInjector.createBufferedReader(ARP_TABLE_PATH);
    reader.readLine();                          // 跳过表头
    while ((line = reader.readLine()) != null) {
        String[] tokens = line.split("[ ]+");
        if (tokens.length < 6) continue;
        String ip = tokens[0];
        String mac = tokens[3];
        if (TextUtils.equals(ipAddress, ip)) { macAddress = mac; break; }
    }
    ...
}
```

> 如果你在想「为什么不直接让 App 传 MAC？」——答案是老接口已经用 IP 定义了，且 App 层通常只握有对端的 IP（对端在同一个局域网里，IP 是它知道的东西）。所以翻译这一步躲不掉，只能在 Framework 里做。传 MAC 的新接口（`setTdlsEnabledWithMacAddress`）就是为「我已经知道 MAC」的调用者省掉这一步。

## 1.3 记账：`canEnableTdls` 与 `mEnabledTdlsPeers`

翻译完 MAC，请求落到 `ClientModeImpl`（ClientMode 状态机）。这里出现 TDLS 在 Framework 层唯一的「状态」——一个记账集合：

```java
// service/java/com/android/server/wifi/ClientModeImpl.java:2019
public boolean enableTdls(String remoteMacAddress, boolean enable) {
    boolean ret;
    if (enable && !canEnableTdls()) {
        return false;
    }
    ret = mWifiNative.startTdls(mInterfaceName, remoteMacAddress, enable);
    if (enable && ret) {
        mEnabledTdlsPeers.add(remoteMacAddress);      // 记一笔
    } else {
        mEnabledTdlsPeers.remove(remoteMacAddress);
    }
    return ret;
}
```

```java
// service/java/com/android/server/wifi/ClientModeImpl.java:2067
private boolean canEnableTdls() {
    // 该函数在 HAL 不支持查询时返回 -1
    int maxTdlsSessionCount = mWifiNative.getMaxSupportedConcurrentTdlsSessions(mInterfaceName);
    if (maxTdlsSessionCount < 0) {
        return true;                                  // HAL 不报 → 不设限
    }
    if (mEnabledTdlsPeers.size() >= maxTdlsSessionCount) {
        Log.e(TAG, "canEnableTdls() returned false: maxTdlsSessionCount: "
                + maxTdlsSessionCount + "EnabledTdlsPeers count: " + mEnabledTdlsPeers.size());
        return false;
    }
    return true;
}
```

- **`mEnabledTdlsPeers` 是一个 `Set<String>`**（`ClientModeImpl.java:376` 声明，`ArraySet`），存的是「已经成功 enable 的对端 MAC」。这就是 Framework 层关于 TDLS 的全部状态。
- **`canEnableTdls` 是「上限检查」**：`getMaxSupportedConcurrentTdlsSessions` 问 HAL 最多能并发几条 TDLS，超了直接拒绝。注意那个 `-1` 的分支——HAL 不支持查询就不设限，这是向后兼容的宽松处理。
- **记账是「事后补记」**：先 `startTdls` 成功了，才 `add` 进集合；失败则 `remove`。所以这个集合的语义是「驱动里已经 enable 的对端」，不是「正在建立的对端」。

## 1.4 `startTdls` 一拆二：Discover 与 Setup 两步走

`WifiNative` 这层做了一件有意思的事——把一个「enable」拆成两个动作：

```java
// service/java/com/android/server/wifi/WifiNative.java:2754
public boolean startTdls(@NonNull String ifaceName, String macAddr, boolean enable) {
    boolean ret = true;
    if (enable) {
        mSupplicantStaIfaceHal.initiateTdlsDiscover(ifaceName, macAddr);
        ret = mSupplicantStaIfaceHal.initiateTdlsSetup(ifaceName, macAddr);
    } else {
        ret = mSupplicantStaIfaceHal.initiateTdlsTeardown(ifaceName, macAddr);
    }
    return ret;
}
```

- **enable = Discover + Setup**：先 `initiateTdlsDiscover`（协议 §11.20.3 的发现阶段），再 `initiateTdlsSetup`（§11.20.4 的建立阶段）。注意 Discover 的返回值被**丢弃**——它只是个「尽力而为」的探活，Setup 才是真正要结果的那一步。
- **disable = Teardown**：一个 `initiateTdlsTeardown` 搞定（§11.20.5 拆除）。
- 这就是 Framework 层的最底层——它不做任何 TDLS 语义，只是把「enable/disable」翻译成 supplicant 的三个动词，往下丢。

再往下，`SupplicantStaIfaceHal` 的三个方法（`initiateTdlsDiscover/Setup/Teardown`）就是纯粹的 AIDL/HIDL 边界转发，把字符串 MAC 转成 `byte[6]`，调 AIDL 接口 `ISupplicantStaIface` 的同名方法。跨过这条边界，就进了 supplicant。

## 1.5 设计点：为什么没有 TDLS 专属回调

看完整条 Framework 链路，有个「反直觉」的事实值得点破：**Framework 层没有 onTdlsStatus 这类专属回调**。历史上（老 AOSP）有过 `onTdlsStatus`，但现在没了——TDLS 的「建立成功/失败」不通过专门事件回传 Framework，而是**退化成一条断连 reason code**，并入普通断连流程。

```java
// service/java/com/android/server/wifi/SupplicantStaIfaceHal.java:148
public static final int TDLS_TEARDOWN_UNREACHABLE = 25;
public static final int TDLS_TEARDOWN_UNSPECIFIED = 26;
```

```java
// framework/java/android/net/wifi/DeauthenticationReasonCode.java:136
public static final int REASON_TDLS_TEARDOWN_UNREACHABLE = 25;
public static final int REASON_TDLS_TEARDOWN_UNSPECIFIED = 26;
```

- **reason code 25 / 26 是 IEEE 802.11 标准里的「TDLS 拆除原因」**：25 = TDLS teardown unreachable（对端不可达），26 = TDLS teardown unspecified。它们本是「TDLS 链路拆除」专用，现在被复用来告诉上层「这条直连挂了」。
- **为什么这么设计？** 因为 TDLS 直连一旦建立，后续的「直连断了」对 Framework 而言和「普通链路异常」没有本质区别——都是「这条到对端的路没了」。与其为 TDLS 单开一套回调、单开一套状态机，不如把它折叠进既有的 `DeauthenticationReasonCode` 体系，让 `WifiMonitor` → `ClientModeImpl` 的既有断连处理路径顺手把它处理掉。**Framework 的「薄」，薄到连事件回传都懒得单独开一条路。**
- 代价是：**上层只能知道「直连挂了」，拿不到「挂在哪个阶段」**——是 Discovery 没回应、TPK 握手超时、还是对端主动拆？这些细节全留在 supplicant 的日志里，Framework 看不见。

> 如果你在担心「那用户怎么知道 TDLS 建没建成？」——答案是 `setTdlsEnabled(..., Consumer<Boolean>)` 这条带回调的新接口，它的 `onResult` 只回一个「enable 请求是否被接受」的布尔，**不是**「直连是否真的建立」。真正的建立成败，在 Framework 眼里是「一条普通断连」——reason code 25/26。

---

# 2 握手谁在跑？——supplicant 的 TPK 三帧握手状态机

> 前台（Framework）把工单派下去之后，真正的「签合同」环节在 supplicant。这里没有花哨的 Java 状态机，一台 C 状态机用「结构体字段」编码了 Discovery → Setup 三帧握手 → 直连的全部状态。

## 2.1 AIDL 边界：三个动词的三种结局

先看 AIDL 边界上，supplicant 怎么接住 Framework 丢过来的三个动词。核心文件是 `wpa_supplicant/aidl/vendor/sta_iface.cpp`：

```cpp
// wpa_supplicant/aidl/vendor/sta_iface.cpp:1089
ndk::ScopedAStatus StaIface::initiateTdlsSetupInternal(
	const std::vector<uint8_t> &mac_address)
{
	struct wpa_supplicant *wpa_s = retrieveIfacePtr();
	int ret;
	if (mac_address.size() != ETH_ALEN)
		return createStatus(SupplicantStatusCode::FAILURE_UNKNOWN);
	const u8 *peer = mac_address.data();
	if (wpa_tdls_is_external_setup(wpa_s->wpa) &&
		!(wpa_s->conf->tdls_external_control)) {
		wpa_tdls_remove(wpa_s->wpa, peer);
		ret = wpa_tdls_start(wpa_s->wpa, peer);        // supplicant 亲自跑握手
	} else {
		ret = wpa_drv_tdls_oper(wpa_s, TDLS_SETUP, peer);  // 下发驱动内部完成
	}
	if (ret) {
		wpa_printf(MSG_INFO, "StaIface: TDLS setup failed: %d", ret);
	}
	return ndk::ScopedAStatus::ok();
}
```

三个动词各自的实现里，都能看到同一个**岔路口**——`wpa_tdls_is_external_setup()`：

- **Discover**：external → `wpa_tdls_send_discovery_request`（supplicant 亲自发 Discovery Request 帧）；否则 → `wpa_drv_tdls_oper(TDLS_DISCOVERY_REQ)`。
- **Setup**（上面这段）：external 且非 external_control → `wpa_tdls_remove` + `wpa_tdls_start`（supplicant 亲自跑 M1/M2/M3）；否则 → `wpa_drv_tdls_oper(TDLS_SETUP)`。
- **Teardown**：external → `wpa_tdls_teardown_link(..., WLAN_REASON_TDLS_TEARDOWN_UNSPECIFIED)`；否则 → `wpa_drv_tdls_oper(TDLS_TEARDOWN)`。

这个岔路口，就是全文最重要的架构分水岭——**双模式**。

## 2.2 双模式：`external_setup` 决定谁跑握手

`wpa_tdls_is_external_setup` 的实现简单到只剩一行：

```c
// src/rsn_supp/tdls.c:3187
int wpa_tdls_is_external_setup(struct wpa_sm *sm)
{
	return sm->tdls_external_setup;
}
```

这个 flag 在 `wpa_tdls_init` 里从驱动能力查询来：

```c
// src/rsn_supp/tdls.c:3022
/*
 * 支持 TDLS 但不实现 get_capa 回调的驱动，默认「内部完成」
 */
if (wpa_sm_tdls_get_capa(sm, &sm->tdls_supported,
			 &sm->tdls_external_setup,
			 &sm->tdls_chan_switch) < 0) {
	sm->tdls_supported = 1;
	sm->tdls_external_setup = 0;
}
```

而 `wpa_sm_tdls_get_capa` 最终读到的是驱动 nl80211 报上来的 `WPA_DRIVER_FLAGS_TDLS_EXTERNAL_SETUP`（`wpas_glue.c:789` 的 `wpa_supplicant_tdls_get_capa` 读 `wpa_s->drv_flags`）。

所以「双模式」的完整含义是：

| 模式                                      | 判定                                      | supplicant 干什么                                            | 驱动干什么                                                   |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **external**（`tdls_external_setup = 1`） | 驱动广告 `WIPHY_FLAG_TDLS_EXTERNAL_SETUP` | 亲自派生 TPK、亲自组 M1/M2/M3、经 `NL80211_CMD_TDLS_MGMT` 下发 | 只负责把帧发出去、镜像 peer 状态                             |
| **internal**（`= 0`）                     | 驱动不广告该 flag（如软 MAC 的 mac80211） | 只下发一个 `NL80211_CMD_TDLS_OPER`（TDLS_SETUP）             | 驱动自己在内核里跑完整握手（mac80211 的 `ieee80211_tdls_oper` 全权处理 SETUP/TEARDOWN/DISCOVERY） |

**为什么需要两种？** 回到「谁有能力做 TPK」这个问题：

- **TPK 派生需要 host 侧的 RSN 上下文**——`wpa_tdls_generate_tpk` 要拿 `inonce`/`rnonce`/`BSSID`，这些在 supplicant 的 `wpa_sm` 里现成。**全 MAC 固件（QCOM）把帧收发、peer 追踪丢给固件，但安全握手（TPK 派生）这类需要和 host RSN 上下文强耦合的活，还是留在 host supplicant 里更合理**——所以它广告 external，让 supplicant 跑握手，自己只当「帧的搬运工」。
- **软 MAC 驱动（mac80211）** 整个 MAC 都在内核，TPK 握手（M1/M2/M3 的组帧、解析、密钥安装）它自己能做，就广告 internal，supplicant 只需发个 `TDLS_SETUP` 一句话，剩下的驱动包了。

一句话：**「握手逻辑该离 host RSN 上下文多近」决定双模式的分界**。而 QCOM 和 MTK 恰好都选了 external（下面第 3 章会看到，它们 external 之下的「搬运」方式又分叉成两条施工队）。

## 2.3 状态机没有 enum：`struct wpa_tdls_peer` 的字段就是状态

supplicant 的 TDLS 状态机**没有显式的 `enum state`**——它的「当前走到哪一步」分散编码在 `struct wpa_tdls_peer` 的几个字段里：

```c
// src/rsn_supp/tdls.c:96
struct wpa_tdls_peer {
	struct wpa_tdls_peer *next;
	unsigned int reconfig_key:1;
	int initiator;          /* 本端是否为 TDLS setup 的发起方 */
	u8 addr[ETH_ALEN];      /* 对端 MAC */
	u8 inonce[WPA_NONCE_LEN]; /* Initiator Nonce（发起方随机数）*/
	u8 rnonce[WPA_NONCE_LEN]; /* Responder Nonce（响应方随机数）*/
	u8 rsnie_i[TDLS_MAX_IE_LEN]; /* Initiator RSN IE */
	size_t rsnie_i_len;
	u8 rsnie_p[TDLS_MAX_IE_LEN]; /* Peer RSN IE */
	size_t rsnie_p_len;
	u32 lifetime;
	int cipher;             /* 选中的密码套件（WPA_CIPHER_*）*/
	u8 dtoken;

	struct tpk {
		u8 kck[16]; /* TPK-KCK */
		u8 tk[16];  /* TPK-TK；假设只用 CCMP */
	} tpk;
	int tpk_set;
	int tk_set;       /* TPK-TK 是否已装到驱动 */
	int tpk_success;      /* 握手是否成功（=直连已建立）*/
	int tpk_in_progress;  /* 握手是否进行中 */

	struct tpk_timer { ... } sm_tmr;  /* 重传定时器 */
	// ...省略 HT/VHT/HE/EHT 能力、offchannel 信道、MLD link_id 等字段...
};
```

- **状态 = 三个 int 的组合**：`tpk_in_progress`（正在握手）、`tpk_success`（握手成功）、`tk_set`（密钥已装驱动）。`initiator` 再补一个「我是发起方还是响应方」的角色。合起来就是一台完整的握手状态机——没有 enum，但语义等价。
- **`sm_tmr` 是重传定时器**：存「最后一次发的什么帧、重试了几次、超时多久、重传的原始报文」。`wpa_tdls_tpk_retry_timeout` 超时后照这个结构原样重发——这就是 M1/M2 那套「重试计数」机制的载体。
- **`tpk.kck` / `tpk.tk`**：最终派生出来的两把钥匙——KCK（Key Confirmation Key，给握手帧打 MIC 验签）和 TK（Temporal Key，给数据帧加解密）。**每个对端独立一份**，这就是「逐对端」状态机的物理形态。

## 2.4 TPK 派生：`wpa_tdls_generate_tpk` 的密钥配方

TPK 怎么从两个随机数变成一把只有双方知道的钥匙？核心在 `wpa_tdls_generate_tpk`：

```c
// src/rsn_supp/tdls.c:428
static void wpa_tdls_generate_tpk(struct wpa_tdls_peer *peer,
				  const u8 *own_addr, const u8 *bssid)
{
	u8 key_input[SHA256_MAC_LEN];
	const u8 *nonce[2];
	size_t len[2];
	u8 data[3 * ETH_ALEN];

	/* IEEE Std 802.11 §12.7.8.2：
	 * TPK-Key-Input = Hash(min(SNonce, ANonce) || max(SNonce, ANonce))
	 * Hash = SHA-256（TDLS 专用）
	 */
	len[0] = WPA_NONCE_LEN;
	len[1] = WPA_NONCE_LEN;
	if (os_memcmp(peer->inonce, peer->rnonce, WPA_NONCE_LEN) < 0) {
		nonce[0] = peer->inonce;
		nonce[1] = peer->rnonce;
	} else {
		nonce[0] = peer->rnonce;
		nonce[1] = peer->inonce;
	}
	sha256_vector(2, nonce, len, key_input);   // TPK-Key-Input

	/* TPK = KDF-Hash-Length(TPK-Key-Input, "TDLS PMK",
	 *	min(MAC_I, MAC_R) || max(MAC_I, MAC_R) || BSSID)
	 */
	if (os_memcmp(own_addr, peer->addr, ETH_ALEN) < 0) {
		os_memcpy(data, own_addr, ETH_ALEN);
		os_memcpy(data + ETH_ALEN, peer->addr, ETH_ALEN);
	} else {
		os_memcpy(data, peer->addr, ETH_ALEN);
		os_memcpy(data + ETH_ALEN, own_addr, ETH_ALEN);
	}
	os_memcpy(data + 2 * ETH_ALEN, bssid, ETH_ALEN);   // BSSID 进 KDF context

	sha256_prf(key_input, SHA256_MAC_LEN, "TDLS PMK", data, sizeof(data),
		   (u8 *) &peer->tpk, sizeof(peer->tpk));
	peer->tpk_set = 1;
}
```

- **两步派生**：先 `SHA-256(min(SNonce,ANonce) || max(SNonce,ANonce))` 得到 `TPK-Key-Input`，再用 `KDF("TDLS PMK", min(MAC)||max(MAC)||BSSID)` 展开成 `tpk.kck` + `tpk.tk`（各 16 字节）。
- **`min`/`max` 排序是安全刚需**：双方各持一份 `inonce`/`rnonce`，但顺序可能相反——不排序就会算出两把不同的钥匙。所以协议规定「先比大小、小的在前」，保证双方算出的输入字节流**完全一致**。
- **`bssid` 参与 KDF context**：这是 TDLS 隧道语义的关键——**钥匙和「你们是哪个 BSS 的」绑定**。哪怕同样的两台设备换到另一个 AP 下，密钥也必然不同。这正是「建立信令借道 AP、但 AP 拿不到钥匙」的技术落地：AP 只转发握手帧，不知道帧里的 nonce，而密钥又是 nonce+BSSID 派生出来的。

> 如果你在想「AP 会不会偷看 nonce、自己把钥匙算出来？」——答案是握手帧里的 nonce 是明文放进 TDLS Setup 帧的（FTIE 里），AP 转发时理论上看得见。但**AP 看见了也没用**：TPK 只绑定这对 STA 之间的数据直连，AP 不需要也没法用它解任何「经 AP 中转」的流量；更关键的是握手帧带 MIC（用 KCK 验签），AP 篡改会被识破。协议篇 §12.7.8.3 把这点列成了「安全假设」，本篇点到为止。

## 2.5 三帧握手：M1/M2/M3 从发出到处理

Setup 的主干是 `wpa_tdls_start`（发起方）→ 发 M1 → 收 M2 → 发 M3。发起方入口：

```c
// src/rsn_supp/tdls.c:2839
int wpa_tdls_start(struct wpa_sm *sm, const u8 *addr)
{
	struct wpa_tdls_peer *peer;
	// ...省略 tdls_prohibited / disabled / MLO 检查...

	peer = wpa_tdls_add_peer(sm, addr, NULL);
	if (peer == NULL)
		return -1;
	if (peer->tpk_in_progress) {
		wpa_printf(MSG_DEBUG, "TDLS: Setup is already in progress with the peer");
		return 0;
	}
	peer->initiator = 1;

	/* 先把对端作为「setup in progress」加进驱动 */
	if (wpa_sm_tdls_peer_addset(sm, peer->addr, 1, 0, 0, NULL, 0, NULL,
				    NULL, NULL, 0, NULL, 0, 0, NULL, 0, NULL, 0,
				    NULL, 0, NULL, 0, peer->mld_link_id)) {
		wpa_tdls_disable_peer_link(sm, peer);
		return -1;
	}

	peer->tpk_in_progress = 1;
	return wpa_tdls_send_tpk_m1(sm, peer);   // 发出 M1
}
```

- **`initiator = 1`**：标记「我是发起方」。响应方收到 M1 后建 peer 时 `initiator = 0`。
- **`wpa_sm_tdls_peer_addset`**：先往驱动「注册」一个 setup-in-progress 的对端（对应 nl80211 的 `NL80211_CMD_TDLS_OPER / TDLS_ADD` 语义，后面 2.7 展开）。驱动要先知道「有这么个对端正在握手」，才能为后续 M2/M3 的收发和密钥安装做好准备。
- **`tpk_in_progress = 1`** 之后立刻发 M1，整个状态机由此起跳。

M1 的组帧（`wpa_tdls_send_tpk_m1`）里，值得记的是它填的 RSN IE——**只用 CCMP、且 AKM 写死为「TPK handshake」**：

```c
// src/rsn_supp/tdls.c:1118
/*
 * TPK Handshake Message 1:
 * FTIE: ANonce=0, SNonce=initiator nonce MIC=0, DataKDs=(RSNIE_I, Timeout IE)
 */
RSN_SELECTOR_PUT(pos, RSN_CIPHER_SUITE_NO_GROUP_ADDRESSED);
pos += RSN_SELECTOR_LEN;
count_pos = pos; pos += 2;
// ...省略...
/* 无论 AP 连接用什么密码套件，TDLS 都固定选 CCMP */
RSN_SELECTOR_PUT(pos, RSN_CIPHER_SUITE_CCMP);
pos += RSN_SELECTOR_LEN;
count++;
WPA_PUT_LE16(count_pos, count);
WPA_PUT_LE16(pos, 1); pos += 2;
RSN_SELECTOR_PUT(pos, RSN_AUTH_KEY_MGMT_TPK_HANDSHAKE);
pos += RSN_SELECTOR_LEN;
```

- **`RSN_AUTH_KEY_MGMT_TPK_HANDSHAKE`**：AKM 类型，明确告诉对端「这是 TPK 握手，不是 EAP/PSK」——呼应本文开头的边界声明「EAP 不涉及」。
- **固定 CCMP**：TDLS 直连不用 TKIP（注释里写明），且**不管 AP 连接用的是什么密码套件**，TDLS 直连一律 CCMP。这也是「直连密钥独立于 AP 密钥」的一个体现。

M1 组好、发出之后，发起方就转入「收」的一侧——对端会回帧，而这头怎么认出「来的是 M2 还是拆除请求」？靠的不是帧头，而是帧里的 action code。

收帧这头，`wpa_supplicant_rx_tdls` 按 action code 分发到各处理函数：

```c
// src/rsn_supp/tdls.c:2967
switch (tf->action) {
case WLAN_TDLS_SETUP_REQUEST:
	wpa_tdls_process_tpk_m1(sm, src_addr, buf, len);   // 收到 M1
	break;
case WLAN_TDLS_SETUP_RESPONSE:
	wpa_tdls_process_tpk_m2(sm, src_addr, buf, len);   // 收到 M2
	break;
case WLAN_TDLS_SETUP_CONFIRM:
	wpa_tdls_process_tpk_m3(sm, src_addr, buf, len);   // 收到 M3
	break;
case WLAN_TDLS_TEARDOWN:
	wpa_tdls_recv_teardown(sm, src_addr, buf, len);
	break;
case WLAN_TDLS_DISCOVERY_REQUEST:
	wpa_tdls_process_discovery_request(sm, src_addr, buf, len);
	break;
default:
	/* 其余帧交给内核处理 */
	break;
}
```

- **`WLAN_TDLS_SETUP_REQUEST/RESPONSE/CONFIRM` 就是 M1/M2/M3**，分别由 `wpa_tdls_process_tpk_m1/m2/m3` 处理。这是「隧道」二字的落地——这些 TDLS 帧**封装在 Data 帧里**（`wpa_tdls_frame` 头：payloadtype=2 表示 TDLS_RFTYPE），所以收帧走的是数据帧封装路径，而不是管理帧路径。回到导读那句——**「隧道」= 建立信令（M1/M2/M3）封装成普通数据帧、借道 AP 转发**：AP 看到的只是两台 STA 之间互发的普通数据帧，不知道里面装的是 TDLS 控制信令；只有对端 STA 剥掉数据帧头，才发现这是「合同」。AP 全程只当「借道的搬运工」，内容对 AP 透明。
- 发起方发 M1 → 对端收到 `SETUP_REQUEST` 走 `process_tpk_m1`（验 MIC、存 nonce、回 M2）→ 发起方收到 `SETUP_RESPONSE` 走 `process_tpk_m2`（派 TPK、发 M3）→ 对端收到 `SETUP_CONFIRM` 走 `process_tpk_m3`（装密钥、enable link）。

三帧握手的具体时序见下图：

![TDLS TPK 三帧握手（M1/M2/M3）时序](assets/14-TDLS-AP-%E6%97%81%E8%B7%AF%E7%9B%B4%E8%BF%9E%E2%80%94%E2%80%94%E4%BB%8E-enableTdls-%E5%88%B0%E7%9B%B4%E8%BF%9E%E5%BB%BA%E7%AB%8B/14-tdls-tpk-handshake.svg)

## 2.6 密钥落盘：`wpa_tdls_set_key` 到驱动

握手成功、TPK 派生出来之后，最后一件事是把 TK 装进驱动，让数据直连真正能用这把钥匙加解密：

```c
// src/rsn_supp/tdls.c:208
static int wpa_tdls_set_key(struct wpa_sm *sm, struct wpa_tdls_peer *peer)
{
	u8 key_len;
	u8 rsc[6];
	enum wpa_alg alg;

	if (peer->tk_set) {
		/* 这把 TPK-TK 已经装过，重复配置会清 TX/RX 序号，破坏安全 */
		return -1;
	}
	os_memset(rsc, 0, 6);
	switch (peer->cipher) {
	case WPA_CIPHER_CCMP:
		alg = WPA_ALG_CCMP;
		key_len = 16;
		break;
	case WPA_CIPHER_NONE:
		/* 开放链路，不用 pairwise key */
		return -1;
	default:
		return -1;
	}
	if (wpa_sm_set_key(sm, -1, alg, peer->addr, 0, 1, rsc, sizeof(rsc),
			   peer->tpk.tk, key_len,
			   KEY_FLAG_PAIRWISE_RX_TX) < 0) {
		return -1;
	}
	peer->tk_set = 1;
	return 0;
}
```

- **`tk_set` 防重复安装**：注释说得很直白——同一把 TK 重复配置会重置 TX/RX 序号，导致重放攻击面。所以「已装过就不许再装」。
- **`KEY_FLAG_PAIRWISE_RX_TX`**：pairwise 双向密钥。`wpa_sm_set_key` 最终落到 `wpa_drv_set_key` → nl80211 `NL80211_CMD_NEW_KEY`，把 TK 装到驱动（QCOM 装到固件，MTK 装到 `rTdlsKeyTemp`，见第 3 章）。

而「密钥装完 + link enable」的收尾在 `wpa_tdls_enable_link`：

```c
// src/rsn_supp/tdls.c:2320
static int wpa_tdls_enable_link(struct wpa_sm *sm, struct wpa_tdls_peer *peer)
{
	peer->tpk_success = 1;
	peer->tpk_in_progress = 0;
	eloop_cancel_timeout(wpa_tdls_tpk_timeout, sm, peer);
	// ...省略 lifetime 到期定时器（TPK_LIFETIME = 12 小时）...
	if (peer->reconfig_key && wpa_tdls_set_key(sm, peer) < 0)
		return -1;
	peer->reconfig_key = 0;
	return wpa_sm_tdls_oper(sm, TDLS_ENABLE_LINK, peer->addr);  // 通知驱动启用直连
}
```

- **`tpk_success = 1` + `tpk_in_progress = 0`**：状态机翻转——握手结束、直连建立。
- **`wpa_sm_tdls_oper(TDLS_ENABLE_LINK)`**：最后发一个「启用链路」给驱动，驱动据此把数据面切到直连路径。这是「直连建立」在代码里的最后一跳。
- **`TDLS_ENABLE_LINK` 之后，数据面到底怎么切？** 机制上就是一句话：**TX 发包前先查「目的 MAC 是不是我的 TDLS 对端」**——命中 TDLS peer 表 → 改走点对点直连，用 §2.4 派生的 TPK-TK 加密封帧、不再经 AP 中转；未命中 → 照旧走 AP。
- 但「查表 → 选路 → 加密封帧」这串动作的字节级实现，两家驱动都下沉到了固件——QCOM 的 `components/tdls/core/src/wlan_tdls_txrx.c` 在 host 侧只是一个 23 行的空壳（实体收发在固件），MTK 的 `TDLS_LINK_ENABLED(prSta)` 宏（`include/mgmt/tdls.h:501`，即 `eTdlsStatus == STA_TDLS_LINK_ENABLE`）定义了 host 状态，却没有任何 host TX 路径调用它——切换发生在固件。
- **Block ACK 是直连链路上独立的一套会话**：直连一旦建立，M1/M2/M3 里交换的 HT/VHT/HE/EHT 能力字段（`struct wpa_tdls_peer` 里那几组 `*_capabilities` 指针，`tdls.c:137-143`）就是为这条直连的 Block ACK 会话准备的。
- 它和「经 AP」那条链路的 Block ACK 是两套，各自协商窗口，直连拆掉时这套也一起拆。ADDBA 按「对端 MAC + TID」建立、**不绑定信道**——这为 offchannel 切信道后 Block ACK 不用重谈埋下伏笔。
- **offchannel 切信道同样下沉固件**：TDLS 可以把直连挪到 AP 工作信道之外的 offchannel 上（协议 §11.20.6 channel switching）。能力在 Setup 阶段用 TDLS Extended Capabilities 里的 channel switch 位协商——MTK host 侧在组帧时确实会把这个能力位置 1（`tdls.c:2158` 的 `aucCapabilities[3] |= BIT(30-24)`，即 `TDLS_EX_CAP_CHAN_SWITCH`），向对端广告「支持切信道」。
- 动作码 `TDLS_FRM_ACTION_CHAN_SWITCH_REQ/RSP`（`include/mgmt/tdls.h:107-108`）也定义了，但 `TdlsexLinkMgt` 的 action 分发 switch 里根本没有 CHAN_SWITCH 分支——host 只负责「打广告」，真正的切信道在固件。supplicant 侧的对应能力探针，就是 §2.2 里 `wpa_sm_tdls_get_capa` 读出的那个 `tdls_chan_switch`（`tdls.c:3028`）。

**为什么这两件事非固件不可、主机软件做不了？** 一句话：它们都压在数据面的**热路径**上，主机软件的时延预算不够看。逐包 TX 决策是每个数据包发出前必经的关卡——「查 TDLS peer 表 → 选直连/AP 路由 → 选钥加密封帧」。若放在主机（supplicant 用户态或驱动内核态），每包都要过一次 host CPU 的查表加判断，高吞吐下就是每包一次的固定开销，还夹着中断、调度和用户态/内核态往返的抖动；而固件把这套 peer 表搬进 MAC 层硬件流水线，逐包决策零 CPU 参与，这是千兆级直连能跑起来的前提。offchannel 切信道更苛刻：切信道是射频硬件层面的动作，要赶在协议规定的微秒级帧间间隔（SIFS 那一档）内完成。主机软件从收到通知到真正动手，中间隔着中断、进程唤醒、内存拷贝，动辄毫秒级，早过了窗口——只有紧贴射频硬件的固件才能同步在这个量级完成切换。而且切信道远不止一次射频跳频：它要把 Block ACK 会话状态、重排序缓冲、AMPDU 聚合状态**原子地**一起搬过去——任何一帧序号错位都会触发 Block ACK 超时重传、瞬间打爆吞吐。所以「切信道 + Block ACK 维持」是一对不可分割的组合动作，只有固件能把它们在同一量级里同步做完。

所以两家驱动不约而同地把这条数据路径让给了固件：QCOM 干脆把 host 侧 `wlan_tdls_txrx.c` 留成 23 行空壳，MTK 让 `TDLS_LINK_ENABLED` 宏定义了却无人调用。这不是它们「偷懒没实现」，而是这个位置本来就该固件坐，主机软件坐在那里只会变成吞吐的瓶颈。

把视角再拉高一层，「绕开 AP」这条数据面，正是 TDLS 和 P2P（Wi-Fi Direct）最本质的分野。TDLS 有「AP 锚」：双方必须已经关联在**同一个 AP** 下，直连建立后数据面才点对点绕开它，但 AP 关联始终保留——它仍是控制面锚点（发现、隧道信令、拆除都借道 AP）和数据面的保底回退路径（直连一断，reason code 25/26 就退回「经 AP」的普通链路，见 §1.5）。这也解释了 §2.4 为什么要把 BSSID 拌进 TPK 的 KDF context——钥匙绑定的就是「这个 AP 的 BSS」。P2P 则没有基础设施 AP 可绕：它自己造一个「软 AP」（Group Owner，GO），普通数据面是 STA → GO → STA 的转发，GO 就是那个「前台」——所以 P2P 的「直连」默认没有「旁路」这一步，因为它本来就没有 AP 可旁路。

## 2.7 下发 nl80211：`TDLS_MGMT` 与 `TDLS_OPER` 两条命令

supplicant 所有的 TDLS 动作，落到驱动就两种 nl80211 命令：

```c
// src/drivers/driver_nl80211.c:10782
if (!(msg = nl80211_drv_msg(drv, 0, NL80211_CMD_TDLS_MGMT)) ||
    nla_put(msg, NL80211_ATTR_MAC, ETH_ALEN, dst) ||
    nla_put_u8(msg, NL80211_ATTR_TDLS_ACTION, action_code) ||
    nla_put_u8(msg, NL80211_ATTR_TDLS_DIALOG_TOKEN, dialog_token) ||
    nla_put_u16(msg, NL80211_ATTR_STATUS_CODE, status_code) ||
    (link_id >= 0 && nla_put_u8(msg, NL80211_ATTR_MLO_LINK_ID, link_id)) ||
    nl80211_add_peer_capab(msg, peer_capab) ||
    (initiator && nla_put_flag(msg, NL80211_ATTR_TDLS_INITIATOR)) ||
    nla_put(msg, NL80211_ATTR_IE, len, buf))
	goto fail;
```

```c
// src/drivers/driver_nl80211.c:10813
switch (oper) {
case TDLS_DISCOVERY_REQ: nl80211_oper = NL80211_TDLS_DISCOVERY_REQ; break;
case TDLS_SETUP:         nl80211_oper = NL80211_TDLS_SETUP;         break;
case TDLS_TEARDOWN:      nl80211_oper = NL80211_TDLS_TEARDOWN;      break;
case TDLS_ENABLE_LINK:   nl80211_oper = NL80211_TDLS_ENABLE_LINK;   break;
case TDLS_DISABLE_LINK:  nl80211_oper = NL80211_TDLS_DISABLE_LINK;  break;
// ...
}
// NL80211_CMD_TDLS_OPER + NL80211_ATTR_TDLS_OPERATION + NL80211_ATTR_MAC
```

- **`NL80211_CMD_TDLS_MGMT`**（external 模式用）：supplicant 把**已经组好的帧内容**（action code + dialog token + IE）原样打包丢给驱动，驱动负责发出去。这就是 M1/M2/M3 的搬运通道。
- **`NL80211_CMD_TDLS_OPER`**（internal 模式用，以及 peer addset / enable_link）：supplicant 只给一个**高层操作码**（SETUP/TEARDOWN/DISCOVERY/ENABLE_LINK...），帧的细节驱动自己造。
- 两个命令、一个「给成品帧」一个「给意图」，正好对应 2.2 的双模式。跨过这条 nl80211 边界，就进了驱动——两条施工队在此分道扬镳。

---

# 3 帧谁在组？——QCOM 固件卸载 vs MTK 主机重活

> 合同（TPK）签完了，剩下「把线拉起来」。两家施工队的风格截然相反：QCOM 把整个布线工程外包给总包商（固件），自己只在旁边监工；MTK 则扛着工具箱亲自上场，一根线一根线地拉。

## 3.1 QCOM：把整活外包给固件

QCOM 驱动（`qcacld-3.0`，full-MAC 架构）在注册 wiphy 时，就亮明了自己的角色：

```c
// core/hdd/src/wlan_hdd_cfg80211.c:19862
#ifdef FEATURE_WLAN_TDLS
	wiphy->flags |= WIPHY_FLAG_SUPPORTS_TDLS
			| WIPHY_FLAG_TDLS_EXTERNAL_SETUP;
#endif
```

- **`WIPHY_FLAG_TDLS_EXTERNAL_SETUP`**：告诉内核/supplicant「握手让 supplicant 跑，我只负责搬运」。这就是第 2.2 节 external 模式的由来。

它的 cfg80211 桥接层 `os_if/tdls/src/wlan_cfg80211_tdls.c` 里，两个回调把 nl80211 请求翻译成内部组件调用：

```c
// os_if/tdls/src/wlan_cfg80211_tdls.c:727
int wlan_cfg80211_tdls_oper(struct wlan_objmgr_vdev *vdev,
			    const uint8_t *peer,
			    enum nl80211_tdls_operation oper)
{
	// ...
	if (NL80211_TDLS_DISCOVERY_REQ == oper) {
		osif_warn("We don't support in-driver setup/teardown/discovery");
		return -ENOTSUPP;
	}
	cmd = tdls_oper_to_cmd(oper);
	switch (oper) {
	case NL80211_TDLS_ENABLE_LINK:
	case NL80211_TDLS_TEARDOWN:
	case NL80211_TDLS_SETUP:
		status = ucfg_tdls_oper(vdev, peer, cmd);   // 下发给 TDLS 组件
		// ...
	}
}
```

- **那句 `-ENOTSUPP` 是 QCOM 的宣言**：「我们不在驱动里跑 setup/teardown/discovery」——discovery 它直接拒，setup/teardown 也只是把 supplicant 的意图（peer 状态变更）**镜像**到组件，帧的收发和状态机在固件。

而「帧怎么进固件」走的是另一个回调 `wlan_cfg80211_tdls_mgmt`（`wlan_cfg80211_tdls.c:977`）——supplicant 组好的 M1/M2/M3 经 `NL80211_CMD_TDLS_MGMT` 到这里，转手调 `ucfg_tdls_send_mgmt_frame` 把成品帧送上 WMI。这就是 external 模式「supplicant 组帧、QCOM 只搬运」的落地。

`ucfg_tdls_oper` 会一路走到 TDLS 组件（`components/tdls/`），组件在 host 侧维护一套「链接状态」镜像，再通过 WMI 下发给固件：

```c
// components/tdls/dispatcher/inc/wlan_tdls_public_structs.h:158
enum tdls_link_state {
	TDLS_LINK_IDLE = 0,
	TDLS_LINK_DISCOVERING,
	TDLS_LINK_DISCOVERED,
	TDLS_LINK_CONNECTING,
	TDLS_LINK_CONNECTED,
	TDLS_LINK_TEARING,
};
```

```c
// components/target_if/tdls/src/target_if_tdls.c:98
if (TDLS_SUPPORT_EXP_TRIG_ONLY == param->tdls_state)
	tdls_state = WMI_TDLS_ENABLE_PASSIVE;
else if (TDLS_SUPPORT_IMP_MODE == param->tdls_state ||
	 TDLS_SUPPORT_EXT_CONTROL == param->tdls_state)
	tdls_state = WMI_TDLS_ENABLE_CONNECTION_TRACKER_IN_HOST;
else
	tdls_state = WMI_TDLS_DISABLE;
status = wmi_unified_update_fw_tdls_state_cmd(wmi_handle, param, tdls_state);
```

- **`WMI_TDLS_ENABLE_CONNECTION_TRACKER_IN_HOST`** 这个名字是 QCOM 架构的题眼：**连接跟踪在 host，帧的收发在固件**。host 组件维护 `IDLE → DISCOVERING → ... → CONNECTED` 的镜像状态（`tdls_link_state`），通过 `wmi_unified_update_fw_tdls_state_cmd` 把「当前该处于什么模式」告诉固件；固件拿到状态后，自己负责实际的 TDLS action 帧收发、TCLAS 分类、offchannel 直连。
- **所以 QCOM 的「固件卸载」**：TPK 派生在 supplicant（host）、链接状态镜像在 host 组件、**帧的实体收发和直连数据路径在固件**。host 全程不碰帧字节，只下发「意图 + 状态」。

## 3.2 MTK：主机亲自下场组帧

MTK（`kernel_modules-connectivity-wlan-core-gen4m`，gen4m 主机型架构）也广告 external，但它「搬运」帧的方式是**主机亲手组帧**。同样在 wiphy 注册处：

```c
// include/mgmt/tdls.h:41
#define TDLSEX_WIPHY_FLAGS_INIT(__fgFlag__)				\
{									\
	__fgFlag__ |= (WIPHY_FLAG_SUPPORTS_TDLS |			\
			WIPHY_FLAG_TDLS_EXTERNAL_SETUP);		\
}
```

cfg80211 回调 `mtk_cfg80211_tdls_mgmt` 把 supplicant 组好的帧塞进一个 `TDLS_CMD_LINK_MGT` 命令，再 `kalIoctl` 转给 `TdlsexLinkMgt`：

```c
// os/linux/gl_cfg80211.c:4810
kalMemZero(&rCmdMgt, sizeof(rCmdMgt));
rCmdMgt.u2StatusCode = status_code;
rCmdMgt.u4SecBufLen = len;
rCmdMgt.ucDialogToken = dialog_token;
rCmdMgt.ucActionCode = action_code;
kalMemCopy(&(rCmdMgt.aucPeer), peer, 6);
kalMemCopy(&(rCmdMgt.aucSecBuf), buf, len);   // supplicant 组好的 IE 原样带过来
rCmdMgt.ucBssIdx = ucBssIndex;
rStatus = kalIoctl(prGlueInfo, TdlsexLinkMgt, &rCmdMgt,
		 sizeof(struct TDLS_CMD_LINK_MGT), &u4BufLen);
```

`TdlsexLinkMgt`（`mgmt/tdls.c:943`）是一个按 action code 分发的**主机侧状态机**，它把「要发的什么帧」翻译成「具体组哪种帧」：

```c
// mgmt/tdls.c:983
switch (prCmd->ucActionCode) {
case TDLS_FRM_ACTION_DISCOVERY_REQ:
	rResult = TdlsDataFrameSend_DISCOVERY_REQ(prAdapter, prStaRec,
			    prCmd->aucPeer, prCmd->ucActionCode,
			    prCmd->ucDialogToken, prCmd->u2StatusCode,
			    (uint8_t *) (prCmd->aucSecBuf), prCmd->u4SecBufLen);
	break;
case TDLS_FRM_ACTION_SETUP_REQ:
	prStaRec = cnmGetTdlsPeerByAddress(prAdapter,
			prBssInfo->ucBssIndex, prCmd->aucPeer);
	g_arTdlsLink[prStaRec->ucTdlsIndex] = 0;
	rResult = TdlsDataFrameSend_SETUP_REQ(prAdapter, prStaRec,
			    prCmd->aucPeer, prCmd->ucActionCode,
			    prCmd->ucDialogToken, prCmd->u2StatusCode,
			    (uint8_t *) (prCmd->aucSecBuf), prCmd->u4SecBufLen);
	break;
case TDLS_FRM_ACTION_SETUP_RSP:
	// ...
	rResult = TdlsDataFrameSend_SETUP_RSP(prAdapter, ...);
	break;
case TDLS_FRM_ACTION_CONFIRM:
	rResult = TdlsDataFrameSend_CONFIRM(prAdapter, ...);
	break;
case TDLS_FRM_ACTION_TEARDOWN:
	// ...
	rResult = TdlsDataFrameSend_TearDown(prAdapter, ...);
	break;
}
```

- **`TdlsDataFrameSend_SETUP_REQ/RSP/CONFIRM/DISCOVERY_REQ/DISCOVERY_RSP/TearDown`**：六个组帧函数，每个都**在主机上手动拼 TDLS action 帧**——填 category、action、dialog token、FTIE、RSN IE、Link ID IE、Timeout IE，再走主机 TX 路径发出去。这是「主机重活」的字面含义：**帧的字节是主机代码一行行写的**，不是固件代劳。
- **`g_arTdlsLink[]`**：一个 `uint8_t` 数组，`MAXNUM_TDLS_PEER`（=4）个槽位，是 MTK 侧的「链路占用表」——哪条直连占用了哪个 TDLS index。

MTK 的链接状态机在 `enum STA_TDLS_STATUS` 里显式枚举（和 supplicant 的「字段即状态」形成有趣对照）：

```c
// include/mgmt/tdls.h:446
enum STA_TDLS_STATUS {
	STA_TDLS_NOT_SETUP,
	STA_TDLS_SETUP_INPROCESS,
	STA_TDLS_SETUP_COMPLETE,
	STA_TDLS_SETUP_TEARDOWN,
	STA_TDLS_LINK_ENABLE,
	STA_TDLS_LINK_DOWN,
	STA_TDLS_LINK_DISABLE,
	STA_TDLS_SETUP_NUM
};
```

- **`STA_TDLS_SETUP_INPROCESS → SETUP_COMPLETE → LINK_ENABLE`**：这就是 MTK 主机侧的直连生命周期，比 supplicant 的 `tpk_in_progress/tpk_success` 更细，因为它还要管「链路 enable/disable」这条数据面切换。

而 `TdlsexLinkOper`（`mgmt/tdls.c:1098`）处理 `TDLS_ENABLE_LINK / TDLS_DISABLE_LINK`——supplicant 握手完成后 `wpa_sm_tdls_oper(TDLS_ENABLE_LINK)` 落到这里，MTK 把 `g_arTdlsLink[i]` 置 1，正式启用直连数据路径。

MTK 侧 TPK 密钥的安装也走主机：`wpa_sm_set_key` 下发的 `NL80211_CMD_NEW_KEY` 最终落到 `struct PARAM_KEY rTdlsKeyTemp`（`include/mgmt/cnm_mem.h:710`，注释写着「temp to queue the key information」）——密钥先入队，再由主机把它装进直连的 STA_RECORD。

## 3.3 双平台对比

| 维度                  | QCOM（qcacld-3.0）                                           | MTK（gen4m）                                            |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| 架构定位              | full-MAC，固件卸载                                           | 主机型，主机重活                                        |
| TDLS action 帧由谁组  | 固件（host 只下发意图）                                      | 主机（`TdlsDataFrameSend_*` 手动拼字节）                |
| 状态机在哪            | host 组件镜像（`enum tdls_link_state`）+ 固件实体            | 主机（`enum STA_TDLS_STATUS`）                          |
| supplicant 帧怎么下发 | `wlan_cfg80211_tdls_mgmt` → `ucfg_tdls_send_mgmt_frame` → WMI | `mtk_cfg80211_tdls_mgmt` → `kalIoctl` → `TdlsexLinkMgt` |
| 状态同步到固件        | `wmi_unified_update_fw_tdls_state_cmd`（`CONNECTION_TRACKER_IN_HOST`） | 无需（状态本来就在主机）                                |
| TPK 密钥装到哪        | 固件（`wpa_sm_set_key` → WMI）                               | 主机 `rTdlsKeyTemp`（`PARAM_KEY`）                      |
| 并发链路记账          | host 组件 peer 列表（`WLAN_TDLS_PEER_LIST_SIZE`=16）         | `g_arTdlsLink[]`（`MAXNUM_TDLS_PEER`=4）                |

两条施工队的对比图见下：

![QCOM 固件卸载 vs MTK 主机组帧 路径对比](assets/14-TDLS-AP-%E6%97%81%E8%B7%AF%E7%9B%B4%E8%BF%9E%E2%80%94%E2%80%94%E4%BB%8E-enableTdls-%E5%88%B0%E7%9B%B4%E8%BF%9E%E5%BB%BA%E7%AB%8B/14-qcom-mtk-compare.svg)

> 如果你在犹豫「external_setup 双模式和 QCOM/MTK 是不是一回事」——**不是**。双模式分的是「握手在 supplicant 还是驱动」（QCOM/MTK 都选 external，握手都在 supplicant）；QCOM/MTK 之分，是 external 之下「帧的搬运」再分叉——一个外包给固件、一个主机亲自动手。这是两个正交的维度，别混。

两条施工队殊途同归——无论把线外包给总包商（固件）还是亲手一根一根接（主机），「前台登记 → 双方签合同 → 施工队拉线」这条链都在驱动这一层落了地：线，就此拉通。

---

# 4 总结——一条「登记 → 签合同 → 拉线」的链

**全链路回顾**（精确到函数）：

```
App 调 setTdlsEnabled(IP, enable)
  → WifiManager.setTdlsEnabled → mService.enableTdls(ip, enable)
    → WifiServiceImpl.enableTdls → TdlsTask（AsyncTask，读 /proc/net/arp 换 MAC）
      → enableTdlsWithMacAddress → getPrimaryClientModeManager().enableTdls(mac, enable)
        → ConcreteClientModeManager.enableTdls → getClientMode().enableTdls
          → ClientModeImpl.enableTdls：canEnableTdls() 查上限 → mWifiNative.startTdls
            → WifiNative.startTdls：enable → initiateTdlsDiscover + initiateTdlsSetup
              → SupplicantStaIfaceHal.initiateTdls* → AIDL/HIDL 边界
        ── AIDL 边界（ISupplicantStaIface）──
              → StaIface::initiateTdlsSetupInternal（sta_iface.cpp）
                → wpa_tdls_is_external_setup? external → wpa_tdls_start
                  → wpa_tdls_send_tpk_m1（组 M1）→ wpa_tdls_tpk_send → wpa_tdls_send_tpk_msg
                    → wpa_sm_send_tdls_mgmt → wpa_drv_send_tdls_mgmt
                      → nl80211_send_tdls_mgmt → NL80211_CMD_TDLS_MGMT
                    ── nl80211 边界 ──
                        → QCOM：wlan_cfg80211_tdls_mgmt → ucfg_tdls_send_mgmt_frame → WMI → 固件
                        → MTK：mtk_cfg80211_tdls_mgmt → kalIoctl → TdlsexLinkMgt → TdlsDataFrameSend_SETUP_REQ
  // ... 对端回 M2、发起方回 M3（wpa_supplicant_rx_tdls 分发 → process_tpk_m1/m2/m3）...
                  → wpa_tdls_generate_tpk（派 TPK）→ wpa_tdls_set_key（装 TK）
                    → wpa_tdls_enable_link → wpa_sm_tdls_oper(TDLS_ENABLE_LINK)
                      → nl80211_tdls_oper → NL80211_CMD_TDLS_OPER → 驱动启用直连数据路径
```

**设计亮点回顾**：

1. **Framework 薄到「连回调都省」**：唯一的 TDLS 状态是 `mEnabledTdlsPeers` 一个 `Set`，唯一的限制是 `canEnableTdls` 的并发上限。拆除事件不单开回调，退化成 reason code 25/26 并入普通断连——薄得彻底。
2. **状态机「字段即状态」**：supplicant 用 `tpk_in_progress`/`tpk_success`/`tk_set`/`initiator` 四个字段编码握手状态，没有显式 enum——和 MTK 的显式 `enum STA_TDLS_STATUS` 形成两种风格的对照。
3. **双模式分界 = 握手离 host RSN 上下文多近**：external（supplicant 跑握手，QCOM/MTK 都选）vs internal（软 MAC 驱动如 mac80211 内核自研）。密钥派生需要 host 的 RSN 上下文，所以全 MAC 固件也把握手留给 supplicant。
4. **同一「搬运」下再分两条施工队**：QCOM 固件卸载（`CONNECTION_TRACKER_IN_HOST`，host 只镜像状态、帧在固件）vs MTK 主机组帧（`TdlsDataFrameSend_*` 手动拼字节）。同一份 external 握手，两种完全不同的工程哲学。

**异常路径（选最关键的几条）**：IP 查不到 MAC（`/proc/net/arp` 无此 IP）→ `Log.w` 静默失败；`canEnableTdls` 超上限 → 直接 `false`；M1/M2 超时无响应 → `wpa_tdls_tpk_retry_timeout` 按 `sm_tmr` 重传（M1 重试 3 次 / 5 秒，M2 重试 10 次 / 500ms），最终放弃；TPK 到期 → `TPK_LIFETIME`（12 小时）后 `wpa_tdls_tpk_timeout` 触发重新握手；对端不可达 → reason code 25（`TDLS_TEARDOWN_UNREACHABLE`）并入断连流程。

**关键常量速查表**：

| 常量                                    | 值           | 定义位置                                | 含义                     |
| --------------------------------------- | ------------ | --------------------------------------- | ------------------------ |
| `WIFI_FEATURE_TDLS`                     | 12           | `WifiManager.java:3888`                 | TDLS 能力 feature bit    |
| `WIFI_FEATURE_TDLS_OFFCHANNEL`          | 13           | `WifiManager.java:3890`                 | TDLS offchannel 能力 bit |
| `TDLS_TEARDOWN_UNREACHABLE`             | 25           | `SupplicantStaIfaceHal.java:148`        | 拆除原因：对端不可达     |
| `TDLS_TEARDOWN_UNSPECIFIED`             | 26           | `SupplicantStaIfaceHal.java:149`        | 拆除原因：未指定         |
| `TPK_LIFETIME`                          | 43200（12h） | `tdls.c:42`                             | TPK 密钥生命周期         |
| `TPK_M1_RETRY_COUNT` / `TPK_M1_TIMEOUT` | 3 / 5000ms   | `tdls.c:43-44`                          | M1 重试次数 / 超时       |
| `TPK_M2_RETRY_COUNT` / `TPK_M2_TIMEOUT` | 10 / 500ms   | `tdls.c:45-46`                          | M2 重试次数 / 超时       |
| `MAXNUM_TDLS_PEER`                      | 4            | `tdls.h:81`（MTK）                      | MTK 并发直连上限         |
| `WLAN_TDLS_PEER_LIST_SIZE`              | 16           | `wlan_tdls_public_structs.h:39`（QCOM） | QCOM peer 列表上限       |

**跨层字段映射表**（「这条直连到对端的 MAC」在四层各登记一次）：

| 层                | 字段/结构                                    | 位置                                        |
| ----------------- | -------------------------------------------- | ------------------------------------------- |
| Framework 记账    | `mEnabledTdlsPeers`（`Set<String>`）         | `ClientModeImpl.java:376`                   |
| supplicant 状态机 | `struct wpa_tdls_peer.addr`                  | `tdls.c:100`                                |
| QCOM host 镜像    | `tdls_peer` 对象（peer 列表）                | `components/tdls/core/src/wlan_tdls_peer.c` |
| MTK 链路占用表    | `g_arTdlsLink[]` + `cnmGetTdlsPeerByAddress` | `tdls.c:40`                                 |

这一章，我们把「AP 旁路直连」从 `enableTdls` 追到了 TPK 三帧握手、再到两条施工队拉线——前台登记、双方签合同、施工队各显神通。至于**直连建立之后数据怎么真正走直连**（TX/RX 从「经 AP」切到「点对点」、Block ACK 和 offchannel 数据面），如 §2.6 所标，字节级的实现两家驱动都下沉到了固件。host 源码到此为止，这是「直连建立」的最后一跳，也是本文的边界。下一篇，我们换一个方向：看一群设备在**没连任何 AP** 的情况下怎么互相发现、还同步时钟——Wi-Fi Aware（NAN）。下一章，我们钻进 NAN 的 Discovery Window 和 SDF。

---

**源码仓库**：

- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- AOSP wpa_supplicant_8: [https://android.googlesource.com/platform/external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8)
- QCOM qcacld-3.0: [https://git.codelinaro.org/clo/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0](https://git.codelinaro.org/clo/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0)
- MTK gen4m: [https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)

**相关规范**（`802.11-2024.pdf`）：

- §11.20 Tunneled direct link setup（§11.20.3 discovery、§11.20.4 direct link establishment、§11.20.5 teardown、§11.20.6 channel switching）
- §9.6.12 TDLS Action field formats（§9.6.12.2/3/4 Setup Request/Response/Confirm，即 M1/M2/M3）
- §12.7.8 TDLS PeerKey (TPK) security protocol（§12.7.8.2 TPK handshake，含 TPK-Key-Input 派生式；§12.7.8.4 TPK Security Protocol handshake messages，即三帧握手）
- 注：TPK 派生在 802.11-2016 里是 §12.7.9.2（代码注释引用的就是旧编号），802.11-2024 已重编号为 §12.7.8.2
