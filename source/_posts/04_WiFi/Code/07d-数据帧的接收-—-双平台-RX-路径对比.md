---
title: 数据帧的接收 — 双平台 RX 路径对比
top: 1
related_posts: true
abbrlink: 83a9d405
date: 2026-09-19 21:09:14
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> "入港的包裹不比出港——你不知道它什么时候到、走哪条路、属于哪个客户。出港分拣靠流程，入港分拣靠应变。"

---

# 本章导读

数据帧发送路径中我们追踪了从 `ndo_start_xmit` 到固件的完整出港分拣线。TX 路径的核心矛盾是"如何在软中断的约束下高效搬运"，驱动和协议栈的角色是"主动推送"——协议栈决定什么时候发、发什么，驱动只需按流程搬。

但 RX 是另一个世界。**你不知道帧什么时候到、是什么类型、属于哪个流、是否需要重排。** 驱动在 RX 路径上是被动的——硬件通过中断告诉你"有包了"，你必须在极短的时间窗口内把数据从 DMA ring 里捞出来、组装成 skb、分类、解密、转换格式、最终上送协议栈。任何一环卡顿，都会导致 DMA ring 溢出、丢包、吞吐量骤降。

<!--more-->

QCOM 和 MTK 在 RX 路径上走出了两条截然不同的路：

- **QCOM 像顺丰的枢纽分拨中心**——卸货（NAPI softirq）和分拣派送（kthread）物理分离。NAPI 传送带只负责从 DMA ring 搬出包裹并分拣入队，GRO merge、协议栈上送和 GRO flush 都在独立的 kthread 车间里完成。传送带永远不会因为一个难处理的包裹而停下来。
- **MTK 像菜鸟的标准流水线**——卸货、合并、派送全在传送带旁边的 NAPI softirq 中一条线做完。结构简单、代码路径短，但传送带停了你什么都做不了。

两个方案的取舍本质是"复杂度换吞吐量弹性"vs"简洁性换可靠性"——你的收件量（RX 吞吐量需求）决定了你该开枢纽还是驿站。

**本章你将学到：**

- RX 终点：`napi_gro_receive` 为什么是驱动回协议栈的唯一出口
- QCOM RX 路径：GRO 分段解耦——NAPI 只搬运入队，kthread 做 merge + flush + 上送
- MTK RX 路径：标准 NAPI 模型，GRO 在 softirq 中完成
- 双平台 RX 线程调度对比
- AMPDU 接收端重排：QCOM 硬件 REO vs MTK 软件滑动窗口
- 多播/广播帧的特殊处理
- Power Save 与数据帧缓冲
- RX 异常路径：描述符耗尽、分片丢失、Reorder 超时

如果只想知道 QCOM 和 MTK 在 RX 设计哲学上的差异，可以跳过中间的源码细节，直接看第 8 节的双平台对比表格。如果想理解 RX 路径的每一跳在做什么，请跟着调用链一步步往下走。

---

# 1 RX 终点：`napi_gro_receive` —— 驱动回协议栈的唯一出口

在深入代码之前，先定一个锚点。

**RX 终点：`napi_gro_receive`（或 `netif_receive_skb`）**。这是数据包从驱动进入协议栈的必经之路。驱动将组装好的 skb 通过 `napi_gro_receive()` 交给内核网络栈——GRO 可能在这里合并多个同流 skb（TCP 大流的分段重组），IP 层从这里接手。

为什么说是"唯一出口"？TX 路径只有一个入口（`ndo_start_xmit`），RX 路径同样只有一个出口——不管是 QCOM 还是 MTK，不管中间经过多少层软件处理，最终都必须通过 `napi_gro_receive()` 或 `netif_receive_skb()` 把 skb 上送协议栈。没有旁路，没有"驱动直接把数据交给 App"的捷径。**理解这个唯一定点，是你追踪 RX 路径所有代码的第一前提。**

不过，QCOM 在这个出口上做了一个关键改造——它没有在 NAPI softirq 中直接调用 `napi_gro_receive()`，而是把 GRO 拆成了两段：merge、flush 和协议栈上送都搬到独立的 kthread 中完成，软中断只做搬运和入队。这是下一节的核心内容。

TX 和 RX 之间，整条链路**不经过 supplicant**。supplicant 是控制面的角色，数据面是纯粹的内核空间搬运——数据包从协议栈来，回协议栈去。

下图是 QCOM 和 MTK 的 RX 全景对比——你可以先看一眼，知道后面的代码在调用链的哪个位置：

![QCOM vs MTK RX 线程模型对比](assets/07d-%E6%95%B0%E6%8D%AE%E5%B8%A7%E7%9A%84%E6%8E%A5%E6%94%B6-%E2%80%94-%E5%8F%8C%E5%B9%B3%E5%8F%B0-RX-%E8%B7%AF%E5%BE%84%E5%AF%B9%E6%AF%94/07d-rx-compare.svg)

---

# 2 QCOM 为什么把 GRO 分成两段？——顺丰的分拣中心分段解耦

这是本章的核心亮点。QCOM 的 RX 路径对标准 Linux NAPI 模型做了一个关键的改造：**将 GRO 拆分成两段——merge（合并）、flush（清空）和协议栈上送全部搬到独立的 kthread 中完成，软中断只做搬运和入队**。

## 2.1 为什么要解耦？

标准 Linux NAPI 模型是这样工作的：

1. 硬件收到数据 → MSI 中断 → 驱动关中断、调 `napi_schedule()`
2. `NET_RX_SOFTIRQ` 软中断触发 → `napi_poll()` 回调 → 驱动从 DMA ring 取 skb
3. 驱动调用 `napi_gro_receive()` → GRO 合并（标准 Linux 在同一步完成 merge + 上送） → 上送协议栈
4. 预算用完或 ring 空 → `napi_complete()` → 开中断

这四步之间还压着一层内核软中断基础设施，它的时序解释了"软中断不能长占 CPU"这条硬约束从何而来。`napi_schedule()` 在 hard IRQ 上下文中逐级下沉：`__napi_schedule()`（`net/core/dev.c:6091`）先 `local_irq_save` 关本地中断，再进 `____napi_schedule()`（同文件 4512 行）把 `napi_struct` 挂进当前 CPU `softnet_data` 的 `poll_list` 链表尾部，随后 `raise_softirq_irqoff(NET_RX_SOFTIRQ)`（4546 行）置起软中断 pending 位后立即返回——它**不在这里处理任何包**。真正的搬运要等 hard IRQ 退栈、内核在中断出口检查 pending 软中断时才发生：`NET_RX_SOFTIRQ` 的注册处理函数 `net_rx_action()`（`net/core/dev.c:6782`）从 `poll_list` 逐个取出 napi 实例，以 `budget`（默认 `netdev_budget=300`，同文件 4502 行）为上限调 `napi->poll(napi, budget)`，每处理一包 `budget--`。若预算耗尽但 ring 仍非空，`poll` 返回 `budget` 值，`net_rx_action` 不调 `napi_complete`，而是把该 napi 重新排回 `poll_list` 尾部并再次 `__raise_softirq_irqoff`，让下一轮软中断接着搬——用"多轮短跑"换"一轮长跑"，避免单个 napi 把软中断时间片吃穿。这是第 4 步 `napi_complete()` 之外的另一条预算回收路径。

问题在第 3 步：**GRO 合并是一个可能耗时的操作**（TCP 大流的分段重组涉及 hash 查找、链表操作、checksum 验证）。而软中断的硬约束是：不能睡眠、不能长占 CPU（会影响同 CPU 上的其他软中断和进程调度）。

QCOM 的选择是：**把第 3 步拆成两段**。GRO merge（将同流分段合并到 per-flow 队列）通过 `receive_offload_cb` 回调完成，运行在 kthread 上下文；GRO flush（`napi_gro_flush`——清空合并队列并上送协议栈）也在 kthread 中完成（NAPI 软中断这一侧不直接 flush——`dp_rx_process_be()` 在 REO ring 服务收尾时经 `dp_rx_vdev_flush()` → `osif_gro_flush` 回调置位 `gro_flush_ind`，把 flush 请求递给 kthread，见 §2.2 第六站）。协议栈上送的主体路径同样通过 kthread 完成——软中断只做轻量级的"从硬件 ring 搬 skb 到软件队列"这一步（即第 1-2 步和第 4 步），然后将 nbuf_list 通过 `nbuf_queue` 交接给 kthread。

## 2.2 完整路径（逐站展开）

六站速览——每站在哪个文件中、做什么、跑在什么上下文：

| 站   | 函数                       | 文件                  | 上下文          | 做什么                                       |
| ---- | -------------------------- | --------------------- | --------------- | -------------------------------------------- |
| ①    | `ce_per_engine_service()`  | HIF/CE                | NAPI softirq    | DMA 描述符消费（src ring → dest ring）       |
| ②    | `dp_service_srngs()`       | `dp_rings_main.c`     | NAPI softirq    | 遍历 REO ring，分派到处理函数                |
| ③    | `dp_rx_process_be()`       | `dp_be_rx.c`          | NAPI softirq    | MSDU 组装、分片重装、解密、802.11→802.3 转换 |
| ④    | `dp_rx_deliver_to_stack()` | `dp_rx.c`             | NAPI 或 kthread | 回调验证 + 上送（或分流到 kthread）          |
| ⑤    | `dp_rx_thread_sub_loop()`  | `wlan_dp_rx_thread.c` | kthread         | 消费 `nbuf_queue`、上送协议栈                |
| ⑥    | `dp_rx_thread_gro_flush()` | `wlan_dp_rx_thread.c` | kthread         | GRO 合并队列超时清空                         |

调用链全景（注意：CE 消费与 REO 服务分属两条独立中断/NAPI 线，靠硬件 REO 中断桥接，不是一条连续函数调用链）：

```
Hardware MSI → irq handler: hif_napi_schedule() → napi_schedule()
  ↓ NET_RX_SOFTIRQ（HIF NAPI：CE 描述符消费）
hif_napi_poll()                           [hif/src/hif_napi.c, 运行时回调]
  → ce_per_engine_service()               CE 描述符消费（源 ring → 目的 ring）
  → hif_napi_offld_flush_cb()            上层 flush 回调
  → napi_complete()                      软中断收工

（另一条中断线：REO 硬件把 MSDU 推入 REO ring 后触发 REO 中断）
  ↓ NET_RX_SOFTIRQ（dp_intr NAPI：REO ring 服务）
dp_service_srngs_wrapper()                [dp/wifi3.0/dp_main.c, NAPI 回调]
  → dp_service_srngs()                    [dp/wifi3.0/dp_rings_main.c]
    遍历所有 REO ring
    → dp_rx_process_be()                  [dp/wifi3.0/be/dp_be_rx.c]
      MSDU 组装、分片重装、解密、802.11→802.3 转换
      → dp_rx_deliver_to_stack()          [dp/wifi3.0/dp_rx.c]
        验证回调 + 上送协议栈（或入队 kthread，走不同回调路径）
  → napi_complete()

  ↓ kthread 上下文（独立的 dp_rx_thread）
dp_rx_thread_loop()                       [components/dp/core/src/wlan_dp_rx_thread.c]
  → qdf_wait_queue_interruptible()       阻塞等待 event flag
  → dp_rx_thread_sub_loop()              处理 nbufq + GRO flush
    → dp_rx_thread_process_nbufq()
      → stack_fn(osif_vdev, nbuf_list)    回调上送（内部经 receive_offload_cb 做 merge）
    → dp_rx_thread_gro_flush()            GRO 合并队列清空（BH 保护）
```

