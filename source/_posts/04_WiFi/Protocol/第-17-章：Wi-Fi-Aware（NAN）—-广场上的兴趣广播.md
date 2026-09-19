---
title: 第 17 章：Wi-Fi Aware（NAN）— 广场上的兴趣广播
top: 1
related_posts: true
tags:
  - 802.11
categories:
  - WiFi
  - Protocol
abbrlink: '23661156'
date: 2026-09-18 23:39:48
---

> "不需要联网，不需要 GPS。只要彼此靠得够近，设备就能自己'感知'到对方提供了什么。"

---

# 本章导读

前两章的 Wi-Fi Direct 和 Miracast，本质上还是"**先建立一对一连接，再传数据**"。但有一类需求不一样：你想知道"**我周围有谁、在提供什么服务**"——附近哪台打印机能用、附近哪个人在玩同一款游戏、附近哪家店在推送优惠——而且这一切**不依赖 AP、不依赖蜂窝网、不依赖云端**。

这就是 **Wi-Fi Aware** 要解决的问题。它的技术规范叫 <strong>NAN（Neighbor Awareness Networking，邻居感知网络）</strong>。核心理念是：**让一群互不相识的设备，自发地"同步"出一个共同的时间窗口，在这个窗口里互相广播和搜索服务——发现彼此后，再按需建立直接的数据通道。**

<!--more-->

> **本章比喻：广场上的兴趣广播**
> 想象一个大广场，人来人往。大家约定"**每隔一段时间，所有人在同一时刻聚到广场中央**"（Discovery Window）。在这个聚会窗口里：有人举牌喊"我这有充电宝出租！"（**Publish/发布**），有人举牌问"谁有充电宝？"（**Subscribe/订阅**）。一旦供需对上，两人就走到一边、单独交换联系方式并交易（**NDP/数据通道**）。窗口之外，大家各干各的、能省电就省电。没有广场管理员（AP），全靠大家自发对表。

**本章你将学到：**

- NAN 的同步机制：Cluster 怎么诞生、Discovery Window（为什么钉死信道 6）、Anchor Master、Master 选举
- 几个关键地址/标识：NMI、NDI、Cluster ID
- 服务发现：Publish / Subscribe / Follow-up，以及 Matching Filter 匹配
- USD：非同步服务发现
- NAN 数据路径：NDP / NDL / NDC，以及 NDPE 如何让上层直接用 socket
- 带外触发：用 BLE / NFC 先"叫醒"NAN
- 省电：DW 机制如何省电

> **数据来源**：本章所有技术结论基于 `Wi-Fi Aware Specification v4.0.pdf`（Wi-Fi Alliance, 2022）并标注章节。

---



# 1 核心难题 — 没有 AP，谁来"对表"？

传统 Wi-Fi 里，AP 周期性发 Beacon，所有设备靠它**对时、定信道**。但 NAN 没有 AP。一群设备要互相发现，必须先解决两个问题：

1. **时间问题**：什么时候大家一起醒着？（不能 24 小时都开着收发，太费电）
2. **信道问题**：在哪个信道碰头？

NAN 的答案是 **NAN Cluster（NAN 簇）+ Discovery Window（发现窗口）**：让设备自发同步出一个共同的时钟，约定在固定的时间窗、固定的信道上聚会。

## 1.1 Discovery Window（DW）— 约定的聚会时刻

**Discovery Window（发现窗口）**是 NAN 设备**汇聚在一起、高概率可互相发现**的一段时间窗（§3.1）。

| 参数         | 值                        | 说明                                           |
| ------------ | ------------------------- | ---------------------------------------------- |
| **DW 周期**  | 512 TU（≈ 524 ms）        | 相邻两个 DW 起始时刻（DWST）间隔               |
| **DW 时长**  | 16 TU（≈ 16 ms）          | 每个 DW 持续多久                               |
| **发现信道** | 2.4 GHz**信道 6**（强制） | 可选额外用一个 5 GHz 信道（128 TU 偏移后开窗） |

> 广场上的人约定"**每 524 毫秒，所有人聚到广场中央 16 毫秒**"。这 16 毫秒就是"集合时间"——大家都醒着、都在信道 6 上，能互相喊话。其余约 508 毫秒，各自散去休息或忙别的，从而省电。

### 1.1.1 关于"信道 6"：是强制的、不能改

这一点常被问到：**NAN 的发现信道不是默认值，而是规范写死的硬性规定，设备改不了**。§3.2 原文：NAN Discovery "**shall operate only in channel 6 (2.437 GHz)**" in the 2.4 GHz band。

- **为什么钉死一个信道？** 道理和第 14 章 P2P 的"社交信道 1/6/11"一样——发现的本质是"互不相识的设备要碰头"，如果各设备在不同信道找，永远撞不上。把发现**收敛到唯一一个全球公认的信道**，才能保证任意两台 NAN 设备一开机就在同一个地方碰头。选 6 是因为它在 2.4 GHz 三个非重叠信道（1/6/11）里居中。
- **5 GHz 那个也不是随便选的**：NAN 可选地额外在一个 5 GHz 信道开发现窗，但具体哪个**由所在地的法规域（regulatory domain）决定**——UNII-1 用**信道 44**，UNII-3 用**信道 149**，两段都允许时用 **149**（§3.2）。同样不是设备任意挑。
- **注意区分"发现"和"数据"**：被钉死的只是<strong>发现（Discovery）</strong>这件事。一旦发现完成、要建数据通道（NDP），**数据可以走任何法规允许的信道**（§3.2 "Any other channel may be used for NAN Data Path operation"）——见 §6.2.3.3 的默认 NDC 信道（2.4 GHz 用 6、5 GHz 用 149/44）。

