---
title: Passpoint 自动连网——从 ANQP 查询到自动连接
top: 1
related_posts: true
abbrlink: 24fd7090
date: 2026-09-24 23:26:09
tags:
  - Android WiFi
  - Passpoint
categories:
  - WiFi
  - Code
---

> 你走进机场，手机没碰一下，自己就连上了运营商的 Passpoint 热点——比蜂窝漫游还像漫游。这张「免手动连接」是怎么在代码里跑通的？本文追踪一次 Passpoint 自动连接：从扫描结果里认出 Passpoint 门店招牌，到借道 supplicant 隔空问询（ANQP），到 Java 层比对会员卡，再到提名、打分、连接——跨过 Java Framework、supplicant C、驱动 C 三个代码世界。

---

# 本章导读

上一章 DPP 回答的是「无屏设备怎么扫码配网」；这一章换个接入难题——**设备在公共 WiFi 之间走动，怎么像蜂窝网一样自动认网、自动认证、全程不点一下？** 这正是 Passpoint（Wi-Fi 联盟认证品牌，技术规范名 Hotspot 2.0，简称 HS2.0）要解决的。协议系列讲过了（四状态、GAS/ANQP、Beacon 标志、OSU），本篇不重讲协议，只做一件事：**把每个协议概念映射到 AOSP 源码里的具体实现**。

<!--more-->

一句话概括本文主线：一次 Passpoint 自动连接 = **发现（`NetworkDetail` 从 `ScanResult` 识别 802.11u/HS2.0 元素）→ ANQP 查询（Framework 借 supplicant 当传输通道）→ Java 层匹配（`PasspointProvider.match` / `ANQPMatcher`）→ 生成 `WifiConfiguration` → 提名（`PasspointNetworkNominateHelper`）→ `WifiNetworkSelector` 打分 → 普通连接（复用《STA 连接》流程）**。

在动手前，先记住一个贯穿全文的三层分工，它决定了后面每一段代码长什么样：

| 层                                 | 角色                                                         | 代码事实                                                     |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Framework（主角）**              | 唯一门面 `PasspointManager`，管 `PasspointProvider` 集合 + ANQP 缓存/请求两套基础设施 | 匹配、提名、打分、持久化全在 Java 层                         |
| **supplicant（被借用的传输通道）** | 只被借用 `initiateAnqpQuery` 做 ANQP 帧收发，结果经 `onAnqpQueryDone` 回 Java | ⚠️ 它自带完整的 `interworking.c` 原生选网引擎，但 Android 框架**不调用**（第 7 章追问） |
| **驱动（纯透传）**                 | GAS/Public Action 帧 raw 透传不解析                          | QCOM `lim_process_action_frame_no_session` / MTK `aisFuncValidateRxActionFrame` |

**本文只讲自动连网的主干。** 本文不涉及 OSU 在线签约——Passpoint 规范 v3.4 已删除 OSU（连同 OSEN/SPP/Policy Update，见规范 §1.1 版本矩阵），但 AOSP 仍保留历史实现 `PasspointProvisioner`（8 状态状态机），正文一句话带过这个「规范已删、AOSP 遗留」的对照，不展开 SOAP/OMADM；也不涉及 EAP 认证细节，见本系列《STA 连接 — 安全协议分支与 WiFi 7 MLO》。

先看这张全链路分层图，理解一次 Passpoint 自动连接要跨越的每一层和跨进程边界：

![Passpoint 自动连接全链路分层架构](assets/13-Passpoint-%E8%87%AA%E5%8A%A8%E8%BF%9E%E7%BD%91%E2%80%94%E2%80%94%E4%BB%8E-ANQP-%E6%9F%A5%E8%AF%A2%E5%88%B0%E8%87%AA%E5%8A%A8%E8%BF%9E%E6%8E%A5/13-passpoint-architecture.svg)

---

# 1 凭什么认出「这是一家可刷卡的连锁店」？

> Beacon 里的 Interworking / HS2.0 Indication / Roaming Consortium 三个元素，就是 AP 门口挂的「可刷卡」灯箱。`NetworkDetail` 的活儿，是把这灯箱上的字一个不落地抄下来。

在讲「隔空问询」之前，先回答更靠前的问题：**设备扫到一堆 AP，凭什么知道「这一个值得发 ANQP 去细问」？** 协议层（规范 §3.1.1、§6.1）的答案是——信息明明白白写在 Beacon / Probe Response 里。源码层的答案是——**每次扫描结果回到 Framework，都会被 `NetworkDetail` 的构造函数解析一遍，把这三个元素的字段抽出来存成成员变量**。这条链的入口是 `WifiConnectivityManager.AllSingleScanListener.onFullResult(ScanResult)`（`WifiConnectivityManager.java:1162`）：它收到单条 `ScanResult` 后 `new ScanDetail(fullScanResult)`（`WifiConnectivityManager.java:1183`）包成 `ScanDetail`，而 `ScanDetail` 的构造函数（`ScanDetail.java:131`）第一行就是 `new NetworkDetail(scanResult.BSSID, scanResult.informationElements, ...)`（`ScanDetail.java:133`）——「扫描结果进 Framework」落到实处，就是「每条 `ScanResult` 都过一次 `NetworkDetail` 构造」。

`NetworkDetail` 的构造函数（`hotspot2/NetworkDetail.java:178`）遍历 `ScanResult.InformationElement[]`，用一个 `switch (ie.id)` 分发到各 `InformationElementUtil` 子类去 `from(ie)` 解析。Passpoint 相关的只有三个 case：

```java
// hotspot2/NetworkDetail.java:239
for (ScanResult.InformationElement ie : infoElements) {
    iesFound.add(ie.id);
    switch (ie.id) {
        case ScanResult.InformationElement.EID_SSID:
            ssidOctets = ie.bytes;
            break;
        case ScanResult.InformationElement.EID_INTERWORKING:      // 802.11u 互通元素
            interworking.from(ie);
            break;
        case ScanResult.InformationElement.EID_ROAMING_CONSORTIUM: // 漫游联盟元素
            roamingConsortium.from(ie);
            break;
        case ScanResult.InformationElement.EID_VSA:                // Vendor Specific → HS2.0 Indication
            vsa.from(ie);
            break;
        // ...省略 HT/VHT/HE/EHT/RSN 等其它元素的解析...
    }
}
// ...省略 SSID 解码...
mHESSID = interworking.hessid;                    // 大网统一标识
mAnt = interworking.ant;                          // Access Network Type（免费/收费公网…）
mInternet = interworking.internet;
mHSRelease = vsa.hsRelease;                       // HS2.0 版本：R1/R2/R3
mAnqpDomainID = vsa.anqpDomainID;                 // ANQP Domain ID
mAnqpOICount = roamingConsortium.anqpOICount;
mRoamingConsortiums = roamingConsortium.getRoamingConsortiums();
```

- **`EID_INTERWORKING`（Interworking element）**：`interworking.from(ie)` 抽出 `hessid`（HESSID，同一张 Passpoint 大网的统一标识）、`ant`（Access Network Type）、`internet` 位。`mAnt != null` 表示「这是个 802.11u AP」——这正是 `isInterworking()` 的唯一判据。
- **`EID_VSA`（Vendor Specific）**：`vsa.from(ie)` 认出 Wi-Fi 联盟 OUI `50:6F:9A` 的 HS2.0 Indication element，抽出 `hsRelease`（Release Number）和 `anqpDomainID`。**有没有这个元素，是「普通 802.11u AP」和「Passpoint AP」的真正分界线**。
- **`EID_ROAMING_CONSORTIUM`**：`roamingConsortium.from(ie)` 抽出漫游联盟 OI 列表，以及 `anqpOICount`（AP 在 ANQP 里还额外藏了几个 OI 没塞进 Beacon）。

判断「是不是 Passpoint」就一句话：

```java
// hotspot2/NetworkDetail.java:638
public boolean isInterworking() {
    return mAnt != null;    // 只看 Interworking element 在不在
}
```

- **`isInterworking()` 只判 `mAnt`（Interworking element 在不在）**：它回答的是「这是个 802.11u AP 吗」。三个字段的「或」——Interworking / Roaming Consortium / HS2.0 Indication 三者有其一——是另一个方法 `has80211uInfo()`（`NetworkDetail.java:595`）干的活，`isInterworking()` 只是它更窄的一个子集。
- 后面第 6 章会看到，`PasspointNetworkNominateHelper` 用 `isInterworking() && getHSRelease() != null` 作为「非 Passpoint 网络直接过滤掉」的闸门——前者是「这是个 802.11u AP」，后者才是「确实是连锁品牌（而不是普通 802.11u）」，也即「可刷卡」的真正分界线。

如果你在想「为什么 ANQP 查询的触发判断不在 `NetworkDetail` 里，而要等扫描结果进网络选择器才做」——答案是：**`NetworkDetail` 只负责「抄招牌」，不负责「做决定」**。它把三个元素的字段原样存下来，是否发 ANQP、发哪些元素、匹配哪张会员卡，都是后面几个类的活。这是 Android 这套代码一个贯穿始终的取舍：**解析和决策分离**。

---

# 2 要不要问、问什么？——ANQP 查询的触发与排队

> 招牌抄下来了，但「要不要去问前台、问些什么、多久问一次」不是拍脑袋决定的。`ANQPRequestManager` 是一个带「冷却惩罚」的排队器——问过一次没答应的 AP，越问越要隔得久。