下面逐站展开每一步的细节。

### 第一站：`ce_per_engine_service()` —— CE 描述符消费

CE（Copy Engine）是 QCOM 用于 Host↔Firmware 数据传输的硬件 DMA 引擎。每个 CE 维护两个 ring buffer：**源 ring**（src ring，固件写入、host 读取）和**目的 ring**（dest ring，host 写入、固件读取）。

`ce_per_engine_service()` 的职责是消费源 ring 中的描述符：

1. **从源 ring 取 CE 描述符**：每个描述符包含数据 buffer 的物理地址、长度、元数据（如 REO ring 编号、MSDU 计数等）
2. **解析元数据**：提取 REO push reason（硬件为什么把这个 MSDU 推给 host）、MSDU 连续性标志、是否需要分片重装
3. **搬运数据到目的 ring**：如果数据 buffer 需要释放回空闲池，将释放的描述符写入目的 ring（固件从另一端消费）

这是一个纯粹的 DMA 搬运操作——不涉及任何协议解析或数据修改。`budget` 参数控制每次 NAPI poll 最多消费多少个描述符，防止软中断长时间占用 CPU。

### 第二站：`dp_service_srngs()` —— 遍历所有 REO ring

`dp_service_srngs()`（`dp/wifi3.0/dp_rings_main.c` 590 行）是 REO（Reorder Engine）ring 的服务函数。REO 硬件将接收到的 MSDU 推入不同的 REO ring，每个 ring 对应一种 RX 处理策略（如非分片的普通 MSDU、需要分片重装的 MSDU、BAR 帧等）。

`dp_service_srngs()` 遍历所有已注册的 REO ring（通过 `reo_status_ring_mask` 掩码判断哪些 ring 有数据待处理，该掩码由 `wlan_cfg_get_reo_status_ring_mask()` 在驱动初始化时配置），对于有数据待处理的 ring，调用对应的处理函数——最常见的是 `dp_rx_process_be()`。

### 第三站：`dp_rx_process_be()` —— 从 REO 到协议栈的转换

`dp_rx_process_be()`（`dp/wifi3.0/be/dp_be_rx.c` 387 行）是 BE（Beryllium）平台的 RX 处理核心，负责将 REO 硬件输出的 MSDU 转换为协议栈可消费的 skb：

**MSDU 组装**：从 REO 描述符提取以下关键信息：

- `msdu_buffer_addr`：MSDU 数据的物理地址（DMA 缓冲区）
- `msdu_length`：MSDU 的总长度
- `reo_push_reason`：为什么被推送到 host（如接收完成、分片不完整等）
- `rx_tid`：接收 TID，用于 per-TID 统计和 BA 会话管理

**分片重装**：通过 `dp_rx_defrag` 处理硬件 REO 未完全重装的分片：

- REO 硬件能处理大部分 AMPDU 子帧的重排，但在某些边界情况下（如 REO 队列描述符不足、跨 TID 分片），剩余的分片重装工作由 `dp_rx_defrag` 在 host 侧完成
- 分片等待超时（`defrag_timeout_ms`）后，未完成重装的分片被丢弃

**解密**：根据帧头中的安全信息选择解密算法。CCMP/GCMP 解密通常在硬件中完成（QCOM 的 crypto engine 在 REO 之前工作），但如果硬件解密被禁用或失败（如软件加密模式），TKIP/WEP 的解密在 host 侧完成。解密后的 MSDU 是明文的 802.11 payload。

**802.11→802.3 转换**：去除 802.11 MAC 头（包括 Frame Control、Duration/ID、Address 1-4、Sequence Control），提取源 MAC 和目标 MAC，构建以太网头（14 字节：6 字节目标 MAC + 6 字节源 MAC + 2 字节 EtherType）。802.11 QoS Control 字段中的 TID 信息保留在 skb 的 CB 中（用于后续的 DSCP 映射）。

### 第四站：`dp_rx_deliver_to_stack()` —— 验证回调 + 上送协议栈

`dp_rx_deliver_to_stack()`（`dp/wifi3.0/dp_rx.c` 2546 行）负责将 nbuf_list 上送协议栈。它的实现非常简洁——**不包含任何入队/唤醒逻辑**：

```c
// dp/wifi3.0/dp_rx.c — dp_rx_deliver_to_stack, 上送协议栈
QDF_STATUS dp_rx_deliver_to_stack(struct dp_soc *soc,
                                  struct dp_vdev *vdev,
                                  struct dp_txrx_peer *txrx_peer,
                                  qdf_nbuf_t nbuf_head,
                                  qdf_nbuf_t nbuf_tail)
{
    // 步骤1：验证回调函数是否已注册
    if (dp_rx_validate_rx_callbacks(soc, vdev, txrx_peer, nbuf_head) !=
                                    QDF_STATUS_SUCCESS)
        return QDF_STATUS_E_FAILURE;

    // 步骤2：raw/native_wifi 模式 → 特殊 decap 回调
    if (qdf_unlikely(vdev->rx_decap_type == htt_cmn_pkt_type_raw) ||
        (vdev->rx_decap_type == htt_cmn_pkt_type_native_wifi)) {
        dp_rx_raw_pkt_mld_addr_conv(soc, vdev, txrx_peer, nbuf_head);
        vdev->osif_rsim_rx_decap(vdev->osif_vdev, &nbuf_head, &nbuf_tail);
    }

    // 步骤3：通过 vdev->osif_rx 回调上送协议栈
    dp_rx_check_delivery_to_stack(soc, vdev, txrx_peer, nbuf_head);

    return QDF_STATUS_SUCCESS;
}
```

关键设计点：

- **`dp_rx_validate_rx_callbacks()`** 验证 `vdev->osif_rx` 等回调是否已注册——如果上层（OSIF 层）尚未完成初始化，直接拒绝
- **`dp_rx_check_delivery_to_stack()`** 调用 `vdev->osif_rx(vdev->osif_vdev, nbuf_head)`，该 OSIF 层回调内部封装了 `netif_receive_skb()` 调用，将 nbuf_list 上送协议栈
- 当 FISA（Flow Inspection and Steering Acceleration）启用时，优先走 `vdev->osif_fisa_rx()` 加速路径

**关于 `receive_offload_cb` 的注册路径**：`receive_offload_cb` 是 `dp_ctx` 结构体的函数指针字段（`wlan_dp_priv.h:580`），在 DP 层初始化时赋值为 `dp_gro_rx_thread` 或 `dp_gro_rx_legacy`（取决于 rx_mode 配置）。

这条指针在 rx_thread 模式下由 `wlan_dp_rx_deliver_to_stack()`（`wlan_dp_txrx.c:1453`）在 kthread 上下文中直接调用——`dp_gro_rx_thread` → `dp_gro_rx_bh_disable` → `dp_rx_napi_gro_receive`（`os_if_dp_txrx.c:302`）→ `napi_gro_receive`，执行 per-flow 的 skb 合并。注意它不直接出现在 `dp_rx_deliver_to_stack`（`dp_rx.c`）的调用链中，而是在 `wlan_dp_rx_deliver_to_stack`（`wlan_dp_txrx.c`）里。

**那入队到 kthread 是在哪里做的？** 答案是 `dp_rx_tm_thread_enqueue()`（`components/dp/core/src/wlan_dp_rx_thread.c` 281 行）。

但它不直接在 `dp_rx_deliver_to_stack` 中入队，而是由 `txrx_ops.rx.rx` 回调（`dp_rx_pkt_thread_enqueue_cbk`）在另一条路径上触发。入队核心逻辑如下：

```c
// components/dp/core/src/wlan_dp_rx_thread.c — dp_rx_tm_thread_enqueue, 入队核心（精简）
static QDF_STATUS dp_rx_tm_thread_enqueue(struct dp_rx_thread *rx_thread,
                                           qdf_nbuf_t nbuf_list)
{
    qdf_nbuf_t head_ptr, next_ptr_list;
    uint32_t num_elements_in_nbuf;
    qdf_wait_queue_head_t *wait_q_ptr = &rx_thread->wait_q;

    // 如果 allow_dropping 标志已被其他路径设置（高负载信号），直接丢弃
    if (unlikely(qdf_atomic_read(...allow_dropping))) {
        qdf_nbuf_list_free(nbuf_list);
        goto enq_done;
    }

    dp_rx_tm_walk_skb_list(nbuf_list);        // 遍历链表，打印调试信息（DP_RX_TM_DEBUG 编译时）

    head_ptr = nbuf_list;
    // 处理扩展链表（ext list）——逐段拆开并入队
    while (head_ptr && qdf_nbuf_get_ext_list(head_ptr)) {
        // ...设置单个 nbuf 的元数据...
        qdf_nbuf_queue_head_enqueue_tail(&rx_thread->nbuf_queue, head_ptr);
        head_ptr = next_ptr_list;
    }

    // 将主链表入队（尾部）
    qdf_nbuf_queue_head_enqueue_tail(&rx_thread->nbuf_queue, head_ptr);

enq_done:
    dp_check_and_update_pending(tm_handle_cmn);   // 更新 pending 水位统计
    qdf_set_bit(RX_POST_EVENT, &rx_thread->event_flag);  // 设置事件标志
    qdf_wake_up_interruptible(wait_q_ptr);              // 唤醒 kthread
    return QDF_STATUS_SUCCESS;
}
```

关键设计点（入队侧）：

- **`qdf_nbuf_queue_head_enqueue_tail()`**：将 nbuf_list 追加到 `rx_thread->nbuf_queue` 的尾部——注意字段名是 `nbuf_queue`（不是 `nbufq`）
- **ext list 拆分**：当 nbuf_list 携带扩展链表时，逐段拆开后分别入队，避免大链阻塞队列
- **`qdf_set_bit(RX_POST_EVENT, &rx_thread->event_flag)`**：设置事件位——这是消费者（`dp_rx_thread_loop`）的唤醒信号
- **`qdf_wake_up_interruptible(wait_q_ptr)`**：唤醒阻塞在 `wait_q` 上的 kthread

**两条路径总结**：

1. **直接上送路径**：`dp_rx_deliver_to_stack()` → `dp_rx_check_delivery_to_stack()` → `vdev->osif_rx()` → `netif_receive_skb()`（在 NAPI 上下文中完成）
2. **kthread 入队路径**：`dp_rx_pkt_thread_enqueue_cbk()` → `dp_rx_tm_thread_enqueue()` → 入队 `nbuf_queue` + 唤醒 kthread

