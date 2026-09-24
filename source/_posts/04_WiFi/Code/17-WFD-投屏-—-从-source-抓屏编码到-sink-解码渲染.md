---
title: WFD 投屏 — 从 source 抓屏编码到 sink 解码渲染
top: 1
related_posts: true
abbrlink: bcdd9134
date: 2026-09-24 23:46:38
tags:
  - Android WiFi
  - WFD
categories:
  - WiFi
  - Code
---

> 你点了一下「投屏」，手机画面就出现在了电视上——中间没有一根线。这 200 毫秒里，你的手机其实临时变成了一座微型电视台：抓屏是摄像机，编码是转码，MPEG2-TS 是电视信号，RTP 是发射塔，而电视那头的 MediaPlayer，就是一台现成的接收机。

> 前情提要：《P2P（七）高级特性》追完了 P2P 的组网与运维，结尾留了个问题——两台设备直连之后，能拿这条链路做什么「真本事」？WiFi 最直观的答案就是投屏。姊妹系列《Miracast-无线投屏》已经把协议讲透了（M1-M16、MPEG2-TS、HDCP、UIBC），这篇换一个问题：**协议在 Android 老源码里怎么落地？** 从 P2P 建连完成的那个瞬间开始，追到画面出现在电视上。

---

# 本章导读

投屏这件事，本质上是一个「把手机屏幕变成电视信号」的过程。Wi-Fi Alliance 给它起了个名字叫 **WFD（Wi-Fi Display）**，认证品牌叫 **Miracast**。它的分工一句话就能说清：**source（手机）负责抓屏、编码、打包、发送；sink（电视）负责接收、重排、解包、渲染**。

<!--more-->

但真正有意思的是「怎么协商」「怎么打包」「怎么保证实时」。这三个问题，正好对应这份老源码里三个最反直觉的设计——也是本文要追的三个灵魂问题：

- 为什么 WFD 是「**反向 RTSP**」——source 明明是 RTSP 服务器（响应 SETUP/PLAY），却主动发第一条消息、主动主导协商？
- 为什么音视频要打包成「**MPEG2-TS**」——这明明是 90 年代电视广播的复用格式，跟手机有什么关系？
- 为什么数据面要叠「**RTP + RTCP SR/RR + NACK 重传 + 最小二乘拟合**」这么多层——UDP 丢包了怎么办，音画怎么对齐？

> source 是一座临时搭起来的微型电视台：`SurfaceMediaSource` 是摄像机（把屏幕「拍」成原始帧），`Converter` 是转码台（raw 视频压成 H.264、raw 音频压成 AAC），`TSPacketizer` 是复用器（把音视频打成电视标准的 MPEG2-TS 流），`Sender` 是发射塔（TS 切成 RTP 包发出去）。sink 是一台电视接收机：`RTPSink` 是天线（收包、排序），`TunnelRenderer` 是机顶盒（把有序的 TS 字节流喂给 `MediaPlayer`），`MediaPlayer` 内部的 `ATSParser` 是解复用器（解出 H.264/AAC 再解码上屏）。电视台开播前，要先跟接收机对一遍「制式表」——这就是 RTSP 的 M1-M4。

**本章你将学到：**

- 一条完整的 source → sink 调用链：`listenForRemoteDisplay` → `WifiDisplaySource` → `PlaybackSession` → `TSPacketizer` → `Sender` →（网络）→ `WifiDisplaySink` → `RTPSink` → `TunnelRenderer` → `MediaPlayer`
- 「反向 RTSP」的真相：`WifiDisplaySource` 状态机 11 个状态怎么流转，M1-M16 哪几步是 source 主动发的
- 参数协商的「意料之外」：视频分辨率帧率根本没真正协商，source 在 M4 里写死 720p30；真正讨价还价的是音频格式、HDCP 开关、RTP 端口
- source 流水线五个组件（`SurfaceMediaSource` / `RepeaterSource` / `MediaPuller` / `Converter` / `TSPacketizer`）各自干什么、为什么这么拆
- MPEG2-TS 的 PAT/PMT/PCR/PES 在代码里怎么逐字节拼出来（PID 分配、PTS/PCR 时钟）
- sink 端怎么用 RFC3550 序号重排 + 正交最小二乘拟合估延迟 + NACK 重传做丢包恢复
- 一个容易被忽略的细节：这份代码里的「网络线程」用的是 `select()` 而不是 epoll

> 这是一篇「考古」——Android 4.2.2 的原生 WFD 实现，现代 AOSP 已在 Android 10 移除这套 `WifiDisplayAdapter` 体系，本篇聚焦老源码本身的设计。本文不重讲协议概念（M1-M16 语义、HDCP 密钥协商、UIBC 反控详见姊妹系列 05 篇）；P2P 建连本身（GO 组网、四路握手）在 11 系列已讲透，这里只从「建连完成、拿到 IP」的瞬间接续；sink 侧（`WifiDisplaySink`/`RTPSink`/`TunnelRenderer`）在代码里主要是 `wfd.cpp` 这个测试工具在用，生产主路径是 source（经 media server 的 `listenForRemoteDisplay` 接入），这一点会在第 7 节说明；HDCP（`makeHDCP` 走 `IHDCP`）与 UIBC 只在涉及代码处简略带过。

---

# 1 为什么投屏要用「反向 RTSP」？

先看全貌。从 P2P 建连完成、双方拿到 IP 开始，投屏的整条链分成「控制面」和「数据面」两条独立的线，两端各挂一组类：

![WFD 投屏全局架构](assets/17-WFD-%E6%8A%95%E5%B1%8F-%E2%80%94-%E4%BB%8E-source-%E6%8A%93%E5%B1%8F%E7%BC%96%E7%A0%81%E5%88%B0-sink-%E8%A7%A3%E7%A0%81%E6%B8%B2%E6%9F%93/17-architecture-overview.svg)

**读图要点**：上半是控制面（RTSP over TCP，可靠、要握手），下半是数据面（MPEG2-TS over RTP/UDP，实时、可丢包）。source 侧的组件是一条「抓屏 → 编码 → 打包 → 发送」的流水线，sink 侧是一条「接收 → 重排 → 解包 → 渲染」的逆流水线。注意一个反常点：**TCP 连接是 sink 主动去连 source（source 是 RTSP 服务器，监听 7236 端口），但连上之后，第一条 RTSP 消息是 source 先发的。**

两端分工一张表：

| 端         | 核心类                         | 职责                                    | 备注          |
| ---------- | ------------------------------ | --------------------------------------- | ------------- |
| **source** | `WifiDisplaySource`            | RTSP 服务器 + M1-M16 状态机             | 1596 行，主类 |
|            | `PlaybackSession`              | 每客户一会话，串联音视频 Track          | 1062 行       |
|            | `TSPacketizer`                 | access unit 打 PES + 188B TS            | 883 行        |
|            | `Sender`                       | TS 切 7 包/RTP 头 + RTCP SR + NACK 重传 | 870 行        |
| **sink**   | `WifiDisplaySink`              | RTSP 客户端 + 状态机                    | 644 行        |
|            | `RTPSink`                      | 解 RTP 头 + 序号重排 + LinearRegression | 806 行        |
|            | `TunnelRenderer`               | 有序 TS 字节流喂 MediaPlayer            | 396 行        |
| **共享**   | `ANetworkSession`              | 单线程 select() 管所有 socket           | 1140 行       |
|            | `ParsedMessage` / `Parameters` | 解析 RTSP 消息 / text-parameters 字典   | —             |

先交代一个「入口」：source 是谁拉起来的。用户点投屏后，Framework 的 `WifiDisplayController`/`WifiDisplayAdapter` 那套（在 `frameworks/base`，不在本仓库）拿到 P2P 接口的 IP，经 Binder 调 `IMediaPlayerService::listenForRemoteDisplay(iface)`。

media server 的 `MediaPlayerService::listenForRemoteDisplay` 检查 `CONTROL_WIFI_DISPLAY` 权限后 `new RemoteDisplay(client, iface)`；`RemoteDisplay` 构造函数里 `new WifiDisplaySource(...)` 并 `mSource->start(iface)`，`start` 内部解析 `ip:port`（默认 7236）再 `mNetSession->createRTSPServer(...)` 开始监听。

后面这条链上的所有 socket，都挂在下面这个 `ANetworkSession` 上。

这份代码最底层的 `ANetworkSession`，是所有 socket 的「总调度」。它开一个线程，用 `select()` 把 RTSP 的 TCP 连接、RTP/RTCP 的 UDP 数据报、TCP 直传（datagram）全塞进一个 `fd_set` 里轮询。注意——这里是 `select()`，不是很多文章以为的 epoll：

