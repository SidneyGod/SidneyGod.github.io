---
title: '[Relearning C/Cpp] Statements and Preprocessor'
top: 1
related_posts: true
categories:
  - Language
  - C/Cpp
abbrlink: 4163f7c1
date: 2020-08-10 00:02:25
tags:
  - Relearning C/Cpp
---

突然发现两个不错的网址

https://en.cppreference.com/w/cpp/language

https://en.cppreference.com/w/c/language

书籍千千万，不如这个定义来得直接啊

<!--more-->

# 基本语句

if...else，switch...case，while，for，do...while，break，continue，goto，return，空语句(一个分号)，try...catch

一些比较简单的就不说了，着重说一些没啥概念的

**switch...case**

```c++
switch(expression){
    case constant-expression  :
       statement(s);
       break; /* 可选的 */
    case constant-expression  :
       statement(s);
       break; /* 可选的 */
  
    /* 您可以有任意数量的 case 语句 */
    default : /* 可选的 */
       statement(s);
}

// switch 语句中的 expression 是一个常量表达式，必须是一个整型或枚举类型。
// C++中可以是一个 class 类型，其中 class 有一个单一的转换函数将其转换为整型或枚举类型。
// case 的 constant-expression 必须与 switch 中的变量具有相同的数据类型，且必须是一个常量或字面量
```

这里就有一个问题了，if...else和switch...case谁效率更高呢？我发现比较有意思的事情是，没那么绝对，得看编译器给不给你优化

```c++
int main() {
    int a = 3;
    if (a == 1) {
    } else if (a == 2) {
    } else {
    }

    switch(a) {
        case 3: break;
        case 2: break;
        default: ;
    }
    return 0;
}
// 这种情况下，if...else啥也没干直接被优化掉了，没错直接删代码那种，但是switch还在
```

汇编出来的代码是这样子的

```assembly
main:
	pushq	%rbp
	...
	.seh_endprologue
	call	__main
	movl	$3, -4(%rbp)  # int a = 3;
	cmpl	$2, -4(%rbp)  # 和2比较
	je	.L5
	cmpl	$3, -4(%rbp)  # 和3比较
	jmp	.L3
.L5:
	nop
.L3:
	movl	$0, %eax
	addq	$48, %rsp
	popq	%rbp
	ret
```

但是这种情况肯定是不常用的，神经病啊..写个没用的代码？我们让代码变得有用一点

```c++
int main() {
    int a = 3;
    if (a == 1) {
        a = 1;
    } else if (a == 2) {
        a = 2;
    } else {
        a = 3;
    }

    switch(a) {
        case 3: a = 2; break;
        case 2: a = 1; break;
        default: a = 3;
    }
    return 0;
}
// 显然这次代码变得有用多了
```

再汇编一下瞅瞅

```assembly
main:
	pushq	%rbp
	...
	.seh_endprologue
	call	__main
	movl	$3, -4(%rbp)  # int a = 3;
	cmpl	$1, -4(%rbp)  # if (a == 1)
	jne	.L2               # 不等于1的话  所以.L2和.L4都是if的
	movl	$1, -4(%rbp)  # 等于就直接赋值
	jmp	.L3               # 这里应当是到switch
.L2:
	cmpl	$2, -4(%rbp)
	jne	.L4
	movl	$2, -4(%rbp)
	jmp	.L3
.L4:
	movl	$3, -4(%rbp)
.L3:                      # 这么看的话好像差不多，switch还比if多一句呢
	cmpl	$2, -4(%rbp)
	je	.L5
	cmpl	$3, -4(%rbp)
	jne	.L6
	movl	$2, -4(%rbp)
	jmp	.L7
.L5:
	movl	$1, -4(%rbp)
	jmp	.L7
.L6:
	movl	$3, -4(%rbp)
.L7:
	movl	$0, %eax
	addq	$48, %rsp
	popq	%rbp
	ret
```

但是...https://blog.csdn.net/jeremyjone/article/details/103428009 网上都总结好了，我还折腾啥呢

这都是基本操作，就不说了，我们再看**try...catch**，这个东西只有C++有，叫做异常处理，有仨关键字：try，catch，throw，看看代码实例

```c++
#include <iostream>
#include <string>
#include <exception>

int divide(int a, int b) {
    if (b == 0) {
        // 抛出个异常
        throw std::runtime_error("Division by zero condition!");
    }
    return a / b;
}

void testException() {
    try {
        divide(10, 0);
    } catch (std::exception const &e) {
        std::cout << e.what() << std::endl;
    }  // 需要注意的是 C++中没有finally
}

// 自定义异常
class MyException : public std::exception {
public:
    MyException(int level, std::string str)
            : level(level), msg(std::move(str)) {}

    // 在这里，what() 是异常类提供的一个公共方法，它已被所有子异常类重载。这将返回异常产生的原因
    std::string what() {
        return msg + " -- " + std::to_string(level);
    }

private:
    int level;
    std::string msg;
};

void testMyException() {
    try {
        // 抛出自定义的异常 总体使用和Java的异常还是很像的
        throw MyException(1, "something wrong!");
    } catch (MyException &e) {
        std::cout << e.what() << std::endl;
    }
}
```

