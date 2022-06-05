---
title: Configure CentOS
top: 1
tags: CentOS
categories: Other
abbrlink: '94e02420'
date: 2019-11-30 11:45:46
---

CentOS常用软件的安装与配置

# 1 卸载软件

```bash
# 先列出要卸载的项
yum list installed | grep gcc
# 再逐个卸载
yum -y remove libgcc.x86_64
```

# 2 GCC

升级或安装gcc流程

```bash
wget https://mirrors.ustc.edu.cn/gnu/gcc/gcc-7.3.0/gcc-7.3.0.tar.gz
tar -xf gcc-7.3.0.tar.gz 
cd gcc-7.3.0
./contrib/download_prerequisites
mkdir gcc-build-7.3.0 
cd gcc-build-7.3.0
../configure --enable-checking=release --enable-languages=c,c++ --disable-multilib
# 时间可能很长 耐心等待就好
make && make install
```

<!-- more -->

# 3 Java

```bash
# 先去下载jdk的压缩包 再解压
tar -zxvf jdk.tar.gz
vim /etc/profile
    #java
    export JAVA_HOME=/usr/java/jdk1.8.0_181
    export CLASSPATH=.:$JAVA_HOME/lib/dt.jar:$JAVA_HOME/lib
    export PATH=$JAVA_HOME/bin:$PATH
source /etc/profile
```

# 4 Tomcat

```bash
# 前提是安装好Java
tar -zxvf tomcat.tar.gz
chmod 777 startup.sh
# only save ROOT 将webapps下所有东西都删了 就留个ROOT就好了
```

# 5 MySQL

```bash
# download mysql8 source
sudo rpm -Uvh https://dev.mysql.com/get/mysql80-community-release-el7-1.noarch.rpm
# install mysql8
sudo yum --enablerepo=mysql80-community install mysql-community-server
# start mysql service
sudo service mysqld start
# check mysql service status
service mysqld status
# get temp pwd of root
grep "A temporary password" /var/log/mysqld.log
# enter mysql cmd
mysql -uroot -p
# a policy of pwd validation
SHOW VARIABLES LIKE 'validate_password.%';
set global validate_password.policy=0;
# change pwd
ALTER USER 'root'@'localhost' IDENTIFIED BY 'YourPwd123';
use mysql;
SELECT host, user, authentication_string, plugin FROM user;
CREATE USER 'root'@'%' IDENTIFIED BY 'YouPwd123';
GRANT ALL ON *.* TO 'root'@'%';
```

# 6 Python

```bash
# 安装一些依赖
yum install zlib-devel bzip2-devel openssl-devel ncurses-devel sqlite-devel readline-devel tk-devel gcc make
yum install libffi-devel -y
# 下载python源码
wget https://www.python.org/ftp/python/3.7.4/Python-3.7.4.tgz
tar -xf Python-3.7.4.tgz
./configure
# 安装
sudo make && make install
# 看下是否安装成功
python3 -V
rm -f /usr/bin/python
ln -s /usr/local/bin/python3 /usr/bin/python
rm -f /usr/bin/pip
ln -s /usr/local/bin/pip3 /usr/bin/pip
# 修改一下 以免这些东西不能用了 将python改为python2
vim /usr/libexec/urlgrabber-ext-down
vim /usr/bin/yum

# 使用virtualenv
pip install virtualenv
cd /opt
virtualenv --no-site-packages --python=python3 env_1
source env_1/bin/activate
deactivate
```

# 7 Node.js

```bash
install node.js:
wget https://nodejs.org/dist/v12.11.1/node-v12.11.1-linux-x64.tar.xz
xz -d node-v12.11.1-linux-x64.tar.xz
tar -xvf node-v12.11.1-linux-x64.tar.xz

ln -s ~/node-v12.11.1-linux-x64/bin/node /usr/bin/node
ln -s ~/node-v12.11.1-linux-x64/bin/npm /usr/bin/npm
ln -s ~/node-v12.11.1-linux-x64/bin/npm /usr/bin/npx
```

# 8 Vim

配置Vim

```bash
$ vim ~/.vimrc
" 256色模式
" 256色模式
set t_Co=256
set term=xterm-256color
" 主题
colorscheme delek # desert ron elflord
" 注释设置成淡灰色
highlight Comment ctermfg=202
highlight PreProc ctermfg=82
"set hlsearch " 高亮搜索的词
set nohlsearch
set incsearch " 输入搜索内容时就显示搜索结果
" 显示所有字符
set list
" set listchars=eol:$,tab:~~,trail:.,nbsp:.,precedes:^,extends:^
set listchars=tab:~~,trail:.,nbsp:.,precedes:^,extends:^
highlight NonText ctermfg=239
highlight SpecialKey ctermfg=239
" 显示行号
set number

" 展开tab
set expandtab
" tab宽度
set tabstop=4
set softtabstop=4
" 自动缩进
set autoindent
set shiftwidth=4
set smartindent

" 设置编码
set encoding=utf-8
set termencoding=utf-8
set formatoptions+=mM
set fencs=utf-8,gbk
set fileencodings=utf-8,gbk
set fileformat=unix

set nocompatible " 关闭vi兼容模式
syntax on " 自动语法高亮
set cursorline " 突出当前行
set ruler " 打开状态栏标尺
set ignorecase smartcase " 搜索时忽略大小写，但在有一个或以上大写字母时仍保持对大小写敏感
set incsearch " 输入搜索内容时就显示搜索结果
```