```cpp
// ANetworkSession.cpp:980  threadLoop()
void ANetworkSession::threadLoop() {
    fd_set rs, ws;
    FD_ZERO(&rs);
    FD_ZERO(&ws);

    FD_SET(mPipeFd[0], &rs);
    int maxFd = mPipeFd[0];

    {
        Mutex::Autolock autoLock(mLock);
        for (size_t i = 0; i < mSessions.size(); ++i) {
            const sp<Session> &session = mSessions.valueAt(i);
            int s = session->socket();
            if (s < 0) continue;
            if (session->wantsToRead())  { FD_SET(s, &rs); /* ...maxFd 更新... */ }
            if (session->wantsToWrite()) { FD_SET(s, &ws); /* ... */ }
        }
    }

    int res = select(maxFd + 1, &rs, &ws, NULL, NULL /* tv */);
    // ...遍历 mSessions，readMore() / writeMore()...
}
```

- `mSessions` 是一个 `KeyedVector<int32_t, sp<Session>>`，每个 socket 一个 `Session` 对象，带 `mState`（`CONNECTING` / `CONNECTED` / `LISTENING_RTSP` / `LISTENING_TCP_DGRAMS` / `DATAGRAM`）。
- 那根 `mPipeFd` 是「唤醒管」：任何线程往 session 里塞了数据（`sendRequest`）都要 `interrupt()` 写一字节到管道，把阻塞在 `select()` 上的网络线程踢醒。
- 为什么用 `select()` 而不是 epoll？因为这台「微型电视台」同时要管的 socket 就几个（1 个 RTSP + 2 个 RTP/RTCP + 偶尔的 TCP 直传），`select()` 简单够用，epoll 的优势（成千上万连接）在这里用不上。

再往上一层，是两端的「状态机」。source 是 RTSP 服务器，状态比 sink 复杂得多：

```cpp
// WifiDisplaySource.h:58
enum State {
    INITIALIZED,
    AWAITING_CLIENT_CONNECTION,   // 已监听，等 sink 连进来
    AWAITING_CLIENT_SETUP,        // 已连上，等 sink 发 SETUP
    AWAITING_CLIENT_PLAY,         // 已回 SETUP，等 sink 发 PLAY
    ABOUT_TO_PLAY,                // 已回 PLAY，等 PlaybackSession 建好
    PLAYING,
    PLAYING_TO_PAUSED,
    PAUSED,
    PAUSED_TO_PLAYING,
    AWAITING_CLIENT_TEARDOWN,     // 已发 TEARDOWN 触发，等 sink 真拆
    STOPPING,
    STOPPED,
};
```

- 11 个状态，对应「一次投屏」从监听、协商、开播、暂停、恢复、到拆台的全生命周期。
- `AWAITING_CLIENT_SETUP → AWAITING_CLIENT_PLAY → ABOUT_TO_PLAY → PLAYING` 这条主线，是 M5/M6/M7 三次握手推动的。

现在回答本节标题的灵魂问题：**为什么 source 是 RTSP 服务器，却要主动发第一条消息、主动主导协商？** 答案是规范逼的，也是业务逼的：

规范层面，Miracast 规范 §6 开门见山写了这么一段：

> Since the RTSP specification does not allow an RTSP server to initiate the SETUP, PLAY, PAUSE or TEARDOWN methods, this specification uses SET_PARAMETER messages with a `wfd-trigger-method` parameter to enable the RTSP server to trigger the client into initiating control operations while still maintaining compliance with RFC2326.

翻译成人话：标准 RTSP 里，只有**客户端**能发起 SETUP/PLAY/PAUSE/TEARDOWN。但 WFD 里 source 才是内容提供方、才需要主动推进流程，于是它打了个「擦边球」——OPTIONS / GET_PARAMETER / SET_PARAMETER 这三个方法 RTSP 允许**任何一方**主动发，source 就用它们来主导：M1（OPTIONS）、M3（GET_PARAMETER）、M4（SET_PARAMETER）、M5（SET_PARAMETER 带 `wfd-trigger-method`）、M16（GET_PARAMETER 保活）。真正的 SETUP/PLAY/PAUSE/TEARDOWN，仍是 sink 发的，只是被 source 的 M5 触发。

业务层面更直接：**source 是「内容供货商」，它必须主动探知 sink 的显示/音频能力，才能决定自己用什么参数编码。** 一台电视支持 1080p 还是 720p、支持 AAC 还是 LPCM、要不要 HDCP 加密，source 不主动问，sink 是不会主动报的（sink 是「被动显示端」）。所以协商由 source 主导，是「谁出内容谁定规则」的自然结果。

# 2 M1-M4 怎么发出去、响应怎么匹配回来？——能力协商的代码

理解了「反向 RTSP」，再看代码怎么把 M1-M4 发出去、响应怎么匹配回来。这一节是整条链的「开场白」。

## 2.1 source 主动发 M1：一条 OPTIONS 打开局面

sink 通过 `createRTSPClient` 连上 source 的 7236 端口后，`ANetworkSession` 给 source 发一个 `kWhatClientConnected` 通知，source 的状态机从 `AWAITING_CLIENT_CONNECTION` 跳进 `AWAITING_CLIENT_SETUP`，随即发出 M1：

```cpp
// WifiDisplaySource.cpp:513  sendM1()
status_t WifiDisplaySource::sendM1(int32_t sessionID) {
    AString request = "OPTIONS * RTSP/1.0\r\n";
    AppendCommonResponse(&request, mNextCSeq);

    request.append(
            "Require: org.wfa.wfd1.0\r\n"
            "\r\n");

    status_t err =
        mNetSession->sendRequest(sessionID, request.c_str(), request.size());

    if (err != OK) {
        return err;
    }

    registerResponseHandler(
            sessionID, mNextCSeq, &WifiDisplaySource::onReceiveM1Response);

    ++mNextCSeq;

    return OK;
}
```

- 关键字段是 `Require: org.wfa.wfd1.0`——这是 WFD 的「暗号」，告诉对端「这是 WFD 会话，不是普通 RTSP 点播」。
- 发出去之前，用 `registerResponseHandler(sessionID, cseq, 回调)` 把「这条请求的 cseq」登记进 `mResponseHandlers`。这是 RTSP 异步响应匹配的核心机制。

`mResponseHandlers` 就是 source 和 sink 两端都有的那张「响应路由表」：

```cpp
// WifiDisplaySource.h:87
struct ResponseID {
    int32_t mSessionID;
    int32_t mCSeq;

    bool operator<(const ResponseID &other) const {
        return mSessionID < other.mSessionID
            || (mSessionID == other.mSessionID && mCSeq < other.mCSeq);
    }
};

// WifiDisplaySource.h:140
KeyedVector<ResponseID, HandleRTSPResponseFunc> mResponseHandlers;
```

- RTSP 是「一问一答」的文本协议，一个 TCP 连接上可以有多条请求在飞（尤其 M16 保活和 M5 触发可能交错）。怎么知道回来的响应对应哪条请求？就靠 **CSeq**（每次 `++mNextCSeq` 递增）。
- `ResponseID` 用 `(sessionID, cseq)` 二元组做 key，`HandleRTSPResponseFunc` 是成员函数指针。响应回来时 `onReceiveClientData` 用同样的二元组去 `indexOfKey`，查到就调用对应的 `onReceiveMxResponse`，查不到就是「不请自来的响应」，直接丢弃。

## 2.2 M3 问能力、M4 定参数

M3 是 source 问 sink「你能干啥」，问四样东西：

```cpp
// WifiDisplaySource.cpp:536  sendM3()
AString body =
    "wfd_content_protection\r\n"
    "wfd_video_formats\r\n"
    "wfd_audio_codecs\r\n"
    "wfd_client_rtp_ports\r\n";

AString request = "GET_PARAMETER rtsp://localhost/wfd1.0 RTSP/1.0\r\n";
// ... Content-Type: text/parameters + body ...
```

- 问的四个参数，对应 sink 的四项能力：内容保护（HDCP）、视频格式、音频编解码、RTP 端口。
- `text/parameters` 是 WFD 自己定义的 `name: value\r\n` 键值对格式，由 `Parameters::Parse` 解析成字典。

M4 是 source 收到 sink 的 M3 响应后，拍板「咱俩就用这些参数」。真正的「协商」发生在 `onReceiveM3Response` 里——这里藏着一个反直觉的真相：