具体走哪条路径取决于 `rx_mode` 配置——当启用 rx_thread kthread 解耦时，走路径 2；标准 NAPI 模式走路径 1。

### 第五站：`dp_rx_thread_sub_loop()` —— kthread 中的事件处理循环

`dp_rx_thread_sub_loop()`（`components/dp/core/src/wlan_dp_rx_thread.c` 588 行）是 kthread 中实际"干活"的地方——但它比简化版复杂得多。下面展示核心流程（精简版）：

```c
// components/dp/core/src/wlan_dp_rx_thread.c — dp_rx_thread_sub_loop, kthread 处理循环
static int dp_rx_thread_sub_loop(struct dp_rx_thread *rx_thread, bool *shutdown)
{
    enum dp_rx_gro_flush_code gro_flush_code;

    while (true) {
        // 事件1：shutdown（线程退出） + suspend（挂起等待）
        if (qdf_atomic_test_and_clear_bit(RX_SHUTDOWN_EVENT,
                                          &rx_thread->event_flag)) {
            if (qdf_atomic_test_and_clear_bit(RX_SUSPEND_EVENT,
                                              &rx_thread->event_flag)) {
                qdf_event_set(&rx_thread->suspend_event);
            }
            *shutdown = true;
            break;
        }

        // 核心：处理 nbuf 队列 → 通过 stack_fn 回调上送协议栈
        dp_rx_thread_process_nbufq(rx_thread);

        // GRO flush（超时或阈值触发）
        gro_flush_code = dp_rx_should_flush(rx_thread);
        if (gro_flush_code != DP_RX_GRO_NOT_FLUSH) {
            dp_rx_thread_gro_flush(rx_thread, gro_flush_code);
            qdf_atomic_set(&rx_thread->gro_flush_ind, 0);
        }

        // 事件2：vdev delete（虚拟接口删除）
        if (qdf_atomic_test_and_clear_bit(RX_VDEV_DEL_EVENT,
                                          &rx_thread->event_flag)) {
            rx_thread->stats.gro_flushes_by_vdev_del++;
            qdf_event_set(&rx_thread->vdev_del_event);
            if (qdf_nbuf_queue_head_qlen(&rx_thread->nbuf_queue))
                continue;                    // 队列非空，继续消费
        }

        // 事件3：suspend（挂起等待 resume）
        if (qdf_atomic_test_and_clear_bit(RX_SUSPEND_EVENT,
                                          &rx_thread->event_flag)) {
            // ...省略：suspend 事件处理、等待 resume 信号...
        }

        // 队列为空 → 退出子循环，回到主循环等待事件
        if (qdf_nbuf_queue_head_qlen(&rx_thread->nbuf_queue) == 0)
            break;
    }
    return 0;
}
```

**`dp_rx_thread_process_nbufq()` 的内部循环**——这是上送协议栈的核心：

```c
// components/dp/core/src/wlan_dp_rx_thread.c — dp_rx_thread_process_nbufq, 处理 nbuf 队列
static int dp_rx_thread_process_nbufq(struct dp_rx_thread *rx_thread)
{
    qdf_nbuf_t nbuf_list;
    uint8_t vdev_id;
    ol_txrx_rx_fp stack_fn;
    ol_osif_vdev_handle osif_vdev;
    ol_txrx_soc_handle soc;
    uint32_t iterates = 0;

    soc = dp_txrx_get_soc_from_ext_handle(txrx_handle_cmn);
    // ...省略：soc 有效性校验...

    nbuf_list = dp_rx_tm_thread_dequeue(rx_thread);  // 从 nbuf_queue 取一个链表
    while (nbuf_list) {
        // 提取 vdev_id → 查找对应的 stack_fn 回调
        vdev_id = QDF_NBUF_CB_RX_VDEV_ID(nbuf_list);
        cdp_get_os_rx_handles_from_vdev(soc, vdev_id, &stack_fn, &osif_vdev);

        // 通过回调上送协议栈（不是 napi_gro_receive！）
        if (!stack_fn || !osif_vdev ||
            QDF_STATUS_SUCCESS != stack_fn(osif_vdev, nbuf_list)) {
            // 回调无效 → 丢包
            qdf_nbuf_list_free(nbuf_list);
        }

        // yield 检查：防止长循环占 CPU
        if (qdf_unlikely(dp_rx_thread_should_yield(rx_thread, iterates))) {
            rx_thread->stats.rx_nbufq_loop_yield++;
            break;
        }
        nbuf_list = dp_rx_tm_thread_dequeue(rx_thread);  // 取下一批
    }
    return 0;
}
```

这里最值得注意的一点是：`dp_rx_thread_process_nbufq()` 从头到尾没有直接调用 `napi_gro_receive()`。它通过 `stack_fn(osif_vdev, nbuf_list)` 回调上送——`stack_fn` 实际上是 `dp_rx_packet_cbk()`，最终调用 `wlan_dp_rx_deliver_to_stack()`；后者内部先通过 `receive_offload_cb`（`dp_gro_rx_thread` → `napi_gro_receive`）尝试 GRO merge，只有非 TCP 或 GRO 不可用时才 fall through 到 `netif_receive_skb()`。也就是说，merge 不是发生在 NAPI 软中断里，而是在这条 kthread 路径内部完成——这是 QCOM 与标准 NAPI 模型的根本分界。剩下五个设计点：

- **不使用 `local_bh_disable()`**：在 kthread 上下文中，此函数通过 `stack_fn` 回调直接上送，回调内部自行管理所需的保护
- **`dp_rx_tm_thread_dequeue()` 返回的是 nbuf_list（链表）**：不是单个 skb——一次 dequeue 可能返回多个链接在一起的 nbuf。出队函数内部调用 `dp_rx_thread_adjust_nbuf_list()` 调整链表结构
- **`dp_rx_thread_should_yield()`**：当处理了足够多的包（由 `iterates` 计数）后主动 yield，防止 kthread 长时间占 CPU 影响其他任务
- **kthread 的调度优先级是驱动设的**：`dp_rx_thread_loop()`（`wlan_dp_rx_thread.c:662`）在进入主循环前调 `qdf_set_user_nice(qdf_get_current_task(), -1)` 把 nice 值设成 -1——CFS 普通调度里略高于默认值 0，而非 SCHED_FIFO 实时调度——再调 `qdf_set_wake_up_idle(true)` 把唤醒标记为 idle，避免上送突发流量时参与交互式进程的抢占
- **refill kthread 做了相同的 nice 调优**：`dp_rx_refill_thread_loop`（同文件 744 行）在进入主循环前同样调 `qdf_set_user_nice(..., -1)`。这正是 §8 对比表里"kthread 可独立调优"的默认起点——两条 kthread 都从 nice -1 起步，而非依赖 softirq 的调度策略

### 第六站：`dp_rx_thread_gro_flush()` —— GRO 合并队列的清空

GRO 会将到达的 skb 暂存在 per-flow 的合并队列中，等待同流的下一个 skb 到达后合并。但如果流中断或转为低速率，合并队列中的 skb 可能长时间等待而无法上送。回到分拣中心的比喻——合并队列就是车间里等待同流向下一件包裹的暂存架，`dp_rx_thread_gro_flush()` 则是车间按批次清空这些积压包裹的动作：不管下一件还来不来，先把暂存架上的包裹全部派送出去。

**触发条件（`dp_rx_should_flush()` 的判断）**：

`dp_rx_should_flush()`（`wlan_dp_rx_thread.c` 565 行）本身的逻辑很简洁——它只做两件事：

1. 读取 `rx_thread->gro_flush_ind` 原子变量（由其他路径在 flush 条件满足时设置）
2. 检查 `RX_VDEV_DEL_EVENT` 事件位（vdev 删除时强制 flush）

`gro_flush_ind` 有三个可能的取值（`enum dp_rx_gro_flush_code`）：

- `DP_RX_GRO_NOT_FLUSH`（0）：无需 flush，kthread 主循环中跳过 GRO flush 步骤
- `DP_RX_GRO_LOW_TPUT_FLUSH`：低吞吐量超时触发 flush
- `DP_RX_GRO_NORMAL_FLUSH`：vdev 删除时触发完整 flush

`gro_flush_ind` 的**设置来源**决定了实际的 flush 触发条件：

| 条件               | 场景                                                        | 机制                                                         |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------ |
| **无触发**         | nbufq 持续有新包入队，GRO 正常合并上送                      | `gro_flush_ind = DP_RX_GRO_NOT_FLUSH`，`dp_rx_thread_sub_loop` 跳过 GRO flush |
| **低吞吐量 flush** | 总线带宽投票检测到吞吐量下降，合并队列中的 skb 需要提前上送 | 总线带宽投票 `dp_low_tput_gro_flush_skip_handler`（`wlan_dp_bus_bandwidth.c`）置位 `low_tput_gro_enable`；RX offload 路径（`dp_rx_process_be` 中 `vdev->osif_gro_flush` 回调）触发 flush 指示回调 `dp_rx_thread_gro_flush_ind_cbk`（`wlan_dp_txrx.c:1321`），其读 `dp_is_low_tput_gro_enable` 后设置 `gro_flush_ind = DP_RX_GRO_LOW_TPUT_FLUSH` |
| **vdev 删除**      | 虚拟接口被移除                                              | `RX_VDEV_DEL_EVENT` 事件位被置位，`dp_rx_should_flush` 返回 `DP_RX_GRO_NORMAL_FLUSH` |

GRO flush 通过 `dp_rx_thread_gro_flush()` 实现，它调用 `qdf_local_bh_disable()` 禁用 BH（保护 GRO hash 表免受 softirq 并发），然后通过 `dp_ops.dp_rx_thread_napi_gro_flush(&rx_thread->napi, gro_flush_code)` 函数指针回调执行实际 flush。该回调最终调用 `napi_gro_flush()` ——将合并队列中所有待合并的 skb 上送协议栈（略过 GRO 合并），释放内存。