> 全城那么多广场，但大家**铁律约定"碰头只在 6 号广场"**——不是谁的偏好，是写进规矩里的，改了就碰不上头。至于碰上头之后去哪儿谈生意（数据信道），那就随你挑了。

![NAN Cluster 同步与 Discovery Window](assets/%E7%AC%AC-17-%E7%AB%A0%EF%BC%9AWi-Fi-Aware%EF%BC%88NAN%EF%BC%89%E2%80%94-%E5%B9%BF%E5%9C%BA%E4%B8%8A%E7%9A%84%E5%85%B4%E8%B6%A3%E5%B9%BF%E6%92%AD/17-nan-dw.svg)

## 1.2 两种 Beacon

DW 内外，NAN 设备发两种 Beacon（§3.3）：

| Beacon                                     | 何时发     | 作用                                            |
| ------------------------------------------ | ---------- | ----------------------------------------------- |
| **NAN Synchronization Beacon（同步信标）** | DW**内**   | 让 Cluster 内所有设备同步时钟（对表）           |
| **NAN Discovery Beacon（发现信标）**       | DW**之间** | 让 Cluster**外**的新设备发现这个 Cluster 的存在 |

两种 Beacon 都以 **6 Mbps** 发送（§2.9.2）。一个设备在一个 DW 内最多发一个同步 Beacon。

---

# 2 NAN Cluster 与 Master 选举

## 2.1 Cluster — 同步到一起的设备群

**NAN Cluster** 是一组共享同一套同步参数（同一个 TSF 时钟、同一个 DW 时间表）的设备集合。Cluster 由 **Cluster ID** 标识——这是一个 MAC 地址，取值 `50-6F-9A-01-00-00` 到 `50-6F-9A-01-FF-FF`，由发起 Cluster 的设备随机选定（§2.8.2）。

## 2.2 Cluster 是怎么"诞生"的

这是另一个常见疑问：**第一个 Cluster 从哪冒出来的？没有 AP 发 Beacon，谁来起这个头？** 答案是一套"**先找、找不到就自己建**"的自举（bootstrap）逻辑（§3.4.1）：

设备一**激活 NAN 功能**，就走这个分叉：

1. **先被动扫描（passive scan）**：在信道 6（和可选的 5 GHz 发现信道）上**只听不发**，看看附近有没有现成 Cluster 的 Beacon（同步 Beacon 或发现 Beacon）。
2. **听到了 → 加入**：若发现一个或多个 Cluster，**加入 Cluster Grade（CG）最高的那个**（CG 相同则选 AMR 最高的），并**采纳它的全部同步参数**（包括 TSF 时钟、DW 时间表）——从此和大家对上表。
3. **没听到 → 自己创建**：若扫了一圈一个 Cluster 都没有，设备就**自己创建一个新 Cluster**——

   - **随机选一个 Cluster ID**（`50-6F-9A-01-xx-xx` 范围内）；
   - 以自己的 TSF 为 time zero，**定义出一串相隔 512 TU 的 DWST**（发现窗起始时刻），把"集合时间表"立起来；
   - **自己成为这个 Cluster 的 Anchor Master**（全簇时间基准）；
   - 刚创建时，规范要求把 **Master Preference 和 Random Factor 都先置 0**（§3.3.3），之后再按规则抬升。

> **所以 Cluster 的"第一推动力"来自这第 3 步**：当一个区域里所有设备都没听到别人，**总有一台会率先建起 Cluster**，开始周期性发 Beacon；后来的设备扫到它，就纷纷加入。Cluster 不需要任何中心节点钦定——它是**第一个"喊话"的设备自发拉起来的**。

> 你到了广场，先**站定听一会儿**（被动扫描）——如果已经有一圈人在那儿对表聚会（现成 Cluster），你就走过去加入人最多最靠谱的那圈（CG 最高）。但如果广场上**空无一人**，你也不会干等，而是**自己往中间一站、掏出表开始每隔 524 ms 招呼一次**（创建 Cluster、自当 Anchor Master）——你就成了这场聚会的发起人。等别人陆续到了，看见你在招呼，就围过来一起对表。

> **补充：扫到现成 Cluster 还有一条捷径**——如果是通过普通 Beacon/Probe Response 里携带的 **Cluster Discovery 属性**发现的，新设备甚至不用持续监听，只要按属性里的 Time Offset 算出 DW 时刻、到点醒来参与即可（§3.4.1）。

## 2.3 角色与状态

每个 NAN 设备在 Cluster 里担任一个角色（§3.3.2）：

| 角色/状态               | 说明                                                |
| ----------------------- | --------------------------------------------------- |
| **Master**              | 主动发同步 Beacon，承担"对表基准"职责               |
| **Non-Master Sync**     | 不是 Master，但仍在 DW 内发同步 Beacon 帮忙传播同步 |
| **Non-Master Non-Sync** | 既不是 Master 也不发同步 Beacon，最省电             |

设备启动或加入 Cluster 时先当 Master，之后根据周围情况（收到的 Beacon 数量、信号强度 RSSI、对方的 Master Rank）在 DW 边界动态切换角色。

