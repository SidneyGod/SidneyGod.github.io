---
title: 第 12 章：DPP（Wi-Fi Easy Connect）— 扫码进门的访客登记
top: 1
related_posts: true
abbrlink: 6f8b6b0a
date: 2026-09-18 22:38:44
tags:
  - 802.11
categories:
  - WiFi
  - Protocol
---

> "一台没有屏幕、没有键盘的智能灯泡，怎么安全地连上你家 WiFi？答案是：用手机扫一下它身上的二维码。"

---

# 本章导读

给手机连 WiFi 很简单：选 SSID、输密码。但换成一台**智能灯泡、传感器、摄像头**——它们大多**没有屏幕、没有键盘**，你怎么把 WiFi 密码"告诉"它？

传统做法（WPS 按钮、厂商 App 配网、设备先开个热点让你连上去设置）要么不安全（PIN 码可被暴力破解），要么繁琐，要么各家一套互不通用。<strong>DPP（Device Provisioning Protocol，设备配置协议）</strong>就是来终结这种混乱的——它是 Wi-Fi 联盟 **Wi-Fi Easy Connect** 认证背后的技术规范。

<!--more-->

DPP 的核心创意：**用公钥密码学 + 一个"带外"动作（最典型的是扫二维码）来安全地配网。** 你用手机扫一下设备上的二维码，就完成了"把它安全接入网络"这件事——既不用输密码，又能防中间人攻击。

> **本章比喻：扫码进门的访客登记**
> 把网络想象成一栋有门禁的办公楼。一位**访客（新设备 = Enrollee，入网者）**要进来，但他没法自己开门。门口有位**门卫（Configurator，配置器）**——通常是你的手机或家庭网关。访客胸前别着一张**二维码名牌（设备公钥）**，门卫拿手机一扫，当场核验身份，然后发给他一张**专属门禁卡（Connector）**。从此访客凭这张卡，就能在楼里和其他被同一门卫登记过的人自由通行——而整个过程，访客自己一个字的密码都不用输。

**本章你将学到：**

- DPP 解决什么：无屏 IoT 设备的安全配网难题
- 两个角色：Configurator（门卫）与 Enrollee（访客）
- 四步流程：Bootstrapping → Authentication → Configuration → Network Introduction
- Bootstrapping 的几种方式：二维码 / NFC / BLE / PKEX
- 为什么"扫个码"就能防中间人攻击（公钥引导信任）
- Connector：一张可验证的"门禁卡"如何让设备互认
- **DPP 能下发的几类凭证：不只是 Connector，也能直接发传统 PSK / SAE 口令 / 802.1X**
- **逐帧拆解：Auth 3 帧 + Config 3 帧（含结果帧）+ NetIntro 2 帧，分别走哪种帧类型（Public Action vs GAS）、带什么属性**
- **抓包实战：DPP 帧的 Category/Action/OUI/Frame Type 与 Wireshark 过滤器**

> **数据来源**：本章所有技术结论基于 `Wi-Fi_Easy_Connect_Specification_v3.0.pdf`（Wi-Fi Alliance, 2022）并标注章节——四步协议见 §6.3（Auth）/§6.4（Config）/§6.6（Network Introduction），凭证与 `akm` 见 §4.5，帧格式与 DPP Frame Type 见 §8.2（Table 34/35）/§8.3。底层的 GAS / Public Action 帧机制与四次握手引用 IEEE 802.11-2024。Wireshark 过滤器字段名以其 802.11 dissector 为准。

---

# 1 配网难题 — 没有屏幕的设备怎么连 WiFi

手机连 WiFi 的"选 SSID + 输密码"模式，隐含了一个前提：**设备有人机界面**。但物联网时代大量设备没有：

- 智能灯泡、插座、传感器：连个像样的屏幕都没有
- 摄像头、音箱：有的有按钮，但输入 WiFi 密码极其别扭

历史上的几种配网方案都有硬伤：

| 老办法              | 问题                                                      |
| ------------------- | --------------------------------------------------------- |
| **WPS PIN**         | 8 位 PIN 可被暴力破解（著名的 WPS 漏洞）                  |
| **WPS PBC（按钮）** | 按钮按下的 120 秒窗口内，任何设备都能加入，谁按的不可验证 |
| **厂商 App 配网**   | 各家一套，私有、不互通，安全性参差                        |
| **设备自开热点**    | 配网期间设备热点往往不加密，密码可能明文经过              |

DPP 的目标：**一套标准化、强安全、又对无屏设备友好的配网机制。**

---

# 2 两个角色 — 门卫与访客

DPP 里只有两个核心角色（§1.5）：