把 flush 只放在 kthread、不在 NAPI 软中断末尾补一份，是 `dp_register_rx_ol_cb()`（`wlan_dp_txrx.c:1189`）的显式选择：对 wifi3.0 目标它把 `receive_offload_cb` 指向 `dp_gro_rx_thread()` 的同时**不注册 NAPI flush**（源码注释：`no flush registration needed, it happens in DP thread`，同文件 1206 行）。取舍在于——merge 和 flush 若留在软中断，GRO 的 hash 查找、链表合并、checksum 校验会拉长软中断驻留时间、拖慢同 CPU 上的其他软中断；全搬进 kthread 后软中断只做"搬运+入队"，代价是等不到同流下一包的 skb 要在合并队列里多驻留一拍（直到 `gro_flush_ind` 被置位或低吞吐定时器触发）。从三个维度量化这个取舍：**吞吐**上，软中断单轮驻留时间从"搬包 + hash 查找 + 链表合并 + 上送"缩短到只"搬包 + 入队"，NAPI 单轮能服务的 ring 数更多，高负载下软中断不会因一个 TCP 大流的 GRO 合并卡住整条 RX 线；**延迟**上，同流 skb 在合并队列里等 flush 的时间就是额外尾部延迟——低吞吐定时器置位 `DP_RX_GRO_LOW_TPUT_FLUSH` 或 vdev 删除触发 `DP_RX_GRO_NORMAL_FLUSH` 才 flush，最坏等于整个低吞吐检测周期，对交互式短流（DNS 查询、TCP 握手）不友好；**CPU 缓存**上，merge 从软中断 CPU 迁到 kthread CPU，GRO hash 表和 per-flow 链表的缓存热度跟着转移——kthread 批量处理带来的批次内局部性弥补了跨 CPU 迁移的冷缓存，同时软中断 CPU 的 L1/L2 不再被 GRO 的 hash 查找污染，留给同 CPU 其他软中断的缓存空间更大。这是 QCOM 用尾部延迟换软中断弹性的核心决策。

## 2.3 `dp_rx_thread` 的多线程分配：REO 环到线程的静态映射

前面说到 nbuf_list 通过 `dp_rx_tm_thread_enqueue()` 入队到 kthread，但有一个关键问题没回答：**如果有多个 `dp_rx_thread`，数据包怎么知道该去哪个线程？** 本节介绍线程选择与分配机制——`dp_rx_tm_enqueue_pkt()` 作为入口，内部调用 `dp_rx_tm_select_thread()` 选定目标线程，再调用 `dp_rx_tm_thread_enqueue()` 入队。

答案在 `dp_rx_tm_select_thread()`（`wlan_dp_rx_thread.c` 1378 行）：

```c
// components/dp/core/src/wlan_dp_rx_thread.c — dp_rx_tm_select_thread, 线程选择
static uint8_t dp_rx_tm_select_thread(struct dp_rx_tm_handle *rx_tm_hdl,
                                      uint8_t reo_ring_num)
{
    uint8_t selected_rx_thread;

    selected_rx_thread = reo_ring_num % rx_tm_hdl->num_dp_rx_threads;
    dp_debug("ring_num %d, selected thread %u", reo_ring_num,
             selected_rx_thread);

    return selected_rx_thread;
}
```

**分配策略是 `reo_ring_num % num_threads`**——一个简单的取模运算，将 REO 硬件环号映射到对应的 kthread。这不是 Linux 内核的 RPS（Receive Packet Steering，基于流哈希的 CPU 映射）或 RSS（Receive Side Scaling，网卡硬件分流），而是**驱动层面的静态环-线程绑定**。

实际分配发生在 `dp_rx_tm_enqueue_pkt()`（同文件 1390 行）中：

```c
// components/dp/core/src/wlan_dp_rx_thread.c — dp_rx_tm_enqueue_pkt, 包分配入口
QDF_STATUS dp_rx_tm_enqueue_pkt(struct dp_rx_tm_handle *rx_tm_hdl,
                                qdf_nbuf_t nbuf_list)
{
    uint8_t selected_thread_id;

    selected_thread_id =
        dp_rx_tm_select_thread(rx_tm_hdl,
                               QDF_NBUF_CB_RX_CTX_ID(nbuf_list));
    dp_rx_tm_thread_enqueue(rx_tm_hdl->rx_thread[selected_thread_id],
                            nbuf_list);
    return QDF_STATUS_SUCCESS;
}
```

`QDF_NBUF_CB_RX_CTX_ID(nbuf_list)` 从 nbuf 的控制块中提取 **rx_ctx_id**——这个值实际上是数据包到达的 REO 环编号，由硬件在 DMA 时写入。硬件端的 REO engine 将不同 TID/流的包分配到不同的 REO 环（这是硬件行为，由固件配置），host 侧只需用取模将环映射到线程即可。

**线程数量**由 `CFG_DP_NUM_DP_RX_THREADS` 配置项决定（默认值从 `wlan_cfg` 中读取），上限为 `DP_MAX_RX_THREADS`（等于 `WLAN_CFG_NUM_REO_DEST_RING`，即硬件 REO 目的环的总数）。初始化时 `dp_rx_tm_init()`（同文件 950 行）在循环中为每个线程分配独立的 `dp_rx_thread` 结构体，包括自己的 `nbuf_queue`、`event_flag`、`wait_q` 等。

```c
// components/dp/core/src/wlan_dp_rx_thread.c — dp_rx_tm_init, 线程批量初始化（精简）
QDF_STATUS dp_rx_tm_init(struct dp_rx_tm_handle *rx_tm_hdl,
                         uint8_t num_dp_rx_threads)
{
    if (num_dp_rx_threads > DP_MAX_RX_THREADS) {
        dp_err("unable to initialize %u number of threads. MAX %u",
               num_dp_rx_threads, DP_MAX_RX_THREADS);
        return QDF_STATUS_E_INVAL;
    }

    rx_tm_hdl->num_dp_rx_threads = num_dp_rx_threads;
    rx_tm_hdl->rx_thread = qdf_mem_malloc(num_dp_rx_threads *
                                          sizeof(struct dp_rx_thread *));

    for (i = 0; i < rx_tm_hdl->num_dp_rx_threads; i++) {
        rx_tm_hdl->rx_thread[i] =
            (struct dp_rx_thread *)
            qdf_mem_malloc(sizeof(struct dp_rx_thread));
        dp_rx_tm_thread_init(rx_tm_hdl->rx_thread[i], i);
    }
    // ...
}
```

**对比 MTK**：MTK 没有多 kthread 模型——它只有 1 个 HIF thread（生产者）+ 1 个 NAPI poll（消费者），通过 KFIFO 无锁队列解耦。不存在"多个线程怎么分配"的问题，因为只有一条 NAPI 软中断路径。

这种静态环-线程映射有一个隐含的性能影响：**线程间的负载均衡完全取决于硬件 REO 的环分配策略**。如果硬件把大量流量集中在某几个 REO 环上，对应的 kthread 就会比其他线程忙，而其他线程可能空闲。这和 RSS 的动态流哈希不同——RSS 可以保证在流级别均匀分布，而这里的均衡性取决于硬件行为。极端情况下，若 80% 流量集中在 1 个 REO 环，4 个 kthread 中只有 1 个满载、其余 3 个空转，多线程解耦的吞吐量收益直接归零；RSS 则把这 80% 均匀打散到各核。

但静态映射换来了 RPS/RSS 求而不得的东西——**CPU 缓存亲和性**。`reo_ring_num % num_threads` 意味着同一个 REO 环的所有包永远落在同一个 kthread 上，该线程的 `nbuf_queue`、per-thread 的 GRO hash 表、per-flow 合并链表、统计计数器全都固定住在同一颗 CPU 的 L1/L2 缓存里，跨包处理时这些数据结构几乎全 cache-hit。反观 RPS/RSS 为了把流量均匀打散，会让同一个流的包在不同 CPU 之间漂移——流状态（flow 表项、GRO 链表）被迫在 CPU 间搬运、缓存反复失效，RPS 在包命中目标 CPU 之外时还要经 `enqueue_to_backlog()`（`net/core/dev.c:4843`）压入 per-CPU backlog 并 `net_rps_send_ipi()`（同文件 5991 行）发处理器间中断把软中断转发到目标 CPU。QCOM 的取模映射省掉了 IPI 和跨核缓存失效，代价是把均衡的赌注压在硬件 REO 的环分配策略上。这是一次"用确定性环绑定换缓存局部性"的取舍——负载均衡是软的（可以调整固件的环分配策略），缓存亲和是硬的（省下的缓存失效和 IPI 是实打实的 CPU 周期）。

---

# 3 MTK 的 RX 路径怎么走？——菜鸟的标准流水线

MTK 的 RX 路径接近标准 Linux NAPI 模型，没有 QCOM 那样的生产-消费解耦。

## 3.1 完整路径（逐站展开）

```
WFDMA 中断 → hard IRQ: disable_irq_nosync()
  ↓ irq thread（threaded IRQ 上半部）
HIF service thread                        HW ring → KFIFO 搬运 → napi_schedule()
  ↓ NET_RX_SOFTIRQ（软中断上下文）
kalNapiPoll()                             [os/linux/gl_kal.c]
  ① Reorder buffer 超时处理              getReorderQueParm 从超时链表取参数
     → qmFlushTimeoutReorderBubble()      超时 flush
     → qmFlushDeletedBaReorder()          已删除 BA 会话清理
  ② → kalNapiPollSwRfb()                 SW RFB 处理（RX Direct 模式）
     → KAL_FIFO_OUT                      从 KFIFO 无锁队列取 RFB
     → nicRxProcessPacketType()           按帧类型分派（数据/管理/控制帧）
       → kalRxIndicatePkts()             批量上送 skb 循环
         → kalRxIndicateOnePkt()          单个 skb 上送协议栈
           → napi_gro_receive()           GRO 合并 + 协议栈上送（在 softirq 中完成）
  ③ → kal_napi_complete_done()           NAPI 完成后再调度（KFIFO 有数据则重调）
```

### 第一站：WFDMA 中断处理 —— 为什么用 `disable_irq_nosync()`

MTK gen4m 的 RX 中断由 WFDMA（WiFi Direct Memory Access）引擎产生——当硬件将接收到的数据帧 DMA 到 host 内存后，WFDMA 触发 MSI 中断通知驱动。

MTK 在 hard IRQ handler 中使用 `disable_irq_nosync()` 而非标准的 `disable_irq()`，原因有二：

1. **`disable_irq_nosync()` 不等待当前正在执行的中断处理完成**——它只是一个写寄存器的操作，立即返回。而 `disable_irq()` 会自旋等待同 IRQ 线上的其他中断处理完成，在 hard IRQ 上下文中可能造成死锁
2. **WFDMA 中断的后续处理在 threaded IRQ 中完成**——hard IRQ 只负责关中断（防止重入），实际的数据搬运和处理由 HIF service thread（threaded IRQ）完成。`disable_irq_nosync()` 保证在 HIF thread 处理完当前批次之前，不会有新的 WFDMA 中断再次触发

### 第二站：HIF service thread —— 硬件 ring 到 KFIFO 的搬运

HIF（Host Interface）service thread 是 threaded IRQ 的下半部，负责从硬件 ring 搬运数据到软件队列：

1. **读取 WFDMA RX ring 描述符**：从硬件 RX ring 中取出已完成 DMA 的描述符，提取数据 buffer 的虚拟地址和长度
2. **构建 SW_RFB（Software Receive Frame Buffer）**：为每个接收到的帧分配 `SW_RFB` 结构体，包含 `skb` 指针、帧类型（通过 `nic_rxd_get_pkt_type` 从硬件描述符中读取）、BSS 索引、接收信号强度（RSSI）等信息
3. **通过 KFIFO 传递**：`KAL_FIFO_IN(&prGlueInfo->rRxKfifoQ, prSwRfb)` 将 SW_RFB 入队到 KFIFO——一个**无锁的单生产者单消费者 FIFO 队列**

