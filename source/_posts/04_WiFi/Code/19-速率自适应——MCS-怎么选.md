---
title: 速率自适应——MCS 怎么选
top: 1
related_posts: true
abbrlink: 484f6ef9
date: 2026-09-24 23:53:35
tags:
  - Android WiFi
  - MCS
categories:
  - WiFi
  - Code
---

> 手机连上 WiFi，视频开始缓冲，网页一个个打开。每一个数据帧从网卡出去之前，都要回答一个问题：这一帧用哪个速率发？MCS 0 最稳但最慢，MCS 11 最快但信道稍微一抖就丢包（EHT 再扩到 MCS 12-15）。谁在替手机做这个"看菜下饭"的决定？很多人会猜——"QCOM 有 RA 引擎，MTK 有 RLM"。但真的追进源码会发现，这话只对了一半：QCOM 主机里并没有一个叫"RA 引擎"的东西，MTK 的 RLM 也压根不在选速率。真正掌勺的，两家的固件里各藏着一个不露面的厨师。

---

# 本章导读

WiFi 源码分析系列反复在画一张地图：一次 WiFi 操作，代码从 Framework 一路沉到 QCOM / MTK 的固件，每层各管什么。这张地图一路画下来，有一个反复出现的结论——**管理面在主机、执行面在固件**，根源是时间尺度。这一篇，我们拿"速率自适应"（Rate Adaptation，简称 RA）再来验一次这句话，而且这次会得到一个更彻底的答案：**RA 不只"执行在固件"，连"决策"都在固件**——主机连算法都看不到，只剩三样东西能碰。

<!--more-->

先说清楚"速率自适应"是什么。一个数据帧发射前，驱动/芯片要决定用哪一档调制编码方案（MCS，Modulation and Coding Scheme）。MCS 是 802.11 给每一档速率编的号——它把调制方式（BPSK / QPSK / 16-QAM / 1024-QAM…）、编码速率（1/2、2/3、3/4…）、空间流数（NSS）、带宽、保护间隔（GI）打包成一个索引。信道好就用高阶 MCS（快），信道差就降阶（稳）。**"怎么根据信道质量决定升还是降"这件事，就是 RA**。

关键在最后半句——802.11 规范只定义了 MCS 有哪些档位（速率表是死的菜单），**从没规定"什么时候升、什么时候降"**。升降级算法是纯实现，各写各的。所以这一篇不是讲协议，是讲"这段实现代码落在安卓 WiFi 栈的哪一层"。

把整条 WiFi 栈想成一家餐厅：大堂经理是主机（Framework 与驱动），后厨是固件。这一次，我们把镜头推进后厨——因为"每一帧用什么火候"这个决策，恰好是掌勺的活。整家餐厅里，**只有掌勺的人才知道今天该用多大的火**，其他人要么递菜谱、要么定规矩、要么看账本：

- **软 MAC**：后厨没有专职厨师，大堂经理（主机 kernel 里的 Minstrel-HT）自己卷袖子下厨——每个站记一本账，每 `HZ/20`（约 50ms）算一次"哪档速率吞吐最高"，还每隔 `HZ/50`（约 20ms）留一帧当"试菜"去探测新速率。
- **full-mac（QCOM / MTK）**：后厨有个闭门厨师（固件 RA 引擎），大堂经理（主机）摸不到炒锅，只剩三件事能干——**递菜谱**（速率表，只做换算不做决策）、**定规矩**（参数下发，给固件的 RA 定边界和覆盖命令）、**看账本**（统计上报，读固件 RA 的结果）。

本文回答四个问题：

- 为什么"用哪个 MCS"的答案，在 full-mac 主机源码里根本找不到？
- 软 MAC 的 Minstrel-HT 是怎么在主机把速率选出来的？它的算法长什么样？
- QCOM / MTK 主机各自留下的"菜谱、规矩、账本"三层，具体是什么代码？
- 为什么 full-mac 的 RA 必须沉进固件？主机能不能硬把它抢回来？

本文聚焦 RA **在源码里的落层**，不展开固件 RA 引擎本体（MCS 升降级的决策循环在闭源固件里，主机不可见，明确标注"在固件"）。Minstrel-HT 算法细节只做"软 MAC 参照"简述，不深入（它不在本文 full-mac 的范围）。协议断言已对照 802.11-2024 + 802.11be-2024 规范验证：MCS 定义见 §19.3.5（HT-MCS）、§21.3.5（VHT-MCS）、§27.3.7（HE-MCS）、§36.3.8 / §36.5（EHT-MCS，802.11be-2024），均为"速率表/参数"层面的定义。RA 升降级算法本身不是规范内容，是驱动实现。

先看一张全局图：RA 决策分别落在哪一层，主机能碰到什么、碰不到什么。颜色语义：橙 = 主机下发（参数/约束），绿 = 结果回传（统计），虚线 = 主机不可见的固件边界。注意软 MAC 那条：Minstrel-HT 整个在主机跑（绿色闭环），而 full-mac 那条，决策和统计都在固件（虚线框内），主机只在左右两端伸了两只手。

![速率自适应落层全景图](assets/19-%E9%80%9F%E7%8E%87%E8%87%AA%E9%80%82%E5%BA%94%E2%80%94%E2%80%94MCS-%E6%80%8E%E4%B9%88%E9%80%89/19-architecture-callchain.svg)

理解了"决策在谁手里"，接下来从最扎眼的反差开始——为什么 full-mac 的主机源码里，翻遍也找不到"MCS 升降级"的算法。

---

# 1 为什么「用哪个 MCS」的答案，主机源码里找不到？

先确认一件事：我们到底在找什么。RA 算法的输入是信道质量（SNR / RSSI）、丢包率（PER）、重传次数、ACK 反馈；输出是一个"当前该用 MCS 几、NSS 几、带宽多少"的决定，以及每帧重试时降几档的链（重试链）。这个输入输出闭环，就是 RA 引擎。

在软 MAC 里，这个闭环整个在主机：mac80211 收到 TX 状态（成功/失败），喂给 Minstrel-HT，它算出一个"最佳速率集"写回硬件。所以你翻 `net/mac80211/rc80211_minstrel_ht.c`，能看到完整的"算概率 → 估吞吐 → 排序选速率 → 填重试链"。这套代码是活的、在主机跑的。

但在 QCOM / MTK 的 full-mac 主机源码里，你翻不到这个闭环。翻得到的只有三样东西：

1. **速率表换算**（词典）——`dp_getrateindex()` 这类函数，把 rate index ↔ kbps ↔ modulation ↔ NSS ↔ MCS ↔ GI 互相换算。它是个"查表机器"，输入输出都是死的数字，没有一行业务判断。
2. **参数下发**（规矩）——`wmi_unified_set_ratepwr_chainmsk_cmd_send()` 这类 WMI 命令，把速率上限、速率掩码、固定速率、探测间隔这些"约束"发给固件。它是给固件 RA 定边界的，不定速率。
3. **统计消费**（账本）——`htt_stats_peer_tx_rate_stats_tlv` 这类结构，读固件上报的逐 MCS 计数、ACK RSSI、重传/成功数。它是读 RA 的**结果**，不是参与 RA 的**过程**。

这三样，恰好对应"菜谱、规矩、账本"。**没有一样是"厨师"**——真正的升降级决策，在固件里。这就是本文的核心判断：**速率自适应的位置由驱动架构决定**——软 MAC 的 RA 在主机，full-mac 的 RA 在固件，主机只能"能看能管边界，不能亲自操盘"。