## 2.4 Anchor Master — 全簇的"对表总基准"

一个 Cluster 里会浮现出一个 **Anchor Master（锚定主节点）**——它是整个 Cluster 时间同步的最终基准（§3.3.4）。谁当 Anchor Master，由 <strong>Master Rank（主节点等级）</strong>决定。

每个设备维护一条 **Anchor Master Record**，含三个关键值：

| 字段                                                | 含义                                |
| --------------------------------------------------- | ----------------------------------- |
| **AMR（Anchor Master Rank）**                       | Anchor Master 的等级                |
| **Hop Count to Anchor Master**                      | 本设备到 Anchor Master 之间隔了几跳 |
| **AMBTT（Anchor Master Beacon Transmission Time）** | Anchor Master 上次发 Beacon 的时刻  |

> 广场上谁的手表最"权威"？大家比"资历"（Master Rank）——资历最高的那块表（Anchor Master）成为全场对表的基准。其他人记下"离权威表隔了几个人"（Hop Count），一层层把准确时间传递下去。如果连续 16 个 DW（约 8 秒）没收到权威表的更新（AMBTT 过期），就认为它走了，自己顶上当新的基准。

## 2.5 Master Preference 与选举

设备通过 <strong>Master Preference（主节点偏好，0–255）</strong>和 **Random Factor（随机因子）** 组合出 **Master Rank**，越大越可能当 Master（§3.3.3）。Master Rank 不是抽象的"等级"，而是一个**可直接比大小的 64 位数**，按下式拼出来：
$$
\text{Master Rank} = \text{Master Preference} \times 2^{56} + \text{Random Factor} \times 2^{48} + \text{MAC[5]} \times 2^{40} + \cdots + \text{MAC[0]}
$$
也就是：**先比 Master Preference，相同再比 Random Factor，还相同就比 NMI（MAC 地址）**——逐级当"平局决胜"，保证任意两台设备的 Rank 绝不相等、总能选出唯一赢家。

规则要点：

- NAN 基础设施设备若要设 Master Preference > 0，须设为 **≥ 128**；其他普通设备设 **< 128**。
- Master Preference 值 **1 和 255 保留用于测试**，正常运行不用。
- 一旦设了新的 Master Preference（> 0），**240 个 DW 内不能再改**，也不能改回 0。
- **Random Factor** 需在 **120～240 个 DW 内更新一次**（取值 0–255），让"决胜随机数"不至于长期固定。

## 2.6 Cluster 合并 — 两群人并成一群

17.2.2节讲的是"一台设备加入哪个 Cluster"。但还有一种情况：两个 Cluster 各自独立形成后，**碰到了一起**——比如两群人本来分处广场两头各自对表，后来走近了互相听见。这时需要**合并（merging）**，否则同一片区域里存在两套不同步的时钟，发现就乱了。

触发与收敛规则（§3.4.2）：当一个设备**同时听到两个不同 Cluster ID 的 Beacon**，它就知道存在两个 Cluster，于是按 **CG（Cluster Grade，簇等级）** 裁决——所有设备逐渐**收敛到 CG 更高的那个**（CG 相同则比 AMR）。其中 **CG = 2⁶⁴ × Anchor Master 的 Master Preference + Cluster 的 TSF 值（TSF 取低 19 位置零）**（§3.4.1.1），所以"主节点偏好更高"或"存在更久"的 Cluster 胜出。

> 广场上同时有两群人各自对表（两个 Cluster）。当有人**同时听见两边的招呼**，发现"隔壁那群更靠谱"（CG 更高），就会带着大家慢慢并过去——最终所有人对到同一块表上。这和 17.2.2节的"一个新人选择加入哪群"是两回事：那是个体入伙，这是两个群体融合。

> **但合并不是唯一选择**：规范允许**一台设备同时参与多个 Cluster**（§2.2，optional）——比如它想"把射程内所有 Cluster 提供的服务都尽快发现一遍"，就可以脚踏多条船，分别在各 Cluster 的 DW 里醒来。这属于可选的实现行为，具体怎么调度由实现决定。所以"听到两个 Cluster"既可以触发合并、也可以选择都留着，看设备的策略。

---

# 3 关键标识 — NMI、NDI、Cluster ID

NAN 用两套不同的接口地址，分清这两个是理解后续数据通道的关键（§2.8）：

| 标识           | 全称                             | 用途                                         | 类比                         |
| -------------- | -------------------------------- | -------------------------------------------- | ---------------------------- |
| **NMI**        | NAN Management Interface address | **管理面**：发现、同步、SDF 服务发现帧都用它 | 你在广场上喊话用的"昵称"     |
| **NDI**        | NAN Data Interface address       | **数据面**：NDP 数据通道建立后传数据用它     | 交易时才交换的"真实联系方式" |
| **Cluster ID** | —                                | 标识整个 Cluster，放在帧的 A3 字段           | 这场聚会的"场地编号"         |

> 在广场上你用一个"昵称"（NMI）打招呼、广播兴趣；等真要交易了，才走到一边交换"真实联系方式"（NDI）单独联系。管理和数据用不同身份，既灵活又利于隐私。

---

# 4 服务发现 — Publish / Subscribe / Follow-up

同步解决了"何时何地碰头"，接下来是核心：**怎么发现服务**。NAN 服务发现协议定义了两种消息（§4），都封装在 **Service Descriptor Attribute（服务描述符属性）**里，通过 **SDF（Service Discovery Frame，服务发现帧）**发送。

