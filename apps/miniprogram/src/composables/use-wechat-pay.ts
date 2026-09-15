/**
 * composables/use-wechat-pay —— 拉支付参数 → 唤起支付 → 确认结果
 *
 * 双通道（由 `PROVIDER_MODE` 决定，端上只需看 `ENV.demoMode`）：
 *   real —— `uni.requestPayment` 唤起真实微信收银台
 *   mock —— 本地无商户号，`requestPayment` 必然失败；改走服务端调试端点
 *           `/pay/mock/paid` 触发**等价回调**，保证
 *           「下单 → 支付 → 回调 → paid」在无商户号的本机也能全链路验证。
 *
 * ⚠️ 两条路径最终都**以 U8 服务端状态为准**（而非端上回调结果）：
 *    微信的 success 回调只代表「用户完成支付动作」，真正入账以服务端为准。
 */
import { ref } from 'vue';
import type { PayCreateResult, PayResultView } from '@abox/shared-types';

import { createPrepay, fetchPayResult, mockPaid } from '@/api/payment';
import { ENV } from '@/constants/env';
import { uuid } from '@/utils/format';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 唤起微信收银台 */
function requestPayment(params: PayCreateResult): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    uni.requestPayment({
      provider: 'wxpay',
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType,
      paySign: params.paySign,
      success: () => resolve(),
      fail: (err) => reject(new Error(err.errMsg || '支付未完成')),
    } as UniApp.RequestPaymentOptions);
  });
}

export function useWechatPay() {
  const paying = ref(false);

  /** 轮询 U8 直至入账或超时（mock 回调有延迟，不能只查一次） */
  async function pollResult(orderNo: string, times = 6, intervalMs = 500): Promise<PayResultView> {
    let last = await fetchPayResult(orderNo);
    for (let i = 0; !last.paid && i < times; i += 1) {
      await sleep(intervalMs);
      last = await fetchPayResult(orderNo);
    }
    return last;
  }

  /**
   * 支付一笔订单
   * @param idempotentKey 与 U7 的幂等键同源；缺省自动生成
   */
  async function pay(orderNo: string, idempotentKey: string = uuid()): Promise<PayResultView> {
    paying.value = true;
    try {
      const prepay = await createPrepay(orderNo, idempotentKey);

      if (ENV.demoMode) {
        await mockPaid(orderNo, prepay.payAmountFen);
      } else {
        await requestPayment(prepay);
      }

      return await pollResult(orderNo);
    } finally {
      paying.value = false;
    }
  }

  return { pay, paying, pollResult };
}