这里先把开篇埋的一个坑填了：很多人看到"MTK 有 RLM"就以为它是 RA——**其实 MTK 的 RLM（Radio Link Management）不是 RA**。RLM 是"无线链路管理"，管的是能力位协商（HT/VHT/HE Cap IE 的填与解）、保护模式（ERP / HT protection）、监管域（regulatory domain，功率限制）——这些是"这条链路支持什么"和"这条链路被什么约束"，不是"这一帧用哪个 MCS"。把 RLM 当成 RA，是看错了门牌。真正的 RA，MTK 也在固件里。

那么先回到参照系——软 MAC 的 Minstrel-HT 到底怎么把速率选出来？只有看懂了这个"主机版厨师"，后面才能看清 full-mac 主机到底"缺"了什么。

---

# 2 软 MAC 参照系：Minstrel-HT 怎么在主机把速率选出来？

Minstrel-HT 是 Linux mac80211 的默认 RA 算法。它跑在主机 kernel 里，每个 STA（关联的站点）维护一张"速率账本"，每个统计周期（`update_interval = HZ/20`，约 50ms）结算一次。它的核心是四件事：**EWMA 平滑成功率**、**吞吐估计**、**lookaround 探测**、**多速率重试链（MRR）**。这四件事，就是"主机版厨师"的完整手法——看懂它，等于拿到一把尺子，后面量 full-mac 主机时就知道它缺了哪几样。

先看成功率怎么算。每个速率档位（rate stats）都有 `success` / `attempts` 两个计数器，结算时算出一个瞬时成功率，再做指数加权移动平均（EWMA）平滑：

```c
// net/mac80211/rc80211_minstrel_ht.c:766
static void
minstrel_ht_calc_rate_stats(struct minstrel_priv *mp,
			    struct minstrel_rate_stats *mrs)
{
	unsigned int cur_prob;

	if (unlikely(mrs->attempts > 0)) {
		cur_prob = MINSTREL_FRAC(mrs->success, mrs->attempts);
		minstrel_filter_avg_add(&mrs->prob_avg,
					&mrs->prob_avg_1, cur_prob);
		mrs->att_hist += mrs->attempts;
		mrs->succ_hist += mrs->success;
	}

	mrs->last_success = mrs->success;
	mrs->last_attempts = mrs->attempts;
	mrs->success = 0;
	mrs->attempts = 0;
}
```

```c
// net/mac80211/rc80211_minstrel_ht.h:20
#define EWMA_LEVEL	96	/* ewma weighting factor [/EWMA_DIV] */
#define EWMA_DIV	128
```

- `cur_prob = MINSTREL_FRAC(success, attempts)`：本周期成功率 = 成功数 / 尝试数，`MINSTREL_FRAC` 是 12 位定点（`MINSTREL_SCALE = 12`）的除法。
- `minstrel_filter_avg_add(&prob_avg, &prob_avg_1, cur_prob)`：把瞬时成功率喂进低通滤波器，得到平滑后的 `prob_avg`（长期成功率）——单帧抖动不会直接改结论。
- 平滑常量 `EWMA_LEVEL / EWMA_DIV = 96 / 128 = 0.75`（`rc80211_minstrel_ht.h:20`）是 Minstrel 家族经典的 EWMA 系数，代码里 `minstrel_ewma()` 用它做指数平均（新样本权重 0.25、历史 0.75）；成功率 `prob_avg` 则用 `MINSTREL_AVG_COEFF1/2/3` 的二级滤波器，同样"历史权重远大于新样本"。两处都在抹平单帧抖动。
- 结尾把 `success` / `attempts` 清零，进入下一个统计周期。

成功率只能回答"这一档稳不稳"，但稳不等于值得用——一档几乎必成功的最低速，吞吐反而不如偶尔丢包的中高速。所以光有成功率还不够，得把它和速率捏成一个数：**期望吞吐**。

Minstrel-HT 的吞吐估计不是直接 `概率 × 速率` 那么简单——成功率低于 10% 直接判死刑（`return 0`），成功率超过 90% 就封顶（防止过高估计），再把重传次数折算成额外空口时间：

```c
// net/mac80211/rc80211_minstrel_ht.c:500
int
minstrel_ht_get_tp_avg(struct minstrel_ht_sta *mi, int group, int rate,
		       int prob_avg)
{
	unsigned int nsecs = 0, overhead = mi->overhead;
	unsigned int ampdu_len = 1;

	/* do not account throughput if success prob is below 10% */
	if (prob_avg < MINSTREL_FRAC(10, 100))
		return 0;

	if (minstrel_ht_is_legacy_group(group))
		overhead = mi->overhead_legacy;
	else
		ampdu_len = minstrel_ht_avg_ampdu_len(mi);

	nsecs = 1000 * overhead / ampdu_len;
	nsecs += minstrel_mcs_groups[group].duration[rate] <<
		 minstrel_mcs_groups[group].shift;

	/*
	 * For the throughput calculation, limit the probability value to 90% to
	 * ...
	 */
	// ...省略：按 prob_avg 折算重传期望次数，概率封顶 90%，返回"吞吐"值（越大越好）
}
```

- 这就是 Minstrel 的吞吐估计 `T = p × R` 的落地形态：`p` 是成功率（夹在 10% 和 90% 之间），`R` 是该速率对应的空口时间（duration 是查表得到的固定值）。
- 成功率太低（<10%）→ 吞吐记 0，这档速率不会入选；成功率太高（>90%）→ 封顶，防止"几乎不发错"的低速率被误判成最优。
- 返回值本质是"期望空口时间的倒数"：重传越多，期望时间越长，吞吐越低——所以高 MCS 若 PER 高，反而会输给稳一点的低 MCS。

每个统计周期（`update_interval = HZ/20`，约 50ms），`minstrel_ht_update_stats()` 遍历所有 MCS 组、所有速率档，用上面的吞吐值排序，选出吞吐最高的几档存进 `max_tp_rate[]`，再选一档"成功率最高"的存进 `max_prob_rate`：

```c
// net/mac80211/rc80211_minstrel_ht.c:1059
static void
minstrel_ht_update_stats(struct minstrel_priv *mp, struct minstrel_ht_sta *mi)
{
	struct minstrel_mcs_group_data *mg;
	struct minstrel_rate_stats *mrs;
	int group, i, j, cur_prob;
	// ...省略局部变量...

	/* Find best rate sets within all MCS groups*/
	for (group = 0; group < ARRAY_SIZE(minstrel_mcs_groups); group++) {
		// ...省略...
		for (i = MCS_GROUP_RATES - 1; i >= 0; i--) {
			// ...省略...
			mrs = &mg->rates[i];
			mrs->retry_updated = false;
			minstrel_ht_calc_rate_stats(mp, mrs);
			// ...省略...
			cur_prob = mrs->prob_avg;

			if (minstrel_ht_get_tp_avg(mi, group, i, cur_prob) == 0)
				continue;

			/* Find max throughput rate set */
			minstrel_ht_sort_best_tp_rates(mi, index, tp_rate);
			// ...省略...
		}
		// ...省略...
	}
	// ...省略：把最优吞吐速率集写回 mi->max_tp_rate
}
```

- 每档速率先 `minstrel_ht_calc_rate_stats()` 结算成功率，再 `minstrel_ht_get_tp_avg()` 估吞吐，吞吐为 0 的直接跳过。
- `minstrel_ht_sort_best_tp_rates()` 做插入排序，把当前速率按吞吐插进最优集，最终 `max_tp_rate[]` 里是吞吐最高的几档。
- 这是"每个统计周期选一次最佳速率"的实现：一个周期里把所有速率都翻一遍，选出冠军和备胎。