KFIFO 的无锁设计是 MTK RX 路径的关键性能优化：生产者在 HIF thread 中入队，消费者在 NAPI softirq 中出队（`KAL_FIFO_OUT`），两者不需要任何锁同步，避免了锁竞争带来的 CPU 开销。

### 第三站：`kalNapiPollSwRfb()` —— RX Direct 模式下的 SW RFB 处理

`kalNapiPollSwRfb()`（`os/linux/gl_kal.c` 13526 行）是 RX Direct 模式下的 NAPI poll 回调。传统模式下走 `kalNapiPoll()` 的 `skb_queue_splice_init` + `napi_gro_receive` 路径，Direct 模式下走此函数。源码中存在两个版本的定义（13526 行和 13595 行），通过编译宏区分不同芯片变体——以下展示主版本：

```c
static int kalNapiPollSwRfb(struct napi_struct *napi, int budget)
{
    struct GLUE_INFO *prGlueInfo = container_of(napi, struct GLUE_INFO, napi);
    struct ADAPTER *prAdapter = prGlueInfo->prAdapter;
    struct SW_RFB *prSwRfb;
    uint32_t work_done = 1, u4Cnt;
    
    // 单用户保护：只允许一个执行上下文进入
    if (GLUE_INC_REF_CNT(i4UserCnt) > 1)
        goto end;  // 已有其他上下文在处理，直接退出
    
    // 通知 NAPI：main thread 可能已经处理了部分 RFB
    nicRxIndicateRfbMainToNapi(prAdapter);
    
    // 批量处理 KFIFO 中的 RFB
    u4Cnt = KAL_GET_FIFO_CNT(prGlueInfo);
    while ((work_done <= u4Cnt) && KAL_FIFO_OUT(&prGlueInfo->rRxKfifoQ, prSwRfb)) {
        if (!prSwRfb) break;
        nicRxProcessPacketType(prAdapter, prSwRfb);  // 按帧类型分派
        work_done++;
    }
    
    if (work_done > budget)
        work_done = budget;  // 不超过 budget
    
end:
    kal_napi_complete_done(napi, work_done);
    return work_done;
}
```

`nicRxProcessPacketType()` 是帧类型分派函数，根据 `prSwRfb->ucPacketType` 字段将帧路由到不同的处理路径：

- **RX_PKT_TYPE_RX_DATA**（数据帧）→ `kalRxIndicatePkts()`：批量上送 skb，调 `napi_gro_receive()` 进入协议栈
- **管理帧** → 通过帧控制字段的 `RXM_IS_MGMT_FRAME()` 宏识别，走 `kalIndicateRxMgmtFrame()` → `cfg80211_rx_mgmt()` 上送 cfg80211（与管理帧接收路径衔接）
- **控制帧** → 通过 `RXM_IS_CTRL_FRAME()` 宏识别，通常由固件处理，host 侧仅做统计计数

### 第四站：`kalRxIndicatePkts()` —— 批量上送 skb 的循环逻辑

`kalRxIndicatePkts()`（`os/linux/gl_kal.c` 1820 行）是批量上送 skb 的循环入口。与传统模式的一个个 `napi_gro_receive()` 不同，它在内部维护一个 "RX indicate 批次" 的逻辑：

- 从 SW_RFB 中提取 skb（`prSwRfb->pvPacket`）
- 设置 skb 的协议类型（`eth_type_trans()`）
- 调用 `kalRxIndicateOnePkt()` 完成单个 skb 的上送
- 处理完一批后更新 per-BSS 的 RX 统计计数

### 第五站：Reorder buffer 超时处理的更多细节

在 `kalNapiPoll` 的开头（处理所有 RX 业务之前），有两个 while 循环优先处理 reorder buffer 的超时：

```c
// 处理 rTimeoutRxBaEntry 链表：超时未补齐的 reorder buffer
while (prReorderQueParm =
       getReorderQueParm(&prAdapter->rTimeoutRxBaEntry,
                         prAdapter, SPIN_LOCK_RX_FLUSH_TIMEOUT))
    qmFlushTimeoutReorderBubble(prAdapter, prReorderQueParm);

// 处理 rFlushRxBaEntry 链表：BA 会话已删除的遗留帧
while (prReorderQueParm =
       getReorderQueParm(&prAdapter->rFlushRxBaEntry,
                         prAdapter, SPIN_LOCK_RX_FLUSH_BA))
    qmFlushDeletedBaReorder(prAdapter, prReorderQueParm);
```

`getReorderQueParm()`（`include/nic/que_mgt.h` 1298 行）是链表提取函数：

- 对 `rTimeoutRxBaEntry`：从超时链表中取出第一个 `RX_BA_ENTRY` 节点。这些节点由 `qmHandleReorderBubbleTimeout()` 定时器回调加入——当滑动窗口的某个 hole 超时未补齐时，对应的 BA 条目被加入此链表
- 对 `rFlushRxBaEntry`：从 BA 删除链表中取出第一个 `RX_BA_ENTRY` 节点。这些节点由 `qmDelRxBaEntry()` 加入——当 BA 会话被删除（DELBA 或超时）时，积压在 reorder buffer 中的帧需要被清空

两个链表使用不同的自旋锁（`SPIN_LOCK_RX_FLUSH_TIMEOUT` 和 `SPIN_LOCK_RX_FLUSH_BA`），避免超时处理和 BA 删除之间的锁竞争。

### 第六站：`kal_napi_complete_done()` —— NAPI 完成的封装

`kal_napi_complete_done()`（`os/linux/gl_kal.c` 13315 行）是对 Linux 标准 `napi_complete_done()` 的薄封装，本身**不包含任何再调度逻辑**：

```c
// MTK: os/linux/gl_kal.c — kal_napi_complete_done, NAPI 完成的薄封装
void kal_napi_complete_done(struct napi_struct *n, int work_done)
{
	if (!n)
		return;
	napi_complete_done(n, work_done);   // 内核 3.19+ 直接透传
}
```

真正的"防止中断丢失导致 RX 永久停滞"逻辑在**调用它的两个 `kalNapiPoll` 函数**里，而非这个封装内部：

- **传统模式 `kalNapiPoll`（见 3.2）**：`kal_napi_complete_done(napi, work_done)` 之后紧跟着 `if (skb_queue_len(prRxNapiSkbQ)) napi_schedule(napi)`。`napi_complete_done()` 关中断和再次检查 `prRxNapiSkbQ` 之间存在竞态窗口——HIF thread 可能在这个窗口内把新 skb 塞进 `rRxNapiSkbQ`，所以完成后再检查一次队列，有剩余就重新 `napi_schedule()`。
- **Direct 模式 `kalNapiPollSwRfb`**：`if (work_done < budget) kal_napi_complete_done(...)`——budget 耗尽时不调 `napi_complete_done`，交由 NAPI 框架自动重新调度；队列正常清空（`work_done < budget`）时才调封装收工。

## 3.2 `kalNapiPoll` 完整代码（传统模式）

传统模式下的 `kalNapiPoll`（已在 3.1 第三站中展开的 Direct 模式的对比版本）流程如下：

```c
// MTK: os/linux/gl_kal.c — kalNapiPoll, NAPI poll 回调（传统模式）
int kalNapiPoll(struct napi_struct *napi, int budget)
{
    struct GLUE_INFO *prGlueInfo = container_of(napi, struct GLUE_INFO, napi);
    struct ADAPTER *prAdapter = prGlueInfo->prAdapter;
    struct sk_buff_head rFlushSkbQ;
    
    // ① Reorder buffer 超时处理（已在 3.1 第五站展开）
    while (getReorderQueParm(&prAdapter->rTimeoutRxBaEntry, ...))
        qmFlushTimeoutReorderBubble(prAdapter, prReorderQueParm);
    while (getReorderQueParm(&prAdapter->rFlushRxBaEntry, ...))
        qmFlushDeletedBaReorder(prAdapter, prReorderQueParm);
    
    // ② RX Direct 模式分派（已在 3.1 第三站展开）
    if (HAL_IS_RX_DIRECT(prAdapter))
        return kalNapiPollSwRfb(napi, budget);
    
    // ③ 传统模式：skb 队列 splice → 逐个 napi_gro_receive
    spin_lock_irqsave(&prRxNapiSkbQ->lock, flags);
    skb_queue_splice_init(prRxNapiSkbQ, &rFlushSkbQ);  // splice: 原子搬空
    spin_unlock_irqrestore(&prRxNapiSkbQ->lock, flags);
    while ((work_done < budget) && skb_queue_len(&rFlushSkbQ)) {
        prSkb = __skb_dequeue(&rFlushSkbQ);
        napi_gro_receive(napi, prSkb);                  // GRO 在 softirq 中完成
        work_done++;
    }
    
    // ④ NAPI 完成 + skb 队列再调度检查（已在 3.1 第六站展开）
    kal_napi_complete_done(napi, work_done);
    if (skb_queue_len(prRxNapiSkbQ))
        napi_schedule(napi);  // 队列还有数据 → 重新调度
    return work_done;
}
```

## 3.3 `kalRxIndicateOnePkt` —— 协议栈上送的最后一站

`kalRxIndicateOnePkt`（`os/linux/gl_kal.c:1934`）是将单个 skb 上送协议栈的终点函数。它的核心职责：

1. **BSS→net_device 映射**：通过 `GLUE_GET_PKT_BSS_IDX(prSkb)` 从 skb 的 CB 中提取 BSS 索引，调用 `wlanGetNetInterfaceByBssIdx()` 查找对应的 `net_device`——多 BSS 场景下，不同 SSID 对应不同的网络接口
2. **设置协议类型**：`prSkb->protocol = eth_type_trans(prSkb, prNetDev)`——解析以太网帧头的 EtherType 字段，设置 skb 的协议类型（如 `ETH_P_IP`、`ETH_P_ARP`），同时将 skb 的 data 指针跳过以太网头（14 字节），指向 IP 头
3. **GRO 路径分派**：
   - **RX Direct 模式**：直接在 NAPI 软中断上下文中调 `napi_gro_receive()`——需要 `preempt_disable()` 和 `spin_lock_bh(&napi_spinlock)` 保护
   - **非 Direct 模式**：将 skb 入队到 `rRxNapiSkbQ` + `kal_napi_schedule()`，由下一轮 NAPI poll 处理

## 3.4 关键差异

MTK 选择在 softirq 中直接调 `napi_gro_receive`。这意味着 GRO 的耗时操作会占用软中断时间片。为什么 MTK 不学 QCOM 做解耦？

三个原因：

1. **硬件吞吐量不同**：MTK 芯片的目标吞吐量低于 QCOM 的旗舰芯片，GRO 在 softirq 中完成的 CPU 开销在可接受范围内
2. **架构简洁优先**：MTK 驱动整体追求"代码路径少、状态管理简单"（从 TX 路径就能看出来），引入 kthread 解耦会增加代码复杂度
3. **KFIFO 已经做了缓冲**：MTK 的 HIF thread 通过 KFIFO 将 skb 从硬件 ring 搬运到 NAPI 可消费的队列，这个无锁管道已经提供了生产者-消费者的基础解耦

