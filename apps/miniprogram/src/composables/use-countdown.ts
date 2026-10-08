/**
 * composables/use-countdown —— 截单倒计时（关键锚点 1：T-1 24:00）
 *
 * ⚠️ 时间基准：**以服务端下发的剩余秒数起表**，本地只做递减。
 *    若用 `截止时刻 − 本地 Date.now()`，设备时钟偏差会直接污染显示
 *    （用户把系统时间调早 2 小时，倒计时就凭空多出 2 小时）；
 *    而 U1 已给出权威 `countdownSec`，端上据此起表最稳。
 *    页面在 `onShow` 时重拉一次 U1 并重新 `start()`，即可自动纠偏。
 */
import { computed, onUnmounted, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

import { formatCountdown, formatRemainHuman } from '@/utils/format';

export interface UseCountdownReturn {
  /** 剩余秒数（0 = 已截单） */
  remainSec: Ref<number>;
  /** "07:32:15" / "1 天 02:10:00" */
  text: ComputedRef<string>;
  /** "7 小时 32 分" —— 用于「距截单还剩 …」句式 */
  humanText: ComputedRef<string>;
  expired: ComputedRef<boolean>;
  /**
   * 以服务端剩余秒数起表
   *
   * ⚠️ 宿主组件**已卸载时该调用是空操作**（不清状态、不起定时器、不抛错）
   *    —— 异步取数后调用的场景无需在页面侧自行判活。
   */
  start: (fromSec: number, onExpire?: () => void) => void;
  stop: () => void;
}

export function useCountdown(): UseCountdownReturn {
  const remainSec = ref(0);

  let timer: ReturnType<typeof setInterval> | null = null;
  /** 本地到点时刻（毫秒）= 起表时刻 + 剩余秒数 × 1000 */
  let deadline = 0;
  let expireCallback: (() => void) | null = null;

  /**
   * 宿主组件是否已卸载 —— **卸载后 `start()` 自拒**的判据
   *
   * ⚠️ 为什么护栏必须放在这里，而不是每个页面自己记一个 `mounted`：
   *    调用点都是「`await` 拉完服务端秒数 → 才 `start()`」的异步路径
   *    （`index.vue` / `order-create.vue` / `leader/workbench.vue`），
   *    用户在这跳 await 期间切走页面时，`onUnmounted` 已经跑完，
   *    晚到的响应再 `start()` 开的定时器**再没有任何地方会去 clear**
   *    ⇒ 后台永久 1s 空转。这个性质属于「倒计时自己」，与页面无关，
   *    故下沉到本组合式：**一处加固，三个调用点同时受益，页面侧零侵入**。
   */
  let unmounted = false;

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function tick(): void {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    remainSec.value = left > 0 ? left : 0;
    if (left <= 0) {
      stop();
      expireCallback?.();
    }
  }

  function start(fromSec: number, onExpire?: () => void): void {
    // ⚠️ 已卸载 ⇒ **自拒**：不清状态、不起定时器、不抛错。
    //    晚到的服务端响应走到这里时页面已经没了，再起表就是纯后台空转
    //    （判据来源见上面 `unmounted` 处的头注）。**页面侧不需要为此加任何守卫。**
    if (unmounted) return;

    stop();
    expireCallback = onExpire ?? null;

    const sec = Math.max(0, Math.floor(fromSec));
    deadline = Date.now() + sec * 1000;
    remainSec.value = sec;

    if (sec <= 0) {
      // 已截单：不启动定时器，直接回调（避免空转）
      expireCallback?.();
      return;
    }
    timer = setInterval(tick, 1000);
  }

  // 组件卸载必须清定时器，否则页面切走后仍在后台空转；
  // 同时置位 `unmounted`，让卸载之后到达的 `start()` 直接自拒。
  onUnmounted(() => {
    unmounted = true;
    stop();
  });

  return {
    remainSec,
    text: computed(() => formatCountdown(remainSec.value)),
    humanText: computed(() => formatRemainHuman(remainSec.value)),
    expired: computed(() => remainSec.value <= 0),
    start,
    stop,
  };
}