```cpp
// WifiDisplaySource.cpp:802  onReceiveM3Response() 内的音频协商
uint32_t modes;
GetAudioModes(value.c_str(), "AAC", &modes);
bool supportsAAC = (modes & 1) != 0;  // AAC 2ch 48kHz

GetAudioModes(value.c_str(), "LPCM", &modes);
bool supportsPCM = (modes & 2) != 0;  // LPCM 2ch 48kHz

char val[PROPERTY_VALUE_MAX];
if (supportsPCM
        && property_get("media.wfd.use-pcm-audio", val, NULL)
        && (!strcasecmp("true", val) || !strcmp("1", val))) {
    ALOGI("Using PCM audio.");
    mUsingPCMAudio = true;
} else if (supportsAAC) {
    ALOGI("Using AAC audio.");
    mUsingPCMAudio = false;
} else if (supportsPCM) {
    ALOGI("Using PCM audio.");
    mUsingPCMAudio = true;
} else {
    ALOGI("Sink doesn't support an audio format we do.");
    return ERROR_UNSUPPORTED;
}
```

- **视频根本没协商**。`wfd_video_formats` 里 source 在 M4 里直接写死：`USE_1080P` 为 0 时是 `"28 00 02 02 00000020 ..."`（720p30），为 1 时是 `"38 00 ... 00000080"`（1080p30）。分辨率、帧率、profile 全是硬编码。
- 真正讨价还价的三样是：**音频编解码**（AAC vs LPCM，上面这段）、**HDCP 开关**（`wfd_content_protection` 是 `none` 还是 `HDCP2.0/2.1`）、**RTP 端口**（`wfd_client_rtp_ports`，sink 报它监听哪个端口，source 用 `sscanf` 抠出来存进 `mChosenRTPPort`）。
- 为什么视频不协商？这是老 Android 4.2.2 的偷懒：source 自己就是编码器，它只编 720p30（或编译时开 1080p），没必要迁就 sink 的解码能力——「我编啥你放啥」。现代 Miracast 的 wfd-video-formats 才是真正在协商：sink 在 M3 里用 Profiles/Levels 位图各置一位报 H.264 profile（CBP/CHP）与 level（3.1~4.2），source 在 M4 里按 §6.1.3 挑一个双方都支持的组合；这份老代码却把位图写死，等于没协商。

## 2.3 M4 拍板后的参数长什么样

`sendM4` 里拼出来的 body，就是 source 对 sink 的「最终报价」：

```cpp
// WifiDisplaySource.cpp:602  sendM4() 内的 body 构造
AString body = StringPrintf(
    "wfd_video_formats: "
#if USE_1080P
    "38 00 02 02 00000080 00000000 00000000 00 0000 0000 00 none none\r\n"
#else
    "28 00 02 02 00000020 00000000 00000000 00 0000 0000 00 none none\r\n"
#endif
    "wfd_audio_codecs: %s\r\n"
    "wfd_presentation_URL: rtsp://%s/wfd1.0/streamid=0 none\r\n"
    "wfd_client_rtp_ports: RTP/AVP/%s;unicast %d 0 mode=play\r\n",
    (mUsingPCMAudio
        ? "LPCM 00000002 00" // 2 ch PCM 48kHz
        : "AAC 00000001 00"),  // 2 ch AAC 48kHz
    mClientInfo.mLocalIP.c_str(), transportString.c_str(), mChosenRTPPort);
```

- `wfd_video_formats` 那串十六进制，按规范 §6.1.3 的 ABNF 是 `native + preferred-display-mode-supported + H.264-codec(profile/level/CEA/VESA/HH/latency/...)` 逐字段拼出来的。`28` 是 native 分辨率位图（对应 720p），`02 02` 是 profile/level，后面 `00000020` 是 CEA 支持掩码，`none none` 是 max-hres/max-vres。
- `wfd_presentation_URL` 给 sink 一个 `rtsp://.../wfd1.0/streamid=0` 的 URI，告诉它 M6 SETUP 该请求哪个流。
- `wfd_client_rtp_ports` 把 source 选中的端口回填给 sink。

## 2.4 收到响应怎么路由：onReceiveClientData 的「二分法」

所有进到 source 的 RTSP 数据，都汇到 `onReceiveClientData`，它用「请求行的第一个 token 是不是 `RTSP/` 开头」来区分「这是响应还是请求」：

```cpp
// WifiDisplaySource.cpp:936  onReceiveClientData()
AString method;
data->getRequestField(0, &method);

if (method.startsWith("RTSP/")) {
    // 这是响应：用 (sessionID, cseq) 去 mResponseHandlers 里找回调
    ResponseID id;
    id.mSessionID = sessionID;
    id.mCSeq = cseq;
    ssize_t index = mResponseHandlers.indexOfKey(id);
    if (index < 0) {
        ALOGW("Received unsolicited server response, cseq %d", cseq);
        return ERROR_MALFORMED;
    }
    HandleRTSPResponseFunc func = mResponseHandlers.valueAt(index);
    mResponseHandlers.removeItemsAt(index);
    status_t err = (this->*func)(sessionID, data);
    // ... 回调返回非 OK 时记日志并返回错误 ...
} else if (method == "OPTIONS") {
    err = onOptionsRequest(sessionID, cseq, data);
} else if (method == "SETUP") {
    err = onSetupRequest(sessionID, cseq, data);
} else if (method == "PLAY") {
    err = onPlayRequest(sessionID, cseq, data);
// ... PAUSE/TEARDOWN/GET_PARAMETER/SET_PARAMETER 各自分派到 onXxxRequest ...
} else {
    sendErrorResponse(sessionID, "405 Method Not Allowed", cseq);
}
```

- 响应路径：`mResponseHandlers.indexOfKey` + `removeItemsAt`——找到即消费，一次性的，防止重复响应。
- 请求路径：按方法名分派到 `onXxxRequest`。source 实现的方法有 OPTIONS/SETUP/PLAY/PAUSE/TEARDOWN/GET_PARAMETER/SET_PARAMETER 七个，对应它在 `Public:` 头里广播的能力。
- 有个细节呼应「反向 RTSP」：source 收到 sink 的 OPTIONS（M2）时，`onOptionsRequest` 回完 200 后**顺手发 M3**——这正是「协商由 source 主导」的代码体现：

```cpp
// WifiDisplaySource.cpp:1041  onOptionsRequest() 尾部
status_t err = mNetSession->sendRequest(sessionID, response.c_str());
if (err == OK) {
    err = sendM3(sessionID);
}
```

至此，M1-M4 的完整时序是：**source 发 M1（OPTIONS）→ sink 回 200 并发 M2（自己的 OPTIONS）→ source 回 200 并发 M3（GET_PARAMETER）→ sink 回 M3 响应（报能力）→ source 发 M4（SET_PARAMETER 定参数）→ sink 回 200。** 之后 M5 触发 SETUP，M6/M7 由 sink 发起，会话才真正建立。

![RTSP M1-M7 消息时序](assets/17-WFD-%E6%8A%95%E5%B1%8F-%E2%80%94-%E4%BB%8E-source-%E6%8A%93%E5%B1%8F%E7%BC%96%E7%A0%81%E5%88%B0-sink-%E8%A7%A3%E7%A0%81%E6%B8%B2%E6%9F%93/17-rtsp-sequence.svg)

**读图要点**：实线箭头是「谁主动发」，虚线是「回应」。注意 M1/M3/M4/M5 全是 source 发起的（橙色，控制面），而 M6 SETUP、M7 PLAY 是 sink 发起的（蓝色）——但 M6/M7 是被 M5 的 `wfd_trigger_method` 触发的，所以 sink 本质上是被 source 牵着走。

# 3 source 的媒体流水线是怎么串起来的？——从抓屏到编码

M7 的 PLAY 被 sink 发来后，source 进入 `PLAYING`，媒体流水线才真正启动。这条流水线由 `PlaybackSession` 串起来——**每个客户一个 `PlaybackSession`**，它是 source 侧媒体链的「总装配线」。

## 3.1 PlaybackSession：每客户一会话

`PlaybackSession` 在 M6 SETUP 时被创建（`onSetupRequest` 里 `new PlaybackSession(...)` 然后 `init`），它内部先建 `Sender`（发数据），再建 `TSPacketizer`（打包），最后加音视频两条 Track：

```cpp
// PlaybackSession.cpp:642  setupPacketizer()
status_t WifiDisplaySource::PlaybackSession::setupPacketizer(bool usePCMAudio) {
    mPacketizer = new TSPacketizer;

    status_t err = addVideoSource();
    if (err != OK) {
        return err;
    }
    return addAudioSource(usePCMAudio);
}
```

