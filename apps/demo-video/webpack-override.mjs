// Lets the film import the web app's real components. Only the data hooks are
// swapped, so everything on screen comes from apps/web and the state comes from
// the current frame.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webpack } from '@remotion/bundler';

const root = path.dirname(fileURLToPath(import.meta.url));
const stub = name => path.join(root, 'src/real/hooks', `${name}.ts`);
const hooks = ['useAuth', 'useChatHistory', 'useChatMessages', 'useSharePageData', 'useTags', 'useVideoPlayback', 'useVideoStats', 'useVideoUpload', 'useVideos'];

/** @type {import('@remotion/bundler').WebpackOverrideFn} */
export const webpackOverride = config => ({
  ...config,
  resolve: {
    ...config.resolve,
    // Use the web app's dependency versions; the repo root hoists older ones of some.
    modules: [path.resolve(root, '../web/node_modules'), 'node_modules'],
    alias: {
      ...config.resolve?.alias,
      ...Object.fromEntries(hooks.map(name => [`@/hooks/${name}$`, stub(name)])),
      '@/lib/authSession$': stub('authSession'),
      '@': path.resolve(root, '../web/src'),
    },
  },
  plugins: [...(config.plugins ?? []), new webpack.DefinePlugin({
    'import.meta.env': JSON.stringify({ DEV: false, PROD: true }),
  })],
});