选完速率，还有两件事：探测新速率（lookaround）和填重试链（MRR）。探测的入口是 `minstrel_ht_get_rate()`，它被 mac80211 在发帧前调用，每隔 `MINSTREL_SAMPLE_INTERVAL`（`HZ/50`，即 20ms）挑一帧当"试菜"，用非最优速率发出去看看效果：

```c
// net/mac80211/rc80211_minstrel_ht.c:1595
static void
minstrel_ht_get_rate(void *priv, struct ieee80211_sta *sta, void *priv_sta,
                     struct ieee80211_tx_rate_control *txrc)
{
	// ...省略...
	if (time_is_after_jiffies(mi->sample_time))
		return;

	mi->sample_time = jiffies + MINSTREL_SAMPLE_INTERVAL;
	sample_idx = minstrel_ht_get_sample_rate(mp, mi);
	if (!sample_idx)
		return;
	// ...省略...
	info->flags |= IEEE80211_TX_CTL_RATE_CTRL_PROBE;
	rate->count = 1;
	// ...省略：把探测速率填进 rate->idx
}
```

- `MINSTREL_SAMPLE_INTERVAL = HZ / 50`（`rc80211_minstrel_ht.h:73`），约 20ms 一次探测——这就是 lookaround 探测的机制：留一小部分帧去试其他速率，而不是永远用当前最优。
- 探测帧打上 `IEEE80211_TX_CTL_RATE_CTRL_PROBE` 标记，`rate->count = 1`（只试一帧，失败就停，别连累重传）。
- 为什么留探测？因为不探测，信道变好你也不会知道——最优速率是"试"出来的，不是算出来的。这是 Minstrel 家族的核心哲学。

最后是重试链。`minstrel_ht_update_rates()` 把选好的速率按"最优吞吐 → 次优吞吐 → 最高成功率"排成一串，写进硬件的重试表——第一帧用最高吞吐，重试时逐级降到更稳的档：

```c
// net/mac80211/rc80211_minstrel_ht.c:1550
static void
minstrel_ht_update_rates(struct minstrel_priv *mp, struct minstrel_ht_sta *mi)
{
	struct ieee80211_sta_rates *rates;
	int i = 0;
	int max_rates = min_t(int, mp->hw->max_rates, IEEE80211_TX_RATE_TABLE_SIZE);
	// ...省略 alloc...

	/* Start with max_tp_rate[0] */
	minstrel_ht_set_rate(mp, mi, rates, i++, mi->max_tp_rate[0]);

	/* Fill up remaining, keep one entry for max_probe_rate */
	for (; i < (max_rates - 1); i++)
		minstrel_ht_set_rate(mp, mi, rates, i, mi->max_tp_rate[i]);

	if (i < max_rates)
		minstrel_ht_set_rate(mp, mi, rates, i++, mi->max_prob_rate);
	// ...省略：末位填 -1 收尾，写回硬件
}
```

- `max_rates = min(hw->max_rates, IEEE80211_TX_RATE_TABLE_SIZE)`，`IEEE80211_TX_RATE_TABLE_SIZE` 通常是 4——这就是"4 级多速率重试链（MRR）"：首帧最高吞吐、重试逐级降、最后兜底到最高成功率那档。
- 这四档串起来 = "先快后稳"：第一枪赌高 MCS，赌输了退一档，再输再退，最后一档几乎必成。
- 至此软 MAC 的 RA 闭环完整了：发帧 → TX 状态回传 → 结算成功率（EWMA）→ 估吞吐 → `HZ/20` 排序选速率 + 20ms 探测 + 4 级重试链 → 写回硬件。

把这四段代码拼起来看，Minstrel-HT 选速率的思路一句话就够：记清每档的成败、抹平偶然抖动、按吞吐排出名次、再留一帧试新菜、备好重试的退路。

记住这个闭环的五件套：**成功/失败计数、EWMA 平滑、吞吐估计、lookaround 探测、MRR 重试链**。现在去 full-mac 主机里找这五件套，你会扑个空——能找到的只有"菜谱、规矩、账本"。先看 QCOM。

---

# 3 QCOM 主机留下了哪三层？——菜谱、规矩、账本

QCOM 的 full-mac 架构（qcacld-3.0）把 RA 整个搬进了固件。主机侧翻遍，跟"选速率"沾边的代码分成三层，但没有一层是"决策"。这一节逐层拆开，看它们各自为什么不是 RA。

## 3.1 菜谱：`dp_ratetable.c` 是查表机器，不是厨师

`dp_ratetable.c` 有 7295 行，是全主机最大的速率相关文件。但它不是一个算法，而是一张**双向换算表**：把 rate index、kbps、modulation、NSS、MCS、GI 这些量两两换算。它的主力函数 `dp_getrateindex()` 做的是"给我 preamble / bw / nss / mcs / gi，我查出对应的 rate index 和 kbps"：

```c
// qca-wifi-host-cmn/dp/cmn_dp_api/dp_ratetable.c:6602
uint32_t
dp_getrateindex(uint32_t gi, uint16_t mcs, uint8_t nss, uint8_t preamble,
		uint8_t bw, uint8_t punc_bw, uint32_t *rix, uint16_t *ratecode)
{
	uint32_t ratekbps = 0, res = RT_INVALID_INDEX; /* represents failure */
	uint16_t rc;
	enum DP_CMN_MODULATION_TYPE mod;

	/* For error case, where idx exceeds boundary limit */
	*ratecode = 0;
	mod = dp_getmodulation(preamble, bw, punc_bw);
	if (mod >= DP_CMN_MOD_IEEE80211_T_MAX_PHY)
		goto done;

	rc = mcs;

	/* get the base of corresponding rate table  entry */
	res = _rc_idx[mod];

	switch (preamble) {
	case DP_CMN_RATECODE_PREAM_HE:
		res += rc + nss * NUM_HE_MCS;
		break;
	// ...省略：EHT / VHT / HT / CCK / OFDM 各 preamble 分支...
	}
	if (res >= DP_RATE_TABLE_SIZE)
		goto done;

	if (!gi) {
		ratekbps = dp_11abgnratetable.info[res].userratekbps;
	} else {
		switch (gi) {
		case CDP_SGI_0_4_US:
			ratekbps = dp_11abgnratetable.info[res].ratekbpssgi;
			break;
		// ...省略：1.6us / 3.2us 等 GI 分支...
		}
	}
	*ratecode = dp_11abgnratetable.info[res].ratecode;
done:
	*rix = res;

	return ratekbps;
}
```

- 函数签名里没有"信道质量"也没有"决策"——输入是死的（gi / mcs / nss / preamble / bw），输出也是死的（rate index、kbps、ratecode）。
- `res = _rc_idx[mod] + rc + nss * NUM_HE_MCS` 是在算偏移量，然后从 `dp_11abgnratetable.info[]` 这张静态表里取出 `userratekbps` / `ratekbpssgi`——纯粹的查表。
- 这是"词典"不是"厨师"：词典能告诉你"MCS 7 在 2 流 80MHz 下是多少 kbps"，但不能告诉你"现在该不该用 MCS 7"。后者是固件的活。

反向换算 `dp_rate_idx_to_kbps()` 更短，就是"index → kbps"：