![Publish / Subscribe 服务发现匹配](assets/%E7%AC%AC-17-%E7%AB%A0%EF%BC%9AWi-Fi-Aware%EF%BC%88NAN%EF%BC%89%E2%80%94-%E5%B9%BF%E5%9C%BA%E4%B8%8A%E7%9A%84%E5%85%B4%E8%B6%A3%E5%B9%BF%E6%92%AD/17-publish-subscribe.svg)

## 4.1 Publish — 举牌"我提供什么"

**Publish（发布）**让一个设备把自己的服务**变得可被发现**（§4.1.3）。它有两种模式：

| 模式                        | 行为                              | 比喻                         |
| --------------------------- | --------------------------------- | ---------------------------- |
| **Unsolicited（非请求式）** | 主动周期性广播"我提供 XX 服务"    | 不管有没有人问，定时举牌吆喝 |
| **Solicited（请求式）**     | 只在收到匹配的 Subscribe 时才回应 | 有人来问了，才举牌应答       |

Publish 消息里，**服务名经过哈希**放进 Hash Value 字段（用规范定义的哈希算法），附加信息放进 Service Specific Info。每个 Publish 实例有一个本地唯一的 **publish_id**。

## 4.2 Subscribe — 举牌"谁提供 XX"

**Subscribe（订阅）**让设备**主动搜索**特定服务（§4.1.4）。当一个设备发出 Subscribe，它请求同 Cluster 内满足条件的设备回以 Publish。

## 4.3 Matching Filter — 供需如何"对上"

Publish 和 Subscribe 怎么判定匹配？除了服务名哈希要一致，还可以用 **Matching Filter（匹配过滤器）** 做更细的筛选（§4.1.3.1）。它是一串 `<length, value>` 对：

- 某位置 length = 0：通配，不管值是什么都算匹配该位。
- 某位置 length > 0：该位的值必须精确相等才算匹配。

只有当过滤器里**每一个** `<length, value>` 对都匹配上，**触发条件（trigger condition）** 才满足，Publish 设备才会回应。

> 你举牌问"谁有充电宝？"还能附加条件："要支持 PD 快充、要 20000 mAh 以上"（Matching Filter）。只有完全符合条件的摊主才会应答你，避免了一堆不相关的吆喝。

## 4.4 Follow-up — 发现之后的"私聊"

发现彼此后，双方可以用 **Follow-up（后续消息）** 交换更详细的服务信息（§4.1，Receive 事件）。这是一种点对点的服务层消息，不再是广播——相当于"对上眼之后凑近了私聊几句细节"。

## 4.5 几个有用的服务配置标志

Publish/Subscribe 时可以带一些标志（§4.1.3）影响行为：

| 标志                        | 作用                                                        |
| --------------------------- | ----------------------------------------------------------- |
| **Discovery Range Limited** | 限制只发现"近距离"的设备（结合 RSSI 阈值）                  |
| **NAN Ranging flag**        | 服务发现是否要联动测距（用 NAN**自带**的测距能力，详见 §8） |
| **Data Path flag**          | 该服务是否需要后续建立 NDP 数据通道                         |
| **Awake DW Interval**       | 设备每隔多少个 DW（512 TU 的倍数）醒来收发该服务的帧        |

---

# 5 USD — 非同步服务发现

完整的 NAN 同步（Cluster + Master 选举）功能强大但也有开销。对于更轻量的场景，规范定义了 **USD（Unsynchronized Service Discovery，非同步服务发现）**——设备**不必加入同步 Cluster**，直接在发现信道上收发 SDF 即可（§4.5）。发布信道方面（§4.5.3），**defaultPublishChannel 默认是信道 6（2.437 GHz）**，publishChannelList 则含法规允许的 2.4 GHz 全部 20 MHz 信道（支持 5 GHz 时再纳入 5 GHz 信道）；发布方在 Single channel / Multiple channels 两态间交替停留。

USD 下的 SDF 地址用法（§2.8.3，Table 5）：

- **Multicast NAN SDF Subscribe**：A1 = NAN Network ID（`51-6F-9A-01-00-00`），A2 = 发送方 NMI。
- **Unicast NAN SDF Publish**：定向回应某个订阅者。

USD 的终止同样轻量：发布方调用 **CancelPublish**、订阅方调用 **CancelSubscribe** 方法即可结束本次非同步发现（§4.5.4）。

USD 同样支持并发：每个 Publish / Subscribe **实例独立运行**、各有唯一 ID（§4.1.3/§4.1.4），同一设备可同时维护多个实例——即可以多个身份参与多个 USD 会话（比如一边发布「打印」、一边订阅「充电宝」），能并发几个实例由实现决定。

> USD 就像"不参加正式聚会、只在路边随手发传单/看传单"。省去了对表的麻烦，适合更即兴、更省事的发现。

---

# 6 NAN 数据路径 — 发现之后直接建通道

发现服务只是第一步。要真正传数据（比如传文件、联机游戏），需要建立 **NAN Data Path（NDP，数据路径）**——而且**全程不经过 AP**（§6）。这是 NAN 区别于"先连 AP 再通信"的根本特征。

![NDP 数据通道建立流程](assets/%E7%AC%AC-17-%E7%AB%A0%EF%BC%9AWi-Fi-Aware%EF%BC%88NAN%EF%BC%89%E2%80%94-%E5%B9%BF%E5%9C%BA%E4%B8%8A%E7%9A%84%E5%85%B4%E8%B6%A3%E5%B9%BF%E6%92%AD/17-ndp-setup.svg)

