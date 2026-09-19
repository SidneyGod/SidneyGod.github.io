---
title: 数据帧发送进阶：DSCP→UP 映射与 QoS Map
top: 1
related_posts: true
abbrlink: b9c2331e
date: 2026-09-19 21:16:24
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> "WMM AC 分类决定数据包走哪条传送带，但传送带编号是从哪来的？DSCP→UP(User Priority) 映射就是快递单上的'优先级戳'——寄件人写了'加急'，快递公司认不认、怎么认，取决于 AP 和 STA 之间的一纸协议。"

---

# 本章导读

上一章把数据帧从 `ndo_start_xmit` 一路送到了固件——QCOM 的 10 道关卡、MTK 的 18 道工序、WMM AC 分类、Block ACK 协议，该过的流程都过了一遍。但 WMM AC 分类的输入——User Priority（UP，0-7）——是从哪来的？

答案在 IP 头的 DSCP 字段（0-63）。从 64 个 DSCP 值到 8 个 UP 值，中间经过一层 QoS Map 的映射。这层映射由 AP 在关联时下发，决定了同一个 DSCP 值在不同网络上可能走不同优先级的队列——你的手机发一个 DSCP=46（EF，语音）的包，在 QCOM 平台上走 VO 队列，在 MTK 平台上呢？答案可能是"一样也可能不一样"——取决于 AP 有没有下发 QoS Map，以及两个平台的默认映射表怎么定义。

<!--more-->

QoS Map 的正确性直接决定了服务质量。如果 AP 下发了一个错误映射——将 DSCP 46 映射到 UP 0（BE）而非 UP 6（VO）——语音帧进入 BK/BE 队列，EDCA 参数从激进的 VO（CWmin=3, CWmax=7, AIFS=2）退化为保守的 BE（CWmin=15, CWmax=1023, AIFS=3），信道竞争延迟和 jitter 飙升，VoWiFi 通话出现断续和失真。更关键的是——STA 侧无法检测 AP 的 QoS Map 是否"正确"，只能信任并执行。一个配置错误的 AP 可以静默地降级所有 STA 的语音服务质量，用户只会感知到"通话质量差"，不知道根因是 QoS Map 映射错误。

读完本章，你将有能力回答：

- 你的手机发一个 DSCP=46（EF，语音）的包，QCOM 和 MTK 分别把它映射到哪个 UP？为什么同一个 DSCP 值可能在两个平台上走不同队列？
- `cfg80211_classify8021d` 的五层判定逻辑各解决什么问题？`array_index_nospec` 在 QoS Map 场景下防的是什么攻击？
- MTK 和 QCOM 都在 `ndo_select_queue` 阶段做 DSCP→UP 映射，但查表函数和是否下发固件有什么不同？这对 Linux qdisc 意味着什么？

**PS**：本章覆盖 QoS Map 的完整闭环——从 hostapd 的 `qos_map_set` 配置、AP 下发（关联响应中的 QoS Map element），到 STA（wpa_supplicant）接收、再到 QCOM/MTK 两个平台在 `ndo_select_queue` 阶段的查表应用。MLO TX（TID-to-Link Mapping、链路选择、操作模式）是另一个独立主题，见下一篇。

---

# 1 `skb->priority` 是怎么来的？

在数据帧发送篇的 WMM 分类中，我们看到了这行代码：

```c
// QCOM: core/hdd/src/wlan_hdd_tx_rx.c — __hdd_hard_start_xmit
up = skb->priority;

```

`skb->priority` 是一个 0-7 的整数值，对应 IEEE 802.1D 定义的 8 个 User Priority。但数据包进入协议栈时携带的是 IP 层的 DSCP（Differentiated Services Code Point）值——一个 6-bit 字段，范围 0-63。从 0-63 到 0-7，中间发生了什么？

答案分两层：

**第一层：Linux 内核默认映射**。当没有 WiFi QoS Map 介入时，`skb->priority` 由内核网络栈根据 DSCP 字段设置。最直接的映射是取 DSCP 的高 3 位（`dscp >> 3`），这恰好对应了 IP 头中原始的 Precedence 字段。例如 DSCP=46（EF，Expedited Forwarding，二进制 `101110`）→ `46 >> 3 = 5`，对应 UP 5（VI，Video）。

**第二层：WiFi QoS Map 覆盖**。AP 可以在关联响应中下发一个定制映射表，明确告诉 STA："DSCP 46 应该映射到 UP 6（VO），不是 UP 5（VI）"。STA 收到后，用这张表覆盖内核默认映射。

问题来了：这个覆盖发生在哪里？两个平台的答案完全不同。

---

# 2 协议：QoS Map element 怎么工作？

IEEE 802.11-2024 §9.4.2.93 定义了 QoS Map element（Element ID 110，hostapd 代码里对应 `qos_map_set`），结构如下：

```
QoS Map element:
  Element ID (1 byte): 110
  Length (1 byte)
  UP[0] DSCP Range (2 bytes: low, high)  ─┐
  UP[1] DSCP Range (2 bytes: low, high)   │ 共 16 字节
  ...                                      │ 定义每个 UP 的默认 DSCP 范围
  UP[7] DSCP Range (2 bytes: low, high)  ─┘
  DSCP Exception List (variable):
    每条记录 2 字节:
      DSCP        (1 byte, 低 6 位有效)
      User Priority (1 byte, 低 3 位有效)

```

先放 UP Range 表（8 个 UP 各 2 字节，共 16 字节），再放 DSCP Exception 列表。每条 Exception 记录将一个具体的 DSCP 值映射到指定 UP——相当于在 Range 表的基础上打补丁。举例：Range 表把 DSCP 40-47 归入 UP 5（VI），但 Exception 可以把 DSCP 46 单独拎出来映射到 UP 6（VO）。DSCP Exception 最多支持 21 条（`IEEE80211_QOS_MAP_MAX_EX`）。

AP 通过两种方式下发 QoS Map：

- **Association Response 帧中的 IE**：STA 关联时一并获取
- **QoS Map Configure 帧**：关联后动态更新，属于 QoS Action 帧（Category 1，QoS Action field 值 4），定义见 §9.6.3.6

这个设计相当于在快递单上打了一个让物流系统认的优先级标签——但两家中转站的"翻译规则"不同，同一张标签到了不同的快递公司，包裹可能走不同的通道。下面顺着这条标签从"签发"到"盖章"的路径走一遍：hostapd 怎么把 `qos_map_set` 写进关联响应，wpa_supplicant 又怎么把它收下来。

## 2.1 hostapd 怎么配置：`qos_map_set` 解析

AP 侧 QoS Map 的唯一权威来源，是 hostapd 配置文件里一行 `qos_map_set` 配置项——逗号分隔的十进制字节序列，直接对应 QoS Map element 的原始字节。`hostapd_config_fill`（`hostapd/config_file.c:2464`）逐行读取配置文件，`os_strcmp(buf, "qos_map_set")` 命中时（`config_file.c:4355`）交给 `parse_qos_map_set`（`config_file.c:1684`）解析：`atoi` 逐个读入 0-255 的十进制字节，遇到逗号跳到下一个值，直到行尾。解析时校验两条规则——总字节数必须不少于 16（UP Range 表的固定长度）且为偶数（16 字节 Range 表 + n×2 字节 Exception 记录），任一字节越界或长度非法都报错返回。通过校验后，字节序列被原样拷贝进 `struct hostapd_bss_config` 的 `qos_map_set[16 + 2 * 21]`（`src/ap/ap_config.h:621`），`qos_map_set_len`（`ap_config.h:622`）记录实际长度。这个 58 字节的数组上限正好等于 16 字节 Range 表 + 21 条 Exception × 2 字节——与 §3 里 `IEEE80211_QOS_MAP_LEN_MAX` 的定义同源。

## 2.2 hostapd 怎么下发：两个出口

hostapd 拿到 `qos_map_set` 字节后，有两个出口。