触发点藏在 `PasspointManager.getAllMatchedProviders()` 里（`PasspointManager.java:903`）。它先试着从 ANQP 缓存里查这个 AP 的答案，查不到才发查询：

```java
// hotspot2/PasspointManager.java:911
// 从 ScanResult 里取出 Roaming Consortium IE 和 HS2.0 Vendor Specific IE
InformationElementUtil.RoamingConsortium roamingConsortium =
        InformationElementUtil.getRoamingConsortiumIE(scanResult.informationElements);
InformationElementUtil.Vsa vsa = InformationElementUtil.getHS2VendorSpecificIE(
        scanResult.informationElements);

// 用 (SSID, BSSID, HESSID, ANQP Domain ID) 四元组拼缓存 key
long bssid = Utils.parseMac(scanResult.BSSID);
ANQPNetworkKey anqpKey = ANQPNetworkKey.buildKey(scanResult.SSID, bssid, scanResult.hessid,
        vsa.anqpDomainID);
ANQPData anqpEntry = mAnqpCache.getEntry(anqpKey);
if (anqpEntry == null) {
    if (anqpRequestAllowed) {
        // 缓存没命中 → 触发一次 ANQP 查询
        mAnqpRequestManager.requestANQPElements(bssid, anqpKey,
                roamingConsortium.anqpOICount > 0, vsa.hsRelease);
    }
    return allMatches;   // 本次查不到，等下一轮扫描拿到答案再匹配
}
```

- **缓存 key 是四元组 `(SSID, BSSID, HESSID, ANQP Domain ID)`**（`ANQPNetworkKey.buildKey`）。为什么不用 BSSID 一个就够？因为同一张 Passpoint 大网下多个 BSS 共享同一份 ANQP 答案——HESSID 和 ANQP Domain ID 让「问过一个 BSS，整张大网的其它 BSS 都能复用答案」成为可能（对应规范 §6.1 的 Discovery 逻辑）。
- **`anqpRequestAllowed` 是节流开关**：匹配失败时传 `false`，避免「查不到 → 再查 → 再查」的空转。
- **本次没命中缓存就 `return`**：ANQP 查询是异步的，答案要等下一轮扫描回来才能用——这正是「自动连接不是一轮扫描完成，而是跨多轮扫描的流水线」的伏笔。

查询请求进入 `ANQPRequestManager.requestANQPElements()`（`ANQPRequestManager.java:159`），它不做立刻发包，而是把请求塞进队列再 `processNextRequest()`：

```java
// hotspot2/ANQPRequestManager.java:159
public void requestANQPElements(long bssid, ANQPNetworkKey anqpNetworkKey, boolean rcOIs,
        NetworkDetail.HSRelease hsReleaseVer) {
    mPendingRequest.offer(new AnqpRequest(bssid, rcOIs, hsReleaseVer, anqpNetworkKey));
    processNextRequest();
}

private void processNextRequest() {
    if (mAnqpRequestPending) return;               // 同一时刻只允许一个进行中的查询
    AnqpRequest request;
    while ((request = mPendingRequest.poll()) != null) {
        if (!canSendRequestNow(request.mBssid)) {  // 还在 hold-off 冷却期内 → 跳过
            continue;
        }
        if (mPasspointHandler.requestANQP(request.mBssid, getRequestElementIDs(request.mRcOIs,
                request.mHsRelease))) {
            break;                                  // 发出去一个，等它的答案
        }
    }
    // ...省略 hold-off 记录 + 2 秒超时 Alarm 的排定...
}
```

- **单飞行查询（single in-flight）**：`mAnqpRequestPending` 保证同一时刻只有一个 ANQP 查询在飞，其它请求排队。ANQP 是 off-channel 的帧交换，串行化避免了多个 off-channel 会话打架。
- **hold-off 冷却**：`canSendRequestNow()` 查 `mHoldOffInfo`，问过没答应的 AP 会被拉黑一段时间，时长指数退避——`BASE_HOLDOFF_TIME_MILLISECONDS = 10000`（10 秒）起步，每失败一次翻倍，`MAX_HOLDOFF_COUNT = 6` 封顶（最长 640 秒）。这是「别反复骚扰一个不搭理的 AP」的礼貌机制。
- **2 秒超时 Alarm**：`ANQP_REQUEST_ALARM_INTERVAL_MS = 2000`，发出去后 2 秒没收到回调就放行下一个请求。

「问什么」由 `getRequestElementIDs()`（`ANQPRequestManager.java:278`）按 HS2.0 版本决定，基础集合是写死的两个常量：

```java
// hotspot2/ANQPRequestManager.java:84
private static final List<Constants.ANQPElementType> R1_ANQP_BASE_SET = Arrays.asList(
        Constants.ANQPElementType.ANQPVenueName,        // 场馆名
        Constants.ANQPElementType.ANQPIPAddrAvailability,
        Constants.ANQPElementType.ANQPNAIRealm,          // NAI 域（开户行）
        Constants.ANQPElementType.ANQP3GPPNetwork,       // 3GPP 蜂窝网络
        Constants.ANQPElementType.ANQPDomName,           // 域名
        Constants.ANQPElementType.HSFriendlyName,        // 运营商友好名
        Constants.ANQPElementType.HSWANMetrics,          // WAN 指标
        Constants.ANQPElementType.HSConnCapability);     // 连接能力
private static final List<Constants.ANQPElementType> R2_ANQP_BASE_SET = Arrays.asList(
        Constants.ANQPElementType.HSOSUProviders);       // OSU 提供商列表
```

- **一次查询问一串元素**：对应协议层「一个 GAS Initial Request 里用 Query List 一次性列出想问的所有 ANQP 元素」（规范 §4.1、附录 B 的官方示例），逻辑上就是「一问一答」，不是「问几样来几轮」。
- **按版本增补**：`rcOIs` 为真时追加 `ANQPRoamingConsortium`；`hsRelease` 为 R2+ 时追加 R2 基础集。这里的 `ANQPElementType` 枚举值（`ANQPVenueName`、`ANQPNAIRealm`…）和 §4 的 HS2.0 ANQP-element 一一对应。

到这里，决策链路是：**扫到 AP → `NetworkDetail` 抄下招牌 → 缓存没答案 → `ANQPRequestManager` 排队 → `PasspointEventHandler.requestANQP` 真正发包**。下一章看「发包」是怎么跨进程跑到 supplicant 的。

---

# 3 借道跑堂（下行）——ANQP 查询怎么跨进 supplicant

> Framework 自己不造 GAS 帧，也不懂 802.11 管理帧的格式——它把问题「翻译成一串元素 ID」，交给 `ClientModeImpl` → `WifiNative` → AIDL → supplicant 的 `anqp_send_req` 去跑腿。supplicant 在这里只是个「传话的跑堂」，不是「做决定的掌柜」。

`PasspointEventHandler.requestANQP()`（`PasspointEventHandler.java:81`）先把 `ANQPElementType` 枚举拆成「ANQP ID 集合」和「HS2.0 subtype 集合」两组数字，再交给 ClientMode：

```java
// hotspot2/PasspointEventHandler.java:81
public boolean requestANQP(long bssid, List<Constants.ANQPElementType> elements) {
    Pair<Set<Integer>, Set<Integer>> querySets = buildAnqpIdSet(elements);
    if (bssid == 0 || querySets == null) return false;
    if (!mWifiInjector.getActiveModeWarden().getPrimaryClientModeManager().requestAnqp(
            Utils.macToString(bssid), querySets.first, querySets.second)) {
        return false;
    }
    return true;
}
```

- **`buildAnqpIdSet()` 是「元素枚举 → 数字 ID」的翻译**：标准 ANQP 元素查 `Constants.getANQPElementID()`，HS2.0 扩展元素查 `Constants.getHS20ElementID()`——前者进 `anqpIds` 集合，后者进 `hs20Subtypes` 集合。这两组数字就是 AIDL 接口真正传输的东西。

`ClientModeImpl.requestAnqp()` 一行转发到 `WifiNative`，`WifiNative.requestAnqp()` 再转发到 `SupplicantStaIfaceHal`：

```java
// ClientModeImpl.java:1931
public boolean requestAnqp(String bssid, Set<Integer> anqpIds, Set<Integer> hs20Subtypes) {
    return mWifiNative.requestAnqp(mInterfaceName, bssid, anqpIds, hs20Subtypes);
}
// WifiNative.java:3127
public boolean requestAnqp(@NonNull String ifaceName, String bssid, Set<Integer> anqpIds,
        Set<Integer> hs20Subtypes) {
    ArrayList<Short> anqpIdList = new ArrayList<>();
    for (Integer anqpId : anqpIds) anqpIdList.add(anqpId.shortValue());
    ArrayList<Integer> hs20SubtypeList = new ArrayList<>(hs20Subtypes);
    return mSupplicantStaIfaceHal.initiateAnqpQuery(ifaceName, bssid, anqpIdList, hs20SubtypeList);
}
```

- **`Set<Integer>` → `ArrayList<Short>`**：把集合转成 AIDL 能携带的定长数组。这两层（`ClientModeImpl` / `WifiNative`）都是纯转发，不掺任何业务逻辑——Android 框架层的惯例是「越接近 AIDL 边界，逻辑越薄」。

真正跨进程的是 `SupplicantStaIfaceHalAidlImpl.initiateAnqpQuery()`（`SupplicantStaIfaceHalAidlImpl.java:1719`），它调用 AIDL 接口 `ISupplicantStaIface` 的方法：

