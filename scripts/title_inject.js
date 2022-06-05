/* global hexo */
'use strict';

const Util = require('@next-theme/utils');
const utils = new Util(hexo, __dirname);

hexo.extend.filter.register('theme_inject', injects => {
  let config = utils.defaultConfigFile('title_change', '../source/_data/hexo-next-title/default.yml');
  if (!config.enable) return;
  injects.head.raw('title', utils.getFileContent('../source/_data/hexo-next-title/change-title.njk'));
});