**出口一：塞进关联响应（Assoc Resp）**。`hostapd_eid_qos_map_set`（`src/ap/ieee802_11_shared.c:526`）构造 QoS Map element：先写 Element ID 110（`WLAN_EID_QOS_MAP_SET`，`src/common/ieee802_11_defs.h:390`），再写 Length，最后 `os_memcpy` 拷贝 `qos_map_set` 原始字节——不做任何解析改写，原样透传。它在 `send_assoc_resp`（`src/ap/ieee802_11.c:4865`）里被调用，但挂在一个开关后：`if (sta && sta->qos_map_enabled)`（`ieee802_11.c:5020`）。也就是说，只有 STA 在关联请求的 Extended Capabilities 里置了 QoS Map 支持位（Bit 32），hostapd 才把 QoS Map element 塞进关联响应。这个位由 `check_ext_capab`（`ieee802_11_shared.c:1156`）解析 STA 的 Ext Capabilities IE——`ext_capab_ie[4] & 0x01` 命中时把 `sta->qos_map_enabled`（`src/ap/sta_info.h:133`）置 1。AP 自己则在 Beacon/Probe Response 的 Ext Capabilities 里通过 Bit 32 声明"我支持 QoS Map"（`ieee802_11_shared.c:403`），但声明位和实际下发是两码事——真正的 element 只在关联响应交换里出现。

**出口二：同步给内核驱动**。`hostapd_setup_bss`（`src/ap/hostapd.c:1393`）在 BSS 启动时调用 `hostapd_drv_set_qos_map`（`src/ap/ap_drv_ops.c:1034`），把 `conf->qos_map_set` 通过驱动接口下发。nl80211 驱动的实现 `nl80211_set_qos_map`（`src/drivers/driver_nl80211.c:11895`）构造一条 `NL80211_CMD_SET_QOS_MAP` netlink 命令，把字节序列塞进 `NL80211_ATTR_QOS_MAP` 属性发往内核。这个出口不走空口——它让内核 cfg80211 层知道 AP 的 QoS Map，供软 MAC 驱动自行生成管理帧时使用。注意这个出口只对 Soft-MAC AP 有意义：Soft-MAC 架构下管理帧由 host 驱动经 cfg80211 生成，QoS Map 必须落进内核才能被拼进 Beacon/Assoc Resp；Full-MAC AP 则由固件自行生成管理帧，QoS Map 留在固件内部、不经这条内核通道。另外出口二需要驱动置位 `WPA_DRIVER_FLAGS_QOS_MAPPING` 能力位，否则 `hostapd_drv_set_qos_map` 直接返回 0 跳过。内核侧的同名函数 `nl80211_set_qos_map`（`net/wireless/nl80211.c:15425`）把 `NL80211_ATTR_QOS_MAP` 解析进 `struct cfg80211_qos_map`，经 `rdev_set_qos_map` 调用 wiphy 回调 `set_qos_map` 交给驱动，mac80211 的 `ieee80211_set_qos_map`（`net/mac80211/cfg.c:4265`）把它挂到 `sdata->qos_map`——这条内核通道与 §2.3 的 STA 侧接收同源。

## 2.3 STA 怎么接收：wpa_supplicant 的入口

STA 侧 Linux 用户态的接收入口在 wpa_supplicant。关联完成、收到 Assoc Resp 后，驱动把响应 IEs 通过 ASSOCINFO 事件上报，`wpa_supplicant_event_associnfo`（`wpa_supplicant/events.c:3430`）取出 `data->assoc_info.resp_ies`，调用 `interworking_process_assoc_resp`（`events.c:3058`）。后者用 `ieee802_11_parse_elems` 解析整个 IE 序列，命中 QoS Map element（Element ID 110）后交给 `wpas_qos_map_set`（`events.c:3043`）。`wpas_qos_map_set` 调 `wpa_drv_set_qos_map`（`wpa_supplicant/driver_i.h:696`）→ 驱动的 `set_qos_map` 回调，nl80211 驱动同样走 `NL80211_CMD_SET_QOS_MAP` 把 QoS Map 推给内核；内核解析后经 wiphy 回调 `set_qos_map` 交给驱动，mac80211 的 `ieee80211_set_qos_map` 把它挂到 `sdata->qos_map`——§3 的 `cfg80211_classify8021d` 经 `ieee80211_select_queue`（`net/mac80211/wme.c:147`）解引用后查的正是这张表。

关联后 AP 若想动态更新 QoS Map，会发一条 QoS Map Configure 帧（§9.6.3.6）——注意这条帧不由 hostapd 生成：hostapd 只负责关联响应里的静态下发路径，Configure 帧由 AP 的 MAC/驱动层按 §9.6.3.6 在运行时构造。Configure 帧的触发语义是单向的：AP 在 QoS Map 变更时主动发起，STA 被动接收并应用，不回任何响应帧。wpa_supplicant 在 `wpas_event_rx_mgmt_action`（`events.c:5565`）里匹配 `category == WLAN_ACTION_QOS && payload[0] == QOS_QOS_MAP_CONFIG`（`events.c:5649`），校验帧内 element 是 `WLAN_EID_QOS_MAP_SET` 且长度合法后，同样调 `wpas_qos_map_set` 走同一条下发链路。于是两条路径——关联响应和运行时 Configure 帧——在 `wpas_qos_map_set` 汇合，统一交给内核。

到这里，闭环补全，回到开篇那张快递单上的"优先级戳"：寄件人写戳（hostapd 的 `qos_map_set` 一行配置）→ 快递公司盖章（AP 下发关联响应里的 QoS Map element，或运行时 Configure 帧）→ 分拣中心照章执行（wpa_supplicant 的 `wpas_qos_map_set` 收下后交给内核 `cfg80211_qos_map`，§3 的 `cfg80211_classify8021d` 查的正是它，§4/§5 两个平台在 `ndo_select_queue` 阶段照表分拣）。写戳、盖章、执行三段，上游的"签发"和下游的"盖章"首次在同一篇里连成了一条线。

---

# 3 内核怎么分类 DSCP？——`cfg80211_classify8021d` 源码拆解

在讲 QCOM 和 MTK 之前，先看 Linux 内核的通用实现——它是理解两个平台差异的基准。

`cfg80211_classify8021d`（`net/wireless/util.c`）是 cfg80211 子系统提供的标准 DSCP→UP 分类函数，供 mac80211 和 Full-MAC 驱动共用：

```c
// Linux net/wireless/util.c:917 — cfg80211_classify8021d, 内核 QoS Map 分类
unsigned int cfg80211_classify8021d(struct sk_buff *skb,
                                    struct cfg80211_qos_map *qos_map)
{
    unsigned int dscp;
    unsigned char vlan_priority;
    unsigned int ret;

    // 步骤1: skb->priority 魔数直通（256-263 直接指示 802.1d priority）
    if (skb->priority >= 256 && skb->priority <= 263) {
        ret = skb->priority - 256;
        goto out;
    }

    // 步骤2: VLAN 标签优先级优先
    if (skb_vlan_tag_present(skb)) {
        vlan_priority = (skb_vlan_tag_get(skb) & VLAN_PRIO_MASK)
            >> VLAN_PRIO_SHIFT;
        if (vlan_priority > 0) {
            ret = vlan_priority;
            goto out;
        }
    }

    // 步骤3: 从 IP 头提取 DSCP
    switch (skb->protocol) {
    case htons(ETH_P_IP):
        dscp = ipv4_get_dsfield(ip_hdr(skb)) & 0xfc;
        break;
    case htons(ETH_P_IPV6):
        dscp = ipv6_get_dsfield(ipv6_hdr(skb)) & 0xfc;
        break;
    // ...省略 MPLS/802.21 处理...
    default:
        return 0;
    }

    // 步骤4: 如果有 QoS Map，先查异常表，再查范围表
    if (qos_map) {
        unsigned int i, tmp_dscp = dscp >> 2;

        for (i = 0; i < qos_map->num_des; i++) {
            if (tmp_dscp == qos_map->dscp_exception[i].dscp) {
                ret = qos_map->dscp_exception[i].up;
                goto out;
            }
        }

        for (i = 0; i < 8; i++) {
            if (tmp_dscp >= qos_map->up[i].low &&
                tmp_dscp <= qos_map->up[i].high) {
                ret = i;
                goto out;
            }
        }
    }

    // 步骤5: 无 QoS Map 时，回退到 dscp >> 5（取 DSCP 高 3 位）
    ret = dscp >> 5;
out:
    return array_index_nospec(ret, IEEE80211_NUM_TIDS);
}

```

