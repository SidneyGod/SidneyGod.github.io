---
title: Optimize hexo
top: 1
related_posts: true
mathjax: false
tags:
  - hexo
  - blog
categories: Other
abbrlink: ebc737d8
date: 2022-07-04 23:26:03
---

之前gitee图床挂了，然后gitee想用pages也必须用身份证，折腾一整最后放弃了gitee，直接用github好了(还是github靠谱)，本想着研究一下hugo，但是新东西费时间啊，就继续使用hexo+next了，算是升了个级，并且添加了github CI，解决环境，部署问题，一个字，爽！

首先搭建hexo博客步骤还是和 [Use hexo + github to build a blog | Sidney God](https://sidneygod.github.io/posts/c969bad9/) 一样，按照步骤做就好了，注意这里不要去改node_modules源码了(好像除了markdown和mathjax冲突，也没啥需要改的，kmarked不适用新版本hexo，别折腾了..)，环境部署麻烦

<!-- more -->

# 1 Env

1 创建 `your.github.io` 仓库用来存放博客源码和静态博客页面，不需要两个仓库，多麻烦啊

比如 https://github.com/SidneyGod/SidneyGod.github.io 仓库整俩分支，一个master分支存储博客源码，一个blog-hexo分支存储静态博客页面

然后将master分支clone到本地`git clone git@github.com:SidneyGod/SidneyGod.github.io.git -b master blog`

2 生成部署密钥

```bash
# 一直按回车就好
ssh-keygen -f github-deploy-key

# 然后就会有下面公钥和私钥俩文件
ls
hexo-deploy-key hexo-deploy-key.pub
```

3 配置密钥到仓库中

路径：Settings -- Secrets -- Actions -- New repository secret

在`Name`输入框填写`HEXO_DEPLOY_PRI`；在`Value`输入框填写`github-deploy-key`文件内容



路径：Settings -- Deploy keys -- Add deploy key

在`Title`输入框填写`HEXO_DEPLOY_PUB`；在`Key`输入框填写`github-deploy-key.pub`文件内容；勾选`Allow write access`选项



4 编写github action

在`blog`仓库根目录下创建`.github/workflows/deploy.yml`文件，文件内容如下

```yaml
name: DEPLOY_HEXO

on:
  push:
    branches:
      - master  # 当push到master分支时触发

env:
  GIT_USER: Sidney Ding
  GIT_EMAIL: sidneyding183@gmail.com

jobs:
  build:  # build任务，可以改名字叫job1
    name: Build on node ${{ matrix.node_version }} and ${{ matrix.os }}
    runs-on: ubuntu-18.04  # 运行的操作系统
    strategy:
      matrix:
        os: [ubuntu-18.04]
        node_version: [16.14.2]

    steps:
      - name: Checkout source
        # 将将master分支源码checkout下来，已经有v3版本了
        # https://github.com/marketplace/actions/checkout
        uses: actions/checkout@v2
        with:
          ref: master

      # 与上面的类似，安装nodejs环境
      # https://github.com/marketplace/actions/setup-node-js-environment
      - name: Setup Node.js ${{ matrix.node_version }}
        uses: actions/setup-node@v1
        with:
          node-version: ${{ matrix.node_version }}

      # 下面这些命令比较好理解，就是配置git环境
      - name: Configuration environment
        env:
          HEXO_DEPLOY_PRI: ${{secrets.HEXO_DEPLOY_PRI}}
        run: |
          sudo timedatectl set-timezone "Asia/Shanghai"
          mkdir -p ~/.ssh/
          echo "$HEXO_DEPLOY_PRI" > ~/.ssh/id_rsa
          chmod 700 ~/.ssh
          chmod 600 ~/.ssh/id_rsa
          ssh-keyscan github.com >> ~/.ssh/known_hosts
          git config --global user.name $GIT_USER
          git config --global user.email $GIT_EMAIL

      # 这个是安装hexo以及美化hexo的插件啥的
      - name: Install dependencies
        run: |
          npm install hexo-cli -g
          test -e package.json && npm install

      # 这仨命令很熟悉了 就是生成静态页面 并部署上去
      - name: Deploy hexo
        run: |
          hexo clean
          hexo generate
          hexo deploy
```

配置就这么些东西，然后再看blog源码..

# 2 搭建blog

简单描述下搭建blog的过程

根据官方文档：[文档 | Hexo](https://hexo.io/zh-cn/docs/index.html)，需要准备好git和nodejs(最新版本必须要12.13.0+，直接用nodejs推荐的版本就好)

想方便点就装个hexo-cli脚手架，这玩意没有也是行的

```bash
# 1 这样安装好后 就可以直接使用 hexo命令了
npm install -g hexo-cli
# 正常的初始化
hexo init <folder>
cd <folder>
npm install

# 2 还可以直接clone https://github.com/hexojs/hexo-starter
git clone git@github.com:hexojs/hexo-starter.git --depth=1 blogSrc
cd blogSrc
npm install
# 想使用hexo命令 每次开shell执行一下
alias hexo=node_modules/.bin/hexo
```

然后就是blog的一些美化操作，这些就不细说了

这里必须要安装的一个插件"hexo-deployer-git"配置deploy仓库，省事，然后在hexo的配置文件中配置下咱们的仓库

```yaml
# Deployment
## Docs: https://hexo.io/docs/one-command-deployment
deploy:
  type: git
  repo: git@github.com:SidneyGod/SidneyGod.github.io.git
  branch: blog-hexo
```

然后把blogSrc中除了`.git`和`.github`的所有文件挪到第一步中clone的blog文件夹，这个时候只需要将新的文件制作成commit push到github就能实现自动部署了

# 3 图床问题

思考良久，免费的图床总是不靠谱的，只有本地才靠谱，而markdown中插入的图片只要插到blog静态资源里面就好了..可能之后图片多了，性能不咋滴吧，但是目前不care了，并且刚好本地图片能兼容起来

解决方案比较简单，创建`blog/scripts/copyAssets.js`

```js
'use strict';

const spawn = require('child_process').exec;
const fs = require('fs');
const path = require('path');
const { existsSync, mkdirsSync, copyDir, listDirSync } = require('hexo-fs');
const Util = require('@next-theme/utils');
const utils = new Util(hexo, __dirname);

// use typora start new post
hexo.on('new', function(data){
  spawn('start  "C:\Program Files\Typora\Typora.exe" ' + data.path);
});

// Copy md assets file to public!
hexo.on('generateBefore', function(data) {
    let srcAssetPath = utils.getFilePath('../source/_posts/');
    let destAssetPath = utils.getFilePath('../public/assets/');
    let assetsPattern = new RegExp(path.sep + "assets");
    console.log("dingfs: assetsPattern: " + assetsPattern);

    if (!existsSync(destAssetPath)) {
        console.log("dingfs: Destination Asset Path is not exists! Try to create!");
        mkdirsSync(destAssetPath);
    }

    let assetsSet = new Set();
    listDirSync(srcAssetPath).forEach(function(filePath) {
        if (assetsPattern.test(filePath)) {
            let splits = filePath.split('assets');
            assetsSet.add(splits[0] + 'assets');
        }
    });

    assetsSet.forEach(function(value) {
        console.log("dingfs: " + value);
        copyDir(utils.getFilePath(srcAssetPath + path.sep + value),
                destAssetPath);
    });
});

// match markdown image and covert to asset_img 
hexo.extend.filter.register('before_post_render', function(data){
    data.content = data.content.replace(/<img src="assets\//g,
        function(match_str, label, path){
            //console.log("dingfs: match_str="+match_str+"-label="+label+"-path="+path);
            return '<img src="/assets/';
        });
    return data;
});
```

可解决了大问题

# 4 marked和mathjax冲突

这个也困扰了很久，用"hexo-filter-mathjax"插件显示数学公式，行内公式可以用单`$`，没问题；但是`\\`表示换行，但是marked直接整没了，没得换行了；数学公式中`_`表示下标，好家伙marked直接解析成`<em>`标签了..

百度大都是换kmarked，然后改源码，但是新版本hexo kmarked失效了并且改源码不优雅，主要action不好做；然后是pandoc啥的，感觉都不好用，最终选了

```
# 是的，没错，用raw来包裹..虽然在typora上看起来多了个这么个符号，但是也还好..
{%raw%}$$这里是数学公式..$${%endraw%}
```

嫌麻烦可以直接`git clone https://github.com/SidneyGod/SidneyGod.github.io -b master`省事..