```java
// SupplicantStaIfaceHalAidlImpl.java:1719
private boolean initiateAnqpQuery(@NonNull String ifaceName, byte[/* 6 */] macAddress,
        int[] infoElements, int[] subTypes) {
    ISupplicantStaIface iface = checkStaIfaceAndLogFailure(ifaceName, methodStr);
    if (iface == null) return false;
    try {
        iface.initiateAnqpQuery(macAddress, infoElements, subTypes);   // ── AIDL 边界 ──
        return true;
    } catch (RemoteException e) { /* ...省略... */ }
    return false;
}
```

- **这就是 AIDL 边界**：Java 的 `iface.initiateAnqpQuery(...)` 跨 Binder 到 supplicant 进程的 `StaIface::initiateAnqpQuery`。AIDL 接口签名定义在 `ISupplicantStaIface.aidl:304`，回调 `onAnqpQueryDone` 定义在 `ISupplicantStaIfaceCallback.aidl:65`。

supplicant 侧收到调用，`StaIface::initiateAnqpQueryInternal()`（`sta_iface.cpp:1133`）把元素 ID 数组和 subtype 位掩码转成 C 结构，交给 `anqp_send_req`：

```cpp
// wpa_supplicant/aidl/vendor/sta_iface.cpp:1133
ndk::ScopedAStatus StaIface::initiateAnqpQueryInternal(
    const std::vector<uint8_t> &mac_address,
    const std::vector<AnqpInfoId> &info_elements,
    const std::vector<Hs20AnqpSubtypes> &sub_types)
{
    struct wpa_supplicant *wpa_s = retrieveIfacePtr();
    uint16_t info_elems_buf[kMaxAnqpElems];
    uint32_t num_info_elems = 0;
    for (const auto &info_element : info_elements)
        info_elems_buf[num_info_elems++] = (uint16_t) info_element;
    uint32_t sub_types_bitmask = 0;
    for (const auto &type : sub_types)
        sub_types_bitmask |= BIT((uint32_t) type);
    if (anqp_send_req(wpa_s, mac_address.data(), 0, info_elems_buf, num_info_elems,
                      sub_types_bitmask, 0))
        return createStatus(SupplicantStatusCode::FAILURE_UNKNOWN);
    return ndk::ScopedAStatus::ok();
}
```

- **`initiateAnqpQueryInternal` 只做「格式搬运」**：把 AIDL 的 vector 换成 C 数组 + 位掩码，然后调 `anqp_send_req`。注意它**没有**调任何「选网」「匹配」的函数——supplicant 在这条链上真的只是个传输通道。

`anqp_send_req()`（`interworking.c:2813`）是 supplicant 里「发一次 ANQP 查询」的通用入口，它把元素 ID 组装成 ANQP Query 帧，再交给 GAS 查询模块：

```c
// wpa_supplicant/interworking.c:2813
int anqp_send_req(struct wpa_supplicant *wpa_s, const u8 *dst, int freq,
          u16 info_ids[], size_t num_ids, u32 subtypes, u32 mbo_subtypes)
{
    bss = wpa_bss_get_bssid_latest(wpa_s, dst);      // 从 BSS 缓存找回频点
    if (!bss && !freq) return -1;
    if (bss && !freq) freq = bss->freq;
#ifdef CONFIG_HS20
    if (subtypes != 0) {                              // HS2.0 扩展元素
        extra_buf = wpabuf_alloc(100);
        hs20_put_anqp_req(subtypes, NULL, 0, extra_buf);
    }
#endif
    buf = anqp_build_req(info_ids, num_ids, extra_buf);  // 组 ANQP Query 载荷
    res = gas_query_req(wpa_s->gas, dst, freq, 0, 0, buf, anqp_resp_cb, wpa_s);
    return res < 0 ? -1 : 0;
}
```

- **`anqp_build_req`** 把标准 ANQP 元素 ID 拼进 Query 载荷；**`hs20_put_anqp_req`** 把 HS2.0 扩展 subtype 拼进同一帧——这正对应协议层「标准 ANQP Query + HS Query List 合在一个 GAS Initial Request 里」（规范 §4.1、附录 B）。
- **`gas_query_req` 的回调是 `anqp_resp_cb`**：记住这个函数，第 4 章的回传链就从它开始。

`gas_query_req()`（`gas_query.c:838`）分配 dialog token、挂进 pending 链表，最后通过 radio work 机制排队到 off-channel 上去发：

```c
// wpa_supplicant/gas_query.c:838
int gas_query_req(struct gas_query *gas, const u8 *dst, int freq, ...)
{
    dialog_token = gas_query_new_dialog_token(gas, dst);  // 随机分配 dialog token
    query->dialog_token = dialog_token;
    query->cb = cb; query->ctx = ctx; query->req = req;
    dl_list_add(&gas->pending, &query->list);
    if (radio_add_work(gas->wpa_s, freq, "gas-query", 0, gas_query_start_cb, query) < 0)
        return -1;
    return dialog_token;
}
```

- **`radio_add_work` 是 supplicant 的「信道互斥调度器」**：GAS 查询要 off-channel 跳到目标 AP 的信道，而扫描、连接也在抢信道，radio work 保证同一时刻只有一个 off-channel 会话——这和《STA 扫描》的 radio work 是同一套机制。
- work 真正开始执行时，`gas_query_start_cb`（`gas_query.c:686`）会先做 **MAC 随机化**（`wpas_update_random_addr_disassoc`，未关联态换随机源 MAC），再 `gas_query_tx_initial_req` → `gas_query_tx`：

```c
// wpa_supplicant/gas_query.c:314
res = offchannel_send_action(gas->wpa_s, query->freq, query->addr,
                 query->sa, bssid, wpabuf_head(req),
                 wpabuf_len(req), wait_time, gas_query_tx_status, 0);
```

- **`offchannel_send_action` 是发 GAS Public Action 帧的最后一步**：它会 `wpa_drv_send_action` 走 nl80211 的 `NL80211_CMD_FRAME` 下发驱动（《管理帧的发送 — 控制面的帧处理》的同一路径）。到这儿，ANQP 查询就离开了 supplicant，进入驱动。
- 帧本身的 `category` 是 **Public Action（4）**、action 字段是 GAS Initial Request（10），都是 802.11 通用 Action 帧——supplicant 没有为 Passpoint 发明任何私有帧格式。

---

# 4 答案怎么回来（上行）——`onAnqpQueryDone` 回传与落缓存

> 问出去了，答案原路返回——跑堂把前台的答复原样端回。这条回传链是下行的镜像：驱动把 GAS Response 帧透传给 supplicant → `anqp_resp_cb` 解析 → AIDL `onAnqpQueryDone` → `WifiMonitor` → `PasspointManager` 落进 `AnqpCache`。每一步都在「原样转发」，没有任何一层擅自做匹配。

答案到达 supplicant 后，`gas_query` 模块触发回调 `anqp_resp_cb()`（`interworking.c:3127`）。它校验帧格式、把 payload 按「Info ID + 长度 + 内容」逐段解析，最后通知 AIDL 层：

```c
// wpa_supplicant/interworking.c:3127
void anqp_resp_cb(void *ctx, const u8 *dst, u8 dialog_token,
          enum gas_query_result result, const struct wpabuf *adv_proto,
          const struct wpabuf *resp, u16 status_code)
{
    // ...省略 result != GAS_QUERY_SUCCESS 的失败分支...
    while (pos < end) {                                   // 遍历 response 里的每个 ANQP 元素
        info_id = WPA_GET_LE16(pos); pos += 2;
        slen = WPA_GET_LE16(pos); pos += 2;
        interworking_parse_rx_anqp_resp(wpa_s, bss, dst, info_id, pos, slen, dialog_token);
        pos += slen;
    }
out:
    wpas_notify_anqp_query_done(wpa_s, dst, anqp_result, bss ? bss->anqp : NULL);
}
```

- **`interworking_parse_rx_anqp_resp` 逐个元素解析**，把结果存进 `bss->anqp`（BSS 缓存里的 ANQP 数据块）。注意：supplicant 在这里**只解析不匹配**——它把 ANQP 元素存进 `struct wpa_bss_anqp`，等着被 `wpas_notify_anqp_query_done` 原样上报给 Java。
- **`anqp_result` 是个字符串**（`"SUCCESS"` / `"FAILURE"` / `"INVALID_FRAME"`），用来告诉上层这次查询成没成。

`wpas_notify_anqp_query_done` 转发到 AIDL 层 `wpas_aidl_notify_anqp_query_done()`（`aidl.cpp:204`），后者调 `AidlManager::notifyAnqpQueryDone`，把 `bss->anqp` 序列化成 AIDL 的 `AnqpData` / `Hs20AnqpData` 结构，跨 Binder 回到 Java。

Java 侧的接地点是 `SupplicantStaIfaceCallbackAidlImpl.onAnqpQueryDone()`（`SupplicantStaIfaceCallbackAidlImpl.java:269`）：

```java
// SupplicantStaIfaceCallbackAidlImpl.java:269
public void onAnqpQueryDone(byte[/* 6 */] bssid, AnqpData data, Hs20AnqpData hs20Data) {
    Map<Constants.ANQPElementType, ANQPElement> elementsMap = new HashMap<>();
    addAnqpElementToMap(elementsMap, ANQPVenueName, data.venueName);
    addAnqpElementToMap(elementsMap, ANQPRoamingConsortium, data.roamingConsortium);
    addAnqpElementToMap(elementsMap, ANQPNAIRealm, data.naiRealm);
    addAnqpElementToMap(elementsMap, ANQP3GPPNetwork, data.anqp3gppCellularNetwork);
    addAnqpElementToMap(elementsMap, ANQPDomName, data.domainName);
    addAnqpElementToMap(elementsMap, HSFriendlyName, hs20Data.operatorFriendlyName);
    // ...省略其余元素...
    mWifiMonitor.broadcastAnqpDoneEvent(
            mIfaceName, new AnqpEvent(NativeUtil.macAddressToLong(bssid), elementsMap));
}
```