这段代码的五层判定逻辑拆开看：

**`skb->priority` 魔数**：值 256-263 是内核为 IEEE 802.1D 优先级保留的特殊范围（内核注释："skb->priority values from 256->263 are magic values to directly indicate a specific 802.1d priority"），对应 Annex G 表 G-2 定义的 8 个优先级（0=BE, 1=BK, 2=spare, 3=EE, 4=CL, 5=VI, 6=VO, 7=NC），由 VLAN 子系统在入队时设置，跳过所有 DSCP 逻辑。

**VLAN 标签**：如果数据包带有 VLAN 标签且优先级非零，直接使用，跳过 DSCP 查询。设计意图是：802.1Q VLAN 优先级是二层交换机在转发路径上已标记的值，比三层 DSCP 更接近最终的链路调度决策点。当 VLAN tag 和 QoS Map 同时存在时，VLAN 优先级先生效（步骤 2 在步骤 4 之前返回），QoS Map 不会覆盖已有的 VLAN 优先级；只有 VLAN 优先级为零或无 VLAN tag 时，才进入 QoS Map 查表路径。

**QoS Map 两阶段匹配**：先精确匹配 Exception 表中的 DSCP 值，再范围匹配 UP Range 表，异常表优先级高于范围表。源码中 `& 0xfc` 和 `>> 2` 配合分工：`0xfc` 掩码清除 TOS 字节低 2 位的 ECN（Explicit Congestion Notification）字段，`>> 2` 将剩余 6-bit DSCP 右移到 0-63 标准范围。两步操作缺一不可，不掩码会导致 ECN 位混入 DSCP 值，同一个 DSCP 在网络拥塞和空闲时得到不同映射。内核故意在查表前剥离拥塞状态信息，确保 QoS 映射不受网络瞬态扰动。

**无 QoS Map 回退**：`dscp >> 5` 取高 3 位，等价于只有 8 个优先级级别，丢弃了 DSCP 低 3 位的细粒度信息。

**性能特征**：有 QoS Map 时，worst-case 路径是遍历全部 `num_des` 条 Exception（最多 21 次比较）后遍历 8 个 UP Range（8 次比较），共 29 次比较；无 QoS Map 时直接走 `dscp >> 5` 单次位移，性能差异在高 PPS（Packets Per Second）场景下可达数个数量级。MTK 的 `qosBuildQosMapTable` 在关联时预构建 64 字节 DSCP→UP 查找表，将运行时线性扫描转化为 O(1) 数组索引，但 `cfg80211_classify8021d` 本身仍走线性路径，因为内核函数不感知 MTK 的预计算表。

**为什么内核不合并 MTK 的 O(1) 查表优化？** MTK 能做预计算是因为 Full-MAC 驱动自行管理 STA Record 的完整生命周期——QoS Map 在关联时解析后挂到 StaRec 上，64 字节表的内存分配跟着 StaRec 走，零额外管理成本。但 `cfg80211_classify8021d` 是通用函数，服务对象包括 mac80211（Soft-MAC）和各种 Full-MAC 驱动，mac80211 的 QoS Map 生命周期绑定在接口对象 `sdata` 上，与驱动的 STA Record 生命周期不同步。在内核通用层做 O(1) 查表，需要在 cfg80211 分配 QoS Map 时同步构建 64 字节平坦表、每次更新时重建、无线设备释放时销毁，这些额外的内存管理和同步机制对一个只做 29 次比较的函数来说，收益不抵复杂度。MTK 的优化"免费"，是因为它挂在已有的 StaRec 生命周期上；内核通用层没有这个天然载体。

如果内核真的合并这个优化——在 cfg80211 层新增平坦表的生命周期管理（分配时构建、更新时重建、销毁时释放），代码复杂度会显著增加：QoS Map 更新路径的代码量翻倍，还要处理 mac80211 和 Full-MAC 驱动对平坦表所有权的争议。

即使假设代码复杂度可接受，性能收益也不可观：线性扫描 29 次比较最多触发 29 个分支，现代 CPU 的分支预测器对这种顺序访问模式的预测准确率超过 99%，实际每次查表只触发 1-2 次分支预测失败（约 15-20ns 惩罚）。在 mt7622（4 核 Cortex-A53 @1.35GHz，典型 OpenWrt 路由器芯片）上，线性扫描耗时约 20ns，O(1) 查表约 2ns——省下 18ns。

但这个节省在整条 TX 路径中（DMA 映射、固件提交、EDCA 信道竞争，总耗时 50-100μs）占比不到 0.04%，用 iperf3 跑 TCP 吞吐测试，差异会淹没在测量噪声里。这就是内核维护者拒绝合并的根本原因——不是技术上不可行，而是收益太小不值得用代码复杂度去换。

**`array_index_nospec` 安全加固与信任边界**：函数末尾的 `return array_index_nospec(ret, IEEE80211_NUM_TIDS)` 不是普通的数组边界检查——它是内核针对 Spectre v1（推测执行侧信道攻击）的缓解措施。CPU 可以在分支条件尚未确定时推测性地执行越界代码路径，通过缓存侧信道泄露敏感数据。`array_index_nospec` 通过屏障指令阻止推测执行生成越界地址，即使 `ret` 已被分支保护限制在 0-7，硬件层面的推测仍可能绕过软件检查。`IEEE80211_NUM_TIDS` 的值是 16，内核在逻辑保护之上仍做一次硬件层面的范围裁剪，体现了"不信任硬件行为"原则。

这道防线之所以必要，是因为 QoS Map 本身来自不信任的 AP（通过无线帧接收，任何同频设备可伪造）——`array_index_nospec` 的边界裁剪是最后一道防线，即使 AP 下发恶意 QoS Map 把某个 DSCP 映射到 UP 15，内核也不会越界访问。下面这个具体攻击场景，展示没有这道防线时会发生什么。

一个具体的攻击场景：攻击者架设 rogue AP，STA 关联后发送一个恶意 QoS Map Configure Action Frame，将 DSCP 0（BE，最常见的默认值）映射到 UP 15（越界）。STA 接受后更新 `adapter->dscp_to_up_map[0] = 15`。随后攻击者持续向 STA 发送 DSCP=0 的数据帧——STA 内核调用 `cfg80211_classify8021d` 时，QoS Map Exception 表命中，`ret` 被设为 15。如果没有 `array_index_nospec`，CPU 在判断 `ret < IEEE80211_NUM_TIDS` 的分支结果确定之前，会推测性地以 `ret=15` 为索引访问下游数组（如 QCOM 的 `dscp_to_up_map[15]`），将该地址对应的缓存行拉入 L1d cache。

攻击者通过同设备上的协同 App 测量缓存访问延迟（Prime+Probe 或 Flush+Reload），即可推断该缓存行中相邻内存的内容——如果内核堆布局恰好将 `dscp_to_up_map` 数组与密钥材料或内核指针放在同一缓存行（64 字节），攻击者就能从推测执行的缓存残留中提取敏感数据。`array_index_nospec` 的屏障指令清除了推测执行产生的中间缓存状态，将攻击面从"所有64字节的缓存行内容"收窄为"仅 `ret` 本身的值"——后者已被分支保护限制在 0-7，不携带任何信息。

`cfg80211_qos_map` 结构体（`include/net/cfg80211.h`）：

```c
// include/net/cfg80211.h — cfg80211_qos_map, QoS Map 数据结构
struct cfg80211_dscp_exception {
    u8 dscp;
    u8 up;
};

struct cfg80211_qos_map {
    u8 num_des;
    struct cfg80211_dscp_exception dscp_exception[IEEE80211_QOS_MAP_MAX_EX];
    struct cfg80211_dscp_range up[8];
};

```