- 顺序固定：先 `TSPacketizer`（复用器），再视频源，再音频源。所以 `mTracks` 里 index 0 是视频、index 1 是音频，`mVideoTrackIndex = 0`。
- 每条 Track 内部是一条「`MediaPuller` 拉 → `Converter` 转 → 产出 access unit」的独立流水线，各跑各的 looper 线程。

![source 端媒体流水线](assets/17-WFD-%E6%8A%95%E5%B1%8F-%E2%80%94-%E4%BB%8E-source-%E6%8A%93%E5%B1%8F%E7%BC%96%E7%A0%81%E5%88%B0-sink-%E8%A7%A3%E7%A0%81%E6%B8%B2%E6%9F%93/17-source-pipeline.svg)

**读图要点**：蓝色是数据流方向（抓屏 → 编码 → 打包 → 发送），橙色是控制/调度（`drainAccessUnits` 按最小时间戳交织 A/V）。两条 Track（视频/音频）各自独立跑，最后在 `drainAccessUnits` 汇合。

视频源怎么来？关键在 `addVideoSource`：

```cpp
// PlaybackSession.cpp:738  addVideoSource()
sp<SurfaceMediaSource> source = new SurfaceMediaSource(width(), height());
source->setUseAbsoluteTimestamps();

sp<RepeaterSource> videoSource =
    new RepeaterSource(source, 30.0 /* rateHz */);

size_t numInputBuffers;
status_t err = addSource(
        true /* isVideo */, videoSource, true /* isRepeaterSource */,
        false /* usePCMAudio */, &numInputBuffers);
// ...
mBufferQueue = source->getBufferQueue();
```

- `SurfaceMediaSource(width(), height())` 建一块**虚拟屏**（1280×720 或 1080p）。这块虚拟屏的 `BufferQueue` 会被一路传回 Framework（`onDisplayConnected` 里 `mClient->onDisplayConnected(getSurfaceTexture(), ...)`），Framework 把要投屏的内容画到这块虚拟屏上，source 就「抓」到了画面。
- `setUseAbsoluteTimestamps()` 让帧带绝对时间戳，后面做 PTS 才有基准。
- `width()/height()` 由 `USE_1080P` 宏决定：0 时 1280×720，1 时 1920×1080。

音频源更简单，直接抓「系统混音」：

```cpp
// PlaybackSession.cpp:772  addAudioSource()
sp<AudioSource> audioSource = new AudioSource(
        AUDIO_SOURCE_REMOTE_SUBMIX,   // 抓系统整体播放的声音
        48000 /* sampleRate */,
        2 /* channelCount */);
```

- `AUDIO_SOURCE_REMOTE_SUBMIX` 是 Android 的「远端子混音」设备，专门用于投屏/录屏抓系统所有播放声音。对应 `wfd.cpp` 里的 `enableAudioSubmix()` 要先把 `AUDIO_DEVICE_IN_REMOTE_SUBMIX` / `AUDIO_DEVICE_OUT_REMOTE_SUBMIX` 两个虚拟设备置为 AVAILABLE。

## 3.2 RepeaterSource：为什么要把「抓屏」包一层恒速重复

`addVideoSource` 里有个容易被忽略的动作：它没有直接把 `SurfaceMediaSource` 交给流水线，而是先包了一层 `RepeaterSource(source, 30.0)`。为什么？

因为**投屏要恒定帧率，而屏幕画面不是匀速更新的**。用户盯着静态页面时，SurfaceFlinger 可能好几秒才推一帧；一旦开始滑动，又可能瞬间挤进来一堆帧。`RepeaterSource` 的作用就是把「按需推送的屏幕帧」变成「30Hz 恒速的帧流」：

```cpp
// RepeaterSource.cpp:89  read()
for (;;) {
    int64_t bufferTimeUs = -1ll;
    if (mStartTimeUs < 0ll) {
        // 第一帧：等底层真的有帧可读
        Mutex::Autolock autoLock(mLock);
        while ((mLastBufferUpdateUs < 0ll || mBuffer == NULL)
                && mResult == OK) {
            mCondition.wait(mLock);
        }
        mStartTimeUs = ALooper::GetNowUs();
        bufferTimeUs = mStartTimeUs;
    } else {
        // 后续帧：按 30Hz 推算该出帧的时间，没到就 usleep
        bufferTimeUs = mStartTimeUs + (mFrameCount * 1000000ll) / mRateHz;
        int64_t nowUs = ALooper::GetNowUs();
        int64_t delayUs = bufferTimeUs - nowUs;
        if (delayUs > 0ll) {
            usleep(delayUs);
        }
    }
    // ... 取 mBuffer，add_ref，标 kKeyTime = bufferTimeUs，++mFrameCount ...
}
```

- `mRateHz = 30.0`，所以每帧间隔 `1000000 / 30 ≈ 33333µs`。第 N 帧的时间戳是 `mStartTimeUs + N × 33333µs`。
- 如果底层没有新帧（画面静止），它就**重复推上一帧**（`mBuffer->add_ref()` 同一个 buffer，只是时间戳变了）——这就是「Repeater」（重复器）名字的由来。
- 如果底层有新帧，`onMessageReceived(kWhatRead)` 里 `mCondition.broadcast()` 唤醒等待的读线程。`SUSPEND_VIDEO_IF_IDLE` 宏（值为 1）还控制着「画面静止超过 1 秒就休眠、`wakeUp()` 唤醒」的逻辑。

这个设计的妙处在于：**编码器需要「有规律的输入」才能稳定出帧，而真实屏幕是无规律的。** 用一层 `RepeaterSource` 把「无规律的世界」和「有规律的下游」解耦，编码器拿到的永远是 30Hz 的干净帧流。

## 3.3 MediaPuller：把 MediaBuffer 拉成 ABuffer

`RepeaterSource` 产出的还是旧式 `MediaBuffer`（带引用计数、要手动 release 的裸内存），而 WFD 这条链的下游都用 `ABuffer`（新的引用计数 buffer 对象）。中间需要一个「搬运工」`MediaPuller`：

```cpp
// MediaPuller.cpp:129  onMessageReceived() 的 kWhatPull 分支
MediaBuffer *mbuf;
status_t err = mSource->read(&mbuf);
// ...
int64_t timeUs;
CHECK(mbuf->meta_data()->findInt64(kKeyTime, &timeUs));

sp<ABuffer> accessUnit = new ABuffer(mbuf->range_length());
memcpy(accessUnit->data(),
       (const uint8_t *)mbuf->data() + mbuf->range_offset(),
       mbuf->range_length());
accessUnit->meta()->setInt64("timeUs", timeUs);

if (mIsAudio) {
    mbuf->release();            // 音频：拷贝完立即释放
} else {
    // 视频：把 mbuf 挂在 accessUnit 上，编码器用完再释放
    accessUnit->meta()->setPointer("mediaBuffer", mbuf);
}

sp<AMessage> notify = mNotify->dup();
notify->setInt32("what", kWhatAccessUnit);
notify->setBuffer("accessUnit", accessUnit);
notify->post();
```

- 一个 `kWhatPull` 消息拉一帧，处理完再 `schedulePull()` 发下一条，形成「自驱动」的拉取循环。
- 音视频释放策略不同：音频数据量小、拷贝完就能释放；视频帧大，为避免多一次拷贝，把原始 `mbuf` 挂在 `accessUnit` 的 meta 上，让下游（编码器）用完再 `release()`——这是性能优化。
- `mPullGeneration` 是个「代际计数器」，stop 时 `++mPullGeneration`，旧的 `kWhatPull` 消息发现代际对不上就丢弃，防止停流后还在拉。

## 3.4 Converter：raw 视频转 H.264、raw 音频转 AAC（或 PCM 直通）

`Converter` 是流水线的「转码台」，内部包了一个 `MediaCodec` 编码器。它一进场就决定输出格式：

```cpp
// Converter.cpp:116  initEncoder() 的输出格式决策
if (!strcasecmp(inputMIME.c_str(), MEDIA_MIMETYPE_AUDIO_RAW)) {
    if (mIsPCMAudio) {
        outputMIME = MEDIA_MIMETYPE_AUDIO_RAW;   // PCM 直通，不编码
    } else {
        outputMIME = MEDIA_MIMETYPE_AUDIO_AAC;   // raw → AAC
    }
    isAudio = true;
} else if (!strcasecmp(inputMIME.c_str(), MEDIA_MIMETYPE_VIDEO_RAW)) {
    outputMIME = MEDIA_MIMETYPE_VIDEO_AVC;        // raw → H.264
} else {
    TRESPASS();
}

if (!mIsPCMAudio) {
    mEncoder = MediaCodec::CreateByType(
            mCodecLooper, outputMIME.c_str(), true /* encoder */);
    // ...
}
```

