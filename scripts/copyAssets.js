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
  //console.info("dingfs: assetsPattern: " + assetsPattern);

  if (!existsSync(destAssetPath)) {
    console.info("dingfs: Destination Asset Path is not exists! Try to create!");
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
    console.info("dingfs: " + value);
    copyDir(utils.getFilePath(srcAssetPath + path.sep + value), destAssetPath);
  });
});

// ========== 渲染markdown之前 ==========
hexo.extend.filter.register('before_post_render', function(data){
  // 1. markdown ![]() 图片
  const reMdImg = /(!\[.*?\]\()(assets\/[^)]+)(\))/g;
  // 2. html <img src="assets/..." ，兼容单引号、双引号
  const reHtmlImg = /(<img\s+[^>]*src=)(["'])(assets\/[^"']+)(\2)/g;
  data.content = data.content
                     .replace(reMdImg, '$1/$2$3')
                     .replace(reHtmlImg, '$1$2/$3$4');
  return data;
});