| 角色             | 全称   | 比喻                       | 谁来当                     |
| ---------------- | ------ | -------------------------- | -------------------------- |
| **Configurator** | 配置器 | 门卫（掌管登记、发门禁卡） | 手机 App、家庭网关、路由器 |
| **Enrollee**     | 入网者 | 访客（要进网络的新设备）   | 智能灯泡、传感器、摄像头等 |

- **Configurator** 已经是网络的"管理者"，它持有一对**签名密钥**，负责认证新设备、给它下发凭证。
- **Enrollee** 是待入网的新设备，最终从 Configurator 处拿到上网/互联所需的凭证。

> **关于"谁发起"**：DPP 认证协议里还有 **Initiator（发起方）/ Responder（响应方）**之分，但这是**协议流程角色**，与 Configurator/Enrollee 这种**功能角色**正交——视引导方式不同，Configurator 或 Enrollee 都可能当 Initiator（§1.5.2）。初学只需记住功能角色：门卫管发卡、访客来领卡。

---

# 3 四步流程总览 — 从扫码到上网

DPP 把配网拆成清晰的四步（§1.5、§2.1）。先看全景，再逐步拆解：

![DPP 四步配网流程](assets/%E7%AC%AC-12-%E7%AB%A0%EF%BC%9ADPP%EF%BC%88Wi-Fi-Easy-Connect%EF%BC%89%E2%80%94-%E6%89%AB%E7%A0%81%E8%BF%9B%E9%97%A8%E7%9A%84%E8%AE%BF%E5%AE%A2%E7%99%BB%E8%AE%B0/12-dpp-flow.svg)

| 步骤  | 名称                                 | 干什么                                                | 比喻                                 |
| ----- | ------------------------------------ | ----------------------------------------------------- | ------------------------------------ |
| **1** | **Bootstrapping（引导）**            | 带外获取对方的**公钥**（扫二维码 / NFC / BLE / PKEX） | 门卫扫一眼访客的二维码名牌           |
| **2** | **Authentication（认证）**           | 基于公钥相互认证，建立一条加密信道                    | 当面核验身份，确认"就是名牌上这个人" |
| **3** | **Configuration（配置）**            | Configurator 通过加密信道下发凭证（Connector 等）     | 发给访客一张专属门禁卡               |
| **4** | **Network Introduction（网络引入）** | Enrollee 用凭证与网络中其他设备建立连接密钥           | 访客凭卡和楼里其他人互认、通行       |

关键顺序：**先有"带外的一眼"（Bootstrapping），后续的"在带内（WiFi 信道）"通信才信得过。** 这是 DPP 全部安全性的根基。

---

# 4 第一步 Bootstrapping — "看一眼"就建立信任

这是 DPP 最巧妙的一步。问题是：两台素未谋面的设备，凭什么相信彼此、又不被第三方冒充（中间人攻击）？

DPP 的答案：**通过一个"带外（out-of-band）"渠道，让一方先拿到另一方的公钥。** 公钥本就是公开的、不怕被看见；而对应的私钥只有设备本人持有，攻击者既拿不到、也无法从公钥反推出来。于是只要公钥的来源可信（确实来自那台设备），后续认证时"**谁能证明自己握有对应私钥，谁就是那台设备**"——冒充者没有私钥，自然过不了关。这一步的精髓是：信任被压进了"看一眼"这个动作里。

获取公钥的几种 Bootstrapping 方式（§5）：

| 方式                  | 怎么传公钥                                                   | 典型场景                      |
| --------------------- | ------------------------------------------------------------ | ----------------------------- |
| **QR Code（二维码）** | 设备印一个二维码，里面编码了它的公钥 + 工作信道；手机一扫即得 | 最常见——灯泡/摄像头贴二维码   |
| **NFC**               | 碰一下，通过 NFC 传递公钥                                    | 支持 NFC 的设备               |
| **BLE**               | 通过低功耗蓝牙传递引导信息                                   | 蓝牙+WiFi 双模设备            |
| **PKEX**              | 双方在带内用一个共享**口令/码**协商，把公钥交换出来          | 没有二维码/NFC 时的纯带内方式 |

NFC 与 BLE 是二维码的姊妹路径，殊途同归：NFC 用 NFC Forum 的 **URI NDEF 消息**承载引导信息（碰一下即读，§5.4）；BLE 则把引导 URI 放进 **GATT 服务**（TDService），扫码方以 GATT Client 身份用 ATT Read 读出（§5.5）——无论哪种，本质都是"带外拿到对方公钥"。

> **二维码里有什么**：一个 DPP 二维码本质是 Enrollee 的**公钥**（椭圆曲线上的点，通常 P-256）外加它支持的**工作信道**等信息（§5.2、§5.3）。手机扫到后，就知道"要去哪个信道找它、它的公钥是什么"。