- **`addAnqpElementToMap` 逐个调用 `parseAnqpElement(infoID, payload)`**：把 AIDL 里的 `AnqpData`（标准元素）/ `Hs20AnqpData`（HS2.0 扩展元素）反序列化成 Java 的 `ANQPElement` 子类对象（`NAIRealmElement`、`DomainNameElement`…）。这一层是「AIDL 结构 → Java 对象」的第二次翻译（下行时是「枚举 → 数字 ID」，上行时反着来）。
- 结果封装成 `AnqpEvent`，经 `WifiMonitor.broadcastAnqpDoneEvent` 投递给 `ClientModeImpl`，再由它调 `mPasspointManager.notifyANQPDone()`（`ClientModeImpl.java:4991`）。

`PasspointManager` 的 `CallbackHandler.onANQPResponse()`（`PasspointManager.java:160`）是答案的终点站——收答案、销请求、落缓存：

```java
// hotspot2/PasspointManager.java:160
public void onANQPResponse(long bssid,
        Map<Constants.ANQPElementType, ANQPElement> anqpElements) {
    // 通知请求管理器：这个请求完成了（顺带销掉 hold-off 与超时 Alarm）
    ANQPNetworkKey anqpKey = mAnqpRequestManager.onRequestCompleted(bssid, anqpElements != null);
    if (anqpElements == null || anqpKey == null) return;   // 查询失败 / 不是我们发的请求
    mAnqpCache.addOrUpdateEntry(anqpKey, anqpElements);    // 落缓存
}
```

- **`onRequestCompleted` 是 `requestANQPElements` 的镜像**：查询成功就清掉这个 AP 的 hold-off 记录、取消超时 Alarm、放行下一个排队请求（`ANQPRequestManager.java:221`）。
- **`mAnqpCache.addOrUpdateEntry` 把答案存进 `AnqpCache`**（`AnqpCache.java:69`），key 还是那个四元组。`AnqpCache.sweep()` 每 60 秒（`CACHE_SWEEP_INTERVAL_MILLISECONDS`）清理过期条目——这就是第 2 章「缓存没命中才发查询」里的那个缓存。
- 到这里完成一个闭环：**第 2 章查缓存没命中 → 第 3 章发查询 → 第 4 章答案回填缓存**——这一路跑堂把前台（AP）的回话原样端回柜台，不替总部（`PasspointManager`）提前判断「这答案合不合卡」。下一轮扫描再进来，`getAllMatchedProviders` 就能命中缓存，进入真正的匹配。

---

# 5 这卡能不能刷？——`PasspointProvider.match` 的四条匹配线索

> 缓存里有了答案，轮到真正的「这卡能不能刷」。`PasspointProvider.match` 像总部客服，拿着会员卡（凭证）逐条对照 ANQP 答案——先对「开户行域名」（FQDN），再对「卡组织」（RCOI），再对「SIM 的归属」（3GPP），最后对「开户域」（NAI Realm）。四条线索任何一条对上，就给出「直营店（Home）还是加盟店（Roaming）」的结论。

回到 `getAllMatchedProviders` 的循环主体（第 2 章那个缓存命中后的分支），它对每个 `PasspointProvider` 调 `match()`：

```java
// hotspot2/PasspointManager.java:938
for (Map.Entry<String, PasspointProvider> entry : mProviders.entrySet()) {
    PasspointProvider provider = entry.getValue();
    PasspointMatch matchStatus = provider.match(anqpEntry.getElements(),
            roamingConsortium, scanResult);
    if (matchStatus == PasspointMatch.HomeProvider
            || matchStatus == PasspointMatch.RoamingProvider) {
        allMatches.add(Pair.create(provider, matchStatus));
    }
}
```

- **`PasspointMatch` 是五值枚举**：`HomeProvider` / `RoamingProvider` / `Incomplete` / `None` / `Declined`（`PasspointMatch.java`）。只有 Home 和 Roaming 两种「确定能用」的结果会被收集；`None` 表示这张卡这店不收。
- **「一张卡 → 一家店」**：每个 provider 独立匹配一次，互不干扰——一个用户可能装了多张卡（多运营商、多漫游联盟），每个 AP 可能同时命中好几张。

`match()`（`PasspointProvider.java:466`）的骨架是「先挡掉不能用的，再逐条线索比对」：

```java
// hotspot2/PasspointProvider.java:466
public PasspointMatch match(Map<ANQPElementType, ANQPElement> anqpElements,
        RoamingConsortium roamingConsortiumFromAp, ScanResult scanResult) {
    sweepMatchedRcoiMap();
    if (isProviderBlocked(scanResult)) return PasspointMatch.None;   // 重认证延迟期内拉黑

    // SIM 凭证要先确认装的那张 SIM 卡对得上（IMSI 前缀匹配）
    String matchingSimImsi = null;
    if (mConfig.getCredential().getSimCredential() != null) {
        matchingSimImsi = getMatchingSimImsi();
        if (TextUtils.isEmpty(matchingSimImsi)) return PasspointMatch.None;
    }

    // 线索一、二：FQDN（Home）与 RCOI（Roaming）
    PasspointMatch providerMatch = matchFqdnAndRcoi(anqpElements, roamingConsortiumFromAp,
            matchingSimImsi, scanResult);

    // 线索三：3GPP Network
    if (providerMatch == PasspointMatch.None && ANQPMatcher.matchThreeGPPNetwork(
            (ThreeGPPNetworkElement) anqpElements.get(ANQPElementType.ANQP3GPPNetwork),
            mImsiParameter, matchingSimImsi)) {
        return PasspointMatch.RoamingProvider;
    }

    // 线索四：NAI Realm
    boolean realmMatch = ANQPMatcher.matchNAIRealm(
            (NAIRealmElement) anqpElements.get(ANQPElementType.ANQPNAIRealm),
            mConfig.getCredential().getRealm());
    if (!realmMatch) return providerMatch;                 // 没对上域，维持 FQDN/RCOI 的结论
    if (providerMatch == PasspointMatch.None)
        providerMatch = PasspointMatch.RoamingProvider;    // 域对上但没 FQDN/RCOI → 也算 Roaming
    return providerMatch;
}
```

- **`isProviderBlocked` 是「重认证延迟」的拉黑**：上次 EAP 认证失败后，这个 provider 在 `mReauthDelay` 期内被整体拉黑（`mBlockedBssids` 记录哪些 BSS 被拉黑，空集表示整张 ESS 都拉黑），避免「认证失败 → 立刻又试 → 再失败」的循环（`PasspointProvider.java:1200`）。
- **SIM 凭证要先验 SIM**：`getMatchingSimImsi()` 拿 profile 里的 IMSI 前缀去匹配已插的 SIM 卡，对不上直接 `None`——这是 SIM 类凭证（EAP-SIM/AKA）特有的前置门槛。
- **匹配有优先级**：FQDN/RCOI（`matchFqdnAndRcoi`）先判，判出 `HomeProvider` 就提前返回；`None` 才轮到 3GPP；NAI Realm 只能「补位」（把 `None` 补成 `RoamingProvider`），不能降级已有的 Home。

![PasspointProvider.match 四条匹配线索的优先级决策树](assets/13-Passpoint-%E8%87%AA%E5%8A%A8%E8%BF%9E%E7%BD%91%E2%80%94%E2%80%94%E4%BB%8E-ANQP-%E6%9F%A5%E8%AF%A2%E5%88%B0%E8%87%AA%E5%8A%A8%E8%BF%9E%E6%8E%A5/13-passpoint-match.svg)

`matchFqdnAndRcoi()`（`PasspointProvider.java:897`）是第一条也是最重要的一条线索——它决定「直营还是加盟」：

```java
// hotspot2/PasspointProvider.java:897
private PasspointMatch matchFqdnAndRcoi(Map<ANQPElementType, ANQPElement> anqpElements,
        RoamingConsortium roamingConsortiumFromAp, String matchingSIMImsi,
        ScanResult scanResult) {
    // (1) 域名匹配 → HomeProvider
    if (ANQPMatcher.matchDomainName(
            (DomainNameElement) anqpElements.get(ANQPElementType.ANQPDomName),
            mConfig.getHomeSp().getFqdn(), mImsiParameter, matchingSIMImsi)) {
        return PasspointMatch.HomeProvider;
    }
    // (2) 其它 Home Partner 域名
    for (String otherHomePartner : mConfig.getHomeSp().getOtherHomePartners()) {
        if (ANQPMatcher.matchDomainName(..., otherHomePartner, null, null))
            return PasspointMatch.HomeProvider;
    }
    // (3) HomeOI 匹配（matchAllOis / matchAnyOis）→ HomeProvider
    // ...省略 HomeOI 的两段判断，结构同 (4)...
    // (4) Roaming Consortium OI 匹配 → RoamingProvider
    long matchedRcoi = matchOis(mConfig.getHomeSp().getRoamingConsortiumOis(),
            (RoamingConsortiumElement) anqpElements.get(ANQPElementType.ANQPRoamingConsortium),
            roamingConsortiumFromAp, false);
    if (matchedRcoi != 0) {
        addMatchedRcoi(scanResult, matchedRcoi);
        return PasspointMatch.RoamingProvider;
    }
    return PasspointMatch.None;
}
```