- 视频固定转 H.264（AVC），音频要么转 AAC、要么 LPCM 直通（`mIsPCMAudio` 为真时**根本不创建编码器**，raw PCM 直接打包进 TS）。
- 视频编码器还配了一堆「实时性」参数：`frame-rate=30`、`i-frame-interval=15`、`bitrate-mode=OMX_Video_ControlRateConstant`、`intra-refresh-mode=OMX_VIDEO_IntraRefreshCyclic`（用周期性帧内宏块刷新替代整帧 IDR，避免周期性大帧导致网络抖动）。

编码器的「喂入」和「产出」用 `MediaCodec` 的异步模型：`scheduleDoMoreWork` → `requestActivityNotification` → `kWhatEncoderActivity` → `doMoreWork`。`doMoreWork` 里先 `dequeueInputBuffer` 拿空闲输入、`feedEncoderInputBuffers` 喂入原始帧，再 `dequeueOutputBuffer` 拿编码结果：

```cpp
// Converter.cpp:608  doMoreWork() 的产出分支
err = mEncoder->dequeueOutputBuffer(
        &bufferIndex, &offset, &size, &timeUs, &flags);
// ...
if (flags & MediaCodec::BUFFER_FLAG_EOS) {
    notify->setInt32("what", kWhatEOS);
} else {
    sp<ABuffer> buffer = new ABuffer(size);
    buffer->meta()->setInt64("timeUs", timeUs);
    memcpy(buffer->data(),
           mEncoderOutputBuffers.itemAt(bufferIndex)->base() + offset,
           size);

    if (flags & MediaCodec::BUFFER_FLAG_CODECCONFIG) {
        mOutputFormat->setBuffer("csd-0", buffer);   // SPS/PPS 存进 csd-0
    } else {
        notify->setInt32("what", kWhatAccessUnit);   // 正常帧通知出去
        notify->setBuffer("accessUnit", buffer);
        notify->post();
    }
}
mEncoder->releaseOutputBuffer(bufferIndex);
```

- `BUFFER_FLAG_CODECCONFIG` 的 buffer 是 SPS/PPS（H.264 的配置帧），不发给对端，而是存进 `mOutputFormat` 的 `csd-0`——后面 TSPacketizer 要用它拼描述符、或在 IDR 前手动补 SPS/PPS。
- 正常帧则带着 `timeUs` 作为 `kWhatAccessUnit` 通知 `PlaybackSession`，进入打包环节。
- 如果编码器不支持自动在 IDR 前带 SPS/PPS，`mNeedToManuallyPrependSPSPPS` 置真，`packetizeAccessUnit` 里会调用 `prependCSD` 手动补上——这是对硬件编码器差异的兜底。

PCM 直通还有一个细节：`feedRawAudioInputBuffers` 把原始 PCM 切成「6 个 access unit × 每个 80 帧」的 PES 包，并加 4 字节的 WFD LPCM 头（首字节 `0xa0`，标注量化位宽/采样率/声道数）——这对应规范附录 B 的 LPCM PES 结构。

# 4 音视频怎么交织成一路？——drainAccessUnits 的「谁时间小谁先走」

视频和音频两条 Track 各自产出 access unit，但 MPEG2-TS 是一条**单路复用流**，必须决定「下一个该打包谁的帧」。`PlaybackSession::drainAccessUnits` 就是那个「调度员」：

```cpp
// PlaybackSession.cpp:997  drainAccessUnit()
bool WifiDisplaySource::PlaybackSession::drainAccessUnit() {
    ssize_t minTrackIndex = -1;
    int64_t minTimeUs = -1ll;

    for (size_t i = 0; i < mTracks.size(); ++i) {
        const sp<Track> &track = mTracks.valueAt(i);
        int64_t timeUs;
        if (track->hasOutputBuffer(&timeUs)) {
            if (minTrackIndex < 0 || timeUs < minTimeUs) {
                minTrackIndex = mTracks.keyAt(i);
                minTimeUs = timeUs;
            }
        } else {
            // 任何一条 Track 没准备好，就停——必须两条都有才能取最早的
            return false;
        }
    }

    const sp<Track> &track = mTracks.valueFor(minTrackIndex);
    sp<ABuffer> accessUnit = track->dequeueOutputBuffer();
    sp<ABuffer> packets;
    status_t err = packetizeAccessUnit(minTrackIndex, accessUnit, &packets);
    // ... 打好的 TS 带 isVideo 标记，交给 Sender 排队发送 ...
    mSender->queuePackets(minTimeUs, packets);
    return true;
}
```

- 核心策略一句话：**所有 Track 的队头帧里，谁的时间戳 `timeUs` 最小，就先打包谁**。这是经典的「多路复用最小时间戳调度」，保证音画按 PTS 顺序进 TS。
- 注意 `else return false` 那行——**必须两条 Track 都有帧在队里，才肯取**。这是防止某条 Track「跑太快」把另一条甩太远的保守策略。
- 取出来的帧交给 `packetizeAccessUnit` 打包，打好的 TS 字节流带着 `isVideo` 标记（用于后续 RTP 的 M 位判断）交给 `Sender::queuePackets`。

`packetizeAccessUnit` 里还决定了「什么时候该发 PAT/PMT/PCR」——答案是**至少每 100ms 发一次**（`mPrevTimeUs + 100000ll <= timeUs` 就置 `EMIT_PCR | EMIT_PAT_AND_PMT` 标志），这样 sink 端即使中途加入或丢了几秒，也能在下一个 100ms 内重新拿到节目表和时间基准。

# 5 为什么打包成 MPEG2-TS？——TSPacketizer 逐字节拼电视信号

现在到了本文第二个灵魂问题：**为什么音视频要打包成 MPEG2-TS？** 答案藏在 `TSPacketizer` 里——它在干的事，就是把 H.264/AAC 的 access unit 逐字节拼成 188 字节的电视广播 TS 包。

## 5.1 为什么是 TS：复用电视广播的成熟封装

三个理由，从「省事」到「逼真」递进：

1. **sink 端有现成的解复用器**。Android 的 `MediaPlayer` 内部自带 `ATSParser`（见第 7 节的 `TunnelRenderer::initPlayer`），它天生认识 TS 格式。source 把数据打成 TS，sink 就能直接喂给 `MediaPlayer`，**省掉一整套私有封装/解封装的开发量**。
2. **TS 是为「实时流」设计的**。TS 包固定 188 字节、自带同步字节 `0x47`、带 PID 复用多路流、带 PCR 时钟基准、带连续性计数器检测丢包——这些全是电视广播「抗干扰、可中途加入、可多路复用」的积累。投屏要的东西它都有。
3. **音画同步靠 PCR/PTS**。TS 里的 PCR（节目时钟基准，27MHz）和 PES 里的 PTS（呈现时间戳，90kHz）是电视行业几十年打磨的时钟同步方案，投屏的音画同步直接借用。

一句话：**投屏本质上就是在发一路电视信号，为什么不直接用电视信号的标准封装？**

![MPEG2-TS 打包结构](assets/17-WFD-%E6%8A%95%E5%B1%8F-%E2%80%94-%E4%BB%8E-source-%E6%8A%93%E5%B1%8F%E7%BC%96%E7%A0%81%E5%88%B0-sink-%E8%A7%A3%E7%A0%81%E6%B8%B2%E6%9F%93/17-ts-packaging.svg)

**读图要点**：一个 access unit 先包成 PES（带 PTS），再切成若干 188 字节 TS 包。橙色的 PAT（PID 0）/ PMT（PID 0x100）/ PCR（PID 0x1000）是「目录、节目单、对表信号」三张控制表，蓝色是真正的音视频载荷（视频 PID 0x1011、音频 PID 0x1100）。

## 5.2 PID 分配表：谁在哪条「车道」上

`TSPacketizer::addTrack` 按 MIME 类型给每条 Track 分配 PID（包标识符）和 stream_type：

```cpp
// TSPacketizer.cpp:350  addTrack() 的 PID/streamType 分配
if (isVideo) {
    PIDStart = 0x1011;
} else if (isAudio) {
    PIDStart = 0x1100;
} else {
    return ERROR_UNSUPPORTED;
}

if (!strcasecmp(mime.c_str(), MEDIA_MIMETYPE_VIDEO_AVC)) {
    streamType = 0x1b;            // H.264
    streamIDStart = 0xe0;
} else if (!strcasecmp(mime.c_str(), MEDIA_MIMETYPE_AUDIO_AAC)) {
    streamType = 0x0f;            // AAC
    streamIDStart = 0xc0;
} else if (!strcasecmp(mime.c_str(), MEDIA_MIMETYPE_AUDIO_RAW)) {
    streamType = 0x83;            // LPCM
    streamIDStart = 0xbd;
}
```

