---
title: Build a leanote server
top: 1
tags:
  - leanote
  - blog
categories: Other
abbrlink: 5d13faf3
date: 2020-08-23 18:05:55
---

# 1 Prepare

You need a server. My server OS is CentOS 7.2. You can also use other versions of Linux. Ok, let's get started.

```shell
su
yum install git  # config your git
git config --global user.name=UserName
git config --global user.email=xx@yy.zz
mkdir /usr/local/apps
mkdir ~/tmp
cd ~/tmp
```

# 2 Install Golang

<!-- more -->

```shell
# download golang
wget https://golang.google.cn/dl/go1.15.linux-amd64.tar.gz
# unzip
tar -zxvf go1.15.linux-amd64.tar.gz -C /usr/local/apps
# configure the golang environment variable
vim /etc/profile
    # golang
    export GOROOT=/usr/local/apps/go
    export GOPATH=/usr/local/apps/gopackage
    export PATH=$PATH:$GOROOT/bin:$GOPATH/bin
# refresh profile
source /etc/profile
# check golang
go version
```

# 3 Install Mongodb

```shell
# download mongodb
wget https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-4.0.20.tgz
# unzip 
tar -zxvf mongodb-linux-x86_64-4.0.20.tgz -C /usr/local/apps
cd /usr/local/apps
# rename
mv mongodb-linux-x86_64-4.0.20 mongodb
# Configure Mongodb
cd mongodb
mkdir -p data/db
mkdir -p data/log
mkdir conf
vim conf/mongodb.conf
    # port
    port=27017
    # database path
    dbpath=/usr/local/apps/mongodb/data/db
    # log path
    logpath=/usr/local/apps/mongodb/data/log/mongodb.log
    pidfilepath=/usr/local/apps/mongodb/data/mongo.pid 
    # run in background
    fork=true
    # log output mode
    logappend=true
    # your server private IP
    bind_ip=127.0.0.1[,private IP]
    # max connection count
    maxConns=200
vim /etc/profile
    # mongo
    export PATH=$PATH:/usr/local/apps/mongodb/bin
# start mongodb service
mongod --config /usr/local/apps/mongodb/conf/mongodb.conf
mongo
exit
```

# 4 Install Leanote

```shell
cd ~/tmp
git clone https://github.com/leanote/leanote-all.git --depth=1
mkdir /usr/local/apps/gopackage
cp -r leanote-all/src/ gopackage/
# install revel
# go get github.com/revel/cmd/revel  # timeout!
mkdir -p /usr/local/apps/go/src/golang.org/x/
cd /usr/local/apps/go/src/golang.org/x/
git clone https://github.com/golang/net.git --depth=1
git clone https://github.com/golang/crypto.git --depth=1
git clone https://github.com/golang/sys.git --depth=1
git clone https://github.com/golang/tools.git --depth=1
git clone https://github.com/golang/mod.git --depth=1
git clone https://github.com/golang/xerrors.git --depth=1
cd /usr/local/apps/go/bin
go build github.com/revel/cmd/revel
revel
# init data
mongorestore -h 127.0.0.1(your server private IP) -d leanote --dir /usr/local/apps/gopackage/src/github.com/leanote/leanote/mongodb_backup/leanote_install_data
mongo
show dbs
# if there is a leanote database, it means that the initialization data is successful.
# create a super administrator
use admin
db.createUser({user: 'root', pwd: 'root', roles: ['clusterAdmin', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'readWriteAnyDatabase']})
db.auth('root', 'root')

use leanote
db.createUser({user: 'leanote', pwd: 'leanotepwd', roles: ['readWrite']})
db.auth('leanote', 'leanotepwd')
# stop mongodb service and quit
use admin
db.shutdownServer()
exit
```

# 5 Configure Leanote

```shell
cd /usr/local/apps/gopackage
vim src/github.com/leanote/leanote/conf/app.conf
    # you website public ip or url
    site.url=http://www.example.com:9000
    # mongodb
    db.username=leanote
    db.password=leanotepwd
    # You Must Change It !!!
    app.secret=[you can modify it at will]
# start mongodb service
mongod --auth --config /usr/local/apps/mongodb/conf/mongodb.conf
# start leanote
nohup revel run src/github.com/leanote/leanote >leanote.log 2>&1 &
```

Now, you can try to open www.example.com:9000 !
**The default account is admin and password is abc123.**

# 6 Other

## 6.1 MongoDB Error

**ERROR: child process failed, exited with error number 48 To see additional information in this outpu**

```bash
# start in repair mode again
./mongod --dbpath=/usr/local/apps/mongodb/data/db --logpath=/usr/local/apps/mongodb/data/log/mongodb.log --repair
# According to the tips to fix! and kill mongod
pkill mongod
# restart mongodb
mongod --auth --config /usr/local/apps/mongodb/conf/mongodb.conf
```

## 6.2 Config Nginx

reference: https://developer.aliyun.com/article/699966

```bash
# install nginx
yum install -y nginx

# after install successfully,
# the default web dir： /usr/share/nginx/html
# the default config file：/etc/nginx/nginx.conf

# Open ports 80 and 443.
firewall-cmd --permanent --zone=public --add-service=http
firewall-cmd --permanent --zone=public --add-service=https
firewall-cmd --reload

# modify /etc/nginx/nginx.conf
vim /etc/nginx/nginx.conf
    server {
        listen       80 default_server;
        listen       [::]:80 default_server;
-        server_name  _;
+        server_name  101.132.124.174;
        root         /usr/share/nginx/html;
...
        location / {
+            proxy_pass  http://127.0.0.1:9000;
+            proxy_set_header Host $host;
+            proxy_set_header X-Real-IP $remote_addr;
+            proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
        }
# start or restart nginx
systemctl restart nginx
```

If nginx did not work, please run "systemctl status nginx" to check. If there is a log for:

```bash
Failed to parse PID from file /run/nginx.pid: Invalid argument
```

Please try the following:

```bash
mkdir -p /etc/systemd/system/nginx.service.d
printf "[Service]\nExecStartPost=/bin/sleep 0.1\n" > /etc/systemd/system/nginx.service.d/override.conf
systemctl daemon-reload
systemctl restart nginx.service

# check again
service nginx status
```

All is over, have fun!