标准C++是没有类似finally这样的语句结构的。C#/Java 中保证无论是否出现异常，finally block 的代码均会得到执行；而 C++ 中，不论是否出现异常，局部变量的析构函数是会保证执行的，所以相对应与 finally block，C++ 的解决办法是 RAII，即Resource Aquisition Is Initialization。

基本的思路是，通过一个局部对象来表现资源，于是局部对象的析构函数将会释放资源。这样，程序员就不会忘记释放资源了。但是写析构函数是个技术活啊

C++11开始支持"Range-based for loop"，就是Java中的增强for循环

```c++
void test1() {
    std::vector<int> int_vec{1, 2, 3, 4, 5};

    for (const auto &item : int_vec) {  // 这个几乎和Java增强for循环一样
        std::cout << item << " ";
    }
    std::cout << std::endl;

    PAIR map[]{{"key",  1},
               {"key2", 2},
               {"key3", 3}};
    // 这个需要C++17特性
    for (const auto &[key, value] : map) {
        std::cout << "key: " << key << " -- value: " << value << std::endl;
    }
}
```

还有个类似的函数`std::for_each()`

# 2 宏

首先最常见的`#include`，导入头文件，一般分为`#include <filename>`和`#include "filename"`

一般来说，用`<>`表示搜索标准库里面的；用`""`表示搜索自己写的，如果自己写的没找到，再去搜标准库。所以我们直接用`""`是没问题的

其次常见的就是`#define`了，定义常量，比如说我们会防止头文件重复导入，在头文件上定义一个常量来标识

```c++
#ifndef XXX_H
#define XXX_H
//blablabla..
#endif //XXX_H
```

这里又认识了`#ifndef`和`#endif`(结束判断)，意思就是if not define，当然也会有`ifdef`，这样就可以防止头文件被多次导入引出的麻烦了

还有我们常说的宏开关`#if`，这其实就是if的功能，看起来高大上一点而已，还有`#else`，和`#elif`(就是else if)

```c++
#if 1
#define ee
#elif 2
#define aa
#else
#define cc
#endif
```

还有`#pragma`，这个宏在visual studio中常见，这个宏用起来比较复杂，其一般格式是`#pragma para`，其中para表示参数，瞅瞅常见参数

**#pragma message**

常常这么用`#pragma message("some msg..")`，当编译器遇到这条指令时就在**编译输出窗口**中将消息文本打印出来，编译时才会打印哦

```
E:\Workspace\CCpp\test>g++ -std=c++17 main.cpp -o x
main.cpp:1:31: note: #pragma message: hello world!
 #pragma message("hello world!")
```

同时，**还有`#error`和`#warning`**，也是针对编译时的，其中warning只是发出警告，error会停止编译

**#pragma code_seg**

`#pragma code_seg( ["section-name"[,"section-class"] ] )`，它能够设置程序中函数代码存放的代码段，当我们开发驱动程序的时候就会使用到它

**#pragma once**

只要在头文件的最开始加入这条指令就能够保证头文件被编译一次，和上面提到的宏定义道理是一样的，这个宏在VS经常见到，但不是标准的，所以可能有的不兼容

**#pragma pack**

使用指令``#pragma pack (n)``，编译器将按照n个字节对齐。使用指令``#pragma pack ()``，编译器将取消自定义字节对齐方式。关于字节对齐，其实就是性能和空间之间的平衡

```c++
struct TestStruct1
{
   char c1;
   short s;
   char c2;
   int i;
};
```

按照常理说，如果c1的内存位置是0，那么s就是1-2，c2就是3，i就是4-7；实际上呢，地址开头是0，2，4，8。意思就是默认四字节对齐

首先，每个成员分别按自己的方式对齐,并能最小化长度。

其次，复杂类型(如结构)的默认对齐方式是它最长的成员的对齐方式,这样在成员是复杂类型时,可以最小化长度。

然后，对齐后的长度必须是成员中最大的对齐参数的整数倍,这样在处理数组时可以保证每一项都边界对齐。

还有其他的，不了解了..



下一个是**`#line`**，说到这个，就不得不说`__LINE__`和`__FILE__`，一般来说这LINE和FILE就是单纯的行数和文件名，然而这个LINE和FILE就是固定的吗？显然不是，这个line就可以重新定义这两个宏

语法：`#line lineNum fileName`，其中lineNum是数字；fileName是字符串，可省略。这个宏定义了lineNum，那下一行的数字就是lineNum



再说**可变参数宏**，源码里面常见的打log的工具

`#define ERROR(format, ...)  fprintf(stderr, format, __VA_ARGS__)`

这`__VA_ARGS__`就是可变参数宏，嗯，可变参数..



再说源码里面常用的**`#，##，#@`**

`#`: 对应变量字符串化

`##`: 连接符

`#@`: 将单字符的标记转成单字符 举个栗子

```c++
int i = 1;
int x1 = 1;
// 1 #
#define trace(x, format) printf(#x " = %" #format "\n", x)
trace(i, d);  // 相当于 printf("i = %d\n", i);
// 2 ##
#define trace2(a) trace(x##i, d)
trace2(1);  // 相当于 trace(x1, d)
// 3 #@
#define B(x) #@x
B(a);  // 即为 'a', 但 B(abc); 没效果
```