- 视频 PID `0x1011`、AAC 音频 PID `0x1100`、LPCM 音频 PID `0x1100`（音频从 0x1100 起，多路时递增）。固定 PID 让 sink 端 `ATSParser` 能稳定定位每条流。
- `stream_type` 是 PMT 表里标注「这条流是什么编码」的字段：`0x1b`=H.264，`0x0f`=AAC，`0x83`=LPCM。
- 另外两个特殊 PID 定义在头文件里：`kPID_PMT = 0x100`（节目映射表）、`kPID_PCR = 0x1000`（PCR 时钟）。PAT 表本身固定在 PID 0。

## 5.3 188 字节怎么拼：PAT / PMT / PCR / PES

`packetize` 是全文最「硬核」的函数——纯手工逐字节拼二进制。它的输出 buffer 大小先算好：

```cpp
// TSPacketizer.cpp:479  packetize() 的包数计算
size_t PES_packet_length = accessUnit->size() + 8 + numStuffingBytes;
// ...
size_t numTSPackets;
if (PES_packet_length <= 178) {
    numTSPackets = 1;
} else {
    numTSPackets = 1 + ((PES_packet_length - 178) + 183) / 184;
}

if (flags & EMIT_PAT_AND_PMT) numTSPackets += 2;   // 多 PAT + PMT 两包
if (flags & EMIT_PCR)           ++numTSPackets;    // 多 PCR 一包

sp<ABuffer> buffer = new ABuffer(numTSPackets * 188);
```

- 一个 access unit 先包成 PES（包化基本流），再切成若干 188 字节 TS 包。第一包能装 178 字节载荷（188 - 4 字节 TS 头 - 至少 6 字节 PES 头/指针），后续每包装 184 字节。
- `EMIT_PAT_AND_PMT` 标志来自 §4 讲的「每 100ms 至少发一次节目表」。

PAT 表是「总目录」，指向 PMT；PMT 表是「节目单」，列出每条流的 PID 和 stream_type。PCR 包是「对表信号」：

```cpp
// TSPacketizer.cpp:663  EMIT_PCR 分支（只节选时钟部分）
int64_t nowUs = ALooper::GetNowUs();

uint64_t PCR = nowUs * 27;  // PCR based on a 27MHz clock
uint64_t PCR_base = PCR / 300;
uint32_t PCR_ext = PCR % 300;

uint8_t *ptr = packetDataStart;
*ptr++ = 0x47;                       // 同步字节
*ptr++ = 0x40 | (kPID_PCR >> 8);     // PID = 0x1000
*ptr++ = kPID_PCR & 0xff;
*ptr++ = 0x20;                       // 只有自适应域、无载荷
*ptr++ = 0xb7;                       // adaptation_field_length = 183
*ptr++ = 0x10;                       // PCR_flag = 1
// ... PCR_base 33 位 + PCR_ext 9 位按位塞进去 ...
```

- **PCR 是 27MHz 时钟**：`nowUs * 27` 把微秒换算成 27MHz 的 tick。电视广播的 PCR 也是 27MHz，这是「继承电视基因」最直接的证据。
- sink 端用 PCR 同步自己的解码时钟，音画同步才有基准。

PES 头里的 PTS 是 90kHz 时钟，从 access unit 的 `timeUs` 换算：

```cpp
// TSPacketizer.cpp:711  PES 的 PTS
uint64_t PTS = (timeUs * 9ll) / 100ll;   // 微秒 → 90kHz（1/90000 秒）
```

- `timeUs` 是微秒，PTS 单位是 1/90000 秒，所以 `× 9 / 100`。
- PES 头里 `PTS_DTS_flags = b10`（只带 PTS，实时流不带宽 DTS），`data_alignment_indicator = b1`（数据对齐，方便解码器切帧）。

每个 TS 包还有个 4 位 `continuity_counter`，从 0 数到 15 再回 0（`incrementContinuityCounter`）——sink 端靠它检测「同一个 PID 上有没有丢包」。

# 6 RTP 怎么把 TS 发出去、丢了怎么补？——Sender 的发送与重传

TS 字节流打好后，交给 `Sender` 切成 RTP 包发出去。这是本文第三个灵魂问题的主场：**UDP 会丢包，实时流怎么应对？** 答案是 RTP（带序号）+ RTCP SR（时钟基准）+ RR/NACK（丢包反馈与重传）+ LinearRegression（sink 端估延迟）。

## 6.1 7 个 TS 包塞一个 RTP 包

`Sender::queuePackets` 把一整段 TS 字节流（若干个 188 字节包）按「每 7 包一个 RTP 包」切分：

```cpp
// Sender.cpp:35  常量
static size_t kMaxRTPPacketSize = 1500;
static size_t kMaxNumTSPacketsPerRTPPacket = (kMaxRTPPacketSize - 12) / 188;  // = 7

// Sender.cpp:301  queuePackets() 内层
for (size_t i = 0; i < numTSPackets; ++i) {
    if ((i % kMaxNumTSPacketsPerRTPPacket) == 0) {
        // 每 7 个 TS 包起一个新 RTP 头
        uint8_t *rtp = udpPackets->data() + dstOffset;
        rtp[0] = 0x80;                        // V=2
        rtp[1] = 33 | (kMarkerBit ? (1 << 7) : 0);  // PT=33（MP2T）
        rtp[2] = (mRTPSeqNo >> 8) & 0xff;     // 序号
        rtp[3] = mRTPSeqNo & 0xff;
        // rtp[4..7] 时间戳稍后填
        rtp[8] = kSourceID >> 24;             // SSRC = 0xdeadbeef
        // ...
        ++mRTPSeqNo;
        dstOffset += 12;
    }
    memcpy(udpPackets->data() + dstOffset, tsPackets->data() + 188 * i, 188);
    dstOffset += 188;
}
```

- **PT = 33** 是 RFC 2250 规定的 MPEG-2 传输流的 RTP 负载类型（MP2T）。
- **SSRC = `kSourceID = 0xdeadbeef`** 是硬编码的同步源标识，sink 端按它分组（一个 source 一个流）。
- 时间戳（rtp[4..7]）不是在这里填的，而是真正发送那一刻（`onDrainQueue`）才填，这样时间戳最接近「离开发射塔」的时刻：

```cpp
// Sender.cpp:796  onDrainQueue() 填时间戳
int64_t nowUs = ALooper::GetNowUs();
uint32_t rtpTime = (nowUs * 9ll) / 100ll;   // 90kHz 时间戳
rtp[4] = rtpTime >> 24;
// ...
mLastRTPTime = rtpTime;
```

## 6.2 RTCP SR：source 定期报「我的时钟」

RTP 时间戳是 90kHz 的相对时钟，sink 需要把它和真实时间（NTP）对应起来，才能算延迟。source 每 10 秒发一个 RTCP SR（Sender Report）：

```cpp
// Sender.h:81
static const int64_t kSendSRIntervalUs = 10000000ll;   // 10 秒

// Sender.cpp:494  addSR() 节选
data[0] = 0x80 | 0;
data[1] = 200;  // SR
// ...
data[8..15] = mLastNTPTime;   // NTP 时间戳（64 位）
data[16..19] = mLastRTPTime;  // 对应的 RTP 时间戳
data[20..23] = mNumRTPSent;   // 已发包数
data[24..27] = mNumRTPOctetsSent;  // 已发字节数
```

- SR 的核心是一个「**NTP 时间 ↔ RTP 时间戳**」的对应关系：`mLastNTPTime` 是发 SR 时的真实时间，`mLastRTPTime` 是当时的 RTP 时钟。sink 拿到这对关系，就能把任意 RTP 时间戳换算成真实时间。
- NTP 时间从 `ALooper::GetNowUs()` 换算，要加一个「1970 到 1900 的秒数偏移」（NTP 纪元是 1900 年）：

```cpp
// Sender.cpp:584  GetNowNTP()
uint64_t nowUs = ALooper::GetNowUs();
nowUs += ((70ll * 365 + 17) * 24) * 60 * 60 * 1000000ll;  // 1970→1900 偏移
uint64_t hi = nowUs / 1000000ll;
uint64_t lo = ((1ll << 32) * (nowUs % 1000000ll)) / 1000000ll;
return (hi << 32) | lo;
```

## 6.3 NACK 重传：sink 说「第 N 包丢了」，source 重发

source 端开着 `ENABLE_RETRANSMISSION = 1`，意味着它维护一个「最近 128 个已发包」的历史缓存，sink 发来 NACK 就从缓存里重发：