第 3 点值得展开——同为生产者-消费者解耦，MTK 的 KFIFO 与 QCOM 的 `nbuf_queue` 在锁的层面走了相反的路。MTK 的 `KAL_FIFO_IN`/`KAL_FIFO_OUT`（`os/linux/include/gl_kal.h:890/892`）落到内核 `kfifo_in`/`kfifo_out`，是为单生产者单消费者设计的无锁 FIFO：head 与 tail 下标各归一方独占更新，只用 `smp_wmb`/`smp_rmb` 内存屏障保序，全程不碰 spinlock。QCOM 的 `qdf_nbuf_queue_head_enqueue_tail()` 则走 `skb_queue_tail`，每次入队都要抢 `skb_queue_head->lock` 自旋锁。

这把锁有两层代价：一是缓存行颠簸——生产者在 NAPI softirq（可能多核并发入队同一 `rx_thread` 队列）、消费者在 kthread 出队，锁 cache line 在核间反复失效、真共享争抢；二是真竞争——多 NAPI 同时入队时 spinlock 把并发串行化。MTK 的无锁设计把这两层归零，代价是拓扑被钉死在单生产者单消费者，未来要并行入队就得退回加锁。回到菜鸟流水线的比喻——HIF thread 和 NAPI softirq 就像流水线上紧挨的两个工位，中间用一条无锁传送带（KFIFO）衔接，包裹滑过去不需要交接单（锁），工位也不会因为抢同一张交接单而互相等待。


---

# 4 AMPDU 接收端重排：硬件 vs 软件

数据面吞吐量的关键是聚合——把多个 MSDU/MPDU 打包成一个 PPDU 发送，减少每帧的 PHY 头部开销和信道竞争开销（IEEE 802.11-2020 §10.12 定义了 A-MPDU 聚合操作，§10.25.6.6 定义了接收端重排序缓冲控制规则）。用分拣中心的比喻来说：单帧就像一件一件搬包裹，聚合就像把同目的地的包裹打成一个托盘——托盘编号（序列号）贴在外面，收货时按托盘编号把包裹拆出来、按序号排好。拆托盘排包裹这一步，就是接收端重排。

两个平台对 AMPDU 接收端重排的处理方式截然不同：QCOM 将重排交给硬件 REO engine，MTK 用软件滑动窗口。但有一点是共通的——**host 侧负责 BA 会话的建立和拆除，固件/硬件负责聚合帧的实际收发**。

## QCOM：硬件 REO 重排 + DP 层会话管理

QCOM 芯片内置 REO（Reorder）硬件引擎，AMPDU 子帧的接收和重排出硬件完成，host 侧 DP 层只负责 BA 会话的生命周期管理。当 peer 关联成功后，`dp_peer_rx_tids_init()` 为每个 peer 初始化所有 TID 的接收状态（源码中有两个版本的定义——MLO 版本在行 1163 和非 MLO 版本在行 1198，通过 `#else` 编译宏区分——以下展示 MLO 版本）：

```c
// dp/wifi3.0/dp_rx_tid.c — dp_peer_rx_tids_init, per-peer TID 初始化
static void dp_peer_rx_tids_init(struct dp_peer *peer)
{
    int tid;
    struct dp_rx_tid *rx_tid;
    struct dp_rx_tid_defrag *rx_tid_defrag;

    // 初始化分片重装结构（非 MLO link peer）
    if (!IS_MLO_DP_LINK_PEER(peer)) {
        for (tid = 0; tid < DP_MAX_TIDS; tid++) {
            rx_tid_defrag = &peer->txrx_peer->rx_tid[tid];
            rx_tid_defrag->array = &rx_tid_defrag->base;
            rx_tid_defrag->defrag_timeout_ms = 0;
            rx_tid_defrag->defrag_waitlist_elem.tqe_next = NULL;
            rx_tid_defrag->defrag_waitlist_elem.tqe_prev = NULL;
            rx_tid_defrag->base.head = NULL;
            rx_tid_defrag->base.tail = NULL;
            rx_tid_defrag->tid = tid;
            rx_tid_defrag->defrag_peer = peer->txrx_peer;
        }
    }

    // 初始化 per-TID BA 状态
    for (tid = 0; tid < DP_MAX_TIDS; tid++) {
        rx_tid = &peer->rx_tid[tid];
        rx_tid->tid = tid;
        rx_tid->ba_win_size = 0;
        rx_tid->ba_status = DP_RX_BA_INACTIVE;   // 初始状态：无 BA 会话
    }
}
```

主要功能：

- **per-peer per-TID 双结构**：`dp_rx_tid_defrag` 管理分片重装（接收端将 fragment 重组为完整 MSDU），`dp_rx_tid` 管理 BA 会话状态和 REO 硬件队列描述符
- **`ba_status` 状态机**：初始为 `DP_RX_BA_INACTIVE`——ADDBA Request 协商成功后，`dp_rx_tid_setup_wifi3()`（同文件）将状态推进为 IN_PROGRESS，REO 硬件开始工作后再置为 ACTIVE。DELBA 或超时则回到 INACTIVE
- **硬件重排卸载**：实际的 AMPDU 接收和序列号重排由 REO 硬件引擎完成——host 侧不需要维护软件滑动窗口。这节省了大量 CPU 周期，代价是需要为每个 TID 分配 REO 队列描述符（`hw_qdesc_vaddr` / `hw_qdesc_paddr`）
- **但"重排窗口开多大"仍由 host 编程**：host 侧虽不维护软件滑动窗口，却要负责把 BA 窗口大小和起始序列号写进 REO 硬件队列描述符，而且这条编程路径分**两段**——"setup"和"update"。初次建连时 `dp_rx_tid_setup_wifi3()`（`dp_rx_tid.c:725`）遍历 TID，对尚未分配队列描述符的 TID 走 `dp_single_rx_tid_setup()`（同文件 584 行）：先按 `hal_get_reo_qdesc_size()` 算出描述符大小、`qdf_mem_malloc` 分配并对齐，再按安全类型选 `hal_pn_type`（TKIP-NOMIC/CCMP/GCMP→`HAL_PN_WPA`，WAPI→`HAL_PN_WAPI_EVEN/UNEVEN`，否则 `HAL_PN_NONE`），最后 `hal_reo_qdesc_setup()`（`hal/wifi3.0/hal_reo.h:687`，inline dispatch 到 `hal_reo_qdesc_setup_be()`）把 `ba_window_size`、`start_seq`、PN 类型、`vdev_stats_id` 一次性烧进 `hw_qdesc_vaddr` 指向的 REO 队列描述符——这是"setup"。此后 BA 会话状态变化（ADDBA 重协商、收到 BlockAckReq 要求前移 SSN、BAR 触发重传）时，`dp_rx_tid_setup_wifi3()` 发现该 TID 的描述符已存在，改走 `dp_rx_tid_update_wifi3()`（`dp_rx_tid.c:328`）——它不再重写描述符，而是填 `hal_reo_cmd_params`（置 `update_ba_window_size=1`；当 `start_seq < IEEE80211_SEQ_MAX` 时再置 `update_ssn=1` 写入新 SSN），经 `dp_reo_send_cmd()`（`dp_reo.c:88`）以 `CMD_UPDATE_RX_REO_QUEUE` 命令字下发给 REO 硬件做增量更新——这是"update"。窗口滑动本身由 REO 硬件按到达 MPDU 的序列号自动推进，host 只在窗口边界需要变化时才下命令重编程；`ba_window_size` 在下发前还会被 `hal_get_rx_max_ba_window()`（同文件 1496 行）夹到硬件支持的上限内。重排的"日常动作"在硬件，重排的"边界修正"在 host

## MTK：软件滑动窗口 + NAPI 内联处理

Gen4m 驱动没有独立的硬件重排引擎。AMPDU 子帧到达后，固件完成 MPDU 级别的接收，host 侧在 `kalNapiPoll` 的 NAPI 软中断中完成两件事：**超时重排 flush** 和 **BA 会话删除后的积压帧清理**。

```c
// MTK: os/linux/gl_kal.c — kalNapiPoll 中的 reorder buffer 处理（摘录）
int kalNapiPoll(struct napi_struct *napi, int budget)
{
    // ...省略前置初始化...

    // 步骤1：处理 reorder buffer 超时——滑动窗口卡住太久，主动 flush
    while (prReorderQueParm =
           getReorderQueParm(&prAdapter->rTimeoutRxBaEntry, ...))
        qmFlushTimeoutReorderBubble(prAdapter, prReorderQueParm);

    // 步骤2：处理 BA 会话已删除的遗留帧——直接 flush，不再等待重传
    while (prReorderQueParm =
           getReorderQueParm(&prAdapter->rFlushRxBaEntry, ...))
        qmFlushDeletedBaReorder(prAdapter, prReorderQueParm);

    // ...后续：GRO 上送 ...
}
```

主要功能：

- **滑动窗口在软件中维护**：每个 BA 会话对应一个 reorder buffer，按序列号排列。窗口内的帧按序上送，窗口外的帧缓存等待。当序列号连续时（hole 补齐），滑动窗口前移
- **双超时队列**：`rTimeoutRxBaEntry` 存超时未补齐的 reorder queue——通过 `qmFlushTimeoutReorderBubble` 强制 flush（不再等待丢失的 MPDU 重传）；`rFlushRxBaEntry` 存 BA 会话已删除的遗留帧——通过 `qmFlushDeletedBaReorder` 清理。这两个队列在每次 `kalNapiPoll` 调用时都会优先处理
- **BA 会话管理走 CNM 层**：ADDBA/DELBA 的协商由 CNM（Connection Manager）在控制面完成，数据面只负责"已有的 BA 会话怎么用"，不负责"BA 会话怎么建立"

同为重排，两种做法的 CPU 成本形态相反。QCOM 的窗口滑动在 REO 硅片里按到达序列号自动推进，host 只在窗口边界变化时调 `dp_rx_tid_setup_wifi3()`（`dp_rx_tid.c:725`）重烧队列描述符、或经 `dp_reo_send_cmd()` 下发 `CMD_UPDATE_RX_REO_QUEUE` 做增量更新——这条编程指令摊到整个 BA 会话的生命周期上，与每秒收多少包无关。MTK 则把重排压在 NAPI softirq 里：每轮 `kalNapiPoll` 都要用 `getReorderQueParm()` 从超时链表摘节点、`qmFlushTimeoutReorderBubble()` 逐个比对序列号、再把补齐的帧从 reorder buffer 拼成 skb 上送——这是一串跑在 host CPU 上的链表遍历与缓存访问，成本随包量线性增长。取舍本质是"一次性硬件编程"换"每包软件指令"：QCOM 每包省下的 CPU 周期，MTK 用软中断时间片和缓存带宽来付。

