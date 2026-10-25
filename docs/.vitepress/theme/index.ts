import { h } from 'vue';
import { withBase } from 'vitepress';
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

import './custom.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // Under the hero, wide enough for the code in the demo to be readable.
      'home-hero-after': () =>
        h('div', { class: 'home-demo' }, [
          h('div', { class: 'container' }, [
            h('img', {
              src: withBase('/chanx-js-demo.gif'),
              alt: 'A chanx-js consumer, the AsyncAPI docs generated from it, and a generated client catching a typo',
              width: 1200,
              height: 526,
            }),
          ]),
        ]),
    }),
} satisfies Theme;