```c
// qca-wifi-host-cmn/dp/cmn_dp_api/dp_ratetable.c:6679
int dp_rate_idx_to_kbps(uint8_t rate_idx, uint8_t gintval)
{
	if (rate_idx >= DP_RATE_TABLE_SIZE)
		return 0;

	if (!gintval)
		return RT_GET_RAW_KBPS(&dp_11abgnratetable, rate_idx);
	else
		return RT_GET_SGI_KBPS(&dp_11abgnratetable, rate_idx);
	return 0;
}
```

- `RT_GET_RAW_KBPS` / `RT_GET_SGI_KBPS` 是宏，从表里取 `.ratekbps` / `.ratekbpssgi` 字段——还是查表。

`dp_ratetable.c` 里还有一对容易被误认成 RA 的函数：`dp_ath_rate_lpf()` / `dp_ath_rate_out()`。名字里带 "rate"，还带低通滤波（lpf），看着很像在"平滑速率决策"。但看实现，它是 ath9k 的遗产——对**已上报的速率**做指数平均，纯粹用于显示：

```c
// qca-wifi-host-cmn/dp/cmn_dp_api/dp_ratetable.h:82
static inline int dp_ath_rate_lpf(uint64_t _d, int _e)
{
	_e = DP_ATH_RATE_IN((_e));
	return (((_d) != DUMMY_MARKER) ? ((((_d) << 3) + (_e) - (_d)) >> 3) :
			(_e));
}
```

- `DP_ATH_RATE_IN(c)` 把输入乘以 `DP_ATH_RATE_EP_MULTIPLIER`（`BIT(7)`，即 128），转成 7 位定点小数。
- 核心算式 `((_d << 3) + _e - _d) >> 3 = (_d*7 + _e)/8`，即新值 = 旧值 × 7/8 + 新样本 × 1/8——一个 α=1/8 的低通滤波。
- 但 `_d` / `_e` 是"已经由固件决定的速率"（比如固件上报的 TX rate），这里只是把一串上报值平均平滑，用于显示和统计，**不参与任何升降级决策**。名字里的 "ATH" 泄露了它的来历——ath9k 时代主机自己算速率的遗产，如今只剩一层壳。

一句话：`dp_ratetable.c` 整本都是"菜谱"，有所有速率的"配方表"，但没有一行"今天炒哪道菜"的判断。

## 3.2 规矩：WMI 参数下发，定边界不定速率

主机不能替固件选速率，但可以**约束**固件怎么选。这一层是一堆 WMI 命令，把"上限、掩码、固定值、探测频率"发给固件。先看 per-rate 功率 / 链掩码命令的入口：

```c
// qca-wifi-host-cmn/wmi/src/wmi_unified_api.c:1387
QDF_STATUS wmi_unified_set_ratepwr_chainmsk_cmd_send(
				wmi_unified_t wmi_handle,
				struct ratepwr_chainmsk_params *param)
{
	if (wmi_handle->ops->send_set_ratepwr_chainmsk_cmd)
		return wmi_handle->ops->send_set_ratepwr_chainmsk_cmd(
						wmi_handle, param);

	return QDF_STATUS_E_FAILURE;
}
```

```c
// qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:3921
struct ratepwr_chainmsk_params {
	uint32_t *ratepwr_chain_tbl;
	uint16_t num_rate;
	uint8_t pream_type;
	uint8_t ops;
};
```

- `ratepwr_chainmsk_params` 里是一张 `ratepwr_chain_tbl` 表 + 速率数量 + preamble 类型——它下发的是"每一档速率的功率和链掩码"，不是"选哪档速率"。
- 典型用法是给低速率降功率、限制链掩码，迫使链路别老掉到低速——是"调整菜单上每道菜的份量"，不是"替顾客点菜"。
- 这个命令经 `wmi_handle->ops` 的函数指针分发到 TLV 序列化，最终变成一条 WMI 消息发给固件。

再看向上封顶的"速率掩码"命令：

```c
// qca-wifi-host-cmn/wmi/src/wmi_unified_vdev_api.c:147
QDF_STATUS
wmi_unified_vdev_config_ratemask_cmd_send(struct wmi_unified *wmi_handle,
					  struct config_ratemask_params *param)
{
	if (wmi_handle->ops->send_vdev_config_ratemask_cmd)
		return wmi_handle->ops->send_vdev_config_ratemask_cmd(
							wmi_handle, param);

	return QDF_STATUS_E_FAILURE;
}
```

```c
// qca-wifi-host-cmn/umac/mlme/vdev_mgr/dispatcher/inc/wlan_vdev_mgr_tgt_if_tx_defs.h:551
struct config_ratemask_params {
	uint8_t vdev_id;
	uint8_t type;
	uint32_t lower32;
	uint32_t higher32;
	uint32_t lower32_2;
	uint32_t higher32_2;
};
```

```c
// qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:4155
enum wmi_ratemask_type {
	WMI_RATEMASK_TYPE_CCK = 0,
	WMI_RATEMASK_TYPE_HT  = 1,
	WMI_RATEMASK_TYPE_VHT = 2,
	WMI_RATEMASK_TYPE_HE  = 3,
};
```

- `config_ratemask_params` 用 `lower32 / higher32 / lower32_2 / higher32_2` 拼出一个 128 位的掩码，按 `type`（CCK / HT / VHT / HE）分类。
- 速率掩码 = 主机说"这几档速率不许用"（对应协议里的 Basic MCS Set 之类的约束）。固件 RA 在这张掩码圈定的集合里挑，但挑哪档还是固件自己定。
- 掩码是"边界"，不是"决策"：主机圈了个菜园子，但摘哪根菜是后厨的事。

除了这两条专用命令，还有一串"通用参数"走 pdev/vdev 参数通道下发，其中几条直接管着固件 RA 的行为：

```c
// qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:6037
PDEV_PARAM(pdev_param_rate_upper_cap, PDEV_PARAM_RATE_UPPER_CAP),
PDEV_PARAM(pdev_param_rate_retry_mcs_drop,
	   PDEV_PARAM_SET_RATE_DROP_DOWN_RETRY_THRESH),
// ...省略...
PDEV_PARAM(pdev_param_mcs_probe_intvl,
	   PDEV_PARAM_MIN_MAX_MCS_PROBE_INTERVAL),
PDEV_PARAM(pdev_param_nss_probe_intvl,
	   PDEV_PARAM_MIN_MAX_NSS_PROBE_INTERVAL),
```

- `pdev_param_rate_upper_cap` → `PDEV_PARAM_RATE_UPPER_CAP`：速率上限，主机说"最高别超过 MCS X"——封顶，不定值。
- `pdev_param_rate_retry_mcs_drop` → `PDEV_PARAM_SET_RATE_DROP_DOWN_RETRY_THRESH`：重传多少次后就降 MCS——这是给固件 RA 的"降档阈值"。
- `pdev_param_mcs_probe_intvl` / `pdev_param_nss_probe_intvl` → `PDEV_PARAM_MIN_MAX_MCS_PROBE_INTERVAL` / `PDEV_PARAM_MIN_MAX_NSS_PROBE_INTERVAL`：MCS / NSS 探测间隔——这是给固件 RA 的"lookaround 频率"。

这几条合起来，几乎就是 Minstrel 五件套里"lookaround 探测 + 重试降档"的参数版——**固件 RA 也做探测和降档，但探测多久一次、重传几次才降，这些旋钮在主机手里**。主机调旋钮，固件转引擎。再补一个"固定速率"的旋钮：

```c
// qca-wifi-host-cmn/wmi/inc/wmi_unified_param.h:6138
VDEV_PARAM(vdev_param_fixed_rate, VDEV_PARAM_FIXED_RATE),
```