## 6.1 三个层次：NDP / NDL / NDC

NAN 把数据通信分成三个层次：

| 概念    | 全称             | 含义                                                      | 类比                                 |
| ------- | ---------------- | --------------------------------------------------------- | ------------------------------------ |
| **NDP** | NAN Data Path    | 一条具体的数据路径（一对设备为某服务建立的数据通道）      | 一笔具体的交易                       |
| **NDL** | NAN Device Link  | 两个设备之间的链路（可承载多条 NDP），由双方 NMI 唯一标识 | 两人之间的"长期合作关系"             |
| **NDC** | NAN Data Cluster | 一组设备约定共同醒着收发数据的资源块时间表                | 几个常打交道的人约定的"固定碰头时段" |

一个 NDL 可以承载多条 NDP；NDL 一旦建立，由 **CRB（Common Resource Block，公共资源块）**——双方 Committed 可用窗口（FAW）在同一主信道上的重叠部分——构成实际的收发时机。

## 6.2 NDP 建立流程

NDP 建立由**订阅者（service subscriber）发起**，它担任 **NDP Initiator**，被发现的发布者担任 **NDP Responder**（§6.2）：

| 步骤 | 帧                         | 说明                                                         |
| ---- | -------------------------- | ------------------------------------------------------------ |
| 1    | **Data Path Request NAF**  | Initiator 发起，含 NDP 属性（Type=Request）、设备能力、HT/VHT/HE 能力元素 |
| 2    | （本地）DataIndication     | Responder 收到后通知上层应用                                 |
| 3    | **Data Path Response NAF** | Responder 回应（Accepted / Rejected）                        |
| 4    | （可选）Confirm / Security | 若需安全，走 四次握手建立 ND-TKSA                            |

如果两个设备之间还没有 NDL Schedule，NDP 建立会**同时建立 NDL Schedule**（§6.2.1）。需要安全时，NDP 建立升级为 **四次握手**，附带安全属性，协商出 ND-TKSA（NAN Data Pairwise Security Association）（§6.2.2）。

> 在广场上对上眼（服务发现）后，两人走到一边正式谈交易：先递个意向（Data Path Request），对方答应或拒绝（Response）。如果涉及钱货（需要加密），还要互验身份签个合同（四次握手建 ND-TKSA）。谈成后，他俩约定"以后固定在某个时段、某条街碰头交货"（NDL/NDC Schedule）。

## 6.3 默认 NDC 时间表

数据通信的时机也要约定。默认 NDC Schedule（§6.2.3.3，Table 14）：

| 对端类型           | 时间窗                                               | 信道      |
| ------------------ | ---------------------------------------------------- | --------- |
| 仅 2.4 GHz 设备    | 每个 committed 2.4 GHz DW**之后紧接的一个 NAN Slot** | 6         |
| 2.4/5 GHz 双频设备 | 每个 committed 5 GHz DW 之后紧接的一个 NAN Slot      | 149 或 44 |

## 6.4 NDPE — 让上层 App 直接用 socket 通信

到这里还差最后一块拼图：**NDP 建好了，App 到底怎么收发数据？** 如果只停在二层（MAC 帧），应用层用起来很别扭。**NDPE（NDP Extension，NDP 扩展属性）** 就是来打通这一层的（§6.2.7）：

- 双方在 Device Capability 属性里把 **NDPE 支持位**置 1，就在 Data Path 建立帧里携带 **NDPE 属性**；
- NDPE 里带一个 **IPv6 Link Local TLV**——一个 64-bit 的接口标识符，加上前缀 `fe80::/64` 拼成一个完整的 **IPv6 链路本地地址**（若对端没显式给，就按规则从它的 NDI 推导，见 Appendix J）；
- 有了双方的 IPv6 地址，**NDP 之上立刻就是一条标准 IP 链路**——App 可以直接用 **TCP/UDP socket** 通信，和写普通网络程序没区别，不必关心底层是 NAN 还是别的。

> **这一步的意义**：没有 NDPE，NDP 只是"二层有了一条通路"；有了 NDPE，**它就升级成了"App 能直接 connect 的 IP 网络"**。所以真实的 Wi-Fi Aware 应用（比如附近设备传文件、联机对战）基本都走 NDPE 这条路。

> 前面建好 NDP/NDL 相当于"两家之间修好了一条专用货运通道"，但货车司机还得知道对方的**门牌号**才能送货。NDPE 就是双方互报门牌（IPv6 地址），从此上层"快递员"（App 的 socket）按地址直接收发，根本不用懂这条路是怎么修的。

---

# 7 省电 — DW 机制如何省电

NAN 的省电设计贯穿始终（§3.1）：

1. **时间集中**：把"互相发现"压缩到每 512 TU 里的 16 TU（约 3% 的时间），其余时间设备可休眠。
2. **角色分层**：大多数设备可处于 Non-Master Non-Sync 状态，不必发同步 Beacon。
3. **信道限定**：发现只在信道 6（+ 可选一个 5 GHz 信道），不必全频段扫描。
4. **按需唤醒**：Awake DW Interval 让设备只在需要时每隔若干 DW 醒来处理特定服务。
5. **数据时机约定**：NDC Schedule 让数据收发也集中在约定的资源块，收发完即可休眠。

