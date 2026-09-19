---
title: WiFi打开（二）QCOM 与 MTK 怎么把芯片叫醒？
top: 1
related_posts: true
abbrlink: 43fe377c
date: 2026-09-19 19:33:29
tags:
  - Android WiFi
categories:
  - WiFi
  - Code
---

> 从 insmod 到芯片就绪，中间经历了什么？QCOM 和 MTK 两条主流平台路径各自怎么解决同一个问题？

# 本章导读

驱动加载就像一家餐厅的「开张准备」—— insmod 是拿到营业执照（内核注册），PCIe 枚举是接通水电煤气（硬件通道），固件下载是把菜谱装进厨房设备（把代码灌进芯片 MCU），WMI 握手是厨师长和服务员对一遍菜单确认能做什么菜（能力协商）。

<!--more-->

**你将学到**

- QCOM 平台驱动加载的 6 个阶段：从 `module_init` 到 `wiphy_register`
- ICNSS2 集成 WiFi 路径（WCN6750/WCN7750）与 cnss2 PCIe 路径的差异
- MTK 平台驱动加载的完整流程：conninfra 共享框架 → wlanProbe → FW Ready 位轮询
- wlan_objmgr 三层对象模型的创建机制和组件回调模式
- WMI 握手的三个事件（Service Ready / EXT / EXT2）各自携带什么信息
- QCOM vs MTK 架构设计差异：为什么一家用「函数回调堆叠」，另一家用「消息线程 + 状态机」

**代码说明**：本文代码来自真实源码，有精简（去掉 log 语句和非核心错误处理），关键路径保留完整调用链。精简处标注 `// ...省略...`。

**系列导航**：本篇聚焦驱动加载与 SSR 崩溃恢复。下篇聚焦 Supplicant 启动与 AIDL 对接。

---

# 1 你点下 WiFi 开关后，内核怎么知道该加载哪个驱动？

在进入代码之前，先看一张全景图。这张图展示了 QCOM 平台内核驱动加载的 6 个阶段（MTK 路径详见第四节）。

![QCOM 驱动加载全景图](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-driver-loading-panoramic.svg)

接下来我们沿着 QCOM 路径，从 insmod 开始一步一步走（MTK 路径从第四节开始）。

## 1.1 先把问题拆清楚：为什么「打开 WiFi」涉及这么多模块？

如果你在桌面 Linux 上用过 `modprobe`，你会觉得这事很简单：加载一个 `.ko` 文件，驱动初始化，完事。但 Android 的 WiFi 子系统远没这么简单，因为：

1. **WiFi 芯片不是独立设备**。它挂在 PCIe / SDIO / AXI 总线上，需要先枚举总线、通电、配时钟，芯片才能「醒过来」。PCIe 链路训练本身就需要时间（几十毫秒到几百毫秒），而且可能重试。
2. **芯片有自己的 MCU**。驱动加载不等于芯片能工作——芯片内部还有一颗或多颗 MCU，需要下载固件（firmware）才能运行协议栈。ROM 里只有最小化的 boot code。
3. **Android 不是单进程系统**。内核驱动、HAL 守护进程（wpa_supplicant）、Java Framework 三层各司其职，加载顺序不能乱。Supplicant 必须在驱动注册 wiphy 之后才能通过 nl80211 与内核通信。
4. **崩溃要能恢复**。SSR（SubSystem Restart）要求驱动在芯片崩溃后能自动重启，且上层无感。这意味着恢复过程中所有数据结构必须可重建，所有状态必须可恢复。
5. **硬件资源是共享的**。在 MTK 的 combo 芯片上，WiFi、BT、FM、GPS 共享电源和时钟。打开 WiFi 之前必须确保 conninfra（连接基础设施）已经初始化完毕。

> 这就像餐厅不是只有一张桌子——你得先接通水电煤气（PCIe 枚举），装好厨房设备（固件下载），确认菜单（WMI 握手），然后前台才能开始迎客（Supplicant 就位）。任何一个环节卡住，餐厅都开不了张。

---

# 2 QCOM 路径：qcacld-3.0 是怎么一步步把芯片叫醒的？

QCOM 的驱动架构走的是「分层工厂」路线——每层有明确职责边界，通过抽象接口通信（MTK 走的则是「一体化车间」路线，对比见§5）。从顶向下看：**HDD**（Host Driver Domain，面向 Linux 内核的接口层，对接 cfg80211）→ **CDS**（Converged Data Services，子系统调度中枢）→ **WMA**（WLAN Management Application，WMI 命令封装）→ **WMI**（Wireless Module Interface，与固件通信的协议层）→ **HIF**（Host Interface，硬件总线抽象）。再加上横向的 **PLD**（Platform Driver Layer，平台硬件抽象层），构成了完整的驱动栈。

下图展示了各模块之间的调用依赖关系：

![QCOM 驱动模块关系](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-qcom-module-relationships.svg)

加载过程从 `module_init` 开始，经历了 6 个关键阶段：insmod 入口 → 平台注册 → PCIe 枚举 → 对象创建 → 固件下载与子系统启动 → WMI 握手。每个阶段都有明确的「进入条件」和「退出条件」——前一个阶段的退出条件是后一个阶段的进入条件。

## 2.1 第一阶段：`hdd_module_init()` — 从 insmod 到驱动框架初始化

一切从 `insmod qcacld-3.0.ko` 开始。内核执行 `module_init` 注册的函数：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_main.c
static int hdd_module_init(void)
{
    if (hdd_driver_load())
        return -EINVAL;
    return 0;
}
```

这个函数非常短，只是一个包装。真正的初始化链在 `hdd_driver_load()` 中展开。这个函数长约 200 行，采用了经典的「goto 错误回滚」模式——Linux 内核代码中最常见的错误处理范式：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_main.c:18333
// 精简重组版：按逻辑步骤编号，实际调用顺序和错误处理更复杂，完整版见源码
int hdd_driver_load(void)
{
    // 1. 初始化 QDF（QCOM Driver Framework）基础设施
    //    QDF 提供内存分配、链表、定时器、work queue、spinlock 等封装
    //    这是 qcacld-3.0 自己的「标准库」，所有其他模块都依赖它
    status = hdd_qdf_init();
    if (status)
        goto exit;

    // 2. 初始化 OS 接口同步机制
    //    osif_sync 是 QCOM 驱动的并发控制核心——它保证关键操作
    //    （如 probe/remove/SSR）不会被并发执行
    osif_sync_init();  // void 函数，无错误检查
    status = osif_driver_sync_create_and_trans(&driver_sync);  // 创建驱动同步对象
    if (status)
        goto sync_deinit;

    // 3. 分配 CDS 上下文，注册调试回调，初始化 trace 系统
    //    CDS（Converged Data Services）是所有子系统的调度中枢
    status = hdd_init();
    if (status)
        goto trans_stop;

    // 4. 初始化组件回调机制
    //    每个 UMAC 组件（scan、regulatory、MLME、crypto 等）在此时注册回调
    status = hdd_component_cb_init();
    if (status)
        goto hdd_deinit;
    status = hdd_component_init();
    if (status)
        goto comp_cb_deinit;

    // 5. 创建 wakelock，防止系统在初始化过程中进入深度睡眠
    qdf_wake_lock_create(&wlan_wake_lock, "wlan");

    // 6. 连接参数初始化
    hdd_set_conparam(con_mode);

    // 7. 初始化平台驱动层（PLD）
    //    分配 pld_context，建立与 cnss2/icnss2 的通信桥梁
    status = pld_init();
    if (status)
        goto wakelock_destroy;

    // 8. 向平台层传递驱动模式
    pld_set_mode(con_mode);

    // 9. 向平台层注册 WLAN 驱动（含重试逻辑）
    status = hdd_register_driver_retry();
    if (status)
        goto pld_deinit;

    // 10. 创建 /sys/kernel/wlan state_control 节点
    wlan_hdd_state_ctrl_param_create();
    // ...省略...
    return 0;

    // 错误回滚（反向顺序）
unregister_driver:
    wlan_hdd_unregister_driver();
pld_deinit:
    pld_deinit();
wakelock_destroy:
    qdf_wake_lock_destroy(&wlan_wake_lock);
comp_deinit:
    hdd_component_deinit();
comp_cb_deinit:
    hdd_component_cb_deinit();
    // ...省略...
}
```

在这个 goto 回滚链条中，有三个步骤是整个驱动能否继续走下去的命脉。最先执行的是 `hdd_qdf_init()`——QDF（QCOM Driver Framework）是 qcacld-3.0 自带的「标准库」，封装了内存分配（`qdf_mem_malloc`）、定时器（`qdf_timer`）、work queue（`qdf_work`）和 spinlock（`qdf_spinlock`），让上层代码可以在不同 OS（Linux/Windows/RTOS）间移植而无需改动。紧接着 `hdd_init()` 调用 `cds_init()` 分配 CDS 上下文——CDS 是 QCOM 驱动框架的「调度中枢」，所有子系统（SME、WMA、PE）的启动、停止和恢复都由它协调。如果这一步因为内存不足返回 `-ENOMEM`，整个加载就此中止。最后一关是 `hdd_register_driver_retry()`，它通过 `pld_register_driver()` 向平台层注册驱动回调。平台层可能还没准备好——此时返回 `-EAGAIN`，驱动不会立即放弃，而是 sleep `HDD_PLD_REGISTER_FAIL_SLEEP_DURATION` 毫秒后重试，最多重试 `HDD_MAX_PLD_REGISTER_RETRY` 次。这种带退避的重试机制是驱动加载可靠性的第一道防线。

## 2.2 第二阶段：`pld_register_driver()` — 向平台层注册，等 PCIe 设备出现

`hdd_register_driver_retry()` 的核心是调用 `pld_register_driver()`。这是 QCOM 驱动和平台层之间的「婚约」——驱动说「这是我的 probe/remove/suspend/resume 回调，有我的设备就叫我」：

```c
// qcacld-3.0/core/pld/src/pld_common.c
int pld_register_driver(struct pld_driver_ops *ops)
{
    // 保存驱动操作回调（probe / remove / suspend / resume / idle_shutdown / reinit）
    pld_ctx->ops = ops;

    // 向所有支持的总线类型注册
    // 实际走哪条总线由设备树和硬件决定，但驱动一次性全部注册
    status = pld_pcie_register_driver();           // PCIe（独立 WiFi 芯片）
    if (status) goto pcie_fail;

    status = pld_snoc_register_driver();           // SNOC（集成 WiFi，如 WCN6750）
    if (status) goto snoc_fail;

    status = pld_sdio_register_driver();           // SDIO
    if (status) goto sdio_fail;

    status = pld_snoc_fw_sim_register_driver();    // SNOC FW 仿真
    if (status) goto snoc_fw_sim_fail;

    status = pld_pcie_fw_sim_register_driver();    // PCIe FW 仿真
    if (status) goto pcie_fw_sim_fail;

    status = pld_usb_register_driver();            // USB
    if (status) goto usb_fail;

    status = pld_ipci_register_driver();           // IPCI（模拟/测试）
    if (status) goto ipci_fail;

    return 0;

    // 级联回滚：哪个注册失败了，就把之前成功注册的逐个注销
    // ...省略...
}
```

`pld_register_driver` 不区分总线类型，一次性向所有支持的总线注册。每一种总线注册失败都会触发级联回滚——goto 标签组合实现「任何一步失败，之前成功注册的全部撤销」，这是内核代码的标志性错误处理模式。

不过，级联回滚只回答了「失败之后怎么办」，还没回答一个更根本的问题——这一刻驱动到底在做什么？这里有个容易误解的地方：此刻是「驱动注册」而非「设备发现」——还没有任何芯片被访问到。驱动只是在说「我准备好了，有匹配我的设备就叫醒我」。真正的设备发现由 cnss2 平台驱动在 PCIe 枚举时完成，而 qcacld-3.0 在 `pld_register_driver` 这步只是把 probe/remove/suspend/resume 等回调交给了平台层，然后就去睡了。

## 2.3 第三阶段：`cnss_pci_probe()` — PCIe 设备上电和 MHI 通道建立

当 Linux PCI 子系统枚举到 WiFi 设备（通过 Vendor ID / Device ID 匹配 `cnss_pci_id_table`），cnss2 的 `cnss_pci_probe()` 被调用。这是从「驱动已注册」到「芯片已通电」的关键转折：

`cnss_pci_probe()` 的完整流程分为三个阶段，先看全景再看关键代码：

![cnss_pci_probe 流程](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-cnss_pci_probe%E6%B5%81%E7%A8%8B.svg)

关键代码（精简为阶段 B 的核心步骤，完整版见源码）：

```c
// platform/cnss2/pci.c:8819-8976
// 精简说明：仅展示阶段 B 的核心步骤，阶段 A/C 和错误回滚见上方流程图
static int cnss_pci_probe(struct pci_dev *pci_dev,
                          const struct pci_device_id *id)
{
    // ... 阶段 A：上电、SMMU、SSR 注册（见流程图）...

    // ===== 阶段 B：总线和通道建立 =====

    // 使能 PCI 总线（BAR 空间、DMA mask、bus mastering）
    ret = cnss_pci_enable_bus(pci_priv);
    if (ret) goto dereg_pci_event;

    // 使能 MSI 中断（比传统 INTx 更多向量、更低延迟）
    ret = cnss_pci_enable_msi(pci_priv);
    if (ret) goto disable_bus;

    // 注册 MHI —— Host-Firmware 的双向通信协议
    // MHI 定义了 channel 概念：channel 0 = WMI 命令，channel 1 = WMI 事件
    ret = cnss_pci_register_mhi(pci_priv);
    if (ret) goto disable_msi;

    // ===== 阶段 C：设备特定配置 =====

    switch (pci_dev->device) {
    case QCA6174_DEVICE_ID:
        pci_read_config_word(pci_dev, QCA6174_REV_ID_OFFSET,
                             &pci_priv->revision_id);
        break;
    case QCA6290_DEVICE_ID ... FIG_DEVICE_ID:
        // WLAON/timer/wake_gpio 初始化（QCA6490/KIWI/MANGO 等共享）
        cnss_pci_set_wlaon_pwr_ctrl(pci_priv, false, false, false);
        timer_setup(&pci_priv->dev_rddm_timer, cnss_dev_rddm_timeout_hdlr, 0);
        cnss_pci_wake_gpio_init(pci_priv);
        break;
    default:
        ret = -ENODEV;
        goto unreg_mhi;
    }

    cnss_pci_config_regs(pci_priv);
    set_bit(CNSS_PCI_PROBE_DONE, &plat_priv->driver_state);
    return 0;

    // 错误回滚（反向顺序）
unreg_mhi:     cnss_pci_unregister_mhi(pci_priv);
disable_msi:   cnss_pci_disable_msi(pci_priv);
disable_bus:   cnss_pci_disable_bus(pci_priv);
dereg_pci_event: cnss_dereg_pci_event(pci_priv);
    // ... 更多回滚标签 ...
}
```

这里有几个决策点值得展开。`cnss_dev_specific_power_on()` 表面上是「通电」，实际是一整套上电时序：regulator 使能的顺序、clock 配置的频率、GPIO 的复位释放时机，一个都不能错。QCA6490 和 KIWI 的 regulator 列表不同、拉高拉低的时序也不同，这些细节定义在设备树的 `qcom,wlan-ramdump-dynamic` 等属性中。通电之后，`cnss_pci_init_smmu()` 建立 IOMMU 映射（QCOM 称之为 DART，即 Distributed Address Range Translation）。没有这一步，芯片的 DMA 引擎无法将数据写到 Host 内存的正确物理地址——固件下载会直接失败，因为固件数据本身就需要通过 DMA buffer 从 Host 传输到芯片。接着 `cnss_pci_register_mhi()` 打开 Host-Firmware 的双向通道：MHI（Modem Host Interface）在 PCIe 之上定义了 channel 概念，channel 0 走 WMI 命令、channel 1 走 WMI 事件，后续所有 Host 与固件的对话都经过这两个通道。

通电、DMA 映射、MHI 通道这三步，把芯片从「死硅片」拉成了「能对话的设备」。但 QCOM 还多做了一步提前为失败埋的伏笔——`cnss_register_subsys()` 向 Linux 内核的 SSR 框架注册：这不是为了当前加载，而是为未来的崩溃做准备，当芯片出问题时，SSR 框架自动调用 cnss2 的 shutdown 回调，触发 Level 2 恢复流程。

#### 2.3.1 PCIe 枚举的重试机制：链路训练不一定一次成功

在 `cnss_pci_probe()` 被调用之前，还有一个步骤——`cnss_pci_enumerate()`，它负责初始化 PCIe Root Complex 并触发链路训练：

