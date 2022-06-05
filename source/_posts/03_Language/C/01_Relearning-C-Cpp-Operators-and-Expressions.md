---
title: '[Relearning C/Cpp] Operators and Expressions'
top: 1
categories:
  - Language
  - C/Cpp
abbrlink: ea0e14e5
date: 2020-06-17 23:15:07
tags:
  - Relearning C/Cpp
---

# 1 算数运算符

| 运算符 | 描述                             | 实例             |
| :----- | :------------------------------- | :--------------- |
| +      | 把两个操作数相加                 | A + B 将得到 30  |
| -      | 从第一个操作数中减去第二个操作数 | A - B 将得到 -10 |
| *      | 把两个操作数相乘                 | A * B 将得到 200 |
| /      | 分子除以分母                     | B / A 将得到 2   |
| %      | 取模运算符，整除后的余数         | B % A 将得到 0   |
| ++     | 自增运算符，整数值增加 1         | A++ 将得到 11    |
| --     | 自减运算符，整数值减少 1         | A-- 将得到 9     |

没啥好说的，可能比较有意思的是，`++`和`--`了

<!-- more -->

```c
int main() {
    int s = 0;
    for (int i = 0; i < 10; ++i) {
        s = s++;
    }
    printf("s: %d\n", s);  // s: 0

    return 0;
}
```

第一眼看过去，那不得炸毛？啥，不说等于10，起码也得等于9吧。说好的先运算，再自加1呢。其实感觉都被那句话给带偏了，前置++是先自增，再运算；后置++是先运算，再自增。这句话是不准确的，准确来说，无论前置++还是后置++，都是先+1，再运算，区别是后置++会先将原来的值存在一个临时变量中，运算的时候用这个临时变量运算。

在第五版的C++ Primer的132页，有这么一句话：**前置版本的递增运算符避免了不必要的工作，它把值加1后直接返回改变了的运算对象。与之相比，后置版本需要将原始值存储下来以便于返回这个未修改的内容**。也就是说，真实情况应该是这样的：

```c
int main() {
    int s = 0;
    for (int i = 0; i < 10; ++i) {
        int tmp = s;
        s = s + 1;
        s = tmp;
    }
    printf("s: %d\n", s);  // s: 0 这样毫无疑问是等于0的

    return 0;
}
```

不信？我们看看汇编代码(`gcc -S main.cpp -o main.s`)：

```assembly
; 略...
	call	__main
	movl	$0, -4(%rbp)    ; 这个是int s = 0;
	movl	$0, -8(%rbp)    ; int i = 0;
.L5:
	cmpl	$9, -8(%rbp)    ; i和9作比较
	jg	.L4                 ; 大于9就跳到.L4
	movl	-4(%rbp), %eax  ; 把s的值放到eax先 是0
	leal	1(%rax), %edx   ; rax + 1放到edx，rax没出现过，就当是0好了
	movl	%edx, -4(%rbp)  ; 把edx值1放到s中 s = 1
	movl	%eax, -4(%rbp)  ; 把eax的值放到s中 s = 0
	addl	$1, -8(%rbp)    ; i = i + 1
	jmp	.L5                 ; 跳回到.L5
.L4:
; 略...
```

所以C++ Primer中**推荐优先使用前置运算符**

# 2 逻辑和关系运算符

| 运算符 | 描述                                                         | 实例              |
| :----- | :----------------------------------------------------------- | :---------------- |
| &&     | 称为逻辑与运算符。如果两个操作数都非零，则条件为真。         | (A && B) 为假。   |
| \|\|   | 称为逻辑或运算符。如果两个操作数中有任意一个非零，则条件为真。 | (A \|\| B) 为真。 |
| !      | 称为逻辑非运算符。用来逆转操作数的逻辑状态。如果条件为真则逻辑非运算符将使其为假。 |                   |
| ==     | 检查两个操作数的值是否相等，如果相等则条件为真。             | (A == B) 不为真。 |
| !=     | 检查两个操作数的值是否相等，如果不相等则条件为真。           | (A != B) 为真。   |
| >      | 检查左操作数的值是否大于右操作数的值，如果是则条件为真。     | (A > B) 不为真。  |
| <      | 检查左操作数的值是否小于右操作数的值，如果是则条件为真。     | (A < B) 为真。    |
| >=     | 检查左操作数的值是否大于或等于右操作数的值，如果是则条件为真。 | (A >= B) 不为真。 |
| <=     | 检查左操作数的值是否小于或等于右操作数的值，如果是则条件为真。 | (A <= B) 为真。   |