- `VDEV_PARAM_FIXED_RATE`：固定速率模式，主机说"就用这个速率，别自适应了"——这是把固件 RA 整个关掉，用于测试/诊断。
- "固定速率"能存在，恰恰反证了正常路径下 RA 在固件：主机若自己能选，就不需要"让固件锁死某个速率"这种命令了。

至此 QCOM 的"规矩"层齐了：**速率上限、速率掩码、固定速率、重传降档阈值、探测间隔、per-rate 功率/链掩码**。全是在给固件 RA 定边界或覆盖它，没有一条在"选速率"。

## 3.3 账本：HTT 统计上报，读固件 RA 的结果

主机碰不到 RA 过程，但能读到 RA 的**结果**——固件周期性把"每个 STA 用了哪些速率、重传几次、ACK 信号多强"打包上报。这个上报结构的定义在 fw-api 里：

```c
// qca-wifi-host-cmn/../../fw-api/fw/htt_stats.h:2610
typedef struct _htt_tx_peer_rate_stats_tlv {
    htt_tlv_hdr_t tlv_hdr;

    /** Number of tx LDPC packets */
    A_UINT32 tx_ldpc;
    /** Number of tx RTS packets */
    A_UINT32 rts_cnt;
    /** RSSI value of last ack packet (units = dB above noise floor) */
    A_UINT32 ack_rssi;

    A_UINT32 tx_mcs[HTT_TX_PEER_STATS_NUM_MCS_COUNTERS];
    A_UINT32 tx_su_mcs[HTT_TX_PEER_STATS_NUM_MCS_COUNTERS];
    A_UINT32 tx_mu_mcs[HTT_TX_PEER_STATS_NUM_MCS_COUNTERS];
    /**
     * element 0,1, ...7 -> NSS 1,2, ...8
     */
    A_UINT32 tx_nss[HTT_TX_PEER_STATS_NUM_SPATIAL_STREAMS];
    /**
     * element 0: 20 MHz, 1: 40 MHz, 2: 80 MHz, 3: 160 and 80+80 MHz
     */
    A_UINT32 tx_bw[HTT_TX_PEER_STATS_NUM_BW_COUNTERS];
    A_UINT32 tx_stbc[HTT_TX_PEER_STATS_NUM_MCS_COUNTERS];
    A_UINT32 tx_pream[HTT_TX_PEER_STATS_NUM_PREAMBLE_TYPES];
    // ...省略：tx_gi[][] / tx_dcm[] / tx_mcs_ext[] 等更细的直方图...
    A_UINT32 peer_tx_ppdu_cnt;
    A_UINT32 peer_tx_mpdu_try_cnt;
    A_UINT32 peer_tx_mpdu_success_cnt;
} htt_stats_peer_tx_rate_stats_tlv;
```

- `tx_mcs[]` / `tx_nss[]` / `tx_bw[]` / `tx_pream[]`：逐 MCS、逐 NSS、逐带宽、逐 preamble 的**直方图**——固件 RA 选了多少帧用 MCS 0、多少帧用 MCS 11、多少帧用 2 流，全都记账。
- `tx_mcs_ext[]` / `tx_mcs_ext_2[]`（`htt_stats.h:2644/2652`）：EHT 在 HE 的 MCS 0-11 之上扩到 MCS 12-15（4096-QAM），单独记账。
- `ack_rssi`：最后一次 ACK 的 RSSI（dB，相对噪声底）——这是固件 RA 的**输入反馈**（SNR 代理），主机读它是为了观察，不是为了决策。
- `peer_tx_mpdu_try_cnt` / `peer_tx_mpdu_success_cnt`：重传总次数 / 成功总次数，两者一除就是 PER——同样是 RA 的输入，主机只能"看到"。
- 这个结构是 `htt_tx_peer_rate_stats_tlv` 的别名（`htt_stats.h:2658` 的 typedef），主机侧在 `dp_stats.c` 里有 `dp_print_tx_peer_rate_stats_tlv()`（:1123）负责打印解析。

主机读完统计，最后一步是把"当前 TX 速率"换算成 kbps，塞进 nl80211 的 `NL80211_RATE_INFO_BITRATE32` 上报给上层：

```c
// qcacld-3.0/core/hdd/src/wlan_hdd_station_info.c:395
static int32_t hdd_add_tx_bitrate(struct sk_buff *skb,
				  struct hdd_adapter *adapter,
				  int idx)
{
	struct nlattr *nla_attr;
	uint32_t bitrate, bitrate_compat;
	struct hdd_station_ctx *sta_ctx = WLAN_HDD_GET_STATION_CTX_PTR(adapter);

	nla_attr = nla_nest_start(skb, idx);
	// ...省略失败处理...

	/* cfg80211_calculate_bitrate will return 0 for mcs >= 32 */
	if (hdd_cm_is_vdev_associated(adapter))
		bitrate = cfg80211_calculate_bitrate(
				&sta_ctx->cache_conn_info.max_tx_bitrate);
	else
		bitrate = cfg80211_calculate_bitrate(
					&sta_ctx->cache_conn_info.txrate);

	bitrate_compat = bitrate < (1UL << 16) ? bitrate : 0;

	if (bitrate > 0) {
		if (nla_put_u32(skb, NL80211_RATE_INFO_BITRATE32, bitrate)) {
			// ...省略失败处理...
		}
	}
	// ...省略：NL80211_RATE_INFO_BITRATE(16位) 与 VHT_NSS 的填充...
	nla_nest_end(skb, nla_attr);
	return 0;
	// ...省略 fail 路径...
}
```

- `cfg80211_calculate_bitrate(&txrate)`：把"速率描述"（含 MCS、NSS、带宽、GI）换算成 kbps——这里又回到了"菜谱"（`dp_ratetable` 那套换算），是**展示**不是**决策**。
- 塞进 `NL80211_RATE_INFO_BITRATE32`：这是 nl80211 的 STATION 信息属性，上层（wificond / Framework）拿它显示"连接速率 866Mbps"。
- 整条链是"固件选完 → 上报统计 → 主机换算 → 塞给上层显示"——主机从头到尾只做了"读结果 + 换算 + 转交"，没碰决策。

QCOM 的三层齐了：菜谱（`dp_ratetable.c`）、规矩（WMI 参数）、账本（HTT 统计 + nl80211 上报）。接下来看 MTK，它的主机侧也留了这三样，但"规矩"和"账本"的载体不一样——而且它那个名字极具迷惑性的 RLM，正是开篇埋的那个坑。

---

# 4 MTK 的 RLM 为什么不是 RA？主机又能碰什么

MTK 的 Gen4M 内核驱动（`kernel_modules-connectivity-wlan-core-gen4m`）同样是 full-mac，RA 在固件。但它主机侧有个和 QCOM 明显不同的模块——RLM（`rlm.c`），名字带 "Radio Link"，很容易被当成 RA。这一节先把 RLM 的真相说清楚，再讲 MTK 主机真正的"规矩"（`UNI_CMD_RA`）和"账本"（`PARAM_GET_STA_STATISTICS`）。

## 4.1 RLM = 链路管理 + 能力协商，不是速率算法

先看规模。MTK 的 RLM 是一组文件：

| 文件                | 行数  | 内容                                                |
| ------------------- | ----- | --------------------------------------------------- |
| `mgmt/rlm.c`        | 11419 | HT/VHT 能力位填充与解析、操作模式（保护、带宽）变更 |
| `mgmt/he_rlm.c`     | 2312  | HE 能力位                                           |
| `mgmt/eht_rlm.c`    | 951   | EHT 能力位                                          |
| `mgmt/rlm_domain.c` | 11388 | 监管域（regulatory domain）与功率限制               |