> 广场聚会"短而频"（16 ms / 524 ms），不需要的人聚会时也可以打盹（Non-Sync），交易双方另约固定时段（NDC）——整个机制就是为了"既能随时发现彼此，又不必一直耗电守着"。

---

# 8 NAN 安全与配对（Pairing）

前面 §6.6 的 NDP 建立里我们提过"需安全则 四次握手建 ND-TKSA"——那只是**数据通道**这一次会话的保护。但更上层还有个问题：**两台设备如何建立一段"长期信任关系"，下次再遇到免去重新认证？** 这就是 NAN Pairing（配对）要解决的（§7）。

## 8.1 NPK / NIK — 长期信任的根

配对成功后，两台设备之间会建立一对长期密钥（§7.6）：

| 密钥    | 全称             | 作用                                         |
| ------- | ---------------- | -------------------------------------------- |
| **NPK** | NAN Pairing Key  | 配对主密钥，是这段长期信任关系的根           |
| **NIK** | NAN Identity Key | 身份密钥，用于后续"认出对方就是上次那台设备" |

这两个密钥可以**缓存（NPK/NIK caching）**。一旦缓存，老朋友重逢就能**跳过完整配对、快速重建安全关系**——和第 14 章 P2P 的"持久组"是同一种"老搭子免重配"的思路。

> 第一次合作要签一份正式合同、互换公章（配对建 NPK/NIK）；以后再打交道，凭存档的合同副本直接续约，不用从头再签。

## 8.2 隐私：可解析的临时身份（NIRA）

NAN 设备在广场上反复广播，若一直用固定地址，就会被人长期追踪。NAN 用 **NIRA（NAN Identity Resolution Attribute，身份解析属性）** 解决隐私（§7.6.2、§9.5.21.6）：

- 设备对外用**经过随机化/加密的临时身份**，旁人无法据此长期追踪。
- 但**已配对的老朋友**，凭之前协商的 NIK 能"解析"出"这个临时身份背后就是我认识的那台设备"。

> 你对陌生人只报一个每次都变的"化名"（防跟踪），但老朋友手里有你给过的"暗号本"（NIK），一对暗号就知道"哦，又是你"。既保护隐私，又不耽误熟人相认。

> 此外，NAN 还可借 Follow-up 提供 **IGTK / BIGTK** 来保护组播管理帧与 Beacon 完整性（§4.1.7），这类保护**不需要先建 NDP 数据通道**。

---

# 9 NAN 自带测距 — 不必等到第 18 章

这里要纠正一个容易产生的误解：**Wi-Fi Aware 自己就内置了测距能力，并不需要"外接"第 18 章的 FTM。** 准确说，NAN Ranging 正是**复用了 FTM（Fine Timing Measurement）的帧交换**，但把它**整合进了 NAN 的发现与调度框架**里（§8）。

## 9.1 角色与流程

| 角色                  | 说明                |
| --------------------- | ------------------- |
| **Ranging Initiator** | 发起测距的 NAN 设备 |
| **Ranging Responder** | 响应测距的 NAN 设备 |

测距通过 **FTM 帧交换**完成（§8.3），并配有自己的 **ranging schedule（测距调度时间块）**——也就是说，"什么时候测、在哪个时间块测"被纳入了 NAN 的可用性调度，和服务发现/数据收发统一编排。会话建立（§8.3.4）靠 **Ranging Request / Ranging Response** 两帧：发起方在 **Ranging Setup attribute** 里提出 NAN FTM 参数、用 **Ranging Control 位**标定 **Map ID / Time Bitmap** 调度，响应方无法满足参数时以 **Status=Rejected** 拒绝。

会话也**不是「一测到底」**：发起方发 **Ranging Request** 帧即可发起会话更新，响应方则可用 **Schedule Update Notification NAF**（携带 Potential/Conditional/Committed FAW）请求调整，流程与会话建立（§8.3.4）一致（§8.3.5）。要结束时，任一方收到 **Cancel_Range** 原语便向对端发 **Ranging Termination** 帧终止会话，并释放该会话占用的 committed 资源块（§8.3.6）。若响应方在 **Ranging Response** 里把 **Ranging Report Required** 位置 1，发起方须在每个 FTM session（每个 single block）完成后回一个带 **FTM Range Report** 属性的 **Ranging Report** 帧（§8.3.7）；周期测距的重复间隔则由 **Ranging Response** 的 **Time Bitmap Control** 字段 **Period** 子字段指定（§8.3.8）。

## 9.2 和服务发现的联动

回到 §4.1.3 的 **NAN Ranging flag**：Publish/Subscribe 时带上它，就能要求"**发现服务的同时测距**"，从而实现**基于距离的服务匹配**——比如"只和 5 米内的设备交互""附近的人按远近排序"。

> 广场上你不只想知道"谁提供充电宝"，还想知道"谁离我最近"。NAN 自带的卷尺（Ranging）和广播喊话（发现）是同一套班子在管，喊话的同时顺手就把距离量了——不用再另请一个测距队（第 18 章的独立 FTM）。

## 9.3 它到底是不是"802.11mc"？——版本溯源

有人会问：**NAN 测距不就是 802.11mc 吗？** 这个说法对了一半，得把"机制来源"和"规范引用"分开看：

