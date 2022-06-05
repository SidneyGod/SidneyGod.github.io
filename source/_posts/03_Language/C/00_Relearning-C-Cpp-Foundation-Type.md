---
title: '[Relearning C/Cpp] Foundation Type'
top: 1
categories:
  - Language
  - C/Cpp
abbrlink: 6a5ea6b7
date: 2020-06-16 22:13:04
tags:
  - Relearning C/Cpp
---

# 1 标识符 关键字

标识符命名规则：

1. 变量名只能是字母（A-Z，a-z）和数字（0-9）或者下划线（_）或者美元符号（**$**）组成
2. 第一个字母不能是数字
3. 不能使用C/C++关键字来命名变量
4. 变量名区分大小写

```c++
int $name1, _name2, Name3;
```

> 似乎有的版本不支持`$`..我试了gcc8.1是可以的

C语言关键字：

<!--more-->

| 关键字   | 说明                                               |
| -------- | -------------------------------------------------- |
| auto     | 声明自动变量                                       |
| short    | 声明短整型变量或函数                               |
| int      | 声明整型变量或函数                                 |
| long     | 声明长整型变量或函数                               |
| float    | 声明浮点型变量或函数                               |
| double   | 声明双精度变量或函数                               |
| char     | 声明字符型变量或函数                               |
| struct   | 声明结构体变量或函数                               |
| union    | 声明共用数据类型                                   |
| enum     | 声明枚举类型                                       |
| typedef  | 用以给数据类型取别名                               |
| const    | 声明只读变量                                       |
| unsigned | 声明无符号类型变量或函数                           |
| signed   | 声明有符号类型变量或函数                           |
| extern   | 声明变量是在其他文件正声明                         |
| register | 声明寄存器变量                                     |
| static   | 声明静态变量                                       |
| volatile | 说明变量在程序执行中可被隐含地改变                 |
| void     | 声明函数无返回值或无参数，声明无类型指针           |
| if       | 条件语句                                           |
| else     | 条件语句否定分支（与 if 连用）                     |
| switch   | 用于开关语句                                       |
| case     | 开关语句分支                                       |
| for      | 一种循环语句                                       |
| do       | 循环语句的循环体                                   |
| while    | 循环语句的循环条件                                 |
| goto     | 无条件跳转语句                                     |
| continue | 结束当前循环，开始下一轮循环                       |
| break    | 跳出当前循环                                       |
| default  | 开关语句中的“其他”分支                             |
| sizeof   | 计算数据类型长度                                   |
| return   | 子程序返回语句（可以带参数，也可不带参数）循环条件 |

C++关键字：

![Cpp_Keywords](assets/00_Relearning-C-Cpp-Foundation-Type/Cpp_Keywords.jpg)

https://www.runoob.com/w3cnote/cpp-keyword-intro.html

# 2 变量声明 定义 初始化

补充知识，C语言从源文件到可执行文件一般经历四个步骤：预处理，编译，汇编，链接

**声明**：声明是只是向编译器声明一下我用到的变量或者类型，与分配内存毫无关系

**定义**：给变量分配了空间才叫做定义。定义往往是附庸于声明的，通俗地说，也就是只当你先声明了一个变量，才有可能为其分配空间（定义）

**初始化**：定义只是给变量分配了内存空间，但一开始决定这内存空间存放什么值是由初始化决定的

```c++
// 在C中直接这样写IDE是不会报错的 就是说在预处理阶段是不会有问题的
// 在C++中要指明aa的类型 即 extern int aa;
extern aa;  // 声明没有分配空间 即使是extern int aa;也没有分配空间 其实在c中不加类型 默认是int
int aa;  // 这里分配了int大小的空间给aa，即定义aa的大小
aa = 10;  // 这里初始化aa的值
int a {10};  // 在C++中初始化不一定就是=，还可以用{}
```

# 3 变量类型 大小 类型转换

**变量类型**

C变量类型：

| 说  明   | 字符型 | 短整型 | 整型 | 长整型 | 单精度浮点型 | 双精度浮点型 | 无类型 |
| -------- | ------ | ------ | ---- | ------ | ------------ | ------------ | ------ |
| 数据类型 | char   | short  | int  | long   | float        | double       | void   |

