---
title: '[Relearning C/Cpp] Supplement'
top: 1
related_posts: true
tags:
  - Relearning C/Cpp
categories: 
  - Language
  - C/Cpp
abbrlink: c8ed763e
date: 2021-05-05 17:40:29
---

这篇笔记主要是对C/Cpp一些知识的补充，这篇笔记过后就是抽象机制以及一些库函数的学习了

# 1 源文件与程序

一个C语言文件到可执行文件，中间经历了什么？预处理(Preprocessing)、编译(Compilation)、汇编(Assemble)、链接(Linking)。这是耳熟能详的几个过程，甚至还能敲出对应的gcc命令，那么实际上到底是啥情况呢？比如现在有个C程序

```c
#include <stdio.h>
int main(void) {
    printf("Hello World!\n");
    return 0;
}
```

敲出gcc的命令：`gcc main.c -o main.o -v`

<!--more-->

```bash
[root@SidneyDing hello]# gcc main.c -o main.o -v
Using built-in specs.
COLLECT_GCC=gcc
COLLECT_LTO_WRAPPER=/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/lto-wrapper
Target: x86_64-redhat-linux
Configured with: ../configure --prefix=/usr --mandir=/usr/share/man --infodir=/usr/share/info --with-bugurl=http://bugzilla.redhat.com/bugzilla --enable-bootstrap --enable-shared --enable-threads=posix --enable-checking=release --with-system-zlib --enable-__cxa_atexit --disable-libunwind-exceptions --enable-gnu-unique-object --enable-linker-build-id --with-linker-hash-style=gnu --enable-languages=c,c++,objc,obj-c++,java,fortran,ada,go,lto --enable-plugin --enable-initfini-array --disable-libgcj --with-isl=/builddir/build/BUILD/gcc-4.8.5-20150702/obj-x86_64-redhat-linux/isl-install --with-cloog=/builddir/build/BUILD/gcc-4.8.5-20150702/obj-x86_64-redhat-linux/cloog-install --enable-gnu-indirect-function --with-tune=generic --with-arch_32=x86-64 --build=x86_64-redhat-linux
Thread model: posix
gcc version 4.8.5 20150623 (Red Hat 4.8.5-36) (GCC)
COLLECT_GCC_OPTIONS='-o' 'main.o' '-v' '-mtune=generic' '-march=x86-64'
 /usr/libexec/gcc/x86_64-redhat-linux/4.8.5/cc1 -quiet -v main.c -quiet -dumpbase main.c -mtune=generic -march=x86-64 -auxbase main -version -o /tmp/cc8LaNsi.s
GNU C (GCC) version 4.8.5 20150623 (Red Hat 4.8.5-36) (x86_64-redhat-linux)
        compiled by GNU C version 4.8.5 20150623 (Red Hat 4.8.5-36), GMP version 6.0.0, MPFR version 3.1.1, MPC version 1.0.1
GGC heuristics: --param ggc-min-expand=100 --param ggc-min-heapsize=131072
ignoring nonexistent directory "/usr/lib/gcc/x86_64-redhat-linux/4.8.5/include-fixed"
ignoring nonexistent directory "/usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../x86_64-redhat-linux/include"
#include "..." search starts here:
#include <...> search starts here:
 /usr/lib/gcc/x86_64-redhat-linux/4.8.5/include
 /usr/local/include
 /usr/include
End of search list.
GNU C (GCC) version 4.8.5 20150623 (Red Hat 4.8.5-36) (x86_64-redhat-linux)
        compiled by GNU C version 4.8.5 20150623 (Red Hat 4.8.5-36), GMP version 6.0.0, MPFR version 3.1.1, MPC version 1.0.1
GGC heuristics: --param ggc-min-expand=100 --param ggc-min-heapsize=131072
Compiler executable checksum: c0b461ba69dba093bfc939a7fa8b7724
COLLECT_GCC_OPTIONS='-o' 'main.o' '-v' '-mtune=generic' '-march=x86-64'
 as -v --64 -o /tmp/ccqhVoX2.o /tmp/cc8LaNsi.s
GNU assembler version 2.27 (x86_64-redhat-linux) using BFD version version 2.27-34.base.el7
COMPILER_PATH=/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/:/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/:/usr/libexec/gcc/x86_64-redhat-linux/:/usr/lib/gcc/x86_64-redhat-linux/4.8.5/:/usr/lib/gcc/x86_64-redhat-linux/
LIBRARY_PATH=/usr/lib/gcc/x86_64-redhat-linux/4.8.5/:/usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64/:/lib/../lib64/:/usr/lib/../lib64/:/usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../:/lib/:/usr/lib/
COLLECT_GCC_OPTIONS='-o' 'main.o' '-v' '-mtune=generic' '-march=x86-64'
 /usr/libexec/gcc/x86_64-redhat-linux/4.8.5/collect2 --build-id --no-add-needed --eh-frame-hdr --hash-style=gnu -m elf_x86_64 -dynamic-linker /lib64/ld-linux-x86-64.so.2 -o main.o /usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64/crt1.o /usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64/crti.o /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtbegin.o -L/usr/lib/gcc/x86_64-redhat-linux/4.8.5 -L/usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64 -L/lib/../lib64 -L/usr/lib/../lib64 -L/usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../.. /tmp/ccqhVoX2.o -lgcc --as-needed -lgcc_s --no-as-needed -lc -lgcc --as-needed -lgcc_s --no-as-needed /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtend.o /usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64/crtn.o
[root@SidneyDing hello]# ls
main.c  main.o
```