下一步的认证要在某个 WiFi 信道上一来一回，可两台素未谋面的设备，怎么**约到同一个信道上碰头**？答案就藏在 Bootstrapping 信息里——它带的不只是公钥，还有一个可选的**信道列表（channel list）**（§5.2.1）。

先澄清一点：这里**并不存在"建立一条信道"这回事**。DPP 认证用的是 **802.11 Public Action 帧**，直接发在**普通的 WiFi 空口信道**上。真正要解决的不是"信道哪来的"，而是"**双方怎么碰头到同一个信道**"。规则很简单（§6.3.1）：

- **二维码里写了信道**：Enrollee（灯泡）就**蹲守**在这个信道上等人来认证；扫码方（手机）读到后，直接奔这个信道发 Authentication Request。规范建议**最好只列一个信道**——列得越多，扫码方要逐个信道试，越慢。
- **二维码里没写信道**：扫码方只能**把所有支持的信道挨个扫一遍**去试探。能成，但慢，所以规范明确不推荐——而且对二维码/NFC 这类方式，规范**并不提供"默认信道"兜底**：你既然都凑到设备跟前扫码了，本就该在二维码里写明信道，不该留空。

换句话说，**不是 Enrollee "怎么知道"自己在哪个信道——而是它在二维码里『声明』了自己蹲在哪，扫码方据此找上门**。主动权在被扫的那一方。

> **唯一定义了"默认信道"的是 PKEX**：它没有二维码这"带外一眼"，双方纯靠一个共享口令碰头，手里没有对方的信道信息，所以规范给了一组约定俗成的默认碰头信道（§5.6）——**2.4 GHz 用信道 6**、5 GHz 用信道 44 或 149（视当地法规）、60 GHz 用信道 2 等。PKEX 的响应方在拿不到带外信道信息时就蹲守在这些默认信道上，发起方逐频段试。**这是整个 DPP 里唯一"信道有默认值"的情形**，恰恰因为它缺了二维码那一环。

> **冷知识坑：信道还受各国"监管域"限制**。哪些信道能用，是各国法规（regulatory domain）规定的，并非全球统一——典型如 5 GHz：信道 149 在中国合法、在日本却禁用。设备出厂时锁了所在国的监管域，且法规禁止它在本国不允许的信道上发射。于是**一台在日本买的 IoT，若配网走的是日本合法、中国却禁用的信道，拿到中国就可能因为"双方约不到同一个合法信道碰头"而配网失败**——注意 PKEX 那条"5 GHz 默认 149"在日本本就是非法的。
>
> 所幸无屏设备配网绝大多数走 **2.4 GHz**，而 2.4G 的信道 1–13 在中日等多数国家完全重叠，所以这个坑在实践中多半被 2.4G 的通用性绕开了；真正容易中招的是"配网走 5 GHz、且只面向单一市场设计"的设备。这不是 DPP 的 bug，而是 WiFi 监管域机制的固有摩擦——DPP 只是把它暴露在了第一步。

> **补充：反过来由 Configurator 发起时**，协议 v2 提供了 **Presence Announcement**（出席通告，§6.2）：Enrollee 周期性地在信道上广播一帧"我在这儿"，Configurator 收到后再朝它的 MAC / 信道发起认证。这适用于"手机想主动发起、但事先不知道设备蹲在哪个信道"的情形。

> **交通比喻**：访客的"二维码名牌"上印的不是密码，而是一枚**公开的图案（公钥）**——任何人都能看、甚至照抄，它本就不怕泄露。但与这枚图案唯一配对的**私章（私钥）**，只攥在访客自己手里。门卫扫名牌，是从访客本人那儿**亲眼**记下了这枚真图案；认证时门卫再要求"**请你用私章在我指定的纸上盖一下**"——只有真访客盖得出与图案吻合的印记。冒充者就算把名牌上的图案抄得一模一样，也变不出那枚私章、盖不出吻合的印记。所以"**亲眼扫一下、记住真图案**"这一步，就足以杜绝冒名顶替。

---

# 5 第二步 Authentication — 当面核验

在约定好的那个信道上（见上一节 §12.4），双方就开始跑 **DPP Authentication 协议**（§6.3）。它由**三帧**完成——Authentication Request → Response → Confirm（具体每帧带什么，见 §12.8 逐帧拆解）：

- 基于 Bootstrapping 得到的公钥，双方做一次**基于公钥密码学的认证握手**，确认对端确实握有对应私钥。
- 握手过程中**逐步推导出临时密钥**（最终的会话密钥记作 ke），并用 **AES-SIV** 把帧里的敏感字段加封，**建立一条加密的安全信道**，供下一步下发凭证用。
- 可选**双向认证**：如果双方都拿到了对方的 Bootstrapping 公钥，就能互相验证（§1.5.1）。

> **谁当门卫、谁当访客，在这一步敲定**：DPP 的发起方（Initiator）既可能是 Configurator 也可能是 Enrollee。双方在 Auth Request / Response 里互带 **Capabilities（能力）** 字段声明自己想当哪个角色；规范规定"一方 Configurator + 另一方 Enrollee"才算兼容，两边都想当同一个角色会回 `STATUS_NOT_COMPATIBLE`（§6.3.1.5）。

认证用的是 **DPP Public Action 帧**（带内管理帧），所以这一步开始就在 WiFi 空口上进行了，不再需要带外渠道。

> **交通比喻**：门卫扫过名牌后，让访客出示那把钥匙开一下名牌上的锁——锁能开，证明"人证一致"。核验通过的同时，两人之间拉起一条**只有彼此能听懂的私密对讲频道**（加密信道），接下来发卡就走这条频道，旁人偷听不到。

---

# 6 第三步 Configuration — 发"门禁卡"

安全信道建好后，Enrollee 主动发起 **DPP Configuration 协议**（§6.4），向 Configurator 索要入网凭证：

- Enrollee 发 **DPP Configuration Request**，里面带一个 **Configuration Request Object**，说明自己的 **Network Role**（要当 STA 还是 AP）等诉求。
- Configurator 回 **DPP Configuration Response**，内含一个 **Configuration Object（配置对象）**——里面是 SSID 等发现信息 + 一个 **Credential（凭证）对象**。

一个常见误解是"DPP = 公钥配网，只会发 Connector"。其实 **Configuration Object 里的 `cred` 凭证对象，靠一个 `akm` 字段决定发哪种凭证**（§4.5 Table 9），完全可以下发传统 WiFi 密码：

| `akm` 取值        | 下发的凭证字段                                               | 含义                     | 适用网络           |
| ----------------- | ------------------------------------------------------------ | ------------------------ | ------------------ |
| **`psk`**         | `psk_hex`（十六进制 PSK）和/或 `pass`（口令）                | 传统 WPA2-Personal 密码  | 老网络、家用路由器 |
| **`sae`**         | `pass`（SAE 口令）                                           | WPA3-Personal            | WPA3 网络          |
| **`psk+sae`**     | `psk_hex` + `pass`                                           | 同时兼容 WPA2/WPA3 过渡  | 混合网络           |
| **`dpp`**         | `signedConnector`（JWS Connector）+ `csign`（C-sign-key 公钥） | 现代公钥凭证（见 §12.7） | 纯 DPP 网络        |
| **`dot1x`**       | 企业证书等（见规范附录 A）                                   | 802.1X 企业认证          | 企业网             |
| **`dpp+sae`**     | `signedConnector` + `csign` + `pass`                         | 同时发门禁卡与 SAE 口令  | 混合 DPP/WPA3 网络 |
| **`dpp+psk+sae`** | 上述组合                                                     | 一张配置同时给多种凭证   | 兼容性最大化       |

也就是说：**DPP 既能发"现代门禁卡"（Connector），也能向后兼容地发"一把老式大门钥匙"（PSK / SAE 口令）。** 这一点很关键——它让 DPP 能给"还在用 WPA2 密码的存量网络"配网，而不是非得整网升级到 Connector 体系。手机扫一下灯泡的码，灯泡照样能被配上你家路由器那个 WPA2 密码，全程你没看见也没输过它。

> **交通比喻**：门卫核验完访客身份后，从抽屉里取出的"凭证"可以有好几种——可能是带防伪签名的**新式门禁卡（Connector）**，也可能就是一把**老式大门钥匙（PSK）**或一把**升级版钥匙（SAE）**。发哪种，取决于这栋楼的门锁是新是旧（目标网络的 `akm`）。

> **注意发起方**：虽然认证可由任一方发起，但 **Configuration 协议只能由 Enrollee 发起**（§1.5）——访客主动上前领卡，符合直觉。

---

# 7 第四步 Network Introduction 与 Connector — 一张可验证的门禁卡

这是 DPP 区别于"发个 WiFi 密码就完事"的精髓。

**Connector** 是 Configurator 签发的一份**经过签名的"introduction（介绍信）"**（§4.2）。技术上它是一个 **JWS（JSON Web Signature）**——用 Configurator 的签名密钥（C-sign-key）签过名的 JSON 对象。它不是一把密码，而是一张**可被全网验证的身份凭证**。