1.1 万行的 `rlm.c`，光看体量很容易被当成"重量级算法"。但它满篇的函数名暴露了真身——`rlmFillHtCapIE`、`rlmFillVhtCapIE`、`rlmFillHtOpIE`、`rlmFillExtCapIE`：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/mgmt/rlm.c:1055
static void rlmFillHtCapIE(struct ADAPTER *prAdapter,
			   struct BSS_INFO *prBssInfo, ...);
// ...省略...
static void rlmFillVhtCapIE(struct ADAPTER *prAdapter,
			    struct BSS_INFO *prBssInfo, ...);   // rlm.c:1908
static void rlmFillHtOpIE(struct ADAPTER *prAdapter, struct BSS_INFO *prBssInfo, ...);  // rlm.c:1414
```

- `rlmFillHtCapIE` / `rlmFillVhtCapIE`：**填充** HT / VHT 能力信息元素（Capability IE）——把"本机支持哪些 MCS、几流、多大带宽"写进关联帧里发出去。这是能力**宣告**，不是速率**选择**。
- `rlmFillHtOpIE`：填 HT Operation IE，里面是保护模式、基本速率集——还是链路参数，不是每帧速率。
- 这套函数的输入是 BSS 关联时的静态能力，输出是 IE 字节流；整个流程没有"信道质量反馈 → 升降级"的回路。

再看 RLM 下发给固件的参数结构，更能说明它管的是"链路边界"而非"速率决策"：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/wsys_cmd_handler_fw.h:819
struct CMD_SET_BSS_RLM_PARAM {
	uint8_t      ucBssIndex;
	uint8_t      ucRfBand;
	uint8_t      ucPrimaryChannel;
	uint8_t      ucRfSco;
	uint8_t      ucErpProtectMode;
	uint8_t      ucHtProtectMode;
	uint8_t      ucGfOperationMode;
	uint8_t      ucTxRifsMode;
	uint16_t     u2HtOpInfo3;
	uint16_t     u2HtOpInfo2;
	uint8_t      ucHtOpInfo1;
	uint8_t      ucUseShortPreamble;
	uint8_t      ucUseShortSlotTime;
	uint8_t      ucVhtChannelWidth;
	uint8_t      ucVhtChannelFrequencyS1;
	uint8_t      ucVhtChannelFrequencyS2;
	uint16_t     u2VhtBasicMcsSet;
	uint8_t      ucTxNss;
	uint8_t      ucRxNss;
};
```

- `ucErpProtectMode` / `ucHtProtectMode`：ERP / HT 保护模式（有老设备共存时要不要开保护帧）——这是**共存策略**，不是速率。
- `u2VhtBasicMcsSet`：VHT 基本 MCS 集（Basic MCS Set）——这是"链路必须支持的最低速率集合"，是个**边界**。
- `ucTxNss` / `ucRxNss`：TX / RX 的空间流数上限——能力边界，不是"这一帧用几流"。
- 整条命令 22 字节，管的全是"这条链路长什么样、被什么规则约束"，没有一个字段是"当前该用 MCS 几"。

所以结论很干脆：**RLM 是无线链路管理（能力协商 + 保护模式 + 监管域），不是速率自适应**。开篇那句"MTK 有 RLM"是把门牌看错了——RLM 管的是"餐厅有几张桌子、消防通道在哪"，而"今天炒哪道菜"在固件后厨。

## 4.2 规矩：`UNI_CMD_RA` 才是主机碰固件 RA 的那只手

MTK 主机真正下发 RA 约束的命令叫 `UNI_CMD_RA`（"RA" 三个字终于出现了——但它是命令名，不是算法所在）。它是一个 TLV 容器，里面挂着一串"标签"（tag），每个 tag 是一种 RA 操作：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/nic_uni_cmd_event.h:3376
enum ENUM_UNI_CMD_RA_TAG {
	UNI_CMD_RA_TAG_GET_RU_RA_INFO = 0x0,
	// ...省略 0x01~0x0C 的各类 MU/HE 相关 tag...
	UNI_CMD_RA_TAG_GET_TX_RATE = 0x0D,
	UNI_CMD_RA_TAG_SET_MAX_PHY_RATE = 0x0E,
	UNI_CMD_RA_TAG_SET_FIXED_RATE = 0x0F,
	UNI_CMD_RA_TAG_SET_FIXED_RATE_UL_TRIG = 0x10,
	UNI_CMD_RA_TAG_SET_AUTO_RATE = 0x11,
	UNI_CMD_RA_TAG_NUM
};
```

- `SET_MAX_PHY_RATE`（0x0E）：设最大 PHY 速率——对应 QCOM 的"速率上限"。
- `SET_FIXED_RATE`（0x0F）：设固定速率——对应 QCOM 的 `VDEV_PARAM_FIXED_RATE`。
- `SET_AUTO_RATE`（0x11）：设自动速率——把 RA 交还给固件（从固定速率切回自适应）。
- `GET_TX_RATE`（0x0D）：读当前 TX 速率——主机主动问固件"你现在用多快"。

这四条凑齐了"边界 + 覆盖 + 查询"三种姿态，和 QCOM 的 WMI 参数是同一套逻辑的 MTK 方言。看其中"固定速率"这个 tag 的具体载荷，更直观：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/nic_uni_cmd_event.h:3415
struct UNI_CMD_RA_SET_FIXED_RATE_V1 {
	uint16_t u2WlanIdx;
	uint8_t  u1PhyMode;
	uint8_t  u1Stbc;
	uint16_t u2ShortGi;
	uint8_t  u1Bw;
	uint8_t  u1Ecc;
	uint8_t  u1Mcs;
	uint8_t  u1Nss;
	uint16_t u2HeLtf;
	uint8_t  u1Spe;
	uint8_t  u1ShortPreamble;
	uint16_t u2Reserve;
};
```

- `u1Mcs` / `u1Nss` / `u1Bw` / `u1PhyMode` / `u1Stbc` / `u2ShortGi`：把"用 MCS 几、几流、多宽、什么 preamble、带不带 STBC、短 GI 还是长 GI"全部指定死。
- 这是主机在说"锁死在这个速率"——**它只能指定一个具体速率，或者干脆说"你自适应"（SET_AUTO_RATE），唯独不能说"根据 SNR 自己算该升还是降"**。
- 这个结构反过来印证了 RA 在固件：主机连"指定一个固定速率"都要发一条命令，说明常态下它压根不参与逐帧选速率。

## 4.3 账本：`PARAM_GET_STA_STATISTICS` 读固件 RA 的逐速率直方图

MTK 主机读 RA 结果的载体，是一个叫 `PARAM_GET_STA_STATISTICS` 的大结构，主机发 `PARAM_GET_STA_STATISTICS` 命令，固件回填每个 STA 的统计。里面跟 RA 相关的字段：

```c
// MTK/kernel_modules-connectivity-wlan-core-gen4m/include/wlan_lib.h:1111
	/* From FW */
	uint8_t ucPer;		/* base: 128 */
	uint8_t ucRcpi;
	uint32_t u4PhyMode;
	uint16_t u2LinkSpeed;	/* unit is 0.5 Mbits */
	// ...省略...
	uint8_t aucArRatePer[AR_RATE_TABLE_ENTRY_MAX];   // wlan_lib.h:1142
	// ...省略...
	uint8_t ucHighestRateCnt;                        // wlan_lib.h:1166
	uint16_t u2TrainUp;                              // wlan_lib.h:1168
	uint16_t u2TrainDown;                            // wlan_lib.h:1169
```