---

# 5 多播与广播帧的特殊处理

目前为止讨论的数据帧都是单播帧，但 WiFi 网络中还存在多播和广播数据帧（如 ARP 广播、mDNS 多播、组播视频流）。在分拣中心的比喻里，单播帧是"寄给一个具体收件人的快递"，多播/广播帧是"小区公告栏贴告示"——不需要签收、不追踪送达、发完就走。这种"只管发不管到"的特性决定了它们在数据面中的几条特殊规则：

**不使用 AMPDU/Block ACK**：多播/广播帧没有单一接收端，因此无法建立 BA 会话——它们只使用普通 ACK 或 NoAck 策略，单帧单发，没有聚合。

**以基础速率发送**：为确保所有 STA（包括信号较差的）都能收到，AP 以 BSS 的基础速率（basic rate set）发送多播/广播帧，而非单播帧可用的高 MCS 速率。这是吞吐量的一个隐性瓶颈——大量多播流量会拖慢整个 BSS 的 airtime 利用率。

**不使用 RTS/CTS 保护**：多播/广播帧的目标是"所有听众"，RTS/CTS 的接收地址无法设定为广播地址，因此这些帧不受 NAV 保护，碰撞概率高于单播帧。

两个平台的实现差异：

- **QCOM**：DP 层通过 multicast filter 决定哪些多播帧需要上送 host（如 mDNS 多播需要上送，而 IGMP 查询可能被固件过滤）。过滤规则通过 WMI 接口下发到固件——host 侧 PMO 层的 `pmo_core_enable_mc_addr_filtering_in_fwr()`（`components/pmo/core/src/wlan_pmo_mc_addr_filtering.c`）负责将多播地址列表缓存并下发到固件。在 RX 数据面，`dp_rx_mcast_echo_check()`（`dp/wifi3.0/dp_rx_err.c:60`）对收到的多播帧进行回波检测——如果帧的源 MAC 与设备自身 MAC 相同，说明是多播回环，直接丢弃以避免协议栈收到自己发出的多播帧
- **MTK**：多播/广播帧的处理主要在固件侧完成——`wlanSetMulticastList()`（`os/linux/gl_init.c:2945`）作为 `net_device` 的 multicast list 回调，将多播地址列表通过 NIC cmd 通道配置到固件，host 侧对已过滤的帧无感知

---

# 6 Power Save 与数据帧缓冲

当 STA 进入 Power Save（PS）模式时，数据面不再是"有包就发"——AP 需要将单播帧缓存起来，等到 STA 醒来时再下发。用分拣中心的比喻：STA 休眠就像收件人出门度假了——分拣中心不能把包裹堆在门口，只能先暂存到驿站（PS buffer），等收件人回来（STA 唤醒）后再通知取件（TIM/PS-Poll）。这一"先存后取"的机制直接影响数据帧的排队延迟和功耗。

**AP 侧缓冲**：当 STA 通过帧控制字段的 Power Management bit 宣告进入 PS 模式后，AP 侧的驱动/固件为每个 PS-STA 维护一个 per-STA 的 PS buffer。所有目标为该 STA 的单播帧不再直接发送，而是暂存在 buffer 中。QCOM 和 MTK 的 PS buffer 管理均在固件侧完成——host 侧驱动不直接操作 PS buffer，只负责把 PS 决策参数通过命令通道下发给固件：

- **QCOM 下发链**：`wma_unified_set_sta_ps_param()`（`core/wma/src/wma_power.c:100`）经 `wmi_unified_sta_ps_cmd_send()` 以 `WMI_STA_POWERSAVE_PARAM_CMDID`（`fw-api/fw/wmi_tlv_defs.h:1527`）下发；DTIM 接收方式由 `WMI_STA_DTIM_PS_METHOD_CMDID`（`fw-api/fw/wmi_tlv_defs.h:1529`）单独控制；AP 模式 U-APSD 则由 `wma_set_ap_peer_uapsd()`（`core/wma/src/wma_power.c:139`）走 `WMI_AP_PS_PEER_PARAM_CMDID`（`fw-api/fw/wmi_tlv_defs.h:1560`）配置
- **MTK 下发链**：`CMD_ID_SET_PS_PROFILE_ADV`（`include/wsys_cmd_handler_fw.h:224`）下发 PS Profile（DTIM 周期、U-APSD 各 AC 位图、Listen Interval）

帧的实际缓存和下发仍由固件决策：QCOM 侧的统计代码（`dp/wifi3.0/dp_stats.c`）通过 `tx_legacy_cck_rate` 和 `tx_legacy_ofdm_rate` 统计 PS 唤醒后以传统速率发送的帧数；MTK gen4m 侧 `kalHardStartXmit()`（`os/linux/gl_kal.c:3692`）入队的帧最终由固件根据 STA 的 PS 状态决定立即发送还是缓存。

**TIM/DTIM 通告**：AP 在每个 Beacon 中携带 TIM（Traffic Indication Map）IE，按 AID（Association ID）位图告知"哪些 PS-STA 有缓存帧待取"。DTIM Beacon（每隔 N 个 Beacon 发一次）额外携带多播/广播帧的缓存信息——多播帧在 DTIM 之后立即下发，因为所有 STA 在 DTIM 后都会短暂保持唤醒。

**STA 取帧的两种方式**：

- **PS-Poll（传统方式）**：STA 发送 PS-Poll 控制帧，AP 响应一个缓存帧。STA 可以多次发送 PS-Poll 直到 AP 回复帧的 More Data bit 为 0（表示缓存清空）。每取一个帧就要一次 PS-Poll 握手，效率低
- **U-APSD（WiFi 多媒体扩展）**：STA 在预定时间发送触发帧（如 QoS Null 或 QoS Data），AP 以一个服务周期（Service Period）窗口下发一批缓存帧。QCOM 和 MTK 都支持 U-APSD，但均在固件侧实现——host 侧驱动不感知 PS-Poll 和 U-APSD 的握手细节

回到驿站取件的比喻——PS-Poll 是收件人隔一会儿就打电话问驿站"有我的包裹吗"，每问一次驿站只递一件，电话费（信道开销）高；U-APSD 则是驿站和收件人约好一个取件窗口，窗口一到就把这段时间攒下的包裹一次性递过去，省去反复打电话的往返。PS-Poll 到 U-APSD 的演进，就是取件从"逐件确认"变成"批量交接"的过程。

**数据面的实际影响**：Power Save 意味着数据面的"即发即走"模型在 PS 场景下失效。一帧可能从 `ndo_start_xmit` 入队后，在 PS buffer 中停留数十到数百毫秒（取决于 STA 的 Listen Interval）。这对于延迟敏感的应用（VoIP、在线游戏）可能是致命的——这也解释了为什么 WiFi Calling 通常要求 STA 关闭 PS 模式或使用 U-APSD 缩短唤醒间隔。

---

# 7 出了问题的物流网络：RX 异常路径

前面讲的都是"正常情况"——数据包从硬件 DMA ring 到协议栈的完整路径。但 RX 真正的挑战往往不在正常路径上，而在异常路径上。以下总结两个平台共有的关键 RX 错误场景。这六个场景可以分成三组：描述符耗尽与 kthread 队列溢出是"背压"问题（硬件进不来，软件接不住），分片丢失与解密失败是"质量"问题（帧进来了但拼不完整或被安全过滤），NAPI budget 耗尽与统一丢包是"过载"问题（接住了但处理不过来，最终丢包兜底）。

**RX 描述符耗尽**（背压——硬件进不来、软件接不住）：当 CPU 处理速度跟不上硬件收包速度时，RX 描述符被耗尽，硬件无法再 DMA 数据到 host 内存。QCOM 的应对是在 `dp_rx_refill_thread_loop`（独立于 `dp_rx_thread` 的 refill kthread，源码 `wlan_dp_rx_thread.c:732`）中持续补充空 buffer——refill thread 和 RX NAPI poll 之间的"描述符水位"是吞吐量的关键调优点——水位由 `dp_rx_schedule_refill_thread()`（`dp_rx_buffer_pool.h:106`）判定，待补 buffer 数达到 `DP_RX_REFILL_THRD_THRESHOLD` 才调度，单次最多补 `DP_RX_REFILL_BUFF_POOL_BURST`（64）个。MTK 的 KFIFO 天然提供了背压——KFIFO 满后 HIF thread 无法继续入队，硬件侧的 WFDMA 描述符自然被消费变慢。

**分片丢失与 Reorder 超时**（质量——帧进来了但拼不完整）：AMPDU 中某个 MPDU 丢失时，Reorder buffer 会等待重传。等待超时（QCOM 的 reorder 超时由 `rx_timeout_pri[4]` 按 AC 配置，`wmi_unified_param.h:7321`；host 控制面经 `wma_set_rx_reorder_timeout_val()`（`wma_main.c:8314`）打包，以 `WMI_PDEV_SET_REORDER_TIMEOUT_VAL_CMDID`（`wma_main.c:8350`）下发固件）后，QCOM 的 REO 硬件自动 flush reorder buffer 将已收到的帧上送——即使有空洞也不再等待。MTK 的 `kalNapiPoll` 在处理循环之前先处理 `rTimeoutRxBaEntry` 和 `rFlushRxBaEntry` 两个超时队列，通过 `qmFlushTimeoutReorderBubble` 和 `qmFlushDeletedBaReorder` 清理超时和删除的 BA 会话中的积压帧。

**解密失败**（质量——帧进来了但被安全过滤）：当硬件解密引擎（QCOM 的 crypto engine 或 MTK 的 firmware-based crypto）无法解密某个帧时，该帧在进入 DP/NAPI 处理前就会被丢弃。QCOM 侧 REO 硬件在 push 到 host 前会检查解密状态，解密失败的帧直接进入 REO exception ring（`soc->reo_exception_ring`）而非正常 REO ring，由 `dp_rx_err_process()`（`dp/wifi3.0/dp_rx_err.c:2078`，在 REO NAPI 服务路径中被调用）处理——读到 `HAL_REO_ERR_PN_CHECK_FAILED` 错误码后，经 `dp_rx_pn_error_handle()` 直接丢弃。MTK 侧固件在 SW_RFB 构建时会标记帧的解密状态——SW_RFB 结构体（`include/nic/nic_rx.h:885`）中 `ucSecMode`（`include/nic/nic_rx.h:916`）记录安全模式，`fgIcvErr`（`include/nic/nic_rx.h:937`）标记 ICV 校验失败，`fgIsCipherMS`（`include/nic/nic_rx.h:940`）标记加密算法不匹配，`fgIsCipherLenMS`（`include/nic/nic_rx.h:941`）标记加密长度不匹配；这些错误位由硬件 RX 描述符承载——`RX_STATUS_FLAG_ICV_ERROR`（`include/nic/nic_rx.h:165`，BIT 4）经 `HAL_RX_STATUS_IS_ICV_ERROR()`（`include/nic/nic_rx.h:1456`）读取，`RX_STATUS_FLAG_CIPHER_MISMATCH`（`include/nic/nic_rx.h:163`，BIT 2）经 `HAL_RX_STATUS_IS_CIPHER_MISMATCH()`（`include/nic/nic_rx.h:1449`）读取，`RX_STATUS_FLAG_CIPHER_LENGTH_MISMATCH`（`include/nic/nic_rx.h:164`，BIT 3）经 `HAL_RX_STATUS_IS_CLM_ERROR()`（`include/nic/nic_rx.h:1452`）读取，解密失败的帧不会被 HIF thread 入队到 KFIFO。两个平台都不会将解密失败的帧上送到 host 协议栈。