除了`float`，`double`，`void`都还可以再加个`unsigned`修饰；(还有就是`struct`，`enum`，`union`复合类型了，只说基础变量类型)

C++变量类型：除了C语言的，还有`bool`，`wchar_t`(宽字符类型)，还有一个和`struct`差不多的`class`

**变量大小**

ANSI/ISO制订的4条铁定的原则

1. sizeof(short int)<=sizeof(int)
2. sizeof(int)<=sizeof(long int)
3. short int至少应为16位（2字节）
4. long int至少应为32位

常见系统情况

参考：https://blog.csdn.net/weixin_30367359/article/details/81211393

**类型转换**

C中**自动类型转换**：编译器默默地、隐式地、偷偷地进行的数据类型转换，这种转换不需要程序员干预，会自动发生

将一种类型的数据赋值给另外一种类型的变量时就会发生自动类型转换

```c
float f = 100;  // 这里100是int型，需要先转换为float型才能赋值给f
```

在不同类型的混合运算中，编译器也会自动地转换数据类型，将参与运算的所有数据先转换为同一种类型，然后再进行计算。转换规则如下：

![type_conversion](assets/00_Relearning-C-Cpp-Foundation-Type/type_conversion.png)

也就是说，在赋值运算中，赋值号两边的数据类型不同时，需要把右边表达式的类型转换为左边变量的类型，这可能会导致数据失真，或者精度降低；所以说，**自动类型转换并不一定是安全的**。对于不安全的类型转换，编译器一般会给出警告。

C中**强制类型转换**：在代码中明确地提出要进行类型转换

```c
// 强转规则 (type_name) expression
(float) 100;  // 将100转为float类型

(double) 10 / 4;  // 2.500000
(double) (10 / 4);  // 2.000000
// 因为()优先级比/高 这一点需要注意
```

如何理解**类型转换只是临时性的**

无论是自动类型转换还是强制类型转换，都只是为了本次运算而进行的临时性转换，转换的结果也会保存到临时的内存空间，不会改变数据本来的类型或者值

```c
double d = 5.5;
int i = 5;
int id = (int) d;
double result = d / i;

printf("%d, %lf, %lf\n", id, d, result);  // 5, 5.500000, 1.100000
// 虽然第3行对d进行强转了，但是并没有改变d的值
```

C++中类型转换，首先C语言能用的，C++都能用，不过强制类型转换，C++有自己的一套

**static_cast**：`static_cast<type_id> (expression)`

用于类层次结构中基类和派生类之间指针或引用的转换

用于基本数据类型之间的转换，如把int转换成char

把空指针转换成目标类型的空指针

把任何类型的表达式转换为void类型

**注意：static_cast不能转换掉expression的`const`、`volitale`或者`__unaligned`属性**

**const_cast**：`const_cast<type_id> (expression)`

用来修改类型的const或volatile属性。除了const或volatile修饰之外，type_id和expression的类型是一样的

常量指针被转化成非常量指针，并且仍然指向原来的对象

常量引用被转换成非常量引用，并且仍然指向原来的对象；常量对象被转换成非常量对象

**const_cast不是用于去除变量的常量性，而是去除指向常数对象的指针或引用的常量性，其去除常量性的对象必须为指针或引用**

```c++
    const int a = 101;
    const int* p = &a;

    // *p = 22;  // 只读 不允许修改
    // int b = const_cast<int>(a);  // const_cast强制转换对象必须为指针或引用
    int* c = const_cast<int *>(p);  // 去掉const属性
    *c = 22;  // 没毛病 *p值就能改了
```

**reinterpret_cast**：`reinterpret_cast<type_id> (expression)`

改变指针或引用的类型、将指针或引用转换为一个足够长度的整型、将整型转换为指针或引用类型

type_id必须是一个指针、引用、算术类型、函数指针或者成员指针

**在使用reinterpret_cast强制转换过程仅仅只是比特位的拷贝，因此在使用过程中需要特别谨慎**

```c++
// 万物皆可转..
int *i = new int;
double *d = reinterpret_cast<double *>(i);
```