`IEEE80211_QOS_MAP_MAX_EX` 的值为 21——这是 IEEE 802.11 规范为 DSCP Exception 列表设定的上限，内核常量直接对齐此值。结合 UP Range 表的 16 字节，QoS Map element 最大长度为 58 字节（`IEEE80211_QOS_MAP_LEN_MAX = 16 + 2 * 21`）。这个 21 并非空间瓶颈的产物——QoS Map element 的 Length 字段为 1 字节，理论最大 payload 255 字节，减去 16 字节 Range 表后可容纳 (255-16)/2 = 119 条 Exception，远超 21。规范选择 21 是工程实用性与协议复杂度的平衡：WiFi QoS 场景中需要精细映射的 DSCP 值集中在 CS1（8）、AF2x（18-30）、CS3-CS5（24-40）、VA/EF（44-46）、CS6-CS7（48-56）约 17 个值，21 条留出了 4 条余量给运营商自定义扩展；同时，Exception 列表的线性扫描成本与条目数成正比，21 条上限将 worst-case 比较次数控制在 29 次（21+8），在 10Gbps 级 PPS 下仍是可接受的 CPU 开销。如果放开到 119 条，每次发包最多 127 次比较，高流量场景下的 CPU 开销会显著增加——规范在灵活性和性能之间选了一个务实的平衡点

不用 QoS Map 时，DSCP→UP 映射只是取高 3 位：DSCP 0-7→UP 0，DSCP 8-15→UP 1，..., DSCP 56-63→UP 7。加上 QoS Map 后，AP 可以把 DSCP 46（EF）单独拎出来映射到 UP 6（VO），而不影响其他 DSCP 40-47 的默认映射。没有 QoS Map 时的 `dscp >> 5` 就像快递公司只有 8 个大区分类——DSCP 有 64 种细粒度标签，但分拣中心只认大区编号，所有标签被粗暴地归入 8 个桶；QoS Map 的 Exception 表相当于在大区分类之上叠加了一份"VIP 件清单"，让特定标签绕过大区规则、直接走上加急传送带。

下图展示了 DSCP→UP→AC 的完整映射流程——从 IP 头的 DSCP 值出发，经过 Exception 表精确匹配、Range 表范围匹配、回退映射三层判定，最终确定 User Priority 和 WMM AC 队列：

![DSCP→UP→AC 映射流程：Exception 表精确匹配优先于 Range 表范围匹配，二者都未命中时回退到 dscp>>5](assets/07e-%E6%95%B0%E6%8D%AE%E5%B8%A7%E5%8F%91%E9%80%81%E8%BF%9B%E9%98%B6%EF%BC%9ADSCP%E2%86%92UP-%E6%98%A0%E5%B0%84%E4%B8%8E-QoS-Map/07e-dscp-up-ac-mapping.svg)

---

# 4 MTK 怎么在发包前做 DSCP→UP 映射？

MTK gen4m 驱动中，DSCP→UP 映射发生在 `ndo_select_queue`——早于 `ndo_start_xmit`。这是协议栈在选择 TX 队列时调用的回调，由 `mtk_wlan_ndev_select_queue` 实现：

```c
// MTK gen4m: os/linux/gl_init.c:2405 — mtk_wlan_ndev_select_queue
static inline u16 mtk_wlan_ndev_select_queue(struct net_device *dev,
    struct sk_buff *skb, void *fallback)
{
    static const u16 ieee8021d_to_queue[8] = {
        ACI_BK, ACI_BE, ACI_BE, ACI_BK, ACI_VI, ACI_VI, ACI_VO, ACI_VO};
    u16 queue_index = 0;
    struct cfg80211_qos_map *qos_map = NULL;

    qos_map = get_qos_map(dev);

    // cfg80211_classify8021d 返回 0~7
    skb->priority = cfg80211_classify8021d(skb, qos_map);

    queue_index = ieee8021d_to_queue[skb->priority];

    if (is_critical_packet(dev, skb, queue_index)) {
        skb->priority = WMM_UP_VO_INDEX;
        queue_index = ieee8021d_to_queue[skb->priority];
    }

    return queue_index;
}

```

函数做了三件事：

- **调用 `get_qos_map(dev)`**：从当前连接的 STA Record 中提取 AP 下发的 QoS Map——如果没有，返回默认表

- **调用标准的 `cfg80211_classify8021d(skb, qos_map)`**：使用内核的标准分类函数，用 QoS Map 覆盖默认 DSCP→UP 映射

- **`ieee8021d_to_queue` 查表**：UP 0→ACI_BK, UP 1→ACI_BE, UP 2→ACI_BE, UP 3→ACI_BK, UP 4→ACI_VI, UP 5→ACI_VI, UP 6→ACI_VO, UP 7→ACI_VO。UP 3 映射到 BK 而非标准的 BE，因为 Excellent Effort（EE，UP 3）是 802.1D 定义的一种介于 Best Effort 与 Controlled Load 之间的服务类型，从未在实际 WiFi 部署中被使用，MTK 将这个空闲优先级降级到 BK 是合理的工程选择。

- **ACI 编号不是优先级阶梯**：ACI 值定义于 `include/mgmt/bss.h:244`（ACI_BE=0, ACI_BK=1, ACI_VI=2, ACI_VO=3），是 WMM AC 的硬件队列索引编号，直接作为 `queue_index` 返回。直觉上容易把 ACI 编号等同于优先级阶梯，但 ACI 只是队列的硬件地址——真正决定"谁先发"的是 EDCA 参数（AIFS、CWmin、CWmax、TXOP），AC_BK 的 AIFS 最长、CWmin 最大，信道竞争最不激进，而 AC_BE 的 AIFS 更短、CWmin 更小，实际接入优先级反而高于 AC_BK。ACI 编号 0/1/2/3 不代表优先级阶梯，只是固件调度器索引队列的地址。

- **MTK 与内核的 UP→AC 映射差异**：MTK 的 `ieee8021d_to_queue` 映射与内核 mac80211 的标准 `ieee802_1d_to_ac[]`（`net/mac80211/wme.c:23`）在 UP 0~3 四个值上恰好相反——内核将 UP 0 映射到 BE、UP 1 映射到 BK、UP 2 映射到 BK、UP 3 映射到 BE，MTK 则将 UP 0 映射到 BK、UP 1 映射到 BE、UP 2 映射到 BE、UP 3 映射到 BK（UP 4-7 两侧一致）。

- **差异源于 WMM 规范的 ACI 编码**：WMM Spec §2.2.2 对 ACI 编码的定义：ACI_BE=0、ACI_BK=1，MTK 的映射直接按 UP 值递增对应 ACI 编号（低 UP→低 ACI），而内核的映射则遵循 802.1D 原始语义（UP 0/3 是 BE 优先级走 BE 队列，UP 1/2 是 BK 优先级走 BK 队列，因为 BK 队列的 EDCA 参数过于保守，将最低优先级流量放入 BK 队列会导致它在信道竞争中完全饿死）

- **从 queue_index 到硬件 TX ring**：MTK 的 netdev 通过 `alloc_netdev_mq(..., CFG_MAX_TXQ_NUM)` 分配了 4 个 TX subqueue（`gl_os.h:30`：`CFG_MAX_TXQ_NUM=4`），`queue_index` 直接对应其中一个硬件 TX 队列。`skb->queue_mapping` 设置为这个值后，整条链路逐层传递：

  - `kalHardStartXmit`（`gl_kal.c:3692`）通过 `skb_get_queue_mapping` 取出队列号——`ndo_start_xmit` 只拿到 skb，得从 `skb->queue_mapping` 取回 `ndo_select_queue` 阶段选定的队列
  - QM 层 `QM_TX_SET_MSDU_INFO_FOR_DATA_PACKET`（`que_mgt.h:909`）写入 `MSDU_INFO.ucTC`，即 Traffic Class（TC0-TC3 对应 AC0-AC3）——把 Linux 队列号翻译成固件调度器认识的流量类别
  - `nicTxGetTxDestQIdxByTc`（`nic_tx.h:1874`）映射到 HIF TX 硬件队列 HIF_TX_AC0_INDEX ~ HIF_TX_AC3_INDEX——TC 最终要落到具体 DMA ring，硬件才能取包发送

  从 DSCP 到硬件 TX ring，整条链路一气呵成

