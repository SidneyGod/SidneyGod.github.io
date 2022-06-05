---
title: '[Make MyOS] Hello MyOS!'
top: 1
related_posts: true
mathjax: true
categories:
  - OS
  - Make OS
abbrlink: 307d30a
date: 2021-08-21 21:20:47
tags:
---

这是30天的第一天内容，也不知道自己能坚持到几天，有几天就几天了，活这么久了，半途而废的事情还少吗？

首先需要准备几个工具

# 1 qemu

不可能真去买个软盘什么的，所以我们需要一个虚拟计算机的东西——QEMU

<!--more-->

```bash
# qemu编译可能要用到的东西
sudo apt-get install ninja-build pkg-config build-essential zlib1g-dev \
  libglib2.0-dev binutils-dev libboost-all-dev autoconf libtool libssl-dev \
  libpixman-1-dev libpython-dev python-pip python-capstone virtualenv
# qemu显示要的东西 没有这个只能通过VNC去看了
sudo apt install libsdl2-dev -y

# 下载qemu源码 其实安装qemu倒没必要这么麻烦 只是我想着可能会顺带研究一下qemu
wget https://download.qemu.org/qemu-6.1.0-rc3.tar.xz
tar xvJf qemu-6.1.0-rc3.tar.xz
cd qemu-6.1.0-rc3
./configure  # 默认安装路径是/usr/local/bin/，这里注意 SDL support: YES 不为YES 后面就只能通过VNC查看了
make -j4
sudo make install
```

遇到的问题，当安装apt遇到下列错误时

```
E: Could not get lock /var/lib/dpkg/lock-frontend - open (11: Resource temporarily unavailable)
E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?
```

建议直接

```bash
sudo rm /var/lib/apt/lists/lock
sudo rm /var/cache/apt/archives/lock
sudo rm /var/lib/dpkg/lock*
sudo dpkg --configure -a
sudo apt update
```

# 2 nasm

写操作系统嘛，总不可能真的就用01来干，那得累死，所以需要用汇编，书中用的是nask，nask和nasm同为汇编编译器。nasm支持win、linux和MacOS，mask仅支持win。这两个差别不大，由于我们是在Ubuntu18下进行试验，所以必然选择nasm了，差距就是

| nask代码            | nasm代码                           |
| ------------------- | ---------------------------------- |
| `JMP entry`         | `JMP SHORT entry`                  |
| `RESB <填充字节数>` | `TIMES <填充字节数> DB <填充数据>` |
| `RESB 0x7dfe-$`     | `TIMES 0x1fe-($-$$) DB 0`          |
| `ALIGNB 16`         | `ALIGN 16, DB 0`                   |

我觉得这个就没必要再通过二进制包安装了，直接`sudo apt install nasm`就好了，然后用`nasm --version`检测一下是否安装好就ok了

# 3 hex editor

不说用01去写代码吧，看看01代码还是有必要的，所以还是需要一个趁手的十六进制编辑器的，这玩意我就随意百度了俩

```bash
sudo apt-get install wxhexeditor # 这玩意好久没更新了 官网都没了 但是挺好用的
sudo apt-get install bless       # 这个倒在更新 但是感觉一般吧
sudo apt-get install hexedit     # 这个是命令行版本
```

我觉得还是wxHexEditor比较强大，因为16进制能转成汇编..

# 4 helloos0

这个时候可以尝试实验了，直接把光盘中的`projects/01_day/helloos0/helloos.img`拷到我们自己的目录下，然后执行

```bash
sidney@ubuntu:~/Work/MyOS/day01$ qemu-system-i386 helloos.img
WARNING: Image format was not specified for 'helloos.img' and probing guessed raw.
         Automatically detecting the format is dangerous for raw images, write operations on block 0 will be restricted.
         Specify the 'raw' format explicitly to remove the restrictions.
```

虽然有warning，但是至少系统跑起来了，而想让这段警告消失，也很简单，将命令改为`qemu-system-i386 -drive file=helloos.img,format=raw,if=floppy`就ok了