**dynamic_cast**：`dynamic_cast<type_id> (expression)`

**其他三种都是编译时完成的，dynamic_cast是运行时处理的，运行时要进行类型检查**

**不能用于内置的基本数据类型的强制转换**

**dynamic_cast转换如果成功的话返回的是指向类的指针或引用，转换失败的话则会返回NULL**

**使用dynamic_cast进行转换的，基类中一定要有虚函数，否则编译不通过**(需要检测有虚函数的原因：类中存在虚函数，就说明它有想要让基类指针或引用指向派生类对象的情况，此时转换才有意义。这是由于运行时类型检查需要运行时类型信息，而这个信息存储在类的虚函数表中，只有定义了虚函数的类才有虚函数表)

**在类的转换时，在类层次间进行上行转换时，dynamic_cast和static_cast的效果是一样的。在进行下行转换时，dynamic_cast具有类型检查的功能，比static_cast更安全**

**向下转换的成功与否还与将要转换的类型有关，即要转换的指针指向的对象的实际类型与转换以后的对象类型一定要相同，否则转换失败**

嗯..略..

# 4 变量作用域

能不能简单理解为一个`{}`就是一个域，总有没套在`{}`里面的，那肯定比在`{}`里活得久啊

变量作用域，一是看其能覆盖到哪，二是看其能活多久

首先，强龙压不过地头蛇，其次，你得让人作用域见过你

```c
int a = 10;  // 没有被{}包裹 全局变量 活得久
int main() {
    printf("%d\n", a);  // 这个肯定没问题 声明在上面见过 作用域比a小
    //printf("%d\n", b);  // 找不到b的声明
    {
        int a = 11;
        printf("%d\n", a);  // 11 这就叫强龙压不过地头蛇 
    }
    return 0;
}
int b = 20;
```

这又牵扯到了声明

```c
int main() {
    {
        extern bb;  // 这里声明一下 让编译器去找
        printf("%d\n", bb);  // 在这个作用域就可以用了
    }
    //printf("%d\n", bb);  // 这个就不行 在这个作用域中没有声明过 找不到
    return 0;
}
int bb = 20;
```

再说说全局变量和局部变量

- 在函数或一个代码块内部定义的变量，称为局部变量
- 在函数参数的定义中定义的变量，称为形式参数
- 在所有函数外部定义的变量，称为全局变量

为什么说extern修饰的变量是全局变量？其实我觉得和extern没关系，毕竟extern只是声明，不分配空间

```c
int main() {
    {
        extern a, b;
        // printf("%d\n", a);  // 既声明也在下面定义了 但是编译的时候还是会报错 undefined
        printf("%d\n", b);  // 全局的就没问题了 也就是说extern是在全局变量中找 而不是声明为全局
    }
    int a = 10;
}
int b = 20;
```

可以看到，C语言的作用域还是蛮简单的，C++还有个域操作符`::`，其实也很简单

```c++
namespace names {  // 这就声明一个命名空间
    int aa = 10;
}
int aa = 20;
int main() {
    int aa = 30;
    // 10 - 20 - 30  有内味了 names下的aa，没名字下的aa，没名字就叫全局
    std::cout << names::aa << " - " << ::aa << " - " << aa << std::endl;
    return 0;
}

// 再说一点class的知识
class AA {
public:
    void print();  // 这叫声明一个函数
};
void AA::print() {}  // 这叫定义一个函数 你不说明是aa的print，那编译器哪知道是不是
```

# 5 变量存储位置

一个C/C++程序的内存占用情况

栈区：由编译器自动分配释放，存放函数的参数值，局部变量的值等

堆区：一般由程序员分配释放，若程序员不释放，程序结束时可能由操作系统回收。注意它与数据结构中的堆是两回事，分配方式类似于链表

全局区/静态区：全局变量和静态变量的存储是放在一块的。初始化的全局变量和静态变量在一块区域，未初始化的全局变量和静态变量又放在相邻的另一块区域中。程序结束后由系统释放

常量区：字符串常量和其他类型常量存放位置。程序结束后由系统释放

代码区：存放函数体的二进制代码