- **关键包提升**：`is_critical_packet` 检测到 ARP 或 EAPOL（802.1X）等关键帧时，直接提升到 VO 优先级——无论 QoS Map 怎么说

`get_qos_map` 的实现展示了 MTK 的结构体布局兼容技巧：

```c
// MTK gen4m: os/linux/gl_init.c:2313 — get_qos_map, 从 STA Record 取 QoS Map
static struct cfg80211_qos_map *get_qos_map(struct net_device *dev)
{
    struct cfg80211_qos_map *qos_map = &default_qos_map;
    // ...获取 GlueInfo, Adapter, BssInfo, StaRec...
    prStaRec = prBssInfo->prStaRecOfAP;
    if (prStaRec)
        qos_map = (struct cfg80211_qos_map *)&prStaRec->rQosMap;
    return qos_map;
}

```

其中 `default_qos_map` 定义了 17 条 DSCP Exception（或 `CFG_WIFI_AT_THE_EDGE_QOS` 下的 15 条），基于 RFC 8325 推荐值。关键的结构体布局要求是 `struct QOS_MAP`（MTK 内部类型，定义于 `include/mgmt/cnm_mem.h:226`）和 `struct cfg80211_qos_map`（内核类型）之间有严格的字段对应关系——通过四个 `_Static_assert` 在编译期验证。

QoS Map 的动态更新来自 AP 下发的 QoS Map Configure Action Frame。`handleQosMapConf`（`qosmap.c:165`）是 QoS Action 帧的分发器——它根据 Action 字段分发到不同处理函数，其中 `ACTION_QOS_MAP_CONFIGURE` 由 `qosHandleQosMapConfigure` 处理。后者验证帧长度和 STA Record 有效性后，调用 `qosParseQosMapSet`（`qosmap.c:291`）解析 IE。`qosParseQosMapSet` 的工作分两步：先调用 `qosBuildQosMapTable` 解析 Range 表和 Exception 表，构建 `prStaRec->qosMapTable`（一个 64 字节的 DSCP→UP 平坦查找表）——固件 TX 路径收到数据包后按 DSCP 直接索引这张表得到 TID，避免逐包回 host 查表；再调用 `updateCachedQosMap` 将原始 IE 字节缓存到 `prStaRec->rQosMap`——`ndo_select_queue` 时 `cfg80211_classify8021d` 查询的正是这个 `cfg80211_qos_map` 结构体，按 Exception→Range 两阶段匹配查表：

```c
// MTK gen4m: mgmt/qosmap.c:236 — updateCachedQosMap, 缓存 QoS Map 原始字节
static void updateCachedQosMap(struct STA_RECORD *prStaRec, uint8_t ucDscpExNum,
                               const uint8_t *dscp_exception,
                               const uint8_t *dscp_range)
{
    prStaRec->rQosMap.ucDscpExNum = ucDscpExNum;
    kalMemCopy(&prStaRec->rQosMap.arDscpException, dscp_exception,
               dscp_range - dscp_exception);
    kalMemCopy(&prStaRec->rQosMap.arDscpRange, dscp_range,
               sizeof(prStaRec->rQosMap.arDscpRange));
}

```

`QOS_MAP` 结构体中 `ucDscpExNum`、`arDscpException` 和 `arDscpRange` 这三个字段与内核的 `cfg80211_qos_map` 完全对应——`get_qos_map` 将 `prStaRec->rQosMap` 的地址强转为 `struct cfg80211_qos_map *`，`cfg80211_classify8021d` 直接按内核结构体的字段偏移读取，省去了一次数据拷贝。`qosBuildQosMapTable` 先遍历 Range 表设置每个 UP 的 DSCP 范围，再遍历 Exception 表覆盖特定 DSCP——后者优先级更高，与 `cfg80211_classify8021d` 的两阶段匹配逻辑完全一致。

**默认 DSCP Exception 映射**（MTK 默认表，gl_init.c:121）：

| DSCP                             | UP     | 说明             |
| -------------------------------- | ------ | ---------------- |
| 8 (CS1)                          | 1 (BK) | 低优先级数据     |
| 18,20,22 (AF21,AF22,AF23)        | 3 (EE) | 保证转发 class 2 |
| 24,26,28,30 (CS3,AF31,AF32,AF33) | 4 (CL) | 保证转发 class 3 |
| 32,34,36,38 (CS4,AF41,AF42,AF43) | 4 (CL) | 保证转发 class 4 |
| 40 (CS5)                         | 5 (VI) | 信令             |
| 44,46 (VA,EF)                    | 6 (VO) | 语音/实时流量    |
| 48 (CS6)                         | 6 (VO) | 网络控制         |
| 56 (CS7)                         | 7 (NC) | 网络控制         |

对于没有出现在 Exception 表中的 DSCP 值，UP Range 表 `up = {{0, 63}}` 将全部 DSCP 0-63 覆盖为 UP 0——但 Exception 表优先，所以实际效果是"不在表里的都走 UP 0 (BE)"。这就像一个快递网点的分拣规则：Exception 表是手写的特殊件清单（"这个地址的件走加急"），Range 表是兜底规则（"其他一律走普通"），两层叠加后，只有清单上列明的地址才能享受特殊待遇。

---

# 5 QCOM 把 DSCP→UP 映射交给了谁？

QCOM 的处理比 MTK 更复杂——它**同时**在 host 侧和固件侧做 DSCP→UP 映射，两层各自查表，但查的是同一张表。

## 5.1 初始化：填充默认映射表

`hdd_wmm_dscp_initial_state`（`wlan_hdd_wmm.c:1635`）是 DSCP 映射初始化的编排函数，按顺序执行三步：

```c
// QCOM: core/hdd/src/wlan_hdd_wmm.c:1635 — hdd_wmm_dscp_initial_state, 初始化编排
QDF_STATUS hdd_wmm_dscp_initial_state(struct hdd_adapter *adapter)
{
    // 第1步：填充默认映射表（dscp >> 3）
    hdd_fill_dscp_to_up_map(adapter->dscp_to_up_map);

    // 第2步：RFC 8325 定制覆盖（如果编译了 WLAN_CUSTOM_DSCP_UP_MAP）
    // 第3步：定制成功时下发到固件（通过 WMI）
    if (hdd_custom_dscp_up_map(adapter->dscp_to_up_map) == QDF_STATUS_SUCCESS)
        hdd_send_dscp_up_map_to_fw(adapter);
    return QDF_STATUS_SUCCESS;
}

```

三步编排中的第一步——`hdd_fill_dscp_to_up_map`（`wlan_hdd_wmm.c:1561`）——负责构建默认映射表。这张表是 QCOM 驱动的"出厂设置"：先把所有 64 个 DSCP 值按 `dscp >> 3` 粗分到 8 个 UP 桶里，再把 DSCP 46（EF，语音）单独拎出来硬编码到 UP 6（VO）。这就像用不同精度的地图做地址匹配——出厂默认是高速公路地图，只认省界，64 个 DSCP 被粗暴归入 8 个大区；但语音流量（DSCP 46）是 VIP 地址，即使在高速公路地图上也要单独标出来：

```c
// QCOM: core/hdd/src/wlan_hdd_wmm.c:1561 — hdd_fill_dscp_to_up_map
static inline void hdd_fill_dscp_to_up_map(
        enum sme_qos_wmmuptype *dscp_to_up_map)
{
    uint8_t dscp;

    // 默认：取 DSCP 高 3 位作为 UP
    for (dscp = 0; dscp <= WLAN_MAX_DSCP; dscp++)
        dscp_to_up_map[dscp] = dscp >> 3;

    // 特殊处理：DSCP 46 (EF) → UP 6 (VO)
    dscp_to_up_map[DSCP(46)] = SME_QOS_WMM_UP_VO;
}

```

