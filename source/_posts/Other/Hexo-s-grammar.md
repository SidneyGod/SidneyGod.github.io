---
title: Hexo's grammar
top: 1
tags:
  - hexo
  - blog
  - NexT
categories: Other
abbrlink: 2b335451
date: 2019-10-13 09:27:08
---

# 1 Hexo的语法

参考官网给的：

https://hexo.io/docs/front-matter

https://hexo.io/docs/tag-plugins

做好笔记，以便之后寻找方便...

## 1.1 文章的meta

就是这么个东西

<!-- more -->

```yaml
---
title: article name
top: 1
date: 2019-10-13 09:27:08
tags:
  - hexo
  - blog
categories: Other
---
```

可以通过yaml语法定义，也可以通过json语法定义，基本没啥好说的，除了tags和categories需要手动添加也就没了，当然了也可以添加自己的meta信息，在article中使用

## 1.2 引用

 https://hexo.io/docs/tag-plugins#Block-Quote 

简单一点的引用，直接使用markdown的语法就好了，当然还可以有更强一点的引用，语法如下：

```text
{% blockquote [author[, source]] [link] [source_link_title] %}
content
{% endblockquote %}
```

比如说引用某人书中的一句话, 多个作者的话就比较麻烦，要不用`/`隔开？

{% blockquote Sidney / Ding, A book %}
content
{% endblockquote %}

还有一种居中引用，不过貌似不能添加作者什么的

```
{% cq %}
content
{% endcq %}
```

{% cq %}
content
{% endcq %}

## 1.3 代码块

 https://hexo.io/docs/tag-plugins#Code-Block 

```text
{% codeblock [title] [lang:language] [url] [link text] %}
code snippet
{% endcodeblock %}
```

感受一下

{% codeblock diff.txt lang:diff %}
+ code snippet
- code
{% endcodeblock %}

将语言设为diff即可看到变色，有点头疼的是，用typro写这个费事，建议直接开启源码模式

## 1.4 插入文章链接

 https://hexo.io/docs/tag-plugins#Include-Posts 

插入之前的article

```
{% post_link filename [optional text] %}
```

## 1.5 Read More

read more的位置默认是150字符处，但是有时候前面有个代码块就很长了，这是可以在想分割的地方插入一个

```
<!-- more -->
```

## 1.6 Include Assets

好像啥都可以哈

```
{% asset_path slug %}
{% asset_img slug [title] %}
{% asset_link slug [title] %}
```

# 2 NexT的特性

参考官网

 https://theme-next.org/docs/third-party-services/math-equations 数学公式基本和markdown差不多

 https://theme-next.org/docs/tag-plugins/ 比较好用的布局

以下默认插件都安装好了

## 2.1 pdf

插入pdf

```
{% pdf url [height] %}

[url]    : Relative path to PDF file.
[height] : Optional. Height of the PDF display element, e.g. 800px.
```

## 2.2 tab

 https://theme-next.org/docs/tag-plugins/tabs 

可能以后会用

```
{% tabs Unique name, [index] %}
<!-- tab [Tab caption] [@icon] -->
Any content (support inline tags too).
<!-- endtab -->
{% endtabs %}

Unique name   : Unique name of tabs block tag without comma.
                Will be used in #id's as prefix for each tab with their index numbers.
                If there are whitespaces in name, for generate #id all whitespaces will replaced by dashes.
                Only for current url of post/page must be unique!
[index]       : Index number of active tab.
                If not specified, first tab (1) will be selected.
                If index is -1, no tab will be selected. It's will be something like spoiler.
                Optional parameter.
[Tab caption] : Caption of current tab.
                If not caption specified, unique name with tab index suffix will be used as caption of tab.
                If not caption specified, but specified icon, caption will empty.
                Optional parameter.
[@icon]       : FontAwesome icon name (without 'fa-' at the begining).
                Can be specified with or without space; e.g. 'Tab caption @icon' similar to 'Tab caption@icon'.
                Optional parameter.
```

## 2.3 note

{% note success %}

**Success Header**

Successfully!
{% endnote %}

```
{% note [class] [no-icon] %}
Any content (support inline tags too.io).
{% endnote %}

[class]   : default | primary | success | info | warning | danger.
[no-icon] : Disable icon in note.

All parameters are optional.
```

## 2.4 label

```
{% label [class]@Text %}

[class] : default | primary | success | info | warning | danger.
          '@Text' can be specified with or without space
          E.g. 'success @text' similar to 'success@text'.
          If not specified, default class will be selected.
```

Ut enim *{% label warning @ad %}* minim veniam, quis **{% label danger@nostrud %}** exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

# 3 插入图片的bug

不知道这个bug是不是因为[hexo-abbrlink](https://github.com/Rozbo/hexo-abbrlink)插件造成的，反正插入图片死活不成功，也不分析怎么造成的了，修改文件：`blog/node_modules/hexo/lib/plugins/processor/post.js`

{% codeblock post.js lang:diff %}
function scanAssetDir(post) {
    ...12 lines
    if (err.cause && err.cause.code === 'ENOENT') return [];
      throw err;
    }).filter(item => !common.isTmpFile(item) && !common.isHiddenFile(item)).map(item => {
      const id = join(assetDir, item).substring(baseDirLength).replace(/\\/g, '/');

+      // SidneyGod fix bug
+      item = id.replace("source/_posts", ".");
+      console.info&&console.info("SidneyGod---" + item);
      const asset = PostAsset.findById(id);
      if (asset) return undefined;
      return PostAsset.save({
      {% endcodeblock %}

加上那三句后，因为我是启用了asset folder的

{% codeblock _config.js lang:yaml %}
post_asset_folder: true
{% endcodeblock %}

所以在引用图片的时候，写链接需要这样`./articleName/imageName`，注意这个`./`不能少，因为表示相对路径，并且要确保，你的图片真的在`articleName`目录下