- **FQDN 是「直营店」的判据**（对应规范 §6.1.1 Home SP identification）：AP 的 Domain Name ANQP 元素里出现我家 Home SP 的 FQDN（或其子域），就是直营店 → `HomeProvider`。
- **`OtherHomePartners` 是「合作方也当直营」**：Home SP 可能和其它 SP 合作，对方的 FQDN 也按 Home 待遇。
- **RCOI 是「加盟店」的判据**（对应规范 §6.5 Roaming Consortium membership）：`getRoamingConsortiumOis()` 里任何一个 OI 和 AP 的漫游联盟对上，就是加盟店 → `RoamingProvider`。`matchOis`（`PasspointProvider.java:844`）先比对 ANQP 的 Roaming Consortium 元素，再退回比对 Beacon 里的 Roaming Consortium IE——**ANQP 优先，Beacon 兜底**（有些 AP 只把部分 OI 塞进 Beacon，更多的藏在 ANQP 里，这正是 `anqpOICount` 存在的意义）。

四条线索的「比对引擎」都在 `ANQPMatcher`（`ANQPMatcher.java`）这个纯静态工具类里，和 provider 的业务逻辑彻底解耦。域名匹配的核心是子域判定：

```java
// hotspot2/ANQPMatcher.java:48
public static boolean matchDomainName(DomainNameElement element, String fqdn,
        IMSIParameter imsiParam, String simImsi) {
    if (element == null) return false;
    for (String domain : element.getDomains()) {
        if (DomainMatcher.arg2SubdomainOfArg1(fqdn, domain)) return true;   // fqdn 是 domain 的子域？
        if (imsiParam == null || simImsi == null) continue;
        // 3GPP 域名（wlan.mnc*.mcc*.3gppnetwork.org）→ 提取 MCC-MNC 再比 SIM
        if (matchMccMnc(Utils.getMccMnc(Utils.splitDomain(domain)), imsiParam, simImsi))
            return true;
    }
    return false;
}
```

- **`DomainMatcher.arg2SubdomainOfArg1(fqdn, domain)`**（`DomainMatcher.java:187`）：判断 `fqdn` 是不是 `domain` 的子域——比如凭证 FQDN 是 `hotspot.example.com`，AP 域名 `example.com` 就算命中。这是「我这张卡的开户行是这家集团」的语义。
- **3GPP 域名走另一条路**：`wlan.mnc*.mcc*.3gppnetwork.org` 这类域名里藏着 MCC/MNC，`matchMccMnc`（`ANQPMatcher.java:194`）要求 `imsiParam.matchesMccMnc(mccMnc)` 且 `simImsi.startsWith(mccMnc)`——双保险，既对 profile 的 IMSI 前缀，又对实际插卡 IMSI 的前缀。

NAI Realm 匹配是四条线索里最「松」的一条（只按域名比对，不校验 EAP 方法）：

```java
// hotspot2/ANQPMatcher.java:112
public static boolean matchNAIRealm(NAIRealmElement element, String realm) {
    if (element == null || element.getRealmDataList().isEmpty()) return false;
    for (NAIRealmData realmData : element.getRealmDataList()) {
        if (matchNAIRealmData(realmData, realm)) return true;
    }
    return false;
}
```

- **只比对 realm 域名，不比对 EAP 方法**：`matchNAIRealmData` 里也是 `DomainMatcher.arg2SubdomainOfArg1(realm, realmStr)`。这看起来有点「偷工」——协议上 NAI Realm 元素还声明了每个 realm 该用哪种 EAP，但 Android 在**匹配阶段**只关心「域对不对」，EAP 方法的选择被推迟到 `getWifiConfig()` 生成 `WifiEnterpriseConfig` 时，按凭证类型（用户/证书/SIM）确定。这是一个「匹配与认证解耦」的取舍。

如果你在担心「四个线索会不会自相矛盾，比如 FQDN 说 Home、RCOI 又说 Roaming」——答案是**不会**：`match` 里的返回顺序就是裁决顺序，FQDN 一旦命中 Home 就直接返回，后面的 3GPP/NAI Realm 根本轮不到。优先级链是 `FQDN(Home) > OtherHomePartners(Home) > HomeOI(Home) > RCOI(Roaming) > 3GPP(Roaming) > NAI Realm(补位 Roaming)`。

---

# 6 匹配上了怎么落地？——从 `WifiConfiguration` 到提名、打分、连接

> 匹配上了不等于连上。`PasspointProvider.getWifiConfig()` 先把「会员卡」翻译成一张「门禁卡」（`WifiConfiguration`），`PasspointNetworkNominateHelper` 把门禁卡塞进 `WifiConfigManager`，最后 `WifiNetworkSelector` 拿这张卡和其它候选一起打分——Passpoint 网络不是「命中就必连」，而是「命中后和其它网络公平竞争」。

匹配成功后，第一个动作是把 provider 的凭证翻译成一张可连接的 `WifiConfiguration`。`getWifiConfig()`（`PasspointProvider.java:545`）干的就是这件事：

```java
// hotspot2/PasspointProvider.java:545
public WifiConfiguration getWifiConfig() {
    WifiConfiguration wifiConfig = new WifiConfiguration();
    // 安全类型标记为 Passpoint（R1/R2 或 R3）
    List<SecurityParams> paramsList = Arrays.asList(
            SecurityParams.createSecurityParamsBySecurityType(
                    WifiConfiguration.SECURITY_TYPE_PASSPOINT_R1_R2),
            SecurityParams.createSecurityParamsBySecurityType(
                    WifiConfiguration.SECURITY_TYPE_PASSPOINT_R3));
    wifiConfig.setSecurityParams(paramsList);

    wifiConfig.FQDN = mConfig.getHomeSp().getFqdn();       // 凭证归属的 FQDN
    wifiConfig.setPasspointUniqueId(mConfig.getUniqueId());
    if (mConfig.getHomeSp().getRoamingConsortiumOis() != null)
        wifiConfig.roamingConsortiumIds = Arrays.copyOf(..., ...);
    // ...省略 updateIdentifier、metered、carrierId、subscriptionId 等字段...

    WifiEnterpriseConfig enterpriseConfig = new WifiEnterpriseConfig();
    enterpriseConfig.setRealm(mConfig.getCredential().getRealm());
    enterpriseConfig.setDomainSuffixMatch(mConfig.getHomeSp().getFqdn());
    if (mConfig.getCredential().getUserCredential() != null) {
        buildEnterpriseConfigForUserCredential(enterpriseConfig, ...);   // EAP-TTLS
    } else if (mConfig.getCredential().getCertCredential() != null) {
        buildEnterpriseConfigForCertCredential(enterpriseConfig);        // EAP-TLS
    } else {
        buildEnterpriseConfigForSimCredential(enterpriseConfig, ...);    // EAP-SIM/AKA
    }
    wifiConfig.enterpriseConfig = enterpriseConfig;
    wifiConfig.allowAutojoin = isAutojoinEnabled();
    // ...省略其余几十个字段...
    return wifiConfig;
}
```

- **`SECURITY_TYPE_PASSPOINT_R1_R2`（=11）/ `SECURITY_TYPE_PASSPOINT_R3`（=12）**：Passpoint 有自己的安全类型常量，不是普通 PSK/Enterprise——`getWifiConfig` 只填字段**不填 SSID**（SSID 由提名阶段从 `ScanDetail` 里补上，因为同一个 FQDN 下可能有多个 BSS/SSID）。
- **EAP 方法在这里才确定**：用户凭证 → EAP-TTLS、证书凭证 → EAP-TLS、SIM 凭证 → EAP-SIM/AKA（`PasspointProvider` 构造函数里就定好了 `mEAPMethodID`）。这印证了第 5 章说的「匹配不校验 EAP，认证才选 EAP」。
- **`FQDN`、`roamingConsortiumIds`、`updateIdentifier` 会被带进 Association Request / EAPOL**：`domainSuffixMatch` 让 EAP 阶段校验服务器证书域名，`updateIdentifier` 在 R2 profile 里作为 PPS MO ID 写进 HS2.0 Indication element。

提名环节的主角是 `PasspointNetworkNominateHelper`（`PasspointNetworkNominateHelper.java`）。注意它的类注释自称「`WifiNetworkSelector.NetworkNominator` 实现」，但**实际代码并不实现那个接口，也没有 `nominateNetworks` 方法**——它由 `WifiNetworkSelector` 直接调用，是一段历史注释与实际代码脱节的遗留。真正的入口是 `getPasspointNetworkCandidates()`：

```java
// hotspot2/PasspointNetworkNominateHelper.java:110
public List<Pair<ScanDetail, WifiConfiguration>> getPasspointNetworkCandidates(
        List<ScanDetail> scanDetails) {
    return findBestMatchScanDetailForProviders(filterAndUpdateScanDetails(scanDetails));
}

@NonNull private List<ScanDetail> filterAndUpdateScanDetails(List<ScanDetail> scanDetails) {
    mPasspointManager.sweepCache();                      // 先清过期 ANQP 缓存
    for (ScanDetail scanDetail : scanDetails) {
        if (scanDetail.getNetworkDetail() == null
                || !scanDetail.getNetworkDetail().isInterworking()
                || scanDetail.getNetworkDetail().getHSRelease() == null) {
            continue;                                     // 非 Passpoint 网络直接过滤
        }
        filteredScanDetails.add(scanDetail);
    }
    return filteredScanDetails;
}
```