```c
int a = 0; // 全局初始化区
char *p1; // 全局未初始化区

void test() {
    int b; // 栈 
    char s[] = "abc"; // s在栈 "abc\0"在常量区
    char *p2; // 栈 
    char *p3 = "123456"; // 123456\0 在常量区，p3在栈上。 
    static int c = 0; // 全局（静态）初始化区 
    p1 = (char *) malloc(10);
    p2 = (char *) malloc(20); // 分配得来得10和20字节的区域就在堆区
    strcpy(p1, "123456"); // 123456\0放在常量区，编译器可能会做优化，指向p3指向的"123456"
}
```

上面的划分的区对应到操作系统(深入理解计算机系统)的各种段：

bss段：Block Started by Symbol，通常是指用来存放程序中未初始化的全局变量的一块内存区域，不给该段的数据分配空间，只是记录数据所需空间的大小，bss段属于静态内存分配

data段：通常是指用来存放程序中已初始化的全局变量的一块内存区域，数据分配空间，数据保存在目标文件中，data段属于静态内存分配

rodata段：read only data segment，存放常量数据(但不是所有，有些马上数与指令编译在一起直接放在代码段)，用const修饰的全局变量是放入常量区的，可是使用const修饰的局部变量仅仅是设置为只读起到防止改动的效果，没有放入常量区，有些系统中rodata段是多个进程共享的，目的是为了提高空间的利用率

text段：通常是指用来存放程序执行代码的一块内存区域。这部分区域的大小在程序运行前就已经确定，并且内存区域通常属于只读(某些架构也允许代码段为可写，即允许修改程序)。在text段中，也有可能包含一些只读的常数变量(`int a = 10;`中的10)等

heap：用于存放进程运行中被动态分配的内存段，它的大小并不固定，可动态扩张或缩减。当进程调用malloc等函数分配内存时，新分配的内存就被动态添加到堆上（堆被扩张）；当利用free等函数释放内存时，被释放的内存从堆中被剔除（堆被缩减）

stack：用户存放程序临时创建的局部变量。也就是括弧`{}`中定义的变量（但不包括static声明的变量，static意味着在data段中存放变量）。除此以外，在函数被调用时，其参数也会被压入发起调用的进程栈中，并且待到调用结束后，函数的返回值也会被存放回栈中。由于栈的先进先出(FIFO)特点，所以栈特别方便用来保存/恢复调用现场。

> **一个程序本质上都是由 bss段、data段、text段三个组成的**。这样的概念，不知道最初来源于哪里的规定，但在当前的计算机程序设计中是很重要的一个基本概念。一般在初始化时bss段部分将会清零。bss段属于静态内存分配，即程序一开始就将其清零了。比如，在C语言之类的程序编译完成之后，已初始化的全局变量保存在`.data`段中，未初始化的全局变量保存在`.bss`段中。
>
> text和data段都在可执行文件中（在嵌入式系统里一般是固化在镜像文件中），由系统从可执行文件中加载；而bss段不在可执行文件中，由系统初始化。

应该放上一段汇编的，奈何看不太明白，mark几条命令

```bash
# 汇编代码 8086 或者 AT&T，Linux上一般是ATT的
gcc -S -O2 -masm=intel main.c -o main.s
gcc -S -O2 -masm=att main.c -o main.s

# 反汇编
objdump -sd test.exe
objdump -h test.exe  # 查看代码段啥的..

# 列出目标文件的符号清单
nm test.exe
```

**静态变量(static)**

在C/C++中，static 关键字不仅可以用来修饰变量，还可以用来修饰函数。在使用static关键字修饰变量时，我们称此变量为静态变量。静态变量的存储方式与全局变量一样，都是静态存储方式，但是全局变量不是静态变量

全局变量的作用域是整个源程序，当一个源程序由多个源文件组成时，全局变量在各个源文件中都是有效的；全局变量之前加上关键字static来实现，使全局变量被定义成为一个静态全局变量，此时该变量只能在本文件中使用，起到了对其他源文件进行**隐藏与隔离**的作用

