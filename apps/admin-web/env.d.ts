/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * nprogress 未随包提供类型（package.json 里的 @types 未安装）。
 * 本项目只用到 configure / start / done 三个 API，故就地声明最小类型，
 * 避免为此新增一个 devDependency（以及随之而来的 @types 版本漂移）。
 */
declare module 'nprogress' {
  interface NProgress {
    start(): NProgress;
    done(force?: boolean): NProgress;
    configure(options: {
      minimum?: number;
      template?: string;
      easing?: string;
      speed?: number;
      trickle?: boolean;
      trickleSpeed?: number;
      showSpinner?: boolean;
      parent?: string;
    }): NProgress;
  }
  const nprogress: NProgress;
  export default nprogress;
}

declare module 'nprogress/nprogress.css';

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_APP_TITLE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