- **`filterAndUpdateScanDetails` 是第 1 章 `isInterworking()` 的下游消费者**：`isInterworking()` 且 `getHSRelease() != null` 才保留——前者是「这是个 802.11u AP」，后者是「确实是 Passpoint 连锁品牌」。非 Passpoint 的普通 WiFi 在这道闸就被挡掉了，不会污染后面的匹配。
- **`sweepCache` 挂在提名入口**：每次有新的扫描详情进来，顺手清一下过期的 ANQP 缓存（60 秒窗口）。

选出的候选最终在 `createWifiConfigForProvider()`（`PasspointNetworkNominateHelper.java:306`）里「落库」：

```java
// hotspot2/PasspointNetworkNominateHelper.java:306
private WifiConfiguration createWifiConfigForProvider(PasspointNetworkCandidate candidate) {
    WifiConfiguration config = candidate.mProvider.getWifiConfig();
    config.SSID = ScanResultUtil.createQuotedSsid(candidate.mScanDetail.getSSID());  // 补 SSID
    config.isHomeProviderNetwork = candidate.mMatchStatus == HomeProvider;
    if (candidate.mScanDetail.getNetworkDetail().getAnt()
            == NetworkDetail.Ant.ChargeablePublic) {
        config.meteredHint = true;                       // 收费公网 → 提示按流量计费
    }
    // ...省略 MAC 随机化禁用、已存在配置的 enabled 检查...

    NetworkUpdateResult result = mWifiConfigManager.addOrUpdateNetwork(
            config, config.creatorUid, config.creatorName, false);
    if (!result.isSuccess()) return existingNetwork;
    mWifiConfigManager.enableNetwork(result.getNetworkId(), false, config.creatorUid, null);
    mWifiConfigManager.updateScanDetailForNetwork(result.getNetworkId(), candidate.mScanDetail);
    return mWifiConfigManager.getConfiguredNetwork(result.getNetworkId());
}
```

- **`getWifiConfig()` 缺的 SSID 在这里补**：`createQuotedSsid(scanDetail.getSSID())` 把「这家店的招牌」填进「门禁卡」——同一个 FQDN 的 provider 会为每个匹配的 BSS 各生成一张卡。
- **`addOrUpdateNetwork` 落进 `WifiConfigManager`**：从这里开始，Passpoint 网络变成了一张和普通 WiFi 平权的 `WifiConfiguration`，纳入统一的网络选择池。
- **`getAnt() == ChargeablePublic` → `meteredHint = true`**：`Ant` 枚举（`NetworkDetail.java:32`）里有 `ChargeablePublic`（收费公网）、`FreePublic`（免费公网）等值，收费公网会打上「按流量计费」的提示——一个把「协议字段 → 用户体验」的小映射。

提名只是把门禁卡备好塞进 `WifiConfigManager`；最后一步是「选店委员会」拍板——`WifiNetworkSelector` 统一打分。这些候选被送进 `WifiNetworkSelector.getCandidatesFromScan()`（`WifiNetworkSelector.java:1196`）：

```java
// WifiNetworkSelector.java:1196
List<Pair<ScanDetail, WifiConfiguration>> passpointCandidates = mWifiInjector
        .getPasspointNetworkNominateHelper()
        .getPasspointNetworkCandidates(new ArrayList<>(mFilteredNetworks));
for (NetworkNominator registeredNominator : mNominators) {
    registeredNominator.nominateNetworks(
            new ArrayList<>(mFilteredNetworks), passpointCandidates, ...);
}
```

- **Passpoint 候选被单独拎出来，作为参数喂给其它 nominator**：`mNominators` 里是 Saved / Suggestion 等常规 nominator（`WifiInjector.java:609` 注册），它们在自己的 `nominateNetworks` 里把 Passpoint 候选一起纳入打分。Passpoint 不是「插队直连」，而是「进同一个打分池公平竞争」。
- 打分的规则属于网络选择器的通用逻辑：`selectNetwork()` 取 `getActiveCandidateScorer()`（`WifiNetworkSelector.java:1549`）得到 `ThroughputScorer`，它按「RSSI 基础分（`(rssi+85)*4`，饱和封顶）+ 预测吞吐分（`getPredictedThroughputMbps()` 的 Mbps 值分 800 档线性折算、封顶）+ 频段分 + 安全加分（开放网络 0 分、加密网络加分）」加权——这不是 Passpoint 特有，也正是「为什么 Android 要把 Passpoint 匹配放进 Java 层」的关键证据：**只有匹配在 Java 层，生成的 `WifiConfiguration` 才能无缝并入统一的网络选择器**。

打分胜出后，`WifiNetworkSelector` 把选中的网络交给 `ClientModeImpl` 发起连接——从这一秒起，Passpoint 网络的连接走的是**和普通 WiFi 完全相同的《STA 连接》流程**（AIDL → supplicant select_network → 驱动 auth/assoc → EAP 认证 → 四次握手）。Passpoint 的「特殊」，只体现在连接之前的那一段：发现、查询、匹配、提名。

---

# 7 设计层追问——supplicant 有现成的 `interworking.c` 选网引擎，Android 为什么弃用？

> 这是本文最重要的一层追问。supplicant 里其实早就有一台「自动选店机」——`interworking.c` 的 `interworking_select → interworking_select_network → interworking_connect`，用 `struct wpa_cred` 做匹配、自己选网、自己连。Android 却绕过它，只在 Java 层重写了一套匹配。这不是「没发现」，而是**刻意为之**。原因藏在三个设计约束里。

先看看这台被弃用的「自动选店机」长什么样。入口 `interworking_select()`（`interworking.c:3228`）：

```c
// wpa_supplicant/interworking.c:3228
int interworking_select(struct wpa_supplicant *wpa_s, int auto_select, int *freqs)
{
    interworking_stop_fetch_anqp(wpa_s);
    wpa_s->network_select = 1;
    wpa_s->scan_res_handler = interworking_scan_res_handler;   // 扫描完直接进 ANQP 抓取
    wpa_s->scan_req = MANUAL_SCAN_REQ;
    wpa_supplicant_req_scan(wpa_s, 0, 0);                       // 先扫
    return 0;
}
```

- 这是一条**自包含的流水线**：扫描 → `interworking_scan_res_handler` → `interworking_start_fetch_anqp`（对每个候选 BSS 批量抓 ANQP）→ `interworking_select_network` → `interworking_connect`。全程在 supplicant 内部闭环，Java 层根本插不进手。

选网核心 `interworking_select_network()`（`interworking.c:2498`）用 `struct wpa_cred`（supplicant 自己的凭证块）做匹配，遍历 BSS 缓存挑 Home/最高优先级的网络：

```c
// wpa_supplicant/interworking.c:2498
static void interworking_select_network(struct wpa_supplicant *wpa_s)
{
    dl_list_for_each(bss, &wpa_s->bss, struct wpa_bss, list) {
        cred = interworking_credentials_available(wpa_s, bss, &excluded);  // 用 wpa_cred 匹配
        if (!cred) continue;
        // ...省略 RSN 检查、home/roaming 判定、backhaul/bss_load/conn_capab 过滤...
        // 优先 Home SP，其次按 cred priority 排序，选出 selected / selected_home
    }
    // ...省略「无匹配则继续扫」的分支...
    if (selected) {
        selected = pick_best_roaming_partner(wpa_s, selected, selected_cred);
        interworking_connect(wpa_s, selected, 0);               // 直接连
    }
}
```

- **`interworking_credentials_available` 用 `struct wpa_cred` 匹配**：supplicant 的凭证模型（`cred` 块，含 realm、roaming_consortium、imsi、domain 等）和 Android 的 `PasspointProvider` 是**两套平行世界**——字段级逐项对照：`wpa_cred` 的 `realm`/`roaming_consortiums`/`imsi`/`domain` 依次对应 `credential.realm`/`homeSp.roamingConsortiumOis`/`credential.simCredential`/`homeSp.fqdn`。
- **选完就 `interworking_connect` 直接连**，中间没有「提名 → 打分 → 和普通 WiFi 竞争」的环节——这是它和 Android 流程最本质的分歧。

那么 Android 为什么不用它？三个设计约束：

**① 并入统一的 `WifiNetworkSelector` 选网。** Android 的自动连接不是「Passpoint 单独选，普通 WiFi 单独选」，而是**所有网络（已保存、建议、Passpoint、当前连接）进同一个打分池**，由 `WifiNetworkSelector` 统一裁决（第 6 章已见：Passpoint 候选被当作参数喂给其它 nominator）。supplicant 的 `interworking_select` 是一条「选完就自己连」的旁路，一旦用它，Passpoint 就绕过了 `WifiNetworkSelector`，破坏「统一选网」这个架构前提。

**② 凭证要持久化到自己的数据库，而不是 supplicant 的 cred 块。** Android 的 Passpoint 凭证存在 `PasspointProvider` 里，经 `WifiConfigStore` 持久化（`PasspointConfigSharedStoreData` 写 XML、证书私钥进 KeyStore），并受 AppOps、permission、carrier 配置、多用户等 Framework 机制管理。supplicant 的 `struct wpa_cred` 是它的私有内存模型，把凭证塞进去等于把「凭证生命周期管理」让渡给一个不知道 App 边界的 C 进程。