按照书上说的，使用十六进制编写OS，神经病..我才不抄，浪费时间

```
0000000: EB4E 9048 454C 4C4F 4950 4C00 0201 0100 
0000016: 02E0 0040 0BF0 0900 1200 0200 0000 0000 
0000032: 400B 0000 0000 29FF FFFF FF48 454C 4C4F 
0000048: 2D4F 5320 2020 4641 5431 3220 2020 0000 
0000064: 0000 0000 0000 0000 0000 0000 0000 0000 
0000080: B800 008E D0BC 007C 8ED8 8EC0 BE74 7C8A 
0000096: 0483 C601 3C00 7409 B40E BB0F 00CD 10EB 
0000112: EEF4 EBFD 0A0A 6865 6C6C 6F2C 2077 6F72 
0000128: 6C64 0A00 0000 0000 0000 0000 0000 0000 
.......: 0000 0000 0000 0000 0000 0000 0000 0000
0000496: 0000 0000 0000 0000 0000 0000 0000 55AA
0000512: F0FF FF00 0000 0000 0000 0000 0000 0000
.......: 0000 0000 0000 0000 0000 0000 0000 0000
0005120: F0FF FF00 0000 0000 0000 0000 0000 0000
.......: 0000 0000 0000 0000 0000 0000 0000 0000
1474544: 0000 0000 0000 0000 0000 0000 0000 0000
1474560: # 因为我们是从0开始计数的哦
```

剩下的内容全为0，文件大小为$80\times18\times512\times2=1474560$字节，这个很重要，一定要保证大小正确

# 5 helloos1

按照书上第二步，稍微高级一点的东西，涉及到汇编，直接`vim myos.asm`

```assembly
DB  0xeb, 0x4e, 0x90, 0x48, 0x45, 0x4c, 0x4c, 0x4f
DB  0x49, 0x50, 0x4c, 0x00, 0x02, 0x01, 0x01, 0x00
DB  0x02, 0xe0, 0x00, 0x40, 0x0b, 0xf0, 0x09, 0x00
DB  0x12, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00
DB  0x40, 0x0b, 0x00, 0x00, 0x00, 0x00, 0x29, 0xff
DB  0xff, 0xff, 0xff, 0x48, 0x45, 0x4c, 0x4c, 0x4f
DB  0x2d, 0x4f, 0x53, 0x20, 0x20, 0x20, 0x46, 0x41
DB  0x54, 0x31, 0x32, 0x20, 0x20, 0x20, 0x00, 0x00
; RESB 16  ;这里和书上不一样 因为我们的环境是nasm而不是nask
TIMES 16 DB 0x00
DB  0xb8, 0x00, 0x00, 0x8e, 0xd0, 0xbc, 0x00, 0x7c
DB  0x8e, 0xd8, 0x8e, 0xc0, 0xbe, 0x74, 0x7c, 0x8a
DB  0x04, 0x83, 0xc6, 0x01, 0x3c, 0x00, 0x74, 0x09
DB  0xb4, 0x0e, 0xbb, 0x0f, 0x00, 0xcd, 0x10, 0xeb
DB  0xee, 0xf4, 0xeb, 0xfd, 0x0a, 0x0a, 0x68, 0x65
DB  0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x77, 0x6f, 0x72
DB  0x6c, 0x64, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00
; RESB    368
TIMES  368 DB 0x00
DB	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x55, 0xaa
DB	0xf0, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00
; RESB  4600
TIMES  4600 DB 0x00
DB  0xf0, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00
; RESB  1469432
TIMES  1469432 DB 0x00
```

通过命令`nasm myos.asm -o myos.img`得到我们编译出的操作系统，依旧是执行`qemu-system-i386 -drive file=myos.img,format=raw,if=floppy`，运行我们的操作系统，出现个hello world。不过这玩意还是不大能看懂什么意思

# 6 helloos2

再按书中的汇编，写个能看懂的操作系统