如果编译时启用了 `WLAN_CUSTOM_DSCP_UP_MAP`，`hdd_custom_dscp_up_map` 进一步覆盖 RFC 8325 推荐值（与 §4 的 MTK 默认表共用同一套推荐值，差异仅在编译开关——QCOM 是 `WLAN_CUSTOM_DSCP_UP_MAP`，MTK 是 `CFG_WIFI_AT_THE_EDGE_QOS`）——相当于把高速公路地图升级为城市地图，认到街区，语音（DSCP 46）、信令（DSCP 40）等关键地址被单独标注。但这两层都是 STA 自带的导航数据——真正的权威地图来自 AP。AP 在关联响应中携带 QoS Map element 时，host 需要用 AP 的映射覆盖整张表：AP 的 QoS Map 相当于收件人自己写的门牌号级地址，精确到每个 DSCP 值应该走哪个队列，比任何预置地图都准确。这个覆盖发生在关联时——回到开篇的快递场景，STA 自带的导航地图再全，也只是快递单的补充注记；包裹最终走哪条传送带，还是以收件人在快递单上写下的门牌号（AP 的 QoS Map）为准。

## 5.2 连接时：用 AP 的 QoS Map 覆盖默认表

`hdd_wmm_assoc`（`wlan_hdd_wmm.c:2430`）在关联/重关联时调用，核心逻辑是**用 AP 下发的 QoS Map 覆盖默认表**：

```c
// QCOM: core/hdd/src/wlan_hdd_wmm.c:2430 — hdd_wmm_assoc, 关联时更新 DSCP 映射
QDF_STATUS hdd_wmm_assoc(struct hdd_adapter *adapter, bool is_reassoc,
                          uint8_t uapsd_mask)
{
    // ...UAPSD 配置...

    // 尝试用 AP 下发的 QoS Map 更新 adapter 的 DSCP→UP 表
    status = sme_update_dsc_pto_up_mapping(hdd_ctx->mac_handle,
                                           adapter->dscp_to_up_map,
                                           adapter->vdev_id);
    if (!QDF_IS_STATUS_SUCCESS(status)) {
        // AP 未提供 QoS Map → 回退到默认映射
        hdd_wmm_dscp_initial_state(adapter);
    }
    // ...
}

```

`sme_update_dsc_pto_up_mapping`（`sme_api.c:8805`）是核心函数——它从 PE session 中取出 AP 下发的 `QosMapSet`，依次遍历 DSCP 范围表和 DSCP 异常表，覆盖 `adapter->dscp_to_up_map`：

```c
// QCOM: core/sme/src/common/sme_api.c:8805 — sme_update_dsc_pto_up_mapping
QDF_STATUS sme_update_dsc_pto_up_mapping(mac_handle_t mac_handle,
                                          enum sme_qos_wmmuptype *dscpmapping,
                                          uint8_t sessionId)
{
    // 从 session 中取出 AP 下发的 QosMapSet
    if (!pSession->QosMapSet.present)
        return QDF_STATUS_E_FAILURE;

    // 第1轮：遍历 DSCP Range 表（8 个 UP 各一段范围），设置每个 UP 的 DSCP 范围映射
    for (i = 0; i < SME_QOS_WMM_UP_MAX; i++) {
        for (dscp = pSession->QosMapSet.dscp_range[i][0];
             dscp <= pSession->QosMapSet.dscp_range[i][1] && dscp <= WLAN_MAX_DSCP;
             dscp++)
            dscpmapping[dscp] = i;
    }

    // 第2轮：遍历 DSCP Exception 表，覆盖异常项（优先级高于 Range）
    for (i = 0; i < pSession->QosMapSet.num_dscp_exceptions; i++)
        if (pSession->QosMapSet.dscp_exceptions[i][0] <= WLAN_MAX_DSCP &&
            pSession->QosMapSet.dscp_exceptions[i][1] < SME_QOS_WMM_UP_MAX)
            dscpmapping[pSession->QosMapSet.dscp_exceptions[i][0]] =
                    pSession->QosMapSet.dscp_exceptions[i][1];

    return QDF_STATUS_SUCCESS;
}

```

这段代码有两个设计细节：

- **Range 表先写**：大面积覆盖，Exception 表后写（精确覆盖），后者优先级更高
- **失败回退**：如果 AP 的 Assoc Resp 中不包含 QoS Map element（`QosMapSet.present` 为假），返回失败——`hdd_wmm_assoc` 回退到 `hdd_wmm_dscp_initial_state` 使用默认表，就像收件人没写门牌号，包裹退回默认传送带。

## 5.3 AP QoS Map 的接收路径

QoS Map 通过两条路径进入 QCOM 驱动：

**路径 A -- Assoc Resp 携带 QoS Map IE**：`lim_process_assoc_rsp_frame`（`lim_process_message_queue.c:1398`）处理关联响应，经 `sir_convert_assoc_resp_frame2_struct`（`parser_api.c:3945`）解析整个帧体，其中 `convert_qos_mapset_frame`（`utils_parser.c:658`）提取 QoS Map element 并存入 `session->QosMapSet`。

**路径 B -- QoS Map Configure Action Frame（运行时更新）**：`lim_process_action_frame`（`lim_process_message_queue.c:1042`）分发 Action 帧，`__lim_process_qos_map_configure_frame`（`lim_process_action_frame.c:860`）匹配后经 `sir_convert_qos_map_configure_frame2_struct`（`parser_api.c:6116`）解析帧体，同样调用 `convert_qos_mapset_frame` 更新 `session->QosMapSet`。解析完成后，`lim_send_sme_mgmt_frame_ind` 上报 HDD 层，触发 `sme_update_dsc_pto_up_mapping` 更新 adapter 映射表。

两条路径，一个出口——就像快递包裹无论从哪个入口进站，最终都汇到同一个分拣台。最终都会调用 `convert_qos_mapset_frame`（`utils_parser.c:658`），将 dot11 解析后的 `tDot11fIEQosMapSet` 转换为内部 `struct qos_map_set` 并存入 `session->QosMapSet`。

## 5.4 Host 侧数据面查表

> **双平台对照**：上一节 MTK 在 `ndo_select_queue` 阶段调用内核的 `cfg80211_classify8021d` 完成 DSCP→UP 映射（§4），本节 QCOM 同样在 `ndo_select_queue` 阶段做映射——只是走自有的 `hdd_select_queue` → `__hdd_wmm_select_queue` → `hdd_wmm_classify_pkt` 查表，而非内核标准函数。两者的输入（DSCP）、输出（UP）和生效时机相同，真正的差异在查表函数和是否把映射表下发固件。

TX 路径的另一个关键环节是 host 侧数据面的查表：在数据帧发送篇中我们追踪了 `__hdd_hard_start_xmit` 的完整流程，其中 `skb->priority` 直接作为 WMM AC 分类的输入。但 **`skb->priority` 的值从哪来？**

答案在 `hdd_wmm_classify_pkt`（`wlan_hdd_wmm.c:2042`）中。这个函数由 `ndo_select_queue` 回调 `hdd_select_queue` → `__hdd_wmm_select_queue`（`wlan_hdd_wmm.c:2202`）调用——比 `__hdd_hard_start_xmit` 的 WMM 分类更早，它通过 `hdd_wmm_get_user_priority_from_ip_tos` 查 `adapter->dscp_to_up_map`：

`hdd_wmm_get_user_priority_from_ip_tos`（`wlan_hdd_wmm.c:1908`）从 skb 的以太网/802.3 帧头中定位 IP 头，提取 TOS 字段，再右移 2 位取高 6 bit 作为 DSCP 值：

```c
// QCOM: core/hdd/src/wlan_hdd_wmm.c:2014 — DSCP 提取（hdd_wmm_get_user_priority_from_ip_tos 内部）
dscp = (tos >> 2) & 0x3f;

```