**③ 支持用户交互。** `interworking_select` 的 `auto_select` 是个二值开关：自动选，或者不自动选。而 Android 需要更细的粒度——用户可以手动在 Wifi Picker 里看到「这个 Passpoint 热点属于哪家运营商」（`updatePasspointConfig` 就为 Wifi Picker 显示服务，消费点是 `WifiPickerTracker.updatePasspointConfigurations()`，`WifiPickerTracker.java:1203`）、可以禁用一个 profile 的 autojoin、可以手动选一张卡连一个不在自动范围内的网络。这些交互都要求「匹配结果」停留在 Java 层，能被 UI 层消费。

一句话总结这个设计取舍：**supplicant 的 `interworking.c` 是为「wpa_supplicant 作为独立守护进程、自主选网」时代设计的；Android 的架构是「Framework 是大脑、supplicant 是手」——所以 Android 只借了 supplicant 最擅长的那只手（ANQP 帧收发），把大脑（匹配、提名、打分）留在了自己这边。** 这也是为什么第 3、4 章里 supplicant 全程只做了「组帧、发帧、解析、回传」，没有一处碰过「匹配」。

顺带一个「规范已删、AOSP 遗留」的对照：OSU（在线签约）在 Passpoint 规范 v3.4 里已经整章删除（连同 OSEN/SPP/Policy Update，见 §1.1 的版本矩阵），但 AOSP 仍保留 `PasspointProvisioner`——一个 8 状态的签约状态机，配套 `soap/`、`omadm/` 两套 SOAP/OMA-DM 协议栈。这是「规范演进快于代码清理」的典型遗留，本文不展开，只提醒读者：**看 AOSP 的 Passpoint 目录时，别把 `PasspointProvisioner` 当成「当前规范的一部分」**。

---

# 8 驱动纯透传——GAS 帧在 QCOM 和 MTK 怎么「过」而不「解」

> 从第 3 章 `offchannel_send_action` 到第 4 章 `anqp_resp_cb` 之间，隔着一整层驱动。这一层的态度出奇一致：**GAS 帧就是一坨普通的管理帧，进来就转手，既不组 ANQP，也不解 ANQP**。QCOM 和 MTK 两家的实现路径不同，结论相同。

先说下行（发 GAS 请求）。supplicant 的 `offchannel_send_action` 最终落到 nl80211 的 `NL80211_CMD_FRAME`，内核 `cfg80211` 再回调驱动注册的 `.mgmt_tx`。两家的入口都是「通用管理帧发送」，没有任何 Passpoint/ANQP 特化：

| 平台     | cfg80211 `.mgmt_tx` 回调                          | 落地函数                                                     | 对 GAS 的处理                                                |
| -------- | ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **QCOM** | `wlan_hdd_mgmt_tx`（`wlan_hdd_cfg80211.c:27309`） | 通用管理帧发送路径                                           | 当作普通 Action 帧下发，不解析 payload                       |
| **MTK**  | `mtk_cfg80211_mgmt_tx`（`gl_cfg80211.c:2934`）    | `_mtk_cfg80211_mgmt_tx` → 组 `MSG_MGMT_TX_REQUEST`（`gl_cfg80211.c:2781`） | 同上；大帧（>1600B）走 `_mtk_cfg80211_mgmt_tx_via_data_path` 数据通道旁路 |

- **MTK 有个值得注意的细节**：`_mtk_cfg80211_mgmt_tx` 里对超长管理帧（`len > u2MgmtTxMaxLen`，约 1600 字节，受 WFDMA 条目大小限制）改走数据通道 `_mtk_cfg80211_mgmt_tx_via_data_path`，绕过 MCU。GAS Comeback Response 分片可能很长，这条旁路就是为它准备的。
- **发请求时驱动不知道也不关心 payload 是 ANQP**：它看到的只是 `buf` + `len` + `offchan` 标志，原样丢给固件去空口发——像邮差不拆信，只按地址投递。

上行（收 GAS 响应）更能看出「透传」的本质。GAS Response 是 **Public Action 帧**（category 4），驱动在**未关联、无会话**的态下收到它，两家的处理都是「认出来、转手给 supplicant」：

```c
// QCOM: qcacld-3.0/core/mac/src/pe/lim/lim_process_action_frame.c:2235
void lim_process_action_frame_no_session(struct mac_context *mac, uint8_t *pBd)
{
    switch (action_hdr->category) {
    case ACTION_CATEGORY_PUBLIC:
        switch (action_hdr->actionID) {
        case SIR_MAC_ACTION_GAS_INITIAL_REQUEST:
        case SIR_MAC_ACTION_GAS_INITIAL_RESPONSE:
        case SIR_MAC_ACTION_GAS_COMEBACK_REQUEST:
        case SIR_MAC_ACTION_GAS_COMEBACK_RESPONSE:
            // 把 GAS 帧整帧转发给 wpa_supplicant（type 为 ACTION）
            lim_send_sme_mgmt_frame_ind(mac, mac_hdr->fc.subType,
                    (uint8_t *) mac_hdr, frame_len + sizeof(tSirMacMgmtHdr), 0,
                    WMA_GET_RX_FREQ(pBd), WMA_GET_RX_RSSI_NORMALIZED(pBd),
                    RXMGMT_FLAG_NONE);
            break;
        default:
            break;   // 其它 Public Action 帧不处理
        }
        break;
    }
}
```

- **QCOM 只认「是不是 GAS」四个 action ID**（Initial Request/Response、Comeback Request/Response），认出来就 `lim_send_sme_mgmt_frame_ind` 整帧上传，最终经 `cfg80211_rx_mgmt` 回 supplicant。它**不解析 ANQP 元素**——那堆 Info ID 对驱动是黑盒。
- **注释写得直白**：`Forward the GAS frames to wpa_supplicant`。驱动的职责边界画得清清楚楚：GAS 的解析交给 supplicant 的 `anqp_resp_cb`。

MTK 的收侧更「佛系」——所有 Action 帧一律转手：

```c
// MTK: kernel_modules-connectivity-wlan-core-gen4m/mgmt/ais_fsm.c:8394
void aisFuncValidateRxActionFrame(struct ADAPTER *prAdapter, struct SW_RFB *prSwRfb)
{
    // ...省略 BSS index 校验...
    /* All action frames indicate to wpa_supplicant */
    /* Leave the action frame to wpa_supplicant. */
    kalIndicateRxMgmtFrame(prAdapter, prAdapter->prGlueInfo, prSwRfb, ucBssIndex);
    return;
}
```

- **MTK 连 GAS 的 action ID 都懒得认**：`aisFuncValidateRxActionFrame` 对所有 Action 帧统一 `kalIndicateRxMgmtFrame` 上报，分拣（GAS、WPS、P2P、DPP 各是哪种 Action）完全交给上层。注释 `All action frames indicate to wpa_supplicant` 把这层「透传」策略写在了脸上。

**双平台对照的结论**：QCOM 在「无会话」态下精确识别 GAS 四个 action ID 再转发（多一层分类，但也不解析 ANQP）；MTK 干脆所有 Action 帧一律透传（零分类，零解析）。**策略细节不同，但「驱动不解 ANQP」是两家共同的铁律**——ANQP 的组帧和解析，一头在 supplicant（第 3、4 章），一头在 AP 侧，驱动只是中间那个不拆信的邮差。

---

# 9 总结——一条「发现 → 查询 → 匹配 → 提名 → 连接」的链

把整条链收拢成一张精确的调用链图（每一步都来自前文验证过的源码）。看图先抓三个结构点：两条 `── AIDL 边界 ──` 把整条链切成**下行**（Java → supplicant → 驱动 → 空口）与**上行**（空口 → 驱动 → supplicant → Java）两段，中间的 `// ... AP 回 GAS Initial Response ...` 是空口往返，`// ... 下一轮扫描 ...` 标注缓存命中后的**回环**：

```
[扫描结果 ScanResult]
  → NetworkDetail 构造（解析 Interworking / HS2.0 Indication / Roaming Consortium IE）
  → PasspointNetworkNominateHelper.filterAndUpdateScanDetails（isInterworking + getHSRelease 过滤）
  → WifiNetworkSelector.getCandidatesFromScan
    → PasspointManager.getAllMatchedProviders（查 AnqpCache）
      → 缓存 miss → ANQPRequestManager.requestANQPElements（排队 + hold-off）
        → PasspointEventHandler.requestANQP（元素枚举 → ANQP ID / HS2.0 subtype）
          → ClientModeImpl.requestAnqp → WifiNative.requestAnqp
            → SupplicantStaIfaceHal.initiateAnqpQuery
              ── AIDL 边界（ISupplicantStaIface.initiateAnqpQuery）──
              → StaIface::initiateAnqpQueryInternal → anqp_send_req
                → gas_query_req → radio_add_work → gas_query_start_cb
                  → gas_query_tx → offchannel_send_action → nl80211 NL80211_CMD_FRAME
                    → 驱动 .mgmt_tx（QCOM wlan_hdd_mgmt_tx / MTK mtk_cfg80211_mgmt_tx）
                      → 空口 GAS Initial Request
    // ... AP 回 GAS Initial Response（可能 Comeback 分片）...
                    → 驱动收 Public Action 帧（QCOM lim_process_action_frame_no_session / MTK aisFuncValidateRxActionFrame）
                  → cfg80211_rx_mgmt → 回 supplicant
                → anqp_resp_cb（interworking_parse_rx_anqp_resp 解析）
                  → wpas_notify_anqp_query_done → wpas_aidl_notify_anqp_query_done
              ── AIDL 边界（ISupplicantStaIfaceCallback.onAnqpQueryDone）──
            → SupplicantStaIfaceCallbackAidlImpl.onAnqpQueryDone
              → WifiMonitor.broadcastAnqpDoneEvent → ClientModeImpl
                → PasspointManager.notifyANQPDone → CallbackHandler.onANQPResponse
                  → ANQPRequestManager.onRequestCompleted + AnqpCache.addOrUpdateEntry
  // ... 下一轮扫描 ...
  → getAllMatchedProviders（缓存命中）
    → PasspointProvider.match（matchFqdnAndRcoi + ANQPMatcher 四条线索）
      → 命中 → getWifiConfig（生成 WifiConfiguration）
        → PasspointNetworkNominateHelper.createWifiConfigForProvider（补 SSID → addOrUpdateNetwork）
          → WifiNetworkSelector 打分（passpointCandidates 喂给各 nominator）
            → 胜出 → 普通连接（复用《STA 连接》：AIDL → select_network → auth/assoc → EAP → 四次握手）
```