- **FTM 这个机制，确实是 802.11mc 引入的。** 802.11mc（即 IEEE 802.11-2016 修正案）首次定义了 FTM 协议——t1/t2/t3/t4 时间戳交换那一套（第 18 章的主角）。所以"NAN 测距 ≈ 802.11mc 的 FTM"在**历史来源**上成立。
- **但今天的 NAN 规范并不点名"802.11mc"。** 802.11mc 的内容早已**并入基准标准**，NAN v4.0 测距实际引用的是 **IEEE Std 802.11-2022 的 §11.24.6.2（FTM 协议与过程）**——也就是合并后的当前基准，而非那个独立的旧修正案名。
- **而且不止 802.11mc——v4.0 还纳入了 802.11az。** NAN v4.0 的引用列表里同时列了 **P802.11az D4.0**（下一代定位增强：更高精度、支持安全测距）。802.11az（现已并入 802.11-2024）在 FTM 之上引入 **LMR（Location Measurement Report，位置测量报告）**帧与 **IFTMR/IFTM** 协商——发起方发 IFTMR（初始精细定时测量请求）、响应方回 IFTM（初始精细定时测量）确认参数，测完后双方各回一份携带 TOA/AOA 反馈的 LMR。
- 不过要分清：**NAN 的 §8 目前实际只走基准 FTM**——协商靠 Ranging Request/Response 两帧（§8.3.4），测距用 ASAP=1 + Single Burst 的 FTM（§8.3.8）。所以严格说，NAN 测距的"底座"是 **802.11-2022 基准里的 FTM**，802.11az 是"已挂名的未来增强"，LMR 协商流程尚未在 §8 展开。

| 说法                    | 准不准                                                       |
| ----------------------- | ------------------------------------------------------------ |
| NAN 测距用 FTM          | ✅ 完全对                                                     |
| FTM 机制源自 802.11mc   | ✅ 对（历史来源）                                             |
| NAN 测距"就是 802.11mc" | ⚠️ 不够准：规范按 **802.11-2022 §11.24.6.2** 引用，且 v4.0 还在引用列表列名 **802.11az** |

> **与第 18 章的关系**：第 18 章讲的是 **FTM 测距的底层原理**（t1/t2/t3/t4、RTT 计算、802.11az 增强），那是"测距这件事本身怎么做"。本节讲的是 **NAN 如何把 FTM 用起来**——原理同源，但 NAN 给了它一套发现联动与调度。想深究测距原理，仍可参阅第 18 章。

---

# 10 带外触发 — 用 BLE / NFC 先"叫醒"NAN

前面默认 NAN 一直开着、按 DW 周期收发。但 NAN 收发本身也耗电，真实产品常想**平时让 NAN 射频睡着，需要时才唤醒**。规范为此定义了用**别的近场无线电先触发 NAN** 的机制——思路和第 12 章 DPP "用二维码带外引导配网"一脉相承：**用一条更省电/更便捷的旁路，把重活（NAN 发现 + 建链）引导起来。**

![BLE / NFC 带外触发 NAN](assets/%E7%AC%AC-17-%E7%AB%A0%EF%BC%9AWi-Fi-Aware%EF%BC%88NAN%EF%BC%89%E2%80%94-%E5%B9%BF%E5%9C%BA%E4%B8%8A%E7%9A%84%E5%85%B4%E8%B6%A3%E5%B9%BF%E6%92%AD/17-oob-trigger.svg)

## 10.1 BLE 触发（最常用）

**BLE（蓝牙低功耗）一直在低功耗广播，正好用来当"门铃"**（§11）。它借用蓝牙的 **TDS（Transport Discovery Service，传输发现服务）**：

- 触发数据封装在 BLE 广播包里，**AD Type = `0x26`（TDS）**、**Organization ID = `0x02`（Wi-Fi 联盟通用服务发现）**；
- 里面携带基本服务信息，**让对端据此点亮自己的 NAN 射频、开始 NAN 服务发现**；
- 规范定义了两个角色：**Browser（浏览者，主动找服务）** 与 **Seeker（搜索者，找特定服务）**；服务提供方收到后以 **Provider** 身份响应。Seeker 甚至能在广播里直接带上目标设备的 BLE 地址，**定向唤醒**那一台。

> **规范特意点明**：这套"BLE 触发"机制不限于 NAN——同样可用来触发 Wi-Fi Direct、WiGig、HaLow 等其他无线电（§11）。BLE 在这里就是个通用的"低功耗门铃"。

## 10.2 NFC 触发（碰一碰）

设备若带 NFC，也可用 **NFC Connection Handover** 协议触发 NAN 的服务发现与**安全 NDP 建立**（§12）：

- 两台设备**碰一碰**，通过 NFC 的 Negotiated Handover 完成一次**双向认证的 Diffie-Hellman 密钥交换**（NCS-PK-2WDH 套件），当场拿到对方的 DH 公钥和触发信息；
- 于是后续的 NDP 可以**直接带着已交换好的密钥材料安全建立**——省去在空口里重新协商的麻烦。

> **注意**：规范明确标注 NFC 这条"**尚未纳入 Wi-Fi Aware 认证测试**"，属于定义了但未必广泛验证的特性。

> **交通比喻**：NAN 平时在"睡觉省电"。BLE 就像门口一个**超省电的门铃**——有人按一下（BLE 广播触发），屋里人才起身开灯干活（点亮 NAN 射频去发现）；NFC 则像**贴脸递名片**，碰一下不仅叫醒对方，还顺手把"保险柜钥匙"（DH 公钥）也交换了，进门就能直接谈机密生意（安全 NDP）。