拿到 DSCP 后，直接查 `adapter->dscp_to_up_map[dscp]` 获取 UP 值。整个函数支持 4 种帧封装（Ethernet II IP、Ethernet II IPv6、802.3 LLC/SNAP IP、VLAN tagged），每种都是从对应位置取 TOS 字段——逻辑相同，只是 IP 头的偏移量不同。

这正是 `sme_update_dsc_pto_up_mapping` 覆盖 `adapter->dscp_to_up_map` 后的效果——AP 的 QoS Map 在 host 侧数据面上**立即生效**，不需要经过固件。同一个 DSCP 值在 host 侧用这张表翻译一次（确定 AC 队列）；进入固件后，固件侧用自己初始化时下发的默认表再翻译一次（确定 TID/队列）。注意这两张表未必是同一份原文——host 侧的表跟着 AP 的 QoS Map 更新，固件侧的表停留在初始化默认值（见 §5.5），AP 下发自定义映射时，同一个 DSCP 值可能在 host 与固件两条传送带上被分进不同的队列。

为什么 QCOM 需要在 host 侧也做 DSCP→UP 映射，而不是全部交给固件？QCOM 的映射同样发生在 `ndo_select_queue` 阶段——`__hdd_wmm_select_queue` 调用 `hdd_wmm_classify_pkt` 得到 UP 后，经 `hdd_update_pkt_priority_with_inspection` 写回 `skb->priority`，再据此选择 TX 队列。所以 QCOM 的 host 侧映射同样影响 Linux qdisc。它的价值在于：WMM AC 分类（BK/BE/VI/VO 队列选择）和 TX rate 控制都基于 `skb->priority`，如果这个值在进入驱动时还是内核默认的 `dscp >> 5` 映射（而不是 AP 下发的 QoS Map），AC 分类会把 DSCP 46（EF）分到 VI 队列而非 VO 队列——语音帧走了视频队列，延迟特性就错了。

host 侧映射确保驱动内部的 AC 分类基于 AP 的 QoS Map 而非内核默认值。但这里有一个架构层面的 trade-off：QCOM 选择 host+固件双侧映射，而固件侧的映射表只在初始化时通过 WMI 下发一次（`hdd_wmm_dscp_initial_state`），AP 的 QoS Map 更新只落到 host 侧。于是当 AP 下发了与默认表不同的映射时，host 用 AP 的 QoS Map、固件用初始化默认值，同一个 DSCP 在两侧得到不同的 UP——这不是"短暂不一致"，而是持续到下一次重新初始化的稳态差异。

MTK 的单点映射（`ndo_select_queue` 阶段一次性完成）避免了这个问题——映射结果直接写入 `skb->priority`，后续所有层（qdisc、固件 TX 调度）都基于这个值，不存在不一致的风险。

QCOM 接受这个风险的原因是 HW offload 架构的性能收益：固件 DMA 引擎可以直接读取包头做查表，省去了 host 侧逐包解析后通过 WMI 下发映射结果的开销——64 字节的映射表由 `hdd_send_dscp_up_map_to_fw` 一次性下发（经 `wmi_unified_send_dscp_tip_map_cmd` 编码进 WMI），远比每包 4 字节的 WMI 通知高效。

如果 QCOM 改用 MTK 的方案——放弃固件侧映射表、只在 host 侧一次性完成映射（不再通过 WMI 下发固件）——架构上会损失两样东西：第一，固件的 TX 聚合效率。QCOM 的固件在做 A-MSDU/A-MPDU 聚合时，需要根据 TID（Traffic ID，由 UP 派生）决定哪些帧可以聚合到同一个 AMPDU——如果映射在 host 侧完成，固件只能从 TX 描述符的元数据字段读取 host 传下来的 UP 值，但 QCOM 的 TX 描述符中 UP 字段位宽有限（3 bit，恰好 0-7），且该字段在部分芯片型号上与其他标志位复用，映射结果的传递路径比固件本地查表多一跳。第二，固件快速路径退化。QCOM 的固件 DMA 引擎在收到 TX 描述符后，可以直接从包头的 DSCP 字段查 64 字节映射表确定 UP，整个过程在固件微码中完成，不需要 host 侧参与；改为 host 侧映射后，固件要从描述符的元数据字段读取 UP，增加了描述符解析的延迟——虽然单包只有几百皮秒，但在高 PPS 场景下累积效应不可忽略。

QCOM 选择双侧映射的根源是 HW offload 架构的哲学：让固件尽可能自主地完成包处理，减少对 host 侧的依赖——映射表一次性下发，固件本地查表，host 侧不参与热路径。

## 5.5 下发固件

`hdd_send_dscp_up_map_to_fw`（`wlan_hdd_wmm.c:1534`）在初始化阶段（由 `hdd_wmm_dscp_initial_state` 触发）将默认映射表下发到固件。下面这条调用链从 host 的 HDD 层一路下沉到固件，共 7 层——读链的要点是看它怎么一层层往下传：`hdd_send_dscp_up_map_to_fw` 是 host 侧入口，经 os_if、ucfg、target_if 三层转发进入 WMI 通道，最终由 `send_dscp_tid_map_cmd_tlv` 编码成 TLV，固件解包后更新内部 DSCP→TID 映射表：

```
hdd_send_dscp_up_map_to_fw
  → os_if_fwol_send_dscp_up_map_to_fw               // os_if/fw_offload/src/os_if_fwol.c:136
    → ucfg_fwol_send_dscp_up_map_to_fw               // components/fw_offload/dispatcher/
      → target_if_fwol_send_dscp_up_map_to_fw        // components/target_if/fw_offload/
        → wmi_unified_send_dscp_tip_map_cmd           // WMI 通道
          → send_dscp_tid_map_cmd_tlv                 // TLV 编码
            → 固件更新内部 DSCP→TID 映射表

```

与 MTK 的区别不在于"谁做映射"或"在哪一层做"（两者都在 `ndo_select_queue` 阶段），而在于"是否下发固件"：QCOM 在初始化时把默认映射表下发固件做双侧映射；MTK 用内核 `cfg80211_classify8021d` 单点映射、不下发固件。但有一个关键细节——`hdd_send_dscp_up_map_to_fw` 只在 `hdd_wmm_dscp_initial_state` 中调用（初始化，或 AP 未下发 QoS Map 时的回退，见 §5.2）；当 AP 在关联时下发 QoS Map、`sme_update_dsc_pto_up_mapping` 成功覆盖 `adapter->dscp_to_up_map` 时，host **不会**重新下发固件。固件的 DSCP→TID 表停留在初始化时的默认值，只有 host 侧跟着 AP 的 QoS Map 走——这正是 §5.4 提到的"host 与固件两侧可能不一致"的真正来源。QCOM 选择在固件侧维护一份映射表，根因是 HW offload 架构——64 字节的映射表一次性下发，固件 DMA 引擎直接在包处理路径中查表，比逐包通过 WMI 下发映射结果高效得多。

QCOM 的 host+固件双侧映射与 MTK 的 host 侧单次映射，差异的根源在于架构选择——QCOM 的 HW offload 架构让固件 DMA 引擎直接查 64 字节映射表，省去逐包 WMI 通知的开销；MTK 选择在 host 侧单次映射，映射结果写入 `skb->priority` 后全链路可见，架构更简洁。下面这张对比表把两个平台的关键差异浓缩到一起。

---

# 6 同一个 DSCP，QCOM 和 MTK 送到哪个队列？

下表从映射位置、映射函数、默认表、RFC 8325 支持、AP QoS Map 覆盖、生效时机六个维度，把两个平台的差异逐项并列——读表时先抓住「映射位置」和「默认表」两行，其余各行都从这两行派生：