如果希望函数中局部变量的值在**函数调用结束之后不会消失**，而仍然保留其原值，即它所占用的存储单元不释放，在下一次调用该函数时，其局部变量的值仍然存在，也就是上一次函数调用结束时的值，此时，应该将该局部变量用关键字static声明为**静态局部变量**，当将局部变量声明为静态局部变量的时候，也就改变了局部变量的存储位置，即从原来的栈中存放改为静态存储区存放。这让它看起来很像全局变量，其实静态局部变量与全局变量的主要区别就在于可见性，静态局部变量只在其被声明的代码块中是可见的

在静态数据区，内存中所有的字节默认值都是0x00。静态变量与全局变量也一样，它们都存储在静态数据区中，因此其变量的值默认也为0(对自动变量不赋初值，其值是不定的，所以说有的不初始化的静态变量，有可能被优化到data段)

static对函数的修饰与对全局变量的修饰相似，只能被本文件中的函数调用，而不能被同一程序其它文件中的函数调用，所以satic函数又被称为内部函数

**寄存器变量(register)**

`'register' storage class specifier is deprecated and incompatible with C++17`

使用修饰符register声明的变量属于寄存器存储类型。该类型与自动存储类型相似，具有自动存储时期、代码块作用域和内连接。声明为register仅仅是一个请求，因此该变量仍然可能是普通的自动变量。无论哪种情况，用**register修饰的变量都无法获取地址**(在C++中，register变量在内存中有副本，可以获取到副本的地址)。如果没有被初始化，它的值是未定的。register可以加速变量值访问速度，如果不存在竞争条件，并且该变量会被频繁的访问使用，可以使用register。

**volatile**

因为访问寄存器要比访问内存单元快的多，所以编译器一般都会作减少存取内存的优化，但有可能会读脏数据。遇到volatile声明的变量，编译器对访问该变量的代码就不再进行优化，从而可以提供对特殊地址的稳定访问；如果不使用volatile，则编译器将对所声明的语句进行优化。当一个变量存在竞争条件时，如果没有上锁，为了维护数据的统一性，则必须显式的使用volatile进行声明。在对变量声明时，默认的是使用volatile声明，但是如果没有显式的使用该修饰付，那么编译器可能会优化成register变量。

使用volatile的场景：中断服务程序中修改的供其它程序检测的变量需要；多任务环境下各任务间共享的标志；存储器映射的硬件寄存器，因为每次对它的读写都可能有不同意义

**const**

内存被初始化后，**程序**(硬件可以，所以const可以和volatile一起用)便不能对其进行修改。const修饰的全局变量的链接性为内部的(就像加了static)。若希望某个常量的链接性为外部的，则可以**使用关键字extern覆盖默认的内部链接性**，这种情况下所有使用该常量的文件都要使用extern来引用声明它，**只能在其中一个文件初始化该变量，且之后该变量不可修改**

**常量：固定值**，在程序执行期间不会改变。这些固定的值，又叫做**字面量**。常量可以是任何的基本数据类型，比如整数常量、浮点常量、字符常量，或字符串字面值，也有枚举常量。一般说到常量，就不得不提`#define`和`const`。define是宏定义，程序在预处理阶段将用define定义的内容进行了替换。因此程序运行时，常量表中并没有用define定义的常量，系统不为它分配内存(就存储来看，我觉得不能算常量)。const定义的常量，在程序运行时在常量表中，系统为它分配内存。define定义的常量，预处理时只是直接进行了替换。所以编译时不能进行数据类型检验。const定义的常量，在编译时进行严格的类型检验，可以避免出错。define定义表达式时要注意**边缘效应**(就是要记得加括号，仅仅是替换)

说常量是只读的，只是个笑话，实质上内存永远都可以被用户随意修改，只是编译器给用户的代码注入了一些自己的保护代码，通过软件手段将这段内存软保护起来。这种保护在汇编级别可以轻松突破，其保护也就无效了

# 6 类型推导

在C++11之前的版本（C++98和C++03）中，定义变量或者声明变量之前都必须指明它的类型，比如 int、char 等；但是在一些比较灵活的语言中，比如 C#、JavaScript、PHP、Python 等，程序员在定义变量时可以不指明具体的类型，而是让编译器（或者解释器）自己去推导，这就让代码的编写更加方便，阅读更加费事(我觉得就不应该出现这玩意，编译器能推导出来是啥类型，我可不行啊)

