import { defineComponent, h, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

import './custom.css';

const DEMO_ALT =
  'A chanx-js consumer, the AsyncAPI docs generated from it, generating the client, and that client catching a typo';

// Plays muted and looped with controls, except for visitors who prefer reduced motion: they see the poster and press play.
const HomeDemo = defineComponent(() => {
  const video = ref<HTMLVideoElement>();
  onMounted(() => {
    if (video.value && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      void video.value.play().catch(() => {});
    }
  });
  return () =>
    h('div', { class: 'home-demo' }, [
      h('div', { class: 'container' }, [
        h(
          'video',
          {
            ref: video,
            muted: true,
            loop: true,
            playsinline: true,
            controls: true,
            preload: 'metadata',
            poster: withBase('/chanx-js-demo-poster.jpg'),
            width: 1600,
            height: 700,
            'aria-label': DEMO_ALT,
          },
          [
            h('source', { src: withBase('/chanx-js-demo.mp4'), type: 'video/mp4' }),
            h('img', { src: withBase('/chanx-js-demo.gif'), alt: DEMO_ALT }),
          ],
        ),
      ]),
    ]);
});

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // Under the hero, wide enough for the code in the demo to be readable.
      'home-hero-after': () => h(HomeDemo),
    }),
} satisfies Theme;
