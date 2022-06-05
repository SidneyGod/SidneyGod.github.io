/* global hexo */
'use strict';

const Util = require('@next-theme/utils');
const utils = new Util(hexo, __dirname);

hexo.extend.filter.register('theme_inject', injects => {
  injects.head.raw('fireworks', '<script type="text/javascript" src="{{ url_for("lib/fireworks.js") }}"></script>');
  injects.style.push(utils.getFilePath('../source/_data/fireworks/fireworks.styl'));
});

hexo.extend.generator.register('fireworks', () => ({
  path: 'lib/fireworks.js',
  data: utils.getFileContent('../source/_data/fireworks/fireworks.js')
}));