```c
// platform/cnss2/pci.c:9060-9101
static int cnss_pci_enumerate(struct cnss_plat_data *plat_priv,
                              u32 rc_num)
{
    int ret, retry = 0;

    // 1. QCA6490：设置最大链路速度为 Gen2 (5.0 GT/s)
    //    原因：QCA6490 在 Gen3 速度下可能出现链路不稳定（:9069-9074）
    if (plat_priv->device_id == QCA6490_DEVICE_ID) {
        ret = cnss_pci_set_max_link_speed(plat_priv->bus_priv, rc_num,
                                          PCI_EXP_LNKSTA_CLS_5_0GB);
        if (ret && ret != -EPROBE_DEFER)
            cnss_pr_err("Failed to set max PCIe RC%x link speed to Gen2, err = %d\n",
                        rc_num, ret);
    } else {
        // 2. 其他设备：降级 RC 速度（:9076）
        cnss_pci_downgrade_rc_speed(plat_priv, rc_num);
    }

    // 3. 使能 PCIe RC 并触发链路训练（:9080-9094）
    //    使用 goto retry 模式而非 for 循环
retry:
    ret = _cnss_pci_enumerate(plat_priv, rc_num);
    if (ret) {
        if (ret == -EPROBE_DEFER) {
            // RC 驱动未就绪，向上返回让 probe 延迟
            cnss_pr_dbg("PCIe RC driver is not ready, defer probe\n");
            goto out;
        }
        cnss_pr_err("Failed to enable PCIe RC%x, err = %d\n", rc_num, ret);
        if (retry++ < LINK_TRAINING_RETRY_MAX_TIMES) {
            cnss_pr_dbg("Retry PCI link training #%d\n", retry);
            goto retry;
        }
    }

    plat_priv->rc_num = rc_num;

out:
    return ret;
}
```

链路训练的失败分两种：`-EPROBE_DEFER` 意味着 RC 驱动还没准备好，等内核重试即可；其他错误（比如 link down）可能是硬件问题，但也值得再试一次——热启动后的链路训练经常第一次失败、第二次成功，这跟 PCB 信号完整性和时钟稳定时间有关。驱动还主动将速度限制在 Gen2，不是因为不支持 Gen3，而是因为某些早期芯片在该速率下不稳定。这种「降级保稳定」的策略在驱动工程中很常见——宁可用慢一点的速度换来可靠的连接。重试次数 `LINK_TRAINING_RETRY_MAX_TIMES` 通常设为 3，使用 `goto retry` 直接重试，不额外 sleep，总耗时在 5-10ms 内。

> **PCIe 初始化流程速览**
>
> | 步骤           | 目的                                             | 耗时   |
> | -------------- | ------------------------------------------------ | ------ |
> | `power_on`     | regulator + clock + GPIO 复位释放                | 5-20ms |
> | `init_smmu`    | IOMMU/DART 映射（芯片 DMA 访问 Host 内存的前提） | 1-3ms  |
> | `enable_bus`   | BAR 空间 + DMA mask + bus mastering              | 2-5ms  |
> | `enable_msi`   | MSI 中断向量分配（替代传统 INTx）                | 1-3ms  |
> | `register_mhi` | MHI 通道注册（WMI 命令/事件的传输层）            | 3-10ms |

## 2.4 第四阶段：`__hdd_soc_probe()` → `hdd_wlan_startup()` — HDD 上下文创建和模块启动

cnss2 做完硬件初始化后，通过 PLD 的回调触发 qcacld-3.0 的 probe。这是从「芯片已通电」到「驱动数据结构已建立」的关键阶段：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_driver_ops.c
static int __hdd_soc_probe(struct device *dev, void *bdev,
                           const struct hif_bus_id *bid,
                           enum qdf_bus_type bus_type)
{
    // 1. 获取加载锁，防止并发 probe
    hdd_soc_load_lock();

    // 2. 标记 load 进行中，重置不良状态标志
    cds_set_load_in_progress(true);
    cds_set_driver_in_bad_state(false);
    cds_set_recovery_in_progress(false);

    // 3. 初始化 QDF 上下文（设备、总线、驱动句柄）
    status = hdd_init_qdf_ctx(dev, bdev, bus_type, bid);

    // 4. 初始化 DMA mask（32位或64位取决于芯片能力）
    status = hdd_init_dma_mask(dev, bus_type);

    // 5. 创建 HDD 上下文（分配 wiphy、解析 INI、创建 psoc 对象）
    hdd_ctx = hdd_context_create(dev);

    // 6. 数据通路预分配初始化
    ucfg_dp_prealloc_init(hdd_ctx);  // 实际调用含 (struct cdp_ctrl_objmgr_psoc *) 类型转换

    // 7. 【核心】启动 WLAN 子系统
    status = hdd_wlan_startup(hdd_ctx);

    // 8. 创建虚拟设备（vdev）
    status = hdd_psoc_create_vdevs(hdd_ctx);

    // 9. 标记驱动已加载，通知等待者（必须在 thermal 注册之前）
    probe_fail_cnt = 0;                            // 重置连续失败计数
    cds_set_driver_loaded(true);
    cds_set_load_in_progress(false);               // 清除加载中标志

    // 10. 注册 thermal mitigation 回调
    hdd_thermal_mitigation_register(hdd_ctx, dev);

    hdd_soc_load_unlock();
    return 0;

    // 错误回滚
wlan_exit:
    hdd_wlan_exit(hdd_ctx);
hdd_context_destroy:
    hdd_context_destroy(hdd_ctx);
    // ...省略...
}
```

这个 probe 函数用一对互斥锁 `hdd_soc_load_lock()` / `hdd_soc_load_unlock()` 把自己包了起来，保证同一个 SoC 不会被并发 probe——这对 SSR 恢复场景至关重要：如果上一次崩溃的 reinit 还没跑完，新的 probe 必须排队等待。锁内的关键操作各司其职：`hdd_context_create()` 是工作量最大的单一函数，从分配 wiphy 到解析 INI 到创建 psoc 对象，一键完成（详见 2.4.1）；`hdd_wlan_startup()` 则是所有子系统的启动协调器，依次拉起 HIF、CDS、WMA、SME，最后通过 `wiphy_register()` 向 cfg80211 宣告「我准备好了」。

正常路径到此收尾，但锁还守护着一条防御底线——如果连续 probe 失败次数超过 `SSR_MAX_FAIL_CNT`，驱动调用 `QDF_BUG()` 直接触发 kernel panic，宁可用系统重启来打断不可恢复的硬件错误累积，也不要默默地在半死状态中继续运行。

#### 2.4.1 深入 `hdd_context_create()`：一个函数干了多少活？

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_main.c
struct hdd_context *hdd_context_create(struct device *dev)
{
    struct hdd_context *hdd_ctx;
    struct wiphy *wiphy;

    // 1. 向 cfg80211 注册，分配 wiphy + hdd_context
    //    wiphy 是 cfg80211 框架的核心数据结构，内核用它表示一个无线物理设备
    //    它的能力字段（支持的频段、带宽、加密方式、接口类型）来自 INI 文件
    hdd_ctx = hdd_cfg80211_wiphy_alloc();  // 无参，返回 struct hdd_context *，内部调用 wiphy_new()
                                           // 通过 wiphy_priv 嵌入 hdd_context
    if (!hdd_ctx)
        goto err;

    wiphy = hdd_ctx->wiphy;

    // 2. 创建 psoc 空闲超时 work（用于自动关闭不活动的芯片）
    status = qdf_delayed_work_create(&hdd_ctx->psoc_idle_timeout_work,
                                     hdd_psoc_idle_timeout_callback, hdd_ctx);
    if (QDF_IS_STATUS_ERROR(status))
        goto wiphy_free;

    // 3. 初始化 PM notifier（电源管理通知链）
    hdd_pm_notifier_init(hdd_ctx);

    // 4. 从 WLAN_INI_FILE 解析配置文件
    //    这是数百个参数的 INI 文件，控制整个驱动的运行时行为
    //    例如：gEnableFwSelfRecovery、gMaxVdevCount、gCountryCodePriority 等
    hdd_ctx->config = qdf_mem_malloc(sizeof(struct hdd_config));
    if (!hdd_ctx->config)
        goto err_free_work;
    status = cfg_parse(WLAN_INI_FILE);
    if (QDF_IS_STATUS_ERROR(status))
        goto err_free_config;

    // 5. 创建 psoc 对象（wlan_objmgr 层次化对象模型的根节点）
    status = hdd_objmgr_create_and_store_psoc(hdd_ctx, DEFAULT_PSOC_ID);
    if (status)
        goto err_free_config;

    // 6. 初始化配置参数
    hdd_cfg_params_init(hdd_ctx);

    // 7. 应用 INI 覆盖（通过 /sys/kernel/wlan 接口覆盖的参数）
    hdd_override_ini_config(hdd_ctx);

    // 8. 初始化上下文（workqueue、netlink 服务、trace levels 等）
    status = hdd_context_init(hdd_ctx);
    if (status)
        goto psoc_destroy;

    // 9. 初始化 netlink 服务（用于用户空间与驱动通信）
    //    在 EPPING 模式下跳过
    hdd_init_netlink_services(hdd_ctx);

    // 10. 初始化 SAR（Specific Absorption Rate）timer
    wlan_hdd_sar_timers_init(hdd_ctx);

    return hdd_ctx;

psoc_destroy:
    hdd_objmgr_release_and_destroy_psoc(hdd_ctx);
err_free_config:
    qdf_mem_free(hdd_ctx->config);
err_free_work:
    qdf_delayed_work_destroy(&hdd_ctx->psoc_idle_timeout_work);
wiphy_free:
    wiphy_free(wiphy);
    // ...省略...
}
```

**三层横向：**

- `hdd_cfg80211_wiphy_alloc()` 向 cfg80211 框架注册，分配 wiphy。这是驱动对内核的「自我介绍」——wiphy 的能力字段（`bands`、`iface_combinations`、`cipher_suites` 等）决定了内核能看到什么。这些能力先初始化为默认值，在 WMI 握手完成后会被固件的能力信息覆盖。
- `cfg_parse(WLAN_INI_FILE)` 解析 INI 文件。这个文件的路径通常是 `/vendor/etc/wifi/WCNSS_qcom_cfg.ini`，包含数百个配置项。有些项目在运行时可以通过 `/sys/kernel/wlan/` 下的 sysfs 节点动态修改。
- `hdd_objmgr_create_and_store_psoc()` 创建 wlan_objmgr 的 psoc 对象。创建过程会遍历所有 UMAC 组件（scan、regulatory、MLME、crypto、DFS 等），依次调用每个组件的 `psoc_create_handler`。每个组件在 handler 中分配自己的私有数据并挂到 psoc 上。

概括来说，`hdd_context_create()` 用一个函数完成了三层横向工作——内核注册（cfg80211）、配置解析（INI）、对象创建（objmgr）——每层都不可跳过。这种「横向三层、纵向一段」的结构是理解 QCOM 驱动设计的关键：三层工作一气呵成，读完这个函数，你就读懂了 QCOM 驱动骨架的一半。

> 到这里，PCIe 通道已经打通（接通水电），平台回调机制已经就位（电路铺设完毕），对象管理框架已经建好（厨房布局完成）。接下来是最关键的一步——把菜谱装进厨房设备，也就是固件下载和子系统启动。这一步如果失败，整个芯片就是个昂贵的硅片镇纸。

## 2.5 第五阶段：`hdd_wlan_start_modules()` — 打开 HIF、启动 CDS、下载固件

`hdd_wlan_startup()` 的核心是 `hdd_wlan_start_modules()`。这是整个加载过程中最长、最复杂的一个函数。它管理了一个状态机：`DRIVER_MODULES_CLOSED → DRIVER_MODULES_ENABLED`：

先看全景：

![hdd_wlan_start_modules 流程](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-hdd_wlan_start_modules%E6%B5%81%E7%A8%8B.svg)

关键代码（精简为核心步骤）：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_main.c
// 精简说明：省略了 IPA 配置、NAN/SR 回调注册等非核心步骤
int hdd_wlan_start_modules(struct hdd_context *hdd_ctx, bool reinit)
{
    int status;

    switch (hdd_ctx->driver_status) {
    case DRIVER_MODULES_UNINITIALIZED: // fall through
    case DRIVER_MODULES_CLOSED: break;
    default: QDF_DEBUG_PANIC("Unknown driver state:%d", hdd_ctx->driver_status);
             return -EINVAL;
    }

    // ===== 阶段 A：电源和硬件通道 =====
    if (!reinit) {
        status = pld_power_on(qdf_dev->dev);  // 1 参数 device，源码：pld_common.c:1847
        if (status) goto release_lock;
    }
    status = hdd_hif_open(qdf_dev->dev, qdf_dev->drv_hdl, qdf_dev->bid,
                       qdf_dev->bus_type, HIF_ENABLE_TYPE_PROBE);
    // 5 参数（device, drv_hdl, bid, bus_type, enable_type），精简展示
    ol_cds_init(qdf_dev, hif_ctx);  // BMI 初始化（2 参数，源码：bmi.c:536）

    // ===== 阶段 B：子系统打开 =====
    // CDS 内部按依赖顺序：WMA open → SME open → PE open
    // 每个子系统的 open 回调中注册 WMI 事件处理器
    status = cds_open(hdd_ctx->psoc);  // 1 参数，源码：wlan_hdd_main.c:4634
    status = cds_dp_open(hdd_ctx->psoc);  // 1 参数，源码：wlan_hdd_main.c:4661

    // ===== 阶段 C：注册和使能 =====
    status = hdd_register_cb(hdd_ctx);
    hdd_register_notifiers(hdd_ctx);
    status = cds_pre_enable();  // 无参，返回 QDF_STATUS，源码：cds_api.c:1101
    status = hdd_configure_cds(hdd_ctx);    // 完成 WMI 握手 + 配置运行时参数
    hdd_enable_power_management(hdd_ctx);

    hdd_ctx->driver_status = DRIVER_MODULES_ENABLED;
    return 0;

    // 错误回滚（反向顺序）
deconfigure_cds: /* ... */ ;
release_lock:    return status;
}
```

**启动协调：**

- `hdd_hif_open()` 打开主机接口层，配置 DMA 通道和 credit 分配。HIF 打开成功后，Host 可以通过 PCIe 向芯片发送命令。但此时芯片只有 ROM code，只接受 BMI 协议的命令。
- `ol_cds_init()` 初始化 BMI 上下文。BMI 是一个简化的协议：Host 向芯片发送 BMI 命令（如「下载固件到地址 0xXXXXXXXX」），芯片的 ROM code 处理这些命令，把固件数据写入指定的内存地址。
- `cds_open()` 是 QCOM 驱动框架的核心入口。内部调用链为：WMA open → SME open → PE open → UMAC open。每个子系统的 open 过程中会调用 `wmi_unified_register_event_handler()` 注册自己的 WMI 事件处理器。
- `cds_pre_enable() + hdd_configure_cds()` 完成最后的使能步骤：配置 PHY 模式（2.4G / 5G / 6G）、设置国家码、使能省电策略、配置 TDLS 参数等。

#### 2.5.1 子模块启动顺序为什么这么重要？

QCOM 驱动的 `cds_open()` 内部有一个严格的依赖链：**WMA（WLAN Management Application）必须在 SME（Session Management Entity）之前打开**，因为 SME 需要依赖 WMA 提供的 WMI 通道来给固件发送命令。而 **SME 必须在 PE（Protocol Engine）之前打开**，因为 PE 的会话管理依赖 SME 的连接状态机。

如果顺序出错（例如 PE 在 WMA 之前初始化），PE 会尝试通过 WMI 发送命令，但 WMI 通道的句柄还是 NULL——直接触发空指针异常。这种依赖不是通过显式的接口保证的，而是通过代码中的调用顺序隐式保证的。这是 QCOM 驱动架构的一个弱点：依赖关系不透明，新手很容易在添加新模块时搞错顺序。

打个比方来理解这种隐式依赖关系——

> 这就像餐厅后厨，你必须先接通燃气（HIF），再点火试灶（BMI），然后才能开始备菜（CDS 子系统初始化）。燃气没通就去点火，当然点不着——但更糟的是：如果 CDS 在 HIF 之前初始化，它会尝试发送 WMI 命令，而通道还没建好，直接触发 kernel panic。

## 2.6 第六阶段：WMI 握手 — Host 和固件的「菜单对账」

当 `cds_open()` 执行后，WMI 子系统初始化完毕。但此时 Host 和 Firmware 还没有确认过「对方是谁、能做什么」。WMI 握手就是这一步。

![WMI 握手时序](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-wmi-handshake.svg)

发生握手的代码位置在 init_deinit 模块中。在 `cds_open()` 的过程中，`init_deinit_register_tgt_psoc_ev_handlers()` 被调用来注册 WMI 事件处理器：

```c
// qca-wifi-host-cmn/target_if/init_deinit/src/init_event_handler.c
QDF_STATUS init_deinit_register_tgt_psoc_ev_handlers(
    struct wlan_objmgr_psoc *psoc)
{
    // 获取 WMI 句柄（源码中通过两步调用实现）
    tgt_hdl = wlan_psoc_get_tgt_if_handle(psoc);
    wmi_handle = target_psoc_get_wmi_hdl(tgt_hdl);

    // 注册 5 个核心 WMI 事件处理器，每个对应一种握手阶段
    wmi_unified_register_event_handler(
        wmi_handle, wmi_service_ready_event_id,
        init_deinit_service_ready_event_handler,
        WMI_RX_WORK_CTX);