---

# 11 完整流程串讲

把全章串起来，两台手机用 Wi-Fi Aware 发现并传数据，从同步到建链的**逐帧**过程如下图——这也是抓包会看到的帧序列：

![Wi-Fi Aware 完整帧交互](assets/%E7%AC%AC-17-%E7%AB%A0%EF%BC%9AWi-Fi-Aware%EF%BC%88NAN%EF%BC%89%E2%80%94-%E5%B9%BF%E5%9C%BA%E4%B8%8A%E7%9A%84%E5%85%B4%E8%B6%A3%E5%B9%BF%E6%92%AD/17-nan-frames.svg)

> **读图要点（和前几章对照）**：NAN **没有"关联 + 四次握手"那一套**——① 同步靠 **Beacon** 自组织对表（无 AP），② 发现靠 **SDF**（服务发现帧），③ 建链靠 **NAF**（NAN Action 帧），安全直接在 NDP 握手里就地完成。**管理面用 NMI、数据面用 NDI** 两套身份分离；所有帧 ToDS=FromDS=0、**A3 始终填 Cluster ID**。非安全 NDP 只需 Request→Response，安全 NDP 是四帧握手（多 Confirm + Security Install 下发 GTK）。

用文字再串一遍：

```
0. (可选)触发  BLE 广播(TDS)或 NFC 碰一碰先"叫醒"对方的 NAN 射频
                │
1. 同步     设备激活 NAN → 被动扫描 → 加入 CG 最高的 Cluster
          （或自己建 Cluster）。靠 DW 内的同步 Beacon 对表，
          浮现出 Anchor Master 作为全簇时间基准
                │
2. 服务发现  在 DW(信道6, 每512TU的16TU窗口)内：
          手机A 用 NMI Publish "我有文件要分享"
          手机B 用 NMI Subscribe "谁能分享文件"
          经 Matching Filter 匹配 → 对上眼
                │
3. 私聊     可选 Follow-up 交换更多服务细节
                │
4. 建数据通道 订阅方(B)作 NDP Initiator 发 Data Path Request
          → A 作 Responder 回 Response(Accepted)
          → 需安全则 四次握手建 ND-TKSA
          → 同时建立 NDL Schedule，用 NDI 通信
          → 带 NDPE 属性互换 IPv6 地址，升级成 IP 链路
                │
5. 传数据    App 直接用 TCP/UDP socket 在 NDC 约定的资源块/信道上
          传输，全程不经 AP
                │
6. 省电     发现和数据收发都集中在约定窗口，其余时间休眠
```

---

# 12 本章总结

| 机制                    | 作用                                                    | 广场比喻                           |
| ----------------------- | ------------------------------------------------------- | ---------------------------------- |
| **Discovery Window**    | 约定的共同聚会时刻（512 TU 周期 / 16 TU 时长 / 信道 6） | 每隔一会儿聚到广场中央 16 ms       |
| **NAN Cluster**         | 同步到一起的设备群                                      | 对同一块表的一群人                 |
| **Anchor Master**       | 全簇时间基准（按 Master Rank 选）                       | 资历最高的那块"权威表"             |
| **同步/发现 Beacon**    | 簇内对表 / 簇外被发现                                   | 内部对表 / 对外吆喝"这有聚会"      |
| **NMI / NDI**           | 管理面身份 / 数据面身份                                 | 广场昵称 / 交易时的真实联系方式    |
| **Publish / Subscribe** | 发布服务 / 搜索服务                                     | 举牌"我提供" / 举牌"谁提供"        |
| **Matching Filter**     | 精细供需匹配                                            | 附加筛选条件                       |
| **USD**                 | 非同步轻量发现                                          | 路边发传单/看传单，不参加正式聚会  |
| **NDP / NDL / NDC**     | 数据路径 / 设备链路 / 数据簇时间表                      | 一笔交易 / 长期合作 / 固定碰头时段 |
| **NDPE（IPv6 socket）** | NDP 之上升级成 IP 链路，App 直接 TCP/UDP 通信           | 互报门牌，快递员按地址收发         |
| **DW 省电**             | 发现与数据都集中在窗口                                  | 聚会短而频，其余时间打盹           |
| **Pairing（NPK/NIK）**  | 建立长期信任、可缓存免重配                              | 签合同换公章，老搭子续约           |
| **NIRA 身份解析**       | 临时身份防追踪、老朋友可相认                            | 对生人报化名，对熟人对暗号         |
| **NAN Ranging**         | 自带 FTM 测距，联动服务发现                             | 喊话同时顺手量距离                 |
| **BLE / NFC 带外触发**  | 先用旁路唤醒 NAN，省电/便捷                             | 省电门铃 / 贴脸递名片              |

Wi-Fi Aware 的精髓是：**让一群没有 AP 的设备自发同步出"集合时间窗"，在窗口里用 Publish/Subscribe 发现彼此的服务，再按需建立不经 AP 的直接数据通道——既能持续"感知邻居"，又把功耗压到最低。** 它特别适合"附近的人/设备/服务"这类近场社交与协作场景。

---

> 下一章将讲述：Wi-Fi 不只能传数据，还能当"尺子"用。设备之间怎么靠"喊一声、掐个表"算出彼此的距离？FTM 的 t1/t2/t3/t4 时间戳如何换算成米？为什么三个 AP 就能给你室内定位？802.11az 又带来了什么增强？