- `ucPer`：包错误率（PER，base 128）——固件 RA 的核心输入，主机读它等于"偷看固件的作业本"。
- `ucRcpi`：接收信道功率指示（RCPI），信号强度的一种标度。
- `u2LinkSpeed`：链路速率（单位 0.5 Mbits）——固件当前选定的速率，直接换算成 Mbps 给上层看。
- `aucArRatePer[]`：逐速率档位的直方图（`AR_RATE_TABLE_ENTRY_MAX` 个桶）——和 QCOM 的 `tx_mcs[]` 是同一个东西的 MTK 版。
- `u2TrainUp` / `u2TrainDown`：**升档 / 降档次数**——这两个字段是最直接的证据：固件 RA 每次把速率往上调一档，`u2TrainUp` 加一；往下调，`u2TrainDown` 加一。主机只能读到"它升了几次、降了几次"，读不到"它为什么升"。

`u2TrainUp` / `u2TrainDown` 这两个名字，比任何架构图都更有说服力——**升降级的"动作"发生在固件里，主机拿到的只是动作的计数**。这正是 full-mac 的 RA 分层：主机是看台上的观众，固件是场上打球的球员，观众只能记比分，不能替球员挥拍。

MTK 的三层也齐了：链路边界（`rlm.c` + `CMD_SET_BSS_RLM_PARAM`）、RA 约束（`UNI_CMD_RA`）、结果账本（`PARAM_GET_STA_STATISTICS`）。和 QCOM 一对比，你会发现一个惊人的一致性——**两家主机留下的都是"菜谱 + 规矩 + 账本"这三样，只是文件名和字段名不同**。这引出了本文最后一个、也是最本质的问题：为什么两家不约而同，都把 RA 塞进固件？

---

# 5 为什么 full-mac 的 RA 必须沉进固件？

前面四节是"是什么"，这一节是"为什么"。答案不在某一行代码里，而在**时间尺度**里。

回到 RA 的定义：它要给"每一帧"选速率。注意"每一帧"这三个字——一个 80MHz 的 WiFi 6 链路，空口上一个 A-MPDU 可能只有几百微秒。速率选择必须跟发射决策**同处一地、同一时刻**：这一帧的 ACK 刚回来，下一帧的速率就要据此微调。如果决策者（主机）和发射者（固件）不在同一个地方，中间隔一条 WMI 命令通道，会怎么样？

看两条路径的往返代价。软 MAC 里，RA（Minstrel-HT）和 TX 决策都在主机 mac80211，中间没有跨边界——TX 状态通过 `ieee80211_tx_status` 直接回到 RA，延迟是 kernel 内部函数调用级（微秒）。而 full-mac 里，如果 RA 在主机，它得先通过 WMI 问固件要反馈、再通过 WMI 把"新速率"发下去——一次 WMI 命令往返是**百微秒级**，而一个 A-MPDU 只有几百微秒。**决策还没做完，几十帧已经发完了**。

这不是"性能差点"，是"根本来不及"。速率自适应的反馈回路要求"这一帧的结果影响下一帧的决策"，一旦决策者被搬到百微秒外的另一个处理器，这个回路就断了。所以 full-mac 的设计者没有第二个选择：**既然逐帧 TX 决策在固件（微秒级），逐帧 RA 决策就必须也放固件**。RA 跟着 TX 走，不是谁拍脑袋，是"谁管发射，谁管选速"的必然。

反过来看软 MAC 为什么 Minstrel 在主机——同理。软 MAC 里 mac80211 管着发射（它组帧、排队、调 `rate_control_get_rate()`），TX 决策本来就在主机，那 RA 自然也在主机，还省得跟固件来回传。**同一份"选速率"的活，落在哪，取决于"谁管 TX"**。这就是本文最核心的设计洞察：

> **速率自适应的位置由驱动架构决定。** 软 MAC 的 TX 在主机 → RA 在主机（Minstrel-HT）；full-mac 的 TX 在固件 → RA 在固件。主机留不留下的三层，都是"决策不在场"的遗迹。

再往深一层追问：主机真的只能干瞪眼吗？能不能硬把 RA 抢回主机？答案在"账本"那一层已经漏了——**主机的信息是滞后且稀疏的**。固件能看到每一帧的 ACK RSSI（微秒级、逐帧），主机只能拿到固件周期性聚合后的直方图（比如每几秒一条 `htt_stats_peer_tx_rate_stats_tlv`）。让主机拿"几秒前的汇总"去做"微秒级的逐帧决策"，等于让一个只能看日报的经理去现场指挥炒菜——信息维度不对等。所以主机不抢，不是偷懒，是抢了也白抢。

最后看一眼"为什么主机还留了三层"。既然决策全在固件，主机为什么不干脆什么都不做？因为主机还有三个它责无旁贷的活：**换算**（上层要显示 "866Mbps"，得有人把 rate index 换成 kbps——菜谱）、**约束**（用户/运营商要限速、要兼容老设备、要测试固定速率——规矩）、**观测**（Framework 要显示连接速率、要上报统计——账本）。这三层合起来，主机对 RA 的态度是：**能看、能管边界，但不能亲自操盘**。

---

# 6 主机对 RA 到底能做什么？——能看能管边界，不能操盘

把 QCOM 和 MTK 的三层并排看，会得到一个双平台速查表——注意左右两列是同一件事的两种方言，没有任何一行是"RA 算法"：

| 层          | 角色        | QCOM（qcacld-3.0）                                           | MTK（Gen4M）                                                 |
| ----------- | ----------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 菜谱        | 换算不决策  | `dp_getrateindex()` / `dp_rate_idx_to_kbps()`（`dp_ratetable.c`） | `rateGetDataRatesFromRateSet()`（`mgmt/rate.c:253`，rate set 位图 → 数据速率换算，查 `aucDataRate[]` 表） |
| 规矩        | 定边界/覆盖 | `wmi_unified_set_ratepwr_chainmsk_cmd_send()`、`wmi_unified_vdev_config_ratemask_cmd_send()`、`pdev_param_rate_upper_cap`、`pdev_param_rate_retry_mcs_drop`、`pdev_param_mcs_probe_intvl`、`VDEV_PARAM_FIXED_RATE` | `UNI_CMD_RA`（`SET_MAX_PHY_RATE` / `SET_FIXED_RATE` / `SET_AUTO_RATE`）+ `CMD_SET_BSS_RLM_PARAM`（保护模式/基本速率/NSS 边界） |
| 账本        | 读结果      | `htt_stats_peer_tx_rate_stats_tlv`（`tx_mcs[]` / `tx_nss[]` / `ack_rssi` / `peer_tx_mpdu_try_cnt` / `peer_tx_mpdu_success_cnt`）→ `hdd_add_tx_bitrate()` | `PARAM_GET_STA_STATISTICS`（`ucPer` / `ucRcpi` / `u2LinkSpeed` / `aucArRatePer[]` / `u2TrainUp` / `u2TrainDown`） |
| **RA 引擎** | **选速率**  | **固件（主机不可见）**                                       | **固件（主机不可见）**                                       |

表里最扎眼的是最后一行——两家的"RA 引擎"都是空的（主机侧），因为它在固件里。而上面三行，恰好是 Minstrel-HT 五件套"剥离了决策"之后剩下的部分：