    wmi_unified_register_event_handler(
        wmi_handle, wmi_service_ready_ext_event_id,
        init_deinit_service_ext_ready_event_handler,
        WMI_RX_WORK_CTX);

    wmi_unified_register_event_handler(
        wmi_handle, wmi_service_available_event_id,
        init_deinit_service_available_handler,
        WMI_RX_UMAC_CTX);  // 注意：此 handler 使用 UMAC 上下文，非 WORK 上下文

    wmi_unified_register_event_handler(
        wmi_handle, wmi_ready_event_id,
        init_deinit_ready_event_handler,
        WMI_RX_WORK_CTX);

    wmi_unified_register_event_handler(
        wmi_handle, wmi_service_ready_ext2_event_id,
        init_deinit_service_ext2_ready_event_handler,
        WMI_RX_WORK_CTX);

    return QDF_STATUS_SUCCESS;
}
```

五个事件按优先级分三层来理解：

- **第一层（能力级）**：`WMI_SERVICE_READY_EVENTID` 是固件醒来后说的第一句话，它的 payload 里藏着一个巨大的 WMI service bitmap：每一位代表一项固件能力（`WMI_SERVICE_SCAN_CONFIG_PER_CHANNEL`、`WMI_SERVICE_STA_PWRSAVE`、`WMI_SERVICE_TDLS` 等数百种），Host 驱动据此决定后续可以发送哪些 WMI 命令。这份位图不是装饰——Host 侧把 Service Ready 事件里的位图存进 `wmi_service_bitmap`（`wmi_save_service_bitmap()`，`wmi_unified_api.c:1753`），此后每次封装 WMI 命令前都先调 `wmi_service_enabled()`（`wmi_unified_api.c:1792`）查位：位被置 1 的命令才允许下发，未置位则静默跳过或走降级路径。以 `WMI_SERVICE_SCAN_CONFIG_PER_CHANNEL` 为例，该位置位时扫描命令的 channel_list TLV 才会在低 20 位频率之上再填高 12 位的信道 flags，未置位时 Host 只能下发纯频率（`wmi_unified_tlv.c:80-88`）——一个位就决定了扫描命令的封装格式。紧接着的 `WMI_SERVICE_READY_EXT_EVENTID` 携带 HW mode 列表，告诉 Host 芯片是双频同时工作（`WMI_HW_MODE_DBS`，两个 MAC 各自管一个频段）还是单 MAC 被动切换（`WMI_HW_MODE_SBS_PASSIVE`）。
- **第二层（健康级）**：`WMI_READY_EVENTID` 的 `status` 字段如果非零，说明固件在初始化过程中摔了跤（内存分配失败、版本不匹配等），Host 立即触发 SSR 恢复。
- **第三层（调度级）**：`WMI_RX_WORK_CTX` 和 `WMI_RX_UMAC_CTX` 决定了事件回调在哪个上下文中执行：WORK 上下文跑在 WMI 专用 work queue 上（适合耗时操作），UMAC 上下文则可以直接访问 UMAC 数据结构。

#### 2.6.1 WMI 握手为什么需要 EXT 和 EXT2？

早期的 QCOM 固件（如 QCA6174 时代）只有一个 `WMI_SERVICE_READY_EVENTID`，所有信息打包在一个事件中。但随着芯片能力的膨胀（WiFi 6/6E/7），一个事件的固定 payload 大小（通常几千字节）不够用了。

解决方案是拆分信息到三个事件中：

- Service Ready：基础信息（FW 版本、ABI 版本、服务位图、vdev/peer 限额）。
- EXT：HW mode 列表、MAC/PHY 能力（如支持的频段、MCS 速率集、beamforming 能力）。
- EXT2：6GHz 频段支持、MLO（Multi-Link Operation，WiFi 7 的关键特性）能力、AFC（Automated Frequency Coordination）支持等。

如果 INI 配置了 `wmi_service_ext_msg = 1`，Host 在收到 Service Ready 后会启动一个 timer（`service_ready_ext_timer`）等待 EXT 事件。如果 timer 超时还没收到，Host 会降级为非 EXT 模式——这意味着丧失了部分能力（如 6GHz 频段不可用）。

#### 2.6.2 QMI 固件下载协议：cnss2 是怎么把固件喂给芯片的？

cnss2 的固件下载不是简单的 `memcpy`，而是通过 QMI（Qualcomm Messaging Interface）协议分段传输。QMI 是 QCOM 芯片（不仅是 WiFi，还包括 modem、GPS 等）的通用 Host-Firmware 通信协议。在 cnss2 中，QMI 运行在 MHI 通道之上。

固件下载的核心函数在 `platform/cnss2/qmi.c` 中。以 BDF（Board Data File）下载为例：

```c
// platform/cnss2/qmi.c
int cnss_wlfw_bdf_dnld_send_sync(struct cnss_plat_data *plat_priv)
{
    struct qmi_txn txn;
    void *bdf_data;
    u32 bdf_size;
    int ret;

    // 1. 获取 BDF 文件名
    //    根据芯片型号和板级信息确定文件名
    //    例如：bdwlan.bin → bdwlan.e05 → bdwlan.b090
    //    支持文件名回退机制（fallback chain）
    cnss_get_bdf_file_name(plat_priv, &bdf_name);

    // 2. 读取 BDF 文件内容
    //    对于 REGDB 类型的 BDF：使用 cnss_request_firmware_direct()
    //    对于其他类型：使用 cnss_request_firmware_update_timer()
    //       └── firmware_request_nowarn() → 标准 Linux firmware API
    //       └── 同时启动 fw_boot_timer（CNSS_TIMEOUT_FW_LOAD ms）
    ret = cnss_request_firmware_update_timer(fw_entry, ...);
    bdf_data = fw_entry->data;
    bdf_size = fw_entry->size;

    // 3. 【核心】通过 QMI 分段传输 BDF 数据
    //    每个 segment 不超过 QMI_WLFW_MAX_DATA_SIZE_V01 字节
    offset = 0;
    while (offset < bdf_size) {
        seg_size = min(bdf_size - offset,
                       QMI_WLFW_MAX_DATA_SIZE_V01);

        // 构造 QMI 请求消息
        req.bdf_total_size = bdf_size;
        req.bdf_seg_offset = offset;
        req.bdf_seg_size = seg_size;
        memcpy(req.bdf_seg_data, bdf_data + offset, seg_size);

        // 发送 QMI_WLFW_BDF_DOWNLOAD_REQ_V01 消息（三步 QMI 调用）
        ret = qmi_txn_init(&qmi_hdl, &txn,
            QMI_WLFW_BDF_DOWNLOAD_RESP_V01, NULL);
        ret = qmi_send_request(&qmi_hdl, &txn,
            QMI_WLFW_BDF_DOWNLOAD_REQ_V01,
            &req, sizeof(req));
        ret = qmi_txn_wait(&txn, QMI_WLFW_TIMEOUT_JF);  // JF = Jiffies timeout

        if (resp.resp.result != QMI_RESULT_SUCCESS)
            return -EIO;

        offset += seg_size;
    }

    // 4. BDF 下载完成后处理
    //    HW_XPA 配置、CalDB 配置、Radio OFF 配置
    if (resp.host_bdf_data_valid)
        // 内联处理：检查 host_bdf_data 中的
        //   HW_XPA / Radio OFF / CBC 配置标志位
        //   源码：platform/cnss2/qmi.c:1239-1253

    return 0;
}
```

QMI 消息格式定义清晰：每个消息都有唯一的消息 ID（如 `QMI_WLFW_BDF_DOWNLOAD_REQ_V01`）、TLV 编码的 payload 和事务 ID，请求与响应必须一一对应。整个 QMI 调用遵循三步模式：`qmi_txn_init()` 初始化事务 → `qmi_send_request()` 编码并发送请求 → `qmi_txn_wait()` 等待固件回复——三步缺一不可。

BDF（Board Data File）不是可执行代码，而是板级校准数据——包括每个信道的发射功率补偿、接收灵敏度校准、天线切换表等。没有正确的 BDF，芯片的 RF 性能会严重下降。为了保证即使 OEM 未提供定制 BDF 芯片也能工作，QCOM 设计了一个文件名回退（fallback chain）机制：先尝试精确匹配（如 `bdwlan.e05`），失败后回退到通用版本（`bdwlan.bin`），再失败则使用默认 REGDB 文件（`REGDB_FILE_NAME`）。

除了 BDF，QMI 还负责传输：

- **M3 信息**（`QMI_WLFW_M3_INFO_REQ_V01`）：告诉固件 M3（Modem Memory Management）物理内存的基地址和大小。这是固件运行所需的关键内存区域。
- **WLAN 配置**（`QMI_WLFW_WLAN_CFG_REQ_V01`）：携带 Host 驱动版本（用于兼容性检查）、CE（Copy Engine）配置、服务管道配置、shadow register 配置、MSI 配置、芯片名称。
- **WLAN 模式**（`QMI_WLFW_WLAN_MODE_REQ_V01`）：告诉固件进入什么模式——CNSS_MISSION（正常模式）、CNSS_FTM（工厂测试模式）、CNSS_WALTEST（WAL 测试模式）、CNSS_CCPM（CCPM 模式）、CNSS_OFF（关闭模式，SSR 恢复时使用）。

## 2.7 对象模型：wlan_objmgr 的 psoc → pdev → vdev → peer 四层体系

QCOM 驱动的一个核心设计是 **wlan_objmgr**（Wireless LAN Object Manager）。它定义了层次化的对象模型，将物理芯片到逻辑连接的关系用树状结构表达：

![wlan_objmgr 四层对象树](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-objmgr-tree.svg)

对象创建时有一个关键机制：**组件回调**。每当创建 psoc/pdev/vdev 时，wlan_objmgr 遍历已注册的所有 UMAC 组件（scan、regulatory、MLME、crypto、DFS、TDLS、NAN 等，最多 `WLAN_UMAC_MAX_COMPONENTS` 个），依次调用每个组件的 `create_handler`。

以 psoc 创建为例：

```c
// qca-wifi-host-cmn/umac/cmn_services/obj_mgr/src/wlan_objmgr_psoc_obj.c
struct wlan_objmgr_psoc *wlan_objmgr_psoc_obj_create(
    uint32_t phy_version, WLAN_DEV_TYPE dev_type)
{
    uint8_t id;
    struct wlan_objmgr_psoc *psoc = NULL;
    wlan_objmgr_psoc_create_handler handler;
    wlan_objmgr_psoc_status_handler stat_handler;
    QDF_STATUS obj_status;
    void *arg;

    // 分配并初始化 psoc 对象
    psoc = qdf_mem_malloc(sizeof(*psoc));
    if (!psoc)
        return NULL;

    psoc->obj_state = WLAN_OBJ_STATE_ALLOCATED;
    qdf_spinlock_create(&psoc->psoc_lock);
    // 初始化默认参数：pdev_count = 0, vdev_count = 0, peer_count = 0
    // max_vdev_count, max_peer_count 从 INI 配置读取

    // 【核心】两阶段创建模型：
    //   阶段 1：遍历所有 UMAC 组件，将每个 handler 的返回值存入 psoc->obj_status[id]
    //   阶段 2：通过 wlan_objmgr_psoc_object_status() 遍历 obj_status[] 做聚合判断
    for (id = 0; id < WLAN_UMAC_MAX_COMPONENTS; id++) {
        handler = g_umac_glb_obj->psoc_create_handler[id];
        arg = g_umac_glb_obj->psoc_create_handler_arg[id];
        if (handler)
            psoc->obj_status[id] = handler(psoc, arg);
        else
            psoc->obj_status[id] = QDF_STATUS_COMP_DISABLED;
    }

    // 阶段 2：聚合所有组件的 obj_status[]，推导最终对象状态
    //   - 任一组件 QDF_STATUS_E_NOMEM/E_FAILURE → 整体失败
    //   - 任一组件 QDF_STATUS_COMP_ASYNC 且私有对象尚未 attach → PARTIALLY_CREATED
    //   - 全部 QDF_STATUS_SUCCESS 或 COMP_DISABLED → 创建成功
    obj_status = wlan_objmgr_psoc_object_status(psoc);

    if (obj_status == QDF_STATUS_SUCCESS) {
        // 所有组件同步创建成功
        psoc->obj_state = WLAN_OBJ_STATE_CREATED;
        for (id = 0; id < WLAN_UMAC_MAX_COMPONENTS; id++) {
            stat_handler = g_umac_glb_obj->psoc_status_handler[id];
            arg = g_umac_glb_obj->psoc_status_handler_arg[id];
            if (stat_handler)
                stat_handler(psoc, arg, QDF_STATUS_SUCCESS);
        }
    } else if (obj_status == QDF_STATUS_COMP_ASYNC) {
        // 部分组件需要异步完成（如等待固件响应）
        psoc->obj_state = WLAN_OBJ_STATE_PARTIALLY_CREATED;
    } else if (obj_status == QDF_STATUS_E_FAILURE) {
        // 任一组件失败 → 整个 psoc 创建失败，触发清理
        obj_mgr_err("PSOC component objects allocation failed");
        wlan_objmgr_psoc_obj_delete(psoc);
        return NULL;
    }

    // 将 psoc 挂入全局对象列表
    if (wlan_objmgr_psoc_object_attach(psoc) != QDF_STATUS_SUCCESS) {
        wlan_objmgr_psoc_obj_delete(psoc);
        return NULL;
    }
    return psoc;
}
```

**回调机制：**

- 对象状态机有三态：`ALLOCATED → PARTIALLY_CREATED → CREATED`（或直接 `ALLOCATED → CREATED`）。采用两阶段创建模型：阶段 1 遍历所有组件 handler，将各自返回值存入 `psoc->obj_status[id]` 数组（不立即判断成败）；阶段 2 通过 `wlan_objmgr_psoc_object_status()` 遍历 `obj_status[]` 做聚合判断——任一组件的 `QDF_STATUS_E_NOMEM/E_FAILURE` 导致整体失败，任一组件 `QDF_STATUS_COMP_ASYNC` 且私有对象尚未 attach 则进入 PARTIALLY_CREATED。PARTIALLY_CREATED 用于异步创建场景——某些组件的初始化需要等待固件响应（如 DFS 组件需要查询芯片的 radar detection 能力），不能同步完成。异步组件完成后通过 `wlan_objmgr_psoc_component_obj_attach()` 提交私有对象，再次调用 `wlan_objmgr_psoc_object_status()` 判断是否可以转 CREATED。
- 组件回调机制让代码高度解耦。新增一个 UMAC 组件（如 WiFi 7 的 MLO 组件）只需实现 `{psoc,pdev,vdev}_create_handler`、`{psoc,pdev,vdev}_destroy_handler`、`{psoc,pdev,vdev}_status_handler` 三组回调，注册到 `g_umac_glb_obj` 中，不用修改 objmgr 的核心逻辑。
- 引用计数贯穿整个对象生命周期。每次获取对象引用（如 `wlan_objmgr_pdev_get_ref()`）都要配对释放（`wlan_objmgr_pdev_release_ref()`）。当引用计数归零时，对象被自动销毁。这防止了 use-after-free 类型的 bug。

pdev 和 vdev 的创建遵循相同的模式，只是遍历的组件集合不同：

- pdev 创建时遍历所有 `pdev_create_handler`，包括 scan pdev 上下文、regulatory pdev 上下文等。
- vdev 创建时需要指定 `opmode`（STA / SAP / P2P / NAN / MONITOR），不同的 opmode 会触发不同的组件初始化（如 STA 模式初始化 MLME 状态机，SAP 模式初始化 beacon 模板等）。

> **QCOM 对象模型速查**：wlan_objmgr 的四层树状结构，从物理芯片到逻辑连接逐层展开。
>
> | 对象     | 物理/逻辑含义                   | 创建时遍历的回调                                  |
> | -------- | ------------------------------- | ------------------------------------------------- |
> | **psoc** | 一颗物理芯片                    | `psoc_create_handler`（scan/reg/MLME 等全局组件） |
> | **pdev** | 一个 RF 前端（对应一个频段）    | `pdev_create_handler`（per-band 组件）            |
> | **vdev** | 一个逻辑接口（STA/SAP/P2P/NAN） | `vdev_create_handler`（opmode 相关组件）          |
> | **peer** | 一个关联的对端设备              | `peer_create_handler`（per-connection 状态）      |

---

# 3 ICNSS2 路径：集成 WiFi 芯片的另一条路

cnss2 处理的是独立 WiFi 芯片（挂在 PCIe 总线上），但 QCOM 还有很多芯片是集成的——WiFi 子系统和 AP（Application Processor）在同一个 SoC 内部，通过内部总线（SNOC）而非 PCIe 通信。这就是 ICNSS2 平台驱动管理的设备，如 WCN6750、WCN7750、WCN6450。

> **与 cnss2 的关系**：ICNSS2 和 cnss2 共享同一套 qcacld-3.0 驱动核心（HDD/CDS/WMA/WMI 层逻辑完全相同）。差异仅在平台层——cnss2 通过 PCIe + MHI 与芯片通信，ICNSS2 通过 SNOC + QMI over shared memory。也就是说，上一节讲的所有驱动内部逻辑（`hdd_driver_load`、`hdd_wlan_start_modules`、WMI 握手）在 ICNSS2 上完全适用，本节只聚焦平台层的不同之处。

## 3.1 `icnss_probe()` — 集成 WiFi 的初始化有何不同？

```c
// platform/icnss2/main.c
static int icnss_probe(struct platform_device *pdev)
{
    struct icnss_priv *priv;
    const struct of_device_id *match;

    // 1. 通过设备树匹配设备
    match = of_match_device(icnss_dt_match, &pdev->dev);

    // 2. 分配 icnss_priv
    priv = devm_kzalloc(&pdev->dev, sizeof(*priv), GFP_KERNEL);

    // 3. 初始化 regulators、clocks、GPIO 列表
    INIT_LIST_HEAD(&priv->vreg_list);
    INIT_LIST_HEAD(&priv->clk_list);

    // 4. 预分配内存池（集成 WiFi 需要从系统内存中 carve out 一块给固件）
    icnss_initialize_mem_pool(priv->device_id);

    // 5. 解析设备树资源：regulators、clocks、interrupts、memory regions
    icnss_resource_parse(priv);

    // 6. 解析 MSA（Memory System Architecture）配置
    icnss_msa_dt_parse(priv);

    // 7. 解析 SMMU 配置
    icnss_smmu_dt_parse(priv);

    // 8. 注册 bus scaling（动态调整总线带宽）
    icnss_register_bus_scale(priv);

    // 9. 创建 event workqueue
    priv->event_wq = alloc_workqueue("icnss_driver_event", WQ_UNBOUND, 1);

    // 10. 【关键】注册 QMI firmware service
    //     集成 WiFi 通过 QMI 协议与 FW 通信（不用 MHI）
    icnss_register_fw_service(priv);

    // 11. 设备特定初始化（使用 if 条件链，非 switch）
    if (priv->device_id == WCN6750_DEVICE_ID ||
        priv->device_id == WCN7750_DEVICE_ID ||
        priv->device_id == WCN6450_DEVICE_ID) {
        // SoC wake workqueue、genl 初始化、runtime PM、AOP 接口
        // 设置 ICNSS_COLD_BOOT_CAL、bdf_download_support = true
    }
    if (priv->device_id == WCN7750_DEVICE_ID) {
        // WPSS 支持（Wireless Processor SubSystem）
        // DMS init、WPSS load work init
    }

    return 0;

    // 级联回滚
out_unregister_fw_service:
    icnss_unregister_fw_service(priv);
    // ...省略...
}
```

抛开相同的驱动核心逻辑，ICNSS2 和 cnss2 在平台层有四个结构性差异。**总线**是根本差异：cnss2 走 PCIe，需要运行时枚举设备；ICNSS2 走 SNOC（SoC 内部总线），芯片在 SoC 内部，平台设备在设备树中静态定义，完全不需要 PCIe 枚举。**内存**紧随其后：集成芯片没有独立 DDR，`icnss_initialize_mem_pool()` 是 ICNSS2 独有的步骤——从系统内存中 carve out 出一块区域（通过设备树 `reserved-memory` 节点定义）给固件当「私人领地」，这块内存对 Linux 内核不可见。**通信协议**也分层级：ICNSS2 用 QMI over shared memory 与固件对话，而 cnss2 用 MHI over PCIe。QMI 是消息层协议（可在共享内存、PCIe、USB 等多种传输层上运行），MHI 则是传输层协议（专为 PCIe 设计）——两者不是竞争关系，而是协议栈中的上下层关系。最后，集成 WiFi 的 RF 参数受 SoC 温度影响比独立芯片大得多，因此 ICNSS2 在冷启动时执行 `COLD_BOOT_CAL` 流程，通过 QMI 将校准数据发送给固件；cnss2 则通过 BDF 文件在初始化阶段一次性下发校准表。

## 3.2 cnss2 vs ICNSS2 对比

| 维度             | cnss2（独立芯片）                 | ICNSS2（集成芯片）                |
| ---------------- | --------------------------------- | --------------------------------- |
| **总线**         | PCIe                              | SNOC（SoC 内部总线）              |
| **设备发现**     | PCI 枚举（vendor/device ID 匹配） | 设备树静态定义（platform device） |
| **Host-FW 传输** | MHI（Modem Host Interface）       | QMI over shared memory            |
| **内存**         | 芯片自带 DDR                      | carve out 系统内存                |
| **典型芯片**     | QCA6490、KIWI、MANGO              | WCN6750、WCN7750、WCN6450         |
| **校准**         | BDF 文件下发                      | COLD_BOOT_CAL 流程                |
| **IOMMU**        | cnss_pci_init_smmu()              | icnss_smmu_dt_parse()             |

> 如果 cnss2 是街边独立餐厅（自己拉水电、自己管物业），ICNSS2 就是购物中心里的美食广场档口——共享商场的水电消防（SoC 的系统资源），但照样要做菜（驱动核心逻辑不变）。这种差异的根源是物理形态：PCIe 芯片是独立封装的硅片，集成芯片是 SoC die 上的一个 IP 块。

#### 3.2.1 一个容易被忽略的差异：固件加载路径

cnss2 和 ICNSS2 在固件文件名确定方式上有一个设计差异值得注意。

cnss2（PCIe 芯片）的固件文件名在代码中硬编码，根据 `pci_dev->device` 的 switch-case 分支选择。例如 QCA6490 使用 `qwlan6490.bin`，KIWI 使用 `wlanKiwi.bin`。文件名字符串散落在 `pci.c` 中各处，没有统一的注册表。

ICNSS2（集成芯片）的固件文件名来自设备树的 `firmware-name` 属性。OEM 在 dts 中指定：

```dts
&wifi {
    firmware-name = "wcn6750/WCNSS_qcom_wlan_nv.bin";
};
```

这个差异影响了固件升级的灵活性。ICNSS2 方式允许 OEM 在不修改内核代码的情况下通过修改 dts 切换固件版本。cnss2 方式需要修改 `pci.c` 并重新编译内核模块。背后是两种不同的定制化哲学：ICNSS2 面向灵活的 OEM 定制，cnss2 面向统一的 QCOM 参考设计。

#### 3.2.2 内存管理差异：独立 DDR vs Carve-out

另一个根本差异是内存模型。PCIe 芯片自带 DDR，Host 通过 PCIe BAR 窗口和 DMA 访问芯片内存。IOMMU/SMMU 的作用是让芯片能够通过虚拟地址访问 Host 侧内存（用于数据传输——芯片从 Host 内存中的 Tx ring 读取数据包，向 Host 内存中的 Rx ring 写入数据包）。

集成芯片没有独立 DDR，必须从系统内存中 carve out 一块。ICNSS2 通过设备树 `reserved-memory` 节点定义这块内存——设备树里表达 carve-out 的方式，是在根节点下声明一个 `removed-dma-pool` 容器：`reg` 属性给出物理起址和长度，`no-map` 属性则告诉内核这块内存既不建线性映射、也不进 buddy 分配器，等于从内核的「可用内存账本」里直接划掉一行：

```dts
reserved-memory {
    wlan_msa_mem: wlan_msa_region {
        compatible = "removed-dma-pool";
        no-map;
        reg = <0x0 0x8e400000 0x0 0x400000>;  // 4MB carve-out
    };
};
```

这块内存对 Linux 内核是「不可见」的（`no-map` 属性），内核不会将其用于常规分配。芯片通过 SMMU 映射访问这块内存。如果 carve-out 不够大（固件升级后变大），芯片固件会加载失败且报错信息非常隐晦（通常表现为 WMI Ready 超时或 QMI 响应解析错误）。

---

# 4 MTK 路径：conninfra + wlan-core-gen4m 的加载哲学

MTK 的 conninfra 就像公寓楼的物业管理——WiFi、蓝牙、GPS、FM 四家租户共享电源、总线和中断资源，由物业统一协调开关机。谁想单独拉闸都不行，必须通过物业审批。

MTK 的驱动架构和 QCOM 有根本性的不同。最大的区别在于：MTK 有一个独立的 **conninfra**（Connectivity Infrastructure）层，管理 WiFi / BT / FM / GPS 共享的硬件资源（EMI 内存、电源域、时钟），WiFi 只是其中一个「子驱动」。这决定了 MTK 的加载流程不是线性的，而是两条线并行推进。

## 4.1 conninfra：为什么需要一层「共享管家」？

MTK 的很多芯片（如 MT6639）是 combo 芯片——一颗硅片上集成了 WiFi、BT、FM、GPS 四个子系统。它们共享同一套电源管理、同一个 EMI（External Memory Interface）内存池、同一组时钟树。

如果每个子系统各自管理自己的电源，会出现经典的竞争条件：「WiFi 想关电但 BT 还在用」。更糟糕的是，combo 芯片的电源域是分层的——有些域给 WiFi 和 BT 共享（如 RF 域），有些是独享的（如 MCU 域）。如果 WiFi 关了共享域而 BT 还在运行，BT 会挂掉。

conninfra 的角色就是中央仲裁者，负责：

1. 统一管理共享资源（EMI 内存分配、电源域开关、时钟门控）
2. 协调多子系统的并发操作（上电/下电/复位不能冲突）
3. 提供消息线程模型来序列化所有操作

```c
// kernel_modules-connectivity-conninfra/conn_drv/connv2/src/connv2_drv.c
int connv2_drv_init(void)
{
    int ret;

    // 1. 探测 conninfra 平台设备（解析设备树）
    ret = platform_driver_probe(&mtk_conninfra_dev_drv,
                                mtk_conninfra_probe);

    // 2. 轮询等待硬件初始化完成
    //    conninfra probe 可能是异步的（设备树节点依赖 clock 初始化完成）
    //    这里用轮询等待而不是同步阻塞，避免死锁
    //    g_connv2_hw_init_done 是 atomic_t 类型
    while (!atomic_read(&g_connv2_hw_init_done)) {
        osal_sleep_ms(50);
    }

    // 3. 初始化 conninfra 核心
    //    support_drv 是一个位掩码，表示哪些子驱动（WiFi/BT/FM/GPS）被当前硬件支持
    conninfra_core_init(consys_hw_get_support_drv());

    // 4. 向 adaptor 层注册
    //    adaptor 层是 conninfra 对上层子系统暴露的统一接口
    conn_adaptor_register_drv_gen(
        CONN_ADAPTOR_DRV_GEN_CONNAC_2, &g_connv2_drv_gen);

    return 0;
}
```

`connv2_drv_init()` 的初始化链条围绕两个核心概念展开。首先是设备树解析——`mtk_conninfra_probe()` 从 dts 中挖出 EMI 内存基地址（物理地址）、EMI 大小、电源 GPIO 号和时钟句柄，全部存入全局结构体，供 WiFi/BT/FM/GPS 四个子驱动随时查询。其次是消息线程模型——`conninfra_core_init()` 创建两条线程：`conninfra_cored` 处理上电、下电、校准等核心操作，`conninfra_cb` 处理整芯片复位（`CHIP_RST`）与校准回调。这意味着后续所有 conninfra API 调用（如 `conninfra_pwr_on()`）不是函数调用然后立刻返回——它们把请求封装成消息丢进 `conninfra_cored` 的队列，然后阻塞等待完成信号。这种设计天然避免了并发冲突：所有核心操作串行化执行，不需要到处加锁。代价则是延迟不可预测——如果队列前面有大量积压，一个简单的 power-on 调用可能要等几百毫秒。

## 4.2 `initWlan()` — WLAN 模块的 insmod 入口

WLAN 模块通过 weak symbol 机制被 conninfra 调用。总的入口是 `initWlan()`：

```c
// kernel_modules-connectivity-wlan-core-gen4m/os/linux/gl_init.c
static int initWlan(void)
{
    // 1. 检查启动模式（KPOC = 关机充电模式，跳过 WiFi 初始化）
    //    仅在 CFG_MTK_ANDROID_WMT 模式下生效
    #if CFG_MTK_ANDROID_WMT
    if (wlanGetBootMode() == KERNEL_POWER_OFF_CHARGING_BOOT)
        return -1;
    #endif

    // 2. 注册 reset-KO 模块（如果支持芯片复位）
    resetko_register_module(RESET_MODULE_TYPE_WIFI, "wifi", ...);

    // 3. 初始化调试基础设施（log level、debug filter）
    wlanDebugInit();

    // 4. 预分配 IO 缓冲区（避免运行时动态分配导致的延迟）
    kalInitIOBuffer();

    // 5. 注册 netdev notifier（监听网络设备状态变更）
    wlanRegisterNetdevNotifier();

    // 6. 初始化 procfs / sysfs 节点
    procInitFs();
    sysInitFs();

    // 7. 创建无线设备（分配 GLUE_INFO、wireless_dev）
    wlanCreateWirelessDevice();

    // 8. P2P 无线设备创建
    glP2pCreateWirelessDevice();

    // 9. 【关键】向总线层注册 probe/remove 回调
    glRegisterBus(wlanProbe, wlanRemove);

    // 10. 【关键】如果使用非 WMT 模式（编译期宏 CFG_MTK_ANDROID_WMT == 0），
    //     立即给总线上电，触发 PCIe 设备枚举，进而触发 wlanProbe
    #if (!CFG_MTK_ANDROID_WMT)
        glBusFuncOn();
    #endif

    // 11. 初始化芯片复位基础设施
    glResetInit();

    // 12. 注册各种 notifier（framebuffer、battery、IDC 等）
    kalFbNotifierReg(prGlueInfo);
    kalBatNotifierReg(prGlueInfo);
    // ...省略...

    return 0;
}
```

`initWlan()` 里有三个操作值得单独展开。`kalInitIOBuffer()` 走在性能优化最前面——WiFi 数据包处理的延迟抖动直接影响用户体验（视频卡顿、游戏丢包），预分配 IO 缓冲区能在数据通路打开时直接使用，省去运行时 `kmalloc` 的不确定性。`glRegisterBus(wlanProbe, wlanRemove)` 是架构层面的关键调用，它将 `mtk_pci_driver.probe` 设为 `mtk_pci_probe` 然后注册 PCI 驱动。与 QCOM 的 cnss2 不同，MTK 的 PCIe 驱动注册和设备枚举可以在 wlan-core-gen4m 自身加载时完成，不需要等一个独立的平台驱动来触发——减少了模块间的耦合和调度延迟。`glBusFuncOn()` 则是一条可选的快速通道：当编译期宏 `CFG_MTK_ANDROID_WMT == 0` 时（独立 AP 芯片，不使用 Wireless Modem Topology），模块加载后立即给 PCIe 总线上电触发设备枚举；而在 WMT 模式下，WiFi 的上电由 modem 固件控制，Host 只需挂上回调，静等通知。

## 4.3 `mtk_pci_probe()` → `wlanProbe()` — 从 PCIe 枚举到驱动核心

```c
// kernel_modules-connectivity-wlan-core-gen4m/os/linux/hif/pcie/pcie.c
static int mtk_pci_probe(struct pci_dev *pdev,
                         const struct pci_device_id *id)
{
    int ret, i;

    // 1. 使能 PCI 设备
    ret = pcim_enable_device(pdev);

    // 2. 映射 PCI BAR 空间（循环尝试 BAR0-BAR5，找到第一个可用的）
    for (i = 0; i <= PCI_STD_RESOURCE_END; i++) {
        ret = pcim_iomap_regions(pdev, BIT(i), pci_name(pdev));
        if (ret == 0)
            break;
    }

    // 3. 使能 bus mastering（芯片才能发起 DMA）
    pci_set_master(pdev);

    // 4. 分配 MSI 中断向量
    //    u4MaxMsiNum 通常是 4 或 8
    ret = pci_alloc_irq_vectors(pdev, 1, u4MaxMsiNum,
                                PCI_IRQ_MSI);

    // 5. 保存 CSR 基地址（从成功的 BAR 映射得到，i 是上面循环找到的 BAR 号）
    prChipInfo->CSRBaseAddress = pcim_iomap_table(pdev) ?
        pcim_iomap_table(pdev)[i] : NULL;

    // 6. 配置 DMA mask（从芯片信息中读取位宽）
    dma_set_mask(&pdev->dev, DMA_BIT_MASK(prChipInfo->bus_info->u4DmaMask));

    // 7. 【核心】调用 wlanProbe
    ret = pfWlanProbe((void *)pdev, (void *)id->driver_data);

    // 8. 配置 ASPM（Active State Power Management）
    //    L1/L1.1/L1.2 模式在 probe 成功后才使能
    //    （受 CFG_CONTROL_ASPM_BY_FW + CFG_SUPPORT_PCIE_ASPM 条件编译保护）
    glBusConfigASPM(pdev, DISABLE_ASPM_L1);
    glBusConfigASPML1SS(pdev, PCI_L1PM_CTR1_ASPM_L12_EN | PCI_L1PM_CTR1_ASPM_L11_EN);
    glBusConfigASPM(pdev, ENABLE_ASPM_L1);

    // 9. 标记驱动已 probe
    g_fgDriverProbed = TRUE;

    return 0;

    // 错误处理
out_irq_free:
    pci_free_irq_vectors(pdev);
    // ...省略...
}
```

MTK 的 `mtk_pci_probe()` 比 QCOM 的 `cnss_pci_probe()` 简单得多——没有 SMMU 初始化（MTK 用标准 ARM SMMU，不走 QCOM 的 DART 框架）、没有 MHI 注册、没有复杂的设备特定 switch-case 分支。这是因为 MTK 把硬件复杂性隐藏在了两个地方：conninfra 层吸收了对电源和时钟的管理，芯片特定的函数指针表（`prChipInfo->fw_dl_ops`、`prChipInfo->get_sw_interrupt_status` 等）把差异变成可插拔的回调。所以 `mtk_pci_probe` 本身只需要做三件事——BAR 映射、MSI 分配、DMA 设置——然后调用一个全局函数指针 `pfWlanProbe` 把控制权交给驱动核心。`pfWlanProbe` 在 `glRegisterBus()` 中被设为 `wlanProbe`，SDIO 路径也通过同一个指针调用——前面总线初始化不同，后面驱动核心共用。

`wlanProbe()` 是整个 MTK WiFi 驱动最核心的函数，长度约 600 行。它使用 `do-while(FALSE)` + `break` 模式实现错误回滚——任何步骤失败直接 break 到底部的 switch 语句：

![wlanProbe 流程](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-wlanProbe%E6%B5%81%E7%A8%8B.svg)

关键代码（精简为核心步骤）：

```c
// os/linux/gl_init.c
// 精简说明：省略了部分错误检查和参数传递细节
static int32_t wlanProbe(void *pvData, void *pvDriverData)
{
    enum ENUM_PROBE_FAIL_REASON eFailReason = FAIL_REASON_NUM;

    #if CFG_CHIP_RESET_SUPPORT
    if (fgSimplifyResetFlow) return wlanOnAtReset();  // 复位路径
    #endif

    do {
        if (!glBusInit(pvData))                    { eFailReason = BUS_INIT_FAIL; break; }
        if (!wlanNetCreate(pvData, pvDriverData))  { eFailReason = NET_CREATE_FAIL; break; }
        if (prChipInfo->fw_dl_ops->mcu_init(prAdapter))
                                                   { eFailReason = ROM_DL_FAIL; break; }

        glTxRxInit(prGlueInfo);

        if (!glBusSetIrq(prGlueInfo, pvData, ...)) { eFailReason = BUS_SET_IRQ_FAIL; break; }

        wlanOnPreAdapterStart(prGlueInfo, prAdapter, &prRegInfo, prChipInfo);

        // 【核心】固件下载 + FW Ready 轮询 + NIC 能力查询
        if (wlanAdapterStart(prAdapter, prRegInfo, FALSE) != WLAN_STATUS_SUCCESS)
            i4Status = -EIO;

        wlanOnPostAdapterStart(prAdapter, prGlueInfo);  // 无论成功与否都执行（trace-only stub）

        if (i4Status < 0) { eFailReason = ADAPTER_START_FAIL; break; }

        if (wlanOnPreNetRegister(prGlueInfo, prAdapter, prChipInfo, prWifiVar, FALSE))
                                                   { eFailReason = NET_REGISTER_FAIL; break; }

        i4DevIdx = wlanNetRegister(prWdev);
        if (i4DevIdx < 0)                          { eFailReason = NET_REGISTER_FAIL; break; }

        wlanOnPostNetRegister();                   // early suspend/inet notifier
        procCreateFsEntry(); sysCreateFsEntry();
        wlanOnWhenProbeSuccess(prGlueInfo, prAdapter, FALSE);
        return 0;  // 成功

    } while (FALSE);

    // 级联错误回滚：switch (eFailReason) 按失败类型执行不同清理
    return -1;
}
```

**Probe 关键步骤：**

- `mcu_init()` 是一个芯片特定的函数指针。以 MT6639 为例（`mt6639_mcu_init`），它会：配置 CB-infra PCIe 重映射地址（让 Host 能通过 PCIe 访问芯片内部寄存器）、读取 EFUSE 内存修复检查模式（验证硬件完整性）、复位 BT 和 WF 子系统、轮询 `WF_TOP_CFG_ON_ROMCODE_INDEX_ADDR` 寄存器直到返回 `0x1D1E`（MCU_IDLE 状态码，表示 MCU 处于空闲状态，可以接受固件下载）。
- `wlanNetCreate()` 分配 ADAPTER 结构体——MTK 的核心数据结构，相当于 QCOM 的 `hdd_context + wlan_objmgr_psoc + wlan_objmgr_pdev` 的总和。它还分配 `net_device`（Linux 网络栈的标准接口）。
- MTK 没有 QCOM 那样的分层对象模型（psoc/pdev/vdev/peer），而是用扁平的 ADAPTER 承载所有状态。`struct ADAPTER` 包含数百个字段：`chip_info`（芯片信息）、`fw_dl_ops`（固件下载操作表）、`rMacAddr`（MAC 地址）、`rWifiVar`（WiFi 配置变量）、`rConnSettings`（连接设置）、`rWlanState`（状态机状态）等等。
- 错误处理使用 `do-while(FALSE)` 的 break 模式——这是一个 C 语言技巧：`do { ... } while (FALSE)` 只执行一次，但内部的 `break` 可以从任意位置跳出整个块，直接进入下方的 `switch (eFailReason)` 错误回滚逻辑。每种失败类型对应不同的清理步骤，避免了 QCOM 那种长链 goto。

> **wlanProbe 12 步流程**
>
> | 步骤 | 调用                                   | 关键动作                                                     |
> | ---- | -------------------------------------- | ------------------------------------------------------------ |
> | 前置 | 复位路径检查                           | 若 `fgSimplifyResetFlow`，走 `wlanOnAtReset()` 轻量路径，直接 return（do-while 之前） |
> | ①    | `glBusInit`                            | 总线初始化（PCIe: BAR 映射 + MSI；SDIO: claim host + 块大小设置） |
> | ②    | `wlanNetCreate`                        | 分配 `wireless_dev`、`GLUE_INFO`、`ADAPTER`、`net_device`    |
> | ③    | `mcu_init`                             | MCU 初始化：CB-infra 重映射、EFUSE 校验、轮询 MCU_IDLE（`0x1D1E`） |
> | ④    | `glTxRxInit`                           | 收发资源初始化（Tx/Rx ring buffer 分配）                     |
> | ⑤    | `glBusSetIrq`                          | 中断设置（PCIe: MSI / legacy IRQ；SDIO: 中断使能）           |
> | ⑥    | `wlanOnPreAdapterStart`                | 预启动：feature options、NVRAM 加载、REG_INFO 初始化         |
> | ⑦    | `wlanAdapterStart`                     | **核心**：固件下载 + FW Ready 轮询 + NIC 能力查询（详见 4.4 节） |
> | ⑧    | `wlanOnPostAdapterStart`               | 后启动（当前为 trace-only stub，无论 adapter start 成功与否均执行） |
> | ⑨    | `wlanOnPreNetRegister`                 | 启动工作线程（`main_thread` / `hif_thread` / `rx_thread`），5 参数 + 返回值检查 |
> | ⑩    | `wlanNetRegister`                      | 向 Linux 内核注册 `net_device`                               |
> | ⑪    | `wlanOnPostNetRegister` + procfs/sysfs | 注册 early suspend/inet notifier + 暴露调试接口              |
> | ⑫    | 成功通知                               | `wlanOnWhenProbeSuccess()` → `send_reset_event(RFSM_EVENT_PROBE_SUCCESS)` |
>
> 失败时按 `eFailReason`（`BUS_INIT_FAIL` → `NET_CREATE_FAIL` → `ROM_DL_FAIL` → `ADAPTER_START_FAIL` → `NET_REGISTER_FAIL`）级联回滚，每种失败类型对应不同的清理步骤。注：省略了 `PROC_INIT_FAIL`、`FAIL_MET_INIT_PROCFS`、`FAIL_BY_RESET` 等低频失败场景。

## 4.4 `wlanAdapterStart()` — 固件下载和 FW Ready 位等待

这是 MTK 加载流程中信息量最大的函数。从「芯片已初始化」到「固件已就绪」的关键跳跃：

`wlanAdapterStart()` 操作的对象是 MTK 驱动的核心数据结构 `struct ADAPTER`——进入六个阶段之前，先看它在一个扁平互联架构中的位置：

![MTK WiFi 驱动数据结构模型](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-mtk-data-model.svg)

> **图注**：MTK 以 `ADAPTER` 为唯一中心的扁平互联结构。最上层的 `GLUE_INFO` 是 OS 适配层，把 Linux 网络栈的 `net_device`（`prDevHandler`）和驱动核心的 `ADAPTER`（`prAdapter`）连起来；`ADAPTER` 内部通过 `chip_info`/`fw_dl_ops` 等指针引用芯片差异，并内嵌 `aprBssInfo[]`/`arStaRec[]` 扁平数组；三条消息线程 `main_thread`/`hif_thread`/`rx_thread` 挂在 `GLUE_INFO` 上，替代 QCOM 的 work queue 并发模型。对比 §2.7 的四层树状对象模型，这里没有层次化引用计数，只有「一个中心 + 一圈指针」——这也是 MTK 比 QCOM 少一层抽象、调用链更短的结构根源。

`wlanAdapterStart()` 的完整流程分为六个阶段：

![wlanAdapterStart 流程](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-wlanAdapterStart%E6%B5%81%E7%A8%8B.svg)

关键代码（精简为核心步骤，完整版见源码）：

```c
// common/wlan_lib.c
// 精简说明：省略了部分参数检查和非核心初始化，完整版约 200 行
uint32_t wlanAdapterStart(struct ADAPTER *prAdapter,
                          struct REG_INFO *prRegInfo,
                          const u_int8_t bAtResetFlow)
{
    // ===== 阶段 A：内存和硬件控制 =====
    if (!bAtResetFlow) {
        if (nicAllocateAdapterMemory(prAdapter))
            return ALLOC_ADAPTER_MEM_FAIL;
    }

    // 获取驱动对硬件的控制权（防止 conninfra 自动休眠）
    prAdapter->fgIsWiFiOnDrvOwn = TRUE;
    ACQUIRE_POWER_CONTROL_FROM_PM(prAdapter);  // void 宏，失败通过 fgIsFwOwn 检查
    prAdapter->fgIsWiFiOnDrvOwn = FALSE;
    if (prAdapter->fgIsFwOwn == TRUE)
        return DRIVER_OWN_FAIL;

    if (!bAtResetFlow && nicInitializeAdapter(prAdapter))
        return INIT_ADAPTER_FAIL;

    wlanWakeUpWiFi(prAdapter);
    halHifSwInfoInit(prAdapter);

    // ===== 阶段 B-D：固件下载 =====
    HAL_ENABLE_FWDL(prAdapter, TRUE);       // 使能 HIF cut-through 模式
    wlanSetChipEcoInfo(prAdapter);
    nicDisableInterrupt(prAdapter);          // 下载期间用轮询
    nicTxInitResetResource(prAdapter);

    if (wlanDownloadFW(prAdapter)) {         // N9 → CR4 → DSP 顺序下载
        nicEnableInterrupt(prAdapter);
        return RAM_CODE_DOWNLOAD_FAIL;
    }

    // ===== 阶段 D：等待固件就绪 =====
    if (wlanCheckWifiFunc(prAdapter, TRUE)) {  // 轮询 Ready 位
        nicEnableInterrupt(prAdapter);
        return WAIT_FIRMWARE_READY_FAIL;
    }

    // ===== 阶段 E-F：固件就绪后初始化 =====
    prAdapter->fgIsFwDownloaded = TRUE;
    wlanQueryNicCapability(prAdapter);         // 查询芯片能力
    wlanQueryNicCapabilityV2(prAdapter);
    wlanUpdateNicResourceInformation(prAdapter);
    wlanUpdateNetworkAddress(prAdapter);        // 设置 MAC 地址
    nicApplyNetworkAddress(prAdapter);

    if (bAtResetFlow)
        wlanLoadManufactureData(prAdapter, prRegInfo);
    else
        wlanOnPostFirmwareReady(prAdapter, prRegInfo);

    nicEnableInterrupt(prAdapter);             // 恢复中断模式
    nicSerInit(prAdapter, bAtResetFlow);       // SER 模块初始化
    thrmInit(prAdapter);                       // thermal 保护
    RECLAIM_POWER_CONTROL_TO_PM(prAdapter);    // 释放控制权给 conninfra

    return WLAN_STATUS_SUCCESS;
}
```

这六个阶段中有四个操作构成了加载链条上的关键节点，缺一不可。最先执行的是电源控制权的交接——`ACQUIRE_POWER_CONTROL_FROM_PM()` 向 conninfra 宣告「现在 WiFi 驱动说了算，不要自动休眠」。这是一个 void 宏（在 `CFG_ENABLE_FULL_PM=0` 时直接为空操作），调用后通过 `prAdapter->fgIsFwOwn` 检查是否成功获取控制权。在固件下载期间，这个保护至关重要：如果 conninfra 按省电策略自动关闭了 WiFi 电源域，固件下载会随机超时，且失败原因极难追查。

拿到控制权后，接着是固件的写入与确认。`wlanDownloadFW()` 通过函数指针表 `FWDL_OPS_T` 分发到芯片特定的下载引擎，按 N9 → CR4 → DSP 的顺序依次写入固件（详见 4.4.1）。下载完成后，`wlanCheckWifiFunc()` 进入最「原始」的等待模式——因为固件中断向量表还没建立，Host 只能通过轮询芯片 Ready 寄存器来确认固件是否启动成功（详见 4.4.2）。一旦 Ready 位翻起，立即进入 `wlanQueryNicCapability()`——这是 Host 与 Firmware 之间的「第二次握手」，Host 通过 HIF 发送查询命令，获取固件上报的芯片能力（支持的模式、特性），然后据此更新本地状态。这四步环环相扣：不拿控制权就下载可能被断电打断，不确认 Ready 就查询只会收到垃圾数据。

#### 4.4.1 `wlanDownloadFW()` 内部：N9 和 CR4 分别是什么？

在 MTK 的 WiFi SoC 中，通常有两颗（或更多）处理器：

- **N9**（主 MCU）：运行 WiFi 协议栈的主要逻辑——MAC 层状态机（扫描、关联、认证、密钥管理）、数据传输调度（EDCA、Block Ack）、省电策略（PS-Poll、UAPSD、WMM-PS）。
- **CR4**（协处理器）：处理 WiFi 物理层相关工作——信道切换（根据 regulatory 要求跳频）、AGC（自动增益控制，调节接收灵敏度）、射频校准（温度补偿、IQ 不平衡校正）。

两者的固件是独立的二进制文件。下载有严格的顺序要求：

```c
// chips/common/fw_dl.c
uint32_t wlanDownloadFW(struct ADAPTER *prAdapter)
{
    struct FWDL_OPS_T *prFwDlOps = prAdapter->chip_info->fw_dl_ops;

    // 1. 使能固件下载模式
    HAL_ENABLE_FWDL(prAdapter, TRUE);

    // 2. 下载 ROM 补丁（Patch）
    //    ROM code 可能在出厂后有 bug 被发现，ROM patch 用于
    //    在引导阶段修复这些 bug（等效于 ROM code 的热修复）
    if (prFwDlOps->downloadPatch) {
        ret = prFwDlOps->downloadPatch(prAdapter);
        if (ret) goto error;
    }

    // 3. 下载 ZB 补丁（Zero-Backoff，WiFi Direct 相关）
    if (prFwDlOps->downloadZbPatch) {
        ret = prFwDlOps->downloadZbPatch(prAdapter);
    }

    // 4. 下载 BT 补丁（如果芯片支持蓝牙共存）
    if (prFwDlOps->downloadBtPatch) {
        ret = prFwDlOps->downloadBtPatch(prAdapter);
    }

    // 5. 同步时间到固件（第二个参数 TRUE 表示初始化命令）
    kalSyncTimeToFW(prAdapter, TRUE);

    // 6. 查询 PMIC 信息
    prChipInfo->queryPmicInfo(prAdapter);

    // 7. PHY 动作（射频校准前准备）
    if (prFwDlOps->phyAction) {
        ret = prFwDlOps->phyAction(prAdapter);
    }

    // 8. 下载 N9 主固件（WiFi MCU firmware）
    ret = prFwDlOps->downloadFirmware(prAdapter, IMG_DL_IDX_N9_FW);
    if (ret) goto error;

    // 9. 下载 CR4 协处理器固件（如果芯片支持 CR4 或 WACPU）
    if (prChipInfo->is_support_cr4 || prChipInfo->is_support_wacpu) {
        if (prFwDlOps->downloadFirmware) {
            ret = prFwDlOps->downloadFirmware(
                prAdapter, IMG_DL_IDX_CR4_FW);
            if (ret) goto error;
        }
    }

    // 10. 下载 DSP 固件（如果是 WiFi 音频相关的芯片）
    if (prFwDlOps->downloadDspFw) {
        ret = prFwDlOps->downloadDspFw(prAdapter);
    }

    // 11. 关闭固件下载模式
    HAL_ENABLE_FWDL(prAdapter, FALSE);

    return WLAN_STATUS_SUCCESS;

error:
    HAL_ENABLE_FWDL(prAdapter, FALSE);
    return WLAN_STATUS_FAILURE;
}
```

ROM patch 是固件下载的第一步，也是最容易被忽略的一步。芯片 ROM 在 tape-out 时就已经定型，但 bug 可能在芯片出厂后才被发现——ROM patch 在引导阶段把 ROM code 中已知有问题的函数重定向到 RAM 中的修正版本，效果类似于 `LD_PRELOAD`。接下来才是真正的固件下载：文件通过标准 `request_firmware()` API 获取，文件名由芯片型号 + ECO 版本拼成（例如 `mt6639_patch_e1_hdr.bin` 和 `mt6639_n9_e1.bin`），存放在 `/vendor/firmware/` 下。下载顺序必须严格遵守——N9 固件在前，CR4 固件在后。N9 是主控制器，要负责启动 CR4 并分配任务；反过来下载的话，CR4 会发现 N9 还没初始化 MMU，固件加载到内存里也没有任何代码能跳转到它。

#### 4.4.2 FW Ready 位轮询：为什么是「轮询」而不是「中断」？

这是新手最容易困惑的设计选择。答案是：**此时固件没跑起来，中断向量表还没建立，发不出中断**。固件还没醒过来，按门铃自然没人应，只能趴在窗口看灯亮没亮——这就是轮询的设计逻辑。

```c
// common/wlan_lib.c
uint32_t wlanCheckWifiFunc(struct ADAPTER *prAdapter,
                           u_int8_t fgRdyChk)
{
    uint32_t u4LoopCount = 0;
    OS_TIME_T rStartTime;
    uint32_t u4ReadyFlag = 0;

    // 记录开始时间
    rStartTime = kalGetTimeTick();  // 宏，展开为 jiffies_to_msecs(jiffies)，无参数

    while (TRUE) {
        // 通过芯片特定的宏读取硬件 Ready 寄存器
        // 例如：读取 WF_TOP_CFG_ON 寄存器中对应的 Ready 位
        HAL_WIFI_FUNC_READY_CHECK(prAdapter,
                                  prAdapter->chip_info->sw_ready_bits,
                                  &u4ReadyFlag);

        // Ready 位集合检查通过
        if (u4ReadyFlag) {
            DBGLOG(INIT, INFO,
                   "Ready bit asserted, loop=%u\n", u4LoopCount);
            return WLAN_STATUS_SUCCESS;
        }

        // 检查中断状态变化中的卡移除/总线访问错误
        if (kalIsCardRemoved(prAdapter->prGlueInfo) == TRUE ||
            fgIsBusAccessFailed == TRUE) {
            return WLAN_STATUS_FAILURE;
        }

        // 超时检查
        if (CHECK_FOR_TIMEOUT(rStartTime,
                              CFG_RESPONSE_POLLING_TIMEOUT,
                              CFG_RESPONSE_POLLING_DELAY)) {
            // 读取当前状态，帮助 debug
            HAL_WIFI_FUNC_GET_STATUS(prAdapter);
            DBGLOG(INIT, ERROR, "Ready bit timeout\n");
            // 触发复位
            GL_DEFAULT_RESET_TRIGGER(prAdapter, RST_CHECK_READY_BIT_TIMEOUT);
            return WLAN_STATUS_FAILURE;
        }

        // 如果循环次数超过 5 次，发送 AEE 警告
        // AEE = Android Exception Engine，MTK 的错误报告系统
        if (u4LoopCount > 5) {
            kalSendAeeWarning("WFSYS",
                             "wlanCheckWifiFunc fail\n");
        }

        u4LoopCount++;
        kalMsleep(CFG_RESPONSE_POLLING_DELAY);  // 通常是 10ms

    }
}
```

**轮询细节：**

- Ready 位在芯片寄存器中定义。以 MT66xx 系列为例，定义在 `include/nic/mt66xx_reg.h` 中：
  - `WIFI_FUNC_INIT_DONE = BIT(0)` — 基础初始化完成
  - `WIFI_FUNC_N9_DONE = BIT(1)` — N9 MCU 固件启动完成
  - `WIFI_FUNC_CR4_READY = BIT(2)` — CR4 协处理器就绪
  - 不同芯片需要的 `sw_ready_bits` mask 不同：单 MCU 芯片只需 `BITS(0, 1)`，双 MCU 芯片需要 `BITS(0, 2)`。
- 超时判断使用 `CHECK_FOR_TIMEOUT(rStartTime, CFG_RESPONSE_POLLING_TIMEOUT, CFG_RESPONSE_POLLING_DELAY)`，宏内部计算 timeout * delay 作为总超时阈值。典型配置下总超时约 5000ms，delay 10ms，即最多轮询约 500 次。如果超时，触发 `GL_DEFAULT_RESET_TRIGGER(prAdapter, RST_CHECK_READY_BIT_TIMEOUT)` 复位。
- AEE 警告机制在循环超过 5 次后启动。这是 MTK 的早期预警系统——如果正常启动应该是几十次循环（几百毫秒），超过 5 次说明可能有问题（固件加载慢但最终可能会成功），但还没到超时阈值。

## 4.5 SDIO 路径：另一种总线类型

以上描述的是 PCIe 路径。MTK 还广泛支持 SDIO 总线（主要用于低功耗 IoT 芯片）。SDIO 的 `glBusInit()` 和 PCIe 有很大不同：

```c
// os/linux/hif/sdio/sdio.c
uint32_t glBusInit(void *pvData)
{
    struct sdio_func *func = (struct sdio_func *)pvData;

    // 1. Claim SDIO host（获取 SDIO 控制器的独占使用权）
    sdio_claim_host(func);

    // 2. 设置块大小为 512 字节
    sdio_set_block_size(func, 512);

    // 4. 配置 I/O 超时（防止芯片不响应导致 Host 挂起）
    //    SDIO 是同步总线，如果芯片不响应，Host 会永远等待
    //    超时保护是必需的

    // 5. 释放 SDIO host
    sdio_release_host(func);

    return TRUE;
}
```

SDIO 和 PCIe 在 WiFi 驱动中的区别主要在性能：PCIe 提供更高的带宽（Gen3 x1 约 1GB/s）和更低的延迟，适合高吞吐量场景（如 WiFi 6/6E）。SDIO 功耗更低、管脚更少，适合 IoT 和低功耗设备。

> **SDIO 与 PCIe 的共性**：SDIO 路径在 `glBusInit()` 之后的固件下载（`wlanDownloadFW`）和 FW Ready 位轮询（`wlanCheckWifiFunc`）流程与 PCIe 路径完全一致——差异仅在于总线初始化层（SDIO 的块大小设置和 I/O 超时 vs PCIe 的 BAR 映射和 MSI 配置）。

走完了 QCOM 的两条子路径（cnss2 + ICNSS2）和 MTK 的两条总线路径（PCIe + SDIO），现在是时候把它们放在一起做系统性对比了。

---

# 5 QCOM vs MTK：两种架构哲学的全面对比

走完两条路径（以及 QCOM 的 ICNSS2 变体、MTK 的 SDIO 变体），我们可以做一个系统性的对比。

| 维度             | QCOM (qcacld-3.0)                                            | MTK (wlan-core-gen4m)                                        |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **平台层架构**   | cnss2 / icnss2 独立平台驱动（分 PCIe 和集成两种）            | conninfra 共享连接基础设施（WiFi/BT/FM/GPS 统一管理）        |
| **固件下载协议** | PCIe: MHI + QMI（命令/响应模式，分段传输）; 集成: QMI over shared memory | HIF cut-through + 寄存器监控（直接内存写入 + 状态位轮询）    |
| **对象模型**     | 四层树状（psoc → pdev → vdev → peer）+ wlan_objmgr 组件回调  | 扁平 ADAPTER（单一大结构体容纳所有状态）+ 芯片特定函数指针表 |
| **组件解耦**     | UMAC 组件注册表（`g_umac_glb_obj`）+ create/destroy/status 回调 | 条件编译（`CFG_*` 宏）+ 函数指针表（`FWDL_OPS_T`、`CHIP_INFO_T`） |
| **Host-FW 通信** | WMI 统一命令/事件协议（TLV 编码，数百种命令和事件）          | 芯片寄存器（状态位）+ HIF 消息（命令/响应）                  |
| **初始化握手**   | WMI_SERVICE_READY → WMI_READY（含 EXT/EXT2 扩展事件）        | MCU init → FW download → Ready 位轮询（无扩展机制）          |
| **并发模型**     | QDF work queue + OSIF sync transition（状态转换保护）        | 消息线程（conninfra_cored / conninfra_cb / main_thread / hif_thread / rx_thread） |
| **蓝牙共存**     | 独立于 WiFi 驱动（通过 WMI 命令 `WMI_COEX_CONFIG_CMDID` 配置） | conninfra 统一管理（WiFi/BT 共享电源、时钟、内存）           |
| **固件来源**     | `request_firmware()` → QMI 分段传输（每段 ≤ `QMI_WLFW_MAX_DATA_SIZE_V01`） | `request_firmware()` → HIF cut-through 一次性 dump           |
| **错误处理**     | goto 级联回滚 + `QDF_BUG()` 检查                             | do-while(FALSE) break + switch (eFailReason) 级联回滚        |
| **配置管理**     | INI 文件（数百参数）+ `/sys/kernel/wlan/` sysfs 覆盖         | NVRAM + 设备树 + `CFG_*` 编译选项                            |

## 5.1 核心差异解读

**QCOM 的「分层工厂」vs MTK 的「一体化车间」**

QCOM 的设计像一座分层工厂：每层有明确的职责边界（HDD → CDS → WMA → WMI → HIF），每层之间通过抽象接口通信。QCA6490 和 QCN7605 共享同一套 HDD 代码，只换底层的 WMI TLV 定义和 HIF 驱动。新增一颗芯片的工作量主要在 cnss2/icnss2 层——配置设备树、实现 power_on/power_off 序列、指定固件文件名。

MTK 的设计更像一个「一体化车间」：ADAPTER 结构体承载了几乎所有状态，芯片差异通过函数指针表和条件编译处理。新增一颗芯片需要：实现 `FWDL_OPS_T` 的函数指针（`mcu_init`、`downloadPatch`、`downloadFirmware` 等）、实现 `CHIP_INFO_T` 的查询函数（`queryPmicInfo`、`checkAsicCap` 等）、在编译时打开对应的 `CFG_*` 开关。

两种设计的差异反映了不同的商业策略：QCOM 需要用同一套驱动栈支持从低端 IoT 到高端 AP 的几十款芯片，分层设计让代码复用最大化。MTK 的芯片型号相对少，扁平设计牺牲了复用性，换来了更简单的调用链和更少的抽象层开销。

**QMI 分段传输 vs HIF cut-through：可靠性和速度的 trade-off**

QCOM 的 QMI 协议在固件下载时走分段传输：Host 发送 `QMI_WLFW_BDF_DOWNLOAD_REQ_V01` 消息，携带一段固件数据，等待 Firmware 的 `QMI_WLFW_BDF_DOWNLOAD_RESP_V01` 确认，然后发送下一段。如果某段传输失败（ACK 超时或 NACK），可以单独重传那一段。

MTK 的 HIF cut-through 模式是一次性把固件写入芯片内存，然后轮询 Ready 位。没有分段确认机制。如果写入过程中发生错误（例如 DMA 故障导致部分数据损坏），只能重新下载整个固件。

QCOM 的方式在固件较大（5MB+）或传输较慢（USB 2.0）的场景中有明显优势——重传一个 4KB 的 segment 比重传 5MB 的整个固件快得多。MTK 的方式在固件较小（1-2MB）且传输可靠（PCIe Gen2/Gen3，误码率极低）的场景中更快——省去了几百次 QMI 握手的时间。

QMI 的分段确认像后厨按盘上菜——哪道菜打翻了就只补那一道；HIF 的 cut-through 一次性 dump 则像大锅饭——整锅端上来，糊了就得全部重做。前者费在端盘次数上，后者省在中间环节上，代价是出了错要全盘重来。

**并发模型：同步 vs 消息线程**

QCOM 使用 QDF work queue + OSIF sync transition 的组合。`osif_psoc_sync_trans_start_wait()` 和 `osif_psoc_sync_trans_stop()` 保护关键状态转换（如 probe→running、running→SSR shutdown）不被并发执行。正常运行时，各子系统通过 work queue 异步执行。

MTK 使用消息线程模型。conninfra_cored 线程处理核心操作（上电、下电、校准），conninfra_cb 线程处理整芯片复位，main_thread 处理 WLAN 与 conninfra 的交互，hif_thread 处理 HIF 收发，rx_thread 处理数据包接收。线程之间的通信通过消息队列。

两种模型在「正确性」上都能保证并发安全。区别在于调试难度：QCOM 的 work queue 模型在问题出现时调用栈很深（work → work handler → subsystem handler → WMI handler），但代码流是可追踪的。MTK 的消息线程模型调用栈浅（消息发送 → 线程接收消息 → 处理），但问题发生时需要同时查看多条线程的日志才能还原事件顺序。

## 5.2 常见错误场景与恢复路径

驱动加载过程中任何一个环节都可能失败。以下是开发者和系统工程师最常遇到的几种故障，以及如何从日志中快速定位。

### 5.2.1 场景一：PCIe 链路训练失败

**症状**：`cnss_pci_probe()` 从未被调用，或 `wlanProbe()` 从未执行。WiFi 开关点击后无任何 dmesg 输出。

**日志关键字**（QCOM cnss2）：

```text
cnss: Failed to enable PCIe RC%x, err = %d
cnss: PCIe RC driver is not ready, defer probe
```

**日志关键字**（MTK）：`mtk_pci_probe()` 中 `pcim_enable_device()` 返回非零。

**恢复路径**：链路训练在 `cnss_pci_enumerate()` 中最多重试 `LINK_TRAINING_RETRY_MAX_TIMES` 次（通常 3 次）。如果是 `-EPROBE_DEFER`，cnss2 将 probe 推迟到 RC 驱动就绪后自动重试。如果重试耗尽，需要检查硬件连接（PCIe 复位 GPIO 是否正确拉高、参考时钟是否稳定）或设备树配置（`qcom,wlan-rc-num` 是否与硬件匹配）。

### 5.2.2 场景二：固件文件缺失

**症状**：`cnss_pci_probe()` 成功，但 `WMI_SERVICE_READY_EVENTID` 从未到达。dmesg 中出现 `request_firmware` 相关错误。

**日志关键字**（QCOM cnss2）：

```text
cnss: Failed to get BDF file
Direct firmware load for <fw_name> failed with error -2
```

**日志关键字**（MTK wlan-core-gen4m）：

```text
RAM_CODE_DOWNLOAD_FAIL
```

**恢复路径**：检查 `/vendor/firmware/` 或 `/lib/firmware/` 下是否存在对应的固件文件（QCOM: `qwlan6490.bin`、`bdwlan.bin` 等；MTK: `mt6639_n9_e1.bin`、`mt6639_patch_e1_hdr.bin` 等）。QCOM 的 BDF 文件名支持 fallback chain（`bdwlan.e05 → bdwlan.bin → REGDB_FILE_NAME`），即使 OEM 未提供定制 BDF，芯片也能用通用校准数据工作。如果固件文件存在但仍失败，检查文件权限（需要 root 可读）和 SELinux 上下文。

### 5.2.3 场景三：WMI Ready 超时或版本不匹配

**症状**：固件下载成功（BMI/QMI 阶段通过），但 `WMI_READY_EVENTID` 超时或携带错误状态。

**日志关键字**（QCOM）：

```text
target_if_err: Version mismatch with FW
target_if_err: Failed to extract ready event
wlan_init_status != 0
```

**日志关键字**（MTK）：

```text
Ready bit timeout
kalSendAeeWarning: wlanCheckWifiFunc fail
WAIT_FIRMWARE_READY_FAIL
```

**恢复路径**：Host 驱动版本与固件版本不兼容是这类问题的最常见根因。QCOM 的 `wmi_check_and_update_fw_version()` 比较 Host 驱动期望的 ABI 版本与固件报告的 ABI 版本，不匹配则返回错误。如果 INI 配置了 `wmi_service_ext_msg = 1`，Host 还会等待 `WMI_SERVICE_READY_EXT_EVENTID`——如果 EXT 事件在 `service_ready_ext_timer` 超时前未到达，Host 降级为非 EXT 模式（丧失 6GHz 等先进能力）。MTK 路径中 `wlanCheckWifiFunc()` 在 `CFG_RESPONSE_POLLING_TIMEOUT * CFG_RESPONSE_POLLING_DELAY`（典型约 5000ms）内轮询 Ready 位，超时后触发 `GL_DEFAULT_RESET_TRIGGER(prAdapter, RST_CHECK_READY_BIT_TIMEOUT)` 复位。

### 5.2.4 场景四：WLAN 功能未就绪

**症状**：驱动 probe 成功、固件下载成功、WMI Ready 通过，但 `wiphy_register()` 后上层仍然看不到 wlan0 接口。

**日志关键字**（QCOM）：

```text
cds_open() 返回错误
hdd_configure_cds() 返回错误
```

**日志关键字**（MTK）：

```text
ADAPTER_START_FAIL
NET_REGISTER_FAIL
BUS_SET_IRQ_FAIL
```

**恢复路径**：检查 `driver_status` 是否达到了 `DRIVER_MODULES_ENABLED`（QCOM）或 `g_fgDriverProbed == TRUE`（MTK）。如果卡在中间状态，通常是因为某个子系统的初始化失败导致级联回滚。QCOM 的 `hdd_wlan_start_modules()` 状态机会在错误时触发反向回滚（deconfigure_cds → ... → release_lock）。MTK 的 `wlanProbe()` 使用 `do-while(FALSE) + switch(eFailReason)` 模式，每种失败类型对应不同的清理路径（如 `ADAPTER_START_FAIL` 会释放 IRQ 和 adapter 内存）。

### 5.2.5 场景五：SSR 恢复中的二次失败

**症状**：芯片崩溃后 SSR 自动重启，但重启过程中再次失败。

**日志关键字**（QCOM）：

```text
cds_set_recovery_in_progress(true)
SSR_MAX_FAIL_CNT exceeded
QDF_BUG()
```

**恢复路径**：QCOM 驱动在 probe 阶段通过 `cds_set_recovery_in_progress(false)` 清除恢复标志，通过 `cds_set_driver_in_bad_state(false)` 复位不良状态。`hdd_soc_load_lock()` 保证同一个 SoC 不会被并发 probe。如果连续 probe 失败次数超过 `SSR_MAX_FAIL_CNT`，驱动调用 `QDF_BUG()` 触发 kernel panic——这是一种极端保护机制：与其让系统在不可恢复的硬件错误中继续运行，不如让整个系统重启。

> **排查思维导图**：驱动加载失败时，先确定卡在哪个阶段——是 PCIe 枚举阶段（硬件信号问题）、固件下载阶段（文件缺失或传输错误）、WMI 握手阶段（版本不匹配或固件内部错误），还是子系统初始化阶段（依赖顺序错误或内存不足）。每个阶段的日志关键字和恢复路径不同，定位错误阶段是排查的第一步。

---

# 6 出事了怎么办？SSR 崩溃恢复的三级体系

![SSR 三级恢复流程](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-ssr-recovery.svg)

驱动加载完成、芯片就绪后，如果芯片中途崩溃了怎么办？SSR 就是这家餐厅的备用发电机——主电源跳闸时，能不能在三秒内无缝切换？

WiFi 芯片固件可能因为各种原因崩溃：空指针访问（C 代码难免）、看门狗超时（死锁或死循环）、内存耗尽（peer 数量超过硬件限制）、RF 干扰导致的硬件状态机卡死。SSR（SubSystem Restart）就是为此设计的恢复机制。

## 6.1 QCOM 三级 SSR

QCOM 定义了三层恢复策略，从轻到重：

| 级别                    | 触发者          | 触发条件                                        | 措施                                                         | 用户感知                              |
| ----------------------- | --------------- | ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| **Level 1：自恢复**     | 驱动自身        | WMI 命令超时、credit 耗尽、TX 超时              | 重新初始化 WMI 通道、清理 pending 命令、不重启芯片           | 无感知（< 200ms，数据包可能丢几个）   |
| **Level 2：平台 SSR**   | cnss2/icnss2    | 固件看门狗 bite、MHI 通道断开、ramdump 收集完成 | `hdd_wlan_shutdown()` → `hdd_wlan_re_init()`：完整重启驱动、重新下载固件、重建 WMI 握手 | 短暂断连（2-5s，WiFi 图标消失又出现） |
| **Level 3：Panic 关闭** | 内核 panic 路径 | 系统级严重错误（NOC error、内存损坏）           | `wlan_hdd_crash_shutdown()` → `hif_crash_shutdown()`：最小化清理、不尝试恢复 | 系统重启                              |

Level 2 是 SSR 恢复的核心。它的关键技术挑战是「上层无感」—— wpa_supplicant 和 Java Framework 不应该知道芯片重启了。实现方式：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_driver_ops.c
// ===== 阶段一：关闭 =====
static void __hdd_soc_recovery_shutdown(void)
{
    // 1. 通知所有子系统进入 recovery 状态
    //    注意：hdd_psoc_shutdown_notify() 在 hdd_soc_recovery_cleanup() 内部调用
    //    （清理 scan queue、IPA pipe shutdown、shutdown notifier call/purge）
    hdd_soc_recovery_cleanup();

    // 2. 等待 debugfs 线程退出（避免访问被释放的内存）
    hdd_wait_for_debugfs_threads_completion();

    // 3. 屏蔽 HIF 中断——防止旧数据触发 ISR
    hif_mask_interrupt_call(hif_ctx);

    // 4. 禁用 ISR（中断服务例程）
    hif_disable_isr(hif_ctx);

    // 5. HDD 全量关闭（释放所有子系统资源）
    //    逆向执行 cds_open 的反操作：cds_disable → cds_close → hif_close
    hdd_wlan_shutdown();
}

// ===== 阶段二：重新初始化 =====
// 由 cnss2 在硬件复位完成后回调
// 重新走一遍类似 __hdd_soc_probe 的流程，但跳过部分步骤：
//  - 不重新分配内存（复用之前分配的结构体）
//  - 不重新注册 wiphy（cfg80211 不知道芯片重启了）
//  - 不重新创建 sysfs/procfs 节点
//  - 恢复 saved state：dual STA 配置、SAR 限制、scan IE 等
```