注意&&和||是短路的。

```c
(expr1) && (expr2);  // 如果计算出expr1是false，就不会再去计算expr2
(expr1) || (expr2);  // 如果计算出expr1是true，就不会再去计算expr2
```

# 3 赋值运算符

任何一种复合赋值运算符都等价于`a = a op b`。例如：`a += 1;`就等价于`a = a + 1;`。唯一的区别就是，使用复合赋值运算符只求值一次，使用普通赋值运算需要求值两次。第一次，右边运算求一次值；第二次，赋值的时候左侧运算对象求值。这么说来还是复合赋值运算符好一点

# 4 位运算符

假设变量 A 的值为 60，变量 B 的值为 13，则：

| 运算符 | 描述                                                         | 实例                                                         |
| :----- | :----------------------------------------------------------- | :----------------------------------------------------------- |
| &      | 如果同时存在于两个操作数中，二进制 AND 运算符复制一位到结果中。 | (A & B) 将得到 12，即为 0000 1100                            |
| \|     | 如果存在于任一操作数中，二进制 OR 运算符复制一位到结果中。   | (A \| B) 将得到 61，即为 0011 1101                           |
| ^      | 如果存在于其中一个操作数中但不同时存在于两个操作数中，二进制异或运算符复制一位到结果中。 | (A ^ B) 将得到 49，即为 0011 0001                            |
| ~      | 二进制补码运算符是一元运算符，具有"翻转"位效果，即0变成1，1变成0。 | (~A ) 将得到 -61，即为 1100 0011，一个有符号二进制数的补码形式。 |
| <<     | 二进制左移运算符。左操作数的值向左移动右操作数指定的位数。   | A << 2 将得到 240，即为 1111 0000                            |
| >>     | 二进制右移运算符。左操作数的值向右移动右操作数指定的位数。   | A >> 2 将得到 15，即为 0000 1111                             |

**位运算符作用于位，并逐位执行操作。**在kernel中经常喜欢用位运算做flag判断，感受一下：

```c
static unsigned FLAG_0 = 0b000;  // 0
static unsigned FLAG_1 = 0b001;  // 1
static unsigned FLAG_2 = 0b010;  // 2
static unsigned FLAG_4 = 0b100;  // 4

unsigned flag_0 = FLAG_0;
unsigned flag_1 = FLAG_1;
unsigned flag_0_1 = FLAG_0 | FLAG_1;
unsigned flag_1_2 = FLAG_1 | FLAG_2;
unsigned flag_1_2_4 = FLAG_1 | FLAG_2 | FLAG_4;

// |表示+?
printf("flag_0_1: %d\n", flag_0_1);  // 1
printf("flag_1_2: %d\n", flag_1_2);  // 3
printf("flag_1_2_4: %d\n", flag_1_2_4);  // 7

// 0和& 可以用来清空
printf("flag_0 & FLAG_0: %d\n", flag_0 & FLAG_0);  // 0
printf("flag_1 & FLAG_0: %d\n", flag_1 & FLAG_0);  // 0

// 非0和& 可以用来判断包不包含当前的FLAG
printf("flag_1 & FLAG_1: %d\n", flag_1 & FLAG_1);  // 1
printf("flag_1 & FLAG_2: %d\n", flag_1 & FLAG_2);  // 0

// |并不是单纯的+ 不包含则+ 包含则不加；&(~FLAG)表示减去这个FLAG 有则减 无则不用管
printf("flag_1_2 | FLAG_1: %d\n", flag_1_2 | FLAG_1);  // 3
printf("flag_1_2 & FLAG_1: %d\n", flag_1_2 & FLAG_1);  // 1
printf("flag_1_2 & (FLAG_1 | FLAG_4): %d\n", flag_1_2 & (FLAG_1 | FLAG_4));  // 1
printf("flag_1_2 & (~FLAG_1): %d\n", flag_1_2 & (~FLAG_1));  // 2
printf("flag_1_2 & (~(FLAG_1 | FLAG_4)): %d\n", flag_1_2 & (~(FLAG_1 | FLAG_4)));  // 2

printf("flag_1_2_4 | FLAG_1 | FLAG_2: %d\n", flag_1_2_4 | FLAG_1 | FLAG_2);  // 7
printf("flag_1_2_4 & (FLAG_1 | FLAG_2): %d\n", flag_1_2_4 & (FLAG_1 | FLAG_2));  // 3
printf("flag_1_2_4 & (~(FLAG_1 | FLAG_2)): %d\n", flag_1_2_4 & (~(FLAG_1 | FLAG_2)));  // 4
```