| 维度           | QCOM                                                         | MTK                                                          |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **映射位置**   | Host 侧 `ndo_select_queue`（`hdd_wmm_classify_pkt`）+ 固件侧 | Host 侧 `ndo_select_queue`（`mtk_wlan_ndev_select_queue`）   |
| **映射函数**   | `hdd_wmm_get_user_priority_from_ip_tos`（查 adapter 表）+ 固件自实现 | `cfg80211_classify8021d`（Linux 内核标准函数）               |
| **默认表**     | `dscp >> 3` + EF→VO 硬编码                                   | 17 条 DSCP Exception + UP Range 全覆盖                       |
| **RFC 8325**   | 可选（`WLAN_CUSTOM_DSCP_UP_MAP` 编译开关）                   | 内置（`CFG_WIFI_AT_THE_EDGE_QOS` 可变体）                    |
| **AP QoS Map** | 接收并通过 `sme_update_dsc_pto_up_mapping` 覆盖 adapter 表（仅 host 侧；固件表停留在初始化默认值） | 接收并存储到 STA Record，立即生效                            |
| **生效时机**   | 表在关联/收到 Action Frame 时更新，每次发包 `ndo_select_queue` 查表 | 表在关联/收到 Action Frame 时更新，每次发包 `ndo_select_queue` 查表 |
| **DSCP 46→UP** | UP 6 (VO)，硬编码                                            | UP 6 (VO)，Exception 表匹配                                  |
| **DSCP 8→UP**  | UP 1 (BK)，`8 >> 3 = 1`                                      | UP 1 (BK)，Exception 表匹配                                  |
| **DSCP 24→UP** | UP 3（映射到 BE 队列，默认），但如果 AP 下发了 QoS Map 则按 AP 规则 | UP 4（映射到 VI 队列），Exception 表匹配 `{24, 4}`           |

**同一 DSCP 值可能走不同队列**。以 DSCP 24（CS3）为例：QCOM 在未收到 AP QoS Map 时使用 `24 >> 3 = 3`，映射到 UP 3（落在 BE 队列）；MTK 的 Exception 表中 `{24, 4}` 将其映射到 UP 4（落在 VI 队列）。但如果 AP 下发了 QoS Map 且其中将 DSCP 24 映射到了 VI，QCOM 也会跟进——`sme_update_dsc_pto_up_mapping` 在关联时用 AP 的 QoS Map 覆盖了默认表。同样的分叉还有 DSCP 44（VA，Voice-Admit）：MTK 的 Exception 表 `{44, 6}` 把它送进 VO 队列，QCOM 默认表却只对 EF（DSCP 46）做了 VO 硬编码，VA 落在 `44 >> 3 = 5`（VI 队列）——同为语音类 DSCP，一个平台认"准入"、一个平台只认"快速转发"。DSCP 18/20/22（AF2x）也类似：MTK 映射到 UP 3，QCOM 默认 `18 >> 3 = 2` 落到 UP 2。

关键区别是：**MTK 应用 AP QoS Map 后，不同 DSCP 值的映射差异可能比 QCOM 更大**，因为 MTK 默认就有一张 17 条条目的 Exception 表，AP 的覆盖是叠加在这张丰富表之上的；而 QCOM 的默认表只有 `dscp >> 3` 加一个 EF→VO 特殊规则，AP 的覆盖几乎是从零开始。

也有两个平台**默认映射恰好一致**的 DSCP 值。CS6（DSCP 48）和 CS7（DSCP 56）就是典型：QCOM 的 `48 >> 3 = 6`（VO）和 `56 >> 3 = 7`（VO）与 MTK Exception 表中 `{48, 6}` 和 `{56, 7}` 的结果完全相同。这不是巧合——CS6/CS7 是网络控制和网络管理优先级，802.1D 原始定义就将它们放在最高两个 UP 上，`dscp >> 3` 的粗粒度映射恰好捕获了这个设计意图。

**非 IP 帧和关键帧的优先级路径**与 DSCP→UP 映射不同。ARP（ethertype 0x0806）和 EAPOL（ethertype 0x888E）都不是 IP 协议，`cfg80211_classify8021d` 的 `skb->protocol` switch 语句对它们走 `default: return 0` 分支，返回 UP 0（BE）。但 MTK 的 `is_critical_packet` 在 `ndo_select_queue` 阶段拦截 EAPOL（以及 subqueue 拥塞时的 ARP）帧，直接将 `skb->priority` 提升到 VO——绕过整个 DSCP→UP 查表链路。

QCOM 同样在 `ndo_select_queue` 阶段做关键帧拦截：`hdd_wmm_classify_pkt` 首先调用 `hdd_wmm_classify_critical_pkt`（`wlan_hdd_wmm.c:1852`），把 EAPOL 标记为 critical 并置 UP 6（VO）、ARP/DHCP/ICMPv6 NA/NS 标记为 critical 并置 UP 0（BE）——与 MTK「关键帧一律 VO」的策略不同。

另外，`skb->priority` 值 256-263 是内核为 802.1D 优先级保留的魔数范围，`cfg80211_classify8021d` 在步骤 1 就检测到并直接返回（跳过 DSCP 提取和 QoS Map 查表），VLAN 子系统在入队时设置这些值。DSCP=0（BE）在 MTK Exception 表中没有条目，落入 Range 表 `up = {{0, 63}}` 的 UP 0 范围，最终映射到 UP 0（BE）——与 `dscp >> 5` 回退路径的结果一致。

为什么 MTK 要在 `ndo_select_queue` 做这件事？因为 `skb->priority` 一旦在队列选择阶段设置，后续的 `ndo_start_xmit`、qdisc、TC 分类都基于这个值——整个 Linux 网络栈的下游组件都能看到正确的优先级。QCOM 同样在 `ndo_select_queue` 阶段（`__hdd_wmm_select_queue` → `hdd_wmm_classify_pkt`）设置 `skb->priority`，效果与 MTK 一致——两者都在揽件时就给包裹贴好优先级标签，从分拣中心到末端配送全链路按标签调度。真正的差异在标签之外：QCOM 除了贴标签，还在初始化时把默认映射规则抄送一份给固件（双侧映射），让固件的 DMA 引擎在包处理路径上也能独立查表；MTK 则只在 host 侧贴标签，固件依赖 `skb->priority` 一路传下来的结果。

到这里，QoS Map 的全貌已经展开——内核的 `cfg80211_classify8021d` 是公共翻译器，MTK 在 `ndo_select_queue` 阶段调用它当场贴标签，QCOM 同样在 `ndo_select_queue` 阶段用自有的 `hdd_wmm_classify_pkt` 查表，再在初始化时把默认规则手册同步给固件。同一个 DSCP 24（CS3），QCOM 默认给 UP 3（落在 BE 队列），MTK 默认给 UP 4（落在 VI 队列）——这就是"默认映射表不同"带来的实际后果。

QoS Map 回答了数据包在**单条链路**上走什么优先级的传送带。但 WiFi 7 引入了多链路——同一个数据包面前出现了岔路口：走 2.4GHz 还是 5GHz？这不是优先级标签能回答的问题，需要一套全新的链路选择机制。

**本章干货速查**：

| 主题             | 核心机制                          | QCOM                                                     | MTK                                                    |
| ---------------- | --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| DSCP→UP 默认映射 | 取 DSCP 高 3 位（`dscp >> 3`）    | `dscp >> 3` + EF→VO 硬编码                               | 17 条 DSCP Exception（RFC 8325）                       |
| DSCP→UP AP 覆盖  | 关联时 AP QoS Map 覆盖 adapter 表 | `sme_update_dsc_pto_up_mapping` 覆盖 adapter 表          | `ndo_select_queue` 每次发包调 `cfg80211_classify8021d` |
| 映射时机         | 两者都在 ndo_select_queue         | `hdd_wmm_classify_pkt`，写回 `skb->priority`，影响 qdisc | `mtk_wlan_ndev_select_queue`，全链路可见               |
| 固件同步         | 映射表是否下发固件                | 是（WMI `send_dscp_tid_map_cmd_tlv`）                    | 否（host 侧单次映射，`skb->priority` 携带结果）        |

---

协议依据：IEEE 802.11-2024 §9.4.2.93（QoS Map element）、§9.6.3.6（QoS Map Configure 帧）、§10.23.2（EDCA 信道接入）。RFC 8325（Wi-Fi QoS 的 DSCP 映射推荐）。源码路径见各代码块注释。

