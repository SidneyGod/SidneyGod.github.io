/* global hexo */
'use strict';

const Util = require('@next-theme/utils');
const utils = new Util(hexo, __dirname);

hexo.extend.filter.register('theme_inject', injects => {
  //injects.style.push(utils.getFilePath('../source/_data/sidney/sidney_style.styl'));

  injects.postBodyEnd.raw('sidney_postBodyEnd', utils.getFileContent('../source/_data/sidney/sidney_postBodyEnd.njk'));
  injects.footer.raw('sidney_footer',
        utils.getFileContent('../source/_data/sidney/sidney_footer.njk'));

  let config = utils.defaultConfigFile('sidney', '../source/_data/sidney/default.yml');
  if (!config.enable) return;

  injects.bodyEnd.raw('sidney_bodyEnd',
      utils.getFileContent('../source/_data/sidney/sidney_bodyEnd.njk'));
});