关闭阶段有两条铁律：不再向芯片发送任何 WMI 命令（芯片已崩溃，发送只会超时或产生 bus error），不再处理来自芯片的中断（芯片可能处于不确定状态，中断可能携带垃圾数据）。这个关闭过程通过 `osif_psoc_sync` 机制来保证安全——类似于 RCU，等待所有正在使用 psoc 的线程退出关键区后再执行 shutdown，防止有人在 shutdown 过程中还在尝试通过 psoc 操作硬件。重新初始化时，`reinit` 标志让驱动跳过不必要的步骤。最关键的是跳过 `wiphy_register()`——从 cfg80211 的视角看，芯片根本没有变化：能力集、MAC 地址、接口类型都和之前一样，重复注册反而会让内核状态混乱。

#### 6.1.1 SSR 成功后状态恢复

恢复不仅仅是把驱动重新加载，还需要恢复之前的状态：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_power.c
// SSR 恢复后的状态重建
hdd_restore_dual_sta_config();    // 恢复双 STA 策略
hdd_restore_sar_config();         // 恢复 SAR（比吸收率）限制
hdd_restore_dbam_config();        // 恢复 DBAM（动态带宽分配）
hdd_send_default_scan_ies();      // 重新下发默认扫描 IE
hdd_ssr_restart_sap();            // 如果之前有 SAP 接口，重启之
hdd_handle_cached_commands();     // 处理恢复期间被缓存的命令
```

SAR（比吸收率）限制是一道法规红线——设备靠近人体时必须动态降低发射功率，如果 SSR 恢复后忘了恢复 SAR 配置，设备就可能以全功率贴在人身上运行，这在各国监管机构那里是会召回的。另一个容易忽视的细节是缓存命令：SSR 恢复期间 Framework 可能已经下发了新的 WiFi 请求（比如用户尝试连接网络），这些请求不能立即执行——固件还没准备好——而是被放入缓存队列。恢复完成后按入队顺序依次执行，就像餐厅停电重开后按顺序补做停电期间的订单。

## 6.2 MTK 的 Whole Chip Reset

MTK 的复位机制和 QCOM 有不同的出发点：QCOM 是 Host 主动检测和触发，MTK 是芯片固件主动报告：

```c
// chips/common/cmm_asic_connac3x.c
// 精简说明：去除了与 SSR 无关的 SW_INT_FW_LOG（固件日志）和
// SW_INT_SW_WFDMA（WFDMA 软件事件）分支，仅保留复位相关逻辑。