**auto**

在之前的C++版本中，auto关键字用来指明变量的存储类型，它和static关键字是相对的。auto表示变量是自动存储的，这也是编译器的默认规则，所以写不写都一样，一般我们也不写，这使得auto关键字的存在变得非常鸡肋。C++11赋予auto关键字新的含义，使用它来做自动类型推导

```c++
// 这全篇auto写下来，代码还能看？
auto n = 10;
auto f = 12.8;
auto p = &n;
auto url = "123456";
```

注意：auto 仅仅是一个占位符，在编译器期间它会被真正的类型所替代。或者说，C++ 中的变量必须是有明确类型的，只是这个类型是由编译器自己推导出来的。

不能在函数的参数中使用；不能作用于类的非静态成员变量；不能定义数组；不能作用于模板参数

**decltype**

declare type，和auto的功能一样，都用来在编译时期进行自动类型推导，这个关键字的出现肯定为了弥补auto不足之处，用法：

```c++
// varname 表示变量名，value 表示赋给变量的值，exp 表示一个表达式
auto varname = value;
decltype(exp) varname[ = value];
```

decltype能够根据变量、字面量、带有运算符的表达式推导出变量的类型

推到规则：

- 如果exp是一个不被括号`()`包围的表达式，或者是一个类成员访问表达式，或者是一个单独的变量，那么`decltype(exp)`的类型就和exp一致，这是最普遍最常见的情况
- 如果exp是函数调用，那么`decltype(exp)`的类型就和函数返回值的类型一致
- 如果exp是一个左值，或者被括号`()`包围，那么`decltype(exp)`的类型就是exp的引用；假设exp的类型为`T`，那么`decltype(exp)`的类型就是`T&`

两者之间的区别：

auto要求变量必须初始化，也就是在定义变量的同时必须给它赋值；而decltype不要求，初始化与否都不影响变量的类型。这很容易理解，因为auto是根据变量的初始值来推导出变量类型的，如果不初始化，变量的类型也就无法推导了。

auto将变量的类型和初始值绑定在一起，而decltype将变量的类型和初始值分开；虽然auto的书写更加简洁，但decltype的使用更加灵活

如果表达式的类型不是指针或者引用，auto会把cv(const volatile)限定符直接抛弃，推导成non-const或者non-volatile类型；如果表达式的类型是指针或者引用，auto将保留cv限定符

**decltype会保留cv限定符**

# 7 typedef

https://blog.csdn.net/Andrewniu/article/details/80566324

C语言允许用户使用 typedef 关键字来定义自己习惯的数据类型名称，来替代系统默认的基本类型名称、数组类型名称、指针类型名称与用户自定义的结构型名称、共用型名称、枚举型名称等。

```c
#define true 1
#define false 0
typedef int bool;
// 在C语言中也可以愉快地使用bool了
bool aFlag = true;
```

**为基本数据类型定义新的类型名**

为了跨平台，定义一种类型与平台无关

```c
#ifndef _SIZE_T_DEFINED
#ifdef  _WIN64
typedef unsigned __int64    size_t;
#else
typedef _W64 unsigned int   size_t;
#endif
#define _SIZE_T_DEFINED
#endif
```

**为自定义数据类型（结构体、共用体和枚举类型）定义简洁的类型名称**

先看C语言的情况

```c
struct tagMyNode{
    int data;
    struct tagMyNode *next;
} MyNode;

struct tagMyNode *mTagNode;  // 老长了

int main2() {
    MyNode.data = 8;
    mTagNode->data = 10;
    
    return 0;
}

/***********用了typedef之后***********/
typedef struct tagMyNode{
    int data;
    struct tagMyNode *next;
} MyNode;

MyNode *mTagNode;  // 事实上等价于 typedef struct tagMyNode MyNode;

int main() {
    // MyNode.data = 10;
    mTagNode->data = 10;
    
    return 0;
}

/**********再来个有趣的**********/
typedef struct tagMyNode{
    int data;
    struct tagMyNode *next;
} MyNode, Node;

MyNode *mTagNode;  // typedef struct tagMyNode MyNode;
Node *mNode;  // typedef struct tagMyNode Node;

int main() {
    mTagNode->data = 10;
    mNode->data = 10;

    return 0;
}
```