![Connector 可全网验证的门禁卡](assets/%E7%AC%AC-12-%E7%AB%A0%EF%BC%9ADPP%EF%BC%88Wi-Fi-Easy-Connect%EF%BC%89%E2%80%94-%E6%89%AB%E7%A0%81%E8%BF%9B%E9%97%A8%E7%9A%84%E8%AE%BF%E5%AE%A2%E7%99%BB%E8%AE%B0/12-dpp-connector.svg)

**Connector 里到底装了什么**（§4.2）：一张 Connector 是一个 JWS，签名之外，核心装着三样——**准入组标识（Group Identifier）**、**网络角色（STA/AP）**，以及最关键的设备自己的一把**网络访问公钥（netAccessKey 的公钥部分，记作 NK）**。对应的私钥 `nk` 只在设备自己手里、从不外传。

## 7.1 拿到 Connector 后，到底怎么连上路由器

这一步最反直觉的地方是：**Connector 不是"出示给路由器、路由器放你进来"的单向门禁卡**——因为**路由器（AP）自己也持有一张 Connector**（它同样被这个 Configurator 配置过），里头也装着它自己的网络访问公钥。所以这是**两个都领过卡的人见面、互相亮卡**。

连接过程（§6.6）：

```none
1. 找到 AP      设备从 Configuration Object 里读到 SSID（配置时一并给了）
              扫到这个 SSID、且在 Beacon 里宣告支持 DPP AKM 的 AP
                   │
2. 互换 Connector  设备 ←→ AP 交换各自的 Connector（即那 2 帧 Peer Discovery）
                   │
3. 互相验签       双方各用 Configurator 的签名公钥（C-sign-key）验对方的卡：
              "确实是咱们门卫签的?对方有没有权限和我同组?"
                   │
4. 各算出同一把 PMK  设备用【自己的私钥 nk】×【AP 卡里的公钥】
              AP   用【自己的私钥（AP 侧私钥）】  ×【设备卡里的公钥 NK】
              → ECDH 数学保证两边算出完全相同的共享密钥 → 推出 PMK + PMKID
                   │
5. 四次握手       把这把 PMK 喂给标准 WPA2/WPA3 四次握手 → 建 PTK → 加密上网
```

**第 4 步是灵魂**：这是一次 **ECDH（椭圆曲线密钥交换）**——双方各拿"自己的私钥 × 对方的公钥"，数学上必然得到**同一个**共享秘密，而谁都没把私钥发出去过。规范把这个共享秘密记作 **N = nk × PK**（nk 为设备私钥、PK 为对方 Connector 里的 netAccessKey 公钥），再经 HKDF 派生出 **PMK = HKDF(<>, "DPP PMK", N.x)** 与 **PMKID = Truncate-128(SHA-256(min(NK.x, PK.x) | max(NK.x, PK.x)))**（§6.6.4），N 算完即删。PMK 正是 WPA2/WPA3 四次握手的输入。

换句话说：**DPP 没有重新发明"怎么加密"，它只换了"PMK 从哪来"**——把传统的"全网共享一个密码、hash 出 PMK"，换成了"每对设备用各自卡里的公钥现场 ECDH 算一把 PMK"。后面的四次握手、PTK、CCMP 加密，和你家普通 WiFi 一模一样。

这带来的好处：**设备之间不必共享同一个 WiFi 密码，各持一张"门卫签发的卡"凭卡互认。** Configurator 想撤销某台设备，不必改全网密码、让它那张 Connector 失效即可，不惊动别人。

> **交通比喻**：设备和路由器**各掏出自己那张门卫签发的卡**，互相验明"都是自己人、且有权对接"，再用各自卡里的信息**当场对出一个只有彼此知道的暗号（PMK）**，然后凭这个暗号走正常的握手流程进门。好处是：来了新设备只需门卫给它发张卡，**不必把"全楼通用大门密码"告诉每个人**；要请走某人，作废它那张卡就行。

## 7.2 如果发的是 PSK 呢——那就没有这一步了

回到 §12.6：如果 Configuration Object 里的 `akm` 是 `psk`/`sae`，那 Configurator 发的就**不是 Connector，而是直接把 WiFi 密码塞在 `psk_hex`/`pass` 字段里**——它就装在 Config Response 那一帧的配置对象内，**并没有"单独传 PSK"的额外帧**（这就是你在帧流程里找不到"传 PSK"那一步的原因：它不单独成帧，而是配置对象的一个字段）。

更关键的是：**拿到 PSK 的设备，后续根本不走 Network Introduction**。它把这个密码当成一个普普通通的 WiFi 密码，像任何传统设备那样去连 AP：

```none
Config 阶段拿到 psk_hex / pass（藏在 Configuration Object 里，无独立帧）
        │
        ▼
设备当普通 STA：扫到 SSID → 关联 → 直接用这个 PSK 跑标准四次握手 → 上网
        （没有 Peer Discovery、没有 ECDH、没有 Connector 验签）
```

规范把 PSK 路径定位为"**支持 legacy 设备**"（§2.2.2）——DPP 在这里只是充当了一个"安全的密码派发管道"，把密码安全地送进设备；至于送到之后，设备走的还是几十年那套 PSK 接入。

> 所以两条路径的分叉点在 §12.6 的 `akm`：
>
> |                                 | Connector 路径（`akm=dpp`）            | PSK 路径（`akm=psk/sae`）   |
> | ------------------------------- | -------------------------------------- | --------------------------- |
> | 配置阶段发什么                  | signedConnector + C-sign-key           | psk_hex / pass（密码本身）  |
> | 之后走不走 Network Introduction | **走**（互换 Connector + ECDH 出 PMK） | **不走**，当普通 STA 直接连 |
> | PMK 哪来                        | 两张卡公钥现场 ECDH 算出               | 由共享密码直接 hash         |
> | 撤销一台设备                    | 作废它的 Connector，不动别人           | 得改密码、全网重配          |
> | 四次握手                        | 照跑                                   | 照跑                        |
>
> 共同点很重要：**无论哪条路径，最后都落到同一套 802.11 四次握手**——DPP 改变的只是"PMK 怎么来"，从不替代链路加密本身。

---

# 8 逐帧拆解 — 每一帧到底发了什么

前面几节是"概念级"的四步。这一节把它落到**空口上每一帧**：谁发给谁、走哪种帧类型、帧里带什么关键属性。整个配网主线一共就 **8 帧**（不含 Bootstrapping，那一步在带外，没有空口帧）。

![DPP 逐帧时序](assets/%E7%AC%AC-12-%E7%AB%A0%EF%BC%9ADPP%EF%BC%88Wi-Fi-Easy-Connect%EF%BC%89%E2%80%94-%E6%89%AB%E7%A0%81%E8%BF%9B%E9%97%A8%E7%9A%84%E8%AE%BF%E5%AE%A2%E7%99%BB%E8%AE%B0/12-dpp-frames.svg)

一个**最容易被忽略的细节**先点明：这 8 帧并不都是同一种帧——**Authentication 和 Network Introduction 走 802.11 Public Action 帧，唯独中间的 Configuration 换用了 GAS 帧**（Generic Advertisement Service，§6.4.1）。GAS 本是"关联前隔空查询"的通用载体（下一章 Passpoint 会重度使用），DPP 借它来传可能较大的配置对象（还支持分片）。

## 8.1 Authentication：3 帧（Public Action）

| 帧                | 方向                  | 帧类型        | 关键属性（§8.2）                                             | 规范   |
| ----------------- | --------------------- | ------------- | ------------------------------------------------------------ | ------ |
| **Auth Request**  | Initiator → Responder | Public Action | 双方公钥哈希 `SHA-256(BR/BI)`、发起方协议公钥 `PI`、可选信道、**加封的 I-nonce + I-capabilities** | §6.3.2 |
| **Auth Response** | Responder → Initiator | Public Action | `DPP Status`、公钥哈希、响应方协议公钥 `PR`、**加封的 R-nonce/I-nonce + R-capabilities + 认证标签 R-auth** | §6.3.3 |
| **Auth Confirm**  | Initiator → Responder | Public Action | `DPP Status`、公钥哈希、**加封的认证标签 I-auth**            | §6.3.4 |

机制要点：每帧里的敏感字段都用 **AES-SIV** 加封，密钥是握手中**逐步推导**出来的（一层套一层，最终得到会话密钥 ke）；"能正确解封"本身就证明了对方握有对应私钥——这就是认证成立的依据。这套"逐步推导"的密钥层级是（§6.3）：双方先各自 ECDH 出共享秘密 M、N，再 k1 = HKDF(<>, "first intermediate key", M.x)、k2 = HKDF(<>, "second intermediate key", N.x)；随后 bk = HKDF-Extract(I-nonce | R-nonce, M.x | N.x)，最终 ke = HKDF-Expand(bk, "DPP Key", 长度)。双向认证时还会多算一个量、把双方 Bootstrapping 公钥也拌进认证标签里。

> 访客和门卫隔空对暗号——门卫报上"我记得你名牌长这样"（公钥哈希），访客用只有自己有的钥匙回应（加封 nonce），一来一回三句话，彼此都确认"人证一致"，同时拉起了私密频道。

## 8.2 Configuration：2 帧（GAS） + 1 个结果帧

| 帧                  | 方向                    | 帧类型                      | 关键内容                                                     | 规范   |
| ------------------- | ----------------------- | --------------------------- | ------------------------------------------------------------ | ------ |
| **Config Request**  | Enrollee → Configurator | **GAS**（Initial Request）  | Configuration Request Object：Network Role（STA/AP）、可选 MUD URL | §6.4.2 |
| **Config Response** | Configurator → Enrollee | **GAS**（Initial Response） | Configuration Object：SSID 等发现信息 + `cred` 凭证（按 `akm` 发 Connector 或 PSK/SAE） | §6.4.3 |
| **Config Result**   | Enrollee → Configurator | Public Action               | `DPP Status`（配置成功 / 失败）                              | §6.4.4 |

整段仍用上一步的会话密钥 ke 做 AES-SIV 保护。注意帧类型在这里**从 Public Action 切到了 GAS**，配完结果回报又切回 Public Action。

> 访客走到登记窗口（GAS 这个"对外服务窗口"），递上申请表（要当 STA 还是 AP），门卫从窗口递回门禁卡或钥匙；访客拿到后回一句"收到，配好了"（Result）。

## 8.3 Network Introduction：2 帧（Public Action）

| 帧                          | 方向            | 帧类型        | 关键属性                                           | 规范   |
| --------------------------- | --------------- | ------------- | -------------------------------------------------- | ------ |
| **Peer Discovery Request**  | 设备 B → 设备 A | Public Action | Transaction ID、**自己的 Connector**               | §6.6.2 |
| **Peer Discovery Response** | 设备 A → 设备 B | Public Action | Transaction ID、`DPP Status`、**自己的 Connector** | §6.6.2 |

双方交换 Connector、各自用 Configurator 的签名公钥验对方的卡，验过后**推导出 PMK 和 PMKID**（§6.6.4）。

**这里有个关键回扣**：DPP 到此**并不自己加密数据**——它产出的 **PMK / PMKID 会被交给标准的 WPA2/WPA3 四次握手**去真正建立 PTK、加密流量。换句话说，**DPP 干的是"发凭证 + 互认"，真正的链路加密仍由 802.11 的 RSNA 四次握手完成**。DPP v2 还更进一步，把**前向保密（PFS）** 织进这次握手：关联时 STA 与 AP 各自再生成一个临时 DH 密钥对，现场算出共享秘密 Z，把 Z.x 混进 PTK 派生（§6.6.6）——即便日后 PMK 泄露，历史流量也回溯不出明文。

> 两位都领过卡的人见面，互相亮卡验签（Peer Discovery 两帧），确认"都是自己人、且有权对接"。验完得到一把共享暗号（PMK），接下来真正"对接干活"时，还是走公司既定的那套握手流程（四次握手）。

## 8.4 抓包实战 — 帧 type/subtype 与 Wireshark 过滤

把上面这些帧落到**真实空口**上，方便用 Wireshark 抓包对照。

**DPP 帧怎么封装**：DPP 的 Authentication / Peer Discovery / Result 等帧，都是 **802.11 管理帧里的 Public Action 帧**（type 0 Management、subtype 13 Action），具体结构是（§8.2.1 Table 34）：

```none
Category = 0x04        （Public Action）
Action   = 0x09        （Vendor Specific Public Action）
OUI      = 50:6F:9A    （Wi-Fi 联盟 OUI）
OUI Type = 0x1A        （标识这是 DPP）
DPP Frame Type = 0/1/2/…（区分具体哪一帧，见下表）
```

最关键的是 **DPP Frame Type** 字段，它区分了所有 DPP 帧（§8.2.1 Table 35）：

| DPP Frame Type | 帧                                          | 属于哪步               |
| -------------- | ------------------------------------------- | ---------------------- |
| **0 / 1 / 2**  | Authentication Request / Response / Confirm | ① Auth                 |
| **5 / 6**      | Peer Discovery Request / Response           | ③ Network Introduction |
| **11**         | Configuration Result                        | ② Config 的收尾        |
| 13             | Presence Announcement                       | v2 主动发起            |
| 7–10、18       | PKEX 各帧                                   | PKEX 引导              |

**注意 Configuration 那两帧是例外**：它们不是 Vendor Specific Public Action，而是借 **GAS 帧**承载（§6.4.1）——GAS Initial Request 的 Action = `0x0A`、GAS Initial Response = `0x0B`（与上一章 Passpoint 的 GAS 同一套机制），其 Advertisement Protocol ID 里同样带 OUI `50:6F:9A` + Type `0x1A` 标明是 DPP。

**Wireshark 过滤器**：

| 想找什么                                                     | 过滤器                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| 所有 Public Action 帧                                        | `wlan.fixed.category_code == 4`                              |
| Vendor Specific Public Action（DPP 的 Auth/PeerDisc/Result 都在此） | `wlan.fixed.category_code == 4 && wlan.fixed.publicact == 9` |
| 只看 DPP（按 Wi-Fi 联盟 OUI 筛）                             | `wlan.action.vendor_specific.oui == 0x506f9a`（Wireshark 较新版本可直接用 `wifi_dpp`） |
| DPP 的 Configuration（走 GAS）                               | `wlan.fixed.category_code == 4 && (wlan.fixed.publicact == 10 \|\| wlan.fixed.publicact == 11)` |
| 配完进入四次握手                                             | `eapol`                                                      |

> **注意**：DPP 的 Authentication 是**关联前**的 Public Action 帧，和 Passpoint 的 GAS 一样，普通网卡在已连接状态下未必抓得到——要抓全需用**监听模式（monitor mode）** 并锁定目标信道（正好呼应 §12.4：Enrollee 蹲守的那个信道）。

---

# 9 完整流程串讲

把全章串起来，用手机给一个智能灯泡配网的完整过程：

```none
0. 前提      灯泡(Enrollee)出厂时印好二维码(内含它的公钥+信道)
            手机(Configurator)已是网络管理者，持签名密钥
                  |  (带外，无空口帧)
1. Bootstrap 手机用 App 扫灯泡上的二维码 -> 得到灯泡公钥
                  |
2. Auth      3 帧 Public Action：Request/Response/Confirm
            基于公钥互认、AES-SIV 加封 -> 建立加密安全信道(ke)
                  |
3. Config    2 帧 GAS：灯泡发 Request 索要凭证
            手机回 Configuration Object(按 akm 发 Connector 或 PSK)
            + 1 帧 Public Action：灯泡回 Result
                  |
4. NetIntro  2 帧 Public Action：与 AP/其他设备交换 Connector、验签
            -> 推导出 PMK / PMKID
                  |
5. 四次握手   把 PMK 交给标准 WPA2/WPA3 四次握手 -> 建 PTK、加密流量
                  |
   完成       灯泡上网/互联，全程你没输过一次 WiFi 密码
```

---

# 10 本章总结

| 机制                                           | 作用                                      | 门禁比喻                 |
| ---------------------------------------------- | ----------------------------------------- | ------------------------ |
| **Configurator / Enrollee**                    | 配置器 / 待入网设备                       | 门卫 / 访客              |
| **Bootstrapping（QR/NFC/BLE/PKEX）**           | 带外获取对方公钥，奠定信任                | 扫一眼访客的二维码名牌   |
| **公钥引导信任**                               | 公钥可公开，私钥无法伪造，杜绝中间人      | 名牌上是锁，冒充者没钥匙 |
| **Authentication（3 帧 Public Action）**       | 基于公钥互认，建加密信道（ke）            | 当面核验 + 拉起私密频道  |
| **Configuration（2 帧 GAS + 结果帧）**         | 下发 Configuration Object / 凭证          | 递申请表、发卡或发钥匙   |
| **凭证类型（akm: dpp/psk/sae/dot1x）**         | 既能发 Connector，也能发传统 PSK/SAE 口令 | 新式门禁卡 或 老式钥匙   |
| **Connector（JWS 签名）**                      | 可被全网验证的身份凭证                    | 带防伪签名的门禁卡       |
| **Network Introduction（2 帧 Public Action）** | 凭 Connector 互认，推导 PMK/PMKID         | 互相亮卡、验签           |
| **交棒四次握手**                               | PMK/PMKID 交给 RSNA 四次握手做真正加密    | 验完卡，走既定握手干活   |

DPP 的精髓是：**用一个"带外的一眼"（扫码）交换公钥、奠定信任，再在 WiFi 信道上完成认证与发卡——让没有屏幕键盘的设备也能安全入网，且全网设备凭"门卫签发的卡"（Connector）互认，而非共享同一个密码。** 它解决的是"**怎么把设备安全地接进来**"，这正是"WiFi 另一面"的起点。下一章的 Passpoint，换个角度解决"**接入**"——让你的设备像手机蜂窝网一样，在运营商 WiFi 之间无缝漫游。

---

> 下一章将讲述：为什么有些公共 WiFi 不用选 SSID、不用输密码就自动连上、还能跨地点跨运营商无缝切换？手机在"关联之前"就能隔空问到 AP 背后是哪些运营商，靠的是什么机制（GAS/ANQP）？Discovery→Registration→Provisioning→Access 四个状态各在干什么？