**NAPI budget 耗尽**（过载——接住了但处理不过来）：当单次 NAPI poll 处理完 `budget` 配额后仍有数据在 ring 中，`napi_complete_done()` 不会被调用——内核的 `net_rx_action()` 会通过 `napi_schedule()` 重新调度该 NAPI 实例。QCOM 的 `hif_napi_poll` 通过 `budget` 参数限制 CE 描述符消费数量，MTK 的 `kalNapiPollSwRfb` 通过 `work_done > budget` 检查确保不超过配额。budget 耗尽本身不是错误，但在高负载下意味着单次软中断无法清空 ring，需要通过多次轮询来消化——如果 CPU 负载持续偏高，ring 溢出就成为连锁反应。

**kthread 队列溢出与背压**（背压——软件队列水位超限）：QCOM 的 `dp_rx_tm_thread_enqueue()`（`wlan_dp_rx_thread.c:281`）在入队前检查 `allow_dropping` 原子标志——当 kthread 队列堆积超过水位线时，此标志被置位，后续到达的 nbuf_list 直接被释放（`qdf_nbuf_list_free`），不进入 `nbuf_queue`。这是驱动层面对 CPU 过载的最后一层流控。释放前通过 `rx_thread->stats.dropped_enq_fail` 累计入队失败丢包数（`wlan_dp_rx_thread.c:316`），确保运维侧能看到丢包发生在入队环节。MTK 的 KFIFO 天然提供了队列上界——KFIFO 满时 `KAL_FIFO_IN` 入队失败，HIF thread 无法推送新的 SW_RFB，硬件描述符消费自然减缓。

**统一丢包路径**（过载——最终丢包兜底）：QCOM 的 `dp_rx_drop_nbuf_list()`（`dp/wifi3.0/dp_rx.c:2117`）是所有 RX 丢包的最终出口。不管丢包原因是什么——`dp_rx_validate_rx_callbacks` 验证失败、`dp_rx_check_delivery_to_stack` 回调异常、intra-BSS 转发失败——最终都汇聚到这一个函数，统一释放 nbuf 链表并更新 `pdev->stats` 中的 per-reason 丢包计数器。这种"多入口、单出口"的丢包设计使得运维排查能快速定位丢包原因。MTK 侧丢包主要在 HIF thread 入队阶段（KFIFO 满）和 `kalRxIndicateOnePkt` 的回调失败路径上，没有统一的丢包函数——丢包分散在各处，统计信息也分布在不同的计数器中。

---

# 8 QCOM vs MTK RX：到底差在哪里？

将 RX 路径放在一起，QCOM 和 MTK 的完整差异如下：

| 维度              | QCOM                                                         | MTK                                                          |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **RX 中断**       | MSI → `hif_napi_schedule()`                                  | WFDMA MSI → `disable_irq_nosync()`                           |
| **数据搬运**      | NAPI softirq（`hif_napi_poll` → CE 消费）                    | threaded IRQ（HIF service thread → KFIFO）                   |
| **RX 描述符管理** | 独立 refill kthread（`dp_rx_refill_thread_loop`）持续补充    | KFIFO 自然背压，HIF thread 按需补充                          |
| **Reorder**       | REO 硬件重排（host 侧只做 BA 会话管理）                      | 软件滑动窗口（`kalNapiPoll` 中 `qmFlushTimeoutReorderBubble`） |
| **GRO 上下文**    | kthread（merge `receive_offload_cb` + flush `dp_rx_thread_gro_flush`），NAPI 侧仅置位 `gro_flush_ind` 请求 flush | NAPI softirq（`kalNapiPoll` 中 merge + flush）               |
| **GRO 保护**      | kthread 中 `qdf_local_bh_disable()`                          | NAPI 隐式 BH 保护                                            |
| **协议栈上送**    | kthread（`dp_rx_thread_process_nbufq` → `stack_fn`）         | NAPI softirq（`kalRxIndicateOnePkt` → `napi_gro_receive`）   |
| **解耦方式**      | CE → `nbuf_queue` → kthread                                  | HIF → KFIFO → NAPI                                           |
| **线程模型**      | 1 NAPI + N `dp_rx_thread` + 1 refill kthread。线程数 N 由 `CFG_DP_NUM_DP_RX_THREADS` 配置 | 1 HIF thread + 1 NAPI poll                                   |
| **线程分配**      | `reo_ring_num % num_threads` 静态取模（环→线程），非 RPS/RSS | 无需分配（单消费者）                                         |
| **RX 数据拷贝**   | 0 拷贝：预分配 nbuf + DMA map（`qdf_nbuf_alloc` + `qdf_nbuf_map_nbytes_single`），固件 DMA 直接写入 | 0 拷贝：page pool + `build_skb`（`os/linux/hif/common/hif_mem.c:1160`），页直接包装为 skb |
| **调度灵活性**    | kthread 可独立调优（chrt/nice）                              | 依赖 softirq 调度策略                                        |
| **设计哲学**      | 复杂度换吞吐量弹性                                           | 简洁性换可靠性                                               |

表里"RX 数据拷贝"一行值得展开——两个平台都做到了"0 数据拷贝"，但省下的 CPU 成本形态不同。QCOM 的 nbuf 在 refill 阶段就 `qdf_nbuf_alloc()`（`dp_rx_buffer_pool.c:161`）预分配成完整的 skb、再 `qdf_nbuf_map_nbytes_single(..., QDF_DMA_FROM_DEVICE)`（同文件 168 行）一次性 DMA map，固件直接 DMA 写进 skb 的数据区，RX 热路径上**零分配、零 map、零 memcpy**——DMA map 的成本摊到 refill 一次性做完，skb 整个回收复用。MTK 的 RX Direct 路径走 `kalAllocRxSkb()`（`hif_mem.c:1143`）→ `wifi_page_pool_alloc_page()` + `build_skb(page_to_virt(page), PAGE_SIZE)`（同文件 1160 行）——页从 page pool 预取，`build_skb` 把 skb 头直接塞进页尾的空闲区，固件 DMA 写进页头，同样是 0 数据 memcpy，但每包要重新构造一次 skb 元数据（`build_skb` 比完整 `alloc_skb` + `kmem_cache` 分配便宜，却仍有每包开销）。两者共同规避的是"草稿缓冲"式驱动那第三类做法：固件 DMA 进一块独立 DMA buffer、host 再 `memcpy` 进 skb——MTK 的 legacy 拷贝路径 `halCopyPathCopyRxData()`（`hif_mem.c:560`）里那句 `memcpy(prSkb->data, prDmaBuf->AllocVa, u4Size)`（同文件 584 行）就是这种每包一次 memcpy 的形态：一条 1500 字节的帧一次 memcpy 就是上百纳秒的纯 CPU 时间，且拷贝要经过 L1/L2 缓存，在百万 pps 量级下逐包拷贝会线性吃掉整颗核的相当比例，还挤占本该给协议栈的缓存带宽。

追踪上面这些差异时，散落在各节的关键常量/枚举有必要集中成一份速查表——它们的取值决定了双平台 RX 路径的行为边界（GRO flush 时机见 §2.2 第六站，BA 状态机见 §4，线程数上限见 §2.3）：

| 常量/枚举                  | 取值                                                         | 含义                               |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| `DP_RX_GRO_NOT_FLUSH`      | 0                                                            | 无需 GRO flush，kthread 主循环跳过 |
| `DP_RX_GRO_NORMAL_FLUSH`   | 1                                                            | vdev 删除时完整 flush              |
| `DP_RX_GRO_LOW_TPUT_FLUSH` | 2                                                            | 低吞吐量时提前 flush               |
| `DP_RX_BA_INACTIVE`        | 0                                                            | BA 会话未建立                      |
| `DP_RX_BA_ACTIVE`          | 1                                                            | BA 会话活跃                        |
| `DP_RX_BA_IN_PROGRESS`     | 2                                                            | ADDBA 协商中                       |
| `DP_MAX_TIDS`              | 17                                                           | per-peer TID 总数（TID 0-16）      |
| `DP_MAX_RX_THREADS`        | = `WLAN_CFG_NUM_REO_DEST_RING`（Boron 9 / Beryllium 8 / 其他 4） | RX kthread 上限                    |
| `CFG_DP_NUM_DP_RX_THREADS` | 默认 1（范围 1-4）                                           | 实际分配的 RX kthread 数           |

---

# 9 写在最后

RX 路径是数据面中比 TX 更难的一条路。TX 有"我决定什么时候发"的主动权，RX 只有"包来了你必须接住"的被动应变。在这一章中，我们追踪了两个平台从硬件中断到协议栈上送的完整 RX 路径，看到了两种截然不同的设计哲学：

**QCOM 的答案是解耦**——把 GRO 拆成两段，NAPI 只做轻量搬运和入队，重活（merge + flush + 协议栈上送）交给 kthread。代价是代码复杂度、更多的线程、更多的锁；收益是软中断永远不会被 GRO 的耗时操作卡住，RX 吞吐量有更大的弹性空间。

**MTK 的答案是简化**——一条 NAPI softirq 从头做到尾，KFIFO 做无锁缓冲，软件滑动窗口做 reorder。代价是 GRO 占用软中断时间片、吞吐量有天花板；收益是代码路径短、状态管理简单、不需要额外的内核线程。

两个答案没有绝对的对错——它们反映了不同芯片定位下的工程权衡。在 P2P 场景中，GO（Group Owner）和 GC（Group Client）的数据帧路径又有不同——当设备直连通信时，RX 路径的对称性会被打破。

回到开篇那句"入港分拣靠应变"——出港的包裹有流程可依，入港的包裹只能靠一套随时待命的接收系统接住。QCOM 把传送带和分拣车间拆开，传送带永远不会被一个难处理的包裹卡停；MTK 让一条流水线从头跑到底，简单但可靠。开枢纽还是驿站，终究殊途同归：让每一个入港的包裹，在对的时间被稳稳接住、正确送达。

---

**协议依据**：IEEE 802.11-2020 §10.12（AMPDU 聚合与接收端重排序）、§10.25（Block ACK 协议）、§10.23.2（EDCA/WMM AC 分类）、§9.3.2（数据帧格式）。源码路径见各代码块注释。

本文源码出自 QCOM [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0)、[qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn) 仓库，以及 MTK [gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m) 仓库。