- Minstrel 的"成功/失败计数 + EWMA" → 主机只剩"读 `peer_tx_mpdu_try_cnt` / `peer_tx_mpdu_success_cnt`"（账本里的 PER 素材）。
- Minstrel 的"吞吐估计 + 排序选速率" → 主机只剩"速率表换算"（菜谱里的 `dp_getrateindex`）。
- Minstrel 的"lookaround 探测 + MRR 重试链" → 主机只剩"探测间隔 / 降档阈值"这两个旋钮（规矩里的 `pdev_param_mcs_probe_intvl` / `pdev_param_rate_retry_mcs_drop`）。

一句话：**full-mac 主机把 Minstrel 的"算法"抽走了，只留了它的"参数"和"结果"**。算法整段搬进固件，参数留在主机当旋钮，结果回流主机当报表。

---

# 总结

这一篇追的是"驱动怎么决定用哪个 MCS"，答案比前几篇都更极端——**full-mac 里，这个决定根本不在驱动里，在固件里**。全篇主线是一条：**速率自适应的位置由驱动架构决定**。

- **软 MAC**：TX 在主机 mac80211，RA 也在主机。Minstrel-HT 五件套（成功/失败计数、EWMA 平滑 α=0.75、吞吐估计 `T=p×R`、20ms lookaround 探测、4 级 MRR 重试链）整段在 `rc80211_minstrel_ht.c` 跑，每个 `HZ/20` 周期结算一次，是活的、可见的算法。
- **QCOM full-mac**：RA 在固件。主机留三层——菜谱（`dp_ratetable.c` 7295 行查表，`dp_getrateindex` 换算 index↔kbps）、规矩（`wmi_unified_set_ratepwr_chainmsk_cmd_send` / `wmi_unified_vdev_config_ratemask_cmd_send` / 速率上限 / 重传降档阈值 / 探测间隔 / 固定速率）、账本（`htt_stats_peer_tx_rate_stats_tlv` 逐 MCS 直方图 → `hdd_add_tx_bitrate` → nl80211）。
- **MTK full-mac**：RA 也在固件。`rlm.c`（1.1 万行）是链路管理 + 能力协商 + 监管域，**不是 RA**——开篇埋的那个坑在这里填上。真正的 RA 约束走 `UNI_CMD_RA`（`SET_MAX_PHY_RATE` / `SET_FIXED_RATE` / `SET_AUTO_RATE`），结果读 `PARAM_GET_STA_STATISTICS`（`ucPer` / `u2LinkSpeed` / `aucArRatePer[]` / `u2TrainUp` / `u2TrainDown`）。
- **为什么必须沉固件**：RA 是"逐帧"决策，必须跟 TX 决策同处一地。固件微秒级，主机经 WMI 往返百微秒级，一个 A-MPDU 才几百微秒——决策还没做完，帧早发完了。谁管 TX，谁管选速。

一个贯穿全篇的图景：主机对 RA 的三种姿态——**递菜谱（换算）、定规矩（约束）、看账本（读结果）**，唯独没有"掌勺"。这不是 QCOM 或 MTK 偷懒，是 full-mac 架构的必然：决策者在哪，由"谁在发射"决定。

**本章干货速查**：

| 主题       | 核心机制                                   | 关键代码锚点                                                 |
| ---------- | ------------------------------------------ | ------------------------------------------------------------ |
| 软 MAC RA  | Minstrel-HT 五件套在主机                   | `minstrel_ht_calc_rate_stats`（rc80211_minstrel_ht.c:766）、`minstrel_ht_get_tp_avg`（:500）、`minstrel_ht_update_stats`（:1059）、`minstrel_ht_get_rate`（:1595）、`EWMA_LEVEL 96`（.h:20） |
| QCOM 菜谱  | 速率表双向换算，查表不决策                 | `dp_getrateindex`（dp_ratetable.c:6602）、`dp_rate_idx_to_kbps`（:6679）、`dp_ath_rate_lpf`（dp_ratetable.h:82，ath9k 遗产低通，非 RA） |
| QCOM 规矩  | per-rate 功率/链掩码 + 速率掩码 + 参数旋钮 | `wmi_unified_set_ratepwr_chainmsk_cmd_send`（wmi_unified_api.c:1387）、`wmi_unified_vdev_config_ratemask_cmd_send`（wmi_unified_vdev_api.c:147）、`PDEV_PARAM_RATE_UPPER_CAP` / `PDEV_PARAM_SET_RATE_DROP_DOWN_RETRY_THRESH` / `PDEV_PARAM_MIN_MAX_MCS_PROBE_INTERVAL`（wmi_unified_param.h:6037+）、`VDEV_PARAM_FIXED_RATE`（:6138） |
| QCOM 账本  | 固件逐速率直方图 → nl80211                 | `htt_stats_peer_tx_rate_stats_tlv`（htt_stats.h:2610，`tx_mcs[]`/`ack_rssi`/`peer_tx_mpdu_try_cnt`）、`hdd_add_tx_bitrate`（wlan_hdd_station_info.c:395） |
| MTK RLM≠RA | 链路管理 + 能力协商 + 监管域               | `rlmFillHtCapIE` / `rlmFillVhtCapIE`（rlm.c:1055/1908）、`CMD_SET_BSS_RLM_PARAM`（wsys_cmd_handler_fw.h:819，保护模式/NSS 边界） |
| MTK 规矩   | RA 约束 TLV 命令                           | `UNI_CMD_RA_TAG_SET_MAX_PHY_RATE` / `SET_FIXED_RATE` / `SET_AUTO_RATE`（nic_uni_cmd_event.h:3376）、`UNI_CMD_RA_SET_FIXED_RATE_V1`（:3415，`u1Mcs`/`u1Nss`/`u1Bw`） |
| MTK 账本   | 逐速率直方图 + 升降档计数                  | `PARAM_GET_STA_STATISTICS`（wlan_lib.h:1060，`ucPer`/`u2LinkSpeed`/`aucArRatePer[]`/`u2TrainUp`/`u2TrainDown`） |

**协议依据**：MCS 档位（速率表）定义见 IEEE 802.11-2024 §19.3.5（HT-MCS）、§21.3.5（VHT-MCS）、§27.3.7（HE-MCS）、§36.3.8 / §36.5（EHT-MCS，802.11be-2024）。注意：RA 升降级算法**不是** 802.11 规范内容，是各实现的私有算法——Minstrel-HT 是 Linux kernel mac80211 的实现，QCOM / MTK 的 RA 是各自的固件实现，均不可在主机源码中追踪。

**源码出处**：QCOM [qcacld-3.0](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qcacld-3.0)、[qca-wifi-host-cmn](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-qca-wifi-host-cmn)、[fw-api](https://github.com/MotorolaMobilityLLC/vendor-qcom-opensource-wlan-fw-api)；MTK [kernel_modules-connectivity-wlan-core-gen4m](https://github.com/MotorolaMobilityLLC/vendor-mediatek-kernel_modules-connectivity-wlan-core-gen4m)；软 MAC Minstrel-HT 来自内核 mac80211。

速率自适应的决策回路讲完了，但还有一个更"贴身"的悬案没解：速率定了，帧也发出去了，可手机那一根 2.4GHz 天线上，不止 WiFi 一家在用——蓝牙耳机、蓝牙鼠标、蓝牙音箱，全挤在同一个 2.4GHz 频段里。**速率定了，但同一根 2.4GHz 天线上，蓝牙还在抢信道——什么时候该让 WiFi 发帧、什么时候得把天线让给蓝牙，这套"抢"与"让"的仲裁到底落在主机还是固件**？下一篇，我们看 WiFi 和蓝牙怎么在同一根天线上和平共处。