再看看C++有没有什么不同

```c++
struct tagMyNode{
    int data;
    struct tagMyNode *next;
} MyNode;

tagMyNode *mTagNode;  // 这里其实是把struct当class用了
struct tagMyNode *mTagNode2;


int main1() {
    MyNode.data = 10;
    // tagMyNode->data = 10;  // 没有初始化的类不能操作 但可以 mTagNode = new tagMyNode;
    mTagNode2->data = 10;

    return 0;
}

/**********使用typedef*************/
typedef struct tagMyNode{
    int data;
    struct tagMyNode *next;
} MyNode;

tagMyNode *mTagNode;  // 事实上这里是 class tagMyNode;
MyNode *mTagNode2;

int main1() {
    // tagMyNode->data = 10;
    mTagNode2->data = 10;

    return 0;
}
```

**为数组定义简介类型**

```c
typedef int INT_ARR_LEN_10[10];
INT_ARR_LEN_10 arr;
```

**为指针定义简洁的名称**

```c
typedef char* PCHAR;
PCHAR pc;

const PCHAR pChar;  // 等价于const char* pChar;吗？
// 其实是不等价的，typedef不是字符串替换，这里const应当是修饰指针的，即指针常量(网上通俗叫法)
// 所以等价于char* const，而不是const char*，有点懵？
```

> 先补充一下，对于`int *const p = &a;`，网上通常的叫法是指针常量，而在C++ Primer第五版中叫做常量指针，虽然叫法不一样，但是大家的意思是一样的

```c
char c = 'a';

const char *p1 = "abc";  // 指向常量的变量指针 从右向左看
char const *p2 = "abc";  // 指向常量的变量指针
char *const p3 = "abc";  // 指向变量的常量指针
const char const *p4 = "abc";  // 其实这里的第二个const是多余的
const char *const p5 = "abc";  // 指向常量的常量指针

p1 = &c;  // p1的值可以变
// *p1 = c;  // p1指向的值不能变

p2 = &c;  // 同上
// *p1 = c;

// p3 = &c;  // p3的值不可以变 p3是指针(地址) 是常量
*p3 = c;  // *p3的值可以变

p4 = &c;  // 同p1
// *p4 = c;

// p5 = &c;  // 指针(地址)常量 不可变
// *p5 = c;  // 指向常量 不可变
```

按照C++ Primer的说法，**从右向左看**似乎是能看通的，没啥大问题。不过这么想，const优先和左边结合，左边没有再和右边结合，反正const就是不允许变的意思，并且这样就能说得通上面的`const PCHAR`是`PCHAR const`，也就是`char* const`，而不是`const char *`或`char const *`了。

这里的指针换成C++的引用也是同样适用的

话又说回来，**一般使用typedef去简化指针的时候似乎都会加个const**，例如：`typedef const char* PCHAR;`，以使得该指针本身是常量，而不是对象

# 8 sizeof

这个其实没啥好说的，就是这是个关键字，不是个函数..比如说，写一段cpp代码，如下

```c++
#include <iostream>

void fun(int a) {}

int main() {
    int a = sizeof(int);
    fun(4);
    return 0;
}
```

汇编一下

```assembly
main:
	pushq	%rbp
	...  # 先不管中间是啥
	.seh_endprologue
	call	__main  # 程序入口 main函数 从汇编来看 main并不是第一阶段
	movl	$4, -4(%rbp)  # 这一步我觉得是 int a = sizeof(int);
	movl	$4, %ecx  # 这一步我觉得是 a = 4，fun的形参
	call	_Z3funi  # 这才是调用函数fun，可见，如果是函数必然是要call的
	movl	$0, %eax
	addq	$48, %rsp
	popq	%rbp
	ret
```

从汇编代码来看，在编译阶段就已经知道`sizeof(int)`的值了