```cpp
// Sender.cpp:616  parseTSFB() 节选（处理 NACK）
if ((data[0] & 0x1f) != 1) {
    return ERROR_UNSUPPORTED;  // We only support NACK for now.
}
uint32_t srcId = U32_AT(&data[8]);
if (srcId != kSourceID) {
    return ERROR_MALFORMED;
}

for (size_t i = 12; i < size; i += 4) {
    uint16_t seqNo = U16_AT(&data[i]);     // 丢的包序号
    uint16_t blp = U16_AT(&data[i + 2]);  // 位图：seqNo 之后还有哪些丢

    // 遍历 mHistory（最近 128 包），匹配 seqNo 和 blp 置位的序号
    // 命中的就 sendPacket(mRTPSessionID, buffer->data(), buffer->size())
    // 在原始 RTP 通道上重发
}
```

- NACK 是 RFC 4585 的 generic NACK 格式：FMT=1（通用 NACK），PID 是「第一个丢的包序号」，BLP 是 16 位位图，每一位代表 PID 之后的那个包是否也丢了。
- source 端在 `RETRANSMISSION_ACCORDING_TO_RFC_XXXX = 0` 时，选择**在原始 RTP 通道上重发**（不另开通道），因为这样最简单、对端也最好处理。
- 历史缓存只有 128 个包（`kMaxHistoryLength = 128`），丢的包太老就重发不了——实时流的取舍：宁可不补，也不无限缓存。

至此 source 侧整条链走完：抓屏 → 编码 → 打包 TS → 切 RTP → 发 UDP。接下来翻过网络，看 sink 侧怎么把它逆回来。

# 7 sink 端怎么把 RTP 包变回画面？——接收、重排、解码渲染

如果说 source 是那座微型电视台，sink 就是摆在客厅里的电视接收机——天线（`RTPSink`）收信号、机顶盒（`TunnelRenderer`）整理解码、屏幕（`MediaPlayer`）上画。sink 侧三个类各司其职：`WifiDisplaySink` 管 RTSP 会话，`RTPSink` 收包排序、估延迟、回 RTCP，`TunnelRenderer` 把有序 TS 喂给 `MediaPlayer` 渲染。

![sink 端接收渲染链路](assets/17-WFD-%E6%8A%95%E5%B1%8F-%E2%80%94-%E4%BB%8E-source-%E6%8A%93%E5%B1%8F%E7%BC%96%E7%A0%81%E5%88%B0-sink-%E8%A7%A3%E7%A0%81%E6%B8%B2%E6%9F%93/17-sink-pipeline.svg)

**读图要点**：蓝色是数据流（RTP 收包 → 重排 → 有序 TS → 渲染），绿色是回传（RTCP RR + generic NACK 从 sink 回 source），橙色是 `TunnelRenderer` 的 50ms 缺包宽限逻辑。注意 `MediaPlayer` 是跨进程的（Binder），`TunnelRenderer` 通过 `IStreamSource` 隧道喂数据。

## 7.1 WifiDisplaySink：状态机比 source 简单得多

sink 是 RTSP 客户端，它的状态机只有 5 个状态：

```cpp
// WifiDisplaySink.h:47
enum State {
    UNDEFINED,
    CONNECTING,
    CONNECTED,
    PAUSED,
    PLAYING,
};
```

- 对应「连 TCP → 连上 → 建好会话但还没播 → 播放中」。
- 与 source 不同，sink 是「被动响应者」，它只在收到 source 的 M5（`wfd_trigger_method: SETUP`）时才发起 SETUP：

```cpp
// WifiDisplaySink.cpp:586  onSetParameterRequest()
const char *content = data->getContent();
if (strstr(content, "wfd_trigger_method: SETUP\r\n") != NULL) {
    status_t err = sendSetup(sessionID, "rtsp://x.x.x.x:x/wfd1.0/streamid=0");
    // ...
}
```

- 注意这里的 URI 是写死的 `x.x.x.x:x` 占位符——因为这个 sink 是测试工具，真正的 production sink 会从 M4 的 `wfd-presentation-url` 拿 URI。这呼应了开头 PS 里的边界声明：**sink 侧在代码里主要是 wfd.cpp 测试工具在用**。

sink 回 M3 时也很有意思——它返回的能力是「占位符」：

```cpp
// WifiDisplaySink.cpp:477  onGetParameterRequest()
AString body =
    "wfd_video_formats: xxx\r\n"
    "wfd_audio_codecs: xxx\r\n"
    "wfd_client_rtp_ports: RTP/AVP/UDP;unicast xxx 0 mode=play\r\n";
```

- 全是 `xxx`，因为这是个「能连上、能收到画面」的最小测试实现，没做真正的 EDID 采集、能力上报。生产 sink 应该在这里如实填报自己的解码能力。

## 7.2 RTPSink：RFC3550 序号重排 + 最小二乘估延迟

`sink` 收到 RTP 包后，第一个要解决的问题是「**UDP 不保证顺序**」。`RTPSink::Source` 用 RFC3550 的算法做序号重排和丢包统计：

```cpp
// RTPSink.cpp:47  Source 的 RFC3550 常量
static const uint32_t kMinSequential = 2;
static const uint32_t kMaxDropout = 3000;
static const uint32_t kMaxMisorder = 100;
static const uint32_t kRTPSeqMod = 1u << 16;   // 16 位序号回绕

// RTPSink.cpp:96  updateSeq() 核心判断
uint16_t udelta = seq - mMaxSeq;
if (udelta < kMaxDropout) {
    // 有序（允许 ≤3000 的缺口）
    if (seq < mMaxSeq) {
        mCycles += kRTPSeqMod;   // 序号回绕，记一个 64K 周期
    }
    mMaxSeq = seq;
} else if (udelta <= kRTPSeqMod - kMaxMisorder) {
    // 序号大跳：可能是对端重启，或乱序
    // ... mBadSeq 试探逻辑 ...
    return false;
} else {
    // 重复或轻微乱序，忽略
}
```

- 三个阈值各管一类：`kMaxDropout=3000` 内是「有序但可能有缺口」，`kMaxMisorder=100` 内是「轻微乱序可忽略」，中间是「大跳」（对端重启），`mBadSeq` 要连续两个连续序号才认定重启、重新同步。
- `mProbation` 是「试用期」：新流的前几个包必须连续（`kMinSequential=2`），否则回到试用期重来——防止把垃圾包当流头。

重排之后，`parseRTP` 还有一个妙处——**用最小二乘拟合估延迟**：

```cpp
// RTPSink.cpp:481  parseRTP() 的延迟估计
int64_t arrivalTimeMedia = (arrivalTimeUs * 9ll) / 100ll;

mRegression.addPoint((float)rtpTime, (float)arrivalTimeMedia);

float n1, n2, b;
if (mRegression.approxLine(&n1, &n2, &b)) {
    float expectedArrivalTimeMedia = (b - n1 * (float)rtpTime) / n2;
    float latenessMs = (arrivalTimeMedia - expectedArrivalTimeMedia) / 90.0;

    if (mMaxDelayMs < 0ll || latenessMs > mMaxDelayMs) {
        mMaxDelayMs = latenessMs;
        ALOGI("packet was %.2f ms late", latenessMs);
    }
}
```

- 它把每个包的 `(rtpTime, 到达时间)` 当做一个点，喂给 `LinearRegression`（历史 1000 个点）。拟合出一条「RTP 时间戳 → 预期到达时间」的直线。
- 某包的实际到达时间比拟合直线预测的**晚**，就说明它在网络里堵了 `latenessMs` 毫秒。`mMaxDelayMs` 记录最大迟到值。
- `LinearRegression::approxLine` 用的是**正交最小二乘**（total least squares），不是普通最小二乘——它同时考虑 X、Y 两个方向的误差，对「X 是 RTP 时钟、Y 是本地到达时钟、两边都有抖动」的场景更稳健。为什么这么讲究？因为 RTP 时间戳和本地时钟本来就是两个独立时钟域，谁都不是「精确的自变量」。

sink 还每 2 秒回一个 RTCP RR（Receiver Report），报告丢包率：

```cpp
// RTPSink.cpp:725  onSendRR() 节选
ptr[0] = 0x80 | 0;
ptr[1] = 201;  // RR
// ...
for (size_t i = 0; i < mSources.size(); ++i) {
    source->addReportBlock(ssrc, buf);   // 每个 SSRC 一个报告块
    ++numReportBlocks;
}
// ...
addSDES(buf);
mNetSession->sendRequest(mRTCPSessionID, buf->data(), buf->size());
scheduleSendRR();   // 2 秒后再发
```