**强烈建议位运算只用于无符号数..**

# 5 杂项

条件运算符：`?:`，唯一一个三元运算符，就是一个简化版的if-else，但是效率比if-else高

sizeof运算符：`sizeof(expr)`，事实上并**不会去使用expr**，所以即使`sizeof(*ptr)`，其中ptr是null，也不会报错，多用于求数组长度，毕竟C/C++没有`arr.length`的用法

逗号运算符：`v = expr1, expr2`，从左向右的顺序依次求值，然后丢弃左侧结果的值，**真正返回的是右侧的值**

# 6 成员访问运算符

就是点运算符`.`和箭头运算符`->`。其中点运算符是获取类对象的一个成员。`ptr->mem`或`(*ptr).mem`，注意**解引用运算符低于点运算符**

运算符优先级：https://blog.csdn.net/yuliying/article/details/72898132

<table border="1" cellspacing="0" cellpadding="0" width="612"><tbody><tr><td>
<p align="center">
<strong>优先级</strong></p>
</td>
<td>
<p align="center">
<strong>运算符</strong></p>
</td>
<td>
<p align="center">
<strong>名称或含义</strong></p>
</td>
<td>
<p align="center">
<strong>使用形式</strong></p>
</td>
<td>
<p align="center">
<strong>结合方向</strong></p>
</td>
<td>
<p align="center">
<strong>说明</strong></p>
</td>
</tr><tr><td rowspan="4">
<p align="center">
<strong>1</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">[]</span></strong></p>
</td>
<td>
<p>
数组下标</p>
</td>
<td>
<p>
数组名[常量表达式]</p>
</td>
<td rowspan="4">
<p align="center">
左到右</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">()</span></strong></p>
</td>
<td>
<p>
圆括号</p>
</td>
<td>
<p>
(表达式）/函数名(形参表)</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">.</span></strong></p>
</td>
<td>
<p>
成员选择（对象）</p>
</td>
<td>
<p>
对象.成员名</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">-&gt;</span></strong></p>
</td>
<td>
<p>
成员选择（指针）</p>
</td>
<td>
<p>
对象指针-&gt;成员名</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td width="612" colspan="6">
<p>
&nbsp;</p>
</td>
</tr><tr><td rowspan="9">
<p align="center">
<strong>2</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">-</span></strong></p>
</td>
<td>
<p>
负号运算符</p>
</td>
<td>
<p>
-表达式</p>
</td>
<td rowspan="9">
<p align="center">
<strong><span style="color:#FF0000;">右到左</span></strong></p>
</td>
<td rowspan="7">
<p align="center">
单目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">~</span></strong></p>
</td>
<td>
<p>
按位取反运算符</p>
</td>
<td>
<p>
~表达式</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">++</span></strong></p>
</td>
<td>
<p>
自增运算符</p>
</td>
<td>
<p>
++变量名/变量名++</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">--</span></strong></p>
</td>
<td>
<p>
自减运算符</p>
</td>
<td>
<p>
--变量名/变量名--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">*</span></strong></p>
</td>
<td>
<p>
取值运算符</p>
</td>
<td>
<p>
*指针变量</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&amp;</span></strong></p>
</td>
<td>
<p>
取地址运算符</p>
</td>
<td>
<p>
&amp;变量名</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">!</span></strong></p>
</td>
<td>
<p>
逻辑非运算符</p>
</td>
<td>
<p>
!表达式</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">(</span><span style="color:#0000FF;">类型</span><span style="color:#0000FF;">)</span></strong></p>
</td>
<td>
<p>
强制类型转换</p>
</td>
<td>
<p>
(数据类型)表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">sizeof</span></strong></p>
</td>
<td>
<p>
长度运算符</p>
</td>
<td>
<p>
sizeof(表达式)</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td width="612" colspan="6">
<p>
&nbsp;</p>
</td>
</tr><tr><td rowspan="3">
<p align="center">
<strong>3</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">/</span></strong></p>
</td>
<td>
<p>
除</p>
</td>
<td>
<p>
表达式/表达式</p>
</td>
<td rowspan="3">
<p align="center">
左到右</p>
</td>
<td rowspan="3">
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">*</span></strong></p>
</td>
<td>
<p>
乘</p>
</td>
<td>
<p>
表达式*表达式</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">%</span></strong></p>
</td>
<td>
<p>
余数（取模）</p>
</td>
<td>
<p>
整型表达式%整型表达式</p>
</td>
</tr><tr><td rowspan="2">
<p align="center">
<strong>4</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">+</span></strong></p>
</td>
<td>
<p>
加</p>
</td>
<td>
<p>
表达式+表达式</p>
</td>
<td rowspan="2">
<p align="center">
左到右</p>
</td>
<td rowspan="2">
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">-</span></strong></p>
</td>
<td>
<p>
减</p>
</td>
<td>
<p>
表达式-表达式</p>
</td>
</tr><tr><td rowspan="2">
<p align="center">
<strong>5</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">&lt;&lt;&nbsp;</span></strong></p>
</td>
<td>
<p>
左移</p>
</td>
<td>
<p>
变量&lt;&lt;表达式</p>
</td>
<td rowspan="2">
<p align="center">
左到右</p>
</td>
<td rowspan="2">
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&gt;&gt;&nbsp;</span></strong></p>
</td>
<td>
<p>
右移</p>
</td>
<td>
<p>
变量&gt;&gt;表达式</p>
</td>
</tr><tr><td width="612" colspan="6">
<p>
&nbsp;</p>
</td>
</tr><tr><td rowspan="4">
<p align="center">
<strong>6</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">&gt;&nbsp;</span></strong></p>
</td>
<td>
<p>
大于</p>
</td>
<td>
<p>
表达式&gt;表达式</p>
</td>
<td rowspan="4">
<p align="center">
左到右</p>
</td>
<td rowspan="4">
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&gt;=</span></strong></p>
</td>
<td>
<p>
大于等于</p>
</td>
<td>
<p>
表达式&gt;=表达式</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&lt;&nbsp;</span></strong></p>
</td>
<td>
<p>
小于</p>
</td>
<td>
<p>
表达式&lt;表达式</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&lt;=</span></strong></p>
</td>
<td>
<p>
小于等于</p>
</td>
<td>
<p>
表达式&lt;=表达式</p>
</td>
</tr><tr><td rowspan="2">
<p align="center">
<strong>7</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">==</span></strong></p>
</td>
<td>
<p>
等于</p>
</td>
<td>
<p>
表达式==表达式</p>
</td>
<td rowspan="2">
<p align="center">
左到右</p>
</td>
<td rowspan="2">
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">！</span><span style="color:#0000FF;">=</span></strong></p>
</td>
<td>
<p>
不等于</p>
</td>
<td>
<p>
表达式!= 表达式</p>
</td>
</tr><tr><td width="612" colspan="6">
<p>
&nbsp;</p>
</td>
</tr><tr><td>
<p align="center">
<strong>8</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">&amp;</span></strong></p>
</td>
<td>
<p>
按位与</p>
</td>
<td>
<p>
表达式&amp;表达式</p>
</td>
<td>
<p align="center">
左到右</p>
</td>
<td>
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong>9</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">^</span></strong></p>
</td>
<td>
<p>
按位异或</p>
</td>
<td>
<p>
表达式^表达式</p>
</td>
<td>
<p align="center">
左到右</p>
</td>
<td>
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong>10</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">|</span></strong></p>
</td>
<td>
<p>
按位或</p>
</td>
<td>
<p>
表达式|表达式</p>
</td>
<td>
<p align="center">
左到右</p>
</td>
<td>
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong>11</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">&amp;&amp;</span></strong></p>
</td>
<td>
<p>
逻辑与</p>
</td>
<td>
<p>
表达式&amp;&amp;表达式</p>
</td>
<td>
<p align="center">
左到右</p>
</td>
<td>
<p align="center">
双目运算符</p>
</td>
</tr><tr><td>
<p align="center">
<strong>12</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">||</span></strong></p>
</td>
<td>
<p>
逻辑或</p>
</td>
<td>
<p>
表达式||表达式</p>
</td>
<td>
<p align="center">
左到右</p>
</td>
<td>
<p align="center">
双目运算符</p>
</td>
</tr><tr><td width="612" colspan="6">
<p>
&nbsp;</p>
</td>
</tr><tr><td>
<p align="center">
<strong>13</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">?:</span></strong></p>
</td>
<td>
<p>
条件运算符</p>
</td>
<td>
<p>
表达式1?</p>
<p>
表达式2: 表达式3</p>
</td>
<td>
<p align="center">
<strong><span style="color:#FF0000;">右到左</span></strong></p>
</td>
<td>
<p align="center">
<span style="color:#FF0000;">三目运算符</span></p>
</td>
</tr><tr><td width="612" colspan="6">
<p>
<span style="color:#FF0000;">&nbsp;</span></p>
</td>
</tr><tr><td rowspan="11">
<p align="center">
<strong>14</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">=</span></strong></p>
</td>
<td>
<p>
赋值运算符</p>
</td>
<td>
<p>
变量=表达式</p>
</td>
<td rowspan="11">
<p align="center">
<strong><span style="color:#FF0000;">右到左</span></strong></p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">/=</span></strong></p>
</td>
<td>
<p>
除后赋值</p>
</td>
<td>
<p>
变量/=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">*=</span></strong></p>
</td>
<td>
<p>
乘后赋值</p>
</td>
<td>
<p>
变量*=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">%=</span></strong></p>
</td>
<td>
<p>
取模后赋值</p>
</td>
<td>
<p>
变量%=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">+=</span></strong></p>
</td>
<td>
<p>
加后赋值</p>
</td>
<td>
<p>
变量+=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">-=</span></strong></p>
</td>
<td>
<p>
减后赋值</p>
</td>
<td>
<p>
变量-=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&lt;&lt;=</span></strong></p>
</td>
<td>
<p>
左移后赋值</p>
</td>
<td>
<p>
变量&lt;&lt;=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&gt;&gt;=</span></strong></p>
</td>
<td>
<p>
右移后赋值</p>
</td>
<td>
<p>
变量&gt;&gt;=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">&amp;=</span></strong></p>
</td>
<td>
<p>
按位与后赋值</p>
</td>
<td>
<p>
变量&amp;=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">^=</span></strong></p>
</td>
<td>
<p>
按位异或后赋值</p>
</td>
<td>
<p>
变量^=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td>
<p align="center">
<strong><span style="color:#0000FF;">|=</span></strong></p>
</td>
<td>
<p>
按位或后赋值</p>
</td>
<td>
<p>
变量|=表达式</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr><tr><td width="612" colspan="6">
<p>
&nbsp;</p>
</td>
</tr><tr><td>
<p align="center">
<strong>15</strong></p>
</td>
<td>
<p align="center">
<strong><span style="color:#0000FF;">,</span></strong></p>
</td>
<td>
<p>
逗号运算符</p>
</td>
<td>
<p>
表达式,表达式,…</p>
</td>
<td>
<p align="center">
左到右</p>
</td>
<td>
<p align="center">
--</p>
</td>
</tr></tbody></table>
