import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * 企业微信消息加解密（WXBizMsgCrypt，标准算法）
 *
 * 真源：企业微信开发文档《加解密方案》。本实现不依赖任何第三方库
 * （仓库环境装不了新依赖，见 main.ts 头注），纯 Node crypto 实现。
 *
 * 算法要点：
 *   · AESKey = Base64Decode(EncodingAESKey + "=")  → 32 字节（AES-256）
 *   · IV     = AESKey 的前 16 字节
 *   · 明文结构 = random(16) + msg_len(4, 大端) + msg + receiveId
 *   · 整块按 32 字节做 PKCS7 补齐
 *   · 签名 = SHA1( sorted([token, timestamp, nonce, encrypt]).join('') )
 *
 * 凭据从环境变量读取（不进配置 schema，避免改动 typed config）：
 *   WECOM_TOKEN / WECOM_ENCODING_AES_KEY / WECOM_CORP_ID
 */
@Injectable()
export class WecomCryptoService {
  private readonly logger = new Logger(WecomCryptoService.name);

  private conf(): { token: string; aesKey: Buffer; iv: Buffer; corpId: string } {
    const token = process.env.WECOM_TOKEN;
    const encodingAesKey = process.env.WECOM_ENCODING_AES_KEY;
    const corpId = process.env.WECOM_CORP_ID;
    if (!token || !encodingAesKey || !corpId) {
      throw new Error(
        '企业微信凭据未配置：需要 WECOM_TOKEN / WECOM_ENCODING_AES_KEY / WECOM_CORP_ID（在 .env 配置，建应用后由企业微信后台获取）',
      );
    }
    let aesKey: Buffer;
    try {
      aesKey = Buffer.from(encodingAesKey + '=', 'base64');
    } catch (e) {
      throw new Error('WECOM_ENCODING_AES_KEY 不是合法 Base64：' + (e as Error).message);
    }
    if (aesKey.length !== 32) {
      throw new Error(
        `WECOM_ENCODING_AES_KEY 解码后应为 32 字节，实际 ${aesKey.length}（EncodingAESKey 应为 43 字符）`,
      );
    }
    return { token, aesKey, iv: aesKey.subarray(0, 16), corpId };
  }

  /** 验签：msg_signature 是否等于 SHA1(sorted(token,timestamp,nonce,encrypt)) */
  verifyMsgSignature(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encrypt: string,
  ): boolean {
    const { token } = this.conf();
    const calc = this.signature(token, timestamp, nonce, encrypt);
    return calc === msgSignature;
  }

  private signature(token: string, timestamp: string, nonce: string, encrypt: string): string {
    return crypto
      .createHash('sha1')
      .update([token, timestamp, nonce, encrypt].sort().join(''))
      .digest('hex');
  }

  /** 解密企业微信回调报文，返回明文消息与 receiveId（应等于 corpId） */
  decrypt(encrypt: string): { message: string; receiveId: string } {
    const { aesKey, iv, corpId } = this.conf();
    const buf = Buffer.from(encrypt, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(buf), decipher.final()]);
    const pad = decrypted[decrypted.length - 1];
    const content =
      pad > 0 && pad <= 32 ? decrypted.subarray(0, decrypted.length - pad) : decrypted;
    const msgLen = content.readUInt32BE(16);
    const message = content.subarray(20, 20 + msgLen).toString('utf8');
    const receiveId = content.subarray(20 + msgLen).toString('utf8');
    if (receiveId && receiveId !== corpId) {
      throw new Error(`receiveId 不匹配：收到 ${receiveId}，期望 ${corpId}`);
    }
    return { message, receiveId };
  }

  /** 加密待下发消息（被动回复 / 主动下发前包一层） */
  encrypt(plainText: string, receiveId?: string): string {
    const { aesKey, iv, corpId } = this.conf();
    const random = crypto.randomBytes(16);
    const msgBuf = Buffer.from(plainText, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(msgBuf.length, 0);
    const receiveBuf = Buffer.from(receiveId ?? corpId, 'utf8');
    let raw = Buffer.concat([random, lenBuf, msgBuf, receiveBuf]);
    const pad = 32 - (raw.length % 32);
    if (pad > 0 && pad <= 32) raw = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
    return encrypted.toString('base64');
  }

  /** 启动自检：encrypt→decrypt 往返一致。模块 onModuleInit 调用，creds 缺失则跳过。 */
  runSelfTest(): boolean {
    try {
      const { corpId } = this.conf();
      const sample = '企业微信往返自检 ' + Date.now();
      const enc = this.encrypt(sample, corpId);
      const dec = this.decrypt(enc);
      const ok = dec.message === sample && dec.receiveId === corpId;
      if (ok) this.logger.log('WXBizMsgCrypt 自检通过（encrypt→decrypt 往返一致）');
      else this.logger.error('WXBizMsgCrypt 自检失败：明文不一致');
      return ok;
    } catch (e) {
      this.logger.warn('WXBizMsgCrypt 自检跳过（凭据未配置，属预期）：' + (e as Error).message);
      return false;
    }
  }
}
