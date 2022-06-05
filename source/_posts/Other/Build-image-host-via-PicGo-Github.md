---
title: Build image host via PicGo + Github
top: 1
tags:
  - image host
categories: Other
abbrlink: 47391a30
date: 2019-11-29 23:12:09
---

嗯，比较懒，贴两个链接留作纪念：

PicGo + GitHub 搭建个人图床工具：https://blog.csdn.net/yefcion/article/details/88412025

~~PicGo + Gitee + Typora: https://www.cnblogs.com/qtzd/p/12554902.html~~ 图床，图个锤子，还是本地的最好

PicGo： https://github.com/Molunerfinn/PicGo

滥用VPN会导致DNS污染，从而利用github上传的图床都显示不出来了，需要解决一下，

https://www.ioiox.com/archives/62.html



通过 https://www.ipaddress.com/ 或 http://ping.chinaz.com/ 查询 raw.githubusercontent.com 的真实ip地址

再将以下内容保存到hosts文件(Win：`C:\Windows\System32\drivers\etc\hosts`)中

`<ip地址> raw.githubusercontent.com`