**设计亮点回顾**：

1. **解析与决策分离**：`NetworkDetail` 只「抄招牌」（解析 IE），`PasspointProvider` 只「比对会员卡」（匹配），`PasspointNetworkNominateHelper` 只「提名」，`WifiNetworkSelector` 只「打分」——每一层的职责边界都画得干净，没有任何一个类包揽所有事。
2. **supplicant 被降级为「传输通道」**：Android 只借 `initiateAnqpQuery` 这条 AIDL 让 supplicant 收发 ANQP 帧，弃用其完整的 `interworking.c` 选网引擎（第 7 章的三个约束）。这是本文最重要的架构事实——**Framework 是大脑，supplicant 是手**。
3. **跨多轮扫描的流水线**：ANQP 查询是异步的，「这轮查到答案 → 下轮扫描才匹配 → 再下轮才连接」。`AnqpCache` 用四元组 key 让「问过一个 BSS，整张大网复用答案」成为可能，`ANQPRequestManager` 用 hold-off 避免反复骚扰不搭理的 AP。
4. **驱动纯透传**：GAS 帧对驱动是黑盒，QCOM 精确识别四个 action ID、MTK 一律转手，但**两家都不解析 ANQP**——ANQP 语义只存在于 supplicant 和 AP 两侧。

**异常路径（选几条最关键的）**：查询失败（`anqp_result = "FAILURE"`，`onANQPResponse` 收到 `anqpElements == null`）→ `onRequestCompleted` 记录 hold-off，指数退避到最长 640 秒；AP 不搭话 → 2 秒超时 Alarm 放行下一个请求；SIM 凭证对不上插卡 → `match` 直接 `None`；EAP 认证失败 → `isProviderBlocked` 在重认证延迟期内拉黑整个 provider；WAN 链路 down（`HSWANMetricsElement`）→ `isApWanLinkStatusDown` 过滤掉该候选。

**关键常量速查表**：

| 常量                                | 值    | 定义位置                                 | 含义                                 |
| ----------------------------------- | ----- | ---------------------------------------- | ------------------------------------ |
| `BASE_HOLDOFF_TIME_MILLISECONDS`    | 10000 | `ANQPRequestManager.java:73`             | hold-off 起步时长（10 秒）           |
| `MAX_HOLDOFF_COUNT`                 | 6     | `ANQPRequestManager.java:82`             | hold-off 最大翻倍次数（最长 640 秒） |
| `ANQP_REQUEST_ALARM_INTERVAL_MS`    | 2000  | `ANQPRequestManager.java:44`             | 查询超时（2 秒）                     |
| `CACHE_SWEEP_INTERVAL_MILLISECONDS` | 60000 | `AnqpCache.java:36`                      | ANQP 缓存清理周期（60 秒）           |
| `SCAN_DETAIL_EXPIRATION_MS`         | 60000 | `PasspointNetworkNominateHelper.java:68` | 扫描详情缓存过期（60 秒）            |
| `SECURITY_TYPE_PASSPOINT_R1_R2`     | 11    | `WifiConfiguration.java:518`             | Passpoint R1/R2 安全类型             |
| `SECURITY_TYPE_PASSPOINT_R3`        | 12    | `WifiConfiguration.java:526`             | Passpoint R3 安全类型                |

**ANQPElementType 枚举速查表**（§2 的 R1/R2 基础集，元素 ID 来自 `Constants.java`）：

| 枚举值                   | 元素 ID | 类型      | 含义                              |
| ------------------------ | ------- | --------- | --------------------------------- |
| `ANQPVenueName`          | 258     | 标准 ANQP | 场馆名                            |
| `ANQPRoamingConsortium`  | 261     | 标准 ANQP | 漫游联盟 OI（`rcOIs` 为真时追加） |
| `ANQPIPAddrAvailability` | 262     | 标准 ANQP | IP 地址可用性                     |
| `ANQPNAIRealm`           | 263     | 标准 ANQP | NAI 域（开户行）                  |
| `ANQP3GPPNetwork`        | 264     | 标准 ANQP | 3GPP 蜂窝网络                     |
| `ANQPDomName`            | 268     | 标准 ANQP | 域名                              |
| `HSFriendlyName`         | 3       | HS2.0     | 运营商友好名                      |
| `HSWANMetrics`           | 4       | HS2.0     | WAN 指标                          |
| `HSConnCapability`       | 5       | HS2.0     | 连接能力                          |
| `HSOSUProviders`         | 8       | HS2.0     | OSU 提供商列表（R2 基础集）       |

**跨层字段映射表**（「漫游联盟 OI」这份信息在四层各登记一次）：

| 层                       | 字段/结构                                                    | 位置                                               |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------------- |
| 扫描结果（Java）         | `NetworkDetail.mRoamingConsortiums` / `mAnqpOICount`         | `NetworkDetail.java:372-373`                       |
| ANQP 查询（Java）        | `Constants.ANQPElementType.ANQPRoamingConsortium`            | `Constants.java:53`                                |
| supplicant BSS 缓存（C） | `struct wpa_bss_anqp` 的 `roaming_consortium`                | `anqp_resp_cb` → `interworking_parse_rx_anqp_resp` |
| 凭证（Java）             | `PasspointConfiguration.getHomeSp().getRoamingConsortiumOis()` | `PasspointProvider.java:954`                       |

这一章，我们把「免手动连接」从扫描结果追到了统一选网——手机认出连锁店招牌、借跑堂隔空问询、总部比对会员卡、选店委员会拍板、刷卡进闸。但有个前提一直悬着：**这张「会员卡」第一次是怎么装进手机的？** 历史上其实有三条路：

1. **出厂预装**——运营商把凭证作为系统预置数据塞进设备，用户拿到手机时「卡」已经在了（类比 SIM 卡，插卡即用），这是 Passpoint 部署的默认形态。
2. **手动导入**——拿到一个 Passpoint 配置（`PasspointConfiguration`），通过系统设置或 App 调 `addOrUpdatePasspointConfiguration` 装进去，机场、酒店、企业 IT 下发配置走这条。
3. **在线签约（OSU）**——设备第一次走到 Passpoint 热点时现场办卡：连一个 OSU AP → 打开签约网页（WebView）→ 填信息 → 服务器下发凭证，这条路要 SOAP + OMA-DM 两套协议栈 + 证书下载，是三条里最重的一条。

而第 3 条（OSU）正是被规范 v3.4 整章删除的那条——连同 OSEN/SPP/Policy Update 这些连带项，说明这套在线签约的重量远超「预装 + 导入」的简单路径。于是出现一个反差：**协议说「OSU 不需要了」，AOSP 却还留着 `PasspointProvisioner` 那台 8 状态的签约状态机 + soap/omadm 两套协议栈**——规范演进快于代码清理。

所以放在今天的规范里，「会员卡怎么装进手机」的现役答案只剩前两条路（预装 + 导入），第三条（OSU）已经名存实亡。这也正是本文把 OSU 当「规范已删、AOSP 遗留」的对照、只一笔带过不展开的原因——它已经不是 Passpoint 的现役路径了。

---

**源码仓库**：

- AOSP packages/modules/Wifi: [https://android.googlesource.com/platform/packages/modules/Wifi](https://android.googlesource.com/platform/packages/modules/Wifi)
- AOSP wpa_supplicant_8: [https://android.googlesource.com/platform/external/wpa_supplicant_8](https://android.googlesource.com/platform/external/wpa_supplicant_8)
- QCOM qcacld-3.0: [https://git.codelinaro.org/clo/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0](https://git.codelinaro.org/clo/la/platform/vendor/qcom-opensource/wlan/qcacld-3.0)
- MTK gen4m: [https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)

**相关规范**（`Passpoint Specification v3.4.pdf`）：

- §1.1 Scope（版本矩阵，v3.4 删除 OSU/OSEN/SPP/Policy Update）；§2.2 Required mobile device capabilities
- §3.1.1 HS2.0 Indication element；§4 HS2.0 ANQP-ELEMENTS（§4.1 HS Query List 等）
- §5.4 GAS procedures and addressing；§6.1 Discovery state procedures；§6.1.1 Home SP identification；§6.5 Roaming Consortium membership
- §9.1 PerProviderSubscription MO；§10 Terms and Conditions；附录 B（GAS 查询示例）

> OSU 在线签约在 Passpoint 规范 v3.4 已整章删除（§1.1 版本矩阵），AOSP 仍保留 `PasspointProvisioner` 历史实现，正文见 §7。