`addReportBlock` 里的丢包率计算：`fractionLost = (lostInterval << 8) / expectedInterval`——用「期望收到的包数 - 实际收到的包数」算出丢包比例，填进 RR 的报告块。source 收到 RR 就知道「路上丢了多少」，配合 NACK 重传完成闭环。

## 7.3 TunnelRenderer：缺包等 50ms，然后触发 NACK

`RTPSink` 把排好序的包（带着 `mCycles | seq` 的扩展序号）逐个 `queueBuffer` 给 `TunnelRenderer`。`TunnelRenderer` 维护一个按扩展序号**有序插入**的链表，然后按序取出，喂给 `MediaPlayer`：

```cpp
// TunnelRenderer.cpp:213  dequeueBuffer() 的丢包处理
if (mLastDequeuedExtSeqNo < 0 || extSeqNo == mLastDequeuedExtSeqNo + 1) {
    // 正好是下一包，直接交付
    mLastDequeuedExtSeqNo = extSeqNo;
    // ...
    return buffer;
}

// 队头的序号不是期望的下一包 → 说明中间丢了
if (mFirstFailedAttemptUs + 50000ll > ALooper::GetNowUs()) {
    // 愿意等 50ms，期间第一次发现缺口就发 NACK
    if (!mRequestedRetransmission) {
        sp<AMessage> notify = mNotifyLost->dup();
        notify->setInt32("seqNo", (mLastDequeuedExtSeqNo + 1) & 0xffff);
        notify->post();
        mRequestedRetransmission = true;
    }
    return NULL;
}

// 等了 50ms 还没到，放弃，跳到下一包
ALOGI("dropping packet. extSeqNo %d didn't arrive in time", ...);
```

- 核心是一个「**50ms 宽限期**」：发现缺口（期望的包没到，后面更晚的包先到了）时，先发一个 NACK（`mNotifyLost` 通知 `RTPSink::onPacketLost`，它拼 generic NACK 发给 source），然后**等 50ms**。
- 50ms 内被重传补上了（`mRequestedRetransmission` 时 `Recovered after requesting retransmission`），就继续；等不到，就**放弃这个包**，跳到下一包继续喂——实时流不能为等一个包无限阻塞，否则画面卡死比花屏更糟。

喂给 `MediaPlayer` 的方式是「tunnel（隧道）」：`TunnelRenderer` 实现了一个 `IStreamSource`，把有序 TS 字节流通过 Binder 隧道灌给 `MediaPlayer`：

```cpp
// TunnelRenderer.cpp:331  initPlayer() 节选
sp<IServiceManager> sm = defaultServiceManager();
sp<IBinder> binder = sm->getService(String16("media.player"));
sp<IMediaPlayerService> service = interface_cast<IMediaPlayerService>(binder);

mStreamSource = new StreamSource(this);
mPlayerClient = new PlayerClient;
mPlayer = service->create(getpid(), mPlayerClient, 0);
CHECK_EQ(mPlayer->setDataSource(mStreamSource), (status_t)OK);
mPlayer->setVideoSurfaceTexture(mSurfaceTex);
mPlayer->start();
```

- `setDataSource(mStreamSource)` 告诉 `MediaPlayer`：「数据源不是我读文件，而是这个 `IStreamSource`，它会通过 `queueBuffer` 喂我 TS 字节」。
- `MediaPlayer` 内部拿到的就是标准的 MPEG2-TS 流，它自己的 `ATSParser` 解复用 → 解码 H.264/AAC → 渲染到 `mSurfaceTex` 那块 Surface 上。
- `StreamSource::doSomeWork` 里还有个细节：第一包喂出去前，先发一个 `IStreamListener::DISCONTINUITY` + `ATSParser::DISCONTINUITY_ABSOLUTE_TIME` 命令，把 `MediaPlayer` 的时钟校准到「现在」，避免开头几十帧时间戳错乱。

至此，画面出现在电视上。整条链闭合。

# 8 总结：一条链，三个反直觉设计

回顾整条链，从 P2P 建连完成、source 监听 7236 端口开始：

1. **sink 主动连 source 的 TCP**（source 是 RTSP 服务器），但连上后 **source 先发 M1**（OPTIONS + `Require: org.wfa.wfd1.0`）。
2. source 主导 M1-M4 能力协商——M3 问能力、M4 定参数，**视频写死、音频/HDCP/端口真协商**。
3. source 发 M5（`wfd_trigger_method: SETUP`）触发 sink 发 M6 SETUP、M7 PLAY，会话建立。
4. source 侧 `PlaybackSession` 流水线启动：`SurfaceMediaSource` 抓虚拟屏 → `RepeaterSource` 30Hz 恒速 → `MediaPuller` 拉帧 → `Converter` 编码 H.264/AAC → `drainAccessUnits` 按最小时间戳交织 → `TSPacketizer` 打 TS → `Sender` 切 RTP 发 UDP。
5. sink 侧 `RTPSink` 收包 → RFC3550 序号重排 → LinearRegression 估延迟 → `TunnelRenderer` 有序喂 `MediaPlayer`（50ms 缺包 NACK）→ `ATSParser` 解 TS → 解码渲染上屏。
6. 期间 source 每 25 秒发 M16 保活（30 秒超时），每 10 秒发 RTCP SR；sink 每 2 秒回 RR，丢包就发 NACK。

三个反直觉设计的答案，浓缩成三句话：

| 灵魂问题                              | 答案                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| 为什么「反向 RTSP」？                 | RTSP 规范不允许服务器主动发 SETUP/PLAY，WFD 用 OPTIONS/GET/SET_PARAMETER + `wfd-trigger-method` 打擦边球；业务上「谁出内容谁定规则」，source 必须主动探能力 |
| 为什么 MPEG2-TS？                     | 投屏本质是发电视信号，TS 自带解复用器（`ATSParser` 现成）、实时流封装（188B/PID/PCR/连续性计数）、音画同步时钟（PCR 27MHz + PTS 90kHz） |
| 为什么 RTP + RTCP + NACK + 最小二乘？ | UDP 丢包要恢复（NACK 重传 + 128 包历史），时钟要对齐（SR 报 NTP↔RTP 对应），延迟要估（正交最小二乘拟合），不靠 TCP 保序 |

最后看几个异常路径，它们是理解「实时流取舍」的注脚：

- **sink 掉线**：source 靠 M16 保活 + `Reaper` 检测。30 秒内没收到任何 RTSP 响应，`kWhatReapDeadClients` 就把 `PlaybackSession` 摘掉、销毁 socket、回调 `onDisplayError`。
- **缺包超时**：`TunnelRenderer` 等 50ms 后放弃该包继续喂，宁可花屏不卡死——实时流的第一优先级是「跟上时间」。
- **编码器不支持自动 SPS/PPS**：`Converter` 检测后置 `mNeedToManuallyPrependSPSPPS`，`packetizeAccessUnit` 在 IDR 前手动 `prependCSD` 补上，兼容不同硬件编码器。

投屏的「命根子」是时间同步和丢包恢复，而这份老源码里，一个用 `select()` 的朴素网络线程、一个手工拼 188 字节的 `TSPacketizer`、一个 50ms 宽限期的 `TunnelRenderer`，就把这件事干成了。考古它的价值，不在于「抄代码」，而在于看懂那些为了实时性做的取舍——这些取舍在今天的 WebRTC、云游戏、低延迟直播里，依然在重复上演。

**延伸阅读**：本文追的是 Android 4.2.2 老源码里的 C++ 实现，而 Miracast 生态里 sink 还有另一种语言的同构落地——[MiracleCast](https://github.com/albfan/miraclecast)（Linux 侧用 C + GObject 写的开源 Miracast sink）：`miracle-wifid` 管 P2P 配对与 DHCP，`miracle-sinkctl` 管 RTSP 控制面与 UIBC，`gstplayer` 用 GStreamer 播放。同一套协议、同一套分工，换了一种语言实现，可作为本文架构的对照。

追完投屏这条链，你会发现一个和 RTT 篇相似的反差：主机侧（Framework + media server）写的代码并不少——一个 11 状态的状态机、一条五组件流水线、一个手工拼 188 字节的打包器——但真正决定投屏体验的「编码质量、丢包恢复、时钟同步」，要么压进了硬件编码器，要么交给了对端的 `MediaPlayer`。投屏是把「手机屏幕」变成「电视信号」，它脚下踩着的那条 P2P 链路本身，也正在往下一代演进。下一章，我们把镜头转向 WiFi 7——一条链路怎么同时横跨 2.4G / 5G / 6G，主机和固件的分工边界又划在哪里。
