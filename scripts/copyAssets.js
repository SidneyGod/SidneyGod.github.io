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