看起来好像挺乱的，我们拆分一下

```bash
 /usr/libexec/gcc/x86_64-redhat-linux/4.8.5/cc1 main.c -o /tmp/cc8LaNsi.s  # 第10行，预处理 + 编译
 as -o /tmp/ccqhVoX2.o /tmp/cc8LaNsi.s  # 第27行，汇编
 /usr/libexec/gcc/x86_64-redhat-linux/4.8.5/collect2 \
   -dynamic-linker /lib64/ld-linux-x86-64.so.2 \
   -o main.out \
      /usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64/crt1.o \
      /usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64/crti.o \
      /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtbegin.o \
      /tmp/ccqhVoX2.o \
   -lc /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtend.o \
      /usr/lib/gcc/x86_64-redhat-linux/4.8.5/../../../../lib64/crtn.o  # 第32行，链接
```

其中呢，cc1可以再拆分为

```bash
cpp -o main.i main.c  # 预编译 一般语法检查阶段
/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/cc1 main.i -o /tmp/ccMDBkDo.s  # 编译
```

这时候，你可能在怀疑，这些命令真的有用？我们来一个伪`makefile.sh`试试

```bash
# main.i
cpp -o main.i main.c; ls
# main.s
/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/cc1 -o main.s main.i; ls
# main.o
as -o main.o main.s; ls
# main.out
/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/collect2 \
   -dynamic-linker /lib64/ld-linux-x86-64.so.2 \
   -o main.out \
      /usr/lib64/crt1.o \
      /usr/lib64/crti.o \
      /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtbegin.o \
      main.o \
   -lc /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtend.o \
      /usr/lib64/crtn.o; ls
# .clean
# rm -rf main.i main.s main.o main.out
```

这么一运行

```bash
[root@SidneyDing hello]# bash makefile.sh
main.c  main.i  makefile.sh
 main
Analyzing compilation unit
Performing interprocedural optimizations
 <*free_lang_data> <visibility> <early_local_cleanups> <*free_inline_summary> <whole-program>Assembling functions:
 main
Execution times (seconds)
 phase setup             :   0.00 ( 0%) usr   0.00 ( 0%) sys   0.01 (50%) wall    1094 kB (74%) ggc
 phase parsing           :   0.00 ( 0%) usr   0.01 (100%) sys   0.01 (50%) wall     329 kB (22%) ggc
 parser (global)         :   0.00 ( 0%) usr   0.01 (100%) sys   0.01 (50%) wall     287 kB (20%) ggc
 TOTAL                 :   0.00             0.01             0.02               1472 kB
main.c  main.i  main.s  makefile.sh
main.c  main.i  main.o  main.s  makefile.sh
main.c  main.i  main.o  main.out  main.s  makefile.sh
[root@SidneyDing hello]# ./main.out
Hello World!
```

瞅瞅，是不是就是那么回事~

从这件事中，我们学到了，从源文件到可执行程序需要经历：**C源程序 > 预编译处理 > 编译 > 优化程序 > 汇编程序 > 链接程序 > 可执行文件**

`main.i`是预处理后的文件，把所有要包含的(include)文件的内容递归式加到原始C文件中，再输出到`main.i`中，除此之外，还展开了所有的宏定义，所以在`main.i`中看不到任何的宏

`main.s`是编译后的文件，就是将C转换为汇编代码

`main.o`是汇编后的文件，就是将上面的汇编代码翻译成符合一定格式的机器代码，在Linux上一般表现为ELF目标文件(通过`file main.o`查看得知)

`main.out`是链接后的文件，将上步的目标文件与系统的目标文件，库文件链接起来，最后生成在特定平台运行的可执行文件。

为什么要链接库文件(`crt1.o crti.o`)？这些目标文件都是用来初始化或者回收C运行时环境的，比如说堆内存分配，上下文环境的初始化等，实际上crt就是C Runtime的所写。这也暗示了另一点，程序并不是从main开始执行的，而是从crt中某个入口开始的，在Linux上此入口是`_start`。

探究程序的入口可能对于进程怎么诞生有点好处，参考：[从创建进程到进入main函数，发生了什么？ (qq.com)](https://mp.weixin.qq.com/s/YsqoIfFZkHw1pEzsdkfo9Q)

我的目的只是**简单**熟悉一下Makefile，不说会写吧，至少能看懂写的啥..

# 2 GNU Makefile

参考：

[GNU make](https://www.gnu.org/software/make/manual/make.html) -- 官方文档

[Makefile.pdf (seisman.github.io)](https://seisman.github.io/how-to-write-makefile/Makefile.pdf) -- 感觉是官方文档的翻译..

比如将上面的伪makefile改成真正的Makefile

```makefile
.PHONY: clean
all: main.out
main.out: main.o
	ld -dynamic-linker /lib64/ld-linux-x86-64.so.2 \
	-o main.out \
		/usr/lib64/crt1.o \
		/usr/lib64/crti.o \
		/usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtbegin.o \
		main.o \
	-lc /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtend.o \
		/usr/lib64/crtn.o
main.o: main.s
	as -o main.o main.s
main.s: main.i
	/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/cc1 -o main.s main.i
main.i: main.c
	cpp -o main.i main.c
clean:
	rm -rf main.i main.s main.o main.out
```

然后执行make相关命令

```bash
[root@SidneyDing hello]# make
cpp -o main.i main.c
/usr/libexec/gcc/x86_64-redhat-linux/4.8.5/cc1 -o main.s main.i
 main
Analyzing compilation unit
Performing interprocedural optimizations
 <*free_lang_data> <visibility> <early_local_cleanups> <*free_inline_summary> <whole-program>Assembling functions:
 main
Execution times (seconds)
 phase setup             :   0.00 ( 0%) usr   0.00 ( 0%) sys   0.01 (50%) wall    1094 kB (74%) ggc
 phase parsing           :   0.00 ( 0%) usr   0.00 ( 0%) sys   0.01 (50%) wall     329 kB (22%) ggc
 phase opt and generate  :   0.00 ( 0%) usr   0.01 (100%) sys   0.00 ( 0%) wall      32 kB ( 2%) ggc
 parser (global)         :   0.00 ( 0%) usr   0.00 ( 0%) sys   0.01 (50%) wall     287 kB (20%) ggc
 expand                  :   0.00 ( 0%) usr   0.01 (100%) sys   0.00 ( 0%) wall       2 kB ( 0%) ggc
 TOTAL                 :   0.00             0.01             0.02               1472 kB
as -o main.o main.s
ld -dynamic-linker /lib64/ld-linux-x86-64.so.2 \
-o main.out \
        /usr/lib64/crt1.o \
        /usr/lib64/crti.o \
        /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtbegin.o \
        main.o \
-lc /usr/lib/gcc/x86_64-redhat-linux/4.8.5/crtend.o \
        /usr/lib64/crtn.o
[root@SidneyDing hello]# ls
main.c  main.i  main.o  main.out  main.s  Makefile  makefile.sh
[root@SidneyDing hello]# ./main.out
Hello World!
[root@SidneyDing hello]# make clean
rm -rf main.i main.s main.o main.out
[root@SidneyDing hello]# ls
main.c  Makefile  makefile.sh
[root@SidneyDing hello]#
```

**make怎么工作的？**

一般情况下，当输入make命令时，

> 1 make 会在当前目录下找名字叫“Makefile”或“makefile”的文件
>
> 2 如果找到，它会找文件中的第一个目标文件（target），在上面的例子中，他会找到“all”这个文
> 件，并把这个文件作为最终的目标文件。
>
> 3 如果 all 文件不存在，或是 all 所依赖的后面的 .o 文件的文件修改时间要比 all 这个文件新， 那么，他就会执行后面所定义的命令来生成 all 这个文件。
>
> 4 如果 all 所依赖的 .o 文件也不存在，那么 make 会在当前文件中找目标为 .o 文件的依赖性，如果找到则再根据那一个规则生成 .o 文件。（这有点像一个堆栈的过程）
>
> 5 当然，你的 C 文件和 H 文件是存在的啦，于是 make 会生成 .o 文件，然后再用 .o 文件生成 make 的终极任务，也就是执行文件 all 了。

**Makefile 里有什么？**

> 1 显式规则。显式规则说明了如何生成一个或多个目标文件。这是由 Makefile 的书写者明显指出要 生成的文件、文件的依赖文件和生成的命令。
>
> 2 隐晦规则。由于我们的 make 有自动推导的功能，所以隐晦的规则可以让我们比较简略地书写 Makefile，这是由 make 所支持的。
>
> 3 变量的定义。在 Makefile 中我们要定义一系列的变量，变量一般都是字符串，这个有点像你 C 语 言中的宏，当 Makefile 被执行时，其中的变量都会被扩展到相应的引用位置上。
>
> 4 文件指示。其包括了三个部分，一个是在一个 Makefile 中引用另一个 Makefile，就像 C 语言中的 include 一样；另一个是指根据某些情况指定 Makefile 中的有效部分，就像 C 语言中的预编译 #if 一样；还有就是定义一个多行的命令。有关这一部分的内容，我会在后续的部分中讲述。
>
> 5 注释。Makefile 中只有行注释，和 UNIX 的 Shell 脚本一样，其注释是用 # 字符，这个就像 C/C++ 中的 // 一样。如果你要在你的 Makefile 中使用 # 字符，可以用反斜杠进行转义，如：\# 。
>
> 最后，还值得一提的是，在 Makefile 中的命令，必须要以 Tab 键开始。

pdf太详细了..不抄了。多说一句可以`make [target]`，比如`make main.i`

# 3 动态分配内存

这个和前面两个内容没有太大关系，但却是比较重要的一点。命名对象的生命周期一般由作用域决定，但是很多时候，我们希望生命周期和作用域分开，比如子函数中创建一个变量，希望在子函数执行完了，主函数中还能用。这个时候就需要将该变量放在堆(heap)上。先看C语言的

```c
#include <stdlib.h>  // 头文件
void* malloc( size_t size );  // Allocates size bytes of uninitialized storage.
void* calloc( size_t num, size_t size );  // Allocates memory for an array of num objects of size and initializes all bytes in the allocated storage to zero.
void *realloc( void *ptr, size_t new_size );  // Reallocates the given area of memory. It must be previously allocated by malloc(), calloc() or realloc() and not yet freed with a call to free or realloc. Otherwise, the results are undefined.
void free( void* ptr );  // Deallocates the space previously allocated by malloc(), calloc(), aligned_alloc(), (since C11) or realloc().
void *aligned_alloc( size_t alignment, size_t size );  // Allocate size bytes of uninitialized storage whose alignment is specified by alignment. The size parameter must be an integral multiple of alignment.
```

偷个懒：

[malloc - cppreference.com](https://en.cppreference.com/w/c/memory/malloc)

[calloc - cppreference.com](https://en.cppreference.com/w/c/memory/calloc)

[realloc - cppreference.com](https://en.cppreference.com/w/c/memory/realloc)

[free - cppreference.com](https://en.cppreference.com/w/c/memory/free)

用好malloc和free也就差不多了，这俩都是线程安全的。malloc的size是可以为0的，返回空指针。free可以传个空指针

再看Cpp，在Cpp的世界比较单纯，只有new和delete，如果是数组的话，那就new[]和delete[]，有意思的是这俩是个运算符，并且这个运算符是可以重载的..

对象泄漏：使用了new，但忘了使用delete释放对象

提前释放：

重复释放：

> Cpp的标准是有版权的，150刀左右/每版。但是标准的草案是免费的，并且和最终版大体一样，所以找最新的草案版本也可以
>
> Cpp11草案：[www.open-std.org/jtc1/sc22/wg21/docs/papers/2011/n3242.pdf](http://www.open-std.org/jtc1/sc22/wg21/docs/papers/2011/n3242.pdf)
>
> Cpp14草案：[www.open-std.org/jtc1/sc22/wg21/docs/papers/2014/n4296.pdf](http://www.open-std.org/jtc1/sc22/wg21/docs/papers/2014/n4296.pdf)
>
> Cpp17草案：[www.open-std.org/jtc1/sc22/wg21/docs/papers/2017/n4713.pdf](http://www.open-std.org/jtc1/sc22/wg21/docs/papers/2017/n4713.pdf)
>
> Cpp20草案：[www.open-std.org/jtc1/sc22/wg21/docs/papers/2020/n4878.pdf](http://www.open-std.org/jtc1/sc22/wg21/docs/papers/2020/n4878.pdf)
>
> 主要就是在[C++ Standards Committee Papers (open-std.org)](http://www.open-std.org/JTC1/SC22/WG21/docs/papers/)下的年份里搜"Standard for Programming Language"，当然也有C的
>
> 这些都不重要，这辈子也精通不了Cpp，别说标准了，教材都不一定看完一本..

# 4 lambda表达式

lambda 表达式定义了一个匿名函数，并且可以捕获一定范围内的变量。

```c++
auto name = [capture](parameters)->return_type{body};
```

一个可能为空的捕获列表capture，指明定义环境中的哪些名字能被用在lambda表达式内，以及这些名字的访问方式是拷贝还是引用，捕获列表位于[]内；

一个可选的参数列表parameters，指明lambda表达式所需要的参数，参数列表位于()内；

一个可选的mutable修饰符，指明该lambda表达式可能会修改它自身状态，修改按值捕获的外部变量；

一个可选的noexception修饰符；

一个可选的 -> 形式的返回类型声明；

一个表达式体body，指明要执行的代码，表达式体位于{}内

**捕获**

```c++
int a = 0, b = 1;
// auto f1 = []{ return a; };  // error，没有捕获外部变量
auto f2 = [&]{ return a++; };  // OK，捕获所有外部变量，并对a执行自加运算
auto f3 = [=]{ return a; };  // OK，捕获所有外部变量，并返回a
// auto f4 = [=]{ return a++; };  // error，a是以复制方式捕获的，无法修改
// auto f5 = [a]{ return a + b; };  // error，没有捕获变量b
auto f6 = [a, &b]{ return a + (b++); };  // OK，捕获a和b的引用，并对b做自加运算
auto f7 = [&, a]{ return a + (b++); };  // OK，你懂的..
auto f8 = [=, &b]{ return a + (b++); };  // OK，捕获所有外部变量和b的引用，并对b做自加运算
```

一个容易出错的细节是关于 lambda 表达式的延迟调用的

```c++
int a = 0;
auto f = [=]{ return a; };      // 按值捕获外部变量
a += 1;                         // a被修改了
std::cout << f() << std::endl;  // 输出？
```

在捕获的一瞬间，a 的值就已经被复制到f中了。之后 a 被修改，但此时 f 中存储的 a 仍然还是捕获时的值，因此，最终输出结果是 0。

**mutable**

如果希望去修改按值捕获的外部变量应当怎么办呢？

```c++
int a = 0;
// auto f1 = [=]{ return a++; };          // error，修改按值捕获的外部变量
auto f2 = [=]() mutable { return a++; };  // OK，mutable
```

lambda 表达式的类型在 C++11 中被称为“闭包类型（Closure Type）”。啥叫闭包？脚本语言里面听到的贼多..就是能够访问另一个函数作用域的变量的函数。