```assembly
; hello-os
; TAB=4

; 以下这段是标准FAT12格式软盘专用代码
DB  0xeb, 0x4e, 0x90 ; 这里eb4e是jmp 0x00000050，而90是nop
DB  "HELLOIPL"       ; 启动区的名称 可以是任意的字符串(8字节)
DW  512              ; 每个扇区(sector)的大小(必须是512字节)
DB  1                ; 簇(cluster)的大小(必须为1个扇区)
DW  1                ; FAT的起始位置(一般从第一个扇区开始)
DB  2                ; FAT的个数(必须为2)
DW  224              ; 根目录的大小(一般设置为224项)
DW  2880             ; 该磁盘的大小(必须是2880扇区)
DB  0xf0             ; 磁盘的种类(必须是0xf0)
DW  9                ; FAT的长度(必须是9扇区)
DW  18               ; 1个磁道(track)有几个扇区(必须是18)
DW  2                ; 磁头数(必须是2)
DD  0                ; 不使用分区(必须是0)
DD  2880             ; 重写一次磁盘大小
DB  0,0,0x29         ; 意义不明 固定
DD  0xffffffff       ; (可能是)卷标号码
DB  "HELLO-OS   "    ; 磁盘的名称(11字节)
DB  "FAT12   "       ; 磁盘格式名称(8字节)
;RESB  18             ; 先空出18字节
TIMES  18  DB 0

; 程序主体
DB  0xb8, 0x00, 0x00, 0x8e, 0xd0, 0xbc, 0x00, 0x7c
DB  0x8e, 0xd8, 0x8e, 0xc0, 0xbe, 0x74, 0x7c, 0x8a
DB  0x04, 0x83, 0xc6, 0x01, 0x3c, 0x00, 0x74, 0x09
DB  0xb4, 0x0e, 0xbb, 0x0f, 0x00, 0xcd, 0x10, 0xeb
DB  0xee, 0xf4, 0xeb, 0xfd

; 信息显示部分
DB  0x0a, 0x0a       ; 两个换行
DB  "This is my first OS!"
DB  0x0a             ; 换行
DB  0
;RESB  0x1fe-$       ; 填写0x00，直到0x001fe
TIMES  0x1fe-($-$$)  DB 0
DB  0x55, 0xaa       ; 必须保证510字节处是55aa

; 以下是启动区以外部分的输出
DB  0xf0, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00
;RESB  4600
TIMES   4600  DB  0
DB  0xf0, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00
;RESB  1469432
TIMES  1469432  DB  0
```

DB: define byte，往文件里直接写入1字节的指令

DW: define word，16位

DD: define double-word，32位

$ : 代表一个变量，表示当前行的偏移地址

$\$: 代表一个变量，表示当前段(汇编的section，数据段，代码段..)的起始偏移地址

TIMES: 重复定义数据或指令

RESB：reserve byte的缩写，RESB 10这一指令的含义是：从现在的地址开始空出10个字节，且nask（编译器）会自动在空出的部分填充上0x00，这就极大的节省了输入大量0x00的时间。



启动区(boot sector): 软盘第一个扇区称为启动区。计算机读写软盘时，是以512字节为一个单位进行读写的，因此软盘的512字节就称为一个扇区。一张软盘共有1440KB，也就是1474560字节，除以512得2880，也就是一张软盘有2880个扇区。计算机从最初一个扇区开始读软盘，然后去检查这个扇区最后2个字节的内容。如果最后2个字节不是55AA，计算机就认为这张盘上没有所需要启动的程序，就会报一个不能启动的错误。如果是55AA，那它就认为这个扇区的开头是启动程序，并开始执行这个程序。55AA没啥特殊含义..人家发明的时候定的

IPL(initial program loader): 启动程序加载器。启动区只有512字节，正常的操作系统不可能这么小，所以几乎所有的操作系统都是把加载操作系统本身的程序放在启动区里的。启动区的名字必须是8字节，不够得用空格补



感觉有上一篇的操作系统启动流程扫盲，有很多知识点还是比较清晰的..但是还是有几个疑惑点没去尝试，软盘能改成hdd？FAT12给整成FAT32？