// 调用链：内核 IRQ → pcie_sw_int_top_handler（上半部）
//       → pcie_sw_int_thread_handler（下半部，threaded IRQ）
//       → asicConnac3xSwIntHandler（处理 FW log、子系统复位、整芯片复位）
u_int8_t asicConnac3xSwIntHandler(struct ADAPTER *prAdapter)
{
    uint32_t u4Status;

    // 1. 读取 SW 中断状态寄存器
    prChipInfo->get_sw_interrupt_status(prAdapter, &u4Status);

    // 2. 根据中断类型分支（FW_LOG/WFDMA 等无关分支省略）

    if (u4Status & SW_INT_SUBSYS_RESET) {
        // WFSYS 子系统复位
        // 仅重置 WiFi 子系统，BT 继续工作
        // conninfra 确保复位时序正确（先摘 WiFi 电源，等 BT 完成当前操作，再恢复）
        handle_wfsys_reset(prAdapter);
    }

    if (u4Status & SW_INT_WHOLE_RESET) {
        // 整芯片复位（WiFi + BT）
        // 只有在 WiFi 和 BT 同时出问题时才走这条路
        // 先 dump bus hang control registers（帮助 debug）
        dbg_ops->dumpBusHangCr(prAdapter);

        // 如果配置了强制完整 coredump
        if (CFG_WIFI_FORCE_FULL_COREDUMP) {
            kalSetRstEvent(FALSE);  // 保留 coredump 内存
        } else {
            kalSetRstEvent(TRUE);
        }

        handle_whole_chip_reset(prAdapter);
        //   └── conninfra_trigger_whole_chip_rst(CONNDRV_TYPE_WIFI, reason)
        //       └── conninfra_core_lock_rst() → 获取复位锁
        //       └── conninfra_core_trg_chip_rst() → 执行硬件复位
        //       └── 复位顺序：WiFi 电源摘除 → BT 电源摘除 → 等待 → 反向恢复
    }

    return TRUE;
}
```

![MTK 整芯片复位时序](assets/03-WiFi%E6%89%93%E5%BC%80%EF%BC%88%E4%BA%8C%EF%BC%89QCOM-%E4%B8%8E-MTK-%E6%80%8E%E4%B9%88%E6%8A%8A%E8%8A%AF%E7%89%87%E5%8F%AB%E9%86%92%EF%BC%9F/03-mtk-whole-chip-reset.svg)

> **图注**：MTK 整芯片复位的跨层时序。固件检测到内部错误后置位 `SW_INT_WHOLE_RESET`，Host 侧 `asicConnac3xSwIntHandler()` 判读类型并调用 `handle_whole_chip_reset()`，后者经 `conninfra_trigger_whole_chip_rst()` 跨层下发；`conninfra_core_lock_rst()` 抢锁后，`conninfra_core_trg_chip_rst()` 把复位请求丢进 `conninfra_cb` 线程串行执行「先摘 WiFi 电源 → 摘 BT 电源 → 等待 → 反向恢复」，最后 `wlanOnAtReset()` 复用 `net_device`/`ADAPTER` 简化恢复。看图重点：Host（threaded IRQ）→ conninfra（消息线程）→ 电源域三段各自运行在什么上下文，以及电源摘除顺序为何不能乱。

复位顺序「先 WiFi 后 BT」为什么是硬约束？因果藏在两个函数里。`conninfra_trigger_whole_chip_rst()`（`conninfra.c:187`）第一步不是断电，而是调 `conninfra_core_lock_rst()` 抢复位锁——已有复位在进行就立即返回，绝不重入。拿到锁后，`conninfra_core_trg_chip_rst()`（`conninfra_core.c:1784`）把复位请求打包成消息丢进 `conninfra_cb` 线程，真正硬件复位在消息线程串行执行。之所以必须「消息线程 + 固定顺序」：WiFi 和 BT 共享同一个 VCN 电源域和 EMI 总线，先摘 WiFi、再摘 BT、反向恢复不是仪式而是硬约束——任一子系统的 DMA 事务进行到一半被单独拉掉电源域，残留总线事务会污染对端寄存器，芯片可能卡死在半复位态。

`SW_INT` 是固件与 Host 之间的最后一根通信线——固件在检测到内部错误（任务看门狗超时、内存分配失败、硬件状态机卡死）后，设置 SW_INT 状态寄存器，通过硬件中断通知 Host。接下来的复位由 conninfra 的复位管理器协调：先摘 WiFi 的电源域，再摘 BT 的，等电源完全稳定后再反向恢复——先通电 BT，再通 WiFi。这个顺序不能乱。如果两个子系统同时复位，总线竞争会卡死整个芯片。复位完成后，Host 通过 `wlanOnAtReset()` 走简化 probe 流程：复用已有的 `net_device` 和 `ADAPTER`，只重新下载固件和建立中断。内核完全不知道发生了什么——对 netdev 来说，一切照旧。

## 6.3 两种 SSR 策略的哲学差异

QCOM 的 SSR 是「**Host 主导**」：驱动检测异常 → 驱动执行恢复流程 → 平台驱动配合做硬件复位。MTK 的 SSR 是「**芯片主导**」：芯片固件检测异常 → 通过 SW_INT 通知 Host → Host 配合 conninfra 执行硬件复位。

两种设计有不同的适用场景：

- QCOM 方式更可靠：固件即使完全挂死（死锁、内存踩踏导致代码跳转到随机位置），Host 也能通过 MHI 超时或 WMI 命令超时检测到。芯片不需要主动通知——Host 的被动超时就是通知。
- MTK 方式更精确：芯片自己知道什么坏了（是 WiFi 子系统锁死还是全芯片故障？），可以只复位故障部分。代价是如果固件彻底死锁发不出 SW_INT，Host 只能等看门狗超时（通常是 30-60 秒），这个窗口内用户会看到 WiFi 完全无响应。

> QCOM 的方式像餐厅老板亲自巡店——即使厨房没人报警，老板也能通过超时的订单发现问题。MTK 的方式像厨房自带烟雾报警器——更灵敏、能精确报告哪里出问题，但如果报警器本身也坏了，就只能等客人的投诉了。

## 6.4 常见失败场景速查表

在实际开发中，WiFi 打不开的 bug 通常落在以下几个场景。这个表汇总了每个场景的触发条件、日志关键字和恢复路径，可以作为调试时的第一站索引入口：

| 失败场景                    | 触发条件                                                     | 日志关键字                                                   | 恢复路径                                                     |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **PCIe 枚举失败**           | 链路训练超时（RC 时钟未稳定 / PCB 布线问题 / 芯片未复位）    | `"Failed to enable PCIe RC%x, err = %d"` [pci.c:9087]; `"Retry PCI link training"` [pci.c:9090] | `cnss_pci_enumerate()` 内 `goto retry` 重试 `LINK_TRAINING_RETRY_MAX_TIMES` 次；全部失败则返回 `-ENODEV`，`cnss_pci_probe()` 中止（pci.c:9079-9095） |
| **固件文件不存在**          | `/vendor/firmware/` 下缺少对应芯片的 `.bin` 文件             | `request_firmware()` 返回 `-ENOENT`；cnss2 中触发 `CNSS_TIMEOUT_FW_LOAD` 定时器超时 | 文件名 fallback chain（如 `bdwlan.e05` → `bdwlan.bin` → `REGDB_FILE_NAME`）；全部失败则 `cnss_pci_probe()` → `goto reset_ctx`，用户空间 ueventd 可补发固件 |
| **QMI 固件下载失败**        | 分段传输中某段 CRC 校验失败 / MHI 通道断开 / QMI 响应超时    | `"Failed to send respond ... download request"` [qmi.c]; `"Failed to wait for response"`; QMI 响应 `result != QMI_RESULT_SUCCESS_V01` | 单段可重传（QMI 事务级重试）；整体失败则 fallback 文件名或触发 Level 2 SSR |
| **WMI 握手中断**            | Service Ready 事件未收到 / Host-FW 版本不匹配 / EXT timer 超时 | `"Version mismatch with FW"` [init_event_handler.c:1208]; `target_if_err("wmi_ready false")`; `service_ready_ext_timer` 超时 | 版本不匹配 → 加载失败（无法恢复）；EXT 超时 → 降级为非 EXT 模式（丧失 6GHz 等高级能力但基本功能可用）；整体失败 → `tgt_hdl->info.wmi_ready = false` → 触发 Level 2 SSR |
| **Supplicant 启动失败**     | `add_iface` 返回 NULL（驱动未 ready / 配置文件缺失 / nl80211 socket 打开失败） | `"Failed to initialize wpa_supplicant"` [main.c:347]; `"Failed to initialize driver '%s'"` [main.c:171]; `wpa_s == NULL` [main.c:383] | `main()` 返回 `-1` → `init` 进程重启 Supplicant（Android `init.rc` 中 `onrestart` 触发）；重试间隔由 `init` 的 `service` 配置控制 |
| **SSR Level 1（自恢复）**   | WMI 命令超时 / credit 耗尽 / TX 超时                         | `QDF_STATUS_E_TIMEOUT`；WMI pending command 队列堆积         | 重新初始化 WMI 通道、清理 pending 命令、不重启芯片（< 200ms）；失败升级为 Level 2 |
| **SSR Level 2（平台 SSR）** | 固件看门狗 bite / MHI 通道断开 / Level 1 反复失败            | `cnss_subsys_shutdown()` [main.c:3226] → `"subsys shutdown is ignored"` (如已 shutdown)；ramdump 收集完成后 reinit | `__hdd_soc_recovery_shutdown()` → 硬件复位 → `__hdd_soc_probe()` (reinit=true) → 恢复 saved state（SAR/Dual-STA/Scan IE 等）；2-5s 完成 |
| **SSR Level 3（Panic）**    | NOC error / 内存损坏 / 连续 probe 失败超 `SSR_MAX_FAIL_CNT`  | `QDF_BUG()` 触发 kernel panic                                | `wlan_hdd_crash_shutdown()` → `hif_crash_shutdown()`：最小清理、不恢复；系统重启 |

> **调试提示**：排查 WiFi 打不开问题时，建议从 dmesg/logcat 中先搜索 `"Failed to"` 关键字快速定位失败阶段，然后对照上表判断恢复路径。如果日志中看到连续的 `"Retry PCI link training #1, #2, #3"` 然后失败，基本可以确认是硬件问题（PCB 信号完整性、芯片焊接不良等）。

SSR 的恢复能力和上篇的驱动加载流程一脉相承——加载阶段建立的 SSR 框架和状态机是 SSR 能够「无缝恢复」的基础。

---

# 7 完整时间线：从 insmod 到芯片就绪

把所有步骤按时间顺序排列。注意：MTK 和 QCOM 的时间线有细微差异——MTK 的 conninfra 初始化发生在 WLAN 模块加载之前，而 QCOM 的 cnss2 初始化和 qcacld-3.0 初始化是两个独立模块的加载过程。

> **数据来源说明**：下表的时间线符号名（QCOM 与 MTK 两侧函数名）已逐行 grep 复核——MTK 侧步骤 0-6 的 `connv2_drv_init`/`initWlan`/`glRegisterBus`/`mtk_pci_probe`/`wlanProbe`/`mcu_init` 均与源码一致；耗时数据为典型值范围（经验估算），实际值因芯片型号、固件版本、平台配置差异较大。

| 步骤     | QCOM 事件                                             | MTK 事件                                              | 典型耗时       | 最大变量                                                     |
| -------- | ----------------------------------------------------- | ----------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| 0        | --                                                    | conninfra_dev_init → connv2_drv_init                  | 100-200ms      | 设备树解析、消息线程创建                                     |
| 1        | `insmod qcacld-3.0.ko`                                | `initWlan()`                                          | 50-100ms       | 内核模块符号解析、依赖加载                                   |
| 2        | `hdd_driver_load()`                                   | `glRegisterBus()` + `glBusFuncOn()`                   | 10-30ms        | 内存分配、回调注册                                           |
| 3        | cnss2: `cnss_pci_init()` → `cnss_pci_enumerate()`     | `pci_register_driver()` → `mtk_pci_probe()`           | 50-200ms       | PCIe 链路训练（Gen2 vs Gen3）、是否需要重试                  |
| 4        | `cnss_pci_probe()`（上电/SMMU/MSI/MHI）               | `mtk_pci_probe()`（BAR 映射/MSI/DMA）                 | 20-50ms        | regulator 上电时序、MSI 向量数量                             |
| 5        | `hdd_soc_probe()` → `hdd_context_create()`            | `wlanProbe()` → `wlanNetCreate()`                     | 50-150ms       | INI 文件大小（QCOM）、NVRAM 加载（MTK）                      |
| 6        | `hdd_hif_open()` + `ol_cds_init()`                    | `glBusInit()` + `mcu_init()`                          | 10-40ms        | BMI 模式切换、MCU IDLE 状态等待                              |
| 7        | `request_firmware()`（通过 QMI）                      | `request_firmware()`（标准 API）                      | 50-500ms       | 固件文件大小（1-5MB）、存储介质速度（UFS vs eMMC）、是否需要解压 |
| 8        | QMI 分段固件下载                                      | HIF cut-through 固件 dump                             | 100-500ms      | 固件大小、QMI 分段数（每个 segment 有 RTT 开销）             |
| 9        | WMI_SERVICE_READY → WMI_SERVICE_AVAILABLE → WMI_READY | FW Ready 位轮询（`wlanCheckWifiFunc`）                | 50-300ms       | 固件自身初始化时间（MCU 时钟频率、ROM patch 应用）、EXT 事件等待 |
| 10       | `cds_open()`（WMA→SME→PE 子系统打开）                 | `wlanQueryNicCapability()` + `nicInitializeAdapter()` | 30-100ms       | 子系统数量、能力查询的往返次数                               |
| 11       | `wiphy_register()` → cfg80211                         | `wlanNetRegister()` → `register_netdev()`             | 10-30ms        | cfg80211 回调链长度、netdev 命名冲突检测                     |
| 12       | wpa_supplicant `main()` → `eloop_run()`               | 同左                                                  | 100-300ms      | EAP 方法注册数量、配置文件大小、binder 注册延迟              |
| **总计** | insmod → 芯片就绪                                     | --                                                    | **0.5-2.5 秒** | 最快：UFS + 小固件 + Gen3 PCIe + 无链路重试; 最慢：eMMC + 大固件 + Gen2 PCIe + 重试 |

如果把这张表竖着读，就是这家餐厅从「领到营业执照」到「点亮门口招牌」的完整倒计时。绝大多数环节都在毫秒级——唯独「把菜谱装进厨房设备」（固件下载）这一项，会随菜谱厚度（固件大小）和装订速度（UFS 还是 eMMC）从 50ms 一路膨胀到 500ms，成为整条时间线里最不受老板控制的变量。

## 7.1 固件文件读取：最大的不可控变量

`request_firmware()` 的实际耗时远大于纯 I/O 时间。影响它的因素包括：

1. **存储介质速度**：UFS 3.1（~2000 MB/s）vs eMMC 5.1（~250 MB/s）。一个 3MB 固件，纯 I/O 分别是 1.5ms 和 12ms。但实际耗时大得多。
2. **VFS 层开销**：`request_firmware()` 会先在 `/lib/firmware/` 的缓存中查找。如果之前有进程加载过同一个固件，VFS 的 inode/dentry 缓存命中，直接返回。如果没有缓存命中，需要走完整的文件系统路径（open → read → close）。
3. **解压缩开销**：如果固件是 xz 压缩的（`mt6639_n9.bin.xz`），内核需要解压缩。对于 3MB 的压缩文件，解压可能耗时 50-100ms。
4. **固件加载路径**：`request_firmware()` 有 direct 和 fallback 两种模式。Direct 模式直接通过 VFS 加载；Fallback 模式通过 uevent 通知用户空间的 `ueventd`，`ueventd` 从文件系统读取固件内容后写入 sysfs 的 `firmware/loading` 节点。Fallback 模式比 direct 慢一个数量级，因为涉及用户空间进程调度。

## 7.2 QCOM 的加载为什么通常比 MTK 慢？

核心原因在 QMI 协议。QCOM 的固件下载通过 QMI 需要多次握手：

- `QMI_WLFW_BDF_DOWNLOAD_REQ` → 等待 Response
- `QMI_WLFW_M3_INFO_REQ` → 等待 Response
- `QMI_WLFW_WLAN_CFG_REQ` → 等待 Response
- `QMI_WLFW_WLAN_MODE_REQ` → 等待 Response

每次握手都有一个 RTT（Round-Trip Time）延迟——Host 发送请求消息，等待固件通过 MHI 通道返回响应。即使固件处理速度无限快，这个 RTT 也有 MHI 通道的固定延迟（PCIe 总线事务 + MHI 门铃寄存器写读往返，量级在毫秒级）。几百次分段传输累积下来，RTT 开销可能是 100-300ms。

MTK 的 HIF cut-through 模式没有这种握手——它一次性把固件 dump 到芯片内存，然后用一个 Ready 位来确认下载成功。省去了中间的所有 RTT。

但 QCOM 方式的优势在故障场景：如果固件下载中某个 segment 发生 DMA 错误（例如因为 PCIe link flapping），QMI 可以单独重传那个 segment——固件告诉 Host「segment 42 CRC 校验失败」，Host 重发 segment 42。MTK 方式如果 Ready 位超时，需要整个固件重新下载。

---

# 8 总结：从加载到就绪的关键设计决策

## 8.1 为什么固件不能直接放芯片 ROM 里？

这是最常被问的问题。答案有三层：

1. **灵活性（最重要）**：固件包含完整的 WiFi 协议栈，这些代码需要频繁更新——修复安全漏洞、适配新的 regulatory 要求（如 6GHz 频段开放）、支持新功能。ROM 不可修改。如果把固件烧在 ROM 里，一次 FCC/CE regulation update 就可能让整个芯片不合规。
2. **成本**：ROM 的面积效率低于 SRAM（同样容量的存储单元，ROM 在硅片上占用的面积更大），而且 ROM 越大芯片成本越高。现代 WiFi 固件动辄 2-5MB，全放在 ROM 里不经济。
3. **启动速度**：ROM 的读取速度通常比 SRAM 慢。固件加载到 SRAM 中执行比从 ROM 中执行快得多。

最优策略是 ROM + RAM 混合：ROM 中放最小化的 boot code（几百 KB，负责初始化硬件和接收 Host 下发的固件），固件主体放文件系统，Host 每次启动时下载到芯片 RAM。

## 8.2 QCOM 的三层对象模型 vs MTK 的扁平 ADAPTER

这是驱动架构设计中的经典争论点，没有标准答案：

**三层对象模型的优势**：

- 概念清晰：psoc ↔ 物理芯片、pdev ↔ RF 前端、vdev ↔ 逻辑接口。一对一映射，调试时你知道每个对象处于什么状态。
- 解耦：新增功能模块只需实现 create/destroy/status 回调，注册到全局表中。核心 objmgr 逻辑不需要修改。
- 引用计数：防止 use-after-free——ref 计数归零时自动销毁对象。

**代价**：

- 内存和 CPU 开销：每个对象的创建遍历所有组件回调。一个完整的 psoc→pdev→vdev→peer 创建链涉及数十次函数调用。
- 过度设计：对于只有一颗芯片、一个 RF 前端的设备，三层模型显得大材小用。

**扁平 ADAPTER 的优势**：

- 简单高效：所有状态在一个结构体中，访问不需要跨层指针解引用。内存局部性好（一个 cache line 能命中更多字段）。
- 代码路径短：没有虚函数调用的开销（虽然函数指针表本质上也是间接调用）。
- 灵活：新增字段只需在 ADAPTER 中加一个成员，不需要实现一套回调接口。

**代价**：

- 维护成本：ADAPTER 持续膨胀，最终变成数千个字段的「超级结构体」。新工程师很难理解哪些字段在哪个阶段有效。
- 耦合：所有子系统共享同一个 ADAPTER，改动 A 的初始化顺序可能影响 B。

这两种设计的选择反映了 QCOM（「软件公司卖芯片」）和 MTK（「芯片公司卖 turnkey 方案」）不同的商业模式。

## 8.3 SSR 的分层设计：为什么不是一级恢复？

SSR 的三级体系（QCOM）或两级体系（MTK）不是设计出来的，而是**工程中迭代出来的**。

最初的设计只有一级：芯片崩溃 → 整芯片复位 → 重新加载驱动。但实践中发现：

1. 很多「崩溃」其实不是崩溃——WMI 命令超时可能只是因为固件在处理一个耗时操作（如扫描 6GHz 全信道），等几秒就恢复了。整芯片复位会丢掉当前的扫描结果和连接状态，用户体验很差。
2. 有些崩溃是致命的——NOC error 或内存损坏意味着硬件本身出了问题，重启驱动也没用，反而可能因为反复重试导致系统 hang 住。

因此演化出了分层策略：

- **Level 1（自恢复）**：处理 transient 错误。成本最低（< 200ms），用户无感。但只适用于软件层面的临时故障。
- **Level 2（平台 SSR）**：处理固件级故障。成本中等（2-5s），用户会看到 WiFi 短暂断开又恢复。这是最常见的恢复路径。
- **Level 3（Panic）**：处理硬件级故障。成本最高（系统重启），但这是最后的防线——与其让系统在损坏的硬件上继续运行导致数据损坏，不如直接重启。

MTK 走的是两级分法（子系统复位 vs 整芯片复位），但逻辑相同：能用小代价恢复的就用小代价，只有确认小代价无效时才升级。

## 8.4 完整端点速查表

| 环节               | QCOM (qcacld-3.0)                                            | MTK (wlan-core-gen4m)                                        |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| insmod 入口        | `hdd_module_init()` → `hdd_driver_load()`                    | `initWlan()` → `glRegisterBus()`                             |
| 平台层注册         | `pld_register_driver()` → cnss2 / icnss2 回调                | `glRegisterBus()` → `pci_register_driver()` / `sdio_register_driver()` |
| PCIe 枚举          | `cnss_pci_probe()` → 上电 / SMMU / MHI                       | `mtk_pci_probe()` → BAR 映射 / MSI / DMA                     |
| 对象创建           | `hdd_context_create()` → `wlan_objmgr`（psoc → pdev → vdev → peer） | `wlanNetCreate()` → `ADAPTER`（扁平）                        |
| 固件下载           | QMI 分段传输（MHI channel，每段 ≤ `QMI_WLFW_MAX_DATA_SIZE`） | HIF cut-through 一次性 dump + `wlanDownloadFW()`（N9 + CR4 + DSP） |
| 握手确认           | WMI 三步握手（SERVICE_READY → SERVICE_AVAILABLE → READY）+ EXT/EXT2 | `wlanCheckWifiFunc()` 寄存器轮询（INIT_DONE / N9_DONE / CR4_READY） |
| 内核注册           | `wiphy_register()` → cfg80211                                | `wlanNetRegister()` → `register_netdev()`                    |
| 事件循环           | QDF work queue + OSIF sync transition                        | 消息线程（main / hif / rx / conninfra_cored / conninfra_cb） |
| QCOM Level 1 SSR   | 驱动 WMI 超时检测                                            | 重新初始化 WMI 通道，不重启芯片（< 200ms）                   |
| QCOM Level 2 SSR   | `__hdd_soc_recovery_shutdown()` → reinit                     | shutdown → 硬件复位 → probe(reinit=true) → 状态恢复（2-5s）  |
| QCOM Level 3 Panic | `wlan_hdd_crash_shutdown()`                                  | 最小化清理，触发 kernel panic，系统重启                      |
| MTK 子系统复位     | `asicConnac3xSwIntHandler()` → `SW_INT_SUBSYS_RESET`         | 仅复位 WiFi 子系统，BT 继续工作                              |
| MTK 整芯片复位     | `asicConnac3xSwIntHandler()` → `SW_INT_WHOLE_RESET`          | conninfra 协调 WiFi+BT 顺序复位                              |
| 状态恢复           | `hdd_restore_*()` 系列                                       | SAR / Dual-STA / Scan IE / 缓存命令恢复                      |

> **表格说明**：SSR 行（Level 1/2/3 和子系统/整芯片复位）是平台特定的——QCOM 的三列对应 QCOM 的 SSR 机制，MTK 的两列对应 MTK 的复位机制。"状态恢复"行是两者共有的。

到这里，这家餐厅就算正式开张了——营业执照（内核注册）已领、水电煤气（PCIe 通道）已通、菜谱（固件）已装进设备、菜单（WMI 能力）已对账完毕，只等第一位客人（wpa_supplicant）推门进来点单。

---

> 驱动加载完成、芯片就绪，崩溃恢复机制也已就位。接下来的问题是：wpa_supplicant 是怎么启动的？eloop 事件循环是怎么工作的？AIDL binder 是怎么把 Java Framework 和 native Supplicant 连起来的？

> **下一章**：芯片就绪后，wpa_supplicant 守护进程启动，通过 eloop 事件循环统一调度内核事件（nl80211）、binder 请求（AIDL）和 EAPOL 帧。我们会看到从 `main()` 到 `eloop_run()` 的四步启动，eloop 的 epoll 后端实现，以及 AIDL binder fd 如何注册到 eloop 中实现 Java ↔ native 通信。

*本文涉及的技术协议：PCI Express Base Specification（PCIe 链路训练与 MSI 中断）、QCOM MHI 协议（Modem Host Interface，Host-Firmware 通信通道定义）、QCOM WMI 协议（Wireless Module Interface，TLV 编码的命令/事件体系）。驱动加载流程属于厂商实现层，不受 IEEE 802.11 协议正文直接约束。源码路径索引见文内各代码块首行注释。*

**源码出处**：QCOM [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0)、[qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn)、[platform](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-platform)；MTK [gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)、[conninfra](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-